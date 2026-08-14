module.exports = function (RED) {
    const WebSocket = require('ws');

    // Connection lifecycle states. Anything that belongs to one particular socket
    // lives on a connection context rather than on the node, so a socket that has
    // been superseded can never touch the connection that replaced it.
    const STATE = {
        CONNECTING: 'connecting',
        AUTHENTICATING: 'authenticating',
        AUTHENTICATED: 'authenticated',
        AUTH_RETRY_WAIT: 'auth-retry-wait',
        RECONNECT_WAIT: 'reconnect-wait',
        CLOSING: 'closing'
    };

    // The node's own login frames always carry this id. A login response may only
    // change authentication state while a login is genuinely outstanding on the
    // active connection - otherwise a stale reply from a superseded socket, or a
    // user.login a user sends themselves through an API Request node, could flip
    // the node to authenticated.
    const LOGIN_REQUEST_ID = 0;

    // How long node.on('close') waits for a graceful WebSocket close handshake
    // before terminating. Node-RED gives a node 15s to shut down; a frozen peer
    // would otherwise sit on ws's own 30s close timer and blow through it.
    const CLOSE_GRACE_MS = 2000;

    // HTTP statuses on the upgrade that mean the endpoint itself is wrong: retrying
    // fast cannot help, because nothing will change without a configuration edit.
    // Every 5xx is excluded on purpose - including 501, which is a statement about
    // the server rather than about this configuration - so any server-side failure
    // is retried on the normal ladder.
    const PERMANENT_UPGRADE_CODES = [400, 401, 403, 404, 410];

    // WebIQ rejects logins with { category, errc, message } - there is no numeric
    // HTTP-style code. Observed in the field: category 'shmi:connect:api:user'
    // with errc 8 and the message 'too many login attempts', i.e. the server's own
    // attempt limiter has tripped. Every further attempt keeps that window open, so
    // this must stop the node dead rather than back off.
    const LOCKOUT_ERRC = 8;
    const LOCKOUT_PATTERN = /too many login attempts|locked|blocked/i;

    // Server-controlled text ends up in status badges, log lines and Error objects
    // that flows replay. One choke point bounds it: control characters stripped
    // (no ANSI/log forgery), length capped (no multi-megabyte Error messages).
    // Total coercion, no truncation: safe to call on anything, including a value
    // whose toString is null (which JSON can express and String() throws on).
    function coerceServerText(value) {
        try {
            return typeof value === 'string' ? value : String(value);
        } catch (_) {
            // Thrown inside a ws event handler this would reach Node-RED's
            // uncaught handler and terminate the runtime.
            return '[unprintable value]';
        }
    }

    // Presentation form: bounded for badges, logs and Error messages. Never use
    // this for MATCHING - the cap would silently narrow the test.
    function sanitizeServerText(value) {
        // Two deliberate choices here. The filter is built per code point rather
        // than as a regex character class because editing tools have twice embedded
        // the class's control characters as raw bytes, turning this file into a
        // binary blob. And truncation happens while iterating code points, never
        // via slice(): a slice at a UTF-16 unit boundary can split a surrogate
        // pair and leave a lone surrogate in a status badge.
        let out = '';
        let units = 0;
        for (const ch of coerceServerText(value)) {
            if (units >= 200) { break; }
            const c = ch.codePointAt(0);
            out += (c < 32 || c === 127) ? ' ' : ch;
            units += ch.length;
        }
        return out;
    }

    // Deepest nesting accepted in a server frame. A WebIQ frame never needs
    // anything close to this.
    //
    // maxPayload bounds a frame's SIZE but not its SHAPE, and Node-RED clones a
    // message recursively - once per wired Catch node, and once per output wire
    // after the first. A 16 KB frame nested 8000 deep therefore makes cloneMessage
    // throw RangeError inside this node's ws event handler, which reaches
    // Node-RED's uncaught handler and terminates the whole runtime. Bounding the
    // text alone does not close that; the structure has to be bounded too.
    const MAX_FRAME_DEPTH = 64;

    // Runs on EVERY inbound frame, so it must not allocate. The depth bound is
    // checked BEFORE descending, which caps recursion at maxDepth + 1 frames
    // regardless of input - over-deep input returns true without ever being
    // walked, so recursion here cannot blow the stack. The Array fast path
    // matters: large io.read replies are arrays of primitives, and this visits
    // them without creating a single wrapper object or key list.
    function exceedsMaxDepth(value, maxDepth) {
        if (value === null || typeof value !== 'object') { return false; }
        if (maxDepth <= 0) { return true; }
        if (Array.isArray(value)) {
            for (let i = 0; i < value.length; i += 1) {
                const v = value[i];
                if (v !== null && typeof v === 'object' && exceedsMaxDepth(v, maxDepth - 1)) { return true; }
            }
            return false;
        }
        const keys = Object.keys(value);
        for (let i = 0; i < keys.length; i += 1) {
            const v = value[keys[i]];
            if (v !== null && typeof v === 'object' && exceedsMaxDepth(v, maxDepth - 1)) { return true; }
        }
        return false;
    }

    function normaliseServerError(error) {
        // WebIQ sends an object, but a server or proxy can send a bare string.
        // Without this, a string error defeats lockout detection entirely.
        if (typeof error === 'string') { return { message: error }; }
        return error;
    }

    function describeServerError(rawError) {
        const error = normaliseServerError(rawError);
        if (!error || typeof error !== 'object') { return 'unknown error'; }
        const parts = [];
        if (error.category) { parts.push(sanitizeServerText(error.category)); }
        if (error.errc !== undefined) { parts.push('errc ' + sanitizeServerText(error.errc)); }
        if (error.code !== undefined) { parts.push('code ' + sanitizeServerText(error.code)); }
        const prefix = parts.length ? `[${parts.join(' ')}] ` : '';
        return prefix + (error.message ? sanitizeServerText(error.message) : 'no message');
    }

    // The host is an authority component, so anything that could make a URL parser
    // read a DIFFERENT server out of it has to be refused. Userinfo is the sharp
    // case: "trusted.example@10.0.0.9" looks like the trusted host to a human but
    // resolves to 10.0.0.9 - and the node would send the WebIQ credentials there.
    function validateHost(raw) {
        const value = String(raw).trim();
        const reject = (why) => ({
            error: `Host "${value}" is not a plain hostname or IP address: ${why}. Enter only the host; the port belongs in the Port field.`,
            status: 'invalid host'
        });

        if (value.includes('@')) { return reject('it contains userinfo ("@"), which would redirect the connection and the credentials to the host after it'); }
        if (value.includes('://') || value.includes('/') || value.includes('\\')) { return reject('it contains a scheme or path separator'); }
        if (/[?#]/.test(value)) { return reject('it contains a query or fragment character'); }
        if (/\s/.test(value)) { return reject('it contains whitespace'); }

        // Bracketed IPv6 literal, e.g. [::1]
        if (value[0] === '[') {
            if (!/^\[[0-9A-Fa-f:.]+\]$/.test(value)) { return reject('it is not a valid bracketed IPv6 literal'); }
            return { host: value };
        }

        const colons = (value.match(/:/g) || []).length;
        // Two or more colons can only be a bare IPv6 literal; bracket it so the
        // authority is unambiguous.
        if (colons >= 2) {
            if (!/^[0-9A-Fa-f:.]+$/.test(value)) { return reject('it is not a valid IPv6 literal'); }
            return { host: `[${value}]` };
        }
        if (colons === 1) { return reject('it includes a port'); }

        // Within ASCII only hostname characters are allowed - that is what keeps
        // authority syntax out. Non-ASCII is deliberately left alone so
        // internationalised domain names keep working (ws/Node punycode them);
        // an allow-list of ASCII letters would have rejected every IDN host that
        // worked before this validation existed. The underscore is deliberate too:
        // Docker names use it, and 1.1.4 exists because stricter parsing once
        // rejected Docker container names.
        for (const ch of value) {
            const c = ch.codePointAt(0);
            if (c < 128 && !/[A-Za-z0-9._-]/.test(ch)) {
                return reject(`it contains "${ch}", which is not valid in a hostname`);
            }
        }

        return { host: value };
    }

    // A "no free seat" rejection is transient by nature: most often the server is
    // still holding this SAME node's previous session after an unclean disconnect
    // (cable pull, network drop), and frees it once its own dead-session detection
    // catches up - observed at roughly 15 minutes on an X3web. Observed live frame:
    // { category: 'shmi:connect:license', errc: 4, message: 'too many clients' }.
    // Treating this as a credential rejection latched the node terminally over a
    // condition that fixes itself.
    function isCapacityRejection(rawError) {
        const error = normaliseServerError(rawError);
        if (!error || typeof error !== 'object') { return false; }
        if (/too many (clients|sessions)/i.test(coerceServerText(error.message || ''))) { return true; }
        // Within the licence category, only the observed seat-exhaustion code
        // counts. The category alone is NOT enough: an expired or missing licence
        // is also in this namespace and will never fix itself - classifying it as
        // capacity would loop logins forever under a 'server full' badge.
        return error.errc === 4 && /license/i.test(coerceServerText(error.category || ''));
    }

    // One authoritative copy of the exponential login ladder. It was previously
    // written out at three call sites and had already drifted (one copy lost the
    // exponent clamp).
    function authLadderDelay(initialDelay, maxDelay, attemptCount) {
        return Math.min(initialDelay * Math.pow(2, Math.max(0, attemptCount - 1)), maxDelay);
    }

    // Monotonic milliseconds for cooldown arithmetic. Date.now() is wall-clock:
    // an NTP step backwards would make "time since last reconnect" negative and
    // jam the escape hatch for the whole jump.
    function monotonicMs() {
        return Number(process.hrtime.bigint() / 1000000n);
    }

    function isLockout(rawError) {
        const error = normaliseServerError(rawError);
        if (!error || typeof error !== 'object') { return false; }
        // Coerced safely but NOT truncated: sanitizeServerText caps at 200
        // characters for display, and matching against the capped text would miss
        // a lockout whose wording runs long - silently turning "stop now" into
        // "retry a few more times" against an account the HMI also uses.
        if (error.errc === LOCKOUT_ERRC && /user/.test(coerceServerText(error.category || ''))) { return true; }
        return LOCKOUT_PATTERN.test(coerceServerText(error.message || ''));
    }

    function WebIQNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        const host = config.host;
        const port = config.port;
        const project = config.project;

        // Credentials come only from Node-RED's credential store. There is
        // deliberately no fallback to the flat config properties a 1.x flow used:
        // those properties are no longer declared defaults, so Node-RED drops them
        // on any full deploy. A fallback would let the node work after upgrading and
        // then lose its credentials at an unpredictable later moment - failing
        // immediately with an explicit message is far easier to act on.
        const credentials = node.credentials || {};
        const username = credentials.username;
        const password = credentials.password;
        const hasLegacyCredentials = !!(config.username || config.password);

        // Login timeout is configurable (seconds) because slow PLC-backed projects
        // can take well over the old hardcoded 5s to answer a login.
        //
        // The upper bound matters: setTimeout stores its delay in a 32-bit signed
        // integer, so anything above 2147483647ms silently becomes 1ms. Without the
        // clamp, a user entering a very large number to mean "wait a long time" gets
        // a guard that fires immediately instead - the exact opposite of the intent.
        const defaultLoginTimeoutSeconds = 5;
        const maxLoginTimeoutSeconds = 86400; // 24 hours, well inside the 32-bit range
        const configuredLoginTimeout = Number(config.loginTimeout);
        const loginTimeoutIsValid = Number.isFinite(configuredLoginTimeout) && configuredLoginTimeout > 0;
        const loginTimeoutSeconds = loginTimeoutIsValid
            ? Math.min(configuredLoginTimeout, maxLoginTimeoutSeconds)
            : defaultLoginTimeoutSeconds;
        const loginTimeoutMs = loginTimeoutSeconds * 1000;

        if (loginTimeoutIsValid && configuredLoginTimeout < 1) {
            node.warn(`Login timeout of ${configuredLoginTimeout}s is shorter than most servers can answer; the node may never authenticate. Values of 1s or more are recommended.`);
        }
        if (loginTimeoutIsValid && configuredLoginTimeout > maxLoginTimeoutSeconds) {
            node.warn(`Login timeout of ${configuredLoginTimeout}s exceeds the ${maxLoginTimeoutSeconds}s maximum; using ${maxLoginTimeoutSeconds}s.`);
        }

        // Heartbeat interval, in seconds; 0 disables it.
        //
        // Without this, a connection that dies without a TCP close - a frozen server
        // VM, a dropped NAT conntrack entry, a switch reboot - leaves readyState at
        // OPEN forever. The 'close' event never fires, so scheduleReconnect() is
        // unreachable, the node keeps reporting 'authenticated', and every send
        // disappears into a dead socket. That is the whole reconnect machine sitting
        // behind an event that the most common plant-network failure never emits.
        const defaultHeartbeatSeconds = 30;
        const maxHeartbeatSeconds = 3600;

        // An explicit 0 disables the heartbeat; an EMPTY field must fall back to the
        // default. These are not the same thing, and Number('') === 0 conflates them -
        // clearing the field would otherwise silently switch off the protection this
        // release is built around.
        const heartbeatProvided = config.heartbeat !== undefined &&
            config.heartbeat !== null &&
            String(config.heartbeat).trim() !== '';
        // Any positive interval below this is raised to it. Without a floor a
        // fractional value such as 0.001 is honoured literally and produces a
        // ping storm - hundreds of frames a second at the server.
        const minHeartbeatSeconds = 1;

        const configuredHeartbeat = heartbeatProvided ? Number(config.heartbeat) : NaN;
        const heartbeatIsValid = Number.isFinite(configuredHeartbeat) && configuredHeartbeat >= 0;
        const heartbeatSeconds = heartbeatIsValid
            ? (configuredHeartbeat === 0
                ? 0
                : Math.min(Math.max(configuredHeartbeat, minHeartbeatSeconds), maxHeartbeatSeconds))
            : defaultHeartbeatSeconds;
        const heartbeatMs = heartbeatSeconds * 1000;

        if (heartbeatIsValid && configuredHeartbeat > maxHeartbeatSeconds) {
            node.warn(`Heartbeat of ${configuredHeartbeat}s exceeds the ${maxHeartbeatSeconds}s maximum; using ${maxHeartbeatSeconds}s.`);
        } else if (heartbeatProvided && !heartbeatIsValid) {
            node.warn(`Heartbeat of "${config.heartbeat}" is not a non-negative number; using the ${defaultHeartbeatSeconds}s default.`);
        } else if (heartbeatIsValid && configuredHeartbeat > 0 && configuredHeartbeat < minHeartbeatSeconds) {
            node.warn(`Heartbeat of ${configuredHeartbeat}s is below the ${minHeartbeatSeconds}s minimum; using ${minHeartbeatSeconds}s. Use 0 to disable the heartbeat entirely.`);
        }

        if (heartbeatMs <= 0) {
            // Disabling the heartbeat restores exactly the 1.x failure this release
            // exists to fix, so it must not be a silent choice.
            node.warn('WebIQ heartbeat is disabled. A connection that dies without a TCP close will not be detected, and this node will keep reporting "authenticated" while requests are lost.');
        }

        // Terminate only after this many consecutive silent intervals. A threshold of
        // one would make a single dropped frame - or a server that is briefly busy -
        // look like a dead link.
        const heartbeatMissThreshold = 2;

        // How many consecutive REJECTED logins to attempt before latching. Counted
        // node-wide, across sockets, because a per-socket counter resets every time
        // the server hangs up. Configurable: sites differ in how aggressive their
        // WebIQ lockout policy is. The floor of 1 and ceiling of 20 keep both
        // "latch instantly by accident" and "never latch" out of reach.
        //
        // Login TIMEOUTS deliberately spend a different budget with a different
        // ending: after the same count of unanswered logins the node drops to one
        // probe every 60 seconds instead of latching. Silence usually means the
        // server is down or still booting its PLC project - it is not counting
        // attempts, and a terminal latch would leave an unattended gateway dead
        // forever over a transient outage.
        const defaultLoginAttempts = 5;
        const maxConfigurableLoginAttempts = 20;
        const configuredLoginAttempts = Number(config.loginAttempts);
        const loginAttemptsIsValid = Number.isFinite(configuredLoginAttempts) && configuredLoginAttempts >= 1;
        const maxLoginAttempts = loginAttemptsIsValid
            ? Math.min(Math.floor(configuredLoginAttempts), maxConfigurableLoginAttempts)
            : defaultLoginAttempts;

        if (loginAttemptsIsValid && configuredLoginAttempts > maxConfigurableLoginAttempts) {
            node.warn(`Login attempts of ${configuredLoginAttempts} exceeds the ${maxConfigurableLoginAttempts} maximum; using ${maxConfigurableLoginAttempts}.`);
        } else if (loginAttemptsIsValid && !Number.isInteger(configuredLoginAttempts)) {
            node.warn(`Login attempts of ${configuredLoginAttempts} is not a whole number; using ${maxLoginAttempts}.`);
        }

        // TLS. Certificate handling is delegated entirely to Node-RED's own
        // tls-config node, which owns the CA / client-certificate / passphrase
        // fields and sets rejectUnauthorized from its own "verify server
        // certificate" checkbox. We never set that ourselves, so this cannot
        // silently downgrade to an unverified connection.
        // Asking for TLS always means wss://. An unresolvable reference is a
        // configuration error, never a quiet downgrade: falling back to ws:// would
        // hand the credentials to a plaintext socket precisely when the user had
        // asked for encryption.
        const tlsRequested = !!config.tls;
        const tlsConfigNode = (tlsRequested && RED.nodes && typeof RED.nodes.getNode === 'function')
            ? RED.nodes.getNode(config.tls)
            : null;
        const useTls = !!(config.secure || tlsRequested);
        const scheme = useTls ? 'wss' : 'ws';

        // Endpoint validation. Everything that would produce a malformed or
        // surprising URL is caught here rather than at socket-construction time.
        function buildEndpoint() {
            if (tlsRequested && !tlsConfigNode) {
                return {
                    error: 'A TLS configuration is selected but could not be resolved. Refusing to connect: falling back to an unencrypted connection would send the credentials in cleartext.',
                    status: 'TLS config unresolved'
                };
            }

            // A resolved node of the wrong type would connect over wss() while
            // silently discarding the CA or client certificate that was the whole
            // point of selecting it.
            if (tlsRequested && typeof tlsConfigNode.addTLSOptions !== 'function') {
                return {
                    error: 'The selected TLS configuration is not a tls-config node, so its certificate settings cannot be applied. Refusing to connect rather than ignoring them.',
                    status: 'TLS config invalid'
                };
            }

            // A tls-config node that failed to load its files sets valid = false, and
            // its addTLSOptions then silently omits every certificate, key, CA and
            // PFX it was configured with - the method is still present, so checking
            // for the method alone is not enough. Compared against false explicitly
            // so a provider that does not expose the flag at all still works.
            if (tlsRequested && tlsConfigNode.valid === false) {
                return {
                    error: 'The selected TLS configuration failed to load its certificate material (check the file paths on the tls-config node). Refusing to connect, because the connection would otherwise proceed without the certificates you selected.',
                    status: 'TLS config invalid'
                };
            }

            // Check the credential pair itself, never the presence of the legacy
            // fields. Gating on those would protect only until the first full deploy
            // strips them, after which a credential-less node would happily open a
            // socket and send a login carrying no username or password at all.
            if (!username || !password) {
                return {
                    error: hasLegacyCredentials
                        ? 'WebIQ credentials must be re-entered after upgrading to 2.0. Open this node, type the username and password again, and redeploy - they are now held in Node-RED\'s credential store instead of the flow file.'
                        : 'WebIQ username and password are not set. Open this node and enter them; they are stored in Node-RED\'s credential store.',
                    status: hasLegacyCredentials ? 'credentials need re-entry' : 'credentials missing'
                };
            }

            if (!host || !String(host).trim()) {
                return { error: 'Host is empty or missing.', status: 'host missing' };
            }

            const hostCheck = validateHost(host);
            if (hostCheck.error) { return hostCheck; }

            const portNumber = Number(port);
            if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
                return {
                    error: `Port "${port}" is not a valid TCP port (expected 1-65535).`,
                    status: 'invalid port'
                };
            }

            if (!project || String(project).trim() === '') {
                return { error: 'WebIQ project name is empty or missing!', status: 'project missing' };
            }

            const trimmedProject = String(project).trim();
            // A slash, query or fragment in the project would silently retarget the
            // connection at a different path instead of failing.
            if (/[\/?#\\]/.test(trimmedProject)) {
                return {
                    error: `WebIQ project "${trimmedProject}" contains a path separator or URL character.`,
                    status: 'invalid project'
                };
            }

            return {
                url: `${scheme}://${hostCheck.host}:${portNumber}/${encodeURIComponent(trimmedProject)}/`
            };
        }

        const endpoint = buildEndpoint();
        const configError = endpoint.error || null;
        const url = endpoint.url;

        if (configError) {
            node.status({ fill: 'red', shape: 'ring', text: endpoint.status });
            node.error(configError);
        }

        // Node-scoped state: only what genuinely outlives a single connection.
        let activeContext = null;
        let reconnectTimer = null;
        let reconnectDelay = 1000;
        let closing = false;

        // Login accounting and the terminal latch. All node-scoped so they survive
        // the socket churn a failing server causes. Rejections and timeouts are
        // counted separately because they end differently: rejections latch
        // terminally (the server actively said no - that cannot fix itself),
        // timeouts fall back to a slow probe (silence usually means the server is
        // down or booting, and it recovers on its own).
        let loginRejections = 0;
        // Two transient-failure counters, kept separate so log lines and badges
        // stay truthful: a capacity rejection IS answered, so it must never be
        // reported as an 'unanswered login'. Their SUM drives the resting
        // threshold - both classes share the never-latch, probe-gently ending.
        let unansweredLogins = 0;
        let capacityRejections = 0;
        const transientLoginFailures = () => unansweredLogins + capacityRejections;
        let authLatched = false;
        let authLatchReason = null;

        // The reconnect control verb is rate-limited: an automated
        // Catch -> change -> reconnect loop would otherwise turn the escape hatch
        // into exactly the login hammer the latch exists to prevent.
        let lastForcedReconnectAt = -Infinity; // monotonic ms; -Infinity so the first use always passes
        const reconnectCooldownMs = 60000;

        // Cadence of the standing probe once logins have gone unanswered
        // maxLoginAttempts times. Slow enough that it can never trouble a login
        // limiter, fast enough that a server which was merely restarting is picked
        // up within a minute rather than being left down for five.
        const restingRetryDelayMs = 60 * 1000;

        const initialReconnectDelay = 1000;
        const maxReconnectDelay = 30000;

        // Authentication failures get their own ladder. A rejected credential is not
        // a transport problem: retrying it every 5s forever produces ~17k failed
        // logins a day and can trip server-side account lockout.
        const initialAuthRetryDelay = 5000;
        const maxAuthRetryDelay = 60000;

        // A project the server does not know is a configuration error, not a blip.
        // Retry it, but slowly.
        const slowRetryDelay = 30000;

        // Fail a stalled upgrade instead of hanging in CONNECTING forever, and cap
        // inbound frames well below ws's 100 MiB default - this protocol never needs
        // anything close to it.
        const handshakeTimeoutMs = 10000;
        const maxPayloadBytes = 4 * 1024 * 1024;

        // Refuse to queue further sends once this much is already backed up. A peer
        // that has stopped reading would otherwise let the send buffer grow without
        // limit while readyState still reads OPEN.
        const maxBufferedBytes = 1024 * 1024;

        // Backoff only resets once a connection has proven itself for this long.
        // Resetting on 'open' - or even on login - means a link that authenticates
        // and dies two seconds later reconnects every second forever.
        const stabilityWindowMs = 30000;

        function createContext(socket) {
            return {
                socket,
                state: STATE.CONNECTING,
                pendingLoginId: null,
                failureKind: null,
                upgradePermanent: false,
                sendDegraded: false,
                loginAttempted: false,
                missedHeartbeats: 0,
                trafficSinceTick: false,
                timers: { loginTimeout: null, authRetry: null, stability: null, heartbeat: null },
                handlers: {}
            };
        }

        // Every callback and every timer asks this before acting. A context that is
        // no longer the active one has been superseded, and must do nothing.
        function owns(ctx) {
            return !closing && activeContext === ctx;
        }

        function setState(ctx, state, status) {
            if (ctx) { ctx.state = state; }
            if (status) { node.status(status); }
        }

        function clearTimers(ctx) {
            if (!ctx) { return; }
            Object.keys(ctx.timers).forEach(function (key) {
                if (ctx.timers[key]) {
                    if (key === 'heartbeat') {
                        clearInterval(ctx.timers[key]);
                    } else {
                        clearTimeout(ctx.timers[key]);
                    }
                    ctx.timers[key] = null;
                }
            });
        }

        // Detach only the listeners this node attached, by name. Blanket
        // removeAllListeners() would also strip ws's own internal handlers.
        function detachHandlers(ctx) {
            if (!ctx || !ctx.socket) { return; }
            Object.keys(ctx.handlers).forEach(function (event) {
                ctx.socket.removeListener(event, ctx.handlers[event]);
            });
            ctx.handlers = {};
        }

        function isAuthenticated() {
            return !!activeContext && activeContext.state === STATE.AUTHENTICATED;
        }

        // Stop trying, permanently, until the user intervenes. Retrying a rejected
        // credential is not harmless here: WebIQ counts attempts and locks the
        // account, and that account is very likely the one the operator HMI uses
        // too - so a typo in one Node-RED node can take out the real screens.
        function latchAuthFailure(reason) {
            authLatched = true;
            authLatchReason = reason;

            if (reconnectTimer) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }

            const ctx = activeContext;
            if (ctx) {
                clearTimers(ctx);
                try { ctx.socket.close(); } catch (_) {}
            }

            node.status({ fill: 'red', shape: 'ring', text: 'login blocked - fix and redeploy' });
            node.error(`WebIQ login abandoned: ${reason}. No further login attempts will be made. Correct the credentials and redeploy, or send a message with msg.webiq = "reconnect" to retry once.`);
        }

        function clearAuthLatch() {
            authLatched = false;
            authLatchReason = null;
            // "Retry once" means once. An unlatch grants a single fresh attempt,
            // not a whole new budget - if the cause was not actually fixed, the
            // very next rejection re-latches instead of hammering N more times.
            loginRejections = Math.max(0, maxLoginAttempts - 1);
            unansweredLogins = 0;
            capacityRejections = 0;
        }

        // Any traffic at all proves the link is alive, not just a pong. A WebIQ
        // server that is streaming data but does not answer pings must not be
        // terminated as dead.
        function markAlive(ctx) {
            if (ctx) {
                ctx.missedHeartbeats = 0;
                ctx.trafficSinceTick = true;
            }
        }

        function stopHeartbeat(ctx) {
            if (ctx && ctx.timers.heartbeat) {
                clearInterval(ctx.timers.heartbeat);
                ctx.timers.heartbeat = null;
            }
        }

        function startHeartbeat(ctx) {
            if (heartbeatMs <= 0) { return; }

            stopHeartbeat(ctx);
            ctx.missedHeartbeats = 0;
            ctx.trafficSinceTick = false;

            // Probe immediately so the very first interval already has an answer to
            // judge, and count via a per-interval traffic flag rather than a bare
            // counter. Two earlier attempts got this wrong in opposite directions:
            // counting after the check needed THREE intervals (~90s at default,
            // docs promise two), and counting before the check meant an interval
            // that saw traffic at 29.9s was charged as 'missed' 0.1s later - a link
            // could die after barely ONE silent interval, and a single pong slower
            // than one interval killed an idle session. The flag makes a 'miss'
            // mean exactly one FULL interval with zero inbound traffic.
            try { ctx.socket.ping(); } catch (_) {}

            ctx.timers.heartbeat = setInterval(function () {
                const socket = ctx.socket;

                if (!owns(ctx) || !socket || socket.readyState !== WebSocket.OPEN) {
                    stopHeartbeat(ctx);
                    return;
                }

                if (ctx.trafficSinceTick) {
                    ctx.missedHeartbeats = 0;
                } else {
                    ctx.missedHeartbeats += 1;
                }
                ctx.trafficSinceTick = false;

                if (ctx.missedHeartbeats >= heartbeatMissThreshold) {
                    stopHeartbeat(ctx);
                    ctx.failureKind = 'heartbeat-timeout';
                    node.status({ fill: 'red', shape: 'ring', text: 'link stale - reconnecting' });
                    node.warn(`No WebIQ traffic or pong for ${heartbeatMissThreshold} consecutive ${heartbeatSeconds}s heartbeats; terminating an apparently dead link.`);
                    // terminate(), not close(): a frozen peer never sends the close
                    // frame that close() waits for, and ws would then sit on its own
                    // 30s timer before giving up.
                    try { socket.terminate(); } catch (_) {}
                    return;
                }

                try { socket.ping(); } catch (_) {}
            }, heartbeatMs);

            if (typeof ctx.timers.heartbeat.unref === 'function') {
                ctx.timers.heartbeat.unref();
            }
        }

        function connect() {
            if (closing || authLatched) { return; }

            // A pending reconnect must not survive a direct connect. The forgotten
            // timer would fire a second connect() up to 30s later, replace
            // activeContext, and orphan this socket - open, possibly authenticated,
            // and unreachable by every owns()-guarded handler including its own
            // close handler: a leaked WebIQ session.
            if (reconnectTimer) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }

            // Belt and braces for the same class of bug: whatever context is still
            // active is superseded NOW, not left to be discovered.
            if (activeContext) {
                const stale = activeContext;
                activeContext = null;
                clearTimers(stale);
                detachHandlers(stale);
                // ws emits 'error' on the NEXT TICK when a CONNECTING socket is
                // terminated (abortHandshake -> emitErrorAndClose). With every
                // listener just detached, that becomes an unhandled 'error' event,
                // which throws and kills the whole runtime - the try/catch below
                // cannot catch a next-tick emission. A sink listener must outlive
                // the terminate call.
                stale.socket.on('error', function () {});
                try { stale.socket.terminate(); } catch (_) {}
            }

            let socket;
            try {
                const socketOptions = {
                    handshakeTimeout: handshakeTimeoutMs,
                    maxPayload: maxPayloadBytes
                };
                if (tlsConfigNode && typeof tlsConfigNode.addTLSOptions === 'function') {
                    tlsConfigNode.addTLSOptions(socketOptions);
                }
                socket = new WebSocket(url, 'smarthmi-connect', socketOptions);
            } catch (err) {
                // A malformed host or port throws synchronously here. Without a
                // reconnect the node would stay dead until the next deploy, so keep
                // retrying on the slow ladder in case the configuration is fixed
                // by an environment variable or a restarted DNS entry.
                node.status({ fill: 'red', shape: 'ring', text: 'invalid connection settings' });
                node.error(`Could not create WebSocket connection: ${err.message}`);
                scheduleReconnect(slowRetryDelay);
                return;
            }

            const ctx = createContext(socket);
            activeContext = ctx;
            setState(ctx, STATE.CONNECTING, { fill: 'red', shape: 'ring', text: 'disconnected' });

            ctx.handlers.open = function () {
                if (!owns(ctx)) { return; }
                // Deliberately does NOT reset reconnectDelay - see stabilityWindowMs.
                setState(ctx, STATE.AUTHENTICATING, { fill: 'yellow', shape: 'ring', text: 'connected - login pending' });
                attemptLogin(ctx);
            };

            ctx.handlers.pong = function () {
                if (!owns(ctx)) { return; }
                markAlive(ctx);
            };

            // A peer that pings us is demonstrably alive, even if it never answers
            // our own pings. Without this, "any inbound traffic counts" is not true.
            ctx.handlers.ping = function () {
                if (!owns(ctx)) { return; }
                markAlive(ctx);
            };

            ctx.handlers.message = function (data) {
                if (!owns(ctx)) { return; }
                markAlive(ctx);

                let parsed;
                try {
                    parsed = JSON.parse(data.toString());
                    if (exceedsMaxDepth(parsed, MAX_FRAME_DEPTH)) {
                        // Deliberately thrown into the existing fallback: the raw
                        // Buffer is flat, so forwarding it cannot make Node-RED's
                        // recursive clone blow the stack. Letting the parsed value
                        // through would kill the runtime the moment a Catch node is
                        // wired or the output has a second wire.
                        throw new Error(`frame nested deeper than ${MAX_FRAME_DEPTH} levels`);
                    }
                } catch (e) {
                    node.warn(`Unusable WebIQ frame forwarded as raw data: ${sanitizeServerText(e.message)}`);
                    node.send({ payload: data });
                    return;
                }

                handleLoginResponse(ctx, parsed);

                const out = { payload: parsed };

                // A server frame carrying an error is still forwarded - nothing is
                // hidden - but it is ALSO raised as a node error so a Catch node can
                // act on it. Without this, an io.write that WebIQ refused (unknown
                // tag, read-only item, insufficient rights, PLC offline) arrives on
                // the same wire looking exactly like a confirmed write, and a flow
                // that treats an emitted message as success reports a setpoint that
                // was never applied.
                // Exclude only the node's OWN login (cmd AND reserved id): a
                // user.login a flow sent itself (id !== 0) failing must still be
                // catchable, or a rejected user-level elevation vanishes silently.
                if (parsed && parsed.error &&
                    !(parsed.cmd === 'user.login' && parsed.id === LOGIN_REQUEST_ID)) {
                    node.error(
                        new Error(`WebIQ rejected ${sanitizeServerText(parsed.cmd || 'request')}: ${describeServerError(parsed.error)}`),
                        out
                    );
                }

                node.send(out);
            };

            ctx.handlers.error = function (err) {
                if (!owns(ctx)) { return; }

                // A non-101 response to the upgrade is a different failure from a
                // WebIQ JSON error carrying the same code: it means the server never
                // accepted the WebSocket at all, usually because the project segment
                // of the URL path is wrong.
                const upgrade = /Unexpected server response: (\d{3})/.exec(err.message || '');
                if (upgrade) {
                    const code = Number(upgrade[1]);
                    ctx.failureKind = 'http-upgrade-' + code;

                    // Only codes that mean "this endpoint is wrong" are permanent.
                    // 429 and 5xx are a busy or broken server or proxy, and will very
                    // likely work again shortly - putting them on the slow ladder
                    // delays recovery for no reason and misdiagnoses the cause.
                    ctx.upgradePermanent = PERMANENT_UPGRADE_CODES.indexOf(code) !== -1;

                    if (ctx.upgradePermanent) {
                        node.status({ fill: 'red', shape: 'ring', text: `server rejected upgrade (HTTP ${code})` });
                        // The project is a URL path segment, so a wrong project is
                        // rejected here at the handshake - it never reaches a login.
                        // Name the configured project so the user checks the field
                        // that is actually most often at fault.
                        node.error(`WebIQ server rejected the WebSocket upgrade with HTTP ${code}. The project "${project}" is the most likely cause - it is part of the connection URL, so an unknown project is refused before any login happens. Also check host, port and any reverse proxy.`);
                    } else {
                        node.status({ fill: 'yellow', shape: 'ring', text: `server unavailable (HTTP ${code})` });
                        node.warn(`WebIQ server or proxy returned HTTP ${code} to the WebSocket upgrade; retrying.`);
                    }
                    return;
                }

                // Keep the cause so the close handler can name it instead of
                // guessing. ws reports the real reason here and then closes with
                // nothing useful attached.
                ctx.transportError = { code: String(err.code || ''), message: String(err.message || '') };
                node.warn(`WebSocket error: ${err.message}`);
            };

            ctx.handlers.close = function () {
                if (!owns(ctx)) { return; }

                clearTimers(ctx);
                activeContext = null;

                if (closing) { return; }

                // The latch already painted its own badge and cancelled everything.
                if (authLatched) { return; }

                // A socket that dies with a login still outstanding spent a
                // server-side attempt just as surely as one that timed out. Without
                // this it looked like an ordinary transport drop: fast ladder, no
                // budget consumed - so a peer that reads the login and hangs up
                // could be retried forever, defeating the whole lockout protection.
                if (ctx.pendingLoginId !== null) {
                    // Charged regardless of any earlier failureKind on this socket:
                    // a capacity or credential rejection followed by a retry whose
                    // login the server never answered still spent a real attempt,
                    // and skipping the charge here let exactly that attempt vanish
                    // from every budget.
                    ctx.pendingLoginId = null;
                    ctx.failureKind = 'login-timeout';
                    unansweredLogins += 1;
                    node.warn(`WebIQ closed the connection without answering the login (unanswered login ${unansweredLogins}).`);
                }

                // Preserve the badge whichever path we arrived by. These used to be
                // repainted to a generic 'disconnected' within milliseconds, so
                // states the documentation described were never actually observable.
                if (ctx.failureKind === 'heartbeat-timeout') {
                    node.status({ fill: 'red', shape: 'ring', text: 'link stale - reconnecting' });
                } else if (ctx.failureKind === 'login-timeout') {
                    node.status(transientLoginFailures() >= maxLoginAttempts
                        ? { fill: 'red', shape: 'ring', text: 'login unanswered - retrying every 60s' }
                        : { fill: 'red', shape: 'ring', text: 'login timeout' });
                } else if (ctx.failureKind === 'login-capacity') {
                    node.status(transientLoginFailures() >= maxLoginAttempts
                        ? { fill: 'yellow', shape: 'ring', text: 'server full - retrying every 60s' }
                        : { fill: 'yellow', shape: 'ring', text: 'server full - reconnecting' });
                } else if (ctx.failureKind === 'auth-rejected') {
                    // A server that hangs up after rejecting must not erase the
                    // attempt count from the canvas.
                    node.status({ fill: 'yellow', shape: 'ring', text: `login failed (${loginRejections}/${maxLoginAttempts})` });
                } else if (String(ctx.failureKind).startsWith('http-upgrade-')) {
                    // The error handler already reported it with the right severity.
                } else if (!ctx.loginAttempted) {
                    // Nothing was ever sent, so this is a transport fault. Name it
                    // from the socket error rather than blaming the project, which
                    // sent users to check a field that was never involved.
                    const cause = ctx.transportError || {};
                    let text = 'connection failed';
                    let detail = 'the WebIQ server could not be reached.';

                    if (/ECONNREFUSED/.test(cause.code)) {
                        text = 'connection refused';
                        detail = 'nothing is listening on that host and port.';
                    } else if (/ENOTFOUND|EAI_AGAIN/.test(cause.code)) {
                        text = 'host not found';
                        detail = 'the host name could not be resolved.';
                    } else if (/ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/.test(cause.code)) {
                        text = 'server unreachable';
                        detail = 'the host did not respond - check the network path and any firewall.';
                    } else if (/CERT|SELF_SIGNED|DEPTH_ZERO|UNABLE_TO_VERIFY|ERR_TLS/.test(cause.code)) {
                        text = 'TLS certificate rejected';
                        detail = 'the server certificate was not trusted - check the tls-config node.';
                    } else if (/subprotocol/i.test(cause.message)) {
                        text = 'subprotocol rejected';
                        detail = "the server did not accept the 'smarthmi-connect' subprotocol - a reverse proxy may be stripping it.";
                    }

                    node.status({ fill: 'red', shape: 'ring', text: text });
                    node.error(`WebIQ connection failed: ${detail}${cause.message ? ' (' + cause.message + ')' : ''}`);
                } else {
                    node.status({ fill: 'red', shape: 'ring', text: 'disconnected' });
                }

                setState(ctx, STATE.RECONNECT_WAIT);

                // Pick the cadence by failure class. A rejecting server that hangs
                // up per attempt must climb the AUTH ladder (from the node-scoped
                // rejection count - a per-socket count restarts at zero every
                // reconnect, which is how five logins once fired in ~15 seconds,
                // the exact burst most likely to trip the server's limiter). A
                // misconfigured endpoint gets the slow ladder; exhausted timeouts
                // get the resting probe.
                let delay;
                if (ctx.failureKind === 'auth-rejected') {
                    delay = authLadderDelay(initialAuthRetryDelay, maxAuthRetryDelay, loginRejections);
                } else if (ctx.failureKind === 'login-timeout' || ctx.failureKind === 'login-capacity') {
                    delay = transientLoginFailures() >= maxLoginAttempts ? restingRetryDelayMs : slowRetryDelay;
                } else if (ctx.upgradePermanent === true) {
                    delay = slowRetryDelay;
                }
                scheduleReconnect(delay);
            };

            socket.on('open', ctx.handlers.open);
            socket.on('message', ctx.handlers.message);
            socket.on('pong', ctx.handlers.pong);
            socket.on('ping', ctx.handlers.ping);
            socket.on('error', ctx.handlers.error);
            socket.on('close', ctx.handlers.close);
        }

        function handleLoginResponse(ctx, message) {
            if (!message || message.cmd !== 'user.login') { return; }

            // Correlation guard: ignore any user.login frame this node did not ask for.
            if (ctx.pendingLoginId === null || message.id !== ctx.pendingLoginId) { return; }

            ctx.pendingLoginId = null;

            if (ctx.timers.loginTimeout) {
                clearTimeout(ctx.timers.loginTimeout);
                ctx.timers.loginTimeout = null;
            }

            if (!message.error) {
                ctx.failureKind = null;
                loginRejections = 0;
                unansweredLogins = 0;
            capacityRejections = 0;
                if (ctx.timers.authRetry) {
                    clearTimeout(ctx.timers.authRetry);
                    ctx.timers.authRetry = null;
                }
                // Deliberately a stable, exact string: Status nodes and tests match
                // on it. A disabled heartbeat is surfaced by the deploy-time warning
                // instead of by mutating this badge.
                setState(ctx, STATE.AUTHENTICATED, { fill: 'green', shape: 'dot', text: 'authenticated' });

                // Start liveness probing only once the session is usable. Pinging
                // during the login window would just add noise to a connection whose
                // health is already being judged by the login timeout.
                startHeartbeat(ctx);

                // Only a connection that survives the stability window earns a reset
                // of the reconnect ladder.
                if (ctx.timers.stability) { clearTimeout(ctx.timers.stability); }
                ctx.timers.stability = setTimeout(function () {
                    if (!owns(ctx)) { return; }
                    ctx.timers.stability = null;
                    reconnectDelay = initialReconnectDelay;
                }, stabilityWindowMs);
                if (typeof ctx.timers.stability.unref === 'function') { ctx.timers.stability.unref(); }
                return;
            }

            // NOTE: there is deliberately no branch for a JSON "project not found"
            // here. Real WebIQ never sends one - the project is a URL path segment,
            // so a wrong project is rejected at the HTTP upgrade and never reaches
            // a login. Any JSON login error, whatever its shape, is a rejection.
            const described = describeServerError(message.error);

            // ORDER MATTERS: capacity is classified BEFORE lockout. The lockout
            // pattern matches bare 'locked'/'blocked' anywhere in a message, so a
            // seat-exhaustion reply worded as, say, 'all client seats blocked'
            // would otherwise latch the node terminally over the one condition
            // that is guaranteed to fix itself.
            //
            // "Too many clients" is not a credential problem, and after a network
            // drop it is usually this node's OWN previous session still holding the
            // seat until the server's dead-session detection reaps it (observed:
            // ~15 minutes on an X3web). It fixes itself, so it must never latch and
            // must not spend the credential budget - walking the terminal ladder
            // here left an unattended gateway latched forever roughly 75 seconds
            // into a condition that cleared on its own at minute 15.
            if (isCapacityRejection(message.error)) {
                ctx.failureKind = 'login-capacity';
                capacityRejections += 1;

                const capacityDelay = authLadderDelay(initialAuthRetryDelay, maxAuthRetryDelay, capacityRejections);

                setState(ctx, STATE.AUTH_RETRY_WAIT, {
                    fill: 'yellow',
                    shape: 'ring',
                    text: `server full - retrying in ${capacityDelay / 1000}s`
                });
                node.warn(`WebIQ login rejected ${described} - no free client slot, often a session the server has not yet released after an unclean disconnect. Retrying in ${capacityDelay / 1000}s (server-full reply ${capacityRejections}); this does not count against the login budget.`);

                if (ctx.timers.authRetry) { clearTimeout(ctx.timers.authRetry); }
                ctx.timers.authRetry = setTimeout(function () {
                    if (!owns(ctx)) { return; }
                    ctx.timers.authRetry = null;
                    attemptLogin(ctx);
                }, capacityDelay);
                return;
            }

            // The server telling us to stop must never be answered with another
            // attempt - that is precisely what keeps a sliding lockout window open.
            if (isLockout(message.error)) {
                ctx.failureKind = 'auth-rejected';
                latchAuthFailure(`the server refused the login: ${described}`);
                return;
            }

            ctx.failureKind = 'auth-rejected';
            loginRejections += 1;

            if (loginRejections >= maxLoginAttempts) {
                latchAuthFailure(`${loginRejections} consecutive rejected logins (last: ${described})`);
                return;
            }

            // Ladder from the NODE-scoped count: a per-socket count restarts at
            // zero when the server hangs up per attempt, and the ladder never climbs.
            const authRetryDelay = authLadderDelay(initialAuthRetryDelay, maxAuthRetryDelay, loginRejections);

            setState(ctx, STATE.AUTH_RETRY_WAIT, {
                fill: 'yellow',
                shape: 'ring',
                text: `login failed (${loginRejections}/${maxLoginAttempts})`
            });
            // Always relay the server's own words: it is the only thing that
            // distinguishes a wrong password from a licence limit or a lockout, and
            // discarding it sends the user to check the wrong thing.
            node.warn(`WebIQ login rejected ${described} - attempt ${loginRejections} of ${maxLoginAttempts}, retrying in ${authRetryDelay / 1000}s.`);

            if (ctx.timers.authRetry) { clearTimeout(ctx.timers.authRetry); }
            ctx.timers.authRetry = setTimeout(function () {
                if (!owns(ctx)) { return; }
                ctx.timers.authRetry = null;
                attemptLogin(ctx);
            }, authRetryDelay);
        }

        function attemptLogin(ctx) {
            if (!owns(ctx)) { return; }

            const socket = ctx.socket;
            if (!socket || socket.readyState !== WebSocket.OPEN) { return; }

            ctx.loginAttempted = true;
            ctx.pendingLoginId = LOGIN_REQUEST_ID;

            socket.send(JSON.stringify({
                cmd: "user.login",
                id: LOGIN_REQUEST_ID,
                data: { username, password, realm: null }
            }));

            if (ctx.timers.loginTimeout) { clearTimeout(ctx.timers.loginTimeout); }
            ctx.timers.loginTimeout = setTimeout(function () {
                if (!owns(ctx)) { return; }
                ctx.timers.loginTimeout = null;
                if (ctx.state === STATE.AUTHENTICATED) { return; }

                // A reply arriving after we gave up must not be counted or acted
                // on: without this, one wire login could spend two budget units,
                // and a late SUCCESS would paint 'authenticated' and start a
                // heartbeat on a socket we are about to tear down.
                ctx.pendingLoginId = null;

                ctx.failureKind = 'login-timeout';
                unansweredLogins += 1;

                // Silence never latches terminally. A server that is down, booting,
                // or loading a heavy PLC project is not counting login attempts -
                // a terminal latch here would leave an unattended gateway dead
                // forever over a transient outage. After the budget, fall back to
                // one probe every 60 seconds so a recovered server is picked up
                // without human help.
                const resting = transientLoginFailures() >= maxLoginAttempts;
                node.status(resting
                    ? { fill: 'red', shape: 'ring', text: 'login unanswered - retrying every 60s' }
                    : { fill: 'red', shape: 'ring', text: 'login timeout' });
                node.error(`No login reply received within ${loginTimeoutSeconds}s (unanswered login ${unansweredLogins}): the server may be unreachable or slow to answer, or the timeout may be too short for this project.${resting ? ' Falling back to one attempt every 60 seconds until the server answers.' : ''}`);

                // terminate(), not close(): this peer just proved unresponsive, and
                // close() would wait on ws's internal 30s timer for a close frame
                // that may never come.
                try { socket.terminate(); } catch (_) {}
            }, loginTimeoutMs);
        }

        // Downward-only jitter (60-100% of the delay), so a site with many
        // gateways does not stampede a WebIQ server the instant it comes back up.
        function withJitter(delay) {
            // Jitter DOWNWARD only, 60-100% of the delay. Spreading upward and then
            // clamping piled the whole upper half of the distribution onto the exact
            // ceiling - so at the 30s cap, where a stampede is most likely, half the
            // gateways would still have fired at precisely the same moment. This way
            // a documented ceiling stays a real ceiling and the spread is preserved
            // at every rung, including the top one.
            return Math.round(delay * (0.6 + (Math.random() * 0.4)));
        }

        // Timer policy, deliberate: PROGRESS timers (reconnect, authRetry,
        // loginTimeout) keep the event loop referenced - a pending reconnect is
        // work the process must stay alive to do. AUXILIARY timers (heartbeat,
        // stability, close-grace) are unref'd - they observe, they are not work.
        function scheduleReconnect(overrideDelayMs) {
            // activeContext is checked because node.status() can re-enter this node
            // synchronously: a Status -> Change -> msg.webiq='reconnect' flow can
            // establish a replacement connection from inside the close handler's own
            // status call, and the close handler would then carry on and arm a timer
            // that later tears down the healthy replacement.
            if (reconnectTimer || closing || authLatched || activeContext) { return; }

            const base = typeof overrideDelayMs === 'number' ? overrideDelayMs : reconnectDelay;

            reconnectTimer = setTimeout(function () {
                reconnectTimer = null;
                // Only a fire that consumed the TRANSPORT ladder advances it.
                // Override fires (auth/capacity/resting/slow) say nothing about
                // transport health - doubling on them inflated the first retry
                // after an ordinary drop to as much as 30s.
                if (typeof overrideDelayMs !== 'number') {
                    reconnectDelay = Math.min(reconnectDelay * 2, maxReconnectDelay);
                }
                connect();
            }, withJitter(base));
        }

        node.on('input', function (msg, send, done) {
            // Routing failures through done(err) is what makes Catch nodes fire.
            // node.error(text) without a msg never reaches the Catch route at all,
            // so every one of these failures used to vanish silently.
            done = done || function (err) { if (err) { node.error(err, msg); } };

            // A misconfigured node still registers this handler. Returning early from
            // the constructor used to leave the node with no input listener at all, so
            // a message routed to it produced no output, no error, no Catch event and
            // no done() - it simply vanished.
            if (configError) {
                done(new Error(`WebIQ node is not configured: ${configError}`));
                return;
            }

            // Escape hatch from the terminal latch that does not need a redeploy -
            // an unattended site can be recovered by a flow once the cause is fixed.
            if (msg && msg.webiq === 'reconnect') {
                // "Connected" means a socket that is OPEN or still CONNECTING. A
                // context whose socket is CLOSING/CLOSED is a dying connection the
                // close handler has not reaped yet - a reconnect request during that
                // window must act, not be silently swallowed.
                const liveSocket = !!(activeContext && activeContext.socket &&
                    (activeContext.socket.readyState === WebSocket.OPEN ||
                     activeContext.socket.readyState === WebSocket.CONNECTING));

                // Only a fully AUTHENTICATED connection is healthy enough to ignore
                // the verb. Treating a live-but-unauthenticated socket as healthy
                // made the escape hatch a silent success no-op for the whole login
                // window - which, with a long Login timeout, is exactly when an
                // operator reaches for it. The 60s cooldown bounds the cost of
                // interrupting a login that was about to succeed.
                const wantsAction = authLatched || !liveSocket || !isAuthenticated();

                // Rate-limited: an automated Catch -> reconnect loop would otherwise
                // unlatch-and-retry on every message, turning this escape hatch into
                // the login hammer the latch exists to prevent.
                if (wantsAction) {
                    const now = monotonicMs();
                    const sinceLast = now - lastForcedReconnectAt;
                    if (sinceLast < reconnectCooldownMs) {
                        done(new Error(`WebIQ reconnect refused: the last forced reconnect was ${Math.round(sinceLast / 1000)}s ago; wait ${Math.ceil((reconnectCooldownMs - sinceLast) / 1000)}s. This limit protects the account from the server's login-attempt limiter.`));
                        return;
                    }
                    lastForcedReconnectAt = now;

                    if (authLatched) {
                        // Grants exactly ONE fresh attempt - see clearAuthLatch().
                        clearAuthLatch();
                    }
                    node.status({ fill: 'grey', shape: 'ring', text: 'reconnecting on request' });
                    connect();
                }
                // A healthy node treats the verb as a no-op; the budget is NOT
                // touched, so a periodic "nudge" cannot restore infinite retry.

                // A payload on a control message is not sent anywhere. Failing the
                // message says so - a recovery flow that re-sends the failed write
                // with the flag attached must learn the write did NOT happen.
                if (msg.payload !== undefined) {
                    done(new Error('WebIQ reconnect control message: the payload was NOT sent. Resend the request once the node is authenticated.'));
                } else {
                    done();
                }
                return;
            }

            if (authLatched) {
                done(new Error(`WebIQ login is blocked: ${authLatchReason}. Fix the credentials and redeploy, or send msg.webiq = "reconnect" to retry.`));
                return;
            }

            const ctx = activeContext;
            const socket = ctx && ctx.socket;

            if (!socket || socket.readyState !== WebSocket.OPEN) {
                done(new Error('WebSocket is not connected'));
                return;
            }

            if (!isAuthenticated()) {
                done(new Error('Cannot send: not authenticated yet'));
                return;
            }

            if (
                !msg.payload ||
                !msg.payload.cmd ||
                msg.payload.id === undefined ||
                msg.payload.data === undefined
            ) {
                done(new Error('Payload is missing required fields: cmd, id, data'));
                return;
            }

            // Serialise inside the guard: a circular or BigInt payload throws here,
            // and an exception escaping an input handler is not something Node-RED
            // can attribute to this message.
            let serialized;
            try {
                serialized = JSON.stringify(msg.payload);
            } catch (err) {
                done(new Error(`Could not serialise payload: ${err.message}`));
                return;
            }

            // JSON.stringify can also produce NO output without throwing (a
            // toJSON returning undefined). Buffer.byteLength(undefined) would
            // then throw synchronously OUT of this handler - unattributable to
            // the message, invisible to Catch.
            if (typeof serialized !== 'string') {
                done(new Error('Could not serialise payload: JSON.stringify produced no output (does the payload have a toJSON that returns undefined?).'));
                return;
            }

            // Backpressure: if the peer has stopped reading, refuse rather than grow
            // the buffer indefinitely. A link that stays stalled is caught separately
            // by the heartbeat, which sees no traffic and terminates it. The frame
            // about to be queued counts towards the limit - ignoring it would let a
            // single large request sail past the check it is meant to be caught by.
            const frameBytes = Buffer.byteLength(serialized);
            if (socket.bufferedAmount + frameBytes > maxBufferedBytes) {
                ctx.sendDegraded = true;
                node.status({ fill: 'yellow', shape: 'ring', text: 'send buffer full' });
                done(new Error(`WebIQ send buffer is backed up (${socket.bufferedAmount} bytes queued, this request adds ${frameBytes}); dropping this request.`));
                return;
            }

            socket.send(serialized, function (err) {
                if (err) {
                    done(err);
                    return;
                }
                // Recovered: a send got through, so stop showing the warning badge.
                // Only the socket that raised the warning may clear it: a delayed
                // callback from a superseded socket must not paint over the state of
                // the connection that replaced it.
                if (owns(ctx) && ctx.sendDegraded) {
                    ctx.sendDegraded = false;
                    if (isAuthenticated()) {
                        node.status({ fill: 'green', shape: 'dot', text: 'authenticated' });
                    }
                }
                done();
            });
        });

        // Node-RED passes (done) for an arity-1 handler and (removed, done) for
        // arity 2. Taking two parameters is what makes the runtime await teardown
        // instead of starting the replacement node while this socket is still open.
        node.on('close', function (removed, done) {
            const complete = typeof done === 'function'
                ? done
                : (typeof removed === 'function' ? removed : function () {});

            closing = true;

            if (reconnectTimer) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }

            const ctx = activeContext;
            activeContext = null;

            if (ctx) {
                setState(ctx, STATE.CLOSING);
                clearTimers(ctx);
                detachHandlers(ctx);
            }

            const socket = ctx && ctx.socket;
            if (!socket || socket.readyState === WebSocket.CLOSED) {
                complete();
                return;
            }

            let finished = false;
            let forceTimer = null;

            function finish() {
                if (finished) { return; }
                finished = true;
                if (forceTimer) { clearTimeout(forceTimer); }
                complete();
            }

            forceTimer = setTimeout(function () {
                try { socket.terminate(); } catch (_) {}
                finish();
            }, CLOSE_GRACE_MS);
            if (typeof forceTimer.unref === 'function') { forceTimer.unref(); }

            socket.once('close', finish);

            // An error is not a close. Finishing straight from 'error' would clear the
            // force timer and tell Node-RED teardown was done while the socket is
            // still alive, so force it down first.
            socket.once('error', function () {
                try { socket.terminate(); } catch (_) {}
                finish();
            });

            try {
                socket.close();
            } catch (_) {
                try { socket.terminate(); } catch (_) {}
                finish();
            }
        });

        // Handlers above are registered unconditionally so a misconfigured node still
        // answers messages; only the connection itself is skipped.
        if (!configError) {
            connect();
        }
    }

    RED.nodes.registerType("webiq-api-connect", WebIQNode, {
        credentials: {
            username: { type: "text" },
            password: { type: "password" }
        }
    });
};

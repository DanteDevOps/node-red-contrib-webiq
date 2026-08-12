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

    // Total consecutive failed logins - rejections AND timeouts, across sockets -
    // before the node gives up entirely. Counted node-wide on purpose: a per-socket
    // counter resets every time the server hangs up, so the ladder never climbs and
    // the node can burn login attempts indefinitely against an account that other
    // WebIQ clients (the HMI itself) also depend on.
    const MAX_LOGIN_ATTEMPTS = 5;

    function describeServerError(error) {
        if (!error) { return 'unknown error'; }
        const parts = [];
        if (error.category) { parts.push(error.category); }
        if (error.errc !== undefined) { parts.push('errc ' + error.errc); }
        if (error.code !== undefined) { parts.push('code ' + error.code); }
        const prefix = parts.length ? `[${parts.join(' ')}] ` : '';
        return prefix + (error.message || 'no message');
    }

    function isLockout(error) {
        if (!error) { return false; }
        if (error.errc === LOCKOUT_ERRC && /user/.test(String(error.category || ''))) { return true; }
        return LOCKOUT_PATTERN.test(String(error.message || ''));
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
        const configuredHeartbeat = heartbeatProvided ? Number(config.heartbeat) : NaN;
        const heartbeatIsValid = Number.isFinite(configuredHeartbeat) && configuredHeartbeat >= 0;
        const heartbeatSeconds = heartbeatIsValid
            ? Math.min(configuredHeartbeat, maxHeartbeatSeconds)
            : defaultHeartbeatSeconds;
        const heartbeatMs = heartbeatSeconds * 1000;

        if (heartbeatIsValid && configuredHeartbeat > maxHeartbeatSeconds) {
            node.warn(`Heartbeat of ${configuredHeartbeat}s exceeds the ${maxHeartbeatSeconds}s maximum; using ${maxHeartbeatSeconds}s.`);
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

            // A bare IPv6 literal has to be bracketed or the authority is ambiguous.
            let trimmedHost = String(host).trim();
            if ((trimmedHost.match(/:/g) || []).length >= 2 && trimmedHost[0] !== '[') {
                trimmedHost = `[${trimmedHost}]`;
            }

            return {
                url: `${scheme}://${trimmedHost}:${portNumber}/${encodeURIComponent(trimmedProject)}/`
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

        // Login budget and terminal latch. Both are node-scoped so they survive the
        // socket churn that a rejecting server causes.
        let loginAttemptsUsed = 0;
        let authLatched = false;
        let authLatchReason = null;

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
                authenticatedAt: null,
                failureKind: null,
                upgradePermanent: false,
                sendDegraded: false,
                loginAttempted: false,
                authFailures: 0,
                missedHeartbeats: 0,
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
            loginAttemptsUsed = 0;
        }

        // Any traffic at all proves the link is alive, not just a pong. A WebIQ
        // server that is streaming data but does not answer pings must not be
        // terminated as dead.
        function markAlive(ctx) {
            if (ctx) { ctx.missedHeartbeats = 0; }
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

            ctx.timers.heartbeat = setInterval(function () {
                const socket = ctx.socket;

                if (!owns(ctx) || !socket || socket.readyState !== WebSocket.OPEN) {
                    stopHeartbeat(ctx);
                    return;
                }

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

                ctx.missedHeartbeats += 1;
                try { socket.ping(); } catch (_) {}
            }, heartbeatMs);

            if (typeof ctx.timers.heartbeat.unref === 'function') {
                ctx.timers.heartbeat.unref();
            }
        }

        function connect() {
            if (closing || authLatched) { return; }

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
                } catch (e) {
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
                if (parsed && parsed.error && parsed.cmd !== 'user.login') {
                    node.error(
                        new Error(`WebIQ rejected ${parsed.cmd || 'request'}: ${describeServerError(parsed.error)}`),
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

                // Preserve the badge whichever path we arrived by. These used to be
                // repainted to a generic 'disconnected' within milliseconds, so
                // states the documentation described were never actually observable.
                if (ctx.failureKind === 'project-not-found') {
                    node.status({ fill: 'red', shape: 'ring', text: 'project not found' });
                } else if (ctx.failureKind === 'heartbeat-timeout') {
                    node.status({ fill: 'red', shape: 'ring', text: 'link stale - reconnecting' });
                } else if (ctx.failureKind === 'login-timeout') {
                    node.status({ fill: 'red', shape: 'ring', text: 'login timeout' });
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
                    } else if (/CERT|SELF_SIGNED|DEPTH_ZERO/.test(cause.code)) {
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

                // A misconfigured endpoint cannot start working on its own, so
                // hammering it on the fast ladder only generates noise.
                const misconfigured = ctx.failureKind === 'project-not-found' ||
                    ctx.failureKind === 'login-timeout' ||
                    ctx.upgradePermanent === true;
                scheduleReconnect(misconfigured ? slowRetryDelay : undefined);
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
            ctx.loginAttempted = true;

            if (ctx.timers.loginTimeout) {
                clearTimeout(ctx.timers.loginTimeout);
                ctx.timers.loginTimeout = null;
            }

            if (!message.error) {
                ctx.authenticatedAt = Date.now();
                ctx.failureKind = null;
                ctx.authFailures = 0;
                loginAttemptsUsed = 0;
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

            if (message.error.code === 404) {
                // The project is wrong or not yet loaded. Report it, forward the frame
                // (the caller does that), then close so the normal reconnect path runs
                // on a slow ladder - rather than sitting on a live, unauthenticated
                // socket forever with no timer armed and no way back.
                ctx.failureKind = 'project-not-found';
                setState(ctx, STATE.AUTH_RETRY_WAIT, { fill: 'red', shape: 'ring', text: 'project not found' });
                node.error("WebIQ project name invalid: " + message.error.message);
                try { ctx.socket.close(); } catch (_) {}
                return;
            }

            ctx.failureKind = 'auth-rejected';
            ctx.authFailures += 1;
            loginAttemptsUsed += 1;

            const described = describeServerError(message.error);

            // The server telling us to stop must never be answered with another
            // attempt - that is precisely what keeps a sliding lockout window open.
            if (isLockout(message.error)) {
                latchAuthFailure(`the server refused the login: ${described}`);
                return;
            }

            if (loginAttemptsUsed >= MAX_LOGIN_ATTEMPTS) {
                latchAuthFailure(`${loginAttemptsUsed} consecutive failed logins (last: ${described})`);
                return;
            }

            const authRetryDelay = Math.min(
                initialAuthRetryDelay * Math.pow(2, ctx.authFailures - 1),
                maxAuthRetryDelay
            );

            setState(ctx, STATE.AUTH_RETRY_WAIT, {
                fill: 'yellow',
                shape: 'ring',
                text: `login failed (${loginAttemptsUsed}/${MAX_LOGIN_ATTEMPTS})`
            });
            // Always relay the server's own words: it is the only thing that
            // distinguishes a wrong password from a licence limit or a lockout, and
            // discarding it sends the user to check the wrong thing.
            node.warn(`WebIQ login rejected ${described} - attempt ${loginAttemptsUsed} of ${MAX_LOGIN_ATTEMPTS}, retrying in ${authRetryDelay / 1000}s.`);

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

                ctx.failureKind = 'login-timeout';

                // A login the server never answered may still have been counted by
                // its attempt limiter, so it spends the same budget as a rejection.
                // Without this, a slow project reconnects on the fast transport
                // ladder and issues thousands of logins a day with no typo involved.
                loginAttemptsUsed += 1;

                node.status({ fill: 'red', shape: 'ring', text: 'login timeout' });
                node.error(`No login reply received within ${loginTimeoutSeconds}s (attempt ${loginAttemptsUsed} of ${MAX_LOGIN_ATTEMPTS}): the server may be unreachable or slow to answer, or the timeout may be too short for this project.`);

                if (loginAttemptsUsed >= MAX_LOGIN_ATTEMPTS) {
                    latchAuthFailure(`${loginAttemptsUsed} consecutive logins went unanswered`);
                    return;
                }

                try { socket.close(); } catch (_) {}
            }, loginTimeoutMs);
        }

        // +/-20% jitter, so a site with many gateways does not stampede a WebIQ
        // server the instant it comes back up.
        function withJitter(delay) {
            // Clamped after jittering, so the documented 30s ceiling is a real
            // ceiling rather than 30s +20%.
            return Math.min(
                Math.round(delay * (0.8 + (Math.random() * 0.4))),
                maxReconnectDelay
            );
        }

        function scheduleReconnect(overrideDelayMs) {
            if (reconnectTimer || closing || authLatched) { return; }

            const base = typeof overrideDelayMs === 'number' ? overrideDelayMs : reconnectDelay;

            reconnectTimer = setTimeout(function () {
                reconnectTimer = null;
                reconnectDelay = Math.min(reconnectDelay * 2, maxReconnectDelay);
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
                const wasLatched = authLatched;
                clearAuthLatch();
                if (wasLatched || !activeContext) {
                    node.status({ fill: 'grey', shape: 'ring', text: 'reconnecting on request' });
                    connect();
                }
                done();
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

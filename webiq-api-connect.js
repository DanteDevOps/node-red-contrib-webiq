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

    function WebIQNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        const host = config.host;
        const port = config.port;
        const project = config.project;

        // Credentials live in Node-RED's separate credential store: it is not written
        // to flows.json and is excluded from flow exports. A username or password
        // still sitting on the node config comes from a pre-2.0 flow - honour it so
        // the node keeps working, but say so, because that value is in cleartext in
        // the flow file and in every export taken of it.
        //
        // The two are resolved as a pair, never mixed: a half-migrated node that took
        // its username from the credential store and its password from the flow file
        // would fail to log in for reasons nobody could reasonably diagnose.
        const credentials = node.credentials || {};
        const hasStoredCredentials = !!(credentials.username || credentials.password);
        const username = hasStoredCredentials ? credentials.username : config.username;
        const password = hasStoredCredentials ? credentials.password : config.password;

        if (!hasStoredCredentials && (config.username || config.password)) {
            node.warn('WebIQ credentials are stored in the flow file in cleartext. Open this node, re-enter the username and password, and redeploy to move them into the Node-RED credential store.');
        }

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

        // Terminate only after this many consecutive silent intervals. A threshold of
        // one would make a single dropped frame - or a server that is briefly busy -
        // look like a dead link.
        const heartbeatMissThreshold = 2;

        // Endpoint validation. Everything that would produce a malformed or
        // surprising URL is caught here rather than at socket-construction time.
        function buildEndpoint() {
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
                url: `ws://${trimmedHost}:${portNumber}/${encodeURIComponent(trimmedProject)}/`
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
            if (closing) { return; }

            let socket;
            try {
                socket = new WebSocket(url, 'smarthmi-connect', {
                    handshakeTimeout: handshakeTimeoutMs,
                    maxPayload: maxPayloadBytes
                });
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
                node.send({ payload: parsed });
            };

            ctx.handlers.error = function (err) {
                if (!owns(ctx)) { return; }

                // A non-101 response to the upgrade is a different failure from a
                // WebIQ JSON error carrying the same code: it means the server never
                // accepted the WebSocket at all, usually because the project segment
                // of the URL path is wrong.
                const upgrade = /Unexpected server response: (\d{3})/.exec(err.message || '');
                if (upgrade) {
                    ctx.failureKind = 'http-upgrade-' + upgrade[1];
                    node.status({ fill: 'red', shape: 'ring', text: `server rejected upgrade (HTTP ${upgrade[1]})` });
                    node.error(`WebIQ server rejected the WebSocket upgrade with HTTP ${upgrade[1]}: check the project name in the connection URL.`);
                    return;
                }

                node.warn(`WebSocket error: ${err.message}`);
            };

            ctx.handlers.close = function () {
                if (!owns(ctx)) { return; }

                clearTimers(ctx);
                activeContext = null;

                if (closing) { return; }

                if (ctx.failureKind === 'project-not-found') {
                    // Status and error were already reported when the 404 arrived;
                    // don't overwrite the more specific badge with a generic one.
                    node.status({ fill: 'red', shape: 'ring', text: 'project not found' });
                } else if (String(ctx.failureKind).startsWith('http-upgrade-')) {
                    // Ditto for an upgrade rejection.
                } else if (!ctx.loginAttempted) {
                    node.status({ fill: 'red', shape: 'ring', text: 'project not found / connection failed' });
                    node.error('WebIQ project may be invalid or server unreachable.');
                } else {
                    node.status({ fill: 'red', shape: 'ring', text: 'disconnected' });
                }

                setState(ctx, STATE.RECONNECT_WAIT);

                // Both a WebIQ 404 and an HTTP upgrade rejection mean the endpoint is
                // misconfigured, not momentarily unavailable. Hammering it on the fast
                // ladder just pounds a route that cannot start working on its own.
                const misconfigured = ctx.failureKind === 'project-not-found' ||
                    String(ctx.failureKind).startsWith('http-upgrade-');
                scheduleReconnect(misconfigured ? slowRetryDelay : undefined);
            };

            socket.on('open', ctx.handlers.open);
            socket.on('message', ctx.handlers.message);
            socket.on('pong', ctx.handlers.pong);
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
                if (ctx.timers.authRetry) {
                    clearTimeout(ctx.timers.authRetry);
                    ctx.timers.authRetry = null;
                }
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
            const authRetryDelay = Math.min(
                initialAuthRetryDelay * Math.pow(2, ctx.authFailures - 1),
                maxAuthRetryDelay
            );

            setState(ctx, STATE.AUTH_RETRY_WAIT, { fill: 'yellow', shape: 'ring', text: 'connected - login failed' });
            // Warn on the transition only; the retry itself is silent so a bad
            // password cannot flood the log indefinitely.
            if (ctx.authFailures === 1) {
                node.warn(`WebIQ login failed, retrying (backing off up to ${maxAuthRetryDelay / 1000}s).`);
            }

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
                node.status({ fill: 'red', shape: 'ring', text: 'login timeout / project not found' });
                node.error(`No login reply received within ${loginTimeoutSeconds}s: project may be invalid, server unreachable, or the timeout is too short for this project.`);
                try { socket.close(); } catch (_) {}
            }, loginTimeoutMs);
        }

        // +/-20% jitter, so a site with many gateways does not stampede a WebIQ
        // server the instant it comes back up.
        function withJitter(delay) {
            return Math.round(delay * (0.8 + (Math.random() * 0.4)));
        }

        function scheduleReconnect(overrideDelayMs) {
            if (reconnectTimer || closing) { return; }

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
            // by the heartbeat, which sees no pong and terminates it.
            if (socket.bufferedAmount > maxBufferedBytes) {
                node.status({ fill: 'yellow', shape: 'ring', text: 'send buffer full' });
                done(new Error(`WebIQ send buffer is backed up (${socket.bufferedAmount} bytes); dropping this request.`));
                return;
            }

            socket.send(serialized, function (err) {
                if (err) {
                    done(err);
                    return;
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

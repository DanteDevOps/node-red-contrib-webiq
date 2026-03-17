module.exports = function (RED) {
    const WebSocket = require('ws');

    function WebIQNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.log("WEBIQ API CONNECT loaded (LOCAL DEV)");

        const host = config.host;
        const port = config.port;
        const project = config.project;
        const username = config.username;
        const password = config.password;
        const url = `ws://${host}:${port}/${project}/`;

        function isValidHost(host) {
            if (!host || host.trim() === "") return false;
            try {
                // Use native URL parser to ensure the format is valid (catches spaces, illegal chars, etc)
                new URL(`ws://${host}`);
                return true;
            } catch (err) {
                return false;
            }
        }

        if (!isValidHost(host)) {
            node.status({ fill: 'red', shape: 'ring', text: 'host missing' });
            node.error('Host is empty or missing.');
            return;
        }

        if (!project || project.trim() === "") {
            node.status({ fill: 'red', shape: 'ring', text: 'project missing' });
            node.error("WebIQ project name is empty or missing!");
            return;
        }

        let ws = null;
        let reconnectTimer = null;
        let reconnectDelay = 1000;
        const maxReconnectDelay = 30000;
        let closing = false;
        let authenticated = false;

        let loginRetryTimer = null;
        const loginRetryDelay = 5000;
        let loginAttempted = false;
        let loginTimeout = null;

        function connect() {
            if (closing) return;

            authenticated = false;
            loginAttempted = false;
            node.status({ fill: 'red', shape: 'ring', text: 'disconnected' });

            try {
                ws = new WebSocket(url, 'smarthmi-connect');
            } catch (err) {
                node.status({ fill: 'red', shape: 'ring', text: 'invalid host string' });
                node.error(`Could not create WebSocket connection: ${err.message}`);
                return;
            }

            ws.on('open', function () {
                reconnectDelay = 1000;
                node.status({ fill: 'yellow', shape: 'ring', text: 'connected - login pending' });
                attemptLogin();
            });

            ws.on('message', function (data) {
                try {
                    const parsedMessage = JSON.parse(data.toString());

                    if (parsedMessage.cmd === "user.login") {
                        loginAttempted = true;

                        if (loginTimeout) {
                            clearTimeout(loginTimeout);
                            loginTimeout = null;
                        }

                        if (!parsedMessage.error) {
                            authenticated = true;
                            node.status({ fill: 'green', shape: 'dot', text: 'authenticated' });
                            if (loginRetryTimer) {
                                clearTimeout(loginRetryTimer);
                                loginRetryTimer = null;
                            }
                        } else {
                            authenticated = false;
                            if (parsedMessage.error.code === 404) {
                                node.status({ fill: 'red', shape: 'ring', text: 'project not found' });
                                node.error("WebIQ project name invalid: " + parsedMessage.error.message);
                                return;
                            } else {
                                node.status({ fill: 'yellow', shape: 'ring', text: 'connected - login failed' });
                                node.warn('WebIQ login failed, retrying in 5s...');
                                if (loginRetryTimer) clearTimeout(loginRetryTimer);
                                loginRetryTimer = setTimeout(attemptLogin, loginRetryDelay);
                            }
                        }
                    }

                    node.send({ payload: parsedMessage });
                } catch (e) {
                    node.send({ payload: data });
                }
            });

            ws.on('error', function (err) {
                node.warn(`WebSocket error: ${err.message}`);
            });

            ws.on('close', function () {
                ws = null;
                authenticated = false;

                if (loginTimeout) {
                    clearTimeout(loginTimeout);
                    loginTimeout = null;
                }

                if (closing) return;

                if (!loginAttempted) {
                    node.status({ fill: 'red', shape: 'ring', text: 'project not found / connection failed' });
                    node.error('WebIQ project may be invalid or server unreachable.');
                } else {
                    node.status({ fill: 'red', shape: 'ring', text: 'disconnected' });
                }

                scheduleReconnect();
            });
        }

        function attemptLogin() {
            if (ws && ws.readyState === WebSocket.OPEN) {
                loginAttempted = true;

                ws.send(JSON.stringify({
                    cmd: "user.login",
                    id: 0,
                    data: { username, password, realm: null }
                }));

                if (loginTimeout) clearTimeout(loginTimeout);
                loginTimeout = setTimeout(() => {
                    if (!authenticated) {
                        node.status({ fill: 'red', shape: 'ring', text: 'login timeout / project not found' });
                        node.error('No login reply received: project may be invalid or server unreachable.');
                        try { ws.close(); } catch (_) {}
                    }
                }, 5000);
            }
        }

        function scheduleReconnect() {
            if (reconnectTimer || closing) return;

            reconnectTimer = setTimeout(() => {
                reconnectTimer = null;
                reconnectDelay = Math.min(reconnectDelay * 2, maxReconnectDelay);
                connect();
            }, reconnectDelay);
        }

        node.on('input', function (msg) {
            if (ws && ws.readyState === WebSocket.OPEN) {
                if (!authenticated) {
                    node.error('Cannot send: not authenticated yet');
                    return;
                }

                if (
                    msg.payload &&
                    msg.payload.cmd &&
                    msg.payload.id !== undefined &&
                    msg.payload.data !== undefined
                ) {
                    ws.send(JSON.stringify(msg.payload));
                } else {
                    node.error('Payload is missing required fields: cmd, id, data');
                }
            } else {
                node.error('WebSocket is not connected');
            }
        });

        node.on('close', function () {
            closing = true;
            if (reconnectTimer) clearTimeout(reconnectTimer);
            if (loginRetryTimer) clearTimeout(loginRetryTimer);
            if (loginTimeout) clearTimeout(loginTimeout);
            if (ws) try { ws.close(); } catch (_) {}
            authenticated = false;
        });

        connect();
    }

    RED.nodes.registerType("webiq-api-connect", WebIQNode);
};

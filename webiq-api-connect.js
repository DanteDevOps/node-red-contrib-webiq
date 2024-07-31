module.exports = function(RED) {
    const WebSocket = require('ws');

    function WebIQNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;

        const host = config.host;
        const port = config.port;
        const project = config.project;
        const username = config.username;
        const password = config.password;
        const url = `ws://${host}:${port}/${project}/`;

        const ws = new WebSocket(url, 'smarthmi-connect');

        ws.on('open', function open() {
            node.status({ fill: 'green', shape: 'dot', text: 'connected' });
            console.log('Connected to WebIQ server');

            // Log in upon connection
            const loginPayload = JSON.stringify({
                cmd: "user.login",
                id: 0,
                data: {
                    username: username,
                    password: password,
                    realm: null
                }
            });

            ws.send(loginPayload);
        });

        ws.on('error', function error(err) {
            node.status({ fill: 'red', shape: 'ring', text: 'disconnected' });
            console.error('WebSocket error:', err);
        });

        ws.on('message', function message(data) {
            try {
                const message = data.toString();
                const parsedMessage = JSON.parse(message);
                var msg = { payload: parsedMessage };
                if (parsedMessage.cmd === "user.login" && !parsedMessage.error) {
                    node.status({ fill: 'green', shape: 'dot', text: 'authenticated' });
                }
                node.send(msg);
            } catch (e) {
                var msg = { payload: data };
                node.send(msg);
            }
        });

        ws.on('close', function close() {
            node.status({ fill: 'red', shape: 'ring', text: 'disconnected' });
            console.log('Disconnected from WebIQ server');
        });

        node.on('input', function(msg) {
            if (ws.readyState === WebSocket.OPEN) {
                if (msg.payload && msg.payload.cmd && msg.payload.id !== undefined && msg.payload.data !== undefined) {
                    ws.send(JSON.stringify(msg.payload));
                } else {
                    node.error('Payload is missing required fields: cmd, id, data');
                }
            } else {
                node.error('WebSocket is not open');
            }
        });

        node.on('close', function() {
            ws.close();
        });
    }

    RED.nodes.registerType("webiq-api-connect", WebIQNode);
};

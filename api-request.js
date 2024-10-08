module.exports = function(RED) {
    function InjectCmdIdDataNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;

        function sendPayload() {
            try {
                let data = JSON.parse(config.data);
                var msg = {
                    payload: {
                        cmd: config.cmd,
                        id: parseInt(config.id, 10),
                        data: data
                    }
                };
                node.send(msg);
            } catch (error) {
                node.error("Invalid JSON in data field", error);
            }
        }

        node.on('input', function() {
            sendPayload();
        });

        if (config.interval > 0) {
            setInterval(() => {
                sendPayload();
            }, config.interval);
        }
    }

    RED.nodes.registerType("api-request", InjectCmdIdDataNode);
};

module.exports = function (RED) {
    function ApiRequestNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.on('input', function(msg) {
            let payload = {};
            try {
                payload = JSON.parse(config.data || "{}");
            } catch (err) {
                node.warn("Invalid JSON in Data field, sending empty object");
            }
            msg.payload = payload;
            node.send(msg);
        });

        node.status({ fill: "blue", shape: "dot", text: "ready" });
    }

    RED.nodes.registerType("api-request", ApiRequestNode);
};
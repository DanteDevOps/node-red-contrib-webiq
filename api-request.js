module.exports = function (RED) {
    function ApiRequestNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // Parse the configured payload once, at construction. It is static
        // configuration, so re-parsing it per message only buys the chance to
        // report the same fault repeatedly - and a bad value should be visible on
        // the canvas at deploy time rather than the first time a message arrives.
        let template = null;
        let templateError = null;

        try {
            template = JSON.parse(config.data || "{}");
        } catch (err) {
            templateError = new Error(`Invalid JSON in Data field: ${err.message}`);
        }

        node.status(templateError
            ? { fill: "red", shape: "ring", text: "invalid JSON" }
            : { fill: "blue", shape: "dot", text: "ready" });

        node.on('input', function (msg, send, done) {
            // Node-RED 1.0+ supplies send/done; the fallbacks keep the node working
            // when it is driven directly, as the tests do.
            send = send || function () { node.send.apply(node, arguments); };
            done = done || function (err) { if (err) { node.error(err, msg); } };

            if (templateError) {
                done(templateError);
                return;
            }

            // Clone per message: the template is shared across every message this
            // node handles, and a downstream node mutating msg.payload would
            // otherwise corrupt it for all subsequent messages.
            msg.payload = RED.util && typeof RED.util.cloneMessage === 'function'
                ? RED.util.cloneMessage(template)
                : JSON.parse(JSON.stringify(template));

            send(msg);
            done();
        });
    }

    RED.nodes.registerType("api-request", ApiRequestNode);
};

module.exports = function (RED) {
    // A WebIQ request must carry these three fields or the connection node rejects
    // it. Checking here turns a generic downstream failure into one that names the
    // node the user actually has to fix.
    function describeInvalidRequest(payload) {
        if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
            return 'the value is not a request object';
        }
        if (!payload.cmd) { return 'missing "cmd"'; }
        if (payload.id === undefined) { return 'missing "id"'; }
        if (payload.data === undefined) { return 'missing "data"'; }
        return null;
    }

    function ApiRequestNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // Nodes created before the typed-input existed have no dataType and are
        // always plain JSON.
        const dataType = config.dataType || 'json';
        const isStatic = dataType === 'json';

        // A static payload is parsed once, at construction: it cannot change between
        // messages, so re-parsing it only buys the chance to report the same fault
        // repeatedly, and a bad value should show on the canvas at deploy time.
        let template = null;
        let templateError = null;

        if (isStatic) {
            try {
                template = JSON.parse(config.data || "{}");
            } catch (err) {
                templateError = new Error(`Invalid JSON in Data field: ${err.message}`);
            }

            if (!templateError) {
                const problem = describeInvalidRequest(template);
                if (problem) {
                    templateError = new Error(`Data field is not a valid WebIQ request: ${problem}.`);
                }
            }
        }

        node.status(templateError
            ? { fill: "red", shape: "ring", text: "invalid request" }
            : { fill: "blue", shape: "dot", text: "ready" });

        function clone(value) {
            return RED.util && typeof RED.util.cloneMessage === 'function'
                ? RED.util.cloneMessage(value)
                : JSON.parse(JSON.stringify(value));
        }

        // A dynamic source may yield a JSON string rather than an object - an env
        // var always will.
        function coerce(value) {
            if (typeof value === 'string') {
                try { return JSON.parse(value); } catch (err) { return value; }
            }
            return value;
        }

        node.on('input', function (msg, send, done) {
            send = send || function () { node.send.apply(node, arguments); };
            done = done || function (err) { if (err) { node.error(err, msg); } };

            if (isStatic) {
                if (templateError) {
                    done(templateError);
                    return;
                }
                // Clone per message: the template is shared, and a downstream node
                // mutating msg.payload would corrupt it for every later message.
                msg.payload = clone(template);
                send(msg);
                done();
                return;
            }

            if (!RED.util || typeof RED.util.evaluateNodeProperty !== 'function') {
                done(new Error(`Data type "${dataType}" needs a Node-RED runtime providing RED.util.evaluateNodeProperty.`));
                return;
            }

            // Callback form: context stores can be asynchronous, so the synchronous
            // return value is not safe to rely on.
            RED.util.evaluateNodeProperty(config.data, dataType, node, msg, function (err, value) {
                if (err) {
                    done(err);
                    return;
                }

                const payload = coerce(value);
                const problem = describeInvalidRequest(payload);
                if (problem) {
                    done(new Error(`${dataType}.${config.data} is not a valid WebIQ request: ${problem}.`));
                    return;
                }

                msg.payload = payload;
                send(msg);
                done();
            });
        });
    }

    RED.nodes.registerType("api-request", ApiRequestNode);
};

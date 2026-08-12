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

        // The 1.0.x node stored cmd / data / interval as separate properties and its
        // data field held only the request DATA, not a whole request. Reading that as
        // a modern full-request JSON produces a baffling "not a valid WebIQ request"
        // error, so name the real problem instead - and quote the node's own old
        // values, because after this release those are the only record of what it did.
        //
        // Not auto-migrated on purpose: `interval` polled on its own, which this node
        // does not do, so a silent conversion would quietly stop a flow polling.
        //
        // Empty counts as absent: the editor now declares these deprecated fields (so
        // a full deploy cannot strip them) and gives new nodes "".
        const legacyValue = (v) => (v === undefined || v === null || v === '' ? null : v);
        const legacyCmd = legacyValue(config.cmd);
        const legacyInterval = legacyValue(config.interval);
        const isLegacySchema = legacyCmd !== null || legacyInterval !== null;

        // A static payload is parsed once, at construction: it cannot change between
        // messages, so re-parsing it only buys the chance to report the same fault
        // repeatedly, and a bad value should show on the canvas at deploy time.
        let template = null;
        let templateError = null;
        let warnedAboutReservedId = false;

        if (isLegacySchema) {
            const parts = ['This API Request node uses the pre-1.1 layout, which is no longer supported.'];
            if (legacyCmd !== null) { parts.push(`Its command was "${legacyCmd}".`); }
            parts.push(`Open the node and put the whole request into the Data field as JSON, for example {"cmd":"${legacyCmd || 'io.read'}","id":1,"data":${config.data || '["Tag"]'}}.`);

            if (legacyInterval !== null) {
                // The 1.0.x field was MILLISECONDS - it went straight into
                // setInterval, and its editor label said "Interval (ms)". Describing
                // it as seconds would send a user to rebuild a 500 ms poll as a
                // 500 second one.
                const ms = Number(legacyInterval);
                const asSeconds = Number.isFinite(ms) && ms > 0 ? (ms / 1000) : null;
                parts.push(
                    Number.isFinite(ms) && ms > 0
                        ? `It also polled itself every ${ms} ms. There is no built-in polling; drive it from an Inject node set to repeat every ${asSeconds} s.`
                        : 'Its polling interval was 0 (disabled). There is no built-in polling; use an Inject node if you need it.'
                );
            }

            templateError = new Error(parts.join(' '));
        } else if (isStatic) {
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

            // id 0 is reserved for the connection node's own login. A request using it
            // still works, but a flow correlating replies by id alone cannot tell an
            // io.read answer from a login reply after a reconnect. 1.1.x shipped 0 as
            // the default, so warn rather than reject - refusing would break flows
            // that are working today.
            if (!templateError && template && template.id === 0) {
                node.warn('This request uses id 0, which the connection node reserves for its own login. Give each API Request node a distinct non-zero id so replies can be told apart.');
            }
        }

        node.status(templateError
            ? { fill: "red", shape: "ring", text: isLegacySchema ? "needs migration" : "invalid request" }
            : { fill: "blue", shape: "dot", text: "ready" });

        // Report at DEPLOY time, not only when a message arrives. A 1.0.x node polled
        // itself, so it commonly has nothing wired to its input - it would otherwise
        // show a bare "needs migration" badge and never say what to do about it.
        if (templateError) {
            node.error(templateError.message);
        }

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

                // The static branch checks this at deploy time; a dynamic source can
                // only be checked when a value actually arrives. Warned once so a
                // per-message stream cannot flood the log.
                if (payload.id === 0 && !warnedAboutReservedId) {
                    warnedAboutReservedId = true;
                    node.warn('This request used id 0, which the connection node reserves for its own login. Use a distinct non-zero id so replies can be told apart.');
                }

                // Clone here too: flow and global context return the STORED object
                // by reference, so emitting it directly would let any downstream
                // node permanently corrupt the template for every later message -
                // the exact hazard the static path already clones against.
                msg.payload = clone(payload);
                send(msg);
                done();
            });
        });
    }

    RED.nodes.registerType("api-request", ApiRequestNode);
};

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

        // One wording for both the deploy-time (static) and per-message
        // (dynamic) checks - the two copies had already drifted apart once.
        function warnReservedId() {
            if (warnedAboutReservedId) { return; }
            warnedAboutReservedId = true;
            node.warn('This request uses id 0, which the connection node reserves for its own login. Give each API Request node a distinct non-zero id so replies can be told apart.');
        }

        if (isLegacySchema) {
            const parts = ['This API Request node uses the pre-1.1 layout, which is no longer supported.'];
            if (legacyCmd !== null) { parts.push(`Its command was "${legacyCmd}".`); }
            // 1.0.x built the request id with parseInt() on the node's OWN id
            // property (the source of the old duplicate-node-ID bug), so a
            // generated hex id such as "738399a874eef1da" put 738399 on the
            // wire, and an id not starting with a digit serialised as null.
            // Reproducing that exact computation here is the only way to quote
            // the historical id back - Node-RED reserves 'id', so it cannot be
            // redeclared as an editor default.
            const legacyRequestId = parseInt(String(config.id || ''), 10);
            if (Number.isFinite(legacyRequestId)) {
                if (legacyRequestId === 0) {
                    parts.push('Its request id was 0, which is reserved for the connection\'s own login - pick a distinct non-zero id when migrating.');
                } else {
                    parts.push(`Its request id was ${legacyRequestId} - keep that number if a downstream flow filters replies by id.`);
                }
            } else {
                parts.push('Its request id was null on the wire: 1.0.x parsed a number out of this node\'s own id, which does not start with a digit, and JSON turned the result into null. A downstream flow filtering replies by id was matching null.');
            }
            // Quote the real historical id in the example whenever one existed
            // (negative included - only 0 and NaN genuinely need substituting):
            // the example is what users paste, and swapping the id there breaks
            // the downstream filter the previous sentence tells them to protect.
            const exampleId = Number.isFinite(legacyRequestId) && legacyRequestId !== 0 ? legacyRequestId : 1;
            parts.push(`Open the node and put the whole request into the Data field as JSON, for example {"cmd":"${legacyCmd || 'io.read'}","id":${exampleId},"data":${config.data || '["Tag"]'}}.`);

            if (legacyInterval !== null) {
                // The 1.0.x field was MILLISECONDS - it went straight into
                // setInterval, and its editor label said "Interval (ms)". Describing
                // it as seconds would send a user to rebuild a 500 ms poll as a
                // 500 second one.
                const ms = Number(legacyInterval);
                if (Number.isFinite(ms) && ms > 0 && ms <= 2147483647) {
                    parts.push(`It also polled itself every ${ms} ms. There is no built-in polling; drive it from an Inject node set to repeat every ${ms / 1000} s.`);
                } else if (ms > 2147483647) {
                    // Delays past the 32-bit timer limit (Infinity included)
                    // overflow Node's setInterval, which then fires every ~1 ms.
                    parts.push(`Its interval property held ${legacyInterval}, which overflows Node's timer - the old runtime actually polled at ~1 ms. Recreate the cadence you intended with an Inject node set to repeat.`);
                } else if (ms === 0) {
                    parts.push('Its polling interval was 0 (disabled). There is no built-in polling; use an Inject node if you need it.');
                } else {
                    // The 1.0.x runtime guarded polling with `config.interval > 0`,
                    // so a non-numeric or negative value never reached setInterval
                    // (verified against the shipped 1.0.x package).
                    parts.push(`Its interval property held "${legacyInterval}", which the old runtime's interval > 0 guard rejected - this node never polled. No Inject node is needed unless polling is actually wanted.`);
                }
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
                warnReservedId();
            }

            // Cloning happens per message; prove at deploy time that it can
            // work at all, so a pathologically nested (yet valid-JSON) request
            // shows on the canvas instead of failing on the first message.
            if (!templateError) {
                try {
                    clone(template);
                } catch (err) {
                    templateError = new Error(`Data field is too deeply nested to process: ${err && err.message ? err.message : err}`);
                }
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

        // Not RED.util.cloneMessage: that clones MESSAGES, and gives top-level
        // `req`/`res` the http-in treatment - a falsy one is deleted, a truthy
        // one is kept by reference and shared across every message - which
        // silently corrupts a request using those keys. The static template is
        // JSON by construction, so a structural clone is exact; a dynamic value
        // may carry non-JSON types (Buffer, Map), which clone but serialise per
        // plain JSON rules - a request must be plain JSON either way. Cloning
        // can still throw on extreme nesting; every caller must handle that.
        function clone(value) {
            return typeof structuredClone === 'function'
                ? structuredClone(value)
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
                try {
                    msg.payload = clone(template);
                } catch (err) {
                    // An unguarded throw here would skip done(): the message
                    // never completes and the error surfaces as an unattributed
                    // runtime catch instead of on this node.
                    done(new Error(`Could not clone the configured request: ${err && err.message ? err.message : err}`));
                    return;
                }
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
                if (payload.id === 0) {
                    warnReservedId();
                }

                // Clone here too: flow and global context return the STORED object
                // by reference, so emitting it directly would let any downstream
                // node permanently corrupt the template for every later message -
                // the exact hazard the static path already clones against.
                try {
                    msg.payload = clone(payload);
                } catch (cloneErr) {
                    done(new Error(`Could not clone ${dataType}.${config.data}: ${cloneErr && cloneErr.message ? cloneErr.message : cloneErr}`));
                    return;
                }
                send(msg);
                done();
            });
        });
    }

    RED.nodes.registerType("api-request", ApiRequestNode);
};

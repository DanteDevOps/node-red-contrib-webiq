const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { WebSocketServer } = require('ws');

function createRuntime(registerNode) {
    const registeredTypes = new Map();

    const RED = {
        // Minimal stand-ins for the RED.util helpers the nodes use. These exercise
        // the plumbing - callback shape, error routing, validation - not Node-RED's
        // real evaluation semantics; the opt-in node-red-runtime test covers those.
        util: {
            // Faithful to @node-red/util, not a friendly JSON round-trip: the
            // real cloneMessage deletes a falsy top-level req/res, keeps a
            // truthy one BY REFERENCE, and clones recursively (so deep values
            // overflow the stack). The friendly stub masked two real bugs.
            cloneMessage(value) {
                if (value === null || typeof value !== 'object') { return value; }
                const deep = (v) => {
                    if (v === null || typeof v !== 'object') { return v; }
                    if (Array.isArray(v)) { return v.map(deep); }
                    const out = {};
                    for (const k of Object.keys(v)) { out[k] = deep(v[k]); }
                    return out;
                };
                const req = value.req;
                const res = value.res;
                delete value.req;
                delete value.res;
                const cloned = deep(value);
                if (req) { value.req = req; cloned.req = req; }
                if (res) { value.res = res; cloned.res = res; }
                return cloned;
            },
            evaluateNodeProperty(value, type, node, msg, callback) {
                let result;
                try {
                    if (type === 'json') {
                        result = JSON.parse(value);
                    } else if (type === 'msg') {
                        result = String(value).split('.').reduce(
                            (acc, key) => (acc === undefined || acc === null ? acc : acc[key]),
                            msg
                        );
                    } else if (type === 'env') {
                        result = process.env[value];
                    } else if (type === 'flow' || type === 'global') {
                        const store = type === 'flow' ? node._flowContext : node._globalContext;
                        result = store ? store[value] : undefined;
                    } else {
                        result = value;
                    }
                } catch (err) {
                    if (callback) { return callback(err); }
                    throw err;
                }
                if (callback) { return callback(null, result); }
                return result;
            }
        },
        nodes: {
            createNode(node, config) {
                const emitter = new EventEmitter();

                // Node-RED populates node.credentials from its credential store, not
                // from the flow properties. Mirroring that here is what makes a
                // regression that ignored node.credentials actually fail.
                node.credentials = (config && config.credentials) || {};

                node.on = emitter.on.bind(emitter);
                node.once = emitter.once.bind(emitter);
                node.emit = emitter.emit.bind(emitter);
                node.removeListener = emitter.removeListener.bind(emitter);
                node.removeAllListeners = emitter.removeAllListeners.bind(emitter);
                node.listenerCount = emitter.listenerCount.bind(emitter);

                node.statuses = [];
                node.errors = [];
                node.warnings = [];
                node.sent = [];

                node.status = (status) => node.statuses.push(status);
                node.error = (error, msg) => node.errors.push({ error, msg });
                node.warn = (warning) => node.warnings.push(warning);
                node.log = () => {};
                node.send = (msg) => node.sent.push(msg);
            },
            registerType(name, constructor, options) {
                registeredTypes.set(name, { constructor, options });
            }
        }
    };

    registerNode(RED);

    return {
        create(name, config) {
            const registration = registeredTypes.get(name);
            assert.ok(registration, `Node type ${name} was not registered`);
            return new registration.constructor(config);
        },
        registration(name) {
            return registeredTypes.get(name);
        }
    };
}

async function waitFor(predicate, description, timeoutMs = 2500) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        const result = predicate();
        if (result) return result;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.fail(`Timed out waiting for ${description}`);
}

async function createWebIQServer(onRequest) {
    const server = new WebSocketServer({ port: 0 });
    const requests = [];

    server.on('connection', (socket) => {
        socket.on('message', (raw) => {
            // Guarded: a single non-JSON frame must fail one assertion, not
            // crash the whole test process from inside a ws event handler.
            let request;
            try {
                request = JSON.parse(raw.toString());
            } catch (_) {
                return;
            }
            requests.push(request);
            onRequest({ request, socket, requests });
        });
    });

    await once(server, 'listening');

    return {
        port: server.address().port,
        requests,
        clients: server.clients,
        async close() {
            for (const client of server.clients) {
                client.terminate();
            }
            await new Promise((resolve) => server.close(resolve));
        }
    };
}

function createConnectionNode(runtime, port, overrides = {}) {
    return runtime.create('webiq-api-connect', {
        host: '127.0.0.1',
        port: String(port),
        project: 'test-project',
        loginTimeout: 1,
        ...overrides,
        credentials: {
            username: 'test-user',
            password: 'test-password',
            ...(overrides.credentials || {})
        }
    });
}

async function stopConnectionNode(node) {
    // Await the node's own (removed, done) completion signal instead of a
    // blind sleep - teardown is confirmed, and the suite loses ~1s of
    // unconditional waiting across its ~40 call sites.
    await new Promise((resolve) => {
        const safety = setTimeout(resolve, 2000);
        if (typeof safety.unref === 'function') { safety.unref(); }
        try {
            node.emit('close', false, () => { clearTimeout(safety); resolve(); });
        } catch (_) {
            clearTimeout(safety);
            resolve();
        }
    });
}

module.exports = {
    createConnectionNode,
    createRuntime,
    createWebIQServer,
    stopConnectionNode,
    waitFor
};

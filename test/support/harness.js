const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { WebSocketServer } = require('ws');

function createRuntime(registerNode) {
    const registeredTypes = new Map();

    const RED = {
        nodes: {
            createNode(node) {
                const emitter = new EventEmitter();

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
            const request = JSON.parse(raw.toString());
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
        username: 'test-user',
        password: 'test-password',
        loginTimeout: 1,
        ...overrides
    });
}

async function stopConnectionNode(node) {
    node.emit('close');
    await new Promise((resolve) => setTimeout(resolve, 25));
}

module.exports = {
    createConnectionNode,
    createRuntime,
    createWebIQServer,
    stopConnectionNode,
    waitFor
};

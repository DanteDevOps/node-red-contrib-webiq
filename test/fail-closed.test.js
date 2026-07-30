const assert = require('node:assert/strict');
const test = require('node:test');

const registerWebIQConnect = require('../webiq-api-connect');
const {
    createRuntime,
    createWebIQServer,
    stopConnectionNode,
    waitFor
} = require('./support/harness');

function loginResponder({ request, socket }) {
    if (request.cmd === 'user.login') {
        socket.send(JSON.stringify({
            cmd: 'user.login',
            id: request.id,
            data: { loggedIn: true }
        }));
    }
}

test('an unresolvable TLS config refuses to connect rather than falling back to plaintext', async (t) => {
    const server = await createWebIQServer(loginResponder);
    t.after(() => server.close());

    const runtime = createRuntime((RED) => {
        RED.nodes.getNode = () => null; // the referenced tls-config is gone
        registerWebIQConnect(RED);
    });

    const node = runtime.create('webiq-api-connect', {
        host: '127.0.0.1',
        port: String(server.port),
        project: 'p',
        loginTimeout: 5,
        heartbeat: 0,
        tls: 'missing-tls-config',
        credentials: { username: 'secret-user', password: 'secret-pass' }
    });
    t.after(() => stopConnectionNode(node));

    await new Promise((resolve) => setTimeout(resolve, 400));

    assert.equal(
        node.statuses.some((s) => s.text === 'authenticated'),
        false,
        'must not authenticate'
    );
    assert.equal(server.requests.length, 0, 'no credential may reach a plaintext server');
    assert.ok(node.statuses.some((s) => s.text === 'TLS config unresolved'));
    assert.ok(node.errors.some(({ error }) => /Refusing to connect/.test(String(error))));
});

test('a message to a fail-closed node is reported, not swallowed', async (t) => {
    const runtime = createRuntime((RED) => {
        RED.nodes.getNode = () => null;
        registerWebIQConnect(RED);
    });

    const node = runtime.create('webiq-api-connect', {
        host: '127.0.0.1', port: '1', project: 'p', tls: 'missing', heartbeat: 0
    });
    t.after(() => stopConnectionNode(node));

    const err = await new Promise((resolve) => {
        node.emit('input', { payload: { cmd: 'io.read', id: 1, data: [] } }, undefined, resolve);
    });

    assert.ok(err instanceof Error);
    assert.match(String(err), /not configured/);
});

test('a 1.x node whose credentials were never migrated fails with an actionable message', async (t) => {
    const server = await createWebIQServer(loginResponder);
    t.after(() => server.close());

    const runtime = createRuntime(registerWebIQConnect);
    // Flat properties as a 1.x flow stored them, and nothing in the credential store.
    const node = runtime.create('webiq-api-connect', {
        host: '127.0.0.1',
        port: String(server.port),
        project: 'p',
        username: 'legacy-user',
        password: 'legacy-pass',
        loginTimeout: 5,
        heartbeat: 0
    });
    t.after(() => stopConnectionNode(node));

    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.equal(server.requests.length, 0, 'must not log in with flow-file credentials');
    assert.ok(node.statuses.some((s) => s.text === 'credentials need re-entry'));
    assert.ok(node.errors.some(({ error }) => /re-entered after upgrading/.test(String(error))));
});

test('inbound ping frames count as liveness', async (t) => {
    const server = await createWebIQServer(loginResponder);
    t.after(() => server.close());

    const runtime = createRuntime(registerWebIQConnect);
    const node = createConnectionNodeNoPong(runtime, server.port);
    t.after(() => stopConnectionNode(node));

    await waitFor(
        () => node.statuses.some((s) => s.text === 'authenticated'),
        'authenticated'
    );

    // Peer stops answering our pings but pings us instead - clearly alive.
    for (const client of server.clients) {
        client.pong = () => {};
        const pinger = setInterval(() => {
            if (client.readyState === client.OPEN) { client.ping(); }
        }, 40);
        t.after(() => clearInterval(pinger));
    }

    await new Promise((resolve) => setTimeout(resolve, 800));

    assert.equal(
        node.statuses.some((s) => s.text === 'link stale - reconnecting'),
        false,
        'a peer that pings us must not be declared stale'
    );
});

function createConnectionNodeNoPong(runtime, port) {
    return runtime.create('webiq-api-connect', {
        host: '127.0.0.1',
        port: String(port),
        project: 'test-project',
        loginTimeout: 5,
        heartbeat: 0.15,
        credentials: { username: 'u', password: 'p' }
    });
}

test('a transient HTTP upgrade failure is not treated as a permanent misconfiguration', async (t) => {
    // A plain HTTP server that always answers 503 - never upgrades.
    const http = require('node:http');
    const httpServer = http.createServer((req, res) => {
        res.writeHead(503);
        res.end('busy');
    });
    httpServer.listen(0);
    await require('node:events').once(httpServer, 'listening');
    t.after(() => new Promise((resolve) => httpServer.close(resolve)));

    const runtime = createRuntime(registerWebIQConnect);
    const node = runtime.create('webiq-api-connect', {
        host: '127.0.0.1',
        port: String(httpServer.address().port),
        project: 'p',
        loginTimeout: 5,
        heartbeat: 0,
        credentials: { username: 'u', password: 'p' }
    });
    t.after(() => stopConnectionNode(node));

    await waitFor(
        () => node.statuses.some((s) => /server unavailable \(HTTP 503\)/.test(s.text)),
        'transient upgrade failure reported as unavailable'
    );

    assert.equal(
        node.errors.some(({ error }) => /check the project name/.test(String(error))),
        false,
        'a 503 must not be diagnosed as a wrong project name'
    );
});

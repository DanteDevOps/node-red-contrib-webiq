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

test('a node with no credentials at all never sends an empty login', async (t) => {
    const server = await createWebIQServer(loginResponder);
    t.after(() => server.close());

    const runtime = createRuntime(registerWebIQConnect);
    // The state a 1.x node reaches once a full deploy has stripped the legacy
    // username/password: nothing in the credential store, nothing in the flow.
    const node = runtime.create('webiq-api-connect', {
        host: '127.0.0.1',
        port: String(server.port),
        project: 'p',
        loginTimeout: 5,
        heartbeat: 0
    });
    t.after(() => stopConnectionNode(node));

    await new Promise((resolve) => setTimeout(resolve, 400));

    assert.equal(server.requests.length, 0, 'must not send a login with no credentials');
    assert.equal(node.statuses.some((s) => s.text === 'authenticated'), false);
    assert.ok(node.statuses.some((s) => s.text === 'credentials missing'));
});

test('a TLS reference resolving to the wrong node type refuses to connect', async (t) => {
    const server = await createWebIQServer(loginResponder);
    t.after(() => server.close());

    const runtime = createRuntime((RED) => {
        // Resolves, but is not a tls-config node - its certificate settings could
        // not be applied, so connecting would silently discard them.
        RED.nodes.getNode = () => ({ id: 'something-else' });
        registerWebIQConnect(RED);
    });

    const node = runtime.create('webiq-api-connect', {
        host: '127.0.0.1',
        port: String(server.port),
        project: 'p',
        loginTimeout: 5,
        heartbeat: 0,
        tls: 'wrong-type',
        credentials: { username: 'u', password: 'p' }
    });
    t.after(() => stopConnectionNode(node));

    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.equal(server.requests.length, 0);
    assert.ok(node.statuses.some((s) => s.text === 'TLS config invalid'));
});

test('a tls-config that failed to load its certificates is refused', async (t) => {
    const server = await createWebIQServer(loginResponder);
    t.after(() => server.close());

    const runtime = createRuntime((RED) => {
        // A real tls-config keeps addTLSOptions when valid === false, but that
        // method then omits every cert/key/CA/PFX it was configured with.
        RED.nodes.getNode = () => ({
            valid: false,
            addTLSOptions(opts) { opts.rejectUnauthorized = true; return opts; }
        });
        registerWebIQConnect(RED);
    });

    const node = runtime.create('webiq-api-connect', {
        host: '127.0.0.1',
        port: String(server.port),
        project: 'p',
        loginTimeout: 5,
        heartbeat: 0,
        tls: 'broken-tls-config',
        credentials: { username: 'u', password: 'p' }
    });
    t.after(() => stopConnectionNode(node));

    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.equal(server.requests.length, 0);
    assert.ok(node.statuses.some((s) => s.text === 'TLS config invalid'));
    assert.ok(node.errors.some(({ error }) => /certificate material/.test(String(error))));
});

test('the full HTTP upgrade classification contract', async (t) => {
    const http = require('node:http');
    const results = {};

    // Every code in the documented permanent set, plus representatives of the
    // transient side. Omitting any of these lets the contract drift.
    for (const code of [400, 401, 403, 404, 410, 429, 500, 501, 502, 503]) {
        const httpServer = http.createServer((req, res) => { res.writeHead(code); res.end(); });
        httpServer.listen(0);
        await require('node:events').once(httpServer, 'listening');

        const runtime = createRuntime(registerWebIQConnect);
        const node = runtime.create('webiq-api-connect', {
            host: '127.0.0.1',
            port: String(httpServer.address().port),
            project: 'p',
            loginTimeout: 5,
            heartbeat: 0,
            credentials: { username: 'u', password: 'p' }
        });

        await waitFor(
            () => node.statuses.find((s) => /rejected upgrade|server unavailable/.test(s.text)),
            `status for HTTP ${code}`
        );
        results[code] = node.statuses.some((s) => /rejected upgrade/.test(s.text))
            ? 'permanent'
            : 'transient';

        node.emit('close');
        await new Promise((resolve) => httpServer.close(resolve));
    }

    assert.deepEqual(results, {
        400: 'permanent',
        401: 'permanent',
        403: 'permanent',
        404: 'permanent',
        410: 'permanent',
        429: 'transient',
        500: 'transient',
        501: 'transient',
        502: 'transient',
        503: 'transient'
    });
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

    await new Promise((resolve) => setTimeout(resolve, 3000));

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
        heartbeat: 1,
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

test('backpressure rejects, then recovers once the peer reads again', async (t) => {
    const server = await createWebIQServer(loginResponder);
    t.after(() => server.close());

    const runtime = createRuntime(registerWebIQConnect);
    const node = runtime.create('webiq-api-connect', {
        host: '127.0.0.1',
        port: String(server.port),
        project: 'test-project',
        loginTimeout: 5,
        heartbeat: 0,
        credentials: { username: 'u', password: 'p' }
    });
    t.after(() => stopConnectionNode(node));

    await waitFor(() => node.statuses.some((s) => s.text === 'authenticated'), 'authenticated');

    // Stop the peer reading, then push enough data to exceed the 1 MiB guard.
    for (const client of server.clients) { client.pause(); }

    // Fire without awaiting each callback: against a stalled peer ws may never
    // invoke the send callback at all, so awaiting them would hang rather than
    // fail. The rejection we care about is reported through done() immediately.
    const errors = [];
    const blob = 'x'.repeat(600 * 1024);
    for (let i = 0; i < 8; i += 1) {
        node.emit(
            'input',
            { payload: { cmd: 'io.write', id: i, data: { blob } } },
            undefined,
            (err) => { if (err) { errors.push(err); } }
        );
    }

    await waitFor(
        () => node.statuses.some((s) => s.text === 'send buffer full'),
        'backpressure warning',
        4000
    );
    assert.ok(
        errors.some((e) => /buffer is backed up/.test(String(e))),
        'the refused send must report through done()'
    );

    // Let the peer drain, then a normal send must clear the warning.
    for (const client of server.clients) { client.resume(); }
    await new Promise((resolve) => setTimeout(resolve, 500));

    node.emit('input', { payload: { cmd: 'io.read', id: 99, data: ['A'] } }, undefined, () => {});

    await waitFor(
        () => node.statuses[node.statuses.length - 1].text === 'authenticated',
        'backpressure warning to clear after a successful send',
        4000
    );
});

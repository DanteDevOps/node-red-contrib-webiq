// Regressions for the sixth-review findings. Every one of these was reproduced
// against the code before the fix; three were holes in earlier fix rounds.
const assert = require('node:assert/strict');
const test = require('node:test');

const registerWebIQConnect = require('../webiq-api-connect');
const {
    createConnectionNode,
    createRuntime,
    createWebIQServer,
    stopConnectionNode,
    waitFor
} = require('./support/harness');

function loginOk({ request, socket }) {
    if (request.cmd === 'user.login') {
        socket.send(JSON.stringify({ cmd: 'user.login', id: request.id, data: { loggedIn: true } }));
    }
}

test('userinfo in the host cannot redirect the credentials to another server', async (t) => {
    // "trusted.example@127.0.0.1" parses with 127.0.0.1 as the REAL host: the node
    // used to connect there and hand over the protected username and password.
    const server = await createWebIQServer(loginOk);
    t.after(() => server.close());

    const runtime = createRuntime(registerWebIQConnect);
    const node = runtime.create('webiq-api-connect', {
        host: 'trusted.example@127.0.0.1',
        port: String(server.port),
        project: 'p',
        loginTimeout: 5,
        heartbeat: 0,
        credentials: { username: 'secret-user', password: 'secret-pass' }
    });
    t.after(() => stopConnectionNode(node));

    await new Promise((resolve) => setTimeout(resolve, 600));

    assert.equal(server.requests.length, 0, 'no credential may reach the embedded host');
    assert.equal(node.statuses.some((s) => s.text === 'authenticated'), false);
    assert.ok(node.statuses.some((s) => s.text === 'invalid host'));
});

test('URL syntax and embedded ports in the host are rejected', async (t) => {
    const cases = [
        'http://127.0.0.1',
        '127.0.0.1/some/path',
        '127.0.0.1:10123',
        'host with spaces',
        '127.0.0.1?x=1',
        '127.0.0.1#frag',
        'evil\\share'
    ];

    for (const host of cases) {
        const runtime = createRuntime(registerWebIQConnect);
        const node = runtime.create('webiq-api-connect', {
            host,
            port: '10123',
            project: 'p',
            heartbeat: 0,
            credentials: { username: 'u', password: 'p' }
        });
        assert.ok(
            node.statuses.some((s) => s.text === 'invalid host'),
            `host ${JSON.stringify(host)} must be rejected`
        );
        node.emit('close');
    }
});

test('legitimate hosts still work, including IPv6 and Docker names', async (t) => {
    // Guard against over-tightening: these were all deliberately supported.
    const cases = ['127.0.0.1', 'localhost', 'webiq_server', 'e8b193a88e3e', 'my-host.example.com', '[::1]', '::1'];

    for (const host of cases) {
        const runtime = createRuntime(registerWebIQConnect);
        const node = runtime.create('webiq-api-connect', {
            host,
            port: '10123',
            project: 'p',
            heartbeat: 0,
            credentials: { username: 'u', password: 'p' }
        });
        assert.equal(
            node.statuses.some((s) => s.text === 'invalid host'),
            false,
            `host ${JSON.stringify(host)} must be accepted`
        );
        node.emit('close');
    }
});

test('a peer that reads the login and hangs up cannot be retried without limit', async (t) => {
    // The close arrives before any reply, so it used to be classified as an
    // ordinary transport drop: fast ladder, no budget consumed, unlimited logins -
    // exactly the account-lockout hammer the budget exists to prevent.
    const stamps = [];
    const server = await createWebIQServer(({ request, socket }) => {
        if (request.cmd === 'user.login') {
            stamps.push(Date.now());
            setTimeout(() => { try { socket.terminate(); } catch (_) {} }, 5);
        }
    });
    t.after(() => server.close());

    const runtime = createRuntime(registerWebIQConnect);
    const node = createConnectionNode(runtime, server.port, {
        loginTimeout: 5,
        heartbeat: 0,
        loginAttempts: 1
    });
    t.after(() => stopConnectionNode(node));

    // The close must be charged to the login budget, not written off as an
    // ordinary transport drop.
    await waitFor(
        () => node.warnings.some((w) => /closed the connection without answering the login/i.test(String(w))),
        'the silent close is charged to the budget'
    );
    await waitFor(
        () => node.statuses.some((s) => /unanswered/.test(s.text)),
        'budget exhausted by silent closes reaches the resting state'
    );

    // Resting means the cadence collapses. Before the fix this window contained
    // an unbounded fast-ladder login loop.
    const atRest = stamps.length;
    await new Promise((resolve) => setTimeout(resolve, 4000));
    assert.equal(stamps.length, atRest, 'a resting node must not keep logging in');
    assert.equal(atRest, 1, `the budget must bound the burst, saw ${atRest} logins`);
});

test('a reconnect triggered synchronously from a status update leaves no stale timer', async (t) => {
    // A Status -> Change -> reconnect flow can re-enter the node from inside the
    // close handler's own node.status() call. The old handler then continued and
    // armed a timer that later replaced the healthy recovered connection.
    const seen = new Set();
    const server = await createWebIQServer(loginOk);
    const tracker = setInterval(() => {
        for (const c of server.clients) { seen.add(c); }
    }, 5);
    t.after(() => clearInterval(tracker));
    t.after(() => server.close());

    const runtime = createRuntime(registerWebIQConnect);
    const node = createConnectionNode(runtime, server.port, { loginTimeout: 5, heartbeat: 0 });
    t.after(() => stopConnectionNode(node));

    await waitFor(() => node.statuses.some((s) => s.text === 'authenticated'), 'first auth');

    let nudged = false;
    const push = node.statuses.push.bind(node.statuses);
    node.statuses.push = (s) => {
        const r = push(s);
        if (!nudged && s.text === 'disconnected') {
            nudged = true;
            node.emit('input', { webiq: 'reconnect' }, undefined, () => {});
        }
        return r;
    };

    for (const c of server.clients) { c.terminate(); }
    await new Promise((resolve) => setTimeout(resolve, 4000));

    assert.equal(seen.size, 2, `expected exactly one replacement connection, saw ${seen.size}`);
    assert.equal(
        [...server.clients].filter((c) => c.readyState === c.OPEN).length,
        1,
        'exactly one live connection'
    );
});

test('a hostile toString on server error data cannot crash the runtime', async (t) => {
    // JSON can express {"toString": null}; String() on it throws
    // "Cannot convert object to primitive value". Thrown inside a ws event
    // handler that reaches Node-RED's uncaught handler and kills the process.
    const server = await createWebIQServer(({ request, socket }) => {
        if (request.cmd === 'user.login') {
            socket.send(JSON.stringify({
                cmd: 'user.login',
                id: request.id,
                data: null,
                error: { category: { toString: null }, errc: 1, message: { toString: null } }
            }));
        }
    });
    t.after(() => server.close());

    const runtime = createRuntime(registerWebIQConnect);
    const node = createConnectionNode(runtime, server.port, { loginTimeout: 5, heartbeat: 0 });
    t.after(() => stopConnectionNode(node));

    await waitFor(
        () => node.warnings.some((w) => /login rejected/i.test(String(w))) ||
              node.errors.some(({ error }) => /login/i.test(String(error))),
        'the frame is handled rather than throwing'
    );

    // Surviving this far is the assertion: an unhandled throw would have taken
    // the whole test process down.
    assert.ok(true);
});

test('a hostile toString on a request error frame is also survivable', async (t) => {
    const server = await createWebIQServer(({ request, socket }) => {
        if (request.cmd === 'user.login') {
            socket.send(JSON.stringify({ cmd: 'user.login', id: request.id, data: { loggedIn: true } }));
            return;
        }
        socket.send(JSON.stringify({
            cmd: { toString: null },
            id: request.id,
            error: { message: { toString: null } }
        }));
    });
    t.after(() => server.close());

    const runtime = createRuntime(registerWebIQConnect);
    const node = createConnectionNode(runtime, server.port, { loginTimeout: 5, heartbeat: 0 });
    t.after(() => stopConnectionNode(node));

    await waitFor(() => node.statuses.some((s) => s.text === 'authenticated'), 'authenticated');
    node.emit('input', { payload: { cmd: 'io.read', id: 7, data: ['A'] } }, undefined, () => {});

    await waitFor(
        () => node.sent.some((m) => m.payload && m.payload.error),
        'the error frame is forwarded without throwing'
    );
    assert.ok(true);
});

test('a fractional heartbeat cannot become a ping storm', async (t) => {
    let pings = 0;
    const server = await createWebIQServer(loginOk);
    t.after(() => server.close());

    const runtime = createRuntime(registerWebIQConnect);
    const node = createConnectionNode(runtime, server.port, {
        loginTimeout: 5,
        heartbeat: 0.001
    });
    t.after(() => stopConnectionNode(node));

    await waitFor(() => node.statuses.some((s) => s.text === 'authenticated'), 'authenticated');
    for (const client of server.clients) {
        client.on('ping', () => { pings += 1; });
    }

    await new Promise((resolve) => setTimeout(resolve, 600));

    assert.ok(pings <= 2, `a 0.001s heartbeat must be clamped, not honoured (saw ${pings} pings)`);
    assert.ok(
        node.warnings.some((w) => /heartbeat/i.test(String(w))),
        'the clamp must be reported'
    );
});

// Regressions for the findings that came out of the first real-server campaign.
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

// The shape a real WebIQ server sends: category / errc / message, no numeric code.
const LOCKOUT = { category: 'shmi:connect:api:user', errc: 8, message: 'too many login attempts' };
const REJECTED = { category: 'shmi:connect:api:user', errc: 3, message: 'invalid credentials' };

function loginResponder(error) {
    return ({ request, socket }) => {
        if (request.cmd === 'user.login') {
            socket.send(JSON.stringify({ cmd: 'user.login', id: request.id, data: null, error }));
        }
    };
}

test('a lockout reply stops the node dead instead of retrying into it', async (t) => {
    const server = await createWebIQServer(loginResponder(LOCKOUT));
    t.after(() => server.close());

    const runtime = createRuntime(registerWebIQConnect);
    const node = createConnectionNode(runtime, server.port, { loginTimeout: 5, heartbeat: 0 });
    t.after(() => stopConnectionNode(node));

    await waitFor(
        () => node.statuses.some((s) => s.text === 'login blocked - fix and redeploy'),
        'auth latch'
    );

    const attemptsAtLatch = server.requests.length;
    assert.equal(attemptsAtLatch, 1, 'the lockout reply must not be answered with another login');

    // And it must stay stopped.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.equal(server.requests.length, attemptsAtLatch, 'no further logins after latching');

    assert.ok(
        node.errors.some(({ error }) => /too many login attempts/.test(String(error))),
        "the server's own wording must be surfaced, not replaced with 'check your password'"
    );
});

test('repeated rejections latch even when the server hangs up each time', async (t) => {
    // This is the case a per-socket counter could never catch: the server closes
    // after rejecting, so a context-scoped tally resets on every reconnect and the
    // node retries for ever.
    const server = await createWebIQServer(({ request, socket }) => {
        if (request.cmd === 'user.login') {
            socket.send(JSON.stringify({ cmd: 'user.login', id: request.id, data: null, error: REJECTED }));
            setTimeout(() => { try { socket.close(); } catch (_) {} }, 10);
        }
    });
    t.after(() => server.close());

    const runtime = createRuntime(registerWebIQConnect);
    const node = createConnectionNode(runtime, server.port, { loginTimeout: 5, heartbeat: 0 });
    t.after(() => stopConnectionNode(node));

    await waitFor(
        () => node.statuses.some((s) => s.text === 'login blocked - fix and redeploy'),
        'auth latch after repeated rejections',
        30000
    );

    const attempts = server.requests.filter((r) => r.cmd === 'user.login').length;
    assert.ok(attempts <= 5, `expected the budget to cap attempts, saw ${attempts}`);

    const before = server.requests.length;
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.equal(server.requests.length, before, 'latched node must stop reconnecting');
});

test('msg.webiq = "reconnect" clears the latch without a redeploy', async (t) => {
    let error = LOCKOUT;
    const server = await createWebIQServer(({ request, socket }) => {
        if (request.cmd === 'user.login') {
            socket.send(JSON.stringify({
                cmd: 'user.login', id: request.id,
                data: error ? null : { loggedIn: true },
                error: error || undefined
            }));
        }
    });
    t.after(() => server.close());

    const runtime = createRuntime(registerWebIQConnect);
    const node = createConnectionNode(runtime, server.port, { loginTimeout: 5, heartbeat: 0 });
    t.after(() => stopConnectionNode(node));

    await waitFor(() => node.statuses.some((s) => s.text === 'login blocked - fix and redeploy'), 'latch');

    // Messages are refused while latched, and say why.
    const refused = await new Promise((resolve) => {
        node.emit('input', { payload: { cmd: 'io.read', id: 1, data: [] } }, undefined, resolve);
    });
    assert.match(String(refused), /login is blocked/);

    // Operator fixes the cause, then a control message retries.
    error = null;
    node.emit('input', { webiq: 'reconnect' }, undefined, () => {});

    await waitFor(() => node.statuses.some((s) => s.text === 'authenticated'), 'recovery after unlatch');
});

test('a server error on a request is catchable, not silently forwarded as success', async (t) => {
    const server = await createWebIQServer(({ request, socket }) => {
        if (request.cmd === 'user.login') {
            socket.send(JSON.stringify({ cmd: 'user.login', id: request.id, data: { loggedIn: true } }));
            return;
        }
        // A write WebIQ refuses - the case that used to look exactly like success.
        socket.send(JSON.stringify({
            cmd: request.cmd,
            id: request.id,
            error: { category: 'shmi:connect:api:io', errc: 12, message: 'item is read-only' }
        }));
    });
    t.after(() => server.close());

    const runtime = createRuntime(registerWebIQConnect);
    const node = createConnectionNode(runtime, server.port, { loginTimeout: 5, heartbeat: 0 });
    t.after(() => stopConnectionNode(node));

    await waitFor(() => node.statuses.some((s) => s.text === 'authenticated'), 'authenticated');

    node.emit('input', { payload: { cmd: 'io.write', id: 42, data: { Tag: 1 } } }, undefined, () => {});

    const raised = await waitFor(
        () => node.errors.find(({ error }) => /read-only/.test(String(error))),
        'server error raised for Catch'
    );

    assert.ok(raised.msg, 'node.error must carry the msg so a Catch node can route it');
    assert.ok(
        node.sent.some((m) => m.payload && m.payload.error && m.payload.error.errc === 12),
        'the frame must still be forwarded - nothing is hidden'
    );
});

test('an unreachable server is named as such, not blamed on the project', async (t) => {
    const runtime = createRuntime(registerWebIQConnect);
    // Nothing is listening on this port.
    const node = createConnectionNode(runtime, 1, { loginTimeout: 5, heartbeat: 0 });
    t.after(() => stopConnectionNode(node));

    await waitFor(
        () => node.statuses.find((s) => /refused|unreachable|not found|connection failed/.test(s.text)),
        'transport failure status'
    );

    assert.equal(
        node.statuses.some((s) => s.text === 'project not found / connection failed'),
        false,
        'a transport fault must no longer blame the project'
    );
    assert.equal(
        node.errors.some(({ error }) => /project may be invalid/.test(String(error))),
        false
    );
});

test('the login-timeout badge survives the close that follows it', async (t) => {
    const server = await createWebIQServer(() => {}); // never answers the login
    t.after(() => server.close());

    const runtime = createRuntime(registerWebIQConnect);
    const node = createConnectionNode(runtime, server.port, { loginTimeout: 0.1, heartbeat: 0 });
    t.after(() => stopConnectionNode(node));

    await waitFor(
        () => node.errors.find(({ error }) => /No login reply received/.test(String(error))),
        'login timeout'
    );
    // The close that the timeout triggers used to repaint this to 'disconnected'
    // within milliseconds, so the documented state was never observable.
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.equal(
        node.statuses[node.statuses.length - 1].text,
        'login timeout',
        'the specific badge must not be overwritten by the generic one'
    );
});

test('disabling the heartbeat warns, because it restores the 1.x failure mode', async (t) => {
    const server = await createWebIQServer(({ request, socket }) => {
        if (request.cmd === 'user.login') {
            socket.send(JSON.stringify({ cmd: 'user.login', id: request.id, data: { loggedIn: true } }));
        }
    });
    t.after(() => server.close());

    const runtime = createRuntime(registerWebIQConnect);
    const node = createConnectionNode(runtime, server.port, { loginTimeout: 5, heartbeat: 0 });
    t.after(() => stopConnectionNode(node));

    assert.ok(
        node.warnings.some((w) => /heartbeat is disabled/i.test(String(w))),
        'a disabled heartbeat must be visible without opening the node'
    );
});

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

test('repeated rejections latch and PACE even when the server hangs up each time', async (t) => {
    // The case a per-socket counter can never catch: the server closes after each
    // rejection, so a context-scoped tally would reset on every reconnect. The
    // pacing assertion matters as much as the cap - without the node-scoped ladder,
    // all attempts fire seconds apart, the burst most likely to trip the server's
    // own attempt limiter.
    const stamps = [];
    const server = await createWebIQServer(({ request, socket }) => {
        if (request.cmd === 'user.login') {
            stamps.push(Date.now());
            socket.send(JSON.stringify({ cmd: 'user.login', id: request.id, data: null, error: REJECTED }));
            setTimeout(() => { try { socket.close(); } catch (_) {} }, 10);
        }
    });
    t.after(() => server.close());

    const runtime = createRuntime(registerWebIQConnect);
    const node = createConnectionNode(runtime, server.port, {
        loginTimeout: 5,
        heartbeat: 0,
        loginAttempts: 2
    });
    t.after(() => stopConnectionNode(node));

    await waitFor(
        () => node.statuses.some((s) => s.text === 'login blocked - fix and redeploy'),
        'auth latch after repeated rejections',
        15000
    );

    assert.equal(stamps.length, 2, 'the configured budget must cap the attempts');
    // The auth ladder starts at 5s; jitter is downward-only (60-100%), so the
    // floor is 3s. The transport ladder would be ~1s - that is the thing this
    // assertion exists to rule out.
    assert.ok(
        stamps[1] - stamps[0] >= 2500,
        `retry must climb the auth ladder, not the fast transport ladder (gap was ${stamps[1] - stamps[0]}ms)`
    );

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
        node.errors.some(({ error }) => /project may be invalid|most likely cause/.test(String(error))),
        false,
        'a transport fault must not blame the project in old OR current wording'
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

test('a reconnect command during reconnect-wait must not leak a second socket', async (t) => {
    // B1 from the second audit: connect() used to leave a pending reconnectTimer
    // armed, which later fired a second connect() and orphaned the first socket -
    // open, authenticated, and unreachable by every owns()-guarded handler.
    const seen = new Set();
    const server = await createWebIQServer(loginResponder(null));
    const tracker = setInterval(() => {
        for (const c of server.clients) { seen.add(c); }
    }, 10);
    t.after(() => clearInterval(tracker));
    t.after(() => server.close());

    const runtime = createRuntime(registerWebIQConnect);
    const node = createConnectionNode(runtime, server.port, { loginTimeout: 5, heartbeat: 0 });
    t.after(() => stopConnectionNode(node));

    await waitFor(() => node.statuses.some((s) => s.text === 'authenticated'), 'first auth');

    // Server drops the connection; the node schedules a reconnect (~1s).
    for (const c of server.clients) { c.terminate(); }
    await waitFor(() => [...server.clients].length === 0, 'server-side drop');

    // Nudge it immediately - this used to race the still-armed timer.
    node.emit('input', { webiq: 'reconnect' }, undefined, () => {});

    await waitFor(
        () => node.statuses.filter((s) => s.text === 'authenticated').length >= 2,
        'reauthenticated after nudge'
    );

    // Wait well past the forgotten timer's horizon, then count.
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const open = [...server.clients].filter((c) => c.readyState === c.OPEN).length;
    assert.equal(open, 1, 'exactly one live connection - no orphaned socket');
    assert.ok(seen.size <= 2, `no third connect from a forgotten timer (saw ${seen.size})`);
});

test('unanswered logins never latch: after the budget the node rests and recovers', async (t) => {
    // Q1 resolution: silence means the server is down or booting - it is not
    // counting login attempts, so stranding an unattended gateway terminally over
    // it would be an availability regression. It must rest, then self-recover.
    let answer = false;
    const server = await createWebIQServer(({ request, socket }) => {
        if (request.cmd === 'user.login' && answer) {
            socket.send(JSON.stringify({ cmd: 'user.login', id: request.id, data: { loggedIn: true } }));
        }
        // otherwise: accept the connection, never answer the login
    });
    t.after(() => server.close());

    const runtime = createRuntime(registerWebIQConnect);
    const node = createConnectionNode(runtime, server.port, {
        loginTimeout: 0.05,
        heartbeat: 0,
        loginAttempts: 1
    });
    t.after(() => stopConnectionNode(node));

    await waitFor(
        () => node.statuses.some((s) => s.text === 'login unanswered - retrying every 60s'),
        'resting badge'
    );

    // Resting is NOT the latch: messages fail as disconnected, not as blocked.
    const err = await new Promise((resolve) => {
        node.emit('input', { payload: { cmd: 'io.read', id: 2, data: [] } }, undefined, resolve);
    });
    assert.ok(err instanceof Error);
    assert.doesNotMatch(String(err), /login is blocked/, 'resting must not report the terminal latch');

    // Server recovers; a nudge (or the 5-minute probe) brings the node back.
    answer = true;
    node.emit('input', { webiq: 'reconnect' }, undefined, () => {});
    await waitFor(() => node.statuses.some((s) => s.text === 'authenticated'), 'self-recovery');
});

test('the reconnect escape hatch is rate-limited and grants exactly one attempt', async (t) => {
    // Q2 resolution: without this, a Catch -> reconnect loop defeats the latch.
    const server = await createWebIQServer(({ request, socket }) => {
        if (request.cmd === 'user.login') {
            socket.send(JSON.stringify({ cmd: 'user.login', id: request.id, data: null, error: REJECTED }));
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

    await waitFor(() => node.statuses.some((s) => s.text === 'login blocked - fix and redeploy'), 'latched');
    assert.equal(server.requests.length, 1);

    // First reconnect: allowed, grants ONE attempt, which fails and re-latches.
    node.emit('input', { webiq: 'reconnect' }, undefined, () => {});
    await waitFor(() => server.requests.length === 2, 'exactly one granted attempt');
    await waitFor(
        () => node.statuses.filter((s) => s.text === 'login blocked - fix and redeploy').length >= 2,
        're-latched after the single granted attempt'
    );

    // Second reconnect immediately after: refused by the cooldown.
    const refusal = await new Promise((resolve) => {
        node.emit('input', { webiq: 'reconnect' }, undefined, resolve);
    });
    assert.ok(refusal instanceof Error);
    assert.match(String(refusal), /reconnect refused/i);

    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.equal(server.requests.length, 2, 'the refused reconnect must not reach the server');
});

test('a payload on the reconnect control message is reported as NOT sent', async (t) => {
    const server = await createWebIQServer(loginResponder(null));
    t.after(() => server.close());

    const runtime = createRuntime(registerWebIQConnect);
    const node = createConnectionNode(runtime, server.port, { loginTimeout: 5, heartbeat: 0 });
    t.after(() => stopConnectionNode(node));

    await waitFor(() => node.statuses.some((s) => s.text === 'authenticated'), 'authenticated');
    const requestsBefore = server.requests.length;

    const err = await new Promise((resolve) => {
        node.emit('input', {
            webiq: 'reconnect',
            payload: { cmd: 'io.write', id: 9, data: { Tag: 1 } }
        }, undefined, resolve);
    });

    assert.ok(err instanceof Error, 'the flow must learn the write did not happen');
    assert.match(String(err), /NOT sent/);
    assert.equal(server.requests.length, requestsBefore, 'the payload must not reach the server');
});

test('secure:true against a plaintext server sends nothing, never authenticates', async (t) => {
    const server = await createWebIQServer(loginResponder(null));
    t.after(() => server.close());

    const runtime = createRuntime(registerWebIQConnect);
    const node = createConnectionNode(runtime, server.port, {
        loginTimeout: 5,
        heartbeat: 0,
        secure: true
    });
    t.after(() => stopConnectionNode(node));

    await new Promise((resolve) => setTimeout(resolve, 700));

    assert.equal(server.requests.length, 0, 'no frame may cross when TLS was requested');
    assert.equal(node.statuses.some((s) => s.text === 'authenticated'), false);
});

// The exact frame captured on the remote rig (Node-RED on a PC, WebIQ on an
// X3web) after a cable pull: the server still held the node's own previous
// half-open session, so the fresh login bounced off the client limit.
const SERVER_FULL = { category: 'shmi:connect:license', errc: 4, message: 'too many clients' };

test('a server-full rejection never latches and self-heals when the seat frees', async (t) => {
    // loginAttempts: 1 makes this maximally strict - if capacity rejections spent
    // the credential budget or latched, the very first one would stop the node.
    let seatFree = false;
    const server = await createWebIQServer(({ request, socket }) => {
        if (request.cmd === 'user.login') {
            socket.send(JSON.stringify(seatFree
                ? { cmd: 'user.login', id: request.id, data: { loggedIn: true } }
                : { cmd: 'user.login', id: request.id, data: null, error: SERVER_FULL }));
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

    await waitFor(
        () => node.statuses.some((s) => /server full - retrying/.test(s.text)),
        'server-full badge instead of the credential ladder'
    );
    assert.ok(
        node.warnings.some((w) => /does not count against the login budget/.test(String(w))),
        'the log must say the budget is untouched'
    );

    // A second rejection proves no latch even at a budget of one.
    await waitFor(() => server.requests.length >= 2, 'second gentle retry', 10000);
    assert.equal(
        node.statuses.some((s) => s.text === 'login blocked - fix and redeploy'),
        false,
        'a capacity rejection must never latch'
    );

    // The seat frees - as it does in the field when the server reaps the dead
    // session - and the node must log in by itself, with no human involved.
    seatFree = true;
    await waitFor(
        () => node.statuses.some((s) => s.text === 'authenticated'),
        'self-heal once the seat frees',
        20000
    );
    assert.equal(
        node.statuses.some((s) => s.text === 'login blocked - fix and redeploy'),
        false
    );
});

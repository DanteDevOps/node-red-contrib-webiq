// Regressions for the pre-publish whole-codebase review. The three worst
// findings were reproduced live before being fixed; each test here pins one.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
const { WebSocketServer } = require('ws');
const { once } = require('node:events');

const registerWebIQConnect = require('../webiq-api-connect');
const registerApiRequest = require('../api-request');
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

test('a reconnect during CONNECTING must not crash the runtime', () => {
    // ws emits 'error' on the NEXT TICK when a CONNECTING socket is terminated;
    // the supersede path used to detach every listener first, so the emission was
    // unhandled and killed the whole process. Run in a subprocess so a regression
    // fails this test instead of the entire suite.
    const fixture = path.join(__dirname, 'fixtures', 'reconnect-connecting.js');
    const result = spawnSync(process.execPath, [fixture], { timeout: 15000 });
    assert.equal(
        result.status,
        0,
        `fixture must exit cleanly, got ${result.status}: ${String(result.stderr).slice(0, 300)}`
    );
});

test('a capacity rejection worded with "blocked" must not latch', async (t) => {
    // The lockout pattern matches bare 'locked'/'blocked'; checked before the
    // capacity class, it latched terminally on the one condition guaranteed to
    // fix itself.
    const server = await createWebIQServer(({ request, socket }) => {
        if (request.cmd === 'user.login') {
            socket.send(JSON.stringify({
                cmd: 'user.login', id: request.id, data: null,
                error: { category: 'shmi:connect:license', errc: 4, message: 'all client seats blocked' }
            }));
        }
    });
    t.after(() => server.close());

    const runtime = createRuntime(registerWebIQConnect);
    const node = createConnectionNode(runtime, server.port, {
        loginTimeout: 5, heartbeat: 0, loginAttempts: 1
    });
    t.after(() => stopConnectionNode(node));

    await waitFor(() => node.statuses.some((s) => /server full/.test(s.text)), 'capacity classification');
    assert.equal(
        node.statuses.some((s) => s.text === 'login blocked - fix and redeploy'),
        false,
        'seat exhaustion must never latch, whatever its wording'
    );
});

test('a permanent licence error must latch, not loop as "server full"', async (t) => {
    // The licence CATEGORY alone is not capacity: an expired licence never fixes
    // itself, and looping forever under a 'server full' badge would misdescribe it.
    const server = await createWebIQServer(({ request, socket }) => {
        if (request.cmd === 'user.login') {
            socket.send(JSON.stringify({
                cmd: 'user.login', id: request.id, data: null,
                error: { category: 'shmi:connect:license', errc: 1, message: 'license expired' }
            }));
        }
    });
    t.after(() => server.close());

    const runtime = createRuntime(registerWebIQConnect);
    const node = createConnectionNode(runtime, server.port, {
        loginTimeout: 5, heartbeat: 0, loginAttempts: 1
    });
    t.after(() => stopConnectionNode(node));

    await waitFor(
        () => node.statuses.some((s) => s.text === 'login blocked - fix and redeploy'),
        'permanent licence problems surface terminally'
    );
    assert.equal(node.statuses.some((s) => /server full/.test(s.text)), false);
    assert.ok(node.errors.some(({ error }) => /license expired/.test(String(error))));
});

test('a payload whose toJSON returns undefined fails via done, not a throw', async (t) => {
    const server = await createWebIQServer(loginOk);
    t.after(() => server.close());

    const runtime = createRuntime(registerWebIQConnect);
    const node = createConnectionNode(runtime, server.port, { loginTimeout: 5, heartbeat: 0 });
    t.after(() => stopConnectionNode(node));

    await waitFor(() => node.statuses.some((s) => s.text === 'authenticated'), 'authenticated');

    let done;
    assert.doesNotThrow(() => {
        node.emit('input', {
            payload: { cmd: 'io.read', id: 3, data: [], toJSON: () => undefined }
        }, undefined, (err) => { done = err; });
    });
    assert.ok(done instanceof Error, 'the message must fail attributably');
    assert.match(String(done), /produced no output/);
});

test('an interval that saw traffic is never counted as missed', async (t) => {
    // The previous counting compared a bare counter at each tick, so traffic at
    // 29.9s was charged as a miss 0.1s later and a link could die after barely
    // ONE silent interval where the docs promise two.
    const httpsFreeServer = new WebSocketServer({ port: 0, autoPong: false });
    await once(httpsFreeServer, 'listening');
    let client = null;
    let lastTrafficAt = 0;
    httpsFreeServer.on('connection', (socket) => {
        client = socket;
        socket.on('message', (raw) => {
            let request;
            try { request = JSON.parse(raw.toString()); } catch (_) { return; }
            if (request.cmd === 'user.login') {
                socket.send(JSON.stringify({ cmd: 'user.login', id: request.id, data: { loggedIn: true } }));
            }
        });
    });
    t.after(() => new Promise((resolve) => {
        for (const c of httpsFreeServer.clients) { c.terminate(); }
        httpsFreeServer.close(resolve);
    }));

    const runtime = createRuntime(registerWebIQConnect);
    const node = runtime.create('webiq-api-connect', {
        host: '127.0.0.1',
        port: String(httpsFreeServer.address().port),
        project: 'p',
        loginTimeout: 5,
        heartbeat: 1,
        credentials: { username: 'u', password: 'p' }
    });
    t.after(() => stopConnectionNode(node));

    await waitFor(() => node.statuses.some((s) => s.text === 'authenticated'), 'authenticated');

    // One data frame mid-interval, then silence, with pongs disabled: the link
    // must survive at least ~two full intervals beyond that frame.
    await new Promise((resolve) => setTimeout(resolve, 500));
    client.send(JSON.stringify({ cmd: 'io.notify', id: 99, data: { tick: 1 } }));
    lastTrafficAt = Date.now();

    await waitFor(
        () => node.statuses.some((s) => s.text === 'link stale - reconnecting'),
        'stale detection with pongs disabled',
        8000
    );
    const silence = Date.now() - lastTrafficAt;
    assert.ok(
        silence >= 1900,
        `a link must survive two full silent intervals, died after ${silence}ms`
    );
});

test('a hang-up during a capacity retry still charges the login budget', async (t) => {
    // The close-handler charge used to require failureKind === null, so a login
    // sent by the in-socket retry after an earlier rejection vanished from every
    // budget when the server hung up on it.
    let logins = 0;
    const server = await createWebIQServer(({ request, socket }) => {
        if (request.cmd !== 'user.login') { return; }
        logins += 1;
        if (logins === 1) {
            socket.send(JSON.stringify({
                cmd: 'user.login', id: request.id, data: null,
                error: { category: 'shmi:connect:license', errc: 4, message: 'too many clients' }
            }));
        } else {
            // Second login: hang up without answering.
            try { socket.terminate(); } catch (_) {}
        }
    });
    t.after(() => server.close());

    const runtime = createRuntime(registerWebIQConnect);
    const node = createConnectionNode(runtime, server.port, { loginTimeout: 30, heartbeat: 0 });
    t.after(() => stopConnectionNode(node));

    await waitFor(
        () => node.warnings.some((w) => /closed the connection without answering the login/.test(String(w))),
        'the in-flight login is charged despite the earlier capacity failureKind',
        12000
    );
});

test('a non-JSON frame with escape bytes cannot forge log output', async (t) => {
    const server = await createWebIQServer(loginOk);
    t.after(() => server.close());

    const runtime = createRuntime(registerWebIQConnect);
    const node = createConnectionNode(runtime, server.port, { loginTimeout: 5, heartbeat: 0 });
    t.after(() => stopConnectionNode(node));

    await waitFor(() => node.statuses.some((s) => s.text === 'authenticated'), 'authenticated');

    for (const client of server.clients) {
        client.send('\u001b[31mnot json\u001b[0m');
    }

    await waitFor(
        () => node.warnings.some((w) => /Unusable WebIQ frame/.test(String(w))),
        'frame rejected with a warning'
    );
    assert.equal(
        node.warnings.some((w) => String(w).includes('\u001b')),
        false,
        'raw escape bytes must never reach the log'
    );
});

test('a truncated astral character cannot leave a lone surrogate in the log', async (t) => {
    const message = 'x'.repeat(199) + '\u{1F4A5}' + 'tail';
    const server = await createWebIQServer(({ request, socket }) => {
        if (request.cmd === 'user.login') {
            socket.send(JSON.stringify({
                cmd: 'user.login', id: request.id, data: null,
                error: { category: 'shmi:connect:api:user', errc: 3, message }
            }));
        }
    });
    t.after(() => server.close());

    const runtime = createRuntime(registerWebIQConnect);
    const node = createConnectionNode(runtime, server.port, { loginTimeout: 5, heartbeat: 0 });
    t.after(() => stopConnectionNode(node));

    await waitFor(() => node.warnings.some((w) => /login rejected/.test(String(w))), 'rejection surfaced');

    for (const w of node.warnings) {
        const text = String(w);
        const last = text.charCodeAt(text.length - 1);
        assert.ok(!(last >= 0xD800 && last <= 0xDBFF), 'no warning may end in a lone surrogate');
    }
});

test('an invalid heartbeat value warns instead of silently defaulting', () => {
    const runtime = createRuntime(registerWebIQConnect);
    const node = runtime.create('webiq-api-connect', {
        host: '', port: '1', project: 'p', heartbeat: 'abc',
        credentials: { username: 'u', password: 'p' }
    });
    assert.ok(
        node.warnings.some((w) => /not a non-negative number/.test(String(w))),
        'a provided-but-invalid heartbeat must be called out'
    );
    node.emit('close');
});

test('a sub-second login timeout warns that it may never authenticate', () => {
    const runtime = createRuntime(registerWebIQConnect);
    const node = runtime.create('webiq-api-connect', {
        host: '', port: '1', project: 'p', loginTimeout: 0.05, heartbeat: 0,
        credentials: { username: 'u', password: 'p' }
    });
    assert.ok(
        node.warnings.some((w) => /shorter than most servers can answer/.test(String(w))),
        'sub-second timeouts must be flagged'
    );
    node.emit('close');
});

test('a non-numeric legacy interval is reported as polling, never as disabled', async () => {
    const runtime = createRuntime(registerApiRequest);
    const node = runtime.create('api-request', {
        cmd: 'io.read',
        data: '["A"]',
        interval: '5,0'
    });

    const text = String(node.errors[0] && node.errors[0].error);
    assert.match(text, /WAS polling/, 'the old runtime fed NaN to setInterval (~1ms polling)');
    assert.doesNotMatch(text, /was 0 \(disabled\)/);
});

test('a numeric 1.0.x node id is quoted back as the legacy request id', async () => {
    const runtime = createRuntime(registerApiRequest);
    // 1.0.x took the request id from the node's own id property.
    const node = runtime.create('api-request', {
        id: '7',
        cmd: 'io.read',
        data: '["A"]',
        interval: 0
    });

    const text = String(node.errors[0] && node.errors[0].error);
    assert.match(text, /request id was 7/);
    assert.match(text, /"id":7/, 'the example must use the recovered id');
});

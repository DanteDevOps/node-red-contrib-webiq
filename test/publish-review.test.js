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

test('fields lost in serialisation fail via done instead of sending a reduced frame', async (t) => {
    // JSON.stringify silently drops a Symbol id or a function-valued data, and
    // a custom toJSON can replace the whole request; all three used to go out
    // on the wire as reduced frames while done() reported success. Validation
    // must apply to the transmitted form, not the approved object.
    const arrived = [];
    const server = await createWebIQServer(({ request, socket }) => {
        if (request.cmd === 'user.login') {
            socket.send(JSON.stringify({ cmd: 'user.login', id: request.id, data: { loggedIn: true } }));
            return;
        }
        arrived.push(request);
    });
    t.after(() => server.close());

    const runtime = createRuntime(registerWebIQConnect);
    const node = createConnectionNode(runtime, server.port, { loginTimeout: 5, heartbeat: 0 });
    t.after(() => stopConnectionNode(node));
    await waitFor(() => node.statuses.some((s) => s.text === 'authenticated'), 'authenticated');

    const failures = [];
    for (const payload of [
        { cmd: 'io.read', id: Symbol('req'), data: [] },
        { cmd: 'io.read', id: 4, data: function () {} },
        { cmd: 'io.read', id: 5, data: [], toJSON: () => ({ oops: true }) }
    ]) {
        node.emit('input', { payload }, undefined, (err) => failures.push(err));
    }
    assert.equal(failures.length, 3, 'each malformed payload must complete synchronously');
    for (const err of failures) {
        assert.ok(err instanceof Error, 'a reduced frame must fail via done');
        assert.match(String(err), /lost in serialisation/);
    }

    let controlErr = new Error('control done never called');
    node.emit('input', { payload: { cmd: 'io.read', id: 6, data: [] } }, undefined, (err) => { controlErr = err; });
    await waitFor(() => arrived.length > 0, 'the well-formed control frame arrives');
    assert.equal(controlErr, undefined);
    assert.equal(arrived.length, 1, 'only the well-formed frame may reach the server');
    assert.deepEqual(arrived[0], { cmd: 'io.read', id: 6, data: [] });
});

test('a toJSON that throws a non-Error fails via done with the thrown value', async (t) => {
    // done(new Error(`... ${err.message}`)) on a thrown null used to raise a
    // secondary TypeError before done() was reached: no frame, no completion,
    // and the surfaced error named neither.
    const server = await createWebIQServer(loginOk);
    t.after(() => server.close());

    const runtime = createRuntime(registerWebIQConnect);
    const node = createConnectionNode(runtime, server.port, { loginTimeout: 5, heartbeat: 0 });
    t.after(() => stopConnectionNode(node));
    await waitFor(() => node.statuses.some((s) => s.text === 'authenticated'), 'authenticated');

    let errNull;
    assert.doesNotThrow(() => {
        node.emit('input', {
            payload: { cmd: 'io.read', id: 7, data: [], toJSON: () => { throw null; } }
        }, undefined, (err) => { errNull = err; });
    });
    assert.ok(errNull instanceof Error, 'throw null must still complete the message');
    assert.match(String(errNull), /Could not serialise payload: null/);

    let errString;
    node.emit('input', {
        payload: { cmd: 'io.read', id: 8, data: [], toJSON: () => { throw 'boom'; } }
    }, undefined, (err) => { errString = err; });
    assert.ok(errString instanceof Error);
    assert.match(String(errString), /boom/, 'the thrown value must survive into the error');
    assert.doesNotMatch(String(errString), /undefined/);

    // The reason extraction itself must be total: reading .message can run a
    // throwing getter, and `instanceof` throws on a revoked Proxy - either
    // secondary throw used to escape the catch block that was quoting the
    // first one, and done() was never reached.
    const evil = new Error('x');
    Object.defineProperty(evil, 'message', { get() { throw new TypeError('secondary'); } });
    let errGetter;
    assert.doesNotThrow(() => {
        node.emit('input', {
            payload: { cmd: 'io.read', id: 12, data: [], toJSON: () => { throw evil; } }
        }, undefined, (err) => { errGetter = err; });
    });
    assert.ok(errGetter instanceof Error, 'a throwing message getter must still complete the message');
    assert.match(String(errGetter), /Could not serialise payload/);

    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    let errProxy;
    assert.doesNotThrow(() => {
        node.emit('input', {
            payload: { cmd: 'io.read', id: 13, data: [], toJSON: () => { throw revocable.proxy; } }
        }, undefined, (err) => { errProxy = err; });
    });
    assert.ok(errProxy instanceof Error, 'a revoked Proxy must still complete the message');

    // And the quoted reason is presentation text: bounded, control-stripped.
    const esc = String.fromCharCode(27);
    let errHuge;
    node.emit('input', {
        payload: { cmd: 'io.read', id: 14, data: [], toJSON: () => { throw 'A'.repeat(1000000) + esc + '[31mforged'; } }
    }, undefined, (err) => { errHuge = err; });
    assert.ok(errHuge instanceof Error);
    assert.ok(String(errHuge).length < 400, 'a thrown non-Error must be truncated for display');
    assert.ok(!String(errHuge).includes(esc), 'control bytes must never reach the log');
});

test('a negative legacy id is quoted in the example, not replaced with 1', async () => {
    // 1.0.x really sent {"id":-3} for a node id of "-3" (parseInt), and the
    // message says "keep that number" - so the example right after it must not
    // swap in a different id. Only 0 (reserved) and NaN need substituting.
    const runtime = createRuntime(registerApiRequest);
    const node = runtime.create('api-request', {
        id: '-3',
        cmd: 'io.read',
        data: '["A"]',
        interval: ''
    });

    const text = String(node.errors[0] && node.errors[0].error);
    assert.match(text, /request id was -3/);
    assert.match(text, /"id":-3/, 'the example must keep the historical negative id');
});

test('a request using req/res keys is cloned intact and isolated per message', async () => {
    // RED.util.cloneMessage clones MESSAGES: it deletes a falsy top-level req
    // and shares a truthy res by reference across every clone. Applied to a
    // request object, that silently dropped fields and let one message's
    // downstream mutation corrupt the next - the exact hazard the per-message
    // clone exists to prevent.
    const runtime = createRuntime(registerApiRequest);
    const node = runtime.create('api-request', {
        data: '{"cmd":"io.read","id":9,"data":[],"req":0,"res":{"m":1}}',
        dataType: 'json'
    });

    const drive = (msg) => new Promise((resolve) => {
        node.emit('input', msg, undefined, (err) => resolve(err));
    });
    assert.equal(await drive({}), undefined);
    assert.equal(await drive({}), undefined);

    const [first, second] = node.sent.map((m) => m.payload);
    assert.equal(first.req, 0, 'a falsy req must survive the clone');
    assert.notEqual(first.res, second.res, 'res must be cloned per message, never shared');
    first.res.m = 'corrupted-downstream';
    assert.equal(second.res.m, 1, 'mutating one message must not corrupt another');
});

test('a value the clone cannot handle fails via done, not a skipped completion', async () => {
    // structuredClone throws on a function value; unguarded, the throw escaped
    // the input handler and done() was never called - the message hung
    // incomplete with the error attributed to nothing.
    const runtime = createRuntime(registerApiRequest);
    const node = runtime.create('api-request', { data: 'request', dataType: 'msg' });

    let err;
    assert.doesNotThrow(() => {
        node.emit('input', {
            request: { cmd: 'io.read', id: 11, data: { fn: () => {} } }
        }, undefined, (e) => { err = e; });
    });
    assert.ok(err instanceof Error, 'an uncloneable request must fail via done');
    assert.match(String(err), /Could not clone/);
    assert.equal(node.sent.length, 0);
});

test('a pathologically nested Data field ends in an attributable error, never a skipped completion', async () => {
    // Deploy-time validation used to pass a deeply nested (valid JSON) request
    // that the per-message clone then threw on, skipping done(). Engine limits
    // vary, so the invariant tested is: however deep, the node either works or
    // fails via templateError/done - an input never leaves without completing.
    const depth = 200000;
    const deep = '{"a":'.repeat(depth) + '1' + '}'.repeat(depth);
    const runtime = createRuntime(registerApiRequest);
    const node = runtime.create('api-request', {
        data: `{"cmd":"io.read","id":10,"data":${deep}}`,
        dataType: 'json'
    });

    let err;
    assert.doesNotThrow(() => {
        node.emit('input', {}, undefined, (e) => { err = e; });
    });
    if (node.sent.length === 0) {
        assert.ok(err instanceof Error, 'an unsendable deep request must fail via done');
        assert.equal(node.statuses[0].fill, 'red', 'and show on the canvas at deploy time');
    }
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

    // Mutation-verified: with the old slice()-based truncation reinstated, the
    // lone high surrogate appears MID-warning (the sanitized text is always
    // followed by ' - attempt N of M...'), so a final-character check could
    // never fire. Scan by code unit instead of by regex: escape sequences in
    // this file have been corrupted by tooling twice, char codes cannot be.
    function hasLoneSurrogate(text) {
        for (let i = 0; i < text.length; i++) {
            const c = text.charCodeAt(i);
            if (c >= 0xD800 && c <= 0xDBFF) {
                const next = text.charCodeAt(i + 1);
                if (!(next >= 0xDC00 && next <= 0xDFFF)) { return true; }
                i += 1;
            } else if (c >= 0xDC00 && c <= 0xDFFF) {
                return true;
            }
        }
        return false;
    }
    for (const w of node.warnings) {
        assert.ok(!hasLoneSurrogate(String(w)), 'no warning may contain an unpaired surrogate anywhere');
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

test('a non-numeric legacy interval is reported as never polled', async () => {
    // The shipped 1.0.x code guarded polling with `config.interval > 0`, so a
    // non-numeric or negative value never reached setInterval. (Verified by
    // executing the published 1.0.x package; an earlier 2.0.0 draft claimed the
    // opposite and this test enforced the error.)
    const runtime = createRuntime(registerApiRequest);
    const node = runtime.create('api-request', {
        cmd: 'io.read',
        data: '["A"]',
        interval: '5,0'
    });

    const text = String(node.errors[0] && node.errors[0].error);
    assert.match(text, /never polled/, 'interval > 0 rejected "5,0"; the node did not poll');
    assert.doesNotMatch(text, /WAS polling/);
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

test('a generated hex 1.0.x node id recovers the decimal prefix 1.0.x sent', async () => {
    // 1.0.x did parseInt(config.id, 10) on the node's own hex id, so
    // "738399a874eef1da" put 738399 on the wire - not 1, and not the full id.
    const runtime = createRuntime(registerApiRequest);
    const node = runtime.create('api-request', {
        id: '738399a874eef1da',
        cmd: 'io.read',
        data: '["A"]',
        interval: ''
    });

    const text = String(node.errors[0] && node.errors[0].error);
    assert.match(text, /request id was 738399/);
    assert.match(text, /"id":738399/, 'the example must use the historical wire id');
});

test('a letter-leading 1.0.x node id is reported as null on the wire', async () => {
    // parseInt("a8b1...", 10) is NaN, and JSON.stringify({id: NaN}) puts
    // "id":null in the frame - a downstream filter was matching null, and the
    // guidance must say so rather than silently suggesting a new id.
    const runtime = createRuntime(registerApiRequest);
    const node = runtime.create('api-request', {
        id: 'a8b1c2d3e4f50617',
        cmd: 'io.read',
        data: '["A"]',
        interval: ''
    });

    const text = String(node.errors[0] && node.errors[0].error);
    assert.match(text, /null on the wire/);
    assert.match(text, /"id":1/, 'with no numeric history, the example falls back to 1');
});

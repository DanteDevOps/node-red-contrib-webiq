const assert = require('node:assert/strict');
const test = require('node:test');

const registerApiRequest = require('../api-request');
const registerWebIQConnect = require('../webiq-api-connect');
const {
    createConnectionNode,
    createRuntime,
    createWebIQServer,
    stopConnectionNode,
    waitFor
} = require('./support/harness');

test('invalid API Request JSON reports an input error without emitting a request', () => {
    const runtime = createRuntime(registerApiRequest);
    const node = runtime.create('api-request', { data: '{not-json' });
    let doneError;

    node.emit('input', { topic: 'invalid' }, undefined, (error) => {
        doneError = error;
    });

    assert.equal(node.sent.length, 0);
    assert.ok(doneError instanceof Error);
});

test('a circular outbound payload becomes an input-scoped error instead of throwing', async (t) => {
    const server = await createWebIQServer(({ request, socket }) => {
        if (request.cmd === 'user.login') {
            socket.send(JSON.stringify({
                cmd: 'user.login',
                id: request.id,
                data: { loggedIn: true }
            }));
        }
    });
    t.after(() => server.close());

    const runtime = createRuntime(registerWebIQConnect);
    const node = createConnectionNode(runtime, server.port);
    t.after(() => stopConnectionNode(node));

    await waitFor(
        () => node.statuses.some((status) => status.text === 'authenticated'),
        'authenticated status'
    );

    const payload = { cmd: 'io.write', id: 14, data: {} };
    payload.data.circular = payload;
    let doneError;

    assert.doesNotThrow(() => {
        node.emit('input', { payload }, undefined, (error) => {
            doneError = error;
        });
    });
    assert.ok(doneError instanceof Error);
});

test('a legacy code-404 login error is an ordinary rejection, not "project not found"', async (t) => {
    // Real WebIQ never sends a JSON 404 for a wrong project - the project is a URL
    // path segment, rejected at the HTTP upgrade before any login exists. The old
    // dedicated branch keyed on error.code, a field the real server does not emit,
    // and was deleted after the field campaign proved it unreachable. Any JSON
    // login error, whatever its shape, now walks the rejection ladder.
    const server = await createWebIQServer(({ request, socket }) => {
        if (request.cmd === 'user.login') {
            socket.send(JSON.stringify({
                cmd: 'user.login',
                id: request.id,
                error: {
                    code: 404,
                    message: 'Project not found'
                }
            }));
        }
    });
    t.after(() => server.close());

    const runtime = createRuntime(registerWebIQConnect);
    const node = createConnectionNode(runtime, server.port);
    t.after(() => stopConnectionNode(node));

    await waitFor(
        () => node.statuses.some((status) => /login failed \(1\//.test(status.text)),
        'rejection badge with attempt count'
    );
    await waitFor(
        () => node.sent.some((msg) => msg.payload && msg.payload.error?.code === 404),
        'error frame still forwarded',
        250
    );
    assert.equal(
        node.statuses.some((status) => status.text === 'project not found'),
        false,
        'the unreachable badge must never appear'
    );
});

test('Node-RED can await asynchronous WebSocket teardown', async (t) => {
    const server = await createWebIQServer(({ request, socket }) => {
        if (request.cmd === 'user.login') {
            socket.send(JSON.stringify({
                cmd: 'user.login',
                id: request.id,
                data: { loggedIn: true }
            }));
        }
    });
    t.after(() => server.close());

    const runtime = createRuntime(registerWebIQConnect);
    const node = createConnectionNode(runtime, server.port);

    await waitFor(
        () => node.statuses.some((status) => status.text === 'authenticated'),
        'authenticated status'
    );

    let completed = false;
    node.emit('close', false, () => {
        completed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(completed, true);
});

test('username and password are registered as protected Node-RED credentials', () => {
    const runtime = createRuntime(registerWebIQConnect);
    const registration = runtime.registration('webiq-api-connect');

    assert.deepEqual(registration.options?.credentials, {
        username: { type: 'text' },
        password: { type: 'password' }
    });
});

test('very large login timeout values do not overflow into an immediate timeout', async (t) => {
    const server = await createWebIQServer(() => {});
    t.after(() => server.close());

    const runtime = createRuntime(registerWebIQConnect);
    const node = createConnectionNode(runtime, server.port, {
        loginTimeout: 2147484
    });
    t.after(() => stopConnectionNode(node));

    await waitFor(
        () => server.requests.some((request) => request.cmd === 'user.login'),
        'login request'
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(
        node.errors.some(({ error }) => String(error).includes('No login reply received')),
        false
    );
});

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

test('a project-not-found login response is emitted and the socket is closed', async (t) => {
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
        () => node.statuses.some((status) => status.text === 'project not found'),
        'project-not-found status'
    );
    await waitFor(
        () => node.sent.some((msg) => msg.payload && msg.payload.error?.code === 404),
        'project-not-found output',
        250
    );
    await waitFor(
        () => server.requests.length > 0 && [...server.clients].every((client) => client.readyState > 1),
        'project-not-found socket close',
        250
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

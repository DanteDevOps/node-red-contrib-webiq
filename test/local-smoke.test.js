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

test('API Request parses configured JSON into msg.payload', () => {
    const runtime = createRuntime(registerApiRequest);
    const node = runtime.create('api-request', {
        data: '{"cmd":"io.read","id":7,"data":["Temperature"]}'
    });
    const msg = { topic: 'preserved' };

    node.emit('input', msg);

    assert.equal(node.sent.length, 1);
    assert.deepEqual(node.sent[0], {
        topic: 'preserved',
        payload: {
            cmd: 'io.read',
            id: 7,
            data: ['Temperature']
        }
    });
});

test('WebIQ Connect authenticates, forwards a request, and emits responses', async (t) => {
    const server = await createWebIQServer(({ request, socket }) => {
        if (request.cmd === 'user.login') {
            socket.send(JSON.stringify({
                cmd: 'user.login',
                id: request.id,
                data: { loggedIn: true }
            }));
            return;
        }

        socket.send(JSON.stringify({
            cmd: request.cmd,
            id: request.id,
            data: { values: [42] }
        }));
    });
    t.after(() => server.close());

    const runtime = createRuntime(registerWebIQConnect);
    const node = createConnectionNode(runtime, server.port);
    t.after(() => stopConnectionNode(node));

    await waitFor(
        () => node.statuses.some((status) => status.text === 'authenticated'),
        'authenticated status'
    );

    assert.deepEqual(server.requests[0], {
        cmd: 'user.login',
        id: 0,
        data: {
            username: 'test-user',
            password: 'test-password',
            realm: null
        }
    });

    const request = {
        cmd: 'io.read',
        id: 12,
        data: ['Temperature']
    };
    node.emit('input', { payload: request });

    await waitFor(
        () => server.requests.some((item) => item.id === request.id),
        'forwarded API request'
    );
    await waitFor(
        () => node.sent.some((msg) => msg.payload && msg.payload.id === request.id),
        'API response output'
    );

    assert.deepEqual(
        node.sent.find((msg) => msg.payload && msg.payload.id === request.id),
        {
            payload: {
                cmd: 'io.read',
                id: 12,
                data: { values: [42] }
            }
        }
    );
});

test('a delayed login succeeds when it is within the configured timeout', async (t) => {
    const responseDelayMs = 100;
    const server = await createWebIQServer(({ request, socket }) => {
        if (request.cmd !== 'user.login') return;

        setTimeout(() => {
            if (socket.readyState === socket.OPEN) {
                socket.send(JSON.stringify({
                    cmd: 'user.login',
                    id: request.id,
                    data: { loggedIn: true }
                }));
            }
        }, responseDelayMs);
    });
    t.after(() => server.close());

    const runtime = createRuntime(registerWebIQConnect);
    const node = createConnectionNode(runtime, server.port, { loginTimeout: 0.5 });
    t.after(() => stopConnectionNode(node));

    await waitFor(
        () => node.statuses.some((status) => status.text === 'authenticated'),
        'authentication after delayed login'
    );

    assert.equal(
        node.errors.some(({ error }) => String(error).includes('No login reply received')),
        false
    );
});

test('the configured login timeout closes a connection that never replies', async (t) => {
    const server = await createWebIQServer(() => {});
    t.after(() => server.close());

    const runtime = createRuntime(registerWebIQConnect);
    const node = createConnectionNode(runtime, server.port, { loginTimeout: 0.05 });
    t.after(() => stopConnectionNode(node));

    const timeoutError = await waitFor(
        () => node.errors.find(({ error }) => String(error).includes('No login reply received')),
        'login timeout error'
    );

    assert.match(String(timeoutError.error), /within 0\.05s/);
    // The badge no longer says "/ project not found". A login that goes unanswered
    // says nothing about the project - the project is a URL path segment, so a wrong
    // one is refused at the HTTP upgrade long before a login is ever sent. Blaming it
    // here sent users to check a field that was never involved.
    assert.ok(
        node.statuses.some((status) => status.text === 'login timeout')
    );
});

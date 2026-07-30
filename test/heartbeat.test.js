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

function loginResponder({ request, socket }) {
    if (request.cmd === 'user.login') {
        socket.send(JSON.stringify({
            cmd: 'user.login',
            id: request.id,
            data: { loggedIn: true }
        }));
    }
}

test('a half-open link is detected and reconnected instead of staying green', async (t) => {
    const connections = [];
    const server = await createWebIQServer(loginResponder);

    // Track sockets so we can freeze the first one.
    const seen = new Set();
    const trackConnections = setInterval(() => {
        for (const client of server.clients) {
            if (!seen.has(client)) {
                seen.add(client);
                connections.push(client);
            }
        }
    }, 10);
    t.after(() => clearInterval(trackConnections));
    t.after(() => server.close());

    const runtime = createRuntime(registerWebIQConnect);
    const node = createConnectionNode(runtime, server.port, {
        loginTimeout: 5,
        heartbeat: 0.15
    });
    t.after(() => stopConnectionNode(node));

    await waitFor(
        () => node.statuses.some((status) => status.text === 'authenticated'),
        'authenticated status'
    );
    await waitFor(() => connections.length >= 1, 'first server connection');

    // Freeze the peer: pausing the socket stops it reading, so it never sees the
    // ping and never pongs - a TCP connection that is open but dead, which is
    // exactly the failure no 'close' event ever reports.
    connections[0].pause();

    await waitFor(
        () => node.statuses.some((status) => status.text === 'link stale - reconnecting'),
        'stale-link detection',
        4000
    );

    assert.ok(
        node.warnings.some((warning) => String(warning).includes('terminating an apparently dead link')),
        'expected a heartbeat warning'
    );

    // It must actually recover, not just notice.
    await waitFor(
        () => connections.length >= 2,
        'reconnection after a dead link',
        6000
    );
});

test('heartbeat 0 disables probing entirely', async (t) => {
    let pings = 0;
    const server = await createWebIQServer(loginResponder);
    t.after(() => server.close());

    const runtime = createRuntime(registerWebIQConnect);
    const node = createConnectionNode(runtime, server.port, {
        loginTimeout: 5,
        heartbeat: 0
    });
    t.after(() => stopConnectionNode(node));

    await waitFor(
        () => node.statuses.some((status) => status.text === 'authenticated'),
        'authenticated status'
    );

    for (const client of server.clients) {
        client.on('ping', () => { pings += 1; });
    }

    await new Promise((resolve) => setTimeout(resolve, 600));

    assert.equal(pings, 0, 'no pings should be sent when the heartbeat is disabled');
    assert.equal(
        node.statuses.some((status) => status.text === 'link stale - reconnecting'),
        false
    );
    assert.equal(node.statuses[node.statuses.length - 1].text, 'authenticated');
});

test('ordinary traffic keeps a link alive even without pongs', async (t) => {
    const server = await createWebIQServer(({ request, socket }) => {
        loginResponder({ request, socket });
    });
    t.after(() => server.close());

    const runtime = createRuntime(registerWebIQConnect);
    const node = createConnectionNode(runtime, server.port, {
        loginTimeout: 5,
        heartbeat: 0.15
    });
    t.after(() => stopConnectionNode(node));

    await waitFor(
        () => node.statuses.some((status) => status.text === 'authenticated'),
        'authenticated status'
    );

    // Push unsolicited frames faster than the heartbeat interval. Even if pongs
    // were absent, inbound traffic alone must count as evidence of life.
    const chatter = setInterval(() => {
        for (const client of server.clients) {
            if (client.readyState === client.OPEN) {
                client.send(JSON.stringify({ cmd: 'io.notify', id: 99, data: { tick: true } }));
            }
        }
    }, 50);
    t.after(() => clearInterval(chatter));

    await new Promise((resolve) => setTimeout(resolve, 700));

    assert.equal(
        node.statuses.some((status) => status.text === 'link stale - reconnecting'),
        false,
        'a chatty link must never be terminated'
    );
});

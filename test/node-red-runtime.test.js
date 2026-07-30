const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createRequire } = require('node:module');
const path = require('node:path');
const test = require('node:test');
const { WebSocketServer } = require('ws');

const registerApiRequest = require('../api-request');
const registerWebIQConnect = require('../webiq-api-connect');

const runtimeDirectory = process.env.WEBIQ_NODE_RED_TEST_RUNTIME;

if (!runtimeDirectory) {
    test('real Node-RED runtime integration', {
        skip: 'Set WEBIQ_NODE_RED_TEST_RUNTIME to a directory containing node-red and node-red-node-test-helper'
    }, () => {});
} else {
    const runtimeRequire = createRequire(path.join(
        path.resolve(runtimeDirectory),
        'package.json'
    ));
    const helper = runtimeRequire('node-red-node-test-helper');

    helper.init(runtimeRequire.resolve('node-red'));

    test('API Request and WebIQ Connect run end-to-end in Node-RED', async (t) => {
        const server = new WebSocketServer({ port: 0 });
        const serverRequests = [];

        server.on('connection', (socket) => {
            socket.on('message', (raw) => {
                const request = JSON.parse(raw.toString());
                serverRequests.push(request);

                if (request.cmd === 'user.login') {
                    socket.send(JSON.stringify({
                        cmd: request.cmd,
                        id: request.id,
                        data: { loggedIn: true }
                    }));
                    return;
                }

                socket.send(JSON.stringify({
                    cmd: request.cmd,
                    id: request.id,
                    data: { values: [73] }
                }));
            });
        });

        await once(server, 'listening');
        await new Promise((resolve, reject) => {
            helper.startServer((error) => error ? reject(error) : resolve());
        });

        t.after(async () => {
            await helper.unload();
            await new Promise((resolve) => helper.stopServer(resolve));
            for (const client of server.clients) {
                client.terminate();
            }
            await new Promise((resolve) => server.close(resolve));
        });

        const flow = [
            {
                id: 'flow-1',
                type: 'tab',
                label: 'WebIQ local integration'
            },
            {
                id: 'request-1',
                z: 'flow-1',
                type: 'api-request',
                data: '{"cmd":"io.read","id":21,"data":["Temperature"]}',
                wires: [['connect-1']]
            },
            {
                id: 'connect-1',
                z: 'flow-1',
                type: 'webiq-api-connect',
                host: '127.0.0.1',
                port: String(server.address().port),
                project: 'test-project',
                username: 'test-user',
                password: 'test-password',
                loginTimeout: 1,
                wires: [['output-1']]
            },
            {
                id: 'output-1',
                z: 'flow-1',
                type: 'helper'
            }
        ];

        await helper.load(
            [registerApiRequest, registerWebIQConnect],
            flow
        );

        const requestNode = helper.getNode('request-1');
        const outputNode = helper.getNode('output-1');
        const outputs = [];
        outputNode.on('input', (msg) => outputs.push(msg));

        await waitFor(
            () => serverRequests.some((request) => request.cmd === 'user.login'),
            'Node-RED login request'
        );

        requestNode.receive({ topic: 'preserved-by-api-request' });

        await waitFor(
            () => outputs.find((msg) => msg.payload?.id === 21),
            'Node-RED WebIQ response'
        );

        assert.deepEqual(
            serverRequests.find((request) => request.id === 21),
            {
                cmd: 'io.read',
                id: 21,
                data: ['Temperature']
            }
        );
        assert.deepEqual(
            outputs.find((msg) => msg.payload?.id === 21).payload,
            {
                cmd: 'io.read',
                id: 21,
                data: { values: [73] }
            }
        );
    });
}

async function waitFor(predicate, description, timeoutMs = 2500) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        const result = predicate();
        if (result) return result;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.fail(`Timed out waiting for ${description}`);
}

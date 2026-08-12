const assert = require('node:assert/strict');
const test = require('node:test');

const registerApiRequest = require('../api-request');
const { createRuntime } = require('./support/harness');

function drive(node, msg) {
    return new Promise((resolve) => {
        node.emit('input', msg, undefined, (error) => resolve(error));
    });
}

test('a node with no dataType is treated as static JSON', async () => {
    const runtime = createRuntime(registerApiRequest);
    const node = runtime.create('api-request', {
        data: '{"cmd":"io.read","id":1,"data":["A"]}'
    });

    const err = await drive(node, { topic: 'legacy' });

    assert.equal(err, undefined);
    assert.deepEqual(node.sent[0].payload, { cmd: 'io.read', id: 1, data: ['A'] });
    assert.equal(node.sent[0].topic, 'legacy');
});

test('msg type reads the request from the incoming message at runtime', async () => {
    const runtime = createRuntime(registerApiRequest);
    const node = runtime.create('api-request', {
        data: 'request',
        dataType: 'msg'
    });

    const first = await drive(node, { request: { cmd: 'io.write', id: 5, data: { Tag: 1 } } });
    const second = await drive(node, { request: { cmd: 'io.write', id: 6, data: { Tag: 2 } } });

    assert.equal(first, undefined);
    assert.equal(second, undefined);
    assert.equal(node.sent.length, 2);
    assert.deepEqual(node.sent[0].payload, { cmd: 'io.write', id: 5, data: { Tag: 1 } });
    assert.deepEqual(node.sent[1].payload, { cmd: 'io.write', id: 6, data: { Tag: 2 } });
});

test('a JSON string from a dynamic source is parsed', async () => {
    process.env.WEBIQ_TEST_REQUEST = '{"cmd":"io.read","id":9,"data":["B"]}';
    const runtime = createRuntime(registerApiRequest);
    const node = runtime.create('api-request', {
        data: 'WEBIQ_TEST_REQUEST',
        dataType: 'env'
    });

    const err = await drive(node, {});

    assert.equal(err, undefined);
    assert.deepEqual(node.sent[0].payload, { cmd: 'io.read', id: 9, data: ['B'] });
    delete process.env.WEBIQ_TEST_REQUEST;
});

test('a dynamic value missing required fields fails without emitting', async () => {
    const runtime = createRuntime(registerApiRequest);
    const node = runtime.create('api-request', {
        data: 'request',
        dataType: 'msg'
    });

    const err = await drive(node, { request: { cmd: 'io.read' } });

    assert.ok(err instanceof Error);
    assert.match(String(err), /missing "id"/);
    assert.equal(node.sent.length, 0);
});

test('a dynamic value that is not an object fails without emitting', async () => {
    const runtime = createRuntime(registerApiRequest);
    const node = runtime.create('api-request', {
        data: 'request',
        dataType: 'msg'
    });

    const err = await drive(node, { request: 42 });

    assert.ok(err instanceof Error);
    assert.match(String(err), /not a request object/);
    assert.equal(node.sent.length, 0);
});

test('a static payload missing required fields is reported at deploy time', async () => {
    const runtime = createRuntime(registerApiRequest);
    const node = runtime.create('api-request', {
        data: '{"cmd":"io.read"}',
        dataType: 'json'
    });

    assert.deepEqual(node.statuses[0], { fill: 'red', shape: 'ring', text: 'invalid request' });

    const err = await drive(node, {});
    assert.ok(err instanceof Error);
    assert.equal(node.sent.length, 0);
});

test('the static template is cloned so downstream mutation cannot corrupt it', async () => {
    const runtime = createRuntime(registerApiRequest);
    const node = runtime.create('api-request', {
        data: '{"cmd":"io.read","id":1,"data":["A"]}'
    });

    await drive(node, {});
    node.sent[0].payload.data.push('MUTATED');
    await drive(node, {});

    assert.deepEqual(node.sent[1].payload.data, ['A'], 'second message must be unaffected');
});

test('flow and global context sources are evaluated per message', async () => {
    for (const scope of ['flow', 'global']) {
        const runtime = createRuntime(registerApiRequest);
        const node = runtime.create('api-request', {
            data: 'webiqRequest',
            dataType: scope
        });

        // The harness mock reads these off the node, mirroring a context store.
        const store = { webiqRequest: { cmd: 'io.read', id: 3, data: ['Tag'] } };
        if (scope === 'flow') { node._flowContext = store; } else { node._globalContext = store; }

        const err = await drive(node, {});

        assert.equal(err, undefined, `${scope} source should evaluate cleanly`);
        assert.deepEqual(node.sent[0].payload, { cmd: 'io.read', id: 3, data: ['Tag'] });
    }
});

test('a context source with nothing stored fails without emitting', async () => {
    const runtime = createRuntime(registerApiRequest);
    const node = runtime.create('api-request', {
        data: 'missingKey',
        dataType: 'flow'
    });
    node._flowContext = {};

    const err = await drive(node, {});

    assert.ok(err instanceof Error);
    assert.match(String(err), /not a request object/);
    assert.equal(node.sent.length, 0);
});

test('a flow-context template is cloned, so downstream mutation cannot corrupt the store', async () => {
    const runtime = createRuntime(registerApiRequest);
    const node = runtime.create('api-request', {
        data: 'webiqRequest',
        dataType: 'flow'
    });

    const stored = { cmd: 'io.read', id: 3, data: ['Tag'] };
    node._flowContext = { webiqRequest: stored };

    await drive(node, {});
    node.sent[0].payload.data.push('MUTATED');
    await drive(node, {});

    assert.deepEqual(node.sent[1].payload.data, ['Tag'], 'second message must be unaffected');
    assert.deepEqual(stored.data, ['Tag'], 'the stored context object itself must be untouched');
});

test('a pre-1.1 node is told it needs migration, not that its JSON is invalid', async () => {
    const runtime = createRuntime(registerApiRequest);
    // How 1.0.x stored it: separate fields, data holding only the request data.
    const node = runtime.create('api-request', {
        cmd: 'io.read',
        id: 0,
        data: '["DSin", "SInt"]',
        interval: 0
    });

    assert.deepEqual(node.statuses[0], { fill: 'red', shape: 'ring', text: 'needs migration' });

    const err = await drive(node, {});
    assert.ok(err instanceof Error);
    assert.match(String(err), /pre-1\.1 layout/);
    assert.match(String(err), /interval/, 'the removed polling behaviour must be called out');
    assert.equal(node.sent.length, 0);
});

test('a request using the reserved id 0 warns but still works', async () => {
    const runtime = createRuntime(registerApiRequest);
    const node = runtime.create('api-request', {
        data: '{"cmd":"io.read","id":0,"data":["A"]}'
    });

    assert.ok(
        node.warnings.some((w) => /reserves for its own login/.test(String(w))),
        'id 0 must be called out'
    );

    // Deliberately not rejected: 1.1.x shipped 0 as the default, and refusing it
    // would break flows that work today.
    const err = await drive(node, {});
    assert.equal(err, undefined);
    assert.equal(node.sent.length, 1);
});

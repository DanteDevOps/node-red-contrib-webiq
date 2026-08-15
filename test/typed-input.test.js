const assert = require('node:assert/strict');
const test = require('node:test');

const registerApiRequest = require('../api-request');
const { createRuntime } = require('./support/harness');
const { extractEditorNode, extractEditorDefaults, dialogWithData } = require('./support/editor');

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
        data: '["DSin", "SInt"]',
        interval: 500
    });

    assert.deepEqual(node.statuses[0], { fill: 'red', shape: 'ring', text: 'needs migration' });

    const err = await drive(node, {});
    assert.ok(err instanceof Error);
    assert.match(String(err), /pre-1\.1 layout/);
    assert.match(String(err), /polled itself every 500 ms/, 'the removed polling behaviour and its real unit must be called out');
    assert.match(String(err), /every 0.5 s/, 'the Inject equivalent must be given in seconds');
    assert.match(String(err), /"io.read"/, 'the old command must be quoted back');
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

test('a legacy node survives a full deploy that strips undeclared properties', async () => {
    // Node-RED serializes only DECLARED defaults. cmd/interval are now declared as
    // deprecated fields precisely so the first full deploy after upgrading cannot
    // erase the record of what the node used to do. The list comes from the real
    // editor file: a hardcoded copy stayed green after the declarations changed.
    const declared = Object.keys(extractEditorDefaults('api-request.html', 'api-request'));
    const legacy = { cmd: 'io.write', data: '["DSin"]', interval: 500 };

    const afterDeploy = {};
    for (const key of Object.keys(legacy)) {
        if (declared.includes(key)) { afterDeploy[key] = legacy[key]; }
    }

    const runtime = createRuntime(registerApiRequest);
    const node = runtime.create('api-request', afterDeploy);

    assert.deepEqual(node.statuses[0], { fill: 'red', shape: 'ring', text: 'needs migration' });
    assert.ok(
        node.errors.some(({ error }) => /io\.write/.test(String(error))),
        'the original command must survive the deploy'
    );
});

test('a legacy node explains itself at deploy time, with no input wired', async () => {
    // A 1.0.x node polled itself, so it commonly has nothing on its input and
    // would otherwise show a bare badge and never say what to do.
    const runtime = createRuntime(registerApiRequest);
    const node = runtime.create('api-request', { cmd: 'io.read', data: '["A"]', interval: 500 });

    assert.ok(node.errors.length > 0, 'the explanation must not wait for a message');
    assert.match(String(node.errors[0].error), /pre-1\.1 layout/);
});

test('the documented migration completes end-to-end', async () => {
    // The full lifecycle the migration error instructs: a 1.0.x node upgrades
    // in place, the user opens it, puts the whole request into Data, and saves.
    // Mirror the real editor's ordering exactly - oneditsave runs FIRST and
    // reads the pending value from the dialog DOM (`this` still holds the
    // pre-edit properties), then the pane copies the inputs onto the node.
    // Before the oneditsave existed, the dialog wrote cmd/interval back
    // unchanged and the node stayed latched on "needs migration" forever.
    const migrated = '{"cmd":"io.write","id":7,"data":["DSin"]}';
    const def = extractEditorNode('api-request.html', 'api-request', dialogWithData('json', migrated));

    // In-place upgrade state: legacy properties survive the deploy.
    const dialog = { cmd: 'io.write', interval: 500, data: '["DSin"]', dataType: 'json' };
    def.oneditsave.call(dialog);
    // The pane apply loop then writes the bound inputs.
    dialog.data = migrated;

    const runtime = createRuntime(registerApiRequest);
    const node = runtime.create('api-request', {
        data: dialog.data,
        dataType: dialog.dataType,
        cmd: dialog.cmd,
        interval: dialog.interval
    });

    assert.deepEqual(node.statuses[0], { fill: 'blue', shape: 'dot', text: 'ready' },
        'after the documented migration the node must leave the legacy state');
    const err = await drive(node, {});
    assert.equal(err, undefined);
    assert.equal(node.sent.length, 1, 'a migrated node must forward requests');
    assert.deepEqual(node.sent[0].payload, { cmd: 'io.write', id: 7, data: ['DSin'] });
});

test('an inspect-only save keeps the migration record intact', async () => {
    // The user opens the "needs migration" node to read the guidance and
    // clicks Done without editing anything. An unconditional oneditsave here
    // erased the only record of the node's command, cadence and historical
    // wire id - the exact data-loss the declared deprecated defaults exist to
    // prevent - and downgraded the badge to a generic "invalid request".
    const def = extractEditorNode('api-request.html', 'api-request',
        dialogWithData('json', '["DSin"]'));

    const dialog = { cmd: 'io.write', interval: 500, data: '["DSin"]', dataType: 'json' };
    def.oneditsave.call(dialog);

    const runtime = createRuntime(registerApiRequest);
    const node = runtime.create('api-request', {
        id: '738399a874eef1da',
        data: dialog.data,
        dataType: dialog.dataType,
        cmd: dialog.cmd,
        interval: dialog.interval
    });

    assert.deepEqual(node.statuses[0], { fill: 'red', shape: 'ring', text: 'needs migration' },
        'an inspect-only save must not downgrade the actionable badge');
    const text = String(node.errors[0] && node.errors[0].error);
    assert.match(text, /io\.write/, 'the command must survive an inspect-only save');
    assert.match(text, /500 ms/, 'the cadence must survive an inspect-only save');
    assert.match(text, /738399/, 'the historical wire id must survive an inspect-only save');
});

test('saving a JSON typo keeps the migration record intact', async () => {
    // The Data field has no editor validator, so the dialog accepts a typo
    // silently; clearing the markers on that save would destroy the guidance
    // exactly when the user needs it to try again.
    const def = extractEditorNode('api-request.html', 'api-request',
        dialogWithData('json', '{"cmd":"io.write","id":7'));

    const dialog = { cmd: 'io.write', interval: 500, data: '["DSin"]', dataType: 'json' };
    def.oneditsave.call(dialog);
    dialog.data = '{"cmd":"io.write","id":7';

    const runtime = createRuntime(registerApiRequest);
    const node = runtime.create('api-request', {
        data: dialog.data,
        dataType: dialog.dataType,
        cmd: dialog.cmd,
        interval: dialog.interval
    });

    assert.deepEqual(node.statuses[0], { fill: 'red', shape: 'ring', text: 'needs migration' },
        'a saved typo must not erase the migration guidance');
    assert.match(String(node.errors[0] && node.errors[0].error), /io\.write/);
});

test('switching to a dynamic source completes the migration', async () => {
    // A msg/flow/global/env source supplies the whole request at runtime, so
    // choosing one IS the migration even though the json text was never edited.
    const def = extractEditorNode('api-request.html', 'api-request',
        dialogWithData('msg', 'request'));

    const dialog = { cmd: 'io.write', interval: 500, data: '["DSin"]', dataType: 'json' };
    def.oneditsave.call(dialog);
    dialog.data = 'request';
    dialog.dataType = 'msg';

    const runtime = createRuntime(registerApiRequest);
    const node = runtime.create('api-request', {
        data: dialog.data,
        dataType: dialog.dataType,
        cmd: dialog.cmd,
        interval: dialog.interval
    });

    assert.deepEqual(node.statuses[0], { fill: 'blue', shape: 'dot', text: 'ready' });
    const err = await drive(node, { request: { cmd: 'io.read', id: 3, data: ['A'] } });
    assert.equal(err, undefined);
    assert.equal(node.sent.length, 1);
});

test('a new node is not mistaken for a legacy one', async () => {
    // The deprecated fields default to "" in the editor; empty must count as absent.
    const runtime = createRuntime(registerApiRequest);
    const node = runtime.create('api-request', {
        data: '{"cmd":"io.read","id":1,"data":["A"]}',
        dataType: 'json',
        cmd: '',
        interval: ''
    });

    assert.deepEqual(node.statuses[0], { fill: 'blue', shape: 'dot', text: 'ready' });
    const err = await drive(node, {});
    assert.equal(err, undefined);
});

test('a dynamic request using the reserved id 0 warns once, not per message', async () => {
    const runtime = createRuntime(registerApiRequest);
    const node = runtime.create('api-request', { data: 'request', dataType: 'msg' });

    for (let i = 0; i < 3; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await drive(node, { request: { cmd: 'io.read', id: 0, data: ['A'] } });
    }

    const warnings = node.warnings.filter((w) => /reserves for its own login/.test(String(w)));
    assert.equal(warnings.length, 1, 'exactly one warning for a repeated dynamic id 0');
    assert.equal(node.sent.length, 3, 'and the requests still go through');
});

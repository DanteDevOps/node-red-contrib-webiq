// The editor validate() functions are plain JS inside the HTML files; extract
// and EXECUTE them so their contract is pinned like any other code. They exist
// to mirror the runtime's validation - every divergence found in review was in
// exactly this mirror.
const assert = require('node:assert/strict');
const test = require('node:test');

const { extractEditorNode, extractEditorDefaults, dialogWithData } = require('./support/editor');

test('connect-node editor validators mirror the runtime rules', () => {
    const d = extractEditorDefaults('webiq-api-connect.html', 'webiq-api-connect');

    const cases = [
        // host: accept plain names, Docker names/IDs, IPv4, bare + bracketed IPv6
        ['host', 'localhost', true],
        ['host', '127.0.0.1', true],
        ['host', 'webiq_server', true],
        ['host', 'e8b193a88e3e', true],
        ['host', 'my-host.example.com', true],
        ['host', '::1', true],
        ['host', '[::1]', true],
        // host: reject authority syntax the runtime refuses
        ['host', '', false],
        ['host', 'trusted.example@127.0.0.1', false],
        ['host', 'http://x', false],
        ['host', 'x/path', false],
        ['host', 'a b', false],
        ['host', 'h:123', false],
        ['host', 'x?q', false],
        ['host', 'x#f', false],
        // host: bracketed literal must be ONLY the literal (review finding: a
        // leading '[' used to bypass every colon check)
        ['host', '[::1]:8080', false],
        ['host', '[fe80::1]:511', false],
        // host: zone IDs travel in neither form - a ws:// URL cannot carry them
        ['host', 'fe80::1%eth0', false],
        ['host', '[fe80::1%eth0]', false],

        ['port', '10123', true],
        ['port', '1', true],
        ['port', '65535', true],
        ['port', '', false],
        ['port', '0', false],
        ['port', '70000', false],
        ['port', '1.5', false],

        ['project', 'test-project', true],
        ['project', '', false],
        // whitespace-only fails at deploy ("project missing"), so the editor
        // must refuse it too
        ['project', ' ', false],
        ['project', '  \t ', false],
        ['project', 'a/b', false],
        ['project', 'a?b', false],

        ['loginTimeout', '', true],
        ['loginTimeout', '5', true],
        ['loginTimeout', '0.1', true],
        ['loginTimeout', '0.05', false],
        ['loginTimeout', '90000', false],

        ['heartbeat', '', true],
        ['heartbeat', '0', true],
        ['heartbeat', '30', true],
        ['heartbeat', '0.5', false],
        ['heartbeat', '4000', false],

        ['loginAttempts', '', true],
        ['loginAttempts', '5', true],
        ['loginAttempts', '0', false],
        ['loginAttempts', '21', false],
        // the runtime floors fractions (with a warning); the editor refuses
        // them so the deployed value is always the one the user typed
        ['loginAttempts', '2.5', false],
        ['loginAttempts', 2.5, false]
    ];

    for (const [field, value, expect] of cases) {
        assert.equal(
            d[field].validate(value),
            expect,
            `${field} validate(${JSON.stringify(value)}) must be ${expect}`
        );
    }
});

test('request-node editor declares the deprecated markers and clears them on save', () => {
    const def = extractEditorNode('api-request.html', 'api-request');

    // Declared so a full deploy cannot strip them (removing these declarations
    // reintroduces the 1.0.x migration-data loss fixed in c741ee0) ...
    assert.deepEqual(def.defaults.cmd, { value: '' });
    assert.deepEqual(def.defaults.interval, { value: '' });
    assert.equal(def.defaults.dataType.value, 'json');
    const example = JSON.parse(def.defaults.data.value);
    assert.ok(example.cmd && example.id !== undefined && example.data !== undefined,
        'the default Data must itself be a valid request');

    // ... and cleared on save once the pending Data is a complete request, or
    // the dialog writes them back unchanged forever and a legacy node can never
    // complete the documented migration.
    assert.equal(typeof def.oneditsave, 'function',
        'without an oneditsave the legacy markers survive every edit');

    // oneditsave runs BEFORE the pane copies the inputs, so it reads the
    // pending value from the DOM; `this` still holds the pre-edit properties.
    const cases = [
        // [pending type, pending value, must clear?]
        ['json', '{"cmd":"io.write","id":7,"data":["DSin"]}', true, 'a complete request'],
        ['msg', 'request', true, 'a dynamic source'],
        ['json', '["DSin"]', false, 'the untouched 1.0.x fragment (inspect-only Done)'],
        ['json', '{"cmd":"io.write","id":7', false, 'a JSON typo'],
        ['json', '{"cmd":"io.write"}', false, 'an incomplete request']
    ];
    for (const [type, value, mustClear, label] of cases) {
        const cleared = extractEditorNode('api-request.html', 'api-request', dialogWithData(type, value));
        const dialog = { cmd: 'io.write', interval: 500, data: '["DSin"]' };
        cleared.oneditsave.call(dialog);
        assert.equal(dialog.cmd === '' && dialog.interval === '', mustClear,
            `saving over ${label} must ${mustClear ? '' : 'NOT '}clear the legacy markers`);
    }
});

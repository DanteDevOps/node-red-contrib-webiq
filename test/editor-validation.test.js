// The editor validate() functions are plain JS inside the HTML files; extract
// and EXECUTE them so their contract is pinned like any other code. They exist
// to mirror the runtime's validation - every divergence found in review was in
// exactly this mirror.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

function extractEditorDefaults(htmlFile, typeName) {
    const html = fs.readFileSync(path.join(__dirname, '..', htmlFile), 'utf8');
    const match = html.match(
        new RegExp("RED\\.nodes\\.registerType\\('" + typeName + "', \\{[\\s\\S]*?\\n    \\}\\);")
    );
    assert.ok(match, `registerType block for ${typeName} not found`);

    let captured;
    const RED = { nodes: { registerType: (_n, def) => { captured = def; } } };
    // Minimal jQuery stand-in for oneditprepare references at definition time.
    const $ = () => ({ val: () => '', on: () => {}, prop: () => {}, is: () => false, toggle: () => {} });
    // eslint-disable-next-line no-eval
    eval(match[0]);
    void $;
    return captured.defaults;
}

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
        ['loginAttempts', '21', false]
    ];

    for (const [field, value, expect] of cases) {
        assert.equal(
            d[field].validate(value),
            expect,
            `${field} validate(${JSON.stringify(value)}) must be ${expect}`
        );
    }
});

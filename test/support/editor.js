// Extracts and EXECUTES the registerType() block of an editor HTML file, so
// tests pin the real declared defaults, validators and edit hooks - not a
// hand-copied list that keeps passing after the file changes (that exact
// decoupling is how the migration-bricking bug went unseen).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// `jq` stands in for jQuery inside the evaluated block. Tests exercising an
// edit hook that reads the dialog (oneditsave reads the PENDING typedInput
// value from the DOM) pass their own to control what the "dialog" holds.
function extractEditorNode(htmlFile, typeName, jq) {
    const html = fs.readFileSync(path.join(__dirname, '..', '..', htmlFile), 'utf8');
    // The two editor files close the block at different indents: the connect
    // node at four spaces, the request node at column zero.
    const match = html.match(
        new RegExp("RED\\.nodes\\.registerType\\('" + typeName + "', \\{[\\s\\S]*?\\n(?:    )?\\}\\);")
    );
    assert.ok(match, `registerType block for ${typeName} not found in ${htmlFile}`);

    let captured;
    const RED = { nodes: { registerType: (_n, def) => { captured = def; } } };
    const $ = jq || (() => ({
        val: () => '',
        on: () => {},
        prop: () => {},
        is: () => false,
        toggle: () => {},
        typedInput: () => ''
    }));
    // eslint-disable-next-line no-eval
    eval(match[0]);
    void RED;
    void $;
    assert.ok(captured, `registerType for ${typeName} did not run`);
    return captured;
}

function extractEditorDefaults(htmlFile, typeName) {
    return extractEditorNode(htmlFile, typeName).defaults;
}

// The dialog stub the api-request oneditsave reads: a typedInput holding the
// given pending type and value, inert everywhere else.
function dialogWithData(pendingType, pendingValue) {
    return () => ({
        val: () => '',
        on: () => {},
        prop: () => {},
        is: () => false,
        toggle: () => {},
        typedInput: (what) => (what === 'type' ? pendingType : pendingValue)
    });
}

module.exports = { extractEditorNode, extractEditorDefaults, dialogWithData };

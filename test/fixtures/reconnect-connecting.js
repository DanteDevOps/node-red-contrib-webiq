// Fixture for the terminate-on-CONNECTING crash. Run as a subprocess: if the
// supersede path leaves the stale socket without an 'error' listener, ws emits
// an unhandled 'error' on the next tick and this process dies non-zero.
const net = require('node:net');
const path = require('node:path');
const { createRuntime } = require(path.join(__dirname, '..', 'support', 'harness'));
const reg = require(path.join(__dirname, '..', '..', 'webiq-api-connect.js'));

// Accepts TCP and never answers the HTTP upgrade: the WebSocket sits in
// CONNECTING until the 10s handshake timeout.
const server = net.createServer(() => {});
server.listen(0, '127.0.0.1', () => {
    const rt = createRuntime(reg);
    const node = rt.create('webiq-api-connect', {
        host: '127.0.0.1',
        port: String(server.address().port),
        project: 'p',
        loginTimeout: 5,
        heartbeat: 0,
        credentials: { username: 'u', password: 'p' }
    });

    setTimeout(() => {
        // The documented recovery action, sent while the socket is CONNECTING.
        node.emit('input', { webiq: 'reconnect' }, undefined, () => {});
        // Give the next-tick 'error' emission ample time to kill us if unhandled.
        setTimeout(() => { process.exit(0); }, 800);
    }, 150);
});

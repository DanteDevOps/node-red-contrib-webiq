const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { WebSocketServer } = require('ws');

const registerWebIQConnect = require('../webiq-api-connect');
const { createRuntime, stopConnectionNode, waitFor } = require('./support/harness');

// Generate a throwaway self-signed certificate. Skipped rather than failed if
// openssl is unavailable, so the suite still runs on a bare machine.
function makeSelfSignedCert() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webiq-tls-'));
    const keyPath = path.join(dir, 'key.pem');
    const certPath = path.join(dir, 'cert.pem');

    execFileSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', keyPath, '-out', certPath,
        '-days', '1', '-subj', '/CN=localhost',
        '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'
    ], { stdio: 'ignore' });

    return {
        dir,
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath)
    };
}

// Clean up the generated certificate directory when the process exits, so a
// test run does not leave temp dirs behind.
let certDir = null;
process.on('exit', () => {
    if (certDir) { try { fs.rmSync(certDir, { recursive: true, force: true }); } catch (_) {} }
});

let certs = null;
let skipReason = null;
try {
    certs = makeSelfSignedCert();
    certDir = certs.dir;
} catch (err) {
    skipReason = `openssl unavailable: ${err.message}`;
}

// In strict mode a missing prerequisite is a failure, not a skip. Without this a
// release run can go green having exercised no TLS behaviour at all.
if (skipReason && process.env.WEBIQ_STRICT_TESTS === '1') {
    throw new Error(`WEBIQ_STRICT_TESTS=1 but TLS tests cannot run: ${skipReason}`);
}

// node:test treats the mere presence of a `skip` property as intent to skip, even
// when its value is null - so the option object has to be absent, not falsy.
const testOpts = skipReason ? { skip: skipReason } : {};

async function createSecureWebIQServer(certs) {
    const httpsServer = https.createServer({ key: certs.key, cert: certs.cert });
    const wss = new WebSocketServer({ server: httpsServer });
    const requests = [];

    wss.on('connection', (socket) => {
        socket.on('message', (raw) => {
            const request = JSON.parse(raw.toString());
            requests.push(request);
            if (request.cmd === 'user.login') {
                socket.send(JSON.stringify({
                    cmd: 'user.login',
                    id: request.id,
                    data: { loggedIn: true }
                }));
            }
        });
    });

    httpsServer.listen(0);
    await once(httpsServer, 'listening');

    return {
        port: httpsServer.address().port,
        requests,
        async close() {
            for (const client of wss.clients) { client.terminate(); }
            await new Promise((resolve) => wss.close(resolve));
            await new Promise((resolve) => httpsServer.close(resolve));
        }
    };
}

// Stands in for Node-RED's tls-config node: same contract, addTLSOptions(opts).
function fakeTlsConfigNode(options) {
    return {
        addTLSOptions(opts) {
            Object.assign(opts, options);
            return opts;
        }
    };
}

test('connects over wss:// using options from a tls-config node', testOpts, async (t) => {
    const server = await createSecureWebIQServer(certs);
    t.after(() => server.close());

    const runtime = createRuntime((RED) => {
        RED.nodes.getNode = () => fakeTlsConfigNode({
            ca: certs.cert,
            rejectUnauthorized: true,
            servername: 'localhost'
        });
        registerWebIQConnect(RED);
    });

    const node = runtime.create('webiq-api-connect', {
        host: 'localhost',
        port: String(server.port),
        project: 'test-project',
        credentials: { username: 'test-user', password: 'test-password' },
        loginTimeout: 5,
        heartbeat: 0,
        tls: 'tls-config-1'
    });
    t.after(() => stopConnectionNode(node));

    await waitFor(
        () => node.statuses.some((status) => status.text === 'authenticated'),
        'authenticated over TLS'
    );

    assert.equal(server.requests[0].cmd, 'user.login');
    assert.equal(server.requests[0].data.username, 'test-user');
});

test('a rejected server certificate fails instead of silently downgrading', testOpts, async (t) => {
    const server = await createSecureWebIQServer(certs);
    t.after(() => server.close());

    const runtime = createRuntime((RED) => {
        // No CA supplied and verification on: the self-signed cert must be refused.
        RED.nodes.getNode = () => fakeTlsConfigNode({ rejectUnauthorized: true });
        registerWebIQConnect(RED);
    });

    const node = runtime.create('webiq-api-connect', {
        host: 'localhost',
        port: String(server.port),
        project: 'test-project',
        credentials: { username: 'u', password: 'p' },
        loginTimeout: 5,
        heartbeat: 0,
        tls: 'tls-config-1'
    });
    t.after(() => stopConnectionNode(node));

    await waitFor(
        () => node.warnings.some((w) => /self.signed|unable to verify|certificate/i.test(String(w))) ||
              node.errors.some((e) => /certificate/i.test(String(e.error))),
        'certificate rejection'
    );

    assert.equal(
        node.statuses.some((status) => status.text === 'authenticated'),
        false,
        'must never authenticate against an unverified certificate'
    );
    assert.equal(server.requests.length, 0, 'no credential may reach an unverified server');
});

// Deliberately not gated on openssl: this one needs no certificate, and folding it
// into the skip made the whole file vanish when openssl was missing.
test('without TLS the scheme stays ws://', async (t) => {
    const runtime = createRuntime(registerWebIQConnect);
    const node = runtime.create('webiq-api-connect', {
        host: '127.0.0.1',
        port: '1',
        project: 'p',
        loginTimeout: 5,
        heartbeat: 0
    });
    t.after(() => stopConnectionNode(node));

    // No socket can be established on port 1; we only care that nothing threw and
    // the node did not silently claim to be secure.
    assert.equal(node.statuses.some((s) => s.text === 'authenticated'), false);
});

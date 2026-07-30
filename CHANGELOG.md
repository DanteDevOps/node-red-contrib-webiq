# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [2.0.0] - 2026-07-30

### Added — WebIQ API Connect Node
- **Connection heartbeat (the headline feature).** A new **Heartbeat** field (seconds, default `30`, `0` disables) sends a WebSocket ping once the connection is authenticated, and terminates the link after two consecutive intervals with no pong *and* no other inbound traffic. Any traffic counts as evidence of life, so a server that streams data but ignores pings is never treated as dead.

  This closes the gap that made the rest of the reconnect machinery unreachable. A link that dies without a TCP close — a frozen server VM, a dropped NAT conntrack entry, a switch reboot, the *typical* plant-network failure — leaves `readyState` at `OPEN` indefinitely. The socket's `close` event never fires, and that event is the only route into `scheduleReconnect()`. Measured against a peer frozen mid-session: before, the node never noticed, never reconnected, and sat on a green `authenticated` badge forever; now it detects the stale link, terminates it and reconnects. Note that writes issued *during* the detection window still go into the dead socket — that is unavoidable, and is why the interval is worth tuning to your network.
- **TLS / `wss://` support.** A **Secure** checkbox switches the scheme, and an optional **TLS config** field accepts a standard Node-RED `tls-config` node for custom CAs, client certificates and passphrases. Certificate verification is owned entirely by that node's own *Verify server certificate* setting — this node never sets `rejectUnauthorized` itself, so enabling TLS cannot silently degrade into an unverified connection. Until now the scheme was hardcoded to `ws://`, so the login frame and every value read from or written to the PLC crossed the network in cleartext, and a WebIQ endpoint behind TLS simply could not be used.
- **Typed input on the API Request node.** The Data field gains a type selector: `json` (parsed once at deploy, as before) or `msg` / `flow` / `global` / `env`, evaluated per message so the request can change at runtime. Evaluation uses the callback form of `RED.util.evaluateNodeProperty`, since context stores may be asynchronous. Nodes created before this field have no `dataType` and are treated as `json`, so nothing changes for them.
- **Requests are validated before they are sent.** A payload missing `cmd`, `id` or `data` — or one that is not an object at all — now fails with an error naming exactly what is wrong and which node to fix, instead of being forwarded to the connection node for a generic rejection. For a static `json` payload the problem is reported on the canvas at deploy time.
- **Configurable login timeout**: The wait for the server's login reply was previously hardcoded to 5 seconds, which is too short for WebIQ projects backed by a slow PLC — those connections would time out and enter a pointless reconnect loop even though the server was about to answer. The timeout is now exposed as a **Login timeout** field (in seconds) in the node's edit dialog. Any empty, non-numeric, or non-positive value falls back to 5 seconds.
- The login timeout error message now states the timeout that elapsed and names "timeout too short" as a possible cause, instead of only blaming an invalid project or unreachable server.

### Changed
- Node help text rewritten: documents every setting, and no longer describes the connect node as a "config node" — it is an ordinary flow node wired to **API Request** nodes, not referenced as a Node-RED configuration node.
- Removed a leftover `WEBIQ API CONNECT loaded (LOCAL DEV)` log line that was emitted to the Node-RED log on every deploy.
- **Platform baseline raised**: now requires Node-RED `>=4.0.0` and Node.js `>=20`, up from Node-RED `>=3.0.0` / Node.js `>=18`. Node-RED 4 and 5 are both supported; Node.js 18 reached end of life in April 2025.

### Fixed
- **Packaged example flow was broken and undiscoverable.** `Example/simple_example.json` still used the pre-1.1.1 `api-request` schema (separate `cmd` and `interval` properties), so importing it produced `Payload is missing required fields: cmd, id, data`. The directory has been renamed to lowercase `examples/`, which is the only name Node-RED scans for the editor's Import → Examples menu — the old flow had never been reachable from the palette at all. The replacement uses the current single-payload schema, ships with the connection node disabled, and carries no credentials or real project identifier.

### Breaking
- **Credentials moved into Node-RED's credential store.** `username` and `password` were ordinary node properties, which meant every WebIQ password sat in cleartext in `flows.json`, travelled in every flow export, and was readable through the admin API. They are now declared as `credentials`, so Node-RED stores them separately and strips them from exports.

  **There is deliberately no fallback to the old values.** Every connection node stops connecting after the upgrade, reports `credentials need re-entry`, and works again once you open it, type the username and password in, and redeploy. A fallback was implemented and then removed on review: Node-RED serializes only the properties a node declares, and the old ones are no longer declared, so *any* full deploy silently discards them. A node that worked immediately after upgrading and then lost its credentials on an unrelated deploy days later would be far harder to diagnose than one that fails at once and says why. **Record your credentials before upgrading.** Any password previously exported, committed or backed up should be rotated, because it has been readable in plaintext for its whole life.
- **Input handlers now use the `(msg, send, done)` signature.** Failures are reported through `done(err)` instead of a bare `node.error(text)`. This is what makes **Catch** nodes fire — previously no Catch node anywhere could ever trap a failure from these nodes, and the message was dropped silently. Flows that relied on failures being invisible will now see them surface.

### Fixed — connection lifecycle
- **A stale or unsolicited `user.login` frame could flip authentication state.** Any inbound frame with `cmd: "user.login"` was applied to the node's auth state, so a reply from a socket that had already been superseded — or a `user.login` a user sent themselves through an API Request node — could knock an authenticated node into a retry loop, after which every send failed with `Cannot send: not authenticated yet`. Login replies are now correlated against an outstanding request on the *active* connection, and ignored otherwise. The frame is still forwarded downstream, so nothing is hidden.
- **Timers are now owned by the connection they belong to.** Every socket gets a connection context holding its own state and timers, and every callback verifies it still owns the active context before acting. A login retry armed against a dead socket used to survive a full reconnect cycle and fire against its replacement, sending a duplicate login and silently re-arming the timeout guard.
- **Reconnect backoff never actually backed off.** The delay was reset on the transport `open` event, before authentication, so anything failing *after* the socket opened reconnected at a flat interval forever rather than climbing the documented 1s→30s ladder. Backoff now resets only after a connection has stayed authenticated for 30 seconds. Measured against a server that accepts but never answers a login, the retry interval went from a flat `6006, 6007, 6004 ms` to `1221, 1802, 4773, 6753 ms`.
- **±20% jitter added to the reconnect delay**, so many gateways do not stampede a WebIQ server the moment it comes back.
- **A `404` login reply wedged the node permanently.** It returned early leaving a live, unauthenticated socket with no timer armed and no path back — the only route to `scheduleReconnect()` is the socket's `close` event, which could not fire. It now reports, forwards the frame, closes the socket and retries on a slow 30 second ladder.
- **Login retries no longer hammer a rejected credential.** A bad password retried every 5 seconds forever (~17,000 attempts a day, one log line each) and could trip server-side account lockout. Retries now back off from 5s to 60s and warn once per failure run rather than once per attempt.
- **A WebSocket that fails to construct now schedules a reconnect** instead of leaving the node dead until the next deploy.
- **HTTP upgrade rejections are distinguished from WebIQ JSON errors.** A non-101 response to the upgrade means the server never accepted the WebSocket at all, and now reports as `server rejected upgrade (HTTP nnn)` rather than being conflated with an application-level error carrying the same code.
- **Redeploy now waits for the socket to close.** `node.on('close')` took no arguments, so Node-RED did not await teardown and started the replacement node while the old socket was still open. It now takes `(removed, done)`, detaches its own listeners by name rather than calling `removeAllListeners()`, and falls back to `terminate()` after 2 seconds so a frozen peer cannot exceed Node-RED's shutdown limit.

### Fixed — configuration and endpoint handling
- **An invalid configuration used to black-hole every message.** The constructor returned before registering an input listener, so a node with a bad host or empty project consumed messages and produced no output, no error, no Catch event and no `done()` — the message simply vanished. Handlers are now registered unconditionally and a misconfigured node fails each message through `done(err)`; only the connection itself is skipped.
- **Endpoint validation added.** The port is checked as an integer in 1–65535 (previously an empty port silently dialled port 80 and blamed the project field); the project is rejected if it contains a path separator, `?`, `#` or `\`, and is URL-encoded rather than interpolated raw; a bare IPv6 literal is bracketed so the authority is unambiguous.
- **An empty Heartbeat field no longer disables the heartbeat.** `Number('')` is `0`, which the validity check treated as an explicit "disabled", so clearing the field silently switched off the protection rather than restoring the 30s default. An empty field now falls back to the default; only an explicit `0` disables it.
- **Credentials are resolved as a pair.** The username and password were read independently, so a half-migrated node could combine a username from the credential store with a password from the flow file and fail to authenticate for no discoverable reason.

### Fixed — fail-closed security behaviour
- **A TLS configuration that could not be resolved fell back to plaintext.** If the node referenced a `tls-config` node that no longer existed and the **Secure** checkbox was not also ticked, it warned and then connected over `ws://` — sending the credentials in cleartext at exactly the moment the user had asked for encryption. Reproduced against a plaintext server, which received the password and completed a login. Selecting a TLS configuration now always implies `wss://`, and an unresolvable reference is a configuration error that refuses to connect.
- **Inbound `ping` frames now count as liveness.** Only `message` and `pong` reset the heartbeat, so a peer that actively pings this node but does not answer its pings was terminated as stale — contradicting the documented "any inbound traffic counts" behaviour.
- **The backpressure warning now clears.** Once `send buffer full` was reported the node stayed yellow forever, even after later sends succeeded. The guard also ignored the size of the frame about to be queued, so a single large request could sail past the limit it was meant to be caught by.
- **Transient HTTP upgrade failures are no longer treated as misconfiguration.** Every upgrade status was classified as permanent, so `429` and the 5xx family waited on the slow 30 second ladder and were reported as "check the project name". Only `400`, `401`, `403`, `404` and `410` are permanent now; **every 5xx is transient**, including `501`, which describes the server rather than this configuration.
- **The credential guard no longer depends on the properties it is protecting against.** The first version of the fail-closed check only refused to connect while the legacy `username`/`password` were still present on the node — that is, only until the first full deploy stripped them. After that, a node with no credentials in either place opened a socket and sent `{"cmd":"user.login","id":0,"data":{"realm":null}}`, an empty login, and authenticated against a permissive server. The check now tests the credential pair itself, so a node without a username and password never connects, and reports `credentials missing`.
- **A TLS reference that resolves to the wrong node type is now refused.** `addTLSOptions` was treated as optional, so a reference to something that is not a `tls-config` node connected over `wss://` while silently discarding the CA or client certificate that was the entire reason for selecting it.
- **Backpressure recovery is scoped to its own connection.** The degraded flag was node-wide and its clearing callback did not verify socket ownership, so a delayed send callback from a superseded socket could clear the `send buffer full` warning belonging to the connection that replaced it.

### Fixed — resource limits and shutdown
- **Connection resource controls added.** The socket is created with a 10s `handshakeTimeout`, so a peer that accepts TCP without completing the upgrade no longer leaves the node hanging indefinitely, and a 4 MiB `maxPayload` in place of ws's 100 MiB default. Outbound sends are refused once `bufferedAmount` exceeds 1 MiB rather than queuing without limit against a peer that has stopped reading.
- **An HTTP upgrade rejection now uses the slow retry ladder.** Only a WebIQ JSON `project-not-found` reply got the 30 second delay; an HTTP 404 from a server or proxy during the upgrade fell through to the fast exponential ladder and hammered a route that could not start working on its own.
- **A socket error during shutdown could defeat forced closure.** The teardown path finished directly from the `error` event, clearing the force timer before `close` was confirmed, so Node-RED could consider teardown complete while the socket was still alive. It now terminates the socket first.

### Fixed — API Request node
- **The configured JSON is parsed once at construction** rather than on every message, and the parsed template is cloned per message so a downstream node mutating `msg.payload` cannot corrupt it for subsequent messages.
- **Invalid JSON is now reported at deploy time** with a red status, and messages fail through `done(err)` instead of the node warning and then sending an empty object onward anyway — which produced two log lines per message and a payload the connection node was guaranteed to reject.
- The editor template no longer inlines a second copy of the default JSON that had already drifted out of step with the real default.

### Security
- **Login timeout values are clamped to 24 hours.** `setTimeout` stores its delay in a 32-bit signed integer, so anything above 2,147,483 seconds silently became **1 millisecond** — a user entering a large number to mean "wait a long time" got a guard that fired instantly instead. Oversized values are now clamped, warned about, and rejected by the editor.
- **`ws` minimum raised to `^8.21.0`**: the previous `^8.0.0` floor permitted versions affected by a high-severity advisory — [GHSA-58qx-3vcg-4xpx](https://github.com/advisories/GHSA-58qx-3vcg-4xpx) (uninitialized memory disclosure) and [GHSA-96hv-2xvq-fx4p](https://github.com/advisories/GHSA-96hv-2xvq-fx4p) (memory exhaustion DoS). Both cover `8.0.0`–`8.20.1`, so `8.21.0` is the first patched release; `8.20.2` was never published to npm.

### Repository housekeeping
- Added a root `.gitignore` and untracked `node_modules/` and `.idea/`, which had been committed since the initial upload. `.npmignore` had excluded them from the published package, but it has no effect on git.
- Added `.gitattributes` normalising line endings to LF in the repository. The repository held a mix of CRLF and LF blobs, which made `git diff --check` report trailing whitespace on every edited line.
- Added the `LICENSE` file. `package.json` had declared `"license": "MIT"` since the first release with no licence text in the repository or the published tarball.
- `package-lock.json` version resynced with `package.json`; it had been left at 1.1.3 through the 1.1.4 release.
- **`npm test` now runs the full suite**, and a new **`npm run test:release`** gate refuses to pass when any suite is skipped for a missing prerequisite. Previously the release-gap tests sat behind a separate script, and the TLS and real-runtime suites skipped silently when OpenSSL or a Node-RED install was absent — so a green run could mean no TLS behaviour had been exercised at all. Verified: 29 tests, 0 skipped, against real Node-RED 5.
- **The tests now supply credentials the way Node-RED does**, through the credential store rather than as flow properties, and the real-runtime test server authenticates only the exact expected username and password. Previously it accepted any login, so the one test that exists to prove credentials reach production code could have passed while they did not.
- **`npm pack` no longer nests a previous tarball inside the release.** `*.tgz` was in `.gitignore` but not `.npmignore`, and npm ignores `.gitignore` entirely whenever an `.npmignore` file exists.
- **The README no longer ships a flow containing plaintext credentials.** It pointed users at an inline example carrying `username`/`password` as flat properties, recreating exactly the pattern this release removes. It now points at the packaged example and documents the 1.x migration.

- **The README now carries an upgrade guide and a troubleshooting table**, covering the credential migration step by step, the Catch-node behaviour change, and what every status badge and error message means.

---

## [1.1.4] - 2026-03-20

### Fixed — WebIQ API Connect Node
- **Docker container names / IDs now accepted as host**: The host validation was rejecting valid Docker container names (e.g. `webiq_server`), container IDs (e.g. `e8b193a88e3e`), and DNS hostnames on Node.js 18–20 because the WHATWG `URL` parser treats underscores and short hex IDs as invalid hostnames. Validation has been simplified to a non-empty check; truly malformed hosts are still caught at WebSocket creation time.

---

## [1.1.1] - 2026-03-04

### Added — WebIQ API Connect Node
- **Auto-reconnect with exponential backoff**: The connect node now automatically reconnects after a lost connection. The reconnect delay starts at 1 second and doubles on each failed attempt, capping at 30 seconds.
- **Granular connection status outputs**: Node status now reports distinct states to make it immediately clear what is happening at every stage of the connection lifecycle:
  - `disconnected` — No active WebSocket connection.
  - `connected – login pending` — WebSocket is open, waiting for authentication response.
  - `connected – login failed` — Credentials rejected; retrying login every 5 seconds.
  - `login timeout / project not found` — Server did not reply to login within 5 seconds; project UUID may be wrong or the WebIQ project is not running.
  - `project not found` — Server replied with HTTP 404; project name/UUID is invalid.
  - `project not found / connection failed` — Connection closed before a login was attempted; server may be unreachable.
  - `authenticated` — Successfully logged in and ready to send commands.
- **Login timeout guard**: If no login response is received within 5 seconds of connecting, the node reports a clear error and closes the socket to trigger a clean reconnect cycle.
- **Invalid host detection**: Node now validates the host field on startup and reports `invalid host` immediately if the host field is empty, instead of failing silently. *(Note: initial implementation restricted to IPv4/localhost only — expanded in next release to support DNS hostnames.)*
- **Missing project guard**: Node now reports `project missing` immediately on deploy if the project UUID field is empty.

### Changed — WebIQ API Connect Node
- Connection state is now tracked with a dedicated `closing` flag to prevent ghost reconnect loops after the node is stopped or redeployed.
- All timers (`reconnectTimer`, `loginRetryTimer`, `loginTimeout`) are now properly cleared on node close to avoid memory leaks.

---

### Changed — API Request Node
- **Simplified configuration**: Removed the previous three-field form (`cmd`, `id`, `data` as separate inputs). Configuration is now a single raw JSON editor field, giving full control over the request payload without the UI abstracting it away.
- **Default `io.read` example**: When a new API Request node is placed on the canvas, the JSON field is pre-populated with a working `io.read` example to help new users get started immediately.

### Fixed — API Request Node
- **Critical: duplicate node ID bug**: Fixed the root cause that prevented the API Request node from being copied or placed multiple times in a flow. Each new instance was sharing the same internal ID, causing copied nodes to interfere with each other. Nodes can now be freely duplicated and deployed without any manual ID editing workaround.

---

## [1.0.7] - 2023

### Notes
- Initial public release published to [npmjs](https://www.npmjs.com/package/node-red-contrib-webiq).
- Basic WebSocket connect node and API request node.
- Listed on the [Node-RED Flow Library](https://flows.nodered.org/node/node-red-contrib-webiq).

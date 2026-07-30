# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [2.0.0] - unreleased

> **Work in progress.** This entry is being filled in as the release is built.

### Added — WebIQ API Connect Node
- **Connection heartbeat (the headline feature).** A new **Heartbeat** field (seconds, default `30`, `0` disables) sends a WebSocket ping once the connection is authenticated, and terminates the link after two consecutive intervals with no pong *and* no other inbound traffic. Any traffic counts as evidence of life, so a server that streams data but ignores pings is never treated as dead.

  This closes the gap that made the rest of the reconnect machinery unreachable. A link that dies without a TCP close — a frozen server VM, a dropped NAT conntrack entry, a switch reboot, the *typical* plant-network failure — leaves `readyState` at `OPEN` indefinitely. The socket's `close` event never fires, and that event is the only route into `scheduleReconnect()`. Measured against a peer frozen mid-session: before, the node never noticed, never reconnected, and sat on a green `authenticated` badge forever; now it detects the stale link, terminates it and reconnects. Note that writes issued *during* the detection window still go into the dead socket — that is unavoidable, and is why the interval is worth tuning to your network.
- **Configurable login timeout**: The wait for the server's login reply was previously hardcoded to 5 seconds, which is too short for WebIQ projects backed by a slow PLC — those connections would time out and enter a pointless reconnect loop even though the server was about to answer. The timeout is now exposed as a **Login timeout** field (in seconds) in the node's edit dialog. Any empty, non-numeric, or non-positive value falls back to 5 seconds.
- The login timeout error message now states the timeout that elapsed and names "timeout too short" as a possible cause, instead of only blaming an invalid project or unreachable server.

### Changed
- Node help text rewritten: documents every setting, and no longer describes the connect node as a "config node" — it is an ordinary flow node wired to **API Request** nodes, not referenced as a Node-RED configuration node.
- Removed a leftover `WEBIQ API CONNECT loaded (LOCAL DEV)` log line that was emitted to the Node-RED log on every deploy.
- **Platform baseline raised**: now requires Node-RED `>=4.0.0` and Node.js `>=20`, up from Node-RED `>=3.0.0` / Node.js `>=18`. Node-RED 4 and 5 are both supported; Node.js 18 reached end of life in April 2025.

### Fixed
- **Packaged example flow was broken and undiscoverable.** `Example/simple_example.json` still used the pre-1.1.1 `api-request` schema (separate `cmd` and `interval` properties), so importing it produced `Payload is missing required fields: cmd, id, data`. The directory has been renamed to lowercase `examples/`, which is the only name Node-RED scans for the editor's Import → Examples menu — the old flow had never been reachable from the palette at all. The replacement uses the current single-payload schema, ships with the connection node disabled, and carries no credentials or real project identifier.

### Breaking
- **Credentials moved into Node-RED's credential store.** `username` and `password` were ordinary node properties, which meant every WebIQ password sat in cleartext in `flows.json`, travelled in every flow export, and was readable through the admin API. They are now declared as `credentials`, so Node-RED stores them separately and strips them from exports. **A node created before 2.0 keeps working** — the runtime falls back to the old properties and warns on deploy — **but the values remain in cleartext in your flow file until you reopen each connection node, re-enter both fields and redeploy.** Any password previously exported, committed or backed up should be rotated, because it has been readable in plaintext for its whole life.
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

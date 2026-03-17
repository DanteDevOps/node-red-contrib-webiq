# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Fixed — WebIQ API Connect Node
- **DNS hostname support**: The host validation check previously only accepted IPv4 addresses and `localhost`, silently rejecting valid DNS hostnames (e.g. `myserver.local`, `webiq.company.com`). The check has been simplified so that any non-empty host value is accepted, allowing DNS names to be used alongside IP addresses.

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

# node-red-contrib-webiq

This package is an independent WebIQ Node-RED integration focused on connection
reliability: detecting links that die without notice, recovering from them, and
never silently losing a request along the way.

## Features

- **WebIQ API Connect Node** — holds the WebSocket connection to a WebIQ server:
  logs in, reconnects with exponential backoff and jitter, and detects a link that
  has died *without* a TCP close via a ping/pong heartbeat. Supports `wss://` with a
  standard Node-RED `tls-config` node, keeps credentials in Node-RED's credential
  store rather than the flow file, and stops rather than retrying a rejected login
  into a server-side account lockout.
- **API Request Node** — builds the request sent to the server. The whole request is
  one JSON object (`cmd`, `id`, `data`), written inline or taken at runtime from
  `msg` / `flow` / `global` / `env`.
- **Errors surface.** Failures reach **Catch** nodes, including requests the *server*
  rejects — an `io.write` refused for an unknown tag or insufficient rights no longer
  looks identical to one that succeeded.

## Installation

To install the nodes, use the following command in your Node-RED user directory (typically `~/.node-red`):

```bash
npm install node-red-contrib-webiq
```

## Usage

### WebIQ API Connect Node

1. Drag the **WebIQ API Connect** node into your Node-RED workspace.
2. Configure the node properties:
   - **Name**: A name for the node instance.
   - **Host**: The WebIQ server host — hostname, IP address, Docker container name, or a bracketed IPv6 literal.
   - **Port**: The WebIQ server port (1–65535).
   - **Project**: The WebIQ project name or UUID.
   - **Secure**: Connect with `wss://` instead of `ws://`. Without it the login and all PLC data cross the network in cleartext.
   - **TLS config**: Optional. Points at a standard Node-RED `tls-config` node for custom CAs, client certificates or a passphrase. Selecting one implies **Secure**. Certificate verification is controlled by that node's own *Verify server certificate* setting — this node never overrides it.
   - **Username** / **Password**: Your WebIQ project credentials. Stored in Node-RED's credential store, not in `flows.json`, and stripped from flow exports.
   - **Login timeout**: Seconds to wait for the server's login reply before reporting a timeout and reconnecting. Defaults to `5`, maximum `86400`. Raise this if the project is backed by a slow PLC — a login that takes longer than the timeout will otherwise loop without ever authenticating.
   - **Heartbeat**: Seconds between liveness probes once authenticated. Defaults to `30`; `0` disables; values between 0 and 1 are raised to 1 second. Without it, a connection that dies without a TCP close keeps reporting `authenticated` forever while every request disappears.
   - **Login attempts**: How many consecutive *rejected* logins (default `5`, range 1–20) before the node latches and stops trying — WebIQ counts attempts server-side and can lock the account. A lockout reply latches immediately. Logins that go *unanswered* never latch: after the same count the node falls back to one probe every 60 seconds and recovers on its own.
3. Deploy the changes.

### API Request Node

1. Drag the **API Request** node into your Node-RED workspace.
2. Set the **Data** field. The type selector chooses where the request comes from:
   - **json** — written inline, parsed once at deploy time.
   - **msg / flow / global / env** — read from that source for every message, so the request can change at runtime. A JSON string is parsed automatically.
3. Whatever the source, the value must contain `cmd`, `id` and `data`.
4. Wire its output into a **WebIQ API Connect** node and deploy.

## Example Flow

A ready-made example ships with the package. In the Node-RED editor open the menu
and choose **Import → Examples → node-red-contrib-webiq → simple example**.

It imports with the connection node **disabled** and no credentials filled in, so
nothing starts connecting until you have entered your own server details and
enabled the node.

> **Do not paste connection nodes with credentials into issues, documentation or
> chat.** From 2.0 the username and password are held in Node-RED's credential
> store and are stripped from flow exports — that only protects you if the
> credentials were entered in the editor rather than written into the flow JSON by
> hand.

## Upgrading from 1.x

**2.0 is a breaking release. Read this before upgrading a production system.**

### Prerequisites

| | 1.x | 2.0 |
| --- | --- | --- |
| Node-RED | >= 3.0 | **>= 4.0** (4 and 5 both supported) |
| Node.js | >= 18 | **>= 20** |

If your installation is older than that, `npm install` will refuse or Node-RED will
fail to load the nodes. Check with `node --version` and the Node-RED startup log
before upgrading. Node.js 20 is past end-of-life upstream; 22 or later is
recommended, and Node-RED 5 requires 22.9 regardless of this package.

### Step 1 — re-enter your credentials (required, do this first)

The username and password have moved out of the flow file into Node-RED's
credential store. **There is no fallback to the old values**, so every WebIQ API
Connect node stops connecting until you re-enter them. The node tells you so:

> WebIQ credentials must be re-entered after upgrading to 2.0...

and its status reads `credentials need re-entry`.

This is deliberate. An automatic fallback was considered and rejected: Node-RED
serializes only the properties a node declares, and the old `username`/`password`
are no longer declared — so **any full deploy silently discards them**. A node that
worked after upgrading and then lost its credentials on an unrelated deploy days
later would be far harder to diagnose than one that fails immediately.

Before upgrading:

1. **Write down the username and password for every connection node**, or export
   your flows and keep the export somewhere safe. Once the new version loads, the
   editor fields are blank and the old values are only recoverable from a backup.

After upgrading, for each **WebIQ API Connect** node:

2. Open it, type the username and password in again, click **Done**.
3. **Deploy.**
4. Confirm: export the flow (**menu → Export**) and check that no `"username"` or
   `"password"` appears in the JSON.

**Rotate any password that was previously exported, committed to version control, or
included in a backup.** It has been readable in plaintext for its entire life, and
moving it into the credential store does not undo that.

### Step 1b — API Request nodes from 1.0.x need rebuilding

Very old (1.0.x) **API Request** nodes stored `cmd`, `id`, `data` and `interval`
as separate fields. That layout was dropped in 1.1 and is not supported: such a
node shows `needs migration` and explains what to do. Open it and put the whole
request into the **Data** field as JSON:

```json
{ "cmd": "io.read", "id": 1, "data": ["DSin", "SInt"] }
```

The old `interval` field polled automatically and was in **milliseconds**. There is
no built-in polling — drive the node from an **Inject** node set to repeat. The node
tells you its own former interval when it reports `needs migration`, so a 500 ms poll
becomes an Inject repeating every 0.5 s.

Give each API Request node a **distinct, non-zero `id`**. Replies all arrive on
the connection node's single output, and `id: 0` is reserved for the
connection's own login — a node using it warns on deploy.

### Step 2 — expect Catch nodes to start firing (behaviour change)

In 1.x, failures from these nodes never reached a **Catch** node — the message was
dropped silently. They are now reported properly, so if you have a catch-all Catch
node, it may start receiving errors it has never seen before from flows you did not
change. Those errors were always happening; they were just invisible.

### Step 3 — optional but recommended

- **Turn on Secure** if your WebIQ server terminates TLS. 1.x could only speak
  `ws://`, so credentials crossed the network unencrypted.
- **Leave Heartbeat at 30 s.** If your server does not answer WebSocket pings *and*
  goes long periods sending nothing, set it to `0` and tell us — but note that
  disabling it restores the 1.x behaviour where a dead connection is undetectable.

## Troubleshooting

The node's status badge names the problem. The most common ones:

| Status / message | What it means | What to do |
| --- | --- | --- |
| `credentials need re-entry` | A 1.x node still has its credentials in the flow file. | Open the node, type the username and password in again, redeploy. See *Upgrading from 1.x*. |
| `credentials missing` | No username/password have been entered. | Open the node and enter them. The node will not send a login without credentials. |
| `TLS config unresolved` | A TLS configuration is selected but the config node is missing. | The node refuses to connect rather than silently falling back to unencrypted — re-select or recreate the `tls-config` node. |
| `TLS config invalid` | The selected configuration is not a `tls-config` node. | Its certificate settings could not be applied, so the node refuses rather than connecting without them. Re-select a real `tls-config` node. |
| `host missing` | The Host field is empty. | Fill it in. |
| `invalid connection settings` | The WebSocket could not be created from these settings at all. | Rare — the host/port combination is malformed in a way the earlier checks did not catch. The node retries every 30 s in case an environment variable or DNS entry fixes it. |
| `invalid host` | The Host contains URL syntax — userinfo (`@`), a scheme, a path, a query/fragment character, whitespace, or an embedded port. | Enter only the host name or IP; the port belongs in the Port field. Userinfo is rejected because `trusted.example@10.0.0.9` looks like one host but connects to another — and would send your credentials there. |
| `invalid port` | Port is not an integer in 1–65535. | In 1.x an empty port silently dialled port 80 and reported it as a project failure. Set the real port, usually `10123`. |
| `project missing` / `invalid project` | Project is empty, or contains `/`, `?`, `#` or `\`. | Use the project name or UUID only, not a URL or path. |
| `connected - login pending` (stuck) | The socket opened but the server has not answered the login. | Usually a slow PLC. Raise **Login timeout**. |
| `login timeout` | No login reply within the timeout. | Raise **Login timeout** — a slow PLC-backed project may need considerably longer. |
| `login unanswered - retrying every 60s` | **Login attempts** logins in a row went unanswered. | The server is probably down or still booting. The node keeps probing every 60 seconds and recovers on its own the moment the server answers — no action needed unless the server should be up. |
| `login failed (n/N)` | The server rejected the login; *n* of the configured **Login attempts** are used. | Read the warning in the log — it carries WebIQ's own wording, which distinguishes a wrong password from a licence limit or a lockout. Fix the cause before the budget runs out. |
| `login blocked - fix and redeploy` | The node has stopped trying: WebIQ reported a lockout, or **Login attempts** consecutive logins were rejected. | **Deliberate.** WebIQ counts login attempts and will lock the account — usually the same account your HMI clients use, so a typo here can take out operator screens. Fix the credentials and redeploy, or send `msg.webiq = "reconnect"` — it grants **one** fresh attempt, at most once per 60 s. |
| `server full - retrying in Ns` / `server full - retrying every 60s` | WebIQ replied `too many clients`: no free client/licence slot. **After a network drop this is usually your own previous session**, still held by the server until its dead-session detection reaps it. | Usually nothing — this never latches and never spends the login budget; the node keeps retrying gently and logs in by itself the moment the slot frees. To recover faster, delete the stale session in WebIQ's **Active Sessions** panel. |
| `reconnecting on request` | A `msg.webiq = "reconnect"` control message was accepted. | Transient; the normal connection states follow. |
| `connection refused` / `host not found` / `server unreachable` | Transport failure before any login was sent. | Check host, port, network path and firewall. Earlier versions reported all of these as `project not found`, which pointed at the wrong field. |
| `TLS certificate rejected` | The server certificate was not trusted. | Check the `tls-config` node's CA settings. |
| `subprotocol rejected` | The server did not accept `smarthmi-connect`. | Usually a reverse proxy stripping the `Sec-WebSocket-Protocol` header. |
| `server rejected upgrade (HTTP nnn)` | The server refused the WebSocket handshake. | **A wrong Project name is the most likely cause** — the project is part of the connection URL, so an unknown project is refused here, before any login. Shown for **400, 401, 403, 404, 410**; retries every 30 s. Also check host, port and any reverse proxy. |
| `server unavailable (HTTP nnn)` | The server or proxy is busy or broken, not misconfigured. | Everything else, including **429 and every 5xx**, retries on the normal fast ladder. Usually no action needed. |
| `link stale - reconnecting` | Two consecutive probes went unanswered, with no other traffic. | Normal after a network drop — it reconnects automatically. Persistent flapping means the server does not answer pings *and* sends nothing between probes; raise **Heartbeat** rather than disabling it. |
| `send buffer full` | The server has stopped reading and 1 MB is queued. | Requests are being dropped rather than buffered forever. Check server load. |
| `disconnected` | No connection; reconnecting with backoff (1 s doubling to 30 s). | Wait, or check the server. |

### After a network drop: `too many clients`

When the network between Node-RED and WebIQ fails uncleanly (pulled cable, Wi-Fi
drop), the server keeps the old, dead session alive until its own detection
reaps it — observed at roughly **15 minutes** on an X3web. Until then, your
reconnecting node bounces off the client limit with `too many clients`, because
the seat is held by its own ghost.

The node handles this on its own: capacity rejections never latch, and it keeps
retrying gently until the seat frees. If 15 minutes is too long:

- Delete the dead session manually in WebIQ **Setup → Active Sessions**.
- Raise the reap time with your WebIQ contact. ~15 minutes is suspiciously close
  to the Linux TCP retransmission timeout (`tcp_retries2 = 15` ≈ 15.4 min), which
  suggests the server notices dead clients only when TCP gives up, rather than
  via an application-level ping of its own.

Errors you may see on a message (all trappable with a **Catch** node):

| Error | Cause |
| --- | --- |
| `WebIQ node is not configured: ...` | The node has a configuration error. In 1.x this message vanished with no error at all. |
| `Cannot send: not authenticated yet` | The request arrived before login completed. |
| `WebSocket is not connected` | No live connection at that moment. |
| `Payload is missing required fields: cmd, id, data` | The payload reaching the connect node is not a WebIQ request. |
| `... is not a valid WebIQ request: missing "id"` | The API Request node's data — static or dynamic — is incomplete. |
| `Could not serialise payload: ...` | The payload contains a circular reference or a BigInt. |
| `WebIQ rejected <cmd>: [category errc n] ...` | The **server** refused the request — unknown tag, read-only item, insufficient rights. The reply is still forwarded on the output as well. |
| `WebIQ login is blocked: ...` | The node is latched; the message was refused. See `login blocked` above. |
| `WebIQ reconnect refused: ...` | A `msg.webiq = "reconnect"` arrived inside the 60 s cooldown. |
| `WebIQ reconnect control message: the payload was NOT sent...` | A reconnect control message also carried a payload; the payload was not sent — resend it after the node authenticates. |
| `WebIQ send buffer is backed up ...` | Backpressure: the request was dropped, not queued. |
| `Unusable WebIQ frame forwarded as raw data: ...` | A frame could not be parsed, or was nested deeper than 64 levels. It is forwarded as a raw buffer instead of an object, so `msg.payload` arrives as a `Buffer`. The depth limit exists because Node-RED clones messages recursively, and an over-deep frame would otherwise crash the runtime. |

If a request seems to vanish, check that the connection node reached
`authenticated` (green). Requests sent while it is any other colour are rejected
with an error rather than queued.

## Contributing

Contributions are welcome! Please fork the repository and submit a pull request.

## License

This project is licensed under the MIT License.

## Links

- [Node-RED Flow Library](https://flows.nodered.org/node/node-red-contrib-webiq)
- [GitHub Repository](https://github.com/DanteDevOps/node-red-contrib-webiq)


## Contact

For any questions or issues, please open an issue in the GitHub repository.

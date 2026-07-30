# node-red-contrib-webiq

This package is an independent WebIQ Node-RED integration focused on WebSocket reconnect stability and API request handling.

## Features

- **WebIQ API Connect Node**: Establishes a connection to the WebIQ server.
- **API Request Node**: Allows you to send commands to the WebIQ server by injecting `cmd`, `id`, and `data` fields.

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
   - **Heartbeat**: Seconds between liveness probes once authenticated. Defaults to `30`; `0` disables. Without it, a connection that dies without a TCP close keeps reporting `authenticated` forever while every request disappears.
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

Nothing stops working the moment you upgrade — but two things need your attention,
and one of them is a security action.

### 1. Move your credentials (required)

The username and password moved out of the flow file into Node-RED's credential
store. A node created before 2.0 keeps connecting, because the runtime falls back
to the old properties, but it warns on every deploy:

> WebIQ credentials are stored in the flow file in cleartext. Open this node,
> re-enter the username and password, and redeploy...

To finish the move, for **each** WebIQ API Connect node:

1. Open the node. **Write down the username and password before changing anything** —
   the fields may appear blank, because the credential store has nothing in it yet
   while the real values are still in the flow file.
2. Type the username and password in again.
3. Click **Done**, then **Deploy**.
4. Confirm it worked: export the flow (**menu → Export**) and check that no
   `"username"` or `"password"` appears in the JSON.

> **Do this before making unrelated edits to a connection node.** Once you open and
> save a node, the old plaintext properties are dropped. If you save without
> re-entering the credentials, the node has no credentials in either place and will
> fail to log in — fixable by typing them in again, but confusing if it catches you
> mid-deploy.

**Rotate any password that was previously exported, committed to version control, or
included in a backup.** It has been readable in plaintext for its entire life, and
moving it into the credential store does not undo that.

### 2. Catch nodes now fire (behaviour change)

In 1.x, failures from these nodes never reached a **Catch** node — the message was
dropped silently. They are now reported properly, so if you have a catch-all Catch
node, it may start receiving errors it has never seen before from flows you did not
change. Those errors were always happening; they were just invisible.

### 3. Optional but recommended

- **Turn on Secure** if your WebIQ server terminates TLS. 1.x could only speak
  `ws://`, so credentials crossed the network unencrypted.
- **Leave Heartbeat at 30 s.** If your server does not answer WebSocket pings *and*
  goes long periods sending nothing, set it to `0` and tell us — but note that
  disabling it restores the 1.x behaviour where a dead connection is undetectable.

## Troubleshooting

The node's status badge names the problem. The most common ones:

| Status / message | What it means | What to do |
| --- | --- | --- |
| `host missing` | The Host field is empty. | Fill it in. |
| `invalid port` | Port is not an integer in 1–65535. | In 1.x an empty port silently dialled port 80 and reported it as a project failure. Set the real port, usually `10123`. |
| `project missing` / `invalid project` | Project is empty, or contains `/`, `?`, `#` or `\`. | Use the project name or UUID only, not a URL or path. |
| `connected - login pending` (stuck) | The socket opened but the server has not answered the login. | Usually a slow PLC. Raise **Login timeout**. |
| `login timeout / project not found` | No login reply within the timeout. | Raise **Login timeout**; if it persists, check the project name and that the project is actually running. |
| `connected - login failed` | The server rejected the credentials. | Check username and password. Retries back off to 60 s, so you will not lock the account out — but nothing will work until they are right. |
| `project not found` | The server replied with a 404. | The project name or UUID is wrong, or the project is not loaded yet. Retries every 30 s. |
| `server rejected upgrade (HTTP 404)` | The server never accepted the WebSocket at all. | Different from the above: check host, port and any reverse proxy in front of WebIQ. |
| `project not found / connection failed` | The socket closed before a login was attempted. | Server unreachable, wrong port, or a firewall in the way. |
| `link stale - reconnecting` | Two heartbeats passed with no traffic and no pong. | Normal after a network drop — it reconnects automatically. Persistent flapping means the server does not answer pings; consider raising **Heartbeat** or setting it to `0`. |
| `send buffer full` | The server has stopped reading and 1 MB is queued. | Requests are being dropped rather than buffered forever. Check server load. |
| `disconnected` | No connection; reconnecting with backoff (1 s doubling to 30 s). | Wait, or check the server. |

Errors you may see on a message (all trappable with a **Catch** node):

| Error | Cause |
| --- | --- |
| `WebIQ node is not configured: ...` | The node has a configuration error. In 1.x this message vanished with no error at all. |
| `Cannot send: not authenticated yet` | The request arrived before login completed. |
| `WebSocket is not connected` | No live connection at that moment. |
| `Payload is missing required fields: cmd, id, data` | The payload reaching the connect node is not a WebIQ request. |
| `... is not a valid WebIQ request: missing "id"` | The API Request node's data — static or dynamic — is incomplete. |
| `Could not serialise payload: ...` | The payload contains a circular reference or a BigInt. |

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

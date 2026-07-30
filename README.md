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
   - **Host**: The WebIQ server host.
   - **Port**: The WebIQ server port.
   - **Project**: The WebIQ project name.
   - **Username**: Your WebIQ project username.
   - **Password**: Your WebIQ project password.
   - **Login timeout**: Seconds to wait for the server's login reply before reporting a timeout and reconnecting. Defaults to `5`. Raise this if the project is backed by a slow PLC — a login that takes longer than the timeout will otherwise loop without ever authenticating.
3. Deploy the changes.

### API Request Node

1. Drag the **API Request** node into your Node-RED workspace.
2. Configure the node properties as needed.
3. Fill in or edit the example fields (`cmd`, `id`, `data`) to send commands to the WebIQ server.
4. Deploy the changes.

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

## Migrating from 1.x

The username and password moved out of the flow file and into Node-RED's
credential store.

A node created before 2.0 keeps working: the runtime falls back to the old
properties and warns on deploy. To complete the migration, open each **WebIQ API
Connect** node, re-enter the username and password, and deploy. Until you do, the
credentials remain in `flows.json` in cleartext.

Any password that has been exported, committed to version control or included in a
backup should be rotated — it has been readable in plaintext for its entire life.

## Contributing

Contributions are welcome! Please fork the repository and submit a pull request.

## License

This project is licensed under the MIT License.

## Links

- [Node-RED Flow Library](https://flows.nodered.org/node/node-red-contrib-webiq)
- [GitHub Repository](https://github.com/DanteDevOps/node-red-contrib-webiq)


## Contact

For any questions or issues, please open an issue in the GitHub repository.

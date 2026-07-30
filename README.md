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

## Example Flow to import in Node-Red

```json
[{"id":"6ae4f887e84999f1","type":"tab","label":"Flow 1","disabled":false,"info":"","env":[]},{"id":"9c75c542f1c48c46","type":"webiq-api-connect","z":"6ae4f887e84999f1","name":"","host":"127.0.0.1","port":"10123","project":"f0362a66-4b94-4167-bfcb-1995290ad399","username":"Worker","password":"worker","x":540,"y":240,"wires":[["cb3ebb2cf607bc6e"]]},{"id":"4a8faf0286528557","type":"api-request","z":"6ae4f887e84999f1","name":"","data":"{\n    \"cmd\": \"io.read\",\n    \"id\": 0,\n    \"data\": [\"DSin\", \"SInt\"]\n}","x":310,"y":240,"wires":[["9c75c542f1c48c46"]]},{"id":"cb3ebb2cf607bc6e","type":"debug","z":"6ae4f887e84999f1","name":"debug 11","active":true,"tosidebar":true,"console":false,"tostatus":false,"complete":"true","targetType":"full","statusVal":"","statusType":"auto","x":730,"y":240,"wires":[]},{"id":"943c85ce0ced76f1","type":"inject","z":"6ae4f887e84999f1","name":"","props":[{"p":"payload"},{"p":"topic","vt":"str"}],"repeat":"","crontab":"","once":false,"onceDelay":0.1,"topic":"","payload":"","payloadType":"date","x":140,"y":240,"wires":[["4a8faf0286528557"]]}]
```

## Contributing

Contributions are welcome! Please fork the repository and submit a pull request.

## License

This project is licensed under the MIT License.

## Links

- [Node-RED Flow Library](https://flows.nodered.org/node/node-red-contrib-webiq)
- [GitHub Repository](https://github.com/DanteDevOps/node-red-contrib-webiq)


## Contact

For any questions or issues, please open an issue in the GitHub repository.

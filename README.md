# node-red-contrib-webiq

This package provides custom nodes for integrating Node-RED with WebIQ. These nodes enable seamless communication with WebIQ servers, allowing you to easily send commands and receive data.

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
3. Deploy the changes.

### API Request Node

1. Drag the **API Request** node into your Node-RED workspace.
2. Configure the node properties as needed.
3. Inject the required fields (`cmd`, `id`, `data`) to send commands to the WebIQ server.
4. Interval time is used to inject data, set 0 for deactivation.
5. Deploy the changes.

## Example Flow to import in Node-Red

```json
[{"id":"cc66026e27238f8e","type":"inject","z":"2ff0686f23684c79","name":"","props":[{"p":"payload"},{"p":"topic","vt":"str"}],"repeat":"","crontab":"","once":false,"onceDelay":0.1,"topic":"","payload":"","payloadType":"date","x":160,"y":240,"wires":[["0"]]},{"id":"738399a874eef1da","type":"webiq-api-connect","z":"2ff0686f23684c79","name":"WebIQ Connection","host":"localhost","port":"10123","project":"my-project-name","username":"admin","password":"admin","x":610,"y":240,"wires":[["38074751dd3ff1a0"]]},{"id":"0","type":"api-request","z":"2ff0686f23684c79","name":"API Request","cmd":"io.read","data":"[\"DSin\", \"SInt\"]","interval":"0","x":370,"y":240,"wires":[["738399a874eef1da"]]},{"id":"38074751dd3ff1a0","type":"debug","z":"2ff0686f23684c79","name":"debug 3","active":true,"tosidebar":true,"console":false,"tostatus":false,"complete":"false","statusVal":"","statusType":"auto","x":800,"y":240,"wires":[]}]
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

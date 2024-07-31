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
[{"id":"e64c0dbe5d56f9ea","type":"tab","label":"Flow 1","disabled":false,"info":"","env":[]},{"id":"webiq-api-connect","type":"webiq-api-connect","z":"e64c0dbe5d56f9ea","name":"WebIQ Connection","host":"localhost","port":"10123","project":"ob_Review_11","username":"admin","password":"admin","x":570,"y":300,"wires":[["39bc8001a955b56b"]]},{"id":"0","type":"api-request","z":"e64c0dbe5d56f9ea","name":"API Request","cmd":"io.read","data":"[\"DSin\", \"SInt\"]","interval":"0","x":330,"y":300,"wires":[["webiq-api-connect"]]},{"id":"18060514ead1a14e","type":"inject","z":"e64c0dbe5d56f9ea","name":"","props":[{"p":"payload"},{"p":"topic","vt":"str"}],"repeat":"","crontab":"","once":false,"onceDelay":0.1,"topic":"","payload":"","payloadType":"date","x":120,"y":300,"wires":[["0"]]},{"id":"39bc8001a955b56b","type":"debug","z":"e64c0dbe5d56f9ea","name":"debug 1","active":true,"tosidebar":true,"console":false,"tostatus":false,"complete":"false","statusVal":"","statusType":"auto","x":760,"y":300,"wires":[]}]
```

## Contributing

Contributions are welcome! Please fork the repository and submit a pull request.

## License

This project is licensed under the MIT License.

## Links

- [Node-RED Flow Library](https://flows.nodered.org/node/node-red-contrib-webiq)
- [GitHub Repository](https://github.com/YourUsername/node-red-contrib-webiq)

## Contact

For any questions or issues, please open an issue in the GitHub repository.

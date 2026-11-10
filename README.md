# node-red-contrib-levoit-purifier

Node-RED node for controlling **Levoit air purifiers** via the VeSync cloud API.

## Features

- **Two-step OAuth authentication** — supports the current VeSync API (2025+)
- **EU and US region support** — automatic cross-region redirect
- **Dynamic device discovery** — devices populate in dropdown from the VeSync API
- **Air purifier control** — power on/off, fan speed, mode (auto/manual/sleep), display, child lock
- **Status polling** — periodic status updates with PM2.5, filter life, air quality
- **Zero dependencies** — uses only Node.js built-in `https` and `crypto` modules
- **Credentials stored securely** — via Node-RED's built-in credential system

## Supported Devices

| Model | Tested |
|-------|--------|
| Vital 100S (LAP-V102S) | ✅ |
| Vital 200S | Should work |
| Core 200S | Should work |
| Core 300S | ✅ |
| Core 400S | Should work |
| Core 600S | Should work |

## Installation

### Via Node-RED Palette Manager

Search for `node-red-contrib-levoit-purifier` in **Manage palette → Install**.

### Via npm

```bash
cd ~/.node-red
npm install node-red-contrib-levoit-purifier
```

## Quick Start

1. Drag a **levoit purifier** node onto your flow
2. Create a new **Levoit Config** — enter your VeSync app email, password, and select your region
3. Click **Test Connection** to verify credentials
4. **Deploy** the flow
5. Open the purifier node again — your devices will appear in the dropdown
6. Select your device, set poll interval, and deploy

## Usage

### Control via input messages

```json
// Turn on / off
{ "payload": "on" }
{ "payload": "off" }

// Set fan speed (1-4)
{ "payload": { "action": "speed", "value": 2 } }

// Set mode: "manual", "auto", "sleep"
{ "payload": { "action": "mode", "value": "auto" } }

// Poll status
{ "payload": "status" }

// Display on/off
{ "payload": "display_on" }
{ "payload": "display_off" }

// Child lock
{ "payload": "child_lock_on" }
{ "payload": "child_lock_off" }
```

### Output

The node outputs `msg.payload` with the current device status on every poll and after every command.

### Diagnostics

`bin/diagnose.js` prints the raw VeSync request/response so field placement can be checked against a real device. Credentials come from argv or environment variables and are never stored in the repository:

```bash
VESYNC_EMAIL=you@example.com VESYNC_PASSWORD=secret \
LEVOIT_CID=<cid> LEVOIT_CONFIG_MODULE=<configModule> \
node bin/diagnose.js status --raw

VESYNC_EMAIL=... VESYNC_PASSWORD=... node bin/diagnose.js devices
VESYNC_EMAIL=... VESYNC_PASSWORD=... LEVOIT_CID=<cid> \
  LEVOIT_CONFIG_MODULE=<configModule> node bin/diagnose.js on
```

Use `node bin/diagnose.js --help` for all options. Commands: `status`, `on`, `off`, `devices`, `command`. Set `--endpoint bycid` / `--endpoint byuuid` or `--variant core|vital|both` to compare payloads. The token is redacted in the echoed request.

## License

MIT

## Credits

API protocol based on research from [pyvesync](https://github.com/webdjoe/pyvesync), [homebridge-levoit-air-purifier](https://github.com/RaresAil/homebridge-levoit-air-purifier), and [openHAB VeSync binding](https://www.openhab.org/addons/bindings/vesync/).

## Disclaimer

This software is NOT an official Levoit or VeSync product. Levoit and VeSync are registered trademarks of VeSync Co., Ltd.

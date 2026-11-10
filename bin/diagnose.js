#!/usr/bin/env node
'use strict';

/**
 * Levoit / VeSync diagnostic helper.
 *
 * Prints the RAW request and response for getPurifierStatus and for a
 * setSwitch command, so field placement (powerSwitch vs enabled vs deviceProp)
 * can be verified against a real device without touching the flow.
 *
 * Credentials are never stored in this repository. Provide them through
 * environment variables or CLI arguments:
 *
 *   VESYNC_EMAIL, VESYNC_PASSWORD, VESYNC_REGION (US|EU),
 *   VESYNC_TIMEZONE, LEVOIT_CID, LEVOIT_CONFIG_MODULE, LEVOIT_DEVICE
 *
 * Examples:
 *   VESYNC_EMAIL=... VESYNC_PASSWORD=... LEVOIT_CID=... \
 *   LEVOIT_CONFIG_MODULE=... node bin/diagnose.js status --raw
 *
 *   ... node bin/diagnose.js off
 *   ... node bin/diagnose.js command --method setSwitch --data '{"enabled":true,"id":0}'
 *   ... node bin/diagnose.js devices
 *
 * Optional flags:
 *   --device <name|index|cid>  pick a device when cid is not set
 *   --endpoint <name>          bypassV2 (default), bycid, byuuid
 *   --variant <core|vital|both> setSwitch payload to send (default: by model)
 *   --raw                       also print the normalized status object
 *   --help
 */

const { VeSyncAPI, numericDeviceId } = require('../lib/vesync-api');

const USAGE = `Levoit / VeSync diagnostic tool

Usage:
  node bin/diagnose.js [status|on|off|devices|command] [options]

Options:
  --email <email>            VeSync account email (env VESYNC_EMAIL)
  --password <password>      VeSync account password (env VESYNC_PASSWORD)
  --region <US|EU>           account region (env VESYNC_REGION, default EU)
  --timezone <IANA>          timezone (env VESYNC_TIMEZONE, default Europe/Prague)
  --cid <cid>                device cid (env LEVOIT_CID)
  --config-module <module>   device configModule (env LEVOIT_CONFIG_MODULE)
  --device <name|index|cid>  choose a device from the account (env LEVOIT_DEVICE)
  --endpoint <name>          bypassV2 (default), bycid, byuuid
  --variant <core|vital|both> setSwitch payload (default: inferred from device)
  --method <name>            payload method for "command" (default setSwitch)
  --data '<json>'            payload data for "command"
  --raw                      print normalized status next to the raw response
  --help

Nothing secret is printed: the token is redacted in the echoed request.
`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    if (key === 'raw' || key === 'help') {
      args[key] = true;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function pick(args, name, envName, fallback) {
  if (args[name] !== undefined && args[name] !== true) return args[name];
  if (envName && process.env[envName]) return process.env[envName];
  return fallback;
}

/**
 * Redact secrets before printing a request body.
 * @param {object} body
 * @returns {object}
 */
function redact(body) {
  const copy = Object.assign({}, body);
  if (copy.token) copy.token = '<redacted>';
  if (copy.password) copy.password = '<redacted>';
  if (copy.accountID) copy.accountID = String(copy.accountID);
  return copy;
}

function printJson(label, value) {
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(value, null, 2));
}

function isVital(device, configModule) {
  const type = `${configModule || ''} ${(device && device.deviceType) || ''}`;
  return /Vital|LAP-V|LAP-EL/i.test(type);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveDevice(api, args) {
  let cid = pick(args, 'cid', 'LEVOIT_CID');
  let configModule = pick(args, 'config-module', 'LEVOIT_CONFIG_MODULE');
  let device = null;

  const selector = pick(args, 'device', 'LEVOIT_DEVICE');
  if (!cid || !configModule || selector) {
    const devices = await api.getDevices();
    if (devices.length === 0) {
      throw new Error('No devices found on this account');
    }

    if (selector !== undefined && selector !== null) {
      const asIndex = Number(selector);
      device = Number.isInteger(asIndex) && String(asIndex) === String(selector)
        ? devices[asIndex]
        : devices.find((d) => d.cid === selector
          || d.uuid === selector
          || d.deviceName === selector
          || d.macID === selector);
      if (!device) throw new Error(`Device not found: ${selector}`);
    } else if (cid) {
      device = devices.find((d) => d.cid === cid
        || d.uuid === cid
        || d.macID === cid) || null;
    } else {
      const purifiers = devices.filter((d) => /purifier|air/i.test(
        `${d.deviceType || ''} ${d.configModule || ''}`
      ));
      if (purifiers.length === 1) device = purifiers[0];
    }

    if (device) {
      cid = device.cid;
      configModule = configModule || device.configModule;
    }
  }

  if (!cid || !configModule) {
    throw new Error(
      'Missing device cid/configModule. Pass --cid/--config-module, --device, '
      + 'or run "node bin/diagnose.js devices" to list them.'
    );
  }
  if (!device) {
    device = (await api.getDevices()).find((d) => d.cid === cid
      || d.uuid === cid
      || d.macID === cid) || null;
  }

  return { cid, configModule, device };
}

async function listDevices(api) {
  const devices = await api.getDevices({ force: true });
  const summary = devices.map((d, index) => ({
    index,
    name: d.deviceName,
    cid: d.cid,
    uuid: d.uuid,
    type: d.deviceType,
    configModule: d.configModule,
    deviceRegion: d.deviceRegion,
    deviceStatus: d.deviceStatus,
    connectionStatus: (d.deviceProp && d.deviceProp.connectionStatus) || d.connectionStatus,
    deviceProp: d.deviceProp || null,
  }));
  printJson('DEVICES (raw list, secrets not included)', summary);
  return devices;
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }

  const command = (args._[0] || 'status').toLowerCase();
  const email = pick(args, 'email', 'VESYNC_EMAIL');
  const password = pick(args, 'password', 'VESYNC_PASSWORD');
  const region = pick(args, 'region', 'VESYNC_REGION', 'EU');
  const timeZone = pick(args, 'timezone', 'VESYNC_TIMEZONE', 'Europe/Prague');

  if (!email || !password) {
    console.error(
      'Missing credentials. Set VESYNC_EMAIL / VESYNC_PASSWORD or pass '
      + '--email / --password. Run with --help for usage.'
    );
    process.exitCode = 2;
    return;
  }

  const api = new VeSyncAPI(email, password, region, timeZone);
  await api.login();
  console.log(`Authenticated (region: ${api.region}, host: ${api.host})`);

  if (command === 'devices' || command === 'list') {
    await listDevices(api);
    return;
  }

  const { cid, configModule, device } = await resolveDevice(api, args);
  console.log(`Device: ${(device && device.deviceName) || '?'} (cid: ${cid})`);
  console.log(`configModule: ${configModule}`);

  if (command === 'status' || command === 'poll') {
    const attempt = await api.bypassV2Raw(cid, configModule, 'getPurifierStatus');
    printJson('STATUS REQUEST', redact(attempt.request));
    printJson('STATUS RAW RESPONSE', attempt.response);
    if (args.raw) {
      printJson('STATUS NORMALIZED', await api.getPurifierStatus(cid, configModule));
    }
    return;
  }

  if (command === 'on' || command === 'off' || command === 'command') {
    const on = command === 'on';
    let method = pick(args, 'method', null, 'setSwitch');
    let data;

    if (command === 'command' && args.data) {
      data = JSON.parse(args.data);
    } else if (command === 'command' && method !== 'setSwitch') {
      data = {};
    } else {
      const vital = isVital(device, configModule);
      data = vital
        ? { powerSwitch: on ? 1 : 0, switchIdx: 0 }
        : { enabled: Boolean(on), id: numericDeviceId(device) };
    }

    const variant = args.variant;
    if (command !== 'command' && (variant === 'core' || variant === 'vital')) {
      data = variant === 'vital'
        ? { powerSwitch: on ? 1 : 0, switchIdx: 0 }
        : { enabled: Boolean(on), id: numericDeviceId(device) };
    }

    const endpoint = pick(args, 'endpoint', null, 'bypassV2');
    const attempt = await api.bypassV2Raw(cid, configModule, method, data, { endpoint });
    printJson(`${method.toUpperCase()} REQUEST`, redact(attempt.request));
    printJson(`${method.toUpperCase()} RAW RESPONSE`, attempt.response);

    if (command !== 'command' && variant === 'both') {
      const alternate = isVital(device, configModule)
        ? { enabled: Boolean(on), id: numericDeviceId(device) }
        : { powerSwitch: on ? 1 : 0, switchIdx: 0 };
      const second = await api.bypassV2Raw(cid, configModule, method, alternate, { endpoint });
      printJson(`${method.toUpperCase()} ALTERNATE REQUEST`, redact(second.request));
      printJson(`${method.toUpperCase()} ALTERNATE RAW RESPONSE`, second.response);
    }

    await delay(1500);
    const after = await api.bypassV2Raw(cid, configModule, 'getPurifierStatus');
    printJson('STATUS RAW RESPONSE (after command)', after.response);
    if (args.raw) {
      printJson('STATUS NORMALIZED (after command)', await api.getPurifierStatus(cid, configModule));
    }
    return;
  }

  console.error(`Unknown command: ${command}`);
  console.error(USAGE);
  process.exitCode = 2;
}

run().catch((err) => {
  console.error(`\nDiagnose failed: ${err.message}`);
  process.exitCode = 1;
});

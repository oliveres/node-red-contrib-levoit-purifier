'use strict';

const POST_COMMAND_POLL_DELAY = 5000;

module.exports = function (RED) {
  function VeSyncPurifierNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.configNode = RED.nodes.getNode(config.account);
    node.deviceCid = config.deviceCid;
    node.configModule = config.configModule;
    node.deviceName = config.deviceName || 'Air Purifier';
    node.pollInterval = (parseInt(config.pollInterval, 10) || 60) * 1000;
    node.pollTimer = null;

    if (!node.configNode || !node.configNode.api) {
      node.status({ fill: 'red', shape: 'ring', text: 'not configured' });
      return;
    }

    if (!node.deviceCid || !node.configModule) {
      node.status({ fill: 'yellow', shape: 'ring', text: 'no device selected' });
      return;
    }

    const api = node.configNode.api;

    /**
     * Fetch purifier status and send to output.
     */
    async function pollStatus() {
      try {
        const status = await api.getPurifierStatus(node.deviceCid, node.configModule);
        const msg = {
          payload: status,
          topic: 'levoit/purifier/status',
          device: {
            cid: node.deviceCid,
            name: node.deviceName,
            configModule: node.configModule,
          },
        };
        node.send(msg);

        // Update node status — field names from actual VeSync API
        const enabled = status.powerSwitch === 1 || status.enabled === true || status.device_status === 'on';
        const mode = status.workMode || status.mode || '?';
        const level = status.fanSpeedLevel || status.manualSpeedLevel || status.level || '?';
        const pm25 = status.PM25 != null ? status.PM25 : (status.air_quality_value != null ? status.air_quality_value : '?');
        const filter = status.filterLifePercent != null ? status.filterLifePercent : (status.filter_life != null ? status.filter_life : '?');

        if (enabled) {
          node.status({
            fill: 'green',
            shape: 'dot',
            text: `ON | ${mode} (${level}) | PM2.5: ${pm25} | Filter: ${filter}%`,
          });
        } else {
          node.status({ fill: 'grey', shape: 'dot', text: `OFF | PM2.5: ${pm25} | Filter: ${filter}%` });
        }
      } catch (err) {
        node.status({ fill: 'red', shape: 'ring', text: err.message });
        node.send({ topic: 'levoit/purifier/error', payload: { error: err.message } });
        node.error(err);
      }
    }

    // Initial poll
    pollStatus();

    // Periodic polling
    if (node.pollInterval > 0) {
      node.pollTimer = setInterval(pollStatus, node.pollInterval);
    }

    // Handle input messages for control
    node.on('input', async function (msg, send, done) {
      send = send || function () { node.send.apply(node, arguments); };
      done = done || function (err) { if (err) node.error(err, msg); };

      try {
        const action = (msg.payload && typeof msg.payload === 'object')
          ? msg.payload
          : { action: String(msg.payload) };

        const act = (action.action || '').toLowerCase();

        switch (act) {
          case 'on':
          case 'turn_on':
            await api.setPurifierPower(node.deviceCid, node.configModule, true);
            break;

          case 'off':
          case 'turn_off':
            await api.setPurifierPower(node.deviceCid, node.configModule, false);
            break;

          case 'speed':
          case 'level':
          case 'set_level':
            const level = parseInt(action.value || action.level || msg.payload.value, 10);
            if (level >= 1 && level <= 4) {
              await api.setPurifierMode(node.deviceCid, node.configModule, 'manual');
              await api.setPurifierLevel(node.deviceCid, node.configModule, level);
            } else {
              throw new Error(`Invalid fan level: ${level} (must be 1-4)`);
            }
            break;

          case 'mode':
          case 'set_mode':
            const mode = action.value || action.mode || '';
            if (['manual', 'auto', 'sleep'].includes(mode)) {
              await api.setPurifierMode(node.deviceCid, node.configModule, mode);
            } else {
              throw new Error(`Invalid mode: ${mode} (must be manual, auto, or sleep)`);
            }
            break;

          case 'display_on':
            await api.setDisplay(node.deviceCid, node.configModule, true);
            break;

          case 'display_off':
            await api.setDisplay(node.deviceCid, node.configModule, false);
            break;

          case 'child_lock_on':
            await api.setChildLock(node.deviceCid, node.configModule, true);
            break;

          case 'child_lock_off':
            await api.setChildLock(node.deviceCid, node.configModule, false);
            break;

          case 'status':
          case 'poll':
            // Just poll, handled below
            break;

          default:
            node.warn(`Unknown action: ${act}. Use: on, off, speed, mode, display_on, display_off, child_lock_on, child_lock_off, status`);
            done();
            return;
        }

        // After a command, give the cloud time to receive the device's report
        // before polling: deviceProp lagged 1-5 s behind commands on an
        // EverestAir, so an immediate poll returned the previous state.
        if (act !== 'status' && act !== 'poll') {
          await new Promise((resolve) => setTimeout(resolve, POST_COMMAND_POLL_DELAY));
        }
        await pollStatus();
        done();
      } catch (err) {
        node.status({ fill: 'red', shape: 'ring', text: err.message });
        done(err);
      }
    });

    node.on('close', function () {
      if (node.pollTimer) {
        clearInterval(node.pollTimer);
        node.pollTimer = null;
      }
    });
  }

  RED.nodes.registerType('levoit-purifier', VeSyncPurifierNode);
};

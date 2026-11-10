'use strict';

const { VeSyncAPI } = require('../lib/vesync-api');

module.exports = function (RED) {
  function VeSyncConfigNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.region = config.region || 'EU';
    node.timeZone = config.timeZone || 'Europe/Prague';
    node.name = config.name || 'VeSync';

    // Credentials are stored via RED.nodes.registerType credentials
    const email = node.credentials.email;
    const password = node.credentials.password;

    node.api = null;
    node.devices = [];
    node.lastDeviceFetch = 0;

    if (email && password) {
      node.api = new VeSyncAPI(email, password, node.region, node.timeZone);

      // Pre-authenticate on deploy
      node.api.login()
        .then(() => {
          node.log(`Levoit authenticated as ${email} (region: ${node.api.region})`);
          return node.api.getDevices();
        })
        .then((devices) => {
          node.devices = devices;
          node.lastDeviceFetch = Date.now();
          node.log(`Levoit found ${devices.length} device(s)`);
        })
        .catch((err) => {
          node.error(`Levoit login failed: ${err.message}`);
        });
    } else {
      node.warn('Levoit credentials not configured');
    }

    /**
     * Get cached devices or refresh if older than 5 minutes.
     * @returns {Promise<Array>}
     */
    node.getDevices = async function () {
      if (!node.api) throw new Error('Levoit not configured');
      if (Date.now() - node.lastDeviceFetch > 300000 || node.devices.length === 0) {
        node.devices = await node.api.getDevices();
        node.lastDeviceFetch = Date.now();
      }
      return node.devices;
    };

    node.on('close', function () {
      node.api = null;
      node.devices = [];
    });
  }

  RED.nodes.registerType('levoit-config', VeSyncConfigNode, {
    credentials: {
      email: { type: 'text' },
      password: { type: 'password' },
    },
  });

  // ---- Admin API endpoint for dynamic device dropdown in editor ----
  RED.httpAdmin.get('/levoit/devices', RED.auth.needsPermission('levoit-config.read'), async (req, res) => {
    const configNodeId = req.query.configId;
    if (!configNodeId) {
      return res.json([]);
    }

    const configNode = RED.nodes.getNode(configNodeId);
    if (!configNode || !configNode.api) {
      // Config node not deployed yet — try to create a temporary API client
      const configNodeDef = RED.nodes.getNode(configNodeId);
      if (!configNodeDef) {
        return res.json([]);
      }
      return res.json([]);
    }

    try {
      const devices = await configNode.getDevices();
      const result = devices.map((d) => ({
        cid: d.cid,
        name: d.deviceName,
        type: d.deviceType,
        configModule: d.configModule,
        // connectionStatus may live in deviceProp (legacy) or top-level; report unknown when absent
        online: (d.deviceProp && d.deviceProp.connectionStatus) || d.connectionStatus || 'unknown',
        model: d.deviceType,
      }));
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Admin endpoint to test credentials before saving
  RED.httpAdmin.post('/levoit/test-credentials', RED.auth.needsPermission('levoit-config.write'), async (req, res) => {
    const { email, password, region, timeZone } = req.body;
    if (!email || !password) {
      return res.json({ success: false, error: 'Email and password are required' });
    }

    try {
      const api = new VeSyncAPI(email, password, region || 'EU', timeZone || 'America/New_York');
      await api.login();
      const devices = await api.getDevices();
      res.json({
        success: true,
        accountId: api.accountId,
        region: api.region,
        deviceCount: devices.length,
      });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });
};

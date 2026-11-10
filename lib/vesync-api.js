'use strict';

const https = require('https');
const crypto = require('crypto');

const API_HOSTS = {
  US: 'smartapi.vesync.com',
  EU: 'smartapi.vesync.eu',
};

const DEFAULTS = {
  appVersion: '5.6.60',
  phoneBrand: 'node-red-contrib-vesync',
  phoneOS: 'Android',
  clientType: 'vesyncApp',
  clientVersion: 'VeSync 5.6.60',
  appId: 'eldodkfj',
  acceptLanguage: 'en',
  terminalId: '2b970374f583f5195a89018a996166660',
};

function md5(str) {
  return crypto.createHash('md5').update(str, 'utf8').digest('hex');
}

function traceId() {
  return String(Date.now());
}

const DEVICE_CACHE_TTL = 300000; // 5 minutes, same as the config node cache
const POWER_OVERRIDE_TTL = 300000; // trust a successful local command for 5 minutes

/**
 * Normalize a value that may be a boolean, 0/1 number, or "0"/"1" string.
 * @param {*} value
 * @returns {number|undefined} 0, 1 or undefined when the value is not usable
 */
function toSwitchValue(value) {
  if (value === true || value === 1 || value === '1') return 1;
  if (value === false || value === 0 || value === '0') return 0;
  return undefined;
}

/**
 * Extract the outer and inner result objects from a bypassV2 response.
 * @param {object} response
 * @returns {{outer: object|null, inner: object|null}}
 */
function extractBypassV2(response) {
  const outer = (response && typeof response.result === 'object' && response.result) || null;
  const inner = (outer && typeof outer.result === 'object' && outer.result) || null;
  return { outer, inner };
}

/**
 * A bypassV2 call can fail either at the top level (code != 0) or at the
 * inner result level. Both must be successful for a command to count.
 * @param {object} response
 * @returns {boolean}
 */
function isBypassSuccess(response) {
  if (!response || Number(response.code) !== 0) return false;
  const { outer } = extractBypassV2(response);
  if (outer && outer.code !== undefined && outer.code !== null && Number(outer.code) !== 0) {
    return false;
  }
  return true;
}

/**
 * Resolve the numeric id expected in the `setSwitch` payload. Reference
 * clients send 0 for Core models; some accounts expose a real numeric
 * deviceId in deviceProp, which is preferred when present.
 * @param {object|null} device
 * @returns {number}
 */
function numericDeviceId(device) {
  const candidates = [
    device && device.deviceId,
    device && device.deviceProp && device.deviceProp.deviceId,
    device && device.deviceProp && device.deviceProp.id,
    device && device.id,
  ];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null || candidate === '') continue;
    const value = Number(candidate);
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

/**
 * Merge the fields returned by getPurifierStatus with the power state that the
 * genuine device reports in the device list's `deviceProp`.
 *
 * Rationale (verified on a Core 300S, EU): getPurifierStatus may keep returning
 * `enabled: false` (and no `powerSwitch`) while the purifier is physically on.
 * The authoritative power bit for those models is `deviceProp.powerSwitch` in
 * /cloud/v1/deviceManaged/devices, exactly as pyvesync does when it flattens
 * deviceProp into deviceStatus. We still prefer a `powerSwitch` present in the
 * status payload itself (Vital 100S/200S style), because it is the freshest.
 *
 * @param {object} inner - inner result of getPurifierStatus
 * @param {object|null} deviceProp - deviceProp from the device list, if any
 * @param {{value: number, at: number}|null} override - recent local command
 * @param {object|null} device - device list entry (for uuid fallbacks)
 * @returns {object} normalized status object
 */
function normalizePurifierStatus(inner, deviceProp, override, device) {
  const status = Object.assign({}, inner || {});
  const prop = deviceProp || (inner && inner.deviceProp) || {};
  const propPower = toSwitchValue(prop.powerSwitch);

  let power;
  let powerSource;
  if (toSwitchValue(status.powerSwitch) !== undefined) {
    power = toSwitchValue(status.powerSwitch);
    powerSource = 'status.powerSwitch';
  } else if (override && toSwitchValue(override.value) !== undefined) {
    power = toSwitchValue(override.value);
    powerSource = 'command';
  } else if (propPower !== undefined) {
    power = propPower;
    powerSource = 'deviceProp.powerSwitch';
  } else if (typeof status.enabled === 'boolean') {
    power = status.enabled ? 1 : 0;
    powerSource = 'status.enabled';
  } else if (status.deviceStatus === 'on' || status.deviceStatus === 'off') {
    power = status.deviceStatus === 'on' ? 1 : 0;
    powerSource = 'status.deviceStatus';
  }

  if (power !== undefined) {
    status.powerSwitch = power;
    status.enabled = power === 1;
    status.power_source = powerSource;
  } else {
    status.power_source = 'unknown';
  }

  // Add snake_case aliases for models that answer with camelCase fields
  // (Vital 100S/200S, some Core firmware). Done additively: existing keys win.
  if (status.mode == null && status.workMode != null) status.mode = status.workMode;
  if (status.level == null && status.fanSpeedLevel != null) {
    status.level = status.fanSpeedLevel === 255 ? 0 : status.fanSpeedLevel;
  }
  if (status.filter_life == null && status.filterLifePercent != null) {
    status.filter_life = status.filterLifePercent;
  }
  if (status.air_quality == null && status.AQLevel != null) status.air_quality = status.AQLevel;
  if (status.air_quality_value == null && status.PM25 != null) status.air_quality_value = status.PM25;
  if (status.display == null && status.screenState != null) status.display = status.screenState === 1;
  if (status.display == null && status.screenSwitch != null) status.display = status.screenSwitch === 1;
  if (status.child_lock == null && status.childLockSwitch != null) {
    status.child_lock = status.childLockSwitch === 1;
  }

  status.connection_status = (device && (
    (device.deviceProp && device.deviceProp.connectionStatus) || device.connectionStatus
  )) || status.connection_status || 'unknown';

  if (Object.keys(prop).length > 0) status.deviceProp = prop;
  return status;
}

/**
 * Make an HTTPS POST request to VeSync API.
 * @param {string} host - API hostname
 * @param {string} path - API endpoint path
 * @param {object} body - JSON body
 * @returns {Promise<object>} Parsed JSON response
 */
function apiCall(host, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname: host,
      port: 443,
      path: path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'User-Agent': 'okhttp/3.12.1',
        'Content-Length': Buffer.byteLength(data),
      },
    };

    const req = https.request(options, (res) => {
      let responseData = '';
      res.on('data', (chunk) => { responseData += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(responseData));
        } catch (e) {
          reject(new Error(`Failed to parse API response: ${responseData.substring(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('API request timed out'));
    });
    req.write(data);
    req.end();
  });
}

/**
 * VeSync API client.
 * Handles two-step OAuth authentication, token management,
 * device discovery, and device control via bypassV2 API.
 */
class VeSyncAPI {
  /**
   * @param {string} email - VeSync account email
   * @param {string} password - VeSync account password (plain text)
   * @param {string} region - Region code: 'US' or 'EU'
   * @param {string} [timeZone='Europe/Prague'] - IANA timezone
   */
  constructor(email, password, region = 'EU', timeZone = 'America/New_York') {
    this.email = email;
    this.passwordHash = md5(password);
    this.region = region.toUpperCase();
    this.timeZone = timeZone;
    this.host = API_HOSTS[this.region] || API_HOSTS.US;

    this.token = null;
    this.accountId = null;
    this.tokenExpiry = null;

    this.devicesCache = null;
    this.devicesCacheAt = 0;
    // cid -> { value: 0|1, at: epoch ms } set after a successful setSwitch
    this.powerOverrides = new Map();
  }

  /**
   * Check if the current token is valid and not expired.
   * @returns {boolean}
   */
  isAuthenticated() {
    if (!this.token || !this.accountId) return false;
    if (this.tokenExpiry && Date.now() > this.tokenExpiry - 86400000) return false;
    return true;
  }

  /**
   * Two-step OAuth login.
   * Step 1: authByPWDOrOTM → get authorizeCode + accountID
   * Step 2: loginByAuthorizeCode4Vesync → get token
   *
   * Handles cross-region redirect automatically.
   * @returns {Promise<{token: string, accountId: string}>}
   */
  async login() {
    // Step 1: Get authorization code
    const step1Body = {
      email: this.email,
      password: this.passwordHash,
      method: 'authByPWDOrOTM',
      acceptLanguage: DEFAULTS.acceptLanguage,
      accountID: '',
      authProtocolType: 'generic',
      clientInfo: DEFAULTS.phoneBrand,
      clientType: DEFAULTS.clientType,
      clientVersion: DEFAULTS.clientVersion,
      debugMode: false,
      osInfo: DEFAULTS.phoneOS,
      terminalId: DEFAULTS.terminalId,
      timeZone: this.timeZone,
      token: '',
      userCountryCode: this.region === 'EU' ? 'CZ' : 'US',
      appID: DEFAULTS.appId,
      sourceAppID: DEFAULTS.appId,
      traceId: traceId(),
    };

    // Always start with .com for step 1
    let step1Resp = await apiCall(
      API_HOSTS.US,
      '/globalPlatform/api/accountAuth/v1/authByPWDOrOTM',
      step1Body
    );

    if (step1Resp.code !== 0) {
      throw new Error(`VeSync auth step 1 failed: ${step1Resp.msg} (code: ${step1Resp.code})`);
    }

    const authorizeCode = step1Resp.result.authorizeCode;
    this.accountId = step1Resp.result.accountID;

    // Step 2: Exchange authorization code for token
    const step2Body = {
      method: 'loginByAuthorizeCode4Vesync',
      authorizeCode: authorizeCode,
      acceptLanguage: DEFAULTS.acceptLanguage,
      accountID: '',
      clientInfo: DEFAULTS.phoneBrand,
      clientType: DEFAULTS.clientType,
      clientVersion: DEFAULTS.clientVersion,
      debugMode: false,
      emailSubscriptions: false,
      osInfo: DEFAULTS.phoneOS,
      terminalId: DEFAULTS.terminalId,
      timeZone: this.timeZone,
      token: '',
      userCountryCode: this.region === 'EU' ? 'CZ' : 'US',
      traceId: traceId(),
    };

    // Try region-specific host first
    let step2Resp = await apiCall(
      this.host,
      '/user/api/accountManage/v1/loginByAuthorizeCode4Vesync',
      step2Body
    );

    // Handle cross-region redirect
    if (step2Resp.code === -11260022 && step2Resp.result && step2Resp.result.bizToken) {
      const redirectRegion = step2Resp.result.currentRegion
        || (this.region === 'EU' ? 'US' : 'EU');
      const bizToken = step2Resp.result.bizToken;
      const countryCode = step2Resp.result.countryCode || 'US';
      const redirectHost = API_HOSTS[redirectRegion] || API_HOSTS.US;

      step2Body.bizToken = bizToken;
      step2Body.regionChange = 'lastRegion';
      step2Body.userCountryCode = countryCode;

      const retryResp = await apiCall(
        redirectHost,
        '/user/api/accountManage/v1/loginByAuthorizeCode4Vesync',
        step2Body
      );

      if (retryResp.code !== 0) {
        throw new Error(`VeSync auth step 2 cross-region retry failed: ${retryResp.msg} (code: ${retryResp.code})`);
      }

      // Update host for future requests
      step2Resp = retryResp;
      this.host = redirectHost;
      this.region = redirectRegion;
    }

    if (step2Resp.code !== 0) {
      throw new Error(`VeSync auth step 2 failed: ${step2Resp.msg} (code: ${step2Resp.code})`);
    }

    this.token = step2Resp.result.token;
    this.accountId = step2Resp.result.accountID;

    // Parse JWT expiry from token
    try {
      const payload = JSON.parse(
        Buffer.from(this.token.split('.')[1], 'base64').toString()
      );
      this.tokenExpiry = payload.exp;
      // If exp is in milliseconds
      if (this.tokenExpiry > 1e12) this.tokenExpiry = this.tokenExpiry;
      else this.tokenExpiry = this.tokenExpiry * 1000;
    } catch (_) {
      // Token valid for 30 days by default
      this.tokenExpiry = Date.now() + 30 * 86400000;
    }

    return { token: this.token, accountId: this.accountId };
  }

  /**
   * Ensure authenticated, login if needed.
   * @returns {Promise<void>}
   */
  async ensureAuth() {
    if (!this.isAuthenticated()) {
      await this.login();
    }
  }

  /**
   * Get list of all devices on the account.
   * @param {{force?: boolean}} [options]
   * @returns {Promise<Array>} Array of device objects
   */
  async getDevices(options = {}) {
    if (
      !options.force &&
      Array.isArray(this.devicesCache) &&
      Date.now() - this.devicesCacheAt < DEVICE_CACHE_TTL
    ) {
      return this.devicesCache;
    }

    await this.ensureAuth();

    const body = {
      token: this.token,
      accountID: this.accountId,
      timeZone: this.timeZone,
      method: 'devices',
      pageNo: 1,
      pageSize: 100,
      appVersion: DEFAULTS.appVersion,
      phoneBrand: DEFAULTS.phoneBrand,
      phoneOS: DEFAULTS.phoneOS,
      acceptLanguage: DEFAULTS.acceptLanguage,
      traceId: traceId(),
    };

    const resp = await apiCall(this.host, '/cloud/v1/deviceManaged/devices', body);

    if (resp.code !== 0) {
      throw new Error(`VeSync get devices failed: ${resp.msg} (code: ${resp.code})`);
    }

    const list = (resp.result && resp.result.list) || [];
    this.devicesCache = list;
    this.devicesCacheAt = Date.now();
    return list;
  }

  /**
   * Find a device in the (cached) device list by cid, uuid or mac.
   * Returns null instead of throwing so status polling never fails because of
   * the device list endpoint.
   * @param {string} cid
   * @returns {Promise<object|null>}
   */
  async findDevice(cid) {
    try {
      const devices = await this.getDevices();
      return devices.find((d) => d && (
        d.cid === cid || d.uuid === cid || d.macID === cid
      )) || null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Return the power override for a device when it is still newer than the
   * cached device list (i.e. a command was sent after the last list refresh).
   * @param {string} cid
   * @returns {{value: number, at: number}|null}
   */
  getPowerOverride(cid) {
    const override = this.powerOverrides.get(cid);
    if (!override) return null;
    const tooOld = Date.now() - override.at > POWER_OVERRIDE_TTL;
    const olderThanCache = override.at <= this.devicesCacheAt;
    if (tooOld || olderThanCache) {
      this.powerOverrides.delete(cid);
      return null;
    }
    return override;
  }

  /**
   * Send a bypassV2 request and return the complete request/response pair
   * without throwing on API-level errors. Used by setPurifierPower (which
   * needs to try endpoint/payload variants) and by bin/diagnose.js (which
   * needs the raw response).
   *
   * @param {string} cid - Device CID
   * @param {string} configModule - Device config module string
   * @param {string} method - Payload method (e.g. 'setSwitch')
   * @param {object} [data={}] - Payload data
   * @param {{endpoint?: string}} [options] - endpoint defaults to 'bypassV2'.
   *   Accepts 'bypassV2', 'bycid', 'byuuid' or a full path.
   * @returns {Promise<{path: string, request: object, response: object}>}
   */
  async bypassV2Raw(cid, configModule, method, data = {}, options = {}) {
    await this.ensureAuth();

    const endpoint = options.endpoint || 'bypassV2';
    const path = endpoint.startsWith('/')
      ? endpoint
      : `/cloud/v2/deviceManaged/${endpoint}`;

    const body = {
      acceptLanguage: DEFAULTS.acceptLanguage,
      accountID: this.accountId,
      appVersion: DEFAULTS.appVersion,
      cid: cid,
      configModule: configModule,
      configModel: configModule,
      deviceId: cid,
      debugMode: false,
      deviceRegion: this.region,
      userCountryCode: this.region === 'EU' ? 'CZ' : 'US',
      method: 'bypassV2',
      phoneBrand: DEFAULTS.phoneBrand,
      phoneOS: DEFAULTS.phoneOS,
      timeZone: this.timeZone,
      token: this.token,
      traceId: traceId(),
      payload: {
        data: data,
        method: method,
        source: 'APP',
      },
    };

    const response = await apiCall(this.host, path, body);
    return { path, request: body, response };
  }

  /**
   * Send a bypassV2 command to a device.
   * @param {string} cid - Device CID
   * @param {string} configModule - Device config module string
   * @param {string} method - Payload method (e.g. 'getPurifierStatus')
   * @param {object} [data={}] - Payload data
   * @returns {Promise<object>} Result object from API
   */
  async bypassV2(cid, configModule, method, data = {}) {
    const { path, response } = await this.bypassV2Raw(cid, configModule, method, data);

    if (!isBypassSuccess(response)) {
      const { outer } = extractBypassV2(response);
      const code = (outer && outer.code != null) ? outer.code : response.code;
      const msg = (outer && outer.msg) || response.msg || 'unknown error';
      throw new Error(`VeSync ${path} failed: ${msg} (code: ${code})`);
    }

    const { outer, inner } = extractBypassV2(response);
    return inner || outer || {};
  }

  // ---- Air Purifier convenience methods ----

  /**
   * Get purifier status.
   *
   * The power state is reconciled with `deviceProp.powerSwitch` from the
   * device list (see normalizePurifierStatus) because some Core firmware
   * keeps reporting a stale `enabled` / omits `powerSwitch` in
   * getPurifierStatus while the purifier is physically on.
   *
   * @param {string} cid
   * @param {string} configModule
   * @param {object} [options] - optional { deviceProp, device } to avoid a
   *   device-list round trip when the caller already has the device object.
   * @returns {Promise<object>} Status object with enabled, powerSwitch, mode,
   *   level, air_quality, etc.
   */
  async getPurifierStatus(cid, configModule, options = {}) {
    const response = await this.bypassV2(cid, configModule, 'getPurifierStatus');
    const inner = response || {};

    let device = options.device || null;
    if (!device) {
      device = await this.findDevice(cid);
    }
    const deviceProp = options.deviceProp
      || (device && device.deviceProp)
      || null;

    return normalizePurifierStatus(
      inner,
      deviceProp,
      this.getPowerOverride(cid),
      device
    );
  }

  /**
   * Turn purifier on or off.
   *
   * Core 200S/300S/400S/600S expect `{ enabled: bool, id: 0 }`; Vital
   * 100S/200S expect `{ powerSwitch: 0|1, switchIdx: 0 }`. The old code sent
   * the Vital payload to every model, which is why commands were accepted by
   * the API but never reached a Core 300S.
   *
   * @param {string} cid
   * @param {string} configModule
   * @param {boolean} on - true = on, false = off
   * @param {object} [options] - optional { device } from the device list
   * @returns {Promise<{ok: boolean, endpoint: string, data: object, response: object}>}
   */
  async setPurifierPower(cid, configModule, on, options = {}) {
    const device = options.device || await this.findDevice(cid);
    const type = `${configModule || ''} ${(device && device.deviceType) || ''}`;
    const isVital = /Vital|LAP-V|LAP-EL/i.test(type);

    const enabledPayload = { enabled: Boolean(on), id: numericDeviceId(device) };
    const powerSwitchPayload = { powerSwitch: on ? 1 : 0, switchIdx: 0 };
    const forms = isVital
      ? [powerSwitchPayload, enabledPayload]
      : [enabledPayload, powerSwitchPayload];

    // bypassV2 is the endpoint every maintained client uses for setSwitch.
    // bycid/byuuid are kept as fallbacks for accounts where the generic
    // endpoint is rejected (the id/cid still travels in the body).
    const endpoints = ['bypassV2', 'bycid'];
    if (device && device.uuid) endpoints.push('byuuid');

    let lastError = null;
    // Try the preferred payload on every endpoint, then the alternate payload
    // once on bypassV2. Same target state, so retries are idempotent.
    for (const form of forms) {
      const formEndpoints = form === forms[0] ? endpoints : ['bypassV2'];
      for (const endpoint of formEndpoints) {
        try {
          const attempt = await this.bypassV2Raw(
            cid, configModule, 'setSwitch', form, { endpoint }
          );
          if (isBypassSuccess(attempt.response)) {
            this.powerOverrides.set(cid, { value: on ? 1 : 0, at: Date.now() });
            // Keep the cached device list consistent for the next status poll.
            if (device) {
              if (!device.deviceProp) device.deviceProp = {};
              device.deviceProp.powerSwitch = on ? 1 : 0;
              device.deviceStatus = on ? 'on' : 'off';
            }
            return {
              ok: true,
              endpoint,
              data: form,
              response: attempt.response,
            };
          }
          const { outer } = extractBypassV2(attempt.response);
          const code = (outer && outer.code != null) ? outer.code : attempt.response.code;
          const msg = (outer && outer.msg) || attempt.response.msg || 'unknown error';
          lastError = new Error(
            `VeSync setSwitch failed on ${endpoint}: ${msg} (code: ${code})`
          );
        } catch (err) {
          lastError = err;
        }
      }
    }

    throw lastError || new Error('VeSync setSwitch failed for an unknown reason');
  }

  /**
   * Set purifier fan speed level.
   * @param {string} cid
   * @param {string} configModule
   * @param {number} level - Fan speed (1-4, depends on model)
   */
  async setPurifierLevel(cid, configModule, level) {
    return this.bypassV2(cid, configModule, 'setLevel', {
      levelIdx: 0,
      manualSpeedLevel: level,
      levelType: 'wind',
    });
  }

  /**
   * Set purifier mode.
   * @param {string} cid
   * @param {string} configModule
   * @param {string} mode - 'manual', 'auto', 'sleep'
   */
  async setPurifierMode(cid, configModule, mode) {
    return this.bypassV2(cid, configModule, 'setPurifierMode', {
      workMode: mode,
    });
  }

  /**
   * Set display on/off.
   * @param {string} cid
   * @param {string} configModule
   * @param {boolean} on
   */
  async setDisplay(cid, configModule, on) {
    return this.bypassV2(cid, configModule, 'setDisplay', {
      screenSwitch: on ? 1 : 0,
    });
  }

  /**
   * Set child lock.
   * @param {string} cid
   * @param {string} configModule
   * @param {boolean} on
   */
  async setChildLock(cid, configModule, on) {
    return this.bypassV2(cid, configModule, 'setChildLock', {
      childLockSwitch: on ? 1 : 0,
    });
  }
}

module.exports = {
  VeSyncAPI,
  API_HOSTS,
  DEFAULTS,
  normalizePurifierStatus,
  numericDeviceId,
};

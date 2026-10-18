'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  IS_WINDOWS,
  ensureDirSync,
  readJsonSync,
  writeJsonAtomicSync,
  resolvePath,
} = require('./util');

const DEFAULT_PORT = 3210;

function getConfigDir() {
  if (process.env.CS2HUB_HOME) {
    return resolvePath(process.env.CS2HUB_HOME);
  }
  if (IS_WINDOWS) {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'cs2-demo-hub');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'cs2-demo-hub');
}

function defaultConfig() {
  return {
    demoDir: path.join(os.homedir(), 'CS2Demos'),
    cs2Path: null,
    steamPath: null,
    port: DEFAULT_PORT,
    autoDownload: false,
    createdAt: new Date().toISOString(),
  };
}

function normalizeConfig(input) {
  const defaults = defaultConfig();
  const value = input && typeof input === 'object' ? input : {};
  const config = {
    ...defaults,
    ...value,
  };

  if (typeof config.demoDir !== 'string' || !config.demoDir.trim()) {
    config.demoDir = defaults.demoDir;
  }
  config.demoDir = resolvePath(config.demoDir);

  for (const key of ['cs2Path', 'steamPath']) {
    if (typeof config[key] !== 'string' || !config[key].trim()) {
      config[key] = null;
    } else {
      config[key] = resolvePath(config[key].trim());
    }
  }

  config.port = Number(config.port);
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error('端口必须是 1 到 65535 之间的整数');
  }

  config.autoDownload = Boolean(config.autoDownload);
  return config;
}

class ConfigStore {
  constructor(options = {}) {
    this.dir = options.dir ? resolvePath(options.dir) : getConfigDir();
    this.file = options.file || path.join(this.dir, 'config.json');
    this.sessionFile = path.join(this.dir, 'session.json');
    this._config = null;
  }

  get path() {
    return this.file;
  }

  get sessionPath() {
    return this.sessionFile;
  }

  load({reload = false} = {}) {
    if (this._config && !reload) {
      return this._config;
    }
    const stored = readJsonSync(this.file, null);
    this._config = normalizeConfig(stored);
    return this._config;
  }

  get() {
    return this.load();
  }

  ensure() {
    ensureDirSync(this.dir);
    ensureDirSync(this.load().demoDir);
    return this;
  }

  save() {
    ensureDirSync(this.dir);
    ensureDirSync(this._config.demoDir);
    writeJsonAtomicSync(this.file, this._config, 0o600);
    return this._config;
  }

  update(patch) {
    const current = this.load();
    const merged = {...current, ...(patch || {})};
    merged.updatedAt = new Date().toISOString();
    this._config = normalizeConfig(merged);
    return this.save();
  }

  setDemoDir(dir) {
    return this.update({demoDir: dir});
  }

  loadSession() {
    const session = readJsonSync(this.sessionFile, null);
    if (!session || typeof session.refreshToken !== 'string' || session.refreshToken.length < 10) {
      return null;
    }
    return session;
  }

  saveSession(session) {
    if (!session || typeof session.refreshToken !== 'string') {
      throw new Error('无效的 Steam 登录凭据');
    }
    ensureDirSync(this.dir);
    const value = {
      refreshToken: session.refreshToken,
      steamID: session.steamID ? String(session.steamID) : null,
      accountName: session.accountName || null,
      personaName: session.personaName || null,
      savedAt: new Date().toISOString(),
    };
    writeJsonAtomicSync(this.sessionFile, value, 0o600);
    try {
      fs.chmodSync(this.sessionFile, 0o600);
    } catch {
      // Windows: not applicable.
    }
    return value;
  }

  clearSession() {
    try {
      fs.unlinkSync(this.sessionFile);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw err;
      }
    }
  }

  getSessionSummary() {
    const session = this.loadSession();
    if (!session) {
      return {loggedIn: false};
    }
    return {
      loggedIn: true,
      accountName: session.accountName || null,
      personaName: session.personaName || null,
      steamID: session.steamID || null,
      savedAt: session.savedAt || null,
    };
  }

  summary() {
    const config = this.get();
    return {
      configDir: this.dir,
      configPath: this.file,
      sessionPath: this.sessionFile,
      demoDir: config.demoDir,
      cs2Path: config.cs2Path,
      steamPath: config.steamPath,
      port: config.port,
      autoDownload: config.autoDownload,
    };
  }
}

module.exports = {
  DEFAULT_PORT,
  getConfigDir,
  defaultConfig,
  normalizeConfig,
  ConfigStore,
};

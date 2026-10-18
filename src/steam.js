'use strict';

const EventEmitter = require('node:events');
const {LoginSession, EAuthTokenPlatformType, EAuthSessionGuardType} = require('steam-session');
const SteamUser = require('steam-user');
const GlobalOffensive = require('globaloffensive');
const QRCode = require('qrcode');
const {
  randomLogonId,
  waitForEvent,
  sleep,
} = require('./util');
const {isCs2Running} = require('./cs2');
const {normalizeMatch, normalizeShareCodeInput} = require('./valve-matches');

const GUARD_LABELS = {
  EmailCode: '邮箱验证码',
  DeviceCode: '手机令牌验证码',
  DeviceConfirmation: 'Steam 手机 App 确认',
  EmailConfirmation: '邮箱确认',
  MachineToken: '本机令牌',
  LegacyMachineAuth: '本机验证',
};

function createError(message, code, cause) {
  const err = new Error(message);
  err.code = code;
  if (cause) {
    err.cause = cause;
  }
  return err;
}

function friendlySteamError(err, fallback = 'Steam 操作失败') {
  if (!err) {
    return createError(fallback, 'STEAM_ERROR');
  }
  if (err.code === 'NOT_LOGGED_IN' || err.code === 'CS2_RUNNING_SYNC' || err.code === 'GC_TIMEOUT') {
    return err;
  }
  const message = String(err.message || err);
  if (/LoggedInElsewhere/i.test(message)) {
    return createError(
      'Steam 账号已在其他位置登录。请先完全退出 CS2 和 Steam 客户端，或稍后重试',
      'LOGGED_IN_ELSEWHERE',
      err,
    );
  }
  if (/InvalidPassword|AccessDenied|InvalidSignature|Expired/i.test(message)) {
    return createError('Steam 登录凭据已失效，请重新扫码登录', 'SESSION_EXPIRED', err);
  }
  if (/RateLimitExceeded/i.test(message)) {
    return createError('Steam 请求过于频繁，请稍后再试', 'RATE_LIMITED', err);
  }
  if (/SteamGuard/i.test(message)) {
    return createError('Steam 需要安全验证，请重新登录', 'STEAM_GUARD_REQUIRED', err);
  }
  if (/timeout|ETIMEDOUT|ENOTFOUND|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up/i.test(message)) {
    return createError('无法连接 Steam 服务器，请检查网络或代理设置', 'STEAM_NETWORK', err);
  }
  if (/ServiceUnavailable|TryAnotherCM|NoConnection/i.test(message)) {
    return createError('Steam 服务器暂时不可用，请稍后重试', 'STEAM_UNAVAILABLE', err);
  }
  if (/LoggedInElsewhere|NotLoggedOn/i.test(message)) {
    return createError('Steam 登录状态已断开，请重新登录', 'STEAM_DISCONNECTED', err);
  }
  return createError(`${fallback}：${message}`, 'STEAM_ERROR', err);
}

class SteamService extends EventEmitter {
  constructor(configStore, options = {}) {
    super();
    this.configStore = configStore;
    this.logger = options.logger || (() => {});
    this.loginState = {
      phase: 'idle',
      kind: null,
      message: '',
      error: null,
      qrDataUrl: null,
      qrChallengeUrl: null,
      expiresAt: null,
      accountName: null,
      steamID: null,
      actions: [],
      canSubmitCode: false,
      updatedAt: new Date().toISOString(),
    };
    this.pendingLogin = null;
    this._gcQueue = Promise.resolve();
    this._disposed = false;
  }

  getSessionSummary() {
    return this.configStore.getSessionSummary();
  }

  getLoginState() {
    return {...this.loginState, actions: [...this.loginState.actions]};
  }

  _setLoginState(patch) {
    this.loginState = {
      ...this.loginState,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.emit('loginState', this.getLoginState());
    return this.getLoginState();
  }

  _cancelPendingLogin() {
    const pending = this.pendingLogin;
    this.pendingLogin = null;
    if (pending?.session) {
      try {
        pending.session.cancelLoginAttempt();
      } catch {
        // The session may already be finished.
      }
      try {
        pending.session.removeAllListeners();
      } catch {
        // ignore
      }
    }
  }

  _createLoginSession(kind) {
    const session = new LoginSession(EAuthTokenPlatformType.SteamClient);
    session.loginTimeout = 120000;
    session.on('authenticated', () => {
      this._handleAuthenticated(session, kind).catch((err) => {
        this._setLoginState({
          phase: 'error',
          message: err.message,
          error: err.message,
        });
      });
    });
    session.on('timeout', () => {
      if (this.pendingLogin?.session !== session) {
        return;
      }
      this.pendingLogin = null;
      this._setLoginState({
        phase: 'error',
        message: kind === 'qr' ? '二维码已过期，请刷新后重新扫码' : '登录等待超时，请重试',
        error: 'TIMEOUT',
      });
    });
    session.on('error', (err) => {
      if (this.pendingLogin?.session !== session) {
        return;
      }
      this.pendingLogin = null;
      const friendly = friendlySteamError(err, '登录失败');
      this._setLoginState({
        phase: 'error',
        message: friendly.message,
        error: friendly.message,
      });
    });
    return session;
  }

  async _handleAuthenticated(session, kind) {
    if (!this.pendingLogin || this.pendingLogin.session !== session) {
      return;
    }
    this.pendingLogin = null;
    const steamID = session.steamID ? session.steamID.getSteamID64() : null;
    const existing = this.configStore.loadSession();
    const saved = this.configStore.saveSession({
      refreshToken: session.refreshToken,
      steamID,
      accountName: session.accountName || existing?.accountName || null,
      personaName: existing?.steamID === steamID ? existing?.personaName : null,
    });
    this._setLoginState({
      phase: 'success',
      kind,
      accountName: saved.accountName,
      steamID: saved.steamID,
      message: 'Steam 登录成功',
      error: null,
      qrDataUrl: null,
      qrChallengeUrl: null,
      expiresAt: null,
    });
    this.logger(`Steam 登录成功：${saved.accountName || saved.steamID || '未知账号'}`);
  }

  async startQrLogin() {
    this._cancelPendingLogin();
    this._setLoginState({
      phase: 'starting',
      kind: 'qr',
      message: '正在获取 Steam 登录二维码…',
      error: null,
      qrDataUrl: null,
      qrChallengeUrl: null,
      actions: [],
      canSubmitCode: false,
    });

    const session = this._createLoginSession('qr');
    this.pendingLogin = {session, kind: 'qr'};

    let result;
    try {
      result = await session.startWithQR();
    } catch (err) {
      this.pendingLogin = null;
      const friendly = friendlySteamError(err, '获取登录二维码失败');
      this._setLoginState({phase: 'error', message: friendly.message, error: friendly.message});
      throw friendly;
    }

    let qrDataUrl = null;
    try {
      qrDataUrl = await QRCode.toDataURL(result.qrChallengeUrl, {
        margin: 1,
        width: 360,
        errorCorrectionLevel: 'M',
        color: {dark: '#071019', light: '#ffffff'},
      });
    } catch {
      // The raw challenge URL is still exposed for terminal QR rendering.
    }

    if (this.pendingLogin?.session !== session) {
      return this.getLoginState();
    }
    if (this.loginState.phase === 'success') {
      return this.getLoginState();
    }

    return this._setLoginState({
      phase: 'waiting',
      kind: 'qr',
      message: '请使用 Steam 手机 App 扫描二维码并确认登录',
      qrDataUrl,
      qrChallengeUrl: result.qrChallengeUrl,
      expiresAt: Date.now() + session.loginTimeout,
      actions: [],
      canSubmitCode: false,
    });
  }

  async startPasswordLogin({accountName, password, steamGuardCode} = {}) {
    if (!accountName || !password) {
      throw createError('请输入 Steam 账号和密码', 'LOGIN_INPUT');
    }
    this._cancelPendingLogin();
    this._setLoginState({
      phase: 'starting',
      kind: 'password',
      message: '正在登录 Steam…',
      error: null,
      qrDataUrl: null,
      qrChallengeUrl: null,
      actions: [],
      canSubmitCode: false,
    });

    const session = this._createLoginSession('password');
    this.pendingLogin = {session, kind: 'password'};

    let result;
    try {
      result = await session.startWithCredentials({
        accountName: String(accountName).trim(),
        password: String(password),
        ...(steamGuardCode ? {steamGuardCode: String(steamGuardCode).trim()} : {}),
      });
    } catch (err) {
      this.pendingLogin = null;
      const friendly = friendlySteamError(err, 'Steam 登录失败');
      this._setLoginState({phase: 'error', message: friendly.message, error: friendly.message});
      throw friendly;
    }

    if (this.pendingLogin?.session !== session) {
      return this.getLoginState();
    }

    if (result.actionRequired) {
      const actions = (result.validActions || []).map((action) => {
        const name = Object.keys(EAuthSessionGuardType).find(
          (key) => typeof EAuthSessionGuardType[key] === 'number' &&
            EAuthSessionGuardType[key] === action.type &&
            Number.isNaN(Number(key)),
        ) || 'Unknown';
        return {
          type: name,
          label: GUARD_LABELS[name] || name,
          detail: action.detail || null,
        };
      });
      const canSubmitCode = actions.some((action) => (
        action.type === 'EmailCode' || action.type === 'DeviceCode'
      ));
      const needsConfirmation = actions.some((action) => (
        action.type === 'DeviceConfirmation' || action.type === 'EmailConfirmation'
      ));
      return this._setLoginState({
        phase: canSubmitCode ? 'needGuard' : (needsConfirmation ? 'waiting' : 'needGuard'),
        kind: 'password',
        message: canSubmitCode
          ? 'Steam 需要安全验证码，请输入验证码继续'
          : '请在 Steam 手机 App 或邮箱中确认登录',
        actions,
        canSubmitCode,
        expiresAt: Date.now() + session.loginTimeout,
      });
    }

    return this._setLoginState({
      phase: 'waiting',
      kind: 'password',
      message: '正在完成 Steam 登录…',
      expiresAt: Date.now() + session.loginTimeout,
    });
  }

  async submitGuardCode(code) {
    const pending = this.pendingLogin;
    if (!pending?.session) {
      throw createError('当前没有等待验证码的登录请求，请重新登录', 'NO_LOGIN');
    }
    if (!String(code || '').trim()) {
      throw createError('请输入 Steam 安全验证码', 'LOGIN_INPUT');
    }
    try {
      await pending.session.submitSteamGuardCode(String(code).trim());
    } catch (err) {
      const friendly = friendlySteamError(err, '验证码提交失败');
      this._setLoginState({phase: 'needGuard', message: friendly.message, error: friendly.message});
      throw friendly;
    }
    return this._setLoginState({
      phase: 'waiting',
      message: '正在验证 Steam 安全验证码…',
      error: null,
      expiresAt: Date.now() + pending.session.loginTimeout,
    });
  }

  cancelLogin() {
    this._cancelPendingLogin();
    return this._setLoginState({
      phase: 'idle',
      kind: null,
      message: '已取消登录',
      error: null,
      qrDataUrl: null,
      qrChallengeUrl: null,
      expiresAt: null,
      actions: [],
      canSubmitCode: false,
    });
  }

  logout() {
    this._cancelPendingLogin();
    this.configStore.clearSession();
    this._setLoginState({
      phase: 'idle',
      kind: null,
      message: '已退出 Steam 账号',
      error: null,
      qrDataUrl: null,
      qrChallengeUrl: null,
      expiresAt: null,
      accountName: null,
      steamID: null,
      actions: [],
      canSubmitCode: false,
    });
  }

  _ensureSession() {
    const session = this.configStore.loadSession();
    if (!session) {
      throw createError('尚未登录 Steam。请先扫码登录，或运行 cs2hub login', 'NOT_LOGGED_IN');
    }
    return session;
  }

  _saveRefreshedToken(token, baseSession) {
    try {
      const current = this.configStore.loadSession();
      if (!current) {
        return;
      }
      if (baseSession.steamID && current.steamID && String(baseSession.steamID) !== String(current.steamID)) {
        return;
      }
      this.configStore.saveSession({
        ...current,
        refreshToken: token,
      });
    } catch (err) {
      this.logger(`保存 Steam 登录凭据失败：${err.message}`);
    }
  }

  _saveAccountInfo(steamID, personaName, baseSession, latestToken) {
    try {
      const current = this.configStore.loadSession();
      if (!current) {
        return;
      }
      if (current.steamID && steamID && String(current.steamID) !== String(steamID)) {
        return;
      }
      this.configStore.saveSession({
        ...current,
        refreshToken: latestToken || current.refreshToken,
        steamID: steamID || current.steamID,
        accountName: baseSession.accountName || current.accountName,
        personaName: personaName || current.personaName,
      });
    } catch {
      // Non-fatal.
    }
  }

  /**
   * 登录 Steam 并连接 CS2 Game Coordinator，执行一次操作后立即断开。
   * 串行执行，避免 GC 会话冲突。
   */
  withGC(fn, options = {}) {
    const run = this._gcQueue.then(() => this._withGcOnce(fn, options));
    this._gcQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  async _withGcOnce(fn, options = {}) {
    if (this._disposed) {
      throw createError('服务已关闭', 'DISPOSED');
    }
    const session = this._ensureSession();
    const running = await isCs2Running();
    if (running) {
      throw createError(
        'CS2 正在运行。同步比赛/查询分享代码需要占用同一个 Steam 账号的 GC 会话，请先完全退出 CS2 再试',
        'CS2_RUNNING_SYNC',
      );
    }

    let latestToken = session.refreshToken;
    const client = new SteamUser({
      autoRelogin: false,
      renewRefreshTokens: true,
      enablePicsCache: false,
    });
    const go = new GlobalOffensive(client);
    let lastError = null;

    const onError = (err) => {
      lastError = err;
      this.logger(`Steam 错误：${err?.message || err}`);
    };
    client.on('error', onError);
    go.on('error', onError);
    client.on('refreshToken', (token) => {
      latestToken = token;
      this._saveRefreshedToken(token, session);
    });

    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(createError('连接 Steam 超时，请检查网络或代理设置', 'GC_TIMEOUT'));
        }, options.loginTimeout || 30000);
        if (typeof timer.unref === 'function') {
          timer.unref();
        }
        const onLoggedOn = () => {
          cleanup();
          resolve();
        };
        const onLoginError = (err) => {
          cleanup();
          reject(friendlySteamError(err, 'Steam 登录失败'));
        };
        const cleanup = () => {
          clearTimeout(timer);
          client.removeListener('loggedOn', onLoggedOn);
          client.removeListener('error', onLoginError);
        };
        client.once('loggedOn', onLoggedOn);
        client.once('error', onLoginError);
        try {
          client.logOn({
            refreshToken: session.refreshToken,
            logonID: randomLogonId(),
            machineName: 'CS2 Demo Hub',
          });
        } catch (err) {
          cleanup();
          reject(friendlySteamError(err, 'Steam 登录失败'));
        }
      });

      const steamID = client.steamID ? client.steamID.getSteamID64() : session.steamID;
      client.gamesPlayed([730]);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(createError(
            lastError
              ? `连接 CS2 Game Coordinator 失败：${lastError.message || lastError}`
              : '连接 CS2 Game Coordinator 超时。请稍后重试，或尝试使用其他网络/加速器',
            'GC_TIMEOUT',
          ));
        }, options.gcTimeout || 45000);
        if (typeof timer.unref === 'function') {
          timer.unref();
        }
        const onConnected = () => {
          cleanup();
          resolve();
        };
        const onDisconnected = () => {
          cleanup();
          reject(createError('Steam 连接已断开，请重试', 'STEAM_DISCONNECTED'));
        };
        const onGcError = (err) => {
          cleanup();
          reject(friendlySteamError(err, '连接 CS2 Game Coordinator 失败'));
        };
        const cleanup = () => {
          clearTimeout(timer);
          go.removeListener('connectedToGC', onConnected);
          go.removeListener('error', onGcError);
          client.removeListener('disconnected', onDisconnected);
        };
        go.once('connectedToGC', onConnected);
        go.once('error', onGcError);
        client.once('disconnected', onDisconnected);
      });

      const personaName = client.accountInfo?.name || null;
      this._saveAccountInfo(steamID, personaName, session, latestToken);

      return await fn({client, go, steamID, personaName});
    } catch (err) {
      if (err && ['NOT_LOGGED_IN', 'CS2_RUNNING_SYNC', 'GC_TIMEOUT', 'STEAM_NETWORK',
        'LOGGED_IN_ELSEWHERE', 'SESSION_EXPIRED', 'RATE_LIMITED', 'STEAM_UNAVAILABLE',
        'STEAM_DISCONNECTED', 'STEAM_GUARD_REQUIRED'].includes(err.code)) {
        throw err;
      }
      throw friendlySteamError(err, 'Steam 操作失败');
    } finally {
      try {
        if (client.steamID) {
          const disconnected = waitForEvent(client, 'disconnected', 5000, {errorEvent: null})
            .catch(() => {});
          client.logOff();
          await disconnected;
        }
      } catch {
        // SteamUser may already be disconnected.
      }
      try {
        client.gamesPlayed([]);
      } catch {
        // ignore
      }
      client.removeAllListeners();
      client.on('error', () => {});
      try {
        go.removeAllListeners();
      } catch {
        // ignore
      }
      await sleep(50);
    }
  }

  _waitForMatchList(go, requestFn, timeoutMs = 25000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(createError('等待 CS2 比赛数据超时，请重试', 'GC_TIMEOUT'));
      }, timeoutMs);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
      const onMatchList = (matches) => {
        cleanup();
        resolve(Array.isArray(matches) ? matches : []);
      };
      const onError = (err) => {
        cleanup();
        reject(friendlySteamError(err, '获取比赛数据失败'));
      };
      const cleanup = () => {
        clearTimeout(timer);
        go.removeListener('matchList', onMatchList);
        go.removeListener('error', onError);
      };
      go.once('matchList', onMatchList);
      go.once('error', onError);
      try {
        requestFn();
      } catch (err) {
        cleanup();
        reject(friendlySteamError(err, '请求比赛数据失败'));
      }
    });
  }

  async requestRecentMatches({limit = 8} = {}) {
    return this.withGC(async ({go, steamID}) => {
      const steamID64 = steamID ? String(steamID) : '';
      const rawMatches = await this._waitForMatchList(go, () => {
        if (!/^7656119\d{10}$/.test(steamID64)) {
          throw createError('SteamID 无效，无法获取最近比赛', 'INVALID_STEAMID');
        }
        // globaloffensive returns undefined even when the request is sent successfully.
        go.requestRecentGames(steamID64);
      });
      const matches = [];
      for (const raw of rawMatches) {
        try {
          matches.push(normalizeMatch(raw, {source: 'recent'}));
        } catch {
          // Ignore malformed entries.
        }
      }
      matches.sort((a, b) => {
        const aTime = a.date ? Date.parse(a.date) : 0;
        const bTime = b.date ? Date.parse(b.date) : 0;
        return bTime - aTime;
      });
      return matches.slice(0, limit);
    });
  }

  async requestShareCode(shareCode) {
    const parsed = normalizeShareCodeInput(shareCode);
    return this.withGC(async ({go}) => {
      const rawMatches = await this._waitForMatchList(go, () => {
        go.requestGame(parsed.shareCode);
      });
      if (rawMatches.length === 0) {
        throw createError('分享代码无效，或该比赛不存在', 'MATCH_NOT_FOUND');
      }
      let raw = rawMatches.find((item) => String(item.matchid) === parsed.matchId);
      if (!raw) {
        raw = rawMatches[0];
      }
      const match = normalizeMatch(raw, {source: 'sharecode'});
      if (!match.shareCode) {
        match.shareCode = parsed.shareCode;
      }
      return match;
    });
  }

  async dispose() {
    this._disposed = true;
    this._cancelPendingLogin();
    await this._gcQueue.catch(() => {});
  }
}

module.exports = {
  SteamService,
  friendlySteamError,
  createError,
};

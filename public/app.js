'use strict';

/**
 * CS2 录像中心前端。
 * 无构建步骤、无第三方依赖，直接通过本地 HTTP API 与 Node 服务通信。
 */
(() => {
  const ACTIVE_LOGIN_PHASES = new Set(['starting', 'waiting', 'needGuard']);
  const VIEW_TITLES = {matches: '比赛库', tasks: '下载任务', settings: '设置'};
  const PLATFORM_LABELS = {win32: 'Windows', linux: 'Linux', darwin: 'macOS'};
  const MAP_HUES = {
    de_dust2: 38,
    de_mirage: 42,
    de_inferno: 8,
    de_nuke: 208,
    de_ancient: 158,
    de_anubis: 188,
    de_vertigo: 218,
    de_overpass: 112,
    de_train: 20,
    de_cache: 278,
    de_cobblestone: 96,
    de_tuscan: 30,
  };

  const state = {
    app: null,
    config: null,
    environment: null,
    session: {loggedIn: false},
    login: null,
    status: null,
    matches: [],
    stats: {total: 0, downloaded: 0, missing: 0, corrupted: 0, bytes: 0},
    tasks: [],
    taskMap: new Map(),
    expectedTaskIds: new Set(),
    notifiedTaskIds: new Set(),
    taskBaselineReady: false,
    tasksClearedAt: 0,
    clearedTaskIds: new Set(),
    suppressTaskNotificationsUntil: 0,
    lastTasksAt: 0,
    view: 'matches',
    filter: 'all',
    search: '',
    matchesLoaded: false,
    statusLoaded: false,
    serverOnline: null,
    polling: false,
    pollTimer: null,
    statusSeq: 0,
    matchesSeq: 0,
    lastStatusAt: 0,
    lastMatchesAt: 0,
    syncBusy: false,
    downloadAllBusy: false,
    shareBusy: false,
    clearingTasks: false,
    refreshing: false,
    refreshBusy: false,
    savingSettings: false,
    settingsDirty: false,
    settingsNoteTimer: null,
    searchTimer: null,
    loginModalOpen: false,
    loginMode: 'qr',
    loginBusy: false,
    loginAwaitingSuccess: false,
    loginFinishing: false,
    relogin: false,
    qrAutoStarted: false,
    loginEpoch: 0,
    loginPollTimer: null,
    loginErrorKey: null,
    loginSuccessKey: null,
    gcBusy: false,
    demoDirWritable: true,
    confirmAction: null,
    miniTask: null,
    miniDismissedId: null,
    miniHideTimer: null,
    matchesRefreshTimer: null,
    lastFocus: null,
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  let lastToast = {message: '', at: 0};

  /* ---------- DOM / 格式化工具 ---------- */

  function h(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === null || value === undefined || value === false) {
        continue;
      }
      if (key === 'class') {
        node.className = value;
      } else if (key === 'text') {
        node.textContent = value;
      } else if (key === 'dataset') {
        Object.assign(node.dataset, value);
      } else if (key === 'style') {
        Object.assign(node.style, value);
      } else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (value === true) {
        node.setAttribute(key, '');
      } else {
        node.setAttribute(key, value);
      }
    }
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) {
        continue;
      }
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function icon(name, className) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    if (className) {
      svg.setAttribute('class', className);
    }
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
  }

  function badge(text, tone, iconName) {
    return h(
      'span',
      {class: `badge badge-${tone || 'muted'}`},
      iconName ? icon(iconName) : null,
      h('span', {text}),
    );
  }

  function formatBytes(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value <= 0) {
      return '0 B';
    }
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = value;
    let index = 0;
    while (size >= 1024 && index < units.length - 1) {
      size /= 1024;
      index += 1;
    }
    const digits = size >= 100 || index === 0 ? 0 : 1;
    return `${size.toFixed(digits)} ${units[index]}`;
  }

  function formatDateTime(value) {
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) {
      return '时间未知';
    }
    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startDate = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const dayDiff = Math.round((startToday - startDate) / 86400000);
    const time = new Intl.DateTimeFormat('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date);
    if (dayDiff === 0) {
      return `今天 ${time}`;
    }
    if (dayDiff === 1) {
      return `昨天 ${time}`;
    }
    if (date.getFullYear() === now.getFullYear()) {
      return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
    }
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
  }

  function formatRelative(value) {
    const timestamp = value ? Date.parse(value) : NaN;
    if (!Number.isFinite(timestamp)) {
      return '';
    }
    const diff = Math.max(0, Date.now() - timestamp);
    if (diff < 60000) {
      return '刚刚';
    }
    if (diff < 3600000) {
      return `${Math.floor(diff / 60000)} 分钟前`;
    }
    if (diff < 86400000) {
      return `${Math.floor(diff / 3600000)} 小时前`;
    }
    return formatDateTime(value);
  }

  function formatDuration(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    if (!total) {
      return '';
    }
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    return `${minutes}:${String(secs).padStart(2, '0')}`;
  }

  function mapHue(mapName) {
    if (MAP_HUES[mapName]) {
      return MAP_HUES[mapName];
    }
    let hash = 0;
    for (const char of String(mapName || '')) {
      hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
    }
    return Math.abs(hash) % 360;
  }

  function isLoginActive(phase) {
    return ACTIVE_LOGIN_PHASES.has(phase);
  }

  function isModalOpen(id) {
    const modal = document.getElementById(id);
    return Boolean(modal && !modal.hidden);
  }

  function anyModalOpen() {
    return $$('.modal-backdrop').some((modal) => !modal.hidden);
  }

  function sessionName(session) {
    const value = session || {};
    return value.personaName || value.accountName || (value.steamID ? 'Steam 用户' : 'Steam 账号');
  }

  function accountSub(session) {
    if (session?.steamID) {
      return `Steam ID ${session.steamID}`;
    }
    if (session?.accountName) {
      return session.accountName;
    }
    return session?.savedAt ? '登录凭据已保存' : '已登录 Steam';
  }

  function currentMatch(matchId) {
    return state.matches.find((match) => String(match.matchId) === String(matchId)) || null;
  }

  /* ---------- API ---------- */

  async function api(path, {method = 'GET', body} = {}) {
    const options = {
      method,
      headers: {Accept: 'application/json'},
      cache: 'no-store',
    };
    if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    let response;
    try {
      response = await fetch(path, options);
    } catch (cause) {
      const err = new Error('无法连接本地服务，请确认 CS2 录像中心仍在运行');
      err.code = 'NETWORK';
      err.cause = cause;
      throw err;
    }
    let data = null;
    try {
      data = await response.json();
    } catch {
      // 响应不是 JSON。
    }
    if (!response.ok) {
      const err = new Error(data?.error?.message || `请求失败（HTTP ${response.status}）`);
      err.code = data?.error?.code || 'HTTP_ERROR';
      err.status = response.status;
      throw err;
    }
    setServerOnline(true);
    return data;
  }

  function setServerOnline(online) {
    state.serverOnline = online;
    const dot = $('#server-dot');
    const note = $('#server-note');
    if (dot) {
      dot.classList.toggle('is-online', online);
      dot.classList.toggle('is-offline', !online);
    }
    if (note) {
      note.textContent = online ? '本地服务已连接' : '本地服务连接失败';
    }
  }

  function toast(kind, message, {duration = 4300} = {}) {
    const text = String(message || '').trim();
    if (!text) {
      return;
    }
    const now = Date.now();
    if (lastToast.message === text && now - lastToast.at < 1200) {
      return;
    }
    lastToast = {message: text, at: now};
    const container = $('#toasts');
    if (!container) {
      return;
    }
    while (container.children.length >= 2) {
      container.firstElementChild.remove();
    }
    const iconNames = {success: 'check', error: 'alert', warn: 'alert', info: 'alert'};
    const node = h(
      'div',
      {class: `toast toast-${kind}`},
      icon(iconNames[kind] || 'alert'),
      h('span', {text}),
    );
    container.append(node);
    let removed = false;
    const remove = () => {
      if (removed) {
        return;
      }
      removed = true;
      node.classList.add('is-hiding');
      setTimeout(() => node.remove(), 220);
    };
    const timer = setTimeout(remove, duration);
    node.addEventListener('click', () => {
      clearTimeout(timer);
      remove();
    });
  }

  function handleActionError(err, fallback) {
    if (err?.status) {
      setServerOnline(true);
    } else if (err?.code === 'NETWORK') {
      setServerOnline(false);
    }
    const code = err?.code;
    if (code === 'NOT_LOGGED_IN' || code === 'SESSION_EXPIRED') {
      toast('warn', code === 'SESSION_EXPIRED' ? 'Steam 登录已失效，请重新登录' : (err.message || '请先登录 Steam'));
      openLoginModal();
      return;
    }
    if (code === 'CS2_RUNNING' || code === 'CS2_RUNNING_SYNC') {
      toast('warn', err.message || 'CS2 正在运行，请先完全退出游戏');
      loadStatus({quiet: true});
      return;
    }
    if (code === 'CS2_NOT_FOUND' || code === 'STEAM_NOT_FOUND') {
      toast('warn', err.message || fallback);
      showView('settings');
      return;
    }
    toast(code === 'LOGGED_IN_ELSEWHERE' ? 'warn' : 'error', err?.message || fallback);
  }

  /* ---------- 弹窗 ---------- */

  function openModal(id) {
    const modal = document.getElementById(id);
    if (!modal) {
      return;
    }
    if (!anyModalOpen()) {
      state.lastFocus = document.activeElement;
    }
    modal.hidden = false;
    document.body.classList.add('has-modal');
    const focusable = modal.querySelector('input:not([disabled]):not([hidden]), button:not([disabled])');
    setTimeout(() => {
      try {
        focusable?.focus();
      } catch {
        // ignore
      }
    }, 40);
  }

  function closeModal(id) {
    const modal = document.getElementById(id);
    if (!modal) {
      return;
    }
    modal.hidden = true;
    if (id === 'confirm-modal') {
      state.confirmAction = null;
    }
    if (!anyModalOpen()) {
      document.body.classList.remove('has-modal');
      const target = state.lastFocus;
      state.lastFocus = null;
      if (target && target.isConnected) {
        setTimeout(() => {
          try {
            target.focus();
          } catch {
            // ignore
          }
        }, 0);
      }
    }
  }

  function askConfirm({title, text, okLabel = '确认', danger = true, onConfirm}) {
    const titleEl = $('#confirm-title');
    const textEl = $('#confirm-text');
    const okBtn = $('#confirm-ok');
    if (!titleEl || !textEl || !okBtn) {
      return;
    }
    titleEl.textContent = title;
    textEl.textContent = text;
    okBtn.textContent = okLabel;
    okBtn.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
    state.confirmAction = onConfirm;
    openModal('confirm-modal');
    setTimeout(() => okBtn.focus(), 50);
  }

  async function runConfirmAction() {
    const action = state.confirmAction;
    state.confirmAction = null;
    closeModal('confirm-modal');
    if (!action) {
      return;
    }
    try {
      await action();
    } catch (err) {
      handleActionError(err, '操作失败');
    }
  }

  /* ---------- 状态与账号渲染 ---------- */

  function setPill(node, tone, text, title) {
    if (!node) {
      return;
    }
    node.classList.remove('is-ok', 'is-warn', 'is-danger');
    if (tone) {
      node.classList.add(`is-${tone}`);
    }
    const label = node.querySelector('span');
    if (label) {
      label.textContent = text;
    }
    if (title) {
      node.title = title;
    }
  }

  function renderStatus() {
    const app = state.app || {};
    const config = state.config || {};
    const env = state.environment || {};
    const session = state.session || {loggedIn: false};
    const loggedIn = Boolean(session.loggedIn);
    const mock = Boolean(app.mock);
    const name = sessionName(session);
    const cs2 = env.cs2 || {};
    const running = Boolean(env.cs2Running);
    const platform = PLATFORM_LABELS[app.platform || env.platform] || app.platform || env.platform || '';

    if ($('#version-label')) {
      $('#version-label').textContent = app.version ? `v${app.version}` : 'v1.0.0';
    }
    if ($('#footer-env')) {
      $('#footer-env').textContent = [platform, app.node ? `Node ${app.node}` : ''].filter(Boolean).join(' · ');
    }
    if ($('#mock-banner')) {
      $('#mock-banner').hidden = !mock;
    }
    if ($('#mock-help')) {
      $('#mock-help').hidden = !mock;
    }

    setPill(
      $('#cs2-pill'),
      running ? 'warn' : (cs2.detected ? 'ok' : 'danger'),
      running ? 'CS2 运行中' : (cs2.detected ? 'CS2 已就绪' : '未找到 CS2'),
      running
        ? 'CS2 正在运行：同步比赛需先退出；播放会改为导入录像并复制控制台命令'
        : (cs2.csgoPath || '点击前往设置检测 CS2 目录'),
    );
    setPill(
      $('#steam-pill'),
      loggedIn ? 'ok' : 'warn',
      loggedIn ? name : '未登录 Steam',
      loggedIn ? accountSub(session) : '点击扫码登录 Steam',
    );

    const loginBtn = $('#login-btn');
    if (loginBtn) {
      const label = loginBtn.querySelector('span');
      if (label) {
        label.textContent = loggedIn ? '账号' : '登录 Steam';
      }
      loginBtn.title = loggedIn ? `Steam：${name}` : '登录 Steam';
      loginBtn.classList.toggle('btn-primary', !loggedIn);
      loginBtn.classList.toggle('btn-secondary', loggedIn);
    }

    const avatar = $('#account-avatar');
    if (avatar) {
      avatar.classList.toggle('is-logged-in', loggedIn);
    }
    if ($('#account-name')) {
      $('#account-name').textContent = loggedIn ? name : '未登录 Steam';
    }
    if ($('#account-sub')) {
      $('#account-sub').textContent = loggedIn
        ? (mock ? '预览模式 · 点击管理' : accountSub(session))
        : '点击扫码登录';
    }

    if ($('#config-path-badge')) {
      const configPath = config.configPath || '';
      $('#config-path-badge').textContent = configPath ? configPath.split(/[\\/]/).pop() : 'config.json';
      $('#config-path-badge').title = configPath;
    }

    renderEnvironment();
    renderAccountPanel();
    renderLogin();
    updateToolbarState();
    renderCounts();
  }

  function renderEnvironment() {
    const list = $('#env-list');
    if (!list) {
      return;
    }
    const app = state.app || {};
    const config = state.config || {};
    const env = state.environment || {};
    const cs2 = env.cs2 || {};
    const platform = PLATFORM_LABELS[app.platform || env.platform] || app.platform || env.platform || '未知';
    const rows = [
      ['运行平台', `${platform} · ${app.node || env.node || '未知 Node.js'}`, ''],
      ['CS2 目录', cs2.detected ? `${cs2.csgoPath}${cs2.source === 'config' ? '（设置指定）' : '（自动检测）'}` : '未检测到', cs2.detected ? 'ok' : 'bad'],
      ['CS2 进程', env.cs2Running ? '正在运行（同步受限；播放改为导入命令）' : '未运行', env.cs2Running ? 'warn' : 'ok'],
      ['Steam 客户端', env.steamPath || '未检测到', env.steamPath ? 'ok' : 'warn'],
      ['录像目录', `${config.demoDir || '未知'}${state.demoDirWritable ? '' : '（不可写）'}`, state.demoDirWritable ? 'ok' : 'bad'],
      ['replays 目录', cs2.replaysPath || '未检测到', cs2.replaysPath ? 'ok' : 'warn'],
      ['网页端口', `${config.port || '未知'}（仅监听 127.0.0.1）`, 'ok'],
      ['配置目录', config.configDir || '未知', ''],
    ];
    list.replaceChildren();
    for (const [label, value, tone] of rows) {
      const dd = h('dd', {text: value, title: value});
      if (tone) {
        dd.classList.add(`is-${tone}`);
      }
      list.append(h('div', {class: 'env-row'}, h('dt', {text: label}), dd));
    }
  }

  function renderAccountPanel() {
    const panel = $('#settings-account');
    if (!panel) {
      return;
    }
    const session = state.session || {loggedIn: false};
    const loggedIn = Boolean(session.loggedIn);
    const mock = Boolean(state.app?.mock);
    const name = loggedIn ? sessionName(session) : '尚未登录 Steam';
    const detail = loggedIn
      ? (mock ? `${session.steamID || '预览模式'} · 模拟账号` : (session.steamID ? `Steam ID ${session.steamID}` : accountSub(session)))
      : '扫码登录后可同步最近比赛与分享代码。';
    const button = h('button', {
      class: 'btn btn-secondary btn-sm',
      type: 'button',
      text: loggedIn ? '管理账号' : '登录 Steam',
    });
    button.addEventListener('click', openLoginModal);
    panel.replaceChildren(
      h('span', {class: 'login-avatar'}, icon('user')),
      h('div', {class: 'account-panel-info'}, h('strong', {text: name}), h('span', {text: detail})),
      button,
    );
  }

  function qrExpired(login) {
    return Boolean(
      login
      && isLoginActive(login.phase)
      && login.expiresAt
      && Date.now() > Number(login.expiresAt),
    );
  }

  function renderLogin() {
    const modal = $('#login-modal');
    if (!modal) {
      return;
    }
    const session = state.session || {loggedIn: false};
    const login = state.login || {phase: 'idle'};
    const loggedIn = Boolean(session.loggedIn);
    const showFlow = !loggedIn || state.relogin;
    const active = isLoginActive(login.phase);
    const mode = state.loginMode;
    const expired = qrExpired(login);

    if ($('#login-logged-in')) {
      $('#login-logged-in').hidden = !(loggedIn && !state.relogin);
    }
    if ($('#login-flow')) {
      $('#login-flow').hidden = !showFlow;
    }
    if ($('#login-account-name')) {
      $('#login-account-name').textContent = sessionName(session);
    }
    if ($('#login-account-id')) {
      $('#login-account-id').textContent = [
        session.steamID ? `Steam ID ${session.steamID}` : null,
        state.app?.mock ? '预览模式' : null,
      ].filter(Boolean).join(' · ');
    }

    const title = $('#login-title');
    const subtitle = $('#login-modal .modal-head p');
    if (loggedIn && !state.relogin) {
      if (title) {
        title.textContent = 'Steam 账号';
      }
      if (subtitle) {
        subtitle.textContent = '登录凭据只保存在本机，密码从未被保存。';
      }
    } else if (state.relogin) {
      if (title) {
        title.textContent = '重新连接 Steam';
      }
      if (subtitle) {
        subtitle.textContent = '当前账号的登录凭据需要更新，或你想切换到其他账号。';
      }
    } else {
      if (title) {
        title.textContent = '连接 Steam';
      }
      if (subtitle) {
        subtitle.textContent = '扫码登录最安全，无需在网页中输入密码。';
      }
    }

    $$('#login-tabs button').forEach((button) => {
      button.classList.toggle('is-active', button.dataset.mode === mode);
      button.disabled = active || state.loginBusy;
    });
    if ($('#login-pane-qr')) {
      $('#login-pane-qr').hidden = mode !== 'qr';
    }
    if ($('#login-pane-password')) {
      $('#login-pane-password').hidden = mode !== 'password';
    }

    const qrImage = $('#qr-image');
    const qrPlaceholder = $('#qr-placeholder');
    const qrExpiredNode = $('#qr-expired');
    const hasQr = Boolean(login.qrDataUrl) && login.kind === 'qr' && !['idle', 'error'].includes(login.phase);
    if (qrImage) {
      if (hasQr) {
        qrImage.src = login.qrDataUrl;
        qrImage.hidden = false;
      } else {
        qrImage.hidden = true;
        qrImage.removeAttribute('src');
      }
    }
    if (qrPlaceholder) {
      qrPlaceholder.hidden = hasQr;
      const text = qrPlaceholder.querySelector('span');
      if (text) {
        if (login.phase === 'starting' && login.kind === 'qr') {
          text.textContent = '正在获取 Steam 登录二维码…';
        } else if (login.phase === 'waiting' && login.kind === 'qr' && !hasQr) {
          text.textContent = '二维码生成失败，请点击下方按钮重试';
        } else {
          text.textContent = '点击下方按钮生成登录二维码';
        }
      }
    }
    if (qrExpiredNode) {
      qrExpiredNode.hidden = !(mode === 'qr' && (expired || (login.phase === 'error' && login.kind === 'qr')));
    }

    const qrStartBtn = $('#qr-start-btn');
    if (qrStartBtn) {
      qrStartBtn.disabled = state.loginBusy || (login.phase === 'starting' && login.kind === 'qr');
      if (login.phase === 'starting' && login.kind === 'qr') {
        qrStartBtn.textContent = '正在生成…';
      } else if (expired || (login.phase === 'error' && login.kind === 'qr')) {
        qrStartBtn.textContent = '重新生成二维码';
      } else if (login.phase === 'waiting' && login.kind === 'qr') {
        qrStartBtn.textContent = '刷新二维码';
      } else {
        qrStartBtn.textContent = '生成登录二维码';
      }
    }

    const accountInput = $('#login-account-input');
    const passwordInput = $('#login-password-input');
    const guardInput = $('#login-guard-input');
    const guardField = $('#guard-field');
    const codeFieldVisible = login.phase === 'needGuard' && login.canSubmitCode;
    if (accountInput) {
      accountInput.disabled = active || state.loginBusy;
    }
    if (passwordInput) {
      passwordInput.disabled = active || state.loginBusy;
    }
    if (guardField) {
      guardField.hidden = !codeFieldVisible;
    }
    if (guardInput) {
      guardInput.disabled = !codeFieldVisible || state.loginBusy;
    }

    const passwordBtn = $('#password-login-btn');
    const guardBtn = $('#guard-submit-btn');
    if (passwordBtn) {
      passwordBtn.hidden = codeFieldVisible;
      passwordBtn.disabled = active || state.loginBusy;
      if (state.loginBusy) {
        passwordBtn.textContent = '登录中…';
      } else if (login.phase === 'waiting' && login.kind === 'password') {
        passwordBtn.textContent = '等待 Steam 确认…';
      } else {
        passwordBtn.textContent = '登录';
      }
    }
    if (guardBtn) {
      guardBtn.hidden = !codeFieldVisible;
      guardBtn.disabled = state.loginBusy;
      guardBtn.textContent = state.loginBusy ? '提交中…' : '提交验证码';
    }

    const statusNode = $('#login-status');
    const statusText = $('#login-status-text');
    const spinner = $('#login-spinner');
    const showStatus = showFlow && ['starting', 'waiting', 'needGuard', 'error'].includes(login.phase) && Boolean(login.message);
    if (statusNode) {
      statusNode.hidden = !showStatus;
      statusNode.classList.toggle('is-error', login.phase === 'error');
    }
    if (statusText) {
      let text = login.message || '';
      if (login.canSubmitCode && Array.isArray(login.actions) && login.actions.length > 0) {
        const labels = login.actions.map((action) => action.label).filter(Boolean);
        if (labels.length > 0) {
          text += ` · 可用方式：${labels.join(' / ')}`;
        }
      }
      statusText.textContent = text;
    }
    if (spinner) {
      spinner.hidden = login.phase === 'error';
    }

    const cancelBtn = $('#login-cancel-btn');
    if (cancelBtn) {
      cancelBtn.textContent = state.relogin && loggedIn ? '返回账号' : '取消';
    }
  }

  /* ===== MATCHES ===== */

  function applyStats(stats) {
    const value = stats && typeof stats === 'object' ? stats : {};
    state.stats = {
      total: Number(value.total) || 0,
      downloaded: Number(value.downloaded) || 0,
      missing: Number(value.missing) || 0,
      corrupted: Number(value.corrupted) || 0,
      bytes: Number(value.bytes) || 0,
    };
    if ($('#stat-total')) {
      $('#stat-total').textContent = String(state.stats.total);
    }
    if ($('#stat-downloaded')) {
      $('#stat-downloaded').textContent = String(state.stats.downloaded);
    }
    if ($('#stat-pending')) {
      const pending = Math.max(0, state.stats.total - state.stats.downloaded);
      $('#stat-pending').textContent = String(pending);
      $('#stat-pending').title = `未下载 ${Math.max(0, pending - state.stats.missing - state.stats.corrupted)} · 丢失 ${state.stats.missing} · 损坏 ${state.stats.corrupted}`;
    }
    if ($('#stat-bytes')) {
      $('#stat-bytes').textContent = formatBytes(state.stats.bytes);
      $('#stat-bytes').title = `${state.stats.bytes} 字节`;
    }
    renderCounts();
  }

  function renderCounts() {
    const total = Math.max(state.stats.total || 0, state.matches.length);
    const active = state.tasks.filter((task) => task.state === 'running').length;
    $$('[data-count="matches"]').forEach((node) => {
      node.textContent = String(total);
      node.hidden = total === 0;
    });
    $$('[data-count="tasks"]').forEach((node) => {
      node.textContent = String(active);
      node.hidden = active === 0;
    });
  }

  function updateToolbarState() {
    const cs2Running = Boolean(state.environment?.cs2Running);
    const busy = state.syncBusy;
    const syncBtn = $('#sync-btn');
    const syncDownloadBtn = $('#sync-download-btn');
    const shareBtn = $('#share-btn');
    const downloadAllBtn = $('#download-all-btn');
    const blocked = busy || cs2Running || Boolean(state.gcBusy);

    if (syncBtn) {
      syncBtn.disabled = blocked;
      syncBtn.classList.toggle('is-loading', busy);
      const label = syncBtn.querySelector('span');
      if (label) {
        label.textContent = busy ? '正在同步…' : '同步最近比赛';
      }
      syncBtn.title = cs2Running ? '请先完全退出 CS2 后再同步' : '通过 Steam 获取最近 8 场比赛';
    }
    if (syncDownloadBtn) {
      syncDownloadBtn.disabled = blocked;
      syncDownloadBtn.classList.toggle('is-loading', busy);
      syncDownloadBtn.title = busy
        ? '正在同步…'
        : (cs2Running ? '请先完全退出 CS2 后再同步' : '同步最近比赛并下载全部录像');
    }
    if (shareBtn) {
      shareBtn.disabled = blocked;
      shareBtn.title = cs2Running
        ? '请先完全退出 CS2 后再查询分享代码'
        : (busy ? '正在同步…' : '通过分享代码添加比赛');
    }
    if (downloadAllBtn) {
      const hasPending = state.matches.some((match) => !match.downloaded && match.demoUrl);
      downloadAllBtn.disabled = busy || Boolean(state.downloadAllBusy) || !hasPending;
      downloadAllBtn.title = hasPending ? '下载全部尚未下载的录像' : '没有需要下载的录像';
      downloadAllBtn.classList.toggle('is-loading', Boolean(state.downloadAllBusy));
    }
    renderCounts();
  }

  function matchTask(matchId) {
    return state.tasks.find(
      (task) => task.state === 'running' && task.matchId && String(task.matchId) === String(matchId),
    ) || null;
  }

  function filteredMatches() {
    const query = state.search.trim().toLowerCase();
    return state.matches.filter((match) => {
      if (state.filter === 'downloaded' && !match.downloaded) {
        return false;
      }
      if (state.filter === 'pending' && (match.downloaded || match.corrupted || match.missing)) {
        return false;
      }
      if (state.filter === 'broken' && !match.corrupted && !match.missing) {
        return false;
      }
      if (!query) {
        return true;
      }
      const haystack = [
        match.map,
        match.mapName,
        match.mapLabel,
        match.mode,
        match.matchId,
        match.shareCode,
        match.fileName,
        match.title,
        match.scoreCT,
        match.scoreT,
      ].filter((value) => value !== null && value !== undefined).join(' ').toLowerCase();
      return haystack.includes(query);
    });
  }

  function progressBar(value, indeterminate = false) {
    const bar = h('div', {class: `progress${indeterminate ? ' is-indeterminate' : ''}`});
    const fill = h('span');
    const percent = Math.max(0, Math.min(100, Number(value) || 0));
    fill.style.width = `${percent}%`;
    bar.append(fill);
    return bar;
  }

  function emptyState({iconName = 'list', title, text, actions = []}) {
    const row = h('div', {class: 'btn-row'});
    for (const action of actions) {
      row.append(h(
        'button',
        {
          class: `btn ${action.primary ? 'btn-primary' : 'btn-secondary'}`,
          type: 'button',
          dataset: {action: action.action, id: action.id || ''},
        },
        action.icon ? icon(action.icon) : null,
        h('span', {text: action.label}),
      ));
    }
    return h(
      'div',
      {class: 'empty-state'},
      h('div', {class: 'empty-icon'}, icon(iconName)),
      h('h3', {text: title}),
      h('p', {text}),
      row,
    );
  }

  function iconButton(iconName, title, action, id, {danger = false, disabled = false} = {}) {
    return h(
      'button',
      {
        class: `icon-btn${danger ? ' danger' : ''}`,
        type: 'button',
        title,
        'aria-label': title,
        dataset: {action, id: id || ''},
        disabled,
      },
      icon(iconName),
    );
  }

  function matchStatusBadge(match, task) {
    if (task) {
      return badge('任务进行中', 'info');
    }
    if (match.downloaded) {
      return badge('已下载', 'success', 'check');
    }
    if (match.corrupted) {
      return badge('文件损坏', 'danger', 'alert');
    }
    if (match.missing) {
      return badge('文件丢失', 'warn', 'alert');
    }
    return badge('未下载', 'muted');
  }

  function buildMatchCard(match) {
    const task = matchTask(match.matchId);
    const broken = Boolean(match.corrupted || match.missing);
    const cs2Running = Boolean(state.environment?.cs2Running);
    const classes = ['match-card'];
    if (task) {
      classes.push('is-running');
    }
    if (broken) {
      classes.push('is-broken');
    }
    const card = h('article', {
      class: classes.join(' '),
      dataset: {matchId: String(match.matchId)},
      title: match.title || `${match.mapName || match.map} · ${formatDateTime(match.date)}`,
    });
    card.style.setProperty('--map-hue', String(mapHue(match.map)));

    const visual = h(
      'div',
      {class: 'map-visual'},
      h('span', {class: 'map-mode', text: match.mode || 'CS2'}),
      h('span', {class: 'map-big', text: match.mapName || '未知地图'}),
      h('span', {class: 'map-code', text: match.map || 'unknown'}),
    );

    const heading = h(
      'div',
      {class: 'match-heading'},
      h('h3', {text: match.mapName || '未知地图'}),
      h('span', {class: 'match-map-code', text: match.map ? `(${match.map})` : ''}),
      matchStatusBadge(match, task),
    );

    const meta = h('div', {class: 'match-meta'});
    meta.append(h('span', {}, icon('clock'), formatDateTime(match.date)));
    if (Number.isInteger(match.scoreCT) && Number.isInteger(match.scoreT)) {
      meta.append(h('span', {}, icon('list'), '比分 ', h('b', {text: `${match.scoreCT} : ${match.scoreT}`})));
    }
    if (match.duration) {
      meta.append(h('span', {}, icon('clock'), h('b', {text: formatDuration(match.duration)})));
    }
    if (match.rounds) {
      meta.append(h('span', {}, icon('gamepad'), `共 ${match.rounds} 回合`));
    }

    const extra = h('div', {class: 'match-extra'});
    extra.append(h('span', {
      class: 'match-id',
      text: `ID ${match.matchId}`,
      title: String(match.matchId),
      style: {maxWidth: '46%'},
    }));
    const copyLabel = match.shareCode ? '复制分享代码' : '复制比赛 ID';
    extra.append(h(
      'button',
      {
        class: 'copy-btn',
        type: 'button',
        title: copyLabel,
        'aria-label': copyLabel,
        dataset: {action: 'copy', id: String(match.matchId)},
      },
      icon('copy'),
      copyLabel,
    ));
    if (match.fileName) {
      extra.append(h('span', {
        class: 'match-id',
        text: match.fileName,
        title: match.fileName,
        style: {maxWidth: '46%'},
      }));
    }
    if (match.size) {
      extra.append(h('span', {class: 'match-id', text: formatBytes(match.size), title: `${match.size} 字节`}));
    }

    const body = h('div', {class: 'match-body'}, heading, meta, extra);
    if (task) {
      const percent = Math.max(0, Math.min(100, Number(task.progress) || 0));
      body.append(h(
        'div',
        {class: 'match-progress'},
        progressBar(percent, percent <= 0),
        h(
          'div',
          {class: 'match-progress-text'},
          h('span', {text: task.message || '处理中…'}),
          h('span', {text: `${percent}%`}),
        ),
      ));
    }

    const actions = h('div', {class: 'match-actions'});
    const hasDemo = Boolean(match.downloaded || match.demoUrl);
    const playDisabled = Boolean(task) || !hasDemo;
    let playLabel = match.downloaded ? '播放' : '下载并播放';
    let playTitle = match.downloaded ? '将录像暂存到 CS2 并启动播放' : '先下载录像，再启动 CS2 播放';
    if (!hasDemo) {
      playTitle = '缺少录像下载链接，请重新同步比赛或使用分享代码';
    } else if (cs2Running) {
      playLabel = match.downloaded ? '导入并复制命令' : '下载并导入';
      playTitle = 'CS2 正在运行：将录像放入 replays，并复制控制台播放命令；请在 CS2 主菜单执行';
    }
    if (task) {
      playTitle = task.message || '任务正在进行中';
    }
    actions.append(h(
      'button',
      {
        class: 'btn btn-primary btn-play',
        type: 'button',
        title: playTitle,
        dataset: {action: 'play', id: String(match.matchId)},
        disabled: playDisabled,
      },
      icon('play'),
      h('span', {text: playLabel}),
    ));

    if (!match.downloaded || broken) {
      const downloadDisabled = Boolean(task) || !match.demoUrl;
      actions.append(h(
        'button',
        {
          class: 'btn btn-secondary',
          type: 'button',
          title: !match.demoUrl ? '缺少录像下载链接，请重新同步比赛' : (broken ? '重新下载并覆盖异常文件' : '下载录像到本地'),
          dataset: {action: 'download', id: String(match.matchId)},
          disabled: downloadDisabled,
        },
        icon('download'),
        h('span', {text: broken ? '重新下载' : '下载'}),
      ));
    }
    if (match.downloaded) {
      actions.append(iconButton('folder', '打开录像所在位置', 'reveal', match.matchId, {disabled: Boolean(task)}));
    }
    actions.append(iconButton('trash', cs2Running ? '请先退出 CS2 再删除' : '删除录像与比赛记录', 'delete', match.matchId, {
      danger: true,
      disabled: Boolean(task) || cs2Running,
    }));

    card.append(visual, body, actions);
    return card;
  }

  function renderMatches() {
    const list = $('#match-list');
    if (!list || !state.matchesLoaded) {
      return;
    }
    const visible = filteredMatches();
    const total = state.stats.total || state.matches.length;
    const summary = $('#list-summary');
    if (summary) {
      if (total === 0) {
        summary.textContent = '共 0 场比赛';
      } else if (visible.length === total) {
        summary.textContent = `共 ${total} 场比赛 · 已下载 ${state.stats.downloaded} 场`;
      } else {
        summary.textContent = `共 ${total} 场比赛 · 当前显示 ${visible.length} 场`;
      }
    }

    if (state.matches.length === 0) {
      const loggedIn = Boolean(state.session?.loggedIn);
      list.replaceChildren(emptyState({
        iconName: 'list',
        title: '还没有比赛记录',
        text: loggedIn
          ? '点击「同步最近比赛」从 Steam 获取最近 8 场竞技记录，或添加一个分享代码。'
          : '登录 Steam 后可以同步最近比赛，也可以使用分享代码添加指定比赛。',
        actions: loggedIn
          ? [
            {label: '同步最近比赛', action: 'sync', icon: 'refresh', primary: true},
            {label: '添加分享代码', action: 'share', icon: 'plus'},
          ]
          : [
            {label: '登录 Steam', action: 'login', icon: 'user', primary: true},
            {label: '刷新列表', action: 'retry-matches', icon: 'refresh'},
          ],
      }));
    } else if (visible.length === 0) {
      list.replaceChildren(emptyState({
        iconName: 'search',
        title: '没有符合条件的比赛',
        text: '试试更换筛选条件，或清空搜索关键词。',
        actions: [{label: '清空筛选', action: 'reset-filters', icon: 'x'}],
      }));
    } else {
      list.replaceChildren(...visible.map(buildMatchCard));
    }
    updateToolbarState();
    renderCounts();
  }

  function renderMatchesError(error) {
    const list = $('#match-list');
    if (!list) {
      return;
    }
    if ($('#list-summary')) {
      $('#list-summary').textContent = '比赛列表加载失败';
    }
    list.replaceChildren(emptyState({
      iconName: 'alert',
      title: '无法加载比赛列表',
      text: error?.message || '请确认本地服务仍在运行，然后重试。',
      actions: [
        {label: '重试', action: 'retry-matches', icon: 'refresh', primary: true},
        {label: '检查设置', action: 'open-settings', icon: 'settings'},
      ],
    }));
  }

  async function startSync(download) {
    if (state.syncBusy) {
      return;
    }
    if (!requireLogin()) {
      return;
    }
    if (state.environment?.cs2Running) {
      toast('warn', 'CS2 正在运行。同步比赛需要登录 Steam GC，请先完全退出游戏。');
      return;
    }
    if (state.gcBusy) {
      toast('warn', '正在与 Steam 通信，请等待当前操作完成。');
      return;
    }
    state.syncBusy = true;
    updateToolbarState();
    try {
      const data = await api('/api/sync', {method: 'POST', body: {download: Boolean(download)}});
      for (const queued of data.queued || []) {
        expectQueuedTask(queued.id);
      }
      const added = Number(data.added) || 0;
      const updated = Number(data.updated) || 0;
      let message = added + updated > 0
        ? `同步完成：新增 ${added} 场，更新 ${updated} 场`
        : '同步完成，没有新的比赛';
      if (data.queued?.length) {
        message += `，已加入 ${data.queued.length} 个下载任务`;
      }
      toast('success', message);
      await Promise.allSettled([
        loadMatches({quiet: true}),
        loadStatus({quiet: true}),
      ]);
      schedulePoll(700);
    } catch (err) {
      handleActionError(err, '同步比赛失败');
    } finally {
      state.syncBusy = false;
      updateToolbarState();
    }
  }

  async function downloadAll() {
    if (state.downloadAllBusy || state.syncBusy) {
      return;
    }
    state.downloadAllBusy = true;
    updateToolbarState();
    try {
      const data = await api('/api/download-all', {method: 'POST', body: {}});
      for (const item of data.started || []) {
        expectQueuedTask(item.id);
      }
      if (!data.count) {
        toast('info', '没有需要下载的录像');
      } else {
        toast('success', `已加入 ${data.count} 个下载任务`);
      }
      await loadMatches({quiet: true});
      schedulePoll(700);
    } catch (err) {
      handleActionError(err, '批量下载失败');
    } finally {
      state.downloadAllBusy = false;
      updateToolbarState();
    }
  }

  async function downloadMatch(matchId, button) {
    if (button?.dataset.busy === '1') {
      return;
    }
    if (button) {
      button.dataset.busy = '1';
      button.disabled = true;
    }
    try {
      const data = await api('/api/download', {method: 'POST', body: {matchId}});
      if (data.alreadyDownloaded) {
        toast('info', '录像已经存在');
        await loadMatches({quiet: true});
        return;
      }
      if (data.task) {
        registerStartedTask(data.task);
        toast('info', data.duplicate
          ? '该比赛已有下载任务'
          : `已开始下载：${data.task.label?.replace(/^下载录像\s*/, '') || '录像'}`);
      }
      schedulePoll(600);
    } catch (err) {
      handleActionError(err, '下载录像失败');
    } finally {
      if (button && button.isConnected) {
        button.disabled = false;
        delete button.dataset.busy;
      }
      updateToolbarState();
    }
  }

  async function playMatch(matchId, button) {
    if (button?.dataset.busy === '1') {
      return;
    }
    if (button) {
      button.dataset.busy = '1';
      button.disabled = true;
    }
    try {
      const data = await api('/api/play', {method: 'POST', body: {matchId}});
      if (data.task) {
        registerStartedTask(data.task);
        const action = state.environment?.cs2Running ? '正在准备导入录像…' : '正在准备播放…';
        toast('info', data.duplicate ? '该比赛已有任务' : action);
      }
      schedulePoll(500);
    } catch (err) {
      handleActionError(err, '播放失败');
    } finally {
      if (button && button.isConnected) {
        button.disabled = false;
        delete button.dataset.busy;
      }
      updateToolbarState();
    }
  }

  function confirmDeleteMatch(matchId) {
    const match = currentMatch(matchId);
    if (!match) {
      toast('error', '未找到该比赛，请刷新列表');
      return;
    }
    if (matchTask(matchId)) {
      toast('warn', '该比赛正在下载或播放，请等待任务完成后再删除');
      return;
    }
    if (state.environment?.cs2Running) {
      toast('warn', 'CS2 正在运行，请先退出游戏再删除录像');
      return;
    }
    const title = match.title || `${match.mapName || match.map || '比赛'} · ${formatDateTime(match.date)}`;
    const description = match.downloaded
      ? '将删除本地录像文件、CS2 replays 中的同名文件以及比赛记录。此操作不可撤销。'
      : '该比赛尚未下载，删除后会从列表和本地记录中移除。此操作不可撤销。';
    askConfirm({
      title: '删除录像',
      text: `「${title}」\n\n${description}`,
      okLabel: '确认删除',
      danger: true,
      onConfirm: async () => {
        const data = await api('/api/delete', {method: 'POST', body: {matchId}});
        state.matches = Array.isArray(data.matches) ? data.matches : state.matches.filter(
          (item) => String(item.matchId) !== String(matchId),
        );
        if (data.stats) {
          applyStats(data.stats);
        }
        state.matchesLoaded = true;
        renderMatches();
        toast('success', data.removedFile ? '录像与比赛记录已删除' : '比赛记录已删除');
        schedulePoll(1800);
        loadStatus({quiet: true});
      },
    });
  }

  async function revealMatch(matchId) {
    try {
      await api('/api/reveal', {method: 'POST', body: {kind: 'match', matchId}});
    } catch (err) {
      handleActionError(err, '无法打开录像所在位置');
    }
  }

  async function revealKind(kind) {
    try {
      await api('/api/reveal', {method: 'POST', body: {kind}});
    } catch (err) {
      handleActionError(err, '无法打开文件夹');
    }
  }

  async function copyText(text) {
    if (!text) {
      return false;
    }
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        // 某些浏览器在非安全上下文中会拒绝剪贴板 API，使用回退方案。
      }
    }
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    }
    area.remove();
    return copied;
  }

  async function copyMatchId(matchId) {
    const match = currentMatch(matchId);
    if (!match) {
      toast('error', '未找到该比赛，请刷新列表');
      return;
    }
    const value = match.shareCode || match.matchId;
    const copied = await copyText(String(value));
    if (copied) {
      toast('success', match.shareCode ? '分享代码已复制' : '比赛 ID 已复制');
    } else {
      toast('error', '复制失败，请手动选择文本');
    }
  }

  function resetFilters() {
    state.filter = 'all';
    state.search = '';
    if ($('#match-search')) {
      $('#match-search').value = '';
    }
    $$('#filter-chips .chip').forEach((chip) => {
      chip.classList.toggle('is-active', chip.dataset.filter === 'all');
    });
    renderMatches();
  }

  function openShareModal() {
    if (!requireLogin()) {
      return;
    }
    if (state.shareBusy) {
      toast('info', '正在查询上一个分享代码，请稍候。');
      return;
    }
    if (state.environment?.cs2Running) {
      toast('warn', 'CS2 正在运行。查询分享代码需要登录 Steam GC，请先退出游戏。');
      return;
    }
    if (state.syncBusy || state.gcBusy) {
      toast('warn', '正在与 Steam 通信，请等待当前操作完成。');
      return;
    }
    const input = $('#share-code-input');
    if (input) {
      input.value = '';
      input.disabled = false;
    }
    if ($('#share-download')) {
      $('#share-download').checked = true;
      $('#share-download').disabled = false;
    }
    state.shareBusy = false;
    openModal('share-modal');
    setTimeout(() => input?.focus(), 60);
  }

  async function submitShare(event) {
    event.preventDefault();
    if (state.shareBusy) {
      return;
    }
    const input = $('#share-code-input');
    const download = $('#share-download');
    const button = $('#share-submit-btn');
    const shareCode = input?.value.trim() || '';
    if (!shareCode) {
      toast('warn', '请输入分享代码');
      input?.focus();
      return;
    }
    state.shareBusy = true;
    const originalText = button?.textContent || '查询并添加';
    if (button) {
      button.disabled = true;
      button.textContent = '查询中…';
    }
    if (input) {
      input.disabled = true;
    }
    if (download) {
      download.disabled = true;
    }
    try {
      const data = await api('/api/sharecode', {
        method: 'POST',
        body: {shareCode, download: Boolean(download?.checked)},
      });
      if (data.queued) {
        expectQueuedTask(data.queued.id);
      }
      const name = data.match?.title || data.match?.mapName || '比赛';
      let message = `${data.added ? '已添加' : '已更新'}：${name}`;
      if (data.queued) {
        message += '，正在下载录像';
      }
      toast('success', message);
      closeModal('share-modal');
      if (input) {
        input.value = '';
      }
      await loadMatches({quiet: true});
      schedulePoll(600);
    } catch (err) {
      handleActionError(err, '查询分享代码失败');
      input?.focus();
    } finally {
      state.shareBusy = false;
      if (button) {
        button.disabled = false;
        button.textContent = originalText;
      }
      if (input) {
        input.disabled = false;
      }
      if (download) {
        download.disabled = false;
      }
    }
  }

  function requireLogin() {
    if (state.session?.loggedIn || state.app?.mock) {
      return true;
    }
    toast('warn', '请先登录 Steam');
    openLoginModal();
    return false;
  }

  async function handleMatchAction(event) {
    const button = event.target.closest('[data-action]');
    if (!button) {
      return;
    }
    const action = button.dataset.action;
    const id = button.dataset.id;
    if (action === 'sync') {
      startSync(false);
    } else if (action === 'share') {
      openShareModal();
    } else if (action === 'login') {
      openLoginModal();
    } else if (action === 'retry-matches') {
      loadMatches({quiet: false});
    } else if (action === 'reset-filters') {
      resetFilters();
    } else if (action === 'open-settings') {
      showView('settings');
    } else if (action === 'download') {
      downloadMatch(id, button);
    } else if (action === 'play') {
      playMatch(id, button);
    } else if (action === 'delete') {
      confirmDeleteMatch(id);
    } else if (action === 'reveal') {
      revealMatch(id);
    } else if (action === 'copy') {
      copyMatchId(id);
    }
  }

  /* ===== TASKS ===== */

  function rebuildTasks() {
    state.tasks = [...state.taskMap.values()].sort((a, b) => {
      const left = Date.parse(a.createdAt) || 0;
      const right = Date.parse(b.createdAt) || 0;
      return right - left;
    });
  }

  function expectQueuedTask(taskId) {
    if (!taskId) {
      return;
    }
    state.expectedTaskIds.add(taskId);
    state.notifiedTaskIds.delete(taskId);
    schedulePoll(500);
  }

  function registerStartedTask(task) {
    if (!task?.id) {
      return;
    }
    state.expectedTaskIds.add(task.id);
    applyTasks([task], {notify: false});
    schedulePoll(500);
  }

  function applyTasks(tasks, {notify = true, replace = false} = {}) {
    if (!Array.isArray(tasks)) {
      return;
    }
    if (replace) {
      const incoming = new Set(tasks.map((task) => task?.id).filter(Boolean));
      for (const [id, task] of state.taskMap) {
        if (!incoming.has(id) && task.state !== 'running') {
          state.taskMap.delete(id);
        }
      }
    }
    const baseline = !state.taskBaselineReady;
    for (const task of tasks) {
      if (!task?.id) {
        continue;
      }
      if (state.clearedTaskIds?.has(task.id)) {
        continue;
      }
      const finishedAt = task.finishedAt ? Date.parse(task.finishedAt) : NaN;
      if (
        task.state !== 'running'
        && state.tasksClearedAt
        && Number.isFinite(finishedAt)
        && finishedAt <= state.tasksClearedAt
      ) {
        continue;
      }

      const previous = state.taskMap.get(task.id);
      const nowFinished = task.state === 'success' || task.state === 'error';
      if (!baseline && notify) {
        const wasRunning = previous?.state === 'running';
        const newlyExpected = !previous && nowFinished && state.expectedTaskIds.has(task.id);
        if ((wasRunning && nowFinished) || newlyExpected) {
          notifyTaskFinished(task);
        }
      }
      state.taskMap.set(task.id, task);
    }
    state.taskBaselineReady = true;
    state.lastTasksAt = Date.now();
    rebuildTasks();
    renderTasks();
    updateMiniForTasks();
    if (state.matchesLoaded) {
      renderMatches();
    }
  }

  async function notifyManualImport(task) {
    const command = String(task.result?.command || '').trim();
    if (!command) {
      toast('warn', task.result?.message || task.message || '录像已放入游戏目录', {duration: 10000});
      return;
    }
    const copied = await copyText(command);
    if (copied) {
      toast('success', '录像已放入游戏目录，播放命令已复制。请回到 CS2 主菜单，在控制台粘贴执行。', {
        duration: 12000,
      });
    } else {
      toast('warn', `录像已放入游戏目录。请在 CS2 控制台执行：${command}`, {duration: 12000});
    }
  }

  function notifyTaskFinished(task) {
    if (!task?.id || state.notifiedTaskIds.has(task.id) || state.clearedTaskIds?.has(task.id)) {
      return;
    }
    state.notifiedTaskIds.add(task.id);
    state.expectedTaskIds.delete(task.id);
    if (Date.now() < state.suppressTaskNotificationsUntil) {
      return;
    }

    if (task.state === 'error') {
      toast('error', `任务失败：${task.message || task.label || '未知错误'}`);
    } else if (task.type === 'play') {
      if (task.result?.mode === 'manual') {
        notifyManualImport(task).catch(() => {});
      } else {
        toast('success', task.result?.message || task.message || '播放任务完成');
      }
    } else {
      const name = String(task.label || '').replace(/^下载录像\s*/, '');
      toast('success', name ? `下载完成：${name}` : '录像下载完成');
    }

    if (state.miniDismissedId !== task.id) {
      showMiniCompleted(task);
    }
    scheduleMatchesRefresh();
  }

  function scheduleMatchesRefresh() {
    if (state.matchesRefreshTimer) {
      clearTimeout(state.matchesRefreshTimer);
    }
    state.matchesRefreshTimer = setTimeout(() => {
      state.matchesRefreshTimer = null;
      loadMatches({quiet: true});
    }, 450);
  }

  function clearMiniTimer() {
    if (state.miniHideTimer) {
      clearTimeout(state.miniHideTimer);
      state.miniHideTimer = null;
    }
  }

  function showMiniTask(task, completed = false) {
    const node = $('#mini-task');
    if (!node) {
      return;
    }
    clearMiniTimer();
    node.hidden = false;
    node.classList.toggle('is-success', completed && task.state === 'success');
    node.classList.toggle('is-error', completed && task.state === 'error');
    const label = completed
      ? (task.state === 'error' ? '任务失败' : '任务完成')
      : (task.label || '正在执行任务');
    if ($('#mini-task-label')) {
      $('#mini-task-label').textContent = label;
    }
    const fileName = completed && task.result?.fileName ? task.result.fileName : '';
    if ($('#mini-task-message')) {
      $('#mini-task-message').textContent = [task.message, fileName].filter(Boolean).join(' · ');
    }
    const percent = completed ? 100 : Math.max(0, Math.min(100, Number(task.progress) || 0));
    const bar = $('#mini-task-bar');
    if (bar) {
      bar.style.width = `${percent}%`;
    }
    const progress = node.querySelector('.progress');
    if (progress) {
      progress.classList.toggle('is-indeterminate', !completed && percent <= 0);
    }
    node.title = completed ? '点击查看任务中心' : '查看任务中心';
    node.dataset.taskId = task.id || '';
  }

  function showMiniCompleted(task) {
    state.miniTask = task;
    showMiniTask(task, true);
    state.miniHideTimer = setTimeout(() => {
      state.miniHideTimer = null;
      if (state.miniTask?.id === task.id) {
        hideMini();
      }
    }, 6000);
  }

  function hideMini() {
    clearMiniTimer();
    if ($('#mini-task')) {
      $('#mini-task').hidden = true;
    }
  }

  function updateMiniForTasks() {
    const active = state.tasks.find((task) => task.state === 'running');
    if (active) {
      if (state.miniDismissedId === active.id) {
        state.miniTask = active;
        hideMini();
        return;
      }
      state.miniTask = active;
      showMiniTask(active, false);
      return;
    }
    if (state.miniTask?.state === 'running') {
      state.miniTask = null;
      hideMini();
    }
  }

  function taskStateBadge(task) {
    if (task.state === 'success') {
      return badge('完成', 'success');
    }
    if (task.state === 'error') {
      return badge('失败', 'danger');
    }
    return badge('进行中', 'info');
  }

  function buildTaskItem(task) {
    const stateClass = task.state === 'success'
      ? 'is-success'
      : (task.state === 'error' ? 'is-error' : 'is-running');
    const item = h('div', {class: `task-item ${stateClass}`});
    const iconName = task.state === 'success'
      ? 'check'
      : (task.state === 'error' ? 'alert' : (task.type === 'play' ? 'play' : 'download'));
    const side = h(
      'div',
      {class: 'task-side'},
      h('span', {
        class: 'task-time',
        text: task.state === 'running'
          ? '进行中'
          : (formatRelative(task.finishedAt || task.updatedAt || task.createdAt) || '刚刚'),
      }),
      badge(task.type === 'play' ? '播放' : '下载', 'muted'),
    );
    const title = h(
      'div',
      {class: 'task-title'},
      h('span', {text: task.label || '任务'}),
      taskStateBadge(task),
    );
    const main = h(
      'div',
      {class: 'task-main'},
      title,
      h('div', {class: 'task-message', text: task.message || ''}),
    );
    if (task.state === 'running') {
      const percent = Math.max(0, Math.min(100, Number(task.progress) || 0));
      main.append(h(
        'div',
        {class: 'task-progress'},
        progressBar(percent, percent <= 0),
        h('span', {class: 'task-percent', text: `${percent}%`}),
      ));
    }
    if (task.result?.command) {
      const command = String(task.result.command);
      main.append(h('div', {
        class: 'task-command',
        text: command,
        title: '点击复制命令',
        role: 'button',
        tabindex: '0',
        onclick: async () => {
          const copied = await copyText(command);
          toast(copied ? 'success' : 'error', copied ? '命令已复制' : '复制失败，请手动选择文本');
        },
        onkeydown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            event.currentTarget.click();
          }
        },
      }));
    }
    item.append(h('div', {class: 'task-icon'}, icon(iconName)), main, side);
    return item;
  }

  function updateClearButton() {
    const button = $('#clear-finished-btn');
    if (!button) {
      return;
    }
    const finished = state.tasks.filter((task) => task.state !== 'running').length;
    button.disabled = state.clearingTasks || finished === 0;
    button.textContent = state.clearingTasks ? '清除中…' : '清除已完成';
    button.title = finished > 0 ? `清除 ${finished} 个已结束任务` : '没有已结束的任务';
  }

  function renderTasks() {
    const list = $('#task-list');
    if (!list) {
      return;
    }
    if (state.tasks.length === 0) {
      list.replaceChildren(h(
        'div',
        {class: 'task-empty'},
        icon('download'),
        h('span', {text: '还没有任务'}),
        h('span', {text: '同步比赛或点击下载后，任务会显示在这里。' }),
      ));
    } else {
      list.replaceChildren(...state.tasks.map(buildTaskItem));
    }
    updateClearButton();
    renderCounts();
  }

  async function clearFinishedTasks() {
    if (state.clearingTasks) {
      return;
    }
    const finished = state.tasks.filter((task) => task.state !== 'running');
    if (finished.length === 0) {
      return;
    }
    const removedIds = finished.map((task) => task.id);
    for (const id of removedIds) {
      state.clearedTaskIds?.add(id);
    }
    state.clearingTasks = true;
    state.suppressTaskNotificationsUntil = Date.now() + 3000;
    updateClearButton();
    try {
      const data = await api('/api/tasks/clear', {method: 'POST', body: {}});
      state.tasksClearedAt = Date.now();
      for (const [id, task] of state.taskMap) {
        if (task.state !== 'running') {
          state.clearedTaskIds?.add(id);
          state.taskMap.delete(id);
        }
      }
      rebuildTasks();
      if (state.miniTask && state.miniTask.state !== 'running') {
        state.miniTask = null;
        hideMini();
      }
      renderTasks();
      if (state.matchesLoaded) {
        renderMatches();
      }
      toast('info', data.removed > 0 ? `已清除 ${data.removed} 个已结束任务` : '没有需要清除的任务');
    } catch (err) {
      for (const id of removedIds) {
        state.clearedTaskIds?.delete(id);
      }
      handleActionError(err, '清除任务失败');
    } finally {
      state.clearingTasks = false;
      renderTasks();
    }
  }

  async function loadTasks({quiet = true} = {}) {
    try {
      const data = await api('/api/tasks');
      if (Array.isArray(data?.tasks)) {
        applyTasks(data.tasks);
      }
      return data;
    } catch (err) {
      if (!quiet) {
        handleActionError(err, '加载任务失败');
      }
      return null;
    }
  }

  /* ===== SETTINGS ===== */

  function setSettingsNote(text, {error = false, accent = false, sticky = false} = {}) {
    const note = $('#settings-save-note');
    if (!note) {
      return;
    }
    if (state.settingsNoteTimer) {
      clearTimeout(state.settingsNoteTimer);
      state.settingsNoteTimer = null;
    }
    note.textContent = text || '';
    note.classList.toggle('is-error', Boolean(error));
    note.style.color = accent ? 'var(--accent)' : (error ? '' : '');
    if (text && !sticky) {
      state.settingsNoteTimer = setTimeout(() => {
        state.settingsNoteTimer = null;
        if (!state.settingsDirty) {
          note.textContent = '';
          note.classList.remove('is-error');
          note.style.color = '';
        }
      }, 4200);
    }
  }

  function populateSettings() {
    const form = $('#settings-form');
    const config = state.config;
    if (!form || !config || state.settingsDirty) {
      return;
    }
    const setValue = (name, value) => {
      const field = form.elements.namedItem(name);
      if (field) {
        field.value = value;
      }
    };
    setValue('demoDir', config.demoDir || '');
    setValue('cs2Path', config.cs2Path || '');
    setValue('steamPath', config.steamPath || '');
    setValue('port', config.port ?? '');
    const autoDownload = form.elements.namedItem('autoDownload');
    if (autoDownload) {
      autoDownload.checked = Boolean(config.autoDownload);
    }
  }

  function markSettingsDirty() {
    if (!state.settingsDirty) {
      state.settingsDirty = true;
      setSettingsNote('有未保存的修改', {accent: true, sticky: true});
    }
  }

  async function saveSettings(event) {
    event?.preventDefault();
    if (state.savingSettings) {
      return;
    }
    const form = $('#settings-form');
    if (!form) {
      return;
    }
    const data = new FormData(form);
    const demoDir = String(data.get('demoDir') || '').trim();
    const cs2Path = String(data.get('cs2Path') || '').trim();
    const steamPath = String(data.get('steamPath') || '').trim();
    const port = Number(data.get('port'));
    const autoDownload = data.get('autoDownload') === 'on';
    if (!demoDir) {
      setSettingsNote('录像目录不能为空', {error: true, sticky: true});
      toast('warn', '请填写录像保存目录');
      form.elements.namedItem('demoDir')?.focus();
      return;
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setSettingsNote('端口必须是 1 到 65535 之间的整数', {error: true, sticky: true});
      toast('warn', '端口必须是 1 到 65535 之间的整数');
      form.elements.namedItem('port')?.focus();
      return;
    }

    const oldPort = Number(state.config?.port);
    const portChanged = Number.isFinite(oldPort) && oldPort !== port;
    const saveButton = $('#save-settings-btn');
    const originalText = saveButton?.textContent || '保存设置';
    state.savingSettings = true;
    if (saveButton) {
      saveButton.disabled = true;
      saveButton.textContent = '保存中…';
    }
    try {
      const result = await api('/api/settings', {
        method: 'POST',
        body: {demoDir, cs2Path, steamPath, port, autoDownload},
      });
      state.settingsDirty = false;
      if (result?.status) {
        applyStatus(result.status);
      } else {
        await loadStatus({quiet: true});
      }
      await loadMatches({quiet: true});
      setSettingsNote(
        portChanged ? '设置已保存，重启服务后新端口生效' : '设置已保存',
        {sticky: true},
      );
      toast('success', portChanged ? '设置已保存，重启服务后端口生效' : '设置已保存');
    } catch (err) {
      state.settingsDirty = true;
      setSettingsNote(err?.message || '保存设置失败', {error: true, sticky: true});
      handleActionError(err, '保存设置失败');
    } finally {
      state.savingSettings = false;
      if (saveButton) {
        saveButton.disabled = false;
        saveButton.textContent = originalText;
      }
    }
  }

  async function refreshEnvironment() {
    if (state.refreshBusy) {
      return;
    }
    const button = $('#settings-refresh-btn');
    state.refreshBusy = true;
    if (button) {
      button.disabled = true;
      button.classList.add('is-loading');
    }
    try {
      const data = await loadStatus({quiet: true});
      if (data) {
        toast('success', '运行环境已重新检测');
      } else {
        toast('error', '环境检测失败，请确认本地服务仍在运行');
      }
    } finally {
      state.refreshBusy = false;
      if (button) {
        button.disabled = false;
        button.classList.remove('is-loading');
      }
    }
  }

  /* ===== STATUS / DATA LOADING ===== */

  function applyStatus(data) {
    if (!data) {
      return;
    }
    state.status = data;
    state.app = data.app || {};
    state.config = data.config || {};
    state.environment = data.environment || {};
    state.session = data.session || {loggedIn: false};
    state.login = data.login || state.login || {phase: 'idle'};
    state.gcBusy = Boolean(data.gcBusy);
    state.demoDirWritable = Boolean(data.demoDirWritable);
    state.statusLoaded = true;
    if (data.library) {
      applyStats(data.library);
    }
    if (Array.isArray(data.tasks)) {
      applyTasks(data.tasks);
    }
    renderStatus();
    populateSettings();
    if (
      state.loginAwaitingSuccess
      && state.session?.loggedIn
      && state.login?.phase === 'success'
    ) {
      finishLoginSuccess();
    }
  }

  async function loadStatus({quiet = false} = {}) {
    const seq = ++state.statusSeq;
    try {
      const data = await api('/api/status');
      if (seq !== state.statusSeq) {
        return null;
      }
      applyStatus(data);
      state.lastStatusAt = Date.now();
      setServerOnline(true);
      return data;
    } catch (err) {
      if (seq !== state.statusSeq) {
        return null;
      }
      setServerOnline(Boolean(err?.status));
      if (!quiet) {
        toast('error', err?.message || '无法读取服务状态');
      }
      return null;
    }
  }

  async function loadMatches({quiet = false} = {}) {
    const seq = ++state.matchesSeq;
    try {
      const data = await api('/api/matches');
      if (seq !== state.matchesSeq) {
        return null;
      }
      state.matches = Array.isArray(data?.matches) ? data.matches : [];
      applyStats(data?.stats);
      state.matchesLoaded = true;
      if (Array.isArray(data?.tasks)) {
        applyTasks(data.tasks);
      }
      state.lastMatchesAt = Date.now();
      setServerOnline(true);
      renderMatches();
      return data;
    } catch (err) {
      if (seq !== state.matchesSeq) {
        return null;
      }
      setServerOnline(Boolean(err?.status));
      if (!state.matchesLoaded) {
        state.matchesLoaded = true;
        renderMatchesError(err);
      }
      if (!quiet) {
        toast('error', err?.message || '加载比赛列表失败');
      }
      return null;
    }
  }

  /* ===== LOGIN ===== */

  function clearLoginFields() {
    if ($('#login-password-input')) {
      $('#login-password-input').value = '';
    }
    if ($('#login-guard-input')) {
      $('#login-guard-input').value = '';
    }
  }

  function stopLoginPoll() {
    if (state.loginPollTimer) {
      clearTimeout(state.loginPollTimer);
      state.loginPollTimer = null;
    }
  }

  function maybeLoginError(login) {
    if (!state.loginModalOpen || login?.phase !== 'error') {
      return;
    }
    const key = `${login.updatedAt || ''}:${login.message || ''}`;
    if (state.loginErrorKey === key) {
      return;
    }
    state.loginErrorKey = key;
    state.loginAwaitingSuccess = false;
    state.loginBusy = false;
    toast('error', login.message || 'Steam 登录失败');
  }

  function finishLoginSuccess() {
    if (state.loginFinishing || !state.loginModalOpen || !state.loginAwaitingSuccess) {
      return;
    }
    state.loginFinishing = true;
    state.loginBusy = false;
    state.loginAwaitingSuccess = false;
    state.relogin = false;
    state.loginErrorKey = null;
    stopLoginPoll();
    clearLoginFields();
    state.loginModalOpen = false;
    closeModal('login-modal');
    renderStatus();
    toast(
      'success',
      state.app?.mock ? '预览模式：模拟登录已完成，未连接真实 Steam' : 'Steam 登录成功',
    );
    loadStatus({quiet: true});
    loadMatches({quiet: true});
    schedulePoll(900);
    setTimeout(() => {
      state.loginFinishing = false;
    }, 1200);
  }

  async function startQrLogin() {
    if (state.loginBusy) {
      return;
    }
    const epoch = ++state.loginEpoch;
    state.loginMode = 'qr';
    state.loginBusy = true;
    state.loginAwaitingSuccess = true;
    state.loginFinishing = false;
    state.loginErrorKey = null;
    state.login = {
      ...state.login,
      phase: 'starting',
      kind: 'qr',
      message: '正在获取 Steam 登录二维码…',
      error: null,
      qrDataUrl: null,
      qrChallengeUrl: null,
      expiresAt: null,
      actions: [],
      canSubmitCode: false,
    };
    renderLogin();
    try {
      const data = await api('/api/login/qr', {method: 'POST', body: {}});
      if (epoch !== state.loginEpoch) {
        return;
      }
      state.login = data.login ? {...state.login, ...data.login} : state.login;
      state.loginBusy = false;
      renderLogin();
      if (state.login.phase === 'error') {
        maybeLoginError(state.login);
        return;
      }
      if (state.login.phase === 'success') {
        finishLoginSuccess();
        return;
      }
      ensureLoginPoll(epoch);
    } catch (err) {
      if (epoch !== state.loginEpoch) {
        return;
      }
      state.loginBusy = false;
      state.loginAwaitingSuccess = false;
      state.login = {
        ...state.login,
        phase: 'error',
        kind: 'qr',
        message: err?.message || '获取登录二维码失败',
        error: err?.message || '获取登录二维码失败',
        updatedAt: new Date().toISOString(),
      };
      renderLogin();
      handleActionError(err, '获取登录二维码失败');
    } finally {
      if (epoch === state.loginEpoch) {
        state.loginBusy = false;
        renderLogin();
      }
    }
  }

  function ensureLoginPoll(epoch = state.loginEpoch) {
    stopLoginPoll();
    if (!state.loginModalOpen) {
      return;
    }
    const tick = async () => {
      state.loginPollTimer = null;
      if (!state.loginModalOpen || epoch !== state.loginEpoch) {
        return;
      }
      let retryDelay = 0;
      try {
        const data = await api('/api/login/status');
        if (!state.loginModalOpen || epoch !== state.loginEpoch) {
          return;
        }
        if (data?.session) {
          state.session = data.session;
        }
        if (data?.login) {
          state.login = data.login;
        }
        const login = state.login || {phase: 'idle'};
        state.loginBusy = false;
        if (login.phase === 'success') {
          renderLogin();
          if (state.loginAwaitingSuccess) {
            finishLoginSuccess();
          } else {
            renderStatus();
          }
          return;
        }
        if (login.phase === 'error') {
          renderLogin();
          maybeLoginError(login);
          return;
        }
        renderLogin();
        if (isLoginActive(login.phase)) {
          retryDelay = 1200;
        }
      } catch (err) {
        if (!state.loginModalOpen || epoch !== state.loginEpoch) {
          return;
        }
        state.loginBusy = false;
        renderLogin();
        if (err?.code === 'NETWORK') {
          setServerOnline(false);
        }
        retryDelay = 2800;
      }
      if (retryDelay > 0) {
        state.loginPollTimer = setTimeout(tick, retryDelay);
      }
    };
    state.loginPollTimer = setTimeout(tick, 700);
  }

  function openLoginModal() {
    const modal = $('#login-modal');
    if (!modal) {
      return;
    }
    state.loginModalOpen = true;
    state.loginFinishing = false;
    if (!state.session?.loggedIn) {
      state.relogin = false;
    }
    const loggedIn = Boolean(state.session?.loggedIn);
    let autoStart = false;
    if (
      !state.app?.mock
      && !loggedIn
      && !state.relogin
      && !state.qrAutoStarted
      && state.loginMode === 'qr'
      && !isLoginActive(state.login?.phase)
      && state.login?.phase !== 'error'
    ) {
      state.qrAutoStarted = true;
      autoStart = true;
    }
    renderLogin();
    openModal('login-modal');
    if (isLoginActive(state.login?.phase)) {
      ensureLoginPoll(state.loginEpoch);
    }
    if (autoStart) {
      setTimeout(() => {
        if (state.loginModalOpen) {
          startQrLogin();
        }
      }, 120);
    }
  }

  function closeLoginModal() {
    const active = isLoginActive(state.login?.phase) || state.loginBusy;
    state.loginModalOpen = false;
    state.loginEpoch += 1;
    state.loginBusy = false;
    state.loginAwaitingSuccess = false;
    state.relogin = false;
    state.loginErrorKey = null;
    stopLoginPoll();
    closeModal('login-modal');
    clearLoginFields();
    if (active) {
      api('/api/login/cancel', {method: 'POST', body: {}})
        .then((data) => {
          if (data?.login) {
            state.login = data.login;
            renderLogin();
          }
        })
        .catch(() => {});
    }
    loadStatus({quiet: true});
  }

  async function cancelLoginFlow({close = true} = {}) {
    const active = isLoginActive(state.login?.phase) || state.loginBusy;
    state.loginEpoch += 1;
    state.loginBusy = false;
    state.loginAwaitingSuccess = false;
    state.relogin = false;
    state.loginErrorKey = null;
    stopLoginPoll();
    clearLoginFields();
    if (active) {
      try {
        const data = await api('/api/login/cancel', {method: 'POST', body: {}});
        if (data?.login) {
          state.login = data.login;
        }
      } catch {
        // The login may already have finished; closing the dialog is still safe.
      }
    } else if (!state.session?.loggedIn) {
      state.login = {...state.login, phase: 'idle', message: '', error: null};
    }
    if (close || !state.session?.loggedIn) {
      state.loginModalOpen = false;
      closeModal('login-modal');
      loadStatus({quiet: true});
    }
    renderLogin();
  }

  function startRelogin() {
    state.relogin = true;
    state.loginMode = 'qr';
    state.loginErrorKey = null;
    state.loginFinishing = false;
    renderLogin();
    setTimeout(() => $('#qr-start-btn')?.focus(), 50);
  }

  function askLogout() {
    const mock = Boolean(state.app?.mock);
    askConfirm({
      title: '退出 Steam 登录',
      text: mock
        ? '预览模式下退出登录是模拟操作，不会清除模拟账号。真实模式会删除本机保存的 Steam 刷新令牌。'
        : '这将删除本机保存的 Steam 刷新令牌，之后需要重新登录。不会删除已下载的录像。',
      okLabel: '退出登录',
      danger: true,
      onConfirm: logoutNow,
    });
  }

  async function logoutNow() {
    const mock = Boolean(state.app?.mock);
    await api('/api/logout', {method: 'POST', body: {}});
    state.loginEpoch += 1;
    stopLoginPoll();
    state.loginBusy = false;
    state.loginAwaitingSuccess = false;
    state.loginFinishing = false;
    state.relogin = false;
    state.loginErrorKey = null;
    state.login = {
      phase: 'idle',
      kind: null,
      message: '',
      error: null,
      qrDataUrl: null,
      qrChallengeUrl: null,
      expiresAt: null,
      actions: [],
      canSubmitCode: false,
    };
    clearLoginFields();
    state.loginModalOpen = false;
    closeModal('login-modal');
    await loadStatus({quiet: true});
    if (mock) {
      toast('info', '预览模式：退出登录为模拟操作，模拟账号仍保持登录');
    } else {
      toast('success', '已退出 Steam 登录');
    }
  }

  async function submitPasswordLogin(event) {
    event?.preventDefault();
    if (state.login?.phase === 'needGuard' && state.login.canSubmitCode) {
      await submitGuardCode();
      return;
    }
    if (state.loginBusy) {
      return;
    }
    const accountInput = $('#login-account-input');
    const passwordInput = $('#login-password-input');
    const accountName = accountInput?.value.trim() || '';
    const password = passwordInput?.value || '';
    if (!accountName || !password) {
      toast('warn', '请输入 Steam 账号和密码');
      (!accountName ? accountInput : passwordInput)?.focus();
      return;
    }

    const epoch = ++state.loginEpoch;
    state.loginMode = 'password';
    state.loginBusy = true;
    state.loginAwaitingSuccess = true;
    state.loginFinishing = false;
    state.loginErrorKey = null;
    state.login = {
      ...state.login,
      phase: 'starting',
      kind: 'password',
      message: '正在登录 Steam…',
      error: null,
      qrDataUrl: null,
      qrChallengeUrl: null,
      expiresAt: null,
      actions: [],
      canSubmitCode: false,
    };
    renderLogin();
    try {
      const data = await api('/api/login/password', {
        method: 'POST',
        body: {accountName, password},
      });
      if (epoch !== state.loginEpoch) {
        return;
      }
      state.login = data.login ? {...state.login, ...data.login} : state.login;
      state.loginBusy = false;
      if (state.login.phase !== 'error' && passwordInput) {
        passwordInput.value = '';
      }
      renderLogin();
      if (state.login.phase === 'error') {
        maybeLoginError(state.login);
        return;
      }
      if (state.login.phase === 'success') {
        finishLoginSuccess();
        return;
      }
      ensureLoginPoll(epoch);
      if (state.login.phase === 'needGuard') {
        setTimeout(() => $('#login-guard-input')?.focus(), 60);
      }
    } catch (err) {
      if (epoch !== state.loginEpoch) {
        return;
      }
      state.loginBusy = false;
      state.loginAwaitingSuccess = false;
      const message = err?.message || 'Steam 登录失败';
      state.login = {
        ...state.login,
        phase: 'error',
        kind: 'password',
        message,
        error: message,
        updatedAt: new Date().toISOString(),
      };
      renderLogin();
      handleActionError(err, 'Steam 登录失败');
    } finally {
      if (epoch === state.loginEpoch) {
        state.loginBusy = false;
        renderLogin();
      }
    }
  }

  async function submitGuardCode() {
    if (state.loginBusy) {
      return;
    }
    const input = $('#login-guard-input');
    const code = input?.value.trim() || '';
    if (!code) {
      toast('warn', '请输入 Steam 安全验证码');
      input?.focus();
      return;
    }
    const epoch = ++state.loginEpoch;
    state.loginBusy = true;
    state.loginAwaitingSuccess = true;
    state.loginErrorKey = null;
    renderLogin();
    try {
      const data = await api('/api/login/guard', {method: 'POST', body: {code}});
      if (epoch !== state.loginEpoch) {
        return;
      }
      state.login = data.login ? {...state.login, ...data.login} : state.login;
      state.loginBusy = false;
      if (input) {
        input.value = '';
      }
      renderLogin();
      if (state.login.phase === 'error') {
        maybeLoginError(state.login);
        return;
      }
      if (state.login.phase === 'success') {
        finishLoginSuccess();
        return;
      }
      ensureLoginPoll(epoch);
    } catch (err) {
      if (epoch !== state.loginEpoch) {
        return;
      }
      state.loginBusy = false;
      const message = err?.message || '验证码提交失败';
      state.login = {
        ...state.login,
        phase: 'needGuard',
        message,
        error: message,
        canSubmitCode: true,
        updatedAt: new Date().toISOString(),
      };
      renderLogin();
      handleActionError(err, '验证码提交失败');
    } finally {
      if (epoch === state.loginEpoch) {
        state.loginBusy = false;
        renderLogin();
      }
    }
  }

  /* ===== VIEW / POLLING ===== */

  function showView(view, {updateHash = true, load = true} = {}) {
    const target = VIEW_TITLES[view] ? view : 'matches';
    const changed = state.view !== target;
    state.view = target;
    $$('.view').forEach((node) => {
      node.hidden = node.id !== `view-${target}`;
    });
    $$('[data-view]').forEach((node) => {
      const active = node.dataset.view === target;
      node.classList.toggle('is-active', active);
      if (active) {
        node.setAttribute('aria-current', 'page');
      } else {
        node.removeAttribute('aria-current');
      }
    });
    if ($('#page-title')) {
      $('#page-title').textContent = VIEW_TITLES[target];
    }
    document.title = `${VIEW_TITLES[target]} · CS2 录像中心`;
    if (updateHash && location.hash !== `#${target}`) {
      history.replaceState(null, '', `#${target}`);
    }
    if (changed) {
      window.scrollTo({top: 0, behavior: 'smooth'});
    }
    if (load) {
      if (target === 'tasks') {
        loadTasks({quiet: true});
      } else if (target === 'matches' && !state.matchesLoaded) {
        loadMatches({quiet: true});
      } else if (target === 'settings' && !state.statusLoaded) {
        loadStatus({quiet: true});
      }
    }
    renderCounts();
  }

  async function refreshAll() {
    if (state.refreshing) {
      return;
    }
    const button = $('#refresh-btn');
    state.refreshing = true;
    if (button) {
      button.disabled = true;
      button.classList.add('is-loading');
    }
    try {
      const status = await loadStatus({quiet: false});
      await Promise.allSettled([
        loadMatches({quiet: true}),
        loadTasks({quiet: true}),
      ]);
      if (status) {
        toast('success', '已刷新');
      }
    } finally {
      state.refreshing = false;
      if (button) {
        button.disabled = false;
        button.classList.remove('is-loading');
      }
    }
  }

  function hasActiveTasks() {
    return state.tasks.some((task) => task.state === 'running');
  }

  async function pollTick() {
    state.pollTimer = null;
    if (!state.polling) {
      return;
    }
    if (document.hidden) {
      schedulePoll(6500);
      return;
    }
    const now = Date.now();
    const jobs = [];
    if (now - state.lastStatusAt >= 15000) {
      jobs.push(loadStatus({quiet: true}));
    }
    if (now - state.lastMatchesAt >= 12000) {
      jobs.push(loadMatches({quiet: true}));
    }
    if (hasActiveTasks() && now - (state.lastTasksAt || 0) >= 1500) {
      jobs.push(loadTasks({quiet: true}));
    }
    await Promise.allSettled(jobs);
    schedulePoll(hasActiveTasks() ? 1800 : 7000);
  }

  function schedulePoll(delay = 7000) {
    if (!state.polling) {
      return;
    }
    if (state.pollTimer) {
      clearTimeout(state.pollTimer);
    }
    state.pollTimer = setTimeout(pollTick, Math.max(100, Number(delay) || 0));
  }

  /* ===== EVENTS / INIT ===== */

  function handleDocumentClick(event) {
    const closer = event.target.closest('[data-close]');
    if (closer) {
      const id = closer.dataset.close;
      if (id === 'login-modal') {
        closeLoginModal();
      } else {
        closeModal(id);
      }
      return;
    }
    if (event.target.classList?.contains('modal-backdrop')) {
      const id = event.target.id;
      if (id === 'login-modal') {
        closeLoginModal();
      } else {
        closeModal(id);
      }
      return;
    }
    const reveal = event.target.closest('[data-reveal]');
    if (reveal) {
      revealKind(reveal.dataset.reveal);
    }
  }

  function handleKeydown(event) {
    if (event.key !== 'Escape') {
      return;
    }
    const open = $$('.modal-backdrop').filter((modal) => !modal.hidden);
    if (open.length === 0) {
      return;
    }
    event.preventDefault();
    const top = open[open.length - 1];
    if (top.id === 'login-modal') {
      closeLoginModal();
    } else {
      closeModal(top.id);
    }
  }

  function bindEvents() {
    $$('[data-view]').forEach((button) => {
      button.addEventListener('click', () => showView(button.dataset.view));
    });

    $('#refresh-btn')?.addEventListener('click', refreshAll);
    $('#login-btn')?.addEventListener('click', openLoginModal);
    $('#account-card')?.addEventListener('click', openLoginModal);
    $('#steam-pill')?.addEventListener('click', openLoginModal);
    $('#cs2-pill')?.addEventListener('click', () => showView('settings'));

    $('#sync-btn')?.addEventListener('click', () => startSync(false));
    $('#sync-download-btn')?.addEventListener('click', () => startSync(true));
    $('#share-btn')?.addEventListener('click', openShareModal);
    $('#download-all-btn')?.addEventListener('click', downloadAll);
    $('#open-demo-dir')?.addEventListener('click', () => revealKind('demo'));

    $('#filter-chips')?.addEventListener('click', (event) => {
      const chip = event.target.closest('.chip');
      if (!chip) {
        return;
      }
      state.filter = chip.dataset.filter || 'all';
      $$('#filter-chips .chip').forEach((node) => {
        node.classList.toggle('is-active', node === chip);
      });
      renderMatches();
    });

    $('#match-search')?.addEventListener('input', (event) => {
      state.search = event.target.value;
      if (state.searchTimer) {
        clearTimeout(state.searchTimer);
      }
      state.searchTimer = setTimeout(() => {
        state.searchTimer = null;
        renderMatches();
      }, 110);
    });

    $('#match-list')?.addEventListener('click', handleMatchAction);
    $('#clear-finished-btn')?.addEventListener('click', clearFinishedTasks);

    $$('#login-tabs button').forEach((button) => {
      button.addEventListener('click', () => {
        state.loginMode = button.dataset.mode || 'qr';
        renderLogin();
        if (state.loginMode === 'password') {
          setTimeout(() => $('#login-account-input')?.focus(), 60);
        }
      });
    });
    $('#qr-start-btn')?.addEventListener('click', startQrLogin);
    $('#login-pane-password')?.addEventListener('submit', submitPasswordLogin);
    $('#guard-submit-btn')?.addEventListener('click', submitGuardCode);
    $('#login-cancel-btn')?.addEventListener('click', () => {
      cancelLoginFlow({close: !state.session?.loggedIn});
    });
    $('#logout-btn')?.addEventListener('click', askLogout);
    $('#relogin-btn')?.addEventListener('click', startRelogin);

    $('#share-form')?.addEventListener('submit', submitShare);
    $('#confirm-ok')?.addEventListener('click', runConfirmAction);

    $('#settings-form')?.addEventListener('input', markSettingsDirty);
    $('#settings-form')?.addEventListener('change', markSettingsDirty);
    $('#settings-form')?.addEventListener('submit', saveSettings);
    $('#settings-refresh-btn')?.addEventListener('click', refreshEnvironment);

    $('#mini-task-close')?.addEventListener('click', (event) => {
      event.stopPropagation();
      state.miniDismissedId = state.miniTask?.id || null;
      hideMini();
    });
    $('#mini-task')?.addEventListener('click', () => {
      showView('tasks');
    });

    document.addEventListener('click', handleDocumentClick);
    document.addEventListener('keydown', handleKeydown);
    window.addEventListener('hashchange', () => {
      const name = location.hash.replace(/^#/, '');
      showView(VIEW_TITLES[name] ? name : 'matches', {updateHash: false});
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && state.polling) {
        schedulePoll(220);
      }
    });
    window.addEventListener('online', () => {
      if (state.polling) {
        schedulePoll(220);
      }
    });
    window.addEventListener('offline', () => setServerOnline(false));
  }

  async function init() {
    bindEvents();
    const initialHash = location.hash.replace(/^#/, '');
    showView(VIEW_TITLES[initialHash] ? initialHash : 'matches', {updateHash: false, load: false});
    state.polling = true;
    await Promise.allSettled([
      loadStatus({quiet: false}),
      loadMatches({quiet: false}),
    ]);
    schedulePoll(5200);
  }

  init().catch((err) => {
    console.error(err);
    toast('error', '页面初始化失败，请刷新重试');
  });
})();

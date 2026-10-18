'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  dialog,
  nativeImage,
  screen,
  session,
  shell,
} = require('electron');
const {ConfigStore, getConfigDir} = require('../src/config');
const {Library} = require('../src/library');
const {SteamService} = require('../src/steam');
const {createServer} = require('../src/server');
const {readJsonSync, writeJsonAtomicSync} = require('../src/util');
const {sanitizeAppImageEnvironment} = require('./appimage-env');

const APP_NAME = 'CS2 录像中心';
const APP_ID = 'com.cs2demohub.app';
const APP_ROOT = path.join(__dirname, '..');
const MOCK = process.argv.includes('--mock') || process.env.CS2HUB_MOCK === '1';
const WINDOW_STATE_FILE = 'window-state.json';
const MIN_WIDTH = 760;
const MIN_HEIGHT = 540;

let mainWindow = null;
let tray = null;
let currentService = null;
let currentServer = null;
let serverUrl = null;
let configStore = null;
let shuttingDown = false;

const desktopConfig = new ConfigStore();

// AppRun points library and data variables at the temporary AppImage mount.
// Remove those entries so Steam and CS2 are launched with the system libraries.
if (sanitizeAppImageEnvironment(process.env)) {
  console.log('[desktop] 已清理 AppImage 运行时环境变量');
}

app.setName(APP_NAME);

// Keep Chromium data next to the existing CS2 Demo Hub configuration instead of
// creating a second application-data directory.
try {
  const desktopDataDir = path.join(getConfigDir(), 'desktop');
  fs.mkdirSync(desktopDataDir, {recursive: true});
  app.setPath('userData', desktopDataDir);
  app.setPath('sessionData', desktopDataDir);
} catch (err) {
  console.error('[desktop] 无法初始化应用数据目录：', err);
}

if (process.platform === 'win32') {
  app.setAppUserModelId(APP_ID);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindow();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('activate', () => {
    if (serverUrl) {
      showMainWindow();
    }
  });

  app.on('before-quit', (event) => {
    if (shuttingDown) {
      return;
    }
    event.preventDefault();
    shuttingDown = true;
    saveWindowState();

    const forceExit = setTimeout(() => app.exit(0), 4000);
    if (typeof forceExit.unref === 'function') {
      forceExit.unref();
    }
    shutdown()
      .catch((err) => console.error('[desktop] 关闭时出错：', err))
      .finally(() => {
        clearTimeout(forceExit);
        app.exit(0);
      });
  });

  process.on('SIGINT', () => app.quit());
  process.on('SIGTERM', () => app.quit());

  app.whenReady()
    .then(boot)
    .catch((err) => {
      console.error('[desktop] 启动失败：', err);
      dialog.showErrorBox(
        `${APP_NAME} 启动失败`,
        `${err && err.message ? err.message : String(err)}\n\n请尝试通过命令行启动应用以查看详细日志。`,
      );
      app.quit();
    });
}

function assetPath(...parts) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'icons', ...parts);
  }
  return path.join(APP_ROOT, 'build', 'icons', ...parts);
}

function buildWindowStatePath() {
  return path.join(app.getPath('userData'), WINDOW_STATE_FILE);
}

function readWindowState() {
  const state = readJsonSync(buildWindowStatePath(), null);
  if (!state || typeof state !== 'object' || !state.bounds) {
    return null;
  }
  const {x, y, width, height} = state.bounds;
  if (![x, y, width, height].every(Number.isFinite) || width < MIN_WIDTH || height < MIN_HEIGHT) {
    return null;
  }
  return state;
}

function boundsAreVisible(bounds) {
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    const overlapWidth = Math.min(bounds.x + bounds.width, area.x + area.width)
      - Math.max(bounds.x, area.x);
    const overlapHeight = Math.min(bounds.y + bounds.height, area.y + area.height)
      - Math.max(bounds.y, area.y);
    return overlapWidth >= 160 && overlapHeight >= 120;
  });
}

function getWindowOptions() {
  const state = readWindowState();
  const workArea = screen.getPrimaryDisplay().workArea;
  const maxWidth = Math.max(MIN_WIDTH, workArea.width - 24);
  const maxHeight = Math.max(MIN_HEIGHT, workArea.height - 24);
  const defaultWidth = Math.min(1280, maxWidth);
  const defaultHeight = Math.min(840, maxHeight);

  const options = {
    width: defaultWidth,
    height: defaultHeight,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    center: true,
  };

  if (state) {
    const bounds = {
      x: Math.round(state.bounds.x),
      y: Math.round(state.bounds.y),
      width: Math.min(Math.max(Math.round(state.bounds.width), MIN_WIDTH), maxWidth),
      height: Math.min(Math.max(Math.round(state.bounds.height), MIN_HEIGHT), maxHeight),
    };
    if (boundsAreVisible(bounds)) {
      Object.assign(options, bounds, {center: false});
    }
  }

  return {
    options,
    maximized: Boolean(state && state.maximized),
  };
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  try {
    writeJsonAtomicSync(buildWindowStatePath(), {
      bounds: mainWindow.getNormalBounds(),
      maximized: mainWindow.isMaximized(),
    }, 0o600);
  } catch (err) {
    console.error('[desktop] 无法保存窗口位置：', err);
  }
}

function listenOn(server, port) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.removeListener('error', onError);
      server.removeListener('listening', onListening);
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const onListening = () => {
      cleanup();
      resolve(server.address().port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

async function listenWithFallback(server, preferredPort) {
  try {
    return {port: await listenOn(server, preferredPort), fallback: false};
  } catch (err) {
    if (!['EADDRINUSE', 'EACCES'].includes(err.code)) {
      throw err;
    }
    console.warn(`[desktop] 端口 ${preferredPort} 不可用，改用随机本地端口。`);
    return {port: await listenOn(server, 0), fallback: true};
  }
}

async function boot() {
  configStore = desktopConfig;
  configStore.ensure();

  const library = new Library(configStore.get().demoDir);
  library.ensure();

  currentService = new SteamService(configStore);
  const created = createServer({
    configStore,
    service: currentService,
    library,
    mock: MOCK,
  });
  currentServer = created.server;

  try {
    const {port, fallback} = await listenWithFallback(currentServer, configStore.get().port);
    serverUrl = `http://127.0.0.1:${port}`;
    if (fallback) {
      console.warn(`[desktop] 本地服务已启动：${serverUrl}`);
    }
  } catch (err) {
    await currentService.dispose().catch(() => {});
    currentService = null;
    currentServer = null;
    throw err;
  }

  configureSecurity();
  buildApplicationMenu();
  createMainWindow();
  try {
    createTray();
  } catch (err) {
    console.warn('[desktop] 系统托盘不可用：', err.message || err);
  }

  console.log(`[desktop] ${APP_NAME} 已启动：${serverUrl}${MOCK ? '（预览模式）' : ''}`);

  if (process.env.CS2HUB_DEVTOOLS === '1' && mainWindow) {
    mainWindow.webContents.openDevTools({mode: 'detach'});
  }
}

function configureSecurity() {
  const localOrigin = new URL(serverUrl).origin;
  const isLocalUrl = (url) => {
    try {
      return new URL(url).origin === localOrigin;
    } catch {
      return false;
    }
  };
  const openExternal = (url) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        shell.openExternal(url).catch(() => {});
      }
    } catch {
      // Ignore malformed or unsupported URLs.
    }
  };

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(['clipboard-read', 'clipboard-sanitized-write', 'clipboard-write'].includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    return ['clipboard-read', 'clipboard-sanitized-write', 'clipboard-write'].includes(permission);
  });

  session.defaultSession.webRequest.onHeadersReceived(
    {urls: [`${localOrigin}/*`]},
    (details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
            "script-src 'self'; connect-src 'self'; font-src 'self' data:; object-src 'none'; " +
            "base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
          ],
          'Permissions-Policy': [
            'camera=(), microphone=(), geolocation=(), notifications=()',
          ],
        },
      });
    },
  );

  app.on('web-contents-created', (event, contents) => {
    contents.setWindowOpenHandler(({url}) => {
      if (isLocalUrl(url)) {
        return {action: 'allow'};
      }
      openExternal(url);
      return {action: 'deny'};
    });
    contents.on('will-navigate', (event, url) => {
      if (!isLocalUrl(url)) {
        event.preventDefault();
        openExternal(url);
      }
    });
    contents.on('will-attach-webview', (event) => {
      event.preventDefault();
    });
  });
}

function createMainWindow() {
  if (!serverUrl) {
    return;
  }
  const {options, maximized} = getWindowOptions();
  const win = new BrowserWindow({
    ...options,
    show: false,
    title: APP_NAME,
    icon: assetPath('512x512.png'),
    backgroundColor: '#0b0e13',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      devTools: !app.isPackaged || process.env.CS2HUB_DEVTOOLS === '1',
    },
  });

  mainWindow = win;

  if (MOCK) {
    win.webContents.on('page-title-updated', (event) => {
      event.preventDefault();
      win.setTitle(`${APP_NAME}（预览模式）`);
    });
  }

  win.once('ready-to-show', () => {
    if (mainWindow !== win || win.isDestroyed()) {
      return;
    }
    if (maximized) {
      win.maximize();
    }
    win.show();
  });

  win.on('close', () => {
    saveWindowState();
  });

  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null;
    }
  });

  win.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) {
      return;
    }
    console.error('[desktop] 页面加载失败：', errorCode, errorDescription, validatedURL);
    dialog.showErrorBox(
      '页面加载失败',
      `无法加载本地界面（${errorCode} ${errorDescription}）。\n请退出后重新启动 ${APP_NAME}。`,
    );
  });

  win.webContents.on('render-process-gone', (event, details) => {
    console.error('[desktop] 渲染进程退出：', details);
    if (details.reason !== 'clean-exit' && !shuttingDown) {
      dialog.showErrorBox(
        '界面进程意外退出',
        `界面进程已停止（${details.reason}）。重新打开应用即可恢复。`,
      );
    }
  });

  win.loadURL(serverUrl).catch((err) => {
    console.error('[desktop] 无法打开本地界面：', err);
  });
}

function showMessageBox(options) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return dialog.showMessageBox(mainWindow, options);
  }
  return dialog.showMessageBox(options);
}

function createTray() {
  const image = nativeImage.createFromPath(assetPath('tray.png'));
  if (image.isEmpty()) {
    console.warn('[desktop] 托盘图标加载失败，已跳过托盘图标。');
    return;
  }
  tray = new Tray(image);
  tray.setToolTip(MOCK ? `${APP_NAME}（预览模式）` : APP_NAME);
  tray.on('click', showMainWindow);
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray) {
    return;
  }
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: MOCK ? `${APP_NAME}（预览模式）` : APP_NAME,
      enabled: false,
    },
    {type: 'separator'},
    {label: '打开主界面', click: showMainWindow},
    {
      label: '刷新界面',
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.reload();
        }
      },
    },
    {label: '打开录像目录', click: () => openFolder(configStore.get().demoDir)},
    {label: '打开配置目录', click: () => openFolder(configStore.dir)},
    {type: 'separator'},
    {label: '退出', click: () => app.quit()},
  ]));
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (serverUrl) {
      createMainWindow();
    }
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

async function openFolder(target) {
  try {
    fs.mkdirSync(target, {recursive: true});
    const error = await shell.openPath(target);
    if (error) {
      throw new Error(error);
    }
  } catch (err) {
    await showMessageBox({
      type: 'error',
      title: '无法打开目录',
      message: '无法打开文件夹',
      detail: `${target}\n\n${err.message || err}`,
      buttons: ['确定'],
    });
  }
}

function showAbout() {
  showMessageBox({
    type: 'info',
    title: `关于 ${APP_NAME}`,
    message: APP_NAME,
    detail: [
      `版本 ${app.getVersion()}`,
      MOCK ? '当前为预览模式：不会连接 Steam 或启动 CS2。' : '',
      '',
      '本地同步、下载和播放 CS2 比赛录像。',
      '所有数据只保存在本机，Steam 密码不会被保存。',
    ].filter(Boolean).join('\n'),
    buttons: ['确定'],
  });
}

function buildApplicationMenu() {
  const template = [];
  if (process.platform === 'darwin') {
    template.push({role: 'appMenu'});
  }
  template.push(
    {
      label: '文件',
      submenu: [
        {label: '打开录像目录', click: () => openFolder(configStore.get().demoDir)},
        {label: '打开配置目录', click: () => openFolder(configStore.dir)},
        {type: 'separator'},
        {role: 'quit', label: '退出'},
      ],
    },
    {
      label: '编辑',
      submenu: [
        {role: 'undo', label: '撤销'},
        {role: 'redo', label: '重做'},
        {type: 'separator'},
        {role: 'cut', label: '剪切'},
        {role: 'copy', label: '复制'},
        {role: 'paste', label: '粘贴'},
        {role: 'selectAll', label: '全选'},
      ],
    },
    {
      label: '视图',
      submenu: [
        {role: 'reload', label: '刷新界面'},
        {role: 'togglefullscreen', label: '切换全屏'},
        {type: 'separator'},
        {role: 'resetZoom', label: '实际大小'},
        {role: 'zoomIn', label: '放大'},
        {role: 'zoomOut', label: '缩小'},
        ...(app.isPackaged && process.env.CS2HUB_DEVTOOLS !== '1'
          ? []
          : [
            {type: 'separator'},
            {role: 'toggleDevTools', label: '开发者工具'},
          ]),
      ],
    },
    {
      label: '帮助',
      submenu: [
        {label: `关于 ${APP_NAME}`, click: showAbout},
      ],
    },
  );
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function shutdown() {
  saveWindowState();

  if (tray) {
    tray.destroy();
    tray = null;
  }

  const server = currentServer;
  currentServer = null;
  if (server) {
    await new Promise((resolve) => {
      let finished = false;
      let timer = null;
      const finish = () => {
        if (finished) {
          return;
        }
        finished = true;
        if (timer) {
          clearTimeout(timer);
        }
        resolve();
      };
      timer = setTimeout(finish, 1500);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
      server.close(finish);
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
    });
  }

  const service = currentService;
  currentService = null;
  if (service) {
    await Promise.race([
      service.dispose().catch(() => {}),
      new Promise((resolve) => {
        const timer = setTimeout(resolve, 1000);
        if (typeof timer.unref === 'function') {
          timer.unref();
        }
      }),
    ]);
  }
}

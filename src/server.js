'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const {URL} = require('node:url');
const {
  getEnvironment,
  isCs2Running,
  stageDemo,
  launchDemo,
  getLaunchCommand,
  getConsoleCommand,
} = require('./cs2');
const {downloadDemo} = require('./downloader');
const {TaskManager} = require('./tasks');
const {createMockMatches, writeMockDemo} = require('./mock');
const {formatBytes} = require('./util');
const {Library} = require('./library');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_BODY = 1024 * 1024;
const VERSION = require('../package.json').version;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
};

function isLoopbackHostname(hostname) {
  const value = String(hostname || '').toLowerCase();
  return value === '127.0.0.1' || value === 'localhost' || value === '::1' || value === '[::1]';
}

function isAllowedLocalRequest(req) {
  const hostHeader = String(req.headers.host || '');
  if (!hostHeader) {
    return false;
  }
  let requestHost;
  try {
    const parsed = new URL(`http://${hostHeader}`);
    if (!isLoopbackHostname(parsed.hostname)) {
      return false;
    }
    requestHost = parsed.host.toLowerCase();
  } catch {
    return false;
  }

  const origin = req.headers.origin;
  if (origin) {
    try {
      const parsedOrigin = new URL(origin);
      if (
        !['http:', 'https:'].includes(parsedOrigin.protocol) ||
        !isLoopbackHostname(parsedOrigin.hostname) ||
        parsedOrigin.host.toLowerCase() !== requestHost
      ) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || 'HTTP_ERROR';
  }
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function sendError(res, err) {
  let status = err.status || 500;
  if (!err.status) {
    if (['LOGIN_INPUT', 'INVALID_SHARE_CODE', 'INVALID_MATCH', 'MATCH_NOT_FOUND',
      'MATCH_AMBIGUOUS', 'NO_DEMO_URL', 'INVALID_DEMO', 'DEMO_URL_EXPIRED'].includes(err.code)) {
      status = 400;
    } else if (err.code === 'NOT_LOGGED_IN') {
      status = 401;
    } else if (['CS2_RUNNING_SYNC', 'CS2_RUNNING', 'CONFLICT', 'BUSY'].includes(err.code)) {
      status = 409;
    } else if (['STEAM_NETWORK', 'STEAM_UNAVAILABLE', 'GC_TIMEOUT', 'STEAM_ERROR'].includes(err.code)) {
      status = 503;
    }
  }
  sendJson(res, status, {
    error: {
      message: err.message || '服务器内部错误',
      code: err.code || 'INTERNAL_ERROR',
    },
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const contentType = String(req.headers['content-type'] || '');
    if (!contentType.toLowerCase().includes('application/json')) {
      reject(new HttpError(415, '请求必须使用 application/json', 'UNSUPPORTED_MEDIA_TYPE'));
      return;
    }
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, '请求内容过大', 'PAYLOAD_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(new HttpError(400, 'JSON 请求格式不正确', 'BAD_JSON'));
      }
    });
    req.on('error', reject);
  });
}

function createEnvCache() {
  let value = null;
  let at = 0;
  return async function getCachedEnvironment(config, {force = false} = {}) {
    const now = Date.now();
    if (!force && value && now - at < 4000) {
      return value;
    }
    value = await getEnvironment(config);
    at = now;
    return value;
  };
}

function createServer({
  configStore,
  service,
  mock = false,
  library: suppliedLibrary,
  isCs2Running: suppliedIsCs2Running,
}) {
  let library = suppliedLibrary || new Library(configStore.get().demoDir);
  library.ensure();
  const tasks = new TaskManager();
  const getCachedEnvironment = createEnvCache();
  const ctx = {
    configStore,
    service,
    library,
    tasks,
    mock,
    isCs2Running: typeof suppliedIsCs2Running === 'function' ? suppliedIsCs2Running : isCs2Running,
    gcBusy: false,
    playBusy: false,
    lastLaunchAt: 0,
    startedAt: new Date().toISOString(),
    getLib: () => library,
    setLib: (value) => {
      library = value;
      ctx.library = value;
    },
  };

  async function withGcLock(fn) {
    if (ctx.gcBusy) {
      throw new HttpError(409, '正在与 Steam 通信，请等待当前操作完成', 'BUSY');
    }
    if (ctx.playBusy) {
      throw new HttpError(409, '正在准备启动 CS2，请稍后再同步', 'BUSY');
    }
    if (Date.now() - ctx.lastLaunchAt < 30000) {
      throw new HttpError(409, 'CS2 正在启动中，请等待游戏完全进入后再同步比赛', 'CS2_RUNNING_SYNC');
    }
    ctx.gcBusy = true;
    try {
      return await fn();
    } finally {
      ctx.gcBusy = false;
    }
  }

  function requireString(body, key, label) {
    if (typeof body[key] !== 'string' || !body[key].trim()) {
      throw new HttpError(400, `缺少${label}`, 'INVALID_INPUT');
    }
    return body[key].trim();
  }

  function progressMessage(progress) {
    if (!progress) {
      return null;
    }
    if (progress.phase === 'download') {
      if (progress.total > 0) {
        return `正在下载 ${progress.percent ?? 0}%（${formatBytes(progress.received)} / ${formatBytes(progress.total)}）`;
      }
      return `正在下载… ${formatBytes(progress.received)}`;
    }
    if (progress.phase === 'decompress') {
      return '正在解压录像…';
    }
    if (progress.phase === 'done') {
      return '下载完成';
    }
    return null;
  }

  async function ensureDownloaded(entry, update) {
    let current = ctx.library.get(entry.matchId);
    if (!current) {
      throw new HttpError(404, '未找到该比赛，请先同步比赛列表', 'MATCH_NOT_FOUND');
    }
    if (current.downloaded) {
      update({progress: 100, phase: 'done', message: '录像已存在'});
      return current;
    }
    const prepared = ctx.library.prepareDownload(current.matchId);
    update({progress: 3, message: '正在准备下载…'});

    const onProgress = (progress) => {
      const message = progressMessage(progress);
      if (progress.phase === 'download') {
        update({
          progress: progress.percent !== null ? Math.min(85, Math.round(progress.percent * 0.85)) : 25,
          phase: progress.phase,
          message: message || '正在下载录像…',
        });
      } else if (progress.phase === 'decompress') {
        update({progress: 90, phase: progress.phase, message: message || '正在解压录像…'});
      } else if (progress.phase === 'done') {
        update({progress: 96, phase: progress.phase, message: message || '下载完成'});
      }
    };

    let result;
    if (ctx.mock) {
      update({progress: 35, phase: 'download', message: '预览模式：正在生成模拟录像…'});
      await new Promise((resolve) => setTimeout(resolve, 120));
      const fileName = prepared.fileName || 'mock.dem';
      const demoPath = path.join(ctx.library.demoDir, path.basename(fileName));
      writeMockDemo(demoPath);
      const stat = await fsp.stat(demoPath);
      result = {filePath: demoPath, size: stat.size, format: 'cs2'};
      update({progress: 85, phase: 'decompress', message: '预览模式：正在写入模拟录像…'});
    } else {
      result = await downloadDemo(prepared, {demoDir: ctx.library.demoDir, onProgress});
    }

    const updated = ctx.library.markDownloaded(current.matchId, {
      fileName: prepared.fileName,
      size: result.size,
      format: result.format,
    });
    update({progress: 100, phase: 'done', message: '下载完成'});
    return updated;
  }

  async function playMatch(entry, update) {
    if (ctx.gcBusy) {
      throw new HttpError(409, '正在同步 Steam 数据，请稍后再播放', 'BUSY');
    }
    const runningAtStart = !ctx.mock && await ctx.isCs2Running();
    const downloaded = await ensureDownloaded(entry, update);
    update({progress: 94, message: '正在准备 CS2 录像目录…'});
    const env = await getCachedEnvironment(ctx.configStore.get(), {force: true});

    if (ctx.mock) {
      update({progress: 100, phase: 'done', message: '预览模式：未启动 Steam'});
      return {
        mock: true,
        message: '预览模式：模拟播放完成，未启动 Steam/CS2',
        fileName: downloaded.fileName,
      };
    }

    if (!env.cs2.detected) {
      throw new HttpError(400, '未找到 CS2 安装目录，请在设置中手动指定', 'CS2_NOT_FOUND');
    }
    const running = await ctx.isCs2Running();
    const staged = await stageDemo({
      entry: downloaded,
      demoPath: downloaded.demoPath,
      cs2: env.cs2,
    });

    if (runningAtStart || running) {
      const command = getConsoleCommand(staged.stagedPath);
      const message = '录像已放入游戏目录，请在 CS2 主菜单的控制台粘贴播放命令';
      update({progress: 100, phase: 'done', message});
      return {
        mode: 'manual',
        message,
        fileName: downloaded.fileName,
        stagedPath: staged.stagedPath,
        method: staged.method,
        command,
      };
    }

    update({progress: 98, message: '正在启动 Steam 并载入录像…'});
    const launch = await launchDemo({
      steamPath: env.steamPath,
      demoPath: staged.stagedPath,
      cs2Running: false,
    });
    ctx.lastLaunchAt = Date.now();
    update({progress: 100, phase: 'done', message: '已启动 CS2，正在自动播放录像'});
    return {
      message: '已启动 CS2，正在自动播放录像',
      fileName: downloaded.fileName,
      stagedPath: staged.stagedPath,
      method: staged.method,
      command: getLaunchCommand(env.steamPath, staged.stagedPath),
      pid: launch.pid,
    };
  }

  function enqueueDownload(matchId) {
    const active = ctx.tasks.activeForMatch(matchId);
    if (active.length > 0) {
      return {task: active[0], duplicate: true};
    }
    const entry = ctx.library.get(matchId);
    if (!entry) {
      throw new HttpError(404, '未找到该比赛，请先同步比赛列表', 'MATCH_NOT_FOUND');
    }
    if (entry.downloaded) {
      return {alreadyDownloaded: true, match: entry, task: null};
    }
    if (!entry.demoUrl) {
      throw new HttpError(400, '该比赛没有可用的录像链接，请重新同步或使用分享代码', 'NO_DEMO_URL');
    }
    const task = ctx.tasks.start('download', {
      label: `下载录像 ${entry.mapName || entry.map || entry.matchId}`,
      matchId: entry.matchId,
      message: '排队下载中…',
      successMessage: '下载完成',
    }, async (update) => {
      const result = await ensureDownloaded(entry, update);
      return {
        matchId: result.matchId,
        fileName: result.fileName,
        size: result.size,
        downloaded: true,
      };
    });
    return {task, duplicate: false};
  }

  function enqueuePlay(matchId) {
    const active = ctx.tasks.activeForMatch(matchId);
    if (active.length > 0) {
      return {task: active[0], duplicate: true};
    }
    if (ctx.playBusy) {
      throw new HttpError(409, '已有一个播放任务正在准备，请稍后再试', 'BUSY');
    }
    const entry = ctx.library.get(matchId);
    if (!entry) {
      throw new HttpError(404, '未找到该比赛，请先同步比赛列表', 'MATCH_NOT_FOUND');
    }
    ctx.playBusy = true;
    const task = ctx.tasks.start('play', {
      label: `播放录像 ${entry.mapName || entry.map || entry.matchId}`,
      matchId: entry.matchId,
      message: entry.downloaded ? '正在准备播放…' : '将先下载录像，然后启动 CS2…',
      successMessage: ctx.mock ? '预览模式任务完成' : '已启动 CS2，正在自动播放录像',
    }, async (update) => {
      try {
        return await playMatch(entry, update);
      } finally {
        ctx.playBusy = false;
      }
    });
    return {task, duplicate: false};
  }

  async function buildStatus() {
    const config = ctx.configStore.get();
    const env = await getCachedEnvironment(config, {force: true});
    const session = ctx.mock
      ? {
        loggedIn: true,
        accountName: '预览模式',
        personaName: '预览模式',
        steamID: '76561198000000000',
        savedAt: new Date().toISOString(),
      }
      : ctx.service.getSessionSummary();
    const login = ctx.mock
      ? {
        phase: 'success',
        kind: null,
        message: '预览模式无需登录',
        accountName: '预览模式',
        qrDataUrl: null,
        qrChallengeUrl: null,
        actions: [],
        canSubmitCode: false,
        updatedAt: new Date().toISOString(),
      }
      : ctx.service.getLoginState();
    let demoDirWritable = false;
    try {
      fs.accessSync(config.demoDir, fs.constants.W_OK);
      demoDirWritable = true;
    } catch {
      demoDirWritable = false;
    }
    return {
      app: {
        name: 'CS2 录像中心',
        version: VERSION,
        mock: ctx.mock,
        startedAt: ctx.startedAt,
        platform: process.platform,
        node: process.version,
      },
      config: ctx.configStore.summary(),
      session,
      login,
      environment: env,
      library: ctx.library.stats(),
      demoDirWritable,
      gcBusy: ctx.gcBusy,
      activeTasks: ctx.tasks.active().length,
      tasks: ctx.tasks.list().slice(0, 20),
    };
  }

  async function handleApi(req, res, pathname) {
    if (req.method === 'GET' && pathname === '/api/health') {
      sendJson(res, 200, {ok: true, version: VERSION, mock: ctx.mock});
      return true;
    }

    if (req.method === 'GET' && pathname === '/api/status') {
      sendJson(res, 200, await buildStatus());
      return true;
    }

    if (req.method === 'GET' && pathname === '/api/matches') {
      sendJson(res, 200, {
        matches: ctx.library.list(),
        stats: ctx.library.stats(),
        tasks: ctx.tasks.list().slice(0, 30),
      });
      return true;
    }

    if (req.method === 'GET' && pathname === '/api/tasks') {
      sendJson(res, 200, {tasks: ctx.tasks.list()});
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/tasks/clear') {
      await readBody(req);
      const removed = ctx.tasks.clearFinished();
      sendJson(res, 200, {removed, tasks: ctx.tasks.list()});
      return true;
    }

    if (req.method === 'GET' && pathname.startsWith('/api/tasks/')) {
      const id = pathname.slice('/api/tasks/'.length);
      const task = ctx.tasks.get(id);
      if (!task) {
        throw new HttpError(404, '任务不存在', 'TASK_NOT_FOUND');
      }
      sendJson(res, 200, {task});
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/sync') {
      const body = await readBody(req);
      const result = await withGcLock(async () => {
        const config = ctx.configStore.get();
        if (!ctx.mock) {
          const env = await getCachedEnvironment(config, {force: true});
          if (env.cs2Running) {
            throw new HttpError(
              409,
              'CS2 正在运行。同步比赛需要登录 Steam GC，会与游戏的 Steam 会话冲突，请先退出 CS2',
              'CS2_RUNNING_SYNC',
            );
          }
        }
        let matches;
        if (ctx.mock) {
          matches = createMockMatches(8);
        } else {
          matches = await ctx.service.requestRecentMatches({limit: 8});
        }
        const merged = ctx.library.mergeMatches(matches);
        const shouldDownload = Boolean(body.download) || Boolean(config.autoDownload);
        const queued = [];
        if (shouldDownload) {
          for (const entry of merged.entries) {
            if (!entry.downloaded && entry.demoUrl) {
              try {
                const queuedResult = enqueueDownload(entry.matchId);
                if (queuedResult.task) {
                  queued.push(queuedResult.task);
                }
              } catch {
                // Skip entries that cannot be queued.
              }
            }
          }
        }
        return {
          matches: merged.entries,
          added: merged.added,
          updated: merged.updated,
          queued: queued.map((task) => ({id: task.id, matchId: task.matchId})),
          stats: ctx.library.stats(),
        };
      });
      sendJson(res, 200, result);
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/sharecode') {
      const body = await readBody(req);
      const shareCode = requireString(body, 'shareCode', '分享代码');
      const result = await withGcLock(async () => {
        let match;
        if (ctx.mock) {
          match = createMockMatches(1)[0];
        } else {
          match = await ctx.service.requestShareCode(shareCode);
        }
        const merged = ctx.library.mergeMatches([match]);
        const entry = merged.entries.find((item) => String(item.matchId) === String(match.matchId));
        let queued = null;
        if (body.download && entry && entry.demoUrl) {
          const queuedResult = enqueueDownload(entry.matchId);
          if (queuedResult.task) {
            queued = {id: queuedResult.task.id, matchId: entry.matchId};
          }
        }
        return {match: entry || null, added: merged.added, queued, stats: ctx.library.stats()};
      });
      sendJson(res, 200, result);
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/download') {
      const body = await readBody(req);
      const matchId = requireString(body, 'matchId', '比赛 ID');
      const result = enqueueDownload(matchId);
      sendJson(res, 200, result);
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/download-all') {
      const entries = ctx.library.list().filter((entry) => !entry.downloaded && entry.demoUrl);
      const started = [];
      for (const entry of entries) {
        try {
          const result = enqueueDownload(entry.matchId);
          if (result.task) {
            started.push({id: result.task.id, matchId: entry.matchId});
          }
        } catch {
          // Continue with remaining entries.
        }
      }
      sendJson(res, 200, {started, count: started.length});
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/play') {
      const body = await readBody(req);
      const matchId = requireString(body, 'matchId', '比赛 ID');
      if (ctx.gcBusy) {
        throw new HttpError(409, '正在同步 Steam 数据，请稍后再播放', 'BUSY');
      }
      const result = enqueuePlay(matchId);
      sendJson(res, 200, result);
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/delete') {
      const body = await readBody(req);
      const matchId = requireString(body, 'matchId', '比赛 ID');
      if (ctx.tasks.activeForMatch(matchId).length > 0) {
        throw new HttpError(409, '该比赛正在下载或播放，请等待任务完成后再删除', 'BUSY');
      }
      const env = await getCachedEnvironment(ctx.configStore.get(), {force: true});
      if (await ctx.isCs2Running()) {
        throw new HttpError(409, 'CS2 正在运行，请先退出游戏再删除录像（避免删除正在使用的文件）', 'CS2_RUNNING');
      }
      const deleted = ctx.library.delete(matchId, {
        replaysDir: env.cs2.replaysPath || null,
        keepRecord: false,
      });
      sendJson(res, 200, {
        deleted: true,
        matchId,
        removedFile: deleted.removedFile,
        removedReplay: deleted.removedReplay,
        matches: ctx.library.list(),
        stats: ctx.library.stats(),
      });
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/login/qr') {
      if (ctx.mock) {
        sendJson(res, 200, {login: {phase: 'success', message: '预览模式无需登录'}});
        return true;
      }
      const login = await ctx.service.startQrLogin();
      sendJson(res, 200, {login});
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/login/password') {
      if (ctx.mock) {
        sendJson(res, 200, {login: {phase: 'success', message: '预览模式无需登录'}});
        return true;
      }
      const body = await readBody(req);
      const accountName = requireString(body, 'accountName', 'Steam 账号');
      const password = requireString(body, 'password', 'Steam 密码');
      const login = await ctx.service.startPasswordLogin({
        accountName,
        password,
        steamGuardCode: typeof body.steamGuardCode === 'string' ? body.steamGuardCode : null,
      });
      sendJson(res, 200, {login});
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/login/guard') {
      const body = await readBody(req);
      const code = requireString(body, 'code', '安全验证码');
      const login = await ctx.service.submitGuardCode(code);
      sendJson(res, 200, {login});
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/login/cancel') {
      const login = ctx.service.cancelLogin();
      sendJson(res, 200, {login});
      return true;
    }

    if (req.method === 'GET' && pathname === '/api/login/status') {
      const login = ctx.mock
        ? {phase: 'success', message: '预览模式无需登录'}
        : ctx.service.getLoginState();
      sendJson(res, 200, {login, session: ctx.mock ? {loggedIn: true, accountName: '预览模式'} : ctx.service.getSessionSummary()});
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/logout') {
      if (!ctx.mock) {
        ctx.service.logout();
      }
      sendJson(res, 200, {ok: true});
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/settings') {
      const body = await readBody(req);
      const patch = {};
      if (body.demoDir !== undefined) {
        if (typeof body.demoDir !== 'string' || !body.demoDir.trim()) {
          throw new HttpError(400, '录像目录不能为空', 'INVALID_SETTINGS');
        }
        patch.demoDir = body.demoDir.trim();
      }
      if (body.cs2Path !== undefined) {
        patch.cs2Path = typeof body.cs2Path === 'string' && body.cs2Path.trim() ? body.cs2Path.trim() : null;
      }
      if (body.steamPath !== undefined) {
        patch.steamPath = typeof body.steamPath === 'string' && body.steamPath.trim() ? body.steamPath.trim() : null;
      }
      if (body.autoDownload !== undefined) {
        patch.autoDownload = Boolean(body.autoDownload);
      }
      if (body.port !== undefined) {
        patch.port = body.port;
      }
      const oldDemoDir = ctx.configStore.get().demoDir;
      const updated = ctx.configStore.update(patch);
      if (updated.demoDir !== oldDemoDir) {
        const newLibrary = new Library(updated.demoDir);
        newLibrary.ensure();
        ctx.setLib(newLibrary);
      }
      const status = await buildStatus();
      sendJson(res, 200, {ok: true, status, restartRequired: body.port !== undefined});
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/reveal') {
      const body = await readBody(req);
      const config = ctx.configStore.get();
      let target = config.demoDir;
      if (body.kind === 'replays') {
        const env = await getCachedEnvironment(config, {force: true});
        target = env.cs2.replaysPath || config.demoDir;
      } else if (body.kind === 'config') {
        target = ctx.configStore.dir;
      } else if (body.kind === 'match' && body.matchId) {
        const entry = ctx.library.get(body.matchId);
        if (entry?.demoPath) {
          target = entry.demoPath;
        }
      }
      const {revealPath} = require('./util');
      await revealPath(target);
      sendJson(res, 200, {ok: true, path: target});
      return true;
    }

    return false;
  }

  async function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, {error: {message: '不支持的请求方法', code: 'METHOD_NOT_ALLOWED'}});
      return;
    }
    let relative = decodeURIComponent(pathname);
    if (relative === '/') {
      relative = '/index.html';
    }
    const filePath = path.resolve(PUBLIC_DIR, `.${relative}`);
    if (!filePath.startsWith(path.resolve(PUBLIC_DIR) + path.sep) && filePath !== path.resolve(PUBLIC_DIR)) {
      sendJson(res, 404, {error: {message: '页面不存在', code: 'NOT_FOUND'}});
      return;
    }
    try {
      const stat = await fsp.stat(filePath);
      if (!stat.isFile()) {
        throw Object.assign(new Error('not file'), {code: 'ENOENT'});
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      fs.createReadStream(filePath).pipe(res);
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'EISDIR') {
        sendJson(res, 404, {error: {message: '页面不存在', code: 'NOT_FOUND'}});
        return;
      }
      throw err;
    }
  }

  const server = http.createServer(async (req, res) => {
    let pathname = '/';
    try {
      const requestUrl = new URL(req.url, 'http://127.0.0.1');
      pathname = requestUrl.pathname;
      if (!isAllowedLocalRequest(req)) {
        sendJson(res, 403, {
          error: {
            message: '仅允许从本机访问 CS2 录像中心',
            code: 'LOCAL_ACCESS_ONLY',
          },
        });
        return;
      }
      if (pathname.startsWith('/api/')) {
        const handled = await handleApi(req, res, pathname);
        if (!handled) {
          sendJson(res, 404, {error: {message: '接口不存在', code: 'NOT_FOUND'}});
        }
        return;
      }
      await serveStatic(req, res, pathname);
    } catch (err) {
      if (!err.status && !err.code) {
        console.error(`[server] ${req.method} ${pathname}`, err);
      }
      if (!res.headersSent) {
        sendError(res, err);
      } else {
        res.end();
      }
    }
  });

  server.on('close', () => {
    if (service && typeof service.dispose === 'function') {
      service.dispose().catch(() => {});
    }
  });

  return {server, ctx, tasks, library, buildStatus};
}

module.exports = {
  createServer,
  sendJson,
  sendError,
  HttpError,
  PUBLIC_DIR,
  isAllowedLocalRequest,
  isLoopbackHostname,
};
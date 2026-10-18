'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {ConfigStore} = require('../src/config');
const {Library} = require('../src/library');
const {createServer} = require('../src/server');
const {tempDir, removeDir, waitFor, closeServer, makeMatch} = require('./_helpers');

function createFakeEnvironment(root) {
  const game = path.join(root, 'Counter-Strike Global Offensive', 'game');
  const csgo = path.join(game, 'csgo');
  const replays = path.join(csgo, 'replays');
  fs.mkdirSync(replays, {recursive: true});
  fs.writeFileSync(path.join(csgo, 'gameinfo.gi'), 'GameInfo {}\n');
  const steam = path.join(root, process.platform === 'win32' ? 'steam.exe' : 'steam');
  fs.writeFileSync(steam, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(steam, 0o755);
  return {csgo, replays, steam};
}

async function readJson(response) {
  const body = await response.json();
  return {response, body};
}

test('mock HTTP API、静态资源与完整任务流程', async (t) => {
  const root = tempDir();
  const config = new ConfigStore({dir: path.join(root, 'config')});
  const env = createFakeEnvironment(root);
  const demoDir = path.join(root, 'demos');
  config.update({
    demoDir,
    cs2Path: env.csgo,
    steamPath: env.steam,
    port: 3210,
    autoDownload: false,
  });
  const library = new Library(demoDir);
  const service = {dispose: async () => {}};
  const app = createServer({configStore: config, service, mock: true, library, isCs2Running: () => false});
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const port = app.server.address().port;

  t.after(async () => {
    await closeServer(app.server);
    removeDir(root);
  });

  const rawRequest = (pathname, {method = 'GET', headers = {}} = {}) => new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try {
          body = JSON.parse(text);
        } catch {
          // Not JSON.
        }
        resolve({status: res.statusCode, body, text});
      });
    });
    req.on('error', reject);
    req.end();
  });

  const request = async (pathname, {method = 'GET', body, contentType = 'application/json'} = {}) => {
    const headers = {};
    let payload;
    if (body !== undefined) {
      headers['content-type'] = contentType;
      payload = typeof body === 'string' ? body : JSON.stringify(body);
    }
    return fetch(base + pathname, {method, headers, body: payload});
  };
  const getJson = async (pathname) => readJson(await request(pathname));
  const postJson = async (pathname, body = {}, headers) => readJson(await request(pathname, {
    method: 'POST',
    body,
    ...headers,
  }));

  assert.equal(app.server.address().address, '127.0.0.1');

  const health = await getJson('/api/health');
  assert.equal(health.response.status, 200);
  assert.equal(health.response.headers.get('cache-control'), 'no-store');
  assert.equal(health.response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual({ok: health.body.ok, mock: health.body.mock}, {ok: true, mock: true});

  const status = await getJson('/api/status');
  assert.equal(status.response.status, 200);
  assert.equal(status.body.app.mock, true);
  assert.equal(status.body.session.loggedIn, true);
  assert.equal(status.body.login.phase, 'success');
  assert.equal(status.body.environment.cs2.detected, true);
  assert.equal(status.body.environment.cs2.replaysPath, env.replays);
  assert.equal(status.body.config.demoDir, demoDir);
  assert.equal(status.body.demoDirWritable, true);
  assert.equal(status.body.library.total, 0);

  const index = await request('/');
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /text\/html/);
  const html = await index.text();
  assert.match(html, /CS2 录像中心/);
  assert.match(html, /\/app\.js/);
  assert.match(html, /\/style\.css/);
  assert.match(html, /\/favicon\.svg/);

  const css = await request('/style.css');
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);
  assert.ok((await css.text()).length > 1000);

  const appJs = await request('/app.js');
  assert.equal(appJs.status, 200);
  assert.match(appJs.headers.get('content-type'), /javascript/);
  assert.ok((await appJs.text()).length > 1000);

  const favicon = await request('/favicon.svg');
  assert.equal(favicon.status, 200);
  assert.match(favicon.headers.get('content-type'), /image\/svg\+xml/);
  assert.match(await favicon.text(), /<svg/);

  const head = await fetch(base + '/style.css', {method: 'HEAD'});
  assert.equal(head.status, 200);
  assert.equal((await head.text()).length, 0);

  const blockedHost = await rawRequest('/api/matches', {
    headers: {Host: `evil.example:${port}`},
  });
  assert.equal(blockedHost.status, 403);
  assert.equal(blockedHost.body.error.code, 'LOCAL_ACCESS_ONLY');

  const blockedOrigin = await rawRequest('/api/logout', {
    method: 'POST',
    headers: {
      Host: `127.0.0.1:${port}`,
      Origin: 'https://evil.example',
      'Content-Type': 'application/json',
    },
  });
  assert.equal(blockedOrigin.status, 403);

  const sameOrigin = await rawRequest('/api/health', {
    headers: {
      Host: `127.0.0.1:${port}`,
      Origin: base,
    },
  });
  assert.equal(sameOrigin.status, 200);

  assert.equal((await request('/api/nope')).status, 404);
  assert.equal((await request('/missing-file.html')).status, 404);

  const wrongType = await request('/api/sync', {
    method: 'POST',
    body: '{}',
    contentType: 'text/plain',
  });
  assert.equal(wrongType.status, 415);

  const clearedEmpty = await postJson('/api/tasks/clear');
  assert.equal(clearedEmpty.body.removed, 0);

  const sync = await postJson('/api/sync');
  assert.equal(sync.response.status, 200);
  assert.equal(sync.body.added, 8);
  assert.equal(sync.body.updated, 0);
  assert.equal(sync.body.matches.length, 8);
  assert.equal(sync.body.stats.total, 8);
  assert.ok(sync.body.matches.every((match) => match.shareCode));

  const syncAgain = await postJson('/api/sync');
  assert.equal(syncAgain.response.status, 200);
  assert.equal(syncAgain.body.added, 0);
  assert.equal(syncAgain.body.updated, 8);

  const matches = await getJson('/api/matches');
  assert.equal(matches.body.matches.length, 8);
  assert.equal(matches.body.stats.downloaded, 0);
  const first = matches.body.matches[0];

  const single = await postJson('/api/download', {matchId: first.matchId});
  assert.equal(single.response.status, 200);
  assert.ok(single.body.task?.id);
  const singleTask = await waitFor(() => {
    const task = app.ctx.tasks.get(single.body.task.id);
    return task && task.state !== 'running' ? task : null;
  });
  assert.equal(singleTask.state, 'success');
  assert.equal(app.ctx.library.get(first.matchId).downloaded, true);
  assert.ok(fs.existsSync(app.ctx.library.get(first.matchId).demoPath));

  const duplicate = await postJson('/api/download', {matchId: first.matchId});
  assert.equal(duplicate.body.alreadyDownloaded, true);

  const clearedOne = await postJson('/api/tasks/clear');
  assert.equal(clearedOne.body.removed, 1);
  assert.equal(clearedOne.body.tasks.length, 0);

  const all = await postJson('/api/download-all');
  assert.equal(all.response.status, 200);
  assert.equal(all.body.count, 7);
  await waitFor(() => app.ctx.library.stats().downloaded === 8);
  await waitFor(() => app.ctx.tasks.active().length === 0);
  assert.equal(app.ctx.library.stats().missing, 0);
  assert.equal(app.ctx.library.stats().corrupted, 0);
  assert.equal(app.ctx.library.list().filter((match) => match.downloaded).length, 8);

  const tasks = await getJson('/api/tasks');
  assert.equal(tasks.body.tasks.length, 7);
  assert.ok(tasks.body.tasks.every((task) => task.state === 'success'));

  const missingTask = await getJson('/api/tasks/task-does-not-exist');
  assert.equal(missingTask.response.status, 404);

  const play = await postJson('/api/play', {matchId: first.matchId});
  assert.equal(play.response.status, 200);
  const playTask = await waitFor(() => {
    const task = app.ctx.tasks.get(play.body.task.id);
    return task && task.state !== 'running' ? task : null;
  });
  assert.equal(playTask.state, 'success');
  assert.equal(playTask.result.mock, true);
  assert.match(playTask.result.message, /未启动 Steam/);

  const clearAll = await postJson('/api/tasks/clear');
  assert.equal(clearAll.body.removed, 8);
  assert.equal(clearAll.body.tasks.length, 0);

  const entry = app.ctx.library.get(first.matchId);
  fs.writeFileSync(path.join(env.replays, entry.fileName), 'staged copy');
  fs.writeFileSync(path.join(env.replays, `${entry.fileName}.info`), 'info');
  const deleted = await postJson('/api/delete', {matchId: first.matchId});
  assert.equal(deleted.response.status, 200);
  assert.equal(deleted.body.deleted, true);
  assert.equal(deleted.body.removedFile, true);
  assert.equal(deleted.body.removedReplay, true);
  assert.equal(fs.existsSync(entry.demoPath), false);
  assert.equal(fs.existsSync(path.join(env.replays, entry.fileName)), false);
  assert.equal(fs.existsSync(path.join(env.replays, `${entry.fileName}.info`)), false);
  assert.equal(app.ctx.library.get(first.matchId), null);
  assert.equal(app.ctx.library.stats().total, 7);

  const qr = await postJson('/api/login/qr');
  assert.equal(qr.response.status, 200);
  assert.equal(qr.body.login.phase, 'success');

  const nextDemoDir = path.join(root, 'new-demos');
  const settings = await postJson('/api/settings', {
    demoDir: nextDemoDir,
    autoDownload: true,
    port: 3333,
  });
  assert.equal(settings.response.status, 200);
  assert.equal(settings.body.ok, true);
  assert.equal(settings.body.restartRequired, true);
  assert.equal(settings.body.status.config.demoDir, path.resolve(nextDemoDir));
  assert.equal(settings.body.status.config.autoDownload, true);
  assert.equal(settings.body.status.config.port, 3333);
  assert.equal(app.ctx.library.demoDir, path.resolve(nextDemoDir));
  assert.equal(app.ctx.library.stats().total, 0);
  assert.ok(fs.existsSync(nextDemoDir));

  const settingsFile = JSON.parse(fs.readFileSync(config.path, 'utf8'));
  assert.equal(settingsFile.demoDir, path.resolve(nextDemoDir));
  assert.equal(settingsFile.autoDownload, true);
  assert.equal(settingsFile.port, 3333);
  assert.equal(settingsFile.password, undefined);

  const badSettings = await postJson('/api/settings', {demoDir: '   '});
  assert.equal(badSettings.response.status, 400);
});

test('真实模式下载使用配置的录像目录', async (t) => {
  const root = tempDir();
  const demoDir = path.join(root, 'demos');
  const config = new ConfigStore({dir: path.join(root, 'config')});
  config.update({demoDir});
  const library = new Library(demoDir);
  library.mergeMatches([makeMatch({
    matchId: '7300000000000000100',
    demoUrl: 'placeholder',
  })]);

  const payload = Buffer.concat([
    Buffer.from('PBDEMS2\0', 'binary'),
    Buffer.alloc(96, 7),
  ]);
  const demoServer = http.createServer((req, res) => {
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': payload.length,
    });
    res.end(payload);
  });
  await new Promise((resolve) => demoServer.listen(0, '127.0.0.1', resolve));
  const demoPort = demoServer.address().port;
  const match = library.list()[0];
  library.mergeMatches([{
    ...match,
    demoUrl: `http://127.0.0.1:${demoPort}/demo.dem`,
  }]);

  const app = createServer({
    configStore: config,
    service: {dispose: async () => {}},
    mock: false,
    library,
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;

  t.after(async () => {
    await closeServer(app.server);
    await closeServer(demoServer);
    removeDir(root);
  });

  const response = await fetch(`${base}/api/download`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({matchId: match.matchId}),
  });
  assert.equal(response.status, 200);
  const {task} = await response.json();
  assert.ok(task?.id);

  const finished = await waitFor(() => {
    const current = app.ctx.tasks.get(task.id);
    return current && current.state !== 'running' ? current : null;
  });
  assert.equal(finished.state, 'success', finished.message);

  const entry = app.ctx.library.get(match.matchId);
  assert.equal(entry.downloaded, true);
  assert.equal(path.dirname(entry.demoPath), path.resolve(demoDir));
  assert.ok(fs.existsSync(entry.demoPath));
  assert.deepEqual(fs.readFileSync(entry.demoPath), payload);
});

test('CS2 运行时播放会导入录像并返回控制台命令', async (t) => {
  const root = tempDir();
  const demoDir = path.join(root, 'demos');
  const env = createFakeEnvironment(root);
  const config = new ConfigStore({dir: path.join(root, 'config')});
  config.update({
    demoDir,
    cs2Path: env.csgo,
    steamPath: env.steam,
  });

  const payload = Buffer.concat([
    Buffer.from('PBDEMS2\0', 'binary'),
    Buffer.alloc(128, 3),
  ]);
  const demoServer = http.createServer((req, res) => {
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': payload.length,
    });
    res.end(payload);
  });
  await new Promise((resolve) => demoServer.listen(0, '127.0.0.1', resolve));
  const demoPort = demoServer.address().port;

  const library = new Library(demoDir);
  library.mergeMatches([makeMatch({
    matchId: '7300000000000000101',
    demoUrl: `http://127.0.0.1:${demoPort}/demo.dem`,
  })]);
  const match = library.list()[0];

  const app = createServer({
    configStore: config,
    service: {dispose: async () => {}},
    mock: false,
    library,
    isCs2Running: async () => true,
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;

  t.after(async () => {
    await closeServer(app.server);
    await closeServer(demoServer);
    removeDir(root);
  });

  const response = await fetch(`${base}/api/play`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({matchId: match.matchId}),
  });
  assert.equal(response.status, 200);
  const {task} = await response.json();
  assert.ok(task?.id);

  const finished = await waitFor(() => {
    const current = app.ctx.tasks.get(task.id);
    return current && current.state !== 'running' ? current : null;
  });
  assert.equal(finished.state, 'success', finished.message);
  assert.equal(finished.result.mode, 'manual');
  assert.equal(finished.result.command, `playdemo "replays/${match.fileName}"`);
  assert.match(finished.message, /控制台/);
  assert.ok(fs.existsSync(finished.result.stagedPath));
  assert.deepEqual(fs.readFileSync(finished.result.stagedPath), payload);
  assert.equal(app.ctx.lastLaunchAt, 0);
});

test('前端引用的静态 DOM ID 都存在于 index.html', () => {
  const root = path.join(__dirname, '..');
  const appJs = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const ids = new Set();
  const patterns = [
    /\$\('#([A-Za-z0-9_-]+)(?:[ '\"]|\))/g,
    /querySelector\('#([A-Za-z0-9_-]+)(?:[ '\"]|\))/g,
  ];
  for (const pattern of patterns) {
    for (const match of appJs.matchAll(pattern)) {
      ids.add(match[1]);
    }
  }
  const missing = [...ids].filter((id) => !new RegExp(`id=["']${id}["']`).test(html));
  assert.deepEqual(missing, []);
});

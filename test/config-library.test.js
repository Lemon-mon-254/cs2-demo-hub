'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  DEFAULT_PORT,
  getConfigDir,
  normalizeConfig,
  ConfigStore,
} = require('../src/config');
const {
  Library,
  LibraryError,
  buildFileName,
  probeSync,
} = require('../src/library');
const {encodeShareCode} = require('../src/valve-matches');
const {fileStamp} = require('../src/util');
const {tempDir, writeDemo, removeDir, makeMatch} = require('./_helpers');

test('normalizeConfig 规范路径、布尔值和端口', () => {
  const config = normalizeConfig({
    demoDir: 'relative-demos',
    cs2Path: '  ',
    steamPath: '/tmp/steam',
    port: '3211',
    autoDownload: 1,
  });
  assert.equal(config.demoDir, path.resolve('relative-demos'));
  assert.equal(config.cs2Path, null);
  assert.equal(config.steamPath, path.resolve('/tmp/steam'));
  assert.equal(config.port, 3211);
  assert.equal(config.autoDownload, true);
  assert.throws(() => normalizeConfig({port: 'abc'}), /端口/);
  assert.throws(() => normalizeConfig({port: 70000}), /端口/);
  assert.equal(normalizeConfig({}).port, DEFAULT_PORT);
});

test('getConfigDir 支持 CS2HUB_HOME', () => {
  const previous = process.env.CS2HUB_HOME;
  process.env.CS2HUB_HOME = '~/.config/cs2hub-test-home';
  try {
    assert.equal(getConfigDir(), path.join(require('node:os').homedir(), '.config', 'cs2hub-test-home'));
  } finally {
    if (previous === undefined) {
      delete process.env.CS2HUB_HOME;
    } else {
      process.env.CS2HUB_HOME = previous;
    }
  }
});

test('ConfigStore 持久化配置和刷新令牌，不写入密码', () => {
  const dir = tempDir();
  try {
    const demoDir = path.join(dir, 'demos');
    const store = new ConfigStore({dir});
    const saved = store.update({demoDir, port: 3456, autoDownload: true});
    assert.equal(saved.demoDir, path.resolve(demoDir));
    assert.equal(saved.autoDownload, true);
    assert.ok(fs.existsSync(store.path));
    assert.ok(fs.existsSync(demoDir));
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(store.path).mode & 0o777, 0o600);
    }

    const reloaded = new ConfigStore({dir});
    assert.equal(reloaded.get().port, 3456);
    assert.equal(reloaded.get().demoDir, path.resolve(demoDir));

    assert.equal(store.getSessionSummary().loggedIn, false);
    assert.equal(store.loadSession(), null);

    const session = store.saveSession({
      refreshToken: 'test-refresh-token-abcdefghijklmnop',
      steamID: 76561198000000000n,
      accountName: 'tester',
      personaName: '测试玩家',
      password: 'must-not-be-written',
    });
    assert.equal(session.refreshToken, 'test-refresh-token-abcdefghijklmnop');
    assert.equal(session.steamID, '76561198000000000');
    assert.equal(session.password, undefined);

    const raw = fs.readFileSync(store.sessionPath, 'utf8');
    assert.ok(!raw.includes('must-not-be-written'));
    assert.ok(!/"password"\s*:/.test(raw));
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(store.sessionPath).mode & 0o777, 0o600);
    }
    assert.equal(store.getSessionSummary().accountName, 'tester');
    assert.equal(store.getSessionSummary().loggedIn, true);

    store.clearSession();
    assert.equal(store.loadSession(), null);
    assert.equal(store.getSessionSummary().loggedIn, false);
  } finally {
    removeDir(dir);
  }
});

test('Library 合并、下载状态、统计和排序', () => {
  const dir = tempDir();
  try {
    const library = new Library(dir);
    const newer = makeMatch({
      matchId: '7300000000000000002',
      date: '2026-10-16T18:00:00.000Z',
      map: 'de_inferno',
      mapName: '炼狱小镇',
      shareCode: encodeShareCode({
        matchId: '7300000000000000002',
        outcomeId: '7300000000000000102',
        token: 30001,
      }),
    });
    const older = makeMatch({
      matchId: '7300000000000000001',
      date: '2026-10-15T12:34:00.000Z',
    });

    const merged = library.mergeMatches([older, newer]);
    assert.equal(merged.added, 2);
    assert.deepEqual(library.list().map((entry) => entry.matchId), [
      newer.matchId,
      older.matchId,
    ]);
    assert.equal(library.stats().total, 2);
    assert.equal(library.stats().downloaded, 0);

    const prepared = library.prepareDownload(newer.matchId);
    assert.equal(
      prepared.fileName,
      `${fileStamp(new Date(newer.date))}_de_inferno_7300000000000000002.dem`,
    );
    assert.equal(prepared.downloaded, false);

    const demoPath = path.join(dir, prepared.fileName);
    writeDemo(demoPath, {extra: 200});
    assert.equal(probeSync(demoPath).valid, true);
    const downloaded = library.markDownloaded(newer.matchId, {
      fileName: prepared.fileName,
      size: fs.statSync(demoPath).size,
      format: 'cs2',
    });
    assert.equal(downloaded.downloaded, true);
    assert.equal(downloaded.corrupted, false);
    assert.equal(downloaded.demoPath, demoPath);
    assert.equal(library.stats().downloaded, 1);
    assert.equal(library.stats().bytes, fs.statSync(demoPath).size);

    const olderPrepared = library.prepareDownload(older.matchId);
    library.markDownloaded(older.matchId, {fileName: olderPrepared.fileName, size: 100});
    const missingEntry = library.get(older.matchId);
    assert.equal(missingEntry.downloaded, false);
    assert.equal(missingEntry.missing, true);
    assert.equal(library.stats().missing, 1);

    fs.writeFileSync(path.join(dir, olderPrepared.fileName), 'not a cs2 demo');
    const corruptedEntry = library.get(older.matchId);
    assert.equal(corruptedEntry.downloaded, false);
    assert.equal(corruptedEntry.corrupted, true);
    assert.equal(corruptedEntry.missing, false);
    assert.equal(library.stats().corrupted, 1);

    const foundByShareCode = library.resolveOne(newer.shareCode);
    assert.equal(foundByShareCode.matchId, newer.matchId);
    assert.equal(library.findCandidates(newer.matchId).length, 1);
    assert.throws(
      () => library.resolveOne('does-not-exist'),
      (err) => err instanceof LibraryError && err.code === 'MATCH_NOT_FOUND',
    );
  } finally {
    removeDir(dir);
  }
});

test('Library 合并时保留已有分享代码和下载记录，并避免文件名冲突', () => {
  const dir = tempDir();
  try {
    const library = new Library(dir);
    const original = makeMatch();
    library.mergeMatches([original]);
    const prepared = library.prepareDownload(original.matchId);
    const demoPath = path.join(dir, prepared.fileName);
    writeDemo(demoPath);
    library.markDownloaded(original.matchId, {
      fileName: prepared.fileName,
      size: fs.statSync(demoPath).size,
    });

    const updated = library.mergeMatches([{
      ...original,
      shareCode: null,
      date: null,
      map: null,
      demoUrl: null,
      scoreCT: 14,
      scoreT: 16,
      downloaded: false,
      fileName: null,
    }]);
    assert.equal(updated.updated, 1);
    const entry = library.get(original.matchId);
    assert.equal(entry.shareCode, original.shareCode);
    assert.ok(entry.date);
    assert.equal(entry.map, 'de_mirage');
    assert.equal(entry.scoreCT, 14);
    assert.equal(entry.downloaded, true);
    assert.equal(entry.fileName, prepared.fileName);

    const sameStamp = makeMatch({
      matchId: '7300000000000000009',
      shareCode: null,
      date: original.date,
      map: original.map,
      fileName: prepared.fileName,
    });
    library.mergeMatches([sameStamp]);
    const second = library.prepareDownload(sameStamp.matchId);
    assert.notEqual(second.fileName, prepared.fileName);
    assert.match(second.fileName, /_2\.dem$/);
  } finally {
    removeDir(dir);
  }
});

test('Library 删除录像、replays 副本和记录', () => {
  const dir = tempDir();
  try {
    const replays = path.join(dir, 'replays');
    fs.mkdirSync(replays, {recursive: true});
    const library = new Library(path.join(dir, 'demos'));
    const match = makeMatch({matchId: '7300000000000000010', fileName: 'custom.dem'});
    library.mergeMatches([match]);
    const demoPath = path.join(library.demoDir, 'custom.dem');
    writeDemo(demoPath);
    library.markDownloaded(match.matchId, {fileName: 'custom.dem', size: fs.statSync(demoPath).size});
    fs.writeFileSync(path.join(replays, 'custom.dem'), 'staged');
    fs.writeFileSync(path.join(replays, 'custom.dem.info'), 'info');

    const result = library.delete(match.matchId, {replaysDir: replays});
    assert.equal(result.removedFile, true);
    assert.equal(result.removedReplay, true);
    assert.equal(fs.existsSync(demoPath), false);
    assert.equal(fs.existsSync(path.join(replays, 'custom.dem')), false);
    assert.equal(fs.existsSync(path.join(replays, 'custom.dem.info')), false);
    assert.equal(library.get(match.matchId), null);

    const keep = makeMatch({matchId: '7300000000000000011', fileName: 'keep.dem'});
    library.mergeMatches([keep]);
    writeDemo(path.join(library.demoDir, 'keep.dem'));
    library.markDownloaded(keep.matchId, {fileName: 'keep.dem', size: 72});
    library.delete(keep.matchId, {keepRecord: true});
    const kept = library.get(keep.matchId);
    assert.ok(kept);
    assert.equal(kept.downloaded, false);
    assert.match(kept.fileName, /\.dem$/);
  } finally {
    removeDir(dir);
  }
});

test('buildFileName 清理不安全字符并保留比赛 ID', () => {
  const date = new Date(2026, 9, 17, 8, 9);
  const name = buildFileName({
    matchId: '7300000000000000003',
    date,
    map: 'workshop/../<bad>',
  });
  assert.equal(
    name,
    `${fileStamp(date)}_workshop_..__bad__7300000000000000003.dem`,
  );
  assert.ok(!/[<>:"/\\|?*]/.test(name));
});

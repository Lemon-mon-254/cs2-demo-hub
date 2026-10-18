'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  detectCs2Path,
  detectSteamPath,
  resolveConfigCs2Path,
  stageDemo,
  launchDemo,
  getLaunchCommand,
  getConsoleCommand,
} = require('../src/cs2');
const {probeDemoFile} = require('../src/downloader');
const {tempDir, writeDemo, removeDir} = require('./_helpers');

function createCs2Tree(root) {
  const gamePath = path.join(root, 'Counter-Strike Global Offensive', 'game');
  const csgoPath = path.join(gamePath, 'csgo');
  const replaysPath = path.join(csgoPath, 'replays');
  fs.mkdirSync(replaysPath, {recursive: true});
  fs.writeFileSync(path.join(csgoPath, 'gameinfo.gi'), 'GameInfo {}\n');
  return {gamePath, csgoPath, replaysPath};
}

test('检测 CS2 路径，支持 game/csgo、game 和 replays 输入', () => {
  const dir = tempDir();
  try {
    const {gamePath, csgoPath, replaysPath} = createCs2Tree(dir);
    assert.equal(resolveConfigCs2Path(csgoPath), csgoPath);
    assert.equal(resolveConfigCs2Path(gamePath), csgoPath);
    assert.equal(resolveConfigCs2Path(replaysPath), csgoPath);
    assert.equal(resolveConfigCs2Path(path.join(dir, 'missing')), null);

    const info = detectCs2Path({cs2Path: csgoPath});
    assert.equal(info.detected, true);
    assert.equal(info.csgoPath, csgoPath);
    assert.equal(info.gamePath, gamePath);
    assert.equal(info.replaysPath, replaysPath);
    assert.equal(info.source, 'config');
    assert.equal(info.installPath, path.dirname(path.dirname(gamePath)));

    const fallback = detectCs2Path({cs2Path: path.join(dir, 'missing')});
    assert.equal(typeof fallback.detected, 'boolean');
    assert.ok(Array.isArray(fallback.steamRoots));
  } finally {
    removeDir(dir);
  }
});

test('从 Steam 库目录自动发现 CS2', () => {
  const dir = tempDir();
  try {
    const steamRoot = path.join(dir, 'Steam');
    const library = path.join(dir, 'Library');
    const {csgoPath} = createCs2Tree(library);
    fs.mkdirSync(path.join(steamRoot, 'steamapps'), {recursive: true});
    fs.writeFileSync(
      path.join(steamRoot, 'steamapps', 'libraryfolders.vdf'),
      `"libraryfolders"\n{\n  "0"\n  {\n    "path" "${library.replace(/\\/g, '\\\\')}"\n  }\n}\n`,
    );
    const info = detectCs2Path({steamPath: steamRoot});
    assert.equal(info.detected, true);
    assert.equal(info.csgoPath, csgoPath);
    assert.equal(info.source, 'auto');
    assert.ok(info.libraryPaths.includes(path.resolve(library)));
  } finally {
    removeDir(dir);
  }
});

test('detectSteamPath 接受配置中的可执行文件或包含 steam.sh 的目录', () => {
  const dir = tempDir();
  try {
    const executable = path.join(dir, process.platform === 'win32' ? 'steam.exe' : 'steam');
    fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(executable, 0o755);
    assert.equal(detectSteamPath({steamPath: executable}), executable);
    assert.equal(detectSteamPath({steamPath: dir}), executable);
  } finally {
    removeDir(dir);
  }
});

test('stageDemo 使用硬链接或复制，并复用已经存在的有效录像', async () => {
  const dir = tempDir();
  try {
    const {csgoPath, replaysPath} = createCs2Tree(dir);
    const source = writeDemo(path.join(dir, 'downloads', 'source.dem'), {extra: 128});
    const cs2 = detectCs2Path({cs2Path: csgoPath});
    const entry = {fileName: 'match.dem'};

    const staged = await stageDemo({
      entry,
      demoPath: source,
      cs2,
    });
    assert.ok(['hardlink', 'copy'].includes(staged.method));
    assert.equal(staged.stagedPath, path.join(replaysPath, 'match.dem'));
    assert.equal(fs.existsSync(staged.stagedPath), true);
    assert.equal((await probeDemoFile(staged.stagedPath)).valid, true);

    const second = await stageDemo({entry, demoPath: source, cs2});
    assert.equal(second.method, 'existing');
    assert.equal(fs.readFileSync(second.stagedPath).length, fs.readFileSync(source).length);
  } finally {
    removeDir(dir);
  }
});

test('stageDemo 拒绝无效文件并报告缺失环境', async () => {
  const dir = tempDir();
  try {
    const {csgoPath} = createCs2Tree(dir);
    const cs2 = detectCs2Path({cs2Path: csgoPath});
    const bad = path.join(dir, 'bad.dem');
    fs.writeFileSync(bad, 'not a demo');

    await assert.rejects(
      () => stageDemo({entry: {fileName: 'bad.dem'}, demoPath: bad, cs2}),
      (err) => err.code === 'INVALID_DEMO',
    );
    await assert.rejects(
      () => stageDemo({entry: {fileName: 'missing.dem'}, demoPath: path.join(dir, 'nope'), cs2}),
      (err) => err.code === 'INVALID_DEMO',
    );
    await assert.rejects(
      () => stageDemo({entry: {fileName: 'a.dem'}, demoPath: null, cs2}),
      (err) => err.code === 'DEMO_NOT_DOWNLOADED',
    );
    await assert.rejects(
      () => stageDemo({entry: {fileName: 'a.dem'}, demoPath: bad, cs2: null}),
      (err) => err.code === 'CS2_NOT_FOUND',
    );
    await assert.rejects(
      () => stageDemo({entry: {}, demoPath: bad, cs2}),
      (err) => err.code === 'INVALID_MATCH',
    );
  } finally {
    removeDir(dir);
  }
});

test('launchDemo 在 CS2 运行或 Steam 缺失时拒绝启动', async () => {
  await assert.rejects(
    () => launchDemo({steamPath: '/usr/bin/steam', demoPath: '/tmp/a.dem', cs2Running: true}),
    (err) => err.code === 'CS2_RUNNING',
  );
  await assert.rejects(
    () => launchDemo({steamPath: null, demoPath: '/tmp/a.dem', cs2Running: false}),
    (err) => err.code === 'STEAM_NOT_FOUND',
  );
});

test('launchDemo 使用绝对路径、-insecure 和 +playdemo 启动 CS2', async () => {
  const dir = tempDir();
  try {
    const demoPath = path.join(dir, 'replays', 'match.dem');
    const result = await launchDemo({
      steamPath: process.execPath,
      demoPath,
      cs2Running: false,
    });
    assert.deepEqual(result.args, [
      '-applaunch',
      '730',
      '-insecure',
      '+playdemo',
      demoPath,
    ]);
  } finally {
    removeDir(dir);
  }

  await assert.rejects(
    () => launchDemo({steamPath: process.execPath, demoPath: 'replays/a.dem', cs2Running: false}),
    (err) => err.code === 'INVALID_DEMO_PATH',
  );
});

test('启动命令使用绝对路径、-insecure 和 +playdemo', () => {
  assert.equal(
    getLaunchCommand('/path/with space/steam', '/tmp/somewhere/match.dem'),
    '"/path/with space/steam" -applaunch 730 -insecure +playdemo "/tmp/somewhere/match.dem"',
  );
  assert.equal(
    getLaunchCommand(null, '/tmp/somewhere/match.dem'),
    'steam -applaunch 730 -insecure +playdemo "/tmp/somewhere/match.dem"',
  );
});

test('手动播放命令使用 replays 相对路径并清理文件名目录', () => {
  assert.equal(
    getConsoleCommand('/tmp/somewhere/match.dem'),
    'playdemo "replays/match.dem"',
  );
  assert.equal(
    getConsoleCommand('/tmp/somewhere/../somewhere/match.dem'),
    'playdemo "replays/match.dem"',
  );
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {parseArgs} = require('../src/cli');
const {tempDir, removeDir} = require('./_helpers');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'cs2hub.js');

test('parseArgs 支持值参数、等号参数、布尔标志和位置参数', () => {
  const options = parseArgs([
    'share',
    '--download',
    '--port',
    '3211',
    '--demo-dir',
    '/tmp/a b',
    '--account=me',
    '--auto-download=true',
    '--json',
    '--verbose',
  ]);
  assert.deepEqual(options._, ['share']);
  assert.equal(options.download, true);
  assert.equal(options.port, '3211');
  assert.equal(options['demo-dir'], '/tmp/a b');
  assert.equal(options.account, 'me');
  assert.equal(options['auto-download'], 'true');
  assert.equal(options.json, true);
  assert.equal(options.verbose, true);
  assert.deepEqual(options._raw, [
    'share',
    '--download',
    '--port',
    '3211',
    '--demo-dir',
    '/tmp/a b',
    '--account=me',
    '--auto-download=true',
    '--json',
    '--verbose',
  ]);

  const emptyValue = parseArgs(['sync', '--port', '--json']);
  assert.equal(emptyValue.port, '');
  assert.equal(emptyValue.json, true);

  const spacedValue = parseArgs(['config', '--auto-download', 'false']);
  assert.deepEqual(spacedValue._, ['config']);
  assert.equal(spacedValue['auto-download'], 'false');

  const unknown = parseArgs(['--unknown']);
  assert.equal(unknown.unknown, true);
});

test('CLI help、config、matches --json 和未知命令可运行', () => {
  const home = tempDir('cs2hub-cli-');
  const demoDir = path.join(home, 'demos');
  const env = {...process.env, CS2HUB_HOME: home, NO_COLOR: '1'};
  try {
    const help = spawnSync(process.execPath, [BIN, 'help'], {encoding: 'utf8', env, timeout: 20000});
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /CS2 录像中心/);
    assert.match(help.stdout, /cs2hub/);

    const version = spawnSync(process.execPath, [BIN, '--version'], {encoding: 'utf8', env, timeout: 20000});
    assert.equal(version.status, 0, version.stderr);
    assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/);

    const configured = spawnSync(process.execPath, [
      BIN,
      'config',
      '--demo-dir',
      demoDir,
      '--port',
      '4321',
      '--auto-download=true',
    ], {encoding: 'utf8', env, timeout: 20000});
    assert.equal(configured.status, 0, configured.stderr);
    assert.match(configured.stdout, /配置已保存/);
    assert.match(configured.stdout, /4321/);

    const configFile = path.join(home, 'config.json');
    assert.ok(fs.existsSync(configFile));
    const saved = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    assert.equal(saved.demoDir, path.resolve(demoDir));
    assert.equal(saved.port, 4321);
    assert.equal(saved.autoDownload, true);

    const disabled = spawnSync(process.execPath, [
      BIN,
      'config',
      '--auto-download',
      'false',
    ], {encoding: 'utf8', env, timeout: 20000});
    assert.equal(disabled.status, 0, disabled.stderr);
    assert.match(disabled.stdout, /自动下载\s+关闭/);
    const disabledConfig = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    assert.equal(disabledConfig.autoDownload, false);

    const matches = spawnSync(process.execPath, [BIN, 'matches', '--json'], {
      encoding: 'utf8',
      env,
      timeout: 20000,
    });
    assert.equal(matches.status, 0, matches.stderr);
    assert.deepEqual(JSON.parse(matches.stdout.trim()), []);

    const unknown = spawnSync(process.execPath, [BIN, 'not-a-command'], {
      encoding: 'utf8',
      env,
      timeout: 20000,
    });
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /未知命令/);
  } finally {
    removeDir(home);
  }
});

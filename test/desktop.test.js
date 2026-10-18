'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const packageJson = require('../package.json');
const {sanitizeAppImageEnvironment} = require('../electron/appimage-env');

function pngSize(file) {
  const buffer = fs.readFileSync(file);
  assert.equal(buffer.toString('ascii', 1, 4), 'PNG', `${file} 不是 PNG 文件`);
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

test('桌面应用入口与打包配置完整', () => {
  assert.equal(packageJson.main, 'electron/main.js');
  assert.match(packageJson.scripts.desktop, /electron \./);
  assert.match(packageJson.scripts['desktop:mock'], /--mock/);
  assert.ok(packageJson.devDependencies.electron);
  assert.ok(packageJson.devDependencies['electron-builder']);
  assert.ok(packageJson.build);
  assert.equal(packageJson.build.appId, 'com.cs2demohub.app');
  assert.equal(packageJson.build.directories.buildResources, 'build');
  assert.equal(packageJson.desktopName, 'cs2-demo-hub.desktop');
  assert.equal(packageJson.build.linux.syncDesktopName, true);
  assert.equal(packageJson.build.nsis.oneClick, false);
  assert.equal(packageJson.build.nsis.createDesktopShortcut, true);
  assert.equal(packageJson.build.nsis.createStartMenuShortcut, true);
  assert.equal(packageJson.build.nsis.shortcutName, 'CS2 录像中心');
  assert.match(packageJson.homepage, /^https:\/\//);

  const requiredFiles = [
    'electron/main.js',
    'electron/appimage-env.js',
    'build/icon.ico',
    'build/icon.png',
    'build/icons/32x32.png',
    'build/icons/512x512.png',
    'build/icons/tray.png',
  ];
  for (const relative of requiredFiles) {
    const fullPath = path.join(ROOT, relative);
    assert.ok(fs.existsSync(fullPath), `缺少桌面资源：${relative}`);
    assert.ok(fs.statSync(fullPath).size > 0, `桌面资源为空：${relative}`);
  }

  assert.deepEqual(pngSize(path.join(ROOT, 'build/icon.png')), {width: 512, height: 512});
  assert.deepEqual(pngSize(path.join(ROOT, 'build/icons/tray.png')), {width: 32, height: 32});

  const files = packageJson.build.files;
  for (const pattern of ['electron/**/*', 'src/**/*', 'public/**/*', 'package.json']) {
    assert.ok(files.includes(pattern), `打包文件列表缺少 ${pattern}`);
  }
  assert.ok(packageJson.build.extraResources.some((item) => item.from === 'build/icons'));

  const winTargets = packageJson.build.win.target.map((target) => target.target);
  assert.ok(winTargets.includes('nsis'));
  assert.equal(packageJson.build.nsis.createDesktopShortcut, true);
  assert.ok(packageJson.build.linux.target.some((target) => target.target === 'AppImage'));
  assert.ok(packageJson.build.linux.target.some((target) => target.target === 'deb'));
});

test('Electron 主进程语法有效', () => {
  for (const relative of ['electron/main.js', 'electron/appimage-env.js']) {
    assert.doesNotThrow(() => {
      execFileSync(process.execPath, ['--check', path.join(ROOT, relative)], {
        encoding: 'utf8',
        stdio: 'pipe',
      });
    }, `${relative} 语法错误`);
  }
});

test('AppImage 启动环境会移除捆绑目录并保留系统路径', () => {
  const appDir = path.join(path.sep, 'tmp', '.mount_CS2Hub');
  const appImage = path.join(path.sep, 'opt', 'CS2-Demo-Hub.AppImage');
  const similarName = `${appDir}-other`;
  const env = {
    APPDIR: appDir,
    APPIMAGE: appImage,
    ARGV0: 'cs2-demo-hub',
    OWD: path.join(path.sep, 'home', 'player'),
    LD_LIBRARY_PATH: [
      path.join(appDir, 'usr', 'lib'),
      path.join(path.sep, 'usr', 'lib'),
      similarName,
    ].join(path.delimiter),
    PATH: [path.join(appDir, 'usr', 'bin'), path.join(path.sep, 'usr', 'bin')].join(path.delimiter),
    XDG_DATA_DIRS: path.join(appDir, 'usr', 'share'),
    GIO_EXTRA_MODULES: [
      path.join(path.sep, 'usr', 'lib', 'gio', 'modules'),
      path.join(appDir, 'usr', 'lib', 'gio', 'modules'),
    ].join(path.delimiter),
    XDG_CONFIG_HOME: path.join(path.sep, 'home', 'player', '.config'),
    HOME: path.join(path.sep, 'home', 'player'),
  };

  assert.equal(sanitizeAppImageEnvironment(env), true);
  assert.equal(env.LD_LIBRARY_PATH, [path.join(path.sep, 'usr', 'lib'), similarName].join(path.delimiter));
  assert.equal(env.PATH, path.join(path.sep, 'usr', 'bin'));
  assert.equal(env.XDG_DATA_DIRS, undefined);
  assert.equal(env.GIO_EXTRA_MODULES, path.join(path.sep, 'usr', 'lib', 'gio', 'modules'));
  assert.equal(env.XDG_CONFIG_HOME, path.join(path.sep, 'home', 'player', '.config'));
  assert.equal(env.HOME, path.join(path.sep, 'home', 'player'));
  for (const name of ['APPDIR', 'APPIMAGE', 'ARGV0', 'OWD']) {
    assert.equal(env[name], undefined, `${name} 应被移除`);
  }
  assert.equal(sanitizeAppImageEnvironment(env), false);
});

test('非 AppImage 环境不会被修改', () => {
  const env = {PATH: '/usr/bin:/bin', HOME: '/home/player'};
  assert.equal(sanitizeAppImageEnvironment(env), false);
  assert.deepEqual(env, {PATH: '/usr/bin:/bin', HOME: '/home/player'});
});

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  IS_WINDOWS,
  findOnPath,
  extractLibraryPaths,
  execFileAsync,
  spawnDetached,
  isProcessRunningByName,
} = require('./util');
const {probeDemoFile} = require('./downloader');

const CS2_APP_ID = 730;
const CS2_FOLDER = 'Counter-Strike Global Offensive';

function uniquePaths(paths) {
  const seen = new Set();
  const result = [];
  for (const value of paths) {
    if (!value) {
      continue;
    }
    const resolved = path.resolve(value);
    const key = IS_WINDOWS ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(resolved);
  }
  return result;
}

function readRegistrySteamPath() {
  if (!IS_WINDOWS) {
    return null;
  }
  const commands = [
    ['HKCU\\Software\\Valve\\Steam', 'SteamPath'],
    ['HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'],
    ['HKLM\\SOFTWARE\\Valve\\Steam', 'InstallPath'],
  ];
  for (const [key, value] of commands) {
    try {
      const {execFileSync} = require('node:child_process');
      const output = execFileSync('reg', ['query', key, '/v', value], {encoding: 'utf8'});
      const match = output.match(new RegExp(`${value}\\s+REG_[A-Z_]+\\s+(.+)`, 'i'));
      if (match && match[1].trim()) {
        return match[1].trim().replace(/\//g, '\\');
      }
    } catch {
      // Registry key unavailable.
    }
  }
  return null;
}

function getSteamRoots(config = {}) {
  const roots = [];
  if (config.steamPath) {
    const value = path.resolve(config.steamPath);
    if (fs.existsSync(value)) {
      const stat = fs.statSync(value);
      if (stat.isDirectory()) {
        roots.push(value);
      } else {
        roots.push(path.dirname(value));
      }
    }
  }
  if (process.env.STEAM_ROOT) {
    roots.push(process.env.STEAM_ROOT);
  }

  if (IS_WINDOWS) {
    const registryPath = readRegistrySteamPath();
    if (registryPath) {
      roots.push(registryPath);
    }
    if (process.env.ProgramFiles) {
      roots.push(path.join(process.env.ProgramFiles, 'Steam'));
      roots.push(path.join(process.env.ProgramFiles, 'SteamLibrary'));
    }
    if (process.env['ProgramFiles(x86)']) {
      roots.push(path.join(process.env['ProgramFiles(x86)'], 'Steam'));
      roots.push(path.join(process.env['ProgramFiles(x86)'], 'SteamLibrary'));
    }
    roots.push('C:\\Program Files (x86)\\Steam');
    roots.push('C:\\Program Files\\Steam');
  } else {
    roots.push(path.join(os.homedir(), '.steam', 'steam'));
    roots.push(path.join(os.homedir(), '.steam', 'root'));
    roots.push(path.join(os.homedir(), '.local', 'share', 'Steam'));
    roots.push(path.join(os.homedir(), '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam'));
    roots.push('/usr/local/share/Steam');
    roots.push('/usr/share/steam');
  }

  return uniquePaths(roots.filter((root) => {
    try {
      return fs.statSync(root).isDirectory();
    } catch {
      return false;
    }
  }));
}

function getLibraryPaths(steamRoots) {
  const libraries = [];
  for (const root of steamRoots) {
    libraries.push(root);
    const candidates = [
      path.join(root, 'steamapps', 'libraryfolders.vdf'),
      path.join(root, 'config', 'libraryfolders.vdf'),
    ];
    for (const file of candidates) {
      try {
        const content = fs.readFileSync(file, 'utf8');
        libraries.push(...extractLibraryPaths(content));
      } catch {
        // Not every Steam installation has this file.
      }
    }
  }
  return uniquePaths(libraries.filter((library) => {
    try {
      return fs.statSync(library).isDirectory();
    } catch {
      return false;
    }
  }));
}

function resolveConfigCs2Path(input) {
  if (!input) {
    return null;
  }
  let value = path.resolve(input);
  try {
    if (fs.statSync(value).isDirectory()) {
      const base = path.basename(value).toLowerCase();
      if (base === 'csgo') {
        return value;
      }
      if (base === 'replays') {
        return path.dirname(value);
      }
      if (base === 'game') {
        const candidate = path.join(value, 'csgo');
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
      const candidates = [
        path.join(value, 'game', 'csgo'),
        path.join(value, 'csgo'),
        path.join(value, 'Counter-Strike Global Offensive', 'game', 'csgo'),
      ];
      for (const candidate of candidates) {
        if (fs.existsSync(path.join(candidate, 'gameinfo.gi')) || fs.existsSync(candidate)) {
          return candidate;
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

function cs2InfoFromCsgoPath(csgoPath, source) {
  if (!csgoPath) {
    return null;
  }
  try {
    if (!fs.statSync(csgoPath).isDirectory()) {
      return null;
    }
  } catch {
    return null;
  }
  const markers = ['gameinfo.gi', 'pak01_dir.vpk', 'replays', 'cs2.exe'];
  const hasMarker = markers.some((marker) => fs.existsSync(path.join(csgoPath, marker)));
  if (!hasMarker) {
    return null;
  }
  const gamePath = path.dirname(csgoPath);
  const installPath = path.dirname(path.dirname(gamePath));
  return {
    detected: true,
    csgoPath,
    gamePath,
    installPath,
    replaysPath: path.join(csgoPath, 'replays'),
    source,
  };
}

function detectCs2Path(config = {}) {
  const explicit = resolveConfigCs2Path(config.cs2Path);
  if (explicit) {
    return cs2InfoFromCsgoPath(explicit, 'config');
  }

  const steamRoots = getSteamRoots(config);
  const libraryPaths = getLibraryPaths(steamRoots);
  for (const library of libraryPaths) {
    const candidates = [
      path.join(library, 'steamapps', 'common', CS2_FOLDER, 'game', 'csgo'),
      path.join(library, CS2_FOLDER, 'game', 'csgo'),
      path.join(library, 'common', CS2_FOLDER, 'game', 'csgo'),
    ];
    for (const candidate of candidates) {
      const info = cs2InfoFromCsgoPath(candidate, 'auto');
      if (info) {
        return {...info, steamRoots, libraryPaths};
      }
    }
  }
  return {detected: false, steamRoots, libraryPaths};
}

function detectSteamPath(config = {}, cs2Info = {}) {
  const isExecutableFile = (value) => {
    try {
      return fs.statSync(value).isFile();
    } catch {
      return false;
    }
  };

  if (config.steamPath) {
    const value = path.resolve(config.steamPath);
    try {
      const stat = fs.statSync(value);
      if (stat.isFile()) {
        return value;
      }
      if (stat.isDirectory()) {
        const candidates = IS_WINDOWS
          ? [path.join(value, 'steam.exe')]
          : [path.join(value, 'steam.sh'), path.join(value, 'steam')];
        for (const candidate of candidates) {
          if (isExecutableFile(candidate)) {
            return candidate;
          }
        }
      }
    } catch {
      // Fall through to auto detection.
    }
    if (isExecutableFile(value)) {
      return value;
    }
  }

  if (IS_WINDOWS) {
    const roots = [...(cs2Info.steamRoots || []), ...getSteamRoots(config)];
    for (const root of roots) {
      const exe = path.join(root, 'steam.exe');
      if (isExecutableFile(exe)) {
        return exe;
      }
    }
    return null;
  }

  const onPath = findOnPath('steam');
  if (onPath) {
    return onPath;
  }
  const candidates = [
    path.join(os.homedir(), '.steam', 'steam', 'steam.sh'),
    path.join(os.homedir(), '.steam', 'root', 'steam.sh'),
    '/usr/bin/steam',
    '/usr/games/steam',
    '/snap/bin/steam',
  ];
  for (const candidate of candidates) {
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function isCs2Running() {
  if (IS_WINDOWS) {
    try {
      const {stdout} = await execFileAsync('tasklist', ['/FI', 'IMAGENAME eq cs2.exe', '/NH']);
      return /cs2\.exe/i.test(stdout);
    } catch {
      return false;
    }
  }
  if (process.platform === 'linux') {
    return isProcessRunningByName(['cs2', 'cs2.exe', 'cs2_linux64', 'cs2.sh']);
  }
  try {
    const {stdout} = await execFileAsync('ps', ['-A', '-o', 'comm=']);
    return stdout.split('\n').some((line) => line.trim() === 'cs2');
  } catch {
    return false;
  }
}

function getReplaysPath(cs2Info) {
  if (!cs2Info || !cs2Info.replaysPath) {
    return null;
  }
  return cs2Info.replaysPath;
}

async function getEnvironment(config) {
  const cs2 = detectCs2Path(config);
  const steamPath = detectSteamPath(config, cs2);
  const running = await isCs2Running();
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    cs2: {
      detected: Boolean(cs2.detected),
      csgoPath: cs2.csgoPath || null,
      gamePath: cs2.gamePath || null,
      installPath: cs2.installPath || null,
      replaysPath: cs2.replaysPath || null,
      source: cs2.source || null,
      steamRoots: cs2.steamRoots || [],
      libraryPaths: cs2.libraryPaths || [],
    },
    steamPath: steamPath || null,
    cs2Running: running,
  };
}

async function stageDemo({entry, demoPath, cs2}) {
  if (!entry || !entry.fileName) {
    const err = new Error('缺少录像文件信息');
    err.code = 'INVALID_MATCH';
    throw err;
  }
  if (!cs2 || !cs2.replaysPath) {
    const err = new Error('未找到 CS2 安装目录，请在设置中手动指定 CS2 的 game/csgo 路径');
    err.code = 'CS2_NOT_FOUND';
    throw err;
  }
  const sourcePath = demoPath || entry.demoPath;
  if (!sourcePath) {
    const err = new Error('录像文件不存在，请先下载');
    err.code = 'DEMO_NOT_DOWNLOADED';
    throw err;
  }
  const probe = await probeDemoFile(sourcePath);
  if (!probe.valid) {
    const err = new Error('录像文件无效或已损坏，请重新下载');
    err.code = 'INVALID_DEMO';
    throw err;
  }

  const replaysPath = cs2.replaysPath;
  fs.mkdirSync(replaysPath, {recursive: true});
  const fileName = path.basename(entry.fileName);
  const target = path.join(replaysPath, fileName);

  try {
    const sourceStat = await fs.promises.stat(sourcePath);
    let needsCopy = true;
    try {
      const targetStat = await fs.promises.stat(target);
      if (targetStat.size === sourceStat.size) {
        const targetProbe = await probeDemoFile(target);
        if (targetProbe.valid) {
          needsCopy = false;
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw err;
      }
    }

    if (!needsCopy) {
      return {stagedPath: target, method: 'existing', fileName};
    }

    await fs.promises.rm(target, {force: true});
    try {
      await fs.promises.link(sourcePath, target);
      return {stagedPath: target, method: 'hardlink', fileName};
    } catch (err) {
      if (!['EXDEV', 'EPERM', 'EACCES', 'ENOTSUP', 'EMLINK', 'EINVAL'].includes(err.code)) {
        throw err;
      }
    }
    await fs.promises.copyFile(sourcePath, target);
    return {stagedPath: target, method: 'copy', fileName};
  } catch (err) {
    const error = new Error(`准备录像文件失败：${err.message}`);
    error.code = 'STAGE_FAILED';
    error.cause = err;
    throw error;
  }
}

function resolveDemoPath(demoPath) {
  if (!demoPath || typeof demoPath !== 'string') {
    const err = new Error('缺少录像文件路径，请先下载录像');
    err.code = 'DEMO_NOT_DOWNLOADED';
    throw err;
  }
  if (!path.isAbsolute(demoPath)) {
    const err = new Error('播放录像需要录像文件的绝对路径');
    err.code = 'INVALID_DEMO_PATH';
    throw err;
  }
  return path.normalize(demoPath);
}

function quoteForDisplay(value) {
  const text = String(value);
  return /[\s"]/u.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

function quotePathForDisplay(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

async function launchDemo({steamPath, demoPath, cs2Running}) {
  if (cs2Running) {
    const err = new Error('CS2 正在运行，请先完全退出游戏再点击播放');
    err.code = 'CS2_RUNNING';
    throw err;
  }
  if (!steamPath) {
    const err = new Error('未找到 Steam 客户端。请先手动启动 Steam，或在设置中指定 steam 可执行文件路径');
    err.code = 'STEAM_NOT_FOUND';
    throw err;
  }
  const absoluteDemoPath = resolveDemoPath(demoPath);
  // CS2 只在 -insecure 下接受启动参数中的 +playdemo，并且该参数必须是绝对路径。
  // 相对路径（例如 replays/xxx.dem）会被延迟执行但不会开始播放。
  const args = ['-applaunch', String(CS2_APP_ID), '-insecure', '+playdemo', absoluteDemoPath];
  try {
    const result = await spawnDetached(steamPath, args);
    return {...result, demoPath: absoluteDemoPath};
  } catch (err) {
    const error = new Error(`启动 Steam/CS2 失败：${err.message}`);
    error.code = 'LAUNCH_FAILED';
    error.cause = err;
    throw error;
  }
}

function getLaunchCommand(steamPath, demoPath) {
  const absoluteDemoPath = resolveDemoPath(demoPath);
  return `${quoteForDisplay(steamPath || 'steam')} -applaunch ${CS2_APP_ID} -insecure +playdemo ${quotePathForDisplay(absoluteDemoPath)}`;
}

function getConsoleCommand(demoPath) {
  const fileName = path.basename(resolveDemoPath(demoPath));
  return `playdemo ${quotePathForDisplay(`replays/${fileName}`)}`;
}

module.exports = {
  CS2_APP_ID,
  CS2_FOLDER,
  getSteamRoots,
  getLibraryPaths,
  resolveConfigCs2Path,
  detectCs2Path,
  detectSteamPath,
  isCs2Running,
  getEnvironment,
  getReplaysPath,
  stageDemo,
  launchDemo,
  getLaunchCommand,
  getConsoleCommand,
};

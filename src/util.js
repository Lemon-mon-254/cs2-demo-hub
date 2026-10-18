'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {spawn, execFile} = require('node:child_process');
const crypto = require('node:crypto');

const IS_WINDOWS = process.platform === 'win32';

function expandHome(input) {
  if (typeof input !== 'string' || input.length === 0) {
    return input;
  }
  if (input === '~') {
    return os.homedir();
  }
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function resolvePath(input) {
  return path.resolve(expandHome(String(input)));
}

function ensureDirSync(dir) {
  fs.mkdirSync(dir, {recursive: true});
  return dir;
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, {recursive: true});
  return dir;
}

function readJsonSync(file, fallback = null) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT' || err instanceof SyntaxError) {
      return fallback;
    }
    throw err;
  }
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT' || err instanceof SyntaxError) {
      return fallback;
    }
    throw err;
  }
}

function writeFileAtomicSync(file, content, mode = 0o600) {
  ensureDirSync(path.dirname(file));
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, content, {mode});
    try {
      fs.chmodSync(temp, mode);
    } catch {
      // Windows does not support POSIX modes; ignore.
    }
    fs.renameSync(temp, file);
  } catch (err) {
    try {
      fs.unlinkSync(temp);
    } catch {
      // ignore
    }
    throw err;
  }
}

function writeJsonAtomicSync(file, value, mode = 0o600) {
  writeFileAtomicSync(file, `${JSON.stringify(value, null, 2)}\n`, mode);
}

function safeFileName(input, fallback = 'demo') {
  const cleaned = String(input || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim();
  const value = cleaned || fallback;
  return value.length > 180 ? value.slice(0, 180) : value;
}

function isPathInside(parent, child) {
  const parentResolved = path.resolve(parent);
  const childResolved = path.resolve(child);
  return childResolved === parentResolved || childResolved.startsWith(parentResolved + path.sep);
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) {
    return `${value} B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let result = value / 1024;
  let index = 0;
  while (result >= 1024 && index < units.length - 1) {
    result /= 1024;
    index += 1;
  }
  return `${result >= 100 ? result.toFixed(0) : result.toFixed(1)} ${units[index]}`;
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) {
    return `${hours}小时${String(minutes).padStart(2, '0')}分`;
  }
  if (minutes > 0) {
    return `${minutes}分${String(secs).padStart(2, '0')}秒`;
  }
  return `${secs}秒`;
}

function dateParts(dateInput) {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const pad = (value) => String(value).padStart(2, '0');
  return {
    year: date.getFullYear(),
    month: pad(date.getMonth() + 1),
    day: pad(date.getDate()),
    hour: pad(date.getHours()),
    minute: pad(date.getMinutes()),
    second: pad(date.getSeconds()),
  };
}

function formatDate(dateInput) {
  const parts = dateParts(dateInput);
  if (!parts) {
    return '未知时间';
  }
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function fileStamp(dateInput = new Date()) {
  const parts = dateParts(dateInput) || dateParts(new Date());
  return `${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, message = '操作超时') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(message);
      err.code = 'TIMEOUT';
      reject(err);
    }, ms);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function waitForEvent(emitter, event, timeoutMs, options = {}) {
  const {filter, errorEvent = 'error', timeoutMessage = '等待 Steam 响应超时'} = options;
  return new Promise((resolve, reject) => {
    let timer = null;

    function cleanup() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      emitter.removeListener(event, onEvent);
      if (errorEvent) {
        emitter.removeListener(errorEvent, onError);
      }
    }

    function onEvent(...args) {
      if (filter && !filter(...args)) {
        return;
      }
      cleanup();
      resolve(args.length <= 1 ? args[0] : args);
    }

    function onError(err) {
      cleanup();
      reject(err);
    }

    emitter.on(event, onEvent);
    if (errorEvent) {
      emitter.once(errorEvent, onError);
    }
    timer = setTimeout(() => {
      cleanup();
      const err = new Error(timeoutMessage);
      err.code = 'TIMEOUT';
      reject(err);
    }, timeoutMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  });
}

function randomLogonId() {
  return crypto.randomInt(1, 0x7ffffffe);
}

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {encoding: 'utf8', ...options}, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({stdout, stderr});
    });
  });
}

function findOnPath(command) {
  const pathValue = process.env.PATH || '';
  const dirs = pathValue.split(IS_WINDOWS ? ';' : ':').filter(Boolean);
  const extensions = IS_WINDOWS
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean)
    : [''];
  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = path.join(dir, IS_WINDOWS ? `${command}${ext.toLowerCase()}` : command);
      try {
        const stat = fs.statSync(candidate);
        if (stat.isFile()) {
          try {
            fs.accessSync(candidate, fs.constants.X_OK);
          } catch {
            if (!IS_WINDOWS) {
              continue;
            }
          }
          return candidate;
        }
      } catch {
        // Keep looking.
      }
    }
  }
  return null;
}

function spawnDetached(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
        ...options,
      });
    } catch (err) {
      reject(err);
      return;
    }
    child.once('error', reject);
    child.once('spawn', () => {
      child.removeListener('error', reject);
      child.on('error', () => {});
      child.unref();
      resolve({pid: child.pid, command, args});
    });
  });
}

async function openExternal(target) {
  const url = String(target);
  if (IS_WINDOWS) {
    await spawnDetached('cmd', ['/c', 'start', '', url], {windowsHide: true});
    return;
  }
  if (process.platform === 'darwin') {
    await spawnDetached('open', [url]);
    return;
  }
  await spawnDetached('xdg-open', [url]);
}

async function revealPath(target) {
  const resolved = path.resolve(target);
  if (IS_WINDOWS) {
    await spawnDetached('explorer', [resolved]);
    return;
  }
  if (process.platform === 'darwin') {
    await spawnDetached('open', [resolved]);
    return;
  }
  await spawnDetached('xdg-open', [resolved]);
}

function decodeVdfString(value) {
  return value.replace(/\\\\/g, '\\').replace(/\\"/g, '"');
}

function extractLibraryPaths(vdfContent) {
  const paths = new Set();
  if (typeof vdfContent !== 'string') {
    return [];
  }
  let match;
  const pathRegex = /"path"\s+"((?:\\.|[^"\\])*)"/gi;
  while ((match = pathRegex.exec(vdfContent))) {
    const value = decodeVdfString(match[1]).trim();
    if (value) {
      paths.add(value);
    }
  }
  // Very old libraryfolders.vdf format: "1" "D:\\SteamLibrary"
  const legacyRegex = /^\s*"\d+"\s+"([^"]+)"\s*$/gm;
  while ((match = legacyRegex.exec(vdfContent))) {
    const value = decodeVdfString(match[1]).trim();
    if (value && (value.includes('\\') || value.includes('/'))) {
      paths.add(value);
    }
  }
  return [...paths];
}

function visualWidth(value) {
  let width = 0;
  for (const char of String(value)) {
    const code = char.codePointAt(0);
    width += (code >= 0x1100 && (
      code <= 0x115f ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1f64f) ||
      (code >= 0x1f900 && code <= 0x1f9ff)
    )) ? 2 : 1;
  }
  return width;
}

function padDisplay(value, width, align = 'left') {
  const text = String(value ?? '');
  const padding = Math.max(0, width - visualWidth(text));
  if (align === 'right') {
    return ' '.repeat(padding) + text;
  }
  return text + ' '.repeat(padding);
}

function truncateDisplay(value, width) {
  const text = String(value ?? '');
  if (visualWidth(text) <= width) {
    return text;
  }
  let result = '';
  let used = 0;
  for (const char of text) {
    const charWidth = visualWidth(char);
    if (used + charWidth > width - 1) {
      break;
    }
    result += char;
    used += charWidth;
  }
  return `${result}…`;
}

function isProcessRunningByName(names) {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  if (IS_WINDOWS) {
    return false;
  }
  let entries = [];
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    try {
      const comm = fs.readFileSync(`/proc/${entry}/comm`, 'utf8').trim().toLowerCase();
      if (wanted.has(comm)) {
        return true;
      }
      const cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8');
      const first = cmdline.split('\0')[0];
      if (first) {
        const base = path.basename(first).toLowerCase();
        if (wanted.has(base)) {
          return true;
        }
      }
    } catch {
      // Process may have exited or we lack permission.
    }
  }
  return false;
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(item);
  }
  return result;
}

module.exports = {
  IS_WINDOWS,
  expandHome,
  resolvePath,
  ensureDirSync,
  ensureDir,
  readJsonSync,
  readJson,
  writeFileAtomicSync,
  writeJsonAtomicSync,
  safeFileName,
  isPathInside,
  formatBytes,
  formatDuration,
  formatDate,
  fileStamp,
  dateParts,
  sleep,
  withTimeout,
  waitForEvent,
  randomLogonId,
  execFileAsync,
  findOnPath,
  spawnDetached,
  openExternal,
  revealPath,
  extractLibraryPaths,
  visualWidth,
  padDisplay,
  truncateDisplay,
  isProcessRunningByName,
  uniqueBy,
};

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const readlinePromises = require('node:readline/promises');
const {stdin, stdout} = require('node:process');
const QRCode = require('qrcode');
const {ConfigStore} = require('./config');
const {Library} = require('./library');
const {SteamService} = require('./steam');
const {createServer} = require('./server');
const {downloadDemo, probeDemoFile} = require('./downloader');
const {
  getEnvironment,
  isCs2Running,
  stageDemo,
  launchDemo,
  getLaunchCommand,
  getConsoleCommand,
} = require('./cs2');
const {
  parseShareCode,
  formatScore,
  matchTitle,
} = require('./valve-matches');
const {
  formatBytes,
  formatDuration,
  formatDate,
  openExternal,
  sleep,
} = require('./util');

const useColor = Boolean(stdout.isTTY) && !process.env.NO_COLOR;
const color = (code) => (text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : String(text));
const green = color('32');
const red = color('31');
const yellow = color('33');
const cyan = color('36');
const dim = color('2');
const bold = color('1');

const VALUE_OPTIONS = new Set([
  'account',
  'code',
  'port',
  'demo-dir',
  'cs2-path',
  'steam-path',
  'auto-download',
]);

const STATE_LABELS = {
  downloaded: green('已下载'),
  missing: yellow('文件丢失'),
  corrupted: red('已损坏'),
  none: dim('未下载'),
};

function printHelp() {
  console.log(`
${bold('CS2 录像中心')} ${dim('v1.0.0')}
自动同步、下载 CS2 比赛录像，并一键用 CS2 播放。

${bold('用法')}
  cs2hub <命令> [选项]

${bold('命令')}
  ${cyan('login')}            扫码登录 Steam（默认），或使用 --password 密码登录
  ${cyan('logout')}           退出 Steam 账号并清除本地登录凭据
  ${cyan('sync')}             从 Steam 同步最近 8 场比赛 [--download]
  ${cyan('share')} <代码>     用分享代码添加比赛 [--download]
  ${cyan('matches')}          查看本地比赛列表 [--json]
  ${cyan('download')} <比赛>  下载指定比赛（ID、ID 前缀或分享代码）[--all]
  ${cyan('play')} <比赛>      一键下载（如需要）并启动 CS2 播放
  ${cyan('delete')} <比赛>    删除指定比赛和录像文件 [--yes]
  ${cyan('ui')}               启动本地网页界面 [--port 3210] [--open] [--mock]
  ${cyan('config')}           查看或修改配置
  ${cyan('doctor')}           检查运行环境
  ${cyan('help')}             显示本帮助

${bold('示例')}
  cs2hub login
  cs2hub sync --download
  cs2hub share CSGO-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx --download
  cs2hub play 7300000000000000001
  cs2hub ui --open

${bold('说明')}
  同步比赛需要连接 Steam Game Coordinator，请先完全退出 CS2。
  网页界面仅监听 127.0.0.1，不会暴露到局域网。
`);
}

function parseArgs(args) {
  const options = {_raw: args.slice()};
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const body = arg.slice(2);
    if (!body) {
      continue;
    }
    let key;
    let value;
    const eqIndex = body.indexOf('=');
    if (eqIndex !== -1) {
      key = body.slice(0, eqIndex);
      value = body.slice(eqIndex + 1);
    } else {
      key = body;
      if (VALUE_OPTIONS.has(key)) {
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          value = next;
          i += 1;
        } else {
          value = '';
        }
      } else {
        value = true;
      }
    }
    options[key] = value;
  }
  options._ = positional;
  return options;
}

function createStores() {
  const configStore = new ConfigStore();
  configStore.ensure();
  const config = configStore.get();
  const library = new Library(config.demoDir);
  library.ensure();
  return {configStore, config, library};
}

function createService(configStore, options = {}) {
  return new SteamService(configStore, {
    logger: options.verbose ? (message) => console.log(dim(message)) : () => {},
  });
}

function ensureLoggedIn(configStore) {
  const session = configStore.getSessionSummary();
  if (!session.loggedIn) {
    throw new Error('尚未登录 Steam。请先运行 cs2hub login 扫码登录');
  }
  return session;
}

async function confirm(question) {
  if (!stdin.isTTY) {
    return false;
  }
  const rl = readlinePromises.createInterface({input: stdin, output: stdout});
  try {
    const answer = await rl.question(`${question} ${dim('[y/N]')} `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function promptText(question) {
  const rl = readlinePromises.createInterface({input: stdin, output: stdout});
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

function promptHidden(question) {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error('当前不是交互终端，无法隐藏输入密码。请在网页界面使用密码登录，或使用扫码登录');
  }
  return new Promise((resolve, reject) => {
    stdout.write(question);
    stdin.resume();
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    let value = '';

    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
    };
    const onData = (char) => {
      for (const key of char) {
        if (key === '\u0003') {
          cleanup();
          stdout.write('\n');
          reject(new Error('已取消输入'));
          return;
        }
        if (key === '\r' || key === '\n') {
          cleanup();
          stdout.write('\n');
          resolve(value);
          return;
        }
        if (key === '\u007f' || key === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1);
            stdout.write('\b \b');
          }
          continue;
        }
        if (key === '\u001b') {
          continue;
        }
        value += key;
        stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

function statusFor(entry) {
  if (entry.downloaded) {
    return STATE_LABELS.downloaded;
  }
  if (entry.corrupted) {
    return STATE_LABELS.corrupted;
  }
  if (entry.missing) {
    return STATE_LABELS.missing;
  }
  return STATE_LABELS.none;
}

function printMatchTable(entries) {
  if (entries.length === 0) {
    console.log(yellow('还没有比赛记录。运行 cs2hub sync 从 Steam 同步最近比赛。'));
    return;
  }
  const indexWidth = String(entries.length).length;
  console.log(
    dim(
      `${'#'.padEnd(indexWidth)}  ${'日期'.padEnd(16)}  ${'地图'.padEnd(14)}  ${'比分'.padEnd(8)}  ${'时长'.padEnd(8)}  ${'状态'.padEnd(6)}  比赛 ID`,
    ),
  );
  entries.forEach((entry, index) => {
    const map = entry.mapName || entry.map || '未知';
    const date = entry.date ? formatDate(entry.date) : '未知时间';
    const score = Number.isInteger(entry.scoreCT) ? `${entry.scoreCT}:${entry.scoreT}` : '-';
    const duration = entry.duration ? formatDuration(entry.duration) : '-';
    const rawStatus = entry.downloaded ? '已下载' : entry.corrupted ? '已损坏' : entry.missing ? '文件丢失' : '未下载';
    console.log(
      `${String(index + 1).padEnd(indexWidth)}  ${date.padEnd(16)}  ${map.padEnd(14)}  ${score.padEnd(8)}  ${duration.padEnd(8)}  ${statusFor(entry)}  ${entry.matchId}`,
    );
    if (rawStatus === '未下载' && !entry.demoUrl) {
      console.log(dim('   该比赛没有可用的录像链接，请重新同步或使用分享代码'));
    }
  });
  const stats = {
    total: entries.length,
    downloaded: entries.filter((entry) => entry.downloaded).length,
  };
  console.log(dim(`\n共 ${stats.total} 场，已下载 ${stats.downloaded} 场。录像目录：${entries[0]?.demoDir || ''}`));
}

function printMatchDetail(entry) {
  console.log('');
  console.log(bold(matchTitle(entry)));
  console.log(`  ${dim('地图')}      ${entry.mapLabel || entry.map || '未知'}`);
  console.log(`  ${dim('时间')}      ${entry.date ? formatDate(entry.date) : '未知'}`);
  console.log(`  ${dim('比分')}      ${formatScore(entry)}`);
  console.log(`  ${dim('时长')}      ${entry.duration ? formatDuration(entry.duration) : '未知'}${entry.rounds ? ` · ${entry.rounds} 回合` : ''}`);
  console.log(`  ${dim('比赛 ID')}   ${entry.matchId}`);
  if (entry.shareCode) {
    console.log(`  ${dim('分享代码')}  ${entry.shareCode}`);
  }
  console.log(`  ${dim('状态')}      ${statusFor(entry)}${entry.size ? dim(` · ${formatBytes(entry.size)}`) : ''}`);
  if (entry.demoPath) {
    console.log(`  ${dim('文件')}      ${entry.demoPath}`);
  }
  if (!entry.demoUrl) {
    console.log(yellow('  该比赛没有可用的录像下载链接'));
  }
  console.log('');
}

function progressLine(text) {
  if (!stdout.isTTY) {
    return;
  }
  stdout.write(`\r\x1b[2K${text}`);
}

function downloadProgressText(progress) {
  if (progress.phase === 'download') {
    if (progress.total > 0) {
      return `  下载中 ${String(progress.percent ?? 0).padStart(3)}%  ${formatBytes(progress.received)} / ${formatBytes(progress.total)}`;
    }
    return `  下载中  ${formatBytes(progress.received)}`;
  }
  if (progress.phase === 'decompress') {
    return '  正在解压录像…';
  }
  return '  正在完成…';
}

async function downloadOne(library, entry, options = {}) {
  const prepared = library.prepareDownload(entry.matchId);
  if (!prepared.demoUrl) {
    throw new Error('该比赛没有可用的录像下载链接，请重新同步或使用分享代码');
  }
  let lastPhase = null;
  const result = await downloadDemo(prepared, {
    demoDir: library.demoDir,
    onProgress: (progress) => {
      if (stdout.isTTY) {
        progressLine(downloadProgressText(progress));
      } else if (progress.phase && progress.phase !== lastPhase) {
        lastPhase = progress.phase;
        if (progress.phase !== 'done') {
          console.log(`  正在${progress.phase === 'download' ? '下载' : '解压'}…`);
        }
      }
    },
  });
  if (stdout.isTTY) {
    stdout.write('\r\x1b[2K');
  }
  const entryAfter = library.markDownloaded(entry.matchId, {
    fileName: prepared.fileName,
    size: result.size,
    format: result.format,
  });
  const label = entryAfter.mapName || entryAfter.map || entryAfter.matchId;
  console.log(`${green('✓')} 下载完成：${label} ${dim(`(${formatBytes(result.size)}${result.skipped ? '，已存在' : ''})`)}`);
  console.log(dim(`  ${entryAfter.demoPath || path.join(library.demoDir, prepared.fileName)}`));
  return entryAfter;
}

async function downloadMany(library, entries) {
  const targets = entries.filter((entry) => !entry.downloaded);
  if (targets.length === 0) {
    console.log(green('所有比赛录像都已下载。'));
    return {ok: 0, failed: 0};
  }
  let ok = 0;
  let failed = 0;
  for (const [index, entry] of targets.entries()) {
    console.log(`\n${dim(`[${index + 1}/${targets.length}]`)} ${matchTitle(entry)}`);
    if (!entry.demoUrl) {
      console.log(yellow('  跳过：没有可用的录像链接'));
      failed += 1;
      continue;
    }
    try {
      await downloadOne(library, entry);
      ok += 1;
    } catch (err) {
      failed += 1;
      console.log(`${red('✗')} 下载失败：${err.message}`);
    }
  }
  console.log(`\n完成：成功 ${ok} 个，失败 ${failed} 个。`);
  return {ok, failed};
}

async function resolveEntry(library, input) {
  const candidates = library.findCandidates(input);
  if (candidates.length === 0) {
    return null;
  }
  if (candidates.length > 1) {
    console.log(yellow(`找到 ${candidates.length} 场匹配的比赛：`));
    printMatchTable(candidates);
    throw new Error('请输入更完整的比赛 ID');
  }
  return candidates[0];
}

function looksLikeShareCode(value) {
  try {
    parseShareCode(value);
    return true;
  } catch {
    return false;
  }
}

async function resolveOrFetch(library, service, configStore, input, options = {}) {
  let entry = await resolveEntry(library, input);
  if (entry) {
    return entry;
  }
  if (!looksLikeShareCode(input)) {
    throw new Error(`未找到比赛：${input}。可先运行 cs2hub sync，或使用分享代码`);
  }
  ensureLoggedIn(configStore);
  if (await isCs2Running()) {
    throw new Error('CS2 正在运行。查询分享代码需要连接 Steam GC，请先完全退出 CS2');
  }
  console.log(dim('正在通过分享代码向 Steam 查询比赛…'));
  const match = await service.requestShareCode(input);
  const merged = library.mergeMatches([match]);
  entry = merged.entries.find((item) => String(item.matchId) === String(match.matchId));
  if (!entry) {
    throw new Error('查询到比赛，但写入本地列表失败');
  }
  console.log(`${green('✓')} 已添加比赛：${matchTitle(entry)}`);
  return entry;
}

async function waitForLoginOutcome(service, timeoutMs = 150000) {
  return new Promise((resolve, reject) => {
    let timer = null;
    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
      }
      service.removeListener('loginState', onState);
    };
    const onState = (state) => {
      if (state.phase === 'success') {
        cleanup();
        resolve(state);
      } else if (state.phase === 'error') {
        cleanup();
        reject(new Error(state.message || '登录失败'));
      }
    };
    const current = service.getLoginState();
    if (current.phase === 'success') {
      resolve(current);
      return;
    }
    if (current.phase === 'error') {
      reject(new Error(current.message || '登录失败'));
      return;
    }
    service.on('loginState', onState);
    timer = setTimeout(() => {
      cleanup();
      reject(new Error('登录等待超时，请重新运行 cs2hub login'));
    }, timeoutMs);
  });
}

async function cmdLogin(options) {
  const {configStore} = createStores();
  const service = createService(configStore, {verbose: Boolean(options.verbose)});
  try {
    if (options.password) {
      const accountName = options.account || (await promptText('Steam 账号：')).trim();
      if (!accountName) {
        throw new Error('Steam 账号不能为空');
      }
      const password = await promptHidden('Steam 密码（输入不会显示）：');
      if (!password) {
        throw new Error('Steam 密码不能为空');
      }
      let state = await service.startPasswordLogin({
        accountName,
        password,
        steamGuardCode: options.code || undefined,
      });
      let firstCode = options.code || null;
      while (state.phase === 'needGuard') {
        if (state.canSubmitCode) {
          const code = firstCode || (await promptText(
            `请输入 Steam 安全验证码${state.actions[0]?.detail ? dim(`（${state.actions[0].detail}）`) : ''}：`,
          )).trim();
          firstCode = null;
          if (!code) {
            throw new Error('安全验证码不能为空');
          }
          state = await service.submitGuardCode(code);
        } else {
          console.log(yellow(`需要完成验证：${state.actions.map((action) => action.label).join('、')}`));
          console.log('请按提示完成验证，或改用扫码登录：cs2hub login');
          break;
        }
      }
      if (state.phase === 'needGuard' && !state.canSubmitCode) {
        state = await waitForLoginOutcome(service);
      } else if (state.phase === 'waiting' || state.phase === 'starting') {
        console.log(dim('等待 Steam 完成登录…'));
        state = await waitForLoginOutcome(service);
      } else if (state.phase === 'needGuard') {
        state = await waitForLoginOutcome(service);
      }
      console.log(`${green('✓')} ${state.message || '登录成功'}：${state.accountName || state.steamID || ''}`);
      return;
    }

    const state = await service.startQrLogin();
    if (!state.qrChallengeUrl) {
      throw new Error('未能获取 Steam 登录二维码');
    }
    const qr = await QRCode.toString(state.qrChallengeUrl, {
      type: 'terminal',
      small: true,
      errorCorrectionLevel: 'M',
    });
    console.log('');
    console.log(qr);
    console.log(bold('请使用 Steam 手机 App 扫描上方二维码并确认登录。'));
    console.log(dim('二维码约 2 分钟内有效。若已过期，请重新运行 cs2hub login。'));
    console.log('');
    const result = await waitForLoginOutcome(service);
    console.log(`${green('✓')} 登录成功：${result.accountName || result.steamID || 'Steam 账号'}`);
    console.log(dim('现在可以运行 cs2hub sync 同步最近比赛。'));
  } finally {
    await service.dispose();
  }
}

async function cmdLogout() {
  const {configStore} = createStores();
  const service = createService(configStore);
  service.logout();
  await service.dispose();
  console.log(`${green('✓')} 已退出 Steam 账号，本地登录凭据已删除。`);
}

async function cmdSync(options) {
  ensureLoggedIn(createStores().configStore);
  const {configStore, library} = createStores();
  const service = createService(configStore, {verbose: Boolean(options.verbose)});
  try {
    if (await isCs2Running()) {
      throw new Error('CS2 正在运行。同步比赛会占用同一个 Steam 账号的 GC 会话，请先完全退出游戏');
    }
    console.log(dim('正在连接 Steam 并获取最近比赛（最多 8 场）…'));
    const matches = await service.requestRecentMatches();
    if (matches.length === 0) {
      console.log(yellow('Steam 没有返回最近比赛。可能近期没有进行过 CS2 匹配，或该账号的比赛记录不可用。'));
      return;
    }
    const merged = library.mergeMatches(matches);
    console.log(`${green('✓')} 同步完成：新增 ${merged.added} 场，更新 ${merged.updated} 场。`);
    printMatchTable(merged.entries);
    if (options.download) {
      await downloadMany(library, merged.entries);
    } else {
      console.log(dim('\n提示：使用 cs2hub download --all 下载全部录像，或 cs2hub play <比赛 ID> 一键播放。'));
    }
  } finally {
    await service.dispose();
  }
}

async function cmdShare(options) {
  const input = options.shareCode || options._[0];
  if (!input) {
    throw new Error('用法：cs2hub share <分享代码> [--download]');
  }
  parseShareCode(input);
  ensureLoggedIn(createStores().configStore);
  const {configStore, library} = createStores();
  const service = createService(configStore, {verbose: Boolean(options.verbose)});
  try {
    if (await isCs2Running()) {
      throw new Error('CS2 正在运行。查询分享代码需要连接 Steam GC，请先完全退出游戏');
    }
    console.log(dim('正在查询分享代码对应的比赛…'));
    const match = await service.requestShareCode(input);
    const merged = library.mergeMatches([match]);
    const entry = merged.entries.find((item) => String(item.matchId) === String(match.matchId));
    console.log(`${green('✓')} 已添加比赛。`);
    printMatchDetail(entry);
    if (options.download) {
      await downloadOne(library, entry);
    } else {
      console.log(dim(`提示：运行 cs2hub download ${entry.matchId} 下载，或 cs2hub play ${entry.matchId} 下载并播放。`));
    }
  } finally {
    await service.dispose();
  }
}

async function cmdMatches(options) {
  const {library} = createStores();
  const entries = library.list();
  if (options.json) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }
  const stats = library.stats();
  console.log(bold(`本地比赛（${stats.downloaded}/${stats.total} 已下载，共 ${formatBytes(stats.bytes)}）`));
  console.log(dim(`录像目录：${library.demoDir}\n`));
  printMatchTable(entries);
}

async function cmdDownload(options) {
  const {configStore, library} = createStores();
  const service = createService(configStore, {verbose: Boolean(options.verbose)});
  try {
    if (options.all) {
      await downloadMany(library, library.list());
      return;
    }
    const input = options._[0];
    if (!input) {
      throw new Error('用法：cs2hub download <比赛 ID / ID 前缀 / 分享代码>，或 cs2hub download --all');
    }
    let entry = await resolveEntry(library, input);
    if (!entry) {
      entry = await resolveOrFetch(library, service, configStore, input);
    }
    printMatchDetail(entry);
    if (entry.downloaded) {
      console.log(green('该录像已经下载，无需重复下载。'));
      return;
    }
    await downloadOne(library, entry);
  } finally {
    await service.dispose();
  }
}

async function cmdPlay(options) {
  const {configStore, library} = createStores();
  const service = createService(configStore, {verbose: Boolean(options.verbose)});
  try {
    const input = options._[0];
    if (!input) {
      throw new Error('用法：cs2hub play <比赛 ID / ID 前缀 / 分享代码>');
    }
    if (await isCs2Running()) {
      throw new Error('CS2 正在运行，请先完全退出游戏再播放录像');
    }
    const env = await getEnvironment(configStore.get());
    if (!env.cs2.detected) {
      throw new Error('未找到 CS2 安装目录。请运行 cs2hub config --cs2-path "<CS2>/game/csgo" 手动指定');
    }
    if (!env.steamPath) {
      throw new Error('未找到 Steam 客户端。请先安装/启动 Steam，或使用 cs2hub config --steam-path 指定路径');
    }

    let entry = await resolveOrFetch(library, service, configStore, input);
    printMatchDetail(entry);
    if (!entry.downloaded) {
      entry = await downloadOne(library, entry);
    }
    entry = library.get(entry.matchId);
    if (!entry.downloaded) {
      throw new Error('录像文件不可用，请重新下载');
    }

    if (await isCs2Running()) {
      throw new Error('CS2 刚刚启动了，请等待游戏完全进入后再试，或先退出游戏');
    }

    console.log(dim('正在准备 CS2 录像目录…'));
    const staged = await stageDemo({
      entry,
      demoPath: entry.demoPath,
      cs2: env.cs2,
    });
    console.log(`${green('✓')} 录像已${staged.method === 'hardlink' ? '硬链接' : staged.method === 'copy' ? '复制' : '就绪'}到 CS2 录像目录。`);
    console.log(dim(`  ${staged.stagedPath}`));

    const launch = await launchDemo({
      steamPath: env.steamPath,
      demoPath: staged.stagedPath,
      cs2Running: false,
    });
    console.log(`${green('✓')} 已请求 Steam 启动 CS2 并载入录像。`);
    console.log(dim(`  ${getLaunchCommand(env.steamPath, staged.stagedPath)}`));
    if (launch.pid) {
      console.log(dim(`  Steam 进程 PID：${launch.pid}`));
    }
    console.log(yellow('\n如果 CS2 没有自动开始播放，请在游戏控制台执行：'));
    console.log(`  ${getConsoleCommand(staged.stagedPath)}`);
  } finally {
    await service.dispose();
  }
}

async function cmdDelete(options) {
  const {configStore, library} = createStores();
  const input = options._[0];
  if (!input) {
    throw new Error('用法：cs2hub delete <比赛 ID / ID 前缀> [--yes]');
  }
  const candidates = library.findCandidates(input);
  if (candidates.length === 0) {
    throw new Error(`未找到比赛：${input}`);
  }
  if (candidates.length > 1) {
    printMatchTable(candidates);
    throw new Error('找到多场匹配的比赛，请输入更完整的 ID');
  }
  const entry = candidates[0];
  printMatchDetail(entry);
  if (!options.yes) {
    const confirmed = await confirm('确定删除这场比赛和本地录像文件吗？此操作不可撤销。');
    if (!confirmed) {
      console.log(dim('已取消。'));
      return;
    }
  }
  if (await isCs2Running()) {
    throw new Error('CS2 正在运行，请先退出游戏再删除录像');
  }
  const env = await getEnvironment(configStore.get());
  const result = library.delete(entry.matchId, {
    replaysDir: env.cs2.replaysPath || null,
    keepRecord: false,
  });
  console.log(`${green('✓')} 已删除比赛：${entry.matchId}`);
  if (result.removedFile) {
    console.log(dim('  本地录像文件已删除'));
  }
  if (result.removedReplay) {
    console.log(dim('  CS2 replays 目录中的副本已删除'));
  }
}

async function cmdConfig(options) {
  const {configStore, config} = createStores();
  const patch = {};
  if (options['demo-dir'] !== undefined) {
    if (!options['demo-dir']) {
      throw new Error('录像目录不能为空');
    }
    patch.demoDir = options['demo-dir'];
  }
  if (options['cs2-path'] !== undefined) {
    patch.cs2Path = options['cs2-path'] || null;
  }
  if (options['steam-path'] !== undefined) {
    patch.steamPath = options['steam-path'] || null;
  }
  if (options.port !== undefined) {
    const port = Number(options.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('端口必须是 1 到 65535 之间的整数');
    }
    patch.port = port;
  }
  if (options['auto-download'] !== undefined) {
    const value = String(options['auto-download']).toLowerCase();
    if (!['true', 'false', '1', '0', 'yes', 'no'].includes(value)) {
      throw new Error('auto-download 只能是 true 或 false');
    }
    patch.autoDownload = ['true', '1', 'yes'].includes(value);
  }

  if (Object.keys(patch).length > 0) {
    const updated = configStore.update(patch);
    const env = await getEnvironment(updated);
    console.log(`${green('✓')} 配置已保存。`);
    if (!env.cs2.detected && patch.cs2Path !== undefined) {
      console.log(yellow('提示：指定的 CS2 路径暂未检测到 gameinfo.gi 等文件，请确认路径指向 game/csgo。'));
    }
  }

  const session = configStore.getSessionSummary();
  const env = await getEnvironment(configStore.get());
  console.log(bold('\n配置'));
  console.log(`  ${dim('配置文件')}    ${configStore.path}`);
  console.log(`  ${dim('录像目录')}    ${configStore.get().demoDir}`);
  console.log(`  ${dim('自动下载')}    ${configStore.get().autoDownload ? '开启' : '关闭'}`);
  console.log(`  ${dim('网页端口')}    ${configStore.get().port}`);
  console.log(`  ${dim('CS2 路径')}    ${env.cs2.csgoPath || yellow('未检测到')}`);
  console.log(`  ${dim('replays')}     ${env.cs2.replaysPath || yellow('未检测到')}`);
  console.log(`  ${dim('Steam 路径')}  ${env.steamPath || yellow('未检测到')}`);
  console.log(`  ${dim('登录状态')}    ${session.loggedIn ? green(`已登录${session.accountName ? `（${session.accountName}）` : ''}`) : yellow('未登录')}`);
  console.log('');
  console.log(dim('修改示例：'));
  console.log(dim('  cs2hub config --auto-download=true'));
  console.log(dim('  cs2hub config --demo-dir "D:\\\\CS2Demos"'));
  console.log(dim('  cs2hub config --cs2-path "C:\\\\Program Files (x86)\\\\Steam\\\\steamapps\\\\common\\\\Counter-Strike Global Offensive\\\\game\\\\csgo"'));
}

async function cmdDoctor(options) {
  const {configStore, library} = createStores();
  const env = await getEnvironment(configStore.get());
  const session = configStore.getSessionSummary();
  const stats = library.stats();
  let demoDirWritable = false;
  try {
    const probe = path.join(configStore.get().demoDir, `.write-test-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    demoDirWritable = true;
  } catch {
    demoDirWritable = false;
  }
  let replaysWritable = false;
  if (env.cs2.replaysPath) {
    try {
      fs.accessSync(env.cs2.replaysPath, fs.constants.W_OK);
      replaysWritable = true;
    } catch {
      replaysWritable = false;
    }
  }

  const rows = [
    ['Node.js', process.version, true],
    ['平台', `${process.platform} ${process.arch}`, true],
    ['配置文件', configStore.path, true],
    ['录像目录', `${configStore.get().demoDir}${demoDirWritable ? '' : `  ${red('不可写')}`}`, demoDirWritable],
    ['CS2 安装', env.cs2.csgoPath || red('未检测到'), env.cs2.detected],
    ['replays 目录', env.cs2.replaysPath || red('未检测到'), Boolean(env.cs2.replaysPath)],
    ['replays 可写', replaysWritable ? '是' : red('否（首次启动 CS2 后会自动创建）'), replaysWritable],
    ['Steam 客户端', env.steamPath || red('未检测到'), Boolean(env.steamPath)],
    ['Steam 登录', session.loggedIn ? green(`已登录${session.accountName ? `（${session.accountName}）` : ''}`) : yellow('未登录，请运行 cs2hub login'), session.loggedIn],
    ['CS2 进程', env.cs2Running ? yellow('正在运行（同步前需退出）') : '未运行', !env.cs2Running],
    ['本地比赛', `${stats.total} 场，已下载 ${stats.downloaded} 场（${formatBytes(stats.bytes)}）`, true],
  ];
  if (stats.missing > 0 || stats.corrupted > 0) {
    rows.push(['文件异常', `${stats.missing} 个丢失，${stats.corrupted} 个损坏`, false]);
  }

  console.log(bold('\n环境检查\n'));
  for (const [name, value, ok] of rows) {
    const icon = ok ? green('✓') : yellow('!');
    console.log(`  ${icon} ${name.padEnd(14)} ${value}`);
  }
  console.log('');
  if (!env.cs2.detected) {
    console.log(yellow('未自动找到 CS2。请使用 cs2hub config --cs2-path 指定 game/csgo 目录。'));
  }
  if (!env.steamPath) {
    console.log(yellow('未找到 Steam 可执行文件。请使用 cs2hub config --steam-path 指定。'));
  }
  if (!session.loggedIn) {
    console.log(yellow('尚未登录 Steam。运行 cs2hub login 扫码登录后才能同步/分享代码。'));
  }
  console.log('');
}

async function cmdUi(options) {
  const {configStore, library} = createStores();
  const config = configStore.get();
  const port = options.port ? Number(options.port) : config.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('端口必须是 1 到 65535 之间的整数');
  }
  const service = createService(configStore, {verbose: Boolean(options.verbose)});
  const {server} = createServer({
    configStore,
    service,
    library,
    mock: Boolean(options.mock),
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const url = `http://127.0.0.1:${port}`;
  console.log('');
  console.log(`${green('✓')} CS2 录像中心已启动：${bold(url)}`);
  console.log(`  ${dim('录像目录')}  ${config.demoDir}`);
  if (options.mock) {
    console.log(yellow('  当前为预览模式（--mock），不会真正登录 Steam 或启动 CS2。'));
  }
  console.log(dim('  按 Ctrl+C 停止服务。'));
  console.log('');

  if (options.open) {
    try {
      await openExternal(url);
    } catch {
      console.log(yellow('无法自动打开浏览器，请手动访问上面的地址。'));
    }
  }

  await new Promise((resolve) => {
    let stopping = false;
    const stop = () => {
      if (stopping) {
        return;
      }
      stopping = true;
      console.log(dim('\n正在停止服务…'));
      server.close(() => resolve());
      setTimeout(resolve, 2000).unref?.();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    server.once('close', resolve);
  });
  await service.dispose().catch(() => {});
  console.log(dim('服务已停止。'));
}

async function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  const options = parseArgs(argv.slice(1));
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }
  if (command === 'version' || command === '--version' || command === '-v') {
    console.log(require('../package.json').version);
    return;
  }

  const commands = {
    login: cmdLogin,
    logout: cmdLogout,
    sync: cmdSync,
    share: cmdShare,
    matches: cmdMatches,
    download: cmdDownload,
    play: cmdPlay,
    delete: cmdDelete,
    config: cmdConfig,
    doctor: cmdDoctor,
    ui: cmdUi,
  };
  const handler = commands[command];
  if (!handler) {
    console.error(red(`未知命令：${command}`));
    console.error(dim('运行 cs2hub help 查看可用命令。'));
    process.exitCode = 1;
    return;
  }
  await handler(options);
}

module.exports = {
  main,
  parseArgs,
  printHelp,
  cmdLogin,
  cmdSync,
  cmdMatches,
  cmdDownload,
  cmdPlay,
  cmdDelete,
  cmdShare,
  cmdConfig,
  cmdDoctor,
  cmdUi,
  waitForLoginOutcome,
  resolveOrFetch,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(`${red('错误：')}${err.message}`);
    if (process.env.DEBUG) {
      console.error(err.stack);
    }
    process.exitCode = 1;
  });
}

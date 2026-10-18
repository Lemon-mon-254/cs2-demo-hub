'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const {Readable, Transform} = require('node:stream');
const {pipeline} = require('node:stream/promises');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const unbzip2 = require('unbzip2-stream');
const {ensureDir, formatBytes} = require('./util');

const CS2_HEADER = Buffer.from('PBDEMS2\0', 'binary');
const CSGO_HEADER = Buffer.from('HL2DEMO\0', 'binary');

class DemoError extends Error {
  constructor(message, code, options = {}) {
    super(message, options);
    this.name = 'DemoError';
    this.code = code;
  }
}

function probeDemoBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) {
    return {valid: false, format: null};
  }
  if (buffer.subarray(0, 8).equals(CS2_HEADER)) {
    return {valid: true, format: 'cs2'};
  }
  if (buffer.subarray(0, 8).equals(CSGO_HEADER)) {
    return {valid: true, format: 'csgo'};
  }
  return {valid: false, format: null};
}

async function probeDemoFile(filePath) {
  let handle;
  try {
    handle = await fsp.open(filePath, 'r');
    const buffer = Buffer.alloc(8);
    const {bytesRead} = await handle.read(buffer, 0, 8, 0);
    return probeDemoBuffer(buffer.subarray(0, bytesRead));
  } catch (err) {
    if (err.code === 'ENOENT') {
      return {valid: false, format: null, missing: true};
    }
    throw err;
  } finally {
    if (handle) {
      await handle.close().catch(() => {});
    }
  }
}

function compressionFromUrl(url) {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    if (pathname.endsWith('.bz2')) {
      return 'bz2';
    }
    if (pathname.endsWith('.gz') || pathname.endsWith('.gzip')) {
      return 'gz';
    }
  } catch {
    // Fall through to unknown compression.
  }
  return null;
}

async function fetchToFile(url, tempFile, {onProgress, timeoutMs = 15 * 60 * 1000} = {}) {
  const controller = new AbortController();
  let inactivityTimer;
  const armTimer = () => {
    clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => controller.abort(new Error('下载超时')), timeoutMs);
    if (typeof inactivityTimer.unref === 'function') {
      inactivityTimer.unref();
    }
  };
  armTimer();

  let response;
  try {
    response = await fetch(url, {
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; CS2DemoHub/1.0)',
        accept: '*/*',
      },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(inactivityTimer);
    throw new DemoError('无法连接到录像服务器，请检查网络或代理设置', 'DOWNLOAD_FAILED', {cause: err});
  }
  armTimer();

  if (!response.ok) {
    clearTimeout(inactivityTimer);
    await response.body?.cancel().catch(() => {});
    if ([403, 404, 410].includes(response.status)) {
      throw new DemoError(
        '录像下载链接已失效（Valve 下载链接可能过期）。请重新同步比赛或使用分享代码刷新链接',
        'DEMO_URL_EXPIRED',
      );
    }
    throw new DemoError(`下载失败：服务器返回 HTTP ${response.status}`, 'DOWNLOAD_FAILED');
  }

  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('text/html')) {
    clearTimeout(inactivityTimer);
    await response.body?.cancel().catch(() => {});
    throw new DemoError('录像链接已失效，服务器返回了网页而不是录像文件', 'DEMO_URL_EXPIRED');
  }

  const total = Number(response.headers.get('content-length')) || 0;
  const encoded = Boolean(response.headers.get('content-encoding'));
  let received = 0;
  let lastEmit = 0;
  const progress = new Transform({
    transform(chunk, encoding, callback) {
      received += chunk.length;
      armTimer();
      const now = Date.now();
      if (onProgress && (now - lastEmit > 120 || (total > 0 && received >= total))) {
        lastEmit = now;
        onProgress({
          phase: 'download',
          received,
          total,
          percent: total > 0 ? Math.min(99, Math.floor((received / total) * 100)) : null,
        });
      }
      callback(null, chunk);
    },
  });

  try {
    if (!response.body) {
      throw new Error('响应内容为空');
    }
    await pipeline(
      Readable.fromWeb(response.body),
      progress,
      fs.createWriteStream(tempFile, {mode: 0o644}),
    );
  } catch (err) {
    if (err.name === 'AbortError' || controller.signal.aborted) {
      throw new DemoError('下载超时，请检查网络后重试', 'DOWNLOAD_FAILED', {cause: err});
    }
    throw new DemoError('下载录像时发生错误，请重试', 'DOWNLOAD_FAILED', {cause: err});
  } finally {
    clearTimeout(inactivityTimer);
  }

  if (!encoded && total > 0 && received !== total) {
    throw new DemoError(
      `下载不完整（${formatBytes(received)} / ${formatBytes(total)}），请重试`,
      'DOWNLOAD_FAILED',
    );
  }

  return {bytes: received, total, contentType};
}

async function decompressToFile(sourceFile, targetFile, compression, onProgress) {
  onProgress?.({phase: 'decompress', percent: null});
  if (compression === 'bz2') {
    try {
      await pipeline(
        fs.createReadStream(sourceFile),
        unbzip2(),
        fs.createWriteStream(targetFile, {mode: 0o644}),
      );
    } catch (err) {
      throw new DemoError('录像压缩包损坏或格式不受支持（bz2）', 'DECOMPRESS_FAILED', {cause: err});
    }
    return;
  }
  if (compression === 'gz') {
    try {
      await pipeline(
        fs.createReadStream(sourceFile),
        zlib.createGunzip(),
        fs.createWriteStream(targetFile, {mode: 0o644}),
      );
    } catch (err) {
      throw new DemoError('录像压缩包损坏或格式不受支持（gz）', 'DECOMPRESS_FAILED', {cause: err});
    }
    return;
  }
  await fsp.copyFile(sourceFile, targetFile);
}

async function downloadDemo(match, options = {}) {
  const url = match.demoUrl;
  if (!url || !/^https?:\/\//i.test(url)) {
    throw new DemoError('该比赛没有可用的录像下载链接，请重新同步或使用分享代码', 'NO_DEMO_URL');
  }
  const demoDir = options.demoDir ? path.resolve(options.demoDir) : null;
  if (!demoDir) {
    throw new DemoError('未配置录像保存目录', 'NO_DEMO_DIR');
  }
  if (!match.fileName) {
    throw new DemoError('缺少录像文件名', 'INVALID_MATCH');
  }

  await ensureDir(demoDir);
  const safeName = path.basename(match.fileName);
  const targetFile = path.join(demoDir, safeName);
  if (!targetFile.startsWith(path.resolve(demoDir) + path.sep)) {
    throw new DemoError('非法的录像文件名', 'INVALID_MATCH');
  }

  if (!options.overwrite) {
    const existing = await probeDemoFile(targetFile);
    if (existing.valid) {
      const stat = await fsp.stat(targetFile);
      return {
        filePath: targetFile,
        size: stat.size,
        format: existing.format,
        skipped: true,
        bytesDownloaded: 0,
      };
    }
  }

  const token = `${process.pid}-${crypto.randomBytes(5).toString('hex')}`;
  const tempFile = path.join(demoDir, `.${safeName}.${token}.download`);
  const partialFile = path.join(demoDir, `.${safeName}.${token}.part`);

  const cleanup = async () => {
    await Promise.all([
      fsp.rm(tempFile, {force: true}).catch(() => {}),
      fsp.rm(partialFile, {force: true}).catch(() => {}),
    ]);
  };

  const onProgress = options.onProgress;
  try {
    onProgress?.({phase: 'download', received: 0, total: 0, percent: 0});
    const compression = compressionFromUrl(url);
    const result = await fetchToFile(url, tempFile, {onProgress});
    await decompressToFile(tempFile, partialFile, compression, onProgress);

    const probe = await probeDemoFile(partialFile);
    if (!probe.valid) {
      throw new DemoError(
        '下载的文件不是有效的 CS2/CS:GO 录像，链接可能已失效',
        'INVALID_DEMO',
      );
    }

    const stat = await fsp.stat(partialFile);
    if (stat.size < 16) {
      throw new DemoError('下载的录像文件为空或已损坏', 'INVALID_DEMO');
    }

    await fsp.rm(targetFile, {force: true});
    await fsp.rename(partialFile, targetFile);
    await cleanup();

    onProgress?.({phase: 'done', percent: 100, received: result.bytes, total: result.total});
    return {
      filePath: targetFile,
      size: stat.size,
      format: probe.format,
      skipped: false,
      bytesDownloaded: result.bytes,
      compressedSize: result.bytes,
    };
  } catch (err) {
    await cleanup();
    if (err instanceof DemoError) {
      throw err;
    }
    throw new DemoError(`下载失败：${err.message}`, 'DOWNLOAD_FAILED', {cause: err});
  }
}

module.exports = {
  CS2_HEADER,
  CSGO_HEADER,
  DemoError,
  probeDemoBuffer,
  probeDemoFile,
  compressionFromUrl,
  downloadDemo,
};

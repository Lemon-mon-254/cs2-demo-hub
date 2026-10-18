'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function tempDir(prefix = 'cs2hub-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeDemo(filePath, {header = 'PBDEMS2\0', extra = 64, fill = 31} = {}) {
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  const payload = Buffer.alloc(extra);
  for (let i = 0; i < extra; i += 1) {
    payload[i] = (i * fill + 17) % 256;
  }
  fs.writeFileSync(filePath, Buffer.concat([Buffer.from(header, 'binary'), payload]));
  return filePath;
}

function removeDir(dir) {
  fs.rmSync(dir, {recursive: true, force: true});
}

async function waitFor(predicate, {timeout = 5000, interval = 25} = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`waitFor 超时（${timeout}ms）`);
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

function makeMatch(overrides = {}) {
  const matchId = String(overrides.matchId || '7300000000000000001');
  return {
    matchId,
    shareCode: null,
    date: '2026-10-15T12:34:00.000Z',
    timestamp: 1760550840,
    map: 'de_mirage',
    mapName: '荒漠迷城',
    mapLabel: '荒漠迷城 (de_mirage)',
    gameType: (1 << 7 << 8) | 8,
    mode: '官方竞技',
    scoreCT: 13,
    scoreT: 9,
    duration: 1800,
    rounds: 22,
    demoUrl: `https://example.invalid/${matchId}.dem.bz2`,
    outcomeId: '7300000000000000002',
    tvPort: 30001,
    source: 'test',
    syncedAt: '2026-10-15T12:40:00.000Z',
    downloaded: false,
    size: 0,
    fileName: null,
    ...overrides,
  };
}

module.exports = {
  tempDir,
  writeDemo,
  removeDir,
  waitFor,
  closeServer,
  makeMatch,
};

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {encodeShareCode} = require('./valve-matches');
const {prettyMap, shortMapName, gameTypeForMap, gameModeName} = require('./maps');

const MOCK_MAPS = ['de_mirage', 'de_inferno', 'de_dust2', 'de_nuke', 'de_ancient', 'de_anubis', 'de_vertigo', 'de_overpass'];
const MOCK_SCORES = [[13, 9], [13, 11], [7, 13], [13, 4], [10, 13], [13, 6], [13, 2], [13, 10]];

function createMockMatches(count = 8) {
  const now = Date.now();
  const matches = [];
  for (let i = 0; i < count; i += 1) {
    const map = MOCK_MAPS[i % MOCK_MAPS.length];
    const matchId = String(7300000000000000000n + BigInt(1000 + i));
    const outcomeId = String(7300000000000000001n + BigInt(2000 + i));
    const tvPort = 30000 + i;
    const [scoreCT, scoreT] = MOCK_SCORES[i % MOCK_SCORES.length];
    const date = new Date(now - i * 3.5 * 3600 * 1000).toISOString();
    const gameType = gameTypeForMap(map, 8);
    matches.push({
      matchId,
      shareCode: encodeShareCode({matchId, outcomeId, token: tvPort}),
      date,
      timestamp: Math.floor(Date.parse(date) / 1000),
      map,
      mapName: shortMapName(map),
      mapLabel: prettyMap(map),
      gameType,
      mode: gameModeName(gameType),
      scoreCT,
      scoreT,
      duration: 1800 + (i * 137),
      rounds: scoreCT + scoreT + (i % 3),
      demoUrl: `http://mock.local/730/mock_${matchId}.dem.bz2`,
      outcomeId,
      tvPort,
      source: 'mock',
      syncedAt: new Date().toISOString(),
      downloaded: false,
      size: 0,
      fileName: null,
    });
  }
  return matches;
}

function writeMockDemo(filePath) {
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  const header = Buffer.from('PBDEMS2\0', 'binary');
  const payload = Buffer.alloc(64 * 1024);
  for (let i = 0; i < payload.length; i += 1) {
    payload[i] = (i * 31 + 17) % 256;
  }
  fs.writeFileSync(filePath, Buffer.concat([header, payload]));
  return filePath;
}

module.exports = {createMockMatches, writeMockDemo, MOCK_MAPS};

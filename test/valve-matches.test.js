'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {gameTypeForMap} = require('../src/maps');
const {
  encodeShareCode,
  parseShareCode,
  normalizeMatch,
  getLastRoundStats,
  formatScore,
  matchTitle,
  matchSummaryLine,
} = require('../src/valve-matches');

test('分享代码可以编码、解码并容忍首尾空白', () => {
  const source = {
    matchId: '7300000000000000123',
    outcomeId: '7300000000000000456',
    token: 31234,
  };
  const code = encodeShareCode(source);
  assert.match(code, /^CSGO(?:-[A-Za-z0-9]{5}){5}$/);

  const decoded = parseShareCode(`  ${code}\n`);
  assert.deepEqual(
    {matchId: decoded.matchId, outcomeId: decoded.outcomeId, token: decoded.token},
    source,
  );
  assert.equal(decoded.shareCode, code);
});

test('格式错误的分享代码会抛出 INVALID_SHARE_CODE', () => {
  assert.throws(
    () => parseShareCode('not-a-share-code'),
    (err) => err.code === 'INVALID_SHARE_CODE',
  );
  assert.throws(
    () => parseShareCode(''),
    (err) => err.code === 'INVALID_SHARE_CODE' && /不能为空/.test(err.message),
  );
});

test('normalizeMatch 读取 snake_case 字段、最后回合数据和交换后的比分', () => {
  const lastRound = {
    map: 'https://replay.valve.example/last.dem.bz2',
    team_scores: [10, 13],
    b_switched_teams: true,
    match_duration: 2712,
    round: 24,
    reservationid: '7300000000000000456',
    reservation: {
      game_type: gameTypeForMap('de_mirage', 8),
      reservationid: '7300000000000000999',
    },
  };
  const raw = {
    matchid: '7300000000000000123',
    matchtime: 1760550840,
    watchablematchinfo: {
      game_map: 'de_mirage',
      tv_port: 31234,
      reservation_id: '7300000000000000456',
    },
    roundstatsall: [
      {
        round: 1,
        map: 'https://replay.valve.example/first.dem.bz2',
        team_scores: [1, 0],
      },
      lastRound,
    ],
  };

  const match = normalizeMatch(raw, {source: 'share'});
  assert.equal(match.matchId, '7300000000000000123');
  assert.equal(match.shareCode, encodeShareCode({
    matchId: raw.matchid,
    outcomeId: '7300000000000000456',
    token: 31234,
  }));
  assert.equal(match.demoUrl, lastRound.map);
  assert.equal(match.map, 'de_mirage');
  assert.equal(match.mapName, '荒漠迷城');
  assert.equal(match.mode, '官方竞技');
  assert.equal(match.scoreCT, 13);
  assert.equal(match.scoreT, 10);
  assert.equal(match.duration, 2712);
  assert.equal(match.rounds, 24);
  assert.equal(match.source, 'share');
  assert.equal(match.date, new Date(1760550840 * 1000).toISOString());
  assert.equal(getLastRoundStats(raw), lastRound);

  const decoded = parseShareCode(match.shareCode);
  assert.equal(decoded.matchId, '7300000000000000123');
  assert.equal(decoded.outcomeId, '7300000000000000456');
  assert.equal(decoded.token, 31234);
});

test('normalizeMatch 兼容 camelCase 与 roundstatslegacy', () => {
  const gameType = gameTypeForMap('de_anubis', 8);
  const raw = {
    matchId: '7300000000000000789',
    matchTime: 1760554440,
    watchableMatchInfo: {
      gameMap: 'de_anubis',
      tvPort: 30002,
      reservationId: '7300000000000000788',
    },
    roundStatsLegacy: {
      map: 'https://replay.valve.example/legacy.dem',
      teamScores: [13, 7],
      matchDuration: 1800,
      round: 20,
      reservation: {gameType},
    },
  };

  const match = normalizeMatch(raw);
  assert.equal(match.map, 'de_anubis');
  assert.equal(match.mapName, '阿努比斯');
  assert.equal(match.mode, '官方竞技');
  assert.equal(match.scoreCT, 13);
  assert.equal(match.scoreT, 7);
  assert.equal(match.duration, 1800);
  assert.equal(match.rounds, 20);
  assert.equal(match.demoUrl, 'https://replay.valve.example/legacy.dem');
  assert.equal(match.gameType, gameType);
  assert.ok(match.shareCode);
});

test('normalizeMatch 对缺失或非法字段保持安全默认值', () => {
  const match = normalizeMatch({
    matchid: '7300000000000000001',
    watchablematchinfo: {},
    roundstatsall: [{
      team_scores: ['not-a-number'],
      match_duration: 'invalid',
      map: 'javascript:alert(1)',
    }],
  });
  assert.equal(match.demoUrl, null);
  assert.equal(match.scoreCT, null);
  assert.equal(match.scoreT, null);
  assert.equal(match.duration, 0);
  assert.equal(match.map, 'unknown');
  assert.equal(match.shareCode, null);
  assert.equal(match.date, null);

  assert.throws(
    () => normalizeMatch({matchtime: 1}),
    (err) => err.code === 'INVALID_MATCH',
  );
  assert.throws(
    () => normalizeMatch(null),
    (err) => err.code === 'INVALID_MATCH',
  );
});

test('比赛标题与摘要包含地图、比分和时长', () => {
  const match = normalizeMatch({
    matchid: '7300000000000000001',
    matchtime: 1760550840,
    watchablematchinfo: {game_map: 'de_mirage'},
    roundstatslegacy: {
      team_scores: [13, 9],
      match_duration: 1800,
      round: 22,
    },
  });
  assert.equal(formatScore(match), '13 : 9');
  assert.match(matchTitle(match), /荒漠迷城/);
  assert.match(matchSummaryLine(match), /13:9/);
  assert.match(matchSummaryLine(match), /30分00秒/);
  assert.match(matchSummaryLine(match), /22 回合/);
});

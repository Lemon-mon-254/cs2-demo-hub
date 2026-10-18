'use strict';

const {decodeMatchShareCode, encodeMatch} = require('csgo-sharecode');
const {getMapFromGameType, prettyMap, shortMapName, normalizeMapName, gameModeName} = require('./maps');
const {formatDuration, formatDate} = require('./util');

function toId(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'object') {
    if (typeof value.toString === 'function' && value.toString !== Object.prototype.toString) {
      const text = value.toString();
      if (/^\d+$/.test(text)) {
        return text;
      }
    }
    if (typeof value.low === 'number' && typeof value.high === 'number') {
      const low = BigInt(value.low >>> 0);
      const high = BigInt(value.high >>> 0);
      return ((high << 32n) | low).toString();
    }
    return null;
  }
  const text = String(value).trim();
  return /^\d+$/.test(text) ? text : null;
}

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/**
 * globaloffensive 返回的 protobuf 字段使用 snake_case，而部分旧版本/第三方库
 * 使用 camelCase。统一读取，避免比分、时长、分享代码等字段丢失。
 */
function field(object, ...names) {
  if (!object || typeof object !== 'object') {
    return undefined;
  }
  for (const name of names) {
    if (object[name] !== undefined && object[name] !== null) {
      return object[name];
    }
  }
  return undefined;
}

function getLastRoundStats(rawMatch) {
  if (!rawMatch || typeof rawMatch !== 'object') {
    return null;
  }
  const legacy = field(rawMatch, 'roundstatslegacy', 'roundstats_legacy', 'roundStatsLegacy');
  if (legacy && typeof legacy === 'object') {
    return legacy;
  }
  const rounds = field(rawMatch, 'roundstatsall', 'roundStatsAll');
  return Array.isArray(rounds) && rounds.length > 0 ? rounds[rounds.length - 1] : null;
}

function getRoundStatsList(rawMatch) {
  const rounds = field(rawMatch, 'roundstatsall', 'roundStatsAll');
  if (Array.isArray(rounds) && rounds.length > 0) {
    return rounds;
  }
  const legacy = field(rawMatch, 'roundstatslegacy', 'roundstats_legacy', 'roundStatsLegacy');
  return legacy ? [legacy] : [];
}

function isHttpUrl(value) {
  if (typeof value !== 'string') {
    return false;
  }
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function encodeShareCode({matchId, outcomeId, token}) {
  try {
    return encodeMatch({
      matchId: BigInt(matchId),
      reservationId: BigInt(outcomeId),
      tvPort: Number(token),
    });
  } catch {
    return null;
  }
}

function parseShareCode(input) {
  const raw = String(input || '').trim();
  if (!raw) {
    const err = new Error('分享代码不能为空');
    err.code = 'INVALID_SHARE_CODE';
    throw err;
  }
  let decoded;
  try {
    decoded = decodeMatchShareCode(raw);
  } catch (cause) {
    const err = new Error('分享代码格式不正确，请检查后重试');
    err.code = 'INVALID_SHARE_CODE';
    err.cause = cause;
    throw err;
  }
  if (!decoded) {
    const err = new Error('分享代码格式不正确，请检查后重试');
    err.code = 'INVALID_SHARE_CODE';
    throw err;
  }
  const data = {
    matchId: decoded.matchId.toString(),
    outcomeId: decoded.reservationId.toString(),
    token: Number(decoded.tvPort),
  };
  return {
    ...data,
    shareCode: encodeShareCode(data) || raw,
  };
}

function normalizeMatch(rawMatch, options = {}) {
  if (!rawMatch || typeof rawMatch !== 'object') {
    const err = new Error('无效的比赛数据');
    err.code = 'INVALID_MATCH';
    throw err;
  }

  const matchId = toId(field(rawMatch, 'matchid', 'matchId'));
  if (!matchId) {
    const err = new Error('比赛数据缺少 matchid');
    err.code = 'INVALID_MATCH';
    throw err;
  }

  const lastRound = getLastRoundStats(rawMatch) || {};
  const rounds = getRoundStatsList(rawMatch);
  const watchable = field(rawMatch, 'watchablematchinfo', 'watchableMatchInfo') || {};
  const reservation = field(lastRound, 'reservation') || {};

  const matchTime = toNumber(field(rawMatch, 'matchtime', 'matchTime'), 0);
  const timestampMs = matchTime > 0 ? matchTime * 1000 : 0;
  const dateValue = timestampMs > 0 ? new Date(timestampMs) : null;
  const date = dateValue && !Number.isNaN(dateValue.getTime()) ? dateValue.toISOString() : null;

  const demoMap = field(lastRound, 'map');
  const demoUrl = isHttpUrl(demoMap) ? demoMap.trim() : null;

  // 地图与模式编码在 reservation.game_type 中：低 8 位是模式，其余位是地图位。
  const gameType = toNumber(
    field(reservation, 'gameType', 'game_type') ??
    field(watchable, 'gameType', 'game_type'),
    0,
  );
  const mapField = field(watchable, 'gameMap', 'game_map');
  let map = normalizeMapName(typeof mapField === 'string' ? mapField : '');
  if (!map || map === 'unknown') {
    map = getMapFromGameType(gameType);
  }
  if (!map) {
    map = 'unknown';
  }

  const outcomeId = toId(field(lastRound, 'reservationid', 'reservationId')) ||
    toId(field(watchable, 'reservationId', 'reservation_id'));
  const tvPort = toNumber(field(watchable, 'tvPort', 'tv_port'), 0);
  const shareCode = outcomeId && tvPort > 0
    ? encodeShareCode({matchId, outcomeId, token: tvPort})
    : null;

  const rawTeamScores = field(lastRound, 'teamScores', 'team_scores');
  let teamScores = Array.isArray(rawTeamScores)
    ? rawTeamScores.map((value) => toNumber(value, 0))
    : [];
  if (field(lastRound, 'bSwitchedTeams', 'b_switched_teams') && teamScores.length >= 2) {
    teamScores = [teamScores[1], teamScores[0], ...teamScores.slice(2)];
  }
  const scoreCT = teamScores.length >= 2 ? teamScores[0] : null;
  const scoreT = teamScores.length >= 2 ? teamScores[1] : null;

  const duration = toNumber(field(lastRound, 'matchDuration', 'match_duration'), 0);
  const roundCount = toNumber(field(lastRound, 'round'), 0) ||
    Math.max(0, rounds.filter((round) => toNumber(field(round, 'round'), 0) > 0).length);

  const source = options.source || 'recent';
  return {
    matchId,
    shareCode,
    date,
    timestamp: matchTime,
    map,
    mapName: shortMapName(map),
    mapLabel: prettyMap(map),
    gameType,
    mode: gameModeName(gameType),
    scoreCT,
    scoreT,
    duration,
    rounds: roundCount,
    demoUrl,
    outcomeId,
    tvPort,
    source,
    syncedAt: new Date().toISOString(),
    downloaded: false,
    size: 0,
    fileName: null,
  };
}

function formatScore(match) {
  if (Number.isInteger(match.scoreCT) && Number.isInteger(match.scoreT)) {
    return `${match.scoreCT} : ${match.scoreT}`;
  }
  return '比分未知';
}

function matchTitle(match) {
  const date = match.date ? formatDate(match.date) : '未知时间';
  return `${match.mapName || match.map || '未知地图'} · ${date}`;
}

function matchSummaryLine(match) {
  const parts = [match.mapLabel || match.map || '未知地图'];
  if (match.date) {
    parts.push(formatDate(match.date));
  }
  if (Number.isInteger(match.scoreCT) && Number.isInteger(match.scoreT)) {
    parts.push(`比分 ${match.scoreCT}:${match.scoreT}`);
  }
  if (match.duration) {
    parts.push(formatDuration(match.duration));
  }
  if (match.rounds) {
    parts.push(`${match.rounds} 回合`);
  }
  return parts.join(' · ');
}

function normalizeShareCodeInput(input) {
  return parseShareCode(input);
}

module.exports = {
  toId,
  toNumber,
  field,
  getLastRoundStats,
  isHttpUrl,
  encodeShareCode,
  parseShareCode,
  normalizeMatch,
  normalizeShareCodeInput,
  formatScore,
  matchTitle,
  matchSummaryLine,
};

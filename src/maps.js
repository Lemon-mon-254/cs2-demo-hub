'use strict';

// CS2 地图代码与中文名称。Valve 新增地图时回退显示代码本身。
const MAP_NAMES = {
  de_dust2: '炙热沙城 II',
  de_mirage: '荒漠迷城',
  de_inferno: '炼狱小镇',
  de_nuke: '核子危机',
  de_overpass: '死亡游乐园',
  de_vertigo: '殒命大厦',
  de_ancient: '远古遗迹',
  de_anubis: '阿努比斯',
  de_train: '列车停放站',
  de_cache: '死城之谜',
  de_cobblestone: '古堡激战',
  de_tuscan: '托斯卡纳',
  de_office: '办公室',
  cs_office: '办公室',
  de_warden: '守望者',
  de_poseidon: '波塞冬',
  de_eldorado: '黄金国',
  de_sanctum: '圣所',
  de_stronghold: '要塞',
  de_boulder: '巨石',
  de_fachwerk: '桁架',
  cs_shelter: '避难所',
  de_canals: '运河',
  de_debris: '残骸',
  de_aztec: '阿兹特克',
  de_dust: '沙漠 I',
  cs_italy: '意大利',
  cs_militia: '民兵',
  de_shortdust: '迷你沙漠 II',
  de_shortnuke: '迷你核子危机',
  de_lake: '湖畔',
  de_biome: '生态区',
  de_graphite: '石墨',
  de_crete: '克里特',
  de_abbey: '修道院',
  de_breach: '破晓',
  de_engage: '交锋',
  de_marquis: '侯爵',
  de_raas: '拉阿斯',
  de_iris: '鸢尾',
  de_heat: '热浪',
  de_mills: '磨坊',
  de_mocha: '摩卡',
  de_palacio: '宫殿',
  de_rust: '废墟',
  ar_baggage: '行李仓库',
  ar_shoots: '射击场',
  ar_pool_day: '泳池派对',
  cs_agency: '特工',
  cs_apollo: '阿波罗',
  cs_assembly: '集会',
  cs_downtown: '市中心',
  cs_havana: '哈瓦那',
  cs_insertion: '插入点',
  cs_motel: '汽车旅馆',
  cs_thunder: '雷霆',
  cs_workout: '健身房',
};

const GAME_MODE_NAMES = {
  0: '休闲',
  1: '竞技',
  2: '双人搭档',
  3: '军备竞赛',
  4: '爆破模式',
  5: '死亡竞赛',
  6: '混战',
  8: '官方竞技',
  10: '搭档模式',
  11: 'Premier',
  12: '守护模式',
};

const MAP_BITS = {
  [1 << 0]: 'de_warden',
  [1 << 1]: 'de_dust2',
  [1 << 2]: 'de_train',
  [1 << 3]: 'de_ancient',
  [1 << 4]: 'de_inferno',
  [1 << 5]: 'de_nuke',
  [1 << 6]: 'de_vertigo',
  [1 << 7]: {8: 'de_mirage', 10: 'de_debris'},
  [1 << 8]: 'cs_office',
  [1 << 9]: 'de_poseidon',
  [1 << 10]: 'de_eldorado',
  [1 << 11]: 'de_sanctum',
  [1 << 12]: 'de_cache',
  [1 << 13]: 'de_stronghold',
  [1 << 14]: 'de_boulder',
  [1 << 15]: 'de_anubis',
  [1 << 16]: 'de_tuscan',
  [1 << 18]: 'de_fachwerk',
  [1 << 19]: 'cs_shelter',
  [1 << 20]: 'de_overpass',
  [1 << 21]: 'de_cobblestone',
  [1 << 22]: 'de_canals',
};

function normalizeMapName(mapName) {
  if (typeof mapName !== 'string') {
    return '';
  }
  return mapName.trim().toLowerCase().replace(/^workshop\//, '');
}

function prettyMap(mapName) {
  const normalized = normalizeMapName(mapName);
  if (!normalized) {
    return '未知地图';
  }
  const pretty = MAP_NAMES[normalized];
  return pretty ? `${pretty} (${normalized})` : normalized;
}

function shortMapName(mapName) {
  const normalized = normalizeMapName(mapName);
  if (!normalized) {
    return '未知地图';
  }
  return MAP_NAMES[normalized] || normalized;
}

function getMapFromGameType(gameType) {
  const value = Number(gameType) || 0;
  const mapBit = (value >> 8) & 0xffffff;
  const gameMode = value & 0xff;
  const mapping = MAP_BITS[mapBit];
  if (typeof mapping === 'string') {
    return mapping;
  }
  if (mapping && typeof mapping === 'object') {
    return mapping[gameMode] || 'unknown';
  }
  return 'unknown';
}

/**
 * 根据地图名反推 game_type 中的地图位，主要用于模拟数据和测试。
 * 默认模式 8（官方竞技）。
 */
function gameTypeForMap(mapName, mode = 8) {
  const normalized = normalizeMapName(mapName);
  for (const [bit, mapping] of Object.entries(MAP_BITS)) {
    const matched = typeof mapping === 'string'
      ? mapping === normalized
      : mapping[mode] === normalized || Object.values(mapping).includes(normalized);
    if (matched) {
      return (Number(bit) << 8) | (Number(mode) & 0xff);
    }
  }
  return Number(mode) & 0xff;
}

function gameModeName(gameType) {
  const mode = (Number(gameType) || 0) & 0xff;
  return GAME_MODE_NAMES[mode] || '未知模式';
}

module.exports = {
  MAP_NAMES,
  normalizeMapName,
  prettyMap,
  shortMapName,
  getMapFromGameType,
  gameTypeForMap,
  gameModeName,
};

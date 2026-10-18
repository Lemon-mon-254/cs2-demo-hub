'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {SteamService} = require('../src/steam');

test('requestRecentMatches 不把 globaloffensive 的 undefined 返回值当成失败', async () => {
  const service = new SteamService({});
  let requestedSteamID = null;
  const go = {
    requestRecentGames(steamID) {
      requestedSteamID = steamID;
      // globaloffensive 成功发送请求时也返回 undefined。
      return undefined;
    },
  };

  service.withGC = async (fn) => fn({go, steamID: '76561198000000001'});
  service._waitForMatchList = async (targetGo, requestFn) => {
    requestFn();
    return [];
  };

  const matches = await service.requestRecentMatches({limit: 8});

  assert.deepEqual(matches, []);
  assert.equal(requestedSteamID, '76561198000000001');
});

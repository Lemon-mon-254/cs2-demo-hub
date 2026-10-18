'use strict';

const {ConfigStore, DEFAULT_PORT, getConfigDir, defaultConfig} = require('./config');
const {Library, LibraryError, buildFileName} = require('./library');
const {
  parseShareCode,
  normalizeMatch,
  normalizeShareCodeInput,
  formatScore,
  matchTitle,
  matchSummaryLine,
} = require('./valve-matches');
const {
  probeDemoBuffer,
  probeDemoFile,
  downloadDemo,
  DemoError,
} = require('./downloader');
const {
  detectCs2Path,
  detectSteamPath,
  getEnvironment,
  isCs2Running,
  stageDemo,
  launchDemo,
  getLaunchCommand,
} = require('./cs2');
const {TaskManager} = require('./tasks');
const {createServer} = require('./server');
const {SteamService} = require('./steam');
const {createMockMatches, writeMockDemo} = require('./mock');

module.exports = {
  ConfigStore,
  DEFAULT_PORT,
  getConfigDir,
  defaultConfig,
  Library,
  LibraryError,
  buildFileName,
  parseShareCode,
  normalizeMatch,
  normalizeShareCodeInput,
  formatScore,
  matchTitle,
  matchSummaryLine,
  probeDemoBuffer,
  probeDemoFile,
  downloadDemo,
  DemoError,
  detectCs2Path,
  detectSteamPath,
  getEnvironment,
  isCs2Running,
  stageDemo,
  launchDemo,
  getLaunchCommand,
  TaskManager,
  createServer,
  SteamService,
  createMockMatches,
  writeMockDemo,
};

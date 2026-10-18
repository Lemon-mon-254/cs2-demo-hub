'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  ensureDirSync,
  readJsonSync,
  writeJsonAtomicSync,
  safeFileName,
  fileStamp,
  isPathInside,
} = require('./util');
const {probeDemoBuffer} = require('./downloader');
const {parseShareCode, matchTitle} = require('./valve-matches');

class LibraryError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'LibraryError';
    this.code = code;
  }
}

function probeSync(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(8);
    const bytesRead = fs.readSync(fd, buffer, 0, 8, 0);
    return probeDemoBuffer(buffer.subarray(0, bytesRead));
  } catch {
    return {valid: false, format: null};
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

function buildFileName(match) {
  const stamp = fileStamp(match.date ? new Date(match.date) : new Date());
  const map = safeFileName((match.map || 'unknown').replace(/^de_/, 'de_'), 'unknown');
  const id = String(match.matchId || Date.now());
  return `${stamp}_${map}_${id}.dem`;
}

class Library {
  constructor(demoDir, options = {}) {
    this.setDemoDir(demoDir, options);
  }

  setDemoDir(demoDir, options = {}) {
    this.demoDir = path.resolve(demoDir);
    this.file = options.file || path.join(this.demoDir, 'library.json');
    this._data = null;
  }

  ensure() {
    ensureDirSync(this.demoDir);
    return this;
  }

  load({reload = false} = {}) {
    if (this._data && !reload) {
      return this._data;
    }
    ensureDirSync(this.demoDir);
    const raw = readJsonSync(this.file, null);
    const matches = Array.isArray(raw?.matches) ? raw.matches : [];
    const seen = new Set();
    const entries = [];
    for (const item of matches) {
      if (!item || typeof item !== 'object' || !item.matchId) {
        continue;
      }
      const matchId = String(item.matchId);
      if (!/^\d+$/.test(matchId) || seen.has(matchId)) {
        continue;
      }
      seen.add(matchId);
      entries.push({
        ...item,
        matchId,
        downloaded: Boolean(item.downloaded),
        size: Number(item.size) || 0,
      });
    }
    this._data = {
      version: 1,
      updatedAt: raw?.updatedAt || null,
      matches: entries,
    };
    return this._data;
  }

  save() {
    ensureDirSync(this.demoDir);
    const data = this.load();
    data.updatedAt = new Date().toISOString();
    writeJsonAtomicSync(this.file, data, 0o644);
    return data;
  }

  getDemoPath(entry) {
    if (!entry) {
      return null;
    }
    const fileName = entry.fileName || buildFileName(entry);
    const fullPath = path.join(this.demoDir, path.basename(fileName));
    if (!isPathInside(this.demoDir, fullPath)) {
      return null;
    }
    return fullPath;
  }

  decorate(entry) {
    const fileName = entry.fileName || buildFileName(entry);
    const demoPath = this.getDemoPath({...entry, fileName});
    let downloaded = false;
    let size = 0;
    let corrupted = false;
    let missing = false;

    if (demoPath) {
      try {
        const stat = fs.statSync(demoPath);
        if (stat.isFile() && stat.size > 8) {
          const probe = probeSync(demoPath);
          if (probe.valid) {
            downloaded = true;
            size = stat.size;
          } else {
            corrupted = true;
            size = stat.size;
          }
        } else if (stat.isFile()) {
          corrupted = true;
          size = stat.size;
        }
      } catch (err) {
        if (err.code !== 'ENOENT' || entry.downloadedAt) {
          missing = err.code === 'ENOENT';
        }
      }
    }

    return {
      ...entry,
      fileName,
      downloaded,
      size: downloaded ? size : (corrupted ? size : 0),
      corrupted,
      missing: !downloaded && !corrupted && Boolean(entry.downloadedAt || entry.downloaded),
      demoPath: downloaded ? demoPath : null,
      title: matchTitle(entry),
    };
  }

  list() {
    const data = this.load();
    return data.matches
      .map((entry) => this.decorate(entry))
      .sort((a, b) => {
        const aTime = a.date ? Date.parse(a.date) : 0;
        const bTime = b.date ? Date.parse(b.date) : 0;
        if (aTime !== bTime) {
          return bTime - aTime;
        }
        return String(b.matchId).localeCompare(String(a.matchId));
      });
  }

  stats() {
    const entries = this.list();
    const downloaded = entries.filter((entry) => entry.downloaded);
    return {
      total: entries.length,
      downloaded: downloaded.length,
      missing: entries.filter((entry) => entry.missing).length,
      corrupted: entries.filter((entry) => entry.corrupted).length,
      bytes: downloaded.reduce((sum, entry) => sum + entry.size, 0),
      demoDir: this.demoDir,
    };
  }

  mergeMatches(matches) {
    const data = this.load();
    const byId = new Map(data.matches.map((entry) => [String(entry.matchId), entry]));
    let added = 0;
    let updated = 0;

    for (const match of matches) {
      if (!match || !match.matchId) {
        continue;
      }
      const matchId = String(match.matchId);
      const current = byId.get(matchId);
      const incoming = {
        ...match,
        matchId,
        syncedAt: new Date().toISOString(),
      };
      delete incoming.demoPath;
      delete incoming.title;

      if (!current) {
        byId.set(matchId, incoming);
        added += 1;
        continue;
      }

      const keepIfEmpty = [
        'shareCode',
        'date',
        'timestamp',
        'map',
        'mapName',
        'mapLabel',
        'demoUrl',
      ];
      const merged = {...current};
      for (const [key, value] of Object.entries(incoming)) {
        if (value === null || value === undefined || value === '') {
          if (keepIfEmpty.includes(key) && merged[key]) {
            continue;
          }
        }
        merged[key] = value;
      }
      merged.fileName = current.fileName || incoming.fileName || null;
      merged.downloaded = current.downloaded;
      merged.downloadedAt = current.downloadedAt || null;
      merged.size = current.size || 0;
      byId.set(matchId, merged);
      updated += 1;
    }

    data.matches = [...byId.values()];
    this.save();
    return {entries: this.list(), added, updated};
  }

  get(matchId) {
    const id = String(matchId);
    const entry = this.load().matches.find((item) => String(item.matchId) === id);
    return entry ? this.decorate(entry) : null;
  }

  findCandidates(input) {
    const value = String(input || '').trim();
    if (!value) {
      return [];
    }
    let id = null;
    try {
      id = parseShareCode(value).matchId;
    } catch {
      // Not a share code.
    }
    const entries = this.list();
    if (id) {
      return entries.filter((entry) => entry.matchId === id);
    }
    const exact = entries.filter((entry) => entry.matchId === value || entry.fileName === value);
    if (exact.length > 0) {
      return exact;
    }
    const lower = value.toLowerCase();
    return entries.filter((entry) => (
      entry.matchId.startsWith(value) ||
      (entry.shareCode && entry.shareCode.toLowerCase() === lower)
    ));
  }

  resolveOne(input) {
    const candidates = this.findCandidates(input);
    if (candidates.length === 0) {
      throw new LibraryError(`未找到比赛：${input}。可先运行 sync 同步最近比赛`, 'MATCH_NOT_FOUND');
    }
    if (candidates.length > 1) {
      throw new LibraryError(`找到多场匹配的比赛，请输入更完整的 ID：${input}`, 'MATCH_AMBIGUOUS');
    }
    return candidates[0];
  }

  prepareDownload(matchId) {
    const data = this.load();
    const entry = data.matches.find((item) => String(item.matchId) === String(matchId));
    if (!entry) {
      throw new LibraryError('未找到该比赛，请先同步比赛列表', 'MATCH_NOT_FOUND');
    }
    if (!entry.demoUrl) {
      throw new LibraryError('该比赛没有可用的录像链接，请重新同步或使用分享代码', 'NO_DEMO_URL');
    }
    if (!entry.fileName) {
      entry.fileName = this.claimFileName(entry);
      this.save();
    } else {
      const claimed = this.claimFileName(entry);
      if (claimed !== entry.fileName) {
        entry.fileName = claimed;
        this.save();
      }
    }
    return this.decorate(entry);
  }

  markDownloaded(matchId, info) {
    const data = this.load();
    const entry = data.matches.find((item) => String(item.matchId) === String(matchId));
    if (!entry) {
      throw new LibraryError('未找到该比赛', 'MATCH_NOT_FOUND');
    }
    entry.downloaded = true;
    entry.downloadedAt = new Date().toISOString();
    entry.size = Number(info?.size) || 0;
    entry.fileName = info?.fileName || entry.fileName || buildFileName(entry);
    if (info?.format) {
      entry.demoFormat = info.format;
    }
    this.save();
    return this.decorate(entry);
  }

  delete(matchId, options = {}) {
    const data = this.load();
    const index = data.matches.findIndex((item) => String(item.matchId) === String(matchId));
    if (index === -1) {
      throw new LibraryError('未找到该比赛', 'MATCH_NOT_FOUND');
    }
    const entry = data.matches[index];
    const fileName = entry.fileName || buildFileName(entry);
    const demoPath = this.getDemoPath({...entry, fileName});
    let removedFile = false;
    let removedReplay = false;

    if (demoPath && isPathInside(this.demoDir, demoPath)) {
      try {
        fs.unlinkSync(demoPath);
        removedFile = true;
      } catch (err) {
        if (err.code !== 'ENOENT') {
          throw new LibraryError(`删除录像文件失败：${err.message}`, 'DELETE_FAILED');
        }
      }
    }

    if (options.replaysDir) {
      const base = path.basename(fileName);
      const candidates = [
        path.join(options.replaysDir, base),
        path.join(options.replaysDir, `${base}.info`),
        path.join(options.replaysDir, `${base}.dem.info`),
      ];
      for (const target of candidates) {
        try {
          fs.unlinkSync(target);
          if (target.endsWith(base)) {
            removedReplay = true;
          }
        } catch (err) {
          if (err.code !== 'ENOENT') {
            // The game may be holding the file; the library entry is still removed below.
          }
        }
      }
    }

    if (options.keepRecord) {
      entry.downloaded = false;
      entry.downloadedAt = null;
      entry.size = 0;
      entry.fileName = null;
      this.save();
    } else {
      data.matches.splice(index, 1);
      this.save();
    }

    return {entry, removedFile, removedReplay, fileName};
  }

  claimFileName(entry) {
    const data = this.load();
    const used = new Set(
      data.matches
        .filter((item) => String(item.matchId) !== String(entry.matchId) && item.fileName)
        .map((item) => item.fileName.toLowerCase()),
    );
    let fileName = entry.fileName || buildFileName(entry);
    if (used.has(fileName.toLowerCase())) {
      const base = fileName.replace(/\.dem$/i, '');
      let counter = 2;
      while (used.has(`${base}_${counter}.dem`.toLowerCase())) {
        counter += 1;
      }
      fileName = `${base}_${counter}.dem`;
    }
    return fileName;
  }
}

module.exports = {
  Library,
  LibraryError,
  buildFileName,
  probeSync,
};

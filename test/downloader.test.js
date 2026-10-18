'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const zlib = require('node:zlib');
const {
  DemoError,
  probeDemoBuffer,
  compressionFromUrl,
  downloadDemo,
} = require('../src/downloader');
const {tempDir, removeDir, closeServer} = require('./_helpers');

const BZ2_FIXTURE = Buffer.from(
  'QlpoOTFBWSZTWTvOJkUAAAz//8QiIREIiFRCNhNYiIREIiERCIhEQiIREIiERCIBEAiAIABUYAAAAAAAAAADAATBMaamyATIYJgAApz0YQacegikn4GqsuwIDjYAh2LEIbz8EMUcnuWb59/T0U1V/7Mcs9Ndt+Oeu/PfvxdyRThQkDvOJkU=',
  'base64',
);
const DEMO_PLAIN = Buffer.concat([
  Buffer.from('PBDEMS2\0', 'binary'),
  Buffer.from(Array.from({length: 56}, (_, index) => (index * 13 + 9) % 256)),
]);

function createFixtureServer() {
  const hits = new Map();
  const gzip = zlib.gzipSync(DEMO_PLAIN, {level: 9});
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    hits.set(pathname, (hits.get(pathname) || 0) + 1);
    const send = (status, body, type = 'application/octet-stream', headers = {}) => {
      res.writeHead(status, {
        'content-type': type,
        'content-length': body.length,
        ...headers,
      });
      res.end(body);
    };
    if (pathname === '/gzip/demo.dem.gz') {
      send(200, gzip);
    } else if (pathname === '/bz2/demo.dem.bz2') {
      send(200, BZ2_FIXTURE);
    } else if (pathname === '/plain/demo.dem') {
      send(200, DEMO_PLAIN);
    } else if (pathname === '/invalid.dem.gz') {
      send(200, zlib.gzipSync(Buffer.from('this is clearly not a demo file')));
    } else if (pathname === '/broken.dem.gz') {
      send(200, Buffer.from('not a valid gzip stream'));
    } else if (pathname === '/expired.dem.gz') {
      send(410, Buffer.from('gone'), 'text/plain');
    } else if (pathname === '/html.dem.gz') {
      send(200, Buffer.from('<html>expired</html>'), 'text/html; charset=utf-8');
    } else if (pathname === '/error.dem.gz') {
      send(500, Buffer.from('server error'));
    } else {
      send(404, Buffer.from('not found'));
    }
  });
  return {server, hits};
}

test('probeDemoBuffer 识别 CS2、CS:GO 与无效文件头', () => {
  assert.deepEqual(probeDemoBuffer(DEMO_PLAIN), {valid: true, format: 'cs2'});
  assert.deepEqual(
    probeDemoBuffer(Buffer.from('HL2DEMO\0extra bytes', 'binary')),
    {valid: true, format: 'csgo'},
  );
  assert.deepEqual(probeDemoBuffer(Buffer.from('PBDEMS')), {valid: false, format: null});
  assert.deepEqual(probeDemoBuffer(Buffer.from('hello world')), {valid: false, format: null});
  assert.deepEqual(probeDemoBuffer(null), {valid: false, format: null});
});

test('compressionFromUrl 仅根据 URL 路径判断压缩格式', () => {
  assert.equal(compressionFromUrl('https://cdn.test/a/b.DEM.BZ2?token=x'), 'bz2');
  assert.equal(compressionFromUrl('https://cdn.test/a/b.dem.gz'), 'gz');
  assert.equal(compressionFromUrl('https://cdn.test/a/b.dem.gzip?x=1'), 'gz');
  assert.equal(compressionFromUrl('https://cdn.test/a/b.dem'), null);
  assert.equal(compressionFromUrl('not a url'), null);
});

test('downloadDemo 支持 gzip、bz2 和未压缩录像，并原子落盘', async (t) => {
  const {server, hits} = createFixtureServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const dir = tempDir();
  t.after(async () => {
    await closeServer(server);
    removeDir(dir);
  });

  const progressEvents = [];
  const gzipResult = await downloadDemo({
    demoUrl: `${base}/gzip/demo.dem.gz`,
    fileName: 'gzip.dem',
  }, {
    demoDir: dir,
    onProgress: (event) => progressEvents.push(event),
  });
  assert.equal(gzipResult.skipped, false);
  assert.equal(gzipResult.format, 'cs2');
  assert.equal(gzipResult.size, DEMO_PLAIN.length);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'gzip.dem')), DEMO_PLAIN);
  assert.equal(hits.get('/gzip/demo.dem.gz'), 1);
  assert.ok(progressEvents.some((event) => event.phase === 'download'));
  assert.ok(progressEvents.some((event) => event.phase === 'decompress'));
  assert.ok(progressEvents.some((event) => event.phase === 'done' && event.percent === 100));

  const skipped = await downloadDemo({
    demoUrl: `${base}/gzip/demo.dem.gz`,
    fileName: 'gzip.dem',
  }, {demoDir: dir});
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.bytesDownloaded, 0);
  assert.equal(hits.get('/gzip/demo.dem.gz'), 1, '已存在有效录像时不应再次请求');

  const bz2Result = await downloadDemo({
    demoUrl: `${base}/bz2/demo.dem.bz2`,
    fileName: 'bz2.dem',
  }, {demoDir: dir});
  assert.equal(bz2Result.format, 'cs2');
  assert.deepEqual(fs.readFileSync(path.join(dir, 'bz2.dem')), DEMO_PLAIN);

  const plainResult = await downloadDemo({
    demoUrl: `${base}/plain/demo.dem`,
    fileName: 'plain.dem',
  }, {demoDir: dir});
  assert.equal(plainResult.format, 'cs2');
  assert.deepEqual(fs.readFileSync(path.join(dir, 'plain.dem')), DEMO_PLAIN);

  const leftovers = fs.readdirSync(dir).filter((name) => (
    name.endsWith('.download') || name.endsWith('.part') || name.endsWith('.tmp')
  ));
  assert.deepEqual(leftovers, []);
});

test('downloadDemo 拒绝无效录像、损坏压缩包和过期链接', async (t) => {
  const {server} = createFixtureServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const dir = tempDir();
  t.after(async () => {
    await closeServer(server);
    removeDir(dir);
  });

  const cases = [
    [`${base}/invalid.dem.gz`, 'INVALID_DEMO', 'invalid.dem'],
    [`${base}/broken.dem.gz`, 'DECOMPRESS_FAILED', 'broken.dem'],
    [`${base}/expired.dem.gz`, 'DEMO_URL_EXPIRED', 'expired.dem'],
    [`${base}/html.dem.gz`, 'DEMO_URL_EXPIRED', 'html.dem'],
    [`${base}/error.dem.gz`, 'DOWNLOAD_FAILED', 'error.dem'],
  ];
  for (const [demoUrl, code, fileName] of cases) {
    await assert.rejects(
      () => downloadDemo({demoUrl, fileName}, {demoDir: dir}),
      (err) => err instanceof DemoError && err.code === code,
      `${demoUrl} 应产生 ${code}`,
    );
    assert.equal(fs.existsSync(path.join(dir, fileName)), false);
  }

  const leftovers = fs.readdirSync(dir).filter((name) => (
    name.endsWith('.download') || name.endsWith('.part')
  ));
  assert.deepEqual(leftovers, []);
});

test('downloadDemo 校验必要参数', async () => {
  await assert.rejects(
    () => downloadDemo({demoUrl: '', fileName: 'a.dem'}, {demoDir: '/tmp'}),
    (err) => err.code === 'NO_DEMO_URL',
  );
  await assert.rejects(
    () => downloadDemo({demoUrl: 'https://example.test/a.dem', fileName: 'a.dem'}, {}),
    (err) => err.code === 'NO_DEMO_DIR',
  );
  await assert.rejects(
    () => downloadDemo({demoUrl: 'https://example.test/a.dem'}, {demoDir: '/tmp'}),
    (err) => err.code === 'INVALID_MATCH',
  );
});

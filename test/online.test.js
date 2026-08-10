const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const WebSocket = require('ws');

const SERVER_PATH = path.join(__dirname, '..', 'server.js');
const PORT = 20000 + crypto.randomInt(0, 30000);
const uploadTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-online-upload-'));
const libraryTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-online-lib-'));
// 有效 wav 头 + 4KB 静音数据，保证超过下载模块的最小体积校验
const WAV = Buffer.concat([
  Buffer.from('UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA', 'base64'),
  Buffer.alloc(4096),
]);

let stub = null; // 桩服务（模拟网易云/咪咕）
let serverProcess = null;
let rateServerProcess = null;
const clients = [];

// ---------- 桩服务：模拟第三方接口 ----------
function startStub() {
  return new Promise((resolve) => {
    const counts = {
      neteaseSearch: 0,
      miguSearch: 0,
      miguListen: 0,
      neteaseDownload: 0,
      miguDownload: 0,
    };
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      const sendJson = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (u.pathname === '/api/search/get/web') {
        counts.neteaseSearch += 1;
        if ((u.searchParams.get('s') || '').includes('多结果')) {
          return sendJson(200, {
            result: {
              songs: Array.from({ length: 12 }, (_, i) => ({
                id: 900 + i,
                name: `网易歌${i + 1}`,
                artists: [{ name: '歌手N' }],
                album: { name: '专辑N' },
                duration: 1000,
                fee: 0,
              })),
            },
          });
        }
        if ((u.searchParams.get('s') || '').includes('重复')) {
          return sendJson(200, {
            result: {
              songs: [
                { id: 111, name: '同一首歌', artists: [{ name: '同歌手' }], album: { name: '专辑A' }, duration: 1000, fee: 0 },
                { id: 112, name: '另一首', artists: [{ name: '同歌手' }], album: { name: '专辑B' }, duration: 1000, fee: 0 },
              ],
            },
          });
        }
        return sendJson(200, {
          result: {
            songs: [
              {
                id: 111,
                name: '测试歌',
                artists: [{ name: '测试歌手' }],
                album: { name: '测试专辑' },
                duration: 180000,
                fee: 0,
              },
              {
                id: 222,
                name: '会员歌',
                artists: [{ name: '会员歌手' }],
                album: { name: '专辑B' },
                duration: 200000,
                fee: 1,
              },
            ],
          },
        });
      }
      if (u.pathname === '/MIGUM2.0/v1.0/content/search_all.do') {
        counts.miguSearch += 1;
        const text = u.searchParams.get('text') || '';
        if (text.includes('重复')) {
          return sendJson(200, {
            code: '000000',
            songResultData: {
              result: [
                {
                  id: '500',
                  contentId: 'c500',
                  copyrightId: 'cr500',
                  name: '同一首歌',
                  singers: [{ name: '同歌手' }],
                  albums: [{ name: '专辑M1' }],
                },
                {
                  id: '501',
                  contentId: 'c501',
                  copyrightId: 'cr501',
                  name: '第三首',
                  singers: [{ name: '同歌手' }],
                  albums: [{ name: '专辑M2' }],
                },
              ],
            },
          });
        }
        if (text.includes('多结果')) {
          const page = Number(u.searchParams.get('pageNo')) || 1;
          const start = (page - 1) * 20;
          return sendJson(200, {
            code: '000000',
            songResultData: {
              result: Array.from({ length: 20 }, (_, i) => ({
                id: String(700 + start + i),
                contentId: 'c' + (700 + start + i),
                copyrightId: 'cr' + (700 + start + i),
                name: `咪咕歌${start + i + 1}`,
                singers: [{ name: '歌手M' }],
                albums: [{ name: '专辑M' }],
              })),
            },
          });
        }
        if (text.includes('找不到')) {
          return sendJson(200, { code: '000000', songResultData: { result: [] } });
        }
        if (text.includes('不匹配')) {
          return sendJson(200, {
            code: '000000',
            songResultData: {
              result: [
                {
                  id: '444',
                  contentId: 'c444',
                  copyrightId: 'cr444',
                  name: '另一首歌',
                  singers: [{ name: '别人' }],
                  albums: [{ name: '专辑X' }],
                },
              ],
            },
          });
        }
        return sendJson(200, {
          code: '000000',
          songResultData: {
            result: [
              {
                id: '333',
                contentId: 'c333',
                copyrightId: 'cr333',
                name: text.includes('会员歌') ? '会员歌' : '测试歌',
                singers: [{ name: text.includes('会员歌') ? '会员歌手' : '测试歌手' }],
                albums: [{ name: '专辑M' }],
              },
            ],
          },
        });
      }
      if (u.pathname === '/MIGUM3.0/v1.0/content/sub/listen.do') {
        counts.miguListen += 1;
        const audioId = u.searchParams.get('audioId') || '';
        if (audioId === '777') {
          return sendJson(200, {
            code: '000000',
            info: '成功',
            songListens: [{ url: `http://127.0.0.1:${server.address().port}/audio/flaky.wav` }],
          });
        }
        if (audioId === '888' || audioId === '999') {
          // 慢速正常下载（延迟 400ms），用于并发下载上限测试
          return sendJson(200, {
            code: '000000',
            info: '成功',
            songListens: [{ url: `http://127.0.0.1:${server.address().port}/audio/slow.wav` }],
          });
        }
        return sendJson(200, {
          code: '000000',
          info: '成功',
          songListens: [{ url: `http://127.0.0.1:${server.address().port}/audio/migu333.wav` }],
        });
      }
      if (u.pathname.startsWith('/song/media/outer/url')) {
        counts.neteaseDownload += 1;
        const id = u.searchParams.get('id') || '';
        if (id.startsWith('222') || id.startsWith('555') || id.startsWith('999')) {
          res.writeHead(200, { 'Content-Type': 'text/html;charset=utf8' });
          return res.end('<html>受限</html>');
        }
        res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': WAV.length });
        return res.end(WAV);
      }
      if (u.pathname === '/audio/migu333.wav') {
        counts.miguDownload += 1;
        res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': WAV.length });
        return res.end(WAV);
      }
      if (u.pathname === '/audio/flaky.wav') {
        // 模拟下载中途断流：先发一小段再断开连接
        res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': WAV.length + 100 });
        res.write(WAV.subarray(0, 100));
        setTimeout(() => res.destroy(), 20);
        return;
      }
      if (u.pathname === '/audio/slow.wav') {
        // 慢速但正常的下载（延迟 400ms），用于并发下载上限测试
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': WAV.length });
          res.end(WAV);
        }, 400);
        return;
      }
      sendJson(404, { error: 'not found' });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, counts });
    });
  });
}

function startServer(extraEnv = {}, port = PORT) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER_PATH], {
      env: {
        ...process.env,
        PORT: String(port),
        UPLOAD_DIR: uploadTmpDir,
        LIBRARY_DIR: libraryTmpDir,
        EMPTY_ROOM_TTL_MS: '3000',
        ACTIVE_ROOM_TTL_MS: '3000',
        NETEASE_BASE: `http://127.0.0.1:${stub.port}`,
        MIGU_BASE: `http://127.0.0.1:${stub.port}`,
        ONLINE_AUDIO_HOSTS: '127.0.0.1',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const onData = (chunk) => {
      output += chunk.toString();
      if (output.includes('已启动')) {
        cleanup();
        resolve(child);
      }
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      child.off('error', onError);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', onError);
    setTimeout(() => {
      cleanup();
      reject(new Error('服务器启动超时'));
    }, 8000).unref();
  });
}

function connectClient(port = PORT) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const queue = [];
    const waiters = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      const idx = waiters.findIndex((w) => w.type === msg.type);
      if (idx >= 0) {
        const [waiter] = waiters.splice(idx, 1);
        waiter.resolve(msg);
      } else {
        queue.push(msg);
      }
    });
    ws.on('open', () => {
      const client = {
        ws,
        send(obj) {
          ws.send(JSON.stringify(obj));
        },
        waitFor(type, timeout = 8000) {
          const idx = queue.findIndex((m) => m.type === type);
          if (idx >= 0) return Promise.resolve(queue.splice(idx, 1)[0]);
          return new Promise((resolveMsg, rejectMsg) => {
            const timer = setTimeout(() => rejectMsg(new Error(`等待 ${type} 超时`)), timeout);
            waiters.push({
              type,
              resolve: (msg) => {
                clearTimeout(timer);
                resolveMsg(msg);
              },
            });
          });
        },
        close() {
          return new Promise((resolveClose) => {
            if (ws.readyState === WebSocket.CLOSED) return resolveClose();
            ws.once('close', resolveClose);
            try {
              ws.close();
            } catch {
              resolveClose();
            }
          });
        },
      };
      clients.push(client);
      resolve(client);
    });
    ws.on('error', reject);
  });
}

async function addOnline(body, port = PORT) {
  const res = await fetch(`http://127.0.0.1:${port}/api/online/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

before(async () => {
  stub = await startStub();
  serverProcess = await startServer({
    ONLINE_RATE_WINDOW_MS: '60000',
    ONLINE_RATE_MAX: '100',
  });
});

after(() => {
  for (const client of clients) client.close();
  if (serverProcess) serverProcess.kill();
  if (rateServerProcess) rateServerProcess.kill();
  if (stub) stub.server.close();
  fs.rmSync(uploadTmpDir, { recursive: true, force: true });
  fs.rmSync(libraryTmpDir, { recursive: true, force: true });
});

test('在线搜索合并网易云与咪咕结果，会员歌标记不可播', async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/online/search?q=测试`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.total, 2); // 网易云《测试歌》与咪咕同歌去重，保留咪咕
  assert.equal(data.results[0].source, 'migu'); // 咪咕优先展示
  assert.equal(data.results[0].name, '测试歌');
  assert.equal(data.results[0].playable, true);
  assert.equal(data.results[1].source, 'netease');
  assert.equal(data.results[1].playable, false); // 会员歌
});

test('在线搜索结果缓存 60 秒，重复搜索不重复请求第三方', async () => {
  const before = stub.counts.neteaseSearch;
  for (let i = 0; i < 2; i += 1) {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/online/search?q=缓存测试`);
    assert.equal(res.status, 200);
  }
  assert.equal(stub.counts.neteaseSearch, before + 1);
});

test('单源结果过多时仍保证两个来源都可见', async () => {
  const page1 = await (await fetch(`http://127.0.0.1:${PORT}/api/online/search?q=多结果`)).json();
  assert.equal(page1.total, 72); // 咪咕 3 页 × 20 条 + 网易云 12 条
  assert.equal(page1.results.length, 20);
  assert.equal(page1.hasMore, true);
  const page4 = await (
    await fetch(`http://127.0.0.1:${PORT}/api/online/search?q=多结果&offset=60`)
  ).json();
  assert.equal(page4.results.length, 12);
  assert.equal(page4.hasMore, false);
  const sources = new Set([...page1.results, ...page4.results].map((r) => r.source));
  assert.ok(sources.has('netease'));
  assert.ok(sources.has('migu'));
});

test('在线搜索分页：offset 越界返回空且 hasMore=false', async () => {
  const data = await (
    await fetch(`http://127.0.0.1:${PORT}/api/online/search?q=多结果&offset=100`)
  ).json();
  assert.equal(data.results.length, 0);
  assert.equal(data.hasMore, false);
  assert.equal(data.total, 72);
});

test('搜索结果按歌名+歌手去重', async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/online/search?q=重复`);
  assert.equal(res.status, 200);
  const data = await res.json();
  const names = data.results.map((r) => r.name).sort();
  assert.deepEqual(names, ['另一首', '同一首歌', '第三首']);
});

test('在线请求超过限速返回 429', async () => {
  const ratePort = 20000 + crypto.randomInt(0, 30000);
  rateServerProcess = await startServer({
    ONLINE_RATE_WINDOW_MS: '10000',
    ONLINE_RATE_MAX: '3',
  }, ratePort);
  const statuses = [];
  for (let i = 0; i < 4; i += 1) {
    const res = await fetch(`http://127.0.0.1:${ratePort}/api/online/search?q=限速${i}`);
    statuses.push(res.status);
  }
  assert.deepEqual(statuses, [200, 200, 200, 429]);
  rateServerProcess.kill();
  rateServerProcess = null;
});

test('添加网易云免费歌：下载到 library/online 并广播播放列表', async () => {
  const alice = await connectClient();
  alice.send({ type: 'create_room', name: '一起听', nickname: '小A' });
  const created = await alice.waitFor('room_created');
  await alice.waitFor('state'); // 消费初始空状态

  const { status, data } = await addOnline({
    roomId: created.code,
    trackId: 'netease:111',
    name: '测试歌',
    artist: '测试歌手',
    nickname: '小A',
  });
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.track.source, 'online');
  assert.equal(data.track.provider, 'netease');
  assert.ok(fs.existsSync(path.join(libraryTmpDir, 'online', 'netease-111.mp3')));

  const state = await alice.waitFor('state');
  assert.equal(state.playlist.length, 1);
  assert.equal(state.playlist[0].name, '测试歌');
  await alice.close();
});

test('网易云会员/受限歌自动换源咪咕下载', async () => {
  const alice = await connectClient();
  alice.send({ type: 'create_room', name: '一起听', nickname: '小A' });
  const created = await alice.waitFor('room_created');
  await alice.waitFor('state');

  const { status, data } = await addOnline({
    roomId: created.code,
    trackId: 'netease:222',
    name: '会员歌',
    artist: '会员歌手',
    nickname: '小A',
  });
  assert.equal(status, 200);
  assert.equal(data.track.provider, 'migu');
  assert.equal(data.track.name, '会员歌'); // 咪咕同名歌曲
  assert.ok(fs.existsSync(path.join(libraryTmpDir, 'online', 'migu-333.mp3')));
  assert.equal(stub.counts.miguListen, 1);
  assert.equal(stub.counts.miguDownload, 1);
  await alice.close();
});

test('换源时歌名不匹配不添加错误歌曲', async () => {
  const alice = await connectClient();
  alice.send({ type: 'create_room', name: '一起听', nickname: '小A' });
  const created = await alice.waitFor('room_created');
  await alice.waitFor('state');

  const { status, data } = await addOnline({
    roomId: created.code,
    trackId: 'netease:555',
    name: '不匹配的歌',
    artist: '某人',
    nickname: '小A',
  });
  assert.equal(status, 502);
  assert.match(data.error, /版权或会员限制/);
  assert.ok(!fs.existsSync(path.join(libraryTmpDir, 'online', 'migu-444.mp3')));
  await alice.close();
});

test('同一首在线歌重复添加不重复下载', async () => {
  const alice = await connectClient();
  alice.send({ type: 'create_room', name: '一起听', nickname: '小A' });
  const created = await alice.waitFor('room_created');
  await alice.waitFor('state');

  const downloadsBefore = stub.counts.neteaseDownload;
  for (let i = 0; i < 2; i += 1) {
    const { status } = await addOnline({
      roomId: created.code,
      trackId: 'netease:111',
      name: '测试歌',
      artist: '测试歌手',
      nickname: '小A',
    });
    assert.equal(status, 200);
  }
  // 第一次添加复用上一次测试已下载的文件，第二次添加也复用，全程不重复下载
  assert.equal(stub.counts.neteaseDownload, downloadsBefore);
  await alice.close();
});

test('非法歌曲标识返回 400', async () => {
  const alice = await connectClient();
  alice.send({ type: 'create_room', name: '一起听', nickname: '小A' });
  const created = await alice.waitFor('room_created');
  await alice.waitFor('state');

  const { status, data } = await addOnline({
    roomId: created.code,
    trackId: 'netease:../../server.js',
    name: 'x',
    nickname: '小A',
  });
  assert.equal(status, 400);
  assert.match(data.error, /无效的歌曲标识/);
  await alice.close();
});

test('双源都不可播时返回 502 且不加入播放列表', async () => {
  const alice = await connectClient();
  alice.send({ type: 'create_room', name: '一起听', nickname: '小A' });
  const created = await alice.waitFor('room_created');
  await alice.waitFor('state');

  const { status, data } = await addOnline({
    roomId: created.code,
    trackId: 'netease:999',
    name: '找不到的歌',
    artist: '无人',
    nickname: '小A',
  });
  assert.equal(status, 502);
  assert.match(data.error, /版权或会员限制/);
  assert.ok(!fs.existsSync(path.join(libraryTmpDir, 'online', 'netease-999.mp3')));
  assert.ok(!fs.existsSync(path.join(libraryTmpDir, 'online', 'migu-999.mp3')));
  await alice.close();
});

test('下载中途断流返回 502、清理半成品文件且服务不崩溃', async () => {
  const alice = await connectClient();
  alice.send({ type: 'create_room', name: '一起听', nickname: '小A' });
  const created = await alice.waitFor('room_created');
  await alice.waitFor('state');

  const { status, data } = await addOnline({
    roomId: created.code,
    trackId: 'migu:777:c777:cr777',
    name: '断流歌',
    artist: '断流歌手',
    nickname: '小A',
  });
  assert.equal(status, 502);
  assert.ok(data.error);
  assert.ok(!fs.existsSync(path.join(libraryTmpDir, 'online', 'migu-777.mp3')));
  assert.ok(!fs.existsSync(path.join(libraryTmpDir, 'online', 'migu-777.mp3.tmp')));

  // 服务必须还活着：断流失败不能把进程带崩
  const res = await fetch(`http://127.0.0.1:${PORT}/api/online/search?q=存活检查`);
  assert.equal(res.status, 200);
  await alice.close();
});

test('在线歌曲文件被外部删除后再次添加：自动重新下载且不崩溃', async () => {
  const alice = await connectClient();
  alice.send({ type: 'create_room', name: '一起听', nickname: '小A' });
  const created = await alice.waitFor('room_created');
  await alice.waitFor('state');

  // 首次添加（netease:111 在更早的测试里已下载过，这里复用缓存）
  const r1 = await addOnline({
    roomId: created.code,
    trackId: 'netease:111',
    name: '测试歌',
    artist: '测试歌手',
    nickname: '小A',
  });
  assert.equal(r1.status, 200);

  // 模拟外部删除下载文件（用户清理 library/online）
  const file = path.join(libraryTmpDir, 'online', 'netease-111.mp3');
  assert.ok(fs.existsSync(file), '下载文件应存在');
  fs.unlinkSync(file);

  // 再次添加：缓存命中但文件已删——修复前 statSync 抛 ENOENT 直接崩掉整个进程
  const downloadsBefore = stub.counts.neteaseDownload;
  const r2 = await addOnline({
    roomId: created.code,
    trackId: 'netease:111',
    name: '测试歌',
    artist: '测试歌手',
    nickname: '小A',
  });
  assert.equal(r2.status, 200);
  assert.ok(fs.existsSync(file), '文件应被重新下载');
  assert.equal(stub.counts.neteaseDownload, downloadsBefore + 1, '应触发一次重新下载');

  // 服务必须还活着
  const res = await fetch(`http://127.0.0.1:${PORT}/api/online/search?q=存活检查`);
  assert.equal(res.status, 200);
  await alice.close();
});

test('并发下载超过上限返回 429，下载完成后槽位释放', async () => {
  const dlPort = 20000 + crypto.randomInt(0, 30000);
  const dlServer = await startServer(
    {
      ONLINE_MAX_CONCURRENT_DOWNLOADS: '1',
      ONLINE_RATE_WINDOW_MS: '60000',
      ONLINE_RATE_MAX: '1000',
    },
    dlPort
  );
  try {
    const alice = await connectClient(dlPort);
    alice.send({ type: 'create_room', name: '一起听', nickname: '小A' });
    const created = await alice.waitFor('room_created');
    await alice.waitFor('state');

    // 两个慢速下载（400ms）同时发起：并发上限 1，必然一个 200 一个 429
    const [r1, r2] = await Promise.all([
      addOnline({ roomId: created.code, trackId: 'migu:888:c888:cr888', name: '慢歌A', artist: '歌手', nickname: '小A' }, dlPort),
      addOnline({ roomId: created.code, trackId: 'migu:999:c999:cr999', name: '慢歌B', artist: '歌手', nickname: '小A' }, dlPort),
    ]);
    const statuses = [r1.status, r2.status].sort();
    assert.deepEqual(statuses, [200, 429], '并发下载应一个成功一个被限，实际: ' + statuses.join(','));

    // 第一个下载完成后槽位释放：再添加应成功
    const r3 = await addOnline({ roomId: created.code, trackId: 'migu:888:c888:cr888', name: '慢歌A', artist: '歌手', nickname: '小A' }, dlPort);
    assert.equal(r3.status, 200);
    await alice.close();
  } finally {
    dlServer.kill();
  }
});

test('无人引用的在线下载文件被定期清理，有引用的保留', async () => {
  const clPort = 20000 + crypto.randomInt(0, 30000);
  const clServer = await startServer(
    {
      ONLINE_FILE_TTL_MS: '100',
      ONLINE_CLEAN_INTERVAL_MS: '200',
      ONLINE_RATE_WINDOW_MS: '60000',
      ONLINE_RATE_MAX: '1000',
    },
    clPort
  );
  try {
    const alice = await connectClient(clPort);
    alice.send({ type: 'create_room', name: '一起听', nickname: '小A' });
    const created = await alice.waitFor('room_created');
    await alice.waitFor('state');

    const r1 = await addOnline({ roomId: created.code, trackId: 'migu:500:c500:cr500', name: '缓存歌', artist: '歌手', nickname: '小A' }, clPort);
    assert.equal(r1.status, 200);
    const file = path.join(libraryTmpDir, 'online', 'migu-500.mp3');
    assert.ok(fs.existsSync(file), '下载文件应存在');

    // 房间还引用着：过了多个清理周期文件必须保留
    await new Promise((r) => setTimeout(r, 700));
    assert.ok(fs.existsSync(file), '有引用时不应被清理');

    // 退出房间，等房间销毁（ACTIVE_ROOM_TTL 3000ms）后文件失去引用，下个清理周期删除
    await alice.close();
    await new Promise((r) => setTimeout(r, 3700));
    assert.ok(!fs.existsSync(file), '无引用且超 TTL 后应被清理');
  } finally {
    clServer.kill();
  }
});

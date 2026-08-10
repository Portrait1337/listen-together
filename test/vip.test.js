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
const VIP_PORT = 20000 + crypto.randomInt(0, 30000);
const BAD_PORT = 20000 + crypto.randomInt(0, 30000);
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-vip-'));
const WAV = Buffer.concat([
  Buffer.from('UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA', 'base64'),
  Buffer.alloc(4096),
]);

let stub = null;
let plainServer = null; // 无 Cookie
let vipServer = null; // 有效 Cookie
let badServer = null; // 无效 Cookie
const clients = [];

// ---------- 桩服务：模拟网易云登录态与播放接口 ----------
function startStub() {
  return new Promise((resolve) => {
    const counts = { vipResolve: 0, vipCheck: 0 };
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      const cookie = req.headers.cookie || '';
      const sendJson = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (u.pathname === '/api/search/get/web') {
        return sendJson(200, {
          result: {
            songs: [
              { id: 111, name: '免费歌', artists: [{ name: '歌手A' }], album: { name: '专辑A' }, duration: 180000, fee: 0 },
              { id: 222, name: '会员歌', artists: [{ name: '歌手B' }], album: { name: '专辑B' }, duration: 200000, fee: 1 },
            ],
          },
        });
      }
      if (u.pathname === '/api/nuser/account/get') {
        counts.vipCheck += 1;
        if (cookie.includes('VALID_COOKIE')) {
          return sendJson(200, { code: 200, profile: { nickname: '会员小号' } });
        }
        return sendJson(200, { code: 301 });
      }
      if (u.pathname === '/api/song/enhance/player/url') {
        counts.vipResolve += 1;
        if (cookie.includes('VALID_COOKIE')) {
          return sendJson(200, {
            code: 200,
            data: [{ id: 222, url: `http://127.0.0.1:${server.address().port}/audio/vip222.wav`, code: 200 }],
          });
        }
        return sendJson(200, { code: 200, data: [{ id: 222, url: null, code: -110 }] });
      }
      if (u.pathname === '/MIGUM2.0/v1.0/content/search_all.do') {
        return sendJson(200, {
          code: '000000',
          songResultData: {
            result: [
              {
                id: '333',
                contentId: 'c333',
                copyrightId: 'cr333',
                name: '会员歌',
                singers: [{ name: '歌手B' }],
                albums: [{ name: '专辑M' }],
              },
            ],
          },
        });
      }
      if (u.pathname === '/MIGUM3.0/v1.0/content/sub/listen.do') {
        return sendJson(200, {
          code: '000000',
          info: '成功',
          songListens: [{ url: `http://127.0.0.1:${server.address().port}/audio/migu333.wav` }],
        });
      }
      if (u.pathname.startsWith('/song/media/outer/url')) {
        const id = u.searchParams.get('id') || '';
        if (id.startsWith('222')) {
          res.writeHead(200, { 'Content-Type': 'text/html;charset=utf8' });
          return res.end('<html>受限</html>');
        }
        res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': WAV.length });
        return res.end(WAV);
      }
      if (u.pathname === '/audio/vip222.wav' || u.pathname === '/audio/migu333.wav') {
        res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': WAV.length });
        return res.end(WAV);
      }
      sendJson(404, { error: 'not found' });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, counts });
    });
  });
}

function startServer(port, libDir, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER_PATH], {
      env: {
        ...process.env,
        PORT: String(port),
        UPLOAD_DIR: path.join(tmpBase, `upload-${port}`),
        LIBRARY_DIR: libDir,
        EMPTY_ROOM_TTL_MS: '3000',
        ACTIVE_ROOM_TTL_MS: '3000',
        NETEASE_BASE: `http://127.0.0.1:${stub.port}`,
        MIGU_BASE: `http://127.0.0.1:${stub.port}`,
        ONLINE_AUDIO_HOSTS: '127.0.0.1',
        ONLINE_RATE_WINDOW_MS: '60000',
        ONLINE_RATE_MAX: '100',
        NETEASE_COOKIE_FILE: path.join(tmpBase, `cookie-${port}.txt`),
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

function connectClient(port) {
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

async function addOnline(port, roomId, trackId, name, artist) {
  const res = await fetch(`http://127.0.0.1:${port}/api/online/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roomId, trackId, name, artist, nickname: '小A' }),
  });
  return { status: res.status, data: await res.json() };
}

async function createRoom(port) {
  const c = await connectClient(port);
  c.send({ type: 'create_room', name: '一起听', nickname: '小A' });
  const created = await c.waitFor('room_created');
  await c.waitFor('state');
  return { client: c, code: created.code };
}

before(async () => {
  stub = await startStub();
  plainServer = await startServer(PORT, path.join(tmpBase, 'lib-plain'));
  vipServer = await startServer(VIP_PORT, path.join(tmpBase, 'lib-vip'), {
    NETEASE_COOKIE: 'VALID_COOKIE=abc',
  });
  badServer = await startServer(BAD_PORT, path.join(tmpBase, 'lib-bad'), {
    NETEASE_COOKIE: 'BAD_COOKIE=xyz',
  });
});

after(() => {
  for (const client of clients) client.close();
  if (plainServer) plainServer.kill();
  if (vipServer) vipServer.kill();
  if (badServer) badServer.kill();
  if (stub) stub.server.close();
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

test('未配置有效 Cookie：搜索 vipEnabled=false，会员歌走咪咕换源', async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/online/search?q=会员`);
  const data = await res.json();
  assert.equal(data.vipEnabled, false);

  const room = await createRoom(PORT);
  const { status, data: addData } = await addOnline(PORT, room.code, 'netease:222', '会员歌', '歌手B');
  assert.equal(status, 200);
  assert.equal(addData.track.provider, 'migu');
  await room.client.close();
});

test('配置有效 Cookie：搜索 vipEnabled=true 且带昵称', async () => {
  // 登录状态检查是异步的，轮询等待就绪
  let data = null;
  for (let i = 0; i < 20; i += 1) {
    const res = await fetch(`http://127.0.0.1:${VIP_PORT}/api/online/search?q=会员`);
    data = await res.json();
    if (data.vipEnabled === true) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(data.vipEnabled, true);
  assert.equal(data.vipNickname, '会员小号');
});

test('会员歌添加为流式条目：不落盘、URL 指向流式接口', async () => {
  const room = await createRoom(VIP_PORT);
  const { status, data } = await addOnline(VIP_PORT, room.code, 'netease:222', '会员歌', '歌手B');
  assert.equal(status, 200);
  assert.equal(data.track.provider, 'netease');
  assert.equal(data.track.vip, true);
  assert.equal(data.track.url, '/api/online/stream?trackId=netease%3A222');
  assert.ok(!fs.existsSync(path.join(tmpBase, 'lib-vip', 'online', 'netease-222.mp3')));
  await room.client.close();
});

test('流式接口返回 307 且可跟随到音频', async () => {
  const res = await fetch(`http://127.0.0.1:${VIP_PORT}/api/online/stream?trackId=netease:222`, {
    redirect: 'manual',
  });
  assert.equal(res.status, 307);
  const loc = res.headers.get('location');
  assert.match(loc, /\/audio\/vip222\.wav$/);
  const audio = await fetch(loc);
  assert.equal(audio.status, 200);
  assert.match(audio.headers.get('content-type'), /audio\//);
});

test('无 Cookie 的实例流式接口返回 403', async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/online/stream?trackId=netease:222`);
  assert.equal(res.status, 403);
});

test('无效 Cookie：会员歌自动降级咪咕换源', async () => {
  const room = await createRoom(BAD_PORT);
  const { status, data } = await addOnline(BAD_PORT, room.code, 'netease:222', '会员歌', '歌手B');
  assert.equal(status, 200);
  assert.equal(data.track.provider, 'migu');
  await room.client.close();
});

test('流式接口拒绝非法歌曲标识', async () => {
  const res = await fetch(`http://127.0.0.1:${VIP_PORT}/api/online/stream?trackId=netease:abc`);
  assert.equal(res.status, 400);
});

test('有效 Cookie 不影响免费歌下载落盘', async () => {
  const room = await createRoom(VIP_PORT);
  const { status } = await addOnline(VIP_PORT, room.code, 'netease:111', '免费歌', '歌手A');
  assert.equal(status, 200);
  assert.ok(fs.existsSync(path.join(tmpBase, 'lib-vip', 'online', 'netease-111.mp3')));
  await room.client.close();
});

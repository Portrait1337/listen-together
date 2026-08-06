const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const WebSocket = require('ws');

const SERVER_PATH = path.join(__dirname, '..', 'server.js');
const PORT = 5000 + crypto.randomInt(1000, 9000);

let serverProcess = null;
const clients = [];

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER_PATH], {
      env: {
        ...process.env,
        PORT: String(PORT),
        EMPTY_ROOM_TTL_MS: '5000',
        ACTIVE_ROOM_TTL_MS: '5000',
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

function connectClient() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    let latestState = null;
    const waiters = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type !== 'state') return;
      latestState = msg;
      const idx = waiters.findIndex((w) => w.pred(msg));
      if (idx >= 0) {
        const [waiter] = waiters.splice(idx, 1);
        waiter.resolve(msg);
      }
    });
    ws.on('open', () => {
      const client = {
        ws,
        send(obj) {
          ws.send(JSON.stringify(obj));
        },
        waitForState(pred, timeout = 6000) {
          if (latestState && pred(latestState)) return Promise.resolve(latestState);
          return new Promise((resolveWait, rejectWait) => {
            const timer = setTimeout(() => {
              const i = waiters.findIndex((w) => w.resolve === resolveWait);
              if (i >= 0) waiters.splice(i, 1);
              rejectWait(new Error('等待符合条件的状态超时'));
            }, timeout);
            waiters.push({
              pred,
              resolve: (msg) => {
                clearTimeout(timer);
                resolveWait(msg);
              },
            });
          });
        },
        close() {
          return new Promise((done) => {
            if (ws.readyState === WebSocket.CLOSED) return done();
            ws.once('close', done);
            try {
              ws.close();
            } catch {
              done();
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

async function uploadTrack(code, name) {
  const silentWav = Buffer.from(
    'UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA',
    'base64'
  );
  const form = new FormData();
  form.append('roomId', code);
  form.append('nickname', '小A');
  form.append('file', new Blob([silentWav], { type: 'audio/wav' }), name);
  const res = await fetch(`http://127.0.0.1:${PORT}/api/upload?roomId=${encodeURIComponent(code)}`, {
    method: 'POST',
    body: form,
  });
  assert.equal(res.status, 200);
  return res.json();
}

before(async () => {
  serverProcess = await startServer();
});

after(() => {
  for (const client of clients) client.close();
  if (serverProcess) serverProcess.kill();
});

test('可以从歌单删除歌曲，删当前播放的歌会自动切到下一首', async () => {
  const alice = await connectClient();
  alice.send({ type: 'create_room', name: '一起听', nickname: '小A' });
  const created = await alice.waitForState((s) => s.code);

  await uploadTrack(created.code, 'song1.wav');
  await uploadTrack(created.code, 'song2.wav');
  await uploadTrack(created.code, 'song3.wav');
  let state = await alice.waitForState((s) => s.playlist.length === 3);
  const id1 = state.playlist[0].id;
  const id2 = state.playlist[1].id;
  const id3 = state.playlist[2].id;
  assert.equal(state.currentIndex, 0);

  // 开始播放第一首
  alice.send({ type: 'control', action: 'play' });
  state = await alice.waitForState((s) => s.playing === true);

  // 删除当前正在播的第一首，应自动切到原来的第二首继续播
  alice.send({ type: 'remove_track', trackId: id1 });
  state = await alice.waitForState((s) => s.playlist.length === 2);
  assert.equal(state.playlist[0].id, id2);
  assert.equal(state.playlist[1].id, id3);
  assert.equal(state.currentIndex, 0);
  assert.equal(state.playing, true);

  // 删除当前歌后面的歌，当前歌不变
  alice.send({ type: 'remove_track', trackId: id3 });
  state = await alice.waitForState((s) => s.playlist.length === 1);
  assert.equal(state.playlist[0].id, id2);
  assert.equal(state.currentIndex, 0);

  // 把最后一首也删掉，播放停止、回到空歌单
  alice.send({ type: 'remove_track', trackId: id2 });
  state = await alice.waitForState((s) => s.playlist.length === 0);
  assert.equal(state.playing, false);
  assert.equal(state.currentIndex, -1);

  await alice.close();
});

test('删除不存在的歌曲不会影响歌单', async () => {
  const alice = await connectClient();
  alice.send({ type: 'create_room', name: '一起听', nickname: '小A' });
  const created = await alice.waitForState((s) => s.code);

  await uploadTrack(created.code, 'song.wav');
  await alice.waitForState((s) => s.playlist.length === 1);

  alice.send({ type: 'remove_track', trackId: 'not-exist' });
  // 用一次播放操作触发新的状态广播，确认删除无效后歌单仍是 1 首
  alice.send({ type: 'control', action: 'play' });
  const state = await alice.waitForState((s) => s.playing === true);
  assert.equal(state.playlist.length, 1);

  await alice.close();
});

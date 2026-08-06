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
      if (msg.type === 'state') {
        latestState = msg;
      } else if (msg.type === 'mode_changed') {
        // 切模式不再广播完整状态，合并到最新状态里，方便测试等待
        latestState = latestState ? { ...latestState, playMode: msg.playMode } : { playMode: msg.playMode };
      } else {
        return;
      }
      const idx = waiters.findIndex((w) => w.pred(latestState));
      if (idx >= 0) {
        const [waiter] = waiters.splice(idx, 1);
        waiter.resolve(latestState);
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
        waitForNextState(timeout = 6000) {
          return new Promise((resolveWait, rejectWait) => {
            const timer = setTimeout(() => rejectWait(new Error('等待下一条状态超时')), timeout);
            waiters.push({
              pred: () => true,
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

test('单曲循环模式：播完停在当前歌并重新开始', async () => {
  const alice = await connectClient();
  alice.send({ type: 'create_room', name: '一起听', nickname: '小A' });
  const created = await alice.waitForState((s) => s.code);

  await uploadTrack(created.code, 'song1.wav');
  await uploadTrack(created.code, 'song2.wav');
  await alice.waitForState((s) => s.playlist.length === 2);

  alice.send({ type: 'control', action: 'play' });
  let state = await alice.waitForState((s) => s.playing === true);
  assert.equal(state.playMode, 'order');
  const playingBefore = state.playing;
  const positionBefore = state.positionMs;
  const updatedBefore = state.updatedAt;

  // 切换模式本身不能改变播放状态，也不能动进度锚点
  alice.send({ type: 'control', action: 'set_mode', mode: 'single' });
  state = await alice.waitForState((s) => s.playMode === 'single');
  assert.equal(state.playing, playingBefore);
  assert.equal(state.positionMs, positionBefore);
  assert.equal(state.updatedAt, updatedBefore);

  // 单曲循环：播完仍停在当前歌，进度归零
  const singleBefore = state.currentIndex;
  alice.send({ type: 'control', action: 'ended' });
  state = await alice.waitForNextState();
  assert.equal(state.currentIndex, singleBefore);
  assert.equal(state.positionMs, 0);
  assert.equal(state.playing, true);

  await alice.close();
});

test('顺序模式：播完切到下一首', async () => {
  const alice = await connectClient();
  alice.send({ type: 'create_room', name: '一起听', nickname: '小A' });
  const created = await alice.waitForState((s) => s.code);
  await uploadTrack(created.code, 'song1.wav');
  await uploadTrack(created.code, 'song2.wav');
  await alice.waitForState((s) => s.playlist.length === 2);
  alice.send({ type: 'control', action: 'play' });
  let state = await alice.waitForState((s) => s.playing === true);
  const orderBefore = state.currentIndex;
  alice.send({ type: 'control', action: 'ended' });
  state = await alice.waitForState((s) => s.currentIndex !== orderBefore);
  assert.equal(state.currentIndex, (orderBefore + 1) % 2);
  await alice.close();
});

test('随机模式：播完切到另一首', async () => {
  const alice = await connectClient();
  alice.send({ type: 'create_room', name: '一起听', nickname: '小A' });
  const created = await alice.waitForState((s) => s.code);
  await uploadTrack(created.code, 'song1.wav');
  await uploadTrack(created.code, 'song2.wav');
  await alice.waitForState((s) => s.playlist.length === 2);
  alice.send({ type: 'control', action: 'set_mode', mode: 'shuffle' });
  let state = await alice.waitForState((s) => s.playMode === 'shuffle');
  alice.send({ type: 'control', action: 'play' });
  state = await alice.waitForState((s) => s.playing === true);
  const shuffleBefore = state.currentIndex;
  alice.send({ type: 'control', action: 'ended' });
  state = await alice.waitForState((s) => s.currentIndex !== shuffleBefore);
  assert.equal(state.currentIndex, 1 - shuffleBefore);

  await alice.close();
});

test('同一首歌的播完信号在 10 秒内只处理一次', async () => {
  const alice = await connectClient();
  alice.send({ type: 'create_room', name: '一起听', nickname: '小A' });
  const created = await alice.waitForState((s) => s.code);

  await uploadTrack(created.code, 'song.wav');
  await alice.waitForState((s) => s.playlist.length === 1);
  alice.send({ type: 'control', action: 'play' });
  let state = await alice.waitForState((s) => s.playing === true);
  const trackId = state.playlist[0].id;

  // 第一次“播完”正常处理
  alice.send({ type: 'control', action: 'ended', trackId });
  state = await alice.waitForNextState();
  const updatedAfterFirstEnded = state.updatedAt;
  assert.equal(state.currentIndex, 0);
  assert.equal(state.positionMs, 0);

  // 稍等片刻后立刻再发一次同样的信号，应该被冷却拦下
  await new Promise((resolve) => setTimeout(resolve, 30));
  alice.send({ type: 'control', action: 'ended', trackId });
  alice.send({ type: 'request_state' });
  state = await alice.waitForNextState();
  assert.equal(state.updatedAt, updatedAfterFirstEnded);
  assert.equal(state.positionMs, 0);
  assert.equal(state.currentIndex, 0);

  await alice.close();
});

test('迟到的旧歌“播完”信号不会切歌', async () => {
  const alice = await connectClient();
  alice.send({ type: 'create_room', name: '一起听', nickname: '小A' });
  const created = await alice.waitForState((s) => s.code);

  await uploadTrack(created.code, 'song1.wav');
  await uploadTrack(created.code, 'song2.wav');
  await alice.waitForState((s) => s.playlist.length === 2);
  alice.send({ type: 'control', action: 'play' });
  let state = await alice.waitForState((s) => s.playing === true);
  const firstId = state.playlist[state.currentIndex].id;

  // 正常播完第一首：切到第二首
  alice.send({ type: 'control', action: 'ended', trackId: firstId });
  state = await alice.waitForState((s) => s.currentIndex === 1);
  const secondId = state.playlist[1].id;

  // 再发第一首的迟到信号：应被忽略
  alice.send({ type: 'control', action: 'ended', trackId: firstId });
  alice.send({ type: 'request_state' });
  state = await alice.waitForNextState();
  assert.equal(state.currentIndex, 1);
  assert.equal(state.playlist[1].id, secondId);

  // 随便编一个编号：也应被忽略
  alice.send({ type: 'control', action: 'ended', trackId: 'not-current' });
  alice.send({ type: 'request_state' });
  state = await alice.waitForNextState();
  assert.equal(state.currentIndex, 1);
  assert.equal(state.playlist[1].id, secondId);

  await alice.close();
});

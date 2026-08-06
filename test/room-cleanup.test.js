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
        EMPTY_ROOM_TTL_MS: '150',
        ACTIVE_ROOM_TTL_MS: '600',
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
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`等待 ${type} 超时`)), timeout);
            waiters.push({
              type,
              resolve: (msg) => {
                clearTimeout(timer);
                resolve(msg);
              },
            });
          });
        },
        close() {
          return new Promise((resolve) => {
            if (ws.readyState === WebSocket.CLOSED) return resolve();
            ws.once('close', resolve);
            try {
              ws.close();
            } catch {
              resolve();
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

before(async () => {
  serverProcess = await startServer();
});

after(() => {
  for (const client of clients) client.close();
  if (serverProcess) serverProcess.kill();
});

test('房间在最后一个人退出后延迟销毁', async () => {
  const alice = await connectClient();
  alice.send({ type: 'create_room', name: '一起听', nickname: '小A' });
  const created = await alice.waitFor('room_created');

  const bob = await connectClient();
  bob.send({ type: 'join_room', code: created.code, nickname: '小B' });
  await bob.waitFor('state');

  await alice.close();
  await bob.close();

  // 未到销毁时间时仍可加入（证明不是立即销毁）
  const carol = await connectClient();
  carol.send({ type: 'join_room', code: created.code, nickname: '小C' });
  await carol.waitFor('state');
  await carol.close();

  // 超过销毁时间后房间不存在
  await new Promise((resolve) => setTimeout(resolve, 400));

  const dave = await connectClient();
  dave.send({ type: 'join_room', code: created.code, nickname: '小D' });
  const error = await dave.waitFor('error');
  assert.match(error.message, /房间不存在/);
  await dave.close();
});

test('房间里还有人连接时，房间不会被销毁', async () => {
  const alice = await connectClient();
  alice.send({ type: 'create_room', name: '一起听', nickname: '小A' });
  const created = await alice.waitFor('room_created');

  // 超过空房间销毁时间，但 alice 一直在线，房间必须还在
  await new Promise((resolve) => setTimeout(resolve, 250));

  const bob = await connectClient();
  bob.send({ type: 'join_room', code: created.code, nickname: '小B' });
  await bob.waitFor('state');

  await alice.close();
  await bob.close();
});

test('播放过的房间断开后不会被空房间计时销毁，而是等更久', async () => {
  const alice = await connectClient();
  alice.send({ type: 'create_room', name: '一起听', nickname: '小A' });
  const created = await alice.waitFor('room_created');

  // 上传一首歌，让房间成为"播放过的房间"
  const silentWav = Buffer.from(
    'UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA',
    'base64'
  );
  const form = new FormData();
  form.append('roomId', created.code);
  form.append('nickname', '小A');
  form.append('file', new Blob([silentWav], { type: 'audio/wav' }), 'song.wav');
  const uploadRes = await fetch(`http://127.0.0.1:${PORT}/api/upload`, {
    method: 'POST',
    body: form,
  });
  assert.equal(uploadRes.status, 200);

  await alice.close();

  // 已超过空房间的 150ms，但播放过的房间应保留
  await new Promise((resolve) => setTimeout(resolve, 300));
  const bob = await connectClient();
  bob.send({ type: 'join_room', code: created.code, nickname: '小B' });
  await bob.waitFor('state');
  await bob.close();

  // 超过播放过房间的 600ms 后才销毁
  await new Promise((resolve) => setTimeout(resolve, 700));
  const carol = await connectClient();
  carol.send({ type: 'join_room', code: created.code, nickname: '小C' });
  const error = await carol.waitFor('error');
  assert.match(error.message, /房间不存在/);
  await carol.close();
});

test('聊过天的房间断开后也不会被空房间计时销毁，而是等更久', async () => {
  const alice = await connectClient();
  alice.send({ type: 'create_room', name: '一起听', nickname: '小A' });
  const created = await alice.waitFor('room_created');

  alice.send({ type: 'chat', text: '大家好' });
  await alice.waitFor('chat');
  await alice.close();

  // 已超过空房间的 150ms，聊过天的房间应保留
  await new Promise((resolve) => setTimeout(resolve, 300));
  const bob = await connectClient();
  bob.send({ type: 'join_room', code: created.code, nickname: '小B' });
  await bob.waitFor('state');
  await bob.close();

  // 超过播放过房间的 600ms 后才销毁
  await new Promise((resolve) => setTimeout(resolve, 700));
  const carol = await connectClient();
  carol.send({ type: 'join_room', code: created.code, nickname: '小C' });
  const error = await carol.waitFor('error');
  assert.match(error.message, /房间不存在/);
  await carol.close();
});

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const WebSocket = require('ws');

const SERVER_PATH = path.join(__dirname, '..', 'server.js');
const PORT = 20000 + crypto.randomInt(0, 30000);
// 测试上传目录：指向独立临时目录，避免污染/误删项目真实 uploads/
const uploadTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-upload-'));

let serverProcess = null;
const clients = [];

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER_PATH], {
      env: {
        ...process.env,
        PORT: String(PORT),
        UPLOAD_DIR: uploadTmpDir,
        // 该测试会以最高速连发 105 条消息验证历史上限，节流交给 ws-guard 专项测试，这里放开
        MAX_WS_MSGS_PER_SECOND: '1000',
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
          try {
            ws.close();
          } catch {}
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
  fs.rmSync(uploadTmpDir, { recursive: true, force: true });
});

test('新用户进房能看到之前的聊天记录', async () => {
  const alice = await connectClient();
  alice.send({ type: 'create_room', name: '一起听', nickname: '小A' });
  const created = await alice.waitFor('room_created');

  alice.send({ type: 'chat', text: '你好呀' });
  await alice.waitFor('chat');

  const bob = await connectClient();
  bob.send({ type: 'join_room', code: created.code, nickname: '小B' });
  const history = await bob.waitFor('chat_history');

  assert.equal(history.messages.length, 1);
  assert.equal(history.messages[0].nickname, '小A');
  assert.equal(history.messages[0].text, '你好呀');
});

test('聊天记录最多保留最近 100 条', async () => {
  const alice = await connectClient();
  alice.send({ type: 'create_room', name: '一起听', nickname: '小A' });
  const created = await alice.waitFor('room_created');

  for (let i = 1; i <= 105; i++) {
    alice.send({ type: 'chat', text: '消息' + i });
    await alice.waitFor('chat');
  }

  const bob = await connectClient();
  bob.send({ type: 'join_room', code: created.code, nickname: '小B' });
  const history = await bob.waitFor('chat_history');

  assert.equal(history.messages.length, 100);
  assert.equal(history.messages[0].text, '消息6');
  assert.equal(history.messages[99].text, '消息105');
});

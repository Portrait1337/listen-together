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

function startServer(env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER_PATH], {
      env: {
        ...process.env,
        PORT: String(PORT),
        UPLOAD_DIR: uploadTmpDir,
        MAX_WS_CONNECTIONS: '3',
        MAX_WS_MSGS_PER_SECOND: '50',
        ...env,
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
        waitFor(type, timeout = 5000) {
          const idx = queue.findIndex((m) => m.type === type);
          if (idx >= 0) return Promise.resolve(queue.splice(idx, 1)[0]);
          return new Promise((resolveWait, rejectWait) => {
            const timer = setTimeout(() => rejectWait(new Error(`等待 ${type} 超时`)), timeout);
            waiters.push({
              type,
              resolve: (msg) => {
                clearTimeout(timer);
                resolveWait(msg);
              },
            });
          });
        },
        waitClose(timeout = 5000) {
          return new Promise((resolveClose, rejectClose) => {
            if (ws.readyState === WebSocket.CLOSED) return resolveClose({ code: ws.closeCode });
            const timer = setTimeout(() => rejectClose(new Error('等待关闭超时')), timeout);
            ws.once('close', (code) => {
              clearTimeout(timer);
              resolveClose({ code });
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

test('畸形 JSON 消息（null/数字/字符串/数组）不会崩溃服务', async () => {
  const alice = await connectClient();
  // JSON.parse 全部成功但结果不是对象，曾经会让 msg.type 解引用直接崩掉整个进程
  alice.ws.send('null');
  alice.ws.send('123');
  alice.ws.send('"字符串"');
  alice.ws.send('[1,2,3]');
  alice.ws.send('true');

  // 连接应该还活着：ping 能收到 pong
  alice.send({ type: 'ping', t1: 7 });
  const pong = await alice.waitFor('pong');
  assert.equal(pong.t1, 7);
  assert.equal(serverProcess.exitCode, null);
  alice.close();
});

test('超速发消息会被断开（消息节流）', async () => {
  // 独立起一个低阈值服务器（5 条/秒），与主服务器隔离
  const throttlePort = 20000 + crypto.randomInt(0, 30000);
  const throttleServer = await startServer({
    PORT: String(throttlePort),
    MAX_WS_MSGS_PER_SECOND: '5',
    MAX_WS_CONNECTIONS: '100',
  });
  try {
    const bob = await connectClient(throttlePort);
    // 一口气发 10 条必然超速
    for (let i = 0; i < 10; i++) bob.ws.send(JSON.stringify({ type: 'ping', t1: i }));
    const closed = await bob.waitClose();
    assert.equal(closed.code, 1008); // 1008 = Policy Violation
  } finally {
    throttleServer.kill();
  }
});

test('连接数超上限的新连接会被拒绝', async () => {
  // MAX_WS_CONNECTIONS=3：第 4 个连接时 size=3（3>3 不触发），第 5 个时 size=4 触发
  const c1 = await connectClient();
  const c2 = await connectClient();
  const c3 = await connectClient();
  const c4 = await connectClient();
  const c5 = await connectClient();
  const closed = await c5.waitClose();
  assert.equal(closed.code, 1013); // 1013 = Try Again Later
  c1.close();
  c2.close();
  c3.close();
  c4.close();
  c5.close();
});

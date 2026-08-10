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
      env: { ...process.env, PORT: String(PORT), UPLOAD_DIR: uploadTmpDir },
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

const SILENT_WAV = Buffer.from(
  'UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA',
  'base64'
);

async function uploadBlob(code, blob, filename, mime) {
  const form = new FormData();
  form.append('roomId', code);
  form.append('nickname', '小A');
  form.append('file', new Blob([blob], { type: mime }), filename);
  return fetch(`http://127.0.0.1:${PORT}/api/upload?roomId=${encodeURIComponent(code)}`, {
    method: 'POST',
    body: form,
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

test('真实 WAV 能正常上传', async () => {
  const alice = await connectClient();
  alice.send({ type: 'create_room', name: '一起听', nickname: '小A' });
  const created = await alice.waitFor('room_created');

  const res = await uploadBlob(created.code, SILENT_WAV, 'song.wav', 'audio/wav');
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);

  await alice.close();
});

test('扩展名是 .mp3 但内容是 HTML 的文件会被内容校验拒绝', async () => {
  const alice = await connectClient();
  alice.send({ type: 'create_room', name: '一起听', nickname: '小A' });
  const created = await alice.waitFor('room_created');

  const evil = Buffer.from('<script>alert(1)</script>');
  const res = await uploadBlob(created.code, evil, 'evil.mp3', 'audio/mpeg');
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.match(data.error, /不是有效的音频/);

  await alice.close();
});

test('内容校验只按文件头判定，与 Content-Type 无关', async () => {
  const alice = await connectClient();
  alice.send({ type: 'create_room', name: '一起听', nickname: '小A' });
  const created = await alice.waitFor('room_created');

  // 真实 WAV 内容但 Content-Type 伪装成 text/html：内容合法，应放行
  const good = await uploadBlob(created.code, SILENT_WAV, 'song.wav', 'text/html');
  assert.equal(good.status, 200);

  // 扩展名合法但内容是脚本：即使 Content-Type 伪装成 audio 也拒绝
  const evil = Buffer.from('#!/bin/sh\necho pwned');
  const bad = await uploadBlob(created.code, evil, 'evil.mp3', 'audio/mpeg');
  assert.equal(bad.status, 400);

  await alice.close();
});

test('不带 file 字段的 multipart 请求返回 400 而不是崩溃', async () => {
  const form = new FormData();
  form.append('roomId', 'NOEXIST');
  const res = await fetch(`http://127.0.0.1:${PORT}/api/upload?roomId=NOEXIST`, {
    method: 'POST',
    body: form,
  });
  assert.equal(res.status, 400);
});

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const SERVER_PATH = path.join(__dirname, '..', 'server.js');
const PORT = 20000 + crypto.randomInt(0, 30000);
// 测试上传目录：指向独立临时目录，避免污染/误删项目真实 uploads/
const uploadTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-upload-'));

let serverProcess = null;

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER_PATH], {
      env: {
        ...process.env,
        PORT: String(PORT),
        UPLOAD_DIR: uploadTmpDir,
        EMPTY_ROOM_TTL_MS: '5000',
        ACTIVE_ROOM_TTL_MS: '5000',
        MAX_CONCURRENT_UPLOADS_PER_IP: '2',
        MAX_UPLOADS_PER_MINUTE_PER_IP: '10',
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

function sendUpload(host = '127.0.0.1', headers = {}) {
  const silentWav = Buffer.from(
    'UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA',
    'base64'
  );
  const form = new FormData();
  form.append('roomId', 'NOEXIST');
  form.append('nickname', '小A');
  form.append('file', new Blob([silentWav], { type: 'audio/wav' }), 'song.wav');
  return fetch(`http://${host}:${PORT}/api/upload?roomId=NOEXIST`, {
    method: 'POST',
    headers,
    body: form,
  });
}

before(async () => {
  serverProcess = await startServer();
});

after(() => {
  if (serverProcess) serverProcess.kill();
  fs.rmSync(uploadTmpDir, { recursive: true, force: true });
});

test('上传到不存在的房间返回 404，且短时间上传过多会被 429 限流', async () => {
  // 前 10 次：房间不存在，返回 404（文件会被清理）
  for (let i = 0; i < 10; i++) {
    const res = await sendUpload();
    assert.equal(res.status, 404);
  }

  // 第 11 次：超过每分钟上限，返回 429
  const blocked = await sendUpload();
  assert.equal(blocked.status, 429);
});

test('公网直连（非 loopback）伪造 X-Forwarded-For 无法绕过限流', async (t) => {
  // 模拟攻击者直连服务器：用本机局域网 IP 连接，socket 对端不是 loopback，
  // 此时伪造的 XFF 应被忽略，限流按真实 IP 计数
  const ifs = os.networkInterfaces();
  let target = null;
  for (const name of Object.keys(ifs)) {
    for (const addr of ifs[name] || []) {
      if (addr.family === 'IPv4' && !addr.internal) {
        target = addr.address;
        break;
      }
    }
    if (target) break;
  }
  if (!target) return t.skip('本机没有局域网 IP，无法模拟公网直连');

  // 11 次请求、每次换一个伪造 IP：修复前全部 404（限流被绕过）；修复后按真实 IP 计数，第 11 次 429
  const codes = [];
  for (let i = 0; i < 11; i++) {
    codes.push((await sendUpload(target, { 'X-Forwarded-For': `203.0.113.${i}` })).status);
  }
  assert.ok(
    codes.filter((c) => c === 429).length >= 1,
    '伪造 XFF 仍应触发限流，实际状态码: ' + codes.join(',')
  );
  assert.ok(
    codes.filter((c) => c === 404).length >= 10,
    '前 10 次应正常到达（404 房间不存在），实际状态码: ' + codes.join(',')
  );
});

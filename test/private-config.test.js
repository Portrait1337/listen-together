// 私人配置迁出仓库后，验证 COS 和会员 Cookie 的真实读取行为及覆盖优先级。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-private-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeConfig(dir, tag) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'cos-config.json'), JSON.stringify({
    bucket: 'test-bucket', region: 'test-region', secretId: 'test-id', secretKey: 'test-key',
    cdnBaseUrl: `https://${tag}.example.com`,
  }));
  fs.writeFileSync(path.join(dir, 'netease-cookie.txt'), `SESSION=${tag}`);
}

function inspect(env, expectedTag) {
  const childEnv = { ...process.env };
  for (const key of ['NETEASE_COOKIE', 'NETEASE_COOKIE_FILE', 'COS_CONFIG_FILE',
    'LISTEN_TOGETHER_CONFIG_DIR', 'XDG_CONFIG_HOME']) delete childEnv[key];
  const script = `
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const cos = require('./cos');
    const online = require('./online');
    (async () => {
      let url = null;
      const enabled = cos.enabled();
      if (enabled) {
        cos._setClientForTest({ putObject: (params, cb) => {
          params.Body.on('end', () => cb(null, {}));
          params.Body.on('error', cb);
          params.Body.resume();
        } });
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-cos-input-'));
        try {
          const file = path.join(dir, 'a.wav');
          fs.writeFileSync(file, 'fixture');
          url = await cos.uploadFile(file, 'uploads/a.wav', 'audio/wav');
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
      }
      let cookie = null;
      const login = await online.checkNeteaseLogin(async (url, options) => {
        cookie = options.headers.Cookie;
        return { ok: true, json: async () => ({ profile: { nickname: '测试用户' } }) };
      });
      console.log(JSON.stringify({
        enabled,
        urlMatches: url === 'https://' + process.env.EXPECTED_TAG + '.example.com/uploads/a.wav',
        cookieMatches: cookie === 'SESSION=' + process.env.EXPECTED_TAG,
        hasCookie: cookie !== null,
        valid: login.valid,
      }));
    })().catch(() => process.exit(1));
  `;
  return JSON.parse(execFileSync(process.execPath, ['-e', script], {
    cwd: ROOT, env: { ...childEnv, ...env, EXPECTED_TAG: expectedTag || "" }, encoding: 'utf8',
  }));
}

test('指定私人目录后，COS 上传地址与会员请求使用目录内配置', (t) => {
  const dir = fixture(t);
  writeConfig(dir, 'private');
  assert.deepEqual(inspect({ LISTEN_TOGETHER_CONFIG_DIR: dir }, 'private'), {
    enabled: true, urlMatches: true, cookieMatches: true, hasCookie: true, valid: true,
  });
});

test('未显式指定目录时使用 XDG 用户配置目录', (t) => {
  const dir = fixture(t);
  writeConfig(path.join(dir, 'listen-together'), 'xdg');
  assert.deepEqual(inspect({ XDG_CONFIG_HOME: dir }, 'xdg'), {
    enabled: true, urlMatches: true, cookieMatches: true, hasCookie: true, valid: true,
  });
});

test('单文件环境变量优先于私人目录，原有部署覆盖方式仍有效', (t) => {
  const dir = fixture(t);
  writeConfig(path.join(dir, 'private'), 'private');
  writeConfig(path.join(dir, 'explicit'), 'explicit');
  assert.deepEqual(inspect({
    LISTEN_TOGETHER_CONFIG_DIR: path.join(dir, 'private'),
    COS_CONFIG_FILE: path.join(dir, 'explicit/cos-config.json'),
    NETEASE_COOKIE_FILE: path.join(dir, 'explicit/netease-cookie.txt'),
  }, 'explicit'), {
    enabled: true, urlMatches: true, cookieMatches: true, hasCookie: true, valid: true,
  });
});

test('显式指定不存在的配置文件时，不回退读取私人凭据', (t) => {
  const dir = fixture(t);
  writeConfig(dir, 'private');
  assert.deepEqual(inspect({
    LISTEN_TOGETHER_CONFIG_DIR: dir,
    COS_CONFIG_FILE: path.join(dir, 'missing-cos.json'),
    NETEASE_COOKIE_FILE: path.join(dir, 'missing-cookie.txt'),
  }), { enabled: false, urlMatches: false, cookieMatches: false, hasCookie: false, valid: false });
});

test('服务启动后首次创建私人配置，COS 和 Cookie 自动发现新文件', (t) => {
  const dir = fixture(t);
  const app = path.join(dir, 'app');
  const privateDir = path.join(dir, 'private');
  const staged = path.join(dir, 'staged');
  fs.mkdirSync(app);
  for (const file of ['cos.js', 'online.js', 'config-paths.js']) {
    fs.copyFileSync(path.join(ROOT, file), path.join(app, file));
  }
  writeConfig(staged, 'hot');
  const env = { ...process.env, LISTEN_TOGETHER_CONFIG_DIR: privateDir,
    NODE_PATH: path.join(ROOT, 'node_modules'), STAGED_CONFIG: staged };
  for (const k of ['NETEASE_COOKIE', 'NETEASE_COOKIE_FILE', 'COS_CONFIG_FILE']) delete env[k];
  const script = `
    const fs = require('node:fs');
    const path = require('node:path');
    const cos = require('./cos');
    const online = require('./online');
    const before = cos.enabled();
    const versionBefore = online.getNeteaseCookieVersion();
    fs.cpSync(process.env.STAGED_CONFIG, process.env.LISTEN_TOGETHER_CONFIG_DIR, { recursive: true });
    (async () => {
      let cookieMatches = false;
      const login = await online.checkNeteaseLogin(async (url, options) => {
        cookieMatches = options.headers.Cookie === 'SESSION=hot';
        return { ok: true, json: async () => ({ profile: { nickname: '测试用户' } }) };
      });
      console.log(JSON.stringify({ before, after: cos.enabled(), cookieMatches,
        valid: login.valid, versionChanged: versionBefore !== online.getNeteaseCookieVersion() }));
    })().catch(() => process.exit(1));
  `;
  const actual = JSON.parse(execFileSync(process.execPath, ['-e', script], {
    cwd: app, env, encoding: 'utf8',
  }));
  assert.deepEqual(actual, { before: false, after: true, cookieMatches: true,
    valid: true, versionChanged: true });
});

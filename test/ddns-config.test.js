const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '../deploy/phone/ddnspod-update.sh');
const available = spawnSync('bash', ['-c', 'command -v jq'], { encoding: 'utf8' }).status === 0;

// 用真实脚本和 jq，只替换外部网络边界，验证实际提交的 DNS 记录。
test('DDNS 从外部配置读取域名和凭据，环境变量可覆盖域名', { skip: !available }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-ddns-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/bash
printf '%s\\n' "$@" >> "$CALL_LOG"
case "$*" in
  *Record.List*) echo '{"status":{"code":"1"},"records":[]}' ;;
  *Record.Create*) echo '{"status":{"code":"1"},"record":{"value":"192.0.2.10"}}' ;;
  *) echo '192.0.2.10' ;;
esac
`, { mode: 0o755 });
  const config = path.join(dir, 'private.conf');
  fs.writeFileSync(config, "DOMAIN='base.example.com'\nID='test-id'\nTOKEN='test-token'\n");
  const calls = path.join(dir, 'calls.txt');
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH,
    DNSPOD_CONFIG_FILE: config, DNSPOD_DOMAIN: 'listen.example.com', CALL_LOG: calls };
  delete env.DNSPOD_ID;
  delete env.DNSPOD_TOKEN;
  delete env.DNSPOD_SUB_DOMAIN;
  const result = spawnSync('bash', [SCRIPT], { env, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, 'DDNS 脚本应完成更新');
  assert.match(result.stdout, /更新成功/);
  const log = fs.readFileSync(calls, 'utf8');
  assert.match(log, /domain=listen\.example\.com/);
  assert.match(log, /login_token=test-id,test-token/);
  assert.doesNotMatch(result.stdout + result.stderr, /test-token/);
});

test('DDNS 缺少配置时在发起网络请求之前失败', { skip: !available }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-ddns-missing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'curl'), '#!/bin/bash\nexit 99\n', { mode: 0o755 });
  const env = { ...process.env, PATH: dir + path.delimiter + process.env.PATH,
    DNSPOD_CONFIG_FILE: path.join(dir, 'missing.conf') };
  for (const key of ['DOMAIN', 'SUB_DOMAIN', 'ID', 'TOKEN', 'DNSPOD_DOMAIN', 'DNSPOD_SUB_DOMAIN', 'DNSPOD_ID', 'DNSPOD_TOKEN']) delete env[key];
  const result = spawnSync('bash', [SCRIPT], { env, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /缺少 DDNS 配置/);
});

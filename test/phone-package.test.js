const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const toolsAvailable = ['zip', 'unzip'].every((cmd) =>
  spawnSync(cmd, ['-v'], { encoding: 'utf8' }).status === 0);

// 使用真实项目打包，确保新版配置模块/静态资源存在，私人配置不被打入发布包。
test('手机部署包包含运行所需文件与通用教程，排除私人配置和运维原文', { skip: !toolsAvailable }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-phone-package-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const output = path.join(dir, 'phone package.zip');
  const result = spawnSync(process.execPath, [path.join(__dirname, '../scripts/build-phone-package.js'), output], {
    encoding: 'utf8', timeout: 15000,
  });
  assert.equal(result.status, 0, '部署包应成功生成');
  const entries = execFileSync('unzip', ['-Z1', output], { encoding: 'utf8' }).trim().split('\n');
  for (const name of ['listen-together/config-paths.js', 'listen-together/server.js',
    'listen-together/public/earphones.svg', 'phone-setup.sh', 'ddns-config.example.conf']) {
    assert.ok(entries.includes(name), `部署包缺少运行所需文件：${name}`);
  }
  assert.ok(entries.every((name) => !/(?:^|\/)(?:cos-config\.json|netease-cookie\.txt|cookie-.*\.txt|ddns\.conf|cpolar\.conf|\.git|private-notes)(?:$|\/)/.test(name)));
  assert.ok(entries.every((name) => !name.startsWith('listen-together/docs/')));
  const readme = execFileSync('unzip', ['-p', output, 'listen-together/README.md'], { encoding: 'utf8' });
  assert.doesNotMatch(readme, /\/Users\/[^/]+\//);
});

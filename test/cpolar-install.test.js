const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 路径含空格和 XML 特殊字符时仍能安装；生成的 plist 必须是绝对路径。
test('cpolar 安装器生成可解析模板并保留已有私人配置', { skip: process.platform !== 'darwin' }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-cpolar-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home & space');
  const config = path.join(home, '.config/listen-together');
  fs.mkdirSync(config, { recursive: true });
  const conf = path.join(config, 'cpolar.conf');
  fs.writeFileSync(conf, "PORT='3456'\n");
  const env = { ...process.env, HOME: home, NODE_BIN: process.execPath,
    LISTEN_TOGETHER_CONFIG_DIR: config, CPOLAR_BIN: '/usr/bin/true' };
  const result = spawnSync('zsh', [path.join(__dirname, '../scripts/install-cpolar.sh'), '--no-load'], {
    env, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 0, '安装器应成功生成本地文件');
  const file = path.join(home, 'Library/LaunchAgents/org.listen-together.cpolar.plist');
  const plist = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' }));
  assert.equal(plist.Label, 'org.listen-together.cpolar');
  assert.deepEqual(plist.ProgramArguments, ['/bin/zsh', path.join(home, '.cpolar/bin/cpolar-tunnel.sh')]);
  assert.equal(plist.EnvironmentVariables.LISTEN_TOGETHER_CONFIG_DIR, config);
  assert.equal(fs.readFileSync(conf, 'utf8'), "PORT='3456'\n");
  assert.ok(fs.existsSync(path.join(home, '.cpolar/bin/cpolar-tunnel.sh')));
});

test('cpolar 重复安装读取私人路径，并迁移旧服务而不启动真实隧道', { skip: process.platform !== 'darwin' }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-cpolar-repeat-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home ' & space");
  const config = path.join(home, '.config/listen-together');
  const agents = path.join(home, 'Library/LaunchAgents');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(agents, { recursive: true });
  fs.mkdirSync(bin);
  const calls = path.join(dir, 'launchctl.txt');
  fs.writeFileSync(path.join(bin, 'launchctl'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$LAUNCHCTL_LOG"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(agents, 'org.previous.cpolar-listen-together.plist'),
    '<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>org.previous.cpolar</string></dict></plist>');
  const app = path.join(dir, "project ' & space");
  fs.symlinkSync(path.join(__dirname, '..'), app);
  const env = { ...process.env, HOME: home, APP_DIR: app, NODE_BIN: process.execPath,
    CPOLAR_BIN: '/usr/bin/true', LISTEN_TOGETHER_CONFIG_DIR: config,
    PATH: bin + path.delimiter + process.env.PATH, LAUNCHCTL_LOG: calls };
  const script = path.join(__dirname, '../scripts/install-cpolar.sh');
  const first = spawnSync('zsh', [script], { env, encoding: 'utf8', timeout: 5000 });
  assert.equal(first.status, 0, '首次安装应成功');
  const log = fs.readFileSync(calls, 'utf8');
  assert.match(log, /bootout gui\/\d+\/org\.previous\.cpolar/);
  assert.match(log, /bootstrap gui\/\d+/);
  assert.ok(fs.existsSync(path.join(config, 'legacy-launchagents/org.previous.cpolar-listen-together.plist')));
  const conf = path.join(config, 'cpolar.conf');
  const readPath = execFileSync('zsh', ['-c', 'source "$1"; printf "%s" "$APP_DIR"', '--', conf], { encoding: 'utf8' });
  assert.equal(readPath, app, '私人配置中的特殊字符路径应可重新读取');
  const repeatedEnv = { ...env };
  for (const k of ['APP_DIR', 'NODE_BIN', 'CPOLAR_BIN']) delete repeatedEnv[k];
  const second = spawnSync('zsh', [script], { env: repeatedEnv, encoding: 'utf8', timeout: 5000 });
  assert.equal(second.status, 0, '重复安装应使用已有私人配置，不要求重复提供程序路径');
});

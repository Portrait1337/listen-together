#!/bin/zsh
# 生成当前用户的自启配置，私人路径只写入用户目录。
set -euo pipefail
umask 077

MODE="${1:-}"
if [[ -n "$MODE" && "$MODE" != '--no-load' ]]; then
  echo '用法：zsh scripts/install-cpolar.sh [--no-load]' >&2
  exit 1
fi
REPO_DIR="${0:A:h:h}"
CONFIG_DIR="${LISTEN_TOGETHER_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/listen-together}"
REQUESTED_APP_DIR="${APP_DIR:-}"
REQUESTED_NODE_BIN="${NODE_BIN:-}"
REQUESTED_CPOLAR_BIN="${CPOLAR_BIN:-}"
if [[ -f "$CONFIG_DIR/cpolar.conf" ]]; then
  source "$CONFIG_DIR/cpolar.conf"
fi
APP_DIR="${REQUESTED_APP_DIR:-${APP_DIR:-$REPO_DIR}}"
NODE_BIN="${REQUESTED_NODE_BIN:-${NODE_BIN:-$(command -v node)}}"
CPOLAR_BIN="${REQUESTED_CPOLAR_BIN:-${CPOLAR_BIN:-$HOME/.cpolar/bin/cpolar}}"
export LISTEN_TOGETHER_CONFIG_DIR="$CONFIG_DIR"
export APP_DIR NODE_BIN CPOLAR_BIN

if [[ ! -f "$APP_DIR/server.js" || ! -x "$NODE_BIN" || ! -x "$CPOLAR_BIN" ]]; then
  echo '请先确认 APP_DIR、NODE_BIN 和 CPOLAR_BIN 指向有效程序。' >&2
  exit 1
fi
mkdir -p "$CONFIG_DIR" "$HOME/.cpolar/bin" "$HOME/.cpolar/logs" "$HOME/Library/LaunchAgents"
chmod 700 "$CONFIG_DIR"
cp "$REPO_DIR/scripts/cpolar-tunnel.sh" "$HOME/.cpolar/bin/cpolar-tunnel.sh.new"
chmod 700 "$HOME/.cpolar/bin/cpolar-tunnel.sh.new"
mv "$HOME/.cpolar/bin/cpolar-tunnel.sh.new" "$HOME/.cpolar/bin/cpolar-tunnel.sh"

# 使用 Node 转义 shell 字符串和 XML，不能直接将 $HOME 放入 plist 期待展开。
"$NODE_BIN" - "$REPO_DIR" <<'NODE'
const fs = require('fs');
const path = require('path');
const [repo] = process.argv.slice(2);
const home = process.env.HOME;
const config = process.env.LISTEN_TOGETHER_CONFIG_DIR;
const conf = path.join(config, 'cpolar.conf');
const quote = (s) => "'" + s.replace(/'/g, "'\\''") + "'";
if (!fs.existsSync(conf)) {
  fs.writeFileSync(conf, ['APP_DIR', 'NODE_BIN', 'CPOLAR_BIN'].map((k) =>
    k + '=' + quote(process.env[k])).join('\n') + "\nPORT='3000'\n", { mode: 0o600 });
}
const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const template = fs.readFileSync(path.join(repo, 'scripts/org.listen-together.cpolar.plist'), 'utf8');
const rendered = template.replaceAll('__HOME__', xml(home)).replaceAll('__CONFIG_DIR__', xml(config));
fs.writeFileSync(path.join(home, 'Library/LaunchAgents/org.listen-together.cpolar.plist'), rendered, { mode: 0o600 });
NODE
PLIST="$HOME/Library/LaunchAgents/org.listen-together.cpolar.plist"
plutil -lint "$PLIST"
if [[ "$MODE" == '--no-load' ]]; then
  echo '已生成脚本与自启配置；尚未加载服务。'
  exit 0
fi

# 替换旧版个性化标识，防止同一隧道启动两次；旧配置保存在私人目录。
for legacy in "$HOME/Library/LaunchAgents/"*cpolar-listen-together.plist(N); do
  label=$(plutil -extract Label raw -o - "$legacy")
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  mkdir -p "$CONFIG_DIR/legacy-launchagents"
  mv "$legacy" "$CONFIG_DIR/legacy-launchagents/"
done
launchctl bootout "gui/$(id -u)/org.listen-together.cpolar" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo '已启用 org.listen-together.cpolar 自启服务。'

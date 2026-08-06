#!/bin/zsh
# cpolar 隧道守护脚本 —— 「一起听」项目
#
# 功能：
#   1. 启动 cpolar 隧道（listen-together -> 本地 3000 端口）
#   2. 隧道进程意外退出后自动重启（前 10 次间隔 5 秒，之后间隔 60 秒）
#   3. 由 macOS LaunchAgent 开机自启（见同目录的 plist 文件）
#
# 查看日志：tail -f ~/.cpolar/logs/cpolar-tunnel.log

CPOLAR_BIN="$HOME/.cpolar/bin/cpolar"
TUNNEL_NAME="listen-together"
LOG_FILE="$HOME/.cpolar/logs/cpolar-tunnel.log"
APP_DIR="/Users/peng/Documents/Codex/2026-08-04/wo-x/outputs/listen-together"

mkdir -p "$(dirname "$LOG_FILE")"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"
}

cleanup() {
  log "收到停止信号，正在退出..."
  if [[ -n "${child_pid:-}" ]] && kill -0 "$child_pid" 2>/dev/null; then
    kill "$child_pid" 2>/dev/null
  fi
  exit 0
}
trap cleanup TERM INT

if [[ ! -x "$CPOLAR_BIN" ]]; then
  log "错误：找不到 cpolar 可执行文件（$CPOLAR_BIN）"
  exit 1
fi

log "===== 守护脚本启动（隧道：$TUNNEL_NAME）====="

# 网页服务（node server.js）没在运行的话先拉起来，否则隧道通了也没东西可访问
if ! curl -s -o /dev/null --max-time 2 http://localhost:3000/; then
  log "网页服务未运行，正在后台启动..."
  cd "$APP_DIR" && nohup node server.js >> /tmp/listen-together.log 2>&1 &
  sleep 2
fi

fail_count=0
while true; do
  log "正在启动隧道：$TUNNEL_NAME"
  "$CPOLAR_BIN" start -log=stdout -log-level=INFO "$TUNNEL_NAME" >> "$LOG_FILE" 2>&1 &
  child_pid=$!
  wait "$child_pid"
  exit_code=$?
  unset child_pid

  if [[ "$exit_code" -eq 0 ]]; then
    fail_count=0
  else
    fail_count=$((fail_count + 1))
  fi

  if [[ "$fail_count" -ge 10 ]]; then
    delay=60
  else
    delay=5
  fi
  log "隧道进程退出（exit=$exit_code），${delay} 秒后自动重启"
  sleep "$delay"
done

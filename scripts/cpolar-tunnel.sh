#!/bin/zsh
# cpolar 隧道守护脚本 —— 「一起听」项目
#
# 功能：
#   1. 启动 cpolar 隧道（本地 3000 端口）
#   2. 隧道进程意外退出后自动重启（前 10 次间隔 5 秒，之后间隔 60 秒）
#   3. 由 macOS LaunchAgent 开机自启（见同目录的 plist 文件）
#
# 查看日志：tail -f ~/.cpolar/logs/cpolar-tunnel.log

CONFIG_DIR="${LISTEN_TOGETHER_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/listen-together}"
CPOLAR_CONFIG_FILE="${CPOLAR_CONFIG_FILE:-$CONFIG_DIR/cpolar.conf}"
if [[ -f "$CPOLAR_CONFIG_FILE" ]]; then
  source "$CPOLAR_CONFIG_FILE"
fi
CPOLAR_BIN="${CPOLAR_BIN:-$HOME/.cpolar/bin/cpolar}"
APP_DIR="${APP_DIR:-${0:A:h:h}}"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
PORT="${PORT:-3000}"
TUNNEL_ADDR="${TUNNEL_ADDR:-$PORT}"
LOG_FILE="${LOG_FILE:-$HOME/.cpolar/logs/cpolar-tunnel.log}"
SERVER_LOG_FILE="${SERVER_LOG_FILE:-$HOME/.cpolar/logs/server.log}"
export LISTEN_TOGETHER_CONFIG_DIR="$CONFIG_DIR"
mkdir -p "$(dirname "$LOG_FILE")" "$(dirname "$SERVER_LOG_FILE")"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"
}

ensure_server() {
  # 网页服务（node server.js）掉线就重新拉起，隧道通了才有东西可访问
  if curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/"; then
    return 0
  fi
  log "网页服务未运行，正在重启..."
  (
    cd "$APP_DIR" || exit 1
    PORT="$PORT" nohup "$NODE_BIN" server.js >> "$SERVER_LOG_FILE" 2>&1 &
  )
  # 等它真正监听成功，避免在启动窗口内重复拉起多个实例
  for i in 1 2 3 4 5 6 7 8; do
    sleep 1
    if curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/"; then
      return 0
    fi
  done
  log "网页服务启动后 8 秒内仍未就绪"
}

# 看门狗：隧道存活期间，网页服务掉线也能在 30 秒内被拉起来
watchdog() {
  while true; do
    sleep 30
    ensure_server
  done
}

cleanup() {
  log "收到停止信号，正在退出..."
  if [[ -n "${child_pid:-}" ]] && kill -0 "$child_pid" 2>/dev/null; then
    kill "$child_pid" 2>/dev/null
  fi
  if [[ -n "${watchdog_pid:-}" ]] && kill -0 "$watchdog_pid" 2>/dev/null; then
    kill "$watchdog_pid" 2>/dev/null
  fi
  exit 0
}
trap cleanup TERM INT

if [[ ! -x "$CPOLAR_BIN" ]]; then
  log "错误：找不到 cpolar 可执行文件（$CPOLAR_BIN）"
  exit 1
fi

if [[ ! -f "$APP_DIR/server.js" || ! -x "$NODE_BIN" ]]; then
  log "错误：请检查 APP_DIR 和 NODE_BIN 本地配置"
  exit 1
fi

log "===== 守护脚本启动（隧道：http $TUNNEL_ADDR）====="

ensure_server
watchdog &
watchdog_pid=$!

fail_count=0
while true; do
  ensure_server
  log "正在启动隧道：http $TUNNEL_ADDR"
  "$CPOLAR_BIN" http "$TUNNEL_ADDR" -log=stdout -log-level=INFO >> "$LOG_FILE" 2>&1 &
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

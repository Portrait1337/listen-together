#!/bin/bash
# 一起听 - 一键部署到云服务器
# 用法: ./deploy.sh user@服务器IP
set -euo pipefail

SERVER="${1:?用法: ./deploy.sh user@服务器IP}"
LOCAL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="/opt/listen-together"
REMOTE_USER="$(ssh "$SERVER" 'whoami')"

echo "==> 1/4 同步项目文件到服务器"
rsync -az --delete -e ssh \
  --exclude node_modules --exclude uploads --exclude library --exclude .git --exclude '.DS_Store' \
  "$LOCAL_DIR/" "$SERVER:/tmp/listen-together/"

echo "==> 2/4 安装依赖（服务器需已装 Node.js 18+）"
ssh "$SERVER" "sudo mkdir -p '$APP_DIR' && sudo rsync -a --delete --exclude uploads --exclude library /tmp/listen-together/ '$APP_DIR/' && cd '$APP_DIR' && npm install --omit=dev && sudo chown -R '$REMOTE_USER' '$APP_DIR'"

echo "==> 3/4 安装并启动 systemd 服务（开机自启）"
sed "s/__USER__/$REMOTE_USER/" "$LOCAL_DIR/deploy/listen-together.service" > /tmp/listen-together.service
scp /tmp/listen-together.service "$SERVER:/tmp/listen-together.service"
ssh "$SERVER" "sudo cp /tmp/listen-together.service /etc/systemd/system/listen-together.service && sudo systemctl daemon-reload && sudo systemctl enable --now listen-together"

echo "==> 4/4 检查服务状态"
sleep 2
ssh "$SERVER" "systemctl is-active listen-together && curl -s -o /dev/null -w '服务器本机访问: HTTP %{http_code}\n' http://localhost:3000/"

IP="${SERVER#*@}"
echo ""
echo "部署完成！公网访问：http://$IP:3000"
echo "如果打不开，记得在云控制台的防火墙/安全组里放行 TCP 3000 端口。"

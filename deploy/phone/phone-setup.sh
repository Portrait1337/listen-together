#!/data/data/com.termux/files/usr/bin/bash
# 一起听 - Termux 一键配置脚本（在旧手机上运行）
# 用法：解压部署包后，在 Termux 里执行  bash phone-setup.sh
# 注意：需要运行两次（第一次装依赖，第二次配置服务）

PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
APP_DIR="$HOME/listen-together"

echo "========== 一起听 · Termux 部署脚本 =========="

# ---------- 阶段一：安装依赖 ----------
if ! command -v sv >/dev/null 2>&1; then
  echo "[1/2] 安装运行环境（需要联网，约几分钟）..."
  pkg update -y && pkg upgrade -y
  pkg install -y nodejs-lts openssh termux-services termux-api iproute2
  echo ""
  echo "依赖安装完成。"
  echo "请【完全关闭 Termux】（从最近任务里划掉），重新打开后再次执行："
  echo "  bash ~/phone-setup.sh"
  exit 0
fi

# ---------- 阶段二：配置服务 ----------
if [[ ! -d "$APP_DIR" ]]; then
  echo "错误：找不到项目目录 $APP_DIR"
  echo "请先解压部署包：  unzip phone-部署包.zip -d ~/"
  exit 1
fi

cd "$APP_DIR" || exit 1

echo "[1/3] 安装项目依赖..."
npm install --omit=dev

echo "[2/3] 注册常驻服务（进程挂了自动重启）..."
mkdir -p "$PREFIX/var/service/listen-together"
cat > "$PREFIX/var/service/listen-together/run" <<EOF
#!/data/data/com.termux/files/usr/bin/sh
exec $PREFIX/bin/node $APP_DIR/server.js
EOF
chmod +x "$PREFIX/var/service/listen-together/run"
sv-enable listen-together 2>/dev/null
sv up listen-together

echo "[3/3] 配置开机自启 + 防休眠..."
mkdir -p "$HOME/.termux/boot"
cat > "$HOME/.termux/boot/start-services" <<EOF
#!/data/data/com.termux/files/usr/bin/sh
termux-wake-lock
sv-enable listen-together 2>/dev/null
sv up listen-together
EOF
chmod +x "$HOME/.termux/boot/start-services"
termux-wake-lock

sleep 2
PHONE_IP="$(ip -4 addr show wlan0 2>/dev/null | grep -oE 'inet [0-9.]+' | cut -d' ' -f2 | head -1)"

echo ""
echo "========== 配置完成 =========="
echo "手机局域网 IP：${PHONE_IP:-未知}"
echo ""
echo "验证方法："
echo "  1. 手机浏览器打开  http://localhost:3000  应看到「一起听」页面"
echo "  2. 同一 WiFi 下的其他设备打开  http://${PHONE_IP:-手机IP}:3000"
echo ""
echo "别忘了在手机系统设置里（必做）："
echo "  1. 关闭 Termux 的电池优化（设置→应用→Termux→电池→不限制）"
echo "  2. WiFi 设为永不休眠"
echo "  3. 多任务界面把 Termux 下拉锁定"
echo "  4. 重启一次手机，确认服务自动恢复"

#!/data/data/com.termux/files/usr/bin/bash
# 一起听 - DNSPod DDNS 更新脚本（在手机上定时运行）
# 作用：检测公网 IP 变化，自动更新本地配置指定域名的 A 记录。
# 私人配置与发布代码分开，定时任务仍使用本脚本。

CONFIG_DIR="${LISTEN_TOGETHER_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/listen-together}"
DNSPOD_CONFIG_FILE="${DNSPOD_CONFIG_FILE:-$CONFIG_DIR/ddns.conf}"
if [ -f "$DNSPOD_CONFIG_FILE" ]; then
  . "$DNSPOD_CONFIG_FILE"
fi
DOMAIN="${DNSPOD_DOMAIN:-${DOMAIN:-}}"
SUB_DOMAIN="${DNSPOD_SUB_DOMAIN-${SUB_DOMAIN:-}}"
ID="${DNSPOD_ID:-${ID:-}}"
TOKEN="${DNSPOD_TOKEN:-${TOKEN:-}}"
if [ -z "$DOMAIN" ] || [ -z "$ID" ] || [ -z "$TOKEN" ] ||
   [[ "$ID" == *你的* ]] || [[ "$TOKEN" == *你的* ]]; then
  echo "缺少 DDNS 配置：请配置本地 ddns.conf 或 DNSPOD_* 环境变量" >&2
  exit 1
fi

IP_URL="https://ipinfo.io/ip"
API="https://dnsapi.cn"

CUR_IP=$(curl -s --max-time 8 "$IP_URL")
if [ -z "$CUR_IP" ]; then
  echo "$(date '+%F %T') 获取公网 IP 失败"
  exit 1
fi

# 查询现有 A 记录
LIST=$(curl -s -X POST "$API/Record.List" \
  -d "login_token=$ID,$TOKEN&format=json&domain=$DOMAIN&sub_domain=$SUB_DOMAIN")
RID=$(echo "$LIST" | jq -r '.records[]? | select(.type=="A") | .id' | head -1)
OLD_IP=$(echo "$LIST" | jq -r --arg r "$RID" '.records[]? | select(.id==$r) | .value')

if [ -n "$RID" ] && [ "$CUR_IP" = "$OLD_IP" ]; then
  echo "$(date '+%F %T') IP 未变化：$CUR_IP"
  exit 0
fi

# 有记录就修改，没有就新建
if [ -n "$RID" ]; then
  RES=$(curl -s -X POST "$API/Record.Modify" \
    -d "login_token=$ID,$TOKEN&format=json&domain=$DOMAIN&record_id=$RID&record_type=A&record_line=默认&value=$CUR_IP&sub_domain=$SUB_DOMAIN")
else
  RES=$(curl -s -X POST "$API/Record.Create" \
    -d "login_token=$ID,$TOKEN&format=json&domain=$DOMAIN&record_type=A&record_line=默认&value=$CUR_IP&sub_domain=$SUB_DOMAIN")
fi

echo "$RES" | jq -r '"'"$(date '+%F %T')"' " + (if .status.code=="1" then "更新成功 → "+(.record.value // .value // "") else "更新失败："+(.status.message // "未知错误") end)'

# ---------- 定时任务（每 5 分钟检查一次）----------
# 执行：crontab -e
# 添加：
# */5 * * * * bash ~/ddns/ddnspod-update.sh >> ~/ddns/ddns.log 2>&1
# 保存后确认 cron 在跑：sv-enable crond && sv up crond

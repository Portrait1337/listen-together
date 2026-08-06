# cpolar 隧道开机自启（一起听项目）

## 文件说明

- `cpolar-tunnel.sh`：守护脚本，启动 cpolar 隧道并在退出后自动重启
- `com.peng.cpolar-listen-together.plist`：macOS 开机自启配置（LaunchAgent）

实际运行时，脚本会被安装到 `~/.cpolar/bin/cpolar-tunnel.sh`（cpolar 程序也复制到了 `~/.cpolar/bin/cpolar`）。
这是因为 macOS 对"文稿"文件夹有隐私保护，后台自启任务无法读取放在那里的文件。

## 日常使用

```bash
# 查看隧道日志（含公网地址）
tail -f ~/.cpolar/logs/cpolar-tunnel.log

# 只看当前公网地址
grep 'Tunnel established' ~/.cpolar/logs/cpolar-tunnel.log | tail -1

# 立即停止/启动自启任务
launchctl bootout gui/$(id -u)/com.peng.cpolar-listen-together
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.peng.cpolar-listen-together.plist

# 彻底卸载（删除自启配置）
launchctl bootout gui/$(id -u)/com.peng.cpolar-listen-together
rm ~/Library/LaunchAgents/com.peng.cpolar-listen-together.plist
```

注意：守护脚本启动时如果检测到 `一起听` 网页服务（3000 端口）没在运行，会自动把它拉起来
（日志：`/tmp/listen-together.log`），所以电脑开机后不用手动操作。

如果只是临时想停掉网页服务，可以执行：`pkill -f "node server.js"`，隧道会照常运行但访问会失败。

免费版限制：隧道每次重连（比如重启电脑）会重新分配随机地址，需要把新地址重新发给群友。
想要固定地址，升级 cpolar 基础版（99 元/年，保留 3 个子域名）或专业版（自定义域名）即可。

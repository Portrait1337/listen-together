# macOS cpolar 隧道与手机部署包

## cpolar 开机自启

先准备 Node.js、项目依赖和已配置的 cpolar。以下命令在项目根目录执行：

```bash
CPOLAR_BIN="$HOME/.cpolar/bin/cpolar" zsh scripts/install-cpolar.sh
```

安装器会把守护脚本放到 `~/.cpolar/bin/`，生成当前用户的绝对路径，并注册通用标识 `org.listen-together.cpolar`。首次安装把项目目录、Node 和 cpolar 路径写入用户私人配置目录的 `cpolar.conf`；已有配置不会覆盖。需要指定其他程序路径时，通过 `APP_DIR`、`NODE_BIN`、`CPOLAR_BIN` 提供首次安装值。

默认私人目录为 `${XDG_CONFIG_HOME:-$HOME/.config}/listen-together`，可用 `LISTEN_TOGETHER_CONFIG_DIR` 指定。LaunchAgent 会记录该目录，登录自启时仍能找到配置。生成的 plist 只存在本机用户目录，仓库中的 `org.listen-together.cpolar.plist` 是待安装器填充的模板。

```bash
# 先生成本地文件供检查，暂不加载 LaunchAgent
zsh scripts/install-cpolar.sh --no-load

# 查看配置（本机路径不应复制到公开文档）
# $LISTEN_TOGETHER_CONFIG_DIR/cpolar.conf，未设置变量时见上面的默认目录

# 查看隧道和网页服务日志
tail -f "$HOME/.cpolar/logs/cpolar-tunnel.log"
tail -f "$HOME/.cpolar/logs/server.log"

# 停止或启动服务
launchctl bootout "gui/$(id -u)/org.listen-together.cpolar"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/org.listen-together.cpolar.plist"
```

`cpolar.conf` 可配置 `APP_DIR`、`NODE_BIN`、`CPOLAR_BIN`、`PORT`（默认 `3000`）、`TUNNEL_ADDR`（默认跟随 `PORT`）、`LOG_FILE` 和 `SERVER_LOG_FILE`。运行配置是本机 shell 文件，请只保存自己信任的配置内容。守护脚本检查网页服务，必要时启动 `server.js`，并在隧道退出后重试。

已有旧版自启服务时，正常安装会停止旧标识，将旧 plist 移入私人目录的 `legacy-launchagents/`，再加载通用标识；隧道会因此重新连接。`--no-load` 仅生成文件，不迁移旧服务；检查后应运行一次正常安装，避免下次登录同时加载新旧配置。

## 生成手机部署包

安装系统 `zip` 命令后，在项目根目录执行：

```bash
node scripts/build-phone-package.js
```

默认输出 `deploy/phone-部署包.zip`，也可在命令后指定其他输出路径。脚本按发布文件清单重新生成压缩包，包含当前运行代码、页面资源、安装说明和配置样例；不包含真实凭据、私人笔记、音频文件、依赖目录或 Git 记录。

手机安装步骤见 [安装说明](../deploy/phone/安装说明.txt)，DDNS 配置见 [DDNS 说明](../deploy/phone/DDNS配置说明.txt)。

`scripts/migrate-uploads-cos.js` 是已有上传文件的可选转存工具，运行前需先配置 COS；它不删除本地音频，也不自动重写房间歌单。

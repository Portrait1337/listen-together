# 一起听 · Listen Together

和朋友在同一个房间里听同一首歌、共享播放进度，边听边聊。

「一起听」是一个面向小圈子朋友的网页共听原型。无需安装客户端或注册账号，填写昵称即可创建或加入房间；所有成员共同维护歌单，也都能控制播放。音频可来自用户上传、服务器本地曲库，或网易云与咪咕在线搜索。

## 项目目标与范围

项目围绕一条使用流程展开：**创建房间 → 分享房间码 → 添加音频 → 同步播放与聊天**。

| 核心需求 | 当前实现 |
| --- | --- |
| 低门槛邀请朋友 | 6 位房间码；支持通过 `?room=房间码` 预填加入信息 |
| 一起决定听什么 | 所有成员都能添加、删除和选择歌曲，共享一份房间歌单 |
| 听到相近的播放进度 | 播放、暂停、切歌、拖动进度和播放模式通过 WebSocket 同步；客户端校准时钟并按策略纠偏 |
| 提供多种音频来源 | 上传音频、搜索本地曲库、搜索网易云或咪咕 |
| 边听边聊 | 实时聊天，保留最近 100 条消息，支持撤回 |
| 适应手机浏览器 | 自动重连、断线宽限、FLAC 时长解析和播放对齐处理；自动播放受限时提供点击解锁入口 |

项目保持单进程、无数据库、无前端构建步骤。**房间、歌单和聊天记录只保存在服务端内存中，重启后消失。** 当前没有账号、房主权限或内容审核；昵称用于显示，也用于消息撤回判断，不代表经过验证的身份。

## 快速开始

代码要求 Node.js 18+，使用 npm 安装依赖。以下命令均在项目根目录执行：

```bash
npm install
npm start
```

浏览器打开 [http://localhost:3000](http://localhost:3000)。无需配置在线音乐账号或 COS，即可使用上传、本地曲库和房间功能。

需要更换端口时，在 macOS / Linux 终端执行：

```bash
PORT=8080 npm start
```

### 和朋友一起使用

1. 填写昵称，点击「创建房间」。
2. 把访问地址和 6 位房间码发给朋友。朋友打开网页、填写昵称和房间码，点击「加入房间」。也可分享 `http://你的访问地址/?room=ABC234` 形式的链接，预填房间码。
3. 点击「上传音频」，或在「在线音乐」「本地曲库」中搜索并添加歌曲。
4. 第一首歌加入后，房间状态会自动切换为播放。设备提示「点击开始听」时，点击一次以允许浏览器播放声音。
5. 任意成员都能播放、暂停、切歌、拖进度、切换播放模式或删除歌曲；在聊天区发送消息，长按自己的消息可显示撤回操作，桌面端也可右键。

同一局域网内，其他设备访问 `http://运行服务的设备局域网IP:3000`。异地使用需要可从公网访问的服务地址，部署方式见下文。

## 音频来源与播放行为

### 上传音频

- 单文件最大 **200 MiB（200 × 1024 × 1024 字节）**，扩展名支持 `.mp3`、`.wav`、`.m4a`、`.aac`、`.ogg`、`.flac`、`.opus`、`.wma`、`.amr`。
- 服务端校验扩展名和文件头；上传格式被接受，不代表所有浏览器都能解码该格式。
- 默认保存到 `uploads/`；配置腾讯云 COS 后，新上传文件转存云端，再删除本地中转文件。
- 上传 FLAC 时解析 STREAMINFO 中的时长，用于改善 iOS / 微信流式播放的进度显示。

### 本地曲库

把自行准备的音频放入 `library/`，可按子目录分类。服务启动时自动创建目录并建立索引，之后默认每 30 秒刷新；房间内切换到「本地曲库」，输入文件名关键词搜索并添加。搜索结果每次最多返回 20 条；搜索接口支持空关键词查询，页面在未输入关键词时隐藏结果。

曲库文件由部署者维护，不随房间销毁自动删除。在线下载缓存单独放在 `online-cache/`，不会出现在本地曲库搜索结果中。

### 在线音乐

- 页面提供网易云、咪咕来源切换，搜索结果每页 20 条，可继续加载；服务端也支持双源聚合搜索，聚合时按歌名与歌手去重、咪咕优先。
- 普通歌曲添加时先下载到 `online-cache/`，再通过本站地址供房间成员播放；在线下载默认最大 50 MiB。
- 网易云免费外链不可用时，依次尝试已配置 Cookie 的会员播放地址、咪咕匹配换源。换源不保证成功。
- 在线来源依赖第三方接口，搜索有结果不代表一定可播放；接口错误、版权或会员限制都可能导致添加失败。

### 同步、重连与聊天

服务端维护房间的曲目、播放状态、进度和更新时间，客户端据此计算目标进度并播放音频。音频通过 HTTP / COS / 音乐 CDN 获取，WebSocket 负责状态与消息同步。

- 支持顺序、随机和单曲循环模式；删除当前曲目时自动选择后续曲目，删空歌单后停止播放。
- 自动纠偏采用偏差阈值和冷却时间，移动端落后纠偏另有次数限制，以减少反复跳转和重新缓冲。
- 断线后客户端自动尝试重连，服务端默认保留成员 15 秒；同昵称在宽限期内重连可减少成员进出提示闪烁。主动退出立即移除。
- 新成员收到最近 100 条聊天历史；单条消息最多 200 字符。撤回权限按昵称判断，同昵称的连接也能撤回对应消息。

同步效果受网络缓冲、设备解码和浏览器后台策略影响；项目未提供固定毫秒级的同步精度保证。

## 数据保存与自动清理

| 数据 | 保存位置 | 清理行为 |
| --- | --- | --- |
| 房间、歌单、聊天、成员、播放状态 | 服务端进程内存 | 服务重启即丢失；无人房间按超时销毁 |
| 用户上传 | `uploads/`，或配置后的 COS 桶 | 本地文件无房间歌单引用且文件年龄达到默认 1 小时后，可被清理；启动时及每 6 小时检查 |
| 本地曲库 | `library/` | 应用不自动删除 |
| 在线下载缓存 | `online-cache/` | 无房间歌单引用且文件年龄达到默认 24 小时后可被清理，每小时检查 |
| 网易云会员播放地址 | 内存短期缓存 | 缓存 10 分钟，播放通过本站接口 307 跳转到 CDN，不保存会员音频文件 |
| 本进程转存的 COS 对象 | COS 桶 | 默认每小时回收不再被房间歌单引用的对象；进程重启后不再追踪之前的对象 |

房间在成员全部移除后开始计时：歌单和聊天历史均为空时，默认保留 30 秒；至少有一项非空时，默认保留 3 分钟。断线成员须先经过宽限期；使用上传接口查询参数标记的进行中上传会暂停房间销毁倒计时。

重启服务会丢失歌单对音频文件的引用，磁盘文件仍受上述回收规则管理。COS 的跨重启对象保留策略需另行通过桶生命周期配置。

## 可选配置

项目直接读取进程环境变量和指定配置文件，**没有自动加载 `.env` 文件**。私人配置默认保存在项目外的 `${XDG_CONFIG_HOME:-$HOME/.config}/listen-together`，可通过 `LISTEN_TOGETHER_CONFIG_DIR` 指定其他目录。

配置文件查找顺序为：单文件环境变量指定路径 → 私人目录中已有的对应文件 → 旧版项目根目录文件。`NETEASE_COOKIE` 内容仍优先于 Cookie 文件。私人目录设为 `700`、凭据文件设为 `600`；公开发布只提供配置样例。

### 腾讯云 COS

```bash
CONFIG_DIR="${LISTEN_TOGETHER_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/listen-together}"
mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"
# 首次配置时执行；已有配置文件时请直接编辑
cp -n cos-config.example.json "$CONFIG_DIR/cos-config.json"
chmod 600 "$CONFIG_DIR/cos-config.json"
```

编辑私人目录中的 `cos-config.json`：

| 字段 | 用途 |
| --- | --- |
| `bucket` | 桶名称，包含 APPID 后缀 |
| `region` | 桶所在地域 |
| `secretId` / `secretKey` | 服务端访问凭据 |
| `cdnBaseUrl` | 可选的 CDN 访问地址；留空使用 COS 默认域名 |

配置对象的读取权限或 CDN 访问方式，使浏览器能直接读取生成的音频 URL；当前实现不生成私有对象签名链接。服务端凭据需具备上传与删除对象所需权限。

未启用 COS 时使用本地上传存储；**启用后转存失败会返回上传错误，不会回退本地播放。** 此配置只改变新上传音频的存储方式，本地曲库和在线缓存仍由服务端提供。

### 网易云会员播放

将登录 Cookie 写入私人目录的 `netease-cookie.txt`，或通过 `NETEASE_COOKIE` 环境变量提供，环境变量优先。代码会在服务端请求播放地址，不把 Cookie 下发给浏览器。

服务启动时校验登录态，之后约每 10 分钟复查；默认每 30 秒检查一次 Cookie 配置变化，文件更新后会重新校验。是否能播放取决于账号权限及第三方接口响应，失效后需更新 Cookie。

旧版根目录中的 `cos-config.json`、`netease-cookie.txt`、`cookie-*.txt` 副本与三个音频目录均在 `.gitignore` 中排除。迁移已有部署时，可用本地兼容链接保留旧进程的读取路径；发布包按文件清单生成，不复制这些链接或凭据。

### 环境变量速查

所有以 `_MS` 结尾的配置均以**毫秒**为单位。目录变量支持绝对路径；相对路径按进程工作目录解析，未设置时使用项目根目录下的默认位置。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP 与 WebSocket 共用端口 |
| `LISTEN_TOGETHER_CONFIG_DIR` | 用户配置目录下的 `listen-together/` | 私人配置目录；默认用户配置基目录可由 `XDG_CONFIG_HOME` 覆盖 |
| `UPLOAD_DIR` / `LIBRARY_DIR` / `ONLINE_DIR` | `uploads/` / `library/` / `online-cache/` | 上传、曲库和在线缓存目录 |
| `EMPTY_ROOM_TTL_MS` / `ACTIVE_ROOM_TTL_MS` | `30000` / `180000` | 无人房间的保留时间 |
| `MEMBER_GRACE_MS` | `15000` | 断线成员宽限期，设为 `0` 可禁用 |
| `LIBRARY_INDEX_REFRESH_MS` | `30000` | 本地曲库索引刷新间隔 |
| `ORPHAN_UPLOAD_TTL_MS` | `3600000` | 本地孤儿上传文件的年龄门槛 |
| `WS_HEARTBEAT_MS` / `WS_HEARTBEAT_MAX_MISSED` | `30000` / `10` | 心跳间隔、无响应容忍轮数 |
| `MAX_WS_CONNECTIONS` / `MAX_WS_MSGS_PER_SECOND` | `100` / `20` | 单实例连接上限、每连接每秒消息上限 |
| `MAX_CONCURRENT_UPLOADS_PER_IP` / `MAX_UPLOADS_PER_MINUTE_PER_IP` | `2` / `10` | 每 IP 上传并发、每分钟上传频次 |
| `ONLINE_RATE_WINDOW_MS` / `ONLINE_RATE_MAX` | `10000` / `10` | 每 IP 在线接口共享限流窗口与请求数 |
| `ONLINE_MAX_CONCURRENT_SEARCHES` / `ONLINE_MAX_CONCURRENT_DOWNLOADS` | `5` / `3` | 单实例在线搜索、下载并发上限 |
| `ONLINE_CACHE_TTL_MS` | `60000` | 在线搜索结果缓存时间 |
| `ONLINE_DOWNLOAD_TIMEOUT_MS` / `ONLINE_MAX_SIZE` | `30000` / `52428800` | 在线下载响应等待超时、文件大小上限（字节） |
| `ONLINE_FILE_TTL_MS` / `ONLINE_CLEAN_INTERVAL_MS` | `86400000` / `3600000` | 在线孤儿缓存文件的年龄门槛、检查间隔 |
| `COS_CONFIG_FILE` / `COS_CLEAN_INTERVAL_MS` | 按上述顺序查找 / `3600000` | COS 配置文件、孤儿对象检查间隔 |
| `NETEASE_COOKIE` / `NETEASE_COOKIE_FILE` | 未设置 / 按上述顺序查找 | 网易云 Cookie 内容、文件位置 |
| `NETEASE_VIP_REFRESH_MS` | `30000` | Cookie 变化检查轮询间隔；登录态常规复查仍约为 10 分钟 |
| `NETEASE_BASE` / `MIGU_BASE` | `https://music.163.com` / `https://app.pd.nf.migu.cn` | 在线提供者接口地址，测试可覆盖为桩服务 |
| `ONLINE_AUDIO_HOSTS` | 无额外域名 | 扩展下载域名白名单，逗号分隔；不替换内置规则 |
| `SINGLE_LOOP_DEDUP_MS` | `1500` | 单曲循环结束信号去重窗口 |

多数数值配置使用正数；除明确支持的 `MEMBER_GRACE_MS=0` 外，不应通过填 `0` 表示禁用。

## 部署与访问

| 场景 | 仓库提供的入口 | 使用条件 |
| --- | --- | --- |
| 本机或局域网体验 | `npm start` | 运行设备在线，其他设备能访问服务端口 |
| 临时公网分享 | 安装 `cloudflared` 后运行 `cloudflared tunnel --url http://localhost:3000` | 本机服务与隧道持续运行 |
| Linux 云服务器 | [部署脚本与说明](deploy/README.md)、[systemd 模板](deploy/listen-together.service) | SSH、sudo、rsync、systemd 与 Node.js 环境；模板默认使用 `/usr/bin/node` |
| Android 手机自托管 | [安装说明](deploy/phone/安装说明.txt)、[配置脚本](deploy/phone/phone-setup.sh) | Termux 环境，公网访问另需隧道或路由器映射 |
| macOS 常驻隧道 | [cpolar 脚本说明](scripts/README.md) | 检查脚本路径、端口和 LaunchAgent 配置，按实际安装位置调整 |
| 路由器与 DDNS | [公网配置说明](deploy/router-公网IP配置.md)、[DDNS 说明](deploy/phone/DDNS配置说明.txt) | 具备相应网络条件与路由器配置权限 |

云服务器部署命令：

```bash
./deploy/deploy.sh 用户名@服务器IP
```

脚本将代码部署到 `/opt/listen-together`，保留服务器的 `uploads/`、`library/` 和 `online-cache/` 目录，并启用 `listen-together` 服务。首次安装会启动服务；更新已有运行实例后，还需重启进程使新代码生效：

```bash
sudo systemctl restart listen-together
```

部署脚本按 `.gitignore` 排除本地凭据和音频目录，不再随代码同步真实配置；目标设备需单独配置 COS 与 Cookie，原有目标配置会保留。手机 ZIP 包通过 `node scripts/build-phone-package.js` 按明确的文件清单生成，包含当前代码与配置样例。

配置反向代理时需同时转发 HTTP 和 `/ws` 的 WebSocket Upgrade；HTTPS 页面对应使用 `wss://`。应用目前只信任本机回环代理提供的客户端 IP 信息，异机代理部署需检查限流取 IP 的方式。以上是仓库支持的部署入口，不代表某个公网实例当前在线。

## 代码结构与开发

后端使用 CommonJS、Express、`ws` 和 Multer，前端是原生 HTML / CSS / JavaScript，无打包器。

```text
.
├── server.js                 # 静态服务、REST API、房间状态、WebSocket、定时清理
├── online.js                 # 网易云 / 咪咕搜索、下载、换源、会员地址解析
├── cos.js                    # COS 配置、上传和本进程孤儿对象回收
├── config-paths.js           # 私人配置路径查找与旧部署兼容
├── flac.js                   # FLAC STREAMINFO 时长解析
├── public/
│   ├── index.html            # 首页和房间页面
│   ├── app.js                # 播放器、交互、重连与聊天
│   ├── styles.css            # 页面样式
│   └── sync-policy.js        # 浏览器和测试共用的同步纠偏策略
├── test/                     # Node.js 测试与集成场景
├── docs/                     # 产品介绍、功能规格与实现计划
├── deploy/                   # 云服务器、手机、路由器部署资料
├── scripts/                  # cpolar 守护脚本、上传转存工具
├── cos-config.example.json   # COS 配置样例
└── AGENTS.md                 # 项目开发约定
```

运行时自动创建 `uploads/`、`library/`、`online-cache/`，这些目录不入库。

### 接口入口

| 接口 | 用途 |
| --- | --- |
| `POST /api/upload?roomId=房间码` | 上传音频；`multipart/form-data` 字段为 `file`、`roomId`、`nickname`；查询参数用于上传期间保护房间 |
| `GET /api/library/search?q=关键词` | 搜索服务器本地曲库 |
| `POST /api/library/add` | 添加本地曲目，JSON 字段为 `roomId`、`trackId`、`nickname` |
| `GET /api/online/search?q=关键词&source=netease&offset=0` | 在线搜索；来源可选 `netease`、`migu`、`all` |
| `POST /api/online/add` | 添加在线曲目，JSON 字段为 `roomId`、`trackId`、`name`、`artist`、`nickname` |
| `GET /api/online/stream?trackId=netease:歌曲ID` | 获取会员播放地址并 307 跳转 |
| `WS /ws` | 创建 / 加入 / 退出房间、播放控制、聊天与状态广播 |

WebSocket 消息格式和房间状态以 [server.js](server.js) 为准，前端调用见 [public/app.js](public/app.js)。接口未配置账号鉴权，限流和连接上限不构成成员权限管理。

### 测试与修改约定

```bash
node --test
```

`package.json` 仅配置了 `start`，没有 `npm test` 或构建命令。测试覆盖同步策略、房间生命周期、聊天与撤回、歌单、上传校验与限流、FLAC、在线音乐、会员播放、COS 和 WebSocket 防护；在线与 COS 相关测试使用桩服务或模拟客户端，不代表真实第三方服务当前可用。

修改同步逻辑时，优先将策略放入 `public/sync-policy.js` 并补充相应测试。修改前端资源后同步更新 `public/index.html` 中对应的版本查询参数，避免长期缓存继续提供旧资源。交付前运行测试，并用 `npm start` 验证创建 / 加入房间、添加音频、同步控制和聊天。

私人配置与发布约定见 [配置设计说明](docs/superpowers/specs/2026-10-16-private-config-design.md)。开发规则见 [AGENTS.md](AGENTS.md)。[功能规格](docs/superpowers/specs/)与[实现计划](docs/superpowers/plans/)保留了设计过程，部分状态描述属于历史记录；判断当前能力时以运行代码与测试为准。

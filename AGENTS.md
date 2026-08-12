# AGENTS.md

「一起听」：群友同步听音频的网页原型。创建房间 → 上传或搜索曲库 → 全房间同步播放 + 聊天。

## 常用命令

- 安装依赖：`npm install`
- 本地启动：`npm start`（可用 `PORT` 环境变量改端口）
- 运行测试：`node --test`（package.json 未配置 `npm test`；测试用 node:test 编写）
- 公网测试：`cloudflared tunnel --url http://localhost:3000`

## 代码结构

- `server.js` — 后端入口：Express 静态服务 + REST API + WebSocket 同步。房间、歌单、聊天历史都存在内存里，重启即清空。
- `online.js` — 在线音乐提供者（网易云 + 咪咕）：统一搜索、下载、双源自动换源；第三方地址用环境变量可配。
- 网易云会员播放：`netease-cookie.txt`（已 gitignore）或环境变量 `NETEASE_COOKIE` 配置会员 Cookie；会员歌走 `/api/online/stream` 流式播放，不落盘。
- `public/` — 前端，原生 JS，无框架、无构建步骤：
  - `index.html` / `app.js` / `styles.css` — 页面主体
  - `sync-policy.js` — UMD 模块，播放同步自动纠偏策略，浏览器和测试共用
- `test/` — node:test 测试：单元测试（sync-policy）+ 集成测试（房间清理、聊天历史）。集成测试会真实启动 server.js，用 `EMPTY_ROOM_TTL_MS` / `ACTIVE_ROOM_TTL_MS` 环境变量缩短超时。
- `docs/superpowers/specs/` — 功能设计文档
- `deploy/` — 云服务器部署：systemd 服务 + deploy.sh
- `scripts/` — macOS 本机 cpolar 隧道开机自启（launchd）
- `uploads/`、`library/` — 上传文件和本地曲库，已被 .gitignore 排除，不入库

## 运行时关键行为

- 房间生命周期：全新空房间 30 秒销毁，播放过/加过歌/聊过天的房间 3 分钟销毁；正在上传歌曲的房间会等上传结束后再计时。默认值可用环境变量覆盖。
- 聊天历史：每个房间在内存中保留最近 100 条，新成员进房时先收到 `chat_history` 再收到房间状态。
- 上传：单文件 200MB 以内，只收音频（扩展名白名单 + 文件头 magic bytes 双重校验）。可选腾讯云 COS 转存（`cos-config.json`，已 gitignore；未配置自动回退本地存储）：转存成功即删本地中转文件，对象 key 为 96 位随机不可枚举；本进程上传的 COS 对象每小时回收无人引用的（`COS_CLEAN_INTERVAL_MS`，`cos.js` 的 `cleanupOrphans`），重启后保守不删，建议桶级生命周期规则兜底；FLAC 上传时解析 STREAMINFO 存权威时长（`flac.js`）。
- 防滥用：上传按真实 IP 限流（并发 2 / 每分钟 10 次，只信任本机隧道写入的 X-Forwarded-For）；WebSocket 有连接数上限（默认 100）、每连接消息节流（默认 20 条/秒）、单条消息 64KB 上限、心跳清理死连接（默认 30 秒一轮、连续 10 轮约 5 分钟无响应断开，`WS_HEARTBEAT_MS` / `WS_HEARTBEAT_MAX_MISSED` 可配）；连接断开后有成员宽限期（默认 15 秒，`MEMBER_GRACE_MS` 可配，设 0 可禁用）——宽限期内同昵称重连不广播离开/加入，避免 iPhone 锁屏切后台的成员闪烁；在线搜索/添加/播放按 IP 限速（默认 10 次/10 秒），搜索与下载各有并发上限（默认 5 / 3，`ONLINE_MAX_CONCURRENT_SEARCHES` / `ONLINE_MAX_CONCURRENT_DOWNLOADS`）。
- 在线歌曲：下载文件缓存复用（`onlineFiles` 内存表，上限 500 条）；缓存指向的文件被外部删除时会自动失效并重新下载，不会崩溃；换源下载的歌曲 id 有字符集校验，防路径穿越；并发下载上限默认 3（`ONLINE_MAX_CONCURRENT_DOWNLOADS`）；无人引用的下载文件默认 24 小时后清理（`ONLINE_FILE_TTL_MS`，清理间隔 `ONLINE_CLEAN_INTERVAL_MS`），在线歌曲是缓存性质可随时重新下载。
- 上传/曲库目录可用环境变量覆盖：`UPLOAD_DIR` / `LIBRARY_DIR`（测试用临时目录，避免污染真实数据）；在线音乐缓存独立存放于 `online-cache/`（可用 `ONLINE_DIR` 覆盖），不混入曲库搜索，旧版 `library/online` 缓存启动时自动迁移。

## 约定

- 代码注释、界面文案、commit 信息一律用中文；commit 风格参考历史：`修复：xxx`、`新增 xxx`、`体验优化：xxx`。
- 后端用 CommonJS（require），Node 18+。
- 前端直接改 `public/`，不要引入打包器或框架。
- 改了行为后同步更新 README.md 和 `docs/` 里相关的设计文档。
- 新增或改动同步逻辑时，策略先写进 `sync-policy.js` 并补测试。

## 注意

- 数据在内存里，重启后房间、歌单、聊天历史都会消失——这是原型预期，不要擅自引入数据库。
- 曲库文件由用户自己准备，不要从网络下载音乐，除非用户明确要求。
- 保持最小原型：不加登录、房主权限、内容审核，除非用户明确要求。
- 交付前至少跑一遍 `node --test`，再用 `npm start` 手动验证关键流程。

## 下一步目标
- 接入酷狗作为第三源
- 咪咕会员 Cookie（可选）

# 在线音乐搜索与播放（网易云 + 咪咕双源自动换源）设计文档

日期：2026-08-10
状态：待用户审阅

## 1. 背景与目标

在现有“一起听”网页原型中加入在线音乐搜索：用户在房间里搜索歌曲，把**免费歌曲**添加到房间播放列表，全房间同步播放。

目标：

- 用户可搜索在线歌曲并一键添加，体验与本地曲库一致
- 采用“网易云（主源）+ 咪咕（兜底源）”双源，自动换源解决单平台无版权/试听受限问题
- 会员（VIP）歌曲明确标记不可添加；不接入会员账号登录（本期范围外）
- 本地曲库搜索与上传功能保留，作为永久兜底

## 2. 现状

- 已有本地曲库：`/api/library/search`、`/api/library/add`，曲库目录 `library/`
- 播放列表字段：`id / name / url / size / uploader / fromLibrary`
- 前端已有搜索框与结果面板（本地曲库）
- 项目结构：`server.js` 单文件 + `public/app.js` + `public/index.html` + `public/styles.css`

## 3. 实测依据（2026-08-10 实机验证）

| 平台 | 搜索 | 免登录完整播放 | 备注 |
|---|---|---|---|
| 网易云 | 可用 | 可用（免费歌） | 外链 `song/media/outer/url?id=.mp3` 302 到 CDN，返回完整 mp3；`fee=1` 付费歌返回受限页；周杰伦原版无版权 |
| 咪咕 | 可用 | 可用 | App 接口 `search_all.do` 搜索；`listen.do` 返回 https 完整 mp3（实测《晴天》原版 269 秒完整）；URL 带 `Tim/Key` 有效期参数 |
| 酷狗 | 可用 | 部分可用 | 列为后续第三源 |
| QQ音乐 | 可用 | 不可用（需登录） | 播放接口免费歌也拿不到 vkey，本期不做 |
| 酷我 | 可用 | 多数仅 11 秒试听 | 本期不做 |

结论：双源组合（网易云 + 咪咕）能覆盖“网易云无版权/受限”的常见场景，例如周杰伦《晴天》由咪咕提供完整播放。

## 4. 关键设计决策

### 4.1 播放策略：下载到本地曲库（方案 A）

在线歌曲添加时由服务器下载到 `library/online/`，播放列表指向本地文件。

理由：

- 咪咕播放地址带 `Tim/Key`，有时效，直接引用会过期
- 本地文件支持拖进度、断网续播、服务器重启后仍可播
- 与现有播放架构（本地 `/uploads`、`/library` 文件）完全一致

代价：添加需等待下载（数秒）；占用磁盘；下载转存属灰色地带，仅限个人小圈子使用。

### 4.2 双源自动换源

添加歌曲时按 `网易云 → 咪咕` 顺序尝试：

1. 用歌曲主键（网易云 id / 咪咕 contentId）向主源取播放资源
2. 主源不可播（无版权、受限页、下载校验失败）→ 自动用歌名+歌手在下一源搜索同名歌曲
3. 取到完整音频（Content-Type 为 audio/*、大小在合理区间）→ 下载落盘成功
4. 双源都失败 → 返回明确错误

## 5. 架构与组件

### 5.1 新模块 `online.js`

职责：收敛所有第三方调用，向 `server.js` 暴露统一接口。

```js
// 统一搜索结果
// { id, source: 'netease'|'migu', name, artist, album, durationMs, coverUrl, playable }

module.exports = {
  search(q),          // 并行搜索两源，合并返回（网易云优先排序）
  resolveAndDownload(track, destDir),  // 按 网易云→咪咕 顺序取音频并下载
};
```

内部：

- `netease.search(q)`：调 `https://music.163.com/api/search/get/web`，`fee=1` 标记 `playable=false`
- `netease.probe(id)`：请求外链，校验最终 Content-Type 为 audio/*，否则判定不可播
- `migu.search(q)`：调 `MIGUM2.0 search_all.do`
- 咪咕结果默认 `playable=true`（搜索响应不含付费标记），实际可播性以添加时下载校验为准
- `migu.resolve(id, contentId, copyrightId)`：调 `MIGUM3.0 listen.do`，取 `songListens[0].url`
- `download(url, dest)`：带 UA 流式下载，超时 30 秒，大小上限 50MB，完成后校验

### 5.2 `server.js` 新增接口

`GET /api/online/search?q=关键词`

- 返回 `{ results: [统一结构], total }`，上限 20 条（网易云 12 + 咪咕 8）
- 搜索词长度限制 100；结果缓存 60 秒；每 IP 10 秒最多 10 次在线请求

`POST /api/online/add`

- 请求体：`{ roomId, trackId }`（`trackId` 带源前缀，如 `netease:123` / `migu:60090...`）
- 流程：校验房间 → 校验已下载缓存（按 `remoteId` 复用）→ 下载到 `library/online/<source>-<remoteId>.mp3` → 加入播放列表 → 广播快照
- 曲目字段：`{ id, name, url: '/library/online/...', size, uploader, source: 'online', provider, remoteId }`

### 5.3 前端改造

- 搜索框下加来源切换：`本地曲库 | 在线音乐`
- 在线结果行：歌名 / 歌手 / 时长 / 来源角标（网易云、咪咕）/ “添加”按钮
- `playable=false` 的结果置灰显示“会员专属”
- 添加按钮状态：添加中… → 已添加 / 失败原因
- 播放列表与正在播放区显示“在线 · 谁添加”
- 本地曲库的搜索、上传、聊天、同步逻辑不变

### 5.4 配置与常量

```js
const ONLINE_LIMIT = 20;          // 搜索结果上限
const ONLINE_CACHE_TTL = 60_000;  // 搜索缓存
const ONLINE_RATE_LIMIT = { windowMs: 10_000, max: 10 };
const ONLINE_DOWNLOAD_TIMEOUT = 30_000;
const ONLINE_MAX_SIZE = 50 * 1024 * 1024;
```

## 6. 数据流

搜索：

```text
用户输入 → GET /api/online/search
  → 缓存命中？直接返回
  → 并行请求网易云 + 咪咕 → 归一化 → 合并（网易云优先）→ 返回
```

添加：

```text
用户点添加 → POST /api/online/add
  → 解析 trackId 确定源
  → 主源取资源；不可播 → 换源搜索同名歌曲
  → 下载到 library/online/ 临时文件 → 校验 → 原子改名
  → playlist.push → broadcast(snapshot) → 全房间可见可播
```

## 7. 错误处理

- 单源接口超时/失败：搜索结果降级为另一源 + 响应注明；添加时自动换源
- 双源全失败：返回“在线曲库暂时不可用，请稍后再试”
- 下载结果非音频 / 体积异常：判定受限，按“不可播”处理并换源
- 重复添加：允许；同一 `remoteId` 已下载则不重复下载

## 8. 安全

- 下载 URL 只由 `online.js` 内部构造，不接受用户传入的任意 URL
- 下载文件名白名单：`<source>-<数字/字母id>.<ext>`，防路径穿越
- 在线搜索与添加均限速，防止滥用导致平台封 IP

## 9. 测试与验收

接口测试（Node 脚本 + 实测服务）：

1. `GET /api/online/search?q=晴天` → 结果含咪咕原版《晴天》，`playable=true`
2. `GET /api/online/search?q=周杰伦` → 网易云侧付费/受限歌 `playable=false`，咪咕侧正常
3. `POST /api/online/add` 咪咕《晴天》→ `library/online/` 出现 mp3，播放列表广播，文件时长 ≈ 270 秒
4. `POST /api/online/add` 网易云免费歌 → 成功落盘
5. 换源：添加网易云无版权歌 → 自动落到咪咕成功
6. 限速返回 429；60 秒缓存生效（二次搜索不再请求源）
7. 回归：本地曲库搜索、上传、房间同步、聊天均正常

人工验收：启动服务 → 创建房间 → 搜索“晴天”添加 → 全房间同步播放 → 拖进度正常。

## 10. 本期范围外（YAGNI）

- 会员账号扫码登录解锁 VIP 歌（决策另行确认）
- 酷狗第三源（provider 接口已预留，后续加模块即可）
- 歌词、封面本地化、按歌手/专辑筛选
- 下载队列、断点续传、多并发下载调优

## 11. 风险

- 非官方接口随时可能变更：全部调用收敛在 `online.js`，坏一个源自动降级另一源
- 版权合规：仅限个人/小圈子；免费歌下载转存仍属灰色地带，README 中明确提示
- 咪咕直链时效问题已通过“下载落盘”规避
- 服务器磁盘增长：建议在 README 中说明清理方式（删除 `library/online/` 下文件）

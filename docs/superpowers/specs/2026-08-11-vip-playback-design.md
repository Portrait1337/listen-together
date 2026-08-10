# 网易云会员歌曲播放（Cookie 方案）设计文档

日期：2026-08-11
状态：已确认方向，待实施

## 1. 目标

让网易云“会员专属”歌曲可以播放：服务器配置一个真实会员账号的 Cookie，会员歌改为在线流式播放；Cookie 失效时自动降级，免费歌曲不受影响。

## 2. 原理与约束（实测/查证）

- 网易云播放接口 `api/song/enhance/player/url` 在带会员 Cookie 时返回可播放的 CDN 地址，不带则返回 `url: null`
- CDN 地址有时效（响应 `expi=1200`，约 20 分钟），**不能存进播放列表**，必须播放时现取
- Cookie 无官方固定期限，常见 7 天～2 周，可能因风控/改密/退出提前失效
- 第三方登录有账号冻结风险，建议专用小号；本方案只做“流式播放”，不做下载保存

## 3. 关键设计决策

1. **平台**：先做网易云（Cookie 方案最成熟）；咪咕留待后续，provider 结构不变
2. **Cookie 配置**：`netease-cookie.txt` 文件（已 gitignore），30 秒重读一次，改文件即生效无需重启；同时支持 `NETEASE_COOKIE` 环境变量
3. **会员歌播放**：播放列表里会员歌的 URL 指向 `/api/online/stream?trackId=netease:<id>`，服务器现取 CDN 地址后 **307 跳转**（307 保留 Range 请求头，拖进度可用）
4. **添加顺序**：网易云免费外链下载 → 会员流式播放（Cookie 有效时）→ 咪咕换源（保持现有兜底）
5. **Cookie 校验**：启动时 + 每 10 分钟调 `api/nuser/account/get` 验活；`vipEnabled` 随搜索响应下发，失效自动把会员歌恢复置灰

## 4. 数据流

搜索：`/api/online/search` 返回 `{ results, total, degraded, vipEnabled, vipNickname }`

添加会员歌：

```text
POST /api/online/add (trackId=netease:xxx)
  → 免费外链下载失败
  → Cookie 有效？→ 取会员播放地址 → 成功 → 播放列表加入流式条目（不落盘）
  → Cookie 无效/取不到 → 咪咕换源（现有逻辑）
```

播放：

```text
浏览器请求 /api/online/stream?trackId=netease:xxx
  → 限速 → 取播放地址（10 分钟缓存，CDN 地址 20 分钟有效）
  → 307 跳转到 CDN → 浏览器播放/拖进度
  → 取不到（Cookie 过期）→ 403 文本“会员登录已过期或歌曲不可播放”
```

## 5. 接口变更

### 新增 `GET /api/online/stream`

- 参数：`trackId`（仅接受 `netease:<数字id>`）
- 成功：307 到 CDN 地址；失败：400/403/429
- 与搜索/添加共用在线限速额度

### 修改 `GET /api/online/search`

- 响应增加 `vipEnabled`、`vipNickname`

### 修改 `POST /api/online/add`

- 网易云歌曲：免费下载失败后先尝试会员流式，再咪咕换源
- 会员歌条目：`{ ..., url: '/api/online/stream?trackId=netease:<id>', vip: true, provider: 'netease' }`，不写盘

## 6. 前端变更

- 搜索响应 `vipEnabled=true` 时，会员歌按钮变为可添加（提示“+ 添加”），否则保持“会员专属”置灰
- 添加失败时按钮显示错误信息（现有机制）

## 7. 安全

- Cookie 只存服务端文件/环境变量，gitignore 排除，不打日志、不下发到浏览器
- 播放地址由服务端现取并 307，客户端拿到的只是有时效的 CDN 地址
- 流式接口同样限速，防止被用来刷取播放地址

## 8. 测试与验收

桩服务测试（新文件 `test/vip.test.js`）：

1. 未配置 Cookie：搜索 `vipEnabled=false`；会员歌仍走咪咕换源
2. 配置有效 Cookie：搜索 `vipEnabled=true`；添加会员歌 → 播放列表出现流式条目、不落盘
3. `/api/online/stream` 返回 307 且可跟随到音频
4. Cookie 无效：会员歌添加自动降级咪咕；流式接口 403
5. 非法 trackId：400

回归：全量 `node --test`；免费歌下载、本地曲库、房间同步不受影响。

## 9. 范围外（YAGNI）

- 扫码登录、自动续期（后续可选）
- 咪咕会员 Cookie（后续可选）
- 下载会员歌到本地（明确不做）
- 会员状态管理页面（原型用文件/环境变量即可）

## 10. 风险

- 账号可能被网易云风控冻结（建议专用小号，README 明确提示）
- Cookie 过期后会员歌自动降级为不可播/换源，免费歌不受影响
- 非官方接口随时可能变化，已收敛在 `online.js`

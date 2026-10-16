# 设计：搜索结果歌名点击切换无缝滚动

## 目标

搜索列表（本地曲库 + 在线音乐）的歌名默认保持省略号；**点击歌名后开始无缝滚动**，再次点击停止并恢复省略号。只对点中的那一行生效，其他行保持静止。

## 交互规则

- 点击长歌名：开始无缝循环滚动（复用现有 `marquee-scroll` 动画机制）。
- 再次点击同一歌名：停止滚动，恢复省略号。
- 短歌名（不溢出）点击无效果，保持完整显示。
- 滚动期间按住暂停，方便阅读；**悬停不停**（点击后鼠标仍停在歌名上，必须立刻开始滚动，不能被悬停暂停卡住）。
- 系统开启“减少动态效果”时不滚动，点击不生效。
- 本地曲库与在线音乐搜索结果都支持；播放列表行不受影响（仍为省略号）。

## 实现

### 共用能力

- 把现有 `titleOverflows()` 的探针测量逻辑抽取为通用函数 `textOverflows(el)`，正在播放标题与搜索歌名共用。
- 新增通用切换函数 `toggleLibNameMarquee(el)`：
  - 未激活：测量溢出（不溢出直接返回）；激活时把歌名包成双份 `.marquee-text` 的 `.marquee-track`，容器加 `.marquee`，保留 `title`/`aria-label` 完整歌名，滚动副本 `aria-hidden`。
  - 已激活：还原为纯文本省略号（先取回文本再清理，避免标题丢失——参考此前 resize 修复）。

### 渲染接入

- `renderLibraryResults()`（本地曲库）：给 `.lib-name` 绑定 `click` 切换。
- `makeOnlineRow()`（在线音乐）：给 `.lib-name` 绑定 `click` 切换。
- 搜索结果重渲染时 `innerHTML = ''` 会自然清空所有已激活状态。

### 样式

- `.lib-name.marquee`：单行、`white-space: nowrap`、`overflow: hidden`，内部复用 `marquee-scroll` 动画；仅“按住”暂停，不做悬停暂停。
- 默认 `.lib-name` 保持现有省略号样式。

## 改动范围

- `public/app.js`：抽取 `textOverflows()`、新增 `toggleLibNameMarquee()`、两处渲染绑定点击。
- `public/styles.css`：`.lib-name.marquee` 及相关滚动样式。
- `public/index.html`：静态资源版本号 +1（`v=20260821` → `v=20260822`）。
- 不新增依赖；不涉及后端。

## 验证

- Playwright：长歌名点击后滚动、再点停止；其他行不滚；短歌名点击无变化；减少动态效果时不滚；无控制台报错。
- `node --test` 回归通过。

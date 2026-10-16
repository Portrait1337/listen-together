# 搜索结果歌名点击切换无缝滚动 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 搜索列表歌名点击后开始无缝滚动，再次点击停止；其他行保持省略号。

**Architecture:** 抽取通用溢出测量函数 `textOverflows()`；新增 `toggleLibNameMarquee(el)`（点击切换滚动结构）；在本地/在线搜索结果渲染时给 `.lib-name` 绑定点击。滚动结构与“正在播放”标题共用 `marquee-scroll` 动画。

**Tech Stack:** 原生 HTML/CSS/JS，Node 22 + Playwright（验证用）。

---

## 文件结构

- `public/app.js` — `titleOverflows` 改名复用为 `textOverflows`；新增 `toggleLibNameMarquee()`；`renderLibraryResults()` 与 `makeOnlineRow()` 绑定点击。
- `public/styles.css` — `.lib-name.marquee` 滚动样式。
- `public/index.html` — 版本号 `v=20260821` → `v=20260822`。
- `qa-lib-marquee.cjs`（临时验证脚本，验证后删除）。
- 测试夹具：`library/` 下临时复制两个 wav（超长歌名 + 短歌名），验证后删除（library 已 gitignore）。

---

## 本地验证环境

以下命令均从项目根目录执行。准备自备的有效 WAV 音频，并设置
`TEST_AUDIO_FILE` 为该文件的绝对路径，例如 `export TEST_AUDIO_FILE="$HOME/test-audio.wav"`。
Playwright 可安装在项目外的临时工具目录：

```bash
QA_TOOLS_DIR="$(mktemp -d)"
npm install --prefix "$QA_TOOLS_DIR" playwright
npm exec --prefix "$QA_TOOLS_DIR" -- playwright install chromium
export PLAYWRIGHT_MODULE="$QA_TOOLS_DIR/node_modules/playwright"
```

脚本默认使用 Playwright 管理的 Chromium；需要指定已有浏览器时，设置
`PLAYWRIGHT_EXECUTABLE_PATH` 为浏览器可执行文件的绝对路径。
验证完成后删除本次创建的临时工具目录及测试夹具。

---

### Task 1: 准备夹具与验证脚本（先红）

**Files:**
- Create: `qa-lib-marquee.cjs`（项目根目录，临时）
- 测试夹具：`library/` 下两个 wav 文件

- [ ] **Step 1: 复制测试音频到曲库**

```bash
: "${TEST_AUDIO_FILE:?请先设置自备测试 WAV 文件路径}"
mkdir -p library
cp "$TEST_AUDIO_FILE" "library/超长歌名测试这是一首很长很长的歌用来验证搜索歌名滚动显示效果.wav"
cp "$TEST_AUDIO_FILE" "library/短歌名测试.wav"
```

- [ ] **Step 2: 重启本地服务让曲库索引包含新文件**

停掉 3210 端口的旧服务进程，重新执行 `PORT=3210 node server.js`。

- [ ] **Step 3: 创建验证脚本**

```js
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const EXE = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
const BASE = 'http://localhost:3210';
const LONG = '超长歌名测试这是一首很长很长的歌用来验证搜索歌名滚动显示效果.wav';

let failures = 0;
function ok(cond, label, extra) {
  if (cond) console.log('PASS', label);
  else {
    failures += 1;
    console.log('FAIL', label, extra || '');
  }
}

(async () => {
  const browser = await chromium.launch({ ...(EXE ? { executablePath: EXE } : {}), headless: true });
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.fill('#nickname', '小播');
  await page.click('#createBtn');
  await page.waitForSelector('#room:not(.hidden)', { timeout: 5000 });

  // 切到本地曲库并搜索长歌名
  await page.click('#tabLocal');
  await page.fill('#librarySearch', '超长歌名测试');
  await page.waitForSelector('.lib-row .lib-name', { timeout: 8000 });
  const longName = page.locator('.lib-row .lib-name').first();
  ok((await longName.textContent()).trim() === LONG, '搜索到长歌名结果');

  // 点击 → 开始滚动
  await longName.click();
  await page.waitForTimeout(200);
  ok((await longName.getAttribute('class')).includes('marquee'), '点击后开始滚动');
  ok((await longName.locator('.marquee-track').count()) === 1, '滚动轨道存在');

  // 再点 → 停止
  await longName.click();
  await page.waitForTimeout(200);
  ok(!(await longName.getAttribute('class')).includes('marquee'), '再点停止滚动');
  ok((await longName.textContent()).trim() === LONG, '停止后歌名仍完整显示');

  // 短歌名：点击不滚动
  await page.fill('#librarySearch', '短歌名测试');
  await page.waitForSelector('.lib-row .lib-name', { timeout: 8000 });
  const shortName = page.locator('.lib-row .lib-name').first();
  await shortName.click();
  await page.waitForTimeout(200);
  ok(!(await shortName.getAttribute('class')).includes('marquee'), '短歌名点击不滚动');

  ok(errors.length === 0, '无控制台报错', JSON.stringify(errors));
  console.log(failures === 0 ? 'ALL_CHECKS_PASSED' : 'FAILURES=' + failures);
  await browser.close();
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('QA_CRASH', e);
  process.exit(2);
});
```

- [ ] **Step 4: 运行脚本确认失败**

运行：`node qa-lib-marquee.cjs`

预期：`FAIL 点击后开始滚动`（功能未实现）。

---

### Task 2: 实现点击切换滚动

**Files:**
- Modify: `public/app.js`
- Modify: `public/styles.css`

- [ ] **Step 1: 通用化溢出测量**

把 `public/app.js` 中 `titleOverflows` 函数改名为 `textOverflows`（函数体不变），并把 `refreshNowPlayingMarquee()` 里的调用改为 `textOverflows(el)`。

- [ ] **Step 2: 新增切换函数**

在 `refreshNowPlayingMarquee` 之后追加：

```js
// 搜索结果歌名：点击切换无缝滚动（点一次滚，再点停止）
function toggleLibNameMarquee(el) {
  if (!el) return;
  if (el.classList.contains('marquee')) {
    // 停止：先取回文本再清理，避免标题丢失
    const oldTrack = el.querySelector('.marquee-track');
    const text =
      el.getAttribute('aria-label') ||
      (oldTrack && oldTrack.firstElementChild ? oldTrack.firstElementChild.textContent : '') ||
      el.textContent ||
      '';
    el.classList.remove('marquee');
    el.removeAttribute('aria-label');
    if (oldTrack) oldTrack.remove();
    el.textContent = text;
    return;
  }
  // 减少动态效果时不滚动
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const text = el.textContent.trim();
  if (!text || !textOverflows(el)) return;
  el.classList.add('marquee');
  el.setAttribute('aria-label', text);
  const track = document.createElement('span');
  track.className = 'marquee-track';
  track.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 2; i++) {
    const copy = document.createElement('span');
    copy.className = 'marquee-text';
    copy.textContent = text;
    track.append(copy);
  }
  el.textContent = '';
  el.append(track);
  const oneCopyWidth = track.firstElementChild ? track.firstElementChild.scrollWidth : el.clientWidth;
  const duration = Math.max(10, Math.round(10 + oneCopyWidth / 60));
  el.style.setProperty('--marquee-duration', duration + 's');
}
```

- [ ] **Step 3: 两处渲染绑定点击**

`renderLibraryResults()` 中 `name` 创建后追加：

```js
    name.addEventListener('click', () => toggleLibNameMarquee(name));
```

`makeOnlineRow()` 中 `name` 创建后追加同样的绑定。

- [ ] **Step 4: 新增样式**

在 `public/styles.css` 的 `.lib-name` 规则之后追加：

```css
/* 搜索歌名：点击后单行无缝滚动 */
.lib-name.marquee {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: clip;
}

.lib-name.marquee .marquee-track {
  display: inline-flex;
  white-space: nowrap;
  will-change: transform;
  animation: marquee-scroll var(--marquee-duration, 12s) linear infinite;
}

.lib-name.marquee .marquee-text {
  display: inline-block;
  padding-right: 2.5em;
}

.lib-name.marquee:hover .marquee-track,
.lib-name.marquee:active .marquee-track {
  animation-play-state: paused;
}
```

- [ ] **Step 5: 运行验证脚本**

运行：`node qa-lib-marquee.cjs`

预期：`ALL_CHECKS_PASSED`。

- [ ] **Step 6: 回归测试**

运行：`node --test`（项目目录）

预期：全部通过（当前 72 个）。

---

### Task 3: 版本号、清理与提交

**Files:**
- Modify: `public/index.html`
- 删除临时脚本与曲库夹具

- [ ] **Step 1: 版本号 +1**

`public/index.html` 中 `v=20260821` 全部改为 `v=20260822`。

- [ ] **Step 2: 再次运行验证脚本**

预期：`ALL_CHECKS_PASSED`。

- [ ] **Step 3: 清理夹具与脚本**

删除 `qa-lib-marquee.cjs` 与 `library/` 下两个临时 wav。

- [ ] **Step 4: 提交**

```bash
git add public/app.js public/styles.css public/index.html
git commit -m "新增：搜索结果歌名点击切换无缝滚动"
```

---

## Self-Review

1. **Spec 覆盖**：点击切换（Task 2 Step 2/3）、短歌名无效（Task 1 断言）、其他行不滚（默认省略号未改）、减少动态效果（Task 2 Step 2）、本地+在线绑定（Task 2 Step 3）、版本号（Task 3）、验证（Task 1/2/3）。
2. **占位符扫描**：无 TBD/TODO，代码完整。
3. **命名一致**：`textOverflows`、`toggleLibNameMarquee`、`.lib-name.marquee` 各任务引用一致。

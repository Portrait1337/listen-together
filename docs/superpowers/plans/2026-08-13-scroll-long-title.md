# 正在播放歌名超长无缝滚动 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 房间内“正在播放”卡片标题超长时无缝循环滚动展示，播放列表保持省略号。

**Architecture:** 在 `renderNowPlaying` 渲染完标题后调用 `refreshNowPlayingMarquee()`：仅当文本实际溢出且用户未开启“减少动态效果”时，把标题改成单行容器并放入两份相同文本的 `.marquee-track`，用 CSS `translateX(0 → -50%)` 线性动画循环实现首尾无缝；悬停/触摸暂停；窗口尺寸变化时重建。

**Tech Stack:** 原生 HTML/CSS/JS（无框架、无构建步骤），Node 22 + Playwright（验证用）。

---

## 文件结构

- `public/app.js` — 新增 `refreshNowPlayingMarquee()`、`marqueeResizeTimer`，`renderNowPlaying` 末尾调用，`resize` 监听重建。
- `public/styles.css` — `.now-title.marquee` 单行滚动容器、`.marquee-track` 动画、悬停暂停、`@keyframes marquee-scroll`。
- `public/index.html` — 静态资源版本号 `20260815` → `20260816`。
- `qa-marquee.cjs`（临时验证脚本，验证后删除，不入库）。

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

### Task 1: 写验证脚本并确认当前失败

**Files:**
- Create: `qa-marquee.cjs`（项目根目录，临时文件）

- [ ] **Step 1: 创建验证脚本**

```js
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('fs');

const EXE = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
const WAV = process.env.TEST_AUDIO_FILE;
if (!WAV) throw new Error('请设置 TEST_AUDIO_FILE 为自备测试 WAV 文件的绝对路径');
const BASE = 'http://localhost:3210';

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

  // 长歌名：应触发滚动
  const longName = '这是一首用来测试超长歌名无缝滚动效果的单曲，名字故意写得非常非常长以便撑满整个标题区域'.repeat(2) + '.wav';
  await page.setInputFiles('#fileInput', {
    name: longName,
    mimeType: 'audio/wav',
    buffer: fs.readFileSync(WAV),
  });
  await page.waitForSelector('.track', { timeout: 10000 });
  await page.waitForTimeout(400);
  const title = page.locator('#nowPlaying');
  ok((await title.getAttribute('class')).includes('marquee'), '长歌名触发滚动容器');
  ok((await title.locator('.marquee-track').count()) === 1, '存在滚动轨道');
  const anim = await title
    .locator('.marquee-track')
    .evaluate((el) => getComputedStyle(el).animationName);
  ok(anim === 'marquee-scroll', '使用无缝滚动动画', anim);

  // 悬停暂停
  await title.hover();
  await page.waitForTimeout(100);
  const playState = await title
    .locator('.marquee-track')
    .evaluate((el) => getComputedStyle(el).animationPlayState);
  ok(playState === 'paused', '悬停时暂停滚动', playState);

  // 播放列表行不滚动（保持省略号）
  const trackNameClass = await page
    .locator('.track-name')
    .evaluate((el) => getComputedStyle(el).textOverflow);
  ok(trackNameClass === 'ellipsis', '列表行保持省略号', trackNameClass);

  // 短歌名：不触发滚动
  await page.setInputFiles('#fileInput', {
    name: '短歌名.wav',
    mimeType: 'audio/wav',
    buffer: fs.readFileSync(WAV),
  });
  await page.waitForFunction(() => document.querySelectorAll('.track').length === 2, null, {
    timeout: 10000,
  });
  await page.waitForTimeout(300);
  ok(!(await title.getAttribute('class')).includes('marquee'), '短歌名不滚动');

  ok(errors.length === 0, '无控制台报错', JSON.stringify(errors));
  console.log(failures === 0 ? 'ALL_CHECKS_PASSED' : 'FAILURES=' + failures);
  await browser.close();
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('QA_CRASH', e);
  process.exit(2);
});
```

- [ ] **Step 2: 运行验证脚本，确认失败**

运行：`node qa-marquee.cjs`

预期：`FAIL 长歌名触发滚动容器`（功能尚未实现）。

---

### Task 2: 实现无缝滚动

**Files:**
- Modify: `public/app.js`
- Modify: `public/styles.css`

- [ ] **Step 1: 在 `renderNowPlaying` 末尾调用刷新函数**

在 `public/app.js` 的 `renderNowPlaying()` 函数末尾（`ui.vinylLabel` 处理之后）追加：

```js
  refreshNowPlayingMarquee();
```

- [ ] **Step 2: 新增滚动逻辑**

在 `renderNowPlaying` 函数定义之后追加：

```js
// ---------- 正在播放歌名：超长时无缝滚动 ----------
let marqueeResizeTimer = null;

function refreshNowPlayingMarquee() {
  const el = ui.nowPlaying;
  if (!el) return;
  // 清掉上一次的滚动结构，恢复纯文本
  el.classList.remove('marquee');
  el.removeAttribute('aria-label');
  const oldTrack = el.querySelector('.marquee-track');
  if (oldTrack) oldTrack.remove();
  const text = el.textContent.trim();
  if (!text) return;
  // 系统开启“减少动态效果”时不滚动，保持两行截断
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  // 只在真实溢出时滚动
  if (el.scrollWidth <= el.clientWidth + 1) return;
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
  // 时长随文本宽度自适应：文本越宽滚得越慢
  const oneCopyWidth = track.firstElementChild ? track.firstElementChild.scrollWidth : el.clientWidth;
  const duration = Math.max(10, Math.round(10 + oneCopyWidth / 60));
  el.style.setProperty('--marquee-duration', duration + 's');
}

window.addEventListener('resize', () => {
  clearTimeout(marqueeResizeTimer);
  marqueeResizeTimer = setTimeout(refreshNowPlayingMarquee, 150);
});
```

- [ ] **Step 3: 新增滚动样式**

在 `public/styles.css` 的 `.now-title` 规则之后追加：

```css
/* 超长歌名：单行无缝滚动 */
.now-title.marquee {
  display: block;
  -webkit-line-clamp: unset;
  white-space: nowrap;
  overflow: hidden;
}

.now-title.marquee .marquee-track {
  display: inline-flex;
  white-space: nowrap;
  will-change: transform;
  animation: marquee-scroll var(--marquee-duration, 12s) linear infinite;
}

.now-title.marquee .marquee-text {
  display: inline-block;
  padding-right: 2.5em;
}

.now-title.marquee:hover .marquee-track,
.now-title.marquee:active .marquee-track {
  animation-play-state: paused;
}

@keyframes marquee-scroll {
  from {
    transform: translateX(0);
  }
  to {
    transform: translateX(-50%);
  }
}
```

- [ ] **Step 4: 运行验证脚本，确认通过**

运行：`node qa-marquee.cjs`

预期：`ALL_CHECKS_PASSED`。

---

### Task 3: 版本号、回归与提交

**Files:**
- Modify: `public/index.html`
- Commit

- [ ] **Step 1: 版本号 +1**

`public/index.html` 中三处 `v=20260815` 全部改为 `v=20260816`（KaTeX 样式、styles.css、sync-policy.js、app.js 共 4 处链接）。

- [ ] **Step 2: 回归测试**

运行：`node --test`（项目目录 `wo-x/outputs/listen-together`）

预期：61 个测试全部通过。

- [ ] **Step 3: 再次运行验证脚本**

运行：`node qa-marquee.cjs`

预期：`ALL_CHECKS_PASSED`。

- [ ] **Step 4: 删除临时脚本并提交**

删除 `qa-marquee.cjs`，然后：

```bash
git add public/app.js public/styles.css public/index.html
git commit -m "新增：正在播放歌名超长时无缝滚动显示"
```

---

## Self-Review

1. **Spec 覆盖**：溢出触发（Task 2 Step 2）、无缝循环（Task 2 Step 2/3）、时长自适应（Task 2 Step 2）、悬停暂停（Task 2 Step 3）、reduced-motion 回落（Task 2 Step 2）、列表保持省略号（Task 1 验证）、版本号（Task 3）——全部覆盖。
2. **占位符扫描**：无 TBD/TODO；每步均有完整代码与命令。
3. **类型一致性**：`refreshNowPlayingMarquee`、`.marquee-track`、`.marquee-text`、`--marquee-duration`、`marquee-scroll` 在各任务中命名一致。

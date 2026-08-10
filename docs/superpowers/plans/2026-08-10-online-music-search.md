# 在线音乐搜索与播放（网易云 + 咪咕双源）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在“一起听”中加入在线音乐搜索（网易云 + 咪咕），用户搜索并添加免费歌曲，服务器下载到 `library/online/` 后加入房间播放列表，全房间同步播放；主源不可播时自动换源。

**Architecture:** 新增 `online.js` 模块收敛所有第三方调用（统一搜索、下载、换源），`server.js` 暴露 `/api/online/search` 与 `/api/online/add` 并做限速/缓存；前端搜索框加“本地曲库 / 在线音乐”切换。第三方基地址与限速参数全部环境变量可配，测试用本地桩服务保证可复现。

**Tech Stack:** Node.js 18+（CommonJS）、Express、ws、node:test；第三方接口：网易云老搜索接口 + 外链播放、咪咕 MIGUM2.0/3.0。

---

## 文件结构

- Create: `online.js` — 第三方提供者（网易云/咪咕）搜索、下载、换源；导出 `searchOnline / resolveAndDownloadOnline / parseTrackId`
- Create: `test/online.test.js` — 桩服务集成测试（搜索、缓存、限速、添加、换源、复用、非法 id、全失败）
- Modify: `server.js` — 在线搜索/添加接口、限速、缓存、已下载复用、`library/online` 目录
- Modify: `public/index.html` — 搜索来源切换（本地/在线）
- Modify: `public/app.js` — 在线搜索渲染、添加交互、来源切换
- Modify: `public/styles.css` — 标签页、来源角标样式
- Modify: `README.md`、`AGENTS.md` — 文档同步

## Task 1: online.js 核心模块

**Files:** Create: `online.js`

- [ ] **Step 1: 编写桩服务集成测试（RED）**

创建 `test/online.test.js`，内容见 Task 2。先只创建测试文件，运行确认失败原因：`server.js` 引用不存在的 `online.js` 导致启动失败。

- [ ] **Step 2: 运行测试确认 RED**

```bash
node --test test/online.test.js
```

预期：`Cannot find module './online'`，全部失败。

- [ ] **Step 3: 实现 `online.js`**

```js
// 在线音乐提供者：网易云 + 咪咕，统一搜索与下载（双源自动换源）
// 所有第三方地址、超时、大小限制都可用环境变量覆盖，便于测试与维护。
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const NETEASE_BASE = process.env.NETEASE_BASE || 'https://music.163.com';
const MIGU_BASE = process.env.MIGU_BASE || 'https://app.pd.nf.migu.cn';
const DOWNLOAD_TIMEOUT_MS = Number(process.env.ONLINE_DOWNLOAD_TIMEOUT_MS) || 30000;
const MAX_SIZE = Number(process.env.ONLINE_MAX_SIZE) || 50 * 1024 * 1024;
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// 下载地址白名单：只允许官方 CDN 域名，防止第三方返回任意 URL 造成 SSRF
const DEFAULT_AUDIO_HOSTS = ['.music.126.net', '.163.com', '.migu.cn'];
const EXTRA_AUDIO_HOSTS = String(process.env.ONLINE_AUDIO_HOSTS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function isAllowedAudioHost(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  const suffix = host.startsWith('www.') ? host.slice(4) : host;
  return [...EXTRA_AUDIO_HOSTS, ...DEFAULT_AUDIO_HOSTS].some((rule) =>
    rule.startsWith('.') ? suffix.endsWith(rule) : suffix === rule
  );
}

async function httpJson(url, fetchImpl) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function neteaseSearch(q, fetchImpl) {
  const url = `${NETEASE_BASE}/api/search/get/web?s=${encodeURIComponent(q)}&type=1&limit=12`;
  const data = await httpJson(url, fetchImpl);
  const songs = (data && data.result && data.result.songs) || [];
  return songs.map((s) => ({
    id: 'netease:' + s.id,
    source: 'netease',
    name: String(s.name || ''),
    artist: (s.artists || []).map((a) => a.name).filter(Boolean).join('/'),
    album: s.album && s.album.name ? s.album.name : '',
    durationMs: Number(s.duration) || 0,
    coverUrl: s.album && s.album.picUrl ? s.album.picUrl : '',
    // fee=1 是会员歌，直接标为不可播；其余以添加时下载校验为准
    playable: s.fee !== 1,
  }));
}

async function miguSearch(q, fetchImpl) {
  const params = new URLSearchParams({
    ua: 'Android_migu',
    version: '5.1',
    text: q,
    pageNo: '1',
    pageSize: '8',
    searchSwitch: JSON.stringify({ song: 1 }),
  });
  const url = `${MIGU_BASE}/MIGUM2.0/v1.0/content/search_all.do?${params}`;
  const data = await httpJson(url, fetchImpl);
  const list = (data && data.songResultData && data.songResultData.result) || [];
  return list.map((s) => ({
    id: `migu:${s.id}:${s.contentId}:${s.copyrightId}`,
    source: 'migu',
    name: String(s.name || ''),
    artist: (s.singers || []).map((x) => x.name).filter(Boolean).join('/'),
    album: (s.albums && s.albums[0] && s.albums[0].name) || '',
    durationMs: Number(s.length) || 0,
    coverUrl: '',
    playable: true,
  }));
}

function parseTrackId(trackId) {
  const s = String(trackId || '').trim();
  if (s.startsWith('netease:')) {
    const id = s.slice(8);
    if (!/^\d+$/.test(id)) return null;
    return { source: 'netease', neteaseId: id };
  }
  if (s.startsWith('migu:')) {
    const parts = s.slice(5).split(':');
    if (parts.length !== 3 || !parts.every((p) => /^[0-9A-Za-z]+$/.test(p))) return null;
    return { source: 'migu', audioId: parts[0], contentId: parts[1], copyrightId: parts[2] };
  }
  return null;
}

async function miguResolveUrl(meta, fetchImpl) {
  const params = new URLSearchParams({
    audioId: meta.audioId,
    contentId: meta.contentId,
    copyrightId: meta.copyrightId,
    resourceType: '2',
    netType: '01',
    toneFlag: 'PQ',
    channel: '0',
  });
  const url = `${MIGU_BASE}/MIGUM3.0/v1.0/content/sub/listen.do?${params}`;
  const data = await httpJson(url, fetchImpl);
  const u = data && data.songListens && data.songListens[0] && data.songListens[0].url;
  return typeof u === 'string' && u ? u : null;
}

async function downloadAudio(url, dest, fetchImpl) {
  if (!isAllowedAudioHost(url)) throw new Error('不安全的下载地址');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DOWNLOAD_TIMEOUT_MS);
  let res;
  try {
    res = await fetchImpl(url, {
      headers: { 'User-Agent': UA },
      redirect: 'follow',
      signal: ctrl.signal,
    });
  } catch {
    throw new Error('下载失败');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error('下载失败 HTTP ' + res.status);
  const ct = String(res.headers.get('content-type') || '');
  if (!ct.startsWith('audio/')) throw new Error('非音频内容');
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_SIZE) throw new Error('文件过大');
  const tmp = dest + '.tmp';
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
  const st = fs.statSync(tmp);
  if (st.size < 1024 || st.size > MAX_SIZE) {
    fs.unlinkSync(tmp);
    throw new Error('文件大小异常');
  }
  fs.renameSync(tmp, dest);
  return st.size;
}

function pickMiguFallback(results, name, artist) {
  const n = String(name || '').toLowerCase();
  const a = String(artist || '').toLowerCase();
  const hit = results.find(
    (r) =>
      r.name.toLowerCase().includes(n) &&
      (!a || r.artist.toLowerCase().includes(a) || a.includes(r.artist.toLowerCase()))
  );
  return hit || results[0] || null;
}

async function downloadMiguTrack(song, destDir, fetchImpl) {
  const url = await miguResolveUrl(
    { audioId: song.id, contentId: song.contentId, copyrightId: song.copyrightId },
    fetchImpl
  );
  if (!url) return { error: '该歌曲受版权或会员限制，暂时无法播放' };
  const file = `migu-${String(song.id)}.mp3`;
  await downloadAudio(url, path.join(destDir, file), fetchImpl);
  return { file, provider: 'migu', name: song.name || `咪咕歌曲 ${song.id}` };
}

async function searchOnline(q, { fetchImpl = fetch } = {}) {
  const [ne, mg] = await Promise.allSettled([neteaseSearch(q, fetchImpl), miguSearch(q, fetchImpl)]);
  const results = [];
  if (ne.status === 'fulfilled') results.push(...ne.value);
  if (mg.status === 'fulfilled') results.push(...mg.value);
  return {
    total: results.length,
    results: results.slice(0, 20),
    degraded: ne.status !== 'fulfilled' || mg.status !== 'fulfilled',
  };
}

async function resolveAndDownloadOnline(trackId, name, artist, destDir, { fetchImpl = fetch } = {}) {
  const meta = parseTrackId(trackId);
  if (!meta) return { error: '无效的歌曲标识' };
  if (meta.source === 'netease') {
    const file = `netease-${meta.neteaseId}.mp3`;
    try {
      const url = `${NETEASE_BASE}/song/media/outer/url?id=${meta.neteaseId}.mp3`;
      await downloadAudio(url, path.join(destDir, file), fetchImpl);
      return { file, provider: 'netease', name: name || `网易云歌曲 ${meta.neteaseId}` };
    } catch {
      // 主源不可播（会员/版权/接口异常）：用歌名+歌手在咪咕换源
      const q = [artist, name].filter(Boolean).join(' ').trim();
      if (q) {
        try {
          const found = await miguSearch(q, fetchImpl);
          const pick = pickMiguFallback(found, name, artist);
          if (pick) {
            const done = await downloadMiguTrack(pick, destDir, fetchImpl);
            if (!done.error) return done;
          }
        } catch {}
      }
    }
    return { error: '该歌曲受版权或会员限制，暂时无法播放' };
  }
  return downloadMiguTrack(
    {
      id: meta.audioId,
      contentId: meta.contentId,
      copyrightId: meta.copyrightId,
      name,
    },
    destDir,
    fetchImpl
  );
}

module.exports = {
  searchOnline,
  resolveAndDownloadOnline,
  parseTrackId,
  isAllowedAudioHost,
};
```

- [ ] **Step 4: 运行测试确认通过**

```bash
node --test test/online.test.js
```

预期：全部通过。

- [ ] **Step 5: 提交**

```bash
git add online.js test/online.test.js
git commit -m "新增：在线音乐提供者模块（网易云 + 咪咕）与桩服务测试"
```

## Task 2: 在线接口与限速缓存（server.js）

**Files:** Modify: `server.js`

- [ ] **Step 1: 在 `server.js` 顶部引入模块并添加配置**

```js
const online = require('./online');
```

在 `LIBRARY_DIR` 定义后追加：

```js
const ONLINE_DIR = path.join(LIBRARY_DIR, 'online');
fs.mkdirSync(ONLINE_DIR, { recursive: true });
const ONLINE_CACHE_TTL_MS = Number(process.env.ONLINE_CACHE_TTL_MS) || 60000;
const ONLINE_RATE_WINDOW_MS = Number(process.env.ONLINE_RATE_WINDOW_MS) || 10000;
const ONLINE_RATE_MAX = Number(process.env.ONLINE_RATE_MAX) || 10;
```

在 `uploadActivity` 附近追加限速与缓存结构：

```js
// ---------- 在线音乐：限速、搜索缓存、已下载复用 ----------
const onlineHits = new Map(); // ip -> [时间戳]
const onlineCache = new Map(); // q -> { at, data }
const onlineFiles = new Map(); // "provider:remoteId" -> 文件名

function checkOnlineRate(ip) {
  const now = Date.now();
  const arr = (onlineHits.get(ip) || []).filter((t) => now - t < ONLINE_RATE_WINDOW_MS);
  if (arr.length >= ONLINE_RATE_MAX) {
    onlineHits.set(ip, arr);
    return false;
  }
  arr.push(now);
  onlineHits.set(ip, arr);
  return true;
}
```

- [ ] **Step 2: 在 `/api/library/add` 之后添加两个路由**

```js
app.get('/api/online/search', async (req, res) => {
  if (!checkOnlineRate(clientIp(req))) {
    return res.status(429).json({ error: '请求太频繁，请稍后再试' });
  }
  const q = String(req.query.q || '').trim().slice(0, 100);
  if (!q) return res.status(400).json({ error: '请输入搜索关键词' });
  const cached = onlineCache.get(q);
  if (cached && Date.now() - cached.at < ONLINE_CACHE_TTL_MS) return res.json(cached.data);
  try {
    const data = await online.searchOnline(q);
    onlineCache.set(q, { at: Date.now(), data });
    if (onlineCache.size > 200) onlineCache.delete(onlineCache.keys().next().value);
    res.json(data);
  } catch {
    res.status(502).json({ error: '在线曲库暂时不可用，请稍后再试' });
  }
});

app.post('/api/online/add', async (req, res) => {
  if (!checkOnlineRate(clientIp(req))) {
    return res.status(429).json({ error: '请求太频繁，请稍后再试' });
  }
  const room = rooms.get(String(req.body.roomId || '').toUpperCase().trim());
  if (!room) return res.status(404).json({ error: '房间不存在，请重新加入' });
  const trackId = String(req.body.trackId || '');
  const name = String(req.body.name || '').trim().slice(0, 200);
  const artist = String(req.body.artist || '').trim().slice(0, 200);
  const parsed = online.parseTrackId(trackId);
  if (!parsed) return res.status(400).json({ error: '无效的歌曲标识' });
  const cacheKey = parsed.source + ':' + (parsed.source === 'netease' ? parsed.neteaseId : parsed.audioId);
  let file = onlineFiles.get(cacheKey);
  let trackName = name;
  let provider = parsed.source;
  if (!file) {
    const done = await online.resolveAndDownloadOnline(trackId, name, artist, ONLINE_DIR);
    if (done.error) return res.status(502).json({ error: done.error });
    file = done.file;
    trackName = done.name || name;
    provider = done.provider;
    onlineFiles.set(cacheKey, file);
  }
  const track = {
    id: crypto.randomBytes(6).toString('hex'),
    name: trackName,
    url: '/library/online/' + encodeURIComponent(file),
    size: fs.statSync(path.join(ONLINE_DIR, file)).size,
    uploader: String(req.body.nickname || '匿名').trim().slice(0, 20) || '匿名',
    source: 'online',
    provider,
    remoteId: cacheKey,
  };
  room.playlist.push(track);
  if (room.currentIndex < 0) {
    room.currentIndex = 0;
    room.positionMs = 0;
    room.updatedAt = Date.now();
  }
  broadcast(room, snapshot(room));
  res.json({ ok: true, track });
});
```

- [ ] **Step 3: 运行 `test/online.test.js` 与全量测试**

```bash
node --test
```

预期：全部通过。

- [ ] **Step 4: 提交**

```bash
git add server.js
git commit -m "新增：在线音乐搜索与添加接口（限速、缓存、已下载复用）"
```

## Task 3: 前端来源切换与在线结果

**Files:** Modify: `public/index.html`、`public/app.js`、`public/styles.css`

- [ ] **Step 1: index.html 搜索区改为带标签页**

```html
<div class="search-tabs">
  <button id="tabLocal" class="tab active" type="button">本地曲库</button>
  <button id="tabOnline" class="tab" type="button">在线音乐</button>
</div>
<div class="search-row">
  <input id="librarySearch" type="text" placeholder="搜索本地曲库…" autocomplete="off">
</div>
```

- [ ] **Step 2: app.js 添加标签页逻辑与在线搜索**

`ui` 增加 `tabLocal: $('tabLocal'), tabOnline: $('tabOnline')`；顶部状态区增加 `let searchTab = 'local';`。

在 `scheduleLibrarySearch` 前增加：

```js
// ---------- 搜索来源切换：本地曲库 / 在线音乐 ----------
function setSearchTab(tab) {
  searchTab = tab;
  ui.tabLocal.classList.toggle('active', tab === 'local');
  ui.tabOnline.classList.toggle('active', tab === 'online');
  ui.librarySearch.placeholder = tab === 'local' ? '搜索本地曲库…' : '搜索在线音乐…';
  ui.librarySearch.value = '';
  ui.libraryResults.classList.add('hidden');
  ui.libraryResults.innerHTML = '';
}
ui.tabLocal.addEventListener('click', () => setSearchTab('local'));
ui.tabOnline.addEventListener('click', () => setSearchTab('online'));
```

`searchLibrary()` 开头加分支：`if (searchTab === 'online') return searchOnline();`

新增在线搜索与渲染（放在本地曲库函数之后）：

```js
async function searchOnline() {
  const q = ui.librarySearch.value.trim();
  const seq = ++librarySeq;
  clearTimeout(libraryTimer);
  if (!q) {
    ui.libraryResults.classList.add('hidden');
    ui.libraryResults.innerHTML = '';
    return;
  }
  ui.libraryResults.classList.remove('hidden');
  ui.libraryResults.innerHTML = '<div class="lib-note">搜索中…</div>';
  try {
    const res = await fetch('/api/online/search?q=' + encodeURIComponent(q));
    const data = await res.json();
    if (seq !== librarySeq) return;
    if (!res.ok) throw new Error(data.error || '搜索失败');
    renderOnlineResults(data.results || [], data.total || 0);
  } catch {
    if (seq === librarySeq) {
      ui.libraryResults.innerHTML = '<div class="lib-note">在线曲库暂时不可用，请稍后再试</div>';
    }
  }
}

function renderOnlineResults(results, total) {
  ui.libraryResults.innerHTML = '';
  if (total === 0) {
    const note = document.createElement('div');
    note.className = 'lib-note';
    note.textContent = '没有找到匹配的在线歌曲';
    ui.libraryResults.append(note);
    return;
  }
  results.forEach((t) => {
    const row = document.createElement('div');
    row.className = 'lib-row';
    const badge = document.createElement('span');
    badge.className = 'lib-badge ' + t.source;
    badge.textContent = t.source === 'netease' ? '网易云' : '咪咕';
    const name = document.createElement('span');
    name.className = 'lib-name';
    name.textContent = t.name;
    name.title = t.name;
    const meta = document.createElement('span');
    meta.className = 'lib-meta';
    meta.textContent = [t.artist, t.durationMs ? fmt(t.durationMs) : ''].filter(Boolean).join(' · ');
    const add = document.createElement('button');
    add.className = 'small';
    if (t.playable) {
      add.textContent = '+ 添加';
      add.addEventListener('click', () => addOnlineTrack(t, add));
    } else {
      add.textContent = '会员专属';
      add.disabled = true;
    }
    row.append(badge, name, meta, add);
    ui.libraryResults.append(row);
  });
}

async function addOnlineTrack(track, btn) {
  if (!roomCode) return;
  btn.disabled = true;
  btn.textContent = '添加中…';
  try {
    const res = await fetch('/api/online/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roomId: roomCode,
        trackId: track.id,
        name: track.name,
        artist: track.artist,
        nickname,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '添加失败');
    btn.textContent = '✓ 已添加';
  } catch (e) {
    btn.textContent = e.message || '添加失败';
  }
  setTimeout(() => {
    btn.disabled = false;
    btn.textContent = '+ 添加';
  }, 2000);
}
```

`leaveRoom()` 中追加 `setSearchTab('local');`。

- [ ] **Step 3: styles.css 添加标签页与角标样式**

```css
.search-tabs {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
}

.tab {
  flex: 1;
  padding: 9px 0;
  border-radius: 10px;
  background: #1e212c;
  color: #8a8f9c;
  font-size: 14px;
  text-align: center;
}

.tab.active {
  background: #5865f2;
  color: #fff;
}

.lib-badge {
  flex-shrink: 0;
  padding: 2px 7px;
  border-radius: 6px;
  font-size: 11px;
  color: #fff;
}

.lib-badge.netease {
  background: #c62f2f;
}

.lib-badge.migu {
  background: #1f9d55;
}

.lib-meta {
  flex-shrink: 0;
  color: #8a8f9c;
  font-size: 12px;
}
```

- [ ] **Step 4: 语法检查**

```bash
node --check public/app.js
```

- [ ] **Step 5: 提交**

```bash
git add public/index.html public/app.js public/styles.css
git commit -m "新增：搜索来源切换与在线音乐结果添加"
```

## Task 4: 文档同步

**Files:** Modify: `README.md`、`AGENTS.md`

- [ ] **Step 1: README 增加在线曲库说明**

在“本地曲库”小节后新增：

```markdown
## 在线曲库

- 在播放列表搜索框切到“在线音乐”，可搜索网易云与咪咕的免费歌曲并添加
- 添加时歌曲会下载到 `library/online/`，之后按本地文件播放，全房间同步
- 网易云无版权/会员受限的歌会自动尝试咪咕同歌换源；会员（VIP）歌不可添加
- 在线接口为非官方接口，可能随时失效；仅供个人/小圈子测试，勿商用
```

- [ ] **Step 2: AGENTS.md 更新**

`代码结构` 增加 `online.js`；`下一步目标` 删除已完成的联网搜索条目（保留占位清理）。

- [ ] **Step 3: 提交**

```bash
git add README.md AGENTS.md
git commit -m "docs: 在线曲库使用说明与项目结构更新"
```

## Task 5: 真实接口冒烟验证

- [ ] **Step 1: 启动服务（测试端口）**

```bash
PORT=3200 node server.js
```

- [ ] **Step 2: 搜索与添加验证**

```bash
curl --get --data-urlencode 'q=晴天' http://localhost:3200/api/online/search
```

预期：返回网易云翻唱 + 咪咕原版（含 `playable: true`）。

创建房间（node + ws）→ `POST /api/online/add` 咪咕《晴天》→ 检查 `library/online/migu-*.mp3` 存在且可播（`afinfo` 时长 ≈ 270 秒）。

## Task 6: 对抗式审查与收尾

- [ ] **Step 1: 对新增功能做对抗式审查**

重点：SSRF（下载地址白名单）、trackId 解析与路径穿越、限速绕过、缓存膨胀、下载文件复用、换源误匹配、前端 XSS。

- [ ] **Step 2: 修复发现的问题并补测试**

- [ ] **Step 3: 全量测试**

```bash
node --test
```

- [ ] **Step 4: 提交修复**

```bash
git add -A
git commit -m "修复：对抗式审查发现的问题"
```

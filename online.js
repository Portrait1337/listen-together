// 在线音乐提供者：网易云 + 咪咕，统一搜索与下载（双源自动换源）
// 所有第三方地址、超时、大小限制都可用环境变量覆盖，便于测试与维护。
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { resolveConfigFile } = require('./config-paths');

const NETEASE_BASE = process.env.NETEASE_BASE || 'https://music.163.com';
const MIGU_BASE = process.env.MIGU_BASE || 'https://app.pd.nf.migu.cn';
function neteaseCookieFile() {
  return resolveConfigFile('netease-cookie.txt', process.env.NETEASE_COOKIE_FILE);
}
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

async function httpJson(url, fetchImpl, extraHeaders = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json', ...extraHeaders },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 网易云会员 Cookie ----------
let neteaseCookieCache = { version: undefined, value: undefined, at: 0 };

// 优先取环境变量 NETEASE_COOKIE；否则读 netease-cookie.txt（30 秒缓存，改文件即生效）
function getNeteaseCookie() {
  if (process.env.NETEASE_COOKIE) return process.env.NETEASE_COOKIE.trim() || null;
  const now = Date.now();
  const version = getNeteaseCookieVersion();
  if (
    neteaseCookieCache.value !== undefined &&
    neteaseCookieCache.version === version &&
    now - neteaseCookieCache.at < 30000
  ) {
    return neteaseCookieCache.value;
  }
  let value = null;
  try {
    value = fs.readFileSync(neteaseCookieFile(), 'utf8').trim() || null;
  } catch {}
  neteaseCookieCache = { version, value, at: now };
  return value;
}

// Cookie 配置的版本标识：环境变量用长度，文件用 mtime，便于服务端感知"是否变了"
function getNeteaseCookieVersion() {
  if (process.env.NETEASE_COOKIE) return 'env:' + process.env.NETEASE_COOKIE.length;
  try {
    const file = neteaseCookieFile();
    return 'file:' + file + ':' + fs.statSync(file).mtimeMs;
  } catch {
    return 'file:none';
  }
}

// 校验会员登录态：调账号接口，有 profile 才算有效
async function checkNeteaseLogin(fetchImpl = fetch) {
  const cookie = getNeteaseCookie();
  if (!cookie) return { valid: false, nickname: '' };
  try {
    const data = await httpJson(`${NETEASE_BASE}/api/nuser/account/get`, fetchImpl, {
      Cookie: cookie,
      Referer: `${NETEASE_BASE}/`,
    });
    const profile = data && data.profile;
    return { valid: !!profile, nickname: (profile && profile.nickname) || '' };
  } catch {
    return { valid: false, nickname: '' };
  }
}

// 用会员 Cookie 取播放地址；拿不到返回 null
async function resolveNeteaseVipUrl(id, fetchImpl = fetch) {
  const cookie = getNeteaseCookie();
  if (!cookie) return null;
  const url = `${NETEASE_BASE}/api/song/enhance/player/url?id=${id}&ids=[${id}]&br=320000`;
  const data = await httpJson(url, fetchImpl, {
    Cookie: cookie,
    Referer: `${NETEASE_BASE}/`,
  });
  const item = data && data.data && data.data[0];
  return item && typeof item.url === 'string' && item.url ? item.url : null;
}

async function neteaseSearch(q, fetchImpl) {
  const url = `${NETEASE_BASE}/api/search/get/web?s=${encodeURIComponent(q)}&type=1&limit=50`;
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
  // 咪咕每页最多 20 条：连续取 3 页，某页失败或不足一页就提前停
  const all = [];
  for (let page = 1; page <= 3; page += 1) {
    let list;
    try {
      const params = new URLSearchParams({
        ua: 'Android_migu',
        version: '5.1',
        text: q,
        pageNo: String(page),
        pageSize: '20',
        searchSwitch: JSON.stringify({ song: 1 }),
      });
      const url = `${MIGU_BASE}/MIGUM2.0/v1.0/content/search_all.do?${params}`;
      const data = await httpJson(url, fetchImpl);
      list = (data && data.songResultData && data.songResultData.result) || [];
    } catch {
      break;
    }
    all.push(...list);
    if (list.length < 20) break;
  }
  return all.map((s) => ({
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
  try {
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
    const st = fs.statSync(tmp);
    if (st.size < 1024 || st.size > MAX_SIZE) throw new Error('文件大小异常');
    fs.renameSync(tmp, dest);
    return st.size;
  } catch (e) {
    // 下载中断/校验失败时清掉半成品，避免残留 .tmp 文件
    fs.unlink(tmp, () => {});
    throw e;
  }
}

function pickMiguFallback(results, name, artist) {
  const n = String(name || '').toLowerCase();
  const a = String(artist || '').toLowerCase();
  // 只接受歌名匹配的结果，避免换源换成另一首歌
  return (
    results.find(
    (r) =>
      r.name.toLowerCase().includes(n) &&
      (!a || r.artist.toLowerCase().includes(a) || a.includes(r.artist.toLowerCase()))
    ) || null
  );
}

async function downloadMiguTrack(song, destDir, fetchImpl) {
  // 第三方返回的歌曲 id 必须与 parseTrackId 同一字符集：
  // 换源分支直接信任搜索结果里的原始 id，若含路径分隔符会拼进文件名造成路径穿越
  const rawId = String((song && song.id) || '');
  if (!/^[0-9A-Za-z]+$/.test(rawId)) return { error: '歌曲标识无效' };
  const url = await miguResolveUrl(
    { audioId: rawId, contentId: song.contentId, copyrightId: song.copyrightId },
    fetchImpl
  );
  if (!url) return { error: '该歌曲受版权或会员限制，暂时无法播放' };
  const file = `migu-${rawId}.mp3`;
  await downloadAudio(url, path.join(destDir, file), fetchImpl);
  return { file, provider: 'migu', name: song.name || `咪咕歌曲 ${rawId}` };
}

async function searchOnline(q, { source = 'all', fetchImpl = fetch } = {}) {
  const wantNe = source === 'all' || source === 'netease';
  const wantMg = source === 'all' || source === 'migu';
  const [ne, mg] = await Promise.allSettled([
    wantNe ? neteaseSearch(q, fetchImpl) : Promise.resolve([]),
    wantMg ? miguSearch(q, fetchImpl) : Promise.resolve([]),
  ]);
  const results = [];
  const seen = new Set();
  const pushUnique = (list) => {
    for (const t of list) {
      // 按“歌名+歌手”去重：同歌不同源只保留先出现的（咪咕优先）
      const key = (t.name + '|' + t.artist).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(t);
    }
  };
  // 咪咕优先展示：版权覆盖更全（如周杰伦原版），搜索结果先展示咪咕；
  // 每源最多 20 条，避免单源结果过多时把另一源完全挤出
  if (mg.status === 'fulfilled') pushUnique(mg.value.slice(0, 60));
  if (ne.status === 'fulfilled') pushUnique(ne.value.slice(0, 50));
  return {
    total: results.length,
    results,
    degraded: (wantNe && ne.status !== 'fulfilled') || (wantMg && mg.status !== 'fulfilled'),
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
      // 免费外链不可播：先试会员流式（有 Cookie 时），再咪咕换源
      try {
        const vipUrl = await resolveNeteaseVipUrl(meta.neteaseId, fetchImpl);
        if (vipUrl) {
          return {
            streamUrl: vipUrl,
            provider: 'netease',
            name: name || `网易云歌曲 ${meta.neteaseId}`,
            vip: true,
          };
        }
      } catch {}
      const q = [artist, name].filter(Boolean).join(' ').trim();
      if (q) {
        try {
          const found = await miguSearch(q, fetchImpl);
          const pick = pickMiguFallback(found, name, artist);
          if (pick) {
            // pick 是归一化搜索结果，id 形如 migu:<audioId>:<contentId>:<copyrightId>，
            // 下载时需要还原成原始字段
            const parts = String(pick.id).split(':');
            const done = await downloadMiguTrack(
              {
                id: parts[1],
                contentId: parts[2],
                copyrightId: parts[3],
                name: pick.name,
              },
              destDir,
              fetchImpl
            );
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
  checkNeteaseLogin,
  resolveNeteaseVipUrl,
  getNeteaseCookieVersion,
};

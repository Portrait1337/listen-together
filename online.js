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
};

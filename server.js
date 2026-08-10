const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 3000;
const MAX_UPLOAD = 200 * 1024 * 1024; // 200MB
const EMPTY_ROOM_TTL = Number(process.env.EMPTY_ROOM_TTL_MS) || 30 * 1000; // 全新空房间 30 秒后销毁
const ACTIVE_ROOM_TTL = Number(process.env.ACTIVE_ROOM_TTL_MS) || 3 * 60 * 1000; // 播放过/加过歌/聊过天的房间 3 分钟后销毁
const ORPHAN_UPLOAD_TTL = Number(process.env.ORPHAN_UPLOAD_TTL_MS) || 60 * 60 * 1000; // 无人引用的上传文件 1 小时后清理
const LIBRARY_INDEX_REFRESH_MS = Number(process.env.LIBRARY_INDEX_REFRESH_MS) || 30 * 1000; // 曲库索引刷新间隔
const MAX_CONCURRENT_UPLOADS_PER_IP = Number(process.env.MAX_CONCURRENT_UPLOADS_PER_IP) || 2;
const MAX_UPLOADS_PER_MINUTE_PER_IP = Number(process.env.MAX_UPLOADS_PER_MINUTE_PER_IP) || 10;
const SINGLE_LOOP_DEDUP_MS = Number(process.env.SINGLE_LOOP_DEDUP_MS) || 1500; // 单曲循环只拦 1.5 秒内的重复信号
const MAX_WS_CONNECTIONS = Number(process.env.MAX_WS_CONNECTIONS) || 100; // 单实例最大 WebSocket 连接数，防无认证刷连接耗尽内存
const MAX_WS_MSGS_PER_SECOND = Number(process.env.MAX_WS_MSGS_PER_SECOND) || 20; // 每连接每秒最大消息数，防刷屏轰炸拖垮全房间广播
const AUDIO_EXTS = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.opus', '.wma', '.amr'];

// 目录支持环境变量覆盖：测试用它指向临时目录，避免污染/误删真实上传文件
const UPLOAD_DIR = process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : path.join(__dirname, 'uploads');
const LIBRARY_DIR = process.env.LIBRARY_DIR ? path.resolve(process.env.LIBRARY_DIR) : path.join(__dirname, 'library');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(LIBRARY_DIR, { recursive: true });

const app = express();
// 只信任本机隧道（cpolar/cloudflared 都在本机跑）写入的 X-Forwarded-For：
// 公网直连时 socket 对端不是 loopback，XFF 会被完全忽略，限流拿到的就是真实 IP，
// 攻击者无法再靠伪造 XFF 头绕过上传限流。
app.set('trust proxy', 'loopback');
const server = http.createServer(app);

// ---------- 音频上传 ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname) || '.mp3').toLowerCase();
    cb(null, crypto.randomBytes(8).toString('hex') + ext);
  },
});

const upload = multer({
  storage,
  defParamCharset: 'utf8',
  limits: { fileSize: MAX_UPLOAD },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    // 只按扩展名白名单收文件：mimetype 是客户端随便填的，不能作为放行依据，
    // 否则可以上传 .html/.svg 等可执行脚本的同源文件
    if (AUDIO_EXTS.includes(ext)) return cb(null, true);
    cb(new Error('只支持音频文件'));
  },
});

// 校验文件头 magic bytes：扩展名白名单之外的第二道防线，
// 防止把 HTML/脚本等任意内容伪装成音频存进同源目录。
// 只认常见格式的标准文件头，能覆盖绝大多数合法音频。
async function looksLikeAudio(filePath, originalname) {
  let fh;
  try {
    fh = await fs.promises.open(filePath, 'r');
    const buf = Buffer.alloc(16);
    const { bytesRead } = await fh.read(buf, 0, 16, 0);
    if (bytesRead < 4) return false;
    const head = buf.subarray(0, bytesRead);
    const ext = path.extname(originalname || '').toLowerCase();
    switch (ext) {
      case '.mp3':
        // ID3 标签，或 MPEG 帧同步字 0xFFEx/0xFFFx
        return head.subarray(0, 3).equals(Buffer.from('ID3')) || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0);
      case '.wav':
        return head.subarray(0, 4).equals(Buffer.from('RIFF')) && head.subarray(8, 12).equals(Buffer.from('WAVE'));
      case '.flac':
        return head.subarray(0, 4).equals(Buffer.from('fLaC'));
      case '.ogg':
      case '.opus':
        return head.subarray(0, 4).equals(Buffer.from('OggS'));
      case '.amr':
        return head.subarray(0, 5).equals(Buffer.from('#!AMR'));
      case '.wma':
        // ASF 文件 GUID 头
        return head
          .subarray(0, 16)
          .equals(Buffer.from([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c]));
      case '.m4a':
      case '.aac':
        // MP4 容器 '....ftyp'，或 ADTS 同步字 0xFFF
        return head.subarray(4, 8).equals(Buffer.from('ftyp')) || (head[0] === 0xff && (head[1] & 0xf0) === 0xf0);
      default:
        return false;
    }
  } catch {
    return false;
  } finally {
    if (fh) await fh.close();
  }
}

// ---------- 上传限流：防止无认证情况下被刷爆磁盘 ----------
const uploadActivity = new Map(); // ip -> { concurrent, times }

function clientIp(req) {
  // 不直接信任客户端自报的 X-Forwarded-For：
  // trust proxy 只对 loopback（本机隧道）放开 XFF，公网直连时 req.ip 就是 socket 真实地址
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function beginUpload(req, res, next) {
  const ip = clientIp(req);
  const now = Date.now();
  const rec = uploadActivity.get(ip) || { concurrent: 0, times: [] };
  rec.times = rec.times.filter((t) => now - t < 60000);
  if (rec.concurrent >= MAX_CONCURRENT_UPLOADS_PER_IP || rec.times.length >= MAX_UPLOADS_PER_MINUTE_PER_IP) {
    return res.status(429).json({ error: '上传太频繁，请稍后再试' });
  }
  rec.concurrent += 1;
  uploadActivity.set(ip, rec);
  let ended = false;
  const done = () => {
    if (ended) return;
    ended = true;
    rec.concurrent = Math.max(0, rec.concurrent - 1);
    rec.times.push(Date.now());
    rec.times = rec.times.filter((t) => Date.now() - t < 60000);
    if (rec.concurrent === 0 && rec.times.length === 0) uploadActivity.delete(ip);
  };
  res.on('finish', done);
  res.on('close', done);
  next();
}

// 清理无人引用的上传文件（房间销毁、上传失败都会留下孤儿文件）
function cleanupOrphanUploads() {
  const referenced = new Set();
  for (const room of rooms.values()) {
    for (const t of room.playlist) {
      if (typeof t.url === 'string' && t.url.startsWith('/uploads/')) {
        referenced.add(path.basename(t.url));
      }
    }
  }
  let entries;
  try {
    entries = fs.readdirSync(UPLOAD_DIR);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of entries) {
    if (referenced.has(name)) continue;
    const full = path.join(UPLOAD_DIR, name);
    try {
      const st = fs.statSync(full);
      if (!st.isFile() || now - st.mtimeMs < ORPHAN_UPLOAD_TTL) continue;
      fs.unlink(full, () => {});
    } catch {}
  }
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(
  '/uploads',
  express.static(UPLOAD_DIR, {
    setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
  })
);
app.use(
  '/library',
  express.static(LIBRARY_DIR, {
    setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
  })
);
app.use(express.json());

// 上传歌曲期间房间不清零：请求一开始就把房间标记为"正在上传"，
// 这样即使上传者的连接恰好断掉，清理倒计时也会等上传结束再开始。
app.post('/api/upload', beginUpload, (req, res, next) => {
  const room = rooms.get(String(req.query.roomId || '').toUpperCase().trim());
  if (room) {
    room.activeUploads = (room.activeUploads || 0) + 1;
    // 可能已有排定的销毁计时（空房间倒计时）：上传期间必须取消，等上传结束再重新计时
    clearTimeout(roomTimers.get(room.code));
    roomTimers.delete(room.code);
    res.on('finish', () => {
      room.activeUploads = Math.max(0, (room.activeUploads || 1) - 1);
      if (room.members.size === 0) scheduleRoomDestroy(room);
    });
  }
  next();
}, upload.single('file'), async (req, res) => {
  // 没带 file 字段（或字段名不对）：multer 不会报错，直接拒绝
  if (!req.file || !req.file.path) {
    return res.status(400).json({ error: '没有收到有效的音频文件' });
  }
  // 内容校验：扩展名白名单之外的第二道防线，伪装成音频的任意内容直接拒绝并删文件
  if (!(await looksLikeAudio(req.file.path, req.file.originalname))) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: '文件内容不是有效的音频' });
  }
  const room = rooms.get(
    String((req.body && req.body.roomId) || req.query.roomId || '').toUpperCase().trim()
  );
  if (!room) {
    // 文件已经落盘：房间不存在就删掉，避免留下孤儿文件
    if (req.file && req.file.path) fs.unlink(req.file.path, () => {});
    return res.status(404).json({ error: '房间不存在，请重新加入' });
  }
  const track = {
    id: crypto.randomBytes(6).toString('hex'),
    name: req.file.originalname,
    url: '/uploads/' + req.file.filename,
    size: req.file.size,
    uploader: String(req.body.nickname || '匿名').trim().slice(0, 20) || '匿名',
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

// ---------- 本地曲库：搜索与添加 ----------
function libraryUrl(relPath) {
  return '/library/' + relPath.split('/').map(encodeURIComponent).join('/');
}

// 曲库索引：启动时异步建立，之后定期刷新。
// 不要在每次搜索时同步遍历整个目录，否则大曲库会阻塞所有房间的实时通信。
let libraryIndex = [];
let libraryIndexLoading = null;

async function walkLibrary(dir, prefix, out) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      await walkLibrary(path.join(dir, entry.name), prefix ? prefix + '/' + entry.name : entry.name, out);
    } else if (entry.isFile() && AUDIO_EXTS.includes(path.extname(entry.name).toLowerCase())) {
      const rel = prefix ? prefix + '/' + entry.name : entry.name;
      const full = path.join(dir, entry.name);
      let size = 0;
      try {
        size = (await fs.promises.stat(full)).size;
      } catch {}
      out.push({ id: rel, name: entry.name, url: libraryUrl(rel), size, source: 'library' });
    }
  }
}

function refreshLibraryIndex() {
  if (libraryIndexLoading) return libraryIndexLoading;
  libraryIndexLoading = (async () => {
    const tracks = [];
    await walkLibrary(LIBRARY_DIR, '', tracks);
    libraryIndex = tracks;
  })().finally(() => {
    libraryIndexLoading = null;
  });
  return libraryIndexLoading;
}

// 根据曲库 id 校验并返回曲目，防止路径穿越
function findLibraryTrack(trackId) {
  const id = String(trackId || '').trim();
  if (!id) return null;
  const full = path.resolve(LIBRARY_DIR, id);
  if (full !== LIBRARY_DIR && !full.startsWith(LIBRARY_DIR + path.sep)) return null;
  let st;
  try {
    st = fs.statSync(full);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  if (!AUDIO_EXTS.includes(path.extname(full).toLowerCase())) return null;
  return { id, name: path.basename(full), url: libraryUrl(id), size: st.size, source: 'library' };
}

app.get('/api/library/search', async (req, res) => {
  if (libraryIndex.length === 0) await refreshLibraryIndex();
  const q = String(req.query.q || '').trim().toLowerCase().slice(0, 100);
  const all = libraryIndex;
  const results = q ? all.filter((t) => t.name.toLowerCase().includes(q)) : all;
  res.json({ total: all.length, results: results.slice(0, 20) });
});

app.post('/api/library/add', (req, res) => {
  const room = rooms.get(String(req.body.roomId || '').toUpperCase().trim());
  if (!room) {
    return res.status(404).json({ error: '房间不存在，请重新加入' });
  }
  const entry = findLibraryTrack(req.body.trackId);
  if (!entry) {
    return res.status(404).json({ error: '曲库里没有这首歌，请重新搜索' });
  }
  const track = {
    id: crypto.randomBytes(6).toString('hex'),
    name: entry.name,
    url: entry.url,
    size: entry.size,
    uploader: String(req.body.nickname || '匿名').trim().slice(0, 20) || '匿名',
    fromLibrary: true,
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

// multer 等上传错误统一返回
app.use((err, req, res, next) => {
  // multer 出错时把已落盘的半成品文件清掉，避免留下孤儿文件
  if (req.file && req.file.path) fs.unlink(req.file.path, () => {});
  res.status(400).json({ error: err.message || '上传失败' });
});

// ---------- 房间与实时同步 ----------
const rooms = new Map();
const roomTimers = new Map();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function makeCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 6; i++) code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
  } while (rooms.has(code));
  return code;
}

function effectivePosition(room) {
  return room.playing ? room.positionMs + (Date.now() - room.updatedAt) : room.positionMs;
}

function snapshot(room) {
  return {
    type: 'state',
    code: room.code,
    name: room.name,
    currentIndex: room.currentIndex,
    playing: room.playing,
    playMode: room.playMode,
    positionMs: room.positionMs,
    updatedAt: room.updatedAt,
    serverTime: Date.now(),
    playlist: room.playlist,
  };
}

function membersList(room) {
  return Array.from(room.members.values()).map((m) => ({ nickname: m.nickname }));
}

function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  for (const member of room.members.keys()) {
    if (member.readyState === WebSocket.OPEN) member.send(data);
  }
}

function createRoom(name, ws, nickname) {
  const room = {
    code: makeCode(),
    name: String(name || '一起听').trim().slice(0, 30) || '一起听',
    members: new Map(),
    activeUploads: 0,
    playlist: [],
    chatHistory: [],
    currentIndex: -1,
    playing: false,
    playMode: 'order', // order=顺序 shuffle=随机 single=单曲循环
    lastEndedAt: 0,
    lastEndedTrackId: '',
    positionMs: 0,
    updatedAt: Date.now(),
  };
  rooms.set(room.code, room);
  room.members.set(ws, { nickname });
  return room;
}

function addMember(room, ws, nickname) {
  room.members.set(ws, { nickname });
  clearTimeout(roomTimers.get(room.code));
}

// 没人连接时按房间类型安排销毁：
// - 全新空房间：30 秒后销毁，避免垃圾房间占内存
// - 播放过/加过歌/聊过天的房间：保留 3 分钟等人重连，防止网络闪断或手机锁屏后房间消失
function scheduleRoomDestroy(room) {
  clearTimeout(roomTimers.get(room.code));
  // 有人正在上传歌曲时先不清理，等上传结束再重新计时
  if (room.activeUploads > 0) return;
  const used = room.playlist.length > 0 || room.chatHistory.length > 0;
  const ttl = used ? ACTIVE_ROOM_TTL : EMPTY_ROOM_TTL;
  roomTimers.set(
    room.code,
    setTimeout(() => {
      roomTimers.delete(room.code);
      // 有人已经重新进房就不销毁；有上传进行中也不销毁，等上传结束再重新计时
      if (room.members.size === 0 && room.activeUploads === 0) rooms.delete(room.code);
    }, ttl)
  );
}

function removeMember(room, ws) {
  room.members.delete(ws);
  if (room.members.size === 0) {
    scheduleRoomDestroy(room);
  }
}

function cleanNick(n) {
  const s = String(n || '').trim();
  return s ? s.slice(0, 20) : '匿名';
}

function randomTrackIndex(room) {
  if (room.playlist.length <= 1) return 0;
  let i = crypto.randomInt(room.playlist.length);
  if (i === room.currentIndex) i = (i + 1) % room.playlist.length;
  return i;
}

function nextTrackIndex(room) {
  if (room.playMode === 'shuffle') return randomTrackIndex(room);
  return (room.currentIndex + 1) % room.playlist.length;
}

function prevTrackIndex(room) {
  if (room.playMode === 'shuffle') return randomTrackIndex(room);
  return (room.currentIndex - 1 + room.playlist.length) % room.playlist.length;
}

function handleControl(room, msg) {
  const now = Date.now();
  switch (msg.action) {
    case 'play':
      if (room.playlist.length === 0) return;
      if (room.currentIndex < 0) room.currentIndex = 0;
      if (!room.playing) {
        room.playing = true;
        room.updatedAt = now;
      }
      break;
    case 'pause':
      if (room.playing) {
        room.positionMs = effectivePosition(room);
        room.playing = false;
        room.updatedAt = now;
      }
      break;
    case 'seek': {
      const pos = Number(msg.positionMs);
      if (!Number.isFinite(pos)) return;
      room.positionMs = Math.max(0, pos);
      room.updatedAt = now;
      break;
    }
    case 'next':
      if (room.playlist.length === 0) return;
      room.currentIndex = nextTrackIndex(room);
      room.positionMs = 0;
      room.updatedAt = now;
      break;
    case 'prev':
      if (room.playlist.length === 0) return;
      room.currentIndex = prevTrackIndex(room);
      room.positionMs = 0;
      room.updatedAt = now;
      break;
    case 'ended': {
      // 歌曲自然播完：按播放模式决定下一首
      if (room.playlist.length === 0) return;
      // 没在播放就不可能"自然播完"，拒绝伪造的播完信号
      if (!room.playing) return;
      const currentTrack = room.playlist[room.currentIndex];
      const reported = String(msg.trackId || '');
      // 必须带 trackId 且匹配当前正在播的歌；迟到的旧信号直接忽略
      if (!reported || !currentTrack || reported !== currentTrack.id) return;
      const key = currentTrack.id;
      // 防止多个设备重复上报导致连切：
      // - 顺序/随机：同一首歌 10 秒内只处理一次（换歌后编号不同，不会误伤）
      // - 单曲循环：短歌会很快再次自然播完，所以只拦 1.5 秒内的重复信号
      const dedupMs = room.playMode === 'single' ? SINGLE_LOOP_DEDUP_MS : 10000;
      if (room.lastEndedTrackId === key && now - room.lastEndedAt < dedupMs) return;
      room.lastEndedTrackId = key;
      room.lastEndedAt = now;
      if (room.playMode === 'single') {
        // 单曲循环：停在同一首重新播
        room.positionMs = 0;
        room.updatedAt = now;
      } else {
        room.currentIndex = nextTrackIndex(room);
        room.positionMs = 0;
        room.updatedAt = now;
      }
      break;
    }
    case 'set_mode': {
      const mode = String(msg.mode || '');
      if (mode !== 'order' && mode !== 'shuffle' && mode !== 'single') return;
      room.playMode = mode;
      break;
    }
    case 'select': {
      const idx = Number(msg.index);
      if (!Number.isInteger(idx) || idx < 0 || idx >= room.playlist.length) return;
      room.currentIndex = idx;
      room.positionMs = 0;
      room.updatedAt = now;
      break;
    }
  }
}

// maxPayload：正常消息（控制/聊天/心跳）都远小于 64KB，限制单条消息大小防内存轰炸
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

wss.on('connection', (ws) => {
  // 连接数上限：无认证场景下防刷连接耗尽内存/句柄
  if (wss.clients.size > MAX_WS_CONNECTIONS) {
    ws.close(1013, '服务器繁忙，请稍后再试');
    return;
  }
  let room = null;
  let nickname = '匿名';
  const msgTimes = []; // 消息节流滑动窗口：记录最近 1 秒内的消息时间戳

  const send = (obj) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  };

  ws.on('message', (raw) => {
    // 每连接每秒消息数上限：超速（刷屏/控制轰炸）直接断开，防单连接拖垮全房间广播
    const now = Date.now();
    msgTimes.push(now);
    while (msgTimes.length > 0 && now - msgTimes[0] > 1000) msgTimes.shift();
    if (msgTimes.length > MAX_WS_MSGS_PER_SECOND) {
      ws.close(1008, '消息发送过快');
      return;
    }
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    // 消息必须是普通对象：JSON.parse('null'/'123'/"字符串") 不会抛错，
    // 但 null 之类的结果会让 msg.type 解引用崩溃，直接导致整个服务进程退出
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;

    switch (msg.type) {
      case 'create_room':
        if (room) return;
        nickname = cleanNick(msg.nickname);
        room = createRoom(msg.name, ws, nickname);
        send({ type: 'room_created', code: room.code });
        send(snapshot(room));
        send({ type: 'members', members: membersList(room) });
        break;

      case 'join_room': {
        if (room) return;
        const code = String(msg.code || '').toUpperCase().trim();
        const target = rooms.get(code);
        if (!target) {
          send({ type: 'error', message: '房间不存在，请检查房间码' });
          return;
        }
        nickname = cleanNick(msg.nickname);
        room = target;
        addMember(room, ws, nickname);
        send({ type: 'chat_history', messages: room.chatHistory });
        send(snapshot(room));
        send({ type: 'members', members: membersList(room) });
        broadcast(room, { type: 'member_joined', nickname, members: membersList(room) });
        break;
      }

      case 'control':
        if (!room) return;
        handleControl(room, msg);
        if (msg.action === 'set_mode') {
          // 切换模式是纯设置：不改变当前播放进度，单独广播避免触发播放器对齐/播放逻辑
          broadcast(room, { type: 'mode_changed', playMode: room.playMode });
        } else {
          broadcast(room, snapshot(room));
        }
        break;

      case 'remove_track':
        if (!room) return;
        {
          const idx = room.playlist.findIndex((t) => t.id === String(msg.trackId || ''));
          if (idx < 0) break;
          room.playlist.splice(idx, 1);
          if (room.playlist.length === 0) {
            // 歌都删完了：停止播放并回到空状态
            room.currentIndex = -1;
            room.positionMs = 0;
            room.playing = false;
            room.updatedAt = Date.now();
          } else if (idx < room.currentIndex) {
            // 删掉的是当前歌之前的歌，当前序号前移一位
            room.currentIndex -= 1;
          } else if (idx === room.currentIndex) {
            // 删掉的是正在播的歌：自动切到下一首继续播
            if (room.currentIndex >= room.playlist.length) room.currentIndex = 0;
            room.positionMs = 0;
            room.updatedAt = Date.now();
          }
          broadcast(room, snapshot(room));
        }
        break;

      case 'chat':
        if (!room) return;
        {
          const text = String(msg.text || '').trim().slice(0, 200);
          if (text) {
            const chat = { nickname, text, time: Date.now() };
            room.chatHistory.push(chat);
            if (room.chatHistory.length > 100) room.chatHistory.shift();
            broadcast(room, { type: 'chat', ...chat });
          }
        }
        break;

      case 'ping':
        send({ type: 'pong', t1: msg.t1, serverTime: Date.now() });
        break;

      case 'request_state':
        if (!room) return;
        send(snapshot(room));
        send({ type: 'members', members: membersList(room) });
        break;
    }
  });

  ws.on('close', () => {
    if (room) {
      removeMember(room, ws);
      if (room.members.size > 0) {
        broadcast(room, { type: 'member_left', nickname, members: membersList(room) });
      }
    }
  });

  ws.on('error', () => {});
});

server.listen(PORT, () => {
  console.log('一起听已启动：http://localhost:' + PORT);
  // 启动时异步建立曲库索引并清理一次孤儿上传文件
  refreshLibraryIndex();
  cleanupOrphanUploads();
});

// 曲库索引定期刷新；孤儿文件每天清理几次，防止磁盘被慢慢占满
setInterval(refreshLibraryIndex, LIBRARY_INDEX_REFRESH_MS).unref();
setInterval(cleanupOrphanUploads, 6 * 60 * 60 * 1000).unref();

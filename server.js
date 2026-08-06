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
const AUDIO_EXTS = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.opus', '.wma', '.amr'];

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const LIBRARY_DIR = path.join(__dirname, 'library');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(LIBRARY_DIR, { recursive: true });

const app = express();
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
    if (file.mimetype && file.mimetype.startsWith('audio/')) return cb(null, true);
    if (AUDIO_EXTS.includes(ext)) return cb(null, true); // m4a 等文件类型标识不标准时，按扩展名放行
    cb(new Error('只支持音频文件'));
  },
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));
app.use('/library', express.static(LIBRARY_DIR));
app.use(express.json());

// 上传歌曲期间房间不清零：请求一开始就把房间标记为"正在上传"，
// 这样即使上传者的连接恰好断掉，清理倒计时也会等上传结束再开始。
app.post('/api/upload', (req, res, next) => {
  const room = rooms.get(String(req.query.roomId || '').toUpperCase().trim());
  if (room) {
    room.activeUploads = (room.activeUploads || 0) + 1;
    res.on('finish', () => {
      room.activeUploads = Math.max(0, (room.activeUploads || 1) - 1);
      if (room.members.size === 0) scheduleRoomDestroy(room);
    });
  }
  next();
}, upload.single('file'), (req, res) => {
  const room = rooms.get(
    String((req.body && req.body.roomId) || req.query.roomId || '').toUpperCase().trim()
  );
  if (!room) {
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

// 扫描曲库目录（含子文件夹），只收录音频文件
function scanLibrary() {
  const tracks = [];
  const walk = (dir, prefix) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), prefix ? prefix + '/' + entry.name : entry.name);
      } else if (entry.isFile() && AUDIO_EXTS.includes(path.extname(entry.name).toLowerCase())) {
        const rel = prefix ? prefix + '/' + entry.name : entry.name;
        const full = path.join(dir, entry.name);
        let size = 0;
        try {
          size = fs.statSync(full).size;
        } catch {}
        tracks.push({ id: rel, name: entry.name, url: libraryUrl(rel), size, source: 'library' });
      }
    }
  };
  walk(LIBRARY_DIR, '');
  return tracks;
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

app.get('/api/library/search', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase().slice(0, 100);
  const all = scanLibrary();
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
      // 有人已经重新进房就不销毁
      if (room.members.size === 0) rooms.delete(room.code);
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
      room.currentIndex = (room.currentIndex + 1) % room.playlist.length;
      room.positionMs = 0;
      room.updatedAt = now;
      break;
    case 'prev':
      if (room.playlist.length === 0) return;
      room.currentIndex = (room.currentIndex - 1 + room.playlist.length) % room.playlist.length;
      room.positionMs = 0;
      room.updatedAt = now;
      break;
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

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  let room = null;
  let nickname = '匿名';

  const send = (obj) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  };

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

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
        broadcast(room, snapshot(room));
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
});

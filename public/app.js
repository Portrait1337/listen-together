const $ = (id) => document.getElementById(id);

const ui = {
  landing: $('landing'),
  room: $('room'),
  nickname: $('nickname'),
  roomCodeInput: $('roomCode'),
  createBtn: $('createBtn'),
  joinBtn: $('joinBtn'),
  hint: $('landingHint'),
  roomCodeLabel: $('roomCodeLabel'),
  copyBtn: $('copyBtn'),
  memberCount: $('memberCount'),
  memberList: $('memberList'),
  nowPlaying: $('nowPlaying'),
  nowUploader: $('nowUploader'),
  playBtn: $('playBtn'),
  prevBtn: $('prevBtn'),
  nextBtn: $('nextBtn'),
  seek: $('seek'),
  timeLabel: $('timeLabel'),
  playlist: $('playlist'),
  fileInput: $('fileInput'),
  uploadBtn: $('uploadBtn'),
  chatList: $('chatList'),
  chatInput: $('chatInput'),
  chatSend: $('chatSend'),
  unlock: $('unlock'),
};

const audio = new Audio();
audio.preload = 'auto';

let ws = null;
let roomCode = null;
let nickname = '';
let state = null;
let members = [];
let offset = 0; // 估算的服务器时间 - 本地时间
let pendingAlign = null;
let reconnectTimer = null;
let creatingRoom = false;
let dragging = false;

// ---------- 连接 ----------
function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  ws = new WebSocket(proto + location.host + '/ws');
  ws.onopen = async () => {
    await estimateOffset();
    if (creatingRoom) {
      creatingRoom = false;
      send({ type: 'create_room', name: '一起听', nickname });
    } else if (roomCode) {
      send({ type: 'join_room', code: roomCode, nickname });
    }
  };
  ws.onmessage = (ev) => {
    let d;
    try {
      d = JSON.parse(ev.data);
    } catch {
      return;
    }
    handleMessage(d);
  };
  ws.onclose = () => {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 2000);
  };
  ws.onerror = () => {
    try {
      ws.close();
    } catch {}
  };
}

// 通过 ping/pong 估算服务器时间与本地时间的差值，用于进度对齐
function estimateOffset() {
  return new Promise((resolve) => {
    const t1 = Date.now();
    const onMsg = (ev) => {
      let d;
      try {
        d = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (d.type === 'pong' && d.t1 === t1) {
        ws.removeEventListener('message', onMsg);
        offset = d.serverTime - (t1 + Date.now()) / 2;
        resolve();
      }
    };
    ws.addEventListener('message', onMsg);
    send({ type: 'ping', t1 });
    setTimeout(resolve, 1200);
  });
}

// ---------- 消息处理 ----------
function handleMessage(d) {
  switch (d.type) {
    case 'room_created':
      roomCode = d.code;
      enterRoom();
      break;
    case 'state':
      state = d;
      renderPlaylist();
      renderNowPlaying();
      applyTrackAndSync(true);
      break;
    case 'members':
    case 'member_joined':
    case 'member_left':
      members = d.members;
      renderMembers();
      break;
    case 'chat':
      appendChat(d.nickname, d.text);
      break;
    case 'error':
      ui.hint.textContent = d.message || '出错了';
      break;
  }
}

// ---------- 同步 ----------
function targetPosition() {
  if (!state) return 0;
  const serverNow = Date.now() + offset;
  return state.playing ? state.positionMs + (serverNow - state.updatedAt) : state.positionMs;
}

function alignTo(targetMs, force) {
  if (!Number.isFinite(targetMs) || targetMs < 0) return;
  const diff = Math.abs(audio.currentTime * 1000 - targetMs);
  if (force || diff > 1200) {
    try {
      audio.currentTime = targetMs / 1000;
    } catch {}
  }
}

function applyTrackAndSync(force) {
  if (!state) return;
  const track = state.playlist[state.currentIndex];
  if (!track) {
    audio.pause();
    audio.removeAttribute('src');
    renderTime();
    return;
  }
  const target = state.playing ? targetPosition() : state.positionMs;
  const trackChanged = !audio.src || audio.src.indexOf(track.url) === -1;
  if (trackChanged) {
    audio.src = track.url;
    pendingAlign = target;
    return; // 等 loadedmetadata 后再对齐
  }
  alignTo(target, force);
  if (state.playing) {
    audio.play().catch(showUnlock);
  } else {
    audio.pause();
  }
}

audio.addEventListener('loadedmetadata', () => {
  if (pendingAlign != null) {
    alignTo(pendingAlign, true);
    pendingAlign = null;
  }
  renderTime();
  if (state && state.playing) audio.play().catch(showUnlock);
});

audio.addEventListener('timeupdate', () => {
  if (audio.duration) ui.seek.max = Math.floor(audio.duration * 1000);
  if (!dragging) ui.seek.value = audio.currentTime * 1000;
  renderTime();
});

audio.addEventListener('ended', () => {
  if (state && state.playing) send({ type: 'control', action: 'next' });
});

// 每 2.5 秒做一次漂移校正
setInterval(() => {
  if (state && state.playing) {
    if (audio.paused) audio.play().catch(showUnlock);
    else alignTo(targetPosition(), false);
  }
}, 2500);

// ---------- 控制 ----------
function sendControl(action, extra) {
  send({ type: 'control', action, ...(extra || {}) });
}

ui.playBtn.addEventListener('click', () => sendControl(state && state.playing ? 'pause' : 'play'));
ui.prevBtn.addEventListener('click', () => sendControl('prev'));
ui.nextBtn.addEventListener('click', () => sendControl('next'));
ui.seek.addEventListener('input', () => {
  dragging = true;
  renderTime();
});
ui.seek.addEventListener('change', () => {
  dragging = false;
  sendControl('seek', { positionMs: Math.round(Number(ui.seek.value) || 0) });
});

// ---------- 渲染 ----------
function renderPlaylist() {
  ui.playlist.innerHTML = '';
  (state?.playlist || []).forEach((t, i) => {
    const item = document.createElement('div');
    item.className = 'track' + (i === state.currentIndex ? ' active' : '');
    const play = document.createElement('button');
    play.textContent = '▶';
    play.addEventListener('click', () => sendControl('select', { index: i }));
    const name = document.createElement('span');
    name.className = 'track-name';
    name.textContent = t.name;
    const meta = document.createElement('span');
    meta.className = 'track-meta';
    meta.textContent = t.uploader;
    item.append(play, name, meta);
    ui.playlist.append(item);
  });
}

function renderNowPlaying() {
  const track = state?.playlist[state?.currentIndex];
  if (track) {
    ui.nowPlaying.textContent = track.name;
    ui.nowUploader.textContent = '由 ' + track.uploader + ' 上传';
  } else {
    ui.nowPlaying.textContent = '还没有音频';
    ui.nowUploader.textContent = '上传一段音频，大家就能一起听了';
  }
  ui.playBtn.textContent = state?.playing ? '⏸' : '▶';
}

function renderMembers() {
  ui.memberCount.textContent = members.length;
  ui.memberList.innerHTML = '';
  members.forEach((m) => {
    const chip = document.createElement('span');
    chip.className = 'member';
    chip.textContent = m.nickname;
    ui.memberList.append(chip);
  });
}

function fmt(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return m + ':' + String(s % 60).padStart(2, '0');
}

function renderTime() {
  const cur = audio.currentTime * 1000;
  const dur = (audio.duration || 0) * 1000;
  ui.timeLabel.textContent = fmt(cur) + ' / ' + fmt(dur);
}

// ---------- 聊天 ----------
function appendChat(nick, text) {
  const div = document.createElement('div');
  div.className = 'chat-msg';
  const n = document.createElement('b');
  n.textContent = nick + '：';
  const t = document.createElement('span');
  t.textContent = text;
  div.append(n, t);
  ui.chatList.append(div);
  ui.chatList.scrollTop = ui.chatList.scrollHeight;
}

ui.chatSend.addEventListener('click', () => {
  const text = ui.chatInput.value.trim();
  if (!text) return;
  send({ type: 'chat', text });
  ui.chatInput.value = '';
});
ui.chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') ui.chatSend.click();
});

// ---------- 上传 ----------
ui.uploadBtn.addEventListener('click', () => ui.fileInput.click());
ui.fileInput.addEventListener('change', async () => {
  const file = ui.fileInput.files[0];
  if (!file || !roomCode) return;
  const fd = new FormData();
  fd.append('file', file);
  fd.append('roomId', roomCode);
  fd.append('nickname', nickname);
  ui.uploadBtn.disabled = true;
  ui.uploadBtn.textContent = '上传中…';
  try {
    const res = await fetch('/api/upload', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) alert(data.error || '上传失败');
  } catch {
    alert('上传失败，请检查网络');
  } finally {
    ui.uploadBtn.disabled = false;
    ui.uploadBtn.textContent = '上传音频';
    ui.fileInput.value = '';
  }
});

// ---------- 解锁（浏览器自动播放限制） ----------
function showUnlock() {
  ui.unlock.classList.remove('hidden');
}

ui.unlock.addEventListener('click', () => {
  ui.unlock.classList.add('hidden');
  if (state && state.playing && audio.src) {
    alignTo(targetPosition(), true);
    audio.play().catch(() => {});
  }
});

// ---------- 页面流程 ----------
function enterRoom() {
  ui.landing.classList.add('hidden');
  ui.room.classList.remove('hidden');
  ui.roomCodeLabel.textContent = roomCode;
  ui.hint.textContent = '';
  history.replaceState(null, '', '?room=' + roomCode);
  showUnlock();
}

ui.createBtn.addEventListener('click', () => {
  nickname = ui.nickname.value.trim() || '匿名';
  creatingRoom = true;
  roomCode = null;
  connect();
});

ui.joinBtn.addEventListener('click', () => {
  nickname = ui.nickname.value.trim() || '匿名';
  roomCode = ui.roomCodeInput.value.trim().toUpperCase();
  if (!roomCode) {
    ui.hint.textContent = '请输入房间码';
    return;
  }
  creatingRoom = false;
  connect();
});

ui.copyBtn.addEventListener('click', () => {
  const link = location.origin + '/?room=' + roomCode;
  const done = () => {
    ui.copyBtn.textContent = '已复制';
    setTimeout(() => (ui.copyBtn.textContent = '复制链接'), 1600);
  };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(link).then(done).catch(() => prompt('复制链接给群友：', link));
  } else {
    prompt('复制链接给群友：', link);
  }
});

// 从分享链接进入时，预填房间码
(function () {
  const code = new URLSearchParams(location.search).get('room');
  if (code) ui.roomCodeInput.value = code.toUpperCase();
})();

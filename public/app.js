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
  leaveBtn: $('leaveBtn'),
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
  librarySearch: $('librarySearch'),
  libraryResults: $('libraryResults'),
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
let enteredRoom = false;
let leftRoom = false;
let autoJoinTimer = null;
let libraryTimer = null;
let librarySeq = 0;
let libraryComposing = false;

// ---------- 连接 ----------
function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// 昵称永久保存在浏览器里，关闭网页后再次打开会自动填充
function saveNickname(nick) {
  try {
    localStorage.setItem('lt_nickname', nick);
  } catch {}
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
    if (leftRoom) return;
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
      enterRoom(); // 加入者第一次收到房间状态时，切换到房间界面
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
      if (d.message && d.message.indexOf('房间不存在') >= 0) {
        try {
          sessionStorage.removeItem('lt_room');
        } catch {}
      }
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
    safePlay();
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
  if (state && state.playing) safePlay();
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
    if (audio.paused) safePlay();
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
    meta.textContent = t.fromLibrary ? '曲库 · ' + t.uploader : t.uploader;
    item.append(play, name, meta);
    ui.playlist.append(item);
  });
}

function renderNowPlaying() {
  const track = state?.playlist[state?.currentIndex];
  if (track) {
    ui.nowPlaying.textContent = track.name;
    ui.nowUploader.textContent = track.fromLibrary
      ? '由 ' + track.uploader + ' 从曲库添加'
      : '由 ' + track.uploader + ' 上传';
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

function sendChat() {
  const text = ui.chatInput.value.trim();
  if (!text) return;
  send({ type: 'chat', text });
  ui.chatInput.value = '';
}

ui.chatSend.addEventListener('click', sendChat);

// 中文输入法兼容：组词中按回车只确认拼音，不发送；确认后再次按回车才发送
let chatComposing = false;
ui.chatInput.addEventListener('compositionstart', () => {
  chatComposing = true;
});
ui.chatInput.addEventListener('compositionend', () => {
  chatComposing = false;
});
ui.chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !chatComposing && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    sendChat();
  }
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

// ---------- 本地曲库：搜索与添加 ----------
function scheduleLibrarySearch() {
  clearTimeout(libraryTimer);
  libraryTimer = setTimeout(searchLibrary, 250);
}

async function searchLibrary() {
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
    const res = await fetch('/api/library/search?q=' + encodeURIComponent(q));
    const data = await res.json();
    if (seq !== librarySeq) return; // 丢弃过期结果
    if (!res.ok) throw new Error(data.error || '搜索失败');
    renderLibraryResults(data.results || [], data.total || 0);
  } catch {
    if (seq === librarySeq) {
      ui.libraryResults.innerHTML = '<div class="lib-note">搜索失败，请稍后重试</div>';
    }
  }
}

function renderLibraryResults(results, total) {
  ui.libraryResults.innerHTML = '';
  if (total === 0) {
    const note = document.createElement('div');
    note.className = 'lib-note';
    note.textContent = '曲库还是空的：把音频文件放进项目的 library 文件夹';
    ui.libraryResults.append(note);
    return;
  }
  if (results.length === 0) {
    const note = document.createElement('div');
    note.className = 'lib-note';
    note.textContent = '曲库里没有匹配的音乐';
    ui.libraryResults.append(note);
    return;
  }
  results.forEach((t) => {
    const row = document.createElement('div');
    row.className = 'lib-row';
    const name = document.createElement('span');
    name.className = 'lib-name';
    name.textContent = t.name;
    name.title = t.name;
    const add = document.createElement('button');
    add.className = 'small';
    add.textContent = '+ 添加';
    add.addEventListener('click', () => addLibraryTrack(t, add));
    row.append(name, add);
    ui.libraryResults.append(row);
  });
}

async function addLibraryTrack(track, btn) {
  if (!roomCode) return;
  btn.disabled = true;
  btn.textContent = '添加中…';
  try {
    const res = await fetch('/api/library/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId: roomCode, trackId: track.id, nickname }),
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
  }, 1500);
}

ui.librarySearch.addEventListener('compositionstart', () => {
  libraryComposing = true;
});
ui.librarySearch.addEventListener('compositionend', () => {
  libraryComposing = false;
  scheduleLibrarySearch();
});
ui.librarySearch.addEventListener('input', () => {
  if (libraryComposing) return;
  scheduleLibrarySearch();
});
ui.librarySearch.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !libraryComposing && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    clearTimeout(libraryTimer);
    searchLibrary();
  }
});

// ---------- 解锁（浏览器自动播放限制） ----------
function showUnlock() {
  ui.unlock.classList.remove('hidden');
}

// 播放请求被"暂停/切歌"打断时不弹窗，只有被浏览器拦截（需要用户点击）时才弹
function safePlay() {
  const p = audio.play();
  if (p) {
    p.catch((err) => {
      if (err && err.name === 'AbortError') return;
      showUnlock();
    });
  }
}

// 用户点击"创建/加入"时用静音音频预解锁播放权限，让后续远程播放能直接出声
function unlockAudio() {
  try {
    const silent = new Audio('data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA');
    silent.play().catch(() => {});
  } catch {}
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
  if (enteredRoom) return;
  enteredRoom = true;
  try {
    sessionStorage.setItem('lt_room', roomCode);
    sessionStorage.setItem('lt_nickname', nickname);
  } catch {}
  saveNickname(nickname);
  ui.landing.classList.add('hidden');
  ui.room.classList.remove('hidden');
  ui.roomCodeLabel.textContent = roomCode;
  ui.hint.textContent = '';
}

ui.createBtn.addEventListener('click', () => {
  const nick = ui.nickname.value.trim();
  if (!nick) {
    ui.hint.textContent = '请先填写昵称';
    ui.nickname.focus();
    return;
  }
  nickname = nick;
  saveNickname(nick);
  creatingRoom = true;
  roomCode = null;
  leftRoom = false;
  clearTimeout(autoJoinTimer);
  unlockAudio();
  connect();
});

ui.joinBtn.addEventListener('click', () => {
  const nick = ui.nickname.value.trim();
  if (!nick) {
    ui.hint.textContent = '请先填写昵称';
    ui.nickname.focus();
    return;
  }
  nickname = nick;
  saveNickname(nick);
  roomCode = ui.roomCodeInput.value.trim().toUpperCase();
  if (!roomCode) {
    ui.hint.textContent = '请输入房间码';
    return;
  }
  creatingRoom = false;
  leftRoom = false;
  clearTimeout(autoJoinTimer);
  unlockAudio();
  connect();
});

// 房间号输入框有内容时，禁用"创建房间"按钮
function updateCreateBtn() {
  ui.createBtn.disabled = ui.roomCodeInput.value.trim().length > 0;
}

// 房间码输入：只接受字母和数字；组词中不干预输入法，组词结束后统一清理
let roomComposing = false;
ui.roomCodeInput.addEventListener('compositionstart', () => {
  roomComposing = true;
});
ui.roomCodeInput.addEventListener('compositionend', () => {
  roomComposing = false;
  updateRoomCodeInput();
});
ui.roomCodeInput.addEventListener('beforeinput', (e) => {
  if (e.data && /[^A-Za-z0-9]/.test(e.data)) e.preventDefault();
});
function updateRoomCodeInput() {
  if (roomComposing) return;
  const v = ui.roomCodeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (ui.roomCodeInput.value !== v) ui.roomCodeInput.value = v;
  updateCreateBtn();
}
ui.roomCodeInput.addEventListener('input', updateRoomCodeInput);

ui.copyBtn.addEventListener('click', () => {
  const done = () => {
    ui.copyBtn.textContent = '已复制';
    setTimeout(() => (ui.copyBtn.textContent = '复制房间号'), 1600);
  };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(roomCode).then(done).catch(() => prompt('房间号：', roomCode));
  } else {
    prompt('房间号：', roomCode);
  }
});

// 退出房间：断开连接、清空记录、回到输入房间号页面
function leaveRoom() {
  leftRoom = true;
  clearTimeout(autoJoinTimer);
  clearTimeout(reconnectTimer);
  try {
    if (ws) ws.close();
  } catch {}
  ws = null;
  try {
    sessionStorage.removeItem('lt_room');
    sessionStorage.removeItem('lt_nickname');
  } catch {}
  audio.pause();
  audio.removeAttribute('src');
  state = null;
  members = [];
  enteredRoom = false;
  roomCode = null;
  creatingRoom = false;
  ui.librarySearch.value = '';
  ui.libraryResults.classList.add('hidden');
  ui.libraryResults.innerHTML = '';
  ui.unlock.classList.add('hidden');
  ui.roomCodeInput.value = '';
  updateCreateBtn();
  ui.landing.classList.remove('hidden');
  ui.room.classList.add('hidden');
  ui.hint.textContent = '';
  history.replaceState(null, '', location.pathname);
}
ui.leaveBtn.addEventListener('click', leaveRoom);

// 分享链接只预填房间号；同一标签页刷新时自动回到房间（关闭标签页后记录自动清除）
(function () {
  const codeFromUrl = new URLSearchParams(location.search).get('room');
  if (codeFromUrl) ui.roomCodeInput.value = codeFromUrl.toUpperCase();

  let lastNick = '';
  try {
    lastNick = localStorage.getItem('lt_nickname') || '';
  } catch {}
  if (lastNick) ui.nickname.value = lastNick;

  let savedRoom = '';
  let savedNick = '';
  try {
    savedRoom = sessionStorage.getItem('lt_room') || '';
    savedNick = sessionStorage.getItem('lt_nickname') || '';
  } catch {}

  if (savedRoom && savedNick && savedNick !== '匿名') {
    ui.roomCodeInput.value = savedRoom;
    nickname = savedNick || lastNick;
    roomCode = savedRoom;
    creatingRoom = false;
    leftRoom = false;
    ui.hint.textContent = '正在自动回到房间…';
    autoJoinTimer = setTimeout(connect, 300);
  } else if (savedRoom) {
    // 有房间记录但没有有效昵称：只预填房间号，等用户填写昵称后手动加入
    ui.roomCodeInput.value = savedRoom;
  }
  updateCreateBtn();
})();

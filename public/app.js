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
  modeBtn: $('modeBtn'),
  chatList: $('chatList'),
  chatInput: $('chatInput'),
  chatSend: $('chatSend'),
  unlock: $('unlock'),
};

const audio = $('player');

let ws = null;
let roomCode = null;
let nickname = '';
let state = null;
let members = [];
let offset = 0; // 估算的服务器时间 - 本地时间
let reconnectTimer = null;
let needAlign = false; // 正在等音频数据就绪后对齐进度
let initialSeekDone = false; // 进房/换歌时是否已经在播放前跳到了目标进度
let pendingPlay = false; // 对齐完成后需要继续播放
let alignWatchUntil = 0; // 对齐观察期截止时间
let lastAlignSeekAt = 0; // 上次自动跳转的时间，用于限制播放中反复跳转
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

// 周期性校准服务器时间，防止长时间播放后偏移
setInterval(() => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
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
    }
  };
  ws.addEventListener('message', onMsg);
  send({ type: 'ping', t1 });
}, 15000);

// ---------- 消息处理 ----------
function handleMessage(d) {
  switch (d.type) {
    case 'room_created':
      roomCode = d.code;
      enterRoom();
      break;
    case 'state':
      state = d;
      if (offset === 0 && typeof d.serverTime === 'number') {
        offset = d.serverTime - Date.now(); // 初始校准失败时用状态消息兜底
      }
      enterRoom(); // 加入者第一次收到房间状态时，切换到房间界面
      renderPlaylist();
      renderNowPlaying();
      applyTrackAndSync();
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
    case 'chat_history':
      ui.chatList.innerHTML = '';
      (d.messages || []).forEach((m) => appendChat(m.nickname, m.text));
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
  if (force || diff > 600) {
    try {
      audio.currentTime = targetMs / 1000;
    } catch {}
  }
}

function applyTrackAndSync() {
  if (!state) return;
  const track = state.playlist[state.currentIndex];
  if (!track) {
    audio.pause();
    audio.removeAttribute('src');
    needAlign = false;
    initialSeekDone = false;
    renderTime();
    return;
  }
  const target = state.playing ? targetPosition() : state.positionMs;
  const trackChanged = !audio.src || audio.src.indexOf(track.url) === -1;
  if (trackChanged) {
    audio.src = track.url;
    needAlign = true;
    initialSeekDone = false;
    pendingPlay = state.playing;
    alignWatchUntil = Date.now() + 20000;
    return; // 等数据就绪后再对齐
  }
  if (needAlign) {
    // 还在等音频数据就绪：只更新播放意图，不做跳转/播放，避免在加载阶段 seek
    pendingPlay = state.playing;
    return;
  }
  needAlign = false;
  pendingPlay = false;
  alignWatchUntil = 0;
  // 只有偏差足够大才跳转；不要每次收到状态广播都强制 seek，
  // iOS 播放中反复 seek 会导致没有声音或断断续续
  alignTo(target, false);
  if (state.playing) {
    safePlay();
  } else {
    audio.pause();
  }
}

audio.addEventListener('loadedmetadata', () => {
  // 注意：不要在 loadedmetadata 里设置 currentTime
  // WebKit 已知 bug（261512）：会导致 iOS Safari 从 0 播放且之后无法再跳转
  renderTime();
});

// 数据就绪后先在播放前跳到房间进度，再开始播放。
// iOS 不能在 loadedmetadata 里跳（WebKit bug 261512），也不能在播放开始后再跳
// （iPhone Chrome/Safari 会变成进度条在走但没有声音），所以统一在 loadeddata 时对齐。
function startAlignedPlayback() {
  if (!needAlign) return;
  if (!initialSeekDone) {
    alignTo(state.playing ? targetPosition() : state.positionMs, true);
    initialSeekDone = true;
    lastAlignSeekAt = Date.now();
  }
  renderTime();
  // 正在跳转时先不播放，等 seeked 完成后由 seeked 处理，避免 iOS 播放中跳转丢声音
  if (state && state.playing && !audio.seeking) safePlay();
}

audio.addEventListener('loadeddata', startAlignedPlayback);
audio.addEventListener('canplay', startAlignedPlayback);

// 播放真正开始后不再跳转，避免 iOS 播放中 seek 导致没有声音
audio.addEventListener('playing', () => {
  if (needAlign) {
    needAlign = false;
    pendingPlay = false;
  }
});

// 跳转完成后确认对齐结束
audio.addEventListener('seeked', () => {
  if (needAlign && initialSeekDone) {
    needAlign = false;
    pendingPlay = false;
    renderTime();
    if (state && state.playing && audio.paused) safePlay();
  }
});

audio.addEventListener('timeupdate', () => {
  if (audio.duration) ui.seek.max = Math.floor(audio.duration * 1000);
  if (!dragging) ui.seek.value = audio.currentTime * 1000;
  renderTime();
  // 对齐观察期：持续核对进度，偏差大就再跳，到位就结束
  if (needAlign && Date.now() < alignWatchUntil && state && state.playing) {
    const target = targetPosition();
    const diff = Math.abs(audio.currentTime * 1000 - target);
    if (diff <= 3000) {
      needAlign = false;
      pendingPlay = false;
    } else if (SyncPolicy.shouldAutoSeek(audio.currentTime * 1000, target, lastAlignSeekAt, Date.now())) {
      alignTo(target, true);
      lastAlignSeekAt = Date.now();
    }
  }
});

audio.addEventListener('ended', () => {
  if (state && state.playing) send({ type: 'control', action: 'ended' });
});

// 每 2 秒检查播放状态；播放中不再自动跳转（Safari 反复跳转会导致声音断断续续）
setInterval(() => {
  if (state && state.playing) {
    if (needAlign && Date.now() < alignWatchUntil) return; // 对齐进行中，避免从 0 抢先播放
    if (audio.paused) safePlay();
  }
}, 2000);

// ---------- 控制 ----------
function sendControl(action, extra) {
  send({ type: 'control', action, ...(extra || {}) });
}

// 点击播放时在用户手势内立即本地播放，避免等服务端回包后再播放被浏览器拦截
function playLocally() {
  if (!state || !state.playlist[state.currentIndex] || !audio.src) return;
  if (needAlign) {
    // 音频还没就绪：等对齐完成后再自动播放，避免从 0 抢跑
    pendingPlay = true;
    return;
  }
  const p = audio.play();
  if (p) {
    p.catch((err) => {
      if (err && err.name === 'AbortError') return;
      showUnlock();
    });
  }
}

ui.playBtn.addEventListener('click', () => {
  if (state && state.playing) {
    audio.pause();
    sendControl('pause');
  } else {
    playLocally();
    sendControl('play');
  }
});
ui.prevBtn.addEventListener('click', () => sendControl('prev'));
ui.nextBtn.addEventListener('click', () => sendControl('next'));

// ---------- 播放模式 ----------
const MODE_LABELS = { order: '顺序', shuffle: '随机', single: '单曲循环' };
function renderMode() {
  ui.modeBtn.textContent = MODE_LABELS[state?.playMode || 'order'] || '顺序';
}
ui.modeBtn.addEventListener('click', () => {
  const cur = state?.playMode || 'order';
  const next = cur === 'order' ? 'shuffle' : cur === 'shuffle' ? 'single' : 'order';
  sendControl('set_mode', { mode: next });
});

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
  renderMode();
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
    const del = document.createElement('button');
    del.className = 'track-del';
    del.textContent = '删除';
    del.setAttribute('aria-label', '删除 ' + t.name);
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm('确定删除「' + t.name + '」吗？')) {
        send({ type: 'remove_track', trackId: t.id });
      }
    });
    item.append(play, name, meta, del);
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
  let cur = audio.currentTime * 1000;
  // 音频还没就绪/还没对齐时，先显示房间的真实进度，避免进房后进度条长时间卡在 0
  if (needAlign && state) {
    cur = state.playing ? targetPosition() : state.positionMs;
  }
  const dur = (audio.duration || 0) * 1000;
  ui.timeLabel.textContent = fmt(cur) + ' / ' + fmt(dur);
  if (!dragging) {
    ui.seek.value = audio.duration
      ? Math.min(Math.round(cur), Math.floor(audio.duration * 1000))
      : Math.round(cur);
  }
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
    // 房间号放在网址里，服务端才能在文件开始传输的第一时间就知道要保护哪个房间
    const res = await fetch('/api/upload?roomId=' + encodeURIComponent(roomCode), {
      method: 'POST',
      body: fd,
    });
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

const SILENT_WAV = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';

// 用户点击"创建/加入"时，在点击手势内直接播放主播放器（一个无声音频）来解锁它。
// iOS 浏览器按"播放器元素"单独计算解锁状态：只播放另一个临时音频不会解锁主播放器，
// 未解锁时会出现进度条在走但没有声音。
function unlockAudio() {
  try {
    // 静音音频本身没有任何声音，不需要用 muted，避免 iOS 把它当成"没有在播声音"而不解锁
    audio.muted = false;
    if (!audio.src) audio.src = SILENT_WAV;
    const p = audio.play();
    if (p) p.catch(() => {});
  } catch {}
}

ui.unlock.addEventListener('click', () => {
  ui.unlock.classList.add('hidden');
  if (state && state.playing && audio.src) {
    if (needAlign && !initialSeekDone) {
      // 还在等音频就绪：等对齐完成后自动播放
      pendingPlay = true;
      return;
    }
    const p = audio.play();
    if (p) p.catch(() => {});
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
  needAlign = false;
  initialSeekDone = false;
  pendingPlay = false;
  alignWatchUntil = 0;
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

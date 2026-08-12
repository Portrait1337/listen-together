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
  vinyl: $('vinyl'),
  vinylLabel: $('vinylLabel'),
  playBtn: $('playBtn'),
  prevBtn: $('prevBtn'),
  nextBtn: $('nextBtn'),
  seek: $('seek'),
  timeLabel: $('timeLabel'),
  playlist: $('playlist'),
  librarySearch: $('librarySearch'),
  libraryResults: $('libraryResults'),
  tabLocal: $('tabLocal'),
  tabOnline: $('tabOnline'),
  platformTabs: $('platformTabs'),
  platNetease: $('platNetease'),
  platMigu: $('platMigu'),
  fileInput: $('fileInput'),
  uploadBtn: $('uploadBtn'),
  modeBtn: $('modeBtn'),
  queueCount: $('queueCount'),
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
let lastSeekAt = 0; // 上次任何跳转的时间，用于识别“跳转造成的假播完”
// iOS FLAC 流式 seek 可靠性差（尤其向后拖），统一走"暂停→跳转→恢复"，
// 并加跳转冷却与卡死看门狗，避免状态广播反复拉拽造成无限卡顿
const IS_IOS =
  /iP(hone|ad|od)/.test(navigator.userAgent || '') ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const SEEK_COOLDOWN_MS = 3000;
const SEEK_STALL_MS = 3000;
const SEEK_WATCH_MS = 20000; // seek 后 20 秒内才启用卡缓冲看门狗，避免误伤正常网络缓冲
const LARGE_SEEK_MS = 30000; // iOS FLAC 大幅跳转阈值：原地 seek 易让 WebKit 解码器卡死
const ALIGN_WATCH_MS = 20000; // 一次对齐流程的最长观察期
const ALIGN_STALL_MS = 15000; // 对齐流程超过该时间仍未完成 → 重建播放器
const ALIGN_MAX_RELOADS = 2; // 同一首歌最多自动重建 2 次，避免无限循环
let lastSeekDoneAt = 0;
let seekResumeTimer = null;
let lastTickMs = 0;
let lastTickAt = 0;
let stallRetries = 0;
let seekToken = 0; // 每次 seek/暂停/切歌递增，用于丢弃过期的"恢复播放"回调
let pendingSeekTarget = null; // iOS FLAC 大跳转重载后要对齐的目标位置
let alignStartedAt = 0; // 当前对齐流程开始时间（卡死检测用）
let alignStallReloads = 0; // 当前对齐流程已自动重建次数
let driftCorrections = 0; // 本首歌已自动纠偏次数（上限见 sync-policy.js，防止反复卡顿）
let creatingRoom = false;
let dragging = false;
let enteredRoom = false;
let leftRoom = false;
let autoJoinTimer = null;
let libraryTimer = null;
let librarySeq = 0;
let libraryComposing = false;
let searchTab = 'online'; // 搜索来源：local=本地曲库 online=在线音乐（进房默认在线）
let onlineOffset = 0; // 在线搜索已加载条数
let onlineHasMore = false;
let onlineSource = 'netease'; // 在线搜索当前平台：netease / migu

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
  // 防止重复点击/重连叠出多个 WebSocket：先关掉旧连接并摘除事件处理器，
  // 否则多个"自己"同时在线会造成成员列表重复、双份广播
  if (ws) {
    try {
      ws.onclose = null;
      ws.onerror = null;
      ws.close();
    } catch {}
    ws = null;
  }
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  ws = new WebSocket(proto + location.host + '/ws');
  ws.onopen = () => {
    // 先发建房/进房，再异步校准时钟：校准只用于播放进度对齐，
    // 不应阻塞房间创建（微信等环境下首次 ping 往返可能很慢甚至丢失）
    if (creatingRoom) {
      creatingRoom = false;
      send({ type: 'create_room', name: '一起听', nickname });
    } else if (roomCode) {
      send({ type: 'join_room', code: roomCode, nickname });
    }
    estimateOffset();
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
    const sock = ws;
    if (!sock) return resolve();
    const t1 = Date.now();
    let done = false;
    const finish = (o) => {
      if (done) return;
      done = true;
      sock.removeEventListener('message', onMsg);
      offset = o;
      resolve();
    };
    const onMsg = (ev) => {
      let d;
      try {
        d = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (d.type === 'pong' && d.t1 === t1) finish(d.serverTime - (t1 + Date.now()) / 2);
    };
    sock.addEventListener('message', onMsg);
    if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ type: 'ping', t1 }));
    // 兜底：1.2 秒没收到 pong 就不等了（建房/进房已不依赖本次校准）
    setTimeout(() => finish(0), 1200);
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
    case 'mode_changed':
      // 只更新模式按钮，不触碰播放器，切换模式不会暂停当前歌曲
      if (state) state.playMode = d.playMode;
      renderMode();
      break;
    case 'members':
    case 'member_joined':
    case 'member_left':
      members = d.members;
      renderMembers();
      break;
    case 'chat':
      appendChat(d.nickname, d.text, d.id);
      break;
    case 'chat_history':
      ui.chatList.innerHTML = '';
      (d.messages || []).forEach((m) => appendChat(m.nickname, m.text, m.id));
      break;
    case 'message_recalled':
      // 把被撤回的消息从聊天列表移除
      {
        const el = ui.chatList.querySelector('[data-id="' + String(d.id || '') + '"]');
        if (el) el.remove();
      }
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

// 对齐期间的目标位置：手动大跳转以本地目标为准，其余用服务器房间进度
function currentTargetMs() {
  if (pendingSeekTarget !== null) return pendingSeekTarget;
  if (!state) return 0;
  return state.playing ? targetPosition() : state.positionMs;
}

function currentTrack() {
  return state && Array.isArray(state.playlist) ? state.playlist[state.currentIndex] || null : null;
}

// 权威时长：FLAC 在 iOS/微信流式播放下 audio.duration 可能返回 Infinity/错误值，
// 有服务器解析的 durationMs 时优先用它；否则退回浏览器时长
function currentDurMs() {
  const t = currentTrack();
  if (t && Number.isFinite(t.durationMs) && t.durationMs > 0) return t.durationMs;
  const d = audio.duration;
  return Number.isFinite(d) && d > 0 ? d * 1000 : 0;
}

// 当前曲目是否为 FLAC：iOS/微信里 FLAC 流式 seek 最容易卡缓冲
function isFlacTrack() {
  const t = currentTrack();
  if (!t) return false;
  if (t.type === 'flac') return true;
  return /\.flac($|\?)/i.test(t.url || '');
}

// 取消"seek 后恢复播放"的兜底回调（用户暂停/切歌时必须失效，避免被自动重新播放）
function cancelSeekResume() {
  seekToken++;
  clearTimeout(seekResumeTimer);
}

// 对齐流程完成：清理状态并刷新 UI
function completeAlignment() {
  needAlign = false;
  pendingPlay = false;
  alignStartedAt = 0;
  alignStallReloads = 0;
  renderTime();
}

// 重建播放器并重新进入对齐流程（iOS FLAC 解码器卡死/对齐超时时的最后一招）
function recoverAlignment() {
  cancelSeekResume();
  const shouldPlay = !!(state && state.playing);
  alignStallReloads++;
  pendingSeekTarget = null;
  try {
    audio.pause();
    audio.load();
  } catch {}
  needAlign = true;
  initialSeekDone = false;
  pendingPlay = shouldPlay;
  alignWatchUntil = Date.now() + ALIGN_WATCH_MS;
  alignStartedAt = Date.now();
  lastSeekAt = Date.now();
  lastSeekDoneAt = Date.now();
  stallRetries = 0;
  lastTickMs = 0;
  lastTickAt = Date.now();
  if (shouldPlay) safePlay();
}

// seek 后若 seeked 一直不触发，定时兜底恢复播放
function scheduleAlignResume() {
  const token = seekToken; // doSeek 已递增过 token
  const retry = () => {
    if (token !== seekToken) return;
    if (!audio.paused) return;
    safePlay();
  };
  audio.addEventListener('seeked', retry, { once: true });
  clearTimeout(seekResumeTimer);
  seekResumeTimer = setTimeout(retry, 3000);
}

function doSeek(targetMs, force, manual) {
  if (!Number.isFinite(targetMs) || targetMs < 0) return;
  const durMs = currentDurMs();
  // 手动拖动不截断到结尾前 2 秒（用户就是要拖到那里）；自动对齐才截断
  if (!manual && durMs > 0) {
    // 不允许跳到结尾之后；接近结尾时最多到结尾前 2 秒，避免一跳就触发“播完”
    targetMs = Math.min(targetMs, Math.max(0, durMs - 2000));
  }
  const diff = Math.abs(audio.currentTime * 1000 - targetMs);
  if (!force && diff <= 600) return;
  // 冷却：非强制跳转 3 秒内不重复 seek，防止状态广播把刚拖过进度条的用户反复拉拽
  if (!force && Date.now() - lastSeekDoneAt < SEEK_COOLDOWN_MS) return;
  const token = ++seekToken;
  const wasPlaying = !audio.paused;
  if (IS_IOS && wasPlaying) audio.pause(); // iOS 播放中直接 seek 易卡缓冲
  try {
    audio.currentTime = targetMs / 1000;
  } catch {}
  lastSeekAt = Date.now();
  lastSeekDoneAt = Date.now();
  stallRetries = 0;
  lastTickAt = Date.now();
  if (IS_IOS && wasPlaying) {
    // 不立即 play：等 seeked 真正完成后恢复，避免"进度在走但没有声音"
    const retry = () => {
      if (token !== seekToken) return; // 已被暂停/切歌/新 seek 取代
      if (!audio.paused) return;
      safePlay();
    };
    audio.addEventListener('seeked', retry, { once: true });
    clearTimeout(seekResumeTimer);
    seekResumeTimer = setTimeout(retry, 1500);
  }
}

function alignTo(targetMs, force) {
  doSeek(targetMs, force, false);
}

// iOS FLAC 大幅跳转：原地 seek 会让 WebKit 解码器卡死（进度在走但没有声音），
// 改成重载播放器、走标准对齐流程，重建解码管线后再跳到目标位置
function reloadAndSeek(targetMs) {
  const wasPlaying = !audio.paused;
  cancelSeekResume();
  pendingSeekTarget = targetMs;
  try {
    audio.pause();
    audio.load();
  } catch {}
  needAlign = true;
  initialSeekDone = false;
  pendingPlay = wasPlaying;
  alignWatchUntil = Date.now() + ALIGN_WATCH_MS;
  alignStartedAt = Date.now();
  alignStallReloads = 0;
  lastSeekAt = Date.now();
  lastSeekDoneAt = Date.now();
  stallRetries = 0;
  lastTickAt = Date.now();
  if (wasPlaying) safePlay();
}

// 用户手动拖动进度条：本地立即跳转（不等服务器回包），允许拖到任意位置
function userSeek(targetMs) {
  driftCorrections = 0; // 用户主动拖动：重新给自动纠偏配额
  if (IS_IOS && isFlacTrack() && !audio.paused) {
    const jump = targetMs - audio.currentTime * 1000;
    // 大幅向前（或向后）跳：原地 seek 不可靠，直接重建播放器
    if (Math.abs(jump) >= LARGE_SEEK_MS) {
      reloadAndSeek(targetMs);
      return;
    }
  }
  doSeek(targetMs, true, true);
}

function applyTrackAndSync() {
  if (!state) return;
  const track = state.playlist[state.currentIndex];
  if (!track) {
    cancelSeekResume();
    pendingSeekTarget = null;
    alignStartedAt = 0;
    alignStallReloads = 0;
    driftCorrections = 0;
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
    cancelSeekResume();
    pendingSeekTarget = null;
    driftCorrections = 0;
    try {
      audio.pause();
    } catch {}
    audio.src = track.url;
    needAlign = true;
    initialSeekDone = false;
    pendingPlay = state.playing;
    alignWatchUntil = Date.now() + ALIGN_WATCH_MS;
    alignStartedAt = Date.now();
    alignStallReloads = 0;
    lastTickMs = 0;
    lastTickAt = Date.now();
    stallRetries = 0;
    // 边播边缓冲：不等数据就绪，先立即尝试播放，能出声就出声
    if (state.playing) safePlay();
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
  alignStartedAt = 0;
  alignStallReloads = 0;
  pendingSeekTarget = null;
  // 只有偏差足够大才跳转；不要每次收到状态广播都强制 seek，
  // iOS 播放中反复 seek 会导致没有声音或断断续续
  alignTo(target, false);
  if (state.playing) {
    safePlay();
  } else {
    cancelSeekResume();
    audio.pause();
  }
}

audio.addEventListener('loadedmetadata', () => {
  // 注意：不要在 loadedmetadata 里设置 currentTime
  // WebKit 已知 bug（261512）：会导致 iOS Safari 从 0 播放且之后无法再跳转
  renderTime();
});

// 数据就绪后的处理（loadeddata / canplay）：
// - 暂停中的房间：跳到房间进度，不播放
// - 播放中的房间：直接"暂停→跳转→恢复"，不依赖 playing 事件
//   （iOS FLAC 无声卡死时 playing 可能不触发，等 playing 会永远卡住）
function startAlignedPlayback() {
  if (!needAlign || initialSeekDone) return;
  if (state && !state.playing) {
    pendingSeekTarget = null;
    initialSeekDone = true;
    alignTo(state.positionMs, true);
    completeAlignment();
    return;
  }
  if (state && state.playing && pendingPlay) {
    alignAfterStarted();
  }
}

// 已经实际开始播放：先暂停跳到目标进度，再继续播
function alignAfterStarted() {
  if (!needAlign || initialSeekDone) return;
  const target = currentTargetMs();
  pendingSeekTarget = null;
  const diff = Math.abs(audio.currentTime * 1000 - target);
  initialSeekDone = true;
  lastAlignSeekAt = Date.now();
  if (diff > 1500) {
    // 先暂停、再跳转、等 seeked 后恢复播放：
    // iOS 在播放中直接 seek 会变成进度在走但没有声音
    audio.pause();
    alignTo(target, true);
    scheduleAlignResume(); // seeked 一直不触发时的兜底
  } else {
    completeAlignment();
    if (state && state.playing && audio.paused) safePlay();
  }
}

audio.addEventListener('loadeddata', startAlignedPlayback);
audio.addEventListener('canplay', startAlignedPlayback);

audio.addEventListener('playing', () => {
  if (needAlign && !initialSeekDone) {
    // 已经出声但还没对齐：先暂停跳到目标进度再继续播
    alignAfterStarted();
  } else if (needAlign) {
    completeAlignment();
  }
});

// 跳转完成后确认对齐结束
audio.addEventListener('seeked', () => {
  if (needAlign && initialSeekDone) {
    completeAlignment();
    if (state && state.playing && audio.paused) safePlay();
  }
});

audio.addEventListener('timeupdate', () => {
  const now = Date.now();
  const tMs = audio.currentTime * 1000;
  // 记录"播放头实际移动"的时间：只在实际前进时刷新，供卡死检测/落后纠偏使用
  if (Math.abs(tMs - lastTickMs) >= 250) {
    lastTickMs = tMs;
    lastTickAt = now;
  }
  const durMs = currentDurMs();
  if (durMs > 0) ui.seek.max = Math.floor(durMs);
  if (!dragging) ui.seek.value = audio.currentTime * 1000;
  renderTime();
  // 对齐观察期：持续核对进度，偏差大就再跳，到位就结束
  if (needAlign && now < alignWatchUntil && state && state.playing) {
    const target = currentTargetMs();
    const diff = Math.abs(audio.currentTime * 1000 - target);
    if (diff <= 3000) {
      completeAlignment();
    } else if (SyncPolicy.shouldAutoSeek(audio.currentTime * 1000, target, lastAlignSeekAt, now)) {
      lastAlignSeekAt = now;
      if (IS_IOS && isFlacTrack() && target - audio.currentTime * 1000 >= LARGE_SEEK_MS) {
        reloadAndSeek(target); // 差距太大：重建播放器，避免原地大幅 seek 卡死
      } else {
        alignTo(target, true);
      }
    }
  }
});

audio.addEventListener('ended', () => {
  if (!state || !state.playing) return;
  // 跳转/对齐刚结束（1.5 秒内）触发的假“播完”不上报
  if (Date.now() - lastSeekAt < 1500) return;
  // 只有确实播到结尾附近才算自然播完
  const dur = currentDurMs() / 1000;
  if (!(dur > 0) || Math.abs(audio.currentTime - dur) > 0.5) return;
  const track = state.playlist[state.currentIndex];
  send({ type: 'control', action: 'ended', trackId: track ? track.id : '' });
});

// 每 2 秒检查播放状态；播放中不再自动跳转（Safari 反复跳转会导致声音断断续续）。
// 对齐卡死检测：needAlign 超过 15 秒仍未完成（如 iOS FLAC seeked 永不触发），
// 自动重建播放器重新对齐，最多 2 次，避免切到下一首歌后永久无声。
// 同时做 iOS FLAC 卡缓冲看门狗：播放中 currentTime 长时间不动，说明 seek 后卡住了，
// 强制重新 seek，最多 3 次；仍卡就重建播放器并按房间进度重新对齐。
setInterval(() => {
  const now = Date.now();
  if (state && state.playing) {
    if (needAlign && alignStartedAt && !audio.paused && now - alignStartedAt >= ALIGN_STALL_MS) {
      if (alignStallReloads < ALIGN_MAX_RELOADS) {
        recoverAlignment();
      } else {
        // 自动重建次数用尽：不再重建，至少尝试从当前加载到的位置继续播放
        alignStartedAt = now;
        if (audio.paused) safePlay();
      }
      return;
    }
    if (needAlign && now < alignWatchUntil) return; // 对齐进行中，避免从 0 抢先播放
    if (audio.paused) safePlay();
    if (dragging) {
      stallRetries = 0;
      return;
    }
    if (IS_IOS && isFlacTrack()) {
      const tMs = audio.currentTime * 1000;
      const durMs = currentDurMs();
      const nearEnd = durMs > 0 && tMs >= durMs - 2500;
      const progressRecent = now - lastTickAt < 1500; // 播放头最近 1.5 秒内真的在走
      if (progressRecent) stallRetries = 0;
      // 落后纠偏：缓冲/跳转完成后播放头在走，但比房间落后太多 → 重新对齐。
      // 这是 iOS FLAC"固定落后 5-10 秒"的根因修复：seek 后缓冲几秒才出声，
      // 出声时房间已经走到前面，且此前没有任何机制再把进度拉回来。
      if (!needAlign && !nearEnd && progressRecent && !audio.paused) {
        const target = currentTargetMs();
        const behind = target - tMs;
        if (SyncPolicy.shouldDriftSeek(behind, now - lastSeekDoneAt, driftCorrections)) {
          driftCorrections++;
          lastSeekAt = now;
          if (behind >= LARGE_SEEK_MS) {
            reloadAndSeek(target); // 差距太大：重建播放器再对齐，避免原地大幅 seek 卡死
          } else {
            alignTo(target, true); // 暂停→跳转→seeked 后恢复
          }
          return;
        }
      }
      // 卡缓冲看门狗：只在"有数据（readyState≥2）但播放头不动"时动作；
      // 慢网络正常缓冲（readyState 0/1，或 networkState=2 正在下载）不打扰。
      // 只在最近 seek 过（20 秒内）启用。
      if (
        now - lastSeekAt < SEEK_WATCH_MS &&
        audio.readyState >= 2 &&
        audio.networkState !== 2 &&
        !nearEnd &&
        !progressRecent &&
        now - lastTickAt >= SEEK_STALL_MS
      ) {
        if (stallRetries < 3) {
          stallRetries++;
          lastTickAt = now;
          alignTo(tMs, true); // 强制"暂停→跳转→恢复"，打破卡死状态
        } else {
          // 多次 seek 都无效：重建播放器，走正常对齐流程（计数交给对齐卡死检测）
          stallRetries = 0;
          alignStallReloads = 0;
          recoverAlignment();
          return;
        }
      }
    } else {
      stallRetries = 0;
    }
  } else {
    stallRetries = 0;
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
    // 数据其实已就绪但之前因暂停没对齐：直接开始"暂停→跳转→恢复"
    if (audio.readyState >= 2) alignAfterStarted();
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
    cancelSeekResume();
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

// 播放模式符号：用 LaTeX 公式经 KaTeX 预渲染成 HTML（字体已内置，离线可用）
const MODE_LATEX_HTML = {
  order:
    '<span class="katex"><span class="katex-html" aria-hidden="true"><span class="base"><span class="strut" style="height:0.3669em;"></span><span class="mrel">→</span></span></span></span>',
  shuffle:
    '<span class="mode-symbol-cross-wrap">' +
      '<span class="mode-symbol-cross"><span class="katex"><span class="katex-html" aria-hidden="true"><span class="base"><span class="strut" style="height:0.8889em;vertical-align:-0.1944em;"></span><span class="mrel">↗</span></span></span></span></span>' +
      '<span class="mode-symbol-cross"><span class="katex"><span class="katex-html" aria-hidden="true"><span class="base"><span class="strut" style="height:0.8889em;vertical-align:-0.1944em;"></span><span class="mrel">↘</span></span></span></span></span>' +
    '</span>',
  single:
    '<span class="katex"><span class="katex-html" aria-hidden="true"><span class="katex-base"><span class="katex-strut" style="height:0.8558em;vertical-align:-0.1808em;"></span><span class="mrel amsrm">↺</span></span></span></span><span class="mode-symbol-one">1</span>',
};

function renderMode() {
  const mode = state?.playMode || 'order';
  const label = MODE_LABELS[mode] || '顺序';
  const btn = ui.modeBtn;
  if (!btn) return;
  const latex = MODE_LATEX_HTML[mode];
  btn.innerHTML = latex
    ? '<span class="mode-symbol" aria-hidden="true">' + latex + '</span><span class="mode-label">' + label + '</span>'
    : label;
  // 微信内置浏览器偶发只改了数据、屏幕上文字不刷新，
  // 所以放到点击事件结束后刷新，并强制重绘一次
  requestAnimationFrame(() => {
    btn.classList.remove('mode-order', 'mode-shuffle', 'mode-single');
    btn.classList.add('mode-' + mode);
    const prev = btn.style.display;
    btn.style.display = 'none';
    void btn.offsetHeight;
    btn.style.display = prev;
  });
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
  const pos = Math.round(Number(ui.seek.value) || 0);
  userSeek(pos); // 本地立即跳转，不等服务器回包
  sendControl('seek', { positionMs: pos });
});

// ---------- 渲染 ----------
function renderPlaylist() {
  ui.playlist.innerHTML = '';
  renderMode();
  (state?.playlist || []).forEach((t, i) => {
    const item = document.createElement('div');
    item.className = 'track' + (i === state.currentIndex ? ' active' : '');
    const idx = document.createElement('span');
    idx.className = 'track-index';
    idx.textContent = String(i + 1).padStart(2, '0');
    const play = document.createElement('button');
    play.className = 'track-play';
    play.setAttribute('aria-label', '播放 ' + t.name);
    play.innerHTML =
      '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8.5 5.4v13.2L19 12z"/></svg>';
    play.addEventListener('click', () => sendControl('select', { index: i }));
    const name = document.createElement('span');
    name.className = 'track-name';
    name.textContent = t.name;
    // 正在播放的当前曲目：歌名前加绿色“正在播放”标签
    const playingBadge = state?.playing && i === state.currentIndex;
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
    if (playingBadge) {
      const badge = document.createElement('span');
      badge.className = 'track-playing-badge';
      badge.textContent = '正在播放';
      item.append(idx, play, badge, name, meta, del);
    } else {
      item.append(idx, play, name, meta, del);
    }
    ui.playlist.append(item);
  });
  if (ui.queueCount) ui.queueCount.textContent = String(state?.playlist?.length || 0);
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
  const playing = state?.playing === true;
  ui.playBtn.dataset.playing = playing ? 'true' : 'false';
  ui.playBtn.setAttribute('aria-label', playing ? '暂停' : '播放');
  if (ui.vinyl) {
    ui.vinyl.classList.toggle('spinning', playing && !!track);
    if (ui.vinylLabel) {
      ui.vinylLabel.textContent = track ? track.name.trim().charAt(0) || '♪' : '♪';
    }
  }
}

function renderMembers() {
  ui.memberCount.textContent = members.length;
  ui.memberList.innerHTML = '';
  members.forEach((m) => {
    const chip = document.createElement('span');
    chip.className = 'member';
    chip.style.setProperty('--hue', memberHue(m.nickname) + 'deg');
    chip.textContent = m.nickname;
    ui.memberList.append(chip);
  });
}

// 昵称生成一个稳定的色相，成员头像点用同色系
function memberHue(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

function fmt(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return m + ':' + String(s % 60).padStart(2, '0');
}

function renderTime() {
  let cur = audio.currentTime * 1000;
  // 音频还没就绪/还没对齐时，先显示对齐目标进度，避免进房/大跳转后进度条长时间卡在 0
  if (needAlign && state) {
    cur = currentTargetMs();
  }
  const dur = currentDurMs();
  ui.timeLabel.textContent = fmt(cur) + ' / ' + fmt(dur);
  if (!dragging) {
    ui.seek.value = dur > 0 ? Math.min(Math.round(cur), Math.floor(dur)) : Math.round(cur);
  }
  const pct = ui.seek.max > 0 ? Math.min(100, (cur / ui.seek.max) * 100) : 0;
  ui.seek.style.setProperty('--seek-pct', pct + '%');
}

// ---------- 聊天 ----------
function appendChat(nick, text, id) {
  const div = document.createElement('div');
  div.className = 'chat-msg';
  div.dataset.id = id || '';
  const own = Boolean(id) && nick === nickname;
  div.dataset.own = own ? '1' : '0';
  const n = document.createElement('b');
  n.textContent = nick + '：';
  const t = document.createElement('span');
  t.textContent = text;
  div.append(n, t);
  if (own && id) {
    let pressTimer = null;
    const showRecallMenu = () => {
      if (div.querySelector('.recall-btn')) return;
      const btn = document.createElement('button');
      btn.className = 'recall-btn';
      btn.textContent = '撤回';
      btn.addEventListener('click', () => {
        send({ type: 'recall_message', id });
        const existing = div.querySelector('.recall-btn');
        if (existing) existing.remove();
      });
      div.append(btn);
    };
    // 手机：长按约 0.5 秒弹出；滑动/松手取消
    div.addEventListener(
      'touchstart',
      () => {
        clearTimeout(pressTimer);
        pressTimer = setTimeout(showRecallMenu, 500);
      },
      { passive: true }
    );
    ['touchend', 'touchmove', 'touchcancel'].forEach((evt) =>
      div.addEventListener(evt, () => clearTimeout(pressTimer))
    );
    // 电脑：右键直接弹出
    div.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      clearTimeout(pressTimer);
      showRecallMenu();
    });
  }
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

// ---------- 搜索来源切换：本地曲库 / 在线音乐 ----------
function setSearchTab(tab) {
  searchTab = tab;
  ui.tabLocal.classList.toggle('active', tab === 'local');
  ui.tabOnline.classList.toggle('active', tab === 'online');
  ui.tabLocal.setAttribute('aria-selected', tab === 'local' ? 'true' : 'false');
  ui.tabOnline.setAttribute('aria-selected', tab === 'online' ? 'true' : 'false');
  ui.platformTabs.classList.toggle('hidden', tab !== 'online');
  ui.librarySearch.placeholder = tab === 'local' ? '搜索本地曲库…' : '搜索在线音乐…';
  ui.librarySearch.value = '';
  ui.libraryResults.classList.add('hidden');
  ui.libraryResults.innerHTML = '';
}
ui.tabLocal.addEventListener('click', () => setSearchTab('local'));
ui.tabOnline.addEventListener('click', () => setSearchTab('online'));

// 在线音乐按平台分开显示：网易云 / 咪咕
function setOnlineSource(source) {
  onlineSource = source;
  ui.platNetease.classList.toggle('active', source === 'netease');
  ui.platMigu.classList.toggle('active', source === 'migu');
  ui.platNetease.setAttribute('aria-selected', source === 'netease' ? 'true' : 'false');
  ui.platMigu.setAttribute('aria-selected', source === 'migu' ? 'true' : 'false');
  onlineOffset = 0;
  onlineHasMore = false;
  ui.libraryResults.classList.add('hidden');
  ui.libraryResults.innerHTML = '';
  // 已有搜索词时立即按新平台重新搜索
  if (searchTab === 'online' && ui.librarySearch.value.trim()) {
    clearTimeout(libraryTimer);
    searchOnline();
  }
}
ui.platNetease.addEventListener('click', () => setOnlineSource('netease'));
ui.platMigu.addEventListener('click', () => setOnlineSource('migu'));

// ---------- 本地曲库：搜索与添加 ----------
function scheduleLibrarySearch() {
  clearTimeout(libraryTimer);
  libraryTimer = setTimeout(searchLibrary, 250);
}

async function searchLibrary() {
  if (searchTab === 'online') return searchOnline();
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

// ---------- 在线音乐：搜索与添加 ----------
async function searchOnline() {
  const q = ui.librarySearch.value.trim();
  const seq = ++librarySeq;
  clearTimeout(libraryTimer);
  onlineOffset = 0;
  onlineHasMore = false;
  if (!q) {
    ui.libraryResults.classList.add('hidden');
    ui.libraryResults.innerHTML = '';
    return;
  }
  ui.libraryResults.classList.remove('hidden');
  ui.libraryResults.innerHTML = '<div class="lib-note">搜索中…</div>';
  try {
    const res = await fetch(
      '/api/online/search?q=' + encodeURIComponent(q) + '&source=' + onlineSource + '&offset=0'
    );
    const data = await res.json();
    if (seq !== librarySeq) return; // 丢弃过期结果
    if (!res.ok) throw new Error(data.error || '搜索失败');
    renderOnlineResults(data.results || [], data.total || 0, data.vipEnabled === true, data.hasMore === true);
  } catch {
    if (seq === librarySeq) {
      ui.libraryResults.innerHTML = '<div class="lib-note">在线曲库暂时不可用，请稍后再试</div>';
    }
  }
}

function makeOnlineRow(t, vipEnabled) {
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
  // 会员歌：只有服务器配了有效会员 Cookie 才允许添加
  if (t.playable || (vipEnabled && !t.playable)) {
    add.textContent = '+ 添加';
    add.addEventListener('click', () => addOnlineTrack(t, add));
  } else {
    add.textContent = '会员专属';
    add.disabled = true;
  }
  row.append(badge, name, meta, add);
  return row;
}

function appendOnlineRows(results, vipEnabled, beforeEl) {
  const frag = document.createDocumentFragment();
  results.forEach((t) => frag.append(makeOnlineRow(t, vipEnabled)));
  ui.libraryResults.insertBefore(frag, beforeEl || null);
}

function renderOnlineResults(results, total, vipEnabled, hasMore) {
  ui.libraryResults.innerHTML = '';
  if (total === 0) {
    const note = document.createElement('div');
    note.className = 'lib-note';
    note.textContent = '没有找到匹配的在线歌曲';
    ui.libraryResults.append(note);
    return;
  }
  appendOnlineRows(results, vipEnabled);
  onlineHasMore = hasMore;
  if (hasMore) {
    const more = document.createElement('button');
    more.className = 'load-more';
    more.textContent = '加载更多';
    more.addEventListener('click', loadMoreOnline);
    ui.libraryResults.append(more);
  }
}

async function loadMoreOnline() {
  const q = ui.librarySearch.value.trim();
  if (!q || searchTab !== 'online' || !onlineHasMore) return;
  const btn = ui.libraryResults.querySelector('.load-more');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '加载中…';
  }
  try {
    const res = await fetch(
      '/api/online/search?q=' + encodeURIComponent(q) + '&source=' + onlineSource + '&offset=' + onlineOffset
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '加载失败');
    appendOnlineRows(data.results || [], data.vipEnabled === true, btn);
    onlineOffset += (data.results || []).length;
    onlineHasMore = data.hasMore === true;
    if (btn) {
      if (onlineHasMore) {
        btn.disabled = false;
        btn.textContent = '加载更多';
      } else {
        btn.remove();
      }
    }
  } catch {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '加载更多';
    }
  }
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
    // 必须在这次点击里直接 play()，iPhone 才会真正放行声音；
    // 之后对齐逻辑会在 playing 事件里自动跳到房间进度
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
  if (creatingRoom) return; // 正在创建中，忽略重复点击（防微信下连点叠出多个连接）
  const nick = ui.nickname.value.trim();
  if (!nick) {
    ui.hint.textContent = '请先填写昵称';
    ui.nickname.focus();
    return;
  }
  nickname = nick.slice(0, 20); // 与服务端 cleanNick 一致，保证“自己的消息”判断正确
  saveNickname(nick);
  creatingRoom = true;
  roomCode = null;
  leftRoom = false;
  clearTimeout(autoJoinTimer);
  unlockAudio();
  ui.createBtn.disabled = true;
  ui.hint.textContent = '正在创建房间…';
  connect();
});

ui.joinBtn.addEventListener('click', () => {
  const nick = ui.nickname.value.trim();
  if (!nick) {
    ui.hint.textContent = '请先填写昵称';
    ui.nickname.focus();
    return;
  }
  nickname = nick.slice(0, 20); // 与服务端 cleanNick 一致，保证“自己的消息”判断正确
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
  // 房间码输满 6 位：高亮加入按钮，提醒用户可以加入
  ui.joinBtn.classList.toggle('ready', v.length === 6);
}
ui.roomCodeInput.addEventListener('input', updateRoomCodeInput);

ui.copyBtn.addEventListener('click', () => {
  const text = roomCode || '';
  const done = () => {
    ui.copyBtn.textContent = '已复制';
    setTimeout(() => (ui.copyBtn.textContent = '复制房间号'), 1600);
  };
  const fallbackManual = () => {
    if (/MicroMessenger/i.test(navigator.userAgent || '')) {
      // 微信自带浏览器屏蔽 prompt：改在页面内提示长按复制
      ui.hint.textContent = '复制失败，请长按房间号手动复制';
    } else {
      const r = prompt('房间号：', text);
      if (r !== null) done();
    }
  };

  // 1) 微信自带浏览器：走微信内置剪贴板桥（prompt/execCommand 都可能被 XWeb 屏蔽）
  if (window.WeixinJSBridge && typeof window.WeixinJSBridge.invoke === 'function') {
    try {
      window.WeixinJSBridge.invoke(
        'clipboardData',
        { data: text, type: 'text/plain' },
        (res) => {
          const errMsg = res && res.err_msg ? String(res.err_msg) : '';
          if (errMsg === 'clipboardData:ok' || errMsg.indexOf('ok') >= 0) done();
          else legacyCopy();
        }
      );
      return;
    } catch {}
  }

  legacyCopy();

  function legacyCopy() {
    // 2) 安全上下文（HTTPS/localhost）：标准剪贴板 API
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done).catch(execCopy);
      return;
    }
    execCopy();
  }

  function execCopy() {
    // 3) 传统 execCommand 兜底（HTTP 环境，必须由用户点击触发）
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.style.top = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, text.length);
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      if (ok) {
        done();
        return;
      }
    } catch {}
    // 4) 最后兜底：提示手动长按复制（微信下 prompt 无效，改用页内提示）
    fallbackManual();
  }
});

// 退出房间：断开连接、清空记录、回到输入房间号页面
function leaveRoom() {
  leftRoom = true;
  clearTimeout(autoJoinTimer);
  clearTimeout(reconnectTimer);
  try {
    // 主动退出：告诉服务器立即移除自己，不走 15 秒宽限期
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'leave' }));
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
  lastSeekAt = 0;
  state = null;
  members = [];
  enteredRoom = false;
  roomCode = null;
  creatingRoom = false;
  setSearchTab('online');
  ui.librarySearch.value = '';
  ui.libraryResults.classList.add('hidden');
  ui.libraryResults.innerHTML = '';
  // 清空聊天记录，避免新建房间时残留上一个房间的消息
  ui.chatList.innerHTML = '';
  ui.unlock.classList.add('hidden');
  ui.roomCodeInput.value = '';
  updateRoomCodeInput();
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
  updateRoomCodeInput();
})();

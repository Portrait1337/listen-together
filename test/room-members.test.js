// 回归测试：
// 1. 同一昵称（含微信重连场景）在房间成员列表中只能出现一次
// 2. 心跳能清理不响应（微信切后台/网络切换）的死连接，残留成员会被移除
// 用法：node test/room-members.test.js            （本地起测试服务器）
//      WS_URL=ws://192.168.1.3:3000/ws node test/room-members.test.js （测远端）
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const WebSocket = require(path.join(__dirname, '..', 'node_modules', 'ws'));

const PORT = 3101;
const LIB = '/tmp/lt-test-library';
// 上传目录指向独立临时目录：测试服务器启动时会跑孤儿上传清理，
// 不隔离会误删项目真实 uploads/ 里无人引用的用户文件
const UPLOAD_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-rm-upload-'));
fs.mkdirSync(LIB, { recursive: true });

function client(url) {
  const ws = new WebSocket(url);
  const waiters = [];
  const inbox = [];
  ws.on('message', (raw) => {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    inbox.push(m);
    waiters.slice().forEach((w) => w(m));
  });
  return {
    ws,
    inbox,
    sent: (o) => ws.send(JSON.stringify(o)),
    wait: (pred, timeout = 6000) => {
      const idx = inbox.findIndex(pred);
      if (idx >= 0) {
        const m = inbox[idx];
        inbox.splice(idx, 1);
        return Promise.resolve(m);
      }
      return new Promise((res, rej) => {
        const timer = setTimeout(() => rej(new Error('等待消息超时')), timeout);
        const h = (m) => {
          if (pred(m)) {
            clearTimeout(timer);
            const i = waiters.indexOf(h);
            if (i >= 0) waiters.splice(i, 1);
            const j = inbox.indexOf(m);
            if (j >= 0) inbox.splice(j, 1);
            res(m);
          }
        };
        waiters.push(h);
      });
    },
  };
}

const open = (c) =>
  new Promise((res, rej) => {
    c.ws.on('open', res);
    c.ws.on('error', rej);
  });

async function main() {
  let child = null;
  let url = process.env.WS_URL;
  if (!url) {
    child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: {
        ...process.env,
        PORT: String(PORT),
        UPLOAD_DIR: UPLOAD_TMP,
        LIBRARY_DIR: LIB,
        NETEASE_COOKIE_FILE: path.join(__dirname, '..', 'netease-cookie.txt'),
        WS_HEARTBEAT_MS: '400',
        MEMBER_GRACE_MS: '500',
      },
      stdio: 'ignore',
    });
    url = `ws://127.0.0.1:${PORT}/ws`;
  }

  // 等待服务就绪
  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) {
    try {
      const probe = new WebSocket(url);
      await new Promise((res, rej) => {
        probe.on('open', res);
        probe.on('error', rej);
      });
      probe.close();
      ready = true;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  if (!ready) throw new Error('测试服务器未启动');

  // 场景：A 创建房间（昵称 小明），B 用相同昵称加入（模拟微信重连/重复打开）
  const a = client(url);
  await open(a);
  a.sent({ type: 'create_room', name: '测试房', nickname: '小明' });
  const created = await a.wait((m) => m.type === 'room_created');
  const code = created.code;
  await a.wait((m) => m.type === 'members');
  const aState = await a.wait((m) => m.type === 'state');
  if (aState.code !== code) throw new Error('A 房间状态异常');

  const b = client(url);
  await open(b);
  b.sent({ type: 'join_room', code, nickname: '小明' });
  const membersMsg = await b.wait((m) => m.type === 'members');
  const names = membersMsg.members.map((x) => x.nickname);
  const count = names.filter((n) => n === '小明').length;

  console.log('同一昵称在成员列表中的出现次数：', count, JSON.stringify(names));
  if (count !== 1) {
    console.error('FAIL：同一用户出现多次（' + count + ' 次）');
    process.exitCode = 1;
  } else {
    console.log('PASS：同一昵称只出现一次');
  }

  // 场景二（仅本地测试，生产心跳间隔 30 秒）：D（昵称 小红）变成"死连接"
  // （暂停 TCP 读取，不再应答服务端 ping，模拟微信切后台/网络切换残留），
  // 心跳应把它清掉并广播 member_left
  if (!process.env.WS_URL) {
    console.log('场景二开始：模拟死连接');
    const d = client(url);
    await open(d);
    d.sent({ type: 'join_room', code, nickname: '小红' });
    await d.wait((m) => m.type === 'members');
    d.ws._socket.pause();
    const leftMsg = await a.wait((m) => m.type === 'member_left' && m.members.every((x) => x.nickname !== '小红'), 8000);
    const leftNames = leftMsg.members.map((x) => x.nickname);
    console.log('死连接清理后成员列表：', JSON.stringify(leftNames));
    if (leftNames.some((n) => n === '小红')) {
      console.error('FAIL：死连接未被心跳清理');
      process.exitCode = 1;
    } else {
      console.log('PASS：死连接被心跳清理');
    }
  }

  // 场景三（仅本地）：断开后 500ms 宽限期内同昵称重连，
  // 其他人不应看到 member_left/member_joined 闪烁
  if (!process.env.WS_URL) {
    console.log('场景三开始：宽限期重连');
    const o = client(url);
    await open(o);
    o.sent({ type: 'join_room', code, nickname: '观察员' });
    await o.wait((m) => m.type === 'members');
    o.inbox.length = 0; // 清空基线消息，只统计后续的离开/加入闪烁

    a.ws.close(); // 模拟断线（不主动 leave）
    const c = client(url);
    await open(c);
    c.sent({ type: 'join_room', code, nickname: '小明' });
    await c.wait((m) => m.type === 'members');

    await new Promise((r) => setTimeout(r, 1200)); // 超过 500ms 宽限期
    const flash = o.inbox.filter((m) => m.type === 'member_left' || m.type === 'member_joined');
    if (flash.length > 0) {
      console.error('FAIL：宽限期重连仍出现离开/加入闪烁:', JSON.stringify(flash));
      process.exitCode = 1;
    } else {
      console.log('PASS：宽限期内重连无闪烁');
    }
    o.ws.close();
  }

  // 场景四：主动发送 leave 消息后应立即广播 member_left（不走宽限期）
  {
    console.log('场景四开始：主动 leave');
    const obs = client(url);
    await open(obs);
    obs.sent({ type: 'join_room', code, nickname: '观察员2' });
    await obs.wait((m) => m.type === 'members');
    const act = client(url);
    await open(act);
    act.sent({ type: 'join_room', code, nickname: '小红' });
    await act.wait((m) => m.type === 'members');
    act.sent({ type: 'leave' });
    act.ws.close();
    const leftMsg = await obs.wait((m) => m.type === 'member_left', 3000);
    const ok = (leftMsg.members || []).every((x) => x.nickname !== '小红');
    if (!ok) {
      console.error('FAIL：leave 后小红仍在成员列表');
      process.exitCode = 1;
    } else {
      console.log('PASS：主动 leave 立即广播离开');
    }
    obs.ws.close();
  }

  a.ws.close();
  b.ws.close();
  if (child) child.kill();
  fs.rmSync(UPLOAD_TMP, { recursive: true, force: true });
  fs.rmSync(LIB, { recursive: true, force: true });
  setTimeout(() => process.exit(process.exitCode || 0), 200);
}

main().catch((e) => {
  console.error('测试异常：', e.message);
  fs.rmSync(UPLOAD_TMP, { recursive: true, force: true });
  fs.rmSync(LIB, { recursive: true, force: true });
  process.exit(1);
});

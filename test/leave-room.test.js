const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function makeEl() {
  const el = {
    innerHTML: '',
    textContent: '',
    value: '',
    disabled: false,
    className: '',
    style: {},
    files: [],
    scrollTop: 0,
    scrollHeight: 0,
    classList: new Proxy(
      {},
      {
        get: (t, p) => (p in t ? t[p] : () => {}),
      }
    ),
    append() {},
    addEventListener() {},
    removeEventListener() {},
    focus() {},
    setAttribute() {},
    remove() {},
  };
  return new Proxy(el, {
    get: (t, p) => (p in t ? t[p] : () => {}),
    set: (t, p, v) => {
      t[p] = v;
      return true;
    },
  });
}

function makeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

test('退出房间后清空聊天记录，新建房间不会残留上个房间的聊天', () => {
  const src =
    fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8') +
    '\n;globalThis.__test = { leaveRoom, ui };';

  const sandbox = {
    console,
    setTimeout() {},
    clearTimeout() {},
    setInterval() {},
    clearInterval() {},
    requestAnimationFrame() {},
    confirm: () => true,
    alert() {},
    prompt() {},
    URLSearchParams,
    WebSocket: class {
      constructor() {
        this.readyState = 0;
      }
      static OPEN = 1;
      send() {}
      close() {}
      addEventListener() {}
    },
    location: {
      protocol: 'http:',
      host: 'localhost:3000',
      search: '',
      pathname: '/',
    },
    history: { replaceState() {} },
    navigator: {},
    localStorage: makeStorage(),
    sessionStorage: makeStorage(),
    document: {
      getElementById: () => makeEl(),
      createElement: () => makeEl(),
      querySelector: () => makeEl(),
      querySelectorAll: () => [],
      body: makeEl(),
      addEventListener() {},
    },
    window: { isSecureContext: true },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
  };
  sandbox.globalThis = sandbox;

  vm.runInNewContext(src, sandbox);
  const { leaveRoom, ui } = sandbox.__test;

  // 模拟第一个房间已经显示过聊天消息
  ui.chatList.innerHTML = '<div>第一个房间的旧消息</div>';
  leaveRoom();

  assert.equal(ui.chatList.innerHTML, '');
});

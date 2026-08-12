const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function makeEl() {
  const el = {
    _listeners: {},
    children: [],
    parent: null,
    dataset: {},
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
    append(...kids) {
      for (const k of kids) {
        k.parent = this;
        this.children.push(k);
      }
    },
    addEventListener(type, fn) {
      (this._listeners[type] = this._listeners[type] || []).push(fn);
    },
    remove() {
      if (!this.parent) return;
      const i = this.parent.children.indexOf(this);
      if (i >= 0) this.parent.children.splice(i, 1);
      this.parent = null;
    },
    querySelector(sel) {
      const cls = sel.startsWith('.') ? sel.slice(1) : null;
      const dataMatch = sel.match(/^\[data-id="([^"]*)"\]$/);
      const walk = (node) => {
        for (const c of node.children || []) {
          if (cls && String(c.className || '').split(/\s+/).includes(cls)) return c;
          if (dataMatch && c.dataset && c.dataset.id === dataMatch[1]) return c;
          const found = walk(c);
          if (found) return found;
        }
        return null;
      };
      return walk(this);
    },
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

function fire(el, type, ev = {}) {
  for (const fn of el._listeners[type] || []) fn(ev);
}

test('长按自己的消息弹出撤回按钮，点击发送撤回；他人消息不弹；撤回广播后消息被移除', () => {
  const src =
    fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8') +
    '\n;globalThis.__test = { ui, appendChat, handleMessage, setNickname(v){ nickname = v; }, setWs(v){ ws = v; } };';

  const sandbox = {
    console,
    setTimeout: (fn) => {
      fn();
      return 0;
    },
    clearTimeout() {},
    setInterval() {},
    clearInterval() {},
    requestAnimationFrame: (fn) => fn(),
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
  const { ui, appendChat, handleMessage, setNickname, setWs } = sandbox.__test;

  const sent = [];
  setNickname('小A');
  setWs({ readyState: 1, send: (s) => sent.push(JSON.parse(s)) });

  appendChat('小A', '我的消息', 'id-1');
  appendChat('小B', '别人的消息', 'id-2');
  const [mine, others] = ui.chatList.children;

  // 长按自己的消息：弹出撤回按钮，点击后发送撤回
  fire(mine, 'touchstart');
  const recallBtn = mine.querySelector('.recall-btn');
  assert.ok(recallBtn, '长按自己的消息应出现撤回按钮');
  fire(recallBtn, 'click');
  assert.deepEqual(sent, [{ type: 'recall_message', id: 'id-1' }]);

  // 长按别人的消息：不弹撤回按钮
  fire(others, 'touchstart');
  assert.equal(others.querySelector('.recall-btn'), null);

  // 收到撤回广播：对应消息从列表移除
  handleMessage({ type: 'message_recalled', id: 'id-1' });
  assert.equal(ui.chatList.children.length, 1);
  assert.equal(ui.chatList.children[0].dataset.id, 'id-2');
});

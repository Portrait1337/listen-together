const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const online = require('../online.js');

const WAV = Buffer.concat([
  Buffer.from('UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA', 'base64'),
  Buffer.alloc(4096),
]);

// 构造换源场景的 mock：网易云外链 404 → VIP 无 → 咪咕搜索返回指定 id
function makeMockFetch(miguId) {
  return async (url) => {
    const u = new URL(url);
    if (u.pathname === '/song/media/outer/url') {
      return { ok: false, status: 404, headers: { get: () => '' } };
    }
    if (u.pathname === '/api/song/enhance/player/url') {
      return { ok: true, status: 200, json: async () => ({ code: 200, data: [{ url: null }] }) };
    }
    if (u.pathname === '/MIGUM2.0/v1.0/content/search_all.do') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          songResultData: {
            result: [
              {
                id: miguId,
                contentId: 'c',
                copyrightId: 'cr',
                name: '测试歌',
                singers: [{ name: '歌手' }],
              },
            ],
          },
        }),
      };
    }
    if (u.pathname === '/MIGUM3.0/v1.0/content/sub/listen.do') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ songListens: [{ url: 'http://x.migu.cn/ok.mp3' }] }),
      };
    }
    if (u.hostname === 'x.migu.cn') {
      return {
        ok: true,
        status: 200,
        headers: {
          get: (k) =>
            k === 'content-type' ? 'audio/mpeg' : k === 'content-length' ? String(WAV.length) : '',
        },
        body: new ReadableStream({ start(c) { c.enqueue(WAV); c.close(); } }),
      };
    }
    throw new Error('unexpected fetch: ' + url);
  };
}

test('换源下载时第三方返回含路径分隔符的歌曲 id：拒绝下载，不发生路径穿越', async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-online-path-'));
  const destDir = path.join(tmpBase, 'dest');
  fs.mkdirSync(destDir, { recursive: true });
  try {
    const result = await online.resolveAndDownloadOnline('netease:123', '测试歌', '歌手', destDir, {
      fetchImpl: makeMockFetch('x/../../pwn'),
    });
    assert.ok(result.error, '畸形 id 应返回错误，实际: ' + JSON.stringify(result));
    // 穿越目标是 destDir 上级的 pwn.mp3，绝不能出现
    assert.ok(!fs.existsSync(path.join(tmpBase, 'pwn.mp3')), '不应有穿越文件');
    assert.deepEqual(fs.readdirSync(destDir), []);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('换源下载时正常数字 id 仍能正常下载', async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-online-ok-'));
  const destDir = path.join(tmpBase, 'dest');
  fs.mkdirSync(destDir, { recursive: true });
  try {
    const result = await online.resolveAndDownloadOnline('netease:123', '测试歌', '歌手', destDir, {
      fetchImpl: makeMockFetch('333'),
    });
    assert.equal(result.error, undefined, '正常 id 不应报错: ' + JSON.stringify(result));
    assert.equal(result.file, 'migu-333.mp3');
    assert.ok(fs.existsSync(path.join(destDir, 'migu-333.mp3')));
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

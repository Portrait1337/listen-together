const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const cos = require('../cos');

async function main() {
  // 用临时配置 + 假客户端，不碰真实网络
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-test-'));
  const cfgPath = path.join(tmpDir, 'cos-config.json');
  fs.writeFileSync(
    cfgPath,
    JSON.stringify({
      bucket: 'test-bucket-1250000000',
      region: 'ap-guangzhou',
      secretId: 'AKIDtest',
      secretKey: 'testkey',
      cdnBaseUrl: '',
    })
  );
  const calls = [];
  cos._setConfigFile(cfgPath);
  cos._setClientForTest({
    putObject: (params, cb) => {
      calls.push(params);
      cb(null, { ETag: '"abc"' });
    },
    deleteObject: (params, cb) => {
      calls.push(params);
      cb(null, {});
    },
  });

  assert.strictEqual(cos.enabled(), true, 'enabled() 应为 true');

  const local = path.join(tmpDir, 'a.mp3');
  fs.writeFileSync(local, 'hello');
  const url = await cos.uploadFile(local, 'uploads/abc123.mp3', 'audio/mpeg');
  assert.strictEqual(
    url,
    'https://test-bucket-1250000000.cos.ap-guangzhou.myqcloud.com/uploads/abc123.mp3',
    'URL 拼接错误'
  );
  assert.strictEqual(calls[0].Bucket, 'test-bucket-1250000000');
  assert.strictEqual(calls[0].Key, 'uploads/abc123.mp3');
  assert.strictEqual(calls[0].ContentType, 'audio/mpeg');
  assert.ok(calls[0].Body.pipe, 'Body 应为可读流');

  await cos.deleteObject('uploads/abc123.mp3');
  assert.strictEqual(calls[1].Key, 'uploads/abc123.mp3');

  // cleanupOrphans：被引用的保留、无引用的删除；删除失败的对象下轮重试
  cos.recordKey('uploads/keep.mp3');
  cos.recordKey('uploads/doomed.mp3');
  cos.recordKey('uploads/fail.mp3');
  const delCalls = [];
  let failAttempts = 0;
  cos._setClientForTest({
    putObject: (p, cb) => cb(null, {}),
    deleteObject: (params, cb) => {
      delCalls.push(params.Key);
      // fail.mp3 第一次删除失败（网络错误），第二次成功：验证失败对象保留并重试
      if (params.Key === 'uploads/fail.mp3') {
        failAttempts += 1;
        return cb(failAttempts === 1 ? new Error('网络错误') : null, {});
      }
      cb(null, {});
    },
  });
  const removed = await cos.cleanupOrphans(new Set(['uploads/keep.mp3']));
  assert.strictEqual(removed, 1, '本轮应删除 1 个（doomed 成功，fail 网络错误待重试）');
  assert.deepStrictEqual(delCalls.sort(), ['uploads/doomed.mp3', 'uploads/fail.mp3'].sort());
  // 删除失败的对象保留在集合：下轮清理重试
  delCalls.length = 0;
  const removed2 = await cos.cleanupOrphans(new Set(['uploads/keep.mp3']));
  assert.strictEqual(removed2, 1, '失败对象下轮重试删除');
  assert.deepStrictEqual(delCalls, ['uploads/fail.mp3']);

  cos._setClientForTest(null);
  console.log('PASS：cos.js 单元测试通过');
}

main().catch((e) => {
  console.error('FAIL：', e.message);
  process.exit(1);
});

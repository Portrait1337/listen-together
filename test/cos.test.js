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

  cos._setClientForTest(null);
  console.log('PASS：cos.js 单元测试通过');
}

main().catch((e) => {
  console.error('FAIL：', e.message);
  process.exit(1);
});

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseFlacDurationMs } = require('../flac');

async function main() {
  const tmp = path.join(os.tmpdir(), 'flac-test-' + Date.now() + '.flac');

  // 构造最小 FLAC 头：fLaC + STREAMINFO，采样率 44100，总采样 44100*60 = 60 秒
  const buf = Buffer.alloc(64);
  buf.write('fLaC', 0, 'ascii');
  buf[4] = 0x00; // STREAMINFO
  buf[5] = 0x00;
  buf[6] = 0x00;
  buf[7] = 34; // block 长度 34
  const b = 8 + 10;
  const sampleRate = 44100;
  const totalSamples = 44100 * 60;
  buf[b] = (sampleRate >> 12) & 0xff;
  buf[b + 1] = (sampleRate >> 4) & 0xff;
  buf[b + 2] = ((sampleRate & 0x0f) << 4) | ((totalSamples / 0x100000000) & 0x0f);
  buf[b + 3] = (totalSamples >> 32) & 0x0f;
  buf[b + 4] = (totalSamples >> 24) & 0xff;
  buf[b + 5] = (totalSamples >> 16) & 0xff;
  buf[b + 6] = (totalSamples >> 8) & 0xff;
  buf[b + 7] = totalSamples & 0xff;
  fs.writeFileSync(tmp, buf);

  const ms = parseFlacDurationMs(tmp);
  assert.strictEqual(ms, 60000, '60 秒 FLAC 应解析为 60000ms，实际 ' + ms);
  console.log('PASS：FLAC 时长解析 =', ms, 'ms');

  // 非 FLAC 文件返回 0
  const tmp2 = path.join(os.tmpdir(), 'flac-test-' + Date.now() + '.mp3');
  fs.writeFileSync(tmp2, 'not a flac file');
  assert.strictEqual(parseFlacDurationMs(tmp2), 0);
  console.log('PASS：非 FLAC 返回 0');

  // 真实 flac 验证（若存在）
  const real = '/tmp/user.flac';
  if (fs.existsSync(real)) {
    const realMs = parseFlacDurationMs(real);
    console.log('真实 flac 解析时长:', realMs, 'ms（afinfo 参考 230067ms）');
    assert.ok(Math.abs(realMs - 230067) < 100, '真实 flac 时长偏差过大: ' + realMs);
    console.log('PASS：真实 flac 与 afinfo 一致');
  }

  console.log('全部通过 ✓');
}

main().catch((e) => {
  console.error('FAIL：', e.message);
  process.exit(1);
});

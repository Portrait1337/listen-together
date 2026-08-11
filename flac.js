// flac.js - 读取 FLAC STREAMINFO 计算真实时长（毫秒）
// iOS/微信对 FLAC 流式播放的 duration 解析不可靠，上传时用本模块存一份权威时长
const fs = require('fs');

// 只读文件头 64KB 即可：STREAMINFO 一定在文件最前面
function parseFlacDurationMs(filePath) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    if (n < 42 || buf.toString('ascii', 0, 4) !== 'fLaC') return 0;
    // 元数据块头：1 字节（bit7=最后一块，低 7 位=类型），3 字节长度
    const type = buf[4] & 0x7f;
    const blockLen = (buf[5] << 16) | (buf[6] << 8) | buf[7];
    // 类型 0 = STREAMINFO，固定 34 字节
    if (type !== 0 || blockLen < 18) return 0;
    // STREAMINFO 内偏移 10 起：采样率 20bit + 声道 3bit + 位深 5bit + 总采样数 36bit
    const b = 8 + 10;
    const sampleRate = ((buf[b] << 12) | (buf[b + 1] << 4) | (buf[b + 2] >> 4)) & 0xfffff;
    const totalSamples =
      (buf[b + 3] & 0x0f) * 0x100000000 +
      buf[b + 4] * 0x1000000 +
      buf[b + 5] * 0x10000 +
      buf[b + 6] * 0x100 +
      buf[b + 7];
    if (!sampleRate || !totalSamples) return 0;
    return Math.round((totalSamples / sampleRate) * 1000);
  } catch {
    return 0;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

module.exports = { parseFlacDurationMs };

// 把 uploads/ 下已有文件批量转存 COS（不删除本地，安全起见）
// 用法：node scripts/migrate-uploads-cos.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cos = require('../cos');

const DIR = path.join(__dirname, '..', 'uploads');

async function main() {
  if (!cos.enabled()) {
    console.error('未配置 COS，退出');
    process.exit(1);
  }
  const files = fs.readdirSync(DIR).filter((f) => fs.statSync(path.join(DIR, f)).isFile());
  console.log(`待迁移 ${files.length} 个文件`);
  for (const f of files) {
    const ext = path.extname(f) || '.mp3';
    const key = 'uploads/' + crypto.randomBytes(12).toString('hex') + ext;
    const url = await cos.uploadFile(path.join(DIR, f), key, 'audio/mpeg');
    console.log(`${f} -> ${url}`);
  }
  console.log('迁移完成（本地文件保留，确认无误后可手动清理）');
}

main().catch((e) => {
  console.error('迁移失败：', e.message);
  process.exit(1);
});

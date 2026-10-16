// 从明确的发布清单生成手机部署包，避免把本地配置、音频或私人笔记带入。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const output = path.resolve(process.argv[2] || path.join(root, 'deploy/phone-部署包.zip'));
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-release-'));
const pending = output + '.tmp.zip';

try {
  const app = path.join(stage, 'listen-together');
  fs.mkdirSync(app);
  const rootFiles = [
    'server.js', 'online.js', 'cos.js', 'flac.js', 'config-paths.js',
    'package.json', 'package-lock.json', 'cos-config.example.json',
  ];
  for (const name of rootFiles) fs.copyFileSync(path.join(root, name), path.join(app, name));
  fs.copyFileSync(path.join(root, 'deploy/phone/README.md'), path.join(app, 'README.md'));
  // 静态资源按清单复制，包含当前页面引用的图标、字体与样式。
  for (const name of ['index.html', 'app.js', 'styles.css', 'sync-policy.js', 'earphones.svg',
    'fonts/SmileySans-Oblique.ttf.woff2', 'vendor/katex/katex.min.css',
    'vendor/katex/fonts/KaTeX_Main-Regular.woff2', 'vendor/katex/fonts/KaTeX_AMS-Regular.woff2']) {
    const target = path.join(app, 'public', name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, 'public', name), target);
  }
  for (const name of ['phone-setup.sh', '安装说明.txt', 'DDNS配置说明.txt',
    'ddnspod-update.sh', 'ddns-config.example.conf']) {
    fs.copyFileSync(path.join(root, 'deploy/phone', name), path.join(stage, name));
  }
  // 发布文件仅携带公开的示例配置，真实配置在安装设备上单独设置。
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.rmSync(pending, { force: true });
  execFileSync('zip', ['-q', '-r', pending, '.'], { cwd: stage });
  fs.renameSync(pending, output);
  console.log('手机部署包已生成：' + output);
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
  fs.rmSync(pending, { force: true });
}

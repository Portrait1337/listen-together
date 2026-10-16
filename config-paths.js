// 私人配置默认放在用户目录，单文件环境变量保持最高优先级。
const fs = require('fs');
const os = require('os');
const path = require('path');

function resolveConfigFile(filename, explicitPath) {
  if (explicitPath) return path.resolve(explicitPath);
  const configDir = process.env.LISTEN_TOGETHER_CONFIG_DIR ||
    path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'listen-together');
  const privatePath = path.resolve(configDir, filename);
  if (fs.existsSync(privatePath)) return privatePath;
  // 兼容尚未迁移配置的已有部署。
  return path.join(__dirname, filename);
}

module.exports = { resolveConfigFile };

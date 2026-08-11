// cos.js - 腾讯云 COS 上传封装（未配置时 enabled()=false，服务端自动回退本地存储）
const path = require('path');
const fs = require('fs');
const COS = require('cos-nodejs-sdk-v5');

let configFile = process.env.COS_CONFIG_FILE || path.join(__dirname, 'cos-config.json');
let testClient = null;
let client = null;
let bucket = '';
let region = '';
let baseUrl = '';

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch {
    return null;
  }
}

function enabled() {
  const cfg = loadConfig();
  return !!(cfg && cfg.bucket && cfg.secretId && cfg.secretKey);
}

function getClient() {
  if (client) return client;
  const cfg = loadConfig();
  if (!cfg) throw new Error('缺少 COS 配置（cos-config.json）');
  bucket = cfg.bucket;
  region = cfg.region;
  baseUrl = (cfg.cdnBaseUrl || `https://${bucket}.cos.${region}.myqcloud.com`).replace(/\/+$/, '');
  if (testClient) return testClient;
  client = new COS({ SecretId: cfg.secretId, SecretKey: cfg.secretKey });
  return client;
}

async function uploadFile(localPath, key, contentType) {
  const c = getClient();
  await new Promise((resolve, reject) => {
    c.putObject(
      {
        Bucket: bucket,
        Region: region,
        Key: key,
        Body: fs.createReadStream(localPath),
        ContentType: contentType,
      },
      (err) => (err ? reject(err) : resolve())
    );
  });
  return baseUrl + '/' + key.split('/').map(encodeURIComponent).join('/');
}

async function deleteObject(key) {
  const c = getClient();
  await new Promise((resolve, reject) => {
    c.deleteObject({ Bucket: bucket, Region: region, Key: key }, (err) =>
      err ? reject(err) : resolve()
    );
  });
}

function _setConfigFile(p) {
  configFile = p;
}

function _setClientForTest(c) {
  testClient = c;
  client = null;
}

module.exports = { enabled, uploadFile, deleteObject, _setConfigFile, _setClientForTest };

// cos.js - 腾讯云 COS 上传封装（未配置时 enabled()=false，服务端自动回退本地存储）
const fs = require('fs');
const COS = require('cos-nodejs-sdk-v5');
const { resolveConfigFile } = require('./config-paths');

let configFile = process.env.COS_CONFIG_FILE;
let testClient = null;
let client = null;
let bucket = '';
let region = '';
let baseUrl = '';

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(resolveConfigFile('cos-config.json', configFile), 'utf8'));
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

// 本进程上传过的对象 key：清理时只回收这些，重启后集合为空则保守不删，
// 避免误删其他实例或手动上传的对象（桶级生命周期规则可作兜底）
const uploadedKeys = new Set();

function recordKey(key) {
  uploadedKeys.add(key);
}

// 清理无人引用的对象：referenced 是当前仍被房间歌单引用的 key 集合。
// 删除失败的对象保留在集合里，下轮重试；返回本轮实际删除数量。
async function cleanupOrphans(referenced) {
  const doomed = [];
  for (const key of uploadedKeys) {
    if (!referenced.has(key)) doomed.push(key);
  }
  let removed = 0;
  for (const key of doomed) {
    try {
      await deleteObject(key);
      uploadedKeys.delete(key);
      removed += 1;
    } catch {
      // 删除失败（网络等）：保留 key，下轮清理重试
    }
  }
  return removed;
}

function _setConfigFile(p) {
  configFile = p;
}

function _setClientForTest(c) {
  testClient = c;
  client = null;
}

module.exports = { enabled, uploadFile, deleteObject, recordKey, cleanupOrphans, _setConfigFile, _setClientForTest };

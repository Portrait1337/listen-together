# 内容上云（腾讯云 COS/CDN）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「一起听」上传的音频改存腾讯云 COS，播放时听众直接从 COS/CDN 拉流，手机出口带宽从"每人一份"降为"几乎为零"，并发听歌容量从 ~20 人提升到 100+（受连接上限控制）。

**Architecture:** 上传流程改为"本地临时落盘 → multer 校验 → 上传 COS → 删除临时文件 → 播放地址指向 COS URL"。未配置 COS 时完全保持现有行为（本地 /uploads），保证降级兼容。COS 用"公有读私有写 + 随机对象名"，与当前安全模型一致；可选 CDN 加速域名。

**Tech Stack:** Node.js（现有 Express/multer/ws）+ `cos-nodejs-sdk-v5` + 腾讯云 COS 存储桶 + 可选 CDN。

**关键决策（可推翻，但建议保持）：**
1. 用腾讯云 COS（账号已有，与 DNSPod 同账号）
2. 存储桶权限：公有读私有写；对象名 = `uploads/<12字节随机hex><扩展名>`（不可枚举）
3. 不引入签名 URL（避免房间歌单里的 URL 过期问题）；后续要收紧再升级
4. 上传成功即删手机本地临时文件（手机只做中转，不存歌）
5. 未配置 COS 时自动回退到现有本地存储（老版本行为不变）

---

## 前置条件（Task 0，手动，约 15 分钟）

**在腾讯云控制台完成：**
- [ ] 开通 COS，创建存储桶，例如 `listen-together-125xxxxxxx`，地域 `ap-guangzhou`
- [ ] 存储桶权限：**公有读、私有写**
- [ ] 创建子账号 API 密钥（访问管理 CAM → 用户 → 新建用户 → 编程访问），授权策略仅限：
      `QcloudCOSFullAccess`（或更细：该桶的 PutObject/DeleteObject）
- [ ] （可选）给存储桶绑定 CDN 加速域名；不绑则用默认域名 `https://<bucket>.cos.<region>.myqcloud.com`
- [ ] 存储桶 → 生命周期规则：删除创建超过 30 天的对象（防止存储无限膨胀）

---

### Task 1: COS 客户端模块（含单元测试，TDD）

**Files:**
- Create: `cos.js`
- Create: `test/cos.test.js`

- [ ] **Step 1: 写失败测试**

创建 `test/cos.test.js`：

```js
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const cos = require('../cos');

async function main() {
  // 用临时配置 + 假客户端，不碰真实网络
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-test-'));
  const cfgPath = path.join(tmpDir, 'cos-config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    bucket: 'test-bucket-1250000000',
    region: 'ap-guangzhou',
    secretId: 'AKIDtest',
    secretKey: 'testkey',
    cdnBaseUrl: '',
  }));
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
```

- [ ] **Step 2: 运行测试，确认失败（cos.js 不存在）**

运行：`node test/cos.test.js`
预期：`Error: Cannot find module '../cos'`

- [ ] **Step 3: 创建 `cos.js`**

```js
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
  if (testClient) return testClient;
  if (client) return client;
  const cfg = loadConfig();
  if (!cfg) throw new Error('缺少 COS 配置（cos-config.json）');
  bucket = cfg.bucket;
  region = cfg.region;
  baseUrl = (cfg.cdnBaseUrl || `https://${bucket}.cos.${region}.myqcloud.com`).replace(/\/+$/, '');
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
  return baseUrl + '/' + encodeURIComponent(key);
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
```

- [ ] **Step 4: 运行测试，确认通过**

运行：`node test/cos.test.js`
预期：`PASS：cos.js 单元测试通过`

- [ ] **Step 5: 提交**

```bash
git add cos.js test/cos.test.js
git commit -m "feat: 新增 COS 上传封装模块（含单元测试）"
```

---

### Task 2: 修改上传接口（COS 优先，本地兜底）

**Files:**
- Modify: `server.js`（顶部 require 区 + `/api/upload` 路由）
- Test: `test/room-members.test.js`（回归确认没破坏）

- [ ] **Step 1: 写失败测试（先在当前代码上确认路径存在）**

在 `server.js` 顶部 `const online = require('./online');` 之后加一行：

```js
const cos = require('./cos');
```

运行：`node --check server.js`
预期：FAIL，`Cannot find module './cos'`（cos.js 在 Task 1 创建后不再失败——如 Task 1 已完成，此步直接通过）

- [ ] **Step 2: 修改 `/api/upload` 路由（Task 1 完成后做）**

把现有 `app.post('/api/upload', upload.single('file'), (req, res) => {` 整段替换为：

```js
app.post('/api/upload', upload.single('file'), async (req, res) => {
  const room = rooms.get(String(req.body.roomId || '').toUpperCase().trim());
  if (!room) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(404).json({ error: '房间不存在，请重新加入' });
  }
  const ext = (path.extname(req.file.originalname || '') || '.mp3').toLowerCase();
  const key = 'uploads/' + crypto.randomBytes(12).toString('hex') + ext;
  const contentType = req.file.mimetype || 'audio/mpeg';
  let url;
  if (cos.enabled()) {
    try {
      url = await cos.uploadFile(req.file.path, key, contentType);
    } catch (err) {
      fs.unlink(req.file.path, () => {});
      console.error('COS 上传失败：', err.message);
      return res.status(500).json({ error: '上传失败，请重试' });
    }
    fs.unlink(req.file.path, () => {}); // 上传成功即删除本地中转文件
  } else {
    url = '/uploads/' + req.file.filename; // 未配置 COS：保持原行为
  }
  const track = {
    id: crypto.randomBytes(6).toString('hex'),
    name: req.file.originalname,
    url,
    size: req.file.size,
    uploader: String(req.body.nickname || '匿名').trim().slice(0, 20) || '匿名',
    cosKey: cos.enabled() ? key : null,
  };
  room.playlist.push(track);
  if (room.currentIndex < 0) {
    room.currentIndex = 0;
    room.positionMs = 0;
    room.updatedAt = Date.now();
  }
  broadcast(room, snapshot(room));
  res.json({ ok: true, track });
});
```

注意：`req.file.originalname` 是 multer 按 UTF-8 解析后的原名；扩展名提取逻辑与原代码一致。

- [ ] **Step 3: 本地全量回归**

运行：
```bash
node --check server.js
node test/room-members.test.js
```
预期：语法 OK；`PASS：同一昵称只出现一次`、`PASS：死连接被心跳清理`

- [ ] **Step 4: 用现有上传流程测试（COS 未配置时应走本地回退）**

运行：`node /tmp/test-sync-phone.js`（或本地 test-sync 改造版）
预期：上传成功，`track.url` 以 `/uploads/` 开头（COS 未配置，行为不变）

- [ ] **Step 5: 提交**

```bash
git add server.js
git commit -m "feat: 上传优先转存 COS，失败/未配置时回退本地存储"
```

---

### Task 3: 配置文件模板与忽略规则

**Files:**
- Create: `cos-config.example.json`
- Modify: `.gitignore`

- [ ] **Step 1: 创建 `cos-config.example.json`**

```json
{
  "bucket": "listen-together-1250000000",
  "region": "ap-guangzhou",
  "secretId": "AKIDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "secretKey": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "cdnBaseUrl": ""
}
```

- [ ] **Step 2: 修改 `.gitignore`，追加一行**

```gitignore
cos-config.json
```

- [ ] **Step 3: 复制为真实配置并填写**

```bash
cp cos-config.example.json cos-config.json
# 用文本编辑器填入 Task 0 创建的 Bucket / SecretId / SecretKey
```

- [ ] **Step 4: 提交**

```bash
git add cos-config.example.json .gitignore
git commit -m "chore: COS 配置模板与忽略规则"
```

---

### Task 4: 存量文件迁移脚本（可选）

**Files:**
- Create: `scripts/migrate-uploads-cos.js`

- [ ] **Step 1: 创建脚本**

```js
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
```

- [ ] **Step 2: 提交**

```bash
git add scripts/migrate-uploads-cos.js
git commit -m "feat: 存量上传文件迁移到 COS 的脚本"
```

---

### Task 5: 部署到手机并真实验证

**Files:**
- Modify（手机上）: `~/listen-together/` 下的 `server.js`、`cos.js`、`cos-config.json`
- Modify（手机上）: `~/listen-together/package.json`（新增依赖）

- [ ] **Step 1: 电脑上安装 SDK 并验证**

```bash
npm install cos-nodejs-sdk-v5
```

- [ ] **Step 2: 传文件到手机并装依赖**

先按手机上的 SSH 服务填写连接参数；`PHONE_SSH_TARGET` 的格式为
`用户名@手机地址`，可在 Termux 中用 `whoami` 查看用户名，并在网络设置中查看手机地址。

```bash
: "${PHONE_SSH_TARGET:?请设置为手机 SSH 的用户名@地址}"
PHONE_SSH_PORT="${PHONE_SSH_PORT:-8022}"
scp -P "$PHONE_SSH_PORT" cos.js cos-config.json server.js package.json package-lock.json "$PHONE_SSH_TARGET:~/listen-together/"
ssh -p "$PHONE_SSH_PORT" "$PHONE_SSH_TARGET" 'cd ~/listen-together && npm install'
```

- [ ] **Step 3: 重启服务并验证上传走 COS**

```bash
ssh -p "$PHONE_SSH_PORT" "$PHONE_SSH_TARGET" 'sv restart listen-together'
```
用测试脚本上传一个小文件，断言返回的 `track.url` 是 `https://...myqcloud.com/...` 开头；
再用 curl 直接拉取该 URL，比对文件字节一致。

- [ ] **Step 4: 验证手机出口带宽被释放**

重复容量测试：并发 8 路下载同一首上传的歌，观察手机 WiFi 吞吐（应远低于 15Mbps，流量走 COS）。

- [ ] **Step 5: 提交**

```bash
git add package.json package-lock.json
git commit -m "build: 引入 cos-nodejs-sdk-v5"
```

---

## 成本与容量预期

- COS 标准存储约 0.099 元/GB/月；国内流量约 0.5 元/GB（绑定 CDN 后约 0.2-0.3 元/GB）
- 一首 7.5MB 的歌被 100 人听 = 0.75GB ≈ 0.2~0.4 元/次活动；小圈子月成本通常在几元以内
- 生命周期规则 30 天自动删除，防止长期膨胀
- 容量：同房间并发听歌从 ~20 提升到 **100+（连接上限）**；不同房间互不抢带宽

## 风险与降级

- COS 密钥泄露风险：密钥仅存手机 `cos-config.json`（权限已限 Put/Delete）；泄露可删对象，影响面 = 已上传歌曲。后续可换 STS 临时密钥
- COS 故障时：上传报 500，用户可重试；播放已有歌曲仍可播（URL 已指向 COS，若 COS 故障则播放失败——可接受的小概率事件）
- 公有读桶的对象 URL 可被分享传播：与当前行为一致，不新增暴露面

## Self-Review 记录

- 规格覆盖：上传转存（T2）、配置（T3）、迁移（T4）、部署验证（T5）、COS 模块（T1）——全部有任务
- 无占位符：所有代码步骤均为完整代码
- 类型一致性：`cos.uploadFile(localPath, key, contentType)` 在 T1 定义、T2/T4 调用，签名一致；`_setConfigFile/_setClientForTest` 仅测试用，命名一致

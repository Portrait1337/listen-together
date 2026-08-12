const { test } = require('node:test');
const assert = require('node:assert');

test('小偏差不触发自动校正', () => {
  const SyncPolicy = require('../public/sync-policy.js');
  assert.equal(SyncPolicy.shouldAutoSeek(100000, 105000, 0, 10000), false);
});

test('大偏差但冷却时间未到不触发', () => {
  const SyncPolicy = require('../public/sync-policy.js');
  assert.equal(SyncPolicy.shouldAutoSeek(100000, 120000, 5000, 10000), false);
});

test('大偏差且冷却时间已过才触发', () => {
  const SyncPolicy = require('../public/sync-policy.js');
  assert.equal(SyncPolicy.shouldAutoSeek(100000, 120000, 0, 10000), true);
});

test('iOS 落后纠偏：落后不足 4 秒不触发', () => {
  const SyncPolicy = require('../public/sync-policy.js');
  assert.equal(SyncPolicy.shouldDriftSeek(2000, 12000, 0), false);
});

test('iOS 落后纠偏：冷却未到不触发', () => {
  const SyncPolicy = require('../public/sync-policy.js');
  assert.equal(SyncPolicy.shouldDriftSeek(5000, 5000, 0), false);
});

test('iOS 落后纠偏：冷却已过且未超上限才触发', () => {
  const SyncPolicy = require('../public/sync-policy.js');
  assert.equal(SyncPolicy.shouldDriftSeek(5000, 12000, 0), true);
  assert.equal(SyncPolicy.shouldDriftSeek(5000, 12000, 1), true);
});

test('iOS 落后纠偏：本首歌纠偏次数达到上限后不再触发', () => {
  const SyncPolicy = require('../public/sync-policy.js');
  assert.equal(SyncPolicy.shouldDriftSeek(5000, 12000, 2), false);
});

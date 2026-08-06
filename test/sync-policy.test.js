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

// 同步校正策略：Safari 在播放中反复修改 currentTime 会造成声音断断续续，
// 所以自动纠偏必须“很少触发”，只在偏差很大且距离上次跳转足够久时才做。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SyncPolicy = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DRIFT_SEEK_THRESHOLD_MS = 8000;
  const DRIFT_SEEK_COOLDOWN_MS = 10000;

  function shouldAutoSeek(currentMs, targetMs, lastSeekAt, now) {
    if (!Number.isFinite(currentMs) || !Number.isFinite(targetMs)) return false;
    const diff = Math.abs(currentMs - targetMs);
    return diff > DRIFT_SEEK_THRESHOLD_MS && now - lastSeekAt >= DRIFT_SEEK_COOLDOWN_MS;
  }

  return { shouldAutoSeek };
});

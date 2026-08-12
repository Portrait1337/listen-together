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
  // iOS FLAC 固定落后纠偏：播放头在走但比房间落后超过该值、距上次跳转够久、
  // 且本首歌纠偏次数未达上限才动作。阈值/冷却都偏保守：每次纠偏都会重新缓冲，
  // 触发太频繁会把"持续但稍慢"变成"反复卡顿"。
  const IOS_DRIFT_BEHIND_MS = 4000;
  const IOS_DRIFT_COOLDOWN_MS = 12000;
  const IOS_DRIFT_MAX_CORRECTIONS = 2;

  function shouldAutoSeek(currentMs, targetMs, lastSeekAt, now) {
    if (!Number.isFinite(currentMs) || !Number.isFinite(targetMs)) return false;
    const diff = Math.abs(currentMs - targetMs);
    return diff > DRIFT_SEEK_THRESHOLD_MS && now - lastSeekAt >= DRIFT_SEEK_COOLDOWN_MS;
  }

  function shouldDriftSeek(behindMs, sinceSeekMs, corrections) {
    if (!Number.isFinite(behindMs) || behindMs <= 0) return false;
    return (
      behindMs > IOS_DRIFT_BEHIND_MS &&
      sinceSeekMs >= IOS_DRIFT_COOLDOWN_MS &&
      corrections < IOS_DRIFT_MAX_CORRECTIONS
    );
  }

  return { shouldAutoSeek, shouldDriftSeek };
});

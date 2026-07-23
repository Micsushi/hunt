export function startOperationHeartbeat({
  heartbeat,
  intervalMs = 2_000,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  if (typeof heartbeat !== "function") {
    throw new TypeError("heartbeat must be a function");
  }
  const boundedIntervalMs = Math.max(250, Number(intervalMs || 2_000));
  let stopped = false;
  const timer = setIntervalFn(() => {
    if (!stopped) {
      heartbeat();
    }
  }, boundedIntervalMs);
  return {
    stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      clearIntervalFn(timer);
    },
  };
}

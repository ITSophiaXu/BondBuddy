/** Keep only one renewal in flight while a delivery transaction holds its locks. */
export function startRunLeaseHeartbeat(options: {
  renew: () => Promise<unknown>;
  intervalMs: number;
  onLost: () => void;
}) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    return inFlight ?? Promise.resolve();
  };
  const schedule = () => {
    if (!stopped)
      timer = setTimeout(() => {
        inFlight = tick();
        void inFlight.finally(() => {
          inFlight = undefined;
        });
      }, options.intervalMs);
  };
  const tick = async () => {
    if (stopped) return;
    try {
      await options.renew();
    } catch {
      if (!stopped) {
        stop();
        options.onLost();
      }
      return;
    }
    schedule();
  };
  schedule();
  return { stop };
}

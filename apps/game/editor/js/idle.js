// Work that waits for a quiet moment: the editor's checks, draft saves and
// reports run once after a burst of edits, when the browser has time,
// instead of after every single change.

/**
 * A task: `soon()` asks for `fn` to run `delay` ms after the last request,
 * when the browser is idle (requestIdleCallback, at the latest `maxWait` ms
 * later; without it straight after the delay). `flush()` runs a requested
 * task now, `cancel()` drops the request. `env` supplies the timers (tests).
 */
export function idleTask(fn, { delay = 0, maxWait = 1000, env = globalThis } = {}) {
  let timer = null;
  let idle = null;
  const clear = () => {
    if (timer !== null) env.clearTimeout(timer);
    if (idle !== null) env.cancelIdleCallback?.(idle);
    timer = null;
    idle = null;
  };
  const run = () => {
    clear();
    fn();
  };
  return {
    soon() {
      clear();
      timer = env.setTimeout(() => {
        timer = null;
        if (typeof env.requestIdleCallback === 'function') idle = env.requestIdleCallback(run, { timeout: maxWait });
        else run();
      }, delay);
    },
    flush() {
      if (timer !== null || idle !== null) run();
    },
    cancel: clear,
    get pending() {
      return timer !== null || idle !== null;
    },
  };
}

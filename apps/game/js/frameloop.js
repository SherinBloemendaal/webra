// The game's frame loop (js/main.js runGame): what keeps it going when a
// part of the screen fails.
//
// - createFrameLoop asks for the next animation frame in a `finally`, so a
//   frame that throws never ends the loop: the simulation keeps being
//   stepped and drawn. The error itself still reaches the page (it is not
//   caught here): the browser logs it and error reports (js/telemetry) see it.
//   Only `stopped()` ends the loop (the game left, a start that failed).
// - UiGuard runs the presentation-only callbacks of a frame (the guide, the
//   tour, the sidebar, the command bar, sounds, effects, the HUD). One that
//   throws is logged and reported once per name, and the frame goes on with
//   the next callback. While `strict()` holds (before the first frame is
//   drawn) it throws as before, so js/loadingscreen.js FirstFrameGuard fails
//   the start on the loading screen.
//
// No DOM here: Node tests import it.

/**
 * The frame callback: `run(now)` does the frame, `request(fn)` asks for the
 * next one (requestAnimationFrame) and returns its id for `onRequest(id)`.
 * @param {{ run: (now: number) => void, request: (fn: (now: number) => void) => number,
 *   stopped: () => boolean, onRequest?: (id: number) => void }} o
 */
export function createFrameLoop({ run, request, stopped, onRequest = () => {} }) {
  const frame = (now) => {
    if (stopped()) return;
    try {
      run(now);
    } finally {
      if (!stopped()) onRequest(request(frame));
    }
  };
  return frame;
}

export class UiGuard {
  /**
   * @param {{ report?: (err: unknown, name: string) => void, log?: (message: string, err: unknown) => void,
   *   strict?: () => boolean }} [o]
   *   `report`: error reports (js/telemetry reportError); `log`: the console;
   *   `strict`: while true, a throw goes on to the caller
   */
  constructor({ report = () => {}, log = (message, err) => console.error(message, err), strict = () => false } = {}) {
    this.report = report;
    this.log = log;
    this.strict = strict;
    /** Names of the callbacks that failed (each is said once). */
    this.failed = new Set();
  }

  /** Run `fn` as the part `name` of the frame; returns its result, or undefined when it threw. */
  run(name, fn) {
    try {
      return fn();
    } catch (err) {
      if (this.strict()) throw err;
      if (!this.failed.has(name)) {
        this.failed.add(name);
        this.log(`The ${name} part of the game screen failed; the game goes on without it:`, err);
        try {
          this.report(err, name);
        } catch {
          // A report that fails must not stop the frame either.
        }
      }
      return undefined;
    }
  }
}

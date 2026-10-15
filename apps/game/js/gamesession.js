// The game on screen and how another one takes its place without a page
// reload (js/main.js): Restart (skirmish, a mission, a loaded save, the
// map editor's test play) and the next mission of the campaign.
//
// The order matters:
//   1. the loading screen shows at once (js/loadingscreen.js);
//   2. the game is left: its loop stops (no more frames or ticks) and input
//      is suspended, then its replay goes to the account as a game the player
//      left (js/account/replays.js GameReplay.leaving), encoded by the
//      simulation, which is still there but stands still, and a performance
//      capture ends;
//   3. it is taken down: simulation worker, GPU resources, sound, input,
//      listeners, timers and its parts of the screen (js/disposer.js);
//   4. the next game starts with the same settings.
// When taking the game down fails part way, the page is in an unknown state:
// it reloads with the js/restart.js record instead, which starts the same
// game after the reload, as every restart did before.
//
// GameStart (below) is the start of each game on screen, a restart's too:
// the game stands at tick 0 until its loading screen is gone.

/**
 * @typedef {object} RunningGame
 * @property {() => Promise<void>} leaving the game is left: its replay is queued for the account and a capture ends (a moment at most)
 * @property {() => void} teardown take everything of the game down; throws when a part could not be taken down
 */

export class GameSession {
  /**
   * @param {{
   *   loading: { begin(plan: object): void, fail(message: string, o?: { label?: string, run?: () => void }): void },
   *   reload?: () => void,
   *   saveRecord?: (record: object) => boolean,
   * }} o `reload` reloads the page (back to the menu, or into the stored
   *   record); `saveRecord` stores a js/restart.js record for the next boot
   */
  constructor({ loading, reload = () => globalThis.location.reload(), saveRecord = () => false }) {
    this.loading = loading;
    this.reload = reload;
    this.saveRecord = saveRecord;
    /** The game on screen (RunningGame), or null. */
    this.current = null;
    /** A game is being replaced now: further restarts wait for it. */
    this.busy = false;
  }

  /** A game started: it is the one on screen now. */
  attach(game) {
    this.current = game;
  }

  /** The game ended without a restart (the page goes): it is no longer on screen. */
  detach(game) {
    if (this.current === game) this.current = null;
  }

  /**
   * Replace the game on screen with the one `relaunch()` starts (it shows
   * its own errors). `plan` is the loading screen's (js/loadingscreen.js
   * loadingPlan); `record` the js/restart.js record that starts the same
   * game after a reload, the fallback. Resolves to whether the game was
   * replaced in place (false: nothing to replace, a replacement already
   * running, or the page reloads).
   */
  async replace({ plan, relaunch, record = null }) {
    const game = this.current;
    if (this.busy || !game) return false;
    this.busy = true;
    try {
      this.loading.begin(plan);
      try {
        await game.leaving();
      } catch (err) {
        // The replay or the capture is lost; the restart goes on.
        console.warn('Leaving the game did not finish:', err);
      }
      this.current = null;
      try {
        game.teardown();
      } catch (err) {
        console.warn('The game could not be taken down in place; reloading:', err);
        this.fallback(record);
        return false;
      }
      try {
        await relaunch();
      } catch (err) {
        this.loading.fail(`Could not start the game: ${err?.message ?? err}`, { label: 'Back to the menu', run: () => this.reload() });
      }
      return true;
    } finally {
      this.busy = false;
    }
  }

  /** The page reloads into `record` (when it could be stored), else back to the menu after saying so. */
  fallback(record) {
    if (record && this.saveRecord(record)) {
      this.reload();
      return;
    }
    this.loading.fail('Could not restart the game here. Start it again from the menu.', { label: 'Back to the menu', run: () => this.reload() });
  }
}

/** The longest frame time a game advances by in one animation frame (a hitch or a hidden tab drops the rest). */
export const MAX_FRAME_MS = 250;

/**
 * The start of one game on screen (js/main.js runGame). Its frame loop runs
 * from the end of the setup on, so the first frame is drawn behind the
 * loading screen and closes it (js/loadingscreen.js FirstFrameGuard), but
 * the game stands at tick 0 until the screen is gone: the simulation is held
 * (js/sim/core.js `held`), every frame advances it by nothing, and the
 * input and the background timer of a hidden tab wait. `begin`, on the
 * screen's `closed`, starts it: the frame clock counts from that moment, so
 * the time the screen took is never caught up in a burst of ticks.
 */
export class GameStart {
  /**
   * @param {{ host: { command(name: string, args?: any[]): Promise<any> }, now: number,
   *   onStart?: () => void, maxFrameMs?: number }} o
   *   `now`: the frame clock's start (performance.now()); `onStart`: runs once
   *   the game started (sounds, the online `loaded` message, the background timer)
   */
  constructor({ host, now, onStart = () => {}, maxFrameMs = MAX_FRAME_MS }) {
    this.host = host;
    this.onStart = onStart;
    this.maxFrameMs = maxFrameMs;
    this.last = now;
    /** The game runs (the loading screen is gone). */
    this.started = false;
    /** The game was left or taken down before it started: it never does. */
    this.stopped = false;
  }

  /**
   * One animation frame at `now`: `raw`, the time since the last frame
   * (performance capture), and `dt`, what the game advances by (0 until it
   * started, at most `maxFrameMs`).
   */
  frame(now) {
    const raw = now - this.last;
    this.last = now;
    return { raw, dt: this.started ? Math.min(Math.max(0, raw), this.maxFrameMs) : 0 };
  }

  /** The loading screen is gone at `now`: the game starts (once; never after `stop`). Returns whether it did. */
  begin(now) {
    if (this.started || this.stopped) return false;
    this.started = true;
    this.last = now;
    this.host.command('begin').catch(() => {});
    this.onStart();
    return true;
  }

  /** The game is left before it started (a restart, the page going). */
  stop() {
    this.stopped = true;
  }
}

// The game on screen and how another one takes its place without a page
// reload (js/main.js): Restart (skirmish, a mission, a loaded save, the
// map editor's test play) and the next mission of the campaign.
//
// The order matters:
//   1. the loading screen shows at once (js/loadingscreen.js);
//   2. the game is left: its replay goes to the account as a game the player
//      left (js/account/replays.js GameReplay.leaving) while its simulation
//      still runs, and a performance capture ends;
//   3. it is taken down: simulation worker, GPU resources, sound, input,
//      listeners, timers and its parts of the screen (js/disposer.js);
//   4. the next game starts with the same settings.
// When taking the game down fails part way, the page is in an unknown state:
// it reloads with the js/restart.js record instead, which starts the same
// game after the reload, as every restart did before.

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

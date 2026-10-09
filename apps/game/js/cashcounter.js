// The sidebar's credits counter, ticking toward the real value like OpenRA's
// IngameCashCounterLogic (Widgets/Logic/Ingame/IngameCashCounterLogic.cs):
// every UI tick (40 ms) the shown value moves 7% of the gap, at least 37
// credits, and the cash tick sounds play (PlayerResources
// CashTickUpNotification on every tick counting up, CashTickDownNotification
// on every other tick counting down).

/** OpenRA Ui.Timestep: milliseconds per UI tick. */
export const CASH_TICK_MS = 40;
/** OpenRA DisplayFracPerFrame: share of the gap closed per tick. */
export const DISPLAY_FRAC_PER_TICK = 0.07;
/** OpenRA DisplayDeltaPerFrame: credits moved per tick at least. */
export const DISPLAY_DELTA_PER_TICK = 37;
/**
 * OpenRA nextCashTickTime = 2 after a "down" sound: counted down at the start
 * of every tick, so the next one plays two ticks later.
 */
export const CASH_DOWN_QUIET_TICKS = 2;
/** OpenRA Game.TimestepJankThreshold: a longer pause (hidden tab) is not caught up. */
export const CATCH_UP_MS = 250;

export class CashCounter {
  /** @param {number} value the real value, shown at once */
  constructor(value = 0) {
    this.shown = value;
    this.target = value;
    this.downQuiet = 0;
  }

  get settled() {
    return this.shown === this.target;
  }

  /** One UI tick: move the shown value; returns the sound to play, 'up', 'down' or null. */
  tick() {
    if (this.downQuiet > 0) this.downQuiet--;
    const diff = Math.abs(this.target - this.shown);
    const move = Math.min(Math.max(Math.floor(diff * DISPLAY_FRAC_PER_TICK), DISPLAY_DELTA_PER_TICK), diff);
    if (this.shown < this.target) {
      this.shown += move;
      return 'up';
    }
    if (this.shown > this.target) {
      this.shown -= move;
      if (this.downQuiet === 0) {
        this.downQuiet = CASH_DOWN_QUIET_TICKS;
        return 'down';
      }
    }
    return null;
  }

  /**
   * Run the ticks due in `elapsed` milliseconds (at most CATCH_UP_MS worth).
   * @returns {{ ticks: number, up: boolean, down: boolean, rest: number }}
   *   whether a tick sound came up in them, and the milliseconds left over
   */
  advance(elapsed) {
    const due = Math.min(elapsed, CATCH_UP_MS);
    const ticks = Math.floor(due / CASH_TICK_MS);
    let up = false;
    let down = false;
    for (let i = 0; i < ticks; i++) {
      const sound = this.tick();
      if (sound === 'up') up = true;
      else if (sound === 'down') down = true;
    }
    return { ticks, up, down, rest: elapsed > CATCH_UP_MS ? 0 : due - ticks * CASH_TICK_MS };
  }
}

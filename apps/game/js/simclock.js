// The clock of what the battlefield shows: milliseconds of simulated game
// time, read from the newest frame's tick and its interpolation (alpha). It
// stands still whenever the simulation does (the single player pause, the
// game menu and a hidden tab of a local game, the end of game dialogs, a
// paused replay) and runs at the game's speed, like OpenRA's effects that
// tick with the world: RadarPings, FloatingText, ScreenShaker, the weather
// particles (WeatherOverlay skips them while world.Paused) and lightning.
// Interface animations (cursors, menus, the radar's opening, text lines,
// target lines) keep the page clock, as OpenRA's widgets tick while paused.
//
// Presentation only: nothing here reaches the simulation or its state hash.

export class SimClock {
  /** @param {number} tickMs milliseconds per simulation tick at the game's speed */
  constructor(tickMs) {
    this.tickMs = tickMs;
    /** Simulated milliseconds now. */
    this.ms = 0;
    /** The tick of the last update, or null before the first. */
    this.tick = null;
  }

  /**
   * Follow a frame: `tick` the simulation's tick, `alpha` how far (0..1) the
   * frame is drawn toward the next one. The clock never runs backwards while
   * the tick does not (alpha restarts below 1 when a paused game goes on);
   * a tick before the last one (a replay seeking back) sets it back.
   * @returns {number} milliseconds
   */
  update(tick, alpha = 0) {
    const a = Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 0;
    const ms = (tick + a) * this.tickMs;
    this.ms = this.tick !== null && tick < this.tick ? ms : Math.max(this.ms, ms);
    this.tick = tick;
    return this.ms;
  }

  /** Simulated seconds now. */
  get seconds() {
    return this.ms / 1000;
  }
}

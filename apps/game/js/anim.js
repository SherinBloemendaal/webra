// Render clock for sprite animations (building layers, art/animated.js).
//
// The clock is wall time that only runs while the game runs: it stops while
// the game is paused and stands still at frame 0 when the player prefers
// reduced motion. It never touches the simulation, so lockstep games stay
// deterministic. The GPU picks the frame per instance (shaders/sprite.wgsl);
// animFrame below is the same formula for tests and tools.

/** The clock wraps after this many seconds so f32 keeps millisecond precision on the GPU. */
export const ANIM_WRAP = 3600;

/**
 * Frame of an animation with `count` frames at `fps` frames per second at
 * clock `time` (seconds) for an instance with `phase` in [0, 1); frame 0
 * while animation is off. Mirrors anim_frame in shaders/sprite.wgsl.
 */
export function animFrame(time, enabled, fps, count, phase = 0) {
  if (!enabled || count <= 1) return 0;
  const step = Math.floor(Math.max(time, 0) * fps + phase * count);
  return ((step % count) + count) % count;
}

export class AnimClock {
  /** @param {{reducedMotion?: boolean}} [opts] */
  constructor({ reducedMotion = false } = {}) {
    this.time = 0;
    this.reducedMotion = reducedMotion;
  }

  /** Animations run unless the player prefers reduced motion. */
  get enabled() {
    return !this.reducedMotion;
  }

  /** Advance by dtMs of wall time unless paused (or animation is off). */
  advance(dtMs, paused) {
    if (paused || !this.enabled || !(dtMs > 0)) return this.time;
    this.time = (this.time + dtMs / 1000) % ANIM_WRAP;
    return this.time;
  }

  /** What the renderer uploads: { time, enabled }. */
  uniform() {
    return { time: this.enabled ? this.time : 0, enabled: this.enabled };
  }

  /**
   * Follow the browser's prefers-reduced-motion setting, also when it changes
   * mid game. Returns a function that stops listening.
   */
  watchReducedMotion(win = globalThis.window) {
    let query = null;
    try {
      query = win?.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null;
    } catch {
      query = null;
    }
    if (!query) return () => {};
    this.reducedMotion = !!query.matches;
    const onChange = (e) => {
      this.reducedMotion = !!e.matches;
    };
    query.addEventListener?.('change', onChange);
    return () => query.removeEventListener?.('change', onChange);
  }
}

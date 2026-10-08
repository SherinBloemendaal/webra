// Touch gesture recognizer. Turns raw pointer sequences (one or two fingers)
// into taps, double taps, long presses, one-finger drags and a combined
// two-finger pan and pinch. No DOM and no clock of its own: js/touch.js feeds
// it Pointer Events, and apps/game/tests/touch.test.mjs feeds it synthetic
// sequences with a fake timer.
//
// Events (handler names, all optional):
//   tap({ x, y })                        short press without moving
//   doubleTap({ x, y })                  a second tap close in time and place (instead of tap)
//   longPress({ x, y })                  held still for longPressMs
//   longPressEnd({ x, y })               the finger of a long press lifted
//   dragStart({ x, y })                  one finger moved past tapSlop (x, y: where it went down)
//   dragMove({ x, y, sx, sy })           while dragging (sx, sy: start)
//   dragEnd({ x, y, sx, sy })            drag finished
//   dragCancel()                         a second finger turned the drag into a pinch
//   pinchStart({ x, y })                 second finger down (x, y: centre of the two)
//   pinch({ x, y, dx, dy, scale })       centre moved by (dx, dy), distance changed by `scale`
//   pinchEnd()                           one of the two fingers lifted
//
// After a pinch, the remaining finger does nothing until every finger is up,
// so lifting fingers one at a time never fires a stray tap or drag.

export const GESTURE_DEFAULTS = Object.freeze({
  tapSlop: 10, // CSS px a finger may wander and still count as a tap
  doubleTapMs: 300, // second tap within this time...
  doubleTapSlop: 32, // ...and this distance is a double tap
  longPressMs: 500,
});

const dist = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);

export class GestureRecognizer {
  /**
   * @param {object} handlers see the event list above
   * @param {object} [options] GESTURE_DEFAULTS overrides, plus setTimer(fn, ms) / clearTimer(id)
   */
  constructor(handlers = {}, options = {}) {
    this.handlers = handlers;
    this.options = { ...GESTURE_DEFAULTS, ...options };
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((id) => clearTimeout(id));
    this.pointers = new Map(); // id -> { x, y, sx, sy }
    // idle: no finger. press: one finger, still a tap candidate. drag: one
    // finger moving. long: long press fired. multi: two fingers. done: a
    // pinch ended, waiting for the last finger to lift.
    this.mode = 'idle';
    this.timer = null;
    this.lastTap = null; // { x, y, t } of the previous tap, for double taps
    this.pair = null; // { cx, cy, d } of the two fingers at the previous event
  }

  /** True while any finger is down. */
  get active() {
    return this.pointers.size > 0;
  }

  emit(name, arg) {
    this.handlers[name]?.(arg);
  }

  stopTimer() {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  measure() {
    const [a, b] = [...this.pointers.values()];
    return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, d: dist(a.x, a.y, b.x, b.y) };
  }

  /** A finger went down. Returns false when it is ignored (a third finger). */
  down({ id, x, y }) {
    if (this.pointers.has(id)) return true;
    if (this.pointers.size >= 2 || this.mode === 'done') return false;
    this.pointers.set(id, { x, y, sx: x, sy: y });
    if (this.pointers.size === 1) {
      this.mode = 'press';
      this.stopTimer();
      this.timer = this.setTimer(() => this.fireLongPress(), this.options.longPressMs);
      return true;
    }
    // Second finger: whatever the first one was doing becomes a pinch.
    this.stopTimer();
    if (this.mode === 'drag') this.emit('dragCancel');
    if (this.mode === 'long') {
      const [first] = this.pointers.values();
      this.emit('longPressEnd', { x: first.x, y: first.y });
    }
    this.mode = 'multi';
    this.lastTap = null;
    this.pair = this.measure();
    this.emit('pinchStart', { x: this.pair.cx, y: this.pair.cy });
    return true;
  }

  move({ id, x, y }) {
    const p = this.pointers.get(id);
    if (!p) return;
    p.x = x;
    p.y = y;
    if (this.mode === 'press') {
      if (dist(p.sx, p.sy, x, y) <= this.options.tapSlop) return;
      this.stopTimer();
      this.mode = 'drag';
      this.emit('dragStart', { x: p.sx, y: p.sy });
      this.emit('dragMove', { x, y, sx: p.sx, sy: p.sy });
    } else if (this.mode === 'drag') {
      this.emit('dragMove', { x, y, sx: p.sx, sy: p.sy });
    } else if (this.mode === 'multi' && this.pointers.size === 2) {
      const now = this.measure();
      const prev = this.pair;
      this.pair = now;
      const scale = prev.d > 0 && now.d > 0 ? now.d / prev.d : 1;
      this.emit('pinch', { x: now.cx, y: now.cy, dx: now.cx - prev.cx, dy: now.cy - prev.cy, scale });
    }
  }

  /** A finger lifted. `t` (ms, any monotonic clock) times double taps. */
  up({ id, x, y, t }) {
    const p = this.pointers.get(id);
    if (!p) return;
    if (x !== undefined) p.x = x;
    if (y !== undefined) p.y = y;
    this.pointers.delete(id);
    switch (this.mode) {
      case 'press': {
        this.stopTimer();
        this.mode = 'idle';
        const prev = this.lastTap;
        if (prev && t - prev.t <= this.options.doubleTapMs && dist(prev.x, prev.y, p.sx, p.sy) <= this.options.doubleTapSlop) {
          this.lastTap = null;
          this.emit('doubleTap', { x: p.sx, y: p.sy });
        } else {
          this.lastTap = { x: p.sx, y: p.sy, t };
          this.emit('tap', { x: p.sx, y: p.sy });
        }
        break;
      }
      case 'drag':
        this.mode = 'idle';
        this.lastTap = null;
        this.emit('dragEnd', { x: p.x, y: p.y, sx: p.sx, sy: p.sy });
        break;
      case 'long':
        this.mode = 'idle';
        this.emit('longPressEnd', { x: p.x, y: p.y });
        break;
      case 'multi':
        this.mode = this.pointers.size ? 'done' : 'idle';
        this.pair = null;
        this.emit('pinchEnd');
        break;
      default:
        if (!this.pointers.size) this.mode = 'idle';
    }
  }

  /** The browser took the pointer away (pointercancel): nothing fires for it. */
  cancel({ id }) {
    if (!this.pointers.has(id)) return;
    this.pointers.delete(id);
    this.stopTimer();
    this.lastTap = null;
    if (this.mode === 'drag') this.emit('dragCancel');
    else if (this.mode === 'multi') {
      this.pair = null;
      this.emit('pinchEnd');
    } else if (this.mode === 'long') this.emit('longPressEnd', { x: Number.NaN, y: Number.NaN });
    this.mode = this.pointers.size ? 'done' : 'idle';
  }

  /** Drop every finger without firing anything (game menu opened). */
  reset() {
    this.stopTimer();
    this.pointers.clear();
    this.mode = 'idle';
    this.lastTap = null;
    this.pair = null;
  }

  fireLongPress() {
    this.timer = null;
    if (this.mode !== 'press') return;
    const [p] = this.pointers.values();
    this.mode = 'long';
    this.lastTap = null;
    this.emit('longPress', { x: p.x, y: p.y });
  }
}

/**
 * Camera after a two-finger gesture step: pan by the centre's movement, then
 * zoom by `scale` around the centre (x, y in view px), so the world point
 * under the fingers stays under them. Returns a new { x, y, zoom }.
 */
export function pinchCamera(camera, { x, y, dx, dy, scale }, minZoom, maxZoom) {
  const zoom = Math.min(maxZoom, Math.max(minZoom, camera.zoom * scale));
  // World point under the previous centre (x - dx, y - dy) before the step...
  const wx = camera.x + (x - dx) / camera.zoom;
  const wy = camera.y + (y - dy) / camera.zoom;
  // ...ends up under the new centre (x, y) at the new zoom.
  return { x: wx - x / zoom, y: wy - y / zoom, zoom };
}

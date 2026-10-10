// Target lines, like OpenRA's DrawLineToTarget: when the player orders units
// (or selects them), each selected unit shows a line to what it was told to
// do for a moment (DrawLineToTargetInfo.Delay, 2.4 seconds), and all
// selected units show theirs while Shift is held (waypoint mode). The engine
// draws the lines and markers in OpenRA's colours (engine/src/target_lines.rs,
// Game.build_lines); this module only decides which units show them. The
// setting is OpenRA's TargetLines: 'automatic' (after orders and selections,
// and with Shift), 'manual' (only with Shift) or 'disabled'.
// Presentation only: nothing here reaches the simulation.

/** OpenRA DrawLineToTargetInfo.Delay: how long the lines stay after an order or a selection. */
export const TARGET_LINE_DELAY_MS = 2400;

/** The setting values (js/registry.js game.targetLines, OpenRA TargetLinesType). */
export const TARGET_LINE_MODES = Object.freeze(['disabled', 'manual', 'automatic']);

/** Game methods of unit orders: (player, ids, ...); the units then show their lines (OpenRA ShowTargetLines in ResolveOrder). */
export const LINE_ORDERS = Object.freeze([
  'order_smart',
  'order_move',
  'order_attack',
  'order_attack_ground',
  'order_guard',
  'order_waypoint',
  'order_land',
  'order_return_to_base',
  'order_lay_mines',
]);

export class TargetLines {
  /**
   * @param {{ mode?: () => string, now?: () => number }} [o] `mode`: the
   *   setting's value; `now`: milliseconds (the page clock, like OpenRA's RunTime)
   */
  constructor({ mode = () => 'automatic', now = () => performance.now() } = {}) {
    this.mode = mode;
    this.now = now;
    /** Actor id -> time its lines go away. */
    this.until = new Map();
    this.selection = new Set();
  }

  /** Reset the timeout of these units' lines (OpenRA ShowTargetLines: only with 'automatic'). */
  show(ids) {
    if (this.mode() !== 'automatic') return;
    const until = this.now() + TARGET_LINE_DELAY_MS;
    for (const id of ids) this.until.set(id, until);
  }

  /** The local player ordered these units. */
  ordered(ids) {
    this.show(ids ?? []);
  }

  /** The selection changed: newly selected units show their lines (OpenRA INotifySelected). */
  selected(ids) {
    const next = new Set(ids);
    this.show([...next].filter((id) => !this.selection.has(id)));
    this.selection = next;
  }

  /**
   * The units whose lines show now: every selected unit while Shift is held
   * (unless the lines are off), else the selected units whose time has not
   * run out. The engine still draws only allied, selected units.
   * @param {Iterable<number>} selection
   * @param {{ shift?: boolean }} [o]
   * @returns {number[]}
   */
  visible(selection, { shift = false } = {}) {
    const mode = this.mode();
    if (mode === 'disabled') return [];
    const t = this.now();
    for (const [id, until] of this.until) if (until < t) this.until.delete(id);
    const ids = [...selection];
    if (shift) return ids;
    return mode === 'automatic' ? ids.filter((id) => this.until.has(id)) : [];
  }
}

/**
 * `game` with the unit orders of LINE_ORDERS also showing the ordered units'
 * target lines (`onOrder(ids)`), for the input and the command bar.
 */
export function withTargetLines(game, onOrder) {
  const orders = new Set(LINE_ORDERS);
  return new Proxy(game, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target);
      if (!orders.has(prop) || typeof v !== 'function') return typeof v === 'function' ? v.bind(target) : v;
      return (...args) => {
        const r = v.apply(target, args);
        onOrder(Array.from(args[1] ?? []));
        return r;
      };
    },
  });
}

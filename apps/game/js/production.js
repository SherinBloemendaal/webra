// Production queue logic of the sidebar (no DOM, so it is unit tested in
// apps/game/tests/production.test.mjs). The engine decides what is built
// (engine/src/production.rs); this only turns player_json() into card state
// and clicks into orders.

/** Buildings and Defense hold structures, which are placed on the map when finished. */
export const isStructureQueue = (q) => q === 0 || q === 1;

/** Items a shift click (or Shift + numpad) queues. */
export const SHIFT_COUNT = 5;

/**
 * Per actor id: how many are queued and the state of the first one (its
 * progress, and whether it is finished and waiting for placement). Per queue:
 * the number of items and whether one is ready.
 *
 * @param {Array<Array<{id: string, progress: number, done: boolean}>>} queues player_json().queues
 */
export function summarizeQueues(queues) {
  const perId = new Map();
  const activity = queues.map((items) => items.length);
  const ready = queues.map((items) => items.some((it) => it.done));
  for (const items of queues) {
    for (const it of items) {
      const s = perId.get(it.id);
      if (s) s.count += 1;
      else perId.set(it.id, { count: 1, progress: it.progress, done: it.done });
    }
  }
  return { perId, activity, ready };
}

/**
 * What a left click on a card does: place the finished structure, or queue
 * one more (five with shift). Structures queue like units: the first one is
 * built and waits for placement, the ones behind it start once it is placed.
 *
 * @returns {{place: true} | {place: false, count: number} | null} null when the card is disabled
 */
export function clickAction({ queue, enabled, ready }, shift) {
  if (enabled === false) return null;
  if (isStructureQueue(queue) && ready) return { place: true };
  return { place: false, count: shift ? SHIFT_COUNT : 1 };
}

/**
 * Whether a right click on a card ends placement mode. The engine cancels the
 * last queued item of that type, so the finished structure only goes away
 * when it is the only one queued.
 */
export function cancelEndsPlacement({ queue, ready, queued }) {
  return isStructureQueue(queue) && !!ready && queued <= 1;
}

/**
 * Whether placement mode for `placingId` has nothing left to place: the
 * finished structure was cancelled (its prerequisites or the Construction
 * Yard were lost, or it was cancelled elsewhere).
 */
export function placementLost(perId, placingId) {
  if (!placingId) return false;
  const s = perId.get(placingId);
  return !s || !s.done;
}

/** Game ticks of progress history used to estimate the remaining build time. */
export const ETA_WINDOW_TICKS = 50;

/**
 * Remaining build time of the item at the head of a queue, estimated from how
 * fast its progress actually moves (player_json() has progress, not ticks), so
 * low power slowing production shows up in the clock. While production stalls
 * (no money) the clock stands still, and the rate is measured afresh once it
 * moves again. Measured in game ticks, so pausing the game does not skew it.
 */
export class BuildEta {
  constructor(windowTicks = ETA_WINDOW_TICKS) {
    this.windowTicks = windowTicks;
    this.samples = []; // { tick, progress }, oldest first
    this.last = null; // last estimate in ticks, kept while production stalls
  }

  reset() {
    this.samples = [];
    this.last = null;
  }

  /**
   * Record the progress (0..1) at game tick `tick`.
   * @returns {number | null} estimated ticks left, or null while unknown
   */
  observe(progress, tick) {
    const prev = this.samples[this.samples.length - 1];
    // A new item started (progress went back) or time went back: start over.
    if (prev && (progress < prev.progress - 1e-6 || tick < prev.tick)) this.reset();
    const head = this.samples[this.samples.length - 1];
    if (head && head.tick === tick) {
      head.progress = progress;
    } else if (head && progress <= head.progress) {
      // Stalled: keep the clock, and measure from here once it moves again.
      this.samples = [{ tick, progress }];
      return this.last;
    } else {
      this.samples.push({ tick, progress });
    }
    while (this.samples.length > 2 && tick - this.samples[1].tick >= this.windowTicks) this.samples.shift();
    if (progress >= 1) {
      this.last = 0;
      return 0;
    }
    const first = this.samples[0];
    const dt = tick - first.tick;
    const dp = progress - first.progress;
    // (The epsilon keeps float noise from rounding a whole tick up.)
    if (dt > 0 && dp > 0) this.last = Math.ceil(((1 - progress) * dt) / dp - 1e-6);
    return this.last;
  }
}

/** Clock text like the 1996 sidebar: "mm:ss", or "h:mm:ss" from an hour on. */
export function formatClock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return `${h > 0 ? `${h}:` : ''}${String(m).padStart(2, '0')}:${ss}`;
}

/** Power with a sign for gains ("+100", "-40"). */
export function formatPower(power) {
  return power > 0 ? `+${power}` : String(power);
}

/**
 * The production tooltip of a sidebar cameo (OpenRA ProductionTooltipLogic,
 * mods/common/chrome/tooltips.yaml PRODUCTION_TOOLTIP): the name and its
 * hotkey, what is still missing, cost, build time and power in a column, the
 * description, and how the mouse works on it. Cost turns red when the player
 * cannot afford it, the time red while low power slows production, the power
 * red when building it would overload the grid, like OpenRA.
 * @param {{ name: string, description?: string, cost: number, power?: number, kind?: string, queue: number }} actor rules_json actor
 * @param {{ enabled?: boolean, requires?: string[], exclusive?: string | null, buildTicks?: number } | undefined} item player_json `buildable` entry
 * @param {{ funds?: number, cash?: number, resources?: number, powerGenerated?: number, powerUsed?: number, lowPower?: boolean } | null} state player_json
 * @param {{ hotkey?: string | null, ticksPerSecond?: number, lowPowerModifier?: number }} [o]
 */
export function productionTip(actor, item, state, { hotkey = null, ticksPerSecond = 25, lowPowerModifier = 100 } = {}) {
  const stats = [];
  const funds = state ? (state.funds ?? (state.cash ?? 0) + (state.resources ?? 0)) : Infinity;
  stats.push({ kind: 'cost', label: 'cost', text: `$${actor.cost}`, bad: funds < actor.cost });
  if (item && Number.isFinite(item.buildTicks)) {
    const slow = !!state?.lowPower && lowPowerModifier > 100;
    const ticks = slow ? (item.buildTicks * lowPowerModifier) / 100 : item.buildTicks;
    stats.push({ kind: 'time', label: 'build time', text: formatClock(ticks / ticksPerSecond), bad: slow });
  }
  const power = actor.power ?? 0;
  if (power !== 0) {
    const spare = (state?.powerGenerated ?? 0) - (state?.powerUsed ?? 0);
    stats.push({ kind: 'power', label: 'power', text: formatPower(power), bad: power < 0 && spare < -power });
  }
  let requires = '';
  if (item && item.enabled === false) {
    if (item.exclusive) requires = item.exclusive;
    else if (item.requires?.length) requires = `Requires ${item.requires.join(', ')}`;
    else if (actor.buildLimit > 0) requires = `Only ${actor.buildLimit} at a time`;
    else requires = 'Unavailable';
  }
  const hint = isStructureQueue(actor.queue)
    ? `Left click: build, then place. Shift: queue ${SHIFT_COUNT}. Right click: cancel one.`
    : `Left click: build. Shift: build ${SHIFT_COUNT}. Right click: cancel one.`;
  const notes = [{ text: hint, tone: 'hint' }];
  // Buildable.BuildLimit (Tanya, superweapons): engine/src/infantry.rs at_build_limit.
  if (actor.buildLimit > 0) notes.unshift({ text: `At most ${actor.buildLimit} at a time.`, tone: 'warn' });
  return { title: actor.name, hotkey, requires, stats, desc: actor.description || '', notes };
}

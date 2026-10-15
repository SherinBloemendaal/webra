// The guide's progress and what ticks its steps off (docs/contracts.md, "The
// guide and the tour"). The chapters and their texts are GUIDE in
// js/help.js; the game menu's Guide page is js/guideview.js and the tour
// card of the first skirmish games js/tour.js.
//
// Progress is a declared setting (registry guide.done: { stepId: true }), so
// it follows the account like every other setting; guide.tourInGames is the
// "Tour in my games" switch.
//
// A GuideTracker watches one game for the local player (never spectators or
// replays) and marks steps done:
//
// - engine events (engine/src/sound_events.rs, the buffer js/main.js takes
//   each frame for the sound): an MCV deployed, a structure placed, a unit
//   produced, a building powered down, lightning, a support power ready;
// - the player state polled every 100 ms (Game.player_json): low power, ore
//   delivered (the stored ore goes up), and the sky (a thunderstorm);
// - the orders the local player gives through the UI's game (withGuide, a
//   wrapper like js/targetlines.js withTargetLines): move, attack move,
//   guard, stop, scatter, waypoints, fire stances;
// - signals from the screens: a team chat line sent, an online game started;
// - reading: steps that only explain tick off when their chapter is shown in
//   the guide.
//
// State is preferred over events where it can tell (the notes in
// docs/redesign-uitwerking.md 15): a hidden tab drops engine events. No DOM
// here: Node tests import it.

import { GUIDE } from './help.js';
import { EV, STRIDE } from './audio/director.js';
import { boundKey } from './hotkeys.js';

/** The chapter the tour walks through in the first skirmish games. */
export const TOUR_CHAPTER = 'base';

/** Step id -> { step, chapter, index (in its chapter) }. */
export const STEPS = new Map(GUIDE.flatMap((chapter) => chapter.steps.map((step, index) => [step.id, { step, chapter, index }])));

/** Every step id, in guide order. */
export const STEP_IDS = Object.freeze([...STEPS.keys()]);

/** The tour's steps, in order. */
export const TOUR_STEPS = Object.freeze(GUIDE.find((c) => c.id === TOUR_CHAPTER).steps.map((s) => s.id));

/** The orders that count as "an order given" (units.order). */
const ORDER_METHODS = new Set(['order_smart', 'order_move', 'order_attack', 'order_attack_ground', 'order_waypoint', 'order_guard', 'order_stop', 'order_scatter']);

/**
 * What ticks each step off. `event(kind, type, owner, b)` for engine events
 * of the local player (`type` the actor id), `state(s, memory)` for the
 * player state, `order(method, args)`, `signal` a screen's signal name,
 * `read` for steps that only explain. `memory` is the game's own record:
 * `placed` (actor id -> count placed this game).
 */
export const TRIGGERS = Object.freeze({
  'base.mcv': { event: (kind, type) => kind === EV.TRANSFORMED && type === 'MCV' },
  'base.power': { placed: ['POWR', 'APWR'] },
  'base.refinery': { placed: ['PROC'] },
  // Both in one game: Barracks (either side's) and a War Factory.
  'base.production': { state: (_s, m) => placedAny(m, ['TENT', 'BARR']) && placedAny(m, ['WEAP']) },
  'base.radar': { placed: ['DOME'] },
  'ore.deliver': { state: (_s, m) => m.oreDelivered },
  'ore.truck': { event: (kind, type) => kind === EV.UNIT_PRODUCED && type === 'HARV' },
  'ore.gems': { read: true },
  'ore.silo': { placed: ['SILO'] },
  'power.bar': { read: true },
  'power.low': { state: (s) => s.lowPower === true },
  // A second plant in one game, or an Advanced Power Plant.
  'power.more': { state: (_s, m) => (m.placed.get('POWR') ?? 0) + (m.placed.get('APWR') ?? 0) >= 2 || placedAny(m, ['APWR']) },
  // POWER_TOGGLED: b 1 switched off with the power down button (engine repair.rs).
  'power.down': { event: (kind, _type, _owner, b) => kind === EV.POWER_TOGGLED && b === 1 },
  'units.order': { order: (method) => ORDER_METHODS.has(method) },
  // order_move and order_waypoint: the last argument is attack move (engine lib.rs).
  'units.attackMove': { order: (method, args) => (method === 'order_move' || method === 'order_waypoint') && args[args.length - 1] === true },
  'units.guard': { order: (method) => method === 'order_guard' || method === 'order_stop' || method === 'order_scatter' },
  'units.queue': { order: (method, args) => method === 'order_waypoint' && args[args.length - 1] !== true },
  'units.stance': { order: (method) => method === 'set_stance' },
  // The sky (Game.weather_json) or a strike: a thunderstorm the player was in.
  'weather.storm': { state: (s) => s.weather === 'thunderstorm', anyEvent: (kind) => kind === EV.LIGHTNING_STRIKE },
  'weather.plants': { read: true },
  'weather.rod': { placed: ['LROD'] },
  'weather.other': { read: true },
  'powers.timers': { read: true },
  'powers.ready': { event: (kind) => kind === EV.POWER_READY },
  'powers.spread': { read: true },
  'team.chat': { signal: 'teamChat' },
  'team.online': { signal: 'onlineGame' },
  'team.rejoin': { read: true },
});

function placedAny(memory, ids) {
  return ids.some((id) => (memory.placed.get(id) ?? 0) > 0);
}

/** The "Watching: ..." line of a step, or its done or plain form. */
export function stepStatus(id, { done, active }) {
  const watch = STEPS.get(id)?.step.watch ?? '';
  if (done) return `Done: ${watch}`;
  return active ? `Watching: ${watch}` : watch;
}

/**
 * A guide text with `{key:action}` replaced by the action's current key
 * (js/hotkeys.js boundKey), or "no key" when it has none.
 */
export function guideText(text, hotkeys = null) {
  return String(text).replace(/\{key:(\w+)\}/g, (_m, action) => (hotkeys ? (boundKey(hotkeys, action) ?? 'no key') : action));
}

/**
 * The player's progress: which steps are done and whether the tour runs in
 * their skirmish games. Reads and writes the registry's guide group.
 */
export class GuideProgress {
  /** @param {ReturnType<import('./registry.js').createRegistry>} registry */
  constructor(registry) {
    this.registry = registry;
  }

  /** `{ stepId: true }` of the steps done (a copy). */
  get done() {
    const v = this.registry.get('guide', 'done');
    return v && typeof v === 'object' ? v : {};
  }

  isDone(id) {
    return this.done[id] === true;
  }

  /** Steps done of `ids` (default: every step). */
  count(ids = STEP_IDS) {
    const done = this.done;
    return ids.filter((id) => done[id] === true).length;
  }

  get total() {
    return STEP_IDS.length;
  }

  /** `{ done, total }` of a chapter. */
  chapter(chapterId) {
    const c = GUIDE.find((x) => x.id === chapterId);
    const ids = c ? c.steps.map((s) => s.id) : [];
    return { done: this.count(ids), total: ids.length };
  }

  /** The first step of a chapter not done yet, or null. */
  firstOpen(chapterId) {
    const c = GUIDE.find((x) => x.id === chapterId);
    const done = this.done;
    return c?.steps.find((s) => done[s.id] !== true)?.id ?? null;
  }

  /**
   * Mark steps done. Returns the ids that were not done before. Unknown ids
   * are ignored (a newer game's step synced from the account stays in the
   * setting untouched).
   */
  mark(ids) {
    const done = this.done;
    const fresh = [...new Set(ids)].filter((id) => STEPS.has(id) && done[id] !== true);
    if (!fresh.length) return [];
    for (const id of fresh) done[id] = true;
    this.registry.set('guide', 'done', done);
    // The tour is over once its steps are: it does not start again until the switch goes on.
    if (fresh.some((id) => TOUR_STEPS.includes(id)) && this.tourComplete()) this.registry.set('guide', 'tourInGames', false);
    return fresh;
  }

  get tourInGames() {
    return this.registry.get('guide', 'tourInGames') === true;
  }

  /**
   * The "Tour in my games" switch. Switched on after the tour was finished,
   * the tour's steps start over (the rest of the guide keeps its ticks), so
   * the tour shows again in the next skirmish.
   */
  setTourInGames(on) {
    if (on && this.tourComplete()) {
      const done = this.done;
      for (const id of TOUR_STEPS) delete done[id];
      this.registry.set('guide', 'done', done);
    }
    return this.registry.set('guide', 'tourInGames', !!on);
  }

  tourComplete() {
    return this.count(TOUR_STEPS) === TOUR_STEPS.length;
  }

  /** The tour step to show now, or null when the tour is done. */
  tourStep() {
    return this.firstOpen(TOUR_CHAPTER);
  }

  /** Follow changes of the guide settings (here, another tab, the account): fn(). Returns the unsubscribe. */
  subscribe(fn) {
    return this.registry.subscribe('guide', () => fn());
  }
}

/**
 * Whether the tour runs in a game. Only the player's own skirmish games
 * (a skirmish save too): never missions, online games, replays, spectators
 * or the stress test, and only while "Tour in my games" is on and a tour
 * step is open.
 * @param {{ kind: 'skirmish'|'mission'|'online'|'replay'|'stress', watching?: boolean }} game
 */
export function tourRuns(game, progress) {
  if (game?.kind !== 'skirmish' || game.watching) return false;
  return progress.tourInGames && !progress.tourComplete();
}

/**
 * Whether the guide follows a game at all: the local player plays it
 * (skirmish, mission or online), not a replay, a spectator or the stress test.
 */
export function guideFollows(game) {
  return !!game && !game.watching && (game.kind === 'skirmish' || game.kind === 'mission' || game.kind === 'online');
}

/**
 * Watches one game for the local player and marks the guide's steps done
 * (see the top of this file). `onDone(ids)` runs with the steps that were
 * just ticked off (the tour shows "Step done").
 */
export class GuideTracker {
  /**
   * @param {{ progress: GuideProgress, actors: { id: string }[], player: number, onDone?: (ids: string[]) => void }} o
   *   actors: the engine's actor list (rules.actors), for event types
   */
  constructor({ progress, actors, player, onDone = () => {} }) {
    this.progress = progress;
    this.actors = actors ?? [];
    this.player = player;
    this.onDone = onDone;
    this.memory = { placed: new Map(), oreDelivered: false };
    this.lastResources = null;
    this.disposed = false;
  }

  dispose() {
    this.disposed = true;
  }

  /** The steps still open whose trigger has a `field`. */
  open(field) {
    const done = this.progress.done;
    return STEP_IDS.filter((id) => done[id] !== true && TRIGGERS[id]?.[field] !== undefined);
  }

  mark(ids) {
    if (this.disposed || !ids.length) return [];
    const fresh = this.progress.mark(ids);
    if (fresh.length) this.onDone(fresh);
    return fresh;
  }

  /** A frame's engine events (STRIDE values each: kind, a, x, y, owner, b). */
  onEvents(events) {
    if (this.disposed || !events?.length) return;
    const hits = [];
    let placedNew = false;
    for (let i = 0; i + STRIDE <= events.length; i += STRIDE) {
      const kind = events[i];
      const type = this.actors[events[i + 1]]?.id ?? '';
      const owner = events[i + 4];
      const b = events[i + 5];
      if (kind === EV.BUILDING_PLACED && owner === this.player) {
        this.memory.placed.set(type, (this.memory.placed.get(type) ?? 0) + 1);
        placedNew = true;
      }
      for (const id of this.open('anyEvent')) if (TRIGGERS[id].anyEvent(kind)) hits.push(id);
      if (owner !== this.player) continue;
      for (const id of this.open('event')) if (TRIGGERS[id].event(kind, type, owner, b)) hits.push(id);
      if (kind === EV.BUILDING_PLACED) for (const id of this.open('placed')) if (TRIGGERS[id].placed.includes(type)) hits.push(id);
    }
    this.mark(hits);
    // Steps that count what was placed in this game.
    if (placedNew) this.checkState(null);
  }

  /**
   * The player state (Game.player_json) and the sky (`weather`: Game
   * weather_json's `weather`), every 100 ms.
   */
  onState(state, { weather = null } = {}) {
    if (this.disposed || !state) return;
    // The ore in the refinery and silos goes up only when a truck unloads (selling and cash do not touch it).
    const r = Number(state.resources);
    if (Number.isFinite(r)) {
      if (this.lastResources !== null && r > this.lastResources) this.memory.oreDelivered = true;
      this.lastResources = r;
    }
    this.checkState({ ...state, weather });
  }

  checkState(state) {
    const s = state ?? {};
    this.mark(this.open('state').filter((id) => TRIGGERS[id].state(s, this.memory)));
  }

  /** An order the local player gave through the UI (withGuide). */
  onOrder(method, args) {
    if (this.disposed) return;
    this.mark(this.open('order').filter((id) => TRIGGERS[id].order(method, args)));
  }

  /** A screen's signal ('teamChat', 'onlineGame'). */
  signal(name) {
    if (this.disposed) return;
    this.mark(this.open('signal').filter((id) => TRIGGERS[id].signal === name));
  }
}

/** The read-only steps of a chapter (ticked off when the guide shows it). */
export function readSteps(chapterId) {
  const c = GUIDE.find((x) => x.id === chapterId);
  return c ? c.steps.filter((s) => TRIGGERS[s.id]?.read).map((s) => s.id) : [];
}

/**
 * Wrap the UI's game so the local player's orders reach `onOrder(method,
 * args)` after they were given; everything else passes through.
 */
export function withGuide(game, onOrder) {
  const watched = new Set([...ORDER_METHODS, 'set_stance']);
  return new Proxy(game, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target);
      if (typeof v !== 'function') return v;
      if (!watched.has(prop)) return v.bind(target);
      return (...args) => {
        const r = v.apply(target, args);
        onOrder(prop, args);
        return r;
      };
    },
  });
}

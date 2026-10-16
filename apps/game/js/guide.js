// The guide's progress and what ticks its steps off (docs/contracts.md, "The
// guide and the tour"). The chapters and their texts are GUIDE in
// js/help.js; the game menu's Guide page is js/guideview.js and the tour
// card of the skirmish games js/tour.js.
//
// Progress is a declared setting (registry guide.done: { stepId: true }), so
// it follows the account like every other setting; guide.tourInGames is the
// "Tour in my games" switch, the player's own choice: skipping the tour turns
// it off; since 0.18.0 finishing it does not, so tour steps a later version
// adds reach players who finish from then on. 0.17.0 turned it off when the
// tour was done; those players find later tour steps through the "New"
// badges and the Guide (its switch, Take the tour again).
//
// Content added in later versions (docs/contracts.md, "The guide and the
// tour"): every chapter, and a step that came later than its chapter, says
// in `since` which version brought it. guide.seen is the newest guide
// content the player was shown; steps newer than that are "New" in the game
// menu and on the Guide page until the player opens the Guide.
//
// Steps tick off in order (docs/contracts.md, "The guide and the tour"): a
// step waits for the steps before it in its chapter (help.js GUIDE `after`,
// `parallel`, `passive`, `outside`). A GuideTracker watches one game for the
// local player (never spectators or replays), remembers what happened in it
// (`memory`) and marks every step whose turn it is and whose test holds; a
// step that was already achieved ticks the moment its turn comes ("already
// done"). While the tour runs only the tour's chapter is marked, so the
// Guide page never shows a later chapter half done. What it remembers:
//
// - engine events (engine/src/sound_events.rs, the buffer js/main.js takes
//   each frame for the sound): an MCV deployed, a structure placed, a unit
//   produced (a refinery's free Ore Truck is not: the engine spawns it with
//   the refinery, engine/src/tests_sound.rs), a building powered down,
//   lightning, a support power ready;
// - the player state polled every 100 ms (Game.player_json): a Construction
//   Yard (hasProducer), low power, the power margin, ore delivered (the
//   stored ore goes up), what this game can build (`buildable`), and the sky
//   (a thunderstorm);
// - the orders the local player gives through the UI's game (withGuide, a
//   wrapper like js/targetlines.js withTargetLines): move, attack move,
//   guard, stop, scatter, waypoints, fire stances;
// - signals from the screens: a team chat line sent, an online game started;
// - reading: steps that only explain tick off when the Guide shows them
//   (in order) or with Got it on the tour card.
//
// State is preferred over events where it can tell (the notes in
// docs/redesign-uitwerking.md 15): a hidden tab drops engine events. No DOM
// here: Node tests import it.

import { GUIDE } from './help.js';
import { EV, STRIDE } from './audio/director.js';
import { boundKey } from './hotkeys.js';
import { compareVersions, newestVersion } from './releasenotes.js';
import { setQuickTips } from './quicktips.js';
import { applyGuideAction } from '../protocol/guide.js';

/**
 * The order the tour walks the chapters in; GUIDE (js/help.js) has the same
 * order. A chapter a guide has that is not listed here comes after these,
 * in the guide's order.
 */
export const TOUR_ORDER = Object.freeze(['base', 'units', 'ore', 'power', 'weather', 'powers', 'team']);

/**
 * The guide as 0.17.0 shipped it, the first one: the content of every
 * player who had a guide before guide.seen existed (it came in 0.18.0).
 */
export const GUIDE_BASELINE = '0.17.0';

/**
 * Credit carried over at every game start (GuideProgress.reconcile): a
 * player who has done every step on the right has the step on the left done
 * too. Steps whose meaning changed get a new id: 0.19.0 split "Build
 * Barracks and a War Factory" (base.production) into two steps. A step that
 * a later one implies: a Radar Dome placed is room made for it
 * (base.morePower ticks on a dome placed anyway), so a player with the
 * radar done never gets the power check before it.
 */
export const CARRIED = Object.freeze({
  'base.barracks': Object.freeze(['base.production']),
  'base.factory': Object.freeze(['base.production']),
  'base.morePower': Object.freeze(['base.radar']),
});

/** Whether version `a` is newer than `b`; null `b` (nothing seen) is older than every version. */
export function newerThan(a, b) {
  return b === null || b === undefined ? true : compareVersions(a, b) > 0;
}

/** Whether the tour counts a step: not one that only happens to the player (`passive`) or outside a skirmish (`outside`). */
export function tourCounted(step) {
  return !step.passive && !step.outside;
}

/**
 * The guide's content, indexed: `chapters` (help.js GUIDE), `steps` (step id
 * -> { step, chapter, index in its chapter, since, after }), `stepIds` in
 * guide order, `tourChapters` (the chapters in tour order, TOUR_ORDER),
 * `tourIds` (every step the tour counts, in tour order) and `version`, the
 * newest `since` of all. A step's `since` is its own or its chapter's; its
 * `after` (the steps it waits for) is its own or the chapter's step before
 * it that is not `parallel`.
 */
export function guideContent(chapters) {
  const steps = new Map();
  let version = GUIDE_BASELINE;
  for (const chapter of chapters) {
    const chapterSince = chapter.since ?? GUIDE_BASELINE;
    let previous = null;
    chapter.steps.forEach((step, index) => {
      const since = step.since ?? chapterSince;
      const after = Object.freeze(step.after ? [...step.after] : previous ? [previous] : []);
      steps.set(step.id, { step, chapter, index, since, after });
      if (!step.parallel) previous = step.id;
      if (compareVersions(since, version) > 0) version = since;
    });
  }
  const rank = (c) => {
    const i = TOUR_ORDER.indexOf(c.id);
    return i < 0 ? TOUR_ORDER.length + chapters.indexOf(c) : i;
  };
  const tourChapters = [...chapters].sort((a, b) => rank(a) - rank(b));
  return Object.freeze({
    chapters,
    steps,
    stepIds: Object.freeze([...steps.keys()]),
    tourChapters: Object.freeze(tourChapters),
    tourIds: Object.freeze(tourChapters.flatMap((c) => c.steps.filter(tourCounted).map((s) => s.id))),
    version,
  });
}

/** This game's guide (help.js GUIDE). */
export const CONTENT = guideContent(GUIDE);

/** Step id -> { step, chapter, index (in its chapter), since, after }. */
export const STEPS = CONTENT.steps;

/** Every step id, in guide order. */
export const STEP_IDS = CONTENT.stepIds;

/** Every step the tour counts, in tour order. */
export const TOUR_STEPS = CONTENT.tourIds;

/** The orders that count as "an order given" (units.order). */
const ORDER_METHODS = new Set(['order_smart', 'order_move', 'order_attack', 'order_attack_ground', 'order_waypoint', 'order_guard', 'order_stop', 'order_scatter']);

/** The engine events the guide remembers (recordEvent). */
const GUIDE_EVENTS = new Set([EV.TRANSFORMED, EV.BUILDING_PLACED, EV.UNIT_PRODUCED, EV.POWER_TOGGLED, EV.POWER_READY, EV.LIGHTNING_STRIKE]);

/** The production queues (engine/src/rules.rs QueueType, rules_json `queue`). */
const QUEUE_BUILDINGS = 0;
const QUEUE_INFANTRY = 2;
const QUEUE_VEHICLES = 3;

/** Vehicles that are not an army: the Ore Truck has its own step (ore.truck), the MCV is the base. */
const NOT_ARMY = new Set(['HARV', 'MCV']);

/**
 * The game's memory of what happened, for one game (GuideTracker.memory):
 * `yard` (a Construction Yard was the player's), `placed` and `produced`
 * (actor id -> count this game), `poweredDown`, `powerReady`, `lightning`
 * (a strike anywhere), `storm` (a thunderstorm seen), `lowPower` (low power
 * seen), `oreDelivered`, `orders` (the kinds of order given), `signals`, and
 * the last player `state`.
 */
export function newMemory() {
  return {
    yard: false,
    placed: new Map(),
    produced: new Map(),
    poweredDown: false,
    powerReady: false,
    lightning: false,
    storm: false,
    lowPower: false,
    oreDelivered: false,
    lastResources: null,
    orders: new Set(),
    signals: new Set(),
    state: null,
  };
}

/** An engine event (kind, actor id `type`, owner, b) into `memory`; `player` is the local player. */
export function recordEvent(memory, kind, type, owner, b, player) {
  if (kind === EV.LIGHTNING_STRIKE) memory.lightning = true;
  if (owner !== player) return;
  if (kind === EV.TRANSFORMED && type === 'MCV') memory.yard = true;
  else if (kind === EV.BUILDING_PLACED) memory.placed.set(type, (memory.placed.get(type) ?? 0) + 1);
  else if (kind === EV.UNIT_PRODUCED) memory.produced.set(type, (memory.produced.get(type) ?? 0) + 1);
  // POWER_TOGGLED: b 1 switched off with the power down button (engine repair.rs).
  else if (kind === EV.POWER_TOGGLED && b === 1) memory.poweredDown = true;
  else if (kind === EV.POWER_READY) memory.powerReady = true;
}

/** The player state (Game.player_json) and the sky (`weather`) into `memory`. */
export function recordState(memory, state, weather = null) {
  memory.state = state;
  // Queue 0 is the Construction Yard's: a "Construction Yard" start, a save, a mission's yard.
  if (state.hasProducer?.[QUEUE_BUILDINGS] === true) memory.yard = true;
  if (state.lowPower === true) memory.lowPower = true;
  if (weather === 'thunderstorm') memory.storm = true;
  // The ore in the refinery and silos goes up only when a truck unloads (selling and cash do not touch it).
  const r = Number(state.resources);
  if (Number.isFinite(r)) {
    if (memory.lastResources !== null && r > memory.lastResources) memory.oreDelivered = true;
    memory.lastResources = r;
  }
}

/** An order the local player gave (withGuide) into `memory.orders`. */
export function recordOrder(memory, method, args) {
  if (ORDER_METHODS.has(method)) memory.orders.add('order');
  // order_move and order_waypoint: the last argument is attack move (engine lib.rs).
  const attackMove = args[args.length - 1] === true;
  if ((method === 'order_move' || method === 'order_waypoint') && attackMove) memory.orders.add('attackMove');
  if (method === 'order_guard' || method === 'order_stop' || method === 'order_scatter') memory.orders.add('guard');
  if (method === 'order_waypoint' && !attackMove) memory.orders.add('queue');
  if (method === 'set_stance') memory.orders.add('stance');
}

/** A screen's signal ('teamChat', 'onlineGame') into `memory.signals`. */
export function recordSignal(memory, name) {
  memory.signals.add(name);
}

function placedAny(memory, ids) {
  return ids.some((id) => (memory.placed.get(id) ?? 0) > 0);
}

/** Whether a unit of `queue` (QUEUE_*) other than `except` was produced. */
function producedFrom(memory, actors, queue, except = NOT_ARMY) {
  for (const [id, n] of memory.produced) if (n > 0 && !except.has(id) && actors.get(id)?.queue === queue) return true;
  return false;
}

/** The power a building uses (rules_json `power`, negative for users), 0 when unknown. */
export function drain(actors, id) {
  return Math.max(0, -(actors.get(id)?.power ?? 0));
}

/**
 * What ticks each step off: `test(memory, state, actors)` on the game's
 * memory, the player state that just came (null when an event, an order or
 * a signal asks: the last state may be from before the event, a War Factory
 * placed but its power not yet counted) and the actors by id (rules.actors);
 * `read` for steps that only explain (the Guide page or Got it). A step is
 * only tested when it is its turn.
 */
export const TRIGGERS = Object.freeze({
  'base.mcv': { test: (m) => m.yard },
  'base.power': { test: (m) => placedAny(m, ['POWR', 'APWR']) },
  'base.refinery': { test: (m) => placedAny(m, ['PROC']) },
  'base.barracks': { test: (m) => placedAny(m, ['TENT', 'BARR']) },
  'army.infantry': { test: (m, _s, actors) => producedFrom(m, actors, QUEUE_INFANTRY) },
  'base.factory': { test: (m) => placedAny(m, ['WEAP']) },
  'army.vehicle': { test: (m, _s, actors) => producedFrom(m, actors, QUEUE_VEHICLES) },
  // Room for a Radar Dome now: what the engine checks after placing it (world.rs low_power), or a dome placed anyway.
  'base.morePower': {
    test: (m, s, actors) => placedAny(m, ['DOME']) || (!!s && Number(s.powerGenerated) - Number(s.powerUsed) >= drain(actors, 'DOME')),
  },
  'base.radar': { test: (m) => placedAny(m, ['DOME']) },
  'units.order': { test: (m) => m.orders.has('order') },
  'units.attackMove': { test: (m) => m.orders.has('attackMove') },
  'units.guard': { test: (m) => m.orders.has('guard') },
  'units.queue': { test: (m) => m.orders.has('queue') },
  'units.stance': { test: (m) => m.orders.has('stance') },
  'ore.deliver': { test: (m) => m.oreDelivered },
  // Produced: a truck from the War Factory (the refinery's free one is not reported).
  'ore.truck': { test: (m) => (m.produced.get('HARV') ?? 0) > 0 },
  'ore.gems': { read: true },
  'ore.silo': { test: (m) => placedAny(m, ['SILO']) },
  'power.bar': { read: true },
  'power.low': { test: (m) => m.lowPower },
  // A second plant in one game, or an Advanced Power Plant.
  'power.more': { test: (m) => (m.placed.get('POWR') ?? 0) + (m.placed.get('APWR') ?? 0) >= 2 || placedAny(m, ['APWR']) },
  'power.down': { test: (m) => m.poweredDown },
  // The sky (Game.weather_json) or a strike: a thunderstorm the player was in.
  'weather.storm': { test: (m) => m.storm || m.lightning },
  'weather.plants': { read: true },
  'weather.rod': { test: (m) => placedAny(m, ['LROD']) },
  'weather.other': { read: true },
  'powers.timers': { read: true },
  'powers.ready': { test: (m) => m.powerReady },
  'powers.spread': { read: true },
  'team.chat': { test: (m) => m.signals.has('teamChat') },
  'team.online': { test: (m) => m.signals.has('onlineGame') },
  'team.rejoin': { read: true },
});

/** Whether a step only explains (ticks off when read). */
export function isRead(id) {
  return TRIGGERS[id]?.read === true;
}

/** Every step is in the game: before the first player state, outside a game. */
export const EVERY_STEP = Object.freeze({ available: () => true });

/**
 * Which steps a game has (`ctx.available(id)`), from the player state's
 * `buildable` (every item of the game mode): a step whose `builds` or
 * `needs` are all missing or locked for good is not in this game. An item
 * with `exclusive` (engine lib.rs: the tech level, the other side's items)
 * can never be built in it, like js/sidebar.js shows it locked. Without a
 * list, every step is.
 */
export function gameSteps(buildable, content = CONTENT) {
  if (!Array.isArray(buildable)) return EVERY_STEP;
  const ids = new Set(buildable.filter((b) => b && !b.exclusive).map((b) => b.id));
  const has = (list) => !list?.length || list.some((id) => ids.has(id));
  return Object.freeze({
    available(id) {
      const step = content.steps.get(id)?.step;
      return !step || (has(step.builds) && has(step.needs));
    },
  });
}

/** The "Watching: ..." line of a step, or its done or plain form. */
export function stepStatus(id, { done, active }, content = CONTENT) {
  const watch = content.steps.get(id)?.step.watch ?? '';
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
 * The player's progress: which steps are done, whose turn it is, whether the
 * tour runs in their skirmish games and which steps are new to them. Reads
 * and writes the registry's guide group. `content` is the guide
 * (guideContent; tests pass their own). Methods that take `done` use that
 * snapshot of guide.done instead of reading the setting again (the tracker
 * reads it once per pass).
 */
export class GuideProgress {
  /** @param {ReturnType<import('./registry.js').createRegistry>} registry */
  constructor(registry, content = CONTENT) {
    this.registry = registry;
    this.content = content;
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
  count(ids = this.content.stepIds, done = this.done) {
    return ids.filter((id) => done[id] === true).length;
  }

  get total() {
    return this.content.stepIds.length;
  }

  /** `{ done, total }` of a chapter. */
  chapter(chapterId) {
    const c = this.content.chapters.find((x) => x.id === chapterId);
    const ids = c ? c.steps.map((s) => s.id) : [];
    return { done: this.count(ids), total: ids.length };
  }

  /** The first step of a chapter not done yet, or null. */
  firstOpen(chapterId) {
    const c = this.content.chapters.find((x) => x.id === chapterId);
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
    const fresh = [...new Set(ids)].filter((id) => this.content.steps.has(id) && done[id] !== true);
    if (!fresh.length) return [];
    for (const id of fresh) done[id] = true;
    this.registry.set('guide', 'done', done);
    return fresh;
  }

  /**
   * Whether it is a step's turn: every step it waits for (`after`) is done,
   * not in this game (`ctx`), or happens by itself or outside a skirmish
   * (`passive`, `outside`) and is its turn too. Done steps stay done
   * whatever came before them.
   */
  reachable(id, ctx = EVERY_STEP, done = this.done) {
    const entry = this.content.steps.get(id);
    return !!entry && entry.after.every((a) => this.passed(a, ctx, done));
  }

  /** Whether the steps after `id` may go on (see reachable). */
  passed(id, ctx = EVERY_STEP, done = this.done) {
    if (done[id] === true || !ctx.available(id)) return true;
    const step = this.content.steps.get(id)?.step;
    return !!step && !tourCounted(step) && this.reachable(id, ctx, done);
  }

  /** Mark a chapter's explaining steps whose turn it is, in order (the Guide page shows the chapter). Returns the fresh ids. */
  markRead(chapterId) {
    const chapter = this.content.chapters.find((c) => c.id === chapterId);
    if (!chapter) return [];
    const done = { ...this.done };
    const read = [];
    for (const s of chapter.steps) {
      if (done[s.id] !== true && isRead(s.id) && this.reachable(s.id, EVERY_STEP, done)) {
        done[s.id] = true;
        read.push(s.id);
      }
    }
    return this.mark(read);
  }

  /**
   * The "Tour in my games" switch: off only when the player skipped the tour
   * or switched it off. A finished tour leaves it on, so tour steps that a
   * later version adds show in the next skirmish.
   */
  get tourInGames() {
    return this.registry.get('guide', 'tourInGames') === true;
  }

  /**
   * Set the switch. Switched on after the tour was finished, the tour's steps
   * start over (the rest of the guide keeps its ticks), so the tour shows
   * again in the next skirmish.
   */
  setTourInGames(on) {
    if (on && this.tourComplete()) this.restartTour();
    return this.registry.set('guide', 'tourInGames', !!on);
  }

  /**
   * Take the tour again: its steps start over (passive and outside ones keep
   * their ticks) and the switch goes on. No new reset epoch: the account
   * sync's set merge removes the tour's steps on the other devices and keeps
   * the steps they ticked meanwhile (js/account/sync.js KEYED_MERGE).
   */
  restartTour() {
    const done = this.done;
    for (const id of this.content.tourIds) delete done[id];
    this.registry.patch('guide', { done, tourInGames: true });
  }

  /** Whether anything of the progress can be reset: a step done, the tour switched off, or the quick tips question asked. */
  get started() {
    return Object.keys(this.done).length > 0 || !this.tourInGames || this.quickTipsAsked;
  }

  /**
   * Reset guide progress (the Guide page, after a confirm step): no step
   * done, the tour on again, the quick tips question asked again at its end,
   * and a new reset epoch so other devices take this over in the account
   * sync. guide.seen stays: what the player was shown stays shown, so the
   * Guide does not mark every step "New" (it holds no progress).
   */
  resetProgress(now = Date.now()) {
    const g = applyGuideAction(this.registry.values().guide, 'reset', now);
    this.registry.patch('guide', { done: g.done, tourInGames: g.tourInGames, quickTipsAsked: g.quickTipsAsked, resetAt: g.resetAt });
  }

  /** Every step the tour counts is done, in every chapter. */
  tourComplete(done = this.done) {
    return this.count(this.content.tourIds, done) === this.content.tourIds.length;
  }

  /** The steps of a chapter the tour counts, in order. */
  tourStepsOf(chapter) {
    return chapter.steps.filter(tourCounted).map((s) => s.id);
  }

  /** The chapter the tour is in: the first in tour order with a step it counts that is open and in this game; null when none. */
  tourChapter(ctx = EVERY_STEP, done = this.done) {
    return this.content.tourChapters.find((c) => this.tourStepsOf(c).some((id) => done[id] !== true && ctx.available(id))) ?? null;
  }

  /** The open counted steps of the tour's chapter whose turn it is, in this game: [main line, parallel]. */
  tourOpen(ctx = EVERY_STEP, done = this.done) {
    const chapter = this.tourChapter(ctx, done);
    if (!chapter) return [[], []];
    const open = this.tourStepsOf(chapter).filter((id) => done[id] !== true && ctx.available(id) && this.reachable(id, ctx, done));
    const parallel = (id) => this.content.steps.get(id).step.parallel === true;
    return [open.filter((id) => !parallel(id)), open.filter(parallel)];
  }

  /** The tour step to show now: the first open step of the tour's chapter, a parallel one when no other is open; null when none. */
  tourStep(ctx = EVERY_STEP, done = this.done) {
    const [main, parallel] = this.tourOpen(ctx, done);
    return main[0] ?? parallel[0] ?? null;
  }

  /** The parallel step the tour shows beside the main one ("Also"), or null. */
  tourAlso(ctx = EVERY_STEP, done = this.done) {
    const [main, parallel] = this.tourOpen(ctx, done);
    return (main.length ? parallel[0] : parallel[1]) ?? null;
  }

  /** Whether the quick tips question of the tour's end was asked (guide.quickTipsAsked). */
  get quickTipsAsked() {
    return this.registry.get('guide', 'quickTipsAsked') === true;
  }

  /** The tour is done and its last card, the quick tips question, still has to show (in the next skirmish when it was done elsewhere). */
  finalePending(done = this.done) {
    return this.tourInGames && this.tourComplete(done) && !this.quickTipsAsked;
  }

  /**
   * The answer to the quick tips question: `keep` true or false sets
   * game.quickTips, null (the card closed) leaves it as it is. Asked once,
   * ever: also not again after Take the tour again.
   */
  answerQuickTips(keep) {
    if (keep !== null) setQuickTips(this.registry, keep);
    this.registry.set('guide', 'quickTipsAsked', true);
  }

  /** The newest guide content the player was shown (guide.seen), or null before reconcile. */
  get seen() {
    return this.registry.get('guide', 'seen');
  }

  /** Steps that came after the content the player was shown and are not done yet, in guide order. */
  newSteps() {
    const seen = this.seen;
    if (seen === null) return [];
    const done = this.done;
    return this.content.stepIds.filter((id) => done[id] !== true && newerThan(this.content.steps.get(id).since, seen));
  }

  /** The player opened the Guide: what it holds now is seen. */
  markSeen() {
    const next = newestVersion(this.seen, this.content.version);
    if (next !== this.seen) this.registry.set('guide', 'seen', next);
  }

  /**
   * Bring a player's stored progress up to this game's guide, at the start
   * of each game (js/main.js). Every time: a step whose sources (CARRIED)
   * are all done is done too. Once per player, the first time (guide.seen
   * not set yet):
   * - a new player (no step done, the tour not switched off) has seen
   *   everything: no "New" badges, the tour as usual;
   * - a player from 0.17.0 has seen the baseline guide, so what came later
   *   is new to them. Their switch stays as stored: 0.17.0 turned it off both
   *   when the tour was finished and when it was skipped, and its tracker
   *   ticked the tour's steps whatever the switch said, so a skipper who
   *   played on looks the same as a player who finished.
   */
  reconcile() {
    const done = this.done;
    this.mark(Object.keys(CARRIED).filter((id) => done[id] !== true && CARRIED[id].every((old) => done[old] === true)));
    if (this.seen !== null) return;
    const history = Object.keys(done).length > 0 || !this.tourInGames;
    if (!history) {
      this.registry.set('guide', 'seen', this.content.version);
      return;
    }
    this.registry.set('guide', 'seen', GUIDE_BASELINE);
  }

  /** Follow changes of the guide settings (here, another tab, the account): fn(). Returns the unsubscribe. */
  subscribe(fn) {
    return this.registry.subscribe('guide', () => fn());
  }
}

/**
 * Whether the tour runs in a game. Only the player's own skirmish games
 * (a skirmish save too): never missions, online games, replays, spectators,
 * the map editor's test play (kind 'editor') or the stress test, and only
 * while "Tour in my games" is on and a tour step is open or the tour's
 * last card (the quick tips question) has not shown yet.
 * @param {{ kind: 'skirmish'|'mission'|'online'|'replay'|'editor'|'stress', watching?: boolean }} game
 */
export function tourRuns(game, progress) {
  if (game?.kind !== 'skirmish' || game.watching) return false;
  return progress.tourInGames && (!progress.tourComplete() || progress.finalePending());
}

/**
 * Whether the guide follows a game at all: the local player plays it
 * (skirmish, mission or online), not a replay, a spectator, the map
 * editor's test play or the stress test.
 */
export function guideFollows(game) {
  return !!game && !game.watching && (game.kind === 'skirmish' || game.kind === 'mission' || game.kind === 'online');
}

/**
 * Watches one game for the local player and marks the guide's steps done
 * (see the top of this file). `onDone(ids)` runs once per pass with the
 * steps just ticked off, in the order they ticked (the tour shows "Step
 * done" and "already done"). With `tour` (the tour runs in this game,
 * tourRuns) only the tour's chapter is marked while the tour is on; the
 * rest waits in `memory` until the tour gets there.
 */
export class GuideTracker {
  /**
   * @param {{ progress: GuideProgress, actors: { id: string, queue?: number, power?: number }[], player: number, tour?: boolean, onDone?: (ids: string[]) => void }} o
   *   actors: the engine's actor list (rules.actors), for event types, queues and power
   */
  constructor({ progress, actors, player, tour = false, onDone = () => {} }) {
    this.progress = progress;
    this.actors = actors ?? [];
    this.byId = new Map(this.actors.map((a) => [a.id, a]));
    this.player = player;
    this.tour = !!tour;
    this.onDone = onDone;
    this.memory = newMemory();
    this.disposed = false;
  }

  dispose() {
    this.disposed = true;
  }

  /** Which steps this game has (gameSteps of the last player state). */
  ctx() {
    return gameSteps(this.memory.state?.buildable, this.progress.content);
  }

  /**
   * Mark every open step whose turn it is and whose test holds, again until
   * nothing more ticks (a tick makes the next step's turn, which may have
   * happened already). One read of guide.done per pass. `state`: the player
   * state that just came (onState), for the steps about "now".
   */
  evaluate(state = null) {
    if (this.disposed) return [];
    const { progress } = this;
    const { content } = progress;
    const ctx = this.ctx();
    const ticked = [];
    for (let pass = 0; pass <= content.stepIds.length; pass++) {
      const done = progress.done;
      const focus = this.tour && progress.tourInGames ? progress.tourChapter(ctx, done) : null;
      const hits = content.stepIds.filter((id) => {
        if (done[id] === true || isRead(id) || !ctx.available(id)) return false;
        if (focus && content.steps.get(id).chapter !== focus) return false;
        return progress.reachable(id, ctx, done) && TRIGGERS[id]?.test?.(this.memory, state, this.byId) === true;
      });
      const fresh = progress.mark(hits);
      if (!fresh.length) break;
      ticked.push(...fresh);
    }
    if (ticked.length) this.onDone(ticked);
    return ticked;
  }

  /** A frame's engine events (STRIDE values each: kind, a, x, y, owner, b). */
  onEvents(events) {
    if (this.disposed || !events?.length) return;
    let seen = false;
    for (let i = 0; i + STRIDE <= events.length; i += STRIDE) {
      const kind = events[i];
      if (!GUIDE_EVENTS.has(kind)) continue;
      recordEvent(this.memory, kind, this.actors[events[i + 1]]?.id ?? '', events[i + 4], events[i + 5], this.player);
      seen = true;
    }
    if (seen) this.evaluate();
  }

  /**
   * The player state (Game.player_json) and the sky (`weather`: Game
   * weather_json's `weather`), every 100 ms.
   */
  onState(state, { weather = null } = {}) {
    if (this.disposed || !state) return;
    recordState(this.memory, state, weather);
    this.evaluate(state);
  }

  /** An order the local player gave through the UI (withGuide). */
  onOrder(method, args) {
    if (this.disposed) return;
    recordOrder(this.memory, method, args);
    this.evaluate();
  }

  /** A screen's signal ('teamChat', 'onlineGame'). */
  signal(name) {
    if (this.disposed) return;
    recordSignal(this.memory, name);
    this.evaluate();
  }
}


/** The read-only steps of a chapter (ticked off when the guide shows them, in order). */
export function readSteps(chapterId, content = CONTENT) {
  const c = content.chapters.find((x) => x.id === chapterId);
  return c ? c.steps.filter((s) => isRead(s.id)).map((s) => s.id) : [];
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

// Decides what to play: turns the engine's audio events (sound_events.rs) and
// the client's own moments (orders, selection, production clicks, player
// state) into effects, unit replies, sound notifications and announcer lines,
// with throttling, positional culling and a per-frame voice budget so a
// battle of thousands of units stays a soundscape instead of a wall of noise.
//
// Who hears what follows OpenRA: speech notifications and UI sounds go to the
// player they are for (Sound.PlayNotification with a player), a spectator
// hears none of them; world sounds (weapons, explosions, crushes, cloaks) are
// heard by everyone near them, here also only where the player can see
// (WebRA's fog rule for world sounds), except the player's own.
//
// No Web Audio here: the director talks to a `sink` and reads a clock, so the
// rules are unit tested in Node (tests/audio.test.mjs).

import {
  fireSound,
  fireChargeSound,
  impactSound,
  madTankSounds,
  teleportSound,
  deathSound,
  placeSound,
  sellSound,
  transformSounds,
  deployBlocked,
  powerSound,
  voiceLine,
  orderVoice,
  producedVoice,
  killVoice,
  KINDS,
  EVA,
  POWER_KINDS,
  speechKey,
  queueLine,
  PLAYER_LINES,
  timeLimitLine,
  actorSounds,
  lostLine,
  captureLines,
  infiltrationLines,
  repairLines,
  primaryLine,
  powerNotifications,
  damagedSound,
  crushSound,
  chuteSound,
  ejectChuteSound,
  paraImpactSound,
  cloakSound,
  rearmSound,
  levelUp,
  crateSounds,
} from './catalog.js';

/** Event kinds (engine/src/sound_events.rs SoundEventKind). */
export const EV = {
  FIRE: 1,
  IMPACT: 2,
  DEATH: 3,
  BUILDING_DAMAGED: 4,
  UNIT_PRODUCED: 5,
  BUILDING_PLACED: 6,
  SOLD: 7,
  INSUFFICIENT_FUNDS: 8,
  POWER_ACTIVATED: 9,
  CONSTRUCTION_READY: 10,
  REPAIR_STARTED: 11,
  POWER_TOGGLED: 12,
  BEACON_PLACED: 13,
  UNIT_DAMAGED: 14,
  TRANSFORMED: 15,
  DEPLOY_BLOCKED: 16,
  POWER_CHARGING: 17,
  POWER_READY: 18,
  REINFORCEMENTS_ARRIVED: 19,
  PRODUCTION_CANCELLED: 20,
  PRODUCTION_BLOCKED: 21,
  UNIT_REPAIR_STARTED: 22,
  UNIT_REPAIRED: 23,
  LEVEL_UP: 24,
  CRUSHED: 25,
  DAMAGE_HEAVY: 26,
  CLOAK_CHANGED: 27,
  PARA_DROP: 28,
  PARACHUTE_IMPACT: 29,
  REARMED: 30,
  NEW_OPTIONS: 31,
  PRIMARY_BUILDING_SELECTED: 32,
  CAPTURED: 33,
  INFILTRATED: 34,
  TIME_LIMIT_WARNING: 35,
  CRATE_COLLECTED: 36,
  PILOT_EJECTED: 37,
  /** OpenRA AnnounceOnKill: `a` the killer's type (Tanya), to its owner. */
  KILL_ANNOUNCED: 43,
  /** OpenRA MadTank: `b` 0 charging (ChargeSound), 1 detonating (DetonationSound). */
  MAD_TANK: 45,
  /** OpenRA Teleport, at each end: `b` 1 a chrono tank's own jump (PortableChrono), 0 Chronoshiftable. */
  TELEPORTED: 46,
  /** WebRA lightning (engine lightning.rs): `b` the strike kind, 3 a power plant of `owner` (power outage). */
  LIGHTNING_STRIKE: 48,
};

/** The order behind a smart order's action code (js/cursors.js ACTION), for its voice line. */
const SMART_ORDERS = { 2: 'attack', 8: 'capture', 9: 'infiltrate', 10: 'demolish', 11: 'repair', 12: 'attack', 13: 'attack', 14: 'disguise', 17: 'capture' };
/** The order of each order method (js/audio/index.js ORDER_METHODS); the rest are moves. */
const METHOD_ORDERS = { order_attack: 'attack', order_attack_ground: 'attack' };
export const STRIDE = 6;
/**
 * The local player of a spectator or a replay viewer: no player at all, so
 * no event counts as its own (OpenRA PlayToPlayer notifications, placement,
 * deploy and sell sounds, unit replies stay with their owner).
 */
export const NO_PLAYER = -1;
/** `owner` of events every player hears (sound_events.rs ALL_PLAYERS). */
export const ALL_PLAYERS = 255;

/** Positional effects started per frame, at most. */
export const MAX_EFFECTS_PER_FRAME = 10;
/** Starts of the same sound per frame, at most (the loudest ones win). */
export const MAX_SAME_PER_FRAME = 2;
/** Seconds before the same sound may start again. */
export const SAME_SOUND_GAP = 0.045;
/** Seconds between two unit replies (orders and selection share one radio). */
export const VOICE_GAP = 0.45;
/** Beyond this distance (in half-views from the centre) a sound is culled. */
export const CULL_DISTANCE = 1.3;

/** Loudness weight per synthesized sound, so a nuke outranks a rifle. */
const WEIGHT = {
  explosion_huge: 4,
  explosion_building: 3,
  explosion_large: 2.5,
  explosion_ship: 2.5,
  explosion_medium: 2,
  artillery: 1.8,
  naval_gun: 1.8,
  rocket_heavy: 1.8,
  place_building: 1.6,
  damaged: 1.5,
  explosion_small: 1.4,
  cannon: 1.4,
  tesla: 1.4,
  crush: 1.2,
  hit: 0.6,
};
/** Sounds heard beyond the view (in half-views), e.g. a nuke across the map. */
const REACH = { explosion_huge: 6, explosion_building: 1.6 };

/**
 * Gain and stereo pan of a sound at (x, y) for a view rectangle (same units),
 * or null when it is too far away to hear. Full volume in the middle of the
 * view, half at its edge, silent at CULL_DISTANCE * reach.
 */
export function spatial(x, y, view, reach = 1) {
  const { dx, dist } = viewOffset(x, y, view);
  const d = dist / reach;
  if (d > CULL_DISTANCE) return null;
  const gain = d <= 0.7 ? 1 : Math.max(0, 1 - (d - 0.7) / (CULL_DISTANCE - 0.7));
  if (gain <= 0.01) return null;
  return { gain, pan: panAt(dx) };
}

/** Where (x, y) is from the middle of the view, in half-views: `dx`, `dy` and their larger size `dist` (1: the view's edge). */
function viewOffset(x, y, view) {
  const hw = Math.max(1, (view.x1 - view.x0) / 2);
  const hh = Math.max(1, (view.y1 - view.y0) / 2);
  const dx = (x - (view.x0 + hw)) / hw;
  const dy = (y - (view.y0 + hh)) / hh;
  return { dx, dy, dist: Math.max(Math.abs(dx), Math.abs(dy)) };
}

const panAt = (dx) => Math.max(-1, Math.min(1, dx)) * 0.75;

/** Thunder (synth.js thunder_close, thunder, thunder_distant) up to these distances in half-views; beyond, the distant one. */
export const THUNDER_CLOSE = 1;
export const THUNDER_MEDIUM = 3;
/** Thunder fades with distance as other sounds do, over this reach, but never below THUNDER_MIN_GAIN: a storm is heard across the map. */
const THUNDER_REACH = 4;
export const THUNDER_MIN_GAIN = 0.4;

/**
 * The thunder of a lightning strike at (x, y) (world pixels, Game.weather_json
 * `flash`) for a view rectangle: `{ synth, gain, pan }`. On screen the close
 * cue (crack and rumble), further off the medium one, far away the distant
 * rumble; gain and pan as spatial(), with a floor. `kind` (the flash's 4th
 * element, StrikeKind: above 0 a lightning rod, units, structures or a power
 * plant were struck) also gives the close cue just off the view's edge.
 * Without a view or a position: the medium cue in the middle.
 */
export function thunderCue(x, y, view, kind = 0) {
  if (!view || !Number.isFinite(x) || !Number.isFinite(y)) return { synth: 'thunder', gain: 1, pan: 0 };
  const { dx, dist } = viewOffset(x, y, view);
  const close = dist <= THUNDER_CLOSE || (kind > 0 && dist <= CULL_DISTANCE);
  const synth = close ? 'thunder_close' : dist <= THUNDER_MEDIUM ? 'thunder' : 'thunder_distant';
  const gain = Math.max(THUNDER_MIN_GAIN, spatial(x, y, view, THUNDER_REACH)?.gain ?? 0);
  return { synth, gain, pan: panAt(dx) };
}

/** Key identifying "the same sound" for aggregation. */
const soundKey = (s) => s.synth ?? s.originals[0] ?? '';

export class Director {
  /**
   * @param {object} o
   * @param {{ actors: { id: string, kind: string, queue?: number, powers?: string[] }[], weapons: string[] }} o.rules
   * @param {number} o.player local player index, or NO_PLAYER (spectators, replays: no player's notifications)
   * @param {'allies' | 'soviet'} o.side local player's side (voice variants)
   * @param {number} o.pxPerWorld pixels per world unit
   * @param {(id: number) => { type: string, owner: number, building: boolean } | null} o.lookup actor info by id
   * @param {{ effect(sound, opts): void, voice(line): void, announce(key): void, notify?(name, opts): void }} o.sink
   * @param {() => number} o.now seconds (throttles and cooldowns only: nothing is scheduled on it)
   * @param {number} [o.tickMs] milliseconds per simulation tick at the game's speed (the advice intervals count ticks)
   * @param {(owner: number) => boolean} [o.allied] whether a player is the local one or an ally
   */
  constructor({ rules, player, side, pxPerWorld, lookup, sink, now, tickMs = 40, allied = (owner) => owner === player }) {
    this.allied = allied;
    this.rules = rules;
    this.player = player;
    this.side = side;
    this.pxPerWorld = pxPerWorld;
    this.lookup = lookup;
    this.sink = sink;
    this.now = now;
    this.tickMs = tickMs;
    this.batch = [];
    this.lastStart = new Map();
    this.lastVoice = -Infinity;
    this.lastEva = new Map();
    this.selection = new Set();
    /** Low power (null before the first player state), and the tick its line last played. */
    this.lowPower = null;
    this.lowPowerAt = -Infinity;
    /**
     * A mission script silenced the low power line (OpenRA Lua
     * `player.PlayLowPowerNotification = false`: PowerManager skips it).
     */
    this.lowPowerQuiet = false;
    /** The tick the silo warning was last checked (OpenRA ResourceStorageWarning). */
    this.silosAt = null;
    /** The simulation tick of the last player state. */
    this.stateTick = null;
    /**
     * Whether the lines announced now come from the simulation (engine
     * events, player state) rather than from the player's clicks: the
     * announcer holds those while the game is paused (js/audio/announcer.js).
     */
    this.worldLines = false;
    /** Infantry deaths of this batch that were a crush (no scream: crushing is no DeathSounds death type). */
    this.crushed = [];
  }

  actor(ty) {
    return this.rules.actors[ty] ?? { id: '', kind: 'vehicle' };
  }

  // ---- Announcer -------------------------------------------------------------

  /** Queue an announcer line unless the same one played within its cooldown. */
  announce(key) {
    const line = key ? EVA[key] : null;
    if (!line) return false;
    const t = this.now();
    if (t - (this.lastEva.get(key) ?? -Infinity) < line.cooldown) return false;
    this.lastEva.set(key, t);
    this.sink.announce(key, { world: this.worldLines });
    return true;
  }

  /** Run `fn` with its announcer lines marked as the simulation's (`worldLines`). */
  inWorld(fn) {
    const was = this.worldLines;
    this.worldLines = true;
    try {
      fn();
    } finally {
      this.worldLines = was;
    }
  }

  /** Simulation ticks in `seconds` of game time at this game's speed. */
  ticksIn(seconds) {
    return Math.max(1, Math.round((seconds * 1000) / this.tickMs));
  }

  /** A sound notification (notifications.yaml Sounds: LevelUp, RadarUp, ...) for the local player. */
  notify(name, opts = {}) {
    this.sink.notify?.(name, opts);
  }

  // ---- Unit replies ------------------------------------------------------------

  reply(actorType, kind, line) {
    const voice = voiceLine(actorType, kind, this.side, line);
    const t = this.now();
    if (!voice || t - this.lastVoice < VOICE_GAP) return false;
    this.lastVoice = t;
    this.sink.voice(voice);
    return true;
  }

  /** First own unit (not a structure) among `ids`, as { type, kind }. */
  ownUnit(ids) {
    for (const id of ids) {
      const info = this.lookup(id);
      if (!info || info.owner !== this.player || info.building) continue;
      const actor = this.rules.actors.find((a) => a.id === info.type);
      return { type: info.type, kind: actor?.kind ?? 'vehicle' };
    }
    return null;
  }

  /** The next smart order does `action` (js/cursors.js ACTION). */
  noteSmartAction(action) {
    this.smartAction = action;
  }

  /**
   * A local order was given to `ids` through Game method `method`: one reply
   * per order, the voice line of the trait behind it (OpenRA IOrderVoice).
   */
  onOrder(ids, method = 'order_move') {
    const order = method === 'order_smart' ? (SMART_ORDERS[this.smartAction] ?? 'move') : (METHOD_ORDERS[method] ?? 'move');
    this.smartAction = null;
    const u = this.ownUnit(ids);
    if (u) this.reply(u.type, u.kind, orderVoice(u.type, order));
  }

  /**
   * The selection changed. Like OpenRA, every selection the player makes with
   * own units in it gets a reply ("Reporting", "Yes sir"), from the first own
   * unit; VOICE_GAP keeps quick clicks from stacking. Units dropping out of the
   * selection (killed, boarded) stay silent.
   * @param {number[]} ids
   * @param {{ byPlayer?: boolean }} [info]
   */
  onSelection(ids, { byPlayer = true } = {}) {
    this.selection = new Set(ids);
    if (!byPlayer || !ids.length) return;
    const u = this.ownUnit(ids);
    if (u) this.reply(u.type, u.kind, 'select');
  }

  // ---- The sidebar (OpenRA ProductionPaletteWidget, SupportPowersWidget) ----------------

  /**
   * A production cameo was clicked (OpenRA ProductionPaletteWidget): the
   * ClickSound, and the queue's speech for `outcome`: 'queued', 'blocked'
   * (NoBuild), 'limited' (BuildingInProgress), 'resumed' (the queued line
   * again), 'onHold', 'cancelled'; null for a click without speech (OpenRA
   * speaks on a new item only when the queue was empty).
   * @param {string} actorId
   * @param {string | null} outcome
   */
  onProductionClick(actorId, outcome) {
    this.notify('ClickSound');
    const a = this.rules.actors.find((x) => x.id === actorId);
    if (!a || !outcome) return;
    const what = outcome === 'resumed' ? 'queued' : outcome;
    this.announce(queueLine(a.queue ?? 0, what));
  }

  /** A ready support power was picked (OpenRA SupportPowerInstance.Target): its SelectTarget line. */
  onSelectTarget(power) {
    this.announce(this.powerRules(power).selectTargetLine);
  }

  /** A support power without a powered provider was clicked (OpenRA SupportPowersWidget.ClickIcon). */
  onInsufficientPower(power) {
    this.notify('ClickSound');
    this.announce(this.powerRules(power).insufficientPowerLine);
  }

  /** Notifications of a power from `player_json().powers` ({ key, kind }) or a key. */
  powerRules(power) {
    const key = typeof power === 'string' ? power : power?.key;
    const provider = this.rules.actors.find((a) => a.powers?.includes(key));
    return powerNotifications(provider?.id, key);
  }

  /** A mission silences (true) or allows again (false) the local player's low power line (mission_state `lowPowerQuiet`). */
  setLowPowerQuiet(quiet) {
    this.lowPowerQuiet = !!quiet;
  }

  /** The game ended for the local player (OpenRA MissionObjectives Win/LoseNotification). */
  onGameOver(won) {
    // Said at once (OpenRA plays it as the game ends), also while the end of
    // game dialog stands the game still: not one of the simulation's lines the
    // announcer holds during a pause. Once: the end of game flow reports each
    // outcome once, and the line's cooldown covers a repeat.
    this.announce(won ? PLAYER_LINES.win : PLAYER_LINES.lose);
  }

  /**
   * Player state (Game.player_json), polled by the UI: OpenRA PowerManager's
   * low power line (at once when power gets low, then every AdviceInterval
   * while it stays low) and ResourceStorageWarning (every AdviceInterval,
   * when the stored ore is above Threshold percent of the silo capacity).
   *
   * OpenRA checks both in ITick, so neither can play while the world is
   * paused. Here the intervals count the state's simulation ticks (`tick`)
   * instead of the page clock: the UI polls the state also while the game
   * stands still (pause, the game menu, a hidden tab), and the same tick
   * polled again is no time passing. After a pause the cadence goes on
   * where it stopped. (OpenRA measures the interval itself in Game.RunTime,
   * which goes on during a pause, so its first check after a long pause
   * comes at once; counting ticks keeps the advice as far apart in game
   * time as while playing.)
   * @param {{ tick: number, lowPower?: boolean, resources?: number, storage?: number }} state
   */
  onPlayerState(state) {
    const tick = state.tick ?? 0;
    // Back in time (a replay seek, a restart): the intervals count from here.
    if (this.stateTick !== null && tick < this.stateTick) {
      if (this.lowPowerAt > tick) this.lowPowerAt = tick;
      if (this.silosAt !== null) this.silosAt = tick;
    }
    this.stateTick = tick;
    this.inWorld(() => {
      const low = !!state.lowPower;
      // Power just got low: the line is due at once (OpenRA UpdatePowerState), also
      // when a mission keeps it quiet now and allows it later while power stays low.
      if (this.lowPower === false && low) this.lowPowerAt = -Infinity;
      if (this.lowPower === null && low) this.lowPowerAt = tick;
      // OpenRA PowerManager.Tick: PlayLowPowerNotification && isLowPower && the interval passed.
      if (this.lowPower !== null && low && !this.lowPowerQuiet && tick - this.lowPowerAt >= this.ticksIn(PLAYER_LINES.lowPowerInterval)) {
        this.lowPowerAt = tick;
        this.announce(PLAYER_LINES.lowPower);
      }
      this.lowPower = low;
      if (this.silosAt === null) this.silosAt = tick;
      else if (tick - this.silosAt > this.ticksIn(PLAYER_LINES.silosInterval)) {
        this.silosAt = tick;
        const storage = state.storage ?? 0;
        if (storage > 0 && (state.resources ?? 0) > (PLAYER_LINES.silosThreshold * storage) / 100) this.announce(PLAYER_LINES.silos);
      }
    });
  }

  // ---- Engine events --------------------------------------------------------------

  /**
   * Handle a frame's engine events (flat, STRIDE per event) and play the
   * positional ones that can be heard in `view` (pixels).
   * @param {Int32Array | number[]} events
   * @param {{ x0: number, y0: number, x1: number, y1: number }} view
   * @param {(x: number, y: number) => boolean} [visible] whether the player can see a pixel position
   */
  onEvents(events, view, visible = () => true) {
    // The positional sounds of the events are the simulation's too (AudioSystem.defer).
    this.inWorld(() => {
      this.handleEvents(events, visible);
      this.flush(view);
    });
  }

  /** The announcer lines, replies and positional sounds of a frame's events (onEvents). */
  handleEvents(events, visible) {
    const k = this.pxPerWorld;
    this.crushed = [];
    for (let i = 0; i + STRIDE <= events.length; i += STRIDE) {
      const kind = events[i];
      const a = events[i + 1];
      const x = events[i + 2] * k;
      const y = events[i + 3] * k;
      const owner = events[i + 4];
      const b = events[i + 5];
      const own = owner === this.player;
      // A world sound: the player's own, or where the player can see.
      const heard = own || visible(x, y);
      switch (kind) {
        case EV.FIRE:
          if (heard) {
            this.queue(fireSound(this.rules.weapons[a]), x, y);
            // b: the shooter's type (the Tesla Coil's charge).
            this.queue(fireChargeSound(this.actor(b).id), x, y);
          }
          break;
        case EV.IMPACT:
          if (heard) this.queue(impactSound(this.rules.weapons[a], b === 1), x, y);
          break;
        case EV.DEATH: {
          const actor = this.actor(a);
          // b: kind code, the death sequence (die1..die6: infantry screams) in the bits above.
          const kindName = KINDS[b & 0xff] ?? actor.kind;
          const crush = this.crushed.findIndex((c) => c.ty === a && c.owner === owner);
          if (crush >= 0) this.crushed.splice(crush, 1);
          else if (heard) this.queue(deathSound(actor.id, kindName, b >> 8), x, y);
          // OpenRA ActorLostNotification (UnitLost, NavalUnitLost, AirUnitLost), to the owner.
          if (own) this.announce(lostLine(actor.id));
          break;
        }
        case EV.BUILDING_DAMAGED:
          // OpenRA DamageNotifier: speech to the owner, a text to the allies (not the attacker).
          if (own) this.announce(PLAYER_LINES.baseAttack);
          else if (this.player >= 0 && this.allied(owner) && b !== this.player) this.announce('allyUnderAttack');
          break;
        case EV.UNIT_PRODUCED:
          if (own) {
            this.announce(queueLine(this.actor(a).queue ?? 0, 'ready'));
            // VoiceAnnouncement (Tanya laughs as she leaves the barracks).
            const line = producedVoice(this.actor(a).id);
            if (line) this.reply(this.actor(a).id, this.actor(a).kind, line);
          }
          break;
        case EV.KILL_ANNOUNCED: {
          // AnnounceOnKill: Tanya's quip after a kill, to her owner.
          const line = own && killVoice(this.actor(a).id);
          if (line) this.reply(this.actor(a).id, this.actor(a).kind, line);
          break;
        }
        case EV.CONSTRUCTION_READY:
          if (own) this.announce(queueLine(this.actor(a).queue ?? 0, 'ready'));
          break;
        // OpenRA plays these with PlayToPlayer: only the owner hears them, at the actor's position.
        case EV.BUILDING_PLACED:
          if (own) this.queue(placeSound(this.actor(a).id), x, y);
          break;
        case EV.TRANSFORMED:
          if (own) for (const sound of transformSounds(this.actor(a).id)) this.queue(sound, x, y);
          break;
        case EV.DEPLOY_BLOCKED:
          if (own) {
            const blocked = deployBlocked(this.actor(a).id);
            if (blocked.sound) this.sink.effect(blocked.sound, { gain: 1, pan: 0 });
            if (blocked.announce) this.announce(blocked.announce);
          }
          break;
        case EV.SOLD:
          // b: -1 the sale starts (OpenRA Sellable.SellSounds at once), else
          // the refund when it is done after the reverse make animation (the
          // Sell activity's Notification).
          if (own) {
            if (b < 0) this.queue(sellSound(this.actor(a).id), x, y);
            else this.announce(speechKey(actorSounds(this.actor(a).id).sellNotification ?? 'StructureSold'));
          }
          break;
        case EV.INSUFFICIENT_FUNDS:
          if (own) this.announce(PLAYER_LINES.funds);
          break;
        // Sidebar buttons (engine/src/repair.rs, beacons.rs): OpenRA plays these as notifications, not in the world.
        case EV.REPAIR_STARTED:
          if (own) this.announce(speechKey(actorSounds(this.actor(a).id).repairing ?? 'Repairing'));
          break;
        case EV.POWER_TOGGLED:
          if (own) this.notify(b === 1 ? 'DisablePower' : 'EnablePower');
          break;
        case EV.BEACON_PLACED:
          if (this.player >= 0 && this.allied(owner)) this.notify('Beacon');
          break;
        case EV.POWER_ACTIVATED:
          this.powerActivated(a, b, x, y, owner, heard);
          break;
        // Support power timers (OpenRA SupportPower.Charging and Charged), to the owner.
        case EV.POWER_CHARGING:
        case EV.POWER_READY:
          if (own) {
            const p = powerNotifications(this.actor(a).id, this.actor(a).powers?.[b]);
            this.announce(kind === EV.POWER_CHARGING ? p.beginChargeLine : p.endChargeLine);
          }
          break;
        case EV.REINFORCEMENTS_ARRIVED:
          if (own) this.announce(powerNotifications(this.actor(a).id, this.actor(a).powers?.[b]).reinforcementsLine);
          break;
        case EV.PRODUCTION_CANCELLED:
          if (own) this.announce(queueLine(this.actor(a).queue ?? 0, 'cancelled'));
          break;
        case EV.PRODUCTION_BLOCKED:
          if (own) this.announce(queueLine(this.actor(a).queue ?? 0, 'blocked'));
          break;
        case EV.UNIT_REPAIR_STARTED:
        case EV.UNIT_REPAIRED:
          if (own) {
            const lines = repairLines(this.actor(b).id);
            this.announce(kind === EV.UNIT_REPAIR_STARTED ? lines.start : lines.finish);
          }
          break;
        case EV.LEVEL_UP:
          if (own) {
            const l = levelUp(this.actor(a).id);
            if (l) {
              this.notify(l.sound);
              if (l.text) this.announce(l.text);
            }
          }
          break;
        case EV.CRUSHED: {
          const sound = crushSound(this.actor(a).id);
          this.crushed.push({ ty: a, owner });
          if (sound && (heard || owner === this.player || b === this.player)) this.queue(sound, x, y);
          break;
        }
        case EV.DAMAGE_HEAVY: {
          const sound = damagedSound(this.actor(a).id);
          if (sound && heard) this.queue(sound, x, y);
          break;
        }
        case EV.CLOAK_CHANGED: {
          const sound = cloakSound(this.actor(a).id, b === 1);
          if (sound && heard) this.queue(sound, x, y);
          break;
        }
        case EV.PARA_DROP: {
          const sound = chuteSound(this.actor(a).id);
          if (sound && heard) this.queue(sound, x, y);
          break;
        }
        case EV.PILOT_EJECTED: {
          const sound = ejectChuteSound(this.actor(a).id);
          if (sound && heard) this.queue(sound, x, y);
          break;
        }
        case EV.PARACHUTE_IMPACT: {
          const sound = paraImpactSound(this.actor(a).id, b === 1);
          if (sound && heard) this.queue(sound, x, y);
          break;
        }
        case EV.REARMED: {
          // OpenRA Rearmable: PlayToPlayer, the owner only.
          const sound = rearmSound(this.actor(a).id);
          if (sound && own) this.queue(sound, x, y);
          break;
        }
        case EV.NEW_OPTIONS:
          if (own) this.announce(PLAYER_LINES.newOptions);
          break;
        case EV.PRIMARY_BUILDING_SELECTED:
          if (own) this.announce(primaryLine(this.actor(a).id));
          break;
        case EV.CAPTURED: {
          const lines = captureLines(this.actor(a).id);
          if (own) this.announce(lines.gained);
          else if (b === this.player) this.announce(lines.lost);
          break;
        }
        case EV.INFILTRATED: {
          const lines = infiltrationLines(this.actor(a).id, this.actor(b >> 8).id);
          if ((b & 0xff) === this.player) for (const key of lines.infiltrator) this.announce(key);
          if (own) for (const key of lines.target) this.announce(key);
          break;
        }
        case EV.TIME_LIMIT_WARNING:
          // OpenRA TimeLimitManager: to everyone, spectators too.
          if (owner === ALL_PLAYERS || own) this.announce(timeLimitLine(a));
          break;
        // World sounds of OpenRA's MadTank and Teleport (Game.Sound.Play at the actor).
        case EV.MAD_TANK:
          if (heard) for (const sound of madTankSounds(this.actor(a).id, b === 1)) this.queue(sound, x, y);
          break;
        case EV.TELEPORTED:
          if (heard) this.queue(teleportSound(this.actor(a).id, b === 1), x, y);
          break;
        case EV.LIGHTNING_STRIKE:
          // The thunder follows the flash (js/weather-fx.js); the owner of a struck power plant hears why the lights went out.
          if (own && b === 3) this.announce('lightningOutage');
          break;
        case EV.CRATE_COLLECTED:
          if (own) {
            const c = crateSounds(a);
            if (c.sound) this.queue(c.sound, x, y);
            this.announce(c.line);
          }
          break;
        default:
          break;
      }
    }
  }

  /**
   * A support power fired (OpenRA SupportPower.PlayLaunchSounds): its
   * Launch speech and sound for the owner's allies, Incoming for everyone
   * else (spectators hear neither), and the sound where it strikes.
   */
  powerActivated(code, ref, x, y, owner, heard) {
    const provider = this.actor(ref >> 8);
    const p = powerNotifications(provider.id, provider.powers?.[ref & 0xff]);
    const own = owner === this.player;
    if (this.player >= 0) {
      const allied = own || this.allied(owner);
      this.announce(allied ? p.launchLine : p.incomingLine);
      const ui = allied ? p.launchSound : p.incomingSound;
      if (ui) this.sink.effect({ synth: null, originals: [`${ui}.aud`] }, { gain: 1, pan: 0 });
    }
    const sound = powerSound(code, p);
    if (POWER_KINDS[code] === 'NukePower') {
      // Our own launch rumble: the silo is the player's (OpenRA plays no launch sound for RA's nuke).
      if (own) this.sink.effect(sound, { gain: 0.9, pan: 0 });
    } else if (heard) {
      this.queue(sound, x, y);
    }
  }

  queue(sound, x, y) {
    if (!sound || (!sound.synth && sound.originals.length === 0)) return;
    this.batch.push({ sound, x, y });
  }

  /** Play this frame's positional effects within the budget. */
  flush(view) {
    const batch = this.batch;
    this.batch = [];
    if (!batch.length) return;
    const groups = new Map();
    for (const e of batch) {
      const key = soundKey(e.sound);
      const at = spatial(e.x, e.y, view, REACH[e.sound.synth] ?? 1);
      if (!at) continue;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { key, sound: e.sound, hits: [] }));
      g.hits.push(at);
    }
    const t = this.now();
    const starts = [];
    for (const g of groups.values()) {
      if (t - (this.lastStart.get(g.key) ?? -Infinity) < SAME_SOUND_GAP) continue;
      g.hits.sort((p, q) => q.gain - p.gain);
      // Many of the same at once sound fuller, not N times louder.
      const boost = Math.min(1.5, 1 + 0.12 * Math.log2(g.hits.length));
      const weight = WEIGHT[g.sound.synth] ?? 1;
      for (const h of g.hits.slice(0, MAX_SAME_PER_FRAME)) {
        starts.push({ key: g.key, sound: g.sound, gain: Math.min(1, h.gain * boost), pan: h.pan, priority: h.gain * weight });
      }
    }
    starts.sort((p, q) => q.priority - p.priority);
    for (const s of starts.slice(0, MAX_EFFECTS_PER_FRAME)) {
      this.lastStart.set(s.key, t);
      this.sink.effect(s.sound, { gain: s.gain, pan: s.pan, priority: s.priority });
    }
  }
}

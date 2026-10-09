// Decides what to play: turns the engine's audio events (sound_events.rs) and
// the client's own moments (orders, selection, production clicks, player
// state) into effects, unit replies and announcer lines, with throttling,
// positional culling and a per-frame voice budget so a battle of thousands of
// units stays a soundscape instead of a wall of noise.
//
// No Web Audio here: the director talks to a `sink` and reads a clock, so the
// rules are unit tested in Node (tests/audio.test.mjs).

import { fireSound, impactSound, deathSound, placeSound, sellSound, transformSounds, deployBlocked, powerSound, voiceLine, KINDS, EVA, powerReadyLine, POWER_KINDS, BUTTON_SOUNDS } from './catalog.js';

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
};
export const STRIDE = 6;

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
  explosion_small: 1.4,
  cannon: 1.4,
  tesla: 1.4,
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
  const hw = Math.max(1, (view.x1 - view.x0) / 2);
  const hh = Math.max(1, (view.y1 - view.y0) / 2);
  const dx = (x - (view.x0 + hw)) / hw;
  const dy = (y - (view.y0 + hh)) / hh;
  const d = Math.max(Math.abs(dx), Math.abs(dy)) / reach;
  if (d > CULL_DISTANCE) return null;
  const gain = d <= 0.7 ? 1 : Math.max(0, 1 - (d - 0.7) / (CULL_DISTANCE - 0.7));
  if (gain <= 0.01) return null;
  return { gain, pan: Math.max(-1, Math.min(1, dx)) * 0.75 };
}

/** Key identifying "the same sound" for aggregation. */
const soundKey = (s) => s.synth ?? s.originals[0] ?? '';

export class Director {
  /**
   * @param {object} o
   * @param {{ actors: { id: string, kind: string }[], weapons: string[] }} o.rules
   * @param {number} o.player local player index
   * @param {'allies' | 'soviet'} o.side local player's side (voice variants)
   * @param {number} o.pxPerWorld pixels per world unit
   * @param {(id: number) => { type: string, owner: number, building: boolean } | null} o.lookup actor info by id
   * @param {{ effect(sound, opts): void, voice(line): void, announce(key): void }} o.sink
   * @param {() => number} o.now seconds
   * @param {(owner: number) => boolean} [o.allied] whether a player is the local one or an ally (beacons)
   */
  constructor({ rules, player, side, pxPerWorld, lookup, sink, now, allied = (owner) => owner === player }) {
    this.allied = allied;
    this.rules = rules;
    this.player = player;
    this.side = side;
    this.pxPerWorld = pxPerWorld;
    this.lookup = lookup;
    this.sink = sink;
    this.now = now;
    this.batch = [];
    this.lastStart = new Map();
    this.lastVoice = -Infinity;
    this.lastEva = new Map();
    this.selection = new Set();
    this.lowPower = null;
    this.powersReady = null;
  }

  actor(ty) {
    return this.rules.actors[ty] ?? { id: '', kind: 'vehicle' };
  }

  // ---- Announcer -------------------------------------------------------------

  /** Queue an announcer line unless the same one played within its cooldown. */
  announce(key) {
    const line = EVA[key];
    if (!line) return false;
    const t = this.now();
    if (t - (this.lastEva.get(key) ?? -Infinity) < line.cooldown) return false;
    this.lastEva.set(key, t);
    this.sink.announce(key);
    return true;
  }

  // ---- Unit replies ------------------------------------------------------------

  reply(actorType, kind, line) {
    const t = this.now();
    if (t - this.lastVoice < VOICE_GAP) return false;
    this.lastVoice = t;
    this.sink.voice(voiceLine(actorType, kind, this.side, line));
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

  /** A local order was given to `ids` (move, attack, ...): one reply per order. */
  onOrder(ids) {
    const u = this.ownUnit(ids);
    if (u) this.reply(u.type, u.kind, 'action');
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

  onProductionStarted(actorId) {
    const a = this.rules.actors.find((x) => x.id === actorId);
    if (a) this.announce(a.kind === 'infantry' ? 'training' : 'building');
  }

  onProductionCancelled() {
    this.announce('cancelled');
  }

  onSelectTarget() {
    this.announce('selectTarget');
  }

  onGameOver(won) {
    this.announce(won ? 'missionAccomplished' : 'missionFailed');
  }

  /** Player state (Game.player_json), polled by the UI: low power and power readiness edges. */
  onPlayerState(state) {
    const low = !!state.lowPower;
    if (this.lowPower === false && low) this.announce('lowPower');
    this.lowPower = low;
    const ready = new Map((state.powers ?? []).map((p) => [p.key, p]));
    if (this.powersReady) {
      for (const [key, p] of ready) if (p.ready && !this.powersReady.has(key)) this.announce(powerReadyLine(p.kind));
    }
    this.powersReady = new Set([...ready.values()].filter((p) => p.ready).map((p) => p.key));
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
    const k = this.pxPerWorld;
    for (let i = 0; i + STRIDE <= events.length; i += STRIDE) {
      const kind = events[i];
      const a = events[i + 1];
      const x = events[i + 2] * k;
      const y = events[i + 3] * k;
      const owner = events[i + 4];
      const b = events[i + 5];
      const own = owner === this.player;
      switch (kind) {
        case EV.FIRE:
          if (own || visible(x, y)) this.queue(fireSound(this.rules.weapons[a]), x, y);
          break;
        case EV.IMPACT:
          if (own || visible(x, y)) this.queue(impactSound(this.rules.weapons[a], b === 1), x, y);
          break;
        case EV.DEATH: {
          const actor = this.actor(a);
          const kindName = KINDS[b] ?? actor.kind;
          if (own || visible(x, y)) this.queue(deathSound(actor.id, kindName), x, y);
          if (own && kindName !== 'building' && kindName !== 'mine') this.announce('unitLost');
          break;
        }
        case EV.BUILDING_DAMAGED:
          if (own) this.announce('baseUnderAttack');
          break;
        case EV.UNIT_PRODUCED:
          if (own) this.announce('unitReady');
          break;
        case EV.CONSTRUCTION_READY:
          if (own) this.announce('constructionComplete');
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
          if (own) {
            this.announce('structureSold');
            this.queue(sellSound(this.actor(a).id), x, y);
          }
          break;
        case EV.INSUFFICIENT_FUNDS:
          if (own) this.announce('insufficientFunds');
          break;
        // Sidebar buttons (engine/src/repair.rs, beacons.rs): OpenRA plays these as notifications, not in the world.
        case EV.REPAIR_STARTED:
          if (own) this.announce('repairing');
          break;
        case EV.POWER_TOGGLED:
          if (own) this.sink.effect(b === 1 ? BUTTON_SOUNDS.powerDown : BUTTON_SOUNDS.powerUp, { gain: 0.8, pan: 0 });
          break;
        case EV.BEACON_PLACED:
          if (this.allied(owner)) this.sink.effect(BUTTON_SOUNDS.beacon, { gain: 0.8, pan: 0 });
          break;
        case EV.POWER_ACTIVATED: {
          const sound = powerSound(a);
          if (POWER_KINDS[a] === 'NukePower') {
            if (own) this.sink.effect(sound, { gain: 0.9, pan: 0 });
            else this.announce('nukeLaunched');
          } else if (own || visible(x, y)) {
            this.queue(sound, x, y);
          }
          break;
        }
        default:
          break;
      }
    }
    this.flush(view);
  }

  queue(sound, x, y) {
    if (!sound.synth && sound.originals.length === 0) return;
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

// Replays and saves (docs/contracts.md, section 7): recording order frames,
// playing them back, and loading a save by re-simulating it. No DOM here, so
// it runs headless in the tests with the real engine.
//
// Every game runs the engine in lockstep mode, also single player: local
// orders go to the engine's outbox, the driver takes them each tick, applies
// them as a frame for the local player and records that frame. A replay is
// the start settings plus those frames; playing it back feeds the frames into
// a fresh game at the same ticks. The recorder notes the state hash every
// REPLAY_HASH_INTERVAL ticks, so playback (and loading a save) can tell when
// the simulation no longer matches the recording.

import { packOrders, splitOrders } from './net.js';
import {
  encodeReplay,
  REPLAY_FORMAT,
  REPLAY_HASH_INTERVAL,
  REPLAY_MAX_BYTES,
  REPLAY_MAX_TICKS,
  REPLAY_VERSION,
  validOrder,
} from './protocol.js';

export const TICKS_PER_SECOND = 25;
/** Wall time per animation frame spent fast-forwarding (loading, seeking). */
export const FAST_FORWARD_BUDGET_MS = 40;
/**
 * Replay playback speeds. OpenRA's replay speed hotkeys: Slow (half), Regular,
 * Fast (double) and Maximum (the highest).
 */
export const REPLAY_SPEEDS = [0.5, 1, 2, 4, 8];
/** In-memory snapshots for seeking in a replay (keyframes). */
export const MAX_KEYFRAMES = 12;
export const KEYFRAME_TICKS = 1500;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** "m:ss" (or "h:mm:ss") for a tick count. */
export function formatTicks(ticks) {
  const secs = Math.floor(ticks / TICKS_PER_SECOND);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = String(secs % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** A file name for a replay or save: letters, digits and dashes. */
export function recordFileName(replay, kind = replay.kind) {
  const date = new Date(replay.createdAt).toISOString().slice(0, 16).replace(/[T:]/g, '-');
  const title = replay.title.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'game';
  return `webra-${kind}-${title}-${date}.json`;
}

/** Why a replay cannot be played on this engine build, or null. */
export function engineMismatch(replay, version) {
  if (replay.engine === version) return null;
  const what = replay.kind === 'save' ? 'save' : 'replay';
  return `This ${what} was made with WebRA ${replay.engine}; this is WebRA ${version}. The simulation can differ between versions, so ${what}s only load in the version that made them.`;
}

/** A fresh game in lockstep mode from a replay's start settings. */
export function newGame(Game, replay) {
  const options = JSON.stringify(replay.options);
  const game = replay.map ? Game.from_map(replay.map, options) : Game.from_options(options);
  game.set_lockstep(true);
  return game;
}

/**
 * Collects a game's order frames and state hashes. Frames are the
 * `[[player, [order, ...]], ...]` lists the engine ran, by tick.
 */
export class Recorder {
  /**
   * @param {{ mode: 'skirmish' | 'online', options: object, map: string | null, mapHash: string | null,
   *   player: number | null, engine: string, title: string, createdAt?: number,
   *   frames?: Array<[number, any[]]>, hashes?: Array<[number, string]> }} start
   */
  constructor({ mode, options, map, mapHash, player, engine, title, createdAt = Date.now(), frames = [], hashes = [] }) {
    this.start = { mode, options, map, mapHash, player, engine, title, createdAt };
    this.frames = frames.slice();
    this.hashes = hashes.slice();
    this.bytes = (map ? map.length : 0) + JSON.stringify(frames).length;
    /** Too large or too long to keep recording (the game goes on). */
    this.full = false;
  }

  record(tick, orders) {
    if (this.full || orders.length === 0) return;
    const last = this.frames.at(-1);
    if (last && last[0] >= tick) return; // already recorded (catch-up after a reconnect)
    const size = JSON.stringify(orders).length + 16;
    if (this.bytes + size > REPLAY_MAX_BYTES - 64 * 1024 || tick >= REPLAY_MAX_TICKS) {
      this.full = true;
      return;
    }
    this.bytes += size;
    this.frames.push([tick, orders]);
  }

  noteHash(ticks, hash) {
    if (this.full || ticks % REPLAY_HASH_INTERVAL !== 0) return;
    const last = this.hashes.at(-1);
    if (last && last[0] >= ticks) return;
    this.hashes.push([ticks, hash]);
  }

  /** The replay (or save) object after `ticks` ticks. A save ends with the hash of its last tick. */
  build(kind, ticks, finalHash = null) {
    const ticksKept = Math.min(ticks, REPLAY_MAX_TICKS);
    const hashes = this.hashes.filter(([n]) => n <= ticksKept);
    if (kind === 'save') {
      if (finalHash === null) throw new Error('a save needs the state hash of its last tick');
      if (!hashes.length || hashes.at(-1)[0] !== ticksKept) hashes.push([ticksKept, finalHash]);
    }
    return {
      format: REPLAY_FORMAT,
      version: REPLAY_VERSION,
      kind,
      mode: this.start.mode,
      engine: this.start.engine,
      createdAt: this.start.createdAt,
      title: this.start.title,
      options: this.start.options,
      map: this.start.map,
      mapHash: this.start.mapHash,
      player: this.start.player,
      ticks: ticksKept,
      frames: this.frames.filter(([t]) => t < ticksKept),
      hashes,
    };
  }

  /** Validated JSON text (throws ProtocolError when something is off). */
  encode(kind, ticks, finalHash = null) {
    return encodeReplay(this.build(kind, ticks, finalHash));
  }
}

/**
 * Runs a game along recorded frames and checks the recorded state hashes.
 * `diverged` is the first tick count whose hash did not match, or null.
 */
export class FramePlayer {
  constructor(game, replay) {
    this.game = game;
    this.frames = new Map(replay.frames.map(([t, o]) => [t, JSON.stringify(o)]));
    this.hashes = new Map(replay.hashes);
    this.diverged = null;
  }

  get ticks() {
    return this.game.tick_count();
  }

  step() {
    const t = this.game.tick_count();
    const frame = this.frames.get(t);
    if (frame !== undefined) this.game.apply_frame(frame);
    this.game.tick();
    const h = this.hashes.get(t + 1);
    if (h !== undefined && this.diverged === null && this.game.state_hash() !== h) this.diverged = t + 1;
  }

  /** Run until `target` ticks or the budget is spent. Returns true when there. */
  runTo(target, budgetMs = FAST_FORWARD_BUDGET_MS) {
    const end = now() + budgetMs;
    let n = 0;
    while (this.game.tick_count() < target) {
      this.step();
      if ((++n & 7) === 0 && now() >= end) break;
    }
    return this.game.tick_count() >= target;
  }
}

/**
 * Single player and skirmish: runs the game tick by tick from the local
 * player's orders and records them. With `preload` (a save) it first
 * re-simulates the saved game (`load`) and checks its state hashes; the
 * recording then continues the save's.
 */
export class LocalDriver {
  /**
   * @param {*} game
   * @param {{ player: number, recorder?: Recorder | null, preload?: object | null }} opts
   */
  constructor(game, { player, recorder = null, preload = null }) {
    this.game = game;
    this.player = player;
    this.recorder = recorder;
    this.queue = [];
    this.preload = preload ? new FramePlayer(game, preload) : null;
    this.target = preload ? preload.ticks : 0;
    /** Why loading failed, or null. */
    this.error = null;
    game.set_lockstep(true);
  }

  /** Still re-simulating a save. */
  get loading() {
    return this.preload !== null && this.error === null;
  }

  progress() {
    return this.target > 0 ? Math.min(1, this.game.tick_count() / this.target) : 1;
  }

  /**
   * Fast-forward through the save within the budget. Returns true when done
   * (check `error`).
   */
  load(budgetMs = FAST_FORWARD_BUDGET_MS) {
    if (!this.preload) return true;
    if (!this.preload.runTo(this.target, budgetMs)) return false;
    if (this.preload.diverged !== null) {
      this.error = `This save does not load correctly: the game differs from the saved one at ${formatTicks(this.preload.diverged)}.`;
    }
    // Orders clicked while loading are not part of the game.
    this.game.take_orders();
    this.preload = null;
    return true;
  }

  /** One game tick with the local player's new orders. */
  tick() {
    if (this.loading) return;
    const t = this.game.tick_count();
    let local = [];
    try {
      local = JSON.parse(this.game.take_orders());
    } catch (err) {
      console.error('take_orders failed', err);
    }
    for (const o of splitOrders(local)) {
      try {
        this.queue.push(validOrder(o));
      } catch (err) {
        // The engine would skip it anyway; a replay must only hold valid orders.
        console.warn('Dropped an invalid order:', err.message);
      }
    }
    // The same per-tick limits as online, so every recorded frame is valid.
    const batch = packOrders(this.queue);
    if (batch.length > 0) {
      const frame = [[this.player, batch]];
      this.game.apply_frame(JSON.stringify(frame));
      this.recorder?.record(t, frame);
    }
    this.game.tick();
    const n = t + 1;
    if (this.recorder && n % REPLAY_HASH_INTERVAL === 0) this.recorder.noteHash(n, this.game.state_hash());
  }
}

/**
 * Replay viewer state: play, pause, speed, seek. Seeking backwards restores
 * the nearest earlier in-memory snapshot (or starts over) and re-simulates;
 * seeking runs within a time budget per animation frame (`seeking`).
 */
export class ReplayController {
  constructor(Game, replay, { keyframeTicks = KEYFRAME_TICKS, maxKeyframes = MAX_KEYFRAMES } = {}) {
    this.Game = Game;
    this.replay = replay;
    this.game = newGame(Game, replay);
    this.player = new FramePlayer(this.game, replay);
    this.length = replay.ticks;
    this.speed = 1;
    this.playing = true;
    this.acc = 0;
    /** Seek target (ticks) while seeking, else null. */
    this.target = null;
    this.keyframeTicks = keyframeTicks;
    this.maxKeyframes = maxKeyframes;
    /** [{ ticks, snap }] in tick order; tick 0 is the start. */
    this.keyframes = [{ ticks: 0, snap: this.game.snapshot() }];
  }

  get ticks() {
    return this.game.tick_count();
  }

  get ended() {
    return this.ticks >= this.length;
  }

  get seeking() {
    return this.target !== null;
  }

  get diverged() {
    return this.player.diverged;
  }

  setSpeed(speed) {
    if (REPLAY_SPEEDS.includes(speed)) this.speed = speed;
  }

  togglePlay() {
    if (this.ended) this.seek(0);
    this.playing = !this.playing || this.ended;
  }

  /** Start seeking to `ticks` (0..length). */
  seek(ticks) {
    const target = Math.max(0, Math.min(this.length, Math.round(ticks)));
    let best = this.keyframes[0];
    for (const k of this.keyframes) if (k.ticks <= target) best = k;
    // Backwards: from the nearest earlier snapshot. Forwards: skip ahead when a snapshot is closer.
    if (target < this.ticks || best.ticks > this.ticks) {
      this.game.restore(best.snap);
      // Hash checks run again from the restored point.
      if (this.player.diverged !== null && this.player.diverged > best.ticks) this.player.diverged = null;
    }
    this.target = target;
    this.acc = 0;
  }

  /** Run one replay tick and keep a keyframe now and then. */
  step() {
    this.player.step();
    const t = this.ticks;
    if (t % this.keyframeTicks === 0 && !this.keyframes.some((k) => k.ticks === t)) this.addKeyframe(t);
  }

  addKeyframe(t) {
    const i = this.keyframes.findIndex((k) => k.ticks > t);
    const entry = { ticks: t, snap: this.game.snapshot() };
    if (i < 0) this.keyframes.push(entry);
    else this.keyframes.splice(i, 0, entry);
    if (this.keyframes.length > this.maxKeyframes) {
      // Thin out: keep the start and every other keyframe, then space them further apart.
      const keep = this.keyframes.filter((k, j) => j === 0 || j % 2 === 0);
      for (const k of this.keyframes) if (!keep.includes(k)) k.snap.free?.();
      this.keyframes = keep;
      this.keyframeTicks *= 2;
    }
  }

  /**
   * Advance by `dtMs` of wall time at `tickMs` per tick and the current
   * speed. Returns { ticks, alpha } like the other drivers.
   */
  advance(dtMs, tickMs) {
    // Orders clicked in the viewer (the debug menu) never reach a replay.
    this.game.take_orders();
    if (this.seeking) {
      const end = now() + FAST_FORWARD_BUDGET_MS;
      let n = 0;
      while (this.ticks < this.target) {
        this.step();
        if ((++n & 7) === 0 && now() >= end) break;
      }
      if (this.ticks >= this.target) this.target = null;
      return { ticks: n, alpha: 1 };
    }
    if (!this.playing || this.ended) {
      if (this.ended) this.playing = false;
      return { ticks: 0, alpha: 1 };
    }
    this.acc += dtMs * this.speed;
    let ticks = 0;
    const max = 8 * this.speed;
    while (this.acc >= tickMs && ticks < max && !this.ended) {
      this.step();
      this.acc -= tickMs;
      ticks++;
    }
    if (ticks === max) this.acc = 0;
    return { ticks, alpha: Math.min(1, this.acc / tickMs) };
  }

  dispose() {
    for (const k of this.keyframes) k.snap.free?.();
    this.keyframes = [];
  }
}

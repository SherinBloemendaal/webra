// Lockstep relay (pure, no I/O). The server never simulates: it collects each
// active player's orders for tick T and emits frame T once every active player
// delivered. Frames 0..delay-1 are empty and sent right at start, so a client
// running tick T sends its orders for T + delay.
//
// Invariants:
// - every player submits ticks strictly in order, starting at `delay`;
// - a player may not run ahead of the last emitted frame by more than `delay`;
// - orders are stamped with the sender's player index (never trusted);
// - dropping a player discards their undelivered orders and may complete frames.

import { HASH_INTERVAL, TICKS_PER_SECOND } from '@webra/protocol';

/**
 * Each player gets a window that renews whenever this many frames went out
 * since it began (one second of game time at normal speed). A player who,
 * within one window, held the game up for longer than the drop limit in
 * total is reported by `silent`. With a 10 s limit a single slow player can
 * therefore keep the game at about 2.5 ticks per second (10 percent of normal
 * speed) without being dropped: that floor is deliberate, so honest slow
 * machines and hiccups survive.
 */
export const MIN_PROGRESS_FRAMES = TICKS_PER_SECOND;

export class LockstepError extends Error {
  constructor(message, code = 'invalid') {
    super(message);
    this.code = code;
  }
}

export class Lockstep {
  /**
   * @param {{ players: number[], delay: number, now?: number }} config
   *   players: game player indices controlled by connected humans
   */
  constructor({ players, delay, now = Date.now() }) {
    this.delay = delay;
    /** Next frame tick to emit. */
    this.next = 0;
    this.active = new Set(players);
    /** Next tick each player must submit. */
    this.expected = new Map(players.map((p) => [p, delay]));
    /**
     * Drop window per player: `frame` is the value of `next` when it began,
     * `heldMs` how long the player held the game up (did not deliver frame
     * `next`) since then, `since` when the current hold began (null while the
     * player is ahead). Going ahead pauses the clock but never resets it, so
     * players cannot take turns holding the game up.
     */
    this.windows = new Map(players.map((p) => [p, { frame: delay, heldMs: 0, since: now }]));
    /** tick -> Map(player -> orders) */
    this.pending = new Map();
    /** tick -> Map(player -> hash) */
    this.hashes = new Map();
    /** Players already told that their game diverged from the majority. */
    this.diverged = new Set();
    this.lastHashTick = new Map(players.map((p) => [p, -1]));
    /** First tick with mismatching hashes, or null. */
    this.desyncTick = null;
  }

  /** The empty frames 0..delay-1 every client needs before its first tick. */
  initialFrames() {
    const frames = [];
    while (this.next < this.delay) frames.push({ tick: this.next++, orders: [] });
    return frames;
  }

  isActive(player) {
    return this.active.has(player);
  }

  /**
   * Accept one player's orders for one tick. Returns the frames that became
   * complete (possibly none). Throws LockstepError on protocol violations.
   */
  submit(player, tick, orders, now = Date.now()) {
    if (!this.active.has(player)) throw new LockstepError('you are not an active player', 'bad_state');
    const expected = this.expected.get(player);
    if (tick !== expected) throw new LockstepError(`orders for tick ${expected} expected`);
    if (tick > this.next + this.delay) throw new LockstepError('orders are too far ahead');
    this.expected.set(player, tick + 1);
    let byPlayer = this.pending.get(tick);
    if (!byPlayer) {
      byPlayer = new Map();
      this.pending.set(tick, byPlayer);
    }
    // Server stamp: the sender's index wins over anything in the order.
    byPlayer.set(
      player,
      orders.map((o) => ({ ...o, player })),
    );
    const frames = this.flush();
    this.track(now);
    return frames;
  }

  /** Emit every frame that all active players have delivered. */
  flush() {
    const frames = [];
    while (this.active.size > 0) {
      const byPlayer = this.pending.get(this.next);
      const complete = byPlayer && [...this.active].every((p) => byPlayer.has(p));
      if (!complete) break;
      const orders = [...this.active]
        .sort((a, b) => a - b)
        .filter((p) => byPlayer.get(p).length > 0)
        .map((p) => [p, byPlayer.get(p)]);
      frames.push({ tick: this.next, orders });
      this.pending.delete(this.next);
      this.next++;
    }
    return frames;
  }

  /** Remove a player (left, dropped or kicked). Returns frames that became complete. */
  drop(player, now = Date.now()) {
    if (!this.active.delete(player)) return [];
    this.expected.delete(player);
    this.windows.delete(player);
    this.lastHashTick.delete(player);
    for (const byPlayer of this.pending.values()) byPlayer.delete(player);
    for (const byTick of this.hashes.values()) byTick.delete(player);
    const frames = this.flush();
    this.track(now);
    return frames;
  }

  /** Bring the drop windows (see `windows`) up to `now`. */
  track(now) {
    for (const p of this.active) {
      const w = this.windows.get(p);
      const holding = this.expected.get(p) <= this.next;
      if (this.next - w.frame >= MIN_PROGRESS_FRAMES) {
        // Enough frames went out: a fresh window.
        w.frame = this.next;
        w.heldMs = 0;
        w.since = holding ? now : null;
      } else if (holding && w.since === null) {
        w.since = now;
      } else if (!holding && w.since !== null) {
        w.heldMs += now - w.since;
        w.since = null;
      }
    }
  }

  /**
   * Players to drop: holding the game up right now, and, within a window in
   * which fewer than MIN_PROGRESS_FRAMES frames went out, for longer than
   * `limitMs` in total. Sending a tick now and then does not reset that, and
   * neither does taking turns with another player (a client sending one tick
   * every 9 s, or two seats alternating, used to stall a game forever).
   */
  silent(now, limitMs) {
    this.track(now);
    const out = [];
    for (const [p, w] of this.windows) {
      if (w.since !== null && w.heldMs + (now - w.since) > limitMs) out.push(p);
    }
    return out;
  }

  /**
   * Record a state hash a player computed after running `tick`. Once every
   * active player reported for that tick, compare: when a strict majority
   * agrees, only the players outside it diverged (or lied); without a
   * majority (e.g. 1 against 1) nobody can tell who is right, so everyone is
   * told. Returns `{ tick, players }` to notify, or null. A single player can
   * therefore no longer raise a false alarm for the whole game.
   */
  hash(player, tick, hash) {
    if (!this.active.has(player)) throw new LockstepError('you are not an active player', 'bad_state');
    if (tick % HASH_INTERVAL !== 0) throw new LockstepError('bad hash tick');
    if (tick >= this.next) throw new LockstepError('hash for a tick that has not been sent');
    if (tick <= this.lastHashTick.get(player)) throw new LockstepError('hash ticks must increase');
    this.lastHashTick.set(player, tick);
    if (this.desyncTick !== null) return null;
    let byTick = this.hashes.get(tick);
    if (!byTick) {
      byTick = new Map();
      this.hashes.set(tick, byTick);
    }
    byTick.set(player, hash);
    // Players that stop reporting must not grow memory without bound.
    for (const t of this.hashes.keys()) if (t < this.next - 100 * HASH_INTERVAL) this.hashes.delete(t);
    if (![...this.active].every((p) => byTick.has(p))) return null;
    this.hashes.delete(tick);
    const groups = new Map();
    for (const [p, h] of byTick) {
      if (!this.active.has(p)) continue;
      if (!groups.has(h)) groups.set(h, []);
      groups.get(h).push(p);
    }
    if (groups.size <= 1) return null;
    const voters = [...groups.values()].reduce((n, g) => n + g.length, 0);
    const majority = [...groups.values()].find((g) => g.length * 2 > voters);
    if (majority) {
      const outliers = [...byTick.keys()].filter((p) => this.active.has(p) && !majority.includes(p) && !this.diverged.has(p));
      for (const p of outliers) this.diverged.add(p);
      return outliers.length ? { tick, players: outliers } : null;
    }
    this.desyncTick = tick;
    this.hashes.clear();
    return { tick, players: [...this.active] };
  }

  get finished() {
    return this.active.size === 0;
  }
}

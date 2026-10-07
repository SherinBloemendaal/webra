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

import { HASH_INTERVAL } from '@webra/protocol';

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
    this.lastSeen = new Map(players.map((p) => [p, now]));
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
    this.lastSeen.set(player, now);
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
    return this.flush();
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
  drop(player) {
    if (!this.active.delete(player)) return [];
    this.expected.delete(player);
    this.lastSeen.delete(player);
    this.lastHashTick.delete(player);
    for (const byPlayer of this.pending.values()) byPlayer.delete(player);
    for (const byTick of this.hashes.values()) byTick.delete(player);
    return this.flush();
  }

  /** Active players that sent no orders for longer than `limitMs`. */
  silent(now, limitMs) {
    return [...this.active].filter((p) => now - this.lastSeen.get(p) > limitMs);
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

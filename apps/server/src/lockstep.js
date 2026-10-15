// Lockstep relay (pure, no I/O). The server never simulates: it collects each
// active player's orders for tick T and emits frame T once every active player
// delivered. Frames 0..delay-1 are empty and sent right at start, so a client
// running tick T sends its orders for T + delay.
//
// Invariants:
// - every player submits ticks strictly in order, starting at `delay`;
// - a player may not run ahead of the last emitted frame by more than `delay`;
// - orders are stamped with the sender's player index (never trusted);
// - dropping a player discards their undelivered orders and may complete frames;
// - a defeated player (it said so: `defeat`) keeps its seat and its stall
//   rules, but its orders are dropped from then on (the engine refuses them
//   too, so a client that never says so still cannot act);
// - a suspended player (connection lost) is out of the game until it rejoins:
//   nobody waits for it meanwhile. It rejoins at a future tick (`rejoin`) with
//   the stall budget it left with (`suspend` returns it), never a fresh one;
// - the start gate: seats listed in `loading` have not closed their loading
//   screen yet (`loaded`). Until all of them did, no frame past the empty
//   start frames goes out and nothing counts toward a stall budget, the
//   waiting player or the stall log; a seat still loading LOAD_TIMEOUT_MS
//   after the start is reported by `silent` (dropped like a stalling one);
// - the stall log: every time a seat answered a frame later than
//   HOLD_GRACE_MS after it could have (`stalls`, `totals`), for the
//   statistics; `waiting` names the seat the game waits for right now.

import { HASH_INTERVAL, LOAD_TIMEOUT_MS, STALL_LOG_MAX, TICKS_PER_SECOND } from '@webra/protocol';

/**
 * Drop windows renew whenever this many frames went out since they began
 * (one second of game time at normal speed). A player who, within one
 * window, held the game up for longer than the drop limit in total is
 * reported by `silent`. With a 10 s limit a single slow player can therefore
 * keep the game at about 2.5 ticks per second (10 percent of normal speed)
 * without being dropped: that floor is deliberate, so honest slow machines
 * and hiccups survive. Several seats sharing a stall between them are caught
 * by the window's age instead (see `silent`).
 */
export const MIN_PROGRESS_FRAMES = TICKS_PER_SECOND;

/**
 * A client can only send its orders for tick T once it received frame
 * T - delay. Holding frame T within this long of that frame going out is a
 * round trip, not a stall, and is never counted against the player.
 */
export const HOLD_GRACE_MS = 1000;

/**
 * Hold time beyond the grace also goes into a per-player debt that drains
 * at this rate (milliseconds per millisecond, here 1 s every 20 s) and is
 * never reset by progress. A seat whose debt passes the drop limit is
 * dropped. One freeze (a GC pause, a tab switch, a wifi roam) of up to the
 * limit drains away; seats that stall over and over, alone or taking turns,
 * pile it up.
 */
export const DEBT_DRAIN = 1 / 20;

export class LockstepError extends Error {
  constructor(message, code = 'invalid') {
    super(message);
    this.code = code;
  }
}

export class Lockstep {
  /**
   * @param {{ players: number[], delay: number, now?: number, start?: number, loading?: number[] }} config
   *   players: game player indices controlled by connected humans;
   *   start: the first frame to emit (a resumed online save continues after its ticks);
   *   loading: players whose loading screen is still open (the start gate, see `loaded`)
   */
  constructor({ players, delay, now = Date.now(), start = 0, loading = [] }) {
    this.delay = delay;
    /** First frame of this relay (0, or the save point + 1 of a resumed game). */
    this.start = start;
    /** Next frame tick to emit. */
    this.next = start;
    this.active = new Set(players);
    /** Every seat the game started with. */
    this.seats = new Set(players);
    /** Next tick each player must submit. */
    this.expected = new Map(players.map((p) => [p, start + delay]));
    /** First tick each player's orders are part of (later for rejoined players). */
    this.joinTick = new Map(players.map((p) => [p, start]));
    /**
     * Drop window per player. `frame` is the value of `next` when it began,
     * `heldMs` how long the player held the game up in it (did not deliver
     * frame `next`, beyond HOLD_GRACE_MS after the frame it needed went out),
     * `at` until when that is counted (null while the player is ahead) and
     * `ready` when the grace for the frame it holds ends. Going ahead pauses
     * the count but never resets it, so players cannot take turns.
     */
    this.windows = new Map(
      players.map((p) => [p, { frame: start + delay, heldMs: 0, at: now, ready: now + HOLD_GRACE_MS, debtMs: 0, drainedAt: now }]),
    );
    /** tick -> when its frame went out, for the last few frames. */
    this.emitted = new Map();
    this.startedAt = now;
    /** tick -> Map(player -> orders) */
    this.pending = new Map();
    /** tick -> Map(player -> hash) */
    this.hashes = new Map();
    /** Players already told that their game diverged from the majority. */
    this.diverged = new Set();
    this.lastHashTick = new Map(players.map((p) => [p, start - 1]));
    /** First tick with mismatching hashes, or null. */
    this.desyncTick = null;
    /** Last state hash a strict majority of the players reported: { tick, hash } or null. */
    this.agreed = null;
    /** Seats that reported their defeat: their orders are dropped (kept across suspend and rejoin). */
    this.defeated = new Set();
    /** The start gate: seats that have not reported `loaded`, and until when they may take. */
    this.loading = new Set(loading.filter((p) => this.seats.has(p)));
    this.loadUntil = now + LOAD_TIMEOUT_MS;
    /** Seat -> the frame it holds right now: { tick, since } (since: when it could first send it). */
    this.stalling = new Map();
    /** The newest STALL_LOG_MAX waits beyond HOLD_GRACE_MS: { tick, seat, ms }, oldest first. */
    this.stalls = [];
    /** Seat -> { ms, count } of every such wait of this game. */
    this.totals = new Map();
  }

  /**
   * A player's loading screen closed. Once every seat that was loading did
   * (or was dropped), the game begins: the stall clocks start now. Returns
   * the frames that became complete. Repeats and unknown seats are ignored.
   */
  loaded(player, now = Date.now()) {
    if (!this.loading.delete(player)) return [];
    if (this.loading.size === 0) this.begin(now);
    const frames = this.flush(now);
    this.track(now);
    return frames;
  }

  /** Whether the start gate still holds the game. */
  get starting() {
    return this.loading.size > 0;
  }

  /** The start gate opened: every stall clock starts from `now`, as if the start frames went out now. */
  begin(now) {
    this.startedAt = now;
    for (const t of this.emitted.keys()) this.emitted.set(t, now);
    for (const w of this.windows.values()) {
      w.heldMs = 0;
      w.at = null;
      w.ready = now + HOLD_GRACE_MS;
      w.drainedAt = now;
    }
    this.stalling.clear();
  }

  /**
   * A player reports that the engine defeated it. It keeps running the game
   * (it watches, sends empty orders and hashes), but no order of it reaches a
   * frame again, including ones already waiting for a later frame. Returns
   * whether this was news.
   */
  defeat(player) {
    if (!this.seats.has(player)) {
      throw new LockstepError('not a player of this game', 'bad_state');
    }
    if (this.defeated.has(player)) return false;
    this.defeated.add(player);
    for (const byPlayer of this.pending.values()) if (byPlayer.has(player)) byPlayer.set(player, []);
    return true;
  }

  /** The empty frames start..start+delay-1 every client needs before its first tick. */
  initialFrames() {
    const frames = [];
    while (this.next < this.start + this.delay) {
      this.emitted.set(this.next, this.startedAt);
      frames.push({ tick: this.next++, orders: [] });
    }
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
    // Bring the clocks up to now first, so a hold that ends with this very delivery is seen.
    this.track(now);
    this.expected.set(player, tick + 1);
    let byPlayer = this.pending.get(tick);
    if (!byPlayer) {
      byPlayer = new Map();
      this.pending.set(tick, byPlayer);
    }
    // Server stamp: the sender's index wins over anything in the order.
    // A defeated player's orders never reach a frame.
    byPlayer.set(
      player,
      this.defeated.has(player) ? [] : orders.map((o) => ({ ...o, player })),
    );
    const frames = this.flush(now);
    this.track(now);
    return frames;
  }

  /** Emit every frame that all active players have delivered. */
  flush(now = Date.now()) {
    const frames = [];
    while (this.active.size > 0) {
      // The start gate: only the empty start frames until every seat loaded.
      if (this.loading.size > 0 && this.next >= this.start + this.delay) break;
      const byPlayer = this.pending.get(this.next) ?? new Map();
      // Rejoined players count from their join tick on.
      const due = [...this.active].filter((p) => this.joinTick.get(p) <= this.next);
      if (!due.every((p) => byPlayer.has(p))) break;
      const orders = due
        .sort((a, b) => a - b)
        .filter((p) => byPlayer.get(p).length > 0)
        .map((p) => [p, byPlayer.get(p)]);
      frames.push({ tick: this.next, orders });
      this.pending.delete(this.next);
      this.emitted.set(this.next, now);
      this.emitted.delete(this.next - this.delay - 1);
      this.next++;
    }
    return frames;
  }

  /** Remove a player (left, dropped or kicked). Returns frames that became complete. */
  drop(player, now = Date.now()) {
    return this.suspend(player, now).frames;
  }

  /**
   * Take a player out of the game (its connection was lost, or it stalled).
   * Returns the frames that became complete and `record`, the player's stall
   * budget to hand back to `rejoin` (null when it was not active).
   */
  suspend(player, now = Date.now()) {
    if (!this.active.has(player)) return { frames: [], record: null };
    // Count the hold time up to now before it leaves.
    this.track(now);
    const w = this.windows.get(player);
    const record = { frame: w.frame, heldMs: w.heldMs, debtMs: w.debtMs, drainedAt: w.drainedAt };
    // A wait that ends with the seat leaving is a stall too.
    const holding = this.stalling.get(player);
    if (holding) this.endStall(player, holding, now);
    this.stalling.delete(player);
    this.active.delete(player);
    this.expected.delete(player);
    this.joinTick.delete(player);
    this.windows.delete(player);
    this.lastHashTick.delete(player);
    for (const byPlayer of this.pending.values()) byPlayer.delete(player);
    for (const byTick of this.hashes.values()) byTick.delete(player);
    // The last seat still loading left: the others begin.
    if (this.loading.delete(player) && this.loading.size === 0) this.begin(now);
    const frames = this.flush(now);
    this.track(now);
    return { frames, record };
  }

  /**
   * Put a suspended player back into the game. Its orders count from the
   * returned tick on (`next + delay`: every other player may already have
   * sent orders up to there, and the client cannot send earlier ones). Its
   * stall budget is the `record` it left with: the debt keeps draining over
   * wall time like for everyone, and the current drop window's hold time is
   * kept when that window is still running.
   */
  rejoin(player, record, now = Date.now()) {
    if (this.active.has(player)) throw new LockstepError('already in the game', 'bad_state');
    this.track(now);
    const at = this.next + this.delay;
    const frame = this.windows.size > 0 ? [...this.windows.values()][0].frame : this.next;
    this.active.add(player);
    // A seat that missed the start of a resumed save joins the game's seats here.
    this.seats.add(player);
    this.expected.set(player, at);
    this.joinTick.set(player, at);
    this.lastHashTick.set(player, -1);
    this.windows.set(player, {
      frame,
      heldMs: record && record.frame === frame ? record.heldMs : 0,
      at: null,
      ready: now + HOLD_GRACE_MS,
      debtMs: record ? record.debtMs : 0,
      drainedAt: record ? Math.min(record.drainedAt, now) : now,
    });
    this.track(now);
    return at;
  }

  /** Bring the drop windows (see `windows`) and the stall log up to `now`. */
  track(now) {
    if (this.loading.size > 0) {
      // Waiting at the start costs nobody anything.
      for (const w of this.windows.values()) {
        w.drainedAt = now;
        w.at = null;
      }
      return;
    }
    // When the grace for holding frame `next` ends.
    const ready = (this.emitted.get(this.next - this.delay) ?? this.startedAt) + HOLD_GRACE_MS;
    const renew = [...this.windows.values()].some((w) => this.next - w.frame >= MIN_PROGRESS_FRAMES);
    for (const p of this.active) {
      const w = this.windows.get(p);
      w.debtMs = Math.max(0, w.debtMs - (now - w.drainedAt) * DEBT_DRAIN);
      w.drainedAt = now;
      if (w.at !== null) {
        const held = Math.max(0, now - Math.max(w.at, w.ready));
        w.heldMs += held;
        w.debtMs += held;
      }
      if (renew) {
        // Enough frames went out: a fresh window.
        w.frame = this.next;
        w.heldMs = 0;
      }
      const holding = this.expected.get(p) <= this.next;
      w.at = holding ? now : null;
      w.ready = ready;
      const cur = this.stalling.get(p);
      if (holding) {
        if (!cur || cur.tick !== this.next) {
          if (cur) this.endStall(p, cur, now);
          // The game waits for frame `next` from when the seat could send it (frame next - delay
          // went out) and the frame before it was out: a seat catching up after one long stall
          // does not log the frames behind it as stalls of their own.
          const could = this.emitted.get(this.next - this.delay) ?? this.startedAt;
          const prev = this.emitted.get(this.next - 1) ?? this.startedAt;
          this.stalling.set(p, { tick: this.next, since: Math.max(could, prev) });
        }
      } else if (cur) {
        this.endStall(p, cur, now);
        this.stalling.delete(p);
      }
    }
  }

  /** A seat answered the frame it held (or left): log the wait when it was longer than HOLD_GRACE_MS. */
  endStall(seat, hold, now) {
    const ms = Math.max(0, now - hold.since);
    if (ms <= HOLD_GRACE_MS) return;
    this.stalls.push({ tick: hold.tick, seat, ms });
    if (this.stalls.length > STALL_LOG_MAX) this.stalls.shift();
    const t = this.totals.get(seat) ?? { ms: 0, count: 0 };
    t.ms += ms;
    t.count++;
    this.totals.set(seat, t);
  }

  /**
   * The seat the game waits for right now, beyond HOLD_GRACE_MS: { seat,
   * heldMs (since it could have sent the frame and the frame before went out), dropInMs (until
   * `silent` reports it with this `limitMs`) }, the longest wait when several
   * seats hold; null while the game runs (or the start gate holds it).
   */
  waiting(now, limitMs) {
    if (this.loading.size > 0) return null;
    this.track(now);
    let best = null;
    for (const [seat, hold] of this.stalling) {
      const heldMs = now - hold.since;
      if (heldMs <= HOLD_GRACE_MS || (best && best.heldMs >= heldMs)) continue;
      const w = this.windows.get(seat);
      // Both the window's hold time and the debt grow while it holds (the debt minus its drain).
      const byWindow = limitMs - w.heldMs;
      const byDebt = (limitMs - w.debtMs) / (1 - DEBT_DRAIN);
      best = { seat, heldMs: Math.round(heldMs), dropInMs: Math.max(0, Math.ceil(Math.min(byWindow, byDebt))) };
    }
    return best;
  }

  /**
   * Players to drop: holding the game up right now, and, within a window in
   * which fewer than MIN_PROGRESS_FRAMES frames went out, for longer than
   * `limitMs` in total. Sending a tick now and then does not reset that, and
   * neither does taking turns with another player (a client sending one tick
   * every 9 s, or two seats alternating, used to stall a game forever).
   *
   * Several seats can each stay under the limit per window while handing the
   * stall on, so a seat whose debt (see DEBT_DRAIN) passes `limitMs` is
   * dropped as well. Only a seat's own hold time counts, never another's: a
   * griefer cannot time its stalls to get an honest seat with one freeze
   * dropped. Round trips are not counted (see HOLD_GRACE_MS).
   */
  silent(now, limitMs) {
    // The start gate: only seats that did not load in time.
    if (this.loading.size > 0) return now > this.loadUntil ? [...this.loading] : [];
    this.track(now);
    const out = [];
    for (const [p, w] of this.windows) {
      if ((w.at !== null && w.heldMs > limitMs) || w.debtMs > limitMs) out.push(p);
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
    if (tick < this.joinTick.get(player)) throw new LockstepError('hash for a tick before you rejoined');
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
    if (![...this.active].every((p) => this.joinTick.get(p) > tick || byTick.has(p))) return null;
    this.hashes.delete(tick);
    const groups = new Map();
    for (const [p, h] of byTick) {
      if (!this.active.has(p)) continue;
      if (!groups.has(h)) groups.set(h, []);
      groups.get(h).push(p);
    }
    const voters = [...groups.values()].reduce((n, g) => n + g.length, 0);
    const majority = [...groups.entries()].find(([, g]) => g.length * 2 > voters);
    // Rejoining clients check their fast-forwarded state against this.
    if (majority) this.agreed = { tick, hash: majority[0] };
    if (groups.size <= 1) return null;
    if (majority) {
      const outliers = [...byTick.keys()].filter((p) => this.active.has(p) && !majority[1].includes(p) && !this.diverged.has(p));
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

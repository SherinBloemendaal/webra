// Connection quality of an online session (docs/contracts.md section 4,
// "Network quality"): the data layer behind the lobby's Connection column,
// the signal bars and warnings in the game, the game menu's Network tab and
// the statistics' Network tab. No DOM here: screens subscribe to events.
//
// Measuring: every PING_INTERVAL_MS the client sends `ping { n, at }` with
// its own clock (`at`, whole milliseconds of performance.now) and the server
// echoes both in `pong`; the round trip is the difference, so no clock
// synchronization is needed. A pong slower than LATE_PING_MS, or one that
// never comes, is a late ping (WebSocket runs over TCP: nothing is lost
// visibly, late is what a player feels as stutter). Each ping carries the
// last measurement (median round trip and jitter over NET_SAMPLES pongs,
// late pings in percent over NET_LATE_WINDOW pings); the server shares
// everyone's in `netstat`, so every member sees every player.
//
//   const nq = new NetQuality();
//   nq.attach(conn, { you: welcome.you });   // after `welcome`, lobby or game
//   nq.on('players', (players) => ...);      // Map client -> PlayerNet
//   nq.on('self', (self) => ...);            // own measurement
//   nq.on('waiting', (w) => ...);            // { client, heldMs, dropInMs, at } or null
//   nq.beginGame();                          // start the per-player series (statistics)
//   const { stalls, totals } = await nq.requestStalls();
//   nq.detach();
//
// Single player and skirmish never create one.

import {
  C2S,
  jitterOf,
  LATE_PING_MS,
  latePercent,
  median,
  NET_LATE_WINDOW,
  NET_SAMPLES,
  netBars,
  netQuality,
  PING_INTERVAL_MS,
  S2C,
} from './protocol.js';

/** One point of a player's series per this long of game time (statistics: about 150 points for 24 minutes). */
export const SERIES_STEP_MS = 10_000;
/** Most points per series; beyond, neighbouring points merge and the step doubles, so the whole game fits. */
export const SERIES_MAX = 150;
/** "Test again": this many pings, this far apart. */
export const TEST_PINGS = 3;
export const TEST_PING_GAP_MS = 250;
/** A stall log request gives up after this long. */
export const STALLS_TIMEOUT_MS = 5000;

/** A minimal event emitter: `on` returns the function that unsubscribes. */
export class Emitter {
  constructor() {
    this.listeners = new Map();
  }

  on(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
    return () => this.listeners.get(type)?.delete(fn);
  }

  emit(type, value) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) {
      try {
        fn(value);
      } catch (err) {
        console.error(`${type} listener failed`, err);
      }
    }
  }
}

/**
 * The own measurement from pings and pongs (pure: the caller passes the
 * time). `sent` and `late` also count the whole session, for the statistics
 * ("1 of 726 took over a second").
 */
export class NetMeter {
  constructor() {
    /** n -> sent at (own clock), for pings without an answer yet. */
    this.pending = new Map();
    /** Pings already counted (answered or past their deadline): n -> true. */
    this.resolved = new Map();
    this.samples = [];
    /** The last NET_LATE_WINDOW resolved pings: true for late. */
    this.window = [];
    this.sent = 0;
    this.late = 0;
  }

  /** A ping went out. */
  noteSent(n, at) {
    this.pending.set(n, at);
    this.sent++;
  }

  resolve(n, late) {
    this.resolved.set(n, true);
    if (this.resolved.size > NET_LATE_WINDOW * 2) this.resolved.delete(this.resolved.keys().next().value);
    this.window.push(late);
    if (this.window.length > NET_LATE_WINDOW) this.window.shift();
    if (late) this.late++;
  }

  /**
   * A pong for `n` sent at `at` arrived at `now`. Returns the round trip, or
   * null for an unknown or repeated pong. A pong past its deadline still
   * gives a round trip (it was already counted late).
   */
  notePong(n, at, now) {
    const sentAt = this.pending.get(n);
    if (sentAt === undefined || sentAt !== at) return null;
    this.pending.delete(n);
    const rtt = Math.max(0, Math.round(now - at));
    this.samples.push(rtt);
    if (this.samples.length > NET_SAMPLES) this.samples.shift();
    if (!this.resolved.has(n)) this.resolve(n, rtt > LATE_PING_MS);
    return rtt;
  }

  /** Count pings still unanswered LATE_PING_MS after they went out as late. Returns whether any were. */
  expire(now) {
    let any = false;
    for (const [n, at] of this.pending) {
      if (now - at <= LATE_PING_MS) continue;
      if (!this.resolved.has(n)) {
        this.resolve(n, true);
        any = true;
      }
      // Kept a while longer for its (late) round trip; given up after a minute.
      if (now - at > 60_000) this.pending.delete(n);
    }
    return any;
  }

  /** `{ rtt, jitter, late }` (late in percent), or null before the first pong. */
  measurement() {
    if (this.samples.length === 0) return null;
    return {
      rtt: median(this.samples),
      jitter: jitterOf(this.samples),
      late: latePercent(this.window.filter(Boolean).length, this.window.length),
    };
  }
}

/** Running totals of one player's reports, for the statistics table. */
function emptyTotals() {
  return { reports: 0, rttSum: 0, worst: 0, worstAt: 0, jitterSum: 0, late: 0 };
}

/**
 * @typedef {{ client: number, rtt: number|null, jitter: number|null, late: number|null,
 *   silent: number|null, quality: 'good'|'fair'|'poor'|null, bars: number, you: boolean }} PlayerNet
 */

export class NetQuality extends Emitter {
  /**
   * @param {{ now?: () => number, wallNow?: () => number, timers?: { setInterval, clearInterval, setTimeout, clearTimeout }, intervalMs?: number }} [o]
   *   now: the clock pings are timed with (performance.now); wallNow: Date.now (series and `waiting.at`)
   */
  constructor({ now, wallNow, timers, intervalMs = PING_INTERVAL_MS } = {}) {
    super();
    this.now = now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this.wallNow = wallNow ?? (() => Date.now());
    this.timers = timers ?? globalThis;
    this.intervalMs = intervalMs;
    this.meter = new NetMeter();
    this.conn = null;
    this.you = null;
    this.n = 0;
    this.timer = null;
    /** @type {Map<number, PlayerNet>} */
    this.players = new Map();
    /** Whom the game waits for: { client, heldMs, dropInMs, at } (at: wall time it was said), or null. */
    this.waiting = null;
    /** Own quality and since when it is poor (wall time), for the "your connection" warning. */
    this.self = { rtt: null, jitter: null, late: null, quality: null, bars: 0, poorSince: null, sent: 0, latePings: 0 };
    /** client -> [{ t, rtt, worst, jitter, late }] (t: ms since beginGame). */
    this.series = new Map();
    this.totals = new Map();
    this.gameStart = null;
    this.step = SERIES_STEP_MS;
    /** client -> the bucket being filled: { t, n, rttSum, worst, jitterSum, late }. */
    this.buckets = new Map();
    this.stallWaiters = [];
    this.lastStalls = null;
  }

  /**
   * Listen to a session connection (net.js Connection; it must not have
   * other handlers for pong, netstat, waiting or stalls) and start pinging.
   * `you`: this member's client id (own entries are marked).
   */
  attach(conn, { you = null } = {}) {
    this.detach();
    this.conn = conn;
    this.you = you;
    conn.on(S2C.PONG, (m) => this.onPong(m));
    conn.on(S2C.NETSTAT, (m) => this.onNetstat(m));
    conn.on(S2C.WAITING, (m) => this.onWaiting(m));
    conn.on(S2C.STALLS, (m) => this.onStalls(m));
    this.pingNow();
    this.timer = this.timers.setInterval(() => this.pingNow(), this.intervalMs);
    return this;
  }

  /** Stop pinging (the connection closed or the screen left). Collected data stays for the statistics. */
  detach() {
    if (this.timer !== null) this.timers.clearInterval(this.timer);
    this.timer = null;
    this.conn = null;
    for (const w of this.stallWaiters.splice(0)) w.reject(new Error('The connection closed.'));
  }

  /** Send one ping now (with the last measurement). */
  pingNow() {
    if (!this.conn) return;
    const now = this.now();
    if (this.meter.expire(now)) this.updateSelf();
    this.n = (this.n + 1) % 0x7fffffff;
    const at = Math.max(0, Math.round(now));
    const m = this.meter.measurement();
    try {
      this.conn.send(m ? { t: C2S.PING, n: this.n, at, rtt: Math.min(m.rtt, 60_000), jitter: Math.min(m.jitter, 60_000), late: m.late } : { t: C2S.PING, n: this.n, at });
      this.meter.noteSent(this.n, at);
    } catch (err) {
      console.warn('ping failed', err?.message);
    }
  }

  /** "Test again": TEST_PINGS pings TEST_PING_GAP_MS apart (within the server's ping budget). */
  testAgain() {
    for (let i = 0; i < TEST_PINGS; i++) this.timers.setTimeout(() => this.pingNow(), i * TEST_PING_GAP_MS);
  }

  onPong(m) {
    if (this.meter.notePong(m.n, m.at, this.now()) !== null) this.updateSelf();
  }

  updateSelf() {
    const m = this.meter.measurement();
    const quality = m ? netQuality(m) : null;
    const wall = this.wallNow();
    const poorSince = quality === 'poor' ? (this.self.poorSince ?? wall) : null;
    this.self = {
      rtt: m?.rtt ?? null,
      jitter: m?.jitter ?? null,
      late: m?.late ?? null,
      quality,
      bars: netBars(quality),
      poorSince,
      sent: this.meter.sent,
      latePings: this.meter.late,
    };
    this.emit('self', this.self);
  }

  /** How long the own connection has been poor without a break (0 when it is not). */
  poorForMs(now = this.wallNow()) {
    return this.self.poorSince === null ? 0 : Math.max(0, now - this.self.poorSince);
  }

  onNetstat(m) {
    const players = new Map();
    for (const p of m.players) {
      const quality = netQuality(p);
      players.set(p.client, { client: p.client, rtt: p.rtt, jitter: p.jitter, late: p.late, silent: p.silent ?? null, quality, bars: netBars(quality), you: p.client === this.you });
      if (this.gameStart !== null && p.rtt !== null) this.record(p, this.wallNow());
    }
    this.players = players;
    this.emit('players', players);
  }

  onWaiting(m) {
    this.waiting = m.client === null ? null : { client: m.client, heldMs: m.heldMs, dropInMs: m.dropInMs, at: this.wallNow() };
    this.emit('waiting', this.waiting);
  }

  // ---- Statistics ---------------------------------------------------------------------------

  /** The game started: per-player series and totals from now on (one point per SERIES_STEP_MS). */
  beginGame(at = this.wallNow()) {
    this.gameStart = at;
    this.step = SERIES_STEP_MS;
    this.series = new Map();
    this.totals = new Map();
    this.buckets = new Map();
  }

  record(p, wall) {
    const t = wall - this.gameStart;
    const tot = this.totals.get(p.client) ?? emptyTotals();
    tot.reports++;
    tot.rttSum += p.rtt;
    tot.jitterSum += p.jitter;
    if (p.rtt > tot.worst) {
      tot.worst = p.rtt;
      tot.worstAt = t;
    }
    tot.late = p.late;
    this.totals.set(p.client, tot);
    let b = this.buckets.get(p.client);
    const start = Math.floor(t / this.step) * this.step;
    if (b && b.t !== start) {
      this.closeBucket(p.client, b);
      b = null;
    }
    if (!b) {
      b = { t: start, n: 0, rttSum: 0, worst: 0, jitterSum: 0, late: 0 };
      this.buckets.set(p.client, b);
    }
    b.n++;
    b.rttSum += p.rtt;
    b.worst = Math.max(b.worst, p.rtt);
    b.jitterSum += p.jitter;
    b.late = Math.max(b.late, p.late);
  }

  closeBucket(client, b) {
    const list = this.series.get(client) ?? [];
    list.push({ t: b.t, rtt: Math.round(b.rttSum / b.n), worst: b.worst, jitter: Math.round(b.jitterSum / b.n), late: b.late, n: b.n });
    this.series.set(client, list);
    if (list.length > SERIES_MAX) this.compact();
  }

  /** Merge neighbouring points of every series and double the step. */
  compact() {
    this.step *= 2;
    for (const [client, list] of this.series) {
      const out = [];
      for (const p of list) {
        const t = Math.floor(p.t / this.step) * this.step;
        const last = out.at(-1);
        if (last && last.t === t) {
          const n = last.n + p.n;
          last.rtt = Math.round((last.rtt * last.n + p.rtt * p.n) / n);
          last.jitter = Math.round((last.jitter * last.n + p.jitter * p.n) / n);
          last.worst = Math.max(last.worst, p.worst);
          last.late = Math.max(last.late, p.late);
          last.n = n;
        } else {
          out.push({ ...p, t });
        }
      }
      this.series.set(client, out);
    }
  }

  /**
   * The statistics of the game so far: per client `{ series: [{ t, rtt,
   * worst, jitter, late }], avg, worst, worstAt, jitter, late }` (rtt in ms,
   * late in percent, t in ms since beginGame), the current point included.
   */
  report() {
    const out = new Map();
    for (const [client, tot] of this.totals) {
      const series = [...(this.series.get(client) ?? [])];
      const b = this.buckets.get(client);
      if (b && b.n > 0) series.push({ t: b.t, rtt: Math.round(b.rttSum / b.n), worst: b.worst, jitter: Math.round(b.jitterSum / b.n), late: b.late, n: b.n });
      out.set(client, {
        series: series.map(({ n: _n, ...p }) => p),
        avg: Math.round(tot.rttSum / tot.reports),
        worst: tot.worst,
        worstAt: tot.worstAt,
        jitter: Math.round(tot.jitterSum / tot.reports),
        late: tot.late,
      });
    }
    return out;
  }

  /**
   * Ask the server for the game's stall log: `{ stalls: [{ tick, client,
   * ms }], totals: [{ client, ms, count }] }`. Rejects when the connection
   * closes or nothing comes within STALLS_TIMEOUT_MS. The server answers at
   * most every few seconds; the last answer stays in `lastStalls`.
   */
  requestStalls() {
    return new Promise((resolve, reject) => {
      if (!this.conn) {
        reject(new Error('Not connected.'));
        return;
      }
      const waiter = { resolve, reject, timer: null };
      waiter.timer = this.timers.setTimeout(() => {
        this.stallWaiters = this.stallWaiters.filter((w) => w !== waiter);
        reject(new Error('The server did not answer.'));
      }, STALLS_TIMEOUT_MS);
      this.stallWaiters.push(waiter);
      try {
        this.conn.send({ t: C2S.STALLS });
      } catch (err) {
        this.timers.clearTimeout(waiter.timer);
        this.stallWaiters = this.stallWaiters.filter((w) => w !== waiter);
        reject(err);
      }
    });
  }

  onStalls(m) {
    this.lastStalls = { stalls: m.stalls, totals: m.totals };
    for (const w of this.stallWaiters.splice(0)) {
      this.timers.clearTimeout(w.timer);
      w.resolve(this.lastStalls);
    }
    this.emit('stalls', this.lastStalls);
  }
}

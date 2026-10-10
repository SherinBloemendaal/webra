// Online multiplayer networking (docs/contracts.md, section 4): the HTTP API,
// the session WebSocket and the lockstep driver.
//
// Lockstep, end to end:
// 1. The server starts the game and immediately sends empty frames
//    0..delay-1 (delay = 3 ticks).
// 2. The client may run tick T only after frame T arrived. Before running it,
//    it sends its local orders (Game.take_orders) as `orders` for T + delay.
// 3. The server collects every active player's `orders` for a tick, stamps
//    the sender's seat on each order and broadcasts `frame` T + delay.
// 4. Running tick T: Game.apply_frame(frame.orders), then Game.tick().
//    After every tick that is a multiple of 25 the client sends `hash`.
//
// Rejoining (and spectators joining a running game): the server sends the
// start message, the order log (`log`, frames with orders only) and `sync`
// (every frame before `sync.tick` was sent; the others were empty). The
// driver fast-forwards through them within a time budget per animation
// frame, checks `sync.check` (the state hash most players agreed on), and
// a player then sends `resume`. The server answers `back` with the tick from
// which its orders count again; the driver sends orders and hashes from
// there on. Spectators never send orders or hashes.

import {
  C2S,
  encodeClient,
  HASH_INTERVAL,
  MEMBER_HEADER,
  MAX_MESSAGE_BYTES,
  MAX_ORDERS_PER_TICK,
  parseServerMessage,
  PROTOCOL_VERSION,
  ProtocolError,
  REPLAY_HASH_INTERVAL,
  S2C,
  validOrder,
} from './protocol.js';
import { noteUserText } from './telemetry/index.js';

// ---- HTTP API ---------------------------------------------------------------

export class ApiError extends Error {
  /** @param {object} [detail] the whole error object of the answer (field, status, ban, retryAfter, current) */
  constructor(status, code, message, detail = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.field = detail?.field ?? null;
    this.detail = detail;
  }
}

async function request(path, init = {}) {
  let res;
  try {
    res = await fetch(path, { credentials: 'same-origin', ...init });
  } catch {
    throw new ApiError(0, 'offline', 'The multiplayer server cannot be reached.');
  }
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
    // Lobby, map and player names are cut out of error reports (js/telemetry).
    noteUserText(body);
  } catch {
    // Not JSON (e.g. a static file server without the API).
  }
  if (!res.ok || body === null) {
    const err = body && body.error && typeof body.error.message === 'string' ? body.error : null;
    throw new ApiError(res.status, err ? String(err.code) : 'unavailable', err ? err.message : 'The multiplayer server is not available.', err);
  }
  return { body, text };
}

/** Every write to the API carries this header (docs/accounts-api.md 1.1: CSRF). */
export const CSRF_HEADER = Object.freeze({ 'X-WebRA-CSRF': '1' });

const postJson = (path, value, raw = false, headers = {}) =>
  request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...CSRF_HEADER, ...headers },
    body: raw ? value : JSON.stringify(value),
  });

/** A session member's credential for the map endpoints (docs/contracts.md section 4). */
const memberHeader = (member) => ({ [MEMBER_HEADER]: `${member.client}.${member.key}` });
const sessionMapPath = (sessionId) => `/api/sessions/${encodeURIComponent(sessionId)}/map`;

export const api = {
  version: async () => (await request('/api/version')).body,
  sessions: async () => (await request('/api/sessions')).body,
  /** @returns {Promise<{id: string, hostKey: string}>} */
  createSession: async (input) => (await postJson('/api/sessions', input)).body,
  /** The community map list (published maps). */
  maps: async () => (await request('/api/maps')).body,
  /**
   * The lobby's (or running game's) map of a session, as one of its members:
   * raw text, pinned to `hash` by the server (the caller checks it again).
   */
  sessionMap: async (sessionId, member, hash) =>
    (await request(`${sessionMapPath(sessionId)}?hash=${encodeURIComponent(hash)}`, { headers: memberHeader(member), cache: 'no-store' })).text,
  /** Host: continue a saved online game in this session (the save file's text). */
  resumeSession: async (sessionId, member, saveText) =>
    (await postJson(`/api/sessions/${encodeURIComponent(sessionId)}/resume`, saveText, true, memberHeader(member))).body,
  /** Host: share a map file with this session only. @returns {Promise<{id: string, hash: string}>} */
  shareSessionMap: async (sessionId, member, json) => (await postJson(sessionMapPath(sessionId), json, true, memberHeader(member))).body,
};

// ---- WebSocket ------------------------------------------------------------------

/**
 * One session connection. Every incoming message is validated with the
 * protocol package; invalid server messages close the connection.
 */
export class Connection {
  constructor(sessionId) {
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.url = `${scheme}//${location.host}/api/sessions/${encodeURIComponent(sessionId)}/ws`;
    this.handlers = new Map();
    this.closed = false;
    this.closeReason = null;
    /** Code of the last `error` message (why the server closed, if it did). */
    this.closeCode = null;
  }

  /** Register a handler for a server message type (or 'close'). */
  on(type, fn) {
    this.handlers.set(type, fn);
    return this;
  }

  emit(type, value) {
    const fn = this.handlers.get(type);
    if (fn) fn(value);
  }

  /** Open the socket and say hello; resolves with the `welcome` message. */
  open(hello) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.addEventListener('open', () => {
        try {
          this.send({ t: C2S.HELLO, protocol: PROTOCOL_VERSION, ...hello });
        } catch (err) {
          settled = true;
          reject(err);
          ws.close();
        }
      });
      ws.addEventListener('message', (e) => {
        const r = parseServerMessage(e.data);
        if (!r.ok) {
          console.error('Invalid server message:', r.message);
          this.closeReason = 'The server sent an invalid message.';
          ws.close();
          return;
        }
        const msg = r.msg;
        // Chat, player and lobby names are cut out of error reports (js/telemetry).
        noteUserText(msg);
        if (!settled) {
          if (msg.t === S2C.WELCOME) {
            settled = true;
            resolve(msg);
            return;
          }
          if (msg.t === S2C.ERROR) {
            settled = true;
            reject(new ApiError(0, msg.code, msg.message));
            return;
          }
        }
        if (msg.t === S2C.ERROR) {
          this.closeReason = msg.message;
          this.closeCode = msg.code;
        }
        this.emit(msg.t, msg);
      });
      ws.addEventListener('close', () => {
        this.closed = true;
        if (!settled) {
          settled = true;
          reject(new ApiError(0, 'closed', this.closeReason || 'Could not join the session.'));
        }
        this.emit('close', this.closeReason);
      });
    });
  }

  /** Validate and send a client message. Throws ProtocolError when invalid. */
  send(msg) {
    const raw = encodeClient(msg);
    noteUserText(msg);
    if (!this.closed && this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(raw);
  }

  leave() {
    if (this.closed) return;
    try {
      this.send({ t: C2S.LEAVE });
    } catch {
      // Closing anyway.
    }
    this.closed = true;
    this.ws?.close(1000, 'leave');
  }
}

// ---- Order packing ------------------------------------------------------------------

/** Orders with id lists are split into chunks small enough for one message. */
const IDS_PER_ORDER = 300;
/** Leave headroom below the 8 KiB message limit for the envelope. */
const ORDER_BYTES_BUDGET = MAX_MESSAGE_BYTES - 256;

/** Split orders whose id lists would not fit in one message (same effect, smaller pieces). */
export function splitOrders(orders) {
  const out = [];
  for (const o of orders) {
    if (Array.isArray(o.ids) && o.ids.length > IDS_PER_ORDER) {
      for (let i = 0; i < o.ids.length; i += IDS_PER_ORDER) out.push({ ...o, ids: o.ids.slice(i, i + IDS_PER_ORDER) });
    } else {
      out.push(o);
    }
  }
  return out;
}

/**
 * Take as many queued orders as fit into one `orders` message (count and size
 * limits); the rest stay queued for the next tick, in order.
 */
export function packOrders(queue) {
  const batch = [];
  let bytes = 2;
  while (queue.length > 0 && batch.length < MAX_ORDERS_PER_TICK) {
    const size = JSON.stringify(queue[0]).length + 1;
    if (batch.length > 0 && bytes + size > ORDER_BYTES_BUDGET) break;
    batch.push(queue.shift());
    bytes += size;
  }
  return batch;
}

// ---- Lockstep driver ---------------------------------------------------------------------

const MAX_TICKS_PER_FRAME = 8;
const MAX_TICKS_HIDDEN = 250;
/** Wall time per animation frame spent fast-forwarding while catching up. */
export const CATCH_UP_BUDGET_MS = 40;

export class LockstepDriver {
  /**
   * @param {Connection} conn
   * @param {*} game a Game in lockstep mode
   * @param {{
   *   delay: number, tickMs: number,
   *   spectator?: boolean,   never sends orders or hashes
   *   player?: number | null,  this client's player: once the engine defeats it, the
   *                          driver tells the server (`defeated`) and sends only empty orders
   *   rejoining?: boolean,   waits for `back` before sending
   *   recorder?: { record(tick: number, orders: any[]): void, noteHash(ticks: number, hash: string): void } | null,
   *   onCaughtUp?: () => void,  caught up with `sync` (a rejoining player sends `resume` here)
   *   onCheck?: (ok: boolean, tick: number) => void,  result of the `sync.check` comparison
   *   hidden?: () => boolean,  the page is hidden (no animation frames: frames run as they arrive)
   *   now?: () => number,
   * }} opts
   */
  constructor(conn, game, { delay, tickMs, spectator = false, player = null, rejoining = false, recorder = null, onCaughtUp = null, onCheck = null, hidden = null, now = null }) {
    this.conn = conn;
    this.game = game;
    this.delay = delay;
    this.tickMs = tickMs;
    /** Next tick to run. */
    this.next = 0;
    this.frames = new Map();
    this.queue = [];
    this.acc = 0;
    this.stalledMs = 0;
    this.stopped = false;
    this.spectator = spectator;
    this.player = spectator ? null : player;
    /** The engine defeated this client's player: it watches on and gives no orders. */
    this.defeated = false;
    /** The server was told about the defeat on the current connection. */
    this.defeatSent = false;
    /** Whether this client's orders and hashes go to the server (from `joinTick` on). */
    this.sending = !spectator && !rejoining;
    this.joinTick = 0;
    /** Every frame before this tick was sent (`sync`); missing ones are empty. */
    this.syncTick = 0;
    this.check = null;
    this.waitingSync = rejoining;
    this.caughtUp = false;
    this.recorder = recorder;
    this.onCaughtUp = onCaughtUp;
    this.onCheck = onCheck;
    this.now = now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    // In a worker there is no document: the main thread tells it (js/sim/core.js).
    this.hidden = hidden ?? (() => typeof document !== 'undefined' && document.hidden);
    game.set_lockstep(true);
  }

  /**
   * Continue on a new connection after a reconnect: this client keeps its
   * game and waits for the server's `sync`, then catches up and resumes.
   */
  reattach(conn) {
    this.conn = conn;
    this.sending = false;
    this.defeatSent = false;
    this.waitingSync = true;
    this.queue = [];
    this.check = null;
    this.caughtUp = false;
  }

  /** Whether a frame for `tick` is here (frames before `syncTick` that are not are empty). */
  hasFrame(tick) {
    return this.frames.has(tick) || tick < this.syncTick;
  }

  /** Fast-forwarding to catch up with a running game (rejoin, late spectator). */
  get catchingUp() {
    return !this.stopped && (this.waitingSync || this.next < this.syncTick);
  }

  /** Catch-up progress, 0..1. */
  progress() {
    if (this.waitingSync) return 0;
    return this.syncTick > 0 ? Math.min(1, this.next / this.syncTick) : 1;
  }

  /** A `frame` message arrived. */
  onFrame(frame) {
    if (frame.tick < this.next || this.frames.has(frame.tick)) return;
    this.frames.set(frame.tick, frame.orders);
    // Hidden tabs get no animation frames: keep up from the network events.
    if (this.hidden() && !this.catchingUp) this.pump(MAX_TICKS_HIDDEN);
  }

  /** A `log` message: frames with orders from the server's order log. */
  onLog(msg) {
    for (const [tick, orders] of msg.frames) this.onFrame({ tick, orders });
  }

  /** `sync`: the order log is complete up to `tick`. */
  onSync(msg) {
    this.syncTick = msg.tick;
    this.check = msg.check && msg.check.tick >= this.next ? msg.check : null;
    this.waitingSync = false;
    this.maybeCaughtUp();
  }

  /** `back` for this client: its orders count from `tick` on. */
  onBack(tick) {
    if (this.spectator) return;
    this.joinTick = tick;
    this.sending = true;
  }

  maybeCaughtUp() {
    if (this.waitingSync || this.next < this.syncTick || this.caughtUp) return;
    this.caughtUp = true;
    this.onCaughtUp?.();
  }

  /** Run every frame that is already here, up to `max` ticks. */
  pump(max) {
    let n = 0;
    while (!this.stopped && n < max && this.hasFrame(this.next)) {
      this.runTick();
      n++;
    }
    this.acc = 0;
    return n;
  }

  /** Fast-forward within `budgetMs` of wall time (catching up). */
  catchUp(budgetMs = CATCH_UP_BUDGET_MS) {
    const end = this.now() + budgetMs;
    let ticks = 0;
    while (!this.stopped && this.next < this.syncTick && this.hasFrame(this.next)) {
      this.runTick();
      ticks++;
      if ((ticks & 7) === 0 && this.now() >= end) break;
    }
    this.acc = 0;
    this.maybeCaughtUp();
    return ticks;
  }

  /**
   * Advance by `dtMs` of wall time. Returns the ticks run and the render
   * interpolation factor.
   */
  advance(dtMs) {
    if (this.stopped) return { ticks: 0, alpha: 1 };
    if (this.waitingSync) return { ticks: 0, alpha: 1 };
    if (this.next < this.syncTick) return { ticks: this.catchUp(), alpha: 1 };
    this.acc += dtMs;
    // Behind the network (e.g. after a hitch or after others stalled): catch
    // up faster than real time. From delay + 1 waiting frames on, the server
    // is already waiting for this client's orders, so every frame of pacing
    // here would count against its round trip (lockstep.js HOLD_GRACE_MS).
    const backlog = this.frames.size;
    let ticks = 0;
    while (ticks < MAX_TICKS_PER_FRAME && this.hasFrame(this.next) && (this.acc >= this.tickMs || backlog > this.delay)) {
      this.runTick();
      this.acc = Math.max(0, this.acc - this.tickMs);
      ticks++;
    }
    if (!this.hasFrame(this.next) && this.acc >= this.tickMs) {
      // Waiting for other players: do not bank time for a burst later.
      this.stalledMs += dtMs;
      this.acc = this.tickMs;
    } else if (ticks > 0) {
      this.stalledMs = 0;
    }
    return { ticks, alpha: Math.min(1, this.acc / this.tickMs) };
  }

  runTick() {
    const t = this.next;
    const orders = this.frames.get(t) ?? [];
    this.frames.delete(t);
    if (this.sending && t + this.delay >= this.joinTick) this.sendOrders(t + this.delay);
    else this.discardOrders();
    if (orders.length > 0) {
      this.game.apply_frame(JSON.stringify(orders));
      this.recorder?.record(t, orders);
    }
    this.game.tick();
    this.next = t + 1;
    const needHash = (this.sending && t % HASH_INTERVAL === 0 && t >= this.joinTick) || (this.check && this.check.tick === t);
    if (needHash || (this.recorder && this.next % REPLAY_HASH_INTERVAL === 0)) {
      const hash = this.game.state_hash();
      if (this.sending && t % HASH_INTERVAL === 0 && t >= this.joinTick) this.safeSend({ t: C2S.HASH, tick: t, hash });
      if (this.check && this.check.tick === t) {
        this.onCheck?.(hash === this.check.hash, t);
        this.check = null;
      }
      if (this.recorder && this.next % REPLAY_HASH_INTERVAL === 0) this.recorder.noteHash(this.next, hash);
    }
    // The engine checks for defeat once a second (25 ticks).
    if (this.player !== null && !this.defeated && t % HASH_INTERVAL === 0 && this.game.player_defeated?.(this.player)) this.defeated = true;
    if (this.defeated && this.sending && !this.defeatSent && t >= this.joinTick) {
      this.defeatSent = true;
      this.safeSend({ t: C2S.DEFEATED });
    }
  }

  /** Orders issued while this client cannot send (spectating, rejoining) are dropped. */
  discardOrders() {
    this.queue = [];
    try {
      this.game.take_orders();
    } catch {
      // Nothing to drop.
    }
  }

  sendOrders(tick) {
    if (this.defeated) {
      // Out of the game: still in step (empty orders), never an order.
      this.discardOrders();
      this.safeSend({ t: C2S.ORDERS, tick, orders: [] });
      return;
    }
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
        // The engine would skip it anyway; never let one bad order block the tick.
        console.warn('Dropped an order the protocol rejects:', err.message);
      }
    }
    this.safeSend({ t: C2S.ORDERS, tick, orders: packOrders(this.queue) });
  }

  safeSend(msg) {
    try {
      this.conn.send(msg);
    } catch (err) {
      if (err instanceof ProtocolError) console.error('Could not send', msg.t, err.message);
      else throw err;
    }
  }

  stop() {
    this.stopped = true;
  }
}

// Session Durable Object: one per online game. Uses the WebSocket Hibernation
// API, keeps the lobby in Durable Object storage, and relays lockstep frames
// in memory during the game (docs/contracts.md, section 4).
//
// Trust model: every client message is size checked, rate limited and
// validated with packages/protocol; host-only actions are checked against the
// connection that proved the host key; orders are stamped with the sender's
// seat; map names and flags come from D1, never from the client.
//
// Reconnect: every member gets a rejoin key at join (only its SHA-256 is
// stored). A player whose connection drops (or who is dropped for stalling)
// is taken out of lockstep at once, so nobody waits for it, and may rejoin
// within RECONNECT_GRACE_MS: it gets the start message and the order log
// (orderlog.js), fast-forwards, sends `resume`, and its orders count again
// from a future tick on, with the stall budget it left with. The game never
// pauses for a missing player. Spectators get frames and can never send
// orders or hashes (a client that tries is removed).
//
// Accounts (docs/accounts-api.md, section 7): the Worker authenticates the
// WebSocket upgrade by the session cookie and passes the verdict in the
// X-WebRA-Auth header (set by the Worker, never by the client). A signed-in
// member plays under its username, holds at most one place per session and
// can rejoin only as the same account. A refused connection gets the reason
// in answer to `hello`. Members are recorded in D1 `game_presence`, so a ban
// can drop them (`evict`).

import { DurableObject } from 'cloudflare:workers';
import {
  C2S,
  DROP_AFTER_MS,
  encodeServer,
  ERRORS,
  errorMessage,
  MAX_MESSAGE_BYTES,
  LOG_MAX_BYTES,
  MAX_SERVER_MESSAGE_BYTES,
  parseClientMessage,
  PROTOCOL_VERSION,
  RECONNECT_GRACE_MS,
  REJOINABLE_REASONS,
  RESUME_TIMEOUT_MS,
  S2C,
  usernameKey,
} from '@webra/protocol';
import {
  hashHostKey,
  hashPassword,
  hashSeatKey,
  randomInt,
  randomSeatKey,
  randomToken,
  verifyHostKey,
  verifyPassword,
  verifySeatKey,
} from './crypto.js';
import { HEARTBEAT_MS, removeSession, upsertSession } from './directory.js';
import { Lockstep, LockstepError } from './lockstep.js';
import { lookupMap } from './maps.js';
import { OrderLog } from './orderlog.js';
import { TokenBucket } from './ratelimit.js';
import { Room, RoomError } from './room.js';
import { cheatsAllowed, ordersFitRules } from './validate.js';
import { inRange, ipRecord } from './accounts/ip.js';
import { AUTH_HEADER } from './accounts/play.js';
import ENGINE_RULES from '../../../engine/rules.json' with { type: 'json' };

/** Unused sessions (nobody ever joined) are deleted after this long. */
const UNUSED_TTL_MS = 5 * 60 * 1000;
/** A socket must say hello within this time. */
const HELLO_TIMEOUT_MS = 15 * 1000;
const MAX_SOCKETS = 24;
const MAX_PENDING_SOCKETS = 8;
/** Wrong passwords per IP before a lockout, and the lockout length. */
const PASSWORD_FAILURES = 5;
const PASSWORD_LOCKOUT_MS = 60 * 1000;
/** Refused messages before a flooding connection is closed. */
const FLOOD_LIMIT = 200;
const GAME_ALARM_MS = 1000;
/** Catch-ups (rejoins and late spectators read the whole order log) per session: burst and rate per second. */
const SYNC_BURST = 6;
const SYNC_RATE = 6 / 60;
/**
 * Catch-ups in progress at once: from the first log message until the client
 * confirms it caught up (`resume` for players, `synced` for spectators), so
 * this bounds the log output buffered for slow readers, not only the reads.
 */
const MAX_SYNCING = 2;
/** Catch-up output budget: bursts of two full logs, refilled by one full log per minute. */
const CATCH_UP_BYTES_BURST = 2 * LOG_MAX_BYTES;
const CATCH_UP_BYTES_PER_SECOND = LOG_MAX_BYTES / 60;
/** Chat per connection: one line a second, bursts of five; a flood closes the connection. */
const CHAT_RATE = 1;
const CHAT_BURST = 5;
const CHAT_FLOOD_LIMIT = 20;
/** Order log frames per `log` message stay below the server message limit. */
const LOG_MESSAGE_BUDGET = MAX_SERVER_MESSAGE_BYTES - 4 * 1024;
/** Time a rejoining client gets to fast-forward, per tick of the game so far, and at most. */
const RESUME_MS_PER_TICK = 5;
const RESUME_MAX_MS = 15 * 60 * 1000;
/** Reasons after which a member can never come back. */
const FINAL_REASONS = ['left', 'kicked', 'removed', 'expired'];

const CLOSE_NORMAL = 1000;
const CLOSE_POLICY = 1008;
const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/;

/** The Worker's verdict from the upgrade request: { account, refuse } (malformed reads as refused). */
export function readAuthHeader(request) {
  const refused = { account: null, refuse: { code: ERRORS.FORBIDDEN, message: 'Could not check your account. Reload the page.' } };
  const raw = request.headers.get(AUTH_HEADER);
  if (raw === null) return refused;
  let v;
  try {
    v = JSON.parse(raw);
  } catch {
    return refused;
  }
  if (v === null || typeof v !== 'object') return refused;
  let account = null;
  if (v.account !== null) {
    if (typeof v.account !== 'object' || !ACCOUNT_ID_RE.test(v.account?.id) || typeof v.account.username !== 'string') return refused;
    account = { id: v.account.id, username: v.account.username };
  }
  let refuse = null;
  if (v.refuse !== null) {
    if (typeof v.refuse !== 'object' || typeof v.refuse?.code !== 'string' || typeof v.refuse.message !== 'string') return refused;
    refuse = { code: v.refuse.code, message: v.refuse.message };
  }
  return { account, refuse };
}

export class Session extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.meta = null;
    this.room = null;
    this.lockstep = null;
    /** Order log of the running game (in memory and Durable Object storage). */
    this.log = null;
    /** Sockets catching up -> frames broadcast meanwhile (sent after the log). */
    this.syncing = new Map();
    this.syncBucket = new TokenBucket(SYNC_RATE, SYNC_BURST);
    this.catchUpBytes = new TokenBucket(CATCH_UP_BYTES_PER_SECOND, CATCH_UP_BYTES_BURST);
    /** Sockets catching up until they confirm -> { client, role, until }. */
    this.catching = new Map();
    this.buckets = new WeakMap();
    this.chatBuckets = new WeakMap();
    this.failures = new Map();
    this.lastDirectory = null;
    ctx.blockConcurrencyWhile(async () => {
      const [meta, room] = await Promise.all([ctx.storage.get('meta'), ctx.storage.get('room')]);
      this.meta = meta ?? null;
      this.room = room ? Room.fromJSON(room) : null;
    });
  }

  // ---- RPC from the Worker ----------------------------------------------------

  /**
   * Create the session. Called once by POST /api/sessions with validated
   * input. Returns the host key (only its hash is stored).
   */
  async init({ id, name, password, isPublic, maxPlayers, version }) {
    if (this.meta) throw new Error('session already exists');
    const hostKey = randomToken();
    this.meta = {
      id,
      name,
      public: isPublic,
      maxPlayers,
      version,
      password: password ? await hashPassword(password) : null,
      hostKeyHash: await hashHostKey(hostKey),
      createdAt: Date.now(),
      everJoined: false,
    };
    this.room = Room.create({ maxPlayers, seed: randomInt(0x7fffffff) });
    await this.ctx.storage.put({ meta: this.meta, room: this.room.toJSON() });
    await this.ctx.storage.setAlarm(Date.now() + UNUSED_TTL_MS);
    return { hostKey };
  }

  // ---- WebSocket upgrade ---------------------------------------------------------

  async fetch(request) {
    if (!this.meta || !this.room) return new Response('No such session.', { status: 404 });
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected a WebSocket upgrade.', { status: 426 });
    }
    const all = this.ctx.getWebSockets();
    const pending = all.filter((ws) => !this.attachment(ws).client).length;
    if (all.length >= MAX_SOCKETS || pending >= MAX_PENDING_SOCKETS) {
      return new Response('Too many connections.', { status: 429 });
    }
    const pair = new WebSocketPair();
    const [clientSide, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const auth = readAuthHeader(request);
    server.serializeAttachment({
      client: null,
      ip: request.headers.get('CF-Connecting-IP') || 'unknown',
      since: Date.now(),
      busy: false,
      account: auth.account,
      refuse: auth.refuse,
    });
    await this.ensureAlarm(Date.now() + HELLO_TIMEOUT_MS);
    return new Response(null, { status: 101, webSocket: clientSide });
  }

  // ---- Hibernation handlers ---------------------------------------------------------

  async webSocketMessage(ws, message) {
    if (typeof message !== 'string') return this.reject(ws, ERRORS.BAD_MESSAGE, 'Binary messages are not supported.', true);
    if (message.length > MAX_MESSAGE_BYTES) return this.reject(ws, ERRORS.TOO_LARGE, 'Message too large.', true);
    let bucket = this.buckets.get(ws);
    if (!bucket) {
      bucket = new TokenBucket();
      this.buckets.set(ws, bucket);
    }
    if (!bucket.take()) {
      if (bucket.refused > FLOOD_LIMIT) return this.reject(ws, ERRORS.RATE_LIMITED, 'Too many messages.', true);
      if (bucket.refused % 50 === 1) this.send(ws, { t: S2C.ERROR, code: ERRORS.RATE_LIMITED, message: 'Slow down.' });
      return;
    }
    const parsed = parseClientMessage(message);
    if (!parsed.ok) return this.reject(ws, parsed.code, parsed.message, false);
    const msg = parsed.msg;
    const att = this.attachment(ws);
    // Kicked, dropped or departed connections are closing: ignore their messages.
    if (att.gone) return;

    if (!this.meta || !this.room) return this.reject(ws, ERRORS.NOT_FOUND, 'This session no longer exists.', true);
    if (att.client === null) {
      if (msg.t !== C2S.HELLO) return this.reject(ws, ERRORS.STATE, 'Say hello first.', true);
      if (att.busy) return;
      return this.hello(ws, att, msg);
    }
    if (msg.t === C2S.HELLO) return this.reject(ws, ERRORS.STATE, 'Already joined.', false);

    try {
      if (this.room.phase === 'lobby') await this.lobbyMessage(ws, att.client, msg);
      else await this.gameMessage(ws, att.client, msg);
    } catch (err) {
      if (err instanceof RoomError || err instanceof LockstepError) {
        this.reject(ws, err.code, err.message, false);
        return;
      }
      console.error('session message failed', err?.name, err?.message);
      this.reject(ws, ERRORS.INTERNAL, 'Internal error.', false);
    }
  }

  async webSocketClose(ws) {
    this.syncing.delete(ws);
    this.catching.delete(ws);
    await this.disconnect(ws, 'disconnected');
  }

  async webSocketError(ws) {
    this.syncing.delete(ws);
    this.catching.delete(ws);
    await this.disconnect(ws, 'disconnected');
  }

  // ---- Hello ---------------------------------------------------------------------------

  async hello(ws, att, msg) {
    const meta = this.meta;
    if (msg.protocol !== PROTOCOL_VERSION) {
      return this.reject(ws, ERRORS.PROTOCOL, `Protocol ${PROTOCOL_VERSION} required. Reload the page.`, true);
    }
    if (msg.version !== meta.version) {
      return this.reject(ws, ERRORS.VERSION, 'This session runs a different game version.', true);
    }
    if (att.refuse) return this.reject(ws, att.refuse.code, att.refuse.message, true);
    if (msg.rejoin) return this.rejoin(ws, att, msg);
    // Signed in: the username, whatever the client sent. Anonymous: its chosen name.
    const name = att.account ? att.account.username : msg.name;
    if (name === undefined) return this.reject(ws, ERRORS.INVALID, 'Choose a name.', true);
    // Anonymous players (accounts not required) cannot pose as an account.
    if (!att.account && (await this.nameBelongsToAccount(name))) {
      return this.reject(ws, ERRORS.INVALID, 'That name belongs to an account. Sign in, or choose another name.', true);
    }
    const spectate = msg.spectate === true;
    const phaseProblem = () => {
      if (this.room.phase === 'lobby') return null;
      if (!spectate) return 'The game has already started. You can join as a spectator.';
      return this.canCatchUp() ? null : 'This game can no longer be watched.';
    };
    let problem = phaseProblem();
    if (problem) return this.reject(ws, ERRORS.STATE, problem, true);

    const now = Date.now();
    const fail = this.failures.get(att.ip);
    if (fail && fail.until > now) return this.reject(ws, ERRORS.RATE_LIMITED, 'Too many attempts. Try again later.', true);

    att.busy = true;
    ws.serializeAttachment(att);
    let isHost = false;
    let key;
    let keyHash;
    try {
      if (msg.hostKey !== undefined) {
        if (!(await verifyHostKey(msg.hostKey, meta.hostKeyHash))) {
          this.noteFailure(att.ip, now);
          return this.reject(ws, ERRORS.FORBIDDEN, 'Invalid host key.', true);
        }
        isHost = true;
      } else if (meta.password) {
        if (msg.password === undefined || !(await verifyPassword(msg.password, meta.password))) {
          this.noteFailure(att.ip, now);
          return this.reject(ws, ERRORS.PASSWORD, 'Wrong password.', true);
        }
      }
      key = randomSeatKey();
      keyHash = await hashSeatKey(key);
    } finally {
      att.busy = false;
    }

    // Re-check after the awaits: the room may have changed meanwhile.
    if (!this.meta || !this.room) return this.reject(ws, ERRORS.NOT_FOUND, 'This session no longer exists.', true);
    problem = phaseProblem();
    if (problem) return this.reject(ws, ERRORS.STATE, problem, true);
    const hostConnected = this.room.hostId !== null && this.socketOf(this.room.hostId) !== null;
    let joined;
    try {
      joined = this.room.join(name, { host: isHost && !hostConnected, spectate, account: att.account?.id ?? null });
    } catch (err) {
      if (err instanceof RoomError) return this.reject(ws, err.code, err.message, true);
      throw err;
    }
    this.room.setKey(joined.client, keyHash);
    att.client = joined.client;
    att.role = joined.role;
    ws.serializeAttachment(att);
    meta.everJoined = true;
    await this.ctx.storage.put({ meta, room: this.room.toJSON() });
    await this.notePresence(joined.client, att);

    this.send(ws, { t: S2C.WELCOME, you: joined.client, name, hostId: this.room.hostId, session: this.sessionInfo(), role: joined.role, key });
    if (this.room.phase === 'lobby') {
      this.broadcastLobby();
      await this.syncDirectory();
      await this.ensureAlarm(Date.now() + HEARTBEAT_MS);
      return;
    }
    // A spectator joining a running game catches up like a rejoining player.
    if (!this.admitCatchUp(ws, joined.client, 'spectator')) {
      await this.disconnect(ws, 'left');
      return this.reject(ws, ERRORS.RATE_LIMITED, 'Too many players are joining. Try again shortly.', true);
    }
    await this.catchUp(ws, joined.client, 'spectator');
  }

  sessionInfo() {
    const meta = this.meta;
    return {
      id: meta.id,
      name: meta.name,
      public: meta.public,
      locked: meta.password !== null,
      maxPlayers: meta.maxPlayers,
      version: meta.version,
    };
  }

  /**
   * Room for one more catch-up: fewer than MAX_SYNCING unconfirmed, the
   * per-minute count and the byte budget (the log's current size) allow it.
   */
  admitCatchUp(ws, client, role, now = Date.now()) {
    if (this.catching.size >= MAX_SYNCING) return false;
    if (!this.syncBucket.take(now)) return false;
    const bytes = Math.min(CATCH_UP_BYTES_BURST, Math.max(1, this.log?.bytes ?? 0));
    if (!this.catchUpBytes.take(now, bytes)) return false;
    // Reserved now (the rejoin may still await): counted until the client confirms.
    this.catching.set(ws, { client, role, until: now + this.catchUpMs() });
    return true;
  }

  /** How long a catch-up may take before the client must confirm it (longer games take longer). */
  catchUpMs() {
    return Math.min(RESUME_MAX_MS, RESUME_TIMEOUT_MS + (this.lockstep?.next ?? 0) * RESUME_MS_PER_TICK);
  }

  /** Whether a member can still catch up with the running game (relay and full log present). */
  canCatchUp() {
    return this.room?.phase === 'game' && this.lockstep !== null && this.log !== null && !this.log.full;
  }

  /**
   * `hello` with `rejoin`: a member of the running game comes back with its
   * rejoin key (constant-time compare against the stored SHA-256; failures
   * count toward the per-IP lockout like wrong passwords).
   */
  async rejoin(ws, att, msg) {
    const now = Date.now();
    const fail = this.failures.get(att.ip);
    if (fail && fail.until > now) return this.reject(ws, ERRORS.RATE_LIMITED, 'Too many attempts. Try again later.', true);
    if (this.room.phase !== 'game') return this.reject(ws, ERRORS.STATE, 'The game is not running.', true);
    const client = msg.rejoin.client;
    const stored = Object.hasOwn(this.room.keys, client) ? this.room.keys[client] : null;
    att.busy = true;
    ws.serializeAttachment(att);
    let valid;
    try {
      // Unknown clients still pay for a hash, so timing does not tell them apart.
      valid = await verifySeatKey(msg.rejoin.key, stored ?? '00'.repeat(32));
    } finally {
      att.busy = false;
    }
    // The key only works for the account (or the anonymous member) it was issued to.
    if (!valid || stored === null || this.room.accountOf(client) !== (att.account?.id ?? null)) {
      this.noteFailure(att.ip, now);
      return this.reject(ws, ERRORS.FORBIDDEN, 'Invalid rejoin key.', true);
    }
    if (!this.meta || !this.room) return this.reject(ws, ERRORS.NOT_FOUND, 'This session no longer exists.', true);
    if (this.room.phase !== 'game') return this.reject(ws, ERRORS.STATE, 'The game is not running.', true);
    if (!this.lockstep) return this.sessionLost();
    if (!this.canCatchUp()) return this.reject(ws, ERRORS.STATE, 'This game is too long to rejoin.', true);
    // Everything that does not depend on the member's current connection is
    // checked before that connection is touched: a refused rejoin never
    // disconnects a member who is still playing.
    const problem = this.room.rejoinProblem(client);
    if (problem) return this.reject(ws, problem.code, problem.message, true);
    const role = this.room.seatOf(client) >= 0 ? 'player' : 'spectator';
    if (!this.admitCatchUp(ws, client, role, now)) {
      return this.reject(ws, ERRORS.RATE_LIMITED, 'Too many rejoins. Try again shortly.', true);
    }

    // A connection of the same member that is still open (a reload, a second
    // tab, a half-open socket) is replaced: its seat leaves lockstep first.
    const old = this.socketOf(client);
    if (old && old !== ws) {
      const oldAtt = this.attachment(old);
      oldAtt.gone = true;
      old.serializeAttachment(oldAtt);
      this.syncing.delete(old);
      this.catching.delete(old);
      this.send(old, { t: S2C.ERROR, code: ERRORS.STATE, message: 'You joined from another connection.' });
      this.close(old, CLOSE_NORMAL, 'replaced');
      await this.memberLost(client, 'disconnected');
      if (!this.room || this.room.phase !== 'game') {
        this.catching.delete(ws);
        return this.reject(ws, ERRORS.NOT_FOUND, 'This session no longer exists.', true);
      }
    }
    let seat;
    try {
      // Fast-forwarding takes longer in longer games.
      seat = this.room.beginRejoin(client, now, this.catchUpMs());
    } catch (err) {
      this.catching.delete(ws);
      if (err instanceof RoomError) return this.reject(ws, err.code, err.message, true);
      throw err;
    }
    att.client = client;
    att.role = seat >= 0 ? 'player' : 'spectator';
    ws.serializeAttachment(att);
    await this.saveRoom();
    await this.notePresence(client, att);
    this.send(ws, { t: S2C.WELCOME, you: client, name: this.clientName(client) ?? 'Player', hostId: this.room.hostId, session: this.sessionInfo(), role: att.role });
    await this.catchUp(ws, client, att.role);
  }

  /**
   * Send the start message, the order log and `sync` to a socket joining the
   * running game. The log is streamed chunk by chunk (one in memory at a
   * time). Frames emitted meanwhile are queued for it (see broadcast) and
   * sent after `sync`; a frame both logged and queued arrives twice, which
   * clients ignore. So it never misses a frame.
   */
  async catchUp(ws, client, role) {
    this.syncing.set(ws, []);
    // Counted until the client confirms (see MAX_SYNCING, admitCatchUp);
    // unconfirmed spectators are closed by the alarm.
    this.catching.set(ws, { client, role, until: Date.now() + this.catchUpMs() });
    this.send(ws, { t: S2C.START, ...structuredClone(this.room.startMsg) });
    let batch = [];
    let bytes = 0;
    const flush = () => {
      if (batch.length > 0) this.send(ws, { t: S2C.LOG, frames: batch });
      batch = [];
      bytes = 0;
    };
    try {
      for await (const frames of this.log.chunks()) {
        if (!this.syncing.has(ws)) return; // closed meanwhile
        for (const entry of frames) {
          const size = JSON.stringify(entry).length + 1;
          if (batch.length > 0 && bytes + size > LOG_MESSAGE_BUDGET) flush();
          batch.push(entry);
          bytes += size;
        }
        flush();
      }
    } catch (err) {
      console.error('order log read failed', err?.message);
      this.syncing.delete(ws);
      await this.disconnect(ws, 'disconnected');
      return this.reject(ws, ERRORS.INTERNAL, 'Could not load the game. Try again.', true);
    }
    const queued = this.syncing.get(ws);
    this.syncing.delete(ws);
    if (!queued || !this.room || !this.lockstep || this.attachment(ws).gone) return;
    const tick = queued.length > 0 ? queued[0].tick : this.lockstep.next;
    const agreed = this.lockstep.agreed;
    this.send(ws, { t: S2C.SYNC, tick, check: agreed && agreed.tick < tick ? { ...agreed } : null });
    for (const f of queued) this.send(ws, { t: S2C.FRAME, ...f });
  }

  noteFailure(ip, now) {
    const f = this.failures.get(ip) ?? { count: 0, until: 0 };
    f.count++;
    if (f.count >= PASSWORD_FAILURES) {
      f.count = 0;
      f.until = now + PASSWORD_LOCKOUT_MS;
    }
    this.failures.set(ip, f);
    if (this.failures.size > 1000) this.failures.clear();
  }

  // ---- Lobby ------------------------------------------------------------------------------

  async lobbyMessage(ws, client, msg) {
    const room = this.room;
    switch (msg.t) {
      case C2S.SLOT: {
        const { kicked } = room.setSlot(client, msg);
        await this.saveRoom();
        if (kicked !== null) this.kick(kicked);
        this.broadcastLobby();
        await this.syncDirectory();
        return;
      }
      case C2S.OPTIONS:
        room.setOptions(client, msg.options);
        await this.saveRoom();
        this.broadcastLobby();
        return;
      case C2S.MAP: {
        if (!room.isHost(client)) throw new RoomError('Only the host can change the map.', ERRORS.NOT_HOST);
        let map = null;
        if (msg.map !== null) {
          map = await lookupMap(this.env.DB, msg.map.id);
          if (!map || map.hash !== msg.map.hash) throw new RoomError('Unknown map.', ERRORS.NOT_FOUND);
        }
        // Re-validated inside setMap (host and phase may have changed during the lookup).
        room.setMap(client, map);
        await this.saveRoom();
        this.broadcastLobby();
        await this.syncDirectory();
        return;
      }
      case C2S.READY:
        room.setReady(client, msg.ready, msg.mapHash);
        await this.saveRoom();
        this.broadcastLobby();
        return;
      case C2S.CHAT:
        this.chatFrom(ws, client, msg.text);
        return;
      case C2S.START:
        await this.startGame(client);
        return;
      case C2S.SPECTATORS:
        room.setMaxSpectators(client, msg.max);
        await this.saveRoom();
        this.broadcastLobby();
        return;
      case C2S.SPECTATE:
        room.spectate(client, msg.on);
        ws.serializeAttachment({ ...this.attachment(ws), role: msg.on ? 'spectator' : 'player' });
        await this.saveRoom();
        this.broadcastLobby();
        await this.syncDirectory();
        return;
      case C2S.LEAVE:
        await this.disconnect(ws, 'left');
        this.close(ws, CLOSE_NORMAL, 'bye');
        return;
      case C2S.ORDERS:
      case C2S.HASH:
      case C2S.RESUME:
      case C2S.SYNCED:
        throw new RoomError('The game has not started.', ERRORS.STATE);
      default:
        throw new RoomError('Unexpected message.', ERRORS.BAD_MESSAGE);
    }
  }

  async startGame(client) {
    const start = this.room.start(client, randomInt);
    const humans = this.room.seats.map((c, i) => (c === null ? -1 : i)).filter((i) => i >= 0);
    this.lockstep = new Lockstep({ players: humans, delay: start.delay });
    this.log = new OrderLog(this.ctx.storage);
    await this.saveRoom();
    this.broadcast({ t: S2C.START, ...start });
    this.emitFrames(this.lockstep.initialFrames());
    await this.syncDirectory();
    await this.ctx.storage.setAlarm(Date.now() + GAME_ALARM_MS);
  }

  // ---- Game ----------------------------------------------------------------------------------

  async gameMessage(ws, client, msg) {
    if (!this.lockstep) {
      // The object was restarted mid-game and lost the in-memory relay.
      await this.sessionLost();
      return;
    }
    const seat = this.room.seatOf(client);
    if (seat < 0 && (msg.t === C2S.ORDERS || msg.t === C2S.HASH)) {
      // Spectators watch; an honest client never sends either.
      this.reject(ws, ERRORS.FORBIDDEN, 'Spectators cannot send orders.', true);
      await this.disconnect(ws, 'removed');
      return;
    }
    switch (msg.t) {
      case C2S.ORDERS: {
        if (!ordersFitRules(msg.orders, ENGINE_RULES.actors.length)) {
          this.reject(ws, 'bad_message', 'Order names an unknown actor type.', true);
          await this.disconnect(ws, 'removed');
          return;
        }
        // The options are frozen since the start: every peer agreed on them.
        if (!cheatsAllowed(msg.orders, this.room.options)) {
          this.reject(ws, ERRORS.FORBIDDEN, 'Cheats are not enabled in this game.', true);
          await this.disconnect(ws, 'removed');
          return;
        }
        let frames;
        try {
          frames = this.lockstep.submit(seat, msg.tick, msg.orders);
        } catch (err) {
          if (!(err instanceof LockstepError)) throw err;
          // A client out of step cannot recover: remove it from the game.
          this.reject(ws, err.code, err.message, true);
          await this.disconnect(ws, 'removed');
          return;
        }
        this.emitFrames(frames);
        return;
      }
      case C2S.HASH: {
        const desync = this.lockstep.hash(seat, msg.tick, msg.hash);
        if (desync !== null) {
          // Tell only the players whose state left the majority (all of them without one).
          const raw = encodeServer({ t: S2C.DESYNC, tick: desync.tick });
          for (const other of this.ctx.getWebSockets()) {
            const att = this.attachment(other);
            if (att.client !== null && !att.gone && desync.players.includes(this.room.seatOf(att.client))) this.sendRaw(other, raw);
          }
        }
        return;
      }
      case C2S.RESUME: {
        if (seat < 0) throw new RoomError('Spectators have no seat to resume.', ERRORS.STATE);
        const record = this.room.resumeSeat(seat);
        this.catching.delete(ws);
        const tick = this.lockstep.rejoin(seat, record);
        await this.saveRoom();
        this.broadcast({ t: S2C.BACK, player: seat, client, name: this.clientName(client) ?? 'Player', tick });
        // With nobody else to wait for, frames up to the join tick go out now.
        this.emitFrames(this.lockstep.flush());
        return;
      }
      case C2S.SYNCED:
        // A spectator processed the whole catch-up.
        if (!this.catching.delete(ws)) throw new RoomError('Nothing to confirm.', ERRORS.STATE);
        return;
      case C2S.CHAT:
        this.chatFrom(ws, client, msg.text);
        return;
      case C2S.LEAVE:
        await this.disconnect(ws, 'left');
        this.close(ws, CLOSE_NORMAL, 'bye');
        return;
      default:
        throw new RoomError('The game has already started.', ERRORS.STATE);
    }
  }

  /** Record frames in the order log and send them to everyone. */
  emitFrames(frames) {
    for (const f of frames) {
      this.log?.append(f);
      this.broadcast({ t: S2C.FRAME, ...f });
    }
  }

  async sessionLost() {
    for (const ws of this.ctx.getWebSockets()) {
      this.send(ws, { t: S2C.ERROR, code: ERRORS.SESSION_LOST, message: 'The server lost this game. Please start a new one.' });
      this.close(ws, CLOSE_NORMAL, 'session lost');
    }
    await this.destroy();
  }

  // ---- Leaving -------------------------------------------------------------------------------

  /** Remove the client behind `ws` from the lobby or game (idempotent). */
  async disconnect(ws, reason) {
    const att = this.attachment(ws);
    this.syncing.delete(ws);
    this.catching.delete(ws);
    if (att.client === null || att.gone) return;
    att.gone = true;
    try {
      ws.serializeAttachment(att);
    } catch {
      // Socket already closed; the attachment no longer matters.
    }
    await this.memberLost(att.client, reason);
  }

  /**
   * A member's connection ended. In the lobby it leaves. In a running game a
   * spectator leaves; a player's seat leaves lockstep and, for a lost
   * connection or a stall, waits RECONNECT_GRACE_MS for a rejoin (FINAL_REASONS
   * end it at once).
   */
  async memberLost(client, reason, now = Date.now()) {
    if (!this.room) return;
    const room = this.room;
    const name = this.clientName(client);
    const final = FINAL_REASONS.includes(reason);
    if (room.phase === 'lobby') {
      room.leave(client);
      await this.saveRoom();
      await this.forgetPresence(client);
      if (name) this.broadcast({ t: S2C.LEFT, player: null, client, name, reason });
      if (room.memberCount() === 0) {
        await this.destroy();
        return;
      }
      this.broadcastLobby();
      await this.syncDirectory();
      return;
    }
    if (room.isSpectator(client)) {
      room.leave(client);
      if (final) room.forgetKey(client);
      await this.saveRoom();
      if (final) await this.forgetPresence(client);
      if (name) this.broadcast({ t: S2C.LEFT, player: null, client, name, reason });
      return;
    }
    const seat = room.seatOf(client);
    if (seat < 0) return;
    const state = room.seatState(seat);
    const rejoinable = !final && REJOINABLE_REASONS.includes(reason) && this.canCatchUp();
    let frames = [];
    let tell = false;
    if (state === 'active') {
      const out = this.lockstep ? this.lockstep.suspend(seat, now) : { frames: [], record: null };
      frames = out.frames;
      if (rejoinable) room.suspendSeat(seat, out.record, now, RECONNECT_GRACE_MS);
      else room.endSeat(seat);
      tell = true;
    } else if (state === 'syncing' || state === 'away') {
      // Everyone was already told it is away; only a final end is news.
      if (rejoinable) room.suspendSeat(seat, null, now, RECONNECT_GRACE_MS);
      else tell = room.endSeat(seat);
    }
    const gone = room.seatState(seat) === 'gone';
    if (gone) room.forgetKey(client);
    await this.saveRoom();
    if (gone) await this.forgetPresence(client);
    // A lost connection that cannot be rejoined (the order log is full) is reported as final.
    if (tell && name) this.broadcast({ t: S2C.LEFT, player: seat, client, name, reason: final || rejoinable ? reason : 'expired' });
    this.emitFrames(frames);
    await this.endIfOver();
  }

  /** The game ends when no seat can play or come back any more. */
  async endIfOver() {
    if (this.room?.phase === 'game' && this.room.liveSeats().length === 0) await this.destroy();
  }

  kick(client) {
    const ws = this.socketOf(client);
    if (!ws) return;
    const att = this.attachment(ws);
    att.gone = true;
    ws.serializeAttachment(att);
    this.room.forgetKey(client);
    this.send(ws, { t: S2C.ERROR, code: ERRORS.KICKED, message: 'The host removed you from the session.' });
    this.close(ws, CLOSE_NORMAL, 'kicked');
    // The slot is already taken over by the host's change; tell everyone.
    const name = this.room.nameOf(client);
    if (name) this.broadcast({ t: S2C.LEFT, player: null, client, name, reason: 'kicked' });
  }

  // ---- Alarm -----------------------------------------------------------------------------------

  async alarm() {
    if (!this.meta || !this.room) return;
    const now = Date.now();
    // Sockets that never said hello are closed.
    for (const ws of this.ctx.getWebSockets()) {
      const att = this.attachment(ws);
      if (att.client === null && now - att.since > HELLO_TIMEOUT_MS) this.close(ws, CLOSE_POLICY, 'hello timeout');
    }
    if (this.room.phase === 'game') {
      if (!this.lockstep) return this.sessionLost();
      for (const seat of this.lockstep.silent(now, DROP_AFTER_MS)) {
        const client = this.room.seats[seat];
        const ws = this.socketOf(client);
        if (ws) {
          const message = this.canCatchUp() ? 'You were dropped for holding up the game. You can rejoin.' : 'You were dropped for not responding.';
          this.send(ws, { t: S2C.ERROR, code: ERRORS.DROPPED, message });
          await this.disconnect(ws, 'dropped');
          this.close(ws, CLOSE_NORMAL, 'dropped');
        } else {
          await this.memberLost(client, 'dropped', now);
        }
        if (!this.room) return;
      }
      // Spectators that never confirmed their catch-up.
      for (const [ws, c] of [...this.catching]) {
        if (c.role !== 'spectator' || c.until > now) continue;
        this.catching.delete(ws);
        this.reject(ws, ERRORS.DROPPED, 'You did not catch up with the game in time.', true);
        await this.disconnect(ws, 'expired');
        if (!this.room) return;
      }
      // Seats that did not come back (or did not catch up) in time.
      for (const seat of this.room.expiredSeats(now)) {
        const client = this.room.seats[seat];
        const ws = this.socketOf(client);
        if (ws) {
          const att = this.attachment(ws);
          att.gone = true;
          ws.serializeAttachment(att);
          this.syncing.delete(ws);
          this.catching.delete(ws);
          this.send(ws, { t: S2C.ERROR, code: ERRORS.DROPPED, message: 'You did not catch up with the game in time.' });
          this.close(ws, CLOSE_NORMAL, 'expired');
        }
        await this.memberLost(client, 'expired', now);
        if (!this.room) return;
      }
      if (this.meta) await this.ctx.storage.setAlarm(now + GAME_ALARM_MS);
      return;
    }
    if (this.room.memberCount() === 0) {
      const expires = this.meta.createdAt + UNUSED_TTL_MS;
      if (!this.meta.everJoined && now < expires) {
        await this.ctx.storage.setAlarm(Math.min(expires, now + HELLO_TIMEOUT_MS));
        return;
      }
      await this.destroy();
      return;
    }
    await this.syncDirectory(true);
    await this.ctx.storage.setAlarm(now + HEARTBEAT_MS);
  }

  async ensureAlarm(at) {
    const cur = await this.ctx.storage.getAlarm();
    if (cur === null || cur > at) await this.ctx.storage.setAlarm(at);
  }

  /** Delete the session: directory row, storage and alarm. */
  async destroy() {
    const id = this.meta?.id;
    this.meta = null;
    this.room = null;
    this.lockstep = null;
    this.log = null;
    this.syncing.clear();
    this.catching.clear();
    if (id) {
      try {
        await removeSession(this.env.DB, id);
        await this.env.DB.prepare('DELETE FROM game_presence WHERE session_id = ?1').bind(id).run();
      } catch (err) {
        console.error('directory delete failed', err?.message);
      }
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    for (const ws of this.ctx.getWebSockets()) this.close(ws, CLOSE_NORMAL, 'session closed');
  }

  // ---- Accounts and bans ---------------------------------------------------------------------------

  /** Whether `name` is (after folding) the username of an account; true when that cannot be checked. */
  async nameBelongsToAccount(name) {
    try {
      return (await this.env.DB.prepare('SELECT 1 AS taken FROM users WHERE username_key = ?1').bind(usernameKey(name)).first()) !== null;
    } catch (err) {
      console.error('username check failed', err?.message);
      return true;
    }
  }

  /** Record a member in D1 game_presence (account and address), so bans can find it. */
  async notePresence(client, att) {
    if (!this.meta) return;
    const rec = ipRecord(att.ip);
    try {
      await this.env.DB.prepare(
        `INSERT INTO game_presence (session_id, client, user_id, ip_v, ip_hex, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(session_id, client) DO UPDATE SET user_id = excluded.user_id, ip_v = excluded.ip_v, ip_hex = excluded.ip_hex, updated_at = excluded.updated_at`,
      )
        .bind(this.meta.id, client, att.account?.id ?? null, rec?.v ?? null, rec?.hex ?? null, Date.now())
        .run();
    } catch (err) {
      console.error('presence update failed', err?.message);
    }
  }

  async forgetPresence(client) {
    if (!this.meta) return;
    try {
      await this.env.DB.prepare('DELETE FROM game_presence WHERE session_id = ?1 AND client = ?2').bind(this.meta.id, client).run();
    } catch (err) {
      console.error('presence delete failed', err?.message);
    }
  }

  /**
   * RPC from the Worker after a ban: drop every connection of the banned
   * accounts (`userIds`) or from the banned range (`range`: { v, start, end }),
   * for good (reason `removed`: no rejoin). Away seats of banned accounts end
   * too. Returns how many members were dropped.
   */
  async evict({ userIds = [], range = null } = {}) {
    if (!this.meta || !this.room) return 0;
    const ids = new Set(userIds);
    let dropped = 0;
    for (const ws of this.ctx.getWebSockets()) {
      const att = this.attachment(ws);
      if (att.gone) continue;
      const byAccount = att.account !== null && att.account !== undefined && ids.has(att.account.id);
      const byIp = range !== null && inRange(att.ip, range);
      if (!byAccount && !byIp) continue;
      const code = byAccount ? ERRORS.BANNED : ERRORS.IP_BANNED;
      this.send(ws, { t: S2C.ERROR, code, message: 'You were removed from this game: the account or network is banned.' });
      if (att.client !== null) {
        dropped++;
        await this.disconnect(ws, 'removed');
      }
      this.close(ws, CLOSE_POLICY, code);
      if (!this.room) return dropped;
    }
    if (this.room.phase === 'game') {
      for (const [id, account] of Object.entries(this.room.accounts)) {
        if (!ids.has(account)) continue;
        const client = Number(id);
        if (this.socketOf(client)) continue;
        const seat = this.room.seatOf(client);
        if (seat >= 0 && this.room.seatState(seat) !== 'gone') {
          dropped++;
          await this.memberLost(client, 'removed');
          if (!this.room) return dropped;
        } else {
          this.room.forgetKey(client);
        }
      }
      await this.saveRoom();
    }
    return dropped;
  }

  // ---- Directory ---------------------------------------------------------------------------------

  async syncDirectory(heartbeat = false) {
    if (!this.meta?.public || !this.room) return;
    const snapshot = {
      id: this.meta.id,
      name: this.meta.name,
      host: this.room.hostName() ?? '',
      public: true,
      locked: this.meta.password !== null,
      players: this.room.humans().length,
      maxPlayers: this.meta.maxPlayers,
      map: this.room.map,
      version: this.meta.version,
      state: this.room.phase === 'lobby' ? 'lobby' : 'game',
    };
    const key = JSON.stringify(snapshot);
    if (!heartbeat && key === this.lastDirectory) return;
    try {
      await upsertSession(this.env.DB, snapshot);
      this.lastDirectory = key;
    } catch (err) {
      console.error('directory update failed', err?.message);
    }
  }

  // ---- Helpers ---------------------------------------------------------------------------------------

  attachment(ws) {
    return ws.deserializeAttachment() ?? { client: null, ip: 'unknown', since: 0 };
  }

  socketOf(client) {
    for (const ws of this.ctx.getWebSockets()) {
      const att = this.attachment(ws);
      if (att.client === client && !att.gone) return ws;
    }
    return null;
  }

  clientName(client) {
    return this.room ? this.room.nameOf(client) : null;
  }

  async saveRoom() {
    await this.ctx.storage.put('room', this.room.toJSON());
  }

  /** Chat from a connection, with its own rate limit (spectators cannot flood every socket). */
  chatFrom(ws, client, textValue) {
    let bucket = this.chatBuckets.get(ws);
    if (!bucket) {
      bucket = new TokenBucket(CHAT_RATE, CHAT_BURST);
      this.chatBuckets.set(ws, bucket);
    }
    if (bucket.take()) return this.chat(client, textValue);
    if (bucket.refused > CHAT_FLOOD_LIMIT) return this.reject(ws, ERRORS.RATE_LIMITED, 'Too many chat messages.', true);
    if (bucket.refused % 5 === 1) this.send(ws, { t: S2C.ERROR, code: ERRORS.RATE_LIMITED, message: 'Chat is limited to one line a second.' });
  }

  chat(client, textValue) {
    const name = this.clientName(client);
    if (!name) return;
    this.broadcast({ t: S2C.CHAT, from: client, name, text: textValue });
  }

  broadcastLobby() {
    this.broadcast({ t: S2C.LOBBY, ...this.room.lobbyView() });
  }

  broadcast(msg) {
    const raw = encodeServer(msg);
    for (const ws of this.ctx.getWebSockets()) {
      const att = this.attachment(ws);
      if (att.client === null || att.gone) continue;
      const queue = this.syncing.get(ws);
      if (queue) {
        // Catching up: frames follow the log, other news is not needed.
        if (msg.t === S2C.FRAME) queue.push({ tick: msg.tick, orders: msg.orders });
        continue;
      }
      this.sendRaw(ws, raw);
    }
  }

  send(ws, msg) {
    this.sendRaw(ws, encodeServer(msg));
  }

  sendRaw(ws, raw) {
    try {
      ws.send(raw);
    } catch {
      // Closed socket: its close handler cleans up.
    }
  }

  reject(ws, code, message, closeIt) {
    this.sendRaw(ws, errorMessage(code, message));
    if (closeIt) this.close(ws, CLOSE_POLICY, code);
  }

  close(ws, code, reason) {
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
  }
}

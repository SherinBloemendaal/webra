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
//
// Map sharing (docs/security.md "Map sharing"): the host shares a map file
// with this session only (`shareMap`, from POST /api/sessions/<id>/map); it
// is stored unlisted and served to the session's members only (`memberMap`,
// from GET /api/sessions/<id>/map, checked with the member's rejoin key and
// account). Members report whether they installed or declined the lobby map
// (`mapstate`); the game starts only when everyone has it.
//
// Online saves: players agree to save (`save`); at the save point (a hash
// tick) every player reports its state hash, and when they all match the
// session records the save in D1 (onlinesaves.js) and every player's client
// stores the file. Resuming: the host uploads its save file
// (POST /api/sessions/<id>/resume, checked by the Worker against that
// record); `loadSave` turns the lobby into the saved game, whose players come
// back by account. At the start every client fast-forwards through the saved
// orders (the catch-up of a rejoin) and the relay starts after the save point
// once every player caught up (`resumeStart`).
//
// Rematch: the host proposes playing again (`rematch`), every active player
// accepts, and the session goes back to its lobby (room.js `backToLobby`).
// The members reload their page and come back with their rejoin keys
// (`rejoinLobby`); a lost connection does not cost a returning member its
// place until its return deadline.
//
// Protocol 8 (docs/contracts.md section 4):
// - the start gate: the relay emits nothing past the empty start frames
//   until every player reported `loaded` (lockstep.js `loading`); a player
//   that does not within LOAD_TIMEOUT_MS is dropped (it can rejoin). Rejoins
//   and resumed saves need no `loaded`: their `resume` says they caught up;
// - network quality: `ping` is answered at once with `pong`; the sender's
//   last measurement is kept in its socket attachment (it survives
//   hibernation) and `netstat` goes to the whole room at most every
//   NETSTAT_INTERVAL_MS, sent while handling a ping, so no alarm has to wake
//   the lobby for it. In the game the alarm (every second) sends `waiting`
//   while lockstep waits for a player beyond HOLD_GRACE_MS, and
//   `waiting` with client null once it runs again; `stalls` answers with the
//   game's stall log;
// - invite codes: the host issues one (`newInvite`, invites.js); members see
//   it in `lobby.invite`; it ends with the lobby;
// - blocks: a signed-in player blocked by a present member cannot join;
// - the directory has a row for every session (private ones are not
//   listed) with a summary for the detail panel and the friends list.

import { DurableObject } from 'cloudflare:workers';
import {
  C2S,
  coopMission,
  DROP_AFTER_MS,
  INVITE_TTL_MS,
  NET_SILENT_MS,
  NETSTAT_INTERVAL_MS,
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
  FramesDigest,
  optionsDigest,
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
import { HEARTBEAT_MS, removeSession, sessionSummary, upsertSession } from './directory.js';
import { expireInviteCodes, issueInviteCode } from './invites.js';
import { Lockstep, LockstepError } from './lockstep.js';
import { lookupMap, mapTextByHash, storeMap } from './maps.js';
import { gunzip, gzip, OrderLog } from './orderlog.js';
import { missionDigest, recordSave } from './onlinesaves.js';
import { TokenBucket } from './ratelimit.js';
import { Room, RoomError } from './room.js';
import { cheatsAllowed, ordersFitRules } from './validate.js';
import { inRange, ipRecord } from './accounts/ip.js';
import { AUTH_HEADER } from './accounts/play.js';
import ENGINE_RULES from '../../../engine/rules.json' with { type: 'json' };
import { logError } from './telemetry.js';

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
/** Pings per connection: twice a second at most, bursts of six ("Test again" sends three at once). */
const PING_RATE = 2;
const PING_BURST = 6;
/** Stall log requests per connection: one every five seconds, bursts of two. */
const STALLS_RATE = 0.2;
const STALLS_BURST = 2;
/** A directory change that only touches the summary waits this long after the last write. */
const SUMMARY_WRITE_MS = 10 * 1000;
/** Reasons after which a member can never come back. */
const FINAL_REASONS = ['left', 'kicked', 'removed', 'expired'];

/**
 * How long the players of a resumed save have to catch up before the game
 * goes on without them (they can rejoin later): their clients only
 * re-simulate the saved orders, so this is much shorter than a rejoin's
 * allowance: 60 s plus 1 ms per saved tick, at most 3 minutes.
 */
export const RESUME_START_BASE_MS = 60_000;
export const RESUME_START_MAX_MS = 3 * 60_000;
export function resumeStartMs(ticks) {
  return Math.min(RESUME_START_MAX_MS, RESUME_START_BASE_MS + ticks);
}

/** An RPC answer the Worker turns into an HTTP error. */
const rpcError = (status, code, message) => ({ ok: false, status, code, message });

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
    this.lastDirectoryCore = null;
    this.lastDirectoryAt = 0;
    this.pingBuckets = new WeakMap();
    this.stallBuckets = new WeakMap();
    /** When `netstat` last went out. */
    this.lastNetstat = 0;
    /** The client the room was last told the game waits for, or null. */
    this.waitingFor = null;
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

  /**
   * Who a map request comes from: a member's `{ client, key }` (its rejoin
   * key), checked like a rejoin (constant time, bound to the account it was
   * issued to, failures count toward the per-IP lockout). Returns the client
   * id, or an RPC error.
   */
  async checkMember(member, account, ip) {
    const now = Date.now();
    const fail = this.failures.get(ip);
    if (fail && fail.until > now) return rpcError(429, ERRORS.RATE_LIMITED, 'Too many attempts. Try again later.');
    const client = member?.client;
    const stored = Number.isInteger(client) && Object.hasOwn(this.room.keys, client) ? this.room.keys[client] : null;
    // Unknown clients still pay for a hash, so timing does not tell them apart.
    const valid = await verifySeatKey(String(member?.key ?? ''), stored ?? '00'.repeat(32));
    if (!this.room) return rpcError(404, ERRORS.NOT_FOUND, 'No such session.');
    if (!valid || stored === null || this.room.accountOf(client) !== (account?.id ?? null)) {
      this.noteFailure(ip, now);
      return rpcError(403, ERRORS.FORBIDDEN, 'You are not a member of this session.');
    }
    const room = this.room;
    const seat = room.seatOf(client);
    const present = room.phase === 'lobby' ? room.isMember(client) : room.isSpectator(client) || (seat >= 0 && room.seatState(seat) !== 'gone');
    if (!present) return rpcError(403, ERRORS.FORBIDDEN, 'You are not a member of this session.');
    return client;
  }

  /**
   * RPC from the Worker (POST /api/sessions/<id>/map): the host shares a map
   * file with this session. `prepared` was validated by the Worker (protocol
   * package and engine, prepareMap in maps.js). It is stored unlisted and
   * becomes the lobby map. Returns { ok, id, hash } or an RPC error.
   */
  async shareMap({ member, account = null, ip = 'unknown', prepared }) {
    if (!this.meta || !this.room) return rpcError(404, ERRORS.NOT_FOUND, 'No such session.');
    const client = await this.checkMember(member, account, ip);
    if (typeof client !== 'number') return client;
    const problem = () => {
      if (!this.room) return rpcError(404, ERRORS.NOT_FOUND, 'No such session.');
      if (this.room.phase !== 'lobby') return rpcError(409, ERRORS.STATE, 'The game has already started.');
      if (!this.room.isHost(client)) return rpcError(403, ERRORS.NOT_HOST, 'Only the host can change the map.');
      if (this.room.resume) return rpcError(409, ERRORS.FORBIDDEN, 'A resumed game keeps its saved map.');
      return null;
    };
    if (problem()) return problem();
    const { created, ...summary } = await storeMap(this.env.DB, prepared, { listed: false, uploaderId: account?.id ?? null });
    // Re-checked after the await: the host or the phase may have changed.
    if (problem()) return problem();
    try {
      this.room.setMap(client, summary);
    } catch (err) {
      if (err instanceof RoomError) return rpcError(409, err.code, err.message);
      throw err;
    }
    await this.saveRoom();
    this.broadcastLobby();
    await this.syncDirectory();
    return { ok: true, id: summary.id, hash: summary.hash, created };
  }

  /**
   * RPC from the Worker (GET /api/sessions/<id>/map?hash=): the canonical
   * text of the lobby's map, or of the running game's, for a member. `hash`
   * pins it: a map that changed meanwhile is refused (409).
   */
  async memberMap({ member, account = null, ip = 'unknown', hash }) {
    if (!this.meta || !this.room) return rpcError(404, ERRORS.NOT_FOUND, 'No such session.');
    const client = await this.checkMember(member, account, ip);
    if (typeof client !== 'number') return client;
    if (!this.room) return rpcError(404, ERRORS.NOT_FOUND, 'No such session.');
    const current = this.room.phase === 'lobby' ? this.room.map : (this.room.startMsg?.map ?? null);
    if (!current) return rpcError(404, ERRORS.NOT_FOUND, 'This session plays on a generated map.');
    if (current.hash !== hash) return rpcError(409, ERRORS.STATE, 'The session has another map now.');
    const textValue = await mapTextByHash(this.env.DB, hash);
    if (textValue === null) return rpcError(404, ERRORS.NOT_FOUND, 'The map is no longer stored. The host can share it again.');
    return { ok: true, text: textValue };
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
    if (msg.t === C2S.PING) return this.ping(ws, att, msg);

    try {
      if (this.room.phase === 'lobby') await this.lobbyMessage(ws, att.client, msg);
      else await this.gameMessage(ws, att.client, msg);
    } catch (err) {
      if (err instanceof RoomError || err instanceof LockstepError) {
        this.reject(ws, err.code, err.message, false);
        return;
      }
      logError('session message failed', err);
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
    // A member who blocked this account does not want it here (docs/security.md "Friends and presence").
    if (att.account && (await this.blockedByMember(att.account.id))) {
      return this.reject(ws, ERRORS.FORBIDDEN, 'You cannot join this session.', true);
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
    // The start of a resumed save: everyone re-simulates the saved orders (see resumeStartMs).
    if (!this.lockstep && this.room?.resumeStart) return resumeStartMs(this.room.resumeStart.ticks);
    return Math.min(RESUME_MAX_MS, RESUME_TIMEOUT_MS + (this.lockstep?.next ?? 0) * RESUME_MS_PER_TICK);
  }

  /** Whether a member can still catch up with the running game (relay and full log present). */
  canCatchUp() {
    return this.room?.phase === 'game' && (this.lockstep !== null || this.room.resumeStart !== null) && this.log !== null && !this.log.full;
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
    if (this.room.phase === 'lobby') return this.rejoinLobby(ws, att, msg, now);
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
    if (!this.lockstep && !this.room.resumeStart) return this.sessionLost();
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
   * `hello` with `rejoin` in the lobby: a member of the finished game comes
   * back after a rematch (its page reloaded). Same key checks as a game
   * rejoin; possible again until the return deadline (a newer connection
   * replaces an older one), so a reload or a dropped connection during the
   * return never costs the place.
   */
  async rejoinLobby(ws, att, msg, now) {
    const client = msg.rejoin.client;
    const stored = Object.hasOwn(this.room.keys, client) ? this.room.keys[client] : null;
    att.busy = true;
    ws.serializeAttachment(att);
    let valid;
    try {
      valid = await verifySeatKey(msg.rejoin.key, stored ?? '00'.repeat(32));
    } finally {
      att.busy = false;
    }
    if (!this.meta || !this.room) return this.reject(ws, ERRORS.NOT_FOUND, 'This session no longer exists.', true);
    if (!valid || stored === null || this.room.accountOf(client) !== (att.account?.id ?? null)) {
      this.noteFailure(att.ip, now);
      return this.reject(ws, ERRORS.FORBIDDEN, 'Invalid rejoin key.', true);
    }
    if (!this.room.isReturning(client)) return this.reject(ws, ERRORS.STATE, 'The game is not running.', true);
    try {
      this.room.returned(client, now);
    } catch (err) {
      if (err instanceof RoomError) return this.reject(ws, err.code, err.message, true);
      throw err;
    }
    // A connection of the member that is still open (the old page) is replaced.
    const old = this.socketOf(client);
    if (old && old !== ws) {
      const oldAtt = this.attachment(old);
      oldAtt.gone = true;
      old.serializeAttachment(oldAtt);
      this.send(old, { t: S2C.ERROR, code: ERRORS.STATE, message: 'You joined from another connection.' });
      this.close(old, CLOSE_NORMAL, 'replaced');
    }
    att.client = client;
    att.role = this.room.slotOf(client) >= 0 ? 'player' : 'spectator';
    ws.serializeAttachment(att);
    await this.saveRoom();
    await this.notePresence(client, att);
    this.send(ws, { t: S2C.WELCOME, you: client, name: this.clientName(client) ?? 'Player', hostId: this.room.hostId, session: this.sessionInfo(), role: att.role });
    this.broadcastLobby();
    await this.syncDirectory();
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
      logError('order log read failed', err);
      this.syncing.delete(ws);
      await this.disconnect(ws, 'disconnected');
      return this.reject(ws, ERRORS.INTERNAL, 'Could not load the game. Try again.', true);
    }
    const queued = this.syncing.get(ws);
    this.syncing.delete(ws);
    if (!queued || !this.room || this.attachment(ws).gone) return;
    const pending = this.room.resumeStart;
    if (!this.lockstep && !pending) return;
    // A resumed save whose relay waits for every player: the log ends at the save point.
    const tick = queued.length > 0 ? queued[0].tick : this.lockstep ? this.lockstep.next : pending.ticks;
    const agreed = this.lockstep ? this.lockstep.agreed : { tick: pending.ticks - 1, hash: pending.hash };
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
      case C2S.SLOTS: {
        // The host's bulk edit: every change checked like a `slot` message, all or none.
        const { kicked } = room.setSlots(client, msg.changes);
        await this.saveRoom();
        for (const k of kicked) this.kick(k);
        this.broadcastLobby();
        await this.syncDirectory();
        return;
      }
      case C2S.OPTIONS:
        room.setOptions(client, msg.options);
        await this.saveRoom();
        this.broadcastLobby();
        await this.syncDirectory();
        return;
      case C2S.MAP: {
        if (!room.isHost(client)) throw new RoomError('Only the host can change the map.', ERRORS.NOT_HOST);
        let map = null;
        if (msg.map !== null) {
          // Upgraded to the current map format first: the lobby names the map every client plays.
          map = await lookupMap(this.env.DB, msg.map.id, msg.map.hash);
          if (!map) throw new RoomError('Unknown map.', ERRORS.NOT_FOUND);
          if (map.refused) throw new RoomError(map.refused, ERRORS.INVALID);
        }
        // Re-validated inside setMap (host and phase may have changed during the lookup).
        room.setMap(client, map);
        await this.saveRoom();
        this.broadcastLobby();
        await this.syncDirectory();
        return;
      }
      case C2S.MISSION:
        // Validated by the protocol against the co-op missions of this version.
        room.setMission(client, msg.mission);
        await this.saveRoom();
        this.broadcastLobby();
        await this.syncDirectory();
        return;
      case C2S.READY:
        room.setReady(client, msg.ready, msg.mapHash);
        await this.saveRoom();
        this.broadcastLobby();
        return;
      case C2S.CHAT:
        this.chatFrom(ws, client, msg.text, !!msg.team);
        return;
      case C2S.START:
        await this.startGame(client);
        return;
      case C2S.SPECTATORS:
        room.setMaxSpectators(client, msg.max);
        await this.saveRoom();
        this.broadcastLobby();
        await this.syncDirectory();
        return;
      case C2S.SPECTATE:
        room.spectate(client, msg.on);
        ws.serializeAttachment({ ...this.attachment(ws), role: msg.on ? 'spectator' : 'player' });
        await this.saveRoom();
        this.broadcastLobby();
        await this.syncDirectory();
        return;
      case C2S.MAPSTATE:
        room.setMapState(client, msg.hash, msg.state);
        await this.saveRoom();
        this.broadcastLobby();
        return;
      case C2S.KICK: {
        const target = room.kickSpectator(client, msg.client);
        await this.saveRoom();
        this.kick(target);
        await this.forgetPresence(target);
        this.broadcastLobby();
        await this.syncDirectory();
        return;
      }
      case C2S.LEAVE:
        await this.disconnect(ws, 'left');
        this.close(ws, CLOSE_NORMAL, 'bye');
        return;
      case C2S.STALLS:
        // No game, no stalls (a finished game's log went with its relay).
        if (this.takeStallsToken(ws)) this.send(ws, { t: S2C.STALLS, stalls: [], totals: [] });
        return;
      case C2S.ORDERS:
      case C2S.HASH:
      case C2S.RESUME:
      case C2S.SYNCED:
      case C2S.REMATCH:
      case C2S.SAVE:
      case C2S.LOADED:
        throw new RoomError('The game has not started.', ERRORS.STATE);
      default:
        throw new RoomError('Unexpected message.', ERRORS.BAD_MESSAGE);
    }
  }

  async startGame(client) {
    if (this.room.resume) return this.startResumed(client);
    const start = this.room.start(client, randomInt);
    const humans = this.room.seats.map((c, i) => (c === null ? -1 : i)).filter((i) => i >= 0);
    // The start gate: nothing past the start frames until every player's loading screen closed.
    this.lockstep = new Lockstep({ players: humans, delay: start.delay, loading: humans });
    this.log = new OrderLog(this.ctx.storage);
    this.meta.startedAt = Date.now();
    await this.ctx.storage.put('meta', this.meta);
    await this.endInvite();
    await this.saveRoom();
    this.broadcast({ t: S2C.START, ...start });
    this.emitFrames(this.lockstep.initialFrames());
    await this.syncDirectory();
    await this.ctx.storage.setAlarm(Date.now() + GAME_ALARM_MS);
  }

  // ---- Resuming an online save ----------------------------------------------------------------

  /**
   * RPC from the Worker before it reads a resume upload: whether `member`
   * is the host of this lobby (cheap; the upload is checked again by `loadSave`).
   */
  async checkHost({ member, account = null, ip = 'unknown' }) {
    if (!this.meta || !this.room) return rpcError(404, ERRORS.NOT_FOUND, 'No such session.');
    const client = await this.checkMember(member, account, ip);
    if (typeof client !== 'number') return client;
    if (!this.room || this.room.phase !== 'lobby') return rpcError(409, ERRORS.STATE, 'The game has already started.');
    if (!this.room.isHost(client)) return rpcError(403, ERRORS.NOT_HOST, 'Only the host can resume a saved game.');
    return { ok: true };
  }

  /**
   * RPC from the Worker (POST /api/sessions/<id>/resume): the host loads a
   * saved online game into this lobby. The Worker checked the file against
   * the save record (state hash, frames and options digests, map hash) and
   * that the requester played in it. `resume`: { id, title, createdAt,
   * engine, ticks, hash, options, seats: [account | null] per player },
   * `frames`: the saved orders, `prepared`: the map (prepareMap) or null.
   */
  async loadSave({ member, account = null, ip = 'unknown', resume, frames, prepared = null, mission = null }) {
    if (!this.meta || !this.room) return rpcError(404, ERRORS.NOT_FOUND, 'No such session.');
    const client = await this.checkMember(member, account, ip);
    if (typeof client !== 'number') return client;
    const problem = () => {
      if (!this.room) return rpcError(404, ERRORS.NOT_FOUND, 'No such session.');
      if (this.room.phase !== 'lobby') return rpcError(409, ERRORS.STATE, 'The game has already started.');
      if (!this.room.isHost(client)) return rpcError(403, ERRORS.NOT_HOST, 'Only the host can resume a saved game.');
      if (resume.engine !== this.meta.version) return rpcError(409, ERRORS.VERSION, 'This save was made by another game version.');
      if (account === null || !resume.seats.includes(account.id)) return rpcError(403, ERRORS.FORBIDDEN, 'You did not play in this saved game.');
      return null;
    };
    if (problem()) return problem();
    const map = prepared ? (({ created: _c, ...summary }) => summary)(await storeMap(this.env.DB, prepared, { listed: false, uploaderId: account.id })) : null;
    if (problem()) return problem();
    if (!mission && (map?.hash ?? null) !== (resume.mapHash ?? null)) return rpcError(422, ERRORS.INVALID, 'The saved map does not match.');
    // The saved orders wait in storage (the object may sleep while the lobby fills).
    const old = this.room.resume?.chunks ?? 0;
    const chunks = [];
    let chunk = [];
    let bytes = 0;
    for (const f of frames) {
      const size = JSON.stringify(f).length + 1;
      if (chunk.length && bytes + size > 64 * 1024) {
        chunks.push(chunk);
        chunk = [];
        bytes = 0;
      }
      chunk.push(f);
      bytes += size;
    }
    if (chunk.length) chunks.push(chunk);
    try {
      this.room.setMap(client, map, { resume: true });
      this.room.setMission(client, mission, { resume: true });
      this.room.loadResume(client, { id: resume.id, title: resume.title, createdAt: resume.createdAt, ticks: resume.ticks, hash: resume.hash, options: resume.options, seats: resume.seats, chunks: chunks.length });
    } catch (err) {
      if (err instanceof RoomError) return rpcError(409, err.code, err.message);
      throw err;
    }
    for (let i = 0; i < chunks.length; i++) await this.ctx.storage.put(`resume:${i}`, await gzip(JSON.stringify(chunks[i])));
    for (let i = chunks.length; i < old; i++) await this.ctx.storage.delete(`resume:${i}`);
    await this.saveRoom();
    this.broadcastLobby();
    await this.syncDirectory();
    return { ok: true };
  }

  /**
   * Start a resumed save: the order log is rebuilt from the saved orders,
   * every member gets the start message, the log and `sync` (with the saved
   * state hash to check), and the relay waits until every player caught up.
   */
  async startResumed(client) {
    const chunks = this.room.resume.chunks;
    const start = this.room.start(client, randomInt);
    this.meta.startedAt = Date.now();
    await this.ctx.storage.put('meta', this.meta);
    await this.endInvite();
    this.log = new OrderLog(this.ctx.storage);
    for (let i = 0; i < chunks; i++) {
      const bytes = await this.ctx.storage.get(`resume:${i}`);
      for (const [tick, orders] of JSON.parse(await gunzip(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)))) this.log.append({ tick, orders });
      // Sealed log chunks are written before the next one is read: one chunk in memory at a time.
      await this.log.writing;
      await this.ctx.storage.delete(`resume:${i}`);
    }
    this.lockstep = null;
    const now = Date.now();
    const until = now + resumeStartMs(start.resume.ticks);
    for (const s of this.room.seatStates) if (s) s.until = until;
    await this.saveRoom();
    await this.syncDirectory();
    await this.ctx.storage.setAlarm(now + GAME_ALARM_MS);
    for (const ws of this.ctx.getWebSockets()) {
      const att = this.attachment(ws);
      if (att.client === null || att.gone) continue;
      const role = this.room.seatOf(att.client) >= 0 ? 'player' : 'spectator';
      await this.catchUp(ws, att.client, role);
    }
  }

  /**
   * A player of a resumed save did not catch up within resumeStartMs: the
   * game starts without it, and its seat waits RECONNECT_GRACE_MS for a
   * rejoin (not final: a slow device continues once it caught up).
   */
  async dropFromResumeStart(seat, client, now) {
    const ws = this.socketOf(client);
    if (ws) {
      const att = this.attachment(ws);
      att.gone = true;
      ws.serializeAttachment(att);
      this.syncing.delete(ws);
      this.catching.delete(ws);
      this.send(ws, { t: S2C.ERROR, code: ERRORS.DROPPED, message: 'You took too long to catch up; the game goes on. Rejoin to continue.' });
      this.close(ws, CLOSE_NORMAL, 'dropped');
    }
    this.room.awaySeat(seat, now, RECONNECT_GRACE_MS);
    await this.saveRoom();
    const name = this.clientName(client);
    if (name) this.broadcast({ t: S2C.LEFT, player: seat, client, name, reason: 'dropped' });
    await this.maybeStartResumed();
  }

  /** Every player of a resumed save caught up (or is away or gone): the relay starts after the save point. */
  async maybeStartResumed() {
    const room = this.room;
    if (!room?.resumeStart || room.phase !== 'game') return;
    // Nobody still catching up; players who were dropped from the start (away) rejoin later.
    const seats = room.liveSeats();
    if (seats.some((seat) => room.seatState(seat) === 'syncing')) return;
    const live = seats.filter((seat) => room.seatState(seat) === 'active');
    if (live.length === 0) return;
    const { ticks, hash } = room.resumeStart;
    this.lockstep = new Lockstep({ players: live, delay: room.startMsg.delay, start: ticks });
    // Rejoining players and late spectators check against the saved state.
    this.lockstep.agreed = { tick: ticks - 1, hash };
    room.resumeStart = null;
    await this.saveRoom();
    for (const seat of live) this.broadcast({ t: S2C.BACK, player: seat, client: room.seats[seat], name: this.clientName(room.seats[seat]) ?? 'Player', tick: ticks });
    this.emitFrames(this.lockstep.initialFrames());
  }

  // ---- Online saves ---------------------------------------------------------------------------

  /** A `save` message from a player: propose, accept, decline or withdraw. */
  async saveMessage(client, accept, now = Date.now()) {
    const room = this.room;
    const reason = accept && !room.saving ? (room.proposeSave(client, now), null) : room.answerSave(client, accept, now);
    await this.saveRoom();
    if (reason) return this.broadcastSaveEnd(reason);
    return this.saveProgress(now);
  }

  /** Everyone accepted (and is connected): fix the save point; else tell everyone where it stands. */
  async saveProgress(now = Date.now()) {
    const room = this.room;
    if (!room?.saving || room.saving.phase !== 'open' || !this.lockstep) return;
    if (room.saveAgreed((c) => this.lockstep.isActive(room.seatOf(c)))) {
      const tick = room.agreeSave(this.lockstep.next + this.lockstep.delay, now);
      await this.saveRoom();
      this.broadcast({ t: S2C.SAVE, state: 'agreed', tick });
      return;
    }
    this.broadcast({ t: S2C.SAVE, ...room.saveStatus(now) });
  }

  broadcastSaveEnd(reason) {
    this.broadcast({ t: S2C.SAVE, state: 'cancelled', reason });
  }

  /** A player's hash at the save point; once all match, the save is recorded. */
  async saveHash(client, tick, hash) {
    const result = this.room.noteSaveHash(client, tick, hash);
    if (result === null) return;
    const now = Date.now();
    if (result === 'desync') {
      this.room.cancelSave('desync', now);
      await this.saveRoom();
      return this.broadcastSaveEnd('desync');
    }
    const sv = this.room.saving;
    const reason = await this.recordSavePoint(sv.tick, hash, sv.voters, now).catch((err) => {
      logError('online save failed', err);
      return 'failed';
    });
    if (!this.room) return;
    if (typeof reason === 'string') {
      this.room.cancelSave(reason, now);
      await this.saveRoom();
      return this.broadcastSaveEnd(reason);
    }
    this.room.cancelSave('saved', now);
    await this.saveRoom();
    this.broadcast({ t: S2C.SAVE, state: 'saved', id: reason.id, ticks: sv.tick + 1, hash });
  }

  /** Store the record of a save after frame `tick`. Returns { id } or a cancel reason. */
  async recordSavePoint(tick, hash, voters, now) {
    if (!this.log || this.log.full) return 'too_long';
    // Chunk by chunk: one chunk of the order log in memory at a time.
    const digest = new FramesDigest();
    for await (const chunk of this.log.chunks()) {
      for (const f of chunk) if (f[0] <= tick) await digest.add(f);
      if (chunk.length && chunk.at(-1)[0] > tick) break;
    }
    const start = this.room.startMsg;
    const members = this.room.seats.flatMap((c, seat) => (c === null ? [] : [{ seat, userId: this.room.accountOf(c) }]));
    if (members.some((m) => m.userId === null) || members.some((m) => !voters.includes(this.room.seats[m.seat]))) return 'accounts';
    const id = await recordSave(
      this.env.DB,
      {
        engine: this.meta.version,
        title: this.meta.name,
        ticks: tick + 1,
        stateHash: hash,
        framesDigest: digest.value(),
        optionsDigest: await optionsDigest(start.options),
        // A co-op mission is pinned by its record (file hash and options) instead of a map.
        mapHash: start.mission ? await missionDigest(start.mission) : start.map ? start.map.hash : null,
        members,
      },
      now,
    );
    return { id };
  }

  /** A player of the running game is gone (for now): the proposal or the save in progress may end. */
  async saveAfterLoss(client, now) {
    const room = this.room;
    if (!room?.saving || room.phase !== 'game') return;
    const sv = room.saving;
    const gone = (c) => room.seatState(room.seatOf(c)) === 'gone';
    const away = (c) => !this.lockstep?.isActive(room.seatOf(c));
    if (sv.phase === 'open') {
      if (sv.by === client || room.saveProblem()) {
        room.cancelSave('left', now);
        await this.saveRoom();
        return this.broadcastSaveEnd('left');
      }
      return this.saveProgress(now);
    }
    // At the save point every player must report its hash: one who left cannot.
    if (sv.voters.some((c) => gone(c) || (away(c) && sv.hashes[c] === undefined))) {
      room.cancelSave('left', now);
      await this.saveRoom();
      return this.broadcastSaveEnd('left');
    }
  }

  // ---- Game ----------------------------------------------------------------------------------

  async gameMessage(ws, client, msg) {
    if (!this.lockstep && !(this.room.resumeStart && this.log)) {
      // The object was restarted mid-game and lost the in-memory relay.
      await this.sessionLost();
      return;
    }
    const seat = this.room.seatOf(client);
    if (!this.lockstep && ![C2S.RESUME, C2S.SYNCED, C2S.CHAT, C2S.LEAVE, C2S.LOADED, C2S.STALLS].includes(msg.t)) {
      // A resumed save waits for every player to catch up.
      throw new RoomError('The game continues once every player caught up.', ERRORS.STATE);
    }
    if (seat < 0 && (msg.t === C2S.ORDERS || msg.t === C2S.HASH)) {
      // Spectators watch; an honest client never sends either.
      this.reject(ws, ERRORS.FORBIDDEN, 'Spectators cannot send orders.', true);
      await this.disconnect(ws, 'removed');
      return;
    }
    switch (msg.t) {
      case C2S.ORDERS: {
        if (!ordersFitRules(msg.orders, this.actorCount())) {
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
        // The player the room waits for answered: tell everyone at once, not at the next alarm.
        if (this.waitingFor !== null) this.updateWaiting(Date.now(), { onlyChanges: true });
        return;
      }
      case C2S.LOADED: {
        // Spectators, rejoining players and resumed saves have no start gate: ignored.
        if (seat < 0 || !this.lockstep) return;
        this.emitFrames(this.lockstep.loaded(seat));
        return;
      }
      case C2S.STALLS:
        if (this.takeStallsToken(ws)) this.send(ws, { t: S2C.STALLS, ...this.stallLog() });
        return;
      case C2S.HASH: {
        const desync = this.lockstep.hash(seat, msg.tick, msg.hash);
        if (this.room.saving?.phase === 'agreed') await this.saveHash(client, msg.tick, msg.hash);
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
        if (!this.lockstep) {
          // A resumed save: the relay starts when the last player caught up.
          await this.saveRoom();
          await this.maybeStartResumed();
          return;
        }
        const tick = this.lockstep.rejoin(seat, record);
        await this.saveRoom();
        this.broadcast({ t: S2C.BACK, player: seat, client, name: this.clientName(client) ?? 'Player', tick });
        // With nobody else to wait for, frames up to the join tick go out now.
        this.emitFrames(this.lockstep.flush());
        // A proposed rematch now waits for this player too.
        if (this.room.rematch) this.broadcast({ t: S2C.REMATCH, ...this.room.rematchStatus(Date.now()) });
        await this.saveProgress();
        return;
      }
      case C2S.SAVE:
        if (seat < 0) throw new RoomError('Only players save the game.', ERRORS.FORBIDDEN);
        await this.saveMessage(client, msg.accept);
        return;
      case C2S.REMATCH: {
        const now = Date.now();
        const room = this.room;
        const reason = msg.accept && !room.rematch ? (room.proposeRematch(client, now), null) : room.answerRematch(client, msg.accept, now);
        await this.saveRoom();
        if (reason) this.broadcastRematchEnd(reason);
        else await this.rematchProgress(now);
        return;
      }
      case C2S.DEFEATED:
        // The engine defeated this player: it may keep watching (it still
        // sends empty orders and hashes), but its orders are dropped from now on.
        if (seat < 0) throw new RoomError('Spectators have no seat to lose.', ERRORS.STATE);
        this.lockstep.defeat(seat);
        return;
      case C2S.SYNCED:
        // A spectator processed the whole catch-up.
        if (!this.catching.delete(ws)) throw new RoomError('Nothing to confirm.', ERRORS.STATE);
        return;
      case C2S.CHAT:
        this.chatFrom(ws, client, msg.text, !!msg.team);
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
      // Coming back from a rematch: the old page closed its connection; the place waits for the return.
      if (room.isReturning(client) && !final) return;
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
      await this.rematchAfterLoss(client, now);
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
    if (this.waitingFor !== null) this.updateWaiting(now, { onlyChanges: true });
    await this.endIfOver();
    await this.rematchAfterLoss(client, now);
    await this.saveAfterLoss(client, now);
    await this.maybeStartResumed();
  }

  // ---- Rematch -------------------------------------------------------------------------------

  /** Everyone answered yes: back to the lobby; otherwise tell everyone where the proposal stands. */
  async rematchProgress(now = Date.now()) {
    const room = this.room;
    if (!room?.rematch || room.phase !== 'game') return;
    if (room.rematchAgreed()) {
      await this.backToLobby(now);
      return;
    }
    this.broadcast({ t: S2C.REMATCH, ...room.rematchStatus(now) });
  }

  /** A proposal ended without a rematch. */
  broadcastRematchEnd(reason) {
    this.broadcast({ t: S2C.REMATCH, state: 'cancelled', by: null, accepted: [], waiting: [], reason });
  }

  /** A member of the running game is gone (for now): the proposal may end, or be agreed by everyone left. */
  async rematchAfterLoss(client, now) {
    const room = this.room;
    if (!room?.rematch || room.phase !== 'game') return;
    if (room.rematch.by === client) {
      room.cancelRematch('left', now);
      await this.saveRoom();
      this.broadcastRematchEnd('left');
      return;
    }
    await this.rematchProgress(now);
  }

  /**
   * The rematch was agreed: the room goes back to its lobby (room.js
   * `backToLobby`), the relay and the order log are dropped, and every
   * connected member is told to come back (its client reloads and rejoins
   * the lobby with its key).
   */
  async backToLobby(now) {
    const room = this.room;
    const by = room.rematch.by;
    const accepted = room.rematch.accepted.filter((c) => room.rematchVoters().includes(c));
    const before = new Set([...(room.seats ?? []).filter((c) => c !== null), ...room.spectators.map((s) => s.client)]);
    // The players who accepted (also one whose connection is away right now:
    // it comes back with its key) and the spectators watching now.
    const present = [...accepted];
    for (const ws of this.ctx.getWebSockets()) {
      const att = this.attachment(ws);
      if (att.client !== null && !att.gone && room.isSpectator(att.client)) present.push(att.client);
    }
    const back = new Set(room.backToLobby(present, now));
    const log = this.log;
    this.lockstep = null;
    this.waitingFor = null;
    if (this.meta) {
      delete this.meta.startedAt;
      await this.ctx.storage.put('meta', this.meta);
    }
    this.log = null;
    this.syncing.clear();
    this.catching.clear();
    await this.saveRoom();
    try {
      await log?.clear();
    } catch (err) {
      logError('order log clear failed', err);
    }
    for (const c of before) if (!back.has(c)) await this.forgetPresence(c);
    this.broadcast({ t: S2C.REMATCH, state: 'lobby', by, accepted, waiting: [] });
    await this.syncDirectory();
    const next = room.nextReturnDeadline();
    await this.ctx.storage.setAlarm(Math.min(now + HEARTBEAT_MS, next ?? Infinity));
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
      if (!this.lockstep && !(this.room.resumeStart && this.log)) return this.sessionLost();
      const loading = this.lockstep?.starting ?? false;
      for (const seat of this.lockstep ? this.lockstep.silent(now, DROP_AFTER_MS) : []) {
        const client = this.room.seats[seat];
        const ws = this.socketOf(client);
        if (ws) {
          const message = loading
            ? `You did not finish loading in time.${this.canCatchUp() ? ' You can rejoin.' : ''}`
            : this.canCatchUp()
              ? 'You were dropped for holding up the game. You can rejoin.'
              : 'You were dropped for not responding.';
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
        if (this.room.resumeStart && this.room.seatState(seat) === 'syncing') {
          // The start of a resumed save goes on without a slow player, who may rejoin like after a lost connection.
          await this.dropFromResumeStart(seat, client, now);
          if (!this.room) return;
          continue;
        }
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
      // A rematch proposal nobody completed in time.
      if (this.room.rematch && this.room.rematch.until <= now) {
        this.room.cancelRematch('expired', now);
        await this.saveRoom();
        this.broadcastRematchEnd('expired');
      }
      // A save proposal nobody completed, or hashes that never all came.
      if (this.room.saving && this.room.saving.until <= now) {
        this.room.cancelSave('expired', now);
        await this.saveRoom();
        this.broadcastSaveEnd('expired');
      }
      if (this.room?.phase === 'game') {
        this.updateWaiting(now);
        // A summary change (a spectator came or went) that waited for its turn.
        await this.syncDirectory();
      }
      if (this.meta && this.room?.phase === 'game') await this.ctx.storage.setAlarm(now + GAME_ALARM_MS);
      return;
    }
    // The return window after a rematch ended: members who are connected
    // stay, the others did not come back in time and lose their places.
    let returnsChanged = false;
    for (const client of this.room.expiredReturns(now)) {
      if (this.socketOf(client)) {
        this.room.settleReturn(client);
        returnsChanged = true;
        continue;
      }
      await this.memberLost(client, 'expired', now);
      if (!this.room) return;
    }
    if (returnsChanged) await this.saveRoom();
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
    const back = this.room.nextReturnDeadline();
    await this.ctx.storage.setAlarm(Math.min(now + HEARTBEAT_MS, back ?? Infinity));
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
        await expireInviteCodes(this.env.DB, id, Date.now());
        await removeSession(this.env.DB, id);
        await this.env.DB.prepare('DELETE FROM game_presence WHERE session_id = ?1').bind(id).run();
      } catch (err) {
        logError('directory delete failed', err);
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
      logError('username check failed', err);
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
      logError('presence update failed', err);
    }
  }

  async forgetPresence(client) {
    if (!this.meta) return;
    try {
      await this.env.DB.prepare('DELETE FROM game_presence WHERE session_id = ?1 AND client = ?2').bind(this.meta.id, client).run();
    } catch (err) {
      logError('presence delete failed', err);
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

  /**
   * Write the session's directory row when it changed (or as the heartbeat).
   * Every session has one (private ones are never listed). A change of the
   * summary alone (options, AI slots, spectator places) is written at most
   * every SUMMARY_WRITE_MS: the alarm writes it later.
   */
  async syncDirectory(heartbeat = false, now = Date.now()) {
    if (!this.meta || !this.room) return;
    const core = {
      id: this.meta.id,
      name: this.meta.name,
      host: this.room.hostName() ?? '',
      public: this.meta.public,
      locked: this.meta.password !== null,
      players: this.room.humans().length,
      maxPlayers: this.meta.maxPlayers,
      // A co-op mission is listed under its title (directory.js directoryMap).
      map: this.room.mission ? { mission: this.room.mission.id, name: coopMission(this.room.mission.id).title } : this.room.map,
      version: this.meta.version,
      state: this.room.phase === 'lobby' ? 'lobby' : 'game',
    };
    const snapshot = { ...core, summary: sessionSummary(this.room, { startedAt: this.room.phase === 'lobby' ? null : (this.meta.startedAt ?? null) }) };
    const coreKey = JSON.stringify(core);
    const key = JSON.stringify(snapshot);
    if (!heartbeat && key === this.lastDirectory) return;
    if (!heartbeat && coreKey === this.lastDirectoryCore && now - this.lastDirectoryAt < SUMMARY_WRITE_MS) {
      await this.ensureAlarm(this.lastDirectoryAt + SUMMARY_WRITE_MS);
      return;
    }
    try {
      await upsertSession(this.env.DB, snapshot, now);
      this.lastDirectory = key;
      this.lastDirectoryCore = coreKey;
      this.lastDirectoryAt = now;
    } catch (err) {
      logError('directory update failed', err);
    }
  }

  // ---- Network quality --------------------------------------------------------------------------

  /**
   * `ping`: answer with `pong` at once, keep the sender's measurement and,
   * when it is time, tell the room (`netstat`). Pings have their own small
   * budget besides the connection's rate limit; pings beyond it get no pong
   * (an honest client never sends that many), a flood closes the connection.
   */
  ping(ws, att, msg, now = Date.now()) {
    let bucket = this.pingBuckets.get(ws);
    if (!bucket) {
      bucket = new TokenBucket(PING_RATE, PING_BURST, now);
      this.pingBuckets.set(ws, bucket);
    }
    if (!bucket.take(now)) {
      if (bucket.refused > FLOOD_LIMIT) this.reject(ws, ERRORS.RATE_LIMITED, 'Too many pings.', true);
      return;
    }
    this.send(ws, { t: S2C.PONG, n: msg.n, at: msg.at });
    att.net = msg.rtt === undefined ? { ...(att.net ?? { rtt: null, jitter: null, late: null }), at: now } : { rtt: msg.rtt, jitter: msg.jitter, late: msg.late, at: now };
    ws.serializeAttachment(att);
    if (now - this.lastNetstat >= NETSTAT_INTERVAL_MS) this.broadcastNetstat(now);
  }

  /** Whether `client` is a player (holds a lobby slot, or a seat of the running game). */
  isPlayer(client) {
    if (!this.room) return false;
    return this.room.phase === 'lobby' ? this.room.slotOf(client) >= 0 : this.room.seatOf(client) >= 0;
  }

  /** The `netstat` entries: every connected player's last measurement (spectators are not listed). */
  netstatPlayers(now = Date.now()) {
    const out = new Map();
    for (const ws of this.ctx.getWebSockets()) {
      const att = this.attachment(ws);
      if (att.client === null || att.gone || out.has(att.client) || !this.isPlayer(att.client)) continue;
      const net = att.net ?? null;
      const entry = { client: att.client, rtt: net?.rtt ?? null, jitter: net?.jitter ?? null, late: net?.late ?? null };
      const quiet = now - (net?.at ?? att.since ?? now);
      if (quiet > NET_SILENT_MS) entry.silent = Math.min(quiet, 24 * 60 * 60 * 1000);
      out.set(att.client, entry);
    }
    return [...out.values()];
  }

  broadcastNetstat(now = Date.now()) {
    this.lastNetstat = now;
    this.broadcast({ t: S2C.NETSTAT, players: this.netstatPlayers(now) });
  }

  /**
   * Tell the room whom the game waits for (`waiting`, every alarm while it
   * waits: the times move on), and `waiting` with client null once it runs
   * again. `onlyChanges`: only when the answer is another client than before.
   */
  updateWaiting(now = Date.now(), { onlyChanges = false } = {}) {
    const w = this.room?.phase === 'game' && this.lockstep ? this.lockstep.waiting(now, DROP_AFTER_MS) : null;
    const client = w ? this.room.seats[w.seat] : null;
    if (client === null) {
      if (this.waitingFor === null) return;
      this.waitingFor = null;
      this.broadcast({ t: S2C.WAITING, client: null });
      return;
    }
    if (onlyChanges && client === this.waitingFor) return;
    this.waitingFor = client;
    this.broadcast({ t: S2C.WAITING, client, heldMs: w.heldMs, dropInMs: w.dropInMs });
  }

  /** The running game's stall log by client: { stalls, totals }. */
  stallLog() {
    const ls = this.lockstep;
    const seats = this.room?.seats ?? [];
    if (!ls) return { stalls: [], totals: [] };
    return {
      stalls: ls.stalls.filter((x) => seats[x.seat] != null).map((x) => ({ tick: x.tick, client: seats[x.seat], ms: x.ms })),
      totals: [...ls.totals].filter(([seat]) => seats[seat] != null).map(([seat, t]) => ({ client: seats[seat], ms: t.ms, count: t.count })),
    };
  }

  takeStallsToken(ws) {
    let bucket = this.stallBuckets.get(ws);
    if (!bucket) {
      bucket = new TokenBucket(STALLS_RATE, STALLS_BURST);
      this.stallBuckets.set(ws, bucket);
    }
    if (bucket.take()) return true;
    this.send(ws, { t: S2C.ERROR, code: ERRORS.RATE_LIMITED, message: 'Ask for the stall log at most every few seconds.' });
    return false;
  }

  // ---- Invite codes -------------------------------------------------------------------------------

  /**
   * RPC from the Worker (POST /api/sessions/<id>/invite): the host gets a new
   * invite code for the lobby; the previous one stops working. Valid while
   * the lobby is open, at most INVITE_TTL_MS. Returns { ok, code, expiresAt }.
   */
  async newInvite({ member, account = null, ip = 'unknown' }) {
    if (!this.meta || !this.room) return rpcError(404, ERRORS.NOT_FOUND, 'No such session.');
    const client = await this.checkMember(member, account, ip);
    if (typeof client !== 'number') return client;
    const problem = () => {
      if (!this.meta || !this.room) return rpcError(404, ERRORS.NOT_FOUND, 'No such session.');
      if (this.room.phase !== 'lobby') return rpcError(409, ERRORS.STATE, 'The game has already started.');
      if (!this.room.isHost(client)) return rpcError(403, ERRORS.NOT_HOST, 'Only the host can make an invite code.');
      return null;
    };
    if (problem()) return problem();
    const now = Date.now();
    const expiresAt = now + INVITE_TTL_MS;
    // The directory row the lookup reads is there before the code is.
    await this.syncDirectory(true, now);
    const code = await issueInviteCode(this.env.DB, this.meta.id, now, expiresAt);
    // Re-checked after the awaits: the game may have started meanwhile.
    const late = problem();
    if (late) {
      if (this.meta) await expireInviteCodes(this.env.DB, this.meta.id, Date.now());
      return late;
    }
    this.meta.invite = { code, expiresAt };
    await this.ctx.storage.put('meta', this.meta);
    this.broadcastLobby();
    return { ok: true, code, expiresAt };
  }

  /** The lobby's code ends (the game starts): in D1 and for the members. */
  async endInvite() {
    if (!this.meta?.invite) return;
    this.meta.invite = null;
    await this.ctx.storage.put('meta', this.meta);
    try {
      await expireInviteCodes(this.env.DB, this.meta.id, Date.now());
    } catch (err) {
      logError('invite expiry failed', err);
    }
  }

  /** `lobby.invite` while the code is valid. */
  inviteView(now = Date.now()) {
    const inv = this.meta?.invite;
    return inv && inv.expiresAt > now ? { invite: { code: inv.code, expiresAt: inv.expiresAt } } : {};
  }

  /**
   * Whether a member present now blocked the account `userId` (D1
   * user_blocks). A failed check lets the player in (blocking is a social
   * tool, not access control; the error is logged).
   */
  async blockedByMember(userId) {
    const members = this.room?.memberAccounts() ?? [];
    if (members.length === 0) return false;
    try {
      const row = await this.env.DB.prepare('SELECT 1 AS b FROM user_blocks WHERE blocked_id = ?1 AND user_id IN (SELECT value FROM json_each(?2)) LIMIT 1')
        .bind(userId, JSON.stringify(members))
        .first();
      return row !== null && row !== undefined;
    } catch (err) {
      logError('block check failed', err);
      return false;
    }
  }

  // ---- Helpers ---------------------------------------------------------------------------------------

  /** Actor types of the running game's rules: a co-op mission's, or the engine's. */
  actorCount() {
    const mission = this.room?.startMsg?.mission;
    return mission ? coopMission(mission.id).actors : ENGINE_RULES.actors.length;
  }

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
  chatFrom(ws, client, textValue, team = false) {
    let bucket = this.chatBuckets.get(ws);
    if (!bucket) {
      bucket = new TokenBucket(CHAT_RATE, CHAT_BURST);
      this.chatBuckets.set(ws, bucket);
    }
    if (bucket.take()) return this.chat(client, textValue, team);
    if (bucket.refused > CHAT_FLOOD_LIMIT) return this.reject(ws, ERRORS.RATE_LIMITED, 'Too many chat messages.', true);
    if (bucket.refused % 5 === 1) this.send(ws, { t: S2C.ERROR, code: ERRORS.RATE_LIMITED, message: 'Chat is limited to one line a second.' });
  }

  /**
   * A chat line to everyone, or with `team` only to the sender's team
   * (OpenRA team chat: players of the same team, a player without a team
   * alone, spectators among themselves).
   */
  chat(client, textValue, team = false) {
    const name = this.clientName(client);
    if (!name) return;
    if (!team) {
      this.broadcast({ t: S2C.CHAT, from: client, name, text: textValue });
      return;
    }
    const side = this.chatSideOf(client);
    const spectators = side === 'spectators' ? { spectators: true } : {};
    this.broadcast({ t: S2C.CHAT, from: client, name, text: textValue, team: true, ...spectators }, (to) => this.chatSideOf(to) === side);
  }

  /**
   * Whose team chat `client` shares (Room.chatTeamOf), except that a player
   * the engine defeated (it reported `defeated`; it reports again after a
   * rejoin) is on the spectators' side: OpenRA sends the team chat of a
   * player with a win state to the spectators (ExtraData uint.MaxValue), and
   * such a player gets the spectators' team chat, no longer its team's.
   */
  chatSideOf(client) {
    const seat = this.room.seatOf(client);
    if (seat >= 0 && this.lockstep?.defeated.has(seat)) return 'spectators';
    return this.room.chatTeamOf(client);
  }

  broadcastLobby() {
    this.broadcast({ t: S2C.LOBBY, ...this.room.lobbyView(), ...this.inviteView() });
  }

  /** Send to every member (or those `to(client)` accepts). */
  broadcast(msg, to = null) {
    const raw = encodeServer(msg);
    for (const ws of this.ctx.getWebSockets()) {
      const att = this.attachment(ws);
      if (att.client === null || att.gone) continue;
      if (to && !to(att.client)) continue;
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

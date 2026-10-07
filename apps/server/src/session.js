// Session Durable Object: one per online game. Uses the WebSocket Hibernation
// API, keeps the lobby in Durable Object storage, and relays lockstep frames
// in memory during the game (docs/contracts.md, section 4).
//
// Trust model: every client message is size checked, rate limited and
// validated with packages/protocol; host-only actions are checked against the
// connection that proved the host key; orders are stamped with the sender's
// seat; map names and flags come from D1, never from the client.

import { DurableObject } from 'cloudflare:workers';
import {
  C2S,
  DROP_AFTER_MS,
  encodeServer,
  ERRORS,
  errorMessage,
  MAX_MESSAGE_BYTES,
  parseClientMessage,
  PROTOCOL_VERSION,
  S2C,
} from '@webra/protocol';
import { hashHostKey, hashPassword, randomInt, randomToken, verifyHostKey, verifyPassword } from './crypto.js';
import { HEARTBEAT_MS, removeSession, upsertSession } from './directory.js';
import { Lockstep, LockstepError } from './lockstep.js';
import { lookupMap } from './maps.js';
import { TokenBucket } from './ratelimit.js';
import { Room, RoomError } from './room.js';

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

const CLOSE_NORMAL = 1000;
const CLOSE_POLICY = 1008;

export class Session extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.meta = null;
    this.room = null;
    this.lockstep = null;
    this.buckets = new WeakMap();
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
    server.serializeAttachment({
      client: null,
      ip: request.headers.get('CF-Connecting-IP') || 'unknown',
      since: Date.now(),
      busy: false,
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
    await this.disconnect(ws, 'disconnected');
  }

  async webSocketError(ws) {
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
    if (this.room.phase !== 'lobby') return this.reject(ws, ERRORS.STATE, 'The game has already started.', true);

    const now = Date.now();
    const fail = this.failures.get(att.ip);
    if (fail && fail.until > now) return this.reject(ws, ERRORS.RATE_LIMITED, 'Too many attempts. Try again later.', true);

    att.busy = true;
    ws.serializeAttachment(att);
    let isHost = false;
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
    } finally {
      att.busy = false;
    }

    // Re-check after the awaits: the room may have changed meanwhile.
    if (!this.meta || !this.room) return this.reject(ws, ERRORS.NOT_FOUND, 'This session no longer exists.', true);
    if (this.room.phase !== 'lobby') return this.reject(ws, ERRORS.STATE, 'The game has already started.', true);
    const hostConnected = this.room.hostId !== null && this.socketOf(this.room.hostId) !== null;
    let joined;
    try {
      joined = this.room.join(msg.name, { host: isHost && !hostConnected });
    } catch (err) {
      if (err instanceof RoomError) return this.reject(ws, err.code, err.message, true);
      throw err;
    }
    att.client = joined.client;
    ws.serializeAttachment(att);
    meta.everJoined = true;
    await this.ctx.storage.put({ meta, room: this.room.toJSON() });

    this.send(ws, {
      t: S2C.WELCOME,
      you: joined.client,
      hostId: this.room.hostId,
      session: {
        id: meta.id,
        name: meta.name,
        public: meta.public,
        locked: meta.password !== null,
        maxPlayers: meta.maxPlayers,
        version: meta.version,
      },
    });
    this.broadcastLobby();
    await this.syncDirectory();
    await this.ensureAlarm(Date.now() + HEARTBEAT_MS);
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
        this.chat(client, msg.text);
        return;
      case C2S.START:
        await this.startGame(client);
        return;
      case C2S.LEAVE:
        await this.disconnect(ws, 'left');
        this.close(ws, CLOSE_NORMAL, 'bye');
        return;
      case C2S.ORDERS:
      case C2S.HASH:
        throw new RoomError('The game has not started.', ERRORS.STATE);
      default:
        throw new RoomError('Unexpected message.', ERRORS.BAD_MESSAGE);
    }
  }

  async startGame(client) {
    const start = this.room.start(client, randomInt);
    const humans = this.room.seats.map((c, i) => (c === null ? -1 : i)).filter((i) => i >= 0);
    this.lockstep = new Lockstep({ players: humans, delay: start.delay });
    await this.saveRoom();
    this.broadcast({ t: S2C.START, ...start });
    for (const frame of this.lockstep.initialFrames()) this.broadcast({ t: S2C.FRAME, ...frame });
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
    switch (msg.t) {
      case C2S.ORDERS: {
        let frames;
        try {
          frames = this.lockstep.submit(seat, msg.tick, msg.orders);
        } catch (err) {
          if (!(err instanceof LockstepError)) throw err;
          // A client out of step cannot recover: remove it from the game.
          this.reject(ws, err.code, err.message, true);
          await this.disconnect(ws, 'dropped');
          return;
        }
        for (const f of frames) this.broadcast({ t: S2C.FRAME, ...f });
        return;
      }
      case C2S.HASH: {
        const desync = this.lockstep.hash(seat, msg.tick, msg.hash);
        if (desync !== null) this.broadcast({ t: S2C.DESYNC, tick: desync });
        return;
      }
      case C2S.CHAT:
        this.chat(client, msg.text);
        return;
      case C2S.LEAVE:
        await this.disconnect(ws, 'left');
        this.close(ws, CLOSE_NORMAL, 'bye');
        return;
      default:
        throw new RoomError('The game has already started.', ERRORS.STATE);
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
    if (att.client === null || att.gone) return;
    att.gone = true;
    try {
      ws.serializeAttachment(att);
    } catch {
      // Socket already closed; the attachment no longer matters.
    }
    await this.removeClient(att.client, reason);
  }

  async removeClient(client, reason) {
    if (!this.room) return;
    const room = this.room;
    const name = this.clientName(client);
    if (room.phase === 'lobby') {
      room.leave(client);
      await this.saveRoom();
      if (name) this.broadcast({ t: S2C.LEFT, player: null, client, name, reason });
      if (room.humans().length === 0) {
        await this.destroy();
        return;
      }
      this.broadcastLobby();
      await this.syncDirectory();
      return;
    }
    const seat = room.seatOf(client);
    if (this.lockstep && seat >= 0 && this.lockstep.isActive(seat)) {
      const frames = this.lockstep.drop(seat);
      if (name) this.broadcast({ t: S2C.LEFT, player: seat, client, name, reason });
      for (const f of frames) this.broadcast({ t: S2C.FRAME, ...f });
      if (this.lockstep.finished) await this.destroy();
    }
  }

  kick(client) {
    const ws = this.socketOf(client);
    if (!ws) return;
    const att = this.attachment(ws);
    att.gone = true;
    ws.serializeAttachment(att);
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
          this.send(ws, { t: S2C.ERROR, code: ERRORS.DROPPED, message: 'You were dropped for not responding.' });
          await this.disconnect(ws, 'dropped');
          this.close(ws, CLOSE_NORMAL, 'dropped');
        } else {
          await this.removeClient(client, 'dropped');
        }
      }
      if (this.meta) await this.ctx.storage.setAlarm(now + GAME_ALARM_MS);
      return;
    }
    if (this.room.humans().length === 0) {
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
    if (id) {
      try {
        await removeSession(this.env.DB, id);
      } catch (err) {
        console.error('directory delete failed', err?.message);
      }
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    for (const ws of this.ctx.getWebSockets()) this.close(ws, CLOSE_NORMAL, 'session closed');
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
      if (att.client !== null && !att.gone) this.sendRaw(ws, raw);
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

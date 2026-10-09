// Online lobby state and slot rules (pure, no I/O; serializable to storage).
//
// Slots: { type: 'human', client, name, faction, color, team, ready }
//        { type: 'ai', difficulty, faction, color, team }
//        { type: 'open' } | { type: 'closed' }
//
// Rules:
// - a joining player takes the first open slot with the first free colour;
// - players edit their own slot (faction, colour, team) or move to an open slot;
// - the host also edits AI slots and sets any other slot to ai / open / closed
//   (doing that to a human's slot kicks that player);
// - colours are unique; teams 0 (none) .. TEAM_MAX;
// - host changes to options, map or slots reset everyone's ready flag, a
//   player's own change resets only their flag;
// - ready needs the lobby's map hash (null for a generated map);
// - start: host only, every other human ready, 2+ players, 2+ sides, players
//   fit the map's spawns. Random factions are resolved here.
//
// Spectators: up to `maxSpectators` (host setting) members without a slot.
// They join like players (same password rules), in the lobby or a running
// game, and can switch to an open slot (and back) in the lobby. They never
// play: the start message lists only slot holders.
//
// Seats in a running game (`seatStates`, one per game player, null for AI):
// active (connected and in lockstep), away (connection lost or dropped for
// stalling: may rejoin until `until`), syncing (rejoined, catching up; must
// resume until `until`) and gone (left, removed, or did not come back).
// `record` keeps the seat's lockstep stall budget while it is away, so a
// rejoin never gets a fresh one (lockstep.js `suspend` / `rejoin`).

import {
  COLOR_COUNT,
  DEFAULT_MAX_SPECTATORS,
  DEFAULT_OPTIONS,
  MAX_REJOINS,
  MAX_SPECTATORS,
  MIN_PLAYERS,
  ORDER_DELAY,
  RANDOM_FACTIONS,
} from '@webra/protocol';

export class RoomError extends Error {
  constructor(message, code = 'invalid') {
    super(message);
    this.code = code;
  }
}

const fail = (message, code) => {
  throw new RoomError(message, code);
};

const AI_NAMES = { easy: 'Computer (easy)', normal: 'Computer', hard: 'Computer (hard)' };

export class Room {
  /** @param {{ maxPlayers: number, seed?: number }} config */
  static create({ maxPlayers, seed = 1 }) {
    const r = new Room();
    r.phase = 'lobby';
    r.slots = Array.from({ length: maxPlayers }, () => ({ type: 'open' }));
    r.options = { ...DEFAULT_OPTIONS, seed };
    r.map = null;
    r.hostId = null;
    r.nextClient = 1;
    /** Game player index -> client id (humans) after start. */
    r.seats = null;
    /** Client id -> name, kept after a player leaves (for `left` messages). */
    r.names = {};
    /** Members without a slot: [{ client, name }]. */
    r.spectators = [];
    r.maxSpectators = DEFAULT_MAX_SPECTATORS;
    /** Client id -> SHA-256 (hex) of its rejoin key. */
    r.keys = {};
    /** Client id -> rejoins so far (running game). */
    r.rejoins = {};
    /** The `start` message fields, sent again to rejoining members. */
    r.startMsg = null;
    /** Game player index -> seat state (see the header), null for AI. */
    r.seatStates = null;
    /** Client id -> account id of members who joined signed in (never published). */
    r.accounts = {};
    return r;
  }

  static fromJSON(data) {
    const r = new Room();
    Object.assign(r, structuredClone(data));
    // Rooms stored before an option existed get its default (cheats stay off).
    r.options = { ...DEFAULT_OPTIONS, ...r.options };
    r.spectators ??= [];
    r.maxSpectators ??= DEFAULT_MAX_SPECTATORS;
    r.keys ??= {};
    r.rejoins ??= {};
    r.startMsg ??= null;
    r.seatStates ??= null;
    r.accounts ??= {};
    return r;
  }

  toJSON() {
    return {
      phase: this.phase,
      slots: this.slots,
      options: this.options,
      map: this.map,
      hostId: this.hostId,
      nextClient: this.nextClient,
      seats: this.seats,
      names: this.names,
      spectators: this.spectators,
      maxSpectators: this.maxSpectators,
      keys: this.keys,
      rejoins: this.rejoins,
      startMsg: this.startMsg,
      seatStates: this.seatStates,
      accounts: this.accounts,
    };
  }

  slotOf(client) {
    return this.slots.findIndex((s) => s.type === 'human' && s.client === client);
  }

  humans() {
    return this.slots.filter((s) => s.type === 'human');
  }

  isSpectator(client) {
    return this.spectators.some((s) => s.client === client);
  }

  /** Connected lobby members: slot holders and spectators. */
  memberCount() {
    return this.humans().length + this.spectators.length;
  }

  isHost(client) {
    return client !== null && client === this.hostId;
  }

  freeColor(except = -1) {
    const used = new Set(this.slots.filter((s, i) => i !== except && 'color' in s).map((s) => s.color));
    for (let c = 0; c < COLOR_COUNT; c++) if (!used.has(c)) return c;
    return 0;
  }

  colorTaken(color, except) {
    return this.slots.some((s, i) => i !== except && 'color' in s && s.color === color);
  }

  resetReady() {
    for (const s of this.slots) if (s.type === 'human') s.ready = false;
  }

  /**
   * Add a member. Players take the first open slot (lobby only); spectators
   * (`spectate`) join the lobby or a running game while places are free.
   * Returns { client, slot (-1 for spectators), role }.
   */
  join(name, { host = false, spectate = false, account = null } = {}) {
    if (account !== null && this.hasAccountMember(account)) fail('You are already in this session with this account.', 'bad_state');
    if (spectate) {
      if (this.spectators.length >= this.maxSpectators) {
        fail(this.maxSpectators === 0 ? 'This session has no spectator places.' : 'The spectator places are taken.', 'full');
      }
    } else if (this.phase !== 'lobby') {
      fail('The game has already started.', 'bad_state');
    }
    const slot = spectate ? -1 : this.slots.findIndex((s) => s.type === 'open');
    if (slot < 0 && !spectate) fail('The session is full.', 'full');
    const client = this.nextClient++;
    this.names[client] = name;
    if (account !== null) this.accounts[client] = account;
    if (spectate) this.spectators.push({ client, name });
    else this.slots[slot] = { type: 'human', client, name, faction: 'random', color: this.freeColor(), team: 0, ready: false };
    this.pruneNames();
    if (this.phase === 'lobby' && (host || this.hostId === null)) this.hostId = client;
    return { client, slot, role: spectate ? 'spectator' : 'player' };
  }

  /**
   * Remove a member from the lobby, or a spectator from a running game
   * (player seats stay in game, see seatStates). Returns the new host id when
   * the host changed.
   */
  leave(client) {
    const slot = this.slotOf(client);
    if (slot >= 0 && this.phase === 'lobby') this.slots[slot] = { type: 'open' };
    this.spectators = this.spectators.filter((s) => s.client !== client);
    // Leaving a lobby is final: joining again goes through the password check.
    if (this.phase === 'lobby') {
      this.forgetKey(client);
      delete this.accounts[client];
    }
    if (this.hostId !== client) return null;
    // The longest-seated human (lowest slot) inherits the host role, else the first spectator.
    const next = this.phase === 'lobby' ? (this.slots.find((s) => s.type === 'human') ?? this.spectators[0]) : null;
    this.hostId = next ? next.client : null;
    return this.hostId;
  }

  /** Store the SHA-256 (hex) of a member's rejoin key. */
  setKey(client, hashHex) {
    this.keys[client] = hashHex;
  }

  /** The member can no longer rejoin (left on purpose, kicked or removed). */
  forgetKey(client) {
    delete this.keys[client];
  }

  /** Host: number of spectator places (never below the spectators present). */
  setMaxSpectators(client, max) {
    if (this.phase !== 'lobby') fail('The game has already started.', 'bad_state');
    if (!this.isHost(client)) fail('Only the host can change the spectator places.', 'not_host');
    if (!Number.isInteger(max) || max < 0 || max > MAX_SPECTATORS) fail('Invalid number of spectator places.');
    if (max < this.spectators.length) fail(`${this.spectators.length} spectators are already here.`);
    this.maxSpectators = max;
  }

  /** Move between a slot (on: false) and the spectators (on: true), lobby only. */
  spectate(client, on) {
    if (this.phase !== 'lobby') fail('The game has already started.', 'bad_state');
    const slot = this.slotOf(client);
    const watching = this.isSpectator(client);
    if (slot < 0 && !watching) fail('You are not in this session.', 'bad_state');
    if (on) {
      if (watching) return;
      if (this.spectators.length >= this.maxSpectators) fail('The spectator places are taken.', 'full');
      this.spectators.push({ client, name: this.slots[slot].name });
      this.slots[slot] = { type: 'open' };
      return;
    }
    if (!watching) return;
    const open = this.slots.findIndex((s) => s.type === 'open');
    if (open < 0) fail('No player slot is open.', 'full');
    const name = this.names[client] ?? this.spectators.find((s) => s.client === client).name;
    this.spectators = this.spectators.filter((s) => s.client !== client);
    this.slots[open] = { type: 'human', client, name, faction: 'random', color: this.freeColor(), team: 0, ready: false };
  }

  /**
   * Apply a validated `slot` message. Returns { kicked: clientId | null }.
   */
  setSlot(client, msg) {
    if (this.phase !== 'lobby') fail('The game has already started.', 'bad_state');
    const mine = this.slotOf(client);
    const host = this.isHost(client);
    // A spectating host still manages the other slots (types and AI settings).
    if (mine < 0 && !(host && this.isSpectator(client))) fail('You have no slot.', 'bad_state');
    const target = msg.slot;
    if (target >= this.slots.length) fail('No such slot.');
    const cur = this.slots[target];

    if (msg.type !== undefined) {
      if (!host) fail('Only the host can change slot types.', 'not_host');
      if (target === mine) fail('You cannot change your own slot type.');
      const kicked = cur.type === 'human' ? cur.client : null;
      if (msg.type === 'ai') {
        const color = msg.color ?? (cur.type === 'ai' ? cur.color : this.freeColor(target));
        if (this.colorTaken(color, target)) fail('That colour is taken.');
        this.slots[target] = {
          type: 'ai',
          difficulty: msg.difficulty ?? (cur.type === 'ai' ? cur.difficulty : 'normal'),
          faction: msg.faction ?? (cur.type === 'ai' ? cur.faction : 'random'),
          color,
          team: msg.team ?? (cur.type === 'ai' ? cur.team : 0),
        };
      } else {
        if (msg.faction !== undefined || msg.color !== undefined || msg.team !== undefined || msg.difficulty !== undefined) {
          fail('Empty slots have no settings.');
        }
        this.slots[target] = { type: msg.type };
      }
      this.resetReady();
      return { kicked };
    }

    if (target === mine) {
      if (msg.difficulty !== undefined) fail('Humans have no difficulty.');
      this.applySettings(target, msg);
      cur.ready = false;
      return { kicked: null };
    }

    if (cur.type === 'open' && mine >= 0) {
      if (msg.difficulty !== undefined) fail('Humans have no difficulty.');
      // Move to the open slot, keeping name and settings.
      this.slots[target] = this.slots[mine];
      this.slots[mine] = { type: 'open' };
      this.applySettings(target, msg);
      this.slots[target].ready = false;
      return { kicked: null };
    }

    if (cur.type === 'ai' && host) {
      this.applySettings(target, msg);
      if (msg.difficulty !== undefined) cur.difficulty = msg.difficulty;
      this.resetReady();
      return { kicked: null };
    }

    fail('You cannot change that slot.', 'forbidden');
  }

  applySettings(index, msg) {
    const s = this.slots[index];
    if (msg.color !== undefined) {
      if (this.colorTaken(msg.color, index)) fail('That colour is taken.');
      s.color = msg.color;
    }
    if (msg.faction !== undefined) s.faction = msg.faction;
    if (msg.team !== undefined) s.team = msg.team;
  }

  setOptions(client, options) {
    if (this.phase !== 'lobby') fail('The game has already started.', 'bad_state');
    if (!this.isHost(client)) fail('Only the host can change options.', 'not_host');
    this.options = { ...options };
    this.resetReady();
  }

  /** @param {null | {id, hash, name, modded, players}} map trusted (looked up server side) */
  setMap(client, map) {
    if (this.phase !== 'lobby') fail('The game has already started.', 'bad_state');
    if (!this.isHost(client)) fail('Only the host can change the map.', 'not_host');
    this.map = map ? { ...map } : null;
    this.resetReady();
  }

  setReady(client, ready, mapHash) {
    if (this.phase !== 'lobby') fail('The game has already started.', 'bad_state');
    const slot = this.slotOf(client);
    if (slot < 0) fail('You have no slot.', 'bad_state');
    if (ready && mapHash !== (this.map ? this.map.hash : null)) {
      fail('You do not have the selected map installed.', 'not_ready');
    }
    this.slots[slot].ready = ready;
  }

  participants() {
    return this.slots.filter((s) => s.type === 'human' || s.type === 'ai');
  }

  /** Why the host cannot start yet, or null. */
  startProblem(client) {
    if (this.phase !== 'lobby') return 'The game has already started.';
    if (!this.isHost(client)) return 'Only the host can start the game.';
    const players = this.participants();
    if (players.length < MIN_PLAYERS) return 'At least two players are needed.';
    if (this.map && players.length > this.map.players) return `This map has room for ${this.map.players} players.`;
    if (this.slots.some((s) => s.type === 'human' && s.client !== this.hostId && !s.ready)) return 'Not everyone is ready.';
    const sides = new Set(players.map((s, i) => (s.team === 0 ? `ffa${i}` : `team${s.team}`)));
    if (sides.size < 2) return 'At least two opposing sides are needed.';
    return null;
  }

  /**
   * Start the game. `pick(n)` returns a uniform random integer in 0..n-1 and
   * resolves random factions. Returns the `start` message fields plus
   * `seats` (game player index -> client id for humans).
   */
  start(client, pick) {
    const problem = this.startProblem(client);
    if (problem) fail(problem, this.isHost(client) ? 'not_ready' : 'not_host');
    const players = [];
    const startPlayers = [];
    const seats = [];
    this.slots.forEach((s, slot) => {
      if (s.type !== 'human' && s.type !== 'ai') return;
      const index = players.length;
      const pool = RANDOM_FACTIONS[s.faction];
      const faction = pool ? pool[pick(pool.length)] : s.faction;
      if (s.type === 'human') {
        players.push({ slot: index, type: 'human', name: s.name, faction, color: s.color, team: s.team });
        startPlayers.push({ player: index, slot, client: s.client, name: s.name, type: 'human' });
        seats.push(s.client);
      } else {
        const name = AI_NAMES[s.difficulty];
        players.push({ slot: index, type: 'ai', name, difficulty: s.difficulty, faction, color: s.color, team: s.team });
        startPlayers.push({ player: index, slot, client: null, name, type: 'ai' });
        seats.push(null);
      }
    });
    this.phase = 'game';
    this.seats = seats;
    this.seatStates = seats.map((c) => (c === null ? null : { state: 'active', until: 0, record: null }));
    this.startMsg = {
      seed: this.options.seed,
      options: { ...this.options, players },
      map: this.map,
      players: startPlayers,
      delay: ORDER_DELAY,
    };
    return structuredClone(this.startMsg);
  }

  // ---- Seats in a running game ------------------------------------------------------

  seatState(seat) {
    return this.seatStates?.[seat]?.state ?? null;
  }

  /**
   * The connection of an active seat was lost (or it stalled): it may come
   * back until now + graceMs. The grace runs from the moment the seat left
   * play and is not restarted by rejoins: a syncing seat that loses its
   * connection again gets at most what is left of that grace (time spent
   * catching up counts against it), never its longer resume deadline.
   */
  suspendSeat(seat, record, now, graceMs) {
    const s = this.seatStates?.[seat];
    if (!s || s.state === 'gone') return false;
    if (s.state === 'active') {
      s.until = now + graceMs;
      s.graceUntil = s.until;
    } else if (s.state === 'syncing') {
      s.until = Math.min(s.until, s.graceUntil ?? now + graceMs);
    }
    s.state = 'away';
    if (record) s.record = record;
    return true;
  }

  /**
   * A member presented a valid rejoin key. Players move to `syncing` (they
   * must resume within resumeMs); a seat that is still active must be
   * suspended by the caller first. Returns the seat, or -1 for spectators.
   * Throws RoomError when the client may not rejoin.
   */
  /**
   * Why `client` cannot rejoin whatever its current connection does, or
   * null: checked before an open connection of the member is replaced, so a
   * refused rejoin never disturbs a connected member.
   */
  rejoinProblem(client) {
    if (this.phase !== 'game') return new RoomError('The game is not running.', 'bad_state');
    if ((this.rejoins[client] ?? 0) >= MAX_REJOINS) return new RoomError('You rejoined too often.', 'forbidden');
    const seat = this.seatOf(client);
    if (seat >= 0) {
      return this.seatStates[seat].state === 'gone' ? new RoomError('You can no longer rejoin this game.', 'forbidden') : null;
    }
    if (!Object.hasOwn(this.keys, client)) return new RoomError('You are not in this game.', 'forbidden');
    if (!this.isSpectator(client) && this.spectators.length >= this.maxSpectators) return new RoomError('The spectator places are taken.', 'full');
    return null;
  }

  beginRejoin(client, now, resumeMs) {
    const problem = this.rejoinProblem(client);
    if (problem) throw problem;
    const seat = this.seatOf(client);
    if (seat < 0) {
      if (this.isSpectator(client)) fail('You are already watching.', 'bad_state');
      if (this.spectators.length >= this.maxSpectators) fail('The spectator places are taken.', 'full');
      this.rejoins[client] = (this.rejoins[client] ?? 0) + 1;
      this.spectators.push({ client, name: this.names[client] ?? 'Spectator' });
      return -1;
    }
    const s = this.seatStates[seat];
    if (s.state === 'gone') fail('You can no longer rejoin this game.', 'forbidden');
    if (s.state === 'active') fail('Your seat is still connected.', 'bad_state');
    if (s.state === 'syncing') fail('You are already rejoining.', 'bad_state');
    this.rejoins[client] = (this.rejoins[client] ?? 0) + 1;
    s.state = 'syncing';
    s.until = now + resumeMs;
    return seat;
  }

  /** A syncing seat caught up. Returns its saved lockstep record. */
  resumeSeat(seat) {
    const s = this.seatStates?.[seat];
    if (!s || s.state !== 'syncing') fail('You are not rejoining.', 'bad_state');
    s.state = 'active';
    s.until = 0;
    s.graceUntil = null;
    const record = s.record;
    s.record = null;
    return record;
  }

  /** The seat can never come back (left, removed, expired). */
  endSeat(seat) {
    const s = this.seatStates?.[seat];
    if (!s || s.state === 'gone') return false;
    s.state = 'gone';
    s.until = 0;
    s.graceUntil = null;
    s.record = null;
    return true;
  }

  /** Away or syncing seats whose deadline passed. */
  expiredSeats(now) {
    return (this.seatStates ?? []).flatMap((s, seat) => (s && (s.state === 'away' || s.state === 'syncing') && s.until <= now ? [seat] : []));
  }

  /** Seats that are not gone (the game goes on while there is one). */
  liveSeats() {
    return (this.seatStates ?? []).flatMap((s, seat) => (s && s.state !== 'gone' ? [seat] : []));
  }

  /** Game player index of a client, or -1. */
  seatOf(client) {
    return this.seats ? this.seats.indexOf(client) : -1;
  }

  /** The account a member joined with, or null. */
  accountOf(client) {
    return Object.hasOwn(this.accounts, client) ? this.accounts[client] : null;
  }

  /**
   * Whether an account already holds a place: a slot, a spectator place, or
   * a seat in the running game that is not gone (an away seat comes back
   * with its rejoin key, never as a second member).
   */
  hasAccountMember(account) {
    return Object.entries(this.accounts).some(([id, a]) => {
      if (a !== account) return false;
      const client = Number(id);
      if (this.slotOf(client) >= 0 || this.isSpectator(client)) return true;
      const seat = this.seatOf(client);
      return this.phase === 'game' && seat >= 0 && this.seatState(seat) !== 'gone';
    });
  }

  /** Lobby message fields as published to clients (`account: true` marks names from accounts). */
  lobbyView() {
    const mark = (entry) => (this.accountOf(entry.client) !== null ? { ...entry, account: true } : { ...entry });
    return {
      slots: this.slots.map((s) => (s.type === 'human' ? mark(s) : { ...s })),
      options: { ...this.options },
      map: this.map,
      hostId: this.hostId,
      spectators: this.spectators.map(mark),
      maxSpectators: this.maxSpectators,
    };
  }

  /** Keep the name table bounded: forget departed players beyond 64 entries. */
  pruneNames() {
    const ids = Object.keys(this.names);
    if (ids.length <= 64) return;
    const keep = new Set([
      ...this.slots.filter((s) => s.type === 'human').map((s) => String(s.client)),
      ...(this.seats ?? []).map(String),
      ...this.spectators.map((s) => String(s.client)),
    ]);
    for (const id of ids.slice(0, ids.length - 64)) {
      if (keep.has(id)) continue;
      delete this.names[id];
      delete this.keys[id];
      delete this.rejoins[id];
      delete this.accounts[id];
    }
  }

  nameOf(client) {
    return Object.hasOwn(this.names, client) ? this.names[client] : null;
  }

  hostName() {
    return this.hostId === null ? null : this.nameOf(this.hostId);
  }
}

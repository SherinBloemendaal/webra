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

import {
  COLOR_COUNT,
  DEFAULT_OPTIONS,
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
    return r;
  }

  static fromJSON(data) {
    const r = new Room();
    Object.assign(r, structuredClone(data));
    // Rooms stored before an option existed get its default (cheats stay off).
    r.options = { ...DEFAULT_OPTIONS, ...r.options };
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
    };
  }

  slotOf(client) {
    return this.slots.findIndex((s) => s.type === 'human' && s.client === client);
  }

  humans() {
    return this.slots.filter((s) => s.type === 'human');
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

  /** Add a player. Returns { client, slot }. */
  join(name, { host = false } = {}) {
    if (this.phase !== 'lobby') fail('The game has already started.', 'bad_state');
    const slot = this.slots.findIndex((s) => s.type === 'open');
    if (slot < 0) fail('The session is full.', 'full');
    const client = this.nextClient++;
    this.names[client] = name;
    this.pruneNames();
    this.slots[slot] = { type: 'human', client, name, faction: 'random', color: this.freeColor(), team: 0, ready: false };
    if (host || this.hostId === null) this.hostId = client;
    return { client, slot };
  }

  /**
   * Remove a player from the lobby (no-op in game: seats stay). Returns the
   * new host id when the host changed.
   */
  leave(client) {
    const slot = this.slotOf(client);
    if (slot >= 0 && this.phase === 'lobby') this.slots[slot] = { type: 'open' };
    if (this.hostId !== client) return null;
    // The longest-seated human (lowest slot) inherits the host role.
    const next = this.phase === 'lobby' ? this.slots.find((s) => s.type === 'human') : null;
    this.hostId = next ? next.client : null;
    return this.hostId;
  }

  /**
   * Apply a validated `slot` message. Returns { kicked: clientId | null }.
   */
  setSlot(client, msg) {
    if (this.phase !== 'lobby') fail('The game has already started.', 'bad_state');
    const mine = this.slotOf(client);
    if (mine < 0) fail('You have no slot.', 'bad_state');
    const host = this.isHost(client);
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

    if (cur.type === 'open') {
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
    return {
      seed: this.options.seed,
      options: { ...this.options, players },
      map: this.map,
      players: startPlayers,
      delay: ORDER_DELAY,
    };
  }

  /** Game player index of a client, or -1. */
  seatOf(client) {
    return this.seats ? this.seats.indexOf(client) : -1;
  }

  /** Lobby message fields as published to clients. */
  lobbyView() {
    return { slots: this.slots.map((s) => ({ ...s })), options: { ...this.options }, map: this.map, hostId: this.hostId };
  }

  /** Keep the name table bounded: forget departed players beyond 64 entries. */
  pruneNames() {
    const ids = Object.keys(this.names);
    if (ids.length <= 64) return;
    const keep = new Set([...this.slots.filter((s) => s.type === 'human').map((s) => String(s.client)), ...(this.seats ?? []).map(String)]);
    for (const id of ids.slice(0, ids.length - 64)) if (!keep.has(id)) delete this.names[id];
  }

  nameOf(client) {
    return Object.hasOwn(this.names, client) ? this.names[client] : null;
  }

  hostName() {
    const h = this.slots.find((s) => s.type === 'human' && s.client === this.hostId);
    return h ? h.name : null;
  }
}

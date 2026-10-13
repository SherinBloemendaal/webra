// Online lobby state and slot rules (pure, no I/O; serializable to storage).
//
// Slots: { type: 'human', client, name, faction, color, team, handicap, spawn?, ready }
//        { type: 'ai', difficulty, bot, faction, color, team, handicap, spawn? }
//        { type: 'open' } | { type: 'closed' }
//
// Rules:
// - a joining player takes the first open slot with the first free colour;
// - players edit their own slot (faction, colour, team) or move to an open slot;
// - the host also edits AI slots and other players' faction, colour, team,
//   handicap and spawn (OpenRA: only the host changes other clients' info),
//   and sets any other slot to ai / open / closed (doing that to a human's
//   slot kicks that player);
// - the host's bulk edit (`slots`, setSlots) is a list of such changes,
//   each checked like a `slot` message, all applied or none, the colours
//   checked once all are in;
// - colours are unique; teams 0 (none) .. TEAM_MAX;
// - host changes to options, map or slots reset everyone's ready flag, a
//   player's own change resets only their flag;
// - ready needs the lobby's map hash (null for a generated map);
// - spawns (OpenRA's lobby spawn selection, `spawn` 0-based, absent for the
//   automatic choice of protocol spawns.js): a player picks or clears its
//   own, the host an AI's and clears anyone's (OpenRA clear_spawn); a spawn
//   one slot picked is taken for the others; never in a co-op mission. The
//   picks belong to one battlefield (`battlefield`): a new map, mission,
//   seed, size or style, or on a generated map (one spawn per player) a new
//   player count clears them all, like OpenRA clears them on a map change;
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
//
// Lobby maps (docs/security.md "Map sharing"): with a map, every member has
// a map state (`mapStates`, default missing): installed or declined, as the
// member reports it; ready implies installed. The game starts only when every
// player and spectator has the exact map installed. The host has it (it
// picked or shared it).
//
// Rematch: in a running game the host proposes playing again with the same
// settings. Every active seat
// still in the game must accept within REMATCH_VOTE_MS (an away seat answers
// once it is back, or stops counting once it is gone); one decline cancels it. Then the room goes back to its lobby with the same slots,
// options and map: the accepting players and the spectators keep their
// places and come back with their rejoin keys within REMATCH_RETURN_MS
// (`returning`: while it runs, a lost connection does not cost the place);
// everyone else's place opens.
//
// Online saves: any player still in the game proposes saving it; every such
// player must accept (SAVE_VOTE_MS), and all of them must be signed in. The
// save point is a hash tick the server has not sent yet; once every player
// reported the same state hash there, the session records the save.
//
// Resuming a save (`resume`): the host loads a saved game into its lobby.
// The slots become the saved players (factions, colours, teams resolved as
// they were); a human slot is reserved for the account that played it and
// only that account can take it. Options and map are the saved ones and
// cannot change. Everyone ready (accepting) and the map installed, the host
// starts: every client fast-forwards through the saved orders and the game
// goes on after the save point once every player caught up.
//
// Co-op missions (`mission`, protocol mission.js COOP_MISSIONS): the host
// picks one instead of a skirmish (no map file then). The first slots are
// the mission's playable players in order (Allies1, Allies2, ...) and only
// people take them (OpenRA AllowBots: False); the other slots are closed.
// The game starts when every one of those slots holds a ready person.

import {
  lockedOptionProblem,
  lockedSlotProblem,
  lockedSlotProblems,
  mapSlot,
  mapSlotSettings,
  COLOR_COUNT,
  DEFAULT_MAX_SPECTATORS,
  DEFAULT_OPTIONS,
  LEGACY_MOVEMENT,
  MAX_REJOINS,
  MAX_SPECTATORS,
  MIN_PLAYERS,
  ORDER_DELAY,
  RANDOM_FACTIONS,
  REMATCH_COOLDOWN_MS,
  REMATCH_RETURN_MS,
  REMATCH_VOTE_MS,
  HASH_INTERVAL,
  SAVE_COOLDOWN_MS,
  SAVE_HASH_MS,
  SAVE_VOTE_MS,
  battlefieldSpawns,
  coopMission,
  generatedMapPlayers,
  spawnPickProblem,
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

// OpenRA's bot names (ModularBot Name); the difficulty when it is not Normal.
const BOT_NAMES = { rush: 'Rush AI', normal: 'Normal AI', turtle: 'Turtle AI', naval: 'Naval AI' };
const aiName = (s) => `${BOT_NAMES[s.bot ?? 'normal']}${s.difficulty === 'normal' ? '' : ` (${s.difficulty})`}`;

export class Room {
  /** @param {{ maxPlayers: number, seed?: number }} config */
  static create({ maxPlayers, seed = 1 }) {
    const r = new Room();
    r.phase = 'lobby';
    r.slots = Array.from({ length: maxPlayers }, () => ({ type: 'open' }));
    r.options = { ...DEFAULT_OPTIONS, seed };
    r.map = null;
    /** The co-op mission played instead of a skirmish: { id, hash, options } or null. */
    r.mission = null;
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
    /** Client id -> 'installed' | 'declined' for the lobby's map (missing when absent). */
    r.mapStates = {};
    /** Open rematch proposal: { by, accepted: client ids, until } or null. */
    r.rematch = null;
    /** No new proposal before this time (after one ended without a rematch). */
    r.rematchCooldown = 0;
    /** Client id -> deadline: members of the finished game coming back into the lobby. */
    r.returning = {};
    /** Saving the running game: { phase: 'open', by, accepted, until } or { phase: 'agreed', tick, hashes, until }, or null. */
    r.saving = null;
    r.saveCooldown = 0;
    /**
     * The saved online game this lobby resumes, or null: { id, title, createdAt,
     * ticks, hash, options (the saved game options), seats: [account | null] per player, chunks }.
     */
    r.resume = null;
    /** A resumed game whose players are still catching up: { ticks, hash }, or null. */
    r.resumeStart = null;
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
    r.mapStates ??= {};
    r.rematch ??= null;
    r.rematchCooldown ??= 0;
    r.returning ??= {};
    r.saving ??= null;
    r.saveCooldown ??= 0;
    r.resume ??= null;
    r.resumeStart ??= null;
    r.mission ??= null;
    // AI slots stored before bot types play the Normal AI.
    for (const s of r.slots) if (s.type === 'ai') s.bot ??= 'normal';
    return r;
  }

  toJSON() {
    return {
      phase: this.phase,
      slots: this.slots,
      options: this.options,
      map: this.map,
      mission: this.mission,
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
      mapStates: this.mapStates,
      rematch: this.rematch,
      rematchCooldown: this.rematchCooldown,
      returning: this.returning,
      saving: this.saving,
      saveCooldown: this.saveCooldown,
      resume: this.resume,
      resumeStart: this.resumeStart,
    };
  }

  slotOf(client) {
    return this.slots.findIndex((s) => s.type === 'human' && s.client === client);
  }

  humans() {
    return this.slots.filter((s) => s.type === 'human');
  }

  /**
   * Who sees `client`'s team chat: its team ('team:N'), the client alone when
   * it has no team, or the spectators ('spectators').
   */
  chatTeamOf(client) {
    const seat = this.slotOf(client);
    if (seat < 0) return this.isSpectator(client) ? 'spectators' : `client:${client}`;
    const team = this.slots[seat].team;
    return team ? `team:${team}` : `client:${client}`;
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
   * What the picked spawns refer to: the map file, the co-op mission, or the
   * generated map of this seed, size, style and player count (protocol
   * generatedMapPlayers: one spawn per player, so another count is another
   * map; a host alone already has the two player map).
   */
  battlefield() {
    if (this.mission) return 'mission';
    if (this.map) return `map:${this.map.hash}`;
    const o = this.options;
    return `gen:${o.seed}/${o.mapSize}/${o.mapStyle}/${generatedMapPlayers(this.participants().length)}`;
  }

  /** How many spawns the lobby's battlefield has (protocol battlefieldSpawns, as the clients count them). */
  spawnCount() {
    return battlefieldSpawns({ mission: !!this.mission, mapSpawns: this.map ? this.map.players : null, players: this.participants().length });
  }

  /** Clear every picked spawn when the battlefield is no longer `before` (a battlefield() value). */
  keepSpawnsFor(before) {
    if (this.battlefield() === before || this.resume) return;
    for (const s of this.slots) delete s.spawn;
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
    // A resumed save: a player takes the place its account played, nobody else plays.
    const slot = spectate ? -1 : this.resume ? this.reservedSlotOf(account) : this.slots.findIndex((s) => s.type === 'open');
    if (slot < 0 && !spectate) {
      if (this.resume) fail('This lobby continues a saved game: only its players can play. You can watch.', 'forbidden');
      fail('The session is full.', 'full');
    }
    const field = this.battlefield();
    const client = this.nextClient++;
    this.names[client] = name;
    if (account !== null) this.accounts[client] = account;
    if (spectate) this.spectators.push({ client, name });
    else this.slots[slot] = this.resume ? this.savedSlot(slot, client, name) : this.newPerson(slot, client, name);
    this.pruneNames();
    if (this.phase === 'lobby' && (host || this.hostId === null)) this.hostId = client;
    if (this.phase === 'lobby') this.keepSpawnsFor(field);
    return { client, slot, role: spectate ? 'spectator' : 'player' };
  }

  /**
   * Remove a member from the lobby, or a spectator from a running game
   * (player seats stay in game, see seatStates). Returns the new host id when
   * the host changed.
   */
  leave(client) {
    const slot = this.slotOf(client);
    const field = this.battlefield();
    if (slot >= 0 && this.phase === 'lobby') {
      this.slots[slot] = this.resume ? { type: 'open', reserved: slot } : { type: 'open' };
      this.keepSpawnsFor(field);
    }
    this.spectators = this.spectators.filter((s) => s.client !== client);
    // Leaving a lobby is final: joining again goes through the password check.
    if (this.phase === 'lobby') {
      this.forgetKey(client);
      delete this.accounts[client];
      delete this.mapStates[client];
      delete this.returning[client];
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
    const field = this.battlefield();
    this.moveSides(client, on);
    this.keepSpawnsFor(field);
  }

  moveSides(client, on) {
    const slot = this.slotOf(client);
    const watching = this.isSpectator(client);
    if (slot < 0 && !watching) fail('You are not in this session.', 'bad_state');
    if (on) {
      if (watching) return;
      if (this.spectators.length >= this.maxSpectators) fail('The spectator places are taken.', 'full');
      this.spectators.push({ client, name: this.slots[slot].name });
      this.slots[slot] = this.resume ? { type: 'open', reserved: slot } : { type: 'open' };
      return;
    }
    if (!watching) return;
    const open = this.resume ? this.reservedSlotOf(this.accountOf(client)) : this.slots.findIndex((s) => s.type === 'open');
    if (open < 0) fail(this.resume ? 'This lobby continues a saved game: only its players can play.' : 'No player slot is open.', this.resume ? 'forbidden' : 'full');
    const name = this.names[client] ?? this.spectators.find((s) => s.client === client).name;
    this.spectators = this.spectators.filter((s) => s.client !== client);
    this.slots[open] = this.resume ? this.savedSlot(open, client, name) : this.newPerson(open, client, name);
  }

  /**
   * Slot `k` for a person coming into the lobby (joining or leaving the
   * spectators): the lobby's defaults with the map's settings for the slot
   * (map format version 2, takeMapSlot).
   */
  newPerson(k, client, name) {
    this.slots[k] = { type: 'human', client, name, faction: 'random', color: this.freeColorFor(k), team: 0, handicap: 0, ready: false };
    this.takeMapSlot(k);
    return this.slots[k];
  }

  /**
   * Whoever came into slot `k` (a person joining or moving there, or a new
   * AI) takes the map's faction, team and colour for it (map format version
   * 2, protocol mapSlotSettings). A colour another slot holds is swapped:
   * that slot gets the one slot `k` had.
   */
  takeMapSlot(k) {
    const setup = this.map?.setup;
    if (!setup || this.resume) return;
    const s = this.slots[k];
    const m = mapSlotSettings(setup, k);
    if (m.faction !== undefined) s.faction = m.faction;
    if (m.team !== undefined) s.team = m.team;
    if (m.color !== undefined && s.color !== m.color) {
      const other = this.slots.findIndex((x, i) => i !== k && 'color' in x && x.color === m.color);
      if (other >= 0) this.slots[other].color = s.color;
      s.color = m.color;
    }
  }

  /**
   * A free colour for slot `k`: preferably none the lobby map sets for
   * another slot (whoever comes into that slot later takes it), else any
   * free one (freeColor).
   */
  freeColorFor(k) {
    const setup = this.map?.setup;
    const used = new Set(this.slots.filter((s, i) => i !== k && 'color' in s).map((s) => s.color));
    const kept = new Set(
      setup && !this.resume ? (setup.players ?? []).flatMap((_, i) => (i !== k ? [mapSlot(setup, i).color] : [])).filter((c) => c >= 0) : [],
    );
    for (let c = 0; c < COLOR_COUNT; c++) if (!used.has(c) && !kept.has(c)) return c;
    return this.freeColor(k);
  }

  // ---- Resuming an online save --------------------------------------------------------

  /** The open slot reserved for `account` in a resumed save, or -1. */
  reservedSlotOf(account) {
    if (!this.resume || account === null) return -1;
    return this.slots.findIndex((s, i) => s.type === 'open' && s.reserved === i && this.resume.seats[i] === account);
  }

  /** The saved player `i` as a lobby slot for `client`. */
  savedSlot(i, client, name) {
    const p = this.resume.options.players[i];
    return { type: 'human', client, name, faction: p.faction, color: p.color, team: p.team, handicap: p.handicap ?? 0, ...(p.spawn !== undefined ? { spawn: p.spawn } : {}), ready: false };
  }

  /** Changing settings is refused while the lobby resumes a save. */
  refuseInResume() {
    if (this.resume) fail("A resumed game keeps its saved settings.", 'forbidden');
  }

  /**
   * Host: turn the lobby into the resume of a saved game (checked by the
   * caller: the save record, the host's account among its players).
   * `info`: { id, title, createdAt, ticks, hash, options, seats, chunks }.
   * Members whose account played a seat take it; other players watch (when
   * places allow, else the load is refused). Returns nothing.
   */
  loadResume(client, info) {
    if (this.phase !== 'lobby') fail('The game has already started.', 'bad_state');
    if (!this.isHost(client)) fail('Only the host can resume a saved game.', 'not_host');
    const players = info.options.players;
    if (players.length > this.slots.length) fail(`This saved game has ${players.length} players: create a session with at least as many places.`, 'invalid');
    // Who is here, and which seat (if any) its account played.
    const members = [...this.humans().map((s) => ({ client: s.client, name: s.name })), ...this.spectators.map((s) => ({ client: s.client, name: s.name }))];
    const seatOf = (c) => {
      const a = this.accountOf(c);
      return a === null ? -1 : info.seats.findIndex((x) => x === a);
    };
    const watchers = members.filter((m) => seatOf(m.client) < 0);
    if (watchers.length > MAX_SPECTATORS) fail('Too many members who did not play this game are here.', 'full');
    this.resume = { ...info, options: structuredClone(info.options), seats: [...info.seats] };
    this.slots = this.slots.map((_, i) => {
      if (i >= players.length) return { type: 'closed' };
      const p = players[i];
      if (p.type === 'ai') {
        return { type: 'ai', difficulty: p.difficulty, bot: p.bot ?? 'normal', faction: p.faction, color: p.color, team: p.team, handicap: p.handicap ?? 0, ...(p.spawn !== undefined ? { spawn: p.spawn } : {}) };
      }
      return { type: 'open', reserved: i };
    });
    for (const m of members) {
      const seat = seatOf(m.client);
      if (seat >= 0 && players[seat]?.type === 'human') this.slots[seat] = this.savedSlot(seat, m.client, m.name);
    }
    this.spectators = watchers.map((m) => ({ client: m.client, name: m.name }));
    this.maxSpectators = Math.max(this.maxSpectators, this.spectators.length);
    const { players: _players, ...rest } = info.options;
    this.options = { ...DEFAULT_OPTIONS, ...Object.fromEntries(Object.keys(DEFAULT_OPTIONS).map((k) => [k, rest[k] ?? DEFAULT_OPTIONS[k]])) };
    // A save from before the movement option plays the model it was made with.
    this.options.movement = rest.movement ?? LEGACY_MOVEMENT;
    this.mapStates = this.map ? { [client]: 'installed' } : {};
  }

  /** The `resume` field of lobby messages. */
  resumeView() {
    const r = this.resume;
    const waiting = this.slots.flatMap((s, i) => (s.type === 'open' && s.reserved === i ? [r.options.players[i].name] : []));
    return { id: r.id, title: r.title, createdAt: r.createdAt, ticks: r.ticks, waiting };
  }

  /**
   * Apply a validated `slot` message. Returns { kicked: clientId | null }.
   */
  setSlot(client, msg) {
    // A refused change changes nothing.
    const before = structuredClone(this.slots);
    const field = this.battlefield();
    let result;
    try {
      result = this.applySlot(client, msg);
    } catch (err) {
      this.slots = before;
      throw err;
    }
    this.keepLocks(before);
    // Another player count makes another generated map: its picks go.
    this.keepSpawnsFor(field);
    return result;
  }

  /**
   * Apply a validated `slots` message (the host's bulk edit, js/lobby-bulk.js):
   * every change is checked like a `slot` message of the host, in order, and
   * the colours once all are in (a shuffle swaps them). All or nothing.
   * Returns { kicked: [clientId] }.
   */
  setSlots(client, changes) {
    if (this.phase !== 'lobby') fail('The game has already started.', 'bad_state');
    if (!this.isHost(client)) fail('Only the host can change several slots at once.', 'not_host');
    const before = structuredClone(this.slots);
    const field = this.battlefield();
    const kicked = [];
    try {
      for (const change of changes) {
        const { kicked: k } = this.applySlot(client, change, { batch: true });
        if (k !== null) kicked.push(k);
      }
      const colors = this.slots.filter((s) => 'color' in s).map((s) => s.color);
      if (new Set(colors).size !== colors.length) fail('Two slots would share a colour.');
    } catch (err) {
      this.slots = before;
      throw err;
    }
    this.keepLocks(before);
    this.keepSpawnsFor(field);
    return { kicked };
  }

  /**
   * The map's locked slot parts (map format version 2): a change may not
   * break one that held. A lock that was already broken (a lobby from
   * before the map, or another way in) does not block changes, so the
   * lobby can always be put right; the start refuses it (startProblem).
   * Puts `before` back and throws when a change broke one.
   */
  keepLocks(before) {
    const setup = this.map?.setup;
    if (!setup || this.resume) return;
    for (const [k, slot] of this.slots.entries()) {
      const was = new Set(lockedSlotProblems(before[k], setup, k));
      const added = lockedSlotProblems(slot, setup, k).find((p) => !was.has(p));
      if (added) {
        this.slots = before;
        fail(added, 'forbidden');
      }
    }
  }

  /** Why the slots break the lobby map's locks (map format version 2), or null. */
  lockedProblem() {
    const setup = this.map?.setup;
    if (!setup || this.resume) return null;
    for (const [k, slot] of this.slots.entries()) {
      const p = lockedSlotProblem(slot, setup, k);
      if (p) return p;
    }
    return lockedOptionProblem(this.options, setup);
  }

  /** One slot change; `batch`: part of a `slots` message (setSlots checks the colours at the end). */
  applySlot(client, msg, { batch = false } = {}) {
    if (this.phase !== 'lobby') fail('The game has already started.', 'bad_state');
    this.refuseInResume();
    const mine = this.slotOf(client);
    const host = this.isHost(client);
    // A spectating host still manages the other slots (types and AI settings).
    if (mine < 0 && !(host && this.isSpectator(client))) fail('You have no slot.', 'bad_state');
    const target = msg.slot;
    if (target >= this.slots.length) fail('No such slot.');
    const cur = this.slots[target];

    if (msg.spawn !== undefined) this.checkSpawn(target, msg.spawn);

    if (msg.type !== undefined) {
      if (!host) fail('Only the host can change slot types.', 'not_host');
      if (msg.spawn !== undefined) fail('Pick the spawn after the slot type.');
      if (target === mine) fail('You cannot change your own slot type.');
      if (this.mission) {
        if (msg.type === 'ai') fail('People play a co-op mission: no AI players.');
        if (target >= this.missionPlaces()) fail(`This mission has ${this.missionPlaces()} places.`);
      }
      const kicked = cur.type === 'human' ? cur.client : null;
      if (msg.type === 'ai') {
        // An AI keeps its settings; a new one starts from the map's for the slot.
        const m = this.map?.setup && !this.resume && target < (this.map.setup.players ?? []).length ? mapSlot(this.map.setup, target) : null;
        this.slots[target] =
          cur.type === 'ai'
            ? { ...cur, bot: cur.bot ?? 'normal', handicap: cur.handicap ?? 0 }
            : { type: 'ai', difficulty: m?.difficulty ?? 'normal', bot: m?.bot ?? 'normal', faction: 'random', color: this.freeColorFor(target), team: 0, handicap: 0 };
        if (cur.type !== 'ai') this.takeMapSlot(target);
        if (msg.difficulty !== undefined) this.slots[target].difficulty = msg.difficulty;
        if (msg.bot !== undefined) this.slots[target].bot = msg.bot;
        this.applySettings(target, msg, batch);
      } else {
        if (
          msg.faction !== undefined ||
          msg.color !== undefined ||
          msg.team !== undefined ||
          msg.difficulty !== undefined ||
          msg.bot !== undefined ||
          msg.handicap !== undefined ||
          msg.spawn !== undefined
        ) {
          fail('Empty slots have no settings.');
        }
        this.slots[target] = { type: msg.type };
      }
      this.resetReady();
      return { kicked };
    }

    if (target === mine) {
      if (msg.difficulty !== undefined) fail('Humans have no difficulty.');
      if (msg.bot !== undefined) fail('Humans have no bot type.');
      this.applySettings(target, msg, batch);
      cur.ready = false;
      return { kicked: null };
    }

    if (cur.type === 'open' && mine >= 0 && !(this.mission && target >= this.missionPlaces())) {
      if (msg.difficulty !== undefined) fail('Humans have no difficulty.');
      if (msg.bot !== undefined) fail('Humans have no bot type.');
      // Move to the open slot, keeping name and settings.
      this.slots[target] = this.slots[mine];
      this.slots[mine] = { type: 'open' };
      this.takeMapSlot(target);
      this.applySettings(target, msg, batch);
      this.slots[target].ready = false;
      return { kicked: null };
    }

    if (cur.type === 'ai' && host) {
      this.applySettings(target, msg, batch);
      if (msg.difficulty !== undefined) cur.difficulty = msg.difficulty;
      if (msg.bot !== undefined) cur.bot = msg.bot;
      this.resetReady();
      return { kicked: null };
    }

    // OpenRA clear_spawn: the host frees another player's spawn (only that;
    // the player is no longer ready, as in OpenRA).
    if (cur.type === 'human' && host && msg.spawn === null && Object.keys(msg).every((k) => k === 't' || k === 'slot' || k === 'spawn')) {
      delete cur.spawn;
      cur.ready = false;
      return { kicked: null };
    }

    // OpenRA LobbyCommands: "Only the host can change other client's info"
    // (faction, team, handicap, spawn, colour); a host change makes everyone
    // not ready, like its other changes.
    if (cur.type === 'human' && host) {
      if (msg.difficulty !== undefined) fail('Humans have no difficulty.');
      if (msg.bot !== undefined) fail('Humans have no bot type.');
      this.applySettings(target, msg, batch);
      this.resetReady();
      return { kicked: null };
    }

    fail('You cannot change that slot.', 'forbidden');
  }

  /**
   * Whether slot `target` may start at `spawn` (0-based; null: automatic
   * again): a spawn of the lobby's battlefield that no other slot picked,
   * never in a co-op mission or a resumed save.
   */
  checkSpawn(target, spawn) {
    if (spawn === null) return;
    if (this.mission) fail('The mission decides where everyone starts.', 'forbidden');
    const count = this.spawnCount();
    if (spawn >= count) fail(`This map has ${count} start positions.`);
    if (this.slots.some((s, i) => i !== target && s.spawn === spawn)) fail('That start position is taken.', 'forbidden');
  }

  applySettings(index, msg, batch = false) {
    const s = this.slots[index];
    if (msg.color !== undefined) {
      if (!batch && this.colorTaken(msg.color, index)) fail('That colour is taken.');
      s.color = msg.color;
    }
    if (msg.faction !== undefined) s.faction = msg.faction;
    if (msg.team !== undefined) s.team = msg.team;
    // OpenRA handicap: a player's own, or an AI's set by the host (protocol HANDICAPS).
    if (msg.handicap !== undefined) s.handicap = msg.handicap;
    // The picked spawn (checkSpawn), or null: automatic again.
    if (msg.spawn === null) delete s.spawn;
    else if (msg.spawn !== undefined) s.spawn = msg.spawn;
  }

  setOptions(client, options) {
    if (this.phase !== 'lobby') fail('The game has already started.', 'bad_state');
    this.refuseInResume();
    if (!this.isHost(client)) fail('Only the host can change options.', 'not_host');
    const problem = this.resume ? null : lockedOptionProblem(options, this.map?.setup);
    if (problem) fail(problem, 'forbidden');
    const field = this.battlefield();
    this.options = { ...options };
    this.keepSpawnsFor(field);
    this.resetReady();
  }

  /** @param {null | {id, hash, name, modded, players}} map trusted (looked up server side) */
  setMap(client, map, { resume = false } = {}) {
    if (this.phase !== 'lobby') fail('The game has already started.', 'bad_state');
    if (!resume) this.refuseInResume();
    if (!this.isHost(client)) fail('Only the host can change the map.', 'not_host');
    const field = this.battlefield();
    // A map that brings its game setup (map format version 2): its slots and options apply now.
    if (map?.setup && !resume) this.applyMapSetup(map.setup);
    this.map = map ? { ...map } : null;
    // Map states belong to one map; the host has the one it picked.
    this.mapStates = map ? { [client]: 'installed' } : {};
    // A map (or a generated one) means a skirmish: no mission.
    if (!resume) this.mission = null;
    this.keepSpawnsFor(field);
    this.resetReady();
  }

  /**
   * Apply a map's game setup (map format version 2, protocol mapsetup.js)
   * to the lobby: its options, and for each slot it lists: closed or an AI
   * (a person in such a slot moves to a free slot the map leaves open; the
   * map is refused when there is none), its faction, team and colour. Slots
   * it does not list keep what they had. Fails without changing anything.
   */
  applyMapSetup(setup) {
    const slots = structuredClone(this.slots);
    const listed = Math.min(setup.players.length, slots.length);
    const moving = [];
    for (let k = 0; k < listed; k++) {
      const m = mapSlot(setup, k);
      const cur = slots[k];
      if (m.type === 'closed' || m.type === 'ai') {
        if (cur.type === 'human') moving.push(cur);
        slots[k] =
          m.type === 'closed' ? { type: 'closed' } : { type: 'ai', difficulty: m.difficulty, bot: m.bot, faction: m.faction, color: -1, team: m.team, handicap: 0 };
      } else if (cur.type === 'closed' && m.lock.includes('type')) {
        slots[k] = { type: 'open' };
      }
    }
    // People from slots the map closes or gives to an AI take open slots the map leaves to players.
    for (const person of moving) {
      let free = slots.findIndex((x, i) => x.type === 'open' && !(i < listed && mapSlot(setup, i).type !== 'open'));
      // Else a slot the map gives to an AI or closes without locking it.
      if (free < 0) free = slots.findIndex((x, i) => x.type !== 'human' && !(i < listed && mapSlot(setup, i).lock.includes('type')));
      if (free < 0) fail(`This map leaves no free slot for ${person.name}.`);
      slots[free] = person;
    }
    for (let k = 0; k < listed; k++) {
      const m = mapSlot(setup, k);
      const cur = slots[k];
      if (cur.type !== 'human' && cur.type !== 'ai') continue;
      if (m.faction !== 'random' || m.lock.includes('faction')) cur.faction = m.faction;
      cur.team = m.team;
      if (m.color >= 0) {
        // The map's colour: whoever had it takes this slot's.
        const other = slots.findIndex((x, i) => i !== k && x.color === m.color);
        if (other >= 0) slots[other].color = cur.color;
        cur.color = m.color;
      }
    }
    // AI slots the map made get the first free colours.
    for (const [k, x] of slots.entries()) {
      if (x.color !== -1) continue;
      const used = new Set(slots.filter((y, i) => i !== k && 'color' in y).map((y) => y.color));
      x.color = [...Array(COLOR_COUNT).keys()].find((c) => !used.has(c)) ?? 0;
    }
    this.slots = slots;
    this.options = { ...this.options, ...setup.options };
  }

  /** How many places the lobby's co-op mission has (its playable players). */
  missionPlaces() {
    return this.mission ? coopMission(this.mission.id).players.length : 0;
  }

  /**
   * Host: play co-op mission `mission` ({ id, hash, options }, validated by
   * the protocol against COOP_MISSIONS) or go back to a skirmish (null).
   * The first slots become the mission's places: AI players there leave,
   * people in later slots move into free places; the later slots close.
   */
  setMission(client, mission, { resume = false } = {}) {
    if (this.phase !== 'lobby') fail('The game has already started.', 'bad_state');
    if (!resume) this.refuseInResume();
    if (!this.isHost(client)) fail('Only the host can choose a mission.', 'not_host');
    const field = this.battlefield();
    if (mission === null) {
      this.mission = null;
      this.keepSpawnsFor(field);
      this.resetReady();
      return;
    }
    const places = coopMission(mission.id)?.players.length ?? 0;
    if (places === 0) fail('Unknown mission.', 'not_found');
    if (places > this.slots.length) fail(`This mission needs ${places} places: create a session with at least as many.`);
    const people = this.humans();
    if (people.length > places) fail(`This mission has ${places} places for ${people.length} players: some must watch first.`);
    const slots = Array.from({ length: this.slots.length }, (_, i) => (i < places ? { type: 'open' } : { type: 'closed' }));
    // People keep their place when it is a mission place, else take the first free one.
    for (const [i, s] of this.slots.entries()) if (s.type === 'human' && i < places) slots[i] = s;
    for (const [i, s] of this.slots.entries()) {
      if (s.type !== 'human' || i < places) continue;
      slots[slots.findIndex((x, k) => k < places && x.type === 'open')] = s;
    }
    this.slots = slots;
    this.mission = { id: mission.id, hash: mission.hash, options: { ...mission.options } };
    this.map = null;
    this.mapStates = {};
    this.keepSpawnsFor(field);
    this.resetReady();
  }

  /** Whether `client` is in the lobby: a slot or a spectator place. */
  isMember(client) {
    return this.slotOf(client) >= 0 || this.isSpectator(client);
  }

  /** A member installed or declined the lobby's map with `hash` (lobby only). */
  setMapState(client, hash, state) {
    if (this.phase !== 'lobby') fail('The game has already started.', 'bad_state');
    if (!this.isMember(client)) fail('You are not in this lobby.', 'bad_state');
    if (!this.map) fail('The lobby has no map file.', 'bad_state');
    if (hash !== this.map.hash) fail('The lobby map changed.', 'bad_state');
    this.mapStates[client] = state;
    const slot = this.slotOf(client);
    if (state !== 'installed' && slot >= 0) this.slots[slot].ready = false;
  }

  /** The member's state for the lobby's map, or undefined without a map. */
  mapStateOf(client) {
    if (!this.map) return undefined;
    return Object.hasOwn(this.mapStates, client) ? this.mapStates[client] : 'missing';
  }

  /** Host: remove a spectator from the lobby. Returns its client id. */
  kickSpectator(client, target) {
    if (this.phase !== 'lobby') fail('The game has already started.', 'bad_state');
    if (!this.isHost(client)) fail('Only the host can remove spectators.', 'not_host');
    if (target === client) fail('You cannot remove yourself.');
    if (!this.isSpectator(target)) fail('That member is not a spectator.', 'not_found');
    this.leave(target);
    return target;
  }

  setReady(client, ready, mapHash) {
    if (this.phase !== 'lobby') fail('The game has already started.', 'bad_state');
    const slot = this.slotOf(client);
    if (slot < 0) fail('You have no slot.', 'bad_state');
    if (ready && mapHash !== (this.map ? this.map.hash : null)) {
      fail('You do not have the selected map installed.', 'not_ready');
    }
    // Ready with the map's hash means the map is installed.
    if (ready && this.map) this.mapStates[client] = 'installed';
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
    if (this.mission) {
      const places = this.missionPlaces();
      if (this.slots.slice(0, places).some((s) => s.type !== 'human')) return `This mission needs a player in each of its ${places} places.`;
      if (this.resume) {
        const waiting = this.resumeView().waiting;
        if (waiting.length) return `Waiting for ${waiting.join(', ')} to come back.`;
      }
      if (this.slots.some((s) => s.type === 'human' && s.client !== this.hostId && !s.ready)) return 'Not everyone is ready.';
      return null;
    }
    if (players.length < MIN_PLAYERS) return 'At least two players are needed.';
    if (this.map && players.length > this.map.players) return `This map has room for ${this.map.players} players.`;
    const locked = this.lockedProblem();
    if (locked) return locked;
    const picks = this.resume ? null : spawnPickProblem(players, this.spawnCount());
    if (picks) return picks;
    if (this.resume) {
      const waiting = this.resumeView().waiting;
      if (waiting.length) return `Waiting for ${waiting.join(', ')} to come back.`;
    }
    if (this.map) {
      // Every player and spectator needs the exact map (the host has it).
      const lacking = [...this.humans(), ...this.spectators].find((m) => this.mapStateOf(m.client) !== 'installed');
      if (lacking) return `${lacking.name} does not have the map installed.`;
    }
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
    if (this.resume) return this.startResume();
    const players = [];
    const startPlayers = [];
    const seats = [];
    // The spawn a slot picked; automatic ones are left out (protocol spawns.js decides with the engine).
    const picked = (s) => (Number.isInteger(s.spawn) ? { spawn: s.spawn } : {});
    this.slots.forEach((s, slot) => {
      if (s.type !== 'human' && s.type !== 'ai') return;
      const index = players.length;
      const pool = RANDOM_FACTIONS[s.faction];
      const faction = pool ? pool[pick(pool.length)] : s.faction;
      if (s.type === 'human') {
        players.push({ slot: index, type: 'human', name: s.name, faction, color: s.color, team: s.team, handicap: s.handicap ?? 0, ...picked(s) });
        startPlayers.push({ player: index, slot, client: s.client, name: s.name, type: 'human' });
        seats.push(s.client);
      } else {
        const name = aiName(s);
        const bot = s.bot ?? 'normal';
        players.push({ slot: index, type: 'ai', name, difficulty: s.difficulty, bot, faction, color: s.color, team: s.team, handicap: s.handicap ?? 0, ...picked(s) });
        startPlayers.push({ player: index, slot, client: null, name, type: 'ai' });
        seats.push(null);
      }
    });
    this.phase = 'game';
    this.rematch = null;
    this.rematchCooldown = 0;
    this.returning = {};
    this.saving = null;
    this.seats = seats;
    this.seatStates = seats.map((c) => (c === null ? null : { state: 'active', until: 0, record: null }));
    this.startMsg = {
      seed: this.options.seed,
      // A co-op mission has no debug menu (the engine refuses cheats there too).
      options: { ...this.options, ...(this.mission ? { cheats: false } : {}), players },
      map: this.map,
      players: startPlayers,
      delay: ORDER_DELAY,
    };
    if (this.mission) this.startMsg.mission = structuredClone(this.mission);
    return structuredClone(this.startMsg);
  }

  // ---- Rematch ---------------------------------------------------------------------

  /**
   * Clients whose answer a rematch needs: every seat still in the game
   * (active, or away and allowed to rejoin: it answers once it is back).
   */
  rematchVoters() {
    return (this.seatStates ?? []).flatMap((s, seat) => (s && s.state !== 'gone' ? [this.seats[seat]] : []));
  }


  /**
   * Propose a rematch (game only). The proposer accepts it at once when it
   * holds a seat. Throws RoomError when it cannot be proposed now.
   */
  proposeRematch(client, now) {
    if (this.phase !== 'game') fail('There is no game to play again.', 'bad_state');
    if (this.rematch) fail('A rematch is already proposed.', 'bad_state');
    if (!this.isHost(client)) fail('Only the host can propose a rematch.', 'not_host');
    if (now < this.rematchCooldown) fail('Wait a moment before proposing again.', 'rate_limited');
    this.rematch = { by: client, accepted: this.rematchVoters().includes(client) ? [client] : [], until: now + REMATCH_VOTE_MS };
  }

  /**
   * An answer to the open proposal. A voter accepts or declines (a decline
   * cancels it); the proposer may withdraw it. Returns null, or the cancel
   * reason when the proposal ended.
   */
  answerRematch(client, accept, now) {
    const r = this.rematch;
    if (!r) fail('No rematch is proposed.', 'bad_state');
    const voter = this.rematchVoters().includes(client);
    if (!accept) {
      if (!voter && client !== r.by) fail('Only players answer a rematch.', 'forbidden');
      return this.cancelRematch(client === r.by ? 'withdrawn' : 'declined', now);
    }
    if (!voter) fail('Only players answer a rematch.', 'forbidden');
    if (!r.accepted.includes(client)) r.accepted.push(client);
    return null;
  }

  cancelRematch(reason, now) {
    this.rematch = null;
    this.rematchCooldown = now + REMATCH_COOLDOWN_MS;
    return reason;
  }

  /** The `rematch` message fields for the open proposal (accepted and waiting among the current voters). */
  rematchStatus(now) {
    const r = this.rematch;
    const voters = this.rematchVoters();
    return {
      state: 'open',
      by: r.by,
      accepted: r.accepted.filter((c) => voters.includes(c)),
      waiting: voters.filter((c) => !r.accepted.includes(c)),
      msLeft: Math.max(0, r.until - now),
    };
  }

  /** Every voter accepted (and the proposer is still here to host). */
  rematchAgreed() {
    return !!this.rematch && this.rematchVoters().every((c) => this.rematch.accepted.includes(c));
  }

  /**
   * Back to the lobby with the same slots, options and map. `present`: the
   * clients that keep their places (the accepting players and the connected
   * spectators); they must come back by `now + REMATCH_RETURN_MS`. Every
   * other place opens. Returns the returning clients.
   */
  backToLobby(present, now) {
    if (!this.rematchAgreed()) fail('Not everyone accepted the rematch.', 'bad_state');
    const by = this.rematch.by;
    const keep = new Set(present.filter((c) => this.slotOf(c) >= 0 || this.isSpectator(c)));
    const field = this.battlefield();
    this.slots = this.slots.map((s) => {
      if (s.type !== 'human') return s;
      return keep.has(s.client) ? { ...s, ready: false } : { type: 'open' };
    });
    this.spectators = this.spectators.filter((s) => keep.has(s.client));
    for (const id of Object.keys(this.keys)) if (!keep.has(Number(id))) delete this.keys[id];
    for (const id of Object.keys(this.accounts)) if (!keep.has(Number(id))) delete this.accounts[id];
    this.phase = 'lobby';
    this.seats = null;
    this.seatStates = null;
    this.startMsg = null;
    this.rejoins = {};
    this.rematch = null;
    this.rematchCooldown = 0;
    this.saving = null;
    this.resumeStart = null;
    // Everyone coming back played (or watched) this map: they have it.
    this.mapStates = this.map ? Object.fromEntries([...keep].map((c) => [c, 'installed'])) : {};
    this.hostId = keep.has(by) ? by : (this.slots.find((s) => s.type === 'human')?.client ?? this.spectators[0]?.client ?? null);
    this.returning = Object.fromEntries([...keep].map((c) => [c, now + REMATCH_RETURN_MS]));
    this.keepSpawnsFor(field);
    return [...keep];
  }

  /** Whether `client` is on its way back from the finished game into the lobby. */
  isReturning(client) {
    return this.phase === 'lobby' && Object.hasOwn(this.returning, client);
  }

  /**
   * A returning member connected again (its rejoin key was checked by the
   * caller). It stays returning until its deadline: a page that reloads once
   * more (or a connection that dropped meanwhile) can come back again
   * without losing the place.
   */
  returned(client, now) {
    if (!this.isReturning(client)) fail('You are not coming back from a game.', 'forbidden');
    if (this.returning[client] <= now) fail('You came back too late.', 'forbidden');
  }

  /** The return window ended with the member connected: it is simply in the lobby now. */
  settleReturn(client) {
    delete this.returning[client];
  }

  /** Returning members whose deadline passed. */
  expiredReturns(now) {
    return Object.entries(this.returning).flatMap(([c, until]) => (until <= now ? [Number(c)] : []));
  }

  /** The earliest return deadline, or null. */
  nextReturnDeadline() {
    const all = Object.values(this.returning);
    return all.length ? Math.min(...all) : null;
  }

  /**
   * Start a resumed save: the saved options exactly, every human seat
   * catching up (`syncing`; the caller sets deadlines), and `resumeStart`
   * until all of them did. Returns the start message fields.
   */
  startResume() {
    const r = this.resume;
    const players = r.options.players;
    const seats = players.map((p, i) => (p.type === 'human' ? this.slots[i].client : null));
    this.phase = 'game';
    this.rematch = null;
    this.rematchCooldown = 0;
    this.returning = {};
    this.saving = null;
    this.seats = seats;
    this.seatStates = seats.map((c) => (c === null ? null : { state: 'syncing', until: 0, record: null }));
    this.startMsg = {
      seed: r.options.seed,
      options: structuredClone(r.options),
      map: this.map,
      players: players.map((p, i) => ({ player: i, slot: i, client: seats[i], name: p.type === 'human' ? this.slots[i].name : p.name, type: p.type })),
      delay: ORDER_DELAY,
      resume: { ticks: r.ticks, hash: r.hash },
    };
    if (this.mission) this.startMsg.mission = structuredClone(this.mission);
    this.resumeStart = { ticks: r.ticks, hash: r.hash };
    this.resume = null;
    return structuredClone(this.startMsg);
  }

  // ---- Online saves -----------------------------------------------------------------------

  /** Whether every human seat is still in the game and signed in (online saves need accounts). */
  saveProblem() {
    if (this.phase !== 'game' || this.resumeStart) return 'There is no running game to save.';
    for (const [seat, c] of (this.seats ?? []).entries()) {
      if (c === null) continue;
      if (this.seatState(seat) === 'gone') return 'Every player who started the game must still be in it to save it.';
      if (this.accountOf(c) === null) return 'Saving online games needs every player signed in with an account.';
    }
    return null;
  }

  /** Clients whose answer a save needs: the players still in the game. */
  saveVoters() {
    return this.rematchVoters();
  }

  /** Propose saving (any player still in the game); the proposer accepts at once. */
  proposeSave(client, now) {
    if (this.saving) fail('Saving is already under way.', 'bad_state');
    if (!this.saveVoters().includes(client)) fail('Only players can propose saving.', 'forbidden');
    if (now < this.saveCooldown) fail('Wait a moment before proposing again.', 'rate_limited');
    const problem = this.saveProblem();
    if (problem) fail(problem, 'forbidden');
    this.saving = { phase: 'open', by: client, accepted: [client], until: now + SAVE_VOTE_MS };
  }

  /** An answer to the open proposal; returns the cancel reason when it ended, else null. */
  answerSave(client, accept, now) {
    const sv = this.saving;
    if (!sv) fail('Nobody proposed saving.', 'bad_state');
    if (sv.phase !== 'open') fail('The game is being saved.', 'bad_state');
    if (!this.saveVoters().includes(client)) fail('Only players answer.', 'forbidden');
    if (!accept) return this.cancelSave(client === sv.by ? 'withdrawn' : 'declined', now);
    if (!sv.accepted.includes(client)) sv.accepted.push(client);
    return null;
  }

  /** The proposal or save in progress ended (also after a successful save): a short cooldown follows. */
  cancelSave(reason, now) {
    this.saving = null;
    this.saveCooldown = now + SAVE_COOLDOWN_MS;
    return reason;
  }

  /** The open proposal as a `save` message. */
  saveStatus(now) {
    const sv = this.saving;
    const voters = this.saveVoters();
    return { state: 'open', by: sv.by, accepted: sv.accepted.filter((c) => voters.includes(c)), waiting: voters.filter((c) => !sv.accepted.includes(c)), msLeft: Math.max(0, sv.until - now) };
  }

  /** Every voter accepted and is connected: `active` says whether a seat is connected now. */
  saveAgreed(active) {
    const sv = this.saving;
    if (!sv || sv.phase !== 'open') return false;
    const voters = this.saveVoters();
    return voters.every((c) => sv.accepted.includes(c) && active(c));
  }

  /**
   * Agreed: the save point is the first hash tick at or after `from` (the
   * next frame the server sends plus the order delay, so no player ran it).
   * Returns it.
   */
  agreeSave(from, now) {
    const tick = Math.ceil(from / HASH_INTERVAL) * HASH_INTERVAL;
    this.saving = { phase: 'agreed', tick, hashes: {}, voters: this.saveVoters(), until: now + SAVE_HASH_MS };
    return tick;
  }

  /**
   * A player's state hash at `tick`. Returns null while hashes are missing,
   * 'desync' when they differ, or 'complete' with every voter agreeing.
   */
  noteSaveHash(client, tick, hash) {
    const sv = this.saving;
    if (!sv || sv.phase !== 'agreed' || tick !== sv.tick || !sv.voters.includes(client)) return null;
    sv.hashes[client] = hash;
    const all = sv.voters.map((c) => sv.hashes[c]);
    if (all.some((h) => h === undefined)) return null;
    return all.every((h) => h === all[0]) ? 'complete' : 'desync';
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

  /**
   * A seat leaves play for a while (its catch-up of a resumed save ran out):
   * away with a fresh grace of `graceMs` to rejoin, like a lost connection.
   */
  awaySeat(seat, now, graceMs) {
    const s = this.seatStates?.[seat];
    if (!s || s.state === 'gone') return false;
    s.state = 'away';
    s.until = now + graceMs;
    s.graceUntil = s.until;
    s.record = null;
    return true;
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
    const mark = (entry) => {
      const out = this.accountOf(entry.client) !== null ? { ...entry, account: true } : { ...entry };
      if (this.map) out.mapState = this.mapStateOf(entry.client);
      return out;
    };
    const view = {
      slots: this.slots.map((s) => {
        if (s.type === 'human') return mark(s);
        const { reserved: _reserved, ...rest } = s;
        return rest;
      }),
      options: { ...this.options },
      map: this.map,
      hostId: this.hostId,
      spectators: this.spectators.map(mark),
      maxSpectators: this.maxSpectators,
    };
    if (this.resume) view.resume = this.resumeView();
    if (this.mission) view.mission = structuredClone(this.mission);
    return view;
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

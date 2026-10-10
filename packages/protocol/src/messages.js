// WebSocket messages (docs/contracts.md, section 4). JSON objects `{ t, ... }`.
//
// parseClientMessage / parseServerMessage take raw text, enforce the size
// limit, parse, and strictly validate: unknown types or fields are rejected and
// the returned message is a fresh object holding only validated, normalized
// values. encodeClient / encodeServer validate before serializing, so neither
// side can emit a message the other side would reject.

import {
  ACTOR_TYPE_MAX,
  C2S,
  CHAT_MAX,
  COLOR_COUNT,
  DEV_FLAGS,
  DIFFICULTIES,
  BOTS,
  ERROR_CODE_RE,
  ERROR_MESSAGE_MAX,
  HASH_INTERVAL,
  HOST_KEY_RE,
  HOST_SLOT_TYPES,
  LEFT_REASONS,
  MAP_ID_RE,
  MAP_STATES,
  MAX_MESSAGE_BYTES,
  MAX_ORDERS_PER_TICK,
  MAX_PLAYERS,
  MAX_SERVER_MESSAGE_BYTES,
  MAX_SPECTATORS,
  MIN_PLAYERS,
  NAME_MAX,
  NAME_MIN,
  ORDER_MAX_COUNT,
  ORDER_MAX_IDS,
  PASSWORD_MAX,
  REMATCH_CANCEL_REASONS,
  REMATCH_STATES,
  SAVE_CANCEL_REASONS,
  SAVE_ID_RE,
  SAVE_STATES,
  ROLES,
  S2C,
  SEAT_KEY_RE,
  SEED_MAX,
  SESSION_ID_RE,
  SESSION_NAME_MAX,
  SHA256_RE,
  SLOT_MAX,
  SLOT_TYPES,
  STANCES,
  STATE_HASH_RE,
  TEAM_MAX,
  TICK_MAX,
  VERSION_RE,
  HANDICAPS,
} from './constants.js';
import {
  bool,
  excerpt,
  fail,
  has,
  int,
  isPlainObject,
  matches,
  object,
  oneOf,
  ProtocolError,
  text,
  truncate,
  utf8Length,
} from './check.js';
import { MAP_MAX_BYTES, MAP_MAX_SIZE, MAP_MIN_SIZE } from './map.js';
import { validateGameOptions, validateLobbyOptions, validFaction } from './options.js';

const CLIENT_ID_MAX = 0x7fffffff;

// ---- Shared pieces ------------------------------------------------------------------

/** A password: any characters, 1..PASSWORD_MAX code units, no normalization. */
export function validPassword(v, what = 'password') {
  if (typeof v !== 'string' || v.length < 1 || v.length > PASSWORD_MAX) {
    fail(`${what} must be 1 to ${PASSWORD_MAX} characters`);
  }
  return v;
}

export function validName(v, what = 'name') {
  return text(v, NAME_MIN, NAME_MAX, what);
}

export function validSessionName(v, what = 'name') {
  return text(v, 1, SESSION_NAME_MAX, what);
}

function validTick(v, what = 'tick') {
  return int(v, 0, TICK_MAX, what);
}

function validClientId(v, what) {
  return int(v, 1, CLIENT_ID_MAX, what);
}

const U32_MAX = 0xffffffff;
const I32_MIN = -0x80000000;
const I32_MAX = 0x7fffffff;

function idList(v, what) {
  if (!Array.isArray(v) || v.length > ORDER_MAX_IDS) fail(`${what} must list at most ${ORDER_MAX_IDS} ids`);
  return v.map((id) => int(id, 0, U32_MAX, what));
}

const i32 = (v, what) => int(v, I32_MIN, I32_MAX, what);
const u32 = (v, what) => int(v, 0, U32_MAX, what);
/** Field that may be left out (serde `Option` with a default in the engine). */
const optional = (check) => Object.assign((v, what) => check(v, what), { optional: true });
/** Support power key: an OpenRA trait name such as `AirstrikePower@spyplane`. */
const powerKey = (v, what) => {
  if (typeof v !== 'string' || !/^[A-Za-z0-9@._-]{1,64}$/.test(v)) fail(`${what} must be a power key`);
  return v;
};

// Mirrors `Order` in engine/src/world.rs (serde tag "o", snake_case variants,
// deny_unknown_fields) including its is_reasonable() caps. `player` is
// required by the engine but always re-stamped from the sender's seat.
const ORDER_SCHEMA = {
  move: { ids: idList, x: i32, y: i32, attack_move: bool },
  smart: { ids: idList, x: i32, y: i32 },
  attack: { ids: idList, target: u32 },
  stop: { ids: idList },
  start_production: { ty: (v, w) => int(v, 0, ACTOR_TYPE_MAX, w), count: (v, w) => int(v, 1, ORDER_MAX_COUNT, w) },
  cancel_production: { ty: (v, w) => int(v, 0, ACTOR_TYPE_MAX, w) },
  // engine/src/production.rs: put the first queued item of a type on hold or resume it.
  pause_production: { ty: (v, w) => int(v, 0, ACTOR_TYPE_MAX, w), paused: bool },
  place: { ty: (v, w) => int(v, 0, ACTOR_TYPE_MAX, w), cx: i32, cy: i32 },
  rally: { building: u32, x: i32, y: i32 },
  sell: { building: u32 },
  deploy: { ids: idList },
  // Helicopters (engine/src/helicopter.rs).
  land: { ids: idList, x: i32, y: i32 },
  return_to_base: { ids: idList },
  // engine/src/powers.rs: (x2, y2) optionally gives aircraft powers their direction.
  support_power: { key: powerKey, x: i32, y: i32, x2: optional(i32), y2: optional(i32) },
  // engine/src/abilities.rs: minefield cell rectangle (at most MINEFIELD_MAX_CELLS) and chrono tank jump.
  lay_mines: { ids: idList, x0: i32, y0: i32, x1: i32, y1: i32 },
  teleport: { ids: idList, x: i32, y: i32 },
  // engine/src/commands.rs: the command bar (force-fire on the ground, guard,
  // scatter, queued waypoints, fire stances).
  attack_ground: { ids: idList, x: i32, y: i32 },
  guard: { ids: idList, target: u32 },
  scatter: { ids: idList },
  waypoint: { ids: idList, x: i32, y: i32, attack_move: bool },
  set_stance: { ids: idList, stance: (v, w) => oneOf(v, STANCES, w) },
  // engine/src/repair.rs and beacons.rs: the sidebar's Repair and Power down
  // buttons (start or stop repairing a structure, switch one off or on) and
  // map beacons for allies.
  repair_building: { building: u32 },
  power_down: { building: u32 },
  place_beacon: { x: i32, y: i32 },
  // engine/src/debug.rs: debug menu cheats, only valid in games with the
  // `cheats` option (the server refuses them otherwise, see CHEAT_ORDER_KINDS).
  dev_flag: { flag: (v, w) => oneOf(v, DEV_FLAGS, w), on: bool },
  dev_cash: {},
  dev_kill: { ids: idList },
  // engine/src/veterancy.rs: one more veterancy level for the player's own listed units.
  dev_experience: { ids: idList },
};

/** Cheat orders: allowed only when the game's options have `cheats: true`. */
export const CHEAT_ORDER_KINDS = ['dev_flag', 'dev_cash', 'dev_kill', 'dev_experience'];

/** Whether an order is a cheat (debug menu) order. */
export function isCheatOrder(o) {
  return isPlainObject(o) && CHEAT_ORDER_KINDS.includes(o.o);
}

/** Largest minefield one lay_mines order may cover (engine abilities::MAX_MINEFIELD_CELLS). */
export const MINEFIELD_MAX_CELLS = 32 * 32;

export const ORDER_KINDS = Object.keys(ORDER_SCHEMA);

/** Validate one engine order; returns a fresh object in the engine's field order. */
export function validOrder(o, what = 'order') {
  if (!isPlainObject(o) || typeof o.o !== 'string' || !Object.hasOwn(ORDER_SCHEMA, o.o)) {
    fail(`${what} has an unknown order type`);
  }
  const schema = ORDER_SCHEMA[o.o];
  object(o, ['o', 'player', ...Object.keys(schema)], what);
  const out = { o: o.o, player: int(o.player, 0, MAX_PLAYERS - 1, `${what}.player`) };
  for (const [k, check] of Object.entries(schema)) {
    if (!has(o, k) && check.optional) continue;
    if (!has(o, k)) fail(`${what}.${k} is required`);
    out[k] = check(o[k], `${what}.${k}`);
  }
  if (out.o === 'lay_mines' && (Math.abs(out.x1 - out.x0) + 1) * (Math.abs(out.y1 - out.y0) + 1) > MINEFIELD_MAX_CELLS) {
    fail(`${what}: minefield larger than ${MINEFIELD_MAX_CELLS} cells`);
  }
  return out;
}

/** Orders of one player for one tick. */
export function validOrders(v, what = 'orders') {
  if (!Array.isArray(v)) fail(`${what} must be a list`);
  if (v.length > MAX_ORDERS_PER_TICK) fail(`${what}: at most ${MAX_ORDERS_PER_TICK} orders per tick`);
  return v.map((o, i) => validOrder(o, `${what}[${i}]`));
}

/**
 * The orders of one frame: `[[player, [order, ...]], ...]`, each player at
 * most once. Used by `frame` and `log` messages and by replay files.
 */
export function validFrameOrders(v, what = 'frame.orders') {
  if (!Array.isArray(v) || v.length > MAX_PLAYERS) fail(`${what} must be a list of at most ${MAX_PLAYERS} entries`);
  const seen = new Set();
  return v.map((entry, i) => {
    if (!Array.isArray(entry) || entry.length !== 2) fail(`${what}[${i}] must be [player, orders]`);
    const player = int(entry[0], 0, MAX_PLAYERS - 1, `${what}[${i}] player`);
    if (seen.has(player)) fail(`${what} lists a player twice`);
    seen.add(player);
    return [player, validOrders(entry[1], `${what}[${i}]`)];
  });
}

const MAP_REF_KEYS = ['id', 'hash', 'name', 'modded'];
/**
 * What the server announces about a lobby or game map: the host's request
 * fields plus what it looked up itself (players, author, size, file bytes,
 * and `shared`: a map the host shared with this session only, see
 * docs/security.md "Map sharing").
 */
const MAP_INFO_KEYS = [...MAP_REF_KEYS, 'players', 'author', 'width', 'height', 'bytes', 'shared'];

/**
 * Map reference in a lobby: null for a generated map, else a stored map. The
 * host's `map` message names a community map with the four request fields;
 * with `full` (lobby and start messages) the server's description of it.
 */
export function validMapRef(v, what = 'map', full = false) {
  if (v === null) return null;
  object(v, full ? MAP_INFO_KEYS : MAP_REF_KEYS, what);
  const out = {
    id: matches(v.id, MAP_ID_RE, `${what}.id`),
    hash: matches(v.hash, SHA256_RE, `${what}.hash`),
    name: text(v.name, 1, 64, `${what}.name`),
    modded: bool(v.modded, `${what}.modded`),
  };
  if (full) {
    out.players = int(v.players, MIN_PLAYERS, MAX_PLAYERS, `${what}.players`);
    out.author = text(v.author, 1, 64, `${what}.author`);
    out.width = int(v.width, MAP_MIN_SIZE, MAP_MAX_SIZE, `${what}.width`);
    out.height = int(v.height, MAP_MIN_SIZE, MAP_MAX_SIZE, `${what}.height`);
    out.bytes = int(v.bytes, 1, MAP_MAX_BYTES, `${what}.bytes`);
    out.shared = bool(v.shared, `${what}.shared`);
  }
  return out;
}

/** A lobby member's map state, present on slots and spectators only while the lobby has a map. */
function mapStateOf(v, out, what) {
  if (has(v, 'mapState')) out.mapState = oneOf(v.mapState, MAP_STATES, `${what}.mapState`);
  return out;
}

/** The `resume` field of a lobby message: the saved online game it continues. */
export function validResumeInfo(v, what = 'resume') {
  object(v, ['id', 'title', 'createdAt', 'ticks', 'waiting'], what);
  if (!Array.isArray(v.waiting) || v.waiting.length > MAX_PLAYERS) fail(`${what}.waiting must list at most ${MAX_PLAYERS} names`);
  return {
    id: matches(v.id, SAVE_ID_RE, `${what}.id`),
    title: text(v.title, 1, 64, `${what}.title`),
    createdAt: int(v.createdAt, 0, Number.MAX_SAFE_INTEGER, `${what}.createdAt`),
    ticks: int(v.ticks, 1, TICK_MAX, `${what}.ticks`),
    waiting: v.waiting.map((n, i) => validName(n, `${what}.waiting[${i}]`)),
  };
}

// ---- Client to server -------------------------------------------------------------------

const CLIENT = {
  [C2S.HELLO](m) {
    object(m, ['t', 'protocol', 'version', 'name', 'password', 'hostKey', 'spectate', 'rejoin'], 'hello');
    const out = {
      t: C2S.HELLO,
      protocol: int(m.protocol, 0, 0xffff, 'protocol'),
      version: matches(m.version, VERSION_RE, 'version'),
    };
    // Signed-in connections play under their username; anonymous ones must name themselves.
    if (has(m, 'name')) out.name = validName(m.name);
    if (has(m, 'password')) out.password = validPassword(m.password);
    if (has(m, 'hostKey')) out.hostKey = matches(m.hostKey, HOST_KEY_RE, 'hostKey');
    // Join as a spectator (lobby, or a running game).
    if (has(m, 'spectate') && bool(m.spectate, 'spectate')) out.spectate = true;
    // Back into a running game with the key from `welcome.key`.
    if (has(m, 'rejoin')) {
      object(m.rejoin, ['client', 'key'], 'rejoin');
      out.rejoin = { client: validClientId(m.rejoin.client, 'rejoin.client'), key: matches(m.rejoin.key, SEAT_KEY_RE, 'rejoin.key') };
      if (out.hostKey !== undefined || out.spectate) fail('rejoin cannot be combined with hostKey or spectate');
    }
    return out;
  },
  [C2S.SLOT](m) {
    object(m, ['t', 'slot', 'faction', 'color', 'team', 'type', 'difficulty', 'bot', 'handicap'], 'slot');
    const out = { t: C2S.SLOT, slot: int(m.slot, 0, SLOT_MAX, 'slot') };
    if (has(m, 'handicap')) out.handicap = oneOf(m.handicap, HANDICAPS, 'handicap');
    if (has(m, 'faction')) out.faction = validFaction(m.faction, 'faction');
    if (has(m, 'color')) out.color = int(m.color, 0, COLOR_COUNT - 1, 'color');
    if (has(m, 'team')) out.team = int(m.team, 0, TEAM_MAX, 'team');
    if (has(m, 'type')) out.type = oneOf(m.type, HOST_SLOT_TYPES, 'type');
    if (has(m, 'difficulty')) out.difficulty = oneOf(m.difficulty, DIFFICULTIES, 'difficulty');
    if (has(m, 'bot')) out.bot = oneOf(m.bot, BOTS, 'bot');
    return out;
  },
  [C2S.OPTIONS](m) {
    object(m, ['t', 'options'], 'options');
    return { t: C2S.OPTIONS, options: validateLobbyOptions(m.options) };
  },
  [C2S.MAP](m) {
    object(m, ['t', 'map'], 'map');
    if (!has(m, 'map')) fail('map is required (null for a generated map)');
    return { t: C2S.MAP, map: validMapRef(m.map) };
  },
  [C2S.READY](m) {
    object(m, ['t', 'ready', 'mapHash'], 'ready');
    const mapHash = m.mapHash === null || m.mapHash === undefined ? null : matches(m.mapHash, SHA256_RE, 'mapHash');
    return { t: C2S.READY, ready: bool(m.ready, 'ready'), mapHash };
  },
  [C2S.CHAT](m) {
    // `team`: only for the sender's team (OpenRA team chat); spectators chat among themselves.
    object(m, ['t', 'text', 'team'], 'chat');
    const out = { t: C2S.CHAT, text: text(m.text, 1, CHAT_MAX, 'text') };
    if (has(m, 'team') && bool(m.team, 'team')) out.team = true;
    return out;
  },
  [C2S.START](m) {
    object(m, ['t'], 'start');
    return { t: C2S.START };
  },
  [C2S.ORDERS](m) {
    object(m, ['t', 'tick', 'orders'], 'orders');
    return { t: C2S.ORDERS, tick: validTick(m.tick), orders: validOrders(m.orders) };
  },
  [C2S.HASH](m) {
    object(m, ['t', 'tick', 'hash'], 'hash');
    const tick = validTick(m.tick);
    if (tick % HASH_INTERVAL !== 0) fail(`hash ticks are multiples of ${HASH_INTERVAL}`);
    return { t: C2S.HASH, tick, hash: matches(m.hash, STATE_HASH_RE, 'hash') };
  },
  [C2S.LEAVE](m) {
    object(m, ['t'], 'leave');
    return { t: C2S.LEAVE };
  },
  [C2S.SPECTATORS](m) {
    object(m, ['t', 'max'], 'spectators');
    return { t: C2S.SPECTATORS, max: int(m.max, 0, MAX_SPECTATORS, 'max') };
  },
  [C2S.SPECTATE](m) {
    object(m, ['t', 'on'], 'spectate');
    return { t: C2S.SPECTATE, on: bool(m.on, 'on') };
  },
  [C2S.RESUME](m) {
    object(m, ['t'], 'resume');
    return { t: C2S.RESUME };
  },
  [C2S.SYNCED](m) {
    object(m, ['t'], 'synced');
    return { t: C2S.SYNCED };
  },
  [C2S.DEFEATED](m) {
    object(m, ['t'], 'defeated');
    return { t: C2S.DEFEATED };
  },
  [C2S.MAPSTATE](m) {
    // Only for the lobby map with this hash; `missing` is the server's default, never sent.
    object(m, ['t', 'hash', 'state'], 'mapstate');
    return { t: C2S.MAPSTATE, hash: matches(m.hash, SHA256_RE, 'hash'), state: oneOf(m.state, ['installed', 'declined'], 'state') };
  },
  [C2S.KICK](m) {
    object(m, ['t', 'client'], 'kick');
    return { t: C2S.KICK, client: validClientId(m.client, 'client') };
  },
  [C2S.REMATCH](m) {
    object(m, ['t', 'accept'], 'rematch');
    return { t: C2S.REMATCH, accept: bool(m.accept, 'accept') };
  },
  [C2S.SAVE](m) {
    object(m, ['t', 'accept'], 'save');
    return { t: C2S.SAVE, accept: bool(m.accept, 'accept') };
  },
};

// ---- Server to client ---------------------------------------------------------------------

const SESSION_KEYS = ['id', 'name', 'public', 'locked', 'maxPlayers', 'version'];

function validSessionInfo(v, what = 'session') {
  object(v, SESSION_KEYS, what);
  return {
    id: matches(v.id, SESSION_ID_RE, `${what}.id`),
    name: validSessionName(v.name, `${what}.name`),
    public: bool(v.public, `${what}.public`),
    locked: bool(v.locked, `${what}.locked`),
    maxPlayers: int(v.maxPlayers, MIN_PLAYERS, MAX_PLAYERS, `${what}.maxPlayers`),
    version: matches(v.version, VERSION_RE, `${what}.version`),
  };
}

const LOBBY_SLOT_KEYS = ['type', 'client', 'name', 'account', 'faction', 'color', 'team', 'difficulty', 'bot', 'ready', 'handicap', 'mapState'];

/** One slot of the online lobby as the server publishes it. */
export function validLobbySlot(v, what = 'slot') {
  object(v, LOBBY_SLOT_KEYS, what);
  const type = oneOf(v.type, SLOT_TYPES, `${what}.type`);
  const out = { type };
  if (type === 'open' || type === 'closed') {
    for (const k of LOBBY_SLOT_KEYS) if (k !== 'type' && has(v, k)) fail(`${what}: empty slots carry no ${k}`);
    return out;
  }
  if (type === 'human') {
    out.client = validClientId(v.client, `${what}.client`);
    out.name = validName(v.name, `${what}.name`);
    out.ready = bool(v.ready, `${what}.ready`);
    // Present (true) only when the name comes from a signed-in account.
    if (has(v, 'account') && bool(v.account, `${what}.account`)) out.account = true;
    if (has(v, 'difficulty')) fail(`${what}: humans have no difficulty`);
    if (has(v, 'bot')) fail(`${what}: humans have no bot`);
    mapStateOf(v, out, what);
  } else {
    if (has(v, 'client') || has(v, 'name') || has(v, 'ready') || has(v, 'account') || has(v, 'mapState')) {
      fail(`${what}: AI slots carry no client, name, account, ready or map state`);
    }
    out.difficulty = oneOf(v.difficulty, DIFFICULTIES, `${what}.difficulty`);
    // Bot type: left out means the Normal AI (lobbies from before bot types).
    if (has(v, 'bot')) out.bot = oneOf(v.bot, BOTS, `${what}.bot`);
  }
  out.faction = validFaction(v.faction, `${what}.faction`);
  out.color = int(v.color, 0, COLOR_COUNT - 1, `${what}.color`);
  out.team = int(v.team, 0, TEAM_MAX, `${what}.team`);
  // Handicap: left out means 0.
  if (has(v, 'handicap')) out.handicap = oneOf(v.handicap, HANDICAPS, `${what}.handicap`);
  return out;
}

const START_PLAYER_KEYS = ['player', 'slot', 'client', 'name', 'type'];

const SERVER = {
  [S2C.WELCOME](m) {
    object(m, ['t', 'you', 'name', 'hostId', 'session', 'role', 'key'], 'welcome');
    const out = {
      t: S2C.WELCOME,
      you: validClientId(m.you, 'you'),
      // The name this member plays under (its username when signed in).
      name: validName(m.name, 'name'),
      hostId: m.hostId === null ? null : validClientId(m.hostId, 'hostId'),
      session: validSessionInfo(m.session),
      role: oneOf(m.role, ROLES, 'role'),
    };
    // Only on a first join: the rejoin key (a rejoin keeps the old one).
    if (has(m, 'key')) out.key = matches(m.key, SEAT_KEY_RE, 'key');
    return out;
  },
  [S2C.LOBBY](m) {
    object(m, ['t', 'slots', 'options', 'map', 'hostId', 'spectators', 'maxSpectators', 'resume'], 'lobby');
    if (!Array.isArray(m.slots) || m.slots.length < MIN_PLAYERS || m.slots.length > MAX_PLAYERS) {
      fail('lobby.slots must list 2 to 8 slots');
    }
    const maxSpectators = int(m.maxSpectators, 0, MAX_SPECTATORS, 'maxSpectators');
    if (!Array.isArray(m.spectators) || m.spectators.length > maxSpectators) fail('lobby.spectators must list at most maxSpectators');
    const clients = new Set();
    const spectators = m.spectators.map((v, i) => {
      object(v, ['client', 'name', 'account', 'mapState'], `spectators[${i}]`);
      const sp = { client: validClientId(v.client, `spectators[${i}].client`), name: validName(v.name, `spectators[${i}].name`) };
      if (has(v, 'account') && bool(v.account, `spectators[${i}].account`)) sp.account = true;
      mapStateOf(v, sp, `spectators[${i}]`);
      if (clients.has(sp.client)) fail('lobby.spectators lists a client twice');
      clients.add(sp.client);
      return sp;
    });
    const slots = m.slots.map((s, i) => validLobbySlot(s, `slots[${i}]`));
    if (slots.some((s) => s.type === 'human' && clients.has(s.client))) fail('a spectator cannot hold a slot');
    const map = validMapRef(m.map, 'map', true);
    // Map states describe the lobby's map: all members have one with a map, none without.
    const members = [...slots.filter((s) => s.type === 'human'), ...spectators];
    if (members.some((x) => (map !== null) !== (x.mapState !== undefined))) fail('lobby map states must match the map');
    const out = {
      t: S2C.LOBBY,
      slots,
      options: validateLobbyOptions(m.options),
      map,
      hostId: m.hostId === null ? null : validClientId(m.hostId, 'hostId'),
      spectators,
      maxSpectators,
    };
    // A lobby that resumes a saved online game: which one, and whose places still wait.
    if (has(m, 'resume')) out.resume = validResumeInfo(m.resume);
    return out;
  },
  [S2C.CHAT](m) {
    object(m, ['t', 'from', 'name', 'text', 'team'], 'chat');
    const out = {
      t: S2C.CHAT,
      from: m.from === null ? null : validClientId(m.from, 'from'),
      name: m.from === null ? text(m.name, 1, NAME_MAX, 'name') : validName(m.name),
      text: text(m.text, 1, CHAT_MAX, 'text'),
    };
    if (has(m, 'team') && bool(m.team, 'team')) out.team = true;
    return out;
  },
  [S2C.START](m) {
    object(m, ['t', 'seed', 'options', 'map', 'players', 'delay', 'resume'], 'start');
    const options = validateGameOptions(m.options);
    if (!Array.isArray(m.players) || m.players.length !== options.players.length) {
      fail('start.players must match options.players');
    }
    const players = m.players.map((p, i) => {
      const w = `players[${i}]`;
      object(p, START_PLAYER_KEYS, w);
      const out = {
        player: int(p.player, 0, MAX_PLAYERS - 1, `${w}.player`),
        slot: int(p.slot, 0, SLOT_MAX, `${w}.slot`),
        client: p.client === null ? null : validClientId(p.client, `${w}.client`),
        name: validName(p.name, `${w}.name`),
        type: oneOf(p.type, ['human', 'ai'], `${w}.type`),
      };
      if (out.player !== i) fail(`${w}.player must equal its index`);
      if (out.type !== options.players[i].type) fail(`${w}.type does not match the options`);
      if ((out.type === 'human') !== (out.client !== null)) fail(`${w}: only humans have a client`);
      return out;
    });
    const seed = int(m.seed, 0, SEED_MAX, 'seed');
    if (seed !== options.seed) fail('start.seed must match options.seed');
    const out = {
      t: S2C.START,
      seed,
      options,
      map: validMapRef(m.map, 'map', true),
      players,
      delay: int(m.delay, 1, 25, 'delay'),
    };
    // A resumed online save: the game continues after `ticks` ticks whose state hash is `hash`.
    if (has(m, 'resume')) {
      object(m.resume, ['ticks', 'hash'], 'start.resume');
      const ticks = int(m.resume.ticks, 1, TICK_MAX, 'start.resume.ticks');
      if ((ticks - 1) % HASH_INTERVAL !== 0) fail('start.resume.ticks must follow a hash tick');
      out.resume = { ticks, hash: matches(m.resume.hash, STATE_HASH_RE, 'start.resume.hash') };
    }
    return out;
  },
  [S2C.FRAME](m) {
    object(m, ['t', 'tick', 'orders'], 'frame');
    return { t: S2C.FRAME, tick: validTick(m.tick), orders: validFrameOrders(m.orders) };
  },
  [S2C.DESYNC](m) {
    object(m, ['t', 'tick'], 'desync');
    return { t: S2C.DESYNC, tick: validTick(m.tick) };
  },
  [S2C.LEFT](m) {
    object(m, ['t', 'player', 'client', 'name', 'reason'], 'left');
    return {
      t: S2C.LEFT,
      player: m.player === null ? null : int(m.player, 0, MAX_PLAYERS - 1, 'player'),
      client: validClientId(m.client, 'client'),
      name: validName(m.name),
      reason: oneOf(m.reason, LEFT_REASONS, 'reason'),
    };
  },
  [S2C.LOG](m) {
    object(m, ['t', 'frames'], 'log');
    if (!Array.isArray(m.frames) || m.frames.length < 1) fail('log.frames must list at least one frame');
    let last = -1;
    const frames = m.frames.map((f, i) => {
      if (!Array.isArray(f) || f.length !== 2) fail(`log.frames[${i}] must be [tick, orders]`);
      const tick = validTick(f[0], `log.frames[${i}] tick`);
      if (tick <= last) fail('log ticks must increase');
      last = tick;
      return [tick, validFrameOrders(f[1], `log.frames[${i}]`)];
    });
    return { t: S2C.LOG, frames };
  },
  [S2C.SYNC](m) {
    object(m, ['t', 'tick', 'check'], 'sync');
    const tick = validTick(m.tick);
    let check = null;
    if (m.check !== null) {
      object(m.check, ['tick', 'hash'], 'sync.check');
      check = { tick: validTick(m.check.tick, 'sync.check.tick'), hash: matches(m.check.hash, STATE_HASH_RE, 'sync.check.hash') };
      if (check.tick % HASH_INTERVAL !== 0 || check.tick >= tick) fail('sync.check must be a hash tick before sync.tick');
    }
    return { t: S2C.SYNC, tick, check };
  },
  [S2C.BACK](m) {
    object(m, ['t', 'player', 'client', 'name', 'tick'], 'back');
    return {
      t: S2C.BACK,
      player: int(m.player, 0, MAX_PLAYERS - 1, 'player'),
      client: validClientId(m.client, 'client'),
      name: validName(m.name),
      tick: validTick(m.tick),
    };
  },
  [S2C.REMATCH](m) {
    // open: `by` proposed, `accepted` agreed, `waiting` still has to answer;
    // cancelled: why (`reason`); lobby: the session is back in its lobby.
    object(m, ['t', 'state', 'by', 'accepted', 'waiting', 'reason', 'msLeft'], 'rematch');
    const state = oneOf(m.state, REMATCH_STATES, 'state');
    const clients = (v, w) => {
      if (!Array.isArray(v) || v.length > MAX_PLAYERS) fail(`${w} must list at most ${MAX_PLAYERS} clients`);
      const list = v.map((c) => validClientId(c, w));
      if (new Set(list).size !== list.length) fail(`${w} lists a client twice`);
      return list;
    };
    const out = {
      t: S2C.REMATCH,
      state,
      by: m.by === null ? null : validClientId(m.by, 'by'),
      accepted: clients(m.accepted, 'accepted'),
      waiting: clients(m.waiting, 'waiting'),
    };
    if (out.accepted.some((c) => out.waiting.includes(c))) fail('a client cannot both accept and wait');
    if (state === 'cancelled') out.reason = oneOf(m.reason, REMATCH_CANCEL_REASONS, 'reason');
    else if (has(m, 'reason')) fail('only a cancelled rematch has a reason');
    // Milliseconds left to answer an open proposal.
    if (state === 'open') out.msLeft = int(m.msLeft, 0, 24 * 60 * 60 * 1000, 'msLeft');
    else if (has(m, 'msLeft')) fail('only an open rematch has a deadline');
    return out;
  },
  [S2C.SAVE](m) {
    // open: `by` proposed, `accepted` agreed, `waiting` still has to answer;
    // agreed: the save point (`tick`, a hash tick every player reports);
    // saved: the server's record (`id`) of the game after `ticks` ticks with state `hash`;
    // cancelled: why (`reason`).
    object(m, ['t', 'state', 'by', 'accepted', 'waiting', 'msLeft', 'tick', 'id', 'ticks', 'hash', 'reason'], 'save');
    const state = oneOf(m.state, SAVE_STATES, 'state');
    const clients = (v, w) => {
      if (!Array.isArray(v) || v.length > MAX_PLAYERS) fail(`${w} must list at most ${MAX_PLAYERS} clients`);
      const list = v.map((c) => validClientId(c, w));
      if (new Set(list).size !== list.length) fail(`${w} lists a client twice`);
      return list;
    };
    const out = { t: S2C.SAVE, state };
    const allowed = { open: ['by', 'accepted', 'waiting', 'msLeft'], agreed: ['tick'], saved: ['id', 'ticks', 'hash'], cancelled: ['reason'] }[state];
    for (const k of ['by', 'accepted', 'waiting', 'msLeft', 'tick', 'id', 'ticks', 'hash', 'reason']) {
      if (has(m, k) !== allowed.includes(k)) fail(`a ${state} save ${allowed.includes(k) ? 'needs' : 'has no'} ${k}`);
    }
    if (state === 'open') {
      out.by = validClientId(m.by, 'by');
      out.accepted = clients(m.accepted, 'accepted');
      out.waiting = clients(m.waiting, 'waiting');
      if (out.accepted.some((c) => out.waiting.includes(c))) fail('a client cannot both accept and wait');
      out.msLeft = int(m.msLeft, 0, 24 * 60 * 60 * 1000, 'msLeft');
    } else if (state === 'agreed') {
      out.tick = validTick(m.tick);
      if (out.tick % HASH_INTERVAL !== 0) fail(`the save point is a multiple of ${HASH_INTERVAL}`);
    } else if (state === 'saved') {
      out.id = matches(m.id, SAVE_ID_RE, 'id');
      out.ticks = int(m.ticks, 1, TICK_MAX, 'ticks');
      if ((out.ticks - 1) % HASH_INTERVAL !== 0) fail('a save follows a hash tick');
      out.hash = matches(m.hash, STATE_HASH_RE, 'hash');
    } else {
      out.reason = oneOf(m.reason, SAVE_CANCEL_REASONS, 'reason');
    }
    return out;
  },
  [S2C.ERROR](m) {
    object(m, ['t', 'code', 'message'], 'error');
    return {
      t: S2C.ERROR,
      code: matches(m.code, ERROR_CODE_RE, 'code'),
      message: text(m.message, 1, ERROR_MESSAGE_MAX, 'message'),
    };
  },
};

// ---- Parse / encode ----------------------------------------------------------------------------

function parseWith(table, raw, maxBytes) {
  try {
    if (typeof raw !== 'string') fail('messages must be JSON text', 'bad_message');
    if (raw.length > maxBytes || utf8Length(raw) > maxBytes) fail('message too large', 'too_large');
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      fail('message is not valid JSON');
    }
    if (!isPlainObject(m) || typeof m.t !== 'string' || !Object.hasOwn(table, m.t)) {
      fail(`unknown message type ${excerpt(isPlainObject(m) ? m.t : typeof m)}`);
    }
    return { ok: true, msg: table[m.t](m) };
  } catch (err) {
    if (err instanceof ProtocolError) return { ok: false, code: err.code, message: err.message };
    throw err;
  }
}

/** Parse and validate a message a client sent. */
export function parseClientMessage(raw) {
  return parseWith(CLIENT, raw, MAX_MESSAGE_BYTES);
}

/** Parse and validate a message the server sent. */
export function parseServerMessage(raw) {
  return parseWith(SERVER, raw, MAX_SERVER_MESSAGE_BYTES);
}

function encodeWith(table, msg, maxBytes) {
  if (!isPlainObject(msg) || !Object.hasOwn(table, msg.t)) throw new ProtocolError('unknown message type');
  const clean = table[msg.t](msg);
  const s = JSON.stringify(clean);
  if (utf8Length(s) > maxBytes) throw new ProtocolError('message too large', 'too_large');
  return s;
}

/** Validate and serialize a client message. Throws ProtocolError. */
export function encodeClient(msg) {
  return encodeWith(CLIENT, msg, MAX_MESSAGE_BYTES);
}

/** Validate and serialize a server message. Throws ProtocolError. */
export function encodeServer(msg) {
  return encodeWith(SERVER, msg, MAX_SERVER_MESSAGE_BYTES);
}

/** Server error message with the text truncated (never echoes much input). */
export function errorMessage(code, message) {
  const clean = String(message ?? 'error')
    .replace(/[^\x20-\x7e]/g, '?')
    .trim();
  return encodeServer({ t: S2C.ERROR, code, message: truncate(clean || 'error', ERROR_MESSAGE_MAX) });
}

// ---- Builders (client side) ------------------------------------------------------------------

export const client = {
  hello: (f) => ({ t: C2S.HELLO, ...f }),
  slot: (slot, fields = {}) => ({ t: C2S.SLOT, slot, ...fields }),
  options: (options) => ({ t: C2S.OPTIONS, options }),
  map: (map) => ({ t: C2S.MAP, map }),
  ready: (ready, mapHash) => ({ t: C2S.READY, ready, mapHash }),
  chat: (textValue, team = false) => (team ? { t: C2S.CHAT, text: textValue, team: true } : { t: C2S.CHAT, text: textValue }),
  start: () => ({ t: C2S.START }),
  orders: (tick, orders) => ({ t: C2S.ORDERS, tick, orders }),
  hash: (tick, hash) => ({ t: C2S.HASH, tick, hash }),
  leave: () => ({ t: C2S.LEAVE }),
  spectators: (max) => ({ t: C2S.SPECTATORS, max }),
  spectate: (on) => ({ t: C2S.SPECTATE, on }),
  resume: () => ({ t: C2S.RESUME }),
  synced: () => ({ t: C2S.SYNCED }),
  defeated: () => ({ t: C2S.DEFEATED }),
  mapstate: (hash, state) => ({ t: C2S.MAPSTATE, hash, state }),
  kick: (clientId) => ({ t: C2S.KICK, client: clientId }),
  rematch: (accept) => ({ t: C2S.REMATCH, accept }),
  save: (accept) => ({ t: C2S.SAVE, accept }),
};


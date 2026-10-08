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
  ERROR_CODE_RE,
  ERROR_MESSAGE_MAX,
  HASH_INTERVAL,
  HOST_KEY_RE,
  HOST_SLOT_TYPES,
  MAP_ID_RE,
  MAX_MESSAGE_BYTES,
  MAX_ORDERS_PER_TICK,
  MAX_PLAYERS,
  MAX_SERVER_MESSAGE_BYTES,
  MIN_PLAYERS,
  NAME_MAX,
  NAME_MIN,
  ORDER_MAX_COUNT,
  ORDER_MAX_IDS,
  PASSWORD_MAX,
  S2C,
  SEED_MAX,
  SESSION_ID_RE,
  SESSION_NAME_MAX,
  SHA256_RE,
  SLOT_MAX,
  SLOT_TYPES,
  STATE_HASH_RE,
  TEAM_MAX,
  TICK_MAX,
  VERSION_RE,
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
  // engine/src/debug.rs: debug menu cheats, only valid in games with the
  // `cheats` option (the server refuses them otherwise, see CHEAT_ORDER_KINDS).
  dev_flag: { flag: (v, w) => oneOf(v, DEV_FLAGS, w), on: bool },
  dev_cash: {},
  dev_kill: { ids: idList },
};

/** Cheat orders: allowed only when the game's options have `cheats: true`. */
export const CHEAT_ORDER_KINDS = ['dev_flag', 'dev_cash', 'dev_kill'];

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

/** Map reference in a lobby: null for a generated map, else an uploaded map. */
export function validMapRef(v, what = 'map', withPlayers = false) {
  if (v === null) return null;
  object(v, withPlayers ? ['id', 'hash', 'name', 'modded', 'players'] : ['id', 'hash', 'name', 'modded'], what);
  const out = {
    id: matches(v.id, MAP_ID_RE, `${what}.id`),
    hash: matches(v.hash, SHA256_RE, `${what}.hash`),
    name: text(v.name, 1, 64, `${what}.name`),
    modded: bool(v.modded, `${what}.modded`),
  };
  if (withPlayers) out.players = int(v.players, MIN_PLAYERS, MAX_PLAYERS, `${what}.players`);
  return out;
}

// ---- Client to server -------------------------------------------------------------------

const CLIENT = {
  [C2S.HELLO](m) {
    object(m, ['t', 'protocol', 'version', 'name', 'password', 'hostKey'], 'hello');
    const out = {
      t: C2S.HELLO,
      protocol: int(m.protocol, 0, 0xffff, 'protocol'),
      version: matches(m.version, VERSION_RE, 'version'),
      name: validName(m.name),
    };
    if (has(m, 'password')) out.password = validPassword(m.password);
    if (has(m, 'hostKey')) out.hostKey = matches(m.hostKey, HOST_KEY_RE, 'hostKey');
    return out;
  },
  [C2S.SLOT](m) {
    object(m, ['t', 'slot', 'faction', 'color', 'team', 'type', 'difficulty'], 'slot');
    const out = { t: C2S.SLOT, slot: int(m.slot, 0, SLOT_MAX, 'slot') };
    if (has(m, 'faction')) out.faction = validFaction(m.faction, 'faction');
    if (has(m, 'color')) out.color = int(m.color, 0, COLOR_COUNT - 1, 'color');
    if (has(m, 'team')) out.team = int(m.team, 0, TEAM_MAX, 'team');
    if (has(m, 'type')) out.type = oneOf(m.type, HOST_SLOT_TYPES, 'type');
    if (has(m, 'difficulty')) out.difficulty = oneOf(m.difficulty, DIFFICULTIES, 'difficulty');
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
    object(m, ['t', 'text'], 'chat');
    return { t: C2S.CHAT, text: text(m.text, 1, CHAT_MAX, 'text') };
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

const LOBBY_SLOT_KEYS = ['type', 'client', 'name', 'faction', 'color', 'team', 'difficulty', 'ready'];

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
    if (has(v, 'difficulty')) fail(`${what}: humans have no difficulty`);
  } else {
    if (has(v, 'client') || has(v, 'name') || has(v, 'ready')) fail(`${what}: AI slots carry no client, name or ready`);
    out.difficulty = oneOf(v.difficulty, DIFFICULTIES, `${what}.difficulty`);
  }
  out.faction = validFaction(v.faction, `${what}.faction`);
  out.color = int(v.color, 0, COLOR_COUNT - 1, `${what}.color`);
  out.team = int(v.team, 0, TEAM_MAX, `${what}.team`);
  return out;
}

const START_PLAYER_KEYS = ['player', 'slot', 'client', 'name', 'type'];

const SERVER = {
  [S2C.WELCOME](m) {
    object(m, ['t', 'you', 'hostId', 'session'], 'welcome');
    return {
      t: S2C.WELCOME,
      you: validClientId(m.you, 'you'),
      hostId: m.hostId === null ? null : validClientId(m.hostId, 'hostId'),
      session: validSessionInfo(m.session),
    };
  },
  [S2C.LOBBY](m) {
    object(m, ['t', 'slots', 'options', 'map', 'hostId'], 'lobby');
    if (!Array.isArray(m.slots) || m.slots.length < MIN_PLAYERS || m.slots.length > MAX_PLAYERS) {
      fail('lobby.slots must list 2 to 8 slots');
    }
    return {
      t: S2C.LOBBY,
      slots: m.slots.map((s, i) => validLobbySlot(s, `slots[${i}]`)),
      options: validateLobbyOptions(m.options),
      map: validMapRef(m.map, 'map', true),
      hostId: m.hostId === null ? null : validClientId(m.hostId, 'hostId'),
    };
  },
  [S2C.CHAT](m) {
    object(m, ['t', 'from', 'name', 'text'], 'chat');
    return {
      t: S2C.CHAT,
      from: m.from === null ? null : validClientId(m.from, 'from'),
      name: m.from === null ? text(m.name, 1, NAME_MAX, 'name') : validName(m.name),
      text: text(m.text, 1, CHAT_MAX, 'text'),
    };
  },
  [S2C.START](m) {
    object(m, ['t', 'seed', 'options', 'map', 'players', 'delay'], 'start');
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
    return {
      t: S2C.START,
      seed,
      options,
      map: validMapRef(m.map, 'map', true),
      players,
      delay: int(m.delay, 1, 25, 'delay'),
    };
  },
  [S2C.FRAME](m) {
    object(m, ['t', 'tick', 'orders'], 'frame');
    if (!Array.isArray(m.orders) || m.orders.length > MAX_PLAYERS) fail('frame.orders must be a list');
    const seen = new Set();
    const orders = m.orders.map((entry, i) => {
      if (!Array.isArray(entry) || entry.length !== 2) fail(`frame.orders[${i}] must be [player, orders]`);
      const player = int(entry[0], 0, MAX_PLAYERS - 1, `frame.orders[${i}] player`);
      if (seen.has(player)) fail('frame lists a player twice');
      seen.add(player);
      return [player, validOrders(entry[1], `frame.orders[${i}]`)];
    });
    return { t: S2C.FRAME, tick: validTick(m.tick), orders };
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
      reason: oneOf(m.reason, ['left', 'dropped', 'kicked', 'disconnected'], 'reason'),
    };
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
  chat: (textValue) => ({ t: C2S.CHAT, text: textValue }),
  start: () => ({ t: C2S.START }),
  orders: (tick, orders) => ({ t: C2S.ORDERS, tick, orders }),
  hash: (tick, hash) => ({ t: C2S.HASH, tick, hash }),
  leave: () => ({ t: C2S.LEAVE }),
};


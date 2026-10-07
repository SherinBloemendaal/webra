// Protocol constants shared by the game client and the server
// (docs/contracts.md, section 4). Value sets mirror apps/game/js/lobby-state.js.

/** Bumped whenever a message shape changes incompatibly. */
export const PROTOCOL_VERSION = 1;

// ---- Limits -------------------------------------------------------------------

/** Largest WebSocket message a client may send, in UTF-8 bytes. */
export const MAX_MESSAGE_BYTES = 8 * 1024;
/** Largest message the server sends (a frame carries up to 8 players' orders). */
export const MAX_SERVER_MESSAGE_BYTES = 96 * 1024;
export const CHAT_MAX = 200;
export const NAME_MIN = 1;
export const NAME_MAX = 24;
export const SESSION_NAME_MAX = 40;
export const PASSWORD_MAX = 64;
export const VERSION_MAX = 64;
export const ERROR_MESSAGE_MAX = 200;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;
/** Lobby slot indices are 0..MAX_PLAYERS-1. */
export const SLOT_MAX = MAX_PLAYERS - 1;
export const COLOR_COUNT = 8;
/** Team 0 means no team; 1..TEAM_MAX are alliances. */
export const TEAM_MAX = 4;
export const SEED_MAX = 0x7fffffff;
export const TICK_MAX = 0x7fffffff;
export const MAX_ORDERS_PER_TICK = 32;
/** Engine caps (Order::is_reasonable in engine/src/world.rs). */
export const ORDER_MAX_IDS = 2000;
export const ORDER_MAX_COUNT = 50;

// ---- Lockstep -------------------------------------------------------------------

/** Orders issued while running tick T are scheduled for tick T + ORDER_DELAY. */
export const ORDER_DELAY = 3;
/** Clients report a state hash after every tick that is a multiple of this. */
export const HASH_INTERVAL = 25;
/** The server drops an in-game player that sent no orders for this long. */
export const DROP_AFTER_MS = 10_000;
export const TICKS_PER_SECOND = 25;

// ---- Rate limit (per connection) ---------------------------------------------------

export const RATE_PER_SECOND = 60;
export const RATE_BURST = 120;

// ---- Value sets (from apps/game/js/lobby-state.js) ----------------------------------

export const MAP_SIZES = [64, 96, 128, 160];
export const STARTING_CASH = [2500, 5000, 7500, 10000, 20000];
export const STARTING_UNITS = ['mcv', 'light', 'heavy', 'base'];
export const TECH_LEVELS = ['infonly', 'low', 'medium', 'high', 'unrestricted'];
export const GAME_SPEEDS = ['slowest', 'slower', 'normal', 'fast', 'faster', 'fastest'];
export const DIFFICULTIES = ['easy', 'normal', 'hard'];
export const RANDOM_FACTIONS = {
  random: ['england', 'france', 'germany', 'russia', 'ukraine'],
  randomallies: ['england', 'france', 'germany'],
  randomsoviet: ['russia', 'ukraine'],
};
export const PLAYABLE_FACTIONS = ['england', 'france', 'germany', 'russia', 'ukraine'];
export const FACTIONS = [...Object.keys(RANDOM_FACTIONS), ...PLAYABLE_FACTIONS];
export const BOOLEAN_OPTIONS = ['fog', 'explored', 'buildRadius', 'redeployableMcv', 'oreRegrowth'];

/** Milliseconds per simulation tick for each game speed (OpenRA timing). */
export const SPEED_MS = { slowest: 80, slower: 50, normal: 40, fast: 35, faster: 30, fastest: 20 };

export const DEFAULT_OPTIONS = Object.freeze({
  seed: 1,
  mapSize: 96,
  startingCash: 5000,
  startingUnits: 'mcv',
  techLevel: 'unrestricted',
  gameSpeed: 'normal',
  fog: true,
  explored: false,
  buildRadius: true,
  redeployableMcv: true,
  oreRegrowth: true,
});

/** Slot types in an online lobby. */
export const SLOT_TYPES = ['human', 'ai', 'open', 'closed'];
/** Slot types the host may assign to a slot that is not its own. */
export const HOST_SLOT_TYPES = ['ai', 'open', 'closed'];

// ---- Identifiers ---------------------------------------------------------------------

export const SESSION_ID_RE = /^[0-9a-f]{64}$/;
export const MAP_ID_RE = /^[0-9a-f]{16}$/;
export const SHA256_RE = /^[0-9a-f]{64}$/;
export const STATE_HASH_RE = /^[0-9a-f]{1,64}$/;
/** 32 random bytes, base64url without padding. */
export const HOST_KEY_RE = /^[A-Za-z0-9_-]{43}$/;
export const VERSION_RE = /^[0-9A-Za-z.+-]{1,64}$/;
export const ERROR_CODE_RE = /^[a-z_]{1,32}$/;

// ---- Message types ----------------------------------------------------------------------

/** Client to server. */
export const C2S = Object.freeze({
  HELLO: 'hello',
  SLOT: 'slot',
  OPTIONS: 'options',
  MAP: 'map',
  READY: 'ready',
  CHAT: 'chat',
  START: 'start',
  ORDERS: 'orders',
  HASH: 'hash',
  LEAVE: 'leave',
});

/** Server to client. */
export const S2C = Object.freeze({
  WELCOME: 'welcome',
  LOBBY: 'lobby',
  CHAT: 'chat',
  START: 'start',
  FRAME: 'frame',
  DESYNC: 'desync',
  LEFT: 'left',
  ERROR: 'error',
});

/** Error codes the server sends in `error` messages and HTTP error bodies. */
export const ERRORS = Object.freeze({
  BAD_MESSAGE: 'bad_message',
  TOO_LARGE: 'too_large',
  RATE_LIMITED: 'rate_limited',
  PROTOCOL: 'protocol_mismatch',
  VERSION: 'version_mismatch',
  PASSWORD: 'bad_password',
  FULL: 'full',
  NOT_HOST: 'not_host',
  NOT_FOUND: 'not_found',
  STATE: 'bad_state',
  NOT_READY: 'not_ready',
  INVALID: 'invalid',
  KICKED: 'kicked',
  DROPPED: 'dropped',
  SESSION_LOST: 'session_lost',
  FORBIDDEN: 'forbidden',
  INTERNAL: 'internal',
});

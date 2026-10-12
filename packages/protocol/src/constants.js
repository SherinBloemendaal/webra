// Protocol constants shared by the game client and the server
// (docs/contracts.md, section 4). Value sets mirror apps/game/js/lobby-state.js.

/** Bumped whenever a message shape changes incompatibly. */
export const PROTOCOL_VERSION = 6;

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
/**
 * A spawn a player picks in the lobby is 0..SPAWN_MAX (maps have at most
 * MAX_PLAYERS spawns, map.js MAP_MAX_SPAWNS); whether the map has it is the
 * lobby's and the engine's check (spawns.js spawnPickProblem).
 */
export const SPAWN_MAX = MAX_PLAYERS - 1;
export const COLOR_COUNT = 8;
/** Team 0 means no team; 1..TEAM_MAX are alliances. */
export const TEAM_MAX = 4;
export const SEED_MAX = 0x7fffffff;
export const TICK_MAX = 0x7fffffff;
export const MAX_ORDERS_PER_TICK = 32;
/** Engine caps (Order::is_reasonable in engine/src/world.rs). */
export const ORDER_MAX_IDS = 2000;
export const ORDER_MAX_COUNT = 50;
/** Highest actor type id an order may name. The engine has far fewer; the
 * server additionally checks against the real count (apps/server/src/validate.js). */
export const ACTOR_TYPE_MAX = 1023;
/** Fire stances (engine rules.rs `Stance`, OpenRA UnitStance), least aggressive first. */
export const STANCES = ['hold_fire', 'return_fire', 'defend', 'attack_anything'];

// ---- Lockstep -------------------------------------------------------------------

/** Orders issued while running tick T are scheduled for tick T + ORDER_DELAY. */
export const ORDER_DELAY = 3;
/** Clients report a state hash after every tick that is a multiple of this. */
export const HASH_INTERVAL = 25;
/** The server drops an in-game player that sent no orders for this long. */
export const DROP_AFTER_MS = 10_000;
export const TICKS_PER_SECOND = 25;

// ---- Reconnect and spectators ---------------------------------------------------

/** Spectator places per session: the host picks 0..MAX_SPECTATORS. */
export const MAX_SPECTATORS = 8;
export const DEFAULT_MAX_SPECTATORS = 2;
/**
 * Rejoin key issued to every member at join (`welcome.key`): 32 random bytes,
 * base64url. The server stores only its SHA-256.
 */
export const SEAT_KEY_RE = /^[A-Za-z0-9_-]{43}$/;
/** A player whose connection dropped can rejoin the running game this long. */
export const RECONNECT_GRACE_MS = 120_000;
/** A rejoining player must catch up and send `resume` within this time. */
export const RESUME_TIMEOUT_MS = 60_000;
/** Rejoins per member and game. */
export const MAX_REJOINS = 10;
/**
 * The server keeps the game's order log (non-empty frames, JSON) up to this
 * size for rejoining players and spectators. A longer log disables both.
 */
export const LOG_MAX_BYTES = 16 * 1024 * 1024;
/**
 * Rematch (`rematch` messages): the host proposes playing again with the same
 * settings; every connected player must accept within REMATCH_VOTE_MS. The
 * session then goes back to its lobby, and the members who were in the game
 * come back into it with their rejoin keys within REMATCH_RETURN_MS (the
 * client reloads the page to leave the finished game).
 */
export const REMATCH_VOTE_MS = 120_000;
export const REMATCH_RETURN_MS = 60_000;
/** A host can propose again this long after a proposal ended without a rematch. */
export const REMATCH_COOLDOWN_MS = 10_000;
/** States of a rematch proposal (`rematch.state`). */
export const REMATCH_STATES = ['open', 'cancelled', 'lobby'];
/** Why a proposal was cancelled (`rematch.reason`). */
export const REMATCH_CANCEL_REASONS = ['declined', 'expired', 'left', 'withdrawn'];

/**
 * Online saves (`save` messages): any player proposes saving the running
 * game; every player still in it must accept within SAVE_VOTE_MS. The save
 * point is the next hash tick (a multiple of HASH_INTERVAL) the server has
 * not sent yet; once every player reported the same state hash there, the
 * server records the save and each player's client stores the file.
 */
export const SAVE_VOTE_MS = 60_000;
/** Players must report their state hash at the save point within this long after agreeing. */
export const SAVE_HASH_MS = 60_000;
export const SAVE_COOLDOWN_MS = 10_000;
export const SAVE_STATES = ['open', 'agreed', 'saved', 'cancelled'];
export const SAVE_CANCEL_REASONS = ['declined', 'withdrawn', 'left', 'expired', 'desync', 'accounts', 'too_long', 'failed'];
/** Saved online games the server remembers per account (the oldest go first), and for how long. */
export const ONLINE_SAVES_PER_ACCOUNT = 20;
export const ONLINE_SAVE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const SAVE_ID_RE = /^[0-9a-f]{16}$/;

// ---- Lobby maps -----------------------------------------------------------------------

/**
 * Whether a member has the lobby's map (`mapState` of lobby slots and
 * spectators, `mapstate` messages): installed (the exact hash is in its
 * library), missing (not yet) or declined (it said no to installing it).
 */
export const MAP_STATES = ['installed', 'missing', 'declined'];
/**
 * Header with a member's credential for the session's map endpoints
 * (GET and POST /api/sessions/<id>/map): `<client>.<rejoin key>`.
 */
export const MEMBER_HEADER = 'X-WebRA-Member';
export const MEMBER_RE = /^([1-9][0-9]{0,9})\.([A-Za-z0-9_-]{43})$/;

/** Why a member left (`left.reason`). */
export const LEFT_REASONS = ['left', 'dropped', 'kicked', 'disconnected', 'removed', 'expired'];
/** Reasons after which a player can still rejoin a running game. */
export const REJOINABLE_REASONS = ['dropped', 'disconnected'];
export const ROLES = ['player', 'spectator'];

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
/** OpenRA's Red Alert bot types an AI slot plays (engine/src/ai_bots.rs); left out means 'normal'. */
export const BOTS = ['rush', 'normal', 'turtle', 'naval'];
export const RANDOM_FACTIONS = {
  random: ['england', 'france', 'germany', 'russia', 'ukraine'],
  randomallies: ['england', 'france', 'germany'],
  randomsoviet: ['russia', 'ukraine'],
};
export const PLAYABLE_FACTIONS = ['england', 'france', 'germany', 'russia', 'ukraine'];
export const FACTIONS = [...Object.keys(RANDOM_FACTIONS), ...PLAYABLE_FACTIONS];
/**
 * `cheats` is the "Debug menu" option (OpenRA's `cheats` lobby option): only
 * then may players send cheat orders (CHEAT_ORDER_KINDS), and the server
 * refuses them otherwise.
 */
export const BOOLEAN_OPTIONS = [
  'fog',
  'explored',
  'buildRadius',
  'redeployableMcv',
  'oreRegrowth',
  'cheats',
  // OpenRA's other lobby checkboxes (world.yaml, player.yaml; engine/src/gamerules.rs, crates.rs):
  // crates, short game, kill bounties, separate team spawns, ally build radius.
  'crates',
  'shortGame',
  'bounty',
  'separateTeamSpawns',
  'allyBuildRadius',
  // OpenRA's "Reusable Engineers" (player.yaml LobbyPrerequisiteCheckbox@REUSABLEENGINEERS).
  'reusableEngineers',
];

/**
 * How units move among each other (engine/src/movement): `openra`, OpenRA's
 * cell occupancy (units hold their cells, wait for and nudge each other,
 * never push), or `webra`, WebRA's soft crowd separation. Games, saves and
 * replays without the option are played with `webra`, the model they were
 * made with.
 */
export const MOVEMENT_MODELS = ['openra', 'webra'];

/** The model of games, saves and replays without the `movement` option. */
export const LEGACY_MOVEMENT = 'webra';

/** Time limits in minutes, 0 for none (OpenRA TimeLimitManager TimeLimitOptions). */
export const TIME_LIMITS = [0, 10, 20, 30, 40, 60, 90];
/** Handicaps in percent: less firepower and armour, slower production (OpenRA: 0 to 95 in steps of 5). */
export const HANDICAPS = Array.from({ length: 20 }, (_, i) => i * 5);

/** Cheat flags of the `dev_flag` order (engine/src/debug.rs DevFlag). */
export const DEV_FLAGS = ['fast_build', 'build_anywhere', 'unlimited_power', 'fast_charge', 'disable_shroud', 'all_tech'];

/** Milliseconds per simulation tick for each game speed (OpenRA timing). */
export const SPEED_MS = { slowest: 80, slower: 50, normal: 40, fast: 35, faster: 30, fastest: 20 };

/** Generated map layouts (engine/src/mapgen): `random` picks one from the seed. */
export const MAP_STYLES = ['random', 'land', 'rivers', 'lakes', 'islands'];
/** Biomes of a generated map (engine/src/weather.rs): `random` picks one from the seed. */
export const BIOMES = ['random', 'temperate', 'snow', 'desert'];
/** What weather does: visuals and modest gameplay effects, visuals only, or nothing. */
export const WEATHER_MODES = ['full', 'cosmetic', 'off'];
/**
 * Tech buildings of a generated map (engine/src/mapgen/settlements.rs,
 * OpenRA's map generator option "Buildings"): none, standard (a derrick per
 * base and a hospital in the middle), extra (plus command posts and
 * communications centers between neighbours), oil derricks only, oil rush.
 */
export const TECH_BUILDINGS = ['none', 'standard', 'extra', 'oilonly', 'oilrush'];

export const DEFAULT_OPTIONS = Object.freeze({
  seed: 1,
  mapSize: 96,
  mapStyle: 'random',
  biome: 'random',
  weather: 'full',
  techBuildings: 'standard',
  startingCash: 5000,
  startingUnits: 'mcv',
  techLevel: 'unrestricted',
  gameSpeed: 'normal',
  fog: true,
  explored: false,
  buildRadius: true,
  redeployableMcv: true,
  oreRegrowth: true,
  // OpenRA's "Reusable Engineers" (player.yaml LobbyPrerequisiteCheckbox@REUSABLEENGINEERS, off).
  reusableEngineers: false,
  cheats: false,
  // OpenRA's defaults.
  crates: true,
  shortGame: true,
  bounty: false,
  separateTeamSpawns: true,
  allyBuildRadius: true,
  timeLimit: 0,
  movement: 'openra',
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
  /** Host: play a co-op mission (protocol mission.js) instead of a skirmish, or back (null). */
  MISSION: 'mission',
  READY: 'ready',
  CHAT: 'chat',
  START: 'start',
  ORDERS: 'orders',
  HASH: 'hash',
  LEAVE: 'leave',
  /** Host: number of spectator places (lobby). */
  SPECTATORS: 'spectators',
  /** Move between a player slot and the spectators (lobby). */
  SPECTATE: 'spectate',
  /** A rejoining player caught up with the game and wants its seat back. */
  RESUME: 'resume',
  /** A spectator processed the whole catch-up (log and sync). */
  SYNCED: 'synced',
  DEFEATED: 'defeated',
  /** Whether this member installed or declined the lobby's map (lobby). */
  MAPSTATE: 'mapstate',
  /** Host: remove a spectator from the lobby (players are removed through `slot`). */
  KICK: 'kick',
  /** Propose (host) or accept a rematch (`accept: true`), or decline / withdraw it (`accept: false`). */
  REMATCH: 'rematch',
  /** Propose or accept saving the running game (`accept: true`), or decline / withdraw it. */
  SAVE: 'save',
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
  /** Order log for a rejoining player or a spectator joining a running game. */
  LOG: 'log',
  /** End of the order log: every frame before `tick` was sent. */
  SYNC: 'sync',
  /** A player rejoined; its orders count again from `tick` on. */
  BACK: 'back',
  /** A rematch proposal: open (with who accepted), cancelled, or the session is back in its lobby. */
  REMATCH: 'rematch',
  /** Saving the game: proposed, agreed (the save point), saved (the record's id), or cancelled. */
  SAVE: 'save',
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
  /** Online play needs a signed-in account (site setting). */
  ACCOUNT_REQUIRED: 'account_required',
  /** The account is pending (email or approval) or deleted. */
  ACCOUNT_INACTIVE: 'account_inactive',
  BANNED: 'banned',
  IP_BANNED: 'ip_banned',
});

// WebRA multiplayer protocol (see docs/contracts.md, sections 2 to 4).
// Pure ES modules without dependencies: runs in browsers, Workers and Node 22.

export * from './constants.js';
export { ProtocolError, truncate, utf8Length } from './check.js';
export { LOBBY_OPTION_KEYS, validateGameOptions, validateLobbyOptions } from './options.js';
export {
  client,
  encodeClient,
  encodeServer,
  errorMessage,
  parseClientMessage,
  parseServerMessage,
  CHEAT_ORDER_KINDS,
  isCheatOrder,
  validFrameOrders,
  validLobbySlot,
  validMapRef,
  validName,
  ORDER_KINDS,
  validOrder,
  validOrders,
  validPassword,
  validSessionName,
} from './messages.js';
export {
  base64Length,
  canonicalMapJson,
  decodeBase64,
  isModded,
  GEM_MAX,
  MAP_FORMAT,
  MAP_FORMAT_ORE_ONLY,
  MAP_MAX_ACTORS,
  MAP_MAX_BYTES,
  MAP_MAX_SIZE,
  MAP_MAX_SPAWNS,
  MAP_MIN_SIZE,
  MAP_MIN_SPAWNS,
  mapHash,
  mapSummary,
  MODDED_WARNING,
  ORE_MAX,
  parseMap,
  sha256Hex,
  TERRAIN_MAX,
  validateMap,
  validateRules,
} from './map.js';
export {
  encodeReplay,
  parseReplay,
  REPLAY_FORMAT,
  REPLAY_HASH_INTERVAL,
  REPLAY_KINDS,
  REPLAY_MAX_BYTES,
  REPLAY_MAX_TICKS,
  REPLAY_MODES,
  REPLAY_TITLE_MAX,
  REPLAY_VERSION,
  replayOptions,
  SAVE_SLOTS_MAX,
  validateReplay,
} from './replay.js';

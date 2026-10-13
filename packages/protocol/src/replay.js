// Replay and save files (docs/contracts.md, section 7).
//
// Both are the deterministic record of a game: the start settings, the map
// (canonical text, so the engine sees exactly the same bytes), the engine
// version, and every non-empty order frame. Playing one back re-runs the
// simulation; a save is a replay that also carries the state hash at its last
// tick, which the loader checks after fast-forwarding.
//
// Replay files are user files: `parseReplay` checks the size before parsing,
// then every field strictly (unknown keys, orders, options, map, hashes), and
// returns a fresh object holding only validated values.

import { CHAT_MAX, HASH_INTERVAL, MAX_PLAYERS, SAVE_ID_RE, SHA256_RE, STATE_HASH_RE, TICKS_PER_SECOND, VERSION_RE } from './constants.js';
import { fail, int, isPlainObject, object, oneOf, ProtocolError, text, utf8Length } from './check.js';
import { validFrameOrders, validName } from './messages.js';
import { parseMap, sha256Hex } from './map.js';
import { validateGameOptions } from './options.js';
import { coopMission, validateMissionOptions, validCoopMission, validMissionRef } from './mission.js';

export const REPLAY_FORMAT = 'webra-replay';
export const REPLAY_VERSION = 1;
/** Largest replay or save file accepted, in UTF-8 bytes. */
export const REPLAY_MAX_BYTES = 32 * 1024 * 1024;
/** Longest game a replay may hold: eight hours at normal speed. */
export const REPLAY_MAX_TICKS = TICKS_PER_SECOND * 60 * 60 * 8;
/** Recorders store the state hash every this many ticks (playback checks them). */
export const REPLAY_HASH_INTERVAL = 250;
export const REPLAY_KINDS = ['replay', 'save'];
export const REPLAY_MODES = ['skirmish', 'online', 'mission'];
export const REPLAY_TITLE_MAX = 64;
/** Chat lines a replay keeps at most (OpenRA replays hold the Chat orders). */
export const REPLAY_CHAT_MAX = 5000;
/** Saves in the browser (IndexedDB) and their names. */
export const SAVE_SLOTS_MAX = 50;

const KEYS = ['format', 'version', 'kind', 'mode', 'engine', 'createdAt', 'title', 'options', 'map', 'mapHash', 'player', 'ticks', 'frames', 'hashes', 'online', 'mission', 'chat'];

/**
 * Validate everything except the map hash (which needs async SHA-256).
 * Returns a fresh replay object or throws ProtocolError.
 */
export function validateReplay(v, { maxFrameBytes = Infinity } = {}) {
  object(v, KEYS, 'replay');
  if (v.format !== REPLAY_FORMAT) fail('not a WebRA replay or save file');
  if (v.version !== REPLAY_VERSION) fail(`unsupported replay format version ${int(v.version, 0, 0xffff, 'version')}`);
  const mode = oneOf(v.mode, REPLAY_MODES, 'mode');
  // A campaign mission (mission.js): the mission file by id and hash, its
  // start options, one player (the person playing is player 0), no map file.
  const mission = mode === 'mission';
  const out = {
    format: REPLAY_FORMAT,
    version: REPLAY_VERSION,
    kind: oneOf(v.kind, REPLAY_KINDS, 'kind'),
    mode,
    engine: (() => {
      if (typeof v.engine !== 'string' || !VERSION_RE.test(v.engine)) fail('engine version is malformed');
      return v.engine;
    })(),
    createdAt: int(v.createdAt, 0, Number.MAX_SAFE_INTEGER, 'createdAt'),
    title: text(v.title, 1, REPLAY_TITLE_MAX, 'title'),
    options: mission ? validateMissionOptions(v.options, 'options') : validateGameOptions(v.options, 'options'),
    map: null,
    mapHash: null,
    player: null,
    ticks: int(v.ticks, 0, REPLAY_MAX_TICKS, 'ticks'),
    frames: [],
    hashes: [],
  };
  // Mission frames only carry the orders of player 0.
  const players = mission ? 1 : out.options.players.length;
  if (v.player !== null) out.player = int(v.player, 0, players - 1, 'player');
  if (out.kind === 'save' && (out.player === null || (!mission && out.options.players[out.player].type !== 'human'))) {
    fail('a save must name the human player it belongs to');
  }
  if (mission) {
    if (out.player !== 0) fail('a mission is played by player 0');
    if (v.map !== null) fail('a mission has no map file');
    out.mission = validMissionRef(v.mission, 'mission');
  } else if (v.mission !== undefined && out.mode === 'online') {
    // A co-op mission played online: its mission file and options; every player a person.
    out.mission = validCoopMission(v.mission, 'mission');
    if (v.map !== null) fail('a mission has no map file');
    if (players !== coopMission(out.mission.id).players.length || out.options.players.some((p) => p.type !== 'human')) {
      fail('every playable player of a co-op mission is a person');
    }
  } else if (v.mission !== undefined) {
    fail('only missions carry a mission record');
  }
  // An online save names the server's record of it (docs/contracts.md section 4, "Online saves");
  // it can only be resumed online, after a hash tick, by the players who saved it.
  if (out.kind === 'save' && out.mode === 'online') {
    object(v.online, ['id'], 'online');
    out.online = { id: (() => (typeof v.online.id === 'string' && SAVE_ID_RE.test(v.online.id) ? v.online.id : fail('online.id is malformed')))() };
    if (out.ticks < 1 || (out.ticks - 1) % HASH_INTERVAL !== 0) fail('an online save follows a hash tick');
  } else if (v.online !== undefined) {
    fail('only online saves carry an online record');
  }

  if (v.map !== null) {
    if (typeof v.map !== 'string') fail('map must be canonical map JSON text or null');
    // The map as played: never upgraded (files are pinned to the engine that made them anyway).
    const r = parseMap(v.map, { upgrade: false });
    if (!r.ok) fail(`map: ${r.errors.slice(0, 3).join('; ')}`);
    if (r.canonical !== v.map) fail('map is not in canonical form');
    if (players > r.players) fail(`the map has room for ${r.players} players`);
    out.map = r.canonical;
    if (typeof v.mapHash !== 'string' || !SHA256_RE.test(v.mapHash)) fail('mapHash is malformed');
    out.mapHash = v.mapHash;
  } else if (v.mapHash !== null) {
    fail('mapHash must be null without a map');
  }

  if (!Array.isArray(v.frames) || v.frames.length > out.ticks) fail('frames must be a list with at most one frame per tick');
  let last = -1;
  // Orders budget (an online save must fit the server's order log): counted while validating.
  let frameBytes = 0;
  out.frames = v.frames.map((f, i) => {
    if (!Array.isArray(f) || f.length !== 2) fail(`frames[${i}] must be [tick, orders]`);
    const tick = int(f[0], 0, out.ticks - 1, `frames[${i}] tick`);
    if (tick <= last) fail('frame ticks must increase');
    last = tick;
    const orders = validFrameOrders(f[1], `frames[${i}]`);
    if (orders.length === 0) fail(`frames[${i}] is empty (empty frames are left out)`);
    for (const [p] of orders) if (p >= players) fail(`frames[${i}] names player ${p} of ${players}`);
    frameBytes += logEntryBytes(tick, orders);
    if (frameBytes > maxFrameBytes) fail('the orders are too long', 'too_large');
    return [tick, orders];
  });

  if (!Array.isArray(v.hashes) || v.hashes.length > Math.floor(out.ticks / REPLAY_HASH_INTERVAL) + 1) fail('hashes must be a short list');
  last = 0;
  out.hashes = v.hashes.map((h, i) => {
    if (!Array.isArray(h) || h.length !== 2) fail(`hashes[${i}] must be [ticks, hash]`);
    const n = int(h[0], 1, out.ticks, `hashes[${i}] ticks`);
    if (n <= last) fail('hash ticks must increase');
    last = n;
    if (typeof h[1] !== 'string' || !STATE_HASH_RE.test(h[1])) fail(`hashes[${i}] hash is malformed`);
    return [n, h[1]];
  });
  if (out.kind === 'save' && (out.hashes.length === 0 || out.hashes.at(-1)[0] !== out.ticks)) {
    fail('a save must end with the state hash of its last tick');
  }
  // The chat of an online game's replay, as the recording client received it:
  // [tick, player (-1: a spectator), name, text, team (1: team chat)]. Saves never carry chat.
  if (v.chat !== undefined) {
    if (out.kind !== 'replay' || out.mode !== 'online') fail('only replays of online games carry chat');
    if (!Array.isArray(v.chat) || v.chat.length > REPLAY_CHAT_MAX) fail(`chat must be a list of at most ${REPLAY_CHAT_MAX} lines`);
    last = -1;
    out.chat = v.chat.map((c, i) => {
      if (!Array.isArray(c) || c.length !== 5) fail(`chat[${i}] must be [tick, player, name, text, team]`);
      const tick = int(c[0], 0, out.ticks, `chat[${i}] tick`);
      if (tick < last) fail('chat ticks must not decrease');
      last = tick;
      return [tick, int(c[1], -1, players - 1, `chat[${i}] player`), validName(c[2], `chat[${i}] name`), text(c[3], 1, CHAT_MAX, `chat[${i}] text`), int(c[4], 0, 1, `chat[${i}] team`)];
    });
  }
  return out;
}

/**
 * The header of a replay or save (format, kind, mode, engine version,
 * creation time, title), validated on its own: enough to tell the player
 * which version made the file. Throws ProtocolError.
 */
export function replayHeader(v) {
  if (!isPlainObject(v)) fail('not a WebRA replay or save file');
  if (v.format !== REPLAY_FORMAT) fail('not a WebRA replay or save file');
  if (v.version !== REPLAY_VERSION) fail(`unsupported replay format version ${int(v.version, 0, 0xffff, 'version')}`);
  if (typeof v.engine !== 'string' || !VERSION_RE.test(v.engine)) fail('engine version is malformed');
  return {
    format: REPLAY_FORMAT,
    version: REPLAY_VERSION,
    kind: oneOf(v.kind, REPLAY_KINDS, 'kind'),
    mode: oneOf(v.mode, REPLAY_MODES, 'mode'),
    engine: v.engine,
    createdAt: int(v.createdAt, 0, Number.MAX_SAFE_INTEGER, 'createdAt'),
    title: text(v.title, 1, REPLAY_TITLE_MAX, 'title'),
  };
}

/**
 * Parse a replay or save file's text. Resolves `{ ok: true, replay }` or
 * `{ ok: false, error }` (a readable message); never throws for bad input.
 *
 * With `version` (the running engine build), a file made by another build is
 * not validated beyond its header: its settings follow that build's rules
 * (older files lack options added since), and it cannot be played here
 * anyway. It resolves `{ ok: true, replay: header, foreign: true }`, so the
 * caller can say which version made it. Files of this build are validated
 * strictly.
 */
export async function parseReplay(raw, { version = null, maxBytes = REPLAY_MAX_BYTES, maxFrameBytes = Infinity } = {}) {
  try {
    if (typeof raw !== 'string') fail('a replay file is JSON text');
    const limit = Math.min(maxBytes, REPLAY_MAX_BYTES);
    if (raw.length > limit || utf8Length(raw) > limit) fail(`the file is larger than ${Math.floor(limit / 1024 / 1024)} MiB`);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      fail('the file is not valid JSON');
    }
    if (!isPlainObject(parsed)) fail('not a WebRA replay or save file');
    if (version !== null) {
      const header = replayHeader(parsed);
      if (header.engine !== version) return { ok: true, replay: header, foreign: true };
    }
    const replay = validateReplay(parsed, { maxFrameBytes });
    if (replay.map !== null && (await sha256Hex(replay.map)) !== replay.mapHash) fail('the map does not match its hash');
    return { ok: true, replay };
  } catch (err) {
    if (err instanceof ProtocolError) return { ok: false, error: err.message, code: err.code };
    throw err;
  }
}

/**
 * Bytes one frame takes in the server's order log (apps/server/src/orderlog.js)
 * and in an online save's orders budget: one definition for both, so a game
 * the server recorded as saved always fits when it is resumed.
 */
export function logEntryBytes(tick, orders) {
  return JSON.stringify([tick, orders]).length + 1;
}

/**
 * Digest of a game's order frames, frame by frame so it can be computed
 * over a stream (the server reads its order log chunk by chunk): starting
 * from the SHA-256 of the empty string, each frame in its validated form is chained as
 * `h = SHA-256(h + JSON([tick, orders]))`. The server computes it from its
 * order log, the Worker from an uploaded save; equal digests mean the same
 * orders in the same order.
 */
export class FramesDigest {
  constructor() {
    this.hash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    this.last = -1;
  }

  /** Add the next frame `[tick, orders]` (ticks increase). */
  async add([tick, orders]) {
    const t = int(tick, 0, REPLAY_MAX_TICKS, 'frame tick');
    if (t <= this.last) fail('frame ticks must increase');
    this.last = t;
    this.hash = await sha256Hex(`${this.hash}${JSON.stringify([t, validFrameOrders(orders, `frame ${t}`)])}`);
  }

  value() {
    return this.hash;
  }
}

/** The FramesDigest of a list of frames. */
export async function framesDigest(frames) {
  const d = new FramesDigest();
  for (const f of frames) await d.add(f);
  return d.value();
}

/** SHA-256 of a game's validated options (players, factions, seed and the rest). */
export async function optionsDigest(options) {
  return sha256Hex(JSON.stringify(validateGameOptions(options, 'options')));
}

/** Serialize a replay after validating it (throws ProtocolError). */
export function encodeReplay(replay) {
  const clean = validateReplay(replay);
  const s = JSON.stringify(clean);
  if (utf8Length(s) > REPLAY_MAX_BYTES) throw new ProtocolError('the replay is too large', 'too_large');
  return s;
}

/**
 * The engine options of a skirmish or online game in replay form: closed and
 * open slots left out, slots renumbered (the engine numbers players the same
 * way), random factions already resolved. Throws ProtocolError when invalid.
 */
export function replayOptions(options) {
  if (!isPlainObject(options) || !Array.isArray(options.players)) fail('options must have players');
  const { map: _map, ...rest } = options;
  const players = options.players
    .filter((p) => p && p.type !== 'closed' && p.type !== 'open')
    .slice(0, MAX_PLAYERS)
    .map((p, slot) => ({ ...p, slot }));
  return validateGameOptions({ ...rest, players });
}

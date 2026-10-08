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

import { MAX_PLAYERS, SHA256_RE, STATE_HASH_RE, TICKS_PER_SECOND, VERSION_RE } from './constants.js';
import { fail, int, isPlainObject, object, oneOf, ProtocolError, text, utf8Length } from './check.js';
import { validFrameOrders } from './messages.js';
import { parseMap, sha256Hex } from './map.js';
import { validateGameOptions } from './options.js';

export const REPLAY_FORMAT = 'webra-replay';
export const REPLAY_VERSION = 1;
/** Largest replay or save file accepted, in UTF-8 bytes. */
export const REPLAY_MAX_BYTES = 32 * 1024 * 1024;
/** Longest game a replay may hold: eight hours at normal speed. */
export const REPLAY_MAX_TICKS = TICKS_PER_SECOND * 60 * 60 * 8;
/** Recorders store the state hash every this many ticks (playback checks them). */
export const REPLAY_HASH_INTERVAL = 250;
export const REPLAY_KINDS = ['replay', 'save'];
export const REPLAY_MODES = ['skirmish', 'online'];
export const REPLAY_TITLE_MAX = 64;
/** Saves in the browser (IndexedDB) and their names. */
export const SAVE_SLOTS_MAX = 50;

const KEYS = ['format', 'version', 'kind', 'mode', 'engine', 'createdAt', 'title', 'options', 'map', 'mapHash', 'player', 'ticks', 'frames', 'hashes'];

/**
 * Validate everything except the map hash (which needs async SHA-256).
 * Returns a fresh replay object or throws ProtocolError.
 */
export function validateReplay(v) {
  object(v, KEYS, 'replay');
  if (v.format !== REPLAY_FORMAT) fail('not a WebRA replay or save file');
  if (v.version !== REPLAY_VERSION) fail(`unsupported replay format version ${int(v.version, 0, 0xffff, 'version')}`);
  const out = {
    format: REPLAY_FORMAT,
    version: REPLAY_VERSION,
    kind: oneOf(v.kind, REPLAY_KINDS, 'kind'),
    mode: oneOf(v.mode, REPLAY_MODES, 'mode'),
    engine: (() => {
      if (typeof v.engine !== 'string' || !VERSION_RE.test(v.engine)) fail('engine version is malformed');
      return v.engine;
    })(),
    createdAt: int(v.createdAt, 0, Number.MAX_SAFE_INTEGER, 'createdAt'),
    title: text(v.title, 1, REPLAY_TITLE_MAX, 'title'),
    options: validateGameOptions(v.options, 'options'),
    map: null,
    mapHash: null,
    player: null,
    ticks: int(v.ticks, 0, REPLAY_MAX_TICKS, 'ticks'),
    frames: [],
    hashes: [],
  };
  const players = out.options.players.length;
  if (v.player !== null) out.player = int(v.player, 0, players - 1, 'player');
  if (out.kind === 'save' && (out.player === null || out.options.players[out.player].type !== 'human')) {
    fail('a save must name the human player it belongs to');
  }
  if (out.kind === 'save' && out.mode !== 'skirmish') fail('only skirmish games can be saved');

  if (v.map !== null) {
    if (typeof v.map !== 'string') fail('map must be canonical map JSON text or null');
    const r = parseMap(v.map);
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
  out.frames = v.frames.map((f, i) => {
    if (!Array.isArray(f) || f.length !== 2) fail(`frames[${i}] must be [tick, orders]`);
    const tick = int(f[0], 0, out.ticks - 1, `frames[${i}] tick`);
    if (tick <= last) fail('frame ticks must increase');
    last = tick;
    const orders = validFrameOrders(f[1], `frames[${i}]`);
    if (orders.length === 0) fail(`frames[${i}] is empty (empty frames are left out)`);
    for (const [p] of orders) if (p >= players) fail(`frames[${i}] names player ${p} of ${players}`);
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
export async function parseReplay(raw, { version = null } = {}) {
  try {
    if (typeof raw !== 'string') fail('a replay file is JSON text');
    if (raw.length > REPLAY_MAX_BYTES || utf8Length(raw) > REPLAY_MAX_BYTES) {
      fail(`the file is larger than ${REPLAY_MAX_BYTES / 1024 / 1024} MiB`);
    }
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
    const replay = validateReplay(parsed);
    if (replay.map !== null && (await sha256Hex(replay.map)) !== replay.mapHash) fail('the map does not match its hash');
    return { ok: true, replay };
  } catch (err) {
    if (err instanceof ProtocolError) return { ok: false, error: err.message };
    throw err;
  }
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

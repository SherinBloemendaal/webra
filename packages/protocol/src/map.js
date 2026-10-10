// Map files (`.webra-map.json`, formats 1 and 2; docs/contracts.md, section 2).
// Format 2 is format 1 plus a `gems` layer; format 1 maps have none. Apart
// from that layer format, every file carries the map format version
// (`formatVersion`) and the release that wrote it (`gameVersion`); older
// versions are upgraded first (mapversions.js).
//
// The canonical form matches the engine (engine/src/mapdata.rs): fields in the
// order of the contract, defaults filled in (description "", actors [],
// facing 0, rules null, and from format version 2 the game setup:
// mapsetup.js), `gems` only in format 2, keys inside `rules` and `options`
// sorted, actor state only when not its default, no whitespace,
// `formatVersion` only when it is not 1 and never `gameVersion`. Its
// SHA-256 (lowercase hex) is the map's identity.
//
// validateMap upgrades, then checks structure, sizes, layer encoding and value
// ranges. The engine's Game.validate_map additionally checks gameplay rules
// (spawn ground, connectivity, known actor types); clients run both before
// installing a map.

import { base64Length, decodeBase64, encodeBase64 } from './base64.js';
import { excerpt, fail, int, isPlainObject, object, ProtocolError, rawText, utf8Length } from './check.js';
import { GAME_VERSION } from './version.js';
import { MAP_UPGRADED_NOTICE, MAP_VERSIONS, incompatibleMapMessage, mapFormatVersionOf, reservedKeyIn, upgradeMap } from './mapversions.js';
import { canonicalActorState, canonicalSlot, validateActorState, validateLockedOptions, validateMapOptions, validateMapPlayers, validateTags } from './mapsetup.js';

export { base64Length, decodeBase64, encodeBase64 } from './base64.js';

/** The current format (with gems). */
export const MAP_FORMAT = 2;
/** The format without gems: still accepted, and what maps without gems are written as. */
export const MAP_FORMAT_ORE_ONLY = 1;
export const MAP_MAX_BYTES = 1024 * 1024;
export const MAP_MIN_SIZE = 32;
export const MAP_MAX_SIZE = 256;
export const MAP_MIN_SPAWNS = 2;
export const MAP_MAX_SPAWNS = 8;
export const MAP_MAX_ACTORS = 2000;
// 0 clear, 1 rough, 2 rock, 3 water, 4 tree, 5 ford, 6 road, 7 bridge, 8 beach, 9 river, 10 wall (engine map.rs Terrain)
export const TERRAIN_MAX = 10;
/** Terrain that can hold ore or gems: clear, rough and road (engine map.rs Terrain::holds_ore). */
const holdsResource = (t) => t === 0 || t === 1 || t === 6;
/** Map biomes (engine/src/weather.rs); absent means temperate. */
export const MAP_BIOMES = ['temperate', 'snow', 'desert'];
export const ORE_MAX = 12;
export const GEM_MAX = 3;
export const MODDED_WARNING =
  'This map changes game rules (costs, damage, speed...). It can be unfair or act as a cheat.';

const MAP_KEYS = [
  'formatVersion',
  'gameVersion',
  'format',
  'name',
  'author',
  'description',
  'width',
  'height',
  'terrain',
  'ore',
  'gems',
  'spawns',
  'actors',
  'rules',
  'biome',
  // Format version 2: the map's game setup (mapsetup.js).
  'players',
  'options',
  'lockedOptions',
  'tags',
];
const ACTOR_KEYS = ['type', 'owner', 'x', 'y', 'facing', 'health', 'stance', 'veterancy', 'cargo'];
const RULE_SECTIONS = { actors: 'id', weapons: 'name' };
// Never a key JavaScript treats specially (`__proto__`, `constructor`, `prototype`): no built-in rule uses one.
const RULE_KEY_RE = /^(?!(?:__proto__|constructor|prototype)$)[A-Za-z0-9_.-]{1,40}$/;
const RULE_MAX_DEPTH = 6;
/** Fields that identify an entry and can never change (see checkPatch). */
const RULE_FIXED_FIELDS = ['kind', 'queue'];
/** Marks "validated without the engine rules", as opposed to "no built-in value here". */
const NO_BASE = Symbol('no base');
/**
 * Validate a rules override object. Shape rules always apply; with `base`
 * (the parsed engine/rules.json) ids, fields and value types are checked
 * exactly like the engine's apply_overrides.
 */
export function validateRules(rules, base) {
  if (!isPlainObject(rules)) fail('rules must be an object or null');
  for (const section of Object.keys(rules)) {
    if (!Object.hasOwn(RULE_SECTIONS, section)) fail(`rules: unknown section ${excerpt(section)}`);
    const patches = rules[section];
    if (!isPlainObject(patches)) fail(`rules.${section} must be an object`);
    const keyField = RULE_SECTIONS[section];
    for (const id of Object.keys(patches)) {
      if (!RULE_KEY_RE.test(id)) fail(`rules.${section}: invalid id ${excerpt(id)}`);
      let target;
      if (base) {
        const list = Array.isArray(base[section]) ? base[section] : [];
        const lower = id.toLowerCase();
        target = list.find((e) => typeof e?.[keyField] === 'string' && e[keyField].toLowerCase() === lower);
        if (!target) fail(`rules.${section}: unknown id ${excerpt(id)}`);
      }
      checkPatch(patches[id], target, `${section}.${id}`, keyField, RULE_MAX_DEPTH);
    }
  }
}

function kindOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function checkPatch(patch, target, path, keyField, depth) {
  if (!isPlainObject(patch)) fail(`rules ${excerpt(path, 60)}: expected an object`);
  if (target !== undefined && !isPlainObject(target)) fail(`rules ${excerpt(path, 60)}: expected an object`);
  if (depth <= 0) fail(`rules ${excerpt(path, 60)}: nested too deeply`);
  for (const k of Object.keys(patch)) {
    const p = `${path}.${k}`;
    if (!RULE_KEY_RE.test(k)) fail(`rules ${excerpt(path, 60)}: invalid field name`);
    if (k === keyField || RULE_FIXED_FIELDS.includes(k)) fail(`rules ${excerpt(p, 60)}: cannot be changed`);
    const v = patch[k];
    checkRuleValue(v, p, depth - 1, target === undefined ? NO_BASE : target[k]);
    if (target !== undefined) {
      if (!Object.hasOwn(target, k)) fail(`rules ${excerpt(path, 60)}: unknown field ${excerpt(k)}`);
      const cur = target[k];
      // Same JSON type as the built-in value (null built-ins cannot be overridden).
      if (kindOf(cur) !== kindOf(v) || kindOf(v) === 'null') fail(`rules ${excerpt(p, 60)}: wrong type`);
    }
    if (isPlainObject(v)) checkPatch(v, target?.[k], p, '', depth - 1);
  }
}

/**
 * Shape checks for any override value. `base` is the built-in value at the
 * same position, or NO_BASE when no engine rules were given. Arrays are
 * replaced whole, so objects inside them get the same guard as patches: an
 * identity field (`kind`, `queue`) may only repeat the built-in value at the
 * same position (a warhead or support power can be tuned, never change kind).
 * Without the engine rules that comparison is left to the engine, which
 * applies the same rule.
 */
function checkRuleValue(v, path, depth, base) {
  const at = (key) => {
    if (base === NO_BASE) return NO_BASE;
    if (typeof key === 'number') return Array.isArray(base) ? base[key] : undefined;
    return isPlainObject(base) && Object.hasOwn(base, key) ? base[key] : undefined;
  };
  switch (kindOf(v)) {
    case 'number':
      if (!Number.isSafeInteger(v)) fail(`rules ${excerpt(path, 60)}: numbers must be integers`);
      return;
    case 'boolean':
      return;
    case 'string':
      rawText(v, 0, 200, `rules ${excerpt(path, 60)}`);
      return;
    case 'array':
      if (depth <= 0 || v.length > 256) fail(`rules ${excerpt(path, 60)}: array too large or deep`);
      v.forEach((x, i) => checkRuleValue(x, path, depth - 1, at(i)));
      return;
    case 'object':
      if (depth <= 0) fail(`rules ${excerpt(path, 60)}: nested too deeply`);
      for (const k of Object.keys(v)) {
        if (!RULE_KEY_RE.test(k)) fail(`rules ${excerpt(path, 60)}: invalid field name`);
        const b = at(k);
        if (RULE_FIXED_FIELDS.includes(k) && b !== NO_BASE && b !== v[k]) fail(`rules ${excerpt(`${path}.${k}`, 60)}: cannot be changed`);
        checkRuleValue(v[k], `${path}.${k}`, depth - 1, b);
      }
      return;
    default:
      fail(`rules ${excerpt(path, 60)}: unsupported value`);
  }
}

/** A map counts as modded when it carries a non-empty rules object (engine semantics). */
export function isModded(map) {
  const r = map?.rules;
  if (r === null || r === undefined) return false;
  if (isPlainObject(r)) return Object.keys(r).length > 0;
  return true;
}

/**
 * Validate a parsed map file. It is upgraded to the current format first
 * (upgradeMap), so an older file validates as the map it becomes. Returns
 * `{ ok: true, map, canonical, modded, players, upgrade, writtenBy, errors: [] }`
 * with the normalized current-format map (defaults filled in, text kept
 * byte for byte) or `{ ok: false, errors, compat }`.
 *
 * `upgrade` is null, or `{ from, to, notes, message }` after an automatic
 * upgrade (show `message`, MAP_UPGRADED_NOTICE). `compat` is set when the
 * format version is the reason: `{ status: 'incompatible' | 'newer', from,
 * message, problems }`, and `errors[0]` is its message. A map that was
 * upgraded and then fails validation counts as incompatible too: it was
 * valid for the release that made it. `writtenBy` is the file's
 * `gameVersion` (not part of the identity).
 *
 * @param {unknown} input parsed JSON
 * @param {{ rules?: object, versions?: object, upgrade?: boolean }} [opts]
 *   `rules`: parsed engine/rules.json to check overrides against;
 *   `versions`: the version registry (tests); `upgrade: false` refuses
 *   anything but the current format (replays and saves keep the map as played)
 */
export function validateMap(input, opts = {}) {
  const versions = opts.versions ?? MAP_VERSIONS;
  const up = upgradeMap(input, versions);
  if (up.status === 'invalid') return { ok: false, errors: up.errors, compat: null };
  if (up.status === 'newer') return { ok: false, errors: [up.message], compat: compatOf(up, up.problems) };
  if (opts.upgrade === false && up.from !== versions.current) {
    return { ok: false, errors: [`the map is in format ${up.from}; this version plays format ${versions.current} only`], compat: null };
  }
  if (up.status === 'incompatible') {
    return { ok: false, errors: [up.message, ...up.problems.map((p) => p.message)], compat: compatOf(up, up.problems) };
  }
  const r = validateCurrentMap(up.map, opts, versions.current);
  if (!r.ok) {
    if (up.status !== 'upgraded') return { ...r, compat: null };
    // Valid for the release that made it, but not after the upgrade: the format changed under it.
    const message = incompatibleMapMessage(up.from, up.gameVersion, versions);
    const problems = r.errors.map((e) => ({ version: versions.current, code: 'invalid-after-upgrade', message: e, fixes: [] }));
    return { ok: false, errors: [message, ...r.errors], compat: compatOf({ ...up, status: 'incompatible', message }, problems) };
  }
  const upgrade = up.status === 'upgraded' ? { from: up.from, to: up.to, notes: up.notes, message: MAP_UPGRADED_NOTICE } : null;
  return { ...r, upgrade, writtenBy: up.gameVersion };
}

function compatOf(up, problems) {
  return { status: up.status, from: up.from, to: up.to, gameVersion: up.gameVersion, message: up.message, problems, map: up.map };
}

/** validateMap's checks of a map already in format `current`. */
function validateCurrentMap(input, opts, current) {
  const errors = [];
  const step = (fn) => {
    try {
      return fn();
    } catch (err) {
      if (!(err instanceof ProtocolError)) throw err;
      errors.push(err.message);
      return undefined;
    }
  };
  if (!isPlainObject(input)) return { ok: false, errors: ['map must be a JSON object'] };
  const okKeys = step(() => object(input, MAP_KEYS, 'map'));
  if (!okKeys) return { ok: false, errors };

  const m = {};
  step(() => {
    if (mapFormatVersionOf(input) !== current) fail(`formatVersion must be ${current}`);
    m.formatVersion = current;
  });
  // `"gems": null` counts as no gems layer, as in the engine.
  const hasGems = input.gems !== undefined && input.gems !== null;
  step(() => {
    if (input.format !== MAP_FORMAT && input.format !== MAP_FORMAT_ORE_ONLY) fail(`unsupported map format ${excerpt(input.format)}`);
    if (input.format === MAP_FORMAT_ORE_ONLY && hasGems) fail('format 1 maps have no gems layer');
    if (input.format === MAP_FORMAT && !hasGems) fail('format 2 maps need a gems layer');
    m.format = input.format;
  });
  m.name = step(() => rawText(input.name, 1, 64, 'name'));
  m.author = step(() => rawText(input.author, 1, 64, 'author'));
  m.description = step(() => rawText(input.description ?? '', 0, 500, 'description', true));
  m.width = step(() => int(input.width, MAP_MIN_SIZE, MAP_MAX_SIZE, 'width'));
  m.height = step(() => int(input.height, MAP_MIN_SIZE, MAP_MAX_SIZE, 'height'));
  const sized = m.width !== undefined && m.height !== undefined;
  const cells = sized ? m.width * m.height : 0;

  m.terrain = step(() => {
    if (typeof input.terrain !== 'string') fail('terrain must be base64 text');
    if (sized && input.terrain.length !== base64Length(cells)) fail(`terrain must encode ${cells} bytes`);
    return input.terrain;
  });
  m.ore = step(() => {
    if (typeof input.ore !== 'string') fail('ore must be base64 text');
    if (sized && input.ore.length !== base64Length(cells)) fail(`ore must encode ${cells} bytes`);
    return input.ore;
  });
  m.gems = step(() => {
    if (!hasGems) return undefined;
    if (typeof input.gems !== 'string') fail('gems must be base64 text');
    if (sized && input.gems.length !== base64Length(cells)) fail(`the gems layer must have ${cells} bytes`);
    return input.gems;
  });
  if (sized && m.terrain !== undefined && m.ore !== undefined && (m.gems !== undefined || !hasGems)) {
    step(() => {
      const terrain = decodeBase64(m.terrain, 'terrain');
      const ore = decodeBase64(m.ore, 'ore');
      if (terrain.length !== cells || ore.length !== cells) fail(`terrain and ore layers must have ${cells} bytes`);
      const gems = hasGems ? decodeBase64(m.gems, 'gems') : new Uint8Array(cells);
      if (gems.length !== cells) fail(`the gems layer must have ${cells} bytes`);
      for (let i = 0; i < cells; i++) {
        if (terrain[i] > TERRAIN_MAX) fail(`invalid terrain value ${terrain[i]}`);
        if (ore[i] > ORE_MAX) fail(`invalid ore density ${ore[i]}`);
        if (gems[i] > GEM_MAX) fail(`invalid gem density ${gems[i]}`);
        // Resources lie on clear or rough ground only, one type per cell.
        if (ore[i] > 0 && !holdsResource(terrain[i])) fail('ore can only lie on clear or rough ground or roads');
        if (gems[i] > 0 && !holdsResource(terrain[i])) fail('gems can only lie on clear or rough ground or roads');
        if (ore[i] > 0 && gems[i] > 0) fail('a cell cannot hold both ore and gems');
      }
    });
  }

  m.spawns = step(() => {
    const s = input.spawns;
    if (!Array.isArray(s) || s.length < MAP_MIN_SPAWNS || s.length > MAP_MAX_SPAWNS) {
      fail(`a map needs ${MAP_MIN_SPAWNS} to ${MAP_MAX_SPAWNS} spawn points`);
    }
    const seen = new Set();
    return s.map((p, i) => {
      if (!Array.isArray(p) || p.length !== 2) fail(`spawn ${i + 1} must be [x, y]`);
      const x = int(p[0], 0, (m.width ?? MAP_MAX_SIZE) - 3, `spawn ${i + 1} x`);
      const y = int(p[1], 0, (m.height ?? MAP_MAX_SIZE) - 4, `spawn ${i + 1} y`);
      const key = `${x},${y}`;
      if (seen.has(key)) fail(`spawn ${i + 1} duplicates another spawn`);
      seen.add(key);
      return [x, y];
    });
  });

  m.actors = step(() => {
    const a = input.actors ?? [];
    if (!Array.isArray(a)) fail('actors must be a list');
    if (a.length > MAP_MAX_ACTORS) fail(`at most ${MAP_MAX_ACTORS} pre-placed actors`);
    const spawnCount = Array.isArray(m.spawns) ? m.spawns.length : MAP_MAX_SPAWNS;
    return a.map((x, i) => {
      const w = `actor ${i + 1}`;
      object(x, ACTOR_KEYS, w);
      // Actor ids: letters, digits and dots (T01.Husk, AFLD.Ukraine).
      if (typeof x.type !== 'string' || !/^[A-Za-z0-9.]{1,16}$/.test(x.type)) fail(`${w} has an invalid type`);
      return {
        type: x.type,
        owner: int(x.owner, -1, spawnCount - 1, `${w} owner`),
        x: int(x.x, 0, (m.width ?? MAP_MAX_SIZE) - 1, `${w} x`),
        y: int(x.y, 0, (m.height ?? MAP_MAX_SIZE) - 1, `${w} y`),
        facing: int(x.facing ?? 0, 0, 1023, `${w} facing`),
        ...validateActorState(x, w),
      };
    });
  });

  m.rules = step(() => {
    const r = input.rules ?? null;
    if (r === null) return null;
    validateRules(r, opts.rules);
    return r;
  });

  // Optional biome (not a rules override: a biome never makes a map modded).
  m.biome = step(() => {
    const b = input.biome ?? 'temperate';
    if (!MAP_BIOMES.includes(b)) fail(`biome must be one of ${MAP_BIOMES.join(', ')}`);
    return b;
  });

  // The game setup (format version 2, mapsetup.js); absent fields take their defaults.
  m.players = step(() => validateMapPlayers(input.players ?? [], Array.isArray(m.spawns) ? m.spawns.length : MAP_MAX_SPAWNS));
  m.options = step(() => validateMapOptions(input.options ?? {}));
  m.lockedOptions = step(() => validateLockedOptions(input.lockedOptions ?? [], m.options));
  m.tags = step(() => validateTags(input.tags ?? []));

  if (errors.length) return { ok: false, errors };
  const canonical = canonicalMapJson(m);
  if (utf8Length(canonical) > MAP_MAX_BYTES) return { ok: false, errors: ['map is larger than 1 MiB'] };
  return { ok: true, map: m, canonical, modded: isModded(m), players: m.spawns.length, errors: [] };
}

/**
 * Best effort for the map editor: a map it can open from a file that does
 * not validate, typically one that is no longer compatible (upgradeMap
 * `incompatible` or `newer`). Runs what upgrades it can, then repairs the
 * structure only: unknown fields dropped, layers decoded or rebuilt to the
 * map size, malformed spawns and actors left out, bad text replaced. Values
 * the editor can show (terrain codes, resources, actor types) stay for its
 * located checks. Returns `{ map, status, message, problems }` (problems:
 * the upgrade's, with their quick fixes, then one per repair) or null when
 * the input is not a map object at all.
 */
export function salvageMap(input, opts = {}) {
  const versions = opts.versions ?? MAP_VERSIONS;
  if (!isPlainObject(input)) return null;
  const up = upgradeMap(input, versions);
  const problems = [...up.problems];
  const repair = (message, extra = {}) => problems.push({ version: versions.current, code: 'repaired', message, fixes: [], ...extra });
  const src = up.map ?? JSON.parse(JSON.stringify(input));
  if (up.status === 'invalid') repair(`${up.errors.join('; ')}; the map is opened as format ${versions.current}.`);
  if (up.status === 'newer') repair(`${up.message} Fields this version does not know are left out.`);
  const m = { formatVersion: versions.current };
  for (const k of Object.keys(src)) {
    if (!MAP_KEYS.includes(k)) repair(`Unknown field "${excerpt(k)}" was left out.`);
  }
  const textOr = (v, min, max, fallback, what, multiline = false) => {
    try {
      return rawText(v, min, max, what, multiline);
    } catch (err) {
      if (v !== undefined) repair(`${err.message}; replaced with "${fallback}".`);
      return fallback;
    }
  };
  m.name = textOr(src.name, 1, 64, 'Untitled', 'name');
  m.author = textOr(src.author, 1, 64, 'Unknown', 'author');
  m.description = textOr(src.description ?? '', 0, 500, '', 'description', true);
  const size = (v, what) => {
    if (Number.isSafeInteger(v) && v >= MAP_MIN_SIZE && v <= MAP_MAX_SIZE) return v;
    const fixed = Number.isFinite(v) ? Math.min(MAP_MAX_SIZE, Math.max(MAP_MIN_SIZE, Math.round(v))) : 64;
    repair(`${what} ${excerpt(v)} is not ${MAP_MIN_SIZE} to ${MAP_MAX_SIZE}; the map is ${fixed} cells ${what === 'width' ? 'wide' : 'high'} now.`);
    return fixed;
  };
  m.width = size(src.width, 'width');
  m.height = size(src.height, 'height');
  const layer = (key, fill) => {
    const cells = m.width * m.height;
    let bytes = null;
    if (src[key] !== undefined && src[key] !== null) {
      try {
        bytes = decodeBase64(src[key], key);
      } catch {
        repair(`The ${key} layer could not be read; it was rebuilt empty.`);
      }
    }
    if (bytes && bytes.length === cells) return src[key];
    const out = new Uint8Array(cells).fill(fill);
    // Rows that match the old width keep their cells; the rest is empty.
    if (bytes) {
      const oldWidth = Number.isSafeInteger(src.width) && src.width > 0 ? src.width : m.width;
      for (let y = 0; y < m.height; y++) {
        for (let x = 0; x < m.width && x < oldWidth; x++) {
          const i = y * oldWidth + x;
          if (i < bytes.length) out[y * m.width + x] = bytes[i];
        }
      }
      repair(`The ${key} layer had ${bytes.length} cells for a ${m.width} x ${m.height} map; it was cut or filled to fit.`);
    } else if (src[key] === undefined && key !== 'gems') {
      repair(`The map had no ${key} layer; it was added empty.`);
    }
    return encodeBase64(out);
  };
  m.terrain = layer('terrain', 0);
  m.ore = layer('ore', 0);
  const hasGems = src.gems !== undefined && src.gems !== null;
  m.format = hasGems ? MAP_FORMAT : MAP_FORMAT_ORE_ONLY;
  if (hasGems) m.gems = layer('gems', 0);
  const inside = (x, y) => Number.isSafeInteger(x) && Number.isSafeInteger(y) && x >= 0 && y >= 0 && x < m.width && y < m.height;
  m.spawns = (Array.isArray(src.spawns) ? src.spawns : []).filter((p, i) => {
    const ok = Array.isArray(p) && p.length === 2 && inside(p[0], p[1]);
    if (!ok) repair(`Spawn ${i + 1} is not a cell of the map; it was left out.`);
    return ok;
  }).slice(0, MAP_MAX_SPAWNS);
  m.actors = [];
  (Array.isArray(src.actors) ? src.actors : []).forEach((a, i) => {
    if (!isPlainObject(a) || typeof a.type !== 'string' || !/^[A-Za-z0-9.]{1,16}$/.test(a.type) || !inside(a.x, a.y)) {
      repair(`Actor ${i + 1} is malformed or off the map; it was left out.`, isPlainObject(a) && inside(a.x, a.y) ? { x: a.x, y: a.y } : {});
      return;
    }
    const owner = Number.isSafeInteger(a.owner) && a.owner >= -1 && a.owner < Math.max(m.spawns.length, 1) ? a.owner : -1;
    if (owner !== a.owner) repair(`Actor ${i + 1} (${a.type}) had owner ${excerpt(a.owner)}; it is neutral now.`, { x: a.x, y: a.y });
    const facing = Number.isSafeInteger(a.facing) && a.facing >= 0 && a.facing <= 1023 ? a.facing : 0;
    let state = {};
    try {
      state = validateActorState(a, `actor ${i + 1}`);
    } catch (err) {
      repair(`${err.message}; its health, stance, veterancy and passengers were reset.`, { x: a.x, y: a.y });
    }
    m.actors.push({ type: a.type, owner, x: a.x, y: a.y, facing, ...state });
  });
  if (isPlainObject(src.rules) && reservedKeyIn(src.rules) !== null) {
    m.rules = null;
    repair(`rules use the reserved key ${reservedKeyIn(src.rules)}; the overrides were left out.`);
  } else if (src.rules === undefined || src.rules === null || isPlainObject(src.rules)) m.rules = src.rules ?? null;
  else {
    m.rules = null;
    repair('rules is not an object; the overrides were left out.');
  }
  if (src.biome !== undefined && src.biome !== 'temperate') {
    if (MAP_BIOMES.includes(src.biome)) m.biome = src.biome;
    else repair(`biome ${excerpt(src.biome)} is unknown; the map is temperate now.`);
  }
  // The game setup: kept when it checks out, else its default.
  const keep = (key, check, fallback, what) => {
    if (src[key] === undefined) return fallback;
    try {
      return check(src[key]);
    } catch (err) {
      repair(`${err.message}; ${what}`);
      return fallback;
    }
  };
  m.players = keep('players', (v) => validateMapPlayers(v, Math.max(m.spawns.length, 2)).slice(0, m.spawns.length), [], 'the slots were reset to open.');
  m.options = keep('options', validateMapOptions, {}, 'the map sets no options now.');
  m.lockedOptions = keep('lockedOptions', (v) => validateLockedOptions(v, m.options), [], 'no options are locked now.');
  m.tags = keep('tags', validateTags, [], 'the tags were left out.');
  return { map: m, status: up.status, message: up.message, problems };
}

/** Parse map text (size checked first), then validate (and upgrade, see validateMap). */
export function parseMap(textJson, opts) {
  if (typeof textJson !== 'string') return { ok: false, errors: ['map must be JSON text'] };
  if (utf8Length(textJson) > MAP_MAX_BYTES) return { ok: false, errors: ['map is larger than 1 MiB'] };
  let parsed;
  try {
    parsed = JSON.parse(textJson);
  } catch {
    return { ok: false, errors: ['map is not valid JSON'] };
  }
  return validateMap(parsed, opts);
}

function sortKeysDeep(v) {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (isPlainObject(v)) {
    const out = {};
    // Keys are ASCII (RULE_KEY_RE), so UTF-16 order equals the engine's byte order.
    for (const k of Object.keys(v).sort()) out[k] = sortKeysDeep(v[k]);
    return out;
  }
  return v;
}

/**
 * The canonical form of a map object (see validateMap for validated maps;
 * any map-shaped object works, the map editor uses it for drafts). `gems`
 * only when present; `biome` last and only when not temperate, so maps from
 * before biomes keep their identity; `formatVersion` first and only when it
 * is not 1, so every map from before map versions keeps its identity, and
 * never `gameVersion` (who wrote a file does not change the map).
 */
export function canonicalMapObject(m) {
  const formatVersion = m.formatVersion === undefined || m.formatVersion === 1 ? {} : { formatVersion: m.formatVersion };
  const gems = m.gems === undefined || m.gems === null ? {} : { gems: m.gems };
  const biome = m.biome === undefined || m.biome === 'temperate' ? {} : { biome: m.biome };
  return {
    ...formatVersion,
    format: m.format,
    name: m.name,
    author: m.author,
    description: m.description ?? '',
    width: m.width,
    height: m.height,
    terrain: m.terrain,
    ore: m.ore,
    ...gems,
    spawns: (m.spawns ?? []).map((s) => [s[0], s[1]]),
    actors: (m.actors ?? []).map((a) => ({ type: a.type, owner: a.owner, x: a.x, y: a.y, facing: a.facing ?? 0, ...canonicalActorState(a) })),
    rules: m.rules === undefined || m.rules === null ? null : sortKeysDeep(m.rules),
    ...biome,
    ...canonicalSetup(m),
  };
}

/**
 * The game setup of the canonical form: from format version 2 on, every
 * field with its defaults filled in (`options` keys sorted, the lists in
 * the order the map gives); nothing before version 2.
 */
function canonicalSetup(m) {
  if (m.formatVersion === undefined || m.formatVersion < 2) return {};
  return {
    players: (m.players ?? []).map(canonicalSlot),
    options: sortKeysDeep(isPlainObject(m.options) ? m.options : {}),
    lockedOptions: [...(m.lockedOptions ?? [])],
    tags: [...(m.tags ?? [])],
  };
}

/** Canonical JSON text of a map (canonicalMapObject, no whitespace): what the hash covers. */
export function canonicalMapJson(m) {
  return JSON.stringify(canonicalMapObject(m));
}

/**
 * The text of a map file as WebRA writes it (map editor, generator, importer,
 * tools/map-upgrade.mjs): the canonical form with `formatVersion` (always,
 * default the current version) and `gameVersion` (default this release) in
 * front. Same identity as the canonical form. The engine's
 * `MapData::file_json` writes the same bytes.
 */
export function mapFileJson(m, { formatVersion = m.formatVersion ?? MAP_VERSIONS.current, gameVersion = GAME_VERSION } = {}) {
  const { formatVersion: _omitted, ...body } = canonicalMapObject(m);
  return JSON.stringify({ formatVersion, gameVersion, ...body });
}

/** Lowercase hex SHA-256 of a string (WebCrypto: browsers, Workers, Node 22). */
export async function sha256Hex(textValue) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('WebCrypto is not available');
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(textValue));
  let hex = '';
  for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/** Identity of a validated map: sha256 of its canonical JSON. */
export async function mapHash(m) {
  return sha256Hex(canonicalMapJson(m));
}

/** Summary fields a lobby or the map list shows. */
export function mapSummary(m, id, hash) {
  return { id, name: m.name, hash, modded: isModded(m), players: m.spawns.length, width: m.width, height: m.height, tags: [...(m.tags ?? [])] };
}

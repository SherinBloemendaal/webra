// Map files (`.webra-map.json`, format 1; docs/contracts.md, section 2).
//
// The canonical form matches the engine (engine/src/mapdata.rs): fields in the
// order of the contract, defaults filled in (description "", actors [],
// facing 0, rules null), keys inside `rules` sorted, no whitespace. Its
// SHA-256 (lowercase hex) is the map's identity.
//
// validateMap checks structure, sizes, layer encoding and value ranges. The
// engine's Game.validate_map additionally checks gameplay rules (spawn ground,
// connectivity, known actor types); clients run both before installing a map.

import { excerpt, fail, int, isPlainObject, object, ProtocolError, rawText, utf8Length } from './check.js';

export const MAP_FORMAT = 1;
export const MAP_MAX_BYTES = 1024 * 1024;
export const MAP_MIN_SIZE = 32;
export const MAP_MAX_SIZE = 256;
export const MAP_MIN_SPAWNS = 2;
export const MAP_MAX_SPAWNS = 8;
export const MAP_MAX_ACTORS = 2000;
export const TERRAIN_MAX = 4; // 0 clear, 1 rough, 2 rock, 3 water, 4 tree
export const ORE_MAX = 12;
export const MODDED_WARNING =
  'This map changes game rules (costs, damage, speed...). It can be unfair or act as a cheat.';

const MAP_KEYS = ['format', 'name', 'author', 'description', 'width', 'height', 'terrain', 'ore', 'spawns', 'actors', 'rules'];
const ACTOR_KEYS = ['type', 'owner', 'x', 'y', 'facing'];
const RULE_SECTIONS = { actors: 'id', weapons: 'name' };
const RULE_KEY_RE = /^[A-Za-z0-9_.-]{1,40}$/;
const RULE_MAX_DEPTH = 6;
/** Fields that identify an entry and can never change (see checkPatch). */
const RULE_FIXED_FIELDS = ['kind', 'queue'];
/** Marks "validated without the engine rules", as opposed to "no built-in value here". */
const NO_BASE = Symbol('no base');
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const B64_CODES = (() => {
  const t = new Int16Array(128).fill(-1);
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < abc.length; i++) t[abc.charCodeAt(i)] = i;
  return t;
})();

/** Decode standard, padded base64 (as the engine requires). Throws on bad input. */
export function decodeBase64(s, what) {
  if (typeof s !== 'string' || s.length % 4 !== 0 || !B64_RE.test(s)) fail(`${what} is not valid base64`);
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((s.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const a = B64_CODES[s.charCodeAt(i)];
    const b = B64_CODES[s.charCodeAt(i + 1)];
    const c = s[i + 2] === '=' ? 0 : B64_CODES[s.charCodeAt(i + 2)];
    const d = s[i + 3] === '=' ? 0 : B64_CODES[s.charCodeAt(i + 3)];
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  // Non-canonical encodings (stray bits in the last group) are rejected.
  if (pad === 2 && (B64_CODES[s.charCodeAt(s.length - 3)] & 15) !== 0) fail(`${what} is not valid base64`);
  if (pad === 1 && (B64_CODES[s.charCodeAt(s.length - 2)] & 3) !== 0) fail(`${what} is not valid base64`);
  return out;
}

/** Expected base64 length for n bytes. */
export function base64Length(n) {
  return Math.ceil(n / 3) * 4;
}

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
 * Validate a parsed map object. Returns
 * `{ ok: true, map, modded, players }` with the normalized map (defaults
 * filled in, text normalized) or `{ ok: false, errors }`.
 *
 * @param {unknown} input parsed JSON
 * @param {{ rules?: object }} [opts] `rules`: parsed engine/rules.json to check overrides against
 */
export function validateMap(input, opts = {}) {
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
    if (input.format !== MAP_FORMAT) fail(`unsupported map format ${excerpt(input.format)}`);
    m.format = MAP_FORMAT;
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
  if (sized && m.terrain !== undefined && m.ore !== undefined) {
    step(() => {
      const terrain = decodeBase64(m.terrain, 'terrain');
      const ore = decodeBase64(m.ore, 'ore');
      if (terrain.length !== cells || ore.length !== cells) fail(`terrain and ore layers must have ${cells} bytes`);
      for (let i = 0; i < cells; i++) {
        if (terrain[i] > TERRAIN_MAX) fail(`invalid terrain value ${terrain[i]}`);
        if (ore[i] > ORE_MAX) fail(`invalid ore density ${ore[i]}`);
        // Ore lies on clear or rough ground only.
        if (ore[i] > 0 && terrain[i] > 1) fail('ore can only lie on clear or rough ground');
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
      if (typeof x.type !== 'string' || !/^[A-Za-z0-9]{1,16}$/.test(x.type)) fail(`${w} has an invalid type`);
      return {
        type: x.type,
        owner: int(x.owner, -1, spawnCount - 1, `${w} owner`),
        x: int(x.x, 0, (m.width ?? MAP_MAX_SIZE) - 1, `${w} x`),
        y: int(x.y, 0, (m.height ?? MAP_MAX_SIZE) - 1, `${w} y`),
        facing: int(x.facing ?? 0, 0, 1023, `${w} facing`),
      };
    });
  });

  m.rules = step(() => {
    const r = input.rules ?? null;
    if (r === null) return null;
    validateRules(r, opts.rules);
    return r;
  });

  if (errors.length) return { ok: false, errors };
  const canonical = canonicalMapJson(m);
  if (utf8Length(canonical) > MAP_MAX_BYTES) return { ok: false, errors: ['map is larger than 1 MiB'] };
  return { ok: true, map: m, canonical, modded: isModded(m), players: m.spawns.length, errors: [] };
}

/** Parse map text (size checked first), then validate. */
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

/** Canonical JSON text of an already validated map (see validateMap). */
export function canonicalMapJson(m) {
  return JSON.stringify({
    format: m.format,
    name: m.name,
    author: m.author,
    description: m.description ?? '',
    width: m.width,
    height: m.height,
    terrain: m.terrain,
    ore: m.ore,
    spawns: m.spawns.map(([x, y]) => [x, y]),
    actors: (m.actors ?? []).map((a) => ({ type: a.type, owner: a.owner, x: a.x, y: a.y, facing: a.facing ?? 0 })),
    rules: m.rules === undefined || m.rules === null ? null : sortKeysDeep(m.rules),
  });
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
  return { id, name: m.name, hash, modded: isModded(m), players: m.spawns.length, width: m.width, height: m.height };
}

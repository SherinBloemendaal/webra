// WebRA map format 1 (`.webra-map.json`, docs/contracts.md section 2).
// Pure module: base64 layers, canonical JSON, sha256 identity and validation.
// Runs in browsers and in Node (tests), no DOM access.

import { validateOverrides } from './overrides.js';

export const MAP_FORMAT = 1;
export const MAP_FILE_SUFFIX = '.webra-map.json';

export const TERRAIN = Object.freeze({ CLEAR: 0, ROUGH: 1, ROCK: 2, WATER: 3, TREE: 4 });
export const TERRAIN_NAMES = ['Clear', 'Rough', 'Rock', 'Water', 'Tree'];

export const LIMITS = Object.freeze({
  minSize: 32,
  maxSize: 256,
  minSpawns: 2,
  maxSpawns: 8,
  maxOre: 12,
  maxBytes: 1024 * 1024,
  nameMax: 64,
  authorMax: 64,
  descriptionMax: 500,
  maxFacing: 1023,
  maxActors: 2000,
});

/** Map preview colours, the same as `Game.map_preview` in engine/src/lib.rs. */
export const PREVIEW_COLORS = [
  [62, 88, 44],
  [96, 92, 58],
  [128, 118, 102],
  [36, 70, 102],
  [28, 54, 24],
];
export const PREVIEW_ORE = [200, 160, 50];

/** Cells ground units can cross (engine/src/map.rs Terrain::passable). */
export const isPassable = (t) => t === TERRAIN.CLEAR || t === TERRAIN.ROUGH;
/** Cells structures can stand on (engine/src/map.rs Terrain::buildable). */
export const isBuildable = (t) => t === TERRAIN.CLEAR;

// ---- Base64 -------------------------------------------------------------------

/** Standard base64 (RFC 4648, with padding) of a byte array. */
export function encodeBase64(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** Decode standard base64 into bytes. Throws on malformed input. */
export function decodeBase64(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) {
    throw new Error('not valid base64');
  }
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---- Canonical form and identity -----------------------------------------------------

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Recursively sort object keys (serde_json's default map order), for `rules`. */
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (!isObject(v)) return v;
  const out = {};
  for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
  return out;
}

/**
 * The map in canonical form: top-level keys in contract order, every key present
 * (`description` "", `actors` [], `rules` null when missing), actor keys in the
 * order type, owner, x, y, facing, and `rules` keys sorted recursively.
 */
export function canonicalMap(map) {
  return {
    format: map.format,
    name: map.name,
    author: map.author,
    description: map.description ?? '',
    width: map.width,
    height: map.height,
    terrain: map.terrain,
    ore: map.ore,
    spawns: (map.spawns ?? []).map((s) => [s[0], s[1]]),
    actors: (map.actors ?? []).map((a) => ({ type: a.type, owner: a.owner, x: a.x, y: a.y, facing: a.facing ?? 0 })),
    rules: map.rules === undefined || map.rules === null ? null : sortKeys(map.rules),
  };
}

/** Canonical JSON text: canonical form, no whitespace. */
export function canonicalJson(map) {
  return JSON.stringify(canonicalMap(map));
}

/** UTF-8 byte length of a string. */
export function byteLength(text) {
  return new TextEncoder().encode(text).length;
}

/** Lower-case hex sha256 of a UTF-8 string (WebCrypto). */
export async function sha256Hex(text) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Map identity: sha256 of the canonical JSON. */
export function mapHash(map) {
  return sha256Hex(canonicalJson(map));
}

/**
 * Any map with `rules` overrides is a modded map. Like the engine, `null` and an
 * empty object are not modded.
 */
export function isModded(map) {
  const r = map?.rules;
  if (r === undefined || r === null) return false;
  if (isObject(r)) return Object.keys(r).length > 0;
  return true;
}

// ---- Building maps ----------------------------------------------------------------

/** A blank map of one terrain type with two spawns in opposite corners. */
export function createMap({ width = 96, height = 96, base = TERRAIN.CLEAR, name = 'Untitled', author = 'Commander' } = {}) {
  const terrain = new Uint8Array(width * height).fill(base);
  const ore = new Uint8Array(width * height);
  return {
    format: MAP_FORMAT,
    name,
    author,
    description: '',
    width,
    height,
    terrain: encodeBase64(terrain),
    ore: encodeBase64(ore),
    spawns: [
      [Math.min(8, width - 4), Math.min(8, height - 5)],
      [Math.max(0, width - 11), Math.max(0, height - 12)],
    ],
    actors: [],
    rules: null,
  };
}

/** Decode the terrain and ore layers. Throws with a readable message on bad data. */
export function decodeLayers(map) {
  const n = map.width * map.height;
  let terrain;
  let ore;
  try {
    terrain = decodeBase64(map.terrain);
  } catch {
    throw new Error('terrain is not valid base64');
  }
  try {
    ore = decodeBase64(map.ore);
  } catch {
    throw new Error('ore is not valid base64');
  }
  if (terrain.length !== n) throw new Error(`terrain has ${terrain.length} bytes, expected ${n} (width*height)`);
  if (ore.length !== n) throw new Error(`ore has ${ore.length} bytes, expected ${n} (width*height)`);
  return { terrain, ore };
}

/**
 * Cells reachable by ground units from (x, y): 4-neighbour flood fill over
 * passable terrain, the same test the engine generator uses.
 */
export function reachableFrom(terrain, width, height, x, y) {
  const seen = new Uint8Array(width * height);
  if (x < 0 || y < 0 || x >= width || y >= height) return seen;
  const start = y * width + x;
  if (!isPassable(terrain[start])) return seen;
  const stack = [start];
  seen[start] = 1;
  while (stack.length) {
    const i = stack.pop();
    const cx = i % width;
    const cy = (i - cx) / width;
    if (cx > 0 && !seen[i - 1] && isPassable(terrain[i - 1])) (seen[i - 1] = 1), stack.push(i - 1);
    if (cx < width - 1 && !seen[i + 1] && isPassable(terrain[i + 1])) (seen[i + 1] = 1), stack.push(i + 1);
    if (cy > 0 && !seen[i - width] && isPassable(terrain[i - width])) (seen[i - width] = 1), stack.push(i - width);
    if (cy < height - 1 && !seen[i + width] && isPassable(terrain[i + width])) (seen[i + width] = 1), stack.push(i + width);
  }
  return seen;
}

/** Footprint cells `[dx, dy, kind]` (kind 1 occupied, 2 passable) of a catalog actor, or a single cell. */
export function footprintOf(info) {
  if (info?.kind === 'building' && Array.isArray(info.footprint)) {
    return info.footprint.filter((c) => c[2] !== 0);
  }
  return [[0, 0, 1]];
}

/** Catalog lookup; actor ids match case-insensitively, like the engine. */
export function catalogEntry(catalog, type) {
  if (catalog[type]) return catalog[type];
  const lower = String(type).toLowerCase();
  const key = Object.keys(catalog).find((k) => k.toLowerCase() === lower);
  return key === undefined ? undefined : catalog[key];
}

// ---- Validation -------------------------------------------------------------------

const isInt = (v) => Number.isInteger(v);
const TOP_KEYS = ['format', 'name', 'author', 'description', 'width', 'height', 'terrain', 'ore', 'spawns', 'actors', 'rules'];

/**
 * Validate a map against contract section 2.
 *
 * @param map parsed map JSON
 * @param opts.catalog optional `{ [actorId]: { kind, width, height, footprint } }`
 *   (from the engine's rules_json); without it actor types are not checked.
 * @param opts.rulesBase optional `{ actors, weapons }` built-in rules keyed by id;
 *   without it `rules` overrides are only checked for shape.
 * @returns `{ ok, errors: string[], warnings: string[], modded, issues: [{level, message, x?, y?}] }`
 *   `ok` is false when there are errors; warnings do not block publishing.
 */
export function validateMap(map, opts = {}) {
  const issues = [];
  const error = (message, x, y) => issues.push({ level: 'error', message, x, y });
  const warn = (message, x, y) => issues.push({ level: 'warning', message, x, y });
  const result = () => ({
    ok: !issues.some((i) => i.level === 'error'),
    errors: issues.filter((i) => i.level === 'error').map((i) => i.message),
    warnings: issues.filter((i) => i.level === 'warning').map((i) => i.message),
    modded: isObject(map) && isModded(map),
    issues,
  });

  if (!isObject(map)) {
    error('The map must be a JSON object.');
    return result();
  }
  for (const k of Object.keys(map)) {
    if (!TOP_KEYS.includes(k)) error(`Unknown field "${k}".`);
  }
  if (map.format !== MAP_FORMAT) error(`Unsupported format ${JSON.stringify(map.format)} (expected ${MAP_FORMAT}).`);

  const text = (key, min, max) => {
    const v = map[key];
    if (typeof v !== 'string') error(`${key} must be a string.`);
    else if (v.length < min || v.length > max) error(`${key} must be ${min}..${max} characters (has ${v.length}).`);
    else if (min > 0 && v.trim().length === 0) error(`${key} must not be blank.`);
  };
  text('name', 1, LIMITS.nameMax);
  text('author', 1, LIMITS.authorMax);
  if (map.description !== undefined) text('description', 0, LIMITS.descriptionMax);

  const sizeOk = ['width', 'height'].every((k) => {
    const v = map[k];
    if (!isInt(v) || v < LIMITS.minSize || v > LIMITS.maxSize) {
      error(`${k} must be an integer ${LIMITS.minSize}..${LIMITS.maxSize} (is ${JSON.stringify(v)}).`);
      return false;
    }
    return true;
  });

  let layers = null;
  if (sizeOk) {
    try {
      layers = decodeLayers(map);
    } catch (err) {
      error(`${err.message}.`);
    }
  }
  const { width: w, height: h } = map;
  const inside = (x, y) => isInt(x) && isInt(y) && x >= 0 && y >= 0 && x < w && y < h;

  if (layers) {
    let badTerrain = 0;
    let badOre = 0;
    let oreOnBlocked = 0;
    for (let i = 0; i < layers.terrain.length; i++) {
      if (layers.terrain[i] > TERRAIN.TREE) badTerrain++;
      if (layers.ore[i] > LIMITS.maxOre) badOre++;
      else if (layers.ore[i] > 0 && !isPassable(layers.terrain[i])) oreOnBlocked++;
    }
    if (badTerrain) error(`terrain has ${badTerrain} cells with values outside 0..4.`);
    if (badOre) error(`ore has ${badOre} cells with density above ${LIMITS.maxOre}.`);
    if (oreOnBlocked) error(`${oreOnBlocked} ore cells lie on impassable terrain; ore can only lie on clear or rough ground.`);
  }

  // Spawns
  const spawns = Array.isArray(map.spawns) ? map.spawns : null;
  if (!spawns) error('spawns must be an array.');
  else if (spawns.length < LIMITS.minSpawns || spawns.length > LIMITS.maxSpawns) {
    error(`A map needs ${LIMITS.minSpawns}..${LIMITS.maxSpawns} spawns (has ${spawns.length}).`);
  }
  const goodSpawns = [];
  (spawns ?? []).forEach((s, k) => {
    const n = k + 1;
    if (!Array.isArray(s) || s.length !== 2 || !isInt(s[0]) || !isInt(s[1])) {
      error(`Spawn ${n} must be [x, y] integers.`);
      return;
    }
    if (sizeOk && !inside(s[0], s[1])) {
      error(`Spawn ${n} at ${s[0]},${s[1]} is outside the map.`, s[0], s[1]);
      return;
    }
    goodSpawns.push({ n, x: s[0], y: s[1] });
  });
  if (layers && goodSpawns.length) {
    for (const s of goodSpawns) {
      // The engine needs the whole 3x4 construction yard on clear ground.
      const t = layers.terrain[s.y * w + s.x];
      let open = true;
      for (let dy = 0; dy < 4 && open; dy++) {
        for (let dx = 0; dx < 3 && open; dx++) {
          open = inside(s.x + dx, s.y + dy) && isBuildable(layers.terrain[(s.y + dy) * w + s.x + dx]);
        }
      }
      if (!isPassable(t)) {
        error(`Spawn ${s.n} at ${s.x},${s.y} is on impassable ground (${TERRAIN_NAMES[t] ?? t}).`, s.x, s.y);
      } else if (!open) {
        error(`Spawn ${s.n} at ${s.x},${s.y} needs 3x4 clear ground for the construction yard.`, s.x, s.y);
      }
    }
    for (let a = 0; a < goodSpawns.length; a++) {
      for (let b = a + 1; b < goodSpawns.length; b++) {
        const A = goodSpawns[a];
        const B = goodSpawns[b];
        if (Math.abs(A.x - B.x) < 4 && Math.abs(A.y - B.y) < 5) {
          warn(`Spawns ${A.n} and ${B.n} overlap.`, B.x, B.y);
        }
      }
    }
    const first = goodSpawns.find((s) => isPassable(layers.terrain[s.y * w + s.x]));
    if (first) {
      const seen = reachableFrom(layers.terrain, w, h, first.x, first.y);
      for (const s of goodSpawns) {
        if (s !== first && isPassable(layers.terrain[s.y * w + s.x]) && !seen[s.y * w + s.x]) {
          error(`Spawn ${s.n} cannot be reached by ground from spawn ${first.n}.`, s.x, s.y);
        }
      }
    }
  }

  // Actors
  if (map.actors !== undefined && !Array.isArray(map.actors)) error('actors must be an array.');
  const spawnCount = spawns?.length ?? 0;
  if (Array.isArray(map.actors) && map.actors.length > LIMITS.maxActors) {
    error(`At most ${LIMITS.maxActors} pre-placed actors (has ${map.actors.length}).`);
  }
  (Array.isArray(map.actors) ? map.actors : []).forEach((a, i) => {
    const label = `Actor ${i + 1}${a && typeof a.type === 'string' ? ` (${a.type})` : ''}`;
    if (!isObject(a)) {
      error(`${label} must be an object.`);
      return;
    }
    for (const k of Object.keys(a)) {
      if (!['type', 'owner', 'x', 'y', 'facing'].includes(k)) error(`${label}: unknown field "${k}".`);
    }
    if (typeof a.type !== 'string' || !a.type) error(`${label}: type must be an actor id.`);
    const info = opts.catalog && typeof a.type === 'string' ? catalogEntry(opts.catalog, a.type) : undefined;
    if (opts.catalog && typeof a.type === 'string' && !info) error(`${label}: unknown actor type.`);
    if (!isInt(a.owner) || a.owner < -1 || a.owner >= spawnCount) {
      error(`${label}: owner must be -1 (neutral) or a spawn index 0..${spawnCount - 1}.`);
    }
    if (a.facing !== undefined && !isInt(a.facing)) error(`${label}: facing must be an integer.`);
    else if (a.facing !== undefined && (a.facing < 0 || a.facing > LIMITS.maxFacing)) {
      warn(`${label}: facing should be 0..${LIMITS.maxFacing}.`);
    }
    if (!sizeOk) return;
    if (!inside(a.x, a.y)) {
      error(`${label} at ${a.x},${a.y} is outside the map.`, a.x, a.y);
      return;
    }
    if (info) {
      const cells = footprintOf(info);
      if (cells.some(([dx, dy]) => !inside(a.x + dx, a.y + dy))) {
        // The engine refuses such maps (a structure off the edge would break every client).
        error(`${label} at ${a.x},${a.y} does not fit inside the map.`, a.x, a.y);
        return;
      }
      if (layers) {
        const bad = cells.some(([dx, dy, c]) => {
          const t = layers.terrain[(a.y + dy) * w + a.x + dx];
          return info.kind === 'building' && c === 1 ? !isBuildable(t) : !isPassable(t);
        });
        if (bad) warn(`${label} at ${a.x},${a.y} stands on terrain it cannot occupy.`, a.x, a.y);
      }
    }
  });

  // Rules overrides
  if (map.rules !== undefined && map.rules !== null) {
    if (!isObject(map.rules)) error('rules must be an object or null.');
    else if (opts.rulesBase) for (const e of validateOverrides(map.rules, opts.rulesBase)) error(e);
    else {
      for (const k of Object.keys(map.rules)) {
        if (k !== 'actors' && k !== 'weapons') error(`rules.${k}: unknown section (expected actors or weapons).`);
      }
    }
  }

  // Size limit (only meaningful for an otherwise well-formed map)
  try {
    const bytes = byteLength(canonicalJson(map));
    if (bytes > LIMITS.maxBytes) error(`The map is ${(bytes / 1024).toFixed(0)} KiB; the limit is 1024 KiB.`);
  } catch {
    error('The map cannot be serialized.');
  }

  return result();
}

/** Parse map JSON text. Throws `Error` with a readable message. */
export function parseMap(text) {
  let map;
  try {
    map = JSON.parse(text);
  } catch (err) {
    throw new Error(`Not valid JSON: ${err.message}`);
  }
  if (!isObject(map)) throw new Error('The file does not contain a map object.');
  return map;
}

/** File-name friendly version of a map name. */
export function mapFileName(name) {
  const base = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return (base || 'map') + MAP_FILE_SUFFIX;
}

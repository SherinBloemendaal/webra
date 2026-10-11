// WebRA map formats 1 and 2 (`.webra-map.json`, docs/contracts.md section 2).
// Format 2 is format 1 plus a `gems` layer; maps without gems are written as format 1.
// Pure module: base64 layers, canonical JSON, sha256 identity and validation.
// Runs in browsers and in Node (tests), no DOM access. The canonical form and
// the file form come from the protocol package, like the format version
// (`formatVersion`, upgrades in packages/protocol/src/mapversions.js).

import {
  BIOME_PREVIEW_COLORS,
  PREVIEW_GEMS,
  PREVIEW_ORE,
  canonicalMapObject,
  MAP_FORMAT_VERSION,
  mapFileJson,
  validateActorState,
  validateLockedOptions,
  validateMapOptions,
  validateMapPlayers,
  validateTags,
} from '../../js/protocol.js';
import { validateOverrides } from './overrides.js';

export { MAP_FORMAT_VERSION };

/** The current format (with gems). */
export const MAP_FORMAT = 2;
/** The format without gems: still read, and written when no cell holds gems. */
export const MAP_FORMAT_ORE_ONLY = 1;
export const MAP_FILE_SUFFIX = '.webra-map.json';

export const TERRAIN = Object.freeze({ CLEAR: 0, ROUGH: 1, ROCK: 2, WATER: 3, TREE: 4, FORD: 5, ROAD: 6, BRIDGE: 7, BEACH: 8, RIVER: 9, WALL: 10 });
export const TERRAIN_NAMES = ['Clear', 'Rough', 'Rock', 'Water', 'Tree', 'Ford', 'Road', 'Bridge', 'Beach', 'River', 'Wall'];
/** Largest terrain value (engine/src/map.rs Terrain). */
export const MAX_TERRAIN = TERRAIN.WALL;
/** Map biomes (engine/src/weather.rs); a map without `biome` is temperate. */
export const BIOMES = ['temperate', 'snow', 'desert'];

export const LIMITS = Object.freeze({
  minSize: 32,
  maxSize: 256,
  minSpawns: 2,
  maxSpawns: 8,
  maxOre: 12,
  maxGems: 3,
  maxBytes: 1024 * 1024,
  nameMax: 64,
  authorMax: 64,
  descriptionMax: 500,
  maxFacing: 1023,
  maxActors: 2000,
});

/** Map preview colours per biome, the same as the engine's previews (engine/src/weather.rs preview_color). */
// Preview colours (minimap, PNG export): the protocol's, shared with the map list's thumbnails.
export { BIOME_PREVIEW_COLORS, PREVIEW_GEMS, PREVIEW_ORE };
export const PREVIEW_COLORS = BIOME_PREVIEW_COLORS.temperate;

/** Cells ground units can cross (engine/src/map.rs Terrain::passable): fords, roads, bridges and beaches too. */
export const isPassable = (t) =>
  t === TERRAIN.CLEAR || t === TERRAIN.ROUGH || t === TERRAIN.FORD || t === TERRAIN.ROAD || t === TERRAIN.BRIDGE || t === TERRAIN.BEACH;
/** Cells that can hold ore or gems (engine/src/map.rs Terrain::holds_ore). */
export const holdsResource = (t) => t === TERRAIN.CLEAR || t === TERRAIN.ROUGH || t === TERRAIN.ROAD;
/** Cells structures can stand on (engine/src/map.rs Terrain::buildable: OpenRA's Clear and Road). */
export const isBuildable = (t) => t === TERRAIN.CLEAR || t === TERRAIN.ROAD;

/**
 * Whether catalog actor `info` (engine rules_json) may have footprint cell
 * kind `c` on terrain `t`: naval yards (`onWater`) only on water, other
 * structures on clear ground and roads (passable cells on passable ground),
 * ground units and ships where their locomotor goes (`terrain`: ships on
 * water, the transport also on beaches), the rest on passable ground.
 */
export function canOccupy(info, c, t) {
  if (info?.kind === 'building') {
    if (info.onWater) return t === TERRAIN.WATER;
    return c === 1 ? isBuildable(t) : isPassable(t);
  }
  if (Array.isArray(info?.terrain)) return info.terrain.includes(t);
  return isPassable(t);
}

/** The terrain that makes a footprint cell of `info` valid ("Clear the ground under it"): water for ships and naval yards. */
export function groundFor(info) {
  if (info?.kind === 'building') return info.onWater ? TERRAIN.WATER : TERRAIN.CLEAR;
  if (Array.isArray(info?.terrain) && !info.terrain.includes(TERRAIN.CLEAR)) return TERRAIN.WATER;
  return TERRAIN.CLEAR;
}

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

/**
 * The map in canonical form (packages/protocol canonicalMapObject): top-level
 * keys in contract order, every key present (`description` "", `actors` [],
 * `rules` null when missing) except `gems`, which only a format 2 map has
 * (after `ore`), `biome` (not when temperate) and `formatVersion` (not at
 * version 1), actor keys in the order type, owner, x, y, facing, and `rules`
 * keys sorted recursively. Never `gameVersion`.
 */
export function canonicalMap(map) {
  return canonicalMapObject(map);
}

/**
 * The text of a map file as the editor saves it: the canonical form with the
 * format version and this release's `gameVersion` in front (packages/protocol
 * mapFileJson). Same identity as the canonical form.
 */
export function mapFileText(map) {
  return mapFileJson(map);
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
    formatVersion: MAP_FORMAT_VERSION,
    format: MAP_FORMAT_ORE_ONLY,
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
    // The game setup (map format version 2): open slots, the lobby's options, no tags.
    players: [],
    options: {},
    lockedOptions: [],
    tags: [],
  };
}

/** The format a map with these gems is written in: 2 when any cell holds gems, else 1. */
export function formatFor(gems) {
  return gems.some((g) => g > 0) ? MAP_FORMAT : MAP_FORMAT_ORE_ONLY;
}

/**
 * Decode the terrain, ore and gems layers (no gems layer: all zero). Throws
 * with a readable message on bad data.
 */
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
  let gems = new Uint8Array(n);
  if (map.gems !== undefined && map.gems !== null) {
    try {
      gems = decodeBase64(map.gems);
    } catch {
      throw new Error('gems is not valid base64');
    }
    if (gems.length !== n) throw new Error(`gems has ${gems.length} bytes, expected ${n} (width*height)`);
  }
  return { terrain, ore, gems };
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

/** Footprint cells `[dx, dy, kind]` (kind 1 occupied, 2 passable, 3 over the cell without taking it: bridges and their huts) of a catalog actor, or a single cell. */
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
const TOP_KEYS = ['formatVersion', 'gameVersion', 'format', 'name', 'author', 'description', 'width', 'height', 'terrain', 'ore', 'gems', 'spawns', 'actors', 'rules', 'biome', 'players', 'options', 'lockedOptions', 'tags'];
const ACTOR_KEYS = ['type', 'owner', 'x', 'y', 'facing', 'health', 'stance', 'veterancy', 'cargo'];

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
  // Files are upgraded before they get here (js/protocol.js upgradeMap): only the current version is edited.
  if (map.formatVersion !== undefined && map.formatVersion !== MAP_FORMAT_VERSION) {
    error(`formatVersion must be ${MAP_FORMAT_VERSION}; open the file to upgrade it.`);
  }
  const hasGems = map.gems !== undefined && map.gems !== null;
  if (map.format !== MAP_FORMAT && map.format !== MAP_FORMAT_ORE_ONLY) {
    error(`Unsupported format ${JSON.stringify(map.format)} (expected ${MAP_FORMAT_ORE_ONLY} or ${MAP_FORMAT}).`);
  } else if (map.format === MAP_FORMAT_ORE_ONLY && hasGems) {
    error('Format 1 maps have no gems layer.');
  } else if (map.format === MAP_FORMAT && !hasGems) {
    error('Format 2 maps need a gems layer.');
  }
  if (hasGems && typeof map.gems !== 'string') error('gems must be base64 text.');
  if (map.biome !== undefined && !BIOMES.includes(map.biome)) error(`biome must be one of ${BIOMES.join(', ')}.`);

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
  if (sizeOk && (!hasGems || typeof map.gems === 'string')) {
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
    let badGems = 0;
    let gemsOnBlocked = 0;
    let both = 0;
    for (let i = 0; i < layers.terrain.length; i++) {
      if (layers.terrain[i] > MAX_TERRAIN) badTerrain++;
      if (layers.ore[i] > LIMITS.maxOre) badOre++;
      else if (layers.ore[i] > 0 && !holdsResource(layers.terrain[i])) oreOnBlocked++;
      if (layers.gems[i] > LIMITS.maxGems) badGems++;
      else if (layers.gems[i] > 0 && !holdsResource(layers.terrain[i])) gemsOnBlocked++;
      if (layers.ore[i] > 0 && layers.gems[i] > 0) both++;
    }
    if (badTerrain) error(`terrain has ${badTerrain} cells with values outside 0..${MAX_TERRAIN}.`);
    if (badOre) error(`ore has ${badOre} cells with density above ${LIMITS.maxOre}.`);
    if (oreOnBlocked) error(`${oreOnBlocked} ore cells lie on other terrain; ore can only lie on clear or rough ground or roads.`);
    if (badGems) error(`gems has ${badGems} cells with density above ${LIMITS.maxGems}.`);
    if (gemsOnBlocked) error(`${gemsOnBlocked} gem cells lie on other terrain; gems can only lie on clear or rough ground or roads.`);
    if (both) error(`${both} cells hold both ore and gems; a cell holds one or the other.`);
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
        // Overlapping yards are refused by the engine (the second start would get no yard).
        if (Math.abs(A.x - B.x) < 3 && Math.abs(A.y - B.y) < 4) {
          error(`Spawns ${A.n} and ${B.n} overlap.`, B.x, B.y);
        } else if (Math.abs(A.x - B.x) < 4 && Math.abs(A.y - B.y) < 5) {
          warn(`Spawns ${A.n} and ${B.n} are very close.`, B.x, B.y);
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
      if (!ACTOR_KEYS.includes(k)) error(`${label}: unknown field "${k}".`);
    }
    // Health, stance, veterancy, passengers (map format version 2; the engine checks them against the rules).
    try {
      validateActorState(a, label);
    } catch (err) {
      error(`${err.message}.`, a.x, a.y);
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
          // Bridges lie over their template's cells, whatever they are (engine bridges.rs).
          if (c === 3) return false;
          return !canOccupy(info, c, t);
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

  // The game setup (map format version 2, packages/protocol mapsetup.js).
  const setup = (fn) => {
    try {
      fn();
    } catch (err) {
      error(`${err.message.charAt(0).toUpperCase()}${err.message.slice(1)}.`);
    }
  };
  setup(() => validateMapPlayers(map.players ?? [], spawnCount));
  setup(() => validateLockedOptions(map.lockedOptions ?? [], validateMapOptions(map.options ?? {})));
  setup(() => validateTags(map.tags ?? []));

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

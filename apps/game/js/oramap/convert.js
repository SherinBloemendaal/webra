// Convert a parsed OpenRA map (map.yaml + map.bin) into a WebRA map (format 1,
// docs/contracts.md section 2) and an import report.
//
// What maps onto WebRA:
// - Terrain: every cell's tile is looked up in the RA tileset tables
//   (tables.js, generated from OpenRA's tilesets) and the OpenRA terrain type
//   is mapped by ORA_TO_WEBRA_TERRAIN. The map is cropped to its Bounds.
// - Resources: ore and gems with OpenRA's density recalculation, into the
//   ore and gems layers (RESOURCE_TYPES). Maps with gems are format 2.
// - Bridges: OpenRA's LegacyBridgeLayer turns the map's bridge templates into
//   bridge actors; so does the import (BRIDGES in tables.js), at the
//   template's top-left cell, over the terrain of its tiles.
// - mpspawn actors become spawns; actors of types WebRA knows are kept,
//   among them the neutral world: trees, rocks, civilians, civilian and tech
//   buildings, barrels, ore mines (engine/src/neutral.rs).
// - Rules and Weapons values that have a WebRA rules field become `rules`
//   overrides (a modded map, with the usual warning before it is installed).
// Everything else (Lua, other rules, custom art and sounds, unknown actors) is
// listed in the report and never applied.

import { BRIDGES, INHERITS, TILESETS } from './tables.js';
import { child, childValue, parseIntPair, parseIntQuad, parseInteger, parseList, parseWDist } from './miniyaml.js';
import { BIOMES as MAP_BIOMES, encodeBase64, formatFor, holdsResource, isBuildable, MAP_FORMAT_VERSION, TERRAIN } from '../../editor/js/mapformat.js';
import { ticksToTime } from '../maprules.js';
import { ACTOR_CARGO_MAX, GAME_VERSION, MAP_OPTION_KEYS, MAP_OPTION_VALUES, PREVIEW_TEAM } from '../protocol.js';

export class OramapError extends Error {
  constructor(message, report = null) {
    super(message);
    this.report = report;
  }
}

/** WebRA map limits (docs/contracts.md section 2). */
const MIN_SIZE = 32;
const MAX_SIZE = 256;
const MAX_SPAWNS = 8;
const MAX_ACTORS = 2000;
const ACTOR_TYPE_RE = /^[A-Za-z0-9.]{1,16}$/;

/**
 * OpenRA terrain letter (see ORA_TERRAIN_LETTERS in tables.js) to WebRA
 * terrain: the same types (roads and bridges faster, beaches slow wheels,
 * rivers and walls stop everything); the ore and gem tiles are clear ground.
 */
export const ORA_TO_WEBRA_TERRAIN = Object.freeze({
  c: TERRAIN.CLEAR,
  d: TERRAIN.ROAD,
  g: TERRAIN.BRIDGE,
  o: TERRAIN.CLEAR,
  m: TERRAIN.CLEAR,
  r: TERRAIN.ROUGH,
  b: TERRAIN.BEACH,
  k: TERRAIN.ROCK,
  l: TERRAIN.WALL,
  v: TERRAIN.RIVER,
  w: TERRAIN.WATER,
  t: TERRAIN.TREE,
});

/** Names of the OpenRA terrain letters, for the report. */
const LETTER_NAMES = {
  c: 'clear',
  d: 'road',
  g: 'bridge',
  o: 'ore ground',
  m: 'gem ground',
  r: 'rough',
  b: 'beach',
  k: 'rock',
  l: 'wall',
  v: 'river',
  w: 'water',
  t: 'tree',
};

/**
 * OpenRA RA tileset to WebRA biome (the map's optional `biome` field).
 * INTERIOR has no WebRA biome and is drawn temperate.
 */
export const TILESET_BIOMES = Object.freeze({
  TEMPERAT: 'temperate',
  SNOW: 'snow',
  DESERT: 'desert',
  INTERIOR: 'interior',
});

/**
 * OpenRA RA resource types (ResourceIndex of ResourceLayer in
 * mods/ra/rules/world.yaml) and the WebRA layer each lands in. Both games use
 * the same densities (ore 1..12, gems 1..3) and values (25 and 50 per bale).
 */
export const RESOURCE_TYPES = Object.freeze({
  1: Object.freeze({ name: 'Ore', maxDensity: 12, webra: 'ore' }),
  2: Object.freeze({ name: 'Gems', maxDensity: 3, webra: 'gems' }),
});

/** OpenRA actor types that only make sense in OpenRA (no report noise beyond a count). */
const ENGINE_ONLY_ACTORS = new Set(['waypoint', 'camera', 'camera.small', 'camera.paradrop', 'flare', 'mpspawn']);

/** map.yaml keys that carry content WebRA cannot use. */
const UNSUPPORTED_KEYS = {
  Sequences: 'custom sprite sequences',
  ModelSequences: 'custom model sequences',
  VoxelSequences: 'custom voxel sequences',
  Voices: 'custom voices',
  Music: 'custom music',
  Notifications: 'custom notifications',
  Translations: 'custom translations',
  FluentMessages: 'custom text (FluentMessages)',
  Video: 'videos',
  Smudges: 'smudges (craters and scorch marks)',
};

// ---- Tile lookup ------------------------------------------------------------------

const letterCache = new Map();

function expandRle(s) {
  let out = '';
  for (let i = 0; i < s.length; ) {
    const c = s[i++];
    let n = '';
    while (i < s.length && s[i] >= '0' && s[i] <= '9') n += s[i++];
    out += c.repeat(n ? Number(n) : 1);
  }
  return out;
}

/** Terrain letters of a template ("." for missing tiles), or undefined for an unknown template. */
function templateLetters(tileset, id) {
  const key = `${tileset}:${id}`;
  if (letterCache.has(key)) return letterCache.get(key);
  const packed = TILESETS[tileset]?.[id];
  const letters = packed === undefined ? undefined : expandRle(packed);
  letterCache.set(key, letters);
  return letters;
}

// ---- Helpers ----------------------------------------------------------------------------

const FORBIDDEN_CHARS = /[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u202a-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/g;

/** Display text from an untrusted file: no control or bidi characters, collapsed spaces, at most `max` code points. */
export function cleanText(value, max) {
  let s = String(value ?? '');
  if (typeof s.toWellFormed === 'function') s = s.toWellFormed();
  s = s.normalize('NFC').replace(FORBIDDEN_CHARS, ' ').replace(/\s+/g, ' ').trim();
  const cps = Array.from(s);
  return cps.length > max ? cps.slice(0, max).join('').trim() : s;
}

/** "a x3, b x2, c" for a Map of name -> count, longest first, capped. */
function countList(counts, cap = 12) {
  const items = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const shown = items.slice(0, cap).map(([k, n]) => (n > 1 ? `${k} x${n}` : k));
  if (items.length > cap) shown.push(`${items.length - cap} more`);
  return shown.join(', ');
}

const bump = (m, k, n = 1) => m.set(k, (m.get(k) ?? 0) + n);

/**
 * Cells a WebRA building footprint claims (engine rules: strings of x X = +
 * _ -; `_` is not part of it, `-` lies over a cell without claiming it:
 * bridges and their huts).
 */
function buildingCells(info) {
  const fp = info?.building?.footprint;
  if (!Array.isArray(fp)) return [[0, 0]];
  const cells = [];
  fp.forEach((row, dy) => {
    for (let dx = 0; dx < String(row).length; dx++) if (row[dx] !== '_' && row[dx] !== '-') cells.push([dx, dy]);
  });
  return cells;
}

/** Every cell that belongs to a WebRA building footprint (not `_`): all must lie on the map. */
function areaCells(info) {
  const fp = info?.building?.footprint;
  if (!Array.isArray(fp)) return [[0, 0]];
  const cells = [];
  fp.forEach((row, dy) => {
    for (let dx = 0; dx < String(row).length; dx++) if (row[dx] !== '_') cells.push([dx, dy]);
  });
  return cells;
}

// ---- Conversion -------------------------------------------------------------------------

/**
 * @param {object} input
 * @param {import('./miniyaml.js').YamlNode[]} input.yaml parsed map.yaml
 * @param {ReturnType<import('./mapbin.js').readMapBin>} input.bin parsed map.bin
 * @param {(name: string) => import('./miniyaml.js').YamlNode[] | null} [input.yamlFile]
 *   parsed YAML file from the package (for Rules/Weapons file references), or null when missing
 * @param {string[]} [input.files] names of all files in the package
 * @param {object} opts
 * @param {{ actors: object[], weapons: object[] }} opts.baseRules the engine's built-in rules
 * @param {string} [opts.fileName] for the report and as a fallback title
 * @returns {{ map: object, report: object }}
 */
export function convertOramap(input, opts) {
  const { yaml, bin } = input;
  const files = input.files ?? [];
  const yamlFile = input.yamlFile ?? (() => null);
  const base = opts?.baseRules;
  if (!base || !Array.isArray(base.actors) || !Array.isArray(base.weapons)) throw new Error('convertOramap needs the engine rules');

  const report = {
    fileName: opts.fileName ?? '',
    title: '',
    author: '',
    tileset: '',
    mapFormat: null,
    sourceSize: [bin.width, bin.height],
    bounds: null,
    size: null,
    converted: [],
    skipped: [],
    warnings: [],
    unsupported: [],
    rules: { applied: [], rejected: [] },
    modded: false,
  };
  const fatal = (msg) => {
    throw new OramapError(msg, report);
  };

  // ---- map.yaml header -----------------------------------------------------------------
  report.mapFormat = parseInteger(childValue(yaml, 'MapFormat'));
  if (report.mapFormat === null) report.warnings.push('map.yaml has no MapFormat; reading it like a current OpenRA map.');
  else if (report.mapFormat < 11 || report.mapFormat > 12) {
    report.warnings.push(`MapFormat ${report.mapFormat} is not one WebRA was tested with (11 and 12); the import may be incomplete.`);
  }
  const mod = childValue(yaml, 'RequiresMod');
  if (mod !== undefined && mod.trim().toLowerCase() !== 'ra') fatal(`This map is for the OpenRA mod "${cleanText(mod, 32)}", not Red Alert (ra).`);
  const tileset = String(childValue(yaml, 'Tileset', '')).trim().toUpperCase();
  report.tileset = tileset;
  if (!TILESETS[tileset]) fatal(`Unknown tileset "${cleanText(tileset, 32)}" (Red Alert maps use TEMPERAT, SNOW, DESERT or INTERIOR).`);

  const title = cleanText(childValue(yaml, 'Title', ''), 64) || cleanText(String(opts.fileName ?? '').replace(/\.oramap$/i, ''), 64) || 'Imported map';
  const author = cleanText(childValue(yaml, 'Author', ''), 64) || 'Unknown';
  report.title = title;
  report.author = author;

  const mapSize = parseIntPair(childValue(yaml, 'MapSize'));
  if (!mapSize) fatal('map.yaml has no valid MapSize.');
  if (mapSize[0] !== bin.width || mapSize[1] !== bin.height) {
    fatal(`map.yaml says ${mapSize[0]}x${mapSize[1]} cells but map.bin has ${bin.width}x${bin.height}.`);
  }
  const W = bin.width;
  const H = bin.height;
  let bounds = parseIntQuad(childValue(yaml, 'Bounds'));
  if (!bounds) {
    report.warnings.push('map.yaml has no Bounds; the whole map is used.');
    bounds = [0, 0, W, H];
  }
  let [bx, by, bw, bh] = bounds;
  // Clamp the playable area to the map.
  const x0 = Math.max(0, Math.min(W, bx));
  const y0 = Math.max(0, Math.min(H, by));
  bw = Math.max(0, Math.min(W, bx + bw) - x0);
  bh = Math.max(0, Math.min(H, by + bh) - y0);
  bx = x0;
  by = y0;
  report.bounds = [bx, by, bw, bh];
  if (bw < 1 || bh < 1) fatal('The map has an empty playable area (Bounds).');
  if (bw > MAX_SIZE || bh > MAX_SIZE) fatal(`The playable area is ${bw}x${bh} cells; WebRA maps are at most ${MAX_SIZE}x${MAX_SIZE}.`);
  const width = Math.max(MIN_SIZE, bw);
  const height = Math.max(MIN_SIZE, bh);
  report.size = [width, height];
  if (width !== bw || height !== bh) {
    report.warnings.push(`The playable area is ${bw}x${bh} cells; WebRA maps are at least ${MIN_SIZE}x${MIN_SIZE}, so rock was added on the right and bottom.`);
  }

  for (const [key, what] of Object.entries(UNSUPPORTED_KEYS)) {
    if (child(yaml, key)) report.unsupported.push(`${what} (${key}) are not supported and were ignored.`);
  }
  const luaFiles = files.filter((f) => /\.lua$/i.test(f));

  // ---- Terrain, bridges and resources on the full map -----------------------------------
  const { full, ore, gems, letterCounts, resourceCounts, unknownResources, resourcesBlocked, bridgeOrigins } = convertTerrain(
    { tileset, bin, bounds: [bx, by, bw, bh] },
    report,
  );

  // ---- Actors -------------------------------------------------------------------------------
  const actorsNode = child(yaml, 'Actors')?.nodes ?? [];
  const playersNode = child(yaml, 'Players')?.nodes ?? [];
  const players = new Map();
  // OpenRA's lobby slots Multi0, Multi1, ... become the map's player slots (map format version 2).
  const slotRefs = [];
  for (const p of playersNode) {
    const name = childValue(p.nodes, 'Name', p.key.replace(/^PlayerReference@/, ''));
    const playable = /^true$/i.test(childValue(p.nodes, 'Playable', 'False'));
    players.set(name, { playable });
    const multi = /^Multi(\d)$/.exec(name);
    if (playable && multi) slotRefs[Number(multi[1])] = p.nodes;
  }
  const knownActors = new Map();
  for (const a of base.actors) {
    if (typeof a?.id === 'string') knownActors.set(a.id.toLowerCase(), a);
  }
  const wangle = report.mapFormat === null || report.mapFormat >= 12;

  const rawSpawns = [];
  const placed = [];
  const actorStates = new Map();
  const cargoDropped = new Map();
  const skippedTypes = new Map();
  const outside = new Map();
  const engineOnly = new Map();
  let badActors = 0;
  for (const node of actorsNode) {
    const type = String(node.value ?? '').trim();
    const lower = type.toLowerCase();
    const loc = parseIntPair(childValue(node.nodes, 'Location'));
    if (!type || !loc) {
      badActors++;
      continue;
    }
    const [ax, ay] = loc;
    if (lower === 'mpspawn') {
      rawSpawns.push([ax, ay]);
      continue;
    }
    if (ENGINE_ONLY_ACTORS.has(lower)) {
      bump(engineOnly, lower);
      continue;
    }
    const info = knownActors.get(lower);
    if (!info || !ACTOR_TYPE_RE.test(info.id)) {
      bump(skippedTypes, lower);
      continue;
    }
    if (ax < bx || ay < by || ax >= bx + bw || ay >= by + bh) {
      bump(outside, lower);
      continue;
    }
    const facingRaw = parseInteger(childValue(node.nodes, 'Facing'));
    let facing = 0;
    if (facingRaw !== null) {
      // OpenRA facings turn counter-clockwise, WebRA's clockwise; both 0 = north.
      // MapFormat 12 stores WAngle (0..1023), older maps 0..255.
      const f = wangle ? facingRaw : facingRaw * 4;
      facing = (((1024 - f) % 1024) + 1024) % 1024;
    }
    // OpenRA actor inits a map may set (map format version 2): Health (HealthInit, percent) and
    // Stance (StanceInit), where the actor has them. Other inits (Cargo with OpenRA's own names,
    // Veterancy of mods) are not read.
    const state = {};
    const health = parseInteger(childValue(node.nodes, 'Health'));
    if (health !== null && health >= 1 && health < 100 && info.kind !== 'crate') state.health = health;
    const stance = OPENRA_STANCES[String(childValue(node.nodes, 'Stance', '')).toLowerCase()];
    if (stance && Array.isArray(info.stance) && info.weapons?.length) state.stance = stance;
    // OpenRA CargoInit (`Cargo: e1, e1, e3`): the passengers a transport starts with, checked like the
    // map editor's passenger list (known types that fit its cargo types and weight, at most 16).
    const cargoText = childValue(node.nodes, 'Cargo', null);
    if (cargoText !== null && cargoText !== undefined) {
      const cargo = passengersOf(String(cargoText), info, knownActors);
      if (cargo.ok.length) state.cargo = cargo.ok;
      if (cargo.dropped.length) bump(cargoDropped, `${info.id} (${cargo.dropped.join(', ')})`);
    }
    if (Object.keys(state).length) bump(actorStates, info.id);
    placed.push({ info, owner: childValue(node.nodes, 'Owner', 'Neutral'), x: ax - bx, y: ay - by, facing, line: node.line, state });
  }
  // Bridges come first among the neutral actors: they claim no cells.
  const bridgesOutside = new Map();
  let bridgeCount = 0;
  for (const [key, actorId] of bridgeOrigins) {
    const [ax, ay] = key.split(',').map(Number);
    const info = knownActors.get(actorId.toLowerCase());
    if (!info) {
      bump(skippedTypes, actorId.toLowerCase());
      continue;
    }
    if (ax < bx || ay < by || ax >= bx + bw || ay >= by + bh) {
      bump(bridgesOutside, actorId);
      continue;
    }
    placed.unshift({ info, owner: 'Neutral', x: ax - bx, y: ay - by, facing: 0, line: 0 });
    bridgeCount++;
  }

  // ---- Crop and pad -------------------------------------------------------------------------
  const terrain = new Uint8Array(width * height).fill(TERRAIN.ROCK);
  const oreOut = new Uint8Array(width * height);
  const gemsOut = new Uint8Array(width * height);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const si = (by + y) * W + bx + x;
      terrain[y * width + x] = full[si];
      oreOut[y * width + x] = ore[si];
      gemsOut[y * width + x] = gems[si];
    }
  }

  // ---- Spawns ---------------------------------------------------------------------------------
  const fact = knownActors.get('fact');
  const yard = fact ? buildingCells(fact) : [];
  if (!yard.length) for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 3; dx++) yard.push([dx, dy]);
  // The MCV start puts the MCV on the yard's second cell (engine: World::spawn_start).
  if (!yard.some(([dx, dy]) => dx === 1 && dy === 1)) yard.push([1, 1]);
  const taken = new Int32Array(width * height); // 0 free, 1 + spawn index, 1000 + actor index
  const yardFits = (sx, sy, self) =>
    yard.every(([dx, dy]) => {
      const cx = sx + dx;
      const cy = sy + dy;
      if (cx < 0 || cy < 0 || cx >= width || cy >= height) return false;
      const ci = cy * width + cx;
      return isBuildable(terrain[ci]) && (taken[ci] === 0 || taken[ci] === self);
    });

  if (rawSpawns.length < 2) fatal(`The map has ${rawSpawns.length} start position(s) (mpspawn); WebRA needs at least 2.`);
  let spawnList = rawSpawns;
  if (spawnList.length > MAX_SPAWNS) {
    report.warnings.push(`The map has ${spawnList.length} start positions; WebRA supports ${MAX_SPAWNS}, so the first ${MAX_SPAWNS} were kept.`);
    spawnList = spawnList.slice(0, MAX_SPAWNS);
  }
  const spawns = [];
  const unplaced = [];
  spawnList.forEach(([ox, oy], k) => {
    // OpenRA puts the MCV on the spawn cell and deploys the yard one cell up and
    // left of it; WebRA spawns are the yard's top-left cell.
    const want = [ox - 1 - bx, oy - 1 - by];
    const self = 1 + spawns.length;
    let at = yardFits(want[0], want[1], self) ? want : null;
    for (let r = 1; !at && r <= 8; r++) {
      let best = null;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const d = dx * dx + dy * dy;
          if (best && best.d <= d) continue;
          if (yardFits(want[0] + dx, want[1] + dy, self)) best = { d, x: want[0] + dx, y: want[1] + dy };
        }
      }
      if (best) at = [best.x, best.y];
    }
    if (!at) {
      unplaced.push(k + 1);
      return;
    }
    if (at[0] !== want[0] || at[1] !== want[1]) {
      report.warnings.push(`Start position ${k + 1} was moved by ${at[0] - want[0]},${at[1] - want[1]} cells to find clear ground for the construction yard.`);
    }
    for (const [dx, dy] of yard) taken[(at[1] + dy) * width + at[0] + dx] = self;
    spawns.push(at);
  });
  if (unplaced.length) {
    report.warnings.push(`Start position(s) ${unplaced.join(', ')} have no clear ground for a construction yard nearby and were dropped.`);
  }
  if (spawns.length < 2) fatal('Fewer than 2 start positions have clear ground for a construction yard.');

  // ---- Actors on the WebRA map ---------------------------------------------------------------
  const nearestSpawn = (x, y) => {
    let best = 0;
    let bestD = Infinity;
    spawns.forEach(([sx, sy], i) => {
      const d = (sx + 1 - x) ** 2 + (sy + 1 - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  };
  const actors = [];
  const overlapping = new Map();
  const ownerNotes = new Map();
  for (const p of placed) {
    if (actors.length >= MAX_ACTORS) {
      bump(overlapping, `${p.info.id} (over the ${MAX_ACTORS} actor limit)`);
      continue;
    }
    let owner = -1;
    const ref = players.get(p.owner);
    if (ref?.playable) {
      owner = nearestSpawn(p.x, p.y);
      bump(ownerNotes, p.owner);
    }
    if (p.info.kind === 'building') {
      const cells = buildingCells(p.info);
      const inside = ([dx, dy]) => p.x + dx >= 0 && p.y + dy >= 0 && p.x + dx < width && p.y + dy < height;
      const ok =
        areaCells(p.info).every(inside) &&
        cells.every(([dx, dy]) => inside([dx, dy]) && taken[(p.y + dy) * width + p.x + dx] === 0);
      if (!ok) {
        bump(overlapping, p.info.id);
        continue;
      }
      for (const [dx, dy] of cells) taken[(p.y + dy) * width + p.x + dx] = 1000 + actors.length;
    }
    actors.push({ type: p.info.id, owner, x: p.x, y: p.y, facing: p.facing, ...p.state });
  }

  // ---- Rules ----------------------------------------------------------------------------------
  const lobby = { options: {}, locked: new Set() };
  const rules = translateRules(yaml, yamlFile, base, report, lobby);
  const { options, lockedOptions } = lobbySetup(lobby, report);
  const luaInRules = report.luaInRules === true;
  delete report.luaInRules;
  if (luaFiles.length || luaInRules) {
    const names = luaFiles.length ? ` (${luaFiles.slice(0, 5).join(', ')}${luaFiles.length > 5 ? ', ...' : ''})` : '';
    report.unsupported.push(`Lua scripts${names} are not run: imported maps never run scripts (only the game's own campaign missions do), so scripted events and mission objectives are missing.`);
  }

  // ---- Report ---------------------------------------------------------------------------------
  const terrainSummary = [...letterCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([l, n]) => `${LETTER_NAMES[l] ?? l} ${n}`)
    .join(', ');
  report.converted.push(`Terrain: ${bw}x${bh} cells of the ${tileset} tileset (${terrainSummary}).`);
  // WebRA maps hold terrain types, not tiles: the look of OpenRA's cliff,
  // shore and road templates is not carried over (docs/contracts.md).
  report.converted.push(
    'Each cell keeps its terrain type (clear, rough, rock, water, tree, beach, road, river, bridge, wall), not its OpenRA tile: the game draws cliffs, shores and roads with its own terrain tiles.',
  );
  if (letterCounts.get('d') || letterCounts.get('b') || letterCounts.get('v') || letterCounts.get('l')) {
    report.converted.push('Roads, beaches, rivers and walls keep their OpenRA terrain types (roads are faster, beaches slow wheels, rivers and walls stop everything).');
  }
  if (bridgeCount) report.converted.push(`Bridges (${bridgeCount}) became bridge actors: they can be destroyed and repaired at their huts, like OpenRA's.`);
  report.converted.push(`Map cropped to its playable area (Bounds ${bx},${by} ${bw}x${bh} of ${W}x${H}).`);
  if (resourceCounts.size) report.converted.push(`Resources: ${[...resourceCounts].map(([k, n]) => `${k.toLowerCase()} ${n} cells`).join(', ')}, densities recalculated like OpenRA.`);
  if (resourcesBlocked) report.warnings.push(`${resourcesBlocked} resource cells lay on ground where WebRA has no ore and were dropped.`);
  if (unknownResources.size) report.skipped.push(`Unknown resource types: ${countList(unknownResources)}.`);
  report.converted.push(`${spawns.length} start positions.`);
  if (actors.length) report.converted.push(`${actors.length} pre-placed actors (${countList(new Map(actors.map((a) => [a.type, actors.filter((b) => b.type === a.type).length])))}).`);
  if (ownerNotes.size) {
    report.warnings.push(`Actors owned by playable slots (${[...ownerNotes.keys()].slice(0, 8).join(', ')}) now belong to the nearest start position; OpenRA assigns them differently.`);
  }
  if (placed.some((p) => p.owner === 'Creeps')) report.warnings.push('Creeps actors became neutral; in WebRA neutral actors do not attack.');
  if (skippedTypes.size) report.skipped.push(`Actors WebRA does not have: ${countList(skippedTypes)}.`);
  if (outside.size) report.skipped.push(`Actors outside the playable area: ${countList(outside)}.`);
  if (bridgesOutside.size) report.skipped.push(`Bridges outside the playable area: ${countList(bridgesOutside)}.`);
  if (actorStates.size) report.converted.push(`Health, stances and passengers of pre-placed actors: ${countList(actorStates)}.`);
  if (cargoDropped.size) report.skipped.push(`Passengers that do not fit their transport or are unknown: ${countList(cargoDropped)}.`);
  if (overlapping.size) report.skipped.push(`Structures that overlap a start position, another structure or the map edge: ${countList(overlapping)}.`);
  if (engineOnly.size) report.skipped.push(`OpenRA script and editor markers: ${countList(engineOnly)}.`);
  if (badActors) report.warnings.push(`${badActors} actor entries without a type or location were ignored.`);
  const biome = MAP_BIOMES.includes(TILESET_BIOMES[tileset]) ? TILESET_BIOMES[tileset] : 'temperate';
  if (biome !== 'temperate') report.converted.push(`The ${tileset} tileset became the ${biome} biome.`);
  else if (TILESET_BIOMES[tileset] && tileset !== 'TEMPERAT') {
    report.warnings.push(`WebRA has no ${TILESET_BIOMES[tileset]} biome; the ${tileset} map is drawn temperate.`);
  }

  const slots = slotSetup(slotRefs, spawns.length, report);

  // Format 2 (with a gems layer) only when a cell holds gems, like every WebRA writer.
  const format = formatFor(gemsOut);
  const map = {
    // A map file of the current format version, stamped with this release (docs/contracts.md "Map versions").
    formatVersion: MAP_FORMAT_VERSION,
    gameVersion: GAME_VERSION,
    format,
    name: title,
    author,
    description: cleanText(`Imported from the OpenRA map ${report.fileName || title} (tileset ${tileset}).`, 500),
    width,
    height,
    terrain: encodeBase64(terrain),
    ore: encodeBase64(oreOut),
    ...(format === 2 ? { gems: encodeBase64(gemsOut) } : {}),
    spawns,
    actors,
    rules,
    // Optional field: left out for temperate maps (their identity stays as before biomes).
    ...(biome !== 'temperate' ? { biome } : {}),
    players: slots,
    options,
    lockedOptions,
    tags: [],
  };
  report.modded = rules !== null;
  return { map, report };
}

/** OpenRA RA factions (and their random choices) to the lobby's. */
const OPENRA_FACTIONS = Object.freeze({
  random: 'random',
  allies: 'randomallies',
  soviet: 'randomsoviet',
  england: 'england',
  france: 'france',
  germany: 'germany',
  russia: 'russia',
  ukraine: 'ukraine',
});

/**
 * The map's player slots from OpenRA's playable PlayerReferences Multi0 to
 * Multi<n> (`refs[k]`: its nodes): faction and team with their locks
 * (LockFaction, LockTeam) and colour (LockColor, nearestColor). Slots past
 * the map's spawns, and trailing slots that set nothing, are left out.
 */
function slotSetup(refs, spawns, report) {
  const out = [];
  for (let k = 0; k < Math.min(refs.length, spawns); k++) {
    const nodes = refs[k];
    const slot = { faction: 'random', team: 0, color: -1, type: 'open', difficulty: 'normal', bot: 'normal', lock: [] };
    if (nodes) {
      const faction = OPENRA_FACTIONS[String(childValue(nodes, 'Faction', 'Random')).toLowerCase()];
      if (faction) slot.faction = faction;
      if (/^true$/i.test(childValue(nodes, 'LockFaction', 'False')) && faction) slot.lock.push('faction');
      const color = nearestColor(childValue(nodes, 'Color', null), out.map((x) => x.color));
      if (color !== null) {
        slot.color = color;
        if (/^true$/i.test(childValue(nodes, 'LockColor', 'False'))) slot.lock.push('color');
      }
      const team = parseInteger(childValue(nodes, 'Team'));
      if (team !== null && team >= 0 && team <= 4) {
        slot.team = team;
        if (/^true$/i.test(childValue(nodes, 'LockTeam', 'False'))) slot.lock.push('team');
      }
    }
    out.push(slot);
  }
  while (out.length && out.at(-1).faction === 'random' && out.at(-1).team === 0 && out.at(-1).color < 0 && !out.at(-1).lock.length) out.pop();
  if (out.length) report.converted.push(`Player slots (factions and teams of OpenRA's lobby slots): ${out.length}.`);
  return out;
}

/**
 * The WebRA lobby colour (0..7, protocol PREVIEW_TEAM: blue, red, gold,
 * green, purple, orange, teal, white) nearest to an OpenRA player colour
 * (`Color: RRGGBB` or `RRGGBBAA` hex, or `r,g,b[,a]`), by squared distance
 * in RGB; colours `taken` by earlier slots are skipped, so every slot keeps
 * its own (the next nearest). Null without a readable colour ("Any").
 */
export function nearestColor(text, taken = []) {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  let rgb = null;
  const hex = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(t);
  if (hex) rgb = [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16));
  const list = /^(\d{1,3}),\s*(\d{1,3}),\s*(\d{1,3})(?:,\s*\d{1,3})?$/.exec(t);
  if (list) rgb = [list[1], list[2], list[3]].map(Number);
  if (!rgb || rgb.some((v) => v > 255)) return null;
  let best = null;
  PREVIEW_TEAM.forEach((c, i) => {
    if (taken.includes(i)) return;
    const d = (c[0] - rgb[0]) ** 2 + (c[1] - rgb[1]) ** 2 + (c[2] - rgb[2]) ** 2;
    if (!best || d < best.d) best = { i, d };
  });
  return best ? best.i : null;
}

/**
 * OpenRA CargoInit passengers (`e1, e1, e3`) of a transport `info` (base
 * rules actor), checked like the map editor's passenger list: known actor
 * types whose Passenger type the transport's (non-garrison) Cargo takes,
 * within its weight, at most ACTOR_CARGO_MAX. Returns { ok: ids, dropped: ids }.
 */
function passengersOf(text, info, knownActors) {
  const cargo = info.abilities?.cargo;
  const ok = [];
  const dropped = [];
  let weight = 0;
  for (const raw of text.split(',').map((x) => x.trim()).filter(Boolean)) {
    const p = knownActors.get(raw.toLowerCase());
    const kind = p?.unit?.passenger;
    const w = p?.unit?.passenger_weight ?? 1;
    const fits = cargo && !cargo.garrison && kind && cargo.types.includes(kind) && weight + w <= cargo.max && ok.length < ACTOR_CARGO_MAX && ACTOR_TYPE_RE.test(p.id);
    if (fits) {
      ok.push(p.id);
      weight += w;
    } else dropped.push(raw.slice(0, 16));
  }
  return { ok, dropped };
}

/** OpenRA UnitStance names (StanceInit) to WebRA's (engine rules.rs Stance). */
const OPENRA_STANCES = Object.freeze({ attackanything: 'attack_anything', defend: 'defend', returnfire: 'return_fire', holdfire: 'hold_fire' });

// ---- Rules and weapons ------------------------------------------------------------------

/** Rules nodes of map.yaml: inline children plus files listed in the value. */
/**
 * Terrain and resources of a whole OpenRA map (before cropping): every
 * cell's tile looked up in the tileset tables and mapped to WebRA terrain,
 * ore and gems with OpenRA's density recalculation, and the bridge actors its
 * bridge templates stand for (`bridgeOrigins`: "x,y" of the top-left cell to
 * the actor id). Warnings go to
 * `report`; the counts are for its summary (cells inside `bounds`).
 * Shared by `convertOramap` and the mission converter (mission.js).
 * @param {{ tileset: string, bin: ReturnType<import('./mapbin.js').readMapBin>, bounds: number[] }} input
 * @param {{ warnings: string[] }} report
 */
export function convertTerrain({ tileset, bin, bounds }, report) {
  const W = bin.width;
  const H = bin.height;
  const [bx, by, bw, bh] = bounds;
  const full = new Uint8Array(W * H);
  const letterCounts = new Map();
  let unknownTemplates = 0;
  let missingTiles = 0;
  // Bridges (OpenRA LegacyBridgeLayer.ConvertBridgeToActor): a bridge actor at
  // the top-left cell of every bridge template, found from any of its tiles.
  const bridgeTable = BRIDGES[tileset] ?? {};
  const bridgeOrigins = new Map(); // "x,y" -> bridge actor id
  for (let i = 0; i < W * H; i++) {
    const type = bin.tileType[i];
    const bridge = bridgeTable[type];
    if (bridge) {
      const [actorId, tw] = bridge;
      const x = i % W;
      const y = (i - x) / W;
      const idx = bin.tileIndex[i];
      const key = `${x - (idx % tw)},${y - Math.floor(idx / tw)}`;
      if (!bridgeOrigins.has(key)) bridgeOrigins.set(key, actorId);
    }
    const letters = templateLetters(tileset, type);
    let letter = 'c';
    if (letters === undefined) {
      unknownTemplates++;
    } else {
      // The index as OpenRA reads it (mapbin.js: 255 is (x % 4) + (y % 4) * 4);
      // one past the template's tiles is a missing tile, as OpenRA cannot load it.
      const l = letters[bin.tileIndex[i]];
      if (l === undefined || l === '.') missingTiles++;
      else letter = l;
    }
    full[i] = ORA_TO_WEBRA_TERRAIN[letter];
    const x = i % W;
    const y = (i - x) / W;
    if (x >= bx && x < bx + bw && y >= by && y < by + bh) bump(letterCounts, letter);
  }
  if (unknownTemplates) report.warnings.push(`${unknownTemplates} cells use tile templates the ${tileset} tileset does not have; they became clear ground.`);
  if (missingTiles) report.warnings.push(`${missingTiles} cells use tiles their template does not have; they became clear ground.`);

  // Resources, with OpenRA's density recalculation.
  const ore = new Uint8Array(W * H);
  const gems = new Uint8Array(W * H);
  const resourceCounts = new Map();
  const unknownResources = new Map();
  let resourcesBlocked = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const type = bin.resType[i];
      if (type === 0) continue;
      const info = RESOURCE_TYPES[type];
      if (!info) {
        bump(unknownResources, `type ${type}`);
        continue;
      }
      let adjacent = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < W && ny < H && bin.resType[ny * W + nx] === type) adjacent++;
        }
      }
      // OpenRA ResourceLayer: density = max(lerp(0, MaxDensity, adjacent, 9), 1).
      const density = Math.max(Math.floor((info.maxDensity * adjacent) / 9), 1);
      const t = full[i];
      if (!holdsResource(t)) {
        if (x >= bx && x < bx + bw && y >= by && y < by + bh) resourcesBlocked++;
        continue;
      }
      // A cell holds one resource type (map.bin has one per cell), so ore and gems never share a cell.
      (info.webra === 'gems' ? gems : ore)[i] = density;
      if (x >= bx && x < bx + bw && y >= by && y < by + bh) bump(resourceCounts, info.name);
    }
  }

  return { full, ore, gems, letterCounts, resourceCounts, unknownResources, resourcesBlocked, bridgeOrigins };
}

function collectNodes(yaml, key, yamlFile, report) {
  const node = child(yaml, key);
  if (!node) return [];
  const out = [];
  for (const ref of parseList(node.value)) {
    // `ra|rules/...` and other mod paths point outside the package.
    if (ref.includes('|')) {
      report.unsupported.push(`${key} file ${cleanText(ref, 80)} comes from the OpenRA mod, not the map, and was not loaded.`);
      continue;
    }
    const nodes = yamlFile(ref);
    if (nodes === null) {
      report.warnings.push(`${key} file ${cleanText(ref, 80)} is missing from the package.`);
      continue;
    }
    out.push(...nodes);
  }
  out.push(...node.nodes);
  return out;
}

const ACTOR_FIELDS = {
  'Valued.Cost': { path: ['cost'], parse: parseInteger, min: 0 },
  'Health.HP': { path: ['hp'], parse: parseInteger, min: 1 },
  'Mobile.Speed': { path: ['unit', 'speed'], parse: parseInteger, min: 1 },
  'Mobile.TurnSpeed': { path: ['unit', 'turn_speed'], parse: parseInteger, min: 1 },
  'RevealsShroud.Range': { path: ['sight'], parse: parseWDist, min: 0 },
  'Power.Amount': { path: ['building', 'power'], parse: parseInteger },
  'Buildable.Prerequisites': { path: ['prerequisites'], parse: (v) => parseList(v) },
};

/** OpenRA bool fields (FieldLoader: "true" or "false", any case), or null. */
function parseBool(value) {
  const s = String(value ?? '').trim().toLowerCase();
  return s === 'true' ? true : s === 'false' ? false : null;
}

/** OpenRA PlayerRelationship flags ("Ally, Enemy", "None") as WebRA's `display_timer`, or null. */
function parseRelationships(value) {
  const out = [];
  for (const r of parseList(value).map((x) => x.toLowerCase())) {
    if (r === 'none') continue;
    if (!['ally', 'neutral', 'enemy'].includes(r)) return null;
    if (!out.includes(r)) out.push(r);
  }
  return out;
}

/**
 * SupportPowerInfo fields (any support power trait, matched by its full key
 * such as `NukePower` or `AirstrikePower@spyplane`) onto the power's entry in
 * `abilities.support_powers`. Times are ticks in both games.
 */
const SUPPORT_POWER_FIELDS = {
  ChargeInterval: { field: 'charge', parse: parseInteger, min: 0 },
  OneShot: { field: 'one_shot', parse: parseBool },
  StartFullyCharged: { field: 'start_fully_charged', parse: parseBool },
  Prerequisites: { field: 'prerequisites', parse: (v) => parseList(v) },
  DisplayTimerRelationships: { field: 'display_timer', parse: parseRelationships },
};

const WEAPON_FIELDS = {
  Range: { path: ['range'], parse: parseWDist, min: 0 },
  MinRange: { path: ['min_range'], parse: parseWDist, min: 0 },
  ReloadDelay: { path: ['reload'], parse: parseInteger, min: 1 },
  Burst: { path: ['burst'], parse: parseInteger, min: 1 },
  'Projectile.Speed': { path: ['speed'], parse: (v) => parseWDist(parseList(v)[0]), min: 0 },
  'Projectile.Inaccuracy': { path: ['inaccuracy'], parse: parseWDist, min: 0 },
};

/**
 * Lobby options OpenRA maps set in the rules of the World and Player actors
 * (MapOptions, PlayerResources, DeveloperMode, ... with their dropdown and
 * checkbox defaults and locks) onto the map's `options` and `lockedOptions`.
 * `value` parses the field into a WebRA option value (checked against
 * MAP_OPTION_VALUES); `lock` fields lock the option. `openra` is OpenRA's
 * default, which a locked option the map does not set keeps.
 */
const OPENRA_GAME_SPEEDS = { slowest: 'slowest', slower: 'slower', default: 'normal', fast: 'fast', faster: 'faster', fastest: 'fastest' };
const LOBBY_OPTIONS = [
  { actor: 'world', trait: 'MapOptions', value: 'TechLevel', lock: 'TechLevelDropdownLocked', option: 'techLevel', openra: 'unrestricted', parse: (v) => String(v).trim().toLowerCase() },
  { actor: 'world', trait: 'MapOptions', value: 'GameSpeed', lock: 'GameSpeedDropdownLocked', option: 'gameSpeed', openra: 'normal', parse: (v) => OPENRA_GAME_SPEEDS[String(v).trim().toLowerCase()] },
  { actor: 'world', trait: 'MapOptions', value: 'ShortGameCheckboxEnabled', lock: 'ShortGameCheckboxLocked', option: 'shortGame', openra: true, parse: parseBool },
  { actor: 'world', trait: 'CrateSpawner', value: 'CheckboxEnabled', lock: 'CheckboxLocked', option: 'crates', openra: true, parse: parseBool },
  { actor: 'world', trait: 'MapBuildRadius', value: 'BuildRadiusCheckboxEnabled', lock: 'BuildRadiusCheckboxLocked', option: 'buildRadius', openra: true, parse: parseBool },
  { actor: 'world', trait: 'MapBuildRadius', value: 'AllyBuildRadiusCheckboxEnabled', lock: 'AllyBuildRadiusCheckboxLocked', option: 'allyBuildRadius', openra: true, parse: parseBool },
  { actor: 'world', trait: 'MapStartingLocations', value: 'SeparateTeamSpawnsCheckboxEnabled', lock: 'SeparateTeamSpawnsCheckboxLocked', option: 'separateTeamSpawns', openra: true, parse: parseBool },
  { actor: 'world', trait: 'SpawnStartingUnits', value: 'StartingUnitsClass', lock: 'DropdownLocked', option: 'startingUnits', openra: 'mcv', parse: (v) => ({ none: 'mcv', light: 'light', heavy: 'heavy' })[String(v).trim().toLowerCase()] },
  { actor: 'world', trait: 'TimeLimitManager', value: 'TimeLimitDefault', lock: 'TimeLimitLocked', option: 'timeLimit', openra: 0, parse: parseInteger },
  { actor: 'player', trait: 'PlayerResources', value: 'DefaultCash', lock: 'DefaultCashDropdownLocked', option: 'startingCash', openra: 5000, parse: parseInteger },
  { actor: 'player', trait: 'DeveloperMode', value: 'CheckboxEnabled', lock: 'CheckboxLocked', option: 'cheats', openra: false, parse: parseBool },
  { actor: 'player', trait: 'Shroud', value: 'FogCheckboxEnabled', lock: 'FogCheckboxLocked', option: 'fog', openra: true, parse: parseBool },
  { actor: 'player', trait: 'Shroud', value: 'ExploredMapCheckboxEnabled', lock: 'ExploredMapCheckboxLocked', option: 'explored', openra: false, parse: parseBool },
  { actor: 'player', trait: 'LobbyPrerequisiteCheckbox@GLOBALBOUNTY', value: 'Enabled', lock: 'Locked', option: 'bounty', openra: false, parse: parseBool },
  { actor: 'player', trait: 'LobbyPrerequisiteCheckbox@GLOBALFACTUNDEPLOY', value: 'Enabled', lock: 'Locked', option: 'redeployableMcv', openra: true, parse: parseBool },
  { actor: 'player', trait: 'LobbyPrerequisiteCheckbox@REUSABLEENGINEERS', value: 'Enabled', lock: 'Locked', option: 'reusableEngineers', openra: false, parse: parseBool },
];

/** Lobby names of the options above, for the report. */
const LOBBY_OPTION_LABELS = {
  techLevel: 'tech level',
  gameSpeed: 'game speed',
  shortGame: 'short game',
  crates: 'crates',
  buildRadius: 'build radius',
  allyBuildRadius: 'build off allies',
  separateTeamSpawns: 'separate team spawns',
  startingUnits: 'starting units',
  timeLimit: 'time limit',
  startingCash: 'starting cash',
  cheats: 'debug menu',
  fog: 'fog of war',
  explored: 'explored map',
  bounty: 'kill bounties',
  redeployableMcv: 'redeployable MCVs',
  reusableEngineers: 'reusable engineers',
};

const INT32 = 2 ** 31 - 1;

function getIn(obj, path) {
  let v = obj;
  for (const k of path) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, k)) return undefined;
    v = v[k];
  }
  return v;
}

function setIn(obj, path, value) {
  let o = obj;
  for (let i = 0; i < path.length - 1; i++) {
    if (!Object.hasOwn(o, path[i])) o[path[i]] = {};
    o = o[path[i]];
  }
  o[path[path.length - 1]] = value;
}

function parseField(spec, raw) {
  const v = spec.parse(raw);
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.every((s) => /^[A-Za-z0-9_.~!-]{1,40}$/.test(s)) && v.length <= 32 ? v : undefined;
  if (!Number.isSafeInteger(v) || Math.abs(v) > INT32) return undefined;
  if (spec.min !== undefined && v < spec.min) return undefined;
  return v;
}

/**
 * The World and Player actors' lobby option fields (LOBBY_OPTIONS) into
 * `lobby` ({ options, locked }); other fields are noted as unsupported.
 */
function lobbyOptionFields(actor, top, lobby, note) {
  for (const trait of top.nodes) {
    if (!trait.nodes.length) {
      note(`${top.key}.${cleanText(trait.key, 40)}`);
      continue;
    }
    for (const field of trait.nodes) {
      const what = `${top.key}.${cleanText(trait.key, 60)}.${cleanText(field.key, 60)}`;
      const spec = LOBBY_OPTIONS.find((o) => o.actor === actor && o.trait === trait.key && (o.value === field.key || o.lock === field.key));
      if (!spec || field.nodes.length) {
        note(what);
        continue;
      }
      if (spec.lock === field.key) {
        const on = parseBool(field.value);
        if (on === null) note(what);
        else if (on) lobby.locked.add(spec.option);
        else lobby.locked.delete(spec.option);
        continue;
      }
      const value = spec.parse(field.value);
      if (value === undefined || value === null || !MAP_OPTION_VALUES[spec.option].includes(value)) {
        note(`${what} (${cleanText(field.value, 20)} is not a lobby choice)`);
        continue;
      }
      lobby.options[spec.option] = value;
    }
  }
}

/**
 * The map's setting of every key ("Trait.Field") per actor id, with those
 * an actor inherits from its parent actor (tables.js INHERITS): OpenRA
 * resolves `Inherits` after merging the map's rules, so changing AFLD
 * changes AFLD.Ukraine too, except the keys AFLD.Ukraine sets itself.
 */
function withInherited(own, actorsById) {
  const inherits = new Map(Object.entries(INHERITS).map(([id, v]) => [id.toLowerCase(), v]));
  const resolved = new Map();
  const resolve = (id, depth = 0) => {
    const key = id.toLowerCase();
    if (resolved.has(key)) return resolved.get(key);
    const out = new Map();
    const link = inherits.get(key);
    if (link && depth < 8) {
      const [parent, ownKeys] = link;
      const parentEntry = actorsById.get(parent.toLowerCase());
      for (const [k, v] of resolve(parent, depth + 1)) {
        const trait = k.slice(0, k.indexOf('.'));
        if (ownKeys.includes(k) || ownKeys.includes(`-${trait}`)) continue;
        out.set(k, { ...v, from: v.from ?? parentEntry?.id ?? parent });
      }
    }
    for (const [k, v] of own.get(key) ?? []) out.set(k, v);
    resolved.set(key, out);
    return out;
  };
  // The map's actors in its order, then those that only inherit a change.
  const result = new Map();
  for (const key of [...own.keys(), ...actorsById.keys()]) {
    const entry = actorsById.get(key);
    const s = resolve(key);
    if (s.size && !result.has(entry.id)) result.set(entry.id, s);
  }
  return result;
}

/**
 * Translate the map's Rules and Weapons into WebRA rules overrides, and the
 * lobby options its World and Player rules set into `lobby`. Values with a
 * WebRA rules field (and a built-in value of the same type) are kept;
 * everything else is listed as unsupported.
 */
function translateRules(yaml, yamlFile, base, report, lobby) {
  const out = { actors: {}, weapons: {} };
  const unsupported = new Map();
  const note = (what) => bump(unsupported, what);
  const actorsById = new Map(base.actors.map((a) => [String(a.id).toLowerCase(), a]));
  const weaponsByName = new Map(base.weapons.map((w) => [String(w.name).toLowerCase(), w]));

  // The map's "Trait.Field" values per actor; a later duplicate wins, as
  // OpenRA's MiniYaml merges duplicate keys of one file.
  const own = new Map();
  for (const top of collectNodes(yaml, 'Rules', yamlFile, report)) {
    const id = top.key;
    if (top.nodes.some((t) => /^LuaScript(@|$)/.test(t.key))) report.luaInRules = true;
    if (/^(world|player)$/i.test(id)) {
      lobbyOptionFields(id.toLowerCase(), top, lobby, note);
      continue;
    }
    const entry = actorsById.get(id.toLowerCase());
    if (!entry || id.startsWith('^') || id.startsWith('-')) {
      note(`${cleanText(id, 40)} (${entry ? 'removal or template' : 'not a WebRA actor'})`);
      continue;
    }
    const settings = own.get(entry.id.toLowerCase()) ?? new Map();
    own.set(entry.id.toLowerCase(), settings);
    for (const trait of top.nodes) {
      if (trait.key.startsWith('-') || trait.key.startsWith('Inherits')) {
        note(`${entry.id}.${cleanText(trait.key, 40)}`);
        continue;
      }
      if (!trait.nodes.length) note(`${entry.id}.${cleanText(trait.key, 40)}`);
      for (const field of trait.nodes) {
        const key = `${trait.key}.${field.key}`;
        settings.delete(key);
        settings.set(key, { raw: field.value });
      }
    }
  }

  for (const [id, settings] of withInherited(own, actorsById)) {
    const entry = actorsById.get(id.toLowerCase());
    // Build duration follows cost in OpenRA unless BuildDuration is set.
    let cost;
    let buildDuration;
    let durationModifier;
    let powers = null;
    for (const [rawKey, { raw, from }] of settings) {
      const dot = rawKey.indexOf('.');
      const traitKey = rawKey.slice(0, dot);
      const fieldKey = rawKey.slice(dot + 1);
      const traitName = traitKey.split('@')[0];
      const via = from ? ` (inherited from ${from})` : '';
      if (traitName === 'Buildable' && fieldKey === 'BuildDuration') {
        buildDuration = parseInteger(raw);
        continue;
      }
      if (traitName === 'Buildable' && fieldKey === 'BuildDurationModifier') {
        durationModifier = parseInteger(raw);
        continue;
      }
      const builtInPowers = entry.abilities?.support_powers;
      const index = Array.isArray(builtInPowers) ? builtInPowers.findIndex((p) => p?.key === traitKey) : -1;
      if (index >= 0) {
        const spec = SUPPORT_POWER_FIELDS[fieldKey];
        const value = spec ? parseField(spec, raw) : undefined;
        if (!spec || value === undefined) {
          note(`${entry.id}.${cleanText(rawKey, 60)}`);
          continue;
        }
        powers ??= structuredClone(builtInPowers);
        powers[index][spec.field] = value;
        const name = builtInPowers[index].name || traitKey;
        const shown = Array.isArray(value) ? value.join(', ') || 'none' : value;
        const time = spec.field === 'charge' ? ` ticks (${name} charges in ${ticksToTime(value)} at normal speed)` : ` (${name})`;
        report.rules.applied.push({ section: 'actors', id: entry.id, field: 'abilities', text: `${entry.id} ${rawKey}: ${shown}${time}${via}` });
        continue;
      }
      const key = `${traitKey.includes('@') && traitName !== 'Buildable' ? traitKey : traitName}.${fieldKey}`;
      const spec = ACTOR_FIELDS[key];
      const builtIn = spec ? getIn(entry, spec.path) : undefined;
      const value = spec ? parseField(spec, raw) : undefined;
      if (!spec || builtIn === undefined || builtIn === null || value === undefined || Array.isArray(builtIn) !== Array.isArray(value)) {
        note(`${entry.id}.${cleanText(key, 60)}`);
        continue;
      }
      const patch = (out.actors[entry.id] ??= {});
      setIn(patch, spec.path, value);
      if (key === 'Valued.Cost') cost = value;
      report.rules.applied.push({ section: 'actors', id: entry.id, field: spec.path[0], text: `${entry.id} ${key}: ${Array.isArray(value) ? value.join(', ') : value}${via}` });
    }
    if (powers) setIn((out.actors[entry.id] ??= {}), ['abilities', 'support_powers'], powers);
    if ((cost !== undefined || buildDuration != null || durationModifier != null) && typeof entry.build_ticks === 'number') {
      const baseCost = typeof entry.cost === 'number' ? entry.cost : 0;
      const modifier = durationModifier ?? (baseCost > 0 ? Math.round((entry.build_ticks * 100) / baseCost) : 60);
      const duration = buildDuration != null && buildDuration >= 0 ? buildDuration : (cost ?? baseCost);
      const ticks = Math.floor((duration * modifier) / 100);
      if (Number.isSafeInteger(ticks) && ticks >= 0 && ticks <= INT32 && ticks !== entry.build_ticks) {
        (out.actors[entry.id] ??= {}).build_ticks = ticks;
        report.rules.applied.push({ section: 'actors', id: entry.id, field: 'build_ticks', text: `${entry.id} build time: ${ticks} ticks` });
      }
    }
  }

  for (const top of collectNodes(yaml, 'Weapons', yamlFile, report)) {
    const w = weaponsByName.get(top.key.toLowerCase());
    if (!w || top.key.startsWith('^') || top.key.startsWith('-')) {
      note(`weapon ${cleanText(top.key, 40)} (${w ? 'removal or template' : 'not a WebRA weapon'})`);
      continue;
    }
    const fields = [];
    for (const n of top.nodes) {
      if (n.key === 'Projectile') for (const p of n.nodes) fields.push([`Projectile.${p.key}`, p.value]);
      else if (/^Warhead(@|$)/.test(n.key)) {
        const dmg = child(n.nodes, 'Damage');
        // A single damage warhead maps onto WebRA's single warhead; the array is replaced whole.
        const dmgWarheads = (w.warheads ?? []).filter((h) => h && typeof h.damage === 'number');
        const value = dmg ? parseInteger(dmg.value) : null;
        if (dmg && n.nodes.length === 1 && w.warheads?.length === 1 && dmgWarheads.length === 1 && value !== null && Math.abs(value) <= INT32) {
          const patch = (out.weapons[w.name] ??= {});
          patch.warheads = [{ ...w.warheads[0], damage: value }];
          report.rules.applied.push({ section: 'weapons', id: w.name, field: 'warheads', text: `weapon ${w.name} damage: ${value}` });
        } else {
          note(`weapon ${w.name}.${cleanText(n.key, 40)}`);
        }
      } else fields.push([n.key, n.value, n.nodes.length > 0]);
    }
    for (const [key, raw, nested] of fields) {
      const spec = WEAPON_FIELDS[key];
      const builtIn = spec ? getIn(w, spec.path) : undefined;
      const value = spec && !nested ? parseField(spec, raw) : undefined;
      if (!spec || typeof builtIn !== 'number' || value === undefined) {
        note(`weapon ${w.name}.${cleanText(key, 60)}`);
        continue;
      }
      setIn((out.weapons[w.name] ??= {}), spec.path, value);
      report.rules.applied.push({ section: 'weapons', id: w.name, field: spec.path[0], text: `weapon ${w.name} ${key}: ${value}` });
    }
  }

  if (unsupported.size) {
    report.unsupported.push(`Rules WebRA cannot apply (ignored): ${countList(unsupported, 20)}.`);
  }
  if (!Object.keys(out.weapons).length) delete out.weapons;
  if (!Object.keys(out.actors).length) delete out.actors;
  return Object.keys(out).length ? out : null;
}

/**
 * The map's lobby options from its rules (`lobby` of translateRules): a
 * locked option the map does not set keeps OpenRA's default, as OpenRA's
 * lobby does. Returns `{ options, lockedOptions }` in the lobby's order.
 */
function lobbySetup(lobby, report) {
  const options = {};
  const lockedOptions = [];
  for (const key of MAP_OPTION_KEYS) {
    const spec = LOBBY_OPTIONS.find((o) => o.option === key);
    if (!spec) continue;
    const locked = lobby.locked.has(key);
    if (Object.hasOwn(lobby.options, key)) options[key] = lobby.options[key];
    else if (locked) options[key] = spec.openra;
    else continue;
    if (locked) lockedOptions.push(key);
  }
  const shown = Object.entries(options).map(([k, v]) => {
    const value = typeof v === 'boolean' ? (v ? 'on' : 'off') : k === 'timeLimit' ? (v ? `${v} minutes` : 'none') : String(v);
    return `${LOBBY_OPTION_LABELS[k]} ${value}${lockedOptions.includes(k) ? ' (locked)' : ''}`;
  });
  if (shown.length) report.converted.push(`Lobby options from the map's rules: ${shown.join(', ')}.`);
  return { options, lockedOptions };
}

/**
 * Drop rules overrides the engine refuses, one field at a time. `validate`
 * is the engine's `Game.validate_map` (parsed): a field stays when the map
 * with only that override has no errors the map without rules lacks.
 * Updates the map and report in place.
 */
export function vetRules(map, report, validate, maxChecks = 200) {
  if (!map.rules || typeof validate !== 'function') return;
  const without = { ...map, rules: null };
  const baseline = new Set(validate(JSON.stringify(without)).errors ?? []);
  const full = validate(JSON.stringify(map));
  if (!(full.errors ?? []).some((e) => !baseline.has(e))) return;
  const kept = {};
  let checks = 0;
  for (const [section, entries] of Object.entries(map.rules)) {
    for (const [id, patch] of Object.entries(entries)) {
      for (const [field, value] of Object.entries(patch)) {
        const single = { [section]: { [id]: { [field]: value } } };
        const v = checks++ < maxChecks ? validate(JSON.stringify({ ...map, rules: single })) : { errors: ['too many rules to check'] };
        const extra = (v.errors ?? []).filter((e) => !baseline.has(e));
        if (extra.length) {
          report.rules.rejected.push(`${section === 'weapons' ? 'weapon ' : ''}${id} ${field}: ${cleanText(extra[0], 160)}`);
          report.rules.applied = report.rules.applied.filter((a) => !(a.section === section && a.id === id && a.field === field));
        } else {
          ((kept[section] ??= {})[id] ??= {})[field] = value;
        }
      }
    }
  }
  map.rules = Object.keys(kept).length ? kept : null;
  report.modded = map.rules !== null;
}

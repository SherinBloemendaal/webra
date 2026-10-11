// What the map lens shows: a map as a game on it starts, read once from an
// engine preview and kept as plain data (the engine game is freed at once).
//
// - The world: Game.editor_preview of a map file (its actors, the trees of
//   tree terrain and the bridges, nobody playing; spawn k's actors are
//   player k, neutral ones player 8), or for a mission Game.from_mission
//   (the mission's actors after WorldLoaded). Everything is visible, like
//   the preview (the spectator view, no fog).
// - The art: the same as a game on the map (js/gameart.js): the sprite
//   atlas of the rules' actors and the terrain tiles of the map's biome,
//   from installed content (texture packs, the original Red Alert graphics
//   when chosen) or WebRA's own. Atlases are shared between lenses and kept
//   for the last few rule sets and biomes; a content change (install,
//   Graphics setting, pack order) drops them and tells the lenses.

import { applyGameArt, artActors, buildGameAtlas } from '../gameart.js';
import { buildTerrainAtlas, cellTiles, terrainSeed } from '../art/terrain.js';
import { NEUTRAL_COLOR, TEAM_PALETTE } from '../renderer.js';
import { OBSERVER_VIEW } from '../observer.js';
import { CELL_PX, SPRITE_FLOATS, TerrainRaster } from './raster.js';

/** Team slot of the neutral player in an editor preview (engine world.rs EDITOR_SLOTS). */
export const PREVIEW_NEUTRAL = 8;
/** Team colours of a preview: the lobby palette for spawns 1 to 8, then the neutral player. */
export const PREVIEW_COLORS = Object.freeze([...TEAM_PALETTE, Object.freeze(NEUTRAL_COLOR.slice())]);
/** The shader has 16 team colours (shaders/common.wgsl); players without one draw grey. */
const TEAM_SLOTS = 16;
const GREY = Object.freeze([0.5, 0.5, 0.5]);

/** A colour of a mission file ("FE1100") as 0..1 RGB, or null. */
export function hexColor(text) {
  if (typeof text !== 'string' || !/^[0-9a-f]{6}$/i.test(text)) return null;
  const v = parseInt(text, 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

/** 16 team colours: `colors` where given, else the preview palette, else grey. */
export function teamColors(colors = []) {
  const out = [];
  for (let k = 0; k < TEAM_SLOTS; k++) out.push((colors[k] ?? PREVIEW_COLORS[k] ?? GREY).slice(0, 3));
  return out;
}

export class LensArt {
  /**
   * @param {object} o
   * @param {object} o.Game the engine's Game class
   * @param {() => WebAssembly.Memory} o.memory the engine's memory
   * @param {import('../content/index.js').ContentSystem | null} [o.content] installed content (null: WebRA art)
   * @param {number} [o.atlases] sprite atlases kept (one per rule set and biome)
   */
  constructor({ Game, memory, content = null, atlases = 2 }) {
    this.Game = Game;
    this.memory = memory;
    this.content = content;
    this.maxAtlases = Math.max(1, atlases);
    /** Sprite atlases by rule set and biome, oldest first. */
    this.atlases = new Map();
    /** WebRA terrain atlases by biome (small: 16 x 6 tiles). */
    this.terrainAtlases = new Map();
    /** Bumped by every content change; lens maps of an older version are rebuilt. */
    this.version = 0;
    this.listeners = new Set();
    this.content?.onChange?.(() => this.changed());
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  changed() {
    this.version++;
    this.atlases.clear();
    for (const fn of this.listeners) fn();
  }

  /**
   * Let go of everything (a game starts and needs the memory): the atlases
   * and, through the listeners, the lenses' maps and tiles. The next hover
   * reads its map again.
   */
  release() {
    this.terrainAtlases.clear();
    this.changed();
  }

  /** A map file (JSON text). `colors`: team colours by spawn (the lobby's players). */
  fromMap(json, { colors } = {}) {
    const map = JSON.parse(json);
    return this.build(this.Game.editor_preview(json), { biome: map.biome, spawns: map.spawns, colors });
  }

  /** A generated map, exactly as a game with these lobby options gets it. */
  fromGenerated({ seed, size, players, style = 'random', biome = 'random', tech = 'standard', colors }) {
    return this.fromMap(this.Game.generated_map_with(seed, size, players, style, biome, tech), { colors });
  }

  /** A mission file (JSON text): its map with the mission's actors, in the mission's colours. */
  fromMission(text) {
    const game = this.Game.from_mission(text, JSON.stringify({ seed: 1 }));
    let colors = [];
    try {
      colors = (JSON.parse(game.mission_state())?.players ?? []).map((p) => hexColor(p.color));
    } catch (err) {
      game.free?.();
      throw err;
    }
    return this.build(game, { biome: JSON.parse(text).map?.biome, spawns: [], colors });
  }

  /** The sprite atlas for `actors` on `biome`, shared and kept for the last few. */
  spriteAtlas(actors, biome) {
    const key = `${biome}\n${JSON.stringify(actors)}`;
    let entry = this.atlases.get(key);
    if (entry) {
      this.atlases.delete(key);
    } else {
      entry = buildGameAtlas(this.content, actors, biome);
      while (this.atlases.size >= this.maxAtlases) this.atlases.delete(this.atlases.keys().next().value);
    }
    this.atlases.set(key, entry);
    return entry;
  }

  /** Terrain tiles for the engine terrain bytes: installed ones, else WebRA's. */
  tiles(biome, terrain, w, h) {
    const installed = this.content?.terrain(biome, terrain, w, h) ?? null;
    if (installed) return { atlas: installed.atlas, cells: installed.cells, source: installed.source ?? 'installed' };
    let atlas = this.terrainAtlases.get(biome);
    if (!atlas) {
      atlas = buildTerrainAtlas(biome);
      this.terrainAtlases.set(biome, atlas);
    }
    return { atlas, cells: cellTiles(terrain, w, h, terrainSeed(terrain)), source: 'webra' };
  }

  /** Read everything the lens needs from an engine game, then free it. */
  build(game, { biome, spawns = [], colors = [] }) {
    try {
      const b = biome === 'snow' || biome === 'desert' ? biome : 'temperate';
      const width = game.map_width();
      const height = game.map_height();
      const actors = artActors(JSON.parse(game.rules_json()).actors);
      const { atlas, original } = this.spriteAtlas(actors, b);
      applyGameArt(game, atlas, original);
      const terrain = new Uint8Array(this.memory().buffer, game.terrain_ptr(), game.terrain_len()).slice();
      const n = game.build_render(OBSERVER_VIEW, 1, 0, 0, width * CELL_PX, height * CELL_PX);
      const sprites = new Float32Array(this.memory().buffer, game.sprite_ptr(), n * SPRITE_FLOATS).slice();
      const tiles = this.tiles(b, terrain, width, height);
      return {
        width,
        height,
        biome: b,
        version: this.version,
        terrain: new TerrainRaster({ width, height, terrain, cells: tiles.cells, atlas: tiles.atlas }),
        /** 'webra', 'original' or the texture pack's name. */
        terrainSource: tiles.source,
        /** Whether the terrain is pixel art (drawn without smoothing). */
        terrainPixelArt: tiles.atlas.filter === 'nearest',
        sprites,
        atlas,
        /** 'installed' when installed graphics (original or a pack) draw sprites, else 'webra'. */
        spriteSource: atlas.filter === 'nearest' ? 'installed' : 'webra',
        colors: teamColors(colors),
        spawns: Array.isArray(spawns) ? spawns.filter((s) => Array.isArray(s) && s.length >= 2).map(([x, y]) => [x, y]) : [],
      };
    } finally {
      game.free?.();
    }
  }
}

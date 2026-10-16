// The map lens's software renderer: the terrain shader (shaders/terrain.wgsl)
// and the sprite shader's frame choice (shaders/sprite.wgsl) in plain
// JavaScript, so a map preview can show the real map in a 2D canvas without
// a WebGPU context of its own. It draws what a game on the map shows at its
// first frame: the render clock stopped at 0 (no animation, the water's
// colours at their first step), clear weather, nothing under fog.
//
// The terrain is computed per pixel into RGBA bytes, a block of cells at a
// time, and can stop after any pixel row (js/maplens/lens.js spreads a block
// over frames). Pure module: no DOM, so Node tests run it.

import { TILES } from '../art/terrain.js';
import {
  ART_GEMS,
  ART_ORE,
  ART_SMUDGES,
  ART_TILES,
  ART_WATER_ROTATION,
  ATLAS_COLS,
  GEM_LEVELS,
  GEM_TILE_BASE,
  GEM_VARIANTS,
  ORE_LEVELS,
  ORE_TILE_BASE,
  ORE_VARIANTS,
  SMUDGE_DEPTHS,
  SMUDGE_TILE_BASE,
  SMUDGE_VARIANTS,
  WATER_ALPHA,
  WATER_COLORS,
} from '../content/terrain.js';
import { FRAME_FLOATS } from '../sprites.js';
import { MODE, facingFrame, leadFrame, onceFrame, unpackSprite } from '../content/sequences.js';

/** World pixels per cell (engine render.rs PX_PER_CELL, shaders/common.wgsl CELL_PX). */
export const CELL_PX = 24;
/** Floats per sprite instance (engine render.rs SPRITE_FLOATS): x, y, angle, sprite, team, scale, alpha, flash. */
export const SPRITE_FLOATS = 8;
/** The terrain texture's alpha without a smudge (shaders/terrain.wgsl NO_SMUDGE). */
const NO_SMUDGE = 255;
const OFF_MAP = 99;

const fract = (v) => v - Math.floor(v);
const mix = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** shaders/common.wgsl hash2: 0..1 from a 2D point. */
export function hash2(x, y) {
  let qx = fract(x * 123.34);
  let qy = fract(y * 456.21);
  const d = qx * (qx + 45.32) + qy * (qy + 45.32);
  qx += d;
  qy += d;
  return fract(qx * qy);
}

/** shaders/common.wgsl vnoise: smooth value noise, 0..1, one lattice step per unit. */
export function vnoise(x, y) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy);
  const b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1);
  const d = hash2(ix + 1, iy + 1);
  return mix(mix(a, b, ux), mix(c, d, ux), uy);
}

/**
 * The terrain of one map as the terrain shader draws it.
 *
 * `terrain` is the engine's terrain bytes (Game.terrain_ptr: R type, G ore,
 * B gems, A smudge), `cells` the tile layer (js/art/terrain.js cellTiles, or
 * the installed tiles of js/content: tile R + 256 G), `atlas` the tile atlas
 * ({ width, height, data, flags?, filter? }: ATLAS_COLS square tiles to a
 * row, sampled like the renderer's sampler: nearest for pixel art, else
 * bilinear inside the tile).
 */
export class TerrainRaster {
  constructor({ width, height, terrain, cells, atlas }) {
    if (terrain.length !== width * height * 4 || cells.length !== width * height * 4) throw new Error('terrain and cell layers must have 4 bytes per cell');
    this.width = width;
    this.height = height;
    this.terrain = terrain;
    this.cells = cells;
    this.atlas = atlas;
    this.flags = atlas.flags ?? 0;
    this.nearest = atlas.filter === 'nearest';
    this.tileSize = atlas.width / ATLAS_COLS;
    /** The last atlas sample, 0..1 RGBA. */
    this.s = new Float64Array(4);
  }

  type(cx, cy) {
    if (cx < 0 || cy < 0 || cx >= this.width || cy >= this.height) return OFF_MAP;
    return this.terrain[(cy * this.width + cx) * 4];
  }

  /** shaders/terrain.wgsl tile_px: tile `tile` at cell-local (lx, ly), into `this.s`. */
  sample(tile, lx, ly) {
    const size = this.tileSize;
    const { width, data } = this.atlas;
    const ox = (tile % ATLAS_COLS) * size;
    const oy = Math.floor(tile / ATLAS_COLS) * size;
    const px = ox + clamp(lx * size, 0.5, size - 0.5);
    const py = oy + clamp(ly * size, 0.5, size - 0.5);
    const s = this.s;
    if (this.nearest) {
      const o = (Math.floor(py) * width + Math.floor(px)) * 4;
      s[0] = data[o] / 255;
      s[1] = data[o + 1] / 255;
      s[2] = data[o + 2] / 255;
      s[3] = data[o + 3] / 255;
      return s;
    }
    const x = px - 0.5;
    const y = py - 0.5;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const x1 = Math.min(x0 + 1, width - 1);
    const y1 = Math.min(y0 + 1, this.atlas.height - 1);
    const a = (y0 * width + x0) * 4;
    const b = (y0 * width + x1) * 4;
    const c = (y1 * width + x0) * 4;
    const d = (y1 * width + x1) * 4;
    for (let k = 0; k < 4; k++) {
      s[k] = mix(mix(data[a + k], data[b + k], fx), mix(data[c + k], data[d + k], fx), fy) / 255;
    }
    return s;
  }

  /** shaders/terrain.wgsl water_color: the k-th rotating water colour at the first step of the clock. */
  waterColor(k, out) {
    const { width, height, data } = this.atlas;
    const o = ((height - 1) * width + (k % WATER_COLORS)) * 4;
    out[0] = data[o] / 255;
    out[1] = data[o + 1] / 255;
    out[2] = data[o + 2] / 255;
  }

  /** shaders/terrain.wgsl water_depth: depth (0 shore, 1 deep) between cell centres; off the map is deep. */
  waterDepth(fx, fy) {
    const px = fx - 0.5;
    const py = fy - 0.5;
    const ix = Math.floor(px);
    const iy = Math.floor(py);
    const tx = px - ix;
    const ty = py - iy;
    const at = (x, y) => (x < 0 || y < 0 || x >= this.width || y >= this.height ? 1 : this.cells[(y * this.width + x) * 4 + 2] / 255);
    return mix(mix(at(ix, iy), at(ix + 1, iy), tx), mix(at(ix, iy + 1), at(ix + 1, iy + 1), tx), ty);
  }

  /**
   * Shade one pixel at world position (wx, wy) (world pixels) into `out`
   * (0..1 RGB): the terrain shader's fragment at render time 0.
   */
  shade(wx, wy, out) {
    const fx = wx / CELL_PX;
    const fy = wy / CELL_PX;
    const cx = Math.floor(fx);
    const cy = Math.floor(fy);
    const t = this.type(cx, cy);
    if (t === OFF_MAP) {
      out[0] = out[1] = out[2] = 0;
      return out;
    }
    const lx = fx - cx;
    const ly = fy - cy;
    const i = (cy * this.width + cx) * 4;
    const cells = this.cells;
    if ((this.flags & ART_TILES) !== 0) return this.tiled(cx, cy, t, lx, ly, wx, wy, cells[i] + 256 * cells[i + 1], out);
    const tile = cells[i];
    const decal = cells[i + 1];
    const shadow = cells[i + 3];
    let s = this.sample(tile, lx, ly);
    let r = s[0];
    let g = s[1];
    let b = s[2];
    const wet = t === 3 || t === 5 || t === 7 || t === 9;
    if (t === 0 || t === 1) {
      // soft_ground: clear and rough fade into each other over a ragged border.
      const wob = (vnoise(wx * 0.25, wy * 0.25) - 0.5) * 0.25;
      for (let k = 0; k < 4; k++) {
        const nx = cx + (k === 1 ? 1 : k === 3 ? -1 : 0);
        const ny = cy + (k === 0 ? -1 : k === 2 ? 1 : 0);
        const nt = this.type(nx, ny);
        if ((nt === 0 || nt === 1) && nt !== t) {
          const dist = k === 0 ? ly : k === 1 ? 1 - lx : k === 2 ? 1 - ly : lx;
          const f = (1 - smoothstep(0, 0.45, dist + wob)) * 0.5;
          if (f > 0) {
            s = this.sample(cells[(ny * this.width + nx) * 4], lx, ly);
            r = mix(r, s[0], f);
            g = mix(g, s[1], f);
            b = mix(b, s[2], f);
          }
        }
      }
    }
    if (!wet) {
      // Broad variation across the map so repeated tiles do not show.
      const v = (0.92 + 0.16 * vnoise(wx / 150, wy / 150)) * (0.97 + 0.06 * vnoise(wx / 37 + 11, wy / 37 + 11));
      r *= v;
      g *= v;
      b *= v;
    }
    if (decal > 0) {
      s = this.sample(TILES.DECAL + decal - 1, lx, ly);
      r = mix(r, s[0], s[3]);
      g = mix(g, s[1], s[3]);
      b = mix(b, s[2], s[3]);
    }
    if (wet) {
      if (t === 3 || t === 9) {
        const k = 1 - this.waterDepth(fx, fy) * 0.35;
        r *= k;
        g *= k;
        b *= k;
      }
      const wave = Math.sin(wx * 0.35 + wy * 0.22) * Math.sin(wy * 0.31);
      const k = 0.97 + 0.04 * wave;
      r *= k;
      g *= k;
      b *= k;
    }
    // Rock casts its shadow down and to the right.
    let sh = 1;
    if ((shadow & 1) !== 0) sh *= 1 - 0.45 * Math.max(0, 1 - ly / 0.45);
    if ((shadow & 2) !== 0) sh *= 1 - 0.4 * Math.max(0, 1 - lx / 0.35);
    if ((shadow & 4) !== 0 && (shadow & 3) === 0) sh *= 1 - 0.35 * Math.max(0, 1 - Math.hypot(lx, ly) / 0.4);
    r *= sh;
    g *= sh;
    b *= sh;
    out[0] = r;
    out[1] = g;
    out[2] = b;
    const ore = this.terrain[i + 1] / 255;
    if (ore > 0) oreColor(out, cx, cy, lx, ly, ore);
    const gems = this.terrain[i + 2] / 255;
    if (gems > 0) gemColor(out, cx, cy, lx, ly, gems);
    const smudge = this.terrain[i + 3];
    if (smudge !== NO_SMUDGE) smudgeColor(out, smudge, cx, cy, lx, ly);
    return out;
  }

  /** shaders/terrain.wgsl tiled: installed tiles as they are, ore and gems from their overlays. */
  tiled(cx, cy, t, lx, ly, wx, wy, tile, out) {
    let s = this.sample(tile, lx, ly);
    out[0] = s[0];
    out[1] = s[1];
    out[2] = s[2];
    const flags = this.flags;
    if ((flags & ART_WATER_ROTATION) !== 0) {
      const a = Math.round(s[3] * 255);
      if (a >= WATER_ALPHA && a < WATER_ALPHA + WATER_COLORS) this.waterColor(a - WATER_ALPHA, out);
    } else if (t === 3 || t === 5 || t === 7 || t === 9) {
      const k = 0.97 + 0.04 * Math.sin(wx * 0.35 + wy * 0.22) * Math.sin(wy * 0.31);
      out[0] *= k;
      out[1] *= k;
      out[2] *= k;
    }
    const i = (cy * this.width + cx) * 4;
    const ore = this.terrain[i + 1] / 255;
    if (ore > 0) {
      if ((flags & ART_ORE) !== 0) {
        s = this.sample(resourceTile(ORE_TILE_BASE, ORE_LEVELS, ORE_VARIANTS, ore, cx, cy), lx, ly);
        blend(out, s[0], s[1], s[2], s[3]);
      } else {
        blend(out, 0.62, 0.45, 0.12, ore * 0.6);
      }
    }
    const gems = this.terrain[i + 2] / 255;
    if (gems > 0) {
      if ((flags & ART_GEMS) !== 0) {
        s = this.sample(resourceTile(GEM_TILE_BASE, GEM_LEVELS, GEM_VARIANTS, gems, cx, cy), lx, ly);
        blend(out, s[0], s[1], s[2], s[3]);
      } else {
        gemColor(out, cx, cy, lx, ly, gems);
      }
    }
    const smudge = this.terrain[i + 3];
    if (smudge !== NO_SMUDGE) {
      if ((flags & ART_SMUDGES) !== 0) {
        const kind = (smudge >> 6) & 1;
        const variant = Math.min((smudge >> 3) & 7, SMUDGE_VARIANTS - 1);
        const depth = Math.min(smudge & 7, SMUDGE_DEPTHS - 1);
        s = this.sample(SMUDGE_TILE_BASE + (kind * SMUDGE_VARIANTS + variant) * SMUDGE_DEPTHS + depth, lx, ly);
        blend(out, s[0], s[1], s[2], s[3]);
      } else {
        smudgeColor(out, smudge, cx, cy, lx, ly);
      }
    }
    return out;
  }

  /**
   * Draw the cells (bx .. bx + cols - 1, by .. by + rows - 1) at `px`
   * pixels per cell into `out` (RGBA bytes, cols * px wide), pixel rows
   * `y0` to `y1` (exclusive) only. Pixels sample at their centres, as the
   * GPU does; at 24 pixels per cell a pixel is a world pixel.
   */
  renderRows(out, bx, by, cols, px, y0, y1) {
    const w = cols * px;
    const unit = CELL_PX / px;
    const rgb = [0, 0, 0];
    for (let y = y0; y < y1; y++) {
      const wy = (by * px + y + 0.5) * unit;
      let o = y * w * 4;
      for (let x = 0; x < w; x++) {
        this.shade((bx * px + x + 0.5) * unit, wy, rgb);
        out[o] = rgb[0] * 255;
        out[o + 1] = rgb[1] * 255;
        out[o + 2] = rgb[2] * 255;
        out[o + 3] = 255;
        o += 4;
      }
    }
    return out;
  }
}

function blend(out, r, g, b, a) {
  out[0] = mix(out[0], r, a);
  out[1] = mix(out[1], g, a);
  out[2] = mix(out[2], b, a);
}

/** shaders/terrain.wgsl resource_tile: the overlay tile of a density (0..1) and the cell's variant. */
export function resourceTile(base, levels, variants, density, cx, cy) {
  const level = Math.min(levels - 1, Math.max(Math.ceil(density * levels), 1) - 1);
  const variant = Math.min(variants - 1, Math.floor(hash2(cx + 3.7, cy + 1.3) * variants));
  return base + variant * levels + level;
}

// Parity with shaders/terrain.wgsl ore_color and gem_color: the same constants and formulas, and the same
// blocks (cell-local, so placement agrees exactly).
const ORE_LIGHT = [1, 0.827, 0.302];
const ORE_BASE = [0.851, 0.588, 0.165];
const ORE_GROUND = [0.478, 0.4, 0.188];
const GEM_HUES = [
  [0.29, 0.549, 0.941],
  [0.91, 0.29, 0.69],
];
const GEM_GLINT = [0.878, 0.973, 1];
const GEM_GROUND = [0.22, 0.2, 0.16];
const RES_BLOCK_A = [0.37, 0.35, 0.34, 0.3];
const RES_BLOCK_B = [0.69, 0.68, 0.28, 0.26];
const RES_SHADOW = 0.08;
const RES_SHADE = 0.75;

/** shaders/terrain.wgsl res_scale: the size of a resource cell's blocks for a density (0..1). */
const resScale = (density) => 0.55 + 0.45 * density;

/** shaders/terrain.wgsl in_res_block: (lx, ly) in block `b` scaled by `s`, mirrored left to right with `flip`. */
function inResBlock(lx, ly, b, s, flip) {
  const cx = flip ? 1 - b[0] : b[0];
  return Math.abs(lx - cx) < b[2] * s * 0.5 && Math.abs(ly - b[1]) < b[3] * s * 0.5;
}

/** shaders/terrain.wgsl res_face: the lower 30 % of the block, its front face. */
const resFace = (ly, b, s) => ly > b[1] + b[3] * s * 0.2;

/** shaders/terrain.wgsl res_glint: the lit top-left corner of the block. */
function resGlint(lx, ly, b, s, flip) {
  const cx = flip ? 1 - b[0] : b[0];
  return lx - (cx - b[2] * s * 0.5) < b[2] * s * 0.3 && ly - (b[1] - b[3] * s * 0.5) < b[3] * s * 0.3;
}

/** The ground under a resource cell's blocks: `base`, darkened where a block casts its shadow. */
function resGround(base, lx, ly, s, flip) {
  const shaded = inResBlock(lx - RES_SHADOW, ly - RES_SHADOW, RES_BLOCK_A, s, flip) || inResBlock(lx - RES_SHADOW, ly - RES_SHADOW, RES_BLOCK_B, s, flip);
  return shaded ? base.map((v) => v * RES_SHADE) : base;
}

/** shaders/terrain.wgsl ore_color: two gold blocks per cell on a dark ochre ground, mirrored in every other cell. */
export function oreColor(out, cx, cy, lx, ly, ore) {
  const k = ore * 0.5;
  const s = resScale(ore);
  const flip = ((cx + cy) & 1) === 1;
  let c = resGround([mix(out[0], ORE_GROUND[0], k), mix(out[1], ORE_GROUND[1], k), mix(out[2], ORE_GROUND[2], k)], lx, ly, s, flip);
  if (inResBlock(lx, ly, RES_BLOCK_A, s, flip)) c = resFace(ly, RES_BLOCK_A, s) ? ORE_BASE : ORE_LIGHT;
  else if (inResBlock(lx, ly, RES_BLOCK_B, s, flip)) c = resFace(ly, RES_BLOCK_B, s) ? ORE_BASE : ORE_LIGHT;
  out[0] = c[0];
  out[1] = c[1];
  out[2] = c[2];
  return out;
}

/** shaders/terrain.wgsl gem_color: a blue and a magenta block per cell over darker ground, a glint in each lit corner. */
export function gemColor(out, cx, cy, lx, ly, gems) {
  const s = resScale(gems);
  const flip = ((cx + cy) & 1) === 1;
  let c = resGround([mix(out[0], GEM_GROUND[0], 0.35), mix(out[1], GEM_GROUND[1], 0.35), mix(out[2], GEM_GROUND[2], 0.35)], lx, ly, s, flip);
  const [hueA, hueB] = flip ? [GEM_HUES[1], GEM_HUES[0]] : GEM_HUES;
  for (const [b, hue] of [[RES_BLOCK_A, hueA], [RES_BLOCK_B, hueB]]) {
    if (!inResBlock(lx, ly, b, s, flip)) continue;
    c = resFace(ly, b, s) ? hue.map((v) => v * 0.7) : hue;
    if (resGlint(lx, ly, b, s, flip)) c = GEM_GLINT;
    break;
  }
  out[0] = c[0];
  out[1] = c[1];
  out[2] = c[2];
  return out;
}

/** shaders/terrain.wgsl smudge_color: WebRA's scorch marks and craters. */
export function smudgeColor(out, s, cx, cy, lx, ly) {
  const crater = ((s >> 6) & 1) === 1;
  const variant = (s >> 3) & 7;
  const depth = s & 7;
  const mx = 0.5 + (hash2(cx + variant, cy + variant) - 0.5) * 0.18;
  const my = 0.5 + (hash2(cx + variant + 7.3, cy + variant + 7.3) - 0.5) * 0.18;
  const wobble = (vnoise((lx + cx) * 6 + variant * 3.1, (ly + cy) * 6 + variant * 3.1) - 0.5) * 0.12;
  const d = Math.hypot(lx - mx, ly - my) + wobble;
  const r = 0.2 + 0.035 * depth;
  if (crater) {
    if (d < r) blend(out, 0.12, 0.1, 0.08, 0.55 + 0.05 * depth);
    else if (d < r + 0.07) blend(out, 0.55, 0.5, 0.42, 0.35);
    return out;
  }
  blend(out, 0.08, 0.07, 0.06, (1 - smoothstep(r * 0.6, r + 0.12, d)) * (0.6 + 0.05 * depth));
  return out;
}

// ---- Sprites ---------------------------------------------------------------------------

/**
 * What the sprite shader draws for instance `k` of `sprites` (8 floats each)
 * with the render clock stopped at 0: the atlas frame, the rotation left on
 * it (radians, clockwise) and whether it is hidden (a finished VANISH pose).
 */
export function spriteFrame(frames, sprites, k) {
  const at = (i) => frames.subarray(i * FRAME_FLOATS, (i + 1) * FRAME_FLOATS);
  const angle = sprites[k * SPRITE_FLOATS + 2];
  const { slot, pose, age } = unpackSprite(sprites[k * SPRITE_FLOATS + 3]);
  const head = at(slot);
  if (head[13] > 0.5) {
    const base = head[12];
    let d = at(base + Math.min(pose, head[13] - 1));
    let mode = d[11];
    let f = 0;
    let hidden = false;
    if (mode === MODE.ONCE || mode === MODE.VANISH) {
      const count = Math.max(d[9], 1);
      const once = onceFrame(age, d[10]);
      if (once < count) {
        f = once;
      } else if (mode === MODE.VANISH) {
        hidden = true;
        f = count - 1;
      } else {
        // Finished: the idle pose takes over.
        d = at(base);
        mode = d[11];
      }
    }
    const length = Math.max(d[9], 1);
    if (mode === MODE.LOOP || mode === MODE.STILL) f = 0;
    else if (mode === MODE.INDEX) f = Math.min(age, length - 1);
    else if (mode === MODE.LEAD) f = leadFrame(age, 0, false, d[10], length, d[15], 0);
    const desc = { facings: Math.max(1, d[12]), classic: (d[13] & 1) !== 0, rotate: (d[13] & 2) !== 0, interpolatedFacings: d[14] };
    const { facing, rotation } = facingFrame(angle, desc);
    return { index: d[8] + facing * length + f, rotation, hidden };
  }
  // The head of a WebRA animation shows its first frame while the clock stands.
  return { index: head[9] > 1.5 ? head[8] : slot, rotation: angle, hidden: false };
}

/**
 * The quad of atlas frame `index` for an instance: its source rectangle in
 * atlas pixels (sx, sy, sw, sh) and where it lands around the instance
 * position before rotation, in world pixels (dx, dy, dw, dh), and the radius
 * that holds it at any rotation. Null for an empty frame.
 */
export function frameQuad(frames, index, atlasWidth, atlasHeight, scale = 1) {
  const f = frames.subarray(index * FRAME_FLOATS, (index + 1) * FRAME_FLOATS);
  const sx = Math.round(f[0] * atlasWidth);
  const sy = Math.round(f[1] * atlasHeight);
  const sw = Math.round(f[2] * atlasWidth) - sx;
  const sh = Math.round(f[3] * atlasHeight) - sy;
  if (sw <= 0 || sh <= 0 || f[4] <= 0 || f[5] <= 0) return null;
  const dw = f[4] * scale;
  const dh = f[5] * scale;
  const dx = (f[6] - f[4] / 2) * scale;
  const dy = (f[7] - f[5] / 2) * scale;
  const radius = Math.max(Math.hypot(dx, dy), Math.hypot(dx + dw, dy), Math.hypot(dx, dy + dh), Math.hypot(dx + dw, dy + dh));
  return { sx, sy, sw, sh, dx, dy, dw, dh, radius };
}

/**
 * The sprite shader's colours for a frame's pixels (RGBA bytes, unpremultiplied):
 * team areas (grey in the colour atlas, where the mask says) take
 * `team` (0..1 RGB) shaded by their grey level; flash > 0 whitens, flash < 0
 * draws solid black (aircraft shadows). Alpha stays the atlas's.
 */
export function tintPixels(color, mask, team, flash = 0) {
  const out = new Uint8ClampedArray(color.length);
  for (let o = 0; o < color.length; o += 4) {
    const a = color[o + 3];
    out[o + 3] = a;
    if (a === 0) continue;
    if (flash < 0) continue;
    const m = mask[o] / 255;
    const shade = 0.35 + (color[o] / 255) * 1.05;
    for (let c = 0; c < 3; c++) {
      const base = color[o + c] / 255;
      let v = base + (team[c] * shade - base) * m;
      if (flash > 0) v = mix(v, 1, flash * 0.55);
      out[o + c] = Math.round(clamp(v, 0, 1) * 255);
    }
  }
  return out;
}

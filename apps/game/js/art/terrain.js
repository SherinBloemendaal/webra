// Terrain tiles: one pre-rendered atlas per biome, drawn once at game start,
// and a per-cell tile layer that picks the tile, a decal and the water depth
// for every map cell. The terrain shader (shaders/terrain.wgsl) only samples
// these two textures, so a frame costs one texture lookup or two per pixel.
//
// The look follows Red Alert / OpenRA: rock is a raised plateau (lit rim on
// the top and left edges, cliff faces with strata on the bottom and right
// edges, shadow cast to the lower right), water deepens away from the shore
// with foam on its edges, and ground has texture and scattered decals
// (stones, craters, shrubs, tracks). The light comes from the top left, like
// the building art. The style is the design canvas's flat 1996 look ("Terrein
// per biome", "Materialen en kleuren"): solid colours from PALETTES and one
// pattern layer per tile (specks, streaks, cracks, bands), patterns that
// repeat every tile so neighbouring cells join without seams.
//
// Pure module: pixels are computed into a Uint8ClampedArray (RGBA), so it runs
// and is tested under Node without a canvas.

/** Tile size in atlas pixels (a cell is 24 world pixels; tiles are oversampled). */
export const TILE = 32;
/** Tiles per atlas row. */
export const ATLAS_COLS = 16;

/** Engine terrain values (engine/src/map.rs Terrain). */
export const T = Object.freeze({ CLEAR: 0, ROUGH: 1, ROCK: 2, WATER: 3, TREE: 4, FORD: 5, ROAD: 6, BRIDGE: 7, BEACH: 8, RIVER: 9, WALL: 10 });

/** Tile indices in the atlas. Masks: bit 1 north, 2 east, 4 south, 8 west. */
export const TILES = Object.freeze({
  CLEAR: 0, // 4 variants
  ROUGH: 4, // 4 variants
  ROCK: 8, // 16 masks: neighbour is rock too
  WATER: 24, // 16 masks: neighbour is water or ford (or off the map)
  FORD: 40, // 16 masks: neighbour is water or ford
  TREE: 56, // 4 variants
  DECAL: 60, // 8 decal overlays (transparent)
  ROAD: 68, // 16 masks: neighbour is road or bridge
  BEACH: 84, // 4 variants
  COUNT: 88,
});
export const DECALS = 8;
export const BIOMES = ['temperate', 'snow', 'desert'];

/** Shadow bits of the cell layer: rock to the north, west and north-west. */
export const SHADOW = Object.freeze({ N: 1, W: 2, NW: 4 });

// ---- Palettes ------------------------------------------------------------------------

const PALETTES = {
  temperate: {
    ground: [[52, 78, 36], [72, 98, 46]],
    rough: [[86, 82, 50], [106, 98, 60]],
    rockTop: [[118, 108, 92], [150, 140, 120]],
    rockFace: [[72, 64, 52], [98, 88, 72]],
    rim: [196, 186, 160],
    deep: [24, 52, 82],
    shallow: [52, 100, 112],
    foam: [222, 236, 236],
    ford: [[92, 108, 92], [118, 128, 104]],
    tree: [[22, 52, 20], [52, 96, 36]],
    trunk: [70, 50, 32],
    stone: [128, 122, 110],
    shrub: [[34, 70, 26], [60, 104, 40]],
    track: [60, 56, 38],
    accent: [210, 196, 90], // flowers
    road: [[104, 92, 66], [128, 114, 82]], // packed dirt
    sand: [[176, 160, 112], [204, 188, 136]],
  },
  snow: {
    ground: [[214, 222, 230], [240, 244, 250]],
    rough: [[150, 192, 220], [190, 222, 240]], // ice
    rockTop: [[96, 98, 108], [128, 130, 140]],
    rockFace: [[58, 60, 70], [80, 82, 94]],
    rim: [244, 248, 255], // snow cap
    deep: [20, 42, 72],
    shallow: [70, 110, 140],
    foam: [236, 246, 255],
    ford: [[128, 156, 176], [164, 190, 206]],
    tree: [[22, 52, 44], [44, 84, 66]],
    trunk: [64, 48, 36],
    stone: [104, 108, 118],
    shrub: [[92, 80, 64], [122, 106, 84]], // dead brush
    track: [176, 186, 200],
    accent: [180, 214, 236], // ice crack highlight
    road: [[150, 152, 156], [176, 178, 184]], // trodden snow over gravel
    sand: [[168, 172, 172], [196, 200, 200]], // frozen shingle
  },
  desert: {
    ground: [[188, 150, 96], [214, 178, 118]],
    rough: [[204, 166, 104], [232, 196, 134]], // dunes
    rockTop: [[160, 104, 66], [192, 132, 86]],
    rockFace: [[96, 58, 36], [128, 80, 50]],
    rim: [226, 176, 124],
    deep: [20, 84, 98],
    shallow: [52, 142, 146],
    foam: [228, 236, 214],
    ford: [[140, 140, 104], [170, 162, 118]],
    tree: [[52, 104, 46], [86, 140, 62]], // cactus
    trunk: [112, 80, 46], // palm trunk
    stone: [150, 112, 80],
    shrub: [[124, 110, 62], [160, 140, 80]], // dry brush
    track: [156, 120, 76],
    accent: [232, 226, 206], // bones
    road: [[150, 112, 72], [172, 132, 86]], // hardpack
    sand: [[220, 196, 140], [240, 220, 166]],
  },
};

export function palette(biome) {
  return PALETTES[biome] ?? PALETTES.temperate;
}

// ---- Deterministic noise -------------------------------------------------------------

/** 32-bit integer hash of up to three integers, 0..1. */
export function hash3(a, b, c = 0) {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise on a lattice of `scale` pixels, 0..1. Tiles every `wrap` lattice steps. */
function vnoise(x, y, scale, seed, wrap = 1 << 16) {
  const fx = x / scale;
  const fy = y / scale;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const h = (i, j) => hash3(((i % wrap) + wrap) % wrap, ((j % wrap) + wrap) % wrap, seed);
  const a = h(x0, y0);
  const b = h(x0 + 1, y0);
  const c = h(x0, y0 + 1);
  const d = h(x0 + 1, y0 + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

const mixRgb = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const scale = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mod = (v, m) => ((v % m) + m) % m;
const SHADOW_RGB = [0, 0, 0];

// ---- Tile canvas ---------------------------------------------------------------------

/** A TILE x TILE RGBA tile with small drawing helpers (all coordinates in tile pixels). */
class Tile {
  constructor() {
    this.px = new Float32Array(TILE * TILE * 4);
  }

  set(x, y, rgb, a = 1) {
    if (x < 0 || y < 0 || x >= TILE || y >= TILE) return;
    const o = (y * TILE + x) * 4;
    this.px[o] = rgb[0];
    this.px[o + 1] = rgb[1];
    this.px[o + 2] = rgb[2];
    this.px[o + 3] = a;
  }

  /** Fill the whole tile with one opaque colour. */
  fill(rgb) {
    for (let o = 0; o < this.px.length; o += 4) {
      this.px[o] = rgb[0];
      this.px[o + 1] = rgb[1];
      this.px[o + 2] = rgb[2];
      this.px[o + 3] = 1;
    }
  }

  /** Alpha-blend a colour over the pixel. */
  blend(x, y, rgb, a) {
    if (x < 0 || y < 0 || x >= TILE || y >= TILE || a <= 0) return;
    const o = (y * TILE + x) * 4;
    const ia = this.px[o + 3];
    const oa = a + ia * (1 - a);
    for (let k = 0; k < 3; k++) {
      this.px[o + k] = oa > 0 ? (rgb[k] * a + this.px[o + k] * ia * (1 - a)) / oa : 0;
    }
    this.px[o + 3] = oa;
  }

  /** Multiply the pixel's colour (shading). */
  shade(x, y, k) {
    if (x < 0 || y < 0 || x >= TILE || y >= TILE) return;
    const o = (y * TILE + x) * 4;
    for (let c = 0; c < 3; c++) this.px[o + c] *= k;
  }

  /**
   * A flat disc with a one pixel soft edge: `fn(dx, dy, d)` returns [rgb, alpha]
   * or null per covered pixel (dx, dy relative to the radius).
   */
  disk(cx, cy, r, fn) {
    for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y++) {
      for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        const d = Math.hypot(dx, dy) / r;
        if (d > 1) continue;
        const out = fn(dx / r, dy / r, d);
        if (out) this.blend(x, y, out[0], out[1] * clamp01((1 - d) * r));
      }
    }
  }

  /** A flat disc of one colour. */
  dot(cx, cy, r, rgb, a = 1) {
    this.disk(cx, cy, r, () => [rgb, a]);
  }
}

/**
 * Scatter `n` specks of `rgb` (one pixel, or two side by side) at seeded
 * spots, kept a pixel inside the tile so no speck is cut at a cell edge.
 */
function specks(t, n, seed, rgb, wide = 0.5) {
  for (let k = 0; k < n; k++) {
    const x = 1 + Math.floor(hash3(k, seed, 1) * (TILE - 3));
    const y = 1 + Math.floor(hash3(k, seed, 2) * (TILE - 2));
    t.set(x, y, rgb);
    if (hash3(k, seed, 3) < wide) t.set(x + 1, y, rgb);
  }
}

/** Value noise that repeats every tile (lattice `step` pixels, a divisor of TILE), 0..1. */
const tnoise = (x, y, step, seed) => vnoise(x, y, step, seed, TILE / step);

// ---- Ground ------------------------------------------------------------------------------

/**
 * Open ground in the flat 1996 style of the design canvas: one solid colour
 * and one pattern layer. Clear ground has specks of the light ground colour
 * (dark tufts on grass, blue hollows on snow, pebbles on sand); rough ground
 * (heath, ice, dunes) has light streaks running steeply across, broken into
 * dashes. Patterns repeat every tile, so neighbouring cells join without
 * seams whatever their variant; the shader adds large-scale variation.
 */
function ground(p, kind, variant, biome) {
  const t = new Tile();
  if (kind === 'rough') {
    const [lo, hi] = p.rough;
    const seed = 500 + variant * 17;
    t.fill(lo);
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const s = x + 3 * y;
        if (mod(s, 16) >= 5) continue;
        if (hash3(Math.floor(s / 16), x >> 3, seed) < 0.22) continue;
        t.set(x, y, hi);
      }
    }
    return t;
  }
  const [lo, hi] = p.ground;
  const seed = 100 + variant * 17;
  t.fill(lo);
  specks(t, 34, seed, hi);
  if (biome === 'temperate') specks(t, 12, seed + 5, scale(lo, 0.8), 0.7);
  else if (biome === 'snow') specks(t, 12, seed + 5, mixRgb(lo, [150, 176, 210], 0.4), 0.7);
  else specks(t, 6, seed + 5, p.stone, 0.3);
  return t;
}

// ---- Roads and beaches -------------------------------------------------------------------

/**
 * A road cell over open ground: a band of the road surface from the middle of
 * the cell toward each neighbour that is road or bridge too (`mask`: north 1,
 * east 2, south 4, west 8), with a darker border; a road cell with no road
 * around is a patch. The border's wobble repeats every tile, so roads join.
 */
function road(p, mask, biome) {
  const t = ground(p, 'ground', mask % 4, biome);
  const half = TILE / 2;
  const width = 10; // half the road's width in tile pixels
  const border = 2.5;
  const reach = (dx, dy) => {
    // Distance from the road's centre lines (to each connected side, or the middle).
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    let d = Math.hypot(dx, dy) - 5; // the hub
    if (mask & 1 && dy <= 0) d = Math.min(d, ax);
    if (mask & 4 && dy >= 0) d = Math.min(d, ax);
    if (mask & 2 && dx >= 0) d = Math.min(d, ay);
    if (mask & 8 && dx <= 0) d = Math.min(d, ay);
    return d;
  };
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const d = reach(x + 0.5 - half, y + 0.5 - half) + (tnoise(x, y, 4, 1300) - 0.5) * 2;
      if (d > width) continue;
      t.set(x, y, d > width - border ? p.road[0] : p.road[1]);
    }
  }
  return t;
}

/** Sand (beaches, OpenRA's Beach terrain): the light sand colour with short ripple dashes. */
function beach(p, variant, biome) {
  const t = new Tile();
  const seed = 1400 + variant * 13;
  t.fill(p.sand[1]);
  for (let k = 0; k < 16; k++) {
    const x0 = 1 + Math.floor(hash3(k, seed, 1) * (TILE - 7));
    const y = 1 + Math.floor(hash3(k, seed, 2) * (TILE - 2));
    const len = 3 + Math.floor(hash3(k, seed, 3) * 3);
    for (let x = x0; x < x0 + len; x++) t.set(x, y, p.sand[0]);
  }
  if (biome !== 'desert') specks(t, 5, seed + 1, p.stone, 0.3);
  return t;
}

// ---- Rock: raised plateaus -------------------------------------------------------------

/**
 * A rock cell. `mask` bits say which neighbours are rock too (north 1, east 2,
 * south 4, west 8). Open edges get a lit rim (north, west) or a cliff face
 * (east: narrow, south: tall), so plateaus read as raised blocks lit from the
 * top left, and joined cells form one plateau. Flat bands as on the design
 * canvas: rim, light top, a darker brow above the cliff, the face in two tones.
 */
function rock(p, mask, biome) {
  const t = ground(p, 'ground', mask % 4, biome); // what shows below a cliff foot
  const open = { n: !(mask & 1), e: !(mask & 2), s: !(mask & 4), w: !(mask & 8) };
  const faceH = open.s ? 10 : 0; // south cliff face height in pixels
  const faceW = open.e ? 6 : 0; // east cliff face width
  const inset = (edge) => (open[edge] ? 2 : 0); // plateau top stops short of an open edge
  const top = { x0: inset('w'), y0: inset('n'), x1: TILE - faceW, y1: TILE - faceH };
  const cracks = new Set();
  for (let k = 0; k < 3; k++) {
    // A crack of 3 to 5 pixels, a kink halfway, away from the cell's edges.
    let x = 6 + Math.floor(hash3(mask, k, 941) * 16);
    let y = 6 + Math.floor(hash3(mask, k, 942) * 12);
    const len = 3 + Math.floor(hash3(mask, k, 943) * 3);
    const dx = hash3(mask, k, 944) < 0.5 ? 1 : 0;
    for (let s = 0; s < len; s++) {
      cracks.add(y * TILE + x);
      if (dx && s !== 1) x++;
      else y++;
    }
  }
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      // Edges wobble a pixel or so, the same along a whole cliff, so plateaus do not look like boxes.
      const wob = Math.round((tnoise(x, y, 4, 933) - 0.5) * 2.4);
      const n0 = top.y0 + (open.n ? wob : 0);
      const w0 = top.x0 + (open.w ? wob : 0);
      const e1 = top.x1 + (open.e ? wob : 0);
      const s1 = top.y1 + (open.s ? wob : 0);
      if (x >= w0 && y >= n0 && x < e1 && y < s1) {
        let c = p.rockTop[1];
        // The brow: the top darkens just before it drops to a cliff.
        if ((open.s && y >= s1 - 5) || (open.e && x >= e1 - 3)) c = p.rockTop[0];
        // The pattern layer: a few short cracks, kept inside the cell.
        if (cracks.has(y * TILE + x)) c = p.rockTop[0];
        // Lit rim along open north and west edges (snow caps in the snow biome).
        if ((open.n && y < n0 + 3) || (open.w && x < w0 + 3)) c = p.rim;
        t.set(x, y, c, 1);
      } else if (open.s && y >= s1 && x < e1 + 1) {
        // South cliff face: a lit upper band, a shaded lower band and a dark foot.
        const depth = (y - s1) / faceH;
        t.set(x, y, depth < 0.45 ? p.rockFace[1] : depth < 0.85 ? p.rockFace[0] : scale(p.rockFace[0], 0.72), 1);
      } else if (open.e && x >= e1 && y < s1 + 1) {
        // East cliff face: narrower, darkest (faces away from the light).
        t.set(x, y, scale(p.rockFace[0], 0.86), 1);
      } else if (open.e && open.s && x >= top.x1 && y >= top.y1) {
        // South-east corner: the darkest bit of both faces.
        t.set(x, y, scale(p.rockFace[0], 0.68), 1);
      } else {
        // Ground at the foot of the cliff, darkened (the plateau's own shadow).
        t.shade(x, y, 0.72);
      }
    }
  }
  return t;
}

// ---- Water, shorelines and fords ---------------------------------------------------

/**
 * Water with a shoreline on every edge whose neighbour is land (mask bit
 * clear), in flat bands as on the design canvas: wet sand at the very edge, a
 * foam line, a shallow band, a step between, then deep water with thin light
 * streaks. Fords are lighter, a sandy bed with specks. The depth gradient
 * further out comes from the cell layer (shader).
 */
function water(p, mask, ford, biome) {
  const t = new Tile();
  const land = { n: !(mask & 1), e: !(mask & 2), s: !(mask & 4), w: !(mask & 8) };
  const shallow = biome === 'snow' ? mixRgb(p.shallow, [210, 230, 245], 0.45) : p.shallow; // ice along snowy shores
  const bed = mixRgb(p.ford[0], p.shallow, 0.25);
  const bedSpeck = mixRgb(p.ford[1], p.shallow, 0.15);
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const wob = (tnoise(x, y, 4, 1250) - 0.5) * 2.4;
      // Distance (pixels) to the nearest edge that faces land.
      let edge = 99;
      if (land.n) edge = Math.min(edge, y + wob);
      if (land.s) edge = Math.min(edge, TILE - 1 - y + wob);
      if (land.w) edge = Math.min(edge, x + wob);
      if (land.e) edge = Math.min(edge, TILE - 1 - x + wob);
      let c;
      if (ford) {
        c = hash3(x, y, 1330) < 0.08 ? bedSpeck : bed;
      } else if (edge < 9) {
        c = shallow;
      } else if (edge < 14) {
        c = mixRgb(shallow, p.deep, 0.5);
      } else {
        c = p.deep;
        // Streaks a little off level, repeating every tile, broken into dashes.
        const s = 6 * y - x;
        if (mod(s, 32) < 3 && hash3(Math.floor(s / 32), x >> 3, 1280) > 0.4) c = mixRgb(c, [255, 255, 255], 0.1);
      }
      if (edge < 1.5) c = p.sand[0];
      else if (edge < 3.4) c = p.foam;
      t.set(x, y, c, 1);
    }
  }
  return t;
}

// ---- Trees ---------------------------------------------------------------------------------

/** A flat tree on its ground cell: a crown (or cactus, palm, conifer) and a hard shadow to the lower right. */
function tree(p, variant, biome) {
  const t = ground(p, 'ground', variant, biome);
  const r = (k) => hash3(variant, k, 1500);
  const cx = 14 + r(1) * 4;
  const cy = 14 + r(2) * 4;
  const [dark, light] = p.tree;
  if (biome === 'desert' && variant % 2 === 0) {
    // Saguaro cactus: shadow, trunk and two arms, a lit stripe on the left.
    t.dot(cx + 4, cy + 6, 8, SHADOW_RGB, 0.3);
    const arm = (x0, y0, x1, y1, w) => {
      for (let s = 0; s <= 1; s += 0.02) t.disk(x0 + (x1 - x0) * s, y0 + (y1 - y0) * s, w, (dx) => [dx < -0.25 ? light : dark, 1]);
    };
    arm(cx, cy + 10, cx, cy - 10, 2.6);
    arm(cx - 6, cy, cx - 6, cy - 6, 1.8);
    arm(cx - 6, cy + 1, cx - 1, cy + 1, 1.8);
    arm(cx + 6, cy - 2, cx + 6, cy - 9, 1.8);
    arm(cx + 6, cy - 1, cx + 1, cy - 1, 1.8);
    return t;
  }
  if (biome === 'desert') {
    // Palm: trunk and a star of fronds, the ones toward the light lit.
    t.dot(cx + 5, cy + 6, 11, SHADOW_RGB, 0.28);
    for (let s = 0; s <= 1; s += 0.05) t.dot(cx + s * 3, cy + 10 - s * 12, 1.6, p.trunk);
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * Math.PI * 2 + r(3);
      const lit = Math.cos(a) + Math.sin(a) < 0;
      for (let s = 0; s <= 1; s += 0.06) t.dot(cx + 3 + Math.cos(a) * s * 10, cy - 2 + Math.sin(a) * s * 8, 1.7 * (1 - s * 0.6), lit ? light : dark);
    }
    return t;
  }
  if (biome === 'snow') {
    // Conifer: stacked tiers, the lit left half dusted with snow at the top of each tier.
    t.dot(cx + 5, cy + 7, 11, [30, 40, 60], 0.3);
    for (let k = 0; k < 3; k++) {
      const w = 11 - k * 3;
      const ty = cy + 8 - k * 7;
      for (let y = 0; y < 9; y++) {
        const half = (w * (y + 1)) / 9;
        for (let x = -half; x <= half; x++) t.set(Math.round(cx + x), Math.round(ty - 9 + y), x < 0 ? (y < 4 ? p.rim : light) : dark, 1);
      }
    }
    return t;
  }
  // Temperate: a round crown of a few lumps, its lit core toward the top left, a ring of shadow.
  const lumps = [[0, 0, 9]];
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2 + r(4);
    lumps.push([Math.cos(a) * 5.5, Math.sin(a) * 5.5, 5 + r(k + 5) * 1.2]);
  }
  for (const [dx, dy, rr] of lumps) t.dot(cx + dx + 2, cy + dy + 2.5, rr + 1, SHADOW_RGB, 0.3);
  for (const [dx, dy, rr] of lumps) t.dot(cx + dx, cy + dy, rr, dark);
  t.dot(cx - 1.5, cy - 2, 6, light);
  t.dot(cx - 3, cy - 4, 2, scale(light, 1.2));
  return t;
}

// ---- Decals --------------------------------------------------------------------------

/** Transparent overlays scattered over open ground: index 0..DECALS-1. Flat colours with hard shadows. */
function decal(p, k, biome) {
  const t = new Tile();
  const r = (j) => hash3(k, j, 1700);
  const stone = (cx, cy, rad) => {
    t.dot(cx + rad * 0.5, cy + rad * 0.5, rad, SHADOW_RGB, 0.3);
    t.dot(cx, cy, rad, p.stone);
    if (rad > 1.2) t.dot(cx - rad * 0.3, cy - rad * 0.3, rad * 0.55, biome === 'snow' ? p.rim : scale(p.stone, 1.2));
  };
  switch (k) {
    case 0: // a few stones
      for (let j = 0; j < 4; j++) stone(6 + r(j) * 20, 6 + r(j + 9) * 20, 1.6 + r(j + 20) * 1.8);
      break;
    case 1: // pebbles
      for (let j = 0; j < 14; j++) stone(3 + r(j) * 26, 3 + r(j + 30) * 26, 0.9);
      break;
    case 2: // crater: a dark scorched bowl, its lower-right rim lit
      t.disk(16, 16, 10, (dx, dy, d) => (d > 0.75 ? [scale(p.stone, dx + dy > 0 ? 1.2 : 0.85), 0.8] : [[30, 26, 22], 0.55]));
      break;
    case 3: // shrub or brush
      for (let j = 0; j < 5; j++) {
        const cx = 10 + r(j) * 12;
        const cy = 10 + r(j + 5) * 12;
        t.dot(cx + 1.5, cy + 1.5, 3.8, SHADOW_RGB, 0.22);
        t.dot(cx, cy, 3.5, p.shrub[0]);
        t.dot(cx - 1, cy - 1, 1.8, p.shrub[1]);
      }
      break;
    case 4: // vehicle tracks
      for (let x = 0; x < TILE; x++) {
        for (const off of [9, 21]) {
          const y = Math.round(off + Math.sin(x * 0.18 + r(1) * 6) * 2);
          for (let w = 0; w < 3; w++) if ((x + w) % 3 !== 0) t.blend(x, y + w, p.track, 0.45);
        }
      }
      break;
    case 5: // tufts: grass, snow drift or dry tuft
      for (let j = 0; j < 9; j++) {
        const cx = 4 + r(j) * 24;
        const cy = 4 + r(j + 40) * 24;
        for (let s = 0; s < 4; s++) t.blend(Math.round(cx + s - 2), Math.round(cy - Math.abs(s - 1.5) * 1.5), biome === 'snow' ? [250, 252, 255] : scale(p.shrub[1], 1.1), 0.85);
      }
      break;
    case 6: // flowers, ice cracks or bones
      if (biome === 'snow') {
        for (let x = 4; x < 28; x++) t.blend(x, Math.round(16 + Math.sin(x * 0.7) * 3 + (x > 16 ? x - 16 : 0) * 0.3), p.accent, 0.8);
      } else {
        for (let j = 0; j < 8; j++) t.dot(5 + r(j) * 22, 5 + r(j + 50) * 22, biome === 'desert' ? 1.4 : 1, p.accent);
      }
      break;
    default: // a boulder
      stone(15, 15, 6 + r(2) * 2);
  }
  return t;
}

// ---- Atlas -------------------------------------------------------------------------------

/**
 * The tile atlas of a biome: `{ width, height, data, cols, tile }` with
 * RGBA pixels (straight alpha) and TILES.COUNT tiles in rows of ATLAS_COLS.
 */
export function buildTerrainAtlas(biome = 'temperate') {
  const b = BIOMES.includes(biome) ? biome : 'temperate';
  const p = palette(b);
  const tiles = [];
  for (let v = 0; v < 4; v++) tiles[TILES.CLEAR + v] = ground(p, 'ground', v, b);
  for (let v = 0; v < 4; v++) tiles[TILES.ROUGH + v] = ground(p, 'rough', v, b);
  for (let m = 0; m < 16; m++) tiles[TILES.ROCK + m] = rock(p, m, b);
  for (let m = 0; m < 16; m++) tiles[TILES.WATER + m] = water(p, m, false, b);
  for (let m = 0; m < 16; m++) tiles[TILES.FORD + m] = water(p, m, true, b);
  for (let v = 0; v < 4; v++) tiles[TILES.TREE + v] = tree(p, v, b);
  for (let k = 0; k < DECALS; k++) tiles[TILES.DECAL + k] = decal(p, k, b);
  for (let m = 0; m < 16; m++) tiles[TILES.ROAD + m] = road(p, m, b);
  for (let v = 0; v < 4; v++) tiles[TILES.BEACH + v] = beach(p, v, b);
  const rows = Math.ceil(TILES.COUNT / ATLAS_COLS);
  const width = ATLAS_COLS * TILE;
  const height = rows * TILE;
  const data = new Uint8ClampedArray(width * height * 4);
  tiles.forEach((t, i) => {
    const ox = (i % ATLAS_COLS) * TILE;
    const oy = Math.floor(i / ATLAS_COLS) * TILE;
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const s = (y * TILE + x) * 4;
        const o = ((oy + y) * width + ox + x) * 4;
        data[o] = t.px[s];
        data[o + 1] = t.px[s + 1];
        data[o + 2] = t.px[s + 2];
        data[o + 3] = Math.round(clamp01(t.px[s + 3]) * 255);
      }
    }
  });
  return { width, height, data, cols: ATLAS_COLS, tile: TILE, biome: b };
}

// ---- Cell layer ----------------------------------------------------------------------------

/**
 * Seed for terrain decals: a hash of the map's terrain types (engine terrain
 * bytes, RGBA per cell), so every player of a map, and the map editor, see
 * the same decals.
 */
export function terrainSeed(terrain) {
  let h = 0x811c9dc5;
  for (let i = 0; i < terrain.length; i += 4) h = Math.imul(h ^ terrain[i], 0x01000193);
  return h >>> 0;
}

/** Which neighbours have kind bit `k`: north 1, east 2, south 4, west 8. */
const sides = (k, north, east, south, west) => (north & k ? 1 : 0) | (east & k ? 2 : 0) | (south & k ? 4 : 0) | (west & k ? 8 : 0);

/**
 * Per-cell tile layer for the shader, RGBA per cell: R tile index, G decal
 * (0 none, 1 + decal index), B water depth (0 at the shore to 255 four or more
 * cells out), A shadow bits (rock to the north, west, north-west). `terrain`
 * is the engine's terrain bytes (Game.terrain_ptr: R terrain type, G ore, B
 * gems, A 255). Decals follow `seed`, so every player sees the same map.
 */
export function cellTiles(terrain, w, h, seed = 0) {
  const n = w * h;
  const out = new Uint8Array(n * 4);
  // What a terrain type counts as for its neighbours. Rivers look like water,
  // and so does the river under a bridge's deck (the bridge actor draws the
  // deck, art/world.js); walls of the tilesets like rock. Off the map counts
  // as water and rock.
  const WET = 1;
  const ROCKY = 2;
  const ROADY = 4;
  const OFF = WET | ROCKY;
  const kind = new Uint8Array(256);
  for (const t of [T.WATER, T.FORD, T.RIVER, T.BRIDGE]) kind[t] |= WET;
  for (const t of [T.ROCK, T.WALL]) kind[t] |= ROCKY;
  for (const t of [T.ROAD, T.BRIDGE]) kind[t] |= ROADY;
  const kinds = new Uint8Array(n);
  for (let i = 0; i < n; i++) kinds[i] = kind[terrain[i * 4]];
  // Water depth: steps to the nearest land cell (breadth first), capped at 4.
  const depth = new Uint8Array(n).fill(255);
  const queue = new Int32Array(n);
  let tail = 0;
  for (let i = 0; i < n; i++) {
    if (!(kinds[i] & WET)) {
      depth[i] = 0;
      queue[tail++] = i;
    }
  }
  for (let q = 0; q < tail; q++) {
    const i = queue[q];
    const d = depth[i] + 1;
    if (d > 4) continue;
    const x = i % w;
    const y = (i - x) / w;
    // East, west, south, north.
    if (x + 1 < w && depth[i + 1] > d) {
      depth[i + 1] = d;
      queue[tail++] = i + 1;
    }
    if (x > 0 && depth[i - 1] > d) {
      depth[i - 1] = d;
      queue[tail++] = i - 1;
    }
    if (y + 1 < h && depth[i + w] > d) {
      depth[i + w] = d;
      queue[tail++] = i + w;
    }
    if (y > 0 && depth[i - w] > d) {
      depth[i - w] = d;
      queue[tail++] = i - w;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const t = terrain[i * 4];
      const north = y > 0 ? kinds[i - w] : OFF;
      const east = x + 1 < w ? kinds[i + 1] : OFF;
      const south = y + 1 < h ? kinds[i + w] : OFF;
      const west = x > 0 ? kinds[i - 1] : OFF;
      const n4 = (k) => sides(k, north, east, south, west);
      const v = Math.floor(hash3(x, y, seed) * 4);
      let tile;
      let decalIndex = 0;
      switch (t) {
        case T.ROUGH:
          tile = TILES.ROUGH + v;
          if (hash3(x, y, seed + 2) < 0.04) decalIndex = 1 + (hash3(x, y, seed + 3) < 0.5 ? 0 : 1);
          break;
        case T.ROCK:
        case T.WALL:
          tile = TILES.ROCK + n4(ROCKY);
          break;
        case T.WATER:
        case T.RIVER:
        case T.BRIDGE:
          tile = TILES.WATER + n4(WET);
          break;
        case T.ROAD:
          tile = TILES.ROAD + n4(ROADY);
          break;
        case T.BEACH:
          tile = TILES.BEACH + v;
          break;
        case T.TREE:
          tile = TILES.TREE + v;
          break;
        case T.FORD:
          tile = TILES.FORD + n4(WET);
          break;
        default: {
          tile = TILES.CLEAR + v;
          // Decals on 8 % of open ground; craters and boulders are rarer.
          const roll = hash3(x, y, seed + 1);
          if (roll < 0.08) {
            const k = Math.floor(hash3(x, y, seed + 4) * 10);
            decalIndex = 1 + [0, 1, 1, 3, 3, 4, 5, 5, 6, roll < 0.012 ? 2 : 7][k];
          }
        }
      }
      // Rock (or a wall) to the north, west and north-west casts a shadow; rock itself takes none.
      const shadowBits =
        t === T.ROCK ? 0 : (y > 0 && north & ROCKY ? SHADOW.N : 0) | (x > 0 && west & ROCKY ? SHADOW.W : 0) | (x > 0 && y > 0 && kinds[i - w - 1] & ROCKY ? SHADOW.NW : 0);
      out[i * 4] = tile;
      out[i * 4 + 1] = decalIndex;
      out[i * 4 + 2] = kinds[i] & WET ? Math.min(255, depth[i] * 64) : 0;
      out[i * 4 + 3] = shadowBits;
    }
  }
  return out;
}

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
// the building art.
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

/** Fractal noise that tiles across one tile (so neighbouring cells join without seams). */
function fbm(x, y, seed, octaves = 3) {
  let v = 0;
  let amp = 0.5;
  let scale = TILE / 2;
  for (let o = 0; o < octaves; o++) {
    v += amp * vnoise(x, y, scale, seed + o * 101, TILE / scale);
    amp *= 0.5;
    scale /= 2;
  }
  return v / (1 - Math.pow(0.5, octaves));
}

const mix = (a, b, t) => a + (b - a) * t;
const mixRgb = (a, b, t) => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
const scale = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

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

  get(x, y) {
    const o = (y * TILE + x) * 4;
    return [this.px[o], this.px[o + 1], this.px[o + 2], this.px[o + 3]];
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

  /** Soft disk: `fn(dx, dy, d)` returns [rgb, alpha] or null per covered pixel. */
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
}

// ---- Ground ------------------------------------------------------------------------------

function ground(p, kind, variant, biome) {
  const t = new Tile();
  const [lo, hi] = kind === 'rough' ? p.rough : p.ground;
  // Broad shading is the same in every variant (so neighbouring cells join
  // without seams; the shader adds large-scale variation across the map);
  // variants differ in fine detail only.
  const base = kind === 'rough' ? 500 : 100;
  const seed = base + variant * 17;
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const n = 0.5 + (fbm(x, y, base) - 0.5) * 0.25 + (vnoise(x, y, 8, seed, TILE / 8) - 0.5) * 0.3 + (vnoise(x, y, 4, seed + 1, TILE / 4) - 0.5) * 0.2;
      const grain = hash3(x, y, seed + 3);
      let c = mixRgb(lo, hi, clamp01(n * 1.2 - 0.1));
      c = scale(c, 0.94 + grain * 0.1);
      if (kind === 'rough' && biome === 'desert') {
        // Dune ripples running diagonally, lit on the upper left side.
        const ripple = Math.sin((x * 0.55 + y * 0.9 + n * 6) * 1.1);
        c = scale(c, 1 + ripple * 0.07);
      } else if (kind === 'rough' && biome === 'snow') {
        // Ice: smooth with a glossy sheen toward the top left and fine cracks.
        c = mixRgb(c, [236, 248, 255], clamp01(0.35 - (x + y) / (TILE * 4)) * (0.6 + n * 0.4));
        if (Math.abs(vnoise(x, y, 7, seed + 9) - 0.5) < 0.025) c = mixRgb(c, [240, 250, 255], 0.7);
      } else if (kind === 'rough') {
        // Heath: darker tussocks.
        if (hash3(x >> 1, y >> 1, seed + 5) < 0.12) c = scale(c, 0.8);
      } else if (biome === 'temperate') {
        // Grass blades: short dark and light strokes.
        if (grain > 0.93) c = scale(c, 1.18);
        else if (grain < 0.06) c = scale(c, 0.8);
      } else if (biome === 'snow') {
        // Wind-blown snow: faint blue hollows that differ per variant.
        c = mixRgb(c, [176, 196, 222], clamp01(0.45 - vnoise(x, y, 8, seed + 7, TILE / 8)) * 0.35);
      } else {
        // Sand: fine pebbles.
        if (grain > 0.965) c = scale(p.stone, 0.9 + hash3(x, y, 77) * 0.3);
      }
      t.set(x, y, c, 1);
    }
  }
  return t;
}

// ---- Roads and beaches -------------------------------------------------------------------

/**
 * A road cell over open ground: a band of the road surface from the middle of
 * the cell toward each neighbour that is road or bridge too (`mask`: north 1,
 * east 2, south 4, west 8), with worn edges and wheel ruts; a road cell with
 * no road around is a patch.
 */
function road(p, mask, biome) {
  const t = ground(p, 'ground', mask % 4, biome);
  const half = TILE / 2;
  const width = 11; // half the road's width in tile pixels
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
      const dx = x + 0.5 - half;
      const dy = y + 0.5 - half;
      const wob = (vnoise(x, y, 4, 1300 + mask) - 0.5) * 3;
      const d = reach(dx, dy) + wob;
      if (d > width) continue;
      const n = fbm(x, y, 1310);
      let c = mixRgb(p.road[0], p.road[1], clamp01(n * 1.3 - 0.15));
      c = scale(c, 0.92 + hash3(x, y, 1320) * 0.1);
      // Ruts along the road, darker toward its edges.
      if (Math.abs(d - 4) < 0.8) c = scale(c, 0.86);
      const edge = clamp01((d - width + 3) / 3);
      t.blend(x, y, c, 1 - edge * 0.7);
    }
  }
  return t;
}

/** Sand (beaches, OpenRA's Beach terrain): ground of the sand colours with ripples. */
function beach(p, variant, biome) {
  const t = new Tile();
  const seed = 1400 + variant * 13;
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const n = 0.5 + (fbm(x, y, 1400) - 0.5) * 0.3 + (vnoise(x, y, 6, seed, TILE / 6) - 0.5) * 0.25;
      let c = mixRgb(p.sand[0], p.sand[1], clamp01(n * 1.2 - 0.1));
      c = scale(c, 0.95 + hash3(x, y, seed) * 0.08 + Math.sin((x * 0.4 + y * 0.8) * 1.2) * 0.03);
      if (biome !== 'desert' && hash3(x, y, seed + 1) > 0.975) c = scale(p.stone, 1.1);
      t.set(x, y, c, 1);
    }
  }
  return t;
}

// ---- Rock: raised plateaus -------------------------------------------------------------

/**
 * A rock cell. `mask` bits say which neighbours are rock too (north 1, east 2,
 * south 4, west 8). Open edges get a lit rim (north, west) or a cliff face
 * (east: narrow, south: tall, with strata), so plateaus read as raised blocks
 * lit from the top left, and joined cells form one plateau.
 */
function rock(p, mask, biome) {
  const t = ground(p, 'ground', mask % 4, biome); // what shows below a cliff foot
  const open = { n: !(mask & 1), e: !(mask & 2), s: !(mask & 4), w: !(mask & 8) };
  const faceH = open.s ? 11 : 0; // south cliff face height in pixels
  const faceW = open.e ? 6 : 0; // east cliff face width
  const inset = (edge) => (open[edge] ? 2 : 0); // plateau top stops short of an open edge
  const top = { x0: inset('w'), y0: inset('n'), x1: TILE - faceW, y1: TILE - faceH };
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const n = fbm(x, y, 900 + mask * 7);
      const grain = hash3(x, y, 911 + mask);
      // Edges wobble a little so plateaus do not look like boxes.
      const wob = (vnoise(x + y, mask, 5, 933) - 0.5) * 3;
      const inTop = x >= top.x0 + (open.w ? wob : 0) && y >= top.y0 + (open.n ? wob : 0) && x < top.x1 + (open.e ? wob : 0) && y < top.y1 + (open.s ? wob : 0);
      if (inTop) {
        let c = mixRgb(p.rockTop[0], p.rockTop[1], clamp01(n * 1.3 - 0.15));
        // Cracks and lit facets on the top face.
        if (Math.abs(vnoise(x, y, 6, 940 + mask) - 0.5) < 0.03) c = scale(c, 0.7);
        c = scale(c, 0.92 + grain * 0.12);
        // Lit rim along open north and west edges (snow caps in the snow biome).
        const rimN = open.n ? clamp01(1 - (y - top.y0) / 3) : 0;
        const rimW = open.w ? clamp01(1 - (x - top.x0) / 3) : 0;
        c = mixRgb(c, p.rim, Math.max(rimN, rimW) * 0.7);
        if (biome === 'snow' && n > 0.55) c = mixRgb(c, p.rim, 0.75);
        // Gentle slope shading: brighter toward the top left.
        c = scale(c, 1.06 - ((x + y) / (TILE * 2)) * 0.12);
        t.set(x, y, c, 1);
      } else if (open.s && y >= top.y1 + wob && x < top.x1 + (open.e ? wob : 0) + 1) {
        // South cliff face: tall, in shadow, with horizontal strata and a dark foot.
        const depth = (y - top.y1) / faceH;
        const strata = Math.sin((y + vnoise(x, y, 8, 950 + mask) * 4) * 1.5) * 0.08;
        let c = mixRgb(p.rockFace[1], p.rockFace[0], clamp01(depth * 0.9));
        c = scale(c, 0.95 + strata + grain * 0.08);
        if (depth > 0.85) c = scale(c, 0.7);
        t.set(x, y, c, 1);
      } else if (open.e && x >= top.x1 + wob && y < top.y1 + (open.s ? wob : 0) + 1) {
        // East cliff face: narrower, darkest (faces away from the light).
        const depth = (x - top.x1) / Math.max(faceW, 1);
        let c = mixRgb(p.rockFace[0], scale(p.rockFace[0], 0.75), clamp01(depth));
        c = scale(c, 0.92 + grain * 0.1);
        t.set(x, y, c, 1);
      } else if (open.e && open.s && x >= top.x1 && y >= top.y1) {
        // South-east corner: the darkest bit of both faces.
        t.set(x, y, scale(p.rockFace[0], 0.65 + grain * 0.1), 1);
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
 * clear): a shallow band, a foam line and wet sand at the very edge. The
 * depth gradient further out comes from the cell layer (shader).
 */
function water(p, mask, ford, biome) {
  const t = new Tile();
  const land = { n: !(mask & 1), e: !(mask & 2), s: !(mask & 4), w: !(mask & 8) };
  const [fordLo, fordHi] = p.ford;
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const n = fbm(x, y, ford ? 1300 : 1200);
      const wob = (vnoise(x, y, 6, 1250) - 0.5) * 4;
      // Distance (pixels) to the nearest edge that faces land.
      let edge = 99;
      if (land.n) edge = Math.min(edge, y + wob);
      if (land.s) edge = Math.min(edge, TILE - 1 - y + wob);
      if (land.w) edge = Math.min(edge, x + wob);
      if (land.e) edge = Math.min(edge, TILE - 1 - x + wob);
      let c;
      if (ford) {
        // Shallow crossing: sandy bed showing through, ripples across.
        c = mixRgb(fordLo, fordHi, clamp01(n * 1.3 - 0.15));
        c = mixRgb(c, p.shallow, 0.35);
        const ripple = Math.sin((x * 0.8 + y * 0.3 + n * 5) * 1.3);
        if (ripple > 0.85) c = mixRgb(c, p.foam, 0.35);
      } else {
        c = mixRgb(p.deep, p.shallow, clamp01(1.1 - edge / 12) * 0.9 + n * 0.1);
        if (biome === 'snow' && edge < 5) c = mixRgb(c, [210, 230, 245], 0.55); // ice rim
      }
      // Foam along the shore, broken by noise; wet ground right at the edge.
      if (edge < 2.2) c = mixRgb(c, scale(p.ground[0], 0.7), 0.65);
      else if (edge < 4.5 && vnoise(x, y, 3, 1270) > 0.35) c = mixRgb(c, p.foam, 0.75);
      t.set(x, y, c, 1);
    }
  }
  return t;
}

// ---- Trees ---------------------------------------------------------------------------------

function tree(p, variant, biome) {
  const t = ground(p, 'ground', variant, biome);
  const r = (k) => hash3(variant, k, 1500);
  const cx = 14 + r(1) * 4;
  const cy = 14 + r(2) * 4;
  if (biome === 'desert' && variant % 2 === 0) {
    // Saguaro cactus: shadow, trunk and two arms, lit on the left.
    t.disk(cx + 5, cy + 7, 8, () => [[0, 0, 0], 0.28]);
    const arm = (x0, y0, x1, y1, w) => {
      for (let s = 0; s <= 1; s += 0.02) {
        const x = mix(x0, x1, s);
        const y = mix(y0, y1, s);
        t.disk(x, y, w, (dx) => [scale(mixRgb(p.tree[0], p.tree[1], clamp01(0.6 - dx)), 1), 1]);
      }
    };
    arm(cx, cy + 10, cx, cy - 10, 2.6);
    arm(cx - 6, cy, cx - 6, cy - 6, 1.8);
    arm(cx - 6, cy + 1, cx - 1, cy + 1, 1.8);
    arm(cx + 6, cy - 2, cx + 6, cy - 9, 1.8);
    arm(cx + 6, cy - 1, cx + 1, cy - 1, 1.8);
    return t;
  }
  if (biome === 'desert') {
    // Palm: trunk and a star of fronds.
    t.disk(cx + 6, cy + 6, 11, () => [[0, 0, 0], 0.25]);
    for (let s = 0; s <= 1; s += 0.05) t.disk(cx + s * 3, cy + 10 - s * 12, 1.6, () => [p.trunk, 1]);
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * Math.PI * 2 + r(3);
      for (let s = 0; s <= 1; s += 0.06) {
        t.disk(cx + 3 + Math.cos(a) * s * 10, cy - 2 + Math.sin(a) * s * 8, 1.7 * (1 - s * 0.6), () => [mixRgb(p.tree[1], p.tree[0], s), 1]);
      }
    }
    return t;
  }
  if (biome === 'snow') {
    // Conifer: stacked tiers, snow on the lit upper-left of each tier.
    t.disk(cx + 6, cy + 8, 11, () => [[30, 40, 60], 0.3]);
    for (let k = 0; k < 3; k++) {
      const w = 11 - k * 3;
      const ty = cy + 8 - k * 7;
      for (let y = 0; y < 9; y++) {
        const half = (w * (y + 1)) / 9;
        for (let x = -half; x <= half; x++) {
          const lit = x < 0 && y < 5;
          const c = lit ? mixRgb(p.tree[1], [235, 242, 250], 0.75) : mixRgb(p.tree[0], p.tree[1], (half - x) / (2 * half + 1));
          t.blend(Math.round(cx + x), Math.round(ty - 9 + y), c, 1);
        }
      }
    }
    return t;
  }
  // Temperate: a round crown of leaf clumps over a shadow, lit from the top left.
  t.disk(cx + 5, cy + 6, 12, () => [[0, 0, 0], 0.32]);
  for (let k = 0; k < 7; k++) {
    const a = (k / 7) * Math.PI * 2;
    const ox = Math.cos(a) * 6;
    const oy = Math.sin(a) * 6;
    t.disk(cx + ox, cy + oy, 6, (dx, dy) => [scale(mixRgb(p.tree[1], p.tree[0], clamp01(0.5 + (dx + dy) * 0.5)), 0.95 + r(k) * 0.1), 1]);
  }
  t.disk(cx, cy, 7, (dx, dy) => [mixRgb(p.tree[1], p.tree[0], clamp01(0.4 + (dx + dy) * 0.5)), 1]);
  t.disk(cx - 3, cy - 3, 3, () => [scale(p.tree[1], 1.25), 0.6]);
  return t;
}

// ---- Decals --------------------------------------------------------------------------

/** Transparent overlays scattered over open ground: index 0..DECALS-1. */
function decal(p, k, biome) {
  const t = new Tile();
  const r = (j) => hash3(k, j, 1700);
  const stone = (cx, cy, rad) => {
    t.disk(cx + rad * 0.5, cy + rad * 0.5, rad, () => [[0, 0, 0], 0.3]);
    t.disk(cx, cy, rad, (dx, dy) => [scale(p.stone, 1.15 - (dx + dy) * 0.25), 1]);
    if (biome === 'snow') t.disk(cx - rad * 0.3, cy - rad * 0.4, rad * 0.6, () => [p.rim, 0.85]);
  };
  switch (k) {
    case 0: // a few stones
      for (let j = 0; j < 4; j++) stone(6 + r(j) * 20, 6 + r(j + 9) * 20, 1.6 + r(j + 20) * 1.8);
      break;
    case 1: // pebbles
      for (let j = 0; j < 14; j++) stone(3 + r(j) * 26, 3 + r(j + 30) * 26, 0.9);
      break;
    case 2: // crater: dark scorched bowl, lit lower-right rim
      t.disk(16, 16, 10, (dx, dy, d) => [d > 0.75 ? scale(p.stone, 1.1 + (dx + dy) * 0.3) : [30, 26, 22], d > 0.75 ? 0.75 : 0.55]);
      break;
    case 3: // shrub or brush
      for (let j = 0; j < 5; j++) {
        const cx = 10 + r(j) * 12;
        const cy = 10 + r(j + 5) * 12;
        t.disk(cx + 2, cy + 2, 4, () => [[0, 0, 0], 0.22]);
        t.disk(cx, cy, 3.5, (dx, dy) => [mixRgb(p.shrub[1], p.shrub[0], clamp01(0.5 + (dx + dy) * 0.5)), 1]);
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
        for (let s = 0; s < 4; s++) t.blend(Math.round(cx + s - 2), Math.round(cy - Math.abs(s - 1.5) * 1.5), biome === 'snow' ? [250, 252, 255] : scale(p.shrub[1], 1.1), 0.8);
      }
      break;
    case 6: // flowers, ice cracks or bones
      if (biome === 'snow') {
        for (let x = 4; x < 28; x++) t.blend(x, Math.round(16 + Math.sin(x * 0.7) * 3 + (x > 16 ? x - 16 : 0) * 0.3), p.accent, 0.8);
      } else {
        for (let j = 0; j < 8; j++) t.disk(5 + r(j) * 22, 5 + r(j + 50) * 22, biome === 'desert' ? 1.4 : 1, () => [p.accent, 1]);
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

/**
 * Per-cell tile layer for the shader, RGBA per cell: R tile index, G decal
 * (0 none, 1 + decal index), B water depth (0 at the shore to 255 four or more
 * cells out), A shadow bits (rock to the north, west, north-west). `terrain`
 * is the engine's terrain bytes (Game.terrain_ptr: R terrain type, G ore, B
 * gems, A 255). Decals follow `seed`, so every player sees the same map.
 */
export function cellTiles(terrain, w, h, seed = 0) {
  const out = new Uint8Array(w * h * 4);
  const type = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? -1 : terrain[(y * w + x) * 4]);
  // Rivers look like water, and so does the river under a bridge's deck (the
  // bridge actor draws the deck, art/world.js); walls of the tilesets like rock.
  const wet = (t) => t === T.WATER || t === T.FORD || t === T.RIVER || t === T.BRIDGE || t === -1;
  const isRock = (t) => t === T.ROCK || t === T.WALL || t === -1;
  const isRoad = (t) => t === T.ROAD || t === T.BRIDGE;
  // Water depth: steps to the nearest land cell (breadth first), capped at 4.
  const depth = new Uint8Array(w * h).fill(255);
  const queue = [];
  for (let i = 0; i < w * h; i++) {
    if (!wet(terrain[i * 4])) {
      depth[i] = 0;
      queue.push(i);
    }
  }
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q];
    if (depth[i] >= 4) continue;
    const x = i % w;
    const y = (i - x) / w;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (depth[j] > depth[i] + 1) {
        depth[j] = depth[i] + 1;
        queue.push(j);
      }
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const t = type(x, y);
      const n4 = (pred) => (pred(type(x, y - 1)) ? 1 : 0) | (pred(type(x + 1, y)) ? 2 : 0) | (pred(type(x, y + 1)) ? 4 : 0) | (pred(type(x - 1, y)) ? 8 : 0);
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
          tile = TILES.ROCK + n4(isRock);
          break;
        case T.WATER:
        case T.RIVER:
        case T.BRIDGE:
          tile = TILES.WATER + n4(wet);
          break;
        case T.ROAD:
          tile = TILES.ROAD + n4(isRoad);
          break;
        case T.BEACH:
          tile = TILES.BEACH + v;
          break;
        case T.TREE:
          tile = TILES.TREE + v;
          break;
        case T.FORD:
          tile = TILES.FORD + n4(wet);
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
      const shadowBits =
        t === T.ROCK ? 0 : (isRock(type(x, y - 1)) && y > 0 ? SHADOW.N : 0) | (isRock(type(x - 1, y)) && x > 0 ? SHADOW.W : 0) | (isRock(type(x - 1, y - 1)) && x > 0 && y > 0 ? SHADOW.NW : 0);
      out[i * 4] = tile;
      out[i * 4 + 1] = decalIndex;
      out[i * 4 + 2] = wet(t) && t !== -1 ? Math.min(255, depth[i] * 64) : 0;
      out[i * 4 + 3] = shadowBits;
    }
  }
  return out;
}

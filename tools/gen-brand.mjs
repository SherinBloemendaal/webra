// The WebRA logo (the Logo board of the design system), drawn from code so it
// is reproducible: an isometric battlefield tile (a diamond) with a W as a
// radar wave, on an octagonal plate with rivets. WebRA's own mark: no
// Electronic Arts or OpenRA logos or emblems. Every SVG uses presentation
// attributes only (no style attributes or elements, no text, no external
// references), so it works inline, as an image and as a favicon under the
// site's CSP.
//
//   node tools/gen-brand.mjs          write apps/game/brand/*
//   node tools/gen-brand.mjs --check  exit 1 when the committed files differ
//
// Output in apps/game/brand/ (the website loads them from /lib/brand/, the
// game from brand/):
//   emblem.svg            the full emblem with its plate: 40 px and larger
//   favicon.svg           the simplified emblem in one colour (no plate): the
//                         favicon and every mark under 40 px
//   wordmark.svg          WEB RA in blocky condensed capitals, for dark grounds
//   favicon-16.png, favicon-32.png   the simplified emblem
//   apple-touch-icon.png  180 x 180, the full emblem on the dark background
//
// The PNGs come from a small rasterizer in this file (polygons with 8 x 8
// supersampling, zlib from Node), so no image tool is needed. Their pixels
// are what the tests compare (tools/gen-brand.test.mjs): zlib versions may
// pack the same pixels differently.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const BRAND_DIR = join(root, 'apps/game/brand');

// ---- Geometry (viewBox 0 0 100 100, from the Logo board) -------------------------

const pts = (s) => s.split(' ').map((p) => p.split(',').map(Number));
export const SHAPES = Object.freeze({
  octagon: pts('30,3 70,3 97,30 97,70 70,97 30,97 3,70 3,30'),
  plate: pts('31,6 69,6 94,31 94,69 69,94 31,94 6,69 6,31'),
  sheen: pts('6,69 6,31 31,6 69,6'),
  tile: pts('50,17 83,50 50,83 17,50'),
  tileShade: pts('83,50 50,83 17,50'),
  wave: pts('29,41 39,63 50,45 61,63 71,41'),
  rivets: pts('50,12 88,50 50,88 12,50'),
});
export const COLORS = Object.freeze({
  edge: '#030405',
  plate: '#222830',
  sheen: 'rgba(255,255,255,0.16)',
  tile: '#e0301f',
  tileShade: '#b8231a',
  wave: '#f4f1e8',
  rivet: '#8a929c',
  mark: '#ff4a36', // the one-colour emblem and the "RA" of the wordmark (--ui-brand-red)
  word: '#e2e6ea',
  ground: '#0a0c0f', // the app icon's background (--ui-bg)
});
const WAVE_WIDTH = 7;
const RING_WIDTH = 5;
const SHEEN_WIDTH = 2;
const RIVET_R = 2.4;

const fmt = (n) => String(Math.round(n * 1000) / 1000);
const pointList = (ps) => ps.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(' ');
const pathOf = (rings) => rings.map((r) => `M${r.map(([x, y]) => `${fmt(x)} ${fmt(y)}`).join('L')}Z`).join('');

// ---- Strokes as polygons (the same outlines in the SVGs and the PNGs) ------------

/** Intersection of the lines p1 + t * d1 and p2 + s * d2 (null when parallel). */
function intersect([x1, y1], [dx1, dy1], [x2, y2], [dx2, dy2]) {
  const den = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((x2 - x1) * dy2 - (y2 - y1) * dx2) / den;
  return [x1 + t * dx1, y1 + t * dy1];
}

/** One side of a polyline offset by `d` (left of the direction of travel), with miter joins. */
function offsetSide(points, d, closed) {
  const n = points.length;
  const seg = (i) => {
    const a = points[i];
    const b = points[(i + 1) % n];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const dir = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    const nrm = [-dir[1] * d, dir[0] * d];
    return { a: [a[0] + nrm[0], a[1] + nrm[1]], b: [b[0] + nrm[0], b[1] + nrm[1]], dir };
  };
  const segs = Array.from({ length: closed ? n : n - 1 }, (_, i) => seg(i));
  const out = [];
  if (!closed) out.push(segs[0].a);
  for (let i = closed ? 0 : 1; i < segs.length; i++) {
    const prev = segs[(i - 1 + segs.length) % segs.length];
    const cur = segs[i];
    out.push(intersect(prev.a, prev.dir, cur.a, cur.dir) ?? cur.a);
  }
  if (!closed) out.push(segs.at(-1).b);
  return out;
}

/** An open polyline stroked `width` wide with miter joins and butt ends: one ring. */
export function strokePolyline(points, width) {
  const left = offsetSide(points, width / 2, false);
  const right = offsetSide(points, -width / 2, false);
  return [[...left, ...right.reverse()]];
}

/** A closed polygon's outline stroked `width` wide: the outer and the inner ring (even-odd). */
export function strokePolygon(points, width) {
  return [offsetSide(points, -width / 2, true), offsetSide(points, width / 2, true)];
}

/** A circle as a polygon of `n` sides. */
function circle(cx, cy, r, n = 48) {
  return Array.from({ length: n }, (_, i) => [cx + r * Math.cos((2 * Math.PI * i) / n), cy + r * Math.sin((2 * Math.PI * i) / n)]);
}

// ---- The drawings: shapes in paint order ------------------------------------------
// Each: { rings, fill, rule: 'nonzero' | 'evenodd' }.

/** The full emblem with its plate (Logo board, symbol "em"). */
export function emblemShapes() {
  return [
    { rings: [SHAPES.octagon], fill: COLORS.edge },
    { rings: [SHAPES.plate], fill: COLORS.plate },
    { rings: strokePolyline(SHAPES.sheen, SHEEN_WIDTH), fill: COLORS.sheen },
    { rings: [SHAPES.tile], fill: COLORS.tile },
    { rings: [SHAPES.tileShade], fill: COLORS.tileShade },
    { rings: strokePolyline(SHAPES.wave, WAVE_WIDTH), fill: COLORS.wave },
    ...SHAPES.rivets.map(([x, y]) => ({ rings: [circle(x, y, RIVET_R)], fill: COLORS.rivet })),
  ];
}

/** The simplified emblem in one colour (symbol "em-mono"): the plate's outline, the tile with the W cut out. */
export function markShapes(color = COLORS.mark) {
  return [
    { rings: strokePolygon(SHAPES.octagon, RING_WIDTH), fill: color, rule: 'evenodd' },
    { rings: [SHAPES.tile, ...strokePolyline(SHAPES.wave, WAVE_WIDTH)], fill: color, rule: 'evenodd' },
  ];
}

// ---- Wordmark: blocky condensed capitals with cut corners, like the plate -------------
// Glyphs on a 100 unit cap height, stems 18 wide, corners cut by 14.
const S = 18;
const C = 14;
const GLYPHS = {
  W: {
    w: 90,
    rings: [[[0, 0], [S, 0], [S, 82], [36, 82], [36, 28], [54, 28], [54, 82], [90 - S, 82], [90 - S, 0], [90, 0], [90, 100 - C], [90 - C, 100], [C, 100], [0, 100 - C]]],
  },
  E: {
    w: 52,
    rings: [[[0, 0], [52, 0], [52, S], [S, S], [S, 41], [46, 41], [46, 59], [S, 59], [S, 100 - S], [52, 100 - S], [52, 100], [0, 100]]],
  },
  B: {
    w: 58,
    rings: [
      [[0, 0], [58 - C, 0], [58, C], [58, 43], [52, 50], [58, 57], [58, 100 - C], [58 - C, 100], [0, 100]],
      [[S, S], [58 - S, S], [58 - S, 41], [S, 41]],
      [[S, 59], [58 - S, 59], [58 - S, 100 - S], [S, 100 - S]],
    ],
  },
  R: {
    w: 60,
    rings: [
      [[0, 0], [60 - C, 0], [60, C], [60, 56], [52, 64], [60, 100], [60 - S, 100], [32, 66], [S, 66], [S, 100], [0, 100]],
      [[S, S], [60 - S, S], [60 - S, 48], [S, 48]],
    ],
  },
  A: {
    w: 62,
    rings: [
      [[0, C], [C, 0], [62 - C, 0], [62, C], [62, 100], [62 - S, 100], [62 - S, 62], [S, 62], [S, 100], [0, 100]],
      [[S, S], [62 - S, S], [62 - S, 44], [S, 44]],
    ],
  },
};
const LETTER_GAP = 8;

/** The wordmark's shapes and width: WEB in the text colour, RA in the brand red. */
export function wordmarkShapes() {
  const shapes = [];
  let x = 0;
  for (const [i, ch] of [...'WEBRA'].entries()) {
    const g = GLYPHS[ch];
    const fill = i < 3 ? COLORS.word : COLORS.mark;
    shapes.push({ rings: g.rings.map((r) => r.map(([px, py]) => [px + x, py])), fill, rule: 'evenodd' });
    x += g.w + LETTER_GAP;
  }
  return { shapes, width: x - LETTER_GAP, height: 100 };
}

// ---- SVG ----------------------------------------------------------------------------

function fillAttrs(color) {
  const m = /^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$/.exec(color);
  return m ? `fill="rgb(${m[1]},${m[2]},${m[3]})" fill-opacity="${m[4]}"` : `fill="${color}"`;
}

function svgOf(shapes, { width, height, title }) {
  const body = shapes
    .map((s) => (s.rings.length === 1 && s.rule !== 'evenodd' ? `  <polygon points="${pointList(s.rings[0])}" ${fillAttrs(s.fill)}/>` : `  <path d="${pathOf(s.rings)}" ${fillAttrs(s.fill)}${s.rule === 'evenodd' ? ' fill-rule="evenodd"' : ''}/>`))
    .join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${title}">\n  <title>${title}</title>\n${body}\n</svg>\n`;
}

// ---- Rasterizer -------------------------------------------------------------------

function parseColor(c) {
  let m = /^#([0-9a-f]{6})$/i.exec(c);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255).concat(1);
  m = /^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$/.exec(c);
  if (m) return [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255, Number(m[4])];
  throw new Error(`colour ${c}`);
}

/** Coverage (0..1) of `rings` per pixel, `size` x `size`, the viewBox `box` units across. */
function coverage(rings, rule, size, box, ss = 8) {
  const cov = new Float64Array(size * size);
  const scale = size / box;
  const edges = [];
  for (const r of rings) {
    for (let i = 0; i < r.length; i++) {
      const [x0, y0] = r[i];
      const [x1, y1] = r[(i + 1) % r.length];
      if (y0 !== y1) edges.push({ x0: x0 * scale, y0: y0 * scale, x1: x1 * scale, y1: y1 * scale });
    }
  }
  const w = 1 / (ss * ss);
  for (let sy = 0; sy < size * ss; sy++) {
    const y = (sy + 0.5) / ss;
    const xs = [];
    for (const e of edges) {
      const up = e.y0 < e.y1;
      const lo = up ? e.y0 : e.y1;
      const hi = up ? e.y1 : e.y0;
      if (y < lo || y >= hi) continue;
      xs.push({ x: e.x0 + ((y - e.y0) * (e.x1 - e.x0)) / (e.y1 - e.y0), d: up ? 1 : -1 });
    }
    if (!xs.length) continue;
    xs.sort((a, b) => a.x - b.x);
    let k = 0;
    let wind = 0;
    let crossings = 0;
    const row = Math.floor(sy / ss) * size;
    for (let sx = 0; sx < size * ss; sx++) {
      const x = (sx + 0.5) / ss;
      while (k < xs.length && xs[k].x <= x) {
        wind += xs[k].d;
        crossings++;
        k++;
      }
      const inside = rule === 'evenodd' ? crossings % 2 === 1 : wind !== 0;
      if (inside) cov[row + Math.floor(sx / ss)] += w;
    }
  }
  return cov;
}

/** RGBA pixels (0..255) of `shapes` drawn over `background` (null: transparent). */
export function rasterize(shapes, size, box = 100, background = null) {
  const px = new Float64Array(size * size * 4);
  if (background) {
    const [r, g, b] = parseColor(background);
    for (let i = 0; i < size * size; i++) px.set([r, g, b, 1], i * 4);
  }
  for (const s of shapes) {
    const [r, g, b, a] = parseColor(s.fill);
    const cov = coverage(s.rings, s.rule ?? 'nonzero', size, box);
    for (let i = 0; i < size * size; i++) {
      const sa = a * Math.min(1, cov[i]);
      if (sa <= 0) continue;
      const da = px[i * 4 + 3];
      const oa = sa + da * (1 - sa);
      for (const [c, v] of [
        [0, r],
        [1, g],
        [2, b],
      ]) {
        px[i * 4 + c] = (v * sa + px[i * 4 + c] * da * (1 - sa)) / oa;
      }
      px[i * 4 + 3] = oa;
    }
  }
  return Uint8Array.from(px, (v) => Math.round(Math.max(0, Math.min(1, v)) * 255));
}

// ---- PNG ----------------------------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** An RGBA PNG (8 bits, no filter on the rows). */
export function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** The pixels of a PNG this file wrote: `{ size, rgba }` (RGBA, 8 bits, filter 0 rows). */
export function decodePng(buf) {
  if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('not a PNG');
  let off = 8;
  let size = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString('latin1');
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      size = data.readUInt32BE(0);
      if (data.readUInt32BE(4) !== size || data[8] !== 8 || data[9] !== 6) throw new Error('not a square 8-bit RGBA PNG');
    } else if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const rgba = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    if (raw[y * (size * 4 + 1)] !== 0) throw new Error('row filters other than 0 are not expected here');
    rgba.set(raw.subarray(y * (size * 4 + 1) + 1, (y + 1) * (size * 4 + 1)), y * size * 4);
  }
  return { size, rgba };
}

// ---- Files --------------------------------------------------------------------------

/** Every output: `{ name, data, png?: { size, rgba } }`. */
export function brandOutputs() {
  const word = wordmarkShapes();
  const out = [
    { name: 'emblem.svg', data: svgOf(emblemShapes(), { width: 100, height: 100, title: 'WebRA' }) },
    { name: 'favicon.svg', data: svgOf(markShapes(), { width: 100, height: 100, title: 'WebRA' }) },
    { name: 'wordmark.svg', data: svgOf(word.shapes, { width: word.width, height: word.height, title: 'WebRA' }) },
  ];
  for (const [name, size, shapes, bg] of [
    ['favicon-16.png', 16, markShapes(), null],
    ['favicon-32.png', 32, markShapes(), null],
    ['apple-touch-icon.png', 180, emblemShapes(), COLORS.ground],
  ]) {
    // The app icon keeps a margin round the plate (the board's clear space, and
    // room for the rounded corners the phone cuts): the emblem at 76%, centred.
    const placed = bg ? shapes.map((s) => ({ ...s, rings: s.rings.map((r) => r.map(([x, y]) => [12 + x * 0.76, 12 + y * 0.76])) })) : shapes;
    const rgba = rasterize(placed, size, 100, bg);
    out.push({ name, data: encodePng(rgba, size), png: { size, rgba } });
  }
  return out;
}

/** Names of the committed files that differ from the generated ones (PNGs by their pixels). */
export function staleBrand(dir = BRAND_DIR) {
  return brandOutputs()
    .filter((o) => {
      const file = join(dir, o.name);
      if (!existsSync(file)) return true;
      const have = readFileSync(file);
      if (!o.png) return have.toString('utf8') !== o.data;
      try {
        const { size, rgba } = decodePng(have);
        return size !== o.png.size || Buffer.compare(Buffer.from(rgba), Buffer.from(o.png.rgba)) !== 0;
      } catch {
        return true;
      }
    })
    .map((o) => o.name);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--check')) {
    const stale = staleBrand();
    if (stale.length) {
      console.error(`gen-brand: out of date: ${stale.join(', ')}. Run "node tools/gen-brand.mjs".`);
      process.exit(1);
    }
    console.log('gen-brand: apps/game/brand is up to date');
  } else {
    mkdirSync(BRAND_DIR, { recursive: true });
    const outputs = brandOutputs();
    for (const o of outputs) writeFileSync(join(BRAND_DIR, o.name), o.data);
    console.log(`gen-brand: wrote ${outputs.map((o) => o.name).join(', ')} to apps/game/brand`);
  }
}

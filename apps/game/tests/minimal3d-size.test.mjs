// The 3D minimal pack against the original art: the colour table it shares with the 2D minimal art, and (below)
// the size of every structure and unit compared with the original sprite's extent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SHARED_PALETTE } from '../js/art/shared-palette.js';
import { ORIGINAL_BOUNDS } from '../js/content/render-facts.js';

const source = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

// ---- The shared palette ---------------------------------------------------------------------------

test('the shared 2D/3D palette is strict JSON, as the 3D generator reads it', () => {
  const text = source('../js/art/shared-palette.js');
  const at = text.indexOf('{', text.indexOf('export const SHARED_PALETTE ='));
  const end = text.indexOf('\n};', at);
  assert.deepEqual(JSON.parse(text.slice(at, end + 2)), SHARED_PALETTE);
  assert.ok(source('../../../tools/gen_minimal3d/core.py').includes("'shared-palette.js'"), 'core.py reads the shared palette');
});

test('the shared palette has the materials, the team strip, the shadow and terrain for every biome', () => {
  const hex = /^#[0-9a-f]{6}$/;
  assert.match(SHARED_PALETTE.team, hex);
  assert.ok(SHARED_PALETTE.shadow.offset > 0 && SHARED_PALETTE.shadow.alpha > 0 && SHARED_PALETTE.shadow.alpha < 1);
  for (const [name, c] of Object.entries(SHARED_PALETTE.materials)) assert.match(c, hex, name);
  const keys = Object.keys(SHARED_PALETTE.terrain.temperate).sort();
  for (const biome of ['temperate', 'snow', 'desert']) {
    const t = SHARED_PALETTE.terrain[biome];
    assert.deepEqual(Object.keys(t).sort(), keys, `${biome} has the same terrain keys`);
    for (const [k, c] of Object.entries(t)) for (const v of [c].flat()) assert.match(v, hex, `${biome} ${k}`);
  }
});

// ---- Size against the original sprites ------------------------------------------------------------
//
// The original extent of an actor is the decoration bounds of the original art, else its selection bounds
// (render-facts.js ORIGINAL_BOUNDS, 1/1024 cell around the actor's centre): health bars are drawn around them, so
// they say how big the original sprite looks. Bounds smaller than the footprint and centred on it (no centre offset,
// no bounds offset) are a selection box round the middle of a sprite that fills the whole footprint (the service
// depot, the naval yard, the sub pen): they count as the full footprint, as in the 2D minimal size test. WebRA's own actors (data/webra/rules.yaml) use their own rules' bounds; a husk is measured against
// the actor it was; structures without bounds (village houses, trees, rocks, props) use their footprint less its
// bib rows. tools/gen_minimal3d/extents.py reads the same numbers to build the models.
//
// A structure with bounds fills that box: its front edge on the box's bottom (on the footprint's front when the
// original draws a bib, which the 3D model draws as its apron), its front corners on the box's sides and its highest
// point at the box's top (the back leans east by the pack's ground shear, so only the front-right corner is
// compared on the right). Props (barrels, ammunition, the lighthouse, the windmill, bridge huts, barbed wire) and everything
// measured against its footprint stand inside their box; bridges lie flat on their cells and are left out. A unit,
// union over its facings, has the longer side of its box.

const rules = JSON.parse(source('../../../engine/rules.json'));
const byId = new Map(rules.actors.map((a) => [a.id, a]));
const PX = 24 / 1024;
// Pixels a structure may be off at each edge (a fraction of the box, at least a few pixels: blocks are whole
// shapes, not traced outlines), and the share a unit may differ in width or height.
const EDGE_TOL = (size) => Math.max(3, 0.08 * size);
const UNIT_TOL = 0.15;
const PROPS = new Set(['BARL', 'BRL3', 'AMMOBOX1', 'AMMOBOX2', 'AMMOBOX3', 'LHUS', 'WINDMILL', 'BRIDGEHUT', 'BRIDGEHUT.small', 'BARB']);
const BRIDGE = /^(BRIDGE\d|SBRIDGE\d|BR\d)$/;

/** Bounds and DecorationBounds of WebRA's own actors (data/webra/rules.yaml), read like ORIGINAL_BOUNDS. */
function webraBounds() {
  const out = {};
  let actor = null;
  for (const line of source('../../../data/webra/rules.yaml').split('\n')) {
    const head = line.match(/^([A-Za-z0-9.]+):/);
    if (head) {
      actor = head[1];
      continue;
    }
    const m = line.match(/^\t\t(Bounds|DecorationBounds): *([-\d, ]+)$/);
    if (m && actor) {
      const nums = m[2].replace(/ /g, '').split(',').map(Number);
      (out[actor] ??= {})[m[1] === 'Bounds' ? 'bounds' : 'decoration'] = [...nums, 0, 0].slice(0, 4);
    }
  }
  return out;
}
const WEBRA_BOUNDS = webraBounds();

function originalBox(id) {
  const base = id.replace(/\.(Husk|EmptyHusk|FullHusk)$/, '');
  const b = byId.get(id)?.building ?? byId.get(base)?.building;
  const bib = b ? b.footprint.filter((row) => /^=+$/.test(row)).length : 0;
  for (const key of [id, base]) {
    const ob = ORIGINAL_BOUNDS[key] ?? WEBRA_BOUNDS[key];
    const box = ob?.decoration ?? (ob?.bounds?.length ? ob.bounds : null);
    if (!box) continue;
    const from = key === id ? 'bounds' : `bounds of ${key}`;
    const co = b?.center_offset ?? [0, 0];
    if (b && !co[0] && !co[1] && !box[2] && !box[3]) {
      const [fw, fh] = [b.width * 1024, b.height * 1024];
      if (box[0] <= fw && box[1] <= fh && (box[0] < fw || box[1] < fh)) return { w: b.width * 24, h: b.height * 24, x: 0, y: 0, bib, from: `${from} (full footprint)` };
    }
    return { w: box[0] * PX, h: box[1] * PX, x: box[2] * PX, y: box[3] * PX, bib, from };
  }
  if (!b) return null;
  // No bounds: the footprint less its bib rows, around the footprint box centre.
  const co = b.center_offset ?? [0, 0];
  const h = (b.height - bib) * 24;
  return { w: b.width * 24, h, x: -co[0] * PX, y: -b.height * 12 + h / 2 - co[1] * PX, bib, from: 'footprint' };
}

/** Opaque pixels of `rows` of a sheet, in screen pixels from the actor point: {left, right, top, bottom, cols}. */
function extent(sheet, sprite, rows) {
  const [fw, fh] = sprite.frameSize;
  const [ox, oy] = sprite.offset ?? [0, 0];
  const e = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity, cols: new Map() };
  for (const r of rows) {
    for (let y = 0; y < fh; y++) {
      for (let x = 0; x < fw; x++) {
        if (sheet.rgba[((r * fh + y) * sheet.width + x) * 4 + 3] < 250) continue;
        const sx = ox - fw / 2 + x;
        const sy = oy - fh / 2 + y;
        e.left = Math.min(e.left, sx);
        e.right = Math.max(e.right, sx + 1);
        e.top = Math.min(e.top, sy);
        e.bottom = Math.max(e.bottom, sy + 1);
        e.cols.set(sy, Math.max(e.cols.get(sy) ?? -Infinity, sx + 1));
      }
    }
  }
  return e;
}

function union(a, b) {
  const cols = new Map(a.cols);
  for (const [y, x] of b.cols) cols.set(y, Math.max(cols.get(y) ?? -Infinity, x));
  return { left: Math.min(a.left, b.left), right: Math.max(a.right, b.right), top: Math.min(a.top, b.top), bottom: Math.max(a.bottom, b.bottom), cols };
}

let measured = null;
async function measure() {
  if (measured) return measured;
  const { readPack, BUILTIN_LIMITS } = await import('../js/content/packs.js');
  const { BUILTIN_PACKS } = await import('../js/content/index.js');
  const { decodeTestPng } = await import('./content-fixtures.mjs');
  const bytes = new Uint8Array(readFileSync(fileURLToPath(new URL(`../packs/${BUILTIN_PACKS[0]}`, import.meta.url))));
  const pack = await readPack(bytes, {}, BUILTIN_LIMITS);
  const sheets = new Map();
  const sheet = async (path) => {
    if (!sheets.has(path)) sheets.set(path, await decodeTestPng(pack.files.get(path)));
    return sheets.get(path);
  };
  const out = [];
  for (const a of rules.actors) {
    const sprites = pack.manifest.sprites.filter((s) => s.actor === a.id && (s.pose ?? 'idle') === 'idle' && !s.hidden);
    const body = sprites.find((s) => (s.part ?? 'body') === 'body');
    const box = originalBox(a.id);
    if (!body || !box || BRIDGE.test(a.id)) continue;
    const structure = a.kind === 'building';
    // A structure with its turret; a unit with its turret (not a rotor, not a soldier's prone pose).
    const parts = structure ? sprites : sprites.filter((s) => s === body || (a.kind !== 'infantry' && s.facings === body.facings));
    let e = null;
    for (const s of parts) {
      const rows = structure ? [0] : [...Array(s.facings).keys()];
      const x = extent(await sheet(s.image), s, rows);
      e = e ? union(e, x) : x;
    }
    const co = a.building?.center_offset ?? [0, 0];
    const bottom = box.bib ? a.building.height * 12 - co[1] * PX : box.y + box.h / 2;
    const want = { left: box.x - box.w / 2, right: box.x + box.w / 2, top: box.y - box.h / 2, bottom };
    let frontRight = -Infinity;
    for (const [y, x] of e.cols) if (y >= e.bottom - 3) frontRight = Math.max(frontRight, x);
    const fill = structure && box.from.startsWith('bounds') && !PROPS.has(a.id);
    out.push({ id: a.id, kind: a.kind, structure, fill, box, want, got: { ...e, frontRight, w: e.right - e.left, h: e.bottom - e.top } });
  }
  measured = out;
  return out;
}

function deviations(m) {
  if (m.structure) {
    return {
      bottom: m.got.bottom - m.want.bottom,
      top: m.got.top - m.want.top,
      left: m.got.left - m.want.left,
      right: m.got.frontRight - m.want.right,
    };
  }
  return { width: m.got.w / m.box.w - 1, height: m.got.h / m.box.h - 1 };
}

test('size report (SIZE_REPORT=1 prints every actor)', { skip: !process.env.SIZE_REPORT }, async () => {
  for (const m of await measure()) {
    const d = deviations(m);
    if (!m.structure) d.longer = Math.max(m.got.w, m.got.h) / Math.max(m.box.w, m.box.h) - 1;
    const fmt = Object.entries(d).map(([k, v]) => `${k} ${m.structure ? v.toFixed(1) : (v * 100).toFixed(0) + '%'}`).join(', ');
    const how = m.structure ? (m.fill ? 'fills' : 'inside') : 'unit';
    console.log(`${m.id.padEnd(16)} ${m.kind.padEnd(9)} ${how.padEnd(6)} box ${m.box.w.toFixed(0)}x${m.box.h.toFixed(0)} (${m.box.from}) drawn ${m.got.w}x${m.got.h}: ${fmt}`);
  }
});

test('every structure fills its original box: front edge, front corners and top within a few pixels', async () => {
  const fill = (await measure()).filter((x) => x.fill);
  assert.ok(fill.length >= 45, `${fill.length} structures measured`);
  const bad = [];
  for (const m of fill) {
    for (const [k, v] of Object.entries(deviations(m))) {
      const size = k === 'left' || k === 'right' ? m.box.w : m.box.h;
      if (Math.abs(v) > EDGE_TOL(size)) bad.push(`${m.id} ${k} ${v.toFixed(1)} px (box ${m.box.w.toFixed(0)} x ${m.box.h.toFixed(0)}, ${m.box.from})`);
    }
  }
  assert.deepEqual(bad, []);
});

test('props, trees and village pieces stand inside their box and on its front edge or behind it', async () => {
  const inside = (await measure()).filter((x) => x.structure && !x.fill);
  assert.ok(inside.length > 100, `${inside.length} pieces measured`);
  const bad = [];
  for (const m of inside) {
    const d = deviations(m);
    const tol = (size) => EDGE_TOL(size);
    if (d.bottom > tol(m.box.h)) bad.push(`${m.id} reaches ${d.bottom.toFixed(1)} px below its box`);
    if (d.top < -tol(m.box.h)) bad.push(`${m.id} reaches ${(-d.top).toFixed(1)} px above its box`);
    if (d.left < -tol(m.box.w)) bad.push(`${m.id} reaches ${(-d.left).toFixed(1)} px left of its box`);
    if (d.right > tol(m.box.w)) bad.push(`${m.id} reaches ${d.right.toFixed(1)} px right of its box at the front`);
  }
  assert.deepEqual(bad, []);
});

test('every unit is as big as its original box: the longer side drawn against the box\'s longer side', async () => {
  // The measure the 2D minimal unit size test uses too, so 2D and 3D agree: the
  // longer side of the drawn unit (body and turret, union over the facings) within 15 % of the longer side of
  // its DecorationBounds, else Bounds. No unit may be taller on screen than its box either.
  const units = (await measure()).filter((x) => !x.structure);
  assert.ok(units.length > 60, `${units.length} units measured`);
  const bad = [];
  for (const m of units) {
    const longer = Math.max(m.got.w, m.got.h) / Math.max(m.box.w, m.box.h) - 1;
    if (Math.abs(longer) > UNIT_TOL) bad.push(`${m.id} longer side ${(longer * 100).toFixed(0)}% (box ${m.box.w.toFixed(0)} x ${m.box.h.toFixed(0)}, drawn ${m.got.w} x ${m.got.h})`);
    if (m.got.h > m.box.h * (1 + UNIT_TOL)) bad.push(`${m.id} is ${m.got.h} px high for a box ${m.box.h.toFixed(0)} px high`);
  }
  assert.deepEqual(bad, [], 'units off their original size');
});

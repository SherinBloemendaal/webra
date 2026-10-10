// Editing operations on a MapDoc, with symmetry. No DOM; every function works
// inside the caller's open transaction (doc.begin / doc.commit).

import { LIMITS, TERRAIN, catalogEntry, decodeBase64, encodeBase64, footprintOf, holdsResource, isBuildable, isPassable } from './mapformat.js';
import { validateActorState } from '../../js/protocol.js';
import { SPAWN_H, SPAWN_W, applyTransform, mirroredOwner, symmetricPositions, transformCell, transformFacing, transformsFor } from './symmetry.js';

export const BRUSH_SIZES = [1, 3, 5, 9];

/** Cells covered by a round brush of `size` (1, 3, 5, 9) centred on (cx, cy). */
export function brushCells(cx, cy, size) {
  const r = (size - 1) / 2;
  const out = [];
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy <= r * r + r) out.push([cx + dx, cy + dy]);
    }
  }
  return out;
}

/** Cells on the line from (x0, y0) to (x1, y1) (Bresenham), both ends included. */
export function lineCells(x0, y0, x1, y1) {
  const out = [];
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0;
  let y = y0;
  for (;;) {
    out.push([x, y]);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
  return out;
}

/** Repeat single cells at their symmetric positions. */
function eachSymmetricCell(doc, cells, symmetry, fn) {
  const seen = new Set();
  for (const [x, y] of cells) {
    for (const p of symmetricPositions(symmetry, x, y, doc.width, doc.height)) {
      if (!doc.inside(p.x, p.y)) continue;
      const i = doc.idx(p.x, p.y);
      if (seen.has(i)) continue;
      seen.add(i);
      fn(p.x, p.y);
    }
  }
}

/** Paint terrain. Impassable terrain clears ore (like the engine). */
export function paintTerrain(doc, cells, material, symmetry) {
  eachSymmetricCell(doc, cells, symmetry, (x, y) => doc.setCell(x, y, material, undefined));
}

/**
 * Paint ore density (0 removes ore). Only passable cells can hold ore; others
 * are skipped. Ore replaces gems on the cells it is painted on.
 */
export function paintOre(doc, cells, density, symmetry) {
  const d = Math.max(0, Math.min(LIMITS.maxOre, density | 0));
  eachSymmetricCell(doc, cells, symmetry, (x, y) => {
    if (holdsResource(doc.terrain[doc.idx(x, y)])) doc.setCell(x, y, undefined, d);
  });
}

/**
 * Paint gem density (0 removes gems). Only passable cells can hold gems;
 * others are skipped. Gems replace ore on the cells they are painted on.
 */
export function paintGems(doc, cells, density, symmetry) {
  const d = Math.max(0, Math.min(LIMITS.maxGems, density | 0));
  eachSymmetricCell(doc, cells, symmetry, (x, y) => {
    if (holdsResource(doc.terrain[doc.idx(x, y)])) doc.setCell(x, y, undefined, undefined, d);
  });
}

/** Eraser: back to clear ground without ore or gems, and remove actors touching the cells. */
export function erase(doc, cells, symmetry, catalog) {
  const hit = new Set();
  eachSymmetricCell(doc, cells, symmetry, (x, y) => {
    doc.setCell(x, y, TERRAIN.CLEAR, 0, 0);
    hit.add(doc.idx(x, y));
  });
  const doomed = doc.actors.filter((a) => actorCells(a, catalog).some(([x, y]) => hit.has(doc.idx(x, y))));
  if (doomed.length) {
    doc.touchObjects();
    // touchObjects snapshots but keeps the same array objects for live editing.
    doc.actors = doc.actors.filter((a) => !doomed.includes(a));
  }
  return doomed.length;
}

/** Flood fill the 4-connected region of equal terrain at (x, y), at every symmetric seed. */
export function fill(doc, x, y, material, symmetry) {
  for (const p of symmetricPositions(symmetry, x, y, doc.width, doc.height)) {
    if (!doc.inside(p.x, p.y)) continue;
    const from = doc.terrain[doc.idx(p.x, p.y)];
    if (from === material) continue;
    const { width: w, height: h } = doc;
    const seen = new Uint8Array(w * h);
    const stack = [doc.idx(p.x, p.y)];
    seen[stack[0]] = 1;
    while (stack.length) {
      const i = stack.pop();
      const cx = i % w;
      const cy = (i - cx) / w;
      doc.setCell(cx, cy, material, undefined);
      const visit = (j) => {
        if (!seen[j] && doc.terrain[j] === from) {
          seen[j] = 1;
          stack.push(j);
        }
      };
      if (cx > 0) visit(i - 1);
      if (cx < w - 1) visit(i + 1);
      if (cy > 0) visit(i - w);
      if (cy < h - 1) visit(i + w);
    }
  }
}

/** Fill the rectangle between two corner cells (inclusive) with terrain. */
export function fillRect(doc, x0, y0, x1, y1, material, symmetry) {
  const cells = [];
  const [ax, bx] = [Math.max(0, Math.min(x0, x1)), Math.min(doc.width - 1, Math.max(x0, x1))];
  const [ay, by] = [Math.max(0, Math.min(y0, y1)), Math.min(doc.height - 1, Math.max(y0, y1))];
  for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) cells.push([x, y]);
  paintTerrain(doc, cells, material, symmetry);
}

// ---- Actors ----------------------------------------------------------------------

/** Width and height of an actor's footprint box in cells. */
export function actorSize(info) {
  return info?.kind === 'building' ? [info.width, info.height] : [1, 1];
}

/** Cells `[x, y, kind]` an actor covers (kind 1 occupied, 2 passable bib). */
export function actorCells(a, catalog) {
  return footprintOf(catalogEntry(catalog, a.type)).map(([dx, dy, c]) => [a.x + dx, a.y + dy, c]);
}

/**
 * Why an actor cannot go at (x, y), or null when it can. `ignore` is a set of
 * actors to leave out of the overlap test (the ones being moved).
 */
export function placementProblem(doc, catalog, type, x, y, ignore = null) {
  const info = catalogEntry(catalog, type);
  if (!info) return 'unknown actor';
  const cells = footprintOf(info);
  const occupied = new Set();
  const units = new Set();
  for (const a of doc.actors) {
    if (ignore?.has(a)) continue;
    const ai = catalogEntry(catalog, a.type);
    if (ai?.kind === 'building') {
      for (const [cx, cy, c] of actorCells(a, catalog)) if (c === 1) occupied.add(doc.idx(cx, cy));
    } else {
      units.add(doc.idx(a.x, a.y));
    }
  }
  for (const [dx, dy, c] of cells) {
    const cx = x + dx;
    const cy = y + dy;
    if (!doc.inside(cx, cy)) return 'outside the map';
    const i = doc.idx(cx, cy);
    const t = doc.terrain[i];
    // A bridge brings its own terrain (stampBridge) and takes no cell.
    if (c === 3) continue;
    if (info.kind === 'building' && c === 1) {
      if (!isBuildable(t)) return 'needs clear ground';
      if (occupied.has(i) || units.has(i)) return 'overlaps another actor';
    } else {
      if (!isPassable(t)) return 'needs passable ground';
      if (occupied.has(i) || (info.kind !== 'building' && units.has(i))) return 'overlaps another actor';
    }
  }
  return null;
}

/**
 * Place an actor and its symmetric copies (owners and facings mirrored).
 * Copies that do not fit are skipped. Returns the actors added.
 */
export function placeActor(doc, catalog, { type, owner, x, y, facing }, symmetry) {
  const info = catalogEntry(catalog, type);
  const [fw, fh] = actorSize(info);
  const added = [];
  for (const p of symmetricPositions(symmetry, x, y, doc.width, doc.height, fw, fh)) {
    if (placementProblem(doc, catalog, type, p.x, p.y)) continue;
    doc.touchObjects();
    const a = {
      type,
      owner: mirroredOwner(p.t, owner, doc.spawns, doc.width, doc.height),
      x: p.x,
      y: p.y,
      facing: info.kind === 'building' ? 0 : transformFacing(p.t, facing),
    };
    doc.actors.push(a);
    added.push(a);
    stampBridge(doc, info, p.x, p.y);
  }
  return added;
}

/**
 * A bridge placed in the editor brings its healthy template's terrain (the
 * deck and its banks, engine bridges.rs: a game stamps it too when the
 * ground matches no state of the bridge) for the map's biome. Other actors
 * change nothing.
 */
export function stampBridge(doc, info, x, y) {
  const templates = info?.world?.bridge;
  if (!templates) return;
  const t = templates[doc.meta?.biome ?? 'temperate'] ?? Object.values(templates)[0];
  if (!t) return;
  t.healthy.forEach((row, dy) => {
    [...row].forEach((ch, dx) => {
      const terrain = BRIDGE_LETTERS[ch];
      if (terrain === undefined || !doc.inside(x + dx, y + dy)) return;
      doc.setCell(x + dx, y + dy, terrain);
    });
  });
}

/** OpenRA terrain letters of bridge templates (engine map.rs Terrain::from_letter). */
const BRIDGE_LETTERS = Object.freeze({
  c: TERRAIN.CLEAR,
  r: TERRAIN.ROUGH,
  k: TERRAIN.ROCK,
  w: TERRAIN.WATER,
  t: TERRAIN.TREE,
  d: TERRAIN.ROAD,
  g: TERRAIN.BRIDGE,
  b: TERRAIN.BEACH,
  v: TERRAIN.RIVER,
  l: TERRAIN.WALL,
});

/** The top-most actor covering cell (x, y), or null. Units win over the building under them. */
export function actorAt(doc, catalog, x, y) {
  for (let k = doc.actors.length - 1; k >= 0; k--) {
    const a = doc.actors[k];
    if (catalogEntry(catalog, a.type)?.kind !== 'building' && a.x === x && a.y === y) return a;
  }
  for (let k = doc.actors.length - 1; k >= 0; k--) {
    const a = doc.actors[k];
    if (actorCells(a, catalog).some(([cx, cy]) => cx === x && cy === y)) return a;
  }
  return null;
}

/** Actors whose footprint intersects the rectangle between two cells. */
export function actorsInRect(doc, catalog, x0, y0, x1, y1) {
  const [ax, bx] = [Math.min(x0, x1), Math.max(x0, x1)];
  const [ay, by] = [Math.min(y0, y1), Math.max(y0, y1)];
  return doc.actors.filter((a) => actorCells(a, catalog).some(([x, y]) => x >= ax && x <= bx && y >= ay && y <= by));
}

/** Delete actors (by identity). */
export function deleteActors(doc, list) {
  if (!list.length) return;
  const set = new Set(list);
  doc.touchObjects();
  doc.actors = doc.actors.filter((a) => !set.has(a));
}

// ---- Spawns ----------------------------------------------------------------------

/** Index of the spawn whose 3 x 4 construction yard box covers (x, y), or -1. */
export function spawnAt(doc, x, y) {
  for (let k = doc.spawns.length - 1; k >= 0; k--) {
    const [sx, sy] = doc.spawns[k];
    if (x >= sx && x < sx + SPAWN_W && y >= sy && y < sy + SPAWN_H) return k;
  }
  return -1;
}

/** Clamp a spawn's top-left cell so its yard box stays inside the map. */
export function clampSpawn(doc, x, y) {
  return [Math.max(0, Math.min(doc.width - SPAWN_W, x)), Math.max(0, Math.min(doc.height - SPAWN_H, y))];
}

/** Add a spawn and its symmetric copies, up to the 8 spawn limit. Returns the new indices. */
export function addSpawns(doc, x, y, symmetry) {
  const [cx, cy] = clampSpawn(doc, x, y);
  const added = [];
  for (const p of symmetricPositions(symmetry, cx, cy, doc.width, doc.height, SPAWN_W, SPAWN_H)) {
    if (doc.spawns.length >= LIMITS.maxSpawns) break;
    if (doc.spawns.some(([sx, sy]) => sx === p.x && sy === p.y)) continue;
    doc.touchObjects();
    doc.spawns.push([p.x, p.y]);
    added.push(doc.spawns.length - 1);
  }
  return added;
}

/**
 * Spawns that mirror spawn `k` under the symmetry mode, as `{ k, t }` (identity
 * excluded), so dragging one spawn moves its partners too.
 */
export function spawnPartners(doc, k, symmetry) {
  const out = [];
  const [sx, sy] = doc.spawns[k];
  for (const t of transformsFor(symmetry, doc.width, doc.height).slice(1)) {
    const [mx, my] = applyTransform(t, sx, sy, doc.width, doc.height, SPAWN_W, SPAWN_H);
    const j = doc.spawns.findIndex(([x, y], i) => i !== k && x === mx && y === my);
    if (j >= 0 && !out.some((o) => o.k === j)) out.push({ k: j, t });
  }
  return out;
}

// ---- Shapes ------------------------------------------------------------------------

/** Cells of a line from (x0, y0) to (x1, y1) drawn with a round brush of `size`. */
export function thickLineCells(x0, y0, x1, y1, size) {
  const seen = new Set();
  const out = [];
  for (const [lx, ly] of lineCells(x0, y0, x1, y1)) {
    for (const [x, y] of brushCells(lx, ly, size)) {
      const key = `${x},${y}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push([x, y]);
    }
  }
  return out;
}

/**
 * Cells of the ellipse inscribed in the box between two corner cells
 * (inclusive): every cell inside it when `filled`, else its outline (inside
 * cells with a 4-neighbour outside), so the ring is closed and one cell thick.
 */
export function ellipseCells(x0, y0, x1, y1, filled = false) {
  const [ax, bx] = [Math.min(x0, x1), Math.max(x0, x1)];
  const [ay, by] = [Math.min(y0, y1), Math.max(y0, y1)];
  const cx = (ax + bx) / 2;
  const cy = (ay + by) / 2;
  const rx = (bx - ax + 1) / 2;
  const ry = (by - ay + 1) / 2;
  const inside = (x, y) => x >= ax && x <= bx && y >= ay && y <= by && ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
  const out = [];
  for (let y = ay; y <= by; y++) {
    for (let x = ax; x <= bx; x++) {
      if (!inside(x, y)) continue;
      if (filled || !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1)) out.push([x, y]);
    }
  }
  return out;
}

/** Cells of the box between two corner cells (inclusive): all of them, or its border. */
export function rectCells(x0, y0, x1, y1, filled = true) {
  const [ax, bx] = [Math.min(x0, x1), Math.max(x0, x1)];
  const [ay, by] = [Math.min(y0, y1), Math.max(y0, y1)];
  const out = [];
  for (let y = ay; y <= by; y++) {
    for (let x = ax; x <= bx; x++) if (filled || x === ax || x === bx || y === ay || y === by) out.push([x, y]);
  }
  return out;
}

/**
 * Shores: land cells (clear or rough ground) next to water become beach,
 * the way coasts look in Red Alert maps. `cells` are the cells just painted
 * (with their symmetric copies); their neighbours are checked. Returns how
 * many cells became beach.
 */
export function autoShore(doc, cells, symmetry) {
  const touched = new Set();
  eachSymmetricCell(doc, cells, symmetry, (x, y) => touched.add(doc.idx(x, y)));
  const candidates = new Set();
  for (const i of touched) {
    const x = i % doc.width;
    const y = (i - x) / doc.width;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) if (doc.inside(x + dx, y + dy)) candidates.add(doc.idx(x + dx, y + dy));
    }
  }
  let n = 0;
  for (const i of candidates) {
    const t = doc.terrain[i];
    if (t !== TERRAIN.CLEAR && t !== TERRAIN.ROUGH) continue;
    const x = i % doc.width;
    const y = (i - x) / doc.width;
    const wet = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => doc.inside(x + dx, y + dy) && doc.terrain[doc.idx(x + dx, y + dy)] === TERRAIN.WATER);
    if (!wet) continue;
    doc.setCell(x, y, TERRAIN.BEACH, 0, 0);
    n++;
  }
  return n;
}

// ---- Regions: copy, cut, paste, stamps -------------------------------------------------

/**
 * A region of the map as data (the clipboard, stamps): `w` x `h` cells of
 * terrain, ore and gems, and the actors whose top-left cell lies inside,
 * relative to the region (`dx`, `dy`). Spawns are not part of a region.
 */
export function copyRegion(doc, catalog, x0, y0, x1, y1) {
  const [ax, bx] = [Math.max(0, Math.min(x0, x1)), Math.min(doc.width - 1, Math.max(x0, x1))];
  const [ay, by] = [Math.max(0, Math.min(y0, y1)), Math.min(doc.height - 1, Math.max(y0, y1))];
  const w = bx - ax + 1;
  const h = by - ay + 1;
  const terrain = new Uint8Array(w * h);
  const ore = new Uint8Array(w * h);
  const gems = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = doc.idx(ax + x, ay + y);
      terrain[y * w + x] = doc.terrain[i];
      ore[y * w + x] = doc.ore[i];
      gems[y * w + x] = doc.gems[i];
    }
  }
  const actors = doc.actors
    .filter((a) => catalogEntry(catalog, a.type) && a.x >= ax && a.x <= bx && a.y >= ay && a.y <= by)
    .map(({ x, y, ...a }) => ({ ...a, facing: a.facing ?? 0, dx: x - ax, dy: y - ay }));
  return { w, h, terrain, ore, gems, actors };
}

/** Clear a region: clear ground without ore or gems, and remove the actors whose top-left cell is inside. */
export function clearRegion(doc, catalog, x0, y0, x1, y1) {
  const [ax, bx] = [Math.max(0, Math.min(x0, x1)), Math.min(doc.width - 1, Math.max(x0, x1))];
  const [ay, by] = [Math.max(0, Math.min(y0, y1)), Math.min(doc.height - 1, Math.max(y0, y1))];
  for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) doc.setCell(x, y, TERRAIN.CLEAR, 0, 0);
  deleteActors(
    doc,
    doc.actors.filter((a) => a.x >= ax && a.x <= bx && a.y >= ay && a.y <= by),
  );
}

/**
 * A region turned or mirrored: `op` is 'rotate' (a quarter turn clockwise),
 * 'flipX' or 'flipY'. Actors keep their orientation; their boxes follow the
 * turned region and units turn with it.
 */
export function transformRegion(clip, catalog, op) {
  const tr = op === 'rotate' ? { swap: true, fx: true, fy: false } : op === 'flipX' ? { swap: false, fx: true, fy: false } : { swap: false, fx: false, fy: true };
  const [w, h] = tr.swap ? [clip.h, clip.w] : [clip.w, clip.h];
  const out = { w, h, terrain: new Uint8Array(w * h), ore: new Uint8Array(w * h), gems: new Uint8Array(w * h), actors: [] };
  for (let y = 0; y < clip.h; y++) {
    for (let x = 0; x < clip.w; x++) {
      const [nx, ny] = transformCell(tr, x, y, clip.w, clip.h);
      const j = ny * w + nx;
      const i = y * clip.w + x;
      out.terrain[j] = clip.terrain[i];
      out.ore[j] = clip.ore[i];
      out.gems[j] = clip.gems[i];
    }
  }
  for (const a of clip.actors) {
    const info = catalogEntry(catalog, a.type);
    const [fw, fh] = actorSize(info);
    const [nx, ny] = applyRegionTransform(tr, a.dx, a.dy, clip.w, clip.h, fw, fh);
    out.actors.push({ ...a, dx: nx, dy: ny, facing: info?.kind === 'building' ? a.facing : transformFacing(tr, a.facing) });
  }
  return out;
}

/** applyTransform for a region that need not be square (the turned region has its own size). */
function applyRegionTransform(tr, x, y, w, h, fw, fh) {
  if (!tr.swap) return applyTransform(tr, x, y, w, h, fw, fh);
  // Centre in doubled units, swapped, then mirrored inside the turned region (h wide, w tall).
  let cx = 2 * y + fh;
  let cy = 2 * x + fw;
  if (tr.fx) cx = 2 * h - cx;
  if (tr.fy) cy = 2 * w - cy;
  return [Math.round((cx - fw) / 2), Math.round((cy - fh) / 2)];
}

/**
 * Paste a region with its top-left cell at (x, y), and its symmetric copies
 * (each mirrored or turned like the mode does, owners and facings with it).
 * `layers` picks what is pasted: { terrain, resources, actors }. Cells off
 * the map are cut off; actors that do not fit (off the map, on the wrong
 * ground, overlapping) are skipped. Returns { cells, actors, skipped }.
 */
export function pasteRegion(doc, catalog, clip, x, y, symmetry, layers = { terrain: true, resources: true, actors: true }) {
  const result = { cells: 0, actors: 0, skipped: 0 };
  for (const p of symmetricPositions(symmetry, x, y, doc.width, doc.height, clip.w, clip.h)) {
    const c = regionUnder(clip, catalog, p.t);
    for (let cy = 0; cy < c.h; cy++) {
      for (let cx = 0; cx < c.w; cx++) {
        const mx = p.x + cx;
        const my = p.y + cy;
        if (!doc.inside(mx, my)) continue;
        const i = cy * c.w + cx;
        const t = layers.terrain ? c.terrain[i] : undefined;
        const res = layers.resources;
        doc.setCell(mx, my, t, res ? c.ore[i] : undefined, res ? c.gems[i] : undefined);
        result.cells++;
      }
    }
    if (!layers.actors) continue;
    for (const a of c.actors) {
      const ax = p.x + a.dx;
      const ay = p.y + a.dy;
      if (placementProblem(doc, catalog, a.type, ax, ay)) {
        result.skipped++;
        continue;
      }
      doc.touchObjects();
      const { dx: _dx, dy: _dy, ...rest } = a;
      doc.actors.push({ ...rest, owner: mirroredOwner(p.t, a.owner, doc.spawns, doc.width, doc.height), x: ax, y: ay });
      result.actors++;
    }
  }
  return result;
}

/** A region under a symmetry transform (as pasted at a mirrored position). */
function regionUnder(clip, catalog, tr) {
  let c = clip;
  if (tr.swap) c = transformRegion(transformRegion(c, catalog, 'rotate'), catalog, 'flipX');
  if (tr.fx) c = transformRegion(c, catalog, 'flipX');
  if (tr.fy) c = transformRegion(c, catalog, 'flipY');
  return c;
}

/** A region as JSON-safe data (stamps are stored this way), and back. */
export function regionToData(clip) {
  return { w: clip.w, h: clip.h, terrain: encodeBase64(clip.terrain), ore: encodeBase64(clip.ore), gems: encodeBase64(clip.gems), actors: clip.actors.map((a) => ({ ...a })) };
}

export function regionFromData(d) {
  const n = d.w * d.h;
  const layer = (s) => {
    const b = decodeBase64(s);
    if (b.length !== n) throw new Error('the stamp is damaged');
    return b;
  };
  if (!Number.isInteger(d.w) || !Number.isInteger(d.h) || d.w < 1 || d.h < 1 || n > LIMITS.maxSize * LIMITS.maxSize) throw new Error('the stamp is damaged');
  const actor = (a) => {
    let state = {};
    try {
      state = validateActorState(a, 'stamp actor');
    } catch {
      // A damaged state field: the actor keeps its defaults.
    }
    return { type: String(a.type), owner: a.owner | 0, dx: a.dx | 0, dy: a.dy | 0, facing: a.facing | 0, ...state };
  };
  return { w: d.w, h: d.h, terrain: layer(d.terrain), ore: layer(d.ore), gems: layer(d.gems), actors: Array.isArray(d.actors) ? d.actors.filter((a) => a && typeof a === 'object').map(actor) : [] };
}

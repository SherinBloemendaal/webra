// Whole-map changes: resize (with an anchor), crop to a region, shift, turn
// and mirror. Pure module: each takes a map file object and returns a new
// one (the editor applies it as one undoable step, MapDoc.replace) and what
// had to go: spawns and actors that end up off the map are dropped.
//
// Structures keep their orientation (Red Alert art has one): when the map
// turns, a structure's box is placed around its turned centre; units turn
// with the map. Bridges are terrain templates in one direction, so turning a
// map with bridges leaves them for the validation to report.

import { decodeLayers, encodeBase64, formatFor, LIMITS, TERRAIN, catalogEntry } from './mapformat.js';
import { SPAWN_H, SPAWN_W, applyTransform, transformCell, transformFacing } from './symmetry.js';
import { actorSize } from './edits.js';

/** A new map with these layers, keeping everything else of `map`. */
function withLayers(map, width, height, terrain, ore, gems, spawns, actors) {
  const format = formatFor(gems);
  const out = { ...map, format, width, height, terrain: encodeBase64(terrain), ore: encodeBase64(ore), spawns, actors };
  if (format === 1) delete out.gems;
  else out.gems = encodeBase64(gems);
  return out;
}

const inBox = (x, y, fw, fh, w, h) => x >= 0 && y >= 0 && x + fw <= w && y + fh <= h;

/**
 * Resize to `width` x `height`. `ox`, `oy`: where the old map's top-left
 * cell lands in the new one (negative: cut off on that side). New cells are
 * `fill` terrain. Returns { map, dropped: { spawns, actors } }.
 */
export function resizeMap(map, catalog, width, height, ox, oy, fill = TERRAIN.CLEAR) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < LIMITS.minSize || height < LIMITS.minSize || width > LIMITS.maxSize || height > LIMITS.maxSize) {
    throw new Error(`Width and height must be ${LIMITS.minSize} to ${LIMITS.maxSize} cells.`);
  }
  const src = decodeLayers(map);
  const n = width * height;
  const terrain = new Uint8Array(n).fill(fill);
  const ore = new Uint8Array(n);
  const gems = new Uint8Array(n);
  for (let y = 0; y < map.height; y++) {
    const ny = y + oy;
    if (ny < 0 || ny >= height) continue;
    for (let x = 0; x < map.width; x++) {
      const nx = x + ox;
      if (nx < 0 || nx >= width) continue;
      const i = y * map.width + x;
      const j = ny * width + nx;
      terrain[j] = src.terrain[i];
      ore[j] = src.ore[i];
      gems[j] = src.gems[i];
    }
  }
  const dropped = { spawns: 0, actors: 0 };
  const spawns = [];
  // Old spawn index -> new one (-1: dropped).
  const renumber = [];
  for (const [x, y] of map.spawns ?? []) {
    if (inBox(x + ox, y + oy, SPAWN_W, SPAWN_H, width, height)) {
      renumber.push(spawns.length);
      spawns.push([x + ox, y + oy]);
    } else {
      renumber.push(-1);
      dropped.spawns++;
    }
  }
  const actors = [];
  for (const a of map.actors ?? []) {
    const [fw, fh] = actorSize(catalogEntry(catalog, a.type));
    if (!inBox(a.x + ox, a.y + oy, fw, fh, width, height)) {
      dropped.actors++;
      continue;
    }
    // Actors of a spawn that went become neutral; the rest follow their spawn's new number.
    const owner = a.owner >= 0 ? (renumber[a.owner] ?? -1) : a.owner;
    if (owner !== a.owner && owner < 0) dropped.owners = (dropped.owners ?? 0) + 1;
    actors.push({ ...a, owner, x: a.x + ox, y: a.y + oy });
  }
  return { map: withLayers(map, width, height, terrain, ore, gems, spawns, actors), dropped };
}

/** Crop to the region between two corner cells (inclusive). */
export function cropMap(map, catalog, x0, y0, x1, y1) {
  const [ax, bx] = [Math.min(x0, x1), Math.max(x0, x1)];
  const [ay, by] = [Math.min(y0, y1), Math.max(y0, y1)];
  return resizeMap(map, catalog, bx - ax + 1, by - ay + 1, -ax, -ay);
}

/** Shift everything by (dx, dy) cells inside the same size; uncovered cells get `fill`. */
export function shiftMap(map, catalog, dx, dy, fill = TERRAIN.CLEAR) {
  return resizeMap(map, catalog, map.width, map.height, dx, dy, fill);
}

/**
 * Turn the map clockwise by `quarters` quarter turns, or mirror it
 * (`op` 'flipX' left to right, 'flipY' top to bottom).
 */
export function turnMap(map, catalog, op) {
  const tr = { rotate90: { swap: true, fx: true, fy: false }, rotate180: { swap: false, fx: true, fy: true }, rotate270: { swap: true, fx: false, fy: true }, flipX: { swap: false, fx: true, fy: false }, flipY: { swap: false, fx: false, fy: true } }[op];
  if (!tr) throw new Error(`unknown map turn ${op}`);
  const src = decodeLayers(map);
  const [width, height] = tr.swap ? [map.height, map.width] : [map.width, map.height];
  const terrain = new Uint8Array(width * height);
  const ore = new Uint8Array(width * height);
  const gems = new Uint8Array(width * height);
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const [nx, ny] = transformCell(tr, x, y, map.width, map.height);
      const i = y * map.width + x;
      const j = ny * width + nx;
      terrain[j] = src.terrain[i];
      ore[j] = src.ore[i];
      gems[j] = src.gems[i];
    }
  }
  const place = (x, y, fw, fh) => {
    let [nx, ny] = turnBox(tr, x, y, map.width, map.height, fw, fh);
    // A box turned around its centre can stick out by half a cell: keep it on the map.
    nx = Math.max(0, Math.min(width - fw, nx));
    ny = Math.max(0, Math.min(height - fh, ny));
    return [nx, ny];
  };
  const spawns = (map.spawns ?? []).map(([x, y]) => place(x, y, SPAWN_W, SPAWN_H));
  const actors = (map.actors ?? []).map((a) => {
    const info = catalogEntry(catalog, a.type);
    const [fw, fh] = actorSize(info);
    const [x, y] = place(a.x, a.y, fw, fh);
    return { ...a, x, y, facing: info?.kind === 'building' ? (a.facing ?? 0) : transformFacing(tr, a.facing ?? 0) };
  });
  return { map: withLayers(map, width, height, terrain, ore, gems, spawns, actors), dropped: { spawns: 0, actors: 0 } };
}

/** applyTransform for a map that need not be square (a quarter turn swaps its sides). */
function turnBox(tr, x, y, w, h, fw, fh) {
  if (!tr.swap) return applyTransform(tr, x, y, w, h, fw, fh);
  let cx = 2 * y + fh;
  let cy = 2 * x + fw;
  if (tr.fx) cx = 2 * h - cx;
  if (tr.fy) cy = 2 * w - cy;
  return [Math.round((cx - fw) / 2), Math.round((cy - fh) / 2)];
}

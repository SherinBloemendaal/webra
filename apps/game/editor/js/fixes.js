// Quick fixes for problems the validation reports: found on the document
// itself (not by reading messages), each with a place to jump to and an
// action that repairs it as one undoable step. Pure module, no DOM.

import { LIMITS, TERRAIN, canOccupy, catalogEntry, footprintOf, groundFor, isBuildable } from './mapformat.js';
import { SPAWN_H, SPAWN_W } from './symmetry.js';
import { Occupancy, actorCells, deleteActors } from './edits.js';

const yardCells = (x, y) => {
  const out = [];
  for (let dy = 0; dy < SPAWN_H; dy++) for (let dx = 0; dx < SPAWN_W; dx++) out.push([x + dx, y + dy]);
  return out;
};

/** Cells taken by structures (footprint kind 1, on the map), by cell index. */
function structureCells(doc, catalog) {
  const taken = new Set();
  for (const a of doc.actors) {
    if (catalogEntry(catalog, a.type)?.kind !== 'building') continue;
    for (const [cx, cy, c] of actorCells(a, catalog)) if (c === 1 && doc.inside(cx, cy)) taken.add(doc.idx(cx, cy));
  }
  return taken;
}

/** Whether a construction yard fits at (x, y): inside, clear ground, no structure (`taken`), no other yard. */
function yardFits(doc, taken, x, y, except) {
  if (x < 0 || y < 0 || x + SPAWN_W > doc.width || y + SPAWN_H > doc.height) return false;
  for (const [cx, cy] of yardCells(x, y)) {
    const i = doc.idx(cx, cy);
    if (!isBuildable(doc.terrain[i]) || taken.has(i)) return false;
  }
  return doc.spawns.every(([sx, sy], k) => k === except || Math.abs(sx - x) >= SPAWN_W + 1 || Math.abs(sy - y) >= SPAWN_H + 1);
}

/** The free yard position nearest to (x, y) (rings outwards), or null. */
export function nearestYard(doc, catalog, x, y, except = -1) {
  const max = Math.max(doc.width, doc.height);
  const taken = structureCells(doc, catalog);
  for (let r = 0; r <= max; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (yardFits(doc, taken, x + dx, y + dy, except)) return [x + dx, y + dy];
      }
    }
  }
  return null;
}

/**
 * Problems of the document that have a fix: `{ key, level, message, x, y,
 * fixes: [{ label, apply(doc) }] }`. Each `apply` runs inside a transaction
 * the caller opens (doc.begin / doc.commit).
 */
export function findFixes(doc, catalog) {
  const out = [];
  doc.spawns.forEach(([x, y], k) => {
    const n = k + 1;
    if (x < 0 || y < 0 || x + SPAWN_W > doc.width || y + SPAWN_H > doc.height) {
      out.push({
        key: `spawn-out-${k}`,
        level: 'error',
        message: `Spawn ${n} is not inside the map.`,
        x: Math.max(0, Math.min(doc.width - 1, x)),
        y: Math.max(0, Math.min(doc.height - 1, y)),
        fixes: [{ label: 'Move it onto the map', apply: (d) => moveSpawn(d, catalog, k) }],
      });
      return;
    }
    const blocked = yardCells(x, y).some(([cx, cy]) => !isBuildable(doc.terrain[doc.idx(cx, cy)]));
    if (blocked) {
      out.push({
        key: `spawn-ground-${k}`,
        level: 'error',
        message: `Spawn ${n} needs 3x4 clear ground for the construction yard.`,
        x,
        y,
        fixes: [
          {
            label: 'Clear the ground',
            apply: (d) => {
              for (const [cx, cy] of yardCells(x, y)) if (!isBuildable(d.terrain[d.idx(cx, cy)])) d.setCell(cx, cy, TERRAIN.CLEAR, 0, 0);
            },
          },
          { label: 'Move to free ground', apply: (d) => moveSpawn(d, catalog, k) },
        ],
      });
    }
    doc.spawns.forEach(([ox, oy], j) => {
      if (j <= k || Math.abs(ox - x) >= SPAWN_W || Math.abs(oy - y) >= SPAWN_H) return;
      out.push({
        key: `spawn-overlap-${k}-${j}`,
        level: 'error',
        message: `Spawns ${n} and ${j + 1} overlap.`,
        x: ox,
        y: oy,
        fixes: [{ label: `Move spawn ${j + 1} to free ground`, apply: (d) => moveSpawn(d, catalog, j) }],
      });
    });
  });
  if (doc.spawns.length > LIMITS.maxSpawns) {
    out.push({
      key: 'spawns-many',
      level: 'error',
      message: `A map has at most ${LIMITS.maxSpawns} spawns (has ${doc.spawns.length}).`,
      fixes: [
        {
          label: `Remove spawns after ${LIMITS.maxSpawns}`,
          apply: (d) => {
            while (d.spawns.length > LIMITS.maxSpawns) d.removeSpawn(d.spawns.length - 1);
          },
        },
      ],
    });
  }
  // Each actor is checked where it stands, against all the others.
  const occupancy = new Occupancy(doc, catalog);
  doc.actors.forEach((a, i) => {
    const info = catalogEntry(catalog, a.type);
    const label = info?.name ?? a.type;
    const at = { x: Math.max(0, Math.min(doc.width - 1, a.x)), y: Math.max(0, Math.min(doc.height - 1, a.y)) };
    const remove = { label: 'Remove it', apply: (d) => deleteActors(d, [d.actors[i]]) };
    if (!info) {
      out.push({ key: `actor-type-${i}`, level: 'error', message: `Unknown actor type ${a.type}.`, ...at, fixes: [remove] });
      return;
    }
    if (a.owner < -1 || a.owner >= doc.spawns.length) {
      out.push({
        key: `actor-owner-${i}`,
        level: 'error',
        message: `${label} at ${a.x},${a.y} belongs to spawn ${a.owner + 1}, which the map does not have.`,
        ...at,
        fixes: [
          {
            label: 'Make it neutral',
            apply: (d) => {
              d.touchObjects();
              d.actors[i].owner = -1;
            },
          },
          remove,
        ],
      });
    }
    if (footprintOf(info).some(([dx, dy]) => !doc.inside(a.x + dx, a.y + dy))) {
      out.push({ key: `actor-out-${i}`, level: 'error', message: `${label} at ${a.x},${a.y} does not fit inside the map.`, ...at, fixes: [remove] });
      return;
    }
    const problem = occupancy.problem(a.type, a.x, a.y, a);
    if (problem === 'needs clear ground' || problem === 'needs passable ground' || problem === 'needs water') {
      out.push({
        key: `actor-ground-${i}`,
        level: 'warning',
        message: `${label} at ${a.x},${a.y} ${problem}.`,
        ...at,
        fixes: [
          {
            label: problem === 'needs water' ? 'Put water under it' : 'Clear the ground under it',
            apply: (d) => {
              for (const [dx, dy, c] of footprintOf(info)) {
                if (c === 3) continue;
                const t = d.terrain[d.idx(a.x + dx, a.y + dy)];
                if (!canOccupy(info, c, t)) d.setCell(a.x + dx, a.y + dy, groundFor(info), 0, 0);
              }
            },
          },
          remove,
        ],
      });
    } else if (problem === 'overlaps another actor') {
      out.push({ key: `actor-overlap-${i}`, level: 'warning', message: `${label} at ${a.x},${a.y} overlaps another actor.`, ...at, fixes: [remove] });
    }
  });
  return out;
}

function moveSpawn(doc, catalog, k) {
  const [x, y] = doc.spawns[k];
  const to = nearestYard(doc, catalog, Math.max(0, Math.min(doc.width - SPAWN_W, x)), Math.max(0, Math.min(doc.height - SPAWN_H, y)), k);
  if (!to) return false;
  doc.touchObjects();
  doc.spawns[k] = to;
  return true;
}

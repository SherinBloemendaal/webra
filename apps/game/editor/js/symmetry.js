// Symmetry painting: every edit is repeated at its mirrored or rotated
// positions. Pure module. Facing follows the engine: 0..1023, 0 = north,
// clockwise.
//
// A transform is `{ swap, fx, fy }`: swap the axes (mirror on the main
// diagonal), then flip x, then flip y. The modes are groups of transforms:
// mirrors and the half turn work on any map; quarter turns and the
// diagonals need a square map (`needsSquare`), and on other maps they keep
// only the transforms without a swap. The map generator's layouts are the
// left / right mirror (two players) and the four-way mirror (four players in
// two rows): "horizontal" and "quad" here.

const ID = Object.freeze({ swap: false, fx: false, fy: false });
const t = (swap, fx, fy) => Object.freeze({ swap, fx, fy });

export const SYMMETRY_MODES = [
  { id: 'none', label: 'None', transforms: [ID] },
  { id: 'horizontal', label: 'Mirror left / right', transforms: [ID, t(false, true, false)] },
  { id: 'vertical', label: 'Mirror top / bottom', transforms: [ID, t(false, false, true)] },
  { id: 'rotate180', label: 'Rotate 2 (half turn)', transforms: [ID, t(false, true, true)] },
  { id: 'quad', label: 'Mirror 4 (both axes)', transforms: [ID, t(false, true, false), t(false, false, true), t(false, true, true)] },
  // Quarter turns clockwise: 90 = swap then flip x, 270 = swap then flip y.
  { id: 'rotate90', label: 'Rotate 4 (quarter turns)', transforms: [ID, t(true, true, false), t(false, true, true), t(true, false, true)], needsSquare: true },
  { id: 'diagonal', label: 'Mirror diagonal', transforms: [ID, t(true, false, false)], needsSquare: true },
  { id: 'antidiagonal', label: 'Mirror other diagonal', transforms: [ID, t(true, true, true)], needsSquare: true },
  {
    id: 'eight',
    label: 'Mirror 8 (axes and diagonals)',
    transforms: [ID, t(false, true, false), t(false, false, true), t(false, true, true), t(true, false, false), t(true, true, false), t(true, false, true), t(true, true, true)],
    needsSquare: true,
  },
];

const MODES = new Map(SYMMETRY_MODES.map((m) => [m.id, m]));

/** Whether `mode` can be used on a `w` x `h` map as a whole (quarter turns and diagonals need a square). */
export function modeFits(mode, w, h) {
  return !MODES.get(mode)?.needsSquare || w === h;
}

/**
 * The transforms a mode applies, identity first. On a map that is not
 * square (`w` !== `h`), transforms that swap the axes are left out.
 */
export function transformsFor(mode, w = 0, h = 0) {
  const all = MODES.get(mode)?.transforms ?? [ID];
  return w === h ? all : all.filter((x) => !x.swap);
}

/** A cell (x, y) of a `w` x `h` map under transform `tr` (the map must be square for a swap). */
export function transformCell(tr, x, y, w, h) {
  let [px, py] = tr.swap ? [y, x] : [x, y];
  const [mw, mh] = tr.swap ? [h, w] : [w, h];
  if (tr.fx) px = mw - 1 - px;
  if (tr.fy) py = mh - 1 - py;
  return [px, py];
}

/**
 * Apply a transform to the top-left cell of an object `fw` x `fh` cells big on a
 * `w` x `h` map, so the transformed object covers the transformed cells. An
 * object keeps its own orientation (a structure does not turn): under a swap
 * its box is placed around the transformed centre.
 */
export function applyTransform(tr, x, y, w, h, fw = 1, fh = 1) {
  if (!tr.swap) return [tr.fx ? w - x - fw : x, tr.fy ? h - y - fh : y];
  // Centre in doubled cell units, so half cells stay exact.
  let cx = 2 * y + fh;
  let cy = 2 * x + fw;
  if (tr.fx) cx = 2 * h - cx;
  if (tr.fy) cy = 2 * w - cy;
  return [Math.round((cx - fw) / 2), Math.round((cy - fh) / 2)];
}

/** Transform a facing (0 = north, clockwise, 1024 per turn). */
export function transformFacing(tr, facing) {
  let f = facing;
  // A mirror on the main diagonal turns north into west and east into south.
  if (tr.swap) f = 768 - f;
  if (tr.fx) f = 1024 - f;
  if (tr.fy) f = 512 - f;
  return ((f % 1024) + 1024) % 1024;
}

/**
 * All positions an object at (x, y) is repeated at, identity first, without
 * duplicates (an object on a mirror axis maps onto itself).
 */
export function symmetricPositions(mode, x, y, w, h, fw = 1, fh = 1) {
  const out = [];
  const seen = new Set();
  for (const tr of transformsFor(mode, w, h)) {
    const [px, py] = applyTransform(tr, x, y, w, h, fw, fh);
    const key = `${px},${py}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ x: px, y: py, t: tr });
  }
  return out;
}

/** Spawns are the top-left cell of a 3 x 4 construction yard. */
export const SPAWN_W = 3;
export const SPAWN_H = 4;

/**
 * The spawn index that mirrors spawn `owner` under transform `t`, or `owner`
 * itself when no spawn sits within two cells of the mirrored position.
 * Neutral (-1) stays neutral.
 */
export function mirroredOwner(tr, owner, spawns, w, h) {
  if (owner < 0 || !spawns[owner]) return owner;
  const [mx, my] = applyTransform(tr, spawns[owner][0], spawns[owner][1], w, h, SPAWN_W, SPAWN_H);
  let best = owner;
  let bestD = Infinity;
  spawns.forEach(([sx, sy], k) => {
    const d = Math.abs(sx - mx) + Math.abs(sy - my);
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  });
  return bestD <= 2 ? best : owner;
}

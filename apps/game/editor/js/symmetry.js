// Symmetry painting: every edit is repeated at its mirrored positions.
// Pure module. Facing follows the engine: 0..1023, 0 = north, clockwise.

export const SYMMETRY_MODES = [
  { id: 'none', label: 'None' },
  { id: 'horizontal', label: 'Horizontal (left / right)' },
  { id: 'vertical', label: 'Vertical (top / bottom)' },
  { id: 'rotate180', label: '180 degree rotation' },
  { id: 'quad', label: '4-way (both axes)' },
];

/** The transforms a mode applies, identity first. Each is `{ fx, fy }` (flip x, flip y). */
export function transformsFor(mode) {
  switch (mode) {
    case 'horizontal':
      return [{ fx: false, fy: false }, { fx: true, fy: false }];
    case 'vertical':
      return [{ fx: false, fy: false }, { fx: false, fy: true }];
    case 'rotate180':
      return [{ fx: false, fy: false }, { fx: true, fy: true }];
    case 'quad':
      return [
        { fx: false, fy: false },
        { fx: true, fy: false },
        { fx: false, fy: true },
        { fx: true, fy: true },
      ];
    default:
      return [{ fx: false, fy: false }];
  }
}

/**
 * Apply a transform to the top-left cell of an object `fw` x `fh` cells big on a
 * `w` x `h` map, so the mirrored object covers the mirrored cells.
 */
export function applyTransform(t, x, y, w, h, fw = 1, fh = 1) {
  return [t.fx ? w - x - fw : x, t.fy ? h - y - fh : y];
}

/** Mirror a facing (0 = north, clockwise, 1024 per turn). */
export function transformFacing(t, facing) {
  let f = facing;
  if (t.fx) f = 1024 - f;
  if (t.fy) f = 512 - f;
  return ((f % 1024) + 1024) % 1024;
}

/**
 * All positions an object at (x, y) is repeated at, identity first, without
 * duplicates (an object on the mirror axis maps onto itself).
 */
export function symmetricPositions(mode, x, y, w, h, fw = 1, fh = 1) {
  const out = [];
  const seen = new Set();
  for (const t of transformsFor(mode)) {
    const [px, py] = applyTransform(t, x, y, w, h, fw, fh);
    const key = `${px},${py}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ x: px, y: py, t });
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
export function mirroredOwner(t, owner, spawns, w, h) {
  if (owner < 0 || !spawns[owner]) return owner;
  const [mx, my] = applyTransform(t, spawns[owner][0], spawns[owner][1], w, h, SPAWN_W, SPAWN_H);
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

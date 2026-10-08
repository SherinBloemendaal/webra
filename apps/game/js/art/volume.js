// Pseudo-3D volumes for the building art.
//
// Every building is modelled as a handful of simple volumes (boxes, cylinders,
// domes, roofs) and projected with ONE oblique projection, so all structures
// share the same camera and the same light:
//
//   screen x = ground x + KX * height
//   screen y = ground y - KY * height
//
// The ground itself stays square (one cell is 24x24 world pixels, as in the
// game), so a volume is placed with the ground rectangle it stands on and a
// height. Its top is lifted up and a little to the right: the south face and
// the east face become visible. Light comes from the top left, so tops are
// bright, south faces mid and east faces dark, and cast shadows fall to the
// bottom right.
//
// Colours are "specs" (T(level) is a team colour grey level, K(hex) a fixed
// colour) so that the team mask stays intact: a darker team grey is still fully
// masked. All shading uses gradients built from P.team / P.c strings, which
// works in the colour pass, the mask pass and the sidebar icon palette alike.
//
// Everything here is deterministic and draws each volume exactly once.

import { C } from './kit.js';

// ---- Projection and light ---------------------------------------------------------

export const KX = 0.28;
export const KY = 0.92;
/** Cast shadow offset per unit of height (down and to the right). */
export const SHX = 0.62;
export const SHY = 0.5;
export const SHADOW = 'rgba(0,0,0,0.4)';
export const AO = 'rgba(0,0,0,0.26)';

/** Screen position of a ground point (gx, gy) at height gz. */
export const at = (gx, gy, gz = 0) => [gx + KX * gz, gy - KY * gz];

// ---- Colour specs -------------------------------------------------------------------

export const T = (level) => ({ t: level });
export const K = (hex) => ({ c: hex });

/** Lighten (d > 0) or darken (d < 0) a #rrggbb colour. */
export function tone(hex, d) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(d >= 0 ? v + (255 - v) * d : v * (1 + d)));
  return `#${ch.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** Resolve a spec to a fill string for the current pass, shaded by d in [-1, 1]. */
export function col(P, s, d = 0) {
  return s.t !== undefined ? P.team(Math.max(0, Math.min(1, s.t + d * 0.45))) : P.c(tone(s.c, d));
}

/** Linear gradient along (x0, y0) to (x1, y1); stops are [position, shade] pairs. */
export function grad(ctx, P, s, x0, y0, x1, y1, stops) {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  for (const [p, d] of stops) g.addColorStop(p, col(P, s, d));
  return g;
}

/** Radial gradient between two circles; stops are [position, shade] pairs. */
export function radial(ctx, P, s, x0, y0, r0, x1, y1, r1, stops) {
  const g = ctx.createRadialGradient(x0, y0, r0, x1, y1, r1);
  for (const [p, d] of stops) g.addColorStop(p, col(P, s, d));
  return g;
}

// ---- Shapes -----------------------------------------------------------------------------

/** Fill a polygon given as [x0, y0, x1, y1, ...] with any fill style. */
export function quad(ctx, fill, pts) {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
  ctx.closePath();
  ctx.fill();
}

/** Fill a disc with any fill style. */
export function disc(ctx, fill, cx, cy, r) {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
}

/** Fill an axis aligned ellipse with any fill style. */
export function oval(ctx, fill, cx, cy, rx, ry) {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
}

/** A thin straight stroke. */
export function stroke(ctx, style, width, x0, y0, x1, y1) {
  ctx.strokeStyle = style;
  ctx.lineWidth = width;
  ctx.lineCap = 'butt';
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

function hull(pts) {
  // Andrew's monotone chain over [x, y] pairs, counter clockwise.
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * Cast shadows of several volumes as ONE translucent fill, so overlaps never
 * darken twice. Items: {x, y, w, d, z, z0?} for boxes (ground rectangle) or
 * {cx, cy, r, z, z0?} for cylinders. z0 lifts the footprint (rooftop items).
 */
export function castShadows(ctx, P, items) {
  ctx.fillStyle = P.c(SHADOW);
  ctx.beginPath();
  for (const it of items) {
    const z0 = it.z0 ?? 0;
    const pts = [];
    if (it.r !== undefined) {
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        pts.push([it.cx + Math.cos(a) * it.r, it.cy + Math.sin(a) * it.r]);
      }
    } else {
      pts.push([it.x, it.y], [it.x + it.w, it.y], [it.x + it.w, it.y + it.d], [it.x, it.y + it.d]);
    }
    const sx = SHX * it.z;
    const sy = SHY * it.z;
    const all = pts.concat(pts.map(([x, y]) => [x + sx, y + sy])).map(([x, y]) => at(x, y, z0));
    const h = hull(all);
    h.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.closePath();
  }
  ctx.fill();
}

// ---- Boxes -----------------------------------------------------------------------------

/**
 * A box standing on the ground rectangle (x, y, w, d), z high, resting on
 * height o.z0 (default the ground). `wall` colours the south and east faces,
 * `roof` the top. o.cast draws the cast shadow too (default off: callers batch
 * shadows with castShadows so they sit below every volume).
 * Returns the volume, which maps face coordinates to the screen:
 *   V.front(u, v) on the south face (u across, v up)
 *   V.roof(u, t)  on the top (u across, t from the north edge)
 *   V.side(t, v)  on the east face (t from the south edge, v up)
 */
export function box(ctx, P, x, y, w, d, z, wall, roof = wall, o = {}) {
  const z0 = o.z0 ?? 0;
  const zt = z0 + z;
  const g = (gx, gy, gz) => at(gx, gy, gz);
  const [bx, by] = at(0, 0, z0);
  const [tx, ty] = at(0, 0, zt);
  const V = {
    x, y, w, d, z, z0,
    top: zt,
    front: (u, v) => g(x + u, y + d, z0 + v),
    roof: (u, t) => g(x + u, y + t, zt),
    side: (t, v) => g(x + w, y + d - t, z0 + v),
  };
  const rd = o.shade ?? 0;
  // east face: dark (a `run` is a wall that tiles sideways, so it has no end faces)
  if (z > 0 && !o.run) {
    const e = [x + w + bx, y + d + by, x + w + bx, y + by, x + w + tx, y + ty, x + w + tx, y + d + ty];
    quad(ctx, grad(ctx, P, wall, 0, y + d + ty, 0, y + d + by, [[0, -0.34 + rd], [1, -0.56 + rd]]), e);
    // front face: mid, darker towards the ground (ambient occlusion)
    const f = [x + bx, y + d + by, x + w + bx, y + d + by, x + w + tx, y + d + ty, x + tx, y + d + ty];
    quad(ctx, grad(ctx, P, wall, 0, y + d + ty, 0, y + d + by, [[0, 0.04 + rd], [0.7, -0.12 + rd], [1, -0.34 + rd]]), f);
    // lit west edge, dark south-east corner and base line
    stroke(ctx, col(P, wall, -0.55 + rd), 0.9, x + bx, y + d + by - 0.2, x + w + bx, y + d + by - 0.2);
    if (!o.run) {
      stroke(ctx, col(P, wall, 0.3 + rd), 0.7, x + bx + 0.35, y + d + by, x + tx + 0.35, y + d + ty);
      stroke(ctx, col(P, wall, -0.55 + rd), 0.7, x + w + bx, y + d + by, x + w + tx, y + d + ty);
    }
    // vertical panel seams (a groove with a lit lip)
    if (o.panel) {
      for (let u = o.panel; u < w - 0.5; u += o.panel) {
        stroke(ctx, col(P, wall, -0.34 + rd), 0.6, x + u + bx, y + d + by, x + u + tx, y + d + ty);
        stroke(ctx, col(P, wall, 0.14 + rd), 0.4, x + u + 0.6 + bx, y + d + by, x + u + 0.6 + tx, y + d + ty);
      }
    }
  }
  // top: bright, a little darker towards the south east
  const t = [x + tx, y + ty, x + w + tx, y + ty, x + w + tx, y + d + ty, x + tx, y + d + ty];
  const tg = o.run ? grad(ctx, P, roof, 0, y + ty, 0, y + d + ty, [[0, 0.3 + rd], [1, 0.02 + rd]]) : grad(ctx, P, roof, x + tx, y + ty, x + w + tx, y + d + ty, [[0, 0.3 + rd], [1, 0.02 + rd]]);
  quad(ctx, tg, t);
  // lit north and west rim, shaded east and south rim
  stroke(ctx, col(P, roof, 0.55 + rd), 0.8, x + tx, y + ty + 0.4, x + w + tx, y + ty + 0.4);
  if (!o.run) {
    stroke(ctx, col(P, roof, 0.45 + rd), 0.8, x + tx + 0.4, y + ty, x + tx + 0.4, y + d + ty);
    stroke(ctx, col(P, roof, -0.3 + rd), 0.8, x + w + tx - 0.4, y + ty, x + w + tx - 0.4, y + d + ty);
  }
  stroke(ctx, col(P, roof, -0.3 + rd), 0.8, x + tx, y + d + ty - 0.4, x + w + tx, y + d + ty - 0.4);
  if (o.cast) castShadows(ctx, P, [{ x, y, w, d, z, z0 }]);
  return V;
}

/** Fill a rectangle on a box face with any fill style. Faces: 'front' (u, v), 'roof' (u, t), 'side' (t, v). */
export function patch(ctx, fill, V, face, a0, b0, a1, b1) {
  const f = V[face];
  const [p0, p1, p2, p3] = [f(a0, b0), f(a1, b0), f(a1, b1), f(a0, b1)];
  quad(ctx, fill, [...p0, ...p1, ...p2, ...p3]);
}

/** A line on a box face. */
export function mark(ctx, style, width, V, face, a0, b0, a1, b1) {
  const f = V[face];
  const p0 = f(a0, b0);
  const p1 = f(a1, b1);
  stroke(ctx, style, width, p0[0], p0[1], p1[0], p1[1]);
}

/** Clip to the top face of a box (for rooftop shadows and seams). */
export function clipRoof(ctx, V) {
  ctx.beginPath();
  const pts = [V.roof(0, 0), V.roof(V.w, 0), V.roof(V.w, V.d), V.roof(0, V.d)];
  pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.closePath();
  ctx.clip();
}

// ---- Cylinders and domes -------------------------------------------------------------------

/**
 * Upright cylinder (tank, silo, stack, coil): centre (cx, cy) on the ground,
 * radius r, height z. Built from stacked discs so bands are exact. o.bands is
 * [[from, to, spec], ...] in height units; o.z0 lifts it (rooftop tanks).
 */
export function cylinder(ctx, P, cx, cy, r, z, wall, roof = wall, o = {}) {
  const z0 = o.z0 ?? 0;
  const [bx, by] = at(cx, cy, z0);
  const [tx] = at(0, 0, z);
  const steps = Math.max(2, Math.ceil(z / 0.8));
  for (let i = 0; i <= steps; i++) {
    const h = (i / steps) * z;
    const [px, py] = at(cx, cy, z0 + h);
    let spec = wall;
    for (const [a, b, s] of o.bands ?? []) if (h >= a && h <= b) spec = s;
    const lo = h < 1.2 ? -0.18 : 0;
    const g = grad(ctx, P, spec, bx - r, 0, bx + r + tx, 0, [[0, 0.3 + lo], [0.32, 0.05 + lo], [0.7, -0.3 + lo], [1, -0.5 + lo]]);
    disc(ctx, g, px, py, r);
  }
  // lid
  const [lx, ly] = at(cx, cy, z0 + z);
  disc(ctx, col(P, roof, -0.25), lx, ly, r);
  disc(ctx, grad(ctx, P, roof, lx - r, ly - r, lx + r, ly + r, [[0, 0.32], [1, -0.08]]), lx, ly, r - 0.9);
  return { cx, cy, r, z, z0, lid: [lx, ly] };
}

/**
 * Dome (hemisphere) resting on the ground (or on height o.z0): radius r.
 * With o.full it is a whole sphere centred at height r above z0.
 */
export function dome(ctx, P, cx, cy, r, spec, o = {}) {
  const z0 = o.z0 ?? 0;
  const full = o.full === true;
  const lo = full ? -r : 0;
  const hi = r;
  const [ax, ay] = at(cx, cy, z0 + (full ? r : 0) + hi * 0.55);
  const steps = Math.max(6, Math.ceil((hi - lo) / 0.7));
  const hx = ax - r * 0.4;
  const hy = ay - r * 0.35;
  const g = radial(ctx, P, spec, hx, hy, 0, hx, hy, r * 1.75, [[0, 0.62], [0.2, 0.34], [0.55, -0.05], [1, -0.58]]);
  for (let i = 0; i <= steps; i++) {
    const h = lo + ((hi - lo) * i) / steps;
    const rr = Math.sqrt(Math.max(0, r * r - h * h));
    const [px, py] = at(cx, cy, z0 + (full ? r : 0) + h);
    if (rr > 0.2) disc(ctx, g, px, py, rr);
  }
  return { cx, cy, r, z0, apex: at(cx, cy, z0 + (full ? r : 0) + hi) };
}

// ---- Roofs ---------------------------------------------------------------------------------

/**
 * Pitched (gable) roof over a box V: eaves at the box top, ridge o.rise higher.
 * axis 'x' puts the ridge along the width (slopes face north and south), 'y'
 * along the depth (slopes face west and east). Slopes shade by orientation;
 * o.ridge adds a ridge cap and o.seams the number of corrugation lines.
 */
export function gable(ctx, P, V, rise, spec, o = {}) {
  const { x, y, w, d, top } = V;
  const axis = o.axis ?? 'x';
  const out = o.overhang ?? 0;
  const ex0 = x - out;
  const ex1 = x + w + out;
  const ey0 = y - out;
  const ey1 = y + d + out;
  if (axis === 'x') {
    const ym = y + d / 2;
    const north = [at(ex0, ey0, top), at(ex1, ey0, top), at(ex1, ym, top + rise), at(ex0, ym, top + rise)];
    const south = [at(ex0, ey1, top), at(ex1, ey1, top), at(ex1, ym, top + rise), at(ex0, ym, top + rise)];
    // gable end on the east
    quad(ctx, col(P, o.end ?? spec, -0.45), [...at(x + w, y, top), ...at(x + w, y + d, top), ...at(x + w, ym, top + rise)]);
    quad(ctx, grad(ctx, P, spec, 0, north[3][1], 0, north[0][1], [[0, 0.1], [1, 0.34]]), north.flat());
    quad(ctx, grad(ctx, P, spec, 0, south[3][1], 0, south[0][1], [[0, -0.02], [1, -0.28]]), south.flat());
    const n = o.seams ?? 0;
    for (let i = 1; i < n; i++) {
      const gx = ex0 + ((ex1 - ex0) * i) / n;
      const a = at(gx, ey0, top);
      const b = at(gx, ym, top + rise);
      const c = at(gx, ey1, top);
      stroke(ctx, col(P, spec, -0.38), 0.6, a[0], a[1], b[0], b[1]);
      stroke(ctx, col(P, spec, -0.5), 0.6, b[0], b[1], c[0], c[1]);
    }
    const r0 = at(ex0, ym, top + rise);
    const r1 = at(ex1, ym, top + rise);
    stroke(ctx, col(P, spec, 0.5), 1, r0[0], r0[1], r1[0], r1[1]);
    const e0 = at(ex0, ey1, top);
    const e1 = at(ex1, ey1, top);
    stroke(ctx, col(P, spec, -0.55), 0.8, e0[0], e0[1] - 0.2, e1[0], e1[1] - 0.2);
  } else {
    const xm = x + w / 2;
    const west = [at(ex0, ey0, top), at(ex0, ey1, top), at(xm, ey1, top + rise), at(xm, ey0, top + rise)];
    const east = [at(ex1, ey0, top), at(ex1, ey1, top), at(xm, ey1, top + rise), at(xm, ey0, top + rise)];
    // east slope first (it is the darker, far side), then the lit west slope
    quad(ctx, grad(ctx, P, spec, west[3][0], 0, east[0][0], 0, [[0, -0.12], [1, -0.38]]), east.flat());
    quad(ctx, grad(ctx, P, spec, west[0][0], 0, west[3][0], 0, [[0, 0.34], [1, 0.1]]), west.flat());
    // front gable triangle
    quad(ctx, col(P, o.end ?? spec, -0.18), [...at(x, y + d, top), ...at(x + w, y + d, top), ...at(xm, y + d, top + rise)]);
    const n = o.seams ?? 0;
    for (let i = 1; i < n; i++) {
      const gy = ey0 + ((ey1 - ey0) * i) / n;
      const a = at(ex0, gy, top);
      const b = at(xm, gy, top + rise);
      const c = at(ex1, gy, top);
      stroke(ctx, col(P, spec, -0.28), 0.6, a[0], a[1], b[0], b[1]);
      stroke(ctx, col(P, spec, -0.55), 0.6, b[0], b[1], c[0], c[1]);
    }
    const r0 = at(xm, ey0, top + rise);
    const r1 = at(xm, ey1, top + rise);
    stroke(ctx, col(P, spec, 0.5), 1, r0[0], r0[1], r1[0], r1[1]);
  }
}

/**
 * Barrel vault roof (hangars, pens) over a box V, curving along the depth: the
 * crown is o.rise above the eaves. Bands run lit (north) to dark (south) and
 * the east end shows the arch profile.
 */
export function vault(ctx, P, V, rise, spec, o = {}) {
  const { x, y, w, d, top } = V;
  const n = 12;
  // arch end on the east face
  const end = [];
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * d;
    end.push(...at(x + w, y + d - t, top + rise * Math.sin((i / n) * Math.PI)));
  }
  quad(ctx, col(P, o.end ?? spec, -0.5), end);
  // curved shell: the crown line is at the middle of the depth
  const nb = o.bands ?? 8;
  for (let k = 0; k < nb; k++) {
    const t0 = (k / nb) * d;
    const t1 = ((k + 1) / nb) * d;
    const h0 = rise * Math.sin((t0 / d) * Math.PI);
    const h1 = rise * Math.sin((t1 / d) * Math.PI);
    // shade from the slope's angle to the light: lit north slope, dark south slope
    const f = (t0 + t1) / (2 * d);
    const dd = 0.42 - f * 0.86;
    quad(ctx, col(P, spec, dd), [...at(x, y + t0, top + h0), ...at(x + w, y + t0, top + h0), ...at(x + w, y + t1, top + h1), ...at(x, y + t1, top + h1)]);
  }
  // soft sheen on the crown
  const c0 = at(x, y + d * 0.42, top + rise * 0.95);
  const c1 = at(x + w, y + d * 0.42, top + rise * 0.95);
  stroke(ctx, col(P, spec, 0.5), 0.9, c0[0], c0[1], c1[0], c1[1]);
  // ribs
  const nr = Math.max(1, Math.round(w / (o.rib ?? 12)));
  for (let i = 1; i < nr; i++) {
    const gx = x + (w * i) / nr;
    const pts = [];
    for (let j = 0; j <= n; j++) pts.push(...at(gx, y + (j / n) * d, top + rise * Math.sin((j / n) * Math.PI)));
    ctx.strokeStyle = col(P, spec, -0.45);
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.moveTo(pts[0], pts[1]);
    for (let j = 2; j < pts.length; j += 2) ctx.lineTo(pts[j], pts[j + 1]);
    ctx.stroke();
  }
}

// ---- Prisms (octagonal bunkers, hexagonal platforms) -----------------------------------------

/**
 * Regular n-gon prism standing on the ground: centre (cx, cy), circumradius r,
 * height z, resting on o.z0. The side faces that face the camera are shaded by
 * their direction to the light (west lit, east dark). o.rot turns the polygon.
 */
export function prism(ctx, P, cx, cy, r, n, z, wall, roof = wall, o = {}) {
  const z0 = o.z0 ?? 0;
  const rot = o.rot ?? Math.PI / n;
  const ring = [];
  for (let i = 0; i < n; i++) {
    const a = rot + (i / n) * Math.PI * 2;
    ring.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r, a]);
  }
  const faces = [];
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    const mid = (a[2] + b[2] + (i === n - 1 ? Math.PI * 2 : 0)) / 2;
    const nx = Math.cos(mid);
    const ny = Math.sin(mid);
    const q = [at(a[0], a[1], z0), at(b[0], b[1], z0), at(b[0], b[1], z0 + z), at(a[0], a[1], z0 + z)];
    let area = 0;
    for (let k = 0; k < 4; k++) {
      const p = q[k];
      const p2 = q[(k + 1) % 4];
      area += p[0] * p2[1] - p2[0] * p[1];
    }
    if (area > 0.01) faces.push({ q, nx, ny, a, b });
  }
  // back to front: draw the faces whose centre is furthest north first
  faces.sort((f, g) => f.a[1] + f.b[1] - (g.a[1] + g.b[1]));
  for (const f of faces) {
    const d = -0.1 - 0.35 * f.nx - (o.shade ?? 0);
    const top = Math.min(f.q[2][1], f.q[3][1]);
    const bot = Math.max(f.q[0][1], f.q[1][1]);
    quad(ctx, grad(ctx, P, wall, 0, top, 0, bot, [[0, d + 0.1], [0.7, d - 0.05], [1, d - 0.25]]), f.q.flat());
    if (o.seam) stroke(ctx, col(P, wall, d - 0.3), 0.5, f.q[0][0], f.q[0][1], f.q[3][0], f.q[3][1]);
  }
  const [lx, ly] = at(cx, cy, z0 + z);
  const lid = ring.map(([x, y]) => at(x, y, z0 + z)).flat();
  quad(ctx, col(P, roof, -0.2), lid);
  const inner = ring.map(([x, y]) => at(cx + (x - cx) * 0.86, cy + (y - cy) * 0.86, z0 + z)).flat();
  quad(ctx, grad(ctx, P, roof, lx - r, ly - r, lx + r, ly + r, [[0, 0.34], [1, -0.04]]), inner);
  return { cx, cy, r, z, z0, lid: [lx, ly] };
}

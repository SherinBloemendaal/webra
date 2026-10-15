// Shared palette and drawing helpers for the procedural sprites (flat 1996 style).
// Used by sprites.js and by the per-domain art modules in this folder.

export const C = {
  concrete: '#8d8b80',
  concreteDark: '#6c6a61',
  concreteLight: '#aaa79a',
  seam: '#5d5b53',
  steel: '#55585c',
  steelDark: '#35373a',
  steelLight: '#8a8e93',
  track: '#2b2b28',
  trackLight: '#4a4a44',
  yellow: '#d9b23a',
  yellowDark: '#9c7d20',
  glass: '#7fb0c8',
  skin: '#d8b48a',
  canvas: '#8a8a5a',
  canvasDark: '#6a6a42',
  ore: '#c99a2e',
  shadow: 'rgba(0,0,0,0.28)',
};

// ---- Drawing helpers --------------------------------------------------------

export function rect(ctx, fill, x, y, w, h) {
  ctx.fillStyle = fill;
  ctx.fillRect(x, y, w, h);
}

export function rrect(ctx, fill, x, y, w, h, r) {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fill();
}

export function circle(ctx, fill, x, y, r) {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

export function poly(ctx, fill, pts) {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
  ctx.closePath();
  ctx.fill();
}

export function line(ctx, stroke, width, x0, y0, x1, y1) {
  ctx.strokeStyle = stroke;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

/** Concrete bib / pad cells. */
export function bib(ctx, P, x, y, w, h) {
  rect(ctx, P.c(C.concreteDark), x, y, w, h);
  rect(ctx, P.c(C.concrete), x + 1, y + 1, w - 2, h - 2);
  for (let sx = x + 12; sx < x + w - 1; sx += 12) rect(ctx, P.c(C.seam), sx, y + 1, 1, h - 2);
  for (let sy = y + 12; sy < y + h - 1; sy += 12) rect(ctx, P.c(C.seam), x + 1, sy, w - 2, 1);
}

/** A building block seen from above with a darker front wall (slight 3/4 view). */
export function block(ctx, P, x, y, w, h, roof, wall, wallH = 5) {
  rect(ctx, P.c(C.shadow), x + 3, y + 3, w, h);
  rect(ctx, wall, x, y + h - wallH, w, wallH);
  rect(ctx, roof, x, y, w, h - wallH);
}

// ---- Units (facing north) ---------------------------------------------------

export function ring(ctx, stroke, x, y, r, width) {
  ctx.strokeStyle = stroke;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();
}

/** Open polyline through [x0, y0, x1, y1, ...]. */
export function polyline(ctx, stroke, width, pts) {
  ctx.strokeStyle = stroke;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
  ctx.stroke();
}

/** Regular polygon (octagon pillboxes, hexagon pads). */
export function ngon(ctx, fill, cx, cy, r, n, rot = Math.PI / n) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = rot + (i / n) * Math.PI * 2;
    pts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  poly(ctx, fill, pts);
}

/** Yellow/black diagonal hazard stripes clipped to a rectangle. */
export function hazard(ctx, P, x, y, w, h, step = 3) {
  rect(ctx, P.c(C.yellow), x, y, w, h);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  for (let s = -h; s < w; s += step * 2) poly(ctx, P.c(C.track), [x + s, y + h, x + s + step, y + h, x + s + step + h, y, x + s + h, y]);
  ctx.restore();
}

/** Radiation trefoil (demolition truck, missile silo). */
export function trefoil(ctx, P, cx, cy, r) {
  ctx.fillStyle = P.c(C.track);
  for (let i = 0; i < 3; i++) {
    const a = -Math.PI / 2 + (i * Math.PI * 2) / 3;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, a - Math.PI / 6, a + Math.PI / 6);
    ctx.closePath();
    ctx.fill();
  }
  circle(ctx, P.c(C.yellow), cx, cy, r * 0.32);
  circle(ctx, P.c(C.track), cx, cy, r * 0.2);
}

/** Radar / satellite dish seen from above, lit from the top-left. */
export function dish(ctx, P, cx, cy, r) {
  circle(ctx, P.c(C.steelDark), cx, cy, r);
  circle(ctx, P.c(C.steelLight), cx, cy, r - 1);
  circle(ctx, P.c('#c4c7cb'), cx - r * 0.25, cy - r * 0.25, r * 0.45);
  line(ctx, P.c(C.steelDark), 0.8, cx, cy, cx + r * 0.55, cy - r * 0.55);
  circle(ctx, P.c(C.steelDark), cx + r * 0.55, cy - r * 0.55, Math.max(0.8, r * 0.16));
}

/** Tank turret drum with a top-left highlight. */
export function drum(ctx, P, cx, cy, r) {
  circle(ctx, P.c(C.steelDark), cx, cy, r);
  circle(ctx, P.team(0.82), cx, cy, r - 0.9);
  circle(ctx, P.team(1.0), cx - r * 0.3, cy - r * 0.3, r * 0.3);
}

/** Barrel pointing north from y0 to y1, with a muzzle brake. */
export function barrel(ctx, P, x, y0, y1, w = 2) {
  rect(ctx, P.c(C.steelDark), x, y0, w, y1 - y0);
  rect(ctx, P.c(C.steelDark), x - 0.5, y0, w + 1, 2);
}

/** Tesla coil head from above: stacked rings around a glowing core. */
export function teslaHead(ctx, P, cx, cy, r) {
  circle(ctx, P.c('rgba(110,170,255,0.35)'), cx, cy, r * 1.6);
  circle(ctx, P.c(C.steelDark), cx, cy, r);
  ring(ctx, P.c(C.steelLight), cx, cy, r * 0.72, r * 0.22);
  circle(ctx, P.c('#7fc4ff'), cx, cy, r * 0.42);
  circle(ctx, P.c('#eef8ff'), cx - r * 0.1, cy - r * 0.1, r * 0.2);
}

/** Wooden supply crate. */
export function crate(ctx, P, x, y, w, h) {
  rect(ctx, P.c('#5e4424'), x, y, w, h);
  rect(ctx, P.c('#9a7442'), x + 0.5, y + 0.5, w - 1, h - 1);
  line(ctx, P.c('#5e4424'), 0.6, x + 1, y + 1, x + w - 1, y + h - 1);
  line(ctx, P.c('#5e4424'), 0.6, x + w - 1, y + 1, x + 1, y + h - 1);
}

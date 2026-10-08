// Sidebar cameo frames in the Red Alert style: a dark backdrop with a faint
// grid and a spotlight, the model on top, a vignette, and a bevelled steel
// frame. The models themselves are the atlas drawings (see sprites.js
// drawCameo), so a cameo never needs art of its own.

/** The inner rectangle of a cameo frame, inset by the border. */
export function cameoInner(w, h) {
  const b = Math.max(2, Math.round(Math.min(w, h) * 0.045));
  return { x: b, y: b, w: w - b * 2, h: h - b * 2, b };
}

/** Backdrop: deep blue-grey gradient, a perspective grid and a ground spotlight. */
export function paintCameoBackdrop(ctx, w, h) {
  const { x, y, w: iw, h: ih } = cameoInner(w, h);
  const g = ctx.createLinearGradient(0, y, 0, y + ih);
  g.addColorStop(0, '#26323f');
  g.addColorStop(0.55, '#141c25');
  g.addColorStop(1, '#0b1016');
  ctx.fillStyle = g;
  ctx.fillRect(x, y, iw, ih);
  // faint ground grid, converging a little towards the horizon
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, iw, ih);
  ctx.clip();
  ctx.strokeStyle = 'rgba(120,150,180,0.10)';
  ctx.lineWidth = Math.max(0.5, w / 120);
  const horizon = y + ih * 0.42;
  for (let i = -4; i <= 8; i++) {
    const bx = x + (iw * i) / 4;
    ctx.beginPath();
    ctx.moveTo(x + iw / 2 + (bx - (x + iw / 2)) * 0.25, horizon);
    ctx.lineTo(bx, y + ih);
    ctx.stroke();
  }
  for (let k = 1; k <= 4; k++) {
    const ly = horizon + (ih * 0.58 * k * k) / 16;
    ctx.beginPath();
    ctx.moveTo(x, ly);
    ctx.lineTo(x + iw, ly);
    ctx.stroke();
  }
  // spotlight pool under the model
  const r = ctx.createRadialGradient(x + iw / 2, y + ih * 0.62, 0, x + iw / 2, y + ih * 0.62, iw * 0.62);
  r.addColorStop(0, 'rgba(160,190,220,0.30)');
  r.addColorStop(1, 'rgba(160,190,220,0)');
  ctx.fillStyle = r;
  ctx.fillRect(x, y, iw, ih);
  ctx.restore();
}

/** Vignette and the bevelled frame, painted over the model. */
export function paintCameoFrame(ctx, w, h) {
  const { x, y, w: iw, h: ih, b } = cameoInner(w, h);
  const v = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.78);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(0,0,0,0.45)');
  ctx.fillStyle = v;
  ctx.fillRect(x, y, iw, ih);
  // outer steel frame
  const f = ctx.createLinearGradient(0, 0, w, h);
  f.addColorStop(0, '#7b8794');
  f.addColorStop(0.5, '#3c4650');
  f.addColorStop(1, '#1b2128');
  ctx.fillStyle = f;
  ctx.fillRect(0, 0, w, b);
  ctx.fillRect(0, h - b, w, b);
  ctx.fillRect(0, 0, b, h);
  ctx.fillRect(w - b, 0, b, h);
  // bevels: lit top and left, dark bottom and right
  ctx.fillStyle = 'rgba(255,255,255,0.28)';
  ctx.fillRect(0, 0, w, 1);
  ctx.fillRect(0, 0, 1, h);
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(0, h - 1, w, 1);
  ctx.fillRect(w - 1, 0, 1, h);
  // dark inner lip
  ctx.strokeStyle = 'rgba(0,0,0,0.65)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.rect(b - 0.5, b - 0.5, w - b * 2 + 1, h - b * 2 + 1);
  ctx.stroke();
}

/** Soft ground shadow ellipse under a model. */
export function paintCameoShadow(ctx, cx, cy, rx, ry) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(1, ry / rx);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
  g.addColorStop(0, 'rgba(0,0,0,0.55)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, rx, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

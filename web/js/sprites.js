// Procedural sprite atlas. Every unit and building is drawn with flat shapes in
// the spirit of the 1996 game: plain, readable silhouettes instead of detailed
// textures. Team-coloured parts are painted grey into the colour atlas and white
// into a separate mask, so the shader can tint them for any player.

const RES = 2; // atlas pixels per world pixel
const PAD = 2;

// Palette (non-team colours).
const C = {
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

function rect(ctx, fill, x, y, w, h) {
  ctx.fillStyle = fill;
  ctx.fillRect(x, y, w, h);
}

function rrect(ctx, fill, x, y, w, h, r) {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fill();
}

function circle(ctx, fill, x, y, r) {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

function poly(ctx, fill, pts) {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
  ctx.closePath();
  ctx.fill();
}

function line(ctx, stroke, width, x0, y0, x1, y1) {
  ctx.strokeStyle = stroke;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

/** Concrete bib / pad cells. */
function bib(ctx, P, x, y, w, h) {
  rect(ctx, P.c(C.concreteDark), x, y, w, h);
  rect(ctx, P.c(C.concrete), x + 1, y + 1, w - 2, h - 2);
  for (let sx = x + 12; sx < x + w - 1; sx += 12) rect(ctx, P.c(C.seam), sx, y + 1, 1, h - 2);
  for (let sy = y + 12; sy < y + h - 1; sy += 12) rect(ctx, P.c(C.seam), x + 1, sy, w - 2, 1);
}

/** A building block seen from above with a darker front wall (slight 3/4 view). */
function block(ctx, P, x, y, w, h, roof, wall, wallH = 5) {
  rect(ctx, P.c(C.shadow), x + 3, y + 3, w, h);
  rect(ctx, wall, x, y + h - wallH, w, wallH);
  rect(ctx, roof, x, y, w, h - wallH);
}

// ---- Units (facing north) ---------------------------------------------------

function tracks(ctx, P, x, y, w, h) {
  rrect(ctx, P.c(C.track), x, y, w, h, 2);
  for (let ty = y + 2; ty < y + h - 1; ty += 3) rect(ctx, P.c(C.trackLight), x + 0.5, ty, w - 1, 1);
}

const UNIT_DRAW = {
  '1TNK': {
    body: [22, 22, (ctx, P) => {
      tracks(ctx, P, 2, 2, 5, 18);
      tracks(ctx, P, 15, 2, 5, 18);
      rrect(ctx, P.team(0.55), 6, 4, 10, 16, 2);
      rect(ctx, P.team(0.8), 7, 4, 8, 4);
      rect(ctx, P.team(0.4), 7, 17, 8, 2);
    }],
    turret: [22, 22, (ctx, P) => {
      rect(ctx, P.c(C.steelDark), 10, 0, 2, 10);
      circle(ctx, P.c(C.steelDark), 11, 12, 5);
      circle(ctx, P.team(0.85), 11, 12, 4.2);
      circle(ctx, P.team(1.0), 10, 11, 1.6);
    }],
  },
  '3TNK': {
    body: [26, 26, (ctx, P) => {
      tracks(ctx, P, 1, 1, 7, 24);
      tracks(ctx, P, 18, 1, 7, 24);
      rrect(ctx, P.team(0.5), 7, 3, 12, 21, 2);
      rect(ctx, P.team(0.75), 8, 3, 10, 5);
      rect(ctx, P.team(0.35), 8, 21, 10, 2);
    }],
    turret: [26, 26, (ctx, P) => {
      rect(ctx, P.c(C.steelDark), 10, 0, 2, 11);
      rect(ctx, P.c(C.steelDark), 14, 0, 2, 11);
      rrect(ctx, P.c(C.steelDark), 6.5, 8.5, 13, 12, 3);
      rrect(ctx, P.team(0.8), 7.5, 9.5, 11, 10, 2.5);
      rect(ctx, P.team(1.0), 9, 11, 3, 2);
    }],
  },
  HARV: {
    body: [24, 28, (ctx, P) => {
      tracks(ctx, P, 1, 3, 5, 23);
      tracks(ctx, P, 18, 3, 5, 23);
      // cab at the front
      rrect(ctx, P.team(0.65), 5, 1, 14, 8, 2);
      rect(ctx, P.c(C.glass), 7, 2, 10, 3);
      // ore hopper
      rrect(ctx, P.c(C.steel), 5, 10, 14, 16, 1.5);
      rect(ctx, P.c(C.yellowDark), 6.5, 11.5, 11, 13);
      for (let i = 0; i < 9; i++) circle(ctx, P.c(C.ore), 8 + (i % 3) * 4, 13.5 + Math.floor(i / 3) * 4, 1.2);
      rect(ctx, P.team(0.45), 5, 24, 14, 2);
    }],
  },
  E1: {
    body: [10, 12, (ctx, P) => {
      rect(ctx, P.c(C.steelDark), 6.5, 0, 1, 6); // rifle
      circle(ctx, P.c(C.shadow), 5.6, 7, 3.6);
      poly(ctx, P.team(0.7), [1.5, 5.5, 8.5, 5.5, 8, 9.5, 2, 9.5]);
      circle(ctx, P.team(0.55), 5, 6, 2.2);
      circle(ctx, P.c('#5d6b3a'), 5, 5.5, 1.7); // helmet
    }],
  },
};

// ---- Buildings ----------------------------------------------------------------

const BUILDING_DRAW = {
  FACT: (ctx, P) => {
    bib(ctx, P, 0, 72, 72, 24);
    rect(ctx, P.c(C.shadow), 4, 4, 70, 70);
    rect(ctx, P.c(C.concreteDark), 0, 0, 72, 72);
    rect(ctx, P.c(C.concrete), 2, 2, 68, 66);
    // main hall
    block(ctx, P, 6, 8, 40, 50, P.team(0.6), P.team(0.35), 7);
    for (let x = 10; x < 44; x += 6) rect(ctx, P.team(0.75), x, 10, 2, 38);
    rect(ctx, P.c(C.steelDark), 18, 51, 16, 7);
    // crane
    circle(ctx, P.c(C.yellowDark), 58, 54, 7);
    circle(ctx, P.c(C.yellow), 58, 54, 5);
    line(ctx, P.c(C.yellowDark), 5, 58, 54, 60, 12);
    line(ctx, P.c(C.yellow), 3, 58, 54, 60, 12);
    rect(ctx, P.c(C.steelDark), 58, 10, 4, 8);
    // landing lights
    circle(ctx, P.team(1.0), 66, 6, 2);
    circle(ctx, P.team(1.0), 6, 64, 2);
  },
  POWR: (ctx, P) => {
    bib(ctx, P, 0, 48, 48, 24);
    block(ctx, P, 2, 4, 44, 44, P.c(C.concrete), P.c(C.concreteDark), 6);
    rect(ctx, P.team(0.6), 4, 26, 40, 12);
    rect(ctx, P.team(0.85), 4, 26, 40, 3);
    for (const x of [14, 34]) {
      circle(ctx, P.c(C.steelDark), x, 15, 9);
      circle(ctx, P.c(C.steelLight), x, 15, 7.5);
      circle(ctx, P.c(C.steelDark), x, 15, 4);
    }
  },
  PROC: (ctx, P) => {
    // row 0: silo in the middle; row 1: plant; rows 2-3: dock pad
    bib(ctx, P, 0, 48, 72, 48);
    for (let x = 30; x < 42; x += 4) rect(ctx, P.c(C.yellow), x, 52, 2, 18);
    rect(ctx, P.c(C.shadow), 4, 28, 70, 24);
    block(ctx, P, 0, 24, 72, 26, P.c(C.concrete), P.c(C.concreteDark), 6);
    rect(ctx, P.team(0.6), 4, 28, 26, 14);
    rect(ctx, P.team(0.6), 42, 28, 26, 14);
    rect(ctx, P.c(C.steelDark), 0, 50, 24, 22);
    rect(ctx, P.c(C.steel), 2, 52, 20, 18);
    circle(ctx, P.c(C.shadow), 38, 16, 13);
    circle(ctx, P.c(C.concreteDark), 36, 14, 13);
    circle(ctx, P.team(0.7), 36, 14, 11);
    circle(ctx, P.team(0.95), 32, 10, 4);
  },
  TENT: (ctx, P) => {
    bib(ctx, P, 0, 48, 48, 24);
    rect(ctx, P.c(C.shadow), 6, 6, 42, 42);
    poly(ctx, P.c(C.canvasDark), [4, 44, 24, 6, 44, 44]);
    poly(ctx, P.c(C.canvas), [4, 44, 24, 6, 24, 44]);
    rect(ctx, P.c(C.canvasDark), 22, 6, 2, 38);
    rect(ctx, P.c(C.track), 20, 34, 8, 10);
    rect(ctx, P.c(C.steelDark), 40, 4, 1.5, 20);
    rect(ctx, P.team(0.9), 41.5, 4, 6, 5);
  },
  BARR: (ctx, P) => {
    bib(ctx, P, 0, 48, 48, 24);
    block(ctx, P, 3, 4, 42, 42, P.c(C.concreteDark), P.c(C.seam), 7);
    rect(ctx, P.team(0.55), 7, 8, 34, 22);
    poly(ctx, P.team(1.0), [24, 11, 26.5, 17, 33, 17, 28, 21, 30, 27, 24, 23, 18, 27, 20, 21, 15, 17, 21.5, 17]);
    rect(ctx, P.c(C.track), 19, 36, 10, 7);
    for (let x = 4; x < 44; x += 6) circle(ctx, P.c(C.canvas), x + 2, 46, 2.4);
  },
  WEAP: (ctx, P) => {
    bib(ctx, P, 0, 48, 72, 24);
    rect(ctx, P.c(C.shadow), 4, 4, 70, 48);
    rect(ctx, P.c(C.concreteDark), 0, 0, 72, 50);
    // arched hangar roof
    for (let i = 0; i < 6; i++) rect(ctx, P.team(i % 2 ? 0.55 : 0.7), 4, 4 + i * 6, 64, 6);
    rect(ctx, P.c(C.concreteDark), 0, 40, 72, 10);
    rect(ctx, P.c(C.track), 24, 38, 24, 12);
    for (let y = 40; y < 50; y += 3) rect(ctx, P.c(C.steelDark), 24, y, 24, 1);
    circle(ctx, P.c(C.yellow), 20, 45, 1.6);
    circle(ctx, P.c(C.yellow), 52, 45, 1.6);
  },
  FIX: (ctx, P) => {
    // plus-shaped repair pad
    const pad = (x, y) => bib(ctx, P, x, y, 24, 24);
    pad(24, 0);
    pad(0, 24);
    pad(24, 24);
    pad(48, 24);
    pad(24, 48);
    circle(ctx, P.c(C.concreteDark), 36, 36, 10);
    circle(ctx, P.team(0.7), 36, 36, 8);
    line(ctx, P.c(C.steelDark), 3, 31, 41, 41, 31);
    circle(ctx, P.c(C.steelDark), 41, 31, 3);
    circle(ctx, P.team(0.7), 42, 30, 1.4);
    for (const [x, y] of [[28, 4], [44, 4], [4, 28], [4, 44], [68, 28], [68, 44], [28, 68], [44, 68]]) circle(ctx, P.c(C.yellow), x, y, 1.6);
  },
};

// ---- Specials (must match render.rs SpriteIds order) ---------------------------

const SPECIALS = [
  // bullet
  [6, 6, (ctx, P) => {
    circle(ctx, P.c('rgba(255,220,120,0.45)'), 3, 3, 3);
    circle(ctx, P.c('#fff6c8'), 3, 3, 1.4);
  }],
  // small explosion
  [18, 18, (ctx, P) => burst(ctx, P, 9, 9, 8, 7)],
  // large explosion
  [36, 36, (ctx, P) => {
    circle(ctx, P.c('rgba(40,30,25,0.55)'), 18, 18, 17);
    burst(ctx, P, 18, 18, 15, 11);
  }],
  // piff (small arms impact)
  [8, 8, (ctx, P) => {
    circle(ctx, P.c('rgba(255,240,200,0.6)'), 4, 4, 3.5);
    circle(ctx, P.c('#fffbe8'), 4, 4, 1.5);
  }],
  // rally flag
  [12, 16, (ctx, P) => {
    rect(ctx, P.c('#222'), 2, 1, 1.5, 15);
    poly(ctx, P.team(0.9), [3.5, 1.5, 11, 4, 3.5, 7]);
    circle(ctx, P.c('rgba(0,0,0,0.3)'), 3, 15, 2);
  }],
];

function burst(ctx, P, cx, cy, r, spikes) {
  const pts = [];
  for (let i = 0; i < spikes * 2; i++) {
    const a = (i / (spikes * 2)) * Math.PI * 2;
    const rr = i % 2 ? r * 0.55 : r;
    pts.push(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }
  poly(ctx, P.c('#e8641c'), pts);
  circle(ctx, P.c('#f5b030'), cx, cy, r * 0.5);
  circle(ctx, P.c('#fff2b0'), cx, cy, r * 0.25);
}

// ---- Atlas construction ---------------------------------------------------------

function grey(s) {
  const v = Math.round(Math.max(0, Math.min(1, s)) * 255);
  return `rgb(${v},${v},${v})`;
}

const COLOR_PASS = { team: grey, c: (col) => col };
const MASK_PASS = { team: () => '#fff', c: (col) => (col.startsWith('rgba') ? 'rgba(0,0,0,1)' : '#000') };

/** Sprite definitions in atlas order: [w, h, draw] or null (empty). */
function spriteList(actors) {
  const list = [];
  for (const a of actors) {
    if (a.kind === 'building') {
      const draw = BUILDING_DRAW[a.id];
      if (!draw) throw new Error(`no sprite for building ${a.id}`);
      list.push([a.width * 24, a.height * 24, draw]);
      list.push(null);
    } else {
      const d = UNIT_DRAW[a.id];
      if (!d) throw new Error(`no sprite for unit ${a.id}`);
      list.push(d.body);
      list.push(d.turret ?? null);
    }
  }
  return list.concat(SPECIALS);
}

/**
 * Build the colour atlas, mask atlas and frame table.
 * Frame table: 8 floats per sprite [u0, v0, u1, v1, w, h, 0, 0].
 */
export function buildAtlas(actors) {
  const list = spriteList(actors);
  const width = 1024;
  let x = 0;
  let y = 0;
  let rowH = 0;
  const places = list.map((s) => {
    const [w, h] = s ?? [1, 1];
    const pw = Math.ceil(w * RES) + PAD * 2;
    const ph = Math.ceil(h * RES) + PAD * 2;
    if (x + pw > width) {
      x = 0;
      y += rowH;
      rowH = 0;
    }
    const p = { x, y, pw, ph };
    x += pw;
    rowH = Math.max(rowH, ph);
    return p;
  });
  const height = y + rowH;
  const color = document.createElement('canvas');
  const mask = document.createElement('canvas');
  for (const c of [color, mask]) {
    c.width = width;
    c.height = height;
  }
  const cctx = color.getContext('2d');
  const mctx = mask.getContext('2d');
  const frames = new Float32Array(list.length * 8);
  list.forEach((s, i) => {
    const p = places[i];
    const [w, h, draw] = s ?? [1, 1, null];
    if (draw) {
      for (const [ctx, P] of [[cctx, COLOR_PASS], [mctx, MASK_PASS]]) {
        ctx.save();
        ctx.translate(p.x + PAD, p.y + PAD);
        ctx.scale(RES, RES);
        draw(ctx, P);
        ctx.restore();
      }
    }
    frames.set(
      [(p.x + PAD) / width, (p.y + PAD) / height, (p.x + PAD + w * RES) / width, (p.y + PAD + h * RES) / height, w, h, 0, 0],
      i * 8,
    );
  });
  // The mask only matters where the colour atlas has alpha; clear the rest.
  const cdata = cctx.getImageData(0, 0, width, height);
  const mdata = mctx.getImageData(0, 0, width, height);
  for (let i = 3; i < cdata.data.length; i += 4) {
    if (cdata.data[i] === 0) mdata.data[i - 3] = mdata.data[i - 2] = mdata.data[i - 1] = 0;
  }
  mctx.putImageData(mdata, 0, 0);
  return { color, mask, frames };
}

/** Sidebar icon: body + turret composited in a team colour. */
export function drawIcon(canvas, actor, teamRgb) {
  const ctx = canvas.getContext('2d');
  const P = {
    team: (s) => {
      const k = 0.35 + s * 1.05;
      const [r, g, b] = teamRgb.map((c) => Math.round(Math.min(1, c * k) * 255));
      return `rgb(${r},${g},${b})`;
    },
    c: (col) => col,
  };
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const parts = [];
  let w;
  let h;
  if (actor.kind === 'building') {
    w = actor.width * 24;
    h = actor.height * 24;
    parts.push(BUILDING_DRAW[actor.id]);
  } else {
    const d = UNIT_DRAW[actor.id];
    [w, h] = d.body;
    parts.push(d.body[2]);
    if (d.turret) parts.push(d.turret[2]);
  }
  const scale = Math.min(canvas.width / w, canvas.height / h) * (actor.kind === 'building' ? 0.92 : 0.8);
  ctx.save();
  ctx.translate((canvas.width - w * scale) / 2, (canvas.height - h * scale) / 2);
  ctx.scale(scale, scale);
  for (const draw of parts) {
    // Turrets are drawn in a box of the same size centred on the body.
    draw(ctx, P);
  }
  ctx.restore();
}

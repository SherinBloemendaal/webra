// Radar minimap at the top of the sidebar (OpenRA's RA radar widget).
//
// The radar only works while the player owns a powered, unjammed Radar Dome
// (engine/src/minimap.rs, `radar_state`). Online it shows the terrain, ore and gems,
// shroud and fog, every blip the engine reports (`minimap_blips`: own and
// allied actors, visible enemies, remembered enemy structures, nothing near an
// enemy radar jammer) in team colours, and the camera rectangle. Left click or
// drag moves the camera, right click orders the selected units to that spot.
// Without radar it shows a dark panel; jammed or without power it shows
// static, and it opens and closes with a short animation like Red Alert.
//
// Cost: one pixel per cell on a small canvas scaled up by CSS. The picture is
// rebuilt a few times per second (one pass over the cells plus one per blip);
// every frame only the camera rectangle moves.

import { askOf } from './sim/methods.js';
import { RadarPings } from './radarpings.js';

const CELL_PX = 24;
/** Radar picture refresh interval (ms): units move at 4 Hz on the radar. */
export const REFRESH_MS = 250;
/** Opening and closing animation (ms). */
export const TRANSITION_MS = 700;
/** Static noise frame interval (ms). */
const STATIC_MS = 80;
/** Static noise texture size (px, scaled up). */
const STATIC_SIZE = 64;

/** Values of Game.radar_state(). */
export const RADAR = { NONE: 0, ONLINE: 1, JAMMED: 2, LOW_POWER: 3 };
const BLIP_INTS = 5;
const NEUTRAL_OWNER = 255;

// Terrain colours by engine Terrain index (map.rs: Clear, Rough, Rock, Water,
// Tree, Ford), per biome (the same as the engine's lobby preview, weather.rs).
export const BIOME_TERRAIN_RGB = {
  temperate: [
    [62, 88, 44],
    [96, 92, 58],
    [128, 118, 102],
    [36, 70, 102],
    [28, 54, 24],
    [74, 112, 118],
  ],
  snow: [
    [206, 214, 222],
    [158, 196, 222],
    [112, 114, 124],
    [34, 62, 96],
    [40, 66, 58],
    [110, 150, 182],
  ],
  desert: [
    [200, 168, 110],
    [218, 188, 124],
    [150, 94, 60],
    [38, 116, 138],
    [92, 122, 58],
    [112, 168, 158],
  ],
};
export const TERRAIN_RGB = BIOME_TERRAIN_RGB.temperate;
const UNKNOWN_TERRAIN_RGB = [62, 88, 44];
export const ORE_RGB = [200, 160, 50];
export const GEM_RGB = [150, 90, 200];
const NEUTRAL_RGB = [170, 170, 170];
/** Brightness of explored cells under fog (0..1). */
const FOG_SHADE = 0.5;

/** Status line under the radar for each state. */
export function radarLabel(state) {
  switch (state) {
    case RADAR.ONLINE:
      return '';
    case RADAR.JAMMED:
      return 'Radar jammed';
    case RADAR.LOW_POWER:
      return 'Radar offline: low power';
    default:
      return 'No radar';
  }
}

/** Largest rectangle of the map's aspect ratio inside a box, centred: { x, y, w, h } in px. */
export function fitRect(boxW, boxH, mapW, mapH) {
  if (boxW <= 0 || boxH <= 0 || mapW <= 0 || mapH <= 0) return { x: 0, y: 0, w: 0, h: 0 };
  const scale = Math.min(boxW / mapW, boxH / mapH);
  const w = Math.round(mapW * scale);
  const h = Math.round(mapH * scale);
  return { x: Math.round((boxW - w) / 2), y: Math.round((boxH - h) / 2), w, h };
}

/**
 * World point (px) under a client position on the radar, clamped to the map.
 * `rect` is the radar picture's bounding client rect.
 */
export function minimapToWorld(clientX, clientY, rect, mapW, mapH, cellPx = CELL_PX) {
  const fx = Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(1, rect.width)));
  const fy = Math.min(1, Math.max(0, (clientY - rect.top) / Math.max(1, rect.height)));
  return { x: fx * mapW * cellPx, y: fy * mapH * cellPx };
}

/** The camera's view rectangle (world px) as fractions of the map, clipped to it: { l, t, w, h }. */
export function cameraFrame(view, mapW, mapH, cellPx = CELL_PX) {
  const W = mapW * cellPx;
  const H = mapH * cellPx;
  const clip = (v, max) => Math.min(max, Math.max(0, v));
  const l = clip(view.x0, W);
  const t = clip(view.y0, H);
  const r = clip(view.x1, W);
  const b = clip(view.y1, H);
  return { l: l / W, t: t / H, w: (r - l) / W, h: (b - t) / H };
}

/**
 * Paint the radar picture into `out` (RGBA, one pixel per cell).
 * `terrain`: RGBA per cell from Game.terrain_ptr (R terrain type, G ore, B gem density);
 * `fog`: one byte per cell from Game.fog_ptr (0 shroud, 128 fog, 255 visible);
 * `blips`: Game.minimap_blips; `colors`: team colours as 0..1 RGB triples;
 * `biome`: the map's biome (terrain colours).
 */
export function composeRadar(out, terrain, fog, blips, colors, mapW, mapH, biome = 'temperate') {
  const palette = BIOME_TERRAIN_RGB[biome] ?? TERRAIN_RGB;
  const cells = mapW * mapH;
  for (let i = 0; i < cells; i++) {
    const o = i * 4;
    const f = fog[i];
    if (f === 0) {
      out[o] = 0;
      out[o + 1] = 0;
      out[o + 2] = 0;
    } else {
      const rgb = terrain[o + 2] > 0 ? GEM_RGB : terrain[o + 1] > 0 ? ORE_RGB : (palette[terrain[o]] ?? UNKNOWN_TERRAIN_RGB);
      const k = f >= 255 ? 1 : FOG_SHADE;
      out[o] = rgb[0] * k;
      out[o + 1] = rgb[1] * k;
      out[o + 2] = rgb[2] * k;
    }
    out[o + 3] = 255;
  }
  const team = colors.map((c) => c.map((v) => Math.round(v * 255)));
  for (let k = 0; k + BLIP_INTS <= blips.length; k += BLIP_INTS) {
    const owner = blips[k + 4];
    const rgb = owner === NEUTRAL_OWNER ? NEUTRAL_RGB : (team[owner % team.length] ?? NEUTRAL_RGB);
    const x0 = Math.max(0, blips[k]);
    const y0 = Math.max(0, blips[k + 1]);
    const x1 = Math.min(mapW, blips[k] + blips[k + 2]);
    const y1 = Math.min(mapH, blips[k + 1] + blips[k + 3]);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const o = (y * mapW + x) * 4;
        out[o] = rgb[0];
        out[o + 1] = rgb[1];
        out[o + 2] = rgb[2];
      }
    }
  }
  return out;
}

/** Grey static noise into `out` (RGBA). `random` returns 0..1. */
export function fillStatic(out, random = Math.random) {
  for (let o = 0; o < out.length; o += 4) {
    const v = 40 + Math.floor(random() * 150);
    out[o] = v;
    out[o + 1] = v;
    out[o + 2] = v;
    out[o + 3] = 255;
  }
  return out;
}

/**
 * How far the radar picture is open (0 closed .. 1 open) at time `now` after
 * switching to `online` at `since`.
 */
export function revealAt(online, since, now, duration = TRANSITION_MS) {
  const p = Math.min(1, Math.max(0, (now - since) / duration));
  return online ? p : 1 - p;
}

function el(tag, className) {
  const e = document.createElement(tag);
  e.className = className;
  return e;
}

export class Minimap {
  /**
   * @param {HTMLElement} parent the sidebar's radar slot (#radar, js/sidebar.js)
   * @param {object} o
   * @param {object} o.game Game (orders go through it, so pass the audio-watched one)
   * @param {(player: number) => Uint8Array | null} o.fog the player's fog bytes (game handle `fog_bytes`, js/sim/proxy.js); null until known
   * @param {number} o.player local player
   * @param {object} o.input js/input.js Input (camera, selection, order flash)
   * @param {number[][]} o.colors team colours (TEAM_COLORS, may be reordered in place)
   * @param {string} [o.biome] the map's biome (terrain colours)
   * @param {import('./radarpings.js').RadarPings} [o.pings] radar pings drawn over the picture
   */
  constructor(parent, { game, fog, player, input, colors, biome = 'temperate', pings = null }) {
    this.pings = pings;
    this.pingsDrawn = false;
    this.game = game;
    this.fog = fog;
    this.player = player;
    this.input = input;
    this.colors = colors;
    this.mapW = game.map_width();
    this.mapH = game.map_height();
    this.biome = biome;
    this.terrain = new Uint8Array(this.mapW * this.mapH * 4);
    this.state = RADAR.NONE;
    this.online = false;
    this.since = -Infinity;
    this.lastRefresh = -Infinity;
    this.lastStatic = -Infinity;
    this.dragging = null; // pointer id while dragging the camera
    this.camKey = '';
    this.revealKey = '';
    this.build(parent);
  }

  build(parent) {
    this.root = el('div', 'mm off');
    this.root.setAttribute('role', 'img');
    this.root.setAttribute('aria-label', 'Radar');
    this.screen = el('div', 'mm-screen');
    this.staticCanvas = el('canvas', 'mm-static');
    this.staticCanvas.width = STATIC_SIZE;
    this.staticCanvas.height = STATIC_SIZE;
    this.staticCtx = this.staticCanvas.getContext('2d');
    this.staticImage = this.staticCtx?.createImageData(STATIC_SIZE, STATIC_SIZE) ?? null;
    this.canvas = el('canvas', 'mm-map');
    this.canvas.width = this.mapW;
    this.canvas.height = this.mapH;
    this.ctx = this.canvas.getContext('2d');
    this.image = this.ctx?.createImageData(this.mapW, this.mapH) ?? null;
    this.camera = el('div', 'mm-camera');
    this.pingCanvas = el('canvas', 'mm-pings');
    this.pingCtx = this.pingCanvas.getContext?.('2d') ?? null;
    this.label = el('div', 'mm-label');
    // The picture and the camera frame open and close together (clipped by --mm-reveal).
    const layer = el('div', 'mm-layer');
    layer.append(this.canvas, this.pingCanvas, this.camera);
    this.screen.append(this.staticCanvas, layer);
    this.root.append(this.screen, this.label);
    parent.prepend(this.root);
    this.setLabel(radarLabel(this.state));

    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this.canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    const end = (e) => {
      if (this.dragging === e.pointerId) this.dragging = null;
    };
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);

    this.fit();
    if (typeof ResizeObserver === 'function') {
      this.resizer = new ResizeObserver(() => this.fit());
      this.resizer.observe(this.root);
    }
  }

  /** Size the picture to the largest map-shaped rectangle in the radar box. */
  fit() {
    const r = fitRect(this.root.clientWidth, this.root.clientHeight, this.mapW, this.mapH);
    this.screen.style.setProperty('--mm-w', `${r.w}px`);
    this.screen.style.setProperty('--mm-h', `${r.h}px`);
  }

  setLabel(text) {
    if (this.label.textContent !== text) this.label.textContent = text;
    this.label.hidden = !text;
  }

  /** New terrain bytes (Game.terrain_ptr view); copied, used at the next refresh. */
  terrainChanged(bytes) {
    if (bytes.length === this.terrain.length) this.terrain.set(bytes);
  }

  // ---- Input ------------------------------------------------------------------

  usable() {
    return this.online && !this.input.suspended;
  }

  worldAt(e) {
    return minimapToWorld(e.clientX, e.clientY, this.canvas.getBoundingClientRect(), this.mapW, this.mapH);
  }

  onPointerDown(e) {
    if (!this.usable()) return;
    e.preventDefault();
    const w = this.worldAt(e);
    if (e.button === 2) {
      this.order(w);
      return;
    }
    if (e.button !== 0) return;
    this.dragging = e.pointerId;
    this.canvas.setPointerCapture?.(e.pointerId);
    this.input.centerOn(w.x, w.y);
  }

  onPointerMove(e) {
    if (this.dragging !== e.pointerId || !this.usable()) return;
    const w = this.worldAt(e);
    this.input.centerOn(w.x, w.y);
  }

  /** Right click: the selected own units act on that spot (move, or attack what is there). */
  order(w) {
    const units = this.input.selectedOwnUnits();
    if (!units.length) return;
    const ids = Uint32Array.from(units);
    this.game.order_smart(this.player, ids, w.x, w.y);
    // The flash shows what the order does (move or attack), once the simulation answered.
    askOf(this.game)
      .cursor_action(this.player, ids, w.x, w.y)
      .then((action) => this.input.flashOrder?.(w, action))
      .catch(() => {});
  }

  // ---- Per frame -----------------------------------------------------------------

  /** Call once per animation frame, after the battlefield is drawn (calls into wasm). */
  frame(now) {
    if (now - this.lastRefresh >= REFRESH_MS) {
      this.lastRefresh = now;
      this.refresh(now);
    }
    const reveal = revealAt(this.online, this.since, now);
    const revealKey = reveal.toFixed(3);
    if (revealKey !== this.revealKey) {
      this.revealKey = revealKey;
      this.screen.style.setProperty('--mm-reveal', revealKey);
    }
    // Static while the picture is not fully open, unless there is no radar at all.
    const showStatic = reveal < 1 && (this.state !== RADAR.NONE || reveal > 0);
    this.root.classList.toggle('static', showStatic);
    this.root.classList.toggle('off', !showStatic && reveal === 0);
    if (showStatic && now - this.lastStatic >= STATIC_MS && this.staticImage) {
      this.lastStatic = now;
      fillStatic(this.staticImage.data);
      this.staticCtx.putImageData(this.staticImage, 0, 0);
    }
    if (reveal > 0) this.drawCamera();
    this.drawPings(now, reveal > 0);
  }

  /**
   * Radar pings (OpenRA RadarWidget): a turning triangle per ping, shrinking
   * onto its spot, in its colour; only while the radar shows a picture.
   */
  drawPings(now, shown) {
    const ctx = this.pingCtx;
    if (!ctx || !this.pings) return;
    const list = shown ? this.pings.active(now) : [];
    if (!list.length) {
      if (this.pingsDrawn) ctx.clearRect(0, 0, this.pingCanvas.width, this.pingCanvas.height);
      this.pingsDrawn = false;
      return;
    }
    const dpr = Math.max(1, Math.min(3, globalThis.devicePixelRatio || 1));
    const w = Math.max(1, Math.round(this.pingCanvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.pingCanvas.clientHeight * dpr));
    if (this.pingCanvas.width !== w || this.pingCanvas.height !== h) {
      this.pingCanvas.width = w;
      this.pingCanvas.height = h;
    }
    ctx.clearRect(0, 0, w, h);
    // OpenRA's radii are radar pixels of a radar about 200 pixels wide.
    const scale = (w / dpr / 200) * dpr;
    for (const p of list) {
      const cx = (p.x / (this.mapW * CELL_PX)) * w;
      const cy = (p.y / (this.mapH * CELL_PX)) * h;
      const pts = RadarPings.triangle(cx, cy, p.radius, p.angle, scale);
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.lineWidth = 2 * dpr;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
      ctx.stroke();
      ctx.lineWidth = 1 * dpr;
      ctx.strokeStyle = `rgb(${p.color.map((c) => Math.round(Math.max(0, Math.min(1, c)) * 255)).join(', ')})`;
      ctx.stroke();
    }
    this.pingsDrawn = true;
  }

  refresh(now) {
    const state = this.game.radar_state(this.player);
    const online = state === RADAR.ONLINE;
    if (online !== this.online) {
      // Reverse a running animation from where it is.
      const reveal = revealAt(this.online, this.since, now);
      this.online = online;
      this.since = now - (online ? reveal : 1 - reveal) * TRANSITION_MS;
      if (!online) this.dragging = null;
    }
    this.state = state;
    this.setLabel(radarLabel(state));
    if (!online || !this.image) return;
    const blips = this.game.minimap_blips(this.player);
    // Main thread mode: a view of wasm memory right after the call that fills it.
    const fog = this.fog(this.player);
    if (!fog) return;
    composeRadar(this.image.data, this.terrain, fog, blips, this.colors, this.mapW, this.mapH, this.biome);
    this.ctx.putImageData(this.image, 0, 0);
  }

  drawCamera() {
    const f = cameraFrame(this.input.viewRect(), this.mapW, this.mapH);
    const key = `${f.l.toFixed(4)},${f.t.toFixed(4)},${f.w.toFixed(4)},${f.h.toFixed(4)}`;
    if (key === this.camKey) return;
    this.camKey = key;
    const s = this.camera.style;
    s.setProperty('--cam-l', `${(f.l * 100).toFixed(2)}%`);
    s.setProperty('--cam-t', `${(f.t * 100).toFixed(2)}%`);
    s.setProperty('--cam-w', `${(f.w * 100).toFixed(2)}%`);
    s.setProperty('--cam-h', `${(f.h * 100).toFixed(2)}%`);
  }
}

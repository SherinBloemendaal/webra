// 2D previews of the map: the minimap and the PNG export. Colours follow the
// engine's map preview (engine/src/lib.rs) so editor, lobby and minimap agree.

import { TEAM_COLORS } from '../../js/renderer.js';
import { BIOME_PREVIEW_COLORS, PREVIEW_COLORS, PREVIEW_GEMS, PREVIEW_ORE } from './mapformat.js';
import { actorCells } from './edits.js';
import { SPAWN_H, SPAWN_W } from './symmetry.js';

const CELL = 24;
const css = (rgb, a = 1) => `rgba(${Math.round(rgb[0] * 255)},${Math.round(rgb[1] * 255)},${Math.round(rgb[2] * 255)},${a})`;
const teamColor = (owner) => (owner >= 0 ? TEAM_COLORS[Math.min(owner, 7)] : [0.85, 0.85, 0.85]);

/** One pixel per cell: terrain, ore, gems, actor footprints. */
export function terrainImage(doc, catalog) {
  const img = new ImageData(doc.width, doc.height);
  const d = img.data;
  const colors = BIOME_PREVIEW_COLORS[doc.meta?.biome] ?? PREVIEW_COLORS;
  for (let i = 0; i < doc.width * doc.height; i++) {
    const rgb = doc.gems[i] > 0 ? PREVIEW_GEMS : doc.ore[i] > 0 ? PREVIEW_ORE : colors[doc.terrain[i]] ?? [0, 0, 0];
    d[i * 4] = rgb[0];
    d[i * 4 + 1] = rgb[1];
    d[i * 4 + 2] = rgb[2];
    d[i * 4 + 3] = 255;
  }
  for (const a of doc.actors) {
    const c = teamColor(a.owner).map((v) => Math.round(v * 255));
    for (const [x, y, kind] of actorCells(a, catalog)) {
      if (kind !== 1 || !doc.inside(x, y)) continue;
      const i = (y * doc.width + x) * 4;
      d[i] = c[0];
      d[i + 1] = c[1];
      d[i + 2] = c[2];
    }
  }
  return img;
}

/** Draw spawns as numbered player-coloured boxes on a context scaled `s` px per cell. */
function drawSpawns(ctx, doc, s) {
  doc.spawns.forEach(([x, y], k) => {
    const col = teamColor(k);
    ctx.fillStyle = css(col, 0.85);
    ctx.fillRect(x * s, y * s, SPAWN_W * s, SPAWN_H * s);
    ctx.strokeStyle = '#000';
    ctx.lineWidth = Math.max(1, s * 0.25);
    ctx.strokeRect(x * s, y * s, SPAWN_W * s, SPAWN_H * s);
    const size = Math.max(9, Math.round(s * 3));
    ctx.font = `900 ${size}px Impact, 'Arial Black', sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = Math.max(2, size / 5);
    ctx.strokeText(String(k + 1), (x + SPAWN_W / 2) * s, (y + SPAWN_H / 2) * s);
    ctx.fillStyle = '#fff';
    ctx.fillText(String(k + 1), (x + SPAWN_W / 2) * s, (y + SPAWN_H / 2) * s);
  });
}

/** PNG preview canvas, `scale` px per cell (spawns numbered). */
export function previewCanvas(doc, catalog, scale = 4) {
  const base = document.createElement('canvas');
  base.width = doc.width;
  base.height = doc.height;
  base.getContext('2d').putImageData(terrainImage(doc, catalog), 0, 0);
  const out = document.createElement('canvas');
  out.width = doc.width * scale;
  out.height = doc.height * scale;
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(base, 0, 0, out.width, out.height);
  drawSpawns(ctx, doc, scale);
  return out;
}

export class Minimap {
  /**
   * @param canvas minimap canvas element
   * @param onJump (worldX, worldY) => void, centres the main view (a press of any button, and its drag)
   * @param onZoom (factor, worldX, worldY) => void, zooms the main view (mouse wheel over the minimap)
   */
  constructor(canvas, onJump, onZoom = null) {
    this.canvas = canvas;
    this.onJump = onJump;
    this.base = document.createElement('canvas');
    this.dirty = true;
    this.doc = null;
    // Any button (left, right, middle; a finger) moves the view there and a
    // drag keeps moving it, like the game's radar does with every button
    // but the one that gives orders (js/minimap.js). One pointer at a time.
    let dragging = null;
    const jump = (e) => {
      const p = this.toWorld(e);
      if (p) this.onJump(p.x, p.y);
    };
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    // The middle button moves the view: no autoscroll (Windows) or paste (Linux).
    canvas.addEventListener('mousedown', (e) => e.button === 1 && e.preventDefault());
    canvas.addEventListener('auxclick', (e) => e.button === 1 && e.preventDefault());
    canvas.addEventListener('pointerdown', (e) => {
      if (dragging !== null || e.button > 2) return;
      dragging = e.pointerId;
      canvas.setPointerCapture(e.pointerId);
      jump(e);
    });
    canvas.addEventListener('pointermove', (e) => e.pointerId === dragging && jump(e));
    const lift = (e) => {
      if (e.pointerId === dragging) dragging = null;
    };
    canvas.addEventListener('pointerup', lift);
    canvas.addEventListener('pointercancel', lift);
    canvas.addEventListener(
      'wheel',
      (e) => {
        if (!onZoom) return;
        e.preventDefault();
        const p = this.toWorld(e);
        if (p) onZoom(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)), p.x, p.y);
      },
      { passive: false },
    );
  }

  /** Map rectangle inside the canvas (letterboxed, centred). */
  layout() {
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const s = Math.min(cw / this.doc.width, ch / this.doc.height);
    return { s, ox: (cw - this.doc.width * s) / 2, oy: (ch - this.doc.height * s) / 2 };
  }

  toWorld(e) {
    if (!this.doc) return null;
    const r = this.canvas.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * this.canvas.width;
    const py = ((e.clientY - r.top) / r.height) * this.canvas.height;
    const { s, ox, oy } = this.layout();
    return { x: ((px - ox) / s) * CELL, y: ((py - oy) / s) * CELL };
  }

  invalidate() {
    this.dirty = true;
  }

  /** Redraw (terrain only when invalidated) with the current view rectangle. */
  draw(doc, catalog, view) {
    this.doc = doc;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    if (this.dirty) {
      this.base.width = doc.width;
      this.base.height = doc.height;
      this.base.getContext('2d').putImageData(terrainImage(doc, catalog), 0, 0);
      this.dirty = false;
    }
    const ctx = this.canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    const { s, ox, oy } = this.layout();
    ctx.save();
    ctx.translate(ox, oy);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.base, 0, 0, doc.width * s, doc.height * s);
    drawSpawns(ctx, doc, s);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = Math.max(1, dpr);
    ctx.strokeRect((view.x0 / CELL) * s, (view.y0 / CELL) * s, ((view.x1 - view.x0) / CELL) * s, ((view.y1 - view.y0) / CELL) * s);
    ctx.restore();
  }
}

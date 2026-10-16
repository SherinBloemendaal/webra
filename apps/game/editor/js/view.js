// Editor viewport: camera (pan and zoom like the game), pointer input in cells,
// and drawing through the game's WebGPU renderer. Terrain goes to the renderer
// as the engine's preview of the map has it (js/world.js: tree terrain is
// clear ground under tree actors there, as in a game), or, without one, in
// the same RGBA layout from the document (R type, G ore and B gems scaled to
// 255 at their maximum density, A 255). Tiles are WebRA's for the biome or
// installed ones (js/art.js). The fog layer is uploaded fully visible. An
// edit in progress is patched into the uploaded picture as it goes
// (js/live.js).

import { buildTerrainAtlas, cellTiles, terrainSeed } from '../../js/art/terrain.js';
import { LiveTerrain, docCellBytes } from './live.js';

const CELL = 24; // world pixels per cell (render.rs PX_PER_CELL)
const PAN_SPEED = 900; // CSS px per second at zoom 1
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 4;
/** Team slot of neutral actors (engine world.rs EDITOR_SLOTS, js/world.js PREVIEW_NEUTRAL). */
const NEUTRAL_TEAM = 8;

export class EditorView {
  /**
   * @param canvas the WebGPU canvas
   * @param renderer Renderer from ../js/renderer.js
   * @param handlers { down(cell, e), move(cell, e), up(cell, e), hover(cell), leave(), cancel() }
   */
  constructor(canvas, renderer, handlers) {
    this.canvas = canvas;
    this.renderer = renderer;
    this.handlers = handlers;
    this.camera = { x: 0, y: 0, zoom: 1 };
    this.keys = new Set();
    this.pan = null;
    /** Two fingers on a touch screen: pan and pinch zoom. */
    this.pinch = null;
    this.spaceDown = false;
    this.mapW = 0;
    this.mapH = 0;
    this.terrainBytes = null;
    this.terrainDirty = true;
    this.hover = null;
    /** The edit in progress drawn into the uploaded terrain (js/live.js). */
    this.live = new LiveTerrain();
    /** The pointer the tool follows (captured from its press to its release). */
    this.toolPointer = null;
    this.bindInput();
  }

  // ---- Map ------------------------------------------------------------------------

  setMap(doc) {
    if (doc.width !== this.mapW || doc.height !== this.mapH) {
      this.mapW = doc.width;
      this.mapH = doc.height;
      this.renderer.setMapSize(doc.width, doc.height);
      this.renderer.uploadFog(new Uint8Array(doc.width * doc.height).fill(255));
      this.terrainBytes = new Uint8Array(doc.width * doc.height * 4);
    }
    this.terrainDirty = true;
    this.setBiome(doc.meta?.biome ?? 'temperate');
  }

  /** The fog layer: `bytes` (one per cell, 0 shroud, 255 visible) or everything visible for null. */
  uploadFog(bytes) {
    this.renderer.uploadFog(bytes && bytes.length === this.mapW * this.mapH ? bytes : new Uint8Array(this.mapW * this.mapH).fill(255));
  }

  /** Terrain art of the map's biome (the same tiles as in the game). */
  setBiome(biome) {
    if (biome === this.biome) return;
    this.biome = biome;
    this.tiled = false;
    this.tileAtlas = null;
    this.renderer.setTerrainAtlas(buildTerrainAtlas(biome));
    this.terrainDirty = true;
  }

  /** The document's terrain in the engine's RGBA layout (without a preview). */
  docTerrain(doc) {
    const b = this.terrainBytes;
    for (let i = 0, n = doc.width * doc.height; i < n; i++) docCellBytes(doc, i, b);
    return b;
  }

  /**
   * Upload the terrain: `bytes` from the engine preview (or the document's
   * own when null) and the tile layer, from `tilesFor(bytes)` (installed
   * tiles: { atlas, cells } or null) or WebRA's tiles with the game's decal
   * seed, so the map looks as it will in a game.
   */
  updateTerrain(doc, bytes = null, tilesFor = () => null) {
    const b = bytes && bytes.length === doc.width * doc.height * 4 ? bytes : this.docTerrain(doc);
    this.renderer.uploadTerrain(b);
    const tiles = tilesFor(b);
    if (tiles) {
      // The same atlas again (installed tiles planned once, js/tiles.js): no new texture.
      if (!this.tiled || tiles.atlas !== this.tileAtlas) this.renderer.setTerrainAtlas(tiles.atlas);
      this.tileAtlas = tiles.atlas;
      this.renderer.uploadCells(tiles.cells);
      this.tiled = true;
      this.live.reset(b, tiles.cells, doc.width, doc.height, { installed: true });
    } else {
      if (this.tiled) this.renderer.setTerrainAtlas(buildTerrainAtlas(this.biome ?? 'temperate'));
      this.tiled = false;
      this.tileAtlas = null;
      const seed = terrainSeed(b);
      const cells = cellTiles(b, doc.width, doc.height, seed);
      this.renderer.uploadCells(cells);
      this.live.reset(b, cells, doc.width, doc.height, { seed });
    }
    this.terrainDirty = false;
  }

  /** Upload what the edit in progress changed (js/live.js): the changed chunks of terrain and tiles only. */
  flushLive() {
    const live = this.live;
    return live.flush((x, y, w, h) => this.renderer.uploadTerrainRect(live.bytes, live.cells, x, y, w, h));
  }

  // ---- Camera ---------------------------------------------------------------------

  screenToWorld(sx, sy) {
    return { x: this.camera.x + sx / this.camera.zoom, y: this.camera.y + sy / this.camera.zoom };
  }

  cellAt(sx, sy) {
    const w = this.screenToWorld(sx, sy);
    return { x: Math.floor(w.x / CELL), y: Math.floor(w.y / CELL), wx: w.x, wy: w.y };
  }

  viewRect() {
    const w = this.canvas.clientWidth / this.camera.zoom;
    const h = this.canvas.clientHeight / this.camera.zoom;
    return { x0: this.camera.x, y0: this.camera.y, x1: this.camera.x + w, y1: this.camera.y + h };
  }

  /** Centre the view on a world-pixel position. */
  centerOn(x, y) {
    this.camera.x = x - this.canvas.clientWidth / this.camera.zoom / 2;
    this.camera.y = y - this.canvas.clientHeight / this.camera.zoom / 2;
    this.clamp();
  }

  centerOnCell(cx, cy) {
    this.centerOn((cx + 0.5) * CELL, (cy + 0.5) * CELL);
  }

  /** Zoom so the whole map fits the view. */
  fit() {
    const cw = Math.max(1, this.canvas.clientWidth);
    const ch = Math.max(1, this.canvas.clientHeight);
    const z = Math.min(cw / (this.mapW * CELL), ch / (this.mapH * CELL)) * 0.95;
    this.camera.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
    this.centerOn((this.mapW * CELL) / 2, (this.mapH * CELL) / 2);
  }

  clamp() {
    const vw = this.canvas.clientWidth / this.camera.zoom;
    const vh = this.canvas.clientHeight / this.camera.zoom;
    const mw = this.mapW * CELL;
    const mh = this.mapH * CELL;
    const margin = 4 * CELL;
    // When the map is smaller than the view, keep it centred-ish instead of pinned.
    const clampAxis = (v, view, size) =>
      view >= size + 2 * margin ? (size - view) / 2 : Math.min(Math.max(v, -margin), size - view + margin);
    this.camera.x = clampAxis(this.camera.x, vw, mw);
    this.camera.y = clampAxis(this.camera.y, vh, mh);
  }

  /** Zoom by `factor` around the centre of the view. */
  zoomBy(factor) {
    this.zoomAt(this.canvas.clientWidth / 2, this.canvas.clientHeight / 2, factor);
  }

  /** Zoom by `factor` keeping world point (wx, wy) in the middle of the view. */
  zoomAround(factor, wx, wy) {
    this.camera.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.camera.zoom * factor));
    this.centerOn(wx, wy);
  }

  zoomAt(sx, sy, factor) {
    const before = this.screenToWorld(sx, sy);
    this.camera.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.camera.zoom * factor));
    this.camera.x = before.x - sx / this.camera.zoom;
    this.camera.y = before.y - sy / this.camera.zoom;
    this.clamp();
  }

  // ---- Input ----------------------------------------------------------------------

  bindInput() {
    const c = this.canvas;
    const local = (e) => {
      const r = c.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    // Touch: one finger uses the tool; a second finger cancels it and pans and
    // pinch-zooms the map with both until they lift.
    const touches = new Map();
    const pinchState = () => {
      const [a, b] = [...touches.values()];
      return { mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
    };
    c.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      touches.set(e.pointerId, local(e));
      if (touches.size === 2) {
        this.handlers.cancel?.();
        const st = pinchState();
        this.pinch = { ...st, zoom: this.camera.zoom, world: this.screenToWorld(st.mx, st.my) };
      }
    });
    c.addEventListener(
      'pointermove',
      (e) => {
        if (!touches.has(e.pointerId)) return;
        touches.set(e.pointerId, local(e));
        if (!this.pinch || touches.size < 2) return;
        e.stopImmediatePropagation();
        const st = pinchState();
        this.camera.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, (this.pinch.zoom * st.d) / this.pinch.d));
        this.camera.x = this.pinch.world.x - st.mx / this.camera.zoom;
        this.camera.y = this.pinch.world.y - st.my / this.camera.zoom;
        this.clamp();
      },
      { capture: true },
    );
    const lift = (e) => {
      touches.delete(e.pointerId);
      if (touches.size < 2) this.pinch = null;
    };
    c.addEventListener('pointerup', lift, { capture: true });
    c.addEventListener('pointercancel', lift, { capture: true });
    c.addEventListener('pointerdown', (e) => {
      c.focus({ preventScroll: true });
      if (this.pinch) return;
      const p = local(e);
      if (e.button === 1 || (e.button === 0 && this.spaceDown)) {
        e.preventDefault();
        this.pan = { x: p.x, y: p.y, cx: this.camera.x, cy: this.camera.y, id: e.pointerId };
        c.setPointerCapture(e.pointerId);
        c.classList.add('panning');
        return;
      }
      if ((e.button === 0 || e.button === 2) && this.toolPointer === null) {
        // Captured: the gesture follows the pointer off the canvas and ends where it lets go.
        c.setPointerCapture(e.pointerId);
        this.toolPointer = e.pointerId;
        this.handlers.down(this.cellAt(p.x, p.y), e);
      }
    });
    c.addEventListener('pointermove', (e) => {
      if (this.pinch) return;
      const p = local(e);
      if (this.pan) {
        this.camera.x = this.pan.cx - (p.x - this.pan.x) / this.camera.zoom;
        this.camera.y = this.pan.cy - (p.y - this.pan.y) / this.camera.zoom;
        this.clamp();
        return;
      }
      const cell = this.cellAt(p.x, p.y);
      this.hover = cell;
      this.handlers.move(cell, e);
    });
    const up = (e) => {
      if (this.pan && e.pointerId === this.pan.id) {
        this.pan = null;
        c.classList.remove('panning');
        return;
      }
      if (e.pointerId !== this.toolPointer) return;
      this.toolPointer = null;
      const p = local(e);
      this.handlers.up(this.cellAt(p.x, p.y), e);
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    // The capture went without a release (the window lost the pointer): the gesture ends where the pointer was last.
    c.addEventListener('lostpointercapture', (e) => {
      if (e.pointerId !== this.toolPointer) return;
      this.toolPointer = null;
      if (this.hover) this.handlers.up(this.hover, e);
      else this.handlers.cancel?.();
    });
    c.addEventListener('pointerleave', () => {
      this.hover = null;
      this.handlers.leave();
    });
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const p = local(e);
        this.zoomAt(p.x, p.y, Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)));
      },
      { passive: false },
    );
    window.addEventListener('keydown', (e) => {
      if (isTyping(e)) return;
      if (e.key.startsWith('Arrow')) {
        this.keys.add(e.key);
        e.preventDefault();
      }
      if (e.code === 'Space') {
        this.spaceDown = true;
        c.classList.add('can-pan');
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.key);
      if (e.code === 'Space') {
        this.spaceDown = false;
        c.classList.remove('can-pan');
      }
    });
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.spaceDown = false;
    });
  }

  /** Per-frame camera scrolling from the arrow keys. */
  update(dt) {
    let dx = 0;
    let dy = 0;
    if (this.keys.has('ArrowLeft')) dx -= 1;
    if (this.keys.has('ArrowRight')) dx += 1;
    if (this.keys.has('ArrowUp')) dy -= 1;
    if (this.keys.has('ArrowDown')) dy += 1;
    if (dx || dy) {
      this.camera.x += (dx * PAN_SPEED * dt) / this.camera.zoom;
      this.camera.y += (dy * PAN_SPEED * dt) / this.camera.zoom;
      this.clamp();
    }
  }

  // ---- Drawing --------------------------------------------------------------------

  /**
   * Draw a frame: the preview's sprites (`actors`, js/world.js) under the
   * editor's own (`scene.sprites`: spawns, placement ghosts) and rects.
   * @param anim the render clock (js/anim.js AnimClock uniform)
   * @param actors Float32Array of sprite instances (8 floats each)
   * @param scene { sprites: number[] (8 floats each), rects: number[] (8 floats each) }
   */
  draw(anim, actors, scene) {
    const sprites = new Float32Array(actors.length + scene.sprites.length);
    sprites.set(actors, 0);
    sprites.set(scene.sprites, actors.length);
    const rects = new Float32Array(scene.rects);
    this.renderer.draw(this.camera, anim.time, sprites, sprites.length / 8, rects, rects.length / 8, anim);
  }
}

/** True while the user types into a form field (shortcuts must not fire). */
const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'color', 'file']);

export function isTyping(e) {
  const t = e.target;
  if (t instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(t.type);
  if (t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || t?.isContentEditable) return true;
  // A select plate (js/ui/controls.js): its button and its open list take letters and arrows, like a native select.
  // So does a stepper (arrows step it). Tabs do not: the shortcuts work right after a tab is clicked.
  return !!t?.closest?.('.ui-select-plate, .ui-sp-panel, [role="listbox"], [role="spinbutton"]');
}

/** The keys tabs and steppers use themselves (js/ui/controls.js). */
const CONTROL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);

/**
 * True when the key belongs to one of the game's composite controls:
 * capture-phase handlers (dialogs, key rebinding) must let it through
 * untouched. An open select list owns every key (it stops Esc itself);
 * tabs and steppers own only their arrows, Home, End and Page keys, so Esc
 * from them still closes the dialog.
 */
export function controlOwnsKeys(e) {
  const t = e.target;
  if (t?.closest?.('[role="listbox"], .ui-sp-panel')) return true;
  return CONTROL_KEYS.has(e.key) && !!t?.closest?.('[role="spinbutton"], [role="tablist"]');
}

export { CELL, NEUTRAL_TEAM };

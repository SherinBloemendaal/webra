// The map lens: a round magnifier that follows the pointer over a map
// preview (one pixel per cell) and shows the real map at that spot, drawn
// with the game's art (js/maplens/source.js, js/maplens/raster.js): terrain
// with ore, gems, cliffs and water, bridges, buildings, units and trees as
// placed on the map, and the start positions.
//
// - Mouse and pen: the lens is centred on the pointer while it is over the
//   preview and hides when it leaves. The mouse wheel over the preview
//   zooms the lens while it shows, after the pointer has moved there (a
//   page that scrolls under a still pointer never starts zooming), between
//   the game's zoom limits; at a limit the wheel scrolls the page as usual.
// - Touch: press and hold on the preview shows the lens above the finger
//   (below it near the top of the screen), so the finger does not cover it;
//   it follows the finger, the page does not scroll meanwhile, and lifting
//   the finger hides it. A swipe that starts as a scroll stays a scroll.
// - The zoom starts at half the game's own scale (LENS_START_FACTOR of
//   js/scale.js baseZoom at the player's game scale, gameScaleFor: the
//   render ratio a game would use): at the game's own scale the lens showed
//   too little map around the pointer. It does not start at the zoom the
//   player last used in a game (game.zoomFactor): that zoom is for playing,
//   while the lens is for looking over a map before playing it, and a
//   player who zooms in to play would get a lens that shows less of the map.
// - Purely decorative: aria-hidden, never focused, no keyboard handling
//   (the preview keeps its label). It shows and hides at once and the art
//   is the first frame; only the loading spinner turns, and not with
//   reduced motion (then the progress ring alone shows the loading).
// - It never takes the pointer (css/maplens.css pointer-events: none):
//   clicks under it reach the preview, and the start markers over it
//   (js/spawnpick.js), which tell the lens which marker the pointer or the
//   focus is on (setHotMarker): the lens rings it. A touch hold that showed
//   the lens is not a tap (heldRecently), so lifting the finger over a
//   marker does not pick it.
// - Loading: reading a map (the engine's map, the sprite and terrain
//   atlases; js/maplens/source.js) takes a few hundred milliseconds the
//   first time. It is not done on the first hover in one go: as soon as a
//   preview with a lens is on the page (setSource, attach) the lens reads
//   its map in the background, one step per idle task (requestIdleCallback,
//   else a timer), so the page stays responsive and the map is usually
//   ready before the pointer gets there. A pointer that comes first sees
//   the preview's pixels under a progress ring with a spinner and "Loading
//   map" until the map is in; the steps then go on without waiting for
//   idle time. The players' colours (setColors) tint the map's actors
//   without reading it again.
//
// The map is drawn into tiles of TILE_CELLS x TILE_CELLS cells at one world
// pixel per pixel (24 per cell), each tile once, a few pixel rows per frame
// within a time budget so moving the pointer stays smooth; until a tile is
// ready the lens shows the preview's pixels there. Tiles live in an LRU
// cache of `maxTiles`, tinted sprite frames in one of `maxFrames`; the map
// itself is read in the background (see Loading) and dropped when the
// preview changes.
//
// CSP: the lens is placed through CSSOM custom properties (as js/scale.js
// sets --ui-scale), never inline style attributes; its size and colours
// come from css/maplens.css (theme tokens, --ui-px).

import { baseZoom, zoomLimits } from '../scale.js';

/** The lens starts at this factor of the game's base zoom (the wheel changes it). */
export const LENS_START_FACTOR = 0.5;
import { CELL_PX, SPRITE_FLOATS, frameQuad, spriteFrame, tintPixels } from './raster.js';

/** Cells per side of a cached tile. */
export const TILE_CELLS = 8;
/** How long a finger rests on the preview before the lens shows (ms). */
export const HOLD_MS = 350;
/** A finger that moves this far (CSS px) before the lens shows is scrolling. */
export const HOLD_SLOP = 10;
/** Space between the finger and the lens (CSS px). */
export const TOUCH_GAP = 24;
/** After a touch hold that showed the lens, a click this soon (ms) is the finger lifting, not a tap. */
export const HOLD_CLICK_MS = 700;
/** Background reading waits at most this long for idle time (ms) before it runs anyway. */
export const IDLE_TIMEOUT_MS = 500;
/** While the lens waits for its map, the next step runs after this (ms): the pointer is waiting. */
export const LOADING_STEP_MS = 0;

/**
 * The colours a lens map draws its players' actors in: `colors[k]` (0..1
 * RGB) for player k where given, else the map's own (`palette`).
 */
export function playerColors(palette, colors) {
  return palette.map((c, k) => (Array.isArray(colors?.[k]) ? colors[k].slice(0, 3) : c.slice(0, 3)));
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const px = (v) => parseFloat(v) || 0;

/**
 * Where a picture is drawn inside its element (client px): the content box
 * (`rect` minus borders and padding from `style`), then CSS object-fit for
 * a picture of `iw` x `ih` (object-position is the default, centred).
 */
export function contentBox(rect, style, iw, ih) {
  const x = rect.left + px(style.borderLeftWidth) + px(style.paddingLeft);
  const y = rect.top + px(style.borderTopWidth) + px(style.paddingTop);
  const w = Math.max(0, rect.width - px(style.borderLeftWidth) - px(style.borderRightWidth) - px(style.paddingLeft) - px(style.paddingRight));
  const h = Math.max(0, rect.height - px(style.borderTopWidth) - px(style.borderBottomWidth) - px(style.paddingTop) - px(style.paddingBottom));
  const fit = style.objectFit || 'fill';
  if (fit === 'fill' || !(iw > 0 && ih > 0) || !(w > 0 && h > 0)) return { x, y, w, h };
  let s;
  if (fit === 'contain') s = Math.min(w / iw, h / ih);
  else if (fit === 'cover') s = Math.max(w / iw, h / ih);
  else if (fit === 'none') s = 1;
  else if (fit === 'scale-down') s = Math.min(1, w / iw, h / ih);
  else return { x, y, w, h };
  const dw = iw * s;
  const dh = ih * s;
  return { x: x + (w - dw) / 2, y: y + (h - dh) / 2, w: dw, h: dh };
}

/**
 * The map point (in cells) under client point (cx, cy) on a picture drawn
 * in `box` of a `mapW` x `mapH` map. Outside the picture (letterbox bars,
 * the frame) it clamps to the nearest map edge; `inside` says which.
 */
export function cellAt(box, mapW, mapH, cx, cy) {
  const fx = box.w > 0 ? ((cx - box.x) / box.w) * mapW : 0;
  const fy = box.h > 0 ? ((cy - box.y) / box.h) * mapH : 0;
  const inside = box.w > 0 && box.h > 0 && fx >= 0 && fy >= 0 && fx <= mapW && fy <= mapH;
  return { x: clamp(fx, 0, mapW), y: clamp(fy, 0, mapH), inside };
}

/**
 * Top-left corner (client px) of a lens of `size` for a pointer at `p`:
 * centred on a mouse; above a finger with a gap (below it when there is no
 * room above). Kept inside the viewport.
 */
export function lensPlacement(p, size, viewport, touch = false, gap = TOUCH_GAP) {
  let left = p.x - size / 2;
  let top = p.y - size / 2;
  if (touch) {
    top = p.y - gap - size;
    if (top < 0) top = p.y + gap;
  }
  left = clamp(left, 0, Math.max(0, viewport.width - size));
  top = clamp(top, 0, Math.max(0, viewport.height - size));
  return { left, top };
}

/**
 * Tiles ([tx, ty], nearest to the centre first) that cover a view of
 * `viewW` x `viewH` cells centred on `centre` (cells), on a `mapW` x `mapH` map.
 */
export function tilesFor(centre, viewW, viewH, mapW, mapH, tileCells = TILE_CELLS) {
  const maxX = Math.ceil(mapW / tileCells) - 1;
  const maxY = Math.ceil(mapH / tileCells) - 1;
  const x0 = clamp(Math.floor((centre.x - viewW / 2) / tileCells), 0, maxX);
  const x1 = clamp(Math.floor((centre.x + viewW / 2) / tileCells), 0, maxX);
  const y0 = clamp(Math.floor((centre.y - viewH / 2) / tileCells), 0, maxY);
  const y1 = clamp(Math.floor((centre.y + viewH / 2) / tileCells), 0, maxY);
  const out = [];
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) out.push([tx, ty]);
  const d = ([tx, ty]) => Math.hypot((tx + 0.5) * tileCells - centre.x, (ty + 0.5) * tileCells - centre.y);
  return out.sort((a, b) => d(a) - d(b));
}

/** The lens zoom after a wheel event, within `limits` (the editor's and minimap's wheel rate). */
export function wheelZoom(zoom, deltaY, deltaMode, limits) {
  return clamp(zoom * Math.exp(-deltaY * (deltaMode === 1 ? 0.05 : 0.0015)), limits.min, limits.max);
}

/** A least-recently-used cache of at most `max` entries; `onEvict(value)` frees what drops out. */
export class LruCache {
  constructor(max, onEvict = () => {}) {
    this.max = Math.max(1, max);
    this.onEvict = onEvict;
    this.map = new Map();
  }
  get size() {
    return this.map.size;
  }
  get(key) {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const [k, v] = this.map.entries().next().value;
      this.map.delete(k);
      this.onEvict(v);
    }
  }
  clear() {
    for (const v of this.map.values()) this.onEvict(v);
    this.map.clear();
  }
}

/**
 * Draw `map`'s sprite instances that reach into the tile at world pixels
 * (x0, y0) of `size` into `ctx`, in the engine's order, the way the sprite
 * shader does (`frameImage(index, team, flash)` gives the tinted frame).
 */
export function paintSprites(ctx, list, x0, y0, size, frameImage, smooth) {
  ctx.imageSmoothingEnabled = smooth;
  for (const s of list) {
    if (s.x + s.radius < x0 || s.y + s.radius < y0 || s.x - s.radius > x0 + size || s.y - s.radius > y0 + size) continue;
    const img = frameImage(s);
    if (!img) continue;
    ctx.setTransform(1, 0, 0, 1, s.x - x0, s.y - y0);
    ctx.rotate(s.rotation);
    ctx.globalAlpha = s.alpha;
    ctx.drawImage(img, s.quad.dx, s.quad.dy, s.quad.dw, s.quad.dh);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
}

/** The sprites of a lens map with their frames and quads (hidden and empty ones left out). */
export function spriteList(map) {
  const { sprites, atlas } = map;
  const out = [];
  for (let k = 0; k < sprites.length / SPRITE_FLOATS; k++) {
    const o = k * SPRITE_FLOATS;
    const alpha = sprites[o + 6];
    if (!(alpha > 0)) continue;
    const { index, rotation, hidden } = spriteFrame(atlas.frames, sprites, k);
    if (hidden) continue;
    const quad = frameQuad(atlas.frames, index, atlas.width, atlas.height, sprites[o + 5]);
    if (!quad) continue;
    out.push({ x: sprites[o], y: sprites[o + 1], rotation, index, team: Math.min(15, Math.max(0, Math.round(sprites[o + 4]))), alpha: Math.min(1, alpha), flash: sprites[o + 7], quad, radius: quad.radius });
  }
  return out;
}

export class MapLens {
  /**
   * @param {object} o
   * @param {import('./source.js').LensArt} o.art builds the lens maps
   * @param {() => number} [o.gameScale] the player's game scale (the zoom starts at the game's)
   * @param {Document} [o.doc]
   * @param {Window} [o.win]
   * @param {number} [o.maxTiles] tiles kept (TILE_CELLS square, 24 px per cell)
   * @param {number} [o.maxFrames] tinted sprite frames kept
   * @param {number} [o.budgetMs] terrain drawing per frame
   * @param {() => number} [o.now]
   */
  constructor({
    art,
    gameScale = () => 1,
    doc = globalThis.document,
    win = globalThis.window,
    maxTiles = 48,
    maxFrames = 512,
    budgetMs = 6,
    now = () => globalThis.performance.now(),
    reducedMotion = () => !!win?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches,
  }) {
    this.art = art;
    this.reducedMotion = reducedMotion;
    /** The map being read in the background: { source, steps, progress, timer } or null. */
    this.job = null;
    /** The lobby's player colours (setColors), or null for the map's own. */
    this.colors = null;
    /** The marker the pointer or focus is on (setHotMarker), or -1. */
    this.hot = -1;
    /** When a touch hold that showed the lens ended (heldRecently). */
    this.holdEnded = -Infinity;
    this.gameScale = gameScale;
    this.doc = doc;
    this.win = win;
    this.budgetMs = budgetMs;
    this.now = now;
    this.tiles = new LruCache(maxTiles);
    this.frames = new LruCache(maxFrames);
    /** Wheel zoom as a factor of the game's base zoom. */
    this.factor = LENS_START_FACTOR;
    this.target = null;
    this.image = null;
    this.offs = [];
    this.source = null;
    this.map = null;
    this.list = null;
    this.markers = [];
    this.el = null;
    this.canvas = null;
    this.visible = false;
    this.pointer = null;
    this.touch = null;
    this.armed = false;
    this.frame = 0;
    /** Timings of the last frame (ms): lens drawing and tile work. */
    this.stats = { draw: 0, work: 0 };
    this.offArt = art?.onChange?.(() => this.reset()) ?? null;
    this.onScroll = () => this.visible && this.follow();
    this.onBlur = () => this.hide();
    win?.addEventListener?.('scroll', this.onScroll, { capture: true, passive: true });
    win?.addEventListener?.('blur', this.onBlur);
  }

  /**
   * Put the lens on `target` (gets the pointer events) over `image` (the
   * preview canvas or img whose content box shows the map). Leaves the
   * previous one.
   */
  attach(target, image = target) {
    // A screen that redraws its preview under a resting mouse keeps the lens.
    const mouse = this.pointer && !this.pointer.touch ? { pointer: this.pointer, armed: this.armed } : null;
    this.detach();
    this.target = target;
    this.image = image;
    const on = (type, fn, opts) => {
      target.addEventListener(type, fn, opts);
      this.offs.push(() => target.removeEventListener(type, fn, opts));
    };
    on('pointerenter', (e) => this.pointerMove(e));
    on('pointermove', (e) => this.pointerMove(e));
    on('pointerleave', (e) => e.pointerType !== 'touch' && this.leave());
    on('pointerdown', (e) => e.pointerType === 'touch' && this.touchDown(e));
    on('pointerup', (e) => e.pointerType === 'touch' && this.touchEnd());
    on('pointercancel', (e) => e.pointerType === 'touch' && this.touchEnd());
    // While the lens shows under a finger the page must not scroll, and a
    // long press must not open the context menu or the text selection.
    on('touchmove', (e) => this.touch?.shown && e.cancelable && e.preventDefault(), { passive: false });
    on('contextmenu', (e) => this.touch && e.preventDefault());
    on('wheel', (e) => this.wheel(e), { passive: false });
    target.classList?.add('map-lens-target');
    if (mouse) {
      this.pointer = mouse.pointer;
      this.armed = mouse.armed;
      this.follow();
    }
    this.prefetch();
  }

  detach() {
    for (const off of this.offs) off();
    this.offs = [];
    this.target?.classList?.remove('map-lens-target');
    this.target = null;
    this.image = null;
    this.touchEnd();
    this.leave();
  }

  /**
   * The map the preview shows: `key` names it (the same key keeps what is
   * drawn), `load(art)` builds it (js/maplens/source.js LensArt.fromMap and
   * friends) on the first hover. `size` ({ width, height } in cells) maps
   * the preview before the map is read.
   */
  setSource(key, load, size) {
    if (this.source?.key === key) {
      if (size) this.source.size = size;
      return;
    }
    this.source = { key, load, size: size ?? null, failed: false };
    this.dropMap();
    this.prefetch();
    if (this.visible) this.requestFrame();
  }

  /** No map for this preview (it failed or there is none): the lens stays hidden. */
  clearSource() {
    this.source = null;
    this.dropMap();
    this.hide();
  }

  /** Start markers: [{ x, y } cell centres, label, color (0..1 RGB) or null for an empty start, picked?]. */
  setMarkers(markers) {
    this.markers = Array.isArray(markers) ? markers : [];
    if (this.hot >= this.markers.length) this.hot = -1;
    if (this.visible) this.requestFrame();
  }

  /** The marker (index into setMarkers) the pointer or focus is on, -1 for none: the lens rings it. */
  setHotMarker(k) {
    const hot = Number.isInteger(k) && k >= 0 && k < this.markers.length ? k : -1;
    if (hot === this.hot) return;
    this.hot = hot;
    if (this.visible) this.requestFrame();
  }

  /**
   * The players' colours (0..1 RGB, player k's actors; null keeps the
   * map's own): the drawn tiles go, the map stays.
   */
  setColors(colors) {
    const list = Array.isArray(colors) ? colors : null;
    if (JSON.stringify(list) === JSON.stringify(this.colors)) return;
    this.colors = list;
    if (!this.map) return;
    this.map.colors = playerColors(this.map.palette ?? this.map.colors, this.colors);
    this.tiles.clear();
    this.frames.clear();
    if (this.visible) this.requestFrame();
  }

  /** Whether a touch hold showed the lens just now (a click then is the finger lifting). */
  heldRecently() {
    return !!this.touch?.shown || this.now() - this.holdEnded < HOLD_CLICK_MS;
  }

  /** Installed content changed: draw the map again with the new art. */
  reset() {
    if (!this.source) return;
    this.source.failed = false;
    this.dropMap();
    this.prefetch();
    if (this.visible) this.requestFrame();
  }

  dropMap() {
    this.cancelJob();
    this.map = null;
    this.list = null;
    this.tiles.clear();
    this.frames.clear();
  }

  // ---- Reading the map in the background ------------------------------------------------

  /** Whether the preview is on the page and shown (a hidden lobby reads nothing). */
  targetShown() {
    const t = this.target;
    if (!t?.isConnected) return false;
    return typeof t.getClientRects === 'function' ? t.getClientRects().length > 0 : true;
  }

  /**
   * Start reading the source's map when there is one to read: in idle
   * time while nobody waits, `urgent` (the lens shows) right away.
   */
  prefetch(urgent = false) {
    const src = this.source;
    if (!src || src.failed || this.map) return;
    if (!urgent && !this.targetShown()) return;
    if (this.job?.source !== src) {
      this.cancelJob();
      this.job = { source: src, steps: null, progress: 0, timer: null };
    }
    this.schedule(urgent);
  }

  /** Queue the job's next step (once). */
  schedule(urgent) {
    const job = this.job;
    if (!job) return;
    // Waiting for idle time while someone now waits for the map: run sooner.
    if (job.timer?.idle && urgent) {
      job.timer.cancel();
      job.timer = null;
    }
    if (job.timer) return;
    const run = () => {
      job.timer = null;
      this.pump(job);
    };
    if (!urgent && !this.visible && typeof this.win?.requestIdleCallback === 'function') {
      const id = this.win.requestIdleCallback(run, { timeout: IDLE_TIMEOUT_MS });
      job.timer = { idle: true, cancel: () => this.win.cancelIdleCallback?.(id) };
    } else {
      const id = this.win?.setTimeout?.(run, LOADING_STEP_MS);
      job.timer = { cancel: () => this.win?.clearTimeout?.(id) };
    }
  }

  /** One step of reading the map (a source's `load` gives the map, or step generator: js/maplens/source.js). */
  pump(job) {
    if (this.job !== job) return;
    const src = job.source;
    try {
      let map = null;
      if (!job.steps) {
        const r = src.load(this.art);
        if (r && typeof r.next === 'function') job.steps = r;
        else map = r;
      }
      if (job.steps) {
        const r = job.steps.next();
        if (r.done) map = r.value;
        else job.progress = Math.max(job.progress, Math.min(1, Number(r.value) || 0));
      }
      if (map) {
        this.job = null;
        this.map = map;
        this.list = null;
        if (this.colors) map.colors = playerColors(map.palette ?? map.colors, this.colors);
        if (this.visible) this.requestFrame();
        return;
      }
    } catch (err) {
      this.job = null;
      src.failed = true;
      console.warn('Map lens unavailable:', err);
      this.hide();
      return;
    }
    if (this.visible) this.requestFrame();
    this.schedule(this.visible);
  }

  /** Stop reading (another map, or none): the engine game of an unfinished read is freed. */
  cancelJob() {
    const job = this.job;
    if (!job) return;
    this.job = null;
    job.timer?.cancel();
    try {
      job.steps?.return?.();
    } catch (err) {
      console.warn('Map lens: stopping a read failed:', err);
    }
  }

  destroy() {
    this.detach();
    this.offArt?.();
    this.win?.removeEventListener?.('scroll', this.onScroll, { capture: true });
    this.win?.removeEventListener?.('blur', this.onBlur);
    this.cancelJob();
    if (this.frame) this.win?.cancelAnimationFrame?.(this.frame);
    this.frame = 0;
    this.clearSource();
    this.el?.remove();
    this.el = null;
    this.canvas = null;
  }

  // ---- Pointer --------------------------------------------------------------------

  pointerMove(e) {
    if (e.pointerType === 'touch') {
      const t = this.touch;
      if (!t || e.pointerId !== t.id) return;
      if (!t.shown) {
        if (Math.hypot(e.clientX - t.x, e.clientY - t.y) > HOLD_SLOP) this.touchEnd();
        return;
      }
      this.pointer = { x: e.clientX, y: e.clientY, touch: true };
      this.follow();
      return;
    }
    const moved = !this.pointer || this.pointer.touch || this.pointer.x !== e.clientX || this.pointer.y !== e.clientY;
    if (e.type === 'pointermove' && moved) this.armed = true;
    this.pointer = { x: e.clientX, y: e.clientY, touch: false };
    this.follow();
  }

  touchDown(e) {
    this.touchEnd();
    const t = { id: e.pointerId, x: e.clientX, y: e.clientY, shown: false, timer: 0 };
    t.timer = this.win.setTimeout(() => {
      if (this.touch !== t) return;
      t.shown = true;
      this.pointer = { x: t.x, y: t.y, touch: true };
      this.follow();
    }, HOLD_MS);
    this.touch = t;
  }

  touchEnd() {
    if (!this.touch) return;
    this.win?.clearTimeout?.(this.touch.timer);
    const shown = this.touch.shown;
    this.touch = null;
    if (shown) {
      this.holdEnded = this.now();
      this.leave();
    }
  }

  leave() {
    this.armed = false;
    this.pointer = null;
    this.hide();
  }

  wheel(e) {
    if (!this.visible || !this.armed || !this.pointer || this.pointer.touch) return;
    const scale = this.gameScale();
    const zoom = this.zoom();
    const next = wheelZoom(zoom, e.deltaY, e.deltaMode, zoomLimits(scale));
    // At a limit the wheel is the page's again.
    if (Math.abs(next - zoom) < 1e-9) return;
    e.preventDefault();
    this.factor = next / baseZoom(scale);
    this.requestFrame();
  }

  /** CSS px per world pixel in the lens. */
  zoom() {
    const scale = this.gameScale();
    const { min, max } = zoomLimits(scale);
    return clamp(baseZoom(scale) * this.factor, min, max);
  }

  // ---- Showing --------------------------------------------------------------------

  /** The map's size in cells: the read map's, else the source's, else the picture's. */
  mapSize() {
    if (this.map) return { width: this.map.width, height: this.map.height };
    if (this.source?.size) return this.source.size;
    return { width: this.image?.width || 0, height: this.image?.height || 0 };
  }

  /** Where the picture of the map is on screen (client px). */
  pictureBox() {
    const img = this.image;
    const style = this.win.getComputedStyle(img);
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    return contentBox(img.getBoundingClientRect(), style, iw, ih);
  }

  /** Move the lens to the pointer (show it), or hide it when that is not possible. */
  follow() {
    const p = this.pointer;
    if (!p || !this.source || this.source.failed || !this.target?.isConnected || !this.image) return this.hide();
    const r = this.target.getBoundingClientRect();
    if (!p.touch && (p.x < r.left || p.y < r.top || p.x > r.right || p.y > r.bottom)) return this.hide();
    const { width, height } = this.mapSize();
    if (!(width > 0 && height > 0)) return this.hide();
    this.centre = cellAt(this.pictureBox(), width, height, p.x, p.y);
    this.show();
    this.requestFrame();
  }

  ensureElement() {
    if (this.el) return;
    const el = this.doc.createElement('div');
    el.className = 'map-lens';
    el.setAttribute('aria-hidden', 'true');
    el.hidden = true;
    const canvas = this.doc.createElement('canvas');
    canvas.className = 'map-lens-canvas';
    el.append(canvas);
    this.doc.body.append(el);
    this.el = el;
    this.canvas = canvas;
  }

  show() {
    this.ensureElement();
    if (!this.visible) {
      this.el.hidden = false;
      this.visible = true;
    }
    const size = this.el.getBoundingClientRect().width;
    const viewport = { width: this.win.innerWidth, height: this.win.innerHeight };
    const { left, top } = lensPlacement(this.pointer, size, viewport, this.pointer.touch);
    this.el.style.setProperty('--map-lens-x', `${Math.round(left)}px`);
    this.el.style.setProperty('--map-lens-y', `${Math.round(top)}px`);
    this.el.classList.toggle('map-lens-touch', !!this.pointer.touch);
    this.size = size;
  }

  hide() {
    if (!this.visible) return;
    this.visible = false;
    if (this.el) this.el.hidden = true;
  }

  requestFrame() {
    if (this.frame || !this.win?.requestAnimationFrame) return;
    this.frame = this.win.requestAnimationFrame(() => {
      this.frame = 0;
      this.step();
    });
  }

  /** One frame: draw the lens, then work on the tiles it needs within the budget. */
  step() {
    if (!this.visible) return;
    if (this.map && this.art && this.map.version !== this.art.version) this.dropMap();
    if (!this.map) {
      // The preview's pixels under the loading ring; the map is read in
      // steps between frames (never in this frame).
      this.prefetch(true);
      if (!this.visible) return;
      this.draw();
      this.drawLoading();
      if (!this.reducedMotion()) this.requestFrame();
      return;
    }
    const t0 = this.now();
    const missing = this.draw();
    const t1 = this.now();
    this.stats.draw = t1 - t0;
    let changed = false;
    for (const key of missing) {
      if (this.now() - t1 >= this.budgetMs) break;
      changed = this.work(key, t1) || changed;
    }
    this.stats.work = this.now() - t1;
    if (changed) this.draw();
    if (missing.some((k) => !this.tiles.get(k)?.done)) this.requestFrame();
  }

  /**
   * The loading state over the preview's pixels: dimmed, a ring that fills
   * with the share read, a turning arc (not with reduced motion) and
   * "Loading map".
   */
  drawLoading() {
    const ctx = this.canvas.getContext('2d');
    const side = this.canvas.width;
    const c = side / 2;
    const r = side * 0.16;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.fillRect(0, 0, side, side);
    ctx.lineWidth = Math.max(3, side * 0.03);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(c, c, r, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.stroke();
    const progress = this.job?.progress ?? 0;
    const accent = this.win.getComputedStyle?.(this.el)?.borderTopColor || '#e0301f';
    if (progress > 0) {
      ctx.beginPath();
      ctx.arc(c, c, r, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
      ctx.strokeStyle = accent;
      ctx.stroke();
    }
    if (!this.reducedMotion()) {
      const a = ((this.now() / 900) % 1) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(c, c, r * 0.62, a, a + Math.PI * 0.6);
      ctx.strokeStyle = '#fff';
      ctx.stroke();
    }
    const family = this.win.getComputedStyle?.(this.el)?.fontFamily || 'sans-serif';
    ctx.font = `900 ${Math.round(side * 0.075)}px ${family}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = Math.max(2, side * 0.015);
    ctx.strokeStyle = '#000';
    ctx.fillStyle = '#fff';
    ctx.strokeText('Loading map', c, c + r + side * 0.09);
    ctx.fillText('Loading map', c, c + r + side * 0.09);
  }

  /** A tile entry: its canvas, pixels and how many rows are drawn. */
  tile(key, tx, ty) {
    let t = this.tiles.get(key);
    if (!t) {
      const size = TILE_CELLS * CELL_PX;
      const canvas = this.doc.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      t = { tx, ty, canvas, ctx, img: ctx.createImageData(size, size), row: 0, done: false };
      this.tiles.set(key, t);
    }
    return t;
  }

  /** Draw rows of tile `key` until the frame's budget is spent; true when it finished. */
  work(key, start) {
    const map = this.map;
    if (!map) return false;
    const [tx, ty] = key.split(',').map(Number);
    const t = this.tile(key, tx, ty);
    if (t.done) return false;
    const size = TILE_CELLS * CELL_PX;
    const ROWS = 8;
    while (t.row < size && this.now() - start < this.budgetMs) {
      const next = Math.min(size, t.row + ROWS);
      map.terrain.renderRows(t.img.data, tx * TILE_CELLS, ty * TILE_CELLS, TILE_CELLS, CELL_PX, t.row, next);
      t.row = next;
    }
    if (t.row < size) return false;
    t.ctx.putImageData(t.img, 0, 0);
    t.img = null;
    this.list ??= spriteList(map);
    paintSprites(t.ctx, this.list, tx * size, ty * size, size, (s) => this.frameImage(s), map.atlas.filter !== 'nearest');
    t.done = true;
    return true;
  }

  /** A sprite frame tinted in its team colour (and flash), as a canvas; cached. */
  frameImage(s) {
    const map = this.map;
    const flash = s.flash < 0 ? -1 : Math.round(s.flash * 20) / 20;
    const key = `${s.index}|${s.team}|${flash}`;
    let img = this.frames.get(key);
    if (img !== undefined) return img;
    const { sx, sy, sw, sh } = s.quad;
    const color = map.atlas.color.getContext('2d').getImageData(sx, sy, sw, sh).data;
    const mask = map.atlas.mask.getContext('2d').getImageData(sx, sy, sw, sh).data;
    img = this.doc.createElement('canvas');
    img.width = sw;
    img.height = sh;
    const ctx = img.getContext('2d');
    const data = ctx.createImageData(sw, sh);
    data.data.set(tintPixels(color, mask, map.colors[s.team], flash));
    ctx.putImageData(data, 0, 0);
    this.frames.set(key, img);
    return img;
  }

  /**
   * Draw the lens at the current centre: ready tiles, the preview's pixels
   * where a tile is not ready, then the start markers. Returns the keys of
   * the tiles still to draw, nearest first.
   */
  draw() {
    const canvas = this.canvas;
    const dpr = Math.min(2, this.win.devicePixelRatio || 1);
    const side = Math.max(1, Math.round((this.size || 0) * dpr));
    if (canvas.width !== side) canvas.width = side;
    if (canvas.height !== side) canvas.height = side;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, side, side);
    const { width, height } = this.mapSize();
    const c = this.centre;
    if (!c || !(width > 0)) return [];
    const scale = this.zoom() * dpr; // device px per world pixel
    const viewCells = side / scale / CELL_PX;
    const ox = c.x * CELL_PX - side / 2 / scale;
    const oy = c.y * CELL_PX - side / 2 / scale;
    const tilePx = TILE_CELLS * CELL_PX;
    const missing = [];
    const smooth = this.map ? !this.map.terrainPixelArt : false;
    for (const [tx, ty] of tilesFor(c, viewCells, viewCells, width, height)) {
      const key = `${tx},${ty}`;
      const dx = (tx * tilePx - ox) * scale;
      const dy = (ty * tilePx - oy) * scale;
      const t = this.map ? this.tiles.get(key) : null;
      if (t?.done) {
        ctx.imageSmoothingEnabled = smooth;
        ctx.drawImage(t.canvas, dx, dy, tilePx * scale, tilePx * scale);
        continue;
      }
      if (this.map) missing.push(key);
      this.placeholder(ctx, tx, ty, dx, dy, scale, width, height);
    }
    this.drawMarkers(ctx, ox, oy, scale);
    return missing;
  }

  /** The preview's own pixels for a tile that is not drawn yet. */
  placeholder(ctx, tx, ty, dx, dy, scale, width, height) {
    const img = this.image;
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    if (!(iw > 0 && ih > 0)) return;
    const cx0 = tx * TILE_CELLS;
    const cy0 = ty * TILE_CELLS;
    const cols = Math.min(TILE_CELLS, width - cx0);
    const rows = Math.min(TILE_CELLS, height - cy0);
    if (cols <= 0 || rows <= 0) return;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, (cx0 * iw) / width, (cy0 * ih) / height, (cols * iw) / width, (rows * ih) / height, dx, dy, cols * CELL_PX * scale, rows * CELL_PX * scale);
  }

  /** Numbered start markers in their player's colour (empty starts hollow), at the game's construction yard centres. */
  drawMarkers(ctx, ox, oy, scale) {
    const list = this.markers.length ? this.markers : (this.map?.spawns ?? []).map(([x, y], k) => ({ x: x + 1.5, y: y + 2, label: String(k + 1), color: this.map.colors[k] }));
    const hot = this.markers.length ? this.hot : -1;
    if (!list.length) return;
    const r = Math.max(9, CELL_PX * 0.55 * scale);
    const family = this.win.getComputedStyle?.(this.el)?.fontFamily || 'sans-serif';
    ctx.font = `900 ${Math.round(r * 1.1)}px ${family}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = Math.max(2, r / 5);
    for (const [k, m] of list.entries()) {
      const x = (m.x * CELL_PX - ox) * scale;
      const y = (m.y * CELL_PX - oy) * scale;
      if (x < -r * 2 || y < -r * 2 || x > this.canvas.width + r * 2 || y > this.canvas.height + r * 2) continue;
      if (k === hot) {
        // The marker a click picks: an accent ring around it.
        ctx.beginPath();
        ctx.arc(x, y, r * 1.45, 0, Math.PI * 2);
        ctx.strokeStyle = this.win.getComputedStyle?.(this.el)?.borderTopColor || '#e0301f';
        ctx.lineWidth = Math.max(3, r / 3);
        ctx.stroke();
        ctx.lineWidth = Math.max(2, r / 5);
      }
      // The automatic choice's start (not picked) has a dashed ring.
      ctx.setLineDash?.(m.color && m.picked === false ? [r / 3, r / 4] : []);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.strokeStyle = m.color ? '#000' : '#fff';
      if (m.color) {
        ctx.fillStyle = `rgb(${m.color.map((v) => Math.round(v * 255)).join(',')})`;
        ctx.fill();
      }
      ctx.stroke();
      ctx.setLineDash?.([]);
      if (m.label) {
        ctx.strokeText(m.label, x, y);
        ctx.fillStyle = '#fff';
        ctx.fillText(m.label, x, y);
      }
    }
  }
}


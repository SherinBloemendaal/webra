// UI scale and game scale (game menu, Settings; settings registry
// game.uiScale and game.gameScale). Three settings change how the game looks,
// and the Settings page tells them apart:
//
// - UI scale: the size of the chrome (sidebar, bars, HUD, menus, dialogs).
//   It sets --ui-scale on <html>; the stylesheets size the chrome in
//   multiples of --ui-px (css/theme.css), so the layout reflows at the new
//   size, text stays sharp, and the battlefield canvas takes the room left.
// - Game scale: how big units and terrain appear, as the camera's base zoom
//   (js/input.js). The mouse wheel, pinch and the zoom keys zoom relative to
//   it, between limits that scale with it. The player's own zoom is kept as
//   a factor of it (game.zoomFactor), so the next game starts there and a
//   new game scale keeps it.
// - Render resolution (pixelRatioCap, lowQuality; js/layout.js): how many
//   pixels the battlefield is drawn with. Sharpness and speed, not size.
//
// Both scales can be 'auto': the game picks a value for the screen and picks
// again when the window or its pixel density changes.
//
// No DOM at module level: Node tests import the math.

import { UI_SCALE_LIMITS, GAME_SCALE_LIMITS, ZOOM_FACTOR_LIMITS } from '../protocol/accounts.js';
import { isCompact, layoutMode, renderPixelRatio } from './layout.js';

export { UI_SCALE_LIMITS, GAME_SCALE_LIMITS, ZOOM_FACTOR_LIMITS };

/** Camera zoom (CSS px per world px) at game scale 1, and the zoom limits at game scale 1. */
export const DEFAULT_ZOOM = 1.5;
export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 4;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const positive = (v, fallback) => (Number.isFinite(v) && v > 0 ? v : fallback);

/** `v` rounded to a multiple of `step`, without float noise (0.1 + 0.2 stays 0.3). */
export const roundStep = (v, step) => Number((Math.round(v / step) * step).toFixed(6));

/** A scale as text: 0.85 -> "85%". */
export const percent = (v) => `${Math.round(v * 100)}%`;

/**
 * The screen as the auto choices see it: the window in CSS px, its device
 * pixel ratio, and whether it gets a phone layout (js/layout.js).
 */
export function screenOf(win) {
  const width = positive(win?.innerWidth, 1280);
  const height = positive(win?.innerHeight, 800);
  return { width, height, dpr: positive(win?.devicePixelRatio, 1), compact: isCompact(layoutMode(width, height)) };
}

// ---- UI scale -------------------------------------------------------------------------

/** The chrome is drawn for windows of at least this size (CSS px) at 100%. */
export const UI_REFERENCE = Object.freeze({ width: 1600, height: 900 });
/**
 * Auto never goes below this, so text stays readable (11 px text at 85% is
 * 9.35 px). Auto ignores the pixel density: a CSS pixel has about the same
 * size on retina and other screens, so the chrome does too.
 */
export const UI_AUTO_FLOOR = 0.85;

/**
 * The UI scale Auto picks. Phone layouts keep 100% (their drawers and touch
 * targets are made for the screen, css/touch.css). Desktop windows smaller
 * than UI_REFERENCE shrink the chrome so the battlefield keeps its room,
 * never below the readable floor and never above 100%.
 * @param {{ width: number, height: number, dpr?: number, compact?: boolean }} screen
 */
export function autoUiScale({ width, height, compact = false }) {
  if (compact) return 1;
  const fit = Math.min(1, positive(width, UI_REFERENCE.width) / UI_REFERENCE.width, positive(height, UI_REFERENCE.height) / UI_REFERENCE.height);
  return roundStep(clamp(fit, UI_AUTO_FLOOR, 1), UI_SCALE_LIMITS.step);
}

/** The UI scale for a setting value ('auto' or a factor) on a screen. */
export function resolveUiScale(setting, screen) {
  if (setting === 'auto' || !Number.isFinite(setting)) return autoUiScale(screen);
  return clamp(setting, UI_SCALE_LIMITS.min, UI_SCALE_LIMITS.max);
}

/** Put a UI scale on the page (css/theme.css reads --ui-scale). CSSOM only: the CSP allows no style attribute. */
export function applyUiScale(root, scale) {
  root.style.setProperty('--ui-scale', String(scale));
}

/**
 * Calls `fn` when the device pixel ratio changes (a window dragged to another
 * monitor, browser zoom); resize events do not always come with it.
 * Returns a function that stops watching.
 */
export function watchPixelRatio(win, fn) {
  if (typeof win?.matchMedia !== 'function') return () => {};
  let query = null;
  let stopped = false;
  const arm = () => {
    if (stopped) return;
    query = win.matchMedia(`(resolution: ${positive(win.devicePixelRatio, 1)}dppx)`);
    query.addEventListener?.('change', changed, { once: true });
  };
  const changed = () => {
    fn();
    arm();
  };
  arm();
  return () => {
    stopped = true;
    query?.removeEventListener?.('change', changed);
  };
}

/**
 * Keeps the page's UI scale in step with the setting and the screen.
 * `preview(v)` shows a value while a slider is dragged without storing it;
 * `endPreview()` goes back to the stored setting.
 */
export class UiScale {
  /**
   * @param {{
   *   settings: { get(k: string): any, subscribe(k: string, fn: Function): Function },
   *   win?: Window,
   *   root?: HTMLElement,
   * }} o
   */
  constructor({ settings, win = globalThis.window, root = globalThis.document?.documentElement }) {
    this.settings = settings;
    this.win = win;
    this.root = root;
    this.value = null; // none applied yet
    this.previewing = null;
    this.listeners = new Set();
    this.update = this.update.bind(this);
    this.offs = [settings.subscribe('uiScale', this.update), watchPixelRatio(win, this.update)];
    win?.addEventListener?.('resize', this.update);
    this.offs.push(() => win?.removeEventListener?.('resize', this.update));
    this.update();
  }

  /** What Auto gives on this screen now. */
  get auto() {
    return autoUiScale(screenOf(this.win));
  }

  update() {
    const next = this.previewing ?? resolveUiScale(this.settings.get('uiScale'), screenOf(this.win));
    if (this.root) applyUiScale(this.root, next);
    if (next === this.value) return;
    this.value = next;
    // Also when Auto picked another value for the screen: the Settings page shows it.
    for (const fn of [...this.listeners]) fn(next);
  }

  preview(v) {
    this.previewing = clamp(v, UI_SCALE_LIMITS.min, UI_SCALE_LIMITS.max);
    this.update();
  }

  endPreview() {
    this.previewing = null;
    this.update();
  }

  /** fn(scale) whenever the applied scale changes. Returns unsubscribe. */
  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  dispose() {
    for (const off of this.offs) off();
    this.listeners.clear();
  }
}

// ---- Game scale ---------------------------------------------------------------------------

/** Camera zoom at a game scale: the zoom the view starts at and "Reset zoom" returns to. */
export const baseZoom = (scale) => DEFAULT_ZOOM * scale;

/** Zoom limits (mouse wheel, pinch, zoom keys) at a game scale: they scale with it. */
export const zoomLimits = (scale) => ({ min: MIN_ZOOM * scale, max: MAX_ZOOM * scale });

/** `zoom` kept within the limits of a game scale. */
export const clampZoom = (zoom, scale) => {
  const { min, max } = zoomLimits(scale);
  return clamp(zoom, min, max);
};

/**
 * A zoom carried over from one game scale to another: the player's wheel
 * zoom stays the same factor of the base zoom.
 */
export const rescaleZoom = (zoom, from, to) => clampZoom((zoom * to) / from, to);

/**
 * The player's zoom as a factor of the base zoom (the remembered zoom,
 * game.zoomFactor), kept within ZOOM_FACTOR_LIMITS: the zoom limits over
 * the base zoom, the same at every game scale.
 */
export const zoomFactorOf = (zoom, scale) => clamp(zoom / baseZoom(scale), ZOOM_FACTOR_LIMITS.min, ZOOM_FACTOR_LIMITS.max);

/** The zoom for a remembered factor at a game scale, within its zoom limits (no factor: the base zoom). */
export const zoomForFactor = (factor, scale) => clampZoom(baseZoom(scale) * positive(factor, 1), scale);

/**
 * Render pixels per world pixel at a game scale and render pixel ratio
 * (js/renderer.js draws with camera.zoom times the render ratio).
 */
export const renderPixelsPerWorldPixel = (scale, ratio) => baseZoom(scale) * ratio;

/**
 * Game scales (within the limits) where one world pixel covers a whole
 * number of render pixels at the base zoom: pixel art (original graphics,
 * nearest sampling) looks sharpest there.
 * @param {number} ratio render pixel ratio (js/layout.js renderPixelRatio)
 */
export function crispGameScales(ratio, { min, max } = GAME_SCALE_LIMITS) {
  const per = DEFAULT_ZOOM * positive(ratio, 1);
  const out = [];
  for (let n = Math.max(1, Math.ceil(min * per - 1e-9)); n / per <= max + 1e-9; n++) out.push(n / per);
  return out;
}

/** How close (as a scale) a slider value snaps to a sharp scale. */
export const CRISP_SNAP = 0.03;

/**
 * A slider value as a game scale: a sharp scale (crispGameScales) when it is
 * within CRISP_SNAP of one, else rounded to the setting's step.
 */
export function snapGameScale(value, ratio, limits = GAME_SCALE_LIMITS) {
  const v = clamp(value, limits.min, limits.max);
  let best = null;
  for (const s of crispGameScales(ratio, limits)) if (Math.abs(s - v) <= CRISP_SNAP && (best === null || Math.abs(s - v) < Math.abs(best - v))) best = s;
  return best ?? clamp(roundStep(v, limits.step), limits.min, limits.max);
}

/** The window size (CSS px) at which Auto keeps game scale 100%. */
export const GAME_REFERENCE = Object.freeze({ width: 1920, height: 1080 });
/** Auto follows the window between these factors of the reference. */
export const GAME_AUTO_FIT = Object.freeze({ min: 0.85, max: 1.5 });

/**
 * The game scale Auto picks: larger windows show the battlefield larger
 * (a 4K monitor at 100% does not look tiny), smaller ones smaller, phones
 * keep 100%. When a world pixel covers two or more render pixels, it is
 * rounded to a whole number of them, so sprites stay sharp on high-density
 * screens: to the nearest one for windows of at least GAME_REFERENCE, and
 * down for smaller windows, so they never show the battlefield larger than
 * the reference does (a 14" MacBook, 1512 x 982 at 2x: 2.55 render px goes
 * down to 2, about 63 x 41 cells, not up to 3 and 42 x 27 cells).
 * @param {{ width: number, height: number, ratio?: number, compact?: boolean }} screen
 *   ratio: the render pixel ratio (device ratio after the resolution cap)
 */
export function autoGameScale({ width, height, ratio = 1, compact = false }) {
  const fit = compact
    ? 1
    : clamp(Math.min(positive(width, GAME_REFERENCE.width) / GAME_REFERENCE.width, positive(height, GAME_REFERENCE.height) / GAME_REFERENCE.height), GAME_AUTO_FIT.min, GAME_AUTO_FIT.max);
  const per = DEFAULT_ZOOM * positive(ratio, 1);
  let render = per * fit;
  // The small epsilon keeps a product like 2.9999999999999996 at 3.
  if (render >= 2) render = fit < 1 ? Math.floor(render + 1e-9) : Math.round(render);
  return clamp(render / per, GAME_SCALE_LIMITS.min, GAME_SCALE_LIMITS.max);
}

/** The game scale for a setting value ('auto' or a factor) on a screen. */
export function resolveGameScale(setting, screen) {
  if (setting === 'auto' || !Number.isFinite(setting)) return autoGameScale(screen);
  return clamp(setting, GAME_SCALE_LIMITS.min, GAME_SCALE_LIMITS.max);
}

/**
 * The game scale in use for this window outside a game (the map lens of the
 * lobby, the campaign screen and the map editor), at the render pixel ratio
 * a game would draw with (js/layout.js renderPixelRatio, as js/main.js gives
 * the renderer), so it matches the game's own base zoom.
 * @param {{ get(k: string): any }} settings  the game settings (js/settings.js)
 */
export function gameScaleFor(settings, win = globalThis.window) {
  const ratio = renderPixelRatio(win?.devicePixelRatio, settings.get('pixelRatioCap'), settings.get('lowQuality'));
  return resolveGameScale(settings.get('gameScale'), { ...screenOf(win), ratio });
}

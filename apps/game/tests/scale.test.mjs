// UI scale and game scale (js/scale.js): the auto choices, the CSS variable
// on the page, the stylesheets sizing the chrome in --ui-px, the camera's
// base zoom and zoom limits, and screen-to-world mapping at several game
// scales and pixel ratios. No browser. Run with: node --test apps/game/tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_ZOOM,
  MIN_ZOOM,
  MAX_ZOOM,
  UI_SCALE_LIMITS,
  GAME_AUTO_FIT,
  GAME_SCALE_LIMITS,
  ZOOM_FACTOR_LIMITS,
  UiScale,
  applyUiScale,
  autoGameScale,
  autoUiScale,
  baseZoom,
  clampZoom,
  crispGameScales,
  gameScaleFor,
  percent,
  renderPixelsPerWorldPixel,
  rescaleZoom,
  resolveGameScale,
  resolveUiScale,
  roundStep,
  screenOf,
  snapGameScale,
  zoomFactorOf,
  zoomForFactor,
  zoomLimits,
  CRISP_SNAP,
} from '../js/scale.js';
import { renderPixelRatio } from '../js/layout.js';
import { createSettings } from '../js/settings.js';
import { createRegistry } from '../js/registry.js';
import { HotkeyRegistry } from '../js/hotkeys.js';
import { installDom, uninstallDom, memoryStorage } from './dom-fixtures.mjs';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

/** A window of w x h CSS px at a device pixel ratio, with resize listeners. */
function fakeWindow(w, h, dpr = 1) {
  const listeners = new Map();
  const media = [];
  return {
    innerWidth: w,
    innerHeight: h,
    devicePixelRatio: dpr,
    addEventListener: (type, fn) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    removeEventListener: (type, fn) => listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn)),
    matchMedia(query) {
      const q = { query, fns: [], addEventListener: (_t, fn) => q.fns.push(fn), removeEventListener: (_t, fn) => (q.fns = q.fns.filter((f) => f !== fn)) };
      media.push(q);
      return q;
    },
    resize(nw, nh, ndpr = this.devicePixelRatio) {
      const ratioChanged = ndpr !== this.devicePixelRatio;
      Object.assign(this, { innerWidth: nw, innerHeight: nh, devicePixelRatio: ndpr });
      if (ratioChanged) for (const q of media.splice(0)) for (const fn of q.fns) fn();
      for (const fn of listeners.get('resize') ?? []) fn();
    },
    listenerCount: (type) => (listeners.get(type) ?? []).length,
  };
}

/** The page root: records CSS custom properties set through the CSSOM (the CSP allows no style attribute). */
function fakeRoot() {
  const props = new Map();
  return {
    props,
    style: {
      setProperty: (k, v) => props.set(k, v),
      removeProperty: (k) => props.delete(k),
    },
    setAttribute(k) {
      if (k === 'style') throw new Error('inline style attribute: the CSP forbids it');
    },
  };
}

const memorySettings = () => createSettings(createRegistry({ storage: null }));

// ---- UI scale ----------------------------------------------------------------------------

test('ui scale: auto picks 100% on large windows and phones, smaller in small windows, never below readable, whatever the pixel density', () => {
  assert.equal(autoUiScale({ width: 1920, height: 1080, dpr: 1 }), 1);
  assert.equal(autoUiScale({ width: 3840, height: 2160, dpr: 1 }), 1, 'never above 100%');
  assert.equal(autoUiScale({ width: 1366, height: 768, dpr: 1 }), 0.85, 'small laptop: fits, at the floor');
  assert.equal(autoUiScale({ width: 1600, height: 900, dpr: 1 }), 1);
  // Retina laptops and 4K monitors at 200%: CSS pixels have the usual size, so the same scale as at 1x.
  assert.equal(autoUiScale({ width: 1512, height: 982, dpr: 2 }), 0.95);
  assert.equal(autoUiScale({ width: 1920, height: 1080, dpr: 2 }), 1);
  assert.equal(autoUiScale({ width: 1280, height: 800, dpr: 2 }), autoUiScale({ width: 1280, height: 800, dpr: 1 }));
  assert.equal(autoUiScale({ width: 800, height: 600, dpr: 1 }), 0.85, 'readable floor');
  // Phones keep their touch layout at 100%.
  assert.equal(autoUiScale({ width: 390, height: 844, dpr: 3, compact: true }), 1);
  // Every auto value is a step of the setting and inside its limits.
  for (const w of [640, 900, 1024, 1280, 1440, 1512, 1728, 1920, 2560, 3840]) {
    for (const h of [480, 700, 800, 900, 1080, 1440]) {
      for (const dpr of [1, 1.25, 1.5, 2, 3]) {
        const v = autoUiScale({ width: w, height: h, dpr });
        assert.ok(v >= 0.85 && v <= 1, `${w}x${h}@${dpr}: ${v}`);
        assert.equal(v, roundStep(v, UI_SCALE_LIMITS.step));
      }
    }
  }
  // Garbage screens fall back to the reference size.
  assert.equal(autoUiScale({ width: NaN, height: 0, dpr: undefined }), 1);
});

test('ui scale: a fixed setting is clamped to the limits; auto resolves per screen', () => {
  const screen = { width: 1366, height: 768, dpr: 1, compact: false };
  assert.equal(resolveUiScale('auto', screen), 0.85);
  assert.equal(resolveUiScale(1.25, screen), 1.25);
  assert.equal(resolveUiScale(9, screen), UI_SCALE_LIMITS.max);
  assert.equal(resolveUiScale(0.1, screen), UI_SCALE_LIMITS.min);
  assert.deepEqual(screenOf({ innerWidth: 390, innerHeight: 844, devicePixelRatio: 3 }), { width: 390, height: 844, dpr: 3, compact: true });
  assert.equal(screenOf(null).compact, false);
  assert.equal(percent(0.85), '85%');
  assert.equal(percent(2 / 3), '67%');
});

test('ui scale: --ui-scale follows the setting, the window and its pixel ratio, without reload; preview does not store', () => {
  const settings = memorySettings();
  const win = fakeWindow(1920, 1080, 1);
  const root = fakeRoot();
  const ui = new UiScale({ settings, win, root });
  assert.equal(root.props.get('--ui-scale'), '1');
  const heard = [];
  ui.onChange((v) => heard.push(v));
  win.resize(1366, 768);
  assert.equal(root.props.get('--ui-scale'), '0.85', 'auto follows the window');
  win.resize(1440, 810, 2);
  assert.equal(root.props.get('--ui-scale'), '0.9', 'auto follows the window on another monitor');
  win.resize(1440, 810, 1);
  assert.equal(root.props.get('--ui-scale'), '0.9', 'and not its pixel ratio');
  settings.set('uiScale', 1.5);
  assert.equal(root.props.get('--ui-scale'), '1.5');
  win.resize(800, 600);
  assert.equal(root.props.get('--ui-scale'), '1.5', 'a fixed scale ignores the window');
  ui.preview(0.7);
  assert.equal(root.props.get('--ui-scale'), '0.7');
  assert.equal(settings.get('uiScale'), 1.5, 'a preview is not stored');
  ui.preview(5);
  assert.equal(root.props.get('--ui-scale'), String(UI_SCALE_LIMITS.max), 'previews are clamped');
  ui.endPreview();
  assert.equal(root.props.get('--ui-scale'), '1.5');
  settings.reset('uiScale');
  assert.equal(settings.get('uiScale'), 'auto');
  assert.equal(ui.auto, autoUiScale(screenOf(win)));
  assert.deepEqual(heard.slice(0, 3), [0.85, 0.9, 1.5]);
  ui.dispose();
  assert.equal(win.listenerCount('resize'), 0);
  settings.set('uiScale', 0.6);
  assert.notEqual(root.props.get('--ui-scale'), '0.6', 'disposed: no more updates');
  applyUiScale(root, 1.1);
  assert.equal(root.props.get('--ui-scale'), '1.1');
});

// ---- Stylesheets ---------------------------------------------------------------------------

const CSS = (name) => readFileSync(fileURLToPath(new URL(`../css/${name}`, import.meta.url)), 'utf8');
/** The stylesheets of the game screen, its menu and dialogs: their sizes follow the UI scale. */
const SCALED_SHEETS = ['theme.css', 'style.css', 'sidebar.css', 'minimap.css', 'powers.css', 'audio.css', 'content.css', 'debug.css', 'releasenotes.css', 'touch.css', 'commandbar.css', 'tooltip.css', 'worldtooltip.css', 'boxchooser.css'];
/**
 * Properties that keep fixed pixels: hairlines, shadows, decorations, motion, and the
 * window's own margins around the menu screens (--ui-screen-gap and the corner clearance,
 * theme.css; the corner buttons' part of it is scaled with --ui-scale where it is set).
 * The token families that theme.css declares again over --ui-px for the scaled parts
 * (--ui-fs-*, --ui-space-*) keep their plain pixels at :root, and the focus ring, lamp
 * glows and tooltip shadow are outlines and shadows like the properties above.
 */
const FIXED = /^(border|outline|box-shadow|text-shadow|transform|transition|animation|background|filter|backdrop-filter|mask|-webkit-|scrollbar|--ui-(bevel|rivet|scan|brushed|grid|hazard|shadow|fs-|space-|focus-|led-|tip-shadow|primary-glow|radius|screen-gap|corner-clear))/;

test('ui scale css: the chrome is sized in --ui-px, scaled for the game screen, menu and dialogs only', () => {
  for (const sheet of SCALED_SHEETS) {
    const text = CSS(sheet).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of text.matchAll(/(^|[;{\s])([-\w]+)\s*:\s*([^;{}]+);/g)) {
      const [, , prop, value] = m;
      if (FIXED.test(prop)) continue;
      // Fixed pixels are left only as hairlines (1px) or as touch minimums inside max(44px, ...) and similar floors.
      const raw = value.replace(/max\(\s*\d+px\s*,/g, 'max(').match(/(?<![\w.-])-?(\d*\.?\d+)px\b/g) ?? [];
      const big = raw.filter((v) => Math.abs(parseFloat(v)) >= 2);
      assert.deepEqual(big, [], `${sheet}: ${prop}: ${value.trim()} should use var(--ui-px)`);
    }
  }
  const theme = CSS('theme.css');
  assert.match(theme, /:root\s*{[^}]*--ui-scale:\s*1;[^}]*--ui-px:\s*1px;/s, 'unscaled outside the game screen');
  const scoped = /#app,\s*#game-menu,[^{]*{([^}]*)}/s.exec(theme);
  assert.ok(scoped, 'the scaled parts redeclare --ui-px');
  assert.match(scoped[1], /--ui-px:\s*calc\(1px \* var\(--ui-scale\)\)/);
  for (const token of ['--ui-fs-xs', '--ui-fs-s', '--ui-fs-m', '--ui-fs-l', '--ui-fs-display', '--ui-fs-title', '--ui-fs-section', '--ui-fs-label', '--ui-fs-body', ...[1, 2, 3, 4, 5, 6, 7].map((n) => `--ui-space-${n}`)]) {
    assert.match(scoped[1], new RegExp(`${token}: calc\\(\\d+ \\* var\\(--ui-px\\)\\)`), token);
  }
  assert.match(scoped[1], /font-size: calc\(14 \* var\(--ui-px\)\)/, 'inherited text scales too');
  for (const id of ['#app', '#game-menu', '#ui-tooltip', '#gameover', '#toast', '#audio-panel', '#content-panel', '#release-notes']) assert.ok(scoped[0].includes(id), id);
  assert.ok(!scoped[0].includes('#menu,') && !scoped[0].includes('#menu {'), 'the lobby keeps its size');
  // Touch screens keep 44 px targets at any UI scale.
  const touch = CSS('touch.css');
  assert.ok((touch.match(/max\(44px, calc\(44 \* var\(--ui-px\)\)\)/g) ?? []).length >= 8);
  assert.match(touch, /body\.touch #app\[data-layout='desktop'\] #sidebar \{[^}]*width: max\(208px/s);
  assert.match(CSS('commandbar.css'), /body\.touch #commandbar \.cb-button \{[^}]*width: max\(44px/s);
});

test('csp: the scale and settings code sets styles only through the CSSOM', () => {
  const source = (file) => readFileSync(fileURLToPath(new URL(`../js/${file}`, import.meta.url)), 'utf8');
  for (const file of ['scale.js', 'gamemenu.js', 'audio/panel.js', 'commandbar.js', 'input.js', 'main.js']) {
    const src = source(file);
    assert.doesNotMatch(src, /setAttribute\(\s*['"]style['"]/, file);
    assert.doesNotMatch(src, /\.cssText|\sstyle=/, file);
  }
  // The new UI builds its DOM with createElement and textContent only.
  for (const file of ['scale.js', 'gamemenu.js', 'audio/panel.js']) assert.doesNotMatch(source(file), /innerHTML|insertAdjacentHTML|outerHTML/, file);
});

// ---- Game scale ------------------------------------------------------------------------------

test('game scale: base zoom and zoom limits scale together; a zoom keeps its factor across scales', () => {
  assert.equal(baseZoom(1), DEFAULT_ZOOM);
  assert.equal(baseZoom(2), DEFAULT_ZOOM * 2);
  assert.deepEqual(zoomLimits(1), { min: MIN_ZOOM, max: MAX_ZOOM });
  assert.deepEqual(zoomLimits(0.5), { min: MIN_ZOOM * 0.5, max: MAX_ZOOM * 0.5 });
  assert.equal(clampZoom(100, 2), MAX_ZOOM * 2);
  assert.equal(clampZoom(0.01, 2), MIN_ZOOM * 2);
  // The player zoomed in to 2x the base: still 2x the base at another scale.
  assert.ok(near(rescaleZoom(baseZoom(1) * 2, 1, 1.5), baseZoom(1.5) * 2));
  assert.ok(near(rescaleZoom(MAX_ZOOM, 1, 3), MAX_ZOOM * 3), 'limits move along');
  for (const s of [GAME_SCALE_LIMITS.min, 0.75, 1, 4 / 3, 2, GAME_SCALE_LIMITS.max]) {
    const { min, max } = zoomLimits(s);
    assert.ok(min < baseZoom(s) && baseZoom(s) < max, `base zoom inside the limits at ${s}`);
  }
});

test('game scale: sharp scales put whole render pixels on a world pixel; the slider snaps to them', () => {
  for (const ratio of [0.75, 1, 1.25, 1.5, 2, 3]) {
    const crisp = crispGameScales(ratio);
    assert.ok(crisp.length > 0, `ratio ${ratio}`);
    for (const s of crisp) {
      assert.ok(s >= GAME_SCALE_LIMITS.min - 1e-9 && s <= GAME_SCALE_LIMITS.max + 1e-9);
      const px = renderPixelsPerWorldPixel(s, ratio);
      assert.ok(near(px, Math.round(px), 1e-9), `${s} at ${ratio}: ${px} render px`);
    }
  }
  assert.deepEqual(crispGameScales(2).map((s) => Math.round(s * 1000)), [667, 1000, 1333, 1667, 2000, 2333, 2667, 3000]);
  assert.ok(near(snapGameScale(0.98, 2), 1));
  assert.ok(near(snapGameScale(1.31, 2), 4 / 3), 'snaps within reach');
  assert.equal(snapGameScale(1.17, 2), 1.15, 'else the setting step');
  assert.equal(snapGameScale(9, 2), GAME_SCALE_LIMITS.max);
  assert.equal(snapGameScale(0.1, 1), GAME_SCALE_LIMITS.min);
  assert.ok(CRISP_SNAP < GAME_SCALE_LIMITS.step, 'snapping never jumps over a step');
});

test('game scale: auto follows the window and rounds to whole render pixels on dense screens', () => {
  // 1080p at 1x: 100% as before.
  assert.equal(autoGameScale({ width: 1920, height: 1080, ratio: 1 }), 1);
  // Retina laptop (14" MacBook): smaller than the reference, so 2.55 render px goes down to 2, not up to 3.
  assert.ok(near(autoGameScale({ width: 1512, height: 982, ratio: 2 }), 2 / 3));
  // 4K at 100%: larger, rounded to 2 render px.
  assert.ok(near(autoGameScale({ width: 3840, height: 2160, ratio: 1 }), 4 / 3));
  // 5K at 200%: 4 render px.
  assert.ok(near(autoGameScale({ width: 2560, height: 1440, ratio: 2 }), 4 / 3));
  // Small window at 1x: a little smaller, not rounded (below 2 render px).
  assert.ok(near(autoGameScale({ width: 1366, height: 768, ratio: 1 }), 0.85));
  // Phones keep the base zoom.
  assert.equal(autoGameScale({ width: 390, height: 844, ratio: 2, compact: true }), 1);
  for (const ratio of [1, 1.25, 1.5, 2, 3]) {
    for (const [w, h] of [[1280, 720], [1440, 900], [1920, 1080], [2560, 1440], [3840, 2160]]) {
      const s = autoGameScale({ width: w, height: h, ratio });
      assert.ok(s >= GAME_SCALE_LIMITS.min && s <= GAME_SCALE_LIMITS.max);
      const px = renderPixelsPerWorldPixel(s, ratio);
      if (px >= 2) assert.ok(near(px, Math.round(px)), `${w}x${h}@${ratio}: whole render pixels`);
    }
  }
  // Windows smaller than the reference never show the battlefield larger than their fit asks for.
  for (const ratio of [1, 1.25, 1.5, 2, 3]) {
    for (const [w, h] of [[1280, 720], [1366, 768], [1440, 900], [1512, 982], [1728, 1117], [1800, 1000]]) {
      const fit = Math.max(GAME_AUTO_FIT.min, Math.min(w / 1920, h / 1080));
      assert.ok(autoGameScale({ width: w, height: h, ratio }) <= fit + 1e-9, `${w}x${h}@${ratio}`);
    }
  }
  const screen = { width: 1920, height: 1080, ratio: 1 };
  assert.equal(resolveGameScale('auto', screen), 1);
  assert.equal(resolveGameScale(2.5, screen), 2.5);
  assert.equal(resolveGameScale(99, screen), GAME_SCALE_LIMITS.max);
});

test('game scale: the starting view before and after rounding down on small sharp screens', () => {
  // [window, ratio, scale before (rounded to the nearest), scale now, cells across x down at the base zoom now].
  const CELL = 24;
  const table = [
    [1512, 982, 2, 1, 2 / 3, [63, 40.9]],
    [1728, 1117, 2, 1, 2 / 3, [72, 46.5]],
    [1920, 1080, 1, 1, 1, [53.3, 30]],
    [2560, 1440, 1, 4 / 3, 4 / 3, [53.3, 30]],
  ];
  for (const [width, height, ratio, before, now, [cx, cy]] of table) {
    const s = autoGameScale({ width, height, ratio });
    assert.ok(near(s, now), `${width}x${height}@${ratio}: ${s}`);
    // The old rule: the nearest whole number of render px at any window size.
    const per = DEFAULT_ZOOM * ratio;
    const fit = Math.min(GAME_AUTO_FIT.max, Math.max(GAME_AUTO_FIT.min, Math.min(width / 1920, height / 1080)));
    const old = per * fit >= 2 ? Math.round(per * fit) / per : fit;
    assert.ok(near(old, before), `before: ${old}`);
    const zoom = baseZoom(s);
    assert.ok(Math.abs(width / (CELL * zoom) - cx) < 0.05 && Math.abs(height / (CELL * zoom) - cy) < 0.05, `${width}x${height}: cells`);
  }
});

test('game scale outside a game: the map lens sees the scale a game would use (render ratio after the cap)', () => {
  const settings = memorySettings();
  const win = { innerWidth: 1512, innerHeight: 982, devicePixelRatio: 2 };
  assert.ok(near(gameScaleFor(settings, win), 2 / 3));
  // A 3x screen with the default cap of 2 draws at 2, as js/main.js gives the renderer.
  const dense = { innerWidth: 1512, innerHeight: 982, devicePixelRatio: 3 };
  assert.ok(near(gameScaleFor(settings, dense), autoGameScale({ ...screenOf(dense), ratio: renderPixelRatio(3, settings.get('pixelRatioCap')) })));
  settings.set('gameScale', 1.25);
  assert.equal(gameScaleFor(settings, win), 1.25);
});

test('remembered zoom: a factor of the base zoom within the zoom limits, the same at every game scale', () => {
  assert.ok(near(ZOOM_FACTOR_LIMITS.min * DEFAULT_ZOOM, MIN_ZOOM) && near(ZOOM_FACTOR_LIMITS.max * DEFAULT_ZOOM, MAX_ZOOM), 'the zoom limits over the base zoom');
  for (const scale of [0.5, 2 / 3, 1, 4 / 3, 3]) {
    assert.ok(near(zoomForFactor(1, scale), baseZoom(scale)));
    assert.ok(near(zoomForFactor(0.5, scale), baseZoom(scale) / 2));
    assert.ok(near(zoomFactorOf(zoomForFactor(1.7, scale), scale), 1.7));
    assert.ok(near(zoomForFactor(99, scale), MAX_ZOOM * scale), 'clamped to the limits');
    assert.ok(near(zoomForFactor(0.01, scale), MIN_ZOOM * scale));
    assert.equal(zoomForFactor(NaN, scale), baseZoom(scale), 'no factor: the base zoom');
    assert.equal(zoomFactorOf(1e9, scale), ZOOM_FACTOR_LIMITS.max);
  }
});

// ---- Input at several game scales and pixel ratios ------------------------------------------------

function makeInput(settings = memorySettings()) {
  installDom();
  const canvas = document.createElement('canvas');
  canvas.clientWidth = 800;
  canvas.clientHeight = 600;
  canvas.getBoundingClientRect = () => ({ left: 100, top: 50, width: 800, height: 600 });
  const game = {
    map_width: () => 128,
    map_height: () => 128,
    set_selection() {},
    pick: () => 0xffffffff,
    select_at: () => 0xffffffff,
  };
  const hotkeys = new HotkeyRegistry(settings);
  const hooks = { onSelectionChanged() {}, onPlaced() {}, onCancelPlace() {}, onPowerTargeting() {}, onSellMode() {} };
  return import('../js/input.js').then(({ Input }) => ({ input: new Input(canvas, game, { actors: [] }, 0, hooks, { hotkeys, settings }), hotkeys }));
}

/** Where the renderer draws world point (wx, wy), in CSS px of the canvas (js/renderer.js: zoom * render ratio, then back to CSS). */
function drawnAt(camera, ratio, wx, wy) {
  const zoom = camera.zoom * ratio; // render px per world px
  return { x: ((wx - camera.x) * zoom) / ratio, y: ((wy - camera.y) * zoom) / ratio };
}

test('input: the game scale sets the base zoom and the wheel limits; screen points map to the world drawn there', async () => {
  const { input } = await makeInput();
  try {
    input.centerOn(1000, 1000);
    assert.equal(input.camera.zoom, DEFAULT_ZOOM);
    for (const scale of [0.5, 2 / 3, 1, 4 / 3, 2, 3]) {
      input.setGameScale(scale);
      assert.ok(near(input.camera.zoom, baseZoom(scale)), `base zoom at ${scale}`);
      const c = input.viewCenter();
      assert.ok(near(c.x, 1000, 1e-6) && near(c.y, 1000, 1e-6), 'the view keeps its centre');
      // Wheel zoom stays within the scaled limits.
      for (let i = 0; i < 60; i++) input.onWheel({ preventDefault() {}, clientX: 500, clientY: 350, deltaY: -400 });
      assert.ok(near(input.camera.zoom, MAX_ZOOM * scale), `wheel in stops at ${MAX_ZOOM * scale}`);
      for (let i = 0; i < 60; i++) input.onWheel({ preventDefault() {}, clientX: 500, clientY: 350, deltaY: 400 });
      assert.ok(near(input.camera.zoom, MIN_ZOOM * scale), `wheel out stops at ${MIN_ZOOM * scale}`);
      input.setZoom(input.baseZoom());
      input.centerOn(1000, 1000);
      // The world point under the mouse is the one the renderer draws there, at any pixel ratio.
      for (const dpr of [1, 1.25, 2, 3]) {
        const ratio = renderPixelRatio(dpr, 3);
        for (const [cx, cy] of [[100, 50], [500, 350], [899, 649]]) {
          const local = input.local({ clientX: cx, clientY: cy });
          const w = input.toWorld(local.x, local.y);
          const back = drawnAt(input.camera, ratio, w.x, w.y);
          assert.ok(near(back.x, local.x, 1e-6) && near(back.y, local.y, 1e-6), `scale ${scale}, dpr ${dpr}, (${cx}, ${cy})`);
        }
      }
    }
  } finally {
    uninstallDom();
  }
});

test('input: wheel zoom and bookmarks keep their factor of the base zoom when the game scale changes', async () => {
  const { input, hotkeys } = await makeInput();
  try {
    input.centerOn(1500, 1200);
    input.setGameScale(1);
    input.setZoom(DEFAULT_ZOOM * 2);
    assert.equal(hotkeys.run('bookmarkSave1'), true);
    input.bookmarks.set(2, { x: 10, y: 10, zoom: DEFAULT_ZOOM / 2 });
    input.setGameScale(1.5);
    assert.ok(near(input.camera.zoom, DEFAULT_ZOOM * 2 * 1.5), 'the wheel zoom keeps its factor');
    assert.ok(near(input.bookmarks.get(1).zoom, DEFAULT_ZOOM * 2 * 1.5), 'bookmarks too');
    assert.ok(near(input.bookmarks.get(2).zoom, (DEFAULT_ZOOM / 2) * 1.5));
    // Reset zoom (the "." key) goes to the scale's base zoom.
    assert.equal(hotkeys.run('resetZoom'), true);
    assert.ok(near(input.camera.zoom, baseZoom(1.5)));
    // Zooming in by key stops at the scaled limit.
    for (let i = 0; i < 30; i++) hotkeys.run('zoomIn');
    assert.ok(near(input.camera.zoom, MAX_ZOOM * 1.5));
    // Pinch uses the scaled limits too (js/touch.js asks the input).
    assert.deepEqual(input.zoomLimits(), zoomLimits(1.5));
    // Nonsense scales are ignored.
    input.setGameScale(0);
    input.setGameScale(NaN);
    assert.equal(input.gameScale, 1.5);
  } finally {
    uninstallDom();
  }
});

test('input: the player zoom is remembered across a reload and kept through game scale changes; Reset zoom and Defaults clear it', async () => {
  const { ZOOM_SAVE_MS } = await import('../js/input.js');
  const storage = memoryStorage();
  // A page load: a registry over this browser's storage (js/registry.js), as js/settings.js makes it.
  const load = () => createSettings(createRegistry({ storage }));
  const wheel = (input, deltaY) => input.onWheel({ preventDefault() {}, clientX: 500, clientY: 350, deltaY });
  let factor;
  let { input } = await makeInput(load());
  try {
    assert.equal(input.camera.zoom, DEFAULT_ZOOM, 'nothing remembered: the base zoom');
    input.setGameScale(2 / 3); // Auto on a 14" MacBook
    input.centerOn(1000, 1000);
    for (let i = 0; i < 3; i++) wheel(input, 200);
    factor = input.camera.zoom / baseZoom(2 / 3);
    assert.ok(factor < 1, 'zoomed out');
    assert.equal(input.settings.get('zoomFactor'), 1, 'not stored on every wheel event');
    await new Promise((r) => setTimeout(r, ZOOM_SAVE_MS + 50));
    assert.ok(near(input.settings.get('zoomFactor'), factor), 'stored once the wheel stops');
    input.dispose();
  } finally {
    uninstallDom();
  }
  // Reload: the next game starts at the same factor, before and after its game scale is applied.
  let hotkeys;
  ({ input, hotkeys } = await makeInput(load()));
  try {
    assert.ok(near(input.camera.zoom, DEFAULT_ZOOM * factor), 'at game scale 1');
    input.setGameScale(2 / 3);
    assert.ok(near(input.camera.zoom, baseZoom(2 / 3) * factor), 'at the game scale of the screen');
    input.setGameScale(4 / 3);
    assert.ok(near(input.camera.zoom, baseZoom(4 / 3) * factor), 'a new game scale keeps it');
    assert.ok(near(input.settings.get('zoomFactor'), factor), 'and the factor does not change');
    // The zoom keys are remembered too (pinch: tests/touch.test.mjs).
    assert.equal(hotkeys.run('zoomIn'), true);
    assert.ok(input.zoomSave);
    input.flushZoom(); // the page goes away (pagehide)
    assert.ok(near(input.settings.get('zoomFactor'), factor * 1.25));
    // Reset zoom ("."): the base zoom, and the remembered zoom is cleared.
    assert.equal(hotkeys.run('resetZoom'), true);
    assert.ok(near(input.camera.zoom, baseZoom(4 / 3)));
    assert.equal(input.settings.get('zoomFactor'), 1);
    // Changed elsewhere (another tab, the account): the view follows; Defaults reset it: back to the base zoom.
    input.settings.set('zoomFactor', 2);
    assert.ok(near(input.camera.zoom, baseZoom(4 / 3) * 2));
    input.settings.reset('zoomFactor');
    assert.ok(near(input.camera.zoom, baseZoom(4 / 3)));
    // Out of the limits: clamped, in the setting and the view.
    assert.equal(input.settings.set('zoomFactor', 50), ZOOM_FACTOR_LIMITS.max);
    assert.ok(near(input.camera.zoom, MAX_ZOOM * (4 / 3)));
    for (let i = 0; i < 60; i++) wheel(input, 400);
    input.flushZoom();
    assert.ok(near(input.settings.get('zoomFactor'), ZOOM_FACTOR_LIMITS.min), 'the wheel stops at the limit');
    // Only zooming by the player is remembered (the stress test sets the zoom directly).
    input.camera.zoom = 1;
    input.flushZoom();
    assert.ok(near(input.settings.get('zoomFactor'), ZOOM_FACTOR_LIMITS.min));
    input.dispose();
    input.settings.set('zoomFactor', 1);
    assert.equal(input.camera.zoom, 1, 'a disposed view no longer follows');
  } finally {
    uninstallDom();
  }
});


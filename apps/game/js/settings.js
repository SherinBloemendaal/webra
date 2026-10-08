// User settings, kept in localStorage under one JSON key.
//
//   import { get, set, subscribe } from './settings.js';
//   get('edgeScrollSpeed');                      // 1
//   set('edgeScrollSpeed', 2);                   // clamped, stored, listeners called
//   const off = subscribe((key, value) => ...);  // every change
//   const off2 = subscribe('showUnitPaths', (value) => ...); // one key
//
// Storage can be missing or throw (private windows, blocked site data, Node),
// so every access is wrapped: the game then runs on defaults for the session.

const STORAGE_KEY = 'webra.settings';

/**
 * Known settings. Numbers are clamped to [min, max]; choices must be one of
 * their options; a stored value of the wrong type falls back to the default.
 */
export const SCHEMA = {
  // Multiplier on the edge scroll speed; 0 turns edge scrolling off.
  edgeScrollSpeed: { type: 'number', default: 1, min: 0, max: 3 },
  // Multiplier on the arrow key scroll speed.
  keyScrollSpeed: { type: 'number', default: 1, min: 0.25, max: 3 },
  // Draw the paths of selected units (renderer side lives in another module).
  showUnitPaths: { type: 'boolean', default: false },
  // Highest canvas pixels per CSS pixel (js/layout.js renderPixelRatio); lower is faster on phones.
  pixelRatioCap: { type: 'number', default: 2, min: 0.5, max: 3 },
  // Render below screen resolution (cheap speed-up for weak mobile GPUs).
  lowQuality: { type: 'boolean', default: false },
  // Health bars besides the selection and the hovered actor (OpenRA status bars):
  // 'off' (selected and hovered only), 'damaged' (also damaged actors), 'all'.
  healthBars: { type: 'choice', default: 'off', options: ['off', 'damaged', 'all'] },
  // Graphics (js/content): 'webra' (WebRA's own art) or 'original' (the
  // original Red Alert graphics the player installed from their own copy).
  graphics: { type: 'choice', default: 'webra', options: ['webra', 'original'] },
  // Hotkey overrides (js/hotkeys.js): { actionName: ['Ctrl+X', ...] }, [] = unbound.
  hotkeys: { type: 'object', default: {} },
};

function normalize(key, value) {
  const spec = SCHEMA[key];
  if (spec.type === 'number') {
    const n = typeof value === 'number' ? value : Number.NaN;
    return Number.isFinite(n) ? Math.min(spec.max, Math.max(spec.min, n)) : spec.default;
  }
  if (spec.type === 'boolean') return typeof value === 'boolean' ? value : spec.default;
  if (spec.type === 'choice') return spec.options.includes(value) ? value : spec.default;
  if (spec.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return structuredClone(spec.default);
    return structuredClone(value);
  }
  return spec.default;
}

function defaultStorage() {
  try {
    // Browsers only: Node exposes an experimental localStorage that warns when touched.
    return globalThis.window?.localStorage ?? null;
  } catch {
    return null;
  }
}

function report(err) {
  if (typeof globalThis.reportError === 'function') globalThis.reportError(err);
  else console.error(err);
}

/**
 * A settings store over `storage` (a Web Storage object, or null for memory only).
 * The module exports one store over localStorage; tests create their own.
 */
export function createSettings(storage = defaultStorage()) {
  const values = {};
  let stored = {};
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) stored = parsed;
  } catch {
    // Unreadable or corrupt: start from defaults.
  }
  for (const key of Object.keys(SCHEMA)) values[key] = normalize(key, stored[key]);
  const listeners = new Set();

  const check = (key) => {
    if (!Object.hasOwn(SCHEMA, key)) throw new Error(`Unknown setting "${key}"`);
  };

  const save = () => {
    try {
      // Keep keys this build does not know (written by a newer build) intact.
      storage?.setItem(STORAGE_KEY, JSON.stringify({ ...stored, ...values }));
    } catch {
      // Quota or blocked storage: the change still applies for this session.
    }
  };

  return {
    /** Current value of a setting (objects are copies). */
    get(key) {
      check(key);
      const v = values[key];
      return v && typeof v === 'object' ? structuredClone(v) : v;
    },
    /** Change a setting; returns the stored (normalized) value. */
    set(key, value) {
      check(key);
      const next = normalize(key, value);
      if (JSON.stringify(next) === JSON.stringify(values[key])) return this.get(key);
      values[key] = next;
      save();
      for (const fn of [...listeners]) {
        try {
          fn(key, this.get(key));
        } catch (err) {
          report(err);
        }
      }
      return this.get(key);
    },
    /** Put a setting back to its default. */
    reset(key) {
      check(key);
      return this.set(key, SCHEMA[key].default);
    },
    /**
     * subscribe(fn): fn(key, value) on every change.
     * subscribe(key, fn): fn(value) when that key changes.
     * Returns a function that unsubscribes.
     */
    subscribe(keyOrFn, fn) {
      let listener;
      if (typeof keyOrFn === 'function') listener = keyOrFn;
      else {
        check(keyOrFn);
        listener = (key, value) => key === keyOrFn && fn(value);
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const store = createSettings();

export const get = (key) => store.get(key);
export const set = (key, value) => store.set(key, value);
export const reset = (key) => store.reset(key);
export const subscribe = (keyOrFn, fn) => store.subscribe(keyOrFn, fn);
export const settings = store;

// Game settings, a view on the settings registry (js/registry.js) under the
// flat names the game has always used:
//
//   import { get, set, subscribe } from './settings.js';
//   get('edgeScrollSpeed');                      // 1
//   set('edgeScrollSpeed', 2);                   // clamped, stored, listeners called
//   const off = subscribe((key, value) => ...);  // every change
//   const off2 = subscribe('showUnitPaths', (value) => ...); // one key
//
// The registry keeps them in localStorage and syncs them with the player's
// account; storage can be missing or throw (private windows, blocked site
// data, Node), and the game then runs on defaults for the session.

import { createRegistry, defaultRegistry, GROUPS } from './registry.js';

/** Setting name -> [registry group, registry key]. */
export const KEYS = Object.freeze({
  edgeScrollSpeed: ['game', 'edgeScrollSpeed'],
  keyScrollSpeed: ['game', 'keyScrollSpeed'],
  showUnitPaths: ['game', 'showUnitPaths'],
  healthBars: ['game', 'healthBars'],
  // OpenRA's relationship colours (TogglePlayerStanceColor): js/main.js.
  playerStanceColors: ['game', 'playerStanceColors'],
  pixelRatioCap: ['game', 'pixelRatioCap'],
  lowQuality: ['game', 'lowQuality'],
  // Graphics (js/content): 'webra' (WebRA's own art) or 'original' (the
  // original Red Alert graphics the player installed from their own copy).
  graphics: ['game', 'graphics'],
  // Hotkey overrides (js/hotkeys.js): { actionName: ['Ctrl+X', ...] }, [] = unbound.
  hotkeys: ['game', 'hotkeys'],
});

/**
 * Known settings (type, default, min, max, options, label), from the
 * registry. Numbers are clamped to [min, max]; choices must be one of their
 * options; a value of the wrong type falls back to the default.
 */
export const SCHEMA = Object.freeze(Object.fromEntries(Object.entries(KEYS).map(([name, [group, key]]) => [name, GROUPS[group].settings[key]])));

const REVERSE = new Map(Object.entries(KEYS).map(([name, [group, key]]) => [`${group}.${key}`, name]));

/**
 * A settings store over a registry (js/registry.js createRegistry), or null
 * for one kept in memory only. The module exports one over the page's
 * registry; tests create their own.
 */
export function createSettings(source = defaultRegistry()) {
  const registry = source ?? createRegistry({ storage: null });
  const where = (name) => {
    if (!Object.hasOwn(KEYS, name)) throw new Error(`Unknown setting "${name}"`);
    return KEYS[name];
  };
  return {
    registry,
    /** Current value of a setting (objects are copies). */
    get(name) {
      const [group, key] = where(name);
      return registry.get(group, key);
    },
    /** Change a setting; returns the stored (normalized) value. */
    set(name, value) {
      const [group, key] = where(name);
      return registry.set(group, key, value);
    },
    /** Put a setting back to its default. */
    reset(name) {
      const [group, key] = where(name);
      return registry.reset(group, key);
    },
    /**
     * subscribe(fn): fn(name, value) on every change.
     * subscribe(name, fn): fn(value) when that setting changes.
     * Returns a function that unsubscribes.
     */
    subscribe(nameOrFn, fn) {
      const only = typeof nameOrFn === 'function' ? null : nameOrFn;
      if (only) where(only);
      const call = typeof nameOrFn === 'function' ? nameOrFn : (_name, value) => fn(value);
      return registry.subscribe((changes) => {
        for (const c of changes) {
          const name = REVERSE.get(`${c.group}.${c.key}`);
          if (!name || (only && name !== only)) continue;
          call(name, structuredClone(c.to));
        }
      });
    },
  };
}

const store = createSettings();

export const get = (key) => store.get(key);
export const set = (key, value) => store.set(key, value);
export const reset = (key) => store.reset(key);
export const subscribe = (keyOrFn, fn) => store.subscribe(keyOrFn, fn);
export const settings = store;

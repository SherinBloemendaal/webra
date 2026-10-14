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
  // OpenRA's target lines (js/targetlines.js): 'disabled', 'manual' or 'automatic'.
  targetLines: ['game', 'targetLines'],
  healthBars: ['game', 'healthBars'],
  // OpenRA's relationship colours (TogglePlayerStanceColor): js/main.js.
  playerStanceColors: ['game', 'playerStanceColors'],
  // OpenRA HideReplayChat (js/chatlog.js) and the text notification filters
  // (TextNotificationPoolFilters Feedback and Transients, js/notifications.js).
  hideReplayChat: ['game', 'hideReplayChat'],
  uiFeedbackNotifications: ['game', 'uiFeedbackNotifications'],
  gameEventNotifications: ['game', 'gameEventNotifications'],
  pixelRatioCap: ['game', 'pixelRatioCap'],
  lowQuality: ['game', 'lowQuality'],
  // Camera shake and flashes (js/battlefx.js): 'auto', 'on' or 'off'.
  reduceMotion: ['game', 'reduceMotion'],
  // 'auto' or a factor (js/scale.js): the size of the chrome, and of units and terrain.
  uiScale: ['game', 'uiScale'],
  gameScale: ['game', 'gameScale'],
  // The player's zoom as a factor of the game scale's base zoom (js/input.js): the next game starts there.
  zoomFactor: ['game', 'zoomFactor'],
  // Graphics (js/content): 'webra' (WebRA's own art) or 'original' (the
  // original Red Alert graphics the player installed from their own copy).
  graphics: ['game', 'graphics'],
  // Hotkey overrides (js/hotkeys.js): { actionName: ['Ctrl+X', ...] }, [] = unbound.
  hotkeys: ['game', 'hotkeys'],
  // Mouse capture (js/mouselock.js): 'off', 'fullscreen' or 'always'; the
  // pointer speed while captured; raw movement with the game's acceleration
  // instead of the system's; whether Esc also opens the menu then; how often
  // the "Mouse captured" hint was shown.
  mouseCapture: ['game', 'mouseCapture'],
  mouseCaptureSpeed: ['game', 'mouseCaptureSpeed'],
  mouseCaptureRaw: ['game', 'mouseCaptureRaw'],
  mouseCaptureEscMenu: ['game', 'mouseCaptureEscMenu'],
  // The "Mouse captured" notice: 'always', 'first' (the first few captures) or 'off'.
  mouseCaptureNotice: ['game', 'mouseCaptureNotice'],
  // Single player: whether a hidden page opens the menu (and so pauses); off, the game plays on.
  pauseWhenHidden: ['game', 'pauseWhenHidden'],
  mouseCaptureHints: ['extra', 'mouseCaptureHints'],
  // The repair mode box chooser's last choice (js/input.js): 'all', 'buildings', 'combat', 'harvesters' or 'other'.
  repairBoxChoice: ['extra', 'repairBoxChoice'],
  // "Send error reports" (js/telemetry/index.js follows it).
  errorReports: ['privacy', 'errorReports'],
  // "Save replays to my account" (js/account/replay-uploads.js follows it).
  cloudReplays: ['privacy', 'cloudReplays'],
  // The performance capture (js/perfcapture.js, the debug menu): its length
  // in seconds, and recording the first 60 s of every game.
  perfCaptureSeconds: ['debug', 'perfCaptureSeconds'],
  perfCaptureStart: ['debug', 'perfCaptureStart'],
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

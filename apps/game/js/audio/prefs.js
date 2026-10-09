// Audio settings: the "audio" group of the settings registry (js/registry.js),
// kept in this browser and synced with the player's account. Volumes are 0..1.

import { defaultRegistry, groupDefaults, normalizeValues } from '../registry.js';

/** Registry group of the audio settings. */
export const PREFS_GROUP = 'audio';

/**
 * enabled: all sound on or off; master, effects, voices (unit replies and
 * announcer), music (installed content only): volumes; speech: speak unit
 * replies and announcer lines with the browser's speech synthesis;
 * original: use installed original Red Alert sounds where available.
 */
export const DEFAULT_PREFS = Object.freeze(groupDefaults(PREFS_GROUP));

/** Keep only known keys with valid values; anything else falls back to the default. */
export function sanitizePrefs(raw) {
  return normalizeValues({ [PREFS_GROUP]: raw && typeof raw === 'object' ? raw : {} }).values[PREFS_GROUP];
}

/** Effective gain of a bus: master times the bus volume, zero when sound is off. */
export function busGain(prefs, bus) {
  if (!prefs.enabled) return 0;
  return prefs.master * (prefs[bus] ?? 1);
}

/** Observable settings: `set` merges, saves and notifies (also for changes synced from the account). */
export class Prefs {
  /** @param {ReturnType<import('../registry.js').createRegistry>} [registry] */
  constructor(registry = defaultRegistry()) {
    this.registry = registry;
    this.value = registry.group(PREFS_GROUP);
    this.listeners = new Set();
    registry.subscribe(PREFS_GROUP, (values) => {
      this.value = values;
      for (const fn of [...this.listeners]) fn(this.value);
    });
  }

  get() {
    return this.value;
  }

  set(patch) {
    this.registry.patch(PREFS_GROUP, sanitizePatch(patch));
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

/** Only the known keys of a patch (the registry normalizes their values). */
function sanitizePatch(patch) {
  return Object.fromEntries(Object.entries(patch ?? {}).filter(([k]) => Object.hasOwn(DEFAULT_PREFS, k)));
}

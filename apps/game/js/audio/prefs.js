// Audio settings, kept in this browser's localStorage (per device, never sent
// anywhere). Volumes are 0..1.

export const PREFS_KEY = 'webra.audio.v1';

export const DEFAULT_PREFS = Object.freeze({
  /** All sound on or off. */
  enabled: true,
  master: 0.8,
  effects: 0.8,
  /** Unit replies and announcer. */
  voices: 0.9,
  /** Music (installed original content only). */
  music: 0.5,
  /** Speak unit replies and announcer lines with the browser's speech synthesis. */
  speech: true,
  /** Use installed original Red Alert sounds where available. */
  original: true,
});

const VOLUMES = ['master', 'effects', 'voices', 'music'];
const FLAGS = ['enabled', 'speech', 'original'];

/** Keep only known keys with valid values; anything else falls back to the default. */
export function sanitizePrefs(raw) {
  const out = { ...DEFAULT_PREFS };
  if (!raw || typeof raw !== 'object') return out;
  for (const k of VOLUMES) {
    const v = Number(raw[k]);
    if (raw[k] !== undefined && raw[k] !== null && Number.isFinite(v)) out[k] = Math.max(0, Math.min(1, v));
  }
  for (const k of FLAGS) if (typeof raw[k] === 'boolean') out[k] = raw[k];
  return out;
}

export function loadPrefs(storage) {
  try {
    return sanitizePrefs(JSON.parse(storage?.getItem(PREFS_KEY) ?? 'null'));
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(storage, prefs) {
  try {
    storage?.setItem(PREFS_KEY, JSON.stringify(sanitizePrefs(prefs)));
    return true;
  } catch {
    return false; // private mode or blocked storage: settings last for this page only
  }
}

/** Effective gain of a bus: master times the bus volume, zero when sound is off. */
export function busGain(prefs, bus) {
  if (!prefs.enabled) return 0;
  return prefs.master * (prefs[bus] ?? 1);
}

/** Observable settings: `set` merges, saves and notifies. */
export class Prefs {
  constructor(storage = globalThis.localStorage) {
    this.storage = storage;
    this.value = loadPrefs(storage);
    this.listeners = new Set();
  }

  get() {
    return this.value;
  }

  set(patch) {
    this.value = sanitizePrefs({ ...this.value, ...patch });
    savePrefs(this.storage, this.value);
    for (const fn of this.listeners) fn(this.value);
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

// Per-viewer game settings, kept in localStorage. Every read and write is
// guarded: storage can be missing or throw (private windows, blocked site
// data), and the game then runs on the defaults for this session.
//
//   get(key)            current value (the default when never set)
//   set(key, value)     change, store and notify subscribers
//   subscribe(listener) listener(key, value) on every change; returns unsubscribe
//
// Keys:
//   showUnitPaths  draw the planned route of selected own units (boolean)

export const STORAGE_KEY = 'webra.settings';

export const DEFAULTS = Object.freeze({
  showUnitPaths: false,
});

const listeners = new Set();
let values = load();

function storage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Stored values over the defaults; unknown keys and wrong types are dropped. */
function parse(raw) {
  const out = { ...DEFAULTS };
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }
  if (data && typeof data === 'object') {
    for (const key of Object.keys(DEFAULTS)) {
      if (typeof data[key] === typeof DEFAULTS[key]) out[key] = data[key];
    }
  }
  return out;
}

function load() {
  try {
    return parse(storage()?.getItem(STORAGE_KEY));
  } catch {
    return { ...DEFAULTS };
  }
}

function save() {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(values));
  } catch {
    // Storage full or blocked: the setting still holds for this session.
  }
}

function check(key) {
  if (!Object.hasOwn(DEFAULTS, key)) throw new Error(`unknown setting ${key}`);
}

export function get(key) {
  check(key);
  return values[key];
}

export function set(key, value) {
  check(key);
  if (typeof value !== typeof DEFAULTS[key]) throw new TypeError(`setting ${key} must be a ${typeof DEFAULTS[key]}`);
  if (values[key] === value) return;
  values = { ...values, [key]: value };
  save();
  notify(key, value);
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(key, value) {
  for (const listener of [...listeners]) {
    try {
      listener(key, value);
    } catch (err) {
      console.error(err);
    }
  }
}

/** Re-read storage (another tab changed it, or tests swapped the storage). */
export function reload() {
  const old = values;
  values = load();
  for (const key of Object.keys(DEFAULTS)) {
    if (old[key] !== values[key]) notify(key, values[key]);
  }
}

// Changes made in another tab of the same viewer apply here too.
try {
  globalThis.addEventListener?.('storage', (e) => {
    if (e.key === STORAGE_KEY || e.key === null) reload();
  });
} catch {
  // No window (tests, workers).
}

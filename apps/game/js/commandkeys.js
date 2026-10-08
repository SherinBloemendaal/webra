// Stand-in for the central hotkey registry (apps/game/js/hotkeys.js, being
// built on another branch): the same `registerAction(name, defaultKeys,
// handler, options)` signature, so the command bar can switch to the real
// registry by importing `registerAction` from './hotkeys.js' instead and this
// file can go. Until then it binds the default keys only (no rebinding).
//
// Combos are strings like "G", "X", "Ctrl+X", "Alt+1": modifiers in the order
// Ctrl, Alt, Shift, then the key. Cmd (macOS) counts as Ctrl.

const IGNORED_TARGETS = new Set(['INPUT', 'SELECT', 'TEXTAREA']);

/** Canonical combo ("shift+g" becomes "Shift+G"), or null. */
export function normalizeCombo(combo) {
  if (typeof combo !== 'string' || !combo) return null;
  const parts = combo.split('+').map((p) => p.trim());
  let key = parts.pop();
  if (!key) return null;
  const mods = new Set();
  for (const p of parts) {
    const l = p.toLowerCase();
    if (l === 'ctrl' || l === 'control' || l === 'cmd' || l === 'meta') mods.add('Ctrl');
    else if (l === 'alt' || l === 'option') mods.add('Alt');
    else if (l === 'shift') mods.add('Shift');
    else return null;
  }
  if (key.length === 1) key = key.toUpperCase();
  return [...['Ctrl', 'Alt', 'Shift'].filter((m) => mods.has(m)), key].join('+');
}

/** Combo of a keydown event (letters and digits by physical key), or null. */
export function comboFromEvent(e) {
  const code = e.code ?? '';
  let key = null;
  let m = /^Key([A-Z])$/.exec(code);
  if (m) key = typeof e.key === 'string' && /^[a-z]$/i.test(e.key) ? e.key.toUpperCase() : m[1];
  else if ((m = /^Digit([0-9])$/.exec(code))) key = m[1];
  else if (typeof e.key === 'string' && e.key.length === 1 && e.key !== ' ') key = e.key.toUpperCase();
  if (!key) return null;
  const mods = [];
  if (e.ctrlKey || e.metaKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  return [...mods, key].join('+');
}

export class LocalKeys {
  constructor() {
    this.actions = new Map(); // name -> { keys, handler }
    this.listening = false;
  }

  registerAction(name, defaultKeys, handler, options = {}) {
    if (this.actions.has(name)) throw new Error(`Hotkey action "${name}" is already registered`);
    const keys = (Array.isArray(defaultKeys) ? defaultKeys : [defaultKeys]).map(normalizeCombo).filter(Boolean);
    const action = { keys, handler, label: options.label ?? name };
    this.actions.set(name, action);
    if (!this.listening && typeof window !== 'undefined') {
      this.listening = true;
      window.addEventListener('keydown', (e) => this.handle(e));
    }
    return () => {
      if (this.actions.get(name) === action) this.actions.delete(name);
    };
  }

  /** Primary key of an action, for tooltips. */
  keyOf(name) {
    return this.actions.get(name)?.keys[0] ?? null;
  }

  /** Run the action bound to a keydown event; true when one ran. */
  handle(e) {
    if (IGNORED_TARGETS.has(e.target?.tagName)) return false;
    const combo = comboFromEvent(e);
    if (!combo) return false;
    for (const a of this.actions.values()) {
      if (!a.keys.includes(combo)) continue;
      e.preventDefault?.();
      if (!e.repeat) a.handler(e);
      return true;
    }
    return false;
  }
}

export const localKeys = new LocalKeys();

/** Same signature as hotkeys.js `registerAction`. */
export const registerAction = (name, defaultKeys, handler, options) => localKeys.registerAction(name, defaultKeys, handler, options);

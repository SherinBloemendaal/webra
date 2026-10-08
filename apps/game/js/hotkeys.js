// Central hotkey registry. Actions register a name, default keys and a
// handler; the user can rebind them in the game menu (js/gamemenu.js) and the
// overrides persist in settings.js under `hotkeys`.
//
//   import { registerAction } from './hotkeys.js';
//   const off = registerAction('guard', 'D', () => ..., { label: 'Guard', group: 'Orders' });
//
// Defaults follow OpenRA's Red Alert hotkey set (mods/common/hotkeys/*.yaml
// and mods/ra/hotkeys.yaml) where WebRA has the feature; README.md, Controls,
// lists them.
//
// Combos are strings: modifiers in the order Ctrl, Alt, Shift, then the key,
// joined by "+": "A", "Ctrl+X", "Alt+Enter", "Shift+F1", "Space", "[".
// Cmd (macOS) counts as Ctrl, so one binding works on every platform.
//
// Conflicts: user overrides win over defaults; between defaults the first key
// of an action (its primary key) wins over the extra keys of others (kept from
// older WebRA versions), then the action registered first wins.

import { settings as defaultSettings } from './settings.js';

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'OS', 'Hyper', 'Super', 'Fn']);

const CODE_KEYS = {
  Space: 'Space',
  BracketLeft: '[',
  BracketRight: ']',
  Period: '.',
  Comma: ',',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  Minus: '-',
  Equal: '=',
  Backquote: '`',
  Backslash: '\\',
};

/** Keys the game handles itself (cancel/menu, control groups, sidebar numpad, scrolling, chat). */
export function isReservedCombo(combo) {
  const { key, mods } = splitCombo(combo);
  if (key === 'Escape') return 'Esc always cancels and opens the menu.';
  if (/^[0-9]$/.test(key) && !mods.has('Alt')) return 'Number keys are control groups.';
  if (key.startsWith('Numpad')) return 'The numpad drives the sidebar.';
  if (/^Arrow/.test(key) && mods.size === 0) return 'Arrow keys scroll the map.';
  if (key === 'Enter' && mods.size === 0) return 'Enter opens chat in online games.';
  // Shortcuts browsers keep for themselves: pages cannot take them.
  if (mods.has('Ctrl') && ['W', 'T', 'N', 'Q', 'Tab'].includes(key)) return 'The browser keeps this shortcut.';
  if (key === 'F11' || key === 'F5' || key === 'F12') return 'The browser keeps this key.';
  return null;
}

function splitCombo(combo) {
  const parts = combo.split('+');
  // "Ctrl++" is not produced; "+" never appears as a key name (Equal is "=").
  const key = parts.pop();
  return { key, mods: new Set(parts) };
}

/** Key name for an event, or null for modifier-only presses. */
export function keyName(e) {
  if (MODIFIER_KEYS.has(e.key)) return null;
  const code = e.code ?? '';
  let m = /^Key([A-Z])$/.exec(code);
  if (m) {
    // Prefer the letter printed on the key (AZERTY, Dvorak), unless a
    // modifier turned it into another character (Option on macOS).
    return typeof e.key === 'string' && /^[a-z]$/i.test(e.key) ? e.key.toUpperCase() : m[1];
  }
  m = /^Digit([0-9])$/.exec(code);
  if (m) return m[1];
  if (code.startsWith('Numpad')) return code;
  if (CODE_KEYS[code]) return CODE_KEYS[code];
  if (e.key === ' ') return 'Space';
  if (typeof e.key === 'string' && e.key.length === 1) return e.key.toUpperCase();
  return e.key || null;
}

/** Combo string for a keyboard event, or null for modifier-only presses. */
export function comboFromEvent(e) {
  const key = keyName(e);
  if (!key) return null;
  const mods = [];
  if (e.ctrlKey || e.metaKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  return [...mods, key].join('+');
}

/** Normalize a combo written by hand ("shift+f1", "ctrl+x") to the canonical form. */
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
  if (key.length === 1) key = key === ' ' ? 'Space' : key.toUpperCase();
  else if (/^f([1-9]|1[0-2])$/i.test(key)) key = key.toUpperCase();
  return [...['Ctrl', 'Alt', 'Shift'].filter((m) => mods.has(m)), key].join('+');
}

export function isMac() {
  const nav = globalThis.navigator;
  const platform = nav?.userAgentData?.platform ?? nav?.platform ?? '';
  return /mac|iphone|ipad/i.test(platform);
}

/** Human readable combo: "Ctrl+X" (or "Cmd+X" on macOS), "Alt+Enter". */
export function formatCombo(combo, mac = isMac()) {
  const { key, mods } = splitCombo(combo);
  const out = [];
  if (mods.has('Ctrl')) out.push(mac ? 'Cmd' : 'Ctrl');
  if (mods.has('Alt')) out.push(mac ? 'Option' : 'Alt');
  if (mods.has('Shift')) out.push('Shift');
  const names = { Escape: 'Esc', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', ' ': 'Space' };
  out.push(names[key] ?? key);
  return out.join('+');
}

const INTERACTIVE = new Set(['INPUT', 'SELECT', 'TEXTAREA']);
const CONTROL = new Set(['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'A']);

export class HotkeyRegistry {
  /** @param {{ get(key: string): any, set(key: string, value: any): any, subscribe(key: string, fn: Function): Function }} settings */
  constructor(settings = defaultSettings) {
    this.settings = settings;
    this.actions = new Map(); // name -> { name, defaults, handler, label, group, repeat, inControls, order }
    this.order = 0;
    this.lookup = null; // combo -> action name
    this.listeners = new Set();
    settings.subscribe('hotkeys', () => this.changed());
  }

  /**
   * Register an action. `defaultKeys` is a combo or a list of combos (the first
   * is the primary key). Options: label, group (for the menu), repeat (run on
   * held-key repeats), inControls (also when a button has focus; default true).
   * Returns a function that unregisters the action.
   */
  registerAction(name, defaultKeys, handler, options = {}) {
    if (typeof name !== 'string' || !name) throw new Error('registerAction needs a name');
    if (typeof handler !== 'function') throw new Error(`registerAction("${name}") needs a handler`);
    if (this.actions.has(name)) throw new Error(`Hotkey action "${name}" is already registered`);
    const list = (Array.isArray(defaultKeys) ? defaultKeys : [defaultKeys]).filter(Boolean).map((k) => {
      const c = normalizeCombo(k);
      if (!c) throw new Error(`registerAction("${name}"): bad key "${k}"`);
      return c;
    });
    const action = {
      name,
      defaults: list,
      handler,
      label: options.label ?? name,
      group: options.group ?? 'Other',
      repeat: !!options.repeat,
      inControls: options.inControls !== false,
      order: this.order++,
    };
    this.actions.set(name, action);
    this.changed();
    return () => {
      if (this.actions.get(name) === action) {
        this.actions.delete(name);
        this.changed();
      }
    };
  }

  overrides() {
    const o = this.settings.get('hotkeys');
    return o && typeof o === 'object' ? o : {};
  }

  changed() {
    this.lookup = null;
    for (const fn of [...this.listeners]) fn();
  }

  /** Called whenever bindings change (registration or rebinding). */
  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  buildLookup() {
    const map = new Map();
    const overrides = this.overrides();
    const actions = [...this.actions.values()].sort((a, b) => a.order - b.order);
    const claim = (combo, name) => {
      if (combo && !map.has(combo)) map.set(combo, name);
    };
    // 1. User bindings.
    for (const a of actions) {
      const o = overrides[a.name];
      if (Array.isArray(o)) for (const c of o) claim(normalizeCombo(c), a.name);
    }
    const userBound = (a) => Array.isArray(overrides[a.name]);
    // 2. Primary default keys, 3. extra default keys.
    for (const a of actions) if (!userBound(a)) claim(a.defaults[0], a.name);
    for (const a of actions) if (!userBound(a)) a.defaults.slice(1).forEach((c) => claim(c, a.name));
    this.lookup = map;
    return map;
  }

  /** Action name bound to a combo, or null. */
  actionFor(combo) {
    return (this.lookup ?? this.buildLookup()).get(combo) ?? null;
  }

  /** Combos that currently trigger an action (after conflicts are resolved). */
  bindingsFor(name) {
    const map = this.lookup ?? this.buildLookup();
    const out = [];
    for (const [combo, n] of map) if (n === name) out.push(combo);
    const a = this.actions.get(name);
    const o = this.overrides()[name];
    const preferred = Array.isArray(o) ? o.map(normalizeCombo) : a?.defaults ?? [];
    return out.sort((x, y) => preferred.indexOf(x) - preferred.indexOf(y));
  }

  /**
   * Bind `combo` as the only key of `name`. An action that held the combo
   * loses it. Returns { ok: true, displaced: name | null } or { ok: false, reason }.
   */
  rebind(name, combo) {
    if (!this.actions.has(name)) return { ok: false, reason: `Unknown action "${name}".` };
    const c = normalizeCombo(combo);
    if (!c) return { ok: false, reason: 'That is not a key.' };
    const reserved = isReservedCombo(c);
    if (reserved) return { ok: false, reason: reserved };
    const previous = this.actionFor(c);
    const overrides = this.overrides();
    let displaced = null;
    if (previous && previous !== name) {
      displaced = previous;
      const keep = this.bindingsFor(previous).filter((k) => k !== c);
      overrides[previous] = keep;
    }
    overrides[name] = [c];
    this.settings.set('hotkeys', overrides);
    return { ok: true, displaced };
  }

  /** Remove every key from an action. */
  unbind(name) {
    const overrides = this.overrides();
    overrides[name] = [];
    this.settings.set('hotkeys', overrides);
  }

  /** Back to the default keys for one action (null: all actions). */
  reset(name = null) {
    if (name === null) {
      this.settings.set('hotkeys', {});
      return;
    }
    const overrides = this.overrides();
    delete overrides[name];
    this.settings.set('hotkeys', overrides);
  }

  /** Registered actions for the menu, in registration order. */
  list() {
    return [...this.actions.values()]
      .sort((a, b) => a.order - b.order)
      .map((a) => ({ name: a.name, label: a.label, group: a.group, defaults: a.defaults.slice(), keys: this.bindingsFor(a.name) }));
  }

  /**
   * Run an action by name, as its hotkey would (on-screen buttons such as the
   * touch action bar use this). Returns false when no such action exists.
   */
  run(name) {
    const a = this.actions.get(name);
    if (!a) return false;
    a.handler(null);
    return true;
  }

  /**
   * Run the action bound to a keydown event. Returns true when it was handled
   * (the event's default is prevented then, so Ctrl+key browser shortcuts are
   * held back where the browser allows it).
   */
  handle(e) {
    const tag = e.target?.tagName;
    if (INTERACTIVE.has(tag)) return false;
    const combo = comboFromEvent(e);
    if (!combo) return false;
    const name = this.actionFor(combo);
    if (!name) return false;
    const a = this.actions.get(name);
    if (!a.inControls && CONTROL.has(tag)) return false;
    e.preventDefault?.();
    if (e.repeat && !a.repeat) return true;
    a.handler(e);
    return true;
  }
}

export const hotkeys = new HotkeyRegistry();

/** Register an action on the game's registry. See HotkeyRegistry.registerAction. */
export const registerAction = (name, defaultKeys, handler, options) => hotkeys.registerAction(name, defaultKeys, handler, options);

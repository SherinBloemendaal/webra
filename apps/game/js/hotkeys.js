// Central hotkey registry. Actions register a name, default keys and a
// handler; the user can rebind them in the game menu (js/gamemenu.js) and the
// overrides persist in settings.js under `hotkeys`.
//
//   import { registerAction } from './hotkeys.js';
//   const off = registerAction('guard', openraDefaults('Guard'), () => ..., { openra: 'Guard' });
//
// Defaults are OpenRA's Red Alert hotkeys (js/openra-hotkeys.js, generated
// from OpenRA's mods/common/hotkeys/*.yaml and mods/ra/hotkeys.yaml), except
// where the browser keeps OpenRA's key for itself (BROWSER_SUBSTITUTES).
// Actions name their OpenRA hotkey (`openra`), which gives them OpenRA's
// description, contexts and section of the hotkey settings; README.md
// (Controls) lists them all.
//
// Combos are strings: modifiers in the order Ctrl, Alt, Shift, then the key,
// joined by "+": "A", "Ctrl+X", "Alt+Enter", "Shift+F1", "Space", "[",
// "NumpadEnter", "MediaPlayPause". Cmd (macOS) counts as Ctrl, so one binding
// works on every platform (OpenRA's macOS "Meta" control group keys too).
//
// Conflicts: user overrides win over defaults; between defaults the first key
// of an action (its primary key) wins over the extra keys of others, then the
// action registered first wins. Actions of different contexts (OpenRA's
// player and spectator hotkeys share F-keys) are never registered at the same
// time: the game registers what its mode uses.

import { settings as defaultSettings } from './settings.js';
import { HOTKEY_GROUPS, OPENRA_HOTKEYS } from './openra-hotkeys.js';

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

/**
 * OpenRA hotkeys whose default key the browser keeps for itself, and what
 * WebRA uses instead (null: no default key; the player can bind one in the
 * Controls page). docs and README.md list them.
 */
export const BROWSER_SUBSTITUTES = Object.freeze({
  CycleProductionBuildings: { key: 'Shift+Tab', why: 'Ctrl+Tab switches browser tabs' },
  MapBookmarkSave01: { key: 'Alt+Shift+Q', why: 'Ctrl+Q quits the browser' },
  MapBookmarkSave02: { key: 'Alt+Shift+W', why: 'Ctrl+W closes the tab' },
  Production11: { key: null, why: 'F11 is the browser full screen key' },
  Production12: { key: null, why: 'F12 opens the browser developer tools' },
  ReplaySpeedFast: { key: null, why: 'F11 is the browser full screen key' },
  ReplaySpeedMax: { key: null, why: 'F12 opens the browser developer tools' },
});

/** WebRA's default keys for an OpenRA hotkey: OpenRA's key, or its browser substitute. */
export function openraDefaults(name) {
  const h = OPENRA_HOTKEYS[name];
  if (!h) throw new Error(`Unknown OpenRA hotkey "${name}"`);
  const key = Object.hasOwn(BROWSER_SUBSTITUTES, name) ? BROWSER_SUBSTITUTES[name].key : h.key;
  return key ? [key] : [];
}

/** Section of the hotkey settings for OpenRA hotkey types (OpenRA's HotkeyGroups). */
export function groupOfTypes(types) {
  return HOTKEY_GROUPS.find((g) => g.types.some((t) => types.includes(t)))?.label ?? 'Other';
}

/** Section names in the order OpenRA's hotkey settings show them. */
export const GROUP_ORDER = Object.freeze(HOTKEY_GROUPS.map((g) => g.label));

/** Keys the game handles itself (cancel/menu) and shortcuts browsers keep. */
export function isReservedCombo(combo) {
  const { key, mods } = splitCombo(combo);
  if (key === 'Escape') return 'Esc always cancels and opens the menu.';
  // Shortcuts browsers keep for themselves: pages cannot take them.
  if (mods.has('Ctrl') && ['W', 'T', 'N', 'Q', 'Tab'].includes(key)) return 'The browser keeps this shortcut.';
  if ((key === 'F11' || key === 'F12') && mods.size === 0) return 'The browser keeps this key.';
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

/** The combo without the modifiers in `drop` ('Shift', 'Ctrl'). */
function withoutModifiers(combo, drop) {
  const { key, mods } = splitCombo(combo);
  return [...['Ctrl', 'Alt', 'Shift'].filter((m) => mods.has(m) && !drop.includes(m)), key].join('+');
}

export function isMac() {
  const nav = globalThis.navigator;
  const platform = nav?.userAgentData?.platform ?? nav?.platform ?? '';
  return /mac|iphone|ipad/i.test(platform);
}

const KEY_NAMES = {
  Escape: 'Esc',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ' ': 'Space',
  NumpadEnter: 'Keypad Enter',
  NumpadAdd: 'Numpad +',
  NumpadSubtract: 'Numpad -',
  NumpadDecimal: 'Numpad .',
  MediaPlayPause: 'Media Play/Pause',
  MediaStop: 'Media Stop',
  MediaTrackPrevious: 'Media Previous',
  MediaTrackNext: 'Media Next',
};

/** Human readable combo: "Ctrl+X" (or "Cmd+X" on macOS), "Alt+Enter". */
export function formatCombo(combo, mac = isMac()) {
  const { key, mods } = splitCombo(combo);
  const out = [];
  if (mods.has('Ctrl')) out.push(mac ? 'Cmd' : 'Ctrl');
  if (mods.has('Alt')) out.push(mac ? 'Option' : 'Alt');
  if (mods.has('Shift')) out.push('Shift');
  const numpad = /^Numpad([0-9])$/.exec(key);
  out.push(KEY_NAMES[key] ?? (numpad ? `Numpad ${numpad[1]}` : key));
  return out.join('+');
}

// ---- Bindings saved by older WebRA versions ------------------------------------------

/** Keymap entry that marks overrides as written by this version of the defaults. */
export const KEYMAP_VERSION_KEY = 'webra:keymap';
export const KEYMAP_VERSION = '2';

/**
 * Default keys of WebRA 0.7 and earlier, before the defaults followed
 * OpenRA everywhere: what saved overrides of that time are compared against.
 */
export const LEGACY_DEFAULTS = Object.freeze({
  attackMove: ['A'],
  stop: ['S'],
  deploy: ['F', 'D'],
  sell: ['Z'],
  selectAll: ['Q'],
  selectByType: ['W'],
  base: ['H', 'Space'],
  toSelection: ['Home'],
  zoomIn: [']'],
  zoomOut: ['['],
  resetZoom: ['.'],
  jumpTop: ['Alt+ArrowUp'],
  jumpBottom: ['Alt+ArrowDown'],
  jumpLeft: ['Alt+ArrowLeft'],
  jumpRight: ['Alt+ArrowRight'],
  bookmarkSave1: ['Shift+F1'],
  bookmarkSave2: ['Shift+F2'],
  bookmarkSave3: ['Shift+F3'],
  bookmarkSave4: ['Shift+F4'],
  bookmarkJump1: ['F1'],
  bookmarkJump2: ['F2'],
  bookmarkJump3: ['F3'],
  bookmarkJump4: ['F4'],
  debugMenu: ['`'],
  menu: ['F10'],
  pause: ['Pause', 'P'],
  showUnitPaths: ['L'],
  fullscreen: ['Alt+Enter'],
  productionTabBuildings: ['E'],
  productionTabDefense: ['R'],
  productionTabInfantry: ['T'],
  productionTabVehicles: ['Y'],
  productionTabAircraft: ['U'],
  productionTabNaval: ['I'],
  nextTab: ['Tab'],
  previousTab: ['Shift+Tab'],
  guard: ['D', 'G'],
  scatter: ['X'],
  stanceCycle: ['C'],
  stanceAttackAnything: [],
  stanceDefend: [],
  stanceReturnFire: [],
  stanceHoldFire: [],
});

/**
 * Overrides saved before KEYMAP_VERSION, brought to today's defaults: an
 * override that equals the old defaults was never a choice (it is dropped, so
 * today's default applies), and neither was one that only lost old default
 * keys to keys the player bound to other actions (a side effect of
 * rebinding). Every other override is the player's choice and stays.
 * Overrides of the current version come back unchanged.
 */
export function migrateOverrides(raw) {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  if (Array.isArray(o[KEYMAP_VERSION_KEY]) && o[KEYMAP_VERSION_KEY][0] === KEYMAP_VERSION) return { ...o };
  const norm = (list) => (Array.isArray(list) ? list.map(normalizeCombo).filter(Boolean) : []);
  const userBound = new Map(); // combo -> action, among overrides that are real choices
  const chosen = (name) => {
    const old = LEGACY_DEFAULTS[name];
    if (!old) return true;
    const keys = norm(o[name]);
    return keys.some((k) => !old.includes(k));
  };
  for (const [name, keys] of Object.entries(o)) {
    if (name === KEYMAP_VERSION_KEY || !chosen(name)) continue;
    for (const k of norm(keys)) userBound.set(k, name);
  }
  const out = {};
  for (const [name, keys] of Object.entries(o)) {
    if (name === KEYMAP_VERSION_KEY || !Array.isArray(keys)) continue;
    const old = LEGACY_DEFAULTS[name];
    if (old && !chosen(name)) {
      const kept = norm(keys);
      const lost = old.filter((k) => !kept.includes(k));
      // Equal to the old defaults, or what rebinding other actions left over.
      if (lost.every((k) => userBound.has(k) && userBound.get(k) !== name)) continue;
    }
    out[name] = keys.slice();
  }
  return out;
}

const INTERACTIVE = new Set(['INPUT', 'SELECT', 'TEXTAREA']);
const CONTROL = new Set(['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'A']);

export class HotkeyRegistry {
  /** @param {{ get(key: string): any, set(key: string, value: any): any, subscribe(key: string, fn: Function): Function }} settings */
  constructor(settings = defaultSettings) {
    this.settings = settings;
    this.actions = new Map(); // name -> action record (registerAction)
    this.order = 0;
    this.lookup = null; // combo -> action name
    this.listeners = new Set();
    /** Held keys of `hold` actions: key name -> action name. */
    this.held = new Map();
    settings.subscribe('hotkeys', () => this.changed());
  }

  /**
   * Register an action. `defaultKeys` is a combo or a list of combos (the first
   * is the primary key); undefined takes the OpenRA hotkey's defaults
   * (`openraDefaults`). Options:
   * - openra: the OpenRA hotkey this action is (description, section, contexts)
   * - label, group: shown in the Controls page (default: from `openra`)
   * - context: 'player', 'spectator', 'menu' or 'chat-input' (default: from `openra`)
   * - repeat: also run on held-key repeats
   * - inControls: also when a button has focus (default true)
   * - modifiers: modifiers that may be added to the bound key and are handed
   *   to the handler through the event (production slots: Shift builds 5)
   * - hold: the action is held while its key is down (`isHeld`)
   * - readonly: shown, but its key cannot be changed (OpenRA Readonly)
   * - listOnly: shown in the Controls page only; a text field handles its key
   *   itself (the chat line's Tab and Shift+Tab), so it takes no key here
   * Returns a function that unregisters the action.
   */
  registerAction(name, defaultKeys, handler, options = {}) {
    if (typeof name !== 'string' || !name) throw new Error('registerAction needs a name');
    if (typeof handler !== 'function') throw new Error(`registerAction("${name}") needs a handler`);
    if (this.actions.has(name)) throw new Error(`Hotkey action "${name}" is already registered`);
    const ora = options.openra ? OPENRA_HOTKEYS[options.openra] : null;
    if (options.openra && !ora) throw new Error(`registerAction("${name}"): unknown OpenRA hotkey "${options.openra}"`);
    const keys = defaultKeys === undefined && options.openra ? openraDefaults(options.openra) : defaultKeys;
    const list = (Array.isArray(keys) ? keys : [keys]).filter(Boolean).map((k) => {
      const c = normalizeCombo(k);
      if (!c) throw new Error(`registerAction("${name}"): bad key "${k}"`);
      return c;
    });
    const action = {
      name,
      defaults: list,
      handler,
      label: options.label ?? ora?.description ?? name,
      group: options.group ?? (ora ? groupOfTypes(ora.types) : 'Other'),
      context: options.context ?? ora?.contexts[0] ?? 'player',
      openra: options.openra ?? null,
      repeat: !!options.repeat,
      inControls: options.inControls !== false,
      modifiers: options.modifiers ?? [],
      hold: !!options.hold,
      readonly: !!(options.readonly ?? ora?.readonly) || !!options.listOnly,
      listOnly: !!options.listOnly,
      order: this.order++,
    };
    this.actions.set(name, action);
    this.changed();
    return () => {
      if (this.actions.get(name) === action) {
        this.actions.delete(name);
        for (const [k, n] of this.held) if (n === name) this.held.delete(k);
        this.changed();
      }
    };
  }

  /** The saved overrides, brought to the current version (migrateOverrides). */
  overrides() {
    const o = migrateOverrides(this.settings.get('hotkeys'));
    delete o[KEYMAP_VERSION_KEY];
    return o;
  }

  /** Save overrides, marked with the current version. */
  save(overrides) {
    this.settings.set('hotkeys', { ...overrides, [KEYMAP_VERSION_KEY]: [KEYMAP_VERSION] });
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
    const actions = [...this.actions.values()].filter((a) => !a.listOnly).sort((a, b) => a.order - b.order);
    const claim = (combo, name) => {
      if (combo && !map.has(combo)) map.set(combo, name);
    };
    const userBound = (a) => !a.readonly && Array.isArray(overrides[a.name]);
    // 1. User bindings.
    for (const a of actions) if (userBound(a)) for (const c of overrides[a.name]) claim(normalizeCombo(c), a.name);
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

  /**
   * The action a pressed combo runs: the exact binding, or an action whose
   * key it is plus modifiers that action takes (`modifiers`), or null.
   */
  resolve(combo) {
    const exact = this.actionFor(combo);
    if (exact) return exact;
    const { mods } = splitCombo(combo);
    const extra = ['Shift', 'Ctrl'].filter((m) => mods.has(m));
    // Every non-empty subset of the extra modifiers, the smallest first.
    const subsets = [];
    for (let bits = 1; bits < 1 << extra.length; bits++) subsets.push(extra.filter((_, i) => bits & (1 << i)));
    subsets.sort((a, b) => a.length - b.length);
    for (const drop of subsets) {
      const name = this.actionFor(withoutModifiers(combo, drop));
      if (name && drop.every((m) => this.actions.get(name).modifiers.includes(m))) return name;
    }
    return null;
  }

  /** Combos that currently trigger an action (after conflicts are resolved). */
  bindingsFor(name) {
    if (this.actions.get(name)?.listOnly) return this.actions.get(name).defaults.slice();
    const map = this.lookup ?? this.buildLookup();
    const out = [];
    for (const [combo, n] of map) if (n === name) out.push(combo);
    const a = this.actions.get(name);
    const o = this.overrides()[name];
    const preferred = Array.isArray(o) && !a?.readonly ? o.map(normalizeCombo) : a?.defaults ?? [];
    return out.sort((x, y) => preferred.indexOf(x) - preferred.indexOf(y));
  }

  /**
   * Bind `combo` as the only key of `name`. An action that held the combo
   * loses it. Returns { ok: true, displaced: name | null } or { ok: false, reason }.
   */
  rebind(name, combo) {
    const action = this.actions.get(name);
    if (!action) return { ok: false, reason: `Unknown action "${name}".` };
    if (action.readonly) return { ok: false, reason: 'This key cannot be changed.' };
    const c = normalizeCombo(combo);
    if (!c) return { ok: false, reason: 'That is not a key.' };
    const reserved = isReservedCombo(c);
    if (reserved) return { ok: false, reason: reserved };
    const previous = this.actionFor(c);
    if (previous && this.actions.get(previous)?.readonly) return { ok: false, reason: `"${this.actions.get(previous).label}" keeps this key.` };
    const overrides = this.overrides();
    let displaced = null;
    if (previous && previous !== name) {
      displaced = previous;
      const keep = this.bindingsFor(previous).filter((k) => k !== c);
      overrides[previous] = keep;
    }
    overrides[name] = [c];
    this.save(overrides);
    return { ok: true, displaced };
  }

  /** Remove every key from an action. */
  unbind(name) {
    if (this.actions.get(name)?.readonly) return;
    const overrides = this.overrides();
    overrides[name] = [];
    this.save(overrides);
  }

  /** Back to the default keys for one action (null: all actions). */
  reset(name = null) {
    if (name === null) {
      this.save({});
      return;
    }
    const overrides = this.overrides();
    delete overrides[name];
    this.save(overrides);
  }

  /** Registered actions for the menu, in registration order. */
  list() {
    return [...this.actions.values()]
      .sort((a, b) => a.order - b.order)
      .map((a) => ({
        name: a.name,
        label: a.label,
        group: a.group,
        context: a.context,
        openra: a.openra,
        readonly: a.readonly,
        defaults: a.defaults.slice(),
        keys: this.bindingsFor(a.name),
      }));
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

  /** Whether a `hold` action's key is down. */
  isHeld(name) {
    for (const n of this.held.values()) if (n === name) return true;
    return false;
  }

  /** A key went up: release the hold action it held. */
  release(e) {
    const key = keyName(e);
    if (key) this.held.delete(key);
  }

  /** Window lost focus or the game paused input: nothing is held any more. */
  releaseAll() {
    this.held.clear();
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
    const name = this.resolve(combo);
    if (!name) return false;
    const a = this.actions.get(name);
    if (!a.inControls && CONTROL.has(tag)) return false;
    e.preventDefault?.();
    if (a.hold) {
      this.held.set(keyName(e), name);
      return true;
    }
    if (e.repeat && !a.repeat) return true;
    a.handler(e);
    return true;
  }
}

export const hotkeys = new HotkeyRegistry();

/** Register an action on the game's registry. See HotkeyRegistry.registerAction. */
export const registerAction = (name, defaultKeys, handler, options) => hotkeys.registerAction(name, defaultKeys, handler, options);

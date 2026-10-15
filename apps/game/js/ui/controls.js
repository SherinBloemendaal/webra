// Themed form controls (css/controls.css), the shared parts of every screen
// of the game and the website (which loads this module from /lib/js/ui/):
//
//   toggle({ label, hint?, checked?, onChange? })          on/off row with a switch
//   switchInput({ checked?, label?, small?, onChange? })     the switch alone
//   checkbox({ label, hint?, checked?, onChange? })        tick row
//   checkInput({ checked?, label?, onChange? })              the checkbox alone
//   segmented({ label, options, value, block?, onChange? }) 2 to 5 choices, lamp on the chosen one
//   slider({ label, min, max, step?, value, format?, onInput? }) / styleSlider(input)
//   selectPlate({ label | labelledBy, options, value, onChange?, sheet? })  the select
//   selectRow({ label, hint?, ...selectPlate options })    label + select row
//   stepper({ label | labelledBy, values, value, format?, onChange? })  discrete - value +
//   tabs({ label, tabs, value, onChange? })                 tab strip with lamps
//   badge(kind, text, { led?, title? })                     READY, HOST, MODDED, LOCKED...
//   led(state, label?)                                      a lamp: off, on, ok, warn, bad, info
//
// Each returns its element(s) and get/set helpers; callbacks fire on user
// changes only, never on set(). docs/contracts.md ("UI controls") lists the
// whole API with the CSS classes the screens may style.
//
// The switch, checkbox, segmented choice and slider are real form inputs (a
// checkbox with role "switch", radios, a checkbox, a range), so the browser
// gives keyboard use (Space toggles, the arrow keys move through a radio
// group and a slider) and screen readers announce the right role and state.
// The select is a button with an ARIA listbox (the WAI-ARIA "collapsible
// listbox" pattern): arrow keys, Home/End, Page Up/Down, typeahead, Enter or
// Space to choose, Esc to close, focus back on the button; its list opens in
// the top layer (the Popover API, so dialogs and scrolling cards never clip
// it) and on phones (the portrait and landscape layouts of js/layout.js) as
// a sheet at the bottom of the screen. The stepper is an ARIA spinbutton
// between its minus and plus buttons; the tabs are an ARIA tablist with
// roving focus.
//
// The DOM is built with createElement and textContent only: no HTML
// strings, no style attributes (the CSP forbids both). Positions and fills
// go through the CSSOM (style.setProperty).

import { isCompact, layoutMode } from '../layout.js';

let uid = 0;
/** A unique element id with a readable prefix. */
export const nextControlId = (prefix) => `ui-${prefix}-${++uid}`;

function make(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

/**
 * Keep aria-checked in step with the checked state, also when code sets
 * `input.checked = ...` (which fires no event): the property is wrapped on
 * this one element.
 */
function mirrorChecked(input) {
  let proto = Object.getPrototypeOf(input);
  let desc;
  while (proto && !(desc = Object.getOwnPropertyDescriptor(proto, 'checked'))) proto = Object.getPrototypeOf(proto);
  const sync = () => input.setAttribute('aria-checked', String(!!input.checked));
  if (desc?.get && desc.set) {
    Object.defineProperty(input, 'checked', {
      configurable: true,
      get() {
        return desc.get.call(this);
      },
      set(v) {
        desc.set.call(this, v);
        sync();
      },
    });
  }
  input.addEventListener('change', sync);
  sync();
}

/**
 * The toggle switch input alone: `<input type="checkbox" role="switch">`.
 * For rows that bring their own label and layout.
 * @param {{ id?: string, checked?: boolean, disabled?: boolean, label?: string, small?: boolean, onChange?(on: boolean, input: HTMLInputElement): void }} [o]
 *   label: an aria-label, only when no <label> names the switch
 */
export function switchInput({ id, checked = false, disabled = false, label, small = false, onChange } = {}) {
  const input = make('input', { type: 'checkbox', role: 'switch', class: small ? 'ui-switch ui-sm' : 'ui-switch', id, 'aria-label': label });
  mirrorChecked(input);
  input.checked = !!checked;
  input.disabled = !!disabled;
  if (onChange) input.addEventListener('change', () => onChange(input.checked, input));
  return input;
}

/**
 * The themed checkbox input alone (for list selections).
 * @param {{ id?: string, checked?: boolean, disabled?: boolean, label?: string, onChange?(on: boolean, input: HTMLInputElement): void }} [o]
 */
export function checkInput({ id, checked = false, disabled = false, label, onChange } = {}) {
  const input = make('input', { type: 'checkbox', class: 'ui-check', id, 'aria-label': label });
  input.checked = !!checked;
  input.disabled = !!disabled;
  if (onChange) input.addEventListener('change', () => onChange(input.checked, input));
  return input;
}

/** Row = label + control + optional hint, wired with for= / aria-describedby. */
function row(kind, rowClass, input, text, hint) {
  const label = make('label', { class: 'ui-label', for: input.id, text });
  const hintEl = hint ? make('p', { class: 'ui-hint', id: `${input.id}-hint`, text: hint }) : null;
  if (hintEl) input.setAttribute('aria-describedby', hintEl.id);
  const node = make('div', { class: ['ui-row', kind, rowClass].filter(Boolean).join(' ') });
  if (kind === 'ui-row-check') node.append(input, label);
  else node.append(label, input);
  if (hintEl) node.append(hintEl);
  return { row: node, label, hint: hintEl };
}

/**
 * An on/off setting: the label on the left, the switch on the right.
 * @param {{ id?: string, label: string, hint?: string, checked?: boolean, disabled?: boolean, title?: string, rowClass?: string, onChange?(on: boolean): void }} o
 * @returns {{ row: HTMLElement, input: HTMLInputElement, label: HTMLElement, get(): boolean, set(on: boolean): void }}
 */
export function toggle({ id = nextControlId('switch'), label, hint, checked, disabled, title, rowClass, onChange }) {
  const input = switchInput({ id, checked, disabled, onChange: onChange && ((on) => onChange(on)) });
  const r = row('ui-row-switch', rowClass, input, label, hint);
  if (title) r.row.setAttribute('title', title);
  return {
    row: r.row,
    input,
    label: r.label,
    get: () => input.checked,
    set: (on) => {
      input.checked = !!on;
    },
  };
}

/**
 * A choice from a list of things to tick: the check box first, then its label.
 * @param {{ id?: string, label: string, hint?: string, checked?: boolean, disabled?: boolean, title?: string, rowClass?: string, onChange?(on: boolean): void }} o
 */
export function checkbox({ id = nextControlId('check'), label, hint, checked, disabled, title, rowClass, onChange }) {
  const input = checkInput({ id, checked, disabled, onChange: onChange && ((on) => onChange(on)) });
  const r = row('ui-row-check', rowClass, input, label, hint);
  if (title) r.row.setAttribute('title', title);
  return {
    row: r.row,
    input,
    label: r.label,
    get: () => input.checked,
    set: (on) => {
      input.checked = !!on;
    },
  };
}

/**
 * An exclusive choice drawn as connected metal buttons: radios in one group.
 * The radios are real (arrow keys move through them, a screen reader says
 * "1 of 2"); an option can be disabled with a `title` that says why.
 * @param {{
 *   name?: string, id?: string, label: string, value?: string, block?: boolean,
 *   options: { value: string, label: string, disabled?: boolean, title?: string, id?: string }[],
 *   describedBy?: string, disabled?: boolean, onChange?(value: string): void,
 * }} o
 *   label: the group's accessible name; describedBy: id of a note under the group
 * @returns {{ root: HTMLElement, inputs: Map<string, HTMLInputElement>, labels: Map<string, HTMLElement>, get(): string | null, set(value: string): void, setDisabled(value: string, disabled: boolean): void, setTitle(value: string, title: string): void }}
 */
export function segmented({ name = nextControlId('seg'), id = name, label, options, value, block = false, describedBy, disabled = false, onChange }) {
  const root = make('div', { class: block ? 'ui-segmented ui-block' : 'ui-segmented', role: 'radiogroup', id, 'aria-label': label, 'aria-describedby': describedBy });
  const inputs = new Map();
  const labels = new Map();
  const set = (v) => {
    for (const [key, input] of inputs) input.checked = key === v;
  };
  for (const opt of options) {
    const optionId = opt.id ?? `${name}-${opt.value}`;
    const input = make('input', { type: 'radio', name, id: optionId, value: opt.value });
    input.disabled = disabled || !!opt.disabled;
    const text = make('label', { class: 'ui-segment', for: optionId, text: opt.label, title: opt.title });
    input.addEventListener('change', () => {
      if (!input.checked) return;
      set(opt.value);
      onChange?.(opt.value);
    });
    inputs.set(opt.value, input);
    labels.set(opt.value, text);
    root.append(input, text);
  }
  set(value);
  return {
    root,
    inputs,
    labels,
    get: () => [...inputs].find(([, input]) => input.checked)?.[0] ?? null,
    set,
    setDisabled(v, off) {
      const input = inputs.get(v);
      if (input) input.disabled = !!off;
    },
    setTitle(v, title) {
      const l = labels.get(v);
      if (!l) return;
      if (title) l.setAttribute('title', title);
      else l.removeAttribute('title');
    },
  };
}

/** Move the slider's lit part to the current value (the CSSOM: no style attribute). */
export function syncSliderFill(input) {
  const read = (name, fallback) => {
    const raw = input[name] || input.getAttribute(name);
    return raw === null || raw === undefined || raw === '' ? fallback : Number(raw);
  };
  const min = read('min', 0);
  const max = read('max', 100);
  const v = Number(input.value);
  const pct = max > min ? Math.max(0, Math.min(1, (v - min) / (max - min))) * 100 : 0;
  input.style.setProperty('--ui-fill', `${pct}%`);
}

/**
 * The range input alone: themed, with its fill kept in step while it moves.
 * @param {HTMLInputElement} input an existing `<input type="range">` (class and fill are added)
 * @returns {HTMLInputElement} the same input
 */
export function styleSlider(input) {
  input.classList.add('ui-slider');
  input.addEventListener('input', () => syncSliderFill(input));
  syncSliderFill(input);
  return input;
}

/**
 * A slider with its label and a live value readout.
 * @param {{ id?: string, label: string, min: number, max: number, step?: number, value: number, format?(v: number): string, disabled?: boolean, rowClass?: string, onInput?(v: number): void }} o
 * @returns {{ row: HTMLElement, input: HTMLInputElement, output: HTMLOutputElement, get(): number, set(v: number): void }}
 */
export function slider({ id = nextControlId('slider'), label, min, max, step = 1, value, format = String, disabled = false, rowClass, onInput }) {
  const input = make('input', { type: 'range', id, min: String(min), max: String(max), step: String(step) });
  input.value = String(value);
  input.disabled = disabled;
  const output = make('output', { class: 'ui-value', for: id });
  const show = () => {
    const text = format(Number(input.value));
    output.textContent = text;
    input.setAttribute('aria-valuetext', text);
  };
  styleSlider(input);
  show();
  input.addEventListener('input', () => {
    show();
    onInput?.(Number(input.value));
  });
  const node = make('div', { class: ['ui-row', 'ui-row-slider', rowClass].filter(Boolean).join(' ') }, make('label', { class: 'ui-label', for: id, text: label }), input, output);
  return {
    row: node,
    input,
    output,
    get: () => Number(input.value),
    set(v) {
      input.value = String(v);
      syncSliderFill(input);
      show();
    },
  };
}

// ---- Lamps and badges ------------------------------------------------------------

/** Lamp states (css/patterns.css .ui-led-*): never the only signal, always next to a word or mark. */
export const LED_STATES = Object.freeze(['off', 'on', 'ok', 'warn', 'bad', 'info']);

/**
 * A lamp. Decorative (aria-hidden) unless `label` is given, which makes it an
 * image with that name (for a lamp that stands alone, such as a status dot
 * in a table cell).
 * @param {'off'|'on'|'ok'|'warn'|'bad'|'info'} [state]
 * @param {string} [label]
 */
export function led(state = 'off', label) {
  const s = LED_STATES.includes(state) ? state : 'off';
  const e = make('span', { class: `ui-led ui-led-${s}` });
  if (label) {
    e.setAttribute('role', 'img');
    e.setAttribute('aria-label', label);
  } else e.setAttribute('aria-hidden', 'true');
  return e;
}

/** Set a lamp's state in place. */
export function setLed(el, state) {
  for (const s of LED_STATES) el.classList.remove(`ui-led-${s}`);
  el.classList.add(`ui-led-${LED_STATES.includes(state) ? state : 'off'}`);
}

/**
 * Badge looks (css/patterns.css .ui-badge-*) and the names screens use for
 * them. A badge is a word in capitals on a small plate; `ok` and `warn`
 * carry a lamp as well.
 */
export const BADGE_KINDS = Object.freeze(['neutral', 'accent', 'ok', 'warn', 'bad', 'info', 'hazard', 'allies', 'soviet']);
export const BADGE_ALIASES = Object.freeze({
  ready: 'ok',
  online: 'ok',
  host: 'accent',
  ingame: 'accent',
  modded: 'hazard',
  locked: 'bad',
  full: 'bad',
  kicked: 'bad',
  waiting: 'warn',
  away: 'warn',
  primary: 'neutral',
  ai: 'neutral',
  spectator: 'neutral',
  offline: 'neutral',
});
const LED_BADGES = new Set(['ok', 'warn']);

/** The look a badge kind or alias maps to ('neutral' for unknown names). */
export const badgeKind = (kind) => (BADGE_KINDS.includes(kind) ? kind : (BADGE_ALIASES[kind] ?? 'neutral'));

/**
 * A badge: READY, HOST, MODDED, LOCKED and so on. The text is the second
 * signal next to the colour (CSS sets it in capitals; write it as a word).
 * @param {string} kind a BADGE_KINDS look or a BADGE_ALIASES name
 * @param {string} text
 * @param {{ led?: boolean, title?: string }} [o] led: force the lamp on or off
 * @returns {HTMLElement}
 */
export function badge(kind, text, { led: withLed, title } = {}) {
  const look = badgeKind(kind);
  const e = make('span', { class: `ui-badge ui-badge-${look}`, title });
  if (withLed ?? LED_BADGES.has(look)) e.append(led(look === 'ok' || look === 'warn' || look === 'bad' || look === 'info' ? look : 'on'));
  const word = make('span', { class: look === 'hazard' ? 'ui-badge-text' : null, text });
  e.append(word);
  return e;
}

// ---- Select ---------------------------------------------------------------------

/**
 * Whether the select's list opens as a bottom sheet: in the phone layouts
 * (js/layout.js: portrait up to 720 px wide, landscape up to 500 px high).
 */
export const selectSheetMode = (w, h) => isCompact(layoutMode(w, h));

/** Popover API (the top layer) where the browser has it. */
const hasPopover = (el) => typeof el.showPopover === 'function' && typeof el.hidePopover === 'function';

/** Flatten options and groups: `[{ value, label, hint?, disabled?, title?, led?, group? }]`. */
function flattenOptions(options) {
  const out = [];
  for (const o of options ?? []) {
    if (o && Array.isArray(o.options)) {
      for (const c of o.options) out.push({ ...c, group: o.label });
    } else if (o) out.push({ ...o, group: null });
  }
  return out;
}

const sameValue = (a, b) => a === b || (a !== null && a !== undefined && b !== null && b !== undefined && String(a) === String(b));

/** Typeahead buffers reset after this pause (ms), like the browser's own lists. */
export const TYPEAHEAD_MS = 500;

/**
 * The select: a metal plate with a lamp, the chosen option in capitals and a
 * flap with a chevron; it opens a list with a lamp per option (hints under
 * the option names). Keyboard as a native select; on phones the list is a
 * sheet at the bottom of the screen.
 *
 * @param {{
 *   id?: string, label?: string, labelledBy?: string, describedBy?: string,
 *   options: ({ value: any, label: string, hint?: string, disabled?: boolean, title?: string, led?: string }
 *             | { label: string, options: object[] })[],
 *   value?: any, placeholder?: string, disabled?: boolean, block?: boolean, small?: boolean,
 *   title?: string, sheet?: 'auto' | 'always' | 'never', className?: string,
 *   onChange?(value: any, option: object): void, onOpen?(): void, onClose?(): void,
 * }} o
 *   label: the accessible name (also the sheet's title); or labelledBy: id of a visible label.
 *   Option values compare as strings (like a native select); get() returns the option's own value.
 *   option.led: the option's lamp state when it is not chosen (LED_STATES), for options that carry
 *   a status (the chosen option's lamp is always lit).
 * @returns {{
 *   root: HTMLElement, button: HTMLButtonElement, listbox: HTMLElement, panel: HTMLElement,
 *   get(): any, set(value: any): void, option(value?: any): object | null,
 *   setOptions(options: object[], value?: any): void, setDisabled(off: boolean): void,
 *   setOptionDisabled(value: any, off: boolean, title?: string): void,
 *   open(at?: 'selected' | 'first' | 'last'): void, close(focusButton?: boolean): void, isOpen(): boolean,
 *   isSheet(): boolean, destroy(): void,
 * }}
 */
export function selectPlate({
  id = nextControlId('select'),
  label = '',
  labelledBy,
  describedBy,
  options,
  value,
  placeholder = '',
  disabled = false,
  block = false,
  small = false,
  title,
  sheet = 'auto',
  className,
  onChange,
  onOpen,
  onClose,
}) {
  const root = make('div', { class: ['ui-select-plate', block && 'ui-block', small && 'ui-sm', className].filter(Boolean).join(' '), id: `${id}-root` });
  let labelId = labelledBy;
  let labelText = label;
  if (!labelId) {
    labelId = `${id}-label`;
    root.append(make('span', { class: 'ui-sr-only', id: labelId, text: label }));
  }
  const valueId = `${id}-value`;
  const listId = `${id}-list`;
  const lamp = led('on');
  const valueText = make('span', { class: 'ui-sp-value', id: valueId });
  const button = make(
    'button',
    {
      type: 'button',
      class: 'ui-sp-button',
      id,
      title,
      'aria-haspopup': 'listbox',
      'aria-expanded': 'false',
      'aria-controls': listId,
      'aria-labelledby': `${labelId} ${valueId}`,
      'aria-describedby': describedBy,
    },
    make('span', { class: 'ui-sp-face' }, lamp, valueText),
    make('span', { class: 'ui-sp-flap', 'aria-hidden': 'true' }),
  );
  const listbox = make('div', { class: 'ui-sp-list', role: 'listbox', id: listId, tabindex: '-1', 'aria-labelledby': labelId });
  const sheetTitle = make('span', { class: 'ui-sp-title', 'aria-hidden': 'true', text: labelText });
  const closeButton = make('button', { type: 'button', class: 'ui-sp-close', 'aria-label': 'Close', tabindex: '-1' });
  const head = make('div', { class: 'ui-sp-head' }, sheetTitle, closeButton);
  const card = make('div', { class: 'ui-sp-card' }, head, listbox);
  const panel = make('div', { class: 'ui-sp-panel', id: `${id}-panel` }, card);
  if (hasPopover(panel)) panel.setAttribute('popover', 'manual');
  else panel.hidden = true;
  root.append(button, panel);

  let items = []; // { opt, el }
  let current = null; // the chosen item
  let active = null; // the highlighted item while open
  let open = false;
  let asSheet = false;
  let typed = '';
  let typedAt = 0;
  let cleanup = [];

  const enabled = (it) => it && !it.opt.disabled;
  const itemOf = (v) => items.find((it) => sameValue(it.opt.value, v)) ?? null;

  function paintButton() {
    valueText.textContent = current ? current.opt.label : placeholder;
    setLed(lamp, current ? 'on' : 'off');
    root.classList.toggle('ui-sp-empty', !current);
  }

  function paintItems() {
    for (const it of items) {
      const chosen = it === current;
      it.el.setAttribute('aria-selected', String(chosen));
      it.el.classList.toggle('ui-sp-active', it === active);
      setLed(it.lamp, chosen ? 'on' : (it.opt.led ?? 'off'));
    }
    if (active) listbox.setAttribute('aria-activedescendant', active.el.id);
    else listbox.removeAttribute('aria-activedescendant');
  }

  function build(opts) {
    listbox.replaceChildren();
    items = [];
    let groupEl = null;
    let groupName = null;
    let n = 0;
    for (const opt of flattenOptions(opts)) {
      if (opt.group !== groupName) {
        groupName = opt.group;
        if (groupName === null) groupEl = null;
        else {
          const gid = `${id}-g${items.length}`;
          groupEl = make('div', { class: 'ui-sp-group', role: 'group', 'aria-labelledby': gid }, make('div', { class: 'ui-sp-group-label', id: gid, role: 'presentation', text: groupName }));
          listbox.append(groupEl);
        }
      }
      const itemLamp = led('off');
      const text = make('span', { class: 'ui-sp-text' }, make('span', { class: 'ui-sp-label', text: opt.label }));
      if (opt.hint) text.append(make('span', { class: 'ui-sp-hint', text: opt.hint }));
      const el = make('div', { class: 'ui-sp-option', role: 'option', id: `${id}-o${n++}`, title: opt.title, 'aria-disabled': opt.disabled ? 'true' : null }, itemLamp, text);
      const it = { opt, el, lamp: itemLamp };
      el.addEventListener('click', (e) => {
        e.preventDefault?.();
        if (!enabled(it)) return;
        choose(it);
        close(true);
      });
      el.addEventListener('pointermove', () => {
        if (open && enabled(it) && active !== it) {
          active = it;
          paintItems();
        }
      });
      items.push(it);
      (groupEl ?? listbox).append(el);
    }
  }

  function choose(it) {
    if (!it || !enabled(it)) return;
    const changed = it !== current;
    current = it;
    paintButton();
    paintItems();
    if (changed) onChange?.(it.opt.value, it.opt);
  }

  /** Move the highlight to `it` and scroll it into view. */
  function activate(it) {
    if (!it) return;
    active = it;
    paintItems();
    it.el.scrollIntoView?.({ block: 'nearest' });
  }

  function step(from, dir, count = 1) {
    const list = items;
    if (!list.length) return null;
    let i = from ? list.indexOf(from) : dir > 0 ? -1 : list.length;
    let last = from && enabled(from) ? from : null;
    for (let moved = 0; moved < count; ) {
      i += dir;
      if (i < 0 || i >= list.length) break;
      if (enabled(list[i])) {
        last = list[i];
        moved++;
      }
    }
    return last;
  }
  const first = () => items.find(enabled) ?? null;
  const lastItem = () => [...items].reverse().find(enabled) ?? null;

  /** Typeahead: the next enabled option whose label starts with what was typed. */
  function typeahead(ch) {
    const now = Date.now();
    typed = now - typedAt > TYPEAHEAD_MS ? ch : typed + ch;
    typedAt = now;
    const q = typed.toLocaleLowerCase();
    // One letter typed again cycles through the options with that letter.
    const repeat = q.length > 1 && [...q].every((c) => c === q[0]);
    const needle = repeat ? q[0] : q;
    const from = (open ? active : current) ?? null;
    const start = from ? items.indexOf(from) + (needle.length === 1 ? 1 : 0) : 0;
    for (let k = 0; k < items.length; k++) {
      const it = items[(start + k) % items.length];
      if (enabled(it) && it.opt.label.toLocaleLowerCase().startsWith(needle)) return it;
    }
    return null;
  }

  function place() {
    if (!open) return;
    const r = button.getBoundingClientRect();
    const vw = window.innerWidth || document.documentElement.clientWidth || r.right;
    const vh = window.innerHeight || document.documentElement.clientHeight || r.bottom;
    if (asSheet) return;
    const gap = 4;
    const below = vh - r.bottom - gap - 8;
    const above = r.top - gap - 8;
    const want = Math.min(listbox.scrollHeight || 320, 320);
    const up = below < Math.min(want, 200) && above > below;
    const width = Math.max(r.width, 160);
    const left = Math.max(8, Math.min(r.left, vw - width - 8));
    panel.style.setProperty('--sp-left', `${Math.round(left)}px`);
    panel.style.setProperty('--sp-width', `${Math.round(width)}px`);
    panel.style.setProperty('--sp-max-h', `${Math.max(120, Math.round(up ? above : below))}px`);
    if (up) {
      panel.style.setProperty('--sp-top', 'auto');
      panel.style.setProperty('--sp-bottom', `${Math.round(vh - r.top + gap)}px`);
    } else {
      panel.style.setProperty('--sp-top', `${Math.round(r.bottom + gap)}px`);
      panel.style.setProperty('--sp-bottom', 'auto');
    }
    panel.classList.toggle('ui-sp-up', up);
  }

  function openList(at = 'selected') {
    if (open || button.disabled || !items.length || !root.isConnected) return;
    open = true;
    asSheet = sheet === 'always' || (sheet === 'auto' && selectSheetMode(window.innerWidth, window.innerHeight));
    panel.classList.toggle('ui-sp-sheet', asSheet);
    // The list inherits its size from the button (the scaled UI and the touch rows).
    const size = typeof getComputedStyle === 'function' ? getComputedStyle(root).fontSize : '';
    if (size) panel.style.setProperty('--sp-font', size);
    button.setAttribute('aria-expanded', 'true');
    root.classList.add('ui-sp-open');
    if (hasPopover(panel)) panel.showPopover();
    else panel.hidden = false;
    activate(at === 'first' ? first() : at === 'last' ? lastItem() : enabled(current) ? current : first());
    place();
    listbox.focus({ preventScroll: true });
    // A press outside closes the list without a choice. The sheet's dim area
    // is the panel itself: its click handler closes it, so the press never
    // reaches what lies under the sheet.
    const onDown = (e) => {
      const t = e.target;
      if (!panel.contains(t) && !button.contains(t)) close(false);
    };
    const onMove = () => place();
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener?.('resize', onMove);
    window.addEventListener?.('scroll', onMove, true);
    cleanup = [
      () => document.removeEventListener('pointerdown', onDown, true),
      () => window.removeEventListener?.('resize', onMove),
      () => window.removeEventListener?.('scroll', onMove, true),
    ];
    onOpen?.();
  }

  function close(focusButton = true) {
    if (!open) return;
    open = false;
    for (const fn of cleanup) fn();
    cleanup = [];
    button.setAttribute('aria-expanded', 'false');
    root.classList.remove('ui-sp-open');
    panel.classList.remove('ui-sp-sheet', 'ui-sp-up');
    if (hasPopover(panel)) {
      try {
        panel.hidePopover();
      } catch {
        // Already hidden (the page removed it from the top layer).
      }
    } else panel.hidden = true;
    active = null;
    typed = '';
    paintItems();
    if (focusButton) button.focus();
    onClose?.();
  }

  button.addEventListener('click', () => (open ? close(true) : openList()));
  closeButton.addEventListener('click', () => close(true));
  // The sheet's dim area: a click there closes, and never reaches what is under it.
  panel.addEventListener('click', (e) => {
    if (e.target === panel) close(true);
  });

  const printable = (e) => typeof e.key === 'string' && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;

  button.addEventListener('keydown', (e) => {
    if (button.disabled) return;
    const k = e.key;
    if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'Home' || k === 'End') {
      e.preventDefault();
      openList(k === 'Home' ? 'first' : k === 'End' ? 'last' : 'selected');
    } else if (printable(e) && e.key !== ' ') {
      const it = typeahead(e.key);
      if (it) {
        e.preventDefault();
        openList();
        activate(it);
      }
    }
  });

  listbox.addEventListener('keydown', (e) => {
    const k = e.key;
    let handled = true;
    if (k === 'ArrowDown') activate(step(active, 1) ?? active);
    else if (k === 'ArrowUp') activate(step(active, -1) ?? active);
    else if (k === 'Home') activate(first());
    else if (k === 'End') activate(lastItem());
    else if (k === 'PageDown') activate(step(active, 1, 10) ?? active);
    else if (k === 'PageUp') activate(step(active, -1, 10) ?? active);
    else if (k === 'Enter' || (k === ' ' && !(typed && Date.now() - typedAt <= TYPEAHEAD_MS))) {
      choose(active);
      close(true);
    } else if (k === 'Escape') {
      close(true);
      // The list closes; the game menu or dialog behind it stays open.
      e.stopPropagation();
    } else if (k === 'Tab') {
      choose(active);
      close(true);
      handled = false; // focus moves on from the button, as from a native select
    } else if (printable(e)) {
      const it = typeahead(e.key);
      if (it) activate(it);
    } else handled = false;
    if (handled) e.preventDefault();
  });

  build(options);
  current = itemOf(value);
  paintButton();
  paintItems();
  button.disabled = !!disabled;

  return {
    root,
    button,
    listbox,
    panel,
    get: () => (current ? current.opt.value : null),
    set(v) {
      current = itemOf(v);
      paintButton();
      paintItems();
    },
    option: (v) => (v === undefined ? (current?.opt ?? null) : (itemOf(v)?.opt ?? null)),
    setOptions(opts, v) {
      const keep = v === undefined ? current?.opt.value : v;
      if (open) close(false);
      build(opts);
      current = itemOf(keep);
      paintButton();
      paintItems();
    },
    setDisabled(off) {
      if (off) close(false);
      button.disabled = !!off;
    },
    setOptionDisabled(v, off, optTitle) {
      const it = itemOf(v);
      if (!it) return;
      it.opt.disabled = !!off;
      if (off) it.el.setAttribute('aria-disabled', 'true');
      else it.el.removeAttribute('aria-disabled');
      if (optTitle !== undefined) {
        if (optTitle) it.el.setAttribute('title', optTitle);
        else it.el.removeAttribute('title');
      }
    },
    open: openList,
    close,
    isOpen: () => open,
    isSheet: () => open && asSheet,
    destroy() {
      close(false);
      root.remove();
    },
  };
}

/**
 * A select with its label in a row, like toggle() and slider(): the label on
 * the left, the select on the right while both fit (on a line of its own in
 * narrow cards).
 * @param {{ label: string, hint?: string, rowClass?: string } & Parameters<typeof selectPlate>[0]} o
 * @returns {{ row: HTMLElement, label: HTMLElement, select: ReturnType<typeof selectPlate> }}
 */
export function selectRow({ id = nextControlId('select'), label, hint, rowClass, ...rest }) {
  const labelEl = make('span', { class: 'ui-label', id: `${id}-label`, text: label });
  const hintEl = hint ? make('p', { class: 'ui-hint', id: `${id}-hint`, text: hint }) : null;
  const select = selectPlate({ ...rest, id, label, labelledBy: labelEl.id, describedBy: hintEl ? hintEl.id : rest.describedBy });
  // A click on the label opens the list, like a <label> on a native select focuses it.
  labelEl.addEventListener('click', () => select.button.focus());
  const row = make('div', { class: ['ui-row', 'ui-row-choice', rowClass].filter(Boolean).join(' ') }, labelEl, select.root);
  if (hintEl) row.append(hintEl);
  return { row, label: labelEl, select };
}

// ---- Stepper ----------------------------------------------------------------------

/**
 * A stepper: minus, the value in mono, plus. Underneath it is a choice from
 * fixed values (the lobby's starting cash steps, for example): an ARIA
 * spinbutton (arrow keys, Page Up/Down, Home/End) whose buttons step one value.
 * @param {{
 *   id?: string, label?: string, labelledBy?: string, describedBy?: string,
 *   values: any[], value?: any, format?(v: any): string, disabled?: boolean, block?: boolean,
 *   decLabel?: string, incLabel?: string, onChange?(value: any): void,
 * }} o
 * @returns {{ root: HTMLElement, field: HTMLElement, dec: HTMLButtonElement, inc: HTMLButtonElement,
 *   get(): any, set(value: any): void, setValues(values: any[], value?: any): void, setDisabled(off: boolean): void }}
 */
export function stepper({ id = nextControlId('stepper'), label, labelledBy, describedBy, values, value, format = String, disabled = false, block = false, decLabel = 'Less', incLabel = 'More', onChange }) {
  let list = [...values];
  let index = Math.max(0, list.findIndex((v) => sameValue(v, value)));
  let off = !!disabled;
  const field = make('div', {
    class: 'ui-stepper-value',
    id,
    role: 'spinbutton',
    tabindex: '0',
    'aria-label': labelledBy ? null : label,
    'aria-labelledby': labelledBy,
    'aria-describedby': describedBy,
  });
  const dec = make('button', { type: 'button', class: 'ui-stepper-dec', 'aria-label': decLabel, tabindex: '-1' });
  const inc = make('button', { type: 'button', class: 'ui-stepper-inc', 'aria-label': incLabel, tabindex: '-1' });
  const root = make('div', { class: block ? 'ui-stepper ui-block' : 'ui-stepper' }, dec, field, inc);

  function paint() {
    const v = list[index];
    const text = list.length ? format(v) : '';
    field.textContent = text;
    field.setAttribute('aria-valuemin', '0');
    field.setAttribute('aria-valuemax', String(Math.max(0, list.length - 1)));
    field.setAttribute('aria-valuenow', String(index));
    field.setAttribute('aria-valuetext', text);
    if (off) field.setAttribute('aria-disabled', 'true');
    else field.removeAttribute('aria-disabled');
    field.tabIndex = off ? -1 : 0;
    dec.disabled = off || index <= 0;
    inc.disabled = off || index >= list.length - 1;
    root.classList.toggle('ui-disabled', off);
  }

  function go(to) {
    if (off || !list.length) return;
    const next = Math.max(0, Math.min(list.length - 1, to));
    if (next === index) return;
    index = next;
    paint();
    onChange?.(list[index]);
  }

  dec.addEventListener('click', () => go(index - 1));
  inc.addEventListener('click', () => go(index + 1));
  field.addEventListener('keydown', (e) => {
    const k = e.key;
    const big = Math.max(1, Math.round(list.length / 10));
    const to = { ArrowUp: index + 1, ArrowRight: index + 1, ArrowDown: index - 1, ArrowLeft: index - 1, PageUp: index + big, PageDown: index - big, Home: 0, End: list.length - 1 }[k];
    if (to === undefined) return;
    e.preventDefault();
    go(to);
  });
  paint();

  return {
    root,
    field,
    dec,
    inc,
    get: () => list[index],
    set(v) {
      const i = list.findIndex((x) => sameValue(x, v));
      if (i >= 0) index = i;
      paint();
    },
    setValues(next, v) {
      const keep = v === undefined ? list[index] : v;
      list = [...next];
      index = Math.max(0, list.findIndex((x) => sameValue(x, keep)));
      paint();
    },
    setDisabled(d) {
      off = !!d;
      paint();
    },
  };
}

// ---- Tabs -------------------------------------------------------------------------

/**
 * A tab strip (Controls board: a lamp per tab, lit on the open one): an ARIA
 * tablist with roving focus. Arrow keys (left/right, or up/down with
 * `vertical`) and Home/End move and open a tab at once (automatic activation).
 * Panels are the caller's: pass `panel` (an element) per tab and they are
 * wired (role tabpanel, aria-labelledby, hidden), or use onChange.
 * @param {{
 *   id?: string, label: string, vertical?: boolean, value?: string,
 *   tabs: { id: string, label: string, panel?: HTMLElement, disabled?: boolean, title?: string }[],
 *   onChange?(id: string): void,
 * }} o
 * @returns {{ root: HTMLElement, buttons: Map<string, HTMLButtonElement>, get(): string | null, set(id: string): void, setDisabled(id: string, off: boolean): void }}
 */
export function tabs({ id = nextControlId('tabs'), label, vertical = false, value, tabs: list, onChange }) {
  const root = make('div', { class: vertical ? 'ui-tabs ui-vertical' : 'ui-tabs', role: 'tablist', id, 'aria-label': label, 'aria-orientation': vertical ? 'vertical' : null });
  const buttons = new Map();
  let current = null;
  for (const t of list) {
    const b = make('button', { type: 'button', class: 'ui-tab', role: 'tab', id: `${id}-${t.id}`, title: t.title, 'aria-controls': t.panel ? t.panel.id || `${id}-${t.id}-panel` : null }, led('off'), make('span', { text: t.label }));
    b.disabled = !!t.disabled;
    if (t.panel) {
      if (!t.panel.id) t.panel.id = `${id}-${t.id}-panel`;
      t.panel.setAttribute('role', 'tabpanel');
      t.panel.setAttribute('aria-labelledby', b.id);
      t.panel.tabIndex = 0;
    }
    b.addEventListener('click', () => pick(t.id, true));
    buttons.set(t.id, b);
    root.append(b);
  }
  function show(tid) {
    current = buttons.has(tid) ? tid : null;
    for (const t of list) {
      const b = buttons.get(t.id);
      const on = t.id === current;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      setLed(b.querySelector('.ui-led'), on ? 'on' : 'off');
      if (t.panel) t.panel.hidden = !on;
    }
  }
  function pick(tid, user) {
    const b = buttons.get(tid);
    if (!b || b.disabled) return;
    const changed = tid !== current;
    show(tid);
    if (user && changed) onChange?.(tid);
  }
  root.addEventListener('keydown', (e) => {
    const order = list.map((t) => t.id).filter((tid) => !buttons.get(tid).disabled);
    if (!order.length) return;
    const at = Math.max(0, order.indexOf(current));
    const next = vertical ? { ArrowDown: 1, ArrowUp: -1 } : { ArrowRight: 1, ArrowLeft: -1 };
    let to = null;
    if (next[e.key]) to = order[(at + next[e.key] + order.length) % order.length];
    else if (e.key === 'Home') to = order[0];
    else if (e.key === 'End') to = order[order.length - 1];
    if (to === null) return;
    e.preventDefault();
    pick(to, true);
    buttons.get(to).focus();
  });
  show(value ?? list.find((t) => !t.disabled)?.id ?? null);
  return {
    root,
    buttons,
    get: () => current,
    set: (tid) => show(tid),
    setDisabled(tid, off) {
      const b = buttons.get(tid);
      if (b) b.disabled = !!off;
    },
  };
}

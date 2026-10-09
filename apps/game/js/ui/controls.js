// Themed form controls (css/controls.css): a toggle switch, a segmented
// choice, a checkbox and a range slider, plus the plain switch / checkbox
// inputs for rows that bring their own layout.
//
// Every control is a real form input (a checkbox with role "switch", radios,
// a checkbox, a range), so the browser gives keyboard use (Space toggles, the
// arrow keys move through a radio group and a slider) and screen readers
// announce the right role and state. The DOM is built with createElement and
// textContent only: no HTML strings, no style attributes (the CSP forbids
// both). The slider's fill goes through the CSSOM (style.setProperty).

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

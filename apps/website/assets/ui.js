// Small DOM helpers for the account and admin pages. Everything is built with
// createElement and textContent: the site's CSP allows no inline scripts or
// style attributes, and text from the server is never parsed as HTML.

import { checkInput, selectPlate, switchInput } from '/lib/js/ui/controls.js';

export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'on') for (const [type, fn] of Object.entries(v)) e.addEventListener(type, fn);
    else if (k === 'value') e.value = v;
    else if (k === 'checked') e.checked = !!v;
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

/**
 * Children for append/replaceChildren without the gaps: the DOM turns null,
 * undefined and false into text ("null"), so optional sections that are left
 * out (null) must be dropped before inserting.
 */
export const present = (...xs) => xs.flat().filter((x) => x !== null && x !== undefined && x !== false);

let uid = 0;
/** A unique element id with a readable prefix. */
export const nextId = (prefix) => `${prefix}-${++uid}`;

/** A labelled form field: `{ row, input }`. `input` may be an element or a tag name. */
export function field(label, input, { help, wide = false } = {}) {
  const control = typeof input === 'string' ? el(input) : input;
  if (!control.id) control.id = nextId('f');
  if (control.localName === 'select') control.classList.add('ui-select');
  const helpEl = help ? el('p', { class: 'form-help', id: nextId('h'), text: help }) : null;
  if (helpEl) control.setAttribute('aria-describedby', helpEl.id);
  const row = el('div', { class: wide ? 'field field-wide' : 'field' }, el('label', { for: control.id, text: label }), control, helpEl);
  return { row, input: control };
}

/**
 * A labelled select: the design system's select plate (the shared controls,
 * /lib/js/ui/controls.js selectPlate) under a label, like field(). Options
 * are `{ value, label, hint?, disabled? }`; `onChange(value)` fires on the
 * player's choice only. Returns `{ row, select }` (select.get(), set(v),
 * setDisabled(off), button).
 */
export function selectField(label, options, { value, help, disabled = false, wide = false, onChange } = {}) {
  const id = nextId('s');
  const labelEl = el('span', { class: 'field-label', id: `${id}-label`, text: label });
  const helpEl = help ? el('p', { class: 'form-help', id: nextId('h'), text: help }) : null;
  const select = selectPlate({ id, labelledBy: labelEl.id, describedBy: helpEl?.id, options, value, disabled, block: true, onChange });
  // The label names the select; a click on it moves there, as a <label> would.
  labelEl.addEventListener('click', () => select.button.focus());
  const row = el('div', { class: wide ? 'field field-wide' : 'field' }, labelEl, select.root, helpEl);
  return { row, select };
}

function checkRow(input, label, help) {
  const helpEl = help ? el('p', { class: 'form-help', id: nextId('h'), text: help }) : null;
  if (helpEl) input.setAttribute('aria-describedby', helpEl.id);
  const row = el('div', { class: 'check' }, input, el('label', { for: input.id, text: label }), helpEl);
  return { row, input };
}

/** A themed checkbox with its label after it: for things to tick in a list or agree to. */
export function checkbox(label, { checked = false, help } = {}) {
  return checkRow(checkInput({ id: nextId('c'), checked }), label, help);
}

/** A toggle switch with its label after it: for a setting that is on or off. */
export function toggle(label, { checked = false, help } = {}) {
  return checkRow(switchInput({ id: nextId('c'), checked }), label, help);
}

/**
 * A status line for a form or section: `show(text, kind)` with kind
 * 'error', 'ok' or 'info'; errors are announced (role alert).
 */
export function statusLine() {
  const p = el('p', { class: 'form-status', hidden: true });
  return {
    node: p,
    show(text, kind = 'info') {
      p.textContent = text;
      p.className = `form-status form-status-${kind}`;
      p.setAttribute('role', kind === 'error' ? 'alert' : 'status');
      p.hidden = !text;
    },
    clear() {
      p.textContent = '';
      p.hidden = true;
    },
  };
}

/**
 * A modal dialog: `build(body, close)` fills it; resolves with what close()
 * got (Escape, the close button and the backdrop give null). Focus moves in
 * and comes back; Tab stays inside.
 */
export function openDialog(title, build, { wide = false } = {}) {
  return new Promise((resolve) => {
    const titleId = nextId('dialog-title');
    const body = el('div', { class: 'dialog-body' });
    const closeButton = el('button', { type: 'button', class: 'btn btn-small dialog-close', text: 'Close' });
    const card = el(
      'div',
      { class: wide ? 'panel dialog dialog-wide' : 'panel dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
      el('div', { class: 'dialog-head' }, el('h2', { id: titleId, text: title }), closeButton),
      body,
    );
    const overlay = el('div', { class: 'dialog-overlay' }, card);
    const opener = document.activeElement;
    let done = false;
    const close = (value = null) => {
      if (done) return;
      done = true;
      overlay.remove();
      if (opener?.isConnected) opener.focus?.();
      resolve(value);
    };
    closeButton.addEventListener('click', () => close(null));
    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) close(null);
    });
    overlay.addEventListener('keydown', (e) => {
      // Keys inside a select's list, a stepper or tabs are theirs (Esc closes the list, not the dialog).
      if (e.target?.closest?.('[role="listbox"], [role="spinbutton"], [role="tablist"]')) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        close(null);
      } else if (e.key === 'Tab') {
        const list = [...card.querySelectorAll('button, a[href], input, select, textarea, summary')].filter((x) => !x.disabled && !x.hidden);
        if (!list.length) return;
        const first = list[0];
        const last = list[list.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    });
    build(body, close);
    document.body.append(overlay);
    (body.querySelector('input, select, textarea, button') ?? closeButton).focus();
  });
}

/** Ask a yes or no question. `confirmText` is the button; `danger` makes it red. */
export function confirmDialog(title, message, { confirmText = 'Confirm', danger = false } = {}) {
  return openDialog(title, (body, close) => {
    const yes = el('button', { type: 'button', class: danger ? 'btn btn-danger' : 'btn btn-primary', text: confirmText });
    const no = el('button', { type: 'button', class: 'btn', text: 'Cancel' });
    yes.addEventListener('click', () => close(true));
    no.addEventListener('click', () => close(false));
    body.append(el('p', { text: message }), el('div', { class: 'form-actions' }, yes, no));
  }).then((v) => v === true);
}

/** Run an async action with its button disabled; errors go to `status`. Returns the result or undefined. */
export async function busy(button, status, fn, errorText = (e) => e.message) {
  if (button) button.disabled = true;
  status?.clear?.();
  try {
    return await fn();
  } catch (err) {
    status?.show(errorText(err), 'error');
    return undefined;
  } finally {
    if (button) button.disabled = false;
  }
}

/** Save a Blob as a file (the data export). */
export function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: name, class: 'visually-hidden' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

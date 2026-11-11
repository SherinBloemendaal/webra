// Tiny DOM helpers for the editor panels.

import { selectPlate } from '../../js/ui/controls.js';

/**
 * Create an element. `attrs`: `class`, `on<event>` handlers, boolean properties
 * (hidden, disabled, checked, selected) and plain attributes; undefined, null and
 * false values are skipped. `children`: string, Node, null or (nested) arrays.
 */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'class') node.className = v;
    else if (k === 'value') node.value = v;
    // Through the CSSOM: the Content-Security-Policy blocks style attributes.
    else if (k === 'style') node.style.cssText = String(v);
    else if (typeof v === 'boolean') node[k] = v;
    else node.setAttribute(k, String(v));
  }
  append(node, children);
  return node;
}

/**
 * A select with a visible label above it: the game's select plate
 * (js/ui/controls.js selectPlate) in a `div.field` (not a <label>: a click on
 * the words would open the list). `o` goes to selectPlate as is (options,
 * value, onChange, small, ...); the plate is named by the label.
 * `attrs`: attributes of the field (class, hidden, title).
 * @returns {{ field: HTMLElement, select: ReturnType<typeof selectPlate> }}
 */
export function selectField(label, o, attrs = {}) {
  const id = o.id ?? `ed-select-${++selectFields}`;
  const name = el('span', { class: 'label', id: `${id}-name` }, label);
  const select = selectPlate({ block: true, label, ...o, id, labelledBy: name.id });
  const field = el('div', { ...attrs, class: `field${attrs.class ? ` ${attrs.class}` : ''}` }, [name, select.root]);
  return { field, select };
}
let selectFields = 0;

function append(node, children) {
  if (children === null || children === undefined || children === false) return;
  if (Array.isArray(children)) {
    for (const c of children) append(node, c);
    return;
  }
  node.append(children instanceof Node ? children : document.createTextNode(String(children)));
}

/**
 * Keyboard for a strip of ARIA tabs with roving focus (buttons with
 * `data-tab`): Left and Right move to the previous or next tab (wrapping),
 * Home and End to the first or last, and open it at once (automatic
 * activation, like js/ui/controls.js tabs()). `open(id)` shows the tab.
 */
export function tabKeys(tablist, ids, open) {
  const step = { ArrowRight: 1, ArrowLeft: -1 };
  tablist.addEventListener('keydown', (e) => {
    const tab = e.target?.closest?.('[role="tab"]');
    if (!tab || !ids.length) return;
    const at = Math.max(0, ids.indexOf(tab.dataset.tab));
    let to = null;
    if (step[e.key]) to = ids[(at + step[e.key] + ids.length) % ids.length];
    else if (e.key === 'Home') to = ids[0];
    else if (e.key === 'End') to = ids[ids.length - 1];
    if (to === null) return;
    // The keys are the tabs': the map view and the shortcuts do not get them.
    e.preventDefault();
    e.stopPropagation();
    open(to);
    tablist.querySelector(`[data-tab="${to}"]`)?.focus();
  });
}

/** Trigger a browser download of a Blob. */
export function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** localStorage access that never throws (private mode, blocked storage). */
export const store = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      // Storage unavailable: nothing to remove.
    }
  },
};

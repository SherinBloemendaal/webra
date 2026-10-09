// "?" help buttons with a themed tooltip (css/help.css), for the lobby
// options and the in-game settings. Texts come from js/help.js.
//
//   const tip = infoTip('weather', { label: 'Weather', describes: select });
//   row.append(tip.root);
//
// Behaviour: a mouse hovering the button or keyboard focus shows the tip;
// a click or tap pins it open and a second one closes it; Esc, a press
// outside it or opening another tip closes it. One tip is open at a time.
// The tip is the button's and the option's aria-describedby, so screen
// readers read it with the control even while it is hidden. DOM through
// createElement and textContent only (strict CSP: no inline styles; the
// position is set through CSSOM custom properties).

import { helpText } from './help.js';

let uid = 0;
/** The open tip, if any. */
let current = null;
/** The document whose Esc and outside presses close tips. */
let listeningOn = null;

function onDocKey(e) {
  if (e.key === 'Escape' && current) {
    current.close();
    e.preventDefault();
    e.stopPropagation();
  }
}

function onDocPointer(e) {
  if (current && !current.root.contains(e.target)) current.close();
}

function listen() {
  if (typeof document === 'undefined' || listeningOn === document) return;
  listeningOn = document;
  current = null;
  document.addEventListener('keydown', onDocKey);
  document.addEventListener('pointerdown', onDocPointer, true);
}

/** Close the open tip. Returns whether one was open (for Esc handlers that run first, such as the game menu's). */
export function closeOpenTip() {
  if (!current) return false;
  current.close();
  return true;
}

/** Whether a tip is open (tests and Esc handlers). */
export const openTip = () => current;

class InfoTip {
  constructor(key, { label, describes = [], text = helpText(key), className = '' }) {
    this.key = key;
    this.pinned = false;
    this.hover = false;
    this.focused = false;
    const id = `info-tip-${++uid}`;

    this.root = document.createElement('span');
    this.root.className = className ? `info ${className}` : 'info';

    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.className = 'info-btn';
    this.button.textContent = '?';
    this.button.setAttribute('aria-label', `About ${label}`);
    this.button.setAttribute('aria-describedby', id);
    this.button.setAttribute('aria-expanded', 'false');
    this.button.dataset.help = key;

    this.tip = document.createElement('span');
    this.tip.className = 'info-tip';
    this.tip.id = id;
    this.tip.setAttribute('role', 'tooltip');
    this.tip.textContent = text;
    this.tip.hidden = true;

    this.root.append(this.button, this.tip);
    for (const control of [].concat(describes).filter(Boolean)) describe(control, id);

    // Hover: mouse only (a touch "hover" comes with the tap, which pins).
    this.button.addEventListener('pointerenter', (e) => {
      if (e.pointerType && e.pointerType !== 'mouse') return;
      this.hover = true;
      this.update();
    });
    this.button.addEventListener('pointerleave', (e) => {
      if (e.pointerType && e.pointerType !== 'mouse') return;
      this.hover = false;
      this.update();
    });
    this.button.addEventListener('focus', () => {
      this.focused = true;
      this.update();
    });
    this.button.addEventListener('blur', () => {
      this.focused = false;
      this.update();
    });
    this.button.addEventListener('click', (e) => {
      // Inside a <label> or a form row the click is only ours.
      e.preventDefault();
      e.stopPropagation();
      if (this.pinned) this.close();
      else {
        this.pinned = true;
        this.update();
      }
    });
    this.button.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isOpen) {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
    });
    listen();
  }

  get isOpen() {
    return !this.tip.hidden;
  }

  /** Close and forget hover, focus and pin (they show it again only when they happen again). Focus stays where it is. */
  close() {
    this.pinned = false;
    this.hover = false;
    this.focused = false;
    this.update();
  }

  update() {
    const open = this.pinned || this.hover || this.focused;
    if (open === this.isOpen) return;
    if (open) {
      if (current && current !== this) current.close();
      current = this;
    } else if (current === this) {
      current = null;
    }
    this.tip.hidden = !open;
    this.button.setAttribute('aria-expanded', open ? 'true' : 'false');
    this.root.classList.toggle('info-open', open);
    if (open) this.place();
  }

  /** Keep the tip on screen: shift it sideways and open it upwards near the bottom. */
  place() {
    const tip = this.tip;
    tip.style.setProperty('--info-shift', '0px');
    tip.classList.remove('info-tip-up');
    const vw = globalThis.document?.documentElement?.clientWidth || globalThis.innerWidth || 0;
    const vh = globalThis.document?.documentElement?.clientHeight || globalThis.innerHeight || 0;
    if (!vw || !vh) return;
    const r = tip.getBoundingClientRect();
    const margin = 8;
    let shift = 0;
    if (r.right > vw - margin) shift = vw - margin - r.right;
    if (r.left + shift < margin) shift = margin - r.left;
    tip.style.setProperty('--info-shift', `${Math.round(shift)}px`);
    if (r.bottom > vh - margin && r.top - r.height > margin) tip.classList.add('info-tip-up');
  }
}

/** Let one more control be described by a tip made earlier (a column header's tip and the row controls). */
export function describedBy(control, tip) {
  describe(control, tip.tip.id);
}

/** Add `id` to a control's aria-describedby (keeping what is there). */
function describe(control, id) {
  const ids = (control.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
  if (!ids.includes(id)) ids.push(id);
  control.setAttribute('aria-describedby', ids.join(' '));
}

/**
 * A "?" button with the help text of `key` (js/help.js).
 * @param {string} key
 * @param {{ label: string, describes?: Element | Element[], text?: string, className?: string }} o
 *   `label`: the option's name ("About <label>"); `describes`: the controls the text describes.
 * @returns {{ root: HTMLElement, button: HTMLButtonElement, tip: HTMLElement, close(): void, readonly isOpen: boolean }}
 */
export function infoTip(key, o) {
  return new InfoTip(key, o);
}

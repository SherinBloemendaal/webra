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

  /**
   * Keep the tip visible: shift it sideways and open it upwards near the
   * bottom, within the screen and within every ancestor that clips its
   * content (a scrolling settings panel cut the tip off at its edge).
   */
  place() {
    const tip = this.tip;
    tip.style.setProperty('--info-shift', '0px');
    tip.classList.remove('info-tip-up');
    const vw = globalThis.document?.documentElement?.clientWidth || globalThis.innerWidth || 0;
    const vh = globalThis.document?.documentElement?.clientHeight || globalThis.innerHeight || 0;
    if (!vw || !vh) return;
    const bounds = clipBounds(tip, { left: 0, top: 0, right: vw, bottom: vh });
    const { shift, up } = tipPlacement(tip.getBoundingClientRect(), bounds, TIP_MARGIN);
    tip.style.setProperty('--info-shift', `${shift}px`);
    if (up) tip.classList.add('info-tip-up');
  }
}

/** Gap kept between a tip and the edge of what shows it (CSS px). */
export const TIP_MARGIN = 8;

/**
 * The visible area for element `el`: the viewport `view` cut down to each
 * ancestor whose overflow clips (anything but visible), as {left, top,
 * right, bottom} in viewport px. `style` reads an element's computed style.
 */
export function clipBounds(el, view, style = (e) => globalThis.getComputedStyle?.(e)) {
  const b = { ...view };
  for (let p = el.parentElement; p; p = p.parentElement) {
    const cs = style(p);
    if (!cs) continue;
    const clipsX = cs.overflowX !== 'visible';
    const clipsY = cs.overflowY !== 'visible';
    if (!clipsX && !clipsY) continue;
    const r = p.getBoundingClientRect();
    if (clipsX) {
      b.left = Math.max(b.left, r.left);
      b.right = Math.min(b.right, r.right);
    }
    if (clipsY) {
      b.top = Math.max(b.top, r.top);
      b.bottom = Math.min(b.bottom, r.bottom);
    }
  }
  return b;
}

/**
 * Where a tip with rect `r` goes inside `bounds`: a whole-pixel sideways
 * `shift` that keeps it `margin` inside (the left edge wins when it is too
 * wide for both), and `up` when it runs past the bottom but fits above.
 */
export function tipPlacement(r, bounds, margin) {
  let shift = 0;
  if (r.right > bounds.right - margin) shift = bounds.right - margin - r.right;
  if (r.left + shift < bounds.left + margin) shift = bounds.left + margin - r.left;
  const up = r.bottom > bounds.bottom - margin && r.top - r.height > bounds.top + margin;
  return { shift: Math.round(shift), up };
}

/**
 * Put the "?" help of `key` beside a row's label (js/ui/controls.js rows):
 * the label is wrapped with the button in a span.ui-label-help (css/help.css)
 * that takes the label's place, unless it already sits in such a wrapper.
 * The tip describes `control`. Returns the row.
 */
export function labelWithHelp(row, key, control, label = row.querySelector('.ui-label')) {
  let name = label.parentNode;
  if (!name.classList.contains('ui-label-help') && !name.classList.contains('game-menu-name')) {
    name = document.createElement('span');
    name.className = 'game-menu-name ui-label-help';
    label.replaceWith(name);
    name.append(label);
  }
  name.append(infoTip(key, { label: label.textContent, describes: control }).root);
  return row;
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

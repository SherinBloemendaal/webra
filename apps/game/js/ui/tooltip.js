// Shared hover tooltip of the game's chrome, styled like OpenRA's Red Alert
// tooltips (mods/common/chrome/tooltips.yaml: a dark "dialog4" panel, the
// name in bold, the hotkey after it in yellow, a smaller description under
// it; production tooltips add cost, build time and power in a column on the
// right, see ProductionTooltipLogic.cs). Every icon-only button of the game
// uses it: the command bar, the sidebar's top row, tabs and cameos, the
// support powers, the HUD buttons and the lobby's icon buttons (css/tooltip.css).
//
//   const tip = attachTooltip(button, () => ({ title: 'Guard', hotkey: keyOf('guard'), desc: 'Click a unit to protect it.' }));
//   tip.refresh(); // the content changed while it shows (it is also built afresh every time it opens)
//   tip.detach();
//
// Behaviour:
// - Mouse: it opens after TOOLTIP_DELAY_MS over the target and closes when
//   the pointer leaves, the target is pressed or the page scrolls. Moving to
//   another tipped target while one shows, or right after (TOOLTIP_WARM_MS),
//   switches at once (like OpenRA). Under mouse capture (js/mouselock.js) the
//   virtual pointer's replayed pointerenter / leave / down drive it the same
//   way; the panel never takes the pointer and no listener here cancels or
//   stops a mouse event.
// - Keyboard: focus opens it at once, blur closes it, Esc closes it (the key
//   still reaches the game, so Esc also cancels modes or opens the menu).
// - Touch: a long press (LONG_PRESS_MS, finger held still) opens it and
//   swallows the click that follows, so reading a tooltip never presses the
//   button; it closes TOUCH_HOLD_MS after the finger lifts or on the next touch.
// - One panel for the whole page (role="tooltip"); while it shows for a
//   target, that target's aria-describedby points at it. Targets keep their
//   own aria-label (the short name), which stays when the tip is closed.
// - Placed beside the target on the side `side` asks for, flipped and clamped
//   so it is never clipped by the viewport (`placeTooltip`).
//
// DOM through createElement and textContent only (strict CSP); the position
// is set through CSSOM properties.

import { icon } from '../ui-icons.js';

/** Hover time before a tooltip opens (OpenRA's TooltipContainer waits a moment too). */
export const TOOLTIP_DELAY_MS = 350;
/** After a hover tooltip closes, the next target hovered this soon opens at once (moving along a bar). */
export const TOOLTIP_WARM_MS = 300;
/** Touch: how long a finger must rest on a target to open its tooltip. */
export const LONG_PRESS_MS = 500;
/** Touch: how long a long-press tooltip stays after the finger lifts. */
export const TOUCH_HOLD_MS = 2500;
/** A finger moving further than this (CSS px) is not a long press. */
export const LONG_PRESS_SLOP = 10;
/** Distance from the target, and the least room kept to the viewport edges (CSS px). */
export const TOOLTIP_GAP = 6;
export const TOOLTIP_MARGIN = 6;

const TIP_ID = 'ui-tooltip';
const SIDES = ['top', 'bottom', 'left', 'right'];
const OPPOSITE = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

/**
 * Where a tooltip of `size` goes next to the `anchor` rectangle inside a
 * `viewport` (all CSS px): on `side` when it fits there, else on the
 * opposite side, else on whichever side has the most room; then slid along
 * that side and clamped so no part of it is outside the viewport.
 * @param {{ left: number, top: number, right: number, bottom: number }} anchor
 * @param {{ width: number, height: number }} size
 * @param {{ width: number, height: number }} viewport
 * @param {'top' | 'bottom' | 'left' | 'right'} side
 * @returns {{ x: number, y: number, side: string }}
 */
export function placeTooltip(anchor, size, viewport, side = 'top', gap = TOOLTIP_GAP, margin = TOOLTIP_MARGIN) {
  const room = {
    top: anchor.top - gap - margin,
    bottom: viewport.height - anchor.bottom - gap - margin,
    left: anchor.left - gap - margin,
    right: viewport.width - anchor.right - gap - margin,
  };
  const need = (s) => (s === 'top' || s === 'bottom' ? size.height : size.width);
  const preferred = SIDES.includes(side) ? side : 'top';
  let pick = [preferred, OPPOSITE[preferred]].find((s) => room[s] >= need(s));
  if (!pick) pick = SIDES.reduce((best, s) => (room[s] - need(s) > room[best] - need(best) ? s : best), preferred);
  let x;
  let y;
  if (pick === 'top' || pick === 'bottom') {
    x = (anchor.left + anchor.right) / 2 - size.width / 2;
    y = pick === 'top' ? anchor.top - gap - size.height : anchor.bottom + gap;
  } else {
    x = pick === 'left' ? anchor.left - gap - size.width : anchor.right + gap;
    y = (anchor.top + anchor.bottom) / 2 - size.height / 2;
  }
  const clamp = (v, extent, total) => Math.max(margin, Math.min(v, total - margin - extent));
  return { x: Math.round(clamp(x, size.width, viewport.width)), y: Math.round(clamp(y, size.height, viewport.height)), side: pick };
}

/**
 * The text a screen reader or a test reads from a tooltip spec, one line per part.
 * @param {TooltipSpec} spec
 */
export function tooltipText(spec) {
  if (!spec) return '';
  const lines = [spec.hotkey ? `${spec.title} (${spec.hotkey})` : spec.title];
  if (spec.requires) lines.push(spec.requires);
  if (spec.tip) lines.push(spec.tip);
  for (const s of spec.stats ?? []) lines.push(`${s.label}: ${s.text}`);
  if (spec.desc) lines.push(spec.desc);
  for (const n of spec.notes ?? []) lines.push(n.text);
  return lines.filter(Boolean).join('\n');
}

/**
 * @typedef {object} TooltipSpec
 * @property {string} title the name, in bold
 * @property {string | null} [hotkey] the bound key ("D", "Ctrl+X"), shown in yellow after the name
 * @property {string} [requires] small line under the name (production prerequisites)
 * @property {string} [tip] the quick tip: one line on what it does (js/quicktips.js), under the name
 * @property {string} [desc] the description
 * @property {{ kind: 'cost' | 'time' | 'power', label: string, text: string, bad?: boolean }[]} [stats]
 *   the right column of production tooltips, red when `bad` (cannot afford, low power)
 * @property {{ text: string, tone?: 'warn' | 'hint' }[]} [notes] extra lines under the description
 */

const STAT_ICONS = { cost: 'sell', time: 'time', power: 'power' };

function el(doc, tag, className, text) {
  const e = doc.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Fill the panel from a spec (a fresh subtree each time: tooltips are small). */
function render(doc, panel, spec) {
  const main = el(doc, 'div', 'ui-tooltip-main');
  const head = el(doc, 'div', 'ui-tooltip-head');
  head.append(el(doc, 'span', 'ui-tooltip-title', spec.title));
  if (spec.hotkey) head.append(el(doc, 'span', 'ui-tooltip-key', `(${spec.hotkey})`));
  main.append(head);
  if (spec.requires) main.append(el(doc, 'div', 'ui-tooltip-requires', spec.requires));
  if (spec.tip) main.append(el(doc, 'div', 'ui-tooltip-quick', spec.tip));
  if (spec.desc) main.append(el(doc, 'div', 'ui-tooltip-desc', spec.desc));
  for (const n of spec.notes ?? []) main.append(el(doc, 'div', `ui-tooltip-note ui-tooltip-${n.tone ?? 'hint'}`, n.text));
  const parts = [main];
  if (spec.stats?.length) {
    const stats = el(doc, 'div', 'ui-tooltip-stats');
    for (const s of spec.stats) {
      const row = el(doc, 'div', `ui-tooltip-stat ui-tooltip-stat-${s.kind}${s.bad ? ' ui-tooltip-bad' : ''}`);
      row.append(icon(STAT_ICONS[s.kind] ?? 'power', doc));
      const value = el(doc, 'span', 'ui-tooltip-stat-value', s.text);
      row.append(value, el(doc, 'span', 'ui-sr-only', ` ${s.label}`));
      stats.append(row);
    }
    parts.push(stats);
  }
  panel.replaceChildren(...parts);
  panel.classList.toggle('ui-tooltip-wide', !!spec.stats?.length);
}

/** Add or remove `id` in an element's aria-describedby, keeping the others. */
function describedBy(target, id, on) {
  const ids = (target.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
  const has = ids.includes(id);
  if (on === has) return;
  const next = on ? [...ids, id] : ids.filter((x) => x !== id);
  if (next.length) target.setAttribute('aria-describedby', next.join(' '));
  else target.removeAttribute('aria-describedby');
}

/** The one tooltip panel of a document and what it shows. */
class TooltipLayer {
  constructor(doc) {
    this.doc = doc;
    this.panel = null;
    /** The attachment showing, or null. */
    this.current = null;
    /** Pending open: { tip, timer }. */
    this.pending = null;
    this.hideTimer = 0;
    /** A hover tooltip closed a moment ago: { tip, timer } until TOOLTIP_WARM_MS passed. */
    this.warm = null;
    doc.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.hide();
    }, true);
    // A press anywhere (mouse or touch) closes it, except a touch on the
    // target whose long press opened it (that one may open it again).
    doc.addEventListener('pointerdown', (e) => {
      if (this.current && !this.current.target.contains?.(e.target)) this.hide();
    }, true);
    globalThis.window?.addEventListener?.('scroll', () => this.hide(), true);
    globalThis.window?.addEventListener?.('blur', () => this.hide());
  }

  ensurePanel() {
    if (this.panel) return this.panel;
    const p = el(this.doc, 'div', 'ui-tooltip');
    p.id = TIP_ID;
    p.setAttribute('role', 'tooltip');
    p.hidden = true;
    this.doc.body.append(p);
    this.panel = p;
    return p;
  }

  /** Open `tip` after the hover delay (at once when another tooltip is showing). */
  schedule(tip, delay = TOOLTIP_DELAY_MS) {
    this.cancelPending();
    if ((this.current && this.current !== tip) || this.warm) delay = 0;
    if (delay <= 0) {
      this.show(tip);
      return;
    }
    const timer = tip.setTimer(() => {
      this.pending = null;
      this.show(tip);
    }, delay);
    this.pending = { tip, timer };
  }

  cancelPending(tip = null) {
    if (!this.pending || (tip && this.pending.tip !== tip)) return;
    this.pending.tip.clearTimer(this.pending.timer);
    this.pending = null;
  }

  show(tip) {
    this.cancelPending();
    this.cancelHide();
    const spec = tip.spec();
    // Nothing to say, or the target left the page meanwhile.
    if (!spec || !spec.title || !tip.target.isConnected) {
      if (this.current === tip) this.hide();
      return;
    }
    if (this.current && this.current !== tip) this.hide();
    const panel = this.ensurePanel();
    render(this.doc, panel, spec);
    panel.hidden = false;
    this.current = tip;
    this.spec = spec;
    describedBy(tip.target, TIP_ID, true);
    this.place();
  }

  /** Close the tooltip of `tip` (any tooltip without one). */
  hide(tip = null) {
    this.cancelPending(tip);
    if (!this.current || (tip && this.current !== tip)) return;
    this.cancelHide();
    describedBy(this.current.target, TIP_ID, false);
    this.current = null;
    this.spec = null;
    if (this.panel) this.panel.hidden = true;
  }

  /** The pointer left `tip`'s target: close it, and open the next one hovered soon without a delay. */
  leave(tip) {
    const was = this.current === tip;
    this.hide(tip);
    if (!was) return;
    if (this.warm) this.warm.tip.clearTimer(this.warm.timer);
    const timer = tip.setTimer(() => {
      this.warm = null;
    }, TOOLTIP_WARM_MS);
    this.warm = { tip, timer };
  }

  /** Close after `ms` (a touch tooltip after the finger lifts). */
  hideLater(tip, ms) {
    this.cancelHide();
    this.hideTimer = tip.setTimer(() => {
      this.hideTimer = 0;
      this.hide(tip);
    }, ms);
    this.hideOwner = tip;
  }

  cancelHide() {
    if (!this.hideTimer) return;
    this.hideOwner.clearTimer(this.hideTimer);
    this.hideTimer = 0;
  }

  /** Re-render the open tooltip (its content changed: cash, a rebound key, a charge timer). */
  refresh(tip = null) {
    if (!this.current || (tip && this.current !== tip)) return;
    // The target left the page (a sidebar tab switched its cameos away): no pointerleave comes.
    const spec = this.current.target.isConnected ? this.current.spec() : null;
    if (!spec || !spec.title) {
      this.hide();
      return;
    }
    if (tooltipText(spec) === tooltipText(this.spec) && spec.stats?.map((s) => s.bad).join() === this.spec.stats?.map((s) => s.bad).join()) return;
    this.spec = spec;
    render(this.doc, this.panel, spec);
    this.place();
  }

  place() {
    const tip = this.current;
    const panel = this.panel;
    if (!tip || !panel) return;
    const win = globalThis.window ?? {};
    const vw = this.doc.documentElement?.clientWidth || win.innerWidth || 0;
    const vh = this.doc.documentElement?.clientHeight || win.innerHeight || 0;
    // Measured at the top left corner, so its natural size is not squeezed by the edge.
    panel.style.left = '0px';
    panel.style.top = '0px';
    const box = panel.getBoundingClientRect?.() ?? { width: 0, height: 0 };
    const at = placeTooltip(tip.target.getBoundingClientRect(), { width: box.width, height: box.height }, { width: vw, height: vh }, tip.side);
    panel.style.left = `${at.x}px`;
    panel.style.top = `${at.y}px`;
    panel.dataset.side = at.side;
  }
}

const layers = new WeakMap();

function layerOf(doc) {
  let layer = layers.get(doc);
  if (!layer) {
    layer = new TooltipLayer(doc);
    layers.set(doc, layer);
  }
  return layer;
}

/** The tooltip showing in `doc`: { target, spec, text } or null (tests, Esc handlers). */
export function openTooltip(doc = globalThis.document) {
  const layer = layers.get(doc);
  if (!layer?.current) return null;
  return { target: layer.current.target, spec: layer.spec, text: tooltipText(layer.spec), panel: layer.panel };
}

/** Close the tooltip showing in `doc`, if any (the game menu opened). */
export function hideTooltip(doc = globalThis.document) {
  layers.get(doc)?.hide();
}

/** Re-render the tooltip showing in `doc` from its content function (state changed). */
export function refreshTooltip(doc = globalThis.document) {
  layers.get(doc)?.refresh();
}

class Attachment {
  constructor(target, content, { side = 'top', setTimer, clearTimer } = {}) {
    this.target = target;
    this.content = content;
    this.side = side;
    this.setTimer = setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = clearTimer ?? ((t) => clearTimeout(t));
    this.layer = layerOf(target.ownerDocument ?? globalThis.document);
    this.press = null; // touch: { x, y, timer }
    this.pressing = false; // a pointer is down on the target (its focus is not keyboard focus)
    this.swallowClick = false;
    this.longPressed = false;
    this.listeners = [];
    const on = (type, fn, opts) => {
      target.addEventListener(type, fn, opts);
      this.listeners.push([type, fn, opts]);
    };
    target.classList.add('has-tooltip');
    on('pointerenter', (e) => {
      if (e.pointerType && e.pointerType !== 'mouse') return;
      this.layer.schedule(this);
    });
    on('pointerleave', (e) => {
      this.pressing = false;
      if (e.pointerType && e.pointerType !== 'mouse') return;
      this.layer.leave(this);
    });
    on('pointerdown', (e) => this.onPointerDown(e));
    on('pointermove', (e) => {
      if (this.press && Math.hypot(e.clientX - this.press.x, e.clientY - this.press.y) > LONG_PRESS_SLOP) this.endPress();
    });
    on('pointerup', () => this.endPress(true));
    on('pointercancel', () => this.endPress(true));
    on('focus', () => {
      // Keyboard focus: at once. The focus a mouse press or a tap gives is
      // not keyboard navigation (hover and long press handle those).
      if (this.pressing) return;
      this.layer.show(this);
    });
    on('blur', () => {
      this.pressing = false;
      this.layer.hide(this);
    });
    // The click a long press ends with must not press the button.
    on(
      'click',
      (e) => {
        if (!this.swallowClick) return;
        this.swallowClick = false;
        e.preventDefault();
        e.stopImmediatePropagation?.();
        e.stopPropagation();
      },
      true,
    );
    on('contextmenu', (e) => {
      // Touch browsers fire contextmenu on a long press; the tooltip is the long press here.
      if (this.longPressed) e.preventDefault();
    });
  }

  spec() {
    return this.content();
  }

  onPointerDown(e) {
    this.swallowClick = false;
    this.longPressed = false;
    this.pressing = true;
    if (!e.pointerType || e.pointerType === 'mouse') {
      // Pressing the button closes its tooltip, like OpenRA.
      this.layer.hide(this);
      return;
    }
    this.endPress();
    const press = { x: e.clientX, y: e.clientY, timer: 0 };
    press.timer = this.setTimer(() => {
      press.timer = 0;
      this.longPressed = true;
      this.swallowClick = true;
      globalThis.navigator?.vibrate?.(10);
      this.layer.show(this);
    }, LONG_PRESS_MS);
    this.press = press;
  }

  /** The finger lifted, moved away or was cancelled. */
  endPress(lifted = false) {
    if (lifted) this.pressing = false;
    if (this.press?.timer) this.clearTimer(this.press.timer);
    this.press = null;
    if (lifted && this.longPressed && this.layer.current === this) this.layer.hideLater(this, TOUCH_HOLD_MS);
  }

  refresh() {
    this.layer.refresh(this);
  }

  detach() {
    this.endPress();
    this.layer.hide(this);
    for (const [type, fn, opts] of this.listeners) this.target.removeEventListener(type, fn, opts);
    this.listeners = [];
    this.target.classList.remove('has-tooltip');
  }
}

/**
 * Give `target` the shared tooltip.
 * @param {HTMLElement} target
 * @param {() => TooltipSpec | null} content called whenever the tooltip opens or refreshes
 * @param {{ side?: 'top' | 'bottom' | 'left' | 'right', setTimer?: Function, clearTimer?: Function }} [options]
 *   `side`: where it goes when there is room; the timer functions are for tests
 * @returns {{ refresh(): void, detach(): void }}
 */
export function attachTooltip(target, content, options = {}) {
  const a = new Attachment(target, content, options);
  return { refresh: () => a.refresh(), detach: () => a.detach(), target };
}

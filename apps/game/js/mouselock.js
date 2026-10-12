// Mouse capture, like desktop OpenRA's locked cursor: on a multi-monitor
// setup the pointer cannot slip off the game onto another screen.
//
// Through the Pointer Lock API (requestPointerLock; unadjustedMovement only
// for Settings > Raw mouse input). While the lock holds, the browser hides the OS
// cursor and reports only movement, so the game keeps a virtual pointer of
// its own: moved by movementX / movementY, clamped to the window, drawn with
// the cursor art the page asks for at that spot (js/cursors.js on the
// battlefield: move, attack, sell, repair, deploy, blocked, the edge scroll
// arrows; the arrow elsewhere).
//
// Why real-looking DOM events rather than calls into js/input.js: the
// battlefield is one of many listeners. The sidebar, minimap, command bar,
// power bar, debug menu, chat line, the "?" tips and the hover tooltips all
// listen to pointer and mouse events on their own elements. So every real
// mouse event is stopped at the window (capture phase) and replayed at the
// virtual position on `document.elementFromPoint`: pointerover / out /
// enter / leave and their mouse twins, pointermove + mousemove,
// pointerdown + mousedown, pointerup + mouseup, click, dblclick, auxclick,
// contextmenu and wheel, with the real buttons and modifier keys. What the
// browser would do by default for real events and does not do for replayed
// ones is done here: focus for text fields, wheel scrolling of scrollable
// panels, :hover and :active styles (mirrored as [data-vhover] and
// [data-vactive], see mirrorPointerStates) and pointer capture
// (setPointerCapture on the virtual pointer, which pointer lock forbids for
// the real one). Controls that need the OS cursor (a <select> list, sliders,
// file and colour pickers) release the lock instead.
//
// When it engages: Settings > Capture the mouse is 'fullscreen' (default:
// entering fullscreen, or a click into the game while fullscreen) or
// 'always' (any click into the game), and the capture hotkey (Alt+M, Option+M
// on macOS; js/gamekeys.js) turns it on and off by hand. It lets go for the
// game menu and other dialogs, when the window loses focus or the page is
// hidden, on leaving fullscreen, for a touch on the screen, and on Esc: the
// first Esc only releases the mouse, the next one opens the menu as before
// (unless Settings > "Esc also opens the menu" is on). A click into the game
// captures it again. Browsers refuse a new lock for about a second after the
// player pressed Esc; clicks in that time just act.
//
// Speed (movementFactor): by default the lock is the plain one, and
// movementX / movementY are the OS cursor's own movement in CSS px, with the
// system's pointer speed and acceleration, so at Captured mouse speed 1x the
// game cursor goes exactly where the OS cursor would. Settings > Raw mouse
// input asks for unadjusted movement instead: raw mouse counts without the
// system's acceleration (mouse counts, not device pixels: never divided by
// devicePixelRatio). Without any acceleration a flick then travels 2 to 4
// times less far than the OS cursor, so raw movement gets a curve of its own
// (rawGain): one CSS px per count while the mouse moves slowly, rising
// smoothly with the speed to RAW_ACCEL.maxGain for fast flicks. Raw is used
// only where the browser really gives it (requestRawLock: a returned promise
// alone does not say so). Both are times the Captured mouse speed setting.
// UI scale and game scale do not change it: they size the chrome and the
// battlefield, not CSS pixels, just as they do not change the speed of the OS
// cursor.
//
// No Pointer Lock (iOS Safari, phones, tablets without a mouse): nothing is
// set up (pointerLockAvailable), the setting is hidden and touch input is
// never touched.

import { CURSORS } from './cursors.js';
import { formatCombo, isMac } from './hotkeys.js';

/** The values of the mouseCapture setting (js/registry.js). */
export const CAPTURE_MODES = Object.freeze(['off', 'fullscreen', 'always']);
/** The hotkey action that captures and releases the mouse (js/gamekeys.js). */
export const CAPTURE_ACTION = 'toggleMouseCapture';
/** pointerId of the virtual pointer's events (the mouse's id in Chromium). */
export const VIRTUAL_POINTER_ID = 1;
/** After the player let go with Esc, browsers refuse a new lock for about a second. */
export const RELOCK_COOLDOWN_MS = 1100;
/** An Esc keydown this soon after the browser let go was the key that let go. */
export const ESC_GUARD_MS = 250;
/** The "Mouse captured" hint shows the first few times only. */
export const HINT_LIMIT = 3;
/**
 * The first movement after locking is dropped only when it jumps more than
 * this far (CSS px or counts): Chromium can report the distance to where the
 * OS cursor was then, while a real first move is small and is kept.
 */
export const FIRST_MOVE_JUMP = 100;
const DOUBLE_CLICK_MS = 500;
const DOUBLE_CLICK_SLOP = 4; // px
const LINE_PX = 16; // a wheel "line" (deltaMode 1)

/** Real events stopped at the window while the lock holds (the virtual pointer replays them). */
const MOUSE_EVENTS = Object.freeze([
  'mousemove',
  'mousedown',
  'mouseup',
  'click',
  'dblclick',
  'auxclick',
  'contextmenu',
  'wheel',
  'mouseover',
  'mouseout',
  'mouseenter',
  'mouseleave',
  'pointermove',
  'pointerdown',
  'pointerup',
  'pointerover',
  'pointerout',
  'pointerenter',
  'pointerleave',
  'gotpointercapture',
  'lostpointercapture',
  'dragstart',
  'selectstart',
]);
/** Their default actions are held back too (context menu, page scroll, text selection, focus). */
const PREVENT = new Set(['mousedown', 'contextmenu', 'wheel', 'dragstart', 'selectstart']);

/** Controls that only work with the OS cursor: picking one releases the lock. */
const REAL_CURSOR =
  'select, input[type="range"], input[type="color"], input[type="file"], input[type="date"], input[type="datetime-local"], input[type="month"], input[type="time"], input[type="week"], [data-real-cursor]';
/** Input types that take no typing. */
const NOT_TEXT = new Set(['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'color', 'file', 'image', 'hidden']);

/** A text field (input, textarea, contenteditable) at or around `el`, or null. */
export function textField(el) {
  const f = el?.closest?.('input, textarea, [contenteditable]');
  if (!f) return null;
  if (f.localName === 'input' && NOT_TEXT.has(String(f.getAttribute('type') ?? 'text').toLowerCase())) return null;
  if (f.localName !== 'input' && f.localName !== 'textarea' && f.getAttribute('contenteditable') === 'false') return null;
  return f;
}

/** The control at or around `el` that needs the OS cursor (REAL_CURSOR), or null. */
export function realCursorControl(el) {
  return el?.closest?.(REAL_CURSOR) ?? null;
}

/**
 * Whether this page can capture the mouse: the Pointer Lock API exists and
 * there is a mouse or touchpad (any fine pointer). False on iOS Safari and
 * on touch-only devices.
 */
export function pointerLockAvailable(doc = globalThis.document, win = globalThis.window) {
  const root = doc?.documentElement;
  if (!root || typeof root.requestPointerLock !== 'function' || typeof doc.exitPointerLock !== 'function') return false;
  if (!('pointerLockElement' in doc)) return false;
  const fine = win?.matchMedia?.('(any-pointer: fine)');
  return fine ? !!fine.matches : true;
}

/**
 * The acceleration curve of raw movement (rawGain). The gain is a smooth
 * step in the mouse's speed v (counts per ms):
 *
 *   gain(v) = 1 + (maxGain - 1) * k / (1 + k),   k = (v / halfSpeed) ^ power
 *
 * 1 at rest (one CSS px per count: slow, precise moves are not scaled), half
 * way (2) at halfSpeed, and never above maxGain. It rises with the speed and
 * nothing else, so a move that is faster goes further, and the curve is the
 * same whatever the mouse's polling rate (the speed is counts per time, not
 * per event). Numbers for a 1000 CPI mouse (1 count/ms = 1 inch/s): a slow
 * aim at 0.5 count/ms gets 1.1, a quick move at 2 counts/ms 2, a flick at 6
 * counts/ms 2.8. The speed comes from the time between two moves (dtMs),
 * kept within minMs..maxMs; a first move or one after a pause counts as
 * nominalMs (a 125 Hz mouse).
 */
export const RAW_ACCEL = Object.freeze({ maxGain: 3, halfSpeed: 2, power: 2, minMs: 1, maxMs: 50, nominalMs: 8 });

/** The raw movement gain at a mouse speed of `countsPerMs` (RAW_ACCEL): from 1 up to maxGain. */
export function rawGain(countsPerMs) {
  const v = Number.isFinite(countsPerMs) && countsPerMs > 0 ? countsPerMs : 0;
  const k = (v / RAW_ACCEL.halfSpeed) ** RAW_ACCEL.power;
  return 1 + ((RAW_ACCEL.maxGain - 1) * k) / (1 + k);
}

/** The time (ms) a move took, for the raw speed: within RAW_ACCEL's limits, nominalMs when unknown or after a pause. */
export function moveDuration(dtMs) {
  if (!Number.isFinite(dtMs) || dtMs > RAW_ACCEL.maxMs) return RAW_ACCEL.nominalMs;
  return Math.max(RAW_ACCEL.minMs, dtMs);
}

/**
 * CSS px of virtual pointer movement per unit of movementX / movementY:
 * the speed setting, and for raw movement times rawGain at the move's speed
 * (`distance` counts in `dtMs`). The device pixel ratio plays no part:
 * accelerated movement is CSS px already, and raw counts are the mouse's.
 */
export function movementFactor({ speed = 1, raw = false, distance = 0, dtMs = RAW_ACCEL.nominalMs } = {}) {
  const s = Number.isFinite(speed) && speed > 0 ? speed : 1;
  if (!raw) return s;
  const d = Number.isFinite(distance) ? Math.abs(distance) : 0;
  return s * rawGain(d / moveDuration(dtMs));
}

/**
 * Ask `el` for a lock with unadjusted (raw) movement. Returns { result, raw }:
 * what requestPointerLock returned (a promise in Chromium and newer browsers,
 * else undefined), and whether the browser took the option. A returned
 * promise is no proof: Firefox returns one and ignores the option. So the
 * option is a getter, and raw counts only when the browser read it while it
 * took the request (the WebIDL dictionary conversion reads every member it
 * knows); a browser that reads it and cannot give raw movement rejects with
 * NotSupportedError, which the caller handles. Throws what the call throws.
 */
export function requestRawLock(el) {
  let read = false;
  const options = {
    get unadjustedMovement() {
      read = true;
      return true;
    },
  };
  const result = el.requestPointerLock(options);
  return { result, raw: read };
}

/** A point kept inside a w x h view (the last pixel row and column included). */
export function clampToView(x, y, w, h) {
  return { x: Math.min(Math.max(x, 0), Math.max(0, w - 1)), y: Math.min(Math.max(y, 0), Math.max(0, h - 1)) };
}

/**
 * A CSS cursor value split up: { src, x, y } for its first url() image with
 * its hotspot (0 0 when it has none), else { keyword } (its last keyword).
 */
export function parseCursor(value) {
  const v = String(value ?? '').trim();
  const m = /url\(\s*(["']?)(.*?)\1\s*\)\s*(-?\d+(?:\.\d+)?)?\s*(-?\d+(?:\.\d+)?)?/.exec(v);
  if (m && m[2]) return { src: m[2], x: Number(m[3] ?? 0), y: Number(m[4] ?? 0) };
  const words = v.split(',').map((w) => w.trim()).filter(Boolean);
  return { keyword: words.at(-1) ?? 'auto' };
}

/** I-beam over text fields (no art in js/cursors.js: the battlefield never shows it). */
const TEXT_CURSOR = (() => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">' +
    '<path d="M12 6 L20 6 M16 6 L16 26 M12 26 L20 26" fill="none" stroke="#101010" stroke-width="4" stroke-linecap="round"/>' +
    '<path d="M12 6 L20 6 M16 6 L16 26 M12 26 L20 26" fill="none" stroke="#f0f0f0" stroke-width="1.8" stroke-linecap="round"/></svg>';
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 16 16, text`;
})();

/** Art for cursor keywords: the game's arrow for everything but these. */
const KEYWORD_ART = {
  text: TEXT_CURSOR,
  'vertical-text': TEXT_CURSOR,
  // Read when used: the original cursors may have replaced it (cursors.js setCursorArt).
  get 'not-allowed'() {
    return CURSORS.blocked;
  },
  get 'no-drop'() {
    return CURSORS.blocked;
  },
};

/** What to draw for a CSS cursor value: { src, x, y }, or null for none (the cursor is hidden). */
export function cursorArt(value) {
  const c = parseCursor(value);
  if (c.src) return c;
  if (c.keyword === 'none') return null;
  return parseCursor(KEYWORD_ART[c.keyword] ?? CURSORS.select);
}

/** "Mouse captured. Option+M or Esc to release." with the capture hotkey's key (none: Esc only). */
export function hintText(combo, mac = isMac()) {
  return `Mouse captured. ${combo ? `${formatCombo(combo, mac)} or ` : ''}Esc to release.`;
}

/** `el` and its ancestor elements, innermost first. */
function chain(el) {
  const out = [];
  for (let n = el; n && n.nodeType === 1; n = n.parentNode) out.push(n);
  return out;
}

/** The innermost element that holds both `a` and `b`. */
function commonAncestor(a, b) {
  for (const n of chain(a)) if (n.contains?.(b)) return n;
  return null;
}

const BUTTON_BITS = [1, 4, 2, 8, 16]; // MouseEvent.button -> MouseEvent.buttons bit

/** Events made with the page's own constructors (PointerEvent, WheelEvent, MouseEvent). */
export function domEvents(win = globalThis.window) {
  return (type, init) => {
    const Ctor =
      type === 'wheel'
        ? win.WheelEvent
        : type.startsWith('pointer') || type.endsWith('pointercapture')
          ? (win.PointerEvent ?? win.MouseEvent)
          : win.MouseEvent;
    return new Ctor(type, init);
  };
}

/**
 * The pointer the game moves while the mouse is captured: its position, the
 * element under it, its buttons, and the events a real mouse there would
 * fire. `makeEvent(type, init)` builds the events (domEvents in the page).
 */
export class VirtualPointer {
  constructor({ doc = globalThis.document, win = globalThis.window, makeEvent = domEvents(win), now = () => performance.now() } = {}) {
    this.doc = doc;
    this.win = win;
    this.makeEvent = makeEvent;
    this.now = now;
    this.x = 0;
    this.y = 0;
    this.buttons = 0;
    this.mods = { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false };
    /** Element under the pointer (hover state, cursor art). */
    this.hovered = null;
    /** Element that captured the pointer (setPointerCapture), or null. */
    this.captured = null;
    /** Where each button went down: its click goes to what holds that and the release spot. */
    this.pressed = new Map();
    /** pointerdown was cancelled: no mouse events until every button is up (as for real pointers). */
    this.mouseSuppressed = false;
    this.lastClick = { time: -Infinity, x: 0, y: 0, button: -1, count: 0 };
    this.clickCount = 1;
  }

  /** Element at the pointer. */
  hit() {
    return this.doc.elementFromPoint?.(this.x, this.y) ?? this.doc.documentElement;
  }

  /** Where pointer and mouse events go: the capturing element, else what is under the pointer. */
  target() {
    return this.captured ?? this.hit();
  }

  setMods(mods) {
    if (!mods) return;
    for (const k of ['ctrlKey', 'shiftKey', 'altKey', 'metaKey']) this.mods[k] = !!mods[k];
  }

  init(extra = {}) {
    return {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: this.win ?? null,
      clientX: this.x,
      clientY: this.y,
      screenX: this.x + (this.win?.screenX ?? 0),
      screenY: this.y + (this.win?.screenY ?? 0),
      button: 0,
      buttons: this.buttons,
      ...this.mods,
      ...extra,
    };
  }

  /** Dispatch `type` at `el`; returns the event. Pointer events get the pointer fields. */
  fire(el, type, extra = {}) {
    const pointer = type.startsWith('pointer') || type.endsWith('pointercapture');
    // Pointer events that change no button carry button -1, like the browser's.
    const init = this.init(
      pointer
        ? { pointerId: VIRTUAL_POINTER_ID, pointerType: 'mouse', isPrimary: true, width: 1, height: 1, pressure: this.buttons ? 0.5 : 0, button: -1, ...extra }
        : extra,
    );
    const e = this.makeEvent(type, init);
    el.dispatchEvent(e);
    return e;
  }

  /** Start at (x, y); `held` hands over buttons that went down before the lock (their element too). */
  place(x, y, mods, held = null) {
    this.x = x;
    this.y = y;
    this.setMods(mods);
    if (held?.buttons) {
      this.buttons = held.buttons;
      const at = held.target ?? this.hit();
      BUTTON_BITS.forEach((bit, button) => held.buttons & bit && this.pressed.set(button, at));
    }
    this.updateHover();
  }

  /** Move by (dx, dy) CSS px, kept inside the w x h view. */
  moveBy(dx, dy, w, h, mods) {
    this.setMods(mods);
    const p = clampToView(this.x + dx, this.y + dy, w, h);
    const mx = p.x - this.x;
    const my = p.y - this.y;
    this.x = p.x;
    this.y = p.y;
    this.updateHover();
    const at = this.target();
    this.fire(at, 'pointermove', { movementX: mx, movementY: my });
    if (!this.mouseSuppressed) this.fire(at, 'mousemove', { movementX: mx, movementY: my });
  }

  /** Keep the pointer inside a view that changed size. */
  clamp(w, h) {
    const p = clampToView(this.x, this.y, w, h);
    this.x = p.x;
    this.y = p.y;
  }

  /**
   * Hover follows what is under the pointer (also when the page moved under
   * a still pointer): out / leave on what it left, over / enter on what it
   * reached, and the [data-vhover] marks that stand in for :hover.
   */
  updateHover() {
    const next = this.captured ?? this.hit();
    const prev = this.hovered;
    if (next === prev) return;
    this.hovered = next;
    const left = prev ? chain(prev).filter((n) => !n.contains?.(next)) : [];
    const entered = next ? chain(next).filter((n) => !prev || !n.contains?.(prev)) : [];
    if (prev && prev.isConnected !== false) {
      this.fire(prev, 'pointerout', { relatedTarget: next });
      for (const n of left) this.fire(n, 'pointerleave', { bubbles: false, cancelable: false, relatedTarget: next });
      this.fire(prev, 'mouseout', { relatedTarget: next });
      for (const n of left) this.fire(n, 'mouseleave', { bubbles: false, cancelable: false, relatedTarget: next });
    }
    for (const n of left) n.removeAttribute?.('data-vhover');
    if (next) {
      this.fire(next, 'pointerover', { relatedTarget: prev });
      for (const n of [...entered].reverse()) this.fire(n, 'pointerenter', { bubbles: false, cancelable: false, relatedTarget: prev });
      this.fire(next, 'mouseover', { relatedTarget: prev });
      for (const n of [...entered].reverse()) this.fire(n, 'mouseenter', { bubbles: false, cancelable: false, relatedTarget: prev });
      for (const n of entered) n.setAttribute?.('data-vhover', '');
    }
  }

  /**
   * A button went down. Returns the control that needs the OS cursor when
   * the press landed on one (nothing is dispatched then), else null.
   */
  down(button, mods) {
    this.setMods(mods);
    const at = this.target();
    const real = realCursorControl(at);
    if (real && !this.buttons) return real;
    const bit = BUTTON_BITS[button] ?? 0;
    const first = this.buttons === 0;
    this.buttons |= bit;
    // A second button while one is held is a pointermove (chorded buttons), as for real pointers.
    if (first) {
      this.mouseSuppressed = false;
      const pd = this.fire(at, 'pointerdown', { button });
      if (pd.defaultPrevented) this.mouseSuppressed = true;
    } else this.fire(at, 'pointermove', { button });
    const now = this.now();
    const c = this.lastClick;
    this.clickCount =
      button === c.button && now - c.time <= DOUBLE_CLICK_MS && Math.abs(this.x - c.x) <= DOUBLE_CLICK_SLOP && Math.abs(this.y - c.y) <= DOUBLE_CLICK_SLOP
        ? c.count + 1
        : 1;
    this.lastClick = { time: now, x: this.x, y: this.y, button, count: this.clickCount };
    this.pressed.set(button, at);
    if (button === 0) for (const n of chain(at)) n.setAttribute?.('data-vactive', '');
    if (!this.mouseSuppressed) {
      const md = this.fire(at, 'mousedown', { button, detail: this.clickCount });
      if (!md.defaultPrevented) this.focusFor(at);
      // macOS and Linux open the context menu on the press (js/input.js acts on mousedown either way).
      if (button === 2) this.fire(at, 'contextmenu', { button, detail: this.clickCount });
    }
    return null;
  }

  /** A button went up: up events, then click / auxclick / dblclick where it went down and came up. */
  up(button, mods, { click = true } = {}) {
    this.setMods(mods);
    const bit = BUTTON_BITS[button] ?? 0;
    if (!(this.buttons & bit)) return;
    this.buttons &= ~bit;
    const at = this.target();
    if (this.buttons === 0) this.fire(at, 'pointerup', { button });
    else this.fire(at, 'pointermove', { button });
    if (!this.mouseSuppressed) this.fire(at, 'mouseup', { button, detail: this.clickCount });
    const from = this.pressed.get(button);
    this.pressed.delete(button);
    if (button === 0) for (const n of this.doc.querySelectorAll?.('[data-vactive]') ?? []) n.removeAttribute('data-vactive');
    const into = click && from ? commonAncestor(from, at) : null;
    if (into) {
      if (button === 0) {
        this.fire(into, 'click', { button, detail: this.clickCount });
        if (this.clickCount === 2) this.fire(into, 'dblclick', { button, detail: 2 });
      } else this.fire(into, 'auxclick', { button, detail: this.clickCount });
    }
    if (this.buttons === 0) {
      this.mouseSuppressed = false;
      this.releaseCapture(this.captured);
    }
  }

  /** Mouse wheel at the pointer; scrolls the nearest scrollable panel unless a listener took it. */
  wheel({ deltaX = 0, deltaY = 0, deltaZ = 0, deltaMode = 0 } = {}, mods) {
    this.setMods(mods);
    const at = this.hit();
    const e = this.fire(at, 'wheel', { deltaX, deltaY, deltaZ, deltaMode });
    if (!e.defaultPrevented) this.scroll(at, deltaX, deltaY, deltaMode);
  }

  /** The browser's wheel scrolling, which replayed wheel events do not get. */
  scroll(from, dx, dy, mode) {
    const style = (n) => this.win?.getComputedStyle?.(n) ?? {};
    for (let n = from; n && n.nodeType === 1; n = n.parentNode) {
      const s = style(n);
      const unitY = mode === 1 ? LINE_PX : mode === 2 ? n.clientHeight : 1;
      const unitX = mode === 1 ? LINE_PX : mode === 2 ? n.clientWidth : 1;
      const top = dy * unitY;
      const left = dx * unitX;
      const canY = /auto|scroll/.test(s.overflowY ?? '') && (top < 0 ? n.scrollTop > 0 : top > 0 && n.scrollTop + n.clientHeight < n.scrollHeight - 1);
      const canX = /auto|scroll/.test(s.overflowX ?? '') && (left < 0 ? n.scrollLeft > 0 : left > 0 && n.scrollLeft + n.clientWidth < n.scrollWidth - 1);
      if (!canY && !canX) continue;
      if (typeof n.scrollBy === 'function') n.scrollBy({ left: canX ? left : 0, top: canY ? top : 0 });
      else {
        if (canY) n.scrollTop += top;
        if (canX) n.scrollLeft += left;
      }
      return n;
    }
    return null;
  }

  /** Focus a text field the press landed on (typing then goes there); a press elsewhere leaves one. */
  focusFor(at) {
    const field = textField(at);
    if (field) {
      if (!field.disabled) field.focus?.({ preventScroll: true });
      return;
    }
    const active = this.doc.activeElement;
    if (active && textField(active) && !active.contains?.(at)) active.blur?.();
  }

  // ---- Pointer capture (setPointerCapture on the virtual pointer) ----------------------

  setCapture(el) {
    if (this.captured === el) return;
    if (this.captured) this.releaseCapture(this.captured);
    this.captured = el;
    this.fire(el, 'gotpointercapture', { cancelable: false });
  }

  releaseCapture(el) {
    if (!el || this.captured !== el) return;
    this.captured = null;
    this.fire(el, 'lostpointercapture', { cancelable: false });
    this.updateHover();
  }

  hasCapture(el) {
    return !!el && this.captured === el;
  }

  /** The lock let go: held buttons come up (no clicks) and hover leaves, so nothing stays pressed or open. */
  end() {
    for (const [button] of [...this.pressed]) this.up(button, null, { click: false });
    this.buttons = 0;
    this.releaseCapture(this.captured);
    const prev = this.hovered;
    if (prev) {
      this.hovered = null;
      const left = chain(prev);
      if (prev.isConnected !== false) {
        this.fire(prev, 'pointerout', { relatedTarget: null });
        for (const n of left) this.fire(n, 'pointerleave', { bubbles: false, cancelable: false, relatedTarget: null });
        this.fire(prev, 'mouseout', { relatedTarget: null });
        for (const n of left) this.fire(n, 'mouseleave', { bubbles: false, cancelable: false, relatedTarget: null });
      }
    }
    for (const n of this.doc.querySelectorAll?.('[data-vhover], [data-vactive]') ?? []) {
      n.removeAttribute('data-vhover');
      n.removeAttribute('data-vactive');
    }
  }
}

// ---- :hover and :active for the virtual pointer ------------------------------------------

const MIRRORED = new WeakSet();

/**
 * Replayed events do not set :hover or :active, so every style rule with
 * them gets a twin right after it with [data-vhover] / [data-vactive]
 * (VirtualPointer marks the elements). Through the CSSOM, which the
 * Content-Security-Policy allows; new style sheets are picked up on the
 * next call. Returns the number of rules added.
 */
export function mirrorPointerStates(doc = globalThis.document) {
  let added = 0;
  const walk = (list, parent) => {
    for (let i = list.length - 1; i >= 0; i--) {
      const rule = list[i];
      if (rule.cssRules && typeof rule.insertRule === 'function') walk(rule.cssRules, rule);
      const sel = rule.selectorText;
      if (typeof sel !== 'string' || !/:(hover|active)\b/.test(sel) || /data-v(hover|active)/.test(sel)) continue;
      const twin = sel.replace(/:hover\b/g, '[data-vhover]').replace(/:active\b/g, '[data-vactive]');
      try {
        parent.insertRule(`${twin} { ${rule.style.cssText} }`, i + 1);
        added++;
      } catch {
        // A selector this browser does not know (another engine's pseudo-element): no twin.
      }
    }
  };
  for (const sheet of doc?.styleSheets ?? []) {
    if (MIRRORED.has(sheet)) continue;
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // another origin's sheet
    }
    MIRRORED.add(sheet);
    walk(rules, sheet);
  }
  return added;
}

// ---- Pointer capture for the virtual pointer ------------------------------------------------

/** The pointer of the lock in force (setPointerCapture goes to it), or null. */
let activePointer = null;
const PATCHED = Symbol('webra.virtualPointerCapture');

/**
 * Pointer lock makes setPointerCapture throw for the real mouse, and the
 * replayed events need capture to follow a drag off an element (the radar,
 * js/minimap.js). While a lock holds, capture calls for the virtual
 * pointer's id go to it; every other call is the browser's.
 */
function routePointerCapture(win) {
  const proto = win?.Element?.prototype;
  if (!proto || typeof proto.setPointerCapture !== 'function' || proto.setPointerCapture[PATCHED]) return;
  const wrap = (original, virtual) => {
    const fn = function (id) {
      return activePointer && id === VIRTUAL_POINTER_ID ? virtual(activePointer, this) : original?.call(this, id);
    };
    fn[PATCHED] = true;
    return fn;
  };
  proto.setPointerCapture = wrap(proto.setPointerCapture, (p, el) => p.setCapture(el));
  proto.releasePointerCapture = wrap(proto.releasePointerCapture, (p, el) => p.releaseCapture(el));
  proto.hasPointerCapture = wrap(proto.hasPointerCapture, (p, el) => p.hasCapture(el));
}

// ---- The lock -------------------------------------------------------------------------------

/**
 * Mouse capture for the game screen: when to lock, the virtual pointer and
 * its cursor while locked, and when to let go. See the top of this file.
 *
 * States: 'off', 'pending' (asked the browser), 'locked'.
 */
export class MouseCapture {
  /**
   * @param {{
   *   root: Element,  clicks into it capture the mouse (#app; [data-no-capture] inside it does not)
   *   settings: { get(k: string): any, set(k: string, v: any): any, subscribe(k: string, fn: Function): Function },
   *   hotkeys?: { bindingsFor(name: string): string[] },  the capture hotkey's key for the hint
   *   isFullscreen?(): boolean,
   *   onHint?(text: string): void,  the "Mouse captured" hint (a toast)
   *   onEscape?(): void,  Esc that the browser kept while it let go, when Esc also opens the menu
   *   doc?: Document, win?: Window, now?(): number, makeEvent?(type: string, init: object): Event,
   *   mac?: boolean,
   * }} opts
   */
  constructor(opts) {
    this.opts = opts;
    this.doc = opts.doc ?? globalThis.document;
    this.win = opts.win ?? globalThis.window;
    this.root = opts.root;
    this.settings = opts.settings;
    this.now = opts.now ?? (() => performance.now());
    this.isFullscreen = opts.isFullscreen ?? (() => !!(this.doc.fullscreenElement ?? this.doc.webkitFullscreenElement));
    this.lockTarget = this.doc.documentElement;
    this.state = 'off';
    /** The player turned capture off with the hotkey: no capture on clicks until it is turned on again. */
    this.userOff = false;
    /** A menu or dialog is open (setBlocked). */
    this.blocked = false;
    this.cooldownUntil = 0;
    this.escGuardUntil = 0;
    /** The lock in force (or asked for) gives raw (unadjusted) movement: the setting asked and the browser took it. */
    this.raw = false;
    this.pointer = null;
    this.overlay = null;
    this.art = null; // what the cursor overlay shows: { src, x, y } or null
    /** The next move is the first after locking (FIRST_MOVE_JUMP). */
    this.firstMove = false;
    /** timeStamp of the last real move while locked (the raw speed), or null. */
    this.lastMoveAt = null;
    this.raf = 0;
    // The real pointer while unlocked: where the virtual one starts, and buttons held into the lock.
    this.real = { x: (this.win?.innerWidth ?? 0) / 2, y: (this.win?.innerHeight ?? 0) / 2, buttons: 0, target: null, mods: null };
    this.offs = [];
    const on = (target, type, fn, options) => {
      target?.addEventListener?.(type, fn, options);
      this.offs.push(() => target?.removeEventListener?.(type, fn, options));
    };
    const real = (e) => this.onReal(e);
    for (const type of MOUSE_EVENTS) on(this.win, type, real, { capture: true, passive: false });
    on(this.win, 'keydown', (e) => this.onKeyDown(e), true);
    on(this.win, 'blur', () => this.release('blur'));
    on(this.doc, 'pointerlockchange', () => this.onLockChange());
    on(this.doc, 'pointerlockerror', () => this.onLockError());
    on(this.doc, 'visibilitychange', () => this.doc.hidden && this.release('hidden'));
    const off = this.settings.subscribe?.('mouseCapture', () => !this.modeAllows() && this.release('setting'));
    if (off) this.offs.push(off);
    routePointerCapture(this.win);
    this.tick = () => {
      this.raf = 0;
      this.frame();
      if (this.state === 'locked') this.raf = this.win?.requestAnimationFrame?.(this.tick) ?? 0;
    };
  }

  get locked() {
    return this.state === 'locked';
  }

  mode() {
    const m = this.settings.get('mouseCapture');
    return CAPTURE_MODES.includes(m) ? m : 'fullscreen';
  }

  /** The setting lets a click capture now. */
  modeAllows() {
    const m = this.mode();
    return m === 'always' || (m === 'fullscreen' && this.isFullscreen());
  }

  /** Whether a mouse press on `target` should capture the mouse. */
  wantsCapture(target) {
    if (this.state !== 'off' || this.userOff || this.blocked || !this.modeAllows()) return false;
    if (this.now() < this.cooldownUntil) return false;
    if (!target || !this.root?.contains?.(target) || target.closest?.('[data-no-capture]')) return false;
    return !textField(target) && !realCursorControl(target);
  }

  // ---- Asking for and letting go of the lock --------------------------------------------

  /**
   * Ask the browser for the lock: the plain one (the OS cursor's movement),
   * or with Raw mouse input on, unadjusted movement first (requestRawLock)
   * and the plain one where the browser cannot give it.
   */
  async request() {
    if (this.state !== 'off' || this.blocked) return false;
    this.state = 'pending';
    const el = this.lockTarget;
    this.raw = false;
    if (this.settings.get('mouseCaptureRaw')) {
      try {
        const { result, raw } = requestRawLock(el);
        this.raw = raw;
        if (result) await result;
        return true;
      } catch (err) {
        this.raw = false;
        if (err?.name !== 'NotSupportedError' || this.state !== 'pending') {
          this.onLockError();
          return false;
        }
        // No raw movement here: the plain lock then.
      }
    }
    try {
      const p = el.requestPointerLock();
      if (p) await p;
    } catch {
      this.onLockError();
      return false;
    }
    return true;
  }

  /** Let go (a menu, blur, the hotkey, Esc). Safe to call in any state. */
  release(reason = 'release') {
    if (this.state === 'off') return false;
    const was = this.state;
    this.state = 'off';
    this.lastRelease = reason;
    if (was === 'locked') this.disengage();
    if (this.doc.pointerLockElement === this.lockTarget) this.doc.exitPointerLock?.();
    return true;
  }

  /** The capture hotkey: let go, or capture now (whatever the setting says; the press is the player's intent). */
  toggle() {
    if (this.state !== 'off') {
      this.userOff = true;
      this.release('hotkey');
      return false;
    }
    this.userOff = false;
    if (!this.blocked) this.request();
    return true;
  }

  /** A menu, dialog or loading screen is open (true) or not: open lets go and stops capturing. */
  setBlocked(on) {
    this.blocked = !!on;
    if (this.blocked) this.release('blocked');
  }

  /** Fullscreen came or went: entering captures (when the setting allows), leaving lets go. */
  fullscreenChanged(fullscreen) {
    if (!fullscreen) {
      this.release('fullscreen');
      return;
    }
    if (this.mode() !== 'off' && !this.userOff && !this.blocked && this.state === 'off') this.request();
  }

  onLockChange() {
    const ours = this.doc.pointerLockElement === this.lockTarget;
    if (ours) {
      // Let go while the browser was still deciding: give it back.
      if (this.state !== 'pending') {
        if (this.state === 'off') this.doc.exitPointerLock?.();
        return;
      }
      this.engage();
      return;
    }
    if (this.state === 'off') return;
    // The browser let go by itself: Esc (which it usually keeps), or focus moving away.
    const was = this.state;
    this.state = 'off';
    this.lastRelease = 'browser';
    if (was !== 'locked') return;
    this.disengage();
    const now = this.now();
    this.cooldownUntil = now + RELOCK_COOLDOWN_MS;
    this.escGuardUntil = now + ESC_GUARD_MS;
    const focused = this.doc.hasFocus?.() ?? true;
    if (focused && !this.doc.hidden && this.settings.get('mouseCaptureEscMenu')) this.opts.onEscape?.();
  }

  onLockError() {
    if (this.state === 'pending') this.state = 'off';
  }

  // ---- Locked ---------------------------------------------------------------------------

  engage() {
    this.state = 'locked';
    mirrorPointerStates(this.doc);
    this.pointer = new VirtualPointer({ doc: this.doc, win: this.win, makeEvent: this.opts.makeEvent, now: this.now });
    activePointer = this.pointer;
    // The first movement after locking can be a jump (Chromium): skipped when it is one.
    this.firstMove = true;
    this.lastMoveAt = null;
    const { w, h } = this.view();
    const p = clampToView(this.real.x, this.real.y, w, h);
    this.pointer.place(p.x, p.y, this.real.mods, { buttons: this.real.buttons, target: this.real.target });
    this.showCursor();
    this.hint();
    if (!this.raf) this.raf = this.win?.requestAnimationFrame?.(this.tick) ?? 0;
  }

  disengage() {
    if (this.raf) this.win?.cancelAnimationFrame?.(this.raf);
    this.raf = 0;
    const p = this.pointer;
    this.pointer = null;
    if (activePointer === p) activePointer = null;
    p?.end();
    this.real.buttons = 0;
    this.real.target = null;
    this.art = null;
    if (this.overlay) this.overlay.hidden = true;
  }

  view() {
    return { w: this.win?.innerWidth ?? 0, h: this.win?.innerHeight ?? 0 };
  }

  /** The "Mouse captured" hint, the first HINT_LIMIT times. */
  hint() {
    const shown = Number(this.settings.get('mouseCaptureHints')) || 0;
    if (shown >= HINT_LIMIT) return;
    this.settings.set('mouseCaptureHints', shown + 1);
    const combo = this.opts.hotkeys?.bindingsFor(CAPTURE_ACTION)?.[0] ?? null;
    this.opts.onHint?.(hintText(combo, this.opts.mac ?? isMac()));
  }

  /** Per animation frame while locked: the window's size, hover under a still pointer, the cursor art. */
  frame() {
    if (this.state !== 'locked' || !this.pointer) return;
    const { w, h } = this.view();
    this.pointer.clamp(w, h);
    this.pointer.updateHover();
    this.drawCursor();
  }

  // ---- The cursor -----------------------------------------------------------------------

  showCursor() {
    if (!this.overlay && this.doc.body) {
      const box = this.doc.createElement('div');
      box.className = 'virtual-cursor';
      box.setAttribute('aria-hidden', 'true');
      const img = this.doc.createElement('img');
      img.alt = '';
      img.setAttribute('draggable', 'false');
      box.append(img);
      this.doc.body.append(box);
      this.overlay = box;
      this.overlayImg = img;
    }
    this.drawCursor();
  }

  /** The art the page asks for where the pointer is (CSS `cursor` there), at the pointer. */
  drawCursor() {
    const p = this.pointer;
    if (!p) return;
    const el = p.captured ?? p.hovered;
    const value = el ? (this.win?.getComputedStyle?.(el)?.cursor ?? '') : '';
    const art = cursorArt(value);
    this.art = art;
    const box = this.overlay;
    if (!box) return;
    box.hidden = !art;
    if (!art) return;
    if (this.overlayImg.getAttribute('src') !== art.src) this.overlayImg.setAttribute('src', art.src);
    // CSSOM only: the CSP allows no style attribute.
    box.style.transform = `translate(${p.x - art.x}px, ${p.y - art.y}px)`;
  }

  // ---- Real input -----------------------------------------------------------------------

  onReal(e) {
    if (!e.isTrusted) return; // the virtual pointer's own events
    const type = e.type;
    if (e.pointerType !== undefined && e.pointerType !== 'mouse' && type.startsWith('pointer')) {
      // Touch and pen never go through the lock; a touch on the screen lets go of it.
      if (type === 'pointerdown' && this.state !== 'off') this.release('touch');
      return;
    }
    if (this.state !== 'locked') {
      this.track(e);
      if (type === 'pointerdown' && this.wantsCapture(e.target)) this.request();
      return;
    }
    e.stopImmediatePropagation();
    if (PREVENT.has(type) && e.cancelable) e.preventDefault();
    const p = this.pointer;
    const mods = { ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey };
    if (type === 'mousemove') {
      const mx = Number(e.movementX) || 0;
      const my = Number(e.movementY) || 0;
      const distance = Math.hypot(mx, my);
      const at = Number.isFinite(e.timeStamp) ? e.timeStamp : null;
      const dtMs = at !== null && this.lastMoveAt !== null ? at - this.lastMoveAt : NaN;
      this.lastMoveAt = at;
      if (this.firstMove) {
        this.firstMove = false;
        if (distance > FIRST_MOVE_JUMP) return;
      }
      const f = movementFactor({ speed: this.settings.get('mouseCaptureSpeed'), raw: this.raw, distance, dtMs });
      const { w, h } = this.view();
      p.moveBy(mx * f, my * f, w, h, mods);
      this.drawCursor();
    } else if (type === 'mousedown') {
      const control = p.down(e.button, mods);
      if (control) {
        // A list, slider or picker needs the OS cursor: let go and hand it the focus.
        this.release('control');
        control.focus?.({ preventScroll: true });
        try {
          control.showPicker?.();
        } catch {
          // No picker without the OS cursor's activation in some browsers: the focus is enough.
        }
      }
    } else if (type === 'mouseup') p.up(e.button, mods);
    else if (type === 'wheel') p.wheel(e, mods);
  }

  /** Follow the real pointer while unlocked. */
  track(e) {
    if (typeof e.clientX === 'number') {
      this.real.x = e.clientX;
      this.real.y = e.clientY;
    }
    this.real.mods = { ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey };
    if (e.type === 'mousedown' || e.type === 'mouseup') {
      this.real.buttons = e.buttons ?? 0;
      if (e.type === 'mousedown') this.real.target = e.target;
    }
  }

  /**
   * Esc while locked lets go; unless Esc also opens the menu (setting), it
   * goes no further, so the next Esc opens the menu. An Esc right after the
   * browser let go was that key: the same. In a text field Esc does both
   * (the chat line closes as it always does).
   */
  onKeyDown(e) {
    if (e.key !== 'Escape') return;
    const typing = !!textField(e.target);
    const menuToo = !!this.settings.get('mouseCaptureEscMenu');
    if (this.state !== 'off') {
      this.release('esc');
      if (!typing && !menuToo) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
      return;
    }
    if (this.now() < this.escGuardUntil) {
      this.escGuardUntil = 0;
      // onLockChange already did what this Esc asks for (onEscape when the menu opens too).
      if (!typing) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }
  }

  dispose() {
    this.release('dispose');
    for (const off of this.offs) off();
    this.offs = [];
    this.overlay?.remove();
    this.overlay = null;
  }
}

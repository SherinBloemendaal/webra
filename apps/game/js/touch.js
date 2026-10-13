// Touch and pen controls for the battlefield. Pointer Events with
// pointerType 'touch' or 'pen' go through the gesture recognizer
// (js/gestures.js) and drive the same actions as the mouse in js/input.js;
// mouse pointers are left alone, so mouse play is unchanged.
//
//   Tap                     select, or give the context order (move, attack, harvest, ...)
//   Double tap              select every unit of that type on screen
//   Drag                    box select (in a targeting mode: aim, then release to act;
//                           in repair mode: repair the own damaged structures in the box)
//   Two fingers             pan, pinch to zoom
//   Long press              with units selected: force attack the actor under the finger,
//                           or attack-move to the ground; otherwise cancel the mode or
//                           clear the selection (the right click)
//   Radar tap               with units selected or a mode on: the order for that spot
//                           (radarTap); otherwise, and for a drag, move the camera (js/minimap.js)
//
// The touch action bar holds the modifier substitutes: Add (Shift: add to the
// selection, keep a mode active, queue five in the sidebar), Attack move,
// Force attack, plus Stop, Deploy, Select all and Cancel. Its buttons run the
// registered hotkey actions by name (js/hotkeys.js), so actions added later
// (for example by a command bar) can be put on the bar the same way.
// Building placement gets Place and Cancel buttons: tap or drag to move the
// footprint, then Place.

import { GestureRecognizer, pinchCamera } from './gestures.js';
import { ACTION } from './cursors.js';

const NONE = 0xffffffff;
const CARD_LONG_PRESS_MS = 500;
const CARD_SLOP = 10;

/**
 * Buttons of the touch action bar. `toggle` buttons show a pressed state;
 * `hotkey` runs that registered action.
 */
export const TOUCH_BAR = [
  { id: 'queue', label: 'Add', title: 'Like holding Shift: taps and boxes add to the selection, modes stay active, the sidebar queues 5', toggle: true },
  { id: 'attackMove', label: 'A-Move', title: 'Attack move: tap the destination', toggle: true, needsUnits: true },
  { id: 'force', label: 'Force', title: 'Force attack: tap any unit or building, your own included', toggle: true, needsUnits: true },
  { id: 'stop', label: 'Stop', title: 'Stop the selected units', hotkey: 'stop', needsUnits: true },
  { id: 'deploy', label: 'Deploy', title: 'Deploy, unload, pack up or use the ability of the selection', hotkey: 'deploy' },
  { id: 'selectAll', label: 'All', title: 'Select every combat unit on screen (again: on the whole map)', hotkey: 'selectAll' },
  { id: 'cancel', label: 'Cancel', title: 'Cancel the current mode, or clear the selection' },
];

/** Touch rows for the Controls page of the game menu. */
export function touchControls() {
  return [
    ['Tap', 'Select, or give the order (move, attack, harvest, dock, repair)'],
    ['Double tap', 'Select all units of that type on screen'],
    ['Drag', 'Box select; in a targeting mode, aim and release; in repair mode, repair your damaged structures in the box'],
    ['Two-finger drag', 'Pan the map'],
    ['Pinch', 'Zoom'],
    ['Long press', 'Force attack the unit or building (units selected), attack-move to the ground, or cancel'],
    ['Add', 'Shift: add to the selection, keep the mode, queue 5 in the sidebar'],
    ['A-Move / Force', 'Attack move / force attack the next tap'],
    ['Tap the radar', 'Units selected: give the order there (Add queues, Force force attacks); otherwise move the camera'],
    ['Drag on the radar', 'Move the camera'],
    ['Long press a sidebar card', 'Cancel one'],
    ['Placing a building', 'Tap or drag to move it, then Place (or Cancel)'],
    ['Menu, Build / Map', 'Game menu; show or hide the build sidebar on phones'],
  ];
}

function button(label, title) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'touch-button';
  b.textContent = label;
  b.title = title;
  return b;
}

export class TouchControls {
  /**
   * @param {{ canvas: HTMLCanvasElement, field: HTMLElement, input: import('./input.js').Input,
   *           hotkeys: import('./hotkeys.js').HotkeyRegistry, onTouchUi?: () => void, gestures?: object }} opts
   *   gestures: GestureRecognizer options (timings, and a fake timer in tests)
   */
  constructor({ canvas, field, input, hotkeys, onTouchUi, gestures = {} }) {
    this.canvas = canvas;
    this.input = input;
    this.hotkeys = hotkeys;
    this.onTouchUi = onTouchUi;
    this.queue = false; // Shift substitute
    this.force = false; // force attack: the next tap
    this.dragKind = null; // 'box' | 'power' | 'aim' | 'footprint'
    this.footprint = null; // { fx, fy, sx, sy } footprint drag start
    this.placingShown = false;
    this.recognizer = new GestureRecognizer({
      tap: (p) => this.onTap(p),
      doubleTap: (p) => this.onDoubleTap(p),
      longPress: (p) => this.onLongPress(p),
      dragStart: (p) => this.onDragStart(p),
      dragMove: (p) => this.onDragMove(p),
      dragEnd: (p) => this.onDragEnd(p),
      dragCancel: () => this.onDragCancel(),
      pinch: (p) => this.onPinch(p),
    }, gestures);
    this.buildBar(field);
    this.bind();
  }

  // ---- Pointer events ------------------------------------------------------------

  bind() {
    const c = this.canvas;
    const handler = (kind) => (e) => this.onPointer(e, kind);
    c.addEventListener('pointerdown', handler('down'));
    c.addEventListener('pointermove', handler('move'));
    c.addEventListener('pointerup', handler('up'));
    c.addEventListener('pointercancel', handler('cancel'));
    // A real mouse moving again takes the pointer back from a finger (hybrid devices).
    window.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'mouse' && this.input.mouse.touch) this.input.mouse.touch = false;
    });
    if (globalThis.matchMedia?.('(pointer: coarse)').matches) this.markTouchUi();
  }

  /** Show the touch UI (action bar, larger targets) from the first touch on. */
  markTouchUi() {
    if (document.body.classList.contains('touch')) return;
    document.body.classList.add('touch');
    this.onTouchUi?.();
  }

  onPointer(e, kind) {
    if (e.pointerType === 'mouse') return;
    // No compatibility mouse events, no browser panning or zooming over the field.
    e.preventDefault();
    if (kind === 'down') this.markTouchUi();
    if (this.input.suspended) {
      this.recognizer.reset();
      return;
    }
    const p = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp };
    if (kind === 'down') {
      if (this.recognizer.down(p)) {
        try {
          this.canvas.setPointerCapture(e.pointerId);
        } catch {
          // Capture is a convenience (moves outside the canvas); ignore refusals.
        }
      }
    } else if (kind === 'move') this.recognizer.move(p);
    else if (kind === 'up') this.recognizer.up(p);
    else this.recognizer.cancel(p);
  }

  /** Client point to canvas-local view px. */
  local(x, y) {
    const r = this.canvas.getBoundingClientRect();
    return { x: x - r.left, y: y - r.top };
  }

  /** A mouse-like event for js/input.js at client point (x, y). */
  fake(x, y, button = 0) {
    return { button, clientX: x, clientY: y, shiftKey: this.queue, ctrlKey: false, metaKey: false, altKey: false, preventDefault() {} };
  }

  /** Left click at a client point, through the mouse code path. */
  click(x, y) {
    const e = this.fake(x, y);
    this.input.onMouseMove(e);
    this.input.onMouseDown(e);
    this.input.onMouseUp(e);
  }

  // ---- Modes ---------------------------------------------------------------------

  modeActive() {
    const i = this.input;
    return !!(this.force || i.targeting || i.power || i.mode || i.placing || i.attackMove);
  }

  /** The right click: cancel the current mode, else clear the selection. */
  cancel() {
    if (this.force) {
      this.force = false;
      this.dragKind = null;
    } else if (!this.input.cancelMode()) this.input.setSelection([]);
    this.update();
  }

  setForce(on) {
    this.force = !!on && this.input.selectedOwnUnits().length > 0;
    if (this.force) this.input.attackMove = false;
    this.update();
  }

  /** Force attack whatever is under client point (x, y). Resolves with true when an order was given. */
  forceAttack(x, y) {
    const p = this.local(x, y);
    return this.forceAttackAt(this.input.toWorld(p.x, p.y));
  }

  /** Force attack whatever is at world point `w`. Resolves with true when an order was given. */
  async forceAttackAt(w) {
    const i = this.input;
    const units = i.selectedOwnUnits();
    if (!units.length) return false;
    const hit = await i.ask.pick(i.player, w.x, w.y);
    if (hit === NONE || units.includes(hit)) return false;
    i.game.order_attack(i.player, Uint32Array.from(units), hit);
    i.flashOrder(w, ACTION.ATTACK);
    return true;
  }

  /**
   * A tap on the radar at world point `w` (js/minimap.js): the order a tap on
   * that spot of the battlefield would give (js/input.js radarClick), with
   * the action bar's substitutes: Add queues it (Shift), Force force attacks
   * what is there. Resolves with true when it was an order; false lets the
   * radar move the camera there instead.
   */
  async radarTap(w) {
    if (this.force) {
      const ordered = await this.forceAttackAt(w);
      if (ordered && !this.queue) this.force = false;
      this.update();
      return ordered;
    }
    const ordered = await this.input.radarClick(w, { shift: this.queue }, 0);
    this.update();
    return ordered;
  }

  /** Whether a radar tap may give an order (else it moves the camera at once): units selected or a mode on. */
  radarMayOrder() {
    return this.force || this.input.radarMayOrder();
  }

  // ---- Gestures ------------------------------------------------------------------

  onTap({ x, y }) {
    if (this.input.placing) {
      this.moveFootprintTo(x, y);
      return;
    }
    if (this.force) {
      this.forceAttack(x, y).then((ordered) => {
        if (ordered && !this.queue) this.force = false;
        this.update();
      });
      return;
    }
    this.click(x, y);
    this.update();
  }

  async onDoubleTap({ x, y }) {
    const i = this.input;
    if (this.modeActive()) {
      this.onTap({ x, y });
      return;
    }
    const p = this.local(x, y);
    const intent = await i.clickIntentNow(i.toWorld(p.x, p.y));
    if (intent.kind === 'select' && intent.id !== undefined && !this.queue) {
      // Like a double click (js/input.js selectSameClass).
      await i.selectSameClass(intent.id);
      i.lastClick = { time: 0, id: NONE };
      this.update();
      return;
    }
    this.onTap({ x, y });
  }

  async onLongPress({ x, y }) {
    const i = this.input;
    if (i.placing) return;
    navigator.vibrate?.(15);
    if (this.modeActive()) {
      this.cancel();
      return;
    }
    const units = i.selectedOwnUnits();
    if (!units.length) {
      this.cancel();
      return;
    }
    if (await this.forceAttack(x, y)) return;
    const p = this.local(x, y);
    const w = i.toWorld(p.x, p.y);
    i.game.order_move(i.player, Uint32Array.from(units), w.x, w.y, true);
    i.flashOrder(w, ACTION.ATTACK);
  }

  onDragStart({ x, y }) {
    const i = this.input;
    if (i.placing) {
      // Drag anywhere: the footprint follows the finger's movement, so the finger does not hide it.
      this.dragKind = 'footprint';
      this.ensureFootprint();
      this.footprint = { fx: i.mouse.x, fy: i.mouse.y, sx: x, sy: y };
      return;
    }
    if (i.power) {
      // Support power: the drag start is the target, the release sets the direction.
      this.dragKind = 'power';
    } else if (i.mode === 'repair' && !this.force) {
      // Repair mode: the drag is a bulk repair box, as with the mouse (js/input.js).
      this.dragKind = 'box';
    } else if (this.modeActive()) {
      this.dragKind = 'aim';
      return;
    } else {
      this.dragKind = 'box';
    }
    const e = this.fake(x, y);
    i.onMouseMove(e);
    i.onMouseDown(e);
  }

  onDragMove({ x, y }) {
    if (this.dragKind === 'footprint') {
      const f = this.footprint;
      this.setFootprint(f.fx + x - f.sx, f.fy + y - f.sy);
    } else if (this.dragKind === 'box' || this.dragKind === 'power') {
      this.input.onMouseMove(this.fake(x, y));
    }
  }

  onDragEnd({ x, y }) {
    if (this.dragKind === 'footprint') this.onDragMove({ x, y });
    const kind = this.dragKind;
    this.dragKind = null;
    this.footprint = null;
    if (kind === 'box' || kind === 'power') {
      const e = this.fake(x, y);
      this.input.onMouseMove(e);
      this.input.onMouseUp(e);
    } else if (kind === 'aim') {
      this.onTap({ x, y });
    }
    this.update();
  }

  onDragCancel() {
    if (this.dragKind === 'box') {
      this.input.drag = null;
      this.input.repairDrag = null;
    }
    if (this.dragKind === 'power') this.input.powerDrag = null;
    this.dragKind = null;
    this.footprint = null;
  }

  onPinch({ x, y, dx, dy, scale }) {
    const i = this.input;
    const p = this.local(x, y);
    const limits = i.zoomLimits();
    const zoom = i.camera.zoom;
    Object.assign(i.camera, pinchCamera(i.camera, { x: p.x, y: p.y, dx, dy, scale }, limits.min, limits.max));
    i.clampCamera();
    // A pinch that zoomed is remembered like the wheel (js/input.js zoomed).
    if (i.camera.zoom !== zoom) i.zoomed();
  }

  // ---- Building placement --------------------------------------------------------

  /** Put the footprint at view point (vx, vy), kept inside the view. */
  setFootprint(vx, vy) {
    const m = this.input.mouse;
    m.x = Math.min(Math.max(vx, 0), this.canvas.clientWidth);
    m.y = Math.min(Math.max(vy, 0), this.canvas.clientHeight);
    m.inside = true;
    m.touch = true;
  }

  moveFootprintTo(x, y) {
    const p = this.local(x, y);
    this.setFootprint(p.x, p.y);
    this.update();
  }

  /** Placement started from a touch screen: show the footprint in the middle of the view. */
  ensureFootprint() {
    if (this.input.mouse.touch && this.input.mouse.inside) return;
    this.setFootprint(this.canvas.clientWidth / 2, this.canvas.clientHeight / 2);
  }

  confirmPlacement() {
    const i = this.input;
    if (!i.placing) return;
    const r = this.canvas.getBoundingClientRect();
    i.onMouseDown(this.fake(r.left + i.mouse.x, r.top + i.mouse.y));
    this.update();
  }

  // ---- Action bar ----------------------------------------------------------------

  buildBar(field) {
    this.bar = document.createElement('div');
    this.bar.id = 'touch-bar';
    this.bar.setAttribute('role', 'toolbar');
    this.bar.setAttribute('aria-label', 'Touch commands');
    this.buttons = new Map();
    for (const spec of TOUCH_BAR) {
      const b = button(spec.label, spec.title);
      b.dataset.action = spec.id;
      if (spec.toggle) b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', () => this.press(spec));
      this.buttons.set(spec.id, b);
      this.bar.append(b);
    }
    this.placeBar = document.createElement('div');
    this.placeBar.id = 'touch-place';
    this.placeBar.setAttribute('role', 'group');
    this.placeBar.setAttribute('aria-label', 'Building placement');
    this.placeHint = document.createElement('span');
    this.placeHint.className = 'touch-place-hint';
    this.placeHint.textContent = 'Tap or drag to move';
    this.placeButton = button('Place', 'Place the building here');
    this.placeButton.classList.add('touch-primary');
    this.placeButton.addEventListener('click', () => this.confirmPlacement());
    const cancel = button('Cancel', 'Stop placing (the building stays ready in the sidebar)');
    cancel.addEventListener('click', () => {
      this.input.cancelPlacing();
      this.update();
    });
    this.placeBar.append(this.placeHint, this.placeButton, cancel);
    this.placeBar.hidden = true;
    // Taps on the bars must not reach the battlefield's mouse handlers.
    for (const el of [this.bar, this.placeBar]) el.addEventListener('mousedown', (e) => e.stopPropagation());
    field.append(this.bar, this.placeBar);
  }

  press(spec) {
    const i = this.input;
    if (spec.id === 'queue') this.queue = !this.queue;
    else if (spec.id === 'attackMove') {
      const on = !i.attackMove;
      this.force = false;
      if (on) this.hotkeys.run('attackMove');
      else i.attackMove = false;
    } else if (spec.id === 'force') this.setForce(!this.force);
    else if (spec.id === 'cancel') this.cancel();
    else if (spec.hotkey) this.hotkeys.run(spec.hotkey);
    this.update();
  }

  /** Sync the bars with the game state (called often; touches the DOM only on change). */
  update() {
    const i = this.input;
    const hasUnits = i.selectedOwnUnits().length > 0;
    if (this.force && !hasUnits) this.force = false;
    const pressed = { queue: this.queue, attackMove: !!i.attackMove, force: this.force };
    for (const spec of TOUCH_BAR) {
      const b = this.buttons.get(spec.id);
      if (spec.toggle) {
        const v = String(!!pressed[spec.id]);
        if (b.getAttribute('aria-pressed') !== v) b.setAttribute('aria-pressed', v);
      }
      const disabled = !!spec.needsUnits && !hasUnits;
      if (b.disabled !== disabled) b.disabled = disabled;
    }
    const placing = !!i.placing;
    if (placing && !this.placingShown && document.body.classList.contains('touch')) this.ensureFootprint();
    if (!placing && this.placingShown && i.mouse.touch) {
      i.mouse.inside = false;
      i.mouse.touch = false;
    }
    this.placingShown = placing;
    // While placing, Place and Cancel replace the action bar.
    if (this.placeBar.hidden === placing) this.placeBar.hidden = !placing;
    if (this.bar.hidden !== placing) this.bar.hidden = placing;
    if (placing) {
      const ok = i.mouse.inside && i.placementValid();
      if (this.placeButton.disabled === ok) this.placeButton.disabled = !ok;
    }
  }

  /** Drop any gesture in progress (the game menu opened). */
  reset() {
    this.recognizer.reset();
    this.onDragCancel();
  }

  // ---- Sidebar -------------------------------------------------------------------

  /**
   * Long press on a sidebar card cancels one (the right click), also on iOS,
   * which has no contextmenu event for touch. The card's own contextmenu
   * handler is held back for touch so Android does not cancel twice.
   */
  bindSidebar(root, onCancel) {
    let press = null; // { id, x, y, timer, fired }
    let suppress = 0; // until this time, swallow the click and contextmenu that follow a touch long press
    const clear = () => {
      if (press) clearTimeout(press.timer);
      press = null;
    };
    root.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') return;
      const card = e.target.closest?.('.sb-card');
      clear();
      // A new touch: the click of an earlier long press has come and gone.
      suppress = 0;
      if (!card) return;
      const id = card.dataset.id;
      press = { id, x: e.clientX, y: e.clientY, timer: 0 };
      press.timer = setTimeout(() => {
        press = null;
        suppress = performance.now() + 1500;
        navigator.vibrate?.(15);
        onCancel(id);
      }, CARD_LONG_PRESS_MS);
    });
    root.addEventListener('pointermove', (e) => {
      if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > CARD_SLOP) clear();
    });
    root.addEventListener('pointerup', clear);
    root.addEventListener('pointercancel', clear);
    const swallow = (e) => {
      if (performance.now() < suppress || press) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    root.addEventListener('click', (e) => {
      if (performance.now() < suppress) {
        suppress = 0;
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);
    root.addEventListener('contextmenu', swallow, true);
  }
}

// Camera, mouse and keyboard handling. Converts screen input into world
// positions and queues orders on the simulation.
//
// Classic Red Alert mouse: with your units selected, LEFT click gives the
// order (move, attack, harvest, dock, repair) and left click on one of your
// own units selects it instead. Right click clears the selection.
//
// Keyboard: Esc, the digit row (control groups, js/controlgroups.js), the
// numpad (sidebar) and the arrow keys are handled here; every other key goes
// through the hotkey registry (js/hotkeys.js), where this class registers its
// actions with OpenRA's default keys. README.md (Controls) lists them all.
//
// The game may run in a worker (js/sim): what is drawn each frame (cursor,
// placement footprint) reads the game handle's synchronous answers, which are
// one frame old there; what a click or key does asks fresh answers
// (`this.ask`, promises) and acts when they arrive.

import { CURSORS, ACTION_CURSORS, ACTION, POWER_CURSORS, scrollCursor } from './cursors.js';
import { hotkeys as defaultHotkeys } from './hotkeys.js';
import { settings as defaultSettings } from './settings.js';
import { ControlGroups, DOUBLE_TAP_MS, groupCommand, groupKeyFromEvent } from './controlgroups.js';
import { actorInfo, askOf, queryOf } from './sim/methods.js';

const NONE = 0xffffffff;
const CELL = 24;
const EDGE = 12; // px from the canvas edge that scrolls the view
const PAN_SPEED = 900; // CSS px per second, at scroll speed 1
const DOUBLE_CLICK_MS = 300;
export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 4;
const DEFAULT_ZOOM = 1.5;
const BOOKMARKS = 4;

/** Edge scroll direction for a mouse position inside a w x h view: { dx, dy } in -1..1. */
export function edgeDirection(x, y, w, h, edge = EDGE) {
  let dx = 0;
  let dy = 0;
  if (x < edge) dx = -1;
  else if (x > w - edge) dx = 1;
  if (y < edge) dy = -1;
  else if (y > h - edge) dy = 1;
  return { dx, dy };
}

/** Camera position limits (world px) for a view of vw x vh world px over a map of mapW x mapH. */
export function cameraBounds(vw, vh, mapW, mapH, margin = 2 * CELL) {
  return {
    minX: -margin,
    maxX: Math.max(-margin, mapW - vw + margin),
    minY: -margin,
    maxY: Math.max(-margin, mapH - vh + margin),
  };
}

/** True when the camera cannot move in direction (dx, dy) on any axis. */
export function scrollBlocked(dx, dy, camera, bounds) {
  const canX = dx < 0 ? camera.x > bounds.minX : dx > 0 ? camera.x < bounds.maxX : false;
  const canY = dy < 0 ? camera.y > bounds.minY : dy > 0 ? camera.y < bounds.maxY : false;
  return !canX && !canY;
}

export class Input {
  constructor(canvas, game, rules, player, hooks, { hotkeys = defaultHotkeys, settings = defaultSettings } = {}) {
    this.canvas = canvas;
    this.game = game;
    /** Fresh answers for actions (js/sim/methods.js askOf). */
    this.ask = askOf(game);
    this.rules = rules;
    this.player = player;
    // { onSelectionChanged(ids), onPlaced(), onCancelPlace(), onNumpad(slot, opts), onTab(dir), onMenu() },
    // command bar (js/commandbar.js): { commandMouseDown(w, e), commandClick(w, mods),
    // commandCursor(w, mods), cancelCommand(), queuesAttackMove(shift) }
    this.hooks = hooks;
    this.hotkeys = hotkeys;
    this.settings = settings;
    this.camera = { x: 0, y: 0, zoom: DEFAULT_ZOOM };
    this.mapPx = { w: game.map_width() * CELL, h: game.map_height() * CELL };
    this.selection = [];
    this.ownUnits = null;
    this.groups = new ControlGroups();
    this.bookmarks = new Map(); // slot -> { x, y, zoom } (view centre)
    this.lastSelectTap = { name: null, time: -Infinity }; // Q / W double tap
    this.edgeScroll = null; // { dx, dy, blocked } while the mouse scrolls the view
    this.suspended = false; // game menu open: no input, no scrolling
    this.viewSize = { w: canvas.clientWidth, h: canvas.clientHeight };
    this.keys = new Set();
    // touch: the position comes from a finger (js/touch.js, building placement), so no edge scrolling.
    this.mouse = { x: -1, y: -1, inside: false, touch: false };
    this.drag = null;
    this.pan = null;
    this.placing = null; // actor id being placed
    this.sellMode = false;
    this.attackMove = false;
    this.power = null; // support power being targeted: { key, name } (js/powers.js)
    this.powerDrag = null; // target picked, mouse still down: { x, y, sx, sy }
    this.lastClick = { time: 0, id: NONE };
    // Ability and support power targeting: { kind: 'teleport', ids } (chrono tank)
    // or { kind: 'power', key, power, src } (src: Chronosphere source area, once picked).
    this.targeting = null;
    this.mineDrag = null; // Ctrl + drag with Minelayers selected: { sx, sy, ex, ey, units }
    this.bind();
    this.unregister = this.registerHotkeys();
  }

  // ---- Coordinates ------------------------------------------------------------

  toWorld(sx, sy) {
    return { x: this.camera.x + sx / this.camera.zoom, y: this.camera.y + sy / this.camera.zoom };
  }

  viewRect() {
    const w = this.canvas.clientWidth / this.camera.zoom;
    const h = this.canvas.clientHeight / this.camera.zoom;
    return { x0: this.camera.x, y0: this.camera.y, x1: this.camera.x + w, y1: this.camera.y + h };
  }

  /** World point at the middle of the view. */
  viewCenter() {
    return this.toWorld(this.canvas.clientWidth / 2, this.canvas.clientHeight / 2);
  }

  centerOn(x, y) {
    this.camera.x = x - this.canvas.clientWidth / this.camera.zoom / 2;
    this.camera.y = y - this.canvas.clientHeight / this.camera.zoom / 2;
    this.clampCamera();
  }

  bounds() {
    return cameraBounds(this.canvas.clientWidth / this.camera.zoom, this.canvas.clientHeight / this.camera.zoom, this.mapPx.w, this.mapPx.h);
  }

  clampCamera() {
    const b = this.bounds();
    this.camera.x = Math.min(Math.max(this.camera.x, b.minX), b.maxX);
    this.camera.y = Math.min(Math.max(this.camera.y, b.minY), b.maxY);
  }

  /** Zoom to `zoom`, keeping the view centre in place. */
  setZoom(zoom) {
    const c = this.viewCenter();
    this.camera.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
    this.centerOn(c.x, c.y);
  }

  /** Centre the camera on the given own actors (control group, selection). */
  async centerOnUnits(ids) {
    if (!ids.length) return;
    const c = await this.ask.units_center(this.player, Uint32Array.from(ids));
    if (c.length === 2) this.centerOn(c[0], c[1]);
  }

  // ---- Selection ----------------------------------------------------------------

  setSelection(ids) {
    this.selection = Array.from(new Set(ids));
    this.ownUnits = null;
    this.game.set_selection(Uint32Array.from(this.selection));
    this.hooks.onSelectionChanged(this.selection);
  }

  refreshSelection() {
    const alive = Array.from(this.game.selection());
    if (alive.length !== this.selection.length) {
      this.selection = alive;
      this.ownUnits = null;
      this.hooks.onSelectionChanged(this.selection);
    }
  }

  /** Owner, kind and type of an actor (js/sim/methods.js actorInfo), or null. */
  info(id) {
    return id === NONE ? null : actorInfo(this.game, id);
  }

  /** Selected units that belong to the local player (cached per selection change). */
  selectedOwnUnits() {
    if (!this.ownUnits) {
      this.ownUnits = this.selection.filter((id) => {
        const info = this.info(id);
        return info && info.owner === this.player && !info.building;
      });
    }
    return this.ownUnits;
  }

  /** The single selected own factory or depot, for rally points. */
  selectedRallyBuilding() {
    if (this.selection.length !== 1) return null;
    const info = this.info(this.selection[0]);
    return info && info.owner === this.player && info.building && info.producer ? this.selection[0] : null;
  }

  /**
   * What a left click at world point `w` does with the current selection:
   * { kind: 'order', action } | { kind: 'rally' } | { kind: 'select', id } | { kind: 'none' }.
   */
  clickIntent(w) {
    const units = this.selectedOwnUnits();
    const hit = this.game.pick(this.player, w.x, w.y);
    const deploy = hit !== NONE && this.selection.includes(hit) ? this.game.deploy_state(this.player, hit) : 0;
    const action = units.length ? this.game.cursor_action(this.player, Uint32Array.from(units), w.x, w.y) : 0;
    return this.decideClick(hit, deploy, action, units);
  }

  /** `clickIntent` with fresh answers from the game (a click, not the cursor). */
  async clickIntentNow(w) {
    const units = this.selectedOwnUnits();
    const [hit, action] = await Promise.all([
      this.ask.pick(this.player, w.x, w.y),
      units.length ? this.ask.cursor_action(this.player, Uint32Array.from(units), w.x, w.y) : 0,
    ]);
    const deploy = hit !== NONE && this.selection.includes(hit) ? await this.ask.deploy_state(this.player, hit) : 0;
    return this.decideClick(hit, deploy, action, units);
  }

  /**
   * The intent from the actor under the click (`hit`), its deploy state when
   * it is selected (`deploy`) and the smart order `action` of the own `units`.
   */
  decideClick(hit, deploy, action, units) {
    const hitInfo = this.info(hit);
    // Clicking a selected MCV (or Construction Yard) deploys it, like the original.
    if (hit !== NONE && this.selection.includes(hit)) {
      if (deploy === 1) return { kind: 'deploy', id: hit };
      if (deploy === 2) return { kind: 'blocked' };
    }
    if (units.length) {
      // Own units and buildings are selected, unless the order targets them (dock, repair, enter a transport).
      const ownHit = hitInfo && hitInfo.owner === this.player;
      const targetsOwn = action === ACTION.DOCK || action === ACTION.REPAIR || action === ACTION.LOAD || action === ACTION.DELIVER_CASH;
      if (ownHit && !targetsOwn) return { kind: 'select', id: hit };
      return { kind: 'order', action, units };
    }
    if (this.selectedRallyBuilding() !== null && !hitInfo) return { kind: 'rally' };
    return hit === NONE ? { kind: 'none' } : { kind: 'select', id: hit };
  }

  // ---- Placement ----------------------------------------------------------------

  startPlacing(actorId) {
    this.placing = actorId;
    this.attackMove = false;
    this.cancelPower();
    this.cancelTargeting();
    this.setSellMode(false);
  }

  // ---- Support powers (engine/src/powers.rs, js/powers.js) -------------------------

  /** Target a ready support power: click the map, or drag to set the flight direction. */
  startPowerTargeting(power) {
    this.placing = null;
    this.attackMove = false;
    this.setSellMode(false);
    // Superweapons have their own targeting (abilities: Chronosphere source then
    // destination, Iron Curtain and nuke targets) and cursors.
    if (POWER_CURSORS[power.kind]) {
      this.cancelPower();
      this.targeting = { kind: 'power', key: power.key, power: power.kind, src: null };
      this.hooks.onPowerTargeting?.(power.key);
      return;
    }
    this.targeting = null;
    this.power = { key: power.key, name: power.name };
    this.powerDrag = null;
    this.hooks.onPowerTargeting?.(power.key);
  }

  cancelPower() {
    if (!this.power) return;
    this.power = null;
    this.powerDrag = null;
    this.hooks.onPowerTargeting?.(null);
  }

  setSellMode(on) {
    this.sellMode = !!on;
    if (on) {
      this.placing = null;
      this.attackMove = false;
    }
    this.hooks.onSellMode?.(this.sellMode);
  }

  toggleSellMode() {
    this.setSellMode(!this.sellMode);
  }

  /** Deploy selected MCVs, pack up a selected Construction Yard, or unload selected transports. */
  async deploySelection() {
    if (!this.selection.length) return;
    // Chrono tanks pick a teleport target first (OpenRA PortableChrono deploy);
    // else MCVs, Construction Yards, transports, and ability units (mine, MAD tank, demolition).
    const { teleport, deploy } = await this.ask.deploy_targets(this.player, Uint32Array.from(this.selection));
    if (teleport.length) {
      this.cancelPower();
      this.targeting = { kind: 'teleport', ids: Array.from(teleport) };
      this.attackMove = false;
      return;
    }
    if (deploy.length) this.game.deploy(this.player, Uint32Array.from(deploy));
  }

  cancelTargeting() {
    if (this.targeting?.kind === 'power') this.hooks.onPowerTargeting?.(null);
    this.targeting = null;
  }

  /** Click while targeting an ability or support power. */
  async targetClick(w) {
    const t = this.targeting;
    if (t.kind === 'teleport') {
      const ok = await this.ask.teleport_valid(this.player, Uint32Array.from(t.ids), w.x, w.y);
      // Still teleporting with these tanks (not cancelled meanwhile).
      if (ok && this.targeting === t) {
        this.game.order_teleport(this.player, Uint32Array.from(t.ids), w.x, w.y);
        this.flashOrder(w, ACTION.MOVE);
        this.cancelTargeting();
      }
      return;
    }
    if (t.power === 'ChronoshiftPower' && !t.src) {
      // First click: the units to send; second click: where to.
      t.src = { x: w.x, y: w.y };
      return;
    }
    if (t.src) this.game.activate_power(this.player, t.key, w.x, w.y, t.src.x, t.src.y);
    else this.game.activate_power(this.player, t.key, w.x, w.y);
    this.flashOrder(w, ACTION.ATTACK);
    this.cancelTargeting();
  }

  /** 0: nothing selected can deploy, 1: something can deploy now, 2: blocked. */
  deployState() {
    if (!this.selection.length) return 0;
    return queryOf(this.game, 'deploy_summary', this.player, Uint32Array.from(this.selection));
  }

  cancelPlacing() {
    if (this.placing) {
      this.placing = null;
      this.hooks.onCancelPlace();
    }
  }

  placementCell(wx, wy) {
    const a = this.rules.actors.find((r) => r.id === this.placing);
    return { cx: Math.round(wx / CELL - a.width / 2), cy: Math.round(wy / CELL - a.height / 2) };
  }

  // ---- Event binding --------------------------------------------------------------

  bind() {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('mousedown', (e) => this.onMouseDown(e));
    window.addEventListener('mousemove', (e) => this.onMouseMove(e));
    window.addEventListener('mouseup', (e) => this.onMouseUp(e));
    // Take the position from the enter event itself: until the first move the
    // stored position would be stale (-1, -1 at start), which reads as "at the
    // top-left edge" and scrolled the view by itself.
    c.addEventListener('mouseenter', (e) => {
      const p = this.local(e);
      this.mouse.x = p.x;
      this.mouse.y = p.y;
      this.mouse.inside = true;
    });
    c.addEventListener('mouseleave', () => (this.mouse.inside = false));
    c.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => this.keys.delete(e.key));
    window.addEventListener('blur', () => this.keys.clear());
  }

  local(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  onMouseDown(e) {
    if (this.suspended) return;
    const p = this.local(e);
    const w = this.toWorld(p.x, p.y);
    if (e.button === 1) {
      e.preventDefault();
      this.pan = { x: p.x, y: p.y, cx: this.camera.x, cy: this.camera.y };
      return;
    }
    if (e.button === 2) {
      if (this.targeting) {
        this.cancelTargeting();
        return;
      }
      if (this.power) {
        this.cancelPower();
        return;
      }
      if (this.placing) {
        this.cancelPlacing();
        return;
      }
      if (this.hooks.cancelCommand?.()) return;
      if (this.attackMove) {
        this.attackMove = false;
        return;
      }
      if (this.sellMode) {
        this.setSellMode(false);
        return;
      }
      this.setSelection([]);
      return;
    }
    if (e.button !== 0) return;
    if (this.power) {
      // Target picked; mouse up fires it (a drag sets the direction).
      this.powerDrag = { x: w.x, y: w.y, sx: p.x, sy: p.y };
      return;
    }
    if (this.sellMode) {
      this.sellAt(w);
      if (!e.shiftKey) this.setSellMode(false);
      return;
    }
    if (this.placing) {
      const { cx, cy } = this.placementCell(w.x, w.y);
      this.placeAt(this.placing, cx, cy);
      return;
    }
    if (this.targeting) {
      this.targetClick(w);
      return;
    }
    if (this.hooks.commandMouseDown?.(w, e)) return;
    if ((e.ctrlKey || e.metaKey) && this.selectedMinelayers().length) {
      this.mineDrag = { sx: w.x, sy: w.y, ex: w.x, ey: w.y, units: this.selectedMinelayers() };
      return;
    }
    if (this.attackMove) {
      const units = this.selectedOwnUnits();
      if (units.length) {
        // Shift (or the command bar's queue toggle) queues it as a waypoint.
        if (this.hooks.queuesAttackMove?.(e.shiftKey)) this.game.order_waypoint(this.player, Uint32Array.from(units), w.x, w.y, true);
        else this.game.order_move(this.player, Uint32Array.from(units), w.x, w.y, true);
        this.flashOrder(w, ACTION.ATTACK);
      }
      if (!e.shiftKey) this.attackMove = false;
      return;
    }
    this.drag = { sx: p.x, sy: p.y, ex: p.x, ey: p.y, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey };
  }

  /** Sell mode click: sell the own structure there, if it can be sold. */
  async sellAt(w) {
    const hit = await this.ask.pick(this.player, w.x, w.y);
    if (hit === NONE || (await this.ask.sell_value(this.player, hit)) <= 0) return;
    this.game.sell(this.player, hit);
    this.flashOrder(w, ACTION.HARVEST);
  }

  /** Place structure `id` with its top-left cell at (cx, cy) when every footprint cell is free. */
  async placeAt(id, cx, cy) {
    const cells = await this.ask.placement_preview(this.player, id, cx, cy);
    // Placement cancelled or switched to another structure meanwhile.
    if (this.placing !== id) return;
    let ok = cells.length > 0;
    for (let i = 2; i < cells.length; i += 3) ok = ok && cells[i] === 1;
    if (!ok) return;
    this.game.place_building(this.player, id, cx, cy);
    this.placing = null;
    this.hooks.onPlaced();
  }

  onMouseMove(e) {
    const p = this.local(e);
    this.mouse.x = p.x;
    this.mouse.y = p.y;
    if (this.pan) {
      this.camera.x = this.pan.cx - (p.x - this.pan.x) / this.camera.zoom;
      this.camera.y = this.pan.cy - (p.y - this.pan.y) / this.camera.zoom;
      this.clampCamera();
    }
    if (this.drag) {
      this.drag.ex = p.x;
      this.drag.ey = p.y;
    }
    if (this.mineDrag) {
      const w = this.toWorld(p.x, p.y);
      this.mineDrag.ex = w.x;
      this.mineDrag.ey = w.y;
    }
  }

  /** Selected own Minelayers (Ctrl + drag lays a minefield). */
  selectedMinelayers() {
    const units = this.selectedOwnUnits();
    return units.length && this.game.has_minelayer(this.player, Uint32Array.from(units)) ? units : [];
  }

  onMouseUp(e) {
    if (e.button === 1) {
      this.pan = null;
      return;
    }
    if (e.button === 0 && this.mineDrag) {
      const m = this.mineDrag;
      this.mineDrag = null;
      this.game.order_lay_mines(this.player, Uint32Array.from(m.units), m.sx, m.sy, m.ex, m.ey);
      this.flashOrder({ x: m.ex, y: m.ey }, ACTION.HARVEST);
      return;
    }
    if (e.button === 0 && this.power && this.powerDrag) {
      const p = this.local(e);
      const t = this.powerDrag;
      const w = this.toWorld(p.x, p.y);
      const dragged = Math.abs(p.x - t.sx) + Math.abs(p.y - t.sy) >= 12;
      this.game.activate_power(this.player, this.power.key, t.x, t.y, dragged ? w.x : undefined, dragged ? w.y : undefined);
      this.flashOrder(t, ACTION.ATTACK);
      this.cancelPower();
      return;
    }
    if (e.button !== 0 || !this.drag) return;
    const d = this.drag;
    this.drag = null;
    const a = this.toWorld(d.sx, d.sy);
    const b = this.toWorld(d.ex, d.ey);
    if (Math.abs(d.ex - d.sx) + Math.abs(d.ey - d.sy) < 6) {
      this.finishClick(b, d);
      return;
    }
    this.boxSelect(a, b, d.shift);
  }

  /** A left click (no drag) at world point `b` with the drag's modifiers `d`. */
  async finishClick(b, d) {
    const now = performance.now();
    // Force move / force attack / queued orders (Alt, Ctrl, Shift + click).
    if (await this.hooks.commandClick?.(b, d)) return;
    const intent = d.shift ? { kind: 'select' } : await this.clickIntentNow(b);
    if (intent.kind === 'order') {
      this.game.order_smart(this.player, Uint32Array.from(intent.units), b.x, b.y);
      this.flashOrder(b, intent.action);
    } else if (intent.kind === 'deploy') {
      this.game.deploy(this.player, Uint32Array.from([intent.id]));
    } else if (intent.kind === 'blocked') {
      // Nothing to do: the deploy cursor already shows why.
    } else if (intent.kind === 'rally') {
      this.game.set_rally(this.player, this.selection[0], b.x, b.y);
      this.flashOrder(b, ACTION.MOVE);
    } else {
      await this.clickSelect(b, d.shift, d.ctrl, now);
    }
  }

  /** Box selection from world point `a` to `b` (Shift: added to the selection). */
  async boxSelect(a, b, shift) {
    const ids = Array.from(await this.ask.select_box(this.player, a.x, a.y, b.x, b.y));
    this.setSelection(shift ? this.selection.concat(ids) : ids);
  }

  /** Whole map rectangle in world px, for map-wide selection. */
  mapRect() {
    return { x0: 0, y0: 0, x1: this.mapPx.w, y1: this.mapPx.h };
  }

  /** Select what is at world point `w` (`now`: when it was clicked, for double clicks). */
  async clickSelect(w, shift, ctrl = false, now = performance.now()) {
    const v = ctrl ? this.mapRect() : this.viewRect();
    const id = await this.ask.pick(this.player, w.x, w.y);
    if (id !== NONE && id === this.lastClick.id && now - this.lastClick.time < DOUBLE_CLICK_MS) {
      // Double click: same type on screen; Ctrl + double click: on the whole map.
      this.lastClick = { time: 0, id: NONE };
      const same = Array.from(await this.ask.select_same_type(this.player, id, v.x0, v.y0, v.x1, v.y1));
      if (same.length) this.setSelection(same);
      return;
    }
    this.lastClick = { time: now, id };
    if (id === NONE) {
      if (!shift) this.setSelection([]);
      return;
    }
    const info = this.info(id);
    const own = info && info.owner === this.player;
    if (shift && own && !info.building) {
      const has = this.selection.includes(id);
      this.setSelection(has ? this.selection.filter((s) => s !== id) : this.selection.concat([id]));
    } else {
      this.setSelection([id]);
    }
  }

  onWheel(e) {
    e.preventDefault();
    if (this.suspended) return;
    const p = this.local(e);
    const before = this.toWorld(p.x, p.y);
    const factor = Math.exp(-e.deltaY * 0.0015);
    this.camera.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.camera.zoom * factor));
    this.camera.x = before.x - p.x / this.camera.zoom;
    this.camera.y = before.y - p.y / this.camera.zoom;
    this.clampCamera();
  }

  onKeyDown(e) {
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) return;
    if (this.suspended) return;
    // Alt + arrow jumps to a map edge (a hotkey); it must not also start scrolling.
    if (!(e.altKey && e.key.startsWith('Arrow'))) this.keys.add(e.key);
    // Numpad drives the sidebar (works with NumLock on or off):
    // 1-9 build that card (Shift: 5, Ctrl: cancel one), + / - switch tabs.
    if (e.code.startsWith('Numpad')) {
      const digit = /^Numpad([1-9])$/.exec(e.code);
      if (digit) {
        e.preventDefault();
        this.hooks.onNumpad?.(Number(digit[1]), { shift: e.shiftKey, cancel: e.ctrlKey || e.metaKey });
        return;
      }
      if (e.code === 'NumpadAdd' || e.code === 'Numpad0') {
        e.preventDefault();
        this.hooks.onTab?.(1);
        return;
      }
      if (e.code === 'NumpadSubtract') {
        e.preventDefault();
        this.hooks.onTab?.(-1);
        return;
      }
      if (e.code === 'NumpadDecimal') {
        e.preventDefault();
        this.cancelPlacing();
        return;
      }
    }
    if (e.key === 'Escape') {
      // Esc cancels the current mode first; with nothing to cancel it opens the game menu.
      e.preventDefault();
      if (!this.cancelMode()) this.hooks.onMenu?.();
      return;
    }
    const group = groupKeyFromEvent(e);
    if (group !== null && this.groupKey(e, group)) return;
    this.hotkeys.handle(e);
  }

  /** Cancel targeting, power, sell, placement, a command bar mode or attack move. False when none was active. */
  cancelMode() {
    if (this.targeting) this.cancelTargeting();
    else if (this.power) this.cancelPower();
    else if (this.sellMode) this.setSellMode(false);
    else if (this.placing) this.cancelPlacing();
    else if (this.hooks.cancelCommand?.()) {
      // A command bar mode (force move, force attack, guard, queue) was disarmed.
    } else if (this.attackMove) this.attackMove = false;
    else return false;
    return true;
  }

  /** Own actors among `ids` that are still alive (inside a transport counts). */
  ownAlive(ids) {
    return ids.filter((id) => {
      const info = this.info(id);
      return info !== null && info.owner === this.player;
    });
  }

  /**
   * Digit row: Ctrl/Cmd+N stores the selected units as group N, N selects it
   * (twice quickly: and centres the camera), Shift+N adds it to the selection.
   */
  groupKey(e, key) {
    const cmd = groupCommand(e);
    if (!cmd) return false;
    // Ctrl/Cmd+number is a tab switch in some browsers: hold it back where allowed.
    e.preventDefault();
    if (cmd === 'assign') {
      if (!e.repeat) this.groups.assign(key, this.selectedOwnUnits());
      return true;
    }
    if (e.repeat) return true;
    const alive = (ids) => this.ownAlive(ids);
    if (cmd === 'add') {
      const ids = this.groups.members(key, alive);
      if (ids.length) {
        this.setSelection(this.selection.concat(ids));
        this.refreshSelection();
      }
      return true;
    }
    const { ids, center } = this.groups.recall(key, performance.now(), alive);
    if (!ids.length) return true;
    this.setSelection(ids);
    this.refreshSelection();
    if (center) this.centerOnUnits(ids);
    return true;
  }

  /** True on the second press of `name` within the double tap time. */
  doubleTap(name) {
    const now = performance.now();
    const twice = this.lastSelectTap.name === name && now - this.lastSelectTap.time <= DOUBLE_TAP_MS;
    this.lastSelectTap = twice ? { name: null, time: -Infinity } : { name, time: now };
    return twice;
  }

  /** Own units of the selected types, on screen (or on the whole map). */
  async selectSameTypes(rect) {
    const seen = new Set();
    const asks = [];
    for (const id of this.selectedOwnUnits()) {
      const type = this.info(id)?.type;
      if (!type || seen.has(type)) continue;
      seen.add(type);
      asks.push(this.ask.select_same_type(this.player, id, rect.x0, rect.y0, rect.x1, rect.y1));
    }
    const out = [];
    for (const ids of await Promise.all(asks)) out.push(...ids);
    return out;
  }

  /** Register this class's hotkey actions (defaults from OpenRA's RA set). Returns an unregister function. */
  registerHotkeys() {
    const reg = (name, keys, handler, label, group, opts = {}) => this.hotkeys.registerAction(name, keys, handler, { label, group, ...opts });
    const offs = [
      reg('attackMove', 'A', () => {
        if (this.selectedOwnUnits().length) this.attackMove = true;
      }, 'Attack move', 'Orders'),
      reg('stop', 'S', () => {
        const units = this.selectedOwnUnits();
        if (units.length) this.game.order_stop(this.player, Uint32Array.from(units));
      }, 'Stop', 'Orders'),
      // OpenRA deploys with F; D (WebRA's first key) keeps working until another action takes it.
      reg('deploy', ['F', 'D'], () => this.deploySelection(), 'Deploy, unload, pack up', 'Orders'),
      reg('sell', 'Z', () => this.toggleSellMode(), 'Sell mode', 'Orders'),
      reg('selectAll', 'Q', async () => {
        const r = this.doubleTap('selectAll') ? this.mapRect() : this.viewRect();
        this.setSelection(Array.from(await this.ask.select_box(this.player, r.x0, r.y0, r.x1, r.y1)));
      }, 'Select all units on screen (twice: whole map)', 'Selection'),
      reg('selectByType', 'W', async () => {
        const ids = await this.selectSameTypes(this.doubleTap('selectByType') ? this.mapRect() : this.viewRect());
        if (ids.length) this.setSelection(ids);
      }, 'Select units of the selected types on screen (twice: whole map)', 'Selection'),
      reg('base', ['H', 'Space'], () => {
        const [x, y] = this.game.start_position(this.player);
        this.centerOn(x, y);
      }, 'Jump to base', 'Camera'),
      reg('toSelection', 'Home', () => this.centerOnUnits(this.selection), 'Jump to selection', 'Camera'),
      reg('zoomIn', ']', () => this.setZoom(this.camera.zoom * 1.25), 'Zoom in', 'Camera', { repeat: true }),
      reg('zoomOut', '[', () => this.setZoom(this.camera.zoom / 1.25), 'Zoom out', 'Camera', { repeat: true }),
      reg('resetZoom', '.', () => this.setZoom(DEFAULT_ZOOM), 'Reset zoom', 'Camera'),
      reg('jumpTop', 'Alt+ArrowUp', () => this.jumpToEdge(0, -1), 'Jump to top edge', 'Camera'),
      reg('jumpBottom', 'Alt+ArrowDown', () => this.jumpToEdge(0, 1), 'Jump to bottom edge', 'Camera'),
      reg('jumpLeft', 'Alt+ArrowLeft', () => this.jumpToEdge(-1, 0), 'Jump to left edge', 'Camera'),
      reg('jumpRight', 'Alt+ArrowRight', () => this.jumpToEdge(1, 0), 'Jump to right edge', 'Camera'),
    ];
    // Camera bookmarks. OpenRA uses Ctrl+Q/W/E/R and Alt+Q/W/E/R, but browsers
    // keep Ctrl+Q and Ctrl+W (quit, close tab), so WebRA uses F1..F4 to jump
    // and Shift+F1..F4 to save.
    for (let i = 1; i <= BOOKMARKS; i++) {
      offs.push(
        reg(`bookmarkSave${i}`, `Shift+F${i}`, () => {
          const c = this.viewCenter();
          this.bookmarks.set(i, { x: c.x, y: c.y, zoom: this.camera.zoom });
        }, `Save camera bookmark ${i}`, 'Camera'),
        reg(`bookmarkJump${i}`, `F${i}`, () => {
          const b = this.bookmarks.get(i);
          if (!b) return;
          this.camera.zoom = b.zoom;
          this.centerOn(b.x, b.y);
        }, `Jump to camera bookmark ${i}`, 'Camera'),
      );
    }
    return () => offs.forEach((off) => off());
  }

  /** Move the view to a map edge, keeping the other axis. */
  jumpToEdge(dx, dy) {
    const b = this.bounds();
    if (dx) this.camera.x = dx < 0 ? b.minX : b.maxX;
    if (dy) this.camera.y = dy < 0 ? b.minY : b.maxY;
  }

  /** Game menu open or closed: input stops and held keys are released. */
  setSuspended(on) {
    this.suspended = !!on;
    if (!on) return;
    this.keys.clear();
    this.drag = null;
    this.pan = null;
    this.mineDrag = null;
    this.powerDrag = null;
    this.edgeScroll = null;
  }

  /** Keep the view centre when the canvas changes size (window resize, fullscreen). */
  trackViewSize() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === this.viewSize.w && h === this.viewSize.h) return;
    const cx = this.camera.x + this.viewSize.w / this.camera.zoom / 2;
    const cy = this.camera.y + this.viewSize.h / this.camera.zoom / 2;
    this.viewSize = { w, h };
    this.centerOn(cx, cy);
  }

  /** Per-frame camera scrolling from arrow keys and screen edges. */
  update(dt) {
    this.trackViewSize();
    this.edgeScroll = null;
    if (this.suspended) return;
    let kx = 0;
    let ky = 0;
    if (this.keys.has('ArrowLeft')) kx -= 1;
    if (this.keys.has('ArrowRight')) kx += 1;
    if (this.keys.has('ArrowUp')) ky -= 1;
    if (this.keys.has('ArrowDown')) ky += 1;
    const edgeSpeed = this.settings.get('edgeScrollSpeed');
    let ex = 0;
    let ey = 0;
    if (edgeSpeed > 0 && this.mouse.inside && !this.mouse.touch && !this.drag && !this.pan) {
      ({ dx: ex, dy: ey } = edgeDirection(this.mouse.x, this.mouse.y, this.canvas.clientWidth, this.canvas.clientHeight));
      if (ex || ey) this.edgeScroll = { dx: ex, dy: ey, blocked: scrollBlocked(ex, ey, this.camera, this.bounds()) };
    }
    const keySpeed = this.settings.get('keyScrollSpeed');
    const vx = kx ? kx * keySpeed : ex * edgeSpeed;
    const vy = ky ? ky * keySpeed : ey * edgeSpeed;
    if (vx || vy) {
      this.camera.x += (vx * PAN_SPEED * dt) / this.camera.zoom;
      this.camera.y += (vy * PAN_SPEED * dt) / this.camera.zoom;
      this.clampCamera();
    }
    this.updateCursor();
  }

  /** Whether the building being placed fits where the mouse is. */
  placementValid() {
    const w = this.toWorld(this.mouse.x, this.mouse.y);
    const { cx, cy } = this.placementCell(w.x, w.y);
    const cells = this.game.placement_preview(this.player, this.placing, cx, cy);
    if (!cells.length) return false;
    for (let i = 2; i < cells.length; i += 3) if (cells[i] !== 1) return false;
    return true;
  }

  updateCursor() {
    let cursor = CURSORS.select;
    if (this.edgeScroll) {
      // Like Red Alert: at the screen edge the scroll arrow wins over every mode.
      cursor = scrollCursor(this.edgeScroll.dx, this.edgeScroll.dy, this.edgeScroll.blocked);
    } else if (this.sellMode) {
      const w = this.toWorld(this.mouse.x, this.mouse.y);
      const hit = this.game.pick(this.player, w.x, w.y);
      cursor = hit !== NONE && this.game.sell_value(this.player, hit) > 0 ? CURSORS.sell : CURSORS.blocked;
    } else if (this.targeting && this.mouse.inside) {
      const w = this.toWorld(this.mouse.x, this.mouse.y);
      const t = this.targeting;
      if (t.kind === 'teleport') cursor = this.game.teleport_valid(this.player, Uint32Array.from(t.ids), w.x, w.y) ? CURSORS.teleport : CURSORS.blocked;
      else cursor = POWER_CURSORS[t.power] ?? CURSORS.select;
    } else if (this.mineDrag || ((this.keys.has('Control') || this.keys.has('Meta')) && this.mouse.inside && !this.drag && this.selectedMinelayers().length)) {
      cursor = CURSORS.mine;
    } else if (this.power) cursor = CURSORS.attack;
    else if (this.placing) {
      // The footprint preview shows the cells; the cursor shows the spot.
      if (this.mouse.inside) cursor = this.placementValid() ? CURSORS.place : CURSORS.blocked;
    } else if (this.attackMove) cursor = CURSORS.attackMove;
    else if (this.mouse.inside && !this.drag && !this.pan) {
      const command = this.commandBarCursor();
      const intent = command ? { kind: 'command' } : this.clickIntent(this.toWorld(this.mouse.x, this.mouse.y));
      if (command) cursor = command;
      else if (intent.kind === 'order') cursor = ACTION_CURSORS[intent.action] ?? CURSORS.select;
      else if (intent.kind === 'rally') cursor = CURSORS.rally;
      else if (intent.kind === 'deploy') cursor = CURSORS.deploy;
      else if (intent.kind === 'blocked') cursor = CURSORS.blocked;
    }
    if (this.cursor !== cursor) {
      this.cursor = cursor;
      this.canvas.style.cursor = cursor;
    }
  }

  /** Command bar cursor (armed mode or held Ctrl / Alt / Shift), or null. */
  commandBarCursor() {
    const k = this.keys;
    const mods = { ctrl: k.has('Control') || k.has('Meta'), alt: k.has('Alt'), shift: k.has('Shift') };
    return this.hooks.commandCursor?.(this.toWorld(this.mouse.x, this.mouse.y), mods) ?? null;
  }

  /** Short marker where an order was given, like the original's flashing target. */
  flashOrder(w, action) {
    this.orderFlash = { x: w.x, y: w.y, action, until: performance.now() + 450 };
  }

  /** UI rectangles (world space) for the drag box and placement preview. */
  uiRects() {
    const out = [];
    const push = (x, y, w, h, r, g, b, a) => out.push(x, y, w, h, r, g, b, a);
    if (this.drag) {
      const a = this.toWorld(this.drag.sx, this.drag.sy);
      const b = this.toWorld(this.drag.ex, this.drag.ey);
      const x0 = Math.min(a.x, b.x);
      const y0 = Math.min(a.y, b.y);
      const w = Math.abs(b.x - a.x);
      const h = Math.abs(b.y - a.y);
      const t = 1 / this.camera.zoom;
      // White outline over a faint fill, like OpenRA's selection box.
      push(x0, y0, w, h, 1, 1, 1, 0.06);
      push(x0, y0, w, t, 1, 1, 1, 0.9);
      push(x0, y0 + h - t, w, t, 1, 1, 1, 0.9);
      push(x0, y0, t, h, 1, 1, 1, 0.9);
      push(x0 + w - t, y0, t, h, 1, 1, 1, 0.9);
    }
    if (this.orderFlash && performance.now() < this.orderFlash.until) {
      const f = this.orderFlash;
      const t = (f.until - performance.now()) / 450;
      const r = 3 + (1 - t) * 7;
      const col = f.action === ACTION.ATTACK ? [1, 0.3, 0.2] : f.action === ACTION.HARVEST ? [0.95, 0.75, 0.25] : [0.4, 0.95, 0.45];
      const th = 1.5 / this.camera.zoom + 0.5;
      push(f.x - r, f.y - r, 2 * r, th, ...col, t);
      push(f.x - r, f.y + r - th, 2 * r, th, ...col, t);
      push(f.x - r, f.y - r, th, 2 * r, ...col, t);
      push(f.x + r - th, f.y - r, th, 2 * r, ...col, t);
    }
    if (this.mineDrag) {
      // Minefield preview: the cells that will be mined.
      const m = this.mineDrag;
      const [x0, x1] = [Math.floor(Math.min(m.sx, m.ex) / CELL), Math.floor(Math.max(m.sx, m.ex) / CELL)];
      const [y0, y1] = [Math.floor(Math.min(m.sy, m.ey) / CELL), Math.floor(Math.max(m.sy, m.ey) / CELL)];
      if ((x1 - x0 + 1) * (y1 - y0 + 1) <= 1024) {
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) push(x * CELL + 2, y * CELL + 2, CELL - 4, CELL - 4, 0.95, 0.8, 0.25, 0.35);
      } else {
        push(x0 * CELL, y0 * CELL, (x1 - x0 + 1) * CELL, (y1 - y0 + 1) * CELL, 0.95, 0.25, 0.2, 0.25);
      }
    }
    if (this.targeting?.src) {
      // Chronosphere: the picked source area.
      const s = this.targeting.src;
      push(Math.floor(s.x / CELL - 1) * CELL, Math.floor(s.y / CELL - 1) * CELL, 3 * CELL, 3 * CELL, 0.45, 0.9, 1, 0.25);
    }
    if (this.power && this.powerDrag) {
      // Direction preview: dots from the target toward the mouse.
      const t = this.powerDrag;
      const m = this.toWorld(this.mouse.x, this.mouse.y);
      const s = 2 / this.camera.zoom + 1;
      for (let i = 0; i <= 8; i++) {
        const x = t.x + ((m.x - t.x) * i) / 8;
        const y = t.y + ((m.y - t.y) * i) / 8;
        push(x - s / 2, y - s / 2, s, s, 1, 0.8, 0.3, 0.9 - i * 0.06);
      }
    }
    if (this.placing && this.mouse.inside) {
      const w = this.toWorld(this.mouse.x, this.mouse.y);
      const { cx, cy } = this.placementCell(w.x, w.y);
      const cells = this.game.placement_preview(this.player, this.placing, cx, cy);
      for (let i = 0; i < cells.length; i += 3) {
        const ok = cells[i + 2] === 1;
        push(cells[i] * CELL + 1, cells[i + 1] * CELL + 1, CELL - 2, CELL - 2, ok ? 0.3 : 0.95, ok ? 0.9 : 0.25, ok ? 0.35 : 0.2, 0.45);
      }
    }
    return out;
  }
}

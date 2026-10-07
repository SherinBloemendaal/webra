// Camera, mouse and keyboard handling. Converts screen input into world
// positions and queues orders on the simulation.
//
// Classic Red Alert mouse: with your units selected, LEFT click gives the
// order (move, attack, harvest, dock, repair) and left click on one of your
// own units selects it instead. Right click clears the selection.

import { CURSORS, ACTION_CURSORS, ACTION, POWER_CURSORS } from './cursors.js';

const NONE = 0xffffffff;
const CELL = 24;
const EDGE = 12; // px from the canvas edge that scrolls the view
const PAN_SPEED = 900; // CSS px per second
const DOUBLE_CLICK_MS = 300;

export class Input {
  constructor(canvas, game, rules, player, hooks) {
    this.canvas = canvas;
    this.game = game;
    this.rules = rules;
    this.player = player;
    this.hooks = hooks; // { onSelectionChanged(ids), onPlaced(), onCancelPlace(), onNumpad(slot, opts), onTab(dir) }
    this.camera = { x: 0, y: 0, zoom: 1.5 };
    this.mapPx = { w: game.map_width() * CELL, h: game.map_height() * CELL };
    this.selection = [];
    this.ownUnits = null;
    this.groups = new Map();
    this.keys = new Set();
    this.mouse = { x: -1, y: -1, inside: false };
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

  centerOn(x, y) {
    this.camera.x = x - this.canvas.clientWidth / this.camera.zoom / 2;
    this.camera.y = y - this.canvas.clientHeight / this.camera.zoom / 2;
    this.clampCamera();
  }

  clampCamera() {
    const vw = this.canvas.clientWidth / this.camera.zoom;
    const vh = this.canvas.clientHeight / this.camera.zoom;
    const margin = 2 * CELL;
    this.camera.x = Math.min(Math.max(this.camera.x, -margin), Math.max(-margin, this.mapPx.w - vw + margin));
    this.camera.y = Math.min(Math.max(this.camera.y, -margin), Math.max(-margin, this.mapPx.h - vh + margin));
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

  info(id) {
    return id === NONE ? null : JSON.parse(this.game.actor_json(id));
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
    const hit = this.game.pick(this.player, w.x, w.y);
    const hitInfo = this.info(hit);
    // Clicking a selected MCV (or Construction Yard) deploys it, like the original.
    if (hit !== NONE && this.selection.includes(hit)) {
      const st = this.game.deploy_state(this.player, hit);
      if (st === 1) return { kind: 'deploy', id: hit };
      if (st === 2) return { kind: 'blocked' };
    }
    const units = this.selectedOwnUnits();
    if (units.length) {
      const action = this.game.cursor_action(this.player, Uint32Array.from(units), w.x, w.y);
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
  deploySelection() {
    // Chrono tanks pick a teleport target first (OpenRA PortableChrono deploy).
    const chrono = this.selection.filter((id) => this.game.ability_deploy_state(this.player, id) === 3);
    if (chrono.length) {
      this.cancelPower();
      this.targeting = { kind: 'teleport', ids: chrono };
      this.attackMove = false;
      return;
    }
    // MCVs, Construction Yards, transports, and ability units (mine, MAD tank, demolition).
    const ids = this.selection.filter((id) => this.game.deploy_state(this.player, id) !== 0 || this.game.ability_deploy_state(this.player, id) === 1);
    if (ids.length) this.game.deploy(this.player, Uint32Array.from(ids));
  }

  cancelTargeting() {
    if (this.targeting?.kind === 'power') this.hooks.onPowerTargeting?.(null);
    this.targeting = null;
  }

  /** Click while targeting an ability or support power. */
  targetClick(w) {
    const t = this.targeting;
    if (t.kind === 'teleport') {
      if (this.game.teleport_valid(this.player, Uint32Array.from(t.ids), w.x, w.y)) {
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
    let best = 0;
    for (const id of this.selection) {
      const st = this.game.deploy_state(this.player, id);
      const ab = this.game.ability_deploy_state(this.player, id);
      if (st === 1 || ab === 1 || ab === 3) return 1;
      if (st === 2 || ab === 2) best = 2;
    }
    return best;
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
      const hit = this.game.pick(this.player, w.x, w.y);
      if (hit !== NONE && this.game.sell_value(this.player, hit) > 0) {
        this.game.sell(this.player, hit);
        this.flashOrder(w, ACTION.HARVEST);
      }
      if (!e.shiftKey) this.setSellMode(false);
      return;
    }
    if (this.placing) {
      const { cx, cy } = this.placementCell(w.x, w.y);
      const cells = this.game.placement_preview(this.player, this.placing, cx, cy);
      let ok = cells.length > 0;
      for (let i = 2; i < cells.length; i += 3) ok = ok && cells[i] === 1;
      if (ok) {
        this.game.place_building(this.player, this.placing, cx, cy);
        this.placing = null;
        this.hooks.onPlaced();
      }
      return;
    }
    if (this.targeting) {
      this.targetClick(w);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && this.selectedMinelayers().length) {
      this.mineDrag = { sx: w.x, sy: w.y, ex: w.x, ey: w.y, units: this.selectedMinelayers() };
      return;
    }
    if (this.attackMove) {
      const units = this.selectedOwnUnits();
      if (units.length) {
        this.game.order_move(this.player, Uint32Array.from(units), w.x, w.y, true);
        this.flashOrder(w, ACTION.ATTACK);
      }
      if (!e.shiftKey) this.attackMove = false;
      return;
    }
    this.drag = { sx: p.x, sy: p.y, ex: p.x, ey: p.y, shift: e.shiftKey };
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
      const intent = d.shift ? { kind: 'select' } : this.clickIntent(b);
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
        this.clickSelect(b, d.shift);
      }
      return;
    }
    const ids = Array.from(this.game.select_box(this.player, a.x, a.y, b.x, b.y));
    this.setSelection(d.shift ? this.selection.concat(ids) : ids);
  }

  clickSelect(w, shift) {
    const id = this.game.pick(this.player, w.x, w.y);
    const now = performance.now();
    if (id !== NONE && id === this.lastClick.id && now - this.lastClick.time < DOUBLE_CLICK_MS) {
      const v = this.viewRect();
      const same = Array.from(this.game.select_same_type(this.player, id, v.x0, v.y0, v.x1, v.y1));
      if (same.length) this.setSelection(same);
      this.lastClick = { time: 0, id: NONE };
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
    const p = this.local(e);
    const before = this.toWorld(p.x, p.y);
    const factor = Math.exp(-e.deltaY * 0.0015);
    this.camera.zoom = Math.min(4, Math.max(0.5, this.camera.zoom * factor));
    this.camera.x = before.x - p.x / this.camera.zoom;
    this.camera.y = before.y - p.y / this.camera.zoom;
    this.clampCamera();
  }

  onKeyDown(e) {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    this.keys.add(e.key);
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
    const k = e.key.toLowerCase();
    if (k === 'escape') {
      if (this.targeting) this.cancelTargeting();
      else if (this.power) this.cancelPower();
      else if (this.sellMode) this.setSellMode(false);
      else if (this.placing) this.cancelPlacing();
      else if (this.attackMove) this.attackMove = false;
      else this.setSelection([]);
    } else if (k === 'a' && !e.ctrlKey && !e.metaKey) {
      if (this.selectedOwnUnits().length) this.attackMove = true;
    } else if (k === 'd' && !e.ctrlKey && !e.metaKey) {
      this.deploySelection();
    } else if (k === 'z' && !e.ctrlKey && !e.metaKey) {
      this.toggleSellMode();
    } else if (k === 's' && !e.ctrlKey && !e.metaKey) {
      const units = this.selectedOwnUnits();
      if (units.length) this.game.order_stop(this.player, Uint32Array.from(units));
    } else if (k === 'h' || k === ' ') {
      e.preventDefault();
      const [x, y] = this.game.start_position(this.player);
      this.centerOn(x, y);
    } else if (/^[1-9]$/.test(e.key)) {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        this.groups.set(e.key, this.selectedOwnUnits());
      } else if (this.groups.has(e.key)) {
        // The game drops dead ids from a selection; keep the stored group in sync.
        this.game.set_selection(Uint32Array.from(this.groups.get(e.key)));
        const alive = Array.from(this.game.selection());
        this.groups.set(e.key, alive);
        this.setSelection(alive);
      }
    }
  }

  /** Per-frame camera scrolling from arrow keys and screen edges. */
  update(dt) {
    let dx = 0;
    let dy = 0;
    if (this.keys.has('ArrowLeft')) dx -= 1;
    if (this.keys.has('ArrowRight')) dx += 1;
    if (this.keys.has('ArrowUp')) dy -= 1;
    if (this.keys.has('ArrowDown')) dy += 1;
    if (this.mouse.inside && !this.drag && !this.pan) {
      const w = this.canvas.clientWidth;
      const h = this.canvas.clientHeight;
      if (this.mouse.x < EDGE) dx -= 1;
      if (this.mouse.x > w - EDGE) dx += 1;
      if (this.mouse.y < EDGE) dy -= 1;
      if (this.mouse.y > h - EDGE) dy += 1;
    }
    if (dx || dy) {
      this.camera.x += (dx * PAN_SPEED * dt) / this.camera.zoom;
      this.camera.y += (dy * PAN_SPEED * dt) / this.camera.zoom;
      this.clampCamera();
    }
    this.updateCursor();
  }

  updateCursor() {
    let cursor = CURSORS.select;
    if (this.sellMode) {
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
    else if (this.placing) cursor = 'none';
    else if (this.attackMove) cursor = CURSORS.attackMove;
    else if (this.mouse.inside && !this.drag && !this.pan) {
      const intent = this.clickIntent(this.toWorld(this.mouse.x, this.mouse.y));
      if (intent.kind === 'order') cursor = ACTION_CURSORS[intent.action] ?? CURSORS.select;
      else if (intent.kind === 'rally') cursor = CURSORS.rally;
      else if (intent.kind === 'deploy') cursor = CURSORS.deploy;
      else if (intent.kind === 'blocked') cursor = CURSORS.blocked;
    }
    if (this.cursor !== cursor) {
      this.cursor = cursor;
      this.canvas.style.cursor = cursor;
    }
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
      push(x0, y0, w, h, 0.4, 0.9, 0.4, 0.08);
      push(x0, y0, w, t, 0.5, 1, 0.5, 0.9);
      push(x0, y0 + h - t, w, t, 0.5, 1, 0.5, 0.9);
      push(x0, y0, t, h, 0.5, 1, 0.5, 0.9);
      push(x0 + w - t, y0, t, h, 0.5, 1, 0.5, 0.9);
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

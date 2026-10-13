// Camera, mouse and keyboard handling. Converts screen input into world
// positions and queues orders on the simulation.
//
// Classic Red Alert mouse: with your units selected, LEFT click gives the
// order (move, attack, harvest, dock, repair) and left click on one of your
// own units selects it instead. Right click clears the selection.
//
// Keyboard: Esc (cancel, menu) is handled here; every other key goes through
// the hotkey registry (js/hotkeys.js), where this class registers its actions
// (orders, sidebar modes, selection, camera, control groups) with OpenRA's
// default keys. README.md (Controls) lists them all.
//
// Sidebar modes (OpenRA's order generators): sell, repair and power down
// stay on until cancelled (right click, Esc, the button or key again); a
// beacon is placed with one click.
//
// Bulk repair (a WebRA addition): with own structures selected, the Repair
// button or key toggles repairing all selected damaged ones at once instead
// of opening repair mode, and a box dragged in repair mode toggles those in
// the box (engine Order::RepairBuildings: start all when any is not
// repairing, else stop all).
//
// The game may run in a worker (js/sim): what is drawn each frame (cursor,
// placement footprint) reads the game handle's synchronous answers, which are
// one frame old there; what a click or key does asks fresh answers
// (`this.ask`, promises) and acts when they arrive.

import { CURSORS, ACTION_CURSORS, ACTION, MODE_CURSORS, POWER_CURSORS, minimapCursor, scrollCursor } from './cursors.js';

/** Smart orders that act on own actors (instead of selecting them). */
const TARGETS_OWN = new Set([
  ACTION.DOCK,
  ACTION.REPAIR,
  ACTION.LOAD,
  ACTION.DELIVER_CASH,
  ACTION.INSTANT_REPAIR,
  ACTION.REPAIR_BLOCKED,
  ACTION.HEAL,
  ACTION.FIX,
  ACTION.DISGUISE,
  ACTION.INFILTRATE,
]);
import { hotkeys as defaultHotkeys, focusKeepsKey } from './hotkeys.js';
import { OPENRA_HOTKEYS } from './openra-hotkeys.js';
import { settings as defaultSettings } from './settings.js';
import { ControlGroups } from './controlgroups.js';
import { actorInfo, askOf, queryOf } from './sim/methods.js';
import { MIN_ZOOM, MAX_ZOOM, baseZoom, clampZoom, rescaleZoom, zoomFactorOf, zoomForFactor, zoomLimits } from './scale.js';

const NONE = 0xffffffff;
const CELL = 24;
const EDGE = 12; // px from the canvas edge that scrolls the view
const PAN_SPEED = 900; // CSS px per second, at scroll speed 1
const DOUBLE_CLICK_MS = 300;
/** View px the mouse may move between down and up for a click, not a box. */
const CLICK_SLOP = 6;
/** Modifier keys (KeyboardEvent.key) the cursors follow in `keys`. */
const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta']);
// Zoom limits at game scale 1 (js/scale.js); an Input's own limits follow its game scale (zoomLimits()).
export { MIN_ZOOM, MAX_ZOOM };
const BOOKMARKS = 4;
/**
 * The player's zoom is remembered (game.zoomFactor) this long after the last
 * zoom step: one turn of the wheel is many events, and each write is stored
 * and synced.
 */
export const ZOOM_SAVE_MS = 300;

/** Sidebar modes (OpenRA order generators), see `Input.setMode`. */
export const MODES = Object.freeze(['sell', 'repair', 'powerDown', 'beacon']);

/**
 * The actor after the selected one in `list` (OpenRA's cycle hotkeys: the
 * first one after the first of `list` that is selected), or the first one.
 */
export function nextInCycle(list, selection) {
  const i = list.findIndex((id) => selection.includes(id));
  return i >= 0 && i + 1 < list.length ? list[i + 1] : (list[0] ?? null);
}

/** OpenRA's selection hotkey feedback line ("selected-units-across-screen" and "-map"). */
export function selectedUnitsText(count, where) {
  return count === 1 ? `Selected one unit across ${where}.` : `Selected ${count} units across ${where}.`;
}

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
  constructor(canvas, game, rules, player, hooks, { hotkeys = defaultHotkeys, settings = defaultSettings, spectator = false } = {}) {
    this.canvas = canvas;
    this.game = game;
    /** Fresh answers for actions (js/sim/methods.js askOf). */
    this.ask = askOf(game);
    this.rules = rules;
    this.player = player;
    // { onSelectionChanged(ids, { byPlayer }), onPlaced(), onCancelPlace(), onMenu(), onMode(mode),
    // lastEvent() -> { x, y } | null (radar pings, js/radarpings.js), feedback(text),
    // selectionClick() (the selection hotkeys' click), gameOver() -> bool },
    // command bar (js/commandbar.js): { commandMouseDown(w, e), commandClick(w, mods),
    // commandCursor(w, mods), cancelCommand(), queuesAttackMove(shift) },
    // tips (js/hints.js): { onPlainMove(units, worldPoint) }
    this.hooks = hooks;
    this.hotkeys = hotkeys;
    this.settings = settings;
    // Spectators and replays: only the hotkeys OpenRA has in its spectator context.
    this.spectator = !!spectator;
    // Spectator watching the whole map (no player's view): see viewOwner.
    this.watchAll = false;
    /** Game scale (game menu, Settings; js/scale.js): the base zoom and the zoom limits follow it. */
    this.gameScale = 1;
    // The zoom the player last used, as a factor of the base zoom (setGameScale keeps the factor).
    this.camera = { x: 0, y: 0, zoom: zoomForFactor(settings.get('zoomFactor'), this.gameScale) };
    /** Timer of a remembered zoom not stored yet (zoomed). */
    this.zoomSave = 0;
    this.mapPx = { w: game.map_width() * CELL, h: game.map_height() * CELL };
    this.selection = [];
    this.ownUnits = null;
    this.groups = new ControlGroups();
    /** `groups.version` the engine last got (`syncGroups`). */
    this.groupsSent = 0;
    this.bookmarks = new Map(); // slot -> { x, y, zoom } (view centre)
    this.edgeScroll = null; // { dx, dy, blocked } while the mouse scrolls the view
    this.suspended = false; // game menu open: no input, no scrolling
    this.viewSize = { w: canvas.clientWidth, h: canvas.clientHeight };
    this.keys = new Set();
    // touch: the position comes from a finger (js/touch.js, building placement), so no edge scrolling.
    this.mouse = { x: -1, y: -1, inside: false, touch: false };
    this.drag = null;
    this.pan = null;
    this.placing = null; // actor id being placed
    this.mode = null; // sidebar mode: one of MODES, or null
    this.attackMove = false;
    this.power = null; // support power being targeted: { key, name } (js/powers.js)
    this.powerDrag = null; // target picked, mouse still down: { x, y, sx, sy }
    this.lastClick = { time: 0, id: NONE };
    // Ability and support power targeting: { kind: 'teleport', ids } (chrono tank)
    // or { kind: 'power', key, power, src } (src: Chronosphere source area, once picked).
    this.targeting = null;
    this.mineDrag = null; // Ctrl + drag with Minelayers selected: { sx, sy, ex, ey, units }
    this.repairDrag = null; // left button down in repair mode: { sx, sy, ex, ey } (view px)
    this.bind();
    this.unregister = this.registerHotkeys();
    // The remembered zoom changed elsewhere (Defaults in the game menu, another tab, the account): the view follows.
    // While a zoom of this view waits to be stored, that one is newer.
    this.offZoomFactor = settings.subscribe?.('zoomFactor', (factor) => !this.zoomSave && this.applyZoomFactor(factor)) ?? null;
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

  /** Zoom to `zoom` (within the game scale's limits), keeping the view centre in place. */
  setZoom(zoom) {
    const c = this.viewCenter();
    this.camera.zoom = clampZoom(zoom, this.gameScale);
    this.centerOn(c.x, c.y);
  }

  /** Zoom limits at the current game scale: { min, max } in CSS px per world px. */
  zoomLimits() {
    return zoomLimits(this.gameScale);
  }

  /** The base zoom of the game scale: where "Reset zoom" goes (the view starts at the remembered factor of it). */
  baseZoom() {
    return baseZoom(this.gameScale);
  }

  /**
   * The player zoomed (wheel, zoom keys, pinch, a bookmark): the zoom is
   * remembered as a factor of the base zoom (game.zoomFactor) once the
   * zooming pauses for ZOOM_SAVE_MS, so the next game starts there.
   */
  zoomed() {
    if (this.zoomSave) clearTimeout(this.zoomSave);
    this.zoomSave = setTimeout(() => this.saveZoom(), ZOOM_SAVE_MS);
  }

  /** Store the zoom of this view as the remembered one now. */
  saveZoom() {
    if (this.zoomSave) clearTimeout(this.zoomSave);
    this.zoomSave = 0;
    this.settings.set('zoomFactor', zoomFactorOf(this.camera.zoom, this.gameScale));
  }

  /** Store a zoom that waits for the pause (the page is going away); nothing when none waits. */
  flushZoom() {
    if (this.zoomSave) this.saveZoom();
  }

  /** Zoom to a remembered factor of the base zoom, keeping the view centre. */
  applyZoomFactor(factor) {
    const zoom = zoomForFactor(factor, this.gameScale);
    if (Math.abs(zoom - this.camera.zoom) > 1e-9) this.setZoom(zoom);
  }

  /** "Reset zoom": the base zoom, and the remembered zoom is cleared (back to its default, 1). */
  resetZoom() {
    if (this.zoomSave) clearTimeout(this.zoomSave);
    this.zoomSave = 0;
    this.setZoom(this.baseZoom());
    this.settings.reset('zoomFactor');
  }

  /** Stop following the remembered zoom (the view is gone). A zoom that waits is stored first. */
  dispose() {
    this.flushZoom();
    this.offZoomFactor?.();
    this.offZoomFactor = null;
  }

  /**
   * A new game scale: the view keeps its centre, and the player's own zoom
   * (wheel, pinch, keys) and camera bookmarks keep their factor of the base zoom.
   */
  setGameScale(scale) {
    if (!Number.isFinite(scale) || scale <= 0 || scale === this.gameScale) return;
    const from = this.gameScale;
    const c = this.viewCenter();
    this.gameScale = scale;
    this.camera.zoom = rescaleZoom(this.camera.zoom, from, scale);
    for (const b of this.bookmarks.values()) b.zoom = rescaleZoom(b.zoom, from, scale);
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
    this.hooks.onSelectionChanged(this.selection, { byPlayer: true });
  }

  refreshSelection() {
    // Grouped actors that died (or changed owner) leave their group, and their number goes.
    this.groups.prune((list) => this.ownAlive(list));
    this.syncGroups();
    const alive = Array.from(this.game.selection());
    if (alive.length !== this.selection.length) {
      this.selection = alive;
      this.ownUnits = null;
      // Units died or boarded a transport: not the player's doing, so no voice.
      this.hooks.onSelectionChanged(this.selection, { byPlayer: false });
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
    // Clicking a selected MCV (or Construction Yard) deploys it, like the original;
    // a selected production structure becomes the primary one (3, OpenRA PrimaryBuilding).
    if (hit !== NONE && this.selection.includes(hit)) {
      if (deploy === 1 || deploy === 3) return { kind: 'deploy', id: hit };
      if (deploy === 2) return { kind: 'blocked' };
    }
    if (units.length) {
      // Own units and buildings are selected, unless the order targets them (dock, repair, enter a transport).
      const ownHit = hitInfo && hitInfo.owner === this.player;
      const targetsOwn = TARGETS_OWN.has(action);
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
    this.setMode(null);
  }

  // ---- Support powers (engine/src/powers.rs, js/powers.js) -------------------------

  /** Target a ready support power: click the map, or drag to set the flight direction. */
  startPowerTargeting(power) {
    this.placing = null;
    this.attackMove = false;
    this.setMode(null);
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

  /**
   * Switch a sidebar mode on ('sell', 'repair', 'powerDown', 'beacon') or
   * all off (null). Turning one on ends placement, targeting and attack move.
   */
  setMode(mode) {
    const next = MODES.includes(mode) ? mode : null;
    if (next) {
      this.cancelPlacing();
      this.attackMove = false;
      this.cancelPower();
      this.cancelTargeting();
    }
    if (next === this.mode) return;
    this.mode = next;
    this.repairDrag = null;
    this.hooks.onMode?.(this.mode);
  }

  /**
   * The mode's button or hotkey: on, or off again when it is on. Repair with
   * own structures selected repairs them instead (`repairSelection`).
   */
  toggleMode(mode) {
    if (mode === 'repair' && this.mode !== 'repair' && this.selectedOwnBuildings().length) {
      this.repairSelection();
      return;
    }
    this.setMode(this.mode === mode ? null : mode);
  }

  /** Selected structures that belong to the local player. */
  selectedOwnBuildings() {
    return this.selection.filter((id) => {
      const info = this.info(id);
      return info && info.owner === this.player && info.building;
    });
  }

  /**
   * Bulk repair of the selection: the own damaged structures selected start
   * repairing, or all stop when all are repairing (engine
   * `repair_buildings`). With none of them damaged, repair mode opens as usual.
   */
  async repairSelection() {
    const ids = await this.ask.repair_targets(this.player, Uint32Array.from(this.selectedOwnBuildings()));
    if (ids.length) this.game.repair_buildings(this.player, Uint32Array.from(ids));
    else this.setMode('repair');
  }

  /** Bulk repair of the own damaged structures in the box from world point `a` to `b` (repair mode). */
  async boxRepair(a, b) {
    const ids = await this.ask.repair_box(this.player, a.x, a.y, b.x, b.y);
    if (ids.length && this.mode === 'repair') this.game.repair_buildings(this.player, Uint32Array.from(ids));
  }

  /** The repair mode's drag box in world px ({ a, b }), or null while it is still a click. */
  repairBox() {
    const d = this.repairDrag;
    if (!d || Math.abs(d.ex - d.sx) + Math.abs(d.ey - d.sy) < CLICK_SLOP) return null;
    return { a: this.toWorld(d.sx, d.sy), b: this.toWorld(d.ex, d.ey) };
  }

  /** A left click on the map in a sidebar mode. */
  async modeClick(w) {
    const mode = this.mode;
    if (mode === 'beacon') {
      // OpenRA BeaconOrderGenerator: one beacon, then the mode ends.
      this.game.place_beacon(this.player, w.x, w.y);
      this.setMode(null);
      return;
    }
    const hit = await this.ask.pick(this.player, w.x, w.y);
    if (hit === NONE) return;
    if (mode === 'sell') {
      if ((await this.ask.sell_value(this.player, hit)) <= 0) return;
      this.game.sell(this.player, hit);
      this.flashOrder(w, ACTION.HARVEST);
    } else if (mode === 'repair') {
      const what = await this.ask.repair_cursor(this.player, hit);
      if (what === 1) {
        this.game.repair_building(this.player, hit);
      } else if (what === 2) {
        // An own damaged unit: off to its repair depot (OpenRA RepairOrderGenerator).
        const t = await this.ask.repair_unit_target(this.player, hit);
        if (t.length === 2) this.game.order_smart(this.player, Uint32Array.from([hit]), t[0], t[1]);
      }
    } else if (mode === 'powerDown') {
      if (await this.ask.can_power_down(this.player, hit)) this.game.power_down(this.player, hit);
    }
  }

  /** Whether the current mode can act on what is at world point `w` (the cursor). */
  modeTarget(w) {
    if (this.mode === 'beacon') return true;
    const box = this.mode === 'repair' ? this.repairBox() : null;
    // Dragging a repair box: whether it holds a structure to repair.
    if (box) return this.game.repair_box(this.player, box.a.x, box.a.y, box.b.x, box.b.y).length > 0;
    const hit = this.game.pick(this.player, w.x, w.y);
    if (hit === NONE) return false;
    if (this.mode === 'sell') return this.game.sell_value(this.player, hit) > 0;
    if (this.mode === 'repair') return this.game.repair_cursor(this.player, hit) > 0;
    if (this.mode === 'powerDown') return !!this.game.can_power_down(this.player, hit);
    return false;
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

  /**
   * The structure being placed where the mouse is, for its range circles
   * (engine range_circles.rs): `{ actor, cx, cy }`, or null when nothing is
   * placed or the mouse is off the battlefield.
   */
  placementState() {
    if (!this.placing || !this.mouse.inside) return null;
    const w = this.toWorld(this.mouse.x, this.mouse.y);
    return { actor: this.placing, ...this.placementCell(w.x, w.y) };
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
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.key);
      this.hotkeys.release(e);
    });
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.hotkeys.releaseAll();
    });
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
      if (this.mode) {
        this.setMode(null);
        return;
      }
      this.setSelection([]);
      return;
    }
    if (e.button !== 0) return;
    if (this.pressAction(w, e, p)) return;
    this.drag = { sx: p.x, sy: p.y, ex: p.x, ey: p.y, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey };
  }

  /**
   * The action button (left) went down at world point `w` with the modifiers
   * of `e`: the order generator in force takes it (support power, sidebar
   * mode, placement, ability targeting, armed command bar mode, minefield,
   * attack move). False when none did: the release then selects or gives the
   * smart order (finishClick). `at`: the view position, where a support
   * power's direction drag starts (null from the radar).
   */
  pressAction(w, e, at) {
    if (this.power) {
      // Target picked; mouse up fires it (a drag sets the direction).
      this.powerDrag = { x: w.x, y: w.y, sx: at?.x ?? 0, sy: at?.y ?? 0 };
      return true;
    }
    if (this.mode) {
      // Repair mode on the battlefield: a click repairs one, a drag a box (mouse up).
      if (this.mode === 'repair' && at) this.repairDrag = { sx: at.x, sy: at.y, ex: at.x, ey: at.y };
      else this.modeClick(w);
      return true;
    }
    if (this.placing) {
      const { cx, cy } = this.placementCell(w.x, w.y);
      this.placeAt(this.placing, cx, cy);
      return true;
    }
    if (this.targeting) {
      this.targetClick(w);
      return true;
    }
    if (this.hooks.commandMouseDown?.(w, e)) return true;
    if ((e.ctrlKey || e.metaKey) && this.selectedMinelayers().length) {
      this.mineDrag = { sx: w.x, sy: w.y, ex: w.x, ey: w.y, units: this.selectedMinelayers() };
      return true;
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
      return true;
    }
    return false;
  }

  /**
   * Whether a radar click may give an order: own units or a rally building
   * selected, or an order generator in force. Touch screens wait for the
   * tap there (js/touch.js radarTap); otherwise a touch pans at once.
   */
  radarMayOrder() {
    if (this.suspended || this.spectator || this.placing) return false;
    return !!(this.power || this.mode || this.targeting || this.attackMove || this.selectedOwnUnits().length || this.selectedRallyBuilding() !== null);
  }

  /**
   * A click on the radar at world point `w` (js/minimap.js). OpenRA's
   * RadarWidget hands the world a mouse down and up at that spot, so the
   * order generator in force acts there as a click on the battlefield would:
   * support powers, sidebar modes, ability targeting, the command bar's modes
   * and modifiers (force move, force attack, guard, Shift waypoints),
   * minefields, attack move, the smart order (move, attack, harvest, enter...)
   * and rally points. `mods`: { shift, ctrl, alt }. `button` 0 is the action
   * button (left, as on the battlefield); 2, the right button (the radar's
   * order button before, and OpenRA's in its modern mouse style), gives only
   * the selected units' orders. Selecting, deploying and placing structures
   * stay on the battlefield (OpenRA places where the mouse is, not at the
   * radar spot); spectators and replays give no orders. Resolves with true
   * when the click was an order; false leaves it to the radar, which moves
   * the camera there.
   */
  async radarClick(w, mods = {}, button = 0) {
    if (this.suspended || this.spectator || this.placing) return false;
    if ((this.power || this.mode || this.targeting) && button !== 0) return false;
    const e = { shiftKey: !!mods.shift, ctrlKey: !!mods.ctrl, metaKey: false, altKey: !!mods.alt };
    if (this.pressAction(w, e, null)) {
      // A down and an up at one spot: a support power without a direction, a one-cell minefield.
      if (this.powerDrag) this.firePower(null);
      if (this.mineDrag) this.layMines();
      return true;
    }
    return this.finishClick(w, { shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey }, { radar: true });
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
    if (this.repairDrag) {
      this.repairDrag.ex = p.x;
      this.repairDrag.ey = p.y;
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
      this.layMines();
      return;
    }
    if (e.button === 0 && this.repairDrag) {
      this.onMouseMove(e);
      const box = this.repairBox();
      const d = this.repairDrag;
      this.repairDrag = null;
      if (box) this.boxRepair(box.a, box.b);
      else this.modeClick(this.toWorld(d.sx, d.sy));
      return;
    }
    if (e.button === 0 && this.power && this.powerDrag) {
      const p = this.local(e);
      const t = this.powerDrag;
      const dragged = Math.abs(p.x - t.sx) + Math.abs(p.y - t.sy) >= 12;
      this.firePower(dragged ? this.toWorld(p.x, p.y) : null);
      return;
    }
    if (e.button !== 0 || !this.drag) return;
    const d = this.drag;
    this.drag = null;
    const a = this.toWorld(d.sx, d.sy);
    const b = this.toWorld(d.ex, d.ey);
    if (Math.abs(d.ex - d.sx) + Math.abs(d.ey - d.sy) < CLICK_SLOP) {
      this.finishClick(b, d);
      return;
    }
    this.boxSelect(a, b, d);
  }

  /** Lay the minefield of the Minelayers' drag (`mineDrag`). */
  layMines() {
    const m = this.mineDrag;
    this.mineDrag = null;
    this.game.order_lay_mines(this.player, Uint32Array.from(m.units), m.sx, m.sy, m.ex, m.ey);
    this.flashOrder({ x: m.ex, y: m.ey }, ACTION.HARVEST);
  }

  /** Fire the targeted support power at the picked spot, toward world point `dir` when dragged. */
  firePower(dir) {
    const t = this.powerDrag;
    this.game.activate_power(this.player, this.power.key, t.x, t.y, dir ? dir.x : undefined, dir ? dir.y : undefined);
    this.flashOrder(t, ACTION.ATTACK);
    this.cancelPower();
  }

  /**
   * A left click (no drag) at world point `b` with the drag's modifiers `d`.
   * From the radar (`radar`) only orders count: what would select or deploy
   * does nothing. Resolves with true when it gave an order.
   */
  async finishClick(b, d, { radar = false } = {}) {
    const now = performance.now();
    // Force move / force attack / queued orders (Alt, Ctrl, Shift + click).
    if (await this.hooks.commandClick?.(b, d)) return true;
    const intent = d.shift ? { kind: 'select' } : await this.clickIntentNow(b);
    if (intent.kind === 'order') {
      // The reply depends on what the order does (capture, C4, heal...).
      this.hooks.onSmartOrder?.(intent.action);
      this.game.order_smart(this.player, Uint32Array.from(intent.units), b.x, b.y);
      this.flashOrder(b, intent.action);
      // A plain move: the attack-move tip may apply (js/hints.js).
      if (intent.action === ACTION.MOVE) this.hooks.onPlainMove?.(intent.units, b);
      return true;
    }
    if (intent.kind === 'rally') {
      this.game.set_rally(this.player, this.selection[0], b.x, b.y);
      this.flashOrder(b, ACTION.MOVE);
      return true;
    }
    if (radar) return false;
    if (intent.kind === 'deploy') {
      this.game.deploy(this.player, Uint32Array.from([intent.id]));
      return true;
    }
    // Blocked deploy: nothing to do, the deploy cursor already shows why.
    if (intent.kind !== 'blocked') await this.clickSelect(b, d.shift, now, d);
    return false;
  }

  /**
   * The player a box or click selects for (engine: their actors first,
   * other players' ranked lower), or 255 for a spectator watching everyone.
   */
  selectionViewer() {
    return this.viewOwner() ?? 255;
  }

  /**
   * OpenRA box selection (WorldInteractionControllerWidget): the visible
   * actors in the box of the highest selection priority (engine/src/selection.rs);
   * Ctrl or Alt held (`mods`) raise the actors that allow it. Shift adds them
   * to the selection, otherwise they replace it.
   */
  async boxSelect(a, b, mods = {}) {
    const ids = Array.from(await this.ask.select_box(this.selectionViewer(), a.x, a.y, b.x, b.y, !!mods.ctrl, !!mods.alt));
    this.setSelection(mods.shift ? this.selection.concat(ids) : ids);
  }

  /** Whole map rectangle in world px, for map-wide selection. */
  mapRect() {
    return { x0: 0, y0: 0, x1: this.mapPx.w, y1: this.mapPx.h };
  }

  /**
   * OpenRA's click selection: the actor at world point `w` of the highest
   * selection priority less its distance (engine/src/selection.rs; Ctrl or
   * Alt in `mods` raise the actors that allow it) replaces the selection, or
   * nothing clears it; with Shift it is added or, when selected, taken out
   * (and a click on nothing changes nothing). `now`: when it was clicked, for
   * double clicks.
   */
  async clickSelect(w, shift, now = performance.now(), mods = {}) {
    const id = await this.ask.select_at(this.selectionViewer(), w.x, w.y, !!mods.ctrl, !!mods.alt);
    if (id !== NONE && id === this.lastClick.id && now - this.lastClick.time < DOUBLE_CLICK_MS) {
      this.lastClick = { time: 0, id: NONE };
      await this.selectSameClass(id);
      return;
    }
    this.lastClick = { time: now, id };
    if (!shift) this.setSelection(id === NONE ? [] : [id]);
    else if (id !== NONE) this.setSelection(this.selection.includes(id) ? this.selection.filter((s) => s !== id) : this.selection.concat([id]));
  }

  /**
   * OpenRA double click (WorldInteractionControllerWidget): the actors on
   * screen of the clicked actor's selection class join the selection, when
   * the clicked actor is one the viewer selects for (selectionOwners).
   */
  async selectSameClass(id) {
    const v = this.viewRect();
    const same = Array.from(await this.ask.select_by_class(this.selectionOwners(), Uint32Array.from([id]), v.x0, v.y0, v.x1, v.y1));
    if (same.length) this.setSelection(this.selection.concat(same));
  }

  onWheel(e) {
    e.preventDefault();
    if (this.suspended) return;
    const p = this.local(e);
    const before = this.toWorld(p.x, p.y);
    const factor = Math.exp(-e.deltaY * 0.0015);
    const zoom = this.camera.zoom;
    this.camera.zoom = clampZoom(zoom * factor, this.gameScale);
    this.camera.x = before.x - p.x / this.camera.zoom;
    this.camera.y = before.y - p.y / this.camera.zoom;
    this.clampCamera();
    if (this.camera.zoom !== zoom) this.zoomed();
  }

  onKeyDown(e) {
    // Held modifiers count wherever the focus is (the mine and command bar
    // cursors after leaving the chat line with Ctrl held); keyup drops them.
    if (MODIFIER_KEYS.has(e.key)) this.keys.add(e.key);
    // Typing in a text field, or a key that works the focused switch, slider
    // or list: not the game's (js/hotkeys.js focusKeepsKey; Esc in a switch is).
    if (focusKeepsKey(e)) return;
    if (this.suspended) return;
    this.keys.add(e.key);
    if (e.key === 'Escape') {
      // Esc cancels the current mode first; with nothing to cancel it opens the game menu.
      e.preventDefault();
      if (!this.cancelMode()) this.hooks.onMenu?.();
      return;
    }
    this.hotkeys.handle(e);
  }

  /** Cancel targeting, power, a sidebar mode, placement, a command bar mode or attack move. False when none was active. */
  cancelMode() {
    if (this.targeting) this.cancelTargeting();
    else if (this.power) this.cancelPower();
    else if (this.mode) this.setMode(null);
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

  // ---- Control groups (OpenRA ControlGroupsWidget, js/controlgroups.js) -------------

  /**
   * Hand the groups to the engine when they changed, for the numbers on the
   * selection boxes (engine/src/overlays.rs). Local UI state, like the selection.
   */
  syncGroups() {
    if (this.groups.version === this.groupsSent) return;
    this.groupsSent = this.groups.version;
    const { ids, groups } = this.groups.entries();
    this.game.set_control_groups(ids, groups);
  }

  /** Select group `key`; pressed twice quickly, also centre the camera on it. */
  groupSelect(key) {
    const { ids, center } = this.groups.recall(key, performance.now(), (list) => this.ownAlive(list));
    this.syncGroups();
    this.setSelection(ids);
    if (center) this.centerOnUnits(ids);
  }

  /** The player's own selected actors (units and structures), as OpenRA puts in groups. */
  selectedOwn() {
    return this.ownAlive(this.selection);
  }

  /** Make group `key` the selection (nothing selected: the group stays as it was). */
  groupCreate(key) {
    const ids = this.selectedOwn();
    if (ids.length) this.groups.assign(key, ids);
    this.syncGroups();
  }

  /** Add the selection to group `key`. */
  groupAddTo(key) {
    const ids = this.selectedOwn();
    if (ids.length) this.groups.add(key, ids);
    this.syncGroups();
  }

  /** Add group `key` to the selection. */
  groupCombine(key) {
    const ids = this.groups.members(key, (list) => this.ownAlive(list));
    this.syncGroups();
    if (ids.length) this.setSelection(this.selection.concat(ids));
  }

  /** Centre the camera on group `key` without selecting it. */
  groupJump(key) {
    const ids = this.groups.members(key, (list) => this.ownAlive(list));
    this.syncGroups();
    if (ids.length) this.centerOnUnits(ids);
  }

  // ---- Selection hotkeys --------------------------------------------------------------

  /**
   * The player whose actors the world hotkeys use: the local one, or the one
   * a spectator watches (none in the whole map view, like OpenRA without a
   * render player).
   */
  viewOwner() {
    return this.spectator && this.watchAll ? null : this.player;
  }

  /**
   * The players whose actors the selection keys and double click pick
   * (OpenRA GetPlayersToIncludeInSelection): the local player, the player a
   * spectator watches, or every player when a spectator watches the whole map.
   */
  selectionOwners() {
    const own = this.viewOwner();
    if (own !== null) return Uint8Array.from([own]);
    return Uint8Array.from({ length: this.game.player_count() }, (_, i) => i);
  }

  /** The selection hotkeys' feedback line and click (OpenRA ClickSound). */
  selected(count, where) {
    this.hooks.feedback?.(selectedUnitsText(count, where));
    this.hooks.selectionClick?.();
  }

  /**
   * OpenRA SelectAllUnits: the actors on screen of the highest selection
   * priority (combat units before support units, harvesters and
   * structures); when that selects no more than is selected already (the
   * key pressed again), the same across the whole map. `e`: the key event.
   * OpenRA hands the pressed key's modifiers to the priority
   * (`SubsetWithHighestSelectionPriority(e.Modifiers)`); the default key Q
   * has none, but bound to Ctrl+K (or Alt+Q) in Controls the key's Ctrl (Alt)
   * raises the actors that allow it, as in OpenRA.
   */
  async selectAllUnits(e = null) {
    if (this.hooks.gameOver?.()) return;
    const owners = this.selectionOwners();
    const ctrl = !!(e?.ctrlKey || e?.metaKey);
    const alt = !!e?.altKey;
    const v = this.viewRect();
    let ids = Array.from(await this.ask.select_all(owners, v.x0, v.y0, v.x1, v.y1, ctrl, alt));
    let where = 'screen';
    if (ids.length <= this.selection.length) {
      const m = this.mapRect();
      ids = Array.from(await this.ask.select_all(owners, m.x0, m.y0, m.x1, m.y1, ctrl, alt));
      where = 'map';
    }
    this.setSelection(ids);
    this.selected(ids.length, where);
  }

  /**
   * OpenRA SelectUnitsByType: the actors on screen of the selection classes
   * of the selected ones, added to the selection; when that is no more than
   * is selected already (the key pressed again), across the whole map.
   */
  async selectUnitsByType() {
    if (this.hooks.gameOver?.()) return;
    if (!this.selection.length) {
      // OpenRA plays ClickDisabledSound here, which is silent in Red Alert.
      this.hooks.feedback?.('Nothing selected.');
      return;
    }
    const owners = this.selectionOwners();
    const owned = this.selection.filter((id) => {
      const info = this.info(id);
      return info !== null && owners.includes(info.owner);
    });
    if (!owned.length) return;
    const types = Uint32Array.from(owned);
    const v = this.viewRect();
    let ids = Array.from(await this.ask.select_by_class(owners, types, v.x0, v.y0, v.x1, v.y1));
    let where = 'screen';
    if (ids.length <= this.selection.length) {
      const m = this.mapRect();
      ids = Array.from(await this.ask.select_by_class(owners, types, m.x0, m.y0, m.x1, m.y1));
      where = 'map';
    }
    this.setSelection(this.selection.concat(ids));
    this.selected(ids.length, where);
  }

  /** Select the next actor of `list` after the selected one and centre the camera on it. */
  async selectNext(list) {
    if (this.viewOwner() === null) return;
    const next = nextInCycle(Array.from(list), this.selection);
    if (next === null) return;
    this.setSelection([next]);
    const c = await this.ask.units_center(this.viewOwner(), Uint32Array.from([next]));
    if (c.length === 2) this.centerOn(c[0], c[1]);
  }

  /** OpenRA CycleBase: the next Construction Yard or MCV (else the first structure). */
  async cycleBase() {
    if (this.viewOwner() === null) return;
    await this.selectNext(await this.ask.base_actors(this.viewOwner()));
  }

  /** OpenRA CycleHarvesters: the next harvester on the map. */
  async cycleHarvesters() {
    if (this.viewOwner() === null) return;
    await this.selectNext(await this.ask.harvesters(this.viewOwner()));
  }

  /** OpenRA CycleProductionBuildings: the next factory, barracks, yard or airfield. */
  async cycleProductionBuildings() {
    if (this.viewOwner() === null) return;
    await this.selectNext(await this.ask.production_buildings(this.viewOwner()));
  }

  /**
   * OpenRA SelectProductionBuilding: select the structure that builds what
   * the production tab `queue` makes; when it already is the selection,
   * centre the camera on it.
   */
  async selectProductionBuilding(queue) {
    const id = await this.ask.queue_producer(this.player, queue);
    if (id === NONE) return;
    if (this.selection.length === 1 && this.selection[0] === id) {
      await this.centerOnUnits([id]);
      return;
    }
    this.setSelection([id]);
  }

  /** Register this class's hotkey actions (OpenRA's RA defaults, js/hotkeys.js). Returns an unregister function. */
  registerHotkeys() {
    const offs = [];
    // name: the WebRA action; ora: its OpenRA hotkey (defaults, description,
    // section, contexts). Spectators only get OpenRA's spectator hotkeys.
    const reg = (name, ora, handler, opts = {}) => {
      if (this.spectator && !OPENRA_HOTKEYS[ora].contexts.includes('spectator')) return;
      offs.push(this.hotkeys.registerAction(name, undefined, handler, { openra: ora, ...opts }));
    };
    const units = () => Uint32Array.from(this.selectedOwnUnits());
    // Game commands: sidebar modes, selection and the camera on the world.
    reg('sell', 'Sell', () => this.toggleMode('sell'));
    reg('repair', 'Repair', () => this.toggleMode('repair'));
    reg('powerDown', 'PowerDown', () => this.toggleMode('powerDown'));
    reg('placeBeacon', 'PlaceBeacon', () => this.toggleMode('beacon'));
    reg('base', 'CycleBase', () => this.cycleBase());
    reg('toLastEvent', 'ToLastEvent', () => {
      const at = this.hooks.lastEvent?.();
      if (at) this.centerOn(at.x, at.y);
    });
    reg('toSelection', 'ToSelection', () => this.centerOnUnits(this.selection));
    reg('selectAll', 'SelectAllUnits', (e) => this.selectAllUnits(e));
    reg('selectByType', 'SelectUnitsByType', () => this.selectUnitsByType());
    reg('cycleHarvesters', 'CycleHarvesters', () => this.cycleHarvesters());
    // Unit commands.
    reg('attackMove', 'AttackMove', () => {
      if (this.selectedOwnUnits().length) this.attackMove = true;
    });
    reg('stop', 'Stop', () => {
      if (this.selectedOwnUnits().length) this.game.order_stop(this.player, units());
    });
    reg('deploy', 'Deploy', () => this.deploySelection());
    // Viewport: scrolling (held), map edges, zoom and bookmarks.
    reg('mapScrollUp', 'MapScrollUp', () => {}, { hold: true });
    reg('mapScrollDown', 'MapScrollDown', () => {}, { hold: true });
    reg('mapScrollLeft', 'MapScrollLeft', () => {}, { hold: true });
    reg('mapScrollRight', 'MapScrollRight', () => {}, { hold: true });
    reg('jumpTop', 'MapJumpToTopEdge', () => this.jumpToEdge(0, -1));
    reg('jumpBottom', 'MapJumpToBottomEdge', () => this.jumpToEdge(0, 1));
    reg('jumpLeft', 'MapJumpToLeftEdge', () => this.jumpToEdge(-1, 0));
    reg('jumpRight', 'MapJumpToRightEdge', () => this.jumpToEdge(1, 0));
    for (let i = 1; i <= BOOKMARKS; i++) {
      reg(`bookmarkSave${i}`, `MapBookmarkSave0${i}`, () => {
        const c = this.viewCenter();
        this.bookmarks.set(i, { x: c.x, y: c.y, zoom: this.camera.zoom });
      });
      reg(`bookmarkJump${i}`, `MapBookmarkRestore0${i}`, () => {
        const b = this.bookmarks.get(i);
        if (!b) return;
        const zoom = this.camera.zoom;
        this.camera.zoom = clampZoom(b.zoom, this.gameScale);
        this.centerOn(b.x, b.y);
        if (this.camera.zoom !== zoom) this.zoomed();
      });
    }
    const zoomTo = (next) => {
      const zoom = this.camera.zoom;
      this.setZoom(next);
      if (this.camera.zoom !== zoom) this.zoomed();
    };
    reg('zoomIn', 'ZoomIn', () => zoomTo(this.camera.zoom * 1.25), { repeat: true });
    reg('zoomOut', 'ZoomOut', () => zoomTo(this.camera.zoom / 1.25), { repeat: true });
    reg('resetZoom', 'ResetZoom', () => this.resetZoom());
    // Control groups: 1..9, 0 select (twice: centre), Ctrl creates, Ctrl+Shift
    // adds the selection, Shift adds the group to the selection, Alt jumps.
    for (let n = 1; n <= 10; n++) {
      const key = String(n % 10);
      const nn = String(n).padStart(2, '0');
      reg(`controlGroupSelect${nn}`, `ControlGroupSelect${nn}`, () => this.groupSelect(key));
      reg(`controlGroupCreate${nn}`, `ControlGroupCreate${nn}`, () => this.groupCreate(key));
      reg(`controlGroupAddTo${nn}`, `ControlGroupAddTo${nn}`, () => this.groupAddTo(key));
      reg(`controlGroupCombineWith${nn}`, `ControlGroupCombineWith${nn}`, () => this.groupCombine(key));
      reg(`controlGroupJumpTo${nn}`, `ControlGroupJumpTo${nn}`, () => this.groupJump(key));
    }
    reg('removeFromControlGroup', 'RemoveFromControlGroup', () => {
      this.groups.remove(this.selectedOwn());
      this.syncGroups();
    });
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
    this.hotkeys.releaseAll();
    this.drag = null;
    this.pan = null;
    this.mineDrag = null;
    this.repairDrag = null;
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
    // OpenRA MapScroll hotkeys (arrow keys by default): held keys of the registry.
    if (this.hotkeys.isHeld('mapScrollLeft')) kx -= 1;
    if (this.hotkeys.isHeld('mapScrollRight')) kx += 1;
    if (this.hotkeys.isHeld('mapScrollUp')) ky -= 1;
    if (this.hotkeys.isHeld('mapScrollDown')) ky += 1;
    const edgeSpeed = this.settings.get('edgeScrollSpeed');
    let ex = 0;
    let ey = 0;
    if (edgeSpeed > 0 && this.mouse.inside && !this.mouse.touch && !this.drag && !this.repairDrag && !this.pan) {
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
    // Like Red Alert: at the screen edge the scroll arrow wins over every mode.
    const cursor = this.edgeScroll
      ? scrollCursor(this.edgeScroll.dx, this.edgeScroll.dy, this.edgeScroll.blocked)
      : this.cursorAt(this.mouse.inside ? this.toWorld(this.mouse.x, this.mouse.y) : null, this.heldMods(), { busy: !!(this.drag || this.pan) });
    if (this.cursor !== cursor) {
      this.cursor = cursor;
      this.canvas.style.cursor = cursor;
    }
  }

  /** The held modifier keys: { ctrl, alt, shift } (Cmd counts as Ctrl). */
  heldMods() {
    const k = this.keys;
    return { ctrl: k.has('Control') || k.has('Meta'), alt: k.has('Alt'), shift: k.has('Shift') };
  }

  /**
   * The cursor over world point `w` (null: the mouse is off the battlefield)
   * with modifiers `mods`: what the order generator in force would do there
   * (OpenRA IOrderGenerator.GetCursor). `busy`: a box selection or pan is
   * under way. `radar`: the radar asks (radarCursor), where only orders show
   * their cursor, since a click there that is no order moves the camera.
   */
  cursorAt(w, mods, { busy = false, radar = false } = {}) {
    if (this.mode) {
      // Sidebar modes: their cursor where they can act, the blocked one elsewhere.
      const [ok, blocked] = MODE_CURSORS[this.mode];
      return w && this.modeTarget(w) ? ok : blocked;
    }
    if (this.targeting && w) {
      const t = this.targeting;
      if (t.kind === 'teleport') return this.game.teleport_valid(this.player, Uint32Array.from(t.ids), w.x, w.y) ? CURSORS.teleport : CURSORS.blocked;
      return POWER_CURSORS[t.power] ?? CURSORS.select;
    }
    if (this.mineDrag || (mods.ctrl && w && !busy && this.selectedMinelayers().length)) return CURSORS.mine;
    if (this.power) return CURSORS.attack;
    if (this.placing) {
      // The footprint preview shows the cells; the cursor shows the spot.
      if (!w || radar) return CURSORS.select;
      return this.placementValid() ? CURSORS.place : CURSORS.blocked;
    }
    if (this.attackMove) return CURSORS.attackMove;
    if (!w || busy) return CURSORS.select;
    // Command bar: an armed mode or held Ctrl / Alt / Shift.
    const command = this.hooks.commandCursor?.(w, mods) ?? null;
    if (command) return command;
    const intent = this.clickIntent(w);
    if (intent.kind === 'order') return ACTION_CURSORS[intent.action] ?? CURSORS.select;
    if (intent.kind === 'rally') return CURSORS.rally;
    if (radar) return CURSORS.select;
    if (intent.kind === 'deploy') return CURSORS.deploy;
    if (intent.kind === 'blocked') return CURSORS.blocked;
    return CURSORS.select;
  }

  /**
   * The cursor over the radar at world point `w` with modifiers `mods`
   * (OpenRA RadarWidget.GetCursor): the cursor a left click there would get
   * on the battlefield, in its radar variant ("move-minimap" ...) when the
   * installed cursors have one; the plain arrow where a click moves the
   * camera (no order there, spectators, placing a structure).
   */
  radarCursor(w, mods) {
    const cursor = this.suspended || this.spectator ? CURSORS.select : this.cursorAt(w, mods, { radar: true });
    return minimapCursor(cursor);
  }

  /** Short marker where an order was given, like the original's flashing target. */
  flashOrder(w, action) {
    this.orderFlash = { x: w.x, y: w.y, action, until: performance.now() + 450 };
  }

  /** UI rectangles (world space) for the drag box and placement preview. */
  uiRects() {
    const out = [];
    const push = (x, y, w, h, r, g, b, a) => out.push(x, y, w, h, r, g, b, a);
    // A drag box from world point a to b: an outline over a faint fill.
    const box = (a, b, r, g, bl, fill) => {
      const x0 = Math.min(a.x, b.x);
      const y0 = Math.min(a.y, b.y);
      const w = Math.abs(b.x - a.x);
      const h = Math.abs(b.y - a.y);
      const t = 1 / this.camera.zoom;
      push(x0, y0, w, h, r, g, bl, fill);
      push(x0, y0, w, t, r, g, bl, 0.9);
      push(x0, y0 + h - t, w, t, r, g, bl, 0.9);
      push(x0, y0, t, h, r, g, bl, 0.9);
      push(x0 + w - t, y0, t, h, r, g, bl, 0.9);
    };
    // White, like OpenRA's selection box.
    if (this.drag) box(this.toWorld(this.drag.sx, this.drag.sy), this.toWorld(this.drag.ex, this.drag.ey), 1, 1, 1, 0.06);
    // Bulk repair box: the repair cursor's yellow.
    const repairBox = this.mode === 'repair' ? this.repairBox() : null;
    if (repairBox) box(repairBox.a, repairBox.b, 0.95, 0.79, 0.3, 0.08);
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

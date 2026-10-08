// Command bar: OpenRA's bottom-left panel of orders for the selected units
// (engine/src/commands.rs). A compact row of icon buttons over the bottom-left
// corner of the battlefield:
//
//   Attack move (A)    move, attacking enemies met on the way
//   Force move         Alt+click: move there whatever is under the cursor
//   Force attack       Ctrl+click: fire on the ground, or on any unit (own too)
//   Guard (G)          then click an own or allied unit to follow and protect
//   Deploy (D)         MCVs, transports, ability units
//   Scatter (X)        each unit steps to a random free neighbouring cell
//   Stop (S)
//   Queue orders       Shift+click (or this toggle): add waypoints
//
// and the fire stances (C cycles): Attack anything, Defend, Return fire, Hold
// fire. A stance shared by part of the selection shows as mixed.
//
// Buttons enable and disable with the selection (`Game.command_state`). The
// armed modes (force move, force attack, guard) act on the next left click on
// the map; Shift keeps them armed, like attack-move. Esc or right click
// disarms them. js/input.js asks this bar first through its hooks
// (commandMouseDown, commandClick, commandCursor, cancelCommand, queueAttackMove).

import { CURSORS } from './cursors.js';

const NONE = 0xffffffff;
const OUTLINE = '#101010';

/** Fire stances, as the engine names them (rules.rs Stance), in bar order. */
export const STANCES = [
  { id: 'attack_anything', label: 'Attack anything', help: 'Attack enemies that come into range, and chase them.' },
  { id: 'defend', label: 'Defend', help: 'Attack enemies in range without moving.' },
  { id: 'return_fire', label: 'Return fire', help: 'Only shoot back at attackers in range.' },
  { id: 'hold_fire', label: 'Hold fire', help: 'Never fire unless ordered to.' },
];

/** Order buttons: id, label, key action (or a modifier hint) and help text. */
export const COMMANDS = [
  { id: 'attackMove', label: 'Attack move', key: 'A', help: 'Move, attacking enemies on the way.' },
  { id: 'forceMove', label: 'Force move', hint: 'Alt+click', help: 'Move there, whatever is under the cursor.' },
  { id: 'forceAttack', label: 'Force attack', hint: 'Ctrl+click', help: 'Fire on the ground or on any unit, own ones too.' },
  { id: 'guard', label: 'Guard', action: 'command-guard', key: 'G', help: 'Click a unit to follow and protect it.' },
  { id: 'deploy', label: 'Deploy', key: 'D', help: 'Deploy, unload or use the ability of the selected units.' },
  { id: 'scatter', label: 'Scatter', action: 'command-scatter', key: 'X', help: 'Each unit steps aside to a free spot nearby.' },
  { id: 'stop', label: 'Stop', key: 'S', help: 'Stop what the units are doing.' },
  { id: 'queue', label: 'Queue orders', hint: 'Shift+click', help: 'Add waypoints: moves run one after another.' },
];

// ---- Icons ------------------------------------------------------------------------------
// 24x24, drawn like the cursors: bold shapes, dark outline, one strong colour.

const stroke = (d, color, w = 2.4) =>
  `<path d="${d}" fill="none" stroke="${OUTLINE}" stroke-width="${w + 2.4}" stroke-linecap="round" stroke-linejoin="round"/>` +
  `<path d="${d}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
const shape = (d, color) => `<path d="${d}" fill="${color}" stroke="${OUTLINE}" stroke-width="1.6" stroke-linejoin="round"/>`;
const ring = (cx, cy, r, color) =>
  `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${OUTLINE}" stroke-width="4.4"/><circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="2"/>`;
const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">${body}</svg>`;

const RED = '#e0473a';
const GOLD = '#f2c94c';
const GREEN = '#5fbf4a';
const OLIVE = '#a3b05a';
const ORANGE = '#ffa030';
const STEEL = '#b9c3c6';

const SHIELD = 'M12 2.5 L19.5 5.5 L19 12 C18.5 16.5 15.5 19.5 12 21.5 C8.5 19.5 5.5 16.5 5 12 L4.5 5.5 Z';

export const ICONS = {
  attackMove: svg(ring(10, 11, 6, ORANGE) + stroke('M10 3 L10 7 M10 15 L10 19 M2 11 L6 11', ORANGE, 2) + stroke('M14 19 L21 19 M18 16 L21 19 L18 22', ORANGE, 2)),
  forceMove: svg(stroke('M4 7 L9 12 L4 17 M11 7 L16 12 L11 17', GREEN) + stroke('M20 5 L20 14', GREEN) + `<circle cx="20" cy="19" r="1.8" fill="${GREEN}" stroke="${OUTLINE}" stroke-width="1.2"/>`),
  forceAttack: svg(ring(12, 12, 7.5, RED) + stroke('M12 2 L12 7 M12 17 L12 22 M2 12 L7 12 M17 12 L22 12', RED, 2) + stroke('M9.5 9.5 L14.5 14.5 M14.5 9.5 L9.5 14.5', RED, 1.8)),
  guard: svg(shape(SHIELD, OLIVE) + stroke('M12 6.5 L12 17 M8 11 L16 11', '#1b1f19', 1.6)),
  deploy: svg(shape('M4 14 L20 14 L20 20 L4 20 Z', GOLD) + stroke('M12 3 L12 11 M8.5 7.5 L12 11 L15.5 7.5', GOLD)),
  scatter: svg(stroke('M12 12 L5 5 M5 5 L5 9.5 M5 5 L9.5 5 M12 12 L19 5 M19 5 L14.5 5 M19 5 L19 9.5 M12 12 L5 19 M5 19 L5 14.5 M5 19 L9.5 19 M12 12 L19 19 M19 19 L19 14.5 M19 19 L14.5 19', GOLD, 2)),
  stop: svg(shape('M8 3 L16 3 L21 8 L21 16 L16 21 L8 21 L3 16 L3 8 Z', RED) + `<rect x="8" y="8" width="8" height="8" fill="#f4efe0" stroke="${OUTLINE}" stroke-width="1.2"/>`),
  queue: svg(stroke('M4 20 L8 16 M10.5 13.5 L13.5 10.5', GREEN, 2) + shape('M14 3 L14 13', GREEN) + stroke('M14 3 L14 12', STEEL, 1.6) + shape('M14.5 3.5 L21 6 L14.5 8.5 Z', GREEN) + `<circle cx="4" cy="20" r="2" fill="${GREEN}" stroke="${OUTLINE}" stroke-width="1.2"/>`),
  attack_anything: svg(stroke('M5 13 L12 6 L19 13 M5 19 L12 12 L19 19', RED)),
  defend: svg(shape(SHIELD, STEEL) + stroke('M9 12 L11.5 14.5 L15.5 9.5', '#1b1f19', 1.8)),
  return_fire: svg(stroke('M3 8 L17 8 M13 4 L17 8 L13 12', ORANGE, 2.2) + stroke('M21 16 L7 16 M11 12 L7 16 L11 20', ORANGE, 2.2)),
  hold_fire: svg(ring(12, 12, 7.5, STEEL) + stroke('M12 2 L12 6 M12 18 L12 22 M2 12 L6 12 M18 12 L22 12', STEEL, 2) + stroke('M5 19 L19 5', RED, 2.4)),
};

// ---- Cursors for the armed modes ----------------------------------------------------------

function svgCursor(body, hx, hy, fallback) {
  const s = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">${body}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(s)}") ${hx} ${hy}, ${fallback}`;
}

export const COMMAND_CURSORS = {
  /** Fire on the ground: the attack reticle with a cross on the spot. */
  attackGround: svgCursor(
    `<g transform="translate(4 4)">${ring(12, 12, 8, RED)}${stroke('M8 8 L16 16 M16 8 L8 16', RED, 2.2)}</g>`,
    16,
    16,
    'crosshair',
  ),
  /** Guard: a shield over the unit to protect. */
  guard: svgCursor(`<g transform="translate(4 3)">${shape(SHIELD, OLIVE)}${stroke('M12 6.5 L12 17 M8 11 L16 11', '#1b1f19', 1.6)}</g>`, 16, 16, 'pointer'),
  /** Queued move: the move chevrons with a waypoint flag. */
  waypoint: svgCursor(
    `<g transform="translate(2 2)">${stroke('M5 6 L11 12 L5 18', GREEN, 2.6)}${stroke('M12 6 L18 12 L12 18', GREEN, 2.6)}</g>${shape('M22 14 L22 30', GREEN)}${shape('M22.5 14 L30 17 L22.5 20 Z', GREEN)}`,
    13,
    14,
    'pointer',
  ),
};

// ---- Pure state ----------------------------------------------------------------------------

/**
 * Button states for a selection. `cmd` is `Game.command_state(...)` (parsed),
 * `deploy` is Input.deployState() (0 none, 1 now, 2 blocked), `active` tells
 * which modes are armed: { attackMove, forceMove, forceAttack, guard, queue }.
 * Returns { commands: { id: { enabled, active } }, stances: { id: 'all' |
 * 'some' | 'none' }, stancesEnabled }.
 */
export function barState(cmd, deploy, active = {}) {
  const units = cmd?.units ?? 0;
  const enabled = {
    attackMove: units > 0,
    forceMove: units > 0,
    forceAttack: (cmd?.armed ?? 0) > 0,
    guard: (cmd?.guard ?? 0) > 0,
    deploy: deploy !== 0,
    scatter: (cmd?.scatter ?? 0) > 0,
    stop: units > 0,
    queue: units > 0,
  };
  const commands = {};
  for (const c of COMMANDS) commands[c.id] = { enabled: enabled[c.id], active: !!active[c.id] && enabled[c.id] };
  const counts = cmd?.stances ?? {};
  const total = STANCES.reduce((n, s) => n + (counts[s.id] ?? 0), 0);
  const stances = {};
  for (const s of STANCES) {
    const n = counts[s.id] ?? 0;
    stances[s.id] = n === 0 ? 'none' : n === total ? 'all' : 'some';
  }
  return { commands, stances, stancesEnabled: total > 0 };
}

/** Stance counts once every actor took `stance`. */
export function pendingStances(counts, stance) {
  const total = STANCES.reduce((n, s) => n + (counts[s.id] ?? 0), 0);
  return Object.fromEntries(STANCES.map((s) => [s.id, s.id === stance ? total : 0]));
}

/** The stance after the current one for the stance cycle key (the most used one counts). */
export function nextStance(cmd) {
  const counts = cmd?.stances ?? {};
  let best = -1;
  let bestN = 0;
  STANCES.forEach((s, i) => {
    if ((counts[s.id] ?? 0) > bestN) {
      bestN = counts[s.id];
      best = i;
    }
  });
  if (best < 0) return null;
  return STANCES[(best + 1) % STANCES.length].id;
}

/**
 * What a left click on the map does in a command mode or with a modifier.
 * `c`: { mode: null | 'forceMove' | 'forceAttack' | 'guard', queue (sticky
 * queue mode), shift, ctrl, alt, hit (actor id or NONE), hitOwner (or null),
 * player, allied(owner): bool, selected(id): bool, canAttackGround: bool,
 * canGuard: bool }.
 * Returns null (not a command click: normal selection and smart orders) or
 * { kind: 'attack', target } | { kind: 'attackGround' } | { kind: 'move' } |
 * { kind: 'waypoint', attackMove } | { kind: 'guard', target } | { kind: 'ignore' }.
 */
export function commandClick(c) {
  const hitActor = c.hit !== NONE && c.hitOwner !== null;
  const forceAttack = c.mode === 'forceAttack' || c.ctrl;
  const forceMove = c.mode === 'forceMove' || c.alt;
  if (c.mode === 'guard') {
    return hitActor && c.canGuard ? { kind: 'guard', target: c.hit } : { kind: 'ignore' };
  }
  if (forceAttack) {
    if (hitActor && !c.selected(c.hit)) return { kind: 'attack', target: c.hit };
    return c.canAttackGround ? { kind: 'attackGround' } : { kind: 'ignore' };
  }
  if (forceMove) return { kind: 'move' };
  if (c.shift || c.queue) {
    // Shift+click on an own unit still adds it to (or takes it out of) the selection.
    if (hitActor && c.hitOwner === c.player) return null;
    const enemy = hitActor && !c.allied(c.hitOwner);
    return { kind: 'waypoint', attackMove: enemy };
  }
  return null;
}

// ---- The bar --------------------------------------------------------------------------

export class CommandBar {
  /**
   * @param {HTMLElement} parent the battlefield element
   * @param {{ game, input, player: number, registerAction: Function, keyOf?: (name: string) => string | null }} opts
   */
  constructor(parent, { game, input, player, registerAction, keyOf }) {
    this.game = game;
    this.input = input;
    this.player = player;
    this.mode = null; // armed one-click mode: 'forceMove' | 'forceAttack' | 'guard'
    this.queue = false; // sticky queue-orders toggle
    this.cmd = null;
    this.state = null;
    this.keyOf = keyOf ?? (() => null);
    this.root = document.createElement('div');
    this.root.id = 'commandbar';
    this.root.setAttribute('role', 'toolbar');
    this.root.setAttribute('aria-label', 'Unit commands');
    this.buttons = new Map();
    const orders = document.createElement('div');
    orders.className = 'cb-group';
    const stances = document.createElement('div');
    stances.className = 'cb-group cb-stances';
    stances.setAttribute('role', 'group');
    stances.setAttribute('aria-label', 'Fire stance');
    for (const c of COMMANDS) orders.appendChild(this.button(c.id, ICONS[c.id], () => this.run(c.id)));
    for (const s of STANCES) stances.appendChild(this.button(s.id, ICONS[s.id], () => this.setStance(s.id)));
    this.root.append(orders, stances);
    // Keep clicks and keys on the bar away from the map: a mousedown would
    // deselect, Space would also jump to the base.
    this.root.addEventListener('mousedown', (e) => e.stopPropagation());
    this.root.addEventListener('keydown', (e) => this.onKeyDown(e));
    parent.appendChild(this.root);
    registerAction('command-guard', 'G', () => this.run('guard'), { label: 'Guard', group: 'Orders' });
    registerAction('command-scatter', 'X', () => this.run('scatter'), { label: 'Scatter', group: 'Orders' });
    registerAction('command-stance-cycle', 'C', () => this.cycleStance(), { label: 'Cycle fire stance', group: 'Orders' });
    this.update();
  }

  button(id, icon, onClick) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `cb-button cb-${id}`;
    el.innerHTML = icon;
    el.addEventListener('click', (e) => {
      onClick();
      // A mouse click leaves the keyboard to the game (Space, letters).
      if (e.detail > 0) el.blur();
    });
    this.buttons.set(id, el);
    return el;
  }

  /** Arrow keys move along the bar; Enter and Space stay with the button. */
  onKeyDown(e) {
    if (e.key === ' ' || e.key === 'Enter') {
      e.stopPropagation();
      return;
    }
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const list = [...this.buttons.values()].filter((b) => !b.disabled);
    const i = list.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    e.stopPropagation();
    list[(i + (e.key === 'ArrowRight' ? 1 : list.length - 1)) % list.length].focus();
  }

  units() {
    return this.input.selectedOwnUnits();
  }

  /** Refresh from the selection (call on selection changes and every UI tick). */
  update() {
    const ids = Uint32Array.from(this.input.selection);
    this.cmd = JSON.parse(this.game.command_state(this.player, ids));
    const p = this.pending;
    if (p && (p.ids !== this.input.selection.join(',') || performance.now() > p.until || this.cmd.stances[p.stance] > 0)) {
      this.pending = null;
    }
    if (this.pending) this.cmd.stances = pendingStances(this.cmd.stances, this.pending.stance);
    const active = { attackMove: this.input.attackMove, forceMove: this.mode === 'forceMove', forceAttack: this.mode === 'forceAttack', guard: this.mode === 'guard', queue: this.queue };
    this.state = barState(this.cmd, this.input.deployState(), active);
    // A mode whose button went dark (selection changed) is dropped.
    if (this.mode && !this.state.commands[this.mode].enabled) this.mode = null;
    if (this.queue && !this.state.commands.queue.enabled) this.queue = false;
    for (const c of COMMANDS) {
      const el = this.buttons.get(c.id);
      const st = this.state.commands[c.id];
      el.disabled = !st.enabled;
      el.classList.toggle('active', st.active);
      if (c.id !== 'deploy' && c.id !== 'stop' && c.id !== 'scatter') el.setAttribute('aria-pressed', String(st.active));
      const key = (c.action && this.keyOf(c.action)) || c.key || c.hint;
      const text = `${c.label} (${key})`;
      el.title = `${text}: ${c.help}`;
      el.setAttribute('aria-label', text);
    }
    const cycle = this.keyOf('command-stance-cycle') ?? 'C';
    for (const s of STANCES) {
      const el = this.buttons.get(s.id);
      const st = this.state.stances[s.id];
      el.disabled = !this.state.stancesEnabled;
      el.classList.toggle('active', st === 'all');
      el.classList.toggle('mixed', st === 'some');
      el.setAttribute('aria-pressed', st === 'all' ? 'true' : st === 'some' ? 'mixed' : 'false');
      const mixed = st === 'some' ? ' (some of the selection)' : '';
      el.title = `${s.label}${mixed}: ${s.help} (${cycle} cycles stances)`;
      el.setAttribute('aria-label', `Stance: ${s.label}${mixed}`);
    }
  }

  run(id) {
    if (!this.state?.commands[id]?.enabled) return;
    const units = Uint32Array.from(this.units());
    switch (id) {
      case 'attackMove':
        this.mode = null;
        this.input.attackMove = true;
        break;
      case 'forceMove':
      case 'forceAttack':
      case 'guard':
        this.input.attackMove = false;
        this.mode = this.mode === id ? null : id;
        break;
      case 'deploy':
        this.input.deploySelection();
        break;
      case 'scatter':
        this.game.order_scatter(this.player, units);
        break;
      case 'stop':
        this.game.order_stop(this.player, units);
        break;
      case 'queue':
        this.queue = !this.queue;
        break;
    }
    this.update();
  }

  setStance(stance) {
    if (!this.state?.stancesEnabled) return;
    this.game.set_stance(this.player, Uint32Array.from(this.input.selection), stance);
    // The engine applies it on the next tick (online: a few ticks later); show it at once.
    this.pending = { stance, ids: this.input.selection.join(','), until: performance.now() + 1000 };
    this.update();
  }

  cycleStance() {
    const next = nextStance(this.cmd);
    if (next) this.setStance(next);
  }

  // ---- Hooks for js/input.js ----------------------------------------------------------

  /** Esc or right click: disarm a mode. True when something was disarmed. */
  cancel() {
    if (!this.mode && !this.queue) return false;
    this.mode = null;
    this.queue = false;
    this.update();
    return true;
  }

  /** Left mouse down on the map while a mode is armed: give that order. */
  mouseDown(w, e) {
    if (!this.mode) return false;
    this.click(w, { shift: e.shiftKey, ctrl: false, alt: false });
    if (!e.shiftKey) this.mode = null;
    this.update();
    return true;
  }

  context(w, mods) {
    const units = this.units();
    const hit = this.game.pick(this.player, w.x, w.y);
    const info = hit === NONE ? null : JSON.parse(this.game.actor_json(hit));
    const ids = Uint32Array.from(units);
    return {
      units,
      ids,
      c: {
        mode: this.mode,
        queue: this.queue,
        shift: !!mods.shift,
        ctrl: !!mods.ctrl,
        alt: !!mods.alt,
        hit,
        hitOwner: info ? info.owner : null,
        player: this.player,
        allied: (owner) => owner === this.player || this.game.are_allies(this.player, owner),
        selected: (id) => this.input.selection.includes(id),
        canAttackGround: units.length > 0 && this.game.can_attack_ground(this.player, ids, w.x, w.y),
        canGuard: hit !== NONE && units.length > 0 && this.game.can_guard(this.player, ids, hit),
      },
    };
  }

  /**
   * A left click on the map (no drag) with modifiers { shift, ctrl, alt }.
   * Returns true when it was a command (handled here).
   */
  click(w, mods) {
    const { units, ids, c } = this.context(w, mods);
    if (!units.length) return false;
    const order = commandClick(c);
    if (!order) return false;
    switch (order.kind) {
      case 'attack':
        this.game.order_attack(this.player, ids, order.target);
        this.input.flashOrder(w, 2);
        break;
      case 'attackGround':
        this.game.order_attack_ground(this.player, ids, w.x, w.y);
        this.input.flashOrder(w, 2);
        break;
      case 'move':
        if (mods.shift || this.queue) this.game.order_waypoint(this.player, ids, w.x, w.y, false);
        else this.game.order_move(this.player, ids, w.x, w.y, false);
        this.input.flashOrder(w, 1);
        break;
      case 'waypoint':
        this.game.order_waypoint(this.player, ids, w.x, w.y, order.attackMove);
        this.input.flashOrder(w, order.attackMove ? 2 : 1);
        break;
      case 'guard':
        this.game.order_guard(this.player, ids, order.target);
        this.input.flashOrder(w, 1);
        break;
    }
    return true;
  }

  /** Shift (or the queue toggle) with an attack-move click: queue it instead. */
  queuesAttackMove(shift) {
    return shift || this.queue;
  }

  /** Cursor for the map position with the held modifiers, or null for the default. */
  cursor(w, mods) {
    if (!this.mode && !mods.ctrl && !mods.alt && !mods.shift && !this.queue) return null;
    const { units, c } = this.context(w, mods);
    if (!units.length) return null;
    const order = commandClick(c);
    if (!order) return null;
    switch (order.kind) {
      case 'attack':
        return this.cmd?.armed ? CURSORS.attack : CURSORS.blocked;
      case 'attackGround':
        return COMMAND_CURSORS.attackGround;
      case 'move':
        return CURSORS.move;
      case 'waypoint':
        return order.attackMove ? CURSORS.attackMove : COMMAND_CURSORS.waypoint;
      case 'guard':
        return COMMAND_CURSORS.guard;
      default:
        return CURSORS.blocked;
    }
  }

  /** Per frame: the actor under the mouse gets a health bar (engine render). */
  frame() {
    const m = this.input.mouse;
    if (!m.inside) {
      this.game.set_hover(NONE);
      return;
    }
    const w = this.input.toWorld(m.x, m.y);
    this.game.set_hover(this.game.pick(this.player, w.x, w.y));
  }
}

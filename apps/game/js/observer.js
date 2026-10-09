// Spectators and replays: the player view switcher (OpenRA's shroud
// selector: all players' vision together, no shroud, or one player) and the
// observer statistics panels (OpenRA's ObserverStatsLogic: basic, economy,
// production, support powers, combat, army and the two graphs; picked with
// F1..F7 or the panel menu). Stats come from the engine (`Game.observer_stats`,
// engine/src/observer.rs) and each player's `player_json`.

export const OBSERVER_VIEW = 255;
/** Income is the money earned over the last minute of game time. */
export const INCOME_WINDOW_TICKS = 25 * 60;

/** Income per minute from samples of each player's `earned` total. */
export class IncomeTracker {
  constructor(windowTicks = INCOME_WINDOW_TICKS) {
    this.windowTicks = windowTicks;
    /** player -> [[tick, earned], ...] */
    this.samples = new Map();
  }

  /** Record `earned` at `tick`; returns the income over the window. */
  sample(player, tick, earned) {
    let list = this.samples.get(player);
    if (!list) {
      list = [];
      this.samples.set(player, list);
    }
    // Seeking backwards in a replay: start over.
    if (list.length && list.at(-1)[0] > tick) list.length = 0;
    list.push([tick, earned]);
    while (list.length > 2 && list[1][0] <= tick - this.windowTicks) list.shift();
    const [t0, e0] = list[0];
    const span = tick - t0;
    // Averaged over the last minute (or the game so far, in its first minute).
    if (span < 25) return 0;
    return Math.round(((earned - e0) * this.windowTicks) / span);
  }
}

export function formatMoney(v) {
  return `$${Math.round(v).toLocaleString('en-US')}`;
}

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function rgbCss(c) {
  const b = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return `rgb(${b(c[0])}, ${b(c[1])}, ${b(c[2])})`;
}

/** The spectator "All players" view: every player's vision together (OpenRA ObserverCombinedView). */
export const COMBINED_VIEW = 254;

/**
 * The statistics panels of OpenRA's observer (ObserverStatsLogic), picked
 * with the statistics hotkeys (F1..F7) or the panel menu: per panel, its
 * table columns, `[heading, (stats, extra) => text]`, or a graph. `extra`
 * holds the client's own numbers for the player: income per minute, the
 * player's `player_json` (production, powers), harvesters and army counts.
 */
export const PANELS = {
  none: { label: 'No statistics' },
  basic: {
    label: 'Basic',
    columns: [
      ['Cash', (s) => formatMoney(s.funds)],
      ['Power', (s) => `${s.powerUsed}/${s.powerGenerated}`],
      ['Kills', (s) => String(s.unitsKilled + s.buildingsKilled)],
      ['Deaths', (s) => String(s.unitsLost + s.buildingsLost)],
      ['Army', (s) => formatMoney(s.armyValue)],
      ['Income', (s, x) => `${formatMoney(x.income ?? 0)}/min`],
    ],
  },
  economy: {
    label: 'Economy',
    columns: [
      ['Cash', (s) => formatMoney(s.funds)],
      ['Income', (s, x) => `${formatMoney(x.income ?? 0)}/min`],
      ['Earned', (s) => formatMoney(s.earned)],
      ['Harvesters', (s, x) => String(x.harvesters ?? 0)],
    ],
  },
  production: {
    label: 'Production',
    columns: [['In production', (s, x) => productionText(x.state)]],
  },
  supportPowers: {
    label: 'Support powers',
    columns: [['Support powers', (s, x) => powersText(x.state)]],
  },
  combat: {
    label: 'Combat',
    columns: [
      ['Units killed', (s) => String(s.unitsKilled)],
      ['Units lost', (s) => String(s.unitsLost)],
      ['Structures killed', (s) => String(s.buildingsKilled)],
      ['Structures lost', (s) => String(s.buildingsLost)],
      ['Army value', (s) => formatMoney(s.armyValue)],
    ],
  },
  army: {
    label: 'Army',
    columns: [['Army', (s, x) => armyText(x.army)]],
  },
  graph: { label: 'Earnings graph', graph: 'earned' },
  armyGraph: { label: 'Army value graph', graph: 'armyValue' },
};

/** Panel names in the order of the statistics hotkeys. */
export const PANEL_ORDER = Object.keys(PANELS);

/** "Heavy Tank 40%, Rifle Infantry" for a player_json's queues: each tab's current item. */
export function productionText(state) {
  const items = (state?.queues ?? []).map((q) => q[0]).filter(Boolean);
  if (!items.length) return '-';
  return items.map((it) => (it.done ? `${it.name ?? it.id} ready` : `${it.name ?? it.id} ${Math.floor((it.progress ?? 0) * 100)}%`)).join(', ');
}

/** "Nuke 2:10, Spy Plane ready" for a player_json's support powers. */
export function powersText(state) {
  const powers = state?.powers ?? [];
  if (!powers.length) return '-';
  return powers.map((p) => `${p.name} ${p.ready ? 'ready' : formatClock(p.remainingTicks / 25)}`).join(', ');
}

/** "5 Rifle Infantry, 2 Heavy Tank" from [[name, count], ...]. */
export function armyText(army) {
  if (!army?.length) return '-';
  return army.map(([name, n]) => `${n} ${name}`).join(', ');
}

function formatClock(seconds) {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Samples of a number per player over time, for the graph panels. */
export class History {
  constructor(max = 600) {
    this.max = max;
    /** player -> [[tick, value], ...] */
    this.series = new Map();
  }

  sample(player, tick, value) {
    let list = this.series.get(player);
    if (!list) this.series.set(player, (list = []));
    // Seeking backwards in a replay: start over.
    if (list.length && list.at(-1)[0] > tick) list.length = 0;
    if (list.length && list.at(-1)[0] === tick) list[list.length - 1] = [tick, value];
    else list.push([tick, value]);
    // Thin out evenly when full: every other sample goes.
    if (list.length > this.max) this.series.set(player, list.filter((_, i) => i % 2 === 0 || i === list.length - 1));
  }
}

/**
 * The observer panel: a view switcher (all players' vision together, the
 * whole map without shroud, or one player's view with that player's fog),
 * the statistics panel picker and the statistics.
 */
export class ObserverPanel {
  /**
   * @param {HTMLElement} parent
   * @param {{ players: { name: string, color: number[] }[], view: number, onView(view: number): void, panel?: string }} opts
   */
  constructor(parent, { players, view = OBSERVER_VIEW, onView, panel = 'basic' }) {
    this.players = players;
    this.onView = onView;
    this.view = view;
    this.income = new IncomeTracker();
    this.earned = new History();
    this.army = new History();
    this.root = el('section', 'observer-panel');
    this.root.setAttribute('aria-label', 'Observer');
    const head = el('div', 'observer-views');
    head.setAttribute('role', 'group');
    head.setAttribute('aria-label', 'View');
    this.viewButtons = [];
    const addView = (label, value, color, title) => {
      const b = el('button', 'observer-view', label);
      b.type = 'button';
      if (title) b.title = title;
      if (color) b.style.setProperty('--player-color', rgbCss(color));
      b.addEventListener('click', () => this.setView(value));
      head.append(b);
      this.viewButtons.push([value, b]);
    };
    // OpenRA's shroud selector: All Players (combined vision), Disable Shroud, then each player.
    addView('All players', COMBINED_VIEW, null, 'What all players see together');
    addView('No shroud', OBSERVER_VIEW, null, 'The whole map');
    players.forEach((p, i) => addView(p.name, i, p.color));
    this.select = el('select', 'observer-toggle observer-panels');
    this.select.setAttribute('aria-label', 'Statistics');
    for (const name of PANEL_ORDER) {
      const o = el('option', null, PANELS[name].label);
      o.value = name;
      this.select.append(o);
    }
    this.select.addEventListener('change', () => this.showPanel(this.select.value));
    head.append(this.select);
    this.table = el('div', 'observer-stats');
    this.table.setAttribute('role', 'table');
    this.graph = el('canvas', 'observer-graph');
    this.graph.width = 480;
    this.graph.height = 160;
    this.graph.setAttribute('role', 'img');
    this.root.append(head, this.table, this.graph);
    parent.append(this.root);
    this.setView(view, false);
    this.showPanel(panel);
  }

  setView(view, notify = true) {
    this.view = view;
    for (const [v, b] of this.viewButtons) b.setAttribute('aria-pressed', String(v === view));
    if (notify) this.onView?.(view);
  }

  /** Show a statistics panel (PANELS key); unknown names are ignored. */
  showPanel(name) {
    if (!PANELS[name]) return;
    this.panel = name;
    this.select.value = name;
    const p = PANELS[name];
    this.table.hidden = !p.columns;
    this.graph.hidden = !p.graph;
    this.graph.setAttribute('aria-label', p.label);
    if (this.last) this.update(...this.last);
  }

  /** What the panel needs from the game besides `observer_stats`: 'state' (player_json), 'harvesters', 'army', or nothing. */
  needs() {
    return { production: 'state', supportPowers: 'state', economy: 'harvesters', army: 'army' }[this.panel] ?? null;
  }

  /**
   * Redraw from `Game.observer_stats()` (parsed) at `tick`. `extra(player)`
   * gives what `needs()` asked for: `{ state, harvesters, army }`.
   */
  update(stats, tick, extra = () => ({})) {
    this.last = [stats, tick, extra];
    for (const s of stats) {
      this.earned.sample(s.player, tick, s.earned);
      this.army.sample(s.player, tick, s.armyValue);
    }
    const incomes = new Map(stats.map((s) => [s.player, this.income.sample(s.player, tick, s.earned)]));
    const panel = PANELS[this.panel];
    if (panel.graph) {
      this.drawGraph(panel.graph === 'earned' ? this.earned : this.army);
      return;
    }
    if (!panel.columns) return;
    const cols = panel.columns;
    const rows = [];
    const head = el('div', 'observer-row observer-row-head');
    head.setAttribute('role', 'row');
    head.style.setProperty('--cols', String(cols.length));
    head.append(el('span', 'observer-cell observer-name', 'Player'), ...cols.map(([h]) => el('span', 'observer-cell', h)));
    rows.push(head);
    for (const s of stats) {
      const p = this.players[s.player];
      if (!p) continue;
      const x = { income: incomes.get(s.player) ?? 0, ...extra(s.player) };
      const row = el('div', s.defeated ? 'observer-row observer-defeated' : 'observer-row');
      row.setAttribute('role', 'row');
      row.style.setProperty('--cols', String(cols.length));
      const name = el('span', 'observer-cell observer-name', p.name);
      name.style.setProperty('--player-color', rgbCss(p.color));
      row.append(name, ...cols.map(([, f]) => el('span', 'observer-cell', f(s, x))));
      rows.push(row);
    }
    this.table.replaceChildren(...rows);
  }

  /** A line per player of `history` (OpenRA's statistics graphs), in their colours. */
  drawGraph(history) {
    const ctx = this.graph.getContext?.('2d');
    if (!ctx) return;
    const { width: w, height: h } = this.graph;
    ctx.clearRect(0, 0, w, h);
    let t0 = Infinity;
    let t1 = -Infinity;
    let top = 1;
    for (const list of history.series.values()) {
      for (const [t, v] of list) {
        t0 = Math.min(t0, t);
        t1 = Math.max(t1, t);
        top = Math.max(top, v);
      }
    }
    if (!(t1 > t0)) return;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
    for (const [player, list] of history.series) {
      const p = this.players[player];
      if (!p || list.length < 2) continue;
      ctx.strokeStyle = rgbCss(p.color);
      ctx.lineWidth = 2;
      ctx.beginPath();
      list.forEach(([t, v], i) => {
        const x = ((t - t0) / (t1 - t0)) * (w - 4) + 2;
        const y = h - 2 - (v / top) * (h - 4);
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      });
      ctx.stroke();
    }
    ctx.fillStyle = '#dfe6d4';
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText(formatMoney(top), 4, 12);
  }

  remove() {
    this.root.remove();
  }
}

/**
 * A view of the game for spectators and replays: the order methods do
 * nothing (selecting and looking around still work).
 */
export function viewOnly(game) {
  const blocked = new Set([
    'order_smart',
    'order_move',
    'order_attack',
    'order_stop',
    'order_land',
    'order_return_to_base',
    'order_lay_mines',
    'order_teleport',
    'sell',
    'deploy',
    'activate_power',
    'set_rally',
    'start_production',
    'cancel_production',
    'place_building',
    'dev_flag',
    'dev_give_cash',
    'dev_kill',
    'dev_experience',
    'set_stance',
    'repair_building',
    'power_down',
    'place_beacon',
  ]);
  const zero = new Set(['cursor_action', 'deploy_state', 'ability_deploy_state', 'sell_value', 'repair_cursor', 'can_power_down']);
  return new Proxy(game, {
    get(target, prop) {
      // Every order_* method (move, attack ground, guard, scatter, waypoints, ...) and the rest above.
      if (blocked.has(prop) || (typeof prop === 'string' && prop.startsWith('order_'))) return () => undefined;
      if (zero.has(prop)) return () => 0;
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

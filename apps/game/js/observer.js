// Spectators and replays: the player view switcher (OpenRA's shroud
// selector: all players' vision together, no shroud, or one player) and the
// observer statistics panels (OpenRA's ObserverStatsLogic: basic, economy,
// production, support powers, combat, army and the two graphs; picked with
// F1..F7 or the panel menu). Stats come from the engine (`Game.observer_stats`,
// engine/src/observer.rs); the production, support power and army panels
// are rows of icons (js/observer-icons.js) from `Game.observer_production`
// and `Game.army_counts`. Players are grouped by team with a header row per
// team, and each row starts with the player's faction flag (OpenRA
// ObserverStatsLogic TEAM_TEMPLATE and FLAG).

import { armyIcons, armyIconTip, IconStrip, powerIcons, powerIconTip, productionIcons, productionIconTip } from './observer-icons.js';

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
 * table columns, `[heading, (stats, extra) => text]`, a row of icons per
 * player (`icons`: js/observer-icons.js, under the heading `heading`), or a
 * graph. `extra` holds the client's own numbers for the player: income per
 * minute, actions per minute, harvesters, and what `ObserverPanel.needs`
 * asked for.
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
      ['Destroyed', (s) => formatMoney(s.assetsDestroyed ?? 0)],
      ['Lost', (s) => formatMoney(s.assetsLost ?? 0)],
      // OpenRA PlayerStatistics.Experience (observer_stats `experience`: the player's PlayerExperience).
      ['Experience', (s) => String(s.experience ?? 0)],
      ['APM', (s, x) => String(x.apm ?? 0)],
    ],
  },
  economy: {
    label: 'Economy',
    columns: [
      ['Cash', (s) => formatMoney(s.funds)],
      ['Income', (s, x) => `${formatMoney(x.income ?? 0)}/min`],
      ['Earned', (s) => formatMoney(s.earned)],
      ['Spent', (s) => formatMoney(s.spent ?? 0)],
      ['Harvesters', (s, x) => String(x.harvesters ?? 0)],
      // OpenRA DERRICKS: the oil derricks the player owns (UpdatesDerrickCount).
      ['Derricks', (s) => String(s.derricks ?? 0)],
    ],
  },
  production: { label: 'Production', heading: 'Production', icons: 'production' },
  supportPowers: { label: 'Support powers', heading: 'Support powers', icons: 'powers' },
  combat: {
    label: 'Combat',
    columns: [
      ['Destroyed', (s) => formatMoney(s.assetsDestroyed ?? 0)],
      ['Lost', (s) => formatMoney(s.assetsLost ?? 0)],
      ['Units killed', (s) => String(s.unitsKilled)],
      ['Units lost', (s) => String(s.unitsLost)],
      ['Structures killed', (s) => String(s.buildingsKilled)],
      ['Structures lost', (s) => String(s.buildingsLost)],
      ['Army value', (s) => formatMoney(s.armyValue)],
      // OpenRA VISION: the share of the map the player sees now (Shroud.RevealedCells).
      ['Vision', (s) => `${s.vision ?? 0}%`],
    ],
  },
  army: { label: 'Army', heading: 'Army', icons: 'army' },
  graph: { label: 'Earnings graph', graph: 'earned' },
  armyGraph: { label: 'Army value graph', graph: 'armyValue' },
};

/** Panel names in the order of the statistics hotkeys. */
export const PANEL_ORDER = Object.keys(PANELS);

/**
 * Players grouped by team for the statistics rows (OpenRA ObserverStatsLogic:
 * teams in ascending order, a header per team unless nobody has a team):
 * `[{ team, label, stats: [...] }]`, `label` null when there are no teams.
 */
export function teamGroups(stats) {
  const groups = new Map();
  for (const s of stats) {
    const team = s.team ?? 0;
    if (!groups.has(team)) groups.set(team, []);
    groups.get(team).push(s);
  }
  const keys = [...groups.keys()].sort((a, b) => a - b);
  const hasTeams = !(keys.length === 1 && keys[0] === 0);
  return keys.map((team) => ({ team, label: hasTeams ? (team > 0 ? `Team ${team}` : 'No team') : null, stats: groups.get(team) }));
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
   * @param {{
   *   players: { name: string, color: number[] }[],
   *   view: number,
   *   onView(view: number): void,
   *   onStats?(): void,
   *   panel?: string,
   *   actors?: object[],
   *   ticksPerSecond?: number,
   *   lowPowerModifier?: number,
   *   paintCameo?(canvas: HTMLCanvasElement, actor: object, teamRgb: number[]): void,
   *   paintPower?(canvas: HTMLCanvasElement, icon: string): void,
   *   iconBacking?: { width: number, height: number },
   * }} opts
   *   `onStats`: a Statistics button that opens the full statistics screen (js/stats.js);
   *   `panel`: the statistics panel shown first (PANELS);
   *   `actors`: rules_json actors (rules order), for the icon panels;
   *   `paintCameo` / `paintPower`: draw an icon's picture (js/cameo.js), at `iconBacking` pixels
   */
  constructor(parent, { players, view = OBSERVER_VIEW, onView, onStats = null, panel = 'basic', actors = [], ticksPerSecond = 25, lowPowerModifier = 100, paintCameo = () => {}, paintPower = () => {}, iconBacking }) {
    this.players = players;
    this.onView = onView;
    this.view = view;
    this.actors = actors;
    this.actorsById = new Map(actors.map((a) => [a.id, a]));
    this.ticksPerSecond = ticksPerSecond;
    this.lowPowerModifier = lowPowerModifier;
    this.paintCameo = paintCameo;
    this.paintPower = paintPower;
    this.iconBacking = iconBacking;
    /** The rows on screen: rebuilt when the panel or the players change, otherwise only their text is updated. */
    this.layout = null;
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
    if (onStats) {
      const more = el('button', 'observer-toggle observer-stats-button', 'Statistics');
      more.type = 'button';
      more.setAttribute('aria-haspopup', 'dialog');
      more.addEventListener('click', () => onStats());
      head.append(more);
    }
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
    this.table.hidden = !p.columns && !p.icons;
    this.graph.hidden = !p.graph;
    this.graph.setAttribute('aria-label', p.label);
    if (this.last) this.update(...this.last);
  }

  /** What the panel needs from the game besides `observer_stats`: 'production' (observer_production), 'harvesters', 'army' (army_counts), or nothing. */
  needs() {
    return { production: 'production', supportPowers: 'production', economy: 'harvesters', army: 'army' }[this.panel] ?? null;
  }

  /**
   * Redraw from `Game.observer_stats()` (parsed) at `tick`. `extra(player)`
   * gives what `needs()` asked for: `{ production, harvesters, army }`.
   */
  update(stats, tick, extra = () => ({})) {
    this.last = [stats, tick, extra];
    for (const s of stats) {
      this.earned.sample(s.player, tick, s.earned);
      this.army.sample(s.player, tick, s.armyValue);
    }
    const incomes = new Map(stats.map((s) => [s.player, this.income.sample(s.player, tick, s.earned)]));
    // Actions per minute over the game so far (orders of the order log, engine observer.rs).
    const minutes = tick / INCOME_WINDOW_TICKS;
    const apm = (s) => (minutes > 0 ? Math.round((s.orders ?? 0) / minutes) : 0);
    const panel = PANELS[this.panel];
    if (panel.graph) {
      this.drawGraph(panel.graph === 'earned' ? this.earned : this.army);
      return;
    }
    if (!panel.columns && !panel.icons) return;
    const shown = stats.filter((s) => this.players[s.player]);
    const layout = this.ensureLayout(panel, shown);
    for (const s of shown) {
      const row = layout.rows.get(s.player);
      const x = { income: incomes.get(s.player) ?? 0, apm: apm(s), ...extra(s.player) };
      if (row.defeated !== !!s.defeated) {
        row.defeated = !!s.defeated;
        row.el.classList.toggle('observer-defeated', row.defeated);
      }
      if (panel.columns) {
        panel.columns.forEach(([, f], i) => {
          const text = f(s, x);
          if (row.texts[i] !== text) {
            row.texts[i] = text;
            row.cells[i].textContent = text;
          }
        });
      } else {
        row.data = x;
        row.strip.update(this.icons(panel.icons, x));
      }
    }
  }

  /** The icons of one player's row: `x` is its `extra`. */
  icons(kind, x) {
    if (kind === 'production') return productionIcons(x.production, this.actorsById, this.ticksPerSecond);
    if (kind === 'powers') return powerIcons(x.production, this.ticksPerSecond);
    return armyIcons(x.army, this.actors);
  }

  /**
   * The table's rows for this panel and these players: kept while neither
   * changes, so an update only writes the cells whose text changed.
   */
  ensureLayout(panel, stats) {
    const key = `${this.panel}|${stats.map((s) => `${s.player}:${s.team ?? 0}:${s.faction ?? ''}`).join(',')}`;
    if (this.layout?.key === key) return this.layout;
    this.dropLayout();
    const heads = panel.columns ? panel.columns.map(([h]) => h) : [panel.heading];
    const cols = heads.length;
    // The icon panels' head shares their rows' column template (name, one wide cell of icons).
    const rowClass = panel.icons ? 'observer-row observer-row-icons' : 'observer-row';
    const head = el('div', `${rowClass} observer-row-head`);
    head.setAttribute('role', 'row');
    head.style.setProperty('--cols', String(cols));
    head.append(el('span', 'observer-cell observer-name', 'Player'), ...heads.map((h) => el('span', 'observer-cell', h)));
    const elements = [head];
    const rows = new Map();
    for (const group of teamGroups(stats)) {
      if (group.label) {
        // OpenRA TEAM_TEMPLATE: the team's name over its players.
        const t = el('div', 'observer-row observer-team');
        t.setAttribute('role', 'row');
        const label = el('span', 'observer-cell observer-team-name', group.label);
        label.setAttribute('role', 'rowheader');
        t.append(label);
        elements.push(t);
      }
      for (const s of group.stats) {
        const p = this.players[s.player];
        const row = el('div', rowClass);
        row.setAttribute('role', 'row');
        row.style.setProperty('--cols', String(cols));
        const name = el('span', 'observer-cell observer-name');
        name.style.setProperty('--player-color', rgbCss(p.color));
        // OpenRA FLAG: the player's faction flag before the name.
        const flag = el('span', 'observer-flag');
        flag.dataset.faction = s.faction ?? '';
        flag.setAttribute('aria-hidden', 'true');
        name.append(flag, el('span', 'observer-player', p.name));
        name.title = p.name;
        row.append(name);
        const rec = { el: row, defeated: false, cells: [], texts: [], strip: null, data: null };
        if (panel.columns) {
          rec.cells = panel.columns.map(() => el('span', 'observer-cell'));
          row.append(...rec.cells);
        } else {
          rec.strip = this.makeStrip(panel.icons, p, rec);
          const cell = el('span', 'observer-cell observer-icon-cell');
          cell.append(rec.strip.root);
          row.append(cell);
        }
        rows.set(s.player, rec);
        elements.push(row);
      }
    }
    this.table.replaceChildren(...elements);
    this.layout = { key, rows };
    return this.layout;
  }

  /** The icon strip of one player's row. */
  makeStrip(kind, player, rec) {
    const tps = this.ticksPerSecond;
    const paint = kind === 'powers' ? (canvas, icon) => this.paintPower(canvas, icon.power.icon) : (canvas, icon) => this.paintCameo(canvas, icon.actor, player.color);
    let tip = (icon) => armyIconTip(icon);
    if (kind === 'production') tip = (icon) => productionIconTip(icon, rec.data?.production, { ticksPerSecond: tps, lowPowerModifier: this.lowPowerModifier });
    else if (kind === 'powers') tip = (icon) => powerIconTip(icon, tps);
    return new IconStrip({ kind, paint, tip, backing: this.iconBacking });
  }

  /** Forget the rows (their tooltips too). */
  dropLayout() {
    for (const row of this.layout?.rows.values() ?? []) row.strip?.remove();
    this.layout = null;
  }

  /** Paint the icons again (installed content changed: js/cameo.js has new pictures). */
  repaintIcons() {
    for (const row of this.layout?.rows.values() ?? []) row.strip?.repaint();
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
    this.dropLayout();
    this.root.remove();
  }
}

/**
 * A view of the game for spectators and replays: the order methods do
 * nothing (selecting and looking around still work). `blocked()` decides per
 * call, so a player's game turns view-only when it starts watching after
 * its defeat.
 */
export function viewOnly(game, blocked = () => true) {
  const orders = new Set([
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
    'pause_production',
    'place_building',
    'dev_flag',
    'dev_give_cash',
    'dev_kill',
    'dev_experience',
    'set_stance',
    'repair_building',
    'repair_buildings',
    'repair_units',
    'sell_buildings',
    'power_down',
    'place_beacon',
  ]);
  const zero = new Set(['cursor_action', 'deploy_state', 'ability_deploy_state', 'repair_cursor', 'can_power_down']);
  return new Proxy(game, {
    get(target, prop) {
      if (blocked()) {
        // Every order_* method (move, attack ground, guard, scatter, waypoints, ...) and the rest above.
        if (orders.has(prop) || (typeof prop === 'string' && prop.startsWith('order_'))) return () => undefined;
        if (zero.has(prop)) return () => 0;
        // Nothing can be sold (-1: no sell cursor, no refund line).
        if (prop === 'sell_value') return () => -1;
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

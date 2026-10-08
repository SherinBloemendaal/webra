// Spectators and replays: the player view switcher and the observer stats
// panel (like OpenRA's observer stats: army value, income, units and
// structures killed and lost per player). Stats come from the engine
// (`Game.observer_stats`, engine/src/observer.rs).

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

const COLUMNS = [
  ['Cash', (s) => formatMoney(s.funds)],
  ['Income', (s, income) => `${formatMoney(income)}/min`],
  ['Army', (s) => formatMoney(s.armyValue)],
  ['Kills', (s) => String(s.unitsKilled + s.buildingsKilled)],
  ['Losses', (s) => String(s.unitsLost + s.buildingsLost)],
  ['Structures K/L', (s) => `${s.buildingsKilled} / ${s.buildingsLost}`],
  ['Power', (s) => `${s.powerUsed}/${s.powerGenerated}`],
];

/**
 * The observer panel: a view switcher (whole map or one player's view, with
 * that player's fog) and the stats table.
 */
export class ObserverPanel {
  /**
   * @param {HTMLElement} parent
   * @param {{ players: { name: string, color: number[] }[], view: number, onView(view: number): void }} opts
   */
  constructor(parent, { players, view = OBSERVER_VIEW, onView }) {
    this.players = players;
    this.onView = onView;
    this.view = view;
    this.income = new IncomeTracker();
    this.root = el('section', 'observer-panel');
    this.root.setAttribute('aria-label', 'Observer');
    const head = el('div', 'observer-views');
    head.setAttribute('role', 'group');
    head.setAttribute('aria-label', 'View');
    this.viewButtons = [];
    const addView = (label, value, color) => {
      const b = el('button', 'observer-view', label);
      b.type = 'button';
      if (color) b.style.setProperty('--player-color', rgbCss(color));
      b.addEventListener('click', () => this.setView(value));
      head.append(b);
      this.viewButtons.push([value, b]);
    };
    addView('All', OBSERVER_VIEW);
    players.forEach((p, i) => addView(p.name, i, p.color));
    this.table = el('div', 'observer-stats');
    this.table.setAttribute('role', 'table');
    this.toggle = el('button', 'observer-toggle', 'Stats');
    this.toggle.type = 'button';
    this.toggle.setAttribute('aria-expanded', 'true');
    this.toggle.addEventListener('click', () => {
      this.table.hidden = !this.table.hidden;
      this.toggle.setAttribute('aria-expanded', String(!this.table.hidden));
    });
    head.append(this.toggle);
    this.root.append(head, this.table);
    parent.append(this.root);
    this.setView(view, false);
  }

  setView(view, notify = true) {
    this.view = view;
    for (const [v, b] of this.viewButtons) b.setAttribute('aria-pressed', String(v === view));
    if (notify) this.onView?.(view);
  }

  /** Redraw the stats from `Game.observer_stats()` (parsed) at `tick`. */
  update(stats, tick) {
    const rows = [];
    const head = el('div', 'observer-row observer-row-head');
    head.setAttribute('role', 'row');
    head.append(el('span', 'observer-cell observer-name', 'Player'), ...COLUMNS.map(([h]) => el('span', 'observer-cell', h)));
    rows.push(head);
    for (const s of stats) {
      const p = this.players[s.player];
      if (!p) continue;
      const income = this.income.sample(s.player, tick, s.earned);
      const row = el('div', s.defeated ? 'observer-row observer-defeated' : 'observer-row');
      row.setAttribute('role', 'row');
      const name = el('span', 'observer-cell observer-name', p.name);
      name.style.setProperty('--player-color', rgbCss(p.color));
      row.append(name, ...COLUMNS.map(([, f]) => el('span', 'observer-cell', f(s, income))));
      rows.push(row);
    }
    this.table.replaceChildren(...rows);
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
  ]);
  const zero = new Set(['cursor_action', 'deploy_state', 'ability_deploy_state', 'sell_value']);
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

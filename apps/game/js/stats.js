// End-game statistics, like OpenRA's observer stats: Basic, Economy,
// Production, Combat, Army, Support powers and Graphs, with a score summary
// and the winner. The numbers come from the engine (`Game.observer_report`,
// engine/src/observer.rs): deterministic, so every peer and every replay of
// a game shows the same screen. The history behind the graphs is sampled
// every 5 s of game time.
//
// The screen shows at the end of a game (js/endgame.js), live for
// spectators and in replays (the observer panel's Statistics button), and
// from the game menu once the local player is out. Every graph has an
// accessible table behind it. The DOM is built from text only (strict CSP).

import { formatMoney } from './observer.js';

export const STATS_TABS = Object.freeze([
  ['basic', 'Basic'],
  ['economy', 'Economy'],
  ['production', 'Production'],
  ['combat', 'Combat'],
  ['army', 'Army'],
  ['powers', 'Support powers'],
  ['graphs', 'Graphs'],
]);

/** Production queues in engine order (rules.rs QueueType). */
export const QUEUE_NAMES = Object.freeze(['Buildings', 'Defense', 'Infantry', 'Vehicles', 'Aircraft', 'Naval']);

/**
 * Graphs: a history column (`key`) or a rate derived from one (`rate`: per
 * minute over the last minute of game time).
 */
export const GRAPHS = Object.freeze([
  { id: 'army', label: 'Army value', key: 'armyValue', money: true },
  { id: 'income', label: 'Income per minute', rate: 'earned', money: true },
  { id: 'earned', label: 'Earned (total)', key: 'earned', money: true },
  { id: 'funds', label: 'Cash', key: 'funds', money: true },
  { id: 'spent', label: 'Spent (total)', key: 'spent', money: true },
  { id: 'destroyed', label: 'Assets destroyed', key: 'assetsDestroyed', money: true },
  { id: 'lost', label: 'Assets lost', key: 'assetsLost', money: true },
  { id: 'kills', label: 'Kills', key: 'kills' },
  { id: 'power', label: 'Power generated', key: 'powerGenerated' },
  { id: 'apm', label: 'Actions per minute', rate: 'orders' },
]);

/** Rows of the accessible table behind a graph, at most. */
export const TABLE_MAX_ROWS = 120;

const int = (v) => (Number.isFinite(v) ? Math.round(v) : 0);
const fmtInt = (v) => int(v).toLocaleString('en-US');

/** "m:ss" or "h:mm:ss" of game time. */
export function formatDuration(ticks, tps = 25) {
  const secs = Math.max(0, Math.floor(ticks / tps));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = String(secs % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/**
 * Axis scale with round steps (1, 2, 2.5, 5 times a power of ten) covering
 * [min, max]; never below 0 when the data is not. `ticks` are the labelled values.
 */
export function niceScale(min, max, count = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) min = max = 0;
  if (max < min) [min, max] = [max, min];
  if (max === min) {
    if (max === 0) max = 1;
    else if (max > 0) min = 0;
    else max = 0;
  }
  const rough = (max - min) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Number(v.toPrecision(12)));
  return { min: lo, max: hi, step, ticks };
}

/**
 * Per minute rate of a running total over the last `windowSec` of game time
 * (the game so far in its first minute; 0 for the first sample).
 */
export function rateSeries(ticks, totals, tps = 25, windowSec = 60) {
  const out = new Array(ticks.length).fill(0);
  let j = 0;
  for (let i = 0; i < ticks.length; i++) {
    while (j < i && ticks[j] < ticks[i] - windowSec * tps) j++;
    const span = ticks[i] - ticks[j];
    out[i] = span > 0 ? ((totals[i] - totals[j]) * 60 * tps) / span : 0;
  }
  return out;
}

/** Actions per minute over the whole game. */
export function actionsPerMinute(orders, ticks, tps = 25) {
  const minutes = ticks / tps / 60;
  return minutes > 0 ? Math.round((orders / minutes) * 10) / 10 : 0;
}

/** Index of the sample nearest `tick` (ticks ascending), or -1 without samples. */
export function nearestIndex(ticks, tick) {
  if (!ticks.length) return -1;
  let lo = 0;
  let hi = ticks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ticks[mid] < tick) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(ticks[lo - 1] - tick) <= Math.abs(ticks[lo] - tick)) return lo - 1;
  return lo;
}

/** `[{ player, values }]` of a graph (GRAPHS id) from a report's history. */
export function graphSeries(report, graphId) {
  const g = GRAPHS.find((x) => x.id === graphId) ?? GRAPHS[0];
  const h = report?.history;
  if (!h) return [];
  const tps = report.ticksPerSecond ?? 25;
  return h.players.map((p) => ({
    player: p.player,
    values: g.rate ? rateSeries(h.ticks, p[g.rate] ?? [], tps) : (p[g.key] ?? []).slice(),
  }));
}

/**
 * Time labels under a graph: one per 80 px of plot at most, and at most 12
 * however wide the statistics screen is (it fills the window).
 */
export const TIME_LABEL_GAP = 80;
export const TIME_LABELS_MAX = 12;

/** How many intervals the time axis of a plot `plotWidth` px wide is cut into. */
export function timeSteps(plotWidth) {
  return Math.max(1, Math.min(TIME_LABELS_MAX, Math.floor(plotWidth / TIME_LABEL_GAP)));
}

/**
 * Where a graph draws: the value scale and the functions from tick and value
 * to canvas pixels inside `pad` ({ left, right, top, bottom }), and the
 * number of time label intervals (timeSteps).
 */
export function graphLayout(series, ticks, width, height, pad = { left: 56, right: 12, top: 10, bottom: 24 }) {
  let min = Infinity;
  let max = -Infinity;
  for (const s of series) {
    for (const v of s.values) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (min === Infinity) min = max = 0;
  const scale = niceScale(Math.min(0, min), max);
  const t0 = ticks.length ? ticks[0] : 0;
  const t1 = ticks.length ? ticks[ticks.length - 1] : 1;
  const plot = { x0: pad.left, y0: pad.top, x1: Math.max(pad.left + 1, width - pad.right), y1: Math.max(pad.top + 1, height - pad.bottom) };
  const xOf = (t) => plot.x0 + ((t - t0) / Math.max(1, t1 - t0)) * (plot.x1 - plot.x0);
  const yOf = (v) => plot.y1 - ((v - scale.min) / (scale.max - scale.min)) * (plot.y1 - plot.y0);
  const tickOf = (x) => t0 + ((x - plot.x0) / Math.max(1, plot.x1 - plot.x0)) * (t1 - t0);
  return { scale, plot, xOf, yOf, tickOf, t0, t1, steps: timeSteps(plot.x1 - plot.x0) };
}

/** Thin a history to at most `max` rows for the accessible table: indices to show (last always included). */
export function tableRows(count, max = TABLE_MAX_ROWS) {
  if (count <= max) return [...Array(count).keys()];
  const every = Math.ceil(count / max);
  const out = [];
  for (let i = 0; i < count; i += every) out.push(i);
  if (out.at(-1) !== count - 1) out.push(count - 1);
  return out;
}

function rgbCss(c) {
  const b = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return c ? `rgb(${b(c[0])}, ${b(c[1])}, ${b(c[2])})` : 'rgb(255, 255, 255)';
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** Actor id -> display name, and power key -> name, from the game's rules. */
export function namesFromRules(rules) {
  const actors = new Map();
  const powers = new Map();
  for (const a of rules?.actors ?? []) {
    actors.set(a.id, a.name || a.id);
    for (const p of a.abilities?.support_powers ?? []) if (!powers.has(p.key)) powers.set(p.key, p.name || p.key);
  }
  return { actors, powers };
}

function breakdown(map, names, rules) {
  const cost = new Map((rules?.actors ?? []).map((a) => [a.id, a.cost ?? 0]));
  return Object.entries(map ?? {})
    .map(([id, count]) => ({ id, name: names.get(id) ?? id, count, value: (cost.get(id) ?? 0) * count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/**
 * Everything the screen shows, from a report (`observer_report`, parsed):
 * players with names and colours, the result, the score ranking, the tables
 * of every tab and the per type breakdowns.
 *
 * @param {object} report
 * @param {{ players: { name: string, color: number[] }[], rules?: object, localPlayer?: number | null }} ctx
 */
export function shapeReport(report, { players = [], rules = null, localPlayer = null } = {}) {
  const tps = report.ticksPerSecond ?? 25;
  const names = namesFromRules(rules);
  const rows = report.players.map((s) => {
    const p = players[s.player] ?? {};
    const name = p.name ?? `Player ${s.player + 1}`;
    return { player: s.player, name, color: p.color ?? null, css: rgbCss(p.color), local: s.player === localPlayer, s };
  });
  const byPlayer = new Map(rows.map((r) => [r.player, r]));
  const winners = rows.filter((r) => r.s.won);
  const over = report.winner !== null && report.winner !== undefined;
  const result = over
    ? `${winners.map((r) => r.name).join(' and ') || 'Nobody'} ${winners.length === 1 ? 'wins' : 'win'}`
    : 'The game is still on';
  const ranking = rows
    .slice()
    .sort((a, b) => b.s.score - a.s.score || a.player - b.player)
    .map((r, i) => ({ rank: i + 1, player: r.player, name: r.name, css: r.css, score: r.s.score, won: r.s.won, defeated: r.s.defeated }));
  const elapsed = report.endTick ?? report.tick;
  const history = report.history ?? { ticks: [], players: [] };
  const incomeNow = (p) => {
    const h = history.players.find((x) => x.player === p);
    if (!h || !h.earned.length) return 0;
    return rateSeries(history.ticks, h.earned, tps).at(-1);
  };
  const status = (s) => (s.won ? 'Won' : s.defeated ? `Defeated ${s.defeatedAt !== null && s.defeatedAt !== undefined ? formatDuration(s.defeatedAt, tps) : ''}`.trim() : 'Playing');
  const table = (columns, cells) => ({ columns, rows: rows.map((r) => ({ player: r.player, cells: cells(r.s, r) })) });
  const tables = {
    basic: table(['Score', 'Status', 'Cash', 'Power', 'Kills', 'Deaths', 'Assets destroyed', 'Assets lost', 'Experience', 'Actions per minute'], (s) => [
      fmtInt(s.score),
      status(s),
      formatMoney(s.funds),
      `${s.powerUsed} / ${s.powerGenerated}`,
      fmtInt(s.unitsKilled + s.buildingsKilled),
      fmtInt(s.unitsLost + s.buildingsLost),
      formatMoney(s.assetsDestroyed),
      formatMoney(s.assetsLost),
      // OpenRA's EXPERIENCE (PlayerStatistics.Experience, the player's PlayerExperience), with the units' promotions.
      `${fmtInt(s.experience)} (${s.promotions} ${s.promotions === 1 ? 'promotion' : 'promotions'})`,
      s.isAi ? 'AI' : String(actionsPerMinute(s.orders, elapsed, tps)),
    ]),
    economy: table(['Cash', 'Income per minute', 'Earned', 'Harvested ore', 'Harvested gems', 'Spent', 'Of which repairs', 'Sold'], (s) => [
      formatMoney(s.funds),
      formatMoney(incomeNow(s.player)),
      formatMoney(s.earned),
      formatMoney(s.harvestedOre),
      formatMoney(s.harvestedGems),
      formatMoney(s.spent),
      formatMoney(s.repairSpent),
      formatMoney(s.sold),
    ]),
    production: table(['Infantry and vehicles', 'Structures', 'Aircraft', 'Ships', 'Value built', ...QUEUE_NAMES.map((q) => `${q} time`)], (s) => [
      fmtInt(s.unitsBuilt),
      fmtInt(s.buildingsBuilt),
      fmtInt(s.aircraftBuilt),
      fmtInt(s.shipsBuilt),
      formatMoney(s.builtValue),
      ...QUEUE_NAMES.map((_, q) => formatDuration(s.productionTicks?.[q] ?? 0, tps)),
    ]),
    combat: table(['Units killed', 'Units lost', 'Structures killed', 'Structures lost', 'Damage dealt', 'Damage taken', 'Assets destroyed', 'Assets lost'], (s) => [
      fmtInt(s.unitsKilled),
      fmtInt(s.unitsLost),
      fmtInt(s.buildingsKilled),
      fmtInt(s.buildingsLost),
      fmtInt(s.damageDealt),
      fmtInt(s.damageTaken),
      formatMoney(s.assetsDestroyed),
      formatMoney(s.assetsLost),
    ]),
    army: table(['Army value', 'Units', 'Structures'], (s) => [
      formatMoney(s.armyValue),
      fmtInt(Object.values(s.units ?? {}).reduce((a, b) => a + b, 0)),
      fmtInt(Object.values(s.structures ?? {}).reduce((a, b) => a + b, 0)),
    ]),
    powers: table(['Support powers used'], (s) => [fmtInt(s.powersUsed)]),
  };
  const lists = {
    production: rows.map((r) => ({ player: r.player, title: 'Built', entries: breakdown(r.s.built, names.actors, rules) })),
    combat: rows.map((r) => ({ player: r.player, title: 'Destroyed', entries: breakdown(r.s.killed, names.actors, rules) })),
    army: rows.map((r) => ({ player: r.player, title: 'Current army', entries: breakdown(r.s.units, names.actors, rules) })),
    powers: rows.map((r) => ({
      player: r.player,
      title: 'Fired',
      entries: Object.entries(r.s.powers ?? {})
        .map(([key, count]) => ({ id: key, name: names.powers.get(key) ?? capitalize(key), count, value: null }))
        .sort((a, b) => b.count - a.count),
    })),
  };
  return { tps, tick: report.tick, elapsed, duration: formatDuration(elapsed, tps), over, result, rows, byPlayer, ranking, tables, lists, history };
}

// ---- DOM ---------------------------------------------------------------------------------

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(text, className, onClick) {
  const b = el('button', className, text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

/** A theme colour from css/theme.css (canvas drawing), with a fallback. */
function themeColor(name, fallback) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}

/** Line graph on a canvas, with a legend, hover tooltips and its data table. */
export class StatsGraph {
  constructor(parent) {
    this.root = el('figure', 'stats-graph');
    this.canvas = el('canvas', 'stats-canvas');
    this.canvas.setAttribute('role', 'img');
    this.tip = el('div', 'stats-tip');
    this.tip.hidden = true;
    this.tip.setAttribute('role', 'status');
    const wrap = el('div', 'stats-canvas-wrap');
    wrap.append(this.canvas, this.tip);
    this.legend = el('ul', 'stats-legend');
    this.tableBox = el('details', 'stats-graph-table');
    this.root.append(wrap, this.legend, this.tableBox);
    parent.append(this.root);
    this.data = null;
    this.hover = -1;
    this.canvas.addEventListener('pointermove', (e) => this.onHover(e));
    this.canvas.addEventListener('pointerleave', () => this.setHover(-1));
  }

  /**
   * @param {{ label: string, money?: boolean }} graph
   * @param {{ player: number, values: number[] }[]} series
   * @param {number[]} ticks
   * @param {Map<number, { name: string, css: string }>} players
   * @param {number} tps
   */
  set(graph, series, ticks, players, tps) {
    this.data = { graph, series, ticks, players, tps };
    this.canvas.setAttribute('aria-label', `${graph.label} over time, per player. The data table follows.`);
    this.legend.replaceChildren(
      ...series.map((s) => {
        const p = players.get(s.player);
        const li = el('li', 'stats-legend-item', p?.name ?? `Player ${s.player + 1}`);
        li.style.setProperty('--player-color', p?.css ?? '#fff');
        return li;
      }),
    );
    this.renderTable();
    this.hover = -1;
    this.tip.hidden = true;
    this.draw();
  }

  format(v) {
    return this.data?.graph.money ? formatMoney(v) : fmtInt(v);
  }

  renderTable() {
    const { graph, series, ticks, players, tps } = this.data;
    const summary = el('summary', null, `${graph.label}: data table`);
    const scroll = el('div', 'stats-scroll');
    const t = el('table', 'stats-table');
    t.append(el('caption', null, `${graph.label} every ${Math.round((ticks[1] - ticks[0] || 125) / tps)} s of game time`));
    const head = el('tr');
    const th = el('th', null, 'Time');
    th.setAttribute('scope', 'col');
    head.append(th);
    for (const s of series) {
      const h = el('th', null, players.get(s.player)?.name ?? `Player ${s.player + 1}`);
      h.setAttribute('scope', 'col');
      head.append(h);
    }
    const thead = el('thead');
    thead.append(head);
    const tbody = el('tbody');
    for (const i of tableRows(ticks.length)) {
      const tr = el('tr');
      const rh = el('th', null, formatDuration(ticks[i], tps));
      rh.setAttribute('scope', 'row');
      tr.append(rh, ...series.map((s) => el('td', 'num', this.format(s.values[i] ?? 0))));
      tbody.append(tr);
    }
    t.append(thead, tbody);
    scroll.append(t);
    this.tableBox.replaceChildren(summary, scroll);
  }

  onHover(e) {
    if (!this.data || !this.layout) return;
    const r = this.canvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) / Math.max(1, r.width)) * this.cssWidth;
    this.setHover(nearestIndex(this.data.ticks, this.layout.tickOf(x)));
  }

  setHover(i) {
    if (i === this.hover) return;
    this.hover = i;
    this.draw();
    if (i < 0 || !this.data) {
      this.tip.hidden = true;
      return;
    }
    const { series, ticks, players, tps } = this.data;
    const lines = [el('strong', null, formatDuration(ticks[i], tps))];
    for (const s of series) {
      const row = el('span', 'stats-tip-row', `${players.get(s.player)?.name ?? s.player}: ${this.format(s.values[i] ?? 0)}`);
      row.style.setProperty('--player-color', players.get(s.player)?.css ?? '#fff');
      lines.push(row);
    }
    this.tip.replaceChildren(...lines);
    this.tip.hidden = false;
    // Keep the tooltip inside the graph: right of the cursor in the left half, left of it in the right half.
    const x = this.layout.xOf(ticks[i]);
    const left = x < this.cssWidth / 2;
    this.tip.style.setProperty('--tip-x', `${Math.round(x)}px`);
    this.tip.classList.toggle('stats-tip-left', !left);
  }

  /** Draw at the canvas' CSS size times the device pixel ratio. */
  draw() {
    const c = this.canvas;
    const ctx = c.getContext?.('2d');
    if (!ctx || !this.data) return;
    const rect = c.getBoundingClientRect();
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const w = Math.max(200, Math.round(rect.width || 600));
    const h = Math.max(140, Math.round(rect.height || 260));
    this.cssWidth = w;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const { graph, series, ticks, players, tps } = this.data;
    const L = graphLayout(series, ticks, w, h);
    this.layout = L;
    const muted = themeColor('--ui-muted', '#949eaa');
    const line = themeColor('--ui-line', '#343c46');
    const text = themeColor('--ui-text', '#e2e6ea');
    ctx.font = '11px ui-monospace, Menlo, Consolas, monospace';
    ctx.lineWidth = 1;
    // Value grid and labels.
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const v of L.scale.ticks) {
      const y = Math.round(L.yOf(v)) + 0.5;
      ctx.strokeStyle = line;
      ctx.beginPath();
      ctx.moveTo(L.plot.x0, y);
      ctx.lineTo(L.plot.x1, y);
      ctx.stroke();
      ctx.fillStyle = muted;
      ctx.fillText(graph.money ? formatMoney(v) : fmtInt(v), L.plot.x0 - 6, y);
    }
    // Time labels.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const span = Math.max(1, L.t1 - L.t0);
    const steps = L.steps;
    for (let k = 0; k <= steps; k++) {
      const t = L.t0 + (span * k) / steps;
      ctx.fillText(formatDuration(t, tps), L.xOf(t), L.plot.y1 + 6);
    }
    // One line per player in its team colour.
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    for (const s of series) {
      ctx.strokeStyle = players.get(s.player)?.css ?? text;
      ctx.beginPath();
      s.values.forEach((v, i) => {
        const x = L.xOf(ticks[i]);
        const y = L.yOf(v);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
    if (this.hover >= 0 && this.hover < ticks.length) {
      const x = Math.round(L.xOf(ticks[this.hover])) + 0.5;
      ctx.strokeStyle = text;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, L.plot.y0);
      ctx.lineTo(x, L.plot.y1);
      ctx.stroke();
      for (const s of series) {
        ctx.fillStyle = players.get(s.player)?.css ?? text;
        ctx.beginPath();
        ctx.arc(x, L.yOf(s.values[this.hover] ?? 0), 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

/**
 * The statistics screen: an overlay with the result, the score summary,
 * one tab per area and the actions the caller passes (Play again, Return
 * to lobby, ...). `load()` returns a promise of the parsed report; `live`
 * refreshes it every two seconds while the screen is open.
 */
export class StatsScreen {
  /**
   * @param {HTMLElement} root the overlay section
   * @param {{
   *   load(): Promise<object | null>,
   *   players: { name: string, color: number[] }[],
   *   rules?: object,
   *   localPlayer?: number | null,
   *   live?: boolean,
   *   actions?: { label: string, run(): void }[],
   *   onChange?(open: boolean): void,
   * }} opts
   */
  constructor(root, opts) {
    this.root = root;
    this.opts = opts;
    this.tab = 'basic';
    this.graph = GRAPHS[0].id;
    this.report = null;
    this.shaped = null;
    this.timer = null;
    this.card = el('div', 'menu-card stats-card');
    this.card.setAttribute('role', 'dialog');
    this.card.setAttribute('aria-modal', 'true');
    this.card.setAttribute('aria-label', 'Statistics');
    root.replaceChildren(this.card);
    root.hidden = true;
    this.onKey = (e) => {
      if (!this.isOpen) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        this.close();
        return;
      }
      // Game hotkeys stay quiet behind the screen; Tab and arrows still work in it.
      e.stopImmediatePropagation();
    };
    window.addEventListener('keydown', this.onKey, true);
    window.addEventListener('resize', () => this.isOpen && this.tab === 'graphs' && this.graphView?.draw());
  }

  get isOpen() {
    return !this.root.hidden;
  }

  /** Open (on `tab`) and load the newest numbers. */
  async open(tab = null) {
    if (tab) this.tab = tab;
    const was = this.isOpen;
    this.root.hidden = false;
    if (!was) this.opts.onChange?.(true);
    if (!this.shaped) this.renderLoading();
    await this.refresh();
    if (this.opts.live && !this.timer) this.timer = setInterval(() => this.refresh(), 2000);
  }

  close() {
    if (!this.isOpen) return;
    this.root.hidden = true;
    clearInterval(this.timer);
    this.timer = null;
    if (this.root.contains(document.activeElement)) document.activeElement.blur();
    this.opts.onChange?.(false);
  }

  async refresh() {
    let report = null;
    try {
      report = await this.opts.load();
    } catch (err) {
      console.warn('Statistics are unavailable:', err);
    }
    if (!this.isOpen) return;
    if (!report) {
      if (!this.shaped) this.renderLoading('The statistics are not available yet.');
      return;
    }
    this.setReport(report);
  }

  /** Show `report` (parsed `observer_report`). */
  setReport(report) {
    this.report = report;
    this.shaped = shapeReport(report, { players: this.opts.players, rules: this.opts.rules, localPlayer: this.opts.localPlayer ?? null });
    this.render();
  }

  renderLoading(text = 'Loading the statistics...') {
    this.card.replaceChildren(el('h1', null, 'Statistics'), el('p', 'tagline', text), this.actionRow());
  }

  actionRow() {
    const row = el('div', 'stats-actions');
    for (const a of this.opts.actions ?? []) row.append(button(a.label, null, () => a.run()));
    row.append(button('Close', 'primary', () => this.close()));
    return row;
  }

  render() {
    const d = this.shaped;
    const focusTab = this.card.contains(document.activeElement) && document.activeElement?.getAttribute?.('role') === 'tab';
    const scroll = this.card.querySelector('.stats-panel')?.scrollTop ?? 0;
    const head = el('header', 'stats-head');
    head.append(el('h1', null, 'Statistics'), el('p', 'tagline', `${d.result}. Game time ${d.duration}.`));
    const ranking = el('ol', 'stats-ranking');
    ranking.setAttribute('aria-label', 'Score');
    for (const r of d.ranking) {
      const li = el('li', r.won ? 'stats-rank stats-rank-won' : r.defeated ? 'stats-rank stats-rank-out' : 'stats-rank');
      li.style.setProperty('--player-color', r.css);
      li.append(el('span', 'stats-rank-name', r.name), el('span', 'stats-rank-score', fmtInt(r.score)));
      if (r.won) li.append(el('span', 'stats-badge', 'Winner'));
      ranking.append(li);
    }
    head.append(ranking);
    const tabs = el('div', 'stats-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Statistics');
    for (const [id, label] of STATS_TABS) {
      const b = button(label, 'stats-tab', () => this.show(id));
      b.setAttribute('role', 'tab');
      b.id = `stats-tab-${id}`;
      b.setAttribute('aria-selected', String(id === this.tab));
      b.setAttribute('aria-controls', 'stats-panel');
      b.tabIndex = id === this.tab ? 0 : -1;
      b.addEventListener('keydown', (e) => this.tabKey(e, id));
      tabs.append(b);
    }
    const panel = el('div', 'stats-panel');
    panel.id = 'stats-panel';
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', `stats-tab-${this.tab}`);
    this.graphView = null;
    if (this.tab === 'graphs') this.renderGraphs(panel);
    else this.renderTab(panel, this.tab);
    this.card.replaceChildren(head, tabs, panel, this.actionRow());
    panel.scrollTop = scroll;
    // Sized by the layout now that it is on the page.
    this.graphView?.draw();
    if (focusTab) this.card.querySelector(`#stats-tab-${this.tab}`)?.focus({ preventScroll: true });
    else if (!this.card.contains(document.activeElement)) this.card.querySelector('.stats-tab[aria-selected="true"]')?.focus({ preventScroll: true });
  }

  /** Arrow keys, Home and End move between tabs (WAI-ARIA tabs). */
  tabKey(e, id) {
    const ids = STATS_TABS.map(([t]) => t);
    const i = ids.indexOf(id);
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: ids.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    this.show(ids[(next + ids.length) % ids.length]);
    this.card.querySelector(`#stats-tab-${this.tab}`)?.focus({ preventScroll: true });
  }

  show(tab) {
    this.tab = tab;
    if (this.shaped) this.render();
  }

  playerCell(row, scope = 'row') {
    const th = el('th', 'stats-player');
    th.setAttribute('scope', scope);
    th.style.setProperty('--player-color', row?.css ?? '#fff');
    th.textContent = row ? `${row.name}${row.local ? ' (you)' : ''}` : '';
    return th;
  }

  renderTab(panel, tab) {
    const d = this.shaped;
    const spec = d.tables[tab];
    const scroll = el('div', 'stats-scroll');
    const t = el('table', 'stats-table');
    t.append(el('caption', 'ui-sr-only', `${STATS_TABS.find(([id]) => id === tab)[1]} statistics per player`));
    const thead = el('thead');
    const hr = el('tr');
    const corner = el('th', null, 'Player');
    corner.setAttribute('scope', 'col');
    hr.append(corner);
    for (const c of spec.columns) {
      const th = el('th', 'num', c);
      th.setAttribute('scope', 'col');
      hr.append(th);
    }
    thead.append(hr);
    const tbody = el('tbody');
    for (const r of spec.rows) {
      const row = d.byPlayer.get(r.player);
      const tr = el('tr', row?.s.defeated && !row?.s.won ? 'stats-out' : null);
      tr.append(this.playerCell(row), ...r.cells.map((c) => el('td', 'num', c)));
      tbody.append(tr);
    }
    t.append(thead, tbody);
    scroll.append(t);
    panel.append(scroll);
    const lists = d.lists[tab];
    if (!lists) return;
    const grid = el('div', 'stats-lists');
    for (const l of lists) {
      const row = d.byPlayer.get(l.player);
      const box = el('section', 'stats-list');
      const h = el('h2', 'stats-player', `${row?.name ?? l.player}: ${l.title.toLowerCase()}`);
      h.style.setProperty('--player-color', row?.css ?? '#fff');
      box.append(h);
      if (!l.entries.length) box.append(el('p', 'hint', 'Nothing.'));
      else {
        const ul = el('ul', 'stats-types');
        for (const e of l.entries) {
          const li = el('li');
          li.append(el('span', null, e.name), el('span', 'num', e.value ? `${fmtInt(e.count)} (${formatMoney(e.value)})` : fmtInt(e.count)));
          ul.append(li);
        }
        box.append(ul);
      }
      grid.append(box);
    }
    panel.append(grid);
  }

  renderGraphs(panel) {
    const d = this.shaped;
    const pick = el('label', 'stats-graph-pick');
    const select = el('select');
    for (const g of GRAPHS) {
      const o = el('option', null, g.label);
      o.value = g.id;
      select.append(o);
    }
    select.value = this.graph;
    select.addEventListener('change', () => {
      this.graph = select.value;
      this.render();
    });
    pick.append(el('span', null, 'Graph'), select);
    panel.append(pick);
    if (d.history.ticks.length < 2) {
      panel.append(el('p', 'hint', 'The graphs start after the first few seconds of the game.'));
      return;
    }
    const graph = GRAPHS.find((g) => g.id === this.graph) ?? GRAPHS[0];
    this.graphView = new StatsGraph(panel);
    this.graphView.set(graph, graphSeries(this.report, graph.id), d.history.ticks, d.byPlayer, d.tps);
  }
}

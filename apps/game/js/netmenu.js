// The game menu's Network tab in online games (docs/redesign-uitwerking.md
// 29; design board NetMenu): tiles (your ping, jitter, late pings, the
// slowest player), the ping of every player over the last minute with the
// stalls marked, a table per player, how long this game waited and for
// whom, and the three net.* switches.
//
// The data comes from the session's connection quality (js/netquality.js
// NetQuality of protocol 8: events 'players' every 2 s with a Map of client
// -> { rtt, jitter, late, quality }, 'self' with the own measurement,
// 'waiting' while lockstep waits for someone, 'stalls' with the server's
// stall log). NetHistory keeps the last minute from the moment the game
// starts, so the chart is full when the menu opens. The HUD's signal bars
// open this tab with `window.dispatchEvent(new CustomEvent(OPEN_NETWORK_EVENT))`.

import * as constants from '../protocol/constants.js';
import { GROUPS } from './registry.js';
import { toggle } from './ui/controls.js';

/** The event that opens the game menu on this tab (the HUD's signal bars dispatch it on window). */
export const OPEN_NETWORK_EVENT = 'webra:open-network';

/** How far back the chart reaches (ms). */
export const CHART_WINDOW_MS = 60_000;

/**
 * The quality bands of the chart: the shared thresholds of protocol 8
 * (packages/protocol constants NET_GOOD_RTT_MS, NET_POOR_RTT_MS), with the
 * values of the design notes until that protocol is in this build.
 */
export const BANDS = Object.freeze({ good: constants.NET_GOOD_RTT_MS ?? 80, poor: constants.NET_POOR_RTT_MS ?? 150 });

/** The words of a quality, the second signal next to its colour. */
export const QUALITY_TEXT = Object.freeze({ good: 'Good', fair: 'Fair', poor: 'Poor' });

/** The net.* switches of the tab (registry group net). */
export const NET_SWITCHES = Object.freeze(['warnSelf', 'warnOthers', 'signalBars']);

const ms = (v) => (v === null || v === undefined ? '--' : `${Math.round(v)} ms`);
const pct = (v) => (v === null || v === undefined ? '--' : `${Number(v.toFixed?.(1) ?? v)}%`);
const secs = (v) => `${(Math.round(v / 100) / 10).toFixed(1)} s`;

/** The last minute of every player's ping, the stalls and this game's waiting time. */
export class NetHistory {
  /**
   * @param {{ on(type: string, fn: Function): Function, self?: object, players?: Map<number, object>, waiting?: object|null, requestStalls?(): Promise<object> }} source
   * @param {{ now?: () => number, windowMs?: number }} [o] now: wall clock (Date.now), as NetQuality's `waiting.at`
   */
  constructor(source, { now = () => Date.now(), windowMs = CHART_WINDOW_MS } = {}) {
    this.source = source;
    this.now = now;
    this.windowMs = windowMs;
    /** client -> [{ t, rtt }] */
    this.points = new Map();
    /** [{ client, at, ms }]: stalls seen while this game ran (ended ones). */
    this.stalls = [];
    /** client -> ms waited for that player this game, counted here. */
    this.totals = new Map();
    /** The server's totals (stall log), when asked: client -> ms. */
    this.serverTotals = null;
    /** The stall going on: { client, start, heldMs }. */
    this.current = null;
    this.listeners = new Set();
    this.offs = [
      source.on('players', (players) => this.onPlayers(players)),
      source.on('self', () => this.changed()),
      source.on('waiting', (w) => this.onWaiting(w)),
      source.on('stalls', (s) => this.onStalls(s)),
    ].filter((f) => typeof f === 'function');
  }

  dispose() {
    for (const off of this.offs) off();
    this.offs = [];
    this.listeners.clear();
  }

  /** fn() after every change; returns the unsubscribe. */
  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  changed() {
    for (const fn of [...this.listeners]) fn();
  }

  trim(now) {
    const from = now - this.windowMs;
    for (const [client, list] of this.points) {
      while (list.length && list[0].t < from) list.shift();
      if (!list.length) this.points.delete(client);
    }
    while (this.stalls.length && this.stalls[0].at < from) this.stalls.shift();
  }

  onPlayers(players) {
    const now = this.now();
    for (const p of players?.values?.() ?? []) {
      if (p.rtt === null || p.rtt === undefined) continue;
      if (!this.points.has(p.client)) this.points.set(p.client, []);
      this.points.get(p.client).push({ t: now, rtt: p.rtt });
    }
    this.trim(now);
    this.changed();
  }

  onWaiting(w) {
    const now = this.now();
    if (this.current && (!w || w.client !== this.current.client)) {
      const c = this.current;
      const held = c.heldMs + Math.max(0, now - c.start);
      this.stalls.push({ client: c.client, at: now, ms: held });
      this.totals.set(c.client, (this.totals.get(c.client) ?? 0) + held);
      this.current = null;
    }
    if (w && !this.current) this.current = { client: w.client, start: w.at ?? now, heldMs: w.heldMs ?? 0 };
    this.trim(now);
    this.changed();
  }

  onStalls(s) {
    if (Array.isArray(s?.totals)) this.serverTotals = new Map(s.totals.map((t) => [t.client, t.ms]));
    this.changed();
  }

  /** Ask the server for its stall log (its totals are the game's own); errors leave the counted ones. */
  refresh() {
    return this.source.requestStalls?.().catch(() => null) ?? Promise.resolve(null);
  }

  /** ms waited per client this game (the server's when it answered, else counted here, the running stall included). */
  waitTotals() {
    const out = new Map(this.serverTotals ?? this.totals);
    if (this.current) {
      const c = this.current;
      out.set(c.client, (out.get(c.client) ?? 0) + c.heldMs + Math.max(0, this.now() - c.start));
    }
    return out;
  }

  /**
   * Everything the tab shows. `people`: the game's players `[{ client,
   * name, color }]` (spectators are left out of the tab, as from the lobby's
   * column); `color` a CSS colour.
   */
  model(people = []) {
    const now = this.now();
    this.trim(now);
    const players = this.source.players ?? new Map();
    const self = this.source.self ?? {};
    const nameOf = (client) => people.find((p) => p.client === client)?.name ?? `Player ${client}`;
    const rows = people.map((p) => {
      const n = players.get(p.client) ?? {};
      return {
        client: p.client,
        name: p.name,
        color: p.color,
        you: !!n.you,
        rtt: n.rtt ?? null,
        jitter: n.jitter ?? null,
        late: n.late ?? null,
        quality: n.quality ?? null,
        ping: ms(n.rtt),
        jitterText: n.jitter === null || n.jitter === undefined ? '--' : `±${n.jitter}`,
        lateText: pct(n.late),
        qualityText: QUALITY_TEXT[n.quality] ?? 'Measuring',
      };
    });
    const measured = rows.filter((r) => r.rtt !== null);
    const slowest = measured.length ? measured.reduce((a, b) => (b.rtt > a.rtt ? b : a)) : null;
    const tiles = [
      { id: 'ping', label: 'Your ping', value: ms(self.rtt), hint: 'to the game server', quality: self.quality ?? null },
      { id: 'jitter', label: 'Jitter', value: self.jitter === null || self.jitter === undefined ? '--' : `±${self.jitter} ms`, hint: 'how much it varies', quality: self.quality ?? null },
      { id: 'late', label: 'Late pings', value: pct(self.late), hint: 'answered after a second or not at all', quality: self.quality ?? null },
      {
        id: 'slowest',
        label: 'Slowest player',
        value: slowest ? slowest.name : '--',
        hint: slowest ? `${slowest.ping}, ${slowest.lateText} late` : 'no measurements yet',
        quality: slowest?.quality ?? null,
      },
    ];
    const from = now - this.windowMs;
    const series = people
      .filter((p) => this.points.has(p.client))
      .map((p) => ({ client: p.client, name: p.name, color: p.color, points: this.points.get(p.client).map((q) => ({ x: (q.t - from) / this.windowMs, rtt: q.rtt })) }));
    const stalls = this.stalls.map((s) => ({ client: s.client, name: nameOf(s.client), x: (s.at - from) / this.windowMs, ms: s.ms, text: `stall ${secs(s.ms)}` }));
    const totals = this.waitTotals();
    return { tiles, rows, chart: { series, stalls }, waiting: waitingText(totals, nameOf) };
  }
}

/** "No waiting this game.", "Waiting time this game: 6.2 s, all caused by Ivan." or the split per player. */
export function waitingText(totals, nameOf) {
  const list = [...totals].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const sum = list.reduce((n, [, v]) => n + v, 0);
  if (!list.length || sum < 100) return 'No waiting this game.';
  if (list.length === 1) return `Waiting time this game: ${secs(sum)}, all caused by ${nameOf(list[0][0])}.`;
  return `Waiting time this game: ${secs(sum)} (${list.map(([c, v]) => `${nameOf(c)} ${secs(v)}`).join(', ')}).`;
}

// ---- Drawing ----------------------------------------------------------------------

const SVG = 'http://www.w3.org/2000/svg';

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function svg(tag, attrs = {}, text) {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text !== undefined) e.textContent = text;
  return e;
}

/** The chart's frame and scale: x 40..590, y 10..190 for 0..top ms. */
const CHART = { x0: 40, x1: 590, y0: 10, y1: 190, w: 600, h: 220 };

/**
 * The ping chart as an inline SVG (presentation attributes only: the CSP has
 * no inline styles). Player colours come from `series[].color`; the bands
 * and the stall marks also carry words, not only colour.
 */
export function pingChart(chart) {
  const max = Math.max(BANDS.poor + 50, ...chart.series.flatMap((s) => s.points.map((p) => p.rtt)));
  const top = Math.ceil(max / 50) * 50;
  const X = (x) => CHART.x0 + Math.max(0, Math.min(1, x)) * (CHART.x1 - CHART.x0);
  const Y = (v) => CHART.y1 - (Math.min(v, top) / top) * (CHART.y1 - CHART.y0);
  const root = svg('svg', { viewBox: `0 0 ${CHART.w} ${CHART.h}`, class: 'net-chart-svg', role: 'img', 'aria-label': 'Ping per player over the last minute' });
  root.append(
    svg('rect', { class: 'net-band-poor', x: CHART.x0, y: CHART.y0, width: CHART.x1 - CHART.x0, height: Y(BANDS.poor) - CHART.y0 }),
    svg('rect', { class: 'net-band-fair', x: CHART.x0, y: Y(BANDS.poor), width: CHART.x1 - CHART.x0, height: Y(BANDS.good) - Y(BANDS.poor) }),
  );
  const grid = svg('g', { class: 'net-grid' });
  for (const v of [BANDS.good, BANDS.poor]) grid.append(svg('path', { d: `M${CHART.x0} ${Y(v)}H${CHART.x1}` }));
  grid.append(svg('path', { d: `M${CHART.x0} ${CHART.y1}H${CHART.x1}` }));
  root.append(grid);
  const labels = svg('g', { class: 'net-axis', 'font-size': 11 });
  labels.append(
    svg('text', { x: CHART.x0 - 6, y: Y(BANDS.poor) + 4, 'text-anchor': 'end' }, String(BANDS.poor)),
    svg('text', { x: CHART.x0 - 6, y: Y(BANDS.good) + 4, 'text-anchor': 'end' }, String(BANDS.good)),
    svg('text', { x: CHART.x0 - 6, y: CHART.y1 + 4, 'text-anchor': 'end' }, '0'),
    svg('text', { x: CHART.x0, y: CHART.h - 6 }, '-60 s'),
    svg('text', { x: CHART.x1, y: CHART.h - 6, 'text-anchor': 'end' }, 'now'),
    svg('text', { x: CHART.x1 - 4, y: CHART.y0 + 12, 'text-anchor': 'end', class: 'net-band-label' }, 'poor'),
  );
  root.append(labels);
  for (const s of chart.series) {
    if (!s.points.length) continue;
    const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)} ${Y(p.rtt).toFixed(1)}`).join(' ');
    root.append(svg('path', { class: 'net-line', d, fill: 'none', stroke: s.color, 'stroke-width': 2 }));
  }
  for (const st of chart.stalls) {
    const line = chart.series.find((s) => s.client === st.client);
    const near = line?.points.reduce((a, b) => (Math.abs(b.x - st.x) < Math.abs(a.x - st.x) ? b : a), line.points[0]);
    const y = near ? Y(near.rtt) : CHART.y0 + 6;
    const g = svg('g', { class: 'net-stall', 'font-size': 12 });
    g.append(svg('circle', { cx: X(st.x).toFixed(1), cy: y.toFixed(1), r: 4 }), svg('text', { x: (X(st.x) - 6).toFixed(1), y: Math.min(CHART.y1 - 4, y + 18).toFixed(1), 'text-anchor': 'end' }, `${st.name}: ${st.text}`));
    root.append(g);
  }
  return root;
}

/** The data part of the tab (drawn again on every update; the switches stay). */
export function renderNetworkData(box, m) {
  const tiles = el('div', 'net-tiles');
  for (const t of m.tiles) {
    const tile = el('div', `net-tile${t.quality ? ` net-${t.quality}` : ''}`);
    tile.dataset.tile = t.id;
    tile.append(el('span', 'net-tile-label', t.label), el('span', 'net-tile-value ui-num', t.value), el('span', 'net-tile-hint', t.quality ? `${QUALITY_TEXT[t.quality]}: ${t.hint}` : t.hint));
    tiles.append(tile);
  }
  const chart = el('section', 'net-chart');
  chart.setAttribute('aria-labelledby', 'net-chart-title');
  const chartHead = el('div', 'net-chart-head');
  const chartTitle = el('h2', 'gm-section-title', 'Ping, last minute');
  chartTitle.id = 'net-chart-title';
  const legend = el('ul', 'net-legend');
  for (const s of m.chart.series) {
    const li = el('li', 'net-legend-item', s.name);
    li.prepend(swatch(s.color));
    legend.append(li);
  }
  chartHead.append(chartTitle, legend);
  chart.append(chartHead, m.chart.series.length ? pingChart(m.chart) : el('p', 'gm-note', 'No measurements yet: the first ones come within a few seconds.'));

  const table = el('section', 'net-players');
  table.setAttribute('aria-labelledby', 'net-players-title');
  const tt = el('h2', 'gm-section-title', 'Players');
  tt.id = 'net-players-title';
  const t = el('table', 'ui-table net-table');
  const head = el('tr', 'ui-table-head');
  for (const [text, cls] of [['Player', null], ['Ping', 'num'], ['Jitter', 'num'], ['Late', 'num'], ['Connection', null]]) {
    const th = el('th', cls, text);
    th.setAttribute('scope', 'col');
    head.append(th);
  }
  const thead = el('thead');
  thead.append(head);
  const tbody = el('tbody');
  for (const r of m.rows) {
    const tr = el('tr', r.quality ? `net-row-${r.quality}` : null);
    tr.dataset.client = String(r.client);
    const name = el('th', 'net-name');
    name.setAttribute('scope', 'row');
    name.append(swatch(r.color), el('span', null, r.you ? `${r.name} (you)` : r.name));
    tr.append(name, el('td', 'num', r.ping), el('td', 'num', r.jitterText), el('td', 'num', r.lateText), el('td', `net-quality${r.quality ? ` net-${r.quality}` : ''}`, r.qualityText));
    tbody.append(tr);
  }
  t.append(thead, tbody);
  table.append(tt, t, el('p', 'gm-note net-waiting', m.waiting));

  const grid = el('div', 'net-grid-layout');
  grid.append(chart, table);
  box.replaceChildren(tiles, grid);
}

/** A small square in a player's colour (set through the CSSOM: the CSP allows no style attributes). */
function swatch(color) {
  const s = el('span', 'net-swatch');
  s.setAttribute('aria-hidden', 'true');
  s.style?.setProperty?.('--swatch', color);
  return s;
}

/** The three switches (registry net.*), following the setting wherever it changes. */
export function netSwitches(registry, offs) {
  const box = el('div', 'net-switches');
  for (const key of NET_SWITCHES) {
    const spec = GROUPS.net.settings[key];
    const t = toggle({ id: `net-${key}`, label: spec.label, hint: spec.help, checked: registry.get('net', key), rowClass: 'net-switch', onChange: (on) => registry.set('net', key, on) });
    offs.push(registry.subscribe('net', (values) => t.set(!!values[key])));
    box.append(t.row);
  }
  return box;
}

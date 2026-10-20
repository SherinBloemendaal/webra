// The statistics screen's Network tab (docs/contracts.md section 4 "Network
// quality" and "Start, loading, end of game and statistics screens", the
// canvas board NetStats), for online games only: tiles (how long
// the game waited, your average ping, your worst moment, late pings), the
// ping of every player over the whole game with a red column for every
// stall, a table per player (average, worst, jitter, loss, held up) and the
// stalls, each opening the replay at that moment.
//
// The data comes from the game's network object (js/online.js gameNet:
// its `quality` is the session's js/netquality.js NetQuality, protocol 8,
// and its `roster` the people of the game): the per-player series and
// totals (`report()`, one point per 10 s, recorded from `netstat`), the
// server's stall log (`requestStalls()`) and the own ping counts (`self`).
// netStatsData() reads them; shapeNetwork() is pure (tests), renderNetwork()
// draws it. "Loss" is late pings: WebSocket runs over TCP, nothing is lost
// visibly, a pong later than a second is what a player feels.
//
// The quality judgement is the protocol's netQuality (packages/protocol
// netquality.js, protocol 8); until that is in the protocol package, the
// same thresholds are used here (NET_* below, docs/contracts.md "Network
// quality").

import * as protocol from './protocol.js';
import { formatDuration } from './stats.js';

/** The thresholds of docs/contracts.md "Network quality" (the protocol's constants when it has them). */
export const NET_GOOD_RTT_MS = protocol.NET_GOOD_RTT_MS ?? 80;
export const NET_POOR_RTT_MS = protocol.NET_POOR_RTT_MS ?? 150;
export const NET_GOOD_JITTER_MS = protocol.NET_GOOD_JITTER_MS ?? 20;
export const NET_POOR_LATE_PCT = protocol.NET_POOR_LATE_PCT ?? 2;

/** `good`, `fair` or `poor` for `{ rtt, jitter, late }` (null without a round trip): the protocol's netQuality. */
export const netQuality =
  protocol.netQuality ??
  (({ rtt, jitter = 0, late = 0 } = {}) => {
    if (rtt === null || rtt === undefined) return null;
    if (rtt > NET_POOR_RTT_MS || (late ?? 0) > NET_POOR_LATE_PCT) return 'poor';
    if (rtt < NET_GOOD_RTT_MS && (jitter ?? 0) <= NET_GOOD_JITTER_MS && (late ?? 0) === 0) return 'good';
    return 'fair';
  });

/** The word and the lamp of a quality (the word is the second signal besides the colour). */
export const QUALITY = Object.freeze({ good: ['Good', 'ok'], fair: ['Fair', 'warn'], poor: ['Poor', 'bad'] });

/** "0.9 s", "12 s" for a stall or wait in milliseconds. */
export function seconds(ms) {
  const s = Math.max(0, ms) / 1000;
  return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
}

/** "m:ss" of milliseconds since the game began. */
export function clock(ms) {
  return formatDuration(Math.max(0, ms) / 1000, 1);
}

/**
 * Read the data of the Network tab from the game's network object
 * (onStartGame `net`, js/online.js gameNet: `{ quality, source, roster, you,
 * players() }`): the NetQuality's series and totals, the stall log (asked
 * from the server; its last answer when it does not answer) and the own ping
 * counts, with the roster (`[{ client, player, name }]`) as the seats.
 */
export async function netStatsData(net) {
  const nq = net?.quality ?? null;
  if (!nq || !net.roster) return null;
  let stalls = nq.lastStalls ?? null;
  try {
    stalls = await nq.requestStalls();
  } catch (err) {
    console.warn('The stall log is unavailable:', err?.message ?? err);
  }
  return { seats: net.roster, report: nq.report(), stalls, self: { sent: nq.self?.sent ?? 0, latePings: nq.self?.latePings ?? 0 }, you: net.you ?? nq.you ?? null };
}

/**
 * Everything the tab shows. `data`: netStatsData's; `players`: the game's
 * players by seat (`{ name, css }`, the statistics' rows); `tps`: game ticks
 * per second; `tickMs`: how long a tick takes at the game's speed (stalls
 * are logged by tick, the series by time since the game began).
 */
export function shapeNetwork(data, { players = new Map(), tps = 25, tickMs = 40 } = {}) {
  const seats = (data?.seats ?? []).filter((s) => s.client !== null && s.client !== undefined);
  const report = data?.report instanceof Map ? data.report : new Map(Object.entries(data?.report ?? {}).map(([k, v]) => [Number(k), v]));
  const totals = new Map((data?.stalls?.totals ?? []).map((t) => [t.client, t]));
  const nameOf = (client) => {
    const seat = seats.find((s) => s.client === client);
    return seat ? (players.get(seat.player)?.name ?? seat.name) : 'a spectator';
  };
  const rows = seats.map((seat) => {
    const r = report.get(seat.client) ?? null;
    const held = totals.get(seat.client)?.ms ?? 0;
    const quality = r ? netQuality({ rtt: r.avg, jitter: r.jitter, late: r.late }) : null;
    return {
      client: seat.client,
      player: seat.player,
      name: players.get(seat.player)?.name ?? seat.name,
      css: players.get(seat.player)?.css ?? null,
      you: seat.client === data?.you,
      avg: r?.avg ?? null,
      worst: r?.worst ?? null,
      worstAt: r?.worstAt ?? null,
      jitter: r?.jitter ?? null,
      late: r?.late ?? null,
      held,
      quality,
      series: r?.series ?? [],
    };
  });
  const stalls = (data?.stalls?.stalls ?? [])
    .slice()
    .sort((a, b) => a.tick - b.tick)
    .map((s) => ({ tick: s.tick, at: formatDuration(s.tick, tps), t: s.tick * tickMs, client: s.client, name: nameOf(s.client), ms: s.ms, text: `Waited for ${nameOf(s.client)}`, len: seconds(s.ms) }));
  const waited = (data?.stalls?.totals ?? []).reduce((n, t) => n + t.ms, 0) || stalls.reduce((n, s) => n + s.ms, 0);
  const count = (data?.stalls?.totals ?? []).reduce((n, t) => n + t.count, 0) || stalls.length;
  const for_ = [...new Set(stalls.map((s) => s.name))];
  const me = rows.find((r) => r.you) ?? null;
  const sent = data?.self?.sent ?? 0;
  const late = data?.self?.latePings ?? 0;
  const latePct = sent ? Math.round((late * 1000) / sent) / 10 : 0;
  const tiles = [
    {
      id: 'waited',
      label: 'Game waited',
      value: count ? seconds(waited) : '0 s',
      hint: count ? `in ${count} ${count === 1 ? 'stall' : 'stalls'}${for_.length === 1 ? `, all for ${for_[0]}` : ''}` : 'never: no stalls',
      quality: count ? 'poor' : 'good',
    },
    {
      id: 'avg',
      label: 'Your average ping',
      value: me?.avg !== null && me?.avg !== undefined ? `${me.avg} ms` : 'n/a',
      hint: me?.quality ? `${QUALITY[me.quality][0].toLowerCase()} on average` : 'no measurement',
      quality: me?.quality ?? null,
    },
    {
      id: 'worst',
      label: 'Your worst moment',
      value: me?.worst ? `${me.worst} ms` : 'n/a',
      hint: me?.worst ? `at ${clock(me.worstAt ?? 0)}` : 'no measurement',
      quality: me?.worst ? netQuality({ rtt: me.worst }) : null,
    },
    {
      id: 'late',
      label: 'Late pings',
      value: `${latePct}%`,
      hint: `${late.toLocaleString('en-US')} of ${sent.toLocaleString('en-US')} took over a second`,
      quality: latePct > NET_POOR_LATE_PCT ? 'poor' : late > 0 ? 'fair' : 'good',
    },
  ];
  const tMax = Math.max(1, ...rows.flatMap((r) => r.series.map((p) => p.t + 1)), ...stalls.map((s) => s.t + s.ms));
  const rttMax = Math.max(NET_POOR_RTT_MS * 1.3, ...rows.flatMap((r) => r.series.map((p) => p.rtt)));
  return { rows, stalls, tiles, chart: { tMax, rttMax }, waited, count };
}

// ---- DOM ---------------------------------------------------------------------------------

const SVG = 'http://www.w3.org/2000/svg';

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function svg(tag, attrs = {}) {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) e.setAttribute(k, String(v));
  return e;
}

function lamp(state) {
  const l = el('span', `ui-led ui-led-${state}`);
  l.setAttribute('aria-hidden', 'true');
  return l;
}

/** The chart's size in its viewBox (it scales with the panel). */
export const CHART = Object.freeze({ width: 1000, height: 260, left: 50, right: 20, top: 10, bottom: 40 });

/**
 * Draw the tab into `panel`. `onStall(tick)` opens the replay at a stall
 * (null: the stall rows say why they cannot; `stallNote` says it).
 */
export function renderNetwork(panel, net, { onStall = null, stallNote = '' } = {}) {
  const tiles = el('div', 'net-tiles');
  for (const t of net.tiles) {
    const tile = el('div', `net-tile${t.quality ? ` net-${t.quality}` : ''}`);
    const value = el('span', 'net-tile-value', t.value);
    tile.append(el('span', 'net-tile-label', t.label), value, el('span', 'net-tile-hint', t.hint));
    tiles.append(tile);
  }
  panel.append(tiles);

  // Ping over the whole game.
  const chartBox = el('section', 'net-chart');
  chartBox.setAttribute('aria-labelledby', 'net-chart-title');
  const chartHead = el('div', 'net-chart-head');
  const chartTitle = el('h2', 'net-title', 'Ping over the whole game');
  chartTitle.id = 'net-chart-title';
  const legend = el('ul', 'stats-legend');
  for (const r of net.rows) {
    const li = el('li', 'stats-legend-item', r.name);
    li.style.setProperty('--player-color', r.css ?? '#fff');
    legend.append(li);
  }
  const stallKey = el('li', 'stats-legend-item net-legend-stall', 'Stall');
  legend.append(stallKey);
  chartHead.append(chartTitle, legend);
  const { width, height, left, right, top, bottom } = CHART;
  const x = (t) => left + (t / net.chart.tMax) * (width - left - right);
  const y = (v) => height - bottom - (Math.min(v, net.chart.rttMax) / net.chart.rttMax) * (height - top - bottom);
  const chart = svg('svg', { viewBox: `0 0 ${width} ${height}`, class: 'net-svg', role: 'img', 'aria-label': `Ping per player over ${clock(net.chart.tMax)}, with ${net.stalls.length} ${net.stalls.length === 1 ? 'stall' : 'stalls'} marked. The table and the stall list follow.` });
  // Bands: poor above NET_POOR_RTT_MS, fair from NET_GOOD_RTT_MS.
  chart.append(
    svg('rect', { class: 'net-band-poor', x: left, y: top, width: width - left - right, height: Math.max(0, y(NET_POOR_RTT_MS) - top) }),
    svg('rect', { class: 'net-band-fair', x: left, y: y(NET_POOR_RTT_MS), width: width - left - right, height: Math.max(0, y(NET_GOOD_RTT_MS) - y(NET_POOR_RTT_MS)) }),
  );
  for (const v of [NET_GOOD_RTT_MS, NET_POOR_RTT_MS]) {
    chart.append(svg('line', { class: 'net-grid', x1: left, x2: width - right, y1: y(v), y2: y(v) }));
    const label = svg('text', { class: 'net-axis', x: left - 6, y: y(v) + 4, 'text-anchor': 'end' });
    label.textContent = String(v);
    chart.append(label);
  }
  const zero = svg('text', { class: 'net-axis', x: left - 6, y: y(0) + 4, 'text-anchor': 'end' });
  zero.textContent = '0';
  chart.append(zero);
  for (let k = 0; k <= 4; k++) {
    const t = (net.chart.tMax * k) / 4;
    const label = svg('text', { class: 'net-axis', x: x(t), y: height - 14, 'text-anchor': k === 0 ? 'start' : k === 4 ? 'end' : 'middle' });
    label.textContent = clock(t);
    chart.append(label);
  }
  // A red column per stall: its time and length; hover names who, a click opens the replay there.
  for (const s of net.stalls) {
    const w = Math.max(6, x(s.t + s.ms) - x(s.t));
    const col = svg('rect', { class: 'net-stall', x: x(s.t), y: top, width: w, height: height - top - bottom });
    const tip = svg('title');
    tip.textContent = `${s.at}: ${s.text}, ${s.len}`;
    col.append(tip);
    if (onStall) col.addEventListener('click', () => onStall(s.tick));
    chart.append(col);
    const label = svg('text', { class: 'net-stall-label', x: x(s.t) + w / 2, y: top + 12, 'text-anchor': 'middle' });
    label.textContent = s.len;
    chart.append(label);
  }
  for (const r of net.rows) {
    if (r.series.length < 1) continue;
    const d = r.series.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)} ${y(p.rtt).toFixed(1)}`).join(' ');
    // The player's colour is a presentation attribute (no style attribute: strict CSP).
    chart.append(svg('path', { class: 'net-line', d, stroke: r.css ?? 'currentColor' }));
  }
  chartBox.append(chartHead, chart, el('p', 'net-note', 'Red columns are stalls: moments when the whole game waited for one player. Point at a column for who and how long.'));
  panel.append(chartBox);

  const lower = el('div', 'net-lower');
  // Per player.
  const table = el('section', 'net-players');
  table.setAttribute('aria-labelledby', 'net-players-title');
  const tableTitle = el('h2', 'net-title', 'Per player');
  tableTitle.id = 'net-players-title';
  const scroll = el('div', 'stats-scroll');
  const t = el('table', 'stats-table net-table');
  t.append(el('caption', 'ui-sr-only', 'Connection of every player over the game'));
  const head = el('tr');
  for (const [label, num] of [['Player', false], ['Quality', false], ['Average', true], ['Worst', true], ['Jitter', true], ['Loss', true], ['Held up', true]]) {
    const th = el('th', num ? 'num' : null, label);
    th.setAttribute('scope', 'col');
    head.append(th);
  }
  const thead = el('thead');
  thead.append(head);
  const tbody = el('tbody');
  for (const r of net.rows) {
    const tr = el('tr', r.quality === 'poor' ? 'net-row-poor' : null);
    const who = el('th', 'stats-player', r.you ? `${r.name} (you)` : r.name);
    who.setAttribute('scope', 'row');
    who.style.setProperty('--player-color', r.css ?? '#fff');
    const q = el('td', `net-quality${r.quality ? ` net-${r.quality}` : ''}`);
    if (r.quality) q.append(lamp(QUALITY[r.quality][1]), QUALITY[r.quality][0]);
    else q.textContent = 'n/a';
    const ms = (v) => (v === null || v === undefined ? 'n/a' : `${v} ms`);
    tr.append(
      who,
      q,
      el('td', 'num', ms(r.avg)),
      el('td', 'num', ms(r.worst)),
      el('td', 'num', r.jitter === null ? 'n/a' : `±${r.jitter}`),
      el('td', `num${(r.late ?? 0) > NET_POOR_LATE_PCT ? ' net-bad-text' : ''}`, r.late === null ? 'n/a' : `${r.late}%`),
      el('td', `num${r.held ? ' net-bad-text' : ''}`, seconds(r.held)),
    );
    tbody.append(tr);
  }
  t.append(thead, tbody);
  scroll.append(t);
  table.append(tableTitle, scroll);

  // The stalls: each opens the replay at its moment.
  const list = el('section', 'net-stalls');
  list.setAttribute('aria-labelledby', 'net-stalls-title');
  const listTitle = el('h2', 'net-title', 'Stalls');
  listTitle.id = 'net-stalls-title';
  list.append(listTitle);
  if (!net.stalls.length) list.append(el('p', 'hint', 'No stalls: the game never waited for anyone.'));
  else {
    const ul = el('ul', 'net-stall-list');
    for (const s of net.stalls) {
      const li = el('li');
      const b = el('button', 'net-stall-row');
      b.type = 'button';
      b.append(el('span', 'net-stall-at', s.at), el('span', 'net-stall-what', s.text), el('span', 'net-stall-len', s.len));
      b.setAttribute('aria-label', `${s.at}: ${s.text} for ${s.len}. ${onStall ? 'Opens the replay at that moment.' : stallNote}`);
      if (onStall) b.addEventListener('click', () => onStall(s.tick));
      else {
        b.disabled = true;
        if (stallNote) b.title = stallNote;
      }
      li.append(b);
      ul.append(li);
    }
    list.append(ul);
  }
  list.append(el('p', 'net-note', onStall ? 'Choose a stall to watch it in the replay.' : stallNote));
  lower.append(table, list);
  panel.append(lower);
}

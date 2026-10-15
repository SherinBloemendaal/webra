// Connection quality in an online game (docs/redesign-uitwerking.md section
// 29, the NetInGame board): the signal bars next to the clock in the
// sidebar, the warning about the own connection at the top of the
// battlefield, and the "Waiting for X" panel with the countdown to the drop
// when the game waits for a player. The data is the session's NetQuality
// (js/netquality.js, docs/contracts.md "Network quality"): its `self`,
// `players` and `waiting` events. Single player, skirmish and replays create
// none of this (js/main.js makes a NetWarn only for an online game that
// brings a `net` handle).
//
// The settings net.warnSelf, net.warnOthers and net.signalBars (game menu,
// Settings; js/registry.js) switch the three parts off one by one.
//
// A click on the signal bars asks the game menu for its Network tab with the
// window event OPEN_NETWORK_EVENT; the menu (js/gamemenu.js) listens for it.
//
// SelfWarning, WaitWatch, signalState and waitRows hold the rules without a
// DOM (tests/netwarn.test.mjs); NetWarn draws them.

import { attachTooltip } from './ui/tooltip.js';
import { led, setLed } from './ui/controls.js';
import { DROP_AFTER_MS, RECONNECT_GRACE_MS } from './protocol.js';

/** Window event that opens the game menu on its Network tab (detail: `{ tab: 'network' }`). */
export const OPEN_NETWORK_EVENT = 'webra:open-network';
/** The own connection must be poor this long without a break before the warning shows. */
export const SELF_WARN_AFTER_MS = 10_000;
/** The "Waiting for X" panel shows this long after the game began to wait for X (the chat line comes at once). */
export const WAIT_PANEL_AFTER_MS = 2_000;
/** How often the countdown and the warning's timing are refreshed. */
export const NET_TICK_MS = 250;
/** Signal bars drawn, and how many of them each quality lights (netquality.js netBars). */
export const BAR_COUNT = 4;

const WORDS = { good: 'good', fair: 'fair', poor: 'poor' };
const LEDS = { good: 'ok', fair: 'warn', poor: 'bad' };

/** "34 ms", or null without a value. */
export function formatMs(ms) {
  return ms === null || ms === undefined || !Number.isFinite(ms) ? null : `${Math.round(ms)} ms`;
}

/** Late pings ("loss" in the UI) in percent: "0%", "2.5%". */
export function formatLate(pct) {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return null;
  return `${Math.round(pct * 10) / 10}%`;
}

/**
 * What the signal bars show for a measurement (NetQuality `self` or a
 * PlayerNet): how many bars are lit, the level (`good`, `fair`, `poor`, or
 * `none` before the first round trip), the word that goes with it (the
 * second signal next to the colour) and the accessible label. The quality
 * and the bar count come from netquality.js (netQuality, netBars: 4 good,
 * 3 fair, 1 poor, 0 unknown), so the lobby, the game and the statistics
 * judge a connection the same way.
 * @param {{ quality?: string|null, bars?: number, rtt?: number|null } | null} m
 * @returns {{ bars: number, level: 'good'|'fair'|'poor'|'none', word: string, label: string }}
 */
export function signalState(m) {
  const level = m?.quality && WORDS[m.quality] ? m.quality : 'none';
  if (level === 'none') return { bars: 0, level, word: 'measuring', label: 'Your connection: measuring' };
  const bars = Math.max(0, Math.min(BAR_COUNT, Math.round(m.bars ?? 0)));
  const ms = formatMs(m.rtt);
  return { bars, level, word: WORDS[level], label: `Your connection: ${WORDS[level]}${ms ? `, ${ms}` : ''}` };
}

/** The signal bars' tooltip: ping, jitter and late pings, and what a click does. */
export function signalTip(self) {
  const s = signalState(self);
  const lines = [
    `Ping: ${formatMs(self?.rtt) ?? 'measuring'}`,
    `Jitter: ${formatMs(self?.jitter) ?? 'measuring'}`,
    `Loss: ${formatLate(self?.late) ?? 'measuring'} (pings slower than a second)`,
  ];
  return {
    title: `Your connection: ${s.word}`,
    desc: lines.join('\n'),
    notes: [{ text: 'Click for the Network tab of the game menu.', tone: 'hint' }],
  };
}

/** The warning's detail line: "320 ms · 6% loss." */
export function selfWarningText(self) {
  const parts = [formatMs(self?.rtt), formatLate(self?.late) ? `${formatLate(self.late)} loss` : null].filter(Boolean);
  return `${parts.length ? `${parts.join(' · ')}. ` : ''}Your orders may arrive late and others may wait for you.`;
}

/**
 * When the warning about the own connection shows: once the connection has
 * been poor for SELF_WARN_AFTER_MS without a break. Hidden by the player, it
 * stays away until the connection recovered and then was poor for the whole
 * time again; it also goes when the connection recovers.
 */
export class SelfWarning {
  constructor({ afterMs = SELF_WARN_AFTER_MS } = {}) {
    this.afterMs = afterMs;
    /** Since when (ms, the caller's clock) the connection is poor, or null. */
    this.poorSince = null;
    this.dismissed = false;
    this.shown = false;
  }

  /**
   * The quality now (`good`, `fair`, `poor` or null) at time `now`; `enabled`
   * is the net.warnSelf setting. Returns whether the warning shows.
   */
  update(quality, now, enabled = true) {
    if (quality === 'poor') this.poorSince ??= now;
    else {
      this.poorSince = null;
      // Recovered: the next poor stretch may warn again.
      this.dismissed = false;
    }
    this.shown = !!enabled && !this.dismissed && this.poorSince !== null && now - this.poorSince >= this.afterMs;
    return this.shown;
  }

  /** The player hid it (only counts while it shows). */
  dismiss() {
    if (!this.shown) return;
    this.dismissed = true;
    this.shown = false;
  }
}

/**
 * Whom the game waits for, from NetQuality's `waiting` (`{ client, heldMs,
 * dropInMs, at }`, `at` the wall time it arrived, or null when the game runs
 * again): when a new wait begins (the chat line), whether the panel shows
 * (WAIT_PANEL_AFTER_MS later) and the countdown to the drop.
 */
export class WaitWatch {
  constructor({ panelAfterMs = WAIT_PANEL_AFTER_MS, dropAfterMs = DROP_AFTER_MS } = {}) {
    this.panelAfterMs = panelAfterMs;
    this.dropAfterMs = dropAfterMs;
    this.current = null;
    /** When (the caller's clock) the game began to wait for `current.client`. */
    this.since = 0;
  }

  /**
   * A `waiting` message (or null) at time `now`. Returns the client the game
   * has just begun to wait for (a new wait, or another player than before),
   * else null.
   */
  set(waiting, now) {
    if (!waiting || waiting.client === null || waiting.client === undefined) {
      this.current = null;
      return null;
    }
    const fresh = !this.current || this.current.client !== waiting.client;
    if (fresh) this.since = now;
    this.current = { client: waiting.client, heldMs: waiting.heldMs ?? 0, dropInMs: waiting.dropInMs ?? this.dropAfterMs, at: waiting.at ?? now };
    return fresh ? waiting.client : null;
  }

  /**
   * The wait at time `now`, or null: whether the panel shows, how long the
   * player has held the game, how long until the drop and that time as a
   * share of the whole drop window (the countdown bar).
   * @returns {null | { client: number, panel: boolean, heldMs: number, dropLeftMs: number, fraction: number }}
   */
  view(now) {
    const w = this.current;
    if (!w) return null;
    const elapsed = Math.max(0, now - w.at);
    const dropLeftMs = Math.max(0, w.dropInMs - elapsed);
    return {
      client: w.client,
      panel: now - this.since >= this.panelAfterMs,
      heldMs: w.heldMs + elapsed,
      dropLeftMs,
      fraction: Math.max(0, Math.min(1, dropLeftMs / this.dropAfterMs)),
    };
  }
}

/**
 * The player rows of the waiting panel, in seat order: each player of the
 * game (`roster`, people only) with the state of their connection, as a word
 * and a lamp, so it reads without colour too.
 * @param {Array<{ client: number|null, player: number, name: string }>} roster
 * @param {Map<number, { rtt: number|null, quality: string|null, silent?: number|null }>} players NetQuality `players`
 * @param {{ client: number, heldMs: number } | null} wait
 * @returns {Array<{ client: number, player: number, name: string, state: 'behind'|'good'|'fair'|'poor'|'silent'|'unknown', led: string, text: string }>}
 */
export function waitRows(roster, players, wait) {
  return roster
    .filter((p) => p.client !== null && p.client !== undefined)
    .map((p) => {
      const net = players?.get(p.client) ?? null;
      const base = { client: p.client, player: p.player, name: p.name };
      if (wait && wait.client === p.client) return { ...base, state: 'behind', led: 'bad', text: `behind · ${Math.round(wait.heldMs)} ms` };
      if (net?.silent) return { ...base, state: 'silent', led: 'bad', text: `silent · ${Math.ceil(net.silent / 1000)} s` };
      const q = net?.quality && WORDS[net.quality] ? net.quality : null;
      if (!q) return { ...base, state: 'unknown', led: 'off', text: 'measuring' };
      const word = q === 'good' ? 'ok' : q;
      return { ...base, state: q, led: LEDS[q], text: `${word} · ${formatMs(net.rtt)}` };
    });
}

/** The waiting panel's explanation (the drop rule of the server, js/protocol.js DROP_AFTER_MS and RECONNECT_GRACE_MS). */
export function waitText(name, dropAfterMs = DROP_AFTER_MS, rejoinMs = RECONNECT_GRACE_MS) {
  const rejoin = rejoinMs % 60_000 === 0 ? `${rejoinMs / 60_000} minute${rejoinMs === 60_000 ? '' : 's'}` : `${Math.round(rejoinMs / 1000)} seconds`;
  return `The game continues as soon as ${name} catches up. A player who holds the game up for ${Math.round(dropAfterMs / 1000)} seconds is dropped and can rejoin within ${rejoin}.`;
}

function el(doc, tag, className, text) {
  const e = doc.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function setText(node, text) {
  const s = String(text);
  if (node.textContent !== s) node.textContent = s;
}

/**
 * The connection parts of an online game's HUD.
 *
 *   const net = new NetWarn({ quality, roster, you, field, slot, registry, line, colorOf });
 *   net.dispose();
 */
export class NetWarn {
  /**
   * @param {object} o
   * @param {{ on(type: string, fn: Function): () => void, self?: object, players?: Map, waiting?: object|null }} o.quality
   *   the session's NetQuality (js/netquality.js)
   * @param {Array<{ client: number|null, player: number, name: string }>} o.roster the players of the game (start message)
   * @param {number|null} [o.you] this member's client id (not named in its own wait)
   * @param {HTMLElement} o.field the battlefield (#field): the warning and the panel go in here
   * @param {HTMLElement|null} [o.slot] the sidebar's place next to the clock (js/sidebar.js `netSlot`); none for spectators
   * @param {{ get(group: string, key: string): unknown, subscribe(group: string, fn: Function): () => void } | null} [o.registry]
   *   the settings registry (js/registry.js), for net.warnSelf, net.warnOthers and net.signalBars
   * @param {(text: string) => void} [o.line] write a system line in the chat log
   * @param {(player: number) => string} [o.colorOf] a player's colour (CSS)
   * @param {boolean} [o.warnSelf] whether the own warning applies (players: yes; spectators hold nobody up)
   * @param {() => number} [o.now] the wall clock (NetQuality's `waiting.at` uses Date.now)
   * @param {EventTarget} [o.events] where OPEN_NETWORK_EVENT goes (the window)
   */
  constructor({ quality, roster = [], you = null, field, slot = null, registry = null, line = () => {}, colorOf = () => 'currentColor', warnSelf = true, now = () => Date.now(), events = globalThis.window ?? globalThis, timers = globalThis }) {
    Object.assign(this, { quality, roster, you, field, slot, registry, line, colorOf, now, events, timers });
    this.doc = field.ownerDocument ?? globalThis.document;
    this.ownWarning = warnSelf;
    this.self = quality.self ?? null;
    this.players = quality.players ?? new Map();
    this.warning = new SelfWarning();
    this.wait = new WaitWatch();
    this.settings = this.readSettings();
    this.offs = [];
    this.build();
    this.offs.push(quality.on('self', (s) => {
      this.self = s;
      this.render();
    }));
    this.offs.push(quality.on('players', (p) => {
      this.players = p;
      this.render();
    }));
    this.offs.push(quality.on('waiting', (w) => this.onWaiting(w)));
    if (registry?.subscribe) {
      this.offs.push(registry.subscribe('net', () => {
        this.settings = this.readSettings();
        this.render();
      }));
    }
    if (quality.waiting) this.onWaiting(quality.waiting);
    this.timer = timers.setInterval(() => this.render(), NET_TICK_MS);
    this.render();
  }

  readSettings() {
    const get = (key) => {
      try {
        return this.registry ? this.registry.get('net', key) !== false : true;
      } catch {
        return true;
      }
    };
    return { warnSelf: get('warnSelf'), warnOthers: get('warnOthers'), signalBars: get('signalBars') };
  }

  build() {
    const doc = this.doc;
    // Signal bars: a button next to the clock (opens the game menu's Network tab).
    if (this.slot) {
      const b = el(doc, 'button', 'net-bars');
      b.type = 'button';
      // Opening the menu releases the mouse anyway (js/mouselock.js).
      b.dataset.noCapture = '';
      this.barEls = [];
      for (let i = 0; i < BAR_COUNT; i++) {
        const bar = el(doc, 'span', `net-bar net-bar-${i + 1}`);
        bar.setAttribute('aria-hidden', 'true');
        this.barEls.push(bar);
        b.append(bar);
      }
      b.addEventListener('click', () => this.openNetwork());
      this.barsTip = attachTooltip(b, () => signalTip(this.self), { side: 'left' });
      this.barsEl = b;
      this.slot.append(b);
    }
    // The own connection: a banner at the top of the battlefield.
    const warn = el(doc, 'div', 'net-warning');
    warn.setAttribute('role', 'alert');
    warn.hidden = true;
    const icon = el(doc, 'span', 'net-warning-bars');
    icon.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < BAR_COUNT; i++) icon.append(el(doc, 'span', `net-bar net-bar-${i + 1}${i === 0 ? ' lit' : ''}`));
    const text = el(doc, 'span', 'net-warning-text');
    text.append(el(doc, 'span', 'net-warning-title', 'Your connection is unstable'));
    this.warnDetail = el(doc, 'span', 'net-warning-detail');
    text.append(this.warnDetail);
    const close = el(doc, 'button', 'net-warning-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Hide the connection warning');
    close.addEventListener('click', () => {
      this.warning.dismiss();
      this.render();
    });
    // Keep the press away from the map (it would deselect).
    warn.addEventListener('mousedown', (e) => e.stopPropagation());
    warn.append(icon, text, close);
    this.warnEl = warn;

    // Waiting for a player: a panel in the middle, over a dimmed battlefield.
    const dim = el(doc, 'div', 'net-waiting-dim');
    dim.hidden = true;
    const panel = el(doc, 'div', 'net-waiting');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'false');
    panel.hidden = true;
    const hazard = el(doc, 'div', 'net-waiting-hazard');
    hazard.setAttribute('aria-hidden', 'true');
    const body = el(doc, 'div', 'net-waiting-body');
    const title = el(doc, 'h2', 'net-waiting-title');
    title.id = 'net-waiting-title';
    title.append('Waiting for ');
    this.waitName = el(doc, 'span', 'net-waiting-name');
    title.append(this.waitName);
    panel.setAttribute('aria-labelledby', title.id);
    this.waitText = el(doc, 'p', 'net-waiting-text');
    const count = el(doc, 'div', 'net-waiting-count');
    count.setAttribute('role', 'timer');
    const countHead = el(doc, 'div', 'net-waiting-count-head');
    countHead.append(el(doc, 'span', 'net-waiting-count-label', 'dropped in'));
    this.waitLeft = el(doc, 'span', 'net-waiting-left');
    countHead.append(this.waitLeft);
    const track = el(doc, 'div', 'net-waiting-track');
    this.waitFill = el(doc, 'div', 'net-waiting-fill');
    track.append(this.waitFill);
    count.append(countHead, track);
    this.waitList = el(doc, 'ul', 'net-waiting-players');
    this.waitList.setAttribute('aria-label', 'Players');
    body.append(title, this.waitText, count, this.waitList);
    panel.append(hazard, body);
    this.dimEl = dim;
    this.panelEl = panel;
    this.rowEls = new Map();
    this.field.append(dim, warn, panel);
  }

  /** Ask the game menu for its Network tab. */
  openNetwork() {
    const Ev = globalThis.CustomEvent;
    const event = typeof Ev === 'function' ? new Ev(OPEN_NETWORK_EVENT, { detail: { tab: 'network' } }) : { type: OPEN_NETWORK_EVENT, detail: { tab: 'network' } };
    this.events?.dispatchEvent?.(event);
  }

  /** A player's name by client id (a spectator or someone gone: "A player"). */
  nameOf(client) {
    return this.roster.find((p) => p.client === client)?.name ?? 'A player';
  }

  onWaiting(w) {
    const began = this.wait.set(w, this.now());
    // OpenRA has no such line; WebRA says who holds the game, once per wait.
    if (began !== null && began !== this.you && this.settings.warnOthers) this.line(`Waiting for ${this.nameOf(began)}.`);
    this.render();
  }

  render() {
    const now = this.now();
    // Signal bars.
    if (this.barsEl) {
      const s = signalState(this.self);
      this.barsEl.hidden = !this.settings.signalBars;
      this.barsEl.dataset.level = s.level;
      this.barEls.forEach((b, i) => b.classList.toggle('lit', i < s.bars));
      if (this.barsEl.getAttribute('aria-label') !== s.label) this.barsEl.setAttribute('aria-label', s.label);
      this.barsTip.refresh();
    }
    // The own connection.
    const shown = this.warning.update(this.self?.quality ?? null, now, this.ownWarning && this.settings.warnSelf);
    if (shown) setText(this.warnDetail, selfWarningText(this.self));
    if (this.warnEl.hidden === shown) this.warnEl.hidden = !shown;
    // Waiting for a player (never for oneself: the own warning covers that).
    const v = this.wait.view(now);
    const panel = !!v && v.panel && v.client !== this.you && this.settings.warnOthers;
    if (this.panelEl.hidden === panel) {
      this.panelEl.hidden = !panel;
      this.dimEl.hidden = !panel;
    }
    if (!panel) return;
    const name = this.nameOf(v.client);
    setText(this.waitName, name);
    const seat = this.roster.find((p) => p.client === v.client);
    this.waitName.style.setProperty('--net-player', seat ? this.colorOf(seat.player) : 'currentColor');
    setText(this.waitText, waitText(name, this.wait.dropAfterMs));
    setText(this.waitLeft, `${Math.ceil(v.dropLeftMs / 1000)} s`);
    this.waitFill.style.setProperty('--net-left', v.fraction.toFixed(4));
    this.renderRows(waitRows(this.roster, this.players, v));
  }

  renderRows(rows) {
    const doc = this.doc;
    const keep = new Set();
    const nodes = rows.map((r) => {
      keep.add(r.client);
      let row = this.rowEls.get(r.client);
      if (!row) {
        const li = el(doc, 'li', 'net-waiting-player');
        const strip = el(doc, 'span', 'net-waiting-strip');
        strip.setAttribute('aria-hidden', 'true');
        const name = el(doc, 'span', 'net-waiting-player-name');
        const lamp = led('off');
        const state = el(doc, 'span', 'net-waiting-state');
        li.append(strip, name, lamp, state);
        row = { li, strip, name, lamp, state, led: 'off', kind: '' };
        this.rowEls.set(r.client, row);
      }
      setText(row.name, r.name);
      setText(row.state, r.text);
      row.strip.style.setProperty('--net-player', this.colorOf(r.player));
      if (row.led !== r.led) {
        row.led = r.led;
        setLed(row.lamp, r.led);
      }
      if (row.kind !== r.state) {
        row.kind = r.state;
        row.li.dataset.state = r.state;
      }
      return row.li;
    });
    for (const id of [...this.rowEls.keys()]) if (!keep.has(id)) this.rowEls.delete(id);
    const kids = this.waitList.children;
    if (kids.length !== nodes.length || nodes.some((n, i) => kids[i] !== n)) this.waitList.replaceChildren(...nodes);
  }

  /** The game is going: listeners, the timer and the parts leave. */
  dispose() {
    for (const off of this.offs.splice(0)) off?.();
    this.timers.clearInterval(this.timer);
    this.barsTip?.detach();
    this.barsEl?.remove();
    this.warnEl.remove();
    this.panelEl.remove();
    this.dimEl.remove();
  }
}

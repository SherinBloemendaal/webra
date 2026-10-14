// In-game sidebar, laid out like the Red Alert sidebar of OpenRA: a row of
// command buttons, the radar slot, money and game clock, then the power
// meter, a column of production tabs and the build grid of cameos, and the
// selection panel. The DOM is built once; update() only patches text, classes
// and CSS variables so it is cheap to call ~10x per second. Every button has
// the shared tooltip (js/ui/tooltip.js): the top row and the tabs OpenRA's
// button tooltip, the cameos its production tooltip (production.js
// `productionTip`), all with the current hotkey.

import { heatText } from './weather-fx.js';
import { TEAM_COLORS } from './renderer.js';
import { cameoBacking, cameoPainter } from './cameo.js';
import { watchPixelRatio } from './scale.js';
import { icon } from './ui-icons.js';
import { formatCombo } from './hotkeys.js';
import { attachTooltip } from './ui/tooltip.js';
import { menuKeys } from './hudtips.js';
import { CashCounter } from './cashcounter.js';
import { blinkOn, clockText } from './gametimer.js';
import {
  BuildEta,
  cancelEndsPlacement,
  clickAction,
  formatClock,
  isStructureQueue,
  placementLost,
  productionTip,
  queueOutcome,
  rightClickAction,
  summarizeQueues,
} from './production.js';

// Must match QueueType in engine/src/rules.rs.
const QUEUE_NAMES = ['Buildings', 'Defense', 'Infantry', 'Vehicles', 'Aircraft', 'Naval'];
const QUEUE_ICONS = ['buildings', 'defense', 'infantry', 'vehicles', 'aircraft', 'naval'];
// The tab hotkeys (js/gamekeys.js, OpenRA ProductionType*), in queue order.
const QUEUE_ACTIONS = ['productionTabBuildings', 'productionTabDefense', 'productionTabInfantry', 'productionTabVehicles', 'productionTabAircraft', 'productionTabNaval'];
const QUEUE_BUILDINGS = 0;

// Cameo size in CSS pixels at UI scale 1: Red Alert's 64x48 cameos (OpenRA's
// RA sidebar). The canvases are drawn at the size the cards really have on
// the screen (fitCameos), so they stay sharp at any UI scale and pixel ratio.
const CAMEO_WIDTH = 64;
const CAMEO_HEIGHT = 48;

// Power meter: above this share of the generated power the bar turns amber.
const POWER_TIGHT = 0.85;

/** Create an element with an optional class and text. */
function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Only touch the DOM when the value really changed. */
function setText(node, text) {
  const s = String(text);
  if (node.textContent !== s) node.textContent = s;
}

function setVar(node, name, value) {
  const s = String(value);
  if (node.style.getPropertyValue(name) !== s) node.style.setProperty(name, s);
}

export class Sidebar {
  /**
   * @param {HTMLElement} root the <aside id="sidebar"> element
   * @param {object} game wasm Game instance
   * @param {object} rules parsed rules_json()
   * @param {number} playerId local player id
   * @param {{onPlace?: (id: string) => void, onCancelPlace?: () => void, onMode?: (mode: string) => void,
   *   onDeploy?: () => void, onMenu?: () => void, shiftLatched?: () => boolean,
   *   onProductionClick?: (id: string, outcome: string | null) => void}} callbacks
   *   onMode: a top row mode button ('beacon', 'sell', 'powerDown', 'repair') was pressed;
   *   onProductionClick: a cameo click did something, with the queue's speech for it
   *   ('queued', 'blocked', 'limited', 'resumed', 'onHold', 'cancelled', or null)
   * @param {{ticksPerSecond?: number, hotkeys?: import('./hotkeys.js').HotkeyRegistry, now?: () => number}} [options]
   *   game ticks per second, for the clocks; the hotkey registry, for the keys in tooltips;
   *   the clock of animation frames in milliseconds (performance.now)
   */
  constructor(root, game, rules, playerId, callbacks = {}, options = {}) {
    this.root = root;
    this.game = game;
    this.playerId = playerId;
    this.callbacks = callbacks;
    this.ticksPerSecond = options.ticksPerSecond || 25;
    // OpenRA GameTimerLogic: "Paused" blinks in the clock while the game is paused (setPaused).
    this.now = options.now ?? (() => Date.now());
    this.clockStart = this.now();
    this.paused = false;
    this.hotkeys = options.hotkeys ?? null;
    this.teamRgb = TEAM_COLORS[playerId % TEAM_COLORS.length];
    /** Production takes this percentage of its time while power is low (the tooltips' build time). */
    this.lowPowerModifier = rules.lowPowerModifier;
    /** player_json `buildable` entries by id (requirements, build time). */
    this.buildable = new Map();
    /** Every tooltip of the sidebar, refreshed with each update (the open one re-renders). */
    this.tips = [];

    this.actors = new Map();
    for (const a of rules.actors) this.actors.set(a.id, a);

    this.activeTab = QUEUE_BUILDINGS;
    this.cards = new Map(); // actor id -> card record
    this.gridKey = ''; // ids currently shown in the grid, in order
    this.placingId = null;
    this.state = null;
    this.iconFailures = new Set();
    /** Backing store size of the cameo canvases, in device pixels (fitCameos). */
    this.cameoPx = cameoBacking(CAMEO_WIDTH, CAMEO_HEIGHT, globalThis.devicePixelRatio);

    // Credits counter (js/cashcounter.js): ticks toward the real value like
    // OpenRA's, with its cash tick sounds (callbacks.onCashTick).
    this.credits = null;
    this.creditsFrame = 0;
    this.creditsLast = 0;
    // The clock of animation frames (requestAnimationFrame times); tests pass their own.
    this.now = options.now ?? (() => performance.now());
    this.creditsRest = 0;

    this.build();
  }

  // ---- DOM construction (once) -----------------------------------------

  /** Square icon button of the top row, with a tooltip of `spec()`. */
  toolButton(name, label, spec, onClick) {
    const b = el('button', `sb-tool sb-tool-${name}`);
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.append(icon(name));
    b.addEventListener('click', onClick);
    this.tip(b, spec);
    return b;
  }

  /** The shared tooltip on `target` (left of the sidebar where there is room). */
  tip(target, spec) {
    const t = attachTooltip(target, spec, { side: 'left' });
    this.tips.push(t);
    return t;
  }

  /** Re-render the open tooltip, if it is one of ours (the state or a key changed). */
  refreshTips() {
    for (const t of this.tips) t.refresh();
  }

  /** Current key of a hotkey action ("Z", "Ctrl+X" or "Cmd+X"), or null. */
  keyOf(action) {
    const combo = this.hotkeys?.bindingsFor(action)[0];
    return combo ? formatCombo(combo) : null;
  }

  build() {
    const root = this.root;
    root.textContent = '';
    root.classList.add('sb');
    root.setAttribute('aria-label', 'Command sidebar');
    root.addEventListener('contextmenu', (e) => e.preventDefault());

    // Command buttons, OpenRA's Red Alert top row: Beacon, Sell, Power down
    // and Repair modes (js/input.js), then WebRA's Deploy and the Options menu.
    const tools = el('div', 'sb-tools');
    this.modeButtons = new Map();
    const tool = (name, label, action, help, onClick, hotkey = () => this.keyOf(action)) => {
      const spec = () => ({
        title: label,
        hotkey: hotkey(),
        desc: help,
        notes: btn.disabled ? [{ text: 'Select an MCV, a Construction Yard or a loaded transport.', tone: 'hint' }] : [],
      });
      const btn = this.toolButton(name, label, spec, onClick);
      tools.append(btn);
      return btn;
    };
    const mode = (name, mode, label, action, help) => {
      const btn = tool(name, label, action, help, () => this.callbacks.onMode?.(mode));
      btn.setAttribute('aria-pressed', 'false');
      this.modeButtons.set(mode, btn);
      return btn;
    };
    mode('beacon', 'beacon', 'Place beacon', 'placeBeacon', 'Click the map to mark a spot for your allies.');
    mode('sell', 'sell', 'Sell', 'sell', 'Click your structures to sell them for half their value (scaled by health). Right click or Esc ends it.');
    mode('powerDown', 'powerDown', 'Power down', 'powerDown', 'Click your defences, radar and superweapons to switch them off (freeing their power) or on again.');
    mode(
      'repair',
      'repair',
      'Repair',
      'repair',
      'Click your or allied damaged structures to start or stop repairing them, or a damaged unit to send it to the repair depot. Drag a box to repair all your damaged structures in it. With your structures selected, repairs all selected damaged ones at once (again: stops them).',
    );
    this.deployBtn = tool(
      'deploy',
      'Deploy',
      'deploy',
      'Deploy the selected MCV, pack up the selected Construction Yard, or unload the selected transport.',
      () => this.callbacks.onDeploy?.(),
    );
    if (this.callbacks.onMenu) {
      this.menuBtn = tool('options', 'Options', null, 'Game menu: settings, controls, leave the game.', () => this.callbacks.onMenu(), () => menuKeys(this.hotkeys));
      this.menuBtn.classList.add('sb-tool-end');
    }
    // Tooltips and cameo keys follow rebinding in the game menu.
    this.hotkeys?.onChange(() => {
      this.slotKeys = null;
      this.refreshTips();
    });

    // Radar slot: the minimap draws in here. Empty, it shows "radar offline".
    this.radarEl = el('div', 'sb-radar');
    this.radarEl.id = 'radar';
    this.radarEl.dataset.offlineLabel = 'Radar offline';

    // Money and game clock, with the ore silos as a thin bar underneath.
    const status = el('div', 'sb-status');
    const money = el('div', 'sb-money');
    money.append(el('span', 'sb-money-sign', '$'));
    this.creditsEl = el('span', 'sb-credits', '0');
    this.creditsEl.setAttribute('aria-live', 'off');
    money.append(this.creditsEl);
    this.moneyEl = money;
    this.clockEl = el('time', 'sb-clock-text', formatClock(0));
    this.tip(this.clockEl, () => ({ title: 'Game time', desc: 'Time played in this game.' }));
    status.append(money, this.clockEl);
    const silo = el('div', 'sb-silo');
    this.siloFill = el('div', 'sb-silo-fill');
    silo.append(this.siloFill);
    this.oreEl = el('span', 'ui-sr-only', 'Ore 0 / 0');
    silo.append(this.oreEl);
    this.siloEl = silo;
    const creditsTip = () => this.creditsTip();
    this.tip(money, creditsTip);
    this.tip(silo, creditsTip);

    // Power meter: a vertical bar of the power used against the produced
    // capacity (the marker), like Red Alert's.
    const power = el('div', 'sb-power');
    const meter = el('div', 'sb-power-meter');
    meter.setAttribute('role', 'meter');
    meter.setAttribute('aria-label', 'Power used');
    meter.setAttribute('aria-valuemin', '0');
    this.powerFillEl = el('div', 'sb-power-fill');
    this.powerCapEl = el('div', 'sb-power-cap');
    meter.append(this.powerFillEl, this.powerCapEl);
    const bolt = el('div', 'sb-power-icon');
    bolt.append(icon('power'));
    this.powerMeterEl = meter;
    this.powerRootEl = power;
    power.append(meter, bolt);
    this.tip(power, () => this.powerTip());

    // Production tabs: a column of icon buttons.
    const tabs = el('div', 'sb-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-orientation', 'vertical');
    tabs.setAttribute('aria-label', 'Production');
    this.tabs = QUEUE_NAMES.map((name, q) => {
      const btn = el('button', 'sb-tab');
      btn.type = 'button';
      btn.id = `sb-tab-${q}`;
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-controls', 'sb-grid');
      btn.setAttribute('aria-label', name);
      const badge = el('span', 'sb-tab-badge');
      badge.hidden = true;
      btn.append(icon(QUEUE_ICONS[q]), badge);
      btn.addEventListener('click', () => {
        this.openTab(q);
      });
      tabs.append(btn);
      const tab = { btn, badge, name, state: '', activity: 0, ready: false };
      this.tip(btn, () => tabTip(tab, this.keyOf(QUEUE_ACTIONS[q])));
      return tab;
    });

    // Card grid.
    this.gridEl = el('div', 'sb-grid');
    this.gridEl.id = 'sb-grid';
    this.gridEl.setAttribute('role', 'tabpanel');
    this.watchCameoSize();
    this.emptyEl = el('div', 'sb-empty', 'Nothing available');

    const main = el('div', 'sb-main');
    main.append(power, tabs, this.gridEl);

    // Selection panel.
    const sel = el('div', 'sb-sel');
    this.selNameEl = el('div', 'sb-sel-name', 'No selection');
    this.selDetailEl = el('div', 'sb-sel-detail');
    const hpBar = el('div', 'sb-hp');
    this.selHpFill = el('div', 'sb-hp-fill');
    hpBar.append(this.selHpFill);
    this.selHpBar = hpBar;
    hpBar.hidden = true;
    sel.append(this.selNameEl, hpBar, this.selDetailEl);
    this.selEl = sel;
    sel.classList.add('empty');

    root.append(tools, this.radarEl, status, silo, main, sel);
    this.selectTab(this.activeTab);
  }

  /** Card (cameo) for one actor type, created lazily the first time it becomes visible. */
  card(id) {
    let c = this.cards.get(id);
    if (c) return c;
    const actor = this.actors.get(id);
    const btn = el('button', 'sb-card');
    btn.type = 'button';
    btn.dataset.id = id;
    // Its sounds follow what the click did (onProductionClick), not every click.
    btn.dataset.clickSound = 'own';

    const canvas = el('canvas', 'sb-icon');
    canvas.width = this.cameoPx.width;
    canvas.height = this.cameoPx.height;

    // Build clock: a clock-wipe shade over the picture, with the time left.
    const clock = el('div', 'sb-clock');
    const eta = el('span', 'sb-eta');
    eta.hidden = true;
    const count = el('span', 'sb-count');
    count.hidden = true;
    const ready = el('span', 'sb-ready', 'Ready');
    // OpenRA's "ON HOLD" over a paused item.
    const hold = el('span', 'sb-hold', 'On hold');
    const name = el('span', 'sb-name', actor.name);
    const slot = el('span', 'sb-slot');
    slot.hidden = true;
    // What is missing, on the cameo itself for touch screens (no hover tooltip there).
    const req = el('span', 'sb-req');
    req.setAttribute('aria-hidden', 'true');
    req.hidden = true;
    // OpenRA ProductionIconOverlayManager (player.yaml Type Veterancy, iconchevrons
    // veteran): a chevron at the cameo's top left while the unit comes out with a level.
    const veteran = el('span', 'sb-veteran');
    veteran.setAttribute('aria-hidden', 'true');
    veteran.hidden = true;
    btn.append(canvas, veteran, clock, eta, count, ready, hold, slot, req, name);
    this.paintIcon(canvas, actor, btn);

    // shiftLatched: the touch action bar's Add toggle stands in for Shift.
    btn.addEventListener('click', (e) => this.onCardClick(id, e.shiftKey || !!this.callbacks.shiftLatched?.()));
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.onCardCancel(id);
    });
    // OpenRA HandleMiddleClick: cancel at once, skipping "on hold".
    btn.addEventListener('auxclick', (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      this.onCardCancel(id, { direct: true });
    });
    btn.addEventListener('keydown', (e) => {
      // Keyboard equivalent of right click.
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        this.onCardCancel(id);
      }
    });
    // OpenRA's production tooltip; a long press on touch screens also cancels one (js/touch.js).
    this.tip(btn, () => this.cardTip(id));

    c = {
      id,
      actor,
      btn,
      canvas,
      clock,
      eta,
      etaText: '',
      timer: new BuildEta(),
      count,
      slot,
      req,
      veteran,
      overlays: '',
      reqText: '',
      slotText: '',
      label: '',
      // Last applied state, to skip redundant DOM writes.
      enabled: null,
      building: null,
      ready: null,
      paused: null,
      head: undefined,
      queued: -1,
      progress: -1,
    };
    this.cards.set(id, c);
    this.updateLabel(c);
    return c;
  }

  /** Paint every card's picture again (installed content or the graphics choice changed). */
  repaintIcons() {
    for (const c of this.cards.values()) this.paintIcon(c.canvas, c.actor, c.btn);
  }

  /**
   * Draw the cameos at the size the cards have on the screen: the grid's
   * width follows the UI scale and the layout, the backing store the pixel
   * ratio. Called when the grid is resized or the pixel ratio changes.
   */
  fitCameos() {
    const shown = [...this.cards.values()].find((c) => c.canvas.isConnected && c.canvas.clientWidth > 0);
    if (!shown) return;
    const px = cameoBacking(shown.canvas.clientWidth, shown.canvas.clientHeight, globalThis.devicePixelRatio);
    if (px.width === this.cameoPx.width && px.height === this.cameoPx.height) return;
    this.cameoPx = px;
    for (const c of this.cards.values()) {
      c.canvas.width = px.width;
      c.canvas.height = px.height;
      this.paintIcon(c.canvas, c.actor, c.btn);
    }
  }

  /** Refit the cameos while this sidebar's grid is on the page. */
  watchCameoSize() {
    const fit = () => {
      if (!this.gridEl.isConnected) {
        stop();
        return;
      }
      this.fitCameos();
    };
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null;
    observer?.observe(this.gridEl);
    const unwatch = watchPixelRatio(globalThis.window, fit);
    const stop = () => {
      observer?.disconnect();
      unwatch();
    };
  }

  paintIcon(canvas, actor, btn) {
    try {
      // Red Alert's own cameos have the name in the picture: no second label over it.
      btn.classList.toggle('labelled', cameoPainter.paint(canvas, actor, this.teamRgb) === 'labelled');
    } catch (err) {
      // An icon without a draw routine must not break the whole sidebar;
      // report once per type so the missing art is visible in the console.
      if (!this.iconFailures.has(actor.id)) {
        this.iconFailures.add(actor.id);
        console.warn(`sidebar: no icon for ${actor.id}`, err);
      }
    }
  }

  // ---- Input -----------------------------------------------------------

  /**
   * Left click on a card (OpenRA ProductionPaletteWidget HandleLeftClick):
   * resume an item on hold, pick up a finished structure, or queue more,
   * saying Building or Training when the queue was empty (or why it cannot
   * queue: Unable to build more, Building in progress).
   */
  onCardClick(id, shift) {
    const c = this.cards.get(id);
    if (!c) return;
    if (c.head?.paused) {
      this.game.pause_production(this.playerId, id, false);
      this.callbacks.onProductionClick?.(id, 'resumed');
      return;
    }
    const action = clickAction({ queue: c.actor.queue, enabled: c.enabled, ready: c.ready }, shift);
    if (!action) return;
    if (action.place) {
      this.callbacks.onPlace?.(id);
      this.callbacks.onProductionClick?.(id, null);
      return;
    }
    const queue = this.state?.queues?.[c.actor.queue] ?? [];
    const outcome = queueOutcome({ queueLength: queue.length, limitLeft: this.buildable?.get(id)?.limitLeft ?? null });
    this.callbacks.onProductionClick?.(id, queue.length ? null : outcome);
    if (outcome === 'queued') this.game.start_production(this.playerId, id, action.count);
  }

  /**
   * Right click (or Delete) on a card (OpenRA HandleRightClick): put the item
   * being built on hold, or cancel one (on hold, finished, not started yet).
   * `direct` (middle click) always cancels.
   */
  onCardCancel(id, { direct = false } = {}) {
    const c = this.cards.get(id);
    if (!c) return;
    // Disabled cards can be cancelled too, so nothing ever stays stuck.
    const what = direct && c.head?.count ? 'cancel' : rightClickAction(c.head);
    if (!what) return;
    if (what === 'pause') {
      this.game.pause_production(this.playerId, id, true);
      this.callbacks.onProductionClick?.(id, 'onHold');
      return;
    }
    const endsPlacement = cancelEndsPlacement({ queue: c.actor.queue, ready: c.ready, queued: c.queued });
    this.game.cancel_production(this.playerId, id);
    this.callbacks.onProductionClick?.(id, 'cancelled');
    if (endsPlacement) this.callbacks.onCancelPlace?.();
  }

  /**
   * A production tab picked by the player (click or hotkey, OpenRA
   * ProductionTypeButton): show it, and pick up a structure of it that is
   * ready to place.
   */
  openTab(q) {
    this.selectTab(q);
    const ready = this.state?.queues?.[q]?.find((it) => it.done);
    if (ready && isStructureQueue(q) && this.placingId !== ready.id) this.callbacks.onPlace?.(ready.id);
  }

  selectTab(q) {
    this.activeTab = q;
    this.tabs.forEach((t, i) => {
      const on = i === q;
      t.btn.classList.toggle('active', on);
      t.btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    this.gridEl.setAttribute('aria-labelledby', this.tabs[q].btn.id);
    this.gridKey = '';
    if (this.state) this.update(this.state);
  }

  // ---- Tooltips --------------------------------------------------------

  /** The production tooltip of the cameo of `id` (production.js `productionTip`). */
  cardTip(id) {
    const actor = this.actors.get(id);
    if (!actor) return null;
    const slot = this.visibleIds?.indexOf(id) ?? -1;
    const hotkey = slot >= 0 ? this.keyOf(`production${String(slot + 1).padStart(2, '0')}`) : null;
    return productionTip(actor, this.buildable.get(id), this.state, { hotkey, ticksPerSecond: this.ticksPerSecond, lowPowerModifier: this.lowPowerModifier });
  }

  /** Credits and the ore in the silos. */
  creditsTip() {
    const s = this.state;
    const ore = Math.round(s?.resources ?? 0);
    const storage = Math.round(s?.storage ?? 0);
    const funds = Math.max(0, Math.round(s?.funds ?? (s?.cash ?? 0) + (s?.resources ?? 0)));
    return { title: `Credits: $${funds}`, desc: `Ore in silos: ${ore} / ${storage}.${storage > 0 && ore >= storage ? ' The silos are full: build more to store more ore.' : ''}` };
  }

  /** Power produced and used (OpenRA's power bar tooltip). */
  powerTip() {
    const s = this.state;
    const gen = Math.max(0, s?.powerGenerated ?? 0);
    const used = Math.max(0, s?.powerUsed ?? 0);
    const notes = s?.lowPower ? [{ text: 'Low power: production is slower and defences need power.', tone: 'warn' }] : [];
    return { title: `Power: ${used} / ${gen}`, desc: `${used} used of ${gen} produced.`, notes };
  }

  // ---- Per-tick update ---------------------------------------------------

  /** The game is paused (the menu, the Pause key, the debug menu): the clock blinks "Paused". */
  setPaused(paused) {
    this.paused = !!paused;
    this.updateClock();
  }

  updateClock() {
    const time = formatClock((this.state?.tick ?? 0) / this.ticksPerSecond);
    setText(this.clockEl, clockText(time, this.paused, blinkOn(this.now(), this.clockStart)));
  }

  /** @param {object} state parsed player_json() */
  update(state) {
    this.state = state;
    this.updateCredits(state);
    this.updatePower(state);
    this.updateClock();

    // Summarise queues: per id, the number queued and the head item.
    const { perId, activity: tabActivity, ready: tabReady } = summarizeQueues(state.queues);
    // The structure being placed was cancelled (lost its Construction Yard or
    // prerequisites): leave placement mode instead of placing nothing.
    if (placementLost(perId, this.placingId)) this.callbacks.onCancelPlace?.();

    // Tabs: activity badge, and whether anything of the tab can be built
    // ("available"), only seen ("locked") or nothing produces it ("no-producer").
    const buildableTabs = new Set();
    for (const b of state.buildable) if (b.enabled) buildableTabs.add(b.queue);
    this.tabs.forEach((t, q) => {
      const has = !!(state.hasProducer && state.hasProducer[q]);
      const look = !has ? 'no-producer' : buildableTabs.has(q) ? 'available' : 'locked';
      if (t.state !== look) {
        t.state = look;
        t.btn.classList.toggle('no-producer', look === 'no-producer');
        t.btn.classList.toggle('available', look === 'available');
        t.btn.classList.toggle('locked', look === 'locked');
      }
      const n = tabActivity[q] ?? 0;
      const ready = !!tabReady[q];
      t.badge.hidden = n === 0;
      if (n) setText(t.badge, ready ? '!' : String(n));
      t.badge.classList.toggle('ready', ready);
      t.activity = n;
      t.ready = ready;
      let label = t.name;
      if (look === 'no-producer') label += ', no production building';
      if (ready) label += ', ready';
      else if (n) label += `, ${n} in production`;
      if (t.btn.getAttribute('aria-label') !== label) t.btn.setAttribute('aria-label', label);
    });

    // Every item of the active tab: what this faction can get first (palette
    // order), then the other side's items, each with what is still missing.
    const enabled = new Map();
    const info = new Map();
    this.buildable = new Map(state.buildable.map((b) => [b.id, b]));
    for (const b of state.buildable) {
      if (b.queue !== this.activeTab) continue;
      enabled.set(b.id, b.enabled);
      info.set(b.id, b);
    }
    const rank = (id) => (info.get(id).exclusive ? 1 : 0);
    const ids = [...enabled.keys()]
      .filter((id) => this.actors.has(id))
      .sort((x, y) => rank(x) - rank(y) || this.actors.get(x).order - this.actors.get(y).order);
    this.visibleIds = ids;
    const key = ids.join('|');
    if (key !== this.gridKey) {
      this.gridKey = key;
      const nodes = ids.map((id) => this.card(id).btn);
      if (nodes.length === 0) nodes.push(this.emptyEl);
      this.gridEl.replaceChildren(...nodes);
      // New cards start at the last fitted size; the first ones learn it here.
      this.fitCameos();
    }

    ids.forEach((id, i) => {
      const c = this.cards.get(id);
      const on = enabled.get(id);
      const s = perId.get(id);
      this.updateCard(c, on, s, state.tick ?? 0);
      this.updateRequirements(c, info.get(id), i);
      this.updateLabel(c);
    });
    // An open tooltip follows availability, cash and power.
    this.refreshTips();
  }

  updateCard(c, enabled, s, tick = 0) {
    if (c.enabled !== enabled) {
      c.enabled = enabled;
      c.btn.classList.toggle('disabled', !enabled);
      c.btn.setAttribute('aria-disabled', enabled ? 'false' : 'true');
    }
    c.head = s;
    const count = s ? s.count : 0;
    const ready = !!(s && s.done);
    const building = !!s && !ready;
    const paused = !!(s && s.paused && !ready);
    if (c.paused !== paused) {
      c.paused = paused;
      c.btn.classList.toggle('paused', paused);
    }
    const progress = building ? Math.max(0, Math.min(1, s.progress)) : 0;

    if (c.building !== building) {
      c.building = building;
      c.btn.classList.toggle('building', building);
    }
    if (c.ready !== ready) {
      c.ready = ready;
      c.btn.classList.toggle('ready', ready);
    }
    if (!building) {
      c.progress = -1;
      c.timer.reset();
    } else if (Math.abs(c.progress - progress) > 0.001) {
      c.progress = progress;
      setVar(c.clock, '--p', progress.toFixed(4));
    }
    // Time left, estimated from the progress rate (production.js BuildEta).
    const left = building ? c.timer.observe(progress, tick) : null;
    const eta = left === null ? '' : formatClock(left / this.ticksPerSecond);
    if (c.etaText !== eta) {
      c.etaText = eta;
      setText(c.eta, eta);
      c.eta.hidden = !eta;
    }
    if (c.queued !== count) {
      c.queued = count;
      c.count.hidden = count <= 1;
      if (count > 1) setText(c.count, count);
    }
  }

  /** Accessible name of a card: name, cost, and its production state. */
  updateLabel(c) {
    let label = `${c.actor.name}, ${c.actor.cost} credits`;
    if (c.enabled === false) label += c.reqText ? `, unavailable: ${c.reqText}` : ', unavailable';
    if (c.ready) label += isStructureQueue(c.actor.queue) ? ', ready to place' : ', ready';
    else if (c.paused) label += ', on hold';
    else if (c.building) label += c.etaText ? `, building, ${c.etaText} left` : ', building';
    if (c.queued > 1) label += `, ${c.queued} queued`;
    if (c.overlays.split(' ').includes('Veterancy')) label += ', produced as a veteran';
    if (c.label !== label) {
      c.label = label;
      c.btn.setAttribute('aria-label', label);
    }
  }

  /** What is still missing ("Needs Service Depot" / "Soviet only"), and the numpad slot. */
  updateRequirements(c, b, index) {
    // The cameo overlays (engine World::production_overlays).
    const overlays = (b.overlays ?? []).join(' ');
    if (c.overlays !== overlays) {
      c.overlays = overlays;
      const veteran = (b.overlays ?? []).includes('Veterancy');
      c.veteran.hidden = !veteran;
      c.btn.classList.toggle('veteran', veteran);
    }
    c.requires = b.requires || [];
    c.exclusive = b.exclusive || null;
    // The label names the first way to unlock each requirement; the tooltip lists all.
    const short = c.requires.map((r) => r.split(' or ')[0]);
    const reqText = b.enabled ? '' : c.exclusive || (short.length ? `Needs ${short.join(', ')}` : '');
    if (c.reqText !== reqText) {
      c.reqText = reqText;
      setText(c.req, reqText);
      c.req.hidden = !reqText;
    }
    const locked = !!c.exclusive;
    c.btn.classList.toggle('exclusive', locked);
    const slot = this.slotKey(index);
    if (c.slotText !== slot) {
      c.slotText = slot;
      setText(c.slot, slot);
      c.slot.hidden = !slot;
    }
  }

  /**
   * The short key shown on the n-th card (0-based): its production slot
   * hotkey (OpenRA Production01..: F1..F12) when that is one plain key.
   */
  slotKey(index) {
    if (!this.slotKeys) {
      this.slotKeys = [];
      for (let i = 0; i < 24; i++) {
        const combo = this.hotkeys?.bindingsFor(`production${String(i + 1).padStart(2, '0')}`)[0] ?? '';
        this.slotKeys.push(combo && !combo.includes('+') ? formatCombo(combo) : '');
      }
    }
    return this.slotKeys[index] ?? '';
  }

  /**
   * Production slot and numpad hotkeys: act on the n-th card (1-based) of the
   * active tab, like a left click (or shift click), or cancel like a right click.
   */
  activateSlot(n, { shift = false, cancel = false } = {}) {
    const id = this.visibleIds?.[n - 1];
    if (!id) return;
    if (cancel) this.onCardCancel(id);
    else this.onCardClick(id, shift);
  }

  /** Highlight the button of the active top row mode (js/input.js `mode`), or none. */
  setMode(mode) {
    for (const [m, btn] of this.modeButtons) {
      btn.classList.toggle('active', m === mode);
      btn.setAttribute('aria-pressed', m === mode ? 'true' : 'false');
    }
  }

  /** Enable the Deploy button when the selection can deploy (0 no, 1 yes, 2 blocked). */
  setDeployState(state) {
    this.deployBtn.disabled = state === 0;
    this.deployBtn.classList.toggle('blocked', state === 2);
  }

  /** Switch to the next (+1) or previous (-1) production tab. */
  cycleTab(dir) {
    this.selectTab((this.activeTab + dir + QUEUE_NAMES.length) % QUEUE_NAMES.length);
  }

  updateCredits(state) {
    const target = Math.max(0, Math.round(state.funds ?? state.cash + state.resources));
    const ore = Math.round(state.resources);
    const storage = Math.round(state.storage);
    setText(this.oreEl, `Ore ${ore} / ${storage}`);
    setVar(this.siloFill, '--silo', (storage > 0 ? Math.min(1, ore / storage) : 0).toFixed(4));
    this.siloEl.classList.toggle('full', storage > 0 && ore >= storage);
    // The credits and silo tooltip (`creditsTip`) reads the state when it opens or refreshes.
    if (!this.credits) {
      // First update: show the real value immediately.
      this.credits = new CashCounter(target);
      setText(this.creditsEl, target);
      return;
    }
    this.credits.target = target;
    if (!this.creditsFrame && !this.credits.settled) {
      // The counter rested for at least a poll (several UI ticks): a "down" sound may play at once.
      this.credits.downQuiet = 0;
      this.creditsLast = this.now();
      this.creditsRest = 0;
      this.creditsFrame = requestAnimationFrame((t) => this.tickCredits(t));
    }
  }

  /** Animation frame of the credits counter: run the UI ticks due since the last frame. */
  tickCredits(now) {
    const elapsed = this.creditsRest + Math.max(0, now - this.creditsLast);
    this.creditsLast = now;
    const c = this.credits;
    const target = c.target;
    const { up, down, rest } = c.advance(elapsed);
    this.creditsRest = rest;
    // OpenRA plays one notification per tick; ticks that fell into one frame play once.
    if (up) this.callbacks.onCashTick?.('up');
    if (down) this.callbacks.onCashTick?.('down');
    setText(this.creditsEl, c.shown);
    this.creditsEl.classList.toggle('up', c.shown < target);
    this.creditsEl.classList.toggle('down', c.shown > target);
    if (c.settled) {
      this.creditsFrame = 0;
    } else {
      this.creditsFrame = requestAnimationFrame((t) => this.tickCredits(t));
    }
  }

  updatePower(state) {
    const gen = Math.max(0, state.powerGenerated);
    const used = Math.max(0, state.powerUsed);
    const scale = Math.max(gen, used, 1);
    setVar(this.powerFillEl, '--fill', (used / scale).toFixed(4));
    setVar(this.powerCapEl, '--cap', (gen / scale).toFixed(4));
    const low = !!state.lowPower;
    const tight = !low && gen > 0 && used > gen * POWER_TIGHT;
    this.powerRootEl.classList.toggle('low', low);
    this.powerRootEl.classList.toggle('tight', tight);
    const text = `Power: ${used} used of ${gen} produced${low ? ' (low power)' : ''}`;
    if (this.powerMeterEl.getAttribute('aria-valuetext') !== text) this.powerMeterEl.setAttribute('aria-valuetext', text);
    this.powerMeterEl.setAttribute('aria-valuenow', String(used));
    this.powerMeterEl.setAttribute('aria-valuemax', String(Math.max(gen, used)));
  }

  // ---- Selection and placement -------------------------------------------

  /**
   * @param {object|null} info actor_json() of one actor, a {count, name}
   *   summary for a multi-selection, or null.
   */
  setSelection(info) {
    if (!info) {
      this.selEl.classList.add('empty');
      setText(this.selNameEl, 'No selection');
      setText(this.selDetailEl, '');
      this.selHpBar.hidden = true;
      return;
    }
    this.selEl.classList.remove('empty');
    if (info.count !== undefined && info.hp === undefined) {
      const n = info.count;
      setText(this.selNameEl, n === 1 && info.name ? info.name : `${n} units selected`);
      setText(this.selDetailEl, n > 1 && info.name ? info.name : '');
      this.selHpBar.hidden = true;
      return;
    }
    // A spy's disguise (engine actor_json().disguise, infantry.rs): to others it
    // is the soldier it pretends to be (OpenRA DisguiseTooltip).
    const disguise = info.disguise && info.owner !== this.playerId ? info.disguise : null;
    const shownOwner = disguise ? disguise.owner : info.owner;
    setText(this.selNameEl, (disguise ? this.actors.get(disguise.type)?.name : null) ?? info.name ?? 'Unknown');
    const max = Math.max(1, info.maxHp || 1);
    const hp = Math.max(0, Math.min(max, info.hp ?? max));
    const frac = hp / max;
    this.selHpBar.hidden = false;
    setVar(this.selHpFill, '--hp', frac.toFixed(4));
    this.selHpFill.classList.toggle('mid', frac <= 0.5 && frac > 0.25);
    this.selHpFill.classList.toggle('low', frac <= 0.25);
    let detail = `${Math.ceil(hp)} / ${max}`;
    if (shownOwner !== undefined && shownOwner !== this.playerId) detail += info.neutral ? '  (neutral)' : '  (enemy)';
    // Veterancy (engine actor_json().rank / xp): rank for everyone, experience for own units.
    const vet = veterancyText(info, info.owner === this.playerId);
    if (vet) detail += `   ${vet}`;
    // Desert heat (engine actor_json().heat / overheated, engine/src/weather.rs).
    const heat = heatText(info);
    if (heat && info.owner === this.playerId) detail += `   ${heat}`;
    // Ability state (engine actor_json().ability).
    const ab = info.ability;
    if (ab && info.owner === this.playerId) {
      if (ab.maxAmmo !== undefined) detail += `   Mines ${ab.ammo}/${ab.maxAmmo}`;
      if (ab.chargeMax !== undefined) detail += ab.charge >= ab.chargeMax ? '   Chrono ready' : `   Chrono ${Math.floor((100 * ab.charge) / ab.chargeMax)}%`;
      if (ab.cloaked) detail += '   Cloaked';
      if (ab.deployed) detail += `   Detonates in ${Math.ceil(ab.detonatesIn / 25)} s`;
    }
    // Infantry (engine/src/infantry.rs): disguise, captures, C4, power outages.
    if (info.disguise && info.owner === this.playerId) detail += `   Disguised as ${this.actors.get(info.disguise.type)?.name ?? info.disguise.type}`;
    if (info.beingCaptured) detail += '   Being captured';
    if (info.demolished) detail += '   C4 planted';
    if (info.powerOutage > 0) detail += `   Power outage ${Math.ceil(info.powerOutage / 25)} s`;
    // Tech buildings: what capturing gives (OpenRA TooltipDescription, picked by main.js selectionInfo).
    if (info.description) detail += `   ${info.description}`;
    setText(this.selDetailEl, detail);
  }

  /** Highlight the building currently being placed (or clear with null). */
  setPlacing(id) {
    if (this.placingId === id) return;
    if (this.placingId) this.cards.get(this.placingId)?.btn.classList.remove('placing');
    this.placingId = id;
    if (id && this.actors.has(id)) this.card(id).btn.classList.add('placing');
  }
}

const RANK_NAMES = ['Rookie', 'Veteran', 'Veteran II', 'Veteran III'];

/**
 * Selection panel text for veterancy (engine actor_json(): rank, maxRank, xp,
 * nextXp, prone): "Elite", "Veteran II  XP 450/800", "Rookie  XP 0/200", plus
 * "Prone". Experience is in value points (an enemy worth $100 gives 100) and
 * only shown for `own` units. Empty for actors that gain no experience.
 */
export function veterancyText(info, own) {
  const parts = [];
  if (info?.maxRank > 0) {
    const elite = info.rank >= info.maxRank;
    parts.push(elite ? 'Elite' : (RANK_NAMES[info.rank] ?? `Veteran ${info.rank}`));
    if (own && !elite) parts.push(`XP ${info.xp}/${info.nextXp}`);
  }
  if (info?.prone) parts.push('Prone');
  return parts.join('  ');
}

/**
 * Tooltip of a production tab (OpenRA ProductionTypeButton): its name and
 * key, and what is going on in it.
 * @param {{ name: string, state: string, activity: number, ready: boolean }} tab
 * @param {string | null} hotkey
 */
export function tabTip(tab, hotkey) {
  let desc;
  if (tab.state === 'no-producer') desc = 'No production building for this tab yet.';
  else if (tab.ready) desc = 'Something is ready.';
  else if (tab.activity) desc = `${tab.activity} in production.`;
  else desc = tab.state === 'locked' ? 'Nothing can be built here yet.' : 'Open this production tab.';
  return { title: tab.name, hotkey, desc };
}

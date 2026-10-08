// In-game sidebar: credits, power meter, production tabs, build palette and
// the selection panel. The DOM is built once; update() only patches text,
// classes and CSS variables so it is cheap to call ~10x per second.

import { drawIcon } from './sprites.js';
import { TEAM_COLORS } from './renderer.js';
import { cancelEndsPlacement, clickAction, isStructureQueue, placementLost, SHIFT_COUNT, summarizeQueues } from './production.js';

// Must match QueueType in engine/src/rules.rs.
const QUEUE_NAMES = ['Buildings', 'Defense', 'Infantry', 'Vehicles', 'Aircraft', 'Naval'];
const QUEUE_BUILDINGS = 0;

// Icon canvas size in CSS pixels; the backing store is scaled by devicePixelRatio.
const ICON_W = 96;
const ICON_H = 64;

// Credits counter: like the 1996 sidebar the display ticks toward the real
// value instead of jumping. Speed grows with the gap so big swings stay short.
const CREDIT_MIN_RATE = 40; // credits per second
const CREDIT_CATCHUP = 4; // fraction of the remaining gap closed per second

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

function formatPower(power) {
  if (power > 0) return `+${power}`;
  return String(power);
}

export class Sidebar {
  /**
   * @param {HTMLElement} root the <aside id="sidebar"> element
   * @param {object} game wasm Game instance
   * @param {object} rules parsed rules_json()
   * @param {number} playerId local player id
   * @param {{onPlace?: (id: string) => void, onCancelPlace?: () => void}} callbacks
   */
  constructor(root, game, rules, playerId, callbacks = {}) {
    this.root = root;
    this.game = game;
    this.playerId = playerId;
    this.callbacks = callbacks;
    this.teamRgb = TEAM_COLORS[playerId % TEAM_COLORS.length];

    this.actors = new Map();
    for (const a of rules.actors) this.actors.set(a.id, a);

    this.activeTab = QUEUE_BUILDINGS;
    this.cards = new Map(); // actor id -> card record
    this.gridKey = ''; // ids currently shown in the grid, in order
    this.placingId = null;
    this.state = null;
    this.iconFailures = new Set();

    // Credits animation state.
    this.creditsShown = 0;
    this.creditsTarget = 0;
    this.creditsFrame = 0;
    this.creditsLast = 0;
    this.creditsInitialised = false;

    this.build();
  }

  // ---- DOM construction (once) -----------------------------------------

  build() {
    const root = this.root;
    root.textContent = '';
    root.classList.add('sb');
    root.addEventListener('contextmenu', (e) => e.preventDefault());

    // Credits and ore storage.
    const top = el('div', 'sb-top');
    const creditsLabel = el('div', 'sb-credits-label', 'Credits');
    this.creditsEl = el('div', 'sb-credits', '0');
    this.creditsEl.setAttribute('aria-live', 'off');
    this.oreEl = el('div', 'sb-ore', 'Ore 0 / 0');
    top.append(creditsLabel, this.creditsEl, this.oreEl);

    // Power meter.
    const power = el('div', 'sb-power');
    const powerHead = el('div', 'sb-power-head');
    this.powerLabelEl = el('span', 'sb-power-label', 'Power');
    this.powerTextEl = el('span', 'sb-power-text', '0 / 0');
    powerHead.append(this.powerLabelEl, this.powerTextEl);
    const meter = el('div', 'sb-power-meter');
    meter.setAttribute('role', 'meter');
    meter.setAttribute('aria-label', 'Power usage');
    this.powerFillEl = el('div', 'sb-power-fill');
    this.powerCapEl = el('div', 'sb-power-cap');
    meter.append(this.powerFillEl, this.powerCapEl);
    this.powerMeterEl = meter;
    this.powerRootEl = power;
    power.append(powerHead, meter);

    // Tabs.
    const tabs = el('div', 'sb-tabs');
    tabs.setAttribute('role', 'tablist');
    this.tabs = QUEUE_NAMES.map((name, q) => {
      const btn = el('button', 'sb-tab');
      btn.type = 'button';
      btn.setAttribute('role', 'tab');
      const label = el('span', 'sb-tab-label', name);
      const badge = el('span', 'sb-tab-badge');
      badge.hidden = true;
      btn.append(label, badge);
      btn.addEventListener('click', () => {
        this.selectTab(q);
      });
      tabs.append(btn);
      return { btn, badge };
    });

    // Card grid.
    this.gridEl = el('div', 'sb-grid');
    this.gridEl.setAttribute('role', 'tabpanel');
    this.emptyEl = el('div', 'sb-empty', 'Nothing available');

    // Hover tooltip (fixed positioned next to the hovered card).
    this.tipEl = el('div', 'sb-tip');
    this.tipEl.setAttribute('role', 'tooltip');
    this.tipEl.id = 'sb-tip';
    this.tipEl.hidden = true;
    this.tipName = el('div', 'sb-tip-name');
    this.tipStats = el('div', 'sb-tip-stats');
    this.tipDesc = el('div', 'sb-tip-desc');
    this.tipWarn = el('div', 'sb-tip-warn', 'Unavailable: requirements not met');
    this.tipHint = el('div', 'sb-tip-hint');
    this.tipEl.append(this.tipName, this.tipStats, this.tipDesc, this.tipWarn, this.tipHint);
    this.tipCard = null;

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

    // Command buttons: sell mode and deploy (MCV / pack up the Construction Yard).
    const tools = el('div', 'sb-tools');
    this.sellBtn = el('button', 'sb-tool', 'Sell');
    this.sellBtn.type = 'button';
    this.sellBtn.title = 'Sell a structure for 50% of its value (scaled by health). Hotkey: Z';
    this.sellBtn.addEventListener('click', () => this.callbacks.onSell?.());
    this.deployBtn = el('button', 'sb-tool', 'Deploy');
    this.deployBtn.type = 'button';
    this.deployBtn.title = 'Deploy the selected MCV, pack up the selected Construction Yard, or unload the selected transport. Hotkey: D';
    this.deployBtn.addEventListener('click', () => this.callbacks.onDeploy?.());
    tools.append(this.sellBtn, this.deployBtn);

    root.append(top, power, tools, tabs, this.gridEl, sel, this.tipEl);
    this.selectTab(this.activeTab);
  }

  /** Card for one actor type, created lazily the first time it becomes visible. */
  card(id) {
    let c = this.cards.get(id);
    if (c) return c;
    const actor = this.actors.get(id);
    const btn = el('button', 'sb-card');
    btn.type = 'button';
    btn.dataset.id = id;
    btn.setAttribute('aria-describedby', 'sb-tip');

    const canvas = el('canvas', 'sb-icon');
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    canvas.width = Math.round(ICON_W * dpr);
    canvas.height = Math.round(ICON_H * dpr);
    this.paintIcon(canvas, actor);

    const clock = el('div', 'sb-clock');
    const count = el('span', 'sb-count');
    count.hidden = true;
    const ready = el('span', 'sb-ready', 'READY');
    const name = el('span', 'sb-name', actor.name);
    const cost = el('span', 'sb-cost', `$${actor.cost}`);
    const slot = el('span', 'sb-slot');
    slot.hidden = true;
    const req = el('span', 'sb-req');
    req.hidden = true;
    btn.append(canvas, clock, count, ready, slot, req, name, cost);
    btn.setAttribute('aria-label', `${actor.name}, ${actor.cost} credits`);

    btn.addEventListener('click', (e) => this.onCardClick(id, e.shiftKey));
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.onCardCancel(id);
    });
    btn.addEventListener('keydown', (e) => {
      // Keyboard equivalent of right click.
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        this.onCardCancel(id);
      }
    });
    btn.addEventListener('mouseenter', () => this.showTip(id));
    btn.addEventListener('mouseleave', () => this.hideTip(id));
    btn.addEventListener('focus', () => this.showTip(id));
    btn.addEventListener('blur', () => this.hideTip(id));

    c = {
      id,
      actor,
      btn,
      clock,
      count,
      slot,
      req,
      reqText: '',
      slotText: '',
      // Last applied state, to skip redundant DOM writes.
      enabled: null,
      building: null,
      ready: null,
      queued: -1,
      progress: -1,
    };
    this.cards.set(id, c);
    return c;
  }

  paintIcon(canvas, actor) {
    try {
      drawIcon(canvas, actor, this.teamRgb);
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

  onCardClick(id, shift) {
    const c = this.cards.get(id);
    if (!c) return;
    const action = clickAction({ queue: c.actor.queue, enabled: c.enabled, ready: c.ready }, shift);
    if (!action) return;
    if (action.place) this.callbacks.onPlace?.(id);
    else this.game.start_production(this.playerId, id, action.count);
  }

  onCardCancel(id) {
    const c = this.cards.get(id);
    if (!c) return;
    // Disabled cards can be cancelled too, so nothing ever stays stuck.
    const endsPlacement = cancelEndsPlacement({ queue: c.actor.queue, ready: c.ready, queued: c.queued });
    this.game.cancel_production(this.playerId, id);
    if (endsPlacement) this.callbacks.onCancelPlace?.();
  }

  selectTab(q) {
    this.activeTab = q;
    this.tabs.forEach((t, i) => {
      const on = i === q;
      t.btn.classList.toggle('active', on);
      t.btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    this.gridKey = '';
    if (this.state) this.update(this.state);
  }

  // ---- Tooltip ---------------------------------------------------------

  showTip(id) {
    const c = this.cards.get(id);
    if (!c) return;
    const a = c.actor;
    this.tipCard = id;
    setText(this.tipName, a.name);
    let stats = `Cost $${a.cost}`;
    if (a.kind === 'building' && a.power) stats += `   Power ${formatPower(a.power)}`;
    setText(this.tipStats, stats);
    setText(this.tipDesc, a.description || '');
    this.tipDesc.hidden = !a.description;
    this.updateTipWarning(c);
    const hint = isStructureQueue(a.queue)
      ? `Left click: build / place. Shift: queue ${SHIFT_COUNT}. Right click: cancel one.`
      : `Left click: build. Shift: build ${SHIFT_COUNT}. Right click: cancel one.`;
    setText(this.tipHint, hint);
    this.tipEl.hidden = false;

    // Place the panel beside the card, on whichever side has room.
    const r = c.btn.getBoundingClientRect();
    const tw = this.tipEl.offsetWidth;
    const th = this.tipEl.offsetHeight;
    let x = r.left - tw - 8;
    if (x < 4) x = r.right + 8;
    let y = r.top;
    y = Math.max(4, Math.min(y, window.innerHeight - th - 4));
    this.tipEl.style.left = `${Math.round(x)}px`;
    this.tipEl.style.top = `${Math.round(y)}px`;
  }

  hideTip(id) {
    if (this.tipCard !== id) return;
    this.tipCard = null;
    this.tipEl.hidden = true;
  }

  // ---- Per-tick update ---------------------------------------------------

  /** @param {object} state parsed player_json() */
  update(state) {
    this.state = state;
    this.updateCredits(state);
    this.updatePower(state);

    // Summarise queues: per id, the number queued and the head item.
    const { perId, activity: tabActivity, ready: tabReady } = summarizeQueues(state.queues);
    // The structure being placed was cancelled (lost its Construction Yard or
    // prerequisites): leave placement mode instead of placing nothing.
    if (placementLost(perId, this.placingId)) this.callbacks.onCancelPlace?.();

    // Tabs: activity badge and "no producer" look.
    this.tabs.forEach((t, q) => {
      const has = !!(state.hasProducer && state.hasProducer[q]);
      t.btn.classList.toggle('no-producer', !has);
      const n = tabActivity[q] ?? 0;
      const ready = !!tabReady[q];
      t.badge.hidden = n === 0;
      if (n) setText(t.badge, ready ? '!' : String(n));
      t.badge.classList.toggle('ready', ready);
    });

    // Every item of the active tab: what this faction can get first (palette
    // order), then the other side's items, each with what is still missing.
    const enabled = new Map();
    const info = new Map();
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
    }

    ids.forEach((id, i) => {
      const c = this.cards.get(id);
      const on = enabled.get(id);
      const s = perId.get(id);
      this.updateCard(c, on, s);
      this.updateRequirements(c, info.get(id), i);
    });
    // Refresh an open tooltip in case availability changed.
    if (this.tipCard) this.updateTipWarning(this.cards.get(this.tipCard));
  }

  updateCard(c, enabled, s) {
    if (c.enabled !== enabled) {
      c.enabled = enabled;
      c.btn.classList.toggle('disabled', !enabled);
      c.btn.setAttribute('aria-disabled', enabled ? 'false' : 'true');
    }
    const count = s ? s.count : 0;
    const ready = !!(s && s.done);
    const building = !!s && !ready;
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
    } else if (Math.abs(c.progress - progress) > 0.001) {
      c.progress = progress;
      setVar(c.clock, '--p', progress.toFixed(4));
    }
    if (c.queued !== count) {
      c.queued = count;
      c.count.hidden = count <= 1;
      if (count > 1) setText(c.count, count);
    }
  }

  /** Requirement line ("Needs Service Depot" / "Soviet only") and numpad slot. */
  updateRequirements(c, b, index) {
    c.requires = b.requires || [];
    c.exclusive = b.exclusive || null;
    // Cards show the first way to unlock each requirement; the tooltip lists all.
    const short = c.requires.map((r) => r.split(' or ')[0]);
    const text = b.enabled ? '' : c.exclusive || (short.length ? `Needs ${short.join(', ')}` : '');
    if (c.reqText !== text) {
      c.reqText = text;
      setText(c.req, text);
      c.req.hidden = !text;
    }
    const locked = !!c.exclusive;
    c.btn.classList.toggle('exclusive', locked);
    const slot = index < 9 ? String(index + 1) : '';
    if (c.slotText !== slot) {
      c.slotText = slot;
      setText(c.slot, slot);
      c.slot.hidden = !slot;
    }
  }

  updateTipWarning(c) {
    if (!c) return;
    if (c.enabled !== false) {
      this.tipWarn.hidden = true;
      return;
    }
    let text;
    if (c.exclusive) text = c.exclusive;
    else if (c.requires && c.requires.length) text = `Requires: ${c.requires.join(', ')}`;
    else text = 'Unavailable';
    setText(this.tipWarn, text);
    this.tipWarn.hidden = false;
  }

  /**
   * Numpad hotkeys: act on the n-th card (1-based) of the active tab, like a
   * left click (or shift click), or cancel like a right click.
   */
  activateSlot(n, { shift = false, cancel = false } = {}) {
    const id = this.visibleIds?.[n - 1];
    if (!id) return;
    if (cancel) this.onCardCancel(id);
    else this.onCardClick(id, shift);
  }

  /** Highlight the Sell button while sell mode is active. */
  setSellMode(on) {
    this.sellBtn.classList.toggle('active', !!on);
    this.sellBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
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
    setText(this.oreEl, `Ore ${Math.round(state.resources)} / ${Math.round(state.storage)}`);
    if (!this.creditsInitialised) {
      // First update: show the real value immediately.
      this.creditsInitialised = true;
      this.creditsShown = target;
      this.creditsTarget = target;
      setText(this.creditsEl, target);
      return;
    }
    this.creditsTarget = target;
    if (!this.creditsFrame && Math.round(this.creditsShown) !== target) {
      this.creditsLast = performance.now();
      this.creditsFrame = requestAnimationFrame((t) => this.tickCredits(t));
    }
  }

  tickCredits(now) {
    const dt = Math.min(0.1, Math.max(0, (now - this.creditsLast) / 1000));
    this.creditsLast = now;
    const gap = this.creditsTarget - this.creditsShown;
    const step = Math.max(CREDIT_MIN_RATE * dt, Math.abs(gap) * CREDIT_CATCHUP * dt);
    if (Math.abs(gap) <= step) {
      this.creditsShown = this.creditsTarget;
    } else {
      this.creditsShown += Math.sign(gap) * step;
    }
    const shown = Math.round(this.creditsShown);
    setText(this.creditsEl, shown);
    this.creditsEl.classList.toggle('up', gap > 0 && shown !== this.creditsTarget);
    this.creditsEl.classList.toggle('down', gap < 0 && shown !== this.creditsTarget);
    if (shown === this.creditsTarget) {
      this.creditsShown = this.creditsTarget;
      this.creditsFrame = 0;
      this.creditsEl.classList.remove('up', 'down');
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
    this.powerRootEl.classList.toggle('low', low);
    setText(this.powerLabelEl, low ? 'LOW POWER' : 'Power');
    setText(this.powerTextEl, `${used} / ${gen}`);
    this.powerMeterEl.setAttribute('aria-valuenow', String(used));
    this.powerMeterEl.setAttribute('aria-valuemax', String(gen));
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
    setText(this.selNameEl, info.name ?? 'Unknown');
    const max = Math.max(1, info.maxHp || 1);
    const hp = Math.max(0, Math.min(max, info.hp ?? max));
    const frac = hp / max;
    this.selHpBar.hidden = false;
    setVar(this.selHpFill, '--hp', frac.toFixed(4));
    this.selHpFill.classList.toggle('mid', frac <= 0.5 && frac > 0.25);
    this.selHpFill.classList.toggle('low', frac <= 0.25);
    let detail = `${Math.ceil(hp)} / ${max}`;
    if (info.owner !== undefined && info.owner !== this.playerId) detail += '  (enemy)';
    // Ability state (engine actor_json().ability).
    const ab = info.ability;
    if (ab && info.owner === this.playerId) {
      if (ab.maxAmmo !== undefined) detail += `   Mines ${ab.ammo}/${ab.maxAmmo}`;
      if (ab.chargeMax !== undefined) detail += ab.charge >= ab.chargeMax ? '   Chrono ready' : `   Chrono ${Math.floor((100 * ab.charge) / ab.chargeMax)}%`;
      if (ab.cloaked) detail += '   Cloaked';
      if (ab.deployed) detail += `   Detonates in ${Math.ceil(ab.detonatesIn / 25)} s`;
    }
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

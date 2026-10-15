// In-game menu (Esc), the design board GameMenu: the actions on the left
// (Resume, Guide, Statistics, the game's record actions, Settings, Network
// in online games, Sound, Music, Original content, Controls and hotkeys,
// Fullscreen, Release notes, Restart, and at the bottom Surrender, Leave and
// Exit) and the game info on the right (OpenRA's GAME_INFO_PANEL with its
// Objectives, Briefing and Options tabs; js/gameinfo.js), one under the
// other on phones. Surrender follows OpenRA IngameMenuLogic: games with more
// than one person, after a confirm step. Restart asks first (single player
// and replays); online it is the rematch. Statistics shows once the local
// player watches (spectators, replays, after a defeat or at the end). Phones
// get the same menu from the HUD's Menu button.
//
// Pages: Settings (board Options: tabs Game, Graphics with the texture pack
// cards, Controls, Hotkeys with search and groups, Sound with the music
// player beside it, Privacy, Advanced), Guide (js/guideview.js), Network in
// online games (js/netmenu.js; the HUD's signal bars open it with the
// OPEN_NETWORK_EVENT), Music (js/audio/musicplayer.js, like OpenRA's
// in-game Music button) and the confirm steps.
//
// Single player and skirmish pause while the menu is open. Online lockstep
// games cannot pause (docs/contracts.md: the server drops a player who holds
// the game up), so the menu opens without pausing and says so.
//
// Keys: while the menu is open it keeps every key from the game. A key on a
// control of the menu reaches that control and stops at the menu's card: an
// open select list and the hotkey search get every key, tabs, steppers and
// radio groups their arrows, Home, End and Page keys, buttons the rest (the
// menu's own hotkeys, fullscreen and mute, still run). Any other key is
// stopped in the capture phase. Esc goes back a page or closes the menu,
// from a tab or a stepper too, except while a select list is open: then it
// only closes the list.

import { boundKey, comboFromEvent, formatCombo, GROUP_ORDER, isMac, substituteFor } from './hotkeys.js';
import { OPENRA_HOTKEYS } from './openra-hotkeys.js';
import { SCHEMA } from './settings.js';
import { touchControls } from './touch.js';
import { led, segmented, slider as createSlider, switchInput, tabs as tabBar, toggle as createToggle } from './ui/controls.js';
import { GAME_SCALE_LIMITS, UI_SCALE_LIMITS, percent, resolveGameScale, screenOf, snapGameScale, crispGameScales, roundStep } from './scale.js';
import { mountAudioSettings } from './audio/panel.js';
import { mountMusicPlayer } from './audio/musicplayer.js';
import { DEFAULT_PREFS } from './audio/prefs.js';
import { closeOpenTip, infoTip, labelWithHelp, openTip } from './infotip.js';
import { helpText } from './help.js';
import { configured as reportsConfigured } from './telemetry/index.js';
import { renderGameInfo } from './gameinfo.js';
import { renderGuide } from './guideview.js';
import { NetHistory, OPEN_NETWORK_EVENT, netSwitches, renderNetworkData } from './netmenu.js';

/** How often the open game info shows the scores again (ms). */
export const GAME_INFO_REFRESH_MS = 1000;

/**
 * Settings of the Settings page with a "?" (tests check each one has help
 * in js/help.js as `settings.<key>`); the Sound tab's are AUDIO_HELP_KEYS
 * of js/audio/panel.js.
 */
export const MENU_HELP_KEYS = Object.freeze([
  'uiScale',
  'gameScale',
  'scaleAuto',
  'zoomFactor',
  'pixelRatioCap',
  'lowQuality',
  'reduceMotion',
  'fullscreen',
  'edgeScrollSpeed',
  'keyScrollSpeed',
  'showUnitPaths',
  'targetLines',
  'playerStanceColors',
  'hideReplayChat',
  'uiFeedbackNotifications',
  'gameEventNotifications',
  'mouseCapture',
  'mouseCaptureSpeed',
  'mouseCaptureRaw',
  'mouseCaptureEscMenu',
  'perfCaptureStart',
  'mouseCaptureNotice',
  'pauseWhenHidden',
  'errorReports',
  'cloudReplays',
]);

/** The "?" beside the titles of the game info and the Surrender page (js/help.js). */
export const MENU_PAGE_HELP_KEYS = Object.freeze(['menu.gameInfo', 'menu.surrender']);

/** The notes under the Hotkeys tab (js/help.js `controls.<key>`). */
export const CONTROLS_HELP_KEYS = Object.freeze(['keys', 'focus', 'selection', 'production']);

/** Settings on the Controls tab, each with a "?" (js/help.js `settings.<key>`); "Reset all hotkeys" leaves them. */
export const CONTROLS_SETTINGS = Object.freeze(['buildRightClick']);

/** The Settings tabs (board Options), in order. */
export const SETTINGS_TABS = Object.freeze([
  { id: 'game', label: 'Game' },
  { id: 'graphics', label: 'Graphics' },
  { id: 'controls', label: 'Controls' },
  { id: 'hotkeys', label: 'Hotkeys' },
  { id: 'sound', label: 'Sound' },
  { id: 'privacy', label: 'Privacy' },
  { id: 'advanced', label: 'Advanced' },
]);

/**
 * What "Reset this section" puts back per tab (settings names; the Game
 * tab's Online switches, the Hotkeys tab's keys and the Sound tab's audio
 * settings too). Privacy has no reset: switching reports back on is the
 * player's call. The graphics choice stays (it can need installed content).
 */
export const SECTION_SETTINGS = Object.freeze({
  game: Object.freeze(['edgeScrollSpeed', 'keyScrollSpeed', 'showUnitPaths', 'targetLines', 'healthBars', 'playerStanceColors', 'hideReplayChat', 'uiFeedbackNotifications', 'gameEventNotifications', 'pauseWhenHidden']),
  graphics: Object.freeze(['uiScale', 'gameScale', 'zoomFactor', 'pixelRatioCap', 'lowQuality', 'reduceMotion']),
  controls: Object.freeze(['buildRightClick', 'mouseCapture', 'mouseCaptureSpeed', 'mouseCaptureRaw', 'mouseCaptureEscMenu', 'mouseCaptureNotice']),
  hotkeys: Object.freeze([]),
  sound: Object.freeze([]),
  privacy: null,
  advanced: Object.freeze(['perfCaptureStart']),
});

/**
 * The texture pack cards of the Graphics tab (game.graphics; docs
 * redesign 0.3): 2D minimal (WebRA's flat art, stored as 'webra' before
 * the 3D pack), 3D minimal (the built-in pack) and Red Alert original (the
 * player's own files). A card shows when this build's setting has its value.
 */
export const PACK_CARDS = Object.freeze([
  { value: 'webra2d', legacy: 'webra', name: '2D minimal', note: 'Flat shapes, easiest to read' },
  { value: 'webra3d', name: '3D minimal', note: 'Blocky and bright' },
  { value: 'original', name: 'Red Alert original', note: 'From your own copy of Red Alert' },
]);

/**
 * The cards for the setting's `options` and value `current`, with their
 * install state: `{ value, name, note, status, checked, disabled }`.
 */
export function packCards(options, current, { originalInstalled = false, problem = null } = {}) {
  const out = [];
  for (const card of PACK_CARDS) {
    const value = options.includes(card.value) ? card.value : card.legacy && options.includes(card.legacy) ? card.legacy : null;
    if (value === null) continue;
    let status = 'Built in';
    let disabled = false;
    if (card.value === 'original') {
      status = originalInstalled ? 'Installed' : 'Not installed: add it from your own copy under Original content';
      disabled = !originalInstalled;
    } else if (card.value === 'webra3d' && problem) status = `Not drawn yet: ${problem}`;
    out.push({ value, name: card.name, note: card.note, status, checked: value === current, disabled, warn: disabled || (card.value === 'webra3d' && !!problem) });
  }
  return out;
}

/** The sync line of the Settings page (account/ui.js SYNC_TEXT while signed in). */
export function syncLine(state) {
  if (!state?.signedIn) return { text: 'Saved in this browser. Sign in to keep them in your account.', led: 'off' };
  switch (state.status) {
    case 'syncing':
      return { text: 'Syncing to your account...', led: 'warn' };
    case 'offline':
      return { text: 'Offline: settings will sync later', led: 'warn' };
    case 'error':
      return { text: 'Settings not synced', led: 'bad' };
    default:
      return { text: 'Synced to your account', led: 'ok' };
  }
}

/** The "?" of setting `key` beside the row's label, describing `control`. */
const withHelp = (row, key, control) => labelWithHelp(row, `settings.${key}`, control);

/** A row of segmented buttons for choice setting `key` of settings store `s`, with an optional hint under it. */
function choiceRow(s, key, text, labels, hint) {
  const id = `game-menu-${key}`;
  const group = segmented({
    name: id,
    label: text,
    value: s.get(key),
    describedBy: hint ? `${id}-hint` : undefined,
    options: SCHEMA[key].options.map((option) => ({ value: option, label: labels[option] ?? option })),
    onChange: (v) => group.set(s.set(key, v)),
  });
  const row = el('div', 'ui-row ui-row-choice game-menu-row');
  row.append(el('span', 'ui-label', text), group.root);
  if (hint) {
    const note = el('p', 'ui-hint', hint);
    note.id = `${id}-hint`;
    row.append(note);
  }
  return row;
}

/** Controls that are not in the hotkey registry (fixed keys and the mouse). */
export function fixedControls(mac = isMac()) {
  const ctrl = mac ? 'Cmd (or Ctrl)' : 'Ctrl';
  return [
    ['Esc', 'Cancel placement, targeting, a sidebar mode or attack move; otherwise open this menu. With the mouse captured, the first Esc releases it'],
    ['Left click', 'Select, or give the order shown by the cursor'],
    // OpenRA WorldInteractionControllerWidget: Shift + click toggles, Shift + drag adds; Ctrl or Alt raise the units that allow it.
    ['Left drag', 'Box select (combat units first)'],
    ['Shift + click', 'Add to or remove from the selection'],
    ['Shift + drag', 'Add to the selection'],
    ['Ctrl / Alt + drag', 'Box select with every unit / only support units and harvesters'],
    // OpenRA double click: the clicked actor's selection class on screen, added to the selection (Q and W are the hotkeys).
    ['Double click', 'Add all of that type on screen to the selection'],
    ['Right click', 'Cancel the current mode, or clear the selection'],
    ['Middle drag', 'Pan the map'],
    ['Radar: left click', 'With units selected: the order the cursor shows for that spot (Shift, Ctrl and Alt as on the map); otherwise move the camera'],
    // OpenRA RadarWidget: every button but the action button (left) moves the view.
    ['Radar: right or middle click', 'Move the camera there (never an order)'],
    ['Radar: drag', 'Move the camera (any button, unless the left press gave an order)'],
    ['Mouse wheel', 'Zoom'],
    ['Screen edges', 'Scroll the map'],
    [`${ctrl} + drag`, 'Lay a minefield (Minelayers selected)'],
    // WebRA bulk repair and sell (js/input.js): boxes in repair and sell mode, the Repair key with a selection.
    ['Drag in repair mode', 'Repair what is damaged in the box: choose structures, combat units, ore trucks, other units or all (structures that all repair already stop)'],
    ['Shift + drag in repair mode', 'The same with your last choice, without asking'],
    ['Repair key, own actors selected', 'Repair the selected damaged structures and send the selected damaged units to repair'],
    ['Drag in sell mode', 'Sell your structures in the box, never a Construction Yard (more than one: click Sell or press S or Y; Enter or Esc cancels)'],
    ['Shift + production key', 'Build 5 (production slots, numpad)'],
    ['Build menu: left / Shift + left click', 'Queue 1 / 5, with or without the credits'],
    ['Build menu: right / Shift + right click', 'Hold or cancel 1 / 5 (Right click in the build menu above)'],
    ['Build menu: middle click', 'Cancel at once (Shift: 5)'],
  ];
}

/**
 * The hotkeys of the Hotkeys tab that match `query` (any case: one
 * character is a key, longer text a part of the label, the group or a key
 * as shown), grouped in OpenRA's order:
 * `[{ group, actions }]`. An empty query keeps everything.
 */
export function filterHotkeys(actions, query = '') {
  const q = query.trim().toLowerCase();
  const groups = new Map();
  for (const a of actions) {
    const keys = a.keys.map((k) => formatCombo(k).toLowerCase());
    // One letter is a key ("D" finds what D does); longer text a part of the command, the group or a key.
    const hit = !q || (q.length === 1 ? keys.some((k) => k === q) : a.label.toLowerCase().includes(q) || keys.some((k) => k.includes(q)) || a.group.toLowerCase().includes(q));
    if (!hit) continue;
    if (!groups.has(a.group)) groups.set(a.group, []);
    groups.get(a.group).push(a);
  }
  const order = (g) => (GROUP_ORDER.includes(g) ? GROUP_ORDER.indexOf(g) : GROUP_ORDER.length);
  return [...groups].sort((x, y) => order(x[0]) - order(y[0])).map(([group, list]) => ({ group, actions: list }));
}

/**
 * Open / close state and what it means for the game. `onChange(open, paused)`
 * runs on every change; online games never pause.
 */
export class MenuState {
  constructor({ online = false, onChange = () => {} } = {}) {
    this.online = online;
    this.onChange = onChange;
    this.isOpen = false;
  }

  get paused() {
    return this.isOpen && !this.online;
  }

  open() {
    if (this.isOpen) return false;
    this.isOpen = true;
    this.onChange(true, this.paused);
    return true;
  }

  close() {
    if (!this.isOpen) return false;
    this.isOpen = false;
    this.onChange(false, false);
    return true;
  }

  toggle() {
    return this.isOpen ? this.close() : this.open();
  }
}

/** Text for a slider value: "Off" at 0, else "1.25x". */
export function speedLabel(v) {
  return v === 0 ? 'Off' : `${Number(v.toFixed(2))}x`;
}

/** Text for the battlefield zoom: "1.0x". */
export function zoomLabel(v) {
  return `${Number(v).toFixed(1)}x`;
}

/** Text for a scale setting: "Auto (85%)" or "110%". */
export function scaleLabel(setting, resolved) {
  return setting === 'auto' ? `Auto (${percent(resolved)})` : percent(resolved);
}

/** What the Display section says about the three ways the picture changes. */
export const DISPLAY_HELP =
  'UI scale sizes the sidebar, bars, menus and dialogs. Game scale sizes units and terrain; the mouse wheel and pinch zoom from there, and the next game starts at the zoom you last used. ' +
  'Max resolution and low quality set how many pixels the battlefield is drawn with: sharpness and speed, not size.';

/**
 * Display, game and mouse settings of the Settings page (MENU_SETTINGS
 * stayed the list of what the old Defaults button put back: every tab's
 * reset but Controls' build menu choice and Advanced).
 */
export const MENU_SETTINGS = Object.freeze([
  'uiScale',
  'gameScale',
  'zoomFactor',
  'pixelRatioCap',
  'lowQuality',
  'reduceMotion',
  'edgeScrollSpeed',
  'keyScrollSpeed',
  'showUnitPaths',
  'targetLines',
  'healthBars',
  'playerStanceColors',
  'hideReplayChat',
  'uiFeedbackNotifications',
  'gameEventNotifications',
  'mouseCapture',
  'mouseCaptureSpeed',
  'mouseCaptureRaw',
  'mouseCaptureEscMenu',
  'mouseCaptureNotice',
  'pauseWhenHidden',
]);

/** What the Mouse capture section says. */
export const MOUSE_CAPTURE_HELP =
  'Keeps the pointer inside the game, so it cannot slip onto another screen. The game draws its own cursor while the mouse is captured.';

/** Controls of the menu that take every key: an open select list and text fields. */
const ALL_KEYS = '[role="listbox"], .ui-sp-panel, input:not([type="checkbox"]):not([type="radio"]):not([type="range"]), textarea';
/** Controls that own their arrow, Home, End and Page keys only (tabs, steppers, radio groups, sliders). */
const NAV_KEYS = '[role="tablist"], [role="spinbutton"], [role="radiogroup"], input[type="range"]';
const NAV = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);

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

/** A menu list button: its label and a quieter hint on the right. */
function item(label, hint, onClick, { accent = false } = {}) {
  const b = button(label, `ui-btn gm-item${accent ? ' gm-item-accent' : ''}`, onClick);
  if (hint) b.append(el('span', 'gm-item-hint', hint));
  return b;
}

/** A page's heading row: a Back arrow (to the menu) and the title. */
function pageHead(title, onBack, extra = null) {
  const head = el('div', 'gm-head');
  const row = el('div', 'gm-title-row');
  if (onBack) {
    const back = button('', 'ui-btn ui-btn-icon gm-back', onBack);
    back.setAttribute('aria-label', 'Back to the game menu');
    row.append(back);
  }
  row.append(el('h1', 'gm-title', title));
  head.append(row);
  if (extra) head.append(extra);
  return head;
}

// Actions that still run while the menu is open (they close it or are
// harmless; OpenRA's menu context has ToggleMute and TakeScreenshot).
const MENU_ACTIONS = new Set(['menu', 'pause', 'fullscreen', 'toggleMute', 'takeScreenshot']);

export class GameMenu {
  /**
   * @param {HTMLElement} root  the overlay section
   * @param {{
   *   online: boolean,
   *   replay?: boolean,  the replay viewer (keeps playing while the menu is open)
   *   actions?: { id: string, label: string, run(): string | Promise<string> }[],  record actions; run() returns a message
   *   hotkeys: import('./hotkeys.js').HotkeyRegistry,
   *   settings: { get(k: string): any, set(k: string, v: any): any, reset(k: string): any, subscribe(k: string, fn: Function): Function, registry?: object },
   *   fullscreen: { available(): boolean, active(): boolean, toggle(): Promise<{ ok: boolean, message?: string }> },
   *   mouseCapture?: { available(): boolean },  mouse capture (js/mouselock.js); its section shows where available
   *   onChange(open: boolean, paused: boolean): void,
   *   uiScale?: import('./scale.js').UiScale,  the page's UI scale (live preview while its slider moves)
   *   renderRatio?(): number,  the battlefield's render pixel ratio (game scale: Auto and sharp steps)
   *   win?: Window,  the window the scales are picked for, and where OPEN_NETWORK_EVENT comes (tests)
   *   audio?: import('./audio/index.js').AudioSystem,  the Sound tab and the Music page
   *   onSound?(): void,
   *   onContent?(): void,  the Original content dialog (graphics, original sounds, texture packs)
   *   contentLabel?(): string,  its button's label (with the installed state)
   *   content?: { hasOriginalGraphics: boolean, builtinError?: string|null, onChange?(fn): Function },
   *     the content system (js/content): the texture pack cards' install state
   *   onReleaseNotes?(): void,
   *   restart?: { replay?: boolean, online?: boolean, available?(): boolean, label?(): string, text?(): string, run(): void },
   *     Restart (asks first); online the rematch (js/online.js): shown while `available()`, with its own label and text
   *   onStats?(): void,  the statistics screen (js/stats.js)
   *   statsAvailable?(): boolean,  whether Statistics shows now (not for a player still in the game)
   *   gameInfo?(): { title: string, objectives: object | null, briefing: object | null, options: object, weather?: string },
   *     what the game info shows now (js/gameinfo.js models)
   *   surrender?: { shown(): boolean, enabled(): boolean, run(): void },
   *     OpenRA's Surrender: shown in games with more than one person for a player of the game,
   *     enabled while its game is undecided; run() gives the order
   *   guide?: import('./guide.js').GuideProgress,  the Guide page and its button
   *   net?: { source: object, players(): { client: number, name: string, color: string }[] },
   *     online games: the session's connection quality (js/netquality.js NetQuality) and the players
   *   syncStatus?(): { signedIn: boolean, status: string },  the account's settings sync (Settings' header)
   *   onLeave(): void,
   *   onExit(): void,
   * }} opts
   */
  constructor(root, opts) {
    this.root = root;
    this.opts = opts;
    this.state = new MenuState({ online: opts.online, onChange: (open, paused) => this.changed(open, paused) });
    this.view = 'main';
    this.capture = null; // action name waiting for a new key
    this.pageOffs = []; // what the open page follows, stopped when it goes (unmountPage)
    this.pinnedScale = undefined; // the menu's own UI scale while the UI scale slider moves
    this.infoTab = 'objectives'; // the game info's open tab
    this.settingsTab = 'game';
    this.guideChapter = null;
    this.keyGroup = null; // the Hotkeys tab's group (null: the first)
    this.keyQuery = '';
    this.card = el('div', 'ui-dialog game-menu-card');
    this.card.setAttribute('role', 'dialog');
    this.card.setAttribute('aria-modal', 'true');
    this.card.setAttribute('aria-label', 'Game menu');
    root.replaceChildren(this.card);
    root.hidden = true;
    this.keyWin = window;
    this.onWindowKey = (e) => this.onKey(e);
    this.keyWin.addEventListener('keydown', this.onWindowKey, true);
    // Keys that reached a control of the menu stop at the card: the game never sees them.
    this.onCardKey = (e) => {
      if (this.isOpen) e.stopPropagation();
    };
    this.card.addEventListener('keydown', this.onCardKey);
    // Rebuild the open page when bindings change elsewhere.
    this.offHotkeys = opts.hotkeys.onChange(() => this.isOpen && this.view === 'settings' && !this.batch && this.render());
    // The last minute of the connection, from the game's start (online games).
    this.net = opts.net?.source ? new NetHistory(opts.net.source) : null;
    this.netWin = opts.win ?? globalThis.window;
    this.onOpenNetwork = () => this.openAt('network');
    if (this.net) this.netWin?.addEventListener?.(OPEN_NETWORK_EVENT, this.onOpenNetwork);
  }

  /**
   * The game is going (a restart in place): an open menu closes without
   * telling the game (it is going too), what its page follows stops, the
   * listeners go and the section is emptied for the next game's menu.
   */
  dispose() {
    this.capture = null;
    this.state.isOpen = false;
    this.unmountPage();
    this.keyWin.removeEventListener('keydown', this.onWindowKey, true);
    this.card.removeEventListener('keydown', this.onCardKey);
    this.offHotkeys?.();
    this.offHotkeys = null;
    this.net?.dispose();
    this.netWin?.removeEventListener?.(OPEN_NETWORK_EVENT, this.onOpenNetwork);
    if (this.root.contains(document.activeElement)) document.activeElement.blur();
    this.root.hidden = true;
    this.root.replaceChildren();
  }

  get isOpen() {
    return this.state.isOpen;
  }

  open() {
    if (this.isOpen) return;
    this.view = 'main';
    this.rendered = null;
    this.message = '';
    this.state.open();
  }

  /** Open the menu on a page ('network', 'guide', 'settings'), or show that page when it is open. */
  openAt(view, tab) {
    if (view === 'network' && !this.net) return;
    if (!this.isOpen) {
      this.view = view;
      if (tab) this.settingsTab = tab;
      this.rendered = null;
      this.message = '';
      this.state.open();
    } else this.show(view, tab);
  }

  close() {
    this.capture = null;
    this.state.close();
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  changed(open, paused) {
    this.root.hidden = !open;
    if (open) this.render();
    else {
      this.unmountPage();
      if (this.root.contains(document.activeElement)) document.activeElement.blur();
    }
    this.opts.onChange(open, paused);
  }

  /** Stop what the open page follows (the Sound tab, the UI scale, the game info's timer). */
  unmountPage() {
    for (const off of this.pageOffs ?? []) off();
    this.pageOffs = [];
    this.endScalePreview();
  }

  /** Show a page; 'controls' is the Settings page on its Hotkeys tab, `tab` a Settings tab. */
  show(view, tab) {
    if (view === 'controls') {
      view = 'settings';
      tab = 'hotkeys';
    }
    if (view === 'network' && !this.net) view = 'main';
    this.view = view;
    if (tab) this.settingsTab = tab;
    this.capture = null;
    this.message = '';
    this.render();
  }

  onKey(e) {
    if (!this.isOpen) return;
    // A dialog opened from the menu (Sound, Original content, Release notes) handles its own keys: Esc closes it, not the menu.
    const t = e.target;
    const inside = t instanceof Element && this.root.contains(t);
    if (t instanceof Element && !inside && t.closest('[role="dialog"]')) return;
    if (this.capture) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.repeat) return;
      if (e.key === 'Escape') {
        this.capture = null;
        this.message = '';
        this.render();
        return;
      }
      const combo = comboFromEvent(e);
      if (!combo) return; // a modifier alone: wait for the key
      const name = this.capture;
      this.capture = null;
      const result = this.opts.hotkeys.rebind(name, combo);
      if (!result.ok) this.message = `${formatCombo(combo)}: ${result.reason}`;
      else if (result.displaced) this.message = `${formatCombo(combo)} moved from "${this.label(result.displaced)}" to "${this.label(name)}".`;
      else this.message = '';
      this.render();
      return;
    }
    // A control that works with keys gets them (it stops them itself or at the card): a list or
    // text field every key, tabs, steppers and radio groups their navigation keys only.
    const own = inside && (t.closest(ALL_KEYS) || (NAV.has(e.key) && t.closest(NAV_KEYS)));
    if (e.key === 'Escape') {
      // An open select list closes, and only the list (js/ui/controls.js selectPlate).
      if (inside && t.closest('[role="listbox"], .ui-sp-panel')) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      // An open help tip closes first.
      if (closeOpenTip()) return;
      if (this.view === 'main') this.close();
      else this.show('main');
      return;
    }
    if (own) return;
    const combo = comboFromEvent(e);
    const action = combo && this.opts.hotkeys.actionFor(combo);
    if (action && MENU_ACTIONS.has(action)) {
      e.stopImmediatePropagation();
      this.opts.hotkeys.handle(e);
      return;
    }
    // Buttons of the menu get their keys (Enter, Space, Tab), which then stop at the card.
    if (inside) return;
    // Keep game hotkeys and chat from firing behind the menu.
    e.stopImmediatePropagation();
  }

  label(name) {
    return this.opts.hotkeys.list().find((a) => a.name === name)?.label ?? name;
  }

  render() {
    const c = this.card;
    // Re-rendering the same page (after a rebind) keeps its scroll position and focus.
    const same = this.rendered === this.view;
    const scroll = same ? (c.querySelector('.game-menu-scroll:not([hidden])')?.scrollTop ?? 0) : 0;
    const focusId = same && c.contains(document.activeElement) ? document.activeElement.id : '';
    this.rendered = this.view;
    this.unmountPage();
    c.replaceChildren();
    c.className = `ui-dialog game-menu-card gm-view-${this.view}`;
    if (this.view === 'settings') this.renderSettings(c);
    else if (this.view === 'music') this.renderMusic(c);
    else if (this.view === 'guide' && this.opts.guide) this.renderGuidePage(c);
    else if (this.view === 'network' && this.net) this.renderNetwork(c);
    else if (this.view === 'leave' || this.view === 'exit') this.renderConfirm(c, this.view);
    else if (this.view === 'restart') this.renderRestart(c);
    else if (this.view === 'surrender') this.renderSurrender(c);
    else {
      this.view = 'main';
      c.className = 'ui-dialog game-menu-card gm-view-main';
      this.renderMain(c);
    }
    if (this.message) {
      const m = el('p', 'gm-message', this.message);
      m.setAttribute('role', 'status');
      const foot = c.querySelector('.gm-foot');
      if (foot) foot.before(m);
      else c.append(m);
    }
    const list = c.querySelector('.game-menu-scroll:not([hidden])');
    if (list) list.scrollTop = scroll;
    if (focusId) c.querySelector(`#${focusId}`)?.focus({ preventScroll: true });
    if (!same || !c.contains(document.activeElement)) (c.querySelector('.ui-btn-primary') ?? c.querySelector('button'))?.focus({ preventScroll: true });
  }

  // ---- Main page -------------------------------------------------------------------

  renderMain(c) {
    const online = this.opts.online;
    const tagline = this.opts.replay
      ? 'Replay: it keeps playing while this menu is open (P pauses it).'
      : online
        ? 'Online game: it keeps running while this menu is open. Online games cannot be paused.'
        : 'The game is paused. Esc resumes.';
    const status = el('p', 'gm-status');
    status.append(led(online ? 'warn' : 'info'), el('span', null, tagline));
    c.append(pageHead(online ? 'Game menu' : 'Paused', null, status));
    const body = el('div', 'gm-main');
    const actions = el('div', 'gm-actions');
    const fs = this.opts.fullscreen;
    const stats = this.opts.onStats && (this.opts.statsAvailable?.() ?? true);
    const guide = this.opts.guide;
    const list = el('div', 'gm-list');
    list.append(
      ...(guide ? [item('Guide', guideHint(guide), () => this.show('guide'), { accent: guide.count() < guide.total })] : []),
      ...(stats ? [item('Statistics', '', () => this.opts.onStats())] : []),
      ...(this.opts.actions ?? []).map((a) => item(a.label, '', () => this.runAction(a))),
      item('Settings', '', () => this.show('settings')),
      ...(this.net ? [item('Network', netHint(this.opts.net.source), () => this.show('network'))] : []),
      ...(this.opts.onSound ? [item('Sound', '', () => this.opts.onSound())] : []),
      ...(this.opts.audio ? [item('Music', '', () => this.show('music'))] : []),
      ...(this.opts.onContent ? [item(this.opts.contentLabel?.() ?? 'Original content', '', () => this.opts.onContent())] : []),
      item('Controls and hotkeys', 'Keys and mouse', () => this.show('settings', 'hotkeys')),
      item(fs.active() ? 'Leave fullscreen' : 'Fullscreen', formatCombo('Alt+Enter'), () => this.toggleFullscreen()),
      ...(this.opts.onReleaseNotes ? [item('Release notes', '', () => this.opts.onReleaseNotes())] : []),
      ...(this.restartShown() ? [item(this.restartLabel(), '', () => this.show('restart'))] : []),
    );
    const exits = el('div', 'gm-exits');
    exits.append(
      ...this.surrenderButton(),
      button(online && !this.opts.replay ? 'Leave game' : 'Leave to lobby', 'ui-btn ui-btn-ghost', () => this.show('leave')),
      button('Exit', 'ui-btn ui-btn-ghost', () => this.show('exit')),
    );
    actions.append(button('Resume', 'ui-btn ui-btn-primary gm-resume', () => this.close()), list, exits);
    body.append(actions);
    if (this.opts.gameInfo) {
      const info = el('section', 'gm-info');
      info.setAttribute('aria-label', 'Game info');
      body.append(info);
      this.renderInfo(info);
      const timer = setInterval(() => {
        // Not while its help tip is open: drawing again would close it.
        if (this.isOpen && this.view === 'main' && !openTip()) this.renderInfo(info);
      }, GAME_INFO_REFRESH_MS);
      timer.unref?.();
      this.pageOffs.push(() => clearInterval(timer));
    }
    c.append(body);
  }

  /** The game info section (OpenRA GAME_INFO_PANEL), drawn again every second (scores). */
  renderInfo(box) {
    const view = this.opts.gameInfo?.();
    if (!view) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const focusId = box.contains(document.activeElement) ? document.activeElement.id : '';
    box.replaceChildren();
    this.infoTab = renderGameInfo(box, view, this.infoTab, (id, focus) => {
      this.infoTab = id;
      this.renderInfo(box);
      if (focus) box.querySelector(`#game-info-tab-${id}`)?.focus({ preventScroll: true });
    });
    box.querySelector('h2')?.append(infoTip('menu.gameInfo', { label: 'Game info' }).root);
    if (focusId) box.querySelector(`#${focusId}`)?.focus({ preventScroll: true });
  }

  /** Run a record action and show its message. */
  async runAction(action) {
    let message;
    try {
      message = await action.run();
    } catch (err) {
      message = err?.message ?? String(err);
    }
    this.message = message || '';
    if (this.isOpen) this.render();
  }

  async toggleFullscreen() {
    const r = await this.opts.fullscreen.toggle();
    this.message = r.ok ? '' : r.message;
    if (this.isOpen) this.render();
  }

  /** A confirm step: title, text, the main action and Back. */
  confirm(c, title, text, action, actionLabel, backLabel = 'Back') {
    c.append(pageHead(title, null));
    const body = el('div', 'gm-confirm');
    body.append(el('p', 'gm-text', text));
    const row = el('div', 'ui-dialog-actions');
    const main = button(actionLabel, 'ui-btn ui-btn-primary', action);
    row.append(button(backLabel, 'ui-btn ui-btn-ghost', () => this.show('main')), main);
    body.append(row);
    c.append(body);
    return c;
  }

  renderConfirm(c, kind) {
    const online = this.opts.online && !this.opts.replay;
    const what = kind === 'exit' ? 'Exit to the WebRA website?' : online ? 'Leave this online game?' : 'Leave to the lobby?';
    const saves = (this.opts.actions ?? []).some((a) => a.id === 'save');
    const note = this.opts.replay
      ? 'The replay closes.'
      : online
        ? 'The other players keep playing without you.'
        : saves
          ? 'This game ends. Save it first to continue it later.'
          : 'This game ends and cannot be resumed.';
    this.confirm(c, kind === 'exit' ? 'Exit' : 'Leave', `${what} ${note}`, () => (kind === 'exit' ? this.opts.onExit() : this.opts.onLeave()), kind === 'exit' ? 'Exit' : 'Leave');
  }

  /** OpenRA IngameMenuLogic.CreateSurrenderButton: shown for a player of a game with more than one person, disabled once its game is decided. */
  surrenderButton() {
    const s = this.opts.surrender;
    if (!s?.shown()) return [];
    const b = button('', 'ui-btn ui-btn-hazard', () => this.show('surrender'));
    b.append(el('span', null, 'Surrender'));
    b.disabled = !s.enabled();
    return [b];
  }

  /** The surrender dialog (dialog-surrender): the player loses at once and may stay to watch. */
  renderSurrender(c) {
    this.confirm(
      c,
      'Surrender',
      'Are you sure you want to surrender? You lose at once; you can stay and watch the rest of the game.',
      () => {
        const s = this.opts.surrender;
        this.close();
        if (s?.enabled()) s.run();
      },
      'Surrender',
      'Stay',
    );
    c.querySelector('h1')?.append(infoTip('menu.surrender', { label: 'Surrender' }).root);
  }

  /** Whether the menu offers Restart (or the rematch) now. */
  restartShown() {
    const r = this.opts.restart;
    return !!r && (r.available?.() ?? true);
  }

  restartLabel() {
    const r = this.opts.restart;
    return r.label?.() ?? (r.replay ? 'Restart replay' : 'Restart');
  }

  /** Restart: progress is lost, so it asks first. Online: the rematch, explained. */
  renderRestart(c) {
    const run = () => {
      this.close();
      this.opts.restart.run();
    };
    if (this.opts.restart?.online) {
      this.confirm(c, 'Rematch', this.opts.restart.text?.() ?? '', run, this.restartLabel());
      return;
    }
    const replay = !!this.opts.restart?.replay;
    this.confirm(
      c,
      'Restart',
      replay ? 'Play this replay again from the start?' : 'Restart this game from the beginning with exactly the same settings? Everything played so far is lost (save it first to keep it).',
      run,
      replay ? 'Restart replay' : 'Restart',
    );
  }

  /** The music player (OpenRA's in-game Music panel). */
  renderMusic(c) {
    c.append(pageHead('Music', () => this.show('main')));
    const list = el('div', 'game-menu-scroll game-menu-music');
    const player = mountMusicPlayer(list, this.opts.audio, { idPrefix: 'menu-music', heading: 2, onContent: this.opts.onContent });
    this.pageOffs.push(() => player.dispose());
    const foot = el('div', 'gm-foot');
    foot.append(button('Back', 'ui-btn ui-btn-primary', () => this.show('main')));
    c.append(list, foot);
  }

  // ---- Guide and Network --------------------------------------------------------------

  renderGuidePage(c) {
    const progress = this.opts.guide;
    this.guideChapter = renderGuide(c, {
      progress,
      hotkeys: this.opts.hotkeys,
      chapter: this.guideChapter,
      onChapter: (id) => {
        this.guideChapter = id;
        this.render();
        this.card.querySelector(`#guide-chapter-${id}`)?.focus({ preventScroll: true });
      },
      onBack: () => this.show('main'),
    });
    // Steps ticked off meanwhile (the game, Skip, another tab, the account) show at once.
    let queued = false;
    this.pageOffs.push(
      progress.subscribe(() => {
        if (queued) return;
        queued = true;
        queueMicrotask(() => {
          queued = false;
          if (this.isOpen && this.view === 'guide') this.render();
        });
      }),
    );
  }

  renderNetwork(c) {
    const status = el('p', 'gm-status');
    status.append(led('warn'), el('span', null, 'Online: the game goes on while this menu is open.'));
    c.append(pageHead('Network', () => this.show('main'), status));
    const scroll = el('div', 'game-menu-scroll gm-network');
    const data = el('div', 'net-data');
    const draw = () => renderNetworkData(data, this.net.model(this.opts.net.players?.() ?? []));
    const registry = this.opts.settings.registry;
    scroll.append(data);
    if (registry) scroll.append(netSwitches(registry, this.pageOffs));
    c.append(scroll);
    const foot = el('div', 'gm-foot');
    foot.append(button('Back', 'ui-btn ui-btn-primary', () => this.show('main')));
    c.append(foot);
    draw();
    this.pageOffs.push(this.net.onChange(draw));
    // The server's stall log has this game's waiting time.
    this.net.refresh();
  }

  // ---- Settings ------------------------------------------------------------------------

  renderSettings(c) {
    const sync = this.opts.syncStatus ? syncLine(this.opts.syncStatus()) : null;
    let syncEl = null;
    if (sync) {
      syncEl = el('p', 'gm-status gm-sync');
      syncEl.setAttribute('role', 'status');
      syncEl.append(led(sync.led), el('span', null, sync.text));
    }
    c.append(pageHead('Settings', () => this.show('main'), syncEl));
    const panels = new Map();
    const build = {
      game: (p) => this.settingsGame(p),
      graphics: (p) => this.settingsGraphics(p),
      controls: (p) => this.settingsControls(p),
      hotkeys: (p) => this.settingsHotkeys(p),
      sound: (p) => this.settingsSound(p),
      privacy: (p) => this.settingsPrivacy(p),
      advanced: (p) => this.settingsAdvanced(p),
    };
    for (const t of SETTINGS_TABS) {
      const panel = el('div', `game-menu-scroll gm-panel gm-panel-${t.id}`);
      build[t.id](panel);
      panels.set(t.id, panel);
    }
    const reset = button('Reset this section', 'ui-btn ui-btn-ghost', () => this.resetSection(this.settingsTab));
    const syncReset = () => {
      reset.hidden = SECTION_SETTINGS[this.settingsTab] === null;
      reset.textContent = this.settingsTab === 'hotkeys' ? 'Reset all hotkeys' : 'Reset this section';
    };
    const bar = tabBar({
      id: 'game-menu-tab',
      label: 'Settings sections',
      vertical: true,
      value: this.settingsTab,
      tabs: SETTINGS_TABS.map((t) => ({ id: t.id, label: t.label, panel: panels.get(t.id) })),
      onChange: (id) => {
        this.settingsTab = id;
        syncReset();
      },
    });
    const body = el('div', 'gm-settings');
    body.append(bar.root, ...panels.values());
    c.append(body);
    syncReset();
    const foot = el('div', 'gm-foot');
    foot.append(reset, button('Done', 'ui-btn ui-btn-primary', () => this.show('main')));
    c.append(foot);
  }

  /** Put back the settings of one tab. */
  resetSection(tab) {
    const s = this.opts.settings;
    if (tab === 'hotkeys') {
      this.opts.hotkeys.reset();
      return;
    }
    for (const key of SECTION_SETTINGS[tab] ?? []) s.reset(key);
    if (tab === 'game') for (const key of ['warnSelf', 'warnOthers', 'signalBars']) s.registry?.reset('net', key);
    if (tab === 'sound') this.opts.audio?.prefs.set(DEFAULT_PREFS);
    this.render();
  }

  /** Row builders for the Settings tabs. */
  rows() {
    const s = this.opts.settings;
    const slider = (key, text, { step = 0.25, format = speedLabel } = {}) => {
      const spec = SCHEMA[key];
      const control = createSlider({
        id: `game-menu-${key}`,
        label: text,
        min: spec.min,
        max: spec.max,
        step,
        value: s.get(key),
        format,
        rowClass: 'game-menu-row',
        onInput: (v) => {
          control.output.textContent = format(s.set(key, v));
        },
      });
      // Follow the setting when it changes elsewhere (the mouse wheel's zoom, another tab).
      this.pageOffs.push(s.subscribe(key, (v) => Number(control.input.value) !== v && control.set(v)));
      return withHelp(control.row, key, control.input);
    };
    const check = (key, text) => {
      const t = createToggle({ id: `game-menu-${key}`, label: text, checked: !!s.get(key), rowClass: 'game-menu-row', onChange: (on) => s.set(key, on) });
      return withHelp(t.row, key, t.input);
    };
    const choice = (key, text, labels, hint) => {
      const row = choiceRow(s, key, text, labels, hint);
      return withHelp(row, key, row.querySelector('[role="radiogroup"]'));
    };
    return { s, slider, check, choice };
  }

  settingsGame(p) {
    const { slider, check, choice } = this.rows();
    p.append(
      el('h2', 'gm-section-title', 'Scrolling and units'),
      slider('edgeScrollSpeed', 'Edge scroll speed'),
      slider('keyScrollSpeed', 'Keyboard scroll speed'),
      check('showUnitPaths', 'Show unit paths'),
      choice('targetLines', 'Target lines', SCHEMA.targetLines.labels),
      choiceRow(this.opts.settings, 'healthBars', 'Always show health bars', { off: 'Off', damaged: 'Damaged', all: 'All' }, 'Off shows them only for selected and hovered units. Damaged and All cover units and buildings.'),
      check('playerStanceColors', 'Relationship colours'),
      // OpenRA's Display settings: js/chatlog.js, js/notifications.js.
      el('h2', 'gm-section-title', 'Chat and notifications'),
      check('hideReplayChat', 'Hide chat in replays'),
      check('uiFeedbackNotifications', 'Show UI feedback notifications'),
      check('gameEventNotifications', 'Show game event notifications'),
      el('h2', 'gm-section-title', 'Pausing'),
      // Single player in another tab or a minimised window (js/main.js): plays on unless this is on.
      check('pauseWhenHidden', 'Pause when the game is hidden'),
    );
    // Online games (registry net.*): the same switches as the Network page.
    const registry = this.opts.settings.registry;
    if (registry) p.append(el('h2', 'gm-section-title', 'Online games'), netSwitches(registry, this.pageOffs));
  }

  settingsGraphics(p) {
    const { slider, check, choice } = this.rows();
    p.append(el('h2', 'gm-section-title', 'Texture pack'), this.packCards());
    if (this.opts.onContent) p.append(button('Original content and texture packs...', 'ui-btn ui-btn-sm gm-content', () => this.opts.onContent()));
    p.append(el('h2', 'gm-section-title', 'Display'), el('p', 'gm-note', DISPLAY_HELP));
    p.append(this.uiScaleRow(), this.gameScaleRow());
    p.append(slider('zoomFactor', 'Battlefield zoom', { step: 0.1, format: zoomLabel }));
    p.append(slider('pixelRatioCap', 'Max resolution (pixel ratio)'), check('lowQuality', 'Low quality (faster on phones)'));
    // Camera shake and the nuke's flash (js/battlefx.js).
    p.append(choice('reduceMotion', 'Reduce motion', SCHEMA.reduceMotion.labels));
    const fs = this.opts.fullscreen;
    const fsRow = el('div', 'ui-row game-menu-row gm-button-row');
    const fsButton = button(fs.active() ? 'Leave fullscreen' : 'Fullscreen', 'ui-btn ui-btn-sm', () => this.toggleFullscreen());
    fsButton.disabled = !fs.available();
    fsRow.append(el('span', 'ui-label', `Fullscreen (${formatCombo('Alt+Enter')})`), fsButton);
    withHelp(fsRow, 'fullscreen', fsButton);
    p.append(fsRow);
    if (!fs.available()) p.append(el('p', 'gm-note', 'Fullscreen is not available in this browser or page.'));
  }

  /** The texture pack cards: a radio group of buttons (arrows move, like radios). */
  packCards() {
    const s = this.opts.settings;
    const group = el('div', 'gm-packs');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', 'Texture pack');
    const draw = () => {
      const content = this.opts.content;
      const cards = packCards(SCHEMA.graphics?.options ?? [], s.get('graphics'), { originalInstalled: !!content?.hasOriginalGraphics, problem: content?.builtinError ?? null });
      const focused = group.contains(document.activeElement) ? document.activeElement.dataset.value : null;
      group.replaceChildren(
        ...cards.map((card) => {
          const b = button('', `gm-pack gm-pack-${card.value}`, () => !card.disabled && s.set('graphics', card.value));
          b.dataset.value = card.value;
          b.setAttribute('role', 'radio');
          b.setAttribute('aria-checked', String(card.checked));
          b.setAttribute('aria-disabled', String(card.disabled));
          b.tabIndex = card.checked ? 0 : -1;
          const swatch = el('span', 'gm-pack-swatch');
          swatch.setAttribute('aria-hidden', 'true');
          const name = el('span', 'gm-pack-name');
          name.append(led(card.checked ? 'on' : 'off'), el('span', null, card.name));
          b.append(swatch, name, el('span', 'gm-pack-note', card.note), el('span', `gm-pack-status${card.warn ? ' gm-pack-warn' : ''}`, card.status));
          return b;
        }),
      );
      if (!group.querySelector('[tabindex="0"]')) group.querySelector('button')?.setAttribute('tabindex', '0');
      if (focused) group.querySelector(`[data-value="${focused}"]`)?.focus({ preventScroll: true });
    };
    group.addEventListener('keydown', (e) => {
      const next = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (!next) return;
      e.preventDefault();
      const all = group.querySelectorAll('button').filter((b) => b.getAttribute('aria-disabled') !== 'true');
      const at = all.indexOf(document.activeElement);
      const to = all[(Math.max(0, at) + next + all.length) % all.length];
      if (!to) return;
      s.set('graphics', to.dataset.value);
      group.querySelector(`[data-value="${to.dataset.value}"]`)?.focus({ preventScroll: true });
    });
    draw();
    this.pageOffs.push(s.subscribe('graphics', draw));
    const off = this.opts.content?.onChange?.(draw);
    if (off) this.pageOffs.push(off);
    return group;
  }

  settingsControls(p) {
    const s = this.opts.settings;
    const { slider, check, choice } = this.rows();
    // ---- Build menu (js/production.js rightClickAction); synced with the account like the other settings ----
    const right = choiceRow(s, 'buildRightClick', 'Right click in the build menu', SCHEMA.buildRightClick.labels);
    p.append(el('h2', 'gm-section-title', 'Build menu'), withHelp(right, 'buildRightClick', right.querySelector('[role="radiogroup"]')));
    // ---- Mouse capture (js/mouselock.js; not without Pointer Lock or a mouse) ----
    if (this.opts.mouseCapture?.available()) {
      const keys = this.opts.hotkeys.bindingsFor('toggleMouseCapture');
      const release = keys.length ? `${formatCombo(keys[0])} releases it and the game plays on; Esc releases it too.` : 'Esc releases it.';
      p.append(
        el('h2', 'gm-section-title', 'Mouse capture'),
        el('p', 'gm-note', MOUSE_CAPTURE_HELP),
        choice('mouseCapture', 'Capture the mouse', { off: 'Off', fullscreen: 'In fullscreen', always: 'Always' }, `${release} A click into the game captures it again.`),
        slider('mouseCaptureSpeed', 'Captured mouse speed'),
        check('mouseCaptureRaw', 'Raw mouse input'),
        check('mouseCaptureEscMenu', 'Esc also opens the menu'),
        choice('mouseCaptureNotice', 'Mouse captured notice', SCHEMA.mouseCaptureNotice.labels),
      );
    }
    p.append(el('h2', 'gm-section-title', 'Mouse'), keyTable(fixedControls()), el('h2', 'gm-section-title', 'Touch'), keyTable(touchControls()));
  }

  settingsHotkeys(p) {
    const reg = this.opts.hotkeys;
    const top = el('div', 'gm-keys-top');
    const search = el('input', 'ui-input gm-keys-search');
    search.type = 'search';
    search.id = 'game-menu-keys-search';
    search.placeholder = 'Find a command or key';
    search.setAttribute('aria-label', 'Find a command or key');
    search.setAttribute('autocomplete', 'off');
    search.value = this.keyQuery;
    top.append(search);
    const body = el('div', 'gm-keys');
    const nav = el('nav', 'gm-keys-groups');
    nav.setAttribute('aria-label', 'Hotkey groups');
    const main = el('div', 'gm-keys-main');
    main.setAttribute('aria-live', 'off');
    body.append(nav, main);
    const groups = filterHotkeys(reg.list());
    if (!groups.some((g) => g.group === this.keyGroup)) this.keyGroup = groups[0]?.group ?? null;
    for (const g of groups) {
      const b = button('', 'gm-keys-group', () => {
        this.keyGroup = g.group;
        this.keyQuery = '';
        search.value = '';
        drawRows();
        for (const x of nav.querySelectorAll('button')) x.removeAttribute('aria-current');
        b.setAttribute('aria-current', 'true');
      });
      b.append(led(g.group === this.keyGroup ? 'on' : 'off'), el('span', null, g.group));
      if (g.group === this.keyGroup) b.setAttribute('aria-current', 'true');
      nav.append(b);
    }
    const drawRows = () => {
      const q = this.keyQuery.trim();
      const shown = q ? filterHotkeys(reg.list(), q) : filterHotkeys(reg.list()).filter((g) => g.group === this.keyGroup);
      nav.hidden = !!q;
      for (const b of nav.querySelectorAll('button')) {
        const on = b.getAttribute('aria-current') === 'true';
        b.querySelector('.ui-led')?.classList.toggle('ui-led-on', on);
        b.querySelector('.ui-led')?.classList.toggle('ui-led-off', !on);
      }
      main.replaceChildren();
      if (this.capture) {
        const line = el('p', 'gm-listening');
        line.setAttribute('role', 'status');
        line.append(led('on'), el('span', null, `Press the new key for "${this.label(this.capture)}". A key that another command uses moves here, and this page says which one. Esc cancels.`));
        main.append(line);
      }
      if (!shown.length) main.append(el('p', 'gm-note', `No command or key matches "${q}".`));
      for (const g of shown) {
        const head = el('div', 'gm-keys-head');
        head.append(el('h2', 'gm-section-title', g.group));
        const changed = g.actions.some((a) => !a.readonly && JSON.stringify(a.keys) !== JSON.stringify(a.defaults));
        const resetGroup = button('Reset group', 'ui-btn ui-btn-sm ui-btn-ghost', () => this.resetGroup(g.actions));
        resetGroup.disabled = !changed;
        head.append(resetGroup);
        main.append(head, this.keyRows(g.actions));
      }
    };
    search.addEventListener('input', () => {
      this.keyQuery = search.value;
      drawRows();
    });
    drawRows();
    p.append(top, body);
    for (const key of CONTROLS_HELP_KEYS) p.append(el('p', 'gm-note', helpText(`controls.${key}`)));
    const sync = this.opts.syncStatus?.();
    p.append(el('p', 'gm-note', `Esc always cancels and opens this menu. ${sync?.signedIn ? 'Your keys follow your account.' : 'Your keys are saved in this browser.'} The map editor keeps its own shortcuts.`));
  }

  /** Put back the keys of one group (one redraw). */
  resetGroup(actions) {
    this.batch = true;
    try {
      for (const a of actions) if (!a.readonly) this.opts.hotkeys.reset(a.name);
    } finally {
      this.batch = false;
    }
    this.render();
  }

  /** The rows of a hotkey group: the command, its keys as caps, Change (Cancel while listening), Clear and Reset. */
  keyRows(actions) {
    const reg = this.opts.hotkeys;
    const table = el('div', 'game-menu-keys');
    for (const a of actions) {
      const row = el('div', 'game-menu-key-row');
      const waiting = this.capture === a.name;
      if (waiting) row.classList.add('gm-key-listening');
      const keys = el('span', 'game-menu-keycap', waiting ? 'Press a key...' : a.keys.length ? a.keys.map((k) => formatCombo(k)).join(' / ') : 'Unbound');
      const changed = JSON.stringify(a.keys) !== JSON.stringify(a.defaults);
      const label = el('span', 'game-menu-key-label', a.label);
      // Where WebRA's default differs from OpenRA's: the browser keeps OpenRA's key, or WebRA uses it.
      const sub = a.openra && substituteFor(a.openra);
      if (sub && OPENRA_HOTKEYS[a.openra]?.key) label.title = `OpenRA: ${formatCombo(OPENRA_HOTKEYS[a.openra].key)} (${sub.why}).`;
      if (a.context === 'chat-input') label.append(el('span', 'gm-key-where', ' (in the chat line)'));
      row.append(label, keys);
      if (a.readonly) {
        row.classList.add('game-menu-fixed');
      } else {
        row.append(
          button(waiting ? 'Cancel' : 'Change', 'ui-btn ui-btn-sm game-menu-mini', () => {
            this.capture = waiting ? null : a.name;
            this.message = '';
            this.render();
          }),
          button('Clear', 'ui-btn ui-btn-sm ui-btn-ghost game-menu-mini', () => reg.unbind(a.name)),
        );
        const resetBtn = button('Reset', 'ui-btn ui-btn-sm ui-btn-ghost game-menu-mini', () => reg.reset(a.name));
        resetBtn.disabled = !changed;
        row.append(resetBtn);
      }
      table.append(row);
    }
    return table;
  }

  settingsSound(p) {
    const audio = this.opts.audio;
    if (!audio) {
      p.append(el('h2', 'gm-section-title', 'Audio'), el('p', 'gm-note', 'Sound is unavailable in this browser.'));
      return;
    }
    // The Sound dialog's controls and the music player side by side (board Sound).
    const grid = el('div', 'gm-sound');
    const box = el('section', 'game-menu-audio gm-sound-settings');
    box.setAttribute('aria-labelledby', 'menu-audio-title');
    const title = el('h2', 'gm-section-title', 'Audio');
    title.id = 'menu-audio-title';
    const settings = el('div');
    box.append(title, settings);
    const mount = mountAudioSettings(settings, audio, { onContent: this.opts.onContent, onMusicPlayer: () => this.show('music'), idPrefix: 'menu-audio', heading: 3, help: true });
    this.pageOffs.push(() => mount.dispose());
    const music = el('section', 'gm-sound-music');
    music.setAttribute('aria-labelledby', 'menu-player-title');
    const mt = el('h2', 'gm-section-title', 'Music player');
    mt.id = 'menu-player-title';
    const player = el('div');
    music.append(mt, player);
    const mp = mountMusicPlayer(player, audio, { idPrefix: 'menu-player', heading: 3, onContent: this.opts.onContent });
    this.pageOffs.push(() => mp.dispose());
    grid.append(box, music);
    p.append(grid);
  }

  settingsPrivacy(p) {
    const { check } = this.rows();
    // Error reports (js/telemetry). Not reset: switching reports back on is the player's call.
    // The switch is kept even when this build reports nothing (it is synced and applies once reports are turned on).
    p.append(el('h2', 'gm-section-title', 'Privacy'), check('errorReports', 'Send error reports'));
    if (!reportsConfigured()) p.append(el('p', 'gm-note', 'Error reporting is off on this site: nothing is sent, whatever this switch says.'));
    // Replays in the account (js/account/replays.js): uploaded only while signed in; the switch syncs with the account.
    p.append(check('cloudReplays', 'Save replays to my account'));
  }

  settingsAdvanced(p) {
    const { check } = this.rows();
    // Performance capture (js/perfcapture.js; recording now and downloads are in the debug menu).
    const key = boundKey(this.opts.hotkeys, 'debugMenu');
    p.append(
      el('h2', 'gm-section-title', 'Performance'),
      check('perfCaptureStart', 'Record the start of every game'),
      el('p', 'gm-note', `Recording now, its length and the downloads are in the debug menu${key ? ` (${key})` : ''}.`),
    );
  }

  /** The window and render ratio the scales are picked for. */
  screen() {
    return { ...screenOf(this.opts.win ?? globalThis.window), ratio: this.opts.renderRatio?.() ?? 1 };
  }

  /**
   * A scale setting row: a slider with its value, an Auto switch and Reset.
   * `o.resolve(setting)` gives the scale in use, `o.fromSlider(v)` the stored
   * value for a slider position, `o.preview(v)` / `o.commit(v)` show and store.
   */
  scaleRow({ key, text, limits, step, resolve, fromSlider, preview, commit, ticks = [] }) {
    const s = this.opts.settings;
    const id = `game-menu-${key}`;
    const control = createSlider({
      id,
      label: text,
      min: limits.min,
      max: limits.max,
      step,
      value: resolve(s.get(key)),
      format: percent,
      rowClass: 'game-menu-row',
      onInput: (v) => {
        const value = fromSlider(v);
        control.output.textContent = percent(value);
        auto.checked = false;
        preview(value);
      },
    });
    const { row, input, output } = control;
    withHelp(row, key, input);
    const wrap = el('div', 'game-menu-scale');
    if (ticks.length) {
      const marks = el('datalist');
      marks.id = `${id}-ticks`;
      for (const t of ticks) {
        const o = el('option');
        o.value = String(t);
        marks.append(o);
      }
      input.setAttribute('list', marks.id);
      wrap.append(marks);
    }
    input.addEventListener('change', () => commit(fromSlider(Number(input.value))));
    const tools = el('div', 'game-menu-scale-tools');
    const autoLabel = el('label', 'game-menu-auto', 'Auto');
    autoLabel.htmlFor = `${id}-auto`;
    const auto = switchInput({ id: `${id}-auto`, small: true, onChange: (on) => s.set(key, on ? 'auto' : resolve('auto')) });
    const reset = button('Reset', 'ui-mini', () => s.reset(key));
    tools.append(autoLabel, auto, reset);
    // The Auto switch's help sits after its label, like the rows' help.
    const autoName = el('span', 'game-menu-name');
    autoLabel.replaceWith(autoName);
    autoName.append(autoLabel);
    labelWithHelp(autoName, 'settings.scaleAuto', auto, autoLabel);
    const show = (setting) => {
      const v = resolve(setting);
      control.set(v);
      output.textContent = scaleLabel(setting, v);
      input.setAttribute('aria-valuetext', output.textContent);
      auto.checked = setting === 'auto';
      reset.disabled = setting === SCHEMA[key].default;
    };
    // Follow the setting (Reset, Auto, another tab, the account) and, on Auto, the screen.
    const sync = () => show(s.get(key));
    this.pageOffs.push(s.subscribe(key, sync));
    sync();
    wrap.append(row, tools);
    return { node: wrap, sync };
  }

  uiScaleRow() {
    const s = this.opts.settings;
    const ui = this.opts.uiScale;
    const row = this.scaleRow({
      key: 'uiScale',
      text: 'UI scale',
      limits: UI_SCALE_LIMITS,
      step: UI_SCALE_LIMITS.step,
      resolve: (setting) => (setting === 'auto' ? (ui?.auto ?? 1) : setting),
      fromSlider: (v) => roundStep(v, UI_SCALE_LIMITS.step),
      // The page follows the slider at once; the menu keeps its size until the
      // slider is let go, so the slider does not move under the pointer.
      preview: (v) => {
        if (!ui) return;
        if (this.pinnedScale === undefined) {
          this.pinnedScale = ui.value;
          this.root.style.setProperty('--ui-scale', String(ui.value));
        }
        ui.preview(v);
      },
      commit: (v) => {
        s.set('uiScale', v);
        this.endScalePreview();
      },
    });
    // Auto follows the screen; not while the slider moves (the preview is not the setting).
    if (ui) this.pageOffs.push(ui.onChange(() => this.pinnedScale === undefined && row.sync()));
    return row.node;
  }

  /** The UI scale slider was let go (or the page closed): the menu follows the page again. */
  endScalePreview() {
    if (this.pinnedScale === undefined) return;
    this.pinnedScale = undefined;
    this.root.style.removeProperty('--ui-scale');
    this.opts.uiScale?.endPreview();
  }

  gameScaleRow() {
    const s = this.opts.settings;
    const ratio = () => this.screen().ratio;
    const row = this.scaleRow({
      key: 'gameScale',
      text: 'Game scale',
      limits: GAME_SCALE_LIMITS,
      step: 0.01,
      ticks: crispGameScales(ratio()),
      resolve: (setting) => resolveGameScale(setting, this.screen()),
      // Close to a scale where world pixels cover whole screen pixels: that one (sharpest sprites).
      fromSlider: (v) => snapGameScale(v, ratio()),
      // The battlefield behind the menu follows the slider.
      preview: (v) => s.set('gameScale', v),
      commit: (v) => s.set('gameScale', v),
    });
    const onResize = () => s.get('gameScale') === 'auto' && row.sync();
    const win = this.opts.win ?? globalThis.window;
    win?.addEventListener?.('resize', onResize);
    this.pageOffs.push(() => win?.removeEventListener?.('resize', onResize));
    return row.node;
  }
}

/** A list of fixed keys or gestures and what they do. */
function keyTable(rows) {
  const table = el('div', 'game-menu-keys');
  for (const [keys, what] of rows) {
    const row = el('div', 'game-menu-key-row game-menu-fixed');
    row.append(el('span', 'game-menu-key-label', what), el('span', 'game-menu-keycap', keys));
    table.append(row);
  }
  return table;
}

/** The Guide button's hint: new, or how far the player got. */
function guideHint(progress) {
  const n = progress.count();
  if (n === 0) return 'New: how to play';
  return n >= progress.total ? 'All steps done' : `${n} of ${progress.total} steps done`;
}

/** The Network button's hint: the own ping, with its quality in words. */
function netHint(source) {
  const self = source?.self;
  if (!self || self.rtt === null || self.rtt === undefined) return 'Measuring';
  const word = { good: 'good', fair: 'fair', poor: 'poor' }[self.quality] ?? '';
  return `${Math.round(self.rtt)} ms${word ? `, ${word}` : ''}`;
}

// In-game menu (Esc): Resume, Game info (OpenRA's GAME_INFO_PANEL with its
// Objectives, Briefing and Options tabs; js/gameinfo.js), Settings, Controls
// (hotkeys, rebindable), Fullscreen, Release notes, Surrender (OpenRA
// IngameMenuLogic: games with more than one person, after a confirm step),
// Leave to lobby, Exit, plus the game's record actions (save the game,
// download the replay; js/records.js), Restart (single player and replays,
// after a confirm step) and Statistics (once the local player watches:
// spectators, replays, after a defeat or at the end). Phones get the same
// menu from the HUD's Menu button.
//
// The Music page is the music player (js/audio/musicplayer.js), like OpenRA's
// in-game menu Music button.
//
// The Settings page has these parts: Display (UI scale, game scale, render
// resolution, fullscreen; js/scale.js), Scrolling and health bars, Mouse
// capture (js/mouselock.js, where the browser has Pointer Lock) and Audio
// (the Sound dialog's controls, js/audio/panel.js).
//
// Single player and skirmish pause while the menu is open. Online lockstep
// games cannot pause (docs/contracts.md: the server drops a player who holds
// the game up), so the menu opens without pausing and says so.
//
// While the menu is open it takes every keydown in the capture phase, so no
// game hotkey fires; default actions (Tab between buttons, arrow keys on a
// slider) still work.

import { BROWSER_SUBSTITUTES, comboFromEvent, formatCombo, GROUP_ORDER, isMac } from './hotkeys.js';
import { OPENRA_HOTKEYS } from './openra-hotkeys.js';
import { SCHEMA } from './settings.js';
import { touchControls } from './touch.js';
import { segmented, slider as createSlider, switchInput, toggle as createToggle } from './ui/controls.js';
import { GAME_SCALE_LIMITS, UI_SCALE_LIMITS, percent, resolveGameScale, screenOf, snapGameScale, crispGameScales, roundStep } from './scale.js';
import { mountAudioSettings } from './audio/panel.js';
import { mountMusicPlayer } from './audio/musicplayer.js';
import { DEFAULT_PREFS } from './audio/prefs.js';
import { closeOpenTip, infoTip, labelWithHelp, openTip } from './infotip.js';
import { helpText } from './help.js';
import { configured as reportsConfigured } from './telemetry/index.js';
import { renderGameInfo } from './gameinfo.js';

/** How often the open Game info page shows the scores again (ms). */
export const GAME_INFO_REFRESH_MS = 1000;

/**
 * Settings of the Settings page with a "?" (tests check each one has help
 * in js/help.js as `settings.<key>`); the Audio section's are AUDIO_HELP_KEYS
 * of js/audio/panel.js.
 */
export const MENU_HELP_KEYS = Object.freeze([
  'uiScale',
  'gameScale',
  'scaleAuto',
  'pixelRatioCap',
  'lowQuality',
  'reduceMotion',
  'fullscreen',
  'edgeScrollSpeed',
  'keyScrollSpeed',
  'showUnitPaths',
  'targetLines',
  'playerStanceColors',
  'mouseCapture',
  'mouseCaptureSpeed',
  'mouseCaptureRaw',
  'mouseCaptureEscMenu',
  'errorReports',
]);

/** The "?" beside the titles of the Game info and Surrender pages (js/help.js). */
export const MENU_PAGE_HELP_KEYS = Object.freeze(['menu.gameInfo', 'menu.surrender']);

/** The notes under the Controls page's list (js/help.js `controls.<key>`). */
export const CONTROLS_HELP_KEYS = Object.freeze(['keys', 'focus', 'selection']);

/** The "?" of setting `key` beside the row's label, describing `control`. */
const withHelp = (row, key, control) => labelWithHelp(row, `settings.${key}`, control);

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
    ['Radar: right click', 'Order the selected units there; otherwise move the camera'],
    ['Radar: drag', 'Move the camera'],
    ['Mouse wheel', 'Zoom'],
    ['Screen edges', 'Scroll the map'],
    [`${ctrl} + drag`, 'Lay a minefield (Minelayers selected)'],
    ['Shift + production key', 'Build 5 (production slots, numpad)'],
  ];
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

/** Text for a scale setting: "Auto (85%)" or "110%". */
export function scaleLabel(setting, resolved) {
  return setting === 'auto' ? `Auto (${percent(resolved)})` : percent(resolved);
}

/** What the Display section says about the three ways the picture changes. */
export const DISPLAY_HELP =
  'UI scale sizes the sidebar, bars, menus and dialogs. Game scale sizes units and terrain; the mouse wheel and pinch zoom from there, and the next game starts at the zoom you last used. ' +
  'Max resolution and low quality set how many pixels the battlefield is drawn with: sharpness and speed, not size.';

/**
 * Game menu settings that the Defaults button puts back (the Audio section's
 * are added). The remembered zoom (zoomFactor) has no row of its own: Defaults
 * clears it like Reset zoom does, and the battlefield follows.
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
  'mouseCapture',
  'mouseCaptureSpeed',
  'mouseCaptureRaw',
  'mouseCaptureEscMenu',
]);

/** What the Mouse capture section says. */
export const MOUSE_CAPTURE_HELP =
  'Keeps the pointer inside the game, so it cannot slip onto another screen. The game draws its own cursor while the mouse is captured.';

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
   *   settings: { get(k: string): any, set(k: string, v: any): any, reset(k: string): any, subscribe(k: string, fn: Function): Function },
   *   fullscreen: { available(): boolean, active(): boolean, toggle(): Promise<{ ok: boolean, message?: string }> },
   *   mouseCapture?: { available(): boolean },  mouse capture (js/mouselock.js); its section shows where available
   *   onChange(open: boolean, paused: boolean): void,
   *   uiScale?: import('./scale.js').UiScale,  the page's UI scale (live preview while its slider moves)
   *   renderRatio?(): number,  the battlefield's render pixel ratio (game scale: Auto and sharp steps)
   *   win?: Window,  the window the scales are picked for (tests)
   *   audio?: import('./audio/index.js').AudioSystem,  the Audio section of Settings and the Music page
   *   onSound?(): void,
   *   onContent?(): void,  the Original content dialog (graphics, original sounds, texture packs)
   *   contentLabel?(): string,  its button's label (with the installed state)
   *   onReleaseNotes?(): void,
   *   restart?: { replay?: boolean, online?: boolean, available?(): boolean, label?(): string, text?(): string, run(): void },
   *     Restart (asks first); online the rematch (js/online.js): shown while `available()`, with its own label and text
   *   onStats?(): void,  the statistics screen (js/stats.js)
   *   statsAvailable?(): boolean,  whether Statistics shows now (not for a player still in the game)
   *   gameInfo?(): { title: string, objectives: object | null, briefing: object | null, options: object },
   *     what the Game info page shows now (js/gameinfo.js models)
   *   surrender?: { shown(): boolean, enabled(): boolean, run(): void },
   *     OpenRA's Surrender: shown in games with more than one person for a player of the game,
   *     enabled while its game is undecided; run() gives the order
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
    this.infoTab = 'objectives'; // the Game info page's open tab
    this.card = el('div', 'menu-card game-menu-card');
    this.card.setAttribute('role', 'dialog');
    this.card.setAttribute('aria-modal', 'true');
    this.card.setAttribute('aria-label', 'Game menu');
    root.replaceChildren(this.card);
    root.hidden = true;
    window.addEventListener('keydown', (e) => this.onKey(e), true);
    // Rebuild the open page when bindings or settings change elsewhere.
    opts.hotkeys.onChange(() => this.isOpen && this.view === 'controls' && this.render());
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

  /** Stop what the open page follows (the Audio section, the UI scale). */
  unmountPage() {
    for (const off of this.pageOffs ?? []) off();
    this.pageOffs = [];
    this.endScalePreview();
  }

  show(view) {
    this.view = view;
    this.capture = null;
    this.message = '';
    this.render();
  }

  onKey(e) {
    if (!this.isOpen) return;
    // A dialog opened from the menu (Sound, Original content, Release notes) handles its own keys: Esc closes it, not the menu.
    const t = e.target;
    if (t instanceof Element && !this.root.contains(t) && t.closest('[role="dialog"]')) return;
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
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      // An open help tip closes first.
      if (closeOpenTip()) return;
      if (this.view === 'main') this.close();
      else this.show('main');
      return;
    }
    const combo = comboFromEvent(e);
    const action = combo && this.opts.hotkeys.actionFor(combo);
    if (action && MENU_ACTIONS.has(action)) {
      e.stopImmediatePropagation();
      this.opts.hotkeys.handle(e);
      return;
    }
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
    const scroll = same ? (c.querySelector('.game-menu-scroll')?.scrollTop ?? 0) : 0;
    // A page drawn again (the Game info scores) keeps the focused control.
    const focusId = same && c.contains(document.activeElement) ? document.activeElement.id : '';
    this.rendered = this.view;
    this.unmountPage();
    c.replaceChildren();
    if (this.view === 'settings') this.renderSettings(c);
    else if (this.view === 'controls') this.renderControls(c);
    else if (this.view === 'music') this.renderMusic(c);
    else if (this.view === 'leave' || this.view === 'exit') this.renderConfirm(c, this.view);
    else if (this.view === 'restart') this.renderRestart(c);
    else if (this.view === 'surrender') this.renderSurrender(c);
    else if (this.view === 'info') this.renderInfo(c);
    else this.renderMain(c);
    if (this.message) {
      const m = el('p', 'hint game-menu-message', this.message);
      m.setAttribute('role', 'status');
      c.append(m);
    }
    const list = c.querySelector('.game-menu-scroll');
    if (list) list.scrollTop = scroll;
    if (focusId) c.querySelector(`#${focusId}`)?.focus({ preventScroll: true });
    if (!same || !c.contains(document.activeElement)) (c.querySelector('button.primary') ?? c.querySelector('button'))?.focus({ preventScroll: true });
  }

  renderMain(c) {
    const online = this.opts.online;
    const tagline = this.opts.replay
      ? 'Replay: it keeps playing while this menu is open (P pauses it).'
      : online
        ? 'Online game: it keeps running while this menu is open. Online games cannot be paused.'
        : 'The game is paused. Esc resumes.';
    c.append(el('h1', null, online ? 'Menu' : 'Paused'), el('p', 'tagline', tagline));
    const fs = this.opts.fullscreen;
    const actions = (this.opts.actions ?? []).map((a) => button(a.label, null, () => this.runAction(a)));
    const stats = this.opts.onStats && (this.opts.statsAvailable?.() ?? true);
    c.append(
      button('Resume', 'primary', () => this.close()),
      ...(this.opts.gameInfo ? [button('Game info', null, () => this.show('info'))] : []),
      ...(stats ? [button('Statistics', null, () => this.opts.onStats())] : []),
      ...actions,
      button('Settings', null, () => this.show('settings')),
      ...(this.opts.onSound ? [button('Sound', null, () => this.opts.onSound())] : []),
      ...(this.opts.audio ? [button('Music', null, () => this.show('music'))] : []),
      ...(this.opts.onContent ? [button(this.opts.contentLabel?.() ?? 'Original content', null, () => this.opts.onContent())] : []),
      button('Controls and hotkeys', null, () => this.show('controls')),
      button(fs.active() ? 'Leave fullscreen' : 'Fullscreen', null, () => this.toggleFullscreen()),
      ...(this.opts.onReleaseNotes ? [button('Release notes', null, () => this.opts.onReleaseNotes())] : []),
      ...this.surrenderButton(),
      ...(this.restartShown() ? [button(this.restartLabel(), null, () => this.show('restart'))] : []),
      button(online && !this.opts.replay ? 'Leave game' : 'Leave to lobby', null, () => this.show('leave')),
      button('Exit', null, () => this.show('exit')),
    );
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
    c.append(
      el('h1', null, kind === 'exit' ? 'Exit' : 'Leave'),
      el('p', 'tagline', `${what} ${note}`),
      button(kind === 'exit' ? 'Exit' : 'Leave', 'primary', () => (kind === 'exit' ? this.opts.onExit() : this.opts.onLeave())),
      button('Back', null, () => this.show('main')),
    );
  }

  /** OpenRA IngameMenuLogic.CreateSurrenderButton: shown for a player of a game with more than one person, disabled once its game is decided. */
  surrenderButton() {
    const s = this.opts.surrender;
    if (!s?.shown()) return [];
    const b = button('Surrender', null, () => this.show('surrender'));
    b.disabled = !s.enabled();
    return [b];
  }

  /** The surrender dialog (dialog-surrender): the player loses at once and may stay to watch. */
  renderSurrender(c) {
    const title = el('h1', null, 'Surrender');
    title.append(infoTip('menu.surrender', { label: 'Surrender' }).root);
    c.append(
      title,
      el('p', 'tagline', 'Are you sure you want to surrender? You lose at once; you can stay and watch the rest of the game.'),
      button('Surrender', 'primary', () => {
        const s = this.opts.surrender;
        this.close();
        if (s?.enabled()) s.run();
      }),
      button('Stay', null, () => this.show('main')),
    );
  }

  /** Game info (OpenRA GAME_INFO_PANEL): the tabs, drawn again every second while open (scores). */
  renderInfo(c) {
    const view = this.opts.gameInfo?.();
    if (!view) {
      this.view = 'main';
      this.renderMain(c);
      return;
    }
    this.infoTab = renderGameInfo(c, view, this.infoTab, (id, focus) => {
      this.infoTab = id;
      this.render();
      if (focus) c.querySelector(`#game-info-tab-${id}`)?.focus({ preventScroll: true });
    });
    c.querySelector('h1')?.append(infoTip('menu.gameInfo', { label: 'Game info' }).root);
    c.append(button('Back', 'primary', () => this.show('main')));
    const timer = setInterval(() => {
      // Not while its help tip is open: drawing again would close it.
      if (this.isOpen && this.view === 'info' && !openTip()) this.render();
    }, GAME_INFO_REFRESH_MS);
    timer.unref?.();
    this.pageOffs.push(() => clearInterval(timer));
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
    if (this.opts.restart?.online) {
      const label = this.restartLabel();
      c.append(
        el('h1', null, 'Rematch'),
        el('p', 'tagline', this.opts.restart.text?.() ?? ''),
        button(label, 'primary', () => {
          this.close();
          this.opts.restart.run();
        }),
        button('Back', null, () => this.show('main')),
      );
      return;
    }
    const replay = !!this.opts.restart?.replay;
    c.append(
      el('h1', null, 'Restart'),
      el(
        'p',
        'tagline',
        replay
          ? 'Play this replay again from the start?'
          : 'Restart this game from the beginning with exactly the same settings? Everything played so far is lost (save it first to keep it).',
      ),
      button(replay ? 'Restart replay' : 'Restart', 'primary', () => {
        this.close();
        this.opts.restart.run();
      }),
      button('Back', null, () => this.show('main')),
    );
  }

  /** The music player (OpenRA's in-game Music panel). */
  renderMusic(c) {
    c.append(el('h1', null, 'Music'));
    const list = el('div', 'game-menu-scroll game-menu-music');
    const player = mountMusicPlayer(list, this.opts.audio, { idPrefix: 'menu-music', heading: 2, onContent: this.opts.onContent });
    this.pageOffs.push(() => player.dispose());
    c.append(list, button('Back', 'primary', () => this.show('main')));
  }

  renderSettings(c) {
    const s = this.opts.settings;
    c.append(el('h1', null, 'Settings'));
    const list = el('div', 'game-menu-scroll');
    const slider = (key, text) => {
      const spec = SCHEMA[key];
      const control = createSlider({
        id: `game-menu-${key}`,
        label: text,
        min: spec.min,
        max: spec.max,
        step: 0.25,
        value: s.get(key),
        format: speedLabel,
        rowClass: 'game-menu-row',
        onInput: (v) => {
          control.output.textContent = speedLabel(s.set(key, v));
        },
      });
      return withHelp(control.row, key, control.input);
    };
    const check = (key, text) => {
      const t = createToggle({ id: `game-menu-${key}`, label: text, checked: !!s.get(key), rowClass: 'game-menu-row', onChange: (on) => s.set(key, on) });
      return withHelp(t.row, key, t.input);
    };
    const choice = (key, text, labels, hint) => {
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
    };

    // ---- Display ----
    list.append(el('h2', null, 'Display'), el('p', 'hint game-menu-explain', DISPLAY_HELP));
    list.append(this.uiScaleRow(), this.gameScaleRow());
    list.append(slider('pixelRatioCap', 'Max resolution (pixel ratio)'), check('lowQuality', 'Low quality (faster on phones)'));
    // Camera shake and the nuke's flash (js/battlefx.js).
    const motion = choice('reduceMotion', 'Reduce motion', SCHEMA.reduceMotion.labels);
    list.append(withHelp(motion, 'reduceMotion', motion.querySelector('[role="radiogroup"]')));
    const fs = this.opts.fullscreen;
    const fsRow = el('div', 'game-menu-row');
    const fsButton = button(fs.active() ? 'Leave fullscreen' : 'Fullscreen', 'game-menu-mini', () => this.toggleFullscreen());
    fsButton.disabled = !fs.available();
    fsRow.append(el('span', 'ui-label', `Fullscreen (${formatCombo('Alt+Enter')})`), fsButton);
    withHelp(fsRow, 'fullscreen', fsButton);
    list.append(fsRow);
    if (!fs.available()) list.append(el('p', 'hint', 'Fullscreen is not available in this browser or page.'));

    // ---- Scrolling and units ----
    const targetLines = choice('targetLines', 'Target lines', SCHEMA.targetLines.labels);
    list.append(
      el('h2', null, 'Scrolling and units'),
      slider('edgeScrollSpeed', 'Edge scroll speed'),
      slider('keyScrollSpeed', 'Keyboard scroll speed'),
      check('showUnitPaths', 'Show unit paths'),
      withHelp(targetLines, 'targetLines', targetLines.querySelector('[role="radiogroup"]')),
      choice('healthBars', 'Always show health bars', { off: 'Off', damaged: 'Damaged', all: 'All' }, 'Off shows them only for selected and hovered units. Damaged and All cover units and buildings.'),
      check('playerStanceColors', 'Relationship colours'),
    );

    // ---- Mouse capture (js/mouselock.js; not without Pointer Lock or a mouse) ----
    if (this.opts.mouseCapture?.available()) {
      const keys = this.opts.hotkeys.bindingsFor('toggleMouseCapture');
      const release = keys.length ? `${formatCombo(keys[0])} or Esc` : 'Esc';
      const mode = choice('mouseCapture', 'Capture the mouse', { off: 'Off', fullscreen: 'In fullscreen', always: 'Always' }, `${release} releases it; a click into the game captures it again.`);
      list.append(
        el('h2', null, 'Mouse capture'),
        el('p', 'hint game-menu-explain', MOUSE_CAPTURE_HELP),
        withHelp(mode, 'mouseCapture', mode.querySelector('[role="radiogroup"]')),
        slider('mouseCaptureSpeed', 'Captured mouse speed'),
        check('mouseCaptureRaw', 'Raw mouse input'),
        check('mouseCaptureEscMenu', 'Esc also opens the menu'),
      );
    }

    // ---- Audio (the Sound dialog's controls) ----
    const audio = this.opts.audio;
    if (audio) {
      const box = el('div', 'game-menu-audio');
      list.append(el('h2', null, 'Audio'), box);
      const mount = mountAudioSettings(box, audio, { onContent: this.opts.onContent, onMusicPlayer: () => this.show('music'), idPrefix: 'menu-audio', heading: 3, help: true });
      this.pageOffs.push(() => mount.dispose());
    } else {
      list.append(el('h2', null, 'Audio'), el('p', 'hint', 'Sound is unavailable in this browser.'));
    }

    // ---- Privacy (js/telemetry: error reports). Not reset by Defaults: switching reports back on is the player's call. ----
    // The switch is kept even when this build reports nothing (it is synced and applies once reports are turned on).
    list.append(el('h2', null, 'Privacy'), check('errorReports', 'Send error reports'));
    if (!reportsConfigured()) list.append(el('p', 'hint', 'Error reporting is off on this site: nothing is sent, whatever this switch says.'));

    c.append(
      list,
      button('Defaults', null, () => {
        for (const key of MENU_SETTINGS) s.reset(key);
        audio?.prefs.set(DEFAULT_PREFS);
        this.render();
      }),
      button('Back', 'primary', () => this.show('main')),
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

  renderControls(c) {
    const reg = this.opts.hotkeys;
    c.append(el('h1', null, 'Controls'));
    c.append(el('p', 'hint', 'Change a hotkey, then press the new key (Esc cancels). Settings are saved in this browser.'));
    const list = el('div', 'game-menu-scroll');
    const groups = new Map();
    for (const a of reg.list()) {
      if (!groups.has(a.group)) groups.set(a.group, []);
      groups.get(a.group).push(a);
    }
    // Sections in the order of OpenRA's hotkey settings, then any others.
    const order = (g) => (GROUP_ORDER.includes(g) ? GROUP_ORDER.indexOf(g) : GROUP_ORDER.length);
    for (const [group, actions] of [...groups].sort((x, y) => order(x[0]) - order(y[0]))) {
      list.append(el('h2', null, group));
      const table = el('div', 'game-menu-keys');
      for (const a of actions) {
        const row = el('div', 'game-menu-key-row');
        const waiting = this.capture === a.name;
        const keys = el('span', 'game-menu-keycap', waiting ? 'Press a key...' : a.keys.length ? a.keys.map((k) => formatCombo(k)).join(' / ') : 'Unbound');
        const changed = JSON.stringify(a.keys) !== JSON.stringify(a.defaults);
        const label = el('span', 'game-menu-key-label', a.label);
        // Where WebRA's default differs from OpenRA's: the browser keeps OpenRA's key.
        const sub = a.openra && BROWSER_SUBSTITUTES[a.openra];
        if (sub && OPENRA_HOTKEYS[a.openra]?.key) label.title = `OpenRA: ${formatCombo(OPENRA_HOTKEYS[a.openra].key)} (${sub.why}).`;
        if (a.context === 'chat-input') label.append(el('span', 'hint', ' (in the chat line)'));
        row.append(label, keys);
        if (a.readonly) {
          row.classList.add('game-menu-fixed');
        } else {
          row.append(
            button('Change', 'game-menu-mini', () => {
              this.capture = a.name;
              this.message = '';
              this.render();
            }),
            button('Clear', 'game-menu-mini', () => reg.unbind(a.name)),
          );
          const resetBtn = button('Reset', 'game-menu-mini', () => reg.reset(a.name));
          resetBtn.disabled = !changed;
          row.append(resetBtn);
        }
        table.append(row);
      }
      list.append(table);
    }
    list.append(el('h2', null, 'Fixed controls'));
    const fixed = el('div', 'game-menu-keys');
    for (const [keys, what] of fixedControls()) {
      const row = el('div', 'game-menu-key-row game-menu-fixed');
      row.append(el('span', 'game-menu-key-label', what), el('span', 'game-menu-keycap', keys));
      fixed.append(row);
    }
    list.append(fixed);
    list.append(el('h2', null, 'Touch'));
    const touch = el('div', 'game-menu-keys');
    for (const [gesture, what] of touchControls()) {
      const row = el('div', 'game-menu-key-row game-menu-fixed');
      row.append(el('span', 'game-menu-key-label', what), el('span', 'game-menu-keycap', gesture));
      touch.append(row);
    }
    list.append(touch);
    for (const key of CONTROLS_HELP_KEYS) list.append(el('p', 'hint', helpText(`controls.${key}`)));
    c.append(list, button('Reset all hotkeys', null, () => reg.reset()), button('Back', 'primary', () => this.show('main')));
  }
}

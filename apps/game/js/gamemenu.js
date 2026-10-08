// In-game menu (Esc): Resume, Settings, Controls (hotkeys, rebindable),
// Fullscreen, Leave to lobby, Exit, plus the game's record actions (save the
// game, download the replay; js/records.js).
//
// Single player and skirmish pause while the menu is open. Online lockstep
// games cannot pause (docs/contracts.md: the server drops a player who holds
// the game up), so the menu opens without pausing and says so.
//
// While the menu is open it takes every keydown in the capture phase, so no
// game hotkey fires; default actions (Tab between buttons, arrow keys on a
// slider) still work.

import { comboFromEvent, formatCombo, isMac } from './hotkeys.js';
import { SCHEMA } from './settings.js';

/** Controls that are not in the hotkey registry (fixed keys and the mouse). */
export function fixedControls(mac = isMac()) {
  const ctrl = mac ? 'Cmd (or Ctrl)' : 'Ctrl';
  return [
    ['Esc', 'Cancel placement, targeting, sell or attack move; otherwise open this menu'],
    ['Left click', 'Select, or give the order shown by the cursor'],
    ['Left drag', 'Box select'],
    ['Shift + click / drag', 'Add to or remove from the selection'],
    ['Double click', 'Select all units of that type on screen'],
    [`${ctrl} + double click`, 'Select all units of that type on the map'],
    ['Right click', 'Cancel the current mode, or clear the selection'],
    ['Middle drag', 'Pan the map'],
    ['Mouse wheel', 'Zoom'],
    ['Arrow keys, screen edges', 'Scroll the map'],
    [`${ctrl} + 1..9, 0`, 'Store the selected units as a control group'],
    ['1..9, 0', 'Select a control group (press twice: centre the camera on it)'],
    ['Shift + 1..9, 0', 'Add a control group to the selection'],
    [`${ctrl} + drag`, 'Lay a minefield (Minelayers selected)'],
    ['Numpad 1..9', 'Build the n-th item of the sidebar tab (Shift: 5, Ctrl: cancel one)'],
    ['Numpad + / 0 / -', 'Next / previous sidebar tab'],
    ['Numpad .', 'Cancel building placement'],
    ['Enter', 'Chat (online games)'],
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

// Actions that still run while the menu is open (they close it or are harmless).
const MENU_ACTIONS = new Set(['menu', 'pause', 'fullscreen']);

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
   *   onChange(open: boolean, paused: boolean): void,
   *   onSound?(): void,
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
    else if (this.root.contains(document.activeElement)) document.activeElement.blur();
    this.opts.onChange(open, paused);
  }

  show(view) {
    this.view = view;
    this.capture = null;
    this.message = '';
    this.render();
  }

  onKey(e) {
    if (!this.isOpen) return;
    // A dialog opened from the menu (Sound) handles its own keys: Esc closes it, not the menu.
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
    this.rendered = this.view;
    c.replaceChildren();
    if (this.view === 'settings') this.renderSettings(c);
    else if (this.view === 'controls') this.renderControls(c);
    else if (this.view === 'leave' || this.view === 'exit') this.renderConfirm(c, this.view);
    else this.renderMain(c);
    if (this.message) {
      const m = el('p', 'hint game-menu-message', this.message);
      m.setAttribute('role', 'status');
      c.append(m);
    }
    const list = c.querySelector('.game-menu-scroll');
    if (list) list.scrollTop = scroll;
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
    c.append(
      button('Resume', 'primary', () => this.close()),
      ...actions,
      button('Settings', null, () => this.show('settings')),
      ...(this.opts.onSound ? [button('Sound', null, () => this.opts.onSound())] : []),
      button('Controls and hotkeys', null, () => this.show('controls')),
      button(fs.active() ? 'Leave fullscreen' : 'Fullscreen', null, () => this.toggleFullscreen()),
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

  renderSettings(c) {
    const s = this.opts.settings;
    c.append(el('h1', null, 'Settings'));
    const slider = (key, text) => {
      const spec = SCHEMA[key];
      const row = el('label', 'game-menu-row');
      const name = el('span', null, text);
      const input = el('input', 'game-menu-range');
      input.type = 'range';
      input.min = String(spec.min);
      input.max = String(spec.max);
      input.step = '0.25';
      input.value = String(s.get(key));
      const out = el('output', 'game-menu-value', speedLabel(s.get(key)));
      input.addEventListener('input', () => {
        const v = s.set(key, Number(input.value));
        out.textContent = speedLabel(v);
      });
      row.append(name, input, out);
      return row;
    };
    const check = (key, text) => {
      const row = el('label', 'game-menu-row');
      const input = el('input', 'game-menu-check');
      input.type = 'checkbox';
      input.checked = !!s.get(key);
      input.addEventListener('change', () => s.set(key, input.checked));
      row.append(el('span', null, text), input);
      return row;
    };
    c.append(
      slider('edgeScrollSpeed', 'Edge scroll speed'),
      slider('keyScrollSpeed', 'Keyboard scroll speed'),
      check('showUnitPaths', 'Show unit paths'),
    );
    const fs = this.opts.fullscreen;
    const fsRow = el('div', 'game-menu-row');
    const fsButton = button(fs.active() ? 'Leave fullscreen' : 'Fullscreen', 'game-menu-mini', () => this.toggleFullscreen());
    fsButton.disabled = !fs.available();
    fsRow.append(el('span', null, `Fullscreen (${formatCombo('Alt+Enter')})`), fsButton);
    c.append(fsRow);
    if (!fs.available()) c.append(el('p', 'hint', 'Fullscreen is not available in this browser or page.'));
    c.append(
      button('Defaults', null, () => {
        for (const key of ['edgeScrollSpeed', 'keyScrollSpeed', 'showUnitPaths']) s.reset(key);
        this.render();
      }),
      button('Back', 'primary', () => this.show('main')),
    );
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
    for (const [group, actions] of groups) {
      list.append(el('h2', null, group));
      const table = el('div', 'game-menu-keys');
      for (const a of actions) {
        const row = el('div', 'game-menu-key-row');
        const waiting = this.capture === a.name;
        const keys = el('span', 'game-menu-keycap', waiting ? 'Press a key...' : a.keys.length ? a.keys.map((k) => formatCombo(k)).join(' / ') : 'Unbound');
        const changed = JSON.stringify(a.keys) !== JSON.stringify(a.defaults);
        row.append(
          el('span', 'game-menu-key-label', a.label),
          keys,
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
    list.append(
      el(
        'p',
        'hint',
        'Some browsers keep Ctrl/Cmd + number for switching tabs. WebRA holds those keys back while the game has focus where the browser allows it; in fullscreen (Chrome, Edge) the digit row and Esc are locked to the game. On macOS, Ctrl + number works as well as Cmd + number.',
      ),
    );
    c.append(list, button('Reset all hotkeys', null, () => reg.reset()), button('Back', 'primary', () => this.show('main')));
  }
}

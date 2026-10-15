// The in-game chat panel of every game (skirmish, missions, online games,
// spectators and replays), after OpenRA's ingame-chat.yaml and
// IngameChatLogic:
//
// - CHAT_OVERLAY: the newest lines (TextNotificationsDisplayWidget, at most
//   OVERLAY_LINES) over the battlefield while the chat is closed; each leaves
//   after OVERLAY_MS (DisplayDurationMs 10000). WebRA's connection lines
//   (`important`) stay until newer lines push them out.
// - CHAT_CHROME: opened with the chat keys (OpenTeamChat Enter,
//   OpenGeneralChat Shift+Enter, js/chatkeys.js): CHAT_SCROLLPANEL with
//   every line of the game (scrollback), the mode button (Team / All), the
//   chat line and the close button. Where nobody can be talked to (single
//   player, replays) the line is disabled and Enter or Esc closes the panel,
//   like OpenRA's KEY_LISTENER. Esc closes the open panel wherever the focus
//   is (after a click on the battlefield too), before it can cancel a mode
//   or open the game menu.
// - Each new line plays ChatLine (ChromeMetrics ChatLineSound) unless it is
//   muted chat or replay chat hidden by "Hide chat in replays".
// - The mute toggles of the other people in the game (OpenRA's MUTE
//   checkboxes of the game info panel) sit at the top of the open panel.
//
// The model is js/chatlog.js; this is its view.

import { CHAT_HOTKEYS, chatMode, completeName } from './chatkeys.js';
import { CommandHistory, formatLineTime, OVERLAY_LINES, OVERLAY_MS } from './chatlog.js';

/** UnitOrders.ChatMessageMaxLength is 2500; the online protocol's CHAT_MAX is lower and wins there. */
const DEFAULT_MAX_LENGTH = 2500;

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * A line as OpenRA's CHAT_LINE_TEMPLATE / SYSTEM_LINE_TEMPLATE lays it out:
 * TIME (scrollback only), "PREFIX:" in its colour, then TEXT.
 */
export function lineElement(line, { withTime = false } = {}) {
  const row = el('div', `chat-line chat-${line.pool}`);
  row.dataset.client = String(line.clientId);
  if (withTime) row.append(el('span', 'chat-time', formatLineTime(line.time)));
  if (line.prefix) {
    const prefix = el('span', 'chat-prefix', `${line.prefix}:`);
    if (line.prefixColor) prefix.style.color = line.prefixColor;
    row.append(prefix);
  }
  const text = el('span', 'chat-text', line.text);
  if (line.textColor) text.style.color = line.textColor;
  row.append(text);
  return row;
}

export class ChatPanel {
  /**
   * @param {HTMLElement} parent the battlefield (#field)
   * @param {object} o
   * @param {import('./chatlog.js').TextLog} o.log the game's lines
   * @param {{ registerAction: Function } | null} [o.hotkeys] the hotkey registry (the chat keys)
   * @param {((text: string, team: boolean) => void) | null} [o.send] send a line; null: nobody to talk to
   * @param {boolean} [o.teamChat] whether team chat reaches anyone (js/chatkeys.js hasTeamChat)
   * @param {boolean} [o.spectator] the viewer is a spectator (team chat says "Spectators")
   * @param {string[]} [o.names] player names for Tab completion
   * @param {() => { client: number, name: string }[]} [o.mutable] the other people whose chat can be muted
   * @param {() => void} [o.sound] OpenRA's ChatLine notification
   * @param {boolean} [o.withTime] the TIME label in the scrollback (not in replays, like OpenRA)
   * @param {() => number} [o.now] wall clock in ms
   * @param {boolean} [o.autoPrune] expire overlay lines on a timer (tests call prune)
   * @param {number} [o.maxLength] longest line
   * @param {EventTarget | null} [o.win] where Esc is caught first (capture phase): the window
   */
  constructor(parent, { log, hotkeys = null, send = null, teamChat = false, spectator = false, names = [], mutable = () => [], sound = () => {}, withTime = true, now = () => Date.now(), autoPrune = true, maxLength = DEFAULT_MAX_LENGTH, win = globalThis.window ?? null }) {
    Object.assign(this, { log, send, teamChat, spectator, names, mutable, sound, withTime, now });
    this.history = new CommandHistory();
    this.mode = 'all';
    this.completion = null;
    /** @type {{ line: object, el: HTMLElement }[]} overlay lines, oldest first */
    this.overlayLines = [];

    this.root = el('div', 'chat-panel');
    this.root.id = 'chat';
    // Online games put their waiting, save and rematch lines here (js/online.js).
    this.extras = el('div', 'chat-extras');
    this.overlay = el('div', 'chat-overlay');
    this.overlay.setAttribute('aria-live', 'polite');
    this.overlay.setAttribute('aria-label', 'Chat and messages');

    this.chrome = el('div', 'chat-chrome');
    this.chrome.hidden = true;
    this.muteBar = el('div', 'chat-mute');
    this.muteBar.hidden = true;
    this.scroll = el('div', 'chat-history');
    this.scroll.setAttribute('role', 'log');
    this.scroll.setAttribute('aria-label', 'Chat history');
    this.scroll.tabIndex = -1;
    const row = el('div', 'chat-input-row');
    this.modeButton = el('button', 'chat-mode');
    this.modeButton.type = 'button';
    this.modeButton.title = 'Toggle chat mode';
    this.modeButton.addEventListener('click', () => {
      this.toggleMode();
      this.focusLine();
    });
    this.input = el('input', 'chat-input online-input');
    this.input.type = 'text';
    this.input.maxLength = maxLength;
    this.input.disabled = !send;
    this.input.setAttribute('aria-label', 'Chat');
    this.closeButton = el('button', 'chat-close', '×');
    this.closeButton.type = 'button';
    this.closeButton.setAttribute('aria-label', 'Close chat');
    this.closeButton.addEventListener('click', () => this.close());
    row.append(this.modeButton, this.input, this.closeButton);
    this.chrome.append(this.muteBar, this.scroll, row);
    this.root.append(this.extras, this.overlay, this.chrome);
    parent.append(this.root);

    this.input.addEventListener('keydown', (e) => this.onInputKey(e));
    // OpenRA's KEY_LISTENER: while the panel is open, Esc closes it wherever
    // the focus is, before the game's keys (input.js: cancel a mode, open the
    // menu); with the line off, Enter closes it too. The chat line handles
    // its own keys (onInputKey).
    this.onWindowKey = (e) => {
      if (!this.isOpen || e.target === this.input || e.ctrlKey || e.altKey || e.metaKey) return;
      // A select list, stepper or tab row (js/ui/controls.js) keeps its keys: Esc closes the list, not the chat.
      if (e.target?.closest?.('[role="listbox"], [role="spinbutton"], [role="tablist"], .ui-sp-panel')) return;
      if (e.key === 'Escape' || (e.key === 'Enter' && !e.shiftKey && this.input.disabled)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        this.close();
      }
    };
    this.win = win;
    this.win?.addEventListener('keydown', this.onWindowKey, true);
    this.setMode('all');

    // Lines from before the panel existed (an online game's first lines):
    // all in the scrollback, the recent ones on the overlay too.
    for (const line of log.lines) {
      this.appendHistory(line);
      if (!line.quiet && (line.important || this.now() - line.time < OVERLAY_MS)) this.addOverlay(line);
    }
    this.offLine = log.onLine((line) => this.onLine(line));
    this.offMute = log.onMute(() => this.renderMutes());

    if (hotkeys) {
      const handlers = { openTeamChat: () => this.open(true), openGeneralChat: () => this.open(false) };
      this.unregister = CHAT_HOTKEYS.map((h) =>
        hotkeys.registerAction(h.name, undefined, handlers[h.name] ?? (() => {}), { openra: h.openra, inControls: false, listOnly: h.listOnly }),
      );
    }
    if (autoPrune) {
      this.timer = setInterval(() => this.prune(), 250);
      this.timer.unref?.();
    }
  }

  get isOpen() {
    return !this.chrome.hidden;
  }

  // ---- Lines -----------------------------------------------------------------------

  onLine(line) {
    this.appendHistory(line);
    // IngameChatLogic.Handle: muted replay chat stays off the overlay and silent.
    if (line.quiet) return;
    this.addOverlay(line);
    this.sound();
  }

  appendHistory(line) {
    const atBottom = this.scroll.scrollTop + this.scroll.clientHeight >= this.scroll.scrollHeight - 4;
    this.scroll.append(lineElement(line, { withTime: this.withTime }));
    const rows = this.scroll.children;
    if (rows.length > this.log.lines.length) rows[0].remove();
    if (atBottom || !this.isOpen) this.scroll.scrollTop = this.scroll.scrollHeight;
  }

  addOverlay(line) {
    const node = lineElement(line);
    this.overlay.append(node);
    this.overlayLines.push({ line, el: node, until: line.important ? Infinity : line.time + OVERLAY_MS });
    while (this.overlayLines.length > OVERLAY_LINES) this.overlayLines.shift().el.remove();
  }

  /** Drop overlay lines older than OVERLAY_MS (TextNotificationsDisplayWidget.Tick). */
  prune(now = this.now()) {
    const keep = [];
    for (const o of this.overlayLines) {
      if (now >= o.until) o.el.remove();
      else keep.push(o);
    }
    this.overlayLines = keep;
  }

  // ---- Open, close, send -------------------------------------------------------------

  /** OpenChat: the scrollback and the chat line; `wantTeam`: team chat when there is a team. */
  open(wantTeam = false) {
    if (this.isOpen) return;
    this.setMode(chatMode(wantTeam, this.teamChat));
    this.input.value = '';
    this.history.reset();
    this.completion = null;
    this.renderMutes();
    this.chrome.hidden = false;
    this.overlay.hidden = true;
    this.scroll.scrollTop = this.scroll.scrollHeight;
    this.focusLine();
  }

  /** CloseChat: back to the overlay. */
  close() {
    if (!this.isOpen) return;
    this.input.value = '';
    this.chrome.hidden = true;
    this.overlay.hidden = false;
    this.input.blur();
    this.scroll.blur();
    this.history.reset();
  }

  focusLine() {
    if (this.input.disabled) this.scroll.focus();
    else this.input.focus();
  }

  setMode(mode) {
    this.mode = mode;
    const team = mode === 'team';
    this.modeButton.textContent = team ? 'Team' : 'All';
    this.modeButton.disabled = !this.teamChat || !this.send;
    this.input.placeholder = !this.send
      ? 'Chat history. Enter or Esc closes'
      : `${team ? (this.spectator ? 'Spectators' : 'Team') : 'All'}: Enter sends, Shift+Tab switches, Esc closes`;
    this.input.setAttribute('aria-label', !this.send ? 'Chat (not available here)' : team ? 'Team chat' : 'Chat to all');
  }

  /**
   * Who team chat reaches now (OpenRA IngameChatLogic chatMode.IsDisabled):
   * a defeated player talks to the spectators, nobody has team chat once the
   * game is over. Team mode falls back to all chat when it is gone.
   */
  setTeamChat(teamChat, spectator) {
    if (this.teamChat === !!teamChat && this.spectator === !!spectator) return;
    this.teamChat = !!teamChat;
    this.spectator = !!spectator;
    this.setMode(this.mode === 'team' && this.teamChat ? 'team' : 'all');
  }

  /** OpenRA ToggleChatMode: only when there is a team to talk to. */
  toggleMode() {
    if (this.teamChat && this.send) this.setMode(this.mode === 'team' ? 'all' : 'team');
  }

  onInputKey(e) {
    e.stopPropagation();
    if (e.key === 'Escape') {
      this.close();
    } else if (e.key === 'Enter') {
      const text = this.input.value.trim();
      if (text && this.send) {
        this.send(text, this.mode === 'team');
        this.history.add(text);
      }
      this.history.reset();
      this.close();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      if (e.shiftKey) {
        this.toggleMode();
        return;
      }
      // OpenRA Autocomplete: player names.
      const r = completeName(this.input.value, this.names, this.completion);
      if (r) {
        this.completion = r.state;
        this.input.value = r.text;
      }
      return;
    } else if (e.key === 'ArrowUp') {
      const prev = this.history.previous();
      if (prev !== null) {
        e.preventDefault();
        this.input.value = prev;
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = this.history.next();
      this.input.value = next ?? '';
      if (next === null) this.history.reset();
    }
    this.completion = null;
  }

  // ---- Mute ---------------------------------------------------------------------------

  /** The mute toggles of the other people (GameInfoStatsLogic MUTE). */
  renderMutes() {
    const people = this.mutable() ?? [];
    this.muteBar.hidden = people.length === 0;
    if (!people.length) {
      this.muteBar.replaceChildren();
      return;
    }
    const buttons = people.map(({ client, name }) => {
      const muted = this.log.isMuted(client);
      const b = el('button', 'chat-mute-button', muted ? `Unmute ${name}` : `Mute ${name}`);
      b.type = 'button';
      b.dataset.client = String(client);
      b.setAttribute('aria-pressed', String(muted));
      b.title = muted ? 'Unmute this player' : 'Mute this player';
      b.addEventListener('click', () => {
        this.log.toggleMuted(client);
        this.focusLine();
      });
      return b;
    });
    this.muteBar.replaceChildren(el('span', 'chat-mute-label', 'Chat from:'), ...buttons);
  }

  dispose() {
    clearInterval(this.timer);
    this.win?.removeEventListener('keydown', this.onWindowKey, true);
    this.offLine?.();
    this.offMute?.();
    for (const off of this.unregister ?? []) off();
    this.root.remove();
  }
}

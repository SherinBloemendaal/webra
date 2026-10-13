// The in-game text log of chat and system lines, after OpenRA's
// TextNotificationsManager and IngameChatLogic (no DOM here, so it is unit
// tested in tests/chatlog.test.mjs; js/chatpanel.js draws it):
//
// - every chat, system and mission line of the game is kept (the chat
//   panel's scrollback lists them all); system lines carry the "Battlefield
//   Control" prefix and are yellow, chat lines the sender's name in the
//   player's colour, with OpenRA's "[Team]", "[Spectators]", "(Ally)",
//   "(Dead)" and "(Spectator)" marks;
// - muted players (OpenRA TextNotificationsManager.MutedPlayers, the MUTE
//   checkbox of GameInfoStatsLogic): their new chat lines are dropped from
//   the overlay and the scrollback, and play no sound;
// - OpenRA's HideReplayChat setting: in a replay the players' chat lines
//   stay in the scrollback but leave the overlay and play no sound;
// - the chat line's history of sent lines for Up and Down (OpenRA
//   CommandHistory).
//
// The mute API (`TextLog` isMuted / setMuted / toggleMuted / onMute) is what
// the game info panel's player list hooks into (docs/contracts.md).

/** OpenRA TextNotificationsManager.SystemClientId. */
export const SYSTEM_CLIENT = -1;
/** OpenRA's SystemMessageLabel (ChromeMetrics), the prefix of system lines. */
export const SYSTEM_LABEL = 'Battlefield Control';
/** SYSTEM_LINE_TEMPLATE's TextColor FFFF00, for its prefix and text. */
export const SYSTEM_COLOR = '#ffff00';
/** CHAT_LINE_TEMPLATE's text colour (the label default). */
export const CHAT_TEXT_COLOR = '#ffffff';
/** CHAT_DISPLAY DisplayDurationMs (ingame-chat.yaml): overlay lines leave after it. */
export const OVERLAY_MS = 10_000;
/** TextNotificationsDisplayWidget LogLength: overlay lines at most. */
export const OVERLAY_LINES = 8;
/** CommandHistory MaxHistorySize. */
export const HISTORY_SIZE = 50;
/** Kept lines at most (OpenRA keeps all; this only bounds a very long game). */
export const LOG_LIMIT = 5000;

/** "HH:MM" of a line's local time (OpenRA SetupTextNotification's TIME label). */
export function formatLineTime(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * The prefix of a chat line, as OpenRA UnitOrders writes it for a Chat order.
 * All chat: the name, " (Dead)" for a defeated player, " (Spectator)" for a
 * spectator, then " (Ally)" for a team mate of the viewer. Team chat:
 * "[Spectators] name" among spectators, "[Team] name" (in a replay "[Team N]")
 * for a team.
 * @param {{ name: string, team?: boolean, spectator?: boolean, dead?: boolean,
 *   ally?: boolean, replay?: boolean, teamNumber?: number }} o
 */
export function chatPrefix({ name, team = false, spectator = false, dead = false, ally = false, replay = false, teamNumber = 0 }) {
  if (team) {
    if (spectator || dead) return `[Spectators] ${name}`;
    return `[Team${replay ? ` ${teamNumber}` : ''}] ${name}`;
  }
  let suffix = dead ? ' (Dead)' : '';
  if (spectator) suffix = ' (Spectator)';
  if (ally) suffix += ' (Ally)';
  return name + suffix;
}

/**
 * The game's chat and system lines.
 */
export class TextLog {
  /**
   * @param {{ now?: () => number, replay?: boolean, hideReplayChat?: () => boolean }} [o]
   *   `now`: wall clock in ms (the TIME label); `replay`: the game is a
   *   replay; `hideReplayChat`: OpenRA's HideReplayChat setting
   */
  constructor({ now = () => Date.now(), replay = false, hideReplayChat = () => false } = {}) {
    this.now = now;
    this.replay = replay;
    this.hideReplayChat = hideReplayChat;
    /** @type {object[]} every line, oldest first */
    this.lines = [];
    /** client id -> muted (OpenRA MutedPlayers). */
    this.muted = new Map();
    this.listeners = new Set();
    this.muteListeners = new Set();
    this.nextId = 1;
  }

  /**
   * Add a line. `pool`: 'chat', 'system' or 'mission' (OpenRA
   * TextNotificationPool); `clientId`: the sender (SYSTEM_CLIENT for system
   * lines); `important`: a WebRA connection line that stays on the overlay.
   * Returns the line, or null when its sender is muted.
   */
  add({ pool = 'system', clientId = SYSTEM_CLIENT, prefix = '', text, prefixColor = null, textColor = null, important = false }) {
    if (!text) return null;
    // IngameChatLogic.Handle: a muted player's lines are not shown at all.
    if (clientId !== SYSTEM_CLIENT && this.isMuted(clientId)) return null;
    const line = {
      id: this.nextId++,
      pool,
      clientId,
      prefix,
      text: String(text),
      prefixColor: prefixColor ?? (pool === 'system' ? SYSTEM_COLOR : null),
      textColor: textColor ?? (pool === 'system' ? SYSTEM_COLOR : CHAT_TEXT_COLOR),
      time: this.now(),
      important: !!important,
      // IsNotificationMuted: replay chat with HideReplayChat, kept in the scrollback only.
      quiet: this.replay && clientId !== SYSTEM_CLIENT && !!this.hideReplayChat(),
    };
    this.lines.push(line);
    if (this.lines.length > LOG_LIMIT) this.lines.splice(0, this.lines.length - LOG_LIMIT);
    for (const fn of [...this.listeners]) fn(line);
    return line;
  }

  /** A system line (OpenRA AddSystemLine): "Battlefield Control: text", or another prefix. */
  system(text, { prefix = SYSTEM_LABEL, important = false } = {}) {
    return this.add({ pool: 'system', prefix, text, important });
  }

  /** A mission line (OpenRA AddMissionLine): a script's speaker and its colour. */
  mission(prefix, text, prefixColor = null) {
    return this.add({ pool: 'mission', prefix, text, prefixColor });
  }

  /** A chat line of client `clientId` (OpenRA AddChatLine), prefix from chatPrefix, in the player's colour. */
  chat(clientId, prefix, text, color = null) {
    return this.add({ pool: 'chat', clientId, prefix, text, prefixColor: color });
  }

  /** Call `fn(line)` for every new line; returns the unsubscribe function. */
  onLine(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ---- Mute (OpenRA TextNotificationsManager.MutedPlayers) -----------------------

  isMuted(clientId) {
    return this.muted.get(clientId) === true;
  }

  setMuted(clientId, on) {
    if (clientId === SYSTEM_CLIENT || clientId === null || clientId === undefined) return;
    const was = this.isMuted(clientId);
    this.muted.set(clientId, !!on);
    if (was !== !!on) for (const fn of [...this.muteListeners]) fn(clientId, !!on);
  }

  /** The MUTE checkbox's OnClick: `MutedPlayers[client] ^= true`. Returns the new state. */
  toggleMuted(clientId) {
    this.setMuted(clientId, !this.isMuted(clientId));
    return this.isMuted(clientId);
  }

  /** Call `fn(clientId, muted)` when a player is muted or unmuted; returns the unsubscribe function. */
  onMute(fn) {
    this.muteListeners.add(fn);
    return () => this.muteListeners.delete(fn);
  }
}

/**
 * The chat line's history for Up and Down (OpenRA CommandHistory): newest
 * first, at most HISTORY_SIZE, a repeated entry moves to the front.
 */
export class CommandHistory {
  constructor(size = HISTORY_SIZE) {
    this.size = size;
    /** @type {string[]} newest first */
    this.history = [];
    this.index = -1;
  }

  add(command) {
    const text = String(command ?? '').trim();
    if (!text) return;
    this.history = this.history.filter((c) => c !== text);
    this.history.unshift(text);
    if (this.history.length > this.size) this.history.length = this.size;
    this.index = -1;
  }

  /** Up: the previous entry (stays at the oldest), or null without history. */
  previous() {
    if (this.history.length === 0) return null;
    if (this.index < this.history.length - 1) this.index++;
    return this.history[this.index];
  }

  /** Down: the next newer entry, or null past the newest (the line empties then). */
  next() {
    if (this.history.length === 0) return null;
    if (this.index > 0) {
      this.index--;
      return this.history[this.index];
    }
    if (this.index === 0) this.index = -1;
    return null;
  }

  reset() {
    this.index = -1;
  }
}

/**
 * The chat of an online game's replay (js/replay.js Recorder.noteChat:
 * `[tick, player, name, text, team]`, player -1 for a spectator), shown as
 * the replay passes each line's tick, with OpenRA's replay prefixes
 * ("[Team N] name", "[Spectators] name"). Lines skipped by seeking are not
 * shown, like the sounds and other events of a fast-forward.
 */
export class ReplayChat {
  /**
   * @param {Array<[number, number, string, string, number]>} lines the replay's chat
   * @param {TextLog} log where the lines go
   * @param {{ teamOf?: (player: number) => number, colorOf?: (player: number) => string | null, dead?: (player: number) => boolean }} [o]
   */
  constructor(lines, log, { teamOf = () => 0, colorOf = () => null, dead = () => false } = {}) {
    Object.assign(this, { lines: lines ?? [], log, teamOf, colorOf, dead });
    this.index = 0;
    this.ticks = 0;
  }

  /** The replay is at `ticks`; `seeking`: fast-forwarding or jumping (nothing is shown). */
  advance(ticks, seeking = false) {
    if (seeking || ticks < this.ticks) {
      this.index = this.lines.findIndex(([t]) => t > ticks);
      if (this.index < 0) this.index = this.lines.length;
      this.ticks = ticks;
      return;
    }
    this.ticks = ticks;
    while (this.index < this.lines.length && this.lines[this.index][0] <= ticks) {
      const [, player, name, text, team] = this.lines[this.index++];
      const spectator = player < 0;
      const prefix = chatPrefix({ name, team: !!team, spectator, dead: !spectator && this.dead(player), replay: true, teamNumber: spectator ? 0 : this.teamOf(player) });
      // Recorded lines have no client id: the player's seat stands in for the sender.
      this.log.chat(spectator ? `spectator:${name}` : `player:${player}`, prefix, text, spectator ? null : this.colorOf(player));
    }
  }
}

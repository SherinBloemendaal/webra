// In-game chat keys of online games (OpenRA's chat hotkeys, js/online.js):
// Enter opens team chat (OpenTeamChat), Shift+Enter all chat
// (OpenGeneralChat); in the chat line Shift+Tab switches between the two
// (ToggleChatMode) and Tab completes a player's name (Autocomplete). Team chat
// reaches the player's team (the server delivers it, apps/server/src/room.js
// chatTeamOf); spectators' team chat reaches the other spectators. Without a
// team mate, Enter opens all chat, like OpenRA.

/**
 * The chat hotkeys js/online.js registers: action name, OpenRA hotkey, and
 * whether the chat line handles the key itself (listed only, like OpenRA's
 * Readonly chat-input keys).
 */
export const CHAT_HOTKEYS = Object.freeze([
  { name: 'openTeamChat', openra: 'OpenTeamChat' },
  { name: 'openGeneralChat', openra: 'OpenGeneralChat' },
  { name: 'toggleChatMode', openra: 'ToggleChatMode', listOnly: true },
  { name: 'autocomplete', openra: 'Autocomplete', listOnly: true },
]);

/**
 * Whether team chat has anyone to reach: a spectator (the other spectators),
 * or a player with another human player on the same non-zero team.
 * @param {{ type: string, team?: number }[]} slots game options' players
 * @param {number | null} me the player's slot, null for a spectator
 */
export function hasTeamChat(slots, me) {
  if (me === null || me === undefined) return true;
  const team = slots[me]?.team ?? 0;
  return team !== 0 && slots.some((s, i) => i !== me && s.type === 'human' && s.team === team);
}

/** The mode a chat key opens: 'team' when asked for and possible, else 'all'. */
export function chatMode(wantTeam, teamChat) {
  return wantTeam && teamChat ? 'team' : 'all';
}

/**
 * Tab completion of a player's name at the end of `text` (OpenRA
 * TabCompletionLogic): the last word completes to the first name that starts
 * with it, ignoring case; pressing Tab again (`previous`: the last result)
 * goes on to the next match. Returns { text, state } or null when nothing
 * matches.
 */
export function completeName(text, names, previous = null) {
  let prefix;
  let start;
  let skip = 0;
  if (previous && text === previous.text) {
    ({ prefix, start } = previous);
    skip = previous.index + 1;
  } else {
    const m = /(\S*)$/.exec(text);
    prefix = m[1];
    start = text.length - prefix.length;
  }
  if (!prefix) return null;
  const matches = names.filter((n) => n.toLowerCase().startsWith(prefix.toLowerCase()));
  if (!matches.length) return null;
  const index = skip % matches.length;
  const out = text.slice(0, start) + matches[index];
  return { text: out, state: { text: out, prefix, start, index } };
}

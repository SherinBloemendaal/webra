// What the online screens show, worked out without the DOM (js/online.js
// draws it): the server browser's rows, filters and detail panel, the online
// counter, the lobby's Connection column, its warning bar and start check,
// "Waiting for <name>", the invite code as it is typed and what a lookup
// found. Pure functions, so the tests check them with fixtures.
//
// Connection quality comes from js/netquality.js (protocol 8, docs/contracts.md
// section 4 "Network quality"): each player's `{ rtt, jitter, late, silent,
// quality, bars }`. "Loss" in the words below is the share of late pings
// (WebSocket runs over TCP, so a late pong is what a player feels as loss).

import {
  BUILTIN_MODES,
  formatInviteCode,
  INVITE_CODE_LENGTH,
  NET_GOOD_JITTER_MS,
  NET_GOOD_RTT_MS,
  NET_POOR_LATE_PCT,
  NET_POOR_RTT_MS,
  normalizeInviteCode,
  SESSION_ID_RE,
} from './protocol.js';

// ---- Connection quality ------------------------------------------------------------------

/** The word for a quality (the second signal next to the colour of the bars). */
export const QUALITY_WORDS = Object.freeze({ good: 'Good', fair: 'Fair', poor: 'Poor' });
/** The lamp state of a quality (js/ui/controls.js LED_STATES). */
export const QUALITY_LEDS = Object.freeze({ good: 'ok', fair: 'warn', poor: 'bad' });

/** The legend of the Connection column (help text and the bars' tooltip), from the shared thresholds. */
export const QUALITY_RULES = Object.freeze({
  good: `Under ${NET_GOOD_RTT_MS} ms, jitter up to ${NET_GOOD_JITTER_MS} ms and no loss.`,
  fair: `${NET_GOOD_RTT_MS} to ${NET_POOR_RTT_MS} ms, or jitter above ${NET_GOOD_JITTER_MS} ms. Playable.`,
  poor: `Above ${NET_POOR_RTT_MS} ms, or more than ${NET_POOR_LATE_PCT}% loss. Expect stutter.`,
});

/** A percentage as people read it: 0%, 4%, 0.5%. */
export function percentText(p) {
  const v = Math.round((p ?? 0) * 10) / 10;
  return `${v}%`;
}

/** The detail line under the ping: "±4 ms · 0% loss". */
export function detailText(net) {
  return `±${net.jitter ?? 0} ms · ${percentText(net.late)} loss`;
}

/**
 * One cell of the lobby's Connection column for a player's measurement
 * (`null`: nothing heard yet). `bars` 0 to 4; `quality` null while measuring.
 * A player the server has not heard a ping from for a while is "No answer".
 */
export function connectionCell(net) {
  if (!net || net.rtt === null || net.rtt === undefined) {
    const silent = !!net?.silent;
    return { quality: silent ? 'poor' : null, bars: silent ? 1 : 0, word: silent ? 'No answer' : 'Measuring', ms: silent ? `${Math.round(net.silent / 1000)} s` : '', detail: silent ? 'No ping reached the server' : '', label: silent ? `No answer for ${Math.round(net.silent / 1000)} seconds` : 'Measuring the connection' };
  }
  const quality = net.silent ? 'poor' : net.quality;
  const bars = net.silent ? 1 : net.bars;
  const word = net.silent ? 'No answer' : (QUALITY_WORDS[quality] ?? 'Measuring');
  const ms = `${net.rtt} ms`;
  const detail = detailText(net);
  return { quality, bars, word, ms, detail, label: `${word}: ${ms}, ${detail.replace(' · ', ', ')}` };
}

/** This player's own status, top right in the lobby: "Your connection: Good" and "34 ms to the server · ±4 ms · 0% loss". */
export function selfConnection(self) {
  if (!self || self.rtt === null || self.rtt === undefined) return { quality: null, bars: 0, title: 'Your connection: measuring', detail: 'Pinging the game server every 2 seconds.' };
  return {
    quality: self.quality,
    bars: self.bars,
    title: `Your connection: ${QUALITY_WORDS[self.quality] ?? 'measuring'}`,
    detail: `${self.rtt} ms to the server · ${detailText(self)}`,
  };
}

/** The people in the slots: `[{ slot, client, name }]` (AI and empty slots have no connection). */
function people(slots) {
  return slots.map((s, slot) => ({ slot, ...s })).filter((s) => s.type === 'human');
}

/**
 * The lobby's players whose connection is poor, worst first:
 * `[{ slot, client, name, rtt, late, you }]`.
 */
export function poorPlayers(slots, players, you) {
  const out = [];
  for (const p of people(slots)) {
    const net = players?.get?.(p.client);
    if (!net) continue;
    const cell = connectionCell(net);
    if (cell.quality !== 'poor') continue;
    out.push({ slot: p.slot, client: p.client, name: p.name, rtt: net.rtt, late: net.late ?? 0, silent: net.silent ?? null, you: p.client === you });
  }
  const weight = (p) => (p.silent ? Infinity : p.rtt + p.late * 100);
  return out.sort((a, b) => weight(b) - weight(a));
}

/** "210 ms with 4% loss", or "no answer for 7 seconds". */
function poorFigures(p) {
  if (p.silent || p.rtt === null || p.rtt === undefined) return `no answer for ${Math.round((p.silent ?? 0) / 1000)} seconds`;
  return `${p.rtt} ms with ${percentText(p.late)} loss`;
}

const WAITS_FOR_SLOWEST = 'In an online game everyone waits for the slowest player, so the game may stutter.';

/**
 * The warning bar under the slots when someone's connection is poor, or null:
 * `{ text, client, slot, canKick, names }`. The worst one is named; the host
 * may kick that player (not itself). "Test again" is for everyone.
 */
export function connectionWarning({ slots, players, you, hostId, isHost }) {
  const poor = poorPlayers(slots, players, you);
  if (!poor.length) return null;
  const worst = poor[0];
  const who = worst.you ? 'Your connection is' : `${worst.name}'s connection is`;
  const more = poor.length > 1 ? ` ${poor.length - 1} more ${poor.length === 2 ? 'player has' : 'players have'} a poor connection too.` : '';
  return {
    text: `${who} unstable: ${poorFigures(worst)}. ${WAITS_FOR_SLOWEST}${more}`,
    client: worst.client,
    slot: worst.slot,
    name: worst.name,
    names: poor.map((p) => p.name),
    canKick: !!isHost && !worst.you && worst.client !== hostId,
  };
}

/**
 * The start check: what Start game says before it starts when someone's
 * connection is poor (it never blocks), or null when everyone is fine.
 */
export function startCheck({ slots, players, you }) {
  const poor = poorPlayers(slots, players, you);
  if (!poor.length) return null;
  const list = poor.map((p) => `${p.you ? 'You' : p.name} (${poorFigures(p)})`).join(', ');
  return { names: poor.map((p) => p.name), text: `Poor connection: ${list}. ${WAITS_FOR_SLOWEST} Start anyway?` };
}

/** The players (not the host) who are not ready yet, by name. */
export function notReady(slots, hostId) {
  return people(slots)
    .filter((s) => s.client !== hostId && !s.ready)
    .map((s) => s.name);
}

/** "Waiting for Ivan", "Waiting for Ivan and Mo", "Waiting for Ivan, Mo and 2 more". */
export function waitingText(names) {
  if (!names.length) return '';
  if (names.length === 1) return `Waiting for ${names[0]}`;
  if (names.length <= 3) return `Waiting for ${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return `Waiting for ${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}

// ---- Server browser -----------------------------------------------------------------------

/** The filter of the server browser: every session, open lobbies, friends' sessions, running games. */
export const SESSION_FILTERS = Object.freeze([
  { value: 'all', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'friends', label: 'Friends' },
  { value: 'ingame', label: 'In progress' },
]);

/** `open` (a lobby with a free place), `full` (a lobby without one) or `ingame` (a running game). */
export function sessionState(s) {
  if (s.state === 'game') return 'ingame';
  return s.players >= s.maxPlayers ? 'full' : 'open';
}

/** The name of a session's game mode: a built-in mode, Custom, or Co-op for a mission. */
export function modeName(s) {
  if (s.map?.mission) return 'Co-op';
  const id = s.summary?.mode;
  if (id === undefined) return '';
  if (id === null) return 'Co-op';
  if (id === 'custom') return 'Custom';
  return BUILTIN_MODES.find((m) => m.id === id)?.name ?? 'Custom';
}

/** The map column: the map's name (an object in the session list, a name in the friends list), or Generated. */
export function mapName(s) {
  if (!s.map) return 'Generated';
  return typeof s.map === 'string' ? s.map : String(s.map.name);
}

/**
 * The sessions the browser shows: `filter` (SESSION_FILTERS), `query`
 * (matches name, host or map, any case), `hideFull` (full lobbies go; running
 * games are their own filter), `friendSessions` (session ids a friend is in).
 */
export function filterSessions(sessions, { filter = 'all', query = '', hideFull = false, friendSessions = new Set() } = {}) {
  const q = query.trim().toLocaleLowerCase();
  return sessions.filter((s) => {
    const state = sessionState(s);
    if (filter === 'open' && state !== 'open') return false;
    if (filter === 'ingame' && state !== 'ingame') return false;
    if (filter === 'friends' && !friendSessions.has(s.id)) return false;
    if (hideFull && state === 'full') return false;
    if (!q) return true;
    return [s.name, s.host, mapName(s)].some((v) => String(v ?? '').toLocaleLowerCase().includes(q));
  });
}

/** Session ids a friend is in (the friends list document of js/account/friends.js), for the Friends filter. */
export function friendSessionIds(doc) {
  return new Set((doc?.friends ?? []).map((f) => f.session?.id).filter(Boolean));
}

/** One row of the session list. */
export function sessionRow(s, { version, friendSessions = new Set() } = {}) {
  const state = sessionState(s);
  const tags = [];
  if (state === 'ingame') tags.push(['ingame', 'In game']);
  else if (state === 'full') tags.push(['full', 'Full']);
  if (s.locked) tags.push(['locked', 'Password']);
  if (s.map?.mission) tags.push(['info', 'Co-op']);
  if (s.map?.modded) tags.push(['modded', 'Modded']);
  if (friendSessions.has(s.id)) tags.push(['online', 'Friend']);
  return {
    id: s.id,
    name: String(s.name),
    host: String(s.host),
    map: mapName(s),
    mode: modeName(s),
    players: `${s.players}/${s.maxPlayers}`,
    state,
    led: state === 'open' ? 'ok' : state === 'ingame' ? 'warn' : 'off',
    stateWord: { open: 'Open', full: 'Full', ingame: 'In game' }[state],
    tags,
    sameVersion: s.version === version,
  };
}

/** Starting cash as the lobby writes it: $10,000. */
export const cashText = (v) => `$${Number(v).toLocaleString('en-US')}`;

const TECH = { infonly: 'Infantry only', low: 'Low tech', medium: 'Medium tech', high: 'No superweapons', unrestricted: 'All tech' };
const SPEED = { slowest: 'Slowest', slower: 'Slower', normal: 'Normal speed', fast: 'Fast', faster: 'Faster', fastest: 'Fastest' };

/** The option chips of the detail panel: FOG, $10,000, 2 SPECTATORS and so on (words, so they read without colour). */
export function optionChips(summary) {
  if (!summary) return [];
  const o = summary.options ?? {};
  const chips = [];
  if (o.startingCash !== undefined) chips.push(cashText(o.startingCash));
  if (o.techLevel && TECH[o.techLevel]) chips.push(TECH[o.techLevel]);
  if (o.gameSpeed && o.gameSpeed !== 'normal' && SPEED[o.gameSpeed]) chips.push(SPEED[o.gameSpeed]);
  if (o.fog) chips.push('Fog');
  if (o.crates) chips.push('Crates');
  if (o.timeLimit) chips.push(`${o.timeLimit} min limit`);
  const n = summary.spectators ?? 0;
  chips.push(n === 1 ? '1 spectator' : `${n} spectators`);
  return chips;
}

/** "12:40" for a running game's time (minutes and seconds; hours when it is long). */
export function clockText(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/**
 * The detail panel of the chosen session: title, the line under it, the
 * players with team and colour index (and the open places), the option chips
 * and which buttons work. `now`: for a running game's time.
 */
export function sessionDetail(s, { version, now = Date.now() } = {}) {
  const state = sessionState(s);
  const summary = s.summary ?? null;
  const mode = modeName(s);
  const sub = [`Hosted by ${s.host}`, mapName(s), mode].filter(Boolean);
  if (state === 'ingame' && summary?.startedAt) sub.push(`Playing ${clockText(now - summary.startedAt)}`);
  const players = (summary?.players ?? []).map((p) => ({ name: String(p.name), team: p.team ?? 0, color: p.color ?? null, ai: !!p.ai }));
  const open = Math.max(0, s.maxPlayers - s.players);
  const spectatorRoom = summary ? summary.spectators < summary.maxSpectators : true;
  const same = s.version === version;
  const versionNote = same ? '' : `Needs game version ${s.version}`;
  return {
    id: s.id,
    title: String(s.name),
    sub: sub.join(' · '),
    players,
    open: state === 'ingame' ? 0 : open,
    chips: optionChips(summary),
    canJoin: same && state === 'open',
    canWatch: same && spectatorRoom,
    joinTitle: !same ? versionNote : state === 'ingame' ? 'The game is running: you can watch it' : state === 'full' ? 'Every place is taken: you can watch' : '',
    watchTitle: !same ? versionNote : spectatorRoom ? '' : 'The spectator places are taken',
    locked: !!s.locked,
    state,
  };
}

/** The online counter: "142 online", with the lobbies and games for its tooltip. */
export function onlineText(c) {
  if (!c || !Number.isInteger(c.players)) return null;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  return { text: `${c.players} online`, title: `${plural(c.players, 'player', 'players')} online, ${plural(c.lobbies ?? 0, 'lobby', 'lobbies')} open, ${plural(c.games ?? 0, 'game', 'games')} running` };
}

// ---- Invite codes ----------------------------------------------------------------------------

/**
 * What the code field shows for what was typed or pasted: the code with its
 * dash as far as it goes (`K7Q-2M`), the six cells (blank ones `''`), whether
 * it is complete, and a long session id or link (the older invite links:
 * `?join=<id>`), which joins without a lookup.
 */
export function inviteInput(raw) {
  const text = String(raw ?? '');
  const sessionId = (/([0-9a-f]{64})/.exec(text) ?? [])[1];
  if (sessionId && SESSION_ID_RE.test(sessionId)) return { code: null, sessionId, shown: text.trim(), cells: Array(INVITE_CODE_LENGTH).fill(''), complete: true };
  const full = normalizeInviteCode(text);
  if (full) return { code: full, sessionId: null, shown: formatInviteCode(full), cells: [...full], complete: true };
  // Partly typed: keep the characters a code can have, in order, up to six.
  const chars = text
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/[01ILO]/g, '')
    .slice(0, INVITE_CODE_LENGTH);
  const cells = Array.from({ length: INVITE_CODE_LENGTH }, (_, i) => chars[i] ?? '');
  const shown = chars.length > 3 ? `${chars.slice(0, 3)}-${chars.slice(3)}` : chars;
  return { code: null, sessionId: null, shown, cells, complete: false };
}

/** "1 h 42 min left", "12 min left", "less than a minute left", "Expired". */
export function inviteLeftText(ms) {
  if (ms <= 0) return 'Expired';
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'less than a minute left';
  const h = Math.floor(min / 60);
  return h ? `${h} h ${min % 60} min left` : `${min} min left`;
}

/**
 * What the join dialog shows for a lookup (js/invites.js lookupInvite): a
 * lobby card or the error, and the main button. `rtt`: the browser's round
 * trip to the server, shown on the card.
 */
export function inviteResult(r, { version, rtt = null } = {}) {
  if (!r) return { kind: 'idle', canJoin: false, action: 'Join lobby' };
  if (!r.ok) return { kind: 'error', reason: r.reason, message: r.message, canJoin: false, action: 'Join lobby' };
  const inv = r.invite;
  const same = inv.version === version;
  const bits = [`Hosted by ${inv.host}`, mapName(inv), `${inv.players} of ${inv.maxPlayers} players`];
  if (rtt !== null) bits.push(`${rtt} ms`);
  const base = { kind: 'lobby', title: String(inv.name), sub: bits.join(' · '), locked: !!inv.locked, invite: inv };
  if (!same) return { ...base, kind: 'error', reason: 'version', message: `This lobby plays game version ${inv.version}. Reload the page to update.`, canJoin: false, action: 'Join lobby' };
  if (r.full) return { ...base, kind: 'full', message: r.message, canJoin: r.canSpectate, spectate: true, action: 'Join as spectator' };
  return { ...base, canJoin: true, spectate: false, action: 'Join lobby' };
}

// Friends on the account page (docs/accounts-api.md 5.11): the API calls
// and the words for each friend's status. No DOM.
//
// Adapter: the protocol round (branch work/netround) adds the same client
// as apps/game/js/account/friends.js (FriendsClient, published under
// /lib/js/account/friends.js). FriendsClient here has the same methods and
// routes; once both are merged, import it from /lib/js/account/friends.js
// and keep only the helpers below the client.

import { AccountApi } from '/lib/js/account/api.js';

const enc = encodeURIComponent;

/** The friends list is polled this often while the page shows it (FRIENDS_POLL_MS of the protocol). */
export const FRIENDS_POLL_MS = 30_000;

/** The `social` settings (declared keys of the settings document) and their defaults (SOCIAL_DEFAULTS). */
export const SOCIAL_DEFAULTS = Object.freeze({ showOnline: true, friendsJoin: true, allowSpectate: false });

/** The friends endpoints. Every method resolves with the parsed answer or throws an AccountError. */
export class FriendsClient {
  constructor(api = new AccountApi()) {
    this.api = api;
  }

  /** `{ friends, incoming, outgoing, blocked, invites, sentInvites, privacy, limits }`. */
  list = () => this.api.get('/api/account/friends');
  /** `{ request }` (waiting) or `{ friend }` when the other player had asked already. */
  request = (username) => this.api.post('/api/account/friends/requests', { username });
  accept = (username) => this.api.post(`/api/account/friends/requests/${enc(username)}/accept`);
  ignore = (username) => this.api.post(`/api/account/friends/requests/${enc(username)}/ignore`);
  withdraw = (username) => this.api.del(`/api/account/friends/requests/${enc(username)}`);
  remove = (username) => this.api.del(`/api/account/friends/${enc(username)}`);
  block = (username) => this.api.post('/api/account/friends/blocks', { username });
  unblock = (username) => this.api.del(`/api/account/friends/blocks/${enc(username)}`);
  /** Dismiss an invite from `username`, or with `sent` withdraw one sent to `username`. */
  dismissInvite = (username, { sent = false } = {}) => this.api.del(`/api/account/friends/invites/${enc(username)}${sent ? '?sent=1' : ''}`);
}

/** The effective privacy settings from a settings document (anything malformed takes the default). */
export function socialSettings(settings) {
  const s = settings && typeof settings === 'object' && !Array.isArray(settings) ? settings.social : null;
  const out = { ...SOCIAL_DEFAULTS };
  if (!s || typeof s !== 'object' || Array.isArray(s)) return out;
  for (const k of Object.keys(SOCIAL_DEFAULTS)) if (typeof s[k] === 'boolean') out[k] = s[k];
  return out;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "3 minutes", "2 hours", "4 days". */
export function spanText(ms) {
  const n = Math.max(0, Number(ms) || 0);
  const unit = (v, word) => `${v} ${word}${v === 1 ? '' : 's'}`;
  if (n < HOUR) return unit(Math.max(1, Math.floor(n / MINUTE)), 'minute');
  if (n < DAY) return unit(Math.floor(n / HOUR), 'hour');
  return unit(Math.floor(n / DAY), 'day');
}

/** "12:40" for a game that runs 12 min 40 s (hours when it is that long). */
export function clockText(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** The map's name of a session as the directory gives it (a name or `{ name }`). */
const mapName = (map) => (typeof map === 'string' ? map : typeof map?.name === 'string' ? map.name : null);

/**
 * What a friend is doing, in words, with the lamp state and the group the
 * list puts it in: `{ text, led, group }` (group game, lobby, online,
 * offline; away counts as online).
 */
export function friendStatus(friend, now = Date.now()) {
  const s = friend?.session && typeof friend.session === 'object' ? friend.session : null;
  switch (friend?.status) {
    case 'game': {
      const parts = ['In a game'];
      if (s) {
        if (s.name) parts[0] = `In a game: ${s.name}`;
        const map = mapName(s.map);
        if (map) parts.push(map);
        if (Number.isFinite(s.playingMs)) parts.push(clockText(s.playingMs));
      }
      return { text: parts.join(' · '), led: 'on', group: 'game' };
    }
    case 'lobby': {
      let text = 'In a lobby';
      if (s?.name) text = `In lobby: ${s.name}`;
      if (s && Number(s.maxPlayers) > 0) text += ` (${Number(s.players) || 0}/${Number(s.maxPlayers)})`;
      return { text, led: 'ok', group: 'lobby' };
    }
    case 'online':
      return { text: 'In the main menu', led: 'ok', group: 'online' };
    case 'away':
      return { text: Number.isFinite(friend.awayMs) ? `Away for ${spanText(friend.awayMs)}` : 'Away', led: 'warn', group: 'online' };
    default: {
      const seen = Number(friend?.lastSeenAt);
      return { text: Number.isFinite(seen) && seen > 0 ? `Last seen ${spanText(now - seen)} ago` : 'Offline', led: 'off', group: 'offline' };
    }
  }
}

/** The list's groups in order, with their friends (filtered by `query` on name). Empty groups are left out. */
export function groupFriends(friends, query = '', now = Date.now()) {
  const q = String(query ?? '').trim().toLocaleLowerCase();
  const groups = [
    ['game', 'In a game'],
    ['lobby', 'In a lobby'],
    ['online', 'Online'],
    ['offline', 'Offline'],
  ].map(([key, title]) => ({ key, title, people: [] }));
  for (const f of Array.isArray(friends) ? friends : []) {
    if (!f || typeof f.username !== 'string') continue;
    const names = [f.username, f.displayName].filter((n) => typeof n === 'string').map((n) => n.toLocaleLowerCase());
    if (q && !names.some((n) => n.includes(q))) continue;
    const status = friendStatus(f, now);
    groups.find((g) => g.key === status.group).people.push({ friend: f, status });
  }
  for (const g of groups) g.people.sort((a, b) => a.friend.username.localeCompare(b.friend.username));
  return groups.filter((g) => g.people.length);
}

/** "3 online · 1 in a game" (away and in a lobby count as online). */
export function friendsSummary(friends) {
  let online = 0;
  let game = 0;
  for (const f of Array.isArray(friends) ? friends : []) {
    if (f?.status === 'game') game++;
    else if (f?.status === 'online' || f?.status === 'away' || f?.status === 'lobby') online++;
  }
  const parts = [`${online} online`];
  if (game) parts.push(`${game} in a game`);
  return parts.join(' · ');
}

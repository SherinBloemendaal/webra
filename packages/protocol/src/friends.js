// Friends (docs/accounts-api.md section 5.11): limits, the statuses a friend
// can have, and the privacy settings the server enforces.

import { SOCIAL_SETTING_DEFAULTS } from './accounts.js';

/** What the friends list says a friend is doing. */
export const FRIEND_STATUSES = ['offline', 'online', 'away', 'lobby', 'game'];

/** Most friends per account, and most open requests an account sends or receives. */
export const FRIENDS_MAX = 200;
export const FRIEND_REQUESTS_OUT_MAX = 50;
export const FRIEND_REQUESTS_IN_MAX = 100;
/** Most blocked accounts per account. */
export const BLOCKS_MAX = 500;
/** Unanswered (or ignored) friend requests are forgotten after this long. */
export const FRIEND_REQUEST_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The presence heartbeat (POST /api/account/presence): the game sends one
 * this often while it is open, and right away when the player goes away (no
 * input for PRESENCE_AWAY_MS) or comes back. A player whose last heartbeat
 * is older than PRESENCE_ONLINE_MS is offline.
 */
export const PRESENCE_INTERVAL_MS = 60_000;
export const PRESENCE_ONLINE_MS = 150_000;
export const PRESENCE_AWAY_MS = 10 * 60_000;
/**
 * The friends list is polled this often while a screen shows it and the
 * realtime channel (realtime.js) is not open, and only this often while it
 * is (the channel says when to look again; the slow poll is a safety net).
 */
export const FRIENDS_POLL_MS = 30_000;
export const FRIENDS_POLL_SLOW_MS = 5 * 60_000;

/**
 * The privacy settings come from the `social` section of the settings
 * document (accounts.js SETTINGS_SECTIONS, defaults SOCIAL_SETTING_DEFAULTS:
 * friends see when you are around, friends can join your lobby without an
 * invite when there is room, friends cannot watch your games unless you
 * allow it).
 */
/** The effective privacy settings from a stored settings document (anything malformed takes the default). */
export function socialSettings(doc) {
  const s = doc && typeof doc === 'object' && !Array.isArray(doc) ? doc.social : null;
  const out = { ...SOCIAL_SETTING_DEFAULTS };
  if (!s || typeof s !== 'object' || Array.isArray(s)) return out;
  for (const k of Object.keys(SOCIAL_SETTING_DEFAULTS)) if (typeof s[k] === 'boolean') out[k] = s[k];
  return out;
}

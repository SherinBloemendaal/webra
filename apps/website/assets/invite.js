// Invite codes on the website (docs/contracts.md section 4, "Invite codes"):
// "Join with a code" on the multiplayer page, the invite a signed-out player
// follows (/join/<code> -> /play/?invite=<code> -> the play gate -> the
// account page with ?returnTo=/play/?invite=<code>), and friends' invites on
// the account page. The Worker owns /join/<code> (a redirect into the game);
// the game looks the code up and joins. The code rules are the protocol's
// (invite.js, from /lib/); this module adds what the website's fields and
// cards need and looks codes up with GET /api/invite/:code.

import { INVITE_ALPHABET, INVITE_CODE_LENGTH } from '/lib/protocol/constants.js';
import { formatInviteCode, invitePath, normalizeInviteCode } from '/lib/protocol/invite.js';

export { formatInviteCode, invitePath, normalizeInviteCode };

/**
 * What a player has typed so far, as the field shows it: the allowed
 * characters in upper case, the dash after the third (it fills in by
 * itself), at most six characters. A pasted link or full code is taken
 * whole.
 */
export function typedInviteCode(input) {
  const whole = normalizeInviteCode(String(input ?? ''));
  if (whole) return formatInviteCode(whole);
  const chars = String(input ?? '')
    .toUpperCase()
    .split('')
    .filter((c) => INVITE_ALPHABET.includes(c))
    .slice(0, INVITE_CODE_LENGTH)
    .join('');
  return chars.length > 3 ? `${chars.slice(0, 3)}-${chars.slice(3)}` : chars;
}

/** The invite code a game link carries (`/play/?invite=K7Q-2MX`, the play gate's returnTo), or null. */
export function inviteInPath(path) {
  if (typeof path !== 'string') return null;
  try {
    const u = new URL(path, 'https://webra.invalid');
    if (u.pathname !== '/play/' && u.pathname !== '/play') return null;
    return normalizeInviteCode(u.searchParams.get('invite') ?? '');
  } catch {
    return null;
  }
}

/** What the website says for each way a lookup can fail (the board "Invite codes"). */
export const INVITE_MESSAGES = Object.freeze({
  invalid: 'Type the six characters a friend gave you.',
  unknown: 'No lobby has this code. Check it with your friend.',
  expired: 'The lobby closed or the code was replaced.',
  full: 'The lobby is full. You can still join as a spectator.',
  rate_limited: 'Too many codes tried. Wait a while and try again.',
  offline: 'The multiplayer server cannot be reached.',
});

/**
 * Look a code up (GET /api/invite/<code>). Resolves `{ ok: true, invite,
 * full, canSpectate, message? }` or `{ ok: false, reason, message }` with
 * reason invalid, unknown, expired, rate_limited or offline; never throws.
 * `invite`: `{ code, session, name, host, map, players, maxPlayers,
 * spectators, maxSpectators, mode, locked, public, version, expiresAt }`.
 */
export async function lookupInvite(input, { fetchImpl = (...a) => globalThis.fetch(...a), timeoutMs = 8000 } = {}) {
  const code = normalizeInviteCode(input);
  if (!code) return { ok: false, reason: 'invalid', message: INVITE_MESSAGES.invalid };
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let res;
  try {
    res = await fetchImpl(`/api/invite/${encodeURIComponent(formatInviteCode(code))}`, {
      headers: { accept: 'application/json' },
      cache: 'no-store',
      credentials: 'same-origin',
      ...(controller ? { signal: controller.signal } : {}),
    });
  } catch {
    return { ok: false, reason: 'offline', message: INVITE_MESSAGES.offline };
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!res.ok) {
    const reason = res.status === 404 ? 'unknown' : res.status === 410 ? 'expired' : res.status === 429 ? 'rate_limited' : 'offline';
    return { ok: false, reason, message: INVITE_MESSAGES[reason] };
  }
  let invite;
  try {
    invite = (await res.json())?.invite;
  } catch {
    invite = null;
  }
  if (!invite || typeof invite !== 'object' || typeof invite.session !== 'string') return { ok: false, reason: 'offline', message: INVITE_MESSAGES.offline };
  const players = Number(invite.players) || 0;
  const maxPlayers = Number(invite.maxPlayers) || 0;
  const full = maxPlayers > 0 && players >= maxPlayers;
  const canSpectate = (Number(invite.spectators) || 0) < (Number(invite.maxSpectators) || 0);
  return { ok: true, invite: { ...invite, code: formatInviteCode(code) }, full, canSpectate, ...(full ? { message: INVITE_MESSAGES.full } : {}) };
}

/** One line about the lobby: "Hosted by Kara · Coastal Ridge · 3 of 4 players". */
export function inviteSummary(invite) {
  const parts = [];
  if (typeof invite?.host === 'string' && invite.host) parts.push(`Hosted by ${invite.host}`);
  const map = typeof invite?.map === 'string' ? invite.map : typeof invite?.map?.name === 'string' ? invite.map.name : null;
  if (map) parts.push(map);
  if (Number.isFinite(Number(invite?.maxPlayers)) && Number(invite?.maxPlayers) > 0) parts.push(`${Number(invite.players) || 0} of ${Number(invite.maxPlayers)} players`);
  if (invite?.locked) parts.push('password');
  return parts.join(' · ');
}

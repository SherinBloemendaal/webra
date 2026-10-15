// Invite codes in the game (docs/contracts.md section 4, "Invite codes"):
// the data layer behind "Join with a code" and the lobby's "Invite players"
// panel. No DOM here.
//
//   const code = inviteFromLocation(location);       // from /join/K7Q-2MX -> /play/?invite=K7Q-2MX
//   const r = await lookupInvite(typedOrPasted);      // { ok, invite } or { ok: false, reason, message }
//   if (r.ok && r.invite.locked) askForThePassword();  // a code never skips the password
//   const mine = await createInvite(sessionId, member); // host: { code, expiresAt, path }
//   copy(inviteLink(mine.code));

import { api, ApiError } from './net.js';
import { formatInviteCode, invitePath, normalizeInviteCode } from './protocol.js';

export { formatInviteCode, invitePath, normalizeInviteCode };

/** What the join dialog says for each way a lookup can fail (the board "Invite codes"). */
export const INVITE_MESSAGES = Object.freeze({
  invalid: 'Type the six characters a friend gave you.',
  unknown: 'No lobby has this code. Check it with your friend.',
  expired: 'The lobby closed or the code was replaced.',
  full: 'The lobby is full. You can still join as a spectator.',
  rate_limited: 'Too many codes tried. Wait a while and try again.',
  offline: 'The multiplayer server cannot be reached.',
});

/**
 * Look up what a player typed or pasted (a code with or without the dash,
 * or a whole link). Resolves `{ ok: true, invite, full, canSpectate }`
 * (invite as GET /api/invite returns it) or `{ ok: false, reason, message }`
 * with reason invalid, unknown, expired, rate_limited or offline. Never
 * throws for those.
 */
export async function lookupInvite(input, { lookup = api.lookupInvite } = {}) {
  const code = normalizeInviteCode(input);
  if (!code) return { ok: false, reason: 'invalid', message: INVITE_MESSAGES.invalid };
  try {
    const { invite } = await lookup(formatInviteCode(code));
    const full = invite.players >= invite.maxPlayers;
    return { ok: true, invite, full, canSpectate: invite.spectators < invite.maxSpectators, ...(full ? { message: INVITE_MESSAGES.full } : {}) };
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    const reason = err.status === 404 ? 'unknown' : err.status === 410 ? 'expired' : err.status === 429 ? 'rate_limited' : 'offline';
    return { ok: false, reason, message: reason === 'offline' && err.status !== 0 ? err.message : INVITE_MESSAGES[reason] };
  }
}

/** Host: a new code for its lobby (the old one stops working). `member`: { client, key } from `welcome`. */
export function createInvite(sessionId, member, { create = api.createInvite } = {}) {
  return create(sessionId, member);
}

/** The link to share: `https://<site>/join/K7Q-2MX`. */
export function inviteLink(code, origin = globalThis.location?.origin ?? '') {
  return `${origin}${invitePath(normalizeInviteCode(code) ?? code)}`;
}

/** The code the page was opened with (`?invite=`, where /join/<code> leads), or null. */
export function inviteFromLocation(loc = globalThis.location) {
  try {
    return normalizeInviteCode(new URL(loc.href).searchParams.get('invite') ?? '');
  } catch {
    return null;
  }
}

/** Remove `?invite=` from the address bar once it was used, so a reload does not join again. */
export function clearInviteFromLocation(loc = globalThis.location, history = globalThis.history) {
  try {
    const url = new URL(loc.href);
    if (!url.searchParams.has('invite')) return;
    url.searchParams.delete('invite');
    history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // No history API (a worker, a test): nothing to clean.
  }
}

/** Milliseconds a code has left (0 once expired). */
export function inviteMsLeft(expiresAt, now = Date.now()) {
  return Math.max(0, expiresAt - now);
}

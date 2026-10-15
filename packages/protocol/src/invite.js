// Invite codes (docs/contracts.md section 4, "Invite codes"): six characters
// from INVITE_ALPHABET, shown as `K7Q-2MX`. The code is only a short name
// for a lobby: a password lobby still asks for its password.

import { INVITE_ALPHABET, INVITE_CODE_LENGTH, INVITE_CODE_RE } from './constants.js';

/**
 * The code in what a player typed or pasted: any case, with or without the
 * dash or spaces, or a whole link ending in `/join/<code>` or carrying
 * `invite=<code>`. Returns the six characters (upper case, no dash) or null.
 */
export function normalizeInviteCode(input) {
  if (typeof input !== 'string' || input.length > 512) return null;
  let s = input.trim();
  const link = /(?:\/join\/|[?&#]invite=)([^/?#&]+)/i.exec(s);
  if (link) {
    try {
      s = decodeURIComponent(link[1]);
    } catch {
      return null;
    }
  }
  s = s.replace(/[\s-]/g, '').toUpperCase();
  return INVITE_CODE_RE.test(s) ? s : null;
}

/** `K7Q2MX` -> `K7Q-2MX` (anything that is not a code is returned as it is). */
export function formatInviteCode(code) {
  return typeof code === 'string' && INVITE_CODE_RE.test(code) ? `${code.slice(0, 3)}-${code.slice(3)}` : code;
}

/**
 * A fresh random code from `random(n)`, which returns n uniformly random
 * bytes (crypto.getRandomValues). Bytes at or above the largest multiple of
 * the alphabet size are discarded, so every character is equally likely.
 */
export function randomInviteCode(random) {
  const n = INVITE_ALPHABET.length;
  const limit = 256 - (256 % n);
  let out = '';
  while (out.length < INVITE_CODE_LENGTH) {
    for (const b of random(INVITE_CODE_LENGTH * 2)) {
      if (b >= limit) continue;
      out += INVITE_ALPHABET[b % n];
      if (out.length === INVITE_CODE_LENGTH) break;
    }
  }
  return out;
}

/** The path of an invite link on this site: `/join/K7Q-2MX`. */
export function invitePath(code) {
  return `/join/${formatInviteCode(code)}`;
}

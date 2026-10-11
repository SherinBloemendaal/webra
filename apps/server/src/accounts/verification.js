// Address proofs (docs/accounts-api.md 4.2, 5.4 and 9): the mail that
// confirms an email address, its limits, and the rules that keep responses
// from telling whether an address has an account.
//
// An address claims nothing until it is verified (migration 0003): only a
// verified address is unique (`email_key`). A new account or a new address
// therefore never fails because another account verified the same address;
// instead that address gets a notice without a link (addressInUseMessage),
// and the request is answered the same way as any other, before the mail
// is prepared (RequestContext.background), so neither the answer nor its
// timing shows which mail went out.

import { emailKey } from '@webra/protocol';
import { accountLink, addressInUseMessage, createEmailToken, sendEmail, TOKEN_TTL_MS, verifyMessage } from './email.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * Limits on address mail (D1 counters keyed by HMAC, src/quota.js).
 * `address*` cap the mail one address receives, whoever asks (signups,
 * changes and resends together): over the cap nothing is sent and the
 * request is still answered as usual.
 */
export const MAIL_LIMITS = {
  resendAccount: [3, HOUR],
  resendAccountDay: [10, DAY],
  resendNetwork: [10, HOUR],
  changeAccount: [5, DAY],
  changeNetwork: [20, DAY],
  addressHour: [3, HOUR],
  addressDay: [6, DAY],
};

/** Whether a verified address belongs to an account other than `exceptUserId` (unverified ones claim nothing). */
export async function emailTaken(db, email, exceptUserId = null) {
  const row = await db.prepare('SELECT id FROM users WHERE email_key = ?1').bind(emailKey(email)).first();
  return row !== null && row.id !== exceptUserId;
}

/**
 * Mail the proof for `email` now: a single-use link (purpose `verify` for
 * the account's own unverified address, `change` for a new address that
 * replaces a verified one) bound to the account and this exact address, or
 * the in-use notice when another account verified the address. The token
 * is stored in both cases (it is what `pendingEmail` shows, and a link to an
 * address someone else verified could not be used anyway), so nothing the
 * account sees afterwards differs. `capped` applies the per-address limits
 * (requests from players; admins are not capped). Returns whether a message
 * was handed to Email Service.
 */
export async function sendAddressMail(ctx, { userId, username, email, purpose, capped = true }) {
  if (!(await ctx.eff()).login.email) return false;
  // Over the cap nothing changes: no mail, and the account's previous link stays valid.
  if (capped) {
    const key = emailKey(email);
    if (!(await ctx.limitSoft('mail-address', key, ...MAIL_LIMITS.addressHour))) return false;
    if (!(await ctx.limitSoft('mail-address-day', key, ...MAIL_LIMITS.addressDay))) return false;
  }
  const { token } = await createEmailToken(ctx.db, userId, purpose, email, TOKEN_TTL_MS[purpose], ctx.now);
  if (await emailTaken(ctx.db, email, userId)) return sendEmail(ctx.env, email, addressInUseMessage(ctx.origin));
  return sendEmail(ctx.env, email, verifyMessage(username, accountLink(ctx.origin, 'verify', token), { change: purpose === 'change', origin: ctx.origin }));
}

/** sendAddressMail after the response (see the top of this file). */
export function queueAddressMail(ctx, mail) {
  return ctx.background('address mail failed', () => sendAddressMail(ctx, mail));
}

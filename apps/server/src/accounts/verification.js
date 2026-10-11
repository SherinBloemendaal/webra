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
import { accountLink, addressInUseMessage, createEmailToken, sendEmail, takeMailBudget, TOKEN_TTL_MS, verifyMessage } from './email.js';

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

/**
 * The mailbox an address delivers to, for the per-address mail limits only
 * (never for uniqueness, which is emailKey): lower case, without a
 * `+suffix`, and for Gmail (gmail.com, googlemail.com) without dots, so
 * victim+1@gmail.com and v.i.c.t.i.m@googlemail.com count as one mailbox.
 */
export function mailboxKey(email) {
  const at = email.lastIndexOf('@');
  let local = email.slice(0, at).toLowerCase();
  let domain = email.slice(at + 1).toLowerCase();
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return `${local}@${domain}`;
}

/** Whether a verified address belongs to an account other than `exceptUserId` (unverified ones claim nothing). */
export async function emailTaken(db, email, exceptUserId = null) {
  const row = await db.prepare('SELECT id FROM users WHERE email_key = ?1').bind(emailKey(email)).first();
  return row !== null && row.id !== exceptUserId;
}

/**
 * Mail the proof for `email` now: a single-use link (purpose `verify` for
 * the account's own unverified address, `change` for a new address that
 * replaces a verified one) bound to the account and this exact address, or
 * the in-use notice when another account verified the address (the token is
 * stored then too: a link to an address someone else verified could not be
 * used anyway). `capped` applies the per-mailbox limits (requests from
 * players; admins are not capped); every message also takes a unit of the
 * daily outbound ceiling. Over a limit nothing is mailed, and nothing the
 * requester sees differs: a `verify` token is invisible to the account, so
 * it is only made when the mail goes out (the previous link stays valid); a
 * `change` token is what `pendingEmail` shows, so it is made first, always.
 * Returns { sent, notice } (notice: the in-use notice went out instead of a
 * link), for admins.
 */
export async function sendAddressMail(ctx, { userId, username, email, purpose, capped = true }) {
  const none = { sent: false, notice: false };
  if (!(await ctx.eff()).login.email) return none;
  const makeToken = () => createEmailToken(ctx.db, userId, purpose, email, TOKEN_TTL_MS[purpose], ctx.now);
  let token = purpose === 'change' ? (await makeToken()).token : null;
  if (capped) {
    const key = mailboxKey(email);
    if (!(await ctx.limitSoft('mail-address', key, ...MAIL_LIMITS.addressHour))) return none;
    if (!(await ctx.limitSoft('mail-address-day', key, ...MAIL_LIMITS.addressDay))) return none;
  }
  if (!(await takeMailBudget(ctx))) return none;
  token ??= (await makeToken()).token;
  const origin = ctx.linkOrigin;
  if (await emailTaken(ctx.db, email, userId)) return { sent: await sendEmail(ctx, email, addressInUseMessage(origin), { budgeted: true }), notice: true };
  const sent = await sendEmail(ctx, email, verifyMessage(username, accountLink(origin, 'verify', token), { change: purpose === 'change', origin }), { budgeted: true });
  return { sent, notice: false };
}

/** sendAddressMail after the response (see the top of this file). */
export function queueAddressMail(ctx, mail) {
  return ctx.background('address mail failed', () => sendAddressMail(ctx, mail));
}

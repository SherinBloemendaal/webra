// Email links (verification, email change, password reset) and sending them
// through Cloudflare Email Service (the Workers `send_email` binding EMAIL,
// `env.EMAIL.send`). Without the binding or the sender address EMAIL_FROM
// (the Workers Paid plan is needed for sending) email is reported unavailable
// and nothing here is called; docs/deploy.md describes how to enable it.
//
// Messages are plain text plus simple HTML: no images, no tracking, one link
// to the account page of the site the request came to.

import { fromHex, randomToken, sha256Hex, timingSafeEqual } from '../crypto.js';
import { emailSender, services } from './site.js';
import { logError } from '../telemetry.js';
import { isLocalDevRequest } from '../ipkey.js';

export const SITE_NAME = 'WebRA';
export const ACCOUNT_PAGE = '/account/';
export const TOKEN_TTL_MS = {
  verify: 24 * 60 * 60 * 1000,
  change: 24 * 60 * 60 * 1000,
  reset: 60 * 60 * 1000,
  adminReset: 24 * 60 * 60 * 1000,
};

/** Purposes whose tokens a new token replaces: one address proof per account at a time. */
const REPLACES = { verify: ['verify', 'change'], change: ['verify', 'change'], reset: ['reset'] };

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * A new single-use token for `purpose`, bound to the account and (for
 * address proofs) the exact address. Older tokens it replaces (REPLACES) are
 * deleted in the same batch. Returns { token, expiresAt }; only the token's
 * SHA-256 is stored.
 */
export async function createEmailToken(db, userId, purpose, email, ttlMs, now = Date.now()) {
  const token = randomToken();
  const expiresAt = now + ttlMs;
  const replaced = REPLACES[purpose];
  await db.batch([
    db.prepare(`DELETE FROM email_tokens WHERE user_id = ?1 AND purpose IN (${replaced.map((_, i) => `?${i + 2}`).join(', ')})`).bind(userId, ...replaced),
    db
      .prepare('INSERT INTO email_tokens (token_hash, user_id, purpose, email, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
      .bind(await sha256Hex(token), userId, purpose, email, now, expiresAt),
  ]);
  return { token, expiresAt };
}

/**
 * Use a token: it is deleted whatever happens next (single use). Returns the
 * row when it existed, had one of `purposes` and had not expired, else null.
 * The row is found by the token's hash (an attacker controls no part of
 * it); the stored hash is compared again in constant time.
 */
export async function consumeEmailToken(db, token, purposes, now = Date.now()) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  const hash = await sha256Hex(token);
  const row = await db.prepare('DELETE FROM email_tokens WHERE token_hash = ?1 RETURNING *').bind(hash).first();
  if (!row || !timingSafeEqual(fromHex(row.token_hash), fromHex(hash)) || !purposes.includes(row.purpose) || row.expires_at <= now) return null;
  return row;
}

/** The site's origin when the variable SITE_ORIGIN is unset (wrangler.jsonc sets it). */
export const DEFAULT_SITE_ORIGIN = 'https://webra.sherin.dev';
const DAY = 24 * 60 * 60 * 1000;

/** The configured site origin: SITE_ORIGIN when it is a plain https origin, else the default. */
export function siteOrigin(env) {
  const v = typeof env?.SITE_ORIGIN === 'string' ? env.SITE_ORIGIN.trim() : '';
  try {
    const u = new URL(v);
    if (u.protocol === 'https:' && u.origin === v) return v;
  } catch {
    // not an origin: the default
  }
  return DEFAULT_SITE_ORIGIN;
}

/**
 * The origin links in mail point at: the configured site origin, whatever
 * host the request reached (a workers.dev or preview host, a forged Host),
 * except plain HTTP to a local development host (wrangler dev), which links
 * to itself.
 */
export function linkOrigin(request, env) {
  if (isLocalDevRequest(request)) return new URL(request.url).origin;
  return siteOrigin(env);
}

/** A link to the account page of `origin` (from linkOrigin) with the token in the fragment. */
export function accountLink(origin, kind, token) {
  return `${origin}${ACCOUNT_PAGE}#${kind}=${token}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Text and HTML bodies: the lines, the link (as a button and as text, when there is one) and a footer. */
function layout({ title, lines, url = null, buttonText = null, footer, origin }) {
  const text = [...lines, ...(url ? ['', url] : []), '', footer, '', `${SITE_NAME}, ${origin}`].join('\n');
  const html = `<!doctype html><html><body style="font-family:sans-serif;line-height:1.5;color:#222">
<h1 style="font-size:20px">${escapeHtml(title)}</h1>
${lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('\n')}
${
  url
    ? `<p><a href="${escapeHtml(url)}" style="display:inline-block;padding:10px 16px;background:#b8402a;color:#fff;text-decoration:none;border-radius:4px">${escapeHtml(buttonText)}</a></p>
<p style="font-size:13px;color:#555">Or open this link: ${escapeHtml(url)}</p>`
    : ''
}
<p style="font-size:13px;color:#555">${escapeHtml(footer)}</p>
<p style="font-size:13px;color:#555">${escapeHtml(SITE_NAME)}, ${escapeHtml(origin)}</p>
</body></html>`;
  return { text, html };
}

/** The link that proves an address (signup, resend, or a new address for the account: `change`). */
export function verifyMessage(username, url, { change = false, origin }) {
  const title = change ? 'Confirm your new email address' : 'Confirm your email address';
  const lines = [
    `Hello ${username},`,
    change
      ? `Someone (hopefully you) asked to use this address for the ${SITE_NAME} account ${username}. Open the link below to confirm it.`
      : `Thanks for signing up for ${SITE_NAME}. Open the link below to confirm your email address.`,
    'The link works once and expires in 24 hours.',
  ];
  return { subject: `${SITE_NAME}: ${title.toLowerCase()}`, ...layout({ title, lines, url, buttonText: 'Confirm email', footer: 'If you did not ask for this, ignore this email.', origin }) };
}

/**
 * Sent instead of a link when another account already verified the address
 * (so the person who typed it learns nothing, and the owner is told). No
 * link, no username: nothing the requester chose appears in it.
 */
export function addressInUseMessage(origin) {
  const title = 'This address already has an account';
  const lines = [
    `Someone asked to use this email address for a ${SITE_NAME} account, but it already belongs to a confirmed ${SITE_NAME} account, so nothing changed.`,
    `If that was you, sign in to your existing account at ${origin}${ACCOUNT_PAGE} (use "Forgot password" there if you need to).`,
  ];
  return { subject: `${SITE_NAME}: this address already has an account`, ...layout({ title, lines, footer: 'If it was not you, ignore this email.', origin }) };
}

export function resetMessage(username, url, hours, { origin }) {
  const title = 'Reset your password';
  const lines = [`Hello ${username},`, `Open the link below within ${hours} ${hours === 1 ? 'hour' : 'hours'} to choose a new ${SITE_NAME} password. The link works once.`];
  return {
    subject: `${SITE_NAME}: reset your password`,
    ...layout({ title, lines, url, buttonText: 'Choose a new password', footer: 'If you did not ask for this, ignore this email; your password stays the same.', origin }),
  };
}

/** Outbound mail per UTC day when EMAIL_DAILY_LIMIT is unset (the Paid plan includes 3,000 a month). */
export const DEFAULT_DAILY_MAIL_LIMIT = 300;

/** The daily outbound ceiling: EMAIL_DAILY_LIMIT (1 to 100,000), else the default. */
export function dailyMailLimit(env) {
  const raw = typeof env?.EMAIL_DAILY_LIMIT === 'string' ? env.EMAIL_DAILY_LIMIT.trim() : String(env?.EMAIL_DAILY_LIMIT ?? '');
  const n = /^[0-9]{1,6}$/.test(raw) ? Number(raw) : NaN;
  return n >= 1 && n <= 100000 ? n : DEFAULT_DAILY_MAIL_LIMIT;
}

/** Mail sent today (UTC) and the ceiling, for the admin stats. */
export async function mailBudget(ctx) {
  const limit = dailyMailLimit(ctx.env);
  const sentToday = await ctx.peekQuota('mail-global', 'all', DAY);
  return { sentToday, dailyLimit: limit, limitReached: sentToday >= limit };
}

/**
 * Take one unit of the daily outbound ceiling (every message counts, links,
 * notices and resets alike). False when the ceiling is reached: then nothing
 * is sent until the next UTC day, the requester's answer stays the same, and
 * the admin dashboard shows it.
 */
export async function takeMailBudget(ctx) {
  if (await ctx.limitSoft('mail-global', 'all', dailyMailLimit(ctx.env), DAY)) return true;
  console.warn('email daily limit reached: not sending');
  return false;
}

/**
 * Send one message from EMAIL_FROM. Returns true when the binding accepted
 * it, false when email is unavailable, the daily ceiling is reached (unless
 * the caller already took its unit: `budgeted`), or sending failed. Failures
 * are logged with Email Service's error code only (E_RATE_LIMIT_EXCEEDED,
 * E_DAILY_LIMIT_EXCEEDED, E_SENDER_NOT_VERIFIED, ...), never the address
 * or the message.
 */
export async function sendEmail(ctx, to, message, { budgeted = false } = {}) {
  const env = ctx.env;
  if (!services(env).email) return false;
  if (!budgeted && !(await takeMailBudget(ctx))) return false;
  try {
    await env.EMAIL.send({ from: emailSender(env), to, subject: message.subject, html: message.html, text: message.text });
    return true;
  } catch (err) {
    const code = typeof err?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(err.code) ? err.code : 'unknown';
    logError('email send failed', new Error(`email send failed: ${code}`));
    return false;
  }
}

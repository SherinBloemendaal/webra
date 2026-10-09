// Email links (verification, email change, password reset) and sending them
// through Cloudflare Email Sending (`env.EMAIL.send`). Without the binding
// (the Workers Paid plan is needed for it) email is reported unavailable and
// nothing here is called; docs/deploy.md describes how to enable it.

import { randomToken, sha256Hex } from '../crypto.js';
import { services } from './site.js';

export const SENDER = 'noreply@webra.sherin.dev';
export const ACCOUNT_PAGE = '/account/';
export const TOKEN_TTL_MS = {
  verify: 24 * 60 * 60 * 1000,
  change: 24 * 60 * 60 * 1000,
  reset: 60 * 60 * 1000,
  adminReset: 24 * 60 * 60 * 1000,
};

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * A new single-use token for `purpose`; older tokens of the same purpose for
 * the account are deleted in the same batch. Returns { token, expiresAt }.
 */
export async function createEmailToken(db, userId, purpose, email, ttlMs, now = Date.now()) {
  const token = randomToken();
  const expiresAt = now + ttlMs;
  await db.batch([
    db.prepare('DELETE FROM email_tokens WHERE user_id = ?1 AND purpose = ?2').bind(userId, purpose),
    db
      .prepare('INSERT INTO email_tokens (token_hash, user_id, purpose, email, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
      .bind(await sha256Hex(token), userId, purpose, email, now, expiresAt),
  ]);
  return { token, expiresAt };
}

/**
 * Use a token: it is deleted whatever happens next (single use). Returns the
 * row when it existed, had one of `purposes` and had not expired, else null.
 */
export async function consumeEmailToken(db, token, purposes, now = Date.now()) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  const row = await db.prepare('DELETE FROM email_tokens WHERE token_hash = ?1 RETURNING *').bind(await sha256Hex(token)).first();
  if (!row || !purposes.includes(row.purpose) || row.expires_at <= now) return null;
  return row;
}

export function accountLink(origin, kind, token) {
  return `${origin}${ACCOUNT_PAGE}#${kind}=${token}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function layout(title, lines, url, buttonText, footer) {
  const text = [...lines, '', url, '', footer, '', 'WebRA, https://webra.sherin.dev'].join('\n');
  const html = `<!doctype html><html><body style="font-family:sans-serif;line-height:1.5;color:#222">
<h1 style="font-size:20px">${escapeHtml(title)}</h1>
${lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('\n')}
<p><a href="${escapeHtml(url)}" style="display:inline-block;padding:10px 16px;background:#b8402a;color:#fff;text-decoration:none;border-radius:4px">${escapeHtml(buttonText)}</a></p>
<p style="font-size:13px;color:#555">Or open this link: ${escapeHtml(url)}</p>
<p style="font-size:13px;color:#555">${escapeHtml(footer)}</p>
</body></html>`;
  return { text, html };
}

export function verifyMessage(username, url, change = false) {
  const title = change ? 'Confirm your new email address' : 'Confirm your email address';
  const lines = [
    `Hello ${username},`,
    change
      ? 'Someone (hopefully you) asked to use this address for a WebRA account. Open the link below within 24 hours to confirm it.'
      : 'Thanks for signing up for WebRA. Open the link below within 24 hours to confirm your email address.',
  ];
  return { subject: `WebRA: ${title.toLowerCase()}`, ...layout(title, lines, url, 'Confirm email', 'If you did not ask for this, ignore this email.') };
}

export function resetMessage(username, url, hours) {
  const title = 'Reset your password';
  const lines = [`Hello ${username},`, `Open the link below within ${hours} ${hours === 1 ? 'hour' : 'hours'} to choose a new WebRA password. The link works once.`];
  return { subject: 'WebRA: reset your password', ...layout(title, lines, url, 'Choose a new password', 'If you did not ask for this, ignore this email; your password stays the same.') };
}

/**
 * Send one message. Returns true when the binding accepted it, false when
 * email is unavailable or sending failed (logged without the address).
 */
export async function sendEmail(env, to, message) {
  if (!services(env).email) return false;
  try {
    await env.EMAIL.send({ from: SENDER, to, subject: message.subject, html: message.html, text: message.text });
    return true;
  } catch (err) {
    console.error('email send failed', err?.name, err?.message);
    return false;
  }
}

// Test-only route for the end-to-end smoke test under `wrangler dev`
// (docs/accounts-api.md, section 10). It exists only when ALL of these hold:
//
// - the variable WEBRA_DEV_ROUTES is "1" (passed with `wrangler dev --var
//   WEBRA_DEV_ROUTES:1`; it is never in wrangler.jsonc, a test checks that),
// - the request is plain HTTP (production is HTTPS only),
// - the request's host is localhost, 127.0.0.1 or [::1].
//
// Otherwise the path answers 404 like any unknown endpoint.
//
// With WEBRA_DEV_MAIL "1" as well (and no real EMAIL binding), account mail
// goes to an in-memory outbox instead of Email Service, readable through
// GET /api/dev/mail?to=<address>, so the end-to-end email test runs under
// plain `wrangler dev` (test/e2e/email.mjs).

import { ACCOUNT_ROLES } from '@webra/protocol';
import { HttpError, json } from '../http.js';
import { invalid } from './context.js';
import { userByUsername } from './users.js';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function devRoutesEnabled(request, env) {
  const url = new URL(request.url);
  return env?.WEBRA_DEV_ROUTES === '1' && url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname);
}

export function devMailEnabled(request, env) {
  return devRoutesEnabled(request, env) && env?.WEBRA_DEV_MAIL === '1';
}

/** The development outbox (this isolate only, the newest DEV_OUTBOX_MAX messages). */
export const DEV_OUTBOX_MAX = 200;
const outbox = [];
const devMailer = Object.freeze({
  async send(message) {
    outbox.push({ from: message.from, to: message.to, subject: message.subject, text: message.text, html: message.html, at: Date.now() });
    if (outbox.length > DEV_OUTBOX_MAX) outbox.shift();
    return { messageId: `dev-${Date.now()}-${outbox.length}` };
  },
});

/** The environment for a request: with the development outbox as EMAIL when devMailEnabled and no binding exists. */
export function withDevMail(request, env) {
  if (env?.EMAIL || !devMailEnabled(request, env)) return env;
  return { ...env, EMAIL: devMailer, EMAIL_FROM: env.EMAIL_FROM || 'noreply@webra.localhost' };
}

/** GET /api/dev/mail?to=<address>: the outbox messages to that address, oldest first. */
async function devMail(ctx) {
  if (!devMailEnabled(ctx.request, ctx.env)) throw new HttpError(404, 'not_found', 'No such API endpoint.');
  const to = ctx.url.searchParams.get('to') ?? '';
  return json({ messages: outbox.filter((m) => m.to === to) });
}

/** POST /api/dev/promote { username, role }: role and status active, sessions revoked. */
async function promote(ctx) {
  if (!devRoutesEnabled(ctx.request, ctx.env)) throw new HttpError(404, 'not_found', 'No such API endpoint.');
  const body = await ctx.body(['username', 'role']);
  if (!ACCOUNT_ROLES.includes(body.role)) throw invalid('role', 'Unknown role.');
  if (typeof body.username !== 'string') throw invalid('username', 'Username required.');
  const row = await userByUsername(ctx.db, body.username, ctx.now);
  if (!row) throw new HttpError(404, 'not_found', 'No such user.');
  await ctx.db.batch([
    ctx.db
      .prepare("UPDATE users SET role = ?2, status = 'active', approved_at = COALESCE(approved_at, ?3) WHERE id = ?1")
      .bind(row.id, body.role, ctx.now),
    ctx.db.prepare('DELETE FROM auth_sessions WHERE user_id = ?1').bind(row.id),
  ]);
  return json({ id: row.id, role: body.role });
}

export function registerDevRoutes(router) {
  router.add('POST', '/api/dev/promote', promote, { dev: true }).add('GET', '/api/dev/mail', devMail, { dev: true, csrfRead: true });
}

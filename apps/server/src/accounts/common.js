// Helpers shared by the account routes.

import { json } from '../http.js';
import { createSession, rotateSession } from './sessions.js';
import { closeUserSockets, revoke } from '../realtime/publish.js';
import { selfUser, userById } from './users.js';

/** The address waiting for its change link, or null. */
export async function pendingEmailOf(db, userId, now = Date.now()) {
  const row = await db
    .prepare("SELECT email FROM email_tokens WHERE user_id = ?1 AND purpose = 'change' AND expires_at > ?2 ORDER BY created_at DESC LIMIT 1")
    .bind(userId, now)
    .first();
  return row?.email ?? null;
}

/**
 * UserSelf for a user id (reloaded so every change is reflected).
 * `pendingEmail` overrides the stored one (its token is written after the
 * answer, src/accounts/verification.js).
 */
export async function selfView(ctx, userId, { pendingEmail } = {}) {
  const row = await userById(ctx.db, userId, ctx.now);
  return selfUser(row, await ctx.eff(), pendingEmail ?? (await pendingEmailOf(ctx.db, userId, ctx.now)));
}

/** Start a session for the account and answer `{ user }`. */
export async function signIn(ctx, userId, status = 200) {
  const s = await createSession(ctx.env, ctx.request, ctx.ip, userId, ctx.now);
  closeReplaced(ctx, s.replaced);
  ctx.cookies.push(s.cookie);
  return json({ user: await selfView(ctx, userId) }, status);
}

/** After the answer: close the realtime sockets of the sign-in a new one replaced in this browser. */
export function closeReplaced(ctx, replaced) {
  if (replaced) revoke(ctx, (env) => closeUserSockets(env, replaced.userId, { sids: [replaced.publicId], staff: replaced.role === null ? undefined : replaced.role !== 'user' }));
}

/** Rotate the current session id (after credential changes); `reauth` refreshes the proof time. */
export async function rotate(ctx, { reauth = false } = {}) {
  const { session } = await ctx.auth();
  if (!session) return;
  const r = await rotateSession(ctx.env, ctx.request, session, ctx.now, { reauth });
  if (r) ctx.cookies.push(r.cookie);
}

/** The stored status after the account's email was verified. */
export function statusAfterVerification(row, eff) {
  if (row.status !== 'pending_email') return row.status;
  return eff.approvalRequired ? 'pending_approval' : 'active';
}

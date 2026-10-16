// Publishing to the realtime hubs (src/userhub.js, docs/accounts-api.md
// 5.12) from the Worker's routes and from the session Durable Object.
//
// Every call is a hint that follows a committed D1 write: the receiving
// pages load the document again, so a lost or doubled hint costs at most a
// poll's delay or one extra request. Nothing here may fail a request:
// routes publish through `notify` and `revoke` (after the answer, errors
// logged), the session object wraps its calls in try/catch. Without the
// USER_HUB binding (tests, an older Worker) every call does nothing.

import { logError } from '../telemetry.js';

/** Stub calls made at once (one slow object does not hold up the rest). */
const CHUNK = 20;
const USER_ID_RE = /^[0-9a-f]{32}$/;
const SID_RE = /^[0-9a-f]{16}$/;

/** Whether the hubs exist in this environment. */
export function realtimeOn(env) {
  return Boolean(env?.USER_HUB) && typeof env.USER_HUB.idFromName === 'function';
}

const hub = (env, name) => env.USER_HUB.get(env.USER_HUB.idFromName(name));

/** Run `call(id)` for every id, CHUNK at a time; `{ reached, failed }` (reached: what the calls returned, summed). */
async function fanOut(ids, call) {
  let reached = 0;
  let failed = 0;
  let first = null;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const results = await Promise.allSettled(ids.slice(i, i + CHUNK).map(call));
    for (const r of results) {
      if (r.status === 'fulfilled') reached += Number(r.value) || 0;
      else {
        failed++;
        first ??= r.reason;
      }
    }
  }
  if (first) logError('realtime publish failed', first);
  return { reached, failed };
}

/** One event (`{ topic, kind, data, origin }`) to the hubs of `userIds`. */
export async function publishToUsers(env, userIds, { topic, kind, data = null, origin = null }) {
  if (!realtimeOn(env)) return { reached: 0, failed: 0 };
  const ids = [...new Set(userIds)].filter((id) => typeof id === 'string' && USER_ID_RE.test(id));
  return fanOut(ids, (id) => hub(env, `user:${id}`).publish({ topic, kind, data, origin }));
}

/** The accounts `userId` is friends with (both sides of every friendships row). */
export async function friendIds(db, userId) {
  const { results } = await db
    .prepare('SELECT CASE WHEN user_a = ?1 THEN user_b ELSE user_a END AS id FROM friendships WHERE user_a = ?1 OR user_b = ?1')
    .bind(userId)
    .all();
  return results.map((r) => r.id);
}

/** One event to every friend of `userId` (one read, skipped without the binding). */
export async function publishToFriendsOf(env, db, userId, event) {
  if (!realtimeOn(env)) return { reached: 0, failed: 0 };
  return publishToUsers(env, await friendIds(db, userId), event);
}

/**
 * One event to the admin dashboard's hub (topic `admin`). `adminsOnly`: only
 * the dashboards of admins hear it (a change only admins may see, such as
 * guide progress; moderators share the object).
 */
export async function publishAdmin(env, { kind, data = null, origin = null, adminsOnly = false }) {
  if (!realtimeOn(env)) return { reached: 0, failed: 0 };
  return fanOut(['topic:admin'], (name) => hub(env, name).publish({ topic: 'admin', kind, data, origin, adminsOnly }));
}

/**
 * Close the sockets of ended sign-in sessions of `userId` (4001: the pages
 * ask who is signed in). `sids`: those sessions' public ids, or null for
 * all; `except`: one that stays. `staff`: the account is (or was) a
 * moderator or admin, so its sockets on the admin dashboard's hub close too;
 * undefined when the caller does not know (both are asked).
 */
export async function closeUserSockets(env, userId, { sids = null, except = null, staff } = {}) {
  if (!realtimeOn(env) || !USER_ID_RE.test(userId ?? '')) return { reached: 0, failed: 0 };
  const list = sids === null ? null : sids.filter((s) => typeof s === 'string' && SID_RE.test(s));
  if (list !== null && list.length === 0) return { reached: 0, failed: 0 };
  const names = staff === false ? [`user:${userId}`] : [`user:${userId}`, 'topic:admin'];
  return fanOut(names, (name) => hub(env, name).closeSessions({ sids: list, except, userId: name === 'topic:admin' ? userId : null }));
}

/**
 * Publish after the answer: `work(env)` runs under ctx.background (errors
 * logged, never answered) when the hubs exist and the site setting
 * `realtime` is on.
 */
export function notify(ctx, work) {
  if (!realtimeOn(ctx.env)) return Promise.resolve();
  return ctx.background('realtime publish', async () => {
    if (!(await ctx.eff()).realtime) return;
    await work(ctx.env);
  });
}

/**
 * Close sockets after the answer: like `notify`, but also while the setting
 * is off (sockets opened before it was switched off still end with their
 * sign-in session).
 */
export function revoke(ctx, work) {
  if (!realtimeOn(ctx.env)) return Promise.resolve();
  return ctx.background('realtime close', () => work(ctx.env));
}

/** The public id of the request's sign-in session (the `origin` of what it changed), or null. */
export async function originOf(ctx) {
  return (await ctx.auth()).session?.public_id ?? null;
}

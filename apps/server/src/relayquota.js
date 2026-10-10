// The one-click relays' budgets (content.js for ra-quickinstall.zip,
// cdmusic.js for the music) as the admin dashboard sees them: what an
// account has used, and what the networks it was recently seen on have
// used, with a reset for both (docs/accounts-api.md 8.10). The counters live
// in the D1 quota table under salted hashes (quota.js), so they can only be
// found from the account id and the addresses of its IP history, never
// listed or reversed.

import { networkOf } from './accounts/ip.js';
import { clearQuota, peekQuota } from './quota.js';
import { CONTENT_ACCOUNT_ATTEMPTS, CONTENT_ACCOUNT_LIMIT, CONTENT_ACCOUNT_WINDOW_MS, CONTENT_NET_ATTEMPTS, CONTENT_NET_LIMIT, CONTENT_NET_WINDOW_MS } from './content.js';
import { SCORES_ACCOUNT_ATTEMPTS, SCORES_DAILY_MIB, SCORES_DAY_MS, SCORES_IP_LIMIT, SCORES_IP_WINDOW_MS } from './cdmusic.js';

/**
 * Every relay budget: `id` names it in the admin view, `purpose` is its
 * quota purpose, `scope` whether it counts per account or per network.
 */
export const RELAY_BUDGETS = Object.freeze([
  Object.freeze({ id: 'content', purpose: 'content-account', scope: 'account', unit: 'downloads', limit: CONTENT_ACCOUNT_LIMIT, windowMs: CONTENT_ACCOUNT_WINDOW_MS }),
  Object.freeze({ id: 'music', purpose: 'scores-bytes', scope: 'account', unit: 'MiB', limit: SCORES_DAILY_MIB, windowMs: SCORES_DAY_MS }),
  Object.freeze({ id: 'contentAttempts', purpose: 'content-account-tries', scope: 'account', unit: 'requests', limit: CONTENT_ACCOUNT_ATTEMPTS, windowMs: CONTENT_ACCOUNT_WINDOW_MS }),
  Object.freeze({ id: 'musicAttempts', purpose: 'scores-account-tries', scope: 'account', unit: 'requests', limit: SCORES_ACCOUNT_ATTEMPTS, windowMs: SCORES_DAY_MS }),
  Object.freeze({ id: 'content', purpose: 'content-net', scope: 'network', unit: 'downloads', limit: CONTENT_NET_LIMIT, windowMs: CONTENT_NET_WINDOW_MS }),
  Object.freeze({ id: 'contentAttempts', purpose: 'content-tries', scope: 'network', unit: 'requests', limit: CONTENT_NET_ATTEMPTS, windowMs: CONTENT_NET_WINDOW_MS }),
  Object.freeze({ id: 'music', purpose: 'scores-ip', scope: 'network', unit: 'requests', limit: SCORES_IP_LIMIT, windowMs: SCORES_IP_WINDOW_MS }),
]);

/** Addresses of the IP history seen this recently count as the account's networks (the longest network window, with room). */
export const RELAY_NETWORK_RECENT_MS = 24 * 60 * 60 * 1000;

const budgets = (scope) => RELAY_BUDGETS.filter((b) => b.scope === scope);

/** The networks (accounts/ip.js networkOf) of the account's recent addresses, newest first, each once. */
async function recentNetworks(db, userId, now) {
  const { results } = await db
    .prepare('SELECT ip, last_seen FROM user_ips WHERE user_id = ?1 AND last_seen > ?2 ORDER BY last_seen DESC')
    .bind(userId, now - RELAY_NETWORK_RECENT_MS)
    .all();
  const out = new Map();
  for (const r of results) {
    const network = networkOf(r.ip);
    if (!out.has(network)) out.set(network, r.last_seen);
  }
  return [...out].map(([network, lastSeen]) => ({ network, lastSeen }));
}

async function usage(db, salt, list, subject, now) {
  const out = {};
  for (const b of list) {
    const start = Math.floor(now / b.windowMs) * b.windowMs;
    out[b.id] = { used: await peekQuota(db, salt, b.purpose, subject, b.windowMs, now), limit: b.limit, unit: b.unit, resetsAt: start + b.windowMs };
  }
  return out;
}

/**
 * What the account `userId` has used of each relay budget, and what its
 * recent networks have used: { account: { content, music }, networks:
 * [{ network, lastSeen, content, contentAttempts, music }] }, each budget
 * as { used, limit, unit, resetsAt }. Reads only.
 */
export async function relayQuotas(db, salt, userId, now = Date.now()) {
  const networks = [];
  for (const n of await recentNetworks(db, userId, now)) networks.push({ ...n, ...(await usage(db, salt, budgets('network'), n.network, now)) });
  return { account: await usage(db, salt, budgets('account'), userId, now), networks };
}

/**
 * Reset the account's relay budgets and those of its recent networks (other
 * people on those networks get their budgets back too). Returns what was
 * used before, without the addresses (for the audit log).
 */
export async function resetRelayQuotas(db, salt, userId, now = Date.now()) {
  const before = await relayQuotas(db, salt, userId, now);
  for (const b of budgets('account')) await clearQuota(db, salt, b.purpose, userId);
  for (const n of before.networks) for (const b of budgets('network')) await clearQuota(db, salt, b.purpose, n.network);
  const used = (o) => Object.fromEntries(Object.entries(o).map(([id, v]) => [id, v.used]));
  return {
    account: used(before.account),
    networks: before.networks.map(({ network: _network, lastSeen: _lastSeen, ...rest }) => used(rest)),
  };
}

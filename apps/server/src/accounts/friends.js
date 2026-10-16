// Friends, blocks, friend invites and the presence heartbeat:
// /api/account/friends/* and /api/account/presence (docs/accounts-api.md
// 5.11, docs/security.md "Friends and presence").
//
// Privacy rules, all enforced here:
// - only signed-in, active accounts have friends; everything is addressed
//   by username (already public in every lobby), never by account id;
// - a friend's status comes from the presence heartbeat, game_presence and
//   the session directory, and only while that friend's `social.showOnline`
//   is on (otherwise: offline, without a last-seen time);
// - a friend's session is named (id, name, map) only when it is public, or
//   for a lobby with the friend's `social.friendsJoin` on, or for a running
//   game with `social.allowSpectate` on;
// - blocking works both ways for requests and invites and ends the
//   friendship; a blocked sender cannot tell (its request just waits), and
//   session joins are refused by the session object (session.js);
// - requests, invites and blocks are rate limited per account;
// - realtime hints (src/realtime/publish.js) go out after each write and
//   tell the other side only what its own list will show: a hidden
//   request, an ignore, or a block of a player who was no friend sends
//   nothing to that player.

import { FRIEND_REQUEST_TTL_MS, FRIENDS_MAX, FRIEND_REQUESTS_IN_MAX, FRIEND_REQUESTS_OUT_MAX, BLOCKS_MAX, PRESENCE_ONLINE_MS, SOCIAL_SETTING_DEFAULTS, usernameKey } from '@webra/protocol';
import { HttpError, json } from '../http.js';
import { invalid } from './context.js';
import { HOUR } from './routes-auth.js';
import { LISTING_TTL_MS, parseMapJson } from '../directory.js';
import { liveInviteCode } from '../invites.js';
import { notify, originOf, publishToFriendsOf, publishToUsers } from '../realtime/publish.js';

const noContent = () => new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });

/** Requests sent, blocks and invites per account and hour. */
export const FRIEND_LIMITS = Object.freeze({ requests: 20, blocks: 30, invites: 30 });
/**
 * Presence heartbeats are stored at most every PRESENCE_WRITE_MS; a change
 * of away is stored sooner, but never within PRESENCE_CHANGE_MS of the last
 * write, so flipping the flag cannot turn the heartbeat into many writes.
 */
export const PRESENCE_WRITE_MS = 45_000;
export const PRESENCE_CHANGE_MS = 5_000;
const DAY = 24 * HOUR;

const notFound = () => new HttpError(404, 'not_found', 'No player with this name.');

/** The SQL pair (smaller id first) of two accounts. */
const pair = (a, b) => (a < b ? [a, b] : [b, a]);

/**
 * After the answer: `friends/<kind>` to each `[userId, username]` of
 * `targets` (`username`: the other party, for the page's message; null for
 * the player's own other tabs and devices, which show no message).
 */
function hint(ctx, kind, targets, extra = {}) {
  notify(ctx, async (env) => {
    const origin = await originOf(ctx);
    await Promise.all(
      targets.map(([id, username]) => publishToUsers(env, [id], { topic: 'friends', kind, data: username === null ? null : { username, ...extra }, origin })),
    );
  });
}

/** The active account named `username` (folded like signup), or null. */
async function accountByName(db, username) {
  if (typeof username !== 'string' || username.length < 1 || username.length > 64) return null;
  return db.prepare("SELECT id, username, display_name, avatar_color, status FROM users WHERE username_key = ?1 AND status = 'active'").bind(usernameKey(username)).first();
}

async function target(ctx, user, username) {
  const row = await accountByName(ctx.db, username);
  if (!row) throw notFound();
  if (row.id === user.id) throw invalid('username', 'That is you.');
  return row;
}

async function areFriends(db, a, b) {
  const [x, y] = pair(a, b);
  return (await db.prepare('SELECT 1 AS f FROM friendships WHERE user_a = ?1 AND user_b = ?2').bind(x, y).first()) !== null;
}

async function blocks(db, userId, blockedId) {
  return (await db.prepare('SELECT 1 AS b FROM user_blocks WHERE user_id = ?1 AND blocked_id = ?2').bind(userId, blockedId).first()) !== null;
}

const count = async (db, sql, ...args) => (await db.prepare(sql).bind(...args).first())?.n ?? 0;

const friendCount = (db, id) => count(db, 'SELECT COUNT(*) AS n FROM friendships WHERE user_a = ?1 OR user_b = ?1', id);

/** A JSON boolean of the settings document as SQLite reads it (1, 0 or null), with its default. */
const flag = (v, fallback) => (v === 1 || v === true ? true : v === 0 || v === false ? false : fallback);

/** Statements that remove every friends row of an account (deletion; the daily job does it for other deletions). */
export function friendsCleanupStatements(db, userId) {
  return [
    db.prepare('DELETE FROM friendships WHERE user_a = ?1 OR user_b = ?1').bind(userId),
    db.prepare('DELETE FROM friend_requests WHERE from_user = ?1 OR to_user = ?1').bind(userId),
    db.prepare('DELETE FROM user_blocks WHERE user_id = ?1 OR blocked_id = ?1').bind(userId),
    db.prepare('DELETE FROM friend_invites WHERE from_user = ?1 OR to_user = ?1').bind(userId),
    db.prepare('DELETE FROM user_presence WHERE user_id = ?1').bind(userId),
  ];
}

/** Hour precision for "last seen" (a friend learns roughly when, not to the minute). */
const hourOf = (t) => (t === null || t === undefined ? null : Math.floor(t / HOUR) * HOUR);

/** What a friend sees of a session its friend is in (null: not named, see the header). */
function friendSession(row, social, now) {
  const lobby = row.state === 'lobby';
  const visible = row.public === 1 || (lobby ? social.friendsJoin : social.allowSpectate);
  if (!visible) return null;
  let summary = null;
  try {
    summary = row.summary_json ? JSON.parse(row.summary_json) : null;
  } catch {
    summary = null;
  }
  const spectators = summary?.spectators ?? 0;
  const maxSpectators = summary?.maxSpectators ?? 0;
  return {
    id: row.id,
    name: row.name,
    state: lobby ? 'lobby' : 'game',
    players: row.players,
    maxPlayers: row.max_players,
    map: parseMapJson(row.map_json)?.name ?? null,
    mode: summary?.mode ?? null,
    locked: row.locked === 1,
    version: row.version,
    ...(summary?.startedAt ? { playingMs: Math.max(0, now - summary.startedAt) } : {}),
    spectators,
    maxSpectators,
    joinable: lobby && social.friendsJoin && row.players < row.max_players,
    spectatable: social.allowSpectate && spectators < maxSpectators,
  };
}

/** The friends list document (GET /api/account/friends). */
export async function friendsDocument(db, userId, now = Date.now()) {
  const all = async (sql, ...args) => (await db.prepare(sql).bind(...args).all()).results;
  const rows = await all(
    `SELECT u.id, u.username, u.display_name, u.avatar_color, u.last_seen_at, f.created_at AS since,
            p.seen_at, p.away_since,
            json_extract(d.doc, '$.social.showOnline') AS show_online,
            json_extract(d.doc, '$.social.friendsJoin') AS friends_join,
            json_extract(d.doc, '$.social.allowSpectate') AS allow_spectate
     FROM friendships f
     JOIN users u ON u.id = CASE WHEN f.user_a = ?1 THEN f.user_b ELSE f.user_a END
     LEFT JOIN user_presence p ON p.user_id = u.id
     LEFT JOIN settings_docs d ON d.user_id = u.id
     WHERE (f.user_a = ?1 OR f.user_b = ?1) AND u.status = 'active'
     ORDER BY u.username_key`,
    userId,
  );
  const sessions = new Map();
  if (rows.length) {
    const live = await all(
      `SELECT gp.user_id, s.id, s.name, s.public, s.locked, s.players, s.max_players, s.map_json, s.version, s.state, s.summary_json
       FROM game_presence gp JOIN sessions s ON s.id = gp.session_id
       WHERE gp.user_id IN (SELECT value FROM json_each(?1)) AND s.updated_at > ?2
       ORDER BY gp.updated_at DESC`,
      JSON.stringify(rows.map((r) => r.id)),
      now - LISTING_TTL_MS,
    );
    for (const r of live) if (!sessions.has(r.user_id)) sessions.set(r.user_id, r);
  }
  const friends = rows.map((r) => {
    const social = {
      showOnline: flag(r.show_online, SOCIAL_SETTING_DEFAULTS.showOnline),
      friendsJoin: flag(r.friends_join, SOCIAL_SETTING_DEFAULTS.friendsJoin),
      allowSpectate: flag(r.allow_spectate, SOCIAL_SETTING_DEFAULTS.allowSpectate),
    };
    const base = { username: r.username, displayName: r.display_name, avatarColor: r.avatar_color, since: r.since };
    if (!social.showOnline) return { ...base, status: 'offline', lastSeenAt: null };
    const sess = sessions.get(r.id);
    if (sess) {
      const view = friendSession(sess, social, now);
      return { ...base, status: sess.state === 'lobby' ? 'lobby' : 'game', ...(view ? { session: view } : {}) };
    }
    if (r.seen_at !== null && r.seen_at > now - PRESENCE_ONLINE_MS) {
      return r.away_since !== null ? { ...base, status: 'away', awayMs: Math.max(0, now - r.away_since) } : { ...base, status: 'online' };
    }
    return { ...base, status: 'offline', lastSeenAt: hourOf(Math.max(r.last_seen_at ?? 0, r.seen_at ?? 0) || null) };
  });
  const people = (sql) =>
    all(sql, userId).then((list) => list.map((r) => ({ username: r.username, displayName: r.display_name, avatarColor: r.avatar_color, createdAt: r.created_at })));
  const incoming = await people(
    `SELECT u.username, u.display_name, u.avatar_color, r.created_at FROM friend_requests r JOIN users u ON u.id = r.from_user
     WHERE r.to_user = ?1 AND r.ignored = 0 AND u.status = 'active' ORDER BY r.created_at DESC`,
  );
  // Ignored ones too: the sender cannot tell.
  const outgoing = await people(
    `SELECT u.username, u.display_name, u.avatar_color, r.created_at FROM friend_requests r JOIN users u ON u.id = r.to_user
     WHERE r.from_user = ?1 AND u.status = 'active' ORDER BY r.created_at DESC`,
  );
  const blocked = await people(
    `SELECT u.username, u.display_name, u.avatar_color, b.created_at FROM user_blocks b JOIN users u ON u.id = b.blocked_id
     WHERE b.user_id = ?1 AND u.status = 'active' ORDER BY u.username_key`,
  );
  const inviteRows = async (mine, other) =>
    all(
      `SELECT u.username, i.session_id, i.code, i.created_at, i.expires_at, s.name, s.players, s.max_players, s.map_json, s.locked
       FROM friend_invites i
       JOIN users u ON u.id = i.${other}
       JOIN invite_codes c ON c.code = i.code AND c.session_id = i.session_id AND c.expires_at > ?2
       LEFT JOIN sessions s ON s.id = i.session_id
       WHERE i.${mine} = ?1 AND u.status = 'active'
       ORDER BY i.created_at DESC`,
      userId,
      now,
    );
  const inviteView = (r) => ({
    username: r.username,
    session: r.session_id,
    code: r.code,
    name: r.name ?? null,
    players: r.players ?? null,
    maxPlayers: r.max_players ?? null,
    map: parseMapJson(r.map_json)?.name ?? null,
    locked: r.locked === 1,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  });
  const invites = (await inviteRows('to_user', 'from_user')).map(inviteView);
  const sentInvites = (await inviteRows('from_user', 'to_user')).map(inviteView);
  const own = await db
    .prepare(
      `SELECT json_extract(doc, '$.social.showOnline') AS show_online, json_extract(doc, '$.social.friendsJoin') AS friends_join,
              json_extract(doc, '$.social.allowSpectate') AS allow_spectate FROM settings_docs WHERE user_id = ?1`,
    )
    .bind(userId)
    .first();
  return {
    friends,
    incoming,
    outgoing,
    blocked,
    invites,
    sentInvites,
    privacy: {
      showOnline: flag(own?.show_online, SOCIAL_SETTING_DEFAULTS.showOnline),
      friendsJoin: flag(own?.friends_join, SOCIAL_SETTING_DEFAULTS.friendsJoin),
      allowSpectate: flag(own?.allow_spectate, SOCIAL_SETTING_DEFAULTS.allowSpectate),
    },
    limits: { friends: FRIENDS_MAX, outgoing: FRIEND_REQUESTS_OUT_MAX, blocked: BLOCKS_MAX },
  };
}

// ---- Routes ------------------------------------------------------------------------------------

async function me(ctx) {
  return ctx.requireUser({ active: true });
}

async function getFriends(ctx) {
  const user = await me(ctx);
  // The game polls every 30 s; a burst limit keeps a loop from costing many reads.
  await ctx.burst('friends-list', [240, HOUR]);
  return json(await friendsDocument(ctx.db, user.id, ctx.now));
}

async function friendView(ctx, userId, username) {
  const doc = await friendsDocument(ctx.db, userId, ctx.now);
  return doc.friends.find((f) => f.username === username) ?? null;
}

/** Make two accounts friends (both requests go), within the friend limit. */
async function befriend(ctx, user, other) {
  if ((await friendCount(ctx.db, user.id)) >= FRIENDS_MAX) throw new HttpError(409, 'limit', `At most ${FRIENDS_MAX} friends.`);
  if ((await friendCount(ctx.db, other.id)) >= FRIENDS_MAX) throw new HttpError(409, 'limit', 'This player has too many friends.');
  const [a, b] = pair(user.id, other.id);
  await ctx.db.batch([
    ctx.db.prepare('INSERT OR IGNORE INTO friendships (user_a, user_b, created_at) VALUES (?1, ?2, ?3)').bind(a, b, ctx.now),
    ctx.db.prepare('DELETE FROM friend_requests WHERE (from_user = ?1 AND to_user = ?2) OR (from_user = ?2 AND to_user = ?1)').bind(user.id, other.id),
  ]);
}

/**
 * Send a request by username. Answers 201 { request } (waiting), or 200
 * { friend } when the other player had already asked (both wanted it). A
 * player who blocked the sender, or who has too many open requests, never
 * sees it, and the sender cannot tell.
 */
async function sendRequest(ctx) {
  const body = await ctx.body(['username']);
  const user = await me(ctx);
  // Counted before the name is looked up, so the route is no faster a username oracle than this limit.
  await ctx.limit('friend-request', user.id, FRIEND_LIMITS.requests, HOUR, 'You sent many friend requests. Try again later.');
  const other = await target(ctx, user, body.username);
  if (await blocks(ctx.db, user.id, other.id)) throw new HttpError(409, 'blocked', 'You blocked this player. Unblock them first.');
  if (await areFriends(ctx.db, user.id, other.id)) throw new HttpError(409, 'conflict', 'You are friends already.');
  const reverse = await ctx.db.prepare('SELECT 1 AS r FROM friend_requests WHERE from_user = ?1 AND to_user = ?2').bind(other.id, user.id).first();
  if (reverse && !(await blocks(ctx.db, other.id, user.id))) {
    await befriend(ctx, user, other);
    hint(ctx, 'accept', [
      [other.id, user.username],
      [user.id, other.username],
    ]);
    return json({ friend: await friendView(ctx, user.id, other.username) });
  }
  if ((await count(ctx.db, 'SELECT COUNT(*) AS n FROM friend_requests WHERE from_user = ?1', user.id)) >= FRIEND_REQUESTS_OUT_MAX) {
    throw new HttpError(409, 'limit', `At most ${FRIEND_REQUESTS_OUT_MAX} open requests. Withdraw some first.`);
  }
  const hidden =
    (await blocks(ctx.db, other.id, user.id)) ||
    (await count(ctx.db, 'SELECT COUNT(*) AS n FROM friend_requests WHERE to_user = ?1 AND ignored = 0', other.id)) >= FRIEND_REQUESTS_IN_MAX;
  const r = await ctx.db
    .prepare('INSERT OR IGNORE INTO friend_requests (from_user, to_user, created_at, ignored) VALUES (?1, ?2, ?3, ?4)')
    .bind(user.id, other.id, ctx.now, hidden ? 1 : 0)
    .run();
  if (r.meta.changes !== 1) throw new HttpError(409, 'conflict', 'You already asked this player.');
  // A hidden request (blocked, or too many waiting) must look like any other to the sender and stay unseen.
  hint(ctx, 'request', hidden ? [[user.id, null]] : [[other.id, user.username], [user.id, null]]);
  return json({ request: { username: other.username, displayName: other.display_name, avatarColor: other.avatar_color, createdAt: ctx.now } }, 201);
}

/** The request `username` sent to the signed-in player (ignored ones too), or 404. */
async function incomingFrom(ctx, user, username) {
  const other = await accountByName(ctx.db, username);
  const row = other && (await ctx.db.prepare('SELECT ignored FROM friend_requests WHERE from_user = ?1 AND to_user = ?2').bind(other.id, user.id).first());
  if (!row) throw new HttpError(404, 'not_found', 'No request from this player.');
  return other;
}

async function acceptRequest(ctx, { username }) {
  const user = await me(ctx);
  const other = await incomingFrom(ctx, user, username);
  // A request kept hidden because the receiver blocked the sender cannot be accepted by name.
  if ((await blocks(ctx.db, user.id, other.id)) || (await blocks(ctx.db, other.id, user.id))) {
    throw new HttpError(409, 'blocked', 'You blocked this player. Unblock them first.');
  }
  await befriend(ctx, user, other);
  hint(ctx, 'accept', [
    [other.id, user.username],
    [user.id, other.username],
  ]);
  return json({ friend: await friendView(ctx, user.id, other.username) });
}

async function ignoreRequest(ctx, { username }) {
  const user = await me(ctx);
  const other = await incomingFrom(ctx, user, username);
  await ctx.db.prepare('UPDATE friend_requests SET ignored = 1 WHERE from_user = ?1 AND to_user = ?2').bind(other.id, user.id).run();
  // Ignoring is invisible to the sender: only this player's other tabs hear of it.
  hint(ctx, 'ignore', [[user.id, null]]);
  return noContent();
}

async function withdrawRequest(ctx, { username }) {
  const user = await me(ctx);
  const other = await accountByName(ctx.db, username);
  const row = other ? await ctx.db.prepare('DELETE FROM friend_requests WHERE from_user = ?1 AND to_user = ?2 RETURNING ignored').bind(user.id, other.id).first() : null;
  if (!row) throw new HttpError(404, 'not_found', 'No request to this player.');
  // The receiver hears only of a request it could see (not an ignored or hidden one).
  hint(ctx, 'withdraw', row.ignored === 0 ? [[other.id, user.username], [user.id, null]] : [[user.id, null]]);
  return noContent();
}

async function removeFriend(ctx, { username }) {
  const user = await me(ctx);
  const other = await accountByName(ctx.db, username);
  if (!other || !(await areFriends(ctx.db, user.id, other.id))) throw new HttpError(404, 'not_found', 'This player is not your friend.');
  const [a, b] = pair(user.id, other.id);
  await ctx.db.batch([
    ctx.db.prepare('DELETE FROM friendships WHERE user_a = ?1 AND user_b = ?2').bind(a, b),
    ctx.db.prepare('DELETE FROM friend_invites WHERE (from_user = ?1 AND to_user = ?2) OR (from_user = ?2 AND to_user = ?1)').bind(user.id, other.id),
  ]);
  hint(ctx, 'remove', [
    [other.id, user.username],
    [user.id, null],
  ]);
  return noContent();
}

/** Block by username: no requests, invites or session joins from them; any friendship, request or invite between the two ends. */
async function block(ctx) {
  const body = await ctx.body(['username']);
  const user = await me(ctx);
  await ctx.limit('block', user.id, FRIEND_LIMITS.blocks, HOUR, 'You blocked many players. Try again later.');
  const other = await target(ctx, user, body.username);
  if ((await count(ctx.db, 'SELECT COUNT(*) AS n FROM user_blocks WHERE user_id = ?1', user.id)) >= BLOCKS_MAX) {
    throw new HttpError(409, 'limit', `At most ${BLOCKS_MAX} blocked players.`);
  }
  // A blocked friend sees the friendship end, like a removal; anyone else hears nothing.
  const wereFriends = await areFriends(ctx.db, user.id, other.id);
  const [a, b] = pair(user.id, other.id);
  await ctx.db.batch([
    ctx.db.prepare('INSERT OR IGNORE INTO user_blocks (user_id, blocked_id, created_at) VALUES (?1, ?2, ?3)').bind(user.id, other.id, ctx.now),
    ctx.db.prepare('DELETE FROM friendships WHERE user_a = ?1 AND user_b = ?2').bind(a, b),
    ctx.db.prepare('DELETE FROM friend_requests WHERE (from_user = ?1 AND to_user = ?2) OR (from_user = ?2 AND to_user = ?1)').bind(user.id, other.id),
    ctx.db.prepare('DELETE FROM friend_invites WHERE (from_user = ?1 AND to_user = ?2) OR (from_user = ?2 AND to_user = ?1)').bind(user.id, other.id),
  ]);
  hint(ctx, 'block', [[user.id, null]]);
  if (wereFriends) hint(ctx, 'remove', [[other.id, user.username]]);
  return noContent();
}

async function unblock(ctx, { username }) {
  const user = await me(ctx);
  const other = await accountByName(ctx.db, username);
  const r = other ? await ctx.db.prepare('DELETE FROM user_blocks WHERE user_id = ?1 AND blocked_id = ?2').bind(user.id, other.id).run() : null;
  if (!r || r.meta.changes !== 1) throw new HttpError(404, 'not_found', 'You did not block this player.');
  hint(ctx, 'unblock', [[user.id, null]]);
  return noContent();
}

const SESSION_ID_RE = /^[0-9a-f]{64}$/;

/**
 * Invite a friend into the session the signed-in player is in, with the
 * lobby's invite code (the host makes one first: 409 `no_code` otherwise).
 */
async function invite(ctx) {
  const body = await ctx.body(['username', 'session']);
  const user = await me(ctx);
  if (typeof body.session !== 'string' || !SESSION_ID_RE.test(body.session)) throw invalid('session', 'Name the session.');
  await ctx.limit('friend-invite', user.id, FRIEND_LIMITS.invites, HOUR, 'You sent many invites. Try again later.');
  const other = await accountByName(ctx.db, body.username);
  if (!other || other.id === user.id || !(await areFriends(ctx.db, user.id, other.id))) throw new HttpError(404, 'not_found', 'This player is not your friend.');
  const member = await ctx.db.prepare('SELECT 1 AS m FROM game_presence WHERE session_id = ?1 AND user_id = ?2').bind(body.session, user.id).first();
  if (!member) throw new HttpError(403, 'forbidden', 'You are not in this session.');
  const code = await liveInviteCode(ctx.db, body.session, ctx.now);
  if (!code) throw new HttpError(409, 'no_code', 'This lobby has no invite code. The host can make one.');
  await ctx.db
    .prepare(
      `INSERT INTO friend_invites (from_user, to_user, session_id, code, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(from_user, to_user) DO UPDATE SET session_id = excluded.session_id, code = excluded.code,
         created_at = excluded.created_at, expires_at = excluded.expires_at`,
    )
    .bind(user.id, other.id, body.session, code.code, ctx.now, code.expiresAt)
    .run();
  hint(ctx, 'invite', [[other.id, user.username]], { session: body.session });
  hint(ctx, 'invite', [[user.id, null]]);
  return json({ invite: { username: other.username, session: body.session, code: code.code, createdAt: ctx.now, expiresAt: code.expiresAt } }, 201);
}

/** Dismiss the invite `username` sent (or withdraw one sent to `username` with ?sent=1). */
async function dismissInvite(ctx, { username }) {
  const user = await me(ctx);
  const other = await accountByName(ctx.db, username);
  const sent = ctx.url.searchParams.get('sent') === '1';
  const r = other
    ? await ctx.db
        .prepare('DELETE FROM friend_invites WHERE from_user = ?1 AND to_user = ?2')
        .bind(sent ? user.id : other.id, sent ? other.id : user.id)
        .run()
    : null;
  if (!r || r.meta.changes !== 1) throw new HttpError(404, 'not_found', 'No such invite.');
  hint(ctx, 'invite_dismiss', [
    [other.id, user.username],
    [user.id, null],
  ]);
  return noContent();
}

/**
 * The presence heartbeat: the game is open (`away`: no input for a while,
 * `idleMs` how long). Stored at most every PRESENCE_WRITE_MS, a change of
 * `away` at most every PRESENCE_CHANGE_MS; a burst limit per address on top.
 */
async function presence(ctx) {
  const body = await ctx.body(['away', 'idleMs']);
  if (typeof body.away !== 'boolean') throw invalid('away', 'away must be true or false.');
  let idle = 0;
  if (body.idleMs !== undefined) {
    if (!Number.isSafeInteger(body.idleMs) || body.idleMs < 0) throw invalid('idleMs', 'idleMs must be a whole number of milliseconds.');
    idle = Math.min(body.idleMs, DAY);
  }
  const user = await me(ctx);
  await ctx.burst('presence', [120, HOUR]);
  const away = body.away ? 1 : 0;
  const before = presenceState(await ctx.db.prepare('SELECT seen_at, away_since FROM user_presence WHERE user_id = ?1').bind(user.id).first(), ctx.now);
  const r = await ctx.db
    .prepare(
      `INSERT INTO user_presence (user_id, seen_at, away_since) VALUES (?1, ?2, CASE WHEN ?3 = 1 THEN ?4 ELSE NULL END)
       ON CONFLICT(user_id) DO UPDATE SET seen_at = excluded.seen_at,
         away_since = CASE WHEN ?3 = 1 THEN COALESCE(user_presence.away_since, excluded.away_since) ELSE NULL END
       WHERE user_presence.seen_at <= ?5 OR ((user_presence.away_since IS NULL) = (?3 = 1) AND user_presence.seen_at <= ?6)`,
    )
    .bind(user.id, ctx.now, away, ctx.now - idle, ctx.now - PRESENCE_WRITE_MS, ctx.now - PRESENCE_CHANGE_MS)
    .run();
  // Friends hear of a change (offline, online, away), not of every heartbeat. The hint names
  // nobody and says only "look again": the list of a player who hides their status still shows offline.
  const after = r.meta.changes > 0 ? (away ? 'away' : 'online') : before;
  if (after !== before) notify(ctx, (env) => publishToFriendsOf(env, ctx.db, user.id, { topic: 'friends', kind: 'presence' }));
  return noContent();
}

/** What a heartbeat row says (the list's rule, friendsDocument): offline, online or away. */
function presenceState(row, now) {
  if (!row || row.seen_at === null || row.seen_at <= now - PRESENCE_ONLINE_MS) return 'offline';
  return row.away_since !== null ? 'away' : 'online';
}

/** The account's friends data for the data export (docs/accounts-api.md 5.9). */
export async function friendsExport(db, userId, now = Date.now()) {
  const doc = await friendsDocument(db, userId, now);
  const presenceRow = await db.prepare('SELECT seen_at, away_since FROM user_presence WHERE user_id = ?1').bind(userId).first();
  return {
    friends: doc.friends.map((f) => ({ username: f.username, since: f.since })),
    incoming: doc.incoming,
    outgoing: doc.outgoing,
    blocked: doc.blocked,
    invites: doc.invites,
    sentInvites: doc.sentInvites,
    presence: presenceRow ? { seenAt: presenceRow.seen_at, awaySince: presenceRow.away_since } : null,
  };
}

/** Retention for the daily job: old requests, ended invites and stale heartbeats, and rows of deleted accounts. */
export function friendsRetentionStatements(db, now) {
  const deleted = "(SELECT id FROM users WHERE status = 'deleted')";
  return {
    friendRequests: db.prepare('DELETE FROM friend_requests WHERE created_at < ?1').bind(now - FRIEND_REQUEST_TTL_MS),
    friendInvites: db.prepare('DELETE FROM friend_invites WHERE expires_at < ?1').bind(now),
    presenceHeartbeats: db.prepare('DELETE FROM user_presence WHERE seen_at < ?1').bind(now - DAY),
    deletedFriends: db.prepare(`DELETE FROM friendships WHERE user_a IN ${deleted} OR user_b IN ${deleted}`).bind(),
    deletedRequests: db.prepare(`DELETE FROM friend_requests WHERE from_user IN ${deleted} OR to_user IN ${deleted}`).bind(),
    deletedBlocks: db.prepare(`DELETE FROM user_blocks WHERE user_id IN ${deleted} OR blocked_id IN ${deleted}`).bind(),
    deletedInvites: db.prepare(`DELETE FROM friend_invites WHERE from_user IN ${deleted} OR to_user IN ${deleted}`).bind(),
    deletedPresence: db.prepare(`DELETE FROM user_presence WHERE user_id IN ${deleted}`).bind(),
  };
}

export function registerFriendRoutes(router) {
  const csrfRead = { csrfRead: true };
  router
    .add('GET', '/api/account/friends', getFriends, csrfRead)
    .add('POST', '/api/account/friends/requests', sendRequest)
    .add('POST', '/api/account/friends/requests/:username/accept', acceptRequest)
    .add('POST', '/api/account/friends/requests/:username/ignore', ignoreRequest)
    .add('DELETE', '/api/account/friends/requests/:username', withdrawRequest)
    .add('POST', '/api/account/friends/blocks', block)
    .add('DELETE', '/api/account/friends/blocks/:username', unblock)
    .add('POST', '/api/account/friends/invites', invite)
    .add('DELETE', '/api/account/friends/invites/:username', dismissInvite)
    .add('DELETE', '/api/account/friends/:username', removeFriend)
    .add('POST', '/api/account/presence', presence);
}

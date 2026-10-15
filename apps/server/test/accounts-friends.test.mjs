// Friends, blocks, friend invites, presence (docs/accounts-api.md 5.11),
// invite codes over HTTP, the session list and the online count
// (docs/contracts.md section 4), and their retention.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FRIEND_REQUEST_TTL_MS, PRESENCE_ONLINE_MS } from '@webra/protocol';
import { Browser, Clock, makeEnv, ORIGIN, promote, scheduled, signup } from './accounts-harness.mjs';
import { clearDirectoryCache, upsertSession } from '../src/directory.js';
import { issueInviteCode } from '../src/invites.js';

const clock = new Clock();
test.after(() => clock.restore());
const HOUR = 60 * 60 * 1000;

/** A signed-in, active player. */
async function player(env, name) {
  const b = await signup(env, name);
  promote(env, b.user.id);
  return b;
}

const SID = (c) => c.repeat(64);

/** A directory row for a session (as its Durable Object writes it). */
async function session(env, id, { name = 'Friday night 2v2', isPublic = false, state = 'lobby', players = 2, summary } = {}) {
  await upsertSession(
    env.DB,
    {
      id,
      name,
      host: 'Karaa',
      public: isPublic,
      locked: false,
      players,
      maxPlayers: 4,
      map: null,
      version: '1.0.0',
      state,
      summary: summary ?? { players: [{ name: 'Karaa', team: 1, color: 0 }], spectators: 0, maxSpectators: 2, mode: 'competitive', options: {} },
    },
    Date.now(),
  );
}

const inSession = (env, sessionId, userId, client = 1) =>
  env.DB.sqlite.prepare('INSERT INTO game_presence (session_id, client, user_id, updated_at) VALUES (?, ?, ?, ?)').run(sessionId, client, userId, Date.now());

const setSocial = (env, userId, social) =>
  env.DB.sqlite
    .prepare('INSERT OR REPLACE INTO settings_docs (user_id, version, doc, updated_at) VALUES (?, 1, ?, 0)')
    .run(userId, JSON.stringify({ schema: 1, social }));

async function befriend(a, b) {
  assert.equal((await a.post('/api/account/friends/requests', { username: b.user.username })).status, 201);
  assert.equal((await b.post(`/api/account/friends/requests/${a.user.username}/accept`)).status, 200);
}

test('requests: send by username, accept, ignore, withdraw; asking back makes friends at once', async () => {
  const env = makeEnv({ email: false });
  const kara = await player(env, 'Karaa');
  const ivan = await player(env, 'Ivano');
  const mo = await player(env, 'Moira');
  const r = await kara.post('/api/account/friends/requests', { username: 'ivano' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.request.username, 'Ivano');
  assert.equal((await kara.post('/api/account/friends/requests', { username: 'Ivano' })).status, 409, 'once');
  assert.equal((await kara.post('/api/account/friends/requests', { username: 'Karaa' })).status, 400, 'not yourself');
  assert.equal((await kara.post('/api/account/friends/requests', { username: 'Nobody' })).status, 404);
  const ivanView = (await ivan.get('/api/account/friends')).body;
  assert.deepEqual(ivanView.incoming.map((x) => x.username), ['Karaa']);
  assert.deepEqual((await kara.get('/api/account/friends')).body.outgoing.map((x) => x.username), ['Ivano']);
  // Ignored: gone for Ivan, still waiting for Kara (she cannot tell).
  assert.equal((await ivan.post('/api/account/friends/requests/Karaa/ignore')).status, 204);
  assert.deepEqual((await ivan.get('/api/account/friends')).body.incoming, []);
  assert.deepEqual((await kara.get('/api/account/friends')).body.outgoing.map((x) => x.username), ['Ivano']);
  // Ivan changes his mind and asks Kara: both wanted it, so they are friends.
  const back = await ivan.post('/api/account/friends/requests', { username: 'Karaa' });
  assert.equal(back.status, 200);
  assert.equal(back.body.friend.username, 'Karaa');
  const k = (await kara.get('/api/account/friends')).body;
  assert.deepEqual(k.friends.map((f) => f.username), ['Ivano']);
  assert.deepEqual(k.outgoing, []);
  assert.equal((await kara.post('/api/account/friends/requests', { username: 'Ivano' })).status, 409, 'friends already');
  // Withdraw a request; accept one.
  await kara.post('/api/account/friends/requests', { username: 'Moira' });
  assert.equal((await kara.del('/api/account/friends/requests/Moira')).status, 204);
  assert.equal((await mo.post('/api/account/friends/requests/Karaa/accept')).status, 404);
  await mo.post('/api/account/friends/requests', { username: 'Karaa' });
  const acc = await kara.post('/api/account/friends/requests/Moira/accept');
  assert.equal(acc.status, 200);
  assert.deepEqual((await kara.get('/api/account/friends')).body.friends.map((f) => f.username).sort(), ['Ivano', 'Moira']);
  // Remove.
  assert.equal((await kara.del('/api/account/friends/Moira')).status, 204);
  assert.equal((await kara.del('/api/account/friends/Moira')).status, 404);
  assert.deepEqual((await mo.get('/api/account/friends')).body.friends, []);
});

test('friends need an active account, CSRF on reads and writes, and same-origin requests', async () => {
  const env = makeEnv({ email: false });
  const pending = await signup(env, 'Pending');
  assert.equal((await pending.get('/api/account/friends')).body.error.code, 'account_inactive');
  assert.equal((await new Browser(env).get('/api/account/friends')).status, 401);
  const kara = await player(env, 'Karaa');
  assert.equal((await kara.get('/api/account/friends', { csrf: false })).status, 403);
  assert.equal((await kara.post('/api/account/friends/requests', { username: 'Pending' }, { csrf: false })).status, 403);
  assert.equal((await kara.post('/api/account/friends/requests', { username: 'Pending' }, { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await kara.post('/api/account/friends/requests', { username: 'Pending' })).status, 404, 'inactive accounts cannot be asked');
  assert.equal((await kara.post('/api/account/friends/requests', { username: 'x', extra: 1 })).status, 400);
});

test('requests are rate limited per account; open requests are capped', async () => {
  const env = makeEnv({ email: false });
  const kara = await player(env, 'Karaa');
  for (let i = 0; i < 20; i++) await player(env, `Player${i}`);
  for (let i = 0; i < 20; i++) assert.equal((await kara.post('/api/account/friends/requests', { username: `Player${i}` })).status, 201);
  await player(env, 'Late');
  const limited = await kara.post('/api/account/friends/requests', { username: 'Late' });
  assert.equal(limited.status, 429);
  assert.ok(limited.body.error.retryAfter > 0);
});

test('blocking: ends the friendship, refuses requests and invites both ways; the blocked sender cannot tell', async () => {
  const env = makeEnv({ email: false });
  const kara = await player(env, 'Karaa');
  const pest = await player(env, 'Pester');
  await befriend(kara, pest);
  assert.equal((await kara.post('/api/account/friends/blocks', { username: 'Pester' })).status, 204);
  const k = (await kara.get('/api/account/friends')).body;
  assert.deepEqual(k.friends, []);
  assert.deepEqual(k.blocked.map((x) => x.username), ['Pester']);
  assert.deepEqual((await pest.get('/api/account/friends')).body.friends, []);
  // Pest asks again: accepted as if sent, never shown to Kara.
  const r = await pest.post('/api/account/friends/requests', { username: 'Karaa' });
  assert.equal(r.status, 201);
  assert.deepEqual((await pest.get('/api/account/friends')).body.outgoing.map((x) => x.username), ['Karaa']);
  assert.deepEqual((await kara.get('/api/account/friends')).body.incoming, []);
  // Kara cannot ask Pest without unblocking first.
  assert.equal((await kara.post('/api/account/friends/requests', { username: 'Pester' })).body.error.code, 'blocked');
  // Pest's waiting request does not make friends when Kara asks after unblocking: it was ignored.
  assert.equal((await kara.del('/api/account/friends/blocks/Pester')).status, 204);
  assert.equal((await kara.del('/api/account/friends/blocks/Pester')).status, 404);
  const ask = await kara.post('/api/account/friends/requests', { username: 'Pester' });
  assert.equal(ask.status, 200, 'both asked: friends (Kara chose to)');
});

test('status: online, away, in a lobby or a game, offline; privacy settings decide what friends see', async () => {
  const env = makeEnv({ email: false });
  const me = await player(env, 'Mehmet');
  const kara = await player(env, 'Karaa');
  const ivan = await player(env, 'Ivano');
  const mo = await player(env, 'Moira');
  const lena = await player(env, 'Lenaa');
  const tomas = await player(env, 'Tomas');
  for (const f of [kara, ivan, mo, lena, tomas]) await befriend(me, f);
  // Mo is in the main menu, Lena away for 12 minutes.
  assert.equal((await mo.post('/api/account/presence', { away: false })).status, 204);
  assert.equal((await lena.post('/api/account/presence', { away: true, idleMs: 12 * 60 * 1000 })).status, 204);
  // Ivan in a private lobby (friends may join), Kara in a private game (no spectators allowed by default).
  await session(env, SID('1'), { players: 3 });
  inSession(env, SID('1'), ivan.user.id);
  await session(env, SID('2'), { state: 'game', name: 'Skirmish', summary: { players: [], spectators: 0, maxSpectators: 2, mode: 'rush', options: {}, startedAt: Date.now() - 60_000 } });
  inSession(env, SID('2'), kara.user.id);
  const list = Object.fromEntries((await me.get('/api/account/friends')).body.friends.map((f) => [f.username, f]));
  assert.equal(list.Moira.status, 'online');
  assert.equal(list.Lenaa.status, 'away');
  assert.equal(list.Lenaa.awayMs, 12 * 60 * 1000);
  assert.equal(list.Ivano.status, 'lobby');
  assert.equal(list.Ivano.session.id, SID('1'));
  assert.equal(list.Ivano.session.joinable, true);
  assert.equal(list.Karaa.status, 'game');
  assert.equal(list.Karaa.session, undefined, 'a private game is not named unless the friend allows spectators');
  assert.equal(list.Tomas.status, 'offline');
  // Kara allows spectators: her game is named, with its play time.
  setSocial(env, kara.user.id, { allowSpectate: true });
  const k = (await me.get('/api/account/friends')).body.friends.find((f) => f.username === 'Karaa');
  assert.equal(k.session.spectatable, true);
  assert.equal(k.session.playingMs, 60_000);
  assert.equal(k.session.joinable, false);
  // Ivan does not let friends join: his private lobby is not named either.
  setSocial(env, ivan.user.id, { friendsJoin: false });
  assert.equal((await me.get('/api/account/friends')).body.friends.find((f) => f.username === 'Ivano').session, undefined);
  // Mo hides his status: offline, without a last-seen time.
  setSocial(env, mo.user.id, { showOnline: false });
  const hidden = (await me.get('/api/account/friends')).body.friends.find((f) => f.username === 'Moira');
  assert.deepEqual([hidden.status, hidden.lastSeenAt], ['offline', null]);
  // The heartbeat goes stale: offline, last seen to the hour.
  clock.advance(PRESENCE_ONLINE_MS + 1000);
  const later = (await me.get('/api/account/friends')).body.friends.find((f) => f.username === 'Lenaa');
  assert.equal(later.status, 'offline');
  assert.equal(later.lastSeenAt % HOUR, 0);
  // The own privacy settings come back too.
  assert.deepEqual((await kara.get('/api/account/friends')).body.privacy, { showOnline: true, friendsJoin: true, allowSpectate: true });
});

test('presence: written at most every 45 s unless away changes; validated', async () => {
  const env = makeEnv({ email: false });
  const mo = await player(env, 'Moira');
  const seen = () => env.DB.rows('SELECT seen_at, away_since FROM user_presence')[0];
  await mo.post('/api/account/presence', { away: false });
  const first = seen().seen_at;
  clock.advance(10_000);
  await mo.post('/api/account/presence', { away: false });
  assert.equal(seen().seen_at, first, 'too soon: not written');
  await mo.post('/api/account/presence', { away: true });
  assert.equal(seen().away_since, Date.now(), 'going away is written at once');
  clock.advance(50_000);
  await mo.post('/api/account/presence', { away: true });
  assert.equal(seen().seen_at, Date.now());
  assert.equal(seen().away_since, Date.now() - 50_000, 'away since stays');
  await mo.post('/api/account/presence', { away: false });
  assert.equal(seen().away_since, null);
  assert.equal((await mo.post('/api/account/presence', { away: 'yes' })).status, 400);
  assert.equal((await mo.post('/api/account/presence', { away: true, idleMs: -1 })).status, 400);
});

test('friend invites: only into your own session, with its live code; blocked and non-friends cannot be invited', async () => {
  const env = makeEnv({ email: false });
  const kara = await player(env, 'Karaa');
  const mo = await player(env, 'Moira');
  const stranger = await player(env, 'Stranger');
  await befriend(kara, mo);
  await session(env, SID('3'));
  const body = { username: 'Moira', session: SID('3') };
  assert.equal((await kara.post('/api/account/friends/invites', body)).status, 403, 'not in the session');
  inSession(env, SID('3'), kara.user.id);
  assert.equal((await kara.post('/api/account/friends/invites', body)).body.error.code, 'no_code');
  const code = await issueInviteCode(env.DB, SID('3'), Date.now(), Date.now() + HOUR);
  const r = await kara.post('/api/account/friends/invites', body);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.invite.code, code);
  const got = (await mo.get('/api/account/friends')).body.invites;
  assert.deepEqual(got.map((i) => [i.username, i.code, i.name]), [['Karaa', code, 'Friday night 2v2']]);
  assert.equal((await kara.get('/api/account/friends')).body.sentInvites.length, 1);
  assert.equal((await kara.post('/api/account/friends/invites', { username: 'Stranger', session: SID('3') })).status, 404);
  // The code ends: the invite is gone.
  clock.advance(HOUR + 1);
  assert.deepEqual((await mo.get('/api/account/friends')).body.invites, []);
  // Dismiss; and a block removes invites both ways.
  const code2 = await issueInviteCode(env.DB, SID('3'), Date.now(), Date.now() + HOUR);
  await kara.post('/api/account/friends/invites', body);
  assert.equal((await mo.del('/api/account/friends/invites/Karaa')).status, 204);
  assert.equal((await mo.del('/api/account/friends/invites/Karaa')).status, 404);
  await kara.post('/api/account/friends/invites', body);
  assert.equal((await kara.del('/api/account/friends/invites/Moira?sent=1')).status, 204, 'the sender withdraws');
  await kara.post('/api/account/friends/invites', body);
  await mo.post('/api/account/friends/blocks', { username: 'Karaa' });
  assert.deepEqual(env.DB.rows('SELECT * FROM friend_invites'), []);
  assert.ok(code2);
  void stranger;
});

test('invite codes over HTTP: lookup 404 / 410 / 200, guessing is limited, blocked players see nothing', async () => {
  const env = makeEnv({ email: false });
  const anon = new Browser(env, { ip: '203.0.113.5' });
  await session(env, SID('4'));
  const code = await issueInviteCode(env.DB, SID('4'), Date.now(), Date.now() + HOUR);
  const pretty = `${code.slice(0, 3)}-${code.slice(3)}`;
  const ok = await anon.get(`/api/invite/${pretty.toLowerCase()}`);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(
    [ok.body.invite.code, ok.body.invite.session, ok.body.invite.name, ok.body.invite.players, ok.body.invite.maxPlayers, ok.body.invite.locked, ok.body.invite.mode],
    [pretty, SID('4'), 'Friday night 2v2', 2, 4, false, 'competitive'],
  );
  assert.equal((await anon.get('/api/invite/ZZZ-ZZZ')).status, 404);
  assert.equal((await anon.get('/api/invite/0000')).status, 404, 'not a code at all');
  assert.equal((await anon.get('/api/invite/%E0%A4%A')).status, 404, 'malformed escapes');
  // Replaced: 410.
  const next = await issueInviteCode(env.DB, SID('4'), Date.now(), Date.now() + HOUR);
  assert.equal((await anon.get(`/api/invite/${code}`)).status, 410);
  // The lobby started: 410.
  await session(env, SID('4'), { state: 'game' });
  assert.equal((await anon.get(`/api/invite/${next}`)).status, 410);
  // A member who blocked the looker: 404 for that account only.
  await session(env, SID('5'));
  const code5 = await issueInviteCode(env.DB, SID('5'), Date.now(), Date.now() + HOUR);
  const kara = await player(env, 'Karaa');
  const pest = await player(env, 'Pester');
  inSession(env, SID('5'), kara.user.id);
  await kara.post('/api/account/friends/blocks', { username: 'Pester' });
  assert.equal((await pest.get(`/api/invite/${code5}`)).status, 404);
  assert.equal((await kara.get(`/api/invite/${code5}`)).status, 200);
  // Failed lookups lock the address out for a while.
  const guesser = new Browser(env, { ip: '203.0.113.99' });
  let last;
  for (let i = 0; i < 31; i++) last = await guesser.get(`/api/invite/ZZZ-ZZ${'23456789ABCDEFGHJKMNPQRSTUVWXYZ'[i]}`);
  assert.equal(last.status, 429);
  assert.equal((await guesser.get(`/api/invite/${code5}`)).status, 429, 'even a right guess waits');
});

test('POST /api/sessions/<id>/invite: CSRF, the member header and a quota; the session object decides', async () => {
  const env = makeEnv({ email: false });
  const kara = await player(env, 'Karaa');
  const calls = [];
  const realGet = env.SESSION.get.bind(env.SESSION);
  env.SESSION.get = (id) => ({ ...realGet(id), newInvite: async (input) => (calls.push(input), { ok: true, code: 'K7Q2MX', expiresAt: 99 }) });
  const path = `/api/sessions/${SID('6')}/invite`;
  const member = { 'X-WebRA-Member': `1.${'k'.repeat(43)}` };
  assert.equal((await kara.post(path, {}, { headers: member, csrf: false })).status, 403);
  assert.equal((await kara.post(path, {})).status, 403, 'needs the member header');
  const r = await kara.post(path, {}, { headers: member });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body, { code: 'K7Q-2MX', expiresAt: 99, path: '/join/K7Q-2MX' });
  assert.deepEqual(calls[0].member, { client: 1, key: 'k'.repeat(43) });
  assert.equal(calls[0].account.username, 'Karaa');
  env.SESSION.get = (id) => ({ ...realGet(id), newInvite: async () => ({ ok: false, status: 403, code: 'not_host', message: 'Only the host can make an invite code.' }) });
  assert.equal((await kara.post(path, {}, { headers: member })).body.error.code, 'not_host');
  assert.equal((await kara.get(path)).status, 405);
});

test('/join/<code> opens the game with the code; anything else is the 404 page', async () => {
  const env = makeEnv({ email: false });
  env.ASSETS = { fetch: async (req) => new Response(`asset ${new URL(req.url).pathname}`, { status: 404 }) };
  const b = new Browser(env);
  const r = await b.get('/join/k7q-2mx');
  assert.equal(r.status, 302);
  assert.equal(r.res.headers.get('location'), '/play/?invite=K7Q-2MX');
  const bad = await b.get('/join/nope');
  assert.equal(bad.status, 404);
  assert.equal(bad.body, 'asset /404.html');
  assert.equal((await b.get('/join/K7Q-2MX/extra')).status, 404);
});

test('session list: public lobbies and running games with their summary; online count', async () => {
  const env = makeEnv({ email: false });
  clearDirectoryCache();
  await session(env, SID('7'), { isPublic: true, players: 4 });
  await session(env, SID('8'), { isPublic: true, state: 'game' });
  await session(env, SID('9'));
  const kara = await player(env, 'Karaa');
  const mo = await player(env, 'Moira');
  await mo.post('/api/account/presence', { away: false });
  inSession(env, SID('8'), kara.user.id);
  inSession(env, SID('8'), null, 2);
  const list = (await new Browser(env).get('/api/sessions')).body;
  assert.deepEqual(list.map((s) => [s.id, s.state, s.players, s.maxPlayers]), [
    [SID('7'), 'lobby', 4, 4],
    [SID('8'), 'game', 2, 4],
  ]);
  assert.equal(list[0].summary.mode, 'competitive');
  const online = (await new Browser(env).get('/api/online')).body;
  assert.deepEqual(online, { players: 3, lobbies: 2, games: 1 });
  assert.equal((await new Browser(env).post('/api/online', {})).status, 405);
});

test('export lists friends; deletion and the daily job clean every friends row', async () => {
  const env = makeEnv({ email: false });
  const kara = await player(env, 'Karaa');
  const mo = await player(env, 'Moira');
  const ivan = await player(env, 'Ivano');
  await befriend(kara, mo);
  await kara.post('/api/account/friends/requests', { username: 'Ivano' });
  await kara.post('/api/account/friends/blocks', { username: 'Ivano' });
  await kara.post('/api/account/presence', { away: false });
  await kara.post('/api/auth/reauth', { password: 'correct horse battery' });
  const ex = await kara.get('/api/account/export');
  assert.equal(ex.status, 200);
  assert.deepEqual(ex.body.friends.friends.map((f) => f.username), ['Moira']);
  assert.deepEqual(ex.body.friends.blocked.map((f) => f.username), ['Ivano']);
  assert.ok(ex.body.friends.presence.seenAt);
  // Kara deletes her account: every row goes at once.
  assert.equal((await kara.del('/api/account', { confirm: 'Karaa' })).status, 204);
  for (const table of ['friendships', 'friend_requests', 'user_blocks', 'user_presence']) assert.deepEqual(env.DB.rows(`SELECT * FROM ${table}`), [], table);
  assert.deepEqual((await mo.get('/api/account/friends')).body.friends, []);
  // An account deleted another way (an admin) is cleaned by the daily job; old requests expire.
  await befriend(mo, ivan);
  await mo.post('/api/account/friends/requests', { username: 'Karaa' }).catch(() => {});
  const lone = await player(env, 'Loner');
  await lone.post('/api/account/friends/requests', { username: 'Ivano' });
  env.DB.sqlite.prepare("UPDATE users SET status = 'deleted', deleted_at = ? WHERE id = ?").run(Date.now(), ivan.user.id);
  await scheduled(env, Date.now());
  assert.deepEqual(env.DB.rows('SELECT * FROM friendships'), []);
  assert.deepEqual(env.DB.rows('SELECT * FROM friend_requests'), []);
  const zed = await player(env, 'Zedd');
  await zed.post('/api/account/friends/requests', { username: 'Moira' });
  clock.advance(FRIEND_REQUEST_TTL_MS + 1);
  await scheduled(env, Date.now());
  assert.deepEqual(env.DB.rows('SELECT * FROM friend_requests'), [], 'a month old request is forgotten');
  void ORIGIN;
});

test('migrations 0009 and 0010 are additive: an older database keeps its rows', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { readdirSync, readFileSync } = await import('node:fs');
  const dir = new URL('../migrations/', import.meta.url);
  const files = readdirSync(dir).filter((n) => n.endsWith('.sql')).sort();
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const older = files.filter((f) => f < '0009');
  for (const f of older) db.exec(readFileSync(new URL(f, dir), 'utf8'));
  db.prepare("INSERT INTO sessions (id, name, host, public, locked, players, max_players, map_json, version, state, updated_at) VALUES (?, 'Old', 'H', 1, 0, 1, 2, NULL, '0.16.0', 'lobby', 1)").run(SID('a'));
  db.prepare("INSERT INTO users (id, username, username_key, display_name, avatar_color, status, user_handle, created_at) VALUES (?, 'Old', 'old', 'Old', '#000000', 'active', 'h', 0)").run('e'.repeat(32));
  for (const f of files.filter((x) => x >= '0009')) db.exec(readFileSync(new URL(f, dir), 'utf8'));
  assert.equal(db.prepare('SELECT summary_json FROM sessions').get().summary_json, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
  // The new constraints hold.
  const a = 'e'.repeat(32);
  db.prepare("INSERT INTO users (id, username, username_key, display_name, avatar_color, status, user_handle, created_at) VALUES (?, 'B', 'b', 'B', '#000000', 'active', 'h2', 0)").run('f'.repeat(32));
  assert.throws(() => db.prepare('INSERT INTO friendships (user_a, user_b, created_at) VALUES (?, ?, 0)').run('f'.repeat(32), a), /CHECK/);
  assert.throws(() => db.prepare('INSERT INTO user_blocks (user_id, blocked_id, created_at) VALUES (?, ?, 0)').run(a, a), /CHECK/);
  db.prepare('INSERT INTO friendships (user_a, user_b, created_at) VALUES (?, ?, 0)').run(a, 'f'.repeat(32));
  db.prepare('INSERT INTO invite_codes (code, session_id, created_at, expires_at) VALUES (?, ?, 0, 1)').run('K7Q2MX', SID('a'));
  assert.throws(() => db.prepare('INSERT INTO invite_codes (code, session_id, created_at, expires_at) VALUES (?, ?, 0, 1)').run('K7Q2MX', SID('b')), /UNIQUE/);
  // Purging an account takes its friendships along.
  db.prepare('DELETE FROM users WHERE id = ?').run(a);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM friendships').get().n, 0);
});

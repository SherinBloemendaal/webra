// The realtime channel through the real Worker (docs/accounts-api.md 5.12,
// src/realtime/publish.js): the upgrade routes, the hints each route
// publishes after its write (and the ones it must not publish: hidden
// requests, ignores, blocks of non-friends), closing the sockets of ended
// sign-in sessions, the site setting, and failure isolation. The hubs are
// FakeUserHubs (accounts-harness.mjs): calls are recorded, never sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Browser, Clock, makeEnv, ORIGIN, PASSWORD, promote, setSite, signup } from './accounts-harness.mjs';
import { PRESENCE_ONLINE_MS } from '@webra/protocol';

const { readHubAuth } = await import('../src/userhub.js'); // after the harness's module hooks

const clock = new Clock();
test.after(() => clock.restore());

async function player(env, name) {
  const b = await signup(env, name);
  promote(env, b.user.id);
  return b;
}

async function befriend(a, b) {
  assert.equal((await a.post('/api/account/friends/requests', { username: b.user.username })).status, 201);
  assert.equal((await b.post(`/api/account/friends/requests/${a.user.username}/accept`)).status, 200);
}

/** The public id of the browser's sign-in session (the `origin` of what it changes). */
const sidOf = async (b) => (await b.get('/api/auth/me', { csrf: false })).body.session.id;
const hubs = (env) => env.USER_HUB;
const userHub = (b) => `user:${b.user.id}`;
/** [topic, kind, data] of each event published to `name`. */
const events = (env, name) => hubs(env).to(name).map((e) => [e.topic, e.kind, e.data]);

const connect = (b, path = '/api/account/realtime', extra = {}) =>
  b.get(path, { csrf: false, json: false, headers: { Upgrade: 'websocket', 'Sec-Fetch-Site': null, ...extra } });

// ---- Upgrade routes -------------------------------------------------------------------------

test('upgrade: who may connect, which topics, and what the hub is told', async () => {
  const env = makeEnv({ email: false });
  assert.equal((await connect(new Browser(env))).status, 401, 'anonymous');
  const pending = await signup(env, 'Waiting');
  const active = await player(env, 'Tanya');
  const forged = JSON.stringify({ userId: 'f'.repeat(32), username: 'Admin', sid: '0'.repeat(16), role: 'admin', status: 'active', topics: ['admin'] });

  const r = await connect(active, '/api/account/realtime', { 'X-WebRA-Auth': forged });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const call = hubs(env).fetches.at(-1);
  assert.equal(call.name, `user:${active.user.id}`);
  assert.equal(call.request.headers.get('Cookie'), null, 'the session cookie does not reach the object');
  assert.deepEqual(readHubAuth(call.request), { userId: active.user.id, username: 'Tanya', sid: await sidOf(active), role: 'user', status: 'active', topics: ['friends', 'account', 'settings', 'replays'] });

  // A pending account hears its approval, nothing about friends.
  assert.equal((await connect(pending)).status, 200);
  assert.deepEqual(readHubAuth(hubs(env).fetches.at(-1).request).topics, ['account', 'settings']);
  assert.equal(readHubAuth(hubs(env).fetches.at(-1).request).status, 'pending_approval');

  // The admin topic: moderators and admins only, one shared object.
  assert.equal((await connect(active, '/api/admin/realtime')).status, 403);
  promote(env, active.user.id, 'moderator');
  assert.equal((await connect(active, '/api/admin/realtime')).status, 200);
  assert.equal(hubs(env).fetches.at(-1).name, 'topic:admin');
  assert.deepEqual(readHubAuth(hubs(env).fetches.at(-1).request).topics, ['admin']);

  // Cross-origin upgrades and plain requests never reach a hub.
  const before = hubs(env).fetches.length;
  assert.equal((await connect(active, '/api/account/realtime', { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await connect(active, '/api/account/realtime', { Origin: null })).status, 403);
  assert.equal((await active.get('/api/account/realtime')).status, 426);
  assert.equal((await active.post('/api/account/realtime', {})).status, 405);

  // Banned: refused.
  env.DB.sqlite.prepare('INSERT INTO account_bans (user_id, reason, created_at) VALUES (?, ?, ?)').run(pending.user.id, 'spam', Date.now());
  assert.equal((await connect(pending)).status, 401, 'a ban ends the sign-in session');
  assert.equal(hubs(env).fetches.length, before);

  // The site setting off: 503, and the pages poll.
  await setSite(env, { realtime: false });
  const off = await connect(active);
  assert.equal(off.status, 503);
  assert.equal(off.body.error.code, 'unavailable');
  assert.equal((await active.get('/api/site', { csrf: false })).body.services.realtime, false);
  await setSite(env, { realtime: true });
  assert.equal((await active.get('/api/site', { csrf: false })).body.services.realtime, true);
});

test('upgrade without the USER_HUB binding: 503, /api/site says so, and every route still works', async () => {
  const env = makeEnv({ email: false, realtime: false });
  const a = await player(env, 'Alpha');
  const b = await player(env, 'Bravo');
  assert.equal((await connect(a)).status, 503);
  assert.equal((await a.get('/api/site', { csrf: false })).body.services.realtime, false);
  await befriend(a, b);
  assert.equal((await a.post('/api/auth/logout')).status, 204);
});

// ---- Friends ----------------------------------------------------------------------------------

test('friends: requests, accepts and removals reach both sides; the device that acted is named as origin', async () => {
  const env = makeEnv({ email: false });
  const a = await player(env, 'Alpha');
  const b = await player(env, 'Bravo');
  const sidA = await sidOf(a);
  // Published after the write: the receiver's list already shows it when the hint arrives.
  const seen = [];
  hubs(env).onPublish = (name, e) => {
    if (name === userHub(b) && e.kind === 'request') seen.push(env.DB.rows('SELECT 1 FROM friend_requests WHERE from_user = ? AND to_user = ?', a.user.id, b.user.id).length);
  };
  assert.equal((await a.post('/api/account/friends/requests', { username: 'Bravo' })).status, 201);
  assert.deepEqual(seen, [1]);
  assert.deepEqual(events(env, userHub(b)), [['friends', 'request', { username: 'Alpha' }]]);
  assert.deepEqual(events(env, userHub(a)), [['friends', 'request', null]], "the sender's other tabs see the request go out");
  assert.equal(hubs(env).to(userHub(a))[0].origin, sidA);
  hubs(env).clear();

  assert.equal((await b.post('/api/account/friends/requests/Alpha/accept')).status, 200);
  assert.deepEqual(events(env, userHub(a)), [['friends', 'accept', { username: 'Bravo' }]]);
  assert.deepEqual(events(env, userHub(b)), [['friends', 'accept', { username: 'Alpha' }]]);
  hubs(env).clear();

  assert.equal((await a.del('/api/account/friends/Bravo')).status, 204);
  assert.deepEqual(events(env, userHub(b)), [['friends', 'remove', { username: 'Alpha' }]]);
  assert.deepEqual(events(env, userHub(a)), [['friends', 'remove', null]]);
  hubs(env).clear();

  // Asking back makes friends at once: both hear `accept`.
  await a.post('/api/account/friends/requests', { username: 'Bravo' });
  hubs(env).clear();
  assert.equal((await b.post('/api/account/friends/requests', { username: 'Alpha' })).status, 200);
  assert.deepEqual(events(env, userHub(a)), [['friends', 'accept', { username: 'Bravo' }]]);
  assert.deepEqual(events(env, userHub(b)), [['friends', 'accept', { username: 'Alpha' }]]);
});

test('friends privacy: hidden requests, ignores and blocks of non-friends tell the other side nothing', async () => {
  const env = makeEnv({ email: false });
  const a = await player(env, 'Alpha');
  const b = await player(env, 'Bravo');
  const c = await player(env, 'Charlie');

  // Ignore: only the receiver's own tabs; the sender hears nothing, also not when it withdraws.
  await a.post('/api/account/friends/requests', { username: 'Bravo' });
  hubs(env).clear();
  assert.equal((await b.post('/api/account/friends/requests/Alpha/ignore')).status, 204);
  assert.deepEqual(events(env, userHub(b)), [['friends', 'ignore', null]]);
  assert.deepEqual(events(env, userHub(a)), [], 'ignoring is invisible to the sender');
  hubs(env).clear();
  assert.equal((await a.del('/api/account/friends/requests/Bravo')).status, 204);
  assert.deepEqual(events(env, userHub(a)), [['friends', 'withdraw', null]]);
  assert.deepEqual(events(env, userHub(b)), [], 'an ignored request leaves no trace when withdrawn');
  hubs(env).clear();

  // A request to a player who blocked the sender stays hidden: no hint to the receiver.
  assert.equal((await c.post('/api/account/friends/blocks', { username: 'Alpha' })).status, 204);
  assert.deepEqual(events(env, userHub(a)), [], 'blocking a player who was no friend sends them nothing');
  assert.deepEqual(events(env, userHub(c)), [['friends', 'block', null]]);
  hubs(env).clear();
  assert.equal((await a.post('/api/account/friends/requests', { username: 'Charlie' })).status, 201, 'looks like any request to the sender');
  assert.deepEqual(events(env, userHub(c)), []);
  assert.deepEqual(events(env, userHub(a)), [['friends', 'request', null]]);
  hubs(env).clear();
  assert.equal((await a.del('/api/account/friends/requests/Charlie')).status, 204);
  assert.deepEqual(events(env, userHub(c)), [], 'withdrawing a hidden request: still nothing');
  hubs(env).clear();
  assert.equal((await c.del('/api/account/friends/blocks/Alpha')).status, 204);
  assert.deepEqual(events(env, userHub(a)), [], 'unblocking is not told either');
  assert.deepEqual(events(env, userHub(c)).at(-1), ['friends', 'unblock', null]);
  hubs(env).clear();

  // A visible request withdrawn: the receiver's list changes, so it hears it.
  await a.post('/api/account/friends/requests', { username: 'Charlie' });
  hubs(env).clear();
  await a.del('/api/account/friends/requests/Charlie');
  assert.deepEqual(events(env, userHub(c)), [['friends', 'withdraw', { username: 'Alpha' }]]);
  hubs(env).clear();

  // Blocking a friend: the blocked player sees the friendship end, like a removal, never a block.
  await befriend(a, b);
  hubs(env).clear();
  assert.equal((await b.post('/api/account/friends/blocks', { username: 'Alpha' })).status, 204);
  assert.deepEqual(events(env, userHub(a)), [['friends', 'remove', { username: 'Bravo' }]]);
  assert.deepEqual(events(env, userHub(b)), [['friends', 'block', null]]);
  assert.ok(!hubs(env).publishes.some((p) => p.kind === 'block' && p.name !== userHub(b)), 'no block event ever leaves the blocker');
});

test('friends: invites and their dismissal reach both; presence only on a change', async () => {
  const env = makeEnv({ email: false });
  const a = await player(env, 'Alpha');
  const b = await player(env, 'Bravo');
  await befriend(a, b);
  const session = 'd'.repeat(64);
  const { upsertSession } = await import('../src/directory.js');
  const { issueInviteCode } = await import('../src/invites.js');
  await upsertSession(env.DB, { id: session, name: 'Lobby', host: 'Alpha', public: false, locked: false, players: 1, maxPlayers: 4, map: null, version: '1.0.0', state: 'lobby', summary: null }, Date.now());
  env.DB.sqlite.prepare('INSERT INTO game_presence (session_id, client, user_id, updated_at) VALUES (?, 1, ?, ?)').run(session, a.user.id, Date.now());
  await issueInviteCode(env.DB, session, Date.now(), Date.now() + 3600_000);
  hubs(env).clear();
  assert.equal((await a.post('/api/account/friends/invites', { username: 'Bravo', session })).status, 201);
  assert.deepEqual(events(env, userHub(b)), [['friends', 'invite', { username: 'Alpha', session }]]);
  assert.deepEqual(events(env, userHub(a)), [['friends', 'invite', null]]);
  hubs(env).clear();
  assert.equal((await b.del('/api/account/friends/invites/Alpha')).status, 204);
  assert.deepEqual(events(env, userHub(a)), [['friends', 'invite_dismiss', { username: 'Bravo' }]]);
  assert.deepEqual(events(env, userHub(b)), [['friends', 'invite_dismiss', null]]);
  hubs(env).clear();

  // Presence: the first heartbeat (offline -> online) is told, the next ones are not.
  assert.equal((await a.post('/api/account/presence', { away: false })).status, 204);
  assert.deepEqual(events(env, userHub(b)), [['friends', 'presence', { username: 'Alpha' }]]);
  hubs(env).clear();
  clock.advance(60_000);
  await a.post('/api/account/presence', { away: false });
  assert.deepEqual(events(env, userHub(b)), [], 'a heartbeat without a change');
  clock.advance(10_000);
  await a.post('/api/account/presence', { away: true, idleMs: 600_000 });
  assert.deepEqual(events(env, userHub(b)), [['friends', 'presence', { username: 'Alpha' }]], 'away');
  hubs(env).clear();
  clock.advance(1_000);
  await a.post('/api/account/presence', { away: false });
  assert.deepEqual(events(env, userHub(b)), [], 'within PRESENCE_CHANGE_MS nothing is stored, so nothing is told');
  clock.advance(PRESENCE_ONLINE_MS + 1);
  await a.post('/api/account/presence', { away: false });
  assert.deepEqual(events(env, userHub(b)), [['friends', 'presence', { username: 'Alpha' }]], 'back after the heartbeat expired');
  assert.deepEqual(events(env, userHub(a)), [], 'presence goes to friends, not to the player');
});

// ---- Account ------------------------------------------------------------------------------------

test('account: profile, settings and the sign-in sessions it ends', async () => {
  const env = makeEnv({ email: false });
  const a = await player(env, 'Alpha');
  const b = await player(env, 'Bravo');
  await befriend(a, b);
  const sidA = await sidOf(a);
  hubs(env).clear();

  assert.equal((await a.patch('/api/account', { displayName: 'Alpha One' })).status, 200);
  assert.deepEqual(events(env, userHub(a)), [['account', 'profile', null]]);
  assert.deepEqual(events(env, userHub(b)), [['friends', 'presence', { username: 'Alpha' }]], 'friends see the new name');
  hubs(env).clear();

  const current = await a.get('/api/account/settings');
  const put = await a.put('/api/account/settings', { settings: { ...current.body.settings, schema: 1 } }, { headers: { 'If-Match': `"v${current.body.version}"` } });
  assert.equal(put.status, 200);
  assert.deepEqual(hubs(env).to(userHub(a)), [{ topic: 'settings', kind: 'updated', data: { version: put.body.version }, origin: sidA }]);
  hubs(env).clear();

  // A second device; revoking it closes its sockets (and only its).
  const phone = new Browser(env, { ip: '198.51.100.99' });
  await phone.post('/api/auth/login', { login: 'Alpha', password: PASSWORD });
  const sidPhone = await sidOf(phone);
  assert.equal((await a.del(`/api/account/sessions/${sidPhone}`)).status, 204);
  assert.deepEqual(hubs(env).closes, [{ name: userHub(a), sids: [sidPhone], except: null, userId: null }], 'a plain user: only its own hub');
  hubs(env).clear();

  // Signing out everywhere else, and a password change: all but this device.
  await phone.post('/api/auth/login', { login: 'Alpha', password: PASSWORD });
  assert.equal((await a.del('/api/account/sessions')).status, 204);
  assert.deepEqual(hubs(env).closes, [{ name: userHub(a), sids: null, except: sidA, userId: null }]);
  hubs(env).clear();
  await a.post('/api/auth/reauth', { password: PASSWORD });
  assert.equal((await a.post('/api/account/password', { newPassword: 'another horse battery' })).status, 200);
  assert.deepEqual(hubs(env).closes, [{ name: userHub(a), sids: null, except: sidA, userId: null }]);
  hubs(env).clear();

  // Signing out closes this sign-in's sockets (the role is not loaded there: both hubs are asked).
  assert.equal((await a.post('/api/auth/logout')).status, 204);
  assert.deepEqual(hubs(env).closes, [
    { name: userHub(a), sids: [sidA], except: null, userId: null },
    { name: 'topic:admin', sids: [sidA], except: null, userId: a.user.id },
  ]);
});

test('account deletion: every socket closes, former friends and the dashboard hear it', async () => {
  const env = makeEnv({ email: false });
  const a = await player(env, 'Alpha');
  const b = await player(env, 'Bravo');
  await befriend(a, b);
  hubs(env).clear();
  await a.post('/api/auth/reauth', { password: PASSWORD });
  assert.equal((await a.del('/api/account', { confirm: 'Alpha' })).status, 204);
  assert.deepEqual(hubs(env).closes.find((c) => c.name === userHub(a)), { name: userHub(a), sids: null, except: null, userId: null });
  assert.deepEqual(events(env, userHub(b)), [['friends', 'remove', { username: 'Alpha' }]], 'collected before the friends rows went');
  assert.deepEqual(events(env, 'topic:admin'), [['admin', 'user_deleted', { userId: a.user.id }]]);
});

// ---- Sign-up and admin ------------------------------------------------------------------------

test('admin: sign-ups, approvals, bans and settings reach the account and the dashboard', async () => {
  const env = makeEnv({ email: false });
  const admin = await signup(env, 'Root Admin');
  promote(env, admin.user.id, 'admin');
  const sidAdmin = await sidOf(admin);
  hubs(env).clear();
  const waiting = await signup(env, 'Waiting');
  assert.deepEqual(events(env, 'topic:admin'), [['admin', 'user_created', { userId: waiting.user.id }]]);
  hubs(env).clear();

  assert.equal((await admin.post(`/api/admin/users/${waiting.user.id}/approve`, {})).status, 200);
  assert.deepEqual(events(env, `user:${waiting.user.id}`), [['account', 'status', { status: 'active' }]], 'the waiting player sees it at once');
  assert.deepEqual(hubs(env).to('topic:admin'), [{ topic: 'admin', kind: 'user_approved', data: { userId: waiting.user.id }, origin: sidAdmin }]);
  hubs(env).clear();

  // Settings changed by an admin: every device of the account, the admin's own tab too (no origin).
  const doc = await admin.get(`/api/admin/users/${waiting.user.id}/settings`);
  const put = await admin.put(`/api/admin/users/${waiting.user.id}/settings`, { settings: { ...doc.body.settings, schema: 1 } }, { headers: { 'If-Match': `"v${doc.body.version}"` } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.deepEqual(hubs(env).to(`user:${waiting.user.id}`), [{ topic: 'settings', kind: 'updated', data: { version: put.body.version }, origin: null }]);
  assert.deepEqual(events(env, 'topic:admin'), [['admin', 'user_updated', { userId: waiting.user.id }]], 'the guide column reads the document');
  hubs(env).clear();

  // A guide action: the player's devices sync, other dashboards reload the row.
  const guided = await admin.post(`/api/admin/users/${waiting.user.id}/guide`, { action: 'reset' });
  assert.equal(guided.status, 200, JSON.stringify(guided.body));
  assert.deepEqual(hubs(env).to(`user:${waiting.user.id}`), [{ topic: 'settings', kind: 'updated', data: { version: guided.body.version }, origin: null }]);
  assert.deepEqual(hubs(env).to('topic:admin'), [{ topic: 'admin', kind: 'user_updated', data: { userId: waiting.user.id }, origin: sidAdmin }]);
  hubs(env).clear();
  const nodoc = await signup(env, 'Nodoc');
  hubs(env).clear();
  assert.equal((await admin.post(`/api/admin/users/${nodoc.user.id}/guide`, { action: 'reset' })).status, 409, 'no settings document yet');
  assert.deepEqual(hubs(env).publishes, [], 'a refused action publishes nothing');

  const friend = await player(env, 'Friend');
  await befriend(friend, waiting);
  hubs(env).clear();
  assert.equal((await admin.post(`/api/admin/users/${waiting.user.id}/ban`, { reason: 'cheating' })).status, 201);
  assert.ok(hubs(env).closes.some((c) => c.name === `user:${waiting.user.id}` && c.sids === null), 'a ban closes every socket');
  assert.deepEqual(events(env, `user:${friend.user.id}`), [['friends', 'presence', null]]);
  assert.deepEqual(events(env, 'topic:admin'), [['admin', 'user_banned', { userId: waiting.user.id }]]);
  hubs(env).clear();
  assert.equal((await admin.del(`/api/admin/users/${waiting.user.id}/ban`)).status, 200);
  assert.deepEqual(events(env, 'topic:admin'), [['admin', 'user_unbanned', { userId: waiting.user.id }]]);
  hubs(env).clear();

  const other = await player(env, 'Other');
  const sidOther = await sidOf(other);
  assert.equal((await admin.del(`/api/admin/users/${other.user.id}/sessions/${sidOther}`)).status, 204);
  assert.deepEqual(hubs(env).closes, [{ name: `user:${other.user.id}`, sids: [sidOther], except: null, userId: null }]);
  hubs(env).clear();
  assert.equal((await admin.post(`/api/admin/users/${other.user.id}/logout`, {})).status, 204);
  assert.deepEqual(hubs(env).closes, [{ name: `user:${other.user.id}`, sids: null, except: null, userId: null }]);
  hubs(env).clear();
  assert.equal((await admin.del(`/api/admin/users/${other.user.id}`)).status, 200);
  assert.deepEqual(hubs(env).closes, [{ name: `user:${other.user.id}`, sids: null, except: null, userId: null }]);
  assert.deepEqual(events(env, 'topic:admin'), [['admin', 'user_deleted', { userId: other.user.id }]]);
});

test('failure isolation: a failing hub never changes an answer; the site setting stops hints, not closes', async () => {
  const env = makeEnv({ email: false });
  const a = await player(env, 'Alpha');
  const b = await player(env, 'Bravo');
  hubs(env).fail = true;
  const errors = [];
  const realError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const r = await a.post('/api/account/friends/requests', { username: 'Bravo' });
    assert.equal(r.status, 201, 'the request is stored and answered as always');
    assert.equal((await b.post('/api/account/friends/requests/Alpha/accept')).status, 200);
    assert.equal((await a.post('/api/auth/logout')).status, 204);
  } finally {
    console.error = realError;
  }
  assert.ok(errors.some((e) => /realtime/.test(e)), 'the failure is logged');
  hubs(env).fail = false;

  await setSite(env, { realtime: false });
  hubs(env).clear();
  await b.del('/api/account/friends/Alpha');
  assert.deepEqual(hubs(env).publishes, [], 'no hints while switched off');
  assert.equal((await b.post('/api/auth/logout')).status, 204);
  assert.equal(hubs(env).closes.length, 2, 'sockets opened before the switch still close with their sign-in');
});

test('signing up and verifying an address: the dashboard and the waiting tab hear it', async () => {
  const env = makeEnv();
  const b = await signup(env, 'Mailer', { email: 'mailer@example.com' });
  hubs(env).clear();
  const token = env.EMAIL.token('mailer@example.com', 'verify');
  assert.equal((await new Browser(env, { origin: ORIGIN }).post('/api/auth/email/verify', { token })).status, 200);
  assert.deepEqual(events(env, `user:${b.user.id}`), [['account', 'status', { status: 'pending_approval' }]]);
  assert.deepEqual(events(env, 'topic:admin'), [['admin', 'user_updated', { userId: b.user.id }]]);
});

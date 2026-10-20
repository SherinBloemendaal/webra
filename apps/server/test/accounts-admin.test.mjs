// Admin and moderator API (docs/accounts-api.md section 8): the permission
// matrix, approval, bans (accounts and CIDR ranges), edits, deletion and
// purge, settings documents, site settings, the audit log and stats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Browser, Clock, makeEnv, PASSWORD, promote, signup } from './accounts-harness.mjs';
import { takeQuota } from '../src/quota.js';
import { GUIDE_OUTLINE, guideIndex } from '@webra/protocol';
import { CONTENT_ACCOUNT_LIMIT, CONTENT_NET_LIMIT } from '../src/content.js';
import { APPROVE_ALL_MAX } from '../src/accounts/routes-admin.js';

const clock = new Clock();
test.after(() => clock.restore());

/** An admin, a moderator, a plain user and a pending target, all signed in. */
async function cast(opts = {}) {
  const env = makeEnv({ email: false, ...opts });
  const admin = await signup(env, 'Root Admin', { ip: '198.51.100.1' });
  const mod = await signup(env, 'Moddy', { ip: '198.51.100.2' });
  const user = await signup(env, 'Plain', { ip: '198.51.100.3' });
  const target = await signup(env, 'Target', { ip: '198.51.100.4' });
  // Addresses as an admin would have set them (this server has no email binding); Target's stays unverified.
  env.DB.sqlite.exec("UPDATE users SET email = lower(replace(username, ' ', '.')) || '@example.com'");
  promote(env, admin.user.id, 'admin');
  promote(env, mod.user.id, 'moderator');
  promote(env, user.user.id, 'user');
  // Role changes revoke sessions: sign in again.
  for (const b of [admin, mod, user]) {
    const name = b.user.username.toLowerCase();
    assert.equal((await b.post('/api/auth/login', { login: name, password: PASSWORD })).status, 200);
  }
  return { env, admin, mod, user, target };
}

test('permission matrix: users get nothing, moderators a subset, admins everything', async () => {
  const { env, admin, mod, user, target } = await cast();
  const t = target.user.id;
  const ifMatch = { headers: { 'If-Match': '"v0"' } };
  const cases = [
    ['GET', '/api/admin/users', undefined, 'moderator'],
    ['GET', `/api/admin/users/${t}`, undefined, 'moderator'],
    ['GET', '/api/admin/stats', undefined, 'moderator'],
    ['POST', `/api/admin/users/${t}/approve`, {}, 'moderator'],
    ['PATCH', `/api/admin/users/${t}`, { displayName: 'X' }, 'admin'],
    ['POST', `/api/admin/users/${t}/logout`, {}, 'admin'],
    ['POST', `/api/admin/users/${t}/password-reset`, {}, 'admin'],
    ['GET', `/api/admin/users/${t}/settings`, undefined, 'admin'],
    ['DELETE', `/api/admin/users/${t}/relay-quota`, undefined, 'admin'],
    ['PUT', `/api/admin/users/${t}/settings`, { settings: {} }, 'admin', ifMatch],
    ['POST', `/api/admin/users/${t}/guide`, { action: 'reset' }, 'admin'],
    ['GET', '/api/admin/ip-bans', undefined, 'admin'],
    ['POST', '/api/admin/ip-bans', { cidr: '192.0.2.0/24', reason: 'spam' }, 'admin'],
    ['GET', '/api/admin/site', undefined, 'admin'],
    ['PATCH', '/api/admin/site', { motd: 'hi' }, 'admin', ifMatch],
    ['GET', '/api/admin/audit', undefined, 'admin'],
  ];
  for (const [method, path, body, minRole, opts] of cases) {
    const results = {};
    for (const [role, b] of [
      ['user', user],
      ['moderator', mod],
    ]) {
      results[role] = (await b.req(method, path, body, opts ?? {})).status;
    }
    const anon = await new Browser(env).req(method, path, body, opts ?? {});
    assert.equal(anon.status, 401, `${method} ${path} anonymous`);
    assert.equal(results.user, 403, `${method} ${path} user`);
    if (minRole === 'moderator') assert.ok(results.moderator < 300, `${method} ${path} moderator: ${results.moderator}`);
    else assert.equal(results.moderator, 403, `${method} ${path} moderator`);
    const r = await admin.req(method, path, body, opts ?? {});
    assert.ok(r.status < 300 || (minRole === 'moderator' && r.status === 409), `${method} ${path} admin: ${r.status} ${JSON.stringify(r.body)}`);
  }
});

test('moderators: masked emails, no IPs or settings, bans only for plain users', async () => {
  const { admin, mod, user, target } = await cast();
  const list = await mod.get('/api/admin/users?sort=username&order=asc');
  assert.equal(list.status, 200);
  assert.equal(list.body.total, 4);
  const t = list.body.users.find((u) => u.username === 'Target');
  assert.equal(t.email, 't***@example.com');
  const detail = await mod.get(`/api/admin/users/${target.user.id}`);
  assert.deepEqual(Object.keys(detail.body).sort(), ['bans', 'user']);
  const full = await admin.get(`/api/admin/users/${target.user.id}`);
  assert.equal(full.body.user.email, 'target@example.com');
  assert.deepEqual(full.body.ips.map((i) => i.ip), ['198.51.100.4']);
  assert.ok(Array.isArray(full.body.sessions));
  assert.equal(full.body.settings.version, 0);
  // Moderator vs other staff and self.
  assert.equal((await mod.post(`/api/admin/users/${admin.user.id}/ban`, { reason: 'coup' })).status, 403);
  assert.equal((await mod.post(`/api/admin/users/${mod.user.id}/ban`, { reason: 'self' })).status, 403);
  assert.equal((await mod.post(`/api/admin/users/${user.user.id}/ban`, { reason: 'griefing' })).status, 201);
  assert.equal((await admin.post(`/api/admin/users/${mod.user.id}/ban`, { reason: 'abuse', expiresAt: clock.now + 1000 })).status, 201);
  assert.equal((await admin.post(`/api/admin/users/${admin.user.id}/ban`, { reason: 'self' })).status, 403);
});

test('search, filters, sorting and paging', async () => {
  const { admin, mod, target } = await cast();
  for (const [q, n] of [
    ['targ', 1],
    ['TARGET@', 1],
    ['%', 0],
    ['_', 0],
  ]) {
    const r = await admin.get(`/api/admin/users?q=${encodeURIComponent(q)}`);
    assert.equal(r.body.total, n, q);
  }
  assert.equal((await mod.get('/api/admin/users?q=target%40')).body.total, 0, 'moderators do not search emails');
  assert.equal((await admin.get('/api/admin/users?status=pending_approval')).body.users[0].id, target.user.id);
  assert.equal((await admin.get('/api/admin/users?role=moderator')).body.total, 1);
  assert.equal((await admin.get('/api/admin/users?flag=content_autoinstall')).body.total, 0);
  const p1 = await admin.get('/api/admin/users?limit=3&page=1&sort=username&order=asc');
  const p2 = await admin.get('/api/admin/users?limit=3&page=2&sort=username&order=asc');
  assert.deepEqual([p1.body.users.length, p2.body.users.length, p1.body.total], [3, 1, 4]);
  assert.deepEqual(p1.body.users.map((u) => u.username), ['Moddy', 'Plain', 'Root Admin']);
  for (const q of ['status=nope', 'role=god', 'flag=x', 'sort=email', 'limit=101', 'page=0', 'order=up']) {
    assert.equal((await admin.get(`/api/admin/users?${q}`)).status, 400, q);
  }
});

test('approval and rejection', async () => {
  const { admin, mod, target, env } = await cast();
  const approved = await mod.post(`/api/admin/users/${target.user.id}/approve`, {});
  assert.equal(approved.status, 200);
  assert.equal(approved.body.user.status, 'active');
  assert.equal(approved.body.user.approvedBy, mod.user.id);
  assert.equal((await mod.post(`/api/admin/users/${target.user.id}/approve`, {})).status, 409);
  assert.equal((await target.get('/api/auth/me')).body.user.canPlayOnline, true);
  const late = await signup(env, 'Latecomer');
  const rejected = await mod.post(`/api/admin/users/${late.user.id}/reject`, { reason: 'not in the beta' });
  assert.equal(rejected.body.user.status, 'deleted');
  assert.equal((await late.get('/api/auth/me')).body.user, null);
  const log = await admin.get('/api/admin/audit?action=user.reject');
  assert.equal(log.body.entries[0].reason, 'not in the beta');
  assert.equal(log.body.entries[0].actor.username, 'Moddy');
});

test('account bans: sessions revoked, games dropped, sign-in refused with the reason, expiry, unban', async () => {
  const { env, admin, user } = await cast();
  const id = user.user.id;
  env.DB.sqlite.prepare("INSERT INTO game_presence (session_id, client, user_id, updated_at) VALUES (?, 3, ?, 0)").run('a'.repeat(64), id);
  for (const bad of [{ reason: '' }, { reason: 'x', expiresAt: clock.now - 1 }, { reason: 'x', expiresAt: 'soon' }, {}]) {
    assert.equal((await admin.post(`/api/admin/users/${id}/ban`, bad)).status, 400, JSON.stringify(bad));
  }
  const r = await admin.post(`/api/admin/users/${id}/ban`, { reason: 'cheating', expiresAt: clock.now + 60 * 60 * 1000 });
  assert.equal(r.status, 201);
  assert.equal(r.body.user.status, 'banned');
  assert.equal(r.body.ban.reason, 'cheating');
  assert.deepEqual(env.SESSION.evictions.map((e) => [e.id, e.userIds]), [['a'.repeat(64), [id]]], 'the game was told to drop the player');
  assert.equal((await user.get('/api/auth/me')).body.user, null, 'signed out');
  const login = await new Browser(env).post('/api/auth/login', { login: 'plain', password: PASSWORD });
  assert.equal(login.status, 403);
  assert.equal(login.body.error.code, 'banned');
  assert.equal(login.body.error.ban.reason, 'cheating');
  assert.equal((await admin.get('/api/admin/users?status=banned')).body.total, 1);
  assert.equal((await admin.get('/api/admin/stats')).body.users.byStatus.banned, 1);
  clock.advance(60 * 60 * 1000 + 1);
  assert.equal((await new Browser(env).post('/api/auth/login', { login: 'plain', password: PASSWORD })).status, 200, 'expired');
  await admin.post(`/api/admin/users/${id}/ban`, { reason: 'again', expiresAt: null });
  assert.equal((await new Browser(env).post('/api/auth/login', { login: 'plain', password: PASSWORD })).status, 403);
  const lifted = await admin.del(`/api/admin/users/${id}/ban`);
  assert.equal(lifted.status, 200);
  assert.equal(lifted.body.user.status, 'active');
  assert.equal((await admin.del(`/api/admin/users/${id}/ban`)).status, 404);
  assert.equal((await new Browser(env).post('/api/auth/login', { login: 'plain', password: PASSWORD })).status, 200);
  const history = (await admin.get(`/api/admin/users/${id}`)).body.bans;
  assert.equal(history.length, 2);
  assert.ok(history.every((b) => b.revokedAt !== null || b.expiresAt !== null));
});

test('IP bans: CIDR ranges for IPv4 and IPv6, validation, own address, expiry, drop from games', async () => {
  const { env, admin } = await cast();
  const bad = async (cidr) => assert.equal((await admin.post('/api/admin/ip-bans', { cidr, reason: 'x' })).status, 400, cidr);
  await bad('300.1.1.1');
  await bad('10.0.0.0/7');
  await bad('2001:db8::/15');
  await bad('198.51.100.0/24'); // contains the admin's own address
  await bad('abc');
  const v4 = await admin.post('/api/admin/ip-bans', { cidr: '203.0.113.77/24', reason: 'botnet', expiresAt: clock.now + 1000 });
  assert.equal(v4.status, 201);
  assert.equal(v4.body.ban.cidr, '203.0.113.0/24');
  const v6 = await admin.post('/api/admin/ip-bans', { cidr: '2001:DB8:abcd::5/48', reason: 'abuse' });
  assert.equal(v6.body.ban.cidr, '2001:db8:abcd::/48');
  const blocked = async (ip) => (await new Browser(env, { ip }).post('/api/auth/login', { login: 'x', password: 'y' })).body?.error?.code;
  assert.equal(await blocked('203.0.113.200'), 'ip_banned');
  assert.equal(await blocked('2001:db8:abcd:ffff::1'), 'ip_banned');
  assert.equal(await blocked('::ffff:203.0.113.9'), 'ip_banned', 'IPv4-mapped IPv6');
  assert.notEqual(await blocked('203.0.114.1'), 'ip_banned');
  assert.notEqual(await blocked('2001:db8:abce::1'), 'ip_banned');
  const list = await admin.get('/api/admin/ip-bans?active=1');
  assert.equal(list.body.total, 2);
  const patched = await admin.patch(`/api/admin/ip-bans/${v6.body.ban.id}`, { reason: 'abuse, again' });
  assert.equal(patched.body.ban.reason, 'abuse, again');
  clock.advance(1001);
  assert.notEqual(await blocked('203.0.113.200'), 'ip_banned', 'expired');
  assert.equal((await admin.get('/api/admin/ip-bans?active=1')).body.total, 1);
  assert.equal((await admin.del(`/api/admin/ip-bans/${v6.body.ban.id}`)).status, 204);
  assert.notEqual(await blocked('2001:db8:abcd::1'), 'ip_banned');
  assert.equal((await admin.del('/api/admin/ip-bans/999')).status, 404);
  // Accounts seen from a banned range and members connected from it are dropped from games.
  env.DB.sqlite.prepare("INSERT INTO game_presence (session_id, client, user_id, ip_v, ip_hex, updated_at) VALUES (?, 2, NULL, 4, 'c0000205', 0)").run('b'.repeat(64));
  const before = env.SESSION.evictions.length;
  await admin.post('/api/admin/ip-bans', { cidr: '192.0.2.0/24', reason: 'raid' });
  const ev = env.SESSION.evictions.slice(before);
  assert.deepEqual(ev.map((e) => e.id), ['b'.repeat(64)]);
  assert.equal(ev[0].range.start, 'c0000200');
  const log = await admin.get('/api/admin/audit?action=ipban.create');
  assert.equal(log.body.entries.length, 3);
  const latest = (await admin.get('/api/admin/ip-bans')).body.bans[0];
  assert.equal(log.body.entries[0].target.id, String(latest.id), 'the audit entry names the new ban');
});

test('edits: profile, email, flags, status; role changes revoke sessions; last admin', async () => {
  const { env, admin, user, target } = await cast();
  const r = await admin.patch(`/api/admin/users/${target.user.id}`, { username: 'Renamed Target', email: 'renamed@example.com', flags: ['content_autoinstall'], status: 'active' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.user.username, 'Renamed Target');
  assert.deepEqual(r.body.user.flags, ['content_autoinstall']);
  assert.equal(r.body.user.emailVerified, false, 'a new address is unverified');
  assert.equal((await admin.patch(`/api/admin/users/${target.user.id}`, { status: 'banned' })).status, 400);
  assert.equal((await admin.patch(`/api/admin/users/${target.user.id}`, { flags: ['god_mode'] })).status, 400);
  assert.equal((await admin.patch(`/api/admin/users/${target.user.id}`, { username: 'plain' })).status, 409);
  const entry = (await admin.get(`/api/admin/audit?target=${target.user.id}&action=user.update`)).body.entries[0];
  assert.equal(entry.before.username, 'Target');
  assert.equal(entry.after.username, 'Renamed Target');
  assert.equal(entry.actor.id, admin.user.id);
  // Role change: the user's sessions end.
  assert.equal((await admin.patch(`/api/admin/users/${user.user.id}`, { role: 'moderator' })).status, 200);
  assert.equal((await user.get('/api/auth/me')).body.user, null);
  assert.equal((await admin.patch(`/api/admin/users/${admin.user.id}`, { role: 'user' })).status, 403, 'not your own role');
  // Make the user an admin, then they cannot demote the first admin below one... both are admins: allowed.
  await admin.patch(`/api/admin/users/${user.user.id}`, { role: 'admin' });
  const second = new Browser(env);
  await second.post('/api/auth/login', { login: 'plain', password: PASSWORD });
  assert.equal((await second.patch(`/api/admin/users/${admin.user.id}`, { role: 'user' })).status, 200);
  // Now `second` is the last admin: nobody can demote them (and they cannot themselves).
  assert.equal((await second.patch(`/api/admin/users/${user.user.id}`, { role: 'user' })).status, 403);
});

test('delete, restore and purge; reset links; settings documents', async () => {
  const { env, admin, target } = await cast();
  const id = target.user.id;
  await target.put('/api/account/settings', { settings: { audio: { master: 0.1 } } }, { headers: { 'If-Match': '"v0"' } });
  const s = await admin.get(`/api/admin/users/${id}/settings`);
  assert.equal(s.res.headers.get('etag'), '"v1"');
  const edited = await admin.put(`/api/admin/users/${id}/settings`, { settings: { audio: { master: 0.9 } } }, { headers: { 'If-Match': '"v1"' } });
  assert.equal(edited.body.version, 2);
  assert.equal((await admin.put(`/api/admin/users/${id}/settings`, { settings: {} }, { headers: { 'If-Match': '"v1"' } })).status, 412);
  assert.equal((await admin.put(`/api/admin/users/${id}/settings`, { settings: { audio: { master: 9 } } }, { headers: { 'If-Match': '"v2"' } })).status, 400);
  const audit = (await admin.get('/api/admin/audit?action=user.settings_update')).body.entries[0];
  assert.equal(audit.before.settings.audio.master, 0.1);
  assert.equal(audit.after.settings.audio.master, 0.9);
  // Reset link (no email binding here: not sent).
  const link = await admin.post(`/api/admin/users/${id}/password-reset`, { send: false });
  assert.equal(link.status, 201);
  assert.match(link.body.url, /^https:\/\/webra\.sherin\.dev\/account\/#reset=[A-Za-z0-9_-]{43}$/);
  assert.equal(link.body.sent, false);
  assert.equal((await admin.post(`/api/admin/users/${id}/password-reset`, { send: true })).status, 503);
  const token = link.body.url.split('=')[1];
  const reset = await new Browser(env).post('/api/auth/password/reset', { token, password: 'reset by an admin' });
  assert.equal(reset.status, 200, JSON.stringify(reset.body));
  // Delete, restore, delete, purge.
  assert.equal((await admin.del(`/api/admin/users/${admin.user.id}`)).status, 403);
  assert.equal((await admin.del(`/api/admin/users/${id}`)).body.user.status, 'deleted');
  assert.equal((await admin.post(`/api/admin/users/${id}/purge`, { confirm: 'Target' })).status, 204);
  assert.equal(env.DB.rows('SELECT COUNT(*) AS n FROM users WHERE id = ?', id)[0].n, 0, 'purged');
  for (const table of ['settings_docs', 'user_ips', 'auth_sessions', 'passkeys', 'email_tokens']) {
    assert.equal(env.DB.rows(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`, id)[0].n, 0, table);
  }
  const scrubbed = env.DB.rows("SELECT before_json, after_json, target_label FROM audit_log WHERE target_id = ? AND action != 'user.purge'", id);
  assert.ok(scrubbed.length > 0);
  assert.ok(scrubbed.every((e) => e.before_json === '{"purged":true}' && e.target_label === null));
  const other = await signup(env, 'Restorable');
  await admin.del(`/api/admin/users/${other.user.id}`);
  assert.equal((await admin.post(`/api/admin/users/${other.user.id}/purge`, { confirm: 'wrong' })).status, 400);
  const restored = await admin.post(`/api/admin/users/${other.user.id}/restore`, {});
  assert.equal(restored.body.user.status, 'pending_approval', 'back to the status it had');
  assert.equal((await admin.post(`/api/admin/users/${other.user.id}/purge`, { confirm: 'Restorable' })).status, 409, 'only deleted accounts');
});

test('force sign-out and single session revocation', async () => {
  const { admin, target } = await cast();
  const detail = await admin.get(`/api/admin/users/${target.user.id}`);
  const sid = detail.body.sessions[0].id;
  assert.equal((await admin.del(`/api/admin/users/${target.user.id}/sessions/${sid}`)).status, 204);
  assert.equal((await target.get('/api/auth/me')).body.user, null);
  assert.equal((await admin.del(`/api/admin/users/${target.user.id}/sessions/${sid}`)).status, 404);
  await target.post('/api/auth/login', { login: 'target', password: PASSWORD });
  assert.equal((await admin.post(`/api/admin/users/${target.user.id}/logout`, {})).status, 204);
  assert.equal((await target.get('/api/auth/me')).body.user, null);
});

test('site settings: versioned edits, validation, audit, effect on signup', async () => {
  const { env, admin } = await cast();
  const s = await admin.get('/api/admin/site');
  assert.equal(s.body.settings.version, 0);
  assert.equal(s.res.headers.get('etag'), '"v0"');
  assert.equal(s.body.services.email, false);
  assert.equal(s.body.effective.registration.emailVerificationRequired, false);
  assert.equal((await admin.patch('/api/admin/site', { motd: 'x' })).status, 428);
  const r = await admin.patch('/api/admin/site', { registration: { open: false }, motd: 'Maintenance tonight\nBack soon' }, { headers: { 'If-Match': '"v0"' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.settings.version, 1);
  assert.equal(r.body.settings.registration.open, false);
  assert.equal(r.body.settings.registration.approvalRequired, true, 'merge keeps the rest');
  assert.equal((await new Browser(env).get('/api/site')).body.motd, 'Maintenance tonight\nBack soon');
  assert.equal((await admin.patch('/api/admin/site', { motd: 'y' }, { headers: { 'If-Match': '"v0"' } })).status, 412);
  for (const bad of [{ registration: { open: 'yes' } }, { login: { sms: true } }, { theme: 'dark' }, { motd: 'x'.repeat(501) }, { motd: 'a‮b' }]) {
    assert.equal((await admin.patch('/api/admin/site', bad, { headers: { 'If-Match': '"v1"' } })).status, 400, JSON.stringify(bad).slice(0, 60));
  }
  const signupTry = await new Browser(env, { ip: '203.0.113.30' }).post('/api/auth/signup', { username: 'Blocked', email: 'blocked@example.com', password: PASSWORD, acceptPrivacy: true });
  assert.equal(signupTry.body.error.code, 'registration_closed');
  const entry = (await admin.get('/api/admin/audit?action=site.update')).body.entries[0];
  assert.equal(entry.before.registration.open, true);
  assert.equal(entry.after.registration.open, false);
});

test('audit log filters and stats', async () => {
  const { admin, mod, target, user } = await cast();
  await mod.post(`/api/admin/users/${target.user.id}/approve`, {});
  await admin.post(`/api/admin/users/${user.user.id}/ban`, { reason: 'test' });
  const all = await admin.get('/api/admin/audit');
  assert.equal(all.body.total, 2);
  assert.equal((await admin.get(`/api/admin/audit?actor=${mod.user.id}`)).body.total, 1);
  assert.equal((await admin.get(`/api/admin/audit?since=${clock.now + 1}`)).body.total, 0);
  assert.equal((await admin.get(`/api/admin/audit?until=${clock.now + 1}`)).body.total, 2);
  assert.equal((await admin.get('/api/admin/audit?action=nope')).status, 400);
  const stats = await mod.get('/api/admin/stats');
  assert.equal(stats.status, 200);
  assert.equal(stats.body.users.total, 4);
  assert.deepEqual(stats.body.users.byRole, { user: 2, moderator: 1, admin: 1 });
  assert.equal(stats.body.users.byStatus.banned, 1);
  assert.equal(stats.body.users.byStatus.active, 3);
  assert.equal(stats.body.bans.accounts, 1);
  assert.deepEqual(stats.body.services, { email: false, discord: false, replays: true, realtime: true });
  assert.ok(stats.body.sessions.active >= 3);
  assert.deepEqual(stats.body.games, { lobbies: 0, running: 0 });
});

test('relay budgets: admins see what an account and its recent networks used, and reset them with an audit entry', async () => {
  const { env, admin, mod, target } = await cast();
  const id = target.user.id;
  const salt = env.IP_HASH_SALT;
  const now = Date.now();
  // Target signed up from 198.51.100.4: two completed package downloads, 40 MiB of music, and its network's counters.
  for (let i = 0; i < 2; i++) await takeQuota(env.DB, salt, 'content-account', id, CONTENT_ACCOUNT_LIMIT, 24 * 3600 * 1000, now);
  await takeQuota(env.DB, salt, 'scores-bytes', id, 256, 24 * 3600 * 1000, now, 40);
  for (let i = 0; i < 3; i++) await takeQuota(env.DB, salt, 'content-net', '198.51.100.4', CONTENT_NET_LIMIT, 3600 * 1000, now);
  await takeQuota(env.DB, salt, 'content-tries', '198.51.100.4', 30, 3600 * 1000, now);
  const detail = (await admin.get(`/api/admin/users/${id}`)).body.relay;
  assert.equal(detail.account.content.used, 2);
  assert.equal(detail.account.content.limit, CONTENT_ACCOUNT_LIMIT);
  assert.equal(detail.account.content.unit, 'downloads');
  assert.equal(detail.account.content.resetsAt, Math.floor(now / 864e5) * 864e5 + 864e5);
  assert.equal(detail.account.music.used, 40);
  assert.equal(detail.networks.length, 1);
  assert.equal(detail.networks[0].network, '198.51.100.4');
  assert.deepEqual([detail.networks[0].content.used, detail.networks[0].contentAttempts.used, detail.networks[0].music.used], [3, 1, 0]);
  assert.equal((await mod.get(`/api/admin/users/${id}`)).body.relay, undefined, 'moderators do not see them');
  const reset = await admin.req('DELETE', `/api/admin/users/${id}/relay-quota`);
  assert.equal(reset.status, 200);
  assert.equal(reset.body.relay.account.content.used, 0);
  assert.equal(reset.body.relay.account.music.used, 0);
  assert.equal(reset.body.relay.networks[0].content.used, 0);
  const entry = (await admin.get('/api/admin/audit?action=user.relay_quota_reset')).body.entries[0];
  assert.equal(entry.target.id, id);
  assert.deepEqual(entry.before, { account: { content: 2, music: 40, contentAttempts: 0, musicAttempts: 0, movies: 0, moviesAttempts: 0 }, networks: [{ content: 3, contentAttempts: 1, music: 0, movies: 0 }] });
  assert.ok(!JSON.stringify(entry).includes('198.51.100.4'), 'no address in the audit log');
  assert.equal((await mod.req('DELETE', `/api/admin/users/${id}/relay-quota`)).status, 403);
});

test('guide progress: admins see it per user, filter and sort by it, and complete, reset or restart it with an audit entry', async () => {
  const { env, admin, mod, user, target } = await cast();
  const id = target.user.id;
  const { stepIds, tourIds } = guideIndex();
  const action = (a, b = admin, opts) => b.post(`/api/admin/users/${id}/guide`, { action: a }, opts);
  // No settings document yet: the progress is only in the player's browser, so nothing to act on.
  const none = await action('reset');
  assert.equal(none.status, 409);
  assert.match(none.body.error.message, /no settings in the account yet/);
  assert.equal((await admin.get(`/api/admin/users/${id}`)).body.guide.stored, false);

  // The player plays: three tour steps and a passive one, the tour switched off, synced as usual.
  const guide = { done: { 'base.mcv': true, 'base.power': true, 'base.refinery': true, 'power.low': true }, tourInGames: false, seen: '0.19.0', lastTip: 4 };
  assert.equal((await target.put('/api/account/settings', { settings: { audio: { master: 0.4 }, guide } }, { headers: { 'If-Match': '"v0"' } })).status, 200);
  await user.put('/api/account/settings', { settings: { guide: { done: Object.fromEntries(stepIds.map((s) => [s, true])), quickTipsAsked: true } } }, { headers: { 'If-Match': '"v0"' } });
  // A settings document without guide.done (only other settings): no step done.
  assert.equal((await mod.put('/api/account/settings', { settings: { audio: { master: 0.3 }, guide: { lastTip: 2 } } }, { headers: { 'If-Match': '"v0"' } })).status, 200);

  // The detail: steps, the tour's state, chapter and step, the switch, the question, seen, the last write.
  const detail = (await admin.get(`/api/admin/users/${id}`)).body.guide;
  assert.deepEqual(detail.steps, { done: 4, total: stepIds.length });
  assert.deepEqual(detail.tour, { done: 3, total: tourIds.length, state: 'off', chapter: 'base', chapterIndex: 0, chapters: GUIDE_OUTLINE.tourOrder.length, step: 'base.barracks' });
  assert.deepEqual([detail.tourInGames, detail.quickTipsAsked, detail.seen, detail.resetAt, detail.stored], [false, false, '0.19.0', null, true]);
  assert.equal(detail.updatedAt, Date.now());
  // Moderators see no settings, so no guide progress either.
  assert.equal((await mod.get(`/api/admin/users/${id}`)).body.guide, undefined);

  // The list: a guide summary on every row (admins), a filter and a sort.
  const list = await admin.get('/api/admin/users?limit=100');
  const row = (body, uid) => body.users.find((u) => u.id === uid);
  assert.deepEqual(row(list.body, id).guide.steps, { done: 4, total: stepIds.length });
  assert.equal(row(list.body, user.user.id).guide.tour.state, 'finished');
  assert.equal(row(list.body, admin.user.id).guide.stored, false);
  assert.equal(row((await mod.get('/api/admin/users')).body, id).guide, undefined);
  const names = async (q) => (await admin.get(`/api/admin/users?${q}`)).body.users.map((u) => u.username);
  assert.deepEqual(await names('guide=started'), ['Target']);
  assert.deepEqual(await names('guide=done'), ['Plain']);
  assert.deepEqual((await names('guide=none')).sort(), ['Moddy', 'Root Admin'], 'Moddy has a document without guide.done');
  assert.equal(row(list.body, mod.user.id).guide.stored, true);
  assert.equal(row(list.body, mod.user.id).guide.steps.done, 0);
  assert.deepEqual((await names('sort=guide&order=desc')).slice(0, 2), ['Plain', 'Target']);
  assert.equal((await admin.get('/api/admin/users?guide=all')).status, 400);
  assert.equal((await mod.get('/api/admin/users?guide=started')).status, 403);
  assert.equal((await mod.get('/api/admin/users?sort=guide')).status, 403);
  assert.equal((await admin.get('/api/admin/users?sort=guide&guide=started')).body.total, 1, 'the count query works with the filter');

  // Bad requests: an unknown action, an unknown field, no CSRF header.
  assert.equal((await action('wipe')).status, 400);
  assert.equal((await admin.post(`/api/admin/users/${id}/guide`, { action: 'reset', extra: 1 })).status, 400);
  assert.equal((await action('reset', admin, { headers: { 'X-WebRA-CSRF': null } })).status, 403);
  assert.equal((await action('reset', admin, { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await admin.post('/api/admin/users/ffffffffffffffffffffffffffffffff/guide', { action: 'reset' })).status, 404);

  // Reset: a new version, every step open, the tour on, the question to ask again, a reset epoch; the rest kept.
  const before = (await admin.get(`/api/admin/users/${id}/settings`)).body;
  const reset = await action('reset');
  assert.equal(reset.status, 200, JSON.stringify(reset.body));
  assert.equal(reset.res.headers.get('etag'), `"v${before.version + 1}"`);
  assert.equal(reset.body.version, before.version + 1);
  assert.deepEqual(reset.body.settings.guide, { done: {}, tourInGames: true, seen: '0.19.0', lastTip: 4, quickTipsAsked: false, resetAt: Date.now() });
  assert.equal(reset.body.settings.audio.master, 0.4);
  assert.equal(reset.body.guide.tour.state, 'running');
  assert.equal(reset.body.guide.resetAt, Date.now());
  const stored = (await target.get('/api/account/settings')).body;
  assert.equal(stored.version, before.version + 1, 'the player\'s game sees the newer version on its next sync');
  assert.deepEqual(stored.settings.guide.done, {});
  const entry = (await admin.get('/api/admin/audit?action=user.guide_update')).body.entries[0];
  assert.equal(entry.actor.id, admin.user.id);
  assert.deepEqual(entry.target, { type: 'user', id, label: 'Target' });
  assert.equal(Object.keys(entry.before.guide.done).length, 4);
  assert.equal(entry.after.action, 'reset');
  assert.deepEqual(entry.after.guide.done, {});

  // Complete: every step, the question counted as asked; the switch stays; a newer epoch even in the same millisecond.
  const complete = await action('complete');
  assert.equal(complete.body.guide.steps.done, stepIds.length);
  assert.equal(complete.body.guide.tour.state, 'finished');
  assert.equal(complete.body.settings.guide.quickTipsAsked, true);
  assert.equal(complete.body.settings.guide.tourInGames, true);
  assert.equal(complete.body.settings.guide.resetAt, Date.now() + 1);
  // Restart tour: the tour's steps only.
  const restart = await action('restartTour');
  assert.equal(restart.body.guide.tour.done, 0);
  assert.equal(restart.body.guide.steps.done, stepIds.length - tourIds.length);
  assert.equal(restart.body.settings.guide.quickTipsAsked, true);
  assert.equal((await admin.get('/api/admin/audit?action=user.guide_update')).body.entries.length, 3);

  // A write of the player between the server's read and its write: the action runs again on the newer document.
  const prepare = env.DB.prepare.bind(env.DB);
  let raced = false;
  env.DB.prepare = (sql) => {
    if (!raced && /^UPDATE settings_docs SET version/.test(sql)) {
      raced = true;
      env.DB.sqlite.prepare("UPDATE settings_docs SET version = version + 1, doc = json_set(doc, '$.audio.master', 0.7) WHERE user_id = ?1").run(id);
    }
    return prepare(sql);
  };
  const again = await action('reset');
  env.DB.prepare = prepare;
  assert.equal(raced, true);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.version, restart.body.version + 2);
  assert.equal(again.body.settings.audio.master, 0.7, 'the player\'s write is kept');
  assert.deepEqual(again.body.settings.guide.done, {});
  assert.equal((await admin.get('/api/admin/audit?action=user.guide_update')).body.entries.length, 4, 'one entry for the action');
  // Writes that keep coming: after three tries the admin is told to try again, nothing is written.
  env.DB.prepare = (sql) => {
    if (/^UPDATE settings_docs SET version/.test(sql)) env.DB.sqlite.prepare('UPDATE settings_docs SET version = version + 1 WHERE user_id = ?1').run(id);
    return prepare(sql);
  };
  const busy = await action('reset');
  env.DB.prepare = prepare;
  assert.equal(busy.status, 409);
  assert.equal(busy.body.error.message, "The player's settings kept changing; try again in a moment.");
  assert.equal((await admin.get('/api/admin/audit?action=user.guide_update')).body.entries.length, 4);

  // The player wrote meanwhile with the version they had: their write is refused (412) and merges as usual.
  assert.equal((await target.put('/api/account/settings', { settings: { guide } }, { headers: { 'If-Match': `"v${before.version}"` } })).status, 412);

  // An action on a document that no longer passes validation is refused, nothing written.
  env.DB.sqlite.prepare("UPDATE settings_docs SET doc = ?1 WHERE user_id = ?2").run(JSON.stringify({ guide: { lastTip: 'x' } }), id);
  const broken = await action('reset');
  assert.equal(broken.status, 400);
  assert.equal((await admin.get('/api/admin/audit?action=user.guide_update')).body.entries.length, 4);

  // Admins act within a rate limit (120 an hour each).
  for (let i = 0; i < 120; i++) await takeQuota(env.DB, env.IP_HASH_SALT, 'admin-guide', admin.user.id, 120, 3600 * 1000, Date.now());
  assert.equal((await action('reset')).status, 429);
});

test('approve all pending: admins only, CSRF, at most APPROVE_ALL_MAX per call, banned and unverified left alone, one audit entry, realtime hints', async () => {
  const { env, admin, mod, target } = await cast();
  // 104 more accounts waiting for approval (older than Target), one of them banned, and one waiting for its email.
  const insert = env.DB.sqlite.prepare(
    "INSERT INTO users (id, username, username_key, display_name, avatar_color, status, user_handle, created_at) VALUES (?, ?, ?, ?, '#808080', ?, ?, ?)",
  );
  const ids = [];
  for (let i = 0; i < 106; i++) {
    const id = (0x10000000 + i).toString(16).padStart(32, '0');
    insert.run(id, `Wait${i}`, `wait${i}`, `Wait${i}`, i === 105 ? 'pending_email' : 'pending_approval', `h${i}`, Date.UTC(2026, 0, 1) + i);
    ids.push(id);
  }
  env.DB.sqlite.prepare("INSERT INTO account_bans (user_id, reason, created_at) VALUES (?, 'spam', 0)").run(ids[104]);
  const path = '/api/admin/users/approve-pending';
  assert.equal((await mod.post(path, {})).status, 403, 'moderators approve one by one');
  assert.equal((await admin.post(path, {}, { csrf: false })).status, 403, 'CSRF like every admin mutation');
  assert.equal((await admin.post(path, { all: true })).status, 400, 'no fields');
  const hubs = env.USER_HUB;
  hubs.publishes.length = 0;
  const first = await admin.post(path, {});
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual(first.body, { approved: APPROVE_ALL_MAX, remaining: 104 + 1 - APPROVE_ALL_MAX });
  assert.equal(APPROVE_ALL_MAX, 100);
  const active = (id) => env.DB.rows('SELECT status, approved_by FROM users WHERE id = ?', id)[0];
  assert.deepEqual(active(ids[0]), { status: 'active', approved_by: admin.user.id }, 'oldest first');
  assert.equal(active(target.user.id).status, 'pending_approval', 'the newest waits for the next call');
  const second = await admin.post(path, {});
  assert.deepEqual(second.body, { approved: 5, remaining: 0 });
  assert.equal(active(target.user.id).status, 'active');
  assert.equal(active(ids[104]).status, 'pending_approval', 'a banned account is not approved');
  assert.equal(active(ids[105]).status, 'pending_email', 'an unconfirmed address is not approved');
  assert.deepEqual((await admin.post(path, {})).body, { approved: 0, remaining: 0 });
  // One audit entry per call, with the count and the ids.
  const entries = env.DB.rows("SELECT actor_id, after_json FROM audit_log WHERE action = 'user.approve_all' ORDER BY id");
  assert.equal(entries.length, 2);
  assert.equal(entries[0].actor_id, admin.user.id);
  assert.equal(JSON.parse(entries[0].after_json).count, 100);
  assert.equal(JSON.parse(entries[1].after_json).userIds.length, 5);
  // Each approved account hears it; the other dashboards reload once per call.
  const statusHints = hubs.publishes.filter((p) => p.topic === 'account' && p.kind === 'status');
  assert.equal(statusHints.length, 105);
  assert.ok(statusHints.every((p) => p.data.status === 'active'));
  assert.equal(hubs.publishes.filter((p) => p.name === 'topic:admin' && p.kind === 'user_approved').length, 2);
  // Nobody is left waiting for approval (the banned account lists as banned).
  assert.deepEqual((await admin.get('/api/admin/users?status=pending_approval')).body.users, []);
  assert.deepEqual((await admin.get('/api/admin/users?status=banned')).body.users.map((u) => u.username), ['Wait104']);
});

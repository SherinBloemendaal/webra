// Regression tests for the security review of the accounts system (findings
// F1 to F8 and the informational items, docs/security.md "Accounts review").
// Each test replays the reviewer's exploit and checks that it now fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Browser, Clock, makeEnv, PASSWORD, promote, setSite, signup } from './accounts-harness.mjs';
import { makeSession } from './fake-do.mjs';
import { FakeD1 } from './fake-d1.mjs';
import { PROTOCOL_VERSION } from '@webra/protocol';
import { discordName } from '../src/accounts/discord.js';
import { parseCidr } from '../src/accounts/ip.js';
import { sha256Hex } from '../src/crypto.js';
import { DEV_IP_SALT } from '../src/ipkey.js';
import { APP_PURPOSES } from '../src/accounts/context.js';

const clock = new Clock();
test.after(() => clock.restore());

/** Count PBKDF2 derivations while `fn` runs. */
async function derivations(fn) {
  const subtle = globalThis.crypto.subtle;
  const original = subtle.deriveBits;
  let n = 0;
  subtle.deriveBits = function (...args) {
    if (args[0]?.name === 'PBKDF2') n++;
    return original.apply(this, args);
  };
  try {
    await fn();
  } finally {
    subtle.deriveBits = original;
  }
  return n;
}

async function staff(env, name, role) {
  const b = await signup(env, name);
  promote(env, b.user.id, role);
  assert.equal((await b.post('/api/auth/login', { login: name.toLowerCase(), password: PASSWORD })).status, 200);
  return b;
}

// ---- F2: staff powers need an active account; status changes; moderation rules ----------------------

test('F2: pending or deactivated staff have no powers; status changes sign out; moderators cannot touch staff', async () => {
  const env = makeEnv({ email: false });
  const admin = await staff(env, 'Root Admin', 'admin');
  const mod = await staff(env, 'Mod One', 'moderator');
  // A pending admin-to-be: moderators cannot reject (or approve) staff.
  const newAdmin = await signup(env, 'New Admin');
  env.DB.sqlite.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(newAdmin.user.id);
  assert.equal((await mod.post(`/api/admin/users/${newAdmin.user.id}/reject`, { reason: 'bye' })).status, 403);
  assert.equal((await mod.post(`/api/admin/users/${newAdmin.user.id}/approve`, {})).status, 403);
  // A pending moderator has no moderator powers, not even over itself.
  const pendingMod = await signup(env, 'Pending Mod');
  env.DB.sqlite.prepare("UPDATE users SET role = 'moderator' WHERE id = ?").run(pendingMod.user.id);
  const list = await pendingMod.get('/api/admin/users');
  assert.equal(list.status, 403);
  assert.equal(list.body.error.code, 'account_inactive');
  assert.equal((await pendingMod.post(`/api/admin/users/${pendingMod.user.id}/approve`, {})).status, 403);
  // Moderators cannot approve themselves or other staff either way.
  assert.equal((await mod.post(`/api/admin/users/${mod.user.id}/approve`, {})).status, 403);
  // An admin set back to pending by another admin is signed out at once and powerless.
  const second = await staff(env, 'Second Admin', 'admin');
  const r = await admin.patch(`/api/admin/users/${second.user.id}`, { status: 'pending_approval' });
  assert.equal(r.status, 200);
  assert.equal((await second.get('/api/auth/me')).body.user, null, 'sessions revoked');
  assert.equal((await second.post(`/api/admin/users/${admin.user.id}/ban`, { reason: 'revenge' })).status, 401);
  // Even with a session left over (status changed directly in the database), the role is not enough.
  const third = await staff(env, 'Third Admin', 'admin');
  env.DB.sqlite.prepare("UPDATE users SET status = 'pending_approval' WHERE id = ?").run(third.user.id);
  assert.equal((await third.get('/api/admin/audit')).status, 403);
  assert.equal((await third.patch('/api/admin/site', { motd: 'owned' }, { headers: { 'If-Match': '"v0"' } })).status, 403);
});

test('F2: the reviewer repro (r8): a deactivated admin cannot ban the last active admin; self actions refused', async () => {
  const env = makeEnv({ email: false });
  const a1 = await staff(env, 'Admin One', 'admin');
  const a2 = await staff(env, 'Admin Two', 'admin');
  assert.equal((await a1.patch(`/api/admin/users/${a2.user.id}`, { status: 'pending_approval' })).status, 200);
  assert.equal((await a2.get('/api/auth/me')).body.user, null);
  // Signed in again, but pending: no staff powers.
  await a2.post('/api/auth/login', { login: 'admin two', password: PASSWORD });
  assert.equal((await a2.patch(`/api/admin/users/${a1.user.id}`, { role: 'user' })).status, 403);
  assert.equal((await a2.post(`/api/admin/users/${a1.user.id}/ban`, { reason: 'revenge' })).status, 403);
  assert.equal((await a1.get('/api/auth/me')).body.user.status, 'active');
  // The last active admin cannot take itself out of service.
  for (const [method, path, body] of [
    ['PATCH', `/api/admin/users/${a1.user.id}`, { status: 'pending_approval' }],
    ['PATCH', `/api/admin/users/${a1.user.id}`, { role: 'user' }],
    ['POST', `/api/admin/users/${a1.user.id}/ban`, { reason: 'x' }],
    ['DELETE', `/api/admin/users/${a1.user.id}`, undefined],
  ]) {
    assert.equal((await a1.req(method, path, body)).status, 403, `${method} ${path}`);
  }
  // Banned admins do not count: with a2 approved and then banned, a1 still cannot leave.
  assert.equal((await a1.post(`/api/admin/users/${a2.user.id}/approve`, {})).status, 200);
  assert.equal((await a1.post(`/api/admin/users/${a2.user.id}/ban`, { reason: 'x' })).status, 201);
  const active = env.DB.rows(
    "SELECT COUNT(*) AS n FROM users u WHERE role = 'admin' AND status = 'active' AND NOT EXISTS (SELECT 1 FROM account_bans b WHERE b.user_id = u.id AND b.revoked_at IS NULL)",
  )[0].n;
  assert.equal(active, 1);
});

// ---- F1: lockouts that a third party cannot use against the owner ----------------------------------

test('F1: the reviewer repro (r1): one budget per account and address, owner not locked out', async () => {
  const env = makeEnv({ email: false });
  const victim = await signup(env, 'Victim', { ip: '198.51.100.40' });
  promote(env, victim.user.id);
  env.DB.sqlite.prepare("UPDATE users SET email = 'victim@example.com', email_key = 'victim@example.com', email_verified = 1 WHERE id = ?").run(victim.user.id);
  const a = new Browser(env, { ip: '203.0.113.1' });
  const fail = async (b, login) => (await b.post('/api/auth/login', { login, password: 'wrong password 1' })).body.error.code;
  for (let i = 0; i < 10; i++) await fail(a, 'Victim');
  assert.equal(await fail(a, 'Victim'), 'locked');
  assert.equal(await fail(a, 'victim@example.com'), 'locked', 'the email is not a fresh budget');
  for (const ip of ['203.0.113.2', '203.0.113.3']) {
    const b = new Browser(env, { ip });
    for (let i = 0; i < 30; i++) await fail(b, 'victim@example.com');
  }
  clock.advance(16 * 60 * 1000);
  const owner = new Browser(env, { ip: '198.51.100.40' });
  assert.equal((await owner.post('/api/auth/login', { login: 'victim@example.com', password: PASSWORD })).status, 200);
});

// ---- F3: one key derivation per request -------------------------------------------------------------

test('F3: no request derives a password key more than once', async () => {
  const env = makeEnv({ email: true, vars: { PASSWORD_ITERATIONS: '20000' } });
  let b;
  assert.equal(await derivations(async () => (b = await signup(env, 'Cpu User'))), 1, 'signup');
  promote(env, b.user.id);
  env.PASSWORD_ITERATIONS = '30000';
  env.PASSWORD_PEPPER = 'a pepper of sixteen+ characters';
  const login = new Browser(env, { ip: '198.51.100.5' });
  assert.equal(await derivations(() => login.post('/api/auth/login', { login: 'cpu user', password: PASSWORD })), 1, 'login, even when the hash is outdated');
  assert.equal(await derivations(() => login.post('/api/auth/login', { login: 'nobody', password: PASSWORD })), 1, 'unknown login');
  assert.equal(await derivations(() => login.post('/api/auth/reauth', { password: PASSWORD })), 1, 'reauth');
  assert.equal(await derivations(() => login.post('/api/account/password', { newPassword: 'another long passphrase' })), 1, 'password change');
  const row = env.DB.rows('SELECT password_iterations, password_peppered FROM users')[0];
  assert.deepEqual([row.password_iterations, row.password_peppered], [30000, 1], 'upgraded when the password was set');
  await login.post('/api/auth/password/forgot', { email: 'cpu.user@example.com' });
  const token = env.EMAIL.token('cpu.user@example.com', 'reset');
  assert.ok(token);
  assert.equal(await derivations(() => new Browser(env).post('/api/auth/password/reset', { token, password: 'reset passphrase here' })), 1, 'reset');
});

// ---- F4: D1 writes ------------------------------------------------------------------------------------

test('F4: refused requests write nothing; the rate limiting binding keeps bursts out of D1', async () => {
  const env = makeEnv({ email: false });
  const b = new Browser(env, { ip: '203.0.113.60' });
  for (let i = 0; i < 30; i++) await b.post('/api/auth/login', { login: `u${i}`, password: 'x password' });
  const before = env.DB.writes;
  for (let i = 0; i < 20; i++) assert.equal((await b.post('/api/auth/login', { login: 'u', password: 'x password' })).status, 429);
  assert.equal(env.DB.writes, before, 'over the limit: reads only');
  // With the binding, bursts never reach D1's rate_limits table.
  const calls = [];
  const env2 = makeEnv({ email: false, vars: { AUTH_LIMITER: { limit: async ({ key }) => (calls.push(key), { success: calls.length <= 3 }) } } });
  const c = new Browser(env2, { ip: '203.0.113.61' });
  for (let i = 0; i < 3; i++) await c.post('/api/auth/passkey/options', {});
  const r = await c.post('/api/auth/passkey/options', {});
  assert.equal(r.status, 429);
  assert.equal(env2.DB.rows("SELECT COUNT(*) AS n FROM rate_limits WHERE key LIKE 'passkey%'")[0].n, 0);
  assert.ok(calls.every((k) => /^passkey:[0-9a-f]{64}$/.test(k) && !k.includes('203.0.113.61')), 'binding keys are keyed hashes');
});

test('burst limits: sign-in purposes count on AUTH_LIMITER, what a signed-in game calls by itself on APP_LIMITER', async () => {
  const seen = { auth: [], app: [] };
  const limiter = (name, max) => ({ limit: async ({ key }) => (seen[name].push(key.split(':')[0]), { success: seen[name].filter((p) => p === key.split(':')[0]).length <= max }) });
  const env = makeEnv({ email: false, vars: { AUTH_LIMITER: limiter('auth', 2), APP_LIMITER: limiter('app', 1000) } });
  assert.deepEqual([...APP_PURPOSES].sort(), ['friends-list', 'presence', 'realtime', 'session-ws']);
  const b = await signup(env, 'Nat Player', { ip: '203.0.113.70' });
  promote(env, b.user.id);
  await b.post('/api/auth/login', { login: 'nat player', password: PASSWORD });
  // Many players behind one address: presence and friends lists go on long after sign-in bursts are spent.
  for (let i = 0; i < 30; i++) {
    assert.equal((await b.get('/api/account/friends')).status, 200);
    assert.notEqual((await b.post('/api/account/presence', { away: false })).status, 429);
  }
  assert.equal((await b.post('/api/auth/login', { login: 'nat player', password: PASSWORD })).status, 200);
  assert.equal((await b.post('/api/auth/login', { login: 'nat player', password: PASSWORD })).status, 429, 'the sign-in budget is separate');
  assert.ok(seen.app.includes('friends-list') && seen.app.includes('presence'));
  assert.ok(!seen.auth.includes('friends-list') && !seen.auth.includes('presence'));
  assert.ok(seen.auth.includes('login') && !seen.app.includes('login'));
  // The session socket counts on APP_LIMITER too.
  await b.req('GET', `/api/sessions/${'a'.repeat(64)}/ws`, undefined, { headers: { Upgrade: 'websocket' } });
  assert.ok(seen.app.includes('session-ws'));
});

test('F4: an active session costs at most one row write per 15 minutes', async () => {
  const env = makeEnv({ email: false });
  const b = await signup(env, 'Busy Player', { ip: '198.51.100.9' });
  clock.advance(60 * 60 * 1000);
  await b.get('/api/auth/me'); // hourly: session, last seen and IP history
  let before = env.DB.writes;
  for (let i = 0; i < 3; i++) {
    clock.advance(15 * 60 * 1000);
    await b.get('/api/auth/me');
  }
  assert.ok(env.DB.writes - before <= 4, `writes: ${env.DB.writes - before}`);
  before = env.DB.writes;
  for (let i = 0; i < 20; i++) {
    clock.advance(30 * 1000);
    await b.get('/api/auth/me');
  }
  assert.equal(env.DB.writes - before, 0, 'no writes between touches');
});

// ---- F5: keyed IP hashes ------------------------------------------------------------------------------

test('F5: stored address hashes are keyed; production refuses to run without the secret', async () => {
  const env = makeEnv({ email: false });
  await signup(env, 'Hash Probe', { ip: '198.51.100.77' });
  const stored = env.DB.rows('SELECT ip_hash FROM auth_sessions')[0].ip_hash;
  assert.notEqual(stored, await sha256Hex('webra-session-ip::198.51.100.77'));
  assert.notEqual(stored, await sha256Hex('198.51.100.77'));
  for (const { key } of env.DB.rows('SELECT key FROM rate_limits')) assert.ok(!key.includes('198.51.100.77'));
  const bare = makeEnv({ email: false, vars: { IP_HASH_SALT: undefined } });
  const r = await new Browser(bare).post('/api/auth/signup', { username: 'No Salt', email: 'nosalt@example.com', password: PASSWORD, acceptPrivacy: true });
  assert.equal(r.status, 503);
  assert.equal(r.body.error.code, 'misconfigured');
  assert.equal(bare.DB.rows('SELECT COUNT(*) AS n FROM users')[0].n, 0);
  // Local development (plain HTTP to localhost) uses a fixed development salt.
  const local = await new Browser(bare, { origin: 'http://localhost:8799' }).post('/api/auth/signup', { username: 'Local Dev', email: 'localdev@example.com', password: PASSWORD, acceptPrivacy: true });
  assert.equal(local.status, 201);
  assert.ok(DEV_IP_SALT.length >= 16);
});

// ---- F6: unverified addresses -------------------------------------------------------------------------

test('F6: the reviewer repro (r5): no squatting, no reset to unverified addresses', async () => {
  const env = makeEnv({ email: false });
  const squatter = await signup(env, 'Squatter');
  promote(env, squatter.user.id);
  await squatter.post('/api/auth/reauth', { password: PASSWORD });
  const r = await squatter.post('/api/account/email', { email: 'ceo@bigcorp.example' });
  assert.equal(r.status, 503, 'a confirmed address is not swapped for one nobody can confirm');
  // Without email sending a new account still gives an address; it stays unverified and claims nothing.
  const typo = await new Browser(env).post('/api/auth/signup', { username: 'Typo Guy', email: 'ceo@bigcorp.example', password: PASSWORD, acceptPrivacy: true });
  assert.equal(typo.status, 201);
  assert.equal(typo.body.user.emailVerified, false);
  assert.equal(env.DB.rows("SELECT COUNT(*) AS n FROM users WHERE email_key = 'ceo@bigcorp.example'")[0].n, 0);
  // With email working: an unverified address does not block the real owner and gets no reset link.
  const env2 = makeEnv({ email: true });
  await setSite(env2, { registration: { emailVerification: false } });
  const claimer = await signup(env2, 'Claimer', { email: 'ceo@bigcorp.example' });
  assert.equal(claimer.user.emailVerified, false);
  const owner = await new Browser(env2, { ip: '198.51.100.31' }).post('/api/auth/signup', { username: 'Real CEO', email: 'ceo@bigcorp.example', password: PASSWORD, acceptPrivacy: true });
  assert.equal(owner.status, 201, 'unverified claims never block a signup');
  const sent = env2.EMAIL.sent.length;
  assert.equal((await new Browser(env2).post('/api/auth/password/forgot', { email: 'ceo@bigcorp.example' })).status, 202);
  assert.equal(env2.EMAIL.sent.length, sent, 'no reset link to an unverified address');
  // The address the owner confirms is theirs; the claimer's link then conflicts.
  const ownerToken = env2.EMAIL.sent.filter((m) => m.to === 'ceo@bigcorp.example').map((m) => /#verify=([A-Za-z0-9_-]{43})/.exec(m.text)?.[1]);
  assert.equal(ownerToken.length, 2, 'one link per account');
  assert.equal((await new Browser(env2).post('/api/auth/email/verify', { token: ownerToken[1] })).status, 200);
  assert.equal((await new Browser(env2).post('/api/auth/email/verify', { token: ownerToken[0] })).status, 409);
  // Unverified addresses are no longer cleared by the daily job (every account keeps its address; it claims nothing).
  const { scheduled } = await import('./accounts-harness.mjs');
  clock.advance(8 * 24 * 60 * 60 * 1000);
  await scheduled(env2, clock.now);
  assert.deepEqual(env2.DB.rows('SELECT email, email_key, email_verified, status FROM users WHERE id = ?', claimer.user.id)[0], {
    email: 'ceo@bigcorp.example',
    email_key: null,
    email_verified: 0,
    status: 'pending_approval',
  });
});

// ---- F7: last sign-in method --------------------------------------------------------------------------

test('F7: concurrent removals never leave an account without a sign-in method', async () => {
  const env = makeEnv({ email: false });
  const b = await signup(env, 'Race User');
  promote(env, b.user.id);
  await b.post('/api/auth/login', { login: 'race user', password: PASSWORD });
  await b.post('/api/auth/reauth', { password: PASSWORD });
  env.DB.sqlite.prepare("UPDATE users SET discord_id = '42', discord_username = 'x', discord_linked_at = 1 WHERE id = ?").run(b.user.id);
  const [d1, d2] = await Promise.all([b.del('/api/account/password'), b.del('/api/account/discord')]);
  const row = env.DB.rows('SELECT password_hash, discord_id FROM users WHERE id = ?', b.user.id)[0];
  assert.ok(row.password_hash !== null || row.discord_id !== null, `a method is left (${d1.status}, ${d2.status})`);
  assert.deepEqual([d1.status, d2.status].sort(), [200, 409].sort());
});

// ---- F8 and informational items -------------------------------------------------------------------------

test('F8: Discord usernames go through the text rules', () => {
  assert.equal(discordName('  nelly  '), 'nelly');
  assert.equal(discordName('evil‮gnp'), 'Discord user');
  assert.equal(discordName('a\u0000b'), 'Discord user');
  assert.equal(discordName(''), 'Discord user');
  assert.equal(discordName(42), 'Discord user');
  assert.equal(discordName('x'.repeat(65)), 'Discord user');
});

test('settings documents refuse __proto__, constructor and prototype keys (r3)', async () => {
  const env = makeEnv({ email: false });
  const u = await signup(env, 'Proto User');
  for (const body of [
    '{"settings":{"extra":{"__proto__":{"polluted":1}}}}',
    '{"settings":{"extra":{"constructor":{"prototype":{"x":1}}}}}',
    '{"settings":{"game":{"hotkeys":{"constructor":["b"]}}}}',
    '{"settings":{"game":{"hotkeys":{"__proto__":["a"]}}}}',
    '{"settings":{"__proto__":{"x":1}}}',
  ]) {
    const r = await u.put('/api/account/settings', body, { headers: { 'If-Match': '"v0"' } });
    assert.equal(r.status, 400, body);
  }
  assert.equal({}.polluted, undefined);
  assert.equal(env.DB.rows('SELECT COUNT(*) AS n FROM settings_docs')[0].n, 0);
});

test('IPv6 bans default to /64; reset links record that they were displayed', async () => {
  assert.equal(parseCidr('2001:db8::1234').cidr, '2001:db8::/64');
  assert.equal(parseCidr('2001:db8::1234/128').cidr, '2001:db8::1234');
  assert.equal(parseCidr('203.0.113.7').cidr, '203.0.113.7');
  const env = makeEnv({ email: false });
  const admin = await staff(env, 'Link Admin', 'admin');
  const target = await signup(env, 'Link Target');
  assert.equal((await admin.post(`/api/admin/users/${target.user.id}/password-reset`, { send: false })).status, 201);
  const entry = (await admin.get('/api/admin/audit?action=user.password_reset_link')).body.entries[0];
  assert.equal(entry.after.displayed, true);
});

test('passkey re-authentication needs user verification', async () => {
  const { Authenticator } = await import('./webauthn-helper.mjs');
  const env = makeEnv({ email: false });
  const b = await signup(env, 'Uv User');
  await b.post('/api/auth/reauth', { password: PASSWORD });
  const o = await b.post('/api/account/passkeys/options', {});
  const auth = await Authenticator.create('ES256');
  await b.post('/api/account/passkeys', { challengeId: o.body.challengeId, name: 'Key', credential: await auth.register(o.body.publicKey, 'https://webra.sherin.dev') });
  clock.advance(11 * 60 * 1000);
  const ro = await b.post('/api/auth/passkey/options', { purpose: 'reauth' });
  assert.equal(ro.body.publicKey.userVerification, 'required');
  const noUv = await b.post('/api/auth/reauth', { passkey: { challengeId: ro.body.challengeId, credential: await auth.assert(ro.body.publicKey, 'https://webra.sherin.dev', { flags: 0x01 }) } });
  assert.equal(noUv.status, 401);
  assert.match(noUv.body.error.message, /verification/);
  const ro2 = await b.post('/api/auth/passkey/options', { purpose: 'reauth' });
  assert.equal((await b.post('/api/auth/reauth', { passkey: { challengeId: ro2.body.challengeId, credential: await auth.assert(ro2.body.publicKey, 'https://webra.sherin.dev') } })).status, 200);
});

test('lobby: anonymous players cannot use an account username', async () => {
  const DB = new FakeD1();
  DB.sqlite
    .prepare("INSERT INTO users (id, username, username_key, display_name, avatar_color, status, user_handle, created_at) VALUES (?, 'Tanya', 'tanya', 'Tanya', '#c8402a', 'active', 'h', 0)")
    .run('a'.repeat(32));
  const s = await makeSession({ maxPlayers: 3, DB });
  const anon = s.connect('anon');
  await s.send(anon, { t: 'hello', protocol: PROTOCOL_VERSION, version: s.version, name: 'ＴＡＮＹＡ', hostKey: s.hostKey });
  assert.equal(anon.last('error').code, 'invalid');
  const ok = s.connect('ok');
  await s.send(ok, { t: 'hello', protocol: PROTOCOL_VERSION, version: s.version, name: 'Tania', hostKey: s.hostKey });
  assert.equal(ok.last('welcome').name, 'Tania');
});

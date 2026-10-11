// Discord OAuth2 with PKCE and state against mocked Discord endpoints
// (docs/accounts-api.md section 4.6). Tests never reach discord.com.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Browser, Clock, makeEnv, ORIGIN, PASSWORD, promote, scheduled, setSite, signup } from './accounts-harness.mjs';
import { discordApi } from '../src/accounts/discord.js';
import { sha256Bytes, toBase64Url } from '../src/crypto.js';

const clock = new Clock();
test.after(() => clock.restore());

/** Mock Discord: one user profile, checks the token request (PKCE verifier, secret, redirect). */
function mockDiscord(profile, { tokenStatus = 200, meStatus = 200, scope = 'identify email' } = {}) {
  const calls = [];
  const state = { challenge: null };
  discordApi.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    if (url === 'https://discord.com/api/oauth2/token') {
      const form = new URLSearchParams(init.body);
      assert.equal(form.get('grant_type'), 'authorization_code');
      assert.equal(form.get('client_id'), '123456789');
      assert.equal(form.get('client_secret'), 'test-secret-not-real');
      assert.equal(form.get('redirect_uri'), `${ORIGIN}/api/auth/discord/callback`);
      assert.equal(form.get('code'), 'good-code');
      assert.equal(toBase64Url(await sha256Bytes(form.get('code_verifier'))), state.challenge, 'the PKCE verifier matches the challenge');
      if (tokenStatus !== 200) return new Response('{}', { status: tokenStatus });
      return Response.json({ access_token: 'at', token_type: 'Bearer', scope });
    }
    if (url === 'https://discord.com/api/users/@me') {
      assert.equal(init.headers.authorization, 'Bearer at');
      if (meStatus !== 200) return new Response('{}', { status: meStatus });
      return Response.json(profile);
    }
    if (url === 'https://discord.com/api/oauth2/token/revoke') return new Response('', { status: 200 });
    throw new Error(`unexpected fetch ${url}`);
  };
  return { calls, state };
}

/** start, then come back from Discord with `code`; returns the redirect fragment. */
async function flow(b, mock, body, { code = 'good-code', tamperState = false, dropCookie = false, error = null } = {}) {
  const s = await b.post('/api/auth/discord/start', body);
  assert.equal(s.status, 200, JSON.stringify(s.body));
  const url = new URL(s.body.url);
  assert.equal(url.origin + url.pathname, 'https://discord.com/oauth2/authorize');
  assert.equal(url.searchParams.get('scope'), 'identify email');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  mock.state.challenge = url.searchParams.get('code_challenge');
  let state = url.searchParams.get('state');
  if (tamperState) state = `${state.slice(0, -1)}${state.endsWith('A') ? 'B' : 'A'}`;
  if (dropCookie) for (const k of [...b.jar.keys()]) if (k.includes('oauth')) b.jar.delete(k);
  const q = new URLSearchParams({ state, ...(error ? { error } : { code }) });
  // A navigation from discord.com: no Origin, no CSRF header, Sec-Fetch-Site cross-site.
  const r = await b.get(`/api/auth/discord/callback?${q}`, { csrf: false, json: false, headers: { Origin: null, 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(r.status, 302);
  const loc = new URL(r.res.headers.get('location'));
  assert.equal(loc.origin, ORIGIN);
  return { path: loc.pathname, fragment: loc.hash.slice(1) };
}

const PROFILE = { id: '80351110224678912', username: 'nelly', global_name: 'Nelly', email: 'nelly@example.com', verified: true };

test('unavailable without credentials; switched off by the setting', async () => {
  const env = makeEnv({ email: false });
  const r = await new Browser(env).post('/api/auth/discord/start', { mode: 'login' });
  assert.equal(r.status, 503);
  const env2 = makeEnv({ email: false, discord: true });
  await setSite(env2, { login: { discord: false } });
  assert.equal((await new Browser(env2).post('/api/auth/discord/start', { mode: 'login' })).body.error.code, 'method_disabled');
});

test('signup with Discord: verified email stored as verified, username from Discord, then sign-in', async () => {
  const env = makeEnv({ email: true, discord: true });
  const mock = mockDiscord(PROFILE);
  const b = new Browser(env);
  assert.equal((await b.post('/api/auth/discord/start', { mode: 'signup' })).status, 400, 'privacy acceptance needed');
  const login = await flow(b, mock, { mode: 'login' });
  assert.equal(login.fragment, 'discord=error&code=no_account', 'login never creates accounts');
  // A typed address is only the fallback: Discord's verified one wins, and no link is mailed.
  const r = await flow(b, mock, { mode: 'signup', acceptPrivacy: true, returnTo: '/play/?lobby=1', email: 'typed@example.com' });
  assert.equal(r.fragment, 'discord=ok');
  assert.equal(r.path, '/play/');
  const me = (await b.get('/api/auth/me')).body.user;
  assert.equal(me.username, 'nelly');
  assert.equal(me.email, 'nelly@example.com');
  assert.equal(me.emailVerified, true);
  assert.equal(env.EMAIL.sent.length, 0);
  assert.equal(me.status, 'pending_approval', 'verified by Discord: straight to approval');
  assert.deepEqual(me.methods.discord.username, 'nelly');
  assert.ok(mock.calls.some((c) => c.url.endsWith('/token/revoke')), 'the access token is revoked');
  // Sign in again from another browser.
  const c = new Browser(env, { ip: '203.0.113.70' });
  assert.equal((await flow(c, mock, { mode: 'login' })).fragment, 'discord=ok');
  assert.equal((await c.get('/api/auth/me')).body.user.username, 'nelly');
  // A second signup with the same Discord account signs in to the same account.
  const d = new Browser(env, { ip: '203.0.113.71' });
  assert.equal((await flow(d, mock, { mode: 'signup', acceptPrivacy: true })).fragment, 'discord=ok');
  assert.equal(env.DB.rows('SELECT COUNT(*) AS n FROM users')[0].n, 1);
});

test('unverified Discord email is not used: the typed address is required and confirmed by link; taken usernames get a number; taken emails refuse', async () => {
  const env = makeEnv({ email: true, discord: true });
  const holder = await signup(env, 'nelly', { email: 'someone@example.com' });
  // Only a verified address is taken.
  await holder.post('/api/auth/email/verify', { token: env.EMAIL.token('someone@example.com', 'verify') });
  const mock = mockDiscord({ ...PROFILE, verified: false });
  const b = new Browser(env, { ip: '203.0.113.80' });
  // No verified Discord address and none typed: no account.
  assert.equal((await flow(b, mock, { mode: 'signup', acceptPrivacy: true })).fragment, 'discord=error&code=email_required');
  assert.equal(b.signedIn, false);
  assert.equal(env.DB.rows('SELECT COUNT(*) AS n FROM users')[0].n, 1);
  // A typed address is checked at the start and used, unverified, with a link to confirm it.
  const bad = await b.post('/api/auth/discord/start', { mode: 'signup', acceptPrivacy: true, email: 'nope' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.field, 'email');
  const notSignup = await b.post('/api/auth/discord/start', { mode: 'login', email: 'nelly2@example.com' });
  assert.equal(notSignup.status, 400);
  assert.equal(notSignup.body.error.field, 'email');
  assert.equal((await flow(b, mock, { mode: 'signup', acceptPrivacy: true, email: 'Nelly2@Example.com' })).fragment, 'discord=ok');
  const me = (await b.get('/api/auth/me')).body.user;
  assert.match(me.username, /^nelly\d+$/);
  assert.equal(me.email, 'Nelly2@example.com', 'the typed address, not the unverified Discord one');
  assert.equal(me.emailVerified, false);
  assert.equal(me.status, 'pending_email', 'verification is in effect and no verified email exists yet');
  const v = await b.post('/api/auth/email/verify', { token: env.EMAIL.token('Nelly2@example.com', 'verify') });
  assert.equal(v.status, 200);
  assert.equal(v.body.user.status, 'pending_approval');
  const other = mockDiscord({ id: '42', username: 'otto', email: 'someone@example.com', verified: true });
  const c = new Browser(env, { ip: '203.0.113.81' });
  assert.equal((await flow(c, other, { mode: 'signup', acceptPrivacy: true })).fragment, 'discord=error&code=email_taken');
});

test('state and PKCE: tampered state, missing binding cookie, replayed state, expiry, denial, Discord errors', async () => {
  const env = makeEnv({ email: false, discord: true });
  const mock = mockDiscord(PROFILE);
  const b = new Browser(env);
  assert.equal((await flow(b, mock, { mode: 'signup', acceptPrivacy: true }, { tamperState: true })).fragment, 'discord=error&code=invalid_state');
  assert.equal((await flow(b, mock, { mode: 'signup', acceptPrivacy: true }, { dropCookie: true })).fragment, 'discord=error&code=invalid_state');
  assert.equal((await flow(b, mock, { mode: 'signup', acceptPrivacy: true }, { error: 'access_denied' })).fragment, 'discord=error&code=denied');
  // Another browser cannot finish this browser's flow (the state is bound to its cookie).
  const s = await b.post('/api/auth/discord/start', { mode: 'signup', acceptPrivacy: true });
  const state = new URL(s.body.url).searchParams.get('state');
  const attacker = new Browser(env, { ip: '203.0.113.90' });
  const stolen = await attacker.get(`/api/auth/discord/callback?state=${state}&code=good-code`, { csrf: false, json: false, headers: { Origin: null } });
  assert.match(stolen.res.headers.get('location'), /code=invalid_state/);
  assert.equal(attacker.signedIn, false);
  // Expired state.
  const e = await b.post('/api/auth/discord/start', { mode: 'signup', acceptPrivacy: true });
  mock.state.challenge = new URL(e.body.url).searchParams.get('code_challenge');
  clock.advance(10 * 60 * 1000 + 1);
  const late = await b.get(`/api/auth/discord/callback?state=${new URL(e.body.url).searchParams.get('state')}&code=good-code`, { csrf: false, json: false, headers: { Origin: null } });
  assert.match(late.res.headers.get('location'), /code=invalid_state/);
  // Discord failing.
  const failing = mockDiscord(PROFILE, { tokenStatus: 400 });
  assert.equal((await flow(b, failing, { mode: 'signup', acceptPrivacy: true })).fragment, 'discord=error&code=unavailable');
  const failingMe = mockDiscord(PROFILE, { meStatus: 500 });
  assert.equal((await flow(b, failingMe, { mode: 'signup', acceptPrivacy: true })).fragment, 'discord=error&code=unavailable');
  // Bad returnTo values are refused at start.
  for (const returnTo of ['//evil.example/', 'https://evil.example/', 'javascript:alert(1)', '/\\evil']) {
    assert.equal((await b.post('/api/auth/discord/start', { mode: 'login', returnTo })).status, 400, returnTo);
  }
  assert.equal(env.DB.rows('SELECT COUNT(*) AS n FROM users')[0].n, 0, 'no account was created by any of these');
});

test('link, reauth and unlink; already linked; bans; Discord as the last method', async () => {
  const env = makeEnv({ email: false, discord: true });
  const mock = mockDiscord(PROFILE);
  const b = await signup(env, 'Linker');
  promote(env, b.user.id);
  await b.post('/api/auth/login', { login: 'linker', password: PASSWORD });
  assert.equal((await b.post('/api/auth/discord/start', { mode: 'link' })).body.error.code, 'reauth_required', 'linking needs a fresh proof');
  await b.post('/api/auth/reauth', { password: PASSWORD });
  const linked = await flow(b, mock, { mode: 'link' });
  assert.equal(linked.fragment, 'discord=ok');
  const me = (await b.get('/api/account')).body.user;
  assert.equal(me.methods.discord.username, 'nelly');
  assert.equal((await b.post('/api/auth/discord/start', { mode: 'link' })).status, 409, 'already linked');
  // Another account cannot take the same Discord account.
  const other = await signup(env, 'Second');
  await other.post('/api/auth/reauth', { password: PASSWORD });
  assert.equal((await flow(other, mock, { mode: 'link' })).fragment, 'discord=error&code=already_linked');
  // Re-authenticate through Discord.
  clock.advance(11 * 60 * 1000);
  assert.equal((await b.get('/api/auth/me')).body.session.reauthUntil < clock.now, true);
  assert.equal((await flow(b, mock, { mode: 'reauth' })).fragment, 'discord=ok');
  assert.ok((await b.get('/api/auth/me')).body.session.reauthUntil > clock.now);
  // Drop the password; Discord is now the only method and cannot be unlinked.
  assert.equal((await b.del('/api/account/password')).status, 200);
  assert.equal((await b.del('/api/account/discord')).status, 409);
  // Linking needs a recent re-authentication.
  clock.advance(11 * 60 * 1000);
  assert.equal((await other.post('/api/auth/discord/start', { mode: 'link' })).body.error.code, 'reauth_required');
  // A banned account cannot sign in through Discord.
  env.DB.sqlite.prepare("INSERT INTO account_bans (user_id, reason, created_at) VALUES (?, 'x', 0)").run(b.user.id);
  const c = new Browser(env, { ip: '203.0.113.99' });
  assert.equal((await flow(c, mock, { mode: 'login' })).fragment, 'discord=error&code=banned');
  assert.equal(c.signedIn, false);
});

// ---- Email review (2026-10-11): deleted accounts give up their Discord account; signup limits per network ----

/** A signed-in admin. */
async function adminIn(env) {
  const a = await signup(env, 'Root Admin', { ip: '198.51.100.1' });
  promote(env, a.user.id, 'admin');
  assert.equal((await a.post('/api/auth/login', { login: 'root admin', password: PASSWORD })).status, 200);
  return a;
}

test('review 2: an expired, self-deleted, rejected or deleted Discord signup does not lock its Discord account out', async () => {
  const env = makeEnv({ email: true, discord: true });
  const unverified = { id: '9001', username: 'expiry', email: 'expiry@example.com', verified: false };
  // Expired: a Discord signup with a typed address that never confirmed it.
  const a = new Browser(env, { ip: '203.0.113.110' });
  assert.equal((await flow(a, mockDiscord(unverified), { mode: 'signup', acceptPrivacy: true, email: 'expiry@example.com' })).fragment, 'discord=ok');
  clock.advance(8 * 24 * 60 * 60 * 1000);
  await scheduled(env, clock.now);
  assert.equal(env.DB.rows("SELECT status, discord_id, deleted_discord_id FROM users WHERE username = 'expiry'")[0].status, 'deleted');
  assert.deepEqual(env.DB.rows("SELECT discord_id, deleted_discord_id FROM users WHERE username = 'expiry'")[0], { discord_id: null, deleted_discord_id: '9001' });
  const again = new Browser(env, { ip: '203.0.113.111' });
  assert.equal((await flow(again, mockDiscord(unverified), { mode: 'signup', acceptPrivacy: true, email: 'expiry@example.com' })).fragment, 'discord=ok', 'not account_inactive');
  assert.equal(env.DB.rows("SELECT COUNT(*) AS n FROM users WHERE discord_id = '9001' AND status != 'deleted'")[0].n, 1);

  // Self-deleted: the Discord account and the verified address come free at once.
  const verifiedProfile = { id: '9002', username: 'leaver', email: 'leaver@example.com', verified: true };
  const b = new Browser(env, { ip: '203.0.113.112' });
  assert.equal((await flow(b, mockDiscord(verifiedProfile), { mode: 'signup', acceptPrivacy: true })).fragment, 'discord=ok');
  assert.equal((await flow(b, mockDiscord(verifiedProfile), { mode: 'reauth', returnTo: '/account/' })).fragment, 'discord=ok');
  const me = (await b.get('/api/account')).body.user;
  assert.equal((await b.del('/api/account', { confirm: me.username })).status, 204);
  const c = new Browser(env, { ip: '203.0.113.113' });
  assert.equal((await flow(c, mockDiscord(verifiedProfile), { mode: 'signup', acceptPrivacy: true })).fragment, 'discord=ok', 'neither email_taken nor account_inactive');
  assert.equal((await c.get('/api/auth/me')).body.user.emailVerified, true);

  // Rejected and admin-deleted.
  const admin = await adminIn(env);
  for (const [i, how] of [['9003', 'reject'], ['9004', 'delete']]) {
    const p = { id: i, username: `gone${i}`, email: `gone${i}@example.com`, verified: true };
    const d = new Browser(env, { ip: `203.0.113.${120 + Number(i) - 9000}` });
    assert.equal((await flow(d, mockDiscord(p), { mode: 'signup', acceptPrivacy: true })).fragment, 'discord=ok');
    const id = (await d.get('/api/auth/me')).body.user.id;
    const r = how === 'reject' ? await admin.post(`/api/admin/users/${id}/reject`, {}) : await admin.del(`/api/admin/users/${id}`);
    assert.equal(r.status, 200, how);
    const e = new Browser(env, { ip: `203.0.113.${130 + Number(i) - 9000}` });
    assert.equal((await flow(e, mockDiscord(p), { mode: 'signup', acceptPrivacy: true })).fragment, 'discord=ok', how);
    // Restoring the old account now: its Discord account is linked elsewhere and it has no other way to sign in.
    const restore = await admin.post(`/api/admin/users/${id}/restore`, {});
    assert.equal(restore.status, 409, how);
    assert.equal(restore.body.error.field, 'discord');
  }
});

test('review 2: restore gives back the Discord account and the verified address when still free, drops them when taken', async () => {
  const env = makeEnv({ email: true, discord: true });
  const admin = await adminIn(env);
  const profile = { id: '9100', username: 'twice', email: 'twice@example.com', verified: true };
  const a = new Browser(env, { ip: '203.0.113.140' });
  assert.equal((await flow(a, mockDiscord(profile), { mode: 'signup', acceptPrivacy: true })).fragment, 'discord=ok');
  const id = (await a.get('/api/auth/me')).body.user.id;
  // A password too, so the account can come back without Discord.
  env.DB.sqlite.prepare("UPDATE users SET password_hash = 'aa', password_salt = 'bb', password_iterations = 10000 WHERE id = ?").run(id);
  assert.equal((await admin.del(`/api/admin/users/${id}`)).status, 200);
  // Free again: everything comes back.
  const back = await admin.post(`/api/admin/users/${id}/restore`, {});
  assert.equal(back.status, 200);
  assert.deepEqual(back.body.dropped, []);
  assert.equal(back.body.user.emailVerified, true);
  assert.equal(back.body.user.methods.discord.id, '9100');
  assert.equal(env.DB.rows('SELECT email_key FROM users WHERE id = ?', id)[0].email_key, 'twice@example.com');
  // Deleted again, and meanwhile a new account takes both.
  assert.equal((await admin.del(`/api/admin/users/${id}`)).status, 200);
  const b = new Browser(env, { ip: '203.0.113.141' });
  assert.equal((await flow(b, mockDiscord(profile), { mode: 'signup', acceptPrivacy: true })).fragment, 'discord=ok');
  const restored = await admin.post(`/api/admin/users/${id}/restore`, {});
  assert.equal(restored.status, 200);
  assert.deepEqual(restored.body.dropped.sort(), ['discord', 'emailVerified']);
  assert.equal(restored.body.user.emailVerified, false, 'the address stays, unverified: it claims nothing');
  assert.equal(restored.body.user.methods.discord, null);
  const audit = env.DB.rows("SELECT after_json FROM audit_log WHERE action = 'user.restore' AND target_id = ? ORDER BY id DESC LIMIT 1", id)[0];
  assert.deepEqual(JSON.parse(audit.after_json).dropped.sort(), ['discord', 'emailVerified']);
});

test('review 1: the Discord signup limit counts per network (an IPv6 /64), not per address', async () => {
  const env = makeEnv({ email: false, discord: true });
  for (let i = 0; i < 10; i++) await signup(env, `Net Signup ${i}`, { ip: `2001:db8:7:8::${i + 1}` });
  const b = new Browser(env, { ip: '2001:db8:7:8::ffff' });
  const p = { id: '9200', username: 'rotator', email: 'rotator@example.com', verified: true };
  assert.equal((await flow(b, mockDiscord(p), { mode: 'signup', acceptPrivacy: true })).fragment, 'discord=error&code=rate_limited');
  const other = new Browser(env, { ip: '2001:db8:7:9::1' });
  assert.equal((await flow(other, mockDiscord(p), { mode: 'signup', acceptPrivacy: true })).fragment, 'discord=ok', 'another /64');
});

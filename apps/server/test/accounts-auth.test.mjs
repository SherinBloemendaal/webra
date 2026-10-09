// Sign-up, sign-in, sessions, CSRF, lockouts, email links and
// re-authentication through the real Worker (docs/accounts-api.md 1 to 4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Browser, call, Clock, makeEnv, ORIGIN, PASSWORD, promote, setSite, signup } from './accounts-harness.mjs';

const clock = new Clock();
test.after(() => clock.restore());

test('GET /api/site reports effective switches and services', async () => {
  const env = makeEnv({ email: false });
  const b = new Browser(env);
  const r = await b.get('/api/site', { csrf: false });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.services, { email: false, discord: false });
  assert.equal(r.body.login.email, false, 'no binding: email links unavailable');
  assert.equal(r.body.login.discord, false);
  assert.equal(r.body.login.password, true);
  assert.equal(r.body.registration.emailVerificationRequired, false, 'verification needs email');
  assert.equal(r.body.registration.approvalRequired, true);
  assert.equal(r.body.onlineRequiresAccount, true);
  assert.equal(r.body.passkey.rpId, 'webra.sherin.dev');
  assert.equal(r.body.privacyUrl, '/privacy.html');
  const withAll = makeEnv({ email: true, discord: true });
  const r2 = await new Browser(withAll).get('/api/site');
  assert.equal(r2.body.login.email, true);
  assert.equal(r2.body.login.discord, true);
  assert.equal(r2.body.registration.emailVerificationRequired, true);
  await setSite(withAll, { login: { discord: false }, registration: { emailVerification: false } });
  const r3 = await new Browser(withAll).get('/api/site');
  assert.equal(r3.body.login.discord, false, 'switched off');
  assert.equal(r3.body.services.discord, true, 'but configured');
  assert.equal(r3.body.registration.emailVerificationRequired, false);
});

test('signup with email verification: pending_email, then approval, then active', async () => {
  const env = makeEnv();
  const b = new Browser(env);
  const r = await b.post('/api/auth/signup', { username: 'Tanya', email: 'Tanya@Example.COM', password: PASSWORD, acceptPrivacy: true });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.user.username, 'Tanya');
  assert.equal(r.body.user.email, 'Tanya@example.com');
  assert.equal(r.body.user.status, 'pending_email');
  assert.equal(r.body.user.canPlayOnline, false);
  assert.match(r.body.user.avatarColor, /^#[0-9a-f]{6}$/);
  const cookie = r.res.headers.getSetCookie().find((c) => c.startsWith('__Host-webra_session='));
  assert.ok(cookie, 'a __Host- session cookie on HTTPS');
  for (const attr of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) assert.ok(cookie.includes(attr), attr);
  assert.ok(!/Domain=/i.test(cookie));
  // The session id is stored hashed only.
  const value = cookie.split(';')[0].split('=')[1];
  assert.equal(JSON.stringify(env.DB.rows('SELECT * FROM auth_sessions')).includes(value), false);
  // The verification email.
  assert.equal(env.EMAIL.sent.length, 1);
  const mail = env.EMAIL.sent[0];
  assert.equal(mail.from, 'noreply@webra.sherin.dev');
  assert.equal(mail.to, 'Tanya@example.com');
  assert.match(mail.text, /https:\/\/webra\.sherin\.dev\/account\/#verify=/);
  const token = env.EMAIL.token('Tanya@example.com', 'verify');
  assert.equal(JSON.stringify(env.DB.rows('SELECT * FROM email_tokens')).includes(token), false, 'tokens are stored hashed');
  // Wrong token, then the right one, then the same one again (single use).
  assert.equal((await b.post('/api/auth/email/verify', { token: 'x'.repeat(43) })).status, 401);
  const v = await b.post('/api/auth/email/verify', { token });
  assert.equal(v.status, 200);
  assert.equal(v.body.user.status, 'pending_approval');
  assert.equal(v.body.user.emailVerified, true);
  assert.equal((await b.post('/api/auth/email/verify', { token })).status, 401, 'single use');
  const me = await b.get('/api/auth/me');
  assert.equal(me.body.user.status, 'pending_approval');
  assert.ok(me.body.session.reauthUntil > clock.now);
});

test('signup validation, uniqueness and closed registration', async () => {
  const env = makeEnv();
  const b = new Browser(env);
  const bad = async (body, field, status = 400) => {
    const r = await b.post('/api/auth/signup', { acceptPrivacy: true, password: PASSWORD, email: 'a@example.com', ...body });
    assert.equal(r.status, status, `${JSON.stringify(body)}: ${JSON.stringify(r.body)}`);
    if (field) assert.equal(r.body.error.field, field);
    return r;
  };
  await bad({ username: 'ab' }, 'username');
  await bad({ username: 'evil‮gnp' }, 'username');
  await bad({ username: 'Аdmin x' }, 'username'); // Cyrillic A mixed with Latin
  await bad({ username: 'Admin' }, 'username'); // reserved
  await bad({ username: 'a@b.c' }, 'username');
  await bad({ username: 'Good', password: 'short' }, 'password');
  await bad({ username: 'Good', password: '1234567890' }, 'password');
  await bad({ username: 'Good', password: 'goodgoodgood', email: 'goodgoodgood' }, 'email');
  await bad({ username: 'Good', email: null }, 'email', 400); // verification in effect: email required
  await bad({ username: 'Good', acceptPrivacy: false }, 'acceptPrivacy');
  await bad({ username: 'Good', password: undefined }, 'password');
  await bad({ username: 'Good', admin: true }, 'admin');
  assert.equal((await b.post('/api/auth/signup', { username: 'Good', email: 'g@example.com', password: PASSWORD, acceptPrivacy: true })).status, 201);
  const c = new Browser(env, { ip: '203.0.113.9' });
  const dupName = await c.post('/api/auth/signup', { username: 'ＧＯＯＤ', email: 'h@example.com', password: PASSWORD, acceptPrivacy: true });
  assert.equal(dupName.status, 409, 'usernames are unique after folding');
  assert.equal(dupName.body.error.field, 'username');
  const dupMail = await c.post('/api/auth/signup', { username: 'Other', email: 'G@EXAMPLE.com', password: PASSWORD, acceptPrivacy: true });
  assert.equal(dupMail.status, 409);
  assert.equal(dupMail.body.error.field, 'email');
  await setSite(env, { registration: { open: false } });
  const closed = await c.post('/api/auth/signup', { username: 'Late', email: 'l@example.com', password: PASSWORD, acceptPrivacy: true });
  assert.equal(closed.status, 403);
  assert.equal(closed.body.error.code, 'registration_closed');
  await setSite(env, { registration: { open: true }, login: { password: false } });
  const off = await c.post('/api/auth/signup', { username: 'Late', email: 'l@example.com', password: PASSWORD, acceptPrivacy: true });
  assert.equal(off.body.error.code, 'method_disabled');
});

test('without email: no verification, email optional, open beta makes accounts active', async () => {
  const env = makeEnv({ email: false });
  await setSite(env, { registration: { approvalRequired: false } });
  const b = new Browser(env);
  const r = await b.post('/api/auth/signup', { username: 'Volkov', password: PASSWORD, acceptPrivacy: true });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.user.status, 'active');
  assert.equal(r.body.user.email, null);
  assert.equal(r.body.user.canPlayOnline, true);
  assert.equal(r.body.user.canUseContentRelay, false, 'the relay needs the flag');
  const f = await b.post('/api/auth/password/forgot', { email: 'x@example.com' });
  assert.equal(f.status, 503);
  assert.equal(f.body.error.code, 'unavailable');
});

test('CSRF: Origin, Sec-Fetch-Site and the custom header on every state change', async () => {
  const env = makeEnv();
  const b = new Browser(env);
  const body = { login: 'x', password: 'y' };
  const tries = [
    { headers: { Origin: 'https://evil.example' } },
    { headers: { Origin: null } },
    { headers: { 'Sec-Fetch-Site': 'cross-site' } },
    { headers: { 'Sec-Fetch-Site': 'same-site' } },
    { csrf: false },
  ];
  for (const opts of tries) {
    const r = await b.post('/api/auth/login', body, opts);
    assert.equal(r.status, 403, JSON.stringify(opts));
    assert.equal(r.body.error.code, 'csrf');
  }
  // Older routes too.
  assert.equal((await b.post('/api/sessions', {}, { csrf: false })).body.error.code, 'csrf');
  assert.equal((await b.post('/api/maps', {}, { csrf: false })).body.error.code, 'csrf');
  // Account and admin reads need the header as well; public reads do not.
  assert.equal((await b.get('/api/account', { csrf: false })).body.error.code, 'csrf');
  assert.equal((await b.get('/api/admin/stats', { csrf: false })).body.error.code, 'csrf');
  assert.equal((await b.get('/api/site', { csrf: false })).status, 200);
  // JSON only.
  const plain = await b.post('/api/auth/login', 'login=x', { headers: { 'Content-Type': 'text/plain' } });
  assert.equal(plain.status, 415);
});

test('password sign-in: generic errors, lockout per login name, rehash, rotation', async () => {
  const env = makeEnv({ email: false, vars: { PASSWORD_ITERATIONS: '20000' } });
  const t = await signup(env, 'Boris');
  promote(env, t.user.id);
  const stored = env.DB.rows('SELECT password_iterations FROM users')[0];
  assert.equal(stored.password_iterations, 20000);
  const b = new Browser(env, { ip: '192.0.2.1' });
  const wrong = await b.post('/api/auth/login', { login: 'boris', password: 'nope nope nope' });
  const unknown = await b.post('/api/auth/login', { login: 'nobody', password: 'nope nope nope' });
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.deepEqual(wrong.body, unknown.body, 'same answer for a wrong password and an unknown name');
  // Case-insensitive username, then by email; raising the iterations upgrades the hash.
  env.PASSWORD_ITERATIONS = '30000';
  const ok = await b.post('/api/auth/login', { login: 'BORIS', password: PASSWORD });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(env.DB.rows('SELECT password_iterations FROM users')[0].password_iterations, 30000, 'rehashed');
  const first = b.jar.get('__Host-webra_session');
  const again = await b.post('/api/auth/login', { login: 'boris@example.com', password: PASSWORD });
  assert.equal(again.status, 200);
  assert.notEqual(b.jar.get('__Host-webra_session'), first, 'a new session id on every sign-in');
  assert.equal(env.DB.rows('SELECT COUNT(*) AS n FROM auth_sessions WHERE user_id = ?', t.user.id)[0].n, 2, 'the old cookie session was replaced');
  // 10 failures lock the name for the window, whatever the IP; existing and unknown names alike.
  for (const name of ['boris', 'ghost']) {
    for (let i = 0; i < 10; i++) {
      const ip = `192.0.2.${100 + i}`;
      const r = await new Browser(env, { ip }).post('/api/auth/login', { login: name, password: 'wrong password!' });
      assert.equal(r.status, 401);
    }
    const locked = await new Browser(env, { ip: '192.0.2.250' }).post('/api/auth/login', { login: name, password: PASSWORD });
    assert.equal(locked.status, 429, name);
    assert.equal(locked.body.error.code, 'locked');
    assert.ok(locked.body.error.retryAfter > 0);
    assert.equal(locked.res.headers.get('retry-after'), String(locked.body.error.retryAfter));
  }
  clock.advance(16 * 60 * 1000);
  assert.equal((await new Browser(env, { ip: '192.0.2.251' }).post('/api/auth/login', { login: 'boris', password: PASSWORD })).status, 200, 'unlocked after the window');
});

test('per-IP sign-in limit', async () => {
  const env = makeEnv({ email: false });
  const b = new Browser(env, { ip: '192.0.2.77' });
  let last;
  for (let i = 0; i < 31; i++) last = await b.post('/api/auth/login', { login: `user${i}`, password: 'whatever password' });
  assert.equal(last.status, 429);
  assert.equal(last.body.error.code, 'rate_limited');
});

test('signup limit per IP', async () => {
  const env = makeEnv({ email: false });
  let last;
  for (let i = 0; i < 11; i++) {
    last = await new Browser(env, { ip: '192.0.2.5' }).post('/api/auth/signup', { username: `Player${i}`, password: PASSWORD, acceptPrivacy: true });
  }
  assert.equal(last.status, 429);
});

test('sessions: idle and absolute expiry, logout, unknown cookies are cleared', async () => {
  const env = makeEnv({ email: false });
  const b = await signup(env, 'Stavros');
  assert.ok((await b.get('/api/auth/me')).body.user);
  clock.advance(13 * 24 * 60 * 60 * 1000);
  assert.ok((await b.get('/api/auth/me')).body.user, 'used within 14 days');
  clock.advance(13 * 24 * 60 * 60 * 1000);
  assert.ok((await b.get('/api/auth/me')).body.user);
  clock.advance(5 * 24 * 60 * 60 * 1000);
  const expired = await b.get('/api/auth/me');
  assert.equal(expired.body.user, null, 'absolute limit of 30 days');
  assert.equal(b.signedIn, false, 'the cookie was cleared');
  const c = await signup(env, 'Nadia');
  clock.advance(15 * 24 * 60 * 60 * 1000);
  assert.equal((await c.get('/api/auth/me')).body.user, null, 'idle limit of 14 days');
  const d = await signup(env, 'Kosygin');
  assert.equal((await d.post('/api/auth/logout')).status, 204);
  assert.equal(d.signedIn, false);
  assert.equal(env.DB.rows('SELECT COUNT(*) AS n FROM auth_sessions WHERE user_id = ?', d.user.id)[0].n, 0);
  // A cookie in the wrong (non __Host-) name is ignored on HTTPS.
  const e = new Browser(env);
  e.jar.set('webra_session', 'A'.repeat(43));
  assert.equal((await e.get('/api/auth/me')).body.user, null);
});

test('plain HTTP (local development) uses a cookie without __Host- and Secure', async () => {
  const env = makeEnv({ email: false });
  const b = new Browser(env, { origin: 'http://localhost:8787' });
  const r = await b.post('/api/auth/signup', { username: 'Local', password: PASSWORD, acceptPrivacy: true });
  assert.equal(r.status, 201);
  const cookie = r.res.headers.getSetCookie()[0];
  assert.match(cookie, /^webra_session=/);
  assert.ok(!cookie.includes('Secure'));
  assert.equal((await b.get('/api/auth/me')).body.user.username, 'Local');
});

test('password reset by email: generic answer, single use, sessions revoked, verifies the email', async () => {
  const env = makeEnv();
  const owner = await signup(env, 'Yuri');
  const other = new Browser(env, { ip: '203.0.113.50' });
  const f = await other.post('/api/auth/password/forgot', { email: 'yuri@example.com' });
  assert.equal(f.status, 202);
  const none = await other.post('/api/auth/password/forgot', { email: 'nobody@example.com' });
  assert.equal(none.status, 202);
  assert.deepEqual(none.body, f.body, 'the same answer whether or not the address exists');
  const token = env.EMAIL.token('yuri@example.com', 'reset');
  assert.ok(token);
  assert.equal(env.EMAIL.sent.filter((m) => m.to === 'nobody@example.com').length, 0);
  const weak = await other.post('/api/auth/password/reset', { token, password: 'short' });
  assert.equal(weak.status, 400);
  // The failed attempt used the token (single use): ask again.
  assert.equal((await other.post('/api/auth/password/reset', { token, password: 'a brand new passphrase' })).status, 401);
  await other.post('/api/auth/password/forgot', { email: 'yuri@example.com' });
  const token2 = env.EMAIL.token('yuri@example.com', 'reset');
  const ok = await other.post('/api/auth/password/reset', { token: token2, password: 'a brand new passphrase' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.user.emailVerified, true, 'the link proved the address');
  assert.equal((await owner.get('/api/auth/me')).body.user, null, 'every other session was revoked');
  assert.equal((await new Browser(env).post('/api/auth/login', { login: 'yuri', password: 'a brand new passphrase' })).status, 200);
  // Expiry: one hour.
  await other.post('/api/auth/password/forgot', { email: 'yuri@example.com' });
  const late = env.EMAIL.token('yuri@example.com', 'reset');
  clock.advance(61 * 60 * 1000);
  assert.equal((await other.post('/api/auth/password/reset', { token: late, password: 'another new passphrase' })).status, 401);
  // Per-address limit: 3 per hour.
  const statuses = [];
  for (let i = 0; i < 4; i++) statuses.push((await new Browser(env, { ip: `203.0.113.${60 + i}` }).post('/api/auth/password/forgot', { email: 'yuri@example.com' })).status);
  assert.deepEqual(statuses, [202, 202, 202, 429]);
});

test('re-authentication: needed for sensitive actions, rotates the session, locks after failures', async () => {
  const env = makeEnv({ email: false });
  const b = await signup(env, 'Gradenko');
  clock.advance(11 * 60 * 1000);
  const r = await b.post('/api/account/email', { email: 'new@example.com' });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'reauth_required');
  const before = b.jar.get('__Host-webra_session');
  const ok = await b.post('/api/auth/reauth', { password: PASSWORD });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.reauthUntil > clock.now);
  assert.notEqual(b.jar.get('__Host-webra_session'), before, 'rotated');
  assert.equal((await b.post('/api/account/email', { email: 'new@example.com' })).status, 202);
  for (let i = 0; i < 10; i++) assert.equal((await b.post('/api/auth/reauth', { password: 'wrong wrong wrong' })).status, 401);
  const locked = await b.post('/api/auth/reauth', { password: PASSWORD });
  assert.equal(locked.status, 429);
  assert.equal(locked.body.error.code, 'locked');
});

test('IP bans block sign-in, signup and every authenticated request', async () => {
  const env = makeEnv({ email: false });
  const b = await signup(env, 'Kane', { ip: '203.0.113.200' });
  env.DB.sqlite
    .prepare("INSERT INTO ip_bans (cidr, ip_v, start_hex, end_hex, reason, created_at) VALUES ('203.0.113.0/24', 4, 'cb007100', 'cb0071ff', 'test', 0)")
    .run();
  assert.equal((await b.get('/api/auth/me')).body.error.code, 'ip_banned');
  assert.equal((await b.get('/api/account')).body.error.code, 'ip_banned');
  const c = new Browser(env, { ip: '203.0.113.201' });
  assert.equal((await c.post('/api/auth/login', { login: 'kane', password: PASSWORD })).body.error.code, 'ip_banned');
  assert.equal((await c.post('/api/auth/signup', { username: 'Seth', password: PASSWORD, acceptPrivacy: true })).body.error.code, 'ip_banned');
  // Outside the range all is well.
  assert.equal((await new Browser(env, { ip: '203.0.114.1' }).post('/api/auth/login', { login: 'kane', password: PASSWORD })).status, 200);
});

test('unknown API paths and methods', async () => {
  const env = makeEnv();
  const b = new Browser(env);
  assert.equal((await b.get('/api/auth/nope')).status, 404);
  const wrong = await b.get('/api/auth/login');
  assert.equal(wrong.status, 405);
  assert.equal(wrong.res.headers.get('allow'), 'POST');
  const r = await call(env, 'GET', `${ORIGIN}/`, {});
  assert.equal(await r.text(), 'asset');
});

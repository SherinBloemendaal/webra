// Required email addresses and their verification (docs/accounts-api.md 2.1,
// 2.2, 4.2, 4.3, 5.4, 8.6 and 9): the token lifecycle, limits, answers that never
// tell whether an address has an account, the daily expiry of unconfirmed
// signups, accounts from before addresses were required, the server without
// email sending, the sender configuration, the admin actions and the
// development outbox.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Browser, Clock, makeEnv, ORIGIN, PASSWORD, promote, scheduled, setSite, signup } from './accounts-harness.mjs';
import { addressInUseMessage, verifyMessage } from '../src/accounts/email.js';
import { emailSender, services } from '../src/accounts/site.js';
import { withDevMail } from '../src/accounts/dev.js';

const clock = new Clock();
test.after(() => clock.restore());
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const linkOf = (mail) => /#verify=([A-Za-z0-9_-]{43})/.exec(mail?.text ?? '')?.[1] ?? null;
const count = (env, sql, ...args) => env.DB.rows(sql, ...args)[0].n;

/** A signed-in admin browser. */
async function adminOf(env) {
  const a = await signup(env, 'Root Admin', { ip: '198.51.100.1' });
  promote(env, a.user.id, 'admin');
  assert.equal((await a.post('/api/auth/login', { login: 'root admin', password: PASSWORD })).status, 200);
  return a;
}

test('verification tokens: valid, single use, expired, superseded, tampered, bound to the account and the exact address', async () => {
  const env = makeEnv();
  const a = await signup(env, 'Alpha', { ip: '198.51.100.10' });
  const b = await signup(env, 'Bravo', { ip: '198.51.100.11' });
  assert.equal(a.user.status, 'pending_email');
  const first = env.EMAIL.token('alpha@example.com', 'verify');
  assert.ok(first);
  // Stored as a hash only, with the account and the address it proves.
  const stored = env.DB.rows('SELECT token_hash, user_id, purpose, email, expires_at - created_at AS ttl FROM email_tokens WHERE user_id = ?', a.user.id);
  assert.equal(stored.length, 1);
  assert.deepEqual({ ...stored[0], token_hash: undefined }, { token_hash: undefined, user_id: a.user.id, purpose: 'verify', email: 'alpha@example.com', ttl: DAY });
  assert.notEqual(stored[0].token_hash, first);

  // Superseded: a new link replaces the old one.
  assert.equal((await a.post('/api/account/email/resend', {})).status, 202);
  const second = env.EMAIL.token('alpha@example.com', 'verify');
  assert.notEqual(second, first);
  assert.equal((await a.post('/api/auth/email/verify', { token: first })).status, 401, 'superseded');
  assert.equal(count(env, 'SELECT COUNT(*) AS n FROM email_tokens WHERE user_id = ?', a.user.id), 1);

  // Tampered and malformed tokens.
  const flip = second.slice(0, -1) + (second.at(-1) === 'A' ? 'B' : 'A');
  for (const token of [flip, second.slice(1), `${second}x`, second.replace(/^./, '!'), '', null, 42]) {
    const r = await a.post('/api/auth/email/verify', { token });
    assert.equal(r.status, 401, String(token));
    assert.equal(r.body.error.code, 'bad_credentials');
  }

  // Expired: 24 hours.
  clock.advance(DAY + 1);
  assert.equal((await a.post('/api/auth/email/verify', { token: second })).status, 401, 'expired');
  assert.equal(count(env, 'SELECT COUNT(*) AS n FROM email_tokens WHERE user_id = ?', a.user.id), 0, 'consumed even when expired');

  // Wrong user: Bravo's session using Alpha's link verifies Alpha (the link proves Alpha's inbox), never Bravo.
  clock.advance(HOUR);
  await a.post('/api/account/email/resend', {});
  const third = env.EMAIL.token('alpha@example.com', 'verify');
  const asBravo = await b.post('/api/auth/email/verify', { token: third });
  assert.equal(asBravo.status, 200);
  assert.equal(asBravo.body.user, null, 'the answer carries no other account');
  assert.equal((await b.get('/api/account')).body.user.emailVerified, false);
  const alpha = (await a.get('/api/account')).body.user;
  assert.equal(alpha.emailVerified, true);
  assert.equal(alpha.status, 'pending_approval');
  // Single use.
  assert.equal((await a.post('/api/auth/email/verify', { token: third })).status, 401, 'reused');

  // Bound to the exact address: a link for an address the account no longer has does nothing.
  const bravoLink = env.EMAIL.token('bravo@example.com', 'verify');
  env.DB.sqlite.prepare("UPDATE users SET email = 'bravo.other@example.com' WHERE id = ?").run(b.user.id);
  assert.equal((await b.post('/api/auth/email/verify', { token: bravoLink })).status, 401);
  assert.equal(count(env, 'SELECT COUNT(*) AS n FROM users WHERE email_verified = 1 AND id = ?', b.user.id), 0);
});

test('mail content: plain text and simple HTML, the site name, the link to this origin, the expiry, the configured sender, no tracking', async () => {
  const env = makeEnv({ vars: { EMAIL_FROM: 'accounts@mail.example.org' } });
  await signup(env, 'Kane', { ip: '198.51.100.12' });
  const mail = env.EMAIL.sent.at(-1);
  assert.equal(mail.from, 'accounts@mail.example.org');
  assert.equal(mail.to, 'kane@example.com');
  assert.match(mail.subject, /^WebRA: /);
  for (const body of [mail.text, mail.html]) {
    assert.match(body, /WebRA/);
    assert.match(body, /24 hours/);
    assert.ok(body.includes(`${ORIGIN}/account/#verify=`));
  }
  assert.doesNotMatch(mail.html, /<img|<script|https?:\/\/(?!webra\.sherin\.dev)/i, 'no images, scripts or other hosts');
  assert.equal(new Set(mail.html.match(/https?:\/\/[^\s"<]+/g).map((u) => new URL(u).origin)).size, 1);
  // Text the player chose is escaped in HTML.
  const m = verifyMessage('<b>x</b>', 'https://webra.sherin.dev/account/#verify=t', { origin: ORIGIN });
  assert.ok(m.html.includes('&lt;b&gt;x&lt;/b&gt;'));
  assert.equal(m.html.includes('<b>x</b>'), false);
  const n = addressInUseMessage(ORIGIN);
  assert.doesNotMatch(n.text, /#verify=|#reset=/);
});

test('answers never tell whether an address has an account; the mail goes out after the answer', async () => {
  const env = makeEnv();
  const owner = await signup(env, 'Owner', { email: 'owner@example.com', ip: '198.51.100.13' });
  await owner.post('/api/auth/email/verify', { token: env.EMAIL.token('owner@example.com', 'verify') });
  const shape = (r) => ({ status: r.status, keys: Object.keys(r.body.user).sort(), emailVerified: r.body.user.emailVerified, status2: r.body.user.status, pending: r.body.user.pendingEmail });
  const one = new Browser(env, { ip: '203.0.113.1' });
  const two = new Browser(env, { ip: '203.0.113.2' });
  const taken = await one.post('/api/auth/signup', { username: 'Probe One', email: 'OWNER@example.com', password: PASSWORD, acceptPrivacy: true });
  const fresh = await two.post('/api/auth/signup', { username: 'Probe Two', email: 'nobody@example.com', password: PASSWORD, acceptPrivacy: true });
  assert.deepEqual(shape(taken), shape(fresh));
  // The same stored state too: one unverified address and one link record each.
  for (const id of [taken.body.user.id, fresh.body.user.id]) {
    assert.equal(count(env, 'SELECT COUNT(*) AS n FROM users WHERE id = ? AND email_key IS NULL AND email_verified = 0', id), 1);
    assert.equal(count(env, "SELECT COUNT(*) AS n FROM email_tokens WHERE user_id = ? AND purpose = 'verify'", id), 1);
  }
  // Resend and the account view: the same answers as well.
  const [ra, rb] = [await one.post('/api/account/email/resend', {}), await two.post('/api/account/email/resend', {})];
  assert.deepEqual([ra.status, ra.body], [rb.status, rb.body]);
  assert.deepEqual(shape(await one.get('/api/account')), shape(await two.get('/api/account')));

  // The answer does not wait for the mail (nor for the check whether the address is taken).
  const { default: worker } = await import('../src/index.js');
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const realSend = env.EMAIL.send.bind(env.EMAIL);
  env.EMAIL.send = async (msg) => {
    await gate;
    return realSend(msg);
  };
  const pending = [];
  const exec = { waitUntil: (p) => pending.push(p), passThroughOnException() {} };
  const headers = { 'CF-Connecting-IP': '203.0.113.3', Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin', 'X-WebRA-CSRF': '1', 'Content-Type': 'application/json' };
  clock.advance(HOUR); // a new hour for the address's mail limit
  const res = await worker.fetch(
    new Request(`${ORIGIN}/api/auth/signup`, { method: 'POST', headers, body: JSON.stringify({ username: 'Probe Three', email: 'owner@example.com', password: PASSWORD, acceptPrivacy: true }) }),
    env,
    exec,
  );
  assert.equal(res.status, 201);
  assert.equal(pending.length, 1, 'the mail is background work');
  const sentBefore = env.EMAIL.sent.length;
  release();
  await Promise.all(pending);
  assert.equal(env.EMAIL.sent.length, sentBefore + 1);
  assert.match(env.EMAIL.sent.at(-1).subject, /already has an account/);
  env.EMAIL.send = realSend;
  // The owner still signs in by that address; the probes cannot.
  assert.equal((await new Browser(env, { ip: '203.0.113.9' }).post('/api/auth/login', { login: 'owner@example.com', password: PASSWORD })).body.user.username, 'Owner');
});

test('limits: resend per account (hour, day), per network, mail per address (silent), changes per account', async () => {
  const env = makeEnv();
  await setSite(env, { registration: { emailVerification: false } });
  const a = await signup(env, 'Resender', { ip: '198.51.100.20' });
  const statuses = [];
  for (let i = 0; i < 4; i++) statuses.push((await a.post('/api/account/email/resend', {})).status);
  assert.deepEqual(statuses, [202, 202, 202, 429]);
  // Mail per address: the signup and two resends filled the hour (3), the third resend sent nothing.
  assert.equal(env.EMAIL.sent.filter((m) => m.to === 'resender@example.com').length, 3);
  // Per day: 10 resends.
  let day = [];
  for (let h = 1; h <= 4; h++) {
    clock.advance(HOUR);
    for (let i = 0; i < 3; i++) day.push((await a.post('/api/account/email/resend', {})).status);
  }
  assert.equal(day.filter((s) => s === 202).length, 7, 'ten in the day: three before and seven now');
  assert.equal(day.at(-1), 429);
  // Mail per address per day: 6.
  assert.equal(env.EMAIL.sent.filter((m) => m.to === 'resender@example.com').length, 6);
  // Per network: 10 per hour across accounts of one network (an IPv6 /64 counts as one).
  clock.advance(DAY);
  const net = [];
  for (let i = 0; i < 6; i++) {
    const b = await signup(env, `Net User ${i}`, { ip: `2001:db8:1:2::${i + 1}` });
    for (let j = 0; j < 2; j++) net.push((await b.post('/api/account/email/resend', {})).status);
  }
  assert.equal(net.filter((s) => s === 202).length, 10);
  assert.equal(net.at(-1), 429);
  assert.equal(net.slice(10).every((s) => s === 429), true);
  // Address changes: 5 a day per account.
  clock.advance(DAY);
  await a.post('/api/auth/reauth', { password: PASSWORD });
  const changes = [];
  for (let i = 0; i < 6; i++) changes.push((await a.post('/api/account/email', { email: `resender${i}@example.com` })).status);
  assert.deepEqual(changes, [200, 200, 200, 200, 200, 429]);
});

test('daily job: unconfirmed signups expire after 7 days; unverified addresses of other accounts stay; nothing expires without email', async () => {
  const env = makeEnv();
  const late = await signup(env, 'Never Confirms', { ip: '198.51.100.30' });
  const fixer = await signup(env, 'Fixes Typo', { ip: '198.51.100.31' });
  const confirmed = await signup(env, 'Confirms', { ip: '198.51.100.32' });
  await confirmed.post('/api/auth/email/verify', { token: env.EMAIL.token('confirms@example.com', 'verify') });
  // Accounts created while verification was not required keep an unverified address (and are not pending_email).
  await setSite(env, { registration: { emailVerification: false } });
  const relaxed = await signup(env, 'Relaxed', { ip: '198.51.100.33' });
  await setSite(env, { registration: { emailVerification: true } });
  // An approved pending_email account (an admin set the status) never expires.
  const approved = await signup(env, 'Approved Once', { ip: '198.51.100.34' });
  env.DB.sqlite.prepare('UPDATE users SET approved_at = 1 WHERE id = ?').run(approved.user.id);
  // Day 5: the typo is fixed, which restarts its 7 days.
  clock.advance(5 * DAY);
  await fixer.post('/api/auth/reauth', { password: PASSWORD });
  assert.equal((await fixer.post('/api/account/email', { email: 'fixed.typo@example.com' })).status, 200);
  // Day 8.
  clock.advance(3 * DAY);
  await scheduled(env, clock.now);
  const row = (id) => env.DB.rows('SELECT status, email, deleted_at FROM users WHERE id = ?', id)[0];
  assert.equal(row(late.user.id).status, 'deleted');
  assert.equal(row(late.user.id).email, null, 'an address nobody confirmed is not kept');
  assert.equal(count(env, 'SELECT COUNT(*) AS n FROM auth_sessions WHERE user_id = ?', late.user.id), 0);
  assert.equal(count(env, 'SELECT COUNT(*) AS n FROM email_tokens WHERE user_id = ?', late.user.id), 0);
  const entry = env.DB.rows("SELECT actor_id, target_id, reason FROM audit_log WHERE action = 'user.expire'");
  assert.deepEqual(entry, [{ actor_id: null, target_id: late.user.id, reason: 'Email address not confirmed within 7 days' }]);
  assert.equal(row(fixer.user.id).status, 'pending_email', 'its address changed 3 days ago');
  assert.equal(row(confirmed.user.id).status, 'pending_approval');
  assert.deepEqual({ ...row(relaxed.user.id), deleted_at: undefined }, { status: 'pending_approval', email: 'relaxed@example.com', deleted_at: undefined }, 'unverified addresses are not cleared');
  assert.equal(row(approved.user.id).status, 'pending_email');
  assert.equal((await late.get('/api/auth/me')).body.user, null, 'signed out');
  // Day 13: the fixer's 7 days are over too.
  clock.advance(5 * DAY);
  await scheduled(env, clock.now);
  assert.equal(row(fixer.user.id).status, 'deleted');
  // An expired account can be restored by an admin (and is purged with the other deleted accounts after 30 days).
  const admin = await adminOf(env);
  const restored = await admin.post(`/api/admin/users/${late.user.id}/restore`, {});
  assert.equal(restored.status, 200);
  assert.equal(restored.body.user.status, 'pending_email');
  clock.advance(31 * DAY);
  await scheduled(env, clock.now);
  assert.equal(count(env, 'SELECT COUNT(*) AS n FROM users WHERE id = ?', fixer.user.id), 0, 'purged');
  assert.equal(row(late.user.id).status, 'pending_email', 'restored without an address: its 7 days start when it adds one');

  // Without email sending nobody could have confirmed: nothing expires.
  const off = makeEnv();
  const stuck = await signup(off, 'Stuck', { ip: '198.51.100.35' });
  delete off.EMAIL;
  clock.advance(10 * DAY);
  await scheduled(off, clock.now);
  assert.equal(off.DB.rows('SELECT status FROM users WHERE id = ?', stuck.user.id)[0].status, 'pending_email');
});

test('accounts from before addresses were required keep working without one and can add one', async () => {
  const env = makeEnv();
  await setSite(env, { registration: { approvalRequired: false } });
  const old = await signup(env, 'Veteran', { ip: '198.51.100.40' });
  // As stored before: no address at all, active.
  env.DB.sqlite.prepare("UPDATE users SET email = NULL, email_key = NULL, email_verified = 0, email_set_at = NULL, status = 'active' WHERE id = ?").run(old.user.id);
  env.DB.sqlite.prepare('DELETE FROM email_tokens').run();
  const b = new Browser(env, { ip: '198.51.100.41' });
  const login = await b.post('/api/auth/login', { login: 'veteran', password: PASSWORD });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.email, null);
  assert.equal(login.body.user.status, 'active');
  assert.equal(login.body.user.canPlay, true);
  clock.advance(30 * DAY);
  await scheduled(env, clock.now);
  assert.equal(env.DB.rows('SELECT status FROM users WHERE id = ?', old.user.id)[0].status, 'active', 'the daily job leaves it alone');
  // Adding an address: set at once (unverified), a link is sent, the status stays.
  await b.post('/api/auth/login', { login: 'veteran', password: PASSWORD });
  await b.post('/api/auth/reauth', { password: PASSWORD });
  const add = await b.post('/api/account/email', { email: 'veteran@example.com' });
  assert.equal(add.status, 200);
  assert.equal(add.body.user.email, 'veteran@example.com');
  assert.equal(add.body.user.status, 'active');
  assert.equal((await b.post('/api/auth/email/verify', { token: env.EMAIL.token('veteran@example.com', 'verify') })).body.user.emailVerified, true);
  assert.equal(env.DB.rows('SELECT status FROM users WHERE id = ?', old.user.id)[0].status, 'active');
});

test('without email sending: signup works, the address waits unverified, nothing is mailed, admins can still vouch for it', async () => {
  const env = makeEnv({ email: false });
  const site = await new Browser(env).get('/api/site');
  assert.equal(site.body.services.email, false);
  assert.equal(site.body.login.email, false);
  assert.equal(site.body.registration.emailVerificationRequired, false);
  const p = await signup(env, 'Patient', { ip: '198.51.100.50' });
  assert.equal(p.user.status, 'pending_approval', 'no verification step while it cannot be done');
  assert.equal(p.user.email, 'patient@example.com');
  assert.equal(p.user.emailVerified, false);
  assert.equal(count(env, 'SELECT COUNT(*) AS n FROM email_tokens'), 0);
  // An unverified address can be corrected without links; a verified one cannot be swapped.
  await p.post('/api/auth/reauth', { password: PASSWORD });
  const fix = await p.post('/api/account/email', { email: 'patient2@example.com' });
  assert.equal(fix.status, 200);
  assert.equal(fix.body.user.email, 'patient2@example.com');
  const admin = await adminOf(env);
  const resend = await admin.post(`/api/admin/users/${p.user.id}/email/resend`, {});
  assert.equal(resend.status, 503);
  const detail = await admin.get(`/api/admin/users/${p.user.id}`);
  assert.equal(detail.body.emailSending, false);
  assert.equal(detail.body.emailLink, null);
  const mark = await admin.post(`/api/admin/users/${p.user.id}/email/verify`, {});
  assert.equal(mark.status, 200);
  assert.equal(mark.body.user.emailVerified, true);
  const swap = await p.post('/api/account/email', { email: 'patient3@example.com' });
  assert.equal(swap.status, 503);
  // Sending failures (Email Service errors) never fail a signup.
  const failing = makeEnv();
  failing.EMAIL.fail = true;
  const f = await signup(failing, 'Unlucky', { ip: '198.51.100.51' });
  assert.equal(f.user.status, 'pending_email');
  assert.equal(failing.EMAIL.sent.length, 0);
  assert.equal((await f.post('/api/account/email/resend', {})).status, 202, 'the answer never depends on the mail');
});

test('the sender: EMAIL_FROM is required with the binding, and must be an address', async () => {
  const send = { send: async () => {} };
  assert.equal(services({ EMAIL: send }).email, false, 'no sender');
  assert.equal(services({ EMAIL: send, EMAIL_FROM: '  ' }).email, false);
  assert.equal(services({ EMAIL: send, EMAIL_FROM: 'not an address' }).email, false);
  assert.equal(services({ EMAIL_FROM: 'noreply@webra.sherin.dev' }).email, false, 'no binding');
  assert.equal(services({ EMAIL: send, EMAIL_FROM: 'noreply@webra.sherin.dev' }).email, true);
  assert.equal(emailSender({ EMAIL_FROM: ' NoReply@WEBRA.sherin.dev ' }), 'NoReply@webra.sherin.dev');
  const env = makeEnv({ vars: { EMAIL_FROM: '' } });
  assert.equal((await new Browser(env).get('/api/site')).body.services.email, false);
});

test('admin: verification state, resend and mark verified (audited); moderators and users cannot', async () => {
  const env = makeEnv();
  const admin = await adminOf(env);
  const mod = await signup(env, 'Moddy', { ip: '198.51.100.60' });
  promote(env, mod.user.id, 'moderator');
  await mod.post('/api/auth/login', { login: 'moddy', password: PASSWORD });
  const t = await signup(env, 'Target', { ip: '198.51.100.61' });
  const id = t.user.id;
  const d = await admin.get(`/api/admin/users/${id}`);
  assert.equal(d.body.emailSending, true);
  assert.equal(d.body.user.emailVerified, false);
  assert.equal(typeof d.body.user.emailSetAt, 'number');
  assert.deepEqual({ ...d.body.emailLink, sentAt: 0, expiresAt: 0 }, { purpose: 'verify', email: 'target@example.com', sentAt: 0, expiresAt: 0 });
  for (const who of [mod, t]) {
    assert.equal((await who.post(`/api/admin/users/${id}/email/resend`, {})).status, 403);
    assert.equal((await who.post(`/api/admin/users/${id}/email/verify`, {})).status, 403);
  }
  const before = env.EMAIL.sent.length;
  const r = await admin.post(`/api/admin/users/${id}/email/resend`, {});
  assert.equal(r.status, 202);
  assert.equal(r.body.sent, true);
  assert.equal(env.EMAIL.sent.length, before + 1);
  assert.equal(r.body.emailLink.purpose, 'verify');
  const v = await admin.post(`/api/admin/users/${id}/email/verify`, {});
  assert.equal(v.status, 200);
  assert.equal(v.body.user.emailVerified, true);
  assert.equal(v.body.user.status, 'pending_approval', 'as after following the link');
  assert.equal(count(env, 'SELECT COUNT(*) AS n FROM email_tokens WHERE user_id = ?', id), 0, 'open links go');
  assert.equal(env.DB.rows('SELECT email_key FROM users WHERE id = ?', id)[0].email_key, 'target@example.com');
  const audit = env.DB.rows("SELECT action, actor_id, before_json, after_json FROM audit_log WHERE target_id = ? AND action LIKE 'user.email_%' ORDER BY id", id);
  assert.deepEqual(audit.map((e) => e.action), ['user.email_resend', 'user.email_verify']);
  assert.equal(JSON.parse(audit[0].after_json).sent, true);
  assert.deepEqual(JSON.parse(audit[1].after_json), { email: 'target@example.com', emailVerified: true, status: 'pending_approval' });
  // Already verified, no address, another account verified the address: refused.
  assert.equal((await admin.post(`/api/admin/users/${id}/email/verify`, {})).status, 409);
  assert.equal((await admin.post(`/api/admin/users/${id}/email/resend`, {})).status, 409);
  const twin = await signup(env, 'Twin', { email: 'target@example.com', ip: '198.51.100.62' });
  const conflict = await admin.post(`/api/admin/users/${twin.user.id}/email/verify`, {});
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.field, 'email');
  // A resend to an address another account verified sends the notice, not a link (admins see the address anyway).
  const n = await admin.post(`/api/admin/users/${twin.user.id}/email/resend`, {});
  assert.equal(n.body.sent, true);
  assert.equal(linkOf(env.EMAIL.sent.at(-1)), null);
  // Admin resends are not capped per address, but per account per day.
  const statuses = [];
  for (let i = 0; i < 10; i++) statuses.push((await admin.post(`/api/admin/users/${twin.user.id}/email/resend`, {})).status);
  assert.equal(statuses.at(-1), 429);
});

test('development outbox: only with both variables over plain HTTP on a local host', async () => {
  const env = makeEnv({ email: false });
  const local = (h) => new Request(`http://${h}/api/site`);
  assert.equal(withDevMail(local('localhost:8799'), env), env, 'no variables');
  env.WEBRA_DEV_ROUTES = '1';
  assert.equal(withDevMail(local('localhost:8799'), env), env, 'WEBRA_DEV_MAIL missing');
  env.WEBRA_DEV_MAIL = '1';
  assert.equal(withDevMail(new Request('https://webra.sherin.dev/api/site'), env), env, 'production host');
  assert.equal(withDevMail(local('192.168.1.5:8799'), env), env, 'not a local host');
  const dev = withDevMail(local('localhost:8799'), env);
  assert.notEqual(dev, env);
  assert.equal(services(dev).email, true);
  assert.equal(emailSender(dev), 'noreply@webra.localhost');
  const withBinding = { ...env, EMAIL: { send: async () => {} }, EMAIL_FROM: 'a@example.com' };
  assert.equal(withDevMail(local('localhost:8799'), withBinding), withBinding, 'a real binding wins');
  // End to end through the Worker.
  const b = new Browser(env, { origin: 'http://localhost:8799' });
  const s = await b.post('/api/auth/signup', { username: 'Dev Mail', email: 'dev.mail@example.com', password: PASSWORD, acceptPrivacy: true });
  assert.equal(s.status, 201);
  assert.equal(s.body.user.status, 'pending_email');
  const box = await b.get('/api/dev/mail?to=dev.mail@example.com');
  assert.equal(box.status, 200);
  assert.equal(box.body.messages.length, 1);
  const token = linkOf(box.body.messages[0]);
  assert.ok(box.body.messages[0].text.includes('http://localhost:8799/account/#verify='));
  assert.equal((await b.post('/api/auth/email/verify', { token })).body.user.emailVerified, true);
  assert.equal((await new Browser(env).get('/api/dev/mail?to=dev.mail@example.com')).status, 404, 'production host');
  assert.equal((await b.get('/api/dev/mail?to=dev.mail@example.com', { csrf: false })).status, 403, 'a CSRF-protected read');
  env.WEBRA_DEV_MAIL = '0';
  assert.equal((await b.get('/api/dev/mail?to=dev.mail@example.com')).status, 404);
});

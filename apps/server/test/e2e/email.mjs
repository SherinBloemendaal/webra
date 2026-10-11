// End-to-end test of required email addresses and their verification against
// a running local Worker with the development outbox (src/accounts/dev.js):
//
//   cd apps/server
//   npx wrangler d1 migrations apply webra --local --persist-to /tmp/webra-email-e2e
//   npx wrangler dev --port 8798 --local-upstream localhost:8798 --persist-to /tmp/webra-email-e2e \
//     --var WEBRA_DEV_ROUTES:1 --var WEBRA_DEV_MAIL:1
//   node test/e2e/email.mjs http://localhost:8798
//
// (Its own database directory: signups are rate limited per address, and the
// smoke test runs against the default one without the outbox.) Exercises:
// signup needs an address; the link from the mail confirms it once; a
// tampered link does nothing; an address another account verified gets a
// notice instead of a link while the answer stays the same; resend limits;
// replacing an unverified address; the admin actions (resend, mark verified)
// and their audit entries.
import assert from 'node:assert/strict';

const BASE = process.argv[2] || 'http://localhost:8798';
const ORIGIN = new URL(BASE).origin;
const PASSWORD = 'email e2e passphrase';
/** Unique names per run (the database keeps accounts between runs). */
const RUN = Date.now().toString(36).slice(-6);

const cookies = new Map();

async function api(path, init = {}, who = null) {
  const headers = { Origin: ORIGIN, 'Content-Type': 'application/json', 'X-WebRA-CSRF': '1', ...init.headers };
  if (who && cookies.has(who)) headers.Cookie = cookies.get(who);
  const res = await fetch(BASE + path, { ...init, headers });
  if (who) {
    for (const c of res.headers.getSetCookie()) {
      const pair = c.split(';')[0];
      if (/^(__Host-)?webra_session=/.test(pair)) {
        if (/Max-Age=0/.test(c)) cookies.delete(who);
        else cookies.set(who, pair);
      }
    }
  }
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const post = (path, body, who) => api(path, { method: 'POST', body: JSON.stringify(body ?? {}) }, who);
const step = (name) => console.log(`- ${name}`);

/** Messages in the development outbox to `to`, oldest first. */
async function outbox(to) {
  const r = await api(`/api/dev/mail?to=${encodeURIComponent(to)}`);
  assert.equal(r.status, 200, `start wrangler dev with --var WEBRA_DEV_ROUTES:1 --var WEBRA_DEV_MAIL:1 (${JSON.stringify(r.body)})`);
  return r.body.messages;
}
const linkOf = (m) => /#verify=([A-Za-z0-9_-]{43})/.exec(m?.text ?? '')?.[1] ?? null;

async function signup(name, email) {
  const r = await post('/api/auth/signup', { username: name, email, password: PASSWORD, acceptPrivacy: true }, name);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.user;
}

const site = await api('/api/site');
assert.equal(site.body.services.email, true, 'the development outbox counts as email sending');
assert.equal(site.body.registration.emailVerificationRequired, true);
step('site: email sending through the development outbox');

// ---- Signup and the link ------------------------------------------------------------------
const A = `Mailer${RUN}`;
const aMail = `mailer.${RUN}@example.com`;
const none = await post('/api/auth/signup', { username: A, password: PASSWORD, acceptPrivacy: true });
assert.equal(none.status, 400);
assert.equal(none.body.error.field, 'email');
const a = await signup(A, aMail);
assert.equal(a.status, 'pending_email');
assert.equal(a.canPlay, false);
const [first] = await outbox(aMail);
assert.ok(first, 'the verification mail');
assert.match(first.subject, /confirm your email/i);
assert.ok(first.text.includes(`${ORIGIN}/account/#verify=`), 'a link to this site only');
assert.match(first.text, /24 hours/);
assert.match(first.html, /<a href="http:\/\/localhost:\d+\/account\/#verify=/);
const token = linkOf(first);
const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
assert.equal((await post('/api/auth/email/verify', { token: tampered })).status, 401);
const verified = await post('/api/auth/email/verify', { token }, A);
assert.equal(verified.status, 200);
assert.equal(verified.body.user.emailVerified, true);
assert.equal(verified.body.user.status, 'pending_approval');
assert.equal((await post('/api/auth/email/verify', { token }, A)).status, 401, 'single use');
step('signup needs an address; the link confirms it once; a tampered link does nothing');

// ---- An address another account verified ------------------------------------------------------
const B = `Prober${RUN}`;
const b = await signup(B, aMail.toUpperCase().replace('@EXAMPLE.COM', '@example.com'));
assert.equal(b.status, 'pending_email');
assert.equal(b.emailVerified, false);
assert.deepEqual(Object.keys(b).sort(), Object.keys(a).sort(), 'the same answer as any signup');
const toA = await outbox(b.email);
const notice = toA.at(-1);
assert.match(notice.subject, /already has an account/);
assert.equal(linkOf(notice), null, 'no link');
assert.equal(notice.text.includes(B), false, 'nothing the requester chose');
// The owner still signs in with the address; the prober cannot.
assert.equal((await post('/api/auth/login', { login: aMail, password: PASSWORD })).body.user.username, A);
step('an address another account verified: the same answer, a notice to the owner instead of a link');

// ---- Resend limits, replacing the unverified address ------------------------------------------------
const resends = [];
for (let i = 0; i < 4; i++) resends.push((await post('/api/account/email/resend', {}, B)).status);
assert.deepEqual(resends, [202, 202, 202, 429]);
assert.equal((await post('/api/account/email', { email: `prober.${RUN}@example.com` }, B)).body.error.code, 'reauth_required');
assert.equal((await post('/api/auth/reauth', { password: PASSWORD }, B)).status, 200);
const fixed = await post('/api/account/email', { email: `prober.${RUN}@example.com` }, B);
assert.equal(fixed.status, 200);
assert.equal(fixed.body.user.email, `prober.${RUN}@example.com`);
const [bLink] = await outbox(`prober.${RUN}@example.com`);
const v2 = await post('/api/auth/email/verify', { token: linkOf(bLink) }, B);
assert.equal(v2.body.user.emailVerified, true);
step('resend is limited per account; an unverified address is replaced at once and confirmed by its link');

// ---- Admin: resend and mark verified -------------------------------------------------------------
const ADMIN = `MailAdmin${RUN}`;
await signup(ADMIN, `mail.admin.${RUN}@example.com`);
const promoted = await post('/api/dev/promote', { username: ADMIN, role: 'admin' });
assert.equal(promoted.status, 200);
assert.equal((await post('/api/auth/login', { login: ADMIN, password: PASSWORD }, ADMIN)).status, 200);
const C = `Late${RUN}`;
const cMail = `late.${RUN}@example.com`;
const c = await signup(C, cMail);
const detail = await api(`/api/admin/users/${c.id}`, {}, ADMIN);
assert.equal(detail.body.emailSending, true);
assert.equal(detail.body.emailLink.purpose, 'verify');
assert.equal(detail.body.emailLink.email, cMail);
const resent = await post(`/api/admin/users/${c.id}/email/resend`, {}, ADMIN);
assert.equal(resent.status, 202);
assert.equal(resent.body.sent, true);
assert.equal((await outbox(cMail)).length, 2);
const marked = await post(`/api/admin/users/${c.id}/email/verify`, {}, ADMIN);
assert.equal(marked.status, 200);
assert.equal(marked.body.user.emailVerified, true);
assert.equal(marked.body.user.status, 'pending_approval');
const auditLog = await api(`/api/admin/audit?target=${c.id}`, {}, ADMIN);
assert.deepEqual(auditLog.body.entries.map((e) => e.action).sort(), ['user.email_resend', 'user.email_verify']);
assert.equal((await post(`/api/admin/users/${c.id}/email/verify`, {}, B)).status, 403, 'admins only');
step('admin: verification state, resend and mark verified, audited');

console.log('email end-to-end test passed');

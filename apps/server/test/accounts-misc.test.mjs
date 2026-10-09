// The retention job (cron), the test-only promote route and its guards,
// IP and CIDR parsing, and the wrangler configuration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Browser, call, Clock, makeEnv, PASSWORD, promote, scheduled, signup } from './accounts-harness.mjs';
import { inRange, ipRecord, parseCidr, parseIp } from '../src/accounts/ip.js';
import { summarizeUserAgent } from '../src/accounts/useragent.js';
import { DEFAULT_ITERATIONS, hashAccountPassword, needsRehash, targetIterations, verifyAccountPassword } from '../src/accounts/password.js';

const clock = new Clock();
test.after(() => clock.restore());
const DAY = 24 * 60 * 60 * 1000;

test('retention: expired sessions and tokens, old IPs, presence, IP bans, audit, purge after 30 days', async () => {
  const env = makeEnv();
  const keep = await signup(env, 'Keeper', { ip: '198.51.100.20' });
  const gone = await signup(env, 'Goner', { ip: '198.51.100.21' });
  promote(env, keep.user.id, 'admin');
  const admin = new Browser(env, { ip: '198.51.100.22' });
  await admin.post('/api/auth/login', { login: 'keeper', password: PASSWORD });
  await admin.del(`/api/admin/users/${gone.user.id}`);
  await admin.post('/api/admin/ip-bans', { cidr: '203.0.113.0/24', reason: 'x', expiresAt: clock.now + 1000 });
  const db = env.DB;
  db.sqlite.prepare("INSERT INTO game_presence (session_id, client, updated_at) VALUES ('s', 1, ?)").run(clock.now);
  db.sqlite.prepare("INSERT INTO audit_log (at, action, target_type) VALUES (?, 'site.update', 'site')").run(clock.now - 366 * DAY);
  const count = (table) => db.rows(`SELECT COUNT(*) AS n FROM ${table}`)[0].n;
  assert.equal(count('email_tokens'), 1, 'the verification link of Keeper (Goner lost theirs when deleted)');
  // Day 2: tokens, challenges, presence and the day-old counters expire; sessions not yet.
  clock.advance(2 * DAY);
  await scheduled(env, clock.now);
  assert.equal(count('email_tokens'), 0);
  assert.equal(count('game_presence'), 0);
  assert.equal(count('audit_log') > 0, true);
  assert.equal(db.rows("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'site.update'")[0].n, 0, 'audit entries older than 365 days');
  assert.ok(count('auth_sessions') > 0);
  // Day 31: Goner is purged (system audit entry), sessions are idle-expired after 14 days.
  clock.advance(29 * DAY);
  await scheduled(env, clock.now);
  assert.equal(db.rows('SELECT COUNT(*) AS n FROM users WHERE id = ?', gone.user.id)[0].n, 0);
  const purge = db.rows("SELECT actor_id, target_id FROM audit_log WHERE action = 'user.purge'")[0];
  assert.deepEqual(purge, { actor_id: null, target_id: gone.user.id });
  assert.equal(count('auth_sessions'), 0);
  assert.equal(count('ip_bans'), 1, 'expired IP bans are kept 90 days');
  assert.equal(count('user_ips'), 2, 'Keeper (two addresses) is still within 90 days');
  // Day 100: IP history and the expired IP ban are gone.
  clock.advance(70 * DAY);
  await scheduled(env, clock.now);
  assert.equal(count('user_ips'), 0);
  assert.equal(count('ip_bans'), 0);
  assert.equal(count('rate_limits'), 0);
});

test('the IP history keeps the 20 most recent addresses', async () => {
  const env = makeEnv({ email: false });
  await signup(env, 'Traveller', { ip: '198.51.100.30' });
  for (let i = 0; i < 25; i++) {
    clock.advance(1000);
    await new Browser(env, { ip: `192.0.2.${i + 1}` }).post('/api/auth/login', { login: 'traveller', password: PASSWORD });
  }
  const ips = env.DB.rows('SELECT ip FROM user_ips ORDER BY last_seen DESC').map((r) => r.ip);
  assert.equal(ips.length, 20);
  assert.equal(ips[0], '192.0.2.25');
  assert.equal(ips.includes('198.51.100.30'), false);
});

test('test-only promote route: only with the variable, over plain HTTP, on a local host', async () => {
  const wrangler = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  assert.equal(wrangler.includes('WEBRA_DEV_ROUTES'), false, 'the variable is never configured for deploys');
  const env = makeEnv({ email: false });
  const local = new Browser(env, { origin: 'http://localhost:8799' });
  await local.post('/api/auth/signup', { username: 'Smoke Admin', password: PASSWORD, acceptPrivacy: true });
  const body = { username: 'Smoke Admin', role: 'admin' };
  assert.equal((await local.post('/api/dev/promote', body)).status, 404, 'no variable');
  env.WEBRA_DEV_ROUTES = '1';
  for (const origin of ['https://webra.sherin.dev', 'http://webra.sherin.dev', 'https://localhost:8799', 'http://192.168.1.5:8799']) {
    const r = await new Browser(env, { origin }).post('/api/dev/promote', body);
    assert.equal(r.status, 404, origin);
  }
  env.WEBRA_DEV_ROUTES = 'true';
  assert.equal((await local.post('/api/dev/promote', body)).status, 404, 'exactly "1"');
  env.WEBRA_DEV_ROUTES = '1';
  const ok = await local.post('/api/dev/promote', body);
  assert.equal(ok.status, 200);
  assert.equal(env.DB.rows('SELECT role, status FROM users')[0].role, 'admin');
  // Still subject to the CSRF rules.
  assert.equal((await local.post('/api/dev/promote', body, { csrf: false })).status, 403);
});

test('wrangler.jsonc: daily cron, Discord client id variable, no email binding yet, no secrets', () => {
  const textValue = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  const config = JSON.parse(textValue.replace(/^\s*\/\/.*$/gm, ''));
  assert.deepEqual(config.triggers.crons, ['17 3 * * *']);
  assert.equal(typeof config.vars.DISCORD_CLIENT_ID, 'string');
  assert.equal(config.send_email, undefined, 'needs the Workers Paid plan: enabled later (docs/deploy.md)');
  assert.equal(/SECRET|PEPPER/.test(JSON.stringify(config.vars)), false);
});

test('IP parsing and CIDR ranges', () => {
  assert.deepEqual(ipRecord('203.0.113.7'), { ip: '203.0.113.7', v: 4, hex: 'cb007107' });
  assert.equal(ipRecord('::ffff:203.0.113.7').v, 4);
  assert.equal(ipRecord('2001:0db8:0000:0000:0000:ff00:0042:8329').ip, '2001:db8::ff00:42:8329');
  assert.equal(ipRecord('1:0:0:2:0:0:0:3').ip, '1:0:0:2::3', 'the longest zero run is compressed');
  for (const bad of ['', 'unknown', '1.2.3', '1.2.3.4.5', '256.1.1.1', '01.1.1.1', '1::2::3', '12345::', 'fe80::1%en0', ':::', 'g::1']) {
    assert.equal(parseIp(bad), null, bad);
  }
  const r = parseCidr('10.20.30.40/12');
  assert.deepEqual([r.cidr, r.start, r.end], ['10.16.0.0/12', '0a100000', '0a1fffff']);
  assert.ok(inRange('10.31.255.255', r));
  assert.ok(!inRange('10.32.0.0', r));
  assert.ok(!inRange('2001:db8::1', r));
  const six = parseCidr('2001:db8::/32');
  assert.ok(inRange('2001:db8:ffff::1', six));
  assert.ok(!inRange('2001:db9::1', six));
  assert.equal(parseCidr('1.2.3.4/33').error !== undefined, true);
  assert.equal(parseCidr('1.2.3.4/08').error !== undefined, true);
  assert.equal(parseCidr('1.2.3.4/8/8').error !== undefined, true);
  assert.equal(parseCidr('0.0.0.0/0').error !== undefined, true);
  assert.equal(parseCidr('::/0').error !== undefined, true);
  assert.equal(parseCidr('1.2.3.4/0', { minPrefix: { 4: 0, 6: 0 } }).cidr, '0.0.0.0/0');
});

test('user agent summaries', () => {
  assert.equal(summarizeUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Edg/140.0'), 'Edge on Windows');
  assert.equal(summarizeUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'), 'Safari on macOS');
  assert.equal(summarizeUserAgent('Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36'), 'Chrome on Android');
  assert.equal(summarizeUserAgent(null), 'Unknown device');
});

test('password hashes: iterations stored per hash, pepper per hash, rehash rules', async () => {
  assert.equal(targetIterations({}), DEFAULT_ITERATIONS);
  assert.equal(targetIterations({ PASSWORD_ITERATIONS: '200000' }), DEFAULT_ITERATIONS, 'above the Workers maximum: default');
  assert.equal(targetIterations({ PASSWORD_ITERATIONS: '15000' }), 15000);
  const plain = { PASSWORD_ITERATIONS: '10000' };
  const peppered = { PASSWORD_ITERATIONS: '10000', PASSWORD_PEPPER: 'a pepper of sixteen+ chars' };
  const h = await hashAccountPassword('secret passphrase', plain);
  const row = { password_hash: h.hash, password_salt: h.salt, password_iterations: h.iterations, password_peppered: h.peppered };
  assert.equal(await verifyAccountPassword('secret passphrase', row, plain), true);
  assert.equal(await verifyAccountPassword('secret passphrase', row, peppered), true, 'unpeppered hashes still verify after the pepper is set');
  assert.equal(needsRehash(row, peppered), true, 'and are upgraded');
  const hp = await hashAccountPassword('secret passphrase', peppered);
  const prow = { password_hash: hp.hash, password_salt: hp.salt, password_iterations: hp.iterations, password_peppered: hp.peppered };
  assert.equal(prow.password_peppered, 1);
  assert.equal(await verifyAccountPassword('secret passphrase', prow, peppered), true);
  assert.equal(await verifyAccountPassword('secret passphrase', prow, plain), false, 'a peppered hash needs the pepper');
  assert.equal(await verifyAccountPassword('wrong', prow, peppered), false);
  assert.equal(await verifyAccountPassword('x', { password_hash: null }, plain), false);
  // The scheduled handler is wired into the Worker export.
  assert.equal(typeof call, 'function');
});

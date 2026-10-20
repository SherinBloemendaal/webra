// The play gate (src/playgate.js, docs/security.md "The play gate"): the
// signed play pass, who may load /play for page loads and subresources,
// the redirect target, caching and security headers, D1 use, sign-out and
// the revocation bound.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Browser, Clock, makeEnv, ORIGIN, promote, setSite, signup } from './accounts-harness.mjs';
import { PASS_TTL_S, passKey, signPass, verifyPass, sidOfToken, passMatchesSession } from '../src/accounts/playpass.js';
import { BUILD_COOKIE, deployedBuild, isNavigation, isPlayPath, normalizedSegments, PLAY_CACHE_CONTROL, PLAY_FILE_CACHE_CONTROL, returnPathFor } from '../src/playgate.js';
import { PLAY_HEADERS, SITE_HEADERS } from '../src/static-headers.js';
import { hmacSha256, toBase64Url } from '../src/crypto.js';

const clock = new Clock();
test.after(() => clock.restore());

const SALT = 'test-ip-hash-salt-not-a-real-secret';
const USER = 'a'.repeat(32);
const SID = '0123456789abcdef';
const nowS = () => Math.floor(clock.now / 1000);

/** Static assets stand-in: records requests and answers like Workers Static Assets (public caching, ETag). */
const BUILD = '0.20.1+abcdef12';

/**
 * Static assets stand-in: records requests and answers like Workers Static
 * Assets (public caching, ETag). Pages (paths ending in / or .html) are HTML.
 * /version.json (the gate reads the deployed build from it once) is answered
 * with `build` and not recorded.
 */
function assets(env, { build = BUILD } = {}) {
  env.assetRequests = [];
  env.versionReads = 0;
  env.ASSETS = {
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      if (path === '/version.json') {
        env.versionReads++;
        return build === null ? new Response('not found', { status: 404 }) : Response.json({ version: '0.20.1', build });
      }
      env.assetRequests.push(path);
      const html = path.endsWith('/') || path.endsWith('.html');
      return new Response(`file ${path}`, {
        status: 200,
        headers: { 'content-type': html ? 'text/html; charset=utf-8' : 'text/javascript', 'cache-control': 'public, max-age=0, must-revalidate', etag: '"abc"', vary: 'Accept-Encoding' },
      });
    },
  };
  return env;
}

const NAV = { csrf: false, json: false, headers: { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', Accept: 'text/html,*/*', Origin: null } };
const SUB = { csrf: false, json: false, headers: { 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'script', Accept: '*/*', Origin: null } };
const WASM = '/play/pkg/webra_sim_bg.wasm';

async function activeUser(env, name, role = 'user', opts = {}) {
  const b = await signup(env, name, opts);
  promote(env, b.user.id, role);
  return b;
}

const passCookieOf = (res) => res.headers.getSetCookie().find((c) => c.startsWith('__Host-webra_play='));

// ---- The pass ---------------------------------------------------------------------------------

test('pass: signs and verifies; tampering, expiry, a far expiry, another key and another version fail', async () => {
  const key = await passKey(SALT);
  const exp = nowS() + PASS_TTL_S;
  const value = await signPass(key, { userId: USER, sid: SID, exp });
  assert.match(value, /^1\.[0-9a-f]{32}\.[0-9a-f]{16}\.\d+\.[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(await verifyPass(key, value, clock.now), { userId: USER, sid: SID, exp });

  const [v, u, s, e, mac] = value.split('.');
  const flip = (t) => (t[0] === 'a' ? 'b' : 'a') + t.slice(1);
  for (const bad of [
    [v, flip(u), s, e, mac],
    [v, u, flip(s), e, mac],
    [v, u, s, String(Number(e) + 1), mac],
    [v, u, s, e, flip(mac)],
    ['2', u, s, e, mac],
  ]) {
    assert.equal(await verifyPass(key, bad.join('.'), clock.now), null, bad.join('.'));
  }
  for (const junk of ['', 'x', `${value}.x`, value.replace(/\./g, ','), null, undefined, 42]) assert.equal(await verifyPass(key, junk, clock.now), null);
  // The last base64url character of the 32-byte MAC carries 2 padding bits:
  // a spelling with them changed decodes to the same MAC but is refused.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const sibling = value.slice(0, -1) + alphabet[alphabet.indexOf(value.at(-1)) ^ 1];
  assert.notEqual(sibling, value);
  assert.equal(await verifyPass(key, sibling, clock.now), null, 'only the canonical MAC spelling');

  // Expiry: valid until exp, refused from exp on.
  assert.ok(await verifyPass(key, value, (exp - 1) * 1000));
  assert.equal(await verifyPass(key, value, exp * 1000), null);
  // A pass that claims to live much longer than a pass lives (a leaked key, a bug) is refused.
  const far = await signPass(key, { userId: USER, sid: SID, exp: nowS() + 24 * 3600 });
  assert.equal(await verifyPass(key, far, clock.now), null);
  // Another secret, another key.
  assert.equal(await verifyPass(await passKey('another-secret-of-enough-length'), value, clock.now), null);
  // A pass of another version, even correctly MACed, is refused.
  const v2 = await signPass(key, { userId: USER, sid: SID, exp, version: 2 });
  assert.equal(await verifyPass(key, v2, clock.now), null);
});

test('pass: the key is derived (HKDF, own label), not the IP hash key itself', async () => {
  const key = await passKey(SALT);
  const exp = nowS() + 60;
  const value = await signPass(key, { userId: USER, sid: SID, exp });
  const plain = toBase64Url(await hmacSha256(SALT, `1.${USER}.${SID}.${exp}`));
  assert.notEqual(value.split('.')[4], plain);
});

test('pass: bound to the session token it was issued for', async () => {
  const token = 'T'.repeat(43);
  const sid = await sidOfToken(token);
  assert.match(sid, /^[0-9a-f]{16}$/);
  assert.equal(await passMatchesSession({ sid }, token), true);
  assert.equal(await passMatchesSession({ sid }, 'U'.repeat(43)), false);
  assert.equal(await passMatchesSession(null, token), false);
  assert.equal(await passMatchesSession({ sid }, null), false);
});

// ---- Navigation detection and the redirect target ----------------------------------------------

test('navigation detection: Fetch Metadata first, Accept without it', () => {
  const req = (headers, method = 'GET') => new Request(`${ORIGIN}/play/`, { method, headers });
  assert.equal(isNavigation(req({ 'Sec-Fetch-Mode': 'navigate' })), true);
  assert.equal(isNavigation(req({ 'Sec-Fetch-Mode': 'cors', Accept: 'text/html' })), false);
  assert.equal(isNavigation(req({ 'Sec-Fetch-Mode': 'no-cors' })), false);
  assert.equal(isNavigation(req({ Accept: 'text/html,application/xhtml+xml' })), true);
  assert.equal(isNavigation(req({ Accept: '*/*' })), false);
  assert.equal(isNavigation(req({ 'Sec-Fetch-Mode': 'navigate' }, 'POST')), false);
});

test('redirect target: only this game path, never another origin', () => {
  const at = (path) => returnPathFor(new URL(path, ORIGIN));
  assert.equal(at('/play/'), '/play/');
  assert.equal(at('/play'), '/play');
  assert.equal(at('/play/?join=abc'), '/play/?join=abc');
  assert.equal(at('/play/editor/?map=1f'), '/play/editor/?map=1f');
  for (const tricky of ['/play//evil.example/', '/play/\\evil.example', '/play/%2F%2Fevil.example', '/play/?next=https://evil.example']) {
    const target = at(tricky);
    assert.ok(target.startsWith('/play'), tricky);
    assert.ok(!target.startsWith('//'), tricky);
    assert.equal(new URL(target, ORIGIN).origin, ORIGIN, tricky);
  }
  assert.equal(at(`/play/${'x'.repeat(300)}`), '/play/', 'too long: the default');
  assert.equal(at('/play/"quoted"'), '/play/%22quoted%22');
  assert.equal(at('/elsewhere'), '/play/');
});

// ---- Path variants ----------------------------------------------------------------------------

/** Spellings of game paths that some layer could read as /play/...: every one is gated. */
const GATED_VARIANTS = [
  '/play',
  '/play/',
  '/play/js/main.js',
  '/%70lay/',
  '/%70lay/index.html',
  '/%70lay/js/main.js',
  '/%70lay/pkg/webra_sim_bg.wasm',
  '/pl%61y/js/main.js',
  '/%50LAY/js/main.js',
  '/%2570lay/js/main.js',
  '/play%2Findex.html',
  '/play%2fjs%2fmain.js',
  '/%2fplay/js/main.js',
  '/%2Fplay%2Fjs%2Fmain.js',
  '//play/',
  '//play/js/main.js',
  '///play//js//main.js',
  '/PLAY/',
  '/Play/js/main.js',
  '/pLaY/pkg/webra_sim_bg.wasm',
  '/play/./js/main.js',
  '/./play/js/main.js',
  '/x/../play/js/main.js',
  '/lib/../play/js/main.js',
  '/lib/%2e%2e/play/js/main.js',
  '/lib/%2E%2E%2Fplay/js/main.js',
  '/play/..%2fplay/js/main.js',
  '/api/..%2fplay/js/main.js',
  '/play.',
  '/play./js/main.js',
  '/play../js/main.js',
  '/play;x/js/main.js',
  '/play;/js/main.js',
  '/play%3Bx/js/main.js',
  '/play%20/js/main.js',
  '/play\\js\\main.js',
  '/play%5Cjs%5Cmain.js',
  '\\play\\js\\main.js',
  '/play/js/main.js;',
  '/play/js/main.js.',
  '/play/js/main.js/',
];

/** Paths that are not the game, whatever the spelling. */
const NOT_GAME = ['/', '/index.html', '/playground', '/play.html', '/plays/x', '/lib/js/account/api.js', '/assets/site.js', '/account/', '/%C0%AFplay/js/main.js', '/%E0%80%AFplay/js/main.js', '/api/version'];

test('path matcher: every spelling of a game path is the game; other paths are not', () => {
  for (const p of GATED_VARIANTS) assert.equal(isPlayPath(p), true, p);
  for (const p of NOT_GAME) assert.equal(isPlayPath(p), false, p);
  // Overlong UTF-8 never decodes to a slash or a letter.
  assert.deepEqual(normalizedSegments('/%C0%AFplay/js'), ['%c0%afplay', 'js']);
  assert.deepEqual(normalizedSegments('/%2570lay/x'), ['play', 'x'], 'double encoding is decoded too');
});

test('path variants that reach the Worker are gated like /play (never the assets without a check)', async () => {
  const env = assets(makeEnv({ email: false }));
  const anon = new Browser(env);
  for (const p of GATED_VARIANTS) {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'POST']) {
      const r = await anon.req(method, p, undefined, { csrf: false, json: false, headers: { ...SUB.headers, Range: 'bytes=0-3' } });
      assert.equal(r.status, 401, `${method} ${p}: ${r.status}`);
    }
    const nav = await anon.get(p, NAV);
    assert.equal(nav.status, 302, `navigation ${p}`);
    const target = decodeURIComponent(nav.res.headers.get('location').split('returnTo=')[1]);
    assert.ok(target === '/play' || target.startsWith('/play/'), `${p}: redirect back to a canonical game path, not ${target}`);
  }
  assert.deepEqual(env.assetRequests, [], 'no variant reached the assets');
});

// ---- The gate matrix ----------------------------------------------------------------------------

async function expectRedirect(b, path) {
  const r = await b.get(path, NAV);
  assert.equal(r.status, 302, `${path}: ${r.status}`);
  const location = r.res.headers.get('location');
  assert.equal(location, `/account/?returnTo=${encodeURIComponent(path)}`);
  assertSecurityHeaders(r.res);
  assert.equal(r.res.headers.get('cache-control'), 'no-store');
  assert.equal(await r.res.text(), '');
  return r;
}

async function expectRefused(b, path, status, code) {
  const r = await b.get(path, SUB);
  assert.equal(r.status, status, `${path}: ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body.error.code, code);
  assert.doesNotMatch(JSON.stringify(r.body), /file \//, 'no game content in a refusal');
  assertSecurityHeaders(r.res);
  assert.equal(r.res.headers.get('cache-control'), 'no-store');
  return r;
}

async function expectServed(b, path, opts = SUB) {
  const r = await b.get(path, opts);
  assert.equal(r.status, 200, `${path}: ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body, `file ${path}`);
  assertSecurityHeaders(r.res);
  // Pages revalidate; a file is kept only when the request named the deployed build (the cookie its page set).
  const page = path.endsWith('/') || path.endsWith('.html');
  const named = [...b.jar.entries()].some(([k, v]) => k.endsWith(BUILD_COOKIE) && v === BUILD);
  assert.equal(r.res.headers.get('cache-control'), !page && named ? PLAY_FILE_CACHE_CONTROL : PLAY_CACHE_CONTROL, path);
  assert.match(r.res.headers.get('vary'), /\bCookie\b/);
  assert.match(r.res.headers.get('vary'), /Accept-Encoding/, 'the asset Vary is kept');
  assert.equal(r.res.headers.get('etag'), '"abc"', 'other asset headers are kept');
  return r;
}

function assertSecurityHeaders(res) {
  for (const [k, v] of Object.entries({ ...SITE_HEADERS, ...PLAY_HEADERS })) assert.equal(res.headers.get(k), v, k);
  assert.equal(res.headers.get('cross-origin-resource-policy'), 'same-origin');
}

test('anonymous: page loads go to sign in, other requests get 401 without game content', async () => {
  const env = assets(makeEnv({ email: false }));
  const anon = new Browser(env);
  await expectRedirect(anon, '/play/');
  await expectRedirect(anon, '/play');
  await expectRedirect(anon, '/play/editor/');
  await expectRedirect(anon, '/play/?join=' + 'c'.repeat(64));
  for (const path of ['/play/js/main.js', '/play/js/sim/worker.js', '/play/protocol/accounts.js', '/play/css/game.css', WASM, '/play/shaders/common.wgsl', '/play/editor/js/editor.js']) {
    await expectRefused(anon, path, 401, 'unauthenticated');
  }
  // Without Fetch Metadata, Accept decides.
  const r = await anon.get('/play/', { csrf: false, json: false, headers: { Accept: 'text/html', Origin: null, 'Sec-Fetch-Site': null } });
  assert.equal(r.status, 302);
  assert.deepEqual(env.assetRequests, [], 'nothing was read from the assets');
});

test('pending, active, banned account, banned address, staff, setting off', async () => {
  const env = assets(makeEnv({ email: false }));
  // Pending approval (the default after signup).
  const pending = await signup(env, 'Pending One');
  await expectRedirect(pending, '/play/');
  const p = await expectRefused(pending, WASM, 403, 'account_inactive');
  assert.equal(p.body.error.status, 'pending_approval');
  assert.equal(passCookieOf(p.res), undefined);

  // Active: served, with a pass.
  const active = await activeUser(env, 'Active One');
  const page = await expectServed(active, '/play/', NAV);
  const cookie = passCookieOf(page.res);
  assert.ok(cookie, 'a pass is issued');
  for (const part of ['Path=/', 'HttpOnly', 'SameSite=Lax', 'Secure', `Max-Age=${PASS_TTL_S}`]) assert.ok(cookie.split('; ').includes(part), part);
  await expectServed(active, WASM);

  // Banned account: the ban ends its sessions, so it is signed out.
  const banned = await activeUser(env, 'Banned One');
  env.DB.sqlite.prepare("INSERT INTO account_bans (user_id, reason, created_at) VALUES (?, 'cheating', 0)").run(banned.user.id);
  await expectRedirect(banned, '/play/');
  await expectRefused(banned, WASM, 401, 'unauthenticated');

  // A banned address, for a player and for staff.
  const ipBanned = await activeUser(env, 'Net Banned', 'user', { ip: '203.0.113.9' });
  const mod = await activeUser(env, 'Mod One', 'moderator', { ip: '203.0.113.10' });
  const admin = await activeUser(env, 'Admin One', 'admin', { ip: '203.0.113.11' });
  env.DB.sqlite.prepare("INSERT INTO ip_bans (cidr, ip_v, start_hex, end_hex, reason, created_at) VALUES ('203.0.113.0/24', 4, 'cb007100', 'cb0071ff', 'x', 0)").run();
  await expectRedirect(ipBanned, '/play/');
  await expectRefused(ipBanned, WASM, 403, 'ip_banned');
  await expectServed(mod, WASM);
  await expectServed(admin, '/play/', NAV);

  // Pending staff have no powers: the account rule applies.
  const pendingAdmin = await signup(env, 'Pending Admin');
  env.DB.sqlite.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(pendingAdmin.user.id);
  await expectRefused(pendingAdmin, WASM, 403, 'account_inactive');

  // Setting off: everyone, without a pass.
  await setSite(env, { gameRequiresAccount: false });
  const anon = new Browser(env);
  const open = await expectServed(anon, '/play/', NAV);
  assert.equal(passCookieOf(open.res), undefined);
  await expectServed(anon, WASM);
  await expectServed(pending, WASM);
});

test('the setting: GET /api/site, the admin API with validation and audit, applied at once', async () => {
  const env = assets(makeEnv({ email: false }));
  const anon = new Browser(env);
  assert.equal((await anon.get('/api/site', { csrf: false })).body.gameRequiresAccount, true);
  await expectRefused(anon, WASM, 401, 'unauthenticated');
  const admin = await activeUser(env, 'Site Admin', 'admin');
  const before = await admin.get('/api/admin/site');
  assert.equal(before.body.settings.gameRequiresAccount, true);
  const bad = await admin.patch('/api/admin/site', { gameRequiresAccount: 'off' }, { headers: { 'If-Match': before.res.headers.get('etag') } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.field, 'settings.gameRequiresAccount');
  const r = await admin.patch('/api/admin/site', { gameRequiresAccount: false }, { headers: { 'If-Match': before.res.headers.get('etag') } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.settings.gameRequiresAccount, false);
  assert.equal(r.body.effective.gameRequiresAccount, false);
  const audit = env.DB.rows("SELECT before_json, after_json FROM audit_log WHERE action = 'site.update'");
  assert.equal(audit.length, 1);
  assert.equal(JSON.parse(audit[0].before_json).gameRequiresAccount, true);
  assert.equal(JSON.parse(audit[0].after_json).gameRequiresAccount, false);
  assert.equal((await anon.get('/api/site', { csrf: false })).body.gameRequiresAccount, false);
  // The save cleared this isolate's settings cache: the gate opens at once.
  await expectServed(anon, WASM);
});

test('UserSelf.canPlay follows the gate rule', async () => {
  const env = assets(makeEnv({ email: false }));
  const b = await signup(env, 'Can Play');
  assert.equal((await b.get('/api/auth/me', { csrf: false })).body.user.canPlay, false);
  promote(env, b.user.id);
  assert.equal((await b.get('/api/auth/me', { csrf: false })).body.user.canPlay, true);
  const pending = await signup(env, 'Not Yet');
  await setSite(env, { gameRequiresAccount: false });
  assert.equal((await pending.get('/api/auth/me', { csrf: false })).body.user.canPlay, true);
});

// ---- Cost, sign-out, revocation ------------------------------------------------------------------

test('a valid pass serves game files without touching D1', async () => {
  const env = assets(makeEnv({ email: false }));
  const b = await activeUser(env, 'Fast Path');
  const first = await expectServed(b, '/play/', NAV);
  assert.ok(passCookieOf(first.res));
  const queries = env.DB.queries;
  for (const path of ['/play/js/main.js', '/play/js/sim/worker.js', WASM, '/play/shaders/common.wgsl', '/play/protocol/accounts.js']) {
    const r = await expectServed(b, path);
    assert.equal(passCookieOf(r.res), undefined, 'no new pass while the old one is valid');
  }
  assert.equal(env.DB.queries, queries, 'no D1 queries with a valid pass');
  // Expired: one D1 check, a fresh pass, then quiet again.
  clock.advance(PASS_TTL_S * 1000);
  const again = await expectServed(b, WASM);
  assert.ok(passCookieOf(again.res), 'refreshed');
  assert.ok(env.DB.queries > queries);
  const after = env.DB.queries;
  await expectServed(b, '/play/js/main.js');
  assert.equal(env.DB.queries, after);
});

test('a forged or foreign pass falls back to the D1 check', async () => {
  const env = assets(makeEnv({ email: false }));
  const a = await activeUser(env, 'Pass Owner');
  await expectServed(a, '/play/', NAV);
  // An anonymous browser with a copied pass but no session: refused, and the pass is cleared.
  const thief = new Browser(env);
  thief.jar.set('__Host-webra_play', a.jar.get('__Host-webra_play'));
  const r = await expectRefused(thief, WASM, 401, 'unauthenticated');
  assert.match(passCookieOf(r.res), /Max-Age=0/);
  // Another signed-in (pending) account with someone else's pass: the session does not match.
  const other = await signup(env, 'Other Pending');
  other.jar.set('__Host-webra_play', a.jar.get('__Host-webra_play'));
  await expectRefused(other, WASM, 403, 'account_inactive');
  // A pass with a broken MAC. Change a character inside the MAC: the last
  // base64url character of a 32-byte MAC also carries 2 padding bits that
  // decoders ignore, so flipping only those would leave the MAC valid.
  const value = a.jar.get('__Host-webra_play');
  const at = value.lastIndexOf('.') + 5;
  const forged = value.slice(0, at) + (value[at] === 'A' ? 'B' : 'A') + value.slice(at + 1);
  assert.notEqual(forged, value);
  const queries = env.DB.queries;
  a.jar.set('__Host-webra_play', forged);
  const again = await expectServed(a, WASM);
  assert.ok(env.DB.queries > queries, 'checked in D1');
  assert.ok(passCookieOf(again.res), 'and replaced');
});

test('sign-out and deleting the account clear the pass at once', async () => {
  const env = assets(makeEnv({ email: false }));
  const b = await activeUser(env, 'Leaving Soon');
  await expectServed(b, '/play/', NAV);
  const pass = b.jar.get('__Host-webra_play');
  const out = await b.post('/api/auth/logout');
  assert.equal(out.status, 204);
  assert.match(passCookieOf(out.res), /^__Host-webra_play=; .*Max-Age=0/);
  assert.equal(b.jar.has('__Host-webra_play'), false);
  // Even a pass copied before signing out does not work without its session.
  b.jar.set('__Host-webra_play', pass);
  await expectRefused(b, WASM, 401, 'unauthenticated');
  await expectRedirect(b, '/play/');
});

test('revoking the current session clears the pass; other devices stop within the pass lifetime', async () => {
  const env = assets(makeEnv({ email: false }));
  const phone = await activeUser(env, 'Two Devices');
  const laptop = new Browser(env, { ip: phone.ip });
  assert.equal((await laptop.post('/api/auth/login', { login: 'Two Devices', password: 'correct horse battery' })).status, 200);
  await expectServed(phone, '/play/', NAV);
  await expectServed(laptop, '/play/', NAV);
  // The laptop signs out every other session: the phone's pass still works until it expires.
  assert.equal((await laptop.del('/api/account/sessions')).status, 204);
  await expectServed(phone, WASM);
  clock.advance(PASS_TTL_S * 1000);
  await expectRefused(phone, WASM, 401, 'unauthenticated');
  // A ban on the laptop's account: the pass keeps working for at most its lifetime.
  await expectServed(laptop, WASM); // fresh pass
  env.DB.sqlite.prepare("INSERT INTO account_bans (user_id, reason, created_at) VALUES (?, 'x', 0)").run(phone.user.id);
  await expectServed(laptop, WASM);
  clock.advance(PASS_TTL_S * 1000);
  await expectRefused(laptop, WASM, 401, 'unauthenticated');
});

test('session rotation (credential changes) re-checks in D1 and issues a matching pass', async () => {
  const env = assets(makeEnv({ email: false }));
  const b = await activeUser(env, 'Rotating');
  await expectServed(b, '/play/', NAV);
  const oldPass = b.jar.get('__Host-webra_play');
  assert.equal((await b.post('/api/auth/reauth', { password: 'correct horse battery' })).status, 200);
  const r = await expectServed(b, WASM);
  assert.notEqual(b.jar.get('__Host-webra_play'), oldPass);
  assert.ok(passCookieOf(r.res));
});

test('plain http on localhost: unprefixed, not Secure; production without the secret fails closed', async () => {
  const env = assets(makeEnv({ email: false }));
  const local = 'http://localhost:8787';
  const b = await signup(env, 'Local Dev');
  promote(env, b.user.id);
  const dev = new Browser(env, { origin: local });
  assert.equal((await dev.post('/api/auth/login', { login: 'Local Dev', password: 'correct horse battery' })).status, 200);
  const r = await dev.get('/play/', NAV);
  assert.equal(r.status, 200);
  const cookie = r.res.headers.getSetCookie().find((c) => c.startsWith('webra_play='));
  assert.ok(cookie);
  assert.ok(!cookie.includes('Secure'));

  const prod = assets(makeEnv({ email: false, vars: { IP_HASH_SALT: undefined } }));
  const anon = new Browser(prod);
  const nav = await anon.get('/play/', NAV);
  assert.equal(nav.status, 503);
  assert.equal(nav.body.error.code, 'misconfigured');
  assertSecurityHeaders(nav.res);
  assert.equal((await anon.get(WASM, SUB)).status, 503);
});

// ---- Configuration -----------------------------------------------------------------------------

test('static-headers.js matches apps/website/_headers', () => {
  const text = readFileSync(new URL('../../website/_headers', import.meta.url), 'utf8');
  const rules = new Map();
  let current = null;
  for (const line of text.split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      current = {};
      rules.set(line.trim(), current);
      continue;
    }
    const i = line.indexOf(':');
    current[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  assert.deepEqual(rules.get('/*'), { ...SITE_HEADERS });
  assert.deepEqual(rules.get('/play'), { ...PLAY_HEADERS });
  assert.deepEqual(rules.get('/play/*'), { ...PLAY_HEADERS });
  // Nothing in _headers makes game files publicly cacheable.
  for (const [pattern, headers] of rules) {
    if (pattern === '/*' || pattern.startsWith('/play')) assert.equal(headers['Cache-Control'], undefined, pattern);
  }
});

test('wrangler.jsonc runs the Worker first for /play, /play/* and invite links', () => {
  const text = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  const config = JSON.parse(text);
  // /join/* turns invite links into game URLs (src/index.js joinRedirect).
  assert.deepEqual(config.assets.run_worker_first, ['/api/*', '/play', '/play/*', '/join/*']);
  assert.equal(config.assets.binding, 'ASSETS');
});

// ---- The map editor through the gate -------------------------------------------------------

const GAME_DIR = new URL('../../game/', import.meta.url);
const TYPES = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  wgsl: 'text/plain; charset=utf-8',
  wasm: 'application/wasm',
  json: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  woff2: 'font/woff2',
};

/**
 * Workers Static Assets over apps/game as dist/play/ has it: an index.html is
 * served at its directory's URL with a trailing slash, the other spellings of
 * it are redirected there (307, html_handling auto-trailing-slash), files by
 * their path, anything else is a 404.
 */
function gameAssets(env) {
  env.assetRequests = [];
  env.ASSETS = {
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      env.assetRequests.push(path);
      const rel = path.replace(/^\/play\/?/, '');
      const file = (r) => {
        try {
          return readFileSync(new URL(r, GAME_DIR));
        } catch {
          return null;
        }
      };
      if (rel === '' || rel.endsWith('/')) {
        const body = file(`${rel}index.html`);
        return body ? new Response(body, { headers: { 'content-type': TYPES.html } }) : new Response('not found', { status: 404 });
      }
      if (rel.endsWith('/index.html') || rel === 'index.html' || file(`${rel}/index.html`)) {
        const dir = rel.endsWith('index.html') ? rel.slice(0, -'index.html'.length) : `${rel}/`;
        return new Response(null, { status: 307, headers: { location: `/play/${dir}` } });
      }
      const body = file(rel);
      if (!body) return new Response('not found', { status: 404 });
      return new Response(body, { headers: { 'content-type': TYPES[rel.split('.').pop()] ?? 'application/octet-stream' } });
    },
  };
  return env;
}

test('the map editor: every spelling of its URL ends on /play/editor/, and it and every file it loads come through the gate', async () => {
  const env = gameAssets(makeEnv({ email: false }));
  const b = await activeUser(env, 'Map Maker');
  // The modules, shaders and engine the page loads: its static imports, followed from editor.js.
  const graph = new Set();
  const visit = (rel) => {
    if (graph.has(rel)) return;
    graph.add(rel);
    if (!rel.endsWith('.js')) return;
    const src = readFileSync(new URL(rel, GAME_DIR), 'utf8');
    for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)[^'"]*?from\s+'(\.[^']+)'/g)) visit(new URL(m[1], new URL(rel, 'https://x/play/')).pathname.slice('/play/'.length));
  };
  visit('editor/editor.js');
  for (const s of ['common', 'terrain', 'sprite', 'fog', 'rect', 'line', 'weather', 'sky', 'heat']) graph.add(`shaders/${s}.wgsl`);
  for (const spelling of ['/play/editor', '/play/editor/', '/play/editor/index.html', '/play/editor?map=abc', '/play/editor/?map=abc']) {
    let path = spelling;
    let r = await b.get(path, NAV);
    for (let hops = 0; r.status === 307 && hops < 2; hops++) {
      assertSecurityHeaders(r.res);
      path = r.res.headers.get('location') + (spelling.includes('?') && !r.res.headers.get('location').includes('?') ? spelling.slice(spelling.indexOf('?')) : '');
      r = await b.get(path, NAV);
    }
    assert.equal(r.status, 200, `${spelling} -> ${path}`);
    assert.equal(new URL(path, ORIGIN).pathname, '/play/editor/', `${spelling} ends on the canonical URL`);
    assertSecurityHeaders(r.res);
    const html = r.body;
    assert.match(html, /<title>WebRA Map Editor<\/title>/);
    // Everything the page names, resolved the way the browser does (its <base>), comes through the gate.
    const base = new URL(html.match(/<base href="([^"]+)"/)[1], new URL(path, ORIGIN));
    const refs = [...html.matchAll(/(?:href|src)="([^"#]+)"/g)].map((m) => new URL(m[1], base).pathname).filter((p) => p !== base.pathname);
    for (const p of new Set([...refs, ...[...graph].map((g) => `/play/${g}`)])) {
      if (p === '/play/' || p === '/play/editor/') continue; // the game itself (the brand link) and this page (the boot screen's reload link)
      const asset = await b.get(p, SUB);
      assert.equal(asset.status, 200, `${spelling}: ${p} ${asset.status}`);
      assert.equal(asset.res.headers.get('content-type'), TYPES[p.split('.').pop()], p);
      assert.equal(asset.res.headers.get('cache-control'), PLAY_CACHE_CONTROL);
      assertSecurityHeaders(asset.res);
      if (!/\.(wasm|png|woff2)$/.test(p)) assert.equal(asset.body, readFileSync(new URL(p.slice('/play/'.length), GAME_DIR), 'utf8'), p);
    }
  }
  // Signed out: the page goes to sign in and back, its files are refused.
  const anon = new Browser(env);
  await expectRedirect(anon, '/play/editor/');
  for (const p of ['/play/editor/editor.js', '/play/editor/editor.css', '/play/css/theme.css', '/play/js/gameart.js']) await expectRefused(anon, p, 401, 'unauthenticated');
});

// ---- Caching ---------------------------------------------------------------------------------

test('caching: pages revalidate; files of the current build are kept for a pass lifetime, keyed by the build cookie', async () => {
  const env = assets(makeEnv({ email: false }));
  const b = await activeUser(env, 'Cache Player');
  assert.equal(PLAY_FILE_CACHE_CONTROL, `private, max-age=${PASS_TTL_S}`);
  assert.equal(PASS_TTL_S, 600);
  // The page: revalidated on every load, and it names the deployed build in a cookie.
  const page = await b.get('/play/', NAV);
  assert.equal(page.status, 200);
  assert.equal(page.res.headers.get('cache-control'), PLAY_CACHE_CONTROL);
  assert.match(page.res.headers.get('vary'), /\bCookie\b/);
  const buildCookie = page.res.headers.getSetCookie().find((c) => c.startsWith(`__Host-${BUILD_COOKIE}=`));
  assert.ok(buildCookie, 'the page sets the build cookie');
  assert.match(buildCookie, new RegExp(`^__Host-${BUILD_COOKIE}=${BUILD.replace('+', '\\+')}; Path=/; HttpOnly; SameSite=Lax; Max-Age=\\d+; Secure$`));
  // Its files, requested with the cookie the page set: kept by the browser (no request on a reload within 10 minutes).
  for (const p of ['/play/js/main.js', WASM, '/play/packs/terrain.bin']) {
    const r = await b.get(p, SUB);
    assert.equal(r.status, 200);
    assert.equal(r.res.headers.get('cache-control'), PLAY_FILE_CACHE_CONTROL, p);
    assert.match(r.res.headers.get('vary'), /\bCookie\b/, 'the cookie is part of the cache key');
    assert.equal(r.res.headers.get('etag'), '"abc"');
  }
  // A second page load sets no cookie (the browser already names this build); the editor page revalidates too.
  const again = await b.get('/play/', NAV);
  assert.equal(again.res.headers.getSetCookie().find((c) => c.includes(BUILD_COOKIE)), undefined);
  assert.equal((await b.get('/play/editor/', NAV)).res.headers.get('cache-control'), PLAY_CACHE_CONTROL);
  assert.equal(env.versionReads, 1, 'the build is read once per isolate');
});

test('caching: after a deploy the page names the new build, so no file of the old build is used with it', async () => {
  const env = assets(makeEnv({ email: false }), { build: '0.20.1+11111111' });
  const b = await activeUser(env, 'Deploy Player');
  await b.get('/play/', NAV);
  assert.equal((await b.get('/play/js/main.js', SUB)).res.headers.get('cache-control'), PLAY_FILE_CACHE_CONTROL);
  // A new deployment: new assets binding (a new isolate), another build.
  const next = assets(env, { build: '0.20.2+22222222' });
  // A file requested by a page of the old build (still open) is the new file: not kept, so it never sticks under the old key.
  assert.equal((await b.get('/play/js/main.js', SUB)).res.headers.get('cache-control'), PLAY_CACHE_CONTROL);
  // The new page renames the build: the browser's copies under the old cookie no longer match (Vary: Cookie).
  const page = await b.get('/play/', NAV);
  assert.ok(page.res.headers.getSetCookie().some((c) => c.includes(`${BUILD_COOKIE}=0.20.2+22222222`)));
  assert.equal((await b.get('/play/js/main.js', SUB)).res.headers.get('cache-control'), PLAY_FILE_CACHE_CONTROL);
  assert.equal(next.versionReads, 1);
});

test('caching: without a readable build, or for refusals and other statuses, nothing is kept', async () => {
  const env = assets(makeEnv({ email: false }), { build: null });
  const b = await activeUser(env, 'No Build');
  const page = await b.get('/play/', NAV);
  assert.equal(page.res.headers.getSetCookie().find((c) => c.includes(BUILD_COOKIE)), undefined);
  assert.equal((await b.get('/play/js/main.js', SUB)).res.headers.get('cache-control'), PLAY_CACHE_CONTROL);
  assert.equal(await deployedBuild({ ASSETS: { fetch: async () => Response.json({ build: 'bad build; x=1' }) } }, ORIGIN), null, 'a malformed build is not used');
  assert.equal(await deployedBuild({ ASSETS: { fetch: async () => new Response('{nope') } }, ORIGIN), null);
  // Refused requests stay no-store whatever the build.
  const env2 = assets(makeEnv({ email: false }));
  const anon = new Browser(env2);
  const r = await anon.get('/play/js/main.js', SUB);
  assert.equal(r.status, 401);
  assert.equal(r.res.headers.get('cache-control'), 'no-store');
  // A 404 from the assets is not kept either.
  const env3 = makeEnv({ email: false });
  env3.ASSETS = { fetch: async (req) => (new URL(req.url).pathname === '/version.json' ? Response.json({ build: BUILD }) : new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } })) };
  await setSite(env3, { gameRequiresAccount: false });
  const open = new Browser(env3);
  open.jar.set(`__Host-${BUILD_COOKIE}`, BUILD);
  const missing = await open.get('/play/nope.js', SUB);
  assert.equal(missing.status, 404);
  assert.equal(missing.res.headers.get('cache-control'), PLAY_CACHE_CONTROL);
});

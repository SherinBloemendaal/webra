// Passkeys (WebAuthn) end to end with a software authenticator: signup,
// usernameless sign-in, re-authentication and management, and every
// refusal (wrong origin, wrong rp id, replayed or expired challenges,
// counter regression, tampering). docs/accounts-api.md section 4.4.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Browser, Clock, makeEnv, ORIGIN, PASSWORD, signup } from './accounts-harness.mjs';
import { Authenticator, b64url, encodeCbor, fromB64url } from './webauthn-helper.mjs';
import { decodeCbor, decodeCborAll, derToRaw, parseAuthData, rpIdFor, WebAuthnError } from '../src/accounts/webauthn.js';

const clock = new Clock();
test.after(() => clock.restore());

async function passkeySignup(env, username, alg = 'ES256', { ip } = {}) {
  const b = new Browser(env, ip ? { ip } : {});
  const o = await b.post('/api/auth/passkey/signup-options', { username });
  assert.equal(o.status, 200, JSON.stringify(o.body));
  const auth = await Authenticator.create(alg);
  const credential = await auth.register(o.body.publicKey, ORIGIN);
  const email = env.EMAIL ? `${username.toLowerCase()}@example.com` : null;
  const r = await b.post('/api/auth/signup', { username, email, passkey: { challengeId: o.body.challengeId, credential }, acceptPrivacy: true });
  return { b, auth, r, options: o.body };
}

async function passkeyLogin(env, auth, opts = {}) {
  const b = new Browser(env);
  const o = await b.post('/api/auth/passkey/options', {});
  assert.equal(o.status, 200);
  const credential = await auth.assert(o.body.publicKey, opts.origin ?? ORIGIN, opts);
  const r = await b.post('/api/auth/passkey/login', { challengeId: o.body.challengeId, credential });
  return { b, r, options: o.body, credential };
}

test('CBOR decoder: shapes, limits and strictness', () => {
  const v = decodeCborAll(encodeCbor(new Map([[1, 2], [-3, new Uint8Array([9])], ['s', [true, false, null]]])));
  assert.equal(v.get(1), 2);
  assert.deepEqual([...v.get(-3)], [9]);
  assert.deepEqual(v.get('s'), [true, false, null]);
  const throws = (bytes) => assert.throws(() => decodeCborAll(new Uint8Array(bytes)), WebAuthnError);
  throws([0x5f]); // indefinite byte string
  throws([0x9f, 0xff]); // indefinite array
  throws([0xc0, 0x00]); // tag
  throws([0x01, 0x02]); // trailing bytes
  throws([0x43, 1, 2]); // truncated
  throws([0xa2, 0x01, 0x01, 0x01, 0x02]); // duplicate key
  throws([0x9b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]); // absurd length
  let deep = [0x01];
  for (let i = 0; i < 40; i++) deep = [0x81, ...deep];
  throws(deep);
  assert.equal(decodeCbor(new Uint8Array([0x19, 0x01, 0x00])).value, 256);
});

test('DER signatures convert to r || s and malformed ones are refused', () => {
  const r = new Uint8Array(32).fill(0x80);
  const s = new Uint8Array(32).fill(1);
  const der = new Uint8Array([0x30, 0x45, 0x02, 0x21, 0x00, ...r, 0x02, 0x20, ...s]);
  assert.deepEqual([...derToRaw(der)], [...r, ...s]);
  assert.throws(() => derToRaw(new Uint8Array([0x30, 0x02, 0x02, 0x00])), WebAuthnError);
  assert.throws(() => derToRaw(new Uint8Array([0x31, ...der.slice(1)])), WebAuthnError);
});

test('authenticator data parsing refuses trailing bytes and short data', () => {
  assert.throws(() => parseAuthData(new Uint8Array(36)), WebAuthnError);
  const ok = new Uint8Array(37);
  ok[32] = 1;
  assert.equal(parseAuthData(ok).flags.up, true);
  assert.throws(() => parseAuthData(new Uint8Array([...ok, 0])), WebAuthnError);
});

test('rp id per host: production over HTTPS, localhost for local HTTP, nothing else', () => {
  assert.equal(rpIdFor(new Request('https://webra.sherin.dev/api/site')), 'webra.sherin.dev');
  assert.equal(rpIdFor(new Request('http://localhost:8787/api/site')), 'localhost');
  assert.equal(rpIdFor(new Request('http://127.0.0.1:8787/api/site')), 'localhost');
  assert.equal(rpIdFor(new Request('http://webra.sherin.dev/api/site')), null);
  assert.equal(rpIdFor(new Request('https://evil.example/api/site')), null);
});

for (const alg of ['ES256', 'RS256', 'EdDSA']) {
  test(`${alg}: passkey-only signup and usernameless sign-in`, async () => {
    const env = makeEnv({ email: false });
    const { r, auth, options } = await passkeySignup(env, `Key${alg}`, alg);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(r.body.user.methods, { password: false, discord: null, passkeys: 1 });
    assert.equal(options.publicKey.rp.id, 'webra.sherin.dev');
    assert.equal(options.publicKey.attestation, 'none');
    assert.deepEqual(options.publicKey.pubKeyCredParams.map((p) => p.alg), [-8, -7, -257]);
    assert.equal(options.publicKey.authenticatorSelection.residentKey, 'required');
    const login = await passkeyLogin(env, auth);
    assert.equal(login.r.status, 200, JSON.stringify(login.r.body));
    assert.equal(login.r.body.user.username, `Key${alg}`);
    const row = env.DB.rows('SELECT sign_count, last_used_at FROM passkeys')[0];
    assert.equal(row.sign_count, 1);
    assert.equal(row.last_used_at, clock.now);
  });
}

test('sign-in refusals: wrong origin, wrong rp id, wrong type, replay, tampering, unknown key, user handle', async () => {
  const env = makeEnv({ email: false });
  const { auth } = await passkeySignup(env, 'Careful');
  const refused = async (opts, label) => {
    const { r } = await passkeyLogin(env, auth, opts);
    assert.equal(r.status, 401, label);
    assert.equal(r.body.error.code, 'bad_credentials');
  };
  await refused({ origin: 'https://evil.example' }, 'wrong origin');
  await refused({ origin: 'http://webra.sherin.dev' }, 'wrong scheme');
  await refused({ rpId: 'evil.example' }, 'wrong rp id');
  await refused({ type: 'webauthn.create' }, 'wrong type');
  await refused({ challenge: b64url(new Uint8Array(32)) }, 'other challenge');
  await refused({ flags: 0x04 }, 'user not present');
  await refused({ userHandle: b64url(new Uint8Array(32).fill(1)) }, 'user handle of nobody');
  // Replay: the same challenge and assertion a second time.
  const { b, options, credential, r } = await passkeyLogin(env, auth);
  assert.equal(r.status, 200);
  const replay = await b.post('/api/auth/passkey/login', { challengeId: options.challengeId, credential });
  assert.equal(replay.status, 401, 'challenges are single use');
  // Tampered signature.
  const o = await b.post('/api/auth/passkey/options', {});
  const good = await auth.assert(o.body.publicKey, ORIGIN);
  const sig = fromB64url(good.response.signature);
  sig[sig.length - 1] ^= 1;
  const bad = { ...good, response: { ...good.response, signature: b64url(sig) } };
  assert.equal((await b.post('/api/auth/passkey/login', { challengeId: o.body.challengeId, credential: bad })).status, 401);
  // An unknown credential.
  const stranger = await Authenticator.create('ES256');
  const o2 = await b.post('/api/auth/passkey/options', {});
  assert.equal((await b.post('/api/auth/passkey/login', { challengeId: o2.body.challengeId, credential: await stranger.assert(o2.body.publicKey, ORIGIN) })).status, 401);
  // Expired challenge (5 minutes).
  const o3 = await b.post('/api/auth/passkey/options', {});
  clock.advance(5 * 60 * 1000 + 1);
  assert.equal((await b.post('/api/auth/passkey/login', { challengeId: o3.body.challengeId, credential: await auth.assert(o3.body.publicKey, ORIGIN) })).status, 401);
  // Garbage (in a fresh rate limit window: options and sign-in both count).
  clock.advance(15 * 60 * 1000);
  for (const credential of [null, {}, { id: 'x', type: 'public-key', response: {} }, 'str']) {
    const o4 = await b.post('/api/auth/passkey/options', {});
    assert.equal((await b.post('/api/auth/passkey/login', { challengeId: o4.body.challengeId, credential })).status, 401);
  }
});

test('signature counter regression is refused and flagged', async () => {
  const env = makeEnv({ email: false });
  const { auth } = await passkeySignup(env, 'Counter');
  assert.equal((await passkeyLogin(env, auth, { counter: 5 })).r.status, 200);
  const back = await passkeyLogin(env, auth, { counter: 5 });
  assert.equal(back.r.status, 401, 'a counter that does not grow');
  assert.equal(env.DB.rows('SELECT counter_error FROM passkeys')[0].counter_error, 1);
  assert.equal((await passkeyLogin(env, auth, { counter: 3 })).r.status, 401);
  assert.equal((await passkeyLogin(env, auth, { counter: 9 })).r.status, 200);
  // Authenticators that never count (always 0) are fine.
  const { auth: zero } = await passkeySignup(env, 'ZeroCount');
  zero.counter = 0;
  const z1 = await passkeyLogin(env, zero, { counter: 0 });
  const z2 = await passkeyLogin(env, zero, { counter: 0 });
  assert.deepEqual([z1.r.status, z2.r.status], [200, 200]);
});

test('registration refusals: wrong origin, wrong rp id, username mismatch, duplicate credential', async () => {
  const env = makeEnv({ email: false });
  const b = new Browser(env);
  const tryReg = async (username, mutate, regUsername = username) => {
    const o = await b.post('/api/auth/passkey/signup-options', { username });
    const auth = await Authenticator.create('ES256');
    const credential = await auth.register(o.body.publicKey, mutate.origin ?? ORIGIN, mutate);
    return b.post('/api/auth/signup', { username: regUsername, email: null, passkey: { challengeId: o.body.challengeId, credential }, acceptPrivacy: true });
  };
  // email optional only without verification: this env has no email binding.
  assert.equal((await tryReg('Alpha1', { origin: 'https://evil.example' })).status, 400);
  assert.equal((await tryReg('Alpha2', { rpId: 'evil.example' })).status, 400);
  assert.equal((await tryReg('Alpha3', { type: 'webauthn.get' })).status, 400);
  assert.equal((await tryReg('Alpha4', {}, 'Somebody Else')).status, 400, 'the challenge belongs to the username');
  const ok = await tryReg('Alpha5', {});
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const taken = await b.post('/api/auth/passkey/signup-options', { username: 'alpha5' });
  assert.equal(taken.status, 409);
});

test('managing passkeys: re-authentication, exclude list, rename, last method, reauth by passkey', async () => {
  const env = makeEnv({ email: false });
  const b = await signup(env, 'Manager');
  assert.equal((await b.post('/api/account/passkeys/options', {})).body.error.code, 'reauth_required', 'adding a passkey needs a fresh proof');
  await b.post('/api/auth/reauth', { password: PASSWORD });
  const o = await b.post('/api/account/passkeys/options', {});
  assert.equal(o.status, 200, JSON.stringify(o.body));
  assert.equal(o.body.publicKey.user.name, 'Manager');
  const auth = await Authenticator.create('EdDSA');
  const credential = await auth.register(o.body.publicKey, ORIGIN);
  const add = await b.post('/api/account/passkeys', { challengeId: o.body.challengeId, name: 'Laptop', credential });
  assert.equal(add.status, 201, JSON.stringify(add.body));
  assert.equal(add.body.passkey.name, 'Laptop');
  const again = await b.post('/api/account/passkeys/options', {});
  assert.deepEqual(again.body.publicKey.excludeCredentials.map((c) => c.id), [auth.id]);
  // The same authenticator again: conflict.
  const dup = await b.post('/api/account/passkeys', { challengeId: again.body.challengeId, name: 'Again', credential: await auth.register(again.body.publicKey, ORIGIN) });
  assert.equal(dup.status, 409);
  const id = encodeURIComponent(auth.id);
  assert.equal((await b.patch(`/api/account/passkeys/${id}`, { name: 'Work laptop' })).body.passkey.name, 'Work laptop');
  assert.equal((await b.get('/api/account/passkeys')).body.passkeys.length, 1);
  // Re-authenticate with the passkey after the window ran out.
  clock.advance(11 * 60 * 1000);
  assert.equal((await b.del(`/api/account/passkeys/${id}`)).body.error.code, 'reauth_required');
  const ro = await b.post('/api/auth/passkey/options', { purpose: 'reauth' });
  assert.deepEqual(ro.body.publicKey.allowCredentials.map((c) => c.id), [auth.id]);
  const reauth = await b.post('/api/auth/reauth', { passkey: { challengeId: ro.body.challengeId, credential: await auth.assert(ro.body.publicKey, ORIGIN) } });
  assert.equal(reauth.status, 200, JSON.stringify(reauth.body));
  // Remove the password: the passkey is left; then the passkey cannot go.
  assert.equal((await b.del('/api/account/password')).status, 200);
  const last = await b.del(`/api/account/passkeys/${id}`);
  assert.equal(last.status, 409);
  // Another account's passkey is not ours.
  const other = await signup(env, 'Outsider');
  assert.equal((await other.patch(`/api/account/passkeys/${id}`, { name: 'Mine' })).status, 404);
  // A passkey from someone else's account cannot reauthenticate this one.
  const ro2 = await other.post('/api/auth/passkey/options', { purpose: 'reauth' });
  assert.equal(ro2.status, 409, 'no passkeys to offer');
  // Adding without a recent re-authentication fails.
  clock.advance(11 * 60 * 1000);
  assert.equal((await b.post('/api/account/passkeys/options', {})).body.error.code, 'reauth_required');
  // Passkeys switched off.
  const { setSite } = await import('./accounts-harness.mjs');
  await setSite(env, { login: { passkey: false } });
  assert.equal((await new Browser(env).post('/api/auth/passkey/options', {})).body.error.code, 'method_disabled');
  assert.equal(PASSWORD.length > 0, true);
});

// Account client (js/account/api.js), passkey encoding (passkey.js) and the
// settings sync (sync.js), against an in-memory server implementing the
// contract (account-mock.mjs, docs/accounts-api.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountApi, AccountError, errorText, formatWait, needsCsrf, queryString, versionOfEtag } from '../js/account/api.js';
import { toBase64url, fromBase64url, creationOptions, requestOptions, credentialJSON } from '../js/account/passkey.js';
import { SettingsSync, mergeSettings, resolveConflicts, SYNC_KEY } from '../js/account/sync.js';
import { createRegistry, normalizeValues, checkDocument } from '../js/registry.js';
import { MockAccountServer } from './account-mock.mjs';
import { memoryStorage } from './dom-fixtures.mjs';

function setup() {
  const server = new MockAccountServer();
  const api = new AccountApi({ fetchImpl: server.fetch });
  return { server, api };
}

// ---- API client ---------------------------------------------------------------------------

test('api: CSRF header on every write and on account and admin reads; JSON only with a body', async () => {
  const { server, api } = setup();
  await api.site();
  await api.me();
  await api.signup({ username: 'Tanya', email: 'tanya@example.com', password: 'a long passphrase', acceptPrivacy: true });
  await api.account();
  const [site, me, signup, account] = server.requests;
  assert.equal(site.headers['x-webra-csrf'], undefined);
  assert.equal(me.headers['x-webra-csrf'], undefined);
  assert.equal(signup.headers['x-webra-csrf'], '1');
  assert.equal(signup.headers['content-type'], 'application/json');
  assert.equal(account.headers['x-webra-csrf'], '1');
  assert.equal(account.headers['content-type'], undefined);
  assert.equal(needsCsrf('GET', '/api/admin/users?q=a'), true);
  assert.equal(needsCsrf('GET', '/api/accounts-public'), false);
  assert.equal(needsCsrf('DELETE', '/api/maps/1'), true);
  // The server refuses a write without it (the mock checks like the real one).
  const raw = await server.fetch('/api/auth/logout', { method: 'POST' });
  assert.equal(raw.status, 403);
  assert.equal((await raw.json()).error.code, 'csrf');
});

test('api: errors carry code, message, field and extras; offline and non-JSON answers are clear', async () => {
  const { server, api } = setup();
  await assert.rejects(api.signup({ username: 'Al', password: 'a long passphrase', acceptPrivacy: true }), (e) => e instanceof AccountError && e.code === 'invalid' && e.field === 'username' && e.status === 400);
  const banned = server.addUser({ username: 'Boris', password: 'a long passphrase' });
  banned.ban = { reason: 'Cheating', expiresAt: server.now + 3_600_000 };
  const err = await api.login({ login: 'boris', password: 'a long passphrase' }).catch((e) => e);
  assert.equal(err.code, 'banned');
  assert.match(errorText(err), /banned until .*Reason: Cheating/);
  server.offline = true;
  const off = await api.site().catch((e) => e);
  assert.equal(off.status, 0);
  assert.equal(off.code, 'offline');
  const html = new AccountApi({ fetchImpl: async () => new Response('<html>', { status: 200 }) });
  assert.equal((await html.site().catch((e) => e)).code, 'unavailable');
  const limited = new AccountApi({ fetchImpl: async () => new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'Slow down.' } }), { status: 429, headers: { 'Retry-After': '120' } }) });
  const e2 = await limited.login({ login: 'x', password: 'y' }).catch((e) => e);
  assert.equal(e2.detail.retryAfter, 120);
  assert.equal(errorText(e2), 'Slow down. Try again in 2 minutes.');
  assert.equal(formatWait(30), '30 seconds');
  assert.equal(formatWait(7200), '2 hours');
});

test('api: sessions, settings with versions (412 brings the current document), export, admin queries', async () => {
  const { server, api } = setup();
  await api.signup({ username: 'Tanya', email: 'tanya@example.com', password: 'a long passphrase', acceptPrivacy: true });
  assert.equal((await api.me()).user.username, 'Tanya');
  const s0 = await api.settings();
  assert.equal(s0.version, 0);
  const s1 = await api.putSettings(0, { schema: 1, audio: { master: 0.5 } });
  assert.equal(s1.version, 1);
  assert.equal(server.requests.at(-1).headers['if-match'], '"v0"');
  const stale = await api.putSettings(0, { schema: 1 }).catch((e) => e);
  assert.equal(stale.code, 'version_conflict');
  assert.equal(stale.detail.current.version, 1);
  assert.equal((await api.settings()).version, 1);
  // Signing up is not a re-authentication: the export needs a fresh one.
  assert.equal((await api.exportData().catch((e) => e)).code, 'reauth_required');
  await api.reauth({ password: 'a long passphrase' });
  const { blob, name } = await api.exportData();
  assert.equal(name, 'webra-account-Tanya.json');
  assert.equal(JSON.parse(await blob.text()).user.username, 'Tanya');
  assert.equal(queryString({ q: 'a b', status: '', page: 2, role: undefined }), '?q=a%20b&page=2');
  assert.equal(versionOfEtag('"v12"'), 12);
  assert.equal(versionOfEtag('W/"v3"'), 3);
  assert.equal(versionOfEtag('nope'), null);
  // Admin endpoints need the role.
  assert.equal((await api.stats().catch((e) => e)).code, 'forbidden');
  await api.logout();
  assert.equal((await api.me()).user, null);
});

// ---- Passkeys -------------------------------------------------------------------------------

test('passkeys: base64url round trip; options and credentials converted without the browser helpers', () => {
  const bytes = Uint8Array.from({ length: 33 }, (_, i) => (i * 37) & 255);
  const text = toBase64url(bytes);
  assert.doesNotMatch(text, /[+/=]/);
  assert.deepEqual(fromBase64url(text), bytes);
  assert.throws(() => fromBase64url('not base64!'));
  const create = creationOptions({ challenge: toBase64url([1, 2]), user: { id: toBase64url([3]), name: 'T', displayName: 'T' }, excludeCredentials: [{ type: 'public-key', id: toBase64url([9]) }] }, {});
  assert.deepEqual([...create.challenge], [1, 2]);
  assert.deepEqual([...create.user.id], [3]);
  assert.deepEqual([...create.excludeCredentials[0].id], [9]);
  const get = requestOptions({ challenge: toBase64url([5]), allowCredentials: [] }, {});
  assert.deepEqual([...get.challenge], [5]);
  const json = credentialJSON({
    id: 'abc',
    rawId: new Uint8Array([1]).buffer,
    type: 'public-key',
    response: { clientDataJSON: new Uint8Array([2]).buffer, authenticatorData: new Uint8Array([3]).buffer, signature: new Uint8Array([4]).buffer, userHandle: new Uint8Array([5]).buffer },
    getClientExtensionResults: () => ({}),
  });
  assert.deepEqual(json, { id: 'abc', rawId: 'AQ', type: 'public-key', response: { clientDataJSON: 'Ag', authenticatorData: 'Aw', signature: 'BA', userHandle: 'BQ' }, clientExtensionResults: {} });
});

// ---- Settings sync ----------------------------------------------------------------------------

function fakeTimers() {
  const pending = new Map();
  let n = 0;
  return {
    pending,
    setTimeout: (fn, ms) => (pending.set(++n, { fn, ms }), n),
    clearTimeout: (id) => pending.delete(id),
    async fire() {
      const all = [...pending.values()];
      pending.clear();
      for (const t of all) t.fn();
      await new Promise((r) => setTimeout(r, 5));
    },
  };
}

function device(server, user, { storage = memoryStorage(), syncStorage = memoryStorage(), onConflict } = {}) {
  const registry = createRegistry({ storage });
  const timers = fakeTimers();
  const statuses = [];
  const conflicts = [];
  const sync = new SettingsSync({
    api: new AccountApi({ fetchImpl: server.fetch }),
    registry,
    storage: syncStorage,
    timers,
    onStatus: (s) => statuses.push(s),
    onConflict: async (c) => {
      conflicts.push(c);
      return onConflict ? onConflict(c) : 'remote';
    },
  });
  return { registry, timers, statuses, conflicts, sync, storage, syncStorage, user };
}

const asUser = (server, user) => server.signIn(user);

test('sync: a new account takes this device\'s settings; another device then gets them (server wins)', async () => {
  const server = new MockAccountServer();
  const user = server.addUser({ username: 'Tanya', password: 'a long passphrase' });
  asUser(server, user);
  const a = device(server, user);
  a.registry.set('audio', 'master', 0.3);
  a.registry.set('game', 'hotkeys', { stop: ['Z'] });
  await a.sync.start(user);
  const stored = server.settingsDocs.get(user.id);
  assert.equal(stored.version, 1);
  assert.equal(stored.settings.audio.master, 0.3);
  assert.equal(checkDocument(stored.settings).ok, true, 'the upload is a valid settings document');
  assert.equal(a.statuses.at(-1), 'synced');
  // Device B has its own (unsynced, never signed in) settings: the account wins.
  const b = device(server, user);
  b.registry.set('audio', 'master', 0.9);
  const seen = [];
  b.registry.subscribe((changes, origin) => seen.push(origin));
  await b.sync.start(user);
  assert.equal(b.registry.get('audio', 'master'), 0.3);
  assert.deepEqual(b.registry.get('game', 'hotkeys'), { stop: ['Z'] });
  assert.deepEqual(seen, ['remote']);
  assert.equal(server.settingsDocs.get(user.id).version, 1, 'nothing uploaded');
});

test('sync: changes upload after a pause, with the version; a newer version on the server is merged and retried', async () => {
  const server = new MockAccountServer();
  const user = server.addUser({ username: 'Tanya', password: 'a long passphrase' });
  asUser(server, user);
  const a = device(server, user);
  await a.sync.start(user);
  a.registry.set('audio', 'music', 0.1);
  a.registry.set('audio', 'music', 0.2);
  assert.equal(a.timers.pending.size, 1, 'one debounced upload');
  await a.timers.fire();
  assert.equal(server.settingsDocs.get(user.id).settings.audio.music, 0.2);
  const v = server.settingsDocs.get(user.id).version;
  // Another device uploads meanwhile (a different setting).
  server.settingsDocs.set(user.id, { version: v + 1, updatedAt: 0, settings: { ...server.settingsDocs.get(user.id).settings, game: { lowQuality: true } } });
  a.registry.set('audio', 'effects', 0.4);
  await a.timers.fire();
  const doc = server.settingsDocs.get(user.id);
  assert.equal(doc.version, v + 2, '412, merged, uploaded again');
  assert.equal(doc.settings.audio.effects, 0.4);
  assert.equal(doc.settings.game.lowQuality, true, 'the other device\'s change survived');
  assert.equal(a.registry.get('game', 'lowQuality'), true, 'and reached this device');
  assert.equal(a.conflicts.length, 0);
});

test('sync: offline changes are kept across a reload and uploaded later; a conflict asks the player', async () => {
  const server = new MockAccountServer();
  const user = server.addUser({ username: 'Tanya', password: 'a long passphrase' });
  asUser(server, user);
  const storage = memoryStorage();
  const syncStorage = memoryStorage();
  const a = device(server, user, { storage, syncStorage });
  await a.sync.start(user);
  server.offline = true;
  a.registry.set('audio', 'voices', 0.1);
  a.registry.set('game', 'healthBars', 'all');
  await a.timers.fire();
  assert.equal(a.statuses.at(-1), 'offline');
  assert.equal(JSON.parse(syncStorage.getItem(SYNC_KEY)).dirty, true, 'remembered as not uploaded');
  a.sync.stop({ forget: false });
  // Meanwhile another device changed healthBars too (a conflict) and voices not.
  const v = server.settingsDocs.get(user.id).version;
  server.settingsDocs.set(user.id, { version: v + 1, updatedAt: 0, settings: { ...server.settingsDocs.get(user.id).settings, game: { ...server.settingsDocs.get(user.id).settings.game, healthBars: 'off', showUnitPaths: true } } });
  server.offline = false;
  // A reload: new registry and sync over the same storage. The player keeps this device's choice.
  const b = device(server, user, { storage, syncStorage, onConflict: () => 'local' });
  await b.sync.start(user);
  assert.equal(b.conflicts.length, 1);
  assert.deepEqual(b.conflicts[0].conflicts.map((c) => `${c.group}.${c.key}:${c.local}/${c.remote}`), ['game.healthBars:all/off']);
  const doc = server.settingsDocs.get(user.id).settings;
  assert.equal(doc.game.healthBars, 'all');
  assert.equal(doc.audio.voices, 0.1, 'the offline change went up');
  assert.equal(doc.game.showUnitPaths, true, 'the other device\'s change stays');
  assert.equal(b.registry.get('game', 'showUnitPaths'), true);
  assert.equal(JSON.parse(syncStorage.getItem(SYNC_KEY)).dirty, false);
});

test('sync: choosing the account\'s values drops this device\'s conflicting change; sign-out forgets', async () => {
  const server = new MockAccountServer();
  const user = server.addUser({ username: 'Tanya', password: 'a long passphrase' });
  asUser(server, user);
  const syncStorage = memoryStorage();
  const storage = memoryStorage();
  const a = device(server, user, { storage, syncStorage });
  await a.sync.start(user);
  server.offline = true;
  a.registry.set('audio', 'master', 0.11);
  await a.timers.fire();
  a.sync.stop({ forget: false });
  server.offline = false;
  const v = server.settingsDocs.get(user.id).version;
  server.settingsDocs.set(user.id, { version: v + 1, updatedAt: 0, settings: { audio: { master: 0.66 } } });
  const b = device(server, user, { storage, syncStorage, onConflict: () => 'remote' });
  await b.sync.start(user);
  assert.equal(b.registry.get('audio', 'master'), 0.66);
  assert.equal(server.settingsDocs.get(user.id).version, v + 1, 'nothing to upload');
  b.sync.stop();
  assert.equal(syncStorage.getItem(SYNC_KEY), null);
  b.registry.set('audio', 'master', 0.2);
  assert.equal(b.timers.pending.size, 0, 'signed out: no uploads');
});

test('sync: another account on this device starts clean (its document wins, nothing of the last one is uploaded)', async () => {
  const server = new MockAccountServer();
  const one = server.addUser({ username: 'One', password: 'a long passphrase' });
  const two = server.addUser({ username: 'Two', password: 'a long passphrase' });
  server.settingsDocs.set(two.id, { version: 4, updatedAt: 0, settings: { audio: { master: 0.4 } } });
  asUser(server, one);
  const syncStorage = memoryStorage();
  const a = device(server, one, { syncStorage });
  await a.sync.start(one);
  server.offline = true;
  a.registry.set('audio', 'master', 0.9);
  await a.timers.fire();
  a.sync.stop({ forget: false });
  server.offline = false;
  asUser(server, two);
  const b = device(server, two, { storage: a.storage, syncStorage });
  await b.sync.start(two);
  assert.equal(b.registry.get('audio', 'master'), 0.4);
  assert.equal(server.settingsDocs.get(two.id).version, 4);
  assert.equal(b.conflicts.length, 0);
});

test('merge: one-sided changes win, both-sided different values conflict, no base means every difference', () => {
  const base = normalizeValues({}).values;
  const local = normalizeValues({ audio: { master: 0.1, music: 0.3 } }).values;
  const remote = normalizeValues({ audio: { master: 0.2 }, game: { lowQuality: true } }).values;
  const r = mergeSettings({ base, local, remote });
  assert.equal(r.merged.audio.music, 0.3);
  assert.equal(r.merged.game.lowQuality, true);
  assert.deepEqual(r.conflicts.map((c) => c.key), ['master']);
  assert.equal(r.merged.audio.master, 0.2, 'the account until the player chooses');
  assert.equal(resolveConflicts(r.merged, r.conflicts, 'local').audio.master, 0.1);
  const same = mergeSettings({ base, local: remote, remote });
  assert.equal(same.conflicts.length, 0, 'the same change on both sides is no conflict');
  const noBase = mergeSettings({ base: null, local, remote });
  assert.deepEqual(noBase.conflicts.map((c) => c.key).sort(), ['lowQuality', 'master', 'music']);
});

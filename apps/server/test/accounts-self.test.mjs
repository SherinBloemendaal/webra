// Self service (docs/accounts-api.md section 5): profile, password, email,
// sessions, the settings document with optimistic concurrency, export and
// deletion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Browser, Clock, makeEnv, PASSWORD, setSite, signup } from './accounts-harness.mjs';

const clock = new Clock();
test.after(() => clock.restore());
const DAY = 24 * 60 * 60 * 1000;

test('profile: display name, avatar color, username once per 30 days', async () => {
  const env = makeEnv({ email: false });
  const b = await signup(env, 'Profile');
  await signup(env, 'Taken');
  const r = await b.patch('/api/account', { displayName: '  Tanya   A. ', avatarColor: '#123abc' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.user.displayName, 'Tanya A.');
  assert.equal(r.body.user.avatarColor, '#123abc');
  assert.equal((await b.patch('/api/account', { avatarColor: 'red' })).body.error.field, 'avatarColor');
  assert.equal((await b.patch('/api/account', { role: 'admin' })).status, 400, 'no unknown fields (no role)');
  assert.equal((await b.patch('/api/account', { username: 'taken' })).status, 409);
  const renamed = await b.patch('/api/account', { username: 'Renamed' });
  assert.equal(renamed.body.user.username, 'Renamed');
  const soon = await b.patch('/api/account', { username: 'Again' });
  assert.equal(soon.status, 403);
  clock.advance(31 * DAY);
  await b.post('/api/auth/login', { login: 'renamed', password: PASSWORD });
  assert.equal((await b.patch('/api/account', { username: 'Again' })).status, 200);
  assert.equal((await new Browser(env).post('/api/auth/login', { login: 'again', password: PASSWORD })).status, 200);
});

test('password change: needs a fresh re-authentication (no current password field); other sessions revoked', async () => {
  const env = makeEnv({ email: false });
  const b = await signup(env, 'Changer');
  const other = new Browser(env, { ip: '198.51.100.99' });
  assert.equal((await other.post('/api/auth/login', { login: 'changer', password: PASSWORD })).status, 200);
  assert.equal((await b.post('/api/account/password', { newPassword: 'an entirely new one' })).body.error.code, 'reauth_required');
  const legacy = await b.post('/api/account/password', { currentPassword: PASSWORD, newPassword: 'an entirely new one' });
  assert.equal(legacy.status, 400, 'the old currentPassword field is gone (it meant two key derivations in one request)');
  assert.equal((await b.post('/api/auth/reauth', { password: 'not it at all' })).status, 401);
  assert.equal((await b.post('/api/auth/reauth', { password: PASSWORD })).status, 200);
  const weak = await b.post('/api/account/password', { newPassword: 'changer' });
  assert.equal(weak.status, 400);
  const ok = await b.post('/api/account/password', { newPassword: 'an entirely new one' });
  assert.equal(ok.status, 200);
  assert.equal((await other.get('/api/auth/me')).body.user, null, 'the other session was revoked');
  assert.equal((await b.get('/api/auth/me')).body.user.username, 'Changer', 'this one continues (rotated)');
  assert.equal((await new Browser(env).post('/api/auth/login', { login: 'changer', password: 'an entirely new one' })).status, 200);
});

test('email change with verification links; resend; removal rules', async () => {
  const env = makeEnv();
  const b = await signup(env, 'Mailer');
  await b.post('/api/auth/email/verify', { token: env.EMAIL.token('mailer@example.com', 'verify') });
  const taken = await signup(env, 'Holder');
  assert.equal((await b.post('/api/account/email', { email: 'new.mailer@example.com' })).body.error.code, 'reauth_required');
  await b.post('/api/auth/reauth', { password: PASSWORD });
  // Holder's address is unverified: it claims nothing, a change link may go out for it.
  assert.equal((await b.post('/api/account/email', { email: 'holder@example.com' })).status, 202);
  const verifiedOther = await signup(env, 'Verified');
  await verifiedOther.post('/api/auth/email/verify', { token: env.EMAIL.token('verified@example.com', 'verify') });
  const c = await b.post('/api/account/email', { email: 'verified@example.com' });
  assert.equal(c.status, 409, 'a verified address of another account is taken');
  const r = await b.post('/api/account/email', { email: 'new.mailer@example.com' });
  assert.equal(r.status, 202);
  assert.equal(r.body.user.email, 'mailer@example.com', 'unchanged until confirmed');
  assert.equal(r.body.user.pendingEmail, 'new.mailer@example.com');
  const token = env.EMAIL.token('new.mailer@example.com', 'verify');
  const v = await b.post('/api/auth/email/verify', { token });
  assert.equal(v.status, 200);
  assert.equal(v.body.user.email, 'new.mailer@example.com');
  assert.equal(v.body.user.emailVerified, true);
  assert.equal(v.body.user.pendingEmail, null);
  // Resend: only for an unverified address, 3 per hour.
  assert.equal((await b.post('/api/account/email/resend', {})).status, 409);
  const statuses = [];
  for (let i = 0; i < 4; i++) statuses.push((await taken.post('/api/account/email/resend', {})).status);
  assert.deepEqual(statuses, [202, 202, 202, 429]);
  // Sending failures are reported.
  env.EMAIL.fail = true;
  clock.advance(60 * 60 * 1000);
  assert.equal((await taken.post('/api/account/email/resend', {})).status, 503);
  env.EMAIL.fail = false;
  // Verification in effect: the email cannot be removed.
  assert.equal((await b.post('/api/auth/reauth', { password: PASSWORD })).status, 200);
  assert.equal((await b.del('/api/account/email')).status, 409);
  await setSite(env, { registration: { emailVerification: false } });
  const removed = await b.del('/api/account/email');
  assert.equal(removed.status, 200);
  assert.equal(removed.body.user.email, null);
});

test('sessions: list, label, revoke one, revoke the others', async () => {
  const env = makeEnv({ email: false });
  const a = await signup(env, 'Sessions');
  const second = new Browser(env, { ip: '198.51.100.50', ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/605.1' });
  await second.post('/api/auth/login', { login: 'sessions', password: PASSWORD });
  const third = new Browser(env, { ip: '198.51.100.51' });
  await third.post('/api/auth/login', { login: 'sessions', password: PASSWORD });
  const list = await a.get('/api/account/sessions');
  assert.equal(list.body.sessions.length, 3);
  assert.equal(list.body.sessions.filter((s) => s.current).length, 1);
  assert.ok(list.body.sessions.some((s) => s.userAgent === 'Safari on iOS'));
  assert.ok(list.body.sessions.every((s) => /^[0-9a-f]{16}$/.test(s.id)));
  const iphone = (await second.get('/api/account/sessions')).body.sessions.find((s) => s.current);
  assert.equal((await a.patch(`/api/account/sessions/${iphone.id}`, { deviceLabel: 'My phone' })).body.session.deviceLabel, 'My phone');
  assert.equal((await a.del(`/api/account/sessions/${iphone.id}`)).status, 204);
  assert.equal((await second.get('/api/auth/me')).body.user, null);
  assert.equal((await a.del('/api/account/sessions')).status, 204);
  assert.equal((await third.get('/api/auth/me')).body.user, null);
  assert.equal((await a.get('/api/account/sessions')).body.sessions.length, 1);
  // Another account's session id is unknown here.
  const other = await signup(env, 'Neighbour');
  const theirs = (await other.get('/api/account/sessions')).body.sessions[0].id;
  assert.equal((await a.del(`/api/account/sessions/${theirs}`)).status, 404);
  assert.equal((await a.del('/api/account/sessions/zzzz')).status, 404);
});

test('settings document: validation, ETag and If-Match, conflicts from two devices', async () => {
  const env = makeEnv({ email: false });
  const desktop = await signup(env, 'Settings');
  const laptop = new Browser(env, { ip: '198.51.100.60' });
  await laptop.post('/api/auth/login', { login: 'settings', password: PASSWORD });
  const first = await desktop.get('/api/account/settings');
  assert.deepEqual(first.body, { version: 0, updatedAt: null, settings: {} });
  assert.equal(first.res.headers.get('etag'), '"v0"');
  const doc = {
    schema: 1,
    game: { edgeScrollSpeed: 1.5, keyScrollSpeed: 0.5, showUnitPaths: true, pixelRatioCap: 1, lowQuality: false, uiScale: 0.85, gameScale: 'auto', healthBars: 'damaged', graphics: 'original', hotkeys: { attackMove: ['A', 'Ctrl+Shift+F1'], stop: [] } },
    audio: { enabled: true, master: 0.5, effects: 1, voices: 0, music: 0.3, speech: false, original: true, musicOn: true, musicShuffle: false, musicRepeat: 'off' },
    content: { packs: [{ id: 'desert tiles|someone', enabled: true }, { id: 'hd units|other', enabled: false }] },
    debug: { cells: true, stats: true, cpuInstances: false },
    lobby: { name: 'Commander', faction: 'randomsoviet', color: 3, lastOptions: { mapSize: 96, startingCash: 5000, players: [{ slot: 0, type: 'human' }] } },
    releaseNotes: { lastSeenVersion: '0.6.0' },
    extra: { future: { nested: [1, 'two', null] } },
  };
  assert.equal((await desktop.put('/api/account/settings', { settings: doc })).status, 428, 'If-Match is required');
  const saved = await desktop.put('/api/account/settings', { settings: doc }, { headers: { 'If-Match': '"v0"' } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.version, 1);
  assert.equal(saved.res.headers.get('etag'), '"v1"');
  assert.deepEqual((await laptop.get('/api/account/settings')).body.settings, doc);
  // The laptop still thinks it is at v0: conflict with the current document attached.
  const stale = await laptop.put('/api/account/settings', { settings: { audio: { master: 1 } } }, { headers: { 'If-Match': '"v0"' } });
  assert.equal(stale.status, 412);
  assert.equal(stale.body.error.code, 'version_conflict');
  assert.equal(stale.body.error.current.version, 1);
  assert.deepEqual(stale.body.error.current.settings, doc);
  const merged = await laptop.put('/api/account/settings', { settings: { ...doc, audio: { ...doc.audio, master: 1 } } }, { headers: { 'If-Match': '"v1"' } });
  assert.equal(merged.body.version, 2);
  // Invalid documents name the path.
  const invalid = async (settings, field) => {
    const r = await desktop.put('/api/account/settings', { settings }, { headers: { 'If-Match': '"v2"' } });
    assert.equal(r.status, 400, JSON.stringify(settings).slice(0, 80));
    assert.equal(r.body.error.field, field);
  };
  await invalid({ audio: { master: 2 } }, 'settings.audio.master');
  await invalid({ game: { uiScale: 0.25 } }, 'settings.game.uiScale');
  await invalid({ game: { gameScale: 'big' } }, 'settings.game.gameScale');
  await invalid({ audio: { musicRepeat: 'twice' } }, 'settings.audio.musicRepeat');
  await invalid({ game: { healthBars: 'some' } }, 'settings.game.healthBars');
  await invalid({ game: { fly: true } }, 'settings.game.fly');
  await invalid({ cheats: {} }, 'settings.cheats');
  await invalid({ schema: 2 }, 'settings.schema');
  await invalid({ game: { hotkeys: { attackMove: ['A', 'B', 'C', 'D', 'E'] } } }, 'settings.game.hotkeys.attackMove');
  await invalid({ game: { hotkeys: { 'bad name!': [] } } }, 'settings.game.hotkeys');
  await invalid({ content: { packs: [{ id: 'a', enabled: true }, { id: 'a', enabled: false }] } }, 'settings.content.packs[1].id');
  await invalid({ lobby: { faction: 'atlantis' } }, 'settings.lobby.faction');
  await invalid({ lobby: { name: '' } }, 'settings.lobby.name');
  await invalid({ releaseNotes: { lastSeenVersion: 'v 1' } }, 'settings.releaseNotes.lastSeenVersion');
  await invalid({ extra: { s: 'x'.repeat(501) } }, 'settings.extra.s');
  await invalid({ extra: { a: { b: { c: { d: 1 } } } } }, 'settings.extra.a.b.c');
  await invalid({ extra: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, 'y'.repeat(300)])) }, 'settings.extra');
  await invalid({ lobby: { lastOptions: { blob: Array.from({ length: 60 }, () => 'z'.repeat(100)) } } }, 'settings.lobby.lastOptions');
  // Saved game modes: complete, known bundles, unique names, at most 16.
  const mode = { mapStyle: 'islands', biome: 'snow', weather: 'full', startingCash: 10000, startingUnits: 'light', techLevel: 'high', gameSpeed: 'fast', fog: true, explored: false, buildRadius: true, redeployableMcv: true, oreRegrowth: true, reusableEngineers: false, cheats: false };
  await invalid({ lobby: { presets: [{ name: 'Ice', options: { ...mode, biome: 'lava' } }] } }, 'settings.lobby.presets[0].options.biome');
  await invalid({ lobby: { presets: [{ name: 'Ice', options: mode }, { name: 'ICE', options: mode }] } }, 'settings.lobby.presets[1].name');
  await invalid({ lobby: { presets: [{ name: 'Ice', options: { ...mode, seed: 4 } }] } }, 'settings.lobby.presets[0].options');
  await invalid({ lobby: { presets: Array.from({ length: 17 }, (_, i) => ({ name: `Mode ${i}`, options: mode })) } }, 'settings.lobby.presets');
  const withModes = await desktop.put('/api/account/settings', { settings: { ...doc, lobby: { ...doc.lobby, presets: [{ name: 'Ice', options: mode }] } } }, { headers: { 'If-Match': '"v2"' } });
  assert.equal(withModes.status, 200, JSON.stringify(withModes.body));
  // A mode saved before protocol 6 gets the defaults of the options added since.
  const stored = { ...mode, timeLimit: 0, crates: true, shortGame: true, bounty: false, separateTeamSpawns: true, allyBuildRadius: true, techBuildings: 'standard' };
  assert.deepEqual((await laptop.get('/api/account/settings')).body.settings.lobby.presets, [{ name: 'Ice', options: stored }]);
  await invalid([], 'settings');
  const malformed = await desktop.put('/api/account/settings', { settings: {} }, { headers: { 'If-Match': 'v3' } });
  assert.equal(malformed.status, 400);
  const tooBig = await desktop.put('/api/account/settings', { settings: { extra: { s: 'x'.repeat(41 * 1024) } } }, { headers: { 'If-Match': '"v3"' } });
  assert.equal(tooBig.status, 413);
});

test('data export holds everything about the account and nothing secret', async () => {
  const env = makeEnv({ email: false });
  const b = await signup(env, 'Exporter', { ip: '198.51.100.70' });
  await b.put('/api/account/settings', { settings: { audio: { master: 0.2 } } }, { headers: { 'If-Match': '"v0"' } });
  await b.post('/api/auth/reauth', { password: PASSWORD });
  const r = await b.get('/api/account/export');
  assert.equal(r.status, 200);
  assert.match(r.res.headers.get('content-disposition'), /attachment; filename="webra-account-Exporter.json"/);
  const data = r.body;
  assert.equal(data.account.username, 'Exporter');
  assert.deepEqual(data.ipHistory.map((i) => i.ip), ['198.51.100.70']);
  assert.equal(data.settings.settings.audio.master, 0.2);
  assert.equal(data.sessions.length, 1);
  const text = JSON.stringify(data);
  const row = env.DB.rows('SELECT password_hash, password_salt FROM users')[0];
  assert.equal(text.includes(row.password_hash), false, 'no password hash');
  assert.equal(text.includes(row.password_salt), false);
  for (const s of env.DB.rows('SELECT id_hash FROM auth_sessions')) assert.equal(text.includes(s.id_hash), false);
  clock.advance(11 * 60 * 1000);
  assert.equal((await b.get('/api/account/export')).body.error.code, 'reauth_required');
});

test('account deletion: confirm, soft delete, sign-in refused, username reserved', async () => {
  const env = makeEnv({ email: false });
  const b = await signup(env, 'Leaver');
  await b.post('/api/auth/reauth', { password: PASSWORD });
  assert.equal((await b.del('/api/account', { confirm: 'leaver' })).status, 400, 'exact username');
  assert.equal((await b.del('/api/account', { confirm: 'Leaver' })).status, 204);
  assert.equal(b.signedIn, false);
  const row = env.DB.rows('SELECT status, deleted_at FROM users')[0];
  assert.equal(row.status, 'deleted');
  assert.equal(row.deleted_at, clock.now);
  const login = await new Browser(env).post('/api/auth/login', { login: 'leaver', password: PASSWORD });
  assert.equal(login.status, 401);
  const again = await new Browser(env, { ip: '198.51.100.88' }).post('/api/auth/signup', { username: 'Leaver', password: PASSWORD, acceptPrivacy: true });
  assert.equal(again.status, 409, 'the username stays reserved until the purge');
});

test('the last admin cannot delete their own account', async () => {
  const env = makeEnv({ email: false });
  const b = await signup(env, 'OnlyAdmin');
  env.DB.sqlite.prepare("UPDATE users SET role = 'admin', status = 'active'").run();
  await b.post('/api/auth/reauth', { password: PASSWORD });
  assert.equal((await b.del('/api/account', { confirm: 'OnlyAdmin' })).status, 409);
});

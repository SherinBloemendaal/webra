// Replays in accounts (docs/accounts-api.md 5.10, src/accounts/replays.js):
// upload, list, download and delete through the real Worker, over the fake
// D1 and the in-memory R2 bucket; ownership, the limits, the size cap,
// validation, one copy per file, the 30 day expiry in the daily job, and
// deletion with the account.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ACCOUNT_REPLAY_MAX_BYTES,
  ACCOUNT_REPLAY_RETENTION_MS,
  ACCOUNT_REPLAYS_BYTES_MAX,
  ACCOUNT_REPLAYS_MAX,
  DEFAULT_OPTIONS,
  REPLAY_FORMAT,
  REPLAY_VERSION,
} from '@webra/protocol';
import { Browser, Clock, makeEnv, PASSWORD, promote, scheduled, signup } from './accounts-harness.mjs';
import { drainReplayTrash, REPLAY_UPLOAD_LIMIT, replayFileName } from '../src/accounts/replays.js';
import { DELETED_RETENTION_MS } from '../src/accounts/users.js';

const clock = new Clock();
test.after(() => clock.restore());
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

/** A valid replay file; `n` makes each one different. */
function replay(n = 0, patch = {}) {
  return {
    format: REPLAY_FORMAT,
    version: REPLAY_VERSION,
    kind: 'replay',
    mode: 'online',
    engine: '0.14.0+abcdef12',
    createdAt: 1_760_000_000_000 + n,
    title: `Game ${n}`,
    options: {
      ...DEFAULT_OPTIONS,
      players: [
        { slot: 0, type: 'human', name: 'Tanya', faction: 'germany', color: 2, team: 1 },
        { slot: 1, type: 'human', name: 'Boris', faction: 'russia', color: 0, team: 2 },
        { slot: 2, type: 'ai', difficulty: 'hard', faction: 'ukraine', color: 1, team: 2 },
      ],
    },
    map: null,
    mapHash: null,
    player: 0,
    ticks: 1500,
    frames: [[12, [[0, [{ o: 'stop', player: 0, ids: [3] }]]]]],
    hashes: [[250, '0123456789abcdef']],
    chat: [[20, 1, 'Boris', 'gl hf', 0]],
    ...patch,
  };
}
const text = (r) => JSON.stringify(r);

async function player(env, name) {
  const b = await signup(env, name);
  promote(env, b.user.id);
  return b;
}

const upload = (b, body, result = 'won', opts = {}) => b.req('POST', `/api/account/replays${result ? `?result=${result}` : ''}`, body, opts);

/** Rows of an account straight from D1. */
const rows = (env, userId) => env.DB.rows('SELECT * FROM account_replays WHERE user_id = ? ORDER BY created_at, rowid', userId);

/** Put rows (and their objects) in directly: the limits without a hundred uploads. */
function seed(env, userId, count, { size = 1000, at = Date.now() - HOUR } = {}) {
  const ids = [];
  for (let i = 0; i < count; i++) {
    const id = (0x1000000000000000n + BigInt(i)).toString(16);
    const key = `replays/${userId}/${id}`;
    env.DB.sqlite
      .prepare(
        `INSERT INTO account_replays (id, user_id, r2_key, created_at, expires_at, size, raw_size, content_hash, engine, mode, title, map_name, players, played_at, ticks, result)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, '0.13.0', 'skirmish', ?, 'Generated map', '[]', ?, 100, 'unknown')`,
      )
      .run(id, userId, key, at + i, at + i + ACCOUNT_REPLAY_RETENTION_MS, size, size * 4, String(i).padStart(64, '0'), `Seeded ${i}`, at + i);
    env.REPLAYS.objects.set(key, { bytes: new Uint8Array(1), httpMetadata: {}, customMetadata: {} });
    ids.push(id);
  }
  return ids;
}

test('upload, list, download and delete: the owner gets the same file back, stored gzip', async () => {
  const env = makeEnv({ email: false });
  const b = await player(env, 'Tanya');
  const file = text(replay(1));
  const up = await upload(b, file);
  assert.equal(up.status, 201, JSON.stringify(up.body));
  const r = up.body.replay;
  assert.match(r.id, /^[0-9a-f]{16}$/);
  assert.equal(r.result, 'won');
  assert.equal(r.mode, 'online');
  assert.equal(r.title, 'Game 1');
  assert.equal(r.mapName, 'Generated map');
  assert.equal(r.engine, '0.14.0+abcdef12');
  assert.equal(r.ticks, 1500);
  assert.equal(r.playedAt, 1_760_000_000_001);
  assert.equal(r.rawSize, Buffer.byteLength(file));
  assert.equal(r.expiresAt - r.createdAt, ACCOUNT_REPLAY_RETENTION_MS);
  assert.deepEqual(
    r.players.map((p) => p.name),
    ['Tanya', 'Boris', null],
  );
  assert.equal(up.body.evicted, 0);

  const [key] = env.REPLAYS.keys();
  assert.equal(key, `replays/${b.user.id}/${r.id}`);
  const stored = env.REPLAYS.objects.get(key).bytes;
  assert.deepEqual([...stored.slice(0, 2)], [0x1f, 0x8b], 'a gzip object');
  assert.equal(r.size, stored.byteLength, 'the quota counts what is stored');

  const list = await b.get('/api/account/replays');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.replays, [r]);
  assert.deepEqual(list.body.usage, { count: 1, bytes: r.size });
  assert.deepEqual(list.body.limits, { count: ACCOUNT_REPLAYS_MAX, bytes: ACCOUNT_REPLAYS_BYTES_MAX, retentionMs: ACCOUNT_REPLAY_RETENTION_MS, uploadBytes: ACCOUNT_REPLAY_MAX_BYTES });
  assert.equal(list.body.available, true);

  const dl = await b.get(`/api/account/replays/${r.id}`);
  assert.equal(dl.status, 200);
  assert.equal(JSON.stringify(dl.body), file, 'the file as uploaded');
  assert.match(dl.res.headers.get('content-disposition'), /^attachment; filename="webra-replay-Game-1-2025-10-09-08-53\.json"$/);
  assert.equal(dl.res.headers.get('cache-control'), 'private, no-store');

  assert.equal((await b.del(`/api/account/replays/${r.id}`)).status, 204);
  assert.deepEqual(env.REPLAYS.keys(), [], 'the object went right after');
  assert.deepEqual(env.DB.rows('SELECT * FROM replay_object_trash'), []);
  assert.equal((await b.del(`/api/account/replays/${r.id}`)).status, 404);
  assert.equal((await b.get(`/api/account/replays/${r.id}`)).status, 404);
  assert.deepEqual((await b.get('/api/account/replays')).body.replays, []);
});

test('signed in, active, same origin and the CSRF header; only the owner sees, downloads or deletes', async () => {
  const env = makeEnv({ email: false });
  const owner = await player(env, 'Owner');
  const other = await player(env, 'Other');
  const id = (await upload(owner, text(replay(2)))).body.replay.id;

  const anon = new Browser(env);
  assert.equal((await anon.get('/api/account/replays')).status, 401);
  assert.equal((await upload(anon, text(replay(3)))).status, 401);
  assert.equal((await anon.get(`/api/account/replays/${id}`)).status, 401);
  assert.equal((await anon.del(`/api/account/replays/${id}`)).status, 401);

  assert.equal((await owner.get('/api/account/replays', { csrf: false })).status, 403, 'account reads need the CSRF header');
  assert.equal((await owner.get(`/api/account/replays/${id}`, { csrf: false })).status, 403);
  assert.equal((await upload(owner, text(replay(3)), 'won', { csrf: false })).status, 403);
  assert.equal((await upload(owner, text(replay(3)), 'won', { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await owner.del(`/api/account/replays/${id}`, undefined, { headers: { Origin: null } })).status, 403, 'writes need Origin');

  assert.deepEqual((await other.get('/api/account/replays')).body.replays, []);
  assert.equal((await other.get(`/api/account/replays/${id}`)).status, 404, 'not found, not forbidden: ids are not confirmed');
  assert.equal((await other.del(`/api/account/replays/${id}`)).status, 404);
  assert.equal(rows(env, owner.user.id).length, 1);
  assert.equal((await other.get('/api/account/replays/not-an-id')).status, 404);

  // Waiting for approval: no uploads (nobody plays then), but the list still answers.
  const pending = await signup(env, 'Pending');
  assert.equal((await upload(pending, text(replay(4)))).body.error.code, 'account_inactive');
  assert.equal((await pending.get('/api/account/replays')).status, 200);
});

test('invalid files, saves, the content type, the result and the size cap are refused before anything is stored', async () => {
  const env = makeEnv({ email: false });
  const b = await player(env, 'Checker');
  const refuse = async (body, status, opts, result) => {
    const r = await upload(b, body, result, opts);
    assert.equal(r.status, status, JSON.stringify(r.body));
    return r.body.error;
  };
  assert.match((await refuse('{', 422)).message, /^Invalid replay: the file is not valid JSON\.$/);
  assert.match((await refuse(text({ ...replay(5), frames: [[9999, []]] }), 422)).message, /^Invalid replay/);
  assert.match((await refuse(text({ ...replay(5), extra: 1 }), 422)).message, /unknown field/);
  const save = replay(5, { kind: 'save', mode: 'skirmish', chat: undefined, ticks: 500, hashes: [[250, 'aa'], [500, 'bb']], options: { ...replay(5).options, players: replay(5).options.players.map((p, i) => (i === 1 ? { slot: 1, type: 'ai', difficulty: 'easy', faction: 'russia', color: 0, team: 2 } : p)) } });
  assert.equal((await refuse(text(save), 422)).message, 'This is a saved game, not a replay.');
  assert.equal((await refuse(text(replay(5)), 415, { headers: { 'Content-Type': 'text/plain' } })).code, 'bad_message');
  assert.equal((await refuse(text(replay(5)), 400, {}, 'victory')).field, 'result');
  // Larger than ACCOUNT_REPLAY_MAX_BYTES: refused from Content-Length (and while reading without one).
  const big = text(replay(5, { title: 'Big' })).replace('"title":"Big"', `"title":"Big","pad":"${'x'.repeat(ACCOUNT_REPLAY_MAX_BYTES)}"`);
  assert.equal((await refuse(big, 413)).code, 'too_large');
  assert.deepEqual(rows(env, b.user.id), []);
  assert.deepEqual(env.REPLAYS.keys(), []);
  // Without `result` the game's outcome is unknown.
  assert.equal((await upload(b, text(replay(6)), null)).body.replay.result, 'unknown');
});

test('one copy per file and account: an upload of the same file answers the stored one', async () => {
  const env = makeEnv({ email: false });
  const b = await player(env, 'Twice');
  const first = await upload(b, text(replay(7)));
  const again = await upload(b, text(replay(7)), 'lost');
  assert.equal(again.status, 200);
  assert.equal(again.body.duplicate, true);
  assert.deepEqual(again.body.replay, first.body.replay);
  assert.equal(rows(env, b.user.id).length, 1);
  assert.equal(env.REPLAYS.keys().length, 1);
  // Both at once: one is stored, the other answers it; no object is left behind.
  const [x, y] = await Promise.all([upload(b, text(replay(8))), upload(b, text(replay(8)))]);
  assert.deepEqual([x.status, y.status].sort(), [200, 201]);
  assert.equal(rows(env, b.user.id).length, 2);
  assert.equal(env.REPLAYS.keys().length, 2);
  // Another account keeps its own copy.
  const c = await player(env, 'Other Twice');
  assert.equal((await upload(c, text(replay(7)))).status, 201);
});

test('at most 100 replays per account: the oldest makes room, also for uploads at the same time', async () => {
  const env = makeEnv({ email: false });
  const b = await player(env, 'Collector');
  const ids = seed(env, b.user.id, ACCOUNT_REPLAYS_MAX);
  const up = await upload(b, text(replay(9)));
  assert.equal(up.status, 201);
  assert.equal(up.body.evicted, 1);
  const left = rows(env, b.user.id);
  assert.equal(left.length, ACCOUNT_REPLAYS_MAX);
  assert.equal(left.some((r) => r.id === ids[0]), false, 'the oldest went');
  assert.equal(left.at(-1).id, up.body.replay.id);
  assert.equal(env.REPLAYS.objects.has(`replays/${b.user.id}/${ids[0]}`), false, 'with its object');
  assert.equal(env.REPLAYS.keys().length, ACCOUNT_REPLAYS_MAX);

  const both = await Promise.all([upload(b, text(replay(10))), upload(b, text(replay(11)))]);
  assert.deepEqual(both.map((r) => r.status), [201, 201]);
  assert.equal(rows(env, b.user.id).length, ACCOUNT_REPLAYS_MAX);
  assert.equal(rows(env, b.user.id).some((r) => r.id === ids[2]), false);
  const list = await b.get('/api/account/replays');
  assert.equal(list.body.usage.count, ACCOUNT_REPLAYS_MAX);
  // The two uploads race, so either may be the newest; both lead the list.
  assert.deepEqual(new Set(list.body.replays.slice(0, 2).map((r) => r.title)), new Set(['Game 10', 'Game 11']), 'newest first');
});

test('at most 100 MiB stored per account: the oldest go until the new one fits', async () => {
  const env = makeEnv({ email: false });
  const b = await player(env, 'Hoarder');
  // Ten replays of 10 MiB each fill the account exactly.
  const ids = seed(env, b.user.id, 10, { size: ACCOUNT_REPLAYS_BYTES_MAX / 10 });
  const up = await upload(b, text(replay(12)));
  assert.equal(up.body.evicted, 1);
  const left = rows(env, b.user.id);
  assert.deepEqual(
    left.map((r) => r.id),
    [...ids.slice(1), up.body.replay.id],
  );
  assert.ok(left.reduce((n, r) => n + r.size, 0) <= ACCOUNT_REPLAYS_BYTES_MAX);
});

test('uploads are rate limited per account', async () => {
  const env = makeEnv({ email: false });
  const b = await player(env, 'Spammer');
  for (let i = 0; i < REPLAY_UPLOAD_LIMIT; i++) assert.equal((await upload(b, '{')).status, 422);
  const r = await upload(b, text(replay(13)));
  assert.equal(r.status, 429);
  assert.ok(r.body.error.retryAfter > 0);
  clock.advance(HOUR);
  assert.equal((await upload(b, text(replay(13)))).status, 201);
});

test('a failed object write stores nothing and leaves nothing behind', async () => {
  const env = makeEnv({ email: false });
  const b = await player(env, 'Unlucky');
  env.REPLAYS.failPut = true;
  assert.equal((await upload(b, text(replay(14)))).status, 500);
  assert.deepEqual(rows(env, b.user.id), []);
  assert.deepEqual(env.DB.rows('SELECT * FROM replay_object_trash'), [], 'its queued object was deleted (there was none)');
  env.REPLAYS.failPut = false;
  // A failed delete keeps the object queued; the next run deletes it.
  const id = (await upload(b, text(replay(14)))).body.replay.id;
  env.REPLAYS.failDelete = true;
  assert.equal((await b.del(`/api/account/replays/${id}`)).status, 204);
  assert.equal(env.DB.rows('SELECT * FROM replay_object_trash').length, 1);
  env.REPLAYS.failDelete = false;
  await scheduled(env, Date.now());
  assert.deepEqual(env.REPLAYS.keys(), []);
  assert.deepEqual(env.DB.rows('SELECT * FROM replay_object_trash'), []);
});

test('an upload in progress keeps its object queued but not ready: the cleanup leaves it alone', async () => {
  const env = makeEnv({ email: false });
  env.DB.sqlite.prepare('INSERT INTO replay_object_trash (r2_key, ready_at) VALUES (?, ?)').run('replays/u/pending', Date.now() + HOUR);
  env.REPLAYS.objects.set('replays/u/pending', { bytes: new Uint8Array(1), httpMetadata: {}, customMetadata: {} });
  assert.equal(await drainReplayTrash(env, Date.now()), 0);
  assert.deepEqual(env.REPLAYS.keys(), ['replays/u/pending']);
  // An hour later the upload clearly failed: its object goes.
  assert.equal(await drainReplayTrash(env, Date.now() + HOUR), 1);
  assert.deepEqual(env.REPLAYS.keys(), []);
});

test('the daily job deletes replays 30 days after their upload, with their objects, idempotently', async () => {
  const env = makeEnv({ email: false });
  const b = await player(env, 'Forgetful');
  await upload(b, text(replay(15)));
  clock.advance(10 * DAY);
  const younger = (await upload(b, text(replay(16)))).body.replay;
  clock.advance(20 * DAY - 1);
  await scheduled(env, Date.now());
  assert.equal(rows(env, b.user.id).length, 2, 'not yet');
  clock.advance(1);
  // Expired rows are gone for the player at once, before the job runs (signed in again: 30 days idle ended the session).
  assert.equal((await b.post('/api/auth/login', { login: 'forgetful', password: PASSWORD })).status, 200);
  assert.deepEqual((await b.get('/api/account/replays')).body.replays.map((r) => r.id), [younger.id]);
  await scheduled(env, Date.now());
  assert.deepEqual(rows(env, b.user.id).map((r) => r.id), [younger.id]);
  assert.deepEqual(env.REPLAYS.keys(), [`replays/${b.user.id}/${younger.id}`]);
  await scheduled(env, Date.now());
  assert.equal(rows(env, b.user.id).length, 1, 'a second run changes nothing');
  clock.advance(10 * DAY);
  await scheduled(env, Date.now());
  assert.deepEqual(rows(env, b.user.id), []);
  assert.deepEqual(env.REPLAYS.keys(), []);
  assert.deepEqual(env.DB.rows('SELECT * FROM replay_object_trash'), []);
});

test('the daily job expires many replays in batches', async () => {
  const env = makeEnv({ email: false });
  const b = await player(env, 'Many');
  seed(env, b.user.id, 1200, { at: Date.now() - ACCOUNT_REPLAY_RETENTION_MS - DAY });
  const { runRetention } = await import('../src/accounts/cron.js');
  const out = await runRetention(env, Date.now());
  assert.equal(out.replays, 1200);
  assert.equal(out.replayObjects, 1200);
  assert.deepEqual(env.REPLAYS.keys(), []);
});

test('deleting the account deletes its replays and their objects at once; a purge catches any left', async () => {
  const env = makeEnv({ email: false });
  const b = await player(env, 'Leaving');
  const keep = await player(env, 'Staying');
  await upload(b, text(replay(17)));
  await upload(b, text(replay(18)));
  await upload(keep, text(replay(17)));
  await b.post('/api/auth/reauth', { password: PASSWORD });
  assert.equal((await b.del('/api/account', { confirm: 'Leaving' })).status, 204);
  assert.deepEqual(rows(env, b.user.id), []);
  assert.deepEqual(env.REPLAYS.keys(`replays/${b.user.id}/`), []);
  assert.equal(env.REPLAYS.keys(`replays/${keep.user.id}/`).length, 1, 'other accounts keep theirs');

  // A row that slipped in after the deletion goes with the purge 30 days later (the cascade queues its object).
  seed(env, b.user.id, 1);
  clock.advance(DELETED_RETENTION_MS + DAY);
  await scheduled(env, Date.now());
  assert.equal(env.DB.rows('SELECT id FROM users WHERE id = ?', b.user.id).length, 0, 'purged');
  assert.deepEqual(env.REPLAYS.keys(`replays/${b.user.id}/`), []);
});

test('an admin deleting an account deletes its replays too', async () => {
  const env = makeEnv({ email: false });
  const admin = await player(env, 'Boss');
  promote(env, admin.user.id, 'admin');
  const b = await player(env, 'Removed');
  await upload(b, text(replay(19)));
  assert.equal((await admin.del(`/api/admin/users/${b.user.id}`)).status, 200);
  assert.deepEqual(rows(env, b.user.id), []);
  assert.deepEqual(env.REPLAYS.keys(), []);
});

test('the data export lists the replays', async () => {
  const env = makeEnv({ email: false });
  const b = await player(env, 'Exporter');
  const r = (await upload(b, text(replay(20)))).body.replay;
  await b.post('/api/auth/reauth', { password: PASSWORD });
  const out = await b.get('/api/account/export');
  assert.deepEqual(out.body.replays, [r]);
});

test('without the bucket: no uploads or downloads, the list says so', async () => {
  const env = makeEnv({ email: false, replays: false });
  const b = await player(env, 'Nobucket');
  const up = await upload(b, text(replay(21)));
  assert.equal(up.status, 503);
  assert.equal(up.body.error.code, 'unavailable');
  const list = await b.get('/api/account/replays');
  assert.equal(list.body.available, false);
  assert.deepEqual(list.body.replays, []);
});

test('wrangler.jsonc binds the bucket the deploy creates', () => {
  const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
  assert.deepEqual(config.r2_buckets, [{ binding: 'REPLAYS', bucket_name: 'webra-replays' }]);
  const deploy = readFileSync(new URL('../../../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  const step = deploy.indexOf('bucket=webra-replays');
  assert.ok(step > 0, 'the deploy creates the bucket');
  assert.ok(step < deploy.indexOf('- name: Deploy the Worker'), 'before the Worker deploys');
  assert.match(deploy, /wrangler r2 bucket create "\$bucket"/);
  assert.match(deploy, /already exists/, 'an existing bucket is not an error');
});

test('a start time outside the Date range is refused; a stored one never breaks the download name', async () => {
  const env = makeEnv({ email: false });
  const b = await player(env, 'Timeless');
  const r = await upload(b, text(replay(30, { createdAt: Number.MAX_SAFE_INTEGER })));
  assert.equal(r.status, 422);
  assert.match(r.body.error.message, /createdAt/);
  assert.equal(replayFileName({ played_at: 9e15, title: 'Far future' }), 'webra-replay-Far-future-undated.json');
  assert.equal(replayFileName({ played_at: 0, title: '' }), 'webra-replay-game-1970-01-01-00-00.json');
});

test('sizes and the checksum come from the uploaded bytes (multi-byte text counted as UTF-8)', async () => {
  const env = makeEnv({ email: false });
  const b = await player(env, 'Bytes');
  const file = text(replay(31, { title: 'Ölfeld 戦い' }));
  const r = (await upload(b, file)).body.replay;
  assert.equal(r.rawSize, Buffer.byteLength(file, 'utf8'));
  const { createHash } = await import('node:crypto');
  assert.equal(rows(env, b.user.id)[0].content_hash, createHash('sha256').update(file, 'utf8').digest('hex'));
  assert.equal(JSON.stringify((await b.get(`/api/account/replays/${r.id}`)).body), file);
});

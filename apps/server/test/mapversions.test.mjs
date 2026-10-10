// Map versions on the server (docs/contracts.md section 2, "Map versions"):
// uploads of every format version (upgraded before they are hashed and
// stored, refused with the message players see), the rows stored before a
// format change (upgraded when read, old hashes and ids still resolvable,
// merged when the upgrade meets a map that is already stored, marked when
// they cannot be upgraded), the community list and the daily job.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { canonicalMapJson, MAP_FORMAT_VERSION, MAP_VERSIONS, parseMap, renameActors, upgradeMap } from '@webra/protocol';
import { testVersions, v1Map } from '../../../packages/protocol/test/fixtures/map-test-versions.mjs';
import { FakeD1 } from './fake-d1.mjs';
import { HttpError } from '../src/http.js';
import { getMap, listMaps, LIST_UPGRADE_BATCH, lookupMap, MAP_UPGRADE_UNAVAILABLE, mapTextByHash, prepareMap, storeMap, upgradeAttempt, upgradeStaleMaps, upgradeStoredMap } from '../src/maps.js';
import { runRetention } from '../src/accounts/cron.js';

const fixture = (name) => readFileSync(new URL(`../../../packages/protocol/test/fixtures/maps/${name}`, import.meta.url), 'utf8');
const sha = (s) => createHash('sha256').update(s).digest('hex');
const exec = { waitUntil: (p) => p?.catch?.(() => {}) };

/** The engine's verdict for maps of the test registry (the real engine reads format 1 only). */
const judge = {
  calls: 0,
  validateMap(canonical) {
    this.calls++;
    const r = parseMap(canonical, { upgrade: false, versions: testVersions() });
    return { ok: r.ok, errors: r.errors, modded: r.ok && r.modded, hash: r.ok ? sha(canonical) : null };
  },
};
/** Format 2 only (one step of the test registry), for chains of upgrades. */
const V2 = { ...testVersions(), current: 2, history: testVersions().history.slice(0, 2), migrations: testVersions().migrations.slice(0, 1) };

const rejects422 = (promise, message) => assert.rejects(promise, (e) => e instanceof HttpError && e.status === 422 && e.message === message, message);

// ---- Uploads ----------------------------------------------------------------------------------

test('uploads: a file from before map versions and its versioned form are one map; a newer format is refused', async () => {
  const legacy = await prepareMap(fixture('format1-legacy.webra-map.json'));
  const file = await prepareMap(fixture('format1-file.webra-map.json'));
  const expected = JSON.parse(fixture('format1-legacy.expected.json'));
  assert.equal(legacy.hash, expected.hash, 'stored as the upgraded map the protocol pinned');
  assert.equal(file.hash, legacy.hash);
  assert.equal(file.canonical, expected.canonical, 'stored upgraded, without gameVersion');
  assert.deepEqual([legacy.formatVersion, legacy.upgradedFrom], [MAP_FORMAT_VERSION, 1]);
  const db = new FakeD1();
  const a = await storeMap(db, legacy, { listed: true });
  const b = await storeMap(db, file, { listed: true });
  assert.equal(b.id, a.id, 'deduplicated');
  assert.deepEqual(db.rows('SELECT format_version, upgrade_error FROM maps'), [{ format_version: MAP_FORMAT_VERSION, upgrade_error: null }]);

  const newer = JSON.stringify({ ...JSON.parse(fixture('format1-file.webra-map.json')), formatVersion: MAP_FORMAT_VERSION + 1, gameVersion: '3.4.5' });
  await rejects422(
    prepareMap(newer),
    `This map was made with a newer version of WebRA (3.4, format ${MAP_FORMAT_VERSION + 1}; this version reads format ${MAP_FORMAT_VERSION}). Update the game to play it.`,
  );
  // Saved games keep their map as played: never upgraded.
  await assert.rejects(prepareMap(newer, undefined, { upgrade: false }), (e) => e.status === 422);
});

test('uploads of an older format are upgraded before they are validated, hashed and stored', async () => {
  const versions = testVersions();
  const p = await prepareMap(JSON.stringify(v1Map()), judge, { versions });
  const upgraded = canonicalMapJson(upgradeMap(v1Map(), versions).map);
  assert.equal(p.canonical, upgraded);
  assert.equal(p.hash, sha(upgraded));
  assert.deepEqual([p.formatVersion, p.upgradedFrom], [3, 1]);
  await rejects422(
    prepareMap(JSON.stringify(v1Map({ gameVersion: '0.7.2', actors: [{ type: 'GONE', owner: -1, x: 3, y: 9 }] })), judge, { versions }),
    'This map was made for WebRA 0.7 (format 1) and is no longer compatible with this version. Open it in the map editor and save it again.',
  );
  // Upgraded, then refused by the engine: no longer compatible (with the engine's reason).
  const refuse = { validateMap: () => ({ ok: false, errors: ['spawn 2 cannot be reached from spawn 1 by ground'], modded: false, hash: null }) };
  await rejects422(
    prepareMap(JSON.stringify(v1Map()), refuse, { versions }),
    'This map was made for WebRA 0.9 (format 1) and is no longer compatible with this version. Open it in the map editor and save it again. (spawn 2 cannot be reached from spawn 1 by ground)',
  );
});

// ---- Rows stored before a format change -----------------------------------------------------------

let nextId = 0;
/**
 * A format 1 row of the test registry, as the release before the format
 * change stored it: its canonical text (format 1 knew `notes` and the
 * `arctic` biome, so this release cannot store such a row itself).
 */
async function storeV1(db, extra = {}, { listed = true, now = Date.now() } = {}) {
  const map = v1Map(extra);
  const json = JSON.stringify(map);
  const id = (nextId++).toString(16).padStart(16, '0');
  db.sqlite
    .prepare(
      `INSERT INTO maps (id, name, author, players, width, height, hash, modded, json, downloads, created_at, listed, used_at, format_version)
       VALUES (?, ?, ?, 2, 32, 32, ?, ?, ?, 0, ?, ?, ?, 1)`,
    )
    .run(id, map.name, map.author, sha(json), map.rules ? 1 : 0, json, now, listed ? 1 : 0, listed ? null : now);
  return { p: { hash: sha(json), canonical: json }, row: { id } };
}

test('a stored row of an older format is upgraded in place when it is read; its old hash still finds it', async () => {
  const versions = testVersions();
  const db = new FakeD1();
  const { p, row } = await storeV1(db, { name: 'Bay' });
  assert.deepEqual(db.rows('SELECT format_version FROM maps'), [{ format_version: 1 }]);
  const upgraded = canonicalMapJson(upgradeMap(v1Map({ name: 'Bay' }), versions).map);

  // A host picks it by id and the hash it knew: the lobby gets the upgraded map.
  const summary = await lookupMap(db, row.id, p.hash, { judge, versions });
  assert.equal(summary.id, row.id, 'same id');
  assert.equal(summary.hash, sha(upgraded));
  assert.deepEqual(db.rows('SELECT format_version, hash, json FROM maps'), [{ format_version: 3, hash: sha(upgraded), json: upgraded }]);
  assert.deepEqual(db.rows('SELECT old_hash, old_id, hash FROM map_aliases'), [{ old_hash: p.hash, old_id: row.id, hash: sha(upgraded) }]);
  // Upgraded once: later reads do not run the engine again.
  const calls = judge.calls;
  assert.equal((await lookupMap(db, row.id, sha(upgraded), { judge, versions })).hash, sha(upgraded));
  assert.equal((await lookupMap(db, row.id, p.hash, { judge, versions })).hash, sha(upgraded), 'the old hash still matches');
  assert.equal(await lookupMap(db, row.id, 'e'.repeat(64), { judge, versions }), null, 'another hash does not');
  assert.equal(judge.calls, calls);
  // Downloads by id and by either hash serve the upgraded map.
  const res = await getMap({ DB: db }, exec, row.id, { judge, versions });
  assert.equal(await res.text(), upgraded);
  assert.equal(await mapTextByHash(db, p.hash, Date.now(), { judge, versions }), upgraded);
  assert.equal(await mapTextByHash(db, sha(upgraded), Date.now(), { judge, versions }), upgraded);
  // Unlisted maps still cannot be picked by id.
  const shared = await storeV1(db, { name: 'Hidden' }, { listed: false });
  assert.equal(await lookupMap(db, shared.row.id, shared.p.hash, { judge, versions }), null);
});

test('the community list upgrades stale rows first and leaves out what is not upgraded yet or cannot be', async () => {
  const versions = testVersions();
  const db = new FakeD1();
  const rows = [];
  for (let i = 0; i < LIST_UPGRADE_BATCH + 2; i++) rows.push(await storeV1(db, { name: `Map ${i}`, rules: null }, { listed: true, now: 1000 + i }));
  const broken = await storeV1(db, { name: 'Broken', actors: [{ type: 'GONE', owner: -1, x: 3, y: 9 }] }, { listed: true, now: 5000 });
  const list = await (await listMaps({ DB: db }, { judge, versions })).json();
  // Newest first: the broken map takes one place of the batch (and is marked), the oldest two wait.
  assert.equal(list.length, LIST_UPGRADE_BATCH - 1, 'one batch per request; the rest waits');
  for (const m of list) assert.equal(m.hash, db.rows('SELECT hash FROM maps WHERE id = ?', m.id)[0].hash);
  assert.ok(list.every((m) => db.rows('SELECT format_version FROM maps WHERE id = ?', m.id)[0].format_version === 3));
  const again = await (await listMaps({ DB: db }, { judge, versions })).json();
  assert.equal(again.length, LIST_UPGRADE_BATCH + 2, 'the next request upgrades the rest');
  assert.ok(!again.some((m) => m.name === 'Broken'), 'a map that cannot be upgraded leaves the list');
  const [mark] = db.rows('SELECT upgrade_error, format_version, json FROM maps WHERE id = ?', broken.row.id);
  assert.match(mark.upgrade_error, /^This map was made for WebRA 0\.9 \(format 1\) and is no longer compatible/);
  assert.equal(mark.format_version, 1);
  // Its file is still served as stored (clients say why it does not load; the editor repairs it) ...
  assert.equal(await (await getMap({ DB: db }, exec, broken.row.id, { judge, versions })).text(), mark.json);
  // ... but a lobby refuses it with the message.
  assert.deepEqual(await lookupMap(db, broken.row.id, broken.p.hash, { judge, versions }), { refused: mark.upgrade_error });
  // Not tried again.
  const calls = judge.calls;
  assert.deepEqual(await upgradeStaleMaps(db, { judge, versions, limit: 10 }), { upgraded: 0, failed: 0, skipped: 0 });
  assert.equal(judge.calls, calls);
});

test('an upgrade that meets a map already stored merges into it; its old id and hash still find it', async () => {
  const versions = testVersions();
  const db = new FakeD1();
  const old = await storeV1(db, { name: 'Twin' }, { listed: false });
  db.sqlite.prepare('UPDATE maps SET downloads = 4 WHERE id = ?').run(old.row.id);
  // The same map, uploaded again after the format change (so stored upgraded already), listed.
  const fresh = await prepareMap(JSON.stringify(v1Map({ name: 'Twin' })), judge, { versions });
  const kept = await storeMap(db, fresh, { listed: true });
  const row = db.rows('SELECT * FROM maps WHERE id = ?', old.row.id)[0];
  const after = await upgradeStoredMap(db, row, { judge, versions });
  assert.equal(after.id, kept.id);
  assert.deepEqual(db.rows('SELECT id, listed, downloads FROM maps'), [{ id: kept.id, listed: 1, downloads: 4 }]);
  assert.deepEqual(db.rows('SELECT old_hash, old_id, hash FROM map_aliases'), [{ old_hash: old.p.hash, old_id: old.row.id, hash: fresh.hash }]);
  assert.equal(await mapTextByHash(db, old.p.hash, Date.now(), { judge, versions }), fresh.canonical);
  assert.equal(await (await getMap({ DB: db }, exec, old.row.id, { judge, versions })).text(), fresh.canonical, 'the old id too');
});

test('two format changes in a row: every old hash points at the map as it is now; the daily job prunes and upgrades', async () => {
  const db = new FakeD1();
  // Valid at format 2 as well (no `notes`, a biome format 2 knows).
  const { p: p1, row } = await storeV1(db, { name: 'Chain', notes: undefined, biome: 'snow' });
  const judge2 = { validateMap: (c) => ({ ok: true, errors: [], modded: parseMap(c, { versions: V2 }).modded, hash: sha(c) }) };
  const r2 = await upgradeStoredMap(db, db.rows('SELECT * FROM maps')[0], { judge: judge2, versions: V2 });
  assert.equal(r2.upgrade_error, null);
  assert.equal(r2.format_version, 2);
  const r3 = await upgradeStoredMap(db, db.rows('SELECT * FROM maps')[0], { judge, versions: testVersions() });
  assert.equal(r3.format_version, 3);
  assert.notEqual(r3.hash, r2.hash, 'a format above 1 is part of the identity');
  assert.equal(r3.id, row.id);
  assert.deepEqual(
    db.rows('SELECT old_hash, hash FROM map_aliases ORDER BY created_at, old_hash').map((a) => [a.old_hash, a.hash]).sort(),
    [
      [p1.hash, r3.hash],
      [r2.hash, r3.hash],
    ].sort(),
  );
  // Current rows are left alone: no engine, no write.
  const current = db.rows('SELECT * FROM maps')[0];
  const writes = db.writes;
  assert.equal(await upgradeStoredMap(db, current, { judge: null, versions: testVersions() }), current);
  assert.equal(db.writes, writes);

  // The daily job: aliases of maps that are gone go too; with nothing stale it never loads the engine.
  db.sqlite.prepare("INSERT INTO map_aliases (old_hash, old_id, hash, created_at) VALUES (?, 'dead', ?, 1)").run('d'.repeat(64), 'f'.repeat(64));
  const out = await runRetention({ DB: db }, Date.now());
  assert.equal(out.mapAliases, 1);
  assert.deepEqual(out.mapUpgrades, { upgraded: 0, failed: 0, skipped: 0 }, `no stale rows at format ${MAP_VERSIONS.current}`);
  assert.equal(db.rows('SELECT COUNT(*) AS n FROM map_aliases')[0].n, 2);
});

// ---- Failures, order, races and retries ---------------------------------------------------------

/** Run `fn` with console.error collected (the upgrade logs what it skips). */
async function quietly(fn) {
  const error = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a.join(' '));
  try {
    return { value: await fn(), logged };
  } finally {
    console.error = error;
  }
}

test('one row that fails for another reason never breaks the list, the daily batch or a download', async () => {
  const versions = testVersions();
  const db = new FakeD1();
  const good = await storeV1(db, { name: 'Good', rules: null }, { now: 1 });
  const bad = await storeV1(db, { name: 'Trap', rules: null }, { now: 2 });
  // The engine trips over one map (an identity mismatch answers 500), every time.
  const flaky = {
    validateMap(canonical) {
      const v = judge.validateMap(canonical);
      return canonical.includes('"Trap"') ? { ...v, hash: 'f'.repeat(64) } : v;
    },
  };
  const { value: list, logged } = await quietly(async () => (await listMaps({ DB: db }, { judge: flaky, versions })).json());
  assert.deepEqual(list.map((m) => m.name), ['Good'], 'the rest is listed');
  assert.match(logged.join('\n'), /map upgrade failed/);
  const [row] = db.rows('SELECT format_version, upgrade_error FROM maps WHERE id = ?', bad.row.id);
  assert.deepEqual(row, { format_version: 1, upgrade_error: null }, 'not marked: it may work next time');
  const { value: batch } = await quietly(() => upgradeStaleMaps(db, { judge: flaky, versions, limit: 10 }));
  assert.deepEqual(batch, { upgraded: 0, failed: 0, skipped: 1 });
  // A download serves the stored text; a lobby refuses it for now.
  const { value: res } = await quietly(() => getMap({ DB: db }, exec, bad.row.id, { judge: flaky, versions }));
  assert.equal(await res.text(), bad.p.canonical);
  const { value: refused } = await quietly(() => lookupMap(db, bad.row.id, bad.p.hash, { judge: flaky, versions }));
  assert.deepEqual(refused, { refused: MAP_UPGRADE_UNAVAILABLE });
  // A database that fails once mid-upgrade: the list still answers, the next request upgrades.
  const shaky = Object.create(db);
  let fail = true;
  shaky.batch = async (steps) => {
    if (fail) {
      fail = false;
      throw new Error('D1_ERROR: network connection lost');
    }
    return db.batch(steps);
  };
  const { value: first } = await quietly(async () => (await listMaps({ DB: shaky }, { judge, versions })).json());
  assert.ok(first.length >= 1);
  const second = await (await listMaps({ DB: shaky }, { judge, versions })).json();
  assert.deepEqual(second.map((m) => m.name).sort(), ['Good', 'Trap']);
  assert.ok(good.row.id);
  // Even a failing query in the upgrade pass leaves the list working.
  const broken = Object.create(db);
  broken.prepare = (sql) => (/format_version < \?1/.test(sql) ? { bind: () => ({ all: async () => Promise.reject(new Error('D1_ERROR')) }) } : db.prepare(sql));
  const { value: third } = await quietly(async () => (await listMaps({ DB: broken }, { judge, versions })).json());
  assert.equal(third.length, 2);
});

test('the list upgrades the rows it shows first: the newest', async () => {
  const versions = testVersions();
  const db = new FakeD1();
  for (let i = 0; i < LIST_UPGRADE_BATCH + 3; i++) await storeV1(db, { name: `Map ${i}`, rules: null }, { now: 1000 + i });
  const list = await (await listMaps({ DB: db }, { judge, versions })).json();
  assert.deepEqual(
    list.map((m) => m.name),
    Array.from({ length: LIST_UPGRADE_BATCH }, (_, i) => `Map ${LIST_UPGRADE_BATCH + 2 - i}`),
  );
});

test('concurrent upgrades: nothing counts twice, a hash clash merges, the listed row keeps its uploader', async () => {
  const versions = testVersions();
  const db = new FakeD1();
  db.sqlite.exec(
    `INSERT INTO users (id, username, username_key, display_name, avatar_color, status, user_handle, created_at)
     VALUES ('u-listed', 'Listed', 'listed', 'Listed', '#fff', 'active', 'h1', 1), ('u-shared', 'Shared', 'shared', 'Shared', '#fff', 'active', 'h2', 1)`,
  );
  // Two stale rows that upgrade to the same map (format 3 moves `notes` to `description`).
  const a = await storeV1(db, { name: 'Same', notes: 'one' }, { listed: false });
  const b = await storeV1(db, { name: 'Same', notes: undefined, description: 'one' }, { listed: true });
  db.sqlite.prepare("UPDATE maps SET downloads = 3, uploader_id = 'u-shared' WHERE id = ?").run(a.row.id);
  db.sqlite.prepare("UPDATE maps SET downloads = 5, uploader_id = 'u-listed' WHERE id = ?").run(b.row.id);
  const rowA = db.rows('SELECT * FROM maps WHERE id = ?', a.row.id)[0];
  const rowB = db.rows('SELECT * FROM maps WHERE id = ?', b.row.id)[0];
  assert.notEqual(rowA.hash, rowB.hash);
  // Both in flight at once: neither writes before both looked for an existing row with the new
  // hash, so one rewrites in place and the other meets UNIQUE(hash), retries and merges.
  const racing = Object.create(db);
  let looked = 0;
  let bothLooked;
  const barrier = new Promise((resolve) => (bothLooked = resolve));
  racing.prepare = (sql) => {
    const st = db.prepare(sql);
    if (!sql.startsWith('SELECT id FROM maps WHERE hash')) return st;
    return { bind: (...a) => ({ first: async () => {
      const r = await st.bind(...a).first();
      if (++looked === 2) bothLooked();
      return r;
    } }) };
  };
  let batches = 0;
  racing.batch = async (steps) => {
    if (batches++ < 2) await barrier;
    return db.batch(steps);
  };
  const [ra, rb] = await Promise.all([upgradeStoredMap(racing, rowA, { judge, versions }), upgradeStoredMap(racing, rowB, { judge, versions })]);
  assert.equal(batches, 3, 'the second writer clashed and retried');
  assert.equal(ra.id, rb.id);
  const rows = db.rows('SELECT id, listed, downloads, uploader_id, format_version FROM maps');
  assert.equal(rows.length, 1);
  assert.deepEqual({ ...rows[0], id: undefined }, { id: undefined, listed: 1, downloads: 8, uploader_id: 'u-listed', format_version: 3 });
  assert.equal(db.rows('SELECT COUNT(*) AS n FROM map_aliases')[0].n, 2);
  // A stale snapshot upgraded again (a second request with the old row): no change, nothing doubled.
  await upgradeStoredMap(db, rowA, { judge, versions });
  await upgradeStoredMap(db, rowB, { judge, versions });
  assert.deepEqual(db.rows('SELECT downloads FROM maps'), [{ downloads: 8 }]);
});

test('a map that could not be upgraded is tried again by a later format or release, not by the same one', async () => {
  const versions = testVersions();
  const db = new FakeD1();
  const gone = await storeV1(db, { name: 'Gone', actors: [{ type: 'GONE', owner: -1, x: 3, y: 9 }] });
  await upgradeStaleMaps(db, { judge, versions, limit: 5 });
  assert.equal(db.rows('SELECT upgrade_tried FROM maps')[0].upgrade_tried, upgradeAttempt(versions));
  assert.deepEqual(await upgradeStaleMaps(db, { judge, versions, limit: 5 }), { upgraded: 0, failed: 0, skipped: 0 });
  // A later release learned to migrate it (GONE became A1).
  const later = testVersions();
  later.migrations = later.migrations.map((m) =>
    m.from === 1
      ? { ...m, migrate(map, ctx) {
          renameActors(map, { GONE: 'A1' }, ctx);
          return m.migrate(map, ctx);
        } }
      : m,
  );
  db.sqlite.prepare("UPDATE maps SET upgrade_tried = '3/0.0.1' WHERE id = ?").run(gone.row.id);
  assert.deepEqual(await upgradeStaleMaps(db, { judge, versions: later, limit: 5 }), { upgraded: 1, failed: 0, skipped: 0 });
  assert.deepEqual(db.rows('SELECT format_version, upgrade_error, upgrade_tried FROM maps'), [{ format_version: 3, upgrade_error: null, upgrade_tried: null }]);
  const list = await (await listMaps({ DB: db }, { judge, versions: later })).json();
  assert.deepEqual(list.map((m) => m.name), ['Gone'], 'back in the list');
});

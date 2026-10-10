import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonicalMapJson, GAME_VERSION, MAP_FORMAT_VERSION, parseMap, upgradeMap } from '../packages/protocol/src/index.js';
import { testVersions, v1Map } from '../packages/protocol/test/fixtures/map-test-versions.mjs';
import { loadJudge, upgradeFile, upgradeMapFiles } from './map-upgrade.mjs';

const fixture = (name) => readFileSync(new URL(`../packages/protocol/test/fixtures/maps/${name}`, import.meta.url), 'utf8');
const sha = (s) => createHash('sha256').update(s).digest('hex');
/** The engine's verdict for maps of the test registry (the real engine reads format 1 only). */
const judge = { validateMap: (c) => ({ ok: true, errors: [], modded: false, hash: sha(c) }) };

function scratch(files) {
  const dir = mkdtempSync(join(tmpdir(), 'map-upgrade-'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

test('map-upgrade: upgrades old files, stamps files from before versions, leaves current ones and lists what needs an author', () => {
  const versions = testVersions();
  const dir = scratch({
    'old.webra-map.json': JSON.stringify(v1Map()),
    'gone.webra-map.json': JSON.stringify(v1Map({ gameVersion: '0.8.0', actors: [{ type: 'MIX', owner: -1, x: 4, y: 9 }, { type: 'MIX', owner: -1, x: 6, y: 9 }] })),
    'newer.webra-map.json': JSON.stringify({ ...v1Map(), formatVersion: 7 }),
    'broken.webra-map.json': '{"formatVersion":',
  });
  const files = ['old', 'gone', 'newer', 'broken'].map((n) => join(dir, `${n}.webra-map.json`));
  try {
    const lines = [];
    const before = files.map((f) => readFileSync(f, 'utf8'));
    const checked = upgradeMapFiles(files, { check: true, versions, judge, log: (l) => lines.push(l) });
    assert.deepEqual(files.map((f) => readFileSync(f, 'utf8')), before, '--check writes nothing');
    assert.deepEqual(checked.written, [files[0]]);
    assert.deepEqual(checked.failed, files.slice(1));
    const report = lines.join('\n');
    assert.match(report, /would change .*old\.webra-map\.json\n {13}upgraded from format 1 to 3\n {13}- Renamed 1 actor from oldtree to T01\./);
    assert.match(
      report,
      /incompatible .*gone\.webra-map\.json\n {13}This map was made for WebRA 0\.8 \(format 1\) and is no longer compatible with this version\. Open it in the map editor and save it again\.\n {13}- 2 MIX actors: MIX was replaced by A1 or A2 in format 2; pick one\. At 4,9 \(and 1 more\)\.\n {13} {2}quick fixes in the map editor: Replace with A1; Replace with A2; Remove all 2/,
    );
    assert.match(report, /newer {7} .*newer\.webra-map\.json\n {13}This map was made with a newer version of WebRA \(format 7; this version reads format 3\)\. Update the game to play it\./);
    assert.match(report, /invalid {5} .*broken\.webra-map\.json\n {13}not valid JSON/);
    assert.match(lines.at(-1), /^4 files: 1 to change, 0 current, 3 failed$/);

    // For real: the old file becomes the upgraded map as a current file; the others stay as they were.
    upgradeMapFiles(files, { versions, judge, log: () => {} });
    const written = readFileSync(files[0], 'utf8');
    const expected = upgradeMap(v1Map(), versions).map;
    assert.equal(written, `{"formatVersion":3,"gameVersion":"${GAME_VERSION}",${canonicalMapJson(expected).slice('{"formatVersion":3,'.length)}`);
    assert.deepEqual(files.slice(1).map((f) => readFileSync(f, 'utf8')), before.slice(1));
    // Running it again finds nothing to do.
    const again = upgradeMapFiles([files[0]], { check: true, versions, judge, log: () => {} });
    assert.deepEqual(again.current, [files[0]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('map-upgrade: with the real format and engine, format 1 files are upgraded to format 2; current files stay', async () => {
  const judgeReal = await loadJudge();
  assert.ok(judgeReal, 'the engine is built (npm run build:wasm)');
  const legacy = fixture('format1-legacy.webra-map.json');
  const r = upgradeFile(legacy, { judge: judgeReal });
  assert.equal(r.status, 'written');
  assert.deepEqual(r.lines, [
    `upgraded from format 1 to ${MAP_FORMAT_VERSION}`,
    '- Added players ([]).',
    '- Added options ({}).',
    '- Added lockedOptions ([]).',
    '- Added tags ([]).',
  ]);
  assert.equal(parseMap(r.text).canonical, JSON.parse(fixture('format1-legacy.expected.json')).canonical, 'the map the protocol pinned');
  assert.ok(r.text.startsWith(`{"formatVersion":${MAP_FORMAT_VERSION},"gameVersion":"${GAME_VERSION}",`));
  assert.equal(upgradeFile(fixture('format1-file.webra-map.json'), { judge: judgeReal }).status, 'written');
  assert.equal(upgradeFile(fixture('format2-setup.webra-map.json'), { judge: judgeReal }).status, 'current');
  // The engine's checks run: a map it refuses is reported with its reasons.
  const bad = JSON.parse(fixture('format2-setup.webra-map.json'));
  bad.actors.push({ type: 'NOPE', owner: -1, x: 1, y: 1, facing: 0 });
  assert.deepEqual(upgradeFile(JSON.stringify(bad), { judge: judgeReal }), { status: 'invalid', lines: ['unknown actor type NOPE'] });
});

test('map-upgrade: the command line', () => {
  const dir = scratch({ 'a.webra-map.json': fixture('format1-legacy.webra-map.json') });
  const out = join(dir, 'out');
  const tool = fileURLToPath(new URL('./map-upgrade.mjs', import.meta.url));
  try {
    const run = (...args) => {
      try {
        return { code: 0, stdout: execFileSync(process.execPath, [tool, ...args], { encoding: 'utf8' }) };
      } catch (err) {
        return { code: err.status, stdout: String(err.stdout), stderr: String(err.stderr) };
      }
    };
    assert.equal(run().code, 2);
    assert.match(run('--bogus', 'x').stderr, /usage: node tools\/map-upgrade\.mjs/);
    const check = run('--check', join(dir, 'a.webra-map.json'));
    assert.equal(check.code, 1, 'work to do');
    const wrote = run('--out', out, join(dir, 'a.webra-map.json'));
    assert.equal(wrote.code, 0, wrote.stdout);
    assert.match(wrote.stdout, /1 file: 1 written, 0 current, 0 failed/);
    assert.equal(run('--check', join(out, 'a.webra-map.json')).code, 0, 'the result is current');
    assert.equal(readFileSync(join(dir, 'a.webra-map.json'), 'utf8'), fixture('format1-legacy.webra-map.json'), '--out leaves the original');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

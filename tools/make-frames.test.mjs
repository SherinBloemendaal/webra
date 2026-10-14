// tools/make-frames.mjs on synthetic files: frame counts of make files in
// MIX archives and loose files, nothing else. No Electronic Arts file is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { countMakeFrames, makeFiles } from './make-frames.mjs';
import { buildShp, testFrame } from '../apps/game/tests/content-fixtures.mjs';
import { buildMix } from '../apps/game/tests/audio-fixtures.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const shp = (n) => buildShp(8, 6, Array.from({ length: n }, (_, k) => testFrame(8, 6, k + 1)));

test('make-frames knows the make files of the structures and their theater variants', () => {
  const files = makeFiles();
  for (const f of ['weapmake.shp', 'factmake.shp', 'mslomake.tem', 'mslomake.sno', 'mslomake.des', 'tentmake.tem']) assert.ok(files.has(f), f);
  assert.ok(![...files].some((f) => !/make\.(shp|tem|sno|des|int)$/.test(f)), 'make files only');
});

test('make-frames counts the frames of make files in archives and loose files', async () => {
  const mix = buildMix([
    { name: 'weapmake.shp', data: shp(15) },
    { name: 'weap.shp', data: shp(4) },
    { name: 'nested.mix', data: buildMix([{ name: 'powrmake.shp', data: shp(13) }]) },
  ]);
  const counts = await countMakeFrames([
    { name: 'conquer.mix', bytes: mix },
    { name: 'mslomake.tem', bytes: shp(7) },
    { name: 'readme.txt', bytes: new Uint8Array([1, 2, 3]) },
  ]);
  assert.deepEqual([...counts.entries()], [['mslomake.tem', 7], ['weapmake.shp', 15]]);
  // The first copy of a file wins.
  const again = await countMakeFrames([{ name: 'weapmake.shp', bytes: shp(3) }, { name: 'conquer.mix', bytes: mix }]);
  assert.equal(again.get('weapmake.shp'), 3);
});

test('the command prints file names and frame counts only and writes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'make-frames-'));
  try {
    writeFileSync(join(dir, 'conquer.mix'), buildMix([{ name: 'factmake.shp', data: shp(32) }]));
    writeFileSync(join(dir, 'tentmake.sno'), shp(13));
    const out = execFileSync(process.execPath, [join(here, 'make-frames.mjs'), dir], { encoding: 'utf8' });
    assert.equal(out, 'factmake.shp: 32 frames\ntentmake.sno: 13 frames\n');
    assert.deepEqual(readdirSync(dir).sort(), ['conquer.mix', 'tentmake.sno']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

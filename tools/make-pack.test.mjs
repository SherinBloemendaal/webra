// tools/make-pack.mjs: builds a texture pack from a folder, checked like the game checks one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makePack } from './make-pack.mjs';
import { readPack, PackError } from '../apps/game/js/content/packs.js';
import { buildPng } from '../apps/game/tests/content-fixtures.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/** The example manifest of docs/texture-packs.md, with images made up here. */
function exampleFolder() {
  const doc = readFileSync(join(here, '..', 'docs', 'texture-packs.md'), 'utf8');
  const manifest = JSON.parse(doc.match(/```json\n([\s\S]*?)\n```/)[1]);
  const dir = mkdtempSync(join(tmpdir(), 'webra-pack-'));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const png = (path, w, h) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), buildPng(w, h, new Uint8ClampedArray(w * h * 4).fill(128)));
  };
  for (const s of manifest.sprites) {
    if (s.hidden) continue;
    const w = s.frameSize[0] * (s.frames ?? 1);
    const h = s.frameSize[1] * (s.facings ?? 1);
    png(s.image, w, h);
    if (s.teamMask) png(s.teamMask, w, h);
  }
  for (const p of Object.values(manifest.cameos ?? {})) png(p, 64, 48);
  const t = manifest.terrain;
  for (const k of ['clear', 'rough', 'rock', 'water', 'tree', 'ford']) if (t?.[k]) png(t[k], t.tileSize * 4, t.tileSize);
  if (t?.ore) png(t.ore, t.tileSize * 12, t.tileSize * 4);
  if (t?.gems) png(t.gems, t.tileSize * 4, t.tileSize * 4);
  for (const p of Object.values(manifest.sounds ?? {})) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    const b = new Uint8Array(64);
    b.set(new TextEncoder().encode('OggS'), 0);
    writeFileSync(join(dir, p), b);
  }
  writeFileSync(join(dir, 'LICENSE.txt'), 'CC0-1.0');
  return { dir, manifest };
}

test('the documented example builds into a pack the game accepts', async () => {
  const { dir, manifest } = exampleFolder();
  try {
    const { bytes } = await makePack(dir);
    const pack = await readPack(bytes);
    assert.equal(pack.manifest.name, manifest.name);
    assert.ok(pack.files.has('LICENSE.txt') === false, 'text files ride along but the game only reads what the manifest names');
    // The command line writes the file.
    const out = join(dir, 'out.webrapack');
    const log = execFileSync(process.execPath, [join(here, 'make-pack.mjs'), dir, out], { encoding: 'utf8' });
    assert.match(log, /wrote .*out\.webrapack/);
    assert.deepEqual(new Uint8Array(readFileSync(out)), bytes);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('broken folders are refused with the reason', async () => {
  const { dir, manifest } = exampleFolder();
  try {
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...manifest, rules: {} }));
    await assert.rejects(makePack(dir), (e) => e instanceof PackError && /rules/.test(e.message));
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
    rmSync(join(dir, manifest.sprites[0].image));
    await assert.rejects(makePack(dir), (e) => e instanceof PackError && /missing files/.test(e.message));
    let code = 0;
    try {
      execFileSync(process.execPath, [join(here, 'make-pack.mjs'), dir], { stdio: 'pipe' });
    } catch (err) {
      code = err.status;
    }
    assert.equal(code, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

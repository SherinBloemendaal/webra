// The 3D minimal pack against the original art: the colour table it shares with the 2D minimal art, and (below)
// the size of every structure and unit compared with the original sprite's extent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SHARED_PALETTE } from '../js/art/shared-palette.js';

const source = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

// ---- The shared palette ---------------------------------------------------------------------------

test('the shared 2D/3D palette is strict JSON, as the 3D generator reads it', () => {
  const text = source('../js/art/shared-palette.js');
  const at = text.indexOf('{', text.indexOf('export const SHARED_PALETTE ='));
  const end = text.indexOf('\n};', at);
  assert.deepEqual(JSON.parse(text.slice(at, end + 2)), SHARED_PALETTE);
  assert.ok(source('../../../tools/gen_minimal3d/core.py').includes("'shared-palette.js'"), 'core.py reads the shared palette');
});

test('the shared palette has the materials, the team strip, the shadow and terrain for every biome', () => {
  const hex = /^#[0-9a-f]{6}$/;
  assert.match(SHARED_PALETTE.team, hex);
  assert.ok(SHARED_PALETTE.shadow.offset > 0 && SHARED_PALETTE.shadow.alpha > 0 && SHARED_PALETTE.shadow.alpha < 1);
  for (const [name, c] of Object.entries(SHARED_PALETTE.materials)) assert.match(c, hex, name);
  const keys = Object.keys(SHARED_PALETTE.terrain.temperate).sort();
  for (const biome of ['temperate', 'snow', 'desert']) {
    const t = SHARED_PALETTE.terrain[biome];
    assert.deepEqual(Object.keys(t).sort(), keys, `${biome} has the same terrain keys`);
    for (const [k, c] of Object.entries(t)) for (const v of [c].flat()) assert.match(v, hex, `${biome} ${k}`);
  }
});

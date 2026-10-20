// tools/gen_content_tables.py: the palette a render trait draws with, read
// from MiniYaml the way the generator reads data/source (OpenRA's field
// defaults per trait, TRAIT_PALETTES).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The palette key of trait `key` (TRAIT_PALETTES `kind`) of ACTOR in this MiniYaml. */
function palette(yaml, key, kind = key.split('@')[0]) {
  const script = `
import json, sys
sys.path[:0] = [${JSON.stringify(join(root, 'tools'))}, ${JSON.stringify(join(root, 'data', 'source'))}]
import gen_content_tables as g, parse
tree = parse.resolve_all(parse.parse_miniyaml(sys.stdin.read()))['ACTOR']
print(json.dumps(g.trait_palette(tree, ${JSON.stringify(kind)}, tree.get(${JSON.stringify(key)}, [None, None])[1], 'test')))
`;
  const r = spawnSync('python3', ['-I', '-B', '-c', script], { input: yaml, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('trait palettes: the palette field and the owner flag each fall back to their own default', () => {
  // WithDeathAnimation: DeathSequencePalette player, DeathPaletteIsPlayerPalette true.
  assert.equal(palette('ACTOR:\n\tWithDeathAnimation:\n', 'WithDeathAnimation'), 'player+owner');
  assert.equal(palette('ACTOR:\n\tWithDeathAnimation:\n\t\tDeathPaletteIsPlayerPalette: false\n', 'WithDeathAnimation'), 'player', 'an explicit flag over the default palette');
  assert.equal(palette('ACTOR:\n\tWithDeathAnimation:\n\t\tDeathSequencePalette: civilian4\n\t\tDeathPaletteIsPlayerPalette: false\n', 'WithDeathAnimation'), 'civilian4');
  assert.equal(palette('ACTOR:\n\tWithDeathAnimation:\n\t\tDeathSequencePalette: player-noshadow\n', 'WithDeathAnimation'), 'player-noshadow+owner');
  // Crushed: CrushedSequencePalette effect, CrushedPaletteIsPlayerPalette false.
  assert.equal(palette('ACTOR:\n\tWithDeathAnimation:\n', 'WithDeathAnimation', 'WithDeathAnimation.crushed'), 'effect');
  assert.equal(palette('ACTOR:\n\tWithDeathAnimation:\n\t\tCrushedSequencePalette: player\n\t\tCrushedPaletteIsPlayerPalette: true\n', 'WithDeathAnimation', 'WithDeathAnimation.crushed'), 'player+owner');
  // No palette of its own: RenderSprites', whatever the flag says (RenderSprites.Add).
  assert.equal(palette('ACTOR:\n\tWithSpriteBody:\n\t\tIsPlayerPalette: true\n\tRenderSprites:\n\t\tPalette: terrain\n', 'WithSpriteBody'), 'terrain');
  assert.equal(palette('ACTOR:\n\tWithSpriteBody:\n', 'WithSpriteBody'), 'player+owner');
  assert.equal(palette('ACTOR:\n\tWithInfantryBody:\n\t\tPalette: player-noshadow\n\t\tIsPlayerPalette: true\n', 'WithInfantryBody'), 'player-noshadow+owner');
  assert.equal(palette('ACTOR:\n\tWithInfantryBody:\n\t\tPalette: civilian7\n', 'WithInfantryBody'), 'civilian7');
});

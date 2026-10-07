// Writes apps/game/editor/data/rules-base.json: the built-in actors and weapons
// from engine/rules.json keyed by id, the shape rules overrides use
// (docs/contracts.md section 2). The editor needs every field and value to
// validate overrides and to show defaults; the wasm API only exposes a summary.
//
// Usage: node apps/game/editor/tools/sync-rules-base.mjs [--check]
// The editor test suite fails when the file is out of date.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const RULES = fileURLToPath(new URL('../../../../engine/rules.json', import.meta.url));
export const OUT = fileURLToPath(new URL('../data/rules-base.json', import.meta.url));

/** Build the snapshot text from the engine's rules.json text. */
export function buildRulesBase(rulesText) {
  const r = JSON.parse(rulesText);
  const entries = (list, key) => list.map((x) => `    ${JSON.stringify(x[key])}: ${JSON.stringify(x)}`).join(',\n');
  return [
    '{',
    `  "source": ${JSON.stringify('engine/rules.json via apps/game/editor/tools/sync-rules-base.mjs; do not edit')},`,
    `  "armorTypes": ${JSON.stringify(r.armor_types)},`,
    `  "weaponNames": ${JSON.stringify(r.weapons.map((w) => w.name))},`,
    '  "actors": {',
    entries(r.actors, 'id'),
    '  },',
    '  "weapons": {',
    entries(r.weapons, 'name'),
    '  }',
    '}',
    '',
  ].join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const text = buildRulesBase(readFileSync(RULES, 'utf8'));
  if (process.argv.includes('--check')) {
    const current = readFileSync(OUT, 'utf8');
    if (current !== text) {
      console.error('rules-base.json is out of date: run node apps/game/editor/tools/sync-rules-base.mjs');
      process.exit(1);
    }
    console.log('rules-base.json is up to date');
  } else {
    writeFileSync(OUT, text);
    console.log(`wrote ${OUT}`);
  }
}

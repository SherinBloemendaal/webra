// Maps converted from OpenRA .oramap packages (in the browser) are uploaded
// like any map: the server's two gates (packages/protocol, then the engine)
// still decide. The server itself never unpacks .oramap files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prepareMap } from '../src/maps.js';
import { importOramap } from '../../game/js/oramap/index.js';
import { sampleOramap } from '../../game/tests/oramap-fixtures.mjs';

const BASE_RULES = JSON.parse(readFileSync(new URL('../../../engine/rules.json', import.meta.url), 'utf8'));

test('converted .oramap maps pass the upload gates, tampered ones do not', async () => {
  const { json, map } = await importOramap(sampleOramap(), { baseRules: BASE_RULES, fileName: 'valley.oramap' });
  const p = await prepareMap(json);
  assert.equal(p.modded, false);
  assert.equal(p.players, 2);
  assert.ok(p.canonical.includes('"gems":'), 'OpenRA gems arrive as a format 2 map');

  const rules = 'E1:\n\tValued:\n\t\tCost: 80\n';
  const modded = await importOramap(
    sampleOramap({ rulesRef: 'rules.yaml', extraFiles: [{ name: 'rules.yaml', data: rules }] }),
    { baseRules: BASE_RULES },
  );
  const pm = await prepareMap(modded.json);
  assert.equal(pm.modded, true);

  // The server does not trust the converter: an actor type the engine does not know is refused.
  const bad = { ...map, actors: [...map.actors, { type: 'NOSUCH', owner: -1, x: 1, y: 1, facing: 0 }] };
  await assert.rejects(prepareMap(JSON.stringify(bad)), (e) => e.status === 422 && /unknown actor type/.test(e.message));
});

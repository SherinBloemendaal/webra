import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  canonicalMapJson,
  decodeBase64,
  isModded,
  MAP_MAX_BYTES,
  mapHash,
  parseMap,
  validateMap,
  validateRules,
} from '../src/index.js';

const ENGINE_RULES = JSON.parse(readFileSync(new URL('../../../engine/rules.json', import.meta.url), 'utf8'));

function makeMap(w = 32, h = 32, extra = {}) {
  const terrain = Buffer.alloc(w * h, 0);
  const ore = Buffer.alloc(w * h, 0);
  terrain[5] = 4;
  ore[w * 10 + 10] = 12;
  return {
    format: 1,
    name: 'Twin Rivers',
    author: 'Commander',
    description: 'Two rivers.\nGood luck.',
    width: w,
    height: h,
    terrain: terrain.toString('base64'),
    ore: ore.toString('base64'),
    spawns: [
      [2, 2],
      [w - 5, h - 6],
    ],
    actors: [{ type: 'SBAG', owner: -1, x: 16, y: 16, facing: 0 }],
    rules: null,
    ...extra,
  };
}

test('a valid map validates and keeps its exact text', () => {
  const r = validateMap(makeMap());
  assert.ok(r.ok, r.errors.join('; '));
  assert.equal(r.modded, false);
  assert.equal(r.players, 2);
  assert.equal(r.map.description, 'Two rivers.\nGood luck.');
});

test('canonical JSON: contract key order, defaults filled, rules keys sorted, no whitespace', () => {
  const { description: _d, actors: _a, rules: _r, ...minimal } = makeMap();
  const r = validateMap({ ...minimal, rules: { weapons: { '25mm': { range: 6000 } }, actors: { '1TNK': { unit: { speed: 150 }, cost: 400 } } } });
  assert.ok(r.ok, r.errors.join('; '));
  const c = r.canonical;
  assert.ok(c.startsWith('{"format":1,"name":"Twin Rivers","author":"Commander","description":"","width":32,"height":32,"terrain":"'));
  assert.ok(c.endsWith(',"actors":[],"rules":{"actors":{"1TNK":{"cost":400,"unit":{"speed":150}}},"weapons":{"25mm":{"range":6000}}}}'));
  assert.ok(!/\s/.test(c.replace(/"[^"]*"/g, '')), 'no whitespace outside strings');
  assert.equal(canonicalMapJson(r.map), c);
});

test('hash is sha256 hex of the canonical JSON and independent of input key order', async () => {
  const m = makeMap();
  const r = validateMap(m);
  const expected = createHash('sha256').update(r.canonical).digest('hex');
  assert.equal(await mapHash(r.map), expected);
  const shuffled = Object.fromEntries(Object.entries(m).reverse());
  assert.equal(await mapHash(validateMap(shuffled).map), expected);
  const other = validateMap(makeMap(32, 32, { name: 'Other' }));
  assert.notEqual(await mapHash(other.map), expected);
});

test('invalid maps report problems', () => {
  const cases = [
    [{ format: 2 }, /format/],
    [{ name: '' }, /name/],
    [{ author: 'x'.repeat(65) }, /author/],
    [{ description: 'x'.repeat(501) }, /description/],
    [{ width: 31 }, /width/],
    [{ height: 257 }, /height/],
    [{ terrain: 'AAAA' }, /terrain/],
    [{ ore: Buffer.alloc(32 * 32, 13).toString('base64') }, /ore density/],
    [{ terrain: Buffer.alloc(32 * 32, 5).toString('base64') }, /terrain value/],
    [{ terrain: Buffer.alloc(32 * 32, 3).toString('base64') }, /ore can only/],
    [{ spawns: [[1, 1]] }, /2 to 8/],
    [{ spawns: Array.from({ length: 9 }, (_, i) => [i, 0]) }, /2 to 8/],
    [{ spawns: [[1, 1], [1, 1]] }, /duplicates/],
    [{ spawns: [[1, 1], [30, 1]] }, /spawn 2 x/],
    [{ actors: [{ type: 'SBAG', owner: 2, x: 1, y: 1 }] }, /owner/],
    [{ actors: [{ type: 'SB AG', owner: 0, x: 1, y: 1 }] }, /type/],
    [{ actors: [{ type: 'SBAG', owner: 0, x: 40, y: 1 }] }, /x/],
    [{ rules: [] }, /rules/],
    [{ rules: { player: { starting_cash: 1 } } }, /unknown section/],
    [{ extra: 1 }, /unknown field/],
  ];
  for (const [patch, re] of cases) {
    const r = validateMap(makeMap(32, 32, patch));
    assert.equal(r.ok, false, JSON.stringify(patch).slice(0, 80));
    assert.ok(r.errors.some((e) => re.test(e)), `${JSON.stringify(patch).slice(0, 60)}: ${r.errors.join('; ')}`);
  }
  assert.equal(validateMap(null).ok, false);
  assert.equal(validateMap([]).ok, false);
});

test('parseMap enforces the 1 MiB limit before parsing', () => {
  const huge = JSON.stringify(makeMap(32, 32, { description: 'x' })).replace('"x"', `"${'x'.repeat(MAP_MAX_BYTES)}"`);
  assert.match(parseMap(huge).errors[0], /1 MiB/);
  assert.match(parseMap('{').errors[0], /JSON/);
  assert.ok(parseMap(JSON.stringify(makeMap())).ok);
});

test('base64 decoding is strict', () => {
  assert.deepEqual(Array.from(decodeBase64('AAEC', 'x')), [0, 1, 2]);
  assert.deepEqual(Array.from(decodeBase64('AAE=', 'x')), [0, 1]);
  assert.deepEqual(Array.from(decodeBase64('AA==', 'x')), [0]);
  for (const s of ['AAE', 'A===', 'AAF=', 'AB==', '!!!!', 'AA=A']) assert.throws(() => decodeBase64(s, 'x'), s);
});

test('rules overrides are checked against the engine rules like the engine does', () => {
  const ok = { actors: { '1tnk': { cost: 400, unit: { speed: 150 } } }, weapons: { '25mm': { range: 6000 } } };
  validateRules(ok, ENGINE_RULES);
  for (const bad of [
    { actors: { NOPE: { cost: 1 } } },
    { actors: { '1TNK': { costt: 1 } } },
    { actors: { '1TNK': { cost: 'free' } } },
    { actors: { '1TNK': { id: '2TNK' } } },
    { actors: { '1TNK': { kind: 'unit' } } },
    { actors: { '1TNK': { cost: 1.5 } } },
    { weapons: { '25mm': { range: null } } },
    { player: { starting_cash: 1 } },
  ]) {
    assert.throws(() => validateRules(bad, ENGINE_RULES), JSON.stringify(bad));
  }
  // Arrays are replaced whole: objects inside keep their kind (engine keep_identity).
  const warheads = structuredClone(ENGINE_RULES.weapons.find((w) => w.name === '25mm').warheads);
  warheads[0].damage = 77;
  validateRules({ weapons: { '25mm': { warheads } } }, ENGINE_RULES);
  const silo = ENGINE_RULES.actors.find((a) => a.abilities.support_powers?.some((p) => p.kind === 'NukePower'));
  const powers = structuredClone(silo.abilities.support_powers);
  powers[0].charge = 10;
  validateRules({ actors: { [silo.id]: { abilities: { support_powers: powers } } } }, ENGINE_RULES);
  for (const [section, id, field, value] of [
    ['weapons', '25mm', 'warheads', [{ ...warheads[0], kind: 'percent' }]],
    ['weapons', '25mm', 'warheads', [...warheads, { ...warheads[0] }]],
    ['actors', silo.id, 'abilities', { support_powers: [{ ...powers[0], kind: 'GpsPower' }] }],
    ['actors', silo.id, 'abilities', { support_powers: [[{ kind: 'NukePower' }]] }],
  ]) {
    const bad = { [section]: { [id]: { [field]: value } } };
    assert.throws(() => validateRules(bad, ENGINE_RULES), /cannot be changed/, JSON.stringify(bad).slice(0, 120));
  }
  // Without the engine rules only shapes are checked; the engine decides the rest.
  validateRules({ weapons: { '25mm': { warheads: [{ ...warheads[0], kind: 'percent' }] } } });
  const r = validateMap(makeMap(32, 32, { rules: ok }), { rules: ENGINE_RULES });
  assert.ok(r.ok, r.errors.join('; '));
  assert.equal(r.modded, true);
  assert.equal(isModded({ rules: {} }), false);
  assert.equal(isModded({ rules: null }), false);
});

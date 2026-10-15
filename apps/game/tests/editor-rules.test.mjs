// The editor's rules overrides tab (editor/js/rulespanel.js) on a fake DOM:
// the sell value (OpenRA CustomSellValue) can be given to any actor and a
// built-in one taken away, it survives saving and reopening the map, the raw
// JSON view takes it, and the engine accepts what the editor accepts (needs
// `npm run build:wasm`).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installDom, uninstallDom, check, typeInto, textOf, FakeNode } from './dom-fixtures.mjs';
import { MapDoc } from '../editor/js/doc.js';
import { mapFileText, parseMap, validateMap } from '../editor/js/mapformat.js';
import { validateOverrides } from '../editor/js/overrides.js';
import { rulesBaseFrom } from '../editor/js/rulesbase.js';
import { RulesPanel } from '../editor/js/rulespanel.js';

const { initSync, Game } = await import('../pkg/webra_sim.js');
initSync({ module: readFileSync(new URL('../pkg/webra_sim_bg.wasm', import.meta.url)) });

const RULES_BASE = rulesBaseFrom(JSON.parse(readFileSync(new URL('../../../engine/rules.json', import.meta.url), 'utf8')));
const engineValidate = (map) => JSON.parse(Game.validate_map(JSON.stringify(map)));

beforeEach(() => {
  installDom();
  globalThis.Node = FakeNode;
});
afterEach(() => {
  delete globalThis.Node;
  uninstallDom();
});

/** Type into a number field (the fake DOM has no constraint validation API). */
function type(input, value) {
  input.setCustomValidity = () => {};
  input.reportValidity = () => true;
  typeInto(input, value);
}

function open(map = JSON.parse(Game.generated_map(9, 64, 2))) {
  const doc = new MapDoc(map);
  const root = document.createElement('div');
  const panel = new RulesPanel(root, doc, RULES_BASE);
  const select = (id) => {
    panel.selected.actors = id;
    panel.renderForm();
  };
  const row = (text) => [...panel.form.querySelectorAll('label')].find((l) => textOf(l).includes(text));
  return { doc, panel, select, row };
}

/** Save the map to its file text and open it again, checked by the editor and the engine. */
function saveAndReopen(doc) {
  const map = parseMap(mapFileText(doc.toMap()));
  const ours = validateMap(map, { rulesBase: RULES_BASE });
  assert.deepEqual(ours.errors, [], 'the editor opens it');
  const engine = engineValidate(map);
  assert.ok(engine.ok, `the engine accepts it: ${JSON.stringify(engine.errors)}`);
  return map;
}

test('sell value: any actor gets one, a built-in one can be taken away, and both survive save and reopen', () => {
  const { doc, select, row } = open();
  // An actor without a built-in CustomSellValue: the default shown is its cost.
  select('POWR');
  const input = row('Sell value').querySelector('input');
  assert.equal(input.placeholder, String(RULES_BASE.actors.POWR.cost));
  assert.equal(row('Sell for the cost'), undefined, 'nothing built in to take away');
  type(input, '120');
  assert.deepEqual(doc.rules, { actors: { POWR: { custom_sell_value: 120 } } });
  // A built-in one (the pillbox's 400) can be taken away: the cost counts again.
  select('PBOX');
  assert.equal(row('Sell value').querySelector('input').placeholder, '400');
  check(row('Sell for the cost').querySelector('input'));
  assert.deepEqual(doc.rules.actors.PBOX, { custom_sell_value: null });
  assert.equal(row('Sell value'), undefined, 'no number while it sells for its cost');

  const map = saveAndReopen(doc);
  assert.deepEqual(map.rules, { actors: { POWR: { custom_sell_value: 120 }, PBOX: { custom_sell_value: null } } });
  const again = open(map);
  again.select('PBOX');
  assert.equal(again.row('Sell for the cost').querySelector('input').checked, true);
  // Unticking it gives the built-in value back (nothing left to override).
  check(again.row('Sell for the cost').querySelector('input'), false);
  again.select('POWR');
  type(again.row('Sell value').querySelector('input'), '');
  assert.equal(again.doc.rules, null, 'all overrides removed');
});

test('sell value in the raw JSON view, with the same limits as the engine', () => {
  const { doc, panel } = open();
  panel.setRaw(true);
  const rules = { actors: { E1: { custom_sell_value: 5 }, sbag: { custom_sell_value: null }, '1TNK': { custom_sell_value: 0, cost: 900 } } };
  panel.rawText.value = JSON.stringify(rules);
  panel.applyRaw();
  assert.deepEqual(doc.rules, rules);
  assert.equal(panel.rawErrors.querySelectorAll('.error').length, 0, 'no errors');
  saveAndReopen(doc);

  const errs = (r) => validateOverrides(r, RULES_BASE);
  for (const [bad, why] of [
    [-1, /must not be negative/],
    [1.5, /expected an integer/],
    ['400', /expected a number or null/],
    [2_000_000, /at most 1000000/],
  ]) {
    const r = { actors: { E1: { custom_sell_value: bad } } };
    assert.match(errs(r)[0], why);
    panel.rawText.value = JSON.stringify(r);
    panel.applyRaw();
    assert.match(textOf(panel.rawErrors), why);
    const map = { ...JSON.parse(Game.generated_map(9, 64, 2)), rules: r };
    assert.equal(engineValidate(map).ok, false, `the engine refuses ${bad} too`);
  }
  assert.deepEqual(doc.rules, rules, 'refused JSON changes nothing');
  assert.match(errs({ weapons: { '25mm': { custom_sell_value: 1 } } })[0], /unknown field/, 'weapons have no sell value');
});

// The quick tips (js/quicktips.js): one line on what every structure,
// defence, infantry, vehicle, ship and aircraft of the build menu does, and
// the `game.quickTips` setting that shows them (on by default).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { QUICK_TIP_MAP_ONLY, QUICK_TIP_MAX, QUICK_TIPS, QUICK_TIPS_SETTING, quickTip, setQuickTips } from '../js/quicktips.js';
import { createRegistry, GROUPS } from '../js/registry.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const RULES = JSON.parse(read('../../../engine/rules.json'));

/** What the build menu can list: a production queue and no `~disabled` prerequisite (engine production.rs in_game_mode). */
const buildable = RULES.actors.filter((a) => a.queue && !(a.prerequisites ?? []).includes('~disabled')).map((a) => a.id);

test('every actor the build menu can list has a quick tip, and no tip is an orphan', () => {
  assert.ok(buildable.length > 80, `${buildable.length} buildable actors`);
  const missing = buildable.filter((id) => !quickTip(id));
  assert.deepEqual(missing, [], 'actors without a tip');
  const ids = new Set(RULES.actors.map((a) => a.id));
  const orphans = Object.keys(QUICK_TIPS).filter((id) => !buildable.includes(id) && !QUICK_TIP_MAP_ONLY.includes(id));
  assert.deepEqual(orphans, [], 'tips of actors the build menu never lists');
  for (const id of QUICK_TIP_MAP_ONLY) assert.ok(ids.has(id) && !buildable.includes(id), `${id}: on the map only`);
});

test('quick tips are one short factual line in the game voice', () => {
  for (const [id, text] of Object.entries(QUICK_TIPS)) {
    assert.equal(typeof text, 'string', id);
    assert.ok(text.length > 0 && text.length <= QUICK_TIP_MAX, `${id}: ${text.length} characters`);
    assert.match(text, /^[A-Z$].*\.$/, `${id}: a sentence`);
    assert.doesNotMatch(text, /[\u2013\u2014\n]/, `${id}: no dashes or line breaks`);
  }
  assert.equal(quickTip('WEAP'), 'Builds vehicles.');
  assert.equal(quickTip('DOME'), 'Shows the radar minimap. Needs power.');
  assert.match(quickTip('FIX'), /^Repairs vehicles and aircraft/);
  assert.equal(quickTip(null), null);
  assert.equal(quickTip('TC01'), null, 'trees have none');
  assert.equal(quickTip('toString'), null, 'only own entries');
});

test('the Quick tips setting: game.quickTips, on by default, and the setter the guide uses', () => {
  assert.deepEqual(QUICK_TIPS_SETTING, ['game', 'quickTips']);
  const spec = GROUPS.game.settings.quickTips;
  assert.equal(spec.type, 'boolean');
  assert.equal(spec.default, true, 'on for everyone');
  assert.ok(spec.label && spec.help);
  const registry = createRegistry({ storage: null });
  assert.equal(registry.get('game', 'quickTips'), true, 'players without the key (from before 0.19.0) get it on');
  setQuickTips(registry, false);
  assert.equal(registry.get('game', 'quickTips'), false);
  setQuickTips(registry, true);
  assert.equal(registry.get('game', 'quickTips'), true);
});

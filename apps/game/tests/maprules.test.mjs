// What a modded map's rules change, in words (js/maprules.js), and the
// modded-map prompts that list it: the skirmish lobby, the online lobby and
// replays or saves. Maps are synthetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initSync, Game } from '../pkg/webra_sim.js';
import { installDom, uninstallDom } from './dom-fixtures.mjs';
import { describeMapRules, ticksToTime } from '../js/maprules.js';
import { defaultRegistry } from '../js/registry.js';
import { createMap } from '../editor/js/mapformat.js';

initSync({ module: readFileSync(fileURLToPath(new URL('../pkg/webra_sim_bg.wasm', import.meta.url))) });
const BASE = JSON.parse(readFileSync(new URL('../../../engine/rules.json', import.meta.url), 'utf8'));
const builtIn = (id) => BASE.actors.find((a) => a.id === id);

/** A modded map: a slower Atom Bomb, a cheaper Light Tank, a longer range carbine. */
function moddedRules() {
  const nuke = builtIn('MSLO').abilities.support_powers;
  return {
    actors: {
      MSLO: { abilities: { support_powers: [{ ...nuke[0], charge: 50000, start_fully_charged: true }] } },
      '1TNK': { cost: 500, prerequisites: ['~techlevel.low'], unit: { speed: builtIn('1TNK').unit.speed } },
    },
    weapons: { M1Carbine: { range: 6144 } },
  };
}

test('ticks read as game time at normal speed', () => {
  assert.equal(ticksToTime(13500), '9:00');
  assert.equal(ticksToTime(50000), '33:20');
  assert.equal(ticksToTime(24), '0:00');
});

test('each changed value is one line, built-in value to the map value', () => {
  const lines = describeMapRules(moddedRules(), BASE);
  const tank = builtIn('1TNK');
  assert.deepEqual(lines, [
    'Missile Silo (MSLO): Atom Bomb charge time: 13500 ticks (9:00) to 50000 ticks (33:20 at normal speed)',
    'Missile Silo (MSLO): Atom Bomb starts charged: no to yes',
    `Light Tank (1TNK): cost: ${tank.cost} to 500`,
    `Light Tank (1TNK): prerequisites: ${tank.prerequisites.join(', ')} to ~techlevel.low`,
    `Weapon M1Carbine: range: ${BASE.weapons.find((w) => w.name === 'M1Carbine').range} to 6144`,
  ]);
  // Unchanged values (the tank's speed) are not listed; a cap counts the rest.
  const capped = describeMapRules(moddedRules(), BASE, { limit: 2 });
  assert.equal(capped.length, 3);
  assert.equal(capped[2], '...and 3 more changes.');
  assert.deepEqual(describeMapRules(null, BASE), []);
  // Without the built-in rules every value still shows, from "none".
  assert.equal(describeMapRules({ weapons: { X: { range: 1 } } }, null)[0], 'Weapon X: range: none to 1');
});

/** A 2-spawn map file with these rules. */
function mapJson(rules) {
  return JSON.stringify({ ...createMap({ width: 96, height: 96, name: 'Slow Nukes', author: 'A' }), spawns: [[8, 8], [80, 80]], rules });
}

test('the skirmish lobby lists what a modded map changes before it is installed', async () => {
  const doc = installDom();
  globalThis.requestAnimationFrame = () => 1;
  try {
    const root = doc.createElement('section');
    doc.body.append(root);
    defaultRegistry().set('lobby', 'presets', []);
    defaultRegistry().set('lobby', 'lastOptions', {});
    const { Lobby } = await import('../js/lobby.js');
    const lobby = new Lobby(root, {
      colors: Array.from({ length: 8 }, () => [1, 1, 1]),
      colorNames: [],
      mapPreview: () => new Uint8Array(0),
      maps: {
        validate: (json) => JSON.parse(Game.validate_map(json)),
        describeRules: (json) => describeMapRules(JSON.parse(json).rules, BASE),
      },
      onStart: () => {},
      onStress: () => {},
    });
    lobby.offerMapText(mapJson(moddedRules()), 'file');
    assert.ok(lobby.pendingMap, 'waits for the player to accept');
    assert.equal(lobby.moddedBox.hidden, false);
    const items = [...lobby.moddedRules.querySelectorAll('li')].map((li) => li.textContent);
    assert.equal(lobby.moddedRules.hidden, false);
    assert.ok(items[0].startsWith('Missile Silo (MSLO): Atom Bomb charge time: 13500 ticks'), items.join('\n'));
    assert.equal(items.length, 5);
  } finally {
    delete globalThis.requestAnimationFrame;
    uninstallDom();
  }
});

test('the online and replay prompts list the changes too', async () => {
  const doc = installDom();
  try {
    const lines = describeMapRules(moddedRules(), BASE);
    for (const [file, cls] of [['../js/online.js', 'online-modded-rules'], ['../js/records.js', 'records-modded-rules']]) {
      const { confirmModdedMap } = await import(file);
      const answer = confirmModdedMap('Slow Nukes', lines);
      const dialog = doc.querySelector('dialog');
      assert.ok(dialog, file);
      const list = dialog.querySelector(`.${cls}`);
      assert.deepEqual([...list.querySelectorAll('li')].map((li) => li.textContent), lines, file);
      const decline = [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Decline');
      decline.click();
      assert.equal(await answer, false);
      dialog.remove();
      // No changes known (no engine): the prompt has no list.
      const plain = confirmModdedMap('Slow Nukes');
      const d2 = doc.querySelector('dialog');
      assert.equal(d2.querySelector(`.${cls}`), null, file);
      [...d2.querySelectorAll('button')].find((b) => b.textContent === 'Decline').click();
      await plain;
      d2.remove();
    }
  } finally {
    uninstallDom();
  }
});

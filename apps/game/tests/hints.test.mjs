// One-time tips (js/hints.js): the attack-move tip shows once, only when the
// engine says a plain move passes enemies, with the bound key, and the
// settings registry remembers it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ATTACK_MOVE_TIP_SETTING, AttackMoveTip, attackMoveTipText, TIP_SECONDS, TipView } from '../js/hints.js';
import { GROUPS } from '../js/registry.js';
import { installDom, uninstallDom } from './dom-fixtures.mjs';

function fakeRegistry(values = {}) {
  return {
    values,
    get: (group, key) => values[`${group}.${key}`],
    set(group, key, value) {
      values[`${group}.${key}`] = value;
      return value;
    },
  };
}

function setup({ hint = true, seen = false, key = 'A' } = {}) {
  const registry = fakeRegistry(seen ? { 'game.attackMoveTipSeen': true } : {});
  const asked = [];
  const shown = [];
  const ask = {
    move_hint: async (player, ids, x, y) => {
      asked.push({ player, ids: Array.from(ids), x, y });
      return hint;
    },
  };
  const tip = new AttackMoveTip({ registry, ask, player: 2, keyLabel: () => key, show: (t) => shown.push(t) });
  return { tip, registry, asked, shown };
}

test('the tip text names the bound key', () => {
  assert.equal(attackMoveTipText(), 'Tip: A + click attack-moves (units engage enemies on the way)');
  assert.equal(attackMoveTipText('Ctrl+Q'), 'Tip: Ctrl+Q + click attack-moves (units engage enemies on the way)');
  // The registry knows the setting, so the account and the server keep it.
  const [group, key] = ATTACK_MOVE_TIP_SETTING;
  assert.equal(GROUPS[group].settings[key].type, 'boolean');
  assert.equal(GROUPS[group].settings[key].default, false);
});

test('a plain move past enemies shows the tip once and remembers it', async () => {
  const { tip, registry, asked, shown } = setup();
  assert.equal(await tip.plainMove([5, 6], { x: 100, y: 200 }), true);
  assert.deepEqual(asked, [{ player: 2, ids: [5, 6], x: 100, y: 200 }]);
  assert.deepEqual(shown, [attackMoveTipText('A')]);
  assert.equal(registry.get(...ATTACK_MOVE_TIP_SETTING), true);
  // Never again, not even a question to the engine.
  assert.equal(await tip.plainMove([5], { x: 1, y: 1 }), false);
  assert.equal(asked.length, 1);
  assert.equal(shown.length, 1);
});

test('no tip for moves the engine finds harmless, when seen before, or without units', async () => {
  const quiet = setup({ hint: false });
  assert.equal(await quiet.tip.plainMove([5], { x: 1, y: 1 }), false);
  assert.equal(quiet.shown.length, 0);
  assert.equal(quiet.registry.get(...ATTACK_MOVE_TIP_SETTING), undefined, 'still to come');
  const seen = setup({ seen: true });
  assert.equal(await seen.tip.plainMove([5], { x: 1, y: 1 }), false);
  assert.equal(seen.asked.length, 0);
  const none = setup();
  assert.equal(await none.tip.plainMove([], { x: 1, y: 1 }), false);
  assert.equal(none.asked.length, 0);
});

test('a rebound key shows in the tip; an unbound one falls back to A', async () => {
  const rebound = setup({ key: 'Q' });
  await rebound.tip.plainMove([1], { x: 0, y: 0 });
  assert.deepEqual(rebound.shown, [attackMoveTipText('Q')]);
  const unbound = setup({ key: null });
  await unbound.tip.plainMove([1], { x: 0, y: 0 });
  assert.deepEqual(unbound.shown, [attackMoveTipText('A')]);
});

test('the tip box closes with its button or after a while', () => {
  installDom();
  try {
    const field = document.createElement('div');
    let timer = null;
    const view = new TipView(field, { setTimer: (fn, ms) => (timer = { fn, ms }), clearTimer: () => (timer = null) });
    view.show(attackMoveTipText());
    assert.equal(view.open, true);
    assert.equal(field.querySelector('#tip .tip-text').textContent, attackMoveTipText());
    assert.equal(timer.ms, TIP_SECONDS * 1000);
    field.querySelector('#tip .tip-close').click();
    assert.equal(view.open, false);
    assert.equal(field.querySelector('#tip'), null);
    assert.equal(timer, null, 'timer cleared');
    view.show('again');
    timer.fn();
    assert.equal(view.open, false, 'timed out');
  } finally {
    uninstallDom();
  }
});

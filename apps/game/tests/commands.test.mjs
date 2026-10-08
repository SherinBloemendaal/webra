// Command bar (js/commandbar.js, js/commandkeys.js) and its engine API
// (engine/src/commands.rs). Run after `npm run build:wasm`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initSync, Game } from '../pkg/webra_sim.js';
import { barState, commandClick, COMMAND_CURSORS, COMMANDS, ICONS, nextStance, pendingStances, STANCES } from '../js/commandbar.js';
import { comboFromEvent, LocalKeys, normalizeCombo } from '../js/commandkeys.js';
import { STANCES as PROTOCOL_STANCES } from '../js/protocol.js';

initSync({ module: readFileSync(fileURLToPath(new URL('../pkg/webra_sim_bg.wasm', import.meta.url))) });

const NONE = 0xffffffff;
const SIZE = 48;
const px = (cell) => (cell + 0.5) * 24;

/** An open, clear map with pre-placed actors; player 1 is an enemy. */
function game(actors) {
  const map = {
    format: 1,
    name: 'Open',
    author: 'Tests',
    description: '',
    width: SIZE,
    height: SIZE,
    terrain: Buffer.from(new Uint8Array(SIZE * SIZE)).toString('base64'),
    ore: Buffer.from(new Uint8Array(SIZE * SIZE)).toString('base64'),
    spawns: [
      [2, 2],
      [2, 40],
    ],
    actors,
    rules: null,
  };
  const options = {
    seed: 3,
    players: [
      { slot: 0, type: 'human', faction: 'england' },
      { slot: 1, type: 'human', faction: 'russia' },
    ],
    startingUnits: 'mcv',
    techLevel: 'unrestricted',
    fog: false,
    explored: true,
  };
  const g = Game.from_map(JSON.stringify(map), JSON.stringify(options));
  g.tick();
  return g;
}

const at = (g, cx, cy) => g.pick(0, px(cx), px(cy));
const ids = (...list) => Uint32Array.from(list);
const state = (g, list) => JSON.parse(g.command_state(0, Uint32Array.from(list)));
const ticks = (g, n) => {
  for (let i = 0; i < n; i++) g.tick();
};

// ---- Pure bar logic ----------------------------------------------------------------------

test('buttons follow the selection', () => {
  const empty = barState(null, 0);
  assert.ok(Object.values(empty.commands).every((c) => !c.enabled));
  assert.equal(empty.stancesEnabled, false);
  const cmd = { units: 2, armed: 1, attackGround: 1, guard: 2, scatter: 2, queued: 0, stances: { attack_anything: 1, defend: 0, return_fire: 0, hold_fire: 0 } };
  const s = barState(cmd, 0, { guard: true, forceMove: false });
  assert.equal(s.commands.deploy.enabled, false, 'nothing deployable');
  assert.equal(barState(cmd, 1).commands.deploy.enabled, true);
  assert.equal(barState(cmd, 2).commands.deploy.enabled, true, 'deployable, blocked here: still a button');
  assert.equal(s.commands.forceAttack.enabled, true);
  assert.equal(s.commands.guard.active, true);
  assert.equal(s.commands.forceMove.active, false);
  assert.equal(s.stances.attack_anything, 'all');
  assert.equal(s.stances.hold_fire, 'none');
  const unarmed = barState({ ...cmd, armed: 0, stances: {} }, 0, { forceAttack: true });
  assert.equal(unarmed.commands.forceAttack.enabled, false, 'harvesters cannot force-fire');
  assert.equal(unarmed.commands.forceAttack.active, false, 'a disabled mode never shows armed');
  assert.equal(unarmed.stancesEnabled, false);
});

test('a stance only part of the selection uses is mixed', () => {
  const s = barState({ units: 3, armed: 3, stances: { attack_anything: 2, hold_fire: 1 } }, 0);
  assert.equal(s.stances.attack_anything, 'some');
  assert.equal(s.stances.hold_fire, 'some');
  assert.equal(s.stances.defend, 'none');
  assert.equal(nextStance({ stances: { attack_anything: 2, hold_fire: 1 } }), 'defend', 'cycles from the most used stance');
  assert.equal(nextStance({ stances: { hold_fire: 1 } }), 'attack_anything', 'wraps around');
  assert.equal(nextStance({ stances: {} }), null);
  assert.deepEqual(pendingStances({ attack_anything: 2, hold_fire: 1, defend: 0, return_fire: 0 }, 'defend'), {
    attack_anything: 0,
    defend: 3,
    return_fire: 0,
    hold_fire: 0,
  });
});

test('the bar and the protocol name the same stances', () => {
  assert.deepEqual([...STANCES.map((s) => s.id)].sort(), [...PROTOCOL_STANCES].sort());
});

test('clicks in command modes and with modifiers', () => {
  const base = {
    mode: null,
    queue: false,
    shift: false,
    ctrl: false,
    alt: false,
    hit: NONE,
    hitOwner: null,
    player: 0,
    allied: (o) => o === 0,
    selected: (id) => id === 5,
    canAttackGround: true,
    canGuard: false,
  };
  assert.equal(commandClick(base), null, 'a plain click is a normal order');
  assert.deepEqual(commandClick({ ...base, ctrl: true }), { kind: 'attackGround' });
  assert.deepEqual(commandClick({ ...base, ctrl: true, canAttackGround: false }), { kind: 'ignore' });
  assert.deepEqual(commandClick({ ...base, ctrl: true, hit: 9, hitOwner: 0 }), { kind: 'attack', target: 9 }, 'force-fire on own units');
  assert.deepEqual(commandClick({ ...base, mode: 'forceAttack', hit: 9, hitOwner: 1 }), { kind: 'attack', target: 9 });
  assert.deepEqual(commandClick({ ...base, ctrl: true, hit: 5, hitOwner: 0 }), { kind: 'attackGround' }, 'not at itself: the ground under it');
  assert.deepEqual(commandClick({ ...base, alt: true, hit: 9, hitOwner: 1 }), { kind: 'move' }, 'force move ignores what is there');
  assert.deepEqual(commandClick({ ...base, mode: 'forceMove' }), { kind: 'move' });
  assert.deepEqual(commandClick({ ...base, shift: true }), { kind: 'waypoint', attackMove: false });
  assert.deepEqual(commandClick({ ...base, queue: true, hit: 9, hitOwner: 1 }), { kind: 'waypoint', attackMove: true }, 'queued attack on an enemy');
  assert.equal(commandClick({ ...base, shift: true, hit: 7, hitOwner: 0 }), null, 'Shift+click on an own unit still selects');
  assert.deepEqual(commandClick({ ...base, mode: 'guard', hit: 7, hitOwner: 0, canGuard: true }), { kind: 'guard', target: 7 });
  assert.deepEqual(commandClick({ ...base, mode: 'guard', hit: 7, hitOwner: 1 }), { kind: 'ignore' }, 'enemies cannot be guarded');
  assert.deepEqual(commandClick({ ...base, mode: 'guard' }), { kind: 'ignore' });
});

test('icons and cursors are CSP-safe SVG', () => {
  for (const c of COMMANDS) assert.ok(ICONS[c.id], c.id);
  for (const s of STANCES) assert.ok(ICONS[s.id], s.id);
  for (const [name, icon] of Object.entries(ICONS)) {
    assert.match(icon, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 24 24"/, name);
    assert.doesNotMatch(icon, /style=|<script|on[a-z]+=/i, `${name}: no inline style or script (CSP)`);
  }
  for (const [name, css] of Object.entries(COMMAND_CURSORS)) {
    const m = /^url\("data:image\/svg\+xml,(.+)"\) (\d+) (\d+), [a-z-]+$/.exec(css);
    assert.ok(m, name);
    assert.match(decodeURIComponent(m[1]), /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="32" height="32"/);
  }
  // Every order has a hotkey or a modifier hint for its tooltip.
  for (const c of COMMANDS) assert.ok(c.key || c.hint, c.id);
});

// ---- Key adapter -------------------------------------------------------------------------

test('local key adapter: registerAction signature, combos, repeats', () => {
  assert.equal(normalizeCombo('shift+g'), 'Shift+G');
  assert.equal(normalizeCombo('cmd+alt+x'), 'Ctrl+Alt+X');
  assert.equal(normalizeCombo('hyper+x'), null);
  const ev = (o) => ({ code: '', key: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, target: { tagName: 'CANVAS' }, preventDefault() {}, ...o });
  assert.equal(comboFromEvent(ev({ code: 'KeyG', key: 'g' })), 'G');
  assert.equal(comboFromEvent(ev({ code: 'KeyQ', key: 'a' })), 'A', 'AZERTY: the printed letter counts');
  assert.equal(comboFromEvent(ev({ code: 'Digit2', key: '@', shiftKey: true })), 'Shift+2');
  assert.equal(comboFromEvent(ev({ code: 'ShiftLeft', key: 'Shift' })), null);
  const keys = new LocalKeys();
  let ran = 0;
  const off = keys.registerAction('command-guard', 'G', () => ran++);
  assert.throws(() => keys.registerAction('command-guard', 'G', () => {}));
  assert.equal(keys.keyOf('command-guard'), 'G');
  assert.equal(keys.handle(ev({ code: 'KeyG', key: 'g' })), true);
  assert.equal(keys.handle(ev({ code: 'KeyG', key: 'g', repeat: true })), true, 'held keys do not repeat the order');
  assert.equal(keys.handle(ev({ code: 'KeyG', key: 'g', target: { tagName: 'INPUT' } })), false, 'typing in a field');
  assert.equal(keys.handle(ev({ code: 'KeyG', key: 'g', shiftKey: true })), false);
  assert.equal(ran, 1);
  off();
  assert.equal(keys.handle(ev({ code: 'KeyG', key: 'g' })), false);
});

// ---- Engine API -------------------------------------------------------------------------

test('command_state counts units, weapons and stances of own actors only', () => {
  const g = game([
    { type: 'E1', owner: 0, x: 20, y: 20, facing: 0 },
    { type: 'STNK', owner: 0, x: 22, y: 20, facing: 0 },
    { type: 'HARV', owner: 0, x: 24, y: 20, facing: 0 },
    { type: 'YAK', owner: 0, x: 26, y: 20, facing: 0 },
    { type: 'E1', owner: 1, x: 30, y: 30, facing: 0 },
    { type: 'GUN', owner: 0, x: 10, y: 20, facing: 0 },
  ]);
  const [e1, stnk, harv, yak, foe, gun] = [at(g, 20, 20), at(g, 22, 20), at(g, 24, 20), at(g, 26, 20), g.pick(1, px(30), px(30)), at(g, 10, 20)];
  for (const id of [e1, stnk, harv, yak, foe, gun]) assert.notEqual(id, NONE);
  const s = state(g, [e1, stnk, harv, yak, foe, gun]);
  assert.equal(s.units, 4, 'own units; not the enemy, not the turret');
  assert.equal(s.armed, 3);
  assert.equal(s.attackGround, 2, 'the plane cannot fire on the ground');
  assert.equal(s.guard, 3, 'planes cannot guard');
  assert.equal(s.scatter, 3);
  assert.deepEqual(s.stances, { hold_fire: 2, return_fire: 0, defend: 0, attack_anything: 2 }, 'Phase Transport and Yak hold fire; the turret has a stance');
  assert.deepEqual(state(g, []).stances, { hold_fire: 0, return_fire: 0, defend: 0, attack_anything: 0 });
  assert.equal(g.set_stance(0, ids(e1, stnk, foe, gun), 'defend'), true);
  g.tick();
  assert.deepEqual(state(g, [e1, stnk, gun]).stances, { hold_fire: 0, return_fire: 0, defend: 3, attack_anything: 0 });
  assert.equal(state(g, []).units, 0);
  // Guard and attack-ground checks for cursors.
  assert.equal(g.can_guard(0, ids(e1), stnk), true);
  assert.equal(g.can_guard(0, ids(e1), foe), false, 'not an enemy');
  assert.equal(g.can_guard(0, ids(yak), e1), false, 'planes do not guard');
  assert.equal(g.can_guard(0, ids(e1), gun), false, 'units only');
  assert.equal(g.can_attack_ground(0, ids(e1), px(25), px(25)), true);
  assert.equal(g.can_attack_ground(0, ids(harv, yak), px(25), px(25)), false);
  assert.equal(g.can_attack_ground(1, ids(e1), px(25), px(25)), false, 'not your unit');
  assert.equal(g.are_allies(0, 0), true);
  assert.equal(g.are_allies(0, 1), false);
  assert.equal(g.are_allies(0, 9), false, 'out of range');
});

test('waypoints, scatter and guard through the API', () => {
  const g = game([
    { type: '1TNK', owner: 0, x: 20, y: 20, facing: 0 },
    { type: 'E1', owner: 0, x: 18, y: 20, facing: 0 },
  ]);
  const [tank, e1] = [at(g, 20, 20), at(g, 18, 20)];
  g.order_waypoint(0, ids(tank), px(26), px(20), false);
  g.order_waypoint(0, ids(tank), px(26), px(26), false);
  g.tick();
  assert.equal(state(g, [tank]).queued, 1, 'one leg running, one queued');
  g.order_guard(0, ids(e1), tank);
  ticks(g, 600);
  const t = JSON.parse(g.actor_json(tank));
  assert.equal(state(g, [tank]).queued, 0);
  assert.equal(t.id, tank);
  // The tank drove both legs and the guard followed it.
  const near = g.pick(0, px(26), px(26));
  assert.ok(near === tank || near === e1, 'someone at the last waypoint');
  assert.equal(g.pick(0, px(20), px(20)), NONE, 'nobody left at the start');
  assert.equal(g.pick(0, px(18), px(20)), NONE);
  g.order_scatter(0, ids(tank, e1));
  g.tick();
  g.set_hover(e1);
  g.set_hover(NONE);
});

test('hover and attack targets draw health bars', () => {
  const g = game([
    { type: '1TNK', owner: 0, x: 20, y: 20, facing: 0 },
    { type: 'E1', owner: 1, x: 24, y: 24, facing: 0 },
  ]);
  const tank = at(g, 20, 20);
  const foe = g.pick(0, px(24), px(24));
  g.set_stance(0, ids(tank), 'hold_fire');
  g.tick();
  g.set_selection(ids(tank));
  const rects = () => {
    g.build_render(0, 1, 0, 0, SIZE * 24, SIZE * 24);
    return g.rect_count();
  };
  const base = rects();
  g.set_hover(foe);
  assert.equal(rects(), base + 2, 'health bar over the hovered enemy');
  g.set_hover(NONE);
  g.order_attack(0, ids(tank), foe);
  g.tick();
  assert.equal(rects(), base + 2, 'and over the target of the selection');
});

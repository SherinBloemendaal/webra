// The battlefield tooltip (js/worldtooltip.js, engine/src/tooltip.rs; OpenRA
// WorldTooltipLogic, ViewportControllerWidget, TooltipContainerWidget) and
// the range circles (engine/src/range_circles.rs): when the panel shows,
// what it says and where, and what the engine answers through
// Game.world_tooltip and Game.build_lines. Synthetic games only. Run after
// `npm run build:wasm`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initSync, Game } from '../pkg/webra_sim.js';
import {
  BOTTOM_EDGE_Y_OFFSET,
  CURSOR_OFFSET_Y,
  TooltipTimer,
  WORLD_TOOLTIP_DELAY_MS,
  WorldTooltip,
  worldTooltipContent,
  worldTooltipPosition,
} from '../js/worldtooltip.js';
import { FOLLOW_LATEST, QUERIES, QUERY_DEFAULTS, UI_STATE } from '../js/sim/methods.js';
import { installDom, uninstallDom } from './dom-fixtures.mjs';

const wasm = initSync({ module: readFileSync(fileURLToPath(new URL('../pkg/webra_sim_bg.wasm', import.meta.url))) });

test('OpenRA TooltipContainerWidget: 200 ms delay, 20 px under the cursor, kept on screen', () => {
  assert.equal(WORLD_TOOLTIP_DELAY_MS, 200);
  assert.equal(CURSOR_OFFSET_Y, 20);
  assert.equal(BOTTOM_EDGE_Y_OFFSET, -5);
  const view = { width: 800, height: 600 };
  const size = { width: 120, height: 50 };
  assert.deepEqual(worldTooltipPosition({ x: 100, y: 100 }, size, view), { x: 100, y: 120 });
  assert.deepEqual(worldTooltipPosition({ x: 750, y: 100 }, size, view), { x: 680, y: 120 }, 'moved left to end at the right edge');
  assert.deepEqual(worldTooltipPosition({ x: 100, y: 560 }, size, view), { x: 100, y: 505 }, 'above the cursor at the bottom edge');
});

test('the tooltip shows once the mouse rests over the battlefield', () => {
  const t = new TooltipTimer();
  assert.equal(t.update(1000, true, 10, 10), false, 'just moved');
  assert.equal(t.update(1150, true, 10, 10), false);
  assert.equal(t.update(1201, true, 10, 10), true, 'after 200 ms');
  assert.equal(t.update(1250, true, 11, 10), false, 'moving hides it');
  assert.equal(t.update(1300, false, 11, 10), false, 'off the battlefield');
  assert.equal(t.update(1350, true, 11, 10), false, 'coming back counts as a move');
  assert.equal(t.update(1551, true, 11, 10), true);
});

test('content: name, owner row in the owner colour and extra lines; refund only for actors', () => {
  const ctx = { nameOf: (o) => ['Ann', 'Bob'][o], colorOf: (o) => [[1, 0, 0], [0, 0.5, 1]][o] };
  assert.equal(worldTooltipContent(null, ctx), null);
  assert.deepEqual(worldTooltipContent({ kind: 'unexplored', label: 'Unrevealed Terrain', owner: null }, ctx), {
    label: 'Unrevealed Terrain',
    owner: null,
    extras: [],
  });
  const tip = { kind: 'actor', label: 'Heavy Tank', id: 7, owner: 1, faction: 'russia', extras: ['Captured'] };
  assert.deepEqual(worldTooltipContent(tip, { ...ctx, refund: 350 }), {
    label: 'Heavy Tank',
    owner: { name: 'Bob', color: 'rgb(0, 128, 255)', faction: 'russia' },
    extras: ['Captured', 'Refund: $350'],
  });
  assert.deepEqual(worldTooltipContent({ ...tip, kind: 'frozen' }, { ...ctx, refund: 350 }).extras, ['Captured'], 'no refund for remembered structures');
  // OpenRA Sellable shows the refund whenever it may be sold: walls (CustomSellValue 0) say $0; -1 (or none) cannot be sold.
  assert.deepEqual(worldTooltipContent(tip, { ...ctx, refund: 0 }).extras, ['Captured', 'Refund: $0']);
  assert.deepEqual(worldTooltipContent(tip, { ...ctx, refund: -1 }).extras, ['Captured']);
  assert.deepEqual(worldTooltipContent(tip, ctx).extras, ['Captured']);
});

test('the worker proxy asks world_tooltip like pick and sends the placement as UI state', () => {
  assert.ok(QUERIES.includes('world_tooltip'));
  assert.equal(QUERY_DEFAULTS.world_tooltip(), 'null');
  assert.ok(FOLLOW_LATEST.has('world_tooltip'), 'the newest mouse position answers');
  assert.ok(UI_STATE.includes('set_placing'));
  assert.equal(typeof Game.prototype.world_tooltip, 'function');
  assert.equal(typeof Game.prototype.set_placing, 'function');
});

function skirmish() {
  const options = {
    seed: 21,
    mapSize: 64,
    players: [
      { slot: 0, type: 'human', name: 'A', faction: 'england', color: 0, team: 0 },
      { slot: 1, type: 'human', name: 'B', faction: 'russia', color: 1, team: 0 },
    ],
    startingCash: 5000,
    startingUnits: 'light',
    techLevel: 'unrestricted',
    gameSpeed: 'normal',
    fog: true,
    explored: false,
    buildRadius: true,
    redeployableMcv: true,
    oreRegrowth: true,
    techBuildings: 'none',
    mapStyle: 'land',
    crates: false,
    shortGame: true,
    bounty: false,
    separateTeamSpawns: true,
    allyBuildRadius: true,
    timeLimit: 0,
    reusableEngineers: false,
  };
  return Game.from_options(JSON.stringify(options));
}

test('Game.world_tooltip: own units, enemies under the shroud, spectators', () => {
  const game = skirmish();
  game.tick();
  // A unit of player 0's start (box selection: its combat units).
  const [unit] = Array.from(game.select_box(0, -1e9, -1e9, 1e9, 1e9, false, false));
  const info = JSON.parse(game.actor_json(unit));
  assert.equal(info.owner, 0);
  const [x, y] = game.units_center(0, Uint32Array.from([unit]));
  const hash = game.state_hash();
  const own = JSON.parse(game.world_tooltip(0, x, y, false, false));
  assert.equal(own.kind, 'actor');
  assert.equal(own.label, info.name);
  assert.equal(own.owner, 0);
  assert.equal(own.faction, 'england');
  assert.equal(own.id, unit);
  // The enemy has not explored player 0's base: shroud there.
  assert.deepEqual(JSON.parse(game.world_tooltip(1, x, y, false, false)), { kind: 'unexplored', label: 'Unrevealed Terrain', id: null, owner: null, faction: null, extras: [] });
  // Spectators see it with no shroud.
  assert.equal(JSON.parse(game.world_tooltip(Game.observer_player(), x, y, false, false)).label, info.name);
  assert.equal(game.world_tooltip(0, -100, -100, false, false), 'null', 'off the map');
  assert.equal(game.state_hash(), hash, 'asking changes nothing');
});

test('range circles: placing a defence draws OpenRA dashed circles into the line buffer', () => {
  const game = skirmish();
  game.tick();
  const [sx, sy] = game.start_position(0);
  const lines = () => {
    const n = game.build_lines(0, 1, false);
    return Array.from({ length: n }, (_, k) => Array.from(new Float32Array(wasm.memory.buffer, game.path_ptr() + k * 36, 9)));
  };
  assert.equal(lines().length, 0);
  const [cx, cy] = [Math.floor(sx / 24) + 4, Math.floor(sy / 24) + 4];
  game.set_placing('GUN', cx, cy);
  const l = lines();
  assert.equal(l.length, 64, '32 dashes, each a border and a line');
  const [border, line] = l;
  assert.deepEqual(border.slice(4, 8).map((v) => Math.round(v * 255)), [0, 0, 0, 96], 'BorderColor 96 alpha black');
  assert.equal(border[8], 3, 'BorderWidth 3');
  assert.deepEqual(line.slice(4, 8).map((v) => Math.round(v * 255)), [255, 255, 0, 128], 'Color 128 alpha yellow');
  assert.equal(line[8], 1, 'Width 1');
  // The first dash starts east of the footprint centre at the turret's range.
  const center = [cx * 24 + 12, cy * 24 + 12];
  const radius = line[0] - center[0];
  assert.ok(radius > 24 * 4, `a weapon range: ${radius}`);
  assert.ok(Math.abs(line[1] - center[1]) < 1e-3);
  game.set_placing('POWR', cx, cy);
  assert.equal(lines().length, 0, 'no circle for a power plant');
  game.set_placing('', 0, 0);
  assert.equal(lines().length, 0);
});

test('the panel: label, owner row and extras from the query, hidden until the mouse rests', () => {
  const doc = installDom();
  try {
    let answer = JSON.stringify({ kind: 'actor', label: 'Pillbox', id: 3, owner: 1, faction: 'england', extras: ['Line two'] });
    const asked = [];
    const game = {
      world_tooltip: (...a) => {
        asked.push(a);
        return answer;
      },
      sell_value: () => -1,
    };
    const canvas = { getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600 }) };
    const input = {
      mouse: { x: 50, y: 60, inside: true, touch: false },
      canvas,
      mode: null,
      toWorld: (x, y) => ({ x: x + 1000, y: y + 2000 }),
      heldMods: () => ({ ctrl: false, alt: true, shift: false }),
    };
    const tip = new WorldTooltip({ input, game, view: () => 4, player: 0, nameOf: () => 'Bob', colorOf: () => [0, 0, 1], doc });
    const panel = doc.querySelector('#world-tooltip');
    tip.frame(1000);
    assert.equal(panel.hidden, true, 'not before the delay');
    assert.equal(asked.length, 0, 'not asked while moving');
    tip.frame(1300);
    assert.equal(panel.hidden, false);
    assert.deepEqual(asked.at(-1), [4, 1050, 2060, false, true], 'the view, the world point, the modifiers');
    assert.equal(panel.querySelector('.world-tooltip-label').textContent, 'Pillbox');
    assert.equal(panel.querySelector('.world-tooltip-owner-name').textContent, 'Bob');
    assert.equal(panel.querySelector('.world-tooltip-flag').dataset.faction, 'england');
    assert.equal(panel.querySelector('.world-tooltip-extras').textContent, 'Line two');
    answer = 'null';
    tip.frame(1400);
    assert.equal(panel.hidden, true, 'nothing there');
    answer = JSON.stringify({ kind: 'actor', label: 'Pillbox', id: 3, owner: 0, faction: 'england', extras: [] });
    game.sell_value = () => 300;
    input.mode = 'sell';
    tip.frame(1500);
    assert.equal(panel.querySelector('.world-tooltip-extras').textContent, 'Refund: $300', 'OpenRA Sellable in sell mode');
    input.drag = true;
    tip.frame(1600);
    assert.equal(panel.hidden, true, 'not while box selecting');
  } finally {
    uninstallDom();
  }
});

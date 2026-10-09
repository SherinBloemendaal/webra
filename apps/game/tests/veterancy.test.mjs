// Veterancy and prone infantry (engine/src/veterancy.rs) through the wasm API:
// the debug menu's level up cheat, actor_json rank and experience, the
// selection panel text, and the art: rank decorations and prone poses in the
// atlas slots the engine draws. Run after `npm run build:wasm`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initSync, Game } from '../pkg/webra_sim.js';
import { spriteList, SPECIAL_SLOTS } from '../js/sprites.js';
import { DECORATION_SPECIALS } from '../js/art/decorations.js';
import { PRONE_DRAW, VETERANCY_SPECIALS } from '../js/art/veterancy.js';
import { CIVILIAN_DRAW } from '../js/art/world.js';
import { veterancyText } from '../js/sidebar.js';

initSync({ module: readFileSync(fileURLToPath(new URL('../pkg/webra_sim_bg.wasm', import.meta.url))) });

const OPTIONS = {
  seed: 99,
  mapSize: 64,
  players: [
    { slot: 0, type: 'human', name: 'A', faction: 'russia', color: 0, team: 0 },
    { slot: 1, type: 'human', name: 'B', faction: 'england', color: 1, team: 0 },
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
  cheats: false,
};

const newGame = (cheats) => Game.from_options(JSON.stringify({ ...OPTIONS, cheats }));
const ticks = (game, n) => {
  for (let i = 0; i < n; i++) game.tick();
};
const info = (game, id) => JSON.parse(game.actor_json(id));
/** Player p's own units of type `type`. */
const own = (game, p, type) => Array.from(game.select_box(p, -1e9, -1e9, 1e9, 1e9)).filter((id) => info(game, id).type === type);

test('actor_json reports rank, experience and prone state', () => {
  const game = newGame(false);
  const [rifle] = own(game, 0, 'E1');
  const a = info(game, rifle);
  // A rookie rifleman ($100): level 1 at 200 value points of kills.
  assert.deepEqual([a.rank, a.maxRank, a.xp, a.nextXp, a.prone], [0, 4, 0, 200, false]);
});

test('the level up cheat raises own units one rank, only with the cheats option', () => {
  for (const cheats of [false, true]) {
    const game = newGame(cheats);
    const rifles = own(game, 0, 'E1');
    const enemy = own(game, 1, 'E1');
    assert.ok(rifles.length >= 2 && enemy.length >= 1);
    game.dev_experience(0, Uint32Array.from([rifles[0], enemy[0]]));
    ticks(game, 2);
    assert.equal(info(game, rifles[0]).rank, cheats ? 1 : 0, `cheats ${cheats}`);
    assert.equal(info(game, rifles[1]).rank, 0, 'unselected units keep their rank');
    assert.equal(info(game, enemy[0]).rank, 0, 'never the enemy');
    if (cheats) {
      const a = info(game, rifles[0]);
      assert.deepEqual([a.xp, a.nextXp], [200, 400]);
      for (let i = 0; i < 5; i++) game.dev_experience(0, Uint32Array.from([rifles[0]]));
      ticks(game, 2);
      assert.equal(info(game, rifles[0]).rank, 4, 'elite is the last rank');
    }
  }
});

test('in lockstep the cheat is an order that goes on the wire', () => {
  const game = newGame(true);
  game.set_lockstep(true);
  const [rifle] = own(game, 0, 'E1');
  game.dev_experience(0, Uint32Array.from([rifle]));
  ticks(game, 3);
  assert.equal(info(game, rifle).rank, 0, 'nothing happens before the frame');
  assert.deepEqual(JSON.parse(game.take_orders()), [{ o: 'dev_experience', player: 0, ids: [rifle] }]);
});

test('the selection panel names the rank and shows experience of own units', () => {
  const unit = (rank, xp, nextXp, prone = false) => ({ rank, maxRank: 4, xp, nextXp, prone });
  assert.equal(veterancyText(unit(0, 50, 200), true), 'Rookie  XP 50/200');
  assert.equal(veterancyText(unit(2, 450, 800), true), 'Veteran II  XP 450/800');
  assert.equal(veterancyText(unit(3, 900, 1600), false), 'Veteran III');
  assert.equal(veterancyText(unit(4, 1600, 1600), true), 'Elite');
  assert.equal(veterancyText(unit(1, 200, 400, true), false), 'Veteran  Prone');
  assert.equal(veterancyText({ maxRank: 0, rank: 0, xp: 0, nextXp: 0, prone: false }, true), '');
  assert.equal(veterancyText(null, true), '');
});

test('prone poses and rank decorations sit in the sprite slots the engine draws', () => {
  const rules = JSON.parse(readFileSync(fileURLToPath(new URL('../../../engine/rules.json', import.meta.url)), 'utf8'));
  const actors = rules.actors.map((a) => ({ ...a, width: a.building?.width, height: a.building?.height }));
  const list = spriteList(actors);
  // engine/src/render.rs SpriteIds: 12 built-in specials, then 8 slots per art module; veterancy is the fifth.
  const base = actors.length * 2 + 12 + 4 * SPECIAL_SLOTS;
  // The repair and power down marks (art/decorations.js) are the sixth and last.
  assert.equal(list.length, base + 2 * SPECIAL_SLOTS);
  VETERANCY_SPECIALS.forEach((s, k) => assert.equal(list[base + k], s));
  DECORATION_SPECIALS.forEach((s, k) => assert.equal(list[base + SPECIAL_SLOTS + k], s));
  for (const [k, a] of actors.entries()) {
    if (a.kind !== 'infantry') continue;
    const key = a.id.replace(/R1$/, '');
    // Infantry have no turret: their second slot is the prone pose (civilians, without prone art, stand).
    assert.equal(list[2 * k + 1], PRONE_DRAW[key] ?? CIVILIAN_DRAW[key]?.body, a.id);
    assert.ok(list[2 * k + 1], `${a.id} has a second pose`);
  }
});

test('veterancy art draws within its box', () => {
  const draws = [...VETERANCY_SPECIALS, ...DECORATION_SPECIALS, ...Object.values(PRONE_DRAW)];
  for (const [w, h, draw] of draws) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const see = (x, y) => {
      assert.ok(Number.isFinite(x) && Number.isFinite(y));
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    };
    const ctx = {
      fillStyle: '#000',
      strokeStyle: '#000',
      lineWidth: 1,
      lineCap: 'butt',
      beginPath() {},
      closePath() {},
      moveTo: see,
      lineTo: see,
      fill() {},
      stroke() {},
      fillRect(x, y, rw, rh) {
        see(x, y);
        see(x + rw, y + rh);
      },
      arc(x, y, r) {
        see(x - r, y - r);
        see(x + r, y + r);
      },
      ellipse(x, y, rx, ry) {
        see(x - rx, y - ry);
        see(x + rx, y + ry);
      },
    };
    draw(ctx, { team: () => '#888', c: (c) => c });
    assert.ok(minX >= -0.01 && minY >= -0.01 && maxX <= w + 0.01 && maxY <= h + 0.01, `art leaves its ${w}x${h} box: ${minX},${minY} ${maxX},${maxY}`);
  }
});

// A map format version registry for tests (packages/protocol mapversions.js
// shape): format 3, with one migration step of each kind a real format change
// may need. Shared by the protocol, client and server tests.
//
// Format 2 renamed OLDTREE to T01, removed GONE, split MIX into A1 and A2,
// turned river (9) into rock (2), retired terrain 7 (bridge) without one
// replacement, renamed the actor override field unit.spd to unit.speed and
// dropped `oldfield`; format 3 moved `notes` to `description`, made `biome`
// required (default temperate) and renamed the biome `arctic` to `snow`
// (and removed `lava`).

import {
  addField,
  encodeBase64,
  moveField,
  remapTerrain,
  renameActors,
  renameRuleFields,
  renameValues,
} from '../../src/index.js';

export const NAMES = ['clear', 'rough', 'rock', 'water', 'tree', 'ford', 'road', 'bridge', 'beach', 'river', 'wall'];

export function testVersions(extra = {}) {
  return {
    current: 3,
    history: [
      { version: 1, lastGame: '0.9', summary: 'baseline' },
      { version: 2, lastGame: '1.0', summary: 'actor and terrain renames' },
      { version: 3, lastGame: null, summary: 'fields moved' },
    ],
    migrations: [
      {
        from: 1,
        to: 2,
        summary: 'actor and terrain renames',
        migrate(map, ctx) {
          renameActors(map, { OLDTREE: 'T01', GONE: null, MIX: ['A1', 'A2'] }, ctx);
          remapTerrain(map, { 9: 2, 7: { fallback: 0, choices: [0, 6], reason: 'bridges are actors now' } }, ctx, NAMES);
          renameRuleFields(map, 'actors', [[['unit', 'spd'], ['unit', 'speed']], [['oldfield'], null]], ctx);
        },
      },
      {
        from: 2,
        to: 3,
        summary: 'fields moved',
        migrate(map, ctx) {
          moveField(map, ['notes'], ['description'], ctx);
          addField(map, ['biome'], 'temperate', ctx);
          renameValues(map, ['biome'], { arctic: 'snow', lava: null }, ctx, ['temperate', 'desert']);
        },
      },
    ],
    ...extra,
  };
}

/** A format 1 map of the test registry (32 x 32, `cells`: terrain index to code). */
export function v1Map(extra = {}, cells = {}, w = 32) {
  const terrain = new Uint8Array(w * w);
  for (const [i, t] of Object.entries(cells)) terrain[Number(i)] = t;
  return {
    format: 1,
    name: 'Old',
    author: 'Someone',
    notes: 'from the notes field',
    width: w,
    height: w,
    terrain: encodeBase64(terrain),
    ore: encodeBase64(new Uint8Array(w * w)),
    spawns: [
      [2, 2],
      [20, 20],
    ],
    actors: [
      { type: 'oldtree', owner: -1, x: 10, y: 10 },
      { type: 'SBAG', owner: -1, x: 11, y: 10 },
    ],
    rules: { actors: { E1: { unit: { spd: 5 } } } },
    biome: 'arctic',
    ...extra,
  };
}

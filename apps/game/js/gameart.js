// The sprite atlas a game draws with, and the engine settings that go with
// it: WebRA's own art, or the original graphics and texture packs the player
// installed (js/content). The game (js/main.js) and the map editor
// (editor/editor.js) build it the same way, so the editor shows a map exactly
// as a game on it looks.

import { buildAtlas } from './sprites.js';

/**
 * The rules_json actors as the art sees them: a mission's own actor draws
 * the art of its art key (engine rules_json `art`).
 */
export function artActors(actors) {
  return actors.map((a) => (a.art ? { ...a, id: a.art } : a));
}

/**
 * Build the atlas for `actors` (artActors) on a map of `biome`: installed
 * content first (`content`: a js/content ContentSystem, or null), WebRA's art
 * where it has none or when its atlas does not fit the device.
 * @returns {{ atlas: object, original: { slots: Uint32Array, info: Int32Array } | null, report: object | null }}
 */
export function buildGameAtlas(content, actors, biome, maxSize = 8192) {
  const art = content?.art(actors, biome) ?? null;
  let atlas = null;
  let original = null;
  if (art?.slots.size) {
    try {
      atlas = buildAtlas(actors, { slots: art.slots, layers: art.layers, filter: art.filter, maxSize, biome });
      original = art.original;
    } catch (err) {
      console.warn('Installed graphics do not fit; using WebRA art:', err);
    }
    if (art.report.problems.length) console.info('Installed graphics:', art.report);
  }
  atlas ??= buildAtlas(actors, { biome });
  return { atlas, original, report: art?.report ?? null };
}

/**
 * Tell a game (an engine Game, or the simulation proxy) how to draw with
 * `atlas`: slots with original art are drawn the OpenRA way (rotors, effects,
 * projectiles, overlays), animated building layers and pre-rendered poses
 * (the original graphics, texture packs and WebRA's own pixel art),
 * and the death sequences of art that has them.
 */
export function applyGameArt(game, atlas, original) {
  game.set_original_slots(original?.slots ?? new Uint32Array(0), original?.info ?? new Int32Array(0));
  game.set_building_overlays(atlas.overlays);
  game.set_sprite_poses(atlas.poses ?? atlas.filter === 'nearest');
  game.set_death_art(Uint32Array.from(atlas.deaths), Uint32Array.from(atlas.deathTicks));
}

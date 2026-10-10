// A map's thumbnail (docs/contracts.md section 2, "Map setup"): one pixel per
// cell, drawn from the map data alone (terrain in the biome's preview
// colours, ore and gems, pre-placed actors, spawns in the lobby colours).
// Never from art, so no original Red Alert graphics ever end up in it. The
// server serves it as a PNG for the map list; the map editor shows the same
// picture. The colours follow the engine's map preview (engine/src/lib.rs
// preview_rgba) and the map editor's minimap.

import { decodeBase64 } from './base64.js';

/** Preview colours per terrain code (engine map.rs Terrain), per biome. */
export const BIOME_PREVIEW_COLORS = Object.freeze({
  temperate: [
    [62, 88, 44],
    [96, 92, 58],
    [128, 118, 102],
    [36, 70, 102],
    [28, 54, 24],
    [74, 112, 118],
    [118, 104, 82],
    [140, 116, 80],
    [176, 160, 112],
    [44, 82, 112],
    [96, 96, 92],
  ],
  snow: [
    [206, 214, 222],
    [158, 196, 222],
    [112, 114, 124],
    [34, 62, 96],
    [40, 66, 58],
    [110, 150, 182],
    [150, 150, 150],
    [132, 112, 86],
    [176, 180, 176],
    [46, 78, 110],
    [92, 94, 102],
  ],
  desert: [
    [200, 168, 110],
    [218, 188, 124],
    [150, 94, 60],
    [38, 116, 138],
    [92, 122, 58],
    [112, 168, 158],
    [170, 136, 92],
    [124, 96, 64],
    [226, 204, 150],
    [52, 124, 140],
    [128, 100, 76],
  ],
});
export const PREVIEW_ORE = Object.freeze([200, 160, 50]);
export const PREVIEW_GEMS = Object.freeze([190, 70, 150]);
/** The lobby colours (apps/game/js/renderer.js TEAM_PALETTE) in 0..255, and neutral actors. */
export const PREVIEW_TEAM = Object.freeze([
  [77, 140, 242],
  [230, 64, 51],
  [242, 204, 64],
  [89, 204, 102],
  [204, 115, 242],
  [242, 140, 51],
  [102, 217, 217],
  [217, 217, 217],
]);
export const PREVIEW_NEUTRAL = Object.freeze([199, 184, 153]);

/** Spawns are the top-left cell of a 3 x 4 construction yard. */
const YARD_W = 3;
const YARD_H = 4;

/**
 * The thumbnail of a validated map (any format version): `{ width, height,
 * rgba }`, one pixel per cell. Actors mark their top-left cell (the server
 * has no footprints); spawns fill their yard in the slot's lobby colour, or
 * the colour the map gives the slot.
 */
export function mapThumbnail(map) {
  const { width, height } = map;
  const n = width * height;
  const terrain = decodeBase64(map.terrain, 'terrain');
  const ore = decodeBase64(map.ore, 'ore');
  const gems = map.gems ? decodeBase64(map.gems, 'gems') : new Uint8Array(n);
  const colors = BIOME_PREVIEW_COLORS[map.biome] ?? BIOME_PREVIEW_COLORS.temperate;
  const rgba = new Uint8ClampedArray(n * 4);
  const put = (i, c) => {
    rgba[i * 4] = c[0];
    rgba[i * 4 + 1] = c[1];
    rgba[i * 4 + 2] = c[2];
    rgba[i * 4 + 3] = 255;
  };
  for (let i = 0; i < n; i++) put(i, gems[i] > 0 ? PREVIEW_GEMS : ore[i] > 0 ? PREVIEW_ORE : (colors[terrain[i]] ?? [0, 0, 0]));
  const slotColor = (k) => {
    const c = map.players?.[k]?.color;
    return PREVIEW_TEAM[Number.isInteger(c) && c >= 0 ? c : k % PREVIEW_TEAM.length];
  };
  for (const a of map.actors ?? []) {
    if (a.x < 0 || a.y < 0 || a.x >= width || a.y >= height) continue;
    put(a.y * width + a.x, a.owner >= 0 ? slotColor(a.owner) : PREVIEW_NEUTRAL);
  }
  (map.spawns ?? []).forEach(([sx, sy], k) => {
    for (let dy = 0; dy < YARD_H; dy++) {
      for (let dx = 0; dx < YARD_W; dx++) {
        const x = sx + dx;
        const y = sy + dy;
        if (x < width && y < height) put(y * width + x, slotColor(k));
      }
    }
  });
  return { width, height, rgba };
}

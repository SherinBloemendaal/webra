// Convert the map of an OpenRA mission (map.yaml + map.bin) with the game's
// .oramap importer (apps/game/js/oramap), for tools/gen_missions.py.
//
//   node tools/mission-map.mjs <mission folder>  < {"actors": ["e1", "v01", ...]}
//
// stdin names the actor types (lower case) the mission has as actors (built-in
// rules, mission rules, script props and markers). Map actors of other types
// that are decorations (trees, rocks, ice; apps/game/js/oramap/tables.js)
// become terrain like in an imported map; the rest are listed as actors with
// their OpenRA inits. The map is cropped to its Bounds: `origin` is the
// OpenRA cell of the first WebRA cell. Writes JSON to stdout.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseMiniYaml, child, childValue, parseIntPair, parseIntQuad } from '../apps/game/js/oramap/miniyaml.js';
import { readMapBin } from '../apps/game/js/oramap/mapbin.js';
import { convertTerrain, TILESET_BIOMES } from '../apps/game/js/oramap/convert.js';
import { DECORATIONS } from '../apps/game/js/oramap/tables.js';
import { encodeBase64, TERRAIN } from '../apps/game/editor/js/mapformat.js';

const folder = process.argv[2];
if (!folder) {
  console.error('usage: node tools/mission-map.mjs <mission folder>');
  process.exit(2);
}
const input = JSON.parse(readFileSync(0, 'utf8'));
const actorTypes = new Set(input.actors);

const yaml = parseMiniYaml(readFileSync(join(folder, 'map.yaml'), 'utf8'), 'map.yaml');
const bin = readMapBin(new Uint8Array(readFileSync(join(folder, 'map.bin'))));
const tileset = String(childValue(yaml, 'Tileset', '')).trim().toUpperCase();
const [bx, by, bw, bh] = parseIntQuad(childValue(yaml, 'Bounds')) ?? [0, 0, bin.width, bin.height];
const report = { warnings: [] };
const { full, ore, gems } = convertTerrain({ tileset, bin, bounds: [bx, by, bw, bh] }, report);

const nodeInits = (nodes) => Object.fromEntries(nodes.map((n) => [n.key, n.nodes.length ? nodeInits(n.nodes) : String(n.value ?? '')]));

const actors = [];
const decorated = new Map();
for (const node of child(yaml, 'Actors')?.nodes ?? []) {
  const type = String(node.value ?? '').trim();
  const loc = parseIntPair(childValue(node.nodes, 'Location'));
  if (!type || !loc) continue;
  const lower = type.toLowerCase();
  const deco = DECORATIONS[type.toUpperCase()];
  if (!actorTypes.has(lower) && deco) {
    for (const [dx, dy] of deco.cells) {
      const x = loc[0] + dx;
      const y = loc[1] + dy;
      if (x < 0 || y < 0 || x >= bin.width || y >= bin.height) continue;
      const i = y * bin.width + x;
      full[i] = deco.kind === 'tree' ? TERRAIN.TREE : TERRAIN.ROCK;
      ore[i] = 0;
      gems[i] = 0;
    }
    decorated.set(lower, (decorated.get(lower) ?? 0) + 1);
    continue;
  }
  actors.push({ name: node.key, type: lower, inits: nodeInits(node.nodes) });
}

const terrain = new Uint8Array(bw * bh);
const oreOut = new Uint8Array(bw * bh);
const gemsOut = new Uint8Array(bw * bh);
for (let y = 0; y < bh; y++) {
  for (let x = 0; x < bw; x++) {
    const si = (by + y) * bin.width + bx + x;
    terrain[y * bw + x] = full[si];
    oreOut[y * bw + x] = ore[si];
    gemsOut[y * bw + x] = gems[si];
  }
}
const players = (child(yaml, 'Players')?.nodes ?? []).map((p) => nodeInits(p.nodes));
const hasGems = gemsOut.some((g) => g > 0);
const biome = TILESET_BIOMES[tileset] === 'snow' || TILESET_BIOMES[tileset] === 'desert' ? TILESET_BIOMES[tileset] : 'temperate';

process.stdout.write(
  JSON.stringify({
    title: String(childValue(yaml, 'Title', '')).trim(),
    author: String(childValue(yaml, 'Author', '')).trim(),
    tileset,
    origin: [bx, by],
    map: {
      width: bw,
      height: bh,
      terrain: encodeBase64(terrain),
      ore: encodeBase64(oreOut),
      ...(hasGems ? { gems: encodeBase64(gemsOut) } : {}),
      ...(biome !== 'temperate' ? { biome } : {}),
    },
    players,
    actors,
    decorations: Object.fromEntries([...decorated].sort()),
    warnings: report.warnings,
  }),
);

// The map editor's tile worker: plans the original graphics' terrain tiles
// (js/content/terrain.js originalTerrain) off the main thread, which takes
// from a fraction of a second to seconds on big maps. The main thread side is
// editor/js/tiles.js (TileWorker); docs/contracts.md (section 8) lists the
// messages.
//
//   in:  { t: 'theater', key, tileset, files: [name, bytes][] }  the theater to tile with
//        { t: 'plan', id, key, bytes, w, h, hints }              engine terrain bytes (and terrain hints) to tile
//   out: { t: 'planned', id, result }                            originalTerrain's result or null
//        { t: 'failed', id, error }

import { planTiles } from './tiles.js';

/** Where messages go: the worker global in browsers; tests may install another port first. */
const port = globalThis.__webraTilesPort ?? globalThis;

let theater = null;

port.onmessage = (e) => {
  const m = e.data;
  if (m?.t === 'theater') {
    theater = { key: m.key, tileset: m.tileset, files: new Map(m.files) };
    return;
  }
  if (m?.t !== 'plan') return;
  try {
    if (!theater || theater.key !== m.key) throw new Error('no theater for this plan');
    const result = planTiles(theater, m.bytes, m.w, m.h, m.hints ?? null);
    const transfer = result ? [result.atlas.data.buffer, result.cells.buffer] : [];
    port.postMessage({ t: 'planned', id: m.id, result }, transfer);
  } catch (err) {
    port.postMessage({ t: 'failed', id: m.id, error: String(err?.message ?? err) });
  }
};

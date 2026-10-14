// The lobby preview worker (js/mappreview.js): generates the preview of a
// generated map and its start positions off the main thread, so New seed,
// a size or style change and the player count never freeze the lobby.
//
// Messages: { t: 'init', module } (the engine's compiled WebAssembly.Module)
// answered by { t: 'ready' } or { t: 'failed', error }; then
// { t: 'gen', id, seed, size, players, style, biome } answered by
// { t: 'done', id, rgba, spawns } (rgba transferred; spawns flat x, y pairs)
// or { t: 'error', id, error }.

import { Game, initSync } from '../pkg/webra_sim.js';

/** Where messages go: the worker global in browsers; tests may install another port first. */
const port = globalThis.__webraPreviewPort ?? globalThis;
let ready = false;

port.onmessage = ({ data: msg }) => {
  if (msg?.t === 'init') {
    try {
      initSync({ module: msg.module });
      ready = true;
      port.postMessage({ t: 'ready' });
    } catch (err) {
      port.postMessage({ t: 'failed', error: String(err?.message ?? err) });
    }
    return;
  }
  if (msg?.t !== 'gen') return;
  try {
    if (!ready) throw new Error('the engine is not loaded');
    const { id, seed, size, players, style, biome } = msg;
    const rgba = Game.map_preview_styled(seed, size, players, style, biome);
    const spawns = Game.map_spawns_styled(seed, size, players, style);
    const bytes = rgba instanceof Uint8Array ? rgba : new Uint8Array(rgba);
    port.postMessage({ t: 'done', id, rgba: bytes, spawns: Array.from(spawns) }, [bytes.buffer]);
  } catch (err) {
    port.postMessage({ t: 'error', id: msg.id, error: String(err?.message ?? err) });
  }
};

// The game engine inside the Worker: the same WebAssembly build the players
// run, so the server judges maps exactly like every client does.
import { initSync, Game } from '../../game/pkg/webra_sim.js';
import wasmModule from '#engine-wasm';

let ready = false;

function engine() {
  if (!ready) {
    initSync({ module: wasmModule });
    ready = true;
  }
  return Game;
}

/** Engine verdict on a map file: `{ ok, errors, modded, hash }`. */
export function engineValidateMap(canonicalJson) {
  return JSON.parse(engine().validate_map(canonicalJson));
}

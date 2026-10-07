// The engine's compiled WebAssembly module for Node (tests, local tools).
import { readFileSync } from 'node:fs';

export default new WebAssembly.Module(readFileSync(new URL('../../game/pkg/webra_sim_bg.wasm', import.meta.url)));

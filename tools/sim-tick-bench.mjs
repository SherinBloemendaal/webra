// Headless benchmark of the simulation's ticks in WebAssembly: the stress
// test (two armies attack-moving into each other, as the lobby's "Stress
// test" starts it) stepped in node with the game's own wasm build, the
// counterpart of the native `cargo run -p webra-sim --release --example
// sim_bench` (docs/contracts.md, "Simulation performance").
//
//   npm run build:wasm
//   node tools/sim-tick-bench.mjs [units] [ticks] [seed] [--window N]
//
// Prints the average and worst tick per window and over the run, the time
// `build_render` takes for the whole map in view and the wasm memory, and
// the final state hash: the native benchmark prints the same hash for the
// same units, ticks and seed (the simulation is integer only and gives the
// same result on every platform).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
let window = 250;
const pos = [];
for (let k = 0; k < args.length; k++) {
  if (args[k] === '--window') window = Number(args[++k]);
  else pos.push(args[k]);
}
const units = Number(pos[0] ?? 20000);
const ticks = Number(pos[1] ?? 1000);
const seed = Number(pos[2] ?? 1);

const root = new URL('../apps/game/', import.meta.url);
const { initSync, Game } = await import(new URL('pkg/webra_sim.js', root));
const wasm = initSync({ module: readFileSync(fileURLToPath(new URL('pkg/webra_sim_bg.wasm', root))) });
// The map size of the game's stress test (js/main.js startStress).
const size = Math.max(96, Math.ceil(Math.sqrt(units) * 2.2));

const t0 = performance.now();
const g = Game.new_stress(seed, units, size);
console.log(`setup: ${units} units on a ${size}x${size} map, seed ${seed}, in ${(performance.now() - t0).toFixed(1)} ms (wasm, node ${process.versions.node})`);
const all = [];
let win = [];
for (let t = 1; t <= ticks; t++) {
  const s = performance.now();
  g.tick();
  const ms = performance.now() - s;
  all.push(ms);
  win.push(ms);
  if (t % window === 0 || t === ticks) {
    const avg = win.reduce((a, b) => a + b, 0) / win.length;
    console.log(
      `ticks ${String(t + 1 - win.length).padStart(5)}-${String(t).padStart(5)}: avg ${avg.toFixed(2).padStart(6)} ms, worst ${Math.max(...win).toFixed(2).padStart(7)} ms; ${g.actor_count()} actors`,
    );
    win = [];
  }
}
/** Average, median, 95th percentile and worst of tick times. */
function summary(ms) {
  const sorted = ms.slice().sort((a, b) => a - b);
  const avg = ms.reduce((a, b) => a + b, 0) / ms.length;
  const pct = (p) => sorted[Math.floor((sorted.length - 1) * p)];
  return `avg ${avg.toFixed(2)} ms/tick, median ${pct(0.5).toFixed(2)}, p95 ${pct(0.95).toFixed(2)}, worst ${sorted.at(-1).toFixed(2)}`;
}
console.log(`${ticks} ticks: ${summary(all)}; budget 40 ms`);
// The first tick starts every unit's move at once (all route searches).
if (all.length > 1) console.log(`after the first tick (${all[0].toFixed(2)} ms): ${summary(all.slice(1))}`);
// The CPU instance path's per-frame build with the whole map in view.
const rect = [0, 0, size * 24, size * 24];
const build = [];
for (let k = 0; k < 20; k++) {
  const s = performance.now();
  g.build_render(0, 0.5, ...rect);
  build.push(performance.now() - s);
}
console.log(`build_render (whole map in view): ${(build.reduce((a, b) => a + b, 0) / build.length).toFixed(2)} ms per frame`);
console.log(`wasm memory ${(wasm.memory.buffer.byteLength / 1048576).toFixed(0)} MiB`);
console.log(`final tick ${g.tick_count()}, state hash ${g.state_hash()}`);

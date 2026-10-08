// Headless benchmark of the main thread's share of a frame in the stress
// test (20,000 units), with the simulation on the main thread (direct) and in
// a worker (transfer, shared). No browser and no GPU: it times the CPU work
// the main thread does per animation frame (stepping or posting the step,
// handling the frame message, and copying the render data as the renderer's
// writeBuffer does), and the cost of the parts a GPU compute pass could take
// over (instance building with interpolation and culling, in the engine).
//
//   npm run build:wasm
//   node tools/sim-bench.mjs [units] [frames]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const units = Number(process.argv[2] ?? 20000);
const frames = Number(process.argv[3] ?? 600);
const FRAME_MS = 1000 / 60;
const TICK_MS = 40;

const root = new URL('../apps/game/', import.meta.url);
const { initSync, Game } = await import(new URL('pkg/webra_sim.js', root));
const { createSimHost } = await import(new URL('js/sim/host.js', root));
const { NodeWorker, nodeEnv } = await import(new URL('tests/sim-fixtures.mjs', root));
const bytes = readFileSync(fileURLToPath(new URL('pkg/webra_sim_bg.wasm', root)));
const wasm = initSync({ module: bytes });
const module = new WebAssembly.Module(bytes);
const size = Math.max(96, Math.ceil(Math.sqrt(units) * 2.2));
const rect = [0, 0, size * 24, size * 24]; // zoomed out over the whole map: every unit is drawn

const stats = (xs) => {
  const s = xs.slice().sort((a, b) => a - b);
  const avg = s.reduce((a, b) => a + b, 0) / s.length;
  return { avg: avg.toFixed(2), p95: s[Math.floor(s.length * 0.95)].toFixed(2), max: s.at(-1).toFixed(2) };
};

async function run(mode) {
  const host =
    mode === 'direct'
      ? await createSimHost({ Game, memory: () => wasm.memory, env: nodeEnv('direct') })
      : await createSimHost({ Game, memory: () => wasm.memory, module, env: nodeEnv(mode), WorkerClass: NodeWorker });
  await host.start({ kind: 'stress', seed: 1, units, size, tickMs: TICK_MS });
  // Time spent handling frame messages on this thread.
  let messageMs = 0;
  if (host.worker) {
    const handler = host.worker.onmessage;
    host.worker.onmessage = (e) => {
      const t = performance.now();
      handler(e);
      messageMs += performance.now() - t;
    };
  }
  const main = [];
  const worker = [];
  let ticks = 0;
  let lastId = 0;
  const start = performance.now();
  for (let i = 0; i < frames; i++) {
    const t0 = performance.now();
    const msgBefore = messageMs;
    const f = host.step({ dt: FRAME_MS, view: 0, rect, audio: false });
    if (f) {
      // What the renderer does with it: writeBuffer copies the data.
      f.sprites().slice();
      f.rects().slice();
      f.fog().slice();
      if (f.id !== lastId) {
        lastId = f.id;
        ticks += f.ticks;
        worker.push(f.simFrameMs);
      }
    }
    const spent = performance.now() - t0;
    // Wait for the next frame time; message handling in between counts too.
    const next = start + (i + 1) * FRAME_MS;
    while (performance.now() < next) await new Promise((r) => setImmediate(r));
    main.push(spent + (messageMs - msgBefore));
  }
  const wall = performance.now() - start;
  host.dispose();
  return { mode: host.mode, main: stats(main), ticksPerSecond: ((ticks * 1000) / wall).toFixed(1), workerSimPerFrame: worker.length ? stats(worker) : null };
}

/** The instance building a GPU interpolation pass would replace: build_render alone. */
function buildRenderCost() {
  const g = Game.new_stress(1, units, size);
  for (let t = 0; t < 50; t++) g.tick();
  const xs = [];
  let count = 0;
  for (let i = 0; i < 200; i++) {
    if (i % 3 === 0) g.tick();
    const t0 = performance.now();
    count = g.build_render(0, (i % 3) / 3, ...rect);
    xs.push(performance.now() - t0);
  }
  return { sprites: count, buildRenderMs: stats(xs) };
}

console.log(`stress test: ${units} units on a ${size}x${size} map, ${frames} frames at 60 fps, whole map in view`);
for (const mode of ['direct', 'transfer', 'shared']) console.log(JSON.stringify(await run(mode)));
console.log(JSON.stringify(buildRenderCost()));
process.exit(0);

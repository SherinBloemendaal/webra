// Headless benchmark of the render data path in the stress test (20,000
// units): the simulation on the main thread (direct) and in a worker
// (transfer, shared), each with both instance paths (js/crowd.js):
//
//   cpu  the simulation builds interpolated, culled sprites and rects every
//        frame (Game.build_render) and sends them; the renderer uploads them
//   gpu  the simulation builds tick-rate records (Game.build_render_records)
//        only when a tick (or the selection, the view) changed them and sends
//        them then; the GPU pass interpolates and culls every frame
//
// at 60 and 144 render frames per second. No browser and no GPU: it times
// the CPU side for real (the worker's instance build per frame, the main
// thread's step, frame message and the copies the renderer's writeBuffer
// makes) and counts the render data bytes per frame. The GPU pass itself
// (shaders/instances.wgsl) does not run here and is not measured.
//
//   npm run build:wasm
//   node tools/sim-bench.mjs [units] [seconds per run]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const units = Number(process.argv[2] ?? 20000);
const seconds = Number(process.argv[3] ?? 4);
const TICK_MS = 40;

const root = new URL('../apps/game/', import.meta.url);
const { initSync, Game } = await import(new URL('pkg/webra_sim.js', root));
const { createSimHost } = await import(new URL('js/sim/host.js', root));
const { recordBytes } = await import(new URL('js/crowd.js', root));
const { NodeWorker, nodeEnv } = await import(new URL('tests/sim-fixtures.mjs', root));
const bytes = readFileSync(fileURLToPath(new URL('pkg/webra_sim_bg.wasm', root)));
const wasm = initSync({ module: bytes });
const module = new WebAssembly.Module(bytes);
const size = Math.max(96, Math.ceil(Math.sqrt(units) * 2.2));
const rect = [0, 0, size * 24, size * 24]; // zoomed out over the whole map: every unit is drawn

const stats = (xs) => {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const avg = s.reduce((a, b) => a + b, 0) / s.length;
  return { avg: +avg.toFixed(3), p95: +s[Math.floor(s.length * 0.95)].toFixed(3), max: +s.at(-1).toFixed(3) };
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

async function run(mode, path, fps) {
  const frameMs = 1000 / fps;
  const frames = Math.round(seconds * fps);
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
  const build = [];
  const buildTicks = [];
  const sent = [];
  let uploaded = 0;
  let ticks = 0;
  let lastId = 0;
  let lastGen = -1;
  let lastFog = null;
  const start = performance.now();
  for (let i = 0; i < frames; i++) {
    const t0 = performance.now();
    const msgBefore = messageMs;
    const f = host.step({ dt: frameMs, view: 0, rect, audio: false, instances: path });
    if (f) {
      // What the renderer does with it: writeBuffer copies the data.
      if (f.instances === 'gpu') {
        const r = f.records();
        if (r && r.gen !== lastGen) {
          lastGen = r.gen;
          r.sprites.slice();
          r.extras.slice();
          r.rects.slice();
          uploaded += recordBytes(r);
        }
      } else {
        uploaded += f.sprites().slice().byteLength + f.rects().slice().byteLength;
      }
      const fog = f.fog();
      if (f.instances !== 'gpu' || fog !== lastFog) {
        fog.slice();
        uploaded += fog.byteLength;
        lastFog = fog;
      }
      if (f.id !== lastId) {
        lastId = f.id;
        ticks += f.ticks;
        build.push(f.buildMs);
        sent.push(f.renderBytes);
        if (f.ticks > 0) buildTicks.push(f.buildMs);
      }
    }
    const spent = performance.now() - t0;
    // Wait for the next frame time; message handling in between counts too.
    const next = start + (i + 1) * frameMs;
    while (performance.now() < next) await new Promise((r) => setImmediate(r));
    main.push(spent + (messageMs - msgBefore));
  }
  const wall = performance.now() - start;
  host.dispose();
  return {
    mode: host.mode,
    path,
    fps,
    frames,
    simFrames: build.length,
    ticksPerSecond: +((ticks * 1000) / wall).toFixed(1),
    // The simulation side's instance build per simulation frame (in the worker, or this thread for direct).
    buildMsPerFrame: stats(build),
    buildMsOnTickFrames: stats(buildTicks),
    // Render data handed over per simulation frame, and uploaded per render frame.
    bytesPerFrame: Math.round(mean(sent)),
    uploadBytesPerRenderFrame: Math.round(uploaded / frames),
    mainMsPerFrame: stats(main),
  };
}

/** The engine alone: build_render every frame against build_render_records once per tick. */
function engineCost() {
  const g = Game.new_stress(1, units, size);
  for (let t = 0; t < 50; t++) g.tick();
  const cpu = [];
  const gpu = [];
  let sprites = 0;
  let records = 0;
  for (let i = 0; i < 200; i++) {
    if (i % 3 === 0) g.tick();
    let t0 = performance.now();
    sprites = g.build_render(0, (i % 3) / 3, ...rect);
    cpu.push(performance.now() - t0);
    t0 = performance.now();
    records = g.build_render_records(0);
    gpu.push(performance.now() - t0);
  }
  const extras = g.record_extra_count();
  const rects = g.rect_record_count();
  return {
    sprites,
    buildRenderMs: stats(cpu),
    instanceBytes: sprites * 32 + g.rect_count() * 32,
    records,
    recordExtras: extras,
    rectRecords: rects,
    buildRenderRecordsMs: stats(gpu),
    recordBytes: (records * 13 + extras * 12 + rects * 13) * 4,
  };
}

console.log(`stress test: ${units} units on a ${size}x${size} map, ${seconds} s per run, whole map in view`);
console.log(JSON.stringify(engineCost()));
for (const fps of [60, 144]) {
  for (const mode of ['direct', 'transfer', 'shared']) {
    for (const path of ['cpu', 'gpu']) console.log(JSON.stringify(await run(mode, path, fps)));
  }
}
process.exit(0);

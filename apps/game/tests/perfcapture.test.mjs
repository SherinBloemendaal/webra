// Performance capture (js/perfcapture.js, js/gputimer.js, docs/contracts.md
// section 10): bounded buffers, the file's schema and export, the summary,
// the start trace, long task watching, GPU timing with a fake device, the
// simulation's step timings, and tile terrain that stays the same while it
// got faster. Synthetic data only. Run after `npm run build:wasm`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initSync, Game } from '../pkg/webra_sim.js';
import {
  CAPTURE_SECONDS,
  captureFileName,
  cleanDetail,
  environmentFacts,
  FRAME_FIELDS,
  GC_HINT_MB,
  loafDetail,
  MAX_STARTUP,
  optionFacts,
  PERF_FORMAT,
  PERF_VERSION,
  PerfCapture,
  PerfRecorder,
  PerfTrace,
  percentile,
  PRIVACY_NOTE,
  saveText,
  scriptSource,
  settingsFacts,
  summarize,
  watchLongTasks,
} from '../js/perfcapture.js';
import { GPU_TIMER_POOL, GpuTimer } from '../js/gputimer.js';
import { captureStatus } from '../js/debug.js';
import { SimCore } from '../js/sim/core.js';
import { originalTerrain } from '../js/content/terrain.js';
import { createSettings } from '../js/settings.js';
import { syntheticTheater } from './content-fixtures.mjs';
import { SKIRMISH } from './sim-fixtures.mjs';

const wasm = initSync({ module: readFileSync(fileURLToPath(new URL('../pkg/webra_sim_bg.wasm', import.meta.url))) });

/** A clock the test moves by hand. */
function fakeClock(start = 1000) {
  const c = { t: start };
  c.now = () => c.t;
  return c;
}

const sample = (k) => ({ frameMs: 16 + (k % 3), workMs: 4, stepMs: 0.5, drawMs: 1.5, workerMs: 2, ticks: k % 2, tickMaxMs: 1, buildMs: 0.3, queryMs: 0.1, roundTripMs: 6, uploadKB: 64, sprites: 300, tick: k, actors: 900, wasmMB: 40 });

test('a capture keeps frames in fixed columns and ends when its time is up', () => {
  const clock = fakeClock();
  const cap = new PerfCapture({ seconds: 1, now: clock.now });
  assert.equal(cap.active, true);
  for (let k = 0; k < 10; k++) {
    clock.t += 50;
    assert.equal(cap.frame(sample(k), clock.t), k);
  }
  assert.equal(cap.count, 10);
  assert.equal(cap.columns.t[0], 50);
  assert.equal(cap.columns.tick[9], 9);
  assert.ok(Number.isNaN(cap.columns.gpuMs[0]), 'no GPU time until the GPU sends one');
  cap.late(3, 'gpuMs', 2.5);
  cap.late(3, 'frameMs', 99);
  cap.late(99, 'gpuMs', 1);
  assert.equal(cap.columns.gpuMs[3], 2.5);
  assert.notEqual(cap.columns.frameMs[3], 99, 'only the late fields can be set later');
  clock.t += 600;
  assert.equal(cap.frame(sample(10), clock.t), -1, 'past the requested seconds');
  assert.equal(cap.active, false);
  assert.equal(cap.endReason, 'time');
  assert.equal(cap.frame(sample(11), clock.t + 1), -1, 'an ended capture takes nothing');
  assert.equal(cap.count, 10);
});

test('a capture is bounded: full buffers end it, extra events are counted, not kept', () => {
  const clock = fakeClock();
  const cap = new PerfCapture({ seconds: 60, now: clock.now, capacity: 5, maxEvents: 3 });
  for (let k = 0; k < 5; k++) assert.equal(cap.frame(sample(k), (clock.t += 10)), k);
  assert.equal(cap.frame(sample(5), (clock.t += 10)), -1);
  assert.equal(cap.endReason, 'full');
  const open = new PerfCapture({ now: clock.now, maxEvents: 3 });
  for (let k = 0; k < 7; k++) open.event('span', `work ${k}`, clock.t, 5);
  assert.equal(open.events.length, 3);
  assert.equal(open.droppedEvents, 4);
  // Every column is preallocated: memory does not grow with the frames.
  for (const f of FRAME_FIELDS) assert.equal(cap.columns[f].length, 5);
  // Lengths are clamped to what the menu offers at most.
  assert.equal(new PerfCapture({ seconds: 100000 }).seconds, Math.max(...CAPTURE_SECONDS));
});

test('the JS heap is sampled every 250 ms and a drop is a garbage collection hint', () => {
  const clock = fakeClock();
  let used = 100 * 1024 * 1024;
  const cap = new PerfCapture({ now: clock.now, memory: () => ({ usedJSHeapSize: used }) });
  cap.frame(sample(0), (clock.t += 16));
  cap.frame(sample(1), (clock.t += 16));
  used -= (GC_HINT_MB + 4) * 1024 * 1024;
  clock.t += 300;
  cap.frame(sample(2), clock.t);
  assert.equal(cap.columns.heapMB[0], 100);
  assert.ok(Number.isNaN(cap.columns.heapMB[1]), 'between samples');
  assert.equal(cap.columns.heapMB[2], 95);
  const gc = cap.events.filter((e) => e.kind === 'gc-hint');
  assert.equal(gc.length, 1);
  assert.equal(gc[0].detail.freedMB, 5);
  // Browsers without performance.memory: no heap column values, no hints.
  const none = new PerfCapture({ now: clock.now });
  none.frame(sample(0), clock.t + 1);
  assert.ok(Number.isNaN(none.columns.heapMB[0]));
});

test('the file: format, version, summary on top, columns, null for none, privacy, valid JSON', () => {
  const clock = fakeClock();
  const cap = new PerfCapture({ seconds: 30, reason: 'manual', now: clock.now });
  for (let k = 0; k < 20; k++) cap.frame(sample(k), (clock.t += 16));
  cap.event('span', 'atlas.sprites', clock.t - 100, 80, { width: 2048, height: 2728 });
  cap.stop();
  const file = cap.toFile(
    { build: { version: '0.13.0' }, environment: { userAgent: 'Test' }, settings: { lowQuality: false }, game: { mode: 'skirmish', players: 8 } },
    { spans: [{ name: 'sim.start', t: 5, ms: 40 }], dropped: 0 },
  );
  assert.equal(Object.keys(file)[0], 'format');
  assert.deepEqual(Object.keys(file).slice(0, 4), ['format', 'version', 'summary', 'privacy']);
  assert.equal(file.format, PERF_FORMAT);
  assert.equal(file.version, PERF_VERSION);
  assert.equal(file.privacy, PRIVACY_NOTE);
  assert.deepEqual(file.frameFields, FRAME_FIELDS);
  for (const f of FRAME_FIELDS) assert.equal(file.frames[f].length, 20, f);
  assert.equal(file.frames.gpuMs[0], null);
  assert.equal(file.frames.tick[19], 19);
  assert.equal(file.capture.frames, 20);
  assert.equal(file.capture.endReason, 'stopped');
  assert.equal(file.capture.reason, 'manual');
  assert.equal(file.game.players, 8);
  assert.equal(file.startup.spans[0].name, 'sim.start');
  const back = JSON.parse(JSON.stringify(file));
  assert.deepEqual(back.frames.frameMs, file.frames.frameMs);
  assert.doesNotMatch(JSON.stringify(file), /[\u2013\u2014]/);
});

test('the summary: percentiles, hitches, the worst frames with what ran during them, where the time went', () => {
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2);
  assert.equal(percentile([5], 0.95), 5);
  assert.equal(percentile([], 0.5), 0);
  const n = 100;
  const frames = Object.fromEntries(FRAME_FIELDS.map((f) => [f, new Array(n).fill(null)]));
  let t = 0;
  for (let i = 0; i < n; i++) {
    const ms = i === 40 ? 700 : i === 70 ? 120 : 16;
    t += ms;
    frames.t[i] = t;
    frames.frameMs[i] = ms;
    frames.workMs[i] = i === 40 ? 690 : 3;
    frames.workerMs[i] = 1;
    frames.tickMaxMs[i] = i === 70 ? 55 : 1;
  }
  const events = [
    { t: frames.t[40] - 650, kind: 'span', name: 'terrain.tiles', ms: 640 },
    { t: frames.t[40] - 650, kind: 'longtask', name: 'self', ms: 660 },
    { t: 10, kind: 'span', name: 'audio.synth', ms: 3 },
    { t: 20, kind: 'span', name: 'audio.synth', ms: 5 },
    { t: 30, kind: 'gc-hint', name: 'heap drop', ms: 0, detail: { freedMB: 12 } },
  ];
  const s = summarize({ frames, count: n, events, startup: [{ name: 'atlas.sprites', t: 100, ms: 300 }, { name: 'first-frame', t: 900, ms: 0 }], durationMs: t });
  assert.equal(s.frames, n);
  assert.equal(s.hitches.over50ms, 2);
  assert.equal(s.hitches.over100ms, 2);
  assert.equal(s.hitches.over250ms, 1);
  assert.equal(s.frameMs.max, 700);
  assert.equal(s.worstFrames[0].frameMs, 700);
  assert.equal(s.worstFrames[0].t, frames.t[40]);
  assert.deepEqual(s.worstFrames[0].during, ['longtask self 660 ms', 'terrain.tiles 640 ms']);
  assert.equal(s.worstFrames[1].frameMs, 120);
  assert.equal(s.time.spans[0].name, 'terrain.tiles');
  assert.deepEqual(s.time.spans.find((x) => x.name === 'audio.synth'), { name: 'audio.synth', count: 2, totalMs: 8, maxMs: 5 });
  assert.deepEqual(s.time.longTasks, { count: 1, totalMs: 660 });
  assert.deepEqual(s.time.gcHints, { count: 1, freedMB: 12 });
  assert.equal(s.time.tickMaxMs.max, 55);
  assert.equal(s.startup.firstFrameMs, 900);
  assert.equal(s.startup.slowest[0].name, 'atlas.sprites');
  const text = s.findings.join(' ');
  assert.match(text, /from launch to its first frame; the slowest step was atlas\.sprites \(300 ms\)/);
  assert.match(text, /The longest frame took 700 ms .* during longtask self 660 ms, terrain\.tiles 640 ms/);
  assert.match(text, /slowest simulation tick took 55 ms/);
  // A smooth capture says so.
  const calm = summarize({ frames: { t: [16, 32], frameMs: [16, 16] }, count: 2, durationMs: 32 });
  assert.match(calm.findings[0], /No frame took longer than 50 ms/);
  assert.equal(calm.time.gpuMs, null);
});

test('the start trace: spans while a game starts or a capture runs, bounded, nothing when off', () => {
  const clock = fakeClock();
  const trace = new PerfTrace(clock.now);
  let ran = 0;
  assert.equal(trace.span('idle', () => ++ran), 1, 'off: the work runs and nothing is kept');
  assert.equal(trace.startup.length, 0);
  trace.beginStartup();
  clock.t += 5;
  const out = trace.span('atlas.sprites', () => {
    clock.t += 30;
    return { width: 2048 };
  }, (r) => ({ width: r.width, name: 'x'.repeat(200) }));
  assert.deepEqual(out, { width: 2048 });
  assert.equal(trace.startup[0].name, 'atlas.sprites');
  assert.equal(trace.startup[0].t, 5);
  assert.equal(trace.startup[0].ms, 30);
  assert.equal(trace.startup[0].detail.width, 2048);
  assert.equal(trace.startup[0].detail.name.length, 80, 'long strings are cut');
  assert.throws(() => trace.span('broken', () => {
    throw new Error('boom');
  }));
  assert.equal(trace.startup.at(-1).name, 'broken', 'a span that throws is still timed');
  for (let k = 0; k < MAX_STARTUP + 5; k++) trace.mark(`m${k}`, 1);
  assert.equal(trace.startup.length, MAX_STARTUP);
  assert.ok(trace.startupDropped > 0);
  trace.endStartup();
  assert.equal(trace.inStartup, false);
  trace.span('later', () => 1);
  assert.equal(trace.startup.at(-1).name.startsWith('m'), true, 'after the first frame nothing is added');
  // A running capture gets spans as events.
  const cap = new PerfCapture({ now: clock.now });
  trace.capture = cap;
  trace.span('audio.synth', () => (clock.t += 4), { id: 'boom', variant: 1 });
  assert.deepEqual(cap.events[0], { t: 0, kind: 'span', name: 'audio.synth', ms: 4, detail: { id: 'boom', variant: 1 } });
  assert.deepEqual(cleanDetail({ a: 1.234567, b: NaN, c: {}, d: true }), { a: 1.23, b: null, d: true });
});

test('async spans time until the promise settles', async () => {
  const clock = fakeClock();
  const trace = new PerfTrace(clock.now);
  trace.beginStartup();
  const v = await trace.spanAsync('sim.start', async () => {
    clock.t += 44;
    return { timings: { createMs: 40 } };
  }, (i) => ({ engineMs: i?.timings?.createMs }));
  assert.deepEqual(v, { timings: { createMs: 40 } });
  assert.deepEqual(trace.startup[0], { name: 'sim.start', t: 0, ms: 44, detail: { engineMs: 40 } });
});

test('the recorder: one capture at a time, a file when it ends, the start spans in it', () => {
  const clock = fakeClock();
  const trace = new PerfTrace(clock.now);
  const done = [];
  let changes = 0;
  const watched = [];
  const rec = new PerfRecorder({
    trace,
    now: clock.now,
    memory: () => null,
    context: () => ({ build: { version: '0.13.0' }, game: { mode: 'skirmish' } }),
    onDone: (file, text, capture) => done.push({ file, text, capture }),
    onChange: () => changes++,
    watch: (capture) => {
      watched.push(capture);
      return { types: [], stop: () => watched.push('stopped') };
    },
  });
  trace.beginStartup();
  trace.mark('content.load', 3);
  rec.start({ seconds: 1, reason: 'start' });
  assert.equal(rec.recording, true);
  assert.equal(trace.capture, rec.capture);
  for (let k = 0; k < 5; k++) rec.frame(sample(k), (clock.t += 100));
  assert.deepEqual(rec.progress(), { seconds: 0.5, of: 1, reason: 'start' });
  rec.frame(sample(9), (clock.t += 600));
  assert.equal(rec.recording, false, 'the time ran out');
  assert.equal(done.length, 1);
  assert.equal(trace.capture, null);
  assert.deepEqual(watched.slice(-1), ['stopped']);
  const { file, text } = done[0];
  assert.equal(file.capture.frames, 5);
  assert.equal(file.startup.spans[0].name, 'content.load');
  assert.deepEqual(JSON.parse(text).summary, file.summary);
  assert.match(rec.last.name, /^webra-perf-0\.13\.0-\d{8}-\d{6}\.json$/);
  assert.ok(changes >= 2);
  // Stop early: the file comes at once.
  rec.start({ seconds: 30 });
  rec.frame(sample(0), (clock.t += 16));
  const stopped = rec.stop();
  assert.equal(stopped.capture.endReason, 'stopped');
  assert.equal(done.length, 2);
  assert.equal(rec.stop(), null, 'nothing to stop');
  assert.equal(rec.frame(sample(1), clock.t + 1), -1);
});

test('long tasks and long animation frames: observed where supported, script addresses cut to the path', () => {
  const origin = 'https://webra.sherin.dev';
  assert.equal(scriptSource('https://webra.sherin.dev/play/js/main.js?v=3#x', origin), '/play/js/main.js');
  assert.equal(scriptSource('chrome-extension://abcdef/content.js', origin), 'extension');
  assert.equal(scriptSource('moz-extension://abcdef/content.js', origin), 'extension');
  assert.equal(scriptSource('https://tracker.example/x.js', origin), 'other origin');
  assert.equal(scriptSource('', origin), '');
  const d = loafDetail(
    {
      startTime: 100,
      duration: 200,
      blockingDuration: 150,
      renderStart: 280,
      styleAndLayoutStart: 290,
      scripts: [
        { duration: 20, invoker: 'https://webra.sherin.dev/play/?join=123 onclick', sourceURL: 'chrome-extension://id/a.js', sourceFunctionName: 'x', forcedStyleAndLayoutDuration: 0 },
        { duration: 170, invoker: 'FrameRequestCallback', sourceURL: 'https://webra.sherin.dev/play/js/main.js', sourceFunctionName: 'frame', forcedStyleAndLayoutDuration: 3 },
      ],
    },
    origin,
  );
  assert.equal(d.blockingMs, 150);
  assert.equal(d.renderMs, 20);
  assert.equal(d.scripts[0].fn, 'frame');
  assert.equal(d.scripts[0].source, '/play/js/main.js');
  assert.equal(d.scripts[1].source, 'extension');
  assert.doesNotMatch(JSON.stringify(d), /join=123/, 'no addresses with queries');

  const observers = [];
  class FakeObserver {
    static supportedEntryTypes = ['longtask', 'long-animation-frame', 'paint'];
    constructor(cb) {
      this.cb = cb;
      observers.push(this);
    }
    observe(o) {
      this.type = o.type;
    }
    disconnect() {
      this.gone = true;
    }
  }
  const clock = fakeClock(0);
  const cap = new PerfCapture({ now: clock.now });
  const w = watchLongTasks(cap, { Observer: FakeObserver, origin });
  assert.deepEqual(w.types, ['longtask', 'long-animation-frame']);
  observers[0].cb({ getEntries: () => [{ name: 'self', startTime: 50, duration: 80 }] });
  observers[1].cb({ getEntries: () => [{ startTime: 60, duration: 90, scripts: [] }] });
  assert.deepEqual(cap.events.map((e) => [e.kind, e.ms]), [['longtask', 80], ['loaf', 90]]);
  w.stop();
  assert.ok(observers.every((o) => o.gone));
  // A browser without them: nothing watched, nothing breaks.
  assert.deepEqual(watchLongTasks(cap, { Observer: undefined }).types, []);
});

test('static facts: browser and screen, perf settings, options without names', () => {
  const win = {
    navigator: { userAgent: 'Mozilla/5.0 Test', hardwareConcurrency: 8, deviceMemory: 8, userAgentData: { brands: [{ brand: 'Chromium', version: '140' }], mobile: false, platform: 'macOS' } },
    devicePixelRatio: 2,
    innerWidth: 1512,
    innerHeight: 860,
    screen: { width: 1512, height: 982 },
    crossOriginIsolated: true,
    PerformanceObserver: { supportedEntryTypes: ['longtask', 'mark'] },
    performance: { memory: { jsHeapSizeLimit: 4 * 1024 * 1024 * 1024 } },
  };
  const env = environmentFacts(win, { vendor: 'apple', architecture: 'metal-3' });
  assert.equal(env.devicePixelRatio, 2);
  assert.deepEqual(env.viewport, { width: 1512, height: 860 });
  assert.deepEqual(env.brands, ['Chromium 140']);
  assert.deepEqual(env.observers, ['longtask']);
  assert.equal(env.jsHeapLimitMB, 4096);
  assert.equal(env.gpu.vendor, 'apple');
  const s = settingsFacts(createSettings(null));
  assert.equal(s.lowQuality, false);
  assert.equal(s.pixelRatioCap, 2);
  const o = optionFacts({ ...SKIRMISH, players: [{ slot: 0, type: 'human', name: 'Sherin', faction: 'england', team: 1 }, { type: 'ai', name: 'Bot', difficulty: 'hard', faction: 'russia' }] });
  assert.equal(o.seed, SKIRMISH.seed);
  assert.equal(o.startingCash, SKIRMISH.startingCash);
  assert.deepEqual(o.players[0], { type: 'human', faction: 'england', team: 1, difficulty: null, bot: null });
  assert.doesNotMatch(JSON.stringify(o), /Sherin|Bot/);
  assert.equal(optionFacts(null), null);
  assert.equal(captureFileName('0.13.0', new Date(2026, 9, 13, 9, 5, 7)), 'webra-perf-0.13.0-20261013-090507.json');
  assert.equal(captureFileName(null, new Date(2026, 0, 2, 3, 4, 5)), 'webra-perf-dev-20260102-030405.json');
});

test('saving a capture offers a JSON file download', () => {
  const clicks = [];
  const doc = {
    body: { append: () => {} },
    createElement: () => ({ click() { clicks.push({ href: this.href, download: this.download }); }, remove() {} }),
  };
  const urls = [];
  const { createObjectURL, revokeObjectURL } = URL;
  URL.createObjectURL = (blob) => (urls.push(blob), 'blob:test');
  URL.revokeObjectURL = () => {};
  try {
    saveText('webra-perf-x.json', '{"format":"webra-perf"}', doc);
  } finally {
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
  }
  assert.deepEqual(clicks, [{ href: 'blob:test', download: 'webra-perf-x.json' }]);
  assert.equal(urls[0].type, 'application/json');
});

test('the debug menu status line', () => {
  assert.equal(captureStatus(null, null), 'No capture yet.');
  assert.equal(captureStatus({ seconds: 12.7, of: 30, reason: 'manual' }, null), 'Recording: 12 of 30 s');
  assert.equal(captureStatus({ seconds: 3, of: 60, reason: 'start' }, null), 'Recording the start of the game: 3 of 60 s');
  assert.equal(captureStatus(null, { capture: { durationMs: 30012, frames: 1790 }, summary: { frameMs: { max: 812.4 } } }), 'Last capture: 30.0 s, 1790 frames, worst frame 812 ms.');
});

/** A fake WebGPU device for the timer: buffers map to fixed timestamps. */
function fakeDevice({ timestamps = true } = {}) {
  const calls = [];
  const pending = [];
  const device = {
    features: new Set(timestamps ? ['timestamp-query'] : []),
    createQuerySet: (d) => (calls.push(['querySet', d.count]), { kind: 'querySet' }),
    createBuffer: (d) => {
      const buf = {
        size: d.size,
        mapAsync: () => new Promise((resolve) => pending.push(resolve)),
        getMappedRange: () => new BigUint64Array([1_000_000n, 3_500_000n]).buffer,
        unmap: () => calls.push(['unmap']),
      };
      calls.push(['buffer', d.size]);
      return buf;
    },
    queue: { onSubmittedWorkDone: () => Promise.resolve() },
  };
  return { device, calls, pending };
}

const USAGE = { QUERY_RESOLVE: 1, COPY_SRC: 2, MAP_READ: 4, COPY_DST: 8 };
const MAP = { READ: 1 };

test('GPU timer: timestamps around the render pass, read back later, a bounded pool, submit-to-done always', async () => {
  const { device, calls, pending } = fakeDevice();
  let t = 0;
  const timer = new GpuTimer(device, { usage: USAGE, mapMode: MAP, now: () => t });
  assert.equal(timer.timestamps, true);
  const got = [];
  const frame = { gpu: (ms) => got.push(['gpu', ms]), done: (ms) => got.push(['done', ms]) };
  const timing = timer.begin(frame);
  assert.equal(timing.pass.timestampWrites.beginningOfPassWriteIndex, 0);
  assert.equal(timing.pass.timestampWrites.endOfPassWriteIndex, 1);
  const enc = { resolveQuerySet: (...a) => calls.push(['resolve', a[1], a[2]]), copyBufferToBuffer: () => calls.push(['copy']) };
  timing.resolve(enc);
  t = 7;
  timing.submitted();
  t = 12;
  await Promise.resolve();
  pending.shift()();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(got.sort(), [['done', 5], ['gpu', 2.5]]);
  assert.ok(calls.some((c) => c[0] === 'resolve' && c[1] === 0 && c[2] === 2));
  // The pool: at most GPU_TIMER_POOL frames in flight; more frames go without timestamps.
  const open = [];
  for (let k = 0; k < GPU_TIMER_POOL + 2; k++) {
    const tm = timer.begin({});
    tm.submitted();
    open.push(tm);
  }
  assert.equal(open.filter((tm) => tm.pass.timestampWrites).length, GPU_TIMER_POOL);
  assert.equal(calls.filter((c) => c[0] === 'buffer' && c[1] === 16).length, GPU_TIMER_POOL + 1, 'the resolve buffer and the pool');
  // Without the feature: no pass changes, only the submit-to-done time.
  const plain = new GpuTimer(fakeDevice({ timestamps: false }).device, { usage: USAGE, mapMode: MAP, now: () => 0 });
  assert.equal(plain.timestamps, false);
  const tm = plain.begin({ done: (ms) => got.push(['plain', ms]) });
  assert.deepEqual(tm.pass, {});
  tm.resolve({ resolveQuerySet: () => assert.fail('no queries'), copyBufferToBuffer: () => assert.fail('no copy') });
  tm.submitted();
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(got.some((g) => g[0] === 'plain'));
});

test('the simulation reports its tick, query and step times, and actors only for a capture', () => {
  const core = new SimCore({ Game, memory: () => wasm.memory });
  const info = core.start({ kind: 'skirmish', options: SKIRMISH, map: null, player: 0, recorder: null, tickMs: 40 });
  assert.ok(info.timings.createMs >= 0);
  assert.ok(info.terrain instanceof Uint8Array);
  assert.equal(info.terrain.length, info.mapWidth * info.mapHeight * 4, 'the start terrain for the art before the first frame');
  const plain = core.step({ dt: 100, view: 0, rect: [0, 0, 800, 600], instances: 'cpu' });
  assert.equal(plain.ticks, 2);
  assert.ok(plain.tickMaxMs > 0 && plain.tickMaxMs <= plain.simFrameMs);
  assert.ok(plain.stepMs >= plain.simFrameMs);
  assert.ok(plain.queryMs >= 0);
  assert.equal(plain.actors, null);
  const perf = core.step({ dt: 40, view: 0, rect: [0, 0, 800, 600], instances: 'cpu', perf: true, queries: [['p', 'player_json', [0]]] });
  assert.ok(perf.actors > 0);
  assert.equal(perf.answers[0][0], 'p');
});

/** Deterministic land and water with coasts, rough and rock: a synthetic map's terrain bytes. */
function syntheticTerrain(w, h) {
  const t = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const d = Math.hypot(x - w / 2, y - h / 2) + 4 * Math.sin(x / 3) + 3 * Math.cos(y / 4);
      let v = d < w / 3 ? 0 : 3;
      if (v === 0 && (x * 7 + y * 13) % 29 === 0) v = 2;
      if (v === 0 && (x * 5 + y * 3) % 23 === 0) v = 1;
      if (v === 0 && Math.abs(x - y) < 1) v = 6;
      t[i] = v;
      t[i + 3] = 255;
    }
  }
  return t;
}

test('tile terrain picks the same tiles as before it got faster (coast fitting, tile pixels made once)', () => {
  const files = syntheticTheater();
  const w = 72;
  const h = 64;
  const r = originalTerrain((n) => files.get(n) ?? null, 'TEMPERAT', syntheticTerrain(w, h), w, h);
  const digest = createHash('sha256').update(r.cells).update(r.atlas.data).update(JSON.stringify(r.report)).digest('hex').slice(0, 16);
  assert.ok(r.report.coast > 100, 'the map has a coast to fit');
  // The digest of the same call before the seam cache and the early stop (commit 44a2036).
  assert.equal(digest, GOLDEN_TERRAIN);
});

const GOLDEN_TERRAIN = 'b655b04cdcdf2349';

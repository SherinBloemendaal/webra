// Performance capture: what the game spent its time on, frame by frame, as a
// JSON file the player can send (docs/contracts.md section 10). Started from
// the debug menu ("Record performance", js/debug.js), its hotkey
// (js/gamekeys.js recordPerformance), or for the first seconds of every game
// with the debug setting "Record the start of every game" (js/main.js).
//
//   perfTrace.span('atlas.sprites', () => buildGameAtlas(...), { width, height });
//   const rec = new PerfRecorder({ ... });  // js/main.js, one per page
//   rec.start({ seconds: 30, reason: 'manual' });
//   const i = rec.frame({ frameMs, ... });   // once per animation frame
//   rec.late(i, 'gpuMs', ms);                // the GPU's time, frames later (js/gputimer.js)
//   rec.stop();                              // or the time runs out: rec.onDone(file)
//
// What it records:
// - per frame (FRAME_FIELDS): the frame time, the main thread's work in the
//   frame and its parts (posting the simulation step, drawing), what the
//   simulation reported (worker time, ticks, the slowest tick, instance build,
//   query answers, the step's round trip), uploads, GPU time where the browser
//   has timestamp queries, the game tick, actors, JS heap and wasm memory;
// - events: spans of rare heavy work (atlas and terrain builds, uploads, sound
//   rendering and decoding: `perfTrace.span`), long tasks and long animation
//   frames (PerformanceObserver, where the browser has them, with the scripts
//   they ran), and drops of the JS heap (a hint of a garbage collection);
// - the game's start (`startup`: launch to first frame), recorded for every
//   game in a short list, so a capture started later still has it;
// - static facts: build, browser, GPU adapter, screen, settings that change
//   speed, map size, player counts and options.
//
// Privacy: no names, chat, account, map contents or URLs with queries. Script
// URLs of long frames are cut to their path on this site; other origins and
// browser extensions are named only as such (PRIVACY_NOTE goes into the file).
//
// Overhead: off, `perfTrace.span` is one check; a capture only appends
// numbers to preallocated typed arrays, with fixed limits on frames
// (MAX_FRAMES) and events (MAX_EVENTS): a long capture ends early rather than
// growing. The pure parts (buffers, summary, export) have no DOM and are
// unit tested (apps/game/tests/perfcapture.test.mjs).

import { PERF_CAPTURE_SECONDS } from '../protocol/accounts.js';

/** File format name and version (docs/contracts.md section 10). */
export const PERF_FORMAT = 'webra-perf';
export const PERF_VERSION = 1;

/** Columns of the per-frame table, in file order. Units: ms unless the name says otherwise. */
export const FRAME_FIELDS = Object.freeze([
  't', // time since the capture started, at the start of the frame
  'frameMs', // time since the previous animation frame (what the player feels)
  'workMs', // main thread time inside the game's frame callback
  'stepMs', // part of workMs: handing the frame to the simulation (direct mode: the ticks themselves)
  'drawMs', // part of workMs: building the WebGPU commands of the frame
  'gpuMs', // GPU time of the frame's render pass (timestamp queries), or null
  'gpuDoneMs', // from the frame's submit until the GPU finished it
  'workerMs', // simulation time of the newest frame (ticks, in the worker when there is one)
  'workerStepMs', // the whole simulation step of the newest frame (ticks, queries, render data)
  'ticks', // ticks the newest simulation frame ran
  'tickMaxMs', // the slowest of those ticks
  'buildMs', // the simulation's render data build (sprites or GPU records)
  'queryMs', // the simulation's answers to UI queries
  'roundTripMs', // a step's way to the worker and back (0 on the main thread)
  'uploadKB', // texture and buffer uploads of the frame
  'sprites', // sprites drawn (CPU instance path) or 0
  'tick', // game tick
  'actors', // actors in the world, or null
  'heapMB', // used JS heap (Chrome only), sampled every HEAP_SAMPLE_MS, else null
  'wasmMB', // engine (wasm) memory
]);

/** Most frames one capture keeps: 120 s at 250 frames per second. */
export const MAX_FRAMES = 30000;
/** Most events one capture keeps; later ones are counted, not kept. */
export const MAX_EVENTS = 4000;
/** Most spans of a game's start kept. */
export const MAX_STARTUP = 64;
/** Capture lengths the debug menu offers (seconds; the setting takes only these) and the longest. */
export const CAPTURE_SECONDS = PERF_CAPTURE_SECONDS;
export const MAX_CAPTURE_SECONDS = Math.max(...PERF_CAPTURE_SECONDS);
/** How long the start-of-game capture runs (setting perfCaptureStart). */
export const START_CAPTURE_SECONDS = 60;
/** How often the JS heap is sampled during a capture. */
export const HEAP_SAMPLE_MS = 250;
/** A heap drop of at least this much between samples is reported as a likely garbage collection. */
export const GC_HINT_MB = 1;
/** Frames slower than these count as hitches in the summary. */
export const HITCH_MS = Object.freeze([50, 100, 250]);
/** Worst frames listed in the summary. */
export const WORST_FRAMES = 10;
/** Most characters of a string kept in an event's details. */
const DETAIL_TEXT_MAX = 80;

export const PRIVACY_NOTE =
  'Made by WebRA\'s performance capture on the player\'s request. It holds timings, counts, the game build, the browser (user agent), ' +
  'the GPU adapter, screen size, graphics settings, map size and name, player counts and game options. It holds no player names, ' +
  'chat, account, map contents, IP address or location; script addresses are cut to their path on the game\'s site.';

const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// ---- Spans of heavy work ----------------------------------------------------------------

/** Only short plain values go into an event's details. */
export function cleanDetail(detail) {
  if (!detail || typeof detail !== 'object') return undefined;
  const out = {};
  for (const [k, v] of Object.entries(detail)) {
    if (typeof v === 'number') out[k] = Number.isFinite(v) ? round(v) : null;
    else if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string') out[k] = v.slice(0, DETAIL_TEXT_MAX);
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Where spans of heavy work go: the running capture, and the list of the
 * current game's start (launch to first frame). One per page (`perfTrace`).
 */
export class PerfTrace {
  constructor(now = clock) {
    this.now = now;
    /** The running PerfCapture, or null. */
    this.capture = null;
    /** Spans of the current game's start: `{ name, t, ms, detail }`, t from the launch. */
    this.startup = [];
    this.startupAt = 0;
    this.inStartup = false;
    this.startupDropped = 0;
    /** Called with the name of every span that begins during a game's start (the loading screen follows them: js/loadingscreen.js). */
    this.onSpan = null;
  }

  /** Whether a span would be kept now (callers skip building details otherwise). */
  get wanted() {
    return this.inStartup || !!this.capture?.active;
  }

  /** A game is being launched: its start spans begin (the previous game's are dropped). */
  beginStartup() {
    this.startup = [];
    this.startupDropped = 0;
    this.startupAt = this.now();
    this.inStartup = true;
  }

  /** The game drew its first frame: the start is over. */
  endStartup() {
    if (!this.inStartup) return;
    this.mark('first-frame', 0);
    this.inStartup = false;
  }

  /**
   * Run `fn` and record how long it took as `name` (when wanted); returns
   * what `fn` returns. `detail` is an object of short values, or a function
   * of `fn`'s result (undefined when it threw) that makes one.
   */
  span(name, fn, detail) {
    if (!this.wanted) return fn();
    this.began(name);
    const t0 = this.now();
    let out;
    try {
      out = fn();
      return out;
    } finally {
      this.record(name, t0, this.now() - t0, typeof detail === 'function' ? detail(out) : detail);
    }
  }

  /** `span` for work that returns a promise: the time until it settles. */
  async spanAsync(name, fn, detail) {
    if (!this.wanted) return fn();
    this.began(name);
    const t0 = this.now();
    let out;
    try {
      out = await fn();
      return out;
    } finally {
      this.record(name, t0, this.now() - t0, typeof detail === 'function' ? detail(out) : detail);
    }
  }

  /** A span begins: the start's listener hears of it (a listener that throws is not the span's problem). */
  began(name) {
    if (!this.inStartup || !this.onSpan) return;
    try {
      this.onSpan(name);
    } catch (err) {
      console.warn('start span listener failed:', err);
    }
  }

  /** A point in time (`ms` 0) or a duration measured elsewhere, ending now. */
  mark(name, ms = 0, detail) {
    if (!this.wanted) return;
    this.record(name, this.now() - ms, ms, detail);
  }

  record(name, t0, ms, detail) {
    const d = cleanDetail(detail);
    if (this.inStartup) {
      if (this.startup.length < MAX_STARTUP) this.startup.push({ name, t: round(t0 - this.startupAt), ms: round(ms), ...(d ? { detail: d } : {}) });
      else this.startupDropped++;
    }
    this.capture?.event('span', name, t0, ms, d);
  }
}

/** The page's trace (js/main.js, renderer, audio, content). */
export const perfTrace = new PerfTrace();

// ---- Capture ----------------------------------------------------------------------------------

/** Round to two decimals (file size; the clocks are not finer anyway). */
export function round(v) {
  return Math.round(v * 100) / 100;
}

/**
 * One recording: per-frame columns in preallocated Float32Arrays (NaN for
 * "none") and a bounded event list. `now` is the page clock; `memory()`
 * returns `performance.memory` or null.
 */
export class PerfCapture {
  constructor({ seconds = 30, reason = 'manual', now = clock, memory = () => null, capacity = MAX_FRAMES, maxEvents = MAX_EVENTS } = {}) {
    this.seconds = Math.max(1, Math.min(MAX_CAPTURE_SECONDS, Number(seconds) || 30));
    this.reason = reason;
    this.now = now;
    this.memory = memory;
    this.capacity = Math.max(1, capacity);
    this.maxEvents = maxEvents;
    this.columns = Object.fromEntries(FRAME_FIELDS.map((f) => [f, new Float32Array(this.capacity).fill(NaN)]));
    this.count = 0;
    this.events = [];
    this.droppedEvents = 0;
    this.startedAt = now();
    this.endedAt = null;
    this.endReason = null;
    this.lastHeapAt = -Infinity;
    this.lastHeap = null;
  }

  get active() {
    return this.endedAt === null;
  }

  /** Milliseconds since the capture started (until it ended). */
  elapsed() {
    return (this.endedAt ?? this.now()) - this.startedAt;
  }

  /**
   * One animation frame, `sample` with FRAME_FIELDS keys (missing: none).
   * `at` is when the frame started (page clock). Returns the frame's index,
   * for a GPU time that comes later, or -1 when the capture has ended (time
   * up or full).
   */
  frame(sample, at = this.now()) {
    if (!this.active) return -1;
    const t = at - this.startedAt;
    if (t >= this.seconds * 1000) {
      this.stop('time');
      return -1;
    }
    if (this.count >= this.capacity) {
      this.stop('full');
      return -1;
    }
    const i = this.count++;
    const c = this.columns;
    c.t[i] = t;
    for (const f of FRAME_FIELDS) {
      if (f === 't' || f === 'heapMB') continue;
      const v = sample[f];
      if (typeof v === 'number') c[f][i] = v;
    }
    c.heapMB[i] = this.sampleHeap(at);
    return i;
  }

  /** The used JS heap (MB) every HEAP_SAMPLE_MS, NaN in between; a drop is a GC hint. */
  sampleHeap(at) {
    if (at - this.lastHeapAt < HEAP_SAMPLE_MS) return NaN;
    this.lastHeapAt = at;
    let used = null;
    try {
      used = this.memory()?.usedJSHeapSize ?? null;
    } catch {
      used = null;
    }
    if (typeof used !== 'number') return NaN;
    const mb = used / (1024 * 1024);
    if (this.lastHeap !== null && this.lastHeap - mb >= GC_HINT_MB) this.event('gc-hint', 'heap drop', at, 0, { freedMB: this.lastHeap - mb });
    this.lastHeap = mb;
    return mb;
  }

  /** A value of frame `index` that comes a few frames later: `field` 'gpuMs' or 'gpuDoneMs'. */
  late(index, field, ms) {
    if (index >= 0 && index < this.count && Number.isFinite(ms) && (field === 'gpuMs' || field === 'gpuDoneMs')) this.columns[field][index] = ms;
  }

  /**
   * An event: `kind` 'span', 'longtask', 'loaf', 'gc-hint' or 'note', `at`
   * when it started (page clock), `ms` how long it took.
   */
  event(kind, name, at, ms, detail) {
    if (!this.active) return;
    if (this.events.length >= this.maxEvents) {
      this.droppedEvents++;
      return;
    }
    const e = { t: round(at - this.startedAt), kind, name: String(name).slice(0, DETAIL_TEXT_MAX), ms: round(ms) };
    const d = detail && !Array.isArray(detail.scripts) ? cleanDetail(detail) : detail;
    if (d) e.detail = d;
    this.events.push(e);
  }

  /** End the capture (`reason`: 'time', 'full', 'stopped', 'left'). */
  stop(reason = 'stopped') {
    if (!this.active) return;
    this.endedAt = this.now();
    this.endReason = reason;
  }

  /** The frame columns as plain arrays (two decimals, null for none). */
  frameTable() {
    const out = {};
    for (const f of FRAME_FIELDS) {
      const col = this.columns[f];
      const list = new Array(this.count);
      for (let i = 0; i < this.count; i++) list[i] = Number.isNaN(col[i]) ? null : round(col[i]);
      out[f] = list;
    }
    return out;
  }

  /**
   * The capture as the file's object (docs/contracts.md section 10):
   * `context` adds the static facts (`build`, `environment`, `settings`,
   * `game`) and `startup` the spans of the game's start.
   */
  toFile(context = {}, startup = { spans: [], dropped: 0 }) {
    const frames = this.frameTable();
    const durationMs = round(this.elapsed());
    return {
      format: PERF_FORMAT,
      version: PERF_VERSION,
      summary: summarize({ frames, count: this.count, events: this.events, startup: startup.spans, durationMs }),
      privacy: PRIVACY_NOTE,
      capture: {
        reason: this.reason,
        requestedSeconds: this.seconds,
        durationMs,
        frames: this.count,
        endReason: this.endReason,
        maxFrames: this.capacity,
        droppedEvents: this.droppedEvents,
      },
      build: context.build ?? null,
      environment: context.environment ?? null,
      settings: context.settings ?? null,
      game: context.game ?? null,
      startup: { spans: startup.spans, dropped: startup.dropped ?? 0 },
      frameFields: FRAME_FIELDS,
      frames,
      events: this.events,
    };
  }
}

// ---- Summary --------------------------------------------------------------------------------

/** The `p`-th percentile (0..1) of numbers (nearest rank). */
export function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = Float64Array.from(values).sort();
  const k = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[k];
}

const sum = (list) => list.reduce((a, v) => a + (v ?? 0), 0);
const numbers = (list) => list.filter((v) => typeof v === 'number');
const stats = (list) => {
  const v = numbers(list);
  if (!v.length) return null;
  return { avg: round(sum(v) / v.length), p50: round(percentile(v, 0.5)), p95: round(percentile(v, 0.95)), max: round(Math.max(...v)) };
};

/**
 * The summary at the top of the file: how smooth it was, the worst frames
 * with what overlapped them, and where the time went. `frames` is the
 * column table (frameTable), `events` the capture's events, `startup` the
 * game's start spans.
 */
export function summarize({ frames, count, events = [], startup = [], durationMs = 0 }) {
  const n = count ?? frames.t?.length ?? 0;
  const col = (f) => (frames[f] ?? []).slice(0, n);
  const frameMs = col('frameMs');
  const work = col('workMs');
  const fps = durationMs > 0 ? round((n * 1000) / durationMs) : 0;
  const hitches = Object.fromEntries(HITCH_MS.map((ms) => [`over${ms}ms`, frameMs.filter((v) => v > ms).length]));
  // The worst frames, with what was running in them (events that overlap the frame).
  const order = [...frameMs.keys()].sort((a, b) => (frameMs[b] ?? 0) - (frameMs[a] ?? 0)).slice(0, WORST_FRAMES);
  const worst = order
    .filter((i) => typeof frameMs[i] === 'number')
    .map((i) => {
      const end = frames.t[i];
      const start = end - frameMs[i];
      const during = events
        .filter((e) => e.kind !== 'gc-hint' && e.t < end && e.t + e.ms > start)
        .sort((a, b) => b.ms - a.ms)
        .slice(0, 4)
        .map((e) => `${e.kind === 'span' ? '' : `${e.kind} `}${e.name} ${round(e.ms)} ms`);
      const row = { t: round(end), frameMs: round(frameMs[i]) };
      for (const f of ['workMs', 'stepMs', 'drawMs', 'gpuMs', 'gpuDoneMs', 'workerMs', 'workerStepMs', 'ticks', 'tickMaxMs', 'roundTripMs', 'tick']) {
        const v = frames[f]?.[i];
        if (typeof v === 'number') row[f] = round(v);
      }
      if (during.length) row.during = during;
      return row;
    });
  // Where the time went: main thread work, the simulation, the GPU, long tasks and spans by name.
  const spans = new Map();
  for (const e of events) {
    if (e.kind !== 'span') continue;
    const s = spans.get(e.name) ?? { name: e.name, count: 0, totalMs: 0, maxMs: 0 };
    s.count++;
    s.totalMs += e.ms;
    s.maxMs = Math.max(s.maxMs, e.ms);
    spans.set(e.name, s);
  }
  const longTasks = events.filter((e) => e.kind === 'longtask');
  const loafs = events.filter((e) => e.kind === 'loaf');
  const gcHints = events.filter((e) => e.kind === 'gc-hint');
  const time = {
    mainThreadMs: round(sum(numbers(work))),
    mainThreadShare: durationMs > 0 ? round(sum(numbers(work)) / durationMs) : 0,
    stepMs: stats(col('stepMs')),
    drawMs: stats(col('drawMs')),
    gpuMs: stats(col('gpuMs')),
    gpuDoneMs: stats(col('gpuDoneMs')),
    workerMs: stats(col('workerMs')),
    workerStepMs: stats(col('workerStepMs')),
    tickMaxMs: stats(col('tickMaxMs')),
    roundTripMs: stats(col('roundTripMs')),
    longTasks: { count: longTasks.length, totalMs: round(sum(longTasks.map((e) => e.ms))) },
    longAnimationFrames: { count: loafs.length, totalMs: round(sum(loafs.map((e) => e.ms))) },
    gcHints: { count: gcHints.length, freedMB: round(sum(gcHints.map((e) => e.detail?.freedMB ?? 0))) },
    spans: [...spans.values()]
      .sort((a, b) => b.totalMs - a.totalMs)
      .slice(0, 12)
      .map((s) => ({ name: s.name, count: s.count, totalMs: round(s.totalMs), maxMs: round(s.maxMs) })),
  };
  const startMs = startup.length ? round(Math.max(...startup.map((s) => s.t + s.ms))) : null;
  const slowStart = [...startup].sort((a, b) => b.ms - a.ms).slice(0, 5).map((s) => ({ name: s.name, ms: s.ms }));
  return {
    durationMs: round(durationMs),
    frames: n,
    fps,
    frameMs: stats(frameMs),
    hitches,
    worstFrames: worst,
    time,
    startup: { firstFrameMs: startMs, slowest: slowStart },
    findings: findings({ frameMs, worst, time, startMs, slowStart, fps }),
  };
}

/** A few sentences for a person reading the file: the biggest stalls and their likely cause. */
export function findings({ frameMs, worst, time, startMs, slowStart, fps }) {
  const out = [];
  if (startMs !== null && slowStart.length) {
    out.push(`The game took ${Math.round(startMs)} ms from launch to its first frame; the slowest step was ${slowStart[0].name} (${Math.round(slowStart[0].ms)} ms).`);
  }
  if (!frameMs.length) return out;
  const top = worst[0];
  if (top && top.frameMs > HITCH_MS[0]) {
    const why = top.during?.length ? `, during ${top.during.join(', ')}` : '';
    out.push(`The longest frame took ${Math.round(top.frameMs)} ms at ${(top.t / 1000).toFixed(1)} s${why}.`);
  } else {
    out.push(`No frame took longer than ${HITCH_MS[0]} ms (${fps} frames per second on average).`);
  }
  const slowFrames = frameMs.filter((v) => v > HITCH_MS[0]).length;
  if (slowFrames) out.push(`${slowFrames} of ${frameMs.length} frames took longer than ${HITCH_MS[0]} ms.`);
  if (time.spans.length && time.spans[0].totalMs >= 50) out.push(`Most time in recorded work: ${time.spans[0].name} (${Math.round(time.spans[0].totalMs)} ms in ${time.spans[0].count}).`);
  if (time.longTasks.count) out.push(`${time.longTasks.count} long tasks blocked the page for ${Math.round(time.longTasks.totalMs)} ms in all.`);
  if (time.tickMaxMs && time.tickMaxMs.max > 40) out.push(`The slowest simulation tick took ${Math.round(time.tickMaxMs.max)} ms (a tick at Normal speed has 40 ms).`);
  if (time.gpuMs && time.gpuMs.p95 > 16) out.push(`The GPU needed ${time.gpuMs.p95} ms per frame or more in 5 % of the frames: the graphics card limits the frame rate.`);
  if (time.gpuDoneMs && time.gpuDoneMs.p95 > 50) out.push(`The GPU finished 5 % of the frames ${Math.round(time.gpuDoneMs.p95)} ms or more after they were sent: it falls behind.`);
  if (time.mainThreadShare > 0.5) out.push(`The game's own frame work kept the main thread busy ${Math.round(time.mainThreadShare * 100)} % of the time.`);
  if (time.gcHints.count >= 5) out.push(`The JS heap dropped ${time.gcHints.count} times (${Math.round(time.gcHints.freedMB)} MB): garbage collection pauses are likely.`);
  return out;
}

// ---- Long tasks and long animation frames ----------------------------------------------------

/**
 * A script address in a long animation frame as the file may hold it: the
 * path on the game's own site (no query or fragment), 'extension' for
 * browser extensions, 'other origin' for anything else, '' for none.
 */
export function scriptSource(url, origin) {
  if (!url) return '';
  let u;
  try {
    u = new URL(url, origin);
  } catch {
    return 'unknown';
  }
  if (/-extension:$/.test(u.protocol) || u.protocol === 'moz-extension:' || u.protocol === 'safari-web-extension:') return 'extension';
  if (origin && u.origin === origin) return u.pathname.slice(0, DETAIL_TEXT_MAX);
  return 'other origin';
}

/** A long animation frame entry as an event detail: its timing parts and up to five scripts. */
export function loafDetail(entry, origin) {
  const scripts = (entry.scripts ?? [])
    .slice()
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 5)
    .map((s) => ({
      ms: round(s.duration),
      invoker: String(s.invoker ?? s.invokerType ?? '').replace(/https?:\/\/\S+/g, '<url>').slice(0, DETAIL_TEXT_MAX),
      source: scriptSource(s.sourceURL, origin),
      fn: String(s.sourceFunctionName ?? '').slice(0, DETAIL_TEXT_MAX),
      layoutMs: round(s.forcedStyleAndLayoutDuration ?? 0),
    }));
  const d = {
    blockingMs: round(entry.blockingDuration ?? 0),
    renderMs: entry.renderStart ? round(entry.startTime + entry.duration - entry.renderStart) : 0,
    layoutMs: entry.styleAndLayoutStart ? round(entry.startTime + entry.duration - entry.styleAndLayoutStart) : 0,
  };
  if (scripts.length) d.scripts = scripts;
  return d;
}

/**
 * Watches long tasks and long animation frames while a capture runs, with
 * the PerformanceObserver `Observer` (null: the browser has none). Returns
 * which entry types it could watch.
 */
export function watchLongTasks(capture, { Observer = globalThis.PerformanceObserver, origin = globalThis.location?.origin ?? '' } = {}) {
  const supported = Observer?.supportedEntryTypes ?? [];
  const types = ['longtask', 'long-animation-frame'].filter((t) => supported.includes(t));
  const observers = [];
  for (const type of types) {
    try {
      const o = new Observer((list) => {
        for (const e of list.getEntries()) {
          if (type === 'longtask') capture.event('longtask', e.name || 'self', e.startTime, e.duration);
          else capture.event('loaf', 'frame', e.startTime, e.duration, loafDetail(e, origin));
        }
      });
      o.observe({ type, buffered: false });
      observers.push(o);
    } catch {
      // Not observable after all: the capture goes on without it.
    }
  }
  return {
    types,
    stop: () => {
      for (const o of observers) {
        try {
          o.disconnect();
        } catch {
          // Already gone.
        }
      }
    },
  };
}

// ---- Static facts ---------------------------------------------------------------------------

/** Settings that change how fast the game draws (js/settings.js names). */
export const PERF_SETTINGS = Object.freeze(['pixelRatioCap', 'lowQuality', 'reduceMotion', 'uiScale', 'gameScale', 'graphics', 'healthBars', 'showUnitPaths', 'targetLines']);

/**
 * The browser and machine: `win` the window (navigator, screen, sizes),
 * `gpu` the renderer's adapter facts (js/renderer.js `gpuInfo()`).
 */
export function environmentFacts(win, gpu = null) {
  const nav = win?.navigator ?? {};
  const brands = nav.userAgentData?.brands?.map((b) => `${b.brand} ${b.version}`) ?? null;
  return {
    userAgent: String(nav.userAgent ?? ''),
    brands,
    mobile: nav.userAgentData?.mobile ?? null,
    platform: nav.userAgentData?.platform ?? null,
    cores: nav.hardwareConcurrency ?? null,
    deviceMemoryGB: nav.deviceMemory ?? null,
    devicePixelRatio: win?.devicePixelRatio ?? null,
    viewport: { width: win?.innerWidth ?? null, height: win?.innerHeight ?? null },
    screen: { width: win?.screen?.width ?? null, height: win?.screen?.height ?? null },
    crossOriginIsolated: !!win?.crossOriginIsolated,
    observers: (win?.PerformanceObserver?.supportedEntryTypes ?? []).filter((t) => ['longtask', 'long-animation-frame'].includes(t)),
    jsHeapLimitMB: win?.performance?.memory?.jsHeapSizeLimit ? round(win.performance.memory.jsHeapSizeLimit / (1024 * 1024)) : null,
    gpu,
  };
}

/** The settings of PERF_SETTINGS from a settings store (js/settings.js). */
export function settingsFacts(settings) {
  const out = {};
  for (const key of PERF_SETTINGS) {
    try {
      out[key] = settings.get(key);
    } catch {
      out[key] = null;
    }
  }
  return out;
}

/** Lobby options without anything personal: no player names, only slot kinds, factions, teams and AI. */
export function optionFacts(options) {
  if (!options || typeof options !== 'object') return null;
  const { players, ...rest } = options;
  const out = {};
  for (const [k, v] of Object.entries(rest)) {
    if (['string', 'number', 'boolean'].includes(typeof v) || v === null) out[k] = v;
  }
  out.players = Array.isArray(players)
    ? players.map((p) => ({ type: p?.type ?? null, faction: p?.faction ?? null, team: p?.team ?? 0, difficulty: p?.difficulty ?? null, bot: p?.bot ?? null }))
    : null;
  return out;
}

/** The file name of a capture: webra-perf-<version>-<YYYYMMDD-HHMMSS>.json (local time). */
export function captureFileName(version, date = new Date()) {
  const two = (n) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
  return `webra-perf-${String(version || 'dev').replace(/[^0-9A-Za-z.-]/g, '')}-${stamp}.json`;
}

/** Offer `text` as a JSON file download (`doc`: the page's document). */
export function saveText(name, text, doc = globalThis.document) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = doc.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  doc.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ---- The page's recorder ----------------------------------------------------------------------

/**
 * Runs captures for the game screen: one at a time, with the long task
 * watch, and turns a finished one into its file. `context()` gives the
 * static facts when the file is made; `onDone(file, text, capture)` gets
 * every finished capture; `onChange()` runs when a capture starts or ends.
 */
export class PerfRecorder {
  constructor({ trace = perfTrace, now = clock, memory = () => globalThis.performance?.memory ?? null, context = () => ({}), onDone = () => {}, onChange = () => {}, watch = watchLongTasks } = {}) {
    this.trace = trace;
    this.now = now;
    this.memory = memory;
    this.context = context;
    this.onDone = onDone;
    this.onChange = onChange;
    this.watch = watch;
    this.capture = null;
    this.watcher = null;
    /** The last finished capture's file (text) and name, kept for "Download". */
    this.last = null;
  }

  get recording() {
    return !!this.capture?.active;
  }

  /** Start a capture of `seconds` (stops a running one first). */
  start({ seconds = 30, reason = 'manual' } = {}) {
    if (this.recording) this.stop('restarted');
    this.capture = new PerfCapture({ seconds, reason, now: this.now, memory: this.memory });
    this.trace.capture = this.capture;
    try {
      this.watcher = this.watch(this.capture);
    } catch {
      this.watcher = null;
    }
    this.onChange();
    return this.capture;
  }

  /** One animation frame (see PerfCapture.frame); ends the capture when its time is up. */
  frame(sample, at) {
    const c = this.capture;
    if (!c?.active) return -1;
    const i = c.frame(sample, at);
    if (!c.active) this.finish();
    return i;
  }

  /** A frame's GPU time, once the GPU has it (PerfCapture.late). */
  late(index, field, ms) {
    this.capture?.late(index, field, ms);
  }

  /** Stop the running capture now and make its file. */
  stop(reason = 'stopped') {
    if (!this.recording) return null;
    this.capture.stop(reason);
    return this.finish();
  }

  /** Seconds recorded so far and requested, for the menu. */
  progress() {
    const c = this.capture;
    if (!c?.active) return null;
    return { seconds: c.elapsed() / 1000, of: c.seconds, reason: c.reason };
  }

  finish() {
    const c = this.capture;
    this.watcher?.stop();
    this.watcher = null;
    if (this.trace.capture === c) this.trace.capture = null;
    let context = {};
    try {
      context = this.context() ?? {};
    } catch (err) {
      context = { error: String(err?.message ?? err) };
    }
    const file = c.toFile(context, { spans: this.trace.startup.slice(), dropped: this.trace.startupDropped });
    const text = JSON.stringify(file);
    this.last = { text, name: captureFileName(context.build?.version, new Date()), file };
    this.onChange();
    this.onDone(file, text, c);
    return file;
  }
}

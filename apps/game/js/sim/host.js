// Main thread side of the simulation: starts it in a Web Worker
// (js/sim/worker.js) or, as the last resort, on this thread, and gives the
// game loop one interface for both (js/main.js):
//
//   const host = await createSimHost({ Game, memory, module });
//   const info = await host.start(spec);       // js/sim/core.js start specs
//   host.game                                   // DirectGame or RemoteGame (js/sim/proxy.js)
//   const frame = host.step({ dt, paused, view, rect, audio, instances });
//   frame.sprites(), frame.rects(), frame.fog() // render data of the latest frame
//   frame.records()                             // GPU instance path: the latest records
//
// With `instances: 'gpu'` a frame carries no sprites or rects: `records()`
// returns the newest tick-rate records (`{ gen, sprites, extras, rects }`,
// js/crowd.js) and `fog()` the newest fog, both kept until newer ones come
// (they are sent only when they change).
//
// Worker modes are pipelined: `step` sends the frame's wall time to the
// worker and returns the newest frame that came back, so the main thread
// never waits for a tick. One step is in flight at a time; time that passes
// meanwhile goes with the next one. Direct mode steps synchronously.

import { SharedFrames } from './framebuffer.js';
import { chooseSimMode, MODE_LABELS, simEnvironment } from './modes.js';
import { DirectGame, RemoteGame } from './proxy.js';

/** How long a worker may take to load the engine before the main thread runs the game itself. */
export const WORKER_START_TIMEOUT_MS = 15000;

const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const NO_F32 = new Float32Array(0);
const NO_U8 = new Uint8Array(0);

/** Tiny event emitter shared by both hosts. */
class Events {
  constructor() {
    this.handlers = new Map();
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
  }

  emit(type, payload) {
    for (const fn of this.handlers.get(type) ?? []) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`simulation ${type} handler failed:`, err);
      }
    }
  }
}

/**
 * Start a simulation host in the best mode this page supports
 * (js/sim/modes.js), falling back to the main thread when the worker fails.
 * @param {{ Game: any, memory: () => WebAssembly.Memory, module?: WebAssembly.Module | null,
 *   env?: object, workerUrl?: URL | string, WorkerClass?: any, timeoutMs?: number }} o
 */
export async function createSimHost({ Game, memory, module = null, env = simEnvironment(), workerUrl = null, WorkerClass = globalThis.Worker, timeoutMs = WORKER_START_TIMEOUT_MS }) {
  const choice = chooseSimMode(env);
  if (choice.mode !== 'direct') {
    try {
      return await WorkerHost.create({
        mode: choice.mode,
        reason: choice.reason,
        module,
        url: workerUrl ?? new URL('./worker.js', import.meta.url),
        WorkerClass,
        timeoutMs,
      });
    } catch (err) {
      console.warn('The simulation worker did not start; running on the main thread:', err?.message ?? err);
      return DirectHost.create({ Game, memory, reason: `worker failed (${err?.message ?? err}): main thread` });
    }
  }
  return DirectHost.create({ Game, memory, reason: choice.reason });
}

// ---- Main thread ---------------------------------------------------------------------

export class DirectHost extends Events {
  static async create({ Game, memory, reason = 'main thread' }) {
    const { SimCore } = await import('./core.js');
    return new DirectHost(SimCore, Game, memory, reason);
  }

  constructor(SimCore, Game, memory, reason) {
    super();
    this.mode = 'direct';
    this.label = MODE_LABELS.direct;
    this.reason = reason;
    this.memory = memory;
    this.core = new SimCore({ Game, memory, emit: (type, payload) => this.emit(type, payload) });
    this.game = null;
    this.frame = null;
    this.frames = 0;
    /** GPU instance path: the latest records (locations in wasm memory) and a copy of the fog. */
    this.records = null;
    this.fog = null;
  }

  async start(spec) {
    const info = this.core.start(spec);
    this.game = new DirectGame(this.core, info);
    return info;
  }

  step(req) {
    const f = this.core.step({ ...req, table: false });
    const memory = this.memory;
    // Views are made when used: a call into wasm in between may grow (and so detach) its memory.
    const view = (Type, loc) => () => (loc ? new Type(memory().buffer, loc.ptr, loc.len) : new Type(0));
    let fog = view(Uint8Array, f.fog);
    let records = () => null;
    if (f.instances === 'gpu') {
      // The records stay in wasm memory until the next build; the fog is
      // copied, since a fog query may overwrite the engine's fog buffer.
      if (f.records) {
        const r = f.records;
        this.records = () => ({ gen: r.gen, sprites: view(Float32Array, r.sprites)(), extras: view(Float32Array, r.extras)(), rects: view(Float32Array, r.rects)() });
      }
      if (f.fog) this.fog = fog().slice();
      const kept = this.fog ?? NO_U8;
      fog = () => kept;
      records = this.records ?? records;
    } else {
      this.records = null;
      this.fog = null;
    }
    this.frame = {
      ...f,
      id: ++this.frames,
      terrain: f.terrain ? new Uint8Array(memory().buffer, f.terrain.ptr, f.terrain.len) : null,
      sprites: view(Float32Array, f.sprites),
      rects: view(Float32Array, f.rects),
      lines: view(Float32Array, f.lineCount ? f.lines : null),
      heat: view(Float32Array, f.heatCount ? f.heat : null),
      fog,
      records,
      valid: () => true,
    };
    this.game.onFrame(this.frame);
    return this.frame;
  }

  command(name, args = []) {
    try {
      return Promise.resolve(this.core.command(name, args));
    } catch (err) {
      return Promise.reject(err);
    }
  }

  stats() {
    return { mode: this.mode, label: this.label, reason: this.reason, workerMs: null, roundTripMs: null, torn: 0 };
  }

  dispose() {}
}

// ---- Worker ----------------------------------------------------------------------------------

export class WorkerHost extends Events {
  /** Start the worker and load the engine in it; rejects when it fails or takes too long. */
  static create({ mode, reason, module, url, WorkerClass, timeoutMs }) {
    return new Promise((resolve, reject) => {
      let worker;
      try {
        worker = new WorkerClass(url, { type: 'module', name: 'webra-sim' });
      } catch (err) {
        reject(err);
        return;
      }
      let done = false;
      const finish = (err, ready) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        worker.onmessage = null;
        worker.onerror = null;
        if (err) {
          worker.terminate();
          reject(err);
        } else {
          resolve(new WorkerHost(worker, mode, reason, ready));
        }
      };
      const timer = setTimeout(() => finish(new Error('the worker did not load the engine in time')), timeoutMs);
      worker.onmessage = (e) => {
        if (e.data?.t === 'ready') finish(null, e.data);
        else if (e.data?.t === 'failed') finish(new Error(e.data.error));
      };
      worker.onerror = (e) => {
        e.preventDefault?.();
        finish(new Error(e.message || 'the worker script failed to load'));
      };
      try {
        worker.postMessage({ t: 'init', module, mode });
      } catch {
        // The compiled module could not be sent: the worker fetches the engine itself.
        worker.postMessage({ t: 'init', module: null, mode });
      }
    });
  }

  constructor(worker, mode, reason, ready) {
    super();
    this.worker = worker;
    // The worker may have stepped down from shared to transfer.
    this.mode = ready.mode === 'shared' ? 'shared' : 'transfer';
    this.label = MODE_LABELS[this.mode];
    this.reason = this.mode === mode ? reason : `${reason}; the worker has no shared memory`;
    this.shared = ready.shared ? SharedFrames.attach(ready.shared) : null;
    this.game = null;
    this.frame = null;
    this.frames = 0;
    this.nextId = 1;
    this.pending = new Map();
    this.inFlight = false;
    this.carryDt = 0;
    this.sentAt = 0;
    this.stepView = 0;
    this.recycle = [];
    this.failed = null;
    this.roundTripMs = 0;
    this.torn = 0;
    /** GPU instance path: the latest records and fog (sent only when they change). */
    this.records = null;
    this.fog = null;
    this.link = {
      post: (msg) => this.post(msg),
      ask: (method, args) => this.request({ t: 'ask', method, args }),
    };
    worker.onmessage = (e) => this.onMessage(e.data);
    worker.onerror = (e) => {
      e.preventDefault?.();
      this.fail(e.message || 'the simulation worker failed');
    };
  }

  post(msg, transfer = []) {
    if (this.failed) return;
    this.worker.postMessage(msg, transfer);
  }

  request(msg) {
    if (this.failed) return Promise.reject(new Error(this.failed));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.post({ ...msg, id });
    });
  }

  async start(spec) {
    const info = await this.request({ t: 'start', spec });
    this.game = new RemoteGame(this.link, info);
    return info;
  }

  command(name, args = []) {
    return this.request({ t: 'command', name, args });
  }

  /**
   * Send this animation frame's time to the worker (unless a step is still
   * on its way) and return the newest frame it sent back (null before the first).
   */
  step(req) {
    if (this.failed || !this.game) return this.frame;
    if (this.inFlight) {
      this.carryDt += req.dt;
      return this.frame;
    }
    const full = { ...req, dt: req.dt + this.carryDt, table: true, queries: this.game.collectQueries() };
    this.carryDt = 0;
    this.inFlight = true;
    this.stepView = req.view;
    this.sentAt = clock();
    const recycle = this.recycle;
    this.recycle = [];
    this.post({ t: 'step', req: full, recycle }, recycle);
    return this.frame;
  }

  onMessage(msg) {
    switch (msg?.t) {
      case 'frame':
        this.onFrame(msg.frame);
        return;
      case 'result': {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error !== undefined) p.reject(new Error(msg.error));
        else p.resolve(msg.value);
        return;
      }
      case 'event':
        this.emit(msg.type, msg.payload);
        return;
      case 'warn':
        console.warn('simulation:', msg.message);
        return;
      case 'failed':
        this.fail(msg.error);
        return;
      default:
    }
  }

  onFrame(f) {
    this.inFlight = false;
    this.roundTripMs = clock() - this.sentAt;
    // The previous frame is no longer drawn: its buffers go back to the worker.
    const old = this.frame;
    if (old && old.instances === 'gpu') {
      if (old.raw.lines) this.recycle.push(old.raw.lines.buffer);
      if (old.raw.heat) this.recycle.push(old.raw.heat.buffer);
    } else if (old && !this.shared) {
      for (const a of [old.raw.sprites, old.raw.rects, old.raw.fog, old.raw.lines, old.raw.heat]) if (a) this.recycle.push(a.buffer);
    }
    const frame = { ...f, id: ++this.frames, raw: f, records: () => null };
    if (f.instances === 'gpu') {
      // Newer records and fog replace the kept ones, whose buffers go back.
      if (f.records) {
        this.releaseRecords();
        this.records = f.records;
      }
      if (f.fog) {
        if (this.fog) this.recycle.push(this.fog.buffer);
        this.fog = f.fog;
      }
      const records = this.records;
      const fog = this.fog ?? NO_U8;
      const lines = f.lines ?? NO_F32;
      const heat = f.heat ?? NO_F32;
      frame.heat = () => heat;
      frame.sprites = () => NO_F32;
      frame.rects = () => NO_F32;
      frame.lines = () => lines;
      frame.fog = () => fog;
      frame.records = () => records;
      frame.valid = () => true;
    } else if (this.shared) {
      const { slot, seq, buffers } = f.shared;
      this.shared.adopt(slot, buffers);
      const len = f.lengths;
      frame.sprites = () => this.shared.read(slot, 'sprites', len.sprites);
      frame.rects = () => this.shared.read(slot, 'rects', len.rects);
      frame.fog = () => this.shared.read(slot, 'fog', len.fog);
      frame.lines = () => this.shared.read(slot, 'lines', len.lines);
      frame.heat = () => this.shared.read(slot, 'heat', len.heat ?? 0);
      frame.valid = () => {
        const ok = this.shared.valid(slot, seq);
        if (!ok) this.torn++;
        return ok;
      };
    }
    if (f.instances !== 'gpu') {
      // Back on the CPU path: the kept records and fog are not drawn any more.
      this.releaseRecords();
      if (this.fog) this.recycle.push(this.fog.buffer);
      this.fog = null;
    }
    if (f.instances !== 'gpu' && !this.shared) {
      const sprites = f.sprites ?? new Float32Array(0);
      const rects = f.rects ?? new Float32Array(0);
      const fog = f.fog ?? new Uint8Array(0);
      const lines = f.lines ?? new Float32Array(0);
      const heat = f.heat ?? new Float32Array(0);
      frame.lines = () => lines;
      frame.heat = () => heat;
      frame.sprites = () => sprites;
      frame.rects = () => rects;
      frame.fog = () => fog;
      frame.valid = () => true;
    }
    this.frame = frame;
    this.game.onFrame(frame, this.stepView);
    this.emit('frame', frame);
  }

  /** Hand the kept records' buffers back to the worker's pool. */
  releaseRecords() {
    const r = this.records;
    if (r) for (const a of [r.sprites, r.extras, r.rects]) if (a) this.recycle.push(a.buffer);
    this.records = null;
  }

  fail(message) {
    if (this.failed) return;
    this.failed = message || 'the simulation worker failed';
    for (const p of this.pending.values()) p.reject(new Error(this.failed));
    this.pending.clear();
    this.emit('failed', this.failed);
  }

  stats() {
    return {
      mode: this.mode,
      label: this.label,
      reason: this.reason,
      workerMs: this.frame ? this.frame.simFrameMs : null,
      roundTripMs: this.roundTripMs,
      torn: this.torn,
    };
  }

  dispose() {
    this.worker.terminate();
  }
}

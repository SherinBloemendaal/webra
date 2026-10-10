// The simulation worker: runs js/sim/core.js (the wasm Game and its driver)
// off the main thread, so ticks never block rendering and input. The main
// thread side is js/sim/host.js (WorkerHost); docs/contracts.md (section 8)
// lists the messages.
//
// Render data leaves through shared memory (mode `shared`: a double buffer
// with sequence counters, js/sim/framebuffer.js) or as transferred
// ArrayBuffers (mode `transfer`), which the main thread hands back with its
// next step so steady play allocates nothing. The GPU instance path
// (`instances: 'gpu'`) sends its tick-rate records and the fog as
// transferred buffers in every mode, and only when they changed.

import init, { Game, initSync, take_panic, version } from '../../pkg/webra_sim.js';
import { SimCore } from './core.js';
import { EngineError, serializeError } from './engine-error.js';
import { BufferPool, SharedFrames } from './framebuffer.js';

/** Where messages go: the worker global in browsers; tests may install another port first. */
const port = globalThis.__webraSimPort ?? globalThis;

let wasm = null;
let core = null;
let mode = 'transfer';
let shared = null;
const pool = new BufferPool();

const post = (msg, transfer = []) => port.postMessage(msg, transfer);

function emit(type, payload) {
  post({ t: 'event', type, payload });
}

/**
 * Send an error to the main thread for the error report (js/sim/host.js;
 * docs/contracts.md section 8, `error`). The worker has no error reporting
 * of its own: the main thread decides whether reports are sent at all.
 */
function report(err) {
  try {
    post({ t: 'error', error: serializeError(err) });
  } catch {
    // The port is gone: nothing to report to.
  }
}

// Errors nothing caught (a bug in this worker's own code).
globalThis.addEventListener?.('error', (e) => report(e.error ?? new Error(e.message || 'error in the simulation worker')));
globalThis.addEventListener?.('unhandledrejection', (e) => report(e.reason));

/** Copy `{ ptr, len }` of wasm memory into a pooled ArrayBuffer (transfer mode). */
function copyOut(Type, loc, transfer) {
  if (!loc) return null;
  const buf = pool.take(Math.max(1, loc.len) * Type.BYTES_PER_ELEMENT);
  const out = new Type(buf, 0, loc.len);
  out.set(new Type(wasm.memory.buffer, loc.ptr, loc.len));
  transfer.push(buf);
  return out;
}

/** The frame as it leaves the worker: locations in wasm memory replaced by data. */
function pack(frame) {
  const transfer = [];
  const out = { ...frame, sprites: null, rects: null, lines: null, heat: null, fog: null, terrain: null, shared: null, records: null };
  // Terrain changes rarely (ore, craters, buildings): always a transferred copy.
  if (frame.terrain) {
    out.terrain = new Uint8Array(wasm.memory.buffer, frame.terrain.ptr, frame.terrain.len).slice();
    transfer.push(out.terrain.buffer);
  }
  if (frame.table) transfer.push(frame.table.buffer);
  if (frame.audio) transfer.push(frame.audio.buffer);
  if (frame.instances === 'gpu') {
    // Records and fog only when they changed: once per tick at most.
    const r = frame.records;
    if (r) {
      out.records = {
        gen: r.gen,
        sprites: copyOut(Float32Array, r.sprites, transfer),
        extras: copyOut(Float32Array, r.extras, transfer),
        rects: copyOut(Float32Array, r.rects, transfer),
      };
    }
    if (frame.fog) out.fog = copyOut(Uint8Array, frame.fog, transfer);
    if (frame.lines.len) out.lines = copyOut(Float32Array, frame.lines, transfer);
    if (frame.heat.len) out.heat = copyOut(Float32Array, frame.heat, transfer);
    return { out, transfer };
  }
  if (mode === 'shared') {
    const mem = wasm.memory.buffer;
    out.shared = shared.write((view) => {
      view('sprites', frame.sprites.len).set(new Float32Array(mem, frame.sprites.ptr, frame.sprites.len));
      view('rects', frame.rects.len).set(new Float32Array(mem, frame.rects.ptr, frame.rects.len));
      view('fog', frame.fog.len).set(new Uint8Array(mem, frame.fog.ptr, frame.fog.len));
      if (frame.lines.len) view('lines', frame.lines.len).set(new Float32Array(mem, frame.lines.ptr, frame.lines.len));
      if (frame.heat.len) view('heat', frame.heat.len).set(new Float32Array(mem, frame.heat.ptr, frame.heat.len));
    });
    out.lengths = { sprites: frame.sprites.len, rects: frame.rects.len, fog: frame.fog.len, lines: frame.lines.len, heat: frame.heat.len };
  } else {
    out.sprites = copyOut(Float32Array, frame.sprites, transfer);
    out.rects = copyOut(Float32Array, frame.rects, transfer);
    out.fog = copyOut(Uint8Array, frame.fog, transfer);
    if (frame.lines.len) out.lines = copyOut(Float32Array, frame.lines, transfer);
    if (frame.heat.len) out.heat = copyOut(Float32Array, frame.heat, transfer);
  }
  return { out, transfer };
}

function reply(id, fn) {
  try {
    post({ t: 'result', id, value: fn() });
  } catch (err) {
    // Engine failures are reported by the core (onFailure); other errors
    // answer bad requests and are the caller's to handle.
    post({ t: 'result', id, error: String(err?.message ?? err) });
  }
}

async function onInit(msg) {
  try {
    wasm = msg.module ? initSync({ module: msg.module }) : await init();
    mode = msg.mode === 'shared' && typeof SharedArrayBuffer === 'function' ? 'shared' : 'transfer';
    if (mode === 'shared') shared = new SharedFrames({ sprites: 'f32', rects: 'f32', fog: 'u8', lines: 'f32', heat: 'f32' });
    core = new SimCore({ Game, memory: () => wasm.memory, emit, engine: { version, takePanic: take_panic }, onFailure: report });
    post({ t: 'ready', version: version(), mode, shared: shared ? shared.describe() : null });
  } catch (err) {
    // Fetching the engine can fail for reasons outside the game (the
    // network, a sign-in that ended): only a failure with the module the
    // page already compiled is a bug worth a report.
    if (msg.module) report(err);
    post({ t: 'failed', error: String(err?.message ?? err) });
  }
}

function onMessage(msg) {
  switch (msg.t) {
    case 'init':
      onInit(msg);
      return;
    case 'start':
      reply(msg.id, () => core.start(msg.spec));
      return;
    case 'call':
      try {
        core.call(msg.method, msg.args);
      } catch (err) {
        post({ t: 'warn', message: `${msg.method}: ${err?.message ?? err}` });
      }
      return;
    case 'ask':
      reply(msg.id, () => core.query(msg.method, msg.args));
      return;
    case 'command':
      reply(msg.id, () => core.command(msg.name, msg.args));
      return;
    case 'step': {
      if (msg.recycle) pool.give(msg.recycle);
      let packed;
      try {
        packed = pack(core.step(msg.req));
      } catch (err) {
        // An engine failure was reported by the core; anything else is a bug here.
        if (!(err instanceof EngineError)) report(err);
        post({ t: 'failed', error: `The simulation stopped: ${err?.message ?? err}` });
        return;
      }
      post({ t: 'frame', frame: packed.out }, packed.transfer);
      return;
    }
    default:
      post({ t: 'warn', message: `unknown message ${msg?.t}` });
  }
}

port.onmessage = (e) => onMessage(e.data);

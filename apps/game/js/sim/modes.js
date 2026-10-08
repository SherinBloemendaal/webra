// Where the simulation runs (js/sim/host.js), picked when a game starts:
//
//   shared    a module Web Worker; render data in SharedArrayBuffers
//             (js/sim/framebuffer.js). Needs a cross-origin isolated page
//             (COOP same-origin + COEP require-corp, apps/website/_headers).
//   transfer  a module Web Worker; render data in ArrayBuffers transferred
//             with each frame (no isolation needed).
//   direct    on the main thread, like before workers: the last resort when
//             module workers are missing or the worker fails to start.
//
// `?sim=direct|transfer|shared` in the page URL asks for a mode (debugging);
// a mode the browser cannot run falls back to the next one down.

export const SIM_MODES = Object.freeze(['shared', 'transfer', 'direct']);

export const MODE_LABELS = Object.freeze({
  shared: 'Worker (shared memory)',
  transfer: 'Worker (transferred buffers)',
  direct: 'Main thread',
});

/**
 * The capabilities that decide the mode, read from the page.
 * @param {typeof globalThis} [g]
 */
export function simEnvironment(g = globalThis) {
  let requested = null;
  try {
    requested = new URLSearchParams(g.location?.search ?? '').get('sim');
  } catch {
    requested = null;
  }
  return {
    worker: typeof g.Worker === 'function',
    moduleWorker: typeof g.Worker === 'function' && supportsModuleWorkers(g),
    sharedMemory: typeof g.SharedArrayBuffer === 'function' && typeof g.Atomics === 'object',
    isolated: g.crossOriginIsolated === true,
    requested,
  };
}

/** Feature test for `new Worker(url, { type: 'module' })` without starting one. */
function supportsModuleWorkers(g) {
  let supported = false;
  try {
    const options = {
      get type() {
        supported = true;
        return 'module';
      },
    };
    // WebIDL reads the options before the constructor parses the URL, which
    // is invalid here: nothing is fetched and nothing starts. Browsers
    // without module workers have no `type` option and never read it.
    new g.Worker('http://[', options).terminate();
  } catch {
    // The invalid URL throws (as intended); `supported` tells whether the
    // browser looked at `type`.
  }
  return supported;
}

/**
 * Pick the simulation mode.
 * @param {{ worker: boolean, moduleWorker: boolean, sharedMemory: boolean, isolated: boolean, requested?: string | null }} env
 * @returns {{ mode: 'shared' | 'transfer' | 'direct', reason: string }}
 */
export function chooseSimMode(env) {
  const canWorker = env.worker && env.moduleWorker;
  const canShare = canWorker && env.sharedMemory && env.isolated;
  const best = canShare ? 'shared' : canWorker ? 'transfer' : 'direct';
  const why = canShare
    ? 'cross-origin isolated: shared memory'
    : canWorker
      ? env.sharedMemory && !env.isolated
        ? 'not cross-origin isolated: transferred buffers'
        : 'no SharedArrayBuffer: transferred buffers'
      : 'no module workers: main thread';
  const asked = SIM_MODES.includes(env.requested) ? env.requested : null;
  if (!asked) return { mode: best, reason: why };
  // A requested mode is honoured when the browser can run it, else the best one below it.
  const order = SIM_MODES.slice(SIM_MODES.indexOf(asked));
  const can = { shared: canShare, transfer: canWorker, direct: true };
  const mode = order.find((m) => can[m]);
  return { mode, reason: mode === asked ? `requested (?sim=${asked})` : `requested ${asked}, ${why}` };
}

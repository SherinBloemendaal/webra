// Engine failures as errors that say what happened (docs/security.md, "Error
// reports"). The wasm32 engine aborts on a Rust panic and JavaScript only
// sees `RuntimeError: unreachable`; the engine's panic hook keeps the message,
// the source location and the tick (engine/src/panic_report.rs), and
// `engineError` turns the trap into an `EnginePanic` error with them. Other
// traps (out of memory, a stack overflow) become `EngineTrap`.
//
// Each such error carries `webraContext`: the engine version, the game mode,
// the tick and the newest state hashes (js/sim/core.js `context()`), which
// the error report attaches (js/telemetry/index.js). The simulation worker
// sends errors to the main thread as plain data (`serializeError`), which
// rebuilds them there (`reviveError`) with their stack.
//
// No DOM: the worker, the main thread and the Node tests use it.

/** Longest message and stack kept from a worker error (characters). */
const MESSAGE_MAX = 1000;
const STACK_MAX = 16_000;

export class EngineError extends Error {
  /**
   * @param {'EnginePanic' | 'EngineTrap'} name
   * @param {string} message
   * @param {{ cause?: unknown, context?: object | null }} [o]
   */
  constructor(name, message, { cause, context = null } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = name;
    this.webraContext = context;
  }
}

/** Whether `err` is a trap of WebAssembly code (a Rust panic included). */
export function isTrap(err) {
  const RuntimeError = globalThis.WebAssembly?.RuntimeError;
  return typeof RuntimeError === 'function' && err instanceof RuntimeError;
}

/**
 * The error to throw for `err`, raised by a call into the engine.
 * `takePanic` is the engine's `take_panic` export (JSON or undefined);
 * `context` the facts about the game at the time. Errors that are not
 * engine traps or panics come back unchanged.
 * @param {unknown} err
 * @param {{ takePanic?: () => string | undefined | null, context?: () => object | null }} o
 */
export function engineError(err, { takePanic = null, context = null } = {}) {
  if (err instanceof EngineError) return err;
  let panic = null;
  try {
    const raw = takePanic?.();
    panic = raw ? JSON.parse(raw) : null;
  } catch {
    panic = null;
  }
  if (!panic && !isTrap(err)) return err;
  let facts = null;
  try {
    facts = context?.() ?? null;
  } catch {
    facts = null;
  }
  if (panic) {
    const where = panic.location ? ` at ${panic.location}` : '';
    const message = `${String(panic.message ?? 'panic')}${where}`;
    return new EngineError('EnginePanic', message, { cause: err, context: { ...facts, panicTick: panic.tick ?? null } });
  }
  return new EngineError('EngineTrap', String(err?.message ?? err), { cause: err, context: facts });
}

/** An error as plain data for postMessage. */
export function serializeError(err) {
  const e = err instanceof Error ? err : new Error(String(err));
  return {
    name: String(e.name || 'Error').slice(0, 100),
    message: String(e.message ?? '').slice(0, MESSAGE_MAX),
    stack: typeof e.stack === 'string' ? e.stack.slice(0, STACK_MAX) : null,
    context: e.webraContext ?? null,
  };
}

/** An Error from `serializeError` data, with its name, stack and context. */
export function reviveError(data) {
  const err = new Error(String(data?.message ?? 'unknown error'));
  err.name = String(data?.name ?? 'Error');
  if (typeof data?.stack === 'string') err.stack = data.stack;
  err.webraContext = data?.context ?? null;
  return err;
}

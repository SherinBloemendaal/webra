// The game engine inside the Worker: the same WebAssembly build the players
// run, so the server judges maps exactly like every client does.
//
// The server needs one export (Game.validate_map) and calls it through a small
// binding of its own rather than the wasm-bindgen glue in apps/game/pkg: the
// glue holds one instance per JavaScript module and cannot start over, while
// a trap (the release build aborts on a Rust panic) can leave an instance with
// a half-unwound stack and heap. Whenever an exception leaves the module, the
// instance is dropped and the next call instantiates a fresh one.
import wasmModule from '#engine-wasm';

/** The engine trapped while judging a map: the map is refused, the instance replaced. */
export class EngineTrap extends Error {
  constructor(cause) {
    super('the engine could not check this map', { cause });
    this.name = 'EngineTrap';
  }
}

const decoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
const encoder = new TextEncoder();

/** UTF-8 string at `ptr` in the instance's memory. */
function readString(wasm, ptr, len) {
  return decoder.decode(new Uint8Array(wasm.memory.buffer, ptr >>> 0, len >>> 0));
}

/**
 * Imports the engine's wasm-bindgen output asks for, matched by name without
 * the version hash. Anything else fails when called, not at instantiation, so
 * an unrelated new import cannot take map validation down.
 */
function bindingImport(name, wasm) {
  const text = (ptr, len) => readString(wasm(), ptr, len);
  if (name.startsWith('__wbg_Error_')) return (ptr, len) => Error(text(ptr, len));
  if (name.startsWith('__wbg___wbindgen_throw_')) {
    return (ptr, len) => {
      throw new Error(text(ptr, len));
    };
  }
  if (name === '__wbindgen_init_externref_table') {
    return () => {
      const table = wasm().__wbindgen_externrefs;
      const offset = table.grow(4);
      table.set(0, undefined);
      table.set(offset + 0, undefined);
      table.set(offset + 1, null);
      table.set(offset + 2, true);
      table.set(offset + 3, false);
    };
  }
  return () => {
    throw new Error(`unsupported engine import ${name}`);
  };
}

export class Engine {
  /** @param {WebAssembly.Module} module the compiled engine */
  constructor(module) {
    this.module = module;
    this.wasm = null;
    /** Instances created so far (a new one after every failed call). */
    this.instances = 0;
  }

  /** The live instance's exports, instantiating one when there is none. */
  exports() {
    if (this.wasm) return this.wasm;
    let wasm = null;
    const imports = {};
    for (const imp of WebAssembly.Module.imports(this.module)) {
      if (imp.kind !== 'function') throw new Error(`unsupported engine import ${imp.name}`);
      imports[imp.module] ??= {};
      imports[imp.module][imp.name] = bindingImport(imp.name, () => wasm);
    }
    wasm = new WebAssembly.Instance(this.module, imports).exports;
    wasm.__wbindgen_start?.();
    this.wasm = wasm;
    this.instances++;
    return wasm;
  }

  /**
   * Engine verdict on a map file: `{ ok, errors, modded, hash }`. Throws
   * EngineTrap when the engine trapped on it.
   */
  validateMap(canonicalJson) {
    const wasm = this.exports();
    let out;
    try {
      // Same calling convention as the glue's Game.validate_map: the engine
      // takes ownership of the UTF-8 argument and returns (pointer, length)
      // of a string the caller frees.
      const bytes = encoder.encode(canonicalJson);
      const ptr = wasm.__wbindgen_malloc(bytes.length, 1) >>> 0;
      new Uint8Array(wasm.memory.buffer, ptr, bytes.length).set(bytes);
      const [outPtr, outLen] = wasm.game_validate_map(ptr, bytes.length);
      try {
        out = readString(wasm, outPtr, outLen);
      } finally {
        wasm.__wbindgen_free(outPtr, outLen, 1);
      }
    } catch (err) {
      // Never call into an instance an exception unwound through.
      this.wasm = null;
      if (err instanceof WebAssembly.RuntimeError) throw new EngineTrap(err);
      throw err;
    }
    return JSON.parse(out);
  }
}

let shared = null;

/** The Worker's engine (one per isolate, instantiated on first use). */
export function engine() {
  shared ??= new Engine(wasmModule);
  return shared;
}

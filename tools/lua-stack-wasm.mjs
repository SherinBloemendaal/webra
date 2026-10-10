// The Lua interpreter's stack use in the WebAssembly build (engine/src/stack_check.rs).
//
//   cargo build --release --target wasm32-unknown-unknown -p webra-sim --example lua_stack --features stack-probe
//   node tools/lua-stack-wasm.mjs [path to lua_stack.wasm]
//   node --stack-size=300 tools/lua-stack-wasm.mjs   (a third of node's default JS stack, for the margin)
//
// The browser and the server's map validator run the engine as wasm32, so
// this is the stack that must hold: per kind of nesting it measures the
// bytes one level of `lua::MAX_LEVELS` takes, and fails when MAX_LEVELS
// levels of any kind would need more than the wasm budget, or when the
// budget is more than half of the module's stack (read from its
// `__stack_pointer`, which rustc places first in memory).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const path = process.argv[2] ?? fileURLToPath(new URL('../target/wasm32-unknown-unknown/release/examples/lua_stack.wasm', import.meta.url));
const bytes = readFileSync(path);

/** Unsigned and signed LEB128 at `at`: [value, next]. */
function leb(buf, at, signed = false) {
  let result = 0n;
  let shift = 0n;
  let b;
  do {
    b = buf[at++];
    result |= BigInt(b & 0x7f) << shift;
    shift += 7n;
  } while (b & 0x80);
  if (signed && b & 0x40) result -= 1n << shift;
  return [Number(result), at];
}

/** The initial value of the module's first global (rustc's __stack_pointer): the stack's top. */
function stackTop(buf) {
  let at = 8;
  while (at < buf.length) {
    const id = buf[at];
    const [size, body] = leb(buf, at + 1);
    if (id === 6) {
      let [, p] = leb(buf, body); // global count
      const type = buf[p];
      const mutable = buf[p + 1];
      if (type !== 0x7f || mutable !== 1 || buf[p + 2] !== 0x41) throw new Error('the first global is not a mutable i32 stack pointer');
      return leb(buf, p + 3, true)[0];
    }
    at = body + size;
  }
  throw new Error('no global section');
}

const module = new WebAssembly.Module(bytes);
// The library's wasm-bindgen imports are linked in but never called by these exports.
const imports = {};
for (const imp of WebAssembly.Module.imports(module)) {
  imports[imp.module] ??= {};
  imports[imp.module][imp.name] = () => {
    throw new Error(`unexpected call to ${imp.module}.${imp.name}`);
  };
}
const wasm = new WebAssembly.Instance(module, imports).exports;
const top = stackTop(bytes);
const budget = wasm.budget();
const maxLevels = wasm.max_levels();
const names = ['nested parentheses', 'Lua calls', 'library calls', 'calls in nested expressions', 'host round trips'];
let failed = false;
console.log(`wasm32 stack ${top} bytes, budget ${budget} for MAX_LEVELS = ${maxLevels}`);
if (budget > top / 2) {
  console.error(`the budget ${budget} is more than half the stack ${top}`);
  failed = true;
}
for (let k = 0; k < wasm.case_count(); k++) {
  const packed = wasm.measure(k);
  const used = Number(packed >> 32n);
  const levels = Number(packed & 0xffffffffn);
  const perLevel = used / Math.max(1, levels);
  const worst = perLevel * maxLevels;
  console.log(`${names[k] ?? `case ${k}`}: ${used} bytes for ${levels} levels, ${perLevel.toFixed(0)} per level, ${worst.toFixed(0)} for MAX_LEVELS`);
  if (levels < 90) {
    console.error(`  only ${levels} levels measured`);
    failed = true;
  }
  if (worst > budget) {
    console.error(`  more than the budget ${budget}`);
    failed = true;
  }
}
// Unbounded recursion of every kind ends in a Lua "stack overflow" error,
// not a trap of the wasm stack or the JS engine's own stack. Run with a
// smaller JS stack too (`--stack-size`, a child process), for the margin.
for (let k = 0; k < wasm.overflow_count(); k++) {
  let ok = 0;
  try {
    ok = wasm.overflow(k);
  } catch (err) {
    console.error(`overflow case ${k}: ${err.message}`);
  }
  if (ok !== 1) {
    console.error(`overflow case ${k} did not end in a Lua stack overflow`);
    failed = true;
  }
}
console.log(`unbounded recursion: ${wasm.overflow_count()} cases end in a Lua stack overflow`);
process.exit(failed ? 1 : 0);

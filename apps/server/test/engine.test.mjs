import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Engine, EngineTrap, engine } from '../src/engine.js';
import { HttpError } from '../src/http.js';
import { prepareMap } from '../src/maps.js';

const wasmModule = new WebAssembly.Module(readFileSync(new URL('../../game/pkg/webra_sim_bg.wasm', import.meta.url)));

function blankMap(w = 32) {
  return {
    format: 1,
    name: 'Test',
    author: 'Me',
    width: w,
    height: w,
    terrain: Buffer.alloc(w * w).toString('base64'),
    ore: Buffer.alloc(w * w).toString('base64'),
    spawns: [
      [1, 1],
      [20, 20],
    ],
  };
}

// A stand-in engine with the same exports as the real one. It traps on input
// starting with "{" and leaves a mark in its memory that makes every later
// call on the same instance trap too, like an instance a panic left broken.
// Otherwise it answers {"ok":true}.
function trappingModule() {
  const u32 = (n) => [n]; // every size here is below 128 (one LEB128 byte)
  const str = (s) => [...u32(s.length), ...Buffer.from(s)];
  const vec = (items) => [...u32(items.length), ...items.flat()];
  const section = (id, body) => [id, ...u32(body.length), ...body];
  const i32 = 0x7f;
  const types = vec([
    [0x60, 2, i32, i32, 2, i32, i32], // validate_map(ptr, len) -> (ptr, len)
    [0x60, 2, i32, i32, 1, i32], // malloc(len, align) -> ptr
    [0x60, 3, i32, i32, i32, 0], // free(ptr, len, align)
    [0x60, 0, 0], // start()
  ]);
  const body = (code) => [...u32(code.length + 1), 0, ...code];
  const validate = [
    ...[0x41, 0, 0x2d, 0, 0, 0x04, 0x40, 0x00, 0x0b], // if mem[0] != 0: unreachable
    ...[0x20, 0, 0x2d, 0, 0, 0x41, 0xfb, 0x00, 0x46, 0x04, 0x40], // if mem[ptr] == '{':
    ...[0x41, 0, 0x41, 1, 0x3a, 0, 0, 0x00, 0x0b], //   mem[0] = 1; unreachable
    ...[0x41, 16, 0x41, 11, 0x0b], // return (16, 11)
  ];
  const bytes = [
    ...[0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0],
    ...section(1, types),
    ...section(3, vec([[0], [1], [2], [3]])),
    ...section(5, [1, 0, 1]),
    ...section(
      7,
      vec([
        [...str('memory'), 2, 0],
        [...str('game_validate_map'), 0, 0],
        [...str('__wbindgen_malloc'), 0, 1],
        [...str('__wbindgen_free'), 0, 2],
        [...str('__wbindgen_start'), 0, 3],
      ]),
    ),
    ...section(10, vec([body(validate), body([0x41, 32, 0x0b]), body([0x0b]), body([0x0b])])),
    ...section(11, vec([[0, 0x41, 16, 0x0b, ...str('{"ok":true}')]])),
  ];
  return new WebAssembly.Module(new Uint8Array(bytes));
}

test('the engine binding validates maps like the game build', () => {
  const e = new Engine(wasmModule);
  const v = e.validateMap(JSON.stringify(blankMap()));
  assert.equal(v.ok, true, v.errors.join('; '));
  assert.match(v.hash, /^[0-9a-f]{64}$/);
  const bad = e.validateMap(JSON.stringify({ ...blankMap(), actors: [{ type: 'FACT', owner: 0, x: 30, y: 30 }] }));
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((x) => /does not fit/.test(x)), bad.errors.join('; '));
  assert.equal(e.validateMap('not json').ok, false);
  assert.equal(e.instances, 1, 'a healthy instance is reused');
  assert.equal(engine().validateMap(JSON.stringify(blankMap())).hash, v.hash);
  // Format 2 maps with a gems layer, checked by the engine as well.
  const gems = Buffer.alloc(32 * 32);
  gems[100] = 3;
  const withGems = { ...blankMap(), format: 2, gems: gems.toString('base64') };
  const g = e.validateMap(JSON.stringify(withGems));
  assert.equal(g.ok, true, g.errors.join('; '));
  assert.notEqual(g.hash, v.hash);
  gems[100] = 4;
  assert.deepEqual(e.validateMap(JSON.stringify({ ...withGems, gems: gems.toString('base64') })).errors, ['invalid gem density 4']);
});

test('after a trap the engine is instantiated afresh', () => {
  const e = new Engine(trappingModule());
  assert.deepEqual(e.validateMap('x'), { ok: true });
  assert.throws(() => e.validateMap('{"evil":1}'), EngineTrap);
  // The broken instance would trap on anything now; a fresh one answers.
  assert.deepEqual(e.validateMap('x'), { ok: true });
  assert.equal(e.instances, 2);
});

test('a map the engine traps on is refused with 422, not 500', async () => {
  const e = new Engine(trappingModule());
  await assert.rejects(
    prepareMap(JSON.stringify(blankMap()), e),
    (err) => err instanceof HttpError && err.status === 422 && /could not check/.test(err.message),
  );
  assert.deepEqual(e.validateMap('x'), { ok: true }, 'and the next upload gets a working engine');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkKey, gunzip, gzip, OrderLog } from '../src/orderlog.js';

class Storage {
  constructor() {
    this.data = new Map();
    this.puts = 0;
  }
  async get(k) {
    return this.data.get(k);
  }
  async put(k, v) {
    this.puts++;
    this.data.set(k, v);
  }
}

const frame = (tick, n = 1) => ({ tick, orders: n ? [[0, Array.from({ length: n }, (_, i) => ({ o: 'stop', player: 0, ids: [tick, i] }))]] : [] });

test('gzip round trip', async () => {
  const text = JSON.stringify(Array.from({ length: 500 }, (_, i) => [i, [[0, [{ o: 'stop', player: 0, ids: [i] }]]]]));
  const z = await gzip(text);
  assert.ok(z.length < text.length / 4, 'compact');
  assert.equal(await gunzip(z), text);
});

test('frames with orders are kept, chunked into compressed storage, read back in order', async () => {
  const storage = new Storage();
  const log = new OrderLog(storage, { chunkFrames: 10 });
  for (let t = 0; t < 100; t++) log.append(frame(t, t % 2));
  assert.throws(() => log.append(frame(50)), /increase/);
  // Reads work while chunks are still being written, and after.
  const early = await log.read();
  assert.deepEqual(early.map((f) => f[0]), Array.from({ length: 50 }, (_, i) => i * 2 + 1));
  await log.writing;
  assert.equal(log.unwritten.size, 0);
  assert.equal(storage.puts, 5);
  assert.ok(storage.data.get(chunkKey(0)) instanceof Uint8Array);
  assert.deepEqual(await log.read(), early);
  assert.deepEqual(early[0], [1, frame(1).orders]);
});

test('the log stops at its size limit and says so', async () => {
  const log = new OrderLog(new Storage(), { maxBytes: 2000 });
  for (let t = 0; t < 100; t++) log.append(frame(t, 3));
  assert.equal(log.full, true);
  assert.ok(log.bytes <= 2000);
  const frames = await log.read();
  assert.ok(frames.length > 0 && frames.length < 100);
});

test('a failed write keeps the chunk in memory', async () => {
  const storage = { get: async () => undefined, put: async () => { throw new Error('disk full'); } };
  const log = new OrderLog(storage, { chunkFrames: 2 });
  const errors = console.error;
  console.error = () => {};
  try {
    for (let t = 0; t < 6; t++) log.append(frame(t));
    await log.writing;
  } finally {
    console.error = errors;
  }
  assert.equal(log.failed, true);
  assert.equal((await log.read()).length, 6);
});

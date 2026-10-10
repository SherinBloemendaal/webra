// Order log of a running game (pure apart from the injected storage).
//
// Every frame the relay emits is appended; empty frames are left out, so a
// log holds only `[tick, orders]` pairs with orders. Frames are collected in
// chunks that are gzip compressed and written to Durable Object storage
// (`log:<n>`), so a long game does not live in memory. `read()` returns the
// whole log for a rejoining player or a spectator joining a running game.
//
// Bounds: once the uncompressed log passes LOG_MAX_BYTES it stops recording
// and `full` is set; the session then refuses rejoins and late spectators
// (they could not catch up), and the game itself goes on.

import { LOG_MAX_BYTES, logEntryBytes } from '@webra/protocol';
import { logError } from './telemetry.js';

/** A chunk is sealed after this many frames or this many bytes of JSON. */
export const CHUNK_FRAMES = 512;
export const CHUNK_BYTES = 64 * 1024;
const KEY_PREFIX = 'log:';

const enc = new TextEncoder();
const dec = new TextDecoder();

async function pipe(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

export const gzip = (text) => pipe(enc.encode(text), new CompressionStream('gzip'));
export const gunzip = async (bytes) => dec.decode(await pipe(bytes, new DecompressionStream('gzip')));

export function chunkKey(n) {
  return `${KEY_PREFIX}${String(n).padStart(6, '0')}`;
}

export class OrderLog {
  /**
   * @param {{ get(key: string): Promise<any>, put(key: string, value: any): Promise<void> }} storage
   * @param {{ maxBytes?: number, chunkFrames?: number, chunkBytes?: number }} [limits]
   */
  constructor(storage, { maxBytes = LOG_MAX_BYTES, chunkFrames = CHUNK_FRAMES, chunkBytes = CHUNK_BYTES } = {}) {
    this.storage = storage;
    this.maxBytes = maxBytes;
    this.chunkFrames = chunkFrames;
    this.chunkBytes = chunkBytes;
    /** Uncompressed JSON bytes recorded so far. */
    this.bytes = 0;
    this.full = false;
    /** Frames of the open chunk. */
    this.buffer = [];
    this.bufferBytes = 0;
    /** Sealed chunks: their count, and the ones not yet confirmed written. */
    this.sealed = 0;
    this.unwritten = new Map();
    this.lastTick = -1;
    /** Write chain (chunks are stored in order). */
    this.writing = Promise.resolve();
    this.failed = false;
  }

  /** Record one emitted frame `{ tick, orders }` (in tick order). */
  append(frame) {
    if (frame.tick <= this.lastTick) throw new Error('order log ticks must increase');
    this.lastTick = frame.tick;
    if (this.full || frame.orders.length === 0) return;
    const entry = [frame.tick, frame.orders];
    // The same accounting as an online save's orders budget (protocol logEntryBytes).
    const size = logEntryBytes(frame.tick, frame.orders);
    if (this.bytes + size > this.maxBytes) {
      this.full = true;
      return;
    }
    this.bytes += size;
    this.buffer.push(entry);
    this.bufferBytes += size;
    if (this.buffer.length >= this.chunkFrames || this.bufferBytes >= this.chunkBytes) this.seal();
  }

  /** Close the open chunk and write it to storage in the background. */
  seal() {
    if (this.buffer.length === 0) return;
    const n = this.sealed++;
    const frames = this.buffer;
    this.buffer = [];
    this.bufferBytes = 0;
    this.unwritten.set(n, frames);
    this.writing = this.writing
      .then(async () => {
        await this.storage.put(chunkKey(n), await gzip(JSON.stringify(frames)));
        this.unwritten.delete(n);
      })
      .catch((err) => {
        // Kept in memory instead; reads still work.
        this.failed = true;
        logError('order log write failed', err);
      });
  }

  /** The frames of sealed chunk `i` (from memory while its write is pending, else from storage). */
  async chunk(i) {
    const mem = this.unwritten.get(i);
    if (mem) return mem;
    const bytes = await this.storage.get(chunkKey(i));
    if (!(bytes instanceof Uint8Array) && !(bytes instanceof ArrayBuffer)) throw new Error(`order log chunk ${i} is missing`);
    return JSON.parse(await gunzip(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)));
  }

  /**
   * The log chunk by chunk (one in memory at a time), ending with the open
   * chunk. Frames appended meanwhile may or may not be included: callers
   * queue live frames from the start and dedupe by tick.
   */
  async *chunks() {
    let i = 0;
    for (;;) {
      while (i < this.sealed) yield await this.chunk(i++);
      // No await between this check and taking the open chunk.
      if (i === this.sealed) {
        yield this.buffer.slice();
        return;
      }
    }
  }

  /**
   * Forget the log (a rematch went back to the lobby): waits for pending
   * chunk writes, then deletes every stored chunk.
   */
  async clear() {
    this.full = true;
    await this.writing;
    for (let i = 0; i < this.sealed; i++) await this.storage.delete(chunkKey(i));
    this.sealed = 0;
    this.unwritten.clear();
    this.buffer = [];
    this.bufferBytes = 0;
    this.bytes = 0;
  }

  /** Every recorded frame, in order: `[[tick, orders], ...]`. */
  async read() {
    const out = [];
    for await (const frames of this.chunks()) for (const f of frames) out.push(f);
    return out;
  }
}

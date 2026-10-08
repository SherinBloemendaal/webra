// Render data from the simulation worker to the main thread without copies
// through postMessage: two slots in SharedArrayBuffers (double buffer), each
// with a sequence counter (seqlock). The worker writes the slot that was not
// published last, so the renderer can keep reading the latest one; a reader
// checks the counter again after reading and drops a frame that changed
// underneath it (it then draws the slot the worker just finished).
//
// Sequence counter per slot: even = stable, odd = being written. Publishing
// stores the slot index in `latest` after the counter is even again.
//
// Used only when the page is cross-origin isolated (SharedArrayBuffer is
// available); js/sim/host.js otherwise transfers ArrayBuffers per frame.

const HEADER_INTS = 4; // seq slot 0, seq slot 1, latest slot, frames published
const SEQ = 0;
const LATEST = 2;
const PUBLISHED = 3;

const TYPES = { f32: Float32Array, u8: Uint8Array, i32: Int32Array, u32: Uint32Array };

/** Smallest power-of-two element count of at least `n` (and at least `min`). */
export function capacityFor(n, min = 1024) {
  let cap = min;
  while (cap < n) cap *= 2;
  return cap;
}

/**
 * The shared state of a double-buffered frame: a header and, per slot, one
 * SharedArrayBuffer per named section (sprites, rects, fog, ...). Create it in
 * the worker; `describe()` gives what the main thread needs to attach to it
 * (`SharedFrames.attach`).
 */
export class SharedFrames {
  /**
   * @param {Record<string, 'f32' | 'u8' | 'i32' | 'u32'>} sections element type per section
   * @param {{ header?: SharedArrayBuffer }} [o]
   */
  constructor(sections, { header = null } = {}) {
    this.sections = sections;
    this.headerBuffer = header ?? new SharedArrayBuffer(HEADER_INTS * 4);
    this.header = new Int32Array(this.headerBuffer);
    /** slots[s][name] = SharedArrayBuffer */
    this.slots = [{}, {}];
    /** Bumped when a slot's buffers change (the reader re-reads them). */
    this.layout = [0, 0];
  }

  /** What the reader needs: the header (once). Section buffers come with each frame that changed them. */
  describe() {
    return { header: this.headerBuffer, sections: this.sections };
  }

  static attach({ header, sections }) {
    return new SharedFrames(sections, { header });
  }

  // ---- Writer (worker) ---------------------------------------------------------------

  /** The slot to write next: never the one published last. */
  nextSlot() {
    return Atomics.load(this.header, PUBLISHED) === 0 ? 0 : 1 - Atomics.load(this.header, LATEST);
  }

  /**
   * Write one frame. `fill(view(name, length))` copies the data in; `view`
   * returns a typed array of exactly `length` elements over the slot's
   * shared buffer (grown when needed). Returns `{ slot, seq, buffers }`;
   * `buffers` is set when this slot's buffers changed since its last frame.
   */
  write(fill) {
    const slot = this.nextSlot();
    const seqIndex = SEQ + slot;
    // Odd: being written.
    Atomics.add(this.header, seqIndex, 1);
    let grown = false;
    const view = (name, length) => {
      const Type = TYPES[this.sections[name]];
      if (!Type) throw new Error(`unknown frame section ${name}`);
      const have = this.slots[slot][name];
      if (!have || have.byteLength < length * Type.BYTES_PER_ELEMENT) {
        this.slots[slot][name] = new SharedArrayBuffer(capacityFor(length) * Type.BYTES_PER_ELEMENT);
        grown = true;
      }
      return new Type(this.slots[slot][name], 0, length);
    };
    try {
      fill(view);
    } finally {
      // Even again: stable. Then publish.
      Atomics.add(this.header, seqIndex, 1);
    }
    Atomics.store(this.header, LATEST, slot);
    Atomics.add(this.header, PUBLISHED, 1);
    if (grown) this.layout[slot]++;
    const seq = Atomics.load(this.header, seqIndex);
    return { slot, seq, buffers: grown ? { ...this.slots[slot] } : null, layout: this.layout[slot] };
  }

  // ---- Reader (main thread) -------------------------------------------------------------

  /** Take the slot buffers a frame message carried. */
  adopt(slot, buffers) {
    if (buffers) this.slots[slot] = { ...buffers };
  }

  /** Typed array over a section of a slot (no copy). */
  read(slot, name, length) {
    const Type = TYPES[this.sections[name]];
    const buf = this.slots[slot][name];
    if (!buf || !Type) return new (Type ?? Uint8Array)(0);
    return new Type(buf, 0, length);
  }

  /** The latest published slot and its sequence number, or null before the first frame or while it is written. */
  latest() {
    if (Atomics.load(this.header, PUBLISHED) === 0) return null;
    const slot = Atomics.load(this.header, LATEST);
    const seq = Atomics.load(this.header, SEQ + slot);
    if (seq & 1) return null;
    return { slot, seq };
  }

  /** True when slot `slot` still holds the frame with sequence number `seq` (nothing was written over it). */
  valid(slot, seq) {
    return (seq & 1) === 0 && Atomics.load(this.header, SEQ + slot) === seq;
  }
}

/**
 * Pool of plain ArrayBuffers for the transfer mode: the worker copies a frame
 * into buffers from here, transfers them, and the main thread hands them back
 * with its next step, so steady play allocates nothing.
 */
export class BufferPool {
  constructor(limit = 24) {
    this.free = [];
    this.limit = limit;
  }

  /** A buffer of at least `bytes` bytes. */
  take(bytes) {
    let best = -1;
    for (let i = 0; i < this.free.length; i++) {
      const b = this.free[i];
      if (b.byteLength >= bytes && (best < 0 || b.byteLength < this.free[best].byteLength)) best = i;
    }
    if (best >= 0) return this.free.splice(best, 1)[0];
    return new ArrayBuffer(capacityFor(bytes, 4096));
  }

  give(buffers) {
    for (const b of buffers) {
      if (b instanceof ArrayBuffer && b.byteLength > 0 && this.free.length < this.limit) this.free.push(b);
    }
  }
}

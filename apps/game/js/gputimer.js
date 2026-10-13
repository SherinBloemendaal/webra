// GPU time of frames for the performance capture (js/perfcapture.js), only
// while a capture runs:
// - with the `timestamp-query` feature (js/renderer.js asks for it when the
//   adapter has it): the render pass writes a timestamp at its start and its
//   end, resolved into a buffer and read back a few frames later (`gpu`);
// - always: the time from the frame's submit until the GPU finished it
//   (queue.onSubmittedWorkDone, `done`), which shows a GPU that falls behind.
//
//   const timing = timer.begin(frame);          // frame: { gpu(ms), done(ms) }
//   pass = enc.beginRenderPass({ ..., ...timing?.pass });
//   pass.end(); timing?.resolve(enc);
//   queue.submit(...); timing?.submitted();
//
// Readback buffers come from a small pool: when all are in flight, that
// frame has no GPU time (never a stall).

/** Readback buffers in flight at most. */
export const GPU_TIMER_POOL = 4;

const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class GpuTimer {
  /**
   * @param {GPUDevice} device
   * @param {{ usage?: object, now?: () => number, pool?: number }} [o] `usage`: GPUBufferUsage
   *   and GPUMapMode values (tests pass their own)
   */
  constructor(device, { usage = globalThis.GPUBufferUsage, mapMode = globalThis.GPUMapMode, now = clock, pool = GPU_TIMER_POOL } = {}) {
    this.device = device;
    this.now = now;
    this.usage = usage;
    this.mapMode = mapMode;
    this.timestamps = !!device.features?.has?.('timestamp-query') && !!usage && !!mapMode;
    this.querySet = null;
    this.resolveBuffer = null;
    this.free = [];
    this.poolSize = pool;
    this.made = 0;
    this.failed = null;
  }

  /** Make the query set and resolve buffer once timestamps are first used. */
  setup() {
    if (this.querySet || !this.timestamps) return !!this.querySet;
    try {
      this.querySet = this.device.createQuerySet({ type: 'timestamp', count: 2 });
      this.resolveBuffer = this.device.createBuffer({ size: 16, usage: this.usage.QUERY_RESOLVE | this.usage.COPY_SRC });
      return true;
    } catch (err) {
      this.disable(err);
      return false;
    }
  }

  disable(err) {
    this.timestamps = false;
    this.failed = String(err?.message ?? err);
  }

  readback() {
    if (this.free.length) return this.free.pop();
    if (this.made >= this.poolSize) return null;
    this.made++;
    return this.device.createBuffer({ size: 16, usage: this.usage.MAP_READ | this.usage.COPY_DST });
  }

  /**
   * Timing for one frame: `frame.gpu(ms)` gets the render pass's GPU time
   * (timestamps only), `frame.done(ms)` the time from submit to the GPU
   * finishing. Returns `{ pass, resolve(enc), submitted() }`.
   */
  begin(frame) {
    const stamps = this.setup() ? this.readback() : null;
    const timing = {
      pass: stamps ? { timestampWrites: { querySet: this.querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } } : {},
      resolve: (enc) => {
        if (!stamps) return;
        enc.resolveQuerySet(this.querySet, 0, 2, this.resolveBuffer, 0);
        enc.copyBufferToBuffer(this.resolveBuffer, 0, stamps, 0, 16);
      },
      submitted: () => {
        const t0 = this.now();
        this.device.queue
          .onSubmittedWorkDone?.()
          .then(() => frame.done?.(this.now() - t0))
          .catch(() => {});
        if (!stamps) return;
        stamps
          .mapAsync(this.mapMode.READ)
          .then(() => {
            const [start, end] = new BigUint64Array(stamps.getMappedRange());
            stamps.unmap();
            this.free.push(stamps);
            // Nanoseconds; some GPUs report a start after the end when the pass was split.
            if (end > start) frame.gpu?.(Number(end - start) / 1e6);
          })
          .catch((err) => this.disable(err));
      },
    };
    return timing;
  }
}

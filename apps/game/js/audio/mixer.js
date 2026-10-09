// Web Audio output: one AudioContext (created on the first user gesture, as
// browsers require), a bus per volume setting into a master gain and a
// limiter, and a voice limit per bus so thousands of units can never start
// thousands of sources.

import { busGain } from './prefs.js';

/** Concurrent sources per bus. */
export const VOICE_LIMITS = { effects: 28, voices: 4, music: 2 };

export class Mixer {
  constructor() {
    this.ctx = null;
    this.buses = null;
    this.active = { effects: [], voices: [], music: [] };
    this.prefs = null;
  }

  get ready() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  /** Create or resume the context. Call from a user gesture (click, key). */
  unlock() {
    if (!this.ctx) {
      const AC = globalThis.AudioContext ?? globalThis.webkitAudioContext;
      if (!AC) return false;
      this.ctx = new AC({ latencyHint: 'interactive' });
      const limiter = this.ctx.createDynamicsCompressor();
      limiter.threshold.value = -10;
      limiter.knee.value = 6;
      limiter.ratio.value = 8;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.2;
      limiter.connect(this.ctx.destination);
      const master = this.ctx.createGain();
      master.connect(limiter);
      this.buses = { master };
      for (const bus of ['effects', 'voices', 'music']) {
        const g = this.ctx.createGain();
        g.connect(master);
        this.buses[bus] = g;
      }
      if (this.prefs) this.apply(this.prefs);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return true;
  }

  /** Apply volume settings (smoothly, no clicks). */
  apply(prefs) {
    this.prefs = prefs;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.buses.master.gain.setTargetAtTime(1, t, 0.02);
    for (const bus of ['effects', 'voices', 'music']) this.buses[bus].gain.setTargetAtTime(busGain(prefs, bus), t, 0.03);
  }

  /** Mono samples to an AudioBuffer (null before unlock). */
  buffer(samples, sampleRate) {
    if (!this.ctx || samples.length === 0) return null;
    const buf = this.ctx.createBuffer(1, samples.length, sampleRate);
    buf.copyToChannel(samples, 0);
    return buf;
  }

  /**
   * Start a buffer on a bus, `offset` seconds into it. Returns a handle
   * { stop(), ended: Promise, position(): seconds played into the buffer } or
   * null when the context is not running or the bus is full of louder sounds.
   */
  play(buffer, { bus = 'effects', gain = 1, pan = 0, rate = 1, onEnded = null, offset = 0 } = {}) {
    if (!this.ready || !buffer) return null;
    if (this.prefs && busGain(this.prefs, bus) <= 0 && bus !== 'music') return null;
    const list = this.active[bus];
    const limit = VOICE_LIMITS[bus] ?? 8;
    if (list.length >= limit) {
      // Steal the quietest voice, unless the new one is quieter still.
      let q = 0;
      for (let i = 1; i < list.length; i++) if (list[i].gain < list[q].gain) q = i;
      if (list[q].gain >= gain) return null;
      list[q].stop();
    }
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g);
    let tail = g;
    if (pan && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      g.connect(p);
      tail = p;
    }
    tail.connect(this.buses[bus]);
    let resolveEnded;
    const startedAt = ctx.currentTime;
    const handle = {
      gain,
      position: () => offset + (ctx.currentTime - startedAt) * rate,
      ended: new Promise((r) => (resolveEnded = r)),
      stop: () => {
        try {
          src.stop();
        } catch {
          // already stopped
        }
      },
    };
    src.onended = () => {
      const i = list.indexOf(handle);
      if (i >= 0) list.splice(i, 1);
      src.disconnect();
      tail.disconnect();
      if (tail !== g) g.disconnect();
      resolveEnded();
      onEnded?.();
    };
    list.push(handle);
    src.start(0, Math.max(0, Math.min(offset, buffer.duration ?? offset)));
    return handle;
  }

  stopBus(bus) {
    for (const h of [...this.active[bus]]) h.stop();
  }
}

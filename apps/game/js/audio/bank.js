// Turns a sound (catalog.js: { synth, originals }) into something playable:
// an installed original file when the player has one and wants originals,
// otherwise our synthesized sound. Both end up as cached AudioBuffers.

import { decodeAud } from './aud.js';
import { MUSIC_FILES } from './catalog.js';
import { render, variantRate, VARIANTS } from './synth.js';

export class SoundBank {
  /**
   * @param {import('./mixer.js').Mixer} mixer
   * @param {() => { original: boolean }} prefs current settings
   */
  constructor(mixer, prefs) {
    this.mixer = mixer;
    this.prefs = prefs;
    this.originals = new Map(); // name -> Uint8Array (.aud bytes)
    this.decoded = new Map(); // name -> AudioBuffer | null
    this.synth = new Map(); // `${id}#${variant}` -> AudioBuffer
  }

  /** Load the installed effects, voices and announcer files (music streams from the store when played). */
  async loadInstalled(store) {
    const records = await store.getAll((name) => !MUSIC_FILES.has(name));
    this.originals.clear();
    this.decoded.clear();
    for (const r of records) this.originals.set(r.name, new Uint8Array(r.bytes));
    return this.originals.size;
  }

  hasOriginal(name) {
    return this.originals.has(name);
  }

  /** Installed candidates of a sound, when originals are on. */
  installed(sound) {
    if (!this.prefs().original || !sound.originals?.length) return [];
    return sound.originals.filter((n) => this.originals.has(n));
  }

  originalBuffer(name) {
    if (!this.decoded.has(name)) {
      let buf = null;
      try {
        const { sampleRate, samples } = decodeAud(this.originals.get(name));
        buf = this.mixer.buffer(samples, sampleRate);
      } catch {
        buf = null; // checked at install time; a broken record just falls back to the synthesized sound
      }
      if (!buf && !this.mixer.ctx) return null; // not unlocked yet: try again later
      this.decoded.set(name, buf);
    }
    return this.decoded.get(name);
  }

  synthBuffer(id, variant) {
    const key = `${id}#${variant}`;
    if (!this.synth.has(key)) {
      if (!this.mixer.ctx) return null;
      const sr = this.mixer.ctx.sampleRate;
      const samples = render(id, sr, variant);
      if (!samples) return null;
      this.synth.set(key, this.mixer.buffer(samples, sr));
    }
    return this.synth.get(key);
  }

  /**
   * Something to play for `sound`: { buffer, rate, original } or null.
   * `random` picks among candidates and variants (Math.random by default).
   */
  resolve(sound, random = Math.random) {
    const names = this.installed(sound);
    if (names.length) {
      const buffer = this.originalBuffer(names[Math.floor(random() * names.length)]);
      if (buffer) return { buffer, rate: 1, original: true };
    }
    if (!sound.synth) return null;
    const variant = Math.floor(random() * VARIANTS);
    const buffer = this.synthBuffer(sound.synth, variant);
    return buffer ? { buffer, rate: variantRate(variant), original: false } : null;
  }
}

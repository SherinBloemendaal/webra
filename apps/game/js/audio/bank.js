// Turns a sound (catalog.js: { synth, originals }) into something playable:
// an installed original file when the player has one and wants originals,
// otherwise our synthesized sound. Both end up as cached AudioBuffers.

import { decodeAud } from './aud.js';
import { MUSIC_FILES } from './catalog.js';
import { render, variantRate, VARIANTS } from './synth.js';

/** Sound files in the content store (graphics share it): .aud files and voice variants. */
export const isSoundName = (name) => /\.(aud|[vr]0\d)$/i.test(name);

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
    /** Texture pack sounds (js/content/packs.js), decoded: key -> AudioBuffer. Keys are sound events or original names. */
    this.pack = new Map();
  }

  /** A texture pack's sound for an original file name or a sound event, or null. */
  packBuffer(name) {
    if (!name) return null;
    const key = String(name).toLowerCase();
    return this.pack.get(key) ?? this.pack.get(key.replace(/\.aud$/, '')) ?? null;
  }

  /** Load the installed effects, voices and announcer files (music streams from the store when played). */
  async loadInstalled(store) {
    const records = await store.getAll((name) => isSoundName(name) && !MUSIC_FILES.has(name));
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
   * Everything to play at once for `sound`: a list of { buffer, rate, original }.
   * A `layered` sound (OpenRA plays every entry, e.g. BuildSounds placbldg and
   * build5) plays each of its originals that a texture pack or the installed
   * files have, together; with none of them it falls back to the sound
   * event's pack sound or our synthesized one, like `resolve`. Any other
   * sound gives at most one, from `resolve`.
   */
  resolveAll(sound, random = Math.random) {
    if (!sound.layered) {
      const one = this.resolve(sound, random);
      return one ? [one] : [];
    }
    // Same order as `resolve`: texture packs (the original names, then the
    // sound event), installed originals, ours. A pack that replaces one part
    // keeps the installed files of the other parts.
    const names = sound.originals ?? [];
    const packed = names.map((n) => this.packBuffer(n));
    const installed = new Set(this.installed(sound));
    const original = (n) => (installed.has(n) ? this.originalBuffer(n) : null);
    if (packed.some(Boolean)) {
      return names
        .map((n, i) => (packed[i] ? { buffer: packed[i], rate: 1, original: false, pack: true } : { buffer: original(n), rate: 1, original: true }))
        .filter((r) => r.buffer);
    }
    const own = this.packBuffer(sound.synth);
    if (own) return [{ buffer: own, rate: 1, original: false, pack: true }];
    const layers = names.map(original).filter(Boolean).map((buffer) => ({ buffer, rate: 1, original: true }));
    if (layers.length) return layers;
    const one = this.resolve({ synth: sound.synth, originals: [] }, random);
    return one ? [one] : [];
  }

  /**
   * Something to play for `sound`: { buffer, rate, original } or null.
   * `random` picks among candidates and variants (Math.random by default).
   */
  resolve(sound, random = Math.random) {
    // Texture packs first (any of the original names, then the sound event), then originals, then ours.
    const packed = (sound.originals ?? []).map((n) => this.packBuffer(n)).filter(Boolean);
    if (packed.length) return { buffer: packed[Math.floor(random() * packed.length)], rate: 1, original: false, pack: true };
    const own = this.packBuffer(sound.synth);
    if (own) return { buffer: own, rate: 1, original: false, pack: true };
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

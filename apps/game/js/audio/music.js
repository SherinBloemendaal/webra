// Music: the original Red Alert soundtrack, only when the player installed it
// from their own copy (scores.mix). Tracks play shuffled, one after another,
// on the music bus; WebRA ships no music of its own.

import { decodeAud } from './aud.js';
import { MUSIC } from './catalog.js';

/** A shuffled order of `n` items that does not start with `avoid`. */
export function shuffle(n, random = Math.random, avoid = -1) {
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  if (n > 1 && order[0] === avoid) [order[0], order[1]] = [order[1], order[0]];
  return order;
}

export class Jukebox {
  constructor(mixer, getStore, onChange = () => {}, packTracks = () => new Map(), useOriginals = () => true) {
    /** Whether installed original tracks play ("Use original sounds"). */
    this.useOriginals = useOriginals;
    this.mixer = mixer;
    this.getStore = getStore;
    /** Texture pack music: () => Map(original track file or its name without .aud -> AudioBuffer). */
    this.packTracks = packTracks;
    this.onChange = onChange;
    this.tracks = []; // { file, title } installed
    this.order = [];
    this.pos = 0;
    this.handle = null;
    this.playing = null; // title
    this.wanted = false; // should be playing (game running, music on)
    this.token = 0;
    /** The music hotkeys stopped it (OpenRA StopMusic): it stays off until started again. */
    this.stoppedByUser = false;
    /** Paused (OpenRA PauseMusic): { track, buffer, at } to resume from, or null. */
    this.paused = null;
    this.buffer = null;
    this.track = null;
  }

  /** Refresh the installed track list from the store. */
  async refresh() {
    const store = await this.getStore();
    const names = new Set(await store.names());
    const pack = this.packTracks();
    const originals = this.useOriginals();
    this.tracks = MUSIC.filter((m) => (originals && names.has(m.file)) || pack.has(m.file) || pack.has(m.file.replace(/\.aud$/, '')));
    this.order = shuffle(this.tracks.length);
    this.pos = 0;
    return this.tracks.length;
  }

  get available() {
    return this.tracks.length > 0;
  }

  async start() {
    this.wanted = true;
    if (!this.handle) await this.next();
  }

  stop() {
    this.wanted = false;
    this.token++;
    const h = this.handle;
    this.handle = null;
    this.playing = null;
    this.paused = null;
    h?.stop();
    this.onChange();
  }

  /** The stop music hotkey: off until the player starts it again (next, previous, pause). */
  userStop() {
    this.stop();
    this.stoppedByUser = true;
  }

  /**
   * The pause music hotkey (OpenRA PauseOrResumeMusic): pause what plays,
   * resume what was paused, or start the next track.
   */
  async togglePause() {
    if (this.handle && this.buffer) {
      const at = this.handle.position?.() ?? 0;
      const paused = { track: this.track, buffer: this.buffer, at };
      this.stop();
      this.paused = paused;
      this.playing = null;
      this.onChange();
      return;
    }
    this.stoppedByUser = false;
    const p = this.paused;
    if (p && this.mixer.ready) {
      this.paused = null;
      this.start_(p.track, p.buffer, p.at);
      return;
    }
    await this.next();
  }

  /** The previous track of the shuffled order (OpenRA PrevMusic). */
  async prev() {
    if (!this.tracks.length) return;
    // `pos` is past the track playing now: two back is the one before it.
    this.pos = Math.max(0, Math.min(this.pos, this.order.length) - 2);
    await this.next();
  }

  /** Play `buffer` of `track` from `offset` seconds; the next track follows when it ends. */
  start_(track, buffer, offset = 0) {
    const token = ++this.token;
    this.wanted = true;
    this.stoppedByUser = false;
    this.playing = track.title;
    this.track = track;
    this.buffer = buffer;
    this.handle = this.mixer.play(buffer, {
      bus: 'music',
      offset,
      onEnded: () => {
        if (token === this.token && this.wanted) this.next();
      },
    });
    this.onChange();
  }

  /** Play the next track of the shuffled order. */
  async next() {
    this.stoppedByUser = false;
    this.paused = null;
    if (!this.tracks.length || !this.mixer.ready) return;
    const token = ++this.token;
    const old = this.handle;
    this.handle = null;
    old?.stop();
    if (this.pos >= this.order.length) {
      this.order = shuffle(this.tracks.length, Math.random, this.order[this.order.length - 1]);
      this.pos = 0;
    }
    const track = this.tracks[this.order[this.pos++]];
    // A texture pack's version of the track first, then the installed original.
    const pack = this.packTracks();
    let buffer = pack.get(track.file) ?? pack.get(track.file.replace(/\.aud$/, '')) ?? null;
    if (!buffer) {
      const store = await this.getStore();
      const rec = await store.get(track.file);
      if (token !== this.token || !rec) return;
      try {
        const { sampleRate, samples } = decodeAud(new Uint8Array(rec.bytes));
        buffer = this.mixer.buffer(samples, sampleRate);
      } catch {
        buffer = null;
      }
    }
    if (!buffer || token !== this.token) return;
    this.start_(track, buffer);
  }
}

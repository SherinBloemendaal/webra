// Music: the original Red Alert soundtrack, only when the player installed it
// from their own copy (scores.mix), and texture pack music. Tracks play one
// after another on the music bus, shuffled or as listed, repeating all, one
// or none (Settings: audio.musicShuffle, audio.musicRepeat); WebRA ships no
// music of its own.

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

/** The order of `n` tracks: shuffled (not starting with `avoid`) or as listed. */
export function playOrder(n, shuffled, random = Math.random, avoid = -1) {
  return shuffled ? shuffle(n, random, avoid) : Array.from({ length: n }, (_, i) => i);
}

export class Jukebox {
  /**
   * @param {import('./mixer.js').Mixer} mixer
   * @param {() => Promise<object>} getStore the content store
   * @param {() => void} [onChange] the track or the playlist changed
   * @param {() => Map<string, AudioBuffer>} [packTracks] texture pack music
   * @param {() => boolean} [useOriginals] whether installed original tracks play ("Use original sounds")
   * @param {() => { shuffle: boolean, repeat: 'all' | 'one' | 'off' }} [mode] the player's music settings
   */
  constructor(mixer, getStore, onChange = () => {}, packTracks = () => new Map(), useOriginals = () => true, mode = () => ({ shuffle: true, repeat: 'all' })) {
    this.useOriginals = useOriginals;
    this.mixer = mixer;
    this.getStore = getStore;
    /** Texture pack music: () => Map(original track file or its name without .aud -> AudioBuffer). */
    this.packTracks = packTracks;
    this.onChange = onChange;
    this.mode = mode;
    this.random = Math.random;
    this.tracks = []; // { file, title } installed
    this.order = [];
    this.pos = 0;
    this.current = -1; // index into tracks of the playing (or last played) track
    this.handle = null;
    this.playing = null; // title
    this.wanted = false; // should be playing (game running, music on)
    /** The playlist ended with repeat off: quiet until the player asks for the next track. */
    this.finished = false;
    this.token = 0;
    /** The music hotkeys stopped it (OpenRA StopMusic): it stays off until started again. */
    this.stoppedByUser = false;
    /** Paused (OpenRA PauseMusic): { index, buffer, at } to resume from, or null. */
    this.paused = null;
    this.buffer = null;
  }

  /** Refresh the installed track list from the store. */
  async refresh() {
    const store = await this.getStore();
    const names = new Set(await store.names());
    const pack = this.packTracks();
    const originals = this.useOriginals();
    this.tracks = MUSIC.filter((m) => (originals && names.has(m.file)) || pack.has(m.file) || pack.has(m.file.replace(/\.aud$/, '')));
    this.order = playOrder(this.tracks.length, this.mode().shuffle, this.random);
    this.pos = 0;
    this.current = -1;
    this.finished = false;
    return this.tracks.length;
  }

  get available() {
    return this.tracks.length > 0;
  }

  /**
   * Shuffle switched: a new order from the track after the playing one, so
   * the playing track is not cut off and every track still comes once.
   */
  reorder() {
    const n = this.tracks.length;
    if (this.mode().shuffle) {
      this.order = playOrder(n, true, this.random, this.current);
      this.pos = 0;
    } else {
      this.order = playOrder(n, false);
      this.pos = this.current >= 0 ? this.current + 1 : 0;
    }
  }

  /** Repeat switched: a finished playlist may play again (the caller syncs). */
  repeatChanged() {
    if (this.mode().repeat !== 'off') this.finished = false;
  }

  async start() {
    this.wanted = true;
    if (!this.handle && !this.finished) await this.next();
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
      const paused = { index: this.current, buffer: this.buffer, at: this.handle.position?.() ?? 0 };
      this.stop();
      this.paused = paused;
      this.onChange();
      return;
    }
    this.stoppedByUser = false;
    const p = this.paused;
    if (p && this.mixer.ready && this.tracks[p.index]) {
      this.paused = null;
      this.current = p.index;
      this.play(this.tracks[p.index], p.buffer, ++this.token, p.at);
      return;
    }
    await this.next();
  }

  /** The track before the playing one in the play order (OpenRA PrevMusic). */
  async prev() {
    if (!this.tracks.length) return;
    const i = this.order.indexOf(this.current);
    this.pos = i > 0 ? i - 1 : Math.max(0, this.order.length - 1);
    this.finished = false;
    await this.next();
  }

  /**
   * The index of the track to play next, or -1 when the playlist is over.
   * `ended`: the last track played to its end (repeat one plays it again);
   * otherwise the player asked for the next track.
   */
  pick(ended) {
    const { repeat } = this.mode();
    if (ended && repeat === 'one' && this.current >= 0) return this.current;
    if (this.pos >= this.order.length) {
      if (ended && repeat === 'off') return -1;
      this.order = playOrder(this.tracks.length, this.mode().shuffle, this.random, this.order[this.order.length - 1]);
      this.pos = 0;
    }
    return this.order[this.pos++];
  }

  /**
   * Play the next track. `ended` is set when the previous one played to its
   * end; "Next track" (the player) always plays one, also after a finished playlist.
   */
  async next({ ended = false } = {}) {
    this.stoppedByUser = false;
    this.paused = null;
    if (!this.tracks.length || !this.mixer.ready) return;
    const token = ++this.token;
    const old = this.handle;
    this.handle = null;
    old?.stop();
    if (!ended && this.finished) {
      this.finished = false;
      this.order = playOrder(this.tracks.length, this.mode().shuffle, this.random, this.current);
      this.pos = 0;
    }
    const index = this.pick(ended);
    if (index < 0) {
      this.finished = true;
      this.playing = null;
      this.onChange();
      return;
    }
    this.current = index;
    const track = this.tracks[index];
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
    this.play(track, buffer, token);
  }

  /** Play `buffer` of `track` from `offset` seconds; when it ends, the next track follows. */
  play(track, buffer, token, offset = 0) {
    this.wanted = true;
    this.stoppedByUser = false;
    this.playing = track.title;
    this.buffer = buffer;
    this.handle = this.mixer.play(buffer, {
      bus: 'music',
      offset,
      onEnded: () => {
        if (token === this.token && this.wanted) this.next({ ended: true });
      },
    });
    this.onChange();
  }
}

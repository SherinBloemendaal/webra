// Music: the original Red Alert soundtrack (with the Counterstrike and
// Aftermath tracks), only when the player installed it from their own copy,
// and texture pack music. Tracks play one after another on the music bus,
// shuffled or as listed, repeating all, one or none (Settings:
// audio.musicShuffle, audio.musicRepeat), each at its music.yaml
// VolumeModifier; WebRA ships no music of its own. A background track
// (OpenRA MusicPlaylist: the menu's intro, the score and map tracks after a
// game) loops until the player picks another track.

import { audDuration, decodeAud } from './aud.js';
import { MUSIC, PLAYLIST } from './catalog.js';

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
    this.tracks = []; // { file, title, volume } installed playlist tracks
    /** Every installed track file, hidden background tracks included. */
    this.installed = new Set();
    /** The background track playing (or wanted while the music waits), or null. */
    this.background = null;
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
    /** Seconds per track file, once known (the AUD header, a texture pack track's length, a played track). */
    this.lengths = new Map();
  }

  /** Refresh the installed track list from the store. */
  async refresh() {
    const store = await this.getStore();
    const names = new Set(await store.names());
    const pack = this.packTracks();
    const originals = this.useOriginals();
    const has = (m) => (originals && names.has(m.file)) || pack.has(m.file) || pack.has(m.file.replace(/\.aud$/, ''));
    this.installed = new Set(MUSIC.filter(has).map((m) => m.file));
    this.tracks = PLAYLIST.filter(has);
    this.order = playOrder(this.tracks.length, this.mode().shuffle, this.random);
    this.pos = 0;
    this.current = -1;
    this.finished = false;
    // A texture pack may have brought another version of a track.
    this.lengths.clear();
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
    this.background = null;
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
      const paused = { index: this.current, buffer: this.buffer, at: this.handle.position?.() ?? 0, background: this.background };
      this.stop();
      this.paused = paused;
      this.onChange();
      return;
    }
    this.stoppedByUser = false;
    const p = this.paused;
    if (p?.background && this.mixer.ready) {
      this.paused = null;
      this.background = p.background;
      this.play(p.background, p.buffer, ++this.token, p.at);
      return;
    }
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
    this.background = null;
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
    await this.startTrack(index, token);
  }

  /**
   * Play track `index` now (the music player's track list). The playlist goes
   * on from there: in order with the tracks after it, shuffled with the
   * others in a new random order.
   */
  async playIndex(index) {
    const n = this.tracks.length;
    if (!this.tracks[index] || !this.mixer.ready) return;
    this.stoppedByUser = false;
    this.paused = null;
    this.background = null;
    this.finished = false;
    const token = ++this.token;
    const old = this.handle;
    this.handle = null;
    old?.stop();
    if (this.mode().shuffle) {
      this.order = [index, ...playOrder(n, true, this.random).filter((i) => i !== index)];
      this.pos = 1;
    } else {
      this.order = playOrder(n, false);
      this.pos = index + 1;
    }
    this.current = index;
    this.onChange();
    await this.startTrack(index, token);
  }

  /** Load and play track `index` unless another request (`token`) came in meanwhile. */
  async startTrack(index, token) {
    const track = this.tracks[index];
    // A texture pack's track plays at once (no await: the handle exists before anything else asks).
    const buffer = this.packBuffer(track) ?? (await this.load(track, token));
    if (!buffer || token !== this.token) return;
    if (buffer.duration) this.lengths.set(track.file, buffer.duration);
    this.play(track, buffer, token);
  }

  /** The decoded track: a texture pack's version first, then the installed original (null when neither, or `token` is stale). */
  async load(track, token) {
    const packed = this.packBuffer(track);
    if (packed) return packed;
    if (!this.useOriginals()) return null;
    const store = await this.getStore();
    const rec = await store.get(track.file);
    if (token !== this.token || !rec) return null;
    try {
      const { sampleRate, samples } = decodeAud(new Uint8Array(rec.bytes));
      return this.mixer.buffer(samples, sampleRate);
    } catch {
      return null;
    }
  }

  /** A texture pack's version of `track` (by its file name, with or without .aud), or null. */
  packBuffer(track) {
    const pack = this.packTracks();
    return pack.get(track.file) ?? pack.get(track.file.replace(/\.aud$/, '')) ?? null;
  }

  /** Whether `track` (a catalog.js MUSIC entry) is installed or in a texture pack. */
  has(track) {
    return !!track && this.installed.has(track.file);
  }

  /**
   * Play `track` as background music (OpenRA MusicPlaylist.SetBackgroundMusic
   * and Stop: it loops until the player picks another track). Returns
   * whether it plays.
   */
  async playBackground(track) {
    if (!this.has(track) || !this.mixer.ready) return false;
    this.stoppedByUser = false;
    this.paused = null;
    const token = ++this.token;
    const old = this.handle;
    this.handle = null;
    old?.stop();
    this.background = track;
    const buffer = this.packBuffer(track) ?? (await this.load(track, token));
    if (!buffer || token !== this.token) return false;
    this.play(track, buffer, token);
    return true;
  }

  /** Seconds into the playing or paused track (0 when none). */
  elapsed() {
    if (this.handle) return Math.max(0, this.handle.position?.() ?? 0);
    return this.paused?.at ?? 0;
  }

  /** Length in seconds of track `index`, or null while unknown. */
  length(index) {
    const track = this.tracks[index];
    return track ? (this.lengths.get(track.file) ?? null) : null;
  }

  /**
   * Find the length of every track (the music player lists them): a texture
   * pack track's duration, or the AUD header of the installed file. Stops
   * early when the playlist changes meanwhile.
   * @returns {Promise<boolean>} whether a length was found
   */
  async measure() {
    const tracks = this.tracks;
    const pack = this.packTracks();
    let store = null;
    let found = false;
    for (const track of tracks) {
      if (this.tracks !== tracks) return found;
      if (this.lengths.has(track.file)) continue;
      const packed = pack.get(track.file) ?? pack.get(track.file.replace(/\.aud$/, ''));
      let seconds = packed?.duration ?? null;
      if (seconds === null) {
        store ??= await this.getStore();
        const rec = await store.get(track.file);
        if (!rec) continue;
        try {
          seconds = audDuration(new Uint8Array(rec.bytes));
        } catch {
          continue; // a broken file: its length stays unknown
        }
      }
      if (this.tracks !== tracks) return found;
      this.lengths.set(track.file, seconds);
      found = true;
    }
    return found;
  }

  /**
   * Play `buffer` of `track` from `offset` seconds, at the track's
   * VolumeModifier; when it ends, the next track follows (a background track
   * starts again).
   */
  play(track, buffer, token, offset = 0) {
    this.wanted = true;
    this.stoppedByUser = false;
    this.playing = track.title;
    this.buffer = buffer;
    this.handle = this.mixer.play(buffer, {
      bus: 'music',
      gain: track.volume ?? 1,
      offset,
      onEnded: () => {
        if (token !== this.token || !this.wanted) return;
        if (this.background === track) this.play(track, buffer, ++this.token);
        else this.next({ ended: true });
      },
    });
    this.onChange();
  }
}

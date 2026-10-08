// Game audio: wires settings, the mixer, the sound bank, speech, the
// announcer, the director and music together, and offers main.js a few small
// hooks (attach a game, per-frame update, player state, selection, ...).
//
// Two layers of sound: our own synthesized sounds (default, shipped) and,
// when the player installed them from their own copy of Red Alert, the
// original files (install.js). See docs in catalog.js.

import { Prefs, busGain } from './prefs.js';
import { Mixer } from './mixer.js';
import { SoundBank } from './bank.js';
import { Speech } from './speech.js';
import { Announcer } from './announcer.js';
import { Director } from './director.js';
import { Jukebox } from './music.js';
import { IdbStore, MemoryStore } from './store.js';
import { EVA } from './catalog.js';

/** Game methods that give a unit order: the units reply. Their second argument is the unit ids. */
export const ORDER_METHODS = new Set([
  'order_smart',
  'order_move',
  'order_attack',
  'order_land',
  'order_return_to_base',
  'order_teleport',
  'order_lay_mines',
  'deploy',
]);

const now = () => performance.now() / 1000;
const wait = (s) => new Promise((r) => setTimeout(r, s * 1000));

export class AudioSystem {
  constructor({ storage = globalThis.localStorage, doc = globalThis.document } = {}) {
    this.prefs = new Prefs(storage);
    this.mixer = new Mixer();
    this.mixer.apply(this.prefs.get());
    this.speech = new Speech();
    this.bank = new SoundBank(this.mixer, () => this.prefs.get());
    this.storePromise = null;
    this.storeError = null;
    this.announcer = new Announcer({ play: (key) => this.playAnnouncement(key), now });
    this.jukebox = new Jukebox(this.mixer, () => this.store(), () => this.changed());
    this.director = null;
    this.game = null;
    this.inGame = false;
    this.listeners = new Set();
    this.prefs.subscribe((p) => {
      this.mixer.apply(p);
      if (!p.speech || !p.enabled) this.speech.cancel();
      this.syncMusic();
    });
    this.installUnlock(doc);
    this.reloadInstalled();
  }

  /** Browsers only allow audio after a user gesture: unlock on the first one. */
  installUnlock(doc) {
    if (!doc) return;
    const unlock = () => {
      if (!this.mixer.unlock()) return;
      if (this.mixer.ctx.state === 'running') {
        doc.removeEventListener('pointerdown', unlock, true);
        doc.removeEventListener('keydown', unlock, true);
        this.syncMusic();
      } else {
        this.mixer.ctx.addEventListener('statechange', () => this.syncMusic(), { once: true });
      }
    };
    doc.addEventListener('pointerdown', unlock, true);
    doc.addEventListener('keydown', unlock, true);
  }

  /** The content store; IndexedDB, or memory when the browser blocks it. */
  store() {
    if (!this.storePromise) {
      this.storePromise = IdbStore.open().catch((err) => {
        this.storeError = err.message ?? String(err);
        return new MemoryStore();
      });
    }
    return this.storePromise;
  }

  async reloadInstalled() {
    try {
      const store = await this.store();
      await this.bank.loadInstalled(store);
      await this.jukebox.refresh();
    } catch (err) {
      this.storeError = err.message ?? String(err);
    }
    this.syncMusic();
    this.changed();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  changed() {
    for (const fn of this.listeners) fn();
  }

  // ---- Game hooks (main.js) ---------------------------------------------------

  /**
   * Start sound for a game: turns on the engine's audio events.
   * @param {object} o
   * @param {object} o.game wasm Game
   * @param {object} o.rules parsed Game.rules_json()
   * @param {number} o.player local player
   * @param {number} o.worldUnitsPerCell Game.world_units_per_cell()
   */
  attachGame({ game, rules, player, worldUnitsPerCell }) {
    this.game = game;
    game.set_audio_events(true);
    const sideIndex = rules.players?.[player]?.side ?? 0;
    this.pxPerCell = rules.pxPerCell;
    this.mapWidth = game.map_width();
    this.director = new Director({
      rules,
      player,
      side: sideIndex === 1 ? 'soviet' : 'allies',
      pxPerWorld: rules.pxPerCell / worldUnitsPerCell,
      lookup: (id) => {
        try {
          return JSON.parse(game.actor_json(id));
        } catch {
          return null;
        }
      },
      sink: this,
      now,
    });
    this.inGame = true;
    this.syncMusic();
  }

  /**
   * Wrap a game so local unit orders and production clicks made through it
   * get their replies and announcements. Everything else passes through.
   */
  watch(game) {
    const cache = new Map();
    const audio = this;
    return new Proxy(game, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (typeof value !== 'function') return value;
        if (!cache.has(prop)) {
          let fn = value.bind(target);
          if (ORDER_METHODS.has(prop)) {
            fn = (...args) => {
              const r = value.apply(target, args);
              audio.director?.onOrder(Array.from(args[1] ?? []));
              return r;
            };
          } else if (prop === 'start_production') {
            fn = (...args) => {
              const r = value.apply(target, args);
              audio.director?.onProductionStarted(args[1]);
              return r;
            };
          } else if (prop === 'cancel_production') {
            fn = (...args) => {
              const r = value.apply(target, args);
              audio.director?.onProductionCancelled();
              return r;
            };
          }
          cache.set(prop, fn);
        }
        return cache.get(prop);
      },
    });
  }

  /**
   * Per frame, after the simulation ticked: play this frame's events.
   * @param {{ x0, y0, x1, y1 }} view visible world rectangle in pixels
   * @param {() => Uint8Array} [fog] the local player's fog bytes (0 shroud, 1 fog, 2 visible)
   */
  frame(view, fog) {
    if (!this.director || !this.game) return;
    const events = this.game.take_audio_events();
    if (!events.length) return;
    if (!this.prefs.get().enabled) return;
    let visible;
    if (fog) {
      const bytes = fog();
      const cell = this.pxPerCell;
      const w = this.mapWidth;
      visible = (x, y) => {
        const cx = Math.floor(x / cell);
        const cy = Math.floor(y / cell);
        if (cx < 0 || cy < 0 || cx >= w) return false;
        return bytes[cy * w + cx] === 2;
      };
    }
    this.director.onEvents(events, view, visible);
  }

  playerState(state) {
    this.director?.onPlayerState(state);
  }

  selection(ids) {
    this.director?.onSelection(ids);
  }

  selectTarget() {
    this.director?.onSelectTarget();
  }

  gameOver(won) {
    this.director?.onGameOver(won);
  }

  // ---- Sink (director.js) --------------------------------------------------------

  effect(sound, { gain = 1, pan = 0 } = {}) {
    const r = this.bank.resolve(sound);
    if (r) this.mixer.play(r.buffer, { bus: 'effects', gain, pan, rate: r.rate });
  }

  /** A unit reply: original voice, or radio blip with an optional spoken line. */
  voice(line) {
    const p = this.prefs.get();
    if (!p.enabled) return;
    const original = this.bank.resolve({ synth: null, originals: line.originals });
    if (original) {
      this.mixer.play(original.buffer, { bus: 'voices' });
      return;
    }
    const speak = p.speech && this.speech.available && !this.announcer.busy && !this.speech.speaking;
    if (!speak) {
      this.playSynth(line.synth, 'voices');
      return;
    }
    const text = line.spoken[Math.floor(Math.random() * line.spoken.length)];
    this.playSynth('radio_open', 'voices');
    this.speech.speak(text, { role: 'unit', volume: busGain(p, 'voices') }).then(() => this.playSynth('radio_close', 'voices'));
  }

  announce(key) {
    if (this.prefs.get().enabled) this.announcer.push(key);
  }

  playSynth(id, bus, gain = 1) {
    const r = this.bank.resolve({ synth: id, originals: [] });
    return r ? this.mixer.play(r.buffer, { bus, gain, rate: 1 }) : null;
  }

  /** Play one announcer line to the end (the announcer queue awaits this). */
  async playAnnouncement(key) {
    const line = EVA[key];
    const p = this.prefs.get();
    const original = this.bank.resolve({ synth: null, originals: line.originals });
    if (original) {
      const h = this.mixer.play(original.buffer, { bus: 'voices' });
      if (h) await h.ended;
      return;
    }
    const chime = this.playSynth(line.chime, 'voices', 0.8);
    if (p.speech && this.speech.available) {
      await wait(0.2);
      await this.speech.speak(line.text, { role: 'eva', volume: busGain(p, 'voices') });
    } else if (chime) {
      await chime.ended;
    }
  }

  // ---- Music ------------------------------------------------------------------------

  syncMusic() {
    const p = this.prefs.get();
    const want = this.inGame && p.enabled && p.original && p.music > 0 && this.jukebox.available && this.mixer.ready;
    if (want && !this.jukebox.handle) this.jukebox.start();
    else if (!want && this.jukebox.handle) this.jukebox.stop();
  }

  /** Short test sound for the settings panel. */
  test(kind) {
    this.mixer.unlock();
    if (kind === 'voices') this.announce('unitReady');
    else this.effect({ synth: 'cannon', originals: ['cannon1.aud'] }, { gain: 1, pan: 0 });
  }
}

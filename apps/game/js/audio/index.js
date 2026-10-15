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
import { Director, thunderCue } from './director.js';
import { Jukebox } from './music.js';
import { openContentStore, storeError } from './store.js';
import { defaultRegistry } from '../registry.js';

/** Fog byte of a cell the local player sees now (engine render.rs `fog_bytes`). */
export const FOG_VISIBLE = 255;
import { EVA, notificationSound, PLAYER_LINES, BACKGROUND_MUSIC } from './catalog.js';
import { actorInfo } from '../sim/methods.js';
import { perfTrace } from '../perfcapture.js';

/** Game methods that give a unit order: the units reply. Their second argument is the unit ids. */
export const ORDER_METHODS = new Set([
  'order_smart',
  'order_move',
  'order_attack',
  'order_land',
  'order_return_to_base',
  'order_teleport',
  // Command bar (js/commandbar.js).
  'order_attack_ground',
  'order_guard',
  'order_scatter',
  'order_waypoint',
  'order_lay_mines',
  'deploy',
]);

/** What counts as a button for the interface click sound (installClicks). */
export const CLICKABLE = 'button, [role="button"], [role="tab"], [role="switch"], [role="menuitem"], [role="option"], summary, select, input[type="checkbox"], input[type="radio"]';

/**
 * Events that count as a user gesture for starting audio (HTML user
 * activation): a touch only counts when it ends (pointerup, touchend), a
 * mouse button when it goes down (pointerdown, mousedown), keys on keydown.
 */
export const GESTURE_EVENTS = Object.freeze(['pointerdown', 'pointerup', 'mousedown', 'touchend', 'keydown']);

/** Seconds a background track (the menu's intro) fades out while the next track fades in, and the music fades when the player leaves a game. */
export const MUSIC_FADE = 1.5;
/**
 * While the installed sounds load (right after the page opens, or after an
 * install), sounds wait for them instead of playing our own in their place;
 * ones that waited longer than this many seconds are dropped as old news.
 */
export const DEFER_MAX_AGE = 1;
/** Sounds waiting for the installed sounds, at most. */
export const MAX_DEFERRED = 32;
/** Seconds an announcer line waits for the installed sounds to load, and then for audio to start, to play the original line. */
export const ANNOUNCE_WAIT = 3;

const now = () => performance.now() / 1000;

/**
 * Whether the game's own sounds and announcer lines wait now
 * (AudioSystem.setPaused): the player paused the game (the Pause hotkey, the
 * game menu, a hidden tab, the debug menu's pause) or the replay. The end of
 * game dialogs stand a local game still too, but they are no pause of the
 * player's: OpenRA's world goes on at the end, so the lines of the last ticks
 * (an objective, a mission's final speech, a lost unit) and the Win or Lose
 * line play as they come.
 * @param {{ menu?: boolean, debug?: boolean, key?: boolean, endDialog?: boolean, replayPaused?: boolean }} o
 */
export function holdsGameAudio({ menu = false, debug = false, key = false, replayPaused = false } = {}) {
  return !!(menu || debug || key || replayPaused);
}
const wait = (s) => new Promise((r) => setTimeout(r, s * 1000));

export class AudioSystem {
  /** @param {{ registry?: object, doc?: Document | null }} [o] the settings registry (js/registry.js) */
  constructor({ registry = defaultRegistry(), doc = globalThis.document } = {}) {
    this.prefs = new Prefs(registry);
    this.mixer = new Mixer();
    this.mixer.apply(this.prefs.get());
    this.speech = new Speech();
    this.bank = new SoundBank(this.mixer, () => this.prefs.get());
    this.storePromise = null;
    this.storeError = null;
    this.announcer = new Announcer({ play: (key) => this.playAnnouncement(key), now });
    this.jukebox = new Jukebox(
      this.mixer,
      () => this.store(),
      () => this.changed(),
      () => this.bank.pack,
      () => this.prefs.get().original,
      () => ({ shuffle: this.prefs.get().musicShuffle, repeat: this.prefs.get().musicRepeat }),
    );
    this.director = null;
    this.game = null;
    this.inGame = false;
    /** Sound notifications playing now, by name (InterruptType, `notify`). */
    this.notifications = new Map();
    /** The game's background track after it ended (OpenRA MusicPlaylist VictoryMusic or DefeatMusic), or null. */
    this.gameOverTrack = null;
    /** The music player started music: it plays outside a game too (js/audio/musicplayer.js). */
    this.listening = false;
    /** A track the music player picked before music could play (audio still locked): played once it can. */
    this.pendingTrack = null;
    /** The player left the game (leave): the music fades out and stays off until the page reloads into the menu. */
    this.leaving = false;
    /** The page's document: audio starts on its first user gesture (installUnlock), or before where the browser allows it. */
    this.gestureDoc = null;
    this.gesturesWatched = false;
    this.autoplayTried = false;
    this.listeners = new Set();
    /** Announcer line listeners (the on-screen notifications), called even with sound off. */
    this.announceListeners = new Set();
    /**
     * Sounds asked for while the installed sounds load (playDeferred):
     * { at, run, world, play }, `run` on the announcer's clock of running game.
     */
    this.deferred = [];
    /** The game's own sounds wait (setPaused, holdsGameAudio). */
    this.paused = false;
    /** The visible world rectangle of the last frame (frame()), in pixels. */
    this.view = null;
    /** Loads of the installed sounds running now, and the promise of the last one. */
    this.loads = 0;
    this.loaded = Promise.resolve();
    let last = this.prefs.get();
    this.prefs.subscribe((p) => {
      // Volumes apply at once, also to the playing music track (mixer buses).
      this.mixer.apply(p);
      if (!p.speech || !p.enabled) this.speech.cancel();
      if (p.original !== last.original) {
        // Installed original tracks join or leave the playlist.
        this.jukebox.stop();
        this.jukebox.refresh().then(() => this.syncMusic(), () => {});
      } else {
        if (p.musicShuffle !== last.musicShuffle) this.jukebox.reorder();
        if (p.musicRepeat !== last.musicRepeat) this.jukebox.repeatChanged();
      }
      last = p;
      this.syncMusic();
    });
    this.installUnlock(doc);
    this.installClicks(doc);
    this.reloadInstalled();
  }

  /**
   * OpenRA's ClickSound on every button, checkbox, tab and dropdown of the
   * interface (ButtonWidget, ProductionTabsWidget, ...). Controls whose
   * sound depends on what the click did (production cameos, support powers)
   * say so with data-click-sound="own" and play it themselves.
   */
  installClicks(doc) {
    if (!doc) return;
    doc.addEventListener(
      'click',
      (e) => {
        const el = e.target?.closest?.(CLICKABLE);
        if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true' || el.closest('[data-click-sound="own"]')) return;
        this.click();
      },
      true,
    );
  }

  /**
   * Browsers only allow audio after a user gesture, unless their autoplay
   * policy allows it (a site the player often plays sound on, a reload after
   * leaving a game, browser settings). Audio starts on the first gesture
   * anywhere on the page, and before that at once where the browser allows it
   * (syncMusic: the menu music asks for it). The music follows every state
   * change of the context (started, suspended, interrupted).
   */
  installUnlock(doc) {
    this.mixer.onStateChange = () => {
      this.watchGestures();
      this.syncMusic();
      this.changed();
    };
    if (!doc) return;
    this.gestureDoc = doc;
    this.onGesture = () => {
      if (!this.mixer.unlock()) {
        // No Web Audio in this browser: no gesture will change that.
        this.gestureDoc = null;
        this.setGestureListeners(doc, false);
        return;
      }
      this.watchGestures();
      this.syncMusic();
    };
    this.watchGestures();
  }

  /** Listen for gestures while audio cannot play (not started yet, or suspended or interrupted since). */
  watchGestures() {
    const doc = this.gestureDoc;
    if (!doc) return;
    const want = !this.mixer.ready && this.mixer.ctx?.state !== 'closed';
    if (want !== this.gesturesWatched) this.setGestureListeners(doc, want);
  }

  setGestureListeners(doc, on) {
    this.gesturesWatched = on;
    for (const type of GESTURE_EVENTS) {
      if (on) doc.addEventListener(type, this.onGesture, true);
      else doc.removeEventListener?.(type, this.onGesture, true);
    }
  }

  /**
   * Start audio before any gesture where the browser may allow it: when it
   * says autoplay is allowed, or cannot tell (a context created then starts
   * if allowed, and stays suspended until the first gesture otherwise; some
   * browsers log a console warning for that). Tried once, when menu music
   * would play.
   */
  tryAutoplay() {
    if (this.autoplayTried || !this.gestureDoc || this.mixer.ctx) return;
    this.autoplayTried = true;
    if (this.mixer.autoplayPolicy() === 'blocked') return;
    this.mixer.unlock();
    this.watchGestures();
  }

  /** The content store (js/content/store.js); IndexedDB, or memory when the browser blocks it. */
  store() {
    if (!this.storePromise) {
      this.storePromise = openContentStore().then((store) => {
        this.storeError = storeError();
        return store;
      });
    }
    return this.storePromise;
  }

  /**
   * Read the installed sounds from the content store. Until they are loaded
   * (`loaded`), sounds wait for them (`defer`) and announcer lines wait to
   * play the original line, so the first sounds of a game started right
   * after the page opened are the installed ones, not ours.
   */
  reloadInstalled() {
    this.loads++;
    this.bank.loading = true;
    // Not known yet whether the store has sounds (installed or removed since the last load).
    this.bank.expecting = null;
    this.loaded = (async () => {
      try {
        const store = await this.store();
        // Nothing installed: the sounds held meanwhile are ours, they play at once.
        await this.bank.loadInstalled(store, (expecting) => expecting || this.playDeferred());
        await this.jukebox.refresh();
        // A removed track stops instead of playing on until it ends.
        if (this.jukebox.playing && !this.jukebox.tracks.some((t) => t.title === this.jukebox.playing)) this.jukebox.stop();
      } catch (err) {
        this.storeError = err.message ?? String(err);
      } finally {
        if (--this.loads === 0) this.bank.loading = false;
      }
      if (!this.bank.loading) this.playDeferred();
      this.syncMusic();
      this.changed();
    })();
    return this.loaded;
  }

  /**
   * Hold `play` while the installed sounds load and original sounds are on
   * (it would otherwise play our own sound in place of an original); it runs
   * once they are loaded. Only while there may be originals: once the store
   * says it has none, nothing waits. `world`: the simulation's sound, which
   * also waits out a pause (playDeferred). Returns whether it was held.
   */
  defer(play, world = false) {
    const p = this.prefs.get();
    if (!this.bank.loading || !p.enabled || !p.original || this.bank.expecting === false) return false;
    if (this.deferred.length >= MAX_DEFERRED) this.deferred.shift();
    this.deferred.push({ at: now(), run: this.announcer.clock(), world, play });
    return true;
  }

  /**
   * Play the sounds held while the installed sounds loaded, unless they
   * waited too long. The simulation's sounds are held like its announcer
   * lines: while the game is paused they wait (only running game time counts
   * as waiting) and play when it goes on; the player's own (clicks, replies
   * to orders) play at once.
   */
  playDeferred() {
    const held = this.deferred;
    this.deferred = [];
    const t = now();
    const run = this.announcer.clock();
    for (const d of held) {
      if (d.world) {
        if (run - d.run > DEFER_MAX_AGE) continue;
        if (this.paused) {
          this.deferred.push(d);
          continue;
        }
      } else if (t - d.at > DEFER_MAX_AGE) continue;
      d.play();
    }
  }

  /** Whether a sound asked for now is the simulation's: said so, or asked for by the director while it handles engine events. */
  worldSound(world) {
    return world ?? this.director?.worldLines ?? false;
  }

  /**
   * Texture pack sounds (js/content: key -> bytes of an OGG, WAV or MP3
   * file). They are decoded by the browser here, checked against the pack
   * length limit, and played before original and synthesized sounds.
   * @param {Map<string, ArrayBuffer>} sounds
   * @param {number} [maxSeconds]
   */
  async setPackSounds(sounds, maxSeconds = 600) {
    const decoded = new Map();
    const Offline = globalThis.OfflineAudioContext ?? globalThis.webkitOfflineAudioContext;
    if (Offline && sounds.size) {
      const ctx = new Offline(1, 1, 44100);
      for (const [key, bytes] of sounds) {
        try {
          const buffer = await perfTrace.spanAsync('audio.decode-pack', () => ctx.decodeAudioData(bytes.slice(0)), { key });
          if (buffer.duration <= maxSeconds) decoded.set(key, buffer);
        } catch {
          // Not decodable in this browser: the key keeps its other sounds.
        }
      }
    }
    this.bank.pack = decoded;
    await this.jukebox.refresh().catch(() => {});
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

  /**
   * Call `fn(key)` for every announcer line the director decides on (EVA key,
   * catalog.js), whether or not sound is on, so the game can show it as text.
   * @returns unsubscribe
   */
  onAnnounce(fn) {
    this.announceListeners.add(fn);
    return () => this.announceListeners.delete(fn);
  }

  // ---- Game hooks (main.js) ---------------------------------------------------

  /**
   * Start sound for a game: turns on the engine's audio events.
   * @param {object} o
   * @param {object} o.game wasm Game
   * @param {object} o.rules parsed Game.rules_json()
   * @param {number} o.player local player, or NO_PLAYER (spectators and replays: nothing is their own)
   * @param {number} o.worldUnitsPerCell Game.world_units_per_cell()
   * @param {number} [o.tickMs] milliseconds per simulation tick at the game's speed
   */
  attachGame({ game, rules, player, worldUnitsPerCell, allied, tickMs = 40 }) {
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
      // Owner, kind and type: a game handle answers from its actor table
      // (js/sim/proxy.js), at once also when the simulation runs in a worker.
      lookup: (id) => {
        try {
          return actorInfo(game, id);
        } catch {
          return null;
        }
      },
      sink: this,
      now,
      tickMs,
      allied,
    });
    this.inGame = true;
    // The menu's intro paused by the player stays paused: resuming it in the game starts the playlist instead.
    if (this.jukebox.paused?.background) this.jukebox.paused = { index: -1, buffer: null, at: 0, background: null };
    this.syncMusic();
  }

  /**
   * The game goes without the page (a restart in place, the next mission):
   * its sounds, voices and announcer lines stop, nothing it asked for plays
   * later, and its game over music ends. The music of the playlist plays on
   * into the next game, which attaches with attachGame.
   */
  detachGame() {
    this.director = null;
    this.game = null;
    this.deferred = [];
    this.announcer.clear();
    this.speech.cancel();
    for (const handles of this.notifications.values()) for (const h of handles) h.stop();
    this.notifications.clear();
    this.mixer.stopBus('effects');
    this.mixer.stopBus('voices');
    this.gameOverTrack = null;
    this.setPaused(false);
    this.syncMusic();
  }

  /**
   * Wrap a game so local unit orders made through it get their replies.
   * Everything else passes through. (Production clicks speak through
   * `productionClick`: the sidebar knows what the click did.)
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
              audio.director?.onOrder(Array.from(args[1] ?? []), prop);
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
   * @param {() => Uint8Array} [fog] the local player's fog bytes from Game.fog_ptr (0 shroud, 128 fog, 255 visible)
   * @param {Int32Array | number[]} [events] the frame's engine events when the caller took them already
   */
  frame(view, fog, events = null) {
    this.view = view;
    if (!this.director || !this.game) return;
    events ??= this.game.take_audio_events();
    if (!events.length) return;
    // With sound off the director still runs: its announcer lines are shown
    // as text (onAnnounce); effect() and voice() stay silent.
    let visible;
    if (fog) {
      const bytes = fog();
      const cell = this.pxPerCell;
      const w = this.mapWidth;
      visible = (x, y) => {
        const cx = Math.floor(x / cell);
        const cy = Math.floor(y / cell);
        if (cx < 0 || cy < 0 || cx >= w) return false;
        return bytes[cy * w + cx] === FOG_VISIBLE;
      };
    }
    this.director.onEvents(events, view, visible);
  }

  playerState(state) {
    this.director?.onPlayerState(state);
  }

  /** A mission silenced (true) or allowed again (false) the low power line (js/campaign/view.js, mission_state `lowPowerQuiet`). */
  lowPowerQuiet(quiet) {
    this.director?.setLowPowerQuiet(quiet);
  }

  /**
   * The player paused the game or let it go on (holdsGameAudio: the Pause
   * hotkey, the game menu, a hidden tab, a paused replay; not the end of game
   * dialogs): announcer lines and held sounds of the simulation wait meanwhile
   * (js/audio/announcer.js, playDeferred). Music and interface sounds go on,
   * as in OpenRA.
   */
  setPaused(paused) {
    this.paused = !!paused;
    this.announcer.setPaused(this.paused);
    // Going on: the simulation's sounds held through the pause (and loaded meanwhile) play now.
    if (!this.paused && !this.bank.loading && this.deferred.length) this.playDeferred();
  }

  /** @param {number[]} ids @param {{ byPlayer?: boolean }} [info] whether the player made this selection */
  selection(ids, info = {}) {
    this.director?.onSelection(ids, info);
  }

  /**
   * A production cameo was clicked (js/sidebar.js, OpenRA ProductionPaletteWidget):
   * the click sound and the queue's speech for `outcome` (Director.onProductionClick).
   */
  productionClick(actorId, outcome) {
    this.director?.onProductionClick(actorId, outcome);
  }

  /** The next smart order (right click) does `action` (Game.cursor_action): its reply. */
  smartOrder(action) {
    this.director?.noteSmartAction(action);
  }

  /** A ready support power was picked for targeting (`power`: player_json power or its key). */
  selectTarget(power) {
    this.director?.onSelectTarget(power);
  }

  /** A support power without a powered provider was clicked (OpenRA InsufficientPower). */
  insufficientPower(power) {
    this.director?.onInsufficientPower(power);
  }

  /** The game ended for the local player: the Win or Lose line, then OpenRA's MusicPlaylist VictoryMusic or DefeatMusic. */
  gameOver(won) {
    this.director?.onGameOver(won);
    this.setBackgroundMusic(won ? BACKGROUND_MUSIC.victory : BACKGROUND_MUSIC.defeat);
  }

  // ---- Notifications outside the engine (OpenRA's widgets and world traits) ----------

  /** An interface button, tab or cameo was clicked (OpenRA ClickSound; ClickDisabledSound is silent in RA). */
  click() {
    if (this.prefs.get().clickSounds) this.notify('ClickSound');
  }

  /** The radar came online or went offline (OpenRA IngameRadarDisplayLogic: RadarUp, RadarDown). */
  radar(online) {
    this.notify(online ? 'RadarUp' : 'RadarDown', { world: true });
  }

  /** The game started, not from a save (OpenRA StartGameNotification: StartGame). */
  startGame() {
    this.announce(PLAYER_LINES.startGame);
  }

  /** A saved game finished loading (GameLoaded). */
  gameLoaded() {
    this.announce(PLAYER_LINES.gameLoaded);
  }

  /** The game was saved (GameSaved). */
  gameSaved() {
    this.announce(PLAYER_LINES.gameSaved);
  }

  /**
   * The player leaves the game (OpenRA IngameMenuLogic.OnQuit: Leave, "Battle
   * control terminated"). Resolves when the line has been spoken, after at
   * most `maxSeconds`, so the page can unload after it.
   */
  async leave(maxSeconds = 2.5) {
    // The music fades out under the line; the menu's music starts after the reload.
    this.leaving = true;
    this.pendingTrack = null;
    if (this.jukebox.handle) this.jukebox.stop({ fade: MUSIC_FADE });
    else this.syncMusic();
    const key = PLAYER_LINES.leave;
    this.announce(key);
    if (!key || !this.prefs.get().enabled || !this.mixer.ready) return;
    const deadline = now() + maxSeconds;
    while (now() < deadline && (this.announcer.current === key || this.announcer.queue.some((q) => q.key === key))) await wait(0.05);
  }

  /** A chat or system line in a game or a lobby (OpenRA ChatLine). */
  chatLine() {
    this.notify('ChatLine');
  }

  /** Lobby changes (OpenRA LobbyLogic): 'joined' (PlayerJoined), 'left' (PlayerLeft), 'option' (LobbyOptionChanged). */
  lobby(event) {
    const name = { joined: 'PlayerJoined', left: 'PlayerLeft', option: 'LobbyOptionChanged' }[event];
    if (name) this.notify(name);
  }

  // ---- Sink (director.js) --------------------------------------------------------

  /**
   * Thunder after a lightning flash (js/weather-fx.js): `strike` { x, y, kind }
   * in world pixels. Placed like the other sounds of the world (director.js
   * thunderCue: the close, medium or distant cue by distance, gain and pan
   * against the view of the last frame). A texture pack's `thunder` stands in
   * for all three unless it replaces them one by one.
   */
  thunder(strike = {}) {
    const cue = thunderCue(strike.x, strike.y, this.view, strike.kind ?? 0);
    const synth = this.bank.packBuffer(cue.synth) || !this.bank.packBuffer('thunder') ? cue.synth : 'thunder';
    this.effect({ synth, originals: [] }, { gain: cue.gain * 0.9, pan: cue.pan, world: true });
  }

  /** A sound effect; `world`: the simulation's (default: whether the director is handling engine events). */
  effect(sound, { gain = 1, pan = 0, world } = {}) {
    if (!this.prefs.get().enabled || this.defer(() => this.effect(sound, { gain, pan }), this.worldSound(world))) return;
    // A layered sound (catalog.js placeSound) plays all of its parts at once.
    for (const r of this.bank.resolveAll(sound)) this.mixer.play(r.buffer, { bus: 'effects', gain, pan, rate: r.rate });
  }

  /**
   * The sidebar credits counter ticked (js/cashcounter.js): 'up' or 'down'.
   * OpenRA plays these as UI notifications (not in the world) when Cash ticks is on.
   */
  cashTick(direction) {
    const name = { up: 'CashTickUp', down: 'CashTickDown' }[direction];
    if (name && this.prefs.get().cashTicks) this.notify(name);
  }

  /**
   * Play a sound notification (notifications.yaml Sounds) as OpenRA's
   * PlayNotification does: InterruptType DoNotPlay skips it while the same
   * one plays, Interrupt stops that one first, Overlap just plays;
   * VolumeModifier scales it. Returns whether it started (one asked for
   * while the installed sounds load starts once they are loaded).
   * `world`: the simulation's notification (default: whether the director
   * is handling engine events), held through a pause while sounds load.
   * @param {string} name
   * @param {{ gain?: number, world?: boolean }} [opts]
   */
  notify(name, { gain = 1, world } = {}) {
    const sound = notificationSound(name);
    if (!sound || !this.prefs.get().enabled || this.defer(() => this.notify(name, { gain }), this.worldSound(world))) return false;
    const playing = this.notifications.get(name);
    if (playing?.length && sound.interrupt === 'DoNotPlay') return false;
    if (playing?.length && sound.interrupt === 'Interrupt') for (const h of playing) h.stop();
    const handles = [];
    for (const r of this.bank.resolveAll(sound)) {
      const h = this.mixer.play(r.buffer, { bus: 'effects', gain: gain * sound.volume, pan: 0, rate: r.rate });
      if (h) handles.push(h);
    }
    if (!handles.length) return false;
    if (sound.interrupt !== 'Overlap') {
      this.notifications.set(name, handles);
      Promise.all(handles.map((h) => h.ended)).then(() => {
        if (this.notifications.get(name) === handles) this.notifications.delete(name);
      });
    }
    return true;
  }

  /**
   * A unit reply: original voice, or radio blip with an optional spoken
   * line. With original sounds in use, a reply OpenRA has (bank.keepsOriginal)
   * is never spoken by the browser in its place.
   */
  voice(line) {
    const p = this.prefs.get();
    if (!p.enabled || this.defer(() => this.voice(line), this.worldSound())) return;
    const original = this.bank.resolve({ ...line, synth: null });
    if (original) {
      this.mixer.play(original.buffer, { bus: 'voices' });
      return;
    }
    if (this.bank.keepsOriginal(line)) return;
    const speak = p.speech && this.speech.available && !this.announcer.busy && !this.speech.speaking;
    if (!speak) {
      this.playSynth(line.synth, 'voices');
      return;
    }
    const text = line.spoken[Math.floor(Math.random() * line.spoken.length)];
    this.playSynth('radio_open', 'voices');
    this.speech.speak(text, { role: 'unit', volume: busGain(p, 'voices') }).then(() => this.playSynth('radio_close', 'voices'));
  }

  /**
   * An announcer line, shown as text and spoken. `world`: the simulation's
   * line (an engine event, the player state, a mission script), which waits
   * while the game is paused.
   * @param {string} key
   * @param {{ world?: boolean }} [o]
   */
  announce(key, { world = false } = {}) {
    for (const fn of this.announceListeners) {
      try {
        fn(key);
      } catch (err) {
        console.warn('announce listener failed:', err);
      }
    }
    if (this.prefs.get().enabled && EVA[key] && !EVA[key].textOnly) this.announcer.push(key, { world });
  }

  playSynth(id, bus, gain = 1) {
    const r = this.bank.resolve({ synth: id, originals: [] });
    return r ? this.mixer.play(r.buffer, { bus, gain, rate: 1 }) : null;
  }

  /**
   * Play one announcer line to the end (the announcer queue awaits this).
   * The original line, when installed: the line waits (at most
   * ANNOUNCE_WAIT seconds) for the installed sounds to finish loading and
   * for audio to start ("Battle control online" comes at once when a game
   * starts). With original sounds in use, a line OpenRA has is never replaced
   * by our chime and the browser's voice: without its file (OpenRA's own
   * "Battle control online", or a line OpenRA leaves empty) only its text shows.
   */
  async playAnnouncement(key, maxWait = ANNOUNCE_WAIT) {
    const line = EVA[key];
    const deadline = now() + maxWait;
    if (this.bank.loading) {
      let timer;
      await Promise.race([this.loaded, new Promise((r) => (timer = setTimeout(r, maxWait * 1000)))]);
      clearTimeout(timer);
    }
    while (this.bank.installed(line).length && !this.mixer.ready && now() < deadline) await wait(0.05);
    const p = this.prefs.get();
    const original = this.bank.resolve({ ...line, synth: null });
    if (original) {
      const h = this.mixer.play(original.buffer, { bus: 'voices' });
      if (h) await h.ended;
      return;
    }
    if (this.bank.keepsOriginal(line)) return;
    const chime = this.playSynth(line.chime, 'voices', 0.8);
    if (p.speech && this.speech.available) {
      await wait(0.2);
      await this.speech.speak(line.text, { role: 'eva', volume: busGain(p, 'voices') });
    } else if (chime) {
      await chime.ended;
    }
  }

  // ---- Music ------------------------------------------------------------------------

  /** Whether music should play now: in a game (or started from the music player), sound and music on, a track to play, audio unlocked. */
  musicWanted() {
    const p = this.prefs.get();
    // The playlist holds pack music, plus the installed originals when they are on (music.js).
    return (this.inGame || this.listening) && !this.leaving && p.enabled && p.musicOn && p.music > 0 && this.jukebox.available && this.mixer.ready;
  }

  /**
   * The background track the settings and the screen ask for, whether or
   * not audio can play yet, or null (OpenRA MusicPlaylist): the score or map
   * track once the game is over, the intro behind the main menu and its
   * screens (skirmish lobby, online games, campaign, settings: the
   * shellmap's BackgroundMusic, unless "Main menu music" is off), while the
   * player has not picked, stopped or paused a track.
   */
  wantedBackground() {
    const p = this.prefs.get();
    if (this.leaving || !p.enabled || !p.musicOn || p.music <= 0 || this.jukebox.stoppedByUser || this.jukebox.paused) return null;
    const track = this.inGame ? this.gameOverTrack : !this.listening && p.menuMusic ? BACKGROUND_MUSIC.menu : null;
    return track && this.jukebox.has(track) ? track : null;
  }

  /** The background track that should play now (audio running), or null. */
  backgroundTrack() {
    return this.mixer.ready ? this.wantedBackground() : null;
  }

  syncMusic() {
    // The menu music is the first thing that wants audio before a gesture.
    if (!this.mixer.ctx && this.wantedBackground()) this.tryAutoplay();
    if (this.pendingTrack !== null && this.musicWanted()) {
      const index = this.pendingTrack;
      this.pendingTrack = null;
      this.gameOverTrack = null;
      this.jukebox.playIndex(index);
      return;
    }
    const bg = this.backgroundTrack();
    if (bg) {
      if (this.jukebox.background !== bg) this.jukebox.playBackground(bg);
      return;
    }
    // The background ended its turn (a game started, the menu music was switched off): it fades into what follows.
    if (this.jukebox.background) this.jukebox.stop({ fade: MUSIC_FADE });
    // The music hotkeys may have stopped or paused it: it stays so until the player starts it again.
    const want = this.musicWanted() && !this.jukebox.stoppedByUser && !this.jukebox.paused;
    // A playlist that ended (repeat off) stays quiet until the player asks for the next track.
    if (want && !this.jukebox.handle && !this.jukebox.finished) {
      this.jukebox.start();
      return;
    }
    if (!want && this.jukebox.handle) this.jukebox.stop();
    // Nothing follows the faded background now: a track started later begins at once.
    this.jukebox.fadeIn = 0;
  }

  /** Background music for the rest of the game (OpenRA MusicPlaylist.GameOver), when it is installed. */
  setBackgroundMusic(track) {
    if (!track || !this.jukebox.has(track)) return;
    this.gameOverTrack = track;
    this.syncMusic();
  }

  /** "Next track" (Settings, Sound): skips the playing track, or starts a finished playlist again. */
  nextTrack() {
    if (!this.musicWanted()) return;
    this.gameOverTrack = null;
    this.jukebox.next();
  }

  // ---- Music player (js/audio/musicplayer.js) ------------------------------------------

  /**
   * The music player's controls are a request for music, also outside a
   * game: they unlock audio and switch music on. Returns whether it can play now.
   */
  wantMusic() {
    this.mixer.unlock?.();
    this.listening = true;
    if (!this.prefs.get().musicOn) this.prefs.set({ musicOn: true });
    return this.musicWanted();
  }

  /** Play track `index` of the playlist (jukebox.tracks) now, or as soon as music can play. */
  playTrack(index) {
    if (!this.jukebox.tracks[index]) return;
    this.pendingTrack = index;
    this.wantMusic();
    this.syncMusic();
    this.changed();
  }

  /** Play or pause: pause what plays, resume what was paused, or play the selected (or first) track. */
  playPause() {
    const j = this.jukebox;
    if (j.handle) {
      j.togglePause();
    } else if (j.paused && this.wantMusic()) {
      j.togglePause();
    } else {
      const index = j.paused?.index ?? (j.current >= 0 ? j.current : (j.order[0] ?? 0));
      this.playTrack(index);
      return;
    }
    this.changed();
  }

  /** Stop: music stays off (also in games) until the player starts it again. */
  stopMusic() {
    this.pendingTrack = null;
    this.listening = false;
    this.jukebox.userStop();
    this.changed();
  }

  /** The previous (-1) or next (+1) track. */
  skipTrack(direction) {
    const j = this.jukebox;
    this.gameOverTrack = null;
    if (!j.available) return;
    if (this.wantMusic()) {
      if (direction < 0) j.prev();
      else j.next();
      this.changed();
      return;
    }
    // Music cannot play yet (audio still locked, sound or music volume off): that track plays once it can.
    const n = j.order.length;
    const at = j.order.indexOf(j.current);
    this.playTrack(j.order[at < 0 ? 0 : (at + direction + n) % n] ?? 0);
  }

  // ---- Hotkeys (js/gamekeys.js) ----------------------------------------------------

  /** OpenRA ToggleMute: all sound off or on again. Returns whether it is muted now. */
  toggleMute() {
    const muted = this.prefs.get().enabled;
    this.prefs.set({ enabled: !muted });
    return muted;
  }

  /** OpenRA's music hotkeys: 'stop', 'pause' (or resume), 'prev', 'next' (only while music may play). */
  music(command) {
    this.mixer.unlock?.();
    const j = this.jukebox;
    if (command === 'stop') j.userStop();
    else if (!this.musicWanted()) return;
    else if (command === 'pause') j.togglePause();
    else if (command === 'prev' || command === 'next') {
      // Picking a track ends the background track (OpenRA MusicPlaylist.Play).
      this.gameOverTrack = null;
      if (command === 'prev') j.prev();
      else j.next();
    }
    this.changed();
  }

  /** Short test sound for the settings panel. */
  test(kind) {
    this.mixer.unlock();
    // Straight to the announcer: a test line is not a game notification.
    if (kind === 'voices') {
      if (this.prefs.get().enabled) this.announcer.push('unitReady');
    }
    else this.effect({ synth: 'cannon', originals: ['cannon1.aud'] }, { gain: 1, pan: 0 });
  }
}

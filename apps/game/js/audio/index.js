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
import { openContentStore, storeError } from './store.js';
import { defaultRegistry } from '../registry.js';

/** Fog byte of a cell the local player sees now (engine render.rs `fog_bytes`). */
export const FOG_VISIBLE = 255;
import { EVA, notificationSound, PLAYER_LINES, BACKGROUND_MUSIC } from './catalog.js';
import { actorInfo } from '../sim/methods.js';

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

const now = () => performance.now() / 1000;
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
    this.listeners = new Set();
    /** Announcer line listeners (the on-screen notifications), called even with sound off. */
    this.announceListeners = new Set();
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

  async reloadInstalled() {
    try {
      const store = await this.store();
      await this.bank.loadInstalled(store);
      await this.jukebox.refresh();
      // A removed track stops instead of playing on until it ends.
      if (this.jukebox.playing && !this.jukebox.tracks.some((t) => t.title === this.jukebox.playing)) this.jukebox.stop();
    } catch (err) {
      this.storeError = err.message ?? String(err);
    }
    this.syncMusic();
    this.changed();
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
          const buffer = await ctx.decodeAudioData(bytes.slice(0));
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
   */
  attachGame({ game, rules, player, worldUnitsPerCell, allied }) {
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
      allied,
    });
    this.inGame = true;
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
              audio.director?.onOrder(Array.from(args[1] ?? []));
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
    this.notify(online ? 'RadarUp' : 'RadarDown');
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

  /** Thunder after a lightning flash (js/weather-fx.js), quieter far away. */
  thunder(gain = 1) {
    this.effect({ synth: 'thunder', originals: [] }, { gain: Math.max(0, Math.min(1, gain)) * 0.9 });
  }

  effect(sound, { gain = 1, pan = 0 } = {}) {
    if (!this.prefs.get().enabled) return;
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
   * VolumeModifier scales it. Returns whether it started.
   * @param {string} name
   * @param {{ gain?: number }} [opts]
   */
  notify(name, { gain = 1 } = {}) {
    const sound = notificationSound(name);
    if (!sound || !this.prefs.get().enabled) return false;
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
    for (const fn of this.announceListeners) {
      try {
        fn(key);
      } catch (err) {
        console.warn('announce listener failed:', err);
      }
    }
    if (this.prefs.get().enabled && EVA[key] && !EVA[key].textOnly) this.announcer.push(key);
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

  /** Whether music should play now: in a game (or started from the music player), sound and music on, a track to play, audio unlocked. */
  musicWanted() {
    const p = this.prefs.get();
    // The playlist holds pack music, plus the installed originals when they are on (music.js).
    return (this.inGame || this.listening) && p.enabled && p.musicOn && p.music > 0 && this.jukebox.available && this.mixer.ready;
  }

  /**
   * The background track that should play now, or null (OpenRA
   * MusicPlaylist): the score or map track once the game is over, the intro
   * behind the main menu (the shellmap's BackgroundMusic, unless "Main menu
   * music" is off), while the player has not picked a track.
   */
  backgroundTrack() {
    const p = this.prefs.get();
    if (!p.enabled || !p.musicOn || p.music <= 0 || !this.mixer.ready || this.jukebox.stoppedByUser || this.jukebox.paused) return null;
    const track = this.inGame ? this.gameOverTrack : !this.listening && p.menuMusic ? BACKGROUND_MUSIC.menu : null;
    return track && this.jukebox.has(track) ? track : null;
  }

  syncMusic() {
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
    // The background ended its turn (a game started, the menu music was switched off).
    if (this.jukebox.background) this.jukebox.stop();
    // The music hotkeys may have stopped or paused it: it stays so until the player starts it again.
    const want = this.musicWanted() && !this.jukebox.stoppedByUser && !this.jukebox.paused;
    // A playlist that ended (repeat off) stays quiet until the player asks for the next track.
    if (want && !this.jukebox.handle && !this.jukebox.finished) this.jukebox.start();
    else if (!want && this.jukebox.handle) this.jukebox.stop();
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

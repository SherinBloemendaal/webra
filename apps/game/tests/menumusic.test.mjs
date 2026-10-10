// Menu music (js/audio): the intro behind the main menu and its screens
// starts as soon as the browser lets audio start (at once where autoplay is
// allowed, otherwise on the first gesture anywhere on the page), follows the
// settings also when they arrive late from the account, fades into the game's
// playlist and out when the player leaves, and respects the music player's
// stop and pause. A fake AudioContext that follows the browsers' autoplay
// rules, the real mixer and jukebox; synthetic tracks, no browser.
//   node --test apps/game/tests/menumusic.test.mjs
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, uninstallDom, FakeEvent, memoryStorage } from './dom-fixtures.mjs';
import { createRegistry } from '../js/registry.js';
import { AudioSystem, GESTURE_EVENTS, MUSIC_FADE } from '../js/audio/index.js';
import { BACKGROUND_MUSIC, PLAYLIST } from '../js/audio/catalog.js';
import { MemoryStore } from '../js/content/store.js';

const settle = async (n = 10) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

/** An AudioParam that records its automation. */
class FakeParam {
  constructor(value = 1) {
    this.value = value;
    this.events = [];
  }
  setTargetAtTime(v, t) {
    this.events.push(['target', v, t]);
    this.value = v;
  }
  setValueAtTime(v, t) {
    this.events.push(['set', v, t]);
    this.value = v;
  }
  linearRampToValueAtTime(v, t) {
    this.events.push(['ramp', v, t]);
  }
  cancelScheduledValues(t) {
    this.events.push(['cancel', t]);
  }
}

class FakeNodeBase {
  connect(node) {
    return node;
  }
  disconnect() {}
}

class FakeGain extends FakeNodeBase {
  constructor() {
    super();
    this.gain = new FakeParam(1);
  }
}

class FakeSource extends FakeNodeBase {
  constructor(ctx) {
    super();
    this.ctx = ctx;
    this.buffer = null;
    this.playbackRate = new FakeParam(1);
    this.onended = null;
    this.stopAt = null;
    this.gainNode = null;
  }
  connect(node) {
    // The gain each source plays through (Mixer.play: source -> gain -> bus).
    this.gainNode ??= node;
    return node;
  }
  start(when, offset) {
    this.startedAt = [when, offset];
    this.ctx.sources.push(this);
  }
  stop(when = 0) {
    this.stopAt = when;
  }
  /** The browser reports the end (a stop came due, or the buffer played out). */
  end() {
    this.onended?.();
  }
}

/**
 * Web Audio as browsers do it: a context made without user activation (and
 * no autoplay allowance) stays suspended, resume() waits for a gesture; a
 * context made or resumed with one starts. statechange fires asynchronously.
 */
class FakeAudioContext {
  /** The browser's autoplay allowance for this page (Media Engagement, a reload after a gesture, settings). */
  static allowed = false;
  /** True while a user activation event is being dispatched. */
  static activation = false;
  static made = [];
  constructor() {
    this.state = 'suspended';
    this.currentTime = 10;
    this.destination = new FakeNodeBase();
    this.sources = [];
    this.listeners = [];
    FakeAudioContext.made.push(this);
    if (FakeAudioContext.allowed || FakeAudioContext.activation) this.start();
  }
  start() {
    queueMicrotask(() => this.setState('running'));
  }
  setState(state) {
    if (this.state === state) return;
    this.state = state;
    for (const fn of [...this.listeners]) fn();
  }
  addEventListener(type, fn) {
    if (type === 'statechange') this.listeners.push(fn);
  }
  resume() {
    if (FakeAudioContext.allowed || FakeAudioContext.activation) {
      this.start();
      return Promise.resolve();
    }
    return new Promise(() => {}); // pending until a gesture, as in Chrome
  }
  createGain() {
    return new FakeGain();
  }
  createDynamicsCompressor() {
    const n = new FakeNodeBase();
    for (const k of ['threshold', 'knee', 'ratio', 'attack', 'release']) n[k] = new FakeParam(0);
    return n;
  }
  createBufferSource() {
    return new FakeSource(this);
  }
  createBuffer(channels, length, sampleRate) {
    return { duration: length / sampleRate, copyToChannel() {} };
  }
  /** Sources still playing (no stop called on them). */
  playing() {
    return this.sources.filter((s) => s.stopAt === null);
  }
}

/** HTML user activation: a mouse button down, a touch when it ends, a key (not Escape). */
function activates(type, init) {
  if (type === 'keydown') return init.key !== 'Escape';
  if (type === 'pointerdown' || type === 'mousedown') return (init.pointerType ?? 'mouse') === 'mouse';
  return type === 'pointerup' ? init.pointerType !== 'mouse' : type === 'touchend';
}

/** Dispatch a user input event on `target`, with user activation where browsers give it. */
function gesture(target, type, init = {}) {
  FakeAudioContext.activation = activates(type, init);
  try {
    target.dispatchEvent(new FakeEvent(type, init));
  } finally {
    FakeAudioContext.activation = false;
  }
}

let doc;
let savedNavigator;
beforeEach(() => {
  doc = installDom();
  globalThis.AudioContext = FakeAudioContext;
  FakeAudioContext.allowed = false;
  FakeAudioContext.made = [];
  savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
});
afterEach(() => {
  uninstallDom();
  delete globalThis.AudioContext;
  if (savedNavigator) Object.defineProperty(globalThis, 'navigator', savedNavigator);
  else delete globalThis.navigator;
});

/** What navigator.getAutoplayPolicy('audiocontext') says (undefined: the browser has no such API). */
function autoplayPolicy(answer) {
  const nav = answer === undefined ? {} : { getAutoplayPolicy: (kind) => (kind === 'audiocontext' ? answer : 'disallowed') };
  Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true });
}

/** The menu intro and `tracks` playlist tracks as texture pack music (a pack track is its own AudioBuffer). */
function packMusic(tracks = 2, { menu = true } = {}) {
  const list = [...(menu ? [BACKGROUND_MUSIC.menu] : []), BACKGROUND_MUSIC.victory, ...PLAYLIST.slice(0, tracks)];
  return new Map(list.map((m) => [m.file, { file: m.file, duration: 120 }]));
}

/**
 * The page's audio system as main.js makes it, with the content store and
 * the texture pack music in place once the page's store has loaded (as
 * reloadInstalled does at startup).
 */
async function startPage({ music = packMusic(), registry = createRegistry({ storage: memoryStorage() }) } = {}) {
  const store = new MemoryStore();
  const audio = new AudioSystem({ registry, doc });
  audio.store = async () => store;
  audio.jukebox.getStore = async () => store;
  audio.bank.pack = music;
  await audio.reloadInstalled();
  await settle();
  return { audio, registry };
}

/** The file of every source playing now. */
const nowPlaying = (audio) => (audio.mixer.ctx ? audio.mixer.ctx.playing().map((s) => s.buffer.file) : []);

/** The page's gesture listeners on the document. */
const gestureListeners = () => GESTURE_EVENTS.reduce((n, type) => n + (doc.listeners.get(type)?.length ?? 0), 0);

/** A game handle and rules, enough for attachGame. */
const fakeGame = () => ({ game: { set_audio_events() {}, map_width: () => 16 }, rules: { actors: [], players: [{ side: 0 }], pxPerCell: 24 }, player: 0, worldUnitsPerCell: 1024 });

test('autoplay allowed: the menu music starts at once, without a gesture', async () => {
  autoplayPolicy('allowed');
  FakeAudioContext.allowed = true;
  const { audio } = await startPage();
  assert.equal(FakeAudioContext.made.length, 1, 'the context was made without a gesture');
  assert.equal(audio.mixer.ctx.state, 'running');
  assert.deepEqual(nowPlaying(audio), ['intro.aud'], 'the shellmap intro plays');
  assert.equal(audio.jukebox.background, BACKGROUND_MUSIC.menu);
  assert.equal(gestureListeners(), 0, 'nothing waits for a gesture any more');
});

test('a browser that cannot tell its policy: a context made at once starts where the browser allows it', async () => {
  // Chrome and Safari have no getAutoplayPolicy; after leaving a game the page reloads with the allowance.
  autoplayPolicy(undefined);
  FakeAudioContext.allowed = true;
  const { audio } = await startPage();
  assert.deepEqual(nowPlaying(audio), ['intro.aud']);
});

test('autoplay blocked: no context before a gesture, the music starts on the first one anywhere on the page', async () => {
  autoplayPolicy('disallowed');
  const { audio } = await startPage();
  assert.equal(FakeAudioContext.made.length, 0, 'nothing is made while the browser says no');
  assert.equal(audio.mixer.ready, false);
  // A touch only activates the page when it ends: the touch down is not enough.
  const lobby = doc.createElement('div');
  doc.body.append(lobby);
  gesture(lobby, 'pointerdown', { pointerType: 'touch' });
  await settle();
  assert.equal(audio.mixer.ready, false, 'a touch down does not start audio');
  assert.deepEqual(nowPlaying(audio), []);
  gesture(lobby, 'pointerup', { pointerType: 'touch' });
  await settle();
  assert.equal(audio.mixer.ready, true);
  assert.deepEqual(nowPlaying(audio), ['intro.aud'], 'the first touch on the menu starts the intro, no Sound dialog needed');
  assert.equal(gestureListeners(), 0, 'the listeners are gone once audio runs');
});

test('autoplay unknown and blocked: the suspended context starts on the first key press', async () => {
  autoplayPolicy(undefined);
  const { audio } = await startPage();
  assert.equal(FakeAudioContext.made.length, 1, 'tried at once');
  assert.equal(audio.mixer.ctx.state, 'suspended', 'the browser kept it suspended');
  assert.deepEqual(nowPlaying(audio), []);
  gesture(doc.body, 'keydown', { key: 'Escape' });
  await settle();
  assert.equal(audio.mixer.ready, false, 'Escape gives no user activation');
  gesture(doc.body, 'keydown', { key: 'Enter' });
  await settle();
  assert.deepEqual(nowPlaying(audio), ['intro.aud']);
  // Safari interrupts audio (a call, another app): the next gesture resumes it and the music goes on.
  audio.mixer.ctx.setState('interrupted');
  assert.ok(gestureListeners() > 0, 'waiting for a gesture again');
  gesture(doc.body, 'mousedown');
  await settle();
  assert.equal(audio.mixer.ready, true);
  assert.deepEqual(nowPlaying(audio), ['intro.aud']);
});

test('settings that arrive late from the account start or stop the menu music', async () => {
  autoplayPolicy('allowed');
  FakeAudioContext.allowed = true;
  const registry = createRegistry({ storage: memoryStorage() });
  registry.patch('audio', { menuMusic: false });
  const { audio } = await startPage({ registry });
  assert.equal(FakeAudioContext.made.length, 0, 'no context while no music is wanted');
  assert.deepEqual(nowPlaying(audio), []);
  // The account's settings sync (js/account/sync.js) brings "Main menu music" on.
  registry.applyDocument({ audio: { menuMusic: true } }, { origin: 'remote' });
  await settle();
  assert.deepEqual(nowPlaying(audio), ['intro.aud'], 'tried autoplay once the account wanted music');
  // And a later sync switching music off stops it.
  registry.applyDocument({ audio: { musicOn: false } }, { origin: 'remote' });
  await settle();
  assert.deepEqual(nowPlaying(audio), []);
  assert.equal(audio.jukebox.background, null);
  registry.applyDocument({ audio: { musicOn: true, music: 0.5 } }, { origin: 'remote' });
  await settle();
  assert.deepEqual(nowPlaying(audio), ['intro.aud']);
  assert.equal(audio.mixer.buses.music.gain.value, 0.5 * audio.prefs.get().master, 'the account volume applies');
});

test('menu, game, menu: the intro fades into the playlist, the music fades out on leaving and the intro returns after the reload', async () => {
  autoplayPolicy('disallowed');
  const { audio } = await startPage();
  gesture(doc.body, 'pointerdown', { pointerType: 'mouse' });
  await settle();
  const ctx = audio.mixer.ctx;
  const [intro] = ctx.playing();
  assert.equal(intro.buffer.file, 'intro.aud');
  // Skirmish lobby, online games, campaign, settings: no game yet, the intro plays on.
  audio.syncMusic();
  await settle();
  assert.equal(ctx.sources.length, 1, 'menu screens do not restart it');

  audio.attachGame(fakeGame());
  await settle();
  assert.equal(intro.stopAt, ctx.currentTime + MUSIC_FADE, 'the intro stops after its fade');
  assert.deepEqual(intro.gainNode.gain.events.at(-1), ['ramp', 0, ctx.currentTime + MUSIC_FADE], 'and fades to silence');
  const [track] = ctx.playing();
  assert.ok(PLAYLIST.some((m) => m.file === track.buffer.file), 'a playlist track plays in the game');
  assert.deepEqual(track.gainNode.gain.events.slice(0, 2).map((e) => e.slice(0, 2)), [['set', 0], ['ramp', PLAYLIST.find((m) => m.file === track.buffer.file).volume]], 'it fades in');
  intro.end();
  await settle();
  assert.deepEqual(ctx.playing(), [track], 'the faded intro does not come back in the game');

  await audio.leave(0);
  assert.equal(track.stopAt, ctx.currentTime + MUSIC_FADE, 'the music fades out while the game closes');
  audio.syncMusic();
  await settle();
  assert.deepEqual(ctx.playing(), [], 'and nothing starts before the page reloads');

  // The page reloads into the menu; the browser lets audio start after the player's gestures on this site.
  uninstallDom();
  doc = installDom();
  FakeAudioContext.allowed = true;
  autoplayPolicy(undefined);
  const again = await startPage();
  assert.deepEqual(nowPlaying(again.audio), ['intro.aud'], 'the menu music is back without another click');
});

test('the music player stop and pause hold in the menu and into a game', async () => {
  autoplayPolicy('allowed');
  FakeAudioContext.allowed = true;
  const { audio } = await startPage();
  assert.deepEqual(nowPlaying(audio), ['intro.aud']);
  audio.stopMusic();
  await settle();
  assert.deepEqual(nowPlaying(audio), []);
  audio.prefs.set({ music: 0.6 });
  audio.syncMusic();
  await settle();
  assert.deepEqual(nowPlaying(audio), [], 'stopped stays stopped');
  audio.playPause();
  await settle();
  assert.equal(nowPlaying(audio).length, 1, 'Play starts music again');

  // Paused in the menu: the game starts quiet, and Resume starts the game's playlist.
  const { audio: paused } = await startPage();
  paused.playPause();
  await settle();
  assert.ok(paused.jukebox.paused, 'the intro is paused');
  paused.attachGame(fakeGame());
  await settle();
  assert.deepEqual(nowPlaying(paused).filter((f) => f !== 'intro.aud'), [], 'no music in the game while paused');
  paused.playPause();
  await settle();
  const resumed = nowPlaying(paused).filter((f) => f !== 'intro.aud');
  assert.equal(resumed.length, 1);
  assert.ok(PLAYLIST.some((m) => m.file === resumed[0]), 'the playlist, not the menu intro');
});

test('without music nothing happens: no context before a gesture, nothing plays, no errors', async () => {
  autoplayPolicy('allowed');
  FakeAudioContext.allowed = true;
  const { audio } = await startPage({ music: new Map() });
  assert.equal(FakeAudioContext.made.length, 0);
  gesture(doc.body, 'pointerdown', { pointerType: 'mouse' });
  await settle();
  assert.equal(audio.mixer.ready, true, 'audio still starts for the interface sounds');
  assert.deepEqual(nowPlaying(audio), []);
  audio.attachGame(fakeGame());
  await settle();
  assert.deepEqual(nowPlaying(audio), []);
});

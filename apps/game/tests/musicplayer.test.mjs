// The music player (js/audio/musicplayer.js): the track list with lengths,
// the playing track with its time, the transport buttons, shuffle, repeat
// and volume on the settings registry, the message without music, the Music
// dialog, the game menu's Music page and the content dialog's music line.
// Fake DOM, no browser, no WebAssembly.
//   node --test apps/game/tests/musicplayer.test.mjs
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, uninstallDom, click, check, textOf, FakeEvent, memoryStorage } from './dom-fixtures.mjs';
import { imaAud, sineSamples } from './audio-fixtures.mjs';
import { createRegistry } from '../js/registry.js';
import { createSettings } from '../js/settings.js';
import { HotkeyRegistry } from '../js/hotkeys.js';
import { GameMenu } from '../js/gamemenu.js';
import { AudioSystem } from '../js/audio/index.js';
import { mountAudioPanel } from '../js/audio/panel.js';
import { mountMusicPlayer, mountMusicPanel, formatTime, playerStatus } from '../js/audio/musicplayer.js';
import { audDuration } from '../js/audio/aud.js';
import { MUSIC, MUSIC_SOURCE_HINT } from '../js/audio/catalog.js';
import { MemoryStore } from '../js/content/store.js';

let doc;
beforeEach(() => {
  doc = installDom();
});
afterEach(() => uninstallDom());

const settle = async (n = 10) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

/**
 * An audio system with a running fake mixer and `tracks` texture pack tracks
 * (pack music plays without installed originals). Not in a game.
 */
async function audioWith({ tracks = 3, store = new MemoryStore(), registry = createRegistry({ storage: memoryStorage() }) } = {}) {
  const audio = new AudioSystem({ registry, doc: null });
  audio.store = async () => store;
  audio.jukebox.getStore = async () => store;
  const node = () => ({ gain: { value: 1, setTargetAtTime(v) {
    this.value = v;
  } } });
  audio.mixer.ctx = { state: 'running', currentTime: 0 };
  audio.mixer.buses = { master: node(), effects: node(), voices: node(), music: node() };
  const played = [];
  let clock = 0;
  audio.mixer.play = (buffer, opts) => {
    const handle = { file: buffer.file, offset: opts.offset ?? 0, stopped: false, ended: Promise.resolve(), stop() {
      this.stopped = true;
    }, position: () => handle.offset + clock };
    played.push(handle);
    return handle;
  };
  audio.bank.pack = new Map(MUSIC.slice(0, tracks).map((t, i) => [t.file, { file: t.file, duration: 60 * (i + 1) + 5 }]));
  await settle();
  await audio.jukebox.refresh();
  audio.changed();
  return { audio, played, tick: (s) => (clock += s), registry };
}

test('times show as m:ss, and a track length comes from its AUD header', () => {
  assert.equal(formatTime(0), '0:00');
  assert.equal(formatTime(65.9), '1:05');
  assert.equal(formatTime(3600), '60:00');
  assert.equal(formatTime(null), '--:--');
  assert.equal(formatTime(NaN), '--:--');
  assert.equal(audDuration(imaAud(sineSamples(22050 * 2))), 2, 'two seconds of IMA ADPCM at 22050 Hz');
});

test('the track list follows OpenRA music.yaml: titles in its order, without the hidden tracks', () => {
  assert.equal(MUSIC[0].title, 'Afterlife (Await)');
  assert.equal(MUSIC[0].file, 'await_r.aud');
  assert.ok(MUSIC.some((m) => m.file === 'hell226m.aud' && m.title === 'Hell March'));
  assert.ok(MUSIC.some((m) => m.file === 'credits.aud' && m.title === 'Reload Fire (Credits)'));
  for (const hidden of ['intro.aud', 'map.aud', 'score.aud']) assert.equal(MUSIC.some((m) => m.file === hidden), false, hidden);
  assert.equal(new Set(MUSIC.map((m) => m.file)).size, MUSIC.length);
});

test('without music: what is missing, why the quick install has none, and how to add scores.mix', async () => {
  const { audio } = await audioWith({ tracks: 0 });
  const root = doc.createElement('div');
  doc.body.append(root);
  let opened = 0;
  const player = mountMusicPlayer(root, audio, { onContent: () => opened++ });
  await settle();
  assert.equal(root.querySelector('.music-main').hidden, true, 'no player controls without tracks');
  const text = textOf(root);
  assert.match(text, /No music installed\./);
  assert.ok(text.includes(MUSIC_SOURCE_HINT));
  assert.match(MUSIC_SOURCE_HINT, /quick install package \(ra-quickinstall\.zip\) has no music/);
  assert.match(MUSIC_SOURCE_HINT, /Steam or Origin release, or C&C Remastered/);
  assert.match(MUSIC_SOURCE_HINT, /scores\.mix \(or main\.mix or redalert\.mix, which contain it\)/);
  assert.match(MUSIC_SOURCE_HINT, /dropping it on this page or in the Original content dialog/);
  const buttons = root.querySelectorAll('button');
  click(buttons.find((b) => b.textContent === 'Original content...'));
  assert.equal(opened, 1);
  assert.equal(buttons.find((b) => b.textContent === 'Use installed original sounds').hidden, true);
  player.dispose();
});

test('installed music while "Use installed original sounds" is off: the player says so and turns it on', async () => {
  const store = new MemoryStore();
  await store.putAll([{ name: 'hell226m.aud', bytes: imaAud(sineSamples(2205)).buffer, size: 1, from: 'scores.mix', kind: 'sound' }]);
  const { audio } = await audioWith({ tracks: 0, store });
  audio.prefs.set({ original: false });
  await audio.jukebox.refresh();
  const root = doc.createElement('div');
  const player = mountMusicPlayer(root, audio);
  await settle();
  assert.match(textOf(root), /One music track is installed, but "Use installed original sounds" is off\./);
  const use = root.querySelectorAll('button').find((b) => b.textContent === 'Use installed original sounds');
  assert.equal(use.hidden, false);
  click(use);
  assert.equal(audio.prefs.get().original, true);
  await settle();
  assert.equal(root.querySelector('.music-main').hidden, false, 'the installed track is listed now');
  assert.deepEqual(root.querySelectorAll('.music-track-title').map((t) => t.textContent), ['Hell March']);
  assert.equal(root.querySelector('.music-track-length').textContent, '0:00', 'its length from the AUD header (a tenth of a second)');
  player.dispose();
});

test('the player lists the tracks with lengths, plays a picked one outside a game and shows its time', async () => {
  const { audio, played, tick } = await audioWith({ tracks: 3 });
  assert.equal(audio.inGame, false);
  const root = doc.createElement('div');
  doc.body.append(root);
  const player = mountMusicPlayer(root, audio, { idPrefix: 'mp' });
  await settle();
  const tracks = root.querySelectorAll('.music-track');
  assert.deepEqual(root.querySelectorAll('.music-track-title').map((t) => t.textContent), MUSIC.slice(0, 3).map((m) => m.title));
  assert.deepEqual(root.querySelectorAll('.music-track-length').map((t) => t.textContent), ['1:05', '2:05', '3:05']);
  assert.match(textOf(root.querySelector('.music-status')), /Stopped/);
  assert.equal(root.querySelector('.music-time').textContent, '');

  // Music off in the settings: picking a track switches it on and plays it, here in the menus.
  audio.prefs.set({ musicOn: false });
  click(tracks[1]);
  await settle();
  assert.equal(audio.prefs.get().musicOn, true);
  assert.equal(audio.jukebox.playing, MUSIC[1].title);
  assert.equal(played.at(-1).file, MUSIC[1].file);
  assert.equal(root.querySelector('.music-status').textContent, `Now playing: ${MUSIC[1].title}`);
  assert.equal(tracks[1].getAttribute('aria-current'), 'true');
  assert.ok(tracks[1].classList.contains('current'));
  assert.equal(tracks[0].getAttribute('aria-current'), null);
  assert.equal(tracks[1].getAttribute('aria-label'), `Playing ${MUSIC[1].title}`);
  tick(42);
  audio.changed();
  assert.equal(root.querySelector('.music-time').textContent, '0:42 / 2:05');

  // Play / pause / resume, keeping the place.
  const button = (label) => root.querySelector('.music-transport').querySelectorAll('button').find((b) => b.textContent === label);
  click(button('Pause'));
  assert.equal(audio.jukebox.handle, null);
  assert.equal(root.querySelector('.music-status').textContent, `Paused: ${MUSIC[1].title}`);
  assert.equal(button('Resume').getAttribute('aria-label'), 'Resume');
  assert.equal(root.querySelector('.music-time').textContent, '0:42 / 2:05');
  click(button('Resume'));
  await settle();
  assert.equal(audio.jukebox.playing, MUSIC[1].title);
  assert.equal(played.at(-1).offset, 42, 'resumed where it was');

  // Next and previous, in order (shuffle off).
  check(root.querySelector('#mp-shuffle'), false);
  assert.equal(audio.prefs.get().musicShuffle, false);
  click(button('Next'));
  await settle();
  assert.equal(audio.jukebox.playing, MUSIC[2].title);
  click(button('Previous'));
  await settle();
  assert.equal(audio.jukebox.playing, MUSIC[1].title);

  // Stop: stays stopped, and the player can start it again.
  click(button('Stop'));
  assert.equal(audio.jukebox.playing, null);
  assert.equal(button('Stop').disabled, true);
  assert.equal(root.querySelector('.music-time').textContent, '');
  audio.syncMusic();
  assert.equal(audio.jukebox.handle, null, 'a stopped player is not restarted by the settings');
  click(button('Play'));
  await settle();
  assert.equal(audio.jukebox.playing, MUSIC[1].title, 'Play starts the selected track again');
  player.dispose();
});

test('shuffle, repeat and the music volume are the registry settings, and follow changes made elsewhere', async () => {
  const { audio, registry } = await audioWith({ tracks: 2 });
  const root = doc.createElement('div');
  const player = mountMusicPlayer(root, audio, { idPrefix: 'mp' });
  await settle();
  check(root.querySelector('#mp-repeat-one'), true);
  assert.equal(registry.get('audio', 'musicRepeat'), 'one');
  check(root.querySelector('#mp-shuffle'), false);
  assert.equal(registry.get('audio', 'musicShuffle'), false);
  const volume = root.querySelector('#mp-volume');
  assert.ok(volume.classList.contains('ui-slider'), 'the themed slider');
  volume.value = '25';
  volume.dispatchEvent(new FakeEvent('input'));
  assert.equal(registry.get('audio', 'music'), 0.25);
  assert.equal(audio.mixer.buses.music.gain.value, 0.25 * audio.prefs.get().master, 'live on the music bus');
  // Changed elsewhere (the Sound dialog, another tab, the account).
  registry.patch('audio', { musicRepeat: 'off', musicShuffle: true, music: 0.6 });
  assert.equal(root.querySelector('#mp-repeat-off').checked, true);
  assert.equal(root.querySelector('#mp-shuffle').checked, true);
  assert.equal(volume.value, '60');
  assert.equal(root.querySelector('#mp-repeat').getAttribute('role'), 'radiogroup');
  assert.equal(root.querySelector('#mp-shuffle').getAttribute('role'), 'switch');
  // A picked track with shuffle on: the others follow in a new random order, each once.
  click(root.querySelectorAll('.music-track')[1]);
  await settle();
  assert.deepEqual([...audio.jukebox.order].sort(), [0, 1]);
  assert.equal(audio.jukebox.order[0], 1);
  player.dispose();
});

test('a track picked before audio is unlocked plays once it is; sound off is explained', async () => {
  const { audio } = await audioWith({ tracks: 2 });
  audio.mixer.ctx.state = 'suspended';
  audio.mixer.ctx.resume = async () => {};
  audio.playTrack(1);
  assert.equal(audio.pendingTrack, 1);
  assert.equal(audio.jukebox.playing, null);
  assert.match(playerStatus(audio), /^Starting: /);
  audio.mixer.ctx.state = 'running';
  audio.syncMusic();
  await settle();
  assert.equal(audio.pendingTrack, null);
  assert.equal(audio.jukebox.playing, MUSIC[1].title);
  audio.stopMusic();
  audio.prefs.set({ enabled: false });
  assert.match(playerStatus(audio), /Sound is off/);
  audio.prefs.set({ enabled: true, music: 0 });
  assert.match(playerStatus(audio), /music volume is at 0%/);
});

test('the Music dialog opens from the Sound dialog, closes with Escape and stops following the settings', async () => {
  const { audio } = await audioWith({ tracks: 2 });
  const button = doc.createElement('button');
  const soundPanel = doc.createElement('section');
  const musicPanel = doc.createElement('section');
  soundPanel.hidden = true; // index.html: hidden until the Sound button opens it
  doc.body.append(button, soundPanel, musicPanel);
  const music = mountMusicPanel(musicPanel, audio);
  mountAudioPanel(button, soundPanel, audio, { onMusicPlayer: () => music.open(button) });
  click(button);
  assert.equal(soundPanel.hidden, false);
  const listeners = audio.listeners.size;
  click(soundPanel.querySelectorAll('button').find((b) => b.textContent === 'Music player...'));
  assert.equal(soundPanel.hidden, true, 'the Sound dialog closes');
  assert.equal(musicPanel.hidden, false);
  assert.ok(music.isOpen());
  assert.equal(musicPanel.querySelector('[role="dialog"]').getAttribute('aria-labelledby'), 'music-title');
  assert.equal(audio.listeners.size, listeners + 1, 'the player follows the audio system while open');
  await settle();
  assert.equal(musicPanel.querySelectorAll('.music-track').length, 2);
  const esc = new FakeEvent('keydown', { key: 'Escape' });
  musicPanel.querySelector('.music-track').dispatchEvent(esc);
  assert.equal(esc.propagationStopped, true, 'keys stay in the dialog');
  assert.equal(musicPanel.hidden, true);
  assert.equal(audio.listeners.size, listeners, 'and lets go when it closes');
  assert.equal(doc.activeElement, button, 'focus goes back to where the dialog was opened');
});

test('the game menu has a Music page with the player, also linked from the Audio settings', async () => {
  const registry = createRegistry({ storage: memoryStorage() });
  const { audio } = await audioWith({ tracks: 2, registry });
  const settings = createSettings(registry);
  const root = doc.createElement('section');
  doc.body.append(root);
  const menu = new GameMenu(root, {
    online: false,
    hotkeys: new HotkeyRegistry(settings),
    settings,
    fullscreen: { available: () => false, active: () => false, toggle: async () => ({ ok: true }) },
    onChange() {},
    audio,
    onLeave() {},
    onExit() {},
  });
  menu.open();
  const listeners = audio.listeners.size;
  click(root.querySelectorAll('button').find((b) => b.textContent === 'Music'));
  assert.equal(menu.view, 'music');
  assert.equal(root.querySelector('h1').textContent, 'Music');
  await settle();
  assert.equal(root.querySelectorAll('.music-track').length, 2);
  assert.ok(root.querySelector('#menu-music-shuffle'));
  click(root.querySelectorAll('.music-track')[0]);
  await settle();
  assert.equal(audio.jukebox.playing, MUSIC[0].title);
  click(root.querySelectorAll('button').find((b) => b.textContent === 'Back'));
  assert.equal(menu.view, 'main');
  assert.equal(audio.listeners.size, listeners, 'the page stops following the audio system');
  // Settings, Audio: "Music player..." opens the same page.
  menu.show('settings');
  click(root.querySelectorAll('button').find((b) => b.textContent === 'Music player...'));
  assert.equal(menu.view, 'music');
  menu.close();
  assert.equal(audio.listeners.size, listeners);
});

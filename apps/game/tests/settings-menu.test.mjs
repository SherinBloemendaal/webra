// The game menu's Settings page (js/gamemenu.js): the UI and game scale rows
// (slider, value, Auto, Reset, live preview), the Audio section shared with
// the Sound dialog (js/audio/panel.js), live music volume, and the music
// player's music on, shuffle and repeat (js/audio/music.js). Fake DOM, no
// browser, no WebAssembly. Run with: node --test apps/game/tests/*.test.mjs
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, uninstallDom, click, check, typeInto, textOf, FakeEvent, memoryStorage } from './dom-fixtures.mjs';
import { createRegistry } from '../js/registry.js';
import { createSettings } from '../js/settings.js';
import { HotkeyRegistry } from '../js/hotkeys.js';
import { GameMenu, scaleLabel, MENU_SETTINGS, DISPLAY_HELP } from '../js/gamemenu.js';
import { UiScale, crispGameScales, autoGameScale, screenOf } from '../js/scale.js';
import { AudioSystem } from '../js/audio/index.js';
import { mountAudioPanel, musicText, AUDIO_HELP_KEYS } from '../js/audio/panel.js';
import { MENU_HELP_KEYS, CONTROLS_SETTINGS } from '../js/gamemenu.js';
import { HELP } from '../js/help.js';
import { Jukebox, playOrder } from '../js/audio/music.js';
import { DEFAULT_PREFS, busGain } from '../js/audio/prefs.js';
import { MUSIC } from '../js/audio/catalog.js';
import { MemoryStore } from '../js/content/store.js';

let doc;
beforeEach(() => {
  doc = installDom();
});
afterEach(() => uninstallDom());

/** A CSSOM style that remembers custom properties. */
function recordingStyle() {
  const props = new Map();
  return { props, setProperty: (k, v) => props.set(k, String(v)), removeProperty: (k) => props.delete(k) };
}

function fakeWindow(w = 1920, h = 1080, dpr = 2) {
  const listeners = new Map();
  return {
    innerWidth: w,
    innerHeight: h,
    devicePixelRatio: dpr,
    addEventListener: (t, fn) => listeners.set(t, [...(listeners.get(t) ?? []), fn]),
    removeEventListener: (t, fn) => listeners.set(t, (listeners.get(t) ?? []).filter((f) => f !== fn)),
    matchMedia: () => ({ addEventListener() {}, removeEventListener() {} }),
    resize(nw, nh) {
      this.innerWidth = nw;
      this.innerHeight = nh;
      for (const fn of listeners.get('resize') ?? []) fn();
    },
    count: (t) => (listeners.get(t) ?? []).length,
  };
}

/** Gain nodes of a running mixer: the bus volumes as set. */
function runMixer(audio) {
  const node = () => ({ gain: { value: 1, setTargetAtTime(v) {
    this.value = v;
  } } });
  audio.mixer.ctx = { state: 'running', currentTime: 0 };
  audio.mixer.buses = { master: node(), effects: node(), voices: node(), music: node() };
  audio.mixer.apply(audio.prefs.get());
  return audio.mixer.buses;
}

function setup({ win = fakeWindow(), withAudio = true, onContent, pointerLock = true } = {}) {
  const registry = createRegistry({ storage: memoryStorage() });
  const settings = createSettings(registry);
  const hotkeys = new HotkeyRegistry(settings);
  const page = { style: recordingStyle() };
  const uiScale = new UiScale({ settings, win, root: page });
  let audio = null;
  if (withAudio) {
    audio = new AudioSystem({ registry, doc: null });
    const store = new MemoryStore();
    audio.store = async () => store;
    audio.jukebox.getStore = async () => store;
  }
  const root = doc.createElement('section');
  root.style = recordingStyle();
  doc.body.append(root);
  const menu = new GameMenu(root, {
    online: false,
    hotkeys,
    settings,
    fullscreen: { available: () => false, active: () => false, toggle: async () => ({ ok: true }) },
    mouseCapture: { available: () => pointerLock },
    onChange() {},
    uiScale,
    renderRatio: () => 2,
    win,
    audio,
    onContent,
    onLeave() {},
    onExit() {},
  });
  menu.open();
  menu.show('settings');
  return { registry, settings, uiScale, audio, menu, root, page, win };
}

const $ = (root, sel) => root.querySelector(sel);

test('settings page: tabs for every section (Game, Graphics, Controls, Hotkeys, Sound, Privacy, Advanced), with the scale help', () => {
  const { root } = setup();
  const tabs = [...root.querySelectorAll('[role="tab"]')].map((t) => t.textContent);
  assert.deepEqual(tabs, ['Game', 'Graphics', 'Controls', 'Hotkeys', 'Sound', 'Privacy', 'Advanced']);
  const titles = [...root.querySelectorAll('h2')].map((h) => h.textContent);
  for (const t of ['Scrolling and units', 'Chat and notifications', 'Online games', 'Texture pack', 'Display', 'Build menu', 'Mouse capture', 'Audio', 'Music player', 'Privacy', 'Performance']) assert.ok(titles.includes(t), t);
  // One panel shows at a time; the tab bar switches them.
  const panels = [...root.querySelectorAll('[role="tabpanel"]')];
  assert.equal(panels.filter((p) => !p.hidden).length, 1);
  click(root.querySelector('#game-menu-tab-graphics'));
  assert.equal(root.querySelector('#game-menu-tab-graphics-panel').hidden, false);
  assert.equal(root.querySelector('#game-menu-tab-game-panel').hidden, true);
  // OpenRA's HideReplayChat and TextNotificationPoolFilters.
  for (const id of ['#game-menu-hideReplayChat', '#game-menu-uiFeedbackNotifications', '#game-menu-gameEventNotifications']) assert.ok($(root, id), id);
  assert.ok(textOf(root).includes(DISPLAY_HELP), 'the three ways the picture changes are explained');
  for (const id of ['#game-menu-uiScale', '#game-menu-gameScale']) assert.ok($(root, id), id);
  assert.ok(root.querySelector('.game-menu-scroll'), 'the page scrolls inside the card');
});

test('settings page: UI scale shows Auto with its value, previews live while dragging, stores on release, Reset goes back to Auto', () => {
  const { root, settings, page, uiScale } = setup({ win: fakeWindow(1366, 768, 2) });
  const slider = $(root, '#game-menu-uiScale');
  const row = slider.closest('.game-menu-scale');
  const out = row.querySelector('output');
  const [auto] = [...row.querySelectorAll('input[type="checkbox"]')];
  assert.equal(auto.getAttribute('role'), 'switch', 'Auto is a themed switch');
  assert.ok(slider.classList.contains('ui-slider'), 'a themed slider');
  const reset = [...row.querySelectorAll('button')].find((b) => b.textContent === 'Reset');
  assert.equal(out.textContent, 'Auto (85%)');
  assert.equal(slider.value, '0.85');
  assert.equal(auto.checked, true);
  assert.equal(reset.disabled, true, 'already the default');
  assert.equal(page.style.props.get('--ui-scale'), '0.85');
  // Dragging: the page follows, the menu keeps its size, nothing is stored yet.
  slider.value = '1.2';
  slider.dispatchEvent(new FakeEvent('input'));
  assert.equal(page.style.props.get('--ui-scale'), '1.2');
  assert.equal(root.style.props.get('--ui-scale'), '0.85', 'the menu is pinned while the slider moves');
  assert.equal(settings.get('uiScale'), 'auto');
  assert.equal(out.textContent, '120%');
  assert.equal(auto.checked, false);
  slider.dispatchEvent(new FakeEvent('change'));
  assert.equal(settings.get('uiScale'), 1.2);
  assert.equal(root.style.props.has('--ui-scale'), false, 'released: the menu follows the page again');
  assert.equal(page.style.props.get('--ui-scale'), '1.2');
  assert.equal(uiScale.previewing, null);
  assert.equal(reset.disabled, false);
  click(reset);
  assert.equal(settings.get('uiScale'), 'auto');
  assert.equal(out.textContent, 'Auto (85%)');
  // Auto off keeps the size Auto had picked, as a fixed value.
  check(auto, false);
  assert.equal(settings.get('uiScale'), 0.85);
  check(auto, true);
  assert.equal(settings.get('uiScale'), 'auto');
  // A change made elsewhere (another tab, the account) shows at once.
  settings.set('uiScale', 0.6);
  assert.equal(out.textContent, '60%');
  assert.equal(page.style.props.get('--ui-scale'), '0.6');
});

test('settings page: closing the menu mid-drag ends the preview; nothing is left listening', () => {
  const { root, settings, page, menu, win, audio } = setup();
  const listeners = audio.prefs.listeners.size;
  const resize = win.count('resize');
  const slider = $(root, '#game-menu-uiScale');
  slider.value = '1.5';
  slider.dispatchEvent(new FakeEvent('input'));
  assert.equal(page.style.props.get('--ui-scale'), '1.5');
  menu.close();
  assert.equal(page.style.props.get('--ui-scale'), '1', 'back to the stored setting (Auto)');
  assert.equal(root.style.props.has('--ui-scale'), false);
  assert.equal(settings.get('uiScale'), 'auto');
  assert.ok(audio.prefs.listeners.size < listeners, 'the Audio section stopped following the settings');
  assert.ok(win.count('resize') < resize, 'the game scale row stopped following the window');
  // Opening again mounts one set of listeners, not two.
  menu.open();
  menu.show('settings');
  menu.show('main');
  menu.show('settings');
  assert.equal(audio.prefs.listeners.size, listeners);
});

test('settings page: game scale snaps to sharp steps for the render ratio and is stored while dragging', () => {
  const { root, settings, win } = setup({ win: fakeWindow(1920, 1080, 2) });
  const slider = $(root, '#game-menu-gameScale');
  const row = slider.closest('.game-menu-scale');
  const out = row.querySelector('output');
  assert.equal(out.textContent, `Auto (${Math.round(autoGameScale({ ...screenOf(win), ratio: 2 }) * 100)}%)`);
  // The sharp steps are marked on the slider.
  const ticks = [...row.querySelectorAll('datalist option')].map((o) => Number(o.value));
  assert.deepEqual(ticks, crispGameScales(2));
  assert.equal(slider.getAttribute('list'), row.querySelector('datalist').id);
  typeInto(slider, '1.31');
  assert.ok(Math.abs(settings.get('gameScale') - 4 / 3) < 1e-9, 'snapped to 4 render px per world px');
  assert.equal(out.textContent, '133%');
  typeInto(slider, '1.17');
  assert.equal(settings.get('gameScale'), 1.15);
  click([...row.querySelectorAll('button')].find((b) => b.textContent === 'Reset'));
  assert.equal(settings.get('gameScale'), 'auto');
  // Auto follows the window while the page is open.
  win.resize(3840, 2160);
  assert.equal(out.textContent, scaleLabel('auto', autoGameScale({ ...screenOf(win), ratio: 2 })));
});

test('settings page: Reset this section puts back the settings of the open tab, the audio ones on Sound', () => {
  const { root, settings, audio, registry } = setup();
  settings.set('uiScale', 1.5);
  settings.set('gameScale', 2);
  settings.set('edgeScrollSpeed', 3);
  settings.set('zoomFactor', 2);
  settings.set('mouseCaptureRaw', true);
  registry.set('net', 'warnSelf', false);
  audio.prefs.set({ music: 0.1, musicRepeat: 'one', enabled: false });
  const reset = () => click([...root.querySelectorAll('button')].find((b) => b.textContent === 'Reset this section'));
  const tab = (id) => click(root.querySelector(`#game-menu-tab-${id}`));
  tab('graphics');
  reset();
  assert.equal(settings.get('uiScale'), 'auto');
  assert.equal(settings.get('zoomFactor'), 1);
  assert.equal(settings.get('edgeScrollSpeed'), 3, 'another tab keeps its settings');
  tab('game');
  reset();
  assert.equal(settings.get('edgeScrollSpeed'), 1);
  assert.equal(registry.get('net', 'warnSelf'), true, 'the Online games switches too');
  tab('controls');
  reset();
  assert.equal(settings.get('mouseCaptureRaw'), false);
  tab('sound');
  reset();
  assert.deepEqual(audio.prefs.get(), DEFAULT_PREFS);
  for (const key of MENU_SETTINGS) assert.deepEqual(settings.get(key), createSettings(null).get(key), key);
  // Privacy has no reset: switching error reports back on is the player's call.
  tab('privacy');
  assert.equal([...root.querySelectorAll('button')].find((b) => b.textContent === 'Reset this section').hidden, true);
});

test('settings page: without sound the Audio section says so', () => {
  const { root } = setup({ withAudio: false });
  assert.match(textOf(root), /Sound is unavailable in this browser/);
});

// ---- Audio section and the Sound dialog -----------------------------------------------------------

test('audio section: every sound control, bound to the settings; the Sound dialog shows the same and stays in step', async () => {
  let opened = 0;
  const { root, audio } = setup({ onContent: () => opened++ });
  const buses = runMixer(audio);
  const box = root.querySelector('.game-menu-audio');
  for (const key of ['enabled', 'master', 'effects', 'voices', 'music', 'speech', 'original', 'cashTicks', 'musicOn', 'musicShuffle']) {
    const input = box.querySelector(`#menu-audio-${key}`);
    assert.ok(input, key);
    assert.ok(box.querySelector(`label[for="menu-audio-${key}"]`), `${key} has a label`);
  }
  // The shared themed controls (js/ui/controls.js): switches for on/off, sliders, a segmented repeat choice.
  for (const key of ['enabled', 'speech', 'original', 'cashTicks', 'musicOn', 'musicShuffle']) assert.equal(box.querySelector(`#menu-audio-${key}`).getAttribute('role'), 'switch', key);
  for (const key of ['master', 'effects', 'voices', 'music']) assert.ok(box.querySelector(`#menu-audio-${key}`).classList.contains('ui-slider'), key);
  const repeatGroup = box.querySelector('#menu-audio-musicRepeat');
  assert.equal(repeatGroup.getAttribute('role'), 'radiogroup');
  assert.deepEqual([...repeatGroup.querySelectorAll('input')].map((r) => r.getAttribute('value')), ['all', 'one', 'off']);
  assert.ok(box.querySelectorAll('h3').length >= 2, 'section titles under the page\'s Audio heading');
  // The Sound dialog: the same component, its own ids.
  const button = doc.createElement('button');
  const panel = doc.createElement('section');
  doc.body.append(button, panel);
  mountAudioPanel(button, panel, audio, { onContent: () => opened++ });
  const dialogMusic = panel.querySelector('#audio-music');
  assert.ok(dialogMusic, 'the dialog has a separate music slider');
  assert.equal(doc.querySelectorAll('#menu-audio-music').length, 1);

  // Music volume: live on the music bus, and the dialog follows.
  const music = box.querySelector('#menu-audio-music');
  music.value = '20';
  music.dispatchEvent(new FakeEvent('input'));
  assert.equal(audio.prefs.get().music, 0.2);
  assert.ok(Math.abs(buses.music.gain.value - busGain(audio.prefs.get(), 'music')) < 1e-12);
  assert.ok(Math.abs(buses.music.gain.value - 0.8 * 0.2) < 1e-12, 'master times music');
  assert.equal(dialogMusic.value, '20');
  assert.equal(dialogMusic.parentNode.querySelector('output').textContent, '20%');
  // Master changes reach the music bus too; sound off silences it.
  typeInto(panel.querySelector('#audio-master'), '50');
  assert.ok(Math.abs(buses.music.gain.value - 0.5 * 0.2) < 1e-12);
  check(box.querySelector('#menu-audio-enabled'), false);
  assert.equal(buses.music.gain.value, 0);
  assert.equal(panel.querySelector('#audio-enabled').checked, false);
  // Per-volume Reset.
  const resetMusic = music.parentNode.querySelector('button.audio-reset');
  click(resetMusic);
  assert.equal(audio.prefs.get().music, DEFAULT_PREFS.music);
  assert.equal(resetMusic.disabled, true);
  // Music settings.
  check(box.querySelector('#menu-audio-musicOn'), false);
  check(box.querySelector('#menu-audio-musicShuffle'), false);
  check(box.querySelector('#menu-audio-musicRepeat-one'), true);
  assert.equal(audio.prefs.get().musicOn, false);
  assert.equal(audio.prefs.get().musicShuffle, false);
  assert.equal(audio.prefs.get().musicRepeat, 'one');
  assert.equal(panel.querySelector('#audio-musicRepeat-one').checked, true, 'the dialog follows');
  assert.equal(panel.querySelector('#audio-musicRepeat-all').checked, false);
  assert.equal(panel.querySelector('#audio-musicShuffle').checked, false);
  // No music installed: clear text and the way to install it.
  assert.match(textOf(box), /No music installed\. Music comes from your own copy of Red Alert/);
  const install = [...box.querySelectorAll('button')].find((b) => b.textContent === 'Original content...' && !b.hidden && b.parentNode.parentNode.classList.contains('audio-music'));
  assert.ok(install, 'Original content button beside the music');
  click(install);
  assert.equal(opened, 1);
  assert.equal(box.querySelector('.audio-music-controls').hidden, true, 'no music: no music controls to set');
});

test('audio section: now playing, next track, music on and off with installed music', async () => {
  const { root, audio } = setup();
  runMixer(audio);
  const played = [];
  audio.mixer.play = (buffer, opts) => {
    const handle = { buffer, stop() {}, ended: Promise.resolve(), opts };
    played.push(handle);
    return handle;
  };
  // Two pack tracks (texture pack music): the playlist.
  const tracks = MUSIC.slice(0, 2);
  audio.bank.pack = new Map(tracks.map((t) => [t.file, { duration: 60, file: t.file }]));
  // The constructor's first look at the installed content finishes first.
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  await audio.jukebox.refresh();
  audio.changed();
  audio.inGame = true;
  audio.syncMusic();
  await new Promise((r) => setImmediate(r));
  const box = root.querySelector('.game-menu-audio');
  const now = box.querySelector('.audio-now');
  assert.match(now.textContent, /^Now playing: /);
  assert.equal(box.querySelector('.audio-music-controls').hidden, false);
  const next = [...box.querySelectorAll('button')].find((b) => b.textContent === 'Next track');
  assert.equal(next.disabled, false);
  const first = audio.jukebox.playing;
  click(next);
  await new Promise((r) => setImmediate(r));
  assert.notEqual(audio.jukebox.playing, first, 'next track plays the other one');
  assert.equal(played.length, 2);
  // Music off stops it at once; on starts it again.
  check(box.querySelector('#menu-audio-musicOn'), false);
  assert.equal(audio.jukebox.handle, null);
  assert.match(now.textContent, /Music is off/);
  check(box.querySelector('#menu-audio-musicOn'), true);
  await new Promise((r) => setImmediate(r));
  assert.ok(audio.jukebox.handle, 'playing again');
  assert.equal(musicText(audio).startsWith('Now playing'), true);
});

// ---- The music player ----------------------------------------------------------------------------------

/** A jukebox over pack tracks with a fake mixer; `end()` lets the playing track finish. */
function jukebox(mode) {
  const played = [];
  const mixer = {
    ready: true,
    play(buffer, opts) {
      const handle = { file: buffer.file, onEnded: opts.onEnded, stopped: false, stop() {
        this.stopped = true;
      } };
      played.push(handle);
      return handle;
    },
  };
  const tracks = MUSIC.slice(0, 4);
  const pack = new Map(tracks.map((t) => [t.file, { file: t.file }]));
  const box = new Jukebox(mixer, async () => new MemoryStore(), () => {}, () => pack, () => true, () => mode);
  const settle = () => new Promise((r) => setImmediate(r));
  return {
    box,
    played,
    files: () => played.map((h) => tracks.findIndex((t) => t.file === h.file)),
    async end() {
      played[played.length - 1].onEnded();
      await settle();
    },
    settle,
  };
}

test('music: in order without shuffle; repeat all starts over, repeat one plays the same, repeat off stops', async () => {
  const mode = { shuffle: false, repeat: 'all' };
  const j = jukebox(mode);
  await j.box.refresh();
  await j.box.start();
  for (let i = 0; i < 5; i++) await j.end();
  assert.deepEqual(j.files(), [0, 1, 2, 3, 0, 1], 'listed order, then again');
  mode.repeat = 'one';
  await j.end();
  await j.end();
  assert.deepEqual(j.files().slice(-3), [1, 1, 1], 'one track again and again');
  // "Next track" still moves on with repeat one.
  await j.box.next();
  assert.equal(j.files().at(-1), 2);
  mode.repeat = 'off';
  await j.end();
  await j.end();
  assert.equal(j.box.finished, true, 'the playlist ended after the last track');
  assert.equal(j.box.playing, null);
  assert.deepEqual(j.files().slice(-2), [2, 3]);
  await j.box.start();
  assert.equal(j.played.length, 10, 'a finished playlist stays quiet');
  // Repeat on again: it may play; Next track restarts it.
  mode.repeat = 'all';
  j.box.repeatChanged();
  assert.equal(j.box.finished, false);
  await j.box.next();
  assert.ok(j.box.playing);
});

test('music: shuffle plays every track once per round; switching shuffle keeps the playing track', async () => {
  const mode = { shuffle: true, repeat: 'all' };
  const j = jukebox(mode);
  let x = 0.42;
  j.box.random = () => (x = (x * 9301 + 0.49297) % 1);
  await j.box.refresh();
  await j.box.start();
  for (let i = 0; i < 3; i++) await j.end();
  assert.deepEqual([...j.files()].sort(), [0, 1, 2, 3], 'each track once');
  const playing = j.files().at(-1);
  mode.shuffle = false;
  j.box.reorder();
  assert.equal(j.played.at(-1).stopped, false, 'not cut off');
  await j.end();
  assert.equal(j.files().at(-1), (playing + 1) % 4, 'in order from the playing track');
  assert.deepEqual(playOrder(3, false), [0, 1, 2]);
  assert.notEqual(playOrder(5, true, j.box.random, 2)[0], 2);
});

test('music: off when music is off, the music volume is 0, or sound is off', () => {
  const audio = new AudioSystem({ registry: createRegistry({ storage: memoryStorage() }), doc: null });
  runMixer(audio);
  audio.jukebox.tracks = MUSIC.slice(0, 1);
  audio.inGame = true;
  assert.equal(audio.musicWanted(), true);
  for (const patch of [{ musicOn: false }, { music: 0 }, { enabled: false }]) {
    audio.prefs.set(patch);
    assert.equal(audio.musicWanted(), false, JSON.stringify(patch));
    audio.prefs.set(DEFAULT_PREFS);
  }
  assert.equal(audio.musicWanted(), true);
});

test('settings page: every setting with help has a "?" wired to its control; Esc closes an open tip before the page', () => {
  const listeners = [];
  globalThis.window.addEventListener = (type, fn) => listeners.push([type, fn]);
  globalThis.Element = globalThis.HTMLElement;
  try {
    const { root, menu } = setup();
    const buttons = [...root.querySelectorAll('.info-btn')];
    const keys = new Set(buttons.map((b) => b.dataset.help));
    for (const k of MENU_HELP_KEYS) assert.ok(keys.has(`settings.${k}`), `no "?" for ${k}`);
    for (const k of AUDIO_HELP_KEYS) assert.ok(keys.has(`audio.${k}`), `no "?" for audio ${k}`);
    // Auto has its own "?" on both scale rows.
    assert.equal(buttons.filter((b) => b.dataset.help === 'settings.scaleAuto').length, 2);
    for (const b of buttons) {
      const tip = root.querySelector(`#${b.getAttribute('aria-describedby')}`);
      assert.equal(tip.textContent, HELP[b.dataset.help]);
      const described = [...root.querySelectorAll('[aria-describedby]')].filter((e) => e !== b && e.getAttribute('aria-describedby').split(' ').includes(tip.id));
      assert.equal(described.length, 1, `${b.dataset.help} describes one control`);
    }
    for (const id of ['#game-menu-uiScale', '#game-menu-gameScale', '#game-menu-uiScale-auto', '#game-menu-pixelRatioCap', '#game-menu-lowQuality']) {
      assert.ok(root.querySelector(id).getAttribute('aria-describedby'), id);
    }
    // The labels still name their controls.
    for (const label of [...root.querySelectorAll('.ui-label-help > label')]) assert.ok(root.querySelector(`#${label.getAttribute('for')}`), textOf(label));
    const onKey = listeners.find(([t]) => t === 'keydown')[1];
    const esc = () => onKey(Object.assign(new FakeEvent('keydown', { key: 'Escape' }), { stopImmediatePropagation() {}, target: doc.body }));
    click(buttons[0]);
    assert.ok(root.querySelector('.info-tip:not([hidden])'));
    esc();
    assert.equal(root.querySelector('.info-tip:not([hidden])'), null, 'Esc closed the tip');
    assert.equal(menu.view, 'settings', 'and left the settings page open');
    esc();
    assert.equal(menu.view, 'main');
  } finally {
    delete globalThis.Element;
  }
});

test('the Sound dialog stays without help buttons (only the game menu asks for them)', () => {
  const { audio } = setup();
  const button = doc.createElement('button');
  const panel = doc.createElement('section');
  doc.body.append(button, panel);
  mountAudioPanel(button, panel, audio);
  assert.ok(panel.querySelector('#audio-music'));
  assert.equal(panel.querySelectorAll('.info-btn').length, 0);
});

test('settings page: Mouse capture (mode, speed, Esc) where Pointer Lock exists, none without it', () => {
  const { settings, root, menu } = setup();
  // The game registers the release hotkey (js/gamekeys.js): the section names its key.
  menu.opts.hotkeys.registerAction('toggleMouseCapture', ['Alt+E'], () => {});
  menu.render();
  const texts = [...root.querySelectorAll('h2')].map((h) => h.textContent);
  assert.ok(texts.includes('Mouse capture'));
  const always = root.querySelector('#game-menu-mouseCapture-always');
  assert.ok(root.querySelector('#game-menu-mouseCapture-fullscreen').checked, 'in fullscreen by default');
  check(always);
  assert.equal(settings.get('mouseCapture'), 'always');
  typeInto(root.querySelector('#game-menu-mouseCaptureSpeed'), '1.5');
  assert.equal(settings.get('mouseCaptureSpeed'), 1.5);
  const escMenu = root.querySelector('#game-menu-mouseCaptureEscMenu');
  assert.ok(escMenu.checked, 'Esc also opens the menu by default');
  check(escMenu, false);
  assert.equal(settings.get('mouseCaptureEscMenu'), false);
  assert.match(textOf(root), /(Alt|Option)\+E releases it and the game plays on; Esc releases it too\. A click into the game captures it again\./);
  // The "Mouse captured" notice: every time by default, the first 3 times, or never.
  assert.ok(root.querySelector('#game-menu-mouseCaptureNotice-always').checked);
  check(root.querySelector('#game-menu-mouseCaptureNotice-first'));
  assert.equal(settings.get('mouseCaptureNotice'), 'first');
  check(root.querySelector('#game-menu-mouseCaptureNotice-off'));
  assert.equal(settings.get('mouseCaptureNotice'), 'off');
  assert.ok(MENU_HELP_KEYS.includes('mouseCaptureNotice') && HELP['settings.mouseCaptureNotice'], 'a "?" with help');
  uninstallDom();
  doc = installDom();
  const none = setup({ pointerLock: false });
  assert.ok(![...none.root.querySelectorAll('h2')].some((h) => h.textContent === 'Mouse capture'), 'phones and iOS Safari: no section');
  assert.equal(none.root.querySelector('#game-menu-mouseCapture-always'), null);
  assert.equal(none.root.querySelector('#game-menu-mouseCaptureNotice-always'), null, 'no notice setting without capture');
  assert.ok(none.root.querySelector('#game-menu-pauseWhenHidden'), 'pausing a hidden game is for every device');
});

test('settings page: Pause when the game is hidden, off by default, with help that names browser throttling', () => {
  const { settings, root } = setup();
  const box = root.querySelector('#game-menu-pauseWhenHidden');
  assert.ok(box);
  assert.equal(box.checked, false, 'a hidden single-player game plays on by default');
  check(box);
  assert.equal(settings.get('pauseWhenHidden'), true);
  assert.ok(MENU_HELP_KEYS.includes('pauseWhenHidden') && MENU_SETTINGS.includes('pauseWhenHidden'));
  assert.match(HELP['settings.pauseWhenHidden'], /Browsers slow down hidden pages/);
  assert.match(HELP['settings.pauseWhenHidden'], /Losing the focus to another window never pauses it/);
});

test('settings page: Raw mouse input, off by default, with help, after the speed', () => {
  const { settings, root } = setup();
  const raw = root.querySelector('#game-menu-mouseCaptureRaw');
  assert.ok(raw, 'the switch');
  assert.equal(raw.checked, false, 'the system movement by default');
  const ids = [...root.querySelectorAll('input')].map((i) => i.id);
  assert.ok(ids.indexOf('game-menu-mouseCaptureSpeed') < ids.indexOf('game-menu-mouseCaptureRaw'));
  assert.ok(ids.indexOf('game-menu-mouseCaptureRaw') < ids.indexOf('game-menu-mouseCaptureEscMenu'));
  assert.match(textOf(root), /Raw mouse input/);
  assert.ok(MENU_HELP_KEYS.includes('mouseCaptureRaw') && HELP['settings.mouseCaptureRaw'], 'a "?" with help');
  assert.match(HELP['settings.mouseCaptureSpeed'], /exactly like the system pointer/);
  check(raw);
  assert.equal(settings.get('mouseCaptureRaw'), true);
  check(raw, false);
  assert.equal(settings.get('mouseCaptureRaw'), false);
});

test('privacy: the error report switch, with a note while this build reports nothing', async () => {
  const { initTelemetry, resetTelemetry } = await import('../js/telemetry/index.js');
  const NOTE = 'Error reporting is off on this site: nothing is sent, whatever this switch says.';
  try {
    const off = setup();
    assert.ok($(off.root, '#game-menu-errorReports'), 'the switch');
    assert.ok(textOf(off.root).includes(NOTE), 'no DSN: the note says nothing is sent');
    const sdk = { init() {}, setTags() {} };
    await initTelemetry({ surface: 'game', config: { dsn: 'https://0123456789abcdef0123456789abcdef@sentry.invalid/1', environment: 'test', release: '', tracesSampleRate: 0 }, storage: null, win: null, loadSdk: async () => sdk });
    const on = setup();
    assert.ok($(on.root, '#game-menu-errorReports'));
    assert.equal(textOf(on.root).includes(NOTE), false, 'with a DSN the switch decides');
    check($(on.root, '#game-menu-errorReports'), false);
    assert.equal(on.registry.get('privacy', 'errorReports'), false);
  } finally {
    resetTelemetry();
  }
});

test('controls page: Right click in the build menu, OpenRA by default, with help; reset hotkeys leaves it', () => {
  const { settings, root, menu } = setup();
  menu.show('controls');
  assert.ok([...root.querySelectorAll('h2')].map((h) => h.textContent).includes('Build menu'));
  const openra = root.querySelector('#game-menu-buildRightClick-openra');
  const webra = root.querySelector('#game-menu-buildRightClick-webra');
  assert.ok(openra && webra);
  assert.equal(settings.get('buildRightClick'), 'openra', 'the sidebar always did what OpenRA does');
  assert.ok(openra.checked);
  check(webra);
  assert.equal(settings.get('buildRightClick'), 'webra');
  assert.ok(CONTROLS_SETTINGS.includes('buildRightClick') && !MENU_SETTINGS.includes('buildRightClick'));
  assert.match(HELP['settings.buildRightClick'], /stack/);
  assert.match(HELP['controls.production'], /whether you have the credits or not/);
  assert.ok(textOf(root).includes(HELP['controls.production']), 'the build menu note is on the page');
});

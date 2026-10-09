// Sound settings: one component for the Sound dialog (index.html, the Sound
// button) and the Audio section of the game menu's Settings page
// (js/gamemenu.js), so both show the same controls and stay in step: every
// control follows the settings, also when they change elsewhere (the other
// place, another tab, the account). Installing the original Red Alert content
// (sounds, music and graphics in one flow) lives in the Original content
// dialog (js/content/panel.js), which `opts.onContent` opens; the music
// player (js/audio/musicplayer.js) is `opts.onMusicPlayer`.

import { installedSummary } from './install.js';
import { MUSIC_SOURCE_HINT } from './catalog.js';
import { DEFAULT_PREFS } from './prefs.js';
import { GROUPS } from '../registry.js';
import { segmented, slider, syncSliderFill, toggle } from '../ui/controls.js';
import { labelWithHelp } from '../infotip.js';

/** Controls that get a "?" with `help: true` (texts: js/help.js `audio.<key>`). */
export const AUDIO_HELP_KEYS = Object.freeze(['master', 'effects', 'voices', 'music', 'speech', 'original', 'cashTicks', 'clickSounds', 'musicOn', 'menuMusic', 'musicShuffle', 'musicRepeat']);

const VOLUMES = [
  ['master', 'Master volume'],
  ['effects', 'Effects'],
  ['voices', 'Voices and announcer'],
  ['music', 'Music'],
];

/** Repeat choices of the music (registry audio.musicRepeat). */
export const REPEAT_LABELS = GROUPS.audio.settings.musicRepeat.labels;
/** Their short names on the segmented control (the long ones are its tooltips). */
const REPEAT_SHORT = { all: 'All', one: 'One', off: 'Off' };

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v !== null && v !== undefined) e.setAttribute(k, v);
  }
  for (const c of children) e.append(c);
  return e;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** A volume (0..1) as the sliders show it. */
export const volumeText = (v) => `${Math.round(v * 100)}%`;

function summaryText(s) {
  if (!s.total) return 'No original sounds installed. WebRA plays its own synthesized sounds.';
  const b = s.byCategory;
  return `Installed on this device: ${plural(b.effects, 'effect', 'effects')}, ${plural(b.voices, 'unit voice', 'unit voices')}, ${plural(
    b.announcer,
    'announcer line',
    'announcer lines',
  )}, ${plural(b.music, 'music track', 'music tracks')}.`;
}

/** What the music line says: the playing track, the playlist, or why nothing plays. */
export function musicText(audio) {
  const p = audio.prefs.get();
  const box = audio.jukebox;
  if (!box.available) return `No music installed. Music comes from your own copy of Red Alert (Original content) or a texture pack with music. ${MUSIC_SOURCE_HINT}`;
  const count = plural(box.tracks.length, 'track', 'tracks');
  if (box.playing) return `Now playing: ${box.playing}`;
  if (!p.enabled) return `${count} installed. Sound is off.`;
  if (!p.musicOn || p.music <= 0) return `${count} installed. Music is off.`;
  if (box.finished) return `${count} installed. The playlist has ended: Next track plays it again.`;
  return `${count} installed; music plays during games and from the music player.`;
}

/**
 * Build the sound settings into `root`.
 * @param {HTMLElement} root
 * @param {import('./index.js').AudioSystem} audio
 * @param {{ onContent?(): void, onMusicPlayer?(): void, idPrefix?: string, heading?: number, help?: boolean }} [opts]
 *   onContent opens the Original content dialog; onMusicPlayer the music player; idPrefix keeps element ids
 *   unique when the settings are on the page twice; heading is the level of
 *   the section titles (2 in the Sound dialog, 3 under the Settings page's Audio);
 *   help adds the "?" help of AUDIO_HELP_KEYS (the game menu).
 * @returns {{ dispose(): void }} stops following the settings (call when `root` goes away)
 */
export function mountAudioSettings(root, audio, opts = {}) {
  const id = (name) => `${opts.idPrefix ?? 'audio'}-${name}`;
  const h = `h${opts.heading ?? 2}`;
  root.classList.add('audio-settings');
  const prefs = audio.prefs;

  // On/off settings: themed switches (css/controls.css).
  const check = (key, label, { disabled = false } = {}) => {
    const c = toggle({ id: id(key), label, disabled, rowClass: 'audio-row', onChange: (on) => prefs.set({ [key]: on }) });
    return { key, input: c.input, row: c.row, sync: (p) => c.set(!!p[key]) };
  };

  const enabled = check('enabled', 'Sound on');
  // Volumes apply while the slider moves, also to the playing music track (mixer buses).
  const sliders = VOLUMES.map(([key, label]) => {
    const c = slider({
      id: id(key),
      label,
      min: 0,
      max: 100,
      value: Math.round(prefs.get()[key] * 100),
      format: (v) => volumeText(v / 100),
      rowClass: 'audio-row audio-volume',
      onInput: (v) => prefs.set({ [key]: v / 100 }),
    });
    const reset = el('button', { type: 'button', class: 'ui-mini audio-reset', text: 'Reset', 'aria-label': `Reset ${label.toLowerCase()}` });
    reset.addEventListener('click', () => prefs.set({ [key]: DEFAULT_PREFS[key] }));
    c.row.append(reset);
    return {
      key,
      input: c.input,
      row: c.row,
      sync: (p) => {
        // Not while the player drags it: the value is already the one set.
        if (Number(c.input.value) !== Math.round(p[key] * 100)) c.set(Math.round(p[key] * 100));
        else syncSliderFill(c.input);
        reset.disabled = p[key] === DEFAULT_PREFS[key];
      },
    };
  });

  const speech = check('speech', 'Speak unit replies and announcements', { disabled: !audio.speech.available });
  const speechNote = el('p', {
    class: 'audio-note',
    text: audio.speech.available
      ? 'Spoken lines use the voices of your system, so they sound different on every device.'
      : 'This browser has no speech synthesis: you hear radio blips and announcer chimes instead.',
  });
  const original = check('original', 'Use installed original sounds');
  const cashTicks = check('cashTicks', 'Cash ticks');
  const clickSounds = check('clickSounds', 'Interface clicks');

  const testFx = el('button', { type: 'button', text: 'Test effects' });
  testFx.addEventListener('click', () => audio.test('effects'));
  const testVoice = el('button', { type: 'button', text: 'Test announcer' });
  testVoice.addEventListener('click', () => audio.test('voices'));

  // ---- Music --------------------------------------------------------------------
  const musicOn = check('musicOn', 'Music on');
  const menuMusic = check('menuMusic', 'Main menu music');
  const shuffle = check('musicShuffle', 'Shuffle');
  // Repeat: an exclusive choice, so a segmented control.
  const repeat = segmented({
    name: id('musicRepeat'),
    label: 'Repeat',
    value: prefs.get().musicRepeat,
    options: Object.entries(REPEAT_SHORT).map(([value, label]) => ({ value, label, title: REPEAT_LABELS[value] })),
    onChange: (v) => prefs.set({ musicRepeat: v }),
  });
  const repeatRow = el('div', { class: 'ui-row ui-row-choice audio-row' }, el('span', { class: 'ui-label', text: 'Repeat' }), repeat.root);
  const nowPlaying = el('p', { class: 'audio-note audio-now', role: 'status', 'aria-live': 'polite' });
  const nextTrack = el('button', { type: 'button', text: 'Next track' });
  nextTrack.addEventListener('click', () => audio.nextTrack());
  const musicPlayer = el('button', { type: 'button', text: 'Music player...' });
  musicPlayer.hidden = !opts.onMusicPlayer;
  musicPlayer.addEventListener('click', () => opts.onMusicPlayer?.());
  const musicContent = el('button', { type: 'button', text: 'Original content...' });
  musicContent.addEventListener('click', () => opts.onContent?.());
  const musicControls = el('div', { class: 'audio-music-controls' }, musicOn.row, menuMusic.row, shuffle.row, repeatRow);
  const syncMusic = () => {
    const p = prefs.get();
    const box = audio.jukebox;
    nowPlaying.textContent = musicText(audio);
    musicControls.hidden = !box.available;
    nextTrack.hidden = !box.available;
    nextTrack.disabled = !(box.playing || (box.finished && audio.musicWanted()));
    musicContent.hidden = box.available || !opts.onContent;
    repeat.set(p.musicRepeat);
  };

  // ---- Original content -------------------------------------------------------
  const status = el('p', { class: 'audio-status', role: 'status', 'aria-live': 'polite' });
  const openContent = el('button', { type: 'button', class: 'primary', text: 'Original content...' });
  openContent.hidden = !opts.onContent;
  openContent.addEventListener('click', () => opts.onContent?.());

  let disposed = false;
  const refresh = async () => {
    try {
      const store = await audio.store();
      const text = summaryText(await installedSummary(store));
      if (disposed) return;
      status.textContent = text;
      if (audio.storeError) status.textContent += ` (Browser storage is unavailable: ${audio.storeError}. Installed content lasts until you leave this page.)`;
    } catch (err) {
      if (!disposed) status.textContent = `Could not read installed content: ${err.message ?? err}`;
    }
  };

  const checks = [enabled, speech, cashTicks, clickSounds, original, musicOn, menuMusic, shuffle];
  const sync = (p) => {
    for (const c of [...checks, ...sliders]) c.sync(p);
    syncMusic();
  };
  const offs = [
    prefs.subscribe(sync),
    audio.onChange(() => {
      syncMusic();
      refresh();
    }),
  ];

  if (opts.help) {
    for (const s of sliders) labelWithHelp(s.row, `audio.${s.key}`, s.input);
    for (const c of [speech, cashTicks, clickSounds, original, musicOn, menuMusic, shuffle]) labelWithHelp(c.row, `audio.${c.key}`, c.input);
    labelWithHelp(repeatRow, 'audio.musicRepeat', repeat.root);
  }

  root.replaceChildren(
    enabled.row,
    ...sliders.map((s) => s.row),
    speech.row,
    speechNote,
    cashTicks.row,
    clickSounds.row,
    el('div', { class: 'audio-buttons' }, testFx, testVoice),
    el(
      'section',
      { class: 'audio-music', 'aria-labelledby': id('music-title') },
      el(h, { id: id('music-title'), text: 'Music' }),
      musicControls,
      nowPlaying,
      el('div', { class: 'audio-buttons' }, musicPlayer, nextTrack, musicContent),
    ),
    el(
      'section',
      { class: 'audio-content', 'aria-labelledby': id('content-title') },
      el(h, { id: id('content-title'), text: 'Original Red Alert content' }),
      el('p', {
        class: 'audio-note',
        text: 'WebRA ships only its own sounds. If you have Red Alert (Electronic Arts released it as freeware in 2008), install its original sounds, voices and music, and its graphics, from your own copy in the Original content dialog. Texture packs can bring sounds too.',
      }),
      original.row,
      status,
      el('div', { class: 'audio-buttons' }, openContent),
    ),
  );
  sync(prefs.get());
  refresh();
  return {
    dispose() {
      disposed = true;
      for (const off of offs) off();
    },
  };
}

/**
 * The Sound button and its dialog (index.html: #audio-button, #audio-panel).
 */
export function mountAudioPanel(button, panel, audio, opts = {}) {
  const body = el('div', { class: 'audio-body' });
  const close = el('button', { type: 'button', class: 'audio-close', 'aria-label': 'Close sound settings', text: 'Close' });
  const card = el(
    'div',
    { class: 'menu-card audio-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'audio-title' },
    el('div', { class: 'audio-head' }, el('h1', { id: 'audio-title', text: 'Sound' }), close),
    body,
  );
  panel.replaceChildren(card);
  mountAudioSettings(body, audio, {
    onContent: opts.onContent
      ? () => {
          open(false);
          opts.onContent();
        }
      : undefined,
    onMusicPlayer: opts.onMusicPlayer
      ? () => {
          open(false);
          opts.onMusicPlayer();
        }
      : undefined,
  });
  function open(on) {
    panel.hidden = !on;
    button.setAttribute('aria-expanded', String(on));
    if (on) close.focus();
    else button.focus();
  }
  button.hidden = false;
  button.addEventListener('click', () => open(panel.hidden));
  close.addEventListener('click', () => open(false));
  panel.addEventListener('pointerdown', (e) => {
    if (e.target === panel) open(false);
  });
  // Keys typed in the dialog (Escape closes it) do not reach the game.
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') open(false);
    e.stopPropagation();
  });
  return { open: () => open(true) };
}

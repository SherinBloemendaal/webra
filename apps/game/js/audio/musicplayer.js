// Music player, like OpenRA's (mods/common/chrome/musicplayer.yaml): the
// installed tracks with their lengths, the playing one highlighted with its
// elapsed time, play, pause, stop, previous and next, shuffle, repeat and the
// music volume. It drives the Jukebox (music.js) through the audio system
// (index.js) and keeps its settings in the registry (audio.musicShuffle,
// musicRepeat, music), so they follow the account like every other setting.
//
// One component for the Music dialog (index.html #music-panel, opened from
// the Sound dialog on the start screen) and the game menu's Music page
// (js/gamemenu.js). Without installed music it explains where music comes
// from (catalog.js MUSIC_SOURCE_HINT).

import { installedSummary } from './install.js';
import { MUSIC_SOURCE_HINT } from './catalog.js';
import { GROUPS } from '../registry.js';
import { segmented, slider, syncSliderFill, toggle } from '../ui/controls.js';

/** Milliseconds between two updates of the elapsed time. */
export const TIME_UPDATE_MS = 250;

/** Repeat choices (registry audio.musicRepeat): short names, the long ones as tooltips. */
const REPEAT_SHORT = { all: 'All', one: 'One', off: 'Off' };
const REPEAT_LABELS = GROUPS.audio.settings.musicRepeat.labels;

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

/** Seconds as "m:ss" (OpenRA's music player shows lengths the same way); "--:--" while unknown. */
export function formatTime(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '--:--';
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * What the player says about the music: the playing or paused track, or why
 * nothing plays.
 * @param {import('./index.js').AudioSystem} audio
 * @returns {string}
 */
export function playerStatus(audio) {
  const p = audio.prefs.get();
  const j = audio.jukebox;
  const track = j.tracks[j.paused?.index ?? j.current];
  if (j.playing) return `Now playing: ${j.playing}`;
  if (j.paused && track) return `Paused: ${track.title}`;
  if (!p.enabled) return 'Sound is off: switch it on in the Sound settings to hear music.';
  if (p.music <= 0) return 'The music volume is at 0%.';
  if (audio.pendingTrack !== null && j.tracks[audio.pendingTrack]) return `Starting: ${j.tracks[audio.pendingTrack].title}`;
  if (j.finished) return 'The playlist has ended. Pick a track or press Play to start again.';
  return 'Stopped. Pick a track or press Play.';
}

/**
 * Build the music player into `root`.
 * @param {HTMLElement} root
 * @param {import('./index.js').AudioSystem} audio
 * @param {{ idPrefix?: string, heading?: number, onContent?(): void }} [opts]
 *   idPrefix keeps element ids unique when the player is on the page twice;
 *   heading is the level of its section titles; onContent opens the Original
 *   content dialog (shown when no music is installed)
 * @returns {{ dispose(): void, refresh(): Promise<void> }}
 */
export function mountMusicPlayer(root, audio, opts = {}) {
  const id = (name) => `${opts.idPrefix ?? 'music'}-${name}`;
  const h = `h${opts.heading ?? 2}`;
  const prefs = audio.prefs;
  const j = audio.jukebox;
  root.classList.add('music-player');

  // ---- Now playing --------------------------------------------------------------
  const status = el('p', { class: 'music-status', role: 'status', 'aria-live': 'polite' });
  const time = el('span', { class: 'music-time', id: id('time') });
  const bar = el('span', { class: 'music-bar-fill' });
  const progress = el('div', { class: 'music-bar', 'aria-hidden': 'true' }, bar);
  const now = el('div', { class: 'music-now' }, status, el('div', { class: 'music-clock' }, progress, time));

  // ---- Transport ------------------------------------------------------------------
  const button = (text, label, onClick) => {
    const b = el('button', { type: 'button', text, 'aria-label': label, title: label });
    b.addEventListener('click', onClick);
    return b;
  };
  const prev = button('Previous', 'Previous track', () => audio.skipTrack(-1));
  const play = button('Play', 'Play', () => audio.playPause());
  const stop = button('Stop', 'Stop', () => audio.stopMusic());
  const next = button('Next', 'Next track', () => audio.skipTrack(1));
  const transport = el('div', { class: 'music-transport', role: 'group', 'aria-label': 'Playback' }, prev, play, stop, next);

  // ---- Tracks ------------------------------------------------------------------------
  const list = el('ol', { class: 'music-tracks', id: id('tracks'), 'aria-label': 'Tracks' });
  let listed = null; // the jukebox track array the list shows
  let rows = [];
  const buildList = () => {
    listed = j.tracks;
    rows = j.tracks.map((track, i) => {
      const title = el('span', { class: 'music-track-title', text: track.title });
      const length = el('span', { class: 'music-track-length' });
      const b = el('button', { type: 'button', class: 'music-track', 'aria-describedby': id('time') }, title, length);
      b.addEventListener('click', () => audio.playTrack(i));
      return { item: el('li', {}, b), button: b, length, track };
    });
    list.replaceChildren(...rows.map((r) => r.item));
  };

  // ---- Options ------------------------------------------------------------------------
  const shuffle = toggle({ id: id('shuffle'), label: 'Shuffle', rowClass: 'music-row', onChange: (on) => prefs.set({ musicShuffle: on }) });
  const repeat = segmented({
    name: id('repeat'),
    label: 'Repeat',
    value: prefs.get().musicRepeat,
    options: Object.entries(REPEAT_SHORT).map(([value, label]) => ({ value, label, title: REPEAT_LABELS[value] })),
    onChange: (v) => prefs.set({ musicRepeat: v }),
  });
  const repeatRow = el('div', { class: 'ui-row ui-row-choice music-row' }, el('span', { class: 'ui-label', text: 'Repeat' }), repeat.root);
  const volume = slider({
    id: id('volume'),
    label: 'Music volume',
    min: 0,
    max: 100,
    value: Math.round(prefs.get().music * 100),
    format: (v) => `${v}%`,
    rowClass: 'music-row',
    onInput: (v) => prefs.set({ music: v / 100 }),
  });
  const options = el('div', { class: 'music-options' }, shuffle.row, repeatRow, volume.row);

  // ---- No music ----------------------------------------------------------------------------
  const emptyText = el('p', { class: 'audio-note music-empty-text' });
  const useOriginals = el('button', { type: 'button', text: 'Use installed original sounds' });
  useOriginals.addEventListener('click', () => prefs.set({ original: true }));
  const openContent = el('button', { type: 'button', class: 'primary', text: 'Original content...' });
  openContent.addEventListener('click', () => opts.onContent?.());
  openContent.hidden = !opts.onContent;
  const empty = el(
    'div',
    { class: 'music-empty' },
    emptyText,
    el('p', { class: 'audio-note', text: MUSIC_SOURCE_HINT }),
    el('div', { class: 'audio-buttons' }, useOriginals, openContent),
  );
  let installedTracks = 0;

  const playerPart = el(
    'div',
    { class: 'music-main' },
    now,
    transport,
    el('section', { class: 'music-list', 'aria-labelledby': id('tracks-title') }, el(h, { id: id('tracks-title'), text: 'Tracks' }), list),
    options,
  );

  // ---- Keeping in step ---------------------------------------------------------------------------
  const syncTime = () => {
    const index = j.paused?.index ?? j.current;
    const length = j.playing || j.paused ? j.length(index) : null;
    const elapsed = j.playing || j.paused ? j.elapsed() : null;
    time.textContent = j.playing || j.paused ? `${formatTime(elapsed)} / ${formatTime(length)}` : '';
    const share = length ? Math.max(0, Math.min(1, elapsed / length)) : 0;
    bar.style.setProperty('--music-progress', `${(share * 100).toFixed(2)}%`);
  };

  const syncTracks = () => {
    if (listed !== j.tracks) buildList();
    const current = j.playing || j.paused || audio.pendingTrack !== null ? (audio.pendingTrack ?? j.paused?.index ?? j.current) : -1;
    rows.forEach((r, i) => {
      const on = i === current;
      r.button.classList.toggle('current', on);
      if (on) r.button.setAttribute('aria-current', 'true');
      else r.button.removeAttribute('aria-current');
      r.button.setAttribute('aria-label', `${on && j.playing ? 'Playing' : 'Play'} ${r.track.title}`);
      r.length.textContent = formatTime(j.lengths.get(r.track.file));
    });
  };

  const sync = () => {
    const p = prefs.get();
    const have = j.available;
    playerPart.hidden = !have;
    empty.hidden = have;
    if (!have) {
      emptyText.textContent =
        installedTracks && !p.original
          ? `${installedTracks === 1 ? 'One music track is' : `${installedTracks} music tracks are`} installed, but "Use installed original sounds" is off.`
          : 'No music installed.';
      useOriginals.hidden = !(installedTracks && !p.original);
    }
    status.textContent = playerStatus(audio);
    play.textContent = j.playing ? 'Pause' : j.paused ? 'Resume' : 'Play';
    play.setAttribute('aria-label', play.textContent);
    play.setAttribute('title', play.textContent);
    stop.disabled = !(j.playing || j.paused || audio.pendingTrack !== null);
    prev.disabled = next.disabled = !have;
    shuffle.set(p.musicShuffle);
    repeat.set(p.musicRepeat);
    if (Number(volume.input.value) !== Math.round(p.music * 100)) volume.set(Math.round(p.music * 100));
    else syncSliderFill(volume.input);
    syncTracks();
    syncTime();
  };

  // Track lengths come from the files (or texture pack tracks), once.
  let measuring = null;
  let disposed = false;
  const measure = () => {
    if (measuring || !j.available) return measuring;
    measuring = j
      .measure()
      .catch(() => false)
      .then((found) => {
        measuring = null;
        if (found && !disposed) syncTracks();
      });
    return measuring;
  };

  // How many tracks are installed, for the message when the playlist is empty.
  const refresh = async () => {
    try {
      installedTracks = (await installedSummary(await audio.store())).byCategory.music;
    } catch {
      installedTracks = 0;
    }
    if (disposed) return;
    sync();
    await measure();
  };

  const offs = [
    prefs.subscribe(sync),
    audio.onChange(() => {
      sync();
      measure();
      if (!j.available) refresh();
    }),
  ];
  const timer = setInterval(() => {
    if (j.playing) syncTime();
  }, TIME_UPDATE_MS);
  timer.unref?.();

  root.replaceChildren(playerPart, empty);
  sync();
  const ready = refresh();
  return {
    refresh: () => ready.then(refresh),
    dispose() {
      disposed = true;
      clearInterval(timer);
      for (const off of offs) off();
    },
  };
}

/**
 * The Music dialog (index.html #music-panel), opened from the Sound dialog.
 * @param {HTMLElement} panel
 * @param {import('./index.js').AudioSystem} audio
 * @param {{ onContent?(): void }} [opts]
 * @returns {{ open(opener?: HTMLElement): void, close(): void, isOpen(): boolean }}
 */
export function mountMusicPanel(panel, audio, opts = {}) {
  const body = el('div', { class: 'music-body' });
  const close = el('button', { type: 'button', class: 'audio-close', 'aria-label': 'Close the music player', text: 'Close' });
  const card = el(
    'div',
    { class: 'menu-card audio-card music-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'music-title' },
    el('div', { class: 'audio-head' }, el('h1', { id: 'music-title', text: 'Music' }), close),
    body,
  );
  panel.replaceChildren(card);
  panel.hidden = true;
  let player = null;
  let opener = null;
  const shut = () => {
    if (panel.hidden) return;
    panel.hidden = true;
    player?.dispose();
    player = null;
    opener?.focus?.();
    opener = null;
  };
  close.addEventListener('click', shut);
  panel.addEventListener('pointerdown', (e) => {
    if (e.target === panel) shut();
  });
  // Keys typed in the dialog (Escape closes it) do not reach the game.
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') shut();
    e.stopPropagation();
  });
  return {
    open(from = null) {
      opener = from ?? document.activeElement;
      if (!player) {
        player = mountMusicPlayer(body, audio, {
          idPrefix: 'music',
          heading: 2,
          onContent: opts.onContent
            ? () => {
                shut();
                opts.onContent();
              }
            : undefined,
        });
      }
      panel.hidden = false;
      close.focus();
    },
    close: shut,
    isOpen: () => !panel.hidden,
  };
}

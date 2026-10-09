// Sound settings. Opened by the Sound button (index.html); `mountAudioSettings`
// can also be placed in another settings screen. Installing the original Red
// Alert content (sounds and graphics in one flow) lives in the Original
// content dialog (js/content/panel.js), which `opts.onContent` opens.

import { installedSummary } from './install.js';
import { slider, toggle } from '../ui/controls.js';

const VOLUMES = [
  ['master', 'Master volume'],
  ['effects', 'Effects'],
  ['voices', 'Voices and announcer'],
  ['music', 'Music (installed original content only)'],
];

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

function summaryText(s) {
  if (!s.total) return 'No original sounds installed. WebRA plays its own synthesized sounds.';
  const b = s.byCategory;
  return `Installed on this device: ${plural(b.effects, 'effect', 'effects')}, ${plural(b.voices, 'unit voice', 'unit voices')}, ${plural(
    b.announcer,
    'announcer line',
    'announcer lines',
  )}, ${plural(b.music, 'music track', 'music tracks')}.`;
}

/**
 * Build the sound settings into `root`.
 * @param {HTMLElement} root
 * @param {import('./index.js').AudioSystem} audio
 * @param {{ onContent?(): void }} [opts] opens the Original content dialog
 */
export function mountAudioSettings(root, audio, opts = {}) {
  root.classList.add('audio-settings');
  const p = audio.prefs.get();

  const enabled = toggle({ id: 'audio-enabled', label: 'Sound on', checked: p.enabled, rowClass: 'audio-row', onChange: (on) => audio.prefs.set({ enabled: on }) });

  const sliders = VOLUMES.map(([key, label]) =>
    slider({
      id: `audio-${key}`,
      label,
      min: 0,
      max: 100,
      value: Math.round(p[key] * 100),
      format: (v) => `${v}%`,
      rowClass: 'audio-row',
      onInput: (v) => audio.prefs.set({ [key]: v / 100 }),
    }),
  );

  const speech = toggle({
    id: 'audio-speech',
    label: 'Speak unit replies and announcements',
    checked: p.speech,
    disabled: !audio.speech.available,
    rowClass: 'audio-row',
    onChange: (on) => audio.prefs.set({ speech: on }),
  });
  const speechNote = el('p', {
    class: 'audio-note',
    text: audio.speech.available
      ? 'Spoken lines use the voices of your system, so they sound different on every device.'
      : 'This browser has no speech synthesis: you hear radio blips and announcer chimes instead.',
  });

  const original = toggle({
    id: 'audio-original',
    label: 'Use installed original sounds',
    checked: p.original,
    rowClass: 'audio-row',
    onChange: (on) => audio.prefs.set({ original: on }),
  });
  // Also switched in the Original content dialog.
  audio.prefs.subscribe((v) => original.set(v.original));

  const testFx = el('button', { type: 'button', text: 'Test effects' });
  testFx.addEventListener('click', () => audio.test('effects'));
  const testVoice = el('button', { type: 'button', text: 'Test announcer' });
  testVoice.addEventListener('click', () => audio.test('voices'));

  // ---- Original content -------------------------------------------------------
  const status = el('p', { class: 'audio-status', role: 'status', 'aria-live': 'polite' });
  const openContent = el('button', { type: 'button', class: 'primary', text: 'Original content...' });
  openContent.hidden = !opts.onContent;
  openContent.addEventListener('click', () => opts.onContent?.());

  const refresh = async () => {
    try {
      const store = await audio.store();
      status.textContent = summaryText(await installedSummary(store));
      if (audio.storeError) status.textContent += ` (Browser storage is unavailable: ${audio.storeError}. Installed content lasts until you leave this page.)`;
    } catch (err) {
      status.textContent = `Could not read installed content: ${err.message ?? err}`;
    }
  };

  // ---- Music --------------------------------------------------------------------
  const nowPlaying = el('p', { class: 'audio-note' });
  const nextTrack = el('button', { type: 'button', text: 'Next track' });
  nextTrack.addEventListener('click', () => audio.jukebox.next());
  const musicRow = el('div', { class: 'audio-music' }, nowPlaying, nextTrack);
  const syncMusic = () => {
    musicRow.hidden = !audio.jukebox.available;
    nowPlaying.textContent = audio.jukebox.playing ? `Now playing: ${audio.jukebox.playing}` : `${plural(audio.jukebox.tracks.length, 'track', 'tracks')} installed; music plays during games.`;
    nextTrack.disabled = !audio.jukebox.playing;
  };
  audio.onChange(() => {
    syncMusic();
    refresh();
  });

  root.replaceChildren(
    enabled.row,
    ...sliders.map((s) => s.row),
    speech.row,
    speechNote,
    el('div', { class: 'audio-buttons' }, testFx, testVoice),
    musicRow,
    el(
      'section',
      { class: 'audio-content', 'aria-labelledby': 'audio-content-title' },
      el('h2', { id: 'audio-content-title', text: 'Original Red Alert content' }),
      el('p', {
        class: 'audio-note',
        text: 'WebRA ships only its own sounds. If you have Red Alert (Electronic Arts released it as freeware in 2008), install its original sounds, voices and music, and its graphics, from your own copy in the Original content dialog. Texture packs can bring sounds too.',
      }),
      original.row,
      status,
      el('div', { class: 'audio-buttons' }, openContent),
    ),
  );
  syncMusic();
  refresh();
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

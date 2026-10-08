// Sound settings and the "Install original Red Alert content" flow. Opened by
// the Sound button (index.html); `mountAudioSettings` can also be placed in
// another settings screen.

import { installFromFiles, installedSummary } from './install.js';

const VOLUMES = [
  ['master', 'Master volume'],
  ['effects', 'Effects'],
  ['voices', 'Voices and announcer'],
  ['music', 'Music (installed original content only)'],
];

const ACCEPT = '.mix,.aud,.v00,.v01,.v02,.v03,.r00,.r01,.r02,.r03';

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
  if (!s.total) return 'Nothing installed. WebRA plays its own synthesized sounds.';
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
 */
export function mountAudioSettings(root, audio) {
  root.classList.add('audio-settings');
  const p = audio.prefs.get();

  const enabled = el('input', { type: 'checkbox', id: 'audio-enabled' });
  enabled.checked = p.enabled;
  enabled.addEventListener('change', () => audio.prefs.set({ enabled: enabled.checked }));

  const sliders = VOLUMES.map(([key, label]) => {
    const input = el('input', { type: 'range', min: '0', max: '100', step: '1', id: `audio-${key}` });
    input.value = String(Math.round(p[key] * 100));
    const out = el('output', { for: `audio-${key}`, text: `${input.value}%` });
    input.addEventListener('input', () => {
      out.textContent = `${input.value}%`;
      audio.prefs.set({ [key]: Number(input.value) / 100 });
    });
    return el('div', { class: 'audio-row' }, el('label', { for: `audio-${key}`, text: label }), input, out);
  });

  const speech = el('input', { type: 'checkbox', id: 'audio-speech' });
  speech.checked = p.speech;
  speech.disabled = !audio.speech.available;
  speech.addEventListener('change', () => audio.prefs.set({ speech: speech.checked }));
  const speechNote = el('p', {
    class: 'audio-note',
    text: audio.speech.available
      ? 'Spoken lines use the voices of your system, so they sound different on every device.'
      : 'This browser has no speech synthesis: you hear radio blips and announcer chimes instead.',
  });

  const original = el('input', { type: 'checkbox', id: 'audio-original' });
  original.checked = p.original;
  original.addEventListener('change', () => audio.prefs.set({ original: original.checked }));

  const testFx = el('button', { type: 'button', text: 'Test effects' });
  testFx.addEventListener('click', () => audio.test('effects'));
  const testVoice = el('button', { type: 'button', text: 'Test announcer' });
  testVoice.addEventListener('click', () => audio.test('voices'));

  // ---- Original content -------------------------------------------------------
  const status = el('p', { class: 'audio-status', role: 'status', 'aria-live': 'polite' });
  const progress = el('p', { class: 'audio-progress', 'aria-live': 'polite' });
  const files = el('input', { type: 'file', multiple: true, accept: ACCEPT, hidden: true });
  const folder = el('input', { type: 'file', multiple: true, hidden: true, webkitdirectory: true });
  const pickFiles = el('button', { type: 'button', class: 'primary', text: 'Choose files...' });
  const pickFolder = el('button', { type: 'button', text: 'Choose folder...' });
  const remove = el('button', { type: 'button', class: 'danger', text: 'Remove installed content' });
  pickFiles.addEventListener('click', () => files.click());
  pickFolder.addEventListener('click', () => folder.click());

  const busy = (on) => {
    for (const b of [pickFiles, pickFolder, remove]) b.disabled = on;
  };

  const refresh = async () => {
    try {
      const store = await audio.store();
      const s = await installedSummary(store);
      status.textContent = summaryText(s);
      remove.hidden = s.total === 0;
      if (audio.storeError) status.textContent += ` (Browser storage is unavailable: ${audio.storeError}. Installed content lasts until you leave this page.)`;
    } catch (err) {
      status.textContent = `Could not read installed content: ${err.message ?? err}`;
    }
  };

  const install = async (list) => {
    if (!list.length) return;
    busy(true);
    progress.textContent = 'Reading your files in this browser...';
    try {
      const store = await audio.store();
      const r = await installFromFiles(list, store, { onProgress: (t) => (progress.textContent = t) });
      const parts = [r.added ? `Installed ${plural(r.added, 'sound', 'sounds')}.` : 'No Red Alert sounds found in these files.'];
      if (r.archives.length) parts.push(`Read ${r.archives.join(', ')}.`);
      if (r.errors.length) parts.push(`Skipped: ${r.errors.slice(0, 3).join('; ')}${r.errors.length > 3 ? '; ...' : ''}`);
      progress.textContent = parts.join(' ');
      await audio.reloadInstalled();
    } catch (err) {
      progress.textContent = `Install failed: ${err.message ?? err}`;
    } finally {
      busy(false);
      files.value = '';
      folder.value = '';
      refresh();
    }
  };
  files.addEventListener('change', () => install([...files.files]));
  folder.addEventListener('change', () => install([...folder.files]));
  remove.addEventListener('click', async () => {
    busy(true);
    try {
      await (await audio.store()).clear();
      progress.textContent = 'Removed. WebRA plays its own synthesized sounds again.';
      await audio.reloadInstalled();
    } finally {
      busy(false);
      refresh();
    }
  });

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
    el('div', { class: 'audio-row audio-check' }, enabled, el('label', { for: 'audio-enabled', text: 'Sound on' })),
    ...sliders,
    el('div', { class: 'audio-row audio-check' }, speech, el('label', { for: 'audio-speech', text: 'Speak unit replies and announcements' })),
    speechNote,
    el('div', { class: 'audio-buttons' }, testFx, testVoice),
    musicRow,
    el(
      'section',
      { class: 'audio-content', 'aria-labelledby': 'audio-content-title' },
      el('h2', { id: 'audio-content-title', text: 'Original Red Alert content' }),
      el('p', {
        class: 'audio-note',
        text:
          'WebRA ships only its own sounds. If you have Red Alert (Electronic Arts released it as freeware in 2008), you can use its original sounds, voices and music: choose main.mix and redalert.mix from your copy, or sounds.mix, allies.mix, russian.mix, speech.mix, scores.mix or loose .aud files.',
      }),
      el('p', {
        class: 'audio-local',
        text: 'Your files are read in this browser and the sounds are stored on this device only. Nothing is uploaded, and WebRA never hosts or distributes them.',
      }),
      el('div', { class: 'audio-row audio-check' }, original, el('label', { for: 'audio-original', text: 'Use installed original sounds' })),
      status,
      el('div', { class: 'audio-buttons' }, pickFiles, pickFolder, remove),
      files,
      folder,
      progress,
    ),
  );
  syncMusic();
  refresh();
}

/**
 * The Sound button and its dialog (index.html: #audio-button, #audio-panel).
 */
export function mountAudioPanel(button, panel, audio) {
  const body = el('div', { class: 'audio-body' });
  const close = el('button', { type: 'button', class: 'audio-close', 'aria-label': 'Close sound settings', text: 'Close' });
  const card = el(
    'div',
    { class: 'menu-card audio-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'audio-title' },
    el('div', { class: 'audio-head' }, el('h1', { id: 'audio-title', text: 'Sound' }), close),
    body,
  );
  panel.replaceChildren(card);
  mountAudioSettings(body, audio);
  const open = (on) => {
    panel.hidden = !on;
    button.setAttribute('aria-expanded', String(on));
    if (on) close.focus();
    else button.focus();
  };
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
}

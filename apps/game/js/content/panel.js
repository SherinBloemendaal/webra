// Original Red Alert content: the "Original content" dialog (lobby button,
// game menu, Sound dialog) and the start screen notice.
//
// The dialog: the graphics and sounds choice; installing the original
// content (sounds and graphics in one flow) in three steps (download
// ra-quickinstall.zip from a mirror, drop or pick it, done) with live
// progress and a summary; the one-click download through WebRA's server
// for accounts allowed to use it (content/download.js canAutoInstall),
// with the music from the freeware CDs (content/cdmusic.js) next to it;
// other ways (a freeware CD image, own Red Alert files, a folder); the
// texture pack manager.
//
// The notice: a dismissible card on the start screen (dismissal is a synced
// setting) with the same steps, shown until something is installed.
//
// Text from files and the server only ever goes in through textContent.

import { GRAPHICS_SETTING } from './index.js';
import { segmented, toggle } from '../ui/controls.js';
import { packSummary, PackError } from './packs.js';
import { MUSIC_SOURCE_HINT } from '../audio/catalog.js';
import {
  downloadQuickInstall,
  dismissNotice,
  DOWNLOAD_NOTICE,
  LEGAL_NOTICE,
  QUICKINSTALL_BYTES,
  QUICKINSTALL_MIRRORS,
} from './download.js';
import { CancelledError, downloadScores, forgetScoresDownload, FREEWARE_CDS, MUSIC_NOTICE, SCORES_BYTES } from './cdmusic.js';

export { QUICKINSTALL_MIRRORS };

const ACCEPT_CONTENT = '.zip,.iso,.mix,.aud,.v00,.v01,.v02,.v03,.r00,.r01,.r02,.r03,.shp,.pal,.tem,.sno,.des,.vqa';
const ACCEPT_PACK = '.webrapack,.zip';
/** Largest pack file read for the preview (content/packs.js PACK_LIMITS.maxArchiveBytes). */
const MAX_PACK_FILE = 64 * 1024 * 1024;
/** Red Alert files the installer takes besides ZIPs. */
const CONTENT_FILE = /\.(iso|mix|aud|v0\d|r0\d|shp|pal|tem|sno|des|vqa)$/i;

const THEATER_NAMES = { TEMPERAT: 'temperate', SNOW: 'snow', DESERT: 'desert (from Tiberian Dawn)' };

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v !== null && v !== undefined) e.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined) e.append(c);
  return e;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** "3.4 MB" */
export function formatBytes(n) {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Whether this device is mainly touch (no drag and drop of files: the file picker instead). */
export function isTouchDevice(win = globalThis.window) {
  try {
    return !!win?.matchMedia?.('(pointer: coarse)').matches && !win.matchMedia('(pointer: fine)').matches;
  } catch {
    return false;
  }
}

/** Whether the browser can pick whole folders (desktop Chrome, Edge, Firefox, Safari; not phones). */
export function canPickFolder(doc = globalThis.document) {
  try {
    return 'webkitdirectory' in doc.createElement('input') && !isTouchDevice();
  } catch {
    return false;
  }
}

/** Whether music is installed, and where it comes from when it is not (catalog.js MUSIC_SOURCE_HINT). */
export function musicText(tracks) {
  return tracks ? `Music: ${plural(tracks, 'track', 'tracks')}.` : `Music: none. ${MUSIC_SOURCE_HINT}`;
}

/** Movie names for the player ("landing.vqa", ...: "landing, prolog and 3 more"). */
export function movieList(names, shown = 8) {
  const bare = names.map((n) => n.replace(/\.vqa$/i, ''));
  if (bare.length <= shown) return bare.length > 1 ? `${bare.slice(0, -1).join(', ')} and ${bare.at(-1)}` : (bare[0] ?? '');
  return `${bare.slice(0, shown).join(', ')} and ${bare.length - shown} more`;
}

/** Whether movies are installed, and where they come from when they are not. */
export function moviesText(count, bytes = 0) {
  return count
    ? `Movies: ${plural(count, 'movie', 'movies')} (${formatBytes(bytes)}); missions play them full screen.`
    : 'Movies: none; missions show a card instead (they come from movies1.mix and movies2.mix on the Allied and Soviet CDs, not in ra-quickinstall.zip).';
}

/** The installed summary as text (content/install.js contentSummary). */
export function summaryText(s) {
  if (!s.total) return `Nothing installed yet. WebRA uses its own art and synthesized sounds. ${musicText(0)}`;
  const b = s.byCategory;
  const parts = [];
  const sounds = b.effects + b.voices + b.announcer;
  if (sounds) {
    parts.push(
      `Sounds: ${plural(b.effects, 'effect', 'effects')}, ${plural(b.voices, 'unit voice', 'unit voices')}, ${plural(b.announcer, 'announcer line', 'announcer lines')} (${formatBytes(s.bytes.sounds)}).`,
    );
  } else {
    parts.push('Sounds: none (they come from sounds.mix, allies.mix, russian.mix and speech.mix, all in ra-quickinstall.zip).');
  }
  parts.push(musicText(b.music));
  if (b.graphics) {
    const theaters = s.theaters.length ? s.theaters.map((t) => THEATER_NAMES[t] ?? t.toLowerCase()).join(', ') : 'none';
    parts.push(`Graphics: ${plural(b.graphics, 'file', 'files')} (${formatBytes(s.bytes.graphics)}); terrain for ${theaters}.`);
    if (s.palette === false) parts.push('The graphics cannot be used yet: the palette from temperat.mix is missing. Install ra-quickinstall.zip or main.mix to complete them.');
  } else {
    parts.push('Graphics: none (they come from conquer.mix, hires.mix and the theater archives, all in ra-quickinstall.zip).');
  }
  parts.push(moviesText(b.movies ?? 0, s.bytes?.movies ?? 0));
  return `Installed on this device. ${parts.join(' ')}`;
}

/** The outcome of one install as short lines for the result card (content/install.js report). */
export function installResultLines(r) {
  const lines = [];
  if (!r.added) lines.push('No Red Alert sounds or graphics were found in these files. Use ra-quickinstall.zip from one of the mirrors.');
  else {
    const b = r.byCategory;
    const sounds = b.effects + b.voices + b.announcer + b.music;
    lines.push(`Installed ${plural(r.added, 'file', 'files')} (${formatBytes(r.bytes)}).`);
    if (sounds) lines.push(`Sounds: ${plural(b.effects, 'effect', 'effects')}, ${plural(b.voices, 'voice', 'voices')}, ${plural(b.announcer, 'announcer line', 'announcer lines')}, ${plural(b.music, 'music track', 'music tracks')}.`);
    if (b.graphics) {
      const theaters = r.theaters?.length ? r.theaters.map((t) => THEATER_NAMES[t] ?? t.toLowerCase()).join(', ') : 'none';
      lines.push(`Graphics: ${plural(b.graphics, 'file', 'files')}; terrain for ${theaters}.`);
    }
    if (r.movies?.length) lines.push(`Movies: ${movieList(r.movies)}.`);
    if (r.switched) lines.push('The game now uses the original graphics. You can switch back below or under Use.');
  }
  if (r.errors?.length) lines.push(`Skipped: ${r.errors.slice(0, 3).join('; ')}${r.errors.length > 3 ? '; ...' : ''}`);
  return lines;
}

/** Split dropped or picked files: texture packs, Red Alert content, and the rest. */
export async function classifyFiles(files, isPack = isPackZip) {
  const packs = [];
  const content = [];
  const other = [];
  for (const f of files) {
    const name = f.name ?? '';
    if (/\.webrapack$/i.test(name)) packs.push(f);
    else if (/\.zip$/i.test(name)) {
      // A ZIP with a manifest.json is a pack; any other ZIP goes to the installer.
      if (await isPack(new Uint8Array(await f.arrayBuffer()))) packs.push(f);
      else content.push(f);
    } else if (CONTENT_FILE.test(name)) content.push(f);
    else other.push(f);
  }
  return { packs, content, other };
}

/** The mirror links of ra-quickinstall.zip (plain links, opened in a new tab). */
function mirrorList() {
  return el(
    'ul',
    { class: 'content-mirrors' },
    ...QUICKINSTALL_MIRRORS.map((url) =>
      el('li', {}, el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', download: 'ra-quickinstall.zip', text: new URL(url).hostname })),
    ),
  );
}

/** The freeware CD images (plain links to the Internet Archive). */
function cdList() {
  return el(
    'ul',
    { class: 'content-cds' },
    ...FREEWARE_CDS.map((cd) => el('li', {}, el('a', { href: cd.url, target: '_blank', rel: 'noopener noreferrer', text: `${cd.label} (ISO, ${formatBytes(cd.bytes)})` }))),
  );
}

/** Step 1, the same in the dialog and the notice. */
function stepDownload() {
  return el(
    'li',
    {},
    el('strong', { text: 'Download ra-quickinstall.zip' }),
    el('span', { text: ` (${formatBytes(QUICKINSTALL_BYTES)}, the same file on every mirror) from one of these mirrors:` }),
    mirrorList(),
  );
}

/**
 * Build the dialog body into `root`.
 * @param {HTMLElement} root
 * @param {import('./index.js').ContentSystem} content
 * @param {import('../audio/index.js').AudioSystem | null} audio
 * @param {{ actorNames?: Map<string, string>, autoInstall?: boolean, fetchImpl?: typeof fetch }} [opts]
 *   autoInstall: offer the one-click download (content/download.js canAutoInstall)
 */
export function mountContentSettings(root, content, audio, opts = {}) {
  root.classList.add('audio-settings', 'content-settings');
  const settings = content.settings;
  const touch = isTouchDevice();
  let running = false;

  // ---- Use ------------------------------------------------------------------------------
  // Two exclusive choices drawn as segmented controls: WebRA's own art and
  // sounds, or the installed originals. "Original" stays off until it exists.
  const graphicsNote = el('p', { class: 'audio-note', id: 'content-graphics-note' });
  const soundsNote = el('p', { class: 'audio-note', id: 'content-sounds-note' });
  const ORIGINAL_NOT_INSTALLED = 'Install the original content below to use this.';
  const graphics = segmented({
    name: 'content-graphics',
    label: 'Graphics',
    describedBy: graphicsNote.id,
    options: [
      { value: 'webra', label: 'WebRA' },
      { value: 'original', label: 'Original' },
    ],
    value: content.graphics,
    onChange: (value) => settings.set(GRAPHICS_SETTING, value),
  });
  const sounds = segmented({
    name: 'content-sounds',
    label: 'Sounds',
    describedBy: soundsNote.id,
    disabled: !audio,
    options: [
      { value: 'webra', label: 'WebRA' },
      { value: 'original', label: 'Original' },
    ],
    value: audio?.prefs.get().original ? 'original' : 'webra',
    onChange: (value) => audio?.prefs.set({ original: value === 'original' }),
  });
  const choiceRow = (text, group) => el('div', { class: 'ui-row ui-row-choice' }, el('span', { class: 'ui-label', text }), group.root);

  // ---- Install --------------------------------------------------------------------------
  const status = el('p', { class: 'audio-status', role: 'status', 'aria-live': 'polite' });
  const files = el('input', { type: 'file', multiple: true, accept: ACCEPT_CONTENT, hidden: true, 'aria-hidden': 'true', tabindex: '-1' });
  const folder = el('input', { type: 'file', multiple: true, hidden: true, webkitdirectory: true, 'aria-hidden': 'true', tabindex: '-1' });
  const pickFiles = el('button', { type: 'button', text: 'Choose Red Alert files...' });
  const pickFolder = el('button', { type: 'button', text: 'Choose folder...' });
  pickFolder.hidden = !canPickFolder();
  const remove = el('button', { type: 'button', class: 'danger', text: 'Remove installed content' });
  pickFiles.addEventListener('click', () => files.click());
  pickFolder.addEventListener('click', () => folder.click());

  const dropzone = el(
    'button',
    { type: 'button', class: 'content-dropzone', 'aria-describedby': 'content-drop-help' },
    el('span', { class: 'content-dropzone-title', text: touch ? 'Choose ra-quickinstall.zip' : 'Drop ra-quickinstall.zip here' }),
    el('span', { class: 'content-dropzone-sub', id: 'content-drop-help', text: touch ? 'Tap to pick the file you downloaded.' : 'or click to choose the file you downloaded.' }),
  );
  dropzone.addEventListener('click', () => files.click());
  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  dropzone.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dropzone.classList.add('over');
  });
  dropzone.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('over'));
  dropzone.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    // Handled here: the page's own drop handler (main.js) must not install the files again.
    e.stopPropagation();
    dropzone.classList.remove('over');
    globalThis.document?.body?.classList.remove('content-drop');
    handleFiles([...(e.dataTransfer.files ?? [])]);
  });

  // Live progress: a bar (with a value while downloading) and a line of text.
  const bar = el('progress', { class: 'content-bar', max: '1', 'aria-label': 'Install progress' });
  const progressText = el('p', { class: 'audio-progress', role: 'status', 'aria-live': 'polite' });
  const progressBox = el('div', { class: 'content-progress', hidden: true }, bar, progressText);
  const showProgress = (text, fraction = null) => {
    progressBox.hidden = false;
    progressText.textContent = text;
    if (fraction === null) bar.removeAttribute('value');
    else bar.value = Math.max(0, Math.min(1, fraction));
  };
  const hideProgress = () => {
    progressBox.hidden = true;
  };

  // The result of the last install: what came in, and the switch to use it.
  const resultTitle = el('h3', { id: 'content-result-title', text: 'Installed' });
  const resultLines = el('div', { class: 'content-result-lines' });
  const useAllControl = toggle({
    id: 'content-use-all',
    label: 'Use the original graphics and sounds',
    rowClass: 'audio-row',
    onChange: (on) => {
      settings.set(GRAPHICS_SETTING, on && content.hasOriginalGraphics ? 'original' : 'webra');
      audio?.prefs.set({ original: on });
    },
  });
  const useAll = useAllControl.input;
  const useAllRow = useAllControl.row;
  const result = el('div', { class: 'content-result', role: 'region', 'aria-labelledby': 'content-result-title', hidden: true }, resultTitle, resultLines, useAllRow);
  const showResult = (title, lines, ok) => {
    resultTitle.textContent = title;
    resultLines.replaceChildren(...lines.map((t) => el('p', { class: 'audio-note', text: t })));
    result.classList.toggle('content-result-error', !ok);
    useAllRow.hidden = !ok;
    result.hidden = false;
  };

  // The one-click download, only for accounts allowed to use it.
  const download = el('button', { type: 'button', class: 'primary', text: `Download and install (${formatBytes(QUICKINSTALL_BYTES)})` });
  // The music is not in that package: it comes from the freeware CDs, by range (content/cdmusic.js).
  const MUSIC_LABEL = `Music (from the freeware Red Alert CDs, ${formatBytes(SCORES_BYTES)})`;
  const music = el('button', { type: 'button', text: MUSIC_LABEL });
  const cancelMusic = el('button', { type: 'button', text: 'Cancel', hidden: true });
  const autoBox = el(
    'div',
    { class: 'content-auto', hidden: !opts.autoInstall },
    el('p', { class: 'audio-note', text: 'Your account may use the one-click install:' }),
    el('div', { class: 'audio-buttons' }, download, music, cancelMusic),
    el('p', { class: 'audio-note', text: DOWNLOAD_NOTICE }),
    el('p', { class: 'audio-note', text: MUSIC_NOTICE }),
  );

  // ---- Packs ----------------------------------------------------------------------------
  const packFile = el('input', { type: 'file', accept: ACCEPT_PACK, hidden: true, 'aria-hidden': 'true', tabindex: '-1' });
  const pickPack = el('button', { type: 'button', text: 'Install texture pack...' });
  pickPack.addEventListener('click', () => packFile.click());
  const packList = el('ul', { class: 'content-packs' });
  const preview = el('div', { class: 'content-preview', hidden: true });
  const packStatus = el('p', { class: 'audio-progress', 'aria-live': 'polite' });

  const busy = (on) => {
    running = on;
    for (const b of [pickFiles, pickFolder, remove, pickPack, download, music, dropzone]) b.disabled = on;
    root.setAttribute('aria-busy', String(on));
  };

  const sync = async () => {
    graphics.set(content.graphics);
    graphics.setDisabled('original', !content.hasOriginalGraphics);
    graphics.setTitle('original', content.hasOriginalGraphics ? '' : ORIGINAL_NOT_INSTALLED);
    graphicsNote.textContent = content.hasOriginalGraphics
      ? 'Original graphics: units, structures, infantry animations, cameos and terrain from your files. Effects keep WebRA art. The choice applies at once, also in a running game.'
      : 'Original is off until the original content is installed: install it below to use the original graphics.';
    sounds.set(audio?.prefs.get().original ? 'original' : 'webra');
    useAll.checked = content.graphics === 'original' && !!audio?.prefs.get().original;
    try {
      const s = await content.summary();
      const haveSounds = s.byCategory.effects + s.byCategory.voices + s.byCategory.announcer + s.byCategory.music > 0;
      // A chosen "Original" stays selectable so the group never shows a state it cannot leave.
      sounds.setDisabled('original', !audio || (!haveSounds && !audio.prefs.get().original));
      sounds.setTitle('original', haveSounds ? '' : ORIGINAL_NOT_INSTALLED);
      soundsNote.textContent = haveSounds
        ? 'Original sounds: effects, unit voices, announcer lines and music from your files. WebRA keeps its own sounds for anything missing.'
        : 'Original is off until the original content is installed: install it below to hear the original sounds.';
      status.textContent = summaryText(s);
      remove.hidden = s.total === 0;
      if (content.storeError) status.textContent += ` (Browser storage is unavailable: ${content.storeError}. Installed content lasts until you leave this page.)`;
    } catch (err) {
      status.textContent = `Could not read installed content: ${err.message ?? err}`;
    }
    renderPacks();
  };

  const install = async (list) => {
    if (!list.length) return null;
    if (running) {
      showProgress('An install is already running. Wait until it finishes.');
      return null;
    }
    busy(true);
    result.hidden = true;
    showProgress('Reading your files in this browser...');
    let report = null;
    try {
      report = await content.install(list, { onProgress: (t) => showProgress(`${t}...`) });
      await audio?.reloadInstalled();
      hideProgress();
      showResult(report.added ? 'Installed' : 'Nothing installed', installResultLines(report), report.added > 0);
    } catch (err) {
      hideProgress();
      showResult('Install failed', [err.message ?? String(err), 'Nothing on this device changed. You can try again.'], false);
    } finally {
      busy(false);
      files.value = '';
      folder.value = '';
      await sync();
    }
    return report;
  };

  const fetchAndInstall = async () => {
    if (running) return null;
    busy(true);
    result.hidden = true;
    showProgress('Starting the download...', 0);
    let file;
    try {
      file = await downloadQuickInstall({
        fetchImpl: opts.fetchImpl,
        onProgress: (n, total) => showProgress(`Downloading: ${formatBytes(n)} of ${formatBytes(total)} (${Math.floor((n / total) * 100)}%)`, n / total),
      });
    } catch (err) {
      hideProgress();
      showResult('Download failed', [`${err.message ?? err}.`, 'You can download the file from a mirror yourself (step 1) and drop it here.'], false);
      busy(false);
      return null;
    }
    busy(false);
    return install([file]);
  };
  download.addEventListener('click', fetchAndInstall);

  // The music: pieces of scores.mix through the relay, kept as they arrive,
  // so Cancel, a failure or a closed tab lose nothing; the same button goes on.
  let musicAbort = null;
  const fetchMusic = async () => {
    if (running) return null;
    busy(true);
    result.hidden = true;
    musicAbort = new AbortController();
    cancelMusic.hidden = false;
    cancelMusic.disabled = false;
    showProgress('Starting the music download...', 0);
    let file;
    let store;
    try {
      store = await content.store();
      file = await downloadScores({
        store,
        fetchImpl: opts.fetchImpl,
        signal: musicAbort.signal,
        onProgress: (n, total) => showProgress(`Downloading the music: ${formatBytes(n)} of ${formatBytes(total)} (${Math.floor((n / total) * 100)}%)`, n / total),
      });
    } catch (err) {
      hideProgress();
      const cancelled = err instanceof CancelledError;
      music.textContent = `Resume the music download (${formatBytes(SCORES_BYTES)})`;
      showResult(cancelled ? 'Music download cancelled' : 'Music download failed', [
        `${err.message ?? err}.`,
        cancelled
          ? 'Click the music button to go on where it stopped.'
          : 'Click the music button to try again: the parts already downloaded are kept. Or download a freeware CD image yourself (Other ways) and drop it here.',
      ], false);
      return null;
    } finally {
      musicAbort = null;
      cancelMusic.hidden = true;
      busy(false);
    }
    const report = await install([file]);
    if (report) {
      music.textContent = MUSIC_LABEL;
      await forgetScoresDownload(store).catch(() => {});
    }
    return report;
  };
  music.addEventListener('click', fetchMusic);
  cancelMusic.addEventListener('click', () => {
    cancelMusic.disabled = true;
    musicAbort?.abort();
  });

  files.addEventListener('change', () => handleFiles([...files.files]));
  folder.addEventListener('change', () => install([...folder.files]));
  remove.addEventListener('click', async () => {
    if (running) return;
    busy(true);
    try {
      await content.removeOriginal();
      await audio?.reloadInstalled();
      showResult('Removed', ['WebRA uses its own art and synthesized sounds again.'], false);
    } catch (err) {
      showResult('Could not remove', [err.message ?? String(err)], false);
    } finally {
      busy(false);
      sync();
    }
  });

  // ---- Pack install with preview -------------------------------------------------------
  const showPreview = (pack) => {
    const m = pack.manifest;
    const s = packSummary(m, opts.actorNames ?? new Map());
    const list = (title, items) => (items.length ? el('p', { class: 'audio-note', text: `${title}: ${items.join(', ')}.` }) : null);
    const sprites = s.sprites.map((e) => {
      const part = e.part === 'second' ? ' (turret or prone)' : '';
      return e.hidden ? `${e.target}${part} hidden` : `${e.target}${part} (${e.poses.join(', ')})`;
    });
    const install = el('button', { type: 'button', class: 'primary', text: 'Install pack' });
    const cancel = el('button', { type: 'button', text: 'Cancel' });
    cancel.addEventListener('click', () => {
      preview.hidden = true;
      preview.replaceChildren();
    });
    install.addEventListener('click', async () => {
      busy(true);
      install.disabled = true;
      try {
        await content.installPack(pack);
        packStatus.textContent = `Installed ${m.name} ${m.version}.`;
        preview.hidden = true;
        preview.replaceChildren();
      } catch (err) {
        packStatus.textContent = `Could not install the pack: ${err.message ?? err}`;
      } finally {
        busy(false);
        sync();
      }
    });
    preview.replaceChildren(
      el('h3', { text: `${m.name} ${m.version}` }),
      el('p', { class: 'audio-note', text: `By ${m.author}. License: ${m.license}. ${formatBytes(pack.size)}.` }),
      m.description ? el('p', { class: 'audio-note', text: m.description }) : null,
      el(
        'p',
        { class: 'audio-local' },
        'Texture packs are made by other players, not by WebRA. Only install packs from people you trust and that you may use. A pack only changes how the game looks and sounds on this device: it cannot change rules, maps or anything the game simulates, so it is safe in multiplayer.',
      ),
      list('Replaces sprites of', sprites),
      list('Cameos', s.cameos),
      s.terrain ? el('p', { class: 'audio-note', text: `Terrain tiles for ${s.terrain.join(', ')} maps.` }) : null,
      list('Sounds', s.sounds),
      pack.warnings.length ? el('p', { class: 'audio-note', text: `Notes: ${pack.warnings.slice(0, 5).join('; ')}${pack.warnings.length > 5 ? '; ...' : ''}` }) : null,
      el('div', { class: 'audio-buttons' }, install, cancel),
    );
    preview.hidden = false;
  };

  const inspectPackFile = async (file) => {
    preview.hidden = true;
    if (file.size > MAX_PACK_FILE) {
      packStatus.textContent = `${file.name} is larger than ${formatBytes(MAX_PACK_FILE)}.`;
      return;
    }
    busy(true);
    packStatus.textContent = `Checking ${file.name} in this browser...`;
    try {
      const pack = await content.inspectPack(new Uint8Array(await file.arrayBuffer()));
      packStatus.textContent = '';
      showPreview(pack);
    } catch (err) {
      packStatus.textContent = err instanceof PackError ? `${file.name} cannot be installed: ${err.message}` : `${file.name} could not be read: ${err.message ?? err}`;
    } finally {
      busy(false);
    }
  };
  packFile.addEventListener('change', () => {
    const file = packFile.files[0];
    packFile.value = '';
    if (file) inspectPackFile(file);
  });

  // ---- Pack manager -------------------------------------------------------------------
  const renderPacks = () => {
    const packs = content.packs;
    if (!packs.length) {
      packList.replaceChildren(el('li', { class: 'audio-note', text: 'No texture packs installed.' }));
      return;
    }
    packList.replaceChildren(
      ...packs.map((p, i) => {
        const r = p.record;
        const info = `${r.name} ${r.version} by ${r.author} (${r.license}, ${formatBytes(r.size ?? 0)})`;
        const on = toggle({
          id: `content-pack-${i}`,
          label: info,
          checked: !!r.enabled,
          disabled: !p.manifest,
          rowClass: 'content-pack-main',
          onChange: (enabled) => content.setPackEnabled(r.id, enabled).then(sync),
        });
        const up = el('button', { type: 'button', class: 'ui-mini', text: 'Up', title: 'Higher priority', 'aria-label': `Move ${r.name} up (higher priority)` });
        const down = el('button', { type: 'button', class: 'ui-mini', text: 'Down', title: 'Lower priority', 'aria-label': `Move ${r.name} down (lower priority)` });
        const del = el('button', { type: 'button', class: 'ui-mini danger', text: 'Remove', 'aria-label': `Remove ${r.name}` });
        up.disabled = i === 0;
        down.disabled = i === packs.length - 1;
        up.addEventListener('click', () => content.movePack(r.id, -1).then(sync));
        down.addEventListener('click', () => content.movePack(r.id, 1).then(sync));
        del.addEventListener('click', () => content.removePack(r.id).then(sync));
        const problems = p.problems.length ? el('p', { class: 'audio-note', text: `Not used: ${p.problems.slice(0, 2).join('; ')}` }) : null;
        const rank = el('span', { class: 'content-pack-rank', text: `Priority ${i + 1} of ${packs.length}` });
        return el('li', { class: 'content-pack' }, on.row, problems, el('div', { class: 'content-pack-actions' }, rank, up, down, del));
      }),
    );
  };

  content.onChange(() => sync());
  audio?.prefs.subscribe((v) => {
    sounds.set(v.original ? 'original' : 'webra');
    useAll.checked = content.graphics === 'original' && !!v.original;
  });

  /**
   * Files dropped or picked: texture packs get the install preview, Red
   * Alert files (ra-quickinstall.zip, a CD image, .mix, loose files) the install.
   * Returns false when nothing in `list` is content. `classified` skips
   * reading the files again (classifyFiles).
   */
  async function handleFiles(list, classified = null) {
    const { packs, content: rest } = classified ?? (await classifyFiles(list));
    if (!packs.length && !rest.length) {
      showResult('Not Red Alert content', ['Choose ra-quickinstall.zip, a freeware Red Alert CD image (.iso), Red Alert .mix files or a texture pack (.webrapack).'], false);
      return false;
    }
    if (rest.length) await install(rest);
    for (const p of packs) await inspectPackFile(p);
    return true;
  }

  root.replaceChildren(
    el('p', { class: 'audio-local', text: LEGAL_NOTICE }),
    el(
      'section',
      { class: 'audio-content', 'aria-labelledby': 'content-use-title' },
      el('h2', { id: 'content-use-title', text: 'Use' }),
      choiceRow('Graphics', graphics),
      graphicsNote,
      choiceRow('Sounds', sounds),
      soundsNote,
    ),
    el(
      'section',
      { class: 'audio-content', 'aria-labelledby': 'content-install-title' },
      el('h2', { id: 'content-install-title', text: 'Install the original content' }),
      status,
      autoBox,
      el(
        'ol',
        { class: 'content-steps' },
        stepDownload(),
        el('li', {}, el('strong', { text: touch ? 'Choose the ZIP' : 'Drop the ZIP here' }), el('span', { text: touch ? ' from your downloads:' : ', or click to choose it:' }), dropzone),
        el('li', {}, el('strong', { text: 'Done.' }), el('span', { text: ' The game switches to the original graphics and sounds at once, also in a running game. You can switch back under Use.' })),
      ),
      progressBox,
      result,
      el(
        'details',
        { class: 'content-other' },
        el('summary', { text: 'Other ways: the freeware CDs, or your own copy of Red Alert' }),
        el('p', {
          class: 'audio-note',
          text: 'With music and movies: download the Allied or the Soviet CD image of the freeware release from the Internet Archive and drop the .iso here (or choose it below). WebRA reads only the parts it needs straight from the file, never the whole image, and installs the music, sounds, graphics and campaign movies on the disc (the movies take a few hundred megabytes of browser storage).',
        }),
        cdList(),
        el('p', {
          class: 'audio-note',
          text: 'Choose main.mix and redalert.mix (the freeware release or the CD), or the archives inside them (conquer.mix, hires.mix, temperat.mix, snow.mix, sounds.mix, allies.mix, russian.mix, speech.mix, scores.mix, movies1.mix, movies2.mix), or loose files (an OpenRA content folder with its movies folder works too). desert.mix from Tiberian Dawn adds desert terrain. Sounds, graphics and movies are installed in one go.',
        }),
        el('div', { class: 'audio-buttons' }, pickFiles, pickFolder),
      ),
      el('div', { class: 'audio-buttons' }, remove),
      files,
      folder,
    ),
    el(
      'section',
      { class: 'audio-content', 'aria-labelledby': 'content-packs-title' },
      el('h2', { id: 'content-packs-title', text: 'Texture packs' }),
      el('p', {
        class: 'audio-note',
        text: 'Packs (.webrapack or .zip) replace sprites, cameos, terrain and sounds. A pack wins over the original content, which wins over WebRA art; the first pack in the list wins over the ones below it. Their order and choice follow your account.',
      }),
      packList,
      el('div', { class: 'audio-buttons' }, pickPack),
      packFile,
      packStatus,
      preview,
    ),
  );
  sync();
  return {
    refresh: sync,
    install,
    handleFiles,
    inspectPackFile,
    download: fetchAndInstall,
    downloadMusic: fetchMusic,
    get busy() {
      return running;
    },
    /** Offer the one-click download or not (the account's flags changed). */
    setAutoInstall(on) {
      autoBox.hidden = !on;
    },
  };
}

/**
 * The Original content button and its dialog (index.html #content-button,
 * #content-panel), also opened from the game menu and the Sound dialog.
 */
export function mountContentPanel(button, panel, content, audio, opts = {}) {
  const body = el('div', { class: 'audio-body' });
  const close = el('button', { type: 'button', class: 'audio-close', 'aria-label': 'Close original content', text: 'Close' });
  const card = el(
    'div',
    { class: 'menu-card audio-card content-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'content-title' },
    el('div', { class: 'audio-head' }, el('h1', { id: 'content-title', text: 'Original content' }), close),
    body,
  );
  panel.replaceChildren(card);
  const view = mountContentSettings(body, content, audio, opts);
  let opener = null;
  const open = (on) => {
    if (on === !panel.hidden) return;
    panel.hidden = !on;
    button?.setAttribute('aria-expanded', String(on));
    if (on) {
      opener = document.activeElement;
      view.refresh();
      close.focus();
    } else {
      (opener instanceof HTMLElement && opener.isConnected ? opener : button)?.focus();
    }
  };
  if (button) {
    button.hidden = false;
    button.addEventListener('click', () => open(panel.hidden));
  }
  close.addEventListener('click', () => open(false));
  panel.addEventListener('pointerdown', (e) => {
    if (e.target === panel) open(false);
  });
  // Keys typed in the dialog (Escape closes it) do not reach the game.
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') open(false);
    e.stopPropagation();
  });
  return {
    open: () => open(true),
    /** Open the dialog and run the one-click download. */
    download() {
      open(true);
      return view.download();
    },
    setAutoInstall: (on) => view.setAutoInstall(on),
    /**
     * Files dropped on the game or the lobby, or picked in the notice: the
     * dialog opens with the install's progress and result. Returns false
     * (and leaves the dialog closed) when nothing in `files` is content.
     */
    async drop(files) {
      const list = [...files];
      const classified = await classifyFiles(list);
      if (!classified.packs.length && !classified.content.length) return false;
      open(true);
      await view.handleFiles(list, classified);
      return true;
    },
  };
}

/** Whether ZIP bytes hold a texture pack (a manifest.json at the root or in its only folder). */
async function isPackZip(bytes) {
  try {
    const { openZip } = await import('../oramap/zip.js');
    const names = openZip(bytes, { maxArchiveBytes: 64 * 1024 * 1024, maxEntries: 1024 }).names();
    return names.some((n) => n === 'manifest.json' || /^[^/]+\/manifest\.json$/.test(n));
  } catch {
    return false;
  }
}

/**
 * The start screen notice: what the original content is and how to install
 * it, in three steps. Dismissing it is remembered (a synced setting); it
 * also goes once content is installed. Not a dialog: the lobby stays usable.
 * @param {HTMLElement} host
 * @param {{ registry: object, onFiles(files: File[]): void, onOpen(): void, onDownload(): void, autoInstall?: boolean }} o
 */
export function mountContentNotice(host, { registry, onFiles, onOpen, onDownload, autoInstall = false }) {
  const touch = isTouchDevice();
  const file = el('input', { type: 'file', accept: '.zip,.iso,.mix', multiple: true, hidden: true, 'aria-hidden': 'true', tabindex: '-1' });
  const pick = el('button', { type: 'button', class: 'primary', text: 'Choose ra-quickinstall.zip...' });
  pick.addEventListener('click', () => file.click());
  file.addEventListener('change', () => {
    const list = [...file.files];
    file.value = '';
    if (list.length) onFiles(list);
  });
  const dismiss = el('button', { type: 'button', class: 'content-notice-close', 'aria-label': 'Dismiss the original content notice', title: 'Dismiss', text: 'Dismiss' });
  const more = el('button', { type: 'button', text: 'More options...' });
  more.addEventListener('click', () => onOpen());
  const auto = el('button', { type: 'button', class: 'primary', text: `Download and install (${formatBytes(QUICKINSTALL_BYTES)})` });
  auto.addEventListener('click', () => onDownload());
  const autoRow = el('div', { class: 'content-auto', hidden: !autoInstall }, el('p', { class: 'audio-note', text: 'Your account may use the one-click install:' }), el('div', { class: 'audio-buttons' }, auto));
  const card = el(
    'section',
    { class: 'menu-card content-notice', role: 'region', 'aria-labelledby': 'content-notice-title' },
    el('div', { class: 'content-notice-head' }, el('h2', { id: 'content-notice-title', text: 'Play with the original Red Alert art and sounds' }), dismiss),
    el('p', {
      class: 'audio-note',
      text: 'WebRA plays with its own art and sounds. Electronic Arts released Red Alert as freeware in 2008: add its original graphics, sounds and music in three steps.',
    }),
    autoRow,
    el(
      'ol',
      { class: 'content-steps' },
      stepDownload(),
      el(
        'li',
        {},
        el('strong', { text: touch ? 'Choose the ZIP' : 'Drag the ZIP onto this page' }),
        el('span', { text: touch ? ' from your downloads: ' : ', or choose it: ' }),
        pick,
      ),
      el('li', {}, el('strong', { text: 'Done.' }), el('span', { text: ' You see the progress and what was installed, and can switch back any time.' })),
    ),
    el('p', { class: 'content-notice-legal', text: LEGAL_NOTICE }),
    el('div', { class: 'audio-buttons' }, more),
    file,
  );
  const close = () => card.remove();
  dismiss.addEventListener('click', () => {
    dismissNotice(registry);
    close();
  });
  host.append(card);
  return {
    close,
    get open() {
      return card.isConnected;
    },
    setAutoInstall(on) {
      autoRow.hidden = !on;
    },
  };
}

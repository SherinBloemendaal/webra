// Original Red Alert content: the "Original content" dialog (lobby button,
// game menu, Sound dialog) and the start screen notice.
//
// The dialog: what is installed (none, partly, everything the one-click
// install covers, with counts, date and storage) and the one action that
// fits it; for accounts allowed to use WebRA's relays (content/download.js
// canAutoInstall) one "Install everything" button for every part the relays
// serve (the package and the music from the freeware CDs, content/cdmusic.js)
// with one progress, a line per part, one Cancel and a summary; the ways to
// install in tabs (the one-click install, and the manual steps: download
// ra-quickinstall.zip from a mirror, drop or pick it, done; a freeware CD
// image; own Red Alert files; a folder); the graphics and sounds choice; the
// texture pack manager.
//
// The notice: a dismissible card on the start screen (dismissal is a synced
// setting) with the same steps, shown until something is installed.
//
// Text from files and the server only ever goes in through textContent.

import { GRAPHICS_SETTING } from './index.js';
import { segmented, toggle } from '../ui/controls.js';
import { packSummary, PackError } from './packs.js';
import {
  downloadQuickInstall,
  formatWait,
  RelayLimitError,
  dismissNotice,
  DOWNLOAD_NOTICE,
  KEPT_NOTICE,
  LEGAL_NOTICE,
  QUICKINSTALL_BYTES,
  QUICKINSTALL_MIRRORS,
} from './download.js';
import { downloadMovieArchive, forgetMovieDownload, keptMovieBytes, MOVIE_ARCHIVES, MOVIES_BYTES } from './cdmovies.js';
import { MOVIE_FILES } from './movies.js';
import { CancelledError, downloadScores, forgetScoresDownload, FREEWARE_CDS, MUSIC_NOTICE, PIECES, pieceLength, SCORES_BYTES, SCORES_PARTIAL } from './cdmusic.js';

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

/** Movie names for the player ("landing.vqa", ...: "landing, prolog and 3 more"). */
export function movieList(names, shown = 8) {
  const bare = names.map((n) => n.replace(/\.vqa$/i, ''));
  if (bare.length <= shown) return bare.length > 1 ? `${bare.slice(0, -1).join(', ')} and ${bare.at(-1)}` : (bare[0] ?? '');
  return `${bare.slice(0, shown).join(', ')} and ${bare.length - shown} more`;
}

/**
 * The parts of the one-click install, in the order they run: the package
 * (ra-quickinstall.zip: graphics, sounds, unit voices, the announcer) and
 * the music from the freeware CDs. Those are what WebRA's relays serve; the
 * movies and the Counterstrike and Aftermath music come from a CD image or
 * the player's own copy (Other ways to install).
 */
export const ONE_CLICK_PARTS = Object.freeze(['package', 'music']);
export const PART_LABELS = Object.freeze({ package: 'Graphics, sounds, voices and announcer', music: 'Music from the freeware CDs', movies: 'Mission movies' });
/** What the one-click install downloads at most. */
export const ONE_CLICK_BYTES = QUICKINSTALL_BYTES + SCORES_BYTES;
const ENTRY_STATES = Object.freeze({ partial: 'partly installed', complete: 'installed' });
const STATE_TITLES = Object.freeze({ none: 'Not installed', partial: 'Partly installed', complete: 'Original content installed' });
const ONE_CLICK_SUMMARY = `One button installs the original graphics, sounds, unit voices, the announcer and the music (${formatBytes(ONE_CLICK_BYTES)} at most) and keeps them on this device. The mission movies are optional, with a button of their own (${formatBytes(MOVIES_BYTES)}). The Counterstrike and Aftermath music comes from your own expansion discs (Other ways to install).`;

/**
 * What is installed (content/install.js contentSummary) as the dialog shows
 * it: `level` none, partial or complete (everything the one-click install
 * covers is there), `installed` lines per category with counts, `missing`
 * lines for what a complete install would add, and `parts`: which one-click
 * parts (ONE_CLICK_PARTS, and the optional movies) are needed. The movies
 * are optional: shown, never counted as missing.
 */
export function contentState(s) {
  const b = s.byCategory;
  const missing = [];
  if (!b.graphics) missing.push('Graphics: units, structures, cameos and terrain (conquer.mix, hires.mix and the theater archives, in ra-quickinstall.zip)');
  else {
    if (s.palette === false) missing.push('The palette from temperat.mix (the graphics cannot be used without it)');
    for (const t of ['TEMPERAT', 'SNOW']) if (!s.theaters.includes(t)) missing.push(`Terrain for ${THEATER_NAMES[t]} maps`);
  }
  if (!b.effects) missing.push('Sound effects (sounds.mix, in ra-quickinstall.zip)');
  if (!b.voices) missing.push('Unit voices (allies.mix and russian.mix, in ra-quickinstall.zip)');
  if (!b.announcer) missing.push('Announcer (EVA) (speech.mix, in ra-quickinstall.zip)');
  const packageNeeded = missing.length > 0;
  if (!b.music) missing.push('Music (scores.mix: not in ra-quickinstall.zip; on the freeware CD images)');
  const installed = [];
  if (b.graphics) {
    const theaters = s.theaters.map((t) => THEATER_NAMES[t] ?? t.toLowerCase()).join(', ') || 'no maps';
    installed.push(`Graphics: ${plural(b.graphics, 'file', 'files')} (${formatBytes(s.bytes.graphics)}), terrain for ${theaters}`);
  }
  if (b.effects) installed.push(`Sound effects: ${b.effects}`);
  if (b.voices) installed.push(`Unit voices: ${b.voices}`);
  if (b.announcer) installed.push(`Announcer (EVA): ${plural(b.announcer, 'line', 'lines')}`);
  if (b.music) installed.push(`Music: ${plural(b.music, 'track', 'tracks')}`);
  const movies = b.movies ?? 0;
  if (s.total) {
    installed.push(
      movies
        ? `Mission movies (optional): ${movies} of ${MOVIE_FILES.size} (${formatBytes(s.bytes.movies ?? 0)})`
        : 'Mission movies (optional): none; missions show a card instead',
    );
  }
  const level = !s.total ? 'none' : missing.length ? 'partial' : 'complete';
  return { level, installed, missing, parts: { package: packageNeeded, music: !b.music, movies: movies < MOVIE_FILES.size } };
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
  if (r.kept) lines.push('ra-quickinstall.zip is kept on this device: installing again or a WebRA update needs no new download.');
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
 * @param {{ actorNames?: Map<string, string>, autoInstall?: boolean, fetchImpl?: typeof fetch, onState?(level: string): void }} [opts]
 *   autoInstall: offer the one-click install (content/download.js canAutoInstall);
 *   onState: the installed state (contentState level) after every refresh
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
      { value: 'webra2d', label: '2D minimal' },
      { value: 'webra3d', label: '3D minimal' },
      { value: 'original', label: 'Red Alert original' },
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
      settings.set(GRAPHICS_SETTING, on && content.hasOriginalGraphics ? 'original' : content.graphics === 'original' ? 'webra2d' : content.graphics);
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

  // ---- State and the one-click install ----------------------------------------------------
  // What is installed (contentState) with the one action that fits it. The
  // one-click install (accounts allowed to use WebRA's relays) is a single
  // button for every part the relays serve (ONE_CLICK_PARTS): one progress
  // bar over all parts, a line per part (a failed part gets its own retry
  // there), one Cancel. The package comes from the kept ZIP when there is
  // one, the music goes on from its kept pieces. Nothing retries on its own.
  let autoInstall = !!opts.autoInstall;
  let current = null; // { state, kept, musicKept } of the last sync
  const stateIcon = el('span', { class: 'content-state-icon', 'aria-hidden': 'true' });
  const stateTitleText = el('span', { text: 'Original content' });
  const stateTitle = el('h3', { id: 'content-state-title' }, stateIcon, stateTitleText);
  const stateList = el('ul', { class: 'content-state-list' });
  const missingTitle = el('p', { class: 'audio-note content-missing-title', text: 'Missing:', hidden: true });
  const missingList = el('ul', { class: 'content-state-list content-missing', hidden: true });
  const stateMeta = el('p', { class: 'audio-note content-state-meta' });
  const installAll = el('button', { type: 'button', class: 'primary content-install-all', text: 'Install everything' });
  // The movies are hundreds of megabytes: optional, with a button of their own that says the size.
  const installMovies = el('button', { type: 'button', class: 'content-install-movies', text: 'Install mission movies' });
  const cancel = el('button', { type: 'button', text: 'Cancel', hidden: true });
  const checkMissing = el('button', { type: 'button', text: 'Check for missing files', hidden: true });
  const reinstall = el('button', { type: 'button', text: 'Reinstall...', hidden: true });
  const confirmText = el('p', { class: 'audio-note', id: 'content-confirm-text' });
  const confirmYes = el('button', { type: 'button', class: 'danger', text: 'Reinstall' });
  const confirmNo = el('button', { type: 'button', text: 'Keep it' });
  const confirmBox = el(
    'div',
    { class: 'content-confirm', role: 'group', 'aria-labelledby': 'content-confirm-text', hidden: true },
    confirmText,
    el('div', { class: 'audio-buttons' }, confirmYes, confirmNo),
  );
  const stateBox = el(
    'div',
    { class: 'content-state', role: 'region', 'aria-labelledby': 'content-state-title', 'data-level': 'none' },
    stateTitle,
    stateList,
    missingTitle,
    missingList,
    stateMeta,
    el('div', { class: 'audio-buttons content-actions' }, installAll, installMovies, cancel, checkMissing, reinstall, remove),
    confirmBox,
  );
  // One line per part while (and after) the one-click install runs.
  const partList = el('ul', { class: 'content-parts', 'aria-label': 'Parts of the install', hidden: true });

  // ---- Packs ----------------------------------------------------------------------------
  const packFile = el('input', { type: 'file', accept: ACCEPT_PACK, hidden: true, 'aria-hidden': 'true', tabindex: '-1' });
  const pickPack = el('button', { type: 'button', text: 'Install texture pack...' });
  pickPack.addEventListener('click', () => packFile.click());
  const packList = el('ul', { class: 'content-packs' });
  const preview = el('div', { class: 'content-preview', hidden: true });
  const packStatus = el('p', { class: 'audio-progress', 'aria-live': 'polite' });

  // A relay budget that is used up (429) holds its part back until the server takes it again
  // (partId -> unix ms); nothing retries on its own.
  const limitedUntil = new Map();
  const limited = (id) => (limitedUntil.get(id) ?? 0) > Date.now();
  const retryButtons = new Set();
  const busy = (on) => {
    running = on;
    for (const b of [pickFiles, pickFolder, remove, pickPack, dropzone, checkMissing, reinstall, ...retryButtons]) b.disabled = on;
    renderAction();
    root.setAttribute('aria-busy', String(on));
  };
  const limit = (id, err) => {
    if (!(err instanceof RelayLimitError) || !err.retryAt) return;
    limitedUntil.set(id, err.retryAt);
    // Timers longer than about 24.8 days fire at once; the server's windows are a day at most.
    const timer = setTimeout(() => {
      limitedUntil.delete(id);
      renderAction();
    }, Math.min(err.retryAt - Date.now(), 2 ** 31 - 1));
    // Where timers can hold a process open (Node), this one does not.
    timer?.unref?.();
  };

  /** The parts the one-click install would run now (needed, or all of them to reinstall), without held back ones. */
  const neededParts = ({ all = false } = {}) => ONE_CLICK_PARTS.filter((id) => all || current?.state.parts[id]);
  /** Bytes a run of `ids` downloads (the kept ZIP and kept music pieces need none). */
  const downloadBytes = (ids) =>
    ids.reduce(
      (n, id) =>
        n + (id === 'package' ? (current?.kept ? 0 : QUICKINSTALL_BYTES) : id === 'music' ? SCORES_BYTES - (current?.musicKept ?? 0) : moviesToDownload().reduce((m, a) => m + a.archive.bytes - a.kept, 0)),
      0,
    );
  /** What a part moves through the progress bar (its whole size: kept bytes count as done at once). */
  const partBytes = (id) => (id === 'package' ? QUICKINSTALL_BYTES : id === 'music' ? SCORES_BYTES : moviesToDownload().reduce((m, a) => m + a.archive.bytes, 0) || MOVIES_BYTES);
  /** The movie archives with a movie that is not installed: [{ archive, kept }] (kept: bytes already on this device). */
  const moviesToDownload = () => current?.movieArchives ?? MOVIE_ARCHIVES.map((archive) => ({ archive, kept: 0 }));

  /** The install button: what it would do now, or why it cannot. */
  function renderAction() {
    installAll.hidden = !autoInstall;
    renderMovies();
    reinstall.hidden = !autoInstall || !current || current.state.level === 'none';
    checkMissing.hidden = !current?.kept || current.state.level === 'none';
    remove.hidden = !current || current.state.level === 'none';
    const level = current?.state.level ?? 'none';
    const ids = neededParts().filter((id) => !limited(id));
    const held = neededParts().filter((id) => limited(id));
    if (level === 'complete') {
      installAll.textContent = 'Everything is installed';
      installAll.disabled = true;
      return;
    }
    if (!ids.length && held.length) {
      const at = Math.min(...held.map((id) => limitedUntil.get(id)));
      installAll.textContent = `Try again ${formatWait(Math.max(1, Math.ceil((at - Date.now()) / 1000)))}`;
      installAll.disabled = true;
      return;
    }
    const bytes = downloadBytes(ids);
    const size = bytes ? formatBytes(bytes) : 'no download';
    installAll.textContent = `${level === 'partial' ? 'Install missing parts' : resumable ? 'Resume the install' : 'Install everything'} (${size})`;
    installAll.disabled = running;
  }
  let resumable = false;

  /** The movies button: its size, or that they are installed, or when to try again. */
  function renderMovies() {
    installMovies.hidden = !autoInstall;
    if (!current?.state.parts.movies) {
      installMovies.textContent = 'Mission movies installed';
      installMovies.disabled = true;
      return;
    }
    if (limited('movies')) {
      installMovies.textContent = `Mission movies: try again ${formatWait(Math.max(1, Math.ceil((limitedUntil.get('movies') - Date.now()) / 1000)))}`;
      installMovies.disabled = true;
      return;
    }
    const bytes = downloadBytes(['movies']);
    installMovies.textContent = `Install mission movies (~${formatBytes(bytes)}, optional)`;
    installMovies.disabled = running;
  }

  const sync = async () => {
    graphics.set(content.graphics);
    graphics.setDisabled('original', !content.hasOriginalGraphics);
    graphics.setTitle('original', content.hasOriginalGraphics ? '' : ORIGINAL_NOT_INSTALLED);
    graphicsNote.textContent = content.hasOriginalGraphics
      ? '2D minimal is WebRA\'s flat art, 3D minimal its blocky low-poly art (built in, texture packs you install come first). Red Alert original: units, structures, infantry animations, cameos and terrain from your files, effects keep WebRA art. The choice applies at once, also in a running game.'
      : '2D minimal is WebRA\'s flat art, 3D minimal its blocky low-poly art (built in, texture packs you install come first). Red Alert original is off until the original content is installed: install it below to use the original graphics.';
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
      const state = contentState(s);
      // What is kept, without reading the kept files (the package's small record, the music pieces' keys).
      const kept = !!(await (content.keptInfo ?? content.keptPackage)?.call(content).catch(() => null));
      let musicKept = 0;
      try {
        const store = await content.store?.();
        for (const i of (await store?.partialIndexes?.(SCORES_PARTIAL)) ?? []) if (i >= 0 && i < PIECES) musicKept += pieceLength(i);
      } catch {
        // No store: nothing kept.
      }
      // The movie archives with a movie that is not installed yet, and how much of each is kept already.
      const store = await content.store?.().catch(() => null);
      const movieArchives = [];
      for (const archive of MOVIE_ARCHIVES) {
        if (archive.movies.every((m) => content.hasMovie?.(m))) {
          // Installed another way (a CD image): pieces of an unfinished download of it are not needed.
          if (store && (await store.partialIndexes?.(archive.partial).catch(() => []))?.length) await forgetMovieDownload(store, archive).catch(() => {});
          continue;
        }
        movieArchives.push({ archive, kept: store ? await keptMovieBytes(store, archive).catch(() => 0) : 0 });
      }
      current = { state, kept, musicKept, movieArchives };
      stateBox.dataset.level = state.level;
      stateTitleText.textContent = STATE_TITLES[state.level];
      stateList.replaceChildren(...state.installed.map((t) => el('li', { text: t })));
      missingTitle.hidden = missingList.hidden = state.level !== 'partial';
      missingList.replaceChildren(...state.missing.map((t) => el('li', { text: t })));
      stateMeta.textContent = await metaText(s);
      if (content.storeError) stateMeta.textContent += ` Browser storage is unavailable (${content.storeError}): installed content lasts until you leave this page.`;
      opts.onState?.(state.level);
    } catch (err) {
      stateMeta.textContent = `Could not read installed content: ${err.message ?? err}`;
    }
    renderAction();
    renderPacks();
  };

  /** "Installed 9 October 2026. 31.2 MB in this browser; WebRA uses 48.0 MB of storage on this device." */
  async function metaText(s) {
    if (!s.total) return 'Nothing installed yet: WebRA uses its own art and synthesized sounds.';
    const size = formatBytes(s.bytes.sounds + s.bytes.graphics + (s.bytes.movies ?? 0));
    const when = s.installedAt ? `Installed ${new Date(s.installedAt).toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' })}. ` : '';
    let usage = '';
    try {
      const est = await globalThis.navigator?.storage?.estimate?.();
      if (est?.usage) usage = `; WebRA uses ${formatBytes(est.usage)} of storage on this device`;
    } catch {
      // Not offered.
    }
    return `${when}${size} in this browser${usage}.`;
  }

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

  // ---- The one-click install run ---------------------------------------------------------
  let abort = null;
  const partRows = new Map();
  /** Set a part's line: `phase` (waiting, running, done, failed, cancelled), its text, and a retry for a failed part. */
  const setPart = (id, phase, text, retry = false) => {
    let row = partRows.get(id);
    if (!row) {
      const label = el('strong', { text: PART_LABELS[id] });
      const status = el('span', { class: 'content-part-status' });
      const again = el('button', { type: 'button', class: 'ui-mini', text: 'Retry', 'aria-label': `Retry: ${PART_LABELS[id]}` });
      again.addEventListener('click', () => runParts([id]));
      retryButtons.add(again);
      row = { li: el('li', { class: 'content-part' }, label, status, again), status, again };
      partRows.set(id, row);
      partList.append(row.li);
    }
    row.li.dataset.phase = phase;
    row.status.textContent = text;
    row.again.hidden = !retry;
    row.again.disabled = running || limited(id);
    partList.hidden = false;
  };

  /** One part: returns the install report; throws (CancelledError when cancelled). */
  async function runPart(id, signal, onBytes) {
    const cancelled = () => signal.aborted && new CancelledError();
    if (id === 'package') {
      const kept = await content.keptPackage?.().catch(() => null);
      let file = kept?.file;
      if (file) {
        onBytes(QUICKINSTALL_BYTES);
        setPart(id, 'running', 'installing from the kept ZIP (no download)');
      } else {
        setPart(id, 'running', 'downloading');
        try {
          file = await downloadQuickInstall({ fetchImpl: opts.fetchImpl, signal, onProgress: (n) => onBytes(n) });
        } catch (err) {
          throw cancelled() || err;
        }
        setPart(id, 'running', 'installing');
      }
      if (signal.aborted) throw new CancelledError();
      return content.install([file], { onProgress: (t) => setPart(id, 'running', `${t.charAt(0).toLowerCase()}${t.slice(1)}`) });
    }
    if (id === 'movies') return runMovies(signal, onBytes);
    const store = await content.store();
    setPart(id, 'running', 'downloading');
    const file = await downloadScores({ store, fetchImpl: opts.fetchImpl, signal, onProgress: (n) => onBytes(n) });
    setPart(id, 'running', 'installing');
    const report = await content.install([file]);
    await forgetScoresDownload(store).catch(() => {});
    return report;
  }

  /** The movies part: each archive with a movie that is not installed, downloaded (or resumed), checked, installed, forgotten. */
  async function runMovies(signal, onBytes) {
    const store = await content.store();
    const todo = moviesToDownload();
    const reports = [];
    let base = 0;
    for (const { archive } of todo) {
      setPart('movies', 'running', `downloading ${archive.name}`);
      const file = await downloadMovieArchive({ archive, store, fetchImpl: opts.fetchImpl, signal, onProgress: (n) => onBytes(base + n) });
      if (signal.aborted) throw new CancelledError();
      setPart('movies', 'running', `installing ${archive.name}`);
      try {
        reports.push(await content.install([file], { onProgress: (t) => setPart('movies', 'running', `${t.charAt(0).toLowerCase()}${t.slice(1)}`) }));
      } catch (err) {
        // Pieces that do not make an archive are not kept for the next try.
        await forgetMovieDownload(store, archive).catch(() => {});
        throw err;
      }
      // Installed: the movies are stored one by one, the archive's pieces are not needed any more.
      await forgetMovieDownload(store, archive).catch(() => {});
      base += archive.bytes;
    }
    return reports.reduce(
      (all, r) => ({ ...all, added: all.added + (r.added ?? 0), switched: all.switched || r.switched, kept: all.kept || r.kept }),
      { added: 0, switched: false, kept: false },
    );
  }

  /**
   * Run the one-click install for the parts `ids` (by default what is
   * missing): one progress over all of them, one Cancel, then a summary.
   * Returns { reports, failed, cancelled } or null when something else runs.
   */
  async function runParts(ids = neededParts().filter((id) => !limited(id))) {
    if (running || !ids.length) return null;
    busy(true);
    result.hidden = true;
    confirmBox.hidden = true;
    abort = new AbortController();
    cancel.hidden = false;
    cancel.disabled = false;
    partList.replaceChildren();
    partRows.clear();
    for (const b of retryButtons) retryButtons.delete(b);
    for (const id of ids) setPart(id, 'waiting', 'waiting');
    const sizes = new Map(ids.map((id) => [id, partBytes(id)]));
    const total = ids.reduce((n, id) => n + sizes.get(id), 0);
    const got = new Map(ids.map((id) => [id, 0]));
    const draw = () => {
      const n = [...got.values()].reduce((a, b) => a + b, 0);
      showProgress(`Installing the original content: ${formatBytes(n)} of ${formatBytes(total)} (${Math.floor((n / total) * 100)}%)`, n / total);
    };
    draw();
    const reports = [];
    const failed = [];
    let cancelled = false;
    for (const id of ids) {
      if (abort.signal.aborted) {
        cancelled = true;
        setPart(id, 'cancelled', 'cancelled', true);
        continue;
      }
      try {
        const report = await runPart(id, abort.signal, (n) => {
          got.set(id, Math.min(n, sizes.get(id)));
          draw();
        });
        got.set(id, sizes.get(id));
        draw();
        reports.push(report);
        setPart(id, 'done', report.added ? `done: ${report.added} files` : 'done: nothing new');
      } catch (err) {
        if (err instanceof CancelledError || abort.signal.aborted) {
          cancelled = true;
          setPart(id, 'cancelled', id !== 'package' ? 'cancelled; the parts already downloaded are kept' : 'cancelled', true);
          continue;
        }
        limit(id, err);
        failed.push(id);
        setPart(id, 'failed', `failed: ${err.message ?? err}`, true);
      }
    }
    abort = null;
    cancel.hidden = true;
    if (reports.some((r) => r.added)) await audio?.reloadInstalled();
    hideProgress();
    busy(false);
    resumable = cancelled;
    await sync();
    for (const [id, row] of partRows) row.again.disabled = limited(id);
    const added = reports.reduce((n, r) => n + (r.added ?? 0), 0);
    const lines = [];
    if (added) lines.push(`Installed ${plural(added, 'file', 'files')}.`);
    if (reports.some((r) => r.switched)) lines.push('The game now uses the original graphics. You can switch back under Use.');
    if (reports.some((r) => r.kept)) lines.push('ra-quickinstall.zip is kept on this device: installing again or a WebRA update needs no new download.');
    if (failed.length) lines.push(`Not installed: ${failed.map((id) => PART_LABELS[id].toLowerCase()).join(', ')}. Retry above, or install the files yourself (Other ways to install).`);
    if (cancelled) lines.push('Cancelled. Install again to go on: the music and the movies go on where they stopped.');
    const title = cancelled ? 'Install cancelled' : failed.length ? 'Install incomplete' : current?.state.level === 'complete' ? 'Original content installed' : 'Installed';
    showResult(title, lines.length ? lines : ['Nothing new was installed.'], added > 0);
    return { reports, failed, cancelled };
  }

  installAll.addEventListener('click', () => runParts());
  installMovies.addEventListener('click', () => runParts(['movies']));
  cancel.addEventListener('click', () => {
    cancel.disabled = true;
    abort?.abort();
  });
  reinstall.addEventListener('click', () => {
    const bytes = downloadBytes(ONE_CLICK_PARTS);
    confirmText.textContent = `Install every part again? ${bytes ? `This downloads ${formatBytes(bytes)}` : 'Nothing is downloaded'}${current?.kept ? '; the graphics and sounds come from the kept ZIP' : ''}. What is installed stays until the new files replace it.`;
    confirmBox.hidden = false;
    confirmNo.focus();
  });
  confirmNo.addEventListener('click', () => {
    confirmBox.hidden = true;
    reinstall.focus();
  });
  confirmYes.addEventListener('click', () => runParts(ONE_CLICK_PARTS.filter((id) => !limited(id))));
  checkMissing.addEventListener('click', async () => {
    if (running) return;
    busy(true);
    result.hidden = true;
    showProgress('Looking for missing files in the kept ra-quickinstall.zip...');
    try {
      const report = await content.updateFromKept({ force: true, onProgress: (t) => showProgress(`${t}...`) });
      if (report?.added) await audio?.reloadInstalled();
      hideProgress();
      busy(false);
      await sync();
      const rest = current?.state.level === 'partial' ? ` Still missing: ${current.state.missing.join(', ')}.` : '';
      showResult(
        report?.added ? 'Missing files installed' : 'Nothing missing',
        [report?.added ? `Installed ${plural(report.added, 'file', 'files')} from the kept ZIP.${rest}` : `The kept ZIP has nothing that is not installed.${rest}`],
        !!report?.added,
      );
    } catch (err) {
      hideProgress();
      busy(false);
      showResult('Check failed', [err.message ?? String(err)], false);
    }
  });

  files.addEventListener('change', () => handleFiles([...files.files]));
  folder.addEventListener('change', () => install([...folder.files]));
  remove.addEventListener('click', async () => {
    if (running) return;
    busy(true);
    try {
      await content.removeOriginal();
      await audio?.reloadInstalled();
      partList.hidden = true;
      resumable = false;
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

  // ---- Ways to install: tabs for accounts with the one-click install --------------------
  // The one-click tab is short (what it does and does not cover); the manual
  // steps, mirrors and the other ways live in their own tab. Accounts without
  // the one-click install see only the manual way, without tabs.
  const oneClickPanel = el(
    'div',
    { class: 'content-tabpanel', id: 'content-panel-oneclick', role: 'tabpanel', 'aria-labelledby': 'content-tab-oneclick' },
    el('p', { class: 'audio-note', text: ONE_CLICK_SUMMARY }),
    el(
      'details',
      { class: 'content-other' },
      el('summary', { text: 'About the one-click install' }),
      el('p', { class: 'audio-note', text: DOWNLOAD_NOTICE }),
      el('p', { class: 'audio-note', text: MUSIC_NOTICE }),
      el('p', { class: 'audio-note', text: KEPT_NOTICE }),
    ),
  );
  const manualPanel = el(
    'div',
    { class: 'content-tabpanel', id: 'content-panel-manual', role: 'tabpanel', 'aria-labelledby': 'content-tab-manual' },
    el('p', { class: 'audio-local', text: LEGAL_NOTICE }),
    el(
      'ol',
      { class: 'content-steps' },
      stepDownload(),
      el('li', {}, el('strong', { text: touch ? 'Choose the ZIP' : 'Drop the ZIP here' }), el('span', { text: touch ? ' from your downloads:' : ', or click to choose it:' }), dropzone),
      el('li', {}, el('strong', { text: 'Done.' }), el('span', { text: ' The game switches to the original graphics and sounds at once, also in a running game. You can switch back under Use.' })),
    ),
    el(
      'details',
      { class: 'content-other' },
      el('summary', { text: 'Music, movies, or your own copy of Red Alert' }),
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
  );
  const TABS = [
    ['oneclick', 'One-click install', oneClickPanel],
    ['manual', 'Other ways to install', manualPanel],
  ];
  const tabButtons = new Map();
  const tabList = el('div', { class: 'content-tabs', role: 'tablist', 'aria-label': 'Ways to install' });
  let tab = autoInstall ? 'oneclick' : 'manual';
  const showTab = (id, focus = false) => {
    tab = id;
    for (const [tid, , panel] of TABS) {
      const b = tabButtons.get(tid);
      const on = tid === id;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      panel.hidden = !on;
    }
    if (focus) tabButtons.get(id).focus();
  };
  for (const [id, label] of TABS) {
    const b = el('button', { type: 'button', class: 'content-tab', role: 'tab', id: `content-tab-${id}`, 'aria-controls': `content-panel-${id}` , text: label });
    b.addEventListener('click', () => showTab(id));
    // Arrow keys, Home and End move between the tabs (WAI-ARIA tabs).
    b.addEventListener('keydown', (e) => {
      const ids = TABS.map(([t]) => t);
      const i = ids.indexOf(id);
      const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: ids.length - 1 }[e.key];
      if (next === undefined) return;
      e.preventDefault();
      showTab(ids[(next + ids.length) % ids.length], true);
    });
    tabButtons.set(id, b);
    tabList.append(b);
  }
  /** Tabs only with the one-click install; without it the manual way alone. */
  const layoutTabs = () => {
    tabList.hidden = !autoInstall;
    if (!autoInstall) showTab('manual');
    else showTab(tab);
  };
  layoutTabs();

  root.replaceChildren(
    el(
      'section',
      { class: 'audio-content', 'aria-labelledby': 'content-install-title' },
      el('h2', { id: 'content-install-title', text: 'Install the original content' }),
      stateBox,
      progressBox,
      partList,
      result,
      tabList,
      oneClickPanel,
      manualPanel,
      files,
      folder,
    ),
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
    /** The one-click install of what is missing (installAll's click): runParts' outcome, or null. */
    download: () => runParts(),
    /** Run the one-click install for some parts (ONE_CLICK_PARTS ids). */
    installParts: (ids) => runParts(ids),
    cancel: () => abort?.abort(),
    get busy() {
      return running;
    },
    /** none, partial or complete (contentState), after the last refresh. */
    get level() {
      return current?.state.level ?? 'none';
    },
    /** Offer the one-click install or not (the account's flags changed). */
    setAutoInstall(on) {
      const was = autoInstall;
      autoInstall = !!on;
      // Newly allowed: the one-click tab comes first.
      if (autoInstall && !was) tab = 'oneclick';
      layoutTabs();
      renderAction();
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
  // The entry point shows the installed state too: a mark and its accessible name.
  let level = 'none';
  // The corner button and the other entries (`opts.entries`: the start screen's More, Original content).
  const entries = [button, ...(opts.entries ?? [])].filter(Boolean);
  const showLevel = (l) => {
    level = l;
    for (const b of entries) {
      b.dataset.state = l;
      if (l === 'none') b.removeAttribute('aria-label');
      else b.setAttribute('aria-label', `Original content (${ENTRY_STATES[l]})`);
    }
  };
  const view = mountContentSettings(body, content, audio, { ...opts, onState: showLevel });
  let opener = null;
  // `from`: what gets the focus back (a click does not focus a button in Safari and Firefox on macOS).
  const open = (on, from = null) => {
    if (on === !panel.hidden) return;
    panel.hidden = !on;
    for (const b of entries) b.setAttribute('aria-expanded', String(on));
    if (on) {
      opener = from ?? (document.activeElement && document.activeElement !== document.body ? document.activeElement : null);
      view.refresh();
      close.focus();
    } else {
      (opener instanceof HTMLElement && opener.isConnected ? opener : button)?.focus();
    }
  };
  if (button) {
    button.hidden = false;
    button.addEventListener('click', () => open(panel.hidden, button));
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
    open: (from = null) => open(true, from),
    /** The menu entry's label: "Original content", with the installed state once there is one. */
    get label() {
      return level === 'none' ? 'Original content' : `Original content (${ENTRY_STATES[level]})`;
    },
    /** Open the dialog and run the one-click install. */
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
  const auto = el('button', { type: 'button', class: 'primary', text: `Install everything (${formatBytes(ONE_CLICK_BYTES)})` });
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

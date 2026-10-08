// The "Original content" dialog (lobby button and game menu): the graphics
// choice, original sounds on or off, installing the original Red Alert
// content from the player's own files in one flow (sounds and graphics),
// and the texture pack manager.

import { GRAPHICS_SETTING } from './index.js';
import { packSummary, PackError } from './packs.js';
import { downloadQuickInstall, declinePrompt, DOWNLOAD_NOTICE, QUICKINSTALL_BYTES } from './download.js';

const ACCEPT_CONTENT = '.zip,.mix,.aud,.v00,.v01,.v02,.v03,.r00,.r01,.r02,.r03,.shp,.pal,.tem,.sno,.des';
const ACCEPT_PACK = '.webrapack,.zip';
/** Largest pack file read for the preview (content/packs.js PACK_LIMITS.maxArchiveBytes). */
const MAX_PACK_FILE = 64 * 1024 * 1024;
/**
 * OpenRA's quick install mirrors (OpenRA mods/ra/installer): EA's freeware
 * files as one ZIP, hosted by third parties. Plain links only: the player
 * downloads the file and picks or drops it here. The game never fetches
 * them (the mirrors send no CORS headers, and the game's CSP and COEP
 * forbid it), and WebRA's server never proxies them.
 */
export const QUICKINSTALL_MIRRORS = Object.freeze([
  'https://openra.baxxster.no/openra/ra-quickinstall.zip',
  'https://republic.community/hosted/files/command-and-conquer/openra/ra-quickinstall.zip',
  'https://openra.0x47.net/ra-quickinstall.zip',
  'https://openra.ppmsite.com/ra-quickinstall.zip',
]);

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

/** The installed summary as text (content/install.js contentSummary). */
export function summaryText(s) {
  if (!s.total) return 'Nothing installed. WebRA uses its own art and synthesized sounds.';
  const b = s.byCategory;
  const parts = [];
  const sounds = b.effects + b.voices + b.announcer + b.music;
  if (sounds) {
    parts.push(
      `Sounds: ${plural(b.effects, 'effect', 'effects')}, ${plural(b.voices, 'unit voice', 'unit voices')}, ${plural(b.announcer, 'announcer line', 'announcer lines')}, ${plural(b.music, 'music track', 'music tracks')} (${formatBytes(s.bytes.sounds)}).`,
    );
  }
  if (b.graphics) {
    const theaters = s.theaters.length ? s.theaters.map((t) => THEATER_NAMES[t] ?? t.toLowerCase()).join(', ') : 'none';
    parts.push(`Graphics: ${plural(b.graphics, 'file', 'files')} (${formatBytes(s.bytes.graphics)}); terrain for ${theaters}.`);
  }
  return `Installed on this device. ${parts.join(' ')}`;
}

/**
 * Build the dialog body into `root`.
 * @param {HTMLElement} root
 * @param {import('./index.js').ContentSystem} content
 * @param {import('../audio/index.js').AudioSystem | null} audio
 * @param {{ actorNames?: Map<string, string> }} [opts]
 */
export function mountContentSettings(root, content, audio, opts = {}) {
  root.classList.add('audio-settings', 'content-settings');
  const settings = content.settings;

  // ---- Graphics and sounds choice ---------------------------------------------------
  const radio = (value, label) => {
    const input = el('input', { type: 'radio', name: 'content-graphics', id: `content-graphics-${value}`, value });
    input.addEventListener('change', () => input.checked && settings.set(GRAPHICS_SETTING, value));
    return [input, el('label', { for: input.id, text: label })];
  };
  const [webra, webraLabel] = radio('webra', 'WebRA');
  const [original, originalLabel] = radio('original', 'Original Red Alert');
  const graphicsNote = el('p', { class: 'audio-note' });
  const sounds = el('input', { type: 'checkbox', id: 'content-sounds' });
  sounds.disabled = !audio;
  sounds.addEventListener('change', () => audio?.prefs.set({ original: sounds.checked }));

  // ---- Install ----------------------------------------------------------------------
  const status = el('p', { class: 'audio-status', role: 'status', 'aria-live': 'polite' });
  const progress = el('p', { class: 'audio-progress', 'aria-live': 'polite' });
  const files = el('input', { type: 'file', multiple: true, accept: ACCEPT_CONTENT, hidden: true });
  const folder = el('input', { type: 'file', multiple: true, hidden: true, webkitdirectory: true });
  const pickFiles = el('button', { type: 'button', class: 'primary', text: 'Choose files...' });
  const pickFolder = el('button', { type: 'button', text: 'Choose folder...' });
  const remove = el('button', { type: 'button', class: 'danger', text: 'Remove installed content' });
  pickFiles.addEventListener('click', () => files.click());
  pickFolder.addEventListener('click', () => folder.click());

  // ---- Packs ------------------------------------------------------------------------
  const packFile = el('input', { type: 'file', accept: ACCEPT_PACK, hidden: true });
  const pickPack = el('button', { type: 'button', text: 'Install texture pack...' });
  pickPack.addEventListener('click', () => packFile.click());
  const packList = el('ul', { class: 'content-packs' });
  const preview = el('div', { class: 'content-preview', hidden: true });
  const packStatus = el('p', { class: 'audio-progress', 'aria-live': 'polite' });

  const download = el('button', { type: 'button', class: 'primary', text: `Download original Red Alert content (${formatBytes(QUICKINSTALL_BYTES)})` });
  const downloadStatus = el('p', { class: 'audio-progress', 'aria-live': 'polite' });

  const busy = (on) => {
    for (const b of [pickFiles, pickFolder, remove, pickPack, download]) b.disabled = on;
  };

  const sync = async () => {
    const choice = content.graphics;
    webra.checked = choice === 'webra';
    original.checked = choice === 'original';
    original.disabled = !content.hasOriginalGraphics;
    graphicsNote.textContent = content.hasOriginalGraphics
      ? 'Original graphics: units, structures, infantry animations, cameos and terrain from your files. Effects keep WebRA art. The choice applies at once, also in a running game.'
      : 'Install the original content below to use the original graphics.';
    sounds.checked = !!audio?.prefs.get().original;
    try {
      const s = await content.summary();
      status.textContent = summaryText(s);
      remove.hidden = s.total === 0;
      if (content.storeError) status.textContent += ` (Browser storage is unavailable: ${content.storeError}. Installed content lasts until you leave this page.)`;
    } catch (err) {
      status.textContent = `Could not read installed content: ${err.message ?? err}`;
    }
    renderPacks();
  };

  const install = async (list) => {
    if (!list.length) return;
    busy(true);
    progress.textContent = 'Reading your files in this browser...';
    try {
      const r = await content.install(list, { onProgress: (t) => (progress.textContent = t) });
      const parts = [r.added ? `Installed ${plural(r.added, 'file', 'files')} (${formatBytes(r.bytes)}).` : 'No Red Alert sounds or graphics found in these files.'];
      if (r.archives.length) parts.push(`Read ${r.archives.join(', ')}.`);
      if (r.errors.length) parts.push(`Skipped: ${r.errors.slice(0, 3).join('; ')}${r.errors.length > 3 ? '; ...' : ''}`);
      progress.textContent = parts.join(' ');
      await audio?.reloadInstalled();
    } catch (err) {
      progress.textContent = `Install failed: ${err.message ?? err}`;
    } finally {
      busy(false);
      files.value = '';
      folder.value = '';
      sync();
    }
  };
  const fetchAndInstall = async () => {
    busy(true);
    downloadStatus.textContent = 'Starting the download...';
    let file;
    try {
      file = await downloadQuickInstall({
        onProgress: (n, total) => (downloadStatus.textContent = `Downloading: ${formatBytes(n)} of ${formatBytes(total)} (${Math.floor((n / total) * 100)}%)`),
      });
    } catch (err) {
      downloadStatus.textContent = `Download failed: ${err.message ?? err}. You can download the file from a mirror yourself and choose it below.`;
      busy(false);
      return;
    }
    downloadStatus.textContent = 'Downloaded. Installing...';
    busy(false);
    await install([file]);
    downloadStatus.textContent = '';
  };
  download.addEventListener('click', fetchAndInstall);

  files.addEventListener('change', () => install([...files.files]));
  folder.addEventListener('change', () => install([...folder.files]));
  remove.addEventListener('click', async () => {
    busy(true);
    try {
      await content.removeOriginal();
      if (content.graphics === 'original') settings.set(GRAPHICS_SETTING, 'webra');
      progress.textContent = 'Removed. WebRA uses its own art and synthesized sounds again.';
      await audio?.reloadInstalled();
    } catch (err) {
      progress.textContent = `Could not remove: ${err.message ?? err}`;
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
        const id = `content-pack-${i}`;
        const on = el('input', { type: 'checkbox', id });
        on.checked = !!r.enabled;
        on.disabled = !p.manifest;
        on.addEventListener('change', () => content.setPackEnabled(r.id, on.checked).then(sync));
        const up = el('button', { type: 'button', text: 'Up', title: 'Higher priority' });
        const down = el('button', { type: 'button', text: 'Down', title: 'Lower priority' });
        const del = el('button', { type: 'button', class: 'danger', text: 'Remove' });
        up.disabled = i === 0;
        down.disabled = i === packs.length - 1;
        up.addEventListener('click', () => content.movePack(r.id, -1).then(sync));
        down.addEventListener('click', () => content.movePack(r.id, 1).then(sync));
        del.addEventListener('click', () => content.removePack(r.id).then(sync));
        const info = `${r.name} ${r.version} by ${r.author} (${r.license}, ${formatBytes(r.size ?? 0)})`;
        const problems = p.problems.length ? el('p', { class: 'audio-note', text: `Not used: ${p.problems.slice(0, 2).join('; ')}` }) : null;
        return el('li', { class: 'content-pack' }, el('div', { class: 'audio-row audio-check' }, on, el('label', { for: id, text: info })), problems, el('div', { class: 'audio-buttons' }, up, down, del));
      }),
    );
  };

  content.onChange(() => sync());
  audio?.prefs.subscribe((v) => (sounds.checked = !!v.original));

  root.replaceChildren(
    el(
      'p',
      { class: 'audio-local' },
      'WebRA ships only its own art and sounds. Red Alert belongs to Electronic Arts, who released it as freeware in 2008: if you have a copy, WebRA can use its original graphics, sounds and music, as OpenRA does. Your files are read in this browser and stored on this device only. Nothing is uploaded, and WebRA never hosts or distributes them.',
    ),
    el(
      'section',
      { class: 'audio-content', 'aria-labelledby': 'content-use-title' },
      el('h2', { id: 'content-use-title', text: 'Use' }),
      el('div', { class: 'content-choice', role: 'radiogroup', 'aria-label': 'Graphics' }, el('span', { text: 'Graphics:' }), webra, webraLabel, original, originalLabel),
      graphicsNote,
      el('div', { class: 'audio-row audio-check' }, sounds, el('label', { for: 'content-sounds', text: 'Use original sounds and music' })),
    ),
    el(
      'section',
      { class: 'audio-content', 'aria-labelledby': 'content-get-title' },
      el('h2', { id: 'content-get-title', text: 'Get the files' }),
      el('p', { class: 'audio-note', text: DOWNLOAD_NOTICE }),
      el('div', { class: 'audio-buttons' }, download),
      downloadStatus,
      el('p', {
        class: 'audio-note',
        text: 'Or use your own Red Alert files, or download ra-quickinstall.zip yourself, the package OpenRA installs from: Electronic Arts\' 2008 freeware release, hosted by third parties. Get it from one of these mirrors, then choose it below or drop it on the game:',
      }),
      el(
        'ul',
        { class: 'content-mirrors' },
        ...QUICKINSTALL_MIRRORS.map((url) => el('li', {}, el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', text: new URL(url).hostname }))),
      ),
    ),
    el(
      'section',
      { class: 'audio-content', 'aria-labelledby': 'content-install-title' },
      el('h2', { id: 'content-install-title', text: 'Install from your copy of Red Alert' }),
      el('p', {
        class: 'audio-note',
        text: 'Choose ra-quickinstall.zip, or main.mix and redalert.mix (the freeware release or the CD), or the archives inside them (conquer.mix, hires.mix, temperat.mix, snow.mix, sounds.mix, allies.mix, russian.mix, speech.mix, scores.mix), or loose files. desert.mix from Tiberian Dawn adds desert terrain. Sounds and graphics are installed in one go.',
      }),
      status,
      el('div', { class: 'audio-buttons' }, pickFiles, pickFolder, remove),
      files,
      folder,
      progress,
    ),
    el(
      'section',
      { class: 'audio-content', 'aria-labelledby': 'content-packs-title' },
      el('h2', { id: 'content-packs-title', text: 'Texture packs' }),
      el('p', {
        class: 'audio-note',
        text: 'Packs (.webrapack or .zip) replace sprites, cameos, terrain and sounds. A pack wins over the original content, which wins over WebRA art; the first pack in the list wins over the ones below it.',
      }),
      packList,
      el('div', { class: 'audio-buttons' }, pickPack),
      packFile,
      packStatus,
      preview,
    ),
  );
  sync();
  return { refresh: sync, install, inspectPackFile, download: fetchAndInstall };
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
    panel.hidden = !on;
    button?.setAttribute('aria-expanded', String(on));
    if (on) {
      opener = document.activeElement;
      view.refresh();
      close.focus();
    } else {
      (opener instanceof HTMLElement ? opener : button)?.focus();
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
    /** Open the dialog and download the original content (the first start prompt's button). */
    download() {
      open(true);
      return view.download();
    },
    /**
     * Files dropped on the game or the lobby: texture packs get the install
     * preview, Red Alert files (ra-quickinstall.zip, .mix, loose files) the
     * normal install. Returns false when nothing in `files` is content.
     */
    async drop(files) {
      const list = [...files];
      const packs = list.filter((f) => /\.webrapack$/i.test(f.name));
      const zips = list.filter((f) => /\.zip$/i.test(f.name));
      const rest = list.filter((f) => /\.(mix|aud|v0\d|r0\d|shp|pal|tem|sno|des)$/i.test(f.name));
      // A ZIP with a manifest.json is a pack; any other ZIP goes to the installer.
      for (const z of zips) {
        const head = new Uint8Array(await z.arrayBuffer());
        if (await isPackZip(head)) packs.push(z);
        else rest.push(z);
      }
      if (!packs.length && !rest.length) return false;
      open(true);
      if (rest.length) await view.install(rest);
      for (const p of packs) await view.inspectPackFile(p);
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
 * The first start offer (once per browser until declined), like OpenRA's
 * content installer: a small card, never a silent download. The game works
 * fully without content.
 */
export function mountContentPrompt(host, { onDownload, onOpen }) {
  const card = el('div', { class: 'menu-card content-prompt', role: 'dialog', 'aria-labelledby': 'content-prompt-title' });
  const yes = el('button', { type: 'button', class: 'primary', text: `Download (${formatBytes(QUICKINSTALL_BYTES)})` });
  const more = el('button', { type: 'button', text: 'Other ways...' });
  const later = el('button', { type: 'button', text: 'Not now' });
  const never = el('button', { type: 'button', text: "Don't ask again" });
  const closeCard = () => card.remove();
  yes.addEventListener('click', () => {
    closeCard();
    onDownload();
  });
  more.addEventListener('click', () => {
    closeCard();
    onOpen();
  });
  later.addEventListener('click', closeCard);
  never.addEventListener('click', () => {
    declinePrompt();
    closeCard();
  });
  card.append(
    el('h2', { id: 'content-prompt-title', text: 'Original Red Alert graphics and sounds' }),
    el('p', { class: 'audio-note', text: 'WebRA plays with its own art and sounds. You can also use the original ones.' }),
    el('p', { class: 'audio-note', text: DOWNLOAD_NOTICE }),
    el('div', { class: 'audio-buttons' }, yes, more, later, never),
  );
  host.append(card);
  return { close: closeCard };
}

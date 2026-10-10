// The Original content dialog and the start screen notice (js/content/panel.js),
// on a fake DOM (dom-fixtures.mjs): steps, mirrors, drop zone, progress,
// result, one-click gating, dismissal, touch devices, CSP safety.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { installDom, uninstallDom, FakeEvent, click, check, settle, textOf } from './dom-fixtures.mjs';
import { mountContentSettings, mountContentPanel, mountContentNotice, installResultLines, contentState, classifyFiles, QUICKINSTALL_MIRRORS } from '../js/content/panel.js';
import { QUICKINSTALL_BYTES } from '../js/content/download.js';
import { createRegistry } from '../js/registry.js';
import { createSettings } from '../js/settings.js';
import { buildZip } from './oramap-fixtures.mjs';
import { MemoryStore } from '../js/content/store.js';

let doc;
beforeEach(() => {
  doc = installDom();
});
// The dialog refreshes its state asynchronously: let that finish on this DOM before it goes.
afterEach(async () => {
  await settle(10);
  uninstallDom();
});

const EMPTY = { total: 0, byCategory: { effects: 0, voices: 0, announcer: 0, music: 0, graphics: 0 }, bytes: { sounds: 0, graphics: 0 }, theaters: [], palette: false };
const REPORT = { added: 120, bytes: 9_000_000, byCategory: { effects: 40, voices: 30, announcer: 20, music: 10, graphics: 20 }, theaters: ['TEMPERAT', 'SNOW'], archives: ['ra-quickinstall.zip'], skipped: [], errors: [], switched: true };

/** A content system stand-in with the parts the dialog uses. */
function fakeContent({ install } = {}) {
  const registry = createRegistry({ storage: null });
  const settings = createSettings(registry);
  const listeners = new Set();
  const c = {
    settings,
    registry,
    installed: false,
    packs: [],
    storeError: null,
    calls: [],
    get graphics() {
      return settings.get('graphics');
    },
    get hasOriginalGraphics() {
      return this.installed;
    },
    onChange: (fn) => listeners.add(fn),
    /** The installed state's summary: none, the package (no music) or everything. */
    get level() {
      return this.installed ? (this.music ? 'complete' : 'partial') : 'none';
    },
    music: false,
    kept: null,
    async keptPackage() {
      return this.kept;
    },
    async summary() {
      if (!this.installed) return EMPTY;
      const byCategory = { ...REPORT.byCategory, music: this.music ? 15 : 0 };
      return { ...EMPTY, total: 120, byCategory, bytes: { sounds: 8e6, graphics: 1e6, movies: 0 }, theaters: ['TEMPERAT', 'SNOW'], palette: true, installedAt: Date.UTC(2026, 9, 9) };
    },
    install:
      install ??
      (async function (files, opts) {
        c.calls.push(files.map((f) => f.name));
        opts.onProgress('Unpacking ra-quickinstall.zip');
        c.installed = true;
        settings.set('graphics', 'original');
        for (const fn of listeners) fn();
        return REPORT;
      }),
    async removeOriginal() {
      c.installed = false;
      settings.set('graphics', 'webra');
    },
  };
  // The music's kept pieces live in the store (content/cdmusic.js).
  const store = new MemoryStore();
  c.store = async () => store;
  return c;
}

const fakeAudio = () => {
  let v = { original: true };
  const subs = new Set();
  return {
    reloads: 0,
    prefs: { get: () => v, set: (p) => ((v = { ...v, ...p }), subs.forEach((f) => f(v))), subscribe: (f) => subs.add(f) },
    async reloadInstalled() {
      this.reloads++;
    },
  };
};

const zipFile = (name = 'ra-quickinstall.zip') => new File([buildZip([{ name: 'conquer.mix', data: new Uint8Array(16) }])], name);

function dropEvent(files) {
  return new FakeEvent('drop', { dataTransfer: { types: ['Files'], files } });
}

function mount(content = fakeContent(), audio = fakeAudio(), opts = {}) {
  const root = doc.createElement('div');
  doc.body.append(root);
  const view = mountContentSettings(root, content, audio, opts);
  return { root, view, content, audio };
}

test('dialog: three steps with the mirrors (new tab, no referrer), the file and its size; legal notice', async () => {
  const { root } = mount();
  await settle();
  const steps = root.querySelectorAll('.content-steps > li');
  assert.equal(steps.length, 3);
  assert.match(textOf(steps[0]), /Download ra-quickinstall\.zip \(12\.9 MB, the same file on every mirror\)/);
  const links = root.querySelectorAll('.content-mirrors a');
  assert.equal(links.length, QUICKINSTALL_MIRRORS.length);
  for (const a of links) {
    assert.equal(a.getAttribute('target'), '_blank');
    assert.equal(a.getAttribute('rel'), 'noopener noreferrer');
    assert.match(a.getAttribute('href'), /^https:\/\/.+\/ra-quickinstall\.zip$/);
  }
  assert.match(textOf(steps[1]), /Drop the ZIP here/);
  assert.match(textOf(root.querySelector('.audio-local')), /Electronic Arts.*freeware in 2008.*does not host or distribute/);
  assert.match(textOf(root), /Nothing installed yet/);
  assert.equal(QUICKINSTALL_BYTES, 13_502_031);
});

test('dialog: without the one-click install only the manual way shows; with it, tabs with the one-click tab first', async () => {
  const { root, view } = mount();
  await settle();
  const tabs = root.querySelector('.content-tabs');
  const button = root.querySelector('.content-install-all');
  const manual = root.querySelector('#content-panel-manual');
  const oneClick = root.querySelector('#content-panel-oneclick');
  assert.equal(tabs.hidden, true, 'no tabs without the one-click install');
  assert.equal(button.hidden, true);
  assert.equal(manual.hidden, false);
  assert.equal(oneClick.hidden, true);
  view.setAutoInstall(true);
  assert.equal(tabs.hidden, false);
  assert.equal(button.hidden, false);
  assert.match(textOf(button), /^Install everything \(74\.1 MB\)$/);
  assert.equal(oneClick.hidden, false, 'the one-click tab comes first');
  assert.equal(manual.hidden, true, 'the manual steps wait behind their tab');
  const [first, second] = tabs.querySelectorAll('[role="tab"]');
  assert.equal(first.getAttribute('aria-selected'), 'true');
  assert.equal(first.getAttribute('aria-controls'), 'content-panel-oneclick');
  assert.equal(oneClick.getAttribute('aria-labelledby'), first.id);
  // Arrow keys move between the tabs.
  first.dispatchEvent(new FakeEvent('keydown', { key: 'ArrowRight' }));
  assert.equal(second.getAttribute('aria-selected'), 'true');
  assert.equal(manual.hidden, false);
  assert.equal(Number(second.tabIndex), 0);
  assert.equal(Number(first.tabIndex), -1);
  click(first);
  assert.match(textOf(oneClick), /graphics, sounds, unit voices, the announcer and the music/);
  assert.match(textOf(oneClick), /passed through, never kept on the server/);
  view.setAutoInstall(false);
  assert.equal(tabs.hidden, true);
  assert.equal(manual.hidden, false);
  const { root: root2 } = mount(fakeContent(), fakeAudio(), { autoInstall: true });
  await settle();
  assert.equal(root2.querySelector('.content-install-all').hidden, false);
});

test('installed state: none, partly with what is missing, and complete with counts, date and only check, reinstall and remove', async () => {
  const content = fakeContent();
  const states = [];
  const { root, view } = mount(content, fakeAudio(), { autoInstall: true, onState: (l) => states.push(l) });
  await settle();
  const box = root.querySelector('.content-state');
  const button = root.querySelector('.content-install-all');
  const named = (re) => root.querySelectorAll('button').find((b) => re.test(b.textContent));
  assert.equal(box.dataset.level, 'none');
  assert.match(textOf(box), /Not installed.*Nothing installed yet/);
  assert.equal(named(/^Reinstall/).hidden, true);
  assert.equal(named(/^Remove installed content$/).hidden, true);
  // The package only: partly installed, the music is missing, the button installs the missing part.
  content.installed = true;
  await view.refresh();
  assert.equal(box.dataset.level, 'partial');
  assert.match(textOf(box), /Partly installed/);
  assert.match(textOf(box.querySelector('.content-missing')), /^Music \(scores\.mix: not in ra-quickinstall\.zip/);
  assert.match(textOf(button), /^Install missing parts \(61\.2 MB\)$/);
  assert.equal(button.disabled, false);
  // Everything: a success state, the button off, only the secondary actions.
  content.music = true;
  content.kept = { file: new File(['z'], 'ra-quickinstall.zip'), checked: new Set() };
  await view.refresh();
  assert.equal(box.dataset.level, 'complete');
  assert.match(textOf(box.querySelector('h3')), /Original content installed/);
  assert.match(textOf(box), /Graphics: 20 files \(.*\), terrain for temperate, snow/);
  assert.match(textOf(box), /Sound effects: 40.*Unit voices: 30.*Announcer \(EVA\): 20 lines.*Music: 15 tracks/);
  assert.match(textOf(box), /Installed .*2026\. .* in this browser/);
  assert.equal(box.querySelector('.content-missing').hidden, true);
  assert.equal(button.textContent, 'Everything is installed');
  assert.equal(button.disabled, true);
  assert.equal(named(/^Check for missing files$/).hidden, false, 'with a kept ZIP');
  assert.equal(named(/^Remove installed content$/).hidden, false);
  // Reinstall asks first.
  click(named(/^Reinstall/));
  const confirm = root.querySelector('.content-confirm');
  assert.equal(confirm.hidden, false);
  assert.match(textOf(confirm), /This downloads 61\.2 MB; the graphics and sounds come from the kept ZIP/);
  click(named(/^Keep it$/));
  assert.equal(confirm.hidden, true);
  assert.deepEqual(states.slice(-3), ['none', 'partial', 'complete']);
  assert.equal(view.level, 'complete');
});

test('installed state: the lobby button and the menu label say it', async () => {
  const button = doc.createElement('button');
  const panel = doc.createElement('div');
  panel.hidden = true;
  doc.body.append(button, panel);
  const content = fakeContent();
  content.installed = true;
  content.music = true;
  const p = mountContentPanel(button, panel, content, fakeAudio(), {});
  await settle(10);
  assert.equal(button.dataset.state, 'complete');
  assert.equal(button.getAttribute('aria-label'), 'Original content (installed)');
  assert.equal(p.label, 'Original content (installed)');
});

test('contentState: what is missing, by part', () => {
  const s = (byCategory, more = {}) => ({ total: 1, byCategory: { effects: 0, voices: 0, announcer: 0, music: 0, graphics: 0, movies: 0, ...byCategory }, bytes: { sounds: 1, graphics: 1 }, theaters: [], palette: true, ...more });
  assert.equal(contentState(EMPTY).level, 'none');
  const soundsOnly = contentState(s({ effects: 5 }));
  assert.equal(soundsOnly.level, 'partial');
  assert.deepEqual(soundsOnly.parts, { package: true, music: true });
  assert.match(soundsOnly.missing.join('|'), /^Graphics: .*\|Unit voices.*\|Announcer \(EVA\).*\|Music/);
  const noPalette = contentState(s({ effects: 5, voices: 1, announcer: 1, music: 3, graphics: 30 }, { palette: false, theaters: ['TEMPERAT', 'SNOW'] }));
  assert.deepEqual(noPalette.missing, ['The palette from temperat.mix (the graphics cannot be used without it)']);
  const noSnow = contentState(s({ effects: 5, voices: 1, announcer: 1, music: 3, graphics: 30 }, { theaters: ['TEMPERAT'] }));
  assert.deepEqual(noSnow.missing, ['Terrain for snow maps']);
  assert.deepEqual(noSnow.parts, { package: true, music: false });
  const all = contentState(s({ effects: 5, voices: 1, announcer: 1, music: 3, graphics: 30 }, { theaters: ['TEMPERAT', 'SNOW'] }));
  assert.equal(all.level, 'complete');
  assert.match(all.installed.at(-1), /Movies: none/, 'movies are said, never missing');
});

test('dialog: dropping the ZIP on the drop zone installs it with progress, then shows what came in and the switch', async () => {
  const content = fakeContent();
  const audio = fakeAudio();
  const { root } = mount(content, audio);
  const zone = root.querySelector('.content-dropzone');
  const over = new FakeEvent('dragover', { dataTransfer: { types: ['Files'] } });
  zone.dispatchEvent(over);
  assert.equal(over.defaultPrevented, true, 'the zone accepts files');
  let pageSaw = 0;
  doc.body.addEventListener('drop', () => pageSaw++);
  const ev = dropEvent([zipFile()]);
  zone.dispatchEvent(ev);
  assert.equal(ev.defaultPrevented, true);
  assert.equal(pageSaw, 0, 'the page drop handler does not install it again');
  await settle(20);
  assert.deepEqual(content.calls, [['ra-quickinstall.zip']]);
  assert.equal(audio.reloads, 1, 'sounds reload without a page reload');
  const result = root.querySelector('.content-result');
  assert.equal(result.hidden, false);
  assert.match(textOf(result), /Installed 120 files/);
  assert.match(textOf(result), /terrain for temperate, snow/);
  assert.match(textOf(result), /now uses the original graphics/);
  const useAll = root.querySelector('#content-use-all');
  assert.equal(useAll.checked, true);
  check(useAll, false);
  assert.equal(content.settings.get('graphics'), 'webra');
  assert.equal(audio.prefs.get().original, false);
  check(useAll, true);
  assert.equal(content.settings.get('graphics'), 'original');
  assert.equal(root.querySelector('#content-graphics-original').checked, true);
  assert.match(textOf(root.querySelector('.content-state')), /Graphics: 20 files/);
  assert.equal(root.querySelector('.content-progress').hidden, true, 'progress goes when done');
});

test('dialog: one install at a time; failures say nothing changed; unrelated files are named', async () => {
  let release;
  const content = fakeContent({
    install: async (_files, opts) => {
      opts.onProgress('Reading main.mix');
      await new Promise((r) => (release = r));
      throw new Error('This browser has no room left for the files. Nothing was installed.');
    },
  });
  const { root, view } = mount(content);
  const first = view.install([zipFile()]);
  await settle();
  assert.equal(root.querySelector('.content-progress').hidden, false);
  assert.match(textOf(root.querySelector('.content-progress')), /Reading main\.mix/);
  assert.equal(root.querySelector('.content-dropzone').disabled, true);
  assert.equal(root.getAttribute('aria-busy'), 'true');
  assert.equal(await view.install([zipFile()]), null);
  assert.match(textOf(root.querySelector('.content-progress')), /already running/);
  release();
  await first;
  const result = root.querySelector('.content-result');
  assert.match(textOf(result), /Install failed/);
  assert.match(textOf(result), /no room left/);
  assert.match(textOf(result), /Nothing on this device changed/);
  assert.equal(root.querySelector('#content-use-all').closest('.audio-row').hidden, true);
  assert.equal(root.querySelector('.content-dropzone').disabled, false);
  assert.equal(await view.handleFiles([new File(['x'], 'notes.txt')]), false);
  assert.match(textOf(result), /Not Red Alert content/);
});

test('dialog: a refused one-click install says why per part and points to the manual way', async () => {
  const { root, view } = mount(fakeContent(), fakeAudio(), {
    autoInstall: true,
    fetchImpl: async () => new Response(JSON.stringify({ error: { code: 'relay_forbidden', message: 'not for you' } }), { status: 403 }),
  });
  await settle();
  const out = await view.download();
  assert.deepEqual(out.failed, ['package', 'music']);
  const parts = root.querySelectorAll('.content-part');
  assert.equal(parts.length, 2);
  for (const p of parts) {
    assert.equal(p.dataset.phase, 'failed');
    assert.match(textOf(p), /failed: the one-click download is only for selected accounts/);
    assert.equal(p.querySelector('button').hidden, false, 'a retry per failed part');
  }
  assert.match(textOf(root.querySelector('.content-result')), /Install incomplete.*Other ways to install/);
});

test('dialog: on phones the drop zone is a file picker and the folder picker is hidden', async () => {
  uninstallDom();
  doc = installDom({ coarse: true });
  const { root } = mount();
  const zone = root.querySelector('.content-dropzone');
  assert.match(textOf(zone), /Choose ra-quickinstall\.zip/);
  assert.match(textOf(zone), /Tap to pick/);
  const files = root.querySelector('input[type="file"]');
  click(zone);
  assert.equal(files.clicks, 1, 'the zone opens the file picker');
  const folderButton = root.querySelectorAll('button').find((b) => /Choose folder/.test(b.textContent));
  assert.equal(folderButton.hidden, true);
});

test('dialog panel: drop() opens the dialog only for content; Escape closes it', async () => {
  const button = doc.createElement('button');
  const panel = doc.createElement('section');
  panel.hidden = true;
  doc.body.append(button, panel);
  const content = fakeContent();
  const p = mountContentPanel(button, panel, content, fakeAudio());
  assert.equal(await p.drop([new File(['x'], 'photo.png')]), false);
  assert.equal(panel.hidden, true);
  assert.equal(await p.drop([zipFile()]), true);
  assert.equal(panel.hidden, false);
  assert.deepEqual(content.calls, [['ra-quickinstall.zip']]);
  const esc = new FakeEvent('keydown', { key: 'Escape' });
  panel.dispatchEvent(esc);
  assert.equal(panel.hidden, true);
  assert.equal(esc.propagationStopped, true, 'keys do not reach the game');
});

test('notice: steps, file picker, more options; dismissal is remembered in the synced settings', async () => {
  const registry = createRegistry({ storage: null });
  const got = [];
  let opened = 0;
  const n = mountContentNotice(doc.body, { registry, onFiles: (f) => got.push(f.map((x) => x.name)), onOpen: () => opened++, onDownload: () => {} });
  const card = doc.body.querySelector('.content-notice');
  assert.equal(card.getAttribute('role'), 'region');
  assert.equal(card.querySelectorAll('.content-steps > li').length, 3);
  assert.equal(card.querySelectorAll('.content-mirrors a').length, QUICKINSTALL_MIRRORS.length);
  assert.match(textOf(card), /Drag the ZIP onto this page/);
  assert.equal(card.querySelector('.content-auto').hidden, true, 'no one-click for everyone');
  n.setAutoInstall(true);
  assert.equal(card.querySelector('.content-auto').hidden, false);
  const input = card.querySelector('input[type="file"]');
  input.files = [zipFile()];
  input.dispatchEvent(new FakeEvent('change'));
  assert.deepEqual(got, [['ra-quickinstall.zip']]);
  click(card.querySelectorAll('button').find((b) => /More options/.test(b.textContent)));
  assert.equal(opened, 1);
  click(card.querySelector('.content-notice-close'));
  assert.equal(n.open, false);
  assert.equal(registry.get('extra', 'contentNoticeDismissed'), true);
});

test('result text: what came in, what was skipped, and a kept ZIP', () => {
  assert.match(installResultLines({ ...REPORT, added: 0, errors: [] }).join(' '), /No Red Alert sounds or graphics were found/);
  assert.match(installResultLines({ ...REPORT, switched: false, errors: ['a', 'b', 'c', 'd'] }).join(' '), /Skipped: a; b; c; \.\.\./);
  assert.match(installResultLines({ ...REPORT, kept: true }).join(' '), /ra-quickinstall\.zip is kept on this device/);
});

test('classifyFiles: packs by name or manifest, content, and the rest', async () => {
  const pack = new File([buildZip([{ name: 'manifest.json', data: '{}' }])], 'tanks.zip');
  const r = await classifyFiles([pack, zipFile(), new File(['x'], 'MAIN.MIX'), new File(['x'], 'a.webrapack'), new File(['x'], 'b.txt')]);
  assert.deepEqual(r.packs.map((f) => f.name), ['tanks.zip', 'a.webrapack']);
  assert.deepEqual(r.content.map((f) => f.name), ['ra-quickinstall.zip', 'MAIN.MIX']);
  assert.deepEqual(r.other.map((f) => f.name), ['b.txt']);
});

test('CSP safety: the content UI builds the DOM with text only, no HTML strings or inline styles', () => {
  for (const rel of ['../js/content/panel.js', '../js/audio/panel.js']) {
    const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|setAttribute\(\s*['"]style/, rel);
  }
});

test('a running game repaints its sidebar cameos and waits for installed content before it starts', async () => {
  const { Sidebar } = await import('../js/sidebar.js');
  const painted = [];
  const fake = { cards: new Map([['1TNK', { canvas: 'c1', actor: { id: '1TNK' } }], ['E1', { canvas: 'c2', actor: { id: 'E1' } }]]), paintIcon: (c, a) => painted.push([c, a.id]) };
  Sidebar.prototype.repaintIcons.call(fake);
  assert.deepEqual(painted, [['c1', '1TNK'], ['c2', 'E1']]);
  const main = readFileSync(fileURLToPath(new URL('../js/main.js', import.meta.url)), 'utf8');
  const launch = main.slice(main.indexOf('async function launch('), main.indexOf('async function startSkirmish('));
  assert.ok(launch.indexOf('await content?.load()') >= 0 && launch.indexOf('await content?.load()') < launch.indexOf('newSimHost()'), 'content loads before the game starts');
  assert.match(main, /content\?\.onChange\(\(\) => \{\s*applyArt\(\);\s*applyTerrain\(\);[^}]*sidebar\?\.repaintIcons\(\);/);
});

test('the toast lives outside the game view, so a message about a file dropped on the lobby shows', () => {
  const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
  const app = html.slice(html.indexOf('<div id="app"'), html.indexOf('</aside>'));
  assert.equal(app.includes('id="toast"'), false);
  assert.match(html, /<div id="toast" role="status" hidden><\/div>/);
  const css = readFileSync(fileURLToPath(new URL('../css/style.css', import.meta.url)), 'utf8');
  assert.match(css, /#toast \{\s*position: fixed;/);
});

test('dialog: Graphics and Sounds are segmented controls (WebRA | Original); Original waits for installed content', async () => {
  const content = fakeContent();
  const audio = fakeAudio();
  audio.prefs.set({ original: false });
  const { root, view: viewOf } = mount(content, audio);
  await settle();
  const gfx = root.querySelector('[role="radiogroup"][aria-label="Graphics"]');
  const snd = root.querySelector('[role="radiogroup"][aria-label="Sounds"]');
  assert.ok(gfx.classList.contains('ui-segmented') && snd.classList.contains('ui-segmented'));
  assert.deepEqual(gfx.querySelectorAll('label').map((l) => l.textContent), ['WebRA', 'Original']);
  assert.equal(root.querySelectorAll('input[type="radio"]').length, 4);

  // Nothing installed: Original is off for both, with the reason in a note the group points to.
  const gOriginal = root.querySelector('#content-graphics-original');
  const sOriginal = root.querySelector('#content-sounds-original');
  assert.equal(gOriginal.disabled, true);
  assert.equal(sOriginal.disabled, true);
  assert.equal(root.querySelector('#content-graphics-webra').checked, true);
  assert.equal(root.querySelector('#content-sounds-webra').checked, true);
  const note = root.querySelector(`#${gfx.getAttribute('aria-describedby')}`);
  assert.match(textOf(note), /Original is off until the original content is installed/);
  assert.match(root.querySelector('label[for="content-graphics-original"]').getAttribute('title'), /Install the original content/);
  assert.match(textOf(root.querySelector(`#${snd.getAttribute('aria-describedby')}`)), /Original is off until/);

  // Installed: Original can be chosen and sets the same settings as the old radios and checkbox.
  content.installed = true;
  await viewOf.refresh();
  await settle();
  assert.equal(gOriginal.disabled, false);
  assert.equal(sOriginal.disabled, false);
  assert.equal(root.querySelector('label[for="content-graphics-original"]').hasAttribute('title'), false);
  check(gOriginal, true);
  assert.equal(content.settings.get('graphics'), 'original');
  check(sOriginal, true);
  assert.equal(audio.prefs.get().original, true);
  check(root.querySelector('#content-graphics-webra'), true);
  assert.equal(content.settings.get('graphics'), 'webra');
  check(root.querySelector('#content-sounds-webra'), true);
  assert.equal(audio.prefs.get().original, false);
});

test('dialog: the segmented controls follow changes made elsewhere (Sound dialog, install)', async () => {
  const content = fakeContent();
  const audio = fakeAudio();
  const { root } = mount(content, audio);
  await settle();
  audio.prefs.set({ original: false });
  assert.equal(root.querySelector('#content-sounds-webra').checked, true);
  assert.equal(root.querySelector('#content-sounds-original').checked, false);
  audio.prefs.set({ original: true });
  assert.equal(root.querySelector('#content-sounds-original').checked, true);
  // An install switches the graphics: the group shows it.
  await content.install([zipFile()], { onProgress() {} });
  await settle();
  assert.equal(root.querySelector('#content-graphics-original').checked, true);
  assert.equal(root.querySelector('#content-graphics-webra').checked, false);
});

test('dialog: the use-all switch is a labelled switch and keeps both settings together', async () => {
  const { root, content, audio } = mount();
  await settle();
  const useAll = root.querySelector('#content-use-all');
  assert.equal(useAll.getAttribute('role'), 'switch');
  assert.equal(root.querySelector('label[for="content-use-all"]').textContent, 'Use the original graphics and sounds');
  content.installed = true;
  check(useAll, true);
  assert.equal(useAll.getAttribute('aria-checked'), 'true');
  assert.equal(content.settings.get('graphics'), 'original');
  assert.equal(audio.prefs.get().original, true);
});

test('dialog: pack rows have an on/off switch, a priority line, order buttons and remove', async () => {
  const content = fakeContent();
  const moved = [];
  const enabled = [];
  content.packs = ['a', 'b'].map((id, i) => ({
    record: { id, name: `Pack ${id}`, version: '1.0', author: 'Someone', license: 'CC0', size: 2048, enabled: i === 0 },
    manifest: {},
    problems: [],
  }));
  content.movePack = async (id, d) => moved.push([id, d]);
  content.setPackEnabled = async (id, on) => enabled.push([id, on]);
  content.removePack = async () => {};
  const { root } = mount(content);
  await settle();
  const rows = root.querySelectorAll('.content-pack');
  assert.equal(rows.length, 2);
  const sw = rows[0].querySelector('input[role="switch"]');
  assert.equal(sw.checked, true);
  assert.equal(sw.getAttribute('aria-checked'), 'true');
  assert.match(rows[0].querySelector(`label[for="${sw.id}"]`).textContent, /Pack a 1\.0 by Someone \(CC0, 2 KB\)/);
  assert.match(textOf(rows[1]), /Priority 2 of 2/);
  check(rows[1].querySelector('input[role="switch"]'), true);
  assert.deepEqual(enabled, [['b', true]]);
  const [up0, down0] = rows[0].querySelectorAll('button');
  assert.equal(up0.disabled, true, 'the first pack cannot move up');
  click(down0);
  assert.deepEqual(moved, [['a', 1]]);
  assert.equal(rows[1].querySelectorAll('button')[1].disabled, true, 'the last pack cannot move down');
});

test('install everything: one progress over the package and the music, a line per part, one Cancel, then resume', async () => {
  const content = fakeContent();
  const calls = [];
  // The package arrives whole; the music relay hangs until the request is aborted.
  const fetchImpl = (url, init) => {
    calls.push({ url, init });
    if (url === '/api/content/ra-quickinstall') return Promise.resolve(new Response(new Uint8Array(QUICKINSTALL_BYTES), { status: 200 }));
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  };
  const { root, view } = mount(content, fakeAudio(), { autoInstall: true, fetchImpl });
  await settle();
  const button = root.querySelector('.content-install-all');
  const cancel = root.querySelectorAll('button').find((b) => b.textContent === 'Cancel' && b.closest('.content-actions'));
  assert.equal(cancel.hidden, true);
  click(button);
  await settle(30);
  assert.deepEqual(calls.map((c) => c.url), ['/api/content/ra-quickinstall', '/api/content/ra-scores'], 'the package, then the music');
  assert.equal(cancel.hidden, false, 'one Cancel while it runs');
  assert.equal(button.disabled, true);
  const progress = root.querySelector('.content-progress');
  assert.equal(progress.querySelector('[aria-live="polite"]') !== null, true);
  assert.match(textOf(progress), /Installing the original content: 12\.9 MB of 74\.1 MB \(17%\)/);
  const [pkg, music] = root.querySelectorAll('.content-part');
  assert.equal(pkg.dataset.phase, 'done');
  assert.match(textOf(pkg), /Graphics, sounds, voices and announcer.*done: 120 files/);
  assert.equal(music.dataset.phase, 'running');
  assert.deepEqual(content.calls, [['ra-quickinstall.zip']]);
  click(cancel);
  await settle(30);
  assert.equal(cancel.hidden, true);
  assert.equal(music.dataset.phase, 'cancelled');
  assert.match(textOf(music), /cancelled; the parts already downloaded are kept/);
  assert.match(textOf(root.querySelector('.content-result')), /Install cancelled.*Installed 120 files.*music goes on where it stopped/);
  // Partly installed now: the button installs what is missing (the music).
  assert.match(textOf(button), /^Install missing parts \(61\.2 MB\)$/);
  assert.equal(button.disabled, false);
  // Retry only the music from its line.
  calls.length = 0;
  click(music.querySelector('button'));
  await settle(10);
  assert.deepEqual(calls.map((c) => c.url), ['/api/content/ra-scores']);
  view.cancel();
  await settle(20);
});

test('install everything: a used up budget (429) says when to try again and is never retried on its own', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'This account has used its one-click downloads for today.', retryAfter: 5400, scope: 'account' } }), {
      status: 429,
      headers: { 'Retry-After': '5400' },
    });
  };
  const content = fakeContent();
  const { root, view } = mount(content, fakeAudio(), { autoInstall: true, fetchImpl });
  await settle();
  const out = await view.download();
  assert.deepEqual(calls, ['/api/content/ra-quickinstall', '/api/content/ra-scores'], 'one request per part, no retry');
  assert.deepEqual(out.failed, ['package', 'music']);
  const [pkg] = root.querySelectorAll('.content-part');
  assert.match(textOf(pkg), /This account has used its one-click downloads for today: try again in 90 minutes \(at .+\), or install the files yourself/);
  assert.equal(pkg.querySelector('button').disabled, true, 'its retry waits for the budget');
  const button = root.querySelector('.content-install-all');
  assert.match(textOf(button), /^Try again in 90 minutes/);
  assert.equal(button.disabled, true);
  await settle(20);
  assert.equal(calls.length, 2, 'still no retry');
});

test('install everything: a kept ZIP installs without a download', async () => {
  const calls = [];
  const content = fakeContent();
  content.kept = { file: new File([new Uint8Array(4)], 'ra-quickinstall.zip'), checked: new Set() };
  const { root, view } = mount(content, fakeAudio(), {
    autoInstall: true,
    fetchImpl: async (url) => {
      calls.push(url);
      return new Response('{}', { status: 500 });
    },
  });
  await settle();
  // Nothing installed: both parts are needed, but the package comes from the kept ZIP.
  assert.match(textOf(root.querySelector('.content-install-all')), /^Install everything \(61\.2 MB\)$/, 'the package needs no download');
  await view.installParts(['package']);
  assert.deepEqual(calls, []);
  assert.deepEqual(content.calls, [['ra-quickinstall.zip']]);
  assert.match(textOf(root.querySelector('.content-part')), /done: 120 files/);
});

test('dialog: everyone gets the freeware CD images as plain links, and an .iso is content', async () => {
  const { root } = mount();
  await settle();
  const links = root.querySelectorAll('.content-cds a');
  assert.equal(links.length, 2);
  for (const a of links) {
    assert.match(a.getAttribute('href'), /^https:\/\/archive\.org\/download\/command-conquer-red-alert_202309\/.+\.ISO$/);
    assert.equal(a.getAttribute('rel'), 'noopener noreferrer');
  }
  assert.match(textOf(root.querySelector('#content-panel-manual .content-other')), /drop the \.iso here.*never the whole image/);
  const r = await classifyFiles([new File([new Uint8Array(4)], 'CD1_ALLIED_DISC.ISO'), new File(['x'], 'notes.txt')]);
  assert.deepEqual(r.content.map((f) => f.name), ['CD1_ALLIED_DISC.ISO']);
});

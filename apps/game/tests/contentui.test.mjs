// The Original content dialog and the start screen notice (js/content/panel.js),
// on a fake DOM (dom-fixtures.mjs): steps, mirrors, drop zone, progress,
// result, one-click gating, dismissal, touch devices, CSP safety.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { installDom, uninstallDom, FakeEvent, click, check, settle, textOf } from './dom-fixtures.mjs';
import { mountContentSettings, mountContentPanel, mountContentNotice, installResultLines, summaryText, classifyFiles, QUICKINSTALL_MIRRORS } from '../js/content/panel.js';
import { QUICKINSTALL_BYTES } from '../js/content/download.js';
import { createRegistry } from '../js/registry.js';
import { createSettings } from '../js/settings.js';
import { buildZip } from './oramap-fixtures.mjs';

let doc;
beforeEach(() => {
  doc = installDom();
});
afterEach(() => uninstallDom());

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
    async summary() {
      return this.installed ? { ...EMPTY, total: 120, byCategory: REPORT.byCategory, bytes: { sounds: 8e6, graphics: 1e6 }, theaters: ['TEMPERAT'], palette: true } : EMPTY;
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

test('dialog: the one-click download is only there when the account may use it', async () => {
  const { root, view } = mount();
  const auto = root.querySelector('.content-auto');
  assert.equal(auto.hidden, true);
  view.setAutoInstall(true);
  assert.equal(auto.hidden, false);
  assert.match(textOf(auto), /Download and install \(12\.9 MB\)/);
  assert.match(textOf(auto), /passed through, never kept on the server/);
  view.setAutoInstall(false);
  assert.equal(auto.hidden, true);
  const { root: root2 } = mount(fakeContent(), fakeAudio(), { autoInstall: true });
  assert.equal(root2.querySelector('.content-auto').hidden, false);
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
  assert.match(textOf(root.querySelector('.audio-status')), /Installed on this device/);
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

test('dialog: a refused or failed one-click download points to the manual steps', async () => {
  const { root, view } = mount(fakeContent(), fakeAudio(), {
    autoInstall: true,
    fetchImpl: async () => new Response(JSON.stringify({ error: { code: 'relay_forbidden', message: 'not for you' } }), { status: 403 }),
  });
  await view.download();
  assert.match(textOf(root.querySelector('.content-result')), /Download failed.*selected accounts.*step 1/);
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

test('result and summary text: partial installs say what is missing', () => {
  assert.match(installResultLines({ ...REPORT, added: 0, errors: [] }).join(' '), /No Red Alert sounds or graphics were found/);
  assert.match(installResultLines({ ...REPORT, switched: false, errors: ['a', 'b', 'c', 'd'] }).join(' '), /Skipped: a; b; c; \.\.\./);
  const soundsOnly = { total: 5, byCategory: { effects: 5, voices: 0, announcer: 0, music: 0, graphics: 0 }, bytes: { sounds: 100, graphics: 0 }, theaters: [], palette: false };
  assert.match(summaryText(soundsOnly), /Graphics: none \(they come from conquer\.mix/);
  const noPalette = { ...soundsOnly, byCategory: { ...soundsOnly.byCategory, graphics: 30 } };
  assert.match(summaryText(noPalette), /palette from temperat\.mix is missing/);
  const graphicsOnly = { total: 30, byCategory: { effects: 0, voices: 0, announcer: 0, music: 0, graphics: 30 }, bytes: { sounds: 0, graphics: 100 }, theaters: ['TEMPERAT'], palette: true };
  assert.match(summaryText(graphicsOnly), /Sounds: none/);
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

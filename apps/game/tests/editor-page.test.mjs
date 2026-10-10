// The map editor page (editor/index.html): it loads the game's theme, base
// sheet and themed controls before its own sheet, resolves every file
// against /play/ whatever spelling of its URL loaded it, every file it
// names exists, and every colour, font and size its sheets use is defined.
// (The editor once lost every colour and font when the theme tokens moved
// into css/theme.css, which only the game page linked.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const GAME = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(join(GAME, rel), 'utf8');
const HTML = read('editor/index.html');

/** The game file a URL of the page resolves to, for each spelling of the page's own URL. */
function resolveFrom(pageUrl, ref) {
  const base = HTML.match(/<base href="([^"]+)"/)?.[1];
  const baseUrl = new URL(base ?? '', pageUrl);
  const u = new URL(ref, baseUrl);
  return u.pathname;
}

const SPELLINGS = ['https://webra.sherin.dev/play/editor/', 'https://webra.sherin.dev/play/editor', 'https://webra.sherin.dev/play/editor/index.html', 'https://webra.sherin.dev/play/editor/?map=abc'];

test('the base is absolute (/play/): every spelling of the editor URL resolves its files the same', () => {
  assert.match(HTML, /<base href="\/play\/" \/>/);
  const refs = [...HTML.matchAll(/(?:href|src)="([^"#]+)"/g)].map((m) => m[1]).filter((r) => r !== '/play/');
  assert.ok(refs.length >= 5);
  for (const ref of refs) {
    const paths = new Set(SPELLINGS.map((p) => resolveFrom(p, ref)));
    assert.equal(paths.size, 1, `${ref} resolves differently: ${[...paths].join(', ')}`);
    const path = [...paths][0];
    assert.ok(path.startsWith('/play/'), `${ref} stays in the game (${path})`);
    const file = path === '/play/' ? 'index.html' : path.slice('/play/'.length);
    assert.ok(existsSync(join(GAME, file)), `${ref} -> ${path} exists`);
  }
});

test('the game theme, base sheet and themed controls load before the editor sheet', () => {
  const sheets = [...HTML.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(sheets.slice(0, 3), ['css/theme.css', 'css/style.css', 'css/controls.css']);
  assert.equal(sheets.at(-1), 'editor/editor.css');
  assert.equal(new Set(sheets).size, sheets.length, 'each once');
  assert.doesNotMatch(HTML, /\sstyle=/, 'no style attributes (the CSP blocks them)');
  assert.doesNotMatch(HTML, /<style|<script(?![^>]*\bsrc=)/, 'no inline style or script');
});

/** Custom properties a sheet defines (`--name:` declarations). */
const definedIn = (css) => new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));

test('every custom property the editor page uses is defined by its sheets or set by its scripts', () => {
  const sheets = [...HTML.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]);
  const css = sheets.map((s) => read(s));
  const defined = new Set(css.flatMap((c) => [...definedIn(c)]));
  // Set at run time through the CSSOM (style.setProperty), e.g. the slider fill.
  const scripts = ['js/ui/controls.js', 'editor/editor.js', ...['art', 'controller', 'ui', 'view', 'preview'].map((m) => `editor/js/${m}.js`)];
  for (const s of scripts) for (const m of read(s).matchAll(/setProperty\('(--[a-z0-9-]+)'/g)) defined.add(m[1]);
  for (const [i, c] of css.entries()) {
    for (const m of c.matchAll(/var\((--[a-z0-9-]+)\s*(,)?/g)) {
      if (m[2]) continue; // has a fallback
      assert.ok(defined.has(m[1]), `${sheets[i]} uses ${m[1]}, which no sheet of the editor page defines`);
    }
  }
  // The page has a background, a text colour and a font of its own.
  assert.ok(defined.has('--ui-bg') && defined.has('--ui-text') && defined.has('--ui-font'));
});

test('the editor module graph: every relative import names a file that exists', () => {
  const seen = new Set();
  const visit = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const src = read(rel);
    for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)[^'"]*?from\s+'(\.[^']+)'|import\(\s*'(\.[^']+)'\s*\)/g)) {
      const spec = m[1] ?? m[2];
      const target = normalize(join(dirname(rel), spec));
      assert.ok(existsSync(join(GAME, target)), `${rel} imports ${spec}: ${target} is missing`);
      if (target.endsWith('.js')) visit(target);
    }
  };
  visit('editor/editor.js');
  assert.ok(seen.has('js/renderer.js') && seen.has('js/gameart.js') && seen.has('editor/js/world.js'));
  // Shaders the renderer fetches relative to the base.
  for (const m of read('js/renderer.js').matchAll(/'(terrain|sprite|fog|rect|line|weather|sky|heat)'/g)) assert.ok(existsSync(join(GAME, `shaders/${m[1]}.wgsl`)), m[1]);
});

// The self-hosted fonts (tools/gen-fonts.mjs) and their one shared copy in
// dist/ (tools/share-assets.mjs): the committed files match the pinned
// packages, every face is a Latin woff2 with its OFL licence, the pages load
// them from this site only (CSP font-src 'self', COEP on /play), and the
// build points the game at the website's /lib/fonts/ copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CRITICAL, FAMILIES, fontFile, fontOutputs, staleFonts } from './gen-fonts.mjs';
import { rewriteFontCss, rewriteFontLinks, shareFonts, sharedFontRefs } from './share-assets.mjs';
import { cssRefsOf, libModules } from './shared-modules.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (rel) => readFileSync(join(root, rel), 'utf8');

test('fonts: the committed files are exactly what the pinned packages hold', () => {
  assert.deepEqual(staleFonts(), [], 'run node tools/gen-fonts.mjs');
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  for (const f of FAMILIES) {
    const version = pkg.devDependencies[f.pkg];
    assert.match(version, /^\d+\.\d+\.\d+$/, `${f.pkg} is pinned to an exact version`);
    const entry = lock.packages[`node_modules/${f.pkg}`];
    assert.equal(entry?.version, version, `${f.pkg} is in package-lock.json`);
    assert.match(entry.integrity, /^sha512-/);
    assert.equal(entry.license, 'OFL-1.1');
  }
});

test('fonts: every face is a woff2 with a licence, and css/fonts.css names each one once', () => {
  const dir = join(root, 'apps/game/fonts');
  const css = read('apps/game/css/fonts.css');
  const refs = cssRefsOf(css);
  const faces = FAMILIES.flatMap((f) => f.weights.map((w) => fontFile(f.slug, w)));
  assert.deepEqual(refs.sort(), faces.map((f) => `../fonts/${f}`).sort());
  for (const face of faces) assert.equal(readFileSync(join(dir, face)).subarray(0, 4).toString('latin1'), 'wOF2', face);
  for (const f of FAMILIES) {
    const licence = readFileSync(join(dir, f.licence), 'utf8');
    assert.match(licence, /SIL OPEN FONT LICENSE Version 1\.1/);
    assert.match(licence, /Copyright 20\d\d The (Barlow|JetBrains Mono) Project Authors/);
  }
  // Nothing in fonts/ that the generator does not write (no stray or EA files).
  const generated = new Set(fontOutputs().map((o) => o.path.replace(/^fonts\//, '')));
  for (const name of readdirSync(dir)) assert.ok(generated.has(name), `fonts/${name} comes from tools/gen-fonts.mjs`);
  // Latin subset only, swap while loading (text shows at once in the fallback font).
  assert.equal((css.match(/@font-face/g) ?? []).length, faces.length);
  assert.equal((css.match(/font-display: swap;/g) ?? []).length, faces.length);
  assert.equal((css.match(/unicode-range: U\+0000-00FF,/g) ?? []).length, faces.length);
  assert.doesNotMatch(css, /https?:|fonts\.googleapis|format\('woff'\)/);
});

test('fonts: the game and every website page load them, preloading the two first-screen faces', () => {
  const game = read('apps/game/index.html');
  assert.match(game, /<link rel="stylesheet" href="css\/fonts\.css" \/>\s*<link rel="stylesheet" href="css\/theme\.css" \/>/);
  for (const face of CRITICAL) assert.ok(game.includes(`<link rel="preload" href="fonts/${face}" as="font" type="font/woff2" crossorigin />`), `game preloads ${face}`);
  assert.match(read('apps/game/editor/index.html'), /href="css\/fonts\.css"/);
  const pages = [...readdirSync(join(root, 'apps/website')).filter((f) => f.endsWith('.html')), 'account/index.html'];
  for (const page of pages) {
    const html = read(`apps/website/${page}`);
    assert.ok(html.includes('<link rel="stylesheet" href="/lib/css/fonts.css" />'), `${page} links the fonts`);
    for (const face of CRITICAL) assert.ok(html.includes(`href="/lib/fonts/${face}" as="font" type="font/woff2" crossorigin`), `${page} preloads ${face}`);
  }
  // The website's /lib/ copy holds the sheet and every face it names.
  const lib = libModules({ websiteDir: join(root, 'apps/website'), gameDir: join(root, 'apps/game') });
  assert.ok(lib.includes('css/fonts.css'));
  for (const f of FAMILIES) for (const w of f.weights) assert.ok(lib.includes(`fonts/${fontFile(f.slug, w)}`), `${fontFile(f.slug, w)} is published under /lib/`);
});

test('fonts: the CSP and the game\'s isolation headers allow self-hosted fonts only', async () => {
  const headers = read('apps/website/_headers');
  const csp = headers.match(/Content-Security-Policy: (.+)/)[1];
  assert.match(csp, /(^|; )font-src 'self'(;|$)/);
  assert.match(csp, /(^|; )style-src 'self'(;|$)/);
  const { SITE_HEADERS, PLAY_HEADERS } = await import('../apps/server/src/static-headers.js');
  assert.equal(SITE_HEADERS['Content-Security-Policy'], csp, 'the Worker sends the same CSP');
  // /play is cross-origin isolated; /lib/fonts/ is the same origin, so require-corp lets the game load it.
  assert.equal(PLAY_HEADERS['Cross-Origin-Embedder-Policy'], 'require-corp');
  assert.doesNotMatch(headers, /^\/lib/m, '/lib/ gets no header rule of its own that could block the fonts');
});

test('share-assets: dist gets one copy under /lib/fonts/ and the game points there', () => {
  assert.equal(rewriteFontCss("src: url('../fonts/a.woff2') format('woff2');"), "src: url('/lib/fonts/a.woff2') format('woff2');");
  assert.equal(rewriteFontCss('src: url(../fonts/a.woff2)'), 'src: url(/lib/fonts/a.woff2)');
  assert.equal(rewriteFontLinks('<link rel="preload" href="fonts/a.woff2" as="font" />'), '<link rel="preload" href="/lib/fonts/a.woff2" as="font" />');
  assert.equal(rewriteFontLinks('<a href="fonts/OFL.txt">'), '<a href="fonts/OFL.txt">', 'only links, not anchors');
  assert.deepEqual(sharedFontRefs("url('/lib/fonts/a.woff2') href=\"/lib/fonts/b.woff2\""), ['a.woff2', 'b.woff2']);

  const tmp = mkdtempSync(join(tmpdir(), 'webra-fonts-'));
  try {
    const dist = join(tmp, 'dist');
    const fontsDir = join(root, 'apps/game/fonts');
    mkdirSync(join(dist, 'play/css'), { recursive: true });
    mkdirSync(join(dist, 'play/fonts'), { recursive: true });
    mkdirSync(join(dist, 'play/editor'), { recursive: true });
    writeFileSync(join(dist, 'play/css/fonts.css'), read('apps/game/css/fonts.css'));
    writeFileSync(join(dist, 'play/index.html'), read('apps/game/index.html'));
    writeFileSync(join(dist, 'play/editor/index.html'), read('apps/game/editor/index.html'));
    writeFileSync(join(dist, 'play/fonts/barlow-latin-400.woff2'), 'stale');
    const r = shareFonts({ dist, fontsDir });
    assert.deepEqual(r.rewritten, ['css/fonts.css', 'index.html']);
    assert.equal(r.files, readdirSync(fontsDir).length);
    assert.equal(existsSync(join(dist, 'play/fonts')), false, 'no second copy under /play/');
    const css = readFileSync(join(dist, 'play/css/fonts.css'), 'utf8');
    assert.doesNotMatch(css, /\.\.\/fonts\//);
    for (const name of sharedFontRefs(css)) assert.ok(existsSync(join(dist, 'lib/fonts', name)), name);
    const html = readFileSync(join(dist, 'play/index.html'), 'utf8');
    for (const face of CRITICAL) assert.ok(html.includes(`href="/lib/fonts/${face}"`));
    for (const f of FAMILIES) assert.ok(existsSync(join(dist, 'lib/fonts', f.licence)), `${f.licence} ships with the fonts`);
    // A reference to a face that is not there fails the build.
    writeFileSync(join(dist, 'play/css/fonts.css'), "src: url('../fonts/missing.woff2');");
    assert.throws(() => shareFonts({ dist, fontsDir }), /missing\.woff2/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('fonts: the website credits name the fonts and their licence', () => {
  const html = read('apps/website/index.html');
  for (const name of ['Barlow', 'Barlow Condensed', 'JetBrains Mono']) assert.ok(html.includes(name), `credits name ${name}`);
  assert.match(html, /SIL Open Font License/);
  for (const f of FAMILIES) assert.ok(html.includes(`/lib/fonts/${f.licence}`), `credits link ${f.licence}`);
});

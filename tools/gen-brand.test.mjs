// The logo (tools/gen-brand.mjs): the committed files are what the script
// draws, the SVGs stay CSP-safe and original, the PNGs have the right sizes,
// and the website and the game use them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND_DIR, brandOutputs, decodePng, encodePng, markShapes, rasterize, staleBrand, strokePolyline } from './gen-brand.mjs';
import { libModules } from './shared-modules.mjs';
import { shareBrand } from './share-assets.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (rel) => readFileSync(join(root, rel), 'utf8');

test('brand: the committed files are what tools/gen-brand.mjs draws', () => {
  assert.deepEqual(staleBrand(), [], 'run node tools/gen-brand.mjs');
  const names = brandOutputs().map((o) => o.name);
  assert.deepEqual(readdirSync(BRAND_DIR).sort(), [...names].sort(), 'nothing else in apps/game/brand');
});

test('brand: SVGs use presentation attributes only, no text, no outside references, no other marks', () => {
  for (const o of brandOutputs().filter((x) => x.name.endsWith('.svg'))) {
    const svg = o.data;
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 \d+ \d+"/, o.name);
    assert.doesNotMatch(svg, /style|<script|<text|<image|<use|href|url\(|@import|<foreignObject/i, `${o.name} is self-contained and CSP-safe`);
    assert.doesNotMatch(svg, /openra|electronic arts|\bEA\b|westwood/i, `${o.name} names no one else`);
    assert.match(svg, /<title>WebRA<\/title>/);
  }
});

test('brand: PNG favicons 16 and 32 (simplified, transparent) and a 180 app icon (full, opaque)', () => {
  const byName = Object.fromEntries(brandOutputs().map((o) => [o.name, o]));
  for (const [name, size, opaque] of [
    ['favicon-16.png', 16, false],
    ['favicon-32.png', 32, false],
    ['apple-touch-icon.png', 180, true],
  ]) {
    const { size: s, rgba } = decodePng(readFileSync(join(BRAND_DIR, name)));
    assert.equal(s, size, name);
    const alphas = [];
    for (let i = 3; i < rgba.length; i += 4) alphas.push(rgba[i]);
    if (opaque) assert.ok(alphas.every((a) => a === 255), `${name} is opaque (iOS fills transparency with black)`);
    else {
      assert.equal(alphas[0], 0, `${name} has a transparent corner`);
      assert.ok(alphas.some((a) => a === 255), `${name} draws the mark`);
    }
    assert.ok(byName[name].png, name);
  }
  // The rasterizer: a full square covers every pixel, half a square half of them, and a PNG round-trips.
  const square = [{ rings: [[[0, 0], [100, 0], [100, 100], [0, 100]]], fill: '#ff0000' }];
  const full = rasterize(square, 4);
  assert.deepEqual([...full.subarray(0, 4)], [255, 0, 0, 255]);
  const half = rasterize([{ rings: [[[0, 0], [50, 0], [50, 100], [0, 100]]], fill: '#ffffff' }], 4);
  assert.deepEqual([full[3], half[3], half[4 * 3 + 3]], [255, 255, 0]);
  const back = decodePng(encodePng(full, 4));
  assert.deepEqual([...back.rgba], [...full]);
  // A W stroked with miter joins is one closed ring, and the one-colour mark cuts it out of the tile (even-odd).
  assert.equal(strokePolyline([[0, 0], [10, 10], [20, 0]], 2).length, 1);
  assert.equal(markShapes()[1].rule, 'evenodd');
});

test('brand: the website and the game use the generated files, published under /lib/brand/', () => {
  const pages = [...readdirSync(join(root, 'apps/website')).filter((f) => f.endsWith('.html')), 'account/index.html'];
  for (const page of pages) {
    const html = read(`apps/website/${page}`);
    assert.ok(html.includes('<link rel="icon" href="/lib/brand/favicon.svg" type="image/svg+xml" />'), `${page} favicon`);
    assert.ok(html.includes('href="/lib/brand/apple-touch-icon.png"'), `${page} app icon`);
    assert.doesNotMatch(html, /href="data:image\/svg/, `${page} has no data-URI favicon left`);
    assert.doesNotMatch(html, /<svg class="brand-mark"/, `${page} has no old inline mark`);
    if (/class="brand"/.test(html)) assert.match(html, /<img class="brand-mark" src="\/lib\/brand\/emblem\.svg" alt="" width="40" height="40" \/>/, `${page} header mark (40 px: the emblem with its plate, as on the Website board)`);
  }
  const lib = libModules({ websiteDir: join(root, 'apps/website'), gameDir: join(root, 'apps/game') });
  for (const name of ['favicon.svg', 'favicon-16.png', 'favicon-32.png', 'apple-touch-icon.png']) assert.ok(lib.includes(`brand/${name}`), `${name} under /lib/brand/`);
  const game = read('apps/game/index.html');
  assert.ok(game.includes('<link rel="icon" href="brand/favicon.svg" type="image/svg+xml" />'));
  assert.ok(game.includes('<link rel="apple-touch-icon" href="brand/apple-touch-icon.png" />'));
  // The start menu's brand: the simplified emblem (under 40 px) and the word on a plate over the hazard stripe.
  assert.match(game, /<h1 class="start-logo"><span class="start-logo-plate ui-brand"><img class="ui-brand-emblem" src="brand\/favicon\.svg" alt="" width="32" height="32" \/><span class="ui-brand-word">WEB<span>RA<\/span><\/span><\/span><\/h1>/);
  assert.match(read('apps/game/editor/index.html'), /href="brand\/favicon\.svg"/);
});

test('brand: the build publishes every logo file under /lib/brand/', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'webra-brand-'));
  try {
    assert.equal(shareBrand({ dist: tmp, brandDir: BRAND_DIR }), brandOutputs().length);
    assert.deepEqual(readdirSync(join(tmp, 'lib/brand')).sort(), brandOutputs().map((o) => o.name).sort());
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

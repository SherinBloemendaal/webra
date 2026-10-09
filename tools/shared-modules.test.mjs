// The game modules published under /lib/ for the website (tools/shared-modules.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cssRefsOf, htmlRefsOf, importsOf, libModules, refersToGame } from './shared-modules.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('importsOf: static, multi-line, re-exports, side effects, dynamic; comments skipped', () => {
  const src = [
    "import a from './a.js';",
    'import {',
    '  x,',
    '  y,',
    "} from '../b.js';",
    "export { z } from './c.js';",
    "import './side.js';",
    "/** @param {import('./type-only.js').T} t */",
    " * import('./jsdoc.js')",
    "// import x from './commented.js';",
    "const later = await import('./d.js');",
  ].join('\n');
  assert.deepEqual(importsOf(src).sort(), ['../b.js', './a.js', './c.js', './d.js', './side.js']);
});

test('the real website: the account client and protocol checks, nothing that draws or runs the game', () => {
  const lib = libModules({ websiteDir: join(root, 'apps/website'), gameDir: join(root, 'apps/game') });
  for (const needed of ['css/controls.css', 'js/ui/controls.js', 'js/account/api.js', 'js/account/session.js', 'js/account/passkey.js', 'js/account/admin-state.js', 'js/account/admin-forms.js', 'js/registry.js', 'protocol/accounts.js']) {
    assert.ok(lib.includes(needed), needed);
  }
  for (const gated of ['js/main.js', 'js/sprites.js', 'js/renderer.js', 'js/sim/worker.js', 'js/account/ui.js', 'index.html']) {
    assert.ok(!lib.includes(gated), gated);
  }
  assert.ok(lib.every((p) => /\.(js|css)$/.test(p) && !p.startsWith('pkg/') && !p.startsWith('shaders/')), lib.join(', '));
});

test('a website script that imports the gated /play/ path statically, or a missing module, fails the build', () => {
  const dir = mkdtempSync(join(tmpdir(), 'webra-lib-'));
  try {
    const website = join(dir, 'website');
    const game = join(dir, 'game');
    mkdirSync(join(website, 'assets'), { recursive: true });
    mkdirSync(join(game, 'js'), { recursive: true });
    writeFileSync(join(game, 'js/ok.js'), "import { b } from './b.js';\nexport const a = b;\n");
    writeFileSync(join(game, 'js/b.js'), 'export const b = 1;\n');
    writeFileSync(join(website, 'assets/page.js'), "import { a } from '/lib/js/ok.js';\n");
    assert.deepEqual(libModules({ websiteDir: website, gameDir: game }), ['js/b.js', 'js/ok.js']);

    writeFileSync(join(website, 'assets/page.js'), "import { a } from '/play/js/ok.js';\n");
    assert.throws(() => libModules({ websiteDir: website, gameDir: game }), /\/play is gated/);

    writeFileSync(join(website, 'assets/page.js'), "import { a } from '/lib/js/missing.js';\n");
    assert.throws(() => libModules({ websiteDir: website, gameDir: game }), /does not exist/);

    writeFileSync(join(game, 'js/ok.js'), "import { c } from '../../outside.js';\n");
    writeFileSync(join(website, 'assets/page.js'), "import { a } from '/lib/js/ok.js';\n");
    assert.throws(() => libModules({ websiteDir: website, gameDir: game }), /outside/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stylesheet and page references: links, scripts, images, @import and url(); anchors are not loads', () => {
  assert.deepEqual(cssRefsOf('@import "./a.css";\n@import url(\'../b.css\');\n/* url(/c.png) */ .x { background: url(./d.png) } .y { background: url("data:image/png;base64,AAA") }').sort(), ['../b.css', './a.css', './d.png']);
  const html = '<link rel="stylesheet" href="/lib/css/controls.css" /><script type="module" src=/assets/site.js></script><img srcset="/a.png 1x, /b.png 2x"><a href="/play/">Play</a><!-- <link href="/play/x.css"> -->';
  assert.deepEqual(htmlRefsOf(html).sort(), ['/a.png', '/assets/site.js', '/b.png', '/lib/css/controls.css']);
});

test('refersToGame: every spelling of /play, nothing else', () => {
  for (const ref of ['/play/css/controls.css', '/play', '../play/js/x.js', '/%70lay/x.js', '/PLAY/x', '/x/../play/y', '/lib/../play/x', '/play;x/a', 'https://webra.invalid/play/x']) assert.equal(refersToGame(ref), true, ref);
  for (const ref of ['/lib/css/controls.css', '/playground.css', '/assets/play.css', 'https://cdn.example/play/x.js', '//play/x', 'data:text/css,x']) assert.equal(refersToGame(ref), false, ref);
});

test('a page or stylesheet that loads from /play fails the build; /lib/ stylesheets and their imports are published', () => {
  const dir = mkdtempSync(join(tmpdir(), 'webra-lib-'));
  try {
    const website = join(dir, 'website');
    const game = join(dir, 'game');
    mkdirSync(join(website, 'assets'), { recursive: true });
    mkdirSync(join(game, 'css'), { recursive: true });
    writeFileSync(join(game, 'css/controls.css'), '@import "./base.css";\n.x { background: url(./knob.svg) }\n');
    writeFileSync(join(game, 'css/base.css'), '.y {}\n');
    writeFileSync(join(game, 'css/knob.svg'), '<svg/>');
    writeFileSync(join(website, 'page.html'), '<link rel="stylesheet" href="/lib/css/controls.css"><a href="/play/">Play</a>');
    assert.deepEqual(libModules({ websiteDir: website, gameDir: game }), ['css/base.css', 'css/controls.css', 'css/knob.svg']);
    writeFileSync(join(website, 'page.html'), '<link rel="stylesheet" href="/play/css/controls.css">');
    assert.throws(() => libModules({ websiteDir: website, gameDir: game }), /page\.html loads \/play\/css\/controls\.css/);
    writeFileSync(join(website, 'page.html'), '<script src="/%70lay/js/x.js"></script>');
    assert.throws(() => libModules({ websiteDir: website, gameDir: game }), /\/play is gated/);
    writeFileSync(join(website, 'page.html'), '');
    writeFileSync(join(website, 'assets/site.css'), '@import url("/play/css/controls.css");');
    assert.throws(() => libModules({ websiteDir: website, gameDir: game }), /site\.css loads/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

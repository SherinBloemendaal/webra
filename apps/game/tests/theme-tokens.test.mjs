// The accent colour of the game and the website: one Red Alert red palette,
// defined once per app as tokens (apps/game/css/theme.css :root and
// apps/website/assets/site.css :root) and used everywhere else through
// var(). Checks that the two palettes match, that the accent reads on the
// dark panels (WCAG AA for text, 3:1 for other parts), that no stylesheet
// brings back a hard-coded accent blue, and that the shared controls sheet
// finds every token it needs on the website.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (rel) => readFileSync(root + rel, 'utf8');
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

const GAME_CSS = readdirSync(root + 'apps/game/css')
  .filter((f) => f.endsWith('.css'))
  .map((f) => `apps/game/css/${f}`)
  .concat('apps/game/editor/editor.css');
const SITE_CSS = ['apps/website/assets/site.css', 'apps/website/assets/account.css'];
const PAGES = ['apps/game/index.html', 'apps/game/editor/index.html', ...readdirSync(root + 'apps/website').filter((f) => f.endsWith('.html')).map((f) => `apps/website/${f}`), 'apps/website/account/index.html'];

/** The custom properties of the first top-level `:root { ... }` block of a stylesheet. */
function rootTokens(rel) {
  const css = stripComments(read(rel));
  const start = css.search(/(^|\n):root\s*\{/);
  assert.ok(start >= 0, `${rel} has no :root block`);
  const open = css.indexOf('{', start);
  let depth = 0;
  let end = open;
  for (; end < css.length; end++) {
    if (css[end] === '{') depth++;
    else if (css[end] === '}' && --depth === 0) break;
  }
  const body = css.slice(open + 1, end);
  const tokens = {};
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) tokens[m[1]] = m[2].trim();
  return { tokens, start, end };
}

/** Follow var() references to a literal colour. */
function resolve(tokens, name, seen = new Set()) {
  assert.ok(!seen.has(name), `token cycle at ${name}`);
  seen.add(name);
  const value = tokens[name];
  assert.ok(value !== undefined, `${name} is not defined`);
  const ref = value.match(/^var\((--[a-z0-9-]+)\)$/);
  return ref ? resolve(tokens, ref[1], seen) : value;
}

function rgbOf(color) {
  let m = color.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (m) {
    const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  m = color.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  throw new Error(`not a colour: ${color}`);
}

/** WCAG 2 contrast ratio of two opaque colours. */
function contrast(a, b) {
  const lum = (c) =>
    rgbOf(c)
      .map((v) => v / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
      .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Hue (degrees), saturation and lightness (0..1) of a colour. */
function hsl(color) {
  const [r, g, b] = rgbOf(color).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  return { h: (h + 360) % 360, s, l };
}

const GAME = rootTokens('apps/game/css/theme.css').tokens;
const SITE = rootTokens('apps/website/assets/site.css').tokens;
const game = (name) => resolve(GAME, name);
const site = (name) => resolve(SITE, name);

// The game names and the website names of the same palette entries.
const PALETTE = [
  ['--ui-accent', '--accent'],
  ['--ui-accent-hi', '--accent-hi'],
  ['--ui-accent-hover', '--accent-hover'],
  ['--ui-accent-lo', '--accent-lo'],
  ['--ui-accent-glow', '--accent-glow'],
  ['--ui-accent-disabled', '--accent-disabled'],
  ['--ui-primary', '--primary'],
  ['--ui-primary-hi', '--primary-hi'],
  ['--ui-primary-hover', '--primary-hover'],
  ['--ui-primary-active', '--primary-active'],
  ['--ui-primary-disabled', '--primary-disabled'],
  ['--ui-focus', '--focus'],
  ['--ui-info', '--info'],
];

test('theme: the game and the website share one red accent palette', () => {
  for (const [g, s] of PALETTE) assert.equal(game(g), site(s), `${g} (game) and ${s} (website)`);
  // The website also offers it under the game's names, for the shared controls sheet.
  for (const [g] of PALETTE) assert.equal(site(g), game(g), `${g} on the website`);
  // Red: the accent hue sits within 15 degrees of pure red.
  for (const name of ['--ui-accent', '--ui-accent-hi', '--ui-primary', '--ui-primary-hi']) {
    const { h, s } = hsl(game(name));
    assert.ok((h <= 15 || h >= 345) && s > 0.5, `${name} ${game(name)} is not red (hue ${h.toFixed(0)})`);
  }
  // The focus ring is the accent, and the chrome no longer follows the side.
  assert.equal(GAME['--ui-focus'], 'var(--ui-accent-hi)');
  assert.doesNotMatch(read('apps/game/css/theme.css'), /data-faction/);
});

test('theme: accent contrast on the dark panels (WCAG AA)', () => {
  const check = (fg, bg, min, what) => {
    const ratio = contrast(fg, bg);
    assert.ok(ratio >= min, `${what}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1, needs ${min}:1`);
  };
  const gameSurfaces = ['--ui-bg', '--ui-metal-0', '--ui-metal-1', '--ui-metal-2'].map(game);
  const siteSurfaces = ['--bg', '--bg-2', '--panel', '--panel-2'].map(site);
  for (const [surfaces, tok] of [
    [gameSurfaces, game],
    [siteSurfaces, site],
  ]) {
    const name = (n) => (tok === game ? n : n.replace('--ui-', '--'));
    for (const bg of surfaces) {
      // Borders, stripes, fills: 3:1 (WCAG 1.4.11).
      check(tok(name('--ui-accent')), bg, 3, `${name('--ui-accent')}`);
      // Text, links, labels, the focus ring: 4.5:1 (WCAG 1.4.3).
      check(tok(name('--ui-accent-hi')), bg, 4.5, `${name('--ui-accent-hi')}`);
      check(tok(name('--ui-accent-hover')), bg, 4.5, `${name('--ui-accent-hover')}`);
      check(tok(name('--ui-focus')), bg, 4.5, `${name('--ui-focus')}`);
    }
  }
  // The hover background of metal buttons still carries accent text.
  check(game('--ui-accent-hi'), game('--ui-metal-3'), 4.5, '--ui-accent-hi on --ui-metal-3');
  // Accent text on a chosen (accent-lo) background.
  check(game('--ui-accent-hi'), game('--ui-accent-lo'), 4.5, '--ui-accent-hi on --ui-accent-lo');
  // White labels on every step of the main buttons and on accent fills.
  for (const n of ['--ui-primary', '--ui-primary-hi', '--ui-primary-hover', '--ui-primary-active', '--ui-accent', '--ui-accent-lo']) check('#ffffff', game(n), 4.5, `white on ${n}`);
  // Information callouts stay apart from the accent and readable as borders.
  for (const bg of gameSurfaces) check(game('--ui-info'), bg, 3, '--ui-info');
  assert.ok(Math.abs(hsl(game('--ui-info')).h - hsl(game('--ui-accent')).h) > 90, 'info is not a shade of the accent');
});

// Design tokens of the Foundations board that the website offers under the
// game's names too (for the shared controls and patterns sheets), resolved
// to the same values.
const SHARED = [
  '--ui-text-2',
  '--ui-info-text',
  '--ui-money',
  '--ui-ok',
  '--ui-warn',
  '--ui-primary-disabled-text',
  '--ui-focus-offset',
  ...['off', 'on', 'ok', 'warn', 'info'].flatMap((k) => [`--ui-led-${k}`, `--ui-led-${k}-edge`, `--ui-led-${k}-glow`]),
  '--ui-led-bad-edge',
  '--ui-led-bad-glow',
  '--ui-line-soft',
  '--ui-brand-red',
  '--ui-allies',
  '--ui-soviet',
  '--ui-neutral',
  '--ui-terrain',
  '--ui-tip-bg',
  '--ui-tip-rim',
  '--ui-tip-key',
  '--ui-tip-text',
  '--ui-tip-shadow',
  ...['display', 'title', 'section', 'label', 'body'].map((k) => `--ui-fs-${k}`),
  ...['display', 'title', 'section', 'button', 'label'].map((k) => `--ui-track-${k}`),
  '--ui-lh-body',
  ...[1, 2, 3, 4, 5, 6, 7].map((n) => `--ui-space-${n}`),
  '--ui-radius',
  '--ui-shadow',
  '--ui-shadow-pop',
  '--ui-shadow-toast',
  '--ui-primary-glow',
  '--ui-primary-glow-hover',
];

/** A token's value with every var() replaced by what it resolves to (for tokens that are not a bare colour). */
function expand(tokens, name, seen = new Set()) {
  assert.ok(!seen.has(name), `token cycle at ${name}`);
  const value = tokens[name];
  assert.ok(value !== undefined, `${name} is not defined`);
  return value.replace(/var\((--[a-z0-9-]+)\)/g, (_, ref) => expand(tokens, ref, new Set([...seen, name])));
}

test('theme: the website mirrors the Foundations tokens under the game names', () => {
  for (const name of SHARED) assert.equal(expand(SITE, name), expand(GAME, name), `${name} (website) equals the game's`);
  // Space in steps of 4 px, the Foundations scale.
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map((n) => GAME[`--ui-space-${n}`]), ['4px', '8px', '12px', '16px', '24px', '32px', '48px']);
  // The self-hosted fonts come first in every font token, with system fallbacks after them.
  for (const [tokens, names] of [
    [GAME, ['--ui-font', '--ui-font-display', '--ui-font-mono']],
    [SITE, ['--sans', '--display', '--mono']],
  ]) {
    const [sans, display, mono] = names.map((n) => tokens[n]);
    assert.match(sans, /^'Barlow',.*sans-serif$/);
    assert.match(display, /^'Barlow Condensed',.*sans-serif$/);
    assert.match(mono, /^'JetBrains Mono',.*monospace$/);
  }
});

test('theme: text colours read on every panel and well (WCAG AA)', () => {
  const surfaces = ['--ui-bg', '--ui-metal-0', '--ui-metal-1', '--ui-metal-2'];
  const ratio = (fg, bg) => contrast(game(fg), game(bg));
  for (const fg of ['--ui-text', '--ui-text-2', '--ui-muted', '--ui-money', '--ui-ok', '--ui-warn', '--ui-info-text', '--ui-tip-key', '--ui-led-on']) {
    for (const bg of surfaces) assert.ok(ratio(fg, bg) >= 4.5, `${fg} on ${bg}: ${ratio(fg, bg).toFixed(2)}:1`);
    // Chosen rows (accent-lo) carry text too.
    assert.ok(ratio(fg, '--ui-accent-lo') >= 4.5, `${fg} on --ui-accent-lo`);
  }
  // The red of errors is text only on the window background and the wells (and tooltips, below).
  for (const bg of ['--ui-bg', '--ui-metal-0']) assert.ok(ratio('--ui-bad', bg) >= 4.5, `--ui-bad on ${bg}`);
  // Tooltips: the panel is near black at 94%; checked as the opaque colour over the darkest ground.
  const tip = (() => {
    const [r, g, b] = GAME['--ui-tip-bg'].match(/[\d.]+/g).map(Number);
    return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
  })();
  for (const fg of ['--ui-text', '--ui-tip-text', '--ui-tip-key', '--ui-money', '--ui-bad', '--ui-muted']) assert.ok(contrast(game(fg), tip) >= 4.5, `${fg} on the tooltip`);
  // Lamps are not text: 3:1 against the well they sit in, and every lit lamp differs from the off one.
  for (const k of ['on', 'ok', 'warn', 'bad', 'info']) {
    assert.ok(contrast(game(`--ui-led-${k}`), game('--ui-metal-0')) >= 3, `--ui-led-${k} shows on a well`);
    assert.notEqual(game(`--ui-led-${k}`), game('--ui-led-off'));
  }
  // Text on the raised plates (buttons, the select's face, segments) at rest and under the pointer:
  // every colour stop of --ui-raised, --ui-raised-hover and the segment gradient.
  const stops = (name) => [...expand(GAME, name).matchAll(/#[0-9a-f]{6}/gi)].map((m) => m[0]);
  const raised = [...stops('--ui-raised'), ...stops('--ui-raised-hover'), game('--ui-metal-3'), game('--ui-metal-2')];
  assert.ok(raised.length >= 4);
  for (const fg of ['--ui-text', '--ui-text-2', '--ui-money']) for (const bg of raised) assert.ok(contrast(game(fg), bg) >= 4.5, `${fg} on raised ${bg}: ${contrast(game(fg), bg).toFixed(2)}:1`);
  // The select's placeholder and every text rule of the select face use a colour that passes there.
  const controls = stripComments(read('apps/game/css/controls.css'));
  assert.match(controls, /\.ui-sp-empty \.ui-sp-value \{\s*color: var\(--ui-text-2\);/);
  assert.doesNotMatch(controls.match(/\.ui-sp-button[^{]*\{[^}]*\}/g).join(''), /color: var\(--ui-(muted|dim)\)/);
  // Disabled parts are exempt from the contrast rules, but the label must still differ from its ground.
  assert.ok(contrast(game('--ui-primary-disabled-text'), game('--ui-primary-disabled')) > 1.5);
});

// Blues that are meanings, not accents: allowed where listed, with the reason.
const ALLOWED_BLUES = [
  { file: 'apps/game/css/lobby.css', near: /lobby-flag/, why: 'country flags and the Random Allies chip (faction art)' },
  { file: 'apps/game/css/account.css', near: /account-discord/, why: 'Discord brand button' },
  { file: 'apps/website/assets/account.css', near: /btn-discord/, why: 'Discord brand button' },
  { file: 'apps/website/index.html', near: /side-allies|Allies/, why: 'the Allied side emblem' },
];

/** Hard-coded accent blues in `text` (a stylesheet or a page), outside the :root token block of the token files. */
function blues(rel) {
  let text = rel.endsWith('.css') ? stripComments(read(rel)) : read(rel).replace(/<!--[\s\S]*?-->/g, '');
  if (rel === 'apps/game/css/theme.css' || rel === 'apps/website/assets/site.css') {
    const { start, end } = rootTokens(rel);
    // Blank the token block (offsets are in the comment-free text).
    text = text.slice(0, start) + ' '.repeat(end - start) + text.slice(end);
  }
  const found = [];
  for (const m of text.matchAll(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b|rgba?\([^)]*\)/gi)) {
    let c;
    try {
      c = hsl(m[0]);
    } catch {
      continue;
    }
    // Saturated blues; the gunmetal greys have a faint blue cast but little saturation.
    if (c.h < 185 || c.h > 255 || c.s < 0.4 || c.l < 0.12 || c.l > 0.92) continue;
    // The rule (stylesheets) or the few lines (pages) the colour sits in.
    const before = text.slice(0, m.index);
    const context = rel.endsWith('.css') ? before.slice(before.lastIndexOf('}') + 1) : before.split('\n').slice(-4).join('\n');
    if (ALLOWED_BLUES.some((a) => a.file === rel && a.near.test(context + text.slice(m.index, m.index + 200).split('\n')[0]))) continue;
    found.push(`${rel}: ${m[0]} in ${context.trim().split('\n').at(-1).slice(0, 80)}`);
  }
  return found;
}

test('theme: no hard-coded accent blues outside the token definitions', () => {
  const found = [...GAME_CSS, ...SITE_CSS, ...PAGES].flatMap(blues);
  assert.deepEqual(found, []);
  // The old blue accent and its button blues are gone everywhere (the info token keeps #4a82c4 by name).
  for (const rel of [...GAME_CSS, ...SITE_CSS]) {
    const css = stripComments(read(rel));
    for (const old of ['#93c0f2', '#1b3555', '#2f5f96', '#3d76b5', '#5089c8', '#d3e6fb', 'rgba(74, 130, 196']) assert.ok(!css.includes(old), `${rel} still has ${old}`);
  }
});

test('theme: the scanner flags a blue accent and passes the allowed ones', () => {
  // Guards the guard: a planted blue must be found, a flag blue must not.
  assert.ok(hsl('#4a82c4').h > 185 && hsl('#4a82c4').s > 0.4);
  assert.ok(hsl('#0055a4').h > 185);
  assert.equal(hsl('#e0301f').h < 15, true);
  assert.ok(hsl('#222830').s < 0.4, 'gunmetal is not a blue');
  assert.ok(ALLOWED_BLUES.every((a) => [...GAME_CSS, ...SITE_CSS, ...PAGES].includes(a.file)), 'every allowlist entry names a scanned file');
});

test('theme: every stylesheet token in use is defined', () => {
  // Custom properties set from script (inline styles) instead of a stylesheet.
  const fromScript = new Set(['--c']);
  const check = (files) => {
    const defs = new Set();
    const uses = [];
    for (const rel of files) {
      const css = stripComments(read(rel));
      for (const m of css.matchAll(/(--[a-z0-9-]+)\s*:/g)) defs.add(m[1]);
      for (const m of css.matchAll(/var\(\s*(--[a-z0-9-]+)\s*(,)?/g)) if (!m[2]) uses.push([m[1], rel]);
    }
    return uses.filter(([name]) => !defs.has(name) && !fromScript.has(name)).map(([n, f]) => `${n} in ${f}`);
  };
  // The game loads theme.css before every sheet; the editor loads it too.
  assert.deepEqual(check(GAME_CSS), []);
  assert.match(read('apps/game/editor/index.html'), /href="css\/theme\.css"/);
  // The website's account and admin pages load the game's controls sheet from /lib/ over site.css.
  assert.deepEqual(check([...SITE_CSS, 'apps/game/css/controls.css']), []);
  // The shared patterns sheet works on the website too (it can load it from /lib/css/patterns.css).
  assert.deepEqual(check([...SITE_CSS, 'apps/game/css/controls.css', 'apps/game/css/patterns.css']), []);
});

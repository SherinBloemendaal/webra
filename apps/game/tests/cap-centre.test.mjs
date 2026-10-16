// Capitals in the middle of a control. Barlow and Barlow Condensed put the
// cap top 300 units under the ascender and the descender 200 units under the
// baseline, so an upper-case label whose line box is centred in a button
// sits 50 units (0.05 em) low. theme.css keeps that number once, as
// --ui-cap-nudge; this test recomputes it from the woff2 files in fonts/,
// checks the website offers the same value, and checks that every control
// with a label in capitals moves its text up by it (and its lamp down by it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readFontMetricsFile } from '../../../tools/font-metrics.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (rel) => readFileSync(root + rel, 'utf8');
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

const NUDGE = 'var(--ui-cap-nudge)';

/** The label faces: every Barlow and Barlow Condensed file the game ships. */
const LABEL_FONTS = readdirSync(root + 'apps/game/fonts')
  .filter((f) => /^barlow(-condensed)?-latin-\d+\.woff2$/.test(f))
  .sort();

/** How far below the middle of its line box a capital's middle sits, in em. */
function capDrop(m) {
  const above = m.hheaAscender - m.capHeight;
  const below = -m.hheaDescender;
  return (above - below) / 2 / m.unitsPerEm;
}

/** The declarations of every rule whose selector list is exactly `selector`, in source order. */
function rules(rel, selector) {
  const css = stripComments(read(rel));
  const out = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1].trim().replace(/\s+/g, ' ') !== selector) continue;
    const decls = {};
    for (const d of m[2].matchAll(/([a-z-]+)\s*:\s*([^;]+);/g)) decls[d[1]] = d[2].trim().replace(/\s+/g, ' ');
    out.push(decls);
  }
  assert.ok(out.length > 0, `${rel}: no rule "${selector}"`);
  return out;
}

/** The value of a custom property in the first :root block of a sheet. */
function rootToken(rel, name) {
  const css = stripComments(read(rel));
  const body = css.slice(css.search(/(^|\n):root\s*\{/));
  const m = body.match(new RegExp(`${name}\\s*:\\s*([^;]+);`));
  assert.ok(m, `${rel} has no ${name}`);
  return m[1].trim();
}

/**
 * Splits a padding shorthand into its four sides. Calc expressions stay
 * whole (they hold spaces inside the parentheses).
 */
function paddingSides(value) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of value) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ' ' && depth === 0) {
      if (cur) parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur) parts.push(cur);
  const [t, r = t, b = t, l = r] = parts;
  return { top: t, right: r, bottom: b, left: l };
}

/**
 * True when the padding moves the content up by the nudge and nothing else:
 * top 0 and bottom twice the nudge, or the same length P with the nudge
 * taken from the top and added below.
 */
function nudgedUp(padding) {
  const { top, bottom } = paddingSides(padding);
  if (top === '0') return bottom === `calc(2 * ${NUDGE})`;
  const t = top.match(/^calc\((.+) - var\(--ui-cap-nudge\)\)$/);
  const b = bottom.match(/^calc\((.+) \+ var\(--ui-cap-nudge\)\)$/);
  return Boolean(t && b && t[1] === b[1]);
}

test('the label fonts: hhea and typo metrics agree, so every platform lines them up alike', () => {
  assert.ok(LABEL_FONTS.length >= 7, `expected Barlow 400 to 700 and Barlow Condensed 500 to 700, found ${LABEL_FONTS}`);
  for (const f of LABEL_FONTS) {
    const m = readFontMetricsFile(`${root}apps/game/fonts/${f}`);
    assert.ok(m.useTypoMetrics, `${f}: USE_TYPO_METRICS is off, Windows would use the win metrics`);
    assert.equal(m.typoAscender, m.hheaAscender, `${f}: typo and hhea ascender differ`);
    assert.equal(m.typoDescender, m.hheaDescender, `${f}: typo and hhea descender differ`);
    assert.equal(m.typoLineGap, 0, `${f}: a line gap would change line-height: normal`);
    assert.equal(m.hheaLineGap, 0, `${f}: a line gap would change line-height: normal`);
  }
});

test('--ui-cap-nudge is the drop of the capitals, recomputed from every label font', () => {
  const drops = new Set(LABEL_FONTS.map((f) => capDrop(readFontMetricsFile(`${root}apps/game/fonts/${f}`))));
  assert.equal(drops.size, 1, `the label fonts disagree: ${[...drops]}`);
  const [drop] = drops;
  assert.ok(drop > 0, 'the capitals of these fonts sit low in their line box');
  assert.equal(rootToken('apps/game/css/theme.css', '--ui-cap-nudge'), `${drop}em`);
  assert.equal(rootToken('apps/website/assets/site.css', '--ui-cap-nudge'), `${drop}em`);
});

test('the padding check accepts only a pure upward move', () => {
  assert.ok(nudgedUp(`0 1.25em calc(2 * ${NUDGE})`));
  assert.ok(nudgedUp(`calc(7px - ${NUDGE}) 14px calc(7px + ${NUDGE})`));
  assert.ok(!nudgedUp('7px 14px'));
  assert.ok(!nudgedUp(`calc(7px - ${NUDGE}) 14px calc(6px + ${NUDGE})`));
  assert.ok(!nudgedUp(`0 1.25em ${NUDGE}`));
});

/** Every control with a label in capitals, as [sheet, selector] (each rule of that selector that sets padding). */
const CONTROLS = [
  // The design system.
  ['apps/game/css/patterns.css', '.ui-btn'],
  ['apps/game/css/patterns.css', '.ui-btn-sm'],
  ['apps/game/css/patterns.css', '.ui-btn-hazard > span'],
  ['apps/game/css/patterns.css', '.ui-menubar-item'],
  ['apps/game/css/controls.css', '.ui-segmented > .ui-segment'],
  ['apps/game/css/controls.css', '.ui-badge'],
  ['apps/game/css/controls.css', '.ui-badge-hazard > .ui-badge-text'],
  ['apps/game/css/controls.css', '.ui-tab'],
  ['apps/game/css/controls.css', '.menu-card button.ui-mini, button.ui-mini'],
  // Screens that set their own padding on those classes.
  ['apps/game/css/audio.css', '.music-player .music-transport .ui-btn'],
  ['apps/game/css/campaign.css', '.campaign-tabs > .ui-tab'],
  ['apps/game/css/campaign.css', '.campaign-play.ui-btn'],
  ['apps/game/css/records.css', '.records-tabs > .ui-tab'],
  ['apps/game/css/gamemenu.css', '.gm-item'],
  // The older button classes still on screens.
  ['apps/game/css/online.css', '.online-btn'],
  ['apps/game/css/online.css', '.online-btn-small'],
  ['apps/game/css/online.css', '.online-chip'],
  ['apps/game/css/lobby.css', '#menu .lobby-btn'],
  ['apps/game/css/lobby.css', '#menu .lobby-btn-primary'],
  ['apps/game/css/startmenu.css', '.start-item, #records-entry button, .start-more-item'],
  ['apps/game/css/startmenu.css', '.start-item, #records-entry button'],
  ['apps/game/css/style.css', '.menu-card button'],
  ['apps/game/css/style.css', '.menu-card button.game-menu-mini'],
  ['apps/game/css/style.css', '.hud-button'],
  ['apps/game/css/touch.css', '.touch-button'],
  ['apps/game/css/touch.css', 'body.touch .hud-button'],
  ['apps/game/css/touch.css', "#app[data-layout='portrait'] .touch-button"],
  ['apps/game/css/records.css', '.records-dialog button:not(.ui-btn):not(.ui-tab):not(.records-row)'],
  ['apps/game/css/endgame.css', '.menu-card button.stats-tab'],
  ['apps/game/css/content.css', '#content-button'],
  ['apps/game/css/content.css', '.menu-card button.content-tab'],
  ['apps/game/css/content.css', '.menu-card button.content-notice-close'],
  ['apps/game/css/content.css', '.menu-card .content-steps button:not(.content-dropzone)'],
  ['apps/game/css/audio.css', '#audio-button'],
  ['apps/game/css/chat.css', '.chat-mode, .chat-close, .chat-mute-button'],
  ['apps/game/css/campaign.css', '.campaign-btn'],
  ['apps/game/css/account.css', '.account-row button, .account-signin'],
  ['apps/game/css/releasenotes.css', '.menu-card .rn-footer button, .menu-card button.rn-close'],
  ['apps/game/css/releasenotes.css', '.menu-card button.rn-close'],
  ['apps/game/css/friends.css', '.friends-menu-item'],
  ['apps/game/css/gamemenu.css', '.gm-keys-group'],
  ['apps/game/editor/editor.css', '.editor button:where(:not(.ui-sp-button, .ui-sp-close))'],
  // The website.
  ['apps/website/assets/site.css', '.btn'],
  ['apps/website/assets/site.css', '.btn-small'],
  ['apps/website/assets/site.css', '.btn-big'],
  ['apps/website/assets/site.css', '.nav-toggle'],
  ['apps/website/assets/site.css', '.site-nav a:not(.btn)'],
  ['apps/website/assets/site.css', '.beta-badge'],
  ['apps/website/assets/site.css', '.segmented button'],
  ['apps/website/assets/site.css', '.badge'],
  ['apps/website/assets/account.css', '.btn-hazard > span'],
  ['apps/website/assets/account.css', '.tab'],
  ['apps/website/assets/account.css', '.account-nav-link'],
];

test('every control with a label in capitals moves its text up by the nudge', () => {
  for (const [rel, selector] of CONTROLS) {
    const withPadding = rules(rel, selector).filter((d) => d.padding !== undefined);
    assert.ok(withPadding.length > 0, `${rel} "${selector}" sets no padding`);
    for (const d of withPadding) {
      assert.ok(nudgedUp(d.padding), `${rel} "${selector}": padding ${d.padding} does not move the capitals up by ${NUDGE}`);
      assert.equal(d['padding-top'], undefined, `${rel} "${selector}": a padding-top would undo the nudge`);
      assert.equal(d['padding-bottom'], undefined, `${rel} "${selector}": a padding-bottom would undo the nudge`);
    }
  }
});

test('a content-high small online button keeps its height: the nudge comes off its line', () => {
  const [base] = rules('apps/game/css/online.css', '.online-btn-small');
  assert.equal(base['min-height'], '0');
  assert.equal(base['line-height'], `calc(1.2em - 2 * ${NUDGE})`);
  // 1.2 is line-height: normal of Barlow: (ascender + descender + line gap) / unitsPerEm.
  const m = readFontMetricsFile(`${root}apps/game/fonts/barlow-latin-700.woff2`);
  assert.equal((m.hheaAscender - m.hheaDescender + m.hheaLineGap) / m.unitsPerEm, 1.2);
});

test('the select plate centres its value, lamps beside capitals move down by the nudge', () => {
  const [value] = rules('apps/game/css/controls.css', '.ui-sp-value');
  assert.equal(value['padding-bottom'], `calc(2 * ${NUDGE})`);
  const [lamps] = rules('apps/game/css/controls.css', '.ui-btn > .ui-led, .ui-tab > .ui-led, .ui-badge > .ui-led, .ui-menubar-item > .ui-led, .ui-segmented > .ui-segment::before');
  assert.equal(lamps['margin-top'], `calc(2 * ${NUDGE})`);
  for (const [rel, selector] of [
    ['apps/website/assets/site.css', '.beta-badge .lamp'],
    ['apps/website/assets/site.css', '.segmented button::before'],
    ['apps/website/assets/site.css', '.badge::before'],
    ['apps/website/assets/account.css', '.account-nav-link .lamp'],
  ]) {
    assert.equal(rules(rel, selector)[0]['margin-top'], `calc(2 * ${NUDGE})`, `${rel} "${selector}"`);
  }
});

test('the nudge is used only in the forms above', () => {
  const sheets = [
    ...readdirSync(root + 'apps/game/css')
      .filter((f) => f.endsWith('.css'))
      .map((f) => `apps/game/css/${f}`),
    'apps/game/editor/editor.css',
    'apps/website/assets/site.css',
    'apps/website/assets/account.css',
  ];
  for (const rel of sheets) {
    for (const m of stripComments(read(rel)).matchAll(/([a-z-]+)\s*:\s*([^;{}]*var\(--ui-cap-nudge\)[^;{}]*);/g)) {
      const [, prop, value] = m;
      const v = value.trim().replace(/\s+/g, ' ');
      if (prop === 'padding') assert.ok(nudgedUp(v), `${rel}: padding ${v}`);
      else if (prop === 'padding-bottom' || prop === 'margin-top') assert.equal(v, `calc(2 * ${NUDGE})`, `${rel}: ${prop} ${v}`);
      else if (prop === 'line-height') assert.equal(v, `calc(1.2em - 2 * ${NUDGE})`, `${rel}: ${prop} ${v}`);
      else assert.fail(`${rel}: ${prop} uses the nudge`);
    }
  }
});

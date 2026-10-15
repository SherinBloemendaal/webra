// The menu screens outside the battlefield are full-width cards: the start
// screen (main menu bar and skirmish setup), online play, the campaign, the
// statistics, the Load game list and the account's Replays list fill the window less one gap
// (css/theme.css --ui-screen-gap), so the grid background shows around them.
// Small dialogs stay compact. There is no layout engine here: the tests read
// the stylesheets, check the rules that make each screen a card, and work
// out from the numbers in them that the container queries still pick the
// layouts they are written for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { timeSteps, graphLayout, TIME_LABEL_GAP, TIME_LABELS_MAX } from '../js/stats.js';
import { dialog, mountRecordEntries } from '../js/records.js';
import { MemoryBackend, SaveStore } from '../js/saves.js';
import { installDom, uninstallDom } from './dom-fixtures.mjs';

const CSS_DIR = fileURLToPath(new URL('../css/', import.meta.url));
const FILES = readdirSync(CSS_DIR).filter((f) => f.endsWith('.css'));
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const SHEETS = Object.fromEntries(FILES.map((f) => [f, strip(readFileSync(CSS_DIR + f, 'utf8'))]));

/**
 * Every style rule of a sheet as { sel, decls, at }: `at` lists the at-rule
 * preludes it sits in (outermost first), e.g. ['@container lobby (min-width: 1440px)'].
 */
function parse(css) {
  const out = [];
  const stack = [];
  let start = 0;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === '{') {
      const prelude = css.slice(start, i).trim();
      if (prelude.startsWith('@')) {
        stack.push(prelude);
        start = i + 1;
        continue;
      }
      const end = css.indexOf('}', i);
      const decls = {};
      for (const d of css.slice(i + 1, end).split(';')) {
        const k = d.indexOf(':');
        if (k > 0) decls[d.slice(0, k).trim()] = d.slice(k + 1).trim().replace(/\s+/g, ' ');
      }
      for (const sel of prelude.split(',')) out.push({ sel: sel.trim().replace(/\s+/g, ' '), decls, at: [...stack] });
      i = end;
      start = i + 1;
    } else if (c === '}') {
      stack.pop();
      start = i + 1;
    } else if (c === ';' && !stack.length) {
      start = i + 1;
    }
  }
  return out;
}

const RULES = Object.fromEntries(Object.entries(SHEETS).map(([f, css]) => [f, parse(css)]));
const ALL = Object.entries(RULES).flatMap(([file, rules]) => rules.map((r) => ({ ...r, file })));
/** The declarations of `sel` outside any at-rule, merged in sheet order. */
const base = (sel) => Object.assign({}, ...ALL.filter((r) => r.sel === sel && !r.at.length).map((r) => r.decls));
const px = (s) => Number(/(-?[\d.]+)px/.exec(s)?.[1]);
/** The first number of a value: the cap of min(420px, ...) or min(calc(560 * var(--ui-px)), 100%). */
const first = (s) => Number(/[\d.]+/.exec(s ?? '')?.[0]);

/** The :root tokens of theme.css (outside media queries). */
const ROOT = base(':root');

const SCREENS = [
  ['style.css', '#menu'],
  ['online.css', '#online-root'],
  ['campaign.css', '#campaign-root'],
  ['endgame.css', '#stats-screen'],
];

const CARDS = ['#menu .lobby', '.start-nav', '.online-page', '.campaign-page', '.menu-card.stats-card', '.records-dialog.records-screen'];

test('screens: one gap token, 12 to 24 px by the window, 8 px on phones, never inside the safe area', () => {
  const gap = ROOT['--ui-screen-gap'];
  const m = /^clamp\((\d+)px, ([\d.]+)vw, (\d+)px\)$/.exec(gap);
  assert.ok(m, `--ui-screen-gap is a clamp: ${gap}`);
  assert.equal(Number(m[1]), 12);
  assert.equal(Number(m[3]), 24);
  // The window width where the gap reaches each end.
  assert.ok((12 / Number(m[2])) * 100 >= 600 && (24 / Number(m[2])) * 100 <= 1920, 'the gap grows between phone and full HD widths');
  const phone = RULES['theme.css'].find((r) => r.sel === ':root' && r.at.some((a) => /max-width: 600px/.test(a)));
  assert.equal(phone?.decls['--ui-screen-gap'], '8px');
  // Each side: the gap, or the safe-area inset where it is larger.
  const pad = ROOT['--ui-screen-pad'];
  for (const side of ['top', 'right', 'bottom', 'left']) assert.match(pad, new RegExp(`max\\(var\\(--ui-screen-gap\\), env\\(safe-area-inset-${side}\\)\\)`));
  assert.deepEqual(
    [...pad.matchAll(/inset-(\w+)/g)].map((x) => x[1]),
    ['top', 'right', 'bottom', 'left'],
    'in padding order',
  );
  assert.match(ROOT['--ui-screen-bg'], /var\(--ui-grid\)/, 'the screens show the grid');
  assert.match(ROOT['--ui-measure'], /^\d+ch$/);
});

test('screens: each screen pads by the gap, shows the grid and stretches its card', () => {
  for (const [file, sel] of SCREENS) {
    const d = Object.assign({}, ...RULES[file].filter((r) => r.sel === sel && !r.at.length).map((r) => r.decls));
    assert.equal(d.padding, 'var(--ui-screen-pad)', `${sel} padding`);
    assert.equal(d['padding-bottom'], 'max(var(--ui-screen-gap), env(safe-area-inset-bottom), var(--ui-corner-clear))', `${sel} clears the corner parts`);
    assert.equal(d['grid-template-columns'], 'minmax(0, 1fr)', `${sel}: the card takes the width`);
    assert.equal(d['place-items'], undefined, `${sel} does not centre a capped card`);
    assert.match(d.background, /--ui-grid|--ui-screen-bg/, `${sel} shows the grid`);
  }
});

test('screens: the cards have no width cap, the compact dialogs keep theirs', () => {
  for (const sel of CARDS) {
    const d = base(sel);
    for (const prop of ['width', 'max-width']) {
      if (d[prop] === undefined) continue;
      assert.doesNotMatch(d[prop], /\d+px|calc\(\d+ \* var\(--ui-px\)\)/, `${sel} ${prop}: ${d[prop]}`);
    }
  }
  for (const [file, css] of Object.entries(SHEETS)) assert.doesNotMatch(css, /min\(10[48]0px/, `${file} still caps a screen at 1080 or 1040 px`);
  const capped = {
    '.menu-card': 440,
    '.game-menu-card': 560,
    '.endgame-card': 460,
    '.online-dialog': 420,
    '.account-dialog': 440,
    '.audio-card': 520,
    '.rn-card': 640,
    '.records-dialog': 560,
  };
  for (const [sel, w] of Object.entries(capped)) assert.equal(first(base(sel).width), w, `${sel} stays a ${w} px dialog`);
});

test('screens: the start screen stacks the menu bar over the skirmish card, which takes the rest of the height', () => {
  const menu = Object.assign({}, ...RULES['startmenu.css'].filter((r) => r.sel === '#menu' && !r.at.length).map((r) => r.decls));
  assert.equal(menu['grid-template-rows'], 'auto 1fr');
  assert.equal(menu.gap, 'var(--ui-screen-gap)');
  assert.equal(base('#menu #skirmish').display, 'flex');
  assert.equal(base('#menu #skirmish > .lobby').flex, '1 0 auto');
  // The cards are columns whose body grows, so the footer bar sits at the bottom.
  for (const [card, body] of [
    ['#menu .lobby', '#menu .lobby-body'],
    ['.online-page', '.online-lobby-body'],
    ['.campaign-page', '.campaign-body'],
  ]) {
    assert.equal(base(card)['flex-direction'], 'column', card);
    assert.equal(base(body).flex, '1 0 auto', body);
  }
});

test('container queries: every one names a container that a card or panel declares', () => {
  const declared = new Set(ALL.map((r) => /^([a-z-]+) \/ inline-size$/.exec(r.decls.container ?? '')?.[1]).filter(Boolean));
  assert.deepEqual([...declared].sort(), ['campaign', 'gm', 'lobby', 'lobby-panel', 'online', 'records']);
  const used = ALL.flatMap((r) => r.at.filter((a) => a.startsWith('@container')));
  assert.ok(used.length > 0);
  for (const at of used) {
    const name = /^@container ([a-z-]+) \(/.exec(at)?.[1];
    assert.ok(name, `${at}: a named container, so a wider card cannot change what it measures`);
    assert.ok(declared.has(name), `${at}: ${name} is declared`);
  }
  // The skirmish setup follows its card, not the window.
  assert.ok(!ALL.some((r) => r.sel === '#menu .lobby-body' && r.at.some((a) => a.startsWith('@media'))), 'no window media query for the lobby columns');
});

/** The rules of one at-rule prelude matching `re`. */
const inAt = (file, re) => RULES[file].filter((r) => r.at.some((a) => re.test(a)));
const atWidth = (file, re) => Number(/(\d+)px\)$/.exec(RULES[file].flatMap((r) => r.at).find((a) => re.test(a)))[1]);

test('lobby: from the wide breakpoint the players panel stays a table next to the map and the options', () => {
  const wide = atWidth('lobby.css', /^@container lobby \(min-width/);
  const rules = inAt('lobby.css', /^@container lobby \(min-width/);
  const body = rules.find((r) => r.sel === '#menu .lobby-body').decls['grid-template-columns'];
  const side = rules.find((r) => r.sel === '#menu .lobby-side').decls['grid-template-columns'];
  const [, lo, pct, hi] = /clamp\((\d+)px, (\d+)%, (\d+)px\)/.exec(body).map(Number);
  const [, fa, fb] = /minmax\(0, ([\d.]+)fr\) minmax\(0, ([\d.]+)fr\)/.exec(side).map(Number);
  const gap = px(base('#menu .lobby-body').gap);
  const sideGap = px(base('#menu .lobby-side').gap);
  const panel = (inner) => inner - 2 - 2 * px(base('#menu .lobby-panel-body').padding); // borders and padding
  const tableMin = Number(/max-width: (\d+)px/.exec(RULES['lobby.css'].flatMap((r) => r.at).find((a) => a.startsWith('@container lobby-panel')))[1]);
  for (const width of [wide, 1600, 1830, 2470]) {
    const map = Math.min(hi, Math.max(lo, (width * pct) / 100));
    const rest = width - map - gap - sideGap;
    const players = panel((rest * fa) / (fa + fb));
    assert.ok(players > tableMin, `card ${width}: players panel ${players.toFixed(0)} px > ${tableMin}`);
    assert.ok(map <= hi && map >= lo);
  }
  // The narrow layout (one column) begins well below the wide one.
  const narrow = atWidth('lobby.css', /^@container lobby \(max-width/);
  assert.ok(narrow < wide - 300);
});

test('online lobby: the options get their own column only on wide cards, spanning the slot rows', () => {
  const rules = inAt('online.css', /^@container online \(min-width/);
  assert.equal(atWidth('online.css', /^@container online \(min-width/), atWidth('lobby.css', /^@container lobby \(min-width/), 'the same breakpoint as the skirmish setup');
  const col = rules.find((r) => r.sel === '.online-lobby-body > .online-col:first-child').decls;
  assert.equal(col['grid-template-rows'], 'auto auto auto 1fr', 'three slot rows (bulk edit, slots, spectators) and a row for the rest');
  const opts = rules.find((r) => r.sel === '.online-lobby-body > .online-col:first-child > .online-options').decls;
  assert.equal(opts['grid-row'], '1 / -1');
  assert.equal(opts['grid-column'], '2');
});

test('campaign: the preview goes beside the briefing once the mission column is 760 px wide', () => {
  const wide = atWidth('campaign.css', /^@container campaign \(min-width/);
  const cols = base('.campaign-body')['grid-template-columns'];
  const [, pct, cap] = /min\((\d+)%, (\d+)px\)/.exec(cols).map(Number);
  const list = Math.min((wide * pct) / 100, cap);
  assert.ok(wide - list - px(base('.campaign-body').gap) >= 760, `mission column at ${wide}`);
  const rules = inAt('campaign.css', /^@container campaign/);
  const rows = rules.find((r) => r.sel === '.campaign-details').decls['grid-template-rows'];
  // canvas, title, side, briefing, options, note, Play: six beside the preview.
  assert.equal(rows, 'repeat(6, auto) 1fr');
  assert.equal(rules.find((r) => r.sel === '.campaign-details > .campaign-preview').decls['grid-row'], '1 / -1');
});

test('measure: running text in the wide cards keeps a readable line length', () => {
  for (const sel of ['.campaign-briefing', '.online-page p:not(.online-caption)', '.stats-card .tagline', '.stats-card .hint', '#menu .lobby-error-text', '#menu .lobby-modded p', '.records-screen .records-muted']) {
    assert.equal(base(sel)['max-width'], 'var(--ui-measure)', sel);
  }
});

test('corner parts: the online and campaign cards end above Sound and Original content', () => {
  const rule = (sel) => base(sel);
  const height = (d) => {
    // padding (top and bottom), one line of --ui-fs-s at line height 1.5, and the borders.
    const pad = Number(/calc\((\d+) \* var\(--ui-px\)\)/.exec(d.padding)[1]);
    return 2 * pad + 11 * 1.5 + 2;
  };
  const bottom = (d) => Number(/calc\((\d+) \* var\(--ui-px\)\)/.exec(d.bottom)[1]);
  const audio = rule('#audio-button');
  const content = rule('#content-button');
  const clear = (sel) => Number(/calc\((\d+)px \* var\(--ui-scale\)\)/.exec(ALL.find((r) => r.sel === sel && !r.at.length).decls['--ui-corner-clear'])[1]);
  assert.ok(clear('#online-root:has(~ #audio-button:not([hidden]))') >= bottom(audio) + height(audio) + 4);
  assert.ok(clear('#online-root:has(~ #content-button:not([hidden]))') >= bottom(content) + height(content) + 4);
  for (const sel of ['#campaign-root:has(~ #audio-button:not([hidden]))', '#campaign-root:has(~ #content-button:not([hidden]))']) assert.ok(ALL.some((r) => r.sel === sel));
  // The version tag (6 px up, one 11 px line) on every screen, Load game too (top layer).
  assert.ok(px(ROOT['--ui-corner-clear']) >= 6 + 11 * 1.4);
  assert.equal(base('.records-dialog.records-screen').bottom, 'max(var(--ui-screen-gap), env(safe-area-inset-bottom), var(--ui-corner-clear))');
  // The statistics over a game on a mouse device: the Sound button stays there (css/touch.css hides it on touch).
  const stats = ALL.find((r) => /#stats-screen:has\(~ #audio-button:not\(\[hidden\]\)\)$/.test(r.sel) && !r.at.length);
  assert.ok(stats, 'the statistics clear the Sound button');
  assert.match(stats.sel, /^body:not\(\.touch\) #app:not\(\[data-layout='portrait'\]\):not\(\[data-layout='landscape'\]\) ~ /);
  assert.ok(clear(stats.sel) >= bottom(audio) + height(audio) + 4);
  const touchHides = SHEETS['touch.css'];
  for (const s of ["body.touch #app:not([hidden]) ~ #audio-button", "#app[data-layout='portrait']:not([hidden]) ~ #audio-button", "#app[data-layout='landscape']:not([hidden]) ~ #audio-button"]) {
    assert.ok(touchHides.includes(s), `touch.css still hides the Sound button: ${s}`);
  }
});

test('server browser: the session list takes the height of the card, its status under it', () => {
  const list = base('.online-page > .online-sessions');
  assert.equal(list.flex, '1 0 auto');
  assert.equal(list['align-content'], 'start', 'rows stay at the top of the well');
  assert.ok(ALL.some((r) => r.sel === '.online-page > .online-sessions + .online-muted'));
});

test('statistics graph: time labels at least 80 px apart, at most 12 however wide the screen', () => {
  assert.equal(TIME_LABEL_GAP, 80);
  assert.equal(TIME_LABELS_MAX, 12);
  assert.equal(timeSteps(0), 1);
  assert.equal(timeSteps(79), 1);
  assert.equal(timeSteps(532), 6, 'the old 1040 px card');
  assert.equal(timeSteps(2400), 12, 'a 2560 px window');
  let last = 0;
  for (let w = 0; w <= 4000; w += 37) {
    const n = timeSteps(w);
    assert.ok(n >= last && n >= 1 && n <= 12);
    if (n > 1) assert.ok(w / n >= TIME_LABEL_GAP, `${w} px: ${n} labels`);
    last = n;
  }
  const L = graphLayout([{ player: 0, values: [0, 1] }], [0, 100], 1900, 400);
  assert.equal(L.steps, timeSteps(L.plot.x1 - L.plot.x0));
});

test('Load game and the account\'s Replays are screen cards; other record dialogs stay compact', () => {
  const doc = installDom();
  try {
    dialog('Modded map', () => {});
    const plain = doc.body.childNodes.find((n) => n.localName === 'dialog');
    assert.equal(plain.className, 'records-dialog');
    plain.remove();
    dialog('A list', () => {}, { screen: true });
    const open = doc.body.childNodes.find((n) => n.localName === 'dialog');
    assert.equal(open.className, 'records-dialog records-screen');
    assert.equal(open.open, true);
    open.remove();

    const root = doc.createElement('div');
    mountRecordEntries(root, { version: 'test', canPlay: () => true, showError: () => {}, onLoadSave: () => {}, onWatchReplay: () => {}, store: new SaveStore(new MemoryBackend()) });
    root.childNodes.find((b) => b.textContent === 'Load game').click();
    const load = doc.body.childNodes.find((n) => n.localName === 'dialog');
    assert.equal(load.className, 'records-dialog records-screen');
    load.remove();

    // Replays with an account (the account's list) is a list screen too.
    const signedIn = doc.createElement('div');
    const api = { replays: () => new Promise(() => {}) };
    mountRecordEntries(signedIn, { version: 'test', canPlay: () => true, showError: () => {}, onLoadSave: () => {}, onWatchReplay: () => {}, store: new SaveStore(new MemoryBackend()), accountReplays: { available: () => true, api } });
    signedIn.childNodes.find((b) => b.textContent === 'Replays').click();
    const replays = doc.body.childNodes.find((n) => n.localName === 'dialog');
    assert.equal(replays.className, 'records-dialog records-screen');
  } finally {
    uninstallDom();
  }
});

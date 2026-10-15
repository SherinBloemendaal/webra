// Watching a running game on a phone (portrait and landscape, touch): the
// session list's Watch button, the catch-up message, the observer panel
// (views, statistics, icons), the replay bar and the chat. There is no
// layout engine here: the tests check the CSS rules that place these parts
// (css/records.css, css/chat.css, css/online.css), the markup the game
// builds, and the chat's first line.
// Run with: node --test apps/game/tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { installDom, uninstallDom, click } from './dom-fixtures.mjs';
import { ObserverPanel, COMBINED_VIEW, OBSERVER_VIEW } from '../js/observer.js';
import { chatIntroLine } from '../js/online.js';
import { touchUi } from '../js/touch.js';
import { chatTip } from '../js/hudtips.js';

const read = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const CSS_DIR = fileURLToPath(new URL('../css/', import.meta.url));
const CSS = readdirSync(CSS_DIR)
  .filter((f) => f.endsWith('.css'))
  .map((f) => readFileSync(CSS_DIR + f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''))
  .join('\n');

/** Every innermost rule as [selector, declarations, media] (rules inside @media too, with their query). */
function rules(css) {
  const out = [];
  const media = [];
  for (const m of css.matchAll(/@media([^{]+)\{((?:[^{}]*\{[^{}]*\})*)\s*\}/g)) media.push([m.index, m.index + m[0].length, m[1].trim()]);
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decls = Object.fromEntries(
      m[2]
        .split(';')
        .map((d) => d.split(':'))
        .filter((d) => d.length >= 2)
        .map(([k, ...v]) => [k.trim(), v.join(':').trim()]),
    );
    const query = media.find(([a, b]) => m.index >= a && m.index < b)?.[2] ?? null;
    const selectors = m[1].replace(/@media[^{]*$/, '');
    for (const sel of selectors.split(',')) out.push([sel.trim().replace(/^@media[^{]*\{\s*/, ''), decls, query]);
  }
  return out;
}
const RULES = rules(CSS);
/** Declarations of the rules with exactly this selector. */
const exact = (selector) => RULES.filter(([sel]) => sel === selector);

/**
 * The CSS length `expr` (calc, max, px and var(--ui-px)) in px at UI scale
 * `scale`, with `percent` for 100% (the battlefield's height).
 */
function cssPx(expr, scale, percent = 800) {
  const js = expr
    .replace(/var\(--ui-px\)/g, `(${scale})`)
    .replace(/(\d+(?:\.\d+)?)px/g, '$1')
    .replace(/(\d+(?:\.\d+)?)%/g, `($1 * ${percent} / 100)`)
    .replace(/calc\(/g, '(')
    .replace(/max\(/g, 'Math.max(');
  assert.match(js, /^[\d\s.+\-*/()Mathmax,]+$/, `only arithmetic in ${expr}`);
  return Function(`return ${js}`)();
}

test('touch screens: the observer panel starts below the 44 px HUD buttons at every UI scale and scrolls on short screens', () => {
  const [[, panel]] = exact('body.touch .observer-panel');
  const buttons = RULES.find(([s]) => s === '.hud-buttons')[1];
  const button = exact('body.touch .hud-button')[0][1];
  for (const scale of [0.5, 0.85, 1, 1.5]) {
    // The HUD buttons' bottom: their row's top plus the touch height and the borders (1 px each).
    const bottom = cssPx(buttons.top, scale) + cssPx(button['min-height'], scale) + 2;
    const top = cssPx(panel.top, scale);
    assert.ok(top >= bottom + 2, `scale ${scale}: panel top ${top} px clears the Menu button's bottom ${bottom} px`);
    assert.equal(cssPx(panel['max-height'], scale) + top <= 800, true, `scale ${scale}: the panel ends above the bottom`);
  }
  assert.equal(panel['overflow-y'], 'auto');
  // The view buttons and the panel picker are touch targets.
  for (const sel of ['.observer-view', '.observer-toggle', '.replay-bar button']) {
    const coarse = RULES.find(([s, , q]) => s === sel && q === '(pointer: coarse)');
    assert.equal(coarse?.[1]['min-height'], '44px', `${sel} on touch screens`);
  }
});

test('phones: the view buttons are one row that scrolls sideways; the panel fits the screen', () => {
  for (const layout of ['portrait', 'landscape']) {
    const [[, views]] = exact(`#app[data-layout='${layout}'] .observer-views`);
    assert.equal(views['flex-wrap'], 'nowrap', layout);
    assert.equal(views['overflow-x'], 'auto', layout);
    assert.equal(views['justify-content'], 'flex-start', `${layout}: no buttons pushed out of reach on the left`);
    assert.equal(views['touch-action'], 'pan-x', `${layout}: a finger scrolls the row`);
    assert.equal(exact(`#app[data-layout='${layout}'] .observer-view`)[0][1].flex, 'none');
  }
  const [[, portrait]] = exact("#app[data-layout='portrait'] .observer-panel");
  assert.equal(portrait.left, '8px', 'portrait: the whole width');
  assert.match(exact("#app[data-layout='landscape'] .observer-panel")[0][1]['max-width'], /50%/, 'landscape: half the width at most');
  // Narrow screens keep four statistics columns; icon rows keep their own grid.
  const narrow = RULES.find(([s, , q]) => s === '.observer-row' && q === '(max-width: 640px)');
  assert.match(narrow[1]['grid-template-columns'], /repeat\(3/);
  assert.equal(exact('.observer-icon-cell')[0][1]['overflow-x'], 'auto', 'a long row of icons scrolls');
});

test('spectators and replays: no touch action bar or placement buttons (no orders; the bottom is the replay bar and the chat)', () => {
  for (const sel of ['#app.viewer #touch-bar', '#app.viewer #touch-place', '#app.viewer #sidebar']) {
    assert.equal(exact(sel)[0]?.[1].display, 'none !important', sel);
  }
});

test('the catch-up message is one line where it fits, never half the screen wide', () => {
  const [[, box]] = exact('.records-progress');
  assert.equal(box.width, 'max-content');
  assert.match(box['max-width'], /100% - /);
});

test('replays: the chat sits above the replay bar however many rows the bar wraps to', () => {
  const [[, chat]] = exact('.chat-panel.above-replay-bar');
  assert.match(chat.bottom, /var\(--replay-bar-height/);
  assert.match(chat.bottom, /^max\(calc\(96 \* var\(--ui-px\)\)/, 'never lower than before');
  const main = read('../js/main.js');
  assert.match(main, /new ResizeObserver\(\(\) => \$\('field'\)\.style\.setProperty\('--replay-bar-height'/);
});

test('touch screens get a Chat button (no Enter key); the chat says how to open it', () => {
  assert.equal(exact('.hud-buttons .hud-chat')[0][1].display, 'none', 'not with a keyboard and mouse');
  assert.equal(exact('body.touch .hud-buttons .hud-chat')[0][1].display, 'block');
  const main = read('../js/main.js');
  assert.match(main, /chatButton\.className = 'hud-button hud-chat'/);
  assert.match(main, /if \(onlineChat\?\.send \|\| replayLines\)/, 'online games (players and spectators) and replays with chat');
  // One test for the button (body.touch, set by js/touch.js from touchUi) and the line's wording.
  assert.match(read('../js/online.js'), /touch: touchUi\(\)/);
  assert.match(read('../js/touch.js'), /if \(touchUi\(\)\) this\.markTouchUi\(\);/);
  const body = (on) => ({ body: { classList: { contains: (c) => on && c === 'touch' } } });
  const media = (coarse) => ({ matchMedia: () => ({ matches: coarse }) });
  assert.equal(touchUi(body(false), media(true)), true, 'a touch screen');
  assert.equal(touchUi(body(true), media(false)), true, 'a laptop touched once');
  assert.equal(touchUi(body(false), media(false)), false, 'mouse and keyboard');
  assert.equal(chatIntroLine({ spectator: true, list: 'Ann, Bo', touch: true }), 'Watching: Ann, Bo. Tap Chat to chat.');
  assert.equal(chatIntroLine({ spectator: true, list: 'Ann, Bo' }), 'Watching: Ann, Bo. Press Enter to chat.');
  assert.equal(chatIntroLine({ list: 'Ann, Bo', teamChat: true }), 'Online game: Ann, Bo. Press Enter to chat with your team, Shift+Enter with everyone.');
  assert.equal(chatIntroLine({ list: 'Ann, Bo', teamChat: true, touch: true }), 'Online game: Ann, Bo. Tap Chat to chat.');
  // Its tooltip (long press) names the keys a keyboard would use.
  const keys = { bindingsFor: (name) => ({ openTeamChat: ['Enter'], openGeneralChat: ['Shift+Enter'] })[name] ?? [] };
  assert.deepEqual(chatTip(keys, false), { title: 'Chat', hotkey: 'Enter, Shift+Enter', desc: 'The chat line and every line of the game so far.' });
  assert.equal(chatTip(keys, true).title, 'Close the chat');
  assert.equal(chatTip({ bindingsFor: () => [] }, false).hotkey, null);
});

test('the session list on phones: the name on a line of its own; Join and Spectate side by side, easy to tap', () => {
  const name = RULES.find(([s, , q]) => s === '.online-session > .online-cell-name' && q === '(max-width: 760px)');
  assert.equal(name?.[1]['grid-column'], '1 / -1');
  // The actions are in the detail panel (under the list on narrow cards), side by side.
  const actions = RULES.find(([s, , q]) => s === '.online-detail-actions' && !q);
  assert.equal(actions?.[1].display, 'flex');
  const buttons = RULES.find(([s, , q]) => s === '.online-detail-actions > .online-btn' && !q);
  assert.equal(buttons?.[1].flex, '1');
  assert.equal(buttons?.[1]['min-height'], '44px');
  const coarse = RULES.find(([s, , q]) => s === '.online-btn' && q === '(pointer: coarse)');
  assert.match(coarse?.[1]['min-height'] ?? '', /44px/, 'the buttons are touch targets');
});

test('the observer panel works by taps: every view is a button, the statistics a list', () => {
  const doc = installDom();
  const field = doc.createElement('main');
  doc.body.append(field);
  const views = [];
  const players = [
    { name: 'Ann', color: [1, 0, 0] },
    { name: 'Bo', color: [0, 0, 1] },
    { name: 'Cy', color: [0, 1, 0] },
    { name: 'Di', color: [1, 1, 0] },
  ];
  const panel = new ObserverPanel(field, { players, view: OBSERVER_VIEW, onView: (v) => views.push(v), onStats: () => views.push('stats') });
  const buttons = [...panel.root.querySelector('.observer-views').querySelectorAll('button')];
  assert.deepEqual(
    buttons.map((b) => b.textContent),
    ['All players', 'No shroud', 'Ann', 'Bo', 'Cy', 'Di', 'Statistics'],
  );
  click(buttons[0]);
  click(buttons[3]);
  click(buttons[6]);
  assert.deepEqual(views, [COMBINED_VIEW, 1, 'stats']);
  assert.equal(buttons[3].getAttribute('aria-pressed'), 'true');
  assert.equal(panel.root.querySelector('select').getAttribute('aria-label'), 'Statistics');
  uninstallDom();
});

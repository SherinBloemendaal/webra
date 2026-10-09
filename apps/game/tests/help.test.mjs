// Help tips: every lobby option and menu setting has a help text that
// matches the engine (js/help.js), the "?" tooltip behaves (hover, focus,
// tap, Esc, aria) and everything stays CSP safe (js/infotip.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { installDom, uninstallDom, FakeEvent, click } from './dom-fixtures.mjs';
import { HELP, helpText } from '../js/help.js';
import { infoTip, describedBy, closeOpenTip, openTip } from '../js/infotip.js';
import { LOBBY_OPTION_KEYS, SPEED_MS, GAME_SPEEDS } from '../protocol/index.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

// The key lists are exported by the UI modules; importing them needs a DOM-free load only.
const { HELP_KEYS } = await import('../js/lobby.js');
const { ONLINE_HELP_KEYS } = await import('../js/online.js');
const { MENU_HELP_KEYS } = await import('../js/gamemenu.js');

test('every lobby option, online option and menu setting has a help text', () => {
  const used = new Set([...HELP_KEYS, ...ONLINE_HELP_KEYS, ...MENU_HELP_KEYS.map((k) => `settings.${k}`)]);
  for (const key of used) {
    assert.ok(Object.hasOwn(HELP, key), `no help text for ${key}`);
    assert.ok(helpText(key).length >= 20, `help for ${key} is too short`);
    assert.ok(helpText(key).length <= 800, `help for ${key} is too long for a tooltip`);
  }
  // Every option the engine and the server know is explained, in both lobbies.
  for (const key of LOBBY_OPTION_KEYS) {
    assert.ok(HELP_KEYS.includes(key), `skirmish lobby has no help for ${key}`);
    assert.ok(ONLINE_HELP_KEYS.includes(key), `online lobby has no help for ${key}`);
  }
  // No dead texts: every entry is shown somewhere.
  for (const key of Object.keys(HELP)) assert.ok(used.has(key), `help text ${key} is never shown`);
  assert.throws(() => helpText('nope'), /No help text/);
});

test('help texts: plain English sentences without typographic dashes', () => {
  for (const [key, text] of Object.entries(HELP)) {
    assert.doesNotMatch(text, /[\u2013\u2014]/, `${key} has an en or em dash`);
    assert.match(text, /^[A-Z`]/, `${key} starts with a capital`);
    assert.match(text, /[.)]$/, `${key} ends with a full stop`);
    assert.doesNotMatch(text, /\s{2}/, `${key} has double spaces`);
  }
});

test('weather, biome and speed help match the engine numbers', () => {
  const weather = read('../../../engine/src/weather.rs');
  const pct = (name) => Number(new RegExp(`pub const ${name}: i32 = (\\d+);`).exec(weather)[1]);
  const sight = {};
  for (const m of weather.matchAll(/((?:Weather::\w+(?: \| )?)+) => (\d+),/g)) {
    for (const w of m[1].split(' | ')) sight[w.replace('Weather::', '')] = Number(m[2]);
  }
  const text = HELP.weather;
  assert.match(text, new RegExp(`${sight.Rain} % in rain`));
  assert.equal(sight.Thunderstorm, sight.Snowfall);
  assert.match(text, new RegExp(`${sight.Thunderstorm} % in thunderstorms and snowfall`));
  assert.match(text, new RegExp(`${sight.Sandstorm} % in sandstorms`));
  assert.match(text, new RegExp(`infantry moves at ${pct('SNOW_INFANTRY_SPEED_PCT')} %`));
  assert.match(text, new RegExp(`turn at ${pct('SNOW_TURN_PCT')} % \\(${pct('ICE_TURN_PCT')} % on ice\\)`));
  assert.match(text, new RegExp(`move at ${pct('OVERHEAT_SPEED_PCT')} %`));
  // 1000 heat at +1 per tick, 25 ticks a second.
  assert.equal(pct('HEAT_MAX') / pct('HEAT_MOVE') / 25, 40);
  assert.match(text, /about 40 s/);
  assert.equal(pct('OVERHEAT_RELOAD_PCT'), 133);
  assert.match(text, /reload a third slower/);
  assert.match(text, /after 2 to 3 clear minutes/);
  assert.match(weather, /120 \* SECOND \+ rng\.range\(0, 60\)/);
  assert.match(text, /Cosmetic only: the same skies, but the game plays as under clear skies/);
  // Game speeds as a share of Normal (SPEED_MS: milliseconds per tick).
  for (const speed of GAME_SPEEDS.filter((s) => s !== 'normal')) {
    const share = Math.round((SPEED_MS.normal / SPEED_MS[speed]) * 100);
    const label = speed.charAt(0).toUpperCase() + speed.slice(1);
    assert.match(HELP.gameSpeed, new RegExp(`${label} ${share} %`), speed);
  }
  // AI difficulties (engine/src/ai.rs: think interval in ticks, defences).
  const ai = read('../../../engine/src/ai.rs');
  const rows = Object.fromEntries([...ai.matchAll(/AiDifficulty::(\w+) => \((\d+), (\d+), (\d+), (\d+)\)/g)].map((m) => [m[1], m.slice(2).map(Number)]));
  assert.deepEqual([rows.Easy[0] / 25, rows.Normal[0] / 25, rows.Hard[0] / 25], [2, 1, 0.6]);
  assert.deepEqual([rows.Easy[3], rows.Normal[3], rows.Hard[3]], [0, 2, 4]);
  for (const key of ['player', 'playerOnline']) {
    assert.match(HELP[key], /Easy thinks every 2 s and builds no defences/);
    assert.match(HELP[key], /Normal thinks every second, builds 2 defences/);
    assert.match(HELP[key], /Hard thinks every 0\.6 s, builds 4 defences/);
  }
});

// ---- The tooltip ---------------------------------------------------------------------

function mount() {
  const doc = installDom();
  const root = doc.createElement('div');
  doc.body.append(root);
  const select = doc.createElement('select');
  const tip = infoTip('weather', { label: 'Weather', describes: select });
  root.append(select, tip.root);
  return { doc, root, select, tip };
}

const fire = (target, type, init = {}) => target.dispatchEvent(new FakeEvent(type, init));

test('tooltip: aria wiring', () => {
  const { select, tip } = mount();
  try {
    assert.equal(tip.tip.getAttribute('role'), 'tooltip');
    assert.equal(tip.tip.textContent, HELP.weather);
    assert.ok(tip.tip.id);
    assert.equal(tip.button.getAttribute('aria-describedby'), tip.tip.id);
    assert.equal(tip.button.getAttribute('aria-label'), 'About Weather');
    assert.equal(tip.button.getAttribute('type'), 'button');
    assert.equal(tip.button.getAttribute('aria-expanded'), 'false');
    assert.equal(select.getAttribute('aria-describedby'), tip.tip.id);
    assert.equal(tip.tip.hidden, true);
    // A second tip describing the same control is added, not replacing the first.
    const other = infoTip('biome', { label: 'Biome' });
    describedBy(select, other);
    assert.deepEqual(select.getAttribute('aria-describedby').split(' '), [tip.tip.id, other.tip.id]);
  } finally {
    uninstallDom();
  }
});

test('tooltip: mouse hover shows it, leaving hides it; touch hover does not', () => {
  const { tip } = mount();
  try {
    fire(tip.button, 'pointerenter', { pointerType: 'touch' });
    assert.equal(tip.isOpen, false);
    fire(tip.button, 'pointerenter', { pointerType: 'mouse' });
    assert.equal(tip.isOpen, true);
    assert.equal(tip.button.getAttribute('aria-expanded'), 'true');
    assert.equal(openTip(), tip);
    fire(tip.button, 'pointerleave', { pointerType: 'mouse' });
    assert.equal(tip.isOpen, false);
    assert.equal(openTip(), null);
  } finally {
    uninstallDom();
  }
});

test('tooltip: keyboard focus shows it, blur hides it, Esc closes it', () => {
  const { doc, tip } = mount();
  try {
    fire(tip.button, 'focus');
    assert.equal(tip.isOpen, true);
    fire(tip.button, 'blur');
    assert.equal(tip.isOpen, false);
    fire(tip.button, 'focus');
    const esc = new FakeEvent('keydown', { key: 'Escape' });
    tip.button.dispatchEvent(esc);
    assert.equal(tip.isOpen, false);
    assert.equal(esc.defaultPrevented, true);
    // Esc anywhere closes a hovered tip too.
    fire(tip.button, 'pointerenter', { pointerType: 'mouse' });
    const docEsc = new FakeEvent('keydown', { key: 'Escape' });
    doc.dispatchEvent(docEsc);
    assert.equal(tip.isOpen, false);
    assert.equal(docEsc.defaultPrevented, true);
    // Esc with no tip open is left alone.
    const idle = new FakeEvent('keydown', { key: 'Escape' });
    doc.dispatchEvent(idle);
    assert.equal(idle.defaultPrevented, false);
  } finally {
    uninstallDom();
  }
});

test('tooltip: tap (click) toggles it; a press outside or another tip closes it', () => {
  const { doc, root, tip } = mount();
  try {
    const c1 = new FakeEvent('click');
    tip.button.dispatchEvent(c1);
    assert.equal(tip.isOpen, true, 'the first tap opens');
    assert.equal(c1.defaultPrevented, true, 'a tap inside a label does not reach the control');
    // The focus and pointer events of the same tap do not close it.
    fire(tip.button, 'focus');
    fire(tip.button, 'pointerleave', { pointerType: 'touch' });
    assert.equal(tip.isOpen, true);
    click(tip.button);
    assert.equal(tip.isOpen, false, 'the second tap closes');
    click(tip.button);
    fire(tip.tip, 'pointerdown');
    assert.equal(tip.isOpen, true, 'pressing the tip itself keeps it open');
    fire(doc.body, 'pointerdown');
    assert.equal(tip.isOpen, false, 'a press outside closes it');
    // One tip at a time.
    const other = infoTip('biome', { label: 'Biome' });
    root.append(other.root);
    click(tip.button);
    click(other.button);
    assert.equal(tip.isOpen, false);
    assert.equal(other.isOpen, true);
    assert.equal(closeOpenTip(), true);
    assert.equal(other.isOpen, false);
    assert.equal(closeOpenTip(), false);
  } finally {
    uninstallDom();
  }
});

test('CSP: the help and mode modules never use inline styles or HTML strings', () => {
  for (const file of ['../js/help.js', '../js/infotip.js', '../js/modes.js', '../js/modepicker.js', '../js/lobby.js', '../js/online.js', '../js/gamemenu.js']) {
    const src = read(file);
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, file);
    assert.doesNotMatch(src, /setAttribute\(\s*['"]style['"]/, file);
    assert.doesNotMatch(src, /\.style\.cssText/, file);
  }
  const css = read('../css/help.css');
  assert.doesNotMatch(css, /@import|url\(/, 'help.css loads nothing');
  assert.match(read('../index.html'), /<link rel="stylesheet" href="css\/help\.css" \/>/);
});

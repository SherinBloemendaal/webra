// The in-game HUD uses the game's own tooltip (js/ui/tooltip.js), never the
// browser's native title: the weather badge, the replay bar's play button and
// time, the observer's view buttons and player names, and the chat's mode and
// mute buttons. Each converted element has no title attribute, opens the
// shared tooltip (keyboard focus here; hover and long press are the same
// attachment, tests/tooltip.test.mjs) and keeps its accessible name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { installDom, uninstallDom, FakeEvent, click } from './dom-fixtures.mjs';
import { openTooltip } from '../js/ui/tooltip.js';
import { NO_EFFECT, weatherInfo } from '../js/weather-fx.js';
import { WeatherBadge, weatherTip } from '../js/weatherbadge.js';
import { playTip, replayTimeTip } from '../js/records.js';
import { ObserverPanel, OBSERVER_VIEW, viewTip } from '../js/observer.js';
import { chatModeTip, muteTip } from '../js/chatpanel.js';
import { TextLog } from '../js/chatlog.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const focus = (el) => el.dispatchEvent(new FakeEvent('focus', { bubbles: false }));
const blur = (el) => el.dispatchEvent(new FakeEvent('blur', { bubbles: false }));
const sky = (o = {}) => ({ biome: 'snow', mode: 'full', weather: 'snowfall', since: 0, until: 5000, tick: 100, sightPct: 85, flash: null, ...o });

/** The element shows the shared tooltip with `text` on keyboard focus, described by it, and no native title. */
function assertGameTooltip(doc, target, text) {
  assert.equal(target.getAttribute('title'), null, 'no native title');
  assert.ok(target.classList.contains('has-tooltip'));
  focus(target);
  const open = openTooltip(doc);
  assert.equal(open?.target, target);
  assert.equal(open.text, text);
  assert.equal(target.getAttribute('aria-describedby'), open.panel.id);
  blur(target);
  assert.equal(openTooltip(doc), null);
}

test('the weather badge: its sky in the game\'s tooltip, reachable by keyboard, no native title', () => {
  const doc = installDom();
  try {
    const badge = doc.createElement('div');
    badge.setAttribute('role', 'status');
    badge.setAttribute('title', 'left over from an older page');
    doc.body.append(badge);
    const w = new WeatherBadge(badge);
    assert.equal(badge.getAttribute('tabindex'), '0', 'keyboard focus opens the tooltip');
    w.update(sky());
    const { label, detail } = weatherInfo(sky());
    assert.equal(badge.hidden, false);
    assert.equal(badge.querySelector('.effects').textContent, detail);
    assertGameTooltip(doc, badge, `${label}\n${detail}`);
    assert.match(label, /Snow · Snowfall/);
    assert.match(detail, /Sight -15%/);
    // A new sky while the tooltip shows: it follows.
    focus(badge);
    w.update(sky({ biome: 'temperate', weather: 'rain', sightPct: 90 }));
    assert.match(openTooltip(doc).text, /^Temperate · Rain\nSight -10%/);
    blur(badge);
    // Cosmetic weather: the badge has no effect line, the tooltip says why.
    w.update(sky({ mode: 'cosmetic' }));
    assert.equal(badge.querySelector('.effects'), null);
    assert.match(weatherTip(sky({ mode: 'cosmetic' })).desc, /only for show/);
    assert.equal(weatherTip(sky({ weather: 'clear', biome: 'temperate', sightPct: 100 })).desc, NO_EFFECT);
    assert.equal(weatherTip(sky({ mode: 'off' })), null);
    w.clear();
    assert.equal(badge.hidden, true);
    assert.ok(!badge.classList.contains('has-tooltip'), 'the game is over: the tooltip goes');
  } finally {
    uninstallDom();
  }
});

test('the replay bar: play and the time use the game\'s tooltip', async () => {
  const doc = installDom();
  try {
    const { ReplayBar } = await import('../js/records.js');
    const c = { ticks: 2500, length: 10000, playing: true, speed: 1, ended: false, seeking: false, target: null, diverged: null, setSpeed() {}, togglePlay() {}, seek() {} };
    const field = doc.createElement('div');
    doc.body.append(field);
    const bar = new ReplayBar(field, c);
    assert.equal(bar.play.getAttribute('aria-label'), 'Pause', 'the name stays');
    assertGameTooltip(doc, bar.play, 'Pause\nStop the replay here.');
    focus(bar.play);
    c.playing = false;
    bar.update();
    assert.equal(openTooltip(doc).text, 'Play\nGo on watching the replay.', 'it follows the state while it shows');
    blur(bar.play);
    assertGameTooltip(doc, bar.time, '25% complete\n1:40 of 6:40 watched.');
    assert.deepEqual(playTip('restart'), { title: 'Restart', desc: 'Watch the replay again from the start.' });
    assert.equal(replayTimeTip(0, 0), null);
    bar.dispose();
    assert.ok(!bar.play.classList.contains('has-tooltip'));
  } finally {
    uninstallDom();
  }
});

test('the observer panel: view buttons and player names use the game\'s tooltip', () => {
  const doc = installDom();
  try {
    const field = doc.createElement('main');
    doc.body.append(field);
    const players = [
      { name: 'Ann', color: [1, 0, 0] },
      { name: 'A very long commander name', color: [0, 0, 1] },
    ];
    const panel = new ObserverPanel(field, { players, view: OBSERVER_VIEW, onView() {} });
    const buttons = [...panel.root.querySelector('.observer-views').querySelectorAll('button')];
    assertGameTooltip(doc, buttons[0], 'All players\nWhat all players see together');
    assertGameTooltip(doc, buttons[1], 'No shroud\nThe whole map');
    assertGameTooltip(doc, buttons[3], 'A very long commander name\nWhat A very long commander name sees.');
    assert.equal(buttons[3].textContent, 'A very long commander name', 'the label stays the name');
    assert.deepEqual(viewTip('Ann'), { title: 'Ann', desc: 'What Ann sees.' });
    panel.update([{ player: 0, earned: 0, armyValue: 0, cash: 0 }, { player: 1, earned: 0, armyValue: 0, cash: 0 }], 25);
    const names = [...panel.table.querySelectorAll('.observer-name')].filter((n) => n.querySelector('.observer-player'));
    assert.equal(names.length, 2);
    for (const n of names) assert.equal(n.getAttribute('title'), null);
    assertGameTooltip(doc, names[1], 'A very long commander name');
  } finally {
    uninstallDom();
  }
});

test('the chat: the mode and mute buttons use the game\'s tooltip', async () => {
  const doc = installDom({ windowEvents: true });
  try {
    const { ChatPanel } = await import('../js/chatpanel.js');
    const field = doc.createElement('div');
    doc.body.append(field);
    const log = new TextLog();
    const registered = [];
    const hotkeys = { registerAction: (name, keys, handler) => (registered.push({ name, handler }), () => {}) };
    const people = [{ client: 2, name: 'Bob' }];
    const p = new ChatPanel(field, { log, hotkeys, send: () => {}, teamChat: true, names: ['Bob'], mutable: () => people, autoPrune: false });
    registered.find((r) => r.name === 'openTeamChat').handler();
    assert.equal(p.modeButton.textContent, 'Team');
    assertGameTooltip(doc, p.modeButton, 'Team chat (Shift+Tab)\nClick to talk to everyone in the game.');
    const mute = () => p.muteBar.querySelector('.chat-mute-button');
    assertGameTooltip(doc, mute(), 'Mute Bob\nTheir new chat lines no longer show or sound, for you only.');
    click(mute());
    assertGameTooltip(doc, mute(), 'Unmute Bob\nTheir new chat lines show and sound again.');
    assert.equal(chatModeTip('all', true).desc, 'Click to talk to your fellow spectators only.');
    assert.equal(muteTip('Ann', true).title, 'Unmute Ann');
    p.dispose();
  } finally {
    uninstallDom();
  }
});

test('no native title left on the in-game HUD (the sidebar cameos are another worker\'s)', () => {
  const html = read('../index.html');
  const app = html.slice(html.indexOf('<div id="app"'), html.indexOf('<!-- Defeat, victory and the end of the game'));
  assert.ok(app.includes('id="weather"'));
  assert.ok(!/\stitle="/.test(app), 'no title attribute in the battlefield\'s markup');
  for (const file of ['weatherbadge.js', 'observer.js', 'chatpanel.js', 'commandbar.js', 'hudtips.js', 'minimap.js', 'netwarn.js', 'powers.js', 'powertimers.js']) {
    const src = read(`../js/${file}`);
    assert.ok(!/\.title = |setAttribute\('title'/.test(src), `${file} sets no native title`);
  }
  const records = read('../js/records.js');
  const bar = records.slice(records.indexOf('export class ReplayBar'), records.indexOf('export class ProgressOverlay'));
  assert.ok(!/\.title = |setAttribute\('title'/.test(bar), 'the replay bar sets no native title');
  assert.ok(!/badge\.title|weather'\)\.title/.test(read('../js/main.js')), 'main.js gives the weather badge no title');
});

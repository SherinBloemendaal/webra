// The game menu's Game info (js/gameinfo.js, OpenRA GameInfoLogic and its
// panels) and Surrender (OpenRA IngameMenuLogic): which tabs show, the
// skirmish scores grouped and ordered like GameInfoStatsLogic, what a player
// still in the game may see, mission objectives, the options as played, and
// the menu's Surrender button and dialog. Synthetic data, fake DOM.
// Run with: node --test apps/game/tests/*.test.mjs
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, uninstallDom, click, textOf, memoryStorage } from './dom-fixtures.mjs';
import { createRegistry } from '../js/registry.js';
import { createSettings } from '../js/settings.js';
import { HotkeyRegistry } from '../js/hotkeys.js';
import { GameMenu } from '../js/gamemenu.js';
import { CONQUEST_OBJECTIVE, aiTag, infoTabs, missionObjectives, optionRows, renderGameInfo, skirmishStats, winState } from '../js/gameinfo.js';

let doc;
beforeEach(() => {
  doc = installDom();
});
afterEach(() => uninstallDom());

const row = (player, o = {}) => ({ player, faction: 'england', team: 0, experience: 0, defeated: false, won: false, ...o });
const NAMES = ['Ann', 'Bob', 'Cy', 'Di'];

test('tabs follow GameInfoLogic: objectives, briefing only with a text, options', () => {
  assert.deepEqual(infoTabs({ briefing: null }).map(([id]) => id), ['objectives', 'options']);
  assert.deepEqual(infoTabs({ briefing: { text: 'Go.' } }), [
    ['objectives', 'Objectives'],
    ['briefing', 'Briefing'],
    ['options', 'Options'],
  ]);
  assert.equal(winState(row(0)), 'playing');
  assert.equal(winState(row(0, { defeated: true })), 'lost');
  assert.equal(winState(row(0, { won: true })), 'won');
});

test('skirmish scores: sorted by experience, grouped by team, teams by their sum, headers only with several groups', () => {
  const stats = [
    row(0, { team: 1, experience: 100 }),
    row(1, { team: 2, experience: 300 }),
    row(2, { team: 1, experience: 250 }),
    row(3, { team: 2, experience: 0, defeated: true }),
  ];
  const m = skirmishStats({ stats, names: NAMES, localPlayer: 0, allied: (a, b) => stats[a].team === stats[b].team });
  assert.deepEqual(m.objective, { text: CONQUEST_OBJECTIVE, state: 'playing', status: 'In progress' });
  // Team 1 has 350, team 2 300: team 1 first; inside a team the most experienced first.
  assert.deepEqual(
    m.groups.map((g) => [g.label, g.score, g.players.map((p) => p.name)]),
    [
      ['Team 1', 350, ['Cy', 'Ann']],
      ['Team 2', 300, ['Bob', 'Di']],
    ],
  );
  // The win state is a word of its own (the design's PLAYING and DEFEATED), not a suffix of the name.
  const di = m.groups[1].players.find((p) => p.name === 'Di');
  assert.equal(di.state, 'lost');
  assert.equal(di.stateText, 'Defeated');
  assert.deepEqual(m.groups[0].players.find((p) => p.name === 'Ann').tags, ['You']);
  // AI players: an AI tag, with the difficulty when the lobby's setup is known.
  const ai = skirmishStats({ stats: [row(0), row(1, { isAi: true }), row(2, { isAi: true })], names: NAMES, localPlayer: 0, bots: [null, { bot: 'normal', difficulty: 'hard' }] });
  const tags = (p) => ai.groups[0].players.find((x) => x.player === p).tags;
  assert.deepEqual(tags(1), ['AI · Hard']);
  assert.deepEqual(tags(2), ['AI']);
  assert.equal(aiTag({ difficulty: 'easy' }), 'AI · Easy');
  // Free for all: one group, no header; equal scores keep the player order.
  const ffa = skirmishStats({ stats: [row(0), row(1, { experience: 5 }), row(2)], names: NAMES, localPlayer: 1 });
  assert.equal(ffa.groups.length, 1);
  assert.equal(ffa.groups[0].label, null);
  assert.deepEqual(ffa.groups[0].players.map((p) => p.player), [1, 0, 2]);
  // Players without a team and teams together: "No Team".
  const mixed = skirmishStats({ stats: [row(0, { team: 0, experience: 9 }), row(1, { team: 3 })], names: NAMES, localPlayer: 0 });
  assert.deepEqual(mixed.groups.map((g) => g.label), ['No Team', 'Team 3']);
});

test('a player still in the game sees only its own and its allies countries; spectators and the decided see all', () => {
  const stats = [row(0, { faction: 'england', team: 1 }), row(1, { faction: 'russia', team: 2 }), row(2, { faction: 'france', team: 1 }), row(3, { faction: 'ukraine', team: 2 })];
  const lobbyFactions = ['england', 'random', 'randomallies', 'ukraine'];
  const allied = (a, b) => stats[a].team === stats[b].team;
  const faction = (m, p) => m.groups.flatMap((g) => g.players).find((x) => x.player === p).faction;
  const live = skirmishStats({ stats, names: NAMES, localPlayer: 0, allied, lobbyFactions });
  assert.equal(faction(live, 0), 'England');
  assert.equal(faction(live, 1), 'Random', 'an opponent random pick is not given away');
  assert.equal(faction(live, 2), 'Random Allies (France)', 'an ally: the choice and the country');
  assert.equal(faction(live, 3), 'Ukraine', 'a chosen country was public in the lobby');
  // Once the local player lost, everything shows (OpenRA: player.WinState != Undefined).
  const lost = skirmishStats({ stats: stats.map((r) => (r.player === 0 ? { ...r, defeated: true } : r)), names: NAMES, localPlayer: 0, allied, lobbyFactions });
  assert.equal(faction(lost, 1), 'Random (Russia)');
  assert.deepEqual(lost.objective, { text: CONQUEST_OBJECTIVE, state: 'lost', status: 'Failed' });
  // Spectators and replays: no objective, every country, the spectators listed.
  const watcher = skirmishStats({ stats, names: NAMES, localPlayer: null, allied, lobbyFactions, spectators: ['Eve'] });
  assert.equal(watcher.objective, null);
  assert.equal(faction(watcher, 1), 'Random (Russia)');
  assert.deepEqual(watcher.spectators, ['Eve']);
  // Unknown lobby choices (online.js gameAbout passes null after a rejoin that saw no lobby,
  // main.js gameAbout for loaded saves) never fall back to the drawn country for opponents.
  for (const unknown of [null, undefined, []]) {
    const rejoined = skirmishStats({ stats, names: NAMES, localPlayer: 0, allied, lobbyFactions: unknown });
    assert.equal(faction(rejoined, 1), 'Unknown', `opponent with lobbyFactions ${JSON.stringify(unknown)}`);
    assert.equal(faction(rejoined, 3), 'Unknown');
    assert.equal(faction(rejoined, 0), 'England', 'its own country');
    assert.equal(faction(rejoined, 2), 'France', 'an ally');
  }
  // Decided, or watching: the drawn countries.
  const decided = skirmishStats({ stats: stats.map((r) => (r.player === 0 ? { ...r, defeated: true } : r)), names: NAMES, localPlayer: 0, allied, lobbyFactions: null });
  assert.equal(faction(decided, 1), 'Russia');
  assert.equal(faction(skirmishStats({ stats, names: NAMES, localPlayer: null, lobbyFactions: null }), 1), 'Russia');
  // Only score, country, team and win state: no economy or army figures leave the engine's row.
  const keys = new Set(live.groups.flatMap((g) => g.players.flatMap((p) => Object.keys(p))));
  assert.deepEqual([...keys].sort(), ['faction', 'name', 'player', 'score', 'state', 'stateText', 'tags', 'team']);
  const won = skirmishStats({ stats: stats.map((r) => ({ ...r, won: r.team === 1, defeated: r.team === 2 })), names: NAMES, localPlayer: 2, allied });
  assert.equal(won.objective.status, 'Accomplished');
  assert.ok(won.groups[0].players.every((p) => p.stateText === 'Won'));
});

test('mission objectives: primary first, the status, the script error', () => {
  const state = {
    result: 'playing',
    error: null,
    objectives: [
      { description: 'Keep the hospital', required: false, state: 'incomplete' },
      { description: 'Rescue Einstein', required: true, state: 'completed' },
      { description: 'Destroy the base', required: true, state: 'failed' },
    ],
  };
  const m = missionObjectives(state);
  assert.equal(m.status, 'In progress');
  assert.deepEqual(m.objectives.map((o) => [o.type, o.description, o.state]), [
    ['Primary', 'Rescue Einstein', 'completed'],
    ['Primary', 'Destroy the base', 'failed'],
    ['Secondary', 'Keep the hospital', 'incomplete'],
  ]);
  assert.equal(missionObjectives({ ...state, result: 'won' }).status, 'Accomplished');
  assert.equal(missionObjectives(state, { defeated: true }).status, 'Failed', 'a co-op player that lost');
  assert.equal(missionObjectives({ ...state, error: 'x.lua:1: boom' }).error, 'x.lua:1: boom');
  assert.deepEqual(missionObjectives(null).objectives, []);
});

test('options as played: generated map settings, selects and switches, mission options', () => {
  const options = { mapSize: 128, mapStyle: 'islands', biome: 'snow', techBuildings: 'extra', weather: 'cosmetic', startingCash: 10000, startingUnits: 'light', techLevel: 'high', gameSpeed: 'faster', timeLimit: 20, movement: 'openra', crates: false, shortGame: true, fog: true, cheats: false };
  const gen = optionRows({ options, generated: true });
  const sel = Object.fromEntries(gen.selects.map((s) => [s.label, s.value]));
  assert.equal(sel['Map size'], 'Large');
  assert.equal(sel['Map style'], 'Islands');
  assert.equal(sel.Biome, 'Snow');
  assert.equal(sel['Tech buildings'], 'Extra');
  assert.equal(sel.Weather, 'Cosmetic only');
  assert.equal(sel['Starting cash'], '$10,000');
  assert.equal(sel['Starting units'], 'Light support');
  assert.equal(sel['Tech level'], 'No superweapons');
  assert.equal(sel['Game speed'], 'Faster');
  assert.equal(sel['Time limit'], '20 minutes');
  assert.equal(sel.Movement, 'OpenRA');
  const tog = Object.fromEntries(gen.toggles.map((t) => [t.label, t.on]));
  assert.deepEqual(tog, { Crates: false, 'Short game': true, 'Fog of war': true, 'Debug menu': false });
  // A map file brings its own layout: no generator rows.
  assert.ok(!optionRows({ options, generated: false }).selects.some((s) => s.label === 'Map size'));
  const mission = optionRows({
    missionOptions: { difficulty: { label: 'Difficulty', values: [['easy', 'Easy'], ['hard', 'Hard']], default: 'easy' } },
    missionValues: { difficulty: 'hard' },
    gameSpeed: 'slower',
  });
  assert.deepEqual(mission, { selects: [{ label: 'Difficulty', value: 'Hard' }, { label: 'Game speed', value: 'Slower' }], toggles: [] });
});

test('the panel draws its tabs and switches between them', () => {
  const root = doc.createElement('div');
  doc.body.append(root);
  const view = {
    title: 'Coastal Clash',
    briefing: { title: 'Coastal Clash', author: 'Tester', text: 'Hold the shore.\n\nThen push.', preview: null },
    options: { selects: [{ label: 'Game speed', value: 'Normal' }], toggles: [{ label: 'Crates', on: true }] },
    objectives: skirmishStats({ stats: [row(0, { experience: 40 }), row(1, { faction: 'russia' })], names: NAMES, localPlayer: 0, lobbyFactions: ['england', 'random'] }),
  };
  let tab = 'objectives';
  const draw = () => {
    root.replaceChildren();
    tab = renderGameInfo(root, view, tab, (id) => {
      tab = id;
      draw();
    });
  };
  draw();
  assert.equal(root.querySelector('h2').textContent, 'Coastal Clash');
  assert.deepEqual([...root.querySelectorAll('[role="tab"]')].map((b) => b.textContent), ['Objectives', 'Briefing', 'Options']);
  const text = textOf(root);
  assert.match(text, /Mission: In progress/);
  assert.match(text, /Destroy all opposition!/);
  assert.match(text, /Ann/);
  assert.match(text, /Random/);
  assert.doesNotMatch(text, /Russia/);
  click(root.querySelector('#game-info-tab-briefing'));
  assert.equal(tab, 'briefing');
  assert.match(textOf(root), /By Tester/);
  assert.match(textOf(root), /Hold the shore/);
  click(root.querySelector('#game-info-tab-options'));
  assert.match(textOf(root), /Game speed/);
  assert.match(textOf(root), /Crates/);
  // A tab that is not there (no briefing) falls back to the first.
  root.replaceChildren();
  assert.equal(renderGameInfo(root, { ...view, briefing: null }, 'briefing', () => {}), 'objectives');
});

function menuWith(opts = {}) {
  const registry = createRegistry({ storage: memoryStorage() });
  const settings = createSettings(registry);
  const hotkeys = new HotkeyRegistry(settings);
  const root = doc.createElement('section');
  doc.body.append(root);
  const menu = new GameMenu(root, {
    online: true,
    hotkeys,
    settings,
    fullscreen: { available: () => false, active: () => false, toggle: async () => ({ ok: true }) },
    onChange() {},
    onLeave() {},
    onExit() {},
    ...opts,
  });
  return { menu, root };
}

const buttons = (root) => [...root.querySelectorAll('button')].map((b) => b.textContent);
const byText = (root, text) => [...root.querySelectorAll('button')].find((b) => b.textContent === text);

test('Surrender: shown for a player of a game with more people, asks first, then gives the order once', () => {
  let people = 2;
  let decided = false;
  let orders = 0;
  const { menu, root } = menuWith({ surrender: { shown: () => people > 1, enabled: () => !decided, run: () => orders++ } });
  menu.open();
  const b = byText(root, 'Surrender');
  assert.ok(b && !b.disabled);
  click(b);
  assert.equal(root.querySelector('h1').textContent.startsWith('Surrender'), true);
  assert.match(textOf(root), /Are you sure you want to surrender\?/);
  // Stay goes back without an order (OpenRA dialog-surrender.cancel).
  click(byText(root, 'Stay'));
  assert.equal(orders, 0);
  assert.ok(byText(root, 'Resume'));
  click(byText(root, 'Surrender'));
  click([...root.querySelectorAll('button.ui-btn-primary')].find((x) => x.textContent === 'Surrender'));
  assert.equal(orders, 1);
  assert.equal(menu.isOpen, false, 'the menu closes like OpenRA CloseMenu');
  // Decided: disabled (OpenRA IsDisabled while WinState is not Undefined).
  decided = true;
  menu.open();
  assert.equal(byText(root, 'Surrender').disabled, true);
  menu.close();
  // One person (single player): no Surrender at all.
  people = 1;
  menu.open();
  assert.ok(!buttons(root).includes('Surrender'));
  menu.close();
  const none = menuWith({});
  none.menu.open();
  assert.ok(!buttons(none.root).includes('Surrender'), 'spectators and replays get no handle');
  none.menu.close();
});

test('Game info: beside the actions on the main page, drawn again with the newest scores', () => {
  let score = 10;
  const { menu, root } = menuWith({
    weather: () => 'Temperate · Thunderstorm',
    gameInfo: () => ({
      title: 'Generated map',
      briefing: null,
      options: { selects: [], toggles: [] },
      objectives: skirmishStats({ stats: [row(0, { experience: score })], names: NAMES, localPlayer: 0 }),
      weather: 'Temperate · Thunderstorm',
    }),
  });
  menu.open();
  assert.equal(buttons(root)[0], 'Resume');
  const info = root.querySelector('.gm-info');
  assert.ok(info, 'the game info section');
  assert.match(info.querySelector('h2').textContent, /Generated map/);
  assert.match(textOf(info), /10/);
  assert.match(textOf(info), /Playing/);
  assert.match(textOf(info), /Weather: Temperate · Thunderstorm/);
  // Drawn again with the newest scores (the section's refresh).
  score = 25;
  menu.renderInfo(info);
  assert.match(textOf(info), /25/);
  click(root.querySelector('#game-info-tab-options'));
  assert.match(textOf(root.querySelector('.gm-info')), /no lobby options/);
  assert.ok(byText(root, 'Resume'), 'still the main page');
  menu.close();
});

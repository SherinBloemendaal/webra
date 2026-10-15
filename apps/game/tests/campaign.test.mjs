// The campaign in the game (js/campaign, the mission parts of js/sim, js/replay.js,
// js/restart.js and js/endgame.js): progress and chapters, every mission file
// loads in the engine and draws with WebRA's art, a mission through the
// simulation boundary with its panel state and script events, mission saves
// and replays, and the in-game mission view. Run after `npm run build:wasm`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initSync, Game, version } from '../pkg/webra_sim.js';
import { WASM_PATH } from './sim-fixtures.mjs';
import { SimCore } from '../js/sim/core.js';
import { MissionFeed } from '../js/sim/proxy.js';
import { newGame, ReplayController } from '../js/replay.js';
import { parseReplay } from '../js/protocol.js';
import { campaignRecord, missionRecord, saveRestart, takeRestart } from '../js/restart.js';
import { campaignNext, campaignStates, chapterOf, CampaignProgress, findMission, missionStatus, nextMission } from '../js/campaign/progress.js';
import { MissionView, movieTitle, objectiveLabel } from '../js/campaign/view.js';
import { CampaignMenu, campaignCount, missionKicker, missionLabel, optionLabel, SEGMENTED_MAX, stateText } from '../js/campaign/menu.js';
import { dialogContent, DIALOGS, EndGameFlow } from '../js/endgame.js';
import { spriteList } from '../js/sprites.js';
import { createRegistry } from '../js/registry.js';
import { click, FakeEvent, installDom, memoryStorage, uninstallDom } from './dom-fixtures.mjs';
import { GAME_SPEEDS } from '../protocol/constants.js';

const GAME_SPEED_COUNT = GAME_SPEEDS.length;

const wasm = initSync({ module: readFileSync(WASM_PATH) });
const MISSIONS = new URL('../missions/', import.meta.url);
const INDEX = JSON.parse(readFileSync(new URL('index.json', MISSIONS), 'utf8'));
const missionText = (id) => readFileSync(new URL(`${id}.json`, MISSIONS), 'utf8');
const allMissions = () => INDEX.campaigns.flatMap((c) => c.missions);

// ---- Progress --------------------------------------------------------------------------

test('chapters open one after the other; expansion missions are open from the start', () => {
  assert.equal(chapterOf('03a: Dead End'), 3);
  assert.equal(chapterOf('Sarin Gas 1: Crackdown'), null);
  const allies = INDEX.campaigns.find((c) => c.name === 'Allied Campaign');
  const fresh = campaignStates(allies, {});
  assert.deepEqual(
    fresh.filter((s) => s.open).map((s) => s.mission.id),
    ['allies-01'],
  );
  // Winning one variant of chapter 3 opens chapter 4.
  const later = campaignStates(allies, { 'allies-01': '', 'allies-02': 'hard', 'allies-03b': 'easy' });
  const open = later.filter((s) => s.open).map((s) => s.mission.id);
  assert.ok(open.includes('allies-03a') && open.includes('allies-04'));
  assert.ok(!open.includes('allies-05a'));
  assert.equal(later.find((s) => s.mission.id === 'allies-02').won, 'hard');
  const cs = INDEX.campaigns.find((c) => c.name === 'Counterstrike Allied Missions');
  assert.ok(campaignStates(cs, {}).every((s) => s.open));
});

test('the next mission is the first open one of a later chapter', () => {
  assert.equal(nextMission(INDEX, 'allies-01', { 'allies-01': '' }).id, 'allies-02');
  assert.equal(nextMission(INDEX, 'allies-02', { 'allies-01': '', 'allies-02': 'normal' }).id, 'allies-03a');
  assert.equal(nextMission(INDEX, 'allies-13', { 'allies-13': 'normal' }), null, 'the last mission');
  assert.equal(findMission(INDEX, 'soviet-01').campaign.name, 'Soviet Campaign');
  assert.equal(findMission(INDEX, 'nope'), null);
});

test('the campaign screen marks the mission after the furthest won one as NEXT', () => {
  const allies = INDEX.campaigns.find((c) => c.name === 'Allied Campaign');
  assert.equal(campaignNext(allies, {}).id, 'allies-01', 'nothing won: the first open mission');
  assert.equal(campaignNext(allies, { 'allies-01': '' }).id, 'allies-02');
  // Both variants of chapter 3 are open; NEXT is the first of them.
  assert.equal(campaignNext(allies, { 'allies-01': '', 'allies-02': 'easy' }).id, 'allies-03a');
  // A variant won: the next chapter, not the other variant.
  assert.equal(campaignNext(allies, { 'allies-01': '', 'allies-02': 'easy', 'allies-03b': 'easy' }).id, 'allies-04');
  // The operations are open from the start: after the furthest won one, even with earlier ones left.
  const cs = INDEX.campaigns.find((c) => c.name === 'Counterstrike Allied Missions');
  const [first, second, third] = cs.missions;
  assert.equal(campaignNext(cs, { [second.id]: '' }).id, third.id);
  assert.equal(campaignNext(cs, Object.fromEntries(cs.missions.slice(1).map((m) => [m.id, '']))).id, first.id, 'the last one won: the first left');
  assert.equal(campaignNext(cs, Object.fromEntries(cs.missions.map((m) => [m.id, '']))), null, 'all won');
  const states = campaignStates(allies, { 'allies-01': '' });
  const next = campaignNext(allies, { 'allies-01': '' });
  assert.deepEqual(
    states.slice(0, 4).map((s) => missionStatus(s, next)),
    ['won', 'next', 'locked', 'locked'],
  );
  assert.equal(missionStatus(campaignStates(cs, {})[1], campaignNext(cs, {})), 'open');
  assert.deepEqual(campaignCount(allies, { 'allies-01': '', 'allies-02': 'hard' }), { won: 2, total: allies.missions.length, text: `2 / ${allies.missions.length} won`, share: 2 / allies.missions.length });
});

test('mission labels: the number and name of numbered titles, the place in the list for others', () => {
  assert.deepEqual(missionLabel('03a: Dead End', 2), { number: '03a', name: 'Dead End' });
  assert.deepEqual(missionLabel('Sarin Gas 1: Crackdown', 0), { number: '01', name: 'Sarin Gas 1: Crackdown' });
  assert.deepEqual(missionLabel('Fall of Greece 2', 11), { number: '12', name: 'Fall of Greece 2' });
  assert.equal(missionKicker({ title: '05a: Tanya\'s Tale', faction: 'allies' }), 'Allied mission, chapter 5');
  assert.equal(missionKicker({ title: 'Crackdown', faction: 'soviet' }), 'Soviet mission');
});

test('progress lives in the settings registry', () => {
  const registry = createRegistry({ storage: memoryStorage() });
  const p = new CampaignProgress(registry);
  assert.deepEqual(p.get(), {});
  let seen = null;
  p.subscribe((v) => {
    seen = v;
  });
  p.won('allies-01', null);
  p.won('allies-02', 'hard');
  assert.deepEqual(p.get(), { 'allies-01': '', 'allies-02': 'hard' });
  assert.deepEqual(seen, p.get());
  assert.equal(stateText({ mission: allMissions()[1], won: 'hard', open: true }), 'Won on Hard');
  assert.equal(stateText({ mission: allMissions()[0], won: '', open: true }), 'Won');
  assert.equal(stateText({ mission: allMissions()[2], won: null, open: false }), 'Locked');
  assert.equal(stateText({ mission: allMissions()[2], won: null, open: true }, allMissions()[2]), 'Next');
  assert.equal(stateText({ mission: allMissions()[2], won: null, open: true }, null), '');
  assert.equal(optionLabel(allMissions()[1], 'difficulty', 'tough'), 'Real tough guy');
});

test('restart records start a mission again or bring back the campaign screen', () => {
  const storage = memoryStorage();
  assert.ok(saveRestart(missionRecord('allies-02', { difficulty: 'hard' }, 'fast'), storage));
  assert.deepEqual(takeRestart(storage), { v: 1, kind: 'mission', id: 'allies-02', options: { difficulty: 'hard' }, gameSpeed: 'fast' });
  saveRestart(campaignRecord('soviet-01'), storage);
  assert.deepEqual(takeRestart(storage), { v: 1, kind: 'campaign', id: 'soviet-01' });
  assert.throws(() => missionRecord('../x', {}));
  assert.throws(() => missionRecord('allies-02', { difficulty: 'very hard' }));
  assert.throws(() => missionRecord('allies-02', {}, 'warp'));
});

test('mission end of game dialogs offer the next mission, another try and the campaign', () => {
  const flow = new EndGameFlow();
  flow.update({ won: true, defeated: false, winner: 0 });
  assert.equal(flow.dialog, DIALOGS.VICTORY);
  const won = dialogContent(flow, { canRestart: true, mission: { next: '02: Five to One' } });
  assert.equal(won.title, 'Mission accomplished');
  assert.match(won.text, /Next: 02: Five to One/);
  assert.deepEqual(
    won.buttons.map((b) => b.id),
    ['next', 'restart', 'stats', 'leave', 'exit'],
    'a won mission is over: no playing on',
  );
  flow.close();
  assert.equal(flow.dialog, DIALOGS.VICTORY, 'the victory dialog cannot be closed');
  assert.equal(won.buttons.find((b) => b.id === 'leave').label, 'Back to the campaign');
  const lost = new EndGameFlow();
  lost.update({ won: false, defeated: true, winner: null });
  const c = dialogContent(lost, { canRestart: true, mission: { next: null } });
  assert.equal(c.title, 'Mission failed');
  assert.equal(c.buttons[0].id, 'restart');
  assert.ok(c.buttons[0].primary);
});

// ---- Mission files in the engine ------------------------------------------------------------

test('the index lists every mission file with its hash', () => {
  for (const m of allMissions()) {
    const text = missionText(m.id);
    assert.equal(Game.mission_hash(text), m.sha256, m.id);
    assert.equal(m.file, `${m.id}.json`);
  }
});

test('every mission starts and every actor it has draws with WebRA art', () => {
  for (const m of allMissions()) {
    const options = { seed: 1, gameSpeed: 'normal', options: Object.fromEntries(Object.entries(m.options).map(([k, o]) => [k, o.default])) };
    const game = Game.from_mission(missionText(m.id), JSON.stringify(options));
    assert.ok(game.is_mission(), m.id);
    const rules = JSON.parse(game.rules_json());
    const actors = rules.actors.map((a) => (a.art ? { ...a, id: a.art } : a));
    assert.doesNotThrow(() => spriteList(actors), m.id);
    const state = JSON.parse(game.mission_state());
    assert.equal(state.id, m.id);
    assert.equal(state.result, 'playing', m.id);
    assert.equal(state.error, null, `${m.id}: ${state.error}`);
    const camera = game.mission_camera();
    assert.equal(camera.length, 2);
    const preview = Game.mission_preview(missionText(m.id));
    const map = JSON.parse(missionText(m.id)).map;
    assert.equal(preview.length, map.width * map.height * 4, m.id);
    game.free();
  }
});

// ---- Through the simulation boundary ------------------------------------------------------

const ALLIES_01 = allMissions().find((m) => m.id === 'allies-01');
const START = { seed: 5, gameSpeed: 'normal', options: {} };

function startCore(spec) {
  const core = new SimCore({ Game, memory: () => wasm.memory });
  const info = core.start({ tickMs: 40, ...spec });
  return { core, info };
}

test('a mission runs through SimCore: panel state, script events, saves and replays', async () => {
  const recorder = { mode: 'mission', options: START, map: null, mapHash: null, player: 0, engine: version(), title: ALLIES_01.title, mission: { id: ALLIES_01.id, hash: ALLIES_01.sha256 } };
  const { core, info } = startCore({ kind: 'mission', mission: missionText('allies-01'), options: START, recorder });
  assert.ok(info.mission);
  assert.ok(info.mission.players.length >= 2);
  assert.equal(info.mission.camera.length, 2);
  const feed = new MissionFeed();
  for (let i = 0; i < 60; i++) feed.onFrame(core.step({ dt: 40 * 4, view: 0, rect: [0, 0, 100, 100] }).mission);
  assert.equal(feed.state.id, 'allies-01');
  assert.ok(feed.state.objectives.length >= 1, 'WorldLoaded added the objectives');
  assert.ok(feed.state.objectives.every((o) => ['incomplete', 'completed', 'failed'].includes(o.state)));
  const events = feed.take();
  assert.ok(events.some((e) => e.kind === 'objectives'), JSON.stringify(events.slice(0, 5)));
  assert.deepEqual(feed.take(), []);

  // A save of the mission names its file and loads to the same state.
  const ticks = core.game.tick_count();
  const { text } = core.command('encode', ['save']);
  const parsed = await parseReplay(text);
  assert.ok(parsed.ok, parsed.error);
  assert.equal(parsed.replay.mode, 'mission');
  assert.deepEqual(parsed.replay.mission, { id: 'allies-01', hash: ALLIES_01.sha256 });
  const hash = core.game.state_hash();
  const load = startCore({ kind: 'save', replay: parsed.replay, mission: missionText('allies-01') });
  while (load.core.local.loading) load.core.step({ dt: 40, view: 0, rect: [0, 0, 100, 100] });
  assert.equal(load.core.local.error, null);
  assert.equal(load.core.game.tick_count(), ticks);
  assert.equal(load.core.game.state_hash(), hash);

  // The replay plays back without diverging.
  const replay = (await parseReplay(core.command('encode', ['replay']).text)).replay;
  const rc = new ReplayController(Game, replay, { missionText: missionText('allies-01') });
  rc.player.runTo(ticks, 1e9);
  assert.equal(rc.player.diverged, null);
  assert.equal(rc.game.state_hash(), hash);
  assert.throws(() => newGame(Game, replay), /needs its mission file/);
});

// ---- The mission view ---------------------------------------------------------------------

test('the mission view shows objectives, messages, the mission text, movie cards and script errors', () => {
  const doc = installDom({ windowEvents: true });
  try {
    const field = doc.createElement('main');
    const hud = doc.createElement('div');
    field.append(hud);
    doc.body.append(field);
    const feed = new MissionFeed();
    const heard = [];
    const centered = [];
    let t = 0;
    const view = new MissionView({
      field,
      hudButtons: hud,
      feed,
      audio: { announce: (k) => heard.push(['speech', k]), notify: (n) => heard.push(['sound', n]), effect: () => heard.push(['file']), lowPowerQuiet: (q) => heard.push(['quiet', q]) },
      centerOn: (x, y) => centered.push([x, y]),
      ping: () => heard.push(['ping']),
      toScreen: (x, y) => [x, y],
      pxPerCell: 24,
      tickMs: 40,
      onRestart: () => heard.push(['restart']),
      onLeave: () => {},
      now: () => t,
    });
    const state = (objectives, extra = {}) => JSON.stringify({ id: 'x', title: 'Test', result: 'playing', error: null, objectives, missionText: null, players: [], lowPowerQuiet: false, ...extra });
    feed.onFrame({ state: state([{ description: 'Rescue Einstein', type: 'Primary', required: true, state: 'incomplete' }]), events: null });
    view.frame();
    assert.equal(view.panel.hidden, true, 'the first objectives do not pop the panel open');
    assert.deepEqual(heard.splice(0), [['quiet', false]], 'the low power line follows the script');
    feed.onFrame({ state: state([{ description: 'Rescue Einstein', type: 'Primary', required: true, state: 'incomplete' }], { lowPowerQuiet: true }), events: null });
    view.frame();
    assert.deepEqual(heard.splice(0), [['quiet', true]], 'PlayLowPowerNotification = false silences it');
    view.toggle(true);
    assert.match(view.panel.textContent, /Rescue Einstein/);
    assert.equal(objectiveLabel({ required: false }), 'Secondary');
    view.toggle(false);
    feed.onFrame({
      state: state([{ description: 'Rescue Einstein', type: 'Primary', required: true, state: 'completed' }], { missionText: { text: 'Reinforcements in 0:30', color: 'FFFFFF' } }),
      events: JSON.stringify([
        { kind: 'message', prefix: 'Tanya', text: 'Shake it baby!', color: 'FF0000' },
        { kind: 'speech', player: 0, name: 'MissionAccomplished' },
        { kind: 'speech', player: 3, name: 'MissionAccomplished' },
        { kind: 'camera', x: 10, y: 5 },
        { kind: 'movie', file: 'landing.vqa' },
      ]),
    });
    view.frame();
    assert.equal(view.panel.hidden, false, 'a decided objective opens the panel');
    assert.match(view.messages.textContent, /Tanya: Shake it baby!/);
    assert.equal(view.text.hidden, false);
    assert.equal(view.text.textContent, 'Reinforcements in 0:30');
    assert.deepEqual(centered, [[240, 120]]);
    assert.equal(heard.filter(([k]) => k === 'speech').length, 1, 'speech for another player is not heard');
    assert.ok(view.card, 'a movie card');
    assert.match(field.textContent, /Movie: landing/);
    view.card.close();
    assert.equal(view.card, null);
    assert.equal(movieTitle('ALLY1.VQA'), 'Movie: ally1');
    // Messages fade after a while.
    t = 10_300;
    view.frame();
    assert.ok(view.messages.firstChild.classList.contains('fading'));
    t = 12_000;
    view.frame();
    assert.equal(view.messages.childElementCount ?? view.messages.children.length, 0);
    // A script error: the banner with Restart.
    feed.onFrame({ state: null, events: JSON.stringify([{ kind: 'error', text: 'attempt to call a nil value' }]) });
    view.frame();
    assert.match(view.error.textContent, /nil value/);
    view.error.querySelector('button').click();
    assert.deepEqual(heard.at(-1), ['restart']);
  } finally {
    uninstallDom();
  }
});

test('the campaign screen lists campaigns and missions, keeps chapters locked and plays the chosen mission', async () => {
  const doc = installDom();
  try {
    const root = doc.createElement('section');
    doc.body.append(root);
    const registry = createRegistry({ storage: memoryStorage() });
    const progress = new CampaignProgress(registry);
    const played = [];
    let closed = 0;
    const menu = new CampaignMenu(root, {
      index: async () => INDEX,
      missionText: async (entry) => missionText(entry.id),
      preview: () => null,
      progress,
      onPlay: (entry, options, speed) => played.push([entry.id, options, speed]),
      onClose: () => closed++,
    });
    await menu.open();
    assert.equal(menu.isOpen, true);
    const tabs = [...root.querySelectorAll('.campaign-tab')];
    assert.equal(tabs.length, INDEX.campaigns.length);
    assert.equal(tabs[0].getAttribute('role'), 'tab');
    assert.equal(tabs[0].getAttribute('title'), `0 of ${INDEX.campaigns[0].missions.length} missions won`);
    assert.equal(root.querySelector('.campaign-panel').getAttribute('role'), 'tabpanel', 'the missions are the open tab\'s panel');
    const total = INDEX.campaigns[0].missions.length;
    assert.equal(root.querySelector('.campaign-count').textContent, `Allied Campaign0 / ${total} won`);
    assert.equal(root.querySelector('.campaign-progress').getAttribute('aria-valuetext'), `0 of ${total} won`);
    const missions = () => root.querySelectorAll('.campaign-mission');
    assert.equal(missions()[0].getAttribute('aria-current'), 'true', 'the next mission is chosen');
    assert.equal(missions()[0].dataset.state, 'next');
    assert.match(missions()[0].textContent, /^01In the Thick of ItNext$/);
    assert.equal(missions()[1].dataset.state, 'locked');
    assert.match(missions()[1].textContent, /Locked$/);
    // A locked mission shows its briefing but cannot be played, and says why.
    missions()[1].click();
    const play = () => root.querySelector('.campaign-play');
    assert.equal(play().disabled, true);
    assert.equal(play().getAttribute('aria-describedby'), 'campaign-locked-note');
    assert.match(root.querySelector('.campaign-kicker').textContent, /Allied mission, chapter 2/);
    assert.equal(root.querySelector('.campaign-objectives'), null, 'no objectives in the menu');
    // Winning allies-01 opens chapter 2: progress changes redraw the screen.
    progress.won('allies-01', null);
    assert.equal(missions()[0].dataset.state, 'won');
    assert.equal(missions()[1].dataset.state, 'next');
    assert.equal(root.querySelector('.campaign-progress').getAttribute('aria-valuenow'), '1');
    missions()[1].click();
    // Difficulty (three values): a row of buttons; game speed (six): a select.
    const difficulty = root.querySelector('.campaign-segmented');
    assert.equal(difficulty.getAttribute('role'), 'radiogroup');
    assert.equal(root.querySelectorAll('select').length, 0, 'no native selects');
    const hard = [...difficulty.querySelectorAll('input')].find((i) => i.getAttribute('value') === 'hard');
    hard.checked = true;
    hard.dispatchEvent(new FakeEvent('change'));
    const speed = root.querySelector('.campaign-plate');
    assert.ok(GAME_SPEED_COUNT > SEGMENTED_MAX);
    click(speed.querySelector('.ui-sp-button'));
    click([...speed.querySelectorAll('[role="option"]')].find((o) => o.textContent.includes('Fast') && !o.textContent.includes('Faster')));
    play().click();
    assert.deepEqual(played, [['allies-02', { difficulty: 'hard' }, 'fast']]);
    // The choices stay for the page: a redraw keeps them.
    progress.won('allies-02', 'hard');
    missions()[1].click();
    assert.equal([...root.querySelector('.campaign-segmented').querySelectorAll('input')].find((i) => i.checked).getAttribute('value'), 'hard');
    assert.match(root.querySelector('.campaign-plate .ui-sp-value').textContent, /^Fast$/);
    assert.ok(root.querySelector('.info-btn'), 'help buttons');
    menu.close();
    assert.equal(menu.isOpen, false);
    assert.equal(closed, 1);
    // Opening at a mission picks its campaign.
    await menu.open('soviet-01');
    assert.match(root.querySelector('.campaign-tab[aria-selected="true"]').textContent, /Soviet/);
    // The tabs switch campaigns and pick that campaign's next mission.
    root.querySelectorAll('.campaign-tab')[0].click();
    assert.equal(root.querySelector('.campaign-mission[aria-current="true"]').textContent.includes('Tanya'), false);
    assert.equal(root.querySelector('.campaign-mission[aria-current="true"]').dataset.state, 'next');
  } finally {
    uninstallDom();
  }
});

test('the campaign screen: the briefing movie plays when installed, else it says how to install it', async () => {
  const doc = installDom();
  try {
    const root = doc.createElement('section');
    doc.body.append(root);
    const progress = new CampaignProgress(createRegistry({ storage: memoryStorage() }));
    const installed = new Set();
    const played = [];
    let installs = 0;
    let changed = null;
    const menu = new CampaignMenu(root, {
      index: async () => INDEX,
      missionText: async (entry) => missionText(entry.id),
      preview: () => null,
      progress,
      onPlay() {},
      movies: {
        has: (file) => installed.has(file),
        play: async (file) => {
          played.push(file);
          return 'ended';
        },
        subscribe: (fn) => (changed = fn),
      },
      onInstallContent: () => installs++,
    });
    await menu.open('allies-01');
    const note = () => root.querySelector('.campaign-movie');
    assert.equal(note().dataset.state, 'missing');
    assert.match(note().textContent, /Original movie not installed/);
    click(note().querySelector('.campaign-install'));
    assert.equal(installs, 1);
    // Installed from the content dialog: the screen follows.
    installed.add('ally1.vqa');
    changed();
    assert.equal(note().dataset.state, 'installed');
    click(note().querySelector('.campaign-watch'));
    assert.deepEqual(played, ['ally1.vqa']);
    // Without a content system the screen says nothing about movies.
    const plain = doc.createElement('section');
    doc.body.append(plain);
    await new CampaignMenu(plain, { index: async () => INDEX, missionText: async (e) => missionText(e.id), preview: () => null, progress, onPlay() {} }).open('allies-01');
    assert.equal(plain.querySelector('.campaign-movie'), null);
  } finally {
    uninstallDom();
  }
});

// ---- Co-op missions online ---------------------------------------------------------------

test('co-op missions: the catalog matches the mission files, and both players compute the same game', async () => {
  const { COOP_MISSIONS } = await import('../js/protocol.js');
  const { coopStart } = await import('../js/replay.js');
  assert.deepEqual(
    COOP_MISSIONS.map((m) => m.id),
    ['evacuation', 'exodus', 'infiltration'],
  );
  for (const m of COOP_MISSIONS) {
    const entry = allMissions().find((x) => x.id === m.id);
    assert.equal(m.hash, entry.sha256, m.id);
    assert.deepEqual(m.players, entry.coop);
    const text = missionText(m.id);
    const mission = { id: m.id, hash: m.hash, options: { difficulty: m.options.difficulty.default } };
    const a = Game.from_mission(text, coopStart(mission, 9, 0));
    const b = Game.from_mission(text, coopStart(mission, 9, 1));
    assert.equal(JSON.parse(a.rules_json()).actors.length, m.actors, `${m.id}: the server checks orders against this`);
    assert.equal(JSON.parse(a.mission_state()).localPlayer, 0);
    assert.equal(JSON.parse(b.mission_state()).localPlayer, 1);
    a.set_lockstep(true);
    b.set_lockstep(true);
    for (let t = 0; t < 300; t++) {
      a.tick();
      b.tick();
    }
    assert.equal(a.state_hash(), b.state_hash(), m.id);
    a.free();
    b.free();
  }
  // The lobby's movement model reaches the engine (left out: `webra`, as games before it).
  const m = COOP_MISSIONS[0];
  const mission = { id: m.id, hash: m.hash, options: { difficulty: m.options.difficulty.default } };
  assert.equal(JSON.parse(coopStart(mission, 9, 0, 'openra')).movement, 'openra');
  assert.equal('movement' in JSON.parse(coopStart(mission, 9, 0)), false);
  const run = (movement) => {
    const g = Game.from_mission(missionText(m.id), coopStart(mission, 9, 0, movement));
    g.set_lockstep(true);
    for (let t = 0; t < 100; t++) g.tick();
    const h = g.state_hash();
    g.free();
    return h;
  };
  assert.equal(run(undefined), run('webra'));
  assert.notEqual(run('openra'), run('webra'));
  // Likewise the factory loss rule.
  assert.equal(JSON.parse(coopStart(mission, 9, 0, 'openra', 'webra')).factoryLoss, 'webra');
  assert.equal('factoryLoss' in JSON.parse(coopStart(mission, 9, 0, 'openra')), false);
  const rule = (factoryLoss) => {
    const g = Game.from_mission(missionText(m.id), coopStart(mission, 9, 0, 'openra', factoryLoss));
    g.set_lockstep(true);
    for (let t = 0; t < 100; t++) g.tick();
    const h = g.state_hash();
    g.free();
    return h;
  };
  assert.equal(rule(undefined), rule('webra'));
  assert.notEqual(rule('openra'), rule('webra'));
  assert.throws(() => Game.from_mission(missionText(m.id), JSON.stringify({ seed: 9, factoryLoss: 'never' })), /factoryLoss/);
});

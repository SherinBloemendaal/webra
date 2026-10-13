// Online parity: the local map library (js/maplibrary.js), shared lobby maps
// in the online lobby (the install question, Install and Decline, the host's
// picker, who lacks the map), the rematch in a running online game, the end
// of game and menu buttons for it, and spectators hearing no player's
// private sounds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, uninstallDom, click, settle, textOf, FakeEvent } from './dom-fixtures.mjs';
import { LIBRARY_MAX_MAPS, MapLibrary, MemoryMapBackend } from '../js/maplibrary.js';
import { DEFAULT_OPTIONS, MAP_FORMAT_VERSION, MAP_UPGRADED_NOTICE, MEMBER_HEADER, mapHash, parseMap } from '../protocol/index.js';
import { testVersions, v1Map } from '../../../packages/protocol/test/fixtures/map-test-versions.mjs';
import { dialogContent, EndGameFlow, DIALOGS } from '../js/endgame.js';
import { Director, EV, NO_PLAYER } from '../js/audio/director.js';

const COLORS = Array.from({ length: 8 }, (_, i) => [i / 8, 0.5, 0.5]);
const W = 48;
const ZERO = Buffer.alloc(W * W).toString('base64');
const mapObj = (name, author = 'Cartographer') => ({ format: 1, name, author, width: W, height: W, terrain: ZERO, ore: ZERO, spawns: [[2, 2], [40, 40]] });

/** Canonical text and hash of a map object. */
async function info(m) {
  const r = parseMap(JSON.stringify(m));
  assert.ok(r.ok, r.errors?.join('; '));
  return { canonical: r.canonical, hash: await mapHash(r.map), map: r.map };
}

// ---- Map library -----------------------------------------------------------------------------------

test('map library: maps are parsed, hashed and stored canonical; bad maps and wrong hashes are refused', async () => {
  let now = 100;
  const lib = new MapLibrary(new MemoryMapBackend(), () => now++);
  const m = mapObj('Lake');
  const { canonical, hash } = await info(m);
  // Any key order: the same map.
  const shuffled = JSON.stringify(Object.fromEntries(Object.entries(m).reverse()));
  const entry = await lib.add(shuffled, { source: 'oramap' });
  assert.deepEqual(entry, { hash, name: 'Lake', author: 'Cartographer', players: 2, width: W, height: W, modded: false, bytes: canonical.length, source: 'oramap', addedAt: 100, usedAt: 100 });
  assert.equal((await lib.get(hash)).json, canonical);
  assert.equal(await lib.has(hash), true);
  assert.deepEqual((await lib.list()).map((e) => e.hash), [hash]);
  assert.equal('json' in (await lib.list())[0], false, 'lists carry no map text');
  await assert.rejects(lib.add(`{"formatVersion":${MAP_FORMAT_VERSION},"format":1}`), /Invalid map/);
  // Without formatVersion a file is format 1: it upgrades, then fails, so it was made for an older release.
  await assert.rejects(lib.add('{"format":1}'), /no longer compatible/);
  await assert.rejects(lib.add(JSON.stringify(mapObj('Other')), { expectHash: hash }), /expected hash/);
  await assert.rejects(lib.add(canonical, { source: 'somewhere' }), /unknown map source/);
  // Adding it again keeps its source and first time, and marks it used.
  const again = await lib.add(canonical, { source: 'lobby' });
  assert.deepEqual([again.source, again.addedAt, again.usedAt > 100], ['oramap', 100, true]);
  await lib.remove(hash);
  assert.equal(await lib.get(hash), null);
});

test('map library: the least recently used maps go beyond the limit; a failing IndexedDB falls back to memory', async () => {
  let now = 0;
  const lib = new MapLibrary(new MemoryMapBackend(), () => ++now);
  const first = await lib.add(JSON.stringify(mapObj('Map 0')));
  const second = await lib.add(JSON.stringify(mapObj('Map 1')));
  await lib.touch(first.hash);
  for (let i = 2; i <= LIBRARY_MAX_MAPS; i++) await lib.add(JSON.stringify(mapObj(`Map ${i}`)));
  const list = await lib.list();
  assert.equal(list.length, LIBRARY_MAX_MAPS);
  assert.ok(list.some((e) => e.hash === first.hash), 'used recently: kept');
  assert.ok(!list.some((e) => e.hash === second.hash), 'the least recently used one went');

  const broken = { all: async () => Promise.reject(new Error('blocked')), get: async () => Promise.reject(new Error('blocked')), put: async () => Promise.reject(new Error('blocked')), remove: async () => Promise.reject(new Error('blocked')) };
  const warn = console.warn;
  console.warn = () => {};
  try {
    const fallback = new MapLibrary(broken);
    const e = await fallback.add(JSON.stringify(mapObj('Kept anyway')));
    assert.equal((await fallback.get(e.hash)).name, 'Kept anyway');
  } finally {
    console.warn = warn;
  }
});

// ---- The online lobby ------------------------------------------------------------------------------

const SID = 'a'.repeat(64);
const KEY = 'K'.repeat(43);

/** An online lobby UI without a server: `fetch` and the engine are fakes. */
async function mountLobby({ host, maps = [], versions = undefined }) {
  const doc = installDom();
  const root = doc.createElement('div');
  doc.body.append(root);
  globalThis.ImageData ??= class {
    constructor(data, width, height) {
      Object.assign(this, { data, width, height });
    }
  };
  // The engine check: accepts the maps the test registered, with their hash.
  const known = new Map();
  for (const m of maps) known.set(m.canonical, m.hash);
  const Game = {
    map_preview_styled: (seed, size) => new Uint8Array(size * size * 4),
    map_file_preview: () => new Uint8Array(W * W * 4),
    validate_map: (json) => JSON.stringify(known.has(json) ? { ok: true, errors: [], hash: known.get(json), modded: false } : { ok: false, errors: ['unknown map'], modded: false }),
  };
  const requests = [];
  const responses = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url, init });
    const r = responses.shift() ?? { status: 200, body: '[]' };
    return new Response(r.body, { status: r.status, headers: { 'content-type': 'application/json' } });
  };
  const { OnlineUI } = await import('../js/online.js');
  const ui = Object.create(OnlineUI.prototype);
  const sent = [];
  const library = new MapLibrary(new MemoryMapBackend(), undefined, versions);
  Object.assign(ui, {
    root,
    ctx: { colors: COLORS, colorNames: [], Game, mapVersions: versions },
    installed: new Map(),
    mapStatus: { hash: null, text: '', ok: true },
    serverMaps: [],
    libraryMaps: [],
    library,
    member: { client: host ? 1 : 2, key: KEY },
    mapOffer: null,
    rematch: null,
    rematchSubs: new Set(),
    send: (m) => sent.push(m),
    state: {
      you: host ? 1 : 2,
      hostId: 1,
      session: { id: SID, name: 'Test', public: true },
      role: 'player',
      slots: [],
      spectators: [],
      maxSpectators: 2,
      options: null,
      map: null,
      lobbySeen: false,
    },
  });
  ui.buildLobby();
  const lobby = (map, states = {}) =>
    ui.onLobby({
      slots: [
        { type: 'human', client: 1, name: 'Host', faction: 'random', color: 0, team: 0, ready: false, ...(map ? { mapState: 'installed' } : {}) },
        { type: 'human', client: 2, name: 'Guest', faction: 'random', color: 1, team: 0, ready: false, ...(map ? { mapState: states.guest ?? 'missing' } : {}) },
      ],
      options: { ...DEFAULT_OPTIONS },
      map,
      hostId: 1,
      spectators: [{ client: 3, name: 'Eye', ...(map ? { mapState: states.eye ?? 'missing' } : {}) }],
      maxSpectators: 2,
    });
  return { root, ui, sent, lobby, requests, responses, library, known };
}

/** Wait (in real time, the hashing runs on a thread pool) until `cond()` holds. */
async function until(cond, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const ref = (i, extra = {}) => ({ id: '0123456789abcdef', hash: i.hash, name: i.map.name, modded: false, players: 2, author: i.map.author, width: W, height: W, bytes: i.canonical.length, shared: true, ...extra });

test('online lobby: a player without the map is asked; Decline reports it, Install downloads, checks, keeps and reports it', async () => {
  const shared = await info(mapObj('Fjord', 'Mapper'));
  const { root, ui, sent, lobby, requests, responses, library } = await mountLobby({ host: false, maps: [shared] });
  try {
    lobby(ref(shared));
    await settle();
    assert.equal(textOf(root.querySelector('.online-map-question')), 'Custom map: Fjord by Mapper. Install?');
    assert.match(textOf(root.querySelector('.online-map-details')), /By Mapper, 48 x 48 cells/);
    assert.equal(ui.readyBtn.disabled, true, 'not ready without the map');
    const buttons = () => root.querySelectorAll('.online-map-offer button');
    assert.deepEqual(buttons().map((b) => b.textContent), ['Install', 'Decline']);
    // Decline: the server is told, the player stays unready, Install is still offered.
    click(buttons()[1]);
    assert.deepEqual(sent.at(-1), { t: 'mapstate', hash: shared.hash, state: 'declined' });
    assert.deepEqual(buttons().map((b) => b.textContent), ['Install']);
    assert.match(textOf(root.querySelector('.online-map')), /declined the map/);
    // Install: from this session, with this member's key, pinned by hash.
    responses.push({ status: 200, body: shared.canonical });
    click(buttons()[0]);
    await until(() => sent.at(-1).state === 'installed');
    const req = requests.at(-1);
    assert.equal(req.url, `/api/sessions/${SID}/map?hash=${shared.hash}`);
    assert.equal(req.init.headers[MEMBER_HEADER], `2.${KEY}`);
    assert.deepEqual(sent.at(-1), { t: 'mapstate', hash: shared.hash, state: 'installed' });
    assert.equal(ui.installed.get(shared.hash), shared.canonical);
    assert.equal((await library.get(shared.hash)).source, 'lobby', 'kept in the library');
    assert.equal(root.querySelector('.online-map-offer'), null);
    assert.equal(ui.readyBtn.disabled, false);
    // Next time this map comes up, it is ready at once (from the library, checked again).
    ui.installed.clear();
    lobby(null);
    lobby(ref(shared));
    await until(() => ui.installed.has(shared.hash));
    assert.equal(root.querySelector('.online-map-offer'), null, 'not asked again');
  } finally {
    uninstallDom();
  }
});

test('online lobby: a download with another hash is refused; names and authors are only ever text', async () => {
  const shared = await info(mapObj('<img src=x onerror=alert(1)>', '<b>Evil</b>'));
  const other = await info(mapObj('Other'));
  const { root, ui, sent, lobby, responses } = await mountLobby({ host: false, maps: [shared, other] });
  try {
    lobby(ref(shared));
    await settle();
    assert.equal(textOf(root.querySelector('.online-map-question')), 'Custom map: <img src=x onerror=alert(1)> by <b>Evil</b>. Install?');
    assert.equal(root.querySelectorAll('img').length, 0);
    assert.equal(root.querySelectorAll('b').length, 0);
    responses.push({ status: 200, body: other.canonical });
    click(root.querySelectorAll('.online-map-offer button')[0]);
    await until(() => /hash mismatch/.test(ui.mapStatus.text));
    assert.equal(ui.installed.size, 0);
    assert.match(ui.mapStatus.text, /hash mismatch/);
    assert.ok(!sent.some((m) => m.t === 'mapstate' && m.state === 'installed'));
    // A server error is shown, nothing installed.
    responses.push({ status: 403, body: JSON.stringify({ error: { code: 'forbidden', message: 'You are not a member of this session.' } }) });
    click(root.querySelectorAll('.online-map-offer button')[0]);
    await until(() => /not a member/.test(ui.mapStatus.text));
  } finally {
    uninstallDom();
  }
});

test('online lobby: the host shares a map from its library and sees who lacks it', async () => {
  const mine = await info(mapObj('My island'));
  const { root, ui, sent, lobby, requests, responses, library } = await mountLobby({ host: true, maps: [mine] });
  try {
    await library.add(mine.canonical, { source: 'editor' });
    lobby(null);
    responses.push({ status: 200, body: '[]' });
    await ui.loadServerMaps();
    const picker = root.querySelector('.online-map select');
    const group = picker.querySelectorAll('optgroup').find((g) => g.label === 'My maps');
    assert.ok(group, 'the host sees its own maps');
    assert.deepEqual(group.querySelectorAll('option').map((o) => o.value), [`mine:${mine.hash}`]);
    responses.push({ status: 201, body: JSON.stringify({ id: '0123456789abcdef', hash: mine.hash }) });
    picker.value = `mine:${mine.hash}`;
    picker.dispatchEvent(new FakeEvent('change'));
    await until(() => ui.installed.has(mine.hash));
    const post = requests.at(-1);
    assert.equal(post.url, `/api/sessions/${SID}/map`);
    assert.equal(post.init.method, 'POST');
    assert.equal(post.init.headers[MEMBER_HEADER], `1.${KEY}`);
    assert.equal(post.init.headers['X-WebRA-CSRF'], '1');
    assert.equal(post.init.body, mine.canonical);
    assert.equal(ui.installed.get(mine.hash), mine.canonical);
    assert.ok(!sent.some((m) => m.t === 'map'), 'shared through the session, not by id');
    // The server announces it: the host sees who has it and cannot start yet.
    lobby(ref(mine), { guest: 'declined', eye: 'missing' });
    await settle();
    assert.equal(root.querySelector('.online-map-offer'), null, 'the host is not asked');
    const states = root.querySelectorAll('[data-map-state]').map((b) => b.dataset.mapState);
    assert.deepEqual(states.sort(), ['declined', 'installed', 'missing'].sort());
    assert.ok(root.querySelectorAll('.online-map-declined').some((b) => textOf(b) === 'Declined map'));
    assert.equal(ui.startBtn.disabled, true);
    assert.match(ui.barStatus.textContent, /Waiting for Guest, Eye to install the map/);
    // The host can remove the spectator who holds things up.
    click(root.querySelectorAll('.online-spectator button').find((b) => b.textContent === 'Remove'));
    assert.deepEqual(sent.at(-1), { t: 'kick', client: 3 });
  } finally {
    uninstallDom();
  }
});

test('online lobby: a host shares a map file of an older format: the lobby gets the upgraded map, the host a notice', async () => {
  const versions = testVersions();
  // No rules overrides: a modded map would ask the host first.
  const text = JSON.stringify(v1Map({ name: 'Old harbour', rules: null }));
  const r = parseMap(text, { versions });
  const up = { canonical: r.canonical, hash: await mapHash(r.map), map: r.map };
  assert.ok(up.canonical.startsWith('{"formatVersion":3,'));
  const { root, ui, lobby, requests, responses } = await mountLobby({ host: true, maps: [up], versions });
  try {
    lobby(null);
    responses.push({ status: 201, body: JSON.stringify({ id: '0123456789abcdef', hash: up.hash, upgradedFrom: 1 }) });
    await ui.shareFile({ name: 'old-harbour.webra-map.json', size: text.length, text: async () => text });
    const post = requests.at(-1);
    assert.equal(post.url, `/api/sessions/${SID}/map`);
    assert.equal(post.init.body, up.canonical, 'the session gets the upgraded map: every member plays the same');
    assert.equal(ui.installed.get(up.hash), up.canonical);
    lobby(ref(up, { width: 32, height: 32 }));
    await settle();
    const notice = root.querySelector('.online-map-notice');
    assert.ok(notice, 'the host sees the notice');
    assert.equal(textOf(notice), MAP_UPGRADED_NOTICE);
    // Another map: the notice was about that file only.
    lobby(null);
    await settle();
    assert.equal(root.querySelector('.online-map-notice'), null);
  } finally {
    uninstallDom();
  }
});

test('online lobby: maps of a newer format or no longer compatible are refused with what to do', async () => {
  const versions = testVersions();
  const { root, ui, lobby, requests } = await mountLobby({ host: true, versions });
  try {
    lobby(null);
    const before = requests.length;
    const newer = JSON.stringify({ ...v1Map(), formatVersion: 4, gameVersion: '2.0.0' });
    await ui.shareFile({ name: 'new.webra-map.json', size: newer.length, text: async () => newer });
    assert.equal(textOf(root.querySelector('.online-error')), 'This map was made with a newer version of WebRA (2.0, format 4; this version reads format 3). Update the game to play it.');
    const gone = JSON.stringify(v1Map({ actors: [{ type: 'GONE', owner: -1, x: 3, y: 9 }] }));
    await ui.shareFile({ name: 'gone.webra-map.json', size: gone.length, text: async () => gone });
    assert.equal(
      textOf(root.querySelector('.online-error')),
      'This map was made for WebRA 0.9 (format 1) and is no longer compatible with this version. Open it in the map editor and save it again.',
    );
    assert.equal(requests.length, before, 'nothing was uploaded');
    // A download for a lobby is checked the same way: a newer map is not installed.
    await assert.rejects(ui.checkMap(JSON.stringify({ ...v1Map(), formatVersion: MAP_FORMAT_VERSION + 9 })), /newer version of WebRA/);
  } finally {
    uninstallDom();
  }
});

// ---- Rematch ----------------------------------------------------------------------------------------

/** The game's lines as text: "Battlefield Control:line" each. */
const logText = (ui) => ui.textLog.lines.map((l) => `${l.prefix}:${l.text}`).join('\n');

async function inGame({ host }) {
  const ctx = await mountLobby({ host });
  const { ui } = ctx;
  ui.inGame = true;
  // The game's lines (js/chatlog.js; js/chatpanel.js draws them).
  const { TextLog } = await import('../js/chatlog.js');
  ui.textLog = new TextLog();
  ui.rematchBar = document.createElement('div');
  ui.startPlayers = [
    { player: 0, slot: 0, client: 1, name: 'Host', type: 'human' },
    { player: 1, slot: 1, client: 2, name: 'Guest', type: 'human' },
  ];
  return ctx;
}

test('rematch: the host proposes, a player accepts or declines from the overlay, everyone returns to the lobby', async () => {
  const { ui, sent } = await inGame({ host: false });
  try {
    const handle = ui.rematchHandle();
    const changes = [];
    handle.subscribe(() => changes.push(handle.action()));
    let returned = 0;
    handle.onLobby = () => returned++;
    assert.equal(handle.action(), null, 'a guest cannot propose');
    handle.run();
    assert.equal(sent.length, 0);
    ui.onRematch({ t: 'rematch', state: 'open', by: 1, accepted: [1], waiting: [2], msLeft: 60000 });
    assert.equal(handle.action(), 'accept');
    assert.equal(handle.label(), 'Accept rematch');
    assert.match(logText(ui), /Host proposes a rematch with the same settings/);
    assert.match(textOf(ui.rematchBar), /Host proposes a rematch/);
    const [accept, decline] = ui.rematchBar.querySelectorAll('button');
    assert.deepEqual([accept.textContent, decline.textContent], ['Accept', 'Decline']);
    click(accept);
    assert.deepEqual(sent.at(-1), { t: 'rematch', accept: true });
    ui.onRematch({ t: 'rematch', state: 'open', by: 1, accepted: [1, 2], waiting: [], msLeft: 50000 });
    assert.equal(handle.action(), 'waiting');
    ui.conn = { leave: () => assert.fail('a return must not give the place up') };
    ui.onRematch({ t: 'rematch', state: 'lobby', by: 1, accepted: [1, 2], waiting: [] });
    assert.equal(returned, 1, 'the page goes back to the lobby');
    assert.equal(ui.conn, null, 'the old connection is let go without leave');
    assert.deepEqual(changes, ['accept', 'waiting', null]);
    // A lobby message during the game means the same (a missed rematch message): once.
    ui.onLobby({ slots: [], options: DEFAULT_OPTIONS, map: null, hostId: 1, spectators: [], maxSpectators: 0 });
    assert.equal(returned, 1);
  } finally {
    uninstallDom();
  }
});

test('rematch: the host proposes and may withdraw; a decline is reported', async () => {
  const { ui, sent } = await inGame({ host: true });
  try {
    const handle = ui.rematchHandle();
    assert.equal(handle.action(), 'propose');
    assert.equal(handle.label(), 'Rematch');
    assert.match(handle.text(), /same settings/);
    handle.run();
    assert.deepEqual(sent.at(-1), { t: 'rematch', accept: true });
    ui.onRematch({ t: 'rematch', state: 'open', by: 1, accepted: [1], waiting: [2], msLeft: 60000 });
    assert.equal(handle.action(), 'waiting');
    assert.match(textOf(ui.rematchBar), /You proposed a rematch.*Waiting for Guest/);
    click(ui.rematchBar.querySelectorAll('button').find((b) => b.textContent === 'Withdraw'));
    assert.deepEqual(sent.at(-1), { t: 'rematch', accept: false });
    ui.onRematch({ t: 'rematch', state: 'cancelled', by: null, accepted: [], waiting: [], reason: 'declined' });
    assert.match(logText(ui), /No rematch: a player declined/);
    assert.equal(ui.rematchBar.hidden, true);
    assert.equal(handle.action(), 'propose');
  } finally {
    uninstallDom();
  }
});

test('the end of game dialog offers the rematch online with its own label', () => {
  const flow = new EndGameFlow({ online: true });
  flow.update({ defeated: true, winner: 1, won: false });
  assert.equal(flow.dialog, DIALOGS.DEFEAT);
  const none = dialogContent(flow, { canRestart: false });
  assert.equal(none.buttons.some((b) => b.id === 'restart'), false);
  const offer = dialogContent(flow, { canRestart: true, restartLabel: 'Accept rematch' });
  assert.equal(offer.buttons.find((b) => b.id === 'restart').label, 'Accept rematch');
  assert.equal(dialogContent(new EndGameFlow({ online: true }), { canRestart: true }), null, 'no dialog while playing');
});

test('the game menu shows the rematch only while it can be proposed or accepted', async () => {
  const { GameMenu } = await import('../js/gamemenu.js');
  const menu = Object.create(GameMenu.prototype);
  let action = 'propose';
  menu.opts = { restart: { online: true, available: () => action !== null, label: () => (action === 'accept' ? 'Accept rematch' : 'Rematch'), text: () => 'x', run() {} } };
  assert.equal(menu.restartShown(), true);
  assert.equal(menu.restartLabel(), 'Rematch');
  action = 'accept';
  assert.equal(menu.restartLabel(), 'Accept rematch');
  action = null;
  assert.equal(menu.restartShown(), false);
  menu.opts = { restart: { replay: true, run() {} } };
  assert.equal(menu.restartLabel(), 'Restart replay');
  menu.opts = {};
  assert.equal(menu.restartShown(), false);
});

// ---- Spectators' sound -----------------------------------------------------------------------------------

test("spectators hear no player's private sounds (placement, deploy, sell, announcements)", () => {
  const rules = { actors: [{ id: 'MCV', kind: 'vehicle' }, { id: 'FACT', kind: 'building' }, { id: 'POWR', kind: 'building' }], weapons: [] };
  const VIEW = { x0: 0, y0: 0, x1: 1000, y1: 600 };
  const run = (player) => {
    const effects = [];
    const announced = [];
    const d = new Director({ rules, player, side: 'allies', pxPerWorld: 1, lookup: () => null, sink: { effect: (s) => effects.push(s), voice() {}, announce: (k) => announced.push(k) }, now: () => 0 });
    for (const owner of [0, 1]) {
      d.onEvents(
        [
          ...[EV.BUILDING_PLACED, 2, 500, 300, owner, 0],
          ...[EV.TRANSFORMED, 0, 500, 300, owner, 1],
          ...[EV.DEPLOY_BLOCKED, 0, 500, 300, owner, 0],
          ...[EV.UNIT_PRODUCED, 0, 500, 300, owner, 0],
          ...[EV.SOLD, 2, 500, 300, owner, 0],
        ],
        VIEW,
      );
    }
    return { effects: effects.length, announced };
  };
  const owner = run(0);
  assert.ok(owner.effects > 0 && owner.announced.length > 0, "the owner hears its own (player 0's)");
  assert.deepEqual(run(NO_PLAYER), { effects: 0, announced: [] }, 'a spectator hears none of them');
});

// ---- Online saves -------------------------------------------------------------------------------------

const SAVE_OPTIONS = {
  ...DEFAULT_OPTIONS,
  seed: 4,
  players: [
    { slot: 0, type: 'human', name: 'Host', faction: 'germany', color: 0, team: 0 },
    { slot: 1, type: 'human', name: 'Guest', faction: 'russia', color: 1, team: 0 },
  ],
};

async function onlineRecorder() {
  const { Recorder } = await import('../js/replay.js');
  const rec = new Recorder({ mode: 'online', options: SAVE_OPTIONS, map: null, mapHash: null, player: 1, engine: '1.0.0', title: 'Friday' });
  rec.record(3, [[1, [{ o: 'stop', player: 1, ids: [7] }]]]);
  rec.record(30, [[0, [{ o: 'stop', player: 0, ids: [8] }]]]);
  return rec;
}

test('an online save file: the frames before the save point, its hash and the record id', async () => {
  const { parseReplay } = await import('../protocol/index.js');
  const rec = await onlineRecorder();
  const r = await parseReplay(rec.encodeOnlineSave(26, 'abcd', '0123456789abcdef'));
  assert.ok(r.ok, r.error);
  assert.deepEqual([r.replay.kind, r.replay.mode, r.replay.ticks, r.replay.player], ['save', 'online', 26, 1]);
  assert.deepEqual(r.replay.frames.map(([t]) => t), [3], 'only orders before the save point');
  assert.deepEqual(r.replay.hashes.at(-1), [26, 'abcd']);
  assert.deepEqual(r.replay.online, { id: '0123456789abcdef' });
  const { Recorder } = await import('../js/replay.js');
  const skirmish = new Recorder({ mode: 'skirmish', options: SAVE_OPTIONS, map: null, mapHash: null, player: 0, engine: '1.0.0', title: 'x' });
  assert.throws(() => skirmish.encodeOnlineSave(26, 'ab', '0123456789abcdef'), /online/);
});

test('an online replay keeps the chat as received; saves and other games keep none', async () => {
  const { parseReplay, REPLAY_CHAT_MAX } = await import('../protocol/index.js');
  const rec = await onlineRecorder();
  rec.noteChat(5, 0, 'Host', 'glhf', false);
  rec.noteChat(12, -1, 'Watcher', 'nice', true);
  rec.noteChat(40, 1, 'Guest', 'later', false);
  const r = await parseReplay(rec.encode('replay', 30));
  assert.ok(r.ok, r.error);
  assert.deepEqual(r.replay.chat, [
    [5, 0, 'Host', 'glhf', 0],
    [12, -1, 'Watcher', 'nice', 1],
  ]);
  const save = await parseReplay(rec.encodeOnlineSave(26, 'abcd', '0123456789abcdef'));
  assert.equal(save.replay.chat, undefined, 'saves never carry chat');
  const { Recorder } = await import('../js/replay.js');
  const skirmish = new Recorder({ mode: 'skirmish', options: SAVE_OPTIONS, map: null, mapHash: null, player: 0, engine: '1.0.0', title: 'x' });
  skirmish.noteChat(1, 0, 'Host', 'nobody hears', false);
  assert.equal(skirmish.build('replay', 10).chat, undefined);
  // The file is checked strictly.
  const text = JSON.parse(rec.encode('replay', 30));
  const bad = async (chat) => (await parseReplay(JSON.stringify({ ...text, chat }))).ok;
  assert.equal(await bad([[5, 2, 'Host', 'x', 0]]), false, 'no such player');
  assert.equal(await bad([[31, 0, 'Host', 'x', 0]]), false, 'after the end');
  assert.equal(await bad([[5, 0, 'Host', '', 0]]), false, 'empty text');
  assert.equal(await bad([[5, 0, 'Host', 'x', 2]]), false, 'team is 0 or 1');
  assert.equal(await bad([[9, 0, 'Host', 'x', 0], [5, 0, 'Host', 'y', 0]]), false, 'in tick order');
  assert.equal(await bad(Array.from({ length: REPLAY_CHAT_MAX + 1 }, () => [1, 0, 'Host', 'x', 0])), false);
  assert.equal(await bad([[5, 0, 'Host', 'x', 0]]), true);
});

test('saving online: a player accepts in the overlay; the saved file is kept in this browser only for players', async () => {
  const { SaveStore, MemoryBackend } = await import('../js/saves.js');
  const { ui, sent } = await inGame({ host: false });
  try {
    const rec = await onlineRecorder();
    ui.saves = new SaveStore(new MemoryBackend());
    ui.saveSubs = new Set();
    ui.saveBar = document.createElement('div');
    ui.mySeat = 1;
    ui.recorder = { encodeOnlineSave: async (ticks, hash, id) => rec.encodeOnlineSave(ticks, hash, id) };
    const handle = ui.saveHandle();
    assert.equal(handle.action(), 'propose');
    await ui.onSave({ t: 'save', state: 'open', by: 1, accepted: [1], waiting: [2], msLeft: 50000 });
    assert.equal(handle.action(), 'accept');
    assert.match(textOf(ui.saveBar), /Host wants to save the game/);
    click(ui.saveBar.querySelectorAll('button').find((b) => b.textContent === 'Accept'));
    assert.deepEqual(sent.at(-1), { t: 'save', accept: true });
    await ui.onSave({ t: 'save', state: 'agreed', tick: 25 });
    assert.equal(handle.action(), 'saving');
    assert.equal(handle.run(), false, 'nothing to send while saving');
    await ui.onSave({ t: 'save', state: 'saved', id: '0123456789abcdef', ticks: 26, hash: 'abcd' });
    const rows = await ui.saves.list();
    assert.deepEqual(rows.map((x) => [x.mode, x.online, x.ticks]), [['online', '0123456789abcdef', 26]]);
    assert.match(logText(ui), /Game saved/);
    // A spectator keeps nothing (it cannot resume a game it did not play).
    ui.mySeat = null;
    await ui.onSave({ t: 'save', state: 'saved', id: '0123456789abcdef', ticks: 26, hash: 'abcd' });
    assert.equal((await ui.saves.list()).length, 1);
    await ui.onSave({ t: 'save', state: 'cancelled', reason: 'desync' });
    assert.match(logText(ui), /games differ/);
  } finally {
    uninstallDom();
  }
});

test('a lobby that resumes a save shows it and keeps the saved settings', async () => {
  const { root, ui } = await mountLobby({ host: true });
  try {
    ui.onLobby({
      slots: [
        { type: 'human', client: 1, name: 'Host', faction: 'germany', color: 0, team: 0, ready: false },
        { type: 'open' },
      ],
      options: { ...DEFAULT_OPTIONS },
      map: null,
      hostId: 1,
      spectators: [],
      maxSpectators: 2,
      resume: { id: '0123456789abcdef', title: 'Friday <i>night</i>', createdAt: 0, ticks: 1501, waiting: ['Guest'] },
    });
    assert.match(textOf(ui.resumeBox), /Resuming "Friday <i>night<\/i>"/);
    assert.match(textOf(ui.resumeBox), /Waiting for its players: Guest/);
    assert.equal(root.querySelectorAll('i').length, 0);
    assert.equal(ui.resumeBox.hidden, false);
    for (const c of root.querySelectorAll('.online-options select')) assert.equal(c.disabled, true, 'options stay as saved');
    assert.equal(root.querySelectorAll('.online-slots button').some((b) => b.textContent === 'Take'), false);
    assert.equal(root.querySelector('.online-map select'), null, 'no map picker');
  } finally {
    uninstallDom();
  }
});

// ---- Co-op missions --------------------------------------------------------------------------------

test('online lobby: the host picks a co-op mission; places are the mission players, people only, its difficulty', async () => {
  const { COOP_MISSIONS } = await import('../protocol/index.js');
  const evac = COOP_MISSIONS.find((m) => m.id === 'evacuation');
  const { root, ui, sent } = await mountLobby({ host: true });
  ui.missionPreviews = new Map();
  ui.missionEntries = new Map();
  ui.ctx.missionInfo = async () => ({ briefing: 'Get them out.', options: { difficulty: { label: 'Difficulty', values: [['easy', 'Easy'], ['normal', 'Normal']] } } });
  ui.ctx.missionText = async () => JSON.stringify({ map: { width: 4 } });
  ui.ctx.Game.mission_preview = () => new Uint8Array(4 * 4 * 4);
  try {
    ui.onLobby({
      slots: [
        { type: 'human', client: 1, name: 'Host', faction: 'random', color: 0, team: 0, ready: false },
        { type: 'human', client: 2, name: 'Guest', faction: 'random', color: 1, team: 0, ready: false },
      ],
      options: { ...DEFAULT_OPTIONS },
      map: null,
      hostId: 1,
      spectators: [],
      maxSpectators: 2,
    });
    const picker = root.querySelector('.online-map select');
    const group = picker.querySelectorAll('optgroup').find((g) => g.label === 'Co-op missions');
    assert.deepEqual(group.querySelectorAll('option').map((o) => o.value), COOP_MISSIONS.map((m) => `mission:${m.id}`));
    picker.value = 'mission:evacuation';
    picker.dispatchEvent(new FakeEvent('change'));
    await settle();
    const mission = { id: 'evacuation', hash: evac.hash, options: { difficulty: 'normal' } };
    assert.deepEqual(sent.at(-1), { t: 'mission', mission });
    // The server answers with the mission lobby.
    ui.onLobby({
      slots: [
        { type: 'human', client: 1, name: 'Host', faction: 'random', color: 0, team: 0, ready: false },
        { type: 'human', client: 2, name: 'Guest', faction: 'random', color: 1, team: 0, ready: false },
        { type: 'closed' },
      ],
      options: { ...DEFAULT_OPTIONS },
      map: null,
      hostId: 1,
      spectators: [],
      maxSpectators: 2,
      mission,
    });
    await settle();
    await settle();
    const badges = root.querySelectorAll('.online-slot .online-badge').map((b) => b.textContent);
    assert.ok(badges.includes('Allies1') && badges.includes('Allies2'), badges.join(','));
    assert.match(textOf(root.querySelector('.online-map')), /Evacuation \(2 players\)/);
    assert.match(textOf(root.querySelector('.online-map')), /Get them out\./);
    // No computer players, no skirmish options but the game speed.
    const typeChoices = root.querySelectorAll('.online-slot select').flatMap((s) => s.querySelectorAll('option').map((o) => o.value));
    assert.ok(!typeChoices.includes('ai'), typeChoices.join(','));
    assert.equal(ui.optionWorld.hidden, true);
    assert.equal(ui.optionRows.gameSpeed.hidden, false);
    // The host picks the difficulty.
    const difficulty = root.querySelectorAll('.online-mission select')[0];
    difficulty.value = 'easy';
    difficulty.dispatchEvent(new FakeEvent('change'));
    assert.deepEqual(sent.at(-1), { t: 'mission', mission: { ...mission, options: { difficulty: 'easy' } } });
  } finally {
    uninstallDom();
  }
});

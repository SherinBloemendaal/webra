// The online screens of the 0.17 redesign: what the server browser, the
// lobby's Connection column and warning bar, the start check and the invite
// code dialog show (js/online-view.js), drawn with the fake DOM where the
// drawing matters (js/online.js, js/online-dialog.js). Fixtures only: no
// server, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, uninstallDom, click, settle, textOf, typeInto } from './dom-fixtures.mjs';
import {
  connectionCell,
  connectionWarning,
  filterSessions,
  friendSessionIds,
  inviteInput,
  inviteLeftText,
  inviteResult,
  modeName,
  notReady,
  onlineText,
  optionChips,
  QUALITY_RULES,
  selfConnection,
  sessionDetail,
  sessionRow,
  sessionState,
  startCheck,
  waitingText,
} from '../js/online-view.js';
import { NET_GOOD_RTT_MS, NET_POOR_LATE_PCT, NET_POOR_RTT_MS, netBars, netQuality } from '../js/protocol.js';
import { HELP } from '../js/help.js';

const V = '0.17.0';
/** The words of a part, one space between elements (textOf joins them without one). */
const words = (node) =>
  (node.childNodes.length ? node.childNodes.map(words).join(' ') : (node.tagName ? '' : node.textContent)).replace(/\s+/g, ' ').trim();
/** A player's numbers as js/netquality.js keeps them. */
const net = (client, rtt, jitter = 2, late = 0, silent = null) => {
  const quality = rtt === null ? null : netQuality({ rtt, jitter, late });
  return { client, rtt, jitter, late, silent, quality, bars: netBars(quality), you: false };
};
const SLOTS = [
  { type: 'human', client: 1, name: 'Kara', ready: false },
  { type: 'human', client: 2, name: 'Commander', ready: true },
  { type: 'human', client: 3, name: 'Ivan', ready: false },
  { type: 'ai', name: 'Normal AI' },
  { type: 'human', client: 4, name: 'Mo', ready: true },
  { type: 'open' },
];

// ---- Connection column, warning bar, start check ----------------------------------------------

test('connection cell: four bars when good, three fair, one poor, measuring before the first pong', () => {
  assert.deepEqual(connectionCell(net(1, 34, 4, 0)), { quality: 'good', bars: 4, word: 'Good', ms: '34 ms', detail: '±4 ms · 0% loss', label: 'Good: 34 ms, ±4 ms, 0% loss' });
  assert.equal(connectionCell(net(1, 118, 12, 0)).bars, 3);
  assert.equal(connectionCell(net(1, 60, 25, 0)).word, 'Fair', 'jitter above 20 ms is fair');
  const poor = connectionCell(net(1, 210, 60, 4));
  assert.deepEqual([poor.quality, poor.bars, poor.ms, poor.detail], ['poor', 1, '210 ms', '±60 ms · 4% loss']);
  assert.equal(connectionCell(net(1, 40, 2, NET_POOR_LATE_PCT + 0.5)).quality, 'poor', 'more than 2% loss is poor');
  assert.deepEqual([connectionCell(null).word, connectionCell(null).bars, connectionCell(null).quality], ['Measuring', 0, null]);
  // Silent for a while (the server heard no ping): poor, whatever it said before.
  const silent = connectionCell(net(1, 30, 2, 0, 7000));
  assert.deepEqual([silent.quality, silent.word, silent.bars], ['poor', 'No answer', 1]);
  assert.equal(connectionCell(net(1, null, null, null, 6000)).label, 'No answer for 6 seconds');
});

test('own status: the word, the ms to the server and the detail line', () => {
  assert.deepEqual(selfConnection({ rtt: 34, jitter: 4, late: 0, quality: 'good', bars: 4 }), {
    quality: 'good',
    bars: 4,
    title: 'Your connection: Good',
    detail: '34 ms to the server · ±4 ms · 0% loss',
  });
  assert.equal(selfConnection(null).title, 'Your connection: measuring');
});

test('warning bar: names the worst player, Kick for the host only and never for itself; Test again for all', () => {
  const players = new Map([
    [1, net(1, 28)],
    [2, net(2, 34)],
    [3, net(3, 210, 60, 4)],
    [4, net(4, 118, 12)],
  ]);
  assert.equal(connectionWarning({ slots: SLOTS, players: new Map([[1, net(1, 28)]]), you: 2, hostId: 1, isHost: false }), null);
  const w = connectionWarning({ slots: SLOTS, players, you: 2, hostId: 1, isHost: true });
  assert.equal(w.text, "Ivan's connection is unstable: 210 ms with 4% loss. In an online game everyone waits for the slowest player, so the game may stutter.");
  assert.deepEqual([w.client, w.slot, w.canKick, w.names], [3, 2, true, ['Ivan']]);
  assert.equal(connectionWarning({ slots: SLOTS, players, you: 2, hostId: 1, isHost: false }).canKick, false, 'a player cannot kick');
  // Your own connection: no Kick, and it says so.
  const mine = connectionWarning({ slots: SLOTS, players: new Map([[1, net(1, 400)]]), you: 1, hostId: 1, isHost: true });
  assert.match(mine.text, /^Your connection is unstable: 400 ms/);
  assert.equal(mine.canKick, false);
  // Two poor: the worst first, the other counted.
  const two = connectionWarning({ slots: SLOTS, players: new Map([[3, net(3, 210)], [4, net(4, 500)]]), you: 2, hostId: 1, isHost: true });
  assert.deepEqual(two.names, ['Mo', 'Ivan']);
  assert.match(two.text, /1 more player has a poor connection too\.$/);
});

test('start check: warns about poor connections but is not a refusal; nothing when all are fine', () => {
  assert.equal(startCheck({ slots: SLOTS, players: new Map([[3, net(3, 40)]]), you: 1 }), null);
  const c = startCheck({ slots: SLOTS, players: new Map([[3, net(3, 210, 60, 4)]]), you: 1 });
  assert.equal(c.text, 'Poor connection: Ivan (210 ms with 4% loss). In an online game everyone waits for the slowest player, so the game may stutter. Start anyway?');
});

test('waiting for: the names of the players who are not ready (not the host)', () => {
  assert.deepEqual(notReady(SLOTS, 1), ['Ivan']);
  assert.equal(waitingText(['Ivan']), 'Waiting for Ivan');
  assert.equal(waitingText(['Ivan', 'Mo']), 'Waiting for Ivan and Mo');
  assert.equal(waitingText(['A', 'B', 'C']), 'Waiting for A, B and C');
  assert.equal(waitingText(['A', 'B', 'C', 'D']), 'Waiting for A, B and 2 more');
  assert.equal(waitingText([]), '');
});

test('the legend and the help say the shared thresholds', () => {
  assert.match(QUALITY_RULES.good, new RegExp(`Under ${NET_GOOD_RTT_MS} ms`));
  assert.match(QUALITY_RULES.poor, new RegExp(`Above ${NET_POOR_RTT_MS} ms`));
  for (const n of [NET_GOOD_RTT_MS, NET_POOR_RTT_MS, `${NET_POOR_LATE_PCT}%`]) assert.ok(HELP.connection.includes(String(n)), `help names ${n}`);
});

// ---- Server browser ---------------------------------------------------------------------------

const summary = (players, extra = {}) => ({ players, spectators: 1, maxSpectators: 2, mode: 'classic', options: { startingCash: 10000, fog: true, techLevel: 'unrestricted', gameSpeed: 'normal', crates: false, timeLimit: 0 }, ...extra });
const SESSIONS = [
  { id: 'a'.repeat(64), name: 'Friday night 2v2', host: 'Kara', players: 3, maxPlayers: 4, locked: false, map: { id: 'm1', name: 'Ore Lord', hash: 'h', modded: false }, version: V, state: 'lobby', summary: summary([{ name: 'Kara', team: 1, color: 2 }, { name: 'Ivan', team: 2, color: 0 }, { name: 'Normal AI', team: 2, color: 3, ai: true }]) },
  { id: 'b'.repeat(64), name: 'Naval only', host: 'Admiral', players: 4, maxPlayers: 4, locked: true, map: null, version: V, state: 'lobby', summary: summary([], { mode: 'custom' }) },
  { id: 'c'.repeat(64), name: 'Clan practice', host: 'RedStar', players: 4, maxPlayers: 4, locked: false, map: { name: 'Keep off the grass', modded: true, shared: true }, version: V, state: 'game', summary: summary([], { startedAt: 1_000_000, spectators: 2 }) },
  { id: 'd'.repeat(64), name: 'Old one', host: 'Tomas', players: 1, maxPlayers: 2, locked: false, map: { mission: 'evacuation', name: 'Evacuation', modded: false }, version: '0.16.0', state: 'lobby', summary: summary([], { mode: null }) },
];

test('server browser: states, filters, search, Hide full and the Friends filter', () => {
  assert.deepEqual(SESSIONS.map(sessionState), ['open', 'full', 'ingame', 'open']);
  const ids = (list) => list.map((s) => s.host);
  assert.deepEqual(ids(filterSessions(SESSIONS)), ['Kara', 'Admiral', 'RedStar', 'Tomas']);
  assert.deepEqual(ids(filterSessions(SESSIONS, { filter: 'open' })), ['Kara', 'Tomas']);
  assert.deepEqual(ids(filterSessions(SESSIONS, { filter: 'ingame' })), ['RedStar']);
  assert.deepEqual(ids(filterSessions(SESSIONS, { hideFull: true })), ['Kara', 'RedStar', 'Tomas'], 'running games are not "full"');
  assert.deepEqual(ids(filterSessions(SESSIONS, { query: 'ORE' })), ['Kara'], 'the map name matches, any case');
  assert.deepEqual(ids(filterSessions(SESSIONS, { query: 'redstar' })), ['RedStar'], 'the host matches');
  const friends = friendSessionIds({ friends: [{ status: 'game', session: { id: 'c'.repeat(64) } }, { status: 'online' }] });
  assert.deepEqual(ids(filterSessions(SESSIONS, { filter: 'friends', friendSessions: friends })), ['RedStar']);
  assert.deepEqual(ids(filterSessions(SESSIONS, { filter: 'friends' })), [], 'no friends list: nothing');
});

test('server browser rows: mode, tags as words, the lamp per state, other versions', () => {
  const [open, full, running, old] = SESSIONS.map((s) => sessionRow(s, { version: V }));
  assert.deepEqual([open.mode, open.players, open.led, open.tags], ['Classic', '3/4', 'ok', []]);
  assert.deepEqual(full.tags, [['full', 'Full'], ['locked', 'Password']]);
  assert.equal(full.mode, 'Custom');
  assert.deepEqual(running.tags, [['ingame', 'In game'], ['modded', 'Modded']]);
  assert.equal(running.led, 'warn');
  assert.deepEqual([old.mode, old.sameVersion, old.tags], ['Co-op', false, [['info', 'Co-op']]]);
  assert.equal(modeName({ map: null }), '', 'rows of older servers have no summary');
});

test('detail panel: players with team and colour, open places, option chips, Join or Spectate', () => {
  const d = sessionDetail(SESSIONS[0], { version: V });
  assert.equal(d.sub, 'Hosted by Kara · Ore Lord · Classic');
  assert.deepEqual(d.players, [
    { name: 'Kara', team: 1, color: 2, ai: false },
    { name: 'Ivan', team: 2, color: 0, ai: false },
    { name: 'Normal AI', team: 2, color: 3, ai: true },
  ]);
  assert.equal(d.open, 1);
  assert.deepEqual(d.chips, ['$10,000', 'All tech', 'Fog', '1 spectator']);
  assert.deepEqual([d.canJoin, d.canWatch], [true, true]);
  const running = sessionDetail(SESSIONS[2], { version: V, now: 1_000_000 + 760_000 });
  assert.match(running.sub, /Playing 12:40$/);
  assert.deepEqual([running.canJoin, running.canWatch, running.open], [false, false, 0], 'no spectator place left');
  assert.equal(running.watchTitle, 'The spectator places are taken');
  const full = sessionDetail(SESSIONS[1], { version: V });
  assert.deepEqual([full.canJoin, full.canWatch, full.locked], [false, true, true]);
  const old = sessionDetail(SESSIONS[3], { version: V });
  assert.deepEqual([old.canJoin, old.canWatch, old.joinTitle], [false, false, 'Needs game version 0.16.0']);
  assert.deepEqual(optionChips(summary([], { options: { startingCash: 5000, gameSpeed: 'fast', crates: true, timeLimit: 30 }, spectators: 0 })), ['$5,000', 'Fast', 'Crates', '30 min limit', '0 spectators']);
});

test('online counter', () => {
  assert.deepEqual(onlineText({ players: 142, lobbies: 1, games: 3 }), { text: '142 online', title: '142 players online, 1 lobby open, 3 games running' });
  assert.equal(onlineText(null), null);
});

// ---- Invite codes ----------------------------------------------------------------------------

test('invite field: the dash by itself, confusable letters dropped, links and long ids pasted whole', () => {
  assert.deepEqual(inviteInput('k7q'), { code: null, sessionId: null, shown: 'K7Q', cells: ['K', '7', 'Q', '', '', ''], complete: false });
  assert.equal(inviteInput('k7q2m').shown, 'K7Q-2M');
  assert.equal(inviteInput('K0O1IL7').shown, 'K7', 'no 0, O, 1, I or L in a code');
  const full = inviteInput('k7q 2mx');
  assert.deepEqual([full.code, full.shown, full.complete], ['K7Q2MX', 'K7Q-2MX', true]);
  assert.equal(inviteInput('https://webra.example/join/K7Q-2MX').code, 'K7Q2MX');
  assert.equal(inviteInput('https://webra.example/play/?invite=k7q2mx').code, 'K7Q2MX');
  const id = 'f'.repeat(64);
  assert.deepEqual([inviteInput(`https://webra.example/play/?join=${id}`).sessionId, inviteInput(id).complete], [id, true]);
});

test('invite lookups: the lobby card, Join as spectator when full, the errors of the board', () => {
  const invite = { code: 'K7Q2MX', session: 'a'.repeat(64), name: 'Friday night 2v2', host: 'Kara', map: { name: 'Coastal Ridge' }, players: 3, maxPlayers: 4, spectators: 0, maxSpectators: 2, locked: false, version: V };
  const ok = inviteResult({ ok: true, invite, full: false, canSpectate: true }, { version: V, rtt: 34 });
  assert.deepEqual([ok.kind, ok.title, ok.sub, ok.action, ok.canJoin], ['lobby', 'Friday night 2v2', 'Hosted by Kara · Coastal Ridge · 3 of 4 players · 34 ms', 'Join lobby', true]);
  const full = inviteResult({ ok: true, invite: { ...invite, players: 4 }, full: true, canSpectate: true, message: 'The lobby is full. You can still join as a spectator.' }, { version: V });
  assert.deepEqual([full.kind, full.action, full.spectate, full.canJoin], ['full', 'Join as spectator', true, true]);
  assert.equal(inviteResult({ ok: true, invite: { ...invite, players: 4 }, full: true, canSpectate: false }, { version: V }).canJoin, false);
  const gone = inviteResult({ ok: false, reason: 'expired', message: 'The lobby closed or the code was replaced.' });
  assert.deepEqual([gone.kind, gone.reason, gone.canJoin], ['error', 'expired', false]);
  assert.equal(inviteResult({ ok: true, invite: { ...invite, version: '0.18.0' }, full: false }, { version: V }).reason, 'version');
  assert.equal(inviteLeftText(102 * 60_000), '1 h 42 min left');
  assert.equal(inviteLeftText(12 * 60_000 + 5), '12 min left');
  assert.equal(inviteLeftText(20_000), 'less than a minute left');
  assert.equal(inviteLeftText(0), 'Expired');
});

test('join with a code: typing fills the cells, a complete code is looked up, Join returns the lobby', async () => {
  const doc = installDom();
  const { joinCodeDialog } = await import('../js/online-dialog.js');
  const looked = [];
  const invite = { code: 'K7Q2MX', session: 'a'.repeat(64), name: 'Friday night 2v2', host: 'Kara', map: null, players: 4, maxPlayers: 4, spectators: 0, maxSpectators: 2, locked: true, version: V };
  const lookup = async (code) => {
    looked.push(code);
    return code === 'K7Q2MX' ? { ok: true, invite, full: true, canSpectate: true, message: 'The lobby is full. You can still join as a spectator.' } : { ok: false, reason: 'unknown', message: 'No lobby has this code. Check it with your friend.' };
  };
  const timers = { setTimeout: (fn) => (fn(), 1), clearTimeout() {} };
  try {
    const done = joinCodeDialog({ version: V, lookup, timers });
    const dialog = doc.body.querySelector('dialog');
    const input = dialog.querySelector('.invite-code-input');
    const join = dialog.querySelectorAll('button').find((b) => b.textContent.startsWith('Join'));
    typeInto(input, 'k7q2');
    assert.equal(input.value, 'K7Q-2');
    assert.deepEqual(dialog.querySelectorAll('.invite-code-cell').map((c) => c.textContent), ['K', '7', 'Q', '2', '', '']);
    assert.equal(join.disabled, true);
    typeInto(input, 'K7Q-2MZ');
    await settle();
    assert.deepEqual(looked, ['K7Q2MZ']);
    assert.match(words(dialog.querySelector('.invite-result')), /Unknown\s*No lobby has this code/);
    assert.equal(join.disabled, true);
    typeInto(input, 'https://webra.example/join/k7q-2mx');
    await settle();
    assert.equal(input.value, 'K7Q-2MX', 'the code from the link');
    assert.match(words(dialog.querySelector('.invite-result')), /Friday night 2v2 Password Hosted by Kara · Generated · 4 of 4 players/);
    assert.equal(join.textContent, 'Join as spectator');
    click(join);
    assert.deepEqual(await done, { session: 'a'.repeat(64), name: 'Friday night 2v2', locked: true, spectate: true });
  } finally {
    uninstallDom();
  }
});

// ---- Drawn by js/online.js ---------------------------------------------------------------------

/** An OnlineUI without a server (the way tests/onlinemaps.test.mjs builds one). */
async function bareUi(extra = {}) {
  const doc = installDom();
  const root = doc.createElement('div');
  doc.body.append(root);
  const { OnlineUI } = await import('../js/online.js');
  const ui = Object.create(OnlineUI.prototype);
  Object.assign(ui, { root, ctx: { colors: Array.from({ length: 8 }, () => [1, 0, 0]), colorNames: [], version: V, Game: {} }, ...extra });
  return { doc, root, ui };
}

test('server browser: rows by search and filter, the chosen one in the detail panel, Enter joins', async () => {
  const { root, ui } = await bareUi();
  const joined = [];
  ui.join = (s, o = {}) => joined.push([s.host, !!o.spectate]);
  try {
    ui.sessionList = root.appendChild(document.createElement('div'));
    ui.detailBox = root.appendChild(document.createElement('aside'));
    ui.listStatus = root.appendChild(document.createElement('p'));
    ui.presenceLine = root.appendChild(document.createElement('p'));
    ui.browse = { filter: 'all', query: '', hideFull: false, selected: null };
    ui.sessions = SESSIONS;
    ui.onlineCount = { players: 142, lobbies: 3, games: 1 };
    ui.serverRtt = 34;
    ui.renderSessions();
    assert.equal(words(ui.presenceLine), '142 online 34 ms to the server');
    assert.equal(ui.sessionRows.length, 4);
    assert.equal(ui.sessionRows[0].getAttribute('aria-selected'), 'true', 'the first row is chosen');
    assert.match(words(ui.detailBox), /Friday night 2v2 Hosted by Kara · Ore Lord · Classic Kara Team 1 Ivan Team 2 Normal AI \(AI\) Team 2 Open slot/);
    // The keyboard: Down chooses the next row, Enter on a full lobby watches it.
    ui.sessionKey({ key: 'ArrowDown', preventDefault() {} });
    assert.equal(ui.browse.selected, 'b'.repeat(64));
    ui.sessionKey({ key: 'Enter', preventDefault() {} });
    assert.deepEqual(joined.at(-1), ['Admiral', true]);
    ui.browse.query = 'clan';
    ui.renderSessions();
    assert.equal(ui.sessionRows.length, 1);
    assert.match(words(ui.sessionRows[0]), /Clan practice host RedStar In game\. In game Modded/);
    assert.equal(ui.listStatus.textContent, '1 of 4 sessions');
    const buttons = ui.detailBox.querySelectorAll('button');
    assert.deepEqual(buttons.map((b) => [b.textContent, b.disabled]), [['Spectate', true], ['Join game', true]]);
  } finally {
    uninstallDom();
  }
});

test('online lobby: the Connection column, the warning bar with Test again and Kick, the start check', async () => {
  const sent = [];
  const tests = [];
  const players = new Map([
    [1, net(1, 28)],
    [3, net(3, 210, 60, 4)],
  ]);
  const { root, ui } = await bareUi({
    installed: new Map(),
    mapStatus: { hash: null, text: '', ok: true },
    serverMaps: [],
    libraryMaps: [],
    library: { list: async () => [] },
    member: { client: 1, key: 'K'.repeat(43) },
    send: (m) => sent.push(m),
    netq: { players, self: { rtt: 28, jitter: 2, late: 0, quality: 'good', bars: 4 }, testAgain: () => tests.push(1) },
    state: { you: 1, hostId: 1, session: { id: 'a'.repeat(64), name: 'Friday night 2v2', public: false, locked: true }, role: 'player', slots: [], spectators: [], maxSpectators: 2, options: null, map: null, lobbySeen: false, invite: null },
  });
  try {
    ui.ctx.Game = { map_preview_styled: (seed, size) => new Uint8Array(size * size * 4) };
    ui.buildLobby();
    const { DEFAULT_OPTIONS } = await import('../js/protocol.js');
    ui.onLobby({
      slots: [
        { type: 'human', client: 1, name: 'Kara', faction: 'england', color: 0, team: 1, ready: false },
        { type: 'human', client: 3, name: 'Ivan', faction: 'russia', color: 1, team: 2, ready: false },
        { type: 'ai', name: 'Normal AI', faction: 'random', color: 2, team: 2, difficulty: 'normal' },
      ],
      options: { ...DEFAULT_OPTIONS },
      map: null,
      hostId: 1,
      spectators: [],
      maxSpectators: 2,
      invite: { code: 'K7Q2MX', expiresAt: Date.now() + 102 * 60_000 + 30_000 },
    });
    assert.match(words(root.querySelector('.online-lobby-tags')), /Private Password/);
    assert.match(words(root.querySelector('.online-self-net')), /Your connection: Good 28 ms to the server · ±2 ms · 0% loss/);
    const cells = root.querySelectorAll('.online-cell-net');
    assert.equal(cells.length, 3);
    assert.match(words(cells[0]), /^28 ms Good · ±2 ms · 0% loss/);
    assert.ok(cells[1].classList.contains('online-q-poor'));
    assert.equal(cells[1].querySelectorAll('.online-bar.is-lit').length, 1);
    assert.ok(cells[2].classList.contains('is-empty'), 'an AI has no connection');
    const warning = root.querySelector('.online-net-warning');
    assert.equal(warning.hidden, false);
    assert.match(words(warning), /Unstable Ivan's connection is unstable: 210 ms with 4% loss/);
    click(warning.querySelectorAll('button').find((b) => b.textContent === 'Test again'));
    assert.equal(tests.length, 1);
    assert.ok(warning.querySelectorAll('button').some((b) => b.textContent === 'Kick'), 'the host may kick');
    // The bar: names who is not ready.
    assert.equal(ui.barStatus.textContent, 'Waiting for Ivan to be ready.');
    // The invite panel: the code, the time left.
    assert.equal(textOf(root.querySelector('.online-invite-value')), 'K7Q-2MX');
    assert.match(textOf(root.querySelector('.online-invite-time')), /1 h 42 min left/);
    // Everyone ready: the start check asks first, and "Wait" sends nothing.
    ui.state.slots[1].ready = true;
    ui.renderLobby();
    assert.equal(ui.startBtn.disabled, false);
    const started = ui.startGame();
    await settle();
    const ask = document.body.querySelector('dialog');
    assert.match(words(ask), /Poor connection: Ivan \(210 ms with 4% loss\)/);
    click(ask.querySelectorAll('button').find((b) => b.textContent === 'Start anyway'));
    await started;
    assert.deepEqual(sent.at(-1), { t: 'start' });
    // Fine connections: no warning, no question.
    players.set(3, net(3, 40));
    ui.renderConnections();
    assert.equal(warning.hidden, true);
    await ui.startGame();
    assert.equal(sent.filter((m) => m.t === 'start').length, 2);
  } finally {
    uninstallDom();
  }
});

// The friends screen (js/friends-ui.js): what it shows for a friends list
// document (docs/accounts-api.md 5.11) and what its buttons do, with a fake
// store and the fake DOM. No server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, uninstallDom, click, settle, textOf, typeInto, submit } from './dom-fixtures.mjs';
import { agoText, friendStatus, friendsView } from '../js/friends-ui.js';
import { Emitter } from '../js/netquality.js';

const NOW = 10_000_000_000;
const MIN = 60_000;
const lobby = (id, extra = {}) => ({ id, name: 'Friday night 2v2', state: 'lobby', players: 3, maxPlayers: 4, map: 'Ore Lord', mode: 'classic', locked: false, version: '0.17.0', spectators: 0, maxSpectators: 2, joinable: true, spectatable: true, ...extra });
const DOC = {
  friends: [
    { username: 'kara', displayName: 'Kara', avatarColor: '#59cc66', since: 0, status: 'game', session: { ...lobby('g1'), name: 'Clan practice', state: 'game', map: 'Coastal Ridge', mode: null, playingMs: 760_000, joinable: false, spectatable: true } },
    { username: 'ivan', displayName: 'Ivan', avatarColor: '#e64033', since: 0, status: 'lobby', session: lobby('l1') },
    { username: 'mo', displayName: 'Mo', avatarColor: '#f2cc40', since: 0, status: 'online' },
    { username: 'lena', displayName: 'Lena', avatarColor: '#4dc8d8', since: 0, status: 'away', awayMs: 12 * MIN },
    { username: 'tomas', displayName: 'Tomas', avatarColor: '#a07cf0', since: 0, status: 'offline', lastSeenAt: NOW - 2 * 24 * 60 * MIN },
    { username: 'yara', displayName: 'Yara', avatarColor: '#f08a3c', since: 0, status: 'offline', lastSeenAt: null },
  ],
  incoming: [{ username: 'viper', displayName: 'Viper', avatarColor: '#c8402a', createdAt: NOW - 5 * MIN }],
  outgoing: [{ username: 'nadia', displayName: 'Nadia', avatarColor: '#2a6fc8', createdAt: NOW - 3 * 60 * MIN }],
  blocked: [{ username: 'pest', displayName: 'Pest', avatarColor: '#3a9a3a', createdAt: 0 }],
  invites: [{ username: 'kara', session: 'l9', code: 'K7Q2MX', name: 'Sunday 1v1', players: 1, maxPlayers: 2, map: null, locked: true, createdAt: NOW - MIN, expiresAt: NOW + 60 * MIN }],
  sentInvites: [{ username: 'lena', session: 'mine', code: 'ABC234', name: 'Mine', players: 1, maxPlayers: 4, map: null, locked: false, createdAt: NOW - 20_000, expiresAt: NOW + MIN }],
  privacy: { showOnline: true, friendsJoin: true, allowSpectate: false },
  limits: { friends: 200, outgoing: 50, blocked: 500 },
};

test('ago and status lines', () => {
  assert.equal(agoText(10_000), 'just now');
  assert.equal(agoText(5 * MIN), '5 minutes ago');
  assert.equal(agoText(60 * MIN), '1 hour ago');
  assert.equal(agoText(2 * 24 * 60 * MIN), '2 days ago');
  assert.equal(agoText(21 * 24 * 60 * MIN), '3 weeks ago');
  const [kara, ivan, mo, lena, tomas, yara] = DOC.friends.map((f) => friendStatus(f, NOW));
  assert.deepEqual(kara, { text: 'In game: Clan practice · Co-op · Coastal Ridge · 12:40', led: 'on', word: 'In game' });
  assert.deepEqual(ivan, { text: 'In lobby: Friday night 2v2 (3/4)', led: 'ok', word: 'In lobby' });
  assert.deepEqual([mo.text, lena.text, lena.led], ['In the main menu', 'Away for 12 minutes', 'warn']);
  assert.deepEqual([tomas.text, yara.text, yara.word], ['Last played 2 days ago', 'Offline', 'Offline']);
  assert.equal(friendStatus({ status: 'game', session: null }).text, 'In a game', 'a private game is not named');
});

test('friends view: groups by status, actions by what the session allows, requests, invites, blocked', () => {
  const v = friendsView(DOC, { now: NOW, version: '0.17.0' });
  assert.equal(v.summary, '4 online · 1 in a game');
  assert.deepEqual(
    v.groups.map((g) => [g.title, g.people.map((p) => p.name)]),
    [
      ['In a game', ['Kara']],
      ['Online', ['Ivan', 'Lena', 'Mo']],
      ['Offline', ['Tomas', 'Yara']],
    ],
  );
  const by = Object.fromEntries(v.groups.flatMap((g) => g.people).map((p) => [p.name, p]));
  assert.deepEqual(by.Kara.actions.map((a) => a.id), ['spectate']);
  assert.deepEqual(by.Ivan.actions.map((a) => [a.id, a.primary]), [['join', true], ['spectate', false]]);
  assert.deepEqual(by.Mo.actions, [], 'no lobby, nothing to invite to');
  assert.equal(by.Tomas.dim, true);
  assert.equal(by.Kara.initial, 'K');
  assert.deepEqual(v.incoming, [{ username: 'viper', name: 'Viper', note: 'Asked 5 minutes ago' }]);
  assert.equal(v.outgoing[0].note, 'Sent 3 hours ago, waiting for an answer');
  assert.deepEqual(v.invites[0], { username: 'kara', session: 'l9', code: 'K7Q2MX', text: 'kara invites you to Sunday 1v1', sub: '1/2 players · Generated · code K7Q-2MX', locked: true });
  assert.deepEqual(v.blocked, [{ username: 'pest', name: 'Pest' }]);
  // In a lobby: Invite for friends around who are not in it; Sent for those invited already.
  const inLobby = friendsView(DOC, { now: NOW, lobby: { session: 'mine' } });
  const p = Object.fromEntries(inLobby.groups.flatMap((g) => g.people).map((x) => [x.name, x]));
  assert.deepEqual(p.Mo.actions, [{ id: 'invite', label: 'Invite', primary: true, disabled: false, title: '' }]);
  assert.deepEqual([p.Lena.actions[0].label, p.Lena.actions[0].disabled, p.Lena.actions[0].title], ['Sent', true, 'Invited just now']);
  assert.ok(!p.Tomas.actions.length, 'offline friends are not invited');
  // Another version: Join is there but off, with the reason.
  const other = friendsView(DOC, { now: NOW, version: '0.18.0' });
  const ivan = other.groups[1].people.find((x) => x.name === 'Ivan');
  assert.deepEqual([ivan.actions[0].disabled, ivan.actions[0].title], [true, 'Needs game version 0.17.0']);
  // Search and the empty states.
  assert.deepEqual(friendsView(DOC, { query: 'LE' }).groups.flatMap((g) => g.people.map((x) => x.name)), ['Lena']);
  assert.equal(friendsView(DOC, { query: 'zz' }).empty, 'No friend matches.');
  assert.match(friendsView({ friends: [] }).empty, /^Add a friend by username/);
});

/** A FriendsStore stand-in: the document, and every action recorded. */
class FakeStore extends Emitter {
  constructor(doc) {
    super();
    this.doc = doc;
    this.calls = [];
    for (const name of ['request', 'accept', 'ignore', 'withdraw', 'remove', 'block', 'unblock', 'invite', 'dismissInvite']) {
      this[name] = async (...args) => {
        this.calls.push([name, ...args]);
        return name === 'request' ? { request: {} } : {};
      };
    }
  }
  start() {
    this.running = true;
    this.emit('change', this.doc);
  }
  stop() {
    this.running = false;
  }
}

async function screen({ user = { username: 'Commander' }, lobbyRef = null } = {}) {
  const doc = installDom();
  const root = doc.createElement('section');
  root.hidden = true;
  doc.body.append(root);
  const { FriendsScreen } = await import('../js/friends-ui.js');
  const store = new FakeStore(DOC);
  const settings = { showOnline: true, friendsJoin: true, allowSpectate: false };
  const joined = [];
  const account = { user, api: {}, onChange: () => () => {} };
  const s = new FriendsScreen(root, {
    account,
    store,
    now: () => NOW,
    version: '0.17.0',
    registry: { get: (g, k) => settings[k], set: (g, k, v) => (settings[k] = v) },
    onJoin: (session, o) => joined.push([session.id, o.spectate]),
    lobby: () => lobbyRef,
    clipboard: { writeText: async () => {} },
  });
  return { doc, root, s, store, settings, joined };
}

test('friends screen: the list as drawn, Join and Spectate, requests, privacy, block with a question', async () => {
  const { root, s, store, settings, joined } = await screen();
  try {
    s.open();
    assert.equal(root.hidden, false);
    assert.equal(store.running, true, 'polls while shown');
    assert.equal(textOf(root.querySelector('.friends-summary')), '4 online · 1 in a game');
    assert.deepEqual([...root.querySelectorAll('.friends-group-title')].map(textOf), ['In a game', 'Online', 'Offline']);
    const rows = root.querySelectorAll('.friends-person');
    assert.equal(rows.length, 6);
    assert.equal(rows[1].getAttribute('aria-label'), 'Ivan, In lobby: In lobby: Friday night 2v2 (3/4)');
    // Join closes the screen and hands the session to the online screen.
    click([...rows[1].querySelectorAll('button')].find((b) => b.textContent === 'Join'));
    assert.deepEqual(joined, [['l1', false]]);
    assert.equal(root.hidden, true);
    assert.equal(store.running, false);
    s.open();
    click([...root.querySelectorAll('.friends-person')[0].querySelectorAll('button')].find((b) => b.textContent === 'Spectate'));
    assert.deepEqual(joined.at(-1), ['g1', true]);
    s.open();
    // Requests: Accept and Ignore; a sent one can be withdrawn.
    click([...root.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Accept Viper'));
    click([...root.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Withdraw the request to Nadia'));
    await settle();
    assert.deepEqual(store.calls.slice(-2), [['accept', 'viper'], ['withdraw', 'nadia']]);
    // Add a friend by username.
    const form = root.querySelector('.friends-add');
    typeInto(form.querySelector('input'), ' Ivan2 ');
    submit(form);
    await settle();
    assert.deepEqual(store.calls.at(-1), ['request', 'Ivan2']);
    assert.equal(textOf(root.querySelector('.friends-status')), 'Request sent to Ivan2.');
    // Invites from friends: Join with the code; the lobby asks for its password itself.
    assert.match(textOf(root.querySelector('.friends-card:not([hidden]) .friends-request-name')), /kara invites you to Sunday 1v1/);
    // Privacy: the switches are the social settings.
    const allow = [...root.querySelectorAll('.ui-row-switch input')].at(2);
    allow.checked = true;
    allow.dispatchEvent(new (await import('./dom-fixtures.mjs')).FakeEvent('change'));
    assert.equal(settings.allowSpectate, true);
    // Unblock.
    click([...root.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Unblock Pest'));
    await settle();
    assert.deepEqual(store.calls.at(-1), ['unblock', 'pest']);
    // More: Block asks first; Cancel does nothing.
    const more = [...root.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'More for Mo');
    click(more);
    assert.equal(more.getAttribute('aria-expanded'), 'false', 'the old button; the list was drawn again');
    const block = [...root.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent === 'Block');
    click(block);
    await settle();
    const ask = document.body.querySelector('dialog');
    assert.match(textOf(ask), /Block Mo\?/);
    click([...ask.querySelectorAll('button')].find((b) => b.textContent === 'Cancel'));
    await settle();
    assert.ok(!store.calls.some(([name]) => name === 'block'));
    // Esc closes the screen, but not from inside a select list.
    s.onKey({ key: 'Escape', defaultPrevented: false, target: { closest: (sel) => (sel.includes('listbox') ? {} : null) }, preventDefault() {} });
    assert.equal(root.hidden, false);
    s.onKey({ key: 'Escape', defaultPrevented: false, target: root, preventDefault() {} });
    assert.equal(root.hidden, true);
  } finally {
    uninstallDom();
  }
});

test('friends screen: Invite while in a lobby; signed out it asks to sign in', async () => {
  let ctx = await screen({ lobbyRef: { session: 'mine' } });
  try {
    ctx.s.open();
    const invite = [...ctx.root.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Invite: Mo');
    click(invite);
    await settle();
    assert.deepEqual(ctx.store.calls.at(-1), ['invite', 'mo', 'mine']);
    const sent = [...ctx.root.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Sent: Lena');
    assert.equal(sent.disabled, true);
  } finally {
    uninstallDom();
  }
  ctx = await screen({ user: null });
  try {
    ctx.s.open();
    assert.match(textOf(ctx.root), /Friends need a WebRA account/);
    assert.equal(ctx.store.running, undefined, 'nothing polled while signed out');
  } finally {
    uninstallDom();
  }
});

test('mountFriends: a game start closes the screen and keeps the lobby hidden; the heartbeat restarts on a new sign-in; one store polls', async () => {
  const doc = installDom();
  try {
    const { mountFriends, sharedFriendsStore, useFriendsStore } = await import('../js/friends-ui.js');
    const listeners = [];
    const account = { user: { username: 'Commander' }, api: {}, onChange: (fn) => listeners.push(fn) };
    const starts = [];
    const presence = { start: () => starts.push(1), stop() {} };
    const root = doc.createElement('section');
    const menu = doc.createElement('section');
    const online = doc.createElement('section');
    menu.hidden = true;
    root.hidden = true;
    doc.body.append(root, menu, online);
    const f = mountFriends({ entry: null, root, account, registry: { get: () => true, set() {} }, cover: [menu, online], presence: () => presence });
    // The shared store must not reach the network in this test.
    const store = sharedFriendsStore(account.api);
    store.client = { list: async () => DOC };
    store.timers = { setTimeout: () => 1, clearTimeout() {} };
    f.open();
    assert.deepEqual([online.hidden, menu.hidden, root.hidden], [true, true, false]);
    f.close();
    assert.equal(online.hidden, false, 'Back shows the lobby again');
    assert.equal(menu.hidden, true, 'what was hidden before stays hidden');
    f.open();
    f.close({ restore: false });
    assert.deepEqual([online.hidden, root.hidden], [true, true], 'a game started: the lobby stays hidden behind it');
    // The heartbeat: started at sign-in, and again on every account change while signed in (a 401 may have stopped it).
    assert.equal(starts.length, 1);
    for (const fn of listeners) fn(account);
    assert.equal(starts.length, 2);
    // One store: the online screens and the friends screen both use it; it polls until the last one is done.
    const a = useFriendsStore(store);
    const b = useFriendsStore(store);
    a();
    a();
    assert.equal(store.running, true, 'the other screen still shows the list');
    b();
    assert.equal(store.running, false);
  } finally {
    uninstallDom();
  }
});

test('mountFriends: a request or invite hint shows a toast while the screen is closed; an open screen loads instead', async () => {
  const doc = installDom();
  try {
    const { mountFriends, hintToastText } = await import('../js/friends-ui.js');
    const { MockAccountServer } = await import('./account-mock.mjs');
    const server = new MockAccountServer();
    const me = server.addUser({ username: 'Commander', password: 'a long passphrase' });
    server.signIn(me);
    const realtime = server.realtime.client();
    realtime.allow();
    let lists = 0;
    const api = {};
    const account = { user: { username: 'Commander' }, api, realtime, onChange() {} };
    const toasts = [];
    const root = doc.createElement('section');
    root.hidden = true;
    doc.body.append(root);
    const f = mountFriends({ entry: null, root, account, registry: { get: () => true, set() {} }, presence: () => ({ start() {}, stop() {} }), toast: (t) => toasts.push(t) });
    // The shared store must not reach the network in this test.
    const { sharedFriendsStore } = await import('../js/friends-ui.js');
    const store = sharedFriendsStore(api, realtime);
    store.client = { list: async () => (lists++, DOC) };
    store.timers = { setTimeout: () => 1, clearTimeout() {} };

    server.realtime.emit(me.id, { topic: 'friends', kind: 'request', data: { username: 'Ivan' } });
    assert.deepEqual(toasts, ['Ivan sent you a friend request. Open Friends to answer.']);
    server.realtime.emit(me.id, { topic: 'friends', kind: 'presence', data: { username: 'Kara' } });
    assert.equal(toasts.length, 1, 'presence is no news worth a toast');

    f.open();
    await new Promise((r) => setTimeout(r, 0));
    const before = lists;
    server.realtime.emit(me.id, { topic: 'friends', kind: 'invite', data: { username: 'Kara', session: 'b'.repeat(64) } });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(toasts.length, 1, 'the open screen shows it in its lists');
    assert.equal(lists, before + 1, 'and loads the list');
    f.close();
    server.realtime.emit(me.id, { topic: 'friends', kind: 'invite', data: { username: 'Kara', session: 'b'.repeat(64) } });
    assert.equal(toasts.at(-1), 'Kara invites you to a lobby. Open Friends to join.');
    assert.equal(hintToastText({ kind: 'request', data: null }), null, 'own echo (no name): no toast');
  } finally {
    uninstallDom();
  }
});

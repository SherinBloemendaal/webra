// Launch settings (docs/launch.md): `gameRequiresAccount` off, so anyone
// plays a skirmish without an account, while `onlineRequiresAccount` stays
// on. A signed-out visitor's page asks the server only for the public
// documents (/api/auth/me, /api/site): no account-only endpoint (friends,
// presence, replays, settings, realtime) is called and so nothing answers
// 401; the online screen and the friends entry show the way to sign in.
// The play gate's side is in apps/server/test/playgate.test.mjs ("setting
// off"), a skirmish starting without any account in startgate.test.mjs.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, uninstallDom, settle, textOf, memoryStorage } from './dom-fixtures.mjs';
import { MockAccountServer } from './account-mock.mjs';
import { AccountApi } from '../js/account/api.js';
import { AccountSession, accountState } from '../js/account/session.js';
import { mountAccountEntry } from '../js/account/ui.js';
import { mountFriends } from '../js/friends-ui.js';
import { uploadsWanted } from '../js/account/replays.js';
import { createRegistry } from '../js/registry.js';

let doc;
beforeEach(() => {
  doc = installDom();
});
afterEach(() => uninstallDom());

/** The launch site: no approval, no verification, the game open to all, online play with an account. */
function launchServer() {
  const server = new MockAccountServer();
  server.site.registration.approvalRequired = false;
  server.site.registration.emailVerification = false;
  server.site.gameRequiresAccount = false;
  server.site.onlineRequiresAccount = true;
  server.site.motd = 'Welcome to the launch!';
  return server;
}

/** A realtime channel stand-in that records whether it was started. */
function fakeRealtime() {
  return { started: 0, stopped: 0, start() { this.started++; }, stop() { this.stopped++; }, subscribe: () => () => {}, on: () => () => {} };
}

const accountCalls = (server) => server.requests.map((r) => r.url).filter((u) => /^\/api\/(account|admin)/.test(u));

test('signed out with the game open: only public documents are read, no realtime, the start screen offers sign-in and shows the motd', async () => {
  const server = launchServer();
  const realtime = fakeRealtime();
  const registry = createRegistry({ storage: null });
  const s = new AccountSession({ api: new AccountApi({ fetchImpl: server.fetch }), registry, storage: memoryStorage(), realtime });
  const host = doc.createElement('aside');
  doc.body.append(host);
  mountAccountEntry(host, s);
  await s.refresh();
  await settle(20);
  assert.equal(s.user, null);
  assert.equal(s.site.gameRequiresAccount, false);
  assert.equal(s.canPlayOnline, false, 'online play still needs an account');
  assert.deepEqual(accountCalls(server), [], 'no account-only endpoint, so no 401s');
  assert.ok(server.requests.every((r) => r.url === '/api/auth/me' || r.url === '/api/site'), server.requests.map((r) => r.url).join(', '));
  assert.equal(realtime.started, 0, 'no realtime channel without an account');
  assert.match(textOf(host), /Welcome to the launch!/);
  assert.ok([...host.querySelectorAll('button')].some((b) => /Sign in/.test(b.textContent)));
  // The start screen's words: anyone can play skirmish, online needs an account.
  assert.match(accountState(null, s.site).text, /play online/);
});

test('signed out: the friends entry stays hidden and no presence heartbeat runs; replays are not queued for upload', async () => {
  const server = launchServer();
  const s = new AccountSession({ api: new AccountApi({ fetchImpl: server.fetch }), registry: createRegistry({ storage: null }), storage: memoryStorage(), realtime: null });
  await s.refresh();
  const entry = doc.createElement('button');
  const root = doc.createElement('div');
  doc.body.append(entry, root);
  let heartbeats = 0;
  mountFriends({ entry, root, account: s, registry: createRegistry({ storage: null }), signIn: () => null, version: '0.20.1', presence: () => ({ start: () => heartbeats++, stop() {} }) });
  await settle(20);
  assert.equal(entry.hidden, true);
  assert.equal(heartbeats, 0);
  assert.equal(uploadsWanted({ user: null, site: s.site, enabled: true }), false);
  assert.deepEqual(accountCalls(server), []);
});

test('signed out: the online screen says online play needs an account, with Sign in and Create an account', async () => {
  const server = launchServer();
  const s = new AccountSession({ api: new AccountApi({ fetchImpl: server.fetch }), registry: createRegistry({ storage: null }), storage: memoryStorage(), realtime: null });
  await s.refresh();
  const root = doc.createElement('div');
  doc.body.append(root);
  const { OnlineUI } = await import('../js/online.js');
  const ui = Object.create(OnlineUI.prototype);
  const reasons = [];
  Object.assign(ui, {
    root,
    name: 'Commander',
    ctx: { colors: Array.from({ length: 8 }, () => [1, 0, 0]), colorNames: [], version: '0.20.1', Game: {}, account: { session: s, signIn: async (reason) => (reasons.push(reason), null) }, onBack() {} },
  });
  ui.refresh = async () => {};
  try {
    ui.showBrowser();
    const prompt = root.querySelector('.online-account-prompt');
    assert.ok(prompt);
    assert.match(textOf(prompt), /Online play needs a WebRA account/);
    assert.ok(prompt.querySelector('a[href="/account/#signup"]'));
    const signIn = [...prompt.querySelectorAll('button')].find((b) => /Sign in/.test(b.textContent));
    signIn.click();
    await settle(5);
    assert.equal(reasons.length, 1);
    assert.equal(ui.friendsStore, undefined, 'no friends list polled while signed out');
    assert.deepEqual(accountCalls(server), []);
  } finally {
    ui.leaveSession();
  }
});

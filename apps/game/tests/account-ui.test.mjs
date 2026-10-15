// Accounts in the game (js/account/session.js, ui.js) on a fake DOM against
// the contract mock: the start screen entry, the sign-in dialog with only the
// methods the site allows, account states, online refusals and the settings
// conflict choice.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, uninstallDom, FakeEvent, click, settle, textOf, submit, memoryStorage } from './dom-fixtures.mjs';
import { MockAccountServer } from './account-mock.mjs';
import { AccountApi } from '../js/account/api.js';
import { AccountSession, accountState, signInMethods } from '../js/account/session.js';
import { askConflict, mountAccountEntry, onlineRefusal, openSignIn, settingLabel, valueText } from '../js/account/ui.js';
import { createRegistry } from '../js/registry.js';
import { canAutoInstall } from '../js/content/download.js';

let doc;
beforeEach(() => {
  doc = installDom();
});
afterEach(() => uninstallDom());

const byText = (root, tag, re) => [...root.querySelectorAll(tag)].find((b) => re.test(b.textContent));

function session(server, registry = createRegistry({ storage: null })) {
  return new AccountSession({ api: new AccountApi({ fetchImpl: server.fetch }), registry, storage: memoryStorage() });
}

test('account states and sign-in methods follow the account and the site', () => {
  assert.equal(accountState(null).kind, 'signed-out');
  assert.match(accountState({ status: 'pending_approval' }).text, /closed beta/);
  assert.match(accountState({ status: 'pending_email' }).label, /Verify/);
  assert.match(accountState({ status: 'banned', ban: { reason: 'Cheating' } }).text, /Reason: Cheating/);
  // The play gate: the copy says the game waits, unless the site lets everyone play.
  assert.match(accountState({ status: 'pending_approval' }).text, /game opens for you once it is approved/);
  assert.match(accountState({ status: 'pending_approval' }, { gameRequiresAccount: false }).text, /play skirmish/);
  assert.match(accountState(null).text, /^Sign in to play,/);
  assert.match(accountState(null, { gameRequiresAccount: false }).text, /play online/);
  assert.match(accountState({ status: 'banned' }).text, /cannot play/);
  const site = { login: { password: true, email: false, discord: false, passkey: true }, registration: { open: false } };
  assert.deepEqual(signInMethods(site, { passkeys: false }), { password: true, passkey: false, discord: false, email: false, signup: false });
  assert.equal(signInMethods(site, { passkeys: true }).passkey, true);
  assert.equal(onlineRefusal('account_required').signIn, true);
  assert.equal(onlineRefusal('banned', 'Banned until Friday').text, 'Banned until Friday');
  assert.equal(onlineRefusal('ip_banned').signIn, false);
  assert.equal(onlineRefusal('kicked'), null);
  assert.equal(settingLabel('audio', 'master'), 'Sound: Master volume');
  assert.equal(valueText('game', 'healthBars', 'all'), 'All units and buildings');
  assert.equal(valueText('audio', 'enabled', false), 'off');
});

test('start screen entry: Sign in, the dialog signs in, then the name, state, motd and sync show', async () => {
  const server = new MockAccountServer();
  server.site.motd = 'Closed beta: welcome!\nReport bugs on GitHub.';
  server.addUser({ username: 'Tanya', password: 'a long passphrase', status: 'pending_approval' });
  const s = session(server);
  const host = doc.createElement('aside');
  doc.body.append(host);
  mountAccountEntry(host, s);
  await s.refresh();
  assert.match(textOf(host), /Closed beta: welcome!/);
  const signIn = byText(host, 'button', /Sign in/);
  assert.equal(signIn.disabled, false);
  const result = openSignIn(s);
  await settle();
  const dialog = doc.body.querySelector('[role="dialog"]');
  assert.equal(byText(dialog, 'button', /passkey/i), undefined, 'no passkeys in this browser');
  assert.equal(byText(dialog, 'button', /Discord/), undefined, 'Discord not configured');
  assert.ok(dialog.querySelector('a[href="/account/#signup"]'), 'sign up lives on the account page');
  dialog.querySelector('#account-login').value = 'Tanya';
  dialog.querySelector('#account-password').value = 'nope nope nope';
  submit(dialog.querySelector('form'));
  await settle(10);
  assert.match(textOf(dialog.querySelector('[role="alert"]')), /Wrong login or password/);
  dialog.querySelector('#account-password').value = 'a long passphrase';
  submit(dialog.querySelector('form'));
  const user = await result;
  await settle(20);
  assert.equal(user.username, 'Tanya');
  assert.equal(doc.body.querySelector('[role="dialog"]'), null, 'the dialog closed');
  assert.match(textOf(host), /Tanya/);
  assert.match(textOf(host), /Waiting for approval/);
  assert.match(textOf(host), /Settings synced/);
  assert.equal(server.settingsDocs.get(user.id).version, 1, 'the first sign-in uploaded this device\'s settings');
  click(byText(host, 'button', /Sign out/));
  await settle(20);
  assert.ok(byText(host, 'button', /Sign in/));
});

test('sign-in dialog: Escape closes it with nothing; Discord goes to the authorize URL with the way back', async () => {
  const server = new MockAccountServer();
  server.services.discord = true;
  const s = session(server);
  await s.refresh();
  const r = openSignIn(s);
  await settle();
  doc.body.querySelector('.account-overlay').dispatchEvent(new FakeEvent('keydown', { key: 'Escape' }));
  assert.equal(await r, null);
  const went = [];
  openSignIn(s, { navigate: (u) => went.push(u) });
  await settle();
  click(byText(doc.body.querySelector('[role="dialog"]'), 'button', /Discord/));
  await settle(10);
  assert.deepEqual(went, ['https://discord.com/oauth2/authorize?state=x']);
  const start = server.requests.find((q) => q.url === '/api/auth/discord/start');
  assert.deepEqual(JSON.parse(start.body), { mode: 'login', returnTo: '/play/' });
});

test('the one-click content install follows the account; the conflict dialog names the settings', async () => {
  const server = new MockAccountServer();
  const flagged = server.addUser({ username: 'Flag', password: 'a long passphrase', flags: ['content_autoinstall'] });
  server.signIn(flagged);
  const s = session(server);
  await s.refresh();
  assert.equal(canAutoInstall(s.user), true);
  server.site.contentRelay = false;
  await s.refresh();
  assert.equal(canAutoInstall(s.user), false, 'relay switched off');
  const choice = askConflict({ conflicts: [{ group: 'game', key: 'healthBars', local: 'all', remote: 'off' }] });
  await settle();
  const dialog = doc.body.querySelector('[role="dialog"]');
  assert.match(textOf(dialog), /Game: Health bars here: All units and buildings; account: Selected and hovered only/);
  click(byText(dialog, 'button', /Keep this device/));
  assert.equal(await choice, 'local');
  const closed = askConflict({ conflicts: [] });
  await settle();
  doc.body.querySelector('.account-overlay').dispatchEvent(new FakeEvent('keydown', { key: 'Escape' }));
  assert.equal(await closed, 'remote', 'closing keeps the account\'s values');
});

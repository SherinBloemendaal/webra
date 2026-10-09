// The account page (apps/website/assets/account.js) on a fake DOM against the
// contract mock: sign in, sign up, email and reset links, Discord returns,
// methods the site switched off, re-authentication, export and deletion.
import './play-loader.mjs';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { strayValues, installDom, uninstallDom, FakeEvent, click, check, settle, textOf, submit, typeInto } from './dom-fixtures.mjs';
import { MockAccountServer } from './account-mock.mjs';
import { AccountApi } from '../js/account/api.js';

const { mountAccountPage, parseFragment, DISCORD_ERRORS, returnTarget, discordReturn } = await import('../../website/assets/account.js');

let doc;
beforeEach(() => {
  doc = installDom();
  globalThis.URL.createObjectURL ??= () => 'blob:x';
  globalThis.URL.revokeObjectURL ??= () => {};
});
afterEach(() => uninstallDom());

async function page(server, hash = '', search = '') {
  const root = doc.createElement('div');
  doc.body.append(root);
  const replaced = [];
  const navigated = [];
  const location = { hash, pathname: '/account/', search, assign: (u) => navigated.push(u) };
  const history = { replaceState: (_s, _t, url) => replaced.push(url) };
  const view = await mountAccountPage(root, { api: new AccountApi({ fetchImpl: server.fetch }), location, history, navigate: (u) => navigated.push(u) });
  await settle(10);
  return { root, view, replaced, navigated };
}

const byText = (root, tag, re) => root.querySelectorAll(tag).find((b) => re.test(b.textContent));
const inputByLabel = (root, re) => {
  const label = root.querySelectorAll('label').find((l) => re.test(l.textContent));
  return label ? root.querySelector(`#${label.getAttribute('for')}`) : null;
};

test('fragments: verify, reset, Discord, tabs; bad tokens are caught', () => {
  assert.deepEqual(parseFragment('#verify=' + 'a'.repeat(43)), { kind: 'verify', token: 'a'.repeat(43) });
  assert.deepEqual(parseFragment('#reset=' + 'b_-'.repeat(15)), { kind: 'reset', token: 'b_-'.repeat(15) });
  assert.deepEqual(parseFragment('#reset=<script>'), { kind: 'bad-link' });
  assert.deepEqual(parseFragment('#discord=ok'), { kind: 'discord', ok: true, code: null });
  assert.deepEqual(parseFragment('#discord=error&code=no_account'), { kind: 'discord', ok: false, code: 'no_account' });
  assert.deepEqual(parseFragment('#signup'), { kind: 'signup' });
  assert.deepEqual(parseFragment(''), { kind: null });
  assert.ok(DISCORD_ERRORS.rate_limited, 'every documented Discord code has words');
});

test('account page: sign in with a password; wrong ones say so; the account sections appear', async () => {
  const server = new MockAccountServer();
  server.addUser({ username: 'Tanya', password: 'a long passphrase', email: 'tanya@example.com', emailVerified: true });
  const { root } = await page(server);
  const tabs = root.querySelectorAll('[role="tab"]').map((t) => t.textContent);
  assert.deepEqual(tabs, ['Sign in', 'Create account'], 'no forgot tab while email is unavailable');
  assert.equal(byText(root, 'button', /Discord/), undefined, 'Discord not configured: no button');
  inputByLabel(root, /Username or email/).value = 'tanya';
  inputByLabel(root, /^Password$/).value = 'wrong password';
  submit(root.querySelector('form'));
  await settle(10);
  assert.match(textOf(root.querySelector('[role="alert"]')), /Wrong login or password/);
  assert.equal(inputByLabel(root, /^Password$/).value, '', 'the password field is cleared');
  inputByLabel(root, /^Password$/).value = 'a long passphrase';
  submit(root.querySelector('form'));
  await settle(20);
  assert.match(textOf(root), /Tanya/);
  for (const title of ['Profile', 'Email', 'Password', 'Passkeys', 'Devices', 'Your data']) assert.ok(root.querySelector(`#section-${title.toLowerCase().replace(/[^a-z]+/g, '-')}`), title);
  assert.match(textOf(root), /tanya@example\.com.*Verified/);
  // Discord is not configured, so its section is left out: no "null" in its place.
  assert.deepEqual(strayValues(root), [], 'no left-out block shows as text');
});

test('account page: sign up needs the privacy notice; a new account waits for approval', async () => {
  const server = new MockAccountServer();
  const { root } = await page(server, '#signup');
  const privacyLink = root.querySelector('a[href="/privacy.html"]');
  assert.ok(privacyLink, 'the form links the privacy notice');
  inputByLabel(root, /^Username/).value = 'Boris';
  inputByLabel(root, /^Password/).value = 'a long passphrase';
  const form = root.querySelectorAll('form')[0];
  submit(form);
  await settle(5);
  assert.match(textOf(root), /Accept the privacy notice/);
  check(root.querySelector('#signup-privacy'));
  submit(form);
  await settle(20);
  const req = server.requests.find((r) => r.url === '/api/auth/signup');
  assert.equal(JSON.parse(req.body).acceptPrivacy, true);
  assert.match(textOf(root), /Waiting for approval/);
  assert.match(textOf(root), /closed beta/);
});

test('account page: no email field while the server cannot confirm addresses', async () => {
  const server = new MockAccountServer();
  const off = await page(server, '#signup');
  const emailRow = (root) => {
    const input = inputByLabel(root, /^Email/);
    let n = input;
    while (n && !n.hidden) n = n.parentNode;
    return n;
  };
  assert.ok(emailRow(off.root), 'hidden without email sending');
  off.root.remove();
  server.services.email = true;
  const on = await page(server, '#signup');
  assert.equal(emailRow(on.root), null, 'shown when email works');
});

test('account page: closed registration and switched off methods are hidden', async () => {
  const server = new MockAccountServer();
  server.site.registration.open = false;
  server.site.login.password = false;
  const { root } = await page(server, '#signup');
  assert.match(textOf(root), /Signing up is closed/);
  click(root.querySelector('#tab-signin'));
  await settle();
  assert.equal(inputByLabel(root, /Username or email/), null);
  assert.match(textOf(root), /Signing in is switched off/);
});

test('account page: email verification and password reset links, then the fragment is gone', async () => {
  const server = new MockAccountServer();
  const user = server.addUser({ username: 'Tanya', password: 'old passphrase!', status: 'pending_email', email: 't@example.com' });
  user.verifyToken = 'v'.repeat(43);
  const a = await page(server, `#verify=${'v'.repeat(43)}`);
  assert.deepEqual(a.replaced, ['/account/']);
  assert.match(textOf(a.root), /Your email is verified/);
  assert.equal(user.emailVerified, true);
  uninstallDom();
  doc = installDom();
  user.resetToken = 'r'.repeat(43);
  const b = await page(server, `#reset=${'r'.repeat(43)}`);
  const inputs = b.root.querySelectorAll('input[type="password"]');
  inputs[0].value = 'a brand new passphrase';
  inputs[1].value = 'a brand new passphrase';
  submit(b.root.querySelector('form'));
  await settle(20);
  assert.equal(user.password, 'a brand new passphrase');
  assert.match(textOf(b.root), /password is set and you are signed in/);
  uninstallDom();
  doc = installDom();
  const c = await page(server, '#discord=error&code=no_account');
  assert.match(textOf(c.root), /No WebRA account is linked to that Discord account/);
});

test('account page: export and deletion ask to confirm the sign-in again, then work', async () => {
  const server = new MockAccountServer();
  const user = server.addUser({ username: 'Tanya', password: 'a long passphrase' });
  server.signIn(user);
  server.sessions.get(server.cookie).reauthUntil = 0;
  const { root } = await page(server);
  const exportButton = byText(root, 'button', /Download my data/);
  click(exportButton);
  await settle(10);
  const dialog = doc.body.querySelector('[role="dialog"]');
  assert.match(textOf(dialog), /Confirm it is you/);
  dialog.querySelector('input[type="password"]').value = 'a long passphrase';
  submit(dialog.querySelector('form'));
  await settle(20);
  assert.match(textOf(root), /Your data is downloaded/);
  // Deleting: type the username.
  click(byText(root, 'button', /Delete my account/));
  await settle(5);
  const del = doc.body.querySelector('[role="dialog"]');
  typeInto(del.querySelector('input'), 'Tanya');
  submit(del.querySelector('form'));
  await settle(20);
  assert.equal(user.status, 'deleted');
  assert.match(textOf(root), /Your account is deleted/);
});

test('account page: devices list marks this one; signing out another device', async () => {
  const server = new MockAccountServer();
  const user = server.addUser({ username: 'Tanya', password: 'a long passphrase' });
  server.signIn(user);
  const other = [...server.sessions.keys()][0];
  server.signIn(user); // this browser
  const { root } = await page(server);
  await settle(20);
  const devices = root.querySelector('#section-devices').closest('section');
  assert.match(textOf(devices), /This device/);
  click(byText(devices, 'button', /Sign out everywhere else/));
  await settle(20);
  assert.equal(server.sessions.has(other), false);
  assert.equal(server.sessions.has(server.cookie), true);
  void FakeEvent;
});

// ---- Back to the game after signing in (the play gate) ------------------------------------------------

test('returnTo: paths on this site only; anything else goes to /play/; none stays here', () => {
  assert.equal(returnTarget(''), null);
  assert.equal(returnTarget('?x=1'), null);
  assert.equal(returnTarget('?returnTo=%2Fplay%2F'), '/play/');
  assert.equal(returnTarget('?returnTo=%2Fplay%2F%3Fjoin%3Dabc'), '/play/?join=abc');
  assert.equal(returnTarget('?returnTo=%2Fplay%2Feditor%2F'), '/play/editor/');
  for (const bad of ['https://evil.example/', '//evil.example/play/', '/\\evil.example', 'javascript:alert(1)', '/api/auth/logout', 'play/', '', '/play/\u0000', `/${'x'.repeat(250)}`]) {
    assert.equal(returnTarget(`?returnTo=${encodeURIComponent(bad)}`), '/play/', bad);
  }
  assert.equal(discordReturn(null), '/account/');
  assert.equal(discordReturn('/play/?join=abc'), '/account/?returnTo=%2Fplay%2F%3Fjoin%3Dabc');
  assert.equal(discordReturn(`/play/?map=${'a'.repeat(180)}`), '/account/?returnTo=%2Fplay%2F', 'too long for the server: the game start');
});

test('returnTo: a password sign-in of an account that may play goes back to the game', async () => {
  const server = new MockAccountServer();
  server.addUser({ username: 'Tanya', password: 'a long passphrase' });
  const { root, navigated } = await page(server, '', '?returnTo=%2Fplay%2F%3Fjoin%3Dabc');
  assert.match(textOf(root), /Sign in to play\./);
  inputByLabel(root, /Username or email/).value = 'tanya';
  inputByLabel(root, /^Password$/).value = 'a long passphrase';
  submit(root.querySelector('form'));
  await settle(20);
  assert.deepEqual(navigated, ['/play/?join=abc']);
});

test('returnTo: a pending account stays and reads why the game is closed; no Play button', async () => {
  const server = new MockAccountServer();
  server.addUser({ username: 'Waiting', password: 'a long passphrase', status: 'pending_approval' });
  const { root, navigated } = await page(server, '', '?returnTo=%2Fplay%2F');
  inputByLabel(root, /Username or email/).value = 'Waiting';
  inputByLabel(root, /^Password$/).value = 'a long passphrase';
  submit(root.querySelector('form'));
  await settle(20);
  assert.deepEqual(navigated, []);
  assert.match(textOf(root), /Waiting for approval/);
  assert.match(textOf(root), /The game opens for you once it is approved/);
  assert.equal(root.querySelector('a.btn-play'), null);
});

test('returnTo: sign up of an account that is active at once goes to the game; Discord carries the target', async () => {
  const server = new MockAccountServer();
  server.site.registration.approvalRequired = false;
  const { root, navigated } = await page(server, '#signup', '?returnTo=%2Fplay%2F');
  inputByLabel(root, /^Username/).value = 'Boris';
  inputByLabel(root, /^Password/).value = 'a long passphrase';
  check(root.querySelector('#signup-privacy'));
  submit(root.querySelectorAll('form')[0]);
  await settle(20);
  assert.deepEqual(navigated, ['/play/']);

  uninstallDom();
  doc = installDom();
  const server2 = new MockAccountServer();
  server2.services.discord = true;
  const d = await page(server2, '', '?returnTo=%2Fplay%2F');
  click(byText(d.root, 'button', /Sign in with Discord/));
  await settle(10);
  const start = server2.requests.find((r) => r.url === '/api/auth/discord/start');
  assert.equal(JSON.parse(start.body).returnTo, '/account/?returnTo=%2Fplay%2F');
});

test('returnTo: back from Discord signed in goes on to the game', async () => {
  const server = new MockAccountServer();
  const u = server.addUser({ username: 'Discordian' });
  server.signIn(u);
  const { navigated } = await page(server, '#discord=ok', '?returnTo=%2Fplay%2F');
  assert.deepEqual(navigated, ['/play/']);
});

test('account page: a clear Play button for accounts that may play (to the target, else /play/)', async () => {
  const server = new MockAccountServer();
  const u = server.addUser({ username: 'Player' });
  server.signIn(u);
  const a = await page(server);
  assert.equal(a.root.querySelector('a.btn-play').getAttribute('href'), '/play/');
  assert.deepEqual(a.navigated, [], 'no automatic redirect when the page is opened');
  a.root.remove();
  const b = await page(server, '', '?returnTo=%2Fplay%2Feditor%2F');
  assert.equal(b.root.querySelector('a.btn-play').getAttribute('href'), '/play/editor/');
  assert.deepEqual(b.navigated, []);
});

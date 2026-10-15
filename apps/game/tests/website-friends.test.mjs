// The website's 0.17 parts: the friends section and the sign-in methods of
// the account page (against the contract mock), the invite card a play
// gate link shows, the invite code helpers ("Join with a code", /join/),
// the home page's beta badge, the changelog tags, and the static pages
// (one navigation, no style attributes, no native selects).
import './play-loader.mjs';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { installDom, uninstallDom, click, check, settle, textOf, submit, strayValues, typeInto, FakeEvent } from './dom-fixtures.mjs';
import { MockAccountServer } from './account-mock.mjs';
import { AccountApi } from '../js/account/api.js';

const { mountAccountPage } = await import('../../website/assets/account.js');
const { friendStatus, groupFriends, friendsSummary, socialSettings, spanText, clockText, SOCIAL_SETTING_DEFAULTS: SOCIAL_DEFAULTS, FriendsClient } = await import('../../website/assets/friends.js');
const { normalizeInviteCode, formatInviteCode, invitePath, typedInviteCode, inviteInPath, lookupInvite, inviteSummary, INVITE_MESSAGES } = await import('../../website/assets/invite.js');
const { betaBadge, releaseTag } = await import('../../website/assets/site-data.js');
const { openDialog, selectField } = await import('../../website/assets/ui.js');

let doc;
beforeEach(() => {
  doc = installDom();
});
afterEach(() => uninstallDom());

/** Timers that never fire: the friends list polls, the tests refresh by hand. */
const quietTimers = { setTimeout: () => 1, clearTimeout() {} };

async function page(server, search = '') {
  const root = doc.createElement('div');
  doc.body.append(root);
  const navigated = [];
  const location = { hash: '', pathname: '/account/', search, assign: (u) => navigated.push(u) };
  const view = await mountAccountPage(root, { api: new AccountApi({ fetchImpl: server.fetch }), location, history: { replaceState() {} }, navigate: (u) => navigated.push(u), storage: null, timers: quietTimers });
  await settle(20);
  return { root, view, navigated };
}

const byLabel = (root, tag, label) => [...root.querySelectorAll(tag)].find((e) => e.getAttribute('aria-label') === label) ?? null;
const byText = (root, tag, re) => [...root.querySelectorAll(tag)].find((b) => re.test(b.textContent));
const inputByLabel = (root, re) => {
  const label = [...root.querySelectorAll('label')].find((l) => re.test(l.textContent));
  return label ? root.querySelector(`#${label.getAttribute('for')}`) : null;
};
const sectionOf = (root, title) => root.querySelector(`#section-${title.toLowerCase().replace(/[^a-z]+/g, '-')}`).closest('section');

// ---- Helpers --------------------------------------------------------------------------------------

test('friends helpers: statuses in words with a lamp and a group; groups, search and the summary', () => {
  const now = 1_000_000_000;
  assert.deepEqual(friendStatus({ status: 'game', session: { name: 'Friday 2v2', map: { name: 'Coastal Ridge' }, playingMs: 760_000 } }), { text: 'In a game: Friday 2v2 · Coastal Ridge · 12:40', led: 'on', group: 'game' });
  assert.deepEqual(friendStatus({ status: 'lobby', session: { name: 'Friday 2v2', players: 3, maxPlayers: 4 } }), { text: 'In lobby: Friday 2v2 (3/4)', led: 'ok', group: 'lobby' });
  assert.equal(friendStatus({ status: 'lobby' }).text, 'In a lobby', 'a private lobby is not named');
  assert.equal(friendStatus({ status: 'online' }).text, 'In the main menu');
  assert.deepEqual(friendStatus({ status: 'away', awayMs: 12 * 60_000 }), { text: 'Away for 12 minutes', led: 'warn', group: 'online' });
  assert.equal(friendStatus({ status: 'offline', lastSeenAt: now - 2 * 86_400_000 }, now).text, 'Last seen 2 days ago');
  assert.equal(friendStatus({ status: 'offline', lastSeenAt: null }, now).text, 'Offline', 'a hidden status has no time');
  assert.equal(spanText(30_000), '1 minute');
  assert.equal(spanText(3 * 3_600_000), '3 hours');
  assert.equal(clockText(3_725_000), '1:02:05');
  const friends = [
    { username: 'Tomas', status: 'offline' },
    { username: 'Kara', status: 'game' },
    { username: 'Mo', status: 'online' },
    { username: 'Ivan', status: 'lobby' },
    { username: 'Lena', displayName: 'Lena K', status: 'away' },
  ];
  assert.deepEqual(groupFriends(friends).map((g) => [g.title, g.people.map((p) => p.friend.username)]), [
    ['In a game', ['Kara']],
    ['In a lobby', ['Ivan']],
    ['Online', ['Lena', 'Mo']],
    ['Offline', ['Tomas']],
  ]);
  assert.deepEqual(groupFriends(friends, 'na k').map((g) => g.people.map((p) => p.friend.username)), [['Lena']], 'search matches the display name too');
  assert.equal(friendsSummary(friends), '3 online · 1 in a game');
  assert.deepEqual(socialSettings({ social: { showOnline: false, friendsJoin: 'yes' } }), { ...SOCIAL_DEFAULTS, showOnline: false });
  assert.deepEqual(socialSettings(null), SOCIAL_DEFAULTS);
  assert.deepEqual(SOCIAL_DEFAULTS, { showOnline: true, friendsJoin: true, allowSpectate: false });
  assert.equal(typeof new FriendsClient().list, 'function', "the game's client");
});

test('invite codes: typed, pasted and linked codes; the dash fills in; game links carry the code', () => {
  assert.equal(normalizeInviteCode('k7q-2mx'), 'K7Q2MX');
  assert.equal(normalizeInviteCode(' K7Q 2MX '), 'K7Q2MX');
  assert.equal(normalizeInviteCode('https://webra.sherin.dev/join/K7Q-2MX'), 'K7Q2MX');
  assert.equal(normalizeInviteCode('/play/?invite=K7Q-2MX'), 'K7Q2MX');
  assert.equal(normalizeInviteCode('K0Q2MX'), null, 'no 0, O, 1, I or L');
  assert.equal(normalizeInviteCode('K7Q2M'), null);
  assert.equal(formatInviteCode('K7Q2MX'), 'K7Q-2MX');
  assert.equal(invitePath('K7Q2MX'), '/join/K7Q-2MX');
  assert.equal(typedInviteCode('k7'), 'K7');
  assert.equal(typedInviteCode('k7q2'), 'K7Q-2');
  assert.equal(typedInviteCode('k7q2mxzz'), 'K7Q-2MX', 'at most six characters');
  assert.equal(typedInviteCode('k0o1'), 'K', 'characters outside the alphabet are dropped');
  assert.equal(typedInviteCode('https://x.test/join/k7q-2mx'), 'K7Q-2MX', 'a pasted link becomes its code');
  assert.equal(inviteInPath('/play/?invite=K7Q-2MX'), 'K7Q2MX');
  assert.equal(inviteInPath('/play/?join=abc'), null);
  assert.equal(inviteInPath('/account/?invite=K7Q-2MX'), null, 'only game links');
  assert.equal(inviteInPath(null), null);
  assert.equal(inviteSummary({ host: 'Kara', map: { name: 'Coastal Ridge' }, players: 3, maxPlayers: 4, locked: true }), 'Hosted by Kara · Coastal Ridge · 3 of 4 players · password');
});

test('invite codes: the lookup says unknown, expired, full or offline in words; never throws', async () => {
  const answers = { K7Q2MX: [200, { invite: { session: 's1', name: 'Friday', players: 4, maxPlayers: 4, spectators: 0, maxSpectators: 2 } }], AAAAAA: [404, {}], BBBBBB: [410, {}], CCCCCC: [429, {}] };
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    const code = url.split('/').pop().replace('-', '');
    if (code === 'DDDDDD') throw new TypeError('Failed to fetch');
    const [status, body] = answers[code];
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  const ok = await lookupInvite('k7q2mx', { fetchImpl });
  assert.equal(seen[0], '/api/invite/K7Q-2MX');
  assert.equal(ok.ok, true);
  assert.equal(ok.full, true);
  assert.equal(ok.canSpectate, true);
  assert.equal(ok.message, INVITE_MESSAGES.full);
  assert.equal(ok.invite.code, 'K7Q-2MX');
  assert.deepEqual(await lookupInvite('AAA-AAA', { fetchImpl }), { ok: false, reason: 'unknown', message: INVITE_MESSAGES.unknown });
  assert.equal((await lookupInvite('BBBBBB', { fetchImpl })).reason, 'expired');
  assert.equal((await lookupInvite('CCCCCC', { fetchImpl })).reason, 'rate_limited');
  assert.equal((await lookupInvite('DDDDDD', { fetchImpl })).reason, 'offline');
  assert.equal((await lookupInvite('nope', { fetchImpl })).reason, 'invalid');
  assert.equal(seen.length, 5, 'an invalid code is never sent');
});

test('home: the beta badge and the sign-up buttons follow the site settings and the version', () => {
  assert.deepEqual(betaBadge({ registration: { open: true, approvalRequired: true } }, { version: '0.17.0' }), {
    text: 'Closed beta · v0.17',
    kind: 'closed',
    signup: 'Request access',
    note: 'Sign up with a password, a passkey or Discord. An admin approves new accounts during the beta.',
  });
  assert.equal(betaBadge({ registration: { open: true, approvalRequired: false } }, null).text, 'Open beta');
  assert.equal(betaBadge({ registration: { open: true, approvalRequired: false } }, null).signup, 'Create account');
  const closed = betaBadge({ registration: { open: false } }, { version: '1.2.3' });
  assert.equal(closed.text, 'Sign-ups closed · v1.2');
  assert.equal(closed.signup, null, 'the buttons lead to the sign-in instead');
  assert.deepEqual(betaBadge(null, null), { text: null, kind: 'open', signup: 'Create account', note: null }, 'nothing known: no badge');
});

test('changelog: groups are tagged New and Fixed like the release notes board', () => {
  assert.deepEqual(releaseTag('features', 'Features'), { text: 'New', kind: 'new' });
  assert.deepEqual(releaseTag('fixes', 'Bug Fixes'), { text: 'Fixed', kind: 'fixed' });
  assert.deepEqual(releaseTag('breaking-changes', 'BREAKING CHANGES'), { text: 'Breaking', kind: 'breaking' });
  assert.deepEqual(releaseTag('other', 'Changes'), { text: 'Changes', kind: 'other' });
});

// ---- The account page ---------------------------------------------------------------------------------

function seed() {
  const server = new MockAccountServer().enableFriends();
  const me = server.addUser({ username: 'Tanya', password: 'a long passphrase', age: 5e6 });
  const kara = server.addUser({ username: 'Kara' });
  const ivan = server.addUser({ username: 'Ivan' });
  const mo = server.addUser({ username: 'Mo' });
  const viper = server.addUser({ username: 'Viper' });
  server.addUser({ username: 'Nadia' });
  server.befriend(me, kara);
  server.befriend(me, ivan);
  server.befriend(me, mo);
  server.presence.set(kara.id, { status: 'game', session: { id: 'g'.repeat(32), name: 'Skirmish night', state: 'game', players: 4, maxPlayers: 4, map: { name: 'Coastal Ridge' }, playingMs: 760_000, joinable: false, spectatable: true } });
  server.presence.set(ivan.id, { status: 'lobby', session: { id: 'l'.repeat(32), name: 'Friday night 2v2', state: 'lobby', players: 3, maxPlayers: 4, joinable: true, spectatable: false } });
  server.presence.set(mo.id, { status: 'online' });
  server.friendRequests.set(`${viper.id}|${me.id}`, { createdAt: server.now, ignored: false });
  server.friendInvites.push({ from: ivan.id, to: me.id, session: 'l'.repeat(32), code: 'K7Q2MX', name: 'Friday night 2v2', players: 3, maxPlayers: 4, map: null, locked: false, createdAt: server.now, expiresAt: server.now + 3_600_000 });
  server.signIn(me);
  return { server, me, kara, ivan, mo, viper };
}

test('account page: a side menu with lamps; sign-in methods with their state; the state of the account', async () => {
  const { server } = seed();
  const { root } = await page(server);
  const nav = root.querySelector('.account-nav');
  assert.equal(nav?.getAttribute('aria-label'), 'Account sections');
  assert.ok(nav, 'the side menu');
  assert.deepEqual([...nav.querySelectorAll('.account-nav-link')].map((a) => a.textContent), ['Profile', 'Sign-in methods', 'Replays', 'Friends', 'Devices', 'Your data']);
  for (const a of nav.querySelectorAll('.account-nav-link')) assert.ok(root.querySelector(a.getAttribute('href')), `${a.textContent} leads to its section`);
  assert.equal(nav.querySelectorAll('[aria-current="true"]').length, 1, 'one section is marked');
  assert.match(textOf(nav), /Tanya.*Active/);
  const methods = sectionOf(root, 'Sign-in methods');
  assert.match(textOf(methods), /Password\s*Changed /, 'when the password was last set');
  assert.match(textOf(methods), /Passkeys\s*None yet/);
  assert.ok(methods.querySelector('#section-password') && methods.querySelector('#section-passkeys'));
  assert.deepEqual(strayValues(root), []);
});

test('account page: waiting for approval says so, with Check again that goes on once approved', async () => {
  const server = new MockAccountServer();
  const u = server.addUser({ username: 'Boris', password: 'a long passphrase', status: 'pending_approval' });
  server.signIn(u);
  const { root, navigated } = await page(server, '?returnTo=%2Fplay%2F');
  assert.match(textOf(root.querySelector('.state-card')), /Waiting for approval/);
  assert.equal(root.querySelector('#section-friends'), null, 'friends need an active account');
  click(byText(root, 'button', /Check again/));
  await settle(10);
  assert.match(textOf(root), /Still waiting/);
  u.status = 'active';
  click(byText(root, 'button', /Check again/));
  await settle(10);
  assert.deepEqual(navigated, ['/play/'], 'approved: back to the game');
});

test('account friends: the list by status with Join and Spectate where allowed, requests, invites', async () => {
  const { server } = seed();
  const { root } = await page(server);
  const friends = sectionOf(root, 'Friends');
  assert.match(textOf(friends), /2 online · 1 in a game/);
  const groups = [...friends.querySelectorAll('.friend-group-title')].map((h) => h.textContent);
  assert.deepEqual(groups, ['In a game (1)', 'In a lobby (1)', 'Online (1)']);
  assert.match(textOf(friends), /In a game: Skirmish night · Coastal Ridge · 12:40/);
  const join = byLabel(friends, 'a', "Join Ivan\'s lobby");
  assert.equal(join.getAttribute('href'), `/play/?join=${'l'.repeat(32)}`);
  assert.equal(byLabel(friends, 'a', "Watch Kara\'s game").getAttribute('href'), `/play/?join=${'g'.repeat(32)}`);
  assert.equal(byLabel(friends, 'a', "Join Kara\'s lobby"), null, 'a full game is not joinable');
  // The invite from Ivan joins by its code.
  assert.match(textOf(friends), /Ivan invites you/);
  assert.equal([...friends.querySelectorAll('a')].find((a) => a.getAttribute('href') === '/join/K7Q-2MX')?.textContent, 'Join');
  // Search narrows the list.
  typeInto(friends.querySelector('input[type="search"]'), 'mo');
  assert.deepEqual([...friends.querySelectorAll('.friend-group-title')].map((h) => h.textContent), ['Online (1)']);
  typeInto(friends.querySelector('input[type="search"]'), '');
  // Accept the request from Viper.
  assert.match(textOf(friends), /Requests\s*1/);
  click(byLabel(friends, 'button', "Accept Viper"));
  await settle(20);
  assert.match(textOf(friends), /You and Viper are friends now/);
  assert.match(textOf(friends), /No requests waiting/);
});

test('account friends: add by username (unknown names say so), withdraw, remove and block, unblock', async () => {
  const { server } = seed();
  const { root } = await page(server);
  const friends = sectionOf(root, 'Friends');
  const name = inputByLabel(friends, /^Username$/);
  name.value = 'Nobody';
  submit(name.closest('form'));
  await settle(20);
  assert.match(textOf(friends), /No player with this name/);
  name.value = 'Nadia';
  submit(name.closest('form'));
  await settle(20);
  assert.match(textOf(friends), /Request sent to Nadia/);
  assert.match(textOf(friends), /Nadia.*Sent, waiting for an answer/);
  click(byLabel(friends, 'button', "Withdraw the request to Nadia"));
  await settle(20);
  assert.doesNotMatch(textOf(friends), /Sent, waiting/);
  // Block a player by name, then unblock.
  const block = inputByLabel(friends, /Block a player/);
  block.value = 'Mo';
  submit(block.closest('form'));
  await settle(20);
  assert.match(textOf(friends), /Mo is blocked/);
  assert.match(textOf(friends), /Blocked players\s*1/);
  assert.equal(server.friendsDoc(server.users.get([...server.users.keys()][0])).friends.some((f) => f.username === 'Mo'), false, 'blocking ends the friendship');
  click(byLabel(friends, 'button', "Unblock Mo"));
  await settle(20);
  assert.doesNotMatch(textOf(friends), /Blocked players\s*1/);
});

test('account friends: the privacy switches write the social settings', async () => {
  const { server, me } = seed();
  const { root } = await page(server);
  const friends = sectionOf(root, 'Friends');
  const spectate = inputByLabel(friends, /Allow spectators/);
  assert.equal(spectate.checked, false, 'off by default');
  assert.equal(inputByLabel(friends, /Show me as online/).checked, true);
  check(spectate, true);
  await settle(20);
  assert.equal(server.settingsDocs.get(me.id).settings.social.allowSpectate, true);
  assert.match(textOf(friends), /Saved/);
});

test('account friends: a server without friends says so instead of failing', async () => {
  const server = new MockAccountServer();
  server.signIn(server.addUser({ username: 'Tanya', password: 'a long passphrase' }));
  const { root } = await page(server);
  assert.match(textOf(sectionOf(root, 'Friends')), /Friends are not available on this server yet/);
});

test('invite link while signed out: the account page shows the lobby the sign-in leads to', async () => {
  const server = new MockAccountServer();
  server.inviteCodes.set('K7Q2MX', { code: 'K7Q-2MX', session: 's'.repeat(32), name: 'Friday night 2v2', host: 'Kara', map: { name: 'Coastal Ridge' }, players: 3, maxPlayers: 4, spectators: 0, maxSpectators: 2, locked: false });
  const { root } = await page(server, `?returnTo=${encodeURIComponent('/play/?invite=K7Q-2MX')}`);
  assert.match(textOf(root.querySelector('.invite-card')), /You are invited: Friday night 2v2.*Hosted by Kara · Coastal Ridge · 3 of 4 players/);
  server.inviteCodes.set('K7Q2MX', 'expired');
  root.remove();
  const again = await page(server, `?returnTo=${encodeURIComponent('/play/?invite=K7Q-2MX')}`);
  assert.match(textOf(again.root.querySelector('.invite-card')), /The lobby closed or the code was replaced/);
});

// ---- Static pages ---------------------------------------------------------------------------------------

test('website pages: one navigation with the right current page, no style attributes, no native selects', () => {
  const dir = fileURLToPath(new URL('../../website/', import.meta.url));
  const pages = [...readdirSync(dir).filter((f) => f.endsWith('.html')), 'account/index.html'];
  const current = { 'maps.html': '/maps.html', 'multiplayer.html': '/multiplayer.html', 'changelog.html': '/changelog', 'account/index.html': '/account/' };
  for (const name of pages) {
    const html = readFileSync(dir + name, 'utf8');
    assert.doesNotMatch(html, /\sstyle=/, `${name}: no style attributes (CSP style-src 'self')`);
    assert.doesNotMatch(html, /<select\b/, `${name}: selects are select plates`);
    const nav = /<nav class="site-nav"[\s\S]*?<\/nav>/.exec(html)[0];
    const links = [...nav.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/g)].map((m) => [m[1], m[2]]);
    assert.deepEqual(links, [['/multiplayer.html', 'Multiplayer'], ['/maps.html', 'Maps'], ['/changelog', 'Changelog'], ['/account/', 'Account'], ['/play/', 'Play']], name);
    const marked = [...nav.matchAll(/<a href="([^"]+)" aria-current="page"/g)].map((m) => m[1]);
    assert.deepEqual(marked, current[name] ? [current[name]] : [], `${name}: aria-current`);
  }
  // The site's scripts never write style attributes (CSSOM custom properties only).
  for (const f of ['site.js', 'account.js', 'admin.js', 'ui.js', 'friends.js', 'invite.js', 'site-data.js']) {
    const src = readFileSync(`${dir}assets/${f}`, 'utf8');
    assert.doesNotMatch(src, /setAttribute\(\s*['"]style['"]|innerHTML|insertAdjacentHTML/, f);
  }
});

test('dialogs: Esc in an open select list closes the list only; Esc again closes the dialog', async () => {
  const key = (el, k) => el.dispatchEvent(new FakeEvent('keydown', { key: k }));
  let select;
  const done = openDialog('Pick', (body) => {
    const f = selectField('Sort by', [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], { value: 'a' });
    select = f.select;
    body.append(f.row);
  });
  let closed = false;
  done.then(() => (closed = true));
  click(select.button);
  assert.equal(select.isOpen(), true);
  key(select.listbox, 'Escape');
  await settle();
  assert.equal(select.isOpen(), false);
  assert.equal(closed, false, 'the dialog stays');
  key(select.button, 'Escape');
  await settle();
  assert.equal(closed, true, 'Esc on the closed select closes the dialog');
});

test('home: the hero battle stands still for reduced motion with CSS alone; the moving one has a Pause button', () => {
  const dir = fileURLToPath(new URL('../../website/', import.meta.url));
  const html = readFileSync(`${dir}index.html`, 'utf8');
  const svgs = [...html.matchAll(/<svg class="(hero-art[^"]*)"[\s\S]*?<\/svg>/g)];
  const live = svgs.find((m) => m[1].includes('hero-live'));
  const still = svgs.find((m) => m[1].includes('hero-still'));
  assert.ok(live && still, 'an animated and a still picture');
  assert.match(live[0], /<animateMotion /);
  assert.doesNotMatch(still[0], /<animate/, 'the still picture has no animation');
  assert.match(still[0], /<title id="hero-still-title">/);
  const ids = (svg) => [...svg.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids(live[0]).filter((id) => ids(still[0]).includes(id)), [], 'ids are not shared');
  assert.match(html, /data-hero-pause/);
  const css = readFileSync(`${dir}assets/site.css`, 'utf8');
  assert.match(css, /\.hero-still \{\s*display: none;/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.hero-live,\s*\.hero-pause \{\s*display: none !important;\s*\}\s*\.hero-still \{\s*display: block;/);
});

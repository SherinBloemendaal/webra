// The admin dashboard: table state and permissions (js/account/admin-state.js),
// settings forms generated from the registry schema (admin-forms.js), and the
// dashboard itself (apps/website/assets/admin.js) on a fake DOM against the
// contract mock. Plus CSP safety of every account and admin script and page.
import './play-loader.mjs';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { strayValues, installDom, uninstallDom, FakeEvent, click, check, settle, textOf, submit, typeInto } from './dom-fixtures.mjs';
import { MockAccountServer } from './account-mock.mjs';
import { AccountApi } from '../js/account/api.js';
import {
  UsersTable,
  apiQuery,
  auditFilter,
  auditParams,
  banExpiry,
  canBan,
  looksLikeCidr,
  normalizeQuery,
  parseView,
  permissions,
  relayLines,
  viewHash,
} from '../js/account/admin-state.js';
import { buildSettingsForm, controlFor, formatValue, parseValue } from '../js/account/admin-forms.js';
import { GROUPS, checkDocument, specOf } from '../js/registry.js';

const { mountAdmin } = await import('../../website/assets/admin.js');

let doc;
beforeEach(() => {
  doc = installDom();
});
afterEach(() => uninstallDom());

// ---- State ----------------------------------------------------------------------------------

test('admin state: permissions follow the role table; moderators never ban staff or anyone themselves', () => {
  const mod = permissions('moderator');
  assert.equal(mod.approve, true);
  assert.equal(mod.ban, true);
  for (const k of ['fullDetail', 'edit', 'sessions', 'resetLink', 'delete', 'settings', 'ipBans', 'site', 'audit']) assert.equal(mod[k], false, k);
  assert.ok(Object.values(permissions('admin')).every(Boolean));
  assert.equal(permissions('user').dashboard, false);
  const m = { id: 'a', role: 'moderator' };
  assert.equal(canBan(m, { id: 'b', role: 'user' }), true);
  assert.equal(canBan(m, { id: 'b', role: 'moderator' }), false);
  assert.equal(canBan({ id: 'a', role: 'admin' }, { id: 'b', role: 'admin' }), true);
  assert.equal(canBan({ id: 'a', role: 'admin' }, { id: 'a', role: 'admin' }), false, 'never self');
});

test('admin state: users table query, sorting, pages, selection for bulk actions, and the fragment', () => {
  const t = new UsersTable();
  assert.deepEqual(apiQuery(t.query), {});
  t.goTo(3);
  t.filter({ status: 'pending_approval', q: 'tan' });
  assert.equal(t.query.page, 1, 'a filter goes back to page 1');
  assert.deepEqual(apiQuery(t.query), { q: 'tan', status: 'pending_approval' });
  t.sortBy('username');
  assert.equal(t.query.order, 'asc');
  t.sortBy('username');
  assert.equal(t.query.order, 'desc');
  t.sortBy('lastSeen');
  assert.equal(t.query.order, 'desc');
  assert.equal(normalizeQuery({ status: 'evil', limit: 7, page: -1, sort: 'x' }).status, '');
  t.setResult({ users: [{ id: '1', status: 'pending_approval' }, { id: '2', status: 'active' }, { id: '3', status: 'pending_email' }], total: 60 });
  assert.equal(t.pages, 3);
  t.toggleAll(true);
  assert.deepEqual(t.selectedFor('approve').map((u) => u.id), ['1', '3']);
  assert.equal(t.selectedFor('other').length, 3);
  t.setResult({ users: [{ id: '3', status: 'pending_email' }], total: 1 });
  assert.deepEqual([...t.selected], ['3'], 'selection keeps only shown rows');
  assert.equal(t.rangeText(), '1 to 1 of 1');
  const h = viewHash({ tab: 'users', query: normalizeQuery({ status: 'banned', page: 2 }) });
  assert.equal(h, '#users?status=banned&page=2');
  assert.deepEqual(parseView(h).query.status, 'banned');
  assert.equal(parseView('#user=0123456789abcdef').user, '0123456789abcdef');
  assert.equal(parseView('#nonsense').tab, 'overview');
  const a = auditFilter({ action: 'user.ban', since: '2026-10-01', until: '2026-10-02', actor: 'NOT HEX' });
  assert.equal(a.actor, '');
  assert.deepEqual(auditParams(a), { action: 'user.ban', since: Date.parse('2026-10-01T00:00:00Z'), until: Date.parse('2026-10-03T00:00:00Z') });
  assert.equal(auditFilter({ target: 'site', actor: 'ab' }).target, 'site');
  assert.equal(auditFilter({ actor: 'ab' }).actor, '', 'actors are full user ids');
  assert.equal(parseView(viewHash({ tab: 'audit', audit: a })).audit.since, '2026-10-01', 'audit filters survive the fragment');
});

test('admin state: value sets match the protocol package and the server', async () => {
  const protocol = await import('../protocol/accounts.js');
  const { AUDIT_ACTIONS: serverActions } = await import('../../server/src/accounts/audit.js');
  const state = await import('../js/account/admin-state.js');
  assert.deepEqual([...state.AUDIT_ACTIONS], [...serverActions]);
  assert.deepEqual([...state.STATUSES], [...protocol.ACCOUNT_STATUSES]);
  assert.deepEqual([...state.ROLES], [...protocol.ACCOUNT_ROLES]);
  assert.deepEqual(Object.keys(state.FLAGS), Object.keys(protocol.ACCOUNT_FLAGS));
  assert.deepEqual([...state.SETTABLE_STATUSES], ['pending_email', 'pending_approval', 'active']);
});

test('admin state: ban ends and IP ranges are checked before sending', () => {
  assert.deepEqual(banExpiry('', 0), { expiresAt: null });
  assert.match(banExpiry('2000-01-01T10:00', Date.now()).error, /future/);
  assert.match(banExpiry('garbage').error, /not valid/);
  assert.ok(banExpiry('2999-01-01T10:00').expiresAt > Date.now());
  for (const ok of ['203.0.113.7', '203.0.113.0/24', '10.0.0.0/8', '2001:db8::1', '2001:db8::/48']) assert.equal(looksLikeCidr(ok), true, ok);
  for (const bad of ['203.0.113.0/4', '999.1.1.1', 'hello', '2001:db8::/8', '']) assert.equal(looksLikeCidr(bad), false, bad);
});

// ---- Forms from the schema -----------------------------------------------------------------------

test('settings forms: every setting gets a labelled control; values round-trip; problems are named', () => {
  for (const [group, g] of Object.entries(GROUPS)) {
    for (const [key, spec] of Object.entries(g.settings)) {
      const c = controlFor(spec);
      assert.ok(c.kind, `${group}.${key}`);
      const shown = formatValue(spec, spec.default);
      const back = parseValue(spec, shown);
      if (spec.default === null) assert.equal(back.value, null, `${group}.${key}`);
      else assert.deepEqual(back.value, spec.default, `${group}.${key} round-trips`);
    }
  }
  assert.deepEqual(parseValue(specOf('game', 'hotkeys'), 'stop: S, Ctrl+X\nguard:').value, { stop: ['S', 'Ctrl+X'], guard: [] });
  assert.match(parseValue(specOf('game', 'hotkeys'), 'no colon here').error, /name: keys/);
  assert.deepEqual(parseValue(specOf('content', 'packs'), 'on a|b\noff c|d').value, [{ id: 'a|b', enabled: true }, { id: 'c|d', enabled: false }]);
  assert.match(parseValue(specOf('audio', 'master'), '1.5').error, /between 0 and 1/);
  assert.match(parseValue(specOf('lobby', 'lastOptions'), '{bad').error, /not valid JSON/);
  assert.equal(parseValue(specOf('releaseNotes', 'lastSeenVersion'), '').value, null);

  const form = buildSettingsForm({ audio: { master: 0.3 }, extra: { futureThing: 1 } });
  const labels = form.node.querySelectorAll('label');
  const count = Object.values(GROUPS).reduce((n, g) => n + Object.keys(g.settings).length, 0);
  assert.equal(labels.length, count);
  for (const l of labels) assert.ok(form.node.querySelector(`#${l.getAttribute('for')}`), 'each label points at its control');
  assert.equal(form.node.querySelectorAll('fieldset').length, Object.keys(GROUPS).length);
  const master = form.controls.find((c) => c.group === 'audio' && c.key === 'master');
  assert.equal(master.input.value, '0.3');
  typeInto(master.input, '2');
  assert.equal(master.error.hidden, false);
  assert.equal(master.input.getAttribute('aria-invalid'), 'true');
  assert.deepEqual(form.read().errors.map((e) => e.path), ['audio.master']);
  typeInto(master.input, '0.4');
  const lowQuality = form.controls.find((c) => c.key === 'lowQuality');
  check(lowQuality.input, true);
  const r = form.read();
  assert.deepEqual(r.errors, []);
  assert.equal(r.document.audio.master, 0.4);
  assert.equal(r.document.game.lowQuality, true);
  assert.equal(r.document.extra.futureThing, 1, 'keys of other builds are kept');
  assert.equal(checkDocument(r.document).ok, true);
});

test('settings forms: the UI and game scale take "auto" or a number; the music settings get controls', () => {
  for (const key of ['uiScale', 'gameScale']) {
    const spec = specOf('game', key);
    const c = controlFor(spec);
    assert.equal(c.kind, 'text', 'a text field: "auto" or a number');
    assert.match(c.hint, new RegExp(`"auto", or a number from ${spec.min} to ${spec.max}`));
    assert.equal(formatValue(spec, 'auto'), 'auto');
    assert.equal(formatValue(spec, 1.25), '1.25');
    assert.deepEqual(parseValue(spec, ' Auto '), { value: 'auto' });
    assert.deepEqual(parseValue(spec, '1.25'), { value: 1.25 });
    assert.match(parseValue(spec, '').error, /needs "auto" or a number/);
    assert.match(parseValue(spec, 'big').error, /"auto" or a number/);
    assert.match(parseValue(spec, String(spec.max + 1)).error, /between/);
  }
  assert.equal(controlFor(specOf('audio', 'musicRepeat')).kind, 'select');
  assert.deepEqual(
    controlFor(specOf('audio', 'musicRepeat')).options.map((o) => o.value),
    ['all', 'one', 'off'],
  );
  assert.equal(controlFor(specOf('audio', 'musicOn')).kind, 'checkbox');

  const form = buildSettingsForm({ game: { uiScale: 0.9 } }, { groups: ['game', 'audio'] });
  const ui = form.controls.find((c) => c.key === 'uiScale');
  const game = form.controls.find((c) => c.key === 'gameScale');
  assert.equal(ui.input.value, '0.9');
  assert.equal(game.input.value, 'auto', 'missing: the default');
  typeInto(game.input, '7');
  assert.deepEqual(form.read().errors.map((e) => e.path), ['game.gameScale']);
  typeInto(game.input, '2.5');
  typeInto(ui.input, 'auto');
  const repeat = form.controls.find((c) => c.key === 'musicRepeat');
  repeat.input.value = 'one';
  const r = form.read();
  assert.deepEqual(r.errors, []);
  assert.equal(r.document.game.gameScale, 2.5);
  assert.equal(r.document.game.uiScale, 'auto');
  assert.equal(r.document.audio.musicRepeat, 'one');
  assert.equal(checkDocument(r.document).ok, true);
});

// ---- The dashboard ---------------------------------------------------------------------------------

function seed(server) {
  const admin = server.addUser({ username: 'Root', password: 'a long passphrase', role: 'admin', age: 9e6 });
  const mod = server.addUser({ username: 'Mod', password: 'a long passphrase', role: 'moderator', age: 8e6 });
  const users = [];
  for (let i = 0; i < 30; i++) users.push(server.addUser({ username: `Player${String(i).padStart(2, '0')}`, email: `p${i}@example.com`, status: i < 3 ? 'pending_approval' : 'active', age: i * 1000 }));
  return { admin, mod, users };
}

async function dashboard(server, hash = '') {
  const root = doc.createElement('div');
  doc.body.append(root);
  const location = { hash, pathname: '/admin.html', search: '' };
  const history = { replaceState: (_s, _t, url) => (location.hash = url.slice(url.indexOf('#'))) };
  const view = await mountAdmin(root, { api: new AccountApi({ fetchImpl: server.fetch }), location, history });
  await settle(20);
  return { root, view, location };
}

const byText = (root, tag, re) => root.querySelectorAll(tag).find((b) => re.test(b.textContent));

test('dashboard: signed out and plain users get no dashboard', async () => {
  const server = new MockAccountServer();
  const { root } = await dashboard(server);
  assert.match(textOf(root), /Sign in with a moderator or admin account/);
  server.signIn(server.addUser({ username: 'Joe', password: 'a long passphrase' }));
  uninstallDom();
  doc = installDom();
  const b = await dashboard(server);
  assert.match(textOf(b.root), /for moderators and admins/);
});

test('dashboard: moderators see overview and users only; approve, ban users, no admin tools', async () => {
  const server = new MockAccountServer();
  const { mod, users } = seed(server);
  server.signIn(mod);
  const { root } = await dashboard(server, '#users');
  assert.deepEqual(root.querySelectorAll('[role="tab"]').map((t) => t.textContent), ['Overview', 'Users']);
  const rows = root.querySelectorAll('tbody tr');
  assert.equal(rows.length, 25);
  click(byText(root, 'button', /^Player29$/) ?? byText(root, 'button', /Player/));
  await settle(20);
  const drawer = root.querySelector('.drawer');
  assert.ok(drawer);
  assert.equal(byText(drawer, 'button', /Delete/), undefined);
  assert.equal(byText(drawer, 'summary', /Settings/), undefined);
  assert.equal(byText(drawer, 'summary', /IP history/), undefined);
  assert.ok(byText(drawer, 'button', /^Ban$/));
  assert.equal(users.length, 30);
});

test('dashboard: filters, sorting and pages drive the API query; bulk approve', async () => {
  const server = new MockAccountServer();
  const { admin, users } = seed(server);
  server.signIn(admin);
  const { root, location } = await dashboard(server, '#users');
  assert.match(textOf(root.querySelector('.pager')), /1 to 25 of 32/);
  click(byText(root, 'button', /^Next$/));
  await settle(20);
  assert.match(textOf(root.querySelector('.pager')), /26 to 32 of 32/);
  assert.match(location.hash, /page=2/);
  const status = root.querySelectorAll('select')[0];
  status.value = 'pending_approval';
  status.dispatchEvent(new FakeEvent('change'));
  await settle(20);
  assert.equal(root.querySelectorAll('tbody tr').length, 3);
  assert.match(server.requests.at(-1).url, /status=pending_approval/);
  assert.doesNotMatch(server.requests.at(-1).url, /page=/, 'back to page 1');
  check(root.querySelector('thead input[type="checkbox"]'));
  await settle();
  click(byText(root, 'button', /Approve selected/));
  await settle(30);
  assert.ok(users.slice(0, 3).every((u) => u.status === 'active'));
  assert.match(textOf(root), /3 accounts approved/);
  const sort = byText(root, 'button', /^Username$/);
  click(sort);
  await settle(20);
  assert.match(server.requests.at(-1).url, /sort=username&order=asc/);
});

test('dashboard: the drawer edits role and flags, bans with a reason, and the settings editor checks and saves', async () => {
  const server = new MockAccountServer();
  const { admin, users } = seed(server);
  server.signIn(admin);
  const target = users[10];
  server.settingsDocs.set(target.id, { version: 2, updatedAt: 1, settings: { schema: 1, audio: { master: 0.5 } } });
  const { root } = await dashboard(server, `#user=${target.id}`);
  await settle(20);
  const drawer = root.querySelector('.drawer');
  assert.match(textOf(drawer), new RegExp(target.username));
  assert.deepEqual(strayValues(drawer), [], 'no left-out block shows as text');
  // Edit: the one-click flag.
  const flag = drawer.querySelectorAll('input[type="checkbox"]').find((c) => /One-click/.test(drawer.querySelector(`label[for="${c.id}"]`)?.textContent ?? ''));
  check(flag, true);
  submit(byText(drawer, 'button', /Save changes/).closest('form'));
  await settle(20);
  assert.deepEqual(target.flags, ['content_autoinstall']);
  // Ban: a reason is needed; a preset fills the end.
  click(byText(root.querySelector('.drawer'), 'button', /^Ban$/));
  await settle(5);
  const dialog = doc.body.querySelectorAll('[role="dialog"]').at(-1);
  submit(dialog.querySelector('form'));
  await settle(5);
  assert.match(textOf(dialog), /Give a reason/);
  dialog.querySelector('textarea').value = 'Griefing';
  click(byText(dialog, 'button', /^7 days$/));
  submit(dialog.querySelector('form'));
  await settle(30);
  assert.equal(target.ban.reason, 'Griefing');
  assert.ok(target.ban.expiresAt > Date.now());
  // Settings editor: open it, break a value, fix it, save; a newer version gives a choice.
  const block = byText(root.querySelector('.drawer'), 'summary', /Settings/).closest('details');
  block.open = true;
  block.dispatchEvent(new FakeEvent('toggle'));
  await settle(20);
  const master = block.querySelectorAll('input').find((i) => block.querySelector(`label[for="${i.id}"]`)?.textContent === 'Master volume');
  assert.equal(master.value, '0.5');
  typeInto(master, '7');
  click(byText(block, 'button', /Save settings/));
  await settle(10);
  assert.match(textOf(block), /Fix 1 setting first/);
  typeInto(master, '0.25');
  // JSON mode: invalid JSON is reported, a valid document saves.
  click(byText(block, 'button', /^JSON$/));
  const raw = block.querySelector('textarea.code');
  typeInto(raw, '{"audio": {"master": 3}}');
  assert.match(textOf(block), /audio\.master must be between 0 and 1/);
  typeInto(raw, JSON.stringify({ schema: 1, audio: { master: 0.25 }, game: { lowQuality: true } }));
  // Someone else saved meanwhile: version 3.
  server.settingsDocs.set(target.id, { version: 3, updatedAt: 2, settings: { schema: 1 } });
  click(byText(block, 'button', /Save settings/));
  await settle(20);
  const conflict = doc.body.querySelectorAll('[role="dialog"]').at(-1);
  assert.match(textOf(conflict), /changed \(now version 3\)/);
  click(byText(conflict, 'button', /Save mine over them/));
  await settle(20);
  const stored = server.settingsDocs.get(target.id);
  assert.equal(stored.version, 4);
  assert.equal(stored.settings.game.lowQuality, true);
});

test('admin state: relay budget lines name what is used and until when', () => {
  const b = (used, limit, unit) => ({ used, limit, unit, resetsAt: 7200000 });
  const r = relayLines(
    { account: { content: b(2, 8, 'downloads'), music: b(0, 256, 'MiB') }, networks: [{ network: '203.0.113.7', lastSeen: 1, content: b(0, 20, 'downloads'), contentAttempts: b(0, 30, 'requests'), music: b(0, 64, 'requests') }] },
    (ms) => `t${ms}`,
  );
  assert.deepEqual(r.account, ['Package downloads: 2 of 8 downloads, until t7200000', 'Music: 0 of 256 MiB']);
  assert.deepEqual(r.networks[0], { network: '203.0.113.7', lines: ['Package downloads: 0 of 20 downloads', 'Package requests: 0 of 30 requests', 'Music: 0 of 64 requests'], used: false });
  assert.equal(r.used, true);
  assert.deepEqual(relayLines(undefined), { account: [], networks: [], used: false });
});

test('dashboard: the drawer shows the relay budgets and resets them after a confirmation', async () => {
  const server = new MockAccountServer();
  const { admin, users } = seed(server);
  server.signIn(admin);
  const target = users[12];
  const b = (used, limit, unit) => ({ used, limit, unit, resetsAt: server.now + 3600e3 });
  server.relayQuotas.set(target.id, {
    account: { content: b(8, 8, 'downloads'), music: b(64, 256, 'MiB') },
    networks: [{ network: '203.0.113.7', lastSeen: server.now, content: b(3, 20, 'downloads'), contentAttempts: b(5, 30, 'requests'), music: b(0, 64, 'requests') }],
  });
  const { root } = await dashboard(server, `#user=${target.id}`);
  await settle(20);
  const block = byText(root.querySelector('.drawer'), 'summary', /One-click relay budgets \(in use\)/).closest('details');
  assert.match(textOf(block), /Package downloads: 8 of 8 downloads, until/);
  assert.match(textOf(block), /Network 203\.0\.113\.7:.*Package requests: 5 of 30 requests/);
  click(byText(block, 'button', /Reset relay budgets/));
  await settle(5);
  const dialog = doc.body.querySelectorAll('[role="dialog"]').at(-1);
  assert.match(textOf(dialog), /others on those networks too/);
  click(byText(dialog, 'button', /^Reset$/));
  await settle(30);
  assert.equal(server.relayQuotas.has(target.id), false);
  assert.equal(server.audit[0].action, 'user.relay_quota_reset');
  const after = byText(root.querySelector('.drawer'), 'summary', /One-click relay budgets/);
  assert.doesNotMatch(textOf(after), /in use/);
});

test('dashboard: IP bans, site settings with unavailable services, and the audit log', async () => {
  const server = new MockAccountServer();
  const { admin } = seed(server);
  server.signIn(admin);
  const { root, view } = await dashboard(server, '#ip-bans');
  click(byText(root, 'button', /Ban an address or range/));
  await settle(5);
  let dialog = doc.body.querySelectorAll('[role="dialog"]').at(-1);
  const [range, reason] = dialog.querySelectorAll('input');
  range.value = '203.0.113.0/4';
  reason.value = 'Spam';
  submit(dialog.querySelector('form'));
  await settle(5);
  assert.match(textOf(dialog), /Enter an IPv4 or IPv6 address/);
  range.value = '203.0.113.0/24';
  submit(dialog.querySelector('form'));
  await settle(30);
  assert.equal(server.ipBans[0].cidr, '203.0.113.0/24');
  assert.match(textOf(root), /203\.0\.113\.0\/24/);
  // Site settings: email and Discord are not available here.
  view.show('site');
  await settle(20);
  assert.match(textOf(root), /Unavailable until the email plan is upgraded/);
  assert.match(textOf(root), /Unavailable: Discord is not configured/);
  const approval = root.querySelectorAll('input[type="checkbox"]').find((c) => /Approval required/.test(root.querySelector(`label[for="${c.id}"]`).textContent));
  check(approval, false);
  const gameGate = root.querySelectorAll('input[type="checkbox"]').find((c) => /The game needs an account/.test(root.querySelector(`label[for="${c.id}"]`).textContent));
  assert.equal(gameGate.checked, true, 'on by default');
  check(gameGate, false);
  root.querySelector('textarea').value = 'Open beta!';
  submit(root.querySelector('form'));
  await settle(30);
  assert.equal(server.site.registration.approvalRequired, false);
  assert.equal(server.site.gameRequiresAccount, false);
  assert.equal(server.site.motd, 'Open beta!');
  assert.equal(server.requests.find((r) => r.method === 'PATCH' && r.url === '/api/admin/site').headers['if-match'], '"v1"');
  // Audit log with a filter.
  view.show('audit');
  await settle(20);
  assert.match(textOf(root), /site\.update/);
  assert.match(textOf(root), /ipban\.create/);
  const action = root.querySelector('select');
  action.value = 'site.update';
  submit(root.querySelector('form'));
  await settle(20);
  assert.match(server.requests.at(-1).url, /action=site\.update/);
});

// ---- CSP safety -------------------------------------------------------------------------------------

test('CSP safety: account and admin code builds the DOM without HTML strings, inline styles or inline handlers', () => {
  const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  const scripts = [
    ...readdirSync(fileURLToPath(new URL('../js/account/', import.meta.url))).map((f) => `../js/account/${f}`),
    '../../website/assets/account.js',
    '../../website/assets/admin.js',
    '../../website/assets/ui.js',
    '../js/content/panel.js',
    '../js/registry.js',
  ];
  for (const rel of scripts) {
    const src = read(rel);
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function\(/, rel);
    assert.doesNotMatch(src, /setAttribute\(\s*['"]style['"]|\.style\.cssText|['"]style['"]\s*:/, rel);
  }
  for (const rel of ['../../website/account/index.html', '../../website/admin.html', '../index.html']) {
    const html = read(rel);
    assert.doesNotMatch(html, /\sstyle=/, `${rel}: no style attributes`);
    assert.doesNotMatch(html, /\son[a-z]+=/, `${rel}: no inline handlers`);
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
      assert.match(m[1], /\bsrc=/, `${rel}: scripts come from files`);
      assert.equal(m[2].trim(), '', `${rel}: no inline script`);
    }
  }
});

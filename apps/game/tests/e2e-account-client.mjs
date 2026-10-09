// End-to-end check of the game's and website's account client
// (js/account/api.js, sync.js) against a running local Worker: every call
// the account page and the admin dashboard make, with the real server.
//
//   cd apps/server && npx wrangler d1 migrations apply webra --local
//   npx wrangler dev --port 8799 --local-upstream localhost:8799 --var WEBRA_DEV_ROUTES:1
//   node apps/game/tests/e2e-account-client.mjs http://localhost:8799
//
// Node's fetch keeps no cookies and sends no Origin: a small jar per account
// adds both, as a browser on the page would.
import assert from 'node:assert/strict';
import { AccountApi, AccountError } from '../js/account/api.js';
import { SettingsSync } from '../js/account/sync.js';
import { createRegistry, checkDocument } from '../js/registry.js';
import { apiQuery, auditParams, auditFilter, UsersTable } from '../js/account/admin-state.js';
import { buildSettingsForm } from '../js/account/admin-forms.js';
import { installDom, uninstallDom } from './dom-fixtures.mjs';

const BASE = process.argv[2] || 'http://localhost:8799';
const ORIGIN = new URL(BASE).origin;
const RUN = Date.now().toString(36).slice(-6);
const PASSWORD = 'client e2e passphrase';

/** An AccountApi with its own cookie jar (one browser). */
function browser() {
  let cookie = null;
  const fetchImpl = async (path, init = {}) => {
    const headers = { ...init.headers, Origin: ORIGIN };
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(BASE + path, { ...init, headers, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const pair = c.split(';')[0];
      if (/^(__Host-)?webra_session=/.test(pair)) cookie = /Max-Age=0/i.test(c) ? null : pair;
    }
    return res;
  };
  return { api: new AccountApi({ fetchImpl }), raw: fetchImpl, cookie: () => cookie };
}

const step = (name) => console.log(`- ${name}`);
const rejects = async (p, code) => {
  const err = await p.then(() => null, (e) => e);
  assert.ok(err instanceof AccountError, `expected ${code}, got ${err}`);
  assert.equal(err.code, code, err.message);
  return err;
};

const site = await browser().api.site();
step(`site: registration open ${site.registration.open}, approval ${site.registration.approvalRequired}`);

// ---- A player signs up, an admin is made through the dev route ---------------------------
const admin = browser();
const adminName = `adm${RUN}`;
const a = await admin.api.signup({ username: adminName, password: PASSWORD, acceptPrivacy: true });
assert.ok(admin.cookie()?.startsWith('webra_session='), 'plain HTTP to localhost: the local cookie name');
const promote = await admin.raw('/api/dev/promote', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WebRA-CSRF': '1' }, body: JSON.stringify({ username: adminName, role: 'admin' }) });
assert.equal(promote.status < 300, true, `dev promote: ${promote.status} (start wrangler dev with --var WEBRA_DEV_ROUTES:1)`);
await admin.api.login({ login: adminName, password: PASSWORD });
const me = (await admin.api.me()).user;
assert.equal(me.role, 'admin');
assert.equal(me.status, 'active');
assert.equal(me.id, a.user.id);
step('signup, promote, sign in: admin active');

const player = browser();
const pname = `ply${RUN}`;
const p = (await player.api.signup({ username: pname, displayName: 'Client Tester', password: PASSWORD, acceptPrivacy: true })).user;
step(`player signed up: ${p.status}`);
await rejects(player.api.stats(), 'forbidden');

// ---- Admin dashboard calls ----------------------------------------------------------------------
const stats = await admin.api.stats();
assert.ok(stats.users.total >= 2);
const table = new UsersTable();
table.filter({ q: pname });
table.setResult(await admin.api.users(apiQuery(table.query)));
assert.equal(table.users.length, 1);
table.sortBy('username');
table.setResult(await admin.api.users(apiQuery(table.query)));
for (const sort of ['created', 'lastSeen']) await admin.api.users(apiQuery(new UsersTable({ sort, order: 'asc', limit: 10 }).query));
await admin.api.users(apiQuery(new UsersTable({ status: 'pending_approval', role: 'user', flag: 'content_autoinstall' }).query));
const detail = await admin.api.user(p.id);
assert.ok(Array.isArray(detail.ips) && Array.isArray(detail.sessions) && detail.settings);
step('stats, users with search, sort, filters, user detail');
if (p.status === 'pending_approval' || p.status === 'pending_email') {
  await admin.api.approveUser(p.id);
  step('approved');
}
await admin.api.updateUser(p.id, { flags: ['content_autoinstall'], displayName: 'Client Tester 2' });
assert.equal((await player.api.account()).user.canUseContentRelay, site.contentRelay);
step('flag set: canUseContentRelay follows');

// ---- Settings sync with the real server ----------------------------------------------------------
const registry = createRegistry({ storage: null });
registry.set('audio', 'master', 0.42);
registry.set('game', 'hotkeys', { stop: ['Ctrl+Shift+S'] });
const sync = new SettingsSync({ api: player.api, registry, debounceMs: 10 });
await sync.start((await player.api.me()).user);
let doc = await player.api.settings();
assert.equal(doc.version, 1);
assert.equal(doc.settings.audio.master, 0.42);
registry.set('audio', 'music', 0.11);
await new Promise((r) => setTimeout(r, 300));
await sync.running;
doc = await player.api.settings();
assert.equal(doc.version, 2);
assert.equal(doc.settings.audio.music, 0.11);
step('settings uploaded with If-Match, debounced change uploaded');

// The admin edits the player's settings with the generated form; a stale version is refused.
installDom();
const userDoc = await admin.api.userSettings(p.id);
const form = buildSettingsForm(userDoc.settings);
form.controls.find((c) => c.group === 'game' && c.key === 'lowQuality').input.checked = true;
const read = form.read();
assert.deepEqual(read.errors, []);
assert.equal(checkDocument(read.document).ok, true);
const saved = await admin.api.putUserSettings(p.id, userDoc.version, read.document);
assert.equal(saved.version, userDoc.version + 1);
const stale = await rejects(admin.api.putUserSettings(p.id, userDoc.version, read.document), 'version_conflict');
assert.equal(stale.detail.current.version, saved.version);
uninstallDom();
await sync.flush();
assert.equal(registry.get('game', 'lowQuality'), true, 'the admin\'s change reached the player');
step('admin settings editor: saved, 412 with current, player pulled it');

// ---- Self service ---------------------------------------------------------------------------------
await player.api.updateProfile({ displayName: 'Tester Three', avatarColor: '#336699' });
const sessions = (await player.api.sessions()).sessions;
const current = sessions.find((s) => s.current);
await player.api.renameSession(current.id, 'Node e2e');
await player.api.revokeOtherSessions();
assert.deepEqual((await player.api.passkeys()).passkeys, []);
// Signing in is not a re-authentication: sensitive changes need a fresh one.
await rejects(player.api.changePassword({ newPassword: `${PASSWORD} two` }), 'reauth_required');
await player.api.reauth({ password: PASSWORD });
await player.api.changePassword({ newPassword: `${PASSWORD} two` });
const exported = await player.api.exportData();
assert.match(exported.name, /^webra-account-.+\.json$/);
step('profile, sessions, password change, re-authentication, export');

// ---- Bans, IP bans, site settings, audit -------------------------------------------------------------
await rejects(admin.api.banUser(p.id, '', null), 'invalid');
await admin.api.banUser(p.id, 'e2e ban', Date.now() + 3_600_000);
await rejects(player.api.account(), 'unauthenticated');
await rejects(player.api.login({ login: pname, password: `${PASSWORD} two` }), 'banned');
await admin.api.unbanUser(p.id);
await player.api.login({ login: pname, password: `${PASSWORD} two` });
step('ban signs out and blocks sign-in; unban');
const ip = await admin.api.createIpBan({ cidr: '198.51.100.0/24', reason: 'e2e', expiresAt: null });
await admin.api.updateIpBan(ip.ban.id, { reason: 'e2e edited', expiresAt: Date.now() + 86_400_000 });
assert.ok((await admin.api.ipBans({ active: 1 })).bans.some((b) => b.id === ip.ban.id));
await admin.api.deleteIpBan(ip.ban.id);
await rejects(admin.api.createIpBan({ cidr: '10.0.0.0/4', reason: 'too wide', expiresAt: null }), 'invalid');
const adminSite = await admin.api.adminSite();
await admin.api.patchSite(adminSite.version, { motd: `e2e ${RUN}` });
await rejects(admin.api.patchSite(adminSite.version, { motd: '' }), 'version_conflict');
const after = await admin.api.adminSite();
await admin.api.patchSite(after.version, { motd: adminSite.settings.motd });
const audit = await admin.api.audit(auditParams(auditFilter({ action: 'site.update', since: new Date().toISOString().slice(0, 10), until: new Date().toISOString().slice(0, 10) })));
assert.ok(audit.entries.length >= 2);
await admin.api.audit(auditParams(auditFilter({ actor: me.id, target: 'site' })));
step('IP bans (create, edit, list, delete, too wide), site settings with If-Match and 412, audit filters');

const link = await admin.api.resetLink(p.id, false);
assert.match(link.url, /\/account\/#reset=/);
await admin.api.logoutUser(p.id);
await rejects(player.api.account(), 'unauthenticated');
await admin.api.deleteUser(p.id);
await admin.api.restoreUser(p.id);
await admin.api.deleteUser(p.id);
await rejects(admin.api.purgeUser(p.id, 'wrong'), 'invalid');
await admin.api.purgeUser(p.id, pname);
await rejects(admin.api.user(p.id), 'not_found');
step('reset link, force sign-out, delete, restore, purge');

// The player's own deletion path.
const leaver = browser();
const lname = `lv${RUN}`;
await leaver.api.signup({ username: lname, password: PASSWORD, acceptPrivacy: true });
await rejects(leaver.api.deleteAccount(lname), 'reauth_required');
await leaver.api.reauth({ password: PASSWORD });
await leaver.api.deleteAccount(lname);
assert.equal((await leaver.api.me()).user, null);
await admin.api.logout();
assert.equal((await admin.api.me()).user, null);
step('self deletion, sign-out');
console.log('account client e2e: ok');

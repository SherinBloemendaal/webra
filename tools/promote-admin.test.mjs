// tools/promote-admin.mjs: argument rules and the SQL it runs, executed
// against the real migrations in SQLite (wrangler is never called here).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { parseArgs, promoteSql, sqlString } from './promote-admin.mjs';

function db() {
  const d = new DatabaseSync(':memory:');
  d.exec('PRAGMA foreign_keys = ON');
  const dir = new URL('../apps/server/migrations/', import.meta.url);
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) d.exec(readFileSync(new URL(f, dir), 'utf8'));
  return d;
}

function addUser(d, id, username, key) {
  d.prepare(
    "INSERT INTO users (id, username, username_key, display_name, avatar_color, status, user_handle, created_at) VALUES (?, ?, ?, ?, '#c8402a', 'pending_approval', ?, 0)",
  ).run(id, username, key, username, `h${id}`);
  d.prepare("INSERT INTO auth_sessions (id_hash, public_id, user_id, created_at, last_used_at, expires_at, reauth_at, ip_hash, user_agent, device_label) VALUES (?, ?, ?, 0, 0, 1, 0, '', '', '')").run(
    `s${id}`,
    id.slice(0, 16),
    id,
  );
}

test('arguments: a mode is required; production needs --confirm with the same username', () => {
  assert.deepEqual(parseArgs(['Tanya', '--local']), { username: 'Tanya', mode: 'local', role: 'admin', confirm: null });
  assert.equal(parseArgs(['Tanya', '--remote', '--confirm', 'Tanya']).mode, 'remote');
  assert.equal(parseArgs(['--local', 'Tanya', '--role', 'moderator']).role, 'moderator');
  for (const bad of [['Tanya'], [], ['Tanya', '--remote'], ['Tanya', '--remote', '--confirm', 'tanya'], ['Tanya', '--local', '--remote'], ['A', 'B', '--local'], ['Tanya', '--local', '--force']]) {
    assert.throws(() => parseArgs(bad), Error, bad.join(' '));
  }
});

test('the SQL promotes exactly that account, signs it out and records an audit entry', () => {
  const d = db();
  addUser(d, 'a'.repeat(32), 'Tanya', 'tanya');
  addUser(d, 'b'.repeat(32), 'Boris', 'boris');
  const sql = promoteSql('TANYA', 'admin', 1234);
  d.exec(sql);
  const users = d.prepare('SELECT username, role, status, approved_at FROM users ORDER BY username').all().map((r) => ({ ...r }));
  assert.deepEqual(users, [
    { username: 'Boris', role: 'user', status: 'pending_approval', approved_at: null },
    { username: 'Tanya', role: 'admin', status: 'active', approved_at: 1234 },
  ]);
  assert.deepEqual(d.prepare('SELECT user_id FROM auth_sessions').all().map((r) => r.user_id), ['b'.repeat(32)]);
  const audit = { ...d.prepare('SELECT * FROM audit_log').get() };
  assert.equal(audit.target_id, 'a'.repeat(32));
  assert.equal(audit.reason, 'tools/promote-admin.mjs');
  assert.deepEqual(JSON.parse(audit.before_json), { role: 'user', status: 'pending_approval' });
  // Unknown usernames change nothing.
  d.exec(promoteSql('Somebody', 'admin', 5));
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n, 1);
});

test('usernames are validated and quoted; roles are checked', () => {
  assert.equal(sqlString("it's"), "'it''s'");
  assert.throws(() => promoteSql("x'; DROP TABLE users; --"), /Username/);
  assert.throws(() => promoteSql('Tanya', 'root'), /role/);
  assert.throws(() => promoteSql('ab'));
});

#!/usr/bin/env node
// Make an existing account an admin (docs/deploy.md, "First admin"):
//
//   node tools/promote-admin.mjs <username> --local
//   node tools/promote-admin.mjs <username> --remote --confirm <username>
//   node tools/promote-admin.mjs <username> --local --role moderator
//
// Sign up on the site first, then run this. It sets the role (admin by
// default) and status `active`, signs the account out everywhere (role
// changes always do) and writes an audit log entry, through
// `wrangler d1 execute webra` from apps/server (--local: the wrangler dev
// database; --remote: production, which needs --confirm with the same
// username). No personal data is stored in the repository: the username is
// only passed on the command line.
//
// Wrangler's --command takes no bound parameters, so the username is
// validated with the protocol's own rules (which allow no quotes) and
// written as an escaped SQL string literal.

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ACCOUNT_ROLES, usernameKey, validUsername } from '../packages/protocol/src/index.js';

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'server');

/** A single-quoted SQL string literal. */
export function sqlString(value) {
  if (typeof value !== 'string' || value.includes('\0')) throw new Error('not a string');
  return `'${value.replace(/'/g, "''")}'`;
}

/** The SQL for one promotion. Throws for an invalid username or role. */
export function promoteSql(username, role = 'admin', now = Date.now()) {
  const name = validUsername(username);
  if (!ACCOUNT_ROLES.includes(role)) throw new Error(`role must be one of ${ACCOUNT_ROLES.join(', ')}`);
  if (!Number.isSafeInteger(now)) throw new Error('bad time');
  const key = sqlString(usernameKey(name));
  const target = `(SELECT id FROM users WHERE username_key = ${key})`;
  return [
    `INSERT INTO audit_log (at, actor_id, actor_username, action, target_type, target_id, target_label, before_json, after_json, reason)
     SELECT ${now}, NULL, NULL, 'user.update', 'user', id, username,
       json_object('role', role, 'status', status), json_object('role', ${sqlString(role)}, 'status', 'active'), 'tools/promote-admin.mjs'
     FROM users WHERE username_key = ${key}`,
    `DELETE FROM auth_sessions WHERE user_id = ${target}`,
    `UPDATE users SET role = ${sqlString(role)}, status = 'active', approved_at = COALESCE(approved_at, ${now})
     WHERE username_key = ${key} RETURNING id, username, role, status`,
  ].join(';\n');
}

/** Parse argv; returns { username, mode, role, confirm } or throws with usage. */
export function parseArgs(argv) {
  const usage = 'usage: node tools/promote-admin.mjs <username> (--local | --remote --confirm <username>) [--role admin|moderator|user]';
  const out = { username: null, mode: null, role: 'admin', confirm: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--local' || a === '--remote') {
      if (out.mode) throw new Error(usage);
      out.mode = a.slice(2);
    } else if (a === '--role' || a === '--confirm') {
      if (i + 1 >= argv.length) throw new Error(usage);
      out[a.slice(2)] = argv[++i];
    } else if (!a.startsWith('--') && out.username === null) {
      out.username = a;
    } else {
      throw new Error(usage);
    }
  }
  if (!out.username || !out.mode) throw new Error(usage);
  if (out.mode === 'remote' && out.confirm !== out.username) {
    throw new Error('Promoting on the production database needs --confirm with the same username.');
  }
  return out;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  const sql = promoteSql(args.username, args.role);
  const out = execFileSync('npx', ['--no-install', 'wrangler', 'd1', 'execute', 'webra', `--${args.mode}`, '--json', '--command', sql], {
    cwd: SERVER_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let rows = [];
  try {
    rows = JSON.parse(out).flatMap((r) => r.results ?? []);
  } catch {
    console.error('Could not read wrangler output:');
    console.error(out);
    process.exit(1);
  }
  const user = rows.find((r) => r && r.role === args.role && r.status === 'active');
  if (!user) {
    console.error(`No account named "${args.username}" in the ${args.mode} database. Sign up first.`);
    process.exit(1);
  }
  console.log(`${user.username} (${user.id}) is now ${user.role} in the ${args.mode} database. Sign in again.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();

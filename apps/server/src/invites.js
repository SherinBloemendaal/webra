// Invite codes (docs/contracts.md section 4, "Invite codes"; docs/security.md
// "Invite codes"). A code is a short name for one session while its lobby is
// open: the host issues it (the session object's `newInvite`, from POST
// /api/sessions/<id>/invite), anyone with it looks the lobby up (GET
// /api/invite/<code>) and joins with the session id it names. The code never
// replaces the password of a password lobby.
//
// Codes live in D1 `invite_codes` (the primary key is the collision check).
// A replaced code, or one whose lobby started or closed, keeps its row with
// an expiry in the past, so it answers "expired" (410) rather than
// "unknown" (404) until the daily job deletes it a day later.

import { formatInviteCode, randomInviteCode } from '@webra/protocol';
import { LISTING_TTL_MS, sessionView } from './directory.js';

/** Expired codes are kept this long, then forgotten (src/accounts/cron.js). */
export const INVITE_KEEP_MS = 24 * 60 * 60 * 1000;
/** Tries to find a free code before giving up (with 31^6 codes, one is nearly always enough). */
const ISSUE_TRIES = 8;

const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

const isUniqueViolation = (err) => /UNIQUE|constraint/i.test(String(err?.message ?? err));

/**
 * Issue a new code for `sessionId`, valid until `expiresAt`; the session's
 * older codes stop working in the same batch. Returns the code.
 */
export async function issueInviteCode(db, sessionId, now, expiresAt, random = randomBytes) {
  for (let i = 0; i < ISSUE_TRIES; i++) {
    const code = randomInviteCode(random);
    try {
      await db.batch([
        db.prepare('UPDATE invite_codes SET expires_at = ?2 WHERE session_id = ?1 AND expires_at > ?2').bind(sessionId, now),
        db.prepare('INSERT INTO invite_codes (code, session_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)').bind(code, sessionId, now, expiresAt),
      ]);
      return code;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  throw new Error('no free invite code');
}

/** Every code of the session stops working now (the game started, the session closed). */
export async function expireInviteCodes(db, sessionId, now) {
  await db.prepare('UPDATE invite_codes SET expires_at = ?2 WHERE session_id = ?1 AND expires_at > ?2').bind(sessionId, now).run();
}

/** The session's code that is valid now: { code, expiresAt } or null. */
export async function liveInviteCode(db, sessionId, now) {
  const row = await db
    .prepare('SELECT code, expires_at FROM invite_codes WHERE session_id = ?1 AND expires_at > ?2 ORDER BY created_at DESC LIMIT 1')
    .bind(sessionId, now)
    .first();
  return row ? { code: row.code, expiresAt: row.expires_at } : null;
}

/**
 * Look a code up: { status: 'unknown' } (no such code, ever or for a day),
 * { status: 'expired' } (replaced, or its lobby started or closed), or
 * { status: 'ok', invite } with what the join dialog shows.
 */
export async function lookupInviteCode(db, code, now) {
  const row = await db
    .prepare(
      `SELECT i.code, i.session_id, i.expires_at, s.id, s.name, s.host, s.players, s.max_players, s.locked, s.public,
              s.map_json, s.version, s.state, s.summary_json, s.updated_at
       FROM invite_codes i LEFT JOIN sessions s ON s.id = i.session_id WHERE i.code = ?1`,
    )
    .bind(code)
    .first();
  if (!row) return { status: 'unknown' };
  if (row.expires_at <= now || row.id === null || row.state !== 'lobby' || row.updated_at <= now - LISTING_TTL_MS) return { status: 'expired' };
  const view = sessionView(row);
  return {
    status: 'ok',
    sessionId: row.session_id,
    invite: {
      code: formatInviteCode(row.code),
      session: view.id,
      name: view.name,
      host: view.host,
      map: view.map,
      players: view.players,
      maxPlayers: view.maxPlayers,
      spectators: view.summary?.spectators ?? 0,
      maxSpectators: view.summary?.maxSpectators ?? 0,
      mode: view.summary?.mode ?? null,
      locked: view.locked,
      public: row.public === 1,
      version: view.version,
      expiresAt: row.expires_at,
    },
  };
}

/** Whether a present member of the session (game_presence) blocked `userId`. */
export async function blockedBySessionMember(db, sessionId, userId) {
  const row = await db
    .prepare(
      `SELECT 1 AS b FROM user_blocks b JOIN game_presence p ON p.user_id = b.user_id
       WHERE p.session_id = ?1 AND b.blocked_id = ?2 LIMIT 1`,
    )
    .bind(sessionId, userId)
    .first();
  return row !== null;
}

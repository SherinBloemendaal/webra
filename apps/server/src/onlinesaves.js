// Saved online games in D1 (docs/security.md "Online saves"). Only what a
// resume is checked against is kept: the save point, the agreed state hash,
// digests of the order frames and the options, the map hash, the session
// name and which account played which seat. The files (options, map, orders)
// stay in the players' browsers.

import { ONLINE_SAVES_PER_ACCOUNT, SAVE_ID_RE } from '@webra/protocol';
import { randomHex } from './crypto.js';

/**
 * Store a save record: `{ engine, title, ticks, stateHash, framesDigest,
 * optionsDigest, mapHash, members: [{ seat, userId }] }`. Each member keeps
 * at most ONLINE_SAVES_PER_ACCOUNT records (its oldest go). Returns the id.
 */
export async function recordSave(db, rec, now = Date.now()) {
  const id = randomHex(8);
  await db.batch([
    db
      .prepare(
        `INSERT INTO online_saves (id, created_at, engine, title, ticks, state_hash, frames_digest, options_digest, map_hash)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      )
      .bind(id, now, rec.engine, rec.title, rec.ticks, rec.stateHash, rec.framesDigest, rec.optionsDigest, rec.mapHash ?? null),
    ...rec.members.map((m) => db.prepare('INSERT INTO online_save_members (save_id, seat, user_id) VALUES (?1, ?2, ?3)').bind(id, m.seat, m.userId)),
  ]);
  for (const m of rec.members) {
    await db
      .prepare(
        `DELETE FROM online_saves WHERE id IN (
           SELECT s.id FROM online_saves s JOIN online_save_members m ON m.save_id = s.id
           WHERE m.user_id = ?1 ORDER BY s.created_at DESC, s.id LIMIT -1 OFFSET ?2)`,
      )
      .bind(m.userId, ONLINE_SAVES_PER_ACCOUNT)
      .run();
  }
  return id;
}

/** A save record with its members (`seats[seat] = userId`), or null. */
export async function loadSaveRecord(db, id) {
  if (!SAVE_ID_RE.test(id)) return null;
  const row = await db.prepare('SELECT * FROM online_saves WHERE id = ?1').bind(id).first();
  if (!row) return null;
  const { results } = await db.prepare('SELECT seat, user_id FROM online_save_members WHERE save_id = ?1 ORDER BY seat').bind(id).all();
  return {
    id: row.id,
    createdAt: row.created_at,
    engine: row.engine,
    title: row.title,
    ticks: row.ticks,
    stateHash: row.state_hash,
    framesDigest: row.frames_digest,
    optionsDigest: row.options_digest,
    mapHash: row.map_hash,
    members: results.map((r) => ({ seat: r.seat, userId: r.user_id })),
  };
}

/**
 * Purging an account: the saves it played in go entirely (a save cannot be
 * resumed without every one of its players).
 */
export function purgeOnlineSavesStatement(db, userId) {
  return db.prepare('DELETE FROM online_saves WHERE id IN (SELECT save_id FROM online_save_members WHERE user_id = ?1)').bind(userId);
}

// Session directory in D1: one row per public lobby, kept fresh by the
// session's Durable Object. Listing shows public lobbies that are still in
// the lobby phase and were updated in the last two minutes.

import { coopMission } from '@webra/protocol';

export const LISTING_TTL_MS = 2 * 60 * 1000;
export const HEARTBEAT_MS = 60 * 1000;
const LIST_LIMIT = 100;

/** @param {{ id, name, host, public, locked, players, maxPlayers, map, version, state }} s */
export async function upsertSession(db, s, now = Date.now()) {
  await db
    .prepare(
      `INSERT INTO sessions (id, name, host, public, locked, players, max_players, map_json, version, state, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, host = excluded.host, public = excluded.public, locked = excluded.locked,
         players = excluded.players, max_players = excluded.max_players, map_json = excluded.map_json,
         version = excluded.version, state = excluded.state, updated_at = excluded.updated_at`,
    )
    .bind(
      s.id,
      s.name,
      s.host,
      s.public ? 1 : 0,
      s.locked ? 1 : 0,
      s.players,
      s.maxPlayers,
      s.map ? JSON.stringify(directoryMap(s.map)) : null,
      s.version,
      s.state,
      now,
    )
    .run();
}

/**
 * What the public session list says about a lobby's map: a community map
 * by id and hash; a map the host shared with the session only by its name
 * (its id, hash and author stay with the members, docs/security.md).
 */
export function directoryMap(map) {
  // A co-op mission lobby: the mission's id and title.
  if (map.mission) return { mission: map.mission, name: map.name };
  if (map.shared) return { name: map.name, modded: map.modded, shared: true };
  return { id: map.id, name: map.name, hash: map.hash, modded: map.modded };
}

export async function removeSession(db, id) {
  await db.prepare('DELETE FROM sessions WHERE id = ?1').bind(id).run();
}

function parseMapJson(text) {
  if (!text) return null;
  try {
    const m = JSON.parse(text);
    // A co-op mission: only one this version knows, under its own title (never the stored text).
    if (m.mission !== undefined) {
      const c = coopMission(m.mission);
      return c ? { mission: c.id, name: c.title, modded: false } : null;
    }
    if (m.shared === true) return { name: String(m.name), modded: m.modded === true, shared: true };
    return { id: String(m.id), name: String(m.name), hash: String(m.hash), modded: m.modded === true };
  } catch {
    return null;
  }
}

/** Public lobbies for GET /api/sessions. */
export async function listSessions(db, now = Date.now()) {
  const { results } = await db
    .prepare(
      `SELECT id, name, host, players, max_players, locked, map_json, version, state
       FROM sessions
       WHERE public = 1 AND state = 'lobby' AND updated_at > ?1 AND players < max_players
       ORDER BY updated_at DESC
       LIMIT ${LIST_LIMIT}`,
    )
    .bind(now - LISTING_TTL_MS)
    .all();
  return results.map((r) => ({
    id: r.id,
    name: r.name,
    host: r.host,
    players: r.players,
    maxPlayers: r.max_players,
    locked: r.locked === 1,
    map: parseMapJson(r.map_json),
    version: r.version,
    state: r.state,
  }));
}

/** Delete rows whose Durable Object stopped refreshing them long ago. */
export async function pruneSessions(db, now = Date.now()) {
  await db.prepare('DELETE FROM sessions WHERE updated_at < ?1').bind(now - 24 * 60 * 60 * 1000).run();
}

// Session directory in D1: one row per session, kept fresh by the session's
// Durable Object (every 60 s, and when something listed changes). Listing
// shows public sessions updated in the last two minutes, lobbies and running
// games, with a summary for the detail panel. Private sessions have rows too
// (never listed): invite codes and the friends list find them there.
//
// Reads are cached per isolate for a few seconds: every open server list
// asks every 10 s, and nothing in these answers is personal.

import { BUILTIN_MODES, coopMission, PRESENCE_ONLINE_MS, presetOptions } from '@webra/protocol';

export const LISTING_TTL_MS = 2 * 60 * 1000;
export const HEARTBEAT_MS = 60 * 1000;
const LIST_LIMIT = 100;
/** How long an isolate reuses the session list and the online count. */
export const LIST_CACHE_MS = 5 * 1000;
export const ONLINE_CACHE_MS = 30 * 1000;

/** Database binding -> key -> { at, value } (one binding per Worker; tests have several). */
let memo = new WeakMap();

/** `fn()`, or its answer from the last `ttlMs` (per isolate and database). */
async function cached(db, key, ttlMs, now, fn) {
  let byKey = memo.get(db);
  if (!byKey) {
    byKey = new Map();
    memo.set(db, byKey);
  }
  const hit = byKey.get(key);
  if (hit && now - hit.at < ttlMs && now >= hit.at) return hit.value;
  const value = await fn();
  byKey.set(key, { at: now, value });
  return value;
}

/** Forget the cached answers (tests). */
export function clearDirectoryCache() {
  memo = new WeakMap();
}

/**
 * The id of the built-in mode (protocol presets.js) whose options the lobby
 * has exactly, or 'custom'. Online lobbies never offer skirmish-only modes.
 */
export function modeOf(options) {
  const mine = JSON.stringify(presetOptions(options));
  const m = BUILTIN_MODES.find((x) => !x.skirmishOnly && JSON.stringify(presetOptions(x.options)) === mine);
  return m ? m.id : 'custom';
}

/** The options the detail panel shows. */
const SUMMARY_OPTIONS = ['startingCash', 'fog', 'techLevel', 'gameSpeed', 'crates', 'timeLimit'];

/**
 * What the directory says about a session beyond its row (`summary`): only
 * what anyone in a public lobby sees anyway. Players (slot holders and AIs)
 * with name, team and colour; how many spectators of how many places; the
 * mode id (null for a co-op mission); a few options; when the game started.
 */
export function sessionSummary(room, { startedAt = null } = {}) {
  const players = [];
  for (const s of room.slots) {
    if (s.type === 'human') players.push({ name: s.name, team: s.team, color: s.color });
    else if (s.type === 'ai') players.push({ name: room.aiNameOf(s), team: s.team, color: s.color, ai: true });
  }
  return {
    players,
    spectators: room.spectators.length,
    maxSpectators: room.maxSpectators,
    mode: room.mission ? null : modeOf(room.options),
    options: Object.fromEntries(SUMMARY_OPTIONS.map((k) => [k, room.options[k]])),
    ...(startedAt !== null ? { startedAt } : {}),
  };
}

function parseSummary(text) {
  if (!text) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) && Array.isArray(v.players) ? v : null;
  } catch {
    return null;
  }
}

/** @param {{ id, name, host, public, locked, players, maxPlayers, map, version, state, summary? }} s */
export async function upsertSession(db, s, now = Date.now()) {
  await db
    .prepare(
      `INSERT INTO sessions (id, name, host, public, locked, players, max_players, map_json, version, state, updated_at, summary_json)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, host = excluded.host, public = excluded.public, locked = excluded.locked,
         players = excluded.players, max_players = excluded.max_players, map_json = excluded.map_json,
         version = excluded.version, state = excluded.state, updated_at = excluded.updated_at,
         summary_json = excluded.summary_json`,
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
      s.summary ? JSON.stringify(s.summary) : null,
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

export function parseMapJson(text) {
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

/** A directory row as the API shows it (GET /api/sessions, invite lookups, the friends list). */
export function sessionView(r) {
  return {
    id: r.id,
    name: r.name,
    host: r.host,
    players: r.players,
    maxPlayers: r.max_players,
    locked: r.locked === 1,
    map: parseMapJson(r.map_json),
    version: r.version,
    state: r.state,
    summary: parseSummary(r.summary_json),
  };
}

/**
 * Public sessions for GET /api/sessions: open and full lobbies and running
 * games (`state`), newest first, at most 100.
 */
export async function listSessions(db, now = Date.now()) {
  return cached(db, 'list', LIST_CACHE_MS, now, async () => {
    const { results } = await db
      .prepare(
        `SELECT id, name, host, players, max_players, locked, map_json, version, state, summary_json
         FROM sessions
         WHERE public = 1 AND updated_at > ?1
         ORDER BY state = 'lobby' DESC, updated_at DESC
         LIMIT ${LIST_LIMIT}`,
      )
      .bind(now - LISTING_TTL_MS)
      .all();
    return results.map(sessionView);
  });
}

/**
 * GET /api/online: `players`, signed-in players with the game open (a
 * presence heartbeat in the last PRESENCE_ONLINE_MS) or in an online session,
 * plus anonymous members of online sessions; `lobbies` and `games`, the
 * sessions (public or not) in each phase. Counts only, cached per isolate.
 */
export async function onlineCounts(db, now = Date.now()) {
  return cached(db, 'online', ONLINE_CACHE_MS, now, async () => {
    const row = await db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM (
              SELECT user_id FROM user_presence WHERE seen_at > ?1
              UNION SELECT p.user_id FROM game_presence p JOIN sessions s ON s.id = p.session_id
                WHERE p.user_id IS NOT NULL AND s.updated_at > ?2)) AS accounts,
           (SELECT COUNT(*) FROM game_presence p JOIN sessions s ON s.id = p.session_id
              WHERE p.user_id IS NULL AND s.updated_at > ?2) AS anonymous,
           (SELECT COUNT(*) FROM sessions WHERE state = 'lobby' AND updated_at > ?2) AS lobbies,
           (SELECT COUNT(*) FROM sessions WHERE state = 'game' AND updated_at > ?2) AS games`,
      )
      .bind(now - PRESENCE_ONLINE_MS, now - LISTING_TTL_MS)
      .first();
    return { players: (row?.accounts ?? 0) + (row?.anonymous ?? 0), lobbies: row?.lobbies ?? 0, games: row?.games ?? 0 };
  });
}

/** Delete rows whose Durable Object stopped refreshing them long ago. */
export async function pruneSessions(db, now = Date.now()) {
  await db.prepare('DELETE FROM sessions WHERE updated_at < ?1').bind(now - 24 * 60 * 60 * 1000).run();
}

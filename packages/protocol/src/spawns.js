// Which spawn each player starts at (OpenRA MapStartingLocations with the
// lobby's spawn selection and the "Separate team spawns" option,
// docs/contracts.md section 3). The engine decides the same in
// engine/src/gamerules.rs `assign_spawns`; both run the shared cases in
// test/fixtures/spawn-cases.json. The lobbies use it to show on the map
// preview where each slot starts.
//
// A player who picked a spawn in the lobby (`spawn`, 0-based, like OpenRA's
// Session.Client.SpawnPoint minus one) starts there. Every other slot shows
// its spawn on the preview, so without the option (and in free for alls)
// slot k starts at spawn k when nobody picked it, else at the lowest spawn
// left free. With the option in a team game the players without a team do
// the same and team members take the spawns still free:
// - on generated maps team by team (in the order of each team's first slot,
//   members in slot order) in the order the generator lists its spawns (by
//   column, top first, so the halves of the list are mirrored sides);
// - on map files in slot order, each as far as possible from their enemies
//   (the most squared distance to the spawns enemies took so far, picked
//   ones included), then as close as possible to their team mates, then the
//   lowest spawn.
// A pick past the last spawn, or of a spawn an earlier slot picked, counts as
// no pick (spawnPickProblem refuses such a game).

import { MIN_PLAYERS } from './constants.js';

/**
 * How many players a generated map is made for when `players` take part:
 * never fewer than a game needs, so a host alone sees (and picks on) the
 * two player map the first guest keeps. The lobbies' previews and spawn
 * lists and the server's checks all use it.
 */
export function generatedMapPlayers(players) {
  return Math.max(MIN_PLAYERS, players);
}

/**
 * The spawns a lobby's battlefield has: none in a co-op mission (the mission
 * places everyone), a map file's own (`mapSpawns`), else one per player of
 * the generated map (generatedMapPlayers). The skirmish lobby, the online
 * lobby and the server all count with this.
 */
export function battlefieldSpawns({ mission = false, mapSpawns = null, players }) {
  if (mission) return 0;
  if (mapSpawns !== null && mapSpawns !== undefined) return mapSpawns;
  return generatedMapPlayers(players);
}

/** OpenRA's name of spawn `k` (0-based) on the preview and in the spawn lists: A, B, C... */
export function spawnLetter(k) {
  return String.fromCharCode(65 + k);
}

/**
 * @param {[number, number][]} spawns spawn cells
 * @param {{ team: number, spawn?: number | null }[]} players in slot order (closed slots left out)
 * @param {boolean} separate the separateTeamSpawns option
 * @param {boolean} [generated] a generated map (not a map file)
 * @returns {number[]} the spawn index of each player
 */
export function assignSpawns(spawns, players, separate, generated = false) {
  if (players.length > spawns.length) return players.map((_, k) => k);
  const out = players.map(() => -1);
  const taken = spawns.map(() => false);
  const free = () => taken.indexOf(false);
  // Picked spawns first.
  players.forEach((p, k) => {
    const s = p.spawn;
    if (Number.isInteger(s) && s >= 0 && s < spawns.length && !taken[s]) {
      out[k] = s;
      taken[s] = true;
    }
  });
  // Players who keep their slot's spawn (all, or those without a team in a
  // team game with separate team spawns): their own when free, else the lowest free.
  const teams = separate && players.some((p) => p.team !== 0);
  const own = players.flatMap((p, k) => (out[k] === -1 && !(teams && p.team !== 0) ? [k] : []));
  for (const k of own) {
    if (!taken[k]) {
      out[k] = k;
      taken[k] = true;
    }
  }
  for (const k of own) {
    if (out[k] !== -1) continue;
    out[k] = free();
    taken[out[k]] = true;
  }
  const allied = (a, b) => a === b || (players[a].team !== 0 && players[a].team === players[b].team);
  const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
  // Team members: on generated maps team by team, on map files in slot order.
  const order = [];
  players.forEach((p, k) => {
    if (out[k] !== -1 || order.includes(k)) return;
    if (generated) players.forEach((q, j) => j >= k && out[j] === -1 && q.team === p.team && order.push(j));
    else order.push(k);
  });
  for (const k of order) {
    if (generated) {
      out[k] = free();
      taken[out[k]] = true;
      continue;
    }
    let best = null;
    spawns.forEach((cell, s) => {
      if (taken[s]) return;
      let enemy = 0;
      let ally = 0;
      out.forEach((os, o) => {
        if (os === -1) return;
        if (allied(k, o)) ally += d2(cell, spawns[os]);
        else enemy += d2(cell, spawns[os]);
      });
      // Most distance to enemies, least to team mates, lowest spawn.
      if (!best || enemy > best.enemy || (enemy === best.enemy && ally < best.ally)) best = { enemy, ally, s };
    });
    out[k] = best.s;
    taken[best.s] = true;
  }
  return out;
}

/**
 * Why the players' picked spawns (`spawn` of each, in slot order) cannot
 * start on a map with `count` spawns, or null: a pick past the last spawn
 * or two players on one (engine/src/gamerules.rs spawn_pick_problem).
 */
export function spawnPickProblem(players, count) {
  const seen = new Set();
  for (const [k, p] of players.entries()) {
    if (p.spawn === undefined || p.spawn === null) continue;
    if (!Number.isInteger(p.spawn) || p.spawn < 0) return `Player ${k + 1} has an invalid start position.`;
    if (p.spawn >= count) return `Player ${k + 1} picked start position ${spawnLetter(p.spawn)}; this map has ${count}.`;
    if (seen.has(p.spawn)) return `Two players picked start position ${spawnLetter(p.spawn)}.`;
    seen.add(p.spawn);
  }
  return null;
}

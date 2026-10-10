// Which spawn each player starts at (OpenRA MapStartingLocations with the
// "Separate team spawns" option, docs/contracts.md section 3). The engine
// decides the same in engine/src/gamerules.rs `assign_spawns`; both run the
// shared cases in test/fixtures/spawn-cases.json. The lobbies use it to put
// each slot's number on the spawn it will start at.
//
// Every slot shows its spawn on the map preview, like a spawn point a player
// picked in OpenRA, so without the option (and in free for alls) slot k
// starts at spawn k. With the option in a team game the players without a
// team keep their own spawn and team members take the free spawns:
// - on generated maps team by team (in the order of each team's first slot,
//   members in slot order) in the order the generator lists its spawns (by
//   column, top first, so the halves of the list are mirrored sides);
// - on map files in slot order, each as far as possible from their enemies
//   (the most squared distance to the spawns enemies took so far), then as
//   close as possible to their team mates, then the lowest spawn.

/**
 * @param {[number, number][]} spawns spawn cells
 * @param {{ team: number }[]} players in slot order (closed slots left out)
 * @param {boolean} separate the separateTeamSpawns option
 * @param {boolean} [generated] a generated map (not a map file)
 * @returns {number[]} the spawn index of each player
 */
export function assignSpawns(spawns, players, separate, generated = false) {
  const identity = players.map((_, k) => k);
  if (!separate || players.length > spawns.length || !players.some((p) => p.team !== 0)) return identity;
  const allied = (a, b) => a === b || (players[a].team !== 0 && players[a].team === players[b].team);
  const out = players.map(() => -1);
  const taken = spawns.map(() => false);
  players.forEach((p, k) => {
    if (p.team === 0) {
      out[k] = k;
      taken[k] = true;
    }
  });
  const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
  // Team members: on generated maps team by team, on map files in slot order.
  const order = [];
  players.forEach((p, k) => {
    if (p.team === 0 || order.includes(k)) return;
    if (generated) players.forEach((q, j) => j >= k && q.team === p.team && order.push(j));
    else order.push(k);
  });
  for (const k of order) {
    if (generated) {
      const s = taken.indexOf(false);
      out[k] = s;
      taken[s] = true;
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
      if (!best || enemy > best.enemy || (enemy === best.enemy && -ally > -best.ally)) best = { enemy, ally, s };
    });
    out[k] = best.s;
    taken[best.s] = true;
  }
  return out;
}

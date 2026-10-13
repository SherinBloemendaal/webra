//! Game rules behind the lobby options, like OpenRA's: which spawn each
//! player starts at (MapStartingLocations, separate team spawns), the
//! starting units (StartingUnits, SpawnStartingUnits), who has lost
//! (ConquestVictoryConditions with MustBeDestroyed and the short game
//! option, OwnerLostAction), the time limit (TimeLimitManager), kill bounties
//! (GivesBounty), handicaps (Handicap*Multiplier) and player experience
//! (PlayerExperience, the time limit's tie breaker).
//!
//! Everything here is simulation state or decided by it: the same on every
//! lockstep peer, in skirmish, replays and saves.

use crate::rules::{Domain, Kind};
use crate::rules_options::OwnerLost;
use crate::sound_events::SoundEventKind;
use crate::world::{cell_center, PlayerSetup, StartingUnits, World, NONE};

/// Highest handicap in percent (OpenRA: 0 to 95 in steps of 5).
pub const MAX_HANDICAP: u8 = 95;
/// Handicap steps.
pub const HANDICAP_STEP: u8 = 5;

/// OpenRA MapStartingLocations with WebRA's lobby: a player who picked a
/// spawn in the lobby (OpenRA's spawn selection, `PlayerSetup::spawn`)
/// starts there. Every other slot shows its spawn on the map preview, so
/// without the option (and in free for alls) slot `k` starts at spawn `k`
/// when nobody picked that spawn, else at the lowest spawn left free.
/// With "Separate team spawns" in a team game the players without a team
/// do the same and the team members take the spawns still free:
/// - on generated maps team by team (in the order of each team's first slot,
///   members in slot order) in the order the generator lists its spawns (by
///   column, top first: consecutive spawns are neighbours, and splitting the
///   list in halves is a mirror match, docs/contracts.md section 3), so teams
///   start together on fair, mirrored sides;
/// - on map files in slot order, each as far as possible from the enemies
///   placed so far (the most squared distance to their spawns, OpenRA's
///   measure; players who picked their spawn count as placed), then as close
///   as possible to team mates, then the lowest spawn.
///
/// A pick past the last spawn, or of a spawn an earlier slot picked, counts
/// as no pick (`spawn_pick_problem` refuses such games at the start).
/// packages/protocol `assignSpawns` computes the same for the lobby markers;
/// both run the cases of packages/protocol/test/fixtures/spawn-cases.json.
pub fn assign_spawns(spawns: &[(i32, i32)], players: &[PlayerSetup], separate: bool, generated: bool) -> Vec<usize> {
    if players.len() > spawns.len() {
        return (0..players.len()).collect();
    }
    let mut out = vec![usize::MAX; players.len()];
    let mut taken = vec![false; spawns.len()];
    // Picked spawns first.
    for (k, p) in players.iter().enumerate() {
        if let Some(s) = p.spawn.map(usize::from).filter(|&s| s < spawns.len() && !taken[s]) {
            out[k] = s;
            taken[s] = true;
        }
    }
    // Players who keep their slot's spawn: everyone, or with separate team
    // spawns in a team game those without a team. Their own spawn when it is
    // free, else (in slot order) the lowest free one.
    let teams = separate && players.iter().any(|p| p.team != 0);
    let own: Vec<usize> = (0..players.len()).filter(|&k| out[k] == usize::MAX && !(teams && players[k].team != 0)).collect();
    for &k in &own {
        if !taken[k] {
            out[k] = k;
            taken[k] = true;
        }
    }
    for &k in &own {
        if out[k] == usize::MAX {
            let s = (0..spawns.len()).find(|&s| !taken[s]).expect("a free spawn for every player");
            out[k] = s;
            taken[s] = true;
        }
    }
    // Team members: on generated maps team by team, in the order of each
    // team's first slot; on map files in slot order.
    let mut order: Vec<usize> = Vec::new();
    for (k, p) in players.iter().enumerate() {
        if out[k] != usize::MAX || order.contains(&k) {
            continue;
        }
        if generated {
            order.extend((k..players.len()).filter(|&j| out[j] == usize::MAX && players[j].team == p.team));
        } else {
            order.push(k);
        }
    }
    let d2 = |a: (i32, i32), b: (i32, i32)| {
        let (dx, dy) = ((a.0 - b.0) as i64, (a.1 - b.1) as i64);
        dx * dx + dy * dy
    };
    for k in order {
        let s = if generated {
            (0..spawns.len()).find(|&s| !taken[s]).expect("a free spawn for every player")
        } else {
            let mut best: Option<(i64, i64, usize)> = None;
            for (s, &cell) in spawns.iter().enumerate() {
                if taken[s] {
                    continue;
                }
                let (mut enemy, mut ally) = (0i64, 0i64);
                for (o, &os) in out.iter().enumerate() {
                    if os == usize::MAX {
                        continue;
                    }
                    if players[o].team == players[k].team {
                        ally += d2(cell, spawns[os]);
                    } else {
                        enemy += d2(cell, spawns[os]);
                    }
                }
                // Most distance to enemies, least to team mates, lowest spawn.
                if best.is_none_or(|(be, ba, _)| enemy > be || (enemy == be && ally < ba)) {
                    best = Some((enemy, ally, s));
                }
            }
            best.expect("a free spawn for every player").2
        };
        out[k] = s;
        taken[s] = true;
    }
    out
}

/// Why the spawns the players picked cannot start a game on a map with
/// `spawns` spawns, or None: a pick past the last spawn, or two players on
/// one spawn (the lobbies never send either; packages/protocol checks the
/// same as far as it can without the map).
pub fn spawn_pick_problem(players: &[PlayerSetup], spawns: usize) -> Option<String> {
    let mut seen = vec![false; spawns];
    for (k, p) in players.iter().enumerate() {
        let Some(s) = p.spawn.map(usize::from) else { continue };
        if s >= spawns {
            return Some(format!("player {} picked spawn {}; this map has {spawns}", k + 1, s + 1));
        }
        if seen[s] {
            return Some(format!("two players picked spawn {}", s + 1));
        }
        seen[s] = true;
    }
    None
}

impl World {
    // ---- Starting units ----------------------------------------------------------

    /// OpenRA SpawnStartingUnits: the base actor (an MCV) at the player's home
    /// and the support actors of a StartingUnits set of the lobby class and
    /// the player's faction on random free cells of the ring between
    /// `inner_radius + 1` and `outer_radius` cells, each where it can reach
    /// the base. WebRA's own "Construction Yard" option deploys the base.
    /// Support types WebRA does not have yet are left out of the sets
    /// (rules_options.rs).
    pub(crate) fn spawn_start(&mut self, player: u8) {
        let (sx, sy) = self.players[player as usize].start;
        if self.options.starting_units == StartingUnits::Base {
            if let Some(fact) = self.rules.actor_index("FACT") {
                self.spawn_building(fact as u16, player, sx, sy);
            }
            return;
        }
        let class = match self.options.starting_units {
            StartingUnits::Light => "light",
            StartingUnits::Heavy => "heavy",
            _ => "none",
        };
        let faction = self.players[player as usize].faction;
        let sets: Vec<usize> = (0..self.rules.world.starting_units.len())
            .filter(|&k| {
                let s = &self.rules.world.starting_units[k];
                s.class == class && s.factions.contains(&faction)
            })
            .collect();
        // OpenRA picks one of the matching sets (RandomOrDefault).
        let Some(&set) = (if sets.is_empty() { None } else { sets.get(self.rng.range(0, sets.len() as i32) as usize) }) else {
            return;
        };
        let info = self.rules.world.starting_units[set].clone();
        // The MCV stands in the middle of where its Construction Yard will be.
        let home = (sx + 1, sy + 1);
        if let Some(base) = info.base_actor {
            self.spawn_unit(base as u16, player, cell_center(home.0), cell_center(home.1), info.base_facing);
        }
        let ring = self.cells_in_annulus(home, info.inner_radius + 1, info.outer_radius);
        let mut used: Vec<(i32, i32)> = vec![home];
        for &ty in &info.support_actors {
            let domain = self.rules.actors[ty].unit.as_ref().map_or(Domain::Ground, |u| self.rules.locomotors[u.locomotor].domain);
            let infantry = self.rules.actors[ty].kind == Kind::Infantry;
            let valid: Vec<(i32, i32)> = ring
                .iter()
                .copied()
                .filter(|&(x, y)| {
                    let ci = self.map.idx(x, y);
                    let pass = self.pass_for(domain);
                    let hi = self.map.idx(home.0, home.1);
                    !pass.blocked[ci]
                        && self.building_at[ci] == NONE
                        // OpenRA PathMightExistForLocomotorBlockedByImmovable: same area as the base.
                        && (domain == Domain::Air || pass.component[ci] == pass.component[hi])
                        // Infantry share cells (sub-cells); vehicles do not.
                        && (infantry || !used.contains(&(x, y)))
                })
                .collect();
            if valid.is_empty() {
                continue;
            }
            let (x, y) = valid[self.rng.range(0, valid.len() as i32) as usize];
            let facing = self.rng.range(0, 1024);
            self.spawn_unit(ty as u16, player, cell_center(x), cell_center(y), facing);
            used.push((x, y));
        }
    }

    /// Map cells whose distance from `c` (rounded up, like OpenRA's
    /// TilesByDistance) is `min..=max` cells, nearest rings first.
    pub(crate) fn cells_in_annulus(&self, c: (i32, i32), min: i32, max: i32) -> Vec<(i32, i32)> {
        let mut out = Vec::new();
        for r in min.max(0)..=max {
            for dy in -max..=max {
                for dx in -max..=max {
                    let d2 = dx * dx + dy * dy;
                    // ceil(sqrt(d2)) == r
                    let root = crate::math::isqrt(d2 as i64) as i32;
                    let ring = if root * root < d2 { root + 1 } else { root };
                    let (x, y) = (c.0 + dx, c.1 + dy);
                    if ring == r && self.map.contains(x, y) {
                        out.push((x, y));
                    }
                }
            }
        }
        out
    }

    // ---- Victory and defeat ----------------------------------------------------------

    /// OpenRA Player.HasNoRequiredUnits: no actor with MustBeDestroyed left
    /// (with the short game option only those RequiredForShortGame, wherever
    /// they are; otherwise those in the world, not passengers).
    pub fn has_no_required_units(&self, player: u8) -> bool {
        let short = self.options.short_game;
        // A mission's structures beyond the playable area are in OpenRA's world too.
        let offmap = self.offmap.iter().any(|s| {
            s.owner == player && self.rules.actors[s.ty as usize].options.must_be_destroyed.is_some_and(|required| required || !short)
        });
        !offmap
            && !self.actors.iter().any(|a| {
                a.alive
                    && a.owner == player
                    && match self.rules.actors[a.ty as usize].options.must_be_destroyed {
                        Some(required) => {
                            if short {
                                required
                            } else {
                                a.in_world()
                            }
                        }
                        None => false,
                    }
            })
    }

    /// OpenRA ConquestVictoryConditions, checked once a second: a player
    /// without required units loses (its actors meet their OwnerLostAction);
    /// the game ends when the players left are all on one side.
    pub(crate) fn check_victory(&mut self) {
        if self.stress || self.game_over {
            return;
        }
        for p in 0..self.players.len() as u8 {
            let pl = &self.players[p as usize];
            if !pl.neutral && !pl.defeated && self.has_no_required_units(p) {
                self.lose(p);
            }
        }
        self.decide_winner();
    }

    /// The game ends when every remaining player is on the same side.
    fn decide_winner(&mut self) {
        if self.game_over {
            return;
        }
        let remaining: Vec<u8> =
            (0..self.players.len() as u8).filter(|&p| !self.players[p as usize].defeated && !self.players[p as usize].neutral).collect();
        let playing = self.players.iter().filter(|p| !p.neutral).count();
        if playing > 1 && !remaining.is_empty() && remaining.iter().all(|&p| self.are_allies(p, remaining[0])) {
            self.winner = Some(remaining[0]);
            self.game_over = true;
            self.note_game_end();
            // OpenRA marks every remaining player's objective completed: one line each.
            for &p in &remaining {
                self.sound.push(SoundEventKind::PlayerWon, 0, 0, 0, p, 0);
            }
        } else if playing > 1 && remaining.is_empty() {
            // Everyone lost at once: no winner, the game is still over.
            self.game_over = true;
            self.note_game_end();
        }
    }

    /// `player` lost: mark it defeated and apply OwnerLostAction to what it
    /// owns (units and structures are destroyed, walls and husks go to the
    /// neutral player, when the game has one).
    pub(crate) fn lose(&mut self, player: u8) {
        if self.players[player as usize].defeated {
            return;
        }
        self.players[player as usize].defeated = true;
        self.note_defeated(player);
        let neutral = self.neutral_player();
        for i in 0..self.actors.len() {
            let a = &self.actors[i];
            if !a.alive || a.owner != player {
                continue;
            }
            match self.rules.actors[a.ty as usize].options.owner_lost {
                Some(OwnerLost::Kill) => {
                    // Passengers die with their transport (or get out of it, cargo.rs).
                    if self.actors[i].in_world() {
                        self.with_damage_source(player, |w| w.kill(i));
                    }
                }
                Some(OwnerLost::Dispose) => self.remove(i),
                Some(OwnerLost::ChangeOwner) => {
                    if let Some(n) = neutral {
                        self.change_owner(i, n, true);
                    }
                }
                None => {}
            }
        }
        self.sound.push(SoundEventKind::PlayerLost, 0, 0, 0, player, 0);
    }

    /// The neutral player, if the game has one.
    pub fn neutral_player(&self) -> Option<u8> {
        self.players.iter().position(|p| p.neutral).map(|p| p as u8)
    }

    // ---- Time limit ---------------------------------------------------------------

    /// Ticks a second at the game's speed (OpenRA `1000 / Timestep`).
    pub fn ticks_per_real_second(&self) -> i64 {
        (1000 / self.options.tick_ms.clamp(1, 1000)) as i64
    }

    /// The time limit in ticks, or None without one.
    pub fn time_limit_ticks(&self) -> Option<i64> {
        (self.options.time_limit > 0).then(|| self.options.time_limit as i64 * 60 * self.ticks_per_real_second())
    }

    /// OpenRA TimeLimitManager: warnings at the minutes of `world.time_limit`
    /// (sound events for the announcer and the message line), and when time
    /// runs out ConquestVictoryConditions.NotifyTimerExpired decides.
    pub(crate) fn tick_time_limit(&mut self) {
        let Some(limit) = self.time_limit_ticks() else { return };
        if self.game_over {
            return;
        }
        let left = limit - self.tick as i64;
        if left == 0 {
            self.sound.push(SoundEventKind::TimeLimitExpired, 0, 0, 0, crate::sound_events::ALL_PLAYERS, 0);
            self.time_limit_expired();
            return;
        }
        let tps = self.ticks_per_real_second();
        for k in 0..self.rules.world.time_limit.warnings.len() {
            let m = self.rules.world.time_limit.warnings[k] as i64;
            if left == m * 60 * tps {
                self.sound.push(SoundEventKind::TimeLimitWarning, m as i32, 0, 0, crate::sound_events::ALL_PLAYERS, 0);
            }
        }
    }

    /// OpenRA ConquestVictoryConditions.NotifyTimerExpired: players sorted by
    /// experience, grouped by team (every player without a team in one group
    /// of team 0); the group with the most experience in total wins: all of a
    /// team, or of team 0 only its most experienced player. Everyone else
    /// loses. Players that had already lost stay lost.
    pub(crate) fn time_limit_expired(&mut self) {
        let mut order: Vec<u8> = (0..self.players.len() as u8).filter(|&p| !self.players[p as usize].neutral).collect();
        // Stable sort: equal experience keeps the player order.
        order.sort_by_key(|&p| std::cmp::Reverse(self.players[p as usize].experience));
        let mut groups: Vec<(u8, Vec<u8>)> = Vec::new();
        for &p in &order {
            let team = self.players[p as usize].team;
            match groups.iter_mut().find(|g| g.0 == team) {
                Some(g) => g.1.push(p),
                None => groups.push((team, vec![p])),
            }
        }
        let sum = |g: &(u8, Vec<u8>)| g.1.iter().map(|&p| self.players[p as usize].experience).sum::<i64>();
        let Some(best) = groups.iter().enumerate().max_by_key(|(k, g)| (sum(g), std::cmp::Reverse(*k))).map(|(_, g)| g.clone()) else {
            return;
        };
        let winners: Vec<u8> = if best.0 == 0 { vec![best.1[0]] } else { best.1.clone() };
        for p in 0..self.players.len() as u8 {
            if !self.players[p as usize].neutral && !winners.contains(&p) {
                self.lose(p);
            }
        }
        self.decide_winner();
        // A winner that had already lost wins nothing: the game ends without one.
        if !self.game_over {
            self.game_over = true;
            self.note_game_end();
        }
    }

    // ---- Kill bounties ----------------------------------------------------------------

    /// OpenRA GivesBounty.Killed: with the kill bounties option, the killing
    /// player (an enemy or neutral one) gets `gives_bounty` percent of the
    /// victim's value; the floating text also counts the passengers' bounties.
    pub(crate) fn give_bounty(&mut self, victim: usize) {
        if !self.options.bounty {
            return;
        }
        let Some(killer) = self.observer.source else { return };
        let owner = self.actors[victim].owner;
        if killer as usize >= self.players.len() || self.are_allies(killer, owner) {
            return;
        }
        let Some(amount) = self.bounty_value(victim) else { return };
        let mut shown = amount;
        for &p in &self.actors[victim].cargo {
            if let Some(pi) = self.resolve(p) {
                shown += self.bounty_value(pi).unwrap_or(0);
            }
        }
        self.players[killer as usize].cash += amount;
        if self.actors[victim].in_world() && shown != 0 {
            let (x, y) = (self.actors[victim].x, self.actors[victim].y);
            self.sound.push(SoundEventKind::Bounty, shown, x, y, killer, 0);
        }
    }

    /// GivesBounty value of actor `i` (its sell value times the percentage), or None.
    fn bounty_value(&self, i: usize) -> Option<i32> {
        let info = &self.rules.actors[self.actors[i].ty as usize];
        let pct = info.options.gives_bounty?;
        // OpenRA GetSellValue: CustomSellValue, else the cost.
        let value = info.building.as_ref().map_or(info.cost, |b| b.value);
        Some((value as i64 * pct as i64 / 100) as i32)
    }

    // ---- Handicaps ---------------------------------------------------------------------

    /// Owner handicap of actor `i` in percent, if it has the handicap traits.
    fn handicap_of(&self, i: usize) -> i32 {
        let a = &self.actors[i];
        if self.rules.actors[a.ty as usize].options.handicaps {
            self.players.get(a.owner as usize).map_or(0, |p| p.handicap)
        } else {
            0
        }
    }

    /// HandicapFirepowerMultiplier: `100 - handicap` percent.
    pub(crate) fn handicap_firepower(&self, i: usize) -> i32 {
        100 - self.handicap_of(i)
    }

    /// HandicapDamageMultiplier: `10000 / (100 - handicap)` percent (5 % handicap: 105 % damage taken).
    pub(crate) fn handicap_damage(&self, i: usize) -> i32 {
        10000 / (100 - self.handicap_of(i)).max(1)
    }

    /// HandicapProductionTimeMultiplier: `100 + handicap` percent of the build
    /// time of `ty` for `player` (the item's own trait).
    pub(crate) fn handicap_build_time(&self, player: u8, ty: u16, ticks: i32) -> i32 {
        if !self.rules.actors[ty as usize].options.handicaps {
            return ticks;
        }
        let h = self.players.get(player as usize).map_or(0, |p| p.handicap);
        (ticks as i64 * (100 + h) as i64 / 100) as i32
    }

    // ---- Player experience ----------------------------------------------------------------

    /// OpenRA PlayerExperience.GiveExperience.
    pub(crate) fn give_player_experience(&mut self, player: u8, amount: i64) {
        if let Some(p) = self.players.get_mut(player as usize) {
            p.experience = p.experience.saturating_add(amount);
        }
    }
}

//! Crates, like OpenRA's (CrateSpawner in world.yaml, ^Crate and the CRATE
//! actions in misc.yaml, the *CrateAction traits).
//!
//! With the crates lobby option the spawner waits `initial_delay` ticks, then
//! every `spawn_interval` ticks tops the crates on the map up to `minimum`
//! and adds one more while there are fewer than `maximum`. Each new crate
//! goes to a random free cell (land, or water with `water_chance` percent)
//! and is flown in by a Badger of the neutral player, dropped over its cell
//! and lands on a parachute. A crate lies for `duration` ticks. A unit whose
//! locomotor crushes `crate` picks it up by driving onto it; the crate rolls
//! one of its actions weighted by their shares for that collector (cash,
//! a level up, an explosion, the map hidden or revealed, healing, copies of
//! the collector, an MCV when the player has no base left, units and
//! squads, invulnerability).
//!
//! Crate types WebRA does not have yet are left out of the action lists
//! (rules_options.rs): a squad of soldiers comes without the medic until
//! the medic exists. Everything here is simulation state and uses the shared
//! RNG; sounds and the pickup animation are sound events
//! (`SoundEventKind::CrateCollected` with the action class code).

use crate::map::Terrain;
use crate::math::{dist_sq, facing_vec, CELL};
use crate::rules::{Domain, Kind};
use crate::rules_options::{CrateAction, CrateActionKind};
use crate::sound_events::SoundEventKind;
use crate::world::{cell_center, World, NONE};

/// Most attempts at finding a drop cell (OpenRA ChooseDropCell maxTries).
const DROP_TRIES: i32 = 100;
/// Parachutable.FallRate of ^Crate: world units per tick.
pub const CRATE_FALL_RATE: i32 = 26;
/// A unit collects a crate once it is this close to the cell's centre
/// (OpenRA crushes on reaching the cell, like mines: abilities.rs).
const COLLECT_REACH: i32 = CELL / 3;

/// Spawner state.
#[derive(Clone, Default, Debug)]
pub struct CrateState {
    enabled: bool,
    /// Ticks until the spawner acts again.
    ticks: i32,
    /// Crates in the world (landed or under their parachute).
    pub count: i32,
}

impl CrateState {
    pub fn new(rules: &crate::rules::Rules, enabled: bool) -> CrateState {
        CrateState { enabled, ticks: rules.world.crates.initial_delay, count: 0 }
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    pub(crate) fn hash(&self) -> i64 {
        ((self.ticks as i64) << 16) ^ self.count as i64 ^ ((self.enabled as i64) << 40)
    }
}

/// OpenRA terrain type names that match cell `ci`: an ore or gem cell is
/// `Ore` or `Gems` (the resource layer's type), clear ground also `Road`,
/// rough ground also `Beach`.
pub(crate) fn terrain_names(w: &World, ci: usize) -> &'static [&'static str] {
    if w.map.ore[ci] > 0 {
        return &["Ore"];
    }
    if w.map.gems[ci] > 0 {
        return &["Gems"];
    }
    match w.map.terrain[ci] {
        // Older maps without roads and beaches drew them as clear and rough ground.
        Terrain::Clear => &["Clear", "Road"],
        Terrain::Rough => &["Rough", "Beach"],
        Terrain::Rock => &["Rock"],
        Terrain::Water => &["Water"],
        Terrain::Tree => &["Tree"],
        Terrain::Ford | Terrain::River => &["River"],
        Terrain::Road => &["Road"],
        Terrain::Bridge => &["Bridge"],
        Terrain::Beach => &["Beach"],
        Terrain::Wall => &["Wall"],
    }
}

fn matches(names: &[String], cell: &[&str]) -> bool {
    names.iter().any(|n| cell.contains(&n.as_str()))
}

impl World {
    /// The landed or falling crate on cell `ci`.
    pub fn crate_at(&self, ci: usize) -> Option<usize> {
        let r = *self.leftover_at.crates.get(ci)?;
        self.resolve(r).filter(|&c| self.actors[c].kind == Kind::Crate)
    }

    /// Whether anything stands on cell `ci` (OpenRA ActorMap: units, structures,
    /// husks, mines, crates).
    pub(crate) fn cell_has_actor(&self, ci: usize) -> bool {
        self.units_in_cell(ci).iter().any(|&u| self.actors[u as usize].alive && self.actors[u as usize].altitude == 0)
            || self.building_at[ci] != NONE
            || self.husk_at(ci).is_some()
            || self.mine_at(ci).is_some()
            || self.crate_at(ci).is_some()
    }

    // ---- Spawner -------------------------------------------------------------------------

    /// Every tick: the spawner, then crates falling and lying.
    pub(crate) fn tick_crates(&mut self) {
        if self.crates.enabled {
            self.crates.ticks -= 1;
            if self.crates.ticks <= 0 {
                let c = &self.rules.world.crates;
                self.crates.ticks = c.spawn_interval;
                let n = self.crates.count;
                let to_spawn = (c.minimum - n).max(0) + i32::from(n < c.maximum && c.maximum > c.minimum);
                for _ in 0..to_spawn {
                    self.spawn_crate();
                }
            }
        }
        for i in 0..self.actors.len() {
            let a = &self.actors[i];
            if !a.alive || a.kind != Kind::Crate {
                continue;
            }
            if a.air.parachute {
                self.tick_falling_crate(i);
                continue;
            }
            let duration = self.rules.actors[a.ty as usize].options.crate_info.as_ref().map_or(0, |c| c.duration);
            let a = &mut self.actors[i];
            a.leftover.ticks += 1;
            if duration != 0 && a.leftover.ticks >= duration {
                self.remove(i);
            }
        }
    }

    /// OpenRA CrateSpawner.SpawnCrate: a drop cell, a crate type, and the
    /// delivery plane (or the crate itself without one).
    pub(crate) fn spawn_crate(&mut self) {
        let in_water = self.rng.range(0, 100) < self.rules.world.crates.water_chance;
        let Some(ci) = self.choose_drop_cell(in_water) else { return };
        let ty = self.choose_crate_actor();
        let Some(neutral) = self.neutral_player() else { return };
        let (cx, cy) = ((ci % self.map.width as usize) as i32, (ci / self.map.width as usize) as i32);
        match self.rules.world.crates.delivery_aircraft {
            Some(plane) => self.launch_crate_plane(plane, neutral, ty, cx, cy),
            None => {
                self.place_crate(ty, neutral, cx, cy, 0);
            }
        }
    }

    /// OpenRA ChooseDropCell: random map cells of the right terrain with nothing on them.
    pub(crate) fn choose_drop_cell(&mut self, in_water: bool) -> Option<usize> {
        for _ in 0..DROP_TRIES {
            let x = self.rng.range(0, self.map.width);
            let y = self.rng.range(0, self.map.height);
            let ci = self.map.idx(x, y);
            let c = &self.rules.world.crates;
            let valid = if in_water { &c.valid_water } else { &c.valid_ground };
            if !matches(valid, terrain_names(self, ci)) || self.cell_has_actor(ci) {
                continue;
            }
            return Some(ci);
        }
        None
    }

    /// OpenRA ChooseCrateActor: weighted by CrateActorShares.
    pub(crate) fn choose_crate_actor(&mut self) -> usize {
        let c = &self.rules.world.crates;
        let total: i32 = c.shares.iter().sum();
        let n = self.rng.range(0, total.max(1));
        let mut cumulative = 0;
        for (k, &s) in c.shares.iter().enumerate() {
            cumulative += s;
            if n <= cumulative {
                return c.actors[k];
            }
        }
        c.actors[0]
    }

    /// The delivery plane: from beyond the map edge (Cordon) on a quantized
    /// facing, straight over the drop cell and off the other side.
    pub(crate) fn launch_crate_plane(&mut self, plane: usize, owner: u8, crate_ty: usize, cx: i32, cy: i32) {
        let q = self.rules.world.crates.quantized_facings.max(1);
        let facing = 1024 * self.rng.range(0, q) / q;
        let (vx, vy) = facing_vec(facing);
        let (tx, ty) = (cell_center(cx), cell_center(cy));
        // Back along the flight path until outside the map, then the cordon.
        let (w, h) = (self.map.width * CELL, self.map.height * CELL);
        let inside = |d: i32| {
            let (px, py) = (tx - vx * d / 1024, ty - vy * d / 1024);
            px >= 0 && py >= 0 && px < w && py < h
        };
        let mut back = 0;
        let max = (self.map.width.max(self.map.height) + 4) * CELL;
        while back < max && inside(back) {
            back += CELL / 2;
        }
        back += self.rules.world.crates.cordon;
        let (sx, sy) = (tx - vx * back / 1024, ty - vy * back / 1024);
        let cruise = self.rules.actors[plane].unit.as_ref().and_then(|u| u.aircraft.as_ref()).map_or(CELL, |a| a.cruise_altitude);
        let u = self.spawn_unit(plane as u16, owner, sx, sy, facing);
        let a = &mut self.actors[u];
        a.altitude = cruise;
        a.air.mission = crate::plane::Mission::CrateDrop;
        a.air.tx = tx;
        a.air.ty = ty;
        a.air.cargo = vec![crate_ty as u16];
    }

    /// Called by a delivery plane over its drop cell (plane.rs): the crate
    /// leaves the plane when the cell is still free (OpenRA ParaDrop with
    /// checkForSuitableCell), at the plane's height, and parachutes down.
    pub(crate) fn drop_crate(&mut self, plane: usize) {
        let a = &self.actors[plane];
        let Some(&ty) = a.air.cargo.first() else { return };
        let (cx, cy) = self.cell_of(a.x, a.y);
        let (alt, owner) = (a.altitude, a.owner);
        let ci = self.map.idx(cx, cy);
        self.actors[plane].air.cargo.clear();
        let info = self.rules.actors[ty as usize].options.crate_info.as_ref();
        if info.is_none_or(|c| !matches(&c.terrain, terrain_names(self, ci))) || self.crate_at(ci).is_some() || self.building_at[ci] != NONE
        {
            return;
        }
        self.place_crate(ty as usize, owner, cx, cy, alt);
    }

    /// A crate in the world at cell (cx, cy), `altitude` above it (falling on its parachute).
    pub(crate) fn place_crate(&mut self, ty: usize, owner: u8, cx: i32, cy: i32, altitude: i32) -> usize {
        let c = self.spawn_unit(ty as u16, owner, cell_center(cx), cell_center(cy), 512);
        self.actors[c].altitude = altitude;
        self.actors[c].air.parachute = altitude > 0;
        let ci = self.map.idx(cx, cy);
        self.leftover_at.crates[ci] = self.make_ref(c);
        self.crates.count += 1;
        c
    }

    /// Parachute: sink at FallRate, then OpenRA Crate.OnLanded: a unit that
    /// can collect it there does; anything else there destroys the crate.
    pub(crate) fn tick_falling_crate(&mut self, c: usize) {
        let a = &mut self.actors[c];
        a.altitude -= CRATE_FALL_RATE;
        if a.altitude > 0 {
            return;
        }
        a.altitude = 0;
        a.air.parachute = false;
        let ci = self.cell_index(self.actors[c].x, self.actors[c].y);
        let collector = self
            .units_in_cell(ci)
            .iter()
            .map(|&u| u as usize)
            .find(|&u| self.actors[u].alive && self.actors[u].altitude == 0 && self.collects_crates(u));
        if let Some(u) = collector {
            self.collect_crate(c, u);
        } else if self.units_in_cell(ci).iter().any(|&u| self.actors[u as usize].alive && self.actors[u as usize].altitude == 0)
            || self.building_at[ci] != NONE
            || self.husk_at(ci).is_some()
            || self.mine_at(ci).is_some()
        {
            self.remove(c);
        }
    }

    /// A crate left the world: free its cell and the spawner's count.
    pub(crate) fn crate_removed(&mut self, c: usize) {
        let a = &self.actors[c];
        let ci = self.cell_index(a.x, a.y);
        let me = crate::world::idx_ref(c, a.gen);
        if self.leftover_at.crates[ci] == me {
            self.leftover_at.crates[ci] = NONE;
            self.crates.count -= 1;
        }
    }

    /// Whether unit `u` picks up crates (its locomotor crushes `crate`).
    pub(crate) fn collects_crates(&self, u: usize) -> bool {
        let a = &self.actors[u];
        if !a.is_unit() || !a.in_world() || a.air.parachute {
            return false;
        }
        let Some(info) = self.rules.actors[a.ty as usize].unit.as_ref() else { return false };
        a.kind != Kind::Aircraft && self.rules.locomotor_crushes_crates.get(info.locomotor).copied().unwrap_or(false)
    }

    /// Per unit after its activity (units.rs): a unit reaching a cell with a
    /// landed crate picks it up.
    pub(crate) fn pick_up_crate(&mut self, u: usize) {
        if self.crates.count == 0 || !self.actors[u].moved || !self.collects_crates(u) {
            return;
        }
        let a = &self.actors[u];
        let ci = self.cell_index(a.x, a.y);
        let Some(c) = self.crate_at(ci) else { return };
        let ca = &self.actors[c];
        if ca.altitude > 0 || dist_sq(a.x, a.y, ca.x, ca.y) > (COLLECT_REACH as i64) * (COLLECT_REACH as i64) {
            return;
        }
        self.collect_crate(c, u);
    }

    // ---- Collecting -------------------------------------------------------------------------

    /// OpenRA Crate.OnCrushInner: the crate goes, and one of its actions
    /// (weighted by its shares for this collector) happens.
    pub(crate) fn collect_crate(&mut self, c: usize, collector: usize) {
        if !self.actors[c].alive {
            return;
        }
        let ty = self.actors[c].ty as usize;
        let (x, y) = (self.actors[c].x, self.actors[c].y);
        self.remove(c);
        self.crate_removed(c);
        let Some(info) = self.rules.actors[ty].options.crate_info.clone() else { return };
        let shares: Vec<i32> = info.actions.iter().map(|a| self.crate_shares(a, collector)).collect();
        let total: i32 = shares.iter().sum();
        if total <= 0 {
            return;
        }
        let mut n = self.rng.range(0, total);
        for (k, &s) in shares.iter().enumerate() {
            if n < s {
                // The crate-effects animation over the collector (presentation).
                let anim = match info.actions[k].sequence.as_deref() {
                    Some("heal") => Some(crate::husks::LEFTOVER_HEAL),
                    Some("hide-map") => Some(crate::husks::LEFTOVER_HIDE_MAP),
                    Some("reveal-map") => Some(crate::husks::LEFTOVER_REVEAL_MAP),
                    Some("invuln") => Some(crate::husks::LEFTOVER_INVULN),
                    _ => None,
                };
                if let Some(n) = anim {
                    let (cx, cy) = (self.actors[collector].x, self.actors[collector].y);
                    self.effects.push(crate::husks::leftover_effect(n, cx, cy));
                }
                self.activate_crate(&info.actions[k], collector, x, y);
                let owner = self.actors[collector].owner;
                let code = crate::sound_events::crate_action_code(&info.actions[k].key);
                self.sound.push(SoundEventKind::CrateCollected, code, x, y, owner, ty as i32);
                return;
            }
            n -= s;
        }
    }

    /// OpenRA CrateAction.GetSelectionSharesOuter and each action's GetSelectionShares.
    pub(crate) fn crate_shares(&self, act: &CrateAction, collector: usize) -> i32 {
        let a = &self.actors[collector];
        let owner = a.owner as usize;
        if (self.tick as i64) < act.time_delay as i64 || act.excluded.contains(&(a.ty as usize)) {
            return 0;
        }
        if !act.prerequisites.iter().all(|&t| self.players[owner].tokens.get(t as usize).copied().unwrap_or(false)) {
            return 0;
        }
        match act.kind {
            CrateActionKind::GiveCash => {
                if act.amount < 0 && self.players[owner].funds() == 0 {
                    0
                } else {
                    act.shares
                }
            }
            CrateActionKind::LevelUp => {
                if self.can_gain_level(collector) {
                    act.shares
                } else {
                    0
                }
            }
            CrateActionKind::HideMap => {
                // Not when the map is revealed for good (explored option, or the GPS).
                if self.options.explored || self.gps_reveals(a.owner) {
                    0
                } else {
                    act.shares
                }
            }
            CrateActionKind::DuplicateUnit => {
                if self.can_duplicate(act, collector) {
                    act.shares
                } else {
                    0
                }
            }
            CrateActionKind::GiveBaseBuilder => {
                if !self.can_give_units(act, collector) {
                    return 0;
                }
                let has_base = self.actors.iter().any(|b| b.alive && b.owner == a.owner && self.rules.actors[b.ty as usize].base_building);
                if has_base {
                    act.shares
                } else {
                    act.no_base_shares
                }
            }
            CrateActionKind::GiveUnit => {
                if self.can_give_units(act, collector) {
                    act.shares
                } else {
                    0
                }
            }
            CrateActionKind::GrantExternalCondition => {
                if self.accepts_crate_condition(act, collector) {
                    act.shares
                } else {
                    0
                }
            }
            CrateActionKind::Explode | CrateActionKind::HealActors | CrateActionKind::RevealMap => act.shares,
        }
    }

    /// GainsExperience.CanGainLevel.
    pub(crate) fn can_gain_level(&self, i: usize) -> bool {
        self.actors[i].rank < self.max_rank(i)
    }

    /// Whether the GPS satellite reveals the map for `player` (OpenRA IPreventsShroudReset).
    pub(crate) fn gps_reveals(&self, player: u8) -> bool {
        self.abil.gps_at.get(player as usize).copied().flatten().is_some_and(|t| self.tick >= t)
    }

    /// Activate one crate action for `collector` (the crate was at (x, y)).
    pub(crate) fn activate_crate(&mut self, act: &CrateAction, collector: usize, x: i32, y: i32) {
        let owner = self.actors[collector].owner;
        match act.kind {
            CrateActionKind::GiveCash => {
                self.players[owner as usize].cash = self.players[owner as usize].cash.saturating_add(act.amount).max(0);
            }
            CrateActionKind::LevelUp => {
                // Nearby own units that can still rank up (Range is in world
                // units: OpenRA's WDist(3) reaches almost no one), then the collector.
                let mut others: Vec<usize> = self
                    .actors
                    .iter()
                    .enumerate()
                    .filter(|&(i, b)| {
                        i != collector
                            && b.alive
                            && b.in_world()
                            && b.owner == owner
                            && b.is_unit()
                            && dist_sq(b.x, b.y, x, y) <= (act.range as i64) * (act.range as i64)
                            && self.can_gain_level(i)
                    })
                    .map(|(i, _)| i)
                    .collect();
                if act.max_extra > -1 {
                    others.truncate(act.max_extra as usize);
                }
                others.push(collector);
                for i in others {
                    if self.actors[i].alive {
                        self.give_levels(i, act.levels.max(0) as usize);
                    }
                }
            }
            CrateActionKind::Explode => {
                if let Some(w) = act.weapon {
                    let (cx, cy) = (self.actors[collector].x, self.actors[collector].y);
                    let shot = self.shot_of(collector);
                    self.impact_shot(w, cx, cy, owner, shot);
                }
            }
            CrateActionKind::HideMap => {
                for p in self.crate_players(owner, act.include_allies) {
                    self.reset_exploration(p);
                }
            }
            CrateActionKind::HealActors => {
                for i in 0..self.actors.len() {
                    let a = &self.actors[i];
                    if !a.alive
                        || a.owner != owner
                        || a.kind == Kind::Crate
                        || (act.targets != 0 && self.target_class(i) & act.targets == 0)
                    {
                        continue;
                    }
                    let max = self.rules.actors[a.ty as usize].hp;
                    self.actors[i].hp = max;
                }
            }
            CrateActionKind::RevealMap => {
                for p in self.crate_players(owner, act.include_allies) {
                    self.players[p as usize].explored.iter_mut().for_each(|e| *e = 1);
                }
            }
            CrateActionKind::DuplicateUnit => self.duplicate_unit(act, collector),
            CrateActionKind::GiveBaseBuilder | CrateActionKind::GiveUnit => self.give_crate_units(act, collector),
            CrateActionKind::GrantExternalCondition => {
                let mut targets = vec![collector];
                let mut others: Vec<(i64, usize)> = self
                    .actors
                    .iter()
                    .enumerate()
                    .filter(|&(i, b)| i != collector && b.alive && b.in_world() && b.owner == owner && self.accepts_crate_condition(act, i))
                    .map(|(i, b)| (dist_sq(b.x, b.y, x, y), i))
                    .filter(|&(d, _)| d <= (act.range as i64) * (act.range as i64))
                    .collect();
                others.sort();
                if act.max_extra > -1 {
                    others.truncate(act.max_extra as usize);
                }
                targets.extend(others.into_iter().map(|(_, i)| i));
                let until = self.tick + act.duration.max(0) as u32;
                for i in targets {
                    self.grant_invulnerability(i, until);
                }
            }
        }
    }

    /// The players a map crate acts for: the collector's owner, with its allies.
    pub(crate) fn crate_players(&self, owner: u8, allies: bool) -> Vec<u8> {
        (0..self.players.len() as u8).filter(|&p| p == owner || (allies && self.are_allies(p, owner))).collect()
    }

    /// OpenRA Shroud.ResetExploration: only what the player sees right now stays explored.
    pub(crate) fn reset_exploration(&mut self, player: u8) {
        let p = &mut self.players[player as usize];
        for (e, &v) in p.explored.iter_mut().zip(p.visible.iter()) {
            *e = u8::from(v != 0);
        }
        // Structures remembered under the shroud are forgotten.
        let explored = &p.explored;
        let w = self.map.width;
        p.ghosts.retain(|_, g| explored.get((g.cy * w + g.cx) as usize).copied().unwrap_or(0) != 0);
        self.terrain_dirty = true;
    }

    /// GrantExternalConditionCrateAction's condition: `invulnerability`, the
    /// Iron Curtain's (ExternalCondition@INVULNERABILITY, abilities.rs).
    pub(crate) fn accepts_crate_condition(&self, act: &CrateAction, i: usize) -> bool {
        act.condition.as_deref() == Some("invulnerability")
            && self.rules.actors[self.actors[i].ty as usize].abilities.iron_curtainable.is_some()
    }

    /// The invulnerability condition: no damage until `until` (a Demolition Truck blows up instead).
    pub(crate) fn grant_invulnerability(&mut self, i: usize, until: u32) {
        let Some(ic) = self.rules.actors[self.actors[i].ty as usize].abilities.iron_curtainable.clone() else { return };
        if ic.kills {
            self.kill(i);
        } else {
            let a = &mut self.actors[i];
            a.invulnerable_until = a.invulnerable_until.max(until);
        }
    }

    /// Whether a unit of type `ty` may stand on cell (x, y) next to others (OpenRA CanEnterCell).
    pub(crate) fn unit_can_enter(&self, ty: usize, x: i32, y: i32) -> bool {
        if !self.map.contains(x, y) {
            return false;
        }
        let ci = self.map.idx(x, y);
        let info = &self.rules.actors[ty];
        let Some(u) = info.unit.as_ref() else { return false };
        let domain = self.rules.locomotors[u.locomotor].domain;
        if domain == Domain::Air {
            return true;
        }
        if self.pass_for(domain).blocked[ci] || self.building_at[ci] != NONE || self.husk_at(ci).is_some() {
            return false;
        }
        let here: Vec<usize> = self.units_in_cell(ci).iter().map(|&u| u as usize).filter(|&u| self.actors[u].alive).collect();
        if info.kind == Kind::Infantry {
            // Infantry share a cell (OpenRA sub-cells: five).
            here.len() < 5 && here.iter().all(|&o| self.actors[o].kind == Kind::Infantry)
        } else {
            here.is_empty()
        }
    }

    /// Whether `ty` could reach (x, y) from cell `from` (OpenRA PathMightExistForLocomotorBlockedByImmovable).
    pub(crate) fn path_might_exist(&self, ty: usize, from: (i32, i32), x: i32, y: i32) -> bool {
        let Some(u) = self.rules.actors[ty].unit.as_ref() else { return false };
        let domain = self.rules.locomotors[u.locomotor].domain;
        if domain == Domain::Air {
            return true;
        }
        let pass = self.pass_for(domain);
        pass.component[self.map.idx(x, y)] == pass.component[self.map.idx(from.0, from.1)]
    }

    /// DuplicateUnitCrateAction.CanGiveTo.
    pub(crate) fn can_duplicate(&self, act: &CrateAction, collector: usize) -> bool {
        let a = &self.actors[collector];
        let owner = &self.players[a.owner as usize];
        if owner.neutral || (!act.factions.is_empty() && !act.factions.contains(&owner.faction)) {
            return false;
        }
        if self.target_class(collector) & act.targets == 0 {
            return false;
        }
        let c = self.cell_of(a.x, a.y);
        self.cells_in_annulus(c, 0, act.max_radius).iter().any(|&(x, y)| self.unit_can_enter(a.ty as usize, x, y))
    }

    /// DuplicateUnitCrateAction.Activate: copies of the collector on random
    /// free cells around it, at most MaxAmount and MaxDuplicateValue worth.
    pub(crate) fn duplicate_unit(&mut self, act: &CrateAction, collector: usize) {
        let a = &self.actors[collector];
        let (ty, owner) = (a.ty as usize, a.owner);
        let c = self.cell_of(a.x, a.y);
        let mut cells: Vec<(i32, i32)> = self
            .cells_in_annulus(c, 0, act.max_radius)
            .into_iter()
            .filter(|&(x, y)| self.unit_can_enter(ty, x, y) && self.path_might_exist(ty, c, x, y))
            .collect();
        // Fisher-Yates with the shared RNG (OpenRA Shuffle).
        for k in (1..cells.len()).rev() {
            let j = self.rng.range(0, k as i32 + 1) as usize;
            cells.swap(k, j);
        }
        let mut n = cells.len().min(act.max_amount.max(0) as usize);
        let cost = self.rules.actors[ty].cost;
        if act.max_duplicate_value > 0 && cost > 0 {
            n = n.min((act.max_duplicate_value / cost) as usize);
        }
        let facing = self.actors[collector].facing;
        for &(x, y) in cells.iter().take(n) {
            self.spawn_unit(ty as u16, owner, cell_center(x), cell_center(y), facing);
        }
    }

    /// GiveUnitCrateAction.CanGiveTo: every unit has a cell next to the collector.
    pub(crate) fn can_give_units(&self, act: &CrateAction, collector: usize) -> bool {
        let a = &self.actors[collector];
        let owner = &self.players[a.owner as usize];
        if owner.neutral || (!act.factions.is_empty() && !act.factions.contains(&owner.faction)) || act.units.is_empty() {
            return false;
        }
        let c = self.cell_of(a.x, a.y);
        act.units.iter().all(|&u| !self.suitable_cells(u, c).is_empty())
    }

    /// GiveUnitCrateAction.GetSuitableCells: the 3 by 3 cells around `near`
    /// where a `ty` can stand and that it can reach from there.
    pub(crate) fn suitable_cells(&self, ty: usize, near: (i32, i32)) -> Vec<(i32, i32)> {
        let mut out = Vec::new();
        for i in -1..=1 {
            for j in -1..=1 {
                let (x, y) = (near.0 + i, near.1 + j);
                if self.unit_can_enter(ty, x, y) && self.path_might_exist(ty, near, x, y) {
                    out.push((x, y));
                }
            }
        }
        out
    }

    /// GiveUnitCrateAction.Activate: each unit on a random suitable cell.
    pub(crate) fn give_crate_units(&mut self, act: &CrateAction, collector: usize) {
        let a = &self.actors[collector];
        let owner = a.owner;
        let near = self.cell_of(a.x, a.y);
        for &ty in &act.units {
            let cells = self.suitable_cells(ty, near);
            if cells.is_empty() {
                continue;
            }
            let (x, y) = cells[self.rng.range(0, cells.len() as i32) as usize];
            let facing = self.rng.range(0, 1024);
            self.spawn_unit(ty as u16, owner, cell_center(x), cell_center(y), facing);
        }
    }
}

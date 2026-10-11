//! Unit abilities (mines, jammers, gap generators, cloaking, chrono tank, demolition
//! truck, MAD tank, supply truck) and structure support powers (Chronosphere,
//! Iron Curtain, nuke, GPS).
//!
//! Every number comes from OpenRA's RA rules through `rules.json`. Hooks called
//! from the shared code:
//! - `init_abilities(i)` when an actor spawns,
//! - `tick_abilities_world()` once per tick before units act (cloak and
//!   detection, chrono charge, missile jamming, MAD tanks stay deployed),
//! - `tick_ability_activity(i)` for units in `Activity::Ability`,
//! - `tick_abilities(i)` per unit after its activity (mines go off),
//! - `on_fire(i)` whenever an actor fires a weapon,
//! - `apply_generated_shroud()` at the end of every vision update,
//! - `render_abilities(..)` from `build_render`.

use crate::map::{Resource, Terrain};
use crate::math::{dist, dist_sq, facing_of, facing_vec, CELL};
use crate::rules::{Domain, Kind, Projectile as ProjKind, SupportPowerInfo, WarheadKind};
use crate::sound_events::SoundEventKind;
use crate::world::{cell_center, Activity, Effect, EffectKind, World, NONE};

/// Largest minefield one order may cover, in cells (bounds the work per order).
pub const MAX_MINEFIELD_CELLS: i32 = 32 * 32;
/// A unit counts as standing on a cell within this distance of its centre.
const ON_CELL: i32 = 128;
/// Ticks without progress before a minelayer skips a cell it cannot reach.
const STUCK_LIMIT: i32 = 75;
/// A unit this close to a mine's cell centre has driven onto it.
const MINE_TRIGGER: i32 = 256;
/// OpenRA DamageState Critical: at or below a quarter of the maximum health.
const CRITICAL_PERCENT: i32 = 25;

/// What a unit in `Activity::Ability` is doing.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Task {
    #[default]
    None,
    /// Minelayer working through `ActorAbility::minefield`.
    LayMines,
    /// Minelayer driving to a rearm pad (Service Depot) to reload.
    Rearm,
    /// Supply truck driving into an own or allied structure.
    DeliverCash,
    /// MAD tank deployed: thumping, then detonating. Cannot be cancelled.
    MadDeploy,
}

/// Per-actor ability state (part of `Actor`).
#[derive(Clone, Default, Debug)]
pub struct ActorAbility {
    pub task: Task,
    /// Minelayer ammunition (AmmoPool).
    pub ammo: i32,
    /// Cells still to be mined, in order of the order's rectangle.
    pub minefield: Vec<u32>,
    /// Cell the minelayer is heading for, or NONE.
    pub mine_cell: u32,
    /// Rearm reload timer, MAD tank deploy ticks.
    pub timer: i32,
    /// Deliver or rearm target (actor reference).
    pub target: u32,
    /// Cloaked right now (land units and structures; submarines use
    /// `Actor::submerged`). Timer and detection live in the shared
    /// `Actor::cloak_timer` / `Actor::detected_by` (naval.rs uses them too).
    pub cloaked: bool,
    /// Chrono tank: ticks until it can teleport again.
    pub chrono_charge: i32,
    /// Chronosphere: origin (x, y) and the tick the unit is pulled back there.
    pub chrono_return: Option<(i32, i32, u32)>,
}

/// Short-lived visuals owned by this module (drawn by `render_abilities`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum FxKind {
    /// MAD tank seismic thump ring.
    Thump,
    /// Chronoshift flash (chrono tank, Chronosphere).
    Chrono,
}

#[derive(Clone, Debug)]
pub struct AbilityFx {
    pub x: i32,
    pub y: i32,
    pub kind: FxKind,
    pub ttl: i32,
    pub max: i32,
}

/// World-level ability state (part of `World`).
#[derive(Clone, Default)]
pub struct AbilityState {
    /// Mine actor reference per cell (NONE when empty); sized on first use.
    pub mine_at: Vec<u32>,
    /// Per player: 1 where an enemy gap generator hides the cell. Empty when no
    /// generator is active.
    pub gen_shroud: Vec<Vec<u8>>,
    pub fx: Vec<AbilityFx>,
    /// Atom bombs in flight.
    pub nukes: Vec<Nuke>,
    /// Per player: tick from which the GPS satellite reveals the map (None: not launched).
    pub gps_at: Vec<Option<u32>>,
}

/// An atom bomb (NukePower) on its way: up from the silo, down on the target.
#[derive(Clone, Debug)]
pub struct Nuke {
    pub owner: u8,
    /// Launch point (the silo) and target, world units.
    pub sx: i32,
    pub sy: i32,
    pub x: i32,
    pub y: i32,
    pub weapon: u16,
    /// Tick it leaves the silo, tick it lands.
    pub launch: u32,
    pub impact: u32,
    /// Target camera for the owner (CameraRange) and its timing.
    pub camera_range: i32,
    pub camera_advance: i32,
    pub camera_remove: i32,
}

/// OpenRA terrain type name of a WebRA terrain class (map.rs `Terrain::name`).
pub(crate) fn terrain_name(t: Terrain) -> &'static str {
    t.name()
}

/// Whether a minelayer may lay on terrain `t` (Minelayer.TerrainTypes);
/// `resource` is the ore or gems on the cell (terrain types Ore and Gems).
fn terrain_allowed(names: &[String], t: Terrain, resource: Option<Resource>) -> bool {
    let name = t.name();
    let res = match resource {
        Some(Resource::Ore) => "Ore",
        Some(Resource::Gems) => "Gems",
        None => "",
    };
    names.iter().any(|n| n == name || n == res)
}

impl World {
    // ---- Lifecycle --------------------------------------------------------------

    /// Starting ability state of a freshly spawned actor.
    pub(crate) fn init_abilities(&mut self, i: usize) {
        let info = &self.rules.actors[self.actors[i].ty as usize].abilities;
        let ammo = info.minelayer.as_ref().map_or(0, |m| m.ammo);
        // Submarines keep their own cloak start (naval.rs).
        let cloak = info.cloak.as_ref().map(|c| c.initial_delay).filter(|_| self.actors[i].kind != Kind::Ship);
        let a = &mut self.actors[i];
        a.ab = crate::abilities::ActorAbility { ammo, mine_cell: NONE, target: NONE, ..Default::default() };
        if let Some(d) = cloak {
            a.cloak_timer = d;
            a.ab.cloaked = d <= 0;
        }
    }

    /// Once per tick, before units act.
    pub(crate) fn tick_abilities_world(&mut self) {
        for f in self.abil.fx.iter_mut() {
            f.ttl -= 1;
        }
        self.abil.fx.retain(|f| f.ttl > 0);
        for i in 0..self.actors.len() {
            if !self.actors[i].alive {
                continue;
            }
            let a = &mut self.actors[i];
            if a.ab.chrono_charge > 0 {
                a.ab.chrono_charge -= 1;
            }
            // A deployed MAD tank cannot be ordered away.
            if a.ab.task == Task::MadDeploy && a.activity != Activity::Ability {
                a.activity = Activity::Ability;
                a.target = NONE;
            }
        }
        self.tick_cloaks();
        self.jam_missiles();
        self.tick_chrono_returns();
        self.tick_nukes();
    }

    // ---- Cloak and detection ------------------------------------------------------

    /// OpenRA Cloak for land units, structures and mines (submarines: naval.rs).
    /// Detection uses the shared `detectors_of` helper.
    fn tick_cloaks(&mut self) {
        for i in 0..self.actors.len() {
            if !self.actors[i].alive || self.actors[i].kind == Kind::Ship {
                continue;
            }
            let info = &self.rules.actors[self.actors[i].ty as usize];
            let Some(c) = info.abilities.cloak.as_ref() else { continue };
            let paused = c.off_when_critical && self.actors[i].hp * 100 <= info.hp * CRITICAL_PERCENT;
            let a = &mut self.actors[i];
            let was = a.ab.cloaked;
            if paused {
                a.ab.cloaked = false;
            } else {
                if a.cloak_timer > 0 {
                    a.cloak_timer -= 1;
                }
                a.ab.cloaked = a.cloak_timer <= 0;
            }
            if a.ab.cloaked != was {
                self.note_cloak(i);
            }
            let mask = if self.actors[i].ab.cloaked {
                let types = self.rules.actors[self.actors[i].ty as usize].abilities.cloak.as_ref().unwrap().types.clone();
                self.detectors_of(i, &types)
            } else {
                0
            };
            self.actors[i].detected_by = mask;
        }
    }

    /// Whether actor `i` is hidden from `player` by its cloak: cloaked, not
    /// allied, and no detector of `player` or an ally covers it. Used by
    /// targeting (`targetable`), picking and rendering.
    pub fn is_cloaked_from(&self, i: usize, player: u8) -> bool {
        if self.render_all || self.render_combined {
            return false; // spectator views (observer.rs, combined.rs)
        }
        let a = &self.actors[i];
        if a.kind == Kind::Ship {
            return !self.naval_visible(i, player);
        }
        if !a.ab.cloaked || self.are_allies(a.owner, player) {
            return false;
        }
        let mask = a.detected_by;
        !(0..self.players.len().min(32)).any(|q| mask & (1 << q) != 0 && self.are_allies(q as u8, player))
    }

    /// Cancel the cloak for its CloakDelay (OpenRA `Cloak.Uncloak`), if `reason`
    /// is one of the actor's UncloakOn types (Attack, Load, Unload, Heal, Dock...).
    pub fn uncloak_on(&mut self, i: usize, reason: &str) {
        let Some(c) = self.rules.actors[self.actors[i].ty as usize].abilities.cloak.as_ref() else { return };
        if !c.uncloak_on.iter().any(|u| u == reason) {
            return;
        }
        if self.actors[i].kind == Kind::Ship {
            return; // submarines surface through naval.rs
        }
        let delay = c.cloak_delay;
        let a = &mut self.actors[i];
        a.cloak_timer = a.cloak_timer.max(delay);
        let was = a.ab.cloaked;
        a.ab.cloaked = false;
        a.detected_by = 0;
        if was {
            self.note_cloak(i);
        }
    }

    /// CloakChanged for actor `i`, which just cloaked or uncloaked (land
    /// units: `ab.cloaked`, submarines: `submerged`). Like OpenRA's Cloak, an
    /// actor that starts out cloaked makes no sound.
    pub(crate) fn note_cloak(&mut self, i: usize) {
        let a = &self.actors[i];
        if self.tick <= a.born + 1 {
            return;
        }
        let on = if a.kind == Kind::Ship { a.submerged } else { a.ab.cloaked };
        let (ty, x, y, owner) = (a.ty as i32, a.x, a.y, a.owner);
        self.sound.push(SoundEventKind::CloakChanged, ty, x, y, owner, i32::from(on));
    }

    /// Called right after actor `i` fired a weapon.
    pub(crate) fn on_fire(&mut self, i: usize) {
        self.uncloak_on(i, "Attack");
        // A spy drops its disguise when it attacks (Disguise RevealDisguiseOn: Attack; infantry.rs).
        self.actors[i].inf.disguise = None;
        // Demolition truck: GrantConditionOnAttack -> KillsSelf (the MiniNuke goes off).
        if self.rules.actors[self.actors[i].ty as usize].abilities.demo_truck.is_some() {
            self.kill(i);
        }
    }

    // ---- Missile jammer -----------------------------------------------------------

    /// Mobile Radar Jammer (JamsMissiles): homing missiles of enemy or neutral
    /// players inside its range lose their target and veer off.
    fn jam_missiles(&mut self) {
        let jammers: Vec<(i32, i32, u8, i32)> = self
            .actors
            .iter()
            .filter(|a| a.alive)
            .filter_map(|a| self.rules.actors[a.ty as usize].abilities.jams_missiles.as_ref().map(|j| (a.x, a.y, a.owner, j.range)))
            .collect();
        if jammers.is_empty() {
            return;
        }
        for k in 0..self.projectiles.len() {
            let p = &self.projectiles[k];
            if p.target == NONE || self.rules.weapons[p.weapon as usize].projectile != ProjKind::Missile {
                continue;
            }
            let jammed =
                jammers.iter().any(|&(x, y, owner, r)| !self.are_allies(owner, p.owner) && dist_sq(x, y, p.x, p.y) <= r as i64 * r as i64);
            if !jammed {
                continue;
            }
            // Veer off by 45 to 135 degrees and fly on for at least two cells.
            let turn = self.rng.range(128, 385) * if self.rng.chance(50) { 1 } else { -1 };
            let p = &mut self.projectiles[k];
            let heading = facing_of(p.tx - p.x, p.ty - p.y).unwrap_or(p.facing);
            let (vx, vy) = facing_vec((heading + turn).rem_euclid(1024));
            let len = dist(p.x, p.y, p.tx, p.ty).max(2 * CELL);
            p.target = NONE;
            p.tx = p.x + vx * len / 1024;
            p.ty = p.y + vy * len / 1024;
        }
    }

    // ---- Gap generators -------------------------------------------------------------

    /// CreatesShroud (Gap Generator, Mobile Gap Generator): cells in range are
    /// shrouded for every non-allied player, explored ghosts included, unless
    /// one of their units sees through generated shroud there (gap_sight).
    pub(crate) fn apply_generated_shroud(&mut self) {
        if !self.abil.gps_at.is_empty() {
            self.apply_gps();
        }
        let gens: Vec<(i32, i32, u8, i32)> = (0..self.actors.len())
            .filter(|&i| self.actors[i].alive)
            .filter_map(|i| {
                let a = &self.actors[i];
                let cs = self.rules.actors[a.ty as usize].abilities.creates_shroud.as_ref()?;
                (!self.is_powered_down(i)).then_some((a.x, a.y, a.owner, cs.range))
            })
            .collect();
        if gens.is_empty() {
            self.abil.gen_shroud.clear();
            return;
        }
        let cells = self.map.cells();
        let np = self.players.len();
        self.abil.gen_shroud = vec![vec![0u8; cells]; np];
        let (w, h) = (self.map.width, self.map.height);
        for p in 0..np {
            let mut any = false;
            for &(x, y, owner, range) in &gens {
                if self.are_allies(owner, p as u8) || self.players[p].neutral {
                    continue;
                }
                any = true;
                let ci = self.circle(range);
                let (cx, cy) = self.cell_of(x, y);
                for &(dx, dy) in &self.circle_cache[ci] {
                    let (vx, vy) = (cx + dx, cy + dy);
                    if vx >= 0 && vy >= 0 && vx < w && vy < h {
                        self.abil.gen_shroud[p][(vy * w + vx) as usize] = 1;
                    }
                }
            }
            if !any {
                continue;
            }
            // Own and allied units close by still see through it.
            for j in 0..self.actors.len() {
                let a = &self.actors[j];
                if !a.alive || !self.are_allies(a.owner, p as u8) {
                    continue;
                }
                let Some(gs) = self.rules.actors[a.ty as usize].abilities.gap_sight.as_ref() else { continue };
                if gs.range <= 0 {
                    continue;
                }
                let (cx, cy) = self.cell_of(a.x, a.y);
                let ci = self.circle(gs.range);
                for &(dx, dy) in &self.circle_cache[ci] {
                    let (vx, vy) = (cx + dx, cy + dy);
                    if vx >= 0 && vy >= 0 && vx < w && vy < h {
                        self.abil.gen_shroud[p][(vy * w + vx) as usize] = 0;
                    }
                }
            }
            let mask = &self.abil.gen_shroud[p];
            for (v, &m) in self.players[p].visible.iter_mut().zip(mask.iter()) {
                if m != 0 {
                    *v = 0;
                }
            }
        }
    }

    /// Whether cell `ci` is hidden from `player` by an enemy gap generator.
    pub fn gen_shrouded(&self, player: u8, ci: usize) -> bool {
        // The spectator view (observer.rs) is never shrouded.
        !self.render_all && self.abil.gen_shroud.get(player as usize).is_some_and(|m| m[ci] != 0)
    }

    // ---- Mines ------------------------------------------------------------------------

    fn mine_ref_at(&self, ci: usize) -> Option<usize> {
        self.resolve(*self.abil.mine_at.get(ci)?)
    }

    /// Alive mine on cell `ci`, if any.
    pub fn mine_at(&self, ci: usize) -> Option<usize> {
        self.mine_ref_at(ci).filter(|&m| self.actors[m].kind == Kind::Mine)
    }

    /// Whether minelayer `i` may put a mine on cell `ci` (terrain, structures, no mine yet).
    pub fn can_lay_mine(&self, i: usize, ci: usize) -> bool {
        let Some(ml) = self.rules.actors[self.actors[i].ty as usize].abilities.minelayer.as_ref() else { return false };
        ci < self.map.cells()
            && !self.pass.blocked[ci]
            && self.building_at[ci] == NONE
            && terrain_allowed(&ml.terrain, self.map.terrain[ci], self.map.resource(ci).map(|(r, _)| r))
            && self.mine_at(ci).is_none()
    }

    /// Put one mine of minelayer `i` on cell `ci`; uses one ammo.
    pub fn lay_mine(&mut self, i: usize, ci: usize) -> bool {
        if self.actors[i].ab.ammo <= 0 || !self.can_lay_mine(i, ci) {
            return false;
        }
        let ml = self.rules.actors[self.actors[i].ty as usize].abilities.minelayer.as_ref().unwrap();
        let Some(mine_ty) = self.rules.actor_index(&ml.mine) else { return false };
        let owner = self.actors[i].owner;
        let (x, y) = (cell_center(ci as i32 % self.map.width), cell_center(ci as i32 / self.map.width));
        let m = self.spawn_unit(mine_ty as u16, owner, x, y, 0);
        if self.abil.mine_at.len() != self.map.cells() {
            self.abil.mine_at = vec![NONE; self.map.cells()];
        }
        self.abil.mine_at[ci] = self.make_ref(m);
        self.actors[i].ab.ammo -= 1;
        true
    }

    /// Per unit after its activity: a ground unit that drove onto a mine sets it
    /// off (OpenRA Mine: CrushClasses mine, AvoidFriendly false; MineImmune skips).
    pub(crate) fn tick_abilities(&mut self, i: usize) {
        self.rearm_on_pad(i);
        let a = &self.actors[i];
        if !a.moved || !matches!(a.kind, Kind::Infantry | Kind::Vehicle) || self.abil.mine_at.is_empty() {
            return;
        }
        let info = &self.rules.actors[a.ty as usize];
        let Some(u) = info.unit.as_ref() else { return };
        if info.abilities.mine_immune.is_some()
            || self.rules.locomotors[u.locomotor].domain != Domain::Ground
            || !self.rules.locomotor_crushes_mines.get(u.locomotor).copied().unwrap_or(false)
        {
            return;
        }
        // Crushing happens as the unit reaches the cell's centre (OpenRA Mobile.FinishedMoving).
        let ci = self.cell_index(a.x, a.y);
        if let Some(m) = self.mine_at(ci) {
            if dist(a.x, a.y, self.actors[m].x, self.actors[m].y) <= MINE_TRIGGER {
                self.kill(m);
            }
        }
    }

    // ---- Ability activity ----------------------------------------------------------

    /// Units in `Activity::Ability` (minefields, rearming, cash delivery, MAD tank).
    pub(crate) fn tick_ability_activity(&mut self, i: usize) {
        match self.actors[i].ab.task {
            Task::None => self.actors[i].activity = Activity::Idle,
            Task::LayMines => self.tick_lay_mines(i),
            Task::Rearm => self.tick_rearm(i),
            Task::DeliverCash => self.tick_deliver_cash(i),
            Task::MadDeploy => self.tick_mad_tank(i),
        }
    }

    fn start_task(&mut self, i: usize, task: Task) {
        self.release_dock(i);
        let a = &mut self.actors[i];
        a.activity = Activity::Ability;
        a.ab.task = task;
        a.ab.timer = 0;
        a.target = NONE;
        a.attack_move = false;
        a.group_size = 1;
        a.best_dist = i32::MAX;
        a.stuck_ticks = 0;
    }

    pub(crate) fn on_cell(&self, i: usize, ci: u32) -> bool {
        let a = &self.actors[i];
        dist(a.x, a.y, cell_center(ci as i32 % self.map.width), cell_center(ci as i32 / self.map.width)) <= ON_CELL
    }

    /// Progress bookkeeping toward a cell, measured along the path; true
    /// when the unit has made no progress for too long or cannot reach the
    /// cell at all.
    ///
    /// In the OpenRA model: the move toward the cell stopped short.
    pub(crate) fn stuck_toward(&mut self, i: usize, ci: u32) -> bool {
        if self.cell_moves() && self.occupies_cells(i) {
            return !self.on_cell(i, ci) && self.move_settled(i, ci);
        }
        let d = match self.path_remaining(i, ci) {
            Some(d) => d,
            // On a blocked cell: no progress until the unit has stepped off.
            None if self.pass_of(i).blocked[self.cell_index(self.actors[i].x, self.actors[i].y)] => i32::MAX,
            None => return true,
        };
        let a = &mut self.actors[i];
        if d < a.best_dist.saturating_sub(64) {
            a.best_dist = d;
            a.stuck_ticks = 0;
            false
        } else {
            a.stuck_ticks += 1;
            a.stuck_ticks > STUCK_LIMIT
        }
    }

    /// LayMines order: units with a Minelayer mine the cell rectangle.
    pub fn order_lay_mines(&mut self, player: u8, ids: &[u32], x0: i32, y0: i32, x1: i32, y1: i32) {
        let (ax, bx) = (x0.min(x1).max(0), x0.max(x1).min(self.map.width - 1));
        let (ay, by) = (y0.min(y1).max(0), y0.max(y1).min(self.map.height - 1));
        if ax > bx || ay > by || (bx - ax + 1) as i64 * (by - ay + 1) as i64 > MAX_MINEFIELD_CELLS as i64 {
            return;
        }
        let cells: Vec<u32> = (ay..=by).flat_map(|y| (ax..=bx).map(move |x| (x, y))).map(|(x, y)| self.map.idx(x, y) as u32).collect();
        for i in self.owned_ability_units(player, ids) {
            if self.rules.actors[self.actors[i].ty as usize].abilities.minelayer.is_none() {
                continue;
            }
            self.start_task(i, Task::LayMines);
            let a = &mut self.actors[i];
            a.ab.minefield = cells.clone();
            a.ab.mine_cell = NONE;
        }
    }

    fn owned_ability_units(&self, player: u8, ids: &[u32]) -> Vec<usize> {
        let mut out: Vec<usize> =
            ids.iter().filter_map(|&r| self.resolve(r)).filter(|&i| self.actors[i].owner == player && self.actors[i].is_unit()).collect();
        out.sort_unstable();
        out.dedup();
        out
    }

    fn tick_lay_mines(&mut self, i: usize) {
        let field = std::mem::take(&mut self.actors[i].ab.minefield);
        let field: Vec<u32> = field.into_iter().filter(|&c| self.can_lay_mine(i, c as usize)).collect();
        self.actors[i].ab.minefield = field;
        if self.actors[i].ab.minefield.is_empty() {
            self.actors[i].ab.task = Task::None;
            self.actors[i].activity = Activity::Idle;
            return;
        }
        if self.actors[i].ab.ammo <= 0 {
            self.go_rearm(i);
            return;
        }
        let mut cell = self.actors[i].ab.mine_cell;
        if cell == NONE || !self.actors[i].ab.minefield.contains(&cell) {
            // Nearest remaining cell (ties: lowest index).
            let (ux, uy) = self.cell_of(self.actors[i].x, self.actors[i].y);
            let w = self.map.width;
            cell = *self.actors[i]
                .ab
                .minefield
                .iter()
                .min_by_key(|&&c| (((c as i32 % w) - ux).pow(2) + ((c as i32 / w) - uy).pow(2), c))
                .unwrap();
            let goal = self.path_goal(i, cell as i32 % w, cell as i32 / w);
            if goal != cell {
                self.actors[i].ab.minefield.retain(|&c| c != cell);
                return;
            }
            let a = &mut self.actors[i];
            a.ab.mine_cell = cell;
            a.goal = cell;
            a.best_dist = i32::MAX;
            a.stuck_ticks = 0;
        }
        if self.on_cell(i, cell) {
            self.lay_mine(i, cell as usize);
            let a = &mut self.actors[i];
            a.ab.minefield.retain(|&c| c != cell);
            a.ab.mine_cell = NONE;
            return;
        }
        if self.stuck_toward(i, cell) {
            let a = &mut self.actors[i];
            a.ab.minefield.retain(|&c| c != cell);
            a.ab.mine_cell = NONE;
            return;
        }
        self.move_toward(i, cell);
    }

    /// Nearest own rearm structure (Rearmable.RearmActors) of minelayer `i`.
    fn rearm_building(&self, i: usize) -> Option<usize> {
        let a = &self.actors[i];
        let ml = self.rules.actors[a.ty as usize].abilities.minelayer.as_ref()?;
        let mut best: Option<(i64, usize)> = None;
        for (j, b) in self.actors.iter().enumerate() {
            if !b.alive || b.owner != a.owner || b.kind != Kind::Building {
                continue;
            }
            if !ml.rearm_actors.iter().any(|r| r.eq_ignore_ascii_case(&self.rules.actors[b.ty as usize].id)) {
                continue;
            }
            let d = dist_sq(a.x, a.y, b.x, b.y);
            if best.is_none_or(|(bd, _)| d < bd) {
                best = Some((d, j));
            }
        }
        best.map(|(_, j)| j)
    }

    fn go_rearm(&mut self, i: usize) {
        let Some(b) = self.rearm_building(i) else {
            // Nowhere to reload: keep the remaining minefield for a later order.
            self.actors[i].ab.task = Task::None;
            self.actors[i].activity = Activity::Idle;
            return;
        };
        let field = std::mem::take(&mut self.actors[i].ab.minefield);
        self.start_task(i, Task::Rearm);
        let r = self.make_ref(b);
        let pad = self.repair_pad_cell(b);
        let a = &mut self.actors[i];
        a.ab.minefield = field;
        a.ab.target = r;
        a.goal = pad;
    }

    fn tick_rearm(&mut self, i: usize) {
        let Some(b) = self.resolve(self.actors[i].ab.target) else {
            self.actors[i].ab.task = Task::None;
            self.actors[i].activity = Activity::Idle;
            return;
        };
        let max = self.rules.actors[self.actors[i].ty as usize].abilities.minelayer.as_ref().map_or(0, |m| m.ammo);
        if self.actors[i].ab.ammo >= max {
            // Full again: back to the minefield, if any is left.
            if self.actors[i].ab.minefield.is_empty() {
                self.actors[i].ab.task = Task::None;
                self.actors[i].activity = Activity::Idle;
            } else {
                let field = std::mem::take(&mut self.actors[i].ab.minefield);
                self.start_task(i, Task::LayMines);
                let a = &mut self.actors[i];
                a.ab.minefield = field;
                a.ab.mine_cell = NONE;
            }
            return;
        }
        let pad = self.repair_pad_cell(b);
        if self.on_cell(i, pad) {
            return; // rearm_on_pad reloads
        }
        if self.stuck_toward(i, pad) {
            self.actors[i].ab.task = Task::None;
            self.actors[i].activity = Activity::Idle;
            return;
        }
        self.move_toward(i, pad);
    }

    /// Minelayers standing still on an own rearm pad reload one mine per ReloadDelay.
    fn rearm_on_pad(&mut self, i: usize) {
        let a = &self.actors[i];
        let Some(ml) = self.rules.actors[a.ty as usize].abilities.minelayer.as_ref() else { return };
        if a.ab.ammo >= ml.ammo || a.moved {
            return;
        }
        let ci = self.cell_index(a.x, a.y);
        let b = self.building_at[ci];
        let on_pad = b != NONE && {
            let bb = &self.actors[b as usize];
            bb.alive
                && bb.owner == a.owner
                && ml.rearm_actors.iter().any(|r| r.eq_ignore_ascii_case(&self.rules.actors[bb.ty as usize].id))
                && self.on_cell(i, ci as u32)
        };
        let delay = ml.reload_delay.max(1);
        let a = &mut self.actors[i];
        if !on_pad {
            a.ab.timer = 0;
            return;
        }
        a.ab.timer += 1;
        if a.ab.timer >= delay {
            a.ab.timer = 0;
            a.ab.ammo += 1;
            // Rearmable: AmmoPool.RearmSound for each magazine, to the owner.
            let (ty, x, y, owner) = (a.ty as i32, a.x, a.y, a.owner);
            self.sound.push(SoundEventKind::Rearmed, ty, x, y, owner, 0);
        }
    }

    // ---- Supply truck -----------------------------------------------------------------

    /// Whether `units` (own) include a supply truck that could deliver to actor `t`.
    pub(crate) fn can_deliver_cash(&self, player: u8, units: &[usize], t: usize) -> bool {
        let ta = &self.actors[t];
        ta.kind == Kind::Building
            && self.are_allies(player, ta.owner)
            && self.rules.actors[ta.ty as usize].abilities.accepts_cash.is_some()
            && units.iter().any(|&i| self.rules.actors[self.actors[i].ty as usize].abilities.delivers_cash.is_some())
    }

    /// Smart order onto an accepting structure: trucks deliver, the rest moves.
    pub(crate) fn order_deliver_cash(&mut self, units: &[usize], t: usize, x: i32, y: i32) {
        let tref = self.make_ref(t);
        let (trucks, others): (Vec<usize>, Vec<usize>) =
            units.iter().partition(|&&i| self.rules.actors[self.actors[i].ty as usize].abilities.delivers_cash.is_some());
        for i in trucks {
            self.start_task(i, Task::DeliverCash);
            self.actors[i].ab.target = tref;
            self.actors[i].goal = NONE;
        }
        self.order_move(&others, x, y, false);
    }

    fn tick_deliver_cash(&mut self, i: usize) {
        let owner = self.actors[i].owner;
        let Some(t) = self.resolve(self.actors[i].ab.target).filter(|&t| self.are_allies(owner, self.actors[t].owner)) else {
            self.actors[i].ab.task = Task::None;
            self.actors[i].activity = Activity::Idle;
            return;
        };
        let (x, y) = (self.actors[i].x, self.actors[i].y);
        let radius = self.rules.actors[self.actors[i].ty as usize].unit.as_ref().map_or(0, |u| u.radius);
        if self.hit_distance(t, x, y) <= radius + 128 {
            // DeliversCash: the structure's owner gets the payload; the truck is used up.
            let payload = self.rules.actors[self.actors[i].ty as usize].abilities.delivers_cash.as_ref().unwrap().payload;
            let to = self.actors[t].owner;
            self.players[to as usize].cash += payload;
            self.note_earned(to, payload);
            // DonateCash: a cash tick over the structure in its owner's colour.
            self.show_cash_tick(t, to, payload);
            self.effects.push(Effect { x, y, tx: x, ty: y, kind: EffectKind::Dust, ttl: 12, max: 12 });
            self.remove(i);
            return;
        }
        if self.actors[i].goal == NONE {
            let (tx, ty) = self.cell_of(self.actors[t].x, self.actors[t].y);
            let goal = self.path_goal(i, tx, ty);
            if goal == NONE {
                self.actors[i].ab.task = Task::None;
                self.actors[i].activity = Activity::Idle;
                return;
            }
            let a = &mut self.actors[i];
            a.goal = goal;
            a.best_dist = i32::MAX;
            a.stuck_ticks = 0;
        }
        let goal = self.actors[i].goal;
        if self.stuck_toward(i, goal) {
            self.actors[i].ab.task = Task::None;
            self.actors[i].activity = Activity::Idle;
            return;
        }
        self.move_toward(i, goal);
    }

    // ---- MAD tank -----------------------------------------------------------------------

    fn tick_mad_tank(&mut self, i: usize) {
        let Some(m) = self.rules.actors[self.actors[i].ty as usize].abilities.mad_tank.clone() else {
            self.actors[i].ab.task = Task::None;
            self.actors[i].activity = Activity::Idle;
            return;
        };
        self.actors[i].ab.timer += 1;
        let t = self.actors[i].ab.timer;
        let (x, y) = (self.actors[i].x, self.actors[i].y);
        if t % m.thump_interval.max(1) == 0 {
            self.percent_blast(i, m.thump_weapon);
            self.abil.fx.push(AbilityFx { x, y, kind: FxKind::Thump, ttl: 10, max: 10 });
        }
        if t >= m.charge_delay + m.detonation_delay {
            self.percent_blast(i, m.detonation_weapon);
            let owner = self.actors[i].owner;
            if let Some(driver) = self.rules.actor_index(&m.driver) {
                self.spawn_unit(driver as u16, owner, x, y, 512);
            }
            self.kill(i);
        }
    }

    /// Thump and detonation of a MAD tank: HealthPercentageDamage within the
    /// warhead's Spread. AffectsParent is false and MAD tanks are invalid
    /// targets (TargetTypes MADTank), so neither the tank nor others of its kind take damage.
    fn percent_blast(&mut self, src: usize, weapon: usize) {
        let (x, y) = (self.actors[src].x, self.actors[src].y);
        for h in 0..self.rules.weapons[weapon].warheads.len() {
            let wh = &self.rules.weapons[weapon].warheads[h];
            let radius = wh.spread;
            let r_cells = radius / CELL + 2;
            let (cx, cy) = self.cell_of(x, y);
            let mut hits: Vec<usize> = Vec::new();
            for yy in cy - r_cells..=cy + r_cells {
                for xx in cx - r_cells..=cx + r_cells {
                    if !self.map.contains(xx, yy) {
                        continue;
                    }
                    let ci = self.map.idx(xx, yy);
                    hits.extend(self.units_in_cell(ci).iter().map(|&u| u as usize));
                    if self.building_at[ci] != NONE {
                        hits.push(self.building_at[ci] as usize);
                    }
                    if let Some(m) = self.mine_at(ci) {
                        hits.push(m);
                    }
                }
            }
            hits.sort_unstable();
            hits.dedup();
            let damages: Vec<(usize, i32)> = hits
                .into_iter()
                .filter(|&u| {
                    let a = &self.actors[u];
                    let info = &self.rules.actors[a.ty as usize];
                    u != src && a.alive && info.abilities.mad_tank.is_none() && wh.affects(a.kind) && self.hit_distance(u, x, y) <= radius
                })
                .map(|u| {
                    let info = &self.rules.actors[self.actors[u].ty as usize];
                    let base = match wh.kind {
                        WarheadKind::Percent => info.hp as i64 * wh.damage as i64 / 100,
                        _ => wh.damage as i64,
                    };
                    (u, (base * wh.versus[info.armor] as i64 / 100) as i32)
                })
                .collect();
            // Kills credit the MAD tank's owner (observer.rs) and the tank (veterancy.rs).
            let owner = self.actors[src].owner;
            let (source, types) = (self.make_ref(src), wh.damage_types);
            self.with_damage_source(owner, |w| {
                for (u, d) in damages {
                    w.damage_from(u, d, source, types);
                }
            });
        }
    }

    // ---- Deploy (D) ----------------------------------------------------------------------

    /// Deploy-style ability state of unit `i`: None when it has none; else
    /// 1 = deploys now, 2 = cannot right now, 3 = needs a target (chrono tank).
    pub fn ability_deploy_state(&self, i: usize) -> Option<u8> {
        let a = &self.actors[i];
        if !a.alive {
            return None;
        }
        let ab = &self.rules.actors[a.ty as usize].abilities;
        if ab.demo_truck.is_some() {
            return Some(1);
        }
        if ab.mad_tank.is_some() {
            return Some(if a.ab.task == Task::MadDeploy { 2 } else { 1 });
        }
        if ab.minelayer.is_some() {
            let ci = self.cell_index(a.x, a.y);
            return Some(if a.ab.ammo > 0 && self.can_lay_mine(i, ci) { 1 } else { 2 });
        }
        if ab.portable_chrono.is_some() {
            return Some(if a.ab.chrono_charge > 0 { 2 } else { 3 });
        }
        None
    }

    /// Deploy order for ability units; false when `i` has no deploy ability
    /// (the caller then tries the MCV transform).
    pub(crate) fn ability_deploy(&mut self, i: usize) -> bool {
        let Some(state) = self.ability_deploy_state(i) else { return false };
        if state != 1 {
            return true;
        }
        let ab = &self.rules.actors[self.actors[i].ty as usize].abilities;
        if ab.demo_truck.is_some() {
            // GrantConditionOnDeploy -> KillsSelf: the MiniNuke goes off here.
            self.kill(i);
        } else if ab.mad_tank.is_some() {
            self.start_task(i, Task::MadDeploy);
        } else if ab.minelayer.is_some() {
            let ci = self.cell_index(self.actors[i].x, self.actors[i].y);
            self.lay_mine(i, ci);
        }
        true
    }

    // ---- Chrono tank ------------------------------------------------------------------

    /// Whether chrono tank `i` can teleport to cell (cx, cy) now: charged,
    /// within MaxDistance cells, onto explored open ground.
    pub fn can_teleport(&self, i: usize, cx: i32, cy: i32) -> bool {
        let a = &self.actors[i];
        let Some(pc) = self.rules.actors[a.ty as usize].abilities.portable_chrono.as_ref() else { return false };
        if !a.alive || a.ab.chrono_charge > 0 || !self.map.contains(cx, cy) {
            return false;
        }
        let (ux, uy) = self.cell_of(a.x, a.y);
        let ci = self.map.idx(cx, cy);
        let d2 = (cx - ux) as i64 * (cx - ux) as i64 + (cy - uy) as i64 * (cy - uy) as i64;
        d2 <= pc.max_distance as i64 * pc.max_distance as i64
            && self.players[a.owner as usize].explored[ci] != 0
            && !self.gen_shrouded(a.owner, ci)
            && !self.pass.blocked[ci]
    }

    /// Teleport order (PortableChrono): every given chrono tank that can reach
    /// the target cell jumps there and starts recharging.
    pub fn order_teleport(&mut self, player: u8, ids: &[u32], x: i32, y: i32) {
        let (cx, cy) = self.cell_of(x, y);
        for i in self.owned_ability_units(player, ids) {
            if !self.can_teleport(i, cx, cy) {
                continue;
            }
            let charge = self.rules.actors[self.actors[i].ty as usize].abilities.portable_chrono.as_ref().unwrap().charge_delay;
            self.teleport(i, cell_center(cx), cell_center(cy));
            self.actors[i].ab.chrono_charge = charge;
        }
    }

    /// Move unit `i` to (x, y) instantly with a chronoshift flash at both ends.
    pub(crate) fn teleport(&mut self, i: usize, x: i32, y: i32) {
        self.release_dock(i);
        let (ox, oy) = (self.actors[i].x, self.actors[i].y);
        for (fx, fy) in [(ox, oy), (x, y)] {
            self.effects.push(Effect { x: fx, y: fy, tx: fx, ty: fy, kind: EffectKind::ChronoShimmer, ttl: 20, max: 20 });
            self.abil.fx.push(AbilityFx { x: fx, y: fy, kind: FxKind::Chrono, ttl: 12, max: 12 });
        }
        let a = &mut self.actors[i];
        a.x = x;
        a.y = y;
        a.px = x;
        a.py = y;
        a.activity = Activity::Idle;
        a.target = NONE;
        a.goal = NONE;
        a.attack_move = false;
    }

    // ---- UI state -----------------------------------------------------------------------

    /// Ability state of actor `i` for the selection panel (`actor_json`).
    pub fn ability_json(&self, i: usize) -> serde_json::Value {
        let a = &self.actors[i];
        let ab = &self.rules.actors[a.ty as usize].abilities;
        let mut out = serde_json::Map::new();
        if let Some(m) = &ab.minelayer {
            out.insert("ammo".into(), a.ab.ammo.into());
            out.insert("maxAmmo".into(), m.ammo.into());
            out.insert("minelayer".into(), true.into());
        }
        if let Some(pc) = &ab.portable_chrono {
            out.insert("charge".into(), (pc.charge_delay - a.ab.chrono_charge).into());
            out.insert("chargeMax".into(), pc.charge_delay.into());
            out.insert("maxDistance".into(), pc.max_distance.into());
        }
        if ab.cloak.is_some() {
            out.insert("cloaked".into(), a.ab.cloaked.into());
        }
        if let Some(m) = &ab.mad_tank {
            let deployed = a.ab.task == Task::MadDeploy;
            out.insert("deployed".into(), deployed.into());
            out.insert("detonatesIn".into(), (if deployed { m.charge_delay + m.detonation_delay - a.ab.timer } else { 0 }).into());
        }
        if let Some(d) = &ab.delivers_cash {
            out.insert("payload".into(), d.payload.into());
        }
        serde_json::Value::Object(out)
    }

    // ---- Rendering ------------------------------------------------------------------------

    /// Mines, ability effects and ability decorations for `player`.
    pub(crate) fn render_abilities(
        &self,
        player: u8,
        sink: &mut crate::instances::Sink,
        selected: &[u32],
        sprites: &mut Vec<f32>,
        rects: &mut Vec<f32>,
    ) {
        use crate::instances::{SpriteRec, NO_CULL};
        use crate::render::{push_fixed_rect, px};
        let ids = crate::render::SpriteIds::new(self.rules.actors.len());
        let vis = &self.players[player as usize].visible;
        // Mines: owners and allies always see them; others only when detected.
        if !self.abil.mine_at.is_empty() {
            for (i, a) in self.actors.iter().enumerate() {
                if !a.alive || a.kind != Kind::Mine {
                    continue;
                }
                let (x, y) = (px(a.x), px(a.y));
                if !sink.visible([x, y], [x, y], 16.0) {
                    continue;
                }
                let own = self.render_allied(a.owner, player);
                if !own && (vis[self.cell_index(a.x, a.y)] == 0 || self.is_cloaked_from(i, player)) {
                    continue;
                }
                let at = SpriteRec::at(x, y, 16.0);
                sink.sprite(sprites, at.look((a.ty * 2) as f32, a.owner as f32, 1.0, 1.0, (a.flash > 0) as i32 as f32));
                if !own {
                    // Detected enemy mine: warning marker.
                    sink.sprite(sprites, at.look(ids.abilities_base, 0.0, 1.0, 0.9, 0.0).offset(0.0, -6.0));
                }
            }
        }
        for (i, a) in self.actors.iter().enumerate() {
            if !a.alive || a.kind == Kind::Mine {
                continue;
            }
            let (x, y) = (px(a.x), px(a.y));
            if !sink.visible([x, y], [x, y], 64.0) {
                continue;
            }
            let seen = a.owner == player || (self.is_visible_to(i, player) && !self.is_cloaked_from(i, player));
            if !seen {
                continue;
            }
            // Iron Curtain: red glow while invulnerable.
            if a.invulnerable_until > self.tick {
                let scale = if a.kind == Kind::Building { 2.0 } else { 1.0 };
                sink.sprite(sprites, SpriteRec::at(x, y, 64.0).look(ids.abilities_base + 3.0, 0.0, scale, 0.75, 0.0));
            }
            // Own cloaked units shimmer.
            if a.ab.cloaked && self.render_allied(a.owner, player) {
                let r = SpriteRec::at(x, y, 64.0).look(ids.abilities_base + 7.0, 0.0, 1.0, 0.5, 0.0);
                sink.sprite(sprites, r.radians((self.tick % 64) as f32 * 0.1));
            }
        }
        // Atom bombs: up from the silo, then down on the target; a beacon marks
        // the target for the owner and allies (DisplayBeacon).
        for n in &self.abil.nukes {
            if self.render_allied(n.owner, player) {
                let (bx, by) = (px(n.x), px(n.y));
                if sink.visible([bx, by], [bx, by], 32.0) {
                    let pulse = 0.6 + 0.4 * ((self.tick % 20) as f32 / 20.0);
                    sink.sprite(sprites, SpriteRec::at(bx, by, 32.0).look(ids.abilities_base + 5.0, n.owner as f32, 1.0, pulse, 0.0));
                }
            }
            if self.tick < n.launch {
                continue;
            }
            let half = (n.impact - n.launch) / 2;
            let t = self.tick - n.launch;
            let (mx, my, ang, lift) = if t < half {
                (n.sx, n.sy, -std::f32::consts::FRAC_PI_2, px(CELL * 12) * t as f32 / half.max(1) as f32)
            } else {
                (n.x, n.y, std::f32::consts::FRAC_PI_2, px(CELL * 12) * (n.impact - self.tick) as f32 / half.max(1) as f32)
            };
            let (x, y) = (px(mx), px(my) - lift);
            if self.render_sees_cell(player, self.cell_index(mx, my)) && sink.visible([x, y], [x, y], 32.0) {
                sink.sprite(sprites, SpriteRec::at(x, y, 32.0).look(ids.missile, n.owner as f32, 2.0, 1.0, 0.0).radians(ang));
            }
        }
        // GPS: enemy units under fog show as dots (GpsDot).
        if self.has_gps(player) {
            for (i, a) in self.actors.iter().enumerate() {
                if !a.alive || !a.is_unit() || !a.in_world() || self.are_allies(a.owner, player) || self.is_visible_to(i, player) {
                    continue;
                }
                if self.is_cloaked_from(i, player) || self.gen_shrouded(player, self.cell_index(a.x, a.y)) {
                    continue;
                }
                let (x, y) = (px(a.x), px(a.y));
                if sink.visible([x, y], [x, y], 8.0) {
                    sink.sprite(sprites, SpriteRec::at(x, y, 8.0).look(ids.abilities_base + 6.0, a.owner as f32, 1.0, 1.0, 0.0));
                }
            }
        }
        for f in &self.abil.fx {
            let (x, y) = (px(f.x), px(f.y));
            if !self.render_sees_cell(player, self.cell_index(f.x, f.y)) || !sink.visible([x, y], [x, y], 96.0) {
                continue;
            }
            let t = 1.0 - f.ttl as f32 / f.max as f32;
            let (sprite, scale) = match f.kind {
                FxKind::Thump => (ids.abilities_base + 1.0, 0.6 + t * 2.4),
                FxKind::Chrono => (ids.abilities_base + 2.0, 0.8 + t * 0.6),
            };
            sink.sprite(sprites, SpriteRec::at(x, y, 96.0).look(sprite, 0.0, scale, 1.0 - t, 0.0));
        }
        // Selected own units: ammo pips, chrono charge, gap generator range.
        for &r in selected {
            let Some(i) = self.resolve(r) else { continue };
            let a = &self.actors[i];
            if !self.render_owns(a.owner, player) {
                continue;
            }
            let info = &self.rules.actors[a.ty as usize];
            let (x, y) = (px(a.x), px(a.y));
            let half = if a.kind == Kind::Building {
                info.building.as_ref().map_or(12.0, |b| b.width as f32 * 12.0)
            } else {
                (px(info.unit.as_ref().map_or(256, |u| u.radius) * 2) + 6.0).max(14.0) / 2.0
            };
            if let Some(m) = &info.abilities.minelayer {
                for k in 0..m.ammo {
                    let full = k < a.ab.ammo;
                    let c = if full { [0.95, 0.8, 0.2, 1.0] } else { [0.15, 0.15, 0.15, 0.8] };
                    push_fixed_rect(sink, rects, &[x - half + k as f32 * 3.0, y + half + 1.0, 2.0, 2.0, c[0], c[1], c[2], c[3]]);
                }
            }
            if let Some(pc) = &info.abilities.portable_chrono {
                let frac = 1.0 - a.ab.chrono_charge as f32 / pc.charge_delay.max(1) as f32;
                push_fixed_rect(sink, rects, &[x - half, y + half + 1.0, half * 2.0, 2.0, 0.0, 0.0, 0.0, 0.7]);
                push_fixed_rect(sink, rects, &[x - half, y + half + 1.0, half * 2.0 * frac, 2.0, 0.45, 0.85, 1.0, 1.0]);
            }
            if let Some(cs) = &info.abilities.creates_shroud {
                // RenderShroudCircle: dots along the range.
                let r = px(cs.range);
                let n = 48;
                for k in 0..n {
                    let ang = k as f32 / n as f32 * std::f32::consts::TAU;
                    let at = SpriteRec::at(x + ang.cos() * r, y + ang.sin() * r, NO_CULL);
                    sink.sprite(sprites, at.look(ids.abilities_base + 4.0, a.owner as f32, 1.0, 0.8, 0.0).radians(ang));
                }
            }
        }
    }

    // ---- Superweapons (dispatched from powers.rs) ------------------------------------

    /// Per-player support power upkeep, called every tick: the GPS satellite
    /// launches by itself once charged (OpenRA GpsPower).
    pub(crate) fn tick_powers(&mut self, player: u8) {
        let key = self
            .power_instances(player)
            .iter()
            .find(|inst| inst.ready() && self.power_info(inst).kind == "GpsPower")
            .map(|inst| inst.key.clone());
        if let Some(key) = key {
            self.activate_support_power(player, &key, 0, 0, None);
        }
    }

    /// Cells of a power's footprint centred on cell (cx, cy), inside the map.
    fn power_cells(&self, info: &SupportPowerInfo, cx: i32, cy: i32) -> Vec<(i32, i32)> {
        let rows = if info.footprint.is_empty() { vec!["x".to_string()] } else { info.footprint.clone() };
        let (h, w) = (rows.len() as i32, rows[0].len() as i32);
        let mut out = Vec::new();
        for (y, row) in rows.iter().enumerate() {
            for (x, c) in row.chars().enumerate() {
                let (px, py) = (cx + x as i32 - w / 2, cy + y as i32 - h / 2);
                if c == 'x' && self.map.contains(px, py) {
                    out.push((px, py));
                }
            }
        }
        out
    }

    /// Actors standing in (units) or covering (structures) the given cells, sorted.
    fn actors_in_cells(&self, cells: &[(i32, i32)]) -> Vec<usize> {
        let mut out = Vec::new();
        for &(x, y) in cells {
            let ci = self.map.idx(x, y);
            for &u in self.units_in_cell(ci) {
                if self.actors[u as usize].alive && self.actors[u as usize].in_world() {
                    out.push(u as usize);
                }
            }
            let b = self.building_at[ci];
            if b != NONE && self.actors[b as usize].alive {
                out.push(b as usize);
            }
        }
        out.sort_unstable();
        out.dedup();
        out
    }

    /// Chronosphere (ChronoshiftPower): units in the footprint around the
    /// source `src` jump to the same spots around (x, y) and return after
    /// Duration. Any owner's Chronoshiftable units are taken, like OpenRA.
    pub(crate) fn fire_chronoshift(&mut self, player: u8, info: &SupportPowerInfo, x: i32, y: i32, src: Option<(i32, i32)>) -> bool {
        let Some((sx, sy)) = src else { return false };
        let (scx, scy) = self.cell_of(sx, sy);
        let (dcx, dcy) = self.cell_of(x, y);
        let (dx, dy) = (dcx - scx, dcy - scy);
        let cells = self.power_cells(info, scx, scy);
        let mut fired = false;
        for i in self.actors_in_cells(&cells) {
            let a = &self.actors[i];
            if a.kind == Kind::Building {
                continue;
            }
            let Some(cs) = self.rules.actors[a.ty as usize].abilities.chronoshiftable.clone() else { continue };
            if cs.not_deployed && a.ab.task == Task::MadDeploy {
                continue;
            }
            let (ux, uy) = self.cell_of(a.x, a.y);
            let (tx, ty) = (ux + dx, uy + dy);
            if !self.map.contains(tx, ty) {
                continue;
            }
            let ci = self.map.idx(tx, ty);
            let domain = self.domain_of(i);
            let open = domain == Domain::Air || !self.pass_of(i).blocked[ci];
            if !open || self.players[player as usize].explored[ci] == 0 || self.gen_shrouded(player, ci) {
                continue;
            }
            fired = true;
            if cs.explode_instead {
                // Demolition truck: Chronoshiftable.ExplodeInstead.
                self.kill(i);
                continue;
            }
            if info.kill_cargo {
                for p in self.passengers(i) {
                    self.kill(p);
                }
            }
            let origin = self.actors[i].ab.chrono_return.map_or((self.actors[i].x, self.actors[i].y), |(ox, oy, _)| (ox, oy));
            let (ox, oy) = (self.actors[i].x - cell_center(ux), self.actors[i].y - cell_center(uy));
            self.teleport(i, cell_center(tx) + ox, cell_center(ty) + oy);
            if info.duration > 0 {
                self.actors[i].ab.chrono_return = Some((origin.0, origin.1, self.tick + info.duration as u32));
            }
        }
        fired
    }

    fn tick_chrono_returns(&mut self) {
        for i in 0..self.actors.len() {
            let Some((x, y, t)) = self.actors[i].ab.chrono_return else { continue };
            if !self.actors[i].alive {
                continue;
            }
            if self.tick >= t {
                self.actors[i].ab.chrono_return = None;
                self.teleport(i, x, y);
            }
        }
    }

    /// Iron Curtain (GrantExternalConditionPower invulnerability): actors in
    /// the footprint take no damage for Duration; Demolition Trucks blow up.
    pub(crate) fn fire_iron_curtain(&mut self, info: &SupportPowerInfo, x: i32, y: i32) -> bool {
        let (cx, cy) = self.cell_of(x, y);
        let cells = self.power_cells(info, cx, cy);
        let until = self.tick + info.duration.max(0) as u32;
        let mut fired = false;
        for i in self.actors_in_cells(&cells) {
            let Some(ic) = self.rules.actors[self.actors[i].ty as usize].abilities.iron_curtainable.clone() else { continue };
            fired = true;
            if ic.kills {
                self.kill(i);
            } else {
                let a = &mut self.actors[i];
                a.invulnerable_until = a.invulnerable_until.max(until);
            }
        }
        fired
    }

    /// Atom bomb (NukePower): leaves a powered silo after MissileDelay and
    /// lands FlightDelay ticks later.
    pub(crate) fn fire_nuke(&mut self, player: u8, info: &SupportPowerInfo, x: i32, y: i32) -> bool {
        let Some(w) = info.missile_weapon else { return false };
        let silo = (0..self.actors.len()).find(|&i| {
            let a = &self.actors[i];
            a.alive
                && a.owner == player
                && a.kind == Kind::Building
                && !self.is_powered_down(i)
                && self.rules.actors[a.ty as usize].abilities.support_powers.as_ref().is_some_and(|l| l.iter().any(|p| p.key == info.key))
        });
        let Some(silo) = silo else { return false };
        // The silo opens (fx.rs, presentation only).
        self.note_launch(silo);
        let launch = self.tick + info.missile_delay.max(0) as u32;
        self.abil.nukes.push(Nuke {
            owner: player,
            sx: self.actors[silo].x,
            sy: self.actors[silo].y,
            x,
            y,
            weapon: w as u16,
            launch,
            impact: launch + info.flight_delay.max(1) as u32,
            camera_range: info.camera_range,
            camera_advance: info.camera_spawn_advance,
            camera_remove: info.camera_remove_delay,
        });
        true
    }

    fn tick_nukes(&mut self) {
        let tick = self.tick;
        let mut k = 0;
        while k < self.abil.nukes.len() {
            let n = self.abil.nukes[k].clone();
            if n.camera_range > 0 && tick + n.camera_advance.max(0) as u32 == n.impact {
                self.add_reveal(n.owner, n.x, n.y, n.camera_range, n.camera_advance + n.camera_remove);
            }
            if tick >= n.impact {
                self.abil.nukes.swap_remove(k);
                self.effects.push(Effect { x: n.x, y: n.y, tx: n.x, ty: n.y, kind: EffectKind::NukeExplosion, ttl: 50, max: 50 });
                self.impact(n.weapon as usize, n.x, n.y, n.owner);
                continue;
            }
            k += 1;
        }
    }

    /// GPS Satellite (GpsPower): after RevealDelay the whole map is explored
    /// for the owner and allies while they keep a structure with the power.
    pub(crate) fn fire_gps(&mut self, player: u8, info: &SupportPowerInfo) -> bool {
        let n = self.players.len();
        self.abil.gps_at.resize(n, None);
        if self.abil.gps_at[player as usize].is_some() {
            return false;
        }
        self.abil.gps_at[player as usize] = Some(self.tick + info.reveal_delay.max(0) as u32);
        true
    }

    /// Whether `player` (or an ally) has a working GPS satellite.
    pub fn has_gps(&self, player: u8) -> bool {
        (0..self.abil.gps_at.len()).any(|p| {
            self.abil.gps_at[p].is_some_and(|t| self.tick >= t)
                && self.are_allies(p as u8, player)
                && self.actors.iter().any(|a| {
                    a.alive
                        && a.owner as usize == p
                        && self.rules.actors[a.ty as usize]
                            .abilities
                            .support_powers
                            .as_ref()
                            .is_some_and(|l| l.iter().any(|sp| sp.kind == "GpsPower"))
                })
        })
    }

    /// Vision update: GPS explores the whole map.
    fn apply_gps(&mut self) {
        for p in 0..self.players.len() {
            if self.has_gps(p as u8) {
                self.players[p].explored.iter_mut().for_each(|e| *e = 1);
            }
        }
    }
}

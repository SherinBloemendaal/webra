//! Command bar orders (OpenRA's bottom-left command bar): force-fire on the
//! ground, guard, scatter, queued waypoints and fire stances.
//!
//! - Attack ground (`Order::AttackGround`, Ctrl+click on the ground): fire at
//!   a point until told otherwise, moving into range first. Weapons need the
//!   `Ground` target type for land (TARGET_GROUND) or `Water` for water cells.
//!   Force-fire on an actor reuses `Order::Attack`, which may target own and
//!   allied actors too (combat.rs `live_target`).
//! - Guard (`Order::Guard`): follow an own or allied unit, staying within
//!   `GUARD_RANGE`, and fight enemies that come near like an attack-move
//!   (OpenRA Guard with `Guardable.Range` 2c0); afterwards guard again.
//! - Scatter (`Order::Scatter`): each unit moves to a random free neighbouring
//!   cell (OpenRA `Mobile.Nudge`), drawn from the shared game random.
//! - Waypoints (`Order::Waypoint`, Shift+click): moves queued after the
//!   current orders; an idle unit starts the next one (units.rs).
//! - Stances (`Order::SetStance`): OpenRA `AutoTarget` stances, used by
//!   combat.rs when idle actors pick targets and shoot back.
//!
//! Every new command to a unit (any order but a waypoint or a stance) clears
//! its queued waypoints and ends guarding (`clear_commands`).

use crate::flowfield::DIRS;
use crate::helicopter::HeliTask;
use crate::math::{dist, CELL};
use crate::rules::{Domain, Kind, Stance};
use crate::world::{cell_center, Activity, Waypoint, World, MAX_WAYPOINTS, NONE};

/// Guardable.Range: guards stay this close to the unit they protect.
pub const GUARD_RANGE: i32 = 2 * CELL;

impl World {
    /// Stance a new actor starts with: AutoTarget InitialStance, or
    /// InitialStanceAI for AI players.
    pub(crate) fn initial_stance(&self, ty: u16, owner: u8) -> Stance {
        let ai = self.players.get(owner as usize).is_some_and(|p| p.is_ai);
        match self.rules.actors[ty as usize].stance {
            Some((human, computer)) => {
                if ai {
                    computer
                } else {
                    human
                }
            }
            None => Stance::AttackAnything,
        }
    }

    /// Whether actor `i` has a fire stance (AutoTarget and a weapon).
    pub fn has_stance(&self, i: usize) -> bool {
        self.rules.actors[self.actors[i].ty as usize].stance.is_some() && self.has_weapons(i)
    }

    /// A new command replaces queued waypoints and ends guarding.
    pub(crate) fn clear_commands(&mut self, i: usize) {
        let a = &mut self.actors[i];
        a.waypoints.clear();
        a.guard = NONE;
        a.hold = false;
    }

    // ---- Attack ground --------------------------------------------------------------

    /// Target class of the ground at a point: water cells for `Water`
    /// weapons, everything else for `Ground` weapons.
    pub fn ground_class(&self, x: i32, y: i32) -> u32 {
        if self.map.terrain[self.cell_index(x, y)] == crate::map::Terrain::Water {
            crate::rules::TARGET_WATER
        } else {
            crate::rules::TARGET_GROUND
        }
    }

    /// Whether unit `i` can fire at the ground at (x, y): it has a weapon for
    /// that ground and is not a plane (planes only attack actors).
    pub fn can_attack_ground(&self, i: usize, x: i32, y: i32) -> bool {
        let info = &self.rules.actors[self.actors[i].ty as usize];
        !self.is_plane(i) && info.can_attack_class(&self.rules, self.ground_class(x, y))
    }

    pub(crate) fn order_attack_ground(&mut self, units: &[usize], x: i32, y: i32) {
        let (mx, my) = (self.map.width * CELL - 1, self.map.height * CELL - 1);
        let (x, y) = (x.clamp(0, mx), y.clamp(0, my));
        for &i in units {
            if !self.can_attack_ground(i, x, y) {
                continue;
            }
            self.release_dock(i);
            let a = &mut self.actors[i];
            a.activity = Activity::AttackGround;
            a.fire_at = (x, y);
            a.target = NONE;
            a.forced = true;
            a.hold = false;
            a.attack_move = false;
            a.chase_cell = NONE;
            a.goal = NONE;
            a.group_size = 1;
            a.best_dist = i32::MAX;
            a.stuck_ticks = 0;
            a.air.new_order();
        }
    }

    /// Ground units and ships: get in range of the ground point and keep firing.
    pub(crate) fn tick_attack_ground(&mut self, i: usize) {
        let (tx, ty) = self.actors[i].fire_at;
        let class = self.ground_class(tx, ty);
        let info = &self.rules.actors[self.actors[i].ty as usize];
        let usable: Vec<usize> = info.weapons.iter().copied().filter(|&w| self.rules.weapons[w].can_target_class(class)).collect();
        if usable.is_empty() {
            self.actors[i].activity = Activity::Idle;
            return;
        }
        let range = usable.iter().map(|&w| self.rules.weapons[w].range).max().unwrap();
        let min_range = usable.iter().map(|&w| self.rules.weapons[w].min_range).min().unwrap();
        let d = dist(self.actors[i].x, self.actors[i].y, tx, ty);
        if d <= range && d >= min_range {
            self.aim_and_fire_at(i, crate::combat::FireTarget::Ground(tx, ty));
        } else if d < min_range {
            self.back_away_from(i, tx, ty);
        } else if !self.approach(i, tx, ty) {
            self.actors[i].activity = Activity::Idle;
        }
    }

    // ---- Guard ----------------------------------------------------------------------

    /// The unit `i` guards, while it is alive and in the world.
    pub fn guarded(&self, i: usize) -> Option<usize> {
        self.resolve(self.actors[i].guard).filter(|&g| self.actors[g].in_world())
    }

    /// Whether `player`'s unit `i` may guard actor `t`: an own or allied unit
    /// (not itself); planes cannot guard.
    pub fn can_guard(&self, player: u8, i: usize, t: usize) -> bool {
        let ta = &self.actors[t];
        i != t
            && ta.alive
            && ta.is_unit()
            && ta.in_world()
            && self.are_allies(player, ta.owner)
            && !self.is_plane(i)
            && !self.is_support_aircraft(t)
    }

    pub(crate) fn order_guard(&mut self, player: u8, units: &[usize], t: usize) {
        let tref = self.make_ref(t);
        for &i in units {
            if !self.can_guard(player, i, t) {
                continue;
            }
            self.release_dock(i);
            let a = &mut self.actors[i];
            a.activity = Activity::Guard;
            a.guard = tref;
            // Fights on the way follow attack-move rules (closer threats first).
            a.attack_move = true;
            a.target = NONE;
            a.forced = false;
            a.hold = false;
            a.goal = NONE;
            a.chase_cell = NONE;
            a.group_size = 1;
            a.best_dist = i32::MAX;
            a.stuck_ticks = 0;
            a.air.new_order();
        }
    }

    /// Ground units and ships: fight enemies near, else stay with the guarded unit.
    pub(crate) fn tick_guard(&mut self, i: usize) {
        let Some(g) = self.guarded(i) else {
            self.end_guard(i);
            return;
        };
        if self.try_auto_target(i) {
            return;
        }
        let (gx, gy) = (self.actors[g].x, self.actors[g].y);
        if dist(self.actors[i].x, self.actors[i].y, gx, gy) <= GUARD_RANGE {
            return;
        }
        // Too far (or the path is cut off for now): follow, or wait for it.
        self.approach(i, gx, gy);
    }

    pub(crate) fn end_guard(&mut self, i: usize) {
        let a = &mut self.actors[i];
        a.guard = NONE;
        a.attack_move = false;
        a.target = NONE;
        a.activity = Activity::Idle;
    }

    /// After a fight: back to guarding when the guarded unit still lives.
    /// Returns false when the unit guards nothing.
    pub(crate) fn resume_guard(&mut self, i: usize) -> bool {
        if self.guarded(i).is_none() {
            self.actors[i].guard = NONE;
            return false;
        }
        let a = &mut self.actors[i];
        a.activity = Activity::Guard;
        a.target = NONE;
        a.attack_move = true;
        a.hold = false;
        a.goal = NONE;
        a.chase_cell = NONE;
        true
    }

    // ---- Moving toward a point ----------------------------------------------------------

    /// One step toward the cell of (x, y), or the nearest reachable cell
    /// (re-planned when that cell changes). False when nothing is reachable.
    pub(crate) fn approach(&mut self, i: usize, x: i32, y: i32) -> bool {
        let (ux, uy) = (self.actors[i].x, self.actors[i].y);
        let (tcx, tcy) = self.cell_toward(x, y, ux, uy);
        let tcell = self.map.idx(tcx, tcy) as u32;
        if self.actors[i].chase_cell != tcell || self.actors[i].goal == NONE {
            let goal = self.path_goal(i, tcx, tcy);
            let a = &mut self.actors[i];
            a.chase_cell = tcell;
            a.goal = goal;
        }
        // The goal may have become unreachable since (a structure went up on it).
        if !self.keep_goal_reachable(i) {
            return false;
        }
        let goal = self.actors[i].goal;
        if goal == NONE {
            return false;
        }
        self.move_toward(i, goal);
        true
    }

    /// Artillery: step away from (x, y) until it is outside minimum range.
    pub(crate) fn back_away_from(&mut self, i: usize, tx: i32, ty: i32) {
        let (x, y) = (self.actors[i].x, self.actors[i].y);
        let (ax, ay) = (x - tx, y - ty);
        let len = dist(0, 0, ax, ay).max(1);
        let (bx, by) = (x + ax * 2 * CELL / len, y + ay * 2 * CELL / len);
        let unit = self.rules.actors[self.actors[i].ty as usize].unit.clone().unwrap();
        self.step_toward(i, bx, by, &unit);
    }

    // ---- Scatter ------------------------------------------------------------------------

    /// Free neighbouring cells unit `i` could move to (its domain, same
    /// passable area; any cell on the map for helicopters).
    fn scatter_cells(&self, i: usize) -> Vec<(i32, i32)> {
        let a = &self.actors[i];
        let (cx, cy) = self.cell_of(a.x, a.y);
        let d = self.domain_of(i);
        let comp = (d != Domain::Air).then(|| self.pass_for(d).component[self.map.idx(cx, cy)]);
        DIRS.iter()
            .map(|&(dx, dy)| (cx + dx, cy + dy))
            .filter(|&(x, y)| {
                if !self.map.contains(x, y) {
                    return false;
                }
                let Some(comp) = comp else { return true };
                let ci = self.map.idx(x, y);
                let pass = self.pass_for(d);
                !pass.blocked[ci] && pass.component[ci] == comp
            })
            .collect()
    }

    pub(crate) fn order_scatter(&mut self, units: &[usize]) {
        for &i in units {
            // Planes cannot hold a spot to scatter to; landed helicopters stay down.
            if self.is_plane(i) || (self.actors[i].kind == Kind::Aircraft && self.actors[i].heli.landed) {
                continue;
            }
            let cells = self.scatter_cells(i);
            if cells.is_empty() {
                continue;
            }
            let (x, y) = cells[self.rng.range(0, cells.len() as i32) as usize];
            self.order_move(&[i], cell_center(x), cell_center(y), false);
        }
    }

    // ---- Waypoints ----------------------------------------------------------------------

    /// Whether unit `i` takes a queued move right away: it is idle (or busy
    /// with an endless automatic task such as harvesting) and has no queue.
    fn ready_for_waypoint(&self, i: usize) -> bool {
        let a = &self.actors[i];
        a.waypoints.is_empty() && matches!(a.activity, Activity::Idle | Activity::Harvest) && a.heli.task == HeliTask::None
    }

    pub(crate) fn order_waypoint(&mut self, units: &[usize], x: i32, y: i32, attack_move: bool) {
        if units.is_empty() {
            return;
        }
        let group = self.next_group();
        let size = units.len() as i32;
        let mut now = Vec::new();
        for &i in units {
            if self.ready_for_waypoint(i) {
                now.push(i);
            } else if self.actors[i].waypoints.len() < MAX_WAYPOINTS {
                self.actors[i].waypoints.push(Waypoint { x, y, attack_move, group, group_size: size });
            }
        }
        self.start_move_group(&now, x, y, attack_move, group, size);
    }

    /// An idle unit with queued waypoints starts the next one.
    pub(crate) fn next_waypoint(&mut self, i: usize) {
        let a = &self.actors[i];
        if a.activity != Activity::Idle || a.waypoints.is_empty() || a.heli.task != HeliTask::None || a.air.parachute {
            return;
        }
        let wp = self.actors[i].waypoints.remove(0);
        self.start_move_group(&[i], wp.x, wp.y, wp.attack_move, wp.group, wp.group_size);
    }

    // ---- Stances ------------------------------------------------------------------------

    pub(crate) fn set_stance(&mut self, player: u8, ids: &[u32], stance: Stance) {
        let mut actors: Vec<usize> = ids
            .iter()
            .filter_map(|&r| self.resolve(r))
            .filter(|&i| self.actors[i].owner == player && self.actors[i].in_world() && self.has_stance(i))
            .collect();
        actors.sort_unstable();
        actors.dedup();
        for i in actors {
            let a = &mut self.actors[i];
            a.stance = stance;
            a.aggressor = NONE;
            // Fights the actor picked itself follow the new stance: none under
            // HoldFire, none that need moving under Defend and ReturnFire.
            let own_choice = a.activity == Activity::Attack && !a.forced && !a.attack_move && a.guard == NONE;
            if a.kind == Kind::Building {
                if stance == Stance::HoldFire {
                    a.target = NONE;
                }
            } else if own_choice && stance == Stance::HoldFire {
                a.target = NONE;
                a.activity = Activity::Idle;
            } else if own_choice && stance < Stance::AttackAnything {
                a.hold = true;
            }
        }
    }
}

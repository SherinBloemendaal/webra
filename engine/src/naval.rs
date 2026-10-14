//! Ships and submarines (OpenRA mods/ra ships.yaml): launching from naval
//! yards, repair near a yard (RepairableNear), submerging (Cloak with
//! UncloakOn: Attack and detection by DetectCloaked: Underwater), target
//! classes of submarines, water impact splashes and ship death effects.
//!
//! Movement itself is the shared flow-field movement on the water
//! passability (`World::pass_water`): ships never enter land cells, and crowd
//! separation only pushes units of the same domain. Weapons are the shared
//! combat code; what makes ships special is data (torpedoes and depth charges
//! target Underwater, the Cruiser's 8Inch has a minimum range and inaccuracy).
//! The transport (LST) uses the generic cargo system in cargo.rs.

use crate::math::{dist, facing_of, CELL};
use crate::rules::{Domain, Kind, TARGET_SUBMARINE, TARGET_UNDERWATER, TARGET_WATER};
use crate::world::{cell_center, Activity, Effect, EffectKind, World, NONE};

/// Naval special sprites, offsets from `SpriteIds::naval_base`. Must match
/// `NAVAL_SPECIALS` in apps/game/js/art/naval.js.
pub const NAVAL_TORPEDO: u8 = 0;
pub const NAVAL_DEPTH_CHARGE: u8 = 1;
pub const NAVAL_SPLASH: u8 = 2;
pub const NAVAL_RIPPLE: u8 = 3;
pub const NAVAL_WRECK: u8 = 4;

/// OpenRA RepairableNearInfo.CloseEnough: ships are repaired within 4 cells of the yard.
pub const REPAIR_NEAR_RANGE: i32 = 4 * CELL;

/// Health share below which a submarine cannot submerge (OpenRA: the Cloak
/// pauses at the Critical damage state, below 25 percent).
const CRITICAL_PERCENT: i32 = 25;

/// Ticks a water splash effect lasts.
const SPLASH_TTL: i32 = 14;
/// Ticks a sinking wreck stays visible.
const WRECK_TTL: i32 = 45;

impl World {
    /// One tick of a ship: the shared activities, except repair near a naval
    /// yard, then submarine diving.
    pub(crate) fn tick_ship(&mut self, i: usize) {
        if self.actors[i].activity == Activity::Repair {
            self.tick_ship_repair(i);
        } else {
            self.tick_unit_activity(i);
        }
        if self.actors[i].alive {
            self.tick_submarine(i);
        }
    }

    /// Whether actor type `ty` moves on water (ships).
    pub fn is_water_type(&self, ty: u16) -> bool {
        self.rules.actors[ty as usize].unit.as_ref().is_some_and(|u| self.rules.locomotors[u.locomotor].domain == Domain::Water)
    }

    /// Whether actor `i` is a submarine (a ship with a Cloak).
    pub fn is_submarine(&self, i: usize) -> bool {
        let a = &self.actors[i];
        a.kind == Kind::Ship && self.rules.actors[a.ty as usize].abilities.cloak.is_some()
    }

    // ---- Launching from a naval yard -------------------------------------------

    /// Cell and facing where a ship built at naval yard `b` would enter the
    /// world when nothing is in the way: the first of `naval_launch_cells`.
    pub(crate) fn naval_spawn_cell(&self, b: usize, ty: u16) -> Option<(i32, i32, i32)> {
        self.naval_launch_cells(b, ty).into_iter().next()
    }

    /// The cells (with facings) where a ship of type `ty` built at naval
    /// yard `b` may enter the world, best first: open water at each exit
    /// that lets it out (`exit_lets_out`: the sub pen's Submarine exits are
    /// (-1, 2), (3, 2) and its top corners, its Ship exits all four corners
    /// for units built as Ship), just outside the yard when the exit is one of its own
    /// corners. Water joined to the yard's rally point comes first, then the
    /// largest body of water (a yard on a shore may touch a pond too, and a
    /// ship launched into it could never leave; OpenRA issue 19154), then
    /// higher exit priority, then the exit nearest the rally point (OpenRA
    /// Production.SelectExit; without one, the exits in order); only cells
    /// on that first water count. Production takes the first one a ship can
    /// enter now (production.rs `select_exit`, OpenRA CanUseExit), so ships
    /// wait while every one is taken.
    pub(crate) fn naval_launch_cells(&self, b: usize, ty: u16) -> Vec<(i32, i32, i32)> {
        let ya = &self.actors[b];
        let Some(binfo) = self.rules.actors[ya.ty as usize].building.as_ref() else { return Vec::new() };
        let (w, h) = (binfo.width, binfo.height);
        let rally_area =
            ya.rally.map(|(rx, ry)| self.cell_index(rx, ry)).filter(|&c| !self.pass_water.blocked[c]).map(|c| self.pass_water.component[c]);
        // Not the rally point's water, smaller water, lower priority, farther from the rally point: worse.
        type ExitKey = (bool, std::cmp::Reverse<u32>, std::cmp::Reverse<i32>, i64);
        let mut cells: Vec<(ExitKey, (i32, i32))> = Vec::new();
        for (k, &(ex, ey)) in binfo.exits.iter().enumerate() {
            if !self.exit_lets_out(b, k, ty) {
                continue;
            }
            // Outward direction from the yard's centre through an exit on the
            // yard's own corner; an exit already outside it (the sub pen's
            // submarine exits) is the launch spot itself.
            let outside = ex < 0 || ex >= w || ey < 0 || ey >= h;
            let (dx, dy) = if outside { (0, 0) } else { ((2 * ex + 1 - w).signum(), (2 * ey + 1 - h).signum()) };
            let Some(c) = self.open_water_near(ya.cx + ex + dx, ya.cy + ey + dy, 3) else { continue };
            if cells.iter().any(|&(_, o)| o == c) {
                continue;
            }
            let ci = self.map.idx(c.0, c.1);
            let to_rally = ya.rally.map_or(0, |(rx, ry)| crate::math::dist_sq(cell_center(c.0), cell_center(c.1), rx, ry));
            let priority = binfo.exit_priority.get(k).copied().unwrap_or(1);
            let key = (
                rally_area.is_some_and(|r| r != self.pass_water.component[ci]),
                std::cmp::Reverse(self.pass_water.area_size(ci)),
                std::cmp::Reverse(priority),
                to_rally,
            );
            cells.push((key, c));
        }
        // Stable: equal cells keep the exits' order.
        cells.sort_by_key(|&(key, _)| key);
        // Only onto the chosen water: a ship waits rather than being launched
        // into a pond because the sea side of the yard is busy.
        let water = cells.first().map(|&(_, (x, y))| self.pass_water.component[self.map.idx(x, y)]);
        cells
            .into_iter()
            .filter(|&(_, (x, y))| Some(self.pass_water.component[self.map.idx(x, y)]) == water)
            .map(|(_, (cx, cy))| (cx, cy, facing_of(cell_center(cx) - ya.x, cell_center(cy) - ya.y).unwrap_or(512)))
            .collect()
    }

    /// Nearest open water cell to (x, y) within `radius` rings (ties: lowest index).
    fn open_water_near(&self, x: i32, y: i32, radius: i32) -> Option<(i32, i32)> {
        for r in 0..=radius {
            let mut best: Option<(i32, usize, (i32, i32))> = None;
            for cy in y - r..=y + r {
                for cx in x - r..=x + r {
                    if (cx - x).abs() != r && (cy - y).abs() != r {
                        continue;
                    }
                    if !self.map.contains(cx, cy) {
                        continue;
                    }
                    let ci = self.map.idx(cx, cy);
                    if self.pass_water.blocked[ci] {
                        continue;
                    }
                    let d = (cx - x).pow(2) + (cy - y).pow(2);
                    if best.is_none_or(|(bd, bi, _)| d < bd || (d == bd && ci < bi)) {
                        best = Some((d, ci, (cx, cy)));
                    }
                }
            }
            if let Some((_, _, c)) = best {
                return Some(c);
            }
        }
        None
    }

    // ---- Repair near a naval yard ----------------------------------------------

    /// RepairableNear: sail within `REPAIR_NEAR_RANGE` of the yard, then the
    /// yard's RepairsUnits heals the ship step by step (paid like the depot).
    fn tick_ship_repair(&mut self, i: usize) {
        let Some(d) = self.resolve(self.actors[i].depot) else {
            self.actors[i].activity = Activity::Idle;
            return;
        };
        if !self.repairs_at(i, d) || self.actors[d].owner != self.actors[i].owner {
            self.actors[i].activity = Activity::Idle;
            return;
        }
        let max_hp = self.rules.actors[self.actors[i].ty as usize].hp;
        if self.actors[i].hp >= max_hp {
            self.note_repaired(i, d);
            self.actors[i].activity = Activity::Idle;
            return;
        }
        let (x, y) = (self.actors[i].x, self.actors[i].y);
        if self.hit_distance(d, x, y) > REPAIR_NEAR_RANGE {
            // Head for the open water closest to the yard (computed once per order).
            let yard_cell = self.map.idx(self.actors[d].cx, self.actors[d].cy) as u32;
            if self.actors[i].goal == NONE || self.actors[i].chase_cell != yard_cell {
                let (gx, gy) = self.cell_of(self.actors[d].x, self.actors[d].y);
                let goal = self.path_goal(i, gx, gy);
                let a = &mut self.actors[i];
                a.goal = goal;
                a.chase_cell = yard_cell;
                a.best_dist = i32::MAX;
                a.stuck_ticks = 0;
            }
            let goal = self.actors[i].goal;
            if goal == NONE || self.goal_reached(i, goal, 0, false) {
                // The yard cannot be approached (no water route).
                self.actors[i].activity = Activity::Idle;
                return;
            }
            self.move_toward(i, goal);
            return;
        }
        let rep = self.rules.actors[self.actors[d].ty as usize].building.as_ref().unwrap().repairs.clone().unwrap();
        self.note_service(d);
        self.repair_step(i, d, &rep);
    }

    // ---- Submarines --------------------------------------------------------------

    /// OpenRA Cloak on submarines: submerged once the cloak timer runs out,
    /// surfaced while critically damaged; refreshes which players detect it.
    fn tick_submarine(&mut self, i: usize) {
        let ty = self.actors[i].ty as usize;
        let Some(cloak) = self.rules.actors[ty].abilities.cloak.clone() else { return };
        if self.actors[i].kind != Kind::Ship {
            return;
        }
        let max = self.rules.actors[ty].hp;
        let a = &mut self.actors[i];
        let was = a.submerged;
        if a.hp * 100 < max * CRITICAL_PERCENT {
            // PauseOnCondition: cloak-force-disabled (Critical): stays surfaced, timer frozen.
            a.submerged = false;
        } else {
            if a.cloak_timer > 0 {
                a.cloak_timer -= 1;
            }
            a.submerged = a.cloak_timer <= 0;
        }
        if a.submerged != was {
            self.note_cloak(i);
        }
        self.actors[i].detected_by = if self.actors[i].submerged { self.detectors_of(i, &cloak.types) } else { 0 };
    }

    /// Players (bit per slot) with a DetectCloaked actor of a matching type in range of `i`.
    pub(crate) fn detectors_of(&self, i: usize, cloak_types: &[String]) -> u32 {
        let (x, y, owner) = (self.actors[i].x, self.actors[i].y, self.actors[i].owner);
        let mut mask = 0u32;
        for d in &self.actors {
            if !d.alive || !d.in_world() || d.owner == owner || d.owner >= 32 {
                continue;
            }
            let Some(det) = &self.rules.actors[d.ty as usize].abilities.detect_cloaked else { continue };
            if !det.types.iter().any(|t| cloak_types.contains(t)) {
                continue;
            }
            // Detection that needs power (Tesla Coil) stops on low power or when switched off (repair.rs).
            if det.needs_power && (self.players[d.owner as usize].low_power() || d.powered_off) {
                continue;
            }
            if dist(x, y, d.x, d.y) <= det.range {
                mask |= 1 << d.owner;
            }
        }
        // Sonar Pulses (infantry.rs).
        mask | self.pulse_detectors(x, y, owner, cloak_types)
    }

    /// Visibility rule for ships: submerged submarines show only to their
    /// owner, allies, and players whose (or whose allies') detectors reveal them.
    pub(crate) fn naval_visible(&self, i: usize, player: u8) -> bool {
        let a = &self.actors[i];
        // The spectator views (observer.rs, combined.rs) show submerged submarines too.
        if self.render_all || self.render_combined || !a.submerged || self.are_allies(a.owner, player) {
            return true;
        }
        (0..self.players.len().min(32)).any(|p| a.detected_by & (1 << p) != 0 && self.are_allies(p as u8, player))
    }

    /// Target classes of a ship: surfaced submarines are WaterActor and
    /// Submarine, submerged ones Underwater and Submarine (only depth charges
    /// and torpedoes can hit them); other ships are WaterActor.
    pub(crate) fn ship_target_class(&self, i: usize) -> u32 {
        if !self.is_submarine(i) {
            return TARGET_WATER;
        }
        if self.actors[i].submerged {
            TARGET_UNDERWATER | TARGET_SUBMARINE
        } else {
            TARGET_WATER | TARGET_SUBMARINE
        }
    }

    /// Called when actor `i` fires: submarines surface and stay up for CloakDelay ticks.
    pub(crate) fn naval_on_fire(&mut self, i: usize) {
        if self.actors[i].kind != Kind::Ship {
            return;
        }
        let Some(cloak) = &self.rules.actors[self.actors[i].ty as usize].abilities.cloak else { return };
        if !cloak.uncloak_on.iter().any(|u| u == "Attack") {
            return;
        }
        let delay = cloak.cloak_delay;
        let a = &mut self.actors[i];
        let was = a.submerged;
        a.submerged = false;
        a.detected_by = 0;
        a.cloak_timer = a.cloak_timer.max(delay);
        if was {
            self.note_cloak(i);
        }
    }

    // ---- Effects -------------------------------------------------------------------

    /// Ship death: a sinking wreck and a large splash on top of the explosion.
    pub(crate) fn ship_death_effect(&mut self, i: usize) {
        let (x, y) = (self.actors[i].x, self.actors[i].y);
        self.effects.push(Effect { x, y, tx: x, ty: y, kind: EffectKind::Naval(NAVAL_WRECK), ttl: WRECK_TTL, max: WRECK_TTL });
        // The death weapon's own explosions replace WebRA's splash (fx.rs).
        if !self.has_death_explosions(i) {
            self.effects.push(Effect {
                x,
                y,
                tx: x,
                ty: y,
                kind: EffectKind::Naval(NAVAL_SPLASH),
                ttl: SPLASH_TTL * 2,
                max: SPLASH_TTL * 2,
            });
        }
    }

    /// Naval special sprite for a projectile of weapon `w` (torpedoes, depth charges), if any.
    pub(crate) fn naval_projectile_sprite(&self, w: usize) -> Option<u8> {
        let wi = &self.rules.weapons[w];
        if wi.valid & TARGET_UNDERWATER == 0 {
            return None;
        }
        match wi.projectile {
            crate::rules::Projectile::Missile => Some(NAVAL_TORPEDO),
            crate::rules::Projectile::Bullet if wi.valid == TARGET_UNDERWATER => Some(NAVAL_DEPTH_CHARGE),
            _ => None,
        }
    }
}

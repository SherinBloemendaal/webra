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

    /// Cell and facing where a ship built at naval yard `b` enters the world:
    /// open water just outside one of the yard's exits (the exit cells are the
    /// yard's own corners). Picks the exit with the fewest units nearby, so
    /// ships fan out; None while every exit is blocked.
    pub(crate) fn naval_spawn_cell(&self, b: usize) -> Option<(i32, i32, i32)> {
        let ya = &self.actors[b];
        let binfo = self.rules.actors[ya.ty as usize].building.as_ref()?;
        let (w, h) = (binfo.width, binfo.height);
        let mut best: Option<(usize, (i32, i32))> = None;
        for &(ex, ey) in &binfo.exits {
            // Outward direction from the yard's centre through the exit cell.
            let (dx, dy) = ((2 * ex + 1 - w).signum(), (2 * ey + 1 - h).signum());
            let Some(c) = self.open_water_near(ya.cx + ex + dx, ya.cy + ey + dy, 3) else { continue };
            let crowd = self.units_in_cell(self.map.idx(c.0, c.1)).len();
            if best.is_none_or(|(n, _)| crowd < n) {
                best = Some((crowd, c));
            }
        }
        let (cx, cy) = best?.1;
        let facing = facing_of(cell_center(cx) - ya.x, cell_center(cy) - ya.y).unwrap_or(512);
        Some((cx, cy, facing))
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
        self.repair_step(i, &rep);
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
        if a.hp * 100 < max * CRITICAL_PERCENT {
            // PauseOnCondition: cloak-force-disabled (Critical): stays surfaced, timer frozen.
            a.submerged = false;
        } else {
            if a.cloak_timer > 0 {
                a.cloak_timer -= 1;
            }
            a.submerged = a.cloak_timer <= 0;
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
            // Detection that needs power (Tesla Coil) stops on low power.
            if det.needs_power && self.players[d.owner as usize].low_power() {
                continue;
            }
            if dist(x, y, d.x, d.y) <= det.range {
                mask |= 1 << d.owner;
            }
        }
        mask
    }

    /// Visibility rule for ships: submerged submarines show only to their
    /// owner, allies, and players whose (or whose allies') detectors reveal them.
    pub(crate) fn naval_visible(&self, i: usize, player: u8) -> bool {
        let a = &self.actors[i];
        if !a.submerged || self.are_allies(a.owner, player) {
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
        a.submerged = false;
        a.detected_by = 0;
        a.cloak_timer = a.cloak_timer.max(delay);
    }

    // ---- Effects -------------------------------------------------------------------

    /// A shot landing in open water (no structure, no surface unit hit) makes a
    /// splash instead of an explosion; depth charges on submerged subs too.
    pub(crate) fn water_impact_effect(&self, x: i32, y: i32, ttl: i32) -> Option<(EffectKind, i32)> {
        let ci = self.cell_index(x, y);
        if self.map.terrain[ci] != crate::map::Terrain::Water || self.building_at[ci] != NONE {
            return None;
        }
        let surface_hit = self.units_in_cell(ci).iter().any(|&u| {
            let a = &self.actors[u as usize];
            a.alive && !a.submerged && dist(x, y, a.x, a.y) <= CELL / 2
        });
        if surface_hit {
            return None;
        }
        Some((EffectKind::Naval(NAVAL_SPLASH), SPLASH_TTL.max(ttl)))
    }

    /// Ship death: a sinking wreck and a large splash on top of the explosion.
    pub(crate) fn ship_death_effect(&mut self, i: usize) {
        let (x, y) = (self.actors[i].x, self.actors[i].y);
        self.effects.push(Effect { x, y, tx: x, ty: y, kind: EffectKind::Naval(NAVAL_WRECK), ttl: WRECK_TTL, max: WRECK_TTL });
        self.effects.push(Effect { x, y, tx: x, ty: y, kind: EffectKind::Naval(NAVAL_SPLASH), ttl: SPLASH_TTL * 2, max: SPLASH_TTL * 2 });
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

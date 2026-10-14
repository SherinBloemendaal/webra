//! Helicopters (Chinook, Black Hawk, Longbow, Hind): hovering flight, landing,
//! ammo and rearming at helipads, repair at the service depot, crashing.
//!
//! Follows OpenRA's `Aircraft` trait with `CanHover`, `VTOL` and `CanSlide`:
//! helicopters take off and land vertically, hover in place when idle, turn in
//! place and slide straight toward where they fly while turning. Attacks use
//! `AttackType: Hover`: stop in range and fire once within `FacingTolerance`
//! of the target. Idle helicopters follow their fire stance (combat.rs; they
//! start on `InitialStance: HoldFire`) and pick targets on attack-move. `AmmoPool` rounds are spent one per shot;
//! an empty helicopter flies back to a free helipad (`Rearmable`, one
//! helicopter per pad through `Reservable`), lands and reloads `ReloadCount`
//! rounds every `ReloadDelay` ticks, then takes off (`TakeOffOnResupply`).
//! Damaged helicopters land on the service depot (`Repairable`), in turn
//! (service.rs: they hover nearby while they wait). Shot down in
//! the air, the husk falls (`FallsToEarth`) and explodes on the ground.

use crate::combat::FireTarget;
use crate::math::{angle_diff, dist, dist_sq, facing_of, isqrt, turn_toward, wrap_angle, CELL};
use crate::render::px;
use crate::rules::{AircraftInfo, Kind};
use crate::world::{cell_center, Activity, Effect, EffectKind, PendingImpact, SmartAction, World, MAX_WEAPONS, NONE};

/// Rotor turn per tick (1024 is a full circle) in the air and on the ground
/// (OpenRA plays `rotor` while airborne, `slow-rotor` on the ground).
const ROTOR_SPIN_AIR: i32 = 168;
const ROTOR_SPIN_GROUND: i32 = 20;
/// OpenRA FallsToEarthInfo.Velocity default (world units per tick).
const FALL_VELOCITY: i32 = 43;
/// The falling husk spins up by this much per tick, to at most `FALL_SPIN_MAX`.
const FALL_SPIN_STEP: i32 = 3;
const FALL_SPIN_MAX: i32 = 64;
/// Search radius (cells) for a free landing spot around the ordered cell.
const LAND_SEARCH: i32 = 3;
/// Snap to the landing point within this distance while descending.
const LAND_SNAP: i32 = 128;
/// Sprite indexes in `HELI_SPECIALS` (apps/game/js/art/helis.js).
const SPECIAL_ROTOR_DISC: f32 = 0.0;
const SPECIAL_ROTOR_WASH: f32 = 1.0;
const SPECIAL_SMOKE: f32 = 2.0;
/// Radius (world units) the rotor disc sprite is drawn for at scale 1.
const ROTOR_DISC_RADIUS: i32 = 512;

/// What a helicopter is doing beyond the shared activities.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum HeliTask {
    #[default]
    None,
    /// Fly to `land_x, land_y` and touch down there.
    Land,
    /// Fly to a free rearm structure (helipad), land on it and reload.
    Resupply,
}

#[derive(Clone, Copy, Debug)]
pub struct HeliState {
    pub task: HeliTask,
    /// Rounds spent from the AmmoPool (0 is full), so new actors start full.
    pub ammo_used: i32,
    /// Ticks to the next reload step while resupplying (0: not started).
    pub rearm_timer: i32,
    /// Helipad reserved by this helicopter, or NONE.
    pub pad: u32,
    pub land_x: i32,
    pub land_y: i32,
    /// Touched down (altitude 0 after a landing), until it takes off again.
    pub landed: bool,
    /// Resupply ordered onto a chosen helipad: land there even with full ammo
    /// and stay (OpenRA ReturnToBase `alwaysLand`).
    pub always_land: bool,
    /// `land_x, land_y` holds the spot chosen to land on for unloading.
    pub unload_spot: bool,
    /// The attack to take up again once rearmed (AbortOnResupply false):
    /// the target actor, or NONE; `resume_ground`: the ground at `fire_at`.
    pub resume: u32,
    pub resume_forced: bool,
    pub resume_ground: bool,
}

impl Default for HeliState {
    fn default() -> Self {
        HeliState {
            task: HeliTask::None,
            ammo_used: 0,
            rearm_timer: 0,
            pad: NONE,
            land_x: 0,
            land_y: 0,
            landed: false,
            always_land: false,
            unload_spot: false,
            resume: NONE,
            resume_forced: false,
            resume_ground: false,
        }
    }
}

/// A helicopter husk falling after being shot down.
#[derive(Clone)]
pub struct Crash {
    pub ty: u16,
    pub owner: u8,
    pub x: i32,
    pub y: i32,
    pub altitude: i32,
    pub palt: i32,
    pub facing: i32,
    pub pfacing: i32,
    pub spin: i32,
}

impl World {
    fn heli_air(&self, i: usize) -> &AircraftInfo {
        self.rules.actors[self.actors[i].ty as usize].unit.as_ref().and_then(|u| u.aircraft.as_ref()).expect("aircraft info")
    }

    fn is_heli(&self, i: usize) -> bool {
        self.actors[i].kind == Kind::Aircraft && self.is_helicopter(i)
    }

    /// Rounds left and pool size (0, 0 for helicopters without an AmmoPool).
    pub fn heli_ammo(&self, i: usize) -> (i32, i32) {
        if !self.is_heli(i) {
            return (0, 0);
        }
        let max = self.heli_air(i).ammo;
        ((max - self.actors[i].heli.ammo_used).max(0), max)
    }

    fn type_listed(&self, b: usize, list: &[String]) -> bool {
        let id = &self.rules.actors[self.actors[b].ty as usize].id;
        list.iter().any(|x| x.eq_ignore_ascii_case(id))
    }

    fn is_rearm_pad_for(&self, i: usize, b: usize) -> bool {
        self.type_listed(b, &self.heli_air(i).rearm_actors)
    }

    /// Whether helicopter `i` is repaired at structure `b` (the repair cursor, repair.rs).
    pub(crate) fn heli_repairs_at(&self, i: usize, b: usize) -> bool {
        self.is_heli(i) && self.is_repair_depot_for(i, b)
    }

    fn is_repair_depot_for(&self, i: usize, b: usize) -> bool {
        self.type_listed(b, &self.heli_air(i).repair_actors)
            && self.rules.actors[self.actors[b].ty as usize].building.as_ref().is_some_and(|bi| bi.repairs.is_some())
    }

    /// Where helicopters touch down on a helipad: the building centre (with LocalCenterOffset).
    fn pad_point(&self, b: usize) -> (i32, i32) {
        let a = &self.actors[b];
        let off = self.rules.actors[a.ty as usize].building.as_ref().map_or((0, 0), |bi| bi.center_offset);
        (a.x + off.0, a.y + off.1)
    }

    /// Where helicopters touch down on a service depot: the middle of the pad
    /// (`repair_pad_cell`, service.rs).
    fn depot_point(&self, d: usize) -> (i32, i32) {
        let a = &self.actors[d];
        let b = self.rules.actors[a.ty as usize].building.as_ref().unwrap();
        (cell_center(a.cx + b.width / 2), cell_center(a.cy + b.height / 2))
    }

    /// A pad is free when nobody holds it, or the holder is `me`, or the
    /// holder is gone or no longer heading for it (reservations clear lazily).
    fn pad_free_for(&self, b: usize, me: u32) -> bool {
        match self.resolve(self.actors[b].dock_user) {
            None => true,
            Some(u) => self.make_ref(u) == me || self.actors[u].heli.pad != self.make_ref(b),
        }
    }

    fn reserve_pad(&mut self, i: usize, b: usize) {
        let me = self.make_ref(i);
        let br = self.make_ref(b);
        self.actors[b].dock_user = me;
        self.actors[i].heli.pad = br;
    }

    fn release_pad(&mut self, i: usize) {
        if let Some(b) = self.resolve(self.actors[i].heli.pad) {
            if self.actors[b].dock_user == self.make_ref(i) {
                self.actors[b].dock_user = NONE;
            }
        }
        self.actors[i].heli.pad = NONE;
    }

    /// New order: end the current task and give up the reserved helipad.
    pub(crate) fn heli_cancel(&mut self, i: usize) {
        if !self.is_heli(i) {
            return;
        }
        self.release_pad(i);
        let h = &mut self.actors[i].heli;
        h.task = HeliTask::None;
        h.rearm_timer = 0;
        h.always_land = false;
        h.unload_spot = false;
        h.resume = NONE;
        h.resume_ground = false;
    }

    // ---- Tick --------------------------------------------------------------------

    /// One tick of a helicopter.
    pub(crate) fn tick_helicopter(&mut self, i: usize) {
        {
            let a = &mut self.actors[i];
            let spin = if a.altitude > 0 { ROTOR_SPIN_AIR } else { ROTOR_SPIN_GROUND };
            a.turret = wrap_angle(a.turret + spin);
        }
        match self.actors[i].heli.task {
            HeliTask::Land => self.tick_heli_land(i),
            HeliTask::Resupply => self.tick_heli_resupply(i),
            HeliTask::None => match self.actors[i].activity {
                Activity::Idle => self.tick_heli_idle(i),
                Activity::Move => self.tick_heli_move(i),
                Activity::Attack => self.tick_heli_attack(i),
                Activity::Repair => self.tick_heli_repair(i),
                Activity::Unload => self.tick_heli_unload(i),
                Activity::Guard => self.tick_heli_guard(i),
                Activity::AttackGround => {
                    let (x, y) = self.actors[i].fire_at;
                    let class = self.ground_class(x, y);
                    self.heli_engage(i, FireTarget::Ground(x, y), class);
                }
                Activity::Harvest | Activity::Board | Activity::Ability | Activity::Enter => self.actors[i].activity = Activity::Idle,
            },
        }
    }

    /// Climb vertically toward cruise altitude (VTOL take-off). True once there.
    fn heli_climb(&mut self, i: usize) -> bool {
        let (cruise, vel) = {
            let air = self.heli_air(i);
            (air.cruise_altitude, air.altitude_velocity.max(1))
        };
        let a = &mut self.actors[i];
        if a.altitude >= cruise {
            return true;
        }
        a.heli.landed = false;
        a.altitude = (a.altitude + vel).min(cruise);
        false
    }

    /// Slide toward a point at full speed while turning to face it
    /// (OpenRA CanSlide). True once exactly there.
    fn heli_fly(&mut self, i: usize, tx: i32, ty: i32) -> bool {
        let unit = self.rules.actors[self.actors[i].ty as usize].unit.as_ref().unwrap();
        // Veterans fly faster (SpeedMultiplier, veterancy.rs).
        let (speed, turn) = (self.modified_speed(i, unit.speed).max(1), unit.turn_speed);
        let (max_x, max_y) = (self.map.width * CELL - 1, self.map.height * CELL - 1);
        let (tx, ty) = (tx.clamp(0, max_x), ty.clamp(0, max_y));
        let a = &mut self.actors[i];
        let d = dist(a.x, a.y, tx, ty);
        if d <= speed {
            a.moved = d > 0;
            a.x = tx;
            a.y = ty;
            return true;
        }
        if let Some(f) = facing_of(tx - a.x, ty - a.y) {
            a.facing = turn_toward(a.facing, f, turn);
        }
        a.x += ((tx - a.x) as i64 * speed as i64 / d as i64) as i32;
        a.y += ((ty - a.y) as i64 * speed as i64 / d as i64) as i32;
        a.moved = true;
        false
    }

    /// Fly to a point at cruise altitude, then descend onto it. True once
    /// landed there.
    fn heli_approach_and_land(&mut self, i: usize, x: i32, y: i32) -> bool {
        let a = &self.actors[i];
        let d = dist(a.x, a.y, x, y);
        if a.heli.landed && d <= LAND_SNAP {
            return true;
        }
        if d > LAND_SNAP {
            // VTOL: horizontal flight only at cruise altitude.
            if self.heli_climb(i) {
                self.heli_fly(i, x, y);
            }
            return false;
        }
        let vel = self.heli_air(i).altitude_velocity.max(1);
        let a = &mut self.actors[i];
        a.x = x;
        a.y = y;
        a.altitude = (a.altitude - vel).max(0);
        if a.altitude == 0 {
            a.heli.landed = true;
            return true;
        }
        false
    }

    fn heli_arrive_radius(&self, i: usize) -> i32 {
        let a = &self.actors[i];
        if a.group_size <= 1 {
            return 0;
        }
        let r = self.rules.actors[a.ty as usize].unit.as_ref().unwrap().radius;
        r * isqrt(a.group_size as i64) as i32 * 13 / 10
    }

    fn tick_heli_idle(&mut self, i: usize) {
        if self.actors[i].heli.landed {
            self.heli_landed_service(i);
            return;
        }
        // Hover at cruise altitude (climb back after a stop during a landing).
        if !self.heli_climb(i) {
            return;
        }
        // Stances (combat.rs): helicopters start on HoldFire.
        self.try_idle_target(i);
    }

    /// Guard (commands.rs): hover near the guarded unit and fight what comes near.
    fn tick_heli_guard(&mut self, i: usize) {
        let Some(g) = self.guarded(i) else {
            self.end_guard(i);
            return;
        };
        if !self.heli_climb(i) || self.try_auto_target(i) {
            return;
        }
        let (gx, gy) = (self.actors[g].x, self.actors[g].y);
        if dist(self.actors[i].x, self.actors[i].y, gx, gy) > crate::commands::GUARD_RANGE {
            self.heli_fly(i, gx, gy);
        }
    }

    /// A helicopter standing on an own helipad keeps it reserved and reloads;
    /// on a service depot it gets repaired when damaged.
    fn heli_landed_service(&mut self, i: usize) {
        let ci = self.cell_index(self.actors[i].x, self.actors[i].y);
        let b = self.building_at[ci];
        if b == NONE {
            return;
        }
        let b = b as usize;
        if !self.actors[b].alive || self.actors[b].owner != self.actors[i].owner {
            return;
        }
        let me = self.make_ref(i);
        if self.is_rearm_pad_for(i, b) && self.pad_free_for(b, me) {
            self.reserve_pad(i, b);
            if self.actors[i].heli.ammo_used > 0 {
                self.actors[i].heli.task = HeliTask::Resupply;
            }
            return;
        }
        let max_hp = self.rules.actors[self.actors[i].ty as usize].hp;
        if self.is_repair_depot_for(i, b) && self.actors[i].hp < max_hp {
            self.enter_service_line(i, b);
        }
    }

    fn tick_heli_move(&mut self, i: usize) {
        if !self.heli_climb(i) {
            return;
        }
        if self.actors[i].attack_move && self.try_auto_target(i) {
            return;
        }
        let goal = self.actors[i].goal;
        if goal == NONE {
            self.actors[i].activity = Activity::Idle;
            return;
        }
        let (gx, gy) = (cell_center(goal as i32 % self.map.width), cell_center(goal as i32 / self.map.width));
        let a = &self.actors[i];
        if dist(a.x, a.y, gx, gy) <= self.heli_arrive_radius(i) {
            let a = &mut self.actors[i];
            a.activity = Activity::Idle;
            a.attack_move = false;
            return;
        }
        self.heli_fly(i, gx, gy);
    }

    fn tick_heli_attack(&mut self, i: usize) {
        let Some(t) = self.live_target(i) else {
            if self.heli_chase_last_seen(i) {
                return;
            }
            self.actors[i].target = NONE;
            self.actors[i].target_seen = None;
            if self.resume_guard(i) {
                return;
            }
            if self.actors[i].attack_move {
                let (dx, dy) = self.actors[i].dest;
                let (gx, gy) = self.cell_of(dx, dy);
                let goal = self.path_goal(i, gx, gy);
                let a = &mut self.actors[i];
                a.goal = goal;
                a.activity = if goal == NONE { Activity::Idle } else { Activity::Move };
            } else {
                self.actors[i].activity = Activity::Idle;
            }
            return;
        };
        self.actors[i].target_seen = Some(self.tick_start_pos(t));
        let class = self.target_kind(t).target_class();
        self.heli_engage(i, FireTarget::Actor(t), class);
    }

    /// The target is out of sight (OpenRA FlyAttack with its last visible
    /// target): fly to where it was last seen and pick it up again once it
    /// shows; false when it is gone, may not be chased (`hold`), or the
    /// helicopter got within weapon range of that spot without seeing it.
    fn heli_chase_last_seen(&mut self, i: usize) -> bool {
        let a = &self.actors[i];
        let (owner, forced) = (a.owner, a.forced);
        let Some((lx, ly)) = a.target_seen.filter(|_| !a.hold) else { return false };
        let Some(t) = self.resolve(a.target) else { return false };
        if t == i
            || !self.actors[t].in_world()
            || self.untargetable_aircraft(t)
            || !(forced || self.are_enemies(owner, self.actors[t].owner))
        {
            return false;
        }
        let range = self.rules.actors[self.actors[i].ty as usize].range_against(&self.rules, self.target_class(t));
        if range == 0 || dist(self.actors[i].x, self.actors[i].y, lx, ly) <= range {
            return false;
        }
        if !self.heli_climb(i) {
            return true;
        }
        self.heli_fly(i, lx, ly);
        true
    }

    /// Out of ammo during an attack (OpenRA FlyAttack). On an attack-move it
    /// never resupplies: the attack ends and the move goes on (its scans
    /// skip targets while the AmmoPool is empty, `has_ammo`). Otherwise it
    /// flies to a helipad to reload (ReturnToBase); without AbortOnResupply
    /// (WebRA's default) the attack is taken up again once full
    /// (`heli_resume`), with it (OpenRA's default) the attack and the queued
    /// orders end. A new order meanwhile cancels the resume (`heli_cancel`).
    fn heli_out_of_ammo(&mut self, i: usize, ft: FireTarget) {
        if self.actors[i].attack_move {
            let (dx, dy) = self.actors[i].dest;
            let (gx, gy) = self.cell_of(dx, dy);
            let goal = self.path_goal(i, gx, gy);
            let a = &mut self.actors[i];
            a.target = NONE;
            a.goal = goal;
            a.activity = if goal == NONE { Activity::Idle } else { Activity::Move };
            return;
        }
        let abort = self.abort_on_resupply(i);
        let resume = match ft {
            FireTarget::Actor(_) if !abort => self.actors[i].target,
            _ => NONE,
        };
        // Where the target was: the resumed attack heads there when the
        // helipad is out of sight of it (OpenRA FlyAttack lastVisibleTarget).
        if let FireTarget::Actor(t) = ft {
            self.actors[i].target_seen = Some(self.tick_start_pos(t));
        }
        let a = &mut self.actors[i];
        a.heli.resume = resume;
        a.heli.resume_forced = a.forced;
        a.heli.resume_ground = !abort && matches!(ft, FireTarget::Ground(..));
        if abort {
            a.waypoints.clear();
        }
        a.target = NONE;
        a.attack_move = false;
        a.activity = Activity::Idle;
        if !self.heli_air(i).rearm_actors.is_empty() {
            self.actors[i].heli.task = HeliTask::Resupply;
        }
    }

    /// Rearmed (AbortOnResupply false): take the attack up again, on the
    /// same actor while it can still be hit, or on the same ground.
    fn heli_resume(&mut self, i: usize) {
        let h = self.actors[i].heli;
        let a = &mut self.actors[i];
        a.heli.resume = NONE;
        a.heli.resume_ground = false;
        if h.resume_ground {
            a.activity = Activity::AttackGround;
            a.forced = true;
            return;
        }
        if h.resume == NONE {
            return;
        }
        a.target = h.resume;
        a.forced = h.resume_forced;
        a.hold = false;
        // Still there and still something its weapons hit (seen or not: it
        // heads for where it saw it, `tick_heli_attack`).
        let owner = self.actors[i].owner;
        let valid = self.resolve(h.resume).is_some_and(|t| {
            self.actors[t].in_world()
                && !self.untargetable_aircraft(t)
                && (h.resume_forced || self.are_enemies(owner, self.actors[t].owner))
                && self.can_attack_actor(i, t)
        });
        if valid {
            self.actors[i].activity = Activity::Attack;
        } else {
            self.actors[i].target = NONE;
            self.actors[i].target_seen = None;
        }
    }

    /// Fly into range of a target (an actor, or the ground) and fire on it
    /// while it lies within `FacingTolerance`; `tclass` is its target class.
    fn heli_engage(&mut self, i: usize, ft: FireTarget, tclass: u32) {
        let (ammo, max_ammo) = self.heli_ammo(i);
        if max_ammo > 0 && ammo == 0 {
            self.heli_out_of_ammo(i, ft);
            return;
        }
        if !self.heli_climb(i) {
            return;
        }
        let ty = self.actors[i].ty as usize;
        let info = &self.rules.actors[ty];
        let mut range = 0;
        let mut min_range = i32::MAX;
        for &w in &info.weapons {
            let wi = &self.rules.weapons[w];
            if wi.can_target_class(tclass) {
                range = range.max(wi.range);
                min_range = min_range.min(wi.min_range);
            }
        }
        if range == 0 {
            let a = &mut self.actors[i];
            a.target = NONE;
            a.activity = Activity::Idle;
            return;
        }
        let tolerance = self.heli_air(i).facing_tolerance;
        let turn = info.unit.as_ref().unwrap().turn_speed;
        let (x, y) = (self.actors[i].x, self.actors[i].y);
        let (tx, ty_) = self.fire_target_pos(ft);
        let d = self.fire_target_distance(ft, x, y);
        if d > range {
            // Defend and ReturnFire fights never move it: out of reach ends them.
            if self.actors[i].hold {
                let a = &mut self.actors[i];
                a.target = NONE;
                a.hold = false;
                a.activity = Activity::Idle;
                return;
            }
            if !self.actors[i].forced && self.actors[i].attack_move && self.try_auto_target(i) {
                return;
            }
            let (ax, ay) = match ft {
                FireTarget::Actor(t) => self.aim_point(t, x, y),
                FireTarget::Ground(gx, gy) => (gx, gy),
            };
            self.heli_fly(i, ax, ay);
            return;
        }
        if d < min_range {
            // Too close for the weapon: back off away from the target.
            let len = dist(0, 0, x - tx, y - ty_).max(1);
            let (bx, by) = (x + (x - tx) * 2 * CELL / len, y + (y - ty_) * 2 * CELL / len);
            self.heli_fly(i, bx, by);
            return;
        }
        // Hover in range, turn to the target and fire within the facing tolerance.
        let desired = facing_of(tx - x, ty_ - y).unwrap_or(self.actors[i].facing);
        let a = &mut self.actors[i];
        a.facing = turn_toward(a.facing, desired, turn);
        if angle_diff(a.facing, desired).abs() > tolerance {
            return;
        }
        let reload_override = self.rules.actors[ty].reload_override;
        let slots = self.rules.actors[ty].weapons.len().min(MAX_WEAPONS);
        for slot in 0..slots {
            if max_ammo > 0 && self.actors[i].heli.ammo_used >= max_ammo {
                break;
            }
            let w = self.rules.actors[ty].weapons[slot];
            let wi = &self.rules.weapons[w];
            if self.actors[i].reload[slot] > 0 || !wi.can_target_class(tclass) || d > wi.range || d < wi.min_range {
                continue;
            }
            self.fire_on(i, ft, w);
            let wi = &self.rules.weapons[w];
            let full_reload = self.modified_reload(i, reload_override.unwrap_or(wi.reload));
            let a = &mut self.actors[i];
            // AmmoPool: one round per shot.
            if max_ammo > 0 {
                a.heli.ammo_used += 1;
            }
            a.burst_shot[slot] += 1;
            if a.burst_shot[slot] < wi.burst {
                a.reload[slot] = wi.burst_delay(a.burst_shot[slot] - 1).max(1);
            } else {
                a.burst_shot[slot] = 0;
                a.reload[slot] = full_reload;
            }
        }
    }

    /// A helicopter sent to the service depot (service.rs): hover over its
    /// waiting cell until it is first in line and the pad is free, then land
    /// on the pad, get repaired, and leave for the rally point or a free spot
    /// nearby.
    fn tick_heli_repair(&mut self, i: usize) {
        self.sync_service(i);
        let Some(d) = self.service_depot(i) else {
            self.end_service(i);
            return;
        };
        self.refresh_service_index();
        let (x, y) = self.depot_point(d);
        if self.pad_holder(d) != Some(i) {
            if !self.needs_service(i, d) {
                self.end_service(i);
                return;
            }
            if self.actors[i].svc.ticket == 0 {
                let join = self.heli_air(i).wait_distance + 2 * CELL;
                if dist(self.actors[i].x, self.actors[i].y, x, y) > join {
                    if self.heli_climb(i) {
                        self.heli_fly(i, x, y);
                    }
                    return;
                }
                self.join_service_line(i);
            }
            if !self.call_to_pad(i, d) {
                // Hover over the waiting cell (OpenRA waits WaitDistanceFromResupplyBase away).
                if self.actors[i].svc.slot == NONE && self.may_pick_slot(i) {
                    let s = self.pick_slot(i, d);
                    self.set_slot(i, s);
                }
                if !self.heli_climb(i) {
                    return;
                }
                let slot = self.actors[i].svc.slot;
                if slot != NONE {
                    let (sx, sy) = self.cell_point(slot);
                    self.heli_fly(i, sx, sy);
                }
                return;
            }
        }
        if !self.heli_approach_and_land(i, x, y) {
            if !self.needs_service(i, d) {
                self.end_service(i);
            }
            return;
        }
        if !self.needs_service(i, d) {
            self.leave_depot(i, d);
            return;
        }
        // The depot's repair animation (fx.rs, presentation only).
        self.note_service(d);
        let rep = self.rules.actors[self.actors[d].ty as usize].building.as_ref().unwrap().repairs.clone().unwrap();
        self.repair_step(i, d, &rep);
    }

    /// Unload (Chinook): land on (or next to) the current spot, let the
    /// passengers out (cargo.rs), then take off again.
    fn tick_heli_unload(&mut self, i: usize) {
        if !self.actors[i].heli.landed {
            let h = self.actors[i].heli;
            let (lx, ly) = self.cell_of(h.land_x, h.land_y);
            if !h.unload_spot || !self.heli_can_land(i, lx, ly) {
                let (cx, cy) = self.cell_of(self.actors[i].x, self.actors[i].y);
                match self.heli_landing_spot(i, cx, cy) {
                    Some((nx, ny)) => {
                        let h = &mut self.actors[i].heli;
                        h.land_x = cell_center(nx);
                        h.land_y = cell_center(ny);
                        h.unload_spot = true;
                    }
                    None => {
                        // Nowhere to land here: keep the passengers aboard.
                        self.actors[i].activity = Activity::Idle;
                        return;
                    }
                }
            }
            let (x, y) = (self.actors[i].heli.land_x, self.actors[i].heli.land_y);
            self.heli_approach_and_land(i, x, y);
            return;
        }
        self.tick_unit_activity(i);
        if self.actors[i].activity != Activity::Unload {
            // Everyone is out: take off again (helicopters hover when idle).
            let a = &mut self.actors[i];
            a.heli.unload_spot = false;
            a.heli.landed = false;
        }
    }

    fn tick_heli_land(&mut self, i: usize) {
        let (x, y) = (self.actors[i].heli.land_x, self.actors[i].heli.land_y);
        let a = &self.actors[i];
        if !a.heli.landed && dist(a.x, a.y, x, y) <= LAND_SNAP {
            // About to touch down: the spot may have been taken meanwhile.
            let (cx, cy) = self.cell_of(x, y);
            if !self.heli_can_land(i, cx, cy) {
                match self.heli_landing_spot(i, cx, cy) {
                    Some((nx, ny)) => {
                        let h = &mut self.actors[i].heli;
                        h.land_x = cell_center(nx);
                        h.land_y = cell_center(ny);
                    }
                    None => self.actors[i].heli.task = HeliTask::None,
                }
                return;
            }
        }
        if self.heli_approach_and_land(i, x, y) {
            let a = &mut self.actors[i];
            a.heli.task = HeliTask::None;
            a.activity = Activity::Idle;
        }
    }

    fn tick_heli_resupply(&mut self, i: usize) {
        let h = self.actors[i].heli;
        if h.ammo_used == 0 && !h.always_land && !h.landed {
            // Nothing to reload (OpenRA ShouldLandAtBuilding is false): fly
            // to the base and wait there instead of landing.
            self.release_pad(i);
            let near = self.choose_rearm_pad(i).map(|(b, _)| b).filter(|&b| {
                let (x, y) = self.pad_point(b);
                dist(self.actors[i].x, self.actors[i].y, x, y) > self.heli_air(i).wait_distance
            });
            match near {
                Some(b) => self.heli_wait_near(i, b),
                None => {
                    let a = &mut self.actors[i];
                    a.heli.task = HeliTask::None;
                    a.activity = Activity::Idle;
                }
            }
            return;
        }
        let me = self.make_ref(i);
        let owner = self.actors[i].owner;
        let held = self.resolve(self.actors[i].heli.pad).filter(|&b| self.actors[b].owner == owner && self.actors[b].dock_user == me);
        let pad = match held {
            Some(b) => b,
            None => {
                self.actors[i].heli.pad = NONE;
                match self.choose_rearm_pad(i) {
                    None => {
                        // Nowhere to reload: hover here.
                        let a = &mut self.actors[i];
                        a.heli.task = HeliTask::None;
                        a.activity = Activity::Idle;
                        return;
                    }
                    Some((b, true)) => {
                        self.reserve_pad(i, b);
                        b
                    }
                    Some((b, false)) => {
                        self.heli_wait_near(i, b);
                        return;
                    }
                }
            }
        };
        let (x, y) = self.pad_point(pad);
        if !self.heli_approach_and_land(i, x, y) {
            return;
        }
        let (max, delay, count, take_off) = {
            let air = self.heli_air(i);
            (air.ammo, air.reload_delay.max(1), air.reload_count.max(1), air.take_off_on_resupply)
        };
        if self.actors[i].heli.ammo_used > 0 && max > 0 {
            // The helipad's rearm animation (fx.rs, presentation only).
            self.note_service(pad);
        }
        let h = &mut self.actors[i].heli;
        if h.ammo_used > 0 && max > 0 {
            // AmmoPool reload: ReloadCount rounds every ReloadDelay ticks.
            if h.rearm_timer <= 0 {
                h.rearm_timer = delay;
            }
            h.rearm_timer -= 1;
            if h.rearm_timer == 0 {
                h.ammo_used = (h.ammo_used - count).max(0);
                h.rearm_timer = delay;
            }
            if h.ammo_used > 0 {
                return;
            }
        }
        h.rearm_timer = 0;
        h.task = HeliTask::None;
        let stay = h.always_land;
        h.always_land = false;
        self.actors[i].activity = Activity::Idle;
        let resumes = self.actors[i].heli.resume != NONE || self.actors[i].heli.resume_ground;
        if (take_off || resumes) && !stay {
            self.release_pad(i);
            self.actors[i].heli.landed = false;
        }
        self.heli_resume(i);
    }

    /// Hold position near a busy helipad (WaitDistanceFromResupplyBase); the
    /// resupply task looks for a free pad again every tick.
    fn heli_wait_near(&mut self, i: usize, b: usize) {
        let (px_, py_) = self.pad_point(b);
        let wait = self.heli_air(i).wait_distance;
        let (x, y) = (self.actors[i].x, self.actors[i].y);
        let d = dist(x, y, px_, py_);
        if !self.heli_climb(i) {
            return;
        }
        if d > wait {
            let (wx, wy) = (px_ + (x - px_) * wait / d.max(1), py_ + (y - py_) * wait / d.max(1));
            self.heli_fly(i, wx, wy);
        }
    }

    /// Nearest own rearm structure for this helicopter, preferring free ones.
    /// Returns the pad and whether it is free.
    fn choose_rearm_pad(&self, i: usize) -> Option<(usize, bool)> {
        let me = self.make_ref(i);
        let (x, y, owner) = (self.actors[i].x, self.actors[i].y, self.actors[i].owner);
        let mut best: Option<(bool, i64, usize)> = None;
        for (b, a) in self.actors.iter().enumerate() {
            if !a.alive || a.owner != owner || a.kind != Kind::Building || !self.is_rearm_pad_for(i, b) {
                continue;
            }
            let free = self.pad_free_for(b, me);
            let (px_, py_) = self.pad_point(b);
            let d = dist_sq(x, y, px_, py_);
            let better = match best {
                None => true,
                Some((bf, bd, _)) => (free && !bf) || (free == bf && d < bd),
            };
            if better {
                best = Some((free, d, b));
            }
        }
        best.map(|(free, _, b)| (b, free))
    }

    // ---- Landing spots -------------------------------------------------------------

    /// Terrain type name of a cell, as in LandableTerrainTypes.
    fn terrain_name(&self, ci: usize) -> &'static str {
        use crate::map::Terrain;
        match self.map.terrain[ci] {
            Terrain::Clear | Terrain::Road if self.map.gems[ci] > 0 => "Gems",
            Terrain::Clear | Terrain::Road if self.map.ore[ci] > 0 => "Ore",
            t => t.name(),
        }
    }

    /// Whether helicopter `i` may touch down on a cell: landable terrain, no
    /// structure, nobody on the ground there and no other helicopter landing there.
    pub(crate) fn heli_can_land(&self, i: usize, cx: i32, cy: i32) -> bool {
        if !self.map.contains(cx, cy) {
            return false;
        }
        let ci = self.map.idx(cx, cy);
        let name = self.terrain_name(ci);
        if !self.heli_air(i).landable.iter().any(|t| t == name) || self.building_at[ci] != NONE {
            return false;
        }
        for &u in self.units_in_cell(ci) {
            let u = u as usize;
            let o = &self.actors[u];
            if u != i && o.alive && (o.kind != Kind::Aircraft || o.altitude == 0) {
                return false;
            }
        }
        // Other helicopters on their way down to this cell.
        !self.actors.iter().enumerate().any(|(j, o)| {
            j != i
                && o.alive
                && o.kind == Kind::Aircraft
                && o.heli.task == HeliTask::Land
                && self.cell_index(o.heli.land_x, o.heli.land_y) == ci
        })
    }

    /// Closest cell around (cx, cy) where the helicopter can land, scanning
    /// rings outward in a fixed order.
    pub(crate) fn heli_landing_spot(&self, i: usize, cx: i32, cy: i32) -> Option<(i32, i32)> {
        for r in 0..=LAND_SEARCH {
            let mut best: Option<(i32, i32, i32)> = None;
            for y in cy - r..=cy + r {
                for x in cx - r..=cx + r {
                    if (x - cx).abs().max((y - cy).abs()) != r || !self.heli_can_land(i, x, y) {
                        continue;
                    }
                    let d = (x - cx).pow(2) + (y - cy).pow(2);
                    if best.is_none_or(|(bd, _, _)| d < bd) {
                        best = Some((d, x, y));
                    }
                }
            }
            if let Some((_, x, y)) = best {
                return Some((x, y));
            }
        }
        None
    }

    // ---- Orders --------------------------------------------------------------------

    /// Send a helicopter to land on an own helipad and reload there.
    fn heli_send_to_pad(&mut self, i: usize, b: usize) {
        self.release_dock(i);
        let me = self.make_ref(i);
        let a = &mut self.actors[i];
        a.activity = Activity::Idle;
        a.target = NONE;
        a.attack_move = false;
        a.heli.task = HeliTask::Resupply;
        a.heli.always_land = true;
        if self.pad_free_for(b, me) {
            self.reserve_pad(i, b);
        }
    }

    fn heli_send_to_depot(&mut self, i: usize, d: usize) {
        self.release_dock(i);
        let r = self.make_ref(d);
        let a = &mut self.actors[i];
        a.activity = Activity::Repair;
        a.depot = r;
        a.repair_timer = 0;
        a.group_size = 1;
        a.target = NONE;
        a.attack_move = false;
    }

    /// Land order: touch down on (or next to) the cell at (x, y). On an own
    /// helipad or service depot the helicopter lands there to reload or repair.
    pub fn order_land(&mut self, units: &[usize], x: i32, y: i32) {
        let (cx, cy) = self.cell_of(x, y);
        let b = self.building_at[self.map.idx(cx, cy)];
        for &i in units {
            if !self.is_heli(i) {
                continue;
            }
            if b != NONE {
                let b = b as usize;
                if self.actors[b].alive && self.actors[b].owner == self.actors[i].owner {
                    if self.is_rearm_pad_for(i, b) {
                        self.heli_send_to_pad(i, b);
                        continue;
                    }
                    if self.is_repair_depot_for(i, b) && self.needs_service(i, b) {
                        self.heli_send_to_depot(i, b);
                        continue;
                    }
                }
            }
            self.release_dock(i);
            match self.heli_landing_spot(i, cx, cy) {
                Some((lx, ly)) => {
                    let a = &mut self.actors[i];
                    a.activity = Activity::Idle;
                    a.target = NONE;
                    a.attack_move = false;
                    a.heli.task = HeliTask::Land;
                    a.heli.land_x = cell_center(lx);
                    a.heli.land_y = cell_center(ly);
                }
                // Nowhere to land: hover there instead.
                None => self.order_move(&[i], x, y, false),
            }
        }
    }

    /// Return to base: fly to a free helipad, land and reload.
    pub fn order_return_to_base(&mut self, units: &[usize]) {
        for &i in units {
            if !self.is_heli(i) || self.heli_air(i).rearm_actors.is_empty() {
                continue;
            }
            self.release_dock(i);
            let a = &mut self.actors[i];
            a.activity = Activity::Idle;
            a.target = NONE;
            a.attack_move = false;
            a.heli.task = HeliTask::Resupply;
        }
    }

    /// Deploy key: land right here, or take off again when landed.
    pub(crate) fn heli_deploy(&mut self, i: usize) {
        if self.actors[i].heli.landed {
            self.release_dock(i);
            let a = &mut self.actors[i];
            a.activity = Activity::Idle;
            a.target = NONE;
            a.heli.landed = false;
            return;
        }
        let (x, y) = (self.actors[i].x, self.actors[i].y);
        self.order_land(&[i], x, y);
    }

    /// For the Deploy button: 1 can land or take off now, 2 nowhere to land here.
    pub fn heli_deploy_state(&self, i: usize) -> u8 {
        if self.actors[i].heli.landed {
            return 1;
        }
        let (cx, cy) = self.cell_of(self.actors[i].x, self.actors[i].y);
        let b = self.building_at[self.map.idx(cx, cy)];
        let on_service = b != NONE
            && self.actors[b as usize].owner == self.actors[i].owner
            && (self.is_rearm_pad_for(i, b as usize) || self.is_repair_depot_for(i, b as usize));
        if on_service || self.heli_landing_spot(i, cx, cy).is_some() {
            1
        } else {
            2
        }
    }

    /// Smart order cursor: helicopters over an own helipad dock, over an own
    /// service depot repair. `None` leaves the decision to the shared code.
    pub(crate) fn heli_smart_action(&self, player: u8, units: &[usize], x: i32, y: i32) -> Option<SmartAction> {
        if !units.iter().any(|&i| self.is_heli(i)) {
            return None;
        }
        let b = self.actor_at(player, x, y)?;
        if self.actors[b].owner != player || self.actors[b].kind != Kind::Building {
            return None;
        }
        if units.iter().any(|&i| self.is_heli(i) && self.is_rearm_pad_for(i, b)) {
            return Some(SmartAction::Dock);
        }
        if units.iter().any(|&i| self.is_heli(i) && self.is_repair_depot_for(i, b)) {
            // Undamaged: the blocked cursor, and the click does nothing
            // (OpenRA Aircraft Enter order: AircraftCanResupplyAt).
            if units.iter().any(|&i| self.is_heli(i) && self.is_repair_depot_for(i, b) && self.needs_service(i, b)) {
                return Some(SmartAction::Repair);
            }
            return Some(SmartAction::EnterBlocked);
        }
        None
    }

    /// Smart order: helicopters clicked onto an own helipad or service depot
    /// go there; returns the units left for the shared smart order.
    pub(crate) fn heli_order_smart(&mut self, player: u8, units: &[usize], x: i32, y: i32) -> Vec<usize> {
        let target = self
            .actor_at(player, x, y)
            .filter(|&b| self.actors[b].owner == player && self.actors[b].kind == Kind::Building && units.iter().any(|&i| self.is_heli(i)));
        let Some(b) = target else { return units.to_vec() };
        let mut rest = Vec::new();
        for &i in units {
            if self.is_heli(i) && self.is_rearm_pad_for(i, b) {
                self.heli_send_to_pad(i, b);
            } else if self.is_heli(i) && self.is_repair_depot_for(i, b) {
                // Nothing to repair: the order does nothing (OpenRA).
                if self.needs_service(i, b) {
                    self.heli_send_to_depot(i, b);
                }
            } else {
                rest.push(i);
            }
        }
        rest
    }

    /// A helicopter just built: it starts landed on its helipad, holding it.
    pub(crate) fn heli_produced(&mut self, u: usize, b: usize) {
        if !self.is_heli(u) {
            return;
        }
        let (x, y) = self.pad_point(b);
        let a = &mut self.actors[u];
        a.x = x;
        a.y = y;
        a.px = x;
        a.py = y;
        a.altitude = 0;
        a.heli.landed = true;
        let me = self.make_ref(u);
        if self.is_rearm_pad_for(u, b) && self.pad_free_for(b, me) {
            self.reserve_pad(u, b);
        }
    }

    // ---- Crashing ------------------------------------------------------------------

    /// Killed in the air: the husk falls instead of exploding on the spot.
    pub(crate) fn begin_heli_crash(&mut self, i: usize) -> bool {
        let a = &self.actors[i];
        if a.kind != Kind::Aircraft || a.altitude <= 0 || !self.is_helicopter(i) {
            return false;
        }
        self.crashes.push(Crash {
            ty: a.ty,
            owner: a.owner,
            x: a.x,
            y: a.y,
            altitude: a.altitude,
            palt: a.altitude,
            facing: a.facing,
            pfacing: a.facing,
            spin: 0,
        });
        true
    }

    /// Falling husks: spin, drop and explode on the ground with the death weapon.
    pub(crate) fn tick_crashes(&mut self) {
        let mut k = 0;
        while k < self.crashes.len() {
            let c = &mut self.crashes[k];
            c.palt = c.altitude;
            c.pfacing = c.facing;
            c.spin = (c.spin + FALL_SPIN_STEP).min(FALL_SPIN_MAX);
            c.facing = wrap_angle(c.facing + c.spin);
            c.altitude -= FALL_VELOCITY;
            if c.altitude > 0 {
                k += 1;
                continue;
            }
            let c = self.crashes.remove(k);
            // The death weapon's explosions where it hits the ground (fx.rs), else a generic one.
            let shown = self.rules.actors[c.ty as usize].death_weapon.is_some_and(|w| {
                let class = self.impact_class(c.x, c.y);
                self.spawn_weapon_effects(w, c.x, c.y, class)
            });
            if !shown {
                self.effects.push(Effect { x: c.x, y: c.y, tx: c.x, ty: c.y, kind: EffectKind::LargeExplosion, ttl: 22, max: 22 });
            }
            if let Some(w) = self.rules.actors[c.ty as usize].death_weapon {
                for h in 0..self.warhead_count(w) {
                    let delay = self.warhead_delay(w, h).max(1);
                    self.pending.push(PendingImpact {
                        tick: self.tick + delay as u32,
                        weapon: w as u16,
                        warhead: h as u8,
                        x: c.x,
                        y: c.y,
                        altitude: 0,
                        owner: c.owner,
                        shot: crate::veterancy::Shot::NONE,
                    });
                }
            }
        }
    }

    // ---- Rendering -------------------------------------------------------------------

    /// Rotors of a helicopter drawn at (x, y): crisp blades on the ground, a
    /// blurred disc with faint blades in the air. Rotor wash on the ground
    /// while taking off or landing. With the original graphics (the rotor
    /// slot is original: RenderOptions::is_original) the rotors are OpenRA's
    /// WithIdleOverlay@ROTOR*: the slow-rotor sequence on the ground and the
    /// rotor sequence in the air, each rotor at its offset (the second one,
    /// the Chinook's rear rotor, with the aux poses), and nothing of WebRA's
    /// drawing (no disc, no wash).
    pub(crate) fn push_heli_rotors(
        &self,
        i: usize,
        at: crate::instances::SpriteRec,
        lift: f32,
        sink: &mut crate::instances::Sink,
        ground: &mut Vec<f32>,
        out: &mut Vec<f32>,
    ) {
        use crate::render::{classic_offset, posed, Pose};
        if !self.is_heli(i) {
            return;
        }
        let a = &self.actors[i];
        let ids = crate::render::SpriteIds::new(self.rules.actors.len());
        let air = self.heli_air(i);
        let team = a.owner as f32;
        let slot = a.ty as u32 * 2 + 1;
        let turn = angle_diff(a.pfacing, a.facing);
        let flying = a.altitude > 0;
        if self.render_opts.is_original(slot) {
            let body = at.facing(a.pfacing, turn);
            for (k, &off) in air.rotors.iter().enumerate() {
                let pose = match (k, flying) {
                    (0, false) => Pose::Idle,
                    (0, true) => Pose::Move,
                    (_, false) => Pose::AuxIdle,
                    (_, true) => Pose::AuxMove,
                };
                // OpenRA's placement on the pre-rendered body (classic perspective).
                let (o0, o1) = (classic_offset(off, 0, a.pfacing), classic_offset(off, 0, a.facing));
                let r = body.look(posed(slot, pose, 0), team, 1.0, 1.0, 0.0);
                sink.sprite(out, r.offset_moving([o0[0], o0[1] - lift], [o1[0], o1[1] - lift]));
            }
            return;
        }
        // The rotor spins with the turret angle; arms point along the body facing.
        let rotor = at.facing(a.pturret, angle_diff(a.pturret, a.turret));
        let radius = self.rules.actors[a.ty as usize].unit.as_ref().unwrap().radius;
        let disc_scale = radius as f32 / ROTOR_DISC_RADIUS as f32;
        for &off in &air.rotors {
            let arm = |r: crate::instances::SpriteRec| r.offset(0.0, -lift).arm(px(off), 0.0, a.pfacing, turn);
            if flying {
                sink.sprite(out, arm(rotor.look(ids.helis_base + SPECIAL_ROTOR_DISC, team, disc_scale, 0.55, 0.0)));
                sink.sprite(out, arm(rotor.look(slot as f32, team, 1.0, 0.3, 0.0)));
            } else {
                sink.sprite(out, arm(rotor.look(slot as f32, team, 1.0, 1.0, 0.0)));
            }
        }
        let cruise = air.cruise_altitude.max(1);
        if flying && a.altitude < cruise {
            let k = 1.0 - a.altitude as f32 / cruise as f32;
            // On the ground under the helicopter, turning at a quarter of the rotor's speed.
            let wash = rotor.look(ids.helis_base + SPECIAL_ROTOR_WASH, 0.0, 0.8 + k * 0.6, 0.25 + k * 0.45, 0.0);
            sink.sprite(ground, wash.offset(0.0, -lift + px(a.altitude)).angle_affine(0.25, 0.0));
        }
    }

    /// Falling husks visible to `player`: shadow on the ground, husk and smoke above.
    pub(crate) fn push_heli_crashes(&self, player: u8, sink: &mut crate::instances::Sink, ground: &mut Vec<f32>, out: &mut Vec<f32>) {
        use crate::instances::SpriteRec;
        let ids = crate::render::SpriteIds::new(self.rules.actors.len());
        for c in &self.crashes {
            if !self.render_sees_cell(player, self.cell_index(c.x, c.y)) {
                continue;
            }
            let (x, y) = (px(c.x), px(c.y));
            if !sink.visible([x, y], [x, y], 64.0) {
                continue;
            }
            // The husk sinks from its previous to its current altitude during the tick.
            let (l0, l1) = (px(c.palt), px(c.altitude));
            let at = SpriteRec::at(x, y, 64.0).facing(c.pfacing, angle_diff(c.pfacing, c.facing));
            let sprite = (c.ty * 2) as f32;
            sink.sprite(ground, at.look(sprite, c.owner as f32, 0.9, 0.25, -1.0).offset_moving([l0 * 0.4, 0.0], [l1 * 0.4, 0.0]));
            sink.sprite(out, at.look(sprite, c.owner as f32, 1.0, 1.0, 0.0).offset_moving([0.0, -l0], [0.0, -l1]));
            let smoke = at.look(ids.helis_base + SPECIAL_SMOKE, 0.0, 1.0, 0.8, 0.0);
            sink.sprite(out, smoke.offset_moving([0.0, -l0 - 4.0], [0.0, -l1 - 4.0]));
        }
    }

    /// Ammo pips (WithAmmoPipsDecoration) below a selected helicopter's box.
    pub(crate) fn push_heli_ammo_pips(&self, i: usize, l: f32, bottom: f32, w: f32, rects: &mut Vec<f32>) {
        if !self.is_heli(i) {
            return;
        }
        let (ammo, max) = self.heli_ammo(i);
        let pips = self.heli_air(i).ammo_pips;
        if max <= 0 || pips <= 0 {
            return;
        }
        // A pip is lit while its share of the pool is (partly) loaded.
        let lit = ((ammo as i64 * pips as i64 + max as i64 - 1) / max as i64) as i32;
        let size = 3.0f32;
        let gap = 1.0f32;
        let total = pips as f32 * (size + gap) - gap;
        let x0 = l + ((w - total) / 2.0).max(0.0);
        for k in 0..pips {
            let x = x0 + k as f32 * (size + gap);
            rects.extend_from_slice(&[x, bottom + 2.0, size, size, 0.0, 0.0, 0.0, 0.75]);
            if k < lit {
                rects.extend_from_slice(&[x + 0.5, bottom + 2.5, size - 1.0, size - 1.0, 0.95, 0.85, 0.3, 1.0]);
            }
        }
    }
}

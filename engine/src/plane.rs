//! Fixed-wing aircraft (Yak, MiG, spy plane, bombers): flight, attack runs,
//! ammo and rearming at airfields, crashes, air support powers and
//! paratroopers.
//!
//! Behaviour follows OpenRA's `Aircraft` for planes (`CanHover: false`):
//!
//! - Built at an Airfield and parked on it (one plane per airfield, OpenRA
//!   `Reservable`), at altitude 0. A parked plane takes off when ordered.
//! - Airborne planes always move at full speed and turn at `TurnSpeed`; with
//!   nothing to do they circle (OpenRA `FlyIdle`). A move order flies to the
//!   point and circles there.
//! - Attack runs (OpenRA `FlyAttack`): fly toward the target, fire while it is
//!   within range and within `FacingTolerance` of the nose, overshoot it and
//!   turn back for the next pass. Every shot uses one round of the AmmoPool.
//! - Out of ammo the plane returns to a free airfield (Rearmable
//!   `RearmActors`), lands, rearms `ReloadCount` rounds every `ReloadDelay`
//!   ticks, and resumes its attack once full if the target still lives.
//! - Airborne planes are only hit by anti-air weapons; landed ones count as
//!   ground vehicles (OpenRA `Targetable@GROUND` / `Targetable@AIRBORNE`).
//! - Shot down in the air they fall (`FallsToEarth` of `^PlaneHusk`) and
//!   explode where they hit the ground.
//! - Planes never bump into each other or into ground units.
//!
//! Support power aircraft (spy plane, paratrooper Badger, parabomb Badger) are
//! launched by [`World::launch_air_power`] (powers.rs dispatches to it). They
//! fly straight across the target, do their job and leave the map.
//!
//! Generic aircraft helpers for helicopter.rs: [`AirState`] (ammo, airfield or
//! helipad reservation), [`World::ammo_left`], [`World::max_ammo`],
//! [`World::rearm_step`], [`World::find_rearm_base`], [`World::target_kind`].

use crate::math::{angle_diff, dist, dist_sq, facing_of, facing_vec, turn_toward, CELL};
use crate::rules::{Kind, SupportPowerInfo};
use crate::world::{Activity, SmartAction, World, MAX_WEAPONS, NONE};

/// OpenRA `AttackAircraft.FacingTolerance` of the Yak and MiG.
const FACING_TOLERANCE: i32 = 80;
/// OpenRA `Aircraft.MaximumPitch` of every plane: climb and descent angle.
const MAX_PITCH: i32 = 56;
/// After passing over the target, fly on this far beyond the minimum range before turning back.
const OVERSHOOT: i32 = 2 * CELL;
/// Ticks between searches for a free airfield while none is available.
const BASE_RETRY: i32 = 25;
/// `Parachutable.FallRate` of `^Soldier` (defaults.yaml): world units per tick.
const PARACHUTE_FALL_RATE: i32 = 26;
/// Distance beyond the map edge where support aircraft appear and vanish.
const SUPPORT_CORDON: i32 = 2 * CELL;
/// WebRA addition (design request): the spy plane also uncovers a strip along its flight path.
const SPY_PATH_RANGE: i32 = 3 * CELL;

/// Flight phase of a plane.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Phase {
    #[default]
    Flying,
    /// On an airfield (altitude 0), rearming.
    Parked,
    /// Flying back to `AirState::base` to land.
    Returning,
    /// Shot down: falling to the ground.
    Crashing,
}

/// Job of a support power aircraft.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Mission {
    #[default]
    None,
    SpyPlane,
    Paradrop,
    Bombing,
}

/// Per-actor aircraft state (planes; the ammo and base fields suit helicopters too).
#[derive(Clone, Debug)]
pub struct AirState {
    pub phase: Phase,
    /// Rounds fired since the last full rearm (ammo left = max - spent), so a
    /// fresh actor starts full without extra spawn code.
    pub spent: i32,
    pub rearm_timer: i32,
    /// Reserved airfield (or helipad), as an actor reference, or NONE.
    pub base: u32,
    /// Flying on past the target after an attack pass.
    pub overshoot: bool,
    /// Explicit "return to base" order; cleared by any new order.
    pub rtb: bool,
    /// Support power aircraft: job, target point and camera.
    pub mission: Mission,
    pub tx: i32,
    pub ty: i32,
    pub camera_range: i32,
    pub camera_delay: i32,
    /// The camera at the target was placed.
    pub camera_done: bool,
    /// Was inside the map at least once (leaving it again ends the flight).
    pub entered: bool,
    /// Paratroopers still aboard (actor types).
    pub cargo: Vec<u16>,
    /// Infantry hanging on a parachute (altitude > 0).
    pub parachute: bool,
}

impl Default for AirState {
    fn default() -> Self {
        AirState {
            phase: Phase::Flying,
            spent: 0,
            rearm_timer: 0,
            base: NONE,
            overshoot: false,
            rtb: false,
            mission: Mission::None,
            tx: 0,
            ty: 0,
            camera_range: 0,
            camera_delay: 0,
            camera_done: false,
            entered: false,
            cargo: Vec::new(),
            parachute: false,
        }
    }
}

impl AirState {
    /// A new player order (move, attack, stop) cancels a return to base.
    pub fn new_order(&mut self) {
        self.rtb = false;
        self.overshoot = false;
        if self.phase == Phase::Returning {
            self.phase = Phase::Flying;
        }
    }
}

/// Flight numbers of one aircraft type, copied out of the rules.
#[derive(Clone, Copy)]
struct Flight {
    speed: i32,
    turn: i32,
    cruise: i32,
    climb: i32,
    max_ammo: i32,
    reload_delay: i32,
    reload_count: i32,
    crash_velocity: i32,
    crash_weapon: Option<usize>,
    drop_range: i32,
}

impl World {
    // ---- Classification and shared helpers ------------------------------------------

    /// Fixed-wing aircraft (OpenRA `Aircraft` without `CanHover`).
    pub fn is_plane(&self, i: usize) -> bool {
        let a = &self.actors[i];
        a.kind == Kind::Aircraft
            && self.rules.actors[a.ty as usize].unit.as_ref().and_then(|u| u.aircraft.as_ref()).is_some_and(|ac| !ac.can_hover)
    }

    /// Support power aircraft: not selectable, rejects orders.
    pub fn is_support_aircraft(&self, i: usize) -> bool {
        self.actors[i].air.mission != Mission::None
    }

    fn flight(&self, i: usize) -> Flight {
        let u = self.rules.actors[self.actors[i].ty as usize].unit.as_ref().expect("aircraft unit");
        let ac = u.aircraft.as_ref().expect("aircraft info");
        // Veterans fly faster (SpeedMultiplier, veterancy.rs).
        let speed = self.modified_speed(i, u.speed).max(1);
        Flight {
            speed,
            turn: u.turn_speed.max(1),
            cruise: ac.cruise_altitude,
            climb: (speed * facing_vec(MAX_PITCH).0 / 1024).max(1),
            max_ammo: ac.ammo,
            reload_delay: ac.reload_delay.max(1),
            reload_count: ac.reload_count.max(1),
            crash_velocity: ac.crash_velocity,
            crash_weapon: ac.crash_weapon,
            drop_range: ac.drop_range,
        }
    }

    /// AmmoPool size of an aircraft (0: unlimited / no pool).
    pub fn max_ammo(&self, i: usize) -> i32 {
        self.rules.actors[self.actors[i].ty as usize].unit.as_ref().and_then(|u| u.aircraft.as_ref()).map_or(0, |ac| ac.ammo)
    }

    /// Rounds left. Aircraft without an AmmoPool never run dry.
    pub fn ammo_left(&self, i: usize) -> i32 {
        let max = self.max_ammo(i);
        if max == 0 {
            i32::MAX
        } else {
            (max - self.actors[i].air.spent).max(0)
        }
    }

    /// The class an actor is targeted as: landed aircraft are ground vehicles,
    /// paratroopers on their parachute are airborne (only anti-air reaches them).
    pub fn target_kind(&self, i: usize) -> Kind {
        let a = &self.actors[i];
        match a.kind {
            Kind::Aircraft if a.altitude == 0 => Kind::Vehicle,
            Kind::Infantry if a.air.parachute => Kind::Aircraft,
            k => k,
        }
    }

    /// Aircraft no weapon may target: falling wrecks and the spy plane
    /// (OpenRA removes its `Targetable@AIRBORNE`).
    pub(crate) fn untargetable_aircraft(&self, i: usize) -> bool {
        let a = &self.actors[i];
        a.air.phase == Phase::Crashing || a.air.mission == Mission::SpyPlane
    }

    /// One rearm tick on a base: adds `ReloadCount` rounds every `ReloadDelay` ticks.
    /// Returns true when the pool is full.
    pub fn rearm_step(&mut self, i: usize) -> bool {
        let f = self.flight(i);
        let a = &mut self.actors[i].air;
        if a.spent <= 0 {
            a.spent = 0;
            a.rearm_timer = 0;
            return true;
        }
        a.rearm_timer += 1;
        if a.rearm_timer >= f.reload_delay {
            a.rearm_timer = 0;
            a.spent = (a.spent - f.reload_count).max(0);
        }
        a.spent == 0
    }

    /// Whether building `b` can rearm aircraft `i` (own structure listed in `RearmActors`).
    fn is_rearm_base_for(&self, i: usize, b: usize) -> bool {
        let (a, ba) = (&self.actors[i], &self.actors[b]);
        if !ba.alive || ba.kind != Kind::Building || ba.owner != a.owner {
            return false;
        }
        let id = &self.rules.actors[ba.ty as usize].id;
        self.rules.actors[a.ty as usize]
            .unit
            .as_ref()
            .and_then(|u| u.aircraft.as_ref())
            .is_some_and(|ac| ac.rearm_actors.iter().any(|r| r.eq_ignore_ascii_case(id)))
    }

    /// Whether another living aircraft holds a reservation on building `b`.
    fn base_reserved_by_other(&self, i: usize, b: usize) -> bool {
        let r = self.make_ref(b);
        self.actors.iter().enumerate().any(|(j, o)| j != i && o.alive && o.kind == Kind::Aircraft && o.air.base == r)
    }

    /// The aircraft's reserved base if still valid, else the nearest free
    /// rearm base, which gets reserved. None when every base is taken.
    pub fn find_rearm_base(&mut self, i: usize) -> Option<usize> {
        if let Some(b) = self.resolve(self.actors[i].air.base) {
            if self.is_rearm_base_for(i, b) {
                return Some(b);
            }
        }
        self.actors[i].air.base = NONE;
        let (x, y) = (self.actors[i].x, self.actors[i].y);
        let mut best: Option<(i64, usize)> = None;
        for b in 0..self.actors.len() {
            if !self.is_rearm_base_for(i, b) || self.base_reserved_by_other(i, b) {
                continue;
            }
            let d = dist_sq(x, y, self.actors[b].x, self.actors[b].y);
            if best.is_none_or(|(bd, _)| d < bd) {
                best = Some((d, b));
            }
        }
        let b = best.map(|(_, b)| b)?;
        self.actors[i].air.base = self.make_ref(b);
        Some(b)
    }

    // ---- Movement ------------------------------------------------------------------

    /// Fly one tick forward along the facing and move the altitude toward `alt`.
    fn fly_forward(&mut self, i: usize, f: &Flight, alt: i32, clamp: bool) {
        let max_x = self.map.width * CELL - 1;
        let max_y = self.map.height * CELL - 1;
        let a = &mut self.actors[i];
        let (vx, vy) = facing_vec(a.facing);
        a.x += vx * f.speed / 1024;
        a.y += vy * f.speed / 1024;
        if clamp {
            a.x = a.x.clamp(0, max_x);
            a.y = a.y.clamp(0, max_y);
        }
        a.altitude += (alt - a.altitude).clamp(-f.climb, f.climb);
        a.moved = true;
    }

    /// Fly one tick toward (tx, ty). A point inside the turning circle cannot
    /// be reached by turning: the plane then flies straight on (OpenRA's
    /// planes overshoot the same way) until the point is far enough behind to
    /// come around, then turns toward it again.
    fn fly_toward(&mut self, i: usize, f: &Flight, tx: i32, ty: i32, alt: i32) {
        // Turning radius: speed * 1024 / (2 pi * turn), 1024 / (2 pi) ~ 163.
        let r = f.speed * 163 / f.turn;
        let a = &self.actors[i];
        let d = dist(a.x, a.y, tx, ty);
        if a.air.overshoot {
            if d < 2 * r + CELL {
                self.fly_forward(i, f, alt, true);
                return;
            }
            self.actors[i].air.overshoot = false;
        }
        let a = &self.actors[i];
        if let Some(desired) = facing_of(tx - a.x, ty - a.y) {
            let diff = angle_diff(a.facing, desired);
            if diff != 0 {
                let (px, py) = facing_vec(a.facing + 256 * diff.signum());
                let (cx, cy) = (a.x + px * r / 1024, a.y + py * r / 1024);
                if dist(cx, cy, tx, ty) < r && d > f.speed {
                    self.actors[i].air.overshoot = true;
                } else {
                    self.actors[i].facing = turn_toward(a.facing, desired, f.turn);
                }
            }
        }
        self.fly_forward(i, f, alt, true);
    }

    /// OpenRA `FlyIdle`: keep turning at full rate (a tight circle).
    fn fly_circle(&mut self, i: usize, f: &Flight) {
        let a = &mut self.actors[i];
        a.facing = (a.facing + f.turn).rem_euclid(1024);
        self.fly_forward(i, f, f.cruise, true);
    }

    // ---- Tick ------------------------------------------------------------------------

    /// One tick of a plane.
    pub(crate) fn tick_plane(&mut self, i: usize) {
        if self.actors[i].air.phase == Phase::Crashing {
            self.tick_crash(i);
            return;
        }
        if self.actors[i].air.mission != Mission::None {
            self.tick_support_aircraft(i);
            return;
        }
        match self.actors[i].air.phase {
            Phase::Parked => self.tick_parked(i),
            Phase::Returning => self.tick_returning(i),
            _ => self.tick_flying(i),
        }
    }

    /// Valid attack target of a plane, or None (also clears a dead target).
    fn plane_target(&self, i: usize) -> Option<usize> {
        let t = self.live_target(i)?;
        if self.untargetable_aircraft(t) {
            return None;
        }
        let tk = self.target_kind(t);
        let info = &self.rules.actors[self.actors[i].ty as usize];
        info.weapons.iter().any(|&w| self.rules.weapons[w].can_target(tk)).then_some(t)
    }

    fn tick_parked(&mut self, i: usize) {
        let f = self.flight(i);
        let on_base = self.resolve(self.actors[i].air.base).filter(|&b| self.is_rearm_base_for(i, b));
        let full = match on_base {
            Some(_) => self.rearm_step(i),
            None => {
                self.actors[i].air.base = NONE;
                self.ammo_left(i) >= f.max_ammo
            }
        };
        match self.actors[i].activity {
            Activity::Move => self.take_off(i),
            Activity::Attack => match self.plane_target(i) {
                // OpenRA ReturnToBase then resume: take off again once fully rearmed.
                Some(_) if full => self.take_off(i),
                Some(_) => {}
                None => {
                    let a = &mut self.actors[i];
                    a.activity = Activity::Idle;
                    a.target = NONE;
                }
            },
            _ => {}
        }
    }

    fn take_off(&mut self, i: usize) {
        let a = &mut self.actors[i];
        a.air.phase = Phase::Flying;
        a.air.base = NONE; // OpenRA releases the reservation on take-off
        a.air.rearm_timer = 0;
        let f = self.flight(i);
        self.fly_forward(i, &f, f.cruise, true);
    }

    fn tick_flying(&mut self, i: usize) {
        let f = self.flight(i);
        match self.actors[i].activity {
            Activity::Attack => match self.plane_target(i) {
                Some(_) if self.ammo_left(i) == 0 => {
                    // Out of ammo: rearm, then come back for the target.
                    self.actors[i].air.phase = Phase::Returning;
                    self.tick_returning(i);
                }
                Some(t) => self.attack_run(i, t, &f),
                None => {
                    let a = &mut self.actors[i];
                    a.activity = Activity::Idle;
                    a.target = NONE;
                    a.air.overshoot = false;
                    self.fly_circle(i, &f);
                }
            },
            Activity::Move if self.actors[i].goal != NONE => {
                let g = self.actors[i].goal as i32;
                let (gx, gy) = (g % self.map.width * CELL + CELL / 2, g / self.map.width * CELL + CELL / 2);
                let a = &self.actors[i];
                if dist(a.x, a.y, gx, gy) <= CELL.max(f.speed) {
                    let a = &mut self.actors[i];
                    a.activity = Activity::Idle;
                    a.attack_move = false;
                    self.fly_circle(i, &f);
                } else {
                    self.fly_toward(i, &f, gx, gy, f.cruise);
                }
            }
            _ => {
                if self.actors[i].activity != Activity::Idle {
                    self.actors[i].activity = Activity::Idle;
                }
                self.fly_circle(i, &f);
            }
        }
    }

    /// Fly back to a free base and land. With none free, circle and look again later.
    fn tick_returning(&mut self, i: usize) {
        let f = self.flight(i);
        let base = if self.actors[i].air.rearm_timer > 0 {
            self.actors[i].air.rearm_timer -= 1;
            None
        } else {
            self.find_rearm_base(i)
        };
        let Some(b) = base else {
            if self.actors[i].air.rearm_timer == 0 {
                self.actors[i].air.rearm_timer = BASE_RETRY;
            }
            self.fly_circle(i, &f);
            return;
        };
        let (px, py) = (self.actors[b].x, self.actors[b].y);
        let a = &self.actors[i];
        let d = dist(a.x, a.y, px, py);
        if d <= f.speed && a.altitude <= 2 * f.climb {
            let a = &mut self.actors[i];
            a.x = px;
            a.y = py;
            a.altitude = 0;
            a.moved = true;
            a.air.phase = Phase::Parked;
            a.air.rearm_timer = 0;
            a.air.overshoot = false;
            a.air.rtb = false;
            if a.activity != Activity::Attack {
                a.activity = Activity::Idle;
            }
            return;
        }
        // Glide path: descend at the maximum pitch over the last stretch.
        let glide = f.cruise as i64 * f.speed as i64 / f.climb as i64 + CELL as i64;
        let alt = (d as i64 * f.cruise as i64 / glide.max(1)).min(f.cruise as i64) as i32;
        self.fly_toward(i, &f, px, py, alt);
    }

    /// One tick of an attack run against actor `t`.
    fn attack_run(&mut self, i: usize, t: usize, f: &Flight) {
        let (x, y) = (self.actors[i].x, self.actors[i].y);
        let tk = self.target_kind(t);
        let weapons = self.rules.actors[self.actors[i].ty as usize].weapons.clone();
        let usable: Vec<usize> = weapons.iter().copied().filter(|&w| self.rules.weapons[w].can_target(tk)).collect();
        let range = usable.iter().map(|&w| self.rules.weapons[w].range).max().unwrap_or(0);
        let min_range = usable.iter().map(|&w| self.rules.weapons[w].min_range).min().unwrap_or(0);
        let (tx, ty) = self.aim_point(t, x, y);
        let d = self.hit_distance(t, x, y);
        // Fire while the target is in range and near the nose.
        let desired = facing_of(tx - x, ty - y).unwrap_or(self.actors[i].facing);
        if d <= range && d >= min_range && angle_diff(self.actors[i].facing, desired).abs() <= FACING_TOLERANCE {
            for (slot, &w) in weapons.iter().enumerate().take(MAX_WEAPONS) {
                if self.ammo_left(i) == 0 {
                    break;
                }
                let wi = &self.rules.weapons[w];
                if self.actors[i].reload[slot] > 0 || !wi.can_target(tk) || d > wi.range || d < wi.min_range {
                    continue;
                }
                self.fire(i, t, w);
                let wi = &self.rules.weapons[w];
                let full_reload = self.modified_reload(i, wi.reload);
                let a = &mut self.actors[i];
                a.air.spent += 1;
                a.burst_shot[slot] += 1;
                if a.burst_shot[slot] < wi.burst {
                    a.reload[slot] = wi.burst_delay(a.burst_shot[slot] - 1).max(1);
                } else {
                    a.burst_shot[slot] = 0;
                    a.reload[slot] = full_reload;
                }
            }
        }
        // Pass over the target, fly on, then turn back for the next pass.
        let pass = min_range.max(CELL);
        if self.actors[i].air.overshoot {
            if d >= pass + OVERSHOOT {
                self.actors[i].air.overshoot = false;
            }
            self.fly_forward(i, f, f.cruise, true);
        } else if d < pass {
            self.actors[i].air.overshoot = true;
            self.fly_forward(i, f, f.cruise, true);
        } else {
            self.fly_toward(i, f, tx, ty, f.cruise);
        }
    }

    // ---- Death ---------------------------------------------------------------------

    /// Called by `World::kill`: an airborne plane does not vanish but falls
    /// (the husk of OpenRA's `SpawnActorOnDeath` + `FallsToEarth`). Returns
    /// true when the plane started to crash; `kill` runs again at impact.
    pub(crate) fn begin_crash(&mut self, i: usize) -> bool {
        if !self.is_plane(i) || self.actors[i].altitude <= 0 || self.actors[i].air.phase == Phase::Crashing {
            return false;
        }
        if self.flight(i).crash_velocity <= 0 {
            return false;
        }
        let a = &mut self.actors[i];
        a.air.phase = Phase::Crashing;
        a.air.base = NONE;
        a.air.cargo.clear();
        a.activity = Activity::Idle;
        a.target = NONE;
        a.hp = 0;
        a.invulnerable_until = u32::MAX; // a falling wreck takes no more damage
        true
    }

    /// Whether `kill` should skip the death weapon (the crash explosion replaced it).
    pub(crate) fn crashed(&self, i: usize) -> bool {
        self.actors[i].air.phase == Phase::Crashing
    }

    fn tick_crash(&mut self, i: usize) {
        let f = self.flight(i);
        // FallsToEarth with Moves: keeps flying forward while it drops.
        let a = &mut self.actors[i];
        let (vx, vy) = facing_vec(a.facing);
        a.x += vx * f.speed / 1024;
        a.y += vy * f.speed / 1024;
        a.altitude -= f.crash_velocity;
        a.moved = true;
        if a.altitude > 0 {
            return;
        }
        a.altitude = 0;
        let max_x = self.map.width * CELL - 1;
        let max_y = self.map.height * CELL - 1;
        let a = &mut self.actors[i];
        a.x = a.x.clamp(0, max_x);
        a.y = a.y.clamp(0, max_y);
        let (x, y, owner) = (a.x, a.y, a.owner);
        if let Some(w) = f.crash_weapon {
            self.impact(w, x, y, owner);
        }
        self.kill(i);
    }

    // ---- Production and orders --------------------------------------------------------

    /// A plane finished at airfield `b`: park it there when the airfield is
    /// free, else it starts in the air above. Then it heads for the rally point
    /// if one is set. Returns false when `u` is not a plane.
    pub(crate) fn plane_produced(&mut self, u: usize, b: usize) -> bool {
        if !self.is_plane(u) {
            return false;
        }
        let (bx, by, rally) = (self.actors[b].x, self.actors[b].y, self.actors[b].rally);
        let free = self.is_rearm_base_for(u, b) && !self.base_reserved_by_other(u, b);
        let bref = self.make_ref(b);
        let cruise = self.flight(u).cruise;
        let a = &mut self.actors[u];
        a.x = bx;
        a.y = by;
        a.px = bx;
        a.py = by;
        // OpenRA Exit@1 Facing 768 (east, counter-clockwise angles) is 256 here.
        a.facing = 256;
        a.pfacing = 256;
        if free {
            a.altitude = 0;
            a.air.phase = Phase::Parked;
            a.air.base = bref;
        } else {
            a.altitude = cruise;
            a.air.phase = Phase::Flying;
        }
        if let Some((rx, ry)) = rally {
            self.order_move(&[u], rx, ry, false);
        }
        true
    }

    /// What a smart order does for planes over an own airfield: return there.
    pub(crate) fn plane_smart_action(&self, player: u8, units: &[usize], x: i32, y: i32) -> Option<SmartAction> {
        let t = self.actor_at(player, x, y)?;
        (self.actors[t].owner == player && units.iter().any(|&i| self.is_plane(i) && self.is_rearm_base_for(i, t)))
            .then_some(SmartAction::Dock)
    }

    /// Smart order: planes clicked onto an own airfield return to base there
    /// (or the nearest free one when it is taken). Returns the other units.
    pub(crate) fn plane_smart_rtb(&mut self, player: u8, units: &[usize], x: i32, y: i32) -> Vec<usize> {
        let Some(t) = self.actor_at(player, x, y).filter(|&t| self.actors[t].owner == player && self.actors[t].kind == Kind::Building)
        else {
            return units.to_vec();
        };
        let (planes, rest): (Vec<usize>, Vec<usize>) = units.iter().partition(|&&i| self.is_plane(i) && self.is_rearm_base_for(i, t));
        let tref = self.make_ref(t);
        for i in planes {
            self.plane_return_to_base(i, Some(tref));
        }
        rest
    }

    /// Send a plane home to rearm (to `base` when free, else the nearest free base).
    pub fn plane_return_to_base(&mut self, i: usize, base: Option<u32>) {
        if !self.is_plane(i) || self.is_support_aircraft(i) || self.actors[i].air.phase == Phase::Crashing {
            return;
        }
        let a = &mut self.actors[i];
        a.activity = Activity::Idle;
        a.target = NONE;
        a.attack_move = false;
        if a.air.phase == Phase::Parked {
            return;
        }
        a.air.phase = Phase::Returning;
        a.air.rtb = true;
        a.air.rearm_timer = 0;
        if let Some(b) = base.and_then(|r| self.resolve(r)) {
            if self.is_rearm_base_for(i, b) && !self.base_reserved_by_other(i, b) {
                self.actors[i].air.base = self.make_ref(b);
            }
        }
    }

    // ---- Paratroopers ----------------------------------------------------------------

    /// Infantry under a parachute: sink at `FallRate`, then land. Landing on a
    /// cell infantry cannot stand on kills it (`KilledOnImpassableTerrain`).
    pub(crate) fn tick_parachute(&mut self, i: usize) {
        let a = &mut self.actors[i];
        a.altitude -= PARACHUTE_FALL_RATE;
        if a.altitude > 0 {
            return;
        }
        a.altitude = 0;
        a.air.parachute = false;
        let ci = self.cell_index(self.actors[i].x, self.actors[i].y);
        if self.pass.blocked[ci] {
            self.kill(i);
        }
    }

    // ---- Support power aircraft ----------------------------------------------------------

    /// Launch the aircraft of an AirstrikePower (spy plane, parabombs) or a
    /// ParatroopersPower toward (x, y). `dir` is an optional second point: the
    /// planes fly from the target toward it; without one they come from the
    /// player's base side. Returns false when the power cannot be launched.
    pub(crate) fn launch_air_power(&mut self, player: u8, info: &SupportPowerInfo, x: i32, y: i32, dir: Option<(i32, i32)>) -> bool {
        let Some(ty) = self.rules.actor_index(&info.unit_type) else { return false };
        if self.rules.actors[ty].unit.as_ref().and_then(|u| u.aircraft.as_ref()).is_none() {
            return false;
        }
        let drops: Vec<u16> = info.drop_items.iter().filter_map(|d| self.rules.actor_index(d)).map(|t| t as u16).collect();
        let mission = match info.kind.as_str() {
            "ParatroopersPower" => Mission::Paradrop,
            _ if !self.rules.actors[ty].weapons.is_empty() => Mission::Bombing,
            _ => Mission::SpyPlane,
        };
        if mission == Mission::Paradrop && drops.is_empty() {
            return false;
        }
        // Flight direction: toward the second point, else away from the player's base.
        let (sx, sy) = self.players[player as usize].start;
        let (bx, by) = (sx * CELL + CELL, sy * CELL + CELL);
        let facing = dir.and_then(|(x2, y2)| facing_of(x2 - x, y2 - y)).or_else(|| facing_of(x - bx, y - by)).unwrap_or(256);
        let (vx, vy) = facing_vec(facing);
        // Start beyond the map edge, behind the target.
        let max = (self.map.width.max(self.map.height) + 4) * CELL;
        let inside = |w: &World, d: i32| {
            let (px, py) = (x - vx * d / 1024, y - vy * d / 1024);
            px >= 0 && py >= 0 && px < w.map.width * CELL && py < w.map.height * CELL
        };
        let mut back = 0;
        while back < max && inside(self, back) {
            back += CELL / 2;
        }
        back += SUPPORT_CORDON;
        let (ox, oy) = (info.squad_offset.first().copied().unwrap_or(0), info.squad_offset.get(1).copied().unwrap_or(0));
        let cruise = self.rules.actors[ty].unit.as_ref().unwrap().aircraft.as_ref().unwrap().cruise_altitude;
        for k in 0..info.squad_size.max(1) {
            // OpenRA SquadOffset: x along the flight, y sideways, alternating sides.
            let side = if k % 2 == 1 { -1 } else { 1 };
            let rank = (k + 1) / 2;
            let along = ox * rank;
            let across = oy * rank * side;
            let (rx, ry) = facing_vec(facing + 256);
            let px = x - vx * back / 1024 + vx * along / 1024 + rx * across / 1024;
            let py = y - vy * back / 1024 + vy * along / 1024 + ry * across / 1024;
            let u = self.spawn_unit(ty as u16, player, px, py, facing);
            let a = &mut self.actors[u];
            a.altitude = cruise;
            a.air.mission = mission;
            a.air.tx = x + rx * across / 1024;
            a.air.ty = y + ry * across / 1024;
            a.air.camera_range = info.camera_range;
            a.air.camera_delay = info.camera_remove_delay;
            if mission == Mission::Paradrop {
                a.air.cargo = drops.clone();
            }
        }
        true
    }

    /// Spy plane, paratrooper and bomber flights: straight across the target, then off the map.
    fn tick_support_aircraft(&mut self, i: usize) {
        let f = self.flight(i);
        self.fly_forward(i, &f, f.cruise, false);
        let a = &self.actors[i];
        let (x, y, owner, tx, ty) = (a.x, a.y, a.owner, a.air.tx, a.air.ty);
        let d = dist(x, y, tx, ty);
        match a.air.mission {
            Mission::SpyPlane => {
                if !a.air.camera_done && d <= f.speed {
                    self.place_camera(i);
                }
            }
            Mission::Paradrop => {
                if d <= f.drop_range && !a.air.cargo.is_empty() {
                    self.place_camera(i);
                    let ci = self.cell_index(x, y);
                    let on_map = x >= 0 && y >= 0 && x < self.map.width * CELL && y < self.map.height * CELL;
                    if on_map && !self.pass.blocked[ci] {
                        let ty = self.actors[i].air.cargo.remove(0);
                        let (alt, facing) = (self.actors[i].altitude, self.actors[i].facing);
                        let u = self.spawn_unit(ty, owner, x, y, facing);
                        let p = &mut self.actors[u];
                        p.altitude = alt;
                        p.air.parachute = true;
                    }
                }
            }
            Mission::Bombing => {
                let weapons = self.rules.actors[self.actors[i].ty as usize].weapons.clone();
                for (slot, &w) in weapons.iter().enumerate().take(MAX_WEAPONS) {
                    if self.ammo_left(i) == 0 || d > self.rules.weapons[w].range || self.actors[i].reload[slot] > 0 {
                        continue;
                    }
                    self.place_camera(i);
                    let alt = self.actors[i].altitude;
                    let shot = self.shot_of(i);
                    self.drop_bomb(w, x, y, owner, alt, shot);
                    let reload = self.modified_reload(i, self.rules.weapons[w].reload);
                    let a = &mut self.actors[i];
                    a.air.spent += 1;
                    a.reload[slot] = reload;
                }
            }
            Mission::None => {}
        }
        // Gone once it left the map again.
        let a = &mut self.actors[i];
        let m = SUPPORT_CORDON;
        let inside_map = a.x >= 0 && a.y >= 0 && a.x < self.map.width * CELL && a.y < self.map.height * CELL;
        if inside_map {
            a.air.entered = true;
        } else if a.air.entered && (a.x < -m || a.y < -m || a.x >= self.map.width * CELL + m || a.y >= self.map.height * CELL + m) {
            self.remove(i);
        }
    }

    /// The power's camera at the target (once per aircraft).
    fn place_camera(&mut self, i: usize) {
        let a = &self.actors[i];
        if a.air.camera_done {
            return;
        }
        let (owner, tx, ty, range, delay) = (a.owner, a.air.tx, a.air.ty, a.air.camera_range, a.air.camera_delay);
        self.actors[i].air.camera_done = true;
        self.add_reveal(owner, tx, ty, range, delay);
    }

    /// Spy planes uncover the ground under their flight path (vision.rs hook via powers.rs).
    pub(crate) fn apply_spy_plane_reveals(&mut self) {
        for i in 0..self.actors.len() {
            let a = &self.actors[i];
            if a.alive && a.air.mission == Mission::SpyPlane && a.air.phase != Phase::Crashing {
                let (owner, x, y) = (a.owner, a.x, a.y);
                self.reveal_circle(owner, x, y, SPY_PATH_RANGE);
            }
        }
    }

    // ---- Bombs -----------------------------------------------------------------------

    /// Drop a GravityBomb of weapon `w` at (x, y) from `altitude`; it explodes on
    /// landing. `shot` credits kills to the aircraft that dropped it.
    pub(crate) fn drop_bomb(&mut self, w: usize, x: i32, y: i32, owner: u8, altitude: i32, shot: crate::veterancy::Shot) {
        let speed = self.rules.weapons[w].speed.max(1);
        if altitude <= 0 {
            self.impact_shot(w, x, y, owner, shot);
            return;
        }
        self.powers.bombs.push(crate::powers::FallingBomb { x, y, altitude, speed, weapon: w as u16, owner, shot });
    }

    pub(crate) fn tick_falling_bombs(&mut self) {
        let mut k = 0;
        while k < self.powers.bombs.len() {
            let b = &mut self.powers.bombs[k];
            b.altitude -= b.speed;
            if b.altitude > 0 {
                k += 1;
                continue;
            }
            let b = self.powers.bombs.remove(k);
            self.impact_shot(b.weapon as usize, b.x, b.y, b.owner, b.shot);
        }
    }

    // ---- Rendering ---------------------------------------------------------------------

    /// Extra sprites for aircraft: paratroopers with their canopy, falling
    /// bombs, contrails and the smoke of falling wrecks. Sprite ids:
    /// `SpriteIds::planes_base + PLANE_SPECIALS index` (apps/game/js/art/planes.js).
    pub(crate) fn render_air_extras(
        &self,
        player: u8,
        sink: &mut crate::instances::Sink,
        ids: &crate::render::SpriteIds,
        sprites: &mut Vec<f32>,
    ) {
        use crate::instances::SpriteRec;
        use crate::render::px;
        let parachute = ids.planes_base;
        let bomb = ids.planes_base + 1.0;
        let puff = ids.planes_base + 2.0;
        let smoke = ids.planes_base + 3.0;
        for (i, a) in self.actors.iter().enumerate() {
            if !a.alive {
                continue;
            }
            let ends = || ([px(a.px), px(a.py)], [px(a.x), px(a.y)]);
            if a.air.parachute {
                if a.owner != player && !self.is_visible_to(i, player) {
                    continue;
                }
                let (from, to) = ends();
                if !sink.visible(from, to, 48.0) {
                    continue;
                }
                let lift = px(a.altitude);
                let at = SpriteRec::moving(from, to, 48.0);
                let body = (a.ty * 2) as f32;
                sink.sprite(sprites, at.look(body, a.owner as f32, 0.9, 0.25, -1.0).offset(lift * 0.4, 0.0));
                sink.sprite(sprites, at.look(body, a.owner as f32, 1.0, 1.0, 0.0).offset(0.0, -lift));
                sink.sprite(sprites, at.look(parachute, a.owner as f32, 1.0, 1.0, 0.0).offset(0.0, -lift - 7.0));
                continue;
            }
            if a.kind != Kind::Aircraft || a.altitude <= 0 || !self.is_plane(i) {
                continue;
            }
            if a.owner != player && !self.is_visible_to(i, player) {
                continue;
            }
            let (from, to) = ends();
            if !sink.visible(from, to, 96.0) {
                continue;
            }
            let lift = px(a.altitude);
            let (vx, vy) = facing_vec(a.facing);
            let (fx, fy) = (vx as f32 / 1024.0, vy as f32 / 1024.0);
            let at = SpriteRec::moving(from, to, 96.0);
            if a.air.phase == Phase::Crashing {
                for k in 1..=3 {
                    let back = 6.0 * k as f32;
                    let s = 0.7 + 0.25 * k as f32;
                    sink.sprite(sprites, at.look(smoke, 0.0, s, 0.8 - 0.2 * k as f32, 0.0).offset(-fx * back, -lift - fy * back));
                }
            } else if a.altitude * 2 >= self.flight(i).cruise {
                // Contrail: a short fading trail of puffs behind the plane.
                for k in 1..=4 {
                    let back = 8.0 + 6.0 * k as f32;
                    let r = at.look(puff, 0.0, 0.6 + 0.12 * k as f32, 0.5 - 0.1 * k as f32, 0.0);
                    sink.sprite(sprites, r.offset(-fx * back, -lift - fy * back));
                }
            }
        }
        for b in &self.powers.bombs {
            let (x, y) = (px(b.x), px(b.y));
            let ci = self.cell_index(b.x, b.y);
            if (b.owner == player || self.render_sees_cell(player, ci)) && sink.visible([x, y], [x, y], 48.0) {
                // Falling: `speed` higher at the previous tick than at the current one.
                let lift = |alpha: f32| px(b.altitude) + px(b.speed) * (1.0 - alpha);
                let r = SpriteRec::at(x, y, 48.0).look(bomb, b.owner as f32, 1.0, 1.0, 0.0);
                sink.sprite(sprites, r.offset_moving([0.0, -lift(0.0)], [0.0, -lift(1.0)]));
            }
        }
    }
}

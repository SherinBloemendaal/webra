//! Per-tick unit behaviour: movement, crowd separation, combat, harvesting, repair.

use crate::flowfield::{DIRS, DIR_GOAL, DIR_NONE};
use crate::map::Resource;
use crate::math::{angle_diff, dist, dist_sq, facing_of, facing_vec, isqrt, turn_toward, CELL};
use crate::rules::Kind;
use crate::world::{cell_center, Activity, HarvState, World, NONE};

/// Vehicles stop to turn when the heading is off by more than this (45 degrees).
const MOVE_WHILE_TURNING: i32 = 128;
const MAX_PUSH: i32 = 96;
const STUCK_LIMIT: i32 = 75;
/// Ticks a unit of a group move must stall against stopped units before it
/// stops too.
const SETTLE_TICKS: i32 = 10;
/// Ticks an ore truck stays idle before it resumes harvesting.
const HARVESTER_IDLE_RESUME: i32 = 3 * 25;

impl World {
    pub(crate) fn tick_units(&mut self) {
        let n = self.actors.len();
        for i in 0..n {
            let a = &mut self.actors[i];
            if !a.alive {
                continue;
            }
            a.moved = false;
            if a.flash > 0 {
                a.flash -= 1;
            }
            for r in a.reload.iter_mut() {
                if *r > 0 {
                    *r -= 1;
                }
            }
        }
        // Alternate the processing direction every tick so no player's units
        // always act (and fire) first; otherwise player slot order decides fights.
        let forward = self.tick.is_multiple_of(2);
        for k in 0..n {
            let i = if forward { k } else { n - 1 - k };
            // Passengers sit out of the world inside their transport.
            if !self.actors[i].alive || !self.actors[i].in_world() {
                continue;
            }
            if self.actors[i].kind == Kind::Building {
                self.tick_defense(i);
                continue;
            }
            // Paratroopers sink on their parachute until they land (plane.rs).
            if self.actors[i].air.parachute {
                self.tick_parachute(i);
                continue;
            }
            // Idle with queued waypoints: on to the next one (commands.rs).
            if !self.actors[i].waypoints.is_empty() {
                self.next_waypoint(i);
            }
            match self.actors[i].kind {
                Kind::Aircraft => self.tick_aircraft(i),
                Kind::Ship => self.tick_ship(i),
                // Mines only wait to be driven over (abilities.rs).
                Kind::Mine => continue,
                _ => self.tick_unit_activity(i),
            }
            // Snow momentum and desert heat (weather.rs).
            if self.actors[i].alive && self.actors[i].kind == Kind::Vehicle {
                self.tick_vehicle_weather(i);
            }
            if self.actors[i].alive {
                self.tick_abilities(i);
            }
            if self.actors[i].alive {
                self.tick_self_heal(i);
                // Prone countdown and elite self repair (veterancy.rs).
                self.tick_veterancy(i);
            }
            if self.actors[i].alive && !self.actors[i].cargo.is_empty() {
                self.tick_cargo(i);
            }
        }
        self.separate_units();
    }

    /// The shared activity state machine (idle, move, attack, harvest, repair).
    /// Domain modules (plane.rs, helicopter.rs, naval.rs) call it for the parts
    /// they do not override.
    pub(crate) fn tick_unit_activity(&mut self, i: usize) {
        match self.actors[i].activity {
            Activity::Idle => self.tick_idle(i),
            Activity::Move => self.tick_move(i),
            Activity::Attack => self.tick_attack(i),
            Activity::Harvest => self.tick_harvest(i),
            Activity::Repair => self.tick_repair(i),
            Activity::Board => self.tick_board(i),
            Activity::Unload => self.tick_unload(i),
            Activity::Ability => self.tick_ability_activity(i),
            Activity::Guard => self.tick_guard(i),
            Activity::AttackGround => self.tick_attack_ground(i),
        }
    }

    // ---- Activities --------------------------------------------------------

    fn tick_idle(&mut self, i: usize) {
        if self.try_idle_target(i) {
            return;
        }
        // Idle ore trucks go back to work on their own after a short pause,
        // like OpenRA's harvesters (e.g. after a move order or a fight).
        if self.is_harvester(i) {
            let a = &mut self.actors[i];
            a.harv_timer += 1;
            if a.harv_timer >= HARVESTER_IDLE_RESUME {
                a.activity = Activity::Harvest;
                a.harv = HarvState::Search;
                a.harv_timer = 0;
            }
            return;
        }
        // Damaged vehicles parked on a repair pad get repaired.
        let a = &self.actors[i];
        if a.kind == crate::rules::Kind::Vehicle && a.hp < self.rules.actors[a.ty as usize].hp {
            let b = self.building_at[self.cell_index(a.x, a.y)];
            if b != NONE {
                let b = b as usize;
                let ba = &self.actors[b];
                if ba.owner == a.owner && self.rules.actors[ba.ty as usize].building.as_ref().unwrap().repairs.is_some() {
                    let r = self.make_ref(b);
                    let a = &mut self.actors[i];
                    a.activity = Activity::Repair;
                    a.depot = r;
                    a.repair_timer = 0;
                }
            }
        }
    }

    fn arrive_radius(&self, i: usize) -> i32 {
        let a = &self.actors[i];
        let r = self.rules.actors[a.ty as usize].unit.as_ref().unwrap().radius;
        if a.group_size <= 1 {
            return r.max(256);
        }
        (r * isqrt(a.group_size as i64) as i32 * 13 / 10).max(256)
    }

    fn tick_move(&mut self, i: usize) {
        if self.actors[i].attack_move {
            if self.try_auto_target(i) {
                self.actors[i].opportunity = NONE;
                return;
            }
        } else {
            // Turrets shoot at what they pass (combat.rs); the move goes on.
            self.opportunity_fire(i);
        }
        if !self.keep_goal_reachable(i) {
            self.actors[i].opportunity = NONE;
            return;
        }
        let goal = self.actors[i].goal;
        if goal == NONE {
            self.actors[i].activity = Activity::Idle;
            self.actors[i].opportunity = NONE;
            return;
        }
        let r = self.arrive_radius(i);
        if self.goal_reached(i, goal, r, true) {
            self.actors[i].activity = Activity::Idle;
            self.actors[i].attack_move = false;
            self.actors[i].opportunity = NONE;
            return;
        }
        self.move_toward(i, goal);
    }

    /// Field toward `goal` for unit `i`'s locomotor, or None for aircraft,
    /// which fly straight.
    fn unit_field(&mut self, i: usize, goal: u32) -> Option<&crate::flowfield::FlowField> {
        let loco = self.rules.actors[self.actors[i].ty as usize].unit.as_ref()?.locomotor;
        let pass = match self.rules.locomotors[loco].domain {
            crate::rules::Domain::Air => return None,
            crate::rules::Domain::Water => &self.pass_water,
            crate::rules::Domain::Ground => &self.pass,
        };
        Some(self.flow.field(&self.map, pass, &self.rules.locomotors, goal, loco as u8))
    }

    /// Flow direction toward `goal` at the cell of unit `i` (None for aircraft).
    pub(crate) fn flow_dir(&mut self, i: usize, goal: u32) -> Option<u8> {
        let ci = self.cell_index(self.actors[i].x, self.actors[i].y);
        self.unit_field(i, goal).map(|f| f.dirs[ci])
    }

    /// Length of the rest of the path from unit `i` to `goal`, in world
    /// units: the straight line to the next cell along the flow field plus
    /// the field's path length from there. Unlike the straight distance to
    /// the goal it shrinks on every detour around a wall and grows when the
    /// unit is pushed back. None when the goal cannot be reached from the
    /// unit's cell (or the unit stands on a blocked cell).
    pub(crate) fn path_remaining(&mut self, i: usize, goal: u32) -> Option<i32> {
        let (x, y) = (self.actors[i].x, self.actors[i].y);
        let w = self.map.width;
        let to_goal = || dist(x, y, cell_center(goal as i32 % w), cell_center(goal as i32 / w));
        let (cx, cy) = self.cell_of(x, y);
        let Some(f) = self.unit_field(i, goal) else { return Some(to_goal()) };
        match f.dirs[(cy * w + cx) as usize] {
            DIR_NONE => None,
            DIR_GOAL => Some(to_goal()),
            d => {
                // A field never points off the map or into a blocked cell.
                let (nx, ny) = (cx + DIRS[d as usize].0, cy + DIRS[d as usize].1);
                let rest = f.dist[(ny * w + nx) as usize] as i32;
                Some(rest * CELL + dist(x, y, cell_center(nx), cell_center(ny)))
            }
        }
    }

    /// A move whose goal can no longer be reached from where the unit stands
    /// (a structure went up on it, or walls cut it off) is sent to the
    /// nearest cell that can be reached instead, the same cell for every unit
    /// of the group. Returns false when there is none: the unit stops.
    pub(crate) fn keep_goal_reachable(&mut self, i: usize) -> bool {
        let goal = self.actors[i].goal;
        if goal == NONE {
            return true;
        }
        let Some(dir) = self.flow_dir(i, goal) else { return true };
        let domain = self.domain_of(i);
        let ci = self.cell_index(self.actors[i].x, self.actors[i].y);
        let pass = self.pass_for(domain);
        // Standing on a structure: step off it first (move_toward).
        if dir != DIR_NONE || pass.blocked[ci] {
            return true;
        }
        let g = (goal as i32 % self.map.width, goal as i32 / self.map.width);
        // Ties go toward the old goal itself, so the whole group agrees.
        let new = crate::flowfield::nearest_in_component(&self.map, pass, g, pass.component[ci], g).unwrap_or(NONE);
        let a = &mut self.actors[i];
        if new == NONE || new == goal {
            a.activity = Activity::Idle;
            a.goal = NONE;
            return false;
        }
        a.goal = new;
        a.best_dist = i32::MAX;
        a.stuck_ticks = 0;
        true
    }

    /// Arrival test. Distances count along the path, so a unit on the far
    /// side of a wall has not arrived, and progress is measured along the
    /// path, so a long detour is not mistaken for being stuck. A goal the
    /// unit can no longer reach counts as reached (callers give up on it;
    /// moves re-target first, see `keep_goal_reachable`).
    ///
    /// With `crowd` (group moves, `radius` is the group's radius) a unit
    /// arrives on the goal itself, or when it has stalled against an own unit
    /// that already stopped, within reach of the area the group fills. Being
    /// near the goal is not enough: a unit that stopped there while the others
    /// still queue behind it (in a gap, say) would block them for good.
    /// Without `crowd`, a unit near the goal that has made no progress for a
    /// while gives up.
    pub(crate) fn goal_reached(&mut self, i: usize, goal: u32, radius: i32, crowd: bool) -> bool {
        let rest = match self.path_remaining(i, goal) {
            Some(r) => r,
            None => {
                let ci = self.cell_index(self.actors[i].x, self.actors[i].y);
                if !self.pass_for(self.domain_of(i)).blocked[ci] {
                    return true;
                }
                // On a blocked cell (a structure went up around the unit):
                // no progress until it has stepped off.
                i32::MAX
            }
        };
        let own_radius = self.rules.actors[self.actors[i].ty as usize].unit.as_ref().unwrap().radius;
        let on_goal = if crowd { own_radius.max(256) } else { radius };
        // Within a cell of the goal `rest` is the straight distance to it.
        if rest <= on_goal {
            return true;
        }
        // Progress bookkeeping along the path.
        let jammed = self.jammed.get(i).copied().unwrap_or(false);
        let a = &mut self.actors[i];
        if rest < a.best_dist.saturating_sub(64) {
            a.best_dist = rest;
            a.stuck_ticks = 0;
            a.stall_ticks = 0;
        } else {
            a.stuck_ticks += 1;
            if !jammed {
                a.stall_ticks += 1;
            }
        }
        let (stuck, stall) = (a.stuck_ticks, a.stall_ticks);
        if crowd {
            if stuck >= SETTLE_TICKS && rest <= radius * 2 + CELL && self.touches_stopped_friend(i) {
                return true;
            }
        } else if stuck > STUCK_LIMIT && rest <= radius + 2 * CELL {
            return true;
        }
        // Blocked for good (enemies in a gap, a wall of units that does not
        // move). Waiting in a moving queue does not count: a big army
        // funnelling through a gap takes its time.
        stall > STUCK_LIMIT * 6
    }

    /// Whether unit `i` touches an idle unit of its owner (one that already
    /// arrived or was parked there).
    fn touches_stopped_friend(&self, i: usize) -> bool {
        let me = &self.actors[i];
        let (x, y) = (me.x, me.y);
        let (cx, cy) = self.cell_of(x, y);
        let rr = self.rules.actors[me.ty as usize].unit.as_ref().unwrap().radius;
        for oy in -1..=1 {
            for ox in -1..=1 {
                if !self.map.contains(cx + ox, cy + oy) {
                    continue;
                }
                for &u in self.units_in_cell(self.map.idx(cx + ox, cy + oy)) {
                    let u = u as usize;
                    let o = &self.actors[u];
                    if u == i || o.owner != me.owner || o.activity != Activity::Idle || (o.altitude == 0) != (me.altitude == 0) {
                        continue;
                    }
                    let orr = self.rules.actors[o.ty as usize].unit.as_ref().unwrap().radius;
                    if dist(x, y, o.x, o.y) <= rr + orr + 64 {
                        return true;
                    }
                }
            }
        }
        false
    }

    /// One movement step along the flow field toward `goal`.
    pub(crate) fn move_toward(&mut self, i: usize, goal: u32) {
        let (x, y) = (self.actors[i].x, self.actors[i].y);
        let ci = self.cell_index(x, y);
        let unit = Drive::of(self.rules.actors[self.actors[i].ty as usize].unit.as_ref().unwrap());
        let loco = unit.locomotor as u8;
        let domain = self.rules.locomotors[unit.locomotor].domain;
        if domain == crate::rules::Domain::Air {
            // Aircraft fly straight to their goal.
            let (gx, gy) = (cell_center(goal as i32 % self.map.width), cell_center(goal as i32 / self.map.width));
            self.drive_toward(i, gx, gy, unit);
            return;
        }
        let (cx, cy) = self.cell_of(x, y);
        let pass = if domain == crate::rules::Domain::Water { &self.pass_water } else { &self.pass };
        let field = self.flow.field(&self.map, pass, &self.rules.locomotors, goal, loco);
        let dir = field.dirs[ci];
        let (wx, wy) = if dir == DIR_GOAL {
            (cell_center(goal as i32 % self.map.width), cell_center(goal as i32 / self.map.width))
        } else if dir == DIR_NONE {
            if !pass.blocked[ci] {
                // The goal cannot be reached from this cell: nothing to do
                // (moves re-target, other activities give up in goal_reached).
                return;
            }
            // Standing on a blocked cell (a structure went up around us):
            // step to the open neighbour closest to the goal along the path,
            // else to any open neighbour.
            let mut best: Option<((u16, usize), (i32, i32))> = None;
            for (d, &(dx, dy)) in DIRS.iter().enumerate() {
                let (nx, ny) = (cx + dx, cy + dy);
                if !self.map.contains(nx, ny) || pass.blocked[self.map.idx(nx, ny)] {
                    continue;
                }
                let key = (field.dist[self.map.idx(nx, ny)], d);
                if best.is_none_or(|(bk, _)| key < bk) {
                    best = Some((key, (nx, ny)));
                }
            }
            match best {
                Some((_, (nx, ny))) => (cell_center(nx), cell_center(ny)),
                None => {
                    self.actors[i].activity = Activity::Idle;
                    return;
                }
            }
        } else {
            let (dx, dy) = DIRS[dir as usize];
            (cell_center(cx + dx), cell_center(cy + dy))
        };
        self.drive_toward(i, wx, wy, unit);
    }

    /// Turn and drive toward a world point, respecting turn rate and terrain
    /// speed, and on snow the vehicle's momentum (weather.rs).
    pub(crate) fn step_toward(&mut self, i: usize, wx: i32, wy: i32, unit: &crate::rules::UnitInfo) {
        self.drive_toward(i, wx, wy, Drive::of(unit));
    }

    /// `step_toward` with the unit's movement stats copied out of the rules
    /// (no clone of its whole UnitInfo every tick).
    fn drive_toward(&mut self, i: usize, wx: i32, wy: i32, unit: Drive) {
        let (x, y) = (self.actors[i].x, self.actors[i].y);
        let Some(desired) = facing_of(wx - x, wy - y) else { return };
        let ci = self.cell_index(x, y);
        let loco = &self.rules.locomotors[unit.locomotor];
        let ship = loco.domain == crate::rules::Domain::Water;
        let speed_pct = loco.speeds[self.map.speed_class_for(ci, ship)];
        // Rank speed bonus and prone infantry (veterancy.rs), then weather (weather.rs).
        let speed = self.weather_speed(i, self.modified_speed(i, unit.speed * speed_pct / 100));
        let grip = self.grip_of(i, ci);
        let turn_speed = grip.map_or(unit.turn_speed, |(_, _, turn)| (unit.turn_speed * turn / 100).max(1));
        let turret_speed = self.rules.actors[self.actors[i].ty as usize].turret_turn_speed;
        let a = &mut self.actors[i];
        let has_turret = turret_speed.is_some();
        // The turret follows the hull unless it aims at an attack target or
        // at a target of opportunity fire.
        let turret_free = a.opportunity == NONE || a.activity != Activity::Move;
        if unit.turn_in_place {
            a.facing = desired;
        } else {
            a.facing = turn_toward(a.facing, desired, turn_speed);
            // On snow the vehicle keeps sliding while it turns (coast in tick_vehicle_weather).
            if angle_diff(a.facing, desired).abs() > MOVE_WHILE_TURNING {
                if has_turret && a.target == NONE && turret_free {
                    a.turret = turn_toward(a.turret, a.facing, turret_speed.unwrap());
                }
                return;
            }
        }
        if has_turret && (a.target == NONE || a.activity != Activity::Attack) && turret_free {
            a.turret = turn_toward(a.turret, a.facing, turret_speed.unwrap());
        }
        // Momentum: speed builds up and drops off gradually.
        let speed = match grip {
            Some((accel, brake, _)) => {
                let (up, down) = ((unit.speed * accel / 100).max(1), (unit.speed * brake / 100).max(1));
                let v = a.env.vel;
                a.env.vel = if v < speed { (v + up).min(speed) } else { (v - down).max(speed) };
                a.env.heading = a.facing;
                a.env.vel
            }
            None => speed,
        };
        let d = dist(x, y, wx, wy);
        let (nx, ny) = if d <= speed {
            (wx, wy)
        } else if unit.turn_in_place {
            (x + ((wx - x) as i64 * speed as i64 / d as i64) as i32, y + ((wy - y) as i64 * speed as i64 / d as i64) as i32)
        } else {
            let (vx, vy) = facing_vec(a.facing);
            (x + vx * speed / 1024, y + vy * speed / 1024)
        };
        self.try_move(i, nx, ny);
    }

    /// Speed after weather: infantry wade through snow, overheated vehicles crawl.
    fn weather_speed(&self, i: usize, speed: i32) -> i32 {
        let a = &self.actors[i];
        if a.kind == Kind::Infantry && self.env.snow_effects() {
            speed * crate::weather::SNOW_INFANTRY_SPEED_PCT / 100
        } else if a.env.overheated {
            speed * crate::weather::OVERHEAT_SPEED_PCT / 100
        } else {
            speed
        }
    }

    /// Ice: rough ground (frozen ponds) in the snow biome.
    pub(crate) fn is_ice(&self, ci: usize) -> bool {
        self.map.biome_ice(ci, self.env.biome)
    }

    /// Grip of a ground vehicle on snow (weather::grip), None without momentum.
    fn grip_of(&self, i: usize, ci: usize) -> Option<(i32, i32, i32)> {
        let a = &self.actors[i];
        (a.kind == Kind::Vehicle && self.env.snow_effects() && a.altitude == 0).then(|| crate::weather::grip(self.is_ice(ci)))
    }

    /// After a vehicle's activity: on snow it coasts on when it did not drive
    /// this tick (stopped, or turning hard), braking as it goes; in the desert
    /// it heats up or cools down. Precise work (harvesting, docking, repair,
    /// boarding, abilities) stops dead instead of coasting.
    fn tick_vehicle_weather(&mut self, i: usize) {
        if self.actors[i].env.vel > 0 && !self.actors[i].moved {
            let a = &self.actors[i];
            let precise =
                matches!(a.activity, Activity::Harvest | Activity::Repair | Activity::Board | Activity::Unload | Activity::Ability);
            match self.grip_of(i, self.cell_index(a.x, a.y)) {
                Some((_, brake, _)) if !precise => {
                    let top = self.rules.actors[a.ty as usize].unit.as_ref().map_or(0, |u| u.speed);
                    let vel = (a.env.vel - (top * brake / 100).max(1)).max(0);
                    let (vx, vy) = facing_vec(a.env.heading);
                    let (x, y) = (a.x, a.y);
                    self.actors[i].env.vel = vel;
                    if vel > 0 && !self.try_move(i, x + vx * vel / 1024, y + vy * vel / 1024) {
                        self.actors[i].env.vel = 0;
                    }
                }
                _ => self.actors[i].env.vel = 0,
            }
        }
        if self.env.effects() && self.env.biome == crate::weather::Biome::Desert {
            let wave = self.env.heat_wave();
            let a = &mut self.actors[i];
            let (moved, fired) = (a.moved, a.env.fired);
            crate::weather::heat_step(&mut a.env, wave, moved, fired);
        }
        self.actors[i].env.fired = false;
    }

    /// Move to (nx, ny) unless that enters a blocked cell; slide along walls.
    fn try_move(&mut self, i: usize, nx: i32, ny: i32) -> bool {
        let (x, y) = (self.actors[i].x, self.actors[i].y);
        for (tx, ty) in [(nx, ny), (nx, y), (x, ny)] {
            if (tx, ty) == (x, y) {
                continue;
            }
            let max_x = self.map.width * CELL - 1;
            let max_y = self.map.height * CELL - 1;
            // Never stop exactly on a cell border: `cell_of` would put the unit
            // in the cell below or right of the border, which is not point
            // symmetric. Step one unit further, into the cell the unit enters.
            let (tx, ty) = (off_border(x, tx).clamp(1, max_x), off_border(y, ty).clamp(1, max_y));
            let from = self.cell_index(x, y);
            let to = self.cell_index(tx, ty);
            let d = self.domain_of(i);
            if to == from || d == crate::rules::Domain::Air || self.may_enter(d, (x, y), (tx, ty)) {
                let a = &mut self.actors[i];
                a.x = tx;
                a.y = ty;
                a.moved = true;
                return true;
            }
        }
        false
    }

    /// Whether a ground or water unit may move from point `a` into the
    /// different cell of point `b`: the cell must be open, and a diagonal
    /// step must not squeeze between two blocked cells. That is the rule the
    /// flow fields and connectivity labels use (`flowfield::step`), so units
    /// never slip into a pocket their fields cannot lead them out of. A unit
    /// on a blocked cell (a structure went up around it) may leave any way.
    fn may_enter(&self, d: crate::rules::Domain, a: (i32, i32), b: (i32, i32)) -> bool {
        let blocked = &self.pass_for(d).blocked;
        let (fx, fy) = self.cell_of(a.0, a.1);
        let (tx, ty) = self.cell_of(b.0, b.1);
        if blocked[self.map.idx(tx, ty)] {
            return false;
        }
        if blocked[self.map.idx(fx, fy)] || fx == tx || fy == ty {
            return true;
        }
        !blocked[self.map.idx(tx, fy)] && !blocked[self.map.idx(fx, ty)]
    }

    // ---- Harvesting --------------------------------------------------------

    fn tick_harvest(&mut self, i: usize) {
        let info = self.rules.actors[self.actors[i].ty as usize].unit.clone().unwrap();
        let hv = info.harvester.clone().unwrap();
        match self.actors[i].harv {
            HarvState::Wait => {
                let a = &mut self.actors[i];
                a.harv_timer -= 1;
                if a.harv_timer <= 0 {
                    a.harv = HarvState::Search;
                }
            }
            HarvState::Search => {
                let found = self.find_ore(i, &hv);
                let a = &mut self.actors[i];
                match found {
                    Some(c) => {
                        a.harv_cell = c;
                        a.goal = c;
                        a.harv = HarvState::ToOre;
                        a.group_size = 1;
                        a.best_dist = i32::MAX;
                        a.stuck_ticks = 0;
                    }
                    None if a.bales > 0 => a.harv = HarvState::ToDock,
                    None => {
                        a.harv = HarvState::Wait;
                        a.harv_timer = 50;
                        a.harv_cell = NONE;
                    }
                }
            }
            HarvState::ToOre => {
                let c = self.actors[i].harv_cell;
                if c == NONE || !self.map.has_resource(c as usize) {
                    self.actors[i].harv = HarvState::Search;
                    return;
                }
                if self.at_cell_center(i, c) {
                    let a = &mut self.actors[i];
                    a.harv = HarvState::Harvesting;
                    a.harv_timer = hv.bale_load_delay;
                    return;
                }
                if self.goal_reached(i, c, 0, false) {
                    // Could not get onto that cell (crowded); pick another.
                    let a = &mut self.actors[i];
                    a.harv = HarvState::Search;
                    a.harv_cell = NONE;
                    return;
                }
                self.move_toward(i, c);
            }
            HarvState::Harvesting => {
                let c = self.actors[i].harv_cell as usize;
                let a = &mut self.actors[i];
                a.harv_timer -= 1;
                if a.harv_timer > 0 {
                    return;
                }
                a.harv_timer = hv.bale_load_delay;
                // One bale of whatever the cell holds; the truck counts gems apart.
                if let Some(r) = self.map.take_bale(c) {
                    self.terrain_dirty = true;
                    let a = &mut self.actors[i];
                    a.bales += 1;
                    a.gem_bales += (r == Resource::Gems) as i32;
                }
                let a = &mut self.actors[i];
                if a.bales >= hv.capacity {
                    a.harv = HarvState::ToDock;
                    a.best_dist = i32::MAX;
                    a.stuck_ticks = 0;
                } else if !self.map.has_resource(c) {
                    a.harv = HarvState::Search;
                }
            }
            HarvState::ToDock => {
                let Some(r) = self.pick_refinery(i) else {
                    let a = &mut self.actors[i];
                    a.harv = HarvState::Wait;
                    a.harv_timer = 50;
                    return;
                };
                let dock = self.dock_cell(r);
                let me = self.make_ref(i);
                let busy = self.resolve(self.actors[r].dock_user).is_some_and(|u| self.make_ref(u) != me);
                if self.at_cell_center(i, dock) && !busy {
                    self.actors[r].dock_user = me;
                    let rref = self.make_ref(r);
                    let a = &mut self.actors[i];
                    a.refinery = rref;
                    a.harv = HarvState::Unloading;
                    a.harv_timer = hv.bale_unload_delay;
                    return;
                }
                // Wait outside while another harvester unloads.
                let (dx, dy) = (cell_center(dock as i32 % self.map.width), cell_center(dock as i32 / self.map.width));
                if busy && dist(self.actors[i].x, self.actors[i].y, dx, dy) < 3 * CELL {
                    return;
                }
                self.move_toward(i, dock);
            }
            HarvState::Unloading => {
                let Some(r) = self.resolve(self.actors[i].refinery) else {
                    self.actors[i].harv = HarvState::ToDock;
                    return;
                };
                let a = &mut self.actors[i];
                a.facing = turn_toward(a.facing, 0, info.turn_speed);
                a.harv_timer -= 1;
                if a.harv_timer > 0 {
                    return;
                }
                a.harv_timer = hv.bale_unload_delay.max(1);
                if a.bales > 0 {
                    // Each bale pays its own type's value (PlayerResources.ResourceValues):
                    // ore bales first, then gems.
                    let gem = a.bales == a.gem_bales;
                    a.bales -= 1;
                    a.gem_bales -= gem as i32;
                    let owner = a.owner;
                    let value = if gem { self.rules.player.gem_value } else { self.rules.player.ore_value };
                    self.give_harvested(owner, value, gem);
                }
                if self.actors[i].bales == 0 {
                    self.actors[r].dock_user = NONE;
                    let a = &mut self.actors[i];
                    a.harv = HarvState::Search;
                }
            }
        }
    }

    pub(crate) fn at_cell_center(&self, i: usize, cell: u32) -> bool {
        let a = &self.actors[i];
        let (cx, cy) = (cell_center(cell as i32 % self.map.width), cell_center(cell as i32 / self.map.width));
        dist(a.x, a.y, cx, cy) <= 96
    }

    fn pick_refinery(&mut self, i: usize) -> Option<usize> {
        if let Some(r) = self.resolve(self.actors[i].refinery) {
            if self.actors[r].owner == self.actors[i].owner {
                return Some(r);
            }
        }
        let (x, y, owner) = (self.actors[i].x, self.actors[i].y, self.actors[i].owner);
        let mut best: Option<(i64, usize)> = None;
        for (j, b) in self.actors.iter().enumerate() {
            if !b.alive || b.owner != owner || b.kind != Kind::Building {
                continue;
            }
            if self.rules.actors[b.ty as usize].building.as_ref().unwrap().refinery.is_none() {
                continue;
            }
            let d = dist_sq(x, y, b.x, b.y);
            if best.is_none_or(|(bd, _)| d < bd) {
                best = Some((d, j));
            }
        }
        let r = best.map(|(_, j)| j)?;
        self.actors[i].refinery = self.make_ref(r);
        Some(r)
    }

    pub fn dock_cell(&self, r: usize) -> u32 {
        let a = &self.actors[r];
        let b = self.rules.actors[a.ty as usize].building.as_ref().unwrap();
        let rf = b.refinery.as_ref().unwrap();
        let x = a.x + b.center_offset.0 + rf.dock_offset.0;
        let y = a.y + b.center_offset.1 + rf.dock_offset.1;
        self.cell_index(x, y) as u32
    }

    /// The nearest unclaimed ore or gem cell. As in OpenRA
    /// (FindAndDeliverResources.ClosestHarvestablePos) only the distance
    /// counts, not the resource's value: a truck mines the field it is sent
    /// to or the nearest one, gems or ore alike.
    fn find_ore(&mut self, i: usize, hv: &crate::rules::HarvesterInfo) -> Option<u32> {
        let a = &self.actors[i];
        let (origin, radius) = if a.harv_cell != NONE {
            let c = a.harv_cell as i32;
            ((c % self.map.width, c / self.map.width), hv.search_from_harv)
        } else if let Some(r) = self.resolve(a.refinery) {
            (self.cell_of(self.actors[r].x, self.actors[r].y), hv.search_from_proc)
        } else {
            (self.cell_of(a.x, a.y), hv.search_from_proc)
        };
        let comp = self.pass.component[self.cell_index(a.x, a.y)];
        let (ux, uy) = self.cell_of(a.x, a.y);
        // Cells other harvesters already claimed.
        let claimed: Vec<u32> = self
            .actors
            .iter()
            .enumerate()
            .filter(|(j, o)| {
                *j != i
                    && o.alive
                    && o.activity == crate::world::Activity::Harvest
                    && matches!(o.harv, HarvState::ToOre | HarvState::Harvesting)
            })
            .map(|(_, o)| o.harv_cell)
            .collect();
        // Ties go to the cell nearer the refinery dock (shorter trip back), then
        // nearer the map centre, never to scan order: mirrored harvesters on a
        // symmetric map must pick mirrored cells.
        let dock = match self.resolve(self.actors[i].refinery) {
            Some(r) => {
                let d = self.dock_cell(r) as i32;
                (d % self.map.width, d / self.map.width)
            }
            None => (ux, uy),
        };
        let mut best: Option<((i32, i32, i32), u32)> = None;
        for y in origin.1 - radius..=origin.1 + radius {
            for x in origin.0 - radius..=origin.0 + radius {
                if !self.map.contains(x, y) {
                    continue;
                }
                let c = self.map.idx(x, y);
                if !self.map.has_resource(c) || self.pass.blocked[c] || self.pass.component[c] != comp {
                    continue;
                }
                if claimed.contains(&(c as u32)) {
                    continue;
                }
                let d = (x - ux).pow(2) + (y - uy).pow(2);
                let key = (d, (x - dock.0).pow(2) + (y - dock.1).pow(2), crate::flowfield::centre_distance(&self.map, x, y));
                if best.is_none_or(|(bk, bc)| key < bk || (key == bk && (c as u32) < bc)) {
                    best = Some((key, c as u32));
                }
            }
        }
        if best.is_none() && self.actors[i].harv_cell != NONE {
            // Nothing near the last field: search again from the refinery.
            self.actors[i].harv_cell = NONE;
            return self.find_ore(i, hv);
        }
        best.map(|(_, c)| c)
    }

    // ---- Repair ------------------------------------------------------------

    /// Whether unit `u` (vehicle or ship) is repaired by building `b`
    /// (OpenRA Repairable / RepairableNear RepairActors).
    pub(crate) fn repairs_at(&self, u: usize, b: usize) -> bool {
        let (ua, ba) = (&self.actors[u], &self.actors[b]);
        if !matches!(ua.kind, Kind::Vehicle | Kind::Ship) || ba.kind != Kind::Building {
            return false;
        }
        let binfo = &self.rules.actors[ba.ty as usize];
        binfo.building.as_ref().is_some_and(|bi| bi.repairs.is_some())
            && self.rules.actors[ua.ty as usize]
                .unit
                .as_ref()
                .is_some_and(|un| un.repair_at.iter().any(|id| id.eq_ignore_ascii_case(&binfo.id)))
    }

    fn tick_repair(&mut self, i: usize) {
        let Some(d) = self.resolve(self.actors[i].depot) else {
            self.actors[i].activity = Activity::Idle;
            return;
        };
        let depot = &self.actors[d];
        let binfo = self.rules.actors[depot.ty as usize].building.as_ref().unwrap();
        let rep = binfo.repairs.clone().unwrap();
        let pad = self.map.idx(depot.cx + binfo.width / 2, depot.cy + binfo.height / 2) as u32;
        if !self.at_cell_center(i, pad) {
            if self.goal_reached(i, pad, 0, false) {
                self.actors[i].activity = Activity::Idle;
                return;
            }
            self.move_toward(i, pad);
            return;
        }
        let max_hp = self.rules.actors[self.actors[i].ty as usize].hp;
        if self.actors[i].hp >= max_hp {
            // Done: leave the pad toward the depot's rally point (or just below it).
            let (rx, ry) = self.actors[d]
                .rally
                .unwrap_or((cell_center(self.actors[d].cx + binfo.width / 2), cell_center(self.actors[d].cy + binfo.height + 1)));
            self.order_move(&[i], rx, ry, false);
            return;
        }
        self.repair_step(i, &rep);
    }

    /// One RepairsUnits interval on unit `i`: heal HpPerStep when the owner can pay.
    pub(crate) fn repair_step(&mut self, i: usize, rep: &crate::rules::RepairInfo) {
        let ty = self.actors[i].ty as usize;
        let (max_hp, cost) = (self.rules.actors[ty].hp, self.rules.actors[ty].cost);
        let a = &mut self.actors[i];
        a.repair_timer -= 1;
        if a.repair_timer > 0 {
            return;
        }
        a.repair_timer = rep.interval;
        let step = rep.hp_per_step.min(max_hp - a.hp);
        // OpenRA RepairsUnits: repair costs ValuePercent of the unit's value, pro rata.
        let price = ((cost as i64 * rep.value_percent as i64 * step as i64 + 100 * max_hp as i64 - 1) / (100 * max_hp as i64)) as i32;
        let owner = a.owner;
        if self.spend(owner, price) {
            self.note_repair(owner, price);
            self.actors[i].hp += step;
            self.uncloak_on(i, "Heal");
        }
    }

    // ---- Crowd separation --------------------------------------------------

    fn separate_units(&mut self) {
        self.rebuild_hash();
        let n = self.actors.len();
        let mut push = vec![(0i32, 0i32); n];
        let mut jammed = vec![false; n];
        // (victim, crusher): crushing counts as a kill by the crusher
        // (veterancy.rs, and for its owner in the observer stats).
        let mut crushed: Vec<(usize, usize)> = Vec::new();
        for i in 0..n {
            let a = &self.actors[i];
            // Planes and paratroopers in the air never bump into anything (plane.rs); mines are not units.
            if !a.alive || !a.is_unit() || a.air.parachute || self.is_plane(i) {
                continue;
            }
            let ra = self.rules.actors[a.ty as usize].unit.as_ref().unwrap().radius;
            let (cx, cy) = self.cell_of(a.x, a.y);
            for oy in -1..=1 {
                for ox in -1..=1 {
                    if !self.map.contains(cx + ox, cy + oy) {
                        continue;
                    }
                    for &j in self.units_in_cell(self.map.idx(cx + ox, cy + oy)) {
                        let j = j as usize;
                        if j <= i {
                            continue;
                        }
                        let b = &self.actors[j];
                        // Only units in the same domain bump into each other
                        // (aircraft fly over tanks, ships never meet tanks).
                        if !b.alive || self.domain_of(i) != self.domain_of(j) || b.air.parachute || self.is_plane(j) {
                            continue;
                        }
                        // A landed helicopter and one flying over it do not touch.
                        if (a.altitude == 0) != (b.altitude == 0) {
                            continue;
                        }
                        let rb = self.rules.actors[b.ty as usize].unit.as_ref().unwrap().radius;
                        let min = ra + rb;
                        let (dx, dy) = (b.x - a.x, b.y - a.y);
                        let d2 = dx as i64 * dx as i64 + dy as i64 * dy as i64;
                        if d2 >= (min as i64) * (min as i64) {
                            continue;
                        }
                        // A moving crusher (tracked vehicles, ore truck) runs over enemy soldiers.
                        if self.are_enemies(a.owner, b.owner) {
                            let crush_reach = (min as i64) * (min as i64) * 9 / 16;
                            if d2 <= crush_reach {
                                if a.moved && self.crushes(i, j) {
                                    crushed.push((j, i));
                                    continue;
                                }
                                if b.moved && self.crushes(j, i) {
                                    crushed.push((i, j));
                                    continue;
                                }
                            }
                        }
                        let friends = !self.are_enemies(a.owner, b.owner);
                        if friends {
                            jammed[i] |= b.moved;
                            jammed[j] |= a.moved;
                        }
                        let d = isqrt(d2) as i32;
                        let (nx, ny) = if d == 0 {
                            // Deterministic split for exactly overlapping units.
                            let f = (i * 7 + j * 13) % 8;
                            (DIRS[f].0 * 1024, DIRS[f].1 * 1024)
                        } else {
                            (dx * 1024 / d, dy * 1024 / d)
                        };
                        let overlap = (min - d).min(MAX_PUSH * 2);
                        // Moving units push standing friends aside, so a crowd that
                        // stopped makes room for those still arriving instead of
                        // plugging their way; standing enemies are walls.
                        let (wa, wb) = match (a.moved, b.moved, friends) {
                            (true, false, true) => (0, 100),
                            (false, true, true) => (100, 0),
                            (true, false, false) => (100, 0),
                            (false, true, false) => (0, 100),
                            _ => (50, 50),
                        };
                        let pa = overlap * wa / 100;
                        let pb = overlap * wb / 100;
                        push[i].0 -= nx * pa / 1024;
                        push[i].1 -= ny * pa / 1024;
                        push[j].0 += nx * pb / 1024;
                        push[j].1 += ny * pb / 1024;
                    }
                }
            }
        }
        self.jammed = jammed;
        for (k, crusher) in crushed {
            if self.actors[k].alive {
                let source = self.make_ref(crusher);
                self.award_kill(k, source);
                let by = self.actors[crusher].owner;
                self.with_damage_source(by, |w| w.kill(k));
            }
        }
        for (i, &(px, py)) in push.iter().enumerate() {
            if px == 0 && py == 0 || !self.actors[i].alive {
                continue;
            }
            let a = &self.actors[i];
            // Units busy at a dock or repair pad hold their spot.
            if a.activity == Activity::Harvest && matches!(a.harv, HarvState::Unloading | HarvState::Harvesting) {
                continue;
            }
            let (px, py) = (px.clamp(-MAX_PUSH, MAX_PUSH), py.clamp(-MAX_PUSH, MAX_PUSH));
            let (x, y) = (a.x, a.y);
            let moved = self.actors[i].moved;
            self.try_move(i, x + px, y + py);
            self.actors[i].moved = moved;
        }
    }

    fn crushes(&self, a: usize, b: usize) -> bool {
        let (ta, tb) = (&self.actors[a], &self.actors[b]);
        if ta.kind != Kind::Vehicle || tb.kind != Kind::Infantry {
            return false;
        }
        let loco = self.rules.actors[ta.ty as usize].unit.as_ref().unwrap().locomotor;
        self.rules.locomotors[loco].crushes_infantry
    }
}

/// The movement stats `step_toward` needs from a UnitInfo.
#[derive(Clone, Copy)]
struct Drive {
    locomotor: usize,
    speed: i32,
    turn_speed: i32,
    turn_in_place: bool,
}

impl Drive {
    fn of(u: &crate::rules::UnitInfo) -> Drive {
        Drive { locomotor: u.locomotor, speed: u.speed, turn_speed: u.turn_speed, turn_in_place: u.turn_in_place }
    }
}

/// `to`, moved one world unit further along the motion from `from` if it lies
/// exactly on a cell border.
#[inline]
fn off_border(from: i32, to: i32) -> i32 {
    if to.rem_euclid(CELL) == 0 {
        to + (to - from).signum()
    } else {
        to
    }
}

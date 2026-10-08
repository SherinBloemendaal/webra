//! Per-tick unit behaviour: movement, crowd separation, combat, harvesting, repair.

use crate::flowfield::{DIRS, DIR_GOAL, DIR_NONE};
use crate::math::{angle_diff, dist, dist_sq, facing_of, facing_vec, isqrt, turn_toward, CELL};
use crate::rules::Kind;
use crate::world::{cell_center, Activity, HarvState, World, NONE};

/// Vehicles stop to turn when the heading is off by more than this (45 degrees).
const MOVE_WHILE_TURNING: i32 = 128;
const MAX_PUSH: i32 = 96;
const STUCK_LIMIT: i32 = 75;
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
            if self.actors[i].alive {
                self.tick_abilities(i);
            }
            if self.actors[i].alive {
                self.tick_self_heal(i);
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
        if self.actors[i].attack_move && self.try_auto_target(i) {
            return;
        }
        let goal = self.actors[i].goal;
        if goal == NONE {
            self.actors[i].activity = Activity::Idle;
            return;
        }
        let r = self.arrive_radius(i);
        if self.goal_reached(i, goal, r, true) {
            self.actors[i].activity = Activity::Idle;
            self.actors[i].attack_move = false;
            return;
        }
        self.move_toward(i, goal);
    }

    /// Arrival test, including crowd arrival: a unit that bumps into a stopped
    /// member of its own group near the goal stops too.
    pub(crate) fn goal_reached(&mut self, i: usize, goal: u32, radius: i32, crowd: bool) -> bool {
        let gx = cell_center(goal as i32 % self.map.width);
        let gy = cell_center(goal as i32 / self.map.width);
        let (x, y) = (self.actors[i].x, self.actors[i].y);
        let d = dist(x, y, gx, gy);
        if d <= radius {
            return true;
        }
        if crowd && d <= radius * 2 + CELL {
            let (cx, cy) = self.cell_of(x, y);
            let me = &self.actors[i];
            let rr = self.rules.actors[me.ty as usize].unit.as_ref().unwrap().radius;
            for oy in -1..=1 {
                for ox in -1..=1 {
                    if !self.map.contains(cx + ox, cy + oy) {
                        continue;
                    }
                    for &u in self.units_in_cell(self.map.idx(cx + ox, cy + oy)) {
                        let u = u as usize;
                        let o = &self.actors[u];
                        if u == i || o.group != me.group || o.activity != Activity::Idle {
                            continue;
                        }
                        let orr = self.rules.actors[o.ty as usize].unit.as_ref().unwrap().radius;
                        if dist(x, y, o.x, o.y) <= rr + orr + 64 {
                            return true;
                        }
                    }
                }
            }
        }
        // Give up when no progress is made for a while near the goal.
        let a = &mut self.actors[i];
        if d < a.best_dist - 64 {
            a.best_dist = d;
            a.stuck_ticks = 0;
        } else {
            a.stuck_ticks += 1;
            if a.stuck_ticks > STUCK_LIMIT && d <= radius * 3 + 2 * CELL {
                return true;
            }
            if a.stuck_ticks > STUCK_LIMIT * 6 {
                return true;
            }
        }
        false
    }

    /// One movement step along the flow field toward `goal`.
    pub(crate) fn move_toward(&mut self, i: usize, goal: u32) {
        let (x, y) = (self.actors[i].x, self.actors[i].y);
        let ci = self.cell_index(x, y);
        let unit = self.rules.actors[self.actors[i].ty as usize].unit.clone().unwrap();
        let loco = unit.locomotor as u8;
        let domain = self.rules.locomotors[unit.locomotor].domain;
        if domain == crate::rules::Domain::Air {
            // Aircraft fly straight to their goal.
            let (gx, gy) = (cell_center(goal as i32 % self.map.width), cell_center(goal as i32 / self.map.width));
            self.step_toward(i, gx, gy, &unit);
            return;
        }
        let pass = if domain == crate::rules::Domain::Water { &self.pass_water } else { &self.pass };
        let dir = self.flow.dir(&self.map, pass, &self.rules.locomotors, goal, loco, ci);
        let (wx, wy) = if dir == DIR_GOAL {
            (cell_center(goal as i32 % self.map.width), cell_center(goal as i32 / self.map.width))
        } else if dir == DIR_NONE {
            // Standing on a blocked cell (e.g. a building was placed next to us)
            // or the field is unreachable: step to the nearest open cell.
            let comp_cell = (0..8).find_map(|d| {
                let (dx, dy) = DIRS[d];
                let (cx, cy) = self.cell_of(x, y);
                let (nx, ny) = (cx + dx, cy + dy);
                (self.map.contains(nx, ny) && !self.pass_for(domain).blocked[self.map.idx(nx, ny)]).then_some((nx, ny))
            });
            match comp_cell {
                Some((nx, ny)) => (cell_center(nx), cell_center(ny)),
                None => {
                    self.actors[i].activity = Activity::Idle;
                    return;
                }
            }
        } else {
            let (cx, cy) = self.cell_of(x, y);
            let (dx, dy) = DIRS[dir as usize];
            (cell_center(cx + dx), cell_center(cy + dy))
        };
        self.step_toward(i, wx, wy, &unit);
    }

    /// Turn and drive toward a world point, respecting turn rate and terrain speed.
    pub(crate) fn step_toward(&mut self, i: usize, wx: i32, wy: i32, unit: &crate::rules::UnitInfo) {
        let (x, y) = (self.actors[i].x, self.actors[i].y);
        let Some(desired) = facing_of(wx - x, wy - y) else { return };
        let ci = self.cell_index(x, y);
        let speed_pct = self.rules.locomotors[unit.locomotor].speeds[self.map.speed_class(ci)];
        let speed = unit.speed * speed_pct / 100;
        let turret_speed = self.rules.actors[self.actors[i].ty as usize].turret_turn_speed;
        let a = &mut self.actors[i];
        let has_turret = turret_speed.is_some();
        if unit.turn_in_place {
            a.facing = desired;
        } else {
            a.facing = turn_toward(a.facing, desired, unit.turn_speed);
            if angle_diff(a.facing, desired).abs() > MOVE_WHILE_TURNING {
                if has_turret && a.target == NONE {
                    a.turret = turn_toward(a.turret, a.facing, turret_speed.unwrap());
                }
                return;
            }
        }
        if has_turret && (a.target == NONE || a.activity != Activity::Attack) {
            a.turret = turn_toward(a.turret, a.facing, turret_speed.unwrap());
        }
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
            if to == from || d == crate::rules::Domain::Air || !self.pass_for(d).blocked[to] {
                let a = &mut self.actors[i];
                a.x = tx;
                a.y = ty;
                a.moved = true;
                return true;
            }
        }
        false
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
                if c == NONE || self.map.ore[c as usize] == 0 {
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
                if self.map.ore[c] > 0 {
                    self.map.ore[c] -= 1;
                    self.terrain_dirty = true;
                    self.actors[i].bales += 1;
                }
                let a = &mut self.actors[i];
                if a.bales >= hv.capacity {
                    a.harv = HarvState::ToDock;
                    a.best_dist = i32::MAX;
                    a.stuck_ticks = 0;
                } else if self.map.ore[c] == 0 {
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
                    a.bales -= 1;
                    let owner = a.owner;
                    let value = self.rules.player.ore_value;
                    self.give_resources(owner, value);
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
                if self.map.ore[c] == 0 || self.pass.blocked[c] || self.pass.component[c] != comp {
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
            self.actors[i].hp += step;
            self.uncloak_on(i, "Heal");
        }
    }

    // ---- Crowd separation --------------------------------------------------

    fn separate_units(&mut self) {
        self.rebuild_hash();
        let n = self.actors.len();
        let mut push = vec![(0i32, 0i32); n];
        let mut crushed: Vec<usize> = Vec::new();
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
                                    crushed.push(j);
                                    continue;
                                }
                                if b.moved && self.crushes(j, i) {
                                    crushed.push(i);
                                    continue;
                                }
                            }
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
                        // Moving units push idle friends aside; enemies are walls to each other.
                        let (wa, wb) = match (a.moved, b.moved, !self.are_enemies(a.owner, b.owner)) {
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
        for k in crushed {
            if self.actors[k].alive {
                self.kill(k);
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

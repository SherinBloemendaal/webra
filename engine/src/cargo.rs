//! Transports: OpenRA `Cargo` and `Passenger` (APC, Ranger, Phase Transport,
//! Transport ship (LST), and the Chinook in helicopter.rs).
//!
//! A passenger may enter a transport when its `Passenger.CargoType` is in the
//! transport's `Cargo.Types` and its `Passenger.Weight` still fits under
//! `Cargo.MaxWeight`. Passengers are out of the world while inside: they are
//! not ticked, not in the spatial hash (so they cannot be hit or targeted),
//! not drawn, give no vision and cannot be ordered; their position follows the
//! transport. They die with the transport unless `Cargo.EjectOnDeath` is set,
//! and get out when the transport is removed (`Cargo.EjectOnSell`).
//!
//! # Public API (used by the orders here and by other unit modules)
//!
//! - [`World::can_enter`]`(p, t)`: whether unit `p` may get into transport `t` now.
//! - [`World::is_transport`]`(t)`, [`World::cargo_weight`]`(t)`, [`World::cargo_max`]`(t)`,
//!   [`World::passengers`]`(t)`: transport state.
//! - [`World::order_load`]`(units, t)`: units walk to `t` and board it
//!   (`Activity::Board`); the transport stops and waits. A passenger enters
//!   when it is within reach of the transport and the transport is on the
//!   ground (`altitude == 0`), so an aircraft transport must land first.
//! - [`World::load_passenger`]`(t, p)`: put `p` inside `t` immediately.
//! - [`World::can_unload`]`(t)` / [`World::order_unload`]`(t)`: unload all
//!   passengers (`Activity::Unload`): BeforeUnloadDelay, then one passenger
//!   per tick onto a free cell next to the transport (cells of the
//!   passenger's own domain, so an LST unloads onto the shore), then
//!   AfterUnloadDelay. Unloading waits while the transport is airborne.
//! - [`World::exit_cell`]`(t, p)` and [`World::unload_passenger`]`(t, cell)`:
//!   the single steps, for transports with their own unload logic.
//!
//! The Deploy order (hotkey D, sidebar Deploy) unloads a loaded transport.

use crate::math::{dist, facing_of, CELL, HALF_CELL};
use crate::rules::{CargoInfo, Domain, Kind};
use crate::world::{cell_center, Activity, World, NONE};

/// Ticks between retries when every exit cell is blocked (OpenRA UnloadCargo waits 10).
const BLOCKED_RETRY: i32 = 10;
/// Rings of cells around a transport searched for exit cells.
const EXIT_RINGS: i32 = 2;

impl World {
    // ---- Queries ---------------------------------------------------------------

    /// Cargo trait of actor `t`, if it is a transport (garrisoned defences are not).
    fn cargo_info(&self, t: usize) -> Option<&CargoInfo> {
        self.rules.actors[self.actors[t].ty as usize].abilities.cargo.as_ref().filter(|c| !c.garrison)
    }

    /// Whether actor `t` carries passengers (has a non-garrison Cargo).
    pub fn is_transport(&self, t: usize) -> bool {
        self.cargo_info(t).is_some()
    }

    /// Cargo.MaxWeight of transport `t` (0 for other actors).
    pub fn cargo_max(&self, t: usize) -> i32 {
        self.cargo_info(t).map_or(0, |c| c.max)
    }

    /// Passengers of `t` (actor indices), in loading order.
    pub fn passengers(&self, t: usize) -> Vec<usize> {
        self.actors[t].cargo.iter().filter_map(|&r| self.resolve(r)).collect()
    }

    fn passenger_weight(&self, p: usize) -> i32 {
        self.rules.actors[self.actors[p].ty as usize].unit.as_ref().map_or(1, |u| u.passenger_weight)
    }

    /// Total Passenger.Weight inside `t`.
    pub fn cargo_weight(&self, t: usize) -> i32 {
        self.passengers(t).iter().map(|&p| self.passenger_weight(p)).sum()
    }

    /// Whether `p`'s cargo type fits transport `t` at all (ignoring free room).
    fn cargo_type_fits(&self, p: usize, t: usize) -> bool {
        let Some(c) = self.cargo_info(t) else { return false };
        let Some(pt) = self.rules.actors[self.actors[p].ty as usize].unit.as_ref().and_then(|u| u.passenger.as_ref()) else { return false };
        c.types.iter().any(|ty| ty == pt) && self.passenger_weight(p) <= c.max
    }

    /// Whether unit `p` may get into transport `t` right now: same owner, both
    /// in the world, a matching cargo type and enough free weight.
    pub fn can_enter(&self, p: usize, t: usize) -> bool {
        if p == t {
            return false;
        }
        let (pa, ta) = (&self.actors[p], &self.actors[t]);
        if !pa.alive || !ta.alive || !pa.in_world() || !ta.in_world() || pa.owner != ta.owner || pa.kind == Kind::Building {
            return false;
        }
        self.cargo_type_fits(p, t) && self.cargo_weight(t) + self.passenger_weight(p) <= self.cargo_max(t)
    }

    // ---- Loading ------------------------------------------------------------------

    /// Smart "enter" order: units that fit walk to `t` and board it, the rest
    /// move next to it. The transport stops and waits for them.
    pub fn order_load(&mut self, units: &[usize], t: usize) {
        let (boarders, others): (Vec<usize>, Vec<usize>) =
            units.iter().copied().filter(|&u| u != t && self.actors[u].in_world()).partition(|&u| self.cargo_type_fits(u, t));
        let tref = self.make_ref(t);
        for &u in &boarders {
            self.release_dock(u);
            let a = &mut self.actors[u];
            a.activity = Activity::Board;
            a.board_target = tref;
            a.target = NONE;
            a.attack_move = false;
            a.goal = NONE;
            a.chase_cell = NONE;
            a.group_size = 1;
            a.best_dist = i32::MAX;
            a.stuck_ticks = 0;
        }
        if !boarders.is_empty() && self.actors[t].activity == Activity::Move {
            self.actors[t].activity = Activity::Idle;
            self.actors[t].goal = NONE;
        }
        let (x, y) = (self.actors[t].x, self.actors[t].y);
        self.order_move(&others, x, y, false);
    }

    /// Distance at which `p` can step into `t`: touching for vehicles, the
    /// adjacent shore cell for ships and other cross-domain transports.
    fn boarding_reach(&self, p: usize, t: usize) -> i32 {
        let radius = |i: usize| self.rules.actors[self.actors[i].ty as usize].unit.as_ref().map_or(0, |u| u.radius);
        let reach = radius(p) + radius(t) + HALF_CELL;
        if self.domain_of(p) != self.domain_of(t) {
            reach.max(CELL * 3 / 2)
        } else {
            reach
        }
    }

    /// Activity::Board: chase the transport and get in once within reach.
    pub(crate) fn tick_board(&mut self, i: usize) {
        let Some(t) = self.resolve(self.actors[i].board_target).filter(|&t| self.can_enter(i, t)) else {
            self.stop_boarding(i);
            return;
        };
        let (x, y) = (self.actors[i].x, self.actors[i].y);
        let (tx, ty) = (self.actors[t].x, self.actors[t].y);
        let in_reach = dist(x, y, tx, ty) <= self.boarding_reach(i, t);
        if in_reach && self.actors[t].altitude == 0 {
            self.load_passenger(t, i);
            return;
        }
        if in_reach {
            return; // wait for the aircraft to land
        }
        // Path toward the transport's cell (or the nearest reachable cell, e.g. the shore).
        let (tcx, tcy) = self.cell_of(tx, ty);
        let tcell = self.map.idx(tcx, tcy) as u32;
        if self.chase_replan(i, tcell) {
            let goal = self.path_goal(i, tcx, tcy);
            let a = &mut self.actors[i];
            a.chase_cell = tcell;
            a.goal = goal;
            a.best_dist = i32::MAX;
            a.stuck_ticks = 0;
        }
        let goal = self.actors[i].goal;
        if goal == NONE {
            self.stop_boarding(i);
            return;
        }
        if self.at_cell_center(i, goal) || self.goal_reached(i, goal, 0, false) {
            // As close as this unit gets: wait while the transport is still coming, else give up.
            if !matches!(self.actors[t].activity, Activity::Move) {
                self.stop_boarding(i);
            }
            return;
        }
        self.move_toward(i, goal);
    }

    fn stop_boarding(&mut self, i: usize) {
        let a = &mut self.actors[i];
        a.activity = Activity::Idle;
        a.board_target = NONE;
        a.goal = NONE;
    }

    /// Put `p` inside `t` immediately. Returns false when it cannot enter.
    pub fn load_passenger(&mut self, t: usize, p: usize) -> bool {
        if !self.can_enter(p, t) {
            return false;
        }
        self.release_dock(p);
        // Cloaked transports (Phase Transport) show themselves while loading.
        self.uncloak_on(t, "Load");
        let (tref, pref) = (self.make_ref(t), self.make_ref(p));
        let (x, y) = (self.actors[t].x, self.actors[t].y);
        self.actors[t].cargo.push(pref);
        let a = &mut self.actors[p];
        a.carrier = tref;
        a.board_target = NONE;
        a.activity = Activity::Idle;
        a.target = NONE;
        a.goal = NONE;
        a.attack_move = false;
        a.x = x;
        a.y = y;
        a.px = x;
        a.py = y;
        self.script_event(crate::mission::ScriptEvent::PassengerEntered { transport: tref, passenger: pref });
        true
    }

    // ---- Unloading ------------------------------------------------------------------

    /// Whether `t` has passengers and a free cell for the next one to get out.
    pub fn can_unload(&self, t: usize) -> bool {
        let a = &self.actors[t];
        if !a.alive || !a.in_world() || !self.is_transport(t) {
            return false;
        }
        match self.passengers(t).last() {
            Some(&p) => self.exit_cell(t, p).is_some(),
            None => false,
        }
    }

    /// Whether `t` is a transport with someone inside.
    pub fn has_passengers(&self, t: usize) -> bool {
        self.is_transport(t) && !self.passengers(t).is_empty()
    }

    /// Unload every passenger of `t` (Deploy order on a loaded transport).
    pub fn order_unload(&mut self, t: usize) {
        if !self.has_passengers(t) {
            return;
        }
        let delay = self.cargo_info(t).map_or(0, |c| c.before_unload_delay);
        self.release_dock(t);
        let a = &mut self.actors[t];
        a.activity = Activity::Unload;
        a.unload_timer = delay;
        a.target = NONE;
        a.goal = NONE;
        a.attack_move = false;
    }

    /// Activity::Unload: wait BeforeUnloadDelay, let one passenger out per tick,
    /// then wait AfterUnloadDelay. Blocked exits are retried every 10 ticks.
    pub(crate) fn tick_unload(&mut self, t: usize) {
        if self.actors[t].altitude > 0 {
            return; // an aircraft transport lands first (helicopter.rs)
        }
        let live: Vec<u32> = self.actors[t].cargo.iter().copied().filter(|&r| self.resolve(r).is_some()).collect();
        self.actors[t].cargo = live;
        if self.actors[t].unload_timer > 0 {
            self.actors[t].unload_timer -= 1;
            return;
        }
        let Some(&p) = self.passengers(t).last() else {
            self.actors[t].activity = Activity::Idle;
            return;
        };
        match self.exit_cell(t, p) {
            Some(c) => {
                self.unload_passenger(t, c);
                if self.actors[t].cargo.is_empty() {
                    self.actors[t].unload_timer = self.cargo_info(t).map_or(0, |c| c.after_unload_delay);
                }
            }
            None => self.actors[t].unload_timer = BLOCKED_RETRY,
        }
    }

    /// A free cell next to `t` where passenger `p` can stand: passable for
    /// `p`'s domain (land next to a ship), without units of that domain on it
    /// or heading to it. Nearest first, then lowest index (deterministic).
    pub fn exit_cell(&self, t: usize, p: usize) -> Option<usize> {
        let d = self.domain_of(p);
        if d == Domain::Air {
            return None;
        }
        let pass = self.pass_of(p);
        let (tcx, tcy) = self.cell_of(self.actors[t].x, self.actors[t].y);
        for r in 1..=EXIT_RINGS {
            let mut cands: Vec<(i32, usize)> = Vec::new();
            for y in tcy - r..=tcy + r {
                for x in tcx - r..=tcx + r {
                    if (x - tcx).abs() != r && (y - tcy).abs() != r {
                        continue;
                    }
                    if !self.map.contains(x, y) {
                        continue;
                    }
                    let ci = self.map.idx(x, y);
                    if !pass.blocked[ci] {
                        cands.push(((x - tcx).pow(2) + (y - tcy).pow(2), ci));
                    }
                }
            }
            cands.sort_unstable();
            if let Some(&(_, c)) = cands.iter().find(|&&(_, c)| self.exit_cell_free(t, c, d)) {
                return Some(c);
            }
        }
        None
    }

    fn exit_cell_free(&self, t: usize, c: usize, d: Domain) -> bool {
        if self.units_in_cell(c).iter().any(|&u| self.actors[u as usize].alive && self.domain_of(u as usize) == d) {
            return false;
        }
        // Passengers that just got out and are still walking to their cell.
        let (tcx, tcy) = self.cell_of(self.actors[t].x, self.actors[t].y);
        for y in tcy - EXIT_RINGS - 1..=tcy + EXIT_RINGS + 1 {
            for x in tcx - EXIT_RINGS - 1..=tcx + EXIT_RINGS + 1 {
                if !self.map.contains(x, y) {
                    continue;
                }
                for &u in self.units_in_cell(self.map.idx(x, y)) {
                    let a = &self.actors[u as usize];
                    if a.alive && a.activity == Activity::Move && a.goal == c as u32 {
                        return false;
                    }
                }
            }
        }
        true
    }

    /// Let the last passenger of `t` out toward `cell`. Returns it.
    pub fn unload_passenger(&mut self, t: usize, cell: usize) -> Option<usize> {
        let r = self.actors[t].cargo.pop()?;
        self.uncloak_on(t, "Unload");
        let p = self.resolve(r)?;
        let (tx, ty) = (self.actors[t].x, self.actors[t].y);
        let (gx, gy) = (cell_center(cell as i32 % self.map.width), cell_center(cell as i32 / self.map.width));
        // Get out at the transport, or, where the passenger cannot stand (a
        // ship on water), at the edge of the exit cell facing the transport.
        let (x, y) = if self.pass_of(p).blocked[self.cell_index(tx, ty)] {
            let len = dist(gx, gy, tx, ty).max(1);
            let k = len.min(HALF_CELL - 64);
            (gx + (tx - gx) * k / len, gy + (ty - gy) * k / len)
        } else {
            (tx, ty)
        };
        {
            let a = &mut self.actors[p];
            a.carrier = NONE;
            a.x = x;
            a.y = y;
            a.px = x;
            a.py = y;
            if let Some(f) = facing_of(gx - x, gy - y) {
                a.facing = f;
                a.pfacing = f;
            }
        }
        self.order_move(&[p], gx, gy, false);
        let (transport, passenger) = (self.make_ref(t), r);
        self.script_event(crate::mission::ScriptEvent::PassengerExited { transport, passenger });
        Some(p)
    }

    // ---- Upkeep -------------------------------------------------------------------

    /// Passengers ride along: keep their position on the transport.
    pub(crate) fn tick_cargo(&mut self, t: usize) {
        let (x, y) = (self.actors[t].x, self.actors[t].y);
        for p in self.passengers(t) {
            let a = &mut self.actors[p];
            a.x = x;
            a.y = y;
            a.px = x;
            a.py = y;
        }
    }

    /// The transport died: passengers die with it, unless Cargo.EjectOnDeath.
    pub(crate) fn cargo_on_death(&mut self, t: usize) {
        if self.actors[t].cargo.is_empty() {
            return;
        }
        let eject = self.cargo_info(t).is_some_and(|c| c.eject_on_death);
        self.empty_cargo(t, eject);
    }

    /// The transport left the world without dying (sold, transformed): passengers get out (Cargo.EjectOnSell).
    pub(crate) fn cargo_on_remove(&mut self, t: usize) {
        if self.actors[t].cargo.is_empty() {
            return;
        }
        let eject = self.cargo_info(t).is_none_or(|c| c.eject_on_sell);
        self.empty_cargo(t, eject);
    }

    fn empty_cargo(&mut self, t: usize, eject: bool) {
        let (x, y) = (self.actors[t].x, self.actors[t].y);
        let refs = std::mem::take(&mut self.actors[t].cargo);
        let tref = self.make_ref(t);
        for r in refs {
            let Some(p) = self.resolve(r) else { continue };
            self.script_event(crate::mission::ScriptEvent::PassengerExited { transport: tref, passenger: r });
            let a = &mut self.actors[p];
            a.carrier = NONE;
            a.x = x;
            a.y = y;
            a.px = x;
            a.py = y;
            a.activity = Activity::Idle;
            // Ejected passengers need ground of their own domain under them.
            let ci = self.cell_index(x, y);
            let d = self.domain_of(p);
            if eject && (d == Domain::Air || !self.pass_of(p).blocked[ci]) {
                continue;
            }
            self.kill(p);
        }
    }
}

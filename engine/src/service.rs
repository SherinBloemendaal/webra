//! The service depot's line (WebRA addition over OpenRA's Repairable,
//! Resupply and Reservable).
//!
//! OpenRA serves one unit at a time on a service depot's pad, but has no
//! line: vehicles sent there together crowd around the pad and push for it
//! (MoveCooldownHelper retries, some give up when their move ends short),
//! and an aircraft cannot even be ordered to a depot another aircraft has
//! reserved (Aircraft.ResolveOrder checks Reservable.IsAvailableFor). WebRA
//! keeps a line per depot instead, first come first served:
//!
//! - A unit sent to repair drives (or flies) toward the depot. Within
//!   `JOIN_RANGE` cells of the pad it joins the line: its ticket is the tick
//!   it arrived, ties by actor index, so the order is the same on every
//!   machine.
//! - Ground units wait on a cell of their own around the depot (`pick_slot`):
//!   the nearest ring outside the footprint first, never on the four
//!   corridors straight out of the pad (the way on and off it), never on a
//!   cell another unit waits on or stands on. Helicopters hover over every
//!   other cell of the rings from `AIR_FIRST_RING` out, planes circle the
//!   depot.
//! - When the pad is free the first unit in line is called (it reserves the
//!   pad, `dock_user`), drives or lands onto it and is repaired to full,
//!   paying as OpenRA's RepairsUnits does (units.rs `repair_step`); without
//!   money it stays on the pad and tries again, as in OpenRA, and the line
//!   waits.
//! - Done, it leaves for the depot's rally point when it has one (OpenRA
//!   Resupply, `RallyPoint`); else ground units and helicopters move to the
//!   nearest free spot next to the depot out of the corridors and waiting
//!   cells (OpenRA moves them just off the pad), planes take off and circle
//!   (OpenRA TakeOff, FlyIdle). Leaving frees the pad for the next in line.
//! - A unit that no longer needs repair (healed by a mechanic, say) leaves
//!   the line and stops. When the depot is destroyed, sold or captured,
//!   everyone in its line stops where it is; aircraft on its pad take off.
//!
//! Tickets and waiting cells are simulation state (part of the state hash).

use crate::math::{dist, CELL};
use crate::rules::Kind;
use crate::world::{Activity, World, NONE};

/// Within this many cells of the pad a unit on its way joins the line.
pub const JOIN_RANGE: i32 = 6;
/// Rings of waiting cells around the pad (Chebyshev distance), ground units.
const SLOT_FIRST_RING: i32 = 2;
const SLOT_LAST_RING: i32 = 8;
/// The corridors straight out of the pad stay free this far.
const CORRIDOR: i32 = 3;
/// Rings helicopters hover over while they wait (every other cell, so two
/// waiting helicopters never touch), from OpenRA's WaitDistanceFromResupplyBase.
const AIR_FIRST_RING: i32 = 4;
const AIR_LAST_RING: i32 = 10;
/// How far from the pad a repaired unit looks for a free spot.
const PARK_SEARCH: i32 = 12;

/// A unit's place in a service depot's line.
#[derive(Clone, Copy, Debug)]
pub struct ServiceState {
    /// Place in line: the tick it joined in the high half, its actor index in
    /// the low half; 0 while it is still on its way.
    pub ticket: u64,
    /// The cell it waits on (ground) or hovers over (helicopters), or NONE.
    pub slot: u32,
}

impl Default for ServiceState {
    fn default() -> Self {
        ServiceState { ticket: 0, slot: NONE }
    }
}

impl ServiceState {
    pub fn mix(&self, mix: &mut impl FnMut(i64)) {
        mix(self.ticket as i64);
        mix(self.slot as i64);
    }
}

impl World {
    /// The depot unit `i` is being repaired at, while it can still serve it:
    /// alive, in the world, its owner's, a structure that repairs units.
    pub(crate) fn service_depot(&self, i: usize) -> Option<usize> {
        let d = self.resolve(self.actors[i].depot)?;
        let b = &self.actors[d];
        let ok = b.alive
            && b.in_world()
            && b.kind == Kind::Building
            && b.owner == self.actors[i].owner
            && self.rules.actors[b.ty as usize].building.as_ref().is_some_and(|bi| bi.repairs.is_some());
        ok.then_some(d)
    }

    /// The unit called to depot `d`'s pad (on its way or being served).
    pub(crate) fn pad_holder(&self, d: usize) -> Option<usize> {
        let u = self.resolve(self.actors[d].dock_user)?;
        let a = &self.actors[u];
        (a.alive && a.activity == Activity::Repair && a.depot == self.make_ref(d)).then_some(u)
    }

    /// The cell in the middle of the pad of service depot `d`, where
    /// vehicles are repaired, helicopters and planes land and minelayers rearm.
    pub(crate) fn repair_pad_cell(&self, d: usize) -> u32 {
        let depot = &self.actors[d];
        let binfo = self.rules.actors[depot.ty as usize].building.as_ref().unwrap();
        self.map.idx(depot.cx + binfo.width / 2, depot.cy + binfo.height / 2) as u32
    }

    /// The world point in the middle of depot `d`'s pad.
    pub(crate) fn repair_pad_point(&self, d: usize) -> (i32, i32) {
        self.cell_point(self.repair_pad_cell(d))
    }

    /// Whether unit `i` holds its depot's pad (called to it or on it): the
    /// crowd does not push it aside.
    pub(crate) fn on_repair_pad(&self, i: usize) -> bool {
        let a = &self.actors[i];
        a.activity == Activity::Repair && self.resolve(a.depot).is_some_and(|d| self.actors[d].dock_user == self.make_ref(i))
    }

    /// Whether unit `i` stands on its waiting cell in a service depot's line
    /// (the WebRA model does not push it, movement/soft.rs).
    pub(crate) fn waits_on_slot(&self, i: usize) -> bool {
        let a = &self.actors[i];
        a.activity == Activity::Repair && a.svc.slot != NONE && a.kind != Kind::Aircraft && self.at_cell_center(i, a.svc.slot)
    }

    /// Whether minelayer `i` reloads at depot `d` and has mines to load
    /// (OpenRA Rearmable RearmActors: the service depot).
    fn rearms_at_depot(&self, i: usize, d: usize) -> bool {
        let a = &self.actors[i];
        let id = &self.rules.actors[self.actors[d].ty as usize].id;
        self.rules.actors[a.ty as usize]
            .abilities
            .minelayer
            .as_ref()
            .is_some_and(|ml| a.ab.ammo < ml.ammo && ml.rearm_actors.iter().any(|r| r.eq_ignore_ascii_case(id)))
    }

    /// Whether unit `i` has anything to get at depot `d`: hit points, or
    /// mines (OpenRA Resupply: repair and rearm). Without either OpenRA
    /// ignores the Repair order.
    pub(crate) fn needs_service(&self, i: usize, d: usize) -> bool {
        let a = &self.actors[i];
        a.hp < self.rules.actors[a.ty as usize].hp || self.rearms_at_depot(i, d)
    }

    /// Unit `i` gets in line at its depot.
    pub(crate) fn join_service_line(&mut self, i: usize) {
        let a = &mut self.actors[i];
        if a.svc.ticket == 0 {
            a.svc.ticket = ((self.tick as u64) << 32) | i as u64;
        }
    }

    /// The first unit in depot `d`'s line (lowest ticket).
    fn next_in_line(&self, d: usize) -> Option<usize> {
        let dref = self.make_ref(d);
        let mut best: Option<(u64, usize)> = None;
        for (j, a) in self.actors.iter().enumerate() {
            if a.alive
                && a.activity == Activity::Repair
                && a.depot == dref
                && a.svc.ticket != 0
                && best.is_none_or(|(t, _)| a.svc.ticket < t)
            {
                best = Some((a.svc.ticket, j));
            }
        }
        best.map(|(_, j)| j)
    }

    /// Call unit `i` to depot `d`'s pad when it is free and `i` is first in
    /// line. True when `i` holds the pad now.
    pub(crate) fn call_to_pad(&mut self, i: usize, d: usize) -> bool {
        if self.pad_holder(d).is_some() || self.next_in_line(d) != Some(i) {
            return false;
        }
        self.actors[d].dock_user = self.make_ref(i);
        let a = &mut self.actors[i];
        a.svc.slot = NONE;
        a.best_dist = i32::MAX;
        a.stuck_ticks = 0;
        a.stall_ticks = 0;
        true
    }

    /// Unit `i` leaves the line without being served (nothing to repair, the
    /// depot gone, the pad out of reach): it stops where it is.
    pub(crate) fn end_service(&mut self, i: usize) {
        self.release_dock(i);
        let a = &mut self.actors[i];
        a.activity = Activity::Idle;
        a.target = NONE;
        // A helicopter on the pad takes off again (OpenRA Resupply with the
        // host gone: TakeOff); tick_plane does the same for planes.
        if a.kind == Kind::Aircraft {
            a.heli.landed = false;
        }
    }

    /// Unit `i` is done at depot `d`: FinishRepairingNotification, then off
    /// to the rally point, or to a free spot next to the depot (ground units
    /// and helicopters). Planes without a rally point fly home (plane.rs).
    /// The move frees the pad (`release_dock`).
    pub(crate) fn leave_depot(&mut self, i: usize, d: usize) {
        self.note_repaired(i, d);
        if let Some((rx, ry)) = self.actors[d].rally {
            self.order_move(&[i], rx, ry, false);
            // OpenRA Resupply: MoveTo(rally point, 1).
            self.actors[i].mv.order_near = 1;
            return;
        }
        if self.is_plane(i) {
            return; // takes off for an airfield (plane.rs)
        }
        let c = self.park_cell(i, d);
        let (x, y) = self.cell_point(c);
        self.order_move(&[i], x, y, false);
        self.actors[i].mv.order_near = 0;
    }

    // ---- Where to wait --------------------------------------------------------------

    /// Offset of cell `c` from depot `d`'s pad.
    fn pad_offset(&self, d: usize, c: u32) -> (i32, i32) {
        let pad = self.repair_pad_cell(d);
        let w = self.map.width;
        (c as i32 % w - pad as i32 % w, c as i32 / w - pad as i32 / w)
    }

    /// Whether cell `c` lies on one of the corridors straight out of depot
    /// `d`'s pad that stay free (the way on and off the pad).
    fn in_corridor(&self, d: usize, c: u32) -> bool {
        let (dx, dy) = self.pad_offset(d, c);
        (dx == 0 || dy == 0) && dx.abs().max(dy.abs()) <= CORRIDOR
    }

    /// Whether a ground unit or landed aircraft other than `i` stands on cell `c`.
    fn someone_stands_on(&self, i: usize, c: u32) -> bool {
        self.units_in_cell(c as usize).iter().any(|&u| {
            let u = u as usize;
            let o = &self.actors[u];
            u != i && o.alive && o.altitude == 0 && !o.moved
        })
    }

    /// Whether a helicopter other than `i` hovers close enough to cell `c`'s
    /// centre that `i` would touch it there.
    fn someone_hovers_over(&self, i: usize, c: u32) -> bool {
        let (x, y) = self.cell_point(c);
        let (cx, cy) = self.cell_of(x, y);
        let r = self.rules.actors[self.actors[i].ty as usize].unit.as_ref().map_or(0, |u| u.radius);
        for oy in -1..=1 {
            for ox in -1..=1 {
                if !self.map.contains(cx + ox, cy + oy) {
                    continue;
                }
                for &u in self.units_in_cell(self.map.idx(cx + ox, cy + oy)) {
                    let u = u as usize;
                    let o = &self.actors[u];
                    if u == i || !o.alive || o.kind != Kind::Aircraft || o.altitude == 0 || self.is_plane(u) {
                        continue;
                    }
                    let ro = self.rules.actors[o.ty as usize].unit.as_ref().map_or(0, |u| u.radius);
                    if dist(o.x, o.y, x, y) < r + ro {
                        return true;
                    }
                }
            }
        }
        false
    }

    /// Whether ground unit `i` may wait (or park) on cell `c` near depot `d`
    /// now: open ground it can reach from the pad, no structure, out of the
    /// corridors, nobody standing there.
    fn ground_spot_open(&self, i: usize, d: usize, c: u32) -> bool {
        let pass = self.pass_of(i);
        let pad = self.repair_pad_cell(d) as usize;
        !pass.blocked[c as usize]
            && pass.component[c as usize] == pass.component[pad]
            && self.building_at[c as usize] == NONE
            && !self.in_corridor(d, c)
            && !self.someone_stands_on(i, c)
    }

    /// Whether another unit in a service line waits on (or over) cell `c`.
    fn slot_taken(&self, i: usize, c: u32, air: bool) -> bool {
        self.actors
            .iter()
            .enumerate()
            .any(|(j, o)| j != i && o.alive && o.activity == Activity::Repair && o.svc.slot == c && (o.kind == Kind::Aircraft) == air)
    }

    /// Cells of the ring at Chebyshev distance `r` around depot `d`'s pad, on the map.
    fn ring(&self, d: usize, r: i32) -> Vec<u32> {
        let pad = self.repair_pad_cell(d) as i32;
        let (px, py) = (pad % self.map.width, pad / self.map.width);
        let mut out = Vec::new();
        for dy in -r..=r {
            for dx in -r..=r {
                if dx.abs().max(dy.abs()) == r && self.map.contains(px + dx, py + dy) {
                    out.push(self.map.idx(px + dx, py + dy) as u32);
                }
            }
        }
        out
    }

    /// The cell unit `i` waits on for its turn at depot `d`: the nearest
    /// ring with an open cell no one else waits on, there the cell nearest
    /// the unit (ties to the lower cell index). Helicopters hover over every
    /// other cell of the outer rings. NONE when there is none (it waits
    /// where it is).
    pub(crate) fn pick_slot(&self, i: usize, d: usize) -> u32 {
        let air = self.actors[i].kind == Kind::Aircraft;
        let (first, last, step) = if air { (AIR_FIRST_RING, AIR_LAST_RING, 2) } else { (SLOT_FIRST_RING, SLOT_LAST_RING, 1) };
        let (x, y) = (self.actors[i].x, self.actors[i].y);
        let mut r = first;
        while r <= last {
            let mut best: Option<(i64, u32)> = None;
            for c in self.ring(d, r) {
                if air {
                    let (dx, dy) = self.pad_offset(d, c);
                    if dx % 2 != 0 || dy % 2 != 0 || self.someone_hovers_over(i, c) {
                        continue;
                    }
                } else if !self.ground_spot_open(i, d, c) {
                    continue;
                }
                if self.slot_taken(i, c, air) {
                    continue;
                }
                let (cx, cy) = self.cell_point(c);
                let key = (crate::math::dist_sq(x, y, cx, cy), c);
                if best.is_none_or(|b| key < b) {
                    best = Some(key);
                }
            }
            if let Some((_, c)) = best {
                return c;
            }
            r += step;
        }
        NONE
    }

    /// Where unit `i`, repaired at depot `d` without a rally point (or idle in
    /// the way onto its pad), goes: the nearest free cell next to the depot
    /// it can drive to without passing a standing unit, south first (where
    /// WebRA's units always left the depot), out of the corridors and the
    /// cells others wait on, and not the goal of another unit. Helicopters
    /// look for a cell no other helicopter hovers over. Falls back to the
    /// cell below the depot.
    fn park_cell(&mut self, i: usize, d: usize) -> u32 {
        // South first, then the diagonals and sides, north last.
        const ORDER: [(i32, i32); 8] = [(0, 1), (-1, 1), (1, 1), (-1, 0), (1, 0), (-1, -1), (1, -1), (0, -1)];
        let air = self.actors[i].kind == Kind::Aircraft;
        let pad = self.repair_pad_cell(d) as i32;
        let w = self.map.width;
        let (px, py) = (pad % w, pad / w);
        let below = self.map.idx(px, (py + 2).min(self.map.height - 1)) as u32;
        let start = self.cell_index(self.actors[i].x, self.actors[i].y);
        let mut seen = vec![false; self.map.cells()];
        let mut queue = std::collections::VecDeque::new();
        seen[start] = true;
        queue.push_back(start as u32);
        while let Some(c) = queue.pop_front() {
            let (dx, dy) = self.pad_offset(d, c);
            if dx.abs().max(dy.abs()) >= SLOT_FIRST_RING && self.park_open(i, d, c, air) {
                return c;
            }
            let (cx, cy) = (c as i32 % w, c as i32 / w);
            for (sx, sy) in ORDER {
                let (nx, ny) = (cx + sx, cy + sy);
                if !self.map.contains(nx, ny) || (nx - px).abs().max((ny - py).abs()) > PARK_SEARCH {
                    continue;
                }
                let n = self.map.idx(nx, ny);
                if seen[n] || (!air && (self.pass_of(i).blocked[n] || self.someone_stands_on(i, n as u32))) {
                    continue;
                }
                seen[n] = true;
                queue.push_back(n as u32);
            }
        }
        below
    }

    /// Whether repaired unit `i` may park on cell `c` near depot `d`.
    fn park_open(&self, i: usize, d: usize, c: u32, air: bool) -> bool {
        if self.slot_taken(i, c, air) {
            return false;
        }
        let ground = !air;
        // Another unit already on its way there.
        let claimed = self
            .actors
            .iter()
            .enumerate()
            .any(|(j, o)| j != i && o.alive && o.activity == Activity::Move && o.goal == c && (o.kind == Kind::Aircraft) == air);
        if claimed {
            return false;
        }
        if ground {
            return self.ground_spot_open(i, d, c);
        }
        // Helicopters: every other cell (two hovering helicopters never
        // touch), nobody hovering over it.
        let (dx, dy) = self.pad_offset(d, c);
        dx % 2 == 0 && dy % 2 == 0 && !self.someone_hovers_over(i, c)
    }

    /// An idle ground unit standing in the way onto an own service depot's
    /// pad while a unit holds it (on a corridor straight out of the pad, or
    /// on the footprint) moves to a free spot next to the depot, as a unit
    /// leaving the pad would. True when it moves. Spread over the ticks:
    /// each unit looks every eighth tick.
    pub(crate) fn clear_service_way(&mut self, i: usize) -> bool {
        if !(self.tick as usize + i).is_multiple_of(8) {
            return false;
        }
        let a = &self.actors[i];
        if a.altitude != 0 || !matches!(a.kind, Kind::Vehicle | Kind::Infantry) {
            return false;
        }
        let (cx, cy) = self.cell_of(a.x, a.y);
        let owner = a.owner;
        let mut depot = None;
        'look: for (sx, sy) in [(0, 1), (1, 0), (0, -1), (-1, 0), (0, 0)] {
            for k in 0..=CORRIDOR {
                let (x, y) = (cx + sx * k, cy + sy * k);
                if !self.map.contains(x, y) {
                    break;
                }
                let b = self.building_at[self.map.idx(x, y)];
                if b == NONE {
                    continue;
                }
                let b = b as usize;
                let ba = &self.actors[b];
                let depot_here = ba.owner == owner
                    && self.rules.actors[ba.ty as usize].building.as_ref().is_some_and(|bi| bi.repairs.is_some())
                    && self.pad_holder(b).is_some_and(|h| h != i);
                if depot_here {
                    let here = self.map.idx(cx, cy) as u32;
                    if self.building_at[here as usize] != NONE || self.in_corridor(b, here) {
                        depot = Some(b);
                        break 'look;
                    }
                }
            }
        }
        let Some(d) = depot else { return false };
        let c = self.park_cell(i, d);
        let (x, y) = self.cell_point(c);
        self.order_move(&[i], x, y, false);
        self.actors[i].mv.order_near = 0;
        true
    }

    // ---- Ground units ---------------------------------------------------------------

    /// One tick of a ground unit with the Repair activity (vehicles at the
    /// service depot; helicopters and planes have their own, helicopter.rs
    /// and plane.rs).
    pub(crate) fn tick_repair(&mut self, i: usize) {
        let Some(d) = self.service_depot(i) else {
            self.end_service(i);
            return;
        };
        let pad = self.repair_pad_cell(d);
        if self.pad_holder(d) == Some(i) {
            self.service_on_pad(i, d, pad);
            return;
        }
        if !self.needs_service(i, d) {
            self.end_service(i);
            return;
        }
        if self.actors[i].svc.ticket == 0 && !self.approach_depot(i, pad) {
            return;
        }
        if self.call_to_pad(i, d) {
            self.service_on_pad(i, d, pad);
            return;
        }
        self.wait_in_line(i, d);
    }

    /// Unit `i` on its way to its depot's `pad`: joins the line within `JOIN_RANGE`
    /// of the pad (or where it stops short of it), gives up when the pad
    /// cannot be reached. True once in line.
    fn approach_depot(&mut self, i: usize, pad: u32) -> bool {
        let (px, py) = self.cell_point(pad);
        if dist(self.actors[i].x, self.actors[i].y, px, py) <= JOIN_RANGE * CELL {
            self.join_service_line(i);
            return true;
        }
        if self.goal_reached(i, pad, 0, false) {
            if !self.pad_reachable(i, pad) {
                self.end_service(i);
                return false;
            }
            // Held up by others on the way: wait in line from here.
            self.join_service_line(i);
            return true;
        }
        self.move_toward(i, pad);
        false
    }

    /// Whether ground unit `i` can drive to cell `pad` (same connected area,
    /// or standing on a blocked cell it first steps off).
    fn pad_reachable(&self, i: usize, pad: u32) -> bool {
        let pass = self.pass_of(i);
        let here = self.cell_index(self.actors[i].x, self.actors[i].y);
        pass.blocked[here] || pass.component[here] == pass.component[pad as usize]
    }

    /// Whether unit `i` stands still on cell `c` (in the OpenRA model: its
    /// step there is done).
    fn standing_on(&self, i: usize, c: u32) -> bool {
        if self.cell_moves() && self.occupies_cells(i) {
            return self.actors[i].mv.to == c && self.at_step_end(i);
        }
        self.at_cell_center(i, c)
    }

    /// Unit `i` waits for its turn at depot `d` on its waiting cell.
    fn wait_in_line(&mut self, i: usize, d: usize) {
        let slot = self.actors[i].svc.slot;
        let usable = slot != NONE && !self.someone_stands_on(i, slot) && self.building_at[slot as usize] == NONE;
        if !usable {
            let s = self.pick_slot(i, d);
            self.actors[i].svc.slot = s;
            if s == NONE {
                return; // nowhere to go: wait here
            }
        }
        let slot = self.actors[i].svc.slot;
        if self.standing_on(i, slot) {
            let a = &mut self.actors[i];
            a.best_dist = i32::MAX;
            a.stuck_ticks = 0;
            a.stall_ticks = 0;
            return;
        }
        if self.goal_reached(i, slot, 0, false) {
            // Held up on the way to it: wait here if this is a fine place,
            // else on another cell.
            let here = self.cell_index(self.actors[i].x, self.actors[i].y) as u32;
            let a = &mut self.actors[i];
            a.best_dist = i32::MAX;
            a.stuck_ticks = 0;
            a.stall_ticks = 0;
            if self.ground_spot_open(i, d, here) && !self.slot_taken(i, here, false) {
                self.actors[i].svc.slot = here;
            } else {
                self.actors[i].svc.slot = NONE;
            }
            return;
        }
        self.move_toward(i, slot);
    }

    /// The unit called to depot `d`'s pad: onto it, then repaired (and
    /// minelayers rearmed, abilities.rs) until done.
    fn service_on_pad(&mut self, i: usize, d: usize, pad: u32) {
        if !self.at_cell_center(i, pad) {
            if !self.needs_service(i, d) {
                self.end_service(i);
                return;
            }
            if self.goal_reached(i, pad, 0, false) {
                if !self.pad_reachable(i, pad) {
                    self.end_service(i);
                    return;
                }
                // Something is in the way: try again (OpenRA
                // MoveCooldownHelper with RetryIfDestinationBlocked).
                let a = &mut self.actors[i];
                a.best_dist = i32::MAX;
                a.stuck_ticks = 0;
                a.stall_ticks = 0;
            }
            self.move_toward(i, pad);
            return;
        }
        if !self.needs_service(i, d) {
            self.leave_depot(i, d);
            return;
        }
        // The depot's repair animation (fx.rs, presentation only).
        self.note_service(d);
        if self.actors[i].hp < self.rules.actors[self.actors[i].ty as usize].hp {
            let rep = self.rules.actors[self.actors[d].ty as usize].building.as_ref().unwrap().repairs.clone().unwrap();
            self.repair_step(i, d, &rep);
        }
    }
}

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
//!   corridors straight out of the pad (the way on and off it) of any
//!   depot, never in front of a structure's exit, never on a cell another
//!   unit waits on or stands on. Helicopters hover over every
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
//!   cells (OpenRA moves them just off the pad), planes take off and fly
//!   home to a free airfield (OpenRA: TakeOff, then FlyIdle circling over
//!   the depot). Leaving frees the pad for the next in line.
//! - A new repair order to the same depot keeps a unit's place (and the
//!   pad, for the unit on it). Minelayers out of mines reload in the line
//!   too, then go back to their minefield (abilities.rs).
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

/// Ticks before a unit that found no waiting cell looks again.
const SLOT_RETRY: u32 = 25;

/// A unit's place in a service depot's line.
#[derive(Clone, Copy, Debug)]
pub struct ServiceState {
    /// The depot (actor reference) the ticket and the waiting cell are for, or NONE.
    pub depot: u32,
    /// Place in line: the tick it joined in the high half, its actor index in
    /// the low half; 0 while it is still on its way.
    pub ticket: u64,
    /// The cell it waits on (ground) or hovers over (helicopters), or NONE.
    pub slot: u32,
    /// No waiting cell was free: the tick it looks again.
    pub retry_at: u32,
    /// A minelayer that came to reload: back to its minefield afterwards.
    pub resume_mines: bool,
}

impl Default for ServiceState {
    fn default() -> Self {
        ServiceState { depot: NONE, ticket: 0, slot: NONE, retry_at: 0, resume_mines: false }
    }
}

impl ServiceState {
    pub fn mix(&self, mix: &mut impl FnMut(i64)) {
        mix(self.depot as i64);
        mix(self.ticket as i64);
        mix(self.slot as i64);
        mix(self.retry_at as i64);
        mix(self.resume_mines as i64);
    }
}

/// Every unit in a service depot's line and every waiting cell taken,
/// gathered at the first use in a tick (in actor order, so the same on
/// every machine) and kept up to date as cells are taken during the tick.
/// Derived from the actors' state; not part of the state hash.
#[derive(Clone, Default)]
pub struct ServiceIndex {
    /// The tick it was gathered for, plus one (0: never).
    tick: u32,
    /// (depot reference, ticket, actor), sorted.
    lines: Vec<(u32, u64, u32)>,
    /// (cell, aircraft, actor) of the waiting cells taken, sorted.
    claims: Vec<(u32, bool, u32)>,
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

    /// Whether unit `j` is sent to the depot `dref` (on its way to it,
    /// waiting, or on its pad).
    fn serving_at(&self, j: usize, dref: u32) -> bool {
        let a = &self.actors[j];
        a.alive && a.activity == Activity::Repair && a.depot == dref
    }

    /// The unit called to depot `d`'s pad (on its way or being served).
    pub(crate) fn pad_holder(&self, d: usize) -> Option<usize> {
        let u = self.resolve(self.actors[d].dock_user)?;
        self.serving_at(u, self.make_ref(d)).then_some(u)
    }

    /// Gather the lines and the waiting cells taken, once a tick (`ServiceIndex`).
    pub(crate) fn refresh_service_index(&mut self) {
        if self.svc_index.tick == self.tick.wrapping_add(1) {
            return;
        }
        let mut idx = std::mem::take(&mut self.svc_index);
        idx.tick = self.tick.wrapping_add(1);
        idx.lines.clear();
        idx.claims.clear();
        for (j, a) in self.actors.iter().enumerate() {
            if !a.alive || a.activity != Activity::Repair || a.svc.depot != a.depot {
                continue;
            }
            if a.svc.ticket != 0 {
                idx.lines.push((a.depot, a.svc.ticket, j as u32));
            }
            if a.svc.slot != NONE {
                idx.claims.push((a.svc.slot, a.kind == Kind::Aircraft, j as u32));
            }
        }
        idx.lines.sort_unstable();
        idx.claims.sort_unstable();
        self.svc_index = idx;
    }

    /// Unit `i` takes waiting cell `slot` (NONE: none free; it looks again later).
    pub(crate) fn set_slot(&mut self, i: usize, slot: u32) {
        let tick = self.tick;
        let a = &mut self.actors[i];
        a.svc.slot = slot;
        if slot == NONE {
            a.svc.retry_at = tick + SLOT_RETRY;
            return;
        }
        let key = (slot, a.kind == Kind::Aircraft, i as u32);
        let at = self.svc_index.claims.partition_point(|c| *c < key);
        self.svc_index.claims.insert(at, key);
    }

    /// Whether unit `i` without a waiting cell may look for one now.
    pub(crate) fn may_pick_slot(&self, i: usize) -> bool {
        self.tick >= self.actors[i].svc.retry_at
    }

    /// The line state of unit `i` belongs to the depot it is sent to: a unit
    /// sent elsewhere starts afresh there and gives up the old depot's pad.
    pub(crate) fn sync_service(&mut self, i: usize) {
        let (depot, old) = (self.actors[i].depot, self.actors[i].svc.depot);
        if old == depot {
            return;
        }
        if let Some(d) = self.resolve(old) {
            if self.actors[d].dock_user == self.make_ref(i) {
                self.actors[d].dock_user = NONE;
            }
        }
        self.actors[i].svc = ServiceState { depot, ..Default::default() };
    }

    /// Unit `i` leaves its depot's line and gives up the pad.
    fn leave_line(&mut self, i: usize) {
        if let Some(d) = self.resolve(self.actors[i].svc.depot) {
            if self.actors[d].dock_user == self.make_ref(i) {
                self.actors[d].dock_user = NONE;
            }
        }
        self.actors[i].svc = Default::default();
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

    /// The first unit in depot `d`'s line (lowest ticket), from this tick's
    /// index: a unit that joined during the tick comes next tick.
    fn next_in_line(&self, d: usize) -> Option<usize> {
        let dref = self.make_ref(d);
        let lines = &self.svc_index.lines;
        let start = lines.partition_point(|l| l.0 < dref);
        lines[start..].iter().take_while(|l| l.0 == dref).map(|l| l.2 as usize).find(|&j| {
            let a = &self.actors[j];
            self.serving_at(j, dref) && a.svc.depot == dref && a.svc.ticket != 0
        })
    }

    /// Call unit `i` to depot `d`'s pad when it is free and `i` is first in
    /// line. True when `i` holds the pad now.
    pub(crate) fn call_to_pad(&mut self, i: usize, d: usize) -> bool {
        if self.pad_holder(d).is_some() {
            return false;
        }
        self.refresh_service_index();
        if self.next_in_line(d) != Some(i) {
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
        let mines = self.actors[i].svc.resume_mines;
        self.leave_line(i);
        self.release_dock(i);
        let a = &mut self.actors[i];
        a.activity = Activity::Idle;
        a.target = NONE;
        // A helicopter on the pad takes off again (OpenRA Resupply with the
        // host gone: TakeOff); tick_plane does the same for planes.
        if a.kind == Kind::Aircraft {
            a.heli.landed = false;
        }
        // A minelayer that came to reload goes back to its minefield with
        // the mines it has (without any it keeps the cells for a later
        // order; abilities.rs).
        let has_mines = self.actors[i].ab.ammo > 0;
        if mines && has_mines {
            self.resume_minefield(i);
        }
    }

    /// Unit `i` gets repaired at depot `d` without an order (a damaged
    /// vehicle left idle on the depot, a helicopter landed on it): a fresh
    /// place at the end of the line, unless the pad is still reserved for
    /// it. Line state kept from an earlier visit never carries over.
    pub(crate) fn enter_service_line(&mut self, i: usize, d: usize) {
        let (me, dref) = (self.make_ref(i), self.make_ref(d));
        let holds_pad = self.actors[d].dock_user == me;
        let a = &mut self.actors[i];
        let ticket = if holds_pad && a.svc.depot == dref { a.svc.ticket } else { 0 };
        a.svc = ServiceState { depot: dref, ticket, ..Default::default() };
        a.activity = Activity::Repair;
        a.depot = dref;
        a.repair_timer = 0;
    }

    /// Unit `i` is done at depot `d`: FinishRepairingNotification, then off
    /// to the rally point, or to a free spot next to the depot (ground units
    /// and helicopters). Planes without a rally point fly home (plane.rs).
    /// It gives up its place and the pad first (`leave_line`).
    pub(crate) fn leave_depot(&mut self, i: usize, d: usize) {
        self.note_repaired(i, d);
        let mines = self.actors[i].svc.resume_mines;
        self.leave_line(i);
        // A minelayer that came to reload goes back to its minefield (abilities.rs).
        if mines && self.resume_minefield(i) {
            return;
        }
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
            && !self.keep_clear(c)
            && !self.someone_stands_on(i, c)
    }

    /// Whether cell `c` must stay free for others: on a corridor straight
    /// out of any service depot's pad (any owner's), or the exit cell of a
    /// structure (where factories put out what they built) or the cell just
    /// outside its footprint from there.
    fn keep_clear(&self, c: u32) -> bool {
        let w = self.map.width;
        let (cx, cy) = (c as i32 % w, c as i32 / w);
        for (sx, sy) in [(0, 1), (1, 0), (0, -1), (-1, 0)] {
            for k in 1..=CORRIDOR + 1 {
                let (x, y) = (cx + sx * k, cy + sy * k);
                if !self.map.contains(x, y) {
                    break;
                }
                let b = self.building_at[self.map.idx(x, y)];
                if b == NONE {
                    continue;
                }
                let b = b as usize;
                let is_depot = self.actors[b].alive
                    && self.rules.actors[self.actors[b].ty as usize].building.as_ref().is_some_and(|bi| bi.repairs.is_some());
                if is_depot && self.in_corridor(b, c) {
                    return true;
                }
            }
        }
        for oy in -1..=1 {
            for ox in -1..=1 {
                if !self.map.contains(cx + ox, cy + oy) {
                    continue;
                }
                let b = self.building_at[self.map.idx(cx + ox, cy + oy)];
                if b == NONE {
                    continue;
                }
                let ba = &self.actors[b as usize];
                let Some(bi) = self.rules.actors[ba.ty as usize].building.as_ref() else { continue };
                let (rx, ry) = (cx - ba.cx, cy - ba.cy);
                let out = |&(ex, ey): &(i32, i32)| {
                    (rx, ry) == (ex, ey)
                        || (ey == bi.height - 1 && (rx, ry) == (ex, bi.height))
                        || (ey == 0 && (rx, ry) == (ex, -1))
                        || (ex == 0 && (rx, ry) == (-1, ey))
                        || (ex == bi.width - 1 && (rx, ry) == (bi.width, ey))
                };
                if ba.alive && bi.exits.iter().any(out) {
                    return true;
                }
            }
        }
        false
    }

    /// Whether another unit in a service line waits on (or over) cell `c`.
    fn slot_taken(&self, i: usize, c: u32, air: bool) -> bool {
        let claims = &self.svc_index.claims;
        let start = claims.partition_point(|k| (k.0, k.1) < (c, air));
        claims[start..].iter().take_while(|k| (k.0, k.1) == (c, air)).any(|k| {
            let j = k.2 as usize;
            let o = &self.actors[j];
            j != i && o.alive && o.activity == Activity::Repair && o.svc.slot == c
        })
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
        self.refresh_service_index();
        let air = self.actors[i].kind == Kind::Aircraft;
        // Cells other units of its kind are on their way to.
        let mut goals: Vec<u32> = self
            .actors
            .iter()
            .enumerate()
            .filter(|(j, o)| *j != i && o.alive && o.activity == Activity::Move && (o.kind == Kind::Aircraft) == air)
            .map(|(_, o)| o.goal)
            .collect();
        goals.sort_unstable();
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
            if dx.abs().max(dy.abs()) >= SLOT_FIRST_RING && self.park_open(i, d, c, air, &goals) {
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
    /// `goals`: the cells others of its kind are on their way to, sorted.
    fn park_open(&self, i: usize, d: usize, c: u32, air: bool, goals: &[u32]) -> bool {
        if self.slot_taken(i, c, air) || goals.binary_search(&c).is_ok() {
            return false;
        }
        if !air {
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
        self.refresh_service_index();
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
        self.sync_service(i);
        let Some(d) = self.service_depot(i) else {
            self.end_service(i);
            return;
        };
        self.refresh_service_index();
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
            if !self.may_pick_slot(i) {
                return; // none was free: wait here, look again later
            }
            let s = self.pick_slot(i, d);
            self.set_slot(i, s);
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
                self.set_slot(i, here);
            } else {
                // Another cell next tick (no retry wait: cells are free).
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

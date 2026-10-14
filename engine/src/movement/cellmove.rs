//! The OpenRA movement model: OpenRA's Move activity (Activities/Move/
//! Move.cs), its MovePart steps and Mobile's blocking notifications
//! (INotifyBlockingMove, Nudge), on WebRA's flow fields.
//!
//! A unit steps from the point of one cell (its centre, or an infantry
//! sub-cell) to the next, holding both cells until it is half way, then
//! only the new one (OpenRA MoveFirstHalf, MoveSecondHalf). The route is
//! found when the move starts, around every unit if it can be, then around
//! standing ones, then around those that cannot be asked to move, else
//! along the flow field (Move.PathSearchOrder). When the next cell is
//! taken, the unit (Move.PopPath):
//!
//! - gives up when it is within `near` cells of its destination and no
//!   free cell next to the blocker is as close (group moves: 8 cells, like
//!   OpenRA's move order, so a group gathers around its target cell);
//! - stops when the blocker is an enemy or cannot move;
//! - asks the blocker to step aside (an idle friendly unit moves to a free
//!   neighbouring cell; a busy one is marked `blocking`), waits up to the
//!   locomotor's WaitAverage ticks, and then, unless the blockers are
//!   leaving, looks for a way around every unit, or backs out of the way
//!   when it blocks others itself.
//!
//! WebRA additions: blockers that wait their turn in a queue through a pass
//! that moves on count as leaving (`World::queue_is_moving`), so a column
//! files through a gap instead of giving up or driving round the map; a
//! unit of a huge move order boxed in by its own units searches its route
//! once a neighbouring cell comes free (`Pending::Boxed`); and the route
//! searches of a tick have a budget (`search::ROUTE_SEARCH_BUDGET`).
//!
//! Differences from OpenRA: units drive straight from cell point to cell
//! point instead of along arcs, and turn while they drive when the next
//! cell is at most 45 degrees off their heading (OpenRA's arcs); sharper
//! turns are made on the spot first, as in OpenRA. On snow, vehicles keep
//! their slow acceleration and braking but do not slide off their cells.

use crate::flowfield::{DIRS, DIR_GOAL, DIR_NONE};
use crate::math::{angle_diff, dist, facing_of, turn_toward};
use crate::movement::occupancy::{sub_cell_point, Blocking, FULL_CELL};
use crate::movement::search::ROUTE_SEARCH_BUDGET;
use crate::movement::MoveResult;
use crate::world::{Activity, World, NONE};

/// Vehicles turn on the spot before a step whose heading is off by more
/// than this (45 degrees), else they turn while they drive.
const TURN_ON_THE_SPOT: i32 = 128;
/// Cells a player's move order may stop short of its target when the way
/// is blocked (OpenRA Mobile: `Move` orders with WDist.FromCells(8)).
pub const ORDER_NEAR_ENOUGH: i32 = 8;
/// OpenRA Crushable.WarnProbability: the chance (percent) that a soldier
/// about to be run over jumps aside.
const WARN_PROBABILITY: i32 = 75;
/// Ticks a unit waits without a step in a queue that moves on
/// (`World::queue_is_moving`) before only units leaving the cell itself
/// count again (OpenRA), one minute: a safety net only, since a queue
/// counts as moving only while the units at its head drive on. Long enough
/// for the back of an army filing through a gap one cell wide.
const QUEUE_PATIENCE: i32 = 25 * 60;
/// Move orders of at least this many units are huge (`World::huge_order`):
/// a unit boxed in by its own units waits for a free neighbouring cell
/// before it searches its route (`Pending::Boxed`), and a unit held up in
/// a queue that moves on waits its turn in the open too, not only in a
/// pass. Smaller orders search at once, as in OpenRA (from a boxed-in cell
/// the searches around every unit and around standing ones fail at the
/// first cell, and the one search left costs little), and in the open
/// follow OpenRA's rule.
const HUGE_ORDER: i32 = 250;
/// Cells of its way ahead a unit held up in a queue looks at for a pass
/// (`World::route_through_pass`).
const PASS_LOOKAHEAD: usize = 24;
/// OpenRA MoveCooldownHelper.Cooldown: ticks before a move that ended
/// short is tried again (activities that keep trying, such as repairs).
const RETRY_COOLDOWN: (i32, i32) = (20, 31);

/// A unit's place on the cell grid and its move (OpenRA Mobile and Move).
#[derive(Clone, Debug)]
pub struct Motion {
    /// The cell it comes from and the cell it drives into (the same cell
    /// when it stands); NONE until the unit was first placed.
    pub from: u32,
    pub to: u32,
    pub from_sub: u8,
    pub to_sub: u8,
    /// Where the current step started (world units).
    pub seg: (i32, i32),
    /// Where this model last put the unit: elsewhere means other code moved
    /// it (unloaded, teleported, landed from a leap) and it takes the cell
    /// it stands on (`World::occupancy_begin_tick`).
    pub pos: (i32, i32),
    /// Destination of the current move, NONE without one.
    pub dest: u32,
    /// Close enough, in cells: the move may end this near when blocked.
    pub near: i32,
    /// `near` for moves of the unit's last move order (`ORDER_NEAR_ENOUGH`,
    /// 1 for a rally point, 0 for a nudge or scatter).
    pub order_near: i32,
    /// The route, next cell last; unused while following the flow field.
    pub path: Vec<u32>,
    /// The route is the flow field toward `dest` (no unit was in the way).
    pub field: bool,
    /// Waiting for a blocker to leave (Move.hasWaited, waitTicksRemaining).
    pub waited: bool,
    pub wait: i32,
    pub result: MoveResult,
    /// Asked to make way while busy (Mobile.IsBlocking).
    pub blocking: bool,
    /// The cell it waits to step into while its move is held up (Move.PopPath
    /// waiting), NONE otherwise: units waiting behind it follow the queue
    /// (`World::queue_is_moving`).
    pub waiting_for: u32,
    /// Ticks it has waited since its last step in this move: past
    /// `QUEUE_PATIENCE` a queue ahead no longer counts as moving.
    pub queue_wait: i32,
    /// The route search of the move is still to come (`Pending`).
    pub pending: Pending,
    /// The tick a search of the move first waited for the tick's budget
    /// (`Pending::Search`, `Pending::Repath`): the oldest are served first
    /// (`World::serve_deferred_searches`).
    pub pending_since: u32,
    /// Turning on the spot to drive on (Mobile.TurnToMove).
    pub turning: bool,
    /// Moved in the last tick (Mobile.CurrentMovementTypes: Horizontal).
    pub moving: bool,
    /// Ticks before a move that ended short is tried again.
    pub cooldown: i32,
    /// Placed on a cell it may not share (unloaded onto a crowded cell, say):
    /// it steps off once idle.
    pub crowded: bool,
    /// Stepped this tick (presentation of nothing; resets every tick).
    pub stepped: bool,
}

impl Default for Motion {
    fn default() -> Self {
        Motion {
            from: NONE,
            to: NONE,
            from_sub: FULL_CELL,
            to_sub: FULL_CELL,
            seg: (0, 0),
            pos: (i32::MIN, i32::MIN),
            dest: NONE,
            near: 0,
            order_near: ORDER_NEAR_ENOUGH,
            path: Vec::new(),
            field: false,
            waited: false,
            wait: 0,
            result: MoveResult::None,
            blocking: false,
            waiting_for: NONE,
            queue_wait: 0,
            pending: Pending::None,
            pending_since: 0,
            turning: false,
            moving: false,
            cooldown: 0,
            crowded: false,
            stepped: false,
        }
    }
}

impl Motion {
    /// A new order: the move in progress ends (a step already begun is
    /// finished first, `World::finish_step`).
    pub fn cancel(&mut self) {
        self.dest = NONE;
        self.result = MoveResult::None;
        self.path.clear();
        self.field = false;
        self.waited = false;
        self.cooldown = 0;
        self.waiting_for = NONE;
        self.queue_wait = 0;
        self.pending = Pending::None;
    }

    /// Other code put the unit at `pos` on `cell`: it stands there now. A
    /// route through other cells is void (Move.PopPath: "something else
    /// might have moved us").
    pub(crate) fn snapped(&mut self, cell: u32, sub: u8, pos: (i32, i32)) {
        self.from = cell;
        self.to = cell;
        self.from_sub = sub;
        self.to_sub = sub;
        self.seg = pos;
        self.pos = pos;
        self.blocking = false;
        self.turning = false;
        self.waiting_for = NONE;
    }

    pub fn mix(&self, mix: &mut impl FnMut(i64)) {
        for v in [self.from as i64, self.to as i64, self.from_sub as i64, self.to_sub as i64, self.dest as i64, self.near as i64] {
            mix(v);
        }
        mix(self.path.len() as i64);
        if let Some(&c) = self.path.last() {
            mix(c as i64);
        }
        mix(self.field as i64 | (self.waited as i64) << 1 | (self.blocking as i64) << 2 | (self.crowded as i64) << 3);
        mix(self.waiting_for as i64);
        mix(self.queue_wait as i64);
        mix(self.wait as i64);
        mix(self.cooldown as i64);
        mix(self.result as i64);
        mix(match self.pending {
            Pending::None => 0,
            Pending::Boxed => 1,
            Pending::Search(check) => 2 + check as i64,
            Pending::Repath => 6,
            Pending::NoWay => 7,
        });
        mix(self.pending_since as i64);
    }
}

/// Why a move has no route yet (WebRA addition: OpenRA searches the route
/// of every move when it starts, Move.OnFirstRun).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Pending {
    /// The route is known (or the move follows the flow field).
    None,
    /// Boxed in by friendly units that are about to move (`World::boxed_in`):
    /// it waits for a neighbouring cell to come free, then searches its
    /// route around the units that cannot be asked to move
    /// (`Blocking::Immovable`): the route OpenRA's search order gives a
    /// boxed-in unit at the start of its move, where the searches around
    /// every unit and around standing ones fail at once.
    Boxed,
    /// The tick's route search budget was spent (`ROUTE_SEARCH_BUDGET`): it
    /// searches from this check on when its turn comes
    /// (`World::serve_deferred_searches`).
    Search(Blocking),
    /// Move.PopPath's search for a way around every unit after waiting
    /// for a blocker, held back by the budget like `Search`.
    Repath,
    /// That search found no way: the unit backs out of the way of others or
    /// its move ends, at its next step.
    NoWay,
}

/// What OpenRA's Move.PopPath decides about the next cell of the route.
enum Pop {
    /// Step into this cell and sub-cell.
    Next(u32, u8),
    /// Wait for it this tick.
    Wait,
    /// The way is blocked (the route may have been found again).
    Stop,
}

/// What a unit standing on a cell point does next (Move.Tick, PopPath).
enum Next {
    /// Step into this cell and sub-cell.
    Go(u32, u8),
    /// Wait this tick.
    Wait,
    /// Turn toward this facing first.
    Turn(i32),
    /// The move is over.
    End(MoveResult),
}

impl World {
    // ---- The move ---------------------------------------------------------------------

    /// One tick of unit `i` moving to cell `dest` (the OpenRA model's
    /// `move_toward`). A new destination starts a new move; a move that
    /// ended short (Blocked) starts again after a cooldown (OpenRA
    /// MoveCooldownHelper with RetryIfDestinationBlocked).
    pub(crate) fn cell_move(&mut self, i: usize, dest: u32) {
        let _section = crate::profile::scope(crate::profile::Section::CellMove);
        // Made this tick (or moved by other code): it takes its cell first.
        if self.actors[i].mv.to == NONE || self.actors[i].mv.pos != (self.actors[i].x, self.actors[i].y) {
            self.place_on_cell(i);
        }
        let m = &self.actors[i].mv;
        let restart = if m.dest != dest || m.result == MoveResult::None {
            true
        } else if m.result == MoveResult::Blocked {
            // Making way for others does not wait for the cooldown.
            if m.blocking {
                true
            } else if m.cooldown == 0 {
                let c = RETRY_COOLDOWN.0 + self.movement_roll(i, Roll::Cooldown, (RETRY_COOLDOWN.1 - RETRY_COOLDOWN.0) as u64) as i32;
                self.actors[i].mv.cooldown = c;
                false
            } else {
                self.actors[i].mv.cooldown -= 1;
                self.actors[i].mv.cooldown == 0
            }
        } else {
            m.result == MoveResult::Reached
        };
        if restart {
            self.start_move(i, dest);
        }
        self.cell_step(i);
    }

    /// How the move of unit `i` toward `dest` ended, if it did: Reached or
    /// Blocked. Reading the end makes the next `cell_move` toward the same
    /// cell a new move.
    pub(crate) fn cell_move_ended(&mut self, i: usize, dest: u32) -> Option<MoveResult> {
        let m = &mut self.actors[i].mv;
        if m.to == NONE {
            return None;
        }
        if m.to == dest && m.from == m.to && self.at_step_end(i) {
            let m = &mut self.actors[i].mv;
            m.result = MoveResult::None;
            m.dest = NONE;
            return Some(MoveResult::Reached);
        }
        let m = &mut self.actors[i].mv;
        if m.dest != dest {
            return None;
        }
        match m.result {
            MoveResult::Reached | MoveResult::Blocked => Some(m.result),
            _ => None,
        }
    }

    /// Forget the end of the move toward `dest` (a caller that gives up on it).
    pub(crate) fn cell_move_forget(&mut self, i: usize) {
        let m = &mut self.actors[i].mv;
        if matches!(m.result, MoveResult::Reached | MoveResult::Blocked) {
            m.cancel();
        }
    }

    /// OpenRA Move.OnFirstRun: the route, around every unit if possible,
    /// then around standing ones, then around the ones that cannot be asked
    /// to move, else the flow field. WebRA addition: a unit boxed in by
    /// friendly units that are about to move searches once a neighbouring
    /// cell comes free (`Pending::Boxed`), so the first tick of a huge move
    /// order searches the routes of the units at the edge of the crowd only.
    fn start_move(&mut self, i: usize, dest: u32) {
        let near = if self.actors[i].activity == Activity::Move { self.actors[i].mv.order_near } else { 0 };
        let m = &mut self.actors[i].mv;
        m.cancel();
        m.dest = dest;
        m.near = near;
        m.result = MoveResult::InProgress;
        if m.to == dest {
            return;
        }
        // Only huge orders wait (`HUGE_ORDER`); a move to a neighbouring
        // cell (a nudge) needs no search anyway.
        if self.huge_order(i) && !self.adjacent_cells(self.actors[i].mv.to, dest) && self.boxed_in(i) {
            self.actors[i].mv.pending = Pending::Boxed;
            return;
        }
        self.find_route(i, Blocking::All);
    }

    /// Move.OnFirstRun's PathSearchOrder from `first` on: the route of unit
    /// `i` to its destination, else the flow field. Once the tick's route
    /// search budget is spent the search waits for the unit's next step
    /// (`Pending::Search`).
    fn find_route(&mut self, i: usize, first: Blocking) {
        if self.route_budget_spent() {
            self.defer_search(i, Pending::Search(first));
            return;
        }
        let dest = self.actors[i].mv.dest;
        self.actors[i].mv.pending = Pending::None;
        for check in [Blocking::All, Blocking::Stationary, Blocking::Immovable] {
            if check > first {
                continue;
            }
            if let Some(path) = self.find_path(i, dest, check) {
                if !path.is_empty() {
                    self.actors[i].mv.path = path;
                    return;
                }
            }
        }
        self.actors[i].mv.field = true;
    }

    /// The step of a move whose route search is still to come: None once
    /// the route is there, else what the unit does this tick. A unit boxed
    /// in waits for a neighbouring cell to come free like a unit waiting for
    /// a blocker (Move.PopPath): up to `WaitAverage` ticks, and on while its
    /// queue moves (`World::queue_is_moving`, up to `QUEUE_PATIENCE`).
    fn pending_step(&mut self, i: usize) -> Option<Next> {
        match self.actors[i].mv.pending {
            Pending::None => return None,
            Pending::Search(first) => self.find_route(i, first),
            Pending::Repath => {
                if self.route_budget_spent() {
                    return Some(Next::Wait);
                }
                self.actors[i].mv.pending = Pending::None;
                let pop = self.repath(i);
                return Some(self.pop_to_next(i, NONE, pop));
            }
            Pending::NoWay => {
                self.actors[i].mv.pending = Pending::None;
                let pop = self.no_way_round(i);
                return Some(self.pop_to_next(i, NONE, pop));
            }
            Pending::Boxed => {
                if self.boxed_in(i) && !self.boxed_wait_over(i) {
                    return Some(Next::Wait);
                }
                self.find_route(i, Blocking::Immovable);
            }
        }
        // The wait goes on where it was (`waited`, `wait`), as for a unit
        // that had its route from the start and waited for its next cell.
        (self.actors[i].mv.pending != Pending::None).then_some(Next::Wait)
    }

    /// The tick's route search budget is spent: unit `i` searches later
    /// (`pending`), and the time it first had to wait is kept.
    fn defer_search(&mut self, i: usize, pending: Pending) {
        let tick = self.tick;
        let m = &mut self.actors[i].mv;
        if !matches!(m.pending, Pending::Search(_) | Pending::Repath) {
            m.pending_since = tick;
            self.search.deferred += 1;
        }
        m.pending = pending;
        self.search.backlog = true;
    }

    /// WebRA addition: before units act, the searches that waited for the
    /// budget in earlier ticks run, the oldest first, as long as the budget
    /// lasts; what is left waits on, and searches asked for in this tick
    /// only get what the older ones leave. Units act in an order that
    /// alternates every tick, so without this the units at both ends of the
    /// actor list would take the budget tick after tick while the ones in
    /// the middle wait. Searches that have waited equally long go by actor.
    /// The order depends only on the game state (`Motion::pending_since`).
    pub(crate) fn serve_deferred_searches(&mut self) {
        if !self.cell_moves() || !self.search.backlog {
            return;
        }
        let mut waiting: Vec<(u32, usize)> = (0..self.actors.len())
            .filter(|&i| {
                let m = &self.actors[i].mv;
                matches!(m.pending, Pending::Search(_) | Pending::Repath)
                    && m.result == MoveResult::InProgress
                    && m.dest != NONE
                    && self.occupies_cells(i)
            })
            .map(|i| (self.actors[i].mv.pending_since, i))
            .collect();
        self.search.backlog = !waiting.is_empty();
        waiting.sort_unstable();
        for (_, i) in waiting {
            if self.search.tick_expanded >= ROUTE_SEARCH_BUDGET {
                break;
            }
            match self.actors[i].mv.pending {
                Pending::Search(first) => self.find_route(i, first),
                Pending::Repath => {
                    // The way found is taken at the unit's next step.
                    let dest = self.actors[i].mv.dest;
                    let path = self.find_path(i, dest, Blocking::All).filter(|p| !p.is_empty());
                    let m = &mut self.actors[i].mv;
                    match path {
                        Some(path) => (m.path, m.field, m.pending) = (path, false, Pending::None),
                        None => m.pending = Pending::NoWay,
                    }
                }
                _ => {}
            }
        }
    }

    /// Whether unit `i`, boxed in, is done waiting (see `pending_step`).
    fn boxed_wait_over(&mut self, i: usize) -> bool {
        if self.actors[i].mv.waiting_for == NONE {
            // The cell it would drive into first: the queue it waits in.
            let next = self.field_next(i).unwrap_or(NONE);
            self.actors[i].mv.waiting_for = next;
        }
        let wait_average = self.wait_average(i);
        let m = &mut self.actors[i].mv;
        if !m.waited {
            (m.wait, m.waited) = (wait_average, true);
            return false;
        }
        m.wait -= 1;
        if m.wait >= 0 {
            return false;
        }
        m.waited = false;
        let (next, patient) = (m.waiting_for, m.queue_wait < QUEUE_PATIENCE);
        !(patient && next != NONE && self.queue_is_moving(next, i, false))
    }

    /// WebRA addition: whether unit `i`, starting a move, is boxed in: every
    /// neighbouring cell it may step to is held, and only by friendly units
    /// that are about to move (`about_to_move`). A soldier counts as boxed
    /// in also when those cells have a free sub-cell: stepping in beside
    /// soldiers of its own crowd gets it nowhere yet, and the searches of
    /// the soldiers in the middle of a huge crowd (two to a cell in the
    /// stress test) would hold back the units at its edge for seconds
    /// (docs/contracts.md "Huge move orders"). The front of a crowd drives
    /// off first and the rows behind follow as cells come free, as they
    /// would anyway: their routes are searched then, not all at once.
    pub(crate) fn boxed_in(&self, i: usize) -> bool {
        let _section = crate::profile::scope(crate::profile::Section::Queues);
        let here = self.actors[i].mv.to;
        let w = self.map.width;
        let (x, y) = (here as i32 % w, here as i32 / w);
        let mut held = false;
        for &(dx, dy) in DIRS.iter() {
            if !self.map.contains(x + dx, y + dy) {
                continue;
            }
            let c = self.map.idx(x + dx, y + dy) as u32;
            if !self.can_step(i, here, c) {
                continue;
            }
            // An empty cell, or one with a unit that is not about to move
            // (a soldier may join idle soldiers there): not boxed in.
            let mut any = false;
            for o in self.others_at(c, i) {
                if !self.about_to_move(i, o.actor as usize) {
                    return false;
                }
                any = true;
            }
            if !any {
                return false;
            }
            held = true;
        }
        held
    }

    /// Whether unit `o` is a friend of unit `i` that is about to move: it
    /// drives or turns, its move waits for its route or for a cell, or it
    /// was just ordered to move and has not acted on the order yet.
    fn about_to_move(&self, i: usize, o: usize) -> bool {
        let b = &self.actors[o];
        let m = &b.mv;
        self.are_allies(self.actors[i].owner, b.owner)
            && self.is_movable(o)
            && (m.moving
                || m.turning
                || m.from != m.to
                || m.pending != Pending::None
                || (m.result == MoveResult::InProgress && m.waiting_for != NONE)
                || (b.activity == Activity::Move && m.result == MoveResult::None))
    }

    /// Whether unit `i` stands on the point of its cell (not between cells).
    pub(crate) fn at_step_end(&self, i: usize) -> bool {
        let a = &self.actors[i];
        let m = &a.mv;
        m.from == m.to && (a.x, a.y) == sub_cell_point(self.map.width, m.to, m.to_sub)
    }

    /// Drive the move of unit `i` on for one tick: finish the current step,
    /// then take the next ones while the tick's movement lasts.
    fn cell_step(&mut self, i: usize) {
        self.actors[i].mv.stepped = true;
        self.actors[i].mv.turning = false;
        let Some(mut budget) = self.step_budget(i) else { return };
        // A step ends at most once per cell crossed; two cells per tick is
        // more than any unit's speed.
        for _ in 0..3 {
            if !self.at_step_end(i) {
                budget = self.advance(i, budget);
                if !self.at_step_end(i) || budget == 0 {
                    return;
                }
            }
            if self.actors[i].mv.result != MoveResult::InProgress {
                return;
            }
            let next = self.next_step(i);
            match next {
                Next::Wait => self.actors[i].mv.queue_wait += 1,
                Next::Go(..) => {
                    let m = &mut self.actors[i].mv;
                    (m.waiting_for, m.queue_wait) = (NONE, 0);
                }
                _ => self.actors[i].mv.waiting_for = NONE,
            }
            match next {
                Next::Go(cell, sub) => {
                    let m = &self.actors[i].mv;
                    let from = (m.to, m.to_sub);
                    let (x, y) = (self.actors[i].x, self.actors[i].y);
                    self.actors[i].mv.seg = (x, y);
                    self.set_location(i, from, (cell, sub));
                }
                Next::Turn(facing) => {
                    let turn = self.turn_rate(i);
                    let a = &mut self.actors[i];
                    a.facing = turn_toward(a.facing, facing, turn);
                    a.mv.turning = true;
                    self.hull_turret(i);
                    return;
                }
                Next::Wait => return,
                Next::End(result) => {
                    self.actors[i].mv.result = result;
                    self.actors[i].mv.path.clear();
                    return;
                }
            }
        }
    }

    /// A unit left between cells finishes its step, whatever it does now
    /// (OpenRA MovePart is not interruptible); a unit placed off the point
    /// of its cell returns to it (Mobile.ReturnToCell).
    pub(crate) fn finish_step(&mut self, i: usize) {
        if self.actors[i].mv.to == NONE || self.actors[i].mv.stepped || self.at_step_end(i) {
            return;
        }
        self.actors[i].mv.stepped = true;
        if let Some(budget) = self.step_budget(i) {
            self.advance(i, budget);
        }
    }

    /// Movement of unit `i` this tick (world units), None while it may not
    /// move (a dog eating).
    fn step_budget(&mut self, i: usize) -> Option<i32> {
        let to = self.actors[i].mv.to as usize;
        let drive = self.unit_drive(i)?;
        self.tick_speed(i, to, drive)
    }

    /// Move unit `i` toward the point of its `to` cell by up to `budget`;
    /// returns what is left of the budget. Half way it leaves its `from`
    /// cell (EnteringCell: soldiers in the way may jump aside), at the
    /// point it has arrived (FinishedMoving: it crushes what it may).
    fn advance(&mut self, i: usize, budget: i32) -> i32 {
        let m = &self.actors[i].mv;
        let target = sub_cell_point(self.map.width, m.to, m.to_sub);
        let seg = m.seg;
        let (x, y) = (self.actors[i].x, self.actors[i].y);
        let d = dist(x, y, target.0, target.1);
        if let Some(f) = facing_of(target.0 - x, target.1 - y) {
            let turn = self.turn_rate(i);
            let instant = self.unit_drive(i).is_some_and(|u| u.turn_in_place);
            let a = &mut self.actors[i];
            a.facing = if instant { f } else { turn_toward(a.facing, f, turn) };
        }
        self.hull_turret(i);
        let (nx, ny, rest) = if d <= budget {
            (target.0, target.1, budget - d)
        } else {
            (
                x + ((target.0 - x) as i64 * budget as i64 / d as i64) as i32,
                y + ((target.1 - y) as i64 * budget as i64 / d as i64) as i32,
                0,
            )
        };
        let old_cell = self.cell_at(x, y);
        if (nx, ny) != (x, y) {
            let a = &mut self.actors[i];
            a.x = nx;
            a.y = ny;
            a.moved = true;
            a.mv.pos = (nx, ny);
        }
        let new_cell = self.cell_at(nx, ny);
        if new_cell != old_cell {
            // Driving onto a wall it may crush crushes it (neutral.rs).
            self.crush_wall_at(i, new_cell as usize);
        }
        let m = &self.actors[i].mv;
        if m.from != m.to && dist(nx, ny, target.0, target.1) * 2 <= dist(seg.0, seg.1, target.0, target.1) {
            let to = (m.to, m.to_sub);
            // OpenRA MoveFirstHalf.OnComplete: EnteringCell while the unit
            // still holds the cell it comes from, then it leaves that cell.
            self.warn_crush(i);
            self.set_location(i, to, to);
            self.pop_ahead(i);
        }
        if (nx, ny) == target {
            self.crush_at_cell(i);
        }
        rest
    }

    /// The next step of unit `i` standing on its cell point (Move.Tick).
    fn next_step(&mut self, i: usize) -> Next {
        let m = &self.actors[i].mv;
        let (cur, dest) = (m.to, m.dest);
        if cur == dest {
            return Next::End(MoveResult::Reached);
        }
        if let Some(wait) = self.pending_step(i) {
            return wait;
        }
        let Some(next) = self.route_next(i) else {
            // No way on: make way for others if asked to, else stop.
            if self.actors[i].mv.blocking {
                if let Some(c) = self.adjacent_enterable_cell(i, None) {
                    if let Some(sub) = self.available_sub_cell(i, c) {
                        return self.turn_or_go(i, c, sub);
                    }
                }
            }
            return Next::End(MoveResult::Blocked);
        };
        let pop = self.pop_path(i, next, false);
        self.pop_to_next(i, next, pop)
    }

    /// What unit `i` standing on its cell point does after `pop_path` (or
    /// a search that waited for the budget) about `next`, the next cell of
    /// its route (NONE: look it up).
    fn pop_to_next(&mut self, i: usize, next: u32, pop: Pop) -> Next {
        match pop {
            Pop::Next(c, sub) => self.turn_or_go(i, c, sub),
            Pop::Wait => {
                let next = if next == NONE { self.route_next(i).unwrap_or(NONE) } else { next };
                self.actors[i].mv.waiting_for = next;
                Next::Wait
            }
            Pop::Stop => Next::End(MoveResult::Blocked),
        }
    }

    /// OpenRA MoveFirstHalf.OnComplete: half way into its new cell a unit
    /// looks at the cell after it (Move.PopPath), so a route that turned bad
    /// is found again while it drives on (a structure went up on it), it
    /// asks a blocker to make way early, and a group stops short where it is
    /// close enough. The cell itself is only taken at the cell point.
    fn pop_ahead(&mut self, i: usize) {
        let m = &self.actors[i].mv;
        if m.result != MoveResult::InProgress || m.to == m.dest || m.dest == NONE {
            return;
        }
        let Some(next) = self.route_next(i) else { return };
        if let Pop::Next(c, _) = self.pop_path(i, next, true) {
            if self.route_next(i) != Some(c) {
                let m = &mut self.actors[i].mv;
                if m.field {
                    m.field = false;
                    m.path.clear();
                }
                m.path.push(c);
            }
        }
    }

    /// OpenRA Move.EvalPath(BlockedByActor.Immovable) after the route turned
    /// bad: around what cannot be asked to move (the flow field when that
    /// search finds nothing), or no route when the destination is cut off.
    /// Over the tick's route search budget the search waits for the unit's
    /// next step (`Pending::Search`).
    fn reroute(&mut self, i: usize) {
        if self.route_budget_spent() {
            let m = &mut self.actors[i].mv;
            m.path.clear();
            m.field = false;
            self.defer_search(i, Pending::Search(Blocking::Immovable));
            return;
        }
        let dest = self.actors[i].mv.dest;
        let path = self.find_path(i, dest, Blocking::Immovable).filter(|p| !p.is_empty());
        let to = self.actors[i].mv.to as usize;
        let field = path.is_none() && self.unit_flow_field_from(i, dest, to).is_some_and(|f| f.dirs[to] != DIR_NONE);
        let m = &mut self.actors[i].mv;
        m.path = path.unwrap_or_default();
        m.field = field;
    }

    /// The cell after the unit's own on its route, None when the route
    /// ends here (or the destination cannot be reached at all).
    fn route_next(&mut self, i: usize) -> Option<u32> {
        let m = &self.actors[i].mv;
        if !m.field {
            return m.path.last().copied();
        }
        self.field_next(i)
    }

    /// The cell after the unit's own along the flow field toward its
    /// destination, None when the destination cannot be reached from here.
    fn field_next(&mut self, i: usize) -> Option<u32> {
        let m = &self.actors[i].mv;
        let (cur, dest) = (m.to, m.dest);
        let w = self.map.width;
        let field = self.unit_flow_field_from(i, dest, cur as usize)?;
        match field.dirs[cur as usize] {
            DIR_GOAL => Some(dest),
            DIR_NONE => {
                // Standing on a structure that went up around it: off to the
                // open neighbour nearest the goal (else any open one).
                if self.terrain_allows(i, cur) {
                    return None;
                }
                let (cx, cy) = (cur as i32 % w, cur as i32 / w);
                let mut best: Option<((u16, usize), u32)> = None;
                for (d, &(dx, dy)) in DIRS.iter().enumerate() {
                    if !self.map.contains(cx + dx, cy + dy) {
                        continue;
                    }
                    let n = self.map.idx(cx + dx, cy + dy) as u32;
                    if !self.terrain_allows(i, n) {
                        continue;
                    }
                    let left = self.unit_flow_field_from(i, dest, n as usize).map_or(crate::flowfield::DIST_NONE, |f| f.dist[n as usize]);
                    if best.is_none_or(|(k, _)| (left, d) < k) {
                        best = Some(((left, d), n));
                    }
                }
                best.map(|(_, n)| n)
            }
            d => {
                let (dx, dy) = DIRS[d as usize];
                Some(self.map.idx(cur as i32 % w + dx, cur as i32 / w + dy) as u32)
            }
        }
    }

    /// Take `next` off the route (it was entered).
    fn pop_route(&mut self, i: usize, next: u32) {
        let m = &mut self.actors[i].mv;
        if !m.field && m.path.last() == Some(&next) {
            m.path.pop();
        }
    }

    /// Cells of the route left, counting `next`: 1 when `next` is the destination.
    fn route_left(&self, i: usize, next: u32) -> usize {
        let m = &self.actors[i].mv;
        if m.field {
            if next == m.dest {
                1
            } else {
                2
            }
        } else {
            m.path.len()
        }
    }

    /// OpenRA Move.PopPath: the cell to step into next, waiting, or stop.
    /// Stopping may leave a new route behind (OpenRA re-evaluates it with
    /// BlockedByActor.Immovable): a unit standing still ends its move, one
    /// driving on (`ahead`, `pop_ahead`) follows the new route. A unit
    /// standing still would throw that route away, so it is not searched.
    fn pop_path(&mut self, i: usize, next: u32, ahead: bool) -> Pop {
        let (cur, dest, near) = {
            let m = &self.actors[i].mv;
            (m.to, m.dest, m.near)
        };
        // Something else moved the unit: the route is no longer valid.
        if !self.adjacent_cells(cur, next) || next == cur {
            if ahead {
                self.reroute(i);
            }
            return Pop::Stop;
        }
        // Just left by another unit: it is free from the next tick on, for
        // whoever then acts first (the order alternates every tick).
        if self.occupancy.left_in(next, self.tick) && self.can_step(i, cur, next) {
            return Pop::Wait;
        }
        if self.can_step(i, cur, next) && self.can_enter_cell(i, next, Blocking::All) {
            self.actors[i].mv.waited = false;
            if self.claimed_first_by_other(i, next) {
                return Pop::Wait;
            }
            return match self.available_sub_cell(i, next) {
                Some(sub) => Pop::Next(next, sub),
                None => Pop::Wait,
            };
        }
        // Close enough: give up rather than fight over the last cells, unless
        // a free cell next to the blocker is as close (nudge or go around).
        if self.cell_dist2(cur, dest) <= near * near && self.can_stay_in_cell(cur) {
            let blocker = self.cell_dist2(next, dest);
            let w = self.map.width;
            let (nx, ny) = (next as i32 % w, next as i32 / w);
            let way = self.route_left(i, next) >= 2
                && DIRS.iter().any(|&(dx, dy)| {
                    if !self.map.contains(nx + dx, ny + dy) {
                        return false;
                    }
                    let c = self.map.idx(nx + dx, ny + dy) as u32;
                    c != cur && self.cell_dist2(c, dest) <= blocker && self.can_enter_cell(i, c, Blocking::All)
                });
            if !way {
                let m = &mut self.actors[i].mv;
                m.path.clear();
                m.field = false;
                return Pop::Stop;
            }
        }
        // No point waiting for what cannot move (an enemy, terrain, a structure).
        if !self.can_step(i, cur, next) || !self.can_enter_cell(i, next, Blocking::Immovable) {
            if ahead {
                self.reroute(i);
            }
            return Pop::Stop;
        }
        // Ask it to move, and wait a while.
        self.notify_blocker(i, next);
        let wait_average = self.wait_average(i);
        let m = &mut self.actors[i].mv;
        if !m.waited {
            m.wait = wait_average;
            m.waited = true;
            return Pop::Wait;
        }
        m.wait -= 1;
        if m.wait >= 0 {
            return Pop::Wait;
        }
        m.waited = false;
        // The blockers are leaving already: wait a little longer. WebRA
        // addition: so do blockers that wait their turn in a queue through
        // a pass that moves on (a column filing through it), instead of the
        // unit driving round the map or giving up. In the open OpenRA's rule
        // alone holds (but for huge orders): a crowd around its goal, whose
        // units shuffle as the ones behind ask them aside, settles as in
        // OpenRA.
        if self.cell_is_evacuating(next, i) || (self.actors[i].mv.queue_wait < QUEUE_PATIENCE && self.queue_through_pass_moves(i, next)) {
            return Pop::Wait;
        }
        if self.route_budget_spent() {
            self.defer_search(i, Pending::Repath);
            return Pop::Wait;
        }
        self.repath(i)
    }

    /// The end of Move.PopPath after waiting for a blocker: a way around
    /// every unit, else `no_way_round`.
    fn repath(&mut self, i: usize) -> Pop {
        let dest = self.actors[i].mv.dest;
        if let Some(path) = self.find_path(i, dest, Blocking::All).filter(|p| !p.is_empty()) {
            let first = *path.last().unwrap();
            let m = &mut self.actors[i].mv;
            m.path = path;
            m.field = false;
            return match self.available_sub_cell(i, first) {
                Some(sub) => Pop::Next(first, sub),
                None => Pop::Wait,
            };
        }
        self.no_way_round(i)
    }

    /// Move.PopPath without a way round a blocker that stays: when others
    /// wait for this unit it backs out of their way, else the move ends.
    fn no_way_round(&mut self, i: usize) -> Pop {
        if self.actors[i].mv.blocking {
            if let Some(c) = self.adjacent_enterable_cell(i, None) {
                if let Some(sub) = self.available_sub_cell(i, c) {
                    return Pop::Next(c, sub);
                }
            }
        }
        Pop::Stop
    }

    /// Whether unit `i`, held up before `next`, waits in a queue through a
    /// pass that moves on (`World::queue_is_moving`): the queue runs
    /// through a pass, or the unit's own way does within `PASS_LOOKAHEAD`
    /// cells (a column still on its way to a gap). A huge order
    /// (`HUGE_ORDER`) files after its own head anywhere.
    fn queue_through_pass_moves(&mut self, i: usize, next: u32) -> bool {
        let need_pass = !self.huge_order(i) && !self.route_through_pass(i);
        self.queue_is_moving(next, i, need_pass)
    }

    /// Whether unit `i` moves as part of a move order of at least
    /// `HUGE_ORDER` units.
    fn huge_order(&self, i: usize) -> bool {
        let a = &self.actors[i];
        a.activity == Activity::Move && a.group_size >= HUGE_ORDER
    }

    /// Whether the next `PASS_LOOKAHEAD` cells of unit `i`'s route (or of
    /// the flow field it follows) cross a pass (`World::pass_cell`).
    fn route_through_pass(&mut self, i: usize) -> bool {
        if self.actors[i].mv.field {
            let (mut c, dest) = (self.actors[i].mv.to, self.actors[i].mv.dest);
            let w = self.map.width;
            for _ in 0..PASS_LOOKAHEAD {
                if self.pass_cell(i, c) {
                    return true;
                }
                let Some(f) = self.unit_flow_field_from(i, dest, c as usize) else { return false };
                match f.dirs[c as usize] {
                    DIR_NONE | DIR_GOAL => return false,
                    d => {
                        let (dx, dy) = DIRS[d as usize];
                        c = self.map.idx(c as i32 % w + dx, c as i32 / w + dy) as u32;
                    }
                }
            }
            return false;
        }
        let m = &self.actors[i].mv;
        std::iter::once(m.to).chain(m.path.iter().rev().copied()).take(PASS_LOOKAHEAD).any(|c| self.pass_cell(i, c))
    }

    /// Whether another unit standing next to the free cell `cell` wants to
    /// step into it now too, and comes first this tick. Units act one after
    /// another (in an order that alternates every tick), so the first to act
    /// would always take a cell several want at once, and mirrored armies
    /// would be decided by the tick their fight starts on. Instead each
    /// tick gives every unit a fresh pseudo-random rank (`claim_rank`), and
    /// the best ranked of those that want the cell takes it.
    fn claimed_first_by_other(&mut self, i: usize, cell: u32) -> bool {
        let mine = claim_rank(self.claim_salt, self.tick, i);
        // At most 8 cells of 5 units each around a cell.
        let mut rivals = [0usize; 40];
        let mut count = 0;
        let w = self.map.width;
        let (x, y) = (cell as i32 % w, cell as i32 / w);
        for &(dx, dy) in DIRS.iter() {
            if !self.map.contains(x + dx, y + dy) {
                continue;
            }
            for o in self.others_at(self.map.idx(x + dx, y + dy) as u32, i) {
                let o = o.actor as usize;
                if count < rivals.len() && claim_rank(self.claim_salt, self.tick, o) > mine {
                    rivals[count] = o;
                    count += 1;
                }
            }
        }
        for &o in &rivals[..count] {
            let m = &self.actors[o].mv;
            if m.result != MoveResult::InProgress || m.dest == NONE || m.to == cell || !self.at_step_end(o) {
                continue;
            }
            if self.route_next(o) == Some(cell) {
                return true;
            }
        }
        false
    }

    /// Step into `cell`, after turning on the spot if the heading is far
    /// off. The route only loses the cell once the step begins. A cell off
    /// the route (backing out of the way of others) goes onto it before the
    /// turn, as OpenRA's Move.Tick adds it to its path before it queues the
    /// Turn: else the unit would forget it after a tick of turning, wait
    /// for its old next cell again, and a unit waiting head on for its own
    /// cell would see it turn (leaving, Move.CellIsEvacuating) and wait on,
    /// every WaitAverage, for good.
    fn turn_or_go(&mut self, i: usize, cell: u32, sub: u8) -> Next {
        let Some(drive) = self.unit_drive(i) else { return Next::Wait };
        let (x, y) = (self.actors[i].x, self.actors[i].y);
        let target = sub_cell_point(self.map.width, cell, sub);
        if !drive.turn_in_place {
            if let Some(f) = facing_of(target.0 - x, target.1 - y) {
                if angle_diff(self.actors[i].facing, f).abs() > TURN_ON_THE_SPOT {
                    if self.route_next(i) != Some(cell) {
                        let m = &mut self.actors[i].mv;
                        if m.field {
                            m.field = false;
                            m.path.clear();
                        }
                        m.path.push(cell);
                    }
                    return Next::Turn(f);
                }
            }
        }
        self.pop_route(i, cell);
        Next::Go(cell, sub)
    }

    /// OpenRA LocomotorInfo.WaitAverage of unit `i`.
    fn wait_average(&self, i: usize) -> i32 {
        self.rules.actors[self.actors[i].ty as usize].unit.as_ref().map_or(0, |u| self.rules.locomotors[u.locomotor].wait_average)
    }

    // ---- Making way -------------------------------------------------------------------

    /// Whether unit `i` has nothing to do (OpenRA Actor.IsIdle).
    pub(crate) fn idle_on_cell(&self, i: usize) -> bool {
        let a = &self.actors[i];
        a.activity == Activity::Idle && a.waypoints.is_empty() && self.at_step_end(i)
    }

    /// OpenRA Actor.NotifyBlocker: the friendly units on `cell` learn that
    /// unit `i` wants in. Idle ones step aside (Nudge), busy ones note that
    /// they are in the way (Mobile.IsBlocking).
    fn notify_blocker(&mut self, i: usize, cell: u32) {
        let (owner, from) = (self.actors[i].owner, self.actors[i].mv.to);
        // A unit waits for a cell every tick it is held up: no list is made
        // (asking a unit changes nobody's cells, so the table stays as it is).
        let mut k = 0;
        while let Some(&o) = self.occupancy.at(cell).get(k) {
            k += 1;
            let o = o.actor as usize;
            if o != i && self.occupies_cells(o) {
                self.notify_one(o, owner, from);
            }
        }
    }

    /// OpenRA Mobile.OnNotifyBlockingMove of each of `blockers`, asked by
    /// an actor of `owner` on cell `from`: friendly idle ones step aside
    /// (Nudge), friendly busy ones note that they are in the way.
    fn notify_blockers(&mut self, blockers: Vec<usize>, owner: u8, from: u32) {
        for o in blockers {
            self.notify_one(o, owner, from);
        }
    }

    /// `notify_blockers` of one blocker `o`.
    fn notify_one(&mut self, o: usize, owner: u8, from: u32) {
        if !self.are_allies(self.actors[o].owner, owner) {
            return;
        }
        if self.idle_on_cell(o) {
            self.nudge(o, Some(from));
        } else {
            self.actors[o].mv.blocking = true;
        }
    }

    /// OpenRA Actor.NotifyBlocker of a structure of `owner` whose top-left
    /// cell is `from` (a factory about to let a unit out of `cell`,
    /// production.rs). In the WebRA movement model, where units hold no
    /// cells and a nudge to a neighbouring cell would only push into the
    /// crowd at the door, idle friendly units standing in `cell` move to the
    /// nearest cell nobody stands in instead.
    pub(crate) fn notify_blockers_at(&mut self, cell: u32, owner: u8, from: u32) {
        if self.cell_moves() {
            let blockers: Vec<usize> = self.others_at(cell, usize::MAX).map(|o| o.actor as usize).collect();
            self.notify_blockers(blockers, owner, from);
            return;
        }
        let here: Vec<usize> = self.units_in_cell(cell as usize).iter().map(|&u| u as usize).collect();
        for o in here {
            let a = &self.actors[o];
            let idle = a.alive && a.activity == Activity::Idle && a.waypoints.is_empty();
            if !idle || a.kind == crate::rules::Kind::Aircraft || !self.is_movable(o) || !self.are_allies(a.owner, owner) {
                continue;
            }
            if let Some(c) = self.nearest_empty_cell(o, cell) {
                let (x, y) = self.cell_point(c);
                self.order_move(&[o], x, y, false);
            }
        }
    }

    /// WebRA movement model: a cell around `cell` (the nearest ring of up to
    /// ten, a random one of that ring) that unit `i` can reach and where no
    /// unit stands.
    fn nearest_empty_cell(&self, i: usize, cell: u32) -> Option<u32> {
        let w = self.map.width;
        let (x, y) = (cell as i32 % w, cell as i32 / w);
        let pass = self.pass_of(i);
        let here = self.cell_at(self.actors[i].x, self.actors[i].y) as usize;
        for r in 1..=10i32 {
            let mut ring = Vec::new();
            for dy in -r..=r {
                for dx in -r..=r {
                    if (dx.abs() != r && dy.abs() != r) || !self.map.contains(x + dx, y + dy) {
                        continue;
                    }
                    let c = self.map.idx(x + dx, y + dy);
                    if !pass.blocked[c] && pass.component[c] == pass.component[here] && self.units_in_cell(c).is_empty() {
                        ring.push(c as u32);
                    }
                }
            }
            if !ring.is_empty() {
                return Some(ring[self.movement_roll(i, Roll::NudgeCell, ring.len() as u64) as usize]);
            }
        }
        None
    }

    /// OpenRA Nudge: unit `o` moves to a free neighbouring cell (else next
    /// to an idle unit it can push on in turn), away from `nudger`'s cell.
    /// Returns whether it moves.
    pub(crate) fn nudge(&mut self, o: usize, nudger: Option<u32>) -> bool {
        if !self.is_movable(o) || !self.occupies_cells(o) || self.actors[o].mv.to == NONE {
            return false;
        }
        let Some(cell) = self.adjacent_cell(o, nudger) else { return false };
        let (x, y) = self.cell_point(cell);
        self.order_move(&[o], x, y, false);
        self.actors[o].mv.order_near = 0;
        true
    }

    /// OpenRA Mobile.GetAdjacentEnterableCell: a random free neighbouring
    /// cell unit `i` may stay on.
    pub(crate) fn adjacent_enterable_cell(&mut self, i: usize, avoid: Option<u32>) -> Option<u32> {
        let here = self.actors[i].mv.to;
        let cells = self.neighbour_cells(here);
        let free: Vec<u32> = cells
            .into_iter()
            .filter(|&c| {
                Some(c) != avoid && self.can_step(i, here, c) && self.can_enter_cell(i, c, Blocking::All) && self.can_stay_in_cell(c)
            })
            .collect();
        if free.is_empty() {
            return None;
        }
        Some(free[self.movement_roll(i, Roll::FreeCell, free.len() as u64) as usize])
    }

    /// OpenRA Mobile.GetAdjacentCell: a free neighbouring cell, else a
    /// neighbouring cell (not `nudger`'s) with an idle unit that can be
    /// nudged on.
    fn adjacent_cell(&mut self, i: usize, nudger: Option<u32>) -> Option<u32> {
        if let Some(c) = self.adjacent_enterable_cell(i, None) {
            return Some(c);
        }
        let here = self.actors[i].mv.to;
        let cells: Vec<u32> = self
            .neighbour_cells(here)
            .into_iter()
            .filter(|&c| Some(c) != nudger && self.can_step(i, here, c))
            .filter(|&c| self.others_at(c, i).any(|o| self.is_movable(o.actor as usize) && self.idle_on_cell(o.actor as usize)))
            .collect();
        if cells.is_empty() {
            return None;
        }
        Some(cells[self.movement_roll(i, Roll::NudgeCell, cells.len() as u64) as usize])
    }

    /// The cells around `cell` on the map, clockwise from north.
    fn neighbour_cells(&self, cell: u32) -> Vec<u32> {
        let w = self.map.width;
        let (x, y) = (cell as i32 % w, cell as i32 / w);
        DIRS.iter().filter(|&&(dx, dy)| self.map.contains(x + dx, y + dy)).map(|&(dx, dy)| self.map.idx(x + dx, y + dy) as u32).collect()
    }

    /// Idle upkeep of the OpenRA model (Mobile.OnBecomingIdle): a unit on a
    /// cell it may only cross (the service depot's pad), or squeezed onto a
    /// cell it may not share, moves to the nearest cell it may stay on.
    /// True when it moves.
    pub(crate) fn cell_idle(&mut self, i: usize) -> bool {
        let _section = crate::profile::scope(crate::profile::Section::Idle);
        if !self.occupies_cells(i) || !self.idle_on_cell(i) {
            return false;
        }
        let here = self.actors[i].mv.to;
        if self.actors[i].mv.crowded || !self.can_stay_in_cell(here) {
            if let Some(c) = self.nearest_stay_cell(i, here) {
                let (x, y) = self.cell_point(c);
                self.order_move(&[i], x, y, false);
                self.actors[i].mv.order_near = 0;
                return true;
            }
        }
        false
    }

    /// The nearest cell around `cell` (ten rings, like OpenRA's
    /// NearestMoveableCell) that unit `i` may enter now and stay on.
    fn nearest_stay_cell(&mut self, i: usize, cell: u32) -> Option<u32> {
        if let Some(c) = self.adjacent_enterable_cell(i, None) {
            return Some(c);
        }
        let w = self.map.width;
        let (x, y) = (cell as i32 % w, cell as i32 / w);
        for r in 2..=10i32 {
            for dy in -r..=r {
                for dx in -r..=r {
                    if dx.abs() != r && dy.abs() != r {
                        continue;
                    }
                    if !self.map.contains(x + dx, y + dy) {
                        continue;
                    }
                    let c = self.map.idx(x + dx, y + dy) as u32;
                    let reachable =
                        self.pass_of(i).component[c as usize] == self.pass_of(i).component[cell as usize] || !self.terrain_allows(i, cell);
                    if reachable && self.can_enter_cell(i, c, Blocking::All) && self.can_stay_in_cell(c) {
                        return Some(c);
                    }
                }
            }
        }
        None
    }

    /// OpenRA Scatter (Nudge on the unit itself).
    pub(crate) fn cell_scatter(&mut self, i: usize) {
        let here = self.actors[i].mv.to;
        if here == NONE || !self.occupies_cells(i) {
            return;
        }
        if let Some(c) = self.adjacent_cell(i, Some(here)) {
            let (x, y) = self.cell_point(c);
            self.order_move(&[i], x, y, false);
            self.actors[i].mv.order_near = 0;
        }
    }

    // ---- Crushing ---------------------------------------------------------------------

    /// Soldiers on the cell unit `i` drives into that it would run over:
    /// OpenRA Crushable.WarnCrush, most of them jump aside.
    fn warn_crush(&mut self, i: usize) {
        let cell = self.actors[i].mv.to;
        let victims: Vec<usize> = self.others_at(cell, i).map(|o| o.actor as usize).filter(|&o| self.crushable_by(o, i)).collect();
        for o in victims {
            if self.movement_roll(o, Roll::WarnCrush, 100) as i32 <= WARN_PROBABILITY {
                let from = self.actors[i].mv.from;
                self.actors[o].activity = Activity::Idle;
                self.actors[o].waypoints.clear();
                self.nudge(o, Some(from));
            }
        }
    }

    /// OpenRA Mobile.FinishedMoving: unit `i` crushes what it may on its
    /// cell (its sub-cell; the whole cell for vehicles).
    fn crush_at_cell(&mut self, i: usize) {
        let (cell, sub) = (self.actors[i].mv.to, self.actors[i].mv.to_sub);
        let victims: Vec<usize> = self
            .others_at(cell, i)
            .filter(|o| sub == FULL_CELL || o.sub == FULL_CELL || o.sub == sub)
            .map(|o| o.actor as usize)
            .filter(|&o| self.crushable_by(o, i))
            .collect();
        for o in victims {
            self.run_over(o, i);
        }
    }
}

impl World {
    // ---- Arrival, as the activities ask for it ---------------------------------------

    /// `goal_reached` of the OpenRA model: the move reached `goal`, or the
    /// goal cannot be reached from here at all, or (with `crowd`, a group
    /// move) the move stopped short. A move that stopped short for any
    /// other activity is tried again after a cooldown (`cell_move`).
    pub(crate) fn cell_goal_reached(&mut self, i: usize, goal: u32, crowd: bool) -> bool {
        if self.unreachable_from_here(i, goal) {
            self.cell_move_forget(i);
            return true;
        }
        match self.cell_move_ended(i, goal) {
            Some(MoveResult::Reached) => true,
            Some(MoveResult::Blocked) if crowd => {
                let m = &self.actors[i].mv;
                if m.near > 0 && self.cell_dist2(m.to, goal) > m.near * m.near {
                    self.note_route_blocked(i);
                }
                self.actors[i].mv.cancel();
                true
            }
            _ => false,
        }
    }

    /// WebRA addition: a move order that ended short of its goal because the
    /// way stayed blocked (farther out than it may stop short: units that do
    /// not make way, a jam on a bridge) tells its owner
    /// (`SoundEventKind::RouteBlocked`: a feedback line and a radar ping in
    /// the client, at most one per player every few seconds). OpenRA gives
    /// no feedback; its move cursor only shows terrain that cannot be
    /// reached when the order is given.
    pub(crate) fn note_route_blocked(&mut self, i: usize) {
        let a = &self.actors[i];
        let (tick, owner, ty, x, y) = (self.tick, a.owner, a.ty, a.x, a.y);
        self.sound.push_route_blocked(tick, owner, ty, x, y);
    }

    /// Whether the move of unit `i` toward `goal` is over, reached or
    /// stopped short (a harvester then looks for another ore cell).
    pub(crate) fn move_settled(&mut self, i: usize, goal: u32) -> bool {
        if !self.cell_moves() || !self.occupies_cells(i) {
            return self.goal_reached(i, goal, 0, false);
        }
        if self.unreachable_from_here(i, goal) {
            self.cell_move_forget(i);
            return true;
        }
        match self.cell_move_ended(i, goal) {
            Some(_) => {
                self.actors[i].mv.cancel();
                true
            }
            None => false,
        }
    }

    /// Whether `goal` cannot be reached from the cell unit `i` stands on
    /// (flow fields; a unit on a blocked cell first steps off).
    fn unreachable_from_here(&mut self, i: usize, goal: u32) -> bool {
        if let Some(reachable) = self.reachable_by_area(i, goal) {
            return !reachable;
        }
        let here = self.cell_at(self.actors[i].x, self.actors[i].y);
        self.path_remaining(i, goal).is_none() && self.terrain_allows(i, here)
    }

    /// Whether unit `i` can reach `goal` from where it stands, from the
    /// connectivity labels (flowfield.rs): a neighbouring cell it may step
    /// to, or the same connected area. A unit on a blocked cell (a
    /// structure went up around it) steps off first and counts as able.
    /// None where the labels cannot tell: a unit that crushes walls when
    /// walls it might crush stand on the map (whose owners decide).
    pub(crate) fn reachable_by_area(&self, i: usize, goal: u32) -> Option<bool> {
        let here = self.cell_at(self.actors[i].x, self.actors[i].y);
        if self.adjacent_cells(here, goal) && self.can_step(i, here, goal) {
            return Some(true);
        }
        let pass = self.pass_of(i);
        if self.flow_crusher(i) != 0 {
            return None;
        }
        if pass.blocked[here as usize] {
            return Some(true);
        }
        Some(!pass.blocked[goal as usize] && pass.component[here as usize] == pass.component[goal as usize])
    }
}

/// What a movement die is rolled for (`World::movement_roll`).
#[derive(Clone, Copy)]
enum Roll {
    Cooldown = 1,
    FreeCell = 2,
    NudgeCell = 3,
    WarnCrush = 4,
}

impl World {
    /// A die of `sides` sides for actor `i` this tick (OpenRA rolls
    /// SharedRandom for these). Movement keeps its own dice, drawn from the
    /// game seed, the tick and the actor, so the game's random numbers
    /// (combat, AI) go the same way whatever happens in a crowd.
    fn movement_roll(&self, i: usize, what: Roll, sides: u64) -> u64 {
        claim_rank(self.claim_salt ^ ((what as u64) << 56), self.tick, i) % sides.max(1)
    }
}

/// A unit's rank for this tick among units that want the same free cell
/// (`World::claimed_first_by_other`): SplitMix64 of the game's salt, the
/// tick and the actor.
fn claim_rank(salt: u64, tick: u32, actor: usize) -> u64 {
    let mut z = (((tick as u64) << 32 | actor as u64) ^ salt).wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

//! Moving into weapon range: OpenRA's MoveWithinRange (Activities/Move/
//! MoveWithinRange.cs), which the Attack activity queues when its target
//! is out of range or inside minimum range.
//!
//! The goal is not the target's cell but any cell from which the target is
//! in range (at least the minimum range, at most the maximum, measured to
//! the target's hit shape from the point the unit stands on), that the unit
//! can enter, stay in and reach. Of those, the unit drives to the nearest
//! by route (OpenRA PathFinder.FindPathToTargetCells), so a unit that only
//! has to come a few cells closer does so, and a row of artillery or ships
//! shifts up beside its front units instead of heading for the one cell
//! nearest the target (around the whole row, or along the coast to the far
//! side of a peninsula). A unit already in range does not move (combat.rs
//! fires first), and the goal is found again when the target moves on.
//!
//! In the OpenRA movement model the cells other units hold do not count as
//! goals (Mobile.CanEnterCell), and the route is searched around every
//! unit, then around standing ones, then around those that cannot be asked
//! to move (Move.PathSearchOrder). In the WebRA model units do not hold
//! cells: cells with another unit standing in them are left out, the route
//! is searched over the terrain, and the unit follows the flow field to the
//! cell found.
//!
//! Differences from OpenRA:
//! - A route to a free cell may cost at most twice the straight way to the
//!   ring of cells in range plus `DETOUR_SLACK` (OpenRA takes any route).
//!   When the only free cells in range lie farther round, the unit instead
//!   drives up behind the own units that hold the nearer ones and waits
//!   there, looking again every `RETRY_TICKS` (a unit of the row that is
//!   done, or dies, frees a cell): it shifts up instead of circling the map.
//! - When no capped route exists at all (a target far away round a lake),
//!   the unit follows the flow field toward the cell in range nearest to
//!   it, and searches again every `RETRY_TICKS` until the short search
//!   succeeds on the way. OpenRA's hierarchical path finder searches the
//!   whole way at once.
//! - A unit that stays in one cell for `RANGE_PATIENCE` while moving into
//!   range, with no own unit firing at the same target (whose end would
//!   free the way), gives up: a jam that does not clear, two units each
//!   waiting for the other's cell. OpenRA's Attack retries for good.
//! - The cells in range of one target are worked out once per tick for all
//!   units of the same kind (`World::range_memo`), as OpenRA caches them
//!   per activity and tick.

use crate::combat::FireTarget;
use crate::flowfield::{COST_DIAGONAL, COST_STRAIGHT};
use crate::math::{dist, CELL};
use crate::movement::occupancy::Blocking;
use crate::movement::MoveResult;
use crate::rules::Domain;
use crate::world::{cell_center, Activity, World, NONE};

/// Route cost a detour to a free cell in range may add beyond twice the
/// straight way (ten straight cells).
const DETOUR_SLACK: u32 = 10 * COST_STRAIGHT;
/// Ticks before a unit that is waiting short of range (or heading for a
/// far one along the flow field) searches for a way into range again.
pub(crate) const RETRY_TICKS: u32 = 25;
/// Ticks a unit moving into range may stay in one cell, with no own unit
/// firing at the same target, before it gives up (20 seconds).
pub(crate) const RANGE_PATIENCE: u32 = 25 * 20;
/// How far infantry may stand from the centre of their cell (a corner
/// sub-cell, movement/occupancy.rs): a cell counts as in range for them
/// only when every point of it does.
const SUB_CELL_REACH: i32 = 363;

/// What `World::plan_range` found.
enum Plan {
    /// Drive to this free cell, along this route in the OpenRA model (next
    /// cell last, empty when the unit stands on it).
    Route(u32, Vec<u32>),
    /// Drive up behind the units that hold the nearest cells in range,
    /// along this route, and search again later.
    Behind(u32, Vec<u32>),
    /// No short route: head for this cell along the flow field and search
    /// again later.
    Toward(u32),
}

/// The cells in range of one target for one kind of unit in one area
/// (`World::range_memo`): the target, minimum and maximum range, the
/// passability (locomotor), crush mask, connectivity label and the
/// infantry margin.
pub(crate) type RangeKey = (u8, i32, i32, i32, i32, usize, u8, u32, i32);

impl World {
    /// The cells (sorted) from which unit `i` has `ft` within `min` and
    /// `max` (`fire_target_distance` from the point it stands on), that it
    /// can stand on and reach from where it is. Empty for aircraft (they
    /// fly straight, `approach`) and when nothing is in reach.
    pub(crate) fn range_cells(&self, i: usize, ft: FireTarget, min: i32, max: i32) -> Vec<u32> {
        let Some((_, _, _, _, _, _, mask, label, margin)) = self.range_key(i, ft, min, max) else { return Vec::new() };
        let pass = self.pass_of(i);
        let labels = pass.components_for(mask);
        let (tx, ty) = self.fire_target_pos(ft);
        let w = self.map.width;
        // Structures are hit at their footprint, so cells farther from the
        // centre may be in range.
        let extent = match ft {
            FireTarget::Actor(t) => self.target_extent(t),
            FireTarget::Ground(..) => 0,
        };
        let r = (max + extent) / CELL + 2;
        let (cx, cy) = self.cell_of(tx, ty);
        let mut cells = Vec::new();
        for y in (cy - r).max(0)..=(cy + r).min(self.map.height - 1) {
            for x in (cx - r).max(0)..=(cx + r).min(w - 1) {
                let c = self.map.idx(x, y);
                if labels[c] != label || !pass.open_for(c, mask) || !self.can_stay_in_cell(c as u32) {
                    continue;
                }
                let d = self.fire_target_distance(ft, cell_center(x), cell_center(y));
                if d + margin <= max && (min <= 0 || d - margin >= min) {
                    cells.push(c as u32);
                }
            }
        }
        cells
    }

    /// The memo key of `range_cells` for unit `i`, None for aircraft and
    /// for a unit that cannot move anywhere (no open cell around it).
    fn range_key(&self, i: usize, ft: FireTarget, min: i32, max: i32) -> Option<RangeKey> {
        let d = self.domain_of(i);
        if d == Domain::Air {
            return None;
        }
        let loco = self.rules.actors[self.actors[i].ty as usize].unit.as_ref()?.locomotor;
        let mask = if d == Domain::Ground { self.crush_mask(i) } else { 0 };
        let pass = self.pass_of(i);
        let (tx, ty) = self.fire_target_pos(ft);
        let from = self.cell_of(tx, ty);
        let ci = self.standing_cell(i, pass, mask, from)?;
        let label = pass.components_for(mask)[ci];
        let margin = if self.shares_cell(i) { SUB_CELL_REACH } else { 0 };
        let (kind, a, b) = match ft {
            FireTarget::Actor(t) => (0, t as i32, 0),
            FireTarget::Ground(x, y) => (1, x, y),
        };
        Some((kind, a, b, min, max, loco, mask, label, margin))
    }

    /// `range_cells`, shared by every unit asking the same this tick.
    fn range_cells_memo(&mut self, i: usize, ft: FireTarget, min: i32, max: i32) -> Vec<u32> {
        let Some(key) = self.range_key(i, ft, min, max) else { return Vec::new() };
        if let Some((_, cells)) = self.range_memo.iter().find(|(k, _)| *k == key) {
            return cells.clone();
        }
        let cells = self.range_cells(i, ft, min, max);
        self.range_memo.push((key, cells.clone()));
        cells
    }

    /// Whether no other unit stands in `cell` for unit `i` to take: in the
    /// OpenRA model, whether it may enter the cell with every unit counted
    /// (Mobile.CanEnterCell); in the WebRA model, whether no other unit on
    /// the ground stands there (one driving through does not count).
    fn range_cell_free(&self, i: usize, cell: u32) -> bool {
        if self.cell_moves() && self.occupies_cells(i) {
            return self.can_enter_cell(i, cell, Blocking::All);
        }
        self.units_in_cell(cell as usize).iter().all(|&u| {
            let u = u as usize;
            u == i || self.actors[u].altitude > 0 || !self.actors[u].in_world() || self.actors[u].moved
        })
    }

    /// Whether the free cell `cell` unit `i` heads for is still free for it
    /// (only units on the move pass through it; WebRA model: nobody stands
    /// there).
    fn range_goal_still_free(&self, i: usize, cell: u32) -> bool {
        if self.cell_moves() && self.occupies_cells(i) {
            return self.can_enter_cell(i, cell, Blocking::Stationary);
        }
        self.range_cell_free(i, cell)
    }

    /// This tick's goal cells of the units moving into range of something
    /// (`range_claims`, sorted by cell), built once per tick. A unit whose
    /// goal is a stand-in (waiting behind others, heading for a far cell)
    /// claims nothing.
    fn build_range_claims(&mut self) {
        if self.range_claims_tick == self.tick {
            return;
        }
        self.range_claims_tick = self.tick;
        self.range_claims.clear();
        for (j, a) in self.actors.iter().enumerate() {
            if a.alive
                && matches!(a.activity, crate::world::Activity::Attack | crate::world::Activity::AttackGround)
                && a.goal != NONE
                && a.chase_cell != NONE
                && a.range_retry == 0
            {
                self.range_claims.push((a.goal, j as u32));
            }
        }
        self.range_claims.sort_unstable();
    }

    /// Unit `i` now heads for `cell` (claims it when `claim`): its earlier
    /// claim this tick is gone.
    fn claim_range_cell(&mut self, i: usize, cell: u32, claim: bool) {
        if self.range_claims_tick != self.tick {
            return;
        }
        self.range_claims.retain(|&(_, u)| u as usize != i);
        if claim {
            let k = self.range_claims.partition_point(|&e| e < (cell, i as u32));
            self.range_claims.insert(k, (cell, i as u32));
        }
    }

    /// Unit `i` is in range and fires: its move into range is over (OpenRA
    /// MoveWithinRange.ShouldStop). It searches afresh once the target is
    /// out of range again.
    pub(crate) fn range_reached(&mut self, i: usize) {
        let a = &mut self.actors[i];
        if a.chase_cell != NONE {
            a.chase_cell = NONE;
            a.goal = NONE;
            a.range_retry = 0;
            a.range_cell = NONE;
        }
    }

    /// Whether unit `i` waits short of range: behind other units, or
    /// heading for a far cell in range until a short way shows up (the AI
    /// re-tasks such units, ai_squads.rs).
    pub(crate) fn range_waiting(&self, i: usize) -> bool {
        let a = &self.actors[i];
        matches!(a.activity, Activity::Attack | Activity::AttackGround) && a.chase_cell != NONE && a.range_retry != 0
    }

    /// Whether unit `i` attacks and has its target in reach now: it fires
    /// (or aims), as opposed to moving into range or waiting.
    pub(crate) fn attack_firing(&self, i: usize) -> bool {
        let a = &self.actors[i];
        match a.activity {
            Activity::Attack => self.live_target(i).is_some_and(|t| self.in_reach(i, t)),
            Activity::AttackGround => {
                let (x, y) = a.fire_at;
                let class = self.ground_class(x, y);
                let d = dist(a.x, a.y, x, y) as i64;
                self.rules.actors[a.ty as usize].reaches_class(&self.rules, class, d * d)
            }
            _ => false,
        }
    }

    /// Whether an own or allied unit other than `i` fires at the target of
    /// `i` (the same actor, or the same spot on the ground) from where it
    /// stands: `i` may be queued behind it.
    fn target_fired_by_others(&self, i: usize) -> bool {
        let me = &self.actors[i];
        self.actors.iter().enumerate().any(|(u, a)| {
            u != i
                && a.alive
                && a.activity == me.activity
                && self.are_allies(me.owner, a.owner)
                && match me.activity {
                    Activity::Attack => a.target == me.target,
                    _ => a.fire_at == me.fire_at,
                }
                && self.attack_firing(u)
        })
    }

    /// Where unit `i` goes to get `ft` within `min` and `max`; None when no
    /// cell in range can be reached at all.
    fn plan_range(&mut self, i: usize, ft: FireTarget, min: i32, max: i32) -> Option<Plan> {
        let cells = self.range_cells_memo(i, ft, min, max);
        if cells.is_empty() {
            return None;
        }
        let w = self.map.width;
        let cell_model = self.cell_moves() && self.occupies_cells(i);
        let (ux, uy) = (self.actors[i].x, self.actors[i].y);
        let here = self.map.idx(self.cell_of(ux, uy).0, self.cell_of(ux, uy).1) as u32;
        // The cell the unit is moving into (where a route starts, Move.EvalPath).
        let from = if cell_model && self.actors[i].mv.to != NONE { self.actors[i].mv.to } else { here };
        let (tx, ty) = self.fire_target_pos(ft);
        let (tcx, tcy) = self.cell_of(tx, ty);
        let extent = match ft {
            FireTarget::Actor(t) => self.target_extent(t),
            FireTarget::Ground(..) => 0,
        };
        let radius = (max + extent + CELL - 1) / CELL;
        // The cap: twice the straight way to the ring of cells in range.
        let (ax, ay) = ((from as i32 % w - tcx).unsigned_abs(), (from as i32 / w - tcy).unsigned_abs());
        let (lo, hi) = (ax.min(ay), ax.max(ay));
        let straight = (lo * COST_DIAGONAL + (hi - lo) * COST_STRAIGHT).saturating_sub(radius as u32 * COST_STRAIGHT);
        let cap = straight * 2 + DETOUR_SLACK;
        // Free: nobody stands there, and no other unit of this kind of
        // move is on its way there (units told to fire at once would all
        // pick the same cell, OpenRA lets them sort it out at the cell).
        self.build_range_claims();
        let claims = std::mem::take(&mut self.range_claims);
        let claimed = |c: u32| {
            let k = claims.partition_point(|&(cc, _)| cc < c);
            claims[k..].iter().take_while(|&&(cc, _)| cc == c).any(|&(_, u)| u as usize != i)
        };
        let free: Vec<u32> = cells.iter().copied().filter(|&c| c == from || (self.range_cell_free(i, c) && !claimed(c))).collect();
        self.range_claims = claims;
        let checks: &[Blocking] = if cell_model { &[Blocking::All, Blocking::Stationary, Blocking::Immovable] } else { &[Blocking::None] };
        for &check in checks {
            if let Some(path) = self.find_path_to_cells(i, from, &free, cap, check) {
                let goal = path.first().copied().unwrap_or(from);
                return Some(Plan::Route(goal, path));
            }
        }
        // The free cells lie too far round: up behind the units that hold
        // the nearer ones, to wait there.
        let last = if cell_model { Blocking::Immovable } else { Blocking::None };
        if free.len() < cells.len() {
            // Not behind what will not make way (an enemy, a structure).
            let behind: Vec<u32> = cells.iter().copied().filter(|&c| c == from || !cell_model || self.can_enter_cell(i, c, last)).collect();
            if let Some(path) = self.find_path_to_cells(i, from, &behind, cap, last) {
                let goal = path.first().copied().unwrap_or(from);
                return Some(Plan::Behind(goal, path));
            }
        }
        // No short way at all: toward the cell in range nearest the unit
        // (free ones first), ties to the lower cell index.
        let pick = |set: &[u32]| {
            set.iter().copied().min_by_key(|&c| {
                let (x, y) = (c as i32 % w, c as i32 / w);
                (dist(ux, uy, cell_center(x), cell_center(y)), c)
            })
        };
        let goal = pick(&free).or_else(|| pick(&cells))?;
        Some(Plan::Toward(goal))
    }

    /// One tick of unit `i` getting `ft` within `min` and `max` (OpenRA
    /// MoveWithinRange). False when it cannot get in range at all (no cell
    /// in range can be reached, or the goal was cut off): the caller gives
    /// up, as OpenRA's Attack ends when its move within range falls short.
    /// Aircraft fly straight toward the target (`approach`).
    pub(crate) fn approach_range(&mut self, i: usize, ft: FireTarget, min: i32, max: i32) -> bool {
        let (tx, ty) = self.fire_target_pos(ft);
        if self.domain_of(i) == Domain::Air {
            return self.approach(i, tx, ty, Some(max));
        }
        let (ux, uy) = (self.actors[i].x, self.actors[i].y);
        let (tcx, tcy) = self.cell_toward(tx, ty, ux, uy);
        let tcell = self.map.idx(tcx, tcy) as u32;
        let a = &self.actors[i];
        let cell_model = self.cell_moves() && self.occupies_cells(i);
        // Waited for a cell that stayed taken (Move ended Blocked): look again.
        // Only a move to a free cell: a stand-in goal (waiting behind
        // others, heading for a far cell) is looked at again on its timer,
        // and its move may stay Blocked meanwhile.
        let blocked = cell_model && a.range_retry == 0 && a.goal != NONE && a.mv.dest == a.goal && a.mv.result == MoveResult::Blocked;
        let retry = a.range_retry != 0 && self.tick >= a.range_retry;
        // Another unit got to the free cell first and stays there.
        let taken = a.range_retry == 0 && a.goal != NONE && a.chase_cell != NONE && !self.range_goal_still_free(i, a.goal);
        // On its goal and still out of range, while the target moved on:
        // after it at once (OpenRA MoveWithinRange repaths whenever the
        // target's cell changed and it is not at the right range).
        let here = self.cell_index(ux, uy) as u32;
        let on_goal = a.goal != NONE && if cell_model { a.mv.to == a.goal && a.mv.from == a.mv.to } else { here == a.goal };
        let followed = on_goal && a.chase_cell != NONE && a.chase_cell != tcell;
        // Waiting time: ticks since the unit last changed cells.
        if a.range_cell != here {
            let tick = self.tick;
            let a = &mut self.actors[i];
            a.range_cell = here;
            a.range_since = tick;
        }
        // Stuck in one cell for long, with nobody of its own firing at the
        // same target (whose end would free the way): a jam that does not
        // clear, two units each waiting for the other's cell. It gives up,
        // as a unit whose move into range falls short does. Looked at once
        // per `RETRY_TICKS` past the patience.
        let waited = self.tick - self.actors[i].range_since;
        if waited >= RANGE_PATIENCE && (waited - RANGE_PATIENCE).is_multiple_of(RETRY_TICKS) && !self.target_fired_by_others(i) {
            return false;
        }
        if self.chase_replan(i, tcell) || blocked || retry || taken || followed {
            let Some(plan) = self.plan_range(i, ft, min, max) else { return false };
            let tick = self.tick;
            let a = &mut self.actors[i];
            a.chase_cell = tcell;
            a.best_dist = i32::MAX;
            a.stuck_ticks = 0;
            a.stall_ticks = 0;
            let (goal, path, retry_at) = match plan {
                Plan::Route(goal, path) => (goal, Some(path), 0),
                Plan::Behind(goal, path) => (goal, Some(path), tick + RETRY_TICKS),
                Plan::Toward(goal) => (goal, None, tick + RETRY_TICKS),
            };
            a.goal = goal;
            a.range_retry = retry_at;
            self.claim_range_cell(i, goal, retry_at == 0);
            if let Some(path) = path.filter(|_| cell_model) {
                self.start_move_along(i, goal, path);
            }
        }
        // The goal may have become unreachable since (a structure went up on it).
        if !self.keep_goal_reachable(i) {
            return false;
        }
        let goal = self.actors[i].goal;
        if goal == NONE {
            return false;
        }
        if self.goal_reached(i, goal, 0, false) {
            // On its goal, or stopped short of it, and still out of range
            // (the target moved a little, the way stayed blocked): wait,
            // and look again in a while.
            if self.actors[i].range_retry == 0 {
                self.actors[i].range_retry = self.tick + RETRY_TICKS;
            }
            return true;
        }
        self.move_toward(i, goal);
        true
    }

    /// Whether unit `i` can get `t` within `range` at all (aircraft always
    /// can): a cell in range lies in the area it can reach.
    pub(crate) fn can_close_in(&self, i: usize, t: usize, range: i32) -> bool {
        self.domain_of(i) == Domain::Air || !self.range_cells(i, FireTarget::Actor(t), 0, range).is_empty()
    }
}

//! Routes around units for the OpenRA movement model: OpenRA's path search
//! with a BlockedByActor check (PathFinder.FindPathToTargetCell).
//!
//! The terrain part of a route comes from the flow fields (flowfield.rs),
//! which know every cell's remaining path length to the goal. That length
//! is the search's estimate for the cells nearer the goal than the unit
//! (farther ones: the straight distance), so an A* that only has to step
//! around a few units expands little more than the route itself; with
//! OpenRA's 125 % heuristic weight a route may be up to a quarter longer
//! than the best.
//! A search gives up after `SEARCH_LIMIT` expanded cells (OpenRA's
//! hierarchical path finder prunes such searches instead): it then counts
//! as no route, and the move falls back to the next weaker check.
//!
//! A route to the nearest of a set of cells (OpenRA
//! PathFinder.FindPathToTargetCells, which MoveWithinRange uses: the cells
//! from which a target is in weapon range, `find_path_to_cells`) is searched
//! backward as OpenRA does: from all of the cells at once toward the unit,
//! so the estimate is the straight distance to one cell, the unit's. Such
//! a search may be capped at a route cost, past which it counts as none.
//!
//! Unlike OpenRA's search there is no lane bias, and equally good cells are
//! taken in an order that does not depend on the side of the map (nearest
//! the goal, then nearest the map centre, as the flow fields do), so units
//! on mirrored spawns drive mirrored routes.

use crate::flowfield::{COST_DIAGONAL, COST_STRAIGHT, DIRS, DIST_NONE};
use crate::movement::occupancy::Blocking;
use crate::world::{World, NONE};
use std::cmp::Reverse;
use std::collections::BinaryHeap;

/// Cells a single search may expand.
pub const SEARCH_LIMIT: u32 = 4096;
/// OpenRA PathFinderInfo.HeuristicWeightPercentage.
pub(crate) const HEURISTIC_WEIGHT: u32 = 125;

/// Per-cell bookkeeping reused by every search (never part of the game
/// state): a cell's entries are valid when its stamp is the current one.
#[derive(Clone, Default)]
pub struct Scratch {
    nodes: Vec<Node>,
    /// The open list's storage, kept between searches.
    open: Vec<Reverse<Open>>,
    current: u32,
    /// Cells expanded by all searches so far (tests and the stress bench).
    pub expanded: u64,
    /// Searches run so far.
    pub searches: u64,
    /// Searches that gave up at `SEARCH_LIMIT`.
    pub limited: u64,
}

/// A cell's entries of the current search, side by side in memory: a
/// search reads all of them for each cell it reaches.
#[derive(Clone, Copy)]
struct Node {
    /// `cost` and `parent` belong to the search with this stamp.
    stamp: u32,
    cost: u32,
    parent: u32,
    /// `step` belongs to the search with this stamp.
    seen: u32,
    /// The cost factor of entering the cell (its terrain speed), or
    /// `u32::MAX` when the unit may not enter it under the search's check.
    /// Asked once per search and cell, though a search reaches a cell from
    /// up to eight neighbours: the answer cannot change while it runs
    /// (nothing moves during a search).
    step: u32,
}

/// An open list entry: estimated total cost, estimate, tie-break, cell,
/// cost so far. Entries never compare equal (a cell is only pushed again at
/// a lower cost), so the order of the search does not depend on the heap.
type Open = (u32, u32, (i32, i32), u32, u32);

const UNSEEN: Node = Node { stamp: 0, cost: 0, parent: NONE, seen: 0, step: 0 };

impl Scratch {
    fn begin(&mut self, cells: usize) {
        if self.nodes.len() != cells {
            self.nodes = vec![UNSEEN; cells];
            self.current = 0;
        }
        self.current = self.current.wrapping_add(1);
        if self.current == 0 {
            self.nodes.iter_mut().for_each(|n| *n = UNSEEN);
            self.current = 1;
        }
        self.searches += 1;
    }

    fn cost_of(&self, c: usize) -> u32 {
        let n = &self.nodes[c];
        if n.stamp == self.current {
            n.cost
        } else {
            u32::MAX
        }
    }

    fn set(&mut self, c: usize, cost: u32, parent: u32) {
        let n = &mut self.nodes[c];
        n.stamp = self.current;
        n.cost = cost;
        n.parent = parent;
    }

    /// `step(c)` (None: the cell may not be entered) asked once per search for cell `c`.
    fn step(&mut self, c: usize, step: impl FnOnce(usize) -> Option<u32>) -> Option<u32> {
        let current = self.current;
        let n = &mut self.nodes[c];
        if n.seen != current {
            n.seen = current;
            n.step = step(c).unwrap_or(u32::MAX);
        }
        (n.step != u32::MAX).then_some(n.step)
    }
}

impl World {
    /// OpenRA Move.EvalPath: the route of unit `i` from the cell it is
    /// moving into to `dest` with the units `check` counts as obstacles,
    /// next cell last (`dest` first). None when there is none (the
    /// destination itself is taken under `check`, or no way was found).
    pub(crate) fn find_path(&mut self, i: usize, dest: u32, check: Blocking) -> Option<Vec<u32>> {
        let _section = crate::profile::scope(crate::profile::Section::RouteSearch);
        let from = self.actors[i].mv.to;
        if from == NONE || dest as usize >= self.map.cells() {
            return None;
        }
        if from == dest {
            return Some(Vec::new());
        }
        // The target cell must be enterable (PathFinder: bail early).
        if !self.can_enter_cell(i, dest, check) {
            return None;
        }
        // A neighbouring cell needs no search (PathFinder does the same).
        if self.adjacent_cells(from, dest) {
            return self.can_step(i, from, dest).then(|| vec![dest]);
        }
        // The flow field as far as the unit: the estimate of the cells.
        self.unit_flow_field_from(i, dest, from as usize)?;
        let mut scratch = std::mem::take(&mut self.search);
        let path = self.search_route(i, from, dest, check, &mut scratch);
        self.search = scratch;
        path
    }

    /// The A* of `find_path`, once the flow field toward `dest` is up to
    /// date as far as `from` (`unit_flow_field_from`).
    fn search_route(&self, i: usize, from: u32, dest: u32, check: Blocking, s: &mut Scratch) -> Option<Vec<u32>> {
        let ty = self.actors[i].ty as usize;
        let loco_index = self.rules.actors[ty].unit.as_ref()?.locomotor;
        let loco = &self.rules.locomotors[loco_index];
        // How far a partial field reaches beyond the unit's cell depends on
        // which units asked for it before, so only the cells nearer the goal
        // than the unit's own are read from it: those it always covers. The
        // route is the same whatever the cache held, as in a replay or after
        // loading a save.
        let field = self.flow.cached(dest, loco_index as u8, self.flow_crusher(i));
        let covered = field.map_or(0, |f| if f.dist[from as usize] == DIST_NONE { 0 } else { f.dist[from as usize] });
        let w = self.map.width;
        let (dx, dy) = (dest as i32 % w, dest as i32 / w);
        let estimate = |c: usize| -> u32 {
            if let Some(f) = field {
                if f.dist[c] < covered {
                    return f.dist[c] as u32 * COST_STRAIGHT;
                }
            }
            // Beyond the field: the straight-line octile distance on the
            // fastest terrain (roads).
            let (ax, ay) = ((c as i32 % w - dx).unsigned_abs(), (c as i32 / w - dy).unsigned_abs());
            let (lo, hi) = (ax.min(ay), ax.max(ay));
            (lo * COST_DIAGONAL + (hi - lo) * COST_STRAIGHT) * 80 / 100
        };
        let enter_cost = |c: usize| -> u32 { 10_000 / loco.speeds[self.map.speed_class(c)].max(1) as u32 };
        // `terrain_allows`, with the unit's passability looked up once.
        let pass = self.pass_of(i);
        let blocked = |c: usize| pass.blocked[c] && !(pass.crush[c] != 0 && self.crushes_wall_at(i, c));
        // Ties: nearer the goal, then nearer the map centre (mirror neutral).
        let tie = |c: usize| {
            let (x, y) = (c as i32 % w, c as i32 / w);
            ((x - dx).pow(2) + (y - dy).pow(2), crate::flowfield::centre_distance(&self.map, x, y))
        };
        s.begin(self.map.cells());
        s.set(from as usize, 0, NONE);
        let mut heap = BinaryHeap::from(std::mem::take(&mut s.open));
        let h0 = estimate(from as usize);
        heap.push(Reverse((h0 * HEURISTIC_WEIGHT / 100, h0, tie(from as usize), from, 0u32)));
        let mut expanded = 0u32;
        let mut found = false;
        while let Some(Reverse((_, _, _, c, g))) = heap.pop() {
            let c = c as usize;
            if c == dest as usize {
                found = true;
                break;
            }
            // A stale entry: the cell was reached cheaper since.
            if g > s.cost_of(c) {
                continue;
            }
            expanded += 1;
            if expanded > SEARCH_LIMIT {
                s.limited += 1;
                break;
            }
            let (x, y) = (c as i32 % w, c as i32 / w);
            for (d, &(ox, oy)) in DIRS.iter().enumerate() {
                let (nx, ny) = (x + ox, y + oy);
                if !self.map.contains(nx, ny) {
                    continue;
                }
                let n = self.map.idx(nx, ny);
                if blocked(n) {
                    continue;
                }
                // Diagonal steps do not cut a blocked corner (flowfield::step).
                if ox != 0 && oy != 0 && (blocked(self.map.idx(x + ox, y)) || blocked(self.map.idx(x, y + oy))) {
                    continue;
                }
                let step = if n == dest as usize {
                    enter_cost(n)
                } else {
                    match s.step(n, |n| self.can_enter_cell(i, n as u32, check).then(|| enter_cost(n))) {
                        Some(step) => step,
                        None => continue,
                    }
                };
                let base = if d % 2 == 0 { COST_STRAIGHT } else { COST_DIAGONAL };
                let ng = g + base * step / 100;
                if ng < s.cost_of(n) {
                    s.set(n, ng, c as u32);
                    let hn = estimate(n);
                    heap.push(Reverse((ng + hn * HEURISTIC_WEIGHT / 100, hn, tie(n), n as u32, ng)));
                }
            }
        }
        s.expanded += expanded as u64;
        s.open = heap.into_vec();
        s.open.clear();
        if !found {
            return None;
        }
        let mut path = Vec::new();
        let mut c = dest;
        while c != from {
            path.push(c);
            c = s.nodes[c as usize].parent;
        }
        Some(path)
    }
}

impl World {
    /// OpenRA PathFinder.FindPathToTargetCells: the route of unit `i` from
    /// cell `from` to the nearest (by route cost) of `goals` with the units
    /// `check` counts as obstacles, next cell last (the goal reached
    /// first); empty when `from` is one of them. None when there is none
    /// costing at most `max_cost` (a straight step on clear ground costs
    /// `COST_STRAIGHT`), or the search gave up at `SEARCH_LIMIT`. The goals
    /// are taken as they are: callers pick cells the unit may enter and
    /// stay in.
    pub(crate) fn find_path_to_cells(&mut self, i: usize, from: u32, goals: &[u32], max_cost: u32, check: Blocking) -> Option<Vec<u32>> {
        let _section = crate::profile::scope(crate::profile::Section::RouteSearch);
        if from as usize >= self.map.cells() || goals.is_empty() {
            return None;
        }
        if goals.contains(&from) {
            return Some(Vec::new());
        }
        // A unit boxed in under `check` has no route: a backward search
        // would only find that out after searching everything up to the cap.
        let w = self.map.width;
        let (fx, fy) = (from as i32 % w, from as i32 / w);
        let way_out = DIRS.iter().any(|&(dx, dy)| {
            self.map.contains(fx + dx, fy + dy) && {
                let n = self.map.idx(fx + dx, fy + dy) as u32;
                self.can_step(i, from, n) && self.can_enter_cell(i, n, check)
            }
        });
        if !way_out {
            return None;
        }
        let mut scratch = std::mem::take(&mut self.search);
        let path = self.search_back(i, from, goals, max_cost, check, &mut scratch);
        self.search = scratch;
        path
    }

    /// The A* of `find_path_to_cells`, from every goal toward `from` (OpenRA
    /// searches such routes in reverse too). A step from cell `c` to its
    /// neighbour `n` is the unit's step from `n` into `c`: it costs what
    /// entering `c` costs, and `n` must be a cell the unit may enter, unless
    /// it is `from` itself.
    fn search_back(&self, i: usize, from: u32, goals: &[u32], max_cost: u32, check: Blocking, s: &mut Scratch) -> Option<Vec<u32>> {
        let ty = self.actors[i].ty as usize;
        let loco = &self.rules.locomotors[self.rules.actors[ty].unit.as_ref()?.locomotor];
        let w = self.map.width;
        let (fx, fy) = (from as i32 % w, from as i32 / w);
        // The straight-line octile distance on the fastest terrain (roads).
        let estimate = |c: usize| -> u32 {
            let (ax, ay) = ((c as i32 % w - fx).unsigned_abs(), (c as i32 / w - fy).unsigned_abs());
            let (lo, hi) = (ax.min(ay), ax.max(ay));
            (lo * COST_DIAGONAL + (hi - lo) * COST_STRAIGHT) * 80 / 100
        };
        let enter_cost = |c: usize| -> u32 { 10_000 / loco.speeds[self.map.speed_class(c)].max(1) as u32 };
        let pass = self.pass_of(i);
        let blocked = |c: usize| pass.blocked[c] && !(pass.crush[c] != 0 && self.crushes_wall_at(i, c));
        // Ties: nearer the unit, then nearer the map centre (mirror neutral).
        let tie = |c: usize| {
            let (x, y) = (c as i32 % w, c as i32 / w);
            ((x - fx).pow(2) + (y - fy).pow(2), crate::flowfield::centre_distance(&self.map, x, y))
        };
        s.begin(self.map.cells());
        let mut heap = BinaryHeap::from(std::mem::take(&mut s.open));
        for &g in goals {
            let g = g as usize;
            if g >= self.map.cells() || s.cost_of(g) == 0 {
                continue;
            }
            s.set(g, 0, NONE);
            let h = estimate(g);
            heap.push(Reverse((h * HEURISTIC_WEIGHT / 100, h, tie(g), g as u32, 0u32)));
        }
        let mut expanded = 0u32;
        let mut found = false;
        while let Some(Reverse((_, _, _, c, g))) = heap.pop() {
            let c = c as usize;
            if c == from as usize {
                found = true;
                break;
            }
            if g > s.cost_of(c) {
                continue;
            }
            expanded += 1;
            if expanded > SEARCH_LIMIT {
                s.limited += 1;
                break;
            }
            let into = enter_cost(c);
            let (x, y) = (c as i32 % w, c as i32 / w);
            for (d, &(ox, oy)) in DIRS.iter().enumerate() {
                let (nx, ny) = (x + ox, y + oy);
                if !self.map.contains(nx, ny) {
                    continue;
                }
                let n = self.map.idx(nx, ny);
                // `from` may be a cell the unit cannot enter (it stands on it).
                if n != from as usize {
                    if blocked(n) {
                        continue;
                    }
                    if s.step(n, |n| self.can_enter_cell(i, n as u32, check).then_some(0)).is_none() {
                        continue;
                    }
                }
                // Diagonal steps do not cut a blocked corner (flowfield::step).
                if ox != 0 && oy != 0 && (blocked(self.map.idx(x + ox, y)) || blocked(self.map.idx(x, y + oy))) {
                    continue;
                }
                let base = if d % 2 == 0 { COST_STRAIGHT } else { COST_DIAGONAL };
                let ng = g + base * into / 100;
                if ng < s.cost_of(n) && ng <= max_cost {
                    s.set(n, ng, c as u32);
                    let hn = estimate(n);
                    heap.push(Reverse((ng + hn * HEURISTIC_WEIGHT / 100, hn, tie(n), n as u32, ng)));
                }
            }
        }
        s.expanded += expanded as u64;
        s.open = heap.into_vec();
        s.open.clear();
        if !found {
            return None;
        }
        // Parents lead from the unit to the goal: the route is that chain,
        // goal first, the cell after `from` last.
        let mut path = Vec::new();
        let mut c = s.nodes[from as usize].parent;
        while c != NONE {
            path.push(c);
            c = s.nodes[c as usize].parent;
        }
        path.reverse();
        Some(path)
    }
}

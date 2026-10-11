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
const HEURISTIC_WEIGHT: u32 = 125;

/// Per-cell bookkeeping reused by every search (never part of the game
/// state): a cell's entries are valid when its stamp is the current one.
#[derive(Clone, Default)]
pub struct Scratch {
    stamp: Vec<u32>,
    cost: Vec<u32>,
    parent: Vec<u32>,
    current: u32,
    /// Cells expanded by all searches so far (tests and the stress bench).
    pub expanded: u64,
    /// Searches run so far.
    pub searches: u64,
}

impl Scratch {
    fn begin(&mut self, cells: usize) {
        if self.stamp.len() != cells {
            self.stamp = vec![0; cells];
            self.cost = vec![0; cells];
            self.parent = vec![NONE; cells];
            self.current = 0;
        }
        self.current = self.current.wrapping_add(1);
        if self.current == 0 {
            self.stamp.iter_mut().for_each(|s| *s = 0);
            self.current = 1;
        }
        self.searches += 1;
    }

    fn cost_of(&self, c: usize) -> u32 {
        if self.stamp[c] == self.current {
            self.cost[c]
        } else {
            u32::MAX
        }
    }

    fn set(&mut self, c: usize, cost: u32, parent: u32) {
        self.stamp[c] = self.current;
        self.cost[c] = cost;
        self.parent[c] = parent;
    }
}

impl World {
    /// OpenRA Move.EvalPath: the route of unit `i` from the cell it is
    /// moving into to `dest` with the units `check` counts as obstacles,
    /// next cell last (`dest` first). None when there is none (the
    /// destination itself is taken under `check`, or no way was found).
    pub(crate) fn find_path(&mut self, i: usize, dest: u32, check: Blocking) -> Option<Vec<u32>> {
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
        let blocked = |c: usize| !self.terrain_allows(i, c as u32);
        // Ties: nearer the goal, then nearer the map centre (mirror neutral).
        let tie = |c: usize| {
            let (x, y) = (c as i32 % w, c as i32 / w);
            ((x - dx).pow(2) + (y - dy).pow(2), crate::flowfield::centre_distance(&self.map, x, y))
        };
        s.begin(self.map.cells());
        s.set(from as usize, 0, NONE);
        let mut heap = BinaryHeap::new();
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
                if n != dest as usize && !self.can_enter_cell(i, n as u32, check) {
                    continue;
                }
                let base = if d % 2 == 0 { COST_STRAIGHT } else { COST_DIAGONAL };
                let ng = g + base * enter_cost(n) / 100;
                if ng < s.cost_of(n) {
                    s.set(n, ng, c as u32);
                    let hn = estimate(n);
                    heap.push(Reverse((ng + hn * HEURISTIC_WEIGHT / 100, hn, tie(n), n as u32, ng)));
                }
            }
        }
        s.expanded += expanded as u64;
        if !found {
            return None;
        }
        let mut path = Vec::new();
        let mut c = dest;
        while c != from {
            path.push(c);
            c = s.parent[c as usize];
        }
        Some(path)
    }
}

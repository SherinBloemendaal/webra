//! Flow-field pathfinding.
//!
//! A flow field stores, for every cell, the neighbour to step to on the
//! cheapest route to one goal cell. All units heading to the same goal with
//! the same locomotor share one field, so a thousand units cost about as much
//! as one. Fields are cached and rebuilt lazily when passability changes.

use crate::map::Map;
use crate::rules::Locomotor;
use std::cmp::Reverse;
use std::collections::{BTreeMap, BinaryHeap};

/// Neighbour offsets, clockwise from north.
pub const DIRS: [(i32, i32); 8] = [(0, -1), (1, -1), (1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1)];
pub const DIR_GOAL: u8 = 8;
pub const DIR_NONE: u8 = 255;

const COST_STRAIGHT: u32 = 100;
const COST_DIAGONAL: u32 = 141;
const MAX_CACHED: usize = 256;

pub struct FlowField {
    pub goal: u32,
    pub loco: u8,
    pub version: u32,
    pub dirs: Vec<u8>,
    pub last_used: u64,
}

/// Passability shared by all ground locomotors, plus per-cell connectivity labels.
pub struct Passability {
    pub blocked: Vec<bool>,
    pub component: Vec<u32>,
    pub version: u32,
    dirty: bool,
}

impl Passability {
    /// Passability for land units.
    pub fn new(map: &Map) -> Self {
        Passability::with(map, |t| t.passable())
    }

    /// Passability for ships: open water only.
    pub fn water(map: &Map) -> Self {
        Passability::with(map, |t| t == crate::map::Terrain::Water)
    }

    fn with(map: &Map, open: impl Fn(crate::map::Terrain) -> bool) -> Self {
        let blocked = map.terrain.iter().map(|&t| !open(t)).collect();
        let mut p = Passability { blocked, component: vec![0; map.cells()], version: 1, dirty: true };
        p.refresh(map);
        p
    }

    pub fn set_blocked(&mut self, i: usize, b: bool) {
        if self.blocked[i] != b {
            self.blocked[i] = b;
            self.dirty = true;
        }
    }

    /// Recompute connectivity labels after passability changed. Returns true if anything changed.
    pub fn refresh(&mut self, map: &Map) -> bool {
        if !self.dirty {
            return false;
        }
        self.dirty = false;
        self.version += 1;
        let n = map.cells();
        self.component.iter_mut().for_each(|c| *c = 0);
        let mut next = 1u32;
        let mut stack = Vec::new();
        for start in 0..n {
            if self.blocked[start] || self.component[start] != 0 {
                continue;
            }
            self.component[start] = next;
            stack.push(start);
            while let Some(i) = stack.pop() {
                let (x, y) = ((i as i32) % map.width, (i as i32) / map.width);
                for d in 0..8 {
                    if let Some(j) = step(map, &self.blocked, x, y, d) {
                        if self.component[j] == 0 {
                            self.component[j] = next;
                            stack.push(j);
                        }
                    }
                }
            }
            next += 1;
        }
        true
    }
}

/// Neighbour index of (x, y) in direction `d` if the step is legal: the
/// target is passable and diagonal steps do not cut a blocked corner.
#[inline]
pub fn step(map: &Map, blocked: &[bool], x: i32, y: i32, d: usize) -> Option<usize> {
    let (dx, dy) = DIRS[d];
    let (nx, ny) = (x + dx, y + dy);
    if !map.contains(nx, ny) {
        return None;
    }
    let j = map.idx(nx, ny);
    if blocked[j] {
        return None;
    }
    if dx != 0 && dy != 0 && (blocked[map.idx(x + dx, y)] || blocked[map.idx(x, y + dy)]) {
        return None;
    }
    Some(j)
}

pub struct FlowCache {
    fields: Vec<FlowField>,
    index: BTreeMap<(u32, u8), usize>,
    clock: u64,
    pub computed: u64,
}

impl FlowCache {
    pub fn new() -> Self {
        FlowCache { fields: Vec::new(), index: BTreeMap::new(), clock: 0, computed: 0 }
    }

    /// Direction byte for `cell` in the field toward `goal`, computing the field if needed.
    pub fn dir(&mut self, map: &Map, pass: &Passability, locos: &[Locomotor], goal: u32, loco: u8, cell: usize) -> u8 {
        let f = self.get(map, pass, locos, goal, loco);
        self.fields[f].dirs[cell]
    }

    fn get(&mut self, map: &Map, pass: &Passability, locos: &[Locomotor], goal: u32, loco: u8) -> usize {
        self.clock += 1;
        if let Some(&i) = self.index.get(&(goal, loco)) {
            self.fields[i].last_used = self.clock;
            if self.fields[i].version != pass.version {
                compute(map, pass, &locos[loco as usize], goal, &mut self.fields[i].dirs);
                self.fields[i].version = pass.version;
                self.computed += 1;
            }
            return i;
        }
        let slot = if self.fields.len() < MAX_CACHED {
            self.fields.push(FlowField { goal, loco, version: 0, dirs: vec![DIR_NONE; map.cells()], last_used: 0 });
            self.fields.len() - 1
        } else {
            // Evict the least recently used field.
            let (i, _) = self.fields.iter().enumerate().min_by_key(|(_, f)| f.last_used).unwrap();
            let old = &self.fields[i];
            self.index.remove(&(old.goal, old.loco));
            i
        };
        let f = &mut self.fields[slot];
        f.goal = goal;
        f.loco = loco;
        f.last_used = self.clock;
        compute(map, pass, &locos[loco as usize], goal, &mut f.dirs);
        f.version = pass.version;
        self.computed += 1;
        self.index.insert((goal, loco), slot);
        slot
    }
}

impl Default for FlowCache {
    fn default() -> Self {
        Self::new()
    }
}

/// Dijkstra from the goal outward. Moving into a cell costs more on slow
/// terrain for this locomotor (OpenRA TerrainSpeeds).
fn compute(map: &Map, pass: &Passability, loco: &Locomotor, goal: u32, dirs: &mut [u8]) {
    let n = map.cells();
    dirs.iter_mut().for_each(|d| *d = DIR_NONE);
    let mut cost = vec![u32::MAX; n];
    let g = goal as usize;
    if g >= n || pass.blocked[g] {
        return;
    }
    let cell_cost = |i: usize| -> u32 {
        let s = loco.speeds[map.speed_class(i)].max(1) as u32;
        100 * 100 / s
    };
    cost[g] = 0;
    dirs[g] = DIR_GOAL;
    let mut heap = BinaryHeap::new();
    heap.push(Reverse((0u32, g as u32)));
    while let Some(Reverse((c, i))) = heap.pop() {
        let i = i as usize;
        if c > cost[i] {
            continue;
        }
        let (x, y) = ((i as i32) % map.width, (i as i32) / map.width);
        let enter = cell_cost(i);
        for d in 0..8 {
            // Neighbour n reaches i by stepping in the opposite direction; the
            // corner rule is symmetric so checking from i is equivalent.
            if let Some(j) = step(map, &pass.blocked, x, y, d) {
                let base = if d % 2 == 0 { COST_STRAIGHT } else { COST_DIAGONAL };
                let nc = c + base * enter / 100;
                if nc < cost[j] {
                    cost[j] = nc;
                    dirs[j] = ((d + 4) % 8) as u8;
                    heap.push(Reverse((nc, j as u32)));
                }
            }
        }
    }
}

/// Nearest cell to `goal` (by straight distance) that lies in `component`.
/// Used when a goal is blocked or on an unreachable island.
pub fn nearest_in_component(map: &Map, pass: &Passability, goal: (i32, i32), component: u32) -> Option<u32> {
    let gi = map.idx(goal.0, goal.1);
    if pass.component[gi] == component && !pass.blocked[gi] {
        return Some(gi as u32);
    }
    let max_r = map.width.max(map.height);
    for r in 1..max_r {
        let mut best: Option<(i32, u32)> = None;
        for y in goal.1 - r..=goal.1 + r {
            for x in goal.0 - r..=goal.0 + r {
                if (x - goal.0).abs() != r && (y - goal.1).abs() != r {
                    continue;
                }
                if !map.contains(x, y) {
                    continue;
                }
                let i = map.idx(x, y);
                if pass.component[i] == component && !pass.blocked[i] {
                    let d = (x - goal.0).pow(2) + (y - goal.1).pow(2);
                    if best.is_none_or(|(bd, bi)| d < bd || (d == bd && (i as u32) < bi)) {
                        best = Some((d, i as u32));
                    }
                }
            }
        }
        if let Some((_, i)) = best {
            return Some(i);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::map::{Map, Terrain};

    fn open_map(w: i32, h: i32) -> Map {
        let n = (w * h) as usize;
        Map { width: w, height: h, terrain: vec![Terrain::Clear; n], ore: vec![0; n], spawns: vec![] }
    }

    fn walk(map: &Map, pass: &Passability, cache: &mut FlowCache, locos: &[Locomotor], from: (i32, i32), goal: u32) -> usize {
        let (mut x, mut y) = from;
        for steps in 0..10_000 {
            let i = map.idx(x, y);
            let d = cache.dir(map, pass, locos, goal, 0, i);
            if d == DIR_GOAL {
                return steps;
            }
            assert_ne!(d, DIR_NONE, "dead end at {x},{y}");
            assert!(!pass.blocked[i]);
            x += DIRS[d as usize].0;
            y += DIRS[d as usize].1;
        }
        panic!("no arrival");
    }

    #[test]
    fn routes_around_a_wall() {
        let mut map = open_map(20, 20);
        for y in 0..18 {
            let i = map.idx(10, y);
            map.terrain[i] = Terrain::Rock;
        }
        let pass = Passability::new(&map);
        let locos = vec![Locomotor {
            name: "t".into(),
            domain: crate::rules::Domain::Ground,
            speeds: vec![100, 50, 88, 0],
            crushes_infantry: true,
        }];
        let mut cache = FlowCache::new();
        let goal = map.idx(15, 2) as u32;
        let steps = walk(&map, &pass, &mut cache, &locos, (2, 2), goal);
        assert!(steps >= 18, "must go around the wall, took {steps}");
        // Second query reuses the cached field.
        walk(&map, &pass, &mut cache, &locos, (5, 5), goal);
        assert_eq!(cache.computed, 1);
    }

    #[test]
    fn unreachable_goal_maps_to_nearest_reachable_cell() {
        let mut map = open_map(20, 20);
        for y in 0..20 {
            let i = map.idx(10, y);
            map.terrain[i] = Terrain::Water;
        }
        let pass = Passability::new(&map);
        let comp = pass.component[map.idx(2, 2)];
        let g = nearest_in_component(&map, &pass, (15, 5), comp).unwrap();
        assert_eq!(g, map.idx(9, 5) as u32);
    }
}

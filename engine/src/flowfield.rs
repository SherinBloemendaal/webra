//! Flow-field pathfinding.
//!
//! A flow field stores, for every cell, the neighbour to step to on the
//! cheapest route to one goal cell. All units heading to the same goal with
//! the same locomotor share one field, so a thousand units cost about as much
//! as one. Fields are cached and rebuilt lazily when passability changes.
//!
//! Next to the direction each field keeps the remaining path length per
//! cell. Units use it to tell real progress from standing in a queue: a
//! detour around a wall moves a unit away from its goal in a straight line
//! but always brings it closer along the path.

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
/// Most fields kept at once.
const MAX_CACHED: usize = 256;
/// Cells kept over all cached fields (three bytes each). Huge maps keep
/// fewer fields so the cache stays near 72 MB; maps up to about 300 x 300
/// cells keep all `MAX_CACHED`.
const CACHE_CELL_BUDGET: usize = 24 << 20;
/// Fewest fields kept, however large the map.
const MIN_CACHED: usize = 32;
/// `FlowField::dist` of a cell that cannot reach the goal.
pub const DIST_NONE: u16 = u16::MAX;

#[derive(Clone)]
pub struct FlowField {
    pub goal: u32,
    pub loco: u8,
    pub version: u32,
    pub dirs: Vec<u8>,
    /// Remaining path cost to the goal per cell, in cell steps on clear
    /// terrain (path cost / `COST_STRAIGHT`, rounded down, saturating below
    /// `DIST_NONE`). It never rises along `dirs`, and drops by at least one
    /// per step wherever the locomotor is not faster than on clear terrain.
    pub dist: Vec<u16>,
    pub last_used: u64,
}

/// Passability shared by all ground locomotors, plus per-cell connectivity labels.
#[derive(Clone)]
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

    /// Passability for ships: open water and fords.
    pub fn water(map: &Map) -> Self {
        Passability::with(map, |t| t.ship_passable())
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

#[derive(Clone)]
pub struct FlowCache {
    fields: Vec<FlowField>,
    index: BTreeMap<(u32, u8), usize>,
    /// Slot of the last field looked up: units of one group ask for the same
    /// field one after another, so this skips most index lookups.
    last: usize,
    clock: u64,
    pub computed: u64,
}

impl FlowCache {
    pub fn new() -> Self {
        FlowCache { fields: Vec::new(), index: BTreeMap::new(), last: usize::MAX, clock: 0, computed: 0 }
    }

    /// Direction byte for `cell` in the field toward `goal`, computing the field if needed.
    pub fn dir(&mut self, map: &Map, pass: &Passability, locos: &[Locomotor], goal: u32, loco: u8, cell: usize) -> u8 {
        let f = self.get(map, pass, locos, goal, loco);
        self.fields[f].dirs[cell]
    }

    /// The field toward `goal` for locomotor `loco`, computing it if needed.
    pub fn field(&mut self, map: &Map, pass: &Passability, locos: &[Locomotor], goal: u32, loco: u8) -> &FlowField {
        let f = self.get(map, pass, locos, goal, loco);
        &self.fields[f]
    }

    /// The cached field toward `goal` for locomotor `loco`, if it exists and
    /// is current for passability `version`. Read only (debug views): never
    /// computes, evicts or touches the use clock.
    pub fn peek(&self, goal: u32, loco: u8, version: u32) -> Option<&[u8]> {
        let &i = self.index.get(&(goal, loco))?;
        let f = &self.fields[i];
        (f.version == version).then_some(f.dirs.as_slice())
    }

    /// Number of cached fields.
    pub fn len(&self) -> usize {
        self.fields.len()
    }

    pub fn is_empty(&self) -> bool {
        self.fields.is_empty()
    }

    fn get(&mut self, map: &Map, pass: &Passability, locos: &[Locomotor], goal: u32, loco: u8) -> usize {
        self.clock += 1;
        let hit = match self.fields.get(self.last) {
            Some(f) if f.goal == goal && f.loco == loco => Some(self.last),
            _ => self.index.get(&(goal, loco)).copied(),
        };
        if let Some(i) = hit {
            self.last = i;
            let f = &mut self.fields[i];
            f.last_used = self.clock;
            if f.version != pass.version {
                compute(map, pass, &locos[loco as usize], goal, &mut f.dirs, &mut f.dist);
                f.version = pass.version;
                self.computed += 1;
            }
            return i;
        }
        let max = (CACHE_CELL_BUDGET / map.cells().max(1)).clamp(MIN_CACHED, MAX_CACHED);
        let slot = if self.fields.len() < max {
            let n = map.cells();
            self.fields.push(FlowField { goal, loco, version: 0, dirs: vec![DIR_NONE; n], dist: vec![DIST_NONE; n], last_used: 0 });
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
        compute(map, pass, &locos[loco as usize], goal, &mut f.dirs, &mut f.dist);
        f.version = pass.version;
        self.computed += 1;
        self.index.insert((goal, loco), slot);
        self.last = slot;
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
fn compute(map: &Map, pass: &Passability, loco: &Locomotor, goal: u32, dirs: &mut [u8], dist: &mut [u16]) {
    let n = map.cells();
    dirs.iter_mut().for_each(|d| *d = DIR_NONE);
    dist.iter_mut().for_each(|d| *d = DIST_NONE);
    let mut cost = vec![u32::MAX; n];
    let g = goal as usize;
    if g >= n || pass.blocked[g] {
        return;
    }
    let ship = loco.domain == crate::rules::Domain::Water;
    let cell_cost = |i: usize| -> u32 {
        let s = loco.speeds[map.speed_class_for(i, ship)].max(1) as u32;
        100 * 100 / s
    };
    cost[g] = 0;
    dirs[g] = DIR_GOAL;
    dist[g] = 0;
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
                    heap.push(Reverse((nc, j as u32)));
                }
            }
        }
    }
    // Pick each cell's direction after the costs are final. Among equally cheap
    // steps the choice must not depend on the scan order (north first, low cell
    // index first), or units would move differently on the two halves of a
    // symmetric map. Prefer the step that ends closest to the goal, then the
    // one closer to the map centre; both stay the same under the mirrorings
    // and rotations a fair map uses.
    let (gx, gy) = ((g as i32) % map.width, (g as i32) / map.width);
    for j in 0..n {
        if cost[j] == u32::MAX || j == g {
            continue;
        }
        // A step costs at least COST_STRAIGHT unless the terrain is faster
        // than clear, so this usually drops by at least one per step.
        dist[j] = (cost[j] / COST_STRAIGHT).min(DIST_NONE as u32 - 1) as u16;
        let (x, y) = ((j as i32) % map.width, (j as i32) / map.width);
        let mut best: Option<(i32, i32, u8)> = None;
        for (d, &(dx, dy)) in DIRS.iter().enumerate() {
            let Some(i) = step(map, &pass.blocked, x, y, d) else { continue };
            if cost[i] == u32::MAX {
                continue;
            }
            let base = if d % 2 == 0 { COST_STRAIGHT } else { COST_DIAGONAL };
            if cost[i] + base * cell_cost(i) / 100 != cost[j] {
                continue;
            }
            let to_goal = (gx - x - dx).pow(2) + (gy - y - dy).pow(2);
            let to_centre = centre_distance(map, x + dx, y + dy);
            if best.is_none_or(|(bd, bc, _)| (to_goal, to_centre) < (bd, bc)) {
                best = Some((to_goal, to_centre, d as u8));
            }
        }
        if let Some((_, _, d)) = best {
            dirs[j] = d;
        }
    }
}

/// Squared distance of a cell to the map centre, in half cells. Used to break
/// ties the same way on every half of a symmetric map.
#[inline]
pub fn centre_distance(map: &Map, x: i32, y: i32) -> i32 {
    (2 * x - (map.width - 1)).pow(2) + (2 * y - (map.height - 1)).pow(2)
}

/// Nearest cell to `goal` (by straight distance) that lies in `component`.
/// Used when a goal is blocked or on an unreachable island. Ties go to the
/// cell closest to `from` (where the units come from), then to the one
/// closest to the map centre, so the choice is the same on both halves of a
/// symmetric map.
pub fn nearest_in_component(map: &Map, pass: &Passability, goal: (i32, i32), component: u32, from: (i32, i32)) -> Option<u32> {
    let gi = map.idx(goal.0, goal.1);
    if pass.component[gi] == component && !pass.blocked[gi] {
        return Some(gi as u32);
    }
    let max_r = map.width.max(map.height);
    for r in 1..max_r {
        let mut best: Option<((i32, i32, i32), u32)> = None;
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
                    let df = (x - from.0).pow(2) + (y - from.1).pow(2);
                    let key = (d, df, centre_distance(map, x, y));
                    if best.is_none_or(|(bk, bi)| key < bk || (key == bk && (i as u32) < bi)) {
                        best = Some((key, i as u32));
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
        Map { width: w, height: h, terrain: vec![Terrain::Clear; n], ore: vec![0; n], gems: vec![0; n], spawns: vec![] }
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
    fn path_length_drops_along_the_field() {
        let mut map = open_map(20, 20);
        for y in 0..18 {
            let i = map.idx(10, y);
            map.terrain[i] = Terrain::Rock;
        }
        for x in 0..20 {
            let i = map.idx(x, 19);
            map.terrain[i] = Terrain::Rough;
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
        let f = cache.field(&map, &pass, &locos, goal, 0);
        assert_eq!(f.dist[goal as usize], 0);
        assert_eq!(f.dist[map.idx(10, 5)], DIST_NONE, "rock");
        for start in 0..map.cells() {
            if pass.blocked[start] {
                continue;
            }
            let (mut x, mut y) = ((start as i32) % 20, (start as i32) / 20);
            loop {
                let i = map.idx(x, y);
                let d = f.dirs[i];
                if d == DIR_GOAL {
                    break;
                }
                let (nx, ny) = (x + DIRS[d as usize].0, y + DIRS[d as usize].1);
                assert!(f.dist[map.idx(nx, ny)] < f.dist[i], "path length drops by a step");
                (x, y) = (nx, ny);
            }
        }
        // Around the wall: from (8, 2) the path is far longer than the 7 cells straight.
        assert!(f.dist[map.idx(8, 2)] >= 20);
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
        let g = nearest_in_component(&map, &pass, (15, 5), comp, (2, 2)).unwrap();
        assert_eq!(g, map.idx(9, 5) as u32);
    }
}

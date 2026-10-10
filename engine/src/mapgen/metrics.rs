//! Fairness measurements of a map, shared by the map tests and the
//! `map_stats` example: what each base gets in ground distance, ore and
//! harbour access, and how much of the map is water.

use crate::map::{Map, Terrain};

/// Cells around a yard that count as "at the base" (the AI's naval reach).
pub const REACH: i32 = 14;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BaseStats {
    /// Ground steps (4-connected, fords included) from this yard to the nearest other yard.
    pub rush: Option<u32>,
    /// Cells of the water network (the largest body of water) within `REACH` cells of the yard.
    pub harbour_cells: u32,
    /// A 3x3 block of open water on the network within `REACH` cells: a naval yard fits.
    pub naval_yard_site: bool,
    /// Steps by water from the hub of the water network (on the mirror axis,
    /// where the generator starts the network) to this base's harbour (None
    /// without a harbour on the network).
    pub naval_steps: Option<u32>,
    /// Ore cells within `REACH` cells of the yard.
    pub ore_cells: u32,
}

#[derive(Clone, Debug, Default)]
pub struct MapStats {
    pub water: u32,
    pub fords: u32,
    pub rock: u32,
    pub trees: u32,
    pub rough: u32,
    pub ore: u32,
    pub bases: Vec<BaseStats>,
}

impl MapStats {
    /// Smallest and largest value of a per-base number (None values skipped).
    pub fn spread(&self, f: impl Fn(&BaseStats) -> Option<u32>) -> Option<(u32, u32)> {
        let v: Vec<u32> = self.bases.iter().filter_map(f).collect();
        Some((*v.iter().min()?, *v.iter().max()?))
    }
}

/// Breadth-first steps from `starts` over cells where `open` holds (4-connected).
fn bfs(m: &Map, starts: &[usize], open: impl Fn(usize) -> bool) -> Vec<u32> {
    let mut dist = vec![u32::MAX; m.cells()];
    let mut queue = std::collections::VecDeque::new();
    for &s in starts {
        if dist[s] == u32::MAX {
            dist[s] = 0;
            queue.push_back(s);
        }
    }
    while let Some(i) = queue.pop_front() {
        let (x, y) = ((i as i32) % m.width, (i as i32) / m.width);
        for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
            if m.contains(x + dx, y + dy) {
                let j = m.idx(x + dx, y + dy);
                if dist[j] == u32::MAX && open(j) {
                    dist[j] = dist[i] + 1;
                    queue.push_back(j);
                }
            }
        }
    }
    dist
}

/// Measure a map (its spawns are the bases).
pub fn measure(m: &Map) -> MapStats {
    let mut s = MapStats::default();
    for i in 0..m.cells() {
        match m.terrain[i] {
            Terrain::Water => s.water += 1,
            Terrain::Ford => s.fords += 1,
            Terrain::Rock => s.rock += 1,
            Terrain::Tree => s.trees += 1,
            Terrain::Rough => s.rough += 1,
            // The generator makes none of these (imported and edited maps can have them).
            Terrain::Clear | Terrain::Road | Terrain::Bridge | Terrain::Beach | Terrain::River | Terrain::Wall => {}
        }
        if m.ore[i] > 0 {
            s.ore += 1;
        }
    }
    let network = super::main_network(m).unwrap_or_else(|| vec![false; m.cells()]);
    let yards: Vec<usize> = m.spawns.iter().map(|&(x, y)| m.idx(x + 1, y + 1)).collect();
    // Network cells near each base.
    let mut harbours: Vec<Vec<usize>> = Vec::new();
    for (k, &(sx, sy)) in m.spawns.iter().enumerate() {
        let (cx, cy) = (sx + 1, sy + 2);
        let ground = bfs(m, &[yards[k]], |j| m.terrain[j].passable());
        let rush = yards.iter().enumerate().filter(|&(o, _)| o != k).map(|(_, &y)| ground[y]).filter(|&d| d != u32::MAX).min();
        let mut b = BaseStats { rush, ..Default::default() };
        let mut harbour = Vec::new();
        for y in cy - REACH..=cy + REACH {
            for x in cx - REACH..=cx + REACH {
                if !m.contains(x, y) {
                    continue;
                }
                let i = m.idx(x, y);
                if m.ore[i] > 0 {
                    b.ore_cells += 1;
                }
                if network[i] {
                    harbour.push(i);
                    let block =
                        (0..3).all(|dy| (0..3).all(|dx| m.contains(x + dx, y + dy) && m.terrain[m.idx(x + dx, y + dy)] == Terrain::Water));
                    if block {
                        b.naval_yard_site = true;
                    }
                }
            }
        }
        b.harbour_cells = harbour.len() as u32;
        harbours.push(harbour);
        s.bases.push(b);
    }
    // The hub the generator grows the network from (mapgen::hub).
    let centres: Vec<(i32, i32)> = m.spawns.iter().map(|&(x, y)| (x + 1, y + 2)).collect();
    let ((hx, hy), _) = super::hub(m.width, m.height, &centres);
    let hubs: Vec<usize> = [m.idx(hx - 1, hy), m.idx(hx, hy)].into_iter().filter(|&i| network[i]).collect();
    if !hubs.is_empty() {
        let water = bfs(m, &hubs, |j| m.terrain[j].ship_passable());
        for (k, h) in harbours.iter().enumerate() {
            s.bases[k].naval_steps = h.iter().map(|&i| water[i]).filter(|&d| d != u32::MAX).min();
        }
    }
    s
}

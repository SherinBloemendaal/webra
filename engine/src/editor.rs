//! The map editor's checks of a map (apps/game/editor), measured on its
//! preview world (World::editor_preview) with the engine's own passability:
//! terrain, structures, trees and walls block ground units as in a game.
//!
//! `editor_cells`: per cell, flags in the low byte and in the high byte the
//! spawn whose start is fewest ground steps away (its zone; 255 for none).
//! `editor_report`: per spawn, the ground steps to the nearest other start
//! (the rush distance), the ore and gems, the buildable ground and the zone
//! around it, the harbour the generator's metrics see (mapgen/metrics.rs),
//! and the map's totals.

use std::collections::VecDeque;

use crate::mapgen::metrics::{self, REACH};
use crate::world::{World, NONE};

/// Ground units can stand here (no blocking terrain, structure, tree or wall).
pub const CELL_PASSABLE: u16 = 1;
/// A structure can be placed here (OpenRA Building.TerrainTypes, nothing standing on it).
pub const CELL_BUILDABLE: u16 = 2;
/// Reachable by ground from the first spawn.
pub const CELL_REACHABLE: u16 = 4;
/// On a shortest ground path from a spawn to the nearest other spawn.
pub const CELL_RUSH: u16 = 8;
/// High byte without a zone (blocked, or no spawn reaches it).
pub const NO_ZONE: u16 = 255;

/// The cell ground units start from at spawn `(x, y)` (the yard's middle, as mapgen/metrics.rs).
fn start(w: &World, (x, y): (i32, i32)) -> Option<usize> {
    let (cx, cy) = (x + 1, y + 1);
    w.map.contains(cx, cy).then(|| w.map.idx(cx, cy))
}

impl World {
    fn ground_open(&self, i: usize) -> bool {
        !self.pass.blocked[i]
    }

    /// Breadth-first ground steps from `from` (4-connected), u32::MAX where unreachable.
    fn ground_steps(&self, from: &[usize]) -> Vec<u32> {
        let mut dist = vec![u32::MAX; self.map.cells()];
        let mut queue = VecDeque::new();
        for &s in from {
            if dist[s] == u32::MAX {
                dist[s] = 0;
                queue.push_back(s);
            }
        }
        let w = self.map.width;
        while let Some(i) = queue.pop_front() {
            let (x, y) = (i as i32 % w, i as i32 / w);
            for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                if !self.map.contains(x + dx, y + dy) {
                    continue;
                }
                let j = self.map.idx(x + dx, y + dy);
                if dist[j] == u32::MAX && self.ground_open(j) {
                    dist[j] = dist[i] + 1;
                    queue.push_back(j);
                }
            }
        }
        dist
    }

    fn spawn_starts(&self) -> Vec<Option<usize>> {
        self.map.spawns.iter().map(|&s| start(self, s)).collect()
    }

    /// The editor's per-cell overlay (see the module comment).
    pub fn editor_cells(&self) -> Vec<u16> {
        let n = self.map.cells();
        let starts = self.spawn_starts();
        let fields: Vec<Option<Vec<u32>>> = starts.iter().map(|s| s.map(|s| self.ground_steps(&[s]))).collect();
        let mut out = vec![0u16; n];
        for (i, cell) in out.iter_mut().enumerate() {
            let mut f = 0;
            if self.ground_open(i) {
                f |= CELL_PASSABLE;
            }
            if self.map.terrain[i].buildable() && self.building_at[i] == NONE {
                f |= CELL_BUILDABLE;
            }
            if fields.first().and_then(|d| d.as_ref()).is_some_and(|d| d[i] != u32::MAX) {
                f |= CELL_REACHABLE;
            }
            let zone = fields
                .iter()
                .enumerate()
                .filter_map(|(k, d)| d.as_ref().map(|d| (d[i], k)))
                .filter(|&(d, _)| d != u32::MAX)
                .min()
                .map_or(NO_ZONE, |(_, k)| k as u16);
            *cell = f | (zone << 8);
        }
        // Rush paths: from each spawn's nearest other start back along falling steps.
        for (k, field) in fields.iter().enumerate() {
            let Some(field) = field else { continue };
            let Some(target) = starts
                .iter()
                .enumerate()
                .filter(|&(o, _)| o != k)
                .filter_map(|(_, s)| *s)
                .filter(|&s| field[s] != u32::MAX)
                .min_by_key(|&s| field[s])
            else {
                continue;
            };
            let mut i = target;
            while field[i] > 0 {
                out[i] |= CELL_RUSH;
                let (x, y) = (i as i32 % self.map.width, i as i32 / self.map.width);
                let next = [(1, 0), (-1, 0), (0, 1), (0, -1)]
                    .into_iter()
                    .filter(|&(dx, dy)| self.map.contains(x + dx, y + dy))
                    .map(|(dx, dy)| self.map.idx(x + dx, y + dy))
                    .find(|&j| field[j] == field[i] - 1);
                match next {
                    Some(j) => i = j,
                    None => break,
                }
            }
            out[i] |= CELL_RUSH;
        }
        out
    }

    /// The editor's fairness report (see the module comment) as JSON.
    pub fn editor_report(&self) -> serde_json::Value {
        let cells = self.editor_cells();
        let starts = self.spawn_starts();
        let stats = metrics::measure(&self.map);
        let bases: Vec<serde_json::Value> = self
            .map
            .spawns
            .iter()
            .enumerate()
            .map(|(k, &(sx, sy))| {
                let rush = starts[k].and_then(|s| {
                    let d = self.ground_steps(&[s]);
                    starts
                        .iter()
                        .enumerate()
                        .filter(|&(o, _)| o != k)
                        .filter_map(|(_, t)| *t)
                        .map(|t| d[t])
                        .filter(|&v| v != u32::MAX)
                        .min()
                });
                let (cx, cy) = (sx + 1, sy + 2);
                let (mut ore, mut gems, mut ore_cells, mut gem_cells, mut buildable) = (0u32, 0u32, 0u32, 0u32, 0u32);
                for y in cy - REACH..=cy + REACH {
                    for x in cx - REACH..=cx + REACH {
                        if !self.map.contains(x, y) {
                            continue;
                        }
                        let i = self.map.idx(x, y);
                        if self.map.ore[i] > 0 {
                            ore_cells += 1;
                            ore += u32::from(self.map.ore[i]);
                        }
                        if self.map.gems[i] > 0 {
                            gem_cells += 1;
                            gems += u32::from(self.map.gems[i]);
                        }
                        if cells[i] & CELL_BUILDABLE != 0 {
                            buildable += 1;
                        }
                    }
                }
                let zone = cells.iter().filter(|&&c| c >> 8 == k as u16).count();
                let harbour = stats.bases.get(k);
                serde_json::json!({
                    "rush": rush,
                    "ore": ore,
                    "oreCells": ore_cells,
                    "gems": gems,
                    "gemCells": gem_cells,
                    "buildable": buildable,
                    "zone": zone,
                    "harbourCells": harbour.map_or(0, |b| b.harbour_cells),
                    "navalYardSite": harbour.is_some_and(|b| b.naval_yard_site),
                })
            })
            .collect();
        let reachable = cells.iter().filter(|&&c| c & CELL_REACHABLE != 0).count();
        let unreachable_spawns: Vec<usize> =
            starts.iter().enumerate().skip(1).filter(|&(_, s)| s.is_none_or(|s| cells[s] & CELL_REACHABLE == 0)).map(|(k, _)| k).collect();
        serde_json::json!({
            "reach": REACH,
            "bases": bases,
            "water": stats.water,
            "ore": stats.ore,
            "passable": cells.iter().filter(|&&c| c & CELL_PASSABLE != 0).count(),
            "buildable": cells.iter().filter(|&&c| c & CELL_BUILDABLE != 0).count(),
            "reachable": reachable,
            "unreachableSpawns": unreachable_spawns,
        })
    }
}

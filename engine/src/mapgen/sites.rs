//! Neutral actors of generated maps: ore and gem mines in the middle of the
//! fields (OpenRA MINE and GMINE, SeedsResource: with the lobby's "Ore
//! regrowth" on, they grow the fields back; see neutral.rs).
//!
//! Sites are found on the finished map by a rule that only looks at a cell's
//! neighbourhood and treats every direction alike: a mine goes on the cell
//! whose weighted resource sum is the highest within `PEAK_RADIUS` cells (and
//! high enough to be the heart of a field), a gem mine where that cell holds
//! gems. The generator's maps are mirror (and some translation) symmetric, so
//! the sites are too: every base gets the same mines.

use super::settlements::TechBuildings;
use crate::map::Map;
use crate::mapdata::MapActor;
use crate::rules::Rules;
use crate::weather::Biome;

/// Cells around a site the resource sum counts (Chebyshev distance).
const SUM_RADIUS: i32 = 3;
/// A site has the highest sum of every cell this close (so fields get one).
const PEAK_RADIUS: i32 = 4;
/// Least weighted sum of a site: the middle of a real field, not scattered ore.
const MIN_SUM: i32 = 300;
/// A gem bale counts like this many ore bales (Red Alert: 3 gem bales hold
/// what 12 ore bales do).
const GEM_WEIGHT: i32 = 4;

/// Weighted resource sum around (x, y): nearer cells count more.
fn resource_sum(m: &Map, x: i32, y: i32) -> i32 {
    let mut s = 0;
    for dy in -SUM_RADIUS..=SUM_RADIUS {
        for dx in -SUM_RADIUS..=SUM_RADIUS {
            if !m.contains(x + dx, y + dy) {
                continue;
            }
            let i = m.idx(x + dx, y + dy);
            let weight = SUM_RADIUS + 1 - dx.abs().max(dy.abs());
            s += (m.ore[i] as i32 + GEM_WEIGHT * m.gems[i] as i32) * weight;
        }
    }
    s
}

/// Cells of `m` where a mine goes, and whether it is a gem mine (see the module comment).
pub fn mine_sites(m: &Map) -> Vec<(i32, i32, bool)> {
    let sums: Vec<i32> = (0..m.cells()).map(|i| resource_sum(m, i as i32 % m.width, i as i32 / m.width)).collect();
    let mut out = Vec::new();
    for y in 0..m.height {
        for x in 0..m.width {
            let i = m.idx(x, y);
            // In a field, on open ground all around so the mine never closes a passage.
            if !m.has_resource(i) || sums[i] < MIN_SUM {
                continue;
            }
            let open = (-1..=1).all(|dy| (-1..=1).all(|dx| m.contains(x + dx, y + dy) && m.terrain[m.idx(x + dx, y + dy)].passable()));
            if !open {
                continue;
            }
            let peak = (-PEAK_RADIUS..=PEAK_RADIUS).all(|dy| {
                (-PEAK_RADIUS..=PEAK_RADIUS)
                    .all(|dx| (dx, dy) == (0, 0) || !m.contains(x + dx, y + dy) || sums[m.idx(x + dx, y + dy)] < sums[i])
            });
            if peak {
                out.push((x, y, m.gems[i] > 0));
            }
        }
    }
    out
}

/// The neutral actors of a generated map, as map file actors (owner -1):
/// the ore mines, then the tech buildings and villages (settlements.rs).
pub fn world_actors(m: &Map, rules: &Rules, biome: Biome, tech: TechBuildings, seed: u64) -> Vec<MapActor> {
    let mut actors: Vec<MapActor> =
        mine_sites(m).into_iter().map(|(x, y, gems)| MapActor::new(if gems { "GMINE" } else { "MINE" }, -1, x, y, 0)).collect();
    let more = super::settlements::settlements(m, rules, biome, tech, seed, &actors);
    actors.extend(more);
    actors
}

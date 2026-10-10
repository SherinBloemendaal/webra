//! OpenRA HarvesterBotModule and ResourceMapBotModule.
//!
//! The resource map splits the map into squares of twice
//! ResourceMapStrideRadius cells and keeps, per square, its ore and gem
//! cells, the bot's refineries and ore trucks there and how many enemy units
//! and base structures are near. The harvester module keeps InitialHarvesters
//! ore trucks (and one per refinery), sends idle trucks to the nearest ore
//! along a path that avoids enemies, moves trucks from crowded fields to
//! ones that lack trucks, and sends a truck under fire home to its refinery.
//!
//! WebRA differences: the per-square counts of friendly units are recounted
//! on every update (OpenRA only ever adds to them), and ties between equally
//! near ore cells go to mirrored cells on mirrored maps, never scan order.

use crate::ai::{count_own, rand};
use crate::ai_bots::BotConfig;
use crate::math::{dist_sq, CELL};
use crate::rules::Kind;
use crate::world::{cell_center, Activity, HarvState, Order, World, NONE};

/// One square of the resource map (OpenRA ResourceIndice).
#[derive(Clone, Default, Debug)]
pub(crate) struct ResourceIndice {
    pub(crate) index: (i32, i32),
    pub(crate) center: (i32, i32),
    pub(crate) resource_cells: i32,
    pub(crate) resource_center: (i32, i32),
    pub(crate) refineries: i32,
    pub(crate) harvesters: i32,
    pub(crate) enemy_units: i32,
    pub(crate) enemy_bases: i32,
    pub(crate) friendly_bases: i32,
    pub(crate) friendly_units: i32,
}

#[derive(Clone, Default, Debug)]
pub(crate) struct HarvestState {
    pub(crate) indices: Vec<ResourceIndice>,
    pub(crate) columns: i32,
    pub(crate) rows: i32,
    map_started: bool,
    map_ticks: i32,
    map_next: usize,
    /// Own ore trucks (references) and their no-resources cooldown.
    trucks: Vec<(u32, i32)>,
    needing_orders: Vec<u32>,
    idle_ticks: i32,
    low_effect_ticks: i32,
    respond_cooldown: i32,
}

pub(crate) fn start(w: &mut World, player: u8) {
    let cfg = w.ai[player as usize].cfg.clone();
    let h = &cfg.info.harvester;
    let idle = rand(w, 0, h.scan_for_idle_harvesters_interval);
    let low = rand(w, 0, h.scan_for_low_effect_harvesters_interval);
    let st = &mut w.ai[player as usize].harvest;
    st.idle_ticks = idle;
    st.low_effect_ticks = low;
    st.respond_cooldown = 40;
}

// ---- Resource map --------------------------------------------------------------------

fn side(cfg: &BotConfig) -> i32 {
    cfg.info.resource_map.as_ref().map_or(24, |r| r.resource_map_stride_radius * 2)
}

/// OpenRA indiceResourceScanRadius (about the stride radius * (sqrt(2) + 1) / 2).
pub(crate) fn scan_radius(cfg: &BotConfig) -> i32 {
    cfg.info.resource_map.as_ref().map_or(14, |r| r.resource_map_stride_radius * 12 / 10)
}

pub(crate) fn tick_resource_map(w: &mut World, player: u8) {
    let cfg = w.ai[player as usize].cfg.clone();
    let Some(rm) = cfg.info.resource_map.as_ref() else { return };
    if !w.ai[player as usize].harvest.map_started {
        let interval = rand(w, rm.update_resource_map_inverval, rm.update_resource_map_inverval * 2);
        let side = side(&cfg);
        let cols = (w.map.width + side - 1) / side;
        let rows = (w.map.height + side - 1) / side;
        let xoff = -((cols * side - w.map.width) >> 1);
        let yoff = -((rows * side - w.map.height) >> 1);
        let indices: Vec<ResourceIndice> = (0..cols * rows)
            .map(|i| ResourceIndice {
                index: (i % cols, i / cols),
                center: (xoff + (i % cols) * side + (side >> 1), yoff + (i / cols) * side + (side >> 1)),
                ..Default::default()
            })
            .collect();
        let st = &mut w.ai[player as usize].harvest;
        st.map_started = true;
        st.map_ticks = interval;
        st.columns = cols;
        st.rows = rows;
        st.indices = indices;
        for i in 0..(cols * rows) as usize {
            update_indice(w, player, &cfg, i);
        }
    }
    let st = &mut w.ai[player as usize].harvest;
    st.map_ticks -= 1;
    if st.map_ticks <= 0 && !st.indices.is_empty() {
        st.map_ticks = rm.update_resource_map_inverval;
        let i = st.map_next;
        st.map_next = (i + 1) % st.indices.len();
        update_indice(w, player, &cfg, i);
    }
}

fn update_indice(w: &mut World, player: u8, cfg: &BotConfig, i: usize) {
    let r = scan_radius(cfg);
    let center = w.ai[player as usize].harvest.indices[i].center;
    let mut cells: Vec<(i32, i32)> = Vec::new();
    for y in center.1 - r..=center.1 + r {
        for x in center.0 - r..=center.0 + r {
            if (x - center.0) * (x - center.0) + (y - center.1) * (y - center.1) <= r * r
                && w.map.contains(x, y)
                && w.map.has_resource(w.map.idx(x, y))
            {
                cells.push((x, y));
            }
        }
    }
    let mut best = (0, 0);
    if !cells.is_empty() {
        let n = cells.len() as i32;
        let avg = (cells.iter().map(|c| c.0).sum::<i32>() / n, cells.iter().map(|c| c.1).sum::<i32>() / n);
        best = *cells.iter().min_by_key(|&&c| ((c.0 - avg.0).pow(2) + (c.1 - avg.1).pow(2), c.1, c.0)).unwrap();
    }
    let (cx, cy) = (cell_center(center.0), cell_center(center.1));
    let rr = (r * CELL) as i64;
    let mut ix = ResourceIndice { index: w.ai[player as usize].harvest.indices[i].index, center, ..Default::default() };
    ix.resource_cells = cells.len() as i32;
    ix.resource_center = best;
    for a in &w.actors {
        if !a.alive || !a.in_world() || matches!(a.kind, Kind::Husk | Kind::Crate | Kind::Proxy | Kind::Mine) {
            continue;
        }
        if dist_sq(a.x, a.y, cx, cy) > rr * rr {
            continue;
        }
        let base = cfg.enemy_base_buildings.contains(&a.ty);
        if w.are_enemies(player, a.owner) {
            if base {
                ix.enemy_bases += 1;
            } else {
                ix.enemy_units += 1;
            }
        } else if w.are_allies(player, a.owner) {
            if base {
                ix.friendly_bases += 1;
            } else {
                ix.friendly_units += 1;
            }
            if a.owner == player {
                if cfg.refineries.contains(&a.ty) {
                    ix.refineries += 1;
                }
                if cfg.harvesters.contains(&a.ty) {
                    ix.harvesters += 1;
                }
            }
        }
    }
    w.ai[player as usize].harvest.indices[i] = ix;
}

/// OpenRA GetNearbyIndicesThreat: (squares counted, enemy units, enemy base
/// structures) around square `i`, less the friendly ones.
pub(crate) fn nearby_threat(w: &World, player: u8, i: usize) -> (i32, i32, i32) {
    let st = &w.ai[player as usize].harvest;
    let (x, y) = st.indices[i].index;
    let (mut count, mut units, mut bases) = (0, 0, 0);
    for dy in -1..=1 {
        for dx in -1..=1 {
            let k = x + dx + (y + dy) * st.columns;
            if k as usize != i && k >= 0 && (k as usize) < st.indices.len() {
                let ix = &st.indices[k as usize];
                bases += ix.enemy_bases - ix.friendly_bases;
                units += ix.enemy_units - ix.friendly_units;
                count += 1;
            }
        }
    }
    (count, units.max(0), bases.max(0))
}

/// Own refineries in the resource square nearest to `cell` (None without a resource map).
pub(crate) fn refineries_near_resource_area(w: &World, player: u8, cell: (i32, i32)) -> Option<i32> {
    let st = &w.ai[player as usize].harvest;
    st.indices.iter().min_by_key(|ix| (ix.center.0 - cell.0).pow(2) + (ix.center.1 - cell.1).pow(2)).map(|ix| ix.refineries)
}

// ---- Harvesters ------------------------------------------------------------------------

fn any_resources(w: &World) -> bool {
    (0..w.map.cells()).any(|c| w.map.has_resource(c))
}

pub(crate) fn tick(w: &mut World, player: u8) {
    let cfg = w.ai[player as usize].cfg.clone();
    let h = &cfg.info.harvester;
    w.ai[player as usize].harvest.respond_cooldown -= 1;
    if !any_resources(w) {
        return;
    }
    // At most one path search per tick.
    while let Some(r) = w.ai[player as usize].harvest.needing_orders.pop() {
        if harvest_if_able(w, player, &cfg, r) {
            break;
        }
    }
    let level = w.ai[player as usize].level();
    let st = &mut w.ai[player as usize].harvest;
    st.idle_ticks -= 1;
    if st.idle_ticks <= 0 {
        st.idle_ticks = level.interval(h.scan_for_idle_harvesters_interval);
        find_idle_harvesters(w, player);
        if !cfg.harvesters.is_empty() {
            let trucks = count_own(w, player, &cfg.harvesters) as i32;
            if trucks < h.initial_harvesters || trucks < count_own(w, player, &cfg.harvester_refineries) as i32 {
                let ty = crate::ai_units::pick(w, &cfg.harvesters).unwrap();
                if crate::ai_units::requested(w, player, ty) == 0 {
                    crate::ai_units::request(w, player, ty);
                }
            }
        }
    }
    let st = &mut w.ai[player as usize].harvest;
    st.low_effect_ticks -= 1;
    if st.low_effect_ticks <= 0 {
        st.low_effect_ticks = h.scan_for_low_effect_harvesters_interval;
        if cfg.info.resource_map.is_some() {
            reassign_low_effect_harvesters(w, player, &cfg);
        }
    }
}

fn find_idle_harvesters(w: &mut World, player: u8) {
    let own: Vec<usize> = (0..w.actors.len())
        .filter(|&i| w.actors[i].alive && w.actors[i].owner == player && w.actors[i].in_world() && w.is_harvester(i))
        .collect();
    let refs: Vec<u32> = own.iter().map(|&i| w.make_ref(i)).collect();
    let st = &mut w.ai[player as usize].harvest;
    st.trucks.retain(|t| refs.contains(&t.0));
    for r in &refs {
        if !st.trucks.iter().any(|t| t.0 == *r) {
            st.trucks.push((*r, 0));
        }
    }
    st.needing_orders = st.trucks.iter().map(|t| t.0).collect();
}

/// OpenRA HarvestIfAble: an idle truck (or one whose search failed) is sent
/// to the next safe ore; returns whether a search was made.
fn harvest_if_able(w: &mut World, player: u8, cfg: &BotConfig, r: u32) -> bool {
    let Some(i) = w.resolve(r).filter(|&i| w.actors[i].alive && w.actors[i].in_world() && w.actors[i].owner == player) else {
        return false;
    };
    let a = &w.actors[i];
    let searching_failed = a.activity == Activity::Harvest && a.harv == HarvState::Wait;
    if a.activity != Activity::Idle && !searching_failed {
        return false;
    }
    let st = &mut w.ai[player as usize].harvest;
    let Some(k) = st.trucks.iter().position(|t| t.0 == r) else { return false };
    if st.trucks[k].1 > 1 {
        st.trucks[k].1 -= 1;
        return false;
    }
    match next_resource(w, player, cfg, i) {
        Some(ci) => {
            let (x, y) = (cell_center(ci as i32 % w.map.width), cell_center(ci as i32 / w.map.width));
            w.queue_order(Order::Smart { player, ids: vec![r], x, y });
        }
        None => {
            let mult = cfg.info.harvester.scan_interval_multipler_when_no_resources;
            w.ai[player as usize].harvest.trucks[k].1 = mult;
        }
    }
    true
}

/// Mirror-symmetric tie break for a cell index (distance from the middle column, row).
fn mirror_key(w: &World, ci: usize) -> (i32, i32) {
    let (x, y) = (ci as i32 % w.map.width, ci as i32 / w.map.width);
    ((2 * x - (w.map.width - 1)).abs(), y)
}

/// OpenRA FindNextResource: the nearest ore cell nobody else claims along a
/// ground path from the truck's nearest refinery (or the truck), where every
/// cell costs extra for each enemy actor around it.
fn next_resource(w: &World, player: u8, cfg: &BotConfig, i: usize) -> Option<usize> {
    let h = &cfg.info.harvester;
    let from = nearest_refinery(w, player, i).map_or_else(|| w.cell_of(w.actors[i].x, w.actors[i].y), |b| dock_cell(w, b));
    let claimed: Vec<u32> = (0..w.actors.len())
        .filter(|&j| j != i && w.actors[j].alive && w.actors[j].owner == player && w.is_harvester(j))
        .map(|j| w.actors[j].harv_cell)
        .filter(|&c| c != NONE)
        .collect();
    let radius = (h.harvester_enemy_avoidance_radius / CELL).max(1);
    // Ten per straight step (the engine's cell cost), so OpenRA's
    // minCellCost * multiplier per enemy becomes 10 * multiplier.
    let per_enemy = 10 * h.harvester_enemy_avoidance_cost_multipler;
    let enemies: Vec<(i32, i32)> = w
        .actors
        .iter()
        .filter(|a| a.alive && a.in_world() && !matches!(a.kind, Kind::Husk | Kind::Crate | Kind::Proxy) && w.are_enemies(player, a.owner))
        .map(|a| w.cell_of(a.x, a.y))
        .collect();
    let mut bins: Vec<((i32, i32), i32)> = Vec::new();
    let mut bin_cost = |cx: i32, cy: i32| -> i32 {
        let bin = (cx / radius, cy / radius);
        if let Some(b) = bins.iter().find(|b| b.0 == bin) {
            return b.1;
        }
        let origin = (bin.0 * radius + radius / 2, bin.1 * radius + radius / 2);
        let n = enemies.iter().filter(|e| (e.0 - origin.0).abs() <= radius && (e.1 - origin.1).abs() <= radius).count() as i32;
        bins.push((bin, n * per_enemy));
        n * per_enemy
    };
    let (fx, fy) = (from.0.clamp(0, w.map.width - 1), from.1.clamp(0, w.map.height - 1));
    let start = w.map.idx(fx, fy);
    let mut cost = vec![i32::MAX; w.map.cells()];
    let mut heap = std::collections::BinaryHeap::new();
    cost[start] = 0;
    heap.push(std::cmp::Reverse((0, mirror_key(w, start), start)));
    while let Some(std::cmp::Reverse((c, _, ci))) = heap.pop() {
        if c > cost[ci] {
            continue;
        }
        if w.map.has_resource(ci) && !w.pass.blocked[ci] && !claimed.contains(&(ci as u32)) {
            return Some(ci);
        }
        let (x, y) = (ci as i32 % w.map.width, ci as i32 / w.map.width);
        for dir in 0..8 {
            if let Some(j) = crate::flowfield::step(&w.map, &w.pass.blocked, x, y, dir) {
                let (jx, jy) = (j as i32 % w.map.width, j as i32 / w.map.width);
                let nc = c + if dir % 2 == 0 { 10 } else { 14 } + bin_cost(jx, jy);
                if nc < cost[j] {
                    cost[j] = nc;
                    heap.push(std::cmp::Reverse((nc, mirror_key(w, j), j)));
                }
            }
        }
    }
    None
}

fn nearest_refinery(w: &World, player: u8, i: usize) -> Option<usize> {
    let (x, y) = (w.actors[i].x, w.actors[i].y);
    (0..w.actors.len())
        .filter(|&b| {
            let a = &w.actors[b];
            a.alive
                && a.owner == player
                && a.kind == Kind::Building
                && w.rules.actors[a.ty as usize].building.as_ref().is_some_and(|x| x.refinery.is_some())
        })
        .min_by_key(|&b| (dist_sq(w.actors[b].x, w.actors[b].y, x, y), b))
}

/// The cell in front of a refinery's dock.
fn dock_cell(w: &World, b: usize) -> (i32, i32) {
    let a = &w.actors[b];
    let info = w.rules.actors[a.ty as usize].building.as_ref().unwrap();
    let rf = info.refinery.as_ref().unwrap();
    let x = a.cx * CELL + info.width * crate::math::HALF_CELL + info.center_offset.0 + rf.dock_offset.0;
    let y = a.cy * CELL + info.height * crate::math::HALF_CELL + info.center_offset.1 + rf.dock_offset.1;
    w.cell_of(x, y)
}

/// OpenRA FindAndOrderLowEffectHarvesterOnResourceMap: trucks of the most
/// crowded resource square move to squares that lack trucks.
fn reassign_low_effect_harvesters(w: &mut World, player: u8, cfg: &BotConfig) {
    let h = &cfg.info.harvester;
    let side = side(cfg);
    let side2 = side * side;
    let n = w.ai[player as usize].harvest.indices.len();
    let mut worst: Option<((i32, i32), i32)> = None;
    let mut lacking: Vec<(i32, i32, (i32, i32))> = Vec::new();
    for i in 0..n {
        let ix = w.ai[player as usize].harvest.indices[i].clone();
        let mut attraction = side2 >> 5;
        attraction += ix.resource_cells - ix.harvesters * h.resource_cells_per_harvester;
        let mut lack = if attraction > 0 {
            attraction / h.resource_cells_per_harvester
        } else if attraction == 0 && ix.resource_cells > 0 {
            1
        } else {
            -1
        };
        attraction >>= 1;
        if ix.refineries <= 0 && lack > 0 {
            lack = 1;
        }
        if ix.enemy_bases > 0 || ix.enemy_units > 0 {
            attraction -= side2 << 4;
        } else {
            let (_, units, bases) = nearby_threat(w, player, i);
            if units + bases > 0 {
                attraction -= side2 >> 5;
            }
        }
        if ix.refineries > 0 {
            attraction += side2;
        }
        if ix.resource_cells > 0 && attraction > 0 && lack > 0 {
            lacking.push((attraction, lack, ix.resource_center));
        }
        if lack < 0 && worst.is_none_or(|(_, l)| lack < l) {
            worst = Some((ix.center, lack));
        }
    }
    let Some((worst_center, worst_lack)) = worst else { return };
    let r = scan_radius(cfg);
    let (wx, wy) = (cell_center(worst_center.0), cell_center(worst_center.1));
    let mut trucks: Vec<usize> = (0..w.actors.len())
        .filter(|&i| {
            let a = &w.actors[i];
            a.alive
                && a.owner == player
                && a.in_world()
                && cfg.harvesters.contains(&a.ty)
                && dist_sq(a.x, a.y, wx, wy) <= (r * CELL) as i64 * (r * CELL) as i64
        })
        .collect();
    let mut can_assign = (-worst_lack).min(trucks.len() as i32 - 1);
    if can_assign <= 0 {
        return;
    }
    let st = &w.ai[player as usize].harvest;
    let factor = (st.rows * st.rows + st.columns * st.columns).max(1);
    let first = w.cell_of(w.actors[trucks[0]].x, w.actors[trucks[0]].y);
    lacking.sort_by_key(|&(a, _, c)| std::cmp::Reverse(a - ((first.0 - c.0).pow(2) + (first.1 - c.1).pow(2)) / factor));
    for (_, lack, center) in lacking {
        if can_assign <= 0 || trucks.is_empty() {
            break;
        }
        let first = w.cell_of(w.actors[trucks[0]].x, w.actors[trucks[0]].y);
        let reach = (first.0 - center.0).pow(2) + (first.1 - center.1).pow(2);
        let near: Vec<(i32, i32)> = (center.1 - r..=center.1 + r)
            .flat_map(|y| (center.0 - r..=center.0 + r).map(move |x| (x, y)))
            .filter(|&(x, y)| {
                (x - center.0).pow(2) + (y - center.1).pow(2) <= r * r
                    && w.map.contains(x, y)
                    && w.map.has_resource(w.map.idx(x, y))
                    && reach >= (x - first.0).pow(2) + (y - first.1).pow(2)
            })
            .collect();
        if near.is_empty() || lack <= 0 {
            continue;
        }
        let mut need = lack;
        let mut used = Vec::new();
        for &t in &trucks {
            if need <= 0 || can_assign <= 0 {
                break;
            }
            let Some(cell) = crate::ai_units::pick(w, &near) else { break };
            let tc = w.cell_index(w.actors[t].x, w.actors[t].y);
            let ci = w.map.idx(cell.0, cell.1);
            if w.pass.component[tc] == w.pass.component[ci] {
                let r = w.make_ref(t);
                w.queue_order(Order::Smart { player, ids: vec![r], x: cell_center(cell.0), y: cell_center(cell.1) });
                need -= 1;
                can_assign -= 1;
                used.push(t);
            } else if need > 1 {
                need = 1;
            } else {
                break;
            }
        }
        trucks.retain(|t| !used.contains(t));
    }
}

/// IBotRespondToAttack: an ore truck under fire drives home to its nearest
/// refinery, unless it is already on its way there.
pub(crate) fn respond_to_attack(w: &mut World, player: u8, victim: usize, attacker: usize) {
    let cfg = w.ai[player as usize].cfg.clone();
    if w.ai[player as usize].harvest.respond_cooldown > 0
        || !cfg.harvesters.contains(&w.actors[victim].ty)
        || !w.actors[attacker].alive
        || !w.are_enemies(player, w.actors[attacker].owner)
    {
        return;
    }
    if matches!(w.actors[victim].harv, HarvState::ToDock | HarvState::Unloading) && w.actors[victim].activity == Activity::Harvest {
        return;
    }
    w.ai[player as usize].harvest.respond_cooldown = 30;
    if let Some(b) = nearest_refinery(w, player, victim) {
        let r = w.make_ref(victim);
        let (x, y) = (w.actors[b].x, w.actors[b].y);
        w.queue_order(Order::Smart { player, ids: vec![r], x, y });
    }
}

/// Own ore trucks (tests).
#[cfg(test)]
pub(crate) fn trucks(w: &World, player: u8) -> Vec<usize> {
    let cfg = w.ai[player as usize].cfg.clone();
    crate::ai::own_of(w, player, &cfg.harvesters)
}

//! The simulation's performance work keeps every result the same: the
//! faster occupancy queries, route searches, target scans and vision
//! (movement/occupancy.rs, movement/search.rs, combat.rs, vision.rs,
//! world.rs `rebuild_hash`) against their plain definitions, on crowds of
//! both sides. docs/contracts.md "Simulation performance" lists them.

use crate::flowfield::{centre_distance, COST_DIAGONAL, COST_STRAIGHT, DIRS, DIST_NONE};
use crate::math::CELL;
use crate::movement::occupancy::{Blocking, DEFAULT_SUB_CELL, FULL_CELL};
use crate::movement::search::{HEURISTIC_WEIGHT, SEARCH_LIMIT};
use crate::rules::Kind;
use crate::world::{cell_center, World, NONE};
use std::cmp::Reverse;
use std::collections::BinaryHeap;

const CHECKS: [Blocking; 4] = [Blocking::None, Blocking::Immovable, Blocking::Stationary, Blocking::All];

/// The stress test's armies, with soldiers and tanks of both sides squeezed
/// into the same cells where the armies meet (crowded cells, crushable
/// enemies, every sub-cell taken), stepped `ticks` ticks.
fn crowd(ticks: u32) -> World {
    let mut w = World::new_stress(7, 1200, 96);
    let (e1, tank) = (w.rules.actor_index("E1").unwrap() as u16, w.rules.actor_index("3TNK").unwrap() as u16);
    for k in 0..120 {
        let (cx, cy) = (40 + k % 12, 40 + k / 12);
        if w.pass.blocked[w.map.idx(cx, cy)] {
            continue;
        }
        let owner = (k % 3 == 0) as u8;
        w.spawn_unit(if k % 4 == 0 { tank } else { e1 }, owner, cell_center(cx) - 200, cell_center(cy), 0);
        w.spawn_unit(e1, 1 - owner, cell_center(cx) + 200, cell_center(cy) + 100, 0);
    }
    for _ in 0..ticks {
        w.step();
    }
    w
}

fn overlaps(a: u8, b: u8) -> bool {
    a == FULL_CELL || b == FULL_CELL || a == b
}

/// OpenRA Locomotor.IsBlockedBy as it read before (occupancy.rs `blocked_by`).
fn plain_blocked_by(w: &World, i: usize, o: usize, check: Blocking) -> bool {
    let movable = w.is_movable(o);
    let moving = movable && w.actors[o].mv.moving;
    if check <= Blocking::Immovable && movable && w.are_allies(w.actors[i].owner, w.actors[o].owner) {
        return false;
    }
    if check <= Blocking::Stationary && moving {
        return false;
    }
    !w.crushable_by(o, i)
}

/// ActorMap.FreeSubCell, one holder query per sub-cell.
fn plain_free_sub_cell(w: &World, cell: u32, i: usize, preferred: u8) -> Option<u8> {
    let taken = |s: u8| w.others_at(cell, i).any(|o| overlaps(o.sub, s));
    if preferred != FULL_CELL && !taken(preferred) {
        return Some(preferred);
    }
    if w.others_at(cell, i).next().is_none() {
        return Some(DEFAULT_SUB_CELL);
    }
    w.nearest_sub_cell(i, cell, |s| s != preferred && !taken(s))
}

/// Mobile.CanEnterCell as it read before.
fn plain_can_enter_cell(w: &World, i: usize, cell: u32, check: Blocking) -> bool {
    if cell as usize >= w.map.cells() || !w.terrain_allows(i, cell) {
        return false;
    }
    if check == Blocking::None {
        return true;
    }
    let shares = w.shares_cell(i);
    if shares && plain_free_sub_cell(w, cell, i, w.actors[i].mv.to_sub).is_some() {
        return true;
    }
    let sub = if shares { w.actors[i].mv.to_sub } else { FULL_CELL };
    !w.others_at(cell, i).any(|o| overlaps(o.sub, sub) && plain_blocked_by(w, i, o.actor as usize, check))
}

/// Mobile.GetAvailableSubCell as it read before.
fn plain_available_sub_cell(w: &World, i: usize, cell: u32) -> Option<u8> {
    if !w.shares_cell(i) {
        let blocked = w.others_at(cell, i).any(|o| plain_blocked_by(w, i, o.actor as usize, Blocking::All));
        return (!blocked).then_some(FULL_CELL);
    }
    let preferred = w.actors[i].mv.from_sub;
    let taken = |s: u8| w.others_at(cell, i).any(|o| overlaps(o.sub, s) && plain_blocked_by(w, i, o.actor as usize, Blocking::All));
    if preferred != FULL_CELL && !taken(preferred) {
        return Some(preferred);
    }
    if w.others_at(cell, i).next().is_none() {
        return Some(DEFAULT_SUB_CELL);
    }
    w.nearest_sub_cell(i, cell, |s| s != preferred && !taken(s))
}

/// The units that hold cells, and the cells around each (5 x 5).
fn units_and_cells(w: &World) -> Vec<(usize, Vec<u32>)> {
    (0..w.actors.len())
        .filter(|&i| w.occupies_cells(i) && w.actors[i].mv.to != NONE)
        .map(|i| {
            let (cx, cy) = w.cell_of(w.actors[i].x, w.actors[i].y);
            let cells = (-2..=2)
                .flat_map(|dy| (-2..=2).map(move |dx| (cx + dx, cy + dy)))
                .filter(|&(x, y)| w.map.contains(x, y))
                .map(|(x, y)| w.map.idx(x, y) as u32)
                .collect();
            (i, cells)
        })
        .collect()
}

#[test]
fn occupancy_queries_answer_as_their_plain_definitions() {
    let mut compared = 0;
    let mut crowded = 0;
    for ticks in [0, 1, 12, 40] {
        let w = crowd(ticks);
        for (i, cells) in units_and_cells(&w) {
            for c in cells {
                if w.others_at(c, i).count() >= 2 {
                    crowded += 1;
                }
                for preferred in 0..6 {
                    assert_eq!(w.free_sub_cell(c, i, preferred), plain_free_sub_cell(&w, c, i, preferred), "free sub-cell of {c} for {i}");
                }
                for check in CHECKS {
                    assert_eq!(w.can_enter_cell(i, c, check), plain_can_enter_cell(&w, i, c, check), "{i} entering {c} under {check:?}");
                    if let Some(o) = w.others_at(c, i).next() {
                        assert_eq!(w.blocked_by(i, o.actor as usize, check), plain_blocked_by(&w, i, o.actor as usize, check));
                    }
                }
                assert_eq!(w.available_sub_cell(i, c), plain_available_sub_cell(&w, i, c), "available sub-cell of {c} for {i}");
                compared += 1;
            }
        }
    }
    assert!(compared > 50_000 && crowded > 1_000, "{compared} cells compared, {crowded} of them shared");
}

/// The route search as it read before (movement/search.rs): its own
/// bookkeeping, every holder query asked again for each neighbour.
fn plain_find_path(w: &mut World, i: usize, dest: u32, check: Blocking) -> Option<Vec<u32>> {
    let from = w.actors[i].mv.to;
    if from == NONE || dest as usize >= w.map.cells() {
        return None;
    }
    if from == dest {
        return Some(Vec::new());
    }
    if !plain_can_enter_cell(w, i, dest, check) {
        return None;
    }
    if w.adjacent_cells(from, dest) {
        return w.can_step(i, from, dest).then(|| vec![dest]);
    }
    w.unit_flow_field_from(i, dest, from as usize)?;
    let w = &*w;
    let ty = w.actors[i].ty as usize;
    let loco_index = w.rules.actors[ty].unit.as_ref()?.locomotor;
    let loco = &w.rules.locomotors[loco_index];
    let field = w.flow.cached(dest, loco_index as u8, w.flow_crusher(i));
    let covered = field.map_or(0, |f| if f.dist[from as usize] == DIST_NONE { 0 } else { f.dist[from as usize] });
    let width = w.map.width;
    let (dx, dy) = (dest as i32 % width, dest as i32 / width);
    let estimate = |c: usize| -> u32 {
        if let Some(f) = field {
            if f.dist[c] < covered {
                return f.dist[c] as u32 * COST_STRAIGHT;
            }
        }
        let (ax, ay) = ((c as i32 % width - dx).unsigned_abs(), (c as i32 / width - dy).unsigned_abs());
        let (lo, hi) = (ax.min(ay), ax.max(ay));
        (lo * COST_DIAGONAL + (hi - lo) * COST_STRAIGHT) * 80 / 100
    };
    let enter_cost = |c: usize| -> u32 { 10_000 / loco.speeds[w.map.speed_class(c)].max(1) as u32 };
    let blocked = |c: usize| !w.terrain_allows(i, c as u32);
    let tie = |c: usize| {
        let (x, y) = (c as i32 % width, c as i32 / width);
        ((x - dx).pow(2) + (y - dy).pow(2), centre_distance(&w.map, x, y))
    };
    let mut cost = vec![u32::MAX; w.map.cells()];
    let mut parent = vec![NONE; w.map.cells()];
    cost[from as usize] = 0;
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
        if g > cost[c] {
            continue;
        }
        expanded += 1;
        if expanded > SEARCH_LIMIT {
            break;
        }
        let (x, y) = (c as i32 % width, c as i32 / width);
        for (d, &(ox, oy)) in DIRS.iter().enumerate() {
            let (nx, ny) = (x + ox, y + oy);
            if !w.map.contains(nx, ny) {
                continue;
            }
            let n = w.map.idx(nx, ny);
            if blocked(n) {
                continue;
            }
            if ox != 0 && oy != 0 && (blocked(w.map.idx(x + ox, y)) || blocked(w.map.idx(x, y + oy))) {
                continue;
            }
            if n != dest as usize && !plain_can_enter_cell(w, i, n as u32, check) {
                continue;
            }
            let base = if d % 2 == 0 { COST_STRAIGHT } else { COST_DIAGONAL };
            let ng = g + base * enter_cost(n) / 100;
            if ng < cost[n] {
                cost[n] = ng;
                parent[n] = c as u32;
                let hn = estimate(n);
                heap.push(Reverse((ng + hn * HEURISTIC_WEIGHT / 100, hn, tie(n), n as u32, ng)));
            }
        }
    }
    if !found {
        return None;
    }
    let mut path = Vec::new();
    let mut c = dest;
    while c != from {
        path.push(c);
        c = parent[c as usize];
    }
    Some(path)
}

#[test]
fn route_searches_find_the_routes_of_the_plain_search() {
    let (mut found, mut none) = (0, 0);
    for ticks in [1, 15] {
        let mut w = crowd(ticks);
        let units: Vec<usize> = (0..w.actors.len()).filter(|&i| w.occupies_cells(i) && w.actors[i].mv.to != NONE).step_by(23).collect();
        let n = w.map.width;
        // Into the crowd where the armies meet, across the map, and into the enemy's spawn.
        let dests = [w.map.idx(45, 44) as u32, w.map.idx(n / 2, 6) as u32, w.map.idx(w.map.spawns[1].0, w.map.spawns[1].1) as u32];
        for &i in &units {
            for &dest in &dests {
                for check in [Blocking::All, Blocking::Stationary, Blocking::Immovable] {
                    let fast = w.find_path(i, dest, check);
                    let plain = plain_find_path(&mut w, i, dest, check);
                    assert_eq!(fast, plain, "route of {i} to {dest} under {check:?}");
                    if fast.is_some() {
                        found += 1;
                    } else {
                        none += 1;
                    }
                }
            }
        }
    }
    assert!(found > 50 && none > 50, "{found} routes found, {none} searches without one");
}

#[test]
fn target_scans_skip_only_cells_without_enemies() {
    let mut w = crowd(30);
    let mut targets = 0;
    let scan_all = |w: &mut World| -> Vec<Option<usize>> {
        let units: Vec<usize> = (0..w.actors.len()).filter(|&i| w.actors[i].alive && w.actors[i].is_unit()).collect();
        units.iter().flat_map(|&i| [w.scan_for_target(i, true), w.scan_for_target(i, false)]).collect()
    };
    w.rebuild_hash();
    assert!(w.hash_owners_valid);
    let fast = scan_all(&mut w);
    w.hash_owners_valid = false;
    assert_eq!(fast, scan_all(&mut w), "the owners per cell change no target");
    targets += fast.iter().flatten().count();
    // A unit changes sides: its cell may now hold an enemy the bits do not show.
    w.rebuild_hash();
    let turned = (0..w.actors.len()).find(|&i| w.actors[i].alive && w.actors[i].kind == Kind::Vehicle && w.actors[i].owner == 0).unwrap();
    w.change_owner(turned, 1, false);
    assert!(!w.hash_owners_valid, "an owner change voids the bits");
    let after = scan_all(&mut w);
    w.rebuild_hash();
    assert_eq!(after, scan_all(&mut w));
    assert!(targets > 100, "{targets} targets found");
}

#[test]
fn hash_owners_name_the_owners_of_each_cells_units() {
    let mut w = crowd(5);
    w.rebuild_hash();
    for ci in 0..w.map.cells() {
        let want = w.units_in_cell(ci).iter().fold(0u32, |m, &u| m | 1 << w.actors[u as usize].owner);
        assert_eq!(w.hash_owners[ci], want, "cell {ci}");
        assert!(w.units_in_cell(ci).windows(2).all(|p| p[0] < p[1]), "units of a cell in actor order");
    }
    let listed: usize = (0..w.map.cells()).map(|ci| w.units_in_cell(ci).len()).sum();
    assert_eq!(listed, w.actors.iter().filter(|a| a.alive && a.is_unit() && a.in_world()).count());
}

#[test]
fn vision_marks_the_cells_of_every_sight_circle() {
    for ticks in [0, 20] {
        let mut w = crowd(ticks);
        // Some units at the map's edges and corners, with short and long sight.
        for (k, &(x, y)) in [(0, 0), (95, 0), (0, 95), (95, 95), (1, 50), (94, 3)].iter().enumerate() {
            let t = w.rules.actor_index(["E1", "3TNK", "JEEP"][k % 3]).unwrap() as u16;
            w.spawn_unit(t, (k % 2) as u8, cell_center(x), cell_center(y), 0);
        }
        let explored: Vec<Vec<u8>> = w.players.iter().map(|p| p.explored.clone()).collect();
        w.update_vision();
        // Every unit's circle, cell by cell, as the vision used to stamp them.
        let mut visible = vec![vec![0u8; w.map.cells()]; w.players.len()];
        let mut seen = explored;
        for i in 0..w.actors.len() {
            let a = &w.actors[i];
            if !a.alive || !a.in_world() || w.players[a.owner as usize].neutral {
                continue;
            }
            let sight = w.env.sight(w.rules.actors[a.ty as usize].sight);
            if sight <= 0 {
                continue;
            }
            let (owner, (cx, cy)) = (a.owner as usize, w.cell_of(a.x, a.y));
            let r = ((sight + CELL - 1) / CELL) as usize;
            for &(dx, dy) in &w.circle_cache[r] {
                if w.map.contains(cx + dx, cy + dy) {
                    let idx = w.map.idx(cx + dx, cy + dy);
                    visible[owner][idx] = 1;
                    seen[owner][idx] = 1;
                }
            }
        }
        for (p, player) in w.players.iter().enumerate() {
            assert_eq!(player.visible, visible[p], "visible cells of player {p} after {ticks} ticks");
            assert_eq!(player.explored, seen[p], "explored cells of player {p} after {ticks} ticks");
        }
    }
}


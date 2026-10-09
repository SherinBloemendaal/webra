//! Large-group pathing tests: crowds, chokepoints, occupied goals.

use crate::map::{Map, Terrain};
use crate::math::{dist, CELL};
use crate::rules::Rules;
use crate::world::{cell_center, Activity, World};

fn ty(w: &World, id: &str) -> u16 {
    w.rules.actor_index(id).unwrap() as u16
}

/// An open `w` x `h` map with two passive players and no structures.
fn arena(w: i32, h: i32) -> World {
    let n = (w * h) as usize;
    let map = Map {
        width: w,
        height: h,
        terrain: vec![Terrain::Clear; n],
        ore: vec![0; n],
        gems: vec![0; n],
        spawns: vec![(1, 1), (w - 3, h - 3)],
    };
    let mut world = World::empty(Rules::load(), map, 9);
    world.stress = true;
    world.add_player(world.rules.faction_index("allies").unwrap(), false, (1, 1));
    world.add_player(world.rules.faction_index("soviet").unwrap(), false, (w - 3, h - 3));
    world
}

fn set_rock(w: &mut World, cells: impl IntoIterator<Item = (i32, i32)>) {
    for (x, y) in cells {
        let i = w.map.idx(x, y);
        w.map.terrain[i] = Terrain::Rock;
        w.pass.set_blocked(i, true);
        w.pass_water.set_blocked(i, true);
        w.pass_landing.set_blocked(i, true);
    }
    w.pass.refresh(&w.map);
    w.pass_water.refresh(&w.map);
    w.pass_landing.refresh(&w.map);
}

/// `n` units of the given types (cycled) in a block of `cols` columns, one
/// tank or two soldiers per cell, starting at cell (x0, y0).
fn spawn_block(w: &mut World, types: &[&str], owner: u8, x0: i32, y0: i32, cols: i32, n: usize) -> Vec<usize> {
    let tys: Vec<u16> = types.iter().map(|t| ty(w, t)).collect();
    let mut out = Vec::new();
    let mut cell = 0;
    while out.len() < n {
        let (cx, cy) = (x0 + cell % cols, y0 + cell / cols);
        cell += 1;
        let t = tys[out.len() % tys.len()];
        if w.rules.actors[t as usize].kind == crate::rules::Kind::Infantry {
            for off in [-256, 256] {
                if out.len() < n {
                    out.push(w.spawn_unit(t, owner, cx * CELL + 512 + off, cell_center(cy), 256));
                }
            }
        } else {
            out.push(w.spawn_unit(t, owner, cell_center(cx), cell_center(cy), 256));
        }
    }
    out
}

#[derive(Debug, Default)]
struct Outcome {
    arrived: usize,
    still_moving: usize,
    /// Units that stopped (Idle) far from the goal.
    gave_up: usize,
    /// Units still ordered to move that did not move at all during the last second.
    frozen: usize,
}

/// Run `ticks` and classify `units` against goal point (gx, gy). A unit
/// counts as arrived within `near` world units of the goal.
fn outcome(w: &mut World, units: &[usize], gx: i32, gy: i32, near: i32, ticks: u32) -> Outcome {
    for _ in 0..ticks.saturating_sub(25) {
        w.step();
    }
    let before: Vec<(i32, i32)> = units.iter().map(|&i| (w.actors[i].x, w.actors[i].y)).collect();
    for _ in 0..25 {
        w.step();
    }
    let mut o = Outcome::default();
    for (k, &i) in units.iter().enumerate() {
        let a = &w.actors[i];
        let d = dist(a.x, a.y, gx, gy);
        if a.activity == Activity::Move {
            o.still_moving += 1;
            if (a.x, a.y) == before[k] {
                o.frozen += 1;
            }
        } else if d <= near {
            o.arrived += 1;
        } else {
            o.gave_up += 1;
        }
    }
    o
}

/// The goal sits just behind a wall 90 cells long: the units first drive
/// away from it, which the old straight-line progress check took for being
/// stuck (they all stopped after 18 seconds).
#[test]
fn a_long_detour_is_not_mistaken_for_being_stuck() {
    let mut w = arena(96, 64);
    set_rock(&mut w, (2..94).map(|x| (x, 30)));
    let units = spawn_block(&mut w, &["3TNK", "E1"], 0, 44, 24, 8, 40);
    let (gx, gy) = (cell_center(48), cell_center(34));
    w.order_move(&units, gx, gy, false);
    let o = outcome(&mut w, &units, gx, gy, 10 * CELL, 25 * 150);
    assert_eq!((o.arrived, o.gave_up, o.still_moving), (40, 0, 0), "{o:?}");
    for &i in &units {
        assert!(w.actors[i].y > 31 * CELL, "every unit got around the wall");
    }
}

/// A structure goes up on the goal while the group drives there. The old
/// code left every unit waiting on an unreachable goal until it gave up.
#[test]
fn a_structure_on_the_goal_sends_the_group_to_the_nearest_open_cell() {
    let mut w = arena(64, 64);
    let units = spawn_block(&mut w, &["1TNK", "E1"], 0, 4, 4, 10, 60);
    let (gx, gy) = (cell_center(40), cell_center(40));
    w.order_move(&units, gx, gy, false);
    for _ in 0..50 {
        w.step();
    }
    let powr = ty(&w, "POWR");
    w.spawn_building(powr, 1, 39, 39).unwrap();
    let o = outcome(&mut w, &units, gx, gy, 8 * CELL, 25 * 60);
    let mut goals: Vec<u32> = units.iter().map(|&i| w.actors[i].goal).collect();
    goals.sort();
    goals.dedup();
    assert_eq!((o.arrived, o.gave_up, o.still_moving), (60, 0, 0), "{o:?}");
    // The group agrees on one new goal, so it still shares one field per locomotor.
    assert_eq!(goals.len(), 1, "goals {goals:?}");
    assert!(!w.pass.blocked[goals[0] as usize]);
}

/// Four hundred tanks squeeze through a one-cell gap to a goal just behind
/// it. The old code let a unit stop anywhere within the group's radius of
/// the goal, and that radius reached back into the gap: the first tank to
/// get there parked in it, every other one stopped against it, and almost
/// the whole army stayed behind the wall. Waiting in the queue for longer
/// than the stuck timeout must not end the move either.
#[test]
fn a_big_group_queues_through_a_gap_instead_of_stopping_short() {
    let mut w = arena(80, 64);
    set_rock(&mut w, (0..64).filter(|&y| y != 32).map(|y| (30, y)));
    let units = spawn_block(&mut w, &["1TNK", "3TNK"], 0, 2, 4, 26, 400);
    let (gx, gy) = (cell_center(42), cell_center(32));
    w.order_move(&units, gx, gy, false);
    let o = outcome(&mut w, &units, gx, gy, 40 * CELL, 25 * 300);
    let behind = units.iter().filter(|&&i| w.actors[i].x < 31 * CELL).count();
    assert_eq!(behind, 0, "units left behind the wall: {o:?}");
    assert_eq!(o.still_moving, 0, "{o:?}");
}

/// A crowd push must not carry a unit diagonally between two rocks into a
/// pocket: flow fields and connectivity never step through such a corner,
/// so a unit inside would have no way out.
#[test]
fn pushes_never_carry_a_unit_through_a_diagonal_crack() {
    let mut w = arena(64, 64);
    // Cell (31, 31) is a pocket that touches the open cell (30, 32) only at a corner.
    set_rock(&mut w, [(30, 30), (31, 30), (32, 30), (32, 31), (32, 32), (31, 32), (30, 31)]);
    let tnk = ty(&w, "1TNK");
    let (x, y) = (31 * CELL - 20, 32 * CELL + 20);
    let pushed = w.spawn_unit(tnk, 0, x, y, 256);
    w.spawn_unit(tnk, 0, x - 300, y + 300, 256);
    let pocket = w.pass.component[w.map.idx(31, 31)];
    assert_ne!(pocket, w.pass.component[w.map.idx(30, 32)]);
    for _ in 0..10 {
        w.step();
        let a = &w.actors[pushed];
        assert_ne!(w.cell_of(a.x, a.y), (31, 31), "pushed through the corner");
    }
}

/// The same crowded orders give the same game, tick for tick.
#[test]
fn crowded_pathing_is_deterministic() {
    let play = || {
        let mut w = arena(64, 64);
        set_rock(&mut w, (0..64).filter(|y| !(30..33).contains(y)).map(|y| (32, y)));
        let a = spawn_block(&mut w, &["1TNK", "E1", "HARV", "JEEP"], 0, 4, 20, 12, 150);
        let b = spawn_block(&mut w, &["3TNK", "E1"], 0, 44, 20, 12, 150);
        w.order_move(&a, cell_center(54), cell_center(31), false);
        w.order_move(&b, cell_center(8), cell_center(31), true);
        let mut hashes = Vec::new();
        for t in 0..25 * 60 {
            w.step();
            if t % 100 == 0 {
                hashes.push(w.state_hash());
            }
        }
        hashes
    };
    assert_eq!(play(), play());
}

/// A thousand mixed units cross a generated map. With the old rules the
/// first units to stall within three group radii of the goal stopped, and
/// the rest piled up against them far from the goal.
#[test]
fn a_thousand_units_cross_a_generated_map_and_gather_at_the_goal() {
    let mut w = World::new_stress(3, 2, 120);
    // The stress setup gives the other side a tank that attack-moves at us:
    // take it out, this is about getting there, not about who gets shot.
    for k in 0..w.actors.len() {
        if w.actors[k].alive && w.actors[k].owner == 1 {
            w.remove(k);
        }
    }
    let units = spawn_block(&mut w, &["1TNK", "E1", "3TNK", "E1", "JEEP", "4TNK"], 0, 4, 4, 30, 1000);
    let units: Vec<usize> = units.into_iter().filter(|&i| !w.pass.blocked[w.cell_index(w.actors[i].x, w.actors[i].y)]).collect();
    let (gx, gy) = (cell_center(100), cell_center(100));
    w.order_move(&units, gx, gy, false);
    let o = outcome(&mut w, &units, gx, gy, 30 * CELL, 25 * 240);
    assert_eq!((o.arrived, o.still_moving), (units.len(), 0), "{o:?}");
}

// ---- "Show unit paths" overlay (paths.rs) ------------------------------------

/// Routes as lists of points, one per selected unit, from the overlay lines.
fn routes(w: &World, player: u8, units: &[usize]) -> Vec<Vec<(f32, f32)>> {
    units
        .iter()
        .map(|&i| {
            let mut lines = Vec::new();
            w.build_paths(player, 1.0, &[w.make_ref(i)], &mut lines);
            let mut pts = Vec::new();
            for seg in lines.chunks(crate::paths::LINE_FLOATS) {
                if pts.is_empty() {
                    pts.push((seg[0], seg[1]));
                }
                assert_eq!(*pts.last().unwrap(), (seg[0], seg[1]), "segments join up");
                pts.push((seg[2], seg[3]));
            }
            pts
        })
        .collect()
}

#[test]
fn unit_paths_follow_the_route_with_one_segment_per_turn() {
    let mut w = arena(64, 64);
    // Allies, so the two tanks do not fight on the way.
    w.players[0].team = 1;
    w.players[1].team = 1;
    // A wall with its only opening at the bottom.
    set_rock(&mut w, (0..58).map(|y| (32, y)));
    let tnk = ty(&w, "1TNK");
    let mine = w.spawn_unit(tnk, 0, cell_center(10), cell_center(10), 256);
    let idle = w.spawn_unit(tnk, 0, cell_center(12), cell_center(12), 256);
    let theirs = w.spawn_unit(tnk, 1, cell_center(10), cell_center(20), 256);
    let (gx, gy) = (cell_center(50), cell_center(10));
    w.order_move(&[mine], gx, gy, false);
    w.order_move(&[theirs], gx, gy, false);
    w.step();
    let fields = w.flow.computed;
    let r = routes(&w, 0, &[mine, idle, theirs]);
    assert!(r[1].is_empty(), "an idle unit has no route");
    assert!(r[2].is_empty(), "no routes of other players' units");
    let route = &r[0];
    let px = |v: i32| crate::render::px(v);
    let a = &w.actors[mine];
    assert_eq!(route[0], (px(a.x), px(a.y)), "starts at the unit");
    assert_eq!(*route.last().unwrap(), (px(gx), px(gy)), "ends on the goal");
    assert!(route.len() <= 8, "waypoints only at turns: {route:?}");
    assert!(route.iter().any(|p| p.1 >= 58.0 * 24.0), "goes through the opening: {route:?}");
    assert_eq!(w.flow.computed, fields, "drawing never computes a field");
    // The route shrinks as the unit drives on, and is gone once it arrived.
    for _ in 0..25 * 60 {
        w.step();
    }
    assert_eq!(w.actors[mine].activity, Activity::Idle);
    assert!(routes(&w, 0, &[mine])[0].is_empty());
}

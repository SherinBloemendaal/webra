//! Tests of units in each other's way on bridges and in narrow gaps (OpenRA
//! movement model, cellmove.rs): idle columns that make way one unit after
//! another, groups that file over a bridge without leaving stragglers,
//! units facing each other that give up and report the blocked route, and
//! the determinism of all of it. Synthetic maps only.

use crate::map::{Map, Terrain};
use crate::movement::MovementModel;
use crate::rules::{Rules, Stance};
use crate::sound_events::{SoundEventKind, EVENT_STRIDE};
use crate::world::{cell_center, Activity, Order, World};

fn ty(w: &World, id: &str) -> u16 {
    w.rules.actor_index(id).unwrap() as u16
}

/// A `w` x `h` map of water with land left of column `x0` and from column
/// `x1` on, joined by a bridge one cell wide (clear cells) on row `y`.
fn bridge_map(w: i32, h: i32, x0: i32, x1: i32, y: i32) -> Map {
    let n = (w * h) as usize;
    let mut terrain = vec![Terrain::Water; n];
    for cy in 0..h {
        for cx in 0..w {
            if cx < x0 || cx >= x1 || cy == y {
                terrain[(cy * w + cx) as usize] = Terrain::Clear;
            }
        }
    }
    Map { width: w, height: h, terrain, ore: vec![0; n], gems: vec![0; n], spawns: vec![(1, 1), (w - 3, h - 3)] }
}

/// Two passive enemy players on `map` with the OpenRA movement model.
fn world_on(map: Map) -> World {
    let (w, h) = (map.width, map.height);
    let mut world = World::empty(Rules::load(), map, 9);
    world.options.movement = MovementModel::OpenRA;
    world.stress = true;
    world.add_player(world.rules.faction_index("allies").unwrap(), false, (1, 1));
    world.add_player(world.rules.faction_index("soviet").unwrap(), false, (w - 3, h - 3));
    world
}

/// Banks left of column 12 and from column 36 on, the bridge on row 10.
fn bridge() -> World {
    world_on(bridge_map(64, 21, 12, 36, 10))
}

/// A unit of player `owner` that holds its fire, so that only movement
/// decides what happens.
fn unit(w: &mut World, id: &str, owner: u8, cx: i32, cy: i32) -> usize {
    let t = ty(w, id);
    let u = w.spawn_unit(t, owner, cell_center(cx), cell_center(cy), 256);
    w.actors[u].stance = Stance::HoldFire;
    u
}

fn move_order(w: &mut World, units: &[usize], cx: i32, cy: i32) {
    let ids = units.iter().map(|&u| w.make_ref(u)).collect();
    w.queue_order(Order::Move { player: w.actors[units[0]].owner, ids, x: cell_center(cx), y: cell_center(cy), attack_move: false });
}

fn cell(w: &World, u: usize) -> (i32, i32) {
    w.cell_of(w.actors[u].x, w.actors[u].y)
}

fn route_blocked_events(w: &mut World) -> Vec<Vec<i32>> {
    w.sound.take().chunks(EVENT_STRIDE).filter(|e| e[0] == SoundEventKind::RouteBlocked as i32).map(|e| e.to_vec()).collect()
}

/// A tank sent over the bridge with `n` idle friendly tanks standing on it
/// in a column: the tick it arrives (None: it gave up), where it ended, and
/// the state hash at the end.
fn cross_column(n: i32) -> (Option<u32>, (i32, i32), u64) {
    let mut w = bridge();
    for x in 16..16 + n {
        unit(&mut w, "2TNK", 0, x, 10);
    }
    let mover = unit(&mut w, "2TNK", 0, 5, 10);
    move_order(&mut w, &[mover], 58, 10);
    for t in 0..25 * 120 {
        w.step();
        if cell(&w, mover) == (58, 10) {
            return (Some(t), (58, 10), w.state_hash());
        }
    }
    (None, cell(&w, mover), w.state_hash())
}

/// OpenRA Mobile.OnNotifyBlockingMove and Nudge: a column of idle tanks on
/// a bridge one cell wide makes way one tank after another (each nudged one
/// asks the next), and the tank behind waits while the column clears
/// instead of giving up after WaitAverage (`cell_is_evacuating`). Before,
/// it gave up behind six or more.
#[test]
fn a_tank_crosses_a_bridge_past_a_column_of_idle_tanks() {
    for n in [1, 3, 6, 10] {
        let (arrived, at, _) = cross_column(n);
        assert!(arrived.is_some(), "behind {n} idle tanks the mover gave up at {at:?}");
    }
    // The same game twice: the same moves.
    assert_eq!(cross_column(8).2, cross_column(8).2, "deterministic");
}

/// A gap one cell wide and six long in a rock wall, filled with idle
/// friendly tanks: a tank sent through gets to the other side.
#[test]
fn a_row_of_idle_tanks_in_a_narrow_gap_makes_way() {
    let n = 48 * 30;
    let mut terrain = vec![Terrain::Clear; n];
    for y in 0..30 {
        for x in 18..24 {
            if y != 15 {
                terrain[y * 48 + x] = Terrain::Rock;
            }
        }
    }
    let mut w = world_on(Map { width: 48, height: 30, terrain, ore: vec![0; n], gems: vec![0; n], spawns: vec![(1, 1), (45, 27)] });
    let row: Vec<usize> = (18..24).map(|x| unit(&mut w, "2TNK", 0, x, 15)).collect();
    let mover = unit(&mut w, "2TNK", 0, 8, 15);
    move_order(&mut w, &[mover], 40, 15);
    let mut arrived = false;
    for _ in 0..25 * 120 {
        w.step();
        if cell(&w, mover) == (40, 15) {
            arrived = true;
            break;
        }
    }
    let row_cells: Vec<_> = row.iter().map(|&u| cell(&w, u)).collect();
    assert!(arrived, "the mover got through the gap: at {:?}, the row at {row_cells:?}", cell(&w, mover));
}

/// A group sent over the bridge files across one tank after another: the
/// ones at the back wait while the queue ahead of them moves (WebRA, see
/// `cell_is_evacuating`) instead of staying behind on the near bank.
#[test]
fn a_group_files_over_a_bridge_without_stragglers() {
    let mut w = bridge();
    let group: Vec<usize> = (0..8).map(|k| unit(&mut w, "2TNK", 0, 2 + k % 4, 9 + k / 4 * 2)).collect();
    move_order(&mut w, &group, 52, 10);
    for _ in 0..25 * 150 {
        w.step();
    }
    let behind: Vec<_> = group.iter().map(|&u| cell(&w, u)).filter(|c| c.0 < 36).collect();
    assert!(behind.is_empty(), "every tank crossed: still on the near bank or the bridge: {behind:?}");
}

/// Two columns that meet head on in the middle of the bridge cannot pass:
/// they wait, look for another way, give up (OpenRA Move.PopPath) and stand
/// still, never waiting on each other for ever; the player hears that the
/// route is blocked (WebRA addition, `SoundEventKind::RouteBlocked`), at
/// most once per `ROUTE_BLOCKED_INTERVAL`.
#[test]
fn columns_meeting_on_a_bridge_give_up_and_report_the_blocked_route() {
    let mut w = bridge();
    w.sound.set_enabled(true);
    let east: Vec<usize> = (2..6).map(|x| unit(&mut w, "2TNK", 0, x, 10)).collect();
    let west: Vec<usize> = (54..58).map(|x| unit(&mut w, "2TNK", 0, x, 10)).collect();
    move_order(&mut w, &east, 60, 10);
    move_order(&mut w, &west, 2, 10);
    let mut events = Vec::new();
    let mut settled = None;
    for t in 0..25 * 60 {
        w.step();
        events.extend(route_blocked_events(&mut w));
        if settled.is_none() && east.iter().chain(&west).all(|&u| w.actors[u].activity == Activity::Idle && !w.actors[u].moved) {
            settled = Some(t);
        }
    }
    assert!(settled.is_some(), "everyone gave up and stands still");
    let on_bridge = east.iter().chain(&west).filter(|&&u| (12..36).contains(&cell(&w, u).0)).count();
    assert!(on_bridge >= 2, "the columns met on the bridge");
    assert!(!events.is_empty(), "the player was told");
    assert!(events.iter().all(|e| e[4] == 0 && (12 * 1024..36 * 1024).contains(&e[2])), "at a unit on the bridge: {events:?}");
    assert!(events.len() <= 25 * 60 / crate::sound_events::ROUTE_BLOCKED_INTERVAL as usize + 1, "throttled: {}", events.len());
}

/// A group move that stops short because it got close enough (OpenRA's 8
/// cells of a move order) is no blocked route.
#[test]
fn stopping_close_to_the_goal_is_not_a_blocked_route() {
    let mut w = bridge();
    w.sound.set_enabled(true);
    let group: Vec<usize> = (0..9).map(|k| unit(&mut w, "2TNK", 0, 2 + k % 3, 3 + k / 3)).collect();
    move_order(&mut w, &group, 4, 16);
    let mut blocked = 0;
    for _ in 0..25 * 40 {
        w.step();
        blocked += route_blocked_events(&mut w).len();
    }
    assert!(group.iter().all(|&u| w.actors[u].activity == Activity::Idle), "the group arrived");
    assert_eq!(blocked, 0);
}

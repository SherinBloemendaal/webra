//! Tests of units queueing in passes and of huge move orders (OpenRA
//! movement model, cellmove.rs): a column ordered through a gap one or
//! three cells wide files through it, waiting its turn, without driving
//! round the map or giving up while the queue ahead moves
//! (`World::queue_is_moving`); a pass that an enemy blocks still makes the
//! units go round or give up (OpenRA Move.PopPath); a crowd boxed in by
//! its own units starts row by row with few route searches in its first
//! tick (`Pending::Boxed`), and the tick's route search budget holds
//! (`ROUTE_SEARCH_BUDGET`). Synthetic maps only.

use crate::map::{Map, Terrain};
use crate::movement::cellmove::Pending;
use crate::movement::search::{ROUTE_SEARCH_BUDGET, SEARCH_LIMIT};
use crate::movement::MovementModel;
use crate::rules::{Rules, Stance};
use crate::sound_events::{SoundEventKind, EVENT_STRIDE};
use crate::world::{cell_center, Activity, Order, World};

const W: i32 = 96;
const H: i32 = 48;
/// The rock wall: columns 44 to 47.
const WALL: (i32, i32) = (44, 48);
/// Rows from here down are the long way round the wall (with `detour`).
const DETOUR_ROW: i32 = 32;

/// A `W` x `H` map with a rock wall four cells thick across it and a gap
/// `gap` cells wide around row 20. With `detour` the wall stops short of
/// the bottom edge: a way round it more than forty cells longer.
fn wall_map(gap: i32, detour: bool) -> Map {
    let n = (W * H) as usize;
    let mut terrain = vec![Terrain::Clear; n];
    let g0 = 20 - (gap - 1) / 2;
    for y in 0..if detour { 42 } else { H } {
        for x in WALL.0..WALL.1 {
            if !(g0..g0 + gap).contains(&y) {
                terrain[(y * W + x) as usize] = Terrain::Rock;
            }
        }
    }
    Map { width: W, height: H, terrain, ore: vec![0; n], gems: vec![0; n], spawns: vec![(1, 1), (W - 3, H - 3)] }
}

/// Two passive enemy players on `map`.
fn world_on(model: MovementModel, map: Map) -> World {
    let mut world = World::empty(Rules::load(), map, 9);
    world.options.movement = model;
    world.stress = true;
    world.add_player(world.rules.faction_index("allies").unwrap(), false, (1, 1));
    world.add_player(world.rules.faction_index("soviet").unwrap(), false, (W - 3, H - 3));
    world.sound.set_enabled(true);
    world
}

/// A medium tank of `owner` at cell (x, y) that holds its fire.
fn tank(w: &mut World, owner: u8, x: i32, y: i32) -> usize {
    let t = w.rules.actor_index("2TNK").unwrap() as u16;
    let u = w.spawn_unit(t, owner, cell_center(x), cell_center(y), 256);
    w.actors[u].stance = Stance::HoldFire;
    u
}

fn cell(w: &World, u: usize) -> (i32, i32) {
    w.cell_of(w.actors[u].x, w.actors[u].y)
}

fn route_blocked_events(w: &mut World) -> usize {
    w.sound.take().chunks(EVENT_STRIDE).filter(|e| e[0] == SoundEventKind::RouteBlocked as i32).count()
}

/// What became of a column sent through the wall.
struct Crossing {
    /// Tanks left in front of the wall when everyone stood still.
    behind: Vec<(i32, i32)>,
    /// Tanks that drove the long way round.
    detoured: usize,
    /// RouteBlocked events (moves that gave up far from the goal).
    blocked: usize,
    /// Ticks until everyone stood still.
    settled: Option<u32>,
    /// Route searches of the whole crossing.
    searches: u64,
    hash: u64,
}

/// `n` tanks in a block `cols` cells wide, ten cells in front of the wall,
/// ordered to a cell 32 cells behind it; `enemy`: an enemy tank stands in
/// the middle of the gap.
fn cross(model: MovementModel, gap: i32, detour: bool, n: i32, cols: i32, enemy: bool) -> Crossing {
    let mut w = world_on(model, wall_map(gap, detour));
    if enemy {
        tank(&mut w, 1, 45, 20);
    }
    let units: Vec<usize> = (0..n).map(|k| tank(&mut w, 0, 34 - k / cols, 20 - cols / 2 + k % cols)).collect();
    let ids = units.iter().map(|&u| w.make_ref(u)).collect();
    w.queue_order(Order::Move { player: 0, ids, x: cell_center(80), y: cell_center(20), attack_move: false });
    let searches = w.search.searches;
    let mut detoured = vec![false; units.len()];
    let (mut blocked, mut settled) = (0, None);
    for t in 0..25 * 240 {
        w.step();
        blocked += route_blocked_events(&mut w);
        for (k, &u) in units.iter().enumerate() {
            detoured[k] |= cell(&w, u).1 >= DETOUR_ROW;
        }
        if units.iter().all(|&u| w.actors[u].activity == Activity::Idle && !w.actors[u].moved) {
            settled = Some(t);
            break;
        }
    }
    Crossing {
        behind: units.iter().map(|&u| cell(&w, u)).filter(|c| c.0 < WALL.1).collect(),
        detoured: detoured.iter().filter(|&&d| d).count(),
        blocked,
        settled,
        searches: w.search.searches - searches,
        hash: w.state_hash(),
    }
}

/// The owner's request: a column ordered through a pass waits its turn and
/// goes through, as long as the queue ahead moves, in a gap one or three
/// cells wide, with a long way round or without one. In OpenRA (and WebRA
/// before) the units at the back gave up or drove round the wall once
/// WaitAverage ran out (24 tanks, gap 1: 11 left behind without the way
/// round, 10 drove round with it), with 50 to 66 route searches for 24
/// tanks; now fewer than two a tank. Beyond the wall the group gathers
/// around its goal as in OpenRA (the last arrivals may stop short).
#[test]
fn a_column_files_through_a_gap_one_or_three_cells_wide() {
    for gap in [1, 3] {
        for detour in [true, false] {
            for (n, cols) in [(12, 3), (24, 4), (40, 5)] {
                let c = cross(MovementModel::OpenRA, gap, detour, n, cols, false);
                let what = format!("gap {gap}, way round {detour}, {n} tanks");
                assert!(c.settled.is_some(), "{what}: everyone came to rest");
                assert!(c.behind.is_empty(), "{what}: left in front of the wall: {:?}", c.behind);
                assert_eq!(c.detoured, 0, "{what}: drove round the wall");
                assert!(c.searches < 2 * n as u64, "{what}: {} route searches", c.searches);
            }
        }
    }
}

/// The WebRA model funnels a column through the same gaps (soft.rs).
#[test]
fn the_webra_model_funnels_a_column_through_a_gap() {
    for gap in [1, 3] {
        let c = cross(MovementModel::WebRA, gap, true, 24, 4, false);
        assert!(c.behind.is_empty() && c.detoured == 0, "gap {gap}: behind {:?}, round {}", c.behind, c.detoured);
    }
}

/// A pass that an enemy blocks is truly blocked: no queue moves through it,
/// so the units do what OpenRA's do (Move.PopPath): with a way round they
/// take it, without one they wait, give up and stand still in front of the
/// wall, and the player hears that the route is blocked.
#[test]
fn a_pass_an_enemy_blocks_makes_them_go_round_or_give_up() {
    let c = cross(MovementModel::OpenRA, 1, true, 12, 3, true);
    assert!(c.settled.is_some(), "everyone came to rest");
    assert!(c.detoured >= 6, "most drove round the wall: {}", c.detoured);
    let c = cross(MovementModel::OpenRA, 1, false, 12, 3, true);
    assert!(c.settled.is_some(), "everyone gave up and stands still");
    assert_eq!(c.behind.len(), 12, "nobody got past the enemy");
    assert!(c.blocked > 0, "the player was told");
}

/// The same crossing twice: the same game.
#[test]
fn queueing_through_a_gap_is_deterministic() {
    for gap in [1, 3] {
        let (a, b) = (cross(MovementModel::OpenRA, gap, true, 24, 4, false), cross(MovementModel::OpenRA, gap, true, 24, 4, false));
        assert_eq!(a.hash, b.hash, "gap {gap}");
    }
}

/// The lobby's stress test with `units` units (sim_bench's map size).
fn stress(units: u32) -> World {
    let size = ((units as f64).sqrt() * 2.2).ceil().max(96.0) as i32;
    World::new_stress(1, units, size)
}

/// The owner's idea for huge armies: a unit boxed in by its own units that
/// are about to move waits for a neighbouring cell to come free before it
/// searches its route. In the first tick of the stress test only the edges
/// of the two crowds search (before: every unit, with up to three searches
/// each); the rows behind follow as cells come free, and every unit is
/// under way as cells come free (the last ones once `QUEUE_PATIENCE` runs
/// out). The tick's route search budget holds: a tick expands at most the
/// budget plus the searches of the move that crossed it (three of
/// `SEARCH_LIMIT` cells at most).
#[test]
fn a_boxed_in_crowd_starts_row_by_row_with_few_searches() {
    let units = 2000;
    let mut w = stress(units);
    let ids: Vec<usize> = (0..w.actors.len()).filter(|&i| w.actors[i].alive && w.actors[i].is_unit()).collect();
    // The ring of the crowd each unit stands on (0: the middle).
    let ring: Vec<i32> = (0..w.actors.len())
        .map(|u| {
            let (x, y) = cell(&w, u);
            let (sx, sy) = w.map.spawns[w.actors[u].owner as usize];
            (x - sx).abs().max((y - sy).abs())
        })
        .collect();
    w.step();
    let first = w.search.searches;
    let boxed = ids.iter().filter(|&&u| w.actors[u].mv.pending == Pending::Boxed).count();
    assert!(first < units as u64 / 2, "searches in the first tick: {first}");
    assert!(boxed > units as usize / 3, "units boxed in: {boxed}");
    // The units in the middle of each crowd start last.
    let mut started = vec![None; w.actors.len()];
    let mut most = w.search.tick_expanded;
    let mut pending = Vec::new();
    for t in 1..1600u32 {
        for &u in &ids {
            if started[u].is_none() && w.actors[u].moved {
                started[u] = Some(t);
            }
        }
        if t % 200 == 0 {
            pending.push(ids.iter().filter(|&&u| w.actors[u].mv.pending != Pending::None).count());
        }
        w.step();
        most = most.max(w.search.tick_expanded);
    }
    assert!(most <= ROUTE_SEARCH_BUDGET + 3 * SEARCH_LIMIT as u64, "a tick expanded {most} cells");
    assert!(w.search.deferred > 0, "the first tick of this crowd reaches the budget");
    assert!(pending.windows(2).all(|p| p[1] <= p[0]) && pending[0] < boxed, "the boxed-in units get going: {pending:?}");
    let left = ids.iter().filter(|&&u| w.actors[u].alive && w.actors[u].mv.pending != Pending::None).count();
    assert_eq!(left, 0, "every route was searched");
    for side in 0..2u8 {
        let mut by_ring: Vec<(i32, u32)> =
            ids.iter().filter(|&&u| w.actors[u].owner == side).filter_map(|&u| started[u].map(|t| (ring[u], t))).collect();
        by_ring.sort();
        let half = by_ring.len() / 2;
        let avg = |s: &[(i32, u32)]| s.iter().map(|&(_, t)| t as u64).sum::<u64>() / s.len().max(1) as u64;
        let (inner, outer) = (avg(&by_ring[..half]), avg(&by_ring[half..]));
        assert!(inner > outer, "side {side}: the inner half starts after the outer half (ticks {inner} and {outer})");
    }
}

/// The stress test twice with the same seed: the same state hashes.
#[test]
fn a_huge_move_order_is_deterministic() {
    let run = || {
        let mut w = stress(2000);
        let mut hashes = Vec::new();
        for t in 1..=300 {
            w.step();
            if t % 25 == 0 {
                hashes.push(w.state_hash());
            }
        }
        hashes
    };
    assert_eq!(run(), run());
}

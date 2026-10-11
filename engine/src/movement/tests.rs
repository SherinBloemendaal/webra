//! Tests of both movement models (movement/): queues at the service depot
//! and the refinery, group moves that come to rest, infantry sharing
//! cells, blockers that make way, the terrain invariant, determinism and
//! the option in saves and replays.

use crate::map::{Map, Terrain};
use crate::math::{dist, CELL};
use crate::movement::occupancy::FULL_CELL;
use crate::movement::MovementModel;
use crate::rules::{Kind, Rules};
use crate::world::{cell_center, Activity, HarvState, Order, World};

fn ty(w: &World, id: &str) -> u16 {
    w.rules.actor_index(id).unwrap() as u16
}

fn open_map(w: i32, h: i32) -> Map {
    let n = (w * h) as usize;
    Map { width: w, height: h, terrain: vec![Terrain::Clear; n], ore: vec![0; n], gems: vec![0; n], spawns: vec![(1, 1), (w - 3, h - 3)] }
}

/// An open `w` x `h` map with two passive players (0 and 1, enemies) on `model`.
fn arena(model: MovementModel, w: i32, h: i32) -> World {
    let mut world = World::empty(Rules::load(), open_map(w, h), 9);
    world.options.movement = model;
    world.stress = true;
    world.add_player(world.rules.faction_index("allies").unwrap(), false, (1, 1));
    world.add_player(world.rules.faction_index("soviet").unwrap(), false, (w - 3, h - 3));
    world
}

/// Terrain on the given cells, passability rebuilt.
fn paint(w: &mut World, terrain: Terrain, cells: impl IntoIterator<Item = (i32, i32)>) {
    for (x, y) in cells {
        let i = w.map.idx(x, y);
        w.map.terrain[i] = terrain;
    }
    w.reset_passability();
}

/// `n` units of `id` for `owner` in a block of `cols` columns from cell (x0, y0).
fn block(w: &mut World, id: &str, owner: u8, x0: i32, y0: i32, cols: i32, n: usize) -> Vec<usize> {
    let t = ty(w, id);
    (0..n as i32).map(|k| w.spawn_unit(t, owner, cell_center(x0 + k % cols), cell_center(y0 + k / cols), 256)).collect()
}

fn refs(w: &World, units: &[usize]) -> Vec<u32> {
    units.iter().map(|&u| w.make_ref(u)).collect()
}

fn move_order(w: &mut World, units: &[usize], cx: i32, cy: i32) {
    let ids = refs(w, units);
    w.queue_order(Order::Move { player: w.actors[units[0]].owner, ids, x: cell_center(cx), y: cell_center(cy), attack_move: false });
}

fn positions(w: &World, units: &[usize]) -> Vec<(i32, i32)> {
    units.iter().map(|&u| (w.actors[u].x, w.actors[u].y)).collect()
}

/// Total distance the units moved between two position lists.
fn displacement(a: &[(i32, i32)], b: &[(i32, i32)]) -> i64 {
    a.iter().zip(b).map(|(p, q)| dist(p.0, p.1, q.0, q.1) as i64).sum()
}

/// Every unit stands on a cell its locomotor may enter (the terrain invariant).
fn assert_on_passable(w: &World, units: &[usize], when: &str) {
    for &u in units {
        let a = &w.actors[u];
        if !a.alive || !a.in_world() {
            continue;
        }
        let ci = w.cell_index(a.x, a.y);
        assert!(!w.pass_of(u).blocked[ci], "{when}: {} {u} on a blocked cell {:?}", w.rules.actors[a.ty as usize].id, w.cell_of(a.x, a.y));
    }
}

/// Step until every unit is idle (or `limit` ticks), checking the terrain
/// invariant on the way. Returns the ticks taken.
fn settle(w: &mut World, units: &[usize], limit: u32) -> u32 {
    for t in 0..limit {
        w.step();
        assert_on_passable(w, units, "settling");
        if units.iter().all(|&u| !w.actors[u].alive || (w.actors[u].activity == Activity::Idle && !w.actors[u].moved)) {
            return t;
        }
    }
    let busy: Vec<_> = units.iter().map(|&u| (w.actors[u].activity, w.cell_of(w.actors[u].x, w.actors[u].y))).collect();
    panic!("{:?}: not settled in {limit} ticks: {busy:?}", w.options.movement);
}

/// How close two standing units of `radius` may be: in the OpenRA model a
/// cell apart (each holds its own cell); in the WebRA model their circles
/// may touch and give a little, never by more than a third of their size.
fn least_gap(model: MovementModel, radius: i32) -> i32 {
    match model {
        MovementModel::OpenRA => CELL,
        MovementModel::WebRA => 2 * radius * 2 / 3,
    }
}

/// Smallest distance between two of the units.
fn closest_pair(w: &World, units: &[usize]) -> i32 {
    let mut best = i32::MAX;
    for (k, &a) in units.iter().enumerate() {
        for &b in &units[k + 1..] {
            best = best.min(dist(w.actors[a].x, w.actors[a].y, w.actors[b].x, w.actors[b].y));
        }
    }
    best
}

// ---- The service depot -----------------------------------------------------------------

/// Damaged tanks sent to one service depot together are repaired one at a
/// time, never overlap while they wait, and stand still once done.
fn depot_queue(model: MovementModel) {
    let mut w = arena(model, 48, 40);
    w.players[0].cash = 100_000;
    let fix = w.spawn_building(ty(&w, "FIX"), 0, 24, 18).unwrap();
    let tanks = block(&mut w, "2TNK", 0, 12, 16, 3, 6);
    let max = w.rules.actors[ty(&w, "2TNK") as usize].hp;
    for &t in &tanks {
        w.actors[t].hp = max / 4;
    }
    let ids = refs(&w, &tanks);
    let (fx, fy) = (w.actors[fix].x, w.actors[fix].y);
    w.queue_order(Order::Smart { player: 0, ids, x: fx, y: fy });
    let radius = w.rules.actors[ty(&w, "2TNK") as usize].unit.as_ref().unwrap().radius;
    let mut hps: Vec<i32> = tanks.iter().map(|&t| w.actors[t].hp).collect();
    let mut done = None;
    for tick in 0..25 * 240 {
        w.step();
        assert_on_passable(&w, &tanks, "depot");
        let now: Vec<i32> = tanks.iter().map(|&t| w.actors[t].hp).collect();
        let healed = now.iter().zip(&hps).filter(|(n, h)| n > h).count();
        assert!(healed <= 1, "{model:?}: {healed} tanks repaired in one tick");
        hps = now;
        // Waiting tanks never overlap (moving ones may brush past at a corner).
        let standing: Vec<usize> = tanks.iter().copied().filter(|&t| !w.actors[t].moved).collect();
        let gap = closest_pair(&w, &standing);
        assert!(gap >= least_gap(model, radius), "{model:?} tick {tick}: standing tanks {gap} apart");
        if done.is_none() && hps.iter().all(|&h| h == max) {
            done = Some(tick);
        }
        if let Some(d) = done {
            if tick > d + 25 * 20 {
                break;
            }
        }
    }
    assert!(done.is_some(), "{model:?}: all six repaired in four minutes: {hps:?}");
    // Done and gone to the rally point: nobody moves any more.
    settle(&mut w, &tanks, 25 * 60);
    let before = positions(&w, &tanks);
    for _ in 0..200 {
        w.step();
    }
    assert_eq!(displacement(&before, &positions(&w, &tanks)), 0, "{model:?}: repaired tanks keep still");
}

#[test]
fn depot_repairs_one_at_a_time_openra() {
    depot_queue(MovementModel::OpenRA);
}

#[test]
fn depot_repairs_one_at_a_time_webra() {
    depot_queue(MovementModel::WebRA);
}

// ---- Group moves -----------------------------------------------------------------------

/// A group sent to one cell comes to rest: once every unit is idle, nobody
/// moves for good (no perpetual jostling).
fn group_settles(model: MovementModel, id: &str, n: usize) {
    let mut w = arena(model, 48, 48);
    let units = block(&mut w, id, 0, 6, 6, 5, n);
    let start = positions(&w, &units);
    move_order(&mut w, &units, 30, 30);
    settle(&mut w, &units, 25 * 120);
    // Everybody is idle; overlaps left by the last arrivals may take a few
    // seconds to even out (WebRA's model), then nothing moves any more.
    for _ in 0..25 * 4 {
        w.step();
    }
    let before = positions(&w, &units);
    for _ in 0..300 {
        w.step();
        assert_on_passable(&w, &units, "after arrival");
    }
    assert_eq!(displacement(&before, &positions(&w, &units)), 0, "{model:?}: {id} keep still after arrival");
    // They gathered around the target: within the 8 cells a blocked move
    // order may stop short of it. As in OpenRA, a unit kept waiting behind
    // units that do not move gives up once the target cell is taken: in a
    // long column (a big group on one diagonal lane) the tail stops on the
    // way, and is sent on with another order.
    let gaps: Vec<i32> = units.iter().map(|&u| dist(w.actors[u].x, w.actors[u].y, cell_center(30), cell_center(30))).collect();
    let near = gaps.iter().filter(|&&d| d <= 8 * CELL).count();
    let long_column = model == MovementModel::OpenRA && n > 20;
    let share = if long_column { 2 } else { 4 };
    assert!(near * 5 >= units.len() * share, "{model:?}: {id} near the target: {gaps:?}");
    if long_column {
        move_order(&mut w, &units, 30, 30);
        settle(&mut w, &units, 25 * 120);
        let near = units.iter().filter(|&&u| dist(w.actors[u].x, w.actors[u].y, cell_center(30), cell_center(30)) <= 8 * CELL).count();
        assert!(near * 5 >= units.len() * 4, "{model:?}: {id} near the target after a second order");
        return;
    }
    // Nobody stayed where it started.
    for (k, &u) in units.iter().enumerate() {
        let left = dist(start[k].0, start[k].1, cell_center(30), cell_center(30));
        assert!(gaps[k] + 4 * CELL <= left, "{model:?}: {id} {u} stayed behind: {gaps:?}");
    }
}

#[test]
fn group_of_tanks_settles_openra() {
    group_settles(MovementModel::OpenRA, "2TNK", 15);
}

#[test]
fn group_of_tanks_settles_webra() {
    group_settles(MovementModel::WebRA, "2TNK", 15);
}

#[test]
fn a_big_group_of_tanks_settles_openra() {
    group_settles(MovementModel::OpenRA, "1TNK", 40);
}

#[test]
fn a_big_group_of_tanks_settles_webra() {
    group_settles(MovementModel::WebRA, "1TNK", 40);
}

#[test]
fn group_of_infantry_settles_openra() {
    group_settles(MovementModel::OpenRA, "E1", 20);
}

#[test]
fn group_of_infantry_settles_webra() {
    group_settles(MovementModel::WebRA, "E1", 20);
}

/// OpenRA model: soldiers share cells, five at most (sub-cells), each on
/// its own sub-cell; a tank holds a cell alone.
#[test]
fn infantry_share_cells_five_at_most() {
    let mut w = arena(MovementModel::OpenRA, 40, 40);
    let men = block(&mut w, "E1", 0, 4, 4, 4, 12);
    move_order(&mut w, &men, 20, 20);
    settle(&mut w, &men, 25 * 90);
    let mut per_cell = std::collections::BTreeMap::new();
    for &m in &men {
        let a = &w.actors[m];
        assert_ne!(a.mv.to_sub, FULL_CELL, "soldiers stand on sub-cells");
        assert_eq!(w.cell_index(a.x, a.y) as u32, a.mv.to);
        per_cell.entry(a.mv.to).or_insert_with(Vec::new).push(a.mv.to_sub);
    }
    for (cell, subs) in &per_cell {
        assert!(subs.len() <= 5, "cell {cell} holds {} soldiers", subs.len());
        let mut s = subs.clone();
        s.dedup();
        s.sort();
        s.dedup();
        assert_eq!(s.len(), subs.len(), "one soldier per sub-cell: {subs:?}");
    }
    let target = w.map.idx(20, 20) as u32;
    assert_eq!(per_cell.get(&target).map_or(0, |v| v.len()), 5, "the target cell fills up: {per_cell:?}");
    // A tank does not share: sent onto the full cell, it stops next to it.
    let tank = block(&mut w, "2TNK", 0, 10, 20, 1, 1)[0];
    move_order(&mut w, &[tank], 20, 20);
    settle(&mut w, &[tank], 25 * 60);
    assert_ne!(w.actors[tank].mv.to, target);
    assert!(w.others_at(w.actors[tank].mv.to, tank).next().is_none(), "the tank has its cell to itself");
}

// ---- Blockers --------------------------------------------------------------------------

/// A 1-cell gap in a rock wall with an idle friendly tank in it: a tank
/// sent through gets past (the blocker is nudged aside, or pushed in the
/// WebRA model) and arrives.
fn blocker_makes_way(model: MovementModel) {
    let mut w = arena(model, 40, 30);
    paint(&mut w, Terrain::Rock, (0..30).filter(|&y| y != 15).map(|y| (20, y)));
    let blocker = block(&mut w, "2TNK", 0, 20, 15, 1, 1)[0];
    let mover = block(&mut w, "2TNK", 0, 10, 15, 1, 1)[0];
    move_order(&mut w, &[mover], 30, 15);
    settle(&mut w, &[mover, blocker], 25 * 90);
    let (cx, cy) = w.cell_of(w.actors[mover].x, w.actors[mover].y);
    match model {
        MovementModel::OpenRA => assert_eq!((cx, cy), (30, 15), "{model:?}: the mover arrived"),
        // The pushed blocker went ahead through the gap: the mover stops
        // against it in its arrival zone (movement/soft.rs).
        MovementModel::WebRA => assert!(
            cx > 20 && dist(w.actors[mover].x, w.actors[mover].y, cell_center(30), cell_center(15)) <= 5 * CELL,
            "{model:?}: the mover got through: {:?}",
            (cx, cy)
        ),
    }
    assert_ne!(w.cell_of(w.actors[blocker].x, w.actors[blocker].y), (20, 15), "{model:?}: the gap is free again");
}

#[test]
fn blocker_makes_way_openra() {
    blocker_makes_way(MovementModel::OpenRA);
}

#[test]
fn blocker_makes_way_webra() {
    blocker_makes_way(MovementModel::WebRA);
}

/// OpenRA model: an idle friendly unit on the way is nudged (moves to a
/// neighbouring cell) as soon as the mover finds it in its next cell, and
/// an enemy in the way stops the move instead.
#[test]
fn idle_friends_are_nudged_enemies_stop_the_move() {
    let mut w = arena(MovementModel::OpenRA, 40, 30);
    paint(&mut w, Terrain::Rock, (0..30).filter(|&y| y != 15).map(|y| (20, y)));
    let friend = block(&mut w, "2TNK", 0, 20, 15, 1, 1)[0];
    let mover = block(&mut w, "2TNK", 0, 17, 15, 1, 1)[0];
    move_order(&mut w, &[mover], 30, 15);
    let mut nudged = false;
    for _ in 0..25 * 10 {
        w.step();
        nudged |= w.actors[friend].activity == Activity::Move;
    }
    assert!(nudged, "the idle friend was asked to make way");
    // An enemy tank in the gap: the move ends in front of it.
    let mut w = arena(MovementModel::OpenRA, 40, 30);
    paint(&mut w, Terrain::Rock, (0..30).filter(|&y| y != 15).map(|y| (20, y)));
    w.actors.iter_mut().for_each(|a| a.stance = crate::rules::Stance::HoldFire);
    let enemy = block(&mut w, "2TNK", 1, 20, 15, 1, 1)[0];
    w.actors[enemy].stance = crate::rules::Stance::HoldFire;
    let mover = block(&mut w, "2TNK", 0, 17, 15, 1, 1)[0];
    w.actors[mover].stance = crate::rules::Stance::HoldFire;
    move_order(&mut w, &[mover], 30, 15);
    settle(&mut w, &[mover], 25 * 30);
    assert!(w.cell_of(w.actors[mover].x, w.actors[mover].y).0 < 20, "stopped in front of the enemy");
    assert_eq!(w.cell_of(w.actors[enemy].x, w.actors[enemy].y), (20, 15), "enemies are not nudged");
}

/// OpenRA model: a tank driving through enemy soldiers runs over those that
/// do not jump aside; none is ever pushed.
#[test]
fn tanks_crush_enemy_soldiers_in_their_cells() {
    let mut w = arena(MovementModel::OpenRA, 40, 20);
    let men = block(&mut w, "E1", 1, 15, 10, 1, 1);
    for &m in &men {
        w.actors[m].stance = crate::rules::Stance::HoldFire;
    }
    // Rock all around but on the tank's side: the soldier cannot jump aside
    // (the tank still holds the cell it comes from when it warns).
    paint(&mut w, Terrain::Rock, [(15, 9), (15, 11), (14, 9), (14, 11), (16, 9), (16, 11), (16, 10)]);
    let tank = block(&mut w, "2TNK", 0, 5, 10, 1, 1)[0];
    w.actors[tank].stance = crate::rules::Stance::HoldFire;
    move_order(&mut w, &[tank], 15, 10);
    for _ in 0..25 * 20 {
        w.step();
    }
    assert!(!w.actors[men[0]].alive, "run over");
    assert_eq!(w.cell_of(w.actors[tank].x, w.actors[tank].y), (15, 10));
}

/// OpenRA model: a soldier in a tank's way that can jump aside often does
/// (Crushable.WarnProbability), and is never pushed.
#[test]
fn soldiers_in_the_open_often_jump_aside() {
    let (mut alive, n) = (0u64, 12u64);
    for k in 0..n {
        let mut w = arena(MovementModel::OpenRA, 40, 20);
        w.claim_salt = k;
        let man = block(&mut w, "E1", 1, 15, 10, 1, 1)[0];
        w.actors[man].stance = crate::rules::Stance::HoldFire;
        let tank = block(&mut w, "2TNK", 0, 5, 10, 1, 1)[0];
        w.actors[tank].stance = crate::rules::Stance::HoldFire;
        move_order(&mut w, &[tank], 25, 10);
        for _ in 0..25 * 20 {
            w.step();
            assert_on_passable(&w, &[man, tank], "crush");
        }
        alive += w.actors[man].alive as u64;
    }
    assert!(alive * 4 >= n && alive < n, "{alive} of {n} soldiers got out of the way");
}

// ---- The terrain invariant ----------------------------------------------------------------

/// Crowds on a shore, in both models: land units never end up on water and
/// ships never on land, whatever pushes or nudges them.
fn shore_crowds(model: MovementModel) {
    let mut w = arena(model, 48, 40);
    // Sea east of column 24, with a jagged coast.
    let sea: Vec<(i32, i32)> = (0..40).flat_map(|y| (24 + (y % 3)..48).map(move |x| (x, y))).collect();
    paint(&mut w, Terrain::Water, sea);
    let tanks = block(&mut w, "2TNK", 0, 14, 10, 4, 16);
    let men = block(&mut w, "E1", 0, 14, 20, 5, 15);
    let ships = block(&mut w, "DD", 0, 34, 10, 4, 12);
    let mut all = tanks.clone();
    all.extend(&men);
    all.extend(&ships);
    // Everybody to the coast at once, then scatter and back.
    move_order(&mut w, &tanks, 26, 16);
    move_order(&mut w, &men, 26, 16);
    move_order(&mut w, &ships, 23, 16);
    for t in 0..25 * 60 {
        w.step();
        assert_on_passable(&w, &all, "shore");
        if t == 25 * 30 {
            let ids = refs(&w, &all);
            w.queue_order(Order::Scatter { player: 0, ids });
        }
    }
    for &s in &ships {
        assert_eq!(w.actors[s].kind, Kind::Ship);
    }
}

#[test]
fn nobody_ends_up_on_terrain_it_cannot_enter_openra() {
    shore_crowds(MovementModel::OpenRA);
}

#[test]
fn nobody_ends_up_on_terrain_it_cannot_enter_webra() {
    shore_crowds(MovementModel::WebRA);
}

// ---- Refinery queue ----------------------------------------------------------------------

/// Full ore trucks coming back at once unload one after another, and the
/// ones waiting never overlap.
fn refinery_queue(model: MovementModel) {
    let mut w = arena(model, 48, 40);
    let proc_ = w.spawn_building(ty(&w, "PROC"), 0, 24, 18).unwrap();
    // The refinery's free truck is not part of this test.
    let trucks: Vec<usize> = (0..w.actors.len()).filter(|&i| w.actors[i].alive && w.is_harvester(i)).collect();
    for t in trucks {
        w.remove(t);
    }
    let harv = ty(&w, "HARV");
    let cap = w.rules.actors[harv as usize].unit.as_ref().unwrap().harvester.as_ref().unwrap().capacity;
    let trucks: Vec<usize> = (0..4).map(|k| w.spawn_unit(harv, 0, cell_center(14 + 2 * k), cell_center(8), 512)).collect();
    let proc_ref = w.make_ref(proc_);
    for &t in &trucks {
        let a = &mut w.actors[t];
        a.bales = cap;
        a.activity = Activity::Harvest;
        a.harv = HarvState::ToDock;
        a.refinery = proc_ref;
    }
    let radius = w.rules.actors[harv as usize].unit.as_ref().unwrap().radius;
    let mut unloaded = vec![false; trucks.len()];
    for tick in 0..25 * 240 {
        w.step();
        assert_on_passable(&w, &trucks, "refinery");
        let docked = trucks.iter().filter(|&&t| w.actors[t].harv == HarvState::Unloading).count();
        assert!(docked <= 1, "{model:?}: {docked} trucks on the dock at once");
        let standing: Vec<usize> = trucks.iter().copied().filter(|&t| !w.actors[t].moved).collect();
        let gap = closest_pair(&w, &standing);
        assert!(gap >= least_gap(model, radius), "{model:?} tick {tick}: waiting trucks {gap} apart");
        for (k, &t) in trucks.iter().enumerate() {
            unloaded[k] |= w.actors[t].bales == 0;
        }
        if unloaded.iter().all(|&u| u) {
            return;
        }
    }
    panic!("{model:?}: not every truck unloaded: {unloaded:?}");
}

#[test]
fn harvesters_queue_at_the_refinery_openra() {
    refinery_queue(MovementModel::OpenRA);
}

#[test]
fn harvesters_queue_at_the_refinery_webra() {
    refinery_queue(MovementModel::WebRA);
}

// ---- Determinism, saves and replays ---------------------------------------------------------

/// An AI game is the same game twice, in either model; the model is part of the state.
#[test]
fn both_models_are_deterministic_and_the_model_is_game_state() {
    let run = |model: MovementModel| {
        let options = crate::world::GameOptions { movement: model, ..Default::default() };
        let players = [
            crate::world::PlayerSetup::new("allies", Some(crate::world::AiDifficulty::Normal)),
            crate::world::PlayerSetup::new("soviet", Some(crate::world::AiDifficulty::Normal)),
        ];
        let mut w = World::with_options(5, 64, &players, options);
        let mut hashes = Vec::new();
        for t in 0..25 * 90 {
            w.step();
            if t % 250 == 0 {
                hashes.push(w.state_hash());
            }
        }
        hashes
    };
    for model in MovementModel::ALL {
        assert_eq!(run(model), run(model), "{model:?} is deterministic");
    }
    assert_ne!(run(MovementModel::OpenRA)[0], run(MovementModel::WebRA)[0], "the model is in the state hash");
}

/// The lobby option travels in the game options: saves and replays carry
/// it, and those from before the option (no `movement`) play WebRA's model.
#[test]
fn the_option_round_trips_through_game_options() {
    let base = r#"{"seed": 3, "mapSize": 64, "players": [{"type": "human", "faction": "england"}, {"type": "ai", "faction": "russia"}]"#;
    let model = |extra: &str| crate::parse_options(&format!("{base}{extra}}}")).map(|p| p.options.movement);
    assert_eq!(model(""), Ok(MovementModel::WebRA), "games from before the option");
    assert_eq!(model(r#", "movement": "openra""#), Ok(MovementModel::OpenRA));
    assert_eq!(model(r#", "movement": "webra""#), Ok(MovementModel::WebRA));
    assert!(model(r#", "movement": "push""#).is_err());
    assert!(model(r#", "movement": 1"#).is_err());
    // A game replayed from its options and orders is the same game.
    let replay = |extra: &str| {
        let mut g = crate::Game::from_options(&format!("{base}{extra}}}")).unwrap();
        for _ in 0..25 * 30 {
            g.world.step();
        }
        g.world.state_hash()
    };
    assert_eq!(replay(r#", "movement": "openra""#), replay(r#", "movement": "openra""#));
    assert_eq!(replay(""), replay(r#", "movement": "webra""#), "absent is WebRA's model");
    assert_ne!(replay(r#", "movement": "openra""#), replay(r#", "movement": "webra""#));
}

// ---- The OpenRA model's counterparts of WebRA-model tests ------------------------------------

/// OpenRA model on snow: a vehicle still builds up speed slowly, but a stop
/// order lets it finish the step to its next cell and then it stands on
/// that cell: it never slides off the grid (WebRA's model lets it slide,
/// tests_weather.rs).
#[test]
fn snow_vehicles_start_slowly_and_stop_on_a_cell_openra() {
    use crate::weather::{Biome, Environment, WeatherMode};
    let drive = |biome: Biome, ticks: u32| {
        let mut w = arena(MovementModel::OpenRA, 48, 48);
        w.env = Environment::new(biome, WeatherMode::Full, 5);
        let t = block(&mut w, "1TNK", 0, 4, 24, 1, 1)[0];
        w.actors[t].facing = 256;
        let x0 = w.actors[t].x;
        move_order(&mut w, &[t], 44, 24);
        for _ in 0..ticks {
            w.step();
        }
        let driven = w.actors[t].x - x0;
        let ids = refs(&w, &[t]);
        w.queue_order(Order::Stop { player: 0, ids });
        for _ in 0..40 {
            w.step();
        }
        let a = &w.actors[t];
        assert!(w.at_step_end(t), "{biome:?}: stands on its cell point");
        assert_eq!((a.x - 512) % CELL, 0, "{biome:?}: on a cell centre: {}", a.x);
        assert_eq!(a.env.vel, 0, "{biome:?}: no momentum left");
        driven
    };
    let (temperate, snow) = (drive(Biome::Temperate, 6), drive(Biome::Snow, 6));
    assert!(snow < temperate * 3 / 4, "snow start {snow} vs {temperate}");
    let (temperate_long, snow_long) = (drive(Biome::Temperate, 120), drive(Biome::Snow, 120));
    assert!(snow_long * 100 >= temperate_long * 90, "snow cruise {snow_long} vs {temperate_long}");
}

/// OpenRA model: a group sent across water it cannot cross stops on the
/// near shore; the group shares its flow field and its route searches stay
/// small, and once everybody stands nothing is searched any more.
#[test]
fn a_move_across_water_ends_on_the_near_shore_openra() {
    for n in [1usize, 50, 200] {
        let mut w = arena(MovementModel::OpenRA, 96, 64);
        paint(&mut w, Terrain::Water, (0..64).map(|y| (48, y)));
        let units = block(&mut w, "1TNK", 0, 6, 6, 20, n);
        move_order(&mut w, &units, 90, 30);
        let (f0, s0) = (w.flow.computed, w.search.expanded);
        settle(&mut w, &units, 25 * 90);
        let (fields, searched) = (w.flow.computed - f0, w.search.expanded - s0);
        for &u in &units {
            assert!(w.actors[u].x < 48 * CELL, "{n} units: never on the water");
        }
        // One field toward the near shore (grown as the group asks from
        // farther cells); searches around the others, a few hundred cells a unit.
        assert!(fields <= 6, "{n} units: {fields} fields");
        assert!(searched <= 400 * n as u64 + 2000, "{n} units: {searched} cells searched");
        let (f1, s1) = (w.flow.computed, w.search.expanded);
        for _ in 0..100 {
            w.step();
        }
        assert_eq!((w.flow.computed - f1, w.search.expanded - s1), (0, 0), "{n} units standing still cost nothing");
    }
}

/// OpenRA model: a ford cut while a group drives to it stops the group on
/// the near bank, as in OpenRA (the move ends where the way is blocked);
/// ordered again once the ford is back, the group crosses.
#[test]
fn a_crossing_cut_mid_route_stops_the_group_openra() {
    let mut w = arena(MovementModel::OpenRA, 96, 64);
    paint(&mut w, Terrain::Water, (0..64).filter(|&y| y != 32).map(|y| (48, y)));
    let units = block(&mut w, "1TNK", 0, 20, 26, 5, 15);
    move_order(&mut w, &units, 70, 32);
    for _ in 0..25 * 3 {
        w.step();
    }
    let ford = w.map.idx(48, 32);
    w.map.terrain[ford] = Terrain::Water;
    w.reset_passability();
    settle(&mut w, &units, 25 * 60);
    assert!(units.iter().all(|&u| w.actors[u].x < 48 * CELL), "nobody crossed the cut ford");
    w.map.terrain[ford] = Terrain::Clear;
    w.reset_passability();
    move_order(&mut w, &units, 70, 32);
    settle(&mut w, &units, 25 * 120);
    // One at a time through the ford: as in OpenRA, a tank kept waiting
    // behind others once the destination is taken gives up its move.
    let crossed = units.iter().filter(|&&u| w.actors[u].x > 48 * CELL).count();
    assert!(crossed * 2 >= units.len(), "{crossed} of {} crossed once the ford was back", units.len());
}

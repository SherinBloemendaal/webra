//! Production exits (production.rs `select_exit`, OpenRA Production.Produce
//! with CanUseExit, ClassicProductionQueue.BuildUnit): a finished unit
//! leaves only by an exit cell it can enter, one at a time, so instant
//! builds (the debug menu) never stack units; friendly idle units on the
//! exit are asked to make way, enemies keep the unit in the factory, a
//! blocked primary factory hands over to another, and exits are tried by
//! priority. Synthetic maps only.

use crate::map::{Map, Terrain};
use crate::movement::MovementModel;
use crate::rules::{Kind, QueueType, Rules, Stance};
use crate::sound_events::{SoundEventKind, EVENT_STRIDE};
use crate::world::{cell_center, Activity, Order, World};

fn ty(w: &World, id: &str) -> u16 {
    w.rules.actor_index(id).unwrap() as u16
}

/// An open 48 x 40 map with two passive enemy players on `model`.
fn arena(model: MovementModel) -> World {
    let n = 48 * 40;
    let map =
        Map { width: 48, height: 40, terrain: vec![Terrain::Clear; n], ore: vec![0; n], gems: vec![0; n], spawns: vec![(1, 1), (45, 37)] };
    let mut w = World::empty(Rules::load(), map, 9);
    w.options.movement = model;
    w.stress = true;
    w.add_player(w.rules.faction_index("allies").unwrap(), false, (1, 1));
    w.add_player(w.rules.faction_index("soviet").unwrap(), false, (45, 37));
    w
}

/// A structure `id` of player 0 at (cx, cy), with money, instant builds and every prerequisite.
fn factory(w: &mut World, id: &str, cx: i32, cy: i32) -> usize {
    let b = w.spawn_building(ty(w, id), 0, cx, cy).unwrap_or_else(|| panic!("{id} fits"));
    w.players[0].cash = 1_000_000;
    w.players[0].dev.fast_build = true;
    w.players[0].dev.all_tech = true;
    w.refresh_tokens();
    w.update_power();
    b
}

fn unit(w: &mut World, id: &str, owner: u8, cx: i32, cy: i32) -> usize {
    let t = ty(w, id);
    let u = w.spawn_unit(t, owner, cell_center(cx), cell_center(cy), 256);
    w.actors[u].stance = Stance::HoldFire;
    u
}

fn all_of(w: &World, id: &str) -> Vec<usize> {
    let t = ty(w, id);
    (0..w.actors.len()).filter(|&i| w.actors[i].alive && w.actors[i].ty == t).collect()
}

fn cell(w: &World, u: usize) -> (i32, i32) {
    w.cell_of(w.actors[u].x, w.actors[u].y)
}

/// Most units of `kind` standing in one cell.
fn most_in_a_cell(w: &World, kind: Kind) -> usize {
    let mut cells = std::collections::BTreeMap::new();
    for a in w.actors.iter().filter(|a| a.alive && a.kind == kind) {
        *cells.entry(w.cell_of(a.x, a.y)).or_insert(0usize) += 1;
    }
    cells.values().copied().max().unwrap_or(0)
}

fn events(w: &mut World, kind: SoundEventKind) -> usize {
    w.sound.take().chunks(EVENT_STRIDE).filter(|e| e[0] == kind as i32).count()
}

/// The war factory's exit cell (WEAP ExitCell 1,2) for a factory at (cx, cy).
fn weap_exit(cx: i32, cy: i32) -> (i32, i32) {
    (cx + 1, cy + 2)
}

/// Twenty tanks built instantly from one war factory (the debug menu's
/// instant build, with and without a rally point) come out one at a time:
/// never two vehicles in one cell, and all of them are out in good time.
/// Returns the state hash at the end.
fn instant_tanks(rally: Option<(i32, i32)>) -> u64 {
    let mut w = arena(MovementModel::OpenRA);
    let weap = factory(&mut w, "WEAP", 20, 10);
    w.actors[weap].rally = rally.map(|(x, y)| (cell_center(x), cell_center(y)));
    let t = ty(&w, "1TNK");
    w.start_production(0, t, 20);
    let mut out = None;
    for tick in 0..25 * 60 {
        w.step();
        assert!(most_in_a_cell(&w, Kind::Vehicle) <= 1, "tick {tick}: vehicles stacked on one cell");
        if out.is_none() && w.players[0].queues[QueueType::Vehicle as usize].items.is_empty() {
            out = Some(tick);
        }
    }
    assert_eq!(all_of(&w, "1TNK").len(), 20);
    assert!(out.is_some_and(|t| t < 25 * 40), "all twenty out within 40 s: {out:?}");
    w.state_hash()
}

#[test]
fn instant_builds_come_out_one_at_a_time() {
    let a = instant_tanks(None);
    instant_tanks(Some((30, 30)));
    assert_eq!(a, instant_tanks(None), "deterministic");
}

/// Infantry share their exit cell up to five at a time, each on its own sub-cell.
#[test]
fn instant_infantry_share_the_exit_five_at_most() {
    let mut w = arena(MovementModel::OpenRA);
    factory(&mut w, "TENT", 20, 10);
    let t = ty(&w, "E1");
    w.start_production(0, t, 20);
    for tick in 0..25 * 40 {
        w.step();
        // Soldiers hold one sub-cell of the cell they stand on or step into
        // (a soldier stepping out still stands over the cell it left).
        let mut held = std::collections::BTreeMap::new();
        for a in w.actors.iter().filter(|a| a.alive && a.kind == Kind::Infantry) {
            held.entry(a.mv.to).or_insert_with(Vec::new).push(a.mv.to_sub);
        }
        for subs in held.values_mut() {
            let n = subs.len();
            subs.sort_unstable();
            subs.dedup();
            assert!(n <= 5 && subs.len() == n, "tick {tick}: soldiers share a sub-cell or crowd a cell: {subs:?} of {n}");
        }
    }
    assert_eq!(all_of(&w, "E1").len(), 20);
}

/// An enemy on the exit keeps the finished tank in the factory (OpenRA
/// CanUseExit: BlockedByActor.All); the queue reports it once (BlockedAudio)
/// and the tank comes out once the enemy has left.
#[test]
fn an_enemy_on_the_exit_keeps_the_unit_inside() {
    let mut w = arena(MovementModel::OpenRA);
    w.sound.set_enabled(true);
    factory(&mut w, "WEAP", 20, 10);
    w.players[0].dev.fast_build = false;
    let (ex, ey) = weap_exit(20, 10);
    let enemy = unit(&mut w, "2TNK", 1, ex, ey);
    let t = ty(&w, "1TNK");
    w.start_production(0, t, 1);
    let mut blocked = 0;
    for _ in 0..25 * 60 {
        w.step();
        blocked += events(&mut w, SoundEventKind::ProductionBlocked);
    }
    assert!(w.players[0].queues[QueueType::Vehicle as usize].items.first().is_some_and(|it| it.done), "finished");
    assert!(all_of(&w, "1TNK").is_empty(), "still inside");
    assert_eq!(blocked, 1, "reported once");
    assert_eq!(cell(&w, enemy), (ex, ey), "enemies are not asked to make way");
    let id = w.make_ref(enemy);
    w.queue_order(Order::Move { player: 1, ids: vec![id], x: cell_center(40), y: cell_center(30), attack_move: false });
    for _ in 0..25 * 10 {
        w.step();
    }
    assert_eq!(all_of(&w, "1TNK").len(), 1, "out once the exit is free");
}

/// An own idle tank parked on the exit is asked to make way (OpenRA
/// Production.CanUseExit notifies the blocker: Nudge), and the new tanks
/// come out.
#[test]
fn an_idle_friend_on_the_exit_makes_way() {
    for model in [MovementModel::OpenRA, MovementModel::WebRA] {
        let mut w = arena(model);
        factory(&mut w, "WEAP", 20, 10);
        let (ex, ey) = weap_exit(20, 10);
        let friend = unit(&mut w, "2TNK", 0, ex, ey);
        let t = ty(&w, "1TNK");
        w.start_production(0, t, 3);
        for _ in 0..25 * 20 {
            w.step();
        }
        assert_eq!(all_of(&w, "1TNK").len(), 3, "{model:?}: all out");
        assert_ne!(cell(&w, friend), (ex, ey), "{model:?}: the friend made way");
        assert_eq!(w.actors[friend].activity, Activity::Idle, "{model:?}");
    }
}

/// The WebRA movement model: an idle enemy on the exit keeps the unit in
/// too (units there hold no cells, so only standing ones count).
#[test]
fn webra_model_an_enemy_on_the_exit_keeps_the_unit_inside() {
    let mut w = arena(MovementModel::WebRA);
    factory(&mut w, "WEAP", 20, 10);
    let (ex, ey) = weap_exit(20, 10);
    unit(&mut w, "2TNK", 1, ex, ey);
    let t = ty(&w, "1TNK");
    w.start_production(0, t, 1);
    for _ in 0..25 * 10 {
        w.step();
    }
    assert!(all_of(&w, "1TNK").is_empty());
}

/// OpenRA ClassicProductionQueue.BuildUnit tries every producer: with the
/// primary war factory's exit held by an enemy, the tank leaves the other.
#[test]
fn a_blocked_primary_factory_hands_over_to_another() {
    let mut w = arena(MovementModel::OpenRA);
    let first = factory(&mut w, "WEAP", 10, 10);
    let second = factory(&mut w, "WEAP", 30, 10);
    w.actors[first].primary = true;
    let (ex, ey) = weap_exit(10, 10);
    unit(&mut w, "2TNK", 1, ex, ey);
    let t = ty(&w, "1TNK");
    w.start_production(0, t, 1);
    for _ in 0..25 {
        w.step();
    }
    let tanks = all_of(&w, "1TNK");
    assert_eq!(tanks.len(), 1);
    assert_eq!(cell(&w, tanks[0]), weap_exit(30, 10), "out of the second factory");
    assert!(w.actors[second].alive);
}

/// OpenRA ExitInfo.Priority: the kennel lets dogs out by its priority 3
/// exit (down left) first, whatever the rally point says, then by the
/// priority 2 ones, nearest the rally point first.
#[test]
fn the_kennel_uses_its_highest_priority_exit_first() {
    let mut w = arena(MovementModel::OpenRA);
    let kenn = factory(&mut w, "KENN", 20, 10);
    // Up and to the right: the priority 1 exit (1, -1) would be nearest.
    w.actors[kenn].rally = Some((cell_center(30), cell_center(0)));
    w.players[0].dev.fast_build = false;
    let dog = ty(&w, "DOG");
    w.start_production(0, dog, 1);
    for _ in 0..25 * 30 {
        w.step();
        if let Some(&d) = all_of(&w, "DOG").first() {
            // The tick it came out it still stands on its exit cell.
            assert_eq!(cell(&w, d), (19, 11), "out by the priority 3 exit");
            return;
        }
    }
    panic!("no dog came out");
}

/// An open 48 x 40 map whose right half (from column 16) is sea, with a
/// naval yard (`id`) of player 0 at (24, 18) and instant builds.
fn harbour_with(model: MovementModel, id: &str) -> (World, usize) {
    let mut w = arena(model);
    for y in 0..40 {
        for x in 16..48 {
            let i = w.map.idx(x, y);
            w.map.terrain[i] = Terrain::Water;
        }
    }
    w.reset_passability();
    let yard = factory(&mut w, id, 24, 18);
    (w, yard)
}

fn harbour() -> (World, usize) {
    harbour_with(MovementModel::OpenRA, "SYRD")
}

/// Ships hold one cell each: no two ships may share one.
fn ships_stacked(w: &World) -> bool {
    let mut held = std::collections::BTreeSet::new();
    w.actors.iter().filter(|a| a.alive && a.kind == Kind::Ship && a.in_world()).any(|a| !held.insert(a.mv.to))
}

/// Ships leave the naval yard by the same rule as units leave a factory:
/// twelve gunboats built instantly come out one at a time onto the free
/// water outside the yard's corners (six park there without a rally point
/// and are asked to make way for the next ones), never two on one cell.
#[test]
fn ships_leave_the_yard_one_at_a_time() {
    let (mut w, _) = harbour();
    let pt = ty(&w, "PT");
    w.start_production(0, pt, 12);
    for tick in 0..25 * 60 {
        w.step();
        assert!(!ships_stacked(&w), "tick {tick}: two ships on one cell");
    }
    assert_eq!(all_of(&w, "PT").len(), 12, "all launched");
}

/// Enemy ships on every launch cell keep the finished gunboat in the yard.
#[test]
fn enemy_ships_on_every_launch_cell_keep_the_ship_inside() {
    let (mut w, yard) = harbour();
    let cells = w.naval_launch_cells(yard, ty(&w, "PT"));
    assert!(!cells.is_empty());
    for &(x, y, _) in &cells {
        unit(&mut w, "PT", 1, x, y);
    }
    w.players[0].dev.fast_build = false;
    let pt = ty(&w, "PT");
    w.start_production(0, pt, 1);
    for _ in 0..25 * 60 {
        w.step();
        assert!(!ships_stacked(&w));
    }
    assert_eq!(all_of(&w, "PT").iter().filter(|&&s| w.actors[s].owner == 0).count(), 0, "still inside");
    assert!(w.players[0].queues[QueueType::Ship as usize].items.first().is_some_and(|it| it.done), "finished");
}

/// The WebRA movement model: ships come out of the yard too, and twelve
/// built instantly all get out onto the water.
#[test]
fn webra_model_ships_leave_the_yard() {
    let (mut w, _) = harbour_with(MovementModel::WebRA, "SYRD");
    let pt = ty(&w, "PT");
    w.start_production(0, pt, 12);
    for _ in 0..25 * 60 {
        w.step();
        for &s in &all_of(&w, "PT") {
            assert_eq!(w.map.terrain[w.cell_index(w.actors[s].x, w.actors[s].y)], Terrain::Water, "on water");
        }
    }
    assert_eq!(all_of(&w, "PT").len(), 12, "all launched");
}

/// OpenRA ExitInfo.ProductionTypes: the sub pen lets submarines (built as
/// Submarine) out by its outer exits (-1, 2) and (3, 2), onto the water
/// right there, and its corners; other ships (the transport, built as Ship)
/// only by its corners. With the "all tech" cheat every unit is built as
/// its queue's type (ClassicProductionQueue.BuildUnit), Ship.
#[test]
fn the_sub_pen_lets_submarines_out_by_their_own_exits() {
    let (mut w, pen) = harbour_with(MovementModel::OpenRA, "SPEN");
    w.players[0].dev.all_tech = false;
    let (cx, cy) = (w.actors[pen].cx, w.actors[pen].cy);
    let corners = [(cx - 1, cy + 3), (cx + 3, cy + 3), (cx - 1, cy - 1), (cx + 3, cy - 1)];
    let cells = |w: &World, id: &str| -> Vec<(i32, i32)> { w.naval_launch_cells(pen, ty(w, id)).iter().map(|&(x, y, _)| (x, y)).collect() };
    assert_eq!(cells(&w, "SS"), vec![(cx - 1, cy + 2), (cx + 3, cy + 2), corners[2], corners[3]], "the submarine exits, in rules order");
    assert_eq!(cells(&w, "LST"), corners.to_vec(), "the ship exits");
    w.players[0].dev.all_tech = true;
    assert_eq!(cells(&w, "SS"), corners.to_vec(), "all tech: built as Ship");
}

/// OpenRA at b6fc03f: structures have no rally point to begin with
/// (RallyPointInfo.Path is empty), so a new unit or ship stays on the cell
/// it came out on; it moves only when the next one needs that cell.
#[test]
fn without_a_rally_point_new_units_stay_where_they_came_out() {
    let mut w = arena(MovementModel::OpenRA);
    factory(&mut w, "WEAP", 20, 10);
    let t = ty(&w, "1TNK");
    w.start_production(0, t, 1);
    for _ in 0..25 * 40 {
        w.step();
    }
    let tanks = all_of(&w, "1TNK");
    assert_eq!(tanks.len(), 1);
    assert_eq!(cell(&w, tanks[0]), weap_exit(20, 10), "on its exit");
    assert_eq!(w.actors[tanks[0]].activity, Activity::Idle);
    let (mut w, yard) = harbour();
    let pt = ty(&w, "PT");
    let launch = w.naval_spawn_cell(yard, pt).map(|(x, y, _)| (x, y));
    w.start_production(0, pt, 1);
    for _ in 0..25 * 40 {
        w.step();
    }
    let boats = all_of(&w, "PT");
    assert_eq!(boats.len(), 1);
    assert_eq!(Some(cell(&w, boats[0])), launch, "on its launch cell");
}

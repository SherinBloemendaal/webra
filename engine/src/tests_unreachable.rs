//! Goals that cannot be reached: islands, rivers without a bridge, a
//! crossing cut while units are on their way, refineries and targets across
//! the water. Units must end up idle or in a sensible waiting state, never
//! push against the bank for good, and the pathfinding work per tick must
//! stay bounded (flow fields computed and cells expanded are counted, never
//! timed: the counters are deterministic and hold in debug builds too).

use crate::ai_bots::BotType;
use crate::flowfield::{FlowCache, Passability, DIRS, DIR_GOAL, DIR_NONE};
use crate::map::{Map, Terrain};
use crate::math::{dist, CELL};
use crate::rules::{Kind, Rules};
use crate::world::{cell_center, Activity, AiDifficulty, GameOptions, HarvState, Order, PlayerSetup, World, NONE};

fn ty(w: &World, id: &str) -> u16 {
    w.rules.actor_index(id).unwrap() as u16
}

fn open_map(w: i32, h: i32) -> Map {
    let n = (w * h) as usize;
    Map { width: w, height: h, terrain: vec![Terrain::Clear; n], ore: vec![0; n], gems: vec![0; n], spawns: vec![(1, 1), (w - 3, h - 3)] }
}

/// An open `w` x `h` map with two passive human players and no structures.
fn arena(w: i32, h: i32) -> World {
    let mut world = World::empty(Rules::load(), open_map(w, h), 9);
    world.stress = true;
    world.add_player(world.rules.faction_index("allies").unwrap(), false, (1, 1));
    world.add_player(world.rules.faction_index("soviet").unwrap(), false, (w - 3, h - 3));
    world
}

/// Water on the given cells (ground units cannot cross), passability rebuilt.
fn flood(w: &mut World, cells: impl IntoIterator<Item = (i32, i32)>) {
    for (x, y) in cells {
        let i = w.map.idx(x, y);
        w.map.terrain[i] = Terrain::Water;
    }
    w.reset_passability();
}

/// A river down column `x`, with a ford at `ford` rows (if any).
fn river(w: &mut World, x: i32, ford: &[i32]) {
    let h = w.map.height;
    flood(w, (0..h).filter(|y| !ford.contains(y)).map(|y| (x, y)));
}

/// `n` units of `id` in a block of `cols` columns from cell (x0, y0).
fn block(w: &mut World, id: &str, owner: u8, x0: i32, y0: i32, cols: i32, n: usize) -> Vec<usize> {
    let t = ty(w, id);
    (0..n as i32).map(|k| w.spawn_unit(t, owner, cell_center(x0 + k % cols), cell_center(y0 + k / cols), 256)).collect()
}

/// The whole map known and in sight for `player` for a long time.
fn see_all(w: &mut World, player: u8) {
    w.players[player as usize].explored.iter_mut().for_each(|e| *e = 1);
    let (cx, cy) = (cell_center(w.map.width / 2), cell_center(w.map.height / 2));
    w.add_reveal(player, cx, cy, (w.map.width + w.map.height) * CELL, 25 * 3600);
    for _ in 0..30 {
        w.step();
    }
}

/// Pathfinding work per tick over a run: the most fields computed and cells
/// expanded in one tick, and the totals.
#[derive(Debug, Default)]
struct Work {
    worst_fields: u64,
    worst_expanded: u64,
    fields: u64,
    expanded: u64,
}

fn run(w: &mut World, ticks: u32, mut each: impl FnMut(&mut World, u32)) -> Work {
    let mut work = Work::default();
    for t in 0..ticks {
        each(w, t);
        let (f0, e0) = (w.flow.computed, w.flow.expanded);
        w.step();
        let (f, e) = (w.flow.computed - f0, w.flow.expanded - e0);
        work.worst_fields = work.worst_fields.max(f);
        work.worst_expanded = work.worst_expanded.max(e);
        work.fields += f;
        work.expanded += e;
    }
    work
}

fn activities(w: &World, units: &[usize]) -> Vec<Activity> {
    units.iter().map(|&i| w.actors[i].activity).collect()
}

fn all_idle(w: &World, units: &[usize]) -> bool {
    units.iter().all(|&i| w.actors[i].activity == Activity::Idle)
}

// ---- Player orders -----------------------------------------------------------------------

/// A move onto an island (or across a river without a bridge) ends on the
/// nearest cell of the near shore, for one unit and for crowds alike, with
/// one field per group and no work once everyone stands still.
#[test]
fn a_move_across_water_ends_on_the_near_shore() {
    for &n in &[1usize, 50, 200] {
        let mut w = arena(96, 64);
        river(&mut w, 48, &[]);
        let units = block(&mut w, "1TNK", 0, 6, 6, 20, n);
        w.order_move(&units, cell_center(90), cell_center(30), false);
        let work = run(&mut w, 25 * 60, |_, _| {});
        assert!(all_idle(&w, &units), "{n} units: {:?}", activities(&w, &units));
        for &i in &units {
            assert!(w.actors[i].x < 48 * CELL, "{n} units: never on the water");
        }
        assert!(work.fields <= 3, "{n} units: {work:?}");
        let after = run(&mut w, 100, |_, _| {});
        assert_eq!(after.fields, 0, "{n} units standing still cost nothing: {after:?}");
    }
}

/// Attacking a target across the water that no reachable cell is in range
/// of ends at once (OpenRA finds no path to the cells within range): no
/// unit drives to the bank and pushes there for good, and no field is
/// computed for the chase.
#[test]
fn an_attack_on_a_target_out_of_reach_is_given_up_at_once() {
    let mut w = arena(96, 64);
    river(&mut w, 48, &[]);
    let units = block(&mut w, "1TNK", 0, 6, 6, 20, 200);
    let t = w.spawn_unit(ty(&w, "3TNK"), 1, cell_center(70), cell_center(30), 0);
    see_all(&mut w, 0);
    w.order_attack(&units, t, false);
    let work = run(&mut w, 5, |_, _| {});
    assert!(all_idle(&w, &units), "{:?}", activities(&w, &units));
    assert_eq!(work.fields, 0, "{work:?}");
    assert!(w.actors[units[0]].x < 10 * CELL, "nobody drove off");
}

/// A target across the water within weapon range of the far bank is
/// attacked from there: the give-up is about reach, not about water.
#[test]
fn a_target_across_the_water_but_in_range_is_shot_from_the_bank() {
    let mut w = arena(64, 48);
    river(&mut w, 32, &[]);
    let units = block(&mut w, "1TNK", 0, 20, 20, 4, 8);
    // 1TNK range is 4.75 cells: three cells past the water is in reach.
    let t = w.spawn_unit(ty(&w, "4TNK"), 1, cell_center(35), cell_center(21), 0);
    w.actors[t].reload = [1_000_000; crate::world::MAX_WEAPONS];
    see_all(&mut w, 0);
    let hp = w.actors[t].hp;
    w.order_attack(&units, t, false);
    run(&mut w, 25 * 30, |_, _| {});
    assert!(w.actors[t].hp < hp, "hit from the bank: {:?}", activities(&w, &units));
}

/// A target that paces along the far bank keeps nobody busy: every new
/// position is out of reach again, so the attack ends and stays ended.
#[test]
fn a_moving_target_out_of_reach_does_not_keep_chasers_busy() {
    let mut w = arena(96, 64);
    river(&mut w, 48, &[]);
    let units = block(&mut w, "1TNK", 0, 6, 6, 20, 200);
    let t = w.spawn_unit(ty(&w, "3TNK"), 1, cell_center(60), cell_center(20), 0);
    w.actors[t].reload = [1_000_000; crate::world::MAX_WEAPONS];
    see_all(&mut w, 0);
    w.order_attack(&units, t, false);
    let work = run(&mut w, 25 * 40, |w, k| {
        if k % 10 == 0 {
            w.order_move(&[t], cell_center(60), cell_center(20 + (k as i32 / 10) % 30), false);
        }
    });
    assert!(all_idle(&w, &units), "{:?}", activities(&w, &units));
    // Only the target's own moves computed fields.
    assert!(work.worst_fields <= 1, "{work:?}");
}

/// Shelled from across the water by artillery it cannot reach, a unit does
/// not set off after the attacker (return fire skips what it can never get
/// in range of); one it can reach it goes for.
#[test]
fn return_fire_skips_attackers_out_of_reach() {
    let mut w = arena(64, 48);
    river(&mut w, 32, &[]);
    let tank = w.spawn_unit(ty(&w, "1TNK"), 0, cell_center(20), cell_center(20), 0);
    let arty = w.spawn_unit(ty(&w, "ARTY"), 1, cell_center(40), cell_center(20), 512);
    see_all(&mut w, 0);
    see_all(&mut w, 1);
    w.order_attack(&[arty], tank, false);
    let work = run(&mut w, 25 * 20, |w, _| {
        assert_ne!(w.actors[tank].activity, Activity::Attack, "no chase of the artillery across the water");
    });
    assert_eq!(w.cell_of(w.actors[tank].x, w.actors[tank].y), (20, 20), "stays put");
    // Only the artillery's own approach computed a field.
    assert!(work.fields <= 1, "{work:?}");
    // The same artillery on the tank's side of the water is answered.
    let arty = w.spawn_unit(ty(&w, "ARTY"), 1, cell_center(8), cell_center(20), 512);
    w.order_attack(&[arty], tank, false);
    let mut answered = false;
    for _ in 0..25 * 20 {
        w.step();
        if w.actors[tank].activity == Activity::Attack && w.resolve(w.actors[tank].target) == Some(arty) {
            answered = true;
            break;
        }
    }
    assert!(answered, "the tank goes for the artillery it can reach");
}

/// Force-fire at ground across the water and out of range ends too.
#[test]
fn attack_ground_at_an_unreachable_point_ends() {
    let mut w = arena(96, 64);
    river(&mut w, 48, &[]);
    let units = block(&mut w, "1TNK", 0, 6, 6, 10, 50);
    let ids: Vec<u32> = units.iter().map(|&u| w.make_ref(u)).collect();
    w.queue_order(Order::AttackGround { player: 0, ids, x: cell_center(80), y: cell_center(30) });
    let work = run(&mut w, 25, |_, _| {});
    assert!(all_idle(&w, &units), "{:?}", activities(&w, &units));
    assert_eq!(work.fields, 0, "{work:?}");
}

/// Artillery force-firing across the water fires once in range of the
/// point: the ground attack walks up to the bank first.
#[test]
fn attack_ground_across_the_water_in_range_fires() {
    let mut w = arena(64, 48);
    river(&mut w, 32, &[]);
    let units = block(&mut w, "ARTY", 0, 10, 20, 2, 2);
    let ids: Vec<u32> = units.iter().map(|&u| w.make_ref(u)).collect();
    w.queue_order(Order::AttackGround { player: 0, ids, x: cell_center(36), y: cell_center(21) });
    let mut fired = false;
    for _ in 0..25 * 40 {
        w.step();
        if !w.projectiles.is_empty() {
            fired = true;
            break;
        }
    }
    assert!(fired, "{:?}", activities(&w, &units));
}

/// Guards of a unit across the water wait at the bank, cheaply, and go on
/// guarding (OpenRA's Guard keeps trying as well).
#[test]
fn guards_wait_at_the_bank_for_a_unit_across_the_water() {
    let mut w = arena(96, 64);
    river(&mut w, 48, &[]);
    let units = block(&mut w, "1TNK", 0, 6, 6, 10, 100);
    let g = w.spawn_unit(ty(&w, "JEEP"), 0, cell_center(60), cell_center(20), 0);
    let ids: Vec<u32> = units.iter().map(|&u| w.make_ref(u)).collect();
    let gr = w.make_ref(g);
    w.queue_order(Order::Guard { player: 0, ids, target: gr });
    let work = run(&mut w, 25 * 40, |w, k| {
        if k % 10 == 0 {
            w.order_move(&[g], cell_center(60), cell_center(20 + (k as i32 / 10) % 30), false);
        }
    });
    assert!(units.iter().all(|&i| w.actors[i].activity == Activity::Guard), "{:?}", activities(&w, &units));
    assert!(work.worst_fields <= 3, "{work:?}");
    // They follow along the bank, never onto the water.
    for &i in &units {
        let x = w.actors[i].x;
        assert!(x > 36 * CELL && x < 48 * CELL, "at the bank: cell {:?}", w.cell_of(x, w.actors[i].y));
    }
}

/// A capture order on a structure across the water ends with the engineer
/// idle at the bank (OpenRA MoveToTarget gives up).
#[test]
fn an_engineer_sent_across_the_water_gives_up() {
    let mut w = arena(64, 48);
    river(&mut w, 32, &[]);
    let e = w.spawn_unit(ty(&w, "E6"), 0, cell_center(20), cell_center(20), 0);
    let b = w.spawn_building(ty(&w, "POWR"), 1, 40, 20).unwrap();
    see_all(&mut w, 0);
    assert!(w.order_enter(e, b, crate::infantry::EnterKind::Capture));
    run(&mut w, 25 * 40, |_, _| {});
    assert_eq!(w.actors[e].activity, Activity::Idle);
    assert!(w.actors[e].x < 32 * CELL);
    assert_eq!(w.actors[b].owner, 1);
}

/// Infantry sent to board a transport ship out at sea walk to the shore and
/// stop there; once the ship comes to the beach they get in.
#[test]
fn boarding_a_ship_out_at_sea_waits_at_the_shore() {
    let mut w = arena(64, 48);
    flood(&mut w, (0..48).flat_map(|y| (24..64).map(move |x| (x, y))));
    // A beach column the landing craft can run up on.
    for y in 0..48 {
        let i = w.map.idx(24, y);
        w.map.terrain[i] = Terrain::Beach;
    }
    w.reset_passability();
    let lst = w.spawn_unit(ty(&w, "LST"), 0, cell_center(50), cell_center(20), 0);
    let units = block(&mut w, "E1", 0, 10, 18, 3, 6);
    w.order_load(&units, lst);
    run(&mut w, 25 * 40, |_, _| {});
    assert!(all_idle(&w, &units), "{:?}", activities(&w, &units));
    assert!(units.iter().all(|&i| w.actors[i].x < 25 * CELL), "on the shore");
    w.order_move(&[lst], cell_center(24), cell_center(19), false);
    run(&mut w, 25 * 30, |_, _| {});
    w.order_load(&units, lst);
    run(&mut w, 25 * 30, |_, _| {});
    assert!(w.passengers(lst).len() >= 5, "{} boarded", w.passengers(lst).len());
}

/// A transport unloading next to a one-cell islet puts its passengers on
/// the mainland, never on the islet they could not leave.
#[test]
fn passengers_are_unloaded_onto_the_mainland_not_an_islet() {
    let mut w = arena(64, 48);
    // Sea east of column 24 with a beach column; one islet cell at (26, 20) right next to the ship.
    flood(&mut w, (0..48).flat_map(|y| (24..64).map(move |x| (x, y))).filter(|&(x, y)| (x, y) != (26, 20)));
    for y in 0..48 {
        let i = w.map.idx(24, y);
        w.map.terrain[i] = Terrain::Beach;
    }
    w.reset_passability();
    assert_eq!(w.pass.area_size(w.map.idx(26, 20)), 1, "an islet");
    let lst = w.spawn_unit(ty(&w, "LST"), 0, cell_center(25), cell_center(20), 0);
    let men = block(&mut w, "E1", 0, 10, 18, 3, 5);
    for &m in &men {
        assert!(w.load_passenger(lst, m));
    }
    w.order_unload(lst);
    run(&mut w, 25 * 20, |_, _| {});
    assert!(w.passengers(lst).is_empty(), "all out");
    for &m in &men {
        let (cx, cy) = w.cell_of(w.actors[m].x, w.actors[m].y);
        assert!(cx <= 24, "on the mainland, not the islet: ({cx}, {cy})");
    }
}

/// Several damaged vehicles sent to one service depot all get repaired in
/// turn: the one on the pad is not pushed off, the others wait around it.
#[test]
fn several_vehicles_sent_to_one_depot_all_get_repaired() {
    let mut w = arena(64, 48);
    w.players[0].cash = 100_000;
    let fix = w.spawn_building(ty(&w, "FIX"), 0, 30, 20).unwrap();
    let tanks = block(&mut w, "1TNK", 0, 20, 20, 3, 6);
    let max = w.rules.actors[ty(&w, "1TNK") as usize].hp;
    for &t in &tanks {
        w.actors[t].hp = max / 4;
    }
    let ids: Vec<u32> = tanks.iter().map(|&t| w.make_ref(t)).collect();
    let (fx, fy) = (w.actors[fix].x, w.actors[fix].y);
    w.queue_order(Order::Smart { player: 0, ids, x: fx, y: fy });
    let mut done_at = None;
    for k in 0..25 * 180 {
        w.step();
        if tanks.iter().all(|&t| w.actors[t].hp == max) {
            done_at = Some(k);
            break;
        }
    }
    let hps: Vec<i32> = tanks.iter().map(|&t| w.actors[t].hp).collect();
    assert!(done_at.is_some(), "all six repaired within three minutes: {hps:?} {:?}", activities(&w, &tanks));
}

/// A rally point across the water: produced units drive to the bank and idle.
#[test]
fn a_rally_point_across_the_water_sends_units_to_the_bank() {
    let mut w = arena(64, 48);
    river(&mut w, 32, &[]);
    let b = w.spawn_building(ty(&w, "WEAP"), 0, 10, 10).unwrap();
    w.actors[b].rally = Some((cell_center(50), cell_center(30)));
    w.players[0].cash = 100_000;
    w.refresh_tokens();
    let tank = w.produce_at(b, 0, ty(&w, "1TNK")).unwrap();
    run(&mut w, 25 * 40, |_, _| {});
    assert_eq!(w.actors[tank].activity, Activity::Idle);
    let (x, _) = (w.actors[tank].x, w.actors[tank].y);
    assert!(x > 25 * CELL && x < 32 * CELL, "at the bank: cell {:?}", w.cell_of(w.actors[tank].x, w.actors[tank].y));
}

/// A naval yard on a shore with a pond on its other side launches ships
/// onto the sea (the largest water, or the water its rally point is in),
/// never into the pond they could not leave.
#[test]
fn naval_yards_launch_ships_onto_the_open_sea_not_into_a_pond() {
    let mut w = arena(64, 48);
    // Sea east of column 30; a 3 x 3 pond west of the yard at (27, 10).
    flood(&mut w, (0..48).flat_map(|y| (30..64).map(move |x| (x, y))).chain((9..12).flat_map(|y| (24..27).map(move |x| (x, y)))));
    w.spawn_building(ty(&w, "FACT"), 0, 4, 4);
    w.spawn_building(ty(&w, "POWR"), 0, 10, 4);
    let syrd = w.spawn_building(ty(&w, "SYRD"), 0, 27, 9).unwrap();
    w.players[0].cash = 100_000;
    w.refresh_tokens();
    w.update_power();
    let pond = w.pass_water.component[w.map.idx(25, 10)];
    assert_ne!(pond, w.pass_water.component[w.map.idx(40, 10)]);
    let pt = ty(&w, "PT");
    for _ in 0..4 {
        let boat = w.produce_at(syrd, 0, pt).expect("launched");
        let ci = w.cell_index(w.actors[boat].x, w.actors[boat].y);
        assert_ne!(w.pass_water.component[ci], pond, "launched into the pond at {:?}", w.cell_of(w.actors[boat].x, w.actors[boat].y));
        w.step();
    }
    // A rally point in the pond is honoured (the player asked for it).
    w.actors[syrd].rally = Some((cell_center(25), cell_center(10)));
    let boat = w.produce_at(syrd, 0, pt).expect("launched");
    let ci = w.cell_index(w.actors[boat].x, w.actors[boat].y);
    assert_eq!(w.pass_water.component[ci], pond);
}

// ---- Harvesters ---------------------------------------------------------------------------

/// A full ore truck delivers to a refinery it can drive to, not to the
/// nearest one across the river (OpenRA's harvester searches paths to the
/// refineries).
#[test]
fn a_full_harvester_delivers_to_a_reachable_refinery() {
    let mut w = arena(64, 48);
    river(&mut w, 32, &[]);
    let proc_ = ty(&w, "PROC");
    w.spawn_building(proc_, 0, 40, 20).unwrap();
    let far = w.spawn_building(proc_, 0, 4, 40).unwrap();
    let h = w.spawn_unit(ty(&w, "HARV"), 0, cell_center(28), cell_center(20), 0);
    w.actors[h].bales = 20;
    w.actors[h].activity = Activity::Harvest;
    w.actors[h].harv = HarvState::ToDock;
    let funds = w.players[0].funds();
    run(&mut w, 25 * 60, |_, _| {});
    assert_eq!(w.actors[h].bales, 0, "unloaded: {:?}", w.actors[h].harv);
    assert!(w.players[0].funds() > funds);
    assert_eq!(w.resolve(w.actors[h].refinery), Some(far));
}

/// Without any reachable refinery a full truck waits and looks again now
/// and then, keeping its load; it never drives at the water. Once a
/// refinery goes up on its side it delivers.
#[test]
fn a_harvester_without_a_reachable_refinery_waits_and_retries() {
    let mut w = arena(64, 48);
    river(&mut w, 32, &[]);
    let proc_ = ty(&w, "PROC");
    w.spawn_building(proc_, 0, 40, 20).unwrap();
    let h = w.spawn_unit(ty(&w, "HARV"), 0, cell_center(20), cell_center(20), 0);
    w.actors[h].bales = 20;
    w.actors[h].activity = Activity::Harvest;
    w.actors[h].harv = HarvState::ToDock;
    let work = run(&mut w, 25 * 30, |_, _| {});
    assert_eq!(w.actors[h].bales, 20);
    assert_eq!(w.actors[h].activity, Activity::Harvest);
    assert!(matches!(w.actors[h].harv, HarvState::Wait | HarvState::Search | HarvState::ToDock), "{:?}", w.actors[h].harv);
    assert_eq!(w.cell_of(w.actors[h].x, w.actors[h].y), (20, 20), "stays put");
    assert_eq!(work.fields, 0, "no path searched for a dock that cannot be reached: {work:?}");
    w.spawn_building(proc_, 0, 8, 30).unwrap();
    run(&mut w, 25 * 60, |_, _| {});
    assert_eq!(w.actors[h].bales, 0, "delivered once a refinery stood on its side: {:?}", w.actors[h].harv);
}

/// A truck picks the refinery with the shortest drive, not the one nearest
/// as the crow flies: a long wall between them counts (OpenRA
/// Harvester.ClosestProc).
#[test]
fn a_harvester_picks_the_refinery_with_the_shortest_drive() {
    let mut w = arena(64, 48);
    // A wall from the top edge down to row 40, between the truck and the near refinery.
    for y in 0..40 {
        let i = w.map.idx(30, y);
        w.map.terrain[i] = Terrain::Rock;
    }
    w.reset_passability();
    let proc_ = ty(&w, "PROC");
    let behind_wall = w.spawn_building(proc_, 0, 34, 8).unwrap();
    let around = w.spawn_building(proc_, 0, 8, 24).unwrap();
    for i in 0..w.actors.len() {
        if w.actors[i].alive && w.is_harvester(i) {
            w.remove(i);
        }
    }
    let h = w.spawn_unit(ty(&w, "HARV"), 0, cell_center(26), cell_center(10), 0);
    w.actors[h].bales = 20;
    w.actors[h].activity = Activity::Harvest;
    w.actors[h].harv = HarvState::ToDock;
    run(&mut w, 2, |_, _| {});
    assert_eq!(w.resolve(w.actors[h].refinery), Some(around), "not {behind_wall} behind the wall");
}

/// A bot's truck under fire runs to a refinery it can reach, never to a
/// nearer one across the water.
#[test]
fn a_bots_truck_under_fire_runs_to_a_reachable_refinery() {
    let mut map = open_map(64, 48);
    for y in 0..48 {
        let i = map.idx(32, y);
        map.terrain[i] = Terrain::Water;
    }
    map.spawns = vec![(4, 36), (50, 40)];
    let players = [PlayerSetup::new("allies", Some(AiDifficulty::Normal)), PlayerSetup::new("soviet", None)];
    let mut w = World::on_map(3, map, &players, GameOptions::default());
    w.ai[0].passive = true;
    let proc_ = ty(&w, "PROC");
    let across = w.spawn_building(proc_, 0, 36, 6).unwrap();
    let home = w.spawn_building(proc_, 0, 6, 20).unwrap();
    for i in 0..w.actors.len() {
        if w.actors[i].alive && w.is_harvester(i) {
            w.remove(i);
        }
    }
    let truck = w.spawn_unit(ty(&w, "HARV"), 0, cell_center(26), cell_center(8), 0);
    let foe = w.spawn_unit(ty(&w, "1TNK"), 1, cell_center(22), cell_center(8), 512);
    run(&mut w, 25 * 3, |_, _| {});
    w.order_attack(&[foe], truck, false);
    let mut home_bound = false;
    for _ in 0..25 * 10 {
        w.step();
        if !w.actors[truck].alive {
            break;
        }
        let a = &w.actors[truck];
        if a.activity == Activity::Harvest && matches!(a.harv, HarvState::ToDock | HarvState::Unloading) {
            let r = w.resolve(a.refinery);
            assert_ne!(r, Some(across), "sent to the refinery across the water");
            home_bound = r == Some(home);
            if home_bound {
                break;
            }
        }
    }
    assert!(home_bound, "the truck under fire heads for its reachable refinery");
}

/// A truck goes for the ore with the shortest drive: a cell nearer as the
/// crow flies but behind a wall loses to one a little farther off (OpenRA
/// FindAndDeliverResources.ClosestHarvestablePos searches paths).
#[test]
fn a_harvester_mines_the_ore_with_the_shortest_drive() {
    let mut w = arena(64, 48);
    // A wall from the top edge down to row 30, two cells east of the truck.
    for y in 0..30 {
        let i = w.map.idx(22, y);
        w.map.terrain[i] = Terrain::Rock;
    }
    w.reset_passability();
    let behind_wall = w.map.idx(24, 20);
    let open = w.map.idx(14, 20);
    w.map.ore[behind_wall] = 5;
    w.map.ore[open] = 5;
    let h = w.spawn_unit(ty(&w, "HARV"), 0, cell_center(20), cell_center(20), 0);
    w.actors[h].activity = Activity::Harvest;
    w.actors[h].harv = HarvState::Search;
    run(&mut w, 2, |_, _| {});
    assert_eq!(w.actors[h].harv_cell, open as u32, "six cells west, not four cells east and twenty around the wall");
}

/// A truck whose refinery dock gets walled in lets go of it and delivers
/// elsewhere.
#[test]
fn a_harvester_lets_go_of_a_refinery_whose_dock_is_cut_off() {
    let mut w = arena(64, 48);
    river(&mut w, 32, &[20]);
    let proc_ = ty(&w, "PROC");
    let near = w.spawn_building(proc_, 0, 40, 18).unwrap();
    let other = w.spawn_building(proc_, 0, 4, 42).unwrap();
    // The refineries' free trucks stay out of the docks' way.
    for i in 0..w.actors.len() {
        if w.actors[i].alive && w.is_harvester(i) {
            w.remove(i);
        }
    }
    let h = w.spawn_unit(ty(&w, "HARV"), 0, cell_center(20), cell_center(20), 0);
    w.actors[h].bales = 20;
    w.actors[h].activity = Activity::Harvest;
    w.actors[h].harv = HarvState::ToDock;
    run(&mut w, 25 * 4, |_, _| {});
    assert_eq!(w.resolve(w.actors[h].refinery), Some(near));
    // The ford closes while the truck is on its way.
    let ford = w.map.idx(32, 20);
    w.map.terrain[ford] = Terrain::Water;
    w.pass.set_blocked(ford, true);
    w.pass.refresh(&w.map);
    run(&mut w, 25 * 150, |_, _| {});
    assert_eq!(w.actors[h].bales, 0, "delivered: {:?} at {:?}", w.actors[h].harv, w.cell_of(w.actors[h].x, w.actors[h].y));
    assert_eq!(w.resolve(w.actors[h].refinery), Some(other));
}

// ---- Passability changes on the way ------------------------------------------------------

/// The only ford closes while a crowd crosses: the units on the near side
/// stop at the bank, after one search for the group (not one per unit),
/// and when the ford opens again a new order takes them across.
#[test]
fn a_crossing_cut_mid_route_stops_the_group_with_one_search() {
    let mut w = arena(96, 64);
    river(&mut w, 48, &[32]);
    let units = block(&mut w, "1TNK", 0, 6, 22, 20, 200);
    w.order_move(&units, cell_center(90), cell_center(32), false);
    let ford = w.map.idx(48, 32);
    let mut cut = Work::default();
    let work = run(&mut w, 25 * 60, |w, k| {
        if k == 25 * 12 {
            w.map.terrain[ford] = Terrain::Water;
            w.pass.set_blocked(ford, true);
            w.pass.refresh(&w.map);
            w.retarget_scans = 0;
        }
        if k == 25 * 12 + 30 {
            cut.fields = w.flow.computed;
        }
    });
    let _ = cut;
    assert!(all_idle(&w, &units), "{:?}", activities(&w, &units));
    let crossed = units.iter().filter(|&&i| w.actors[i].x > 48 * CELL).count();
    assert!(crossed < 60, "the ford shut early: {crossed} crossed");
    assert!(w.retarget_scans <= 2, "one nearest-cell search per side: {}", w.retarget_scans);
    assert!(work.worst_fields <= 8, "{work:?}");
    // The ford opens again: the next order crosses (a stale field is not trusted
    // where a unit has no direction).
    w.map.terrain[ford] = Terrain::Clear;
    w.pass.set_blocked(ford, false);
    w.pass.refresh(&w.map);
    let near: Vec<usize> = units.iter().copied().filter(|&i| w.actors[i].x < 48 * CELL).collect();
    w.order_move(&near, cell_center(90), cell_center(32), false);
    run(&mut w, 25 * 120, |_, _| {});
    let crossed = near.iter().filter(|&&i| w.actors[i].x > 48 * CELL).count();
    assert!(crossed * 10 >= near.len() * 9, "{crossed} of {} crossed after the repair", near.len());
}

/// A wreck in the only gap stops a group short of its destination; when
/// the wreck is gone the units still on their way go on to where they were
/// sent, instead of stopping for good where the blocker made them stop.
#[test]
fn a_move_cut_by_a_wreck_goes_on_once_the_wreck_is_gone() {
    let mut w = arena(96, 64);
    river(&mut w, 48, &[32]);
    let units = block(&mut w, "1TNK", 0, 4, 22, 10, 60);
    let (gx, gy) = (cell_center(90), cell_center(32));
    w.order_move(&units, gx, gy, false);
    // A tank dies in the ford: its husk blocks the gap.
    let victim = w.spawn_unit(ty(&w, "2TNK"), 1, cell_center(48), cell_center(32), 0);
    run(&mut w, 25 * 2, |_, _| {});
    w.kill(victim);
    w.step();
    let husk = (0..w.actors.len()).find(|&i| w.actors[i].alive && w.actors[i].kind == Kind::Husk).expect("a husk");
    assert!(w.pass.blocked[w.map.idx(48, 32)], "the husk blocks the ford");
    run(&mut w, 25 * 12, |_, _| {});
    assert!(units.iter().all(|&i| w.actors[i].x < 48 * CELL), "nobody crossed");
    let retargeted = units.iter().filter(|&&i| w.actors[i].retargeted).count();
    assert!(retargeted > 0, "the group settled for the near bank");
    // The wreck is cleared while the group is still driving.
    w.kill(husk);
    w.step();
    assert!(!w.pass.blocked[w.map.idx(48, 32)]);
    run(&mut w, 25 * 100, |_, _| {});
    let crossed = units.iter().filter(|&&i| w.actors[i].x > 48 * CELL).count();
    assert!(crossed * 10 >= units.len() * 9, "{crossed} of {} crossed once the wreck was gone", units.len());
    assert!(all_idle(&w, &units), "{:?}", activities(&w, &units));
    assert!(units.iter().all(|&i| !w.actors[i].retargeted));
}

/// Structures going up away from the routes do not recompute the fields of
/// forty groups on the move: a field is only refreshed where a unit runs
/// into a change.
#[test]
fn structures_elsewhere_do_not_recompute_fields_on_the_move() {
    let mut w = arena(128, 96);
    let units = block(&mut w, "1TNK", 0, 4, 4, 20, 200);
    let mut goals = Vec::new();
    for g in 0..40 {
        let grp: Vec<usize> = units[g * 5..g * 5 + 5].to_vec();
        let goal = (cell_center(70 + (g as i32 % 8) * 6), cell_center(10 + (g as i32 / 8) * 15));
        goals.push(goal);
        w.order_move(&grp, goal.0, goal.1, false);
    }
    let powr = ty(&w, "POWR");
    let work = run(&mut w, 25 * 70, |w, k| {
        if k > 0 && k % 10 == 0 {
            let n = (k / 10) as i32;
            w.spawn_building(powr, 1, 30 + (n % 10) * 3, 80 + (n / 10) % 4 * 3);
        }
    });
    assert!(all_idle(&w, &units), "{:?}", activities(&w, &units));
    for (g, &(gx, gy)) in goals.iter().enumerate() {
        for &i in &units[g * 5..g * 5 + 5] {
            assert!(dist(w.actors[i].x, w.actors[i].y, gx, gy) <= 6 * CELL, "group {g} arrived");
        }
    }
    // A structure inside the area a field covers recomputes that field (the
    // field stays exactly what a fresh search gives, so the cache never
    // decides a game); one outside does not. Forty groups all over the map
    // cover most of it, so most placements cost up to a field per group,
    // partial ones: on average under a map's worth of cells per tick.
    assert!(work.worst_fields <= 40, "{work:?}");
    assert!(work.expanded / (25 * 70) <= w.map.cells() as u64, "{work:?}");
}

/// A wall of structures goes up across a group's route, with one gap: the
/// field is refreshed where the units meet it and they all get through.
#[test]
fn a_structure_across_the_route_refreshes_the_field_where_units_meet_it() {
    let mut w = arena(96, 64);
    let units = block(&mut w, "1TNK", 0, 6, 26, 10, 40);
    w.order_move(&units, cell_center(90), cell_center(30), false);
    let powr = ty(&w, "POWR");
    let work = run(&mut w, 25 * 90, |w, k| {
        if k == 25 * 6 {
            // Power plants are 2 x 2: a wall from row 0 to 63 at column 48, open at rows 30 and 31.
            for y in (0..64).step_by(2) {
                if y != 30 {
                    w.spawn_building(powr, 1, 48, y);
                }
            }
        }
    });
    assert!(all_idle(&w, &units), "{:?}", activities(&w, &units));
    for &i in &units {
        assert!(w.actors[i].x > 60 * CELL, "got through the gap: cell {:?}", w.cell_of(w.actors[i].x, w.actors[i].y));
    }
    assert!(work.worst_fields <= 2, "{work:?}");
}

/// Chasers of targets far away plan again only when a target moved by an
/// eighth of the distance, not on its every step.
#[test]
fn chasers_of_far_moving_targets_replan_rarely() {
    let mut w = arena(128, 64);
    let units = block(&mut w, "1TNK", 0, 4, 4, 10, 50);
    let targets = block(&mut w, "JEEP", 1, 100, 10, 10, 50);
    for &t in &targets {
        w.actors[t].reload = [1_000_000; crate::world::MAX_WEAPONS];
    }
    see_all(&mut w, 0);
    for (k, &u) in units.iter().enumerate() {
        w.order_attack(&[u], targets[k], false);
    }
    w.step();
    let first = w.flow.computed;
    // The targets step one cell to the right every 10 ticks, 20 cells in all.
    let work = run(&mut w, 200, |w, k| {
        if k % 10 == 0 {
            for (j, &t) in targets.iter().enumerate() {
                let x = 101 + (k as i32 / 10);
                w.order_move(&[t], cell_center(x), cell_center(10 + j as i32 / 10), false);
            }
        }
    });
    let _ = first;
    // Twenty steps each at ninety cells' distance: a new field about every
    // eleven cells, so two or three per chaser, never one per step.
    assert!(work.fields <= 50 * 4, "{work:?}");
    assert!(work.worst_fields <= 50, "{work:?}");
}

/// A crowd on an island with nothing in reach: the units idle, every tick
/// costs nothing, and a target that comes into sight across the water
/// within range is engaged.
#[test]
fn units_on_an_island_idle_cheaply_and_shoot_what_comes_in_range() {
    let mut w = arena(64, 48);
    // An island of 6 x 6 cells at (20..26, 20..26).
    flood(&mut w, (0..48).flat_map(|y| (0..64).map(move |x| (x, y))).filter(|&(x, y)| !((20..26).contains(&x) && (20..26).contains(&y))));
    let units = block(&mut w, "1TNK", 0, 20, 20, 6, 20);
    let boat = w.spawn_unit(ty(&w, "PT"), 1, cell_center(40), cell_center(23), 0);
    w.actors[boat].reload = [1_000_000; crate::world::MAX_WEAPONS];
    see_all(&mut w, 0);
    w.order_move(&units, cell_center(50), cell_center(23), true);
    let work = run(&mut w, 25 * 20, |_, _| {});
    assert!(all_idle(&w, &units), "{:?}", activities(&w, &units));
    assert!(work.fields <= 2, "{work:?}");
    let hp = w.actors[boat].hp;
    w.order_move(&[boat], cell_center(28), cell_center(23), false);
    run(&mut w, 25 * 20, |_, _| {});
    assert!(w.actors[boat].hp < hp, "shot once in range");
}

/// Everything above holds tick for tick on every client: the same orders
/// give the same game, and a copy of the world (replay seeking, a rejoin)
/// goes on exactly like the original even when it starts from an empty
/// flow field cache mid-game: fields are a pure function of the map, so
/// what the cache holds (partial, kept over a change) never decides a game.
#[test]
fn unreachable_goals_and_partial_fields_are_deterministic() {
    let play = |copy_at: Option<u32>| {
        let mut w = arena(96, 64);
        river(&mut w, 48, &[32]);
        let a = block(&mut w, "1TNK", 0, 6, 22, 20, 100);
        let b = block(&mut w, "E1", 0, 6, 40, 20, 100);
        let h = w.spawn_unit(ty(&w, "HARV"), 0, cell_center(20), cell_center(10), 0);
        for x in 24..44 {
            for y in 4..16 {
                let i = w.map.idx(x, y);
                w.map.ore[i] = 6;
            }
        }
        w.spawn_building(ty(&w, "PROC"), 0, 8, 4).unwrap();
        let t = w.spawn_unit(ty(&w, "3TNK"), 1, cell_center(60), cell_center(20), 0);
        see_all(&mut w, 0);
        w.order_move(&a, cell_center(90), cell_center(32), false);
        w.order_attack(&b, t, false);
        w.actors[h].activity = Activity::Harvest;
        w.actors[h].harv = HarvState::Search;
        let ford = w.map.idx(48, 32);
        let powr = ty(&w, "POWR");
        let mutate = |w: &mut World, k: u32| {
            if k == 25 * 8 {
                w.map.terrain[ford] = Terrain::Water;
                w.pass.set_blocked(ford, true);
                w.pass.refresh(&w.map);
            }
            if k == 25 * 10 {
                w.spawn_building(powr, 1, 30, 10);
            }
            if k == 25 * 14 {
                w.map.terrain[ford] = Terrain::Clear;
                w.pass.set_blocked(ford, false);
                w.pass.refresh(&w.map);
            }
        };
        let mut copy: Option<World> = None;
        let mut hashes = Vec::new();
        for k in 0..25 * 40 {
            mutate(&mut w, k);
            if copy_at == Some(k) {
                let mut c = w.clone();
                c.flow = FlowCache::new();
                copy = Some(c);
            }
            if let Some(c) = copy.as_mut() {
                if copy_at != Some(k) {
                    mutate(c, k);
                }
                c.step();
            }
            w.step();
            if k % 25 == 0 {
                hashes.push(w.state_hash());
                if let Some(c) = copy.as_ref() {
                    assert_eq!(c.state_hash(), w.state_hash(), "the copy follows the original at tick {k}");
                }
            }
        }
        hashes
    };
    assert_eq!(play(None), play(Some(25 * 9)));
    assert_eq!(play(None), play(Some(25 * 12)));
}

// ---- Flow fields (flowfield.rs) -------------------------------------------------------------

fn tank_locos() -> Vec<crate::rules::Locomotor> {
    vec![crate::rules::Locomotor {
        name: "t".into(),
        domain: crate::rules::Domain::Ground,
        speeds: vec![100, 50, 88, 0, 125, 125, 50],
        crushes_infantry: true,
        crushes: vec!["infantry".into()],
    }]
}

/// A field asked for from a cell covers that cell and the way to the goal,
/// stops a margin beyond it, and grows (to twice its bound at least) when a
/// cell outside is asked for.
#[test]
fn fields_cover_what_units_ask_for_and_extend_on_demand() {
    let map = open_map(120, 20);
    let pass = Passability::new(&map);
    let locos = tank_locos();
    let mut cache = FlowCache::new();
    let goal = map.idx(5, 10) as u32;
    let near = map.idx(25, 10);
    let f = cache.field_at(&map, &pass, &locos, (goal, 0), None, near);
    assert!(!f.complete, "a 120 cell map is not searched to the end for a cell 20 away");
    assert_ne!(f.dirs[near], DIR_NONE);
    assert_eq!(f.dirs[map.idx(100, 10)], DIR_NONE, "far cells are not covered yet");
    let bound = f.bound;
    // Walk to the goal: every cell on the way is covered.
    let (mut x, mut y) = (25, 10);
    for _ in 0..200 {
        let d = f.dirs[map.idx(x, y)];
        if d == DIR_GOAL {
            break;
        }
        assert_ne!(d, DIR_NONE, "covered at {x},{y}");
        x += DIRS[d as usize].0;
        y += DIRS[d as usize].1;
    }
    assert_eq!((x, y), (5, 10));
    let expanded = cache.expanded;
    assert!(expanded < map.cells() as u64 / 2, "a partial search: {expanded} of {} cells", map.cells());
    let far = map.idx(100, 10);
    let f = cache.field_at(&map, &pass, &locos, (goal, 0), None, far);
    assert_ne!(f.dirs[far], DIR_NONE, "extended to the far cell");
    assert!(f.bound >= bound * 2, "grows by doubling: {} from {bound}", f.bound);
    assert_eq!(cache.computed, 2);
    // A cell on the other side of a wall nobody can reach: the field is complete there.
    let mut map2 = open_map(40, 20);
    for y in 0..20 {
        let i = map2.idx(20, y);
        map2.terrain[i] = Terrain::Water;
    }
    let pass2 = Passability::new(&map2);
    let mut cache2 = FlowCache::new();
    let f = cache2.field_at(&map2, &pass2, &locos, (map2.idx(5, 10) as u32, 0), None, map2.idx(30, 10));
    assert!(f.complete, "searched to the end: the cell cannot be reached");
    assert_eq!(f.dirs[map2.idx(30, 10)], DIR_NONE);
}

/// After passability changed a field is kept when the change lies outside
/// what it covers, and recomputed when the change touches a covered cell
/// (a block on a route, a freed cell next to one).
#[test]
fn fields_are_recomputed_only_for_changes_they_cover() {
    let map = open_map(120, 40);
    let mut pass = Passability::new(&map);
    let locos = tank_locos();
    let mut cache = FlowCache::new();
    let goal = map.idx(5, 20) as u32;
    let cell = map.idx(30, 20);
    let f = cache.field_at(&map, &pass, &locos, (goal, 0), None, cell);
    assert!(!f.complete);
    assert_eq!(f.dist[map.idx(100, 20)], crate::flowfield::DIST_NONE, "far cells are not covered");
    assert_eq!(cache.computed, 1);
    // A change far beyond the field's reach.
    pass.set_blocked(map.idx(100, 20), true);
    pass.refresh(&map);
    let f = cache.field_at(&map, &pass, &locos, (goal, 0), None, cell);
    let next = (30 + DIRS[f.dirs[cell] as usize].0, 20 + DIRS[f.dirs[cell] as usize].1);
    assert_eq!(cache.computed, 1, "kept");
    // A change on a covered cell.
    pass.set_blocked(map.idx(next.0, next.1), true);
    pass.refresh(&map);
    let f = cache.field_at(&map, &pass, &locos, (goal, 0), None, cell);
    assert_ne!(f.dirs[cell], DIR_NONE);
    assert_ne!((30 + DIRS[f.dirs[cell] as usize].0, 20 + DIRS[f.dirs[cell] as usize].1), next, "around the block");
    assert_eq!(cache.computed, 2, "recomputed");
    // A wall cuts the goal off: the field is complete and empty on this side.
    for y in 0..40 {
        pass.set_blocked(map.idx(15, y), true);
    }
    pass.refresh(&map);
    let f = cache.field_at(&map, &pass, &locos, (goal, 0), None, cell);
    assert_eq!(f.dirs[cell], DIR_NONE);
    assert!(f.complete);
    let computed = cache.computed;
    cache.field_at(&map, &pass, &locos, (goal, 0), None, cell);
    assert_eq!(cache.computed, computed, "an unreachable goal is not searched again while nothing changed");
    // A change in the cut-off area changes nothing for the field.
    pass.set_blocked(map.idx(60, 20), true);
    pass.refresh(&map);
    cache.field_at(&map, &pass, &locos, (goal, 0), None, cell);
    assert_eq!(cache.computed, computed, "a change the goal cannot reach is ignored");
    // A gap next to the covered side opens the way again.
    pass.set_blocked(map.idx(15, 20), false);
    pass.refresh(&map);
    let f = cache.field_at(&map, &pass, &locos, (goal, 0), None, cell);
    assert_ne!(f.dirs[cell], DIR_NONE, "the way is open again");
    assert_eq!(cache.computed, computed + 1);
}

/// The covered part of a partial field is exactly the complete field, and a
/// field kept over changes equals a fresh one: what the cache holds never
/// changes a direction.
#[test]
fn partial_and_kept_fields_equal_fresh_ones() {
    let mut map = open_map(80, 60);
    for y in 10..50 {
        let i = map.idx(40, y);
        map.terrain[i] = Terrain::Rock;
    }
    for x in 0..80 {
        let i = map.idx(x, 30);
        map.terrain[i] = Terrain::Rough;
        if x % 3 == 0 {
            map.ore[i] = 5;
        }
    }
    let mut pass = Passability::new(&map);
    let locos = tank_locos();
    let goal = map.idx(10, 30) as u32;
    let mut partial = FlowCache::new();
    let f = partial.field_at(&map, &pass, &locos, (goal, 0), None, map.idx(60, 30));
    assert!(!f.complete);
    let mut full = FlowCache::new();
    let g = full.field(&map, &pass, &locos, goal, 0);
    for c in 0..map.cells() {
        if f.dirs[c] != DIR_NONE {
            assert_eq!(f.dirs[c], g.dirs[c], "cell {c}");
            assert_eq!(f.dist[c], g.dist[c], "cell {c}");
        }
    }
    // Changes outside the covered part, then one inside: the kept field
    // and a fresh one agree on every covered cell.
    pass.set_blocked(map.idx(78, 2), true);
    pass.refresh(&map);
    pass.set_blocked(map.idx(50, 30), true);
    pass.refresh(&map);
    let f = partial.field_at(&map, &pass, &locos, (goal, 0), None, map.idx(60, 30));
    let mut fresh = FlowCache::new();
    let g = fresh.field_at(&map, &pass, &locos, (goal, 0), None, map.idx(60, 30));
    assert_eq!(f.dirs, g.dirs);
    assert_eq!(f.dist, g.dist);
}

// ---- AI ------------------------------------------------------------------------------------

/// Two bots on landmasses without a ground route between them (and one of
/// them the Naval AI): nobody hangs, the pathfinding work per tick stays
/// small, the squads do not spin, and the ground units idle at home or
/// harvest. (Like OpenRA's bots, WebRA's do not ship units across the
/// water, so such a game has no winner by land.)
#[test]
fn bots_on_separate_landmasses_stay_bounded() {
    let mut map = open_map(96, 96);
    for y in 0..96 {
        for x in 44..52 {
            let i = map.idx(x, y);
            map.terrain[i] = Terrain::Water;
        }
    }
    for (x0, y0) in [(10, 2), (66, 56)] {
        for y in y0..y0 + 38 {
            for x in x0..x0 + 20 {
                if (x + y) % 3 == 0 {
                    let i = map.idx(x, y);
                    map.ore[i] = 8;
                }
            }
        }
    }
    map.spawns = vec![(10, 10), (84, 84)];
    let players = [
        PlayerSetup { bot: BotType::Naval, ..PlayerSetup::new("allies", Some(AiDifficulty::Normal)) },
        PlayerSetup::new("soviet", Some(AiDifficulty::Normal)),
    ];
    let mut w = World::on_map(7, map, &players, GameOptions::default());
    let minutes = 8;
    let mut late = Work::default();
    let work = run(&mut w, 25 * 60 * minutes, |w, k| {
        if k == 25 * 60 * (minutes - 1) {
            late.fields = w.flow.computed;
            late.expanded = w.flow.expanded;
        }
    });
    assert!(w.winner.is_none());
    assert!(work.worst_fields <= 40, "{work:?}");
    // The last minute: on average well under a map's worth of cells per tick.
    let last_expanded = w.flow.expanded - late.expanded;
    assert!(last_expanded < 1500 * w.map.cells() as u64 / 4, "last minute expanded {last_expanded} cells");
    for a in w.actors.iter().filter(|a| a.alive && a.is_unit() && a.in_world()) {
        let ground = w.rules.actors[a.ty as usize]
            .unit
            .as_ref()
            .is_some_and(|u| w.rules.locomotors[u.locomotor].domain == crate::rules::Domain::Ground);
        if ground && a.kind != Kind::Mine {
            assert!(
                matches!(a.activity, Activity::Idle | Activity::Harvest | Activity::Move | Activity::Guard | Activity::Attack),
                "{:?} {:?}",
                w.rules.actors[a.ty as usize].id,
                a.activity
            );
            if a.activity == Activity::Attack {
                // Only targets within reach of the shore are attacked.
                let t = w.resolve(a.target).expect("a live target");
                assert!(w.are_enemies(a.owner, w.actors[t].owner));
            }
        }
    }
    let both_alive = (0..2).all(|p| w.actors.iter().any(|a| a.alive && a.owner == p && a.kind == Kind::Building));
    assert!(both_alive);
}

/// A squad member left on an island does not hold the squad back: the
/// leader would wait for it for good. It leaves the squad and the rest
/// attack.
#[test]
fn a_squad_drops_a_member_it_cannot_reach_and_attacks_on() {
    let mut map = open_map(64, 64);
    // An island of 4 x 4 cells at (28..32, 44..48), the rest of the map joined.
    for y in 42..50 {
        for x in 26..34 {
            let island = (28..32).contains(&x) && (44..48).contains(&y);
            if !island {
                let i = map.idx(x, y);
                map.terrain[i] = Terrain::Water;
            }
        }
    }
    map.spawns = vec![(4, 4), (52, 52)];
    let players =
        [PlayerSetup { bot: BotType::Rush, ..PlayerSetup::new("russia", Some(AiDifficulty::Normal)) }, PlayerSetup::new("england", None)];
    let mut w = World::on_map(4, map, &players, GameOptions::default());
    let tnk = ty(&w, "3TNK");
    for k in 0..24 {
        w.spawn_unit(tnk, 0, cell_center(10 + k % 8), cell_center(14 + k / 8), 512);
    }
    let stranded = w.spawn_unit(tnk, 0, cell_center(29), cell_center(45), 512);
    w.players[0].explored.iter_mut().for_each(|e| *e = 1);
    let enemy = crate::ai::base_point(&w, 1);
    let mut arrived = false;
    for _ in 0..25 * 60 * 3 {
        w.step();
        let near =
            w.actors.iter().filter(|a| a.alive && a.owner == 0 && a.ty == tnk && dist(a.x, a.y, enemy.0, enemy.1) < 16 * CELL).count();
        if near >= 12 {
            arrived = true;
            break;
        }
    }
    assert!(arrived, "the squad drove to the enemy base without its stranded member");
    let in_squad = crate::ai_squads::squad_units(&w, 0, crate::ai_squads::SquadType::Assault)
        .into_iter()
        .chain(crate::ai_squads::squad_units(&w, 0, crate::ai_squads::SquadType::Rush))
        .any(|i| i == stranded);
    assert!(!in_squad, "the stranded tank left the squad");
    assert_eq!(
        w.cell_of(w.actors[stranded].x, w.actors[stranded].y).0.clamp(28, 31),
        w.cell_of(w.actors[stranded].x, w.actors[stranded].y).0
    );
}

/// A bot whose only ore lies across the water does not send its trucks at
/// the bank again and again: they wait, and the bot keeps building.
#[test]
fn a_bot_without_reachable_ore_keeps_its_trucks_waiting() {
    let mut map = open_map(64, 64);
    for y in 0..64 {
        let i = map.idx(32, y);
        map.terrain[i] = Terrain::Water;
    }
    for y in 4..60 {
        for x in 40..60 {
            if (x + y) % 2 == 0 {
                let i = map.idx(x, y);
                map.ore[i] = 8;
            }
        }
    }
    map.spawns = vec![(6, 6), (50, 50)];
    let players = [PlayerSetup::new("allies", Some(AiDifficulty::Normal)), PlayerSetup::new("soviet", None)];
    let mut w = World::on_map(3, map, &players, GameOptions::default());
    w.spawn_building(ty(&w, "PROC"), 0, 10, 12).unwrap();
    w.spawn_unit(ty(&w, "HARV"), 0, cell_center(12), cell_center(17), 0);
    let work = run(&mut w, 25 * 60 * 5, |_, _| {});
    let trucks: Vec<usize> = (0..w.actors.len()).filter(|&i| w.actors[i].alive && w.actors[i].owner == 0 && w.is_harvester(i)).collect();
    assert!(!trucks.is_empty(), "the bot has ore trucks");
    for &h in &trucks {
        let a = &w.actors[h];
        assert!(a.x < 32 * CELL);
        assert!(
            matches!(a.activity, Activity::Idle)
                || (a.activity == Activity::Harvest && matches!(a.harv, HarvState::Wait | HarvState::Search)),
            "{:?} {:?}",
            a.activity,
            a.harv
        );
    }
    assert!(work.worst_fields <= 8, "{work:?}");
    assert!(w.actors.iter().filter(|a| a.alive && a.owner == 0 && a.kind == Kind::Building).count() >= 3, "it kept building");
}

/// A generated map of the naval styles has every base joined by land
/// (mapgen connects the big regions), so a game between two bots on it
/// still ends.
#[test]
fn bot_games_on_naval_map_styles_end() {
    let games: Vec<(&str, u64)> = vec![("islands", 11), ("rivers", 12), ("lakes", 13)];
    let results: Vec<(&str, Option<u8>, u32)> = std::thread::scope(|s| {
        let handles: Vec<_> = games
            .iter()
            .map(|&(style, seed)| {
                s.spawn(move || {
                    let options = GameOptions { map_style: crate::mapgen::MapStyle::from_name(style).unwrap(), ..GameOptions::default() };
                    let players =
                        [PlayerSetup::new("allies", Some(AiDifficulty::Normal)), PlayerSetup::new("soviet", Some(AiDifficulty::Normal))];
                    let mut w = World::with_options(seed, 80, &players, options);
                    for _ in 0..25 * 60 * 60 {
                        w.step();
                        if w.winner.is_some() {
                            break;
                        }
                    }
                    (style, w.winner, w.tick)
                })
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });
    for (style, winner, ticks) in results {
        assert!(winner.is_some(), "{style}: no winner after {} minutes", ticks / 1500);
    }
}

/// A bot's engineers and extra MCVs never head for structures or ore
/// fields across the water: the capture manager and the expansion manager
/// check the ground route first.
#[test]
fn bots_skip_tech_buildings_and_ore_across_the_water() {
    let mut map = open_map(64, 64);
    for y in 0..64 {
        let i = map.idx(32, y);
        map.terrain[i] = Terrain::Water;
    }
    for y in 10..30 {
        for x in 40..56 {
            let i = map.idx(x, y);
            map.ore[i] = 8;
        }
    }
    map.spawns = vec![(6, 6), (50, 50)];
    let players = [PlayerSetup::new("allies", Some(AiDifficulty::Normal)), PlayerSetup::new("soviet", None)];
    let options = GameOptions { starting_cash: 50_000, ..GameOptions::default() };
    let mut w = World::on_map(5, map, &players, options);
    let neutral = w.players.len() as u8 - 1;
    assert!(w.players[neutral as usize].neutral || neutral == 1, "a neutral seat or the passive human");
    let owner = if w.players[neutral as usize].neutral { neutral } else { 1 };
    let oil = w.spawn_building(ty(&w, "OILB"), owner, 44, 40).unwrap();
    w.players[0].explored.iter_mut().for_each(|e| *e = 1);
    let mcv = w.spawn_unit(ty(&w, "MCV"), 0, cell_center(14), cell_center(14), 0);
    run(&mut w, 25 * 60 * 6, |_, _| {});
    assert_eq!(w.actors[oil].owner, owner, "the oil derrick across the water was not captured");
    for a in w.actors.iter().filter(|a| a.alive && a.owner == 0 && a.is_unit() && a.in_world()) {
        assert!(a.x < 32 * CELL, "{} stayed on its side", w.rules.actors[a.ty as usize].id);
        let engineer = w.rules.actors[a.ty as usize].abilities.captures.is_some();
        assert!(!engineer || a.activity != Activity::Enter, "no engineer on its way across");
    }
    // The MCV deployed on its own side, or waits idle: never parked at the bank for good.
    if w.actors[mcv].alive {
        assert!(w.actors[mcv].activity == Activity::Idle || w.actors[mcv].x < 28 * CELL);
    }
    assert_eq!(w.retarget_scans, 0, "no unit ran into a cut-off goal");
    let _ = NONE;
}

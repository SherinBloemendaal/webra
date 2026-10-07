//! Simulation-level tests. Run with `cargo test -p webra-sim --release`.

use crate::math::CELL;
use crate::rules::{Kind, QueueType};
use crate::world::{cell_center, Activity, Order, World};

fn ty(w: &World, id: &str) -> u16 {
    w.rules.actor_index(id).unwrap() as u16
}

fn count(w: &World, owner: u8, id: &str) -> usize {
    let t = ty(w, id);
    w.actors.iter().filter(|a| a.alive && a.owner == owner && a.ty == t).count()
}

fn run(w: &mut World, ticks: u32) {
    for _ in 0..ticks {
        w.step();
    }
}

#[test]
fn same_seed_same_game() {
    let mut a = World::new(42, 80, &[("allies", true), ("soviet", true)]);
    let mut b = World::new(42, 80, &[("allies", true), ("soviet", true)]);
    for t in 0..4000 {
        a.step();
        b.step();
        if t % 500 == 0 {
            assert_eq!(a.state_hash(), b.state_hash(), "desync at tick {t}");
        }
    }
    assert_eq!(a.state_hash(), b.state_hash());
}

#[test]
fn player_builds_power_plant_and_places_it() {
    let mut w = World::new(1, 80, &[("allies", false), ("soviet", true)]);
    let powr = ty(&w, "POWR");
    let cash0 = w.players[0].cash;
    w.queue_order(Order::StartProduction { player: 0, ty: powr, count: 1 });
    let build = w.rules.actors[powr as usize].build_ticks as u32;
    run(&mut w, build + 5);
    let item = w.players[0].queues[QueueType::Building as usize].items[0].clone();
    assert!(item.done, "power plant finished after {build} ticks");
    assert_eq!(cash0 - w.players[0].cash, 300, "paid the full cost");
    let (sx, sy) = w.players[0].start;
    let spot = (sx + 4..sx + 8)
        .flat_map(|x| (sy - 2..sy + 6).map(move |y| (x, y)))
        .find(|&(x, y)| w.can_place(0, powr, x, y))
        .expect("a valid spot next to the construction yard");
    assert!(!w.can_place(0, powr, sx + 30, sy + 30), "too far from the base");
    w.queue_order(Order::Place { player: 0, ty: powr, cx: spot.0, cy: spot.1 });
    run(&mut w, 1);
    assert_eq!(count(&w, 0, "POWR"), 1);
    assert_eq!(w.players[0].power_gen, 100);
    // Barracks needs power: now available for Allies (TENT) but never BARR.
    assert!(w.availability(0, ty(&w, "TENT")).enabled);
    assert!(!w.availability(0, ty(&w, "BARR")).visible);
    // War factory needs a refinery first: shown but disabled.
    let weap = w.availability(0, ty(&w, "WEAP"));
    assert!(weap.visible && !weap.enabled);
}

#[test]
fn refinery_comes_with_a_harvester_that_earns_money() {
    let mut w = World::new(3, 80, &[("allies", false), ("soviet", true)]);
    let (sx, sy) = w.players[0].start;
    let proc_ = ty(&w, "PROC");
    w.spawn_building(ty(&w, "POWR"), 0, sx + 4, sy);
    w.spawn_building(proc_, 0, sx, sy + 5);
    w.refresh_tokens();
    assert_eq!(count(&w, 0, "HARV"), 1, "free harvester");
    assert_eq!(w.players[0].storage, 2000);
    let start = w.players[0].funds();
    run(&mut w, 25 * 90);
    assert!(w.players[0].funds() >= start + 500, "at least one full load delivered: {} -> {}", start, w.players[0].funds());
}

#[test]
fn units_cross_the_map_with_flow_fields() {
    let mut w = World::new(5, 96, &[("allies", false), ("soviet", false)]);
    let tnk = ty(&w, "1TNK");
    let (sx, sy) = w.players[0].start;
    let (ex, ey) = w.players[1].start;
    let mut ids = Vec::new();
    for k in 0..12 {
        let u = w.spawn_unit(tnk, 0, cell_center(sx + 5 + k % 4), cell_center(sy + 6 + k / 4), 512);
        ids.push(w.make_ref(u));
    }
    let (gx, gy) = (cell_center(ex - 4), cell_center(ey - 4));
    w.queue_order(Order::Move { player: 0, ids: ids.clone(), x: gx, y: gy, attack_move: false });
    run(&mut w, 25 * 60);
    let fields = w.flow.computed;
    for r in ids {
        let i = w.resolve(r).unwrap();
        let a = &w.actors[i];
        assert_eq!(a.activity, Activity::Idle);
        let d = crate::math::dist(a.x, a.y, gx, gy);
        assert!(d < 4 * CELL, "unit arrived near the goal, distance {d}");
    }
    assert!(fields <= 3, "the group shares one flow field, computed {fields}");
}

#[test]
fn light_tank_beats_rifleman_and_damage_follows_versus_table() {
    let mut w = World::new(7, 64, &[("allies", false), ("soviet", false)]);
    let (sx, sy) = w.players[0].start;
    let t = w.spawn_unit(ty(&w, "1TNK"), 0, cell_center(sx + 6), cell_center(sy + 8), 256);
    let e = w.spawn_unit(ty(&w, "E1"), 1, cell_center(sx + 10), cell_center(sy + 8), 768);
    let tref = w.make_ref(t);
    let eref = w.make_ref(e);
    run(&mut w, 25 * 20);
    assert!(w.resolve(eref).is_none(), "rifleman died");
    let tank = w.resolve(tref).expect("tank survived");
    let lost = w.rules.actors[w.actors[tank].ty as usize].hp - w.actors[tank].hp;
    // M1Carbine: 1000 damage, 10% versus Heavy armor -> 100 per hit.
    assert!(lost % 100 == 0, "every carbine hit does 100 to heavy armor, lost {lost}");
}

#[test]
fn heavy_tank_needs_service_depot() {
    let mut w = World::new(9, 80, &[("soviet", false), ("allies", true)]);
    let (sx, sy) = w.players[0].start;
    let t3 = ty(&w, "3TNK");
    w.spawn_building(ty(&w, "POWR"), 0, sx + 4, sy);
    w.spawn_building(ty(&w, "PROC"), 0, sx, sy + 5);
    w.spawn_building(ty(&w, "WEAP"), 0, sx + 4, sy + 4);
    w.refresh_tokens();
    let av = w.availability(0, t3);
    assert!(av.visible && !av.enabled);
    assert!(!w.availability(0, ty(&w, "1TNK")).visible, "allied tank hidden for soviets");
    w.spawn_building(ty(&w, "FIX"), 0, sx + 8, sy);
    w.refresh_tokens();
    assert!(w.availability(0, t3).enabled);
    w.players[0].cash = 10_000;
    w.queue_order(Order::StartProduction { player: 0, ty: t3, count: 2 });
    let ticks = 2 * w.rules.actors[t3 as usize].build_ticks as u32 * 4;
    run(&mut w, ticks);
    assert_eq!(count(&w, 0, "3TNK"), 2);
}

#[test]
fn ai_builds_a_base_and_army() {
    let mut w = World::new(11, 96, &[("allies", false), ("soviet", true)]);
    run(&mut w, 25 * 60 * 4);
    let buildings = w.actors.iter().filter(|a| a.alive && a.owner == 1 && a.kind == Kind::Building).count();
    let army = w.actors.iter().filter(|a| a.alive && a.owner == 1 && a.kind != Kind::Building && !w.rules.actors[a.ty as usize].weapons.is_empty()).count();
    assert!(buildings >= 6, "AI built a base: {buildings} buildings");
    assert!(army >= 4, "AI built an army: {army}");
    assert!(count(&w, 1, "HARV") >= 1);
}

#[test]
fn ai_vs_ai_game_runs_and_fights() {
    let mut w = World::new(13, 80, &[("allies", true), ("soviet", true)]);
    let mut max_units = 0;
    for _ in 0..(25 * 60 * 15) {
        w.step();
        max_units = max_units.max(w.actors.iter().filter(|a| a.alive && a.kind != Kind::Building).count());
        if w.winner.is_some() {
            break;
        }
    }
    let killed: u32 = w.losses.iter().sum();
    assert!(max_units >= 10, "armies were built: {max_units}");
    assert!(killed >= 5, "fighting happened: {killed} dead");
    assert!(w.winner.is_some(), "one AI destroyed the other within 15 minutes");
}

#[test]
fn stress_world_ticks() {
    let mut w = World::new_stress(1, 4000, 160);
    let alive0 = w.actors.iter().filter(|a| a.alive).count();
    assert_eq!(alive0, 4000);
    let t0 = std::time::Instant::now();
    run(&mut w, 100);
    let per_tick = t0.elapsed().as_secs_f64() * 1000.0 / 100.0;
    eprintln!("stress: 4000 units, {per_tick:.2} ms per tick (native), {} flow fields", w.flow.computed);
}

#[test]
fn requirements_explain_what_is_missing() {
    let w = World::new(1, 64, &[("russia", false), ("england", true)]);
    let labels = |t: &str| w.requirements(0, ty(&w, t)).into_iter().map(|r| (r.label, r.never)).collect::<Vec<_>>();
    assert_eq!(labels("3TNK"), vec![("Service Depot".to_string(), false), ("War Factory".to_string(), false)]);
    assert_eq!(labels("1TNK"), vec![("Allies only".to_string(), true)]);
    assert_eq!(labels("TENT"), vec![("Power Plant".to_string(), false), ("Allies only".to_string(), true)]);
    assert_eq!(labels("E1"), vec![("Allied Barracks or Soviet Barracks".to_string(), false)]);
    assert!(labels("POWR").is_empty());
}

#[test]
fn tanks_crush_enemy_infantry_but_not_friends() {
    let mut w = World::new(17, 64, &[("allies", false), ("soviet", false)]);
    let (sx, sy) = w.players[0].start;
    let (x0, y) = (cell_center(sx + 6), cell_center(sy + 9));
    let tank = w.spawn_unit(ty(&w, "1TNK"), 0, x0, y, 256);
    let enemy = w.spawn_unit(ty(&w, "E1"), 1, x0 + 3 * CELL, y, 768);
    let friend = w.spawn_unit(ty(&w, "E1"), 0, x0 + 3 * CELL, y + 3 * CELL, 768);
    let (tref, eref, fref) = (w.make_ref(tank), w.make_ref(enemy), w.make_ref(friend));
    // Hold the rifleman's fire so only the crush can kill it.
    w.actors[enemy].reload = [1_000_000; crate::world::MAX_WEAPONS];
    w.actors[tank].reload = [1_000_000; crate::world::MAX_WEAPONS];
    w.queue_order(Order::Move { player: 0, ids: vec![tref], x: x0 + 6 * CELL, y, attack_move: false });
    run(&mut w, 25 * 6);
    assert!(w.resolve(eref).is_none(), "enemy rifleman was crushed");
    w.queue_order(Order::Move { player: 0, ids: vec![tref], x: x0 + 3 * CELL, y: y + 3 * CELL, attack_move: false });
    run(&mut w, 25 * 6);
    assert!(w.resolve(fref).is_some(), "friendly infantry is pushed aside, not crushed");
}

#[test]
fn idle_ore_truck_goes_back_to_work() {
    let mut w = World::new(3, 80, &[("allies", false), ("soviet", true)]);
    let (sx, sy) = w.players[0].start;
    w.spawn_building(ty(&w, "POWR"), 0, sx + 4, sy);
    w.spawn_building(ty(&w, "PROC"), 0, sx, sy + 5);
    run(&mut w, 50);
    let h = (0..w.actors.len()).find(|&i| w.actors[i].alive && w.is_harvester(i)).unwrap();
    let href = w.make_ref(h);
    w.queue_order(Order::Move { player: 0, ids: vec![href], x: cell_center(sx + 8), y: cell_center(sy + 12), attack_move: false });
    run(&mut w, 25 * 10);
    assert_eq!(w.actors[h].activity, Activity::Harvest, "truck resumed harvesting after the move");
}

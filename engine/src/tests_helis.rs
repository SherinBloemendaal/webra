//! Tests for helicopters.

use crate::helicopter::HeliTask;
use crate::map::{Map, Terrain};
use crate::math::{dist, CELL};
use crate::rules::{Kind, Rules};
use crate::world::{cell_center, Activity, AiDifficulty, Order, SmartAction, World};

fn ty(w: &World, id: &str) -> u16 {
    w.rules.actor_index(id).unwrap() as u16
}

fn run(w: &mut World, ticks: u32) {
    for _ in 0..ticks {
        w.step();
    }
}

/// Run until `done` holds (at most `limit` ticks). Returns the ticks taken.
fn run_until(w: &mut World, limit: u32, done: impl Fn(&World) -> bool) -> u32 {
    for t in 0..limit {
        if done(w) {
            return t;
        }
        w.step();
    }
    panic!("condition not reached in {limit} ticks");
}

/// A 48x48 all-clear map: player 0 Soviet with a base in the north-west,
/// player 1 England with a base in the south-east, both rich.
fn flat_world() -> World {
    let rules = Rules::load();
    let mut map = Map::generate(48, 48, 5, 12);
    for i in 0..map.cells() {
        map.terrain[i] = Terrain::Clear;
        map.ore[i] = 0;
        map.gems[i] = 0;
    }
    let mut w = World::empty(rules, map, 5);
    w.pass = crate::flowfield::Passability::new(&w.map);
    w.pass_water = crate::flowfield::Passability::water(&w.map);
    w.pass_landing = crate::flowfield::Passability::landing(&w.map);
    let soviet = w.rules.faction_index("soviet").unwrap();
    let england = w.rules.faction_index("england").unwrap();
    w.add_player(soviet, false, (2, 2));
    w.add_player(england, false, (40, 40));
    w.ai = (0..2).map(|p| crate::ai::AiState::new(&w.rules, p as u8, Default::default(), AiDifficulty::Normal)).collect();
    for (p, (x, y)) in [(0u8, (2, 2)), (1u8, (40, 40))] {
        w.spawn_building(ty(&w, "FACT"), p, x, y);
        w.spawn_building(ty(&w, "POWR"), p, x + 4, y);
        w.players[p as usize].cash = 100_000;
    }
    w.refresh_tokens();
    w.update_power();
    w.update_vision();
    w
}

fn heli(w: &mut World, id: &str, owner: u8, cx: i32, cy: i32) -> usize {
    let t = ty(w, id);
    w.spawn_unit(t, owner, cell_center(cx), cell_center(cy), 0)
}

fn cruise(w: &World, i: usize) -> i32 {
    w.rules.actors[w.actors[i].ty as usize].unit.as_ref().unwrap().aircraft.as_ref().unwrap().cruise_altitude
}

/// Touch-down point of a helipad (centre of its 2x2 pad).
fn pad_point(w: &World, pad: usize) -> (i32, i32) {
    (w.actors[pad].cx * CELL + CELL, w.actors[pad].cy * CELL + CELL)
}

fn r(w: &World, i: usize) -> Vec<u32> {
    vec![w.make_ref(i)]
}

#[test]
fn hind_is_buildable_for_the_soviets_at_their_helipad() {
    let mut w = flat_world();
    let (hpad, hind, mh60, tran) = (ty(&w, "HPAD"), ty(&w, "HIND"), ty(&w, "MH60"), ty(&w, "TRAN"));
    w.spawn_building(ty(&w, "DOME"), 0, 2, 7);
    w.spawn_building(ty(&w, "DOME"), 1, 40, 35);
    w.refresh_tokens();
    // The helipad is a structure for both sides (classic Red Alert).
    assert!(w.availability(0, hpad).enabled && w.availability(1, hpad).enabled);
    assert!(!w.availability(0, hind).visible, "no helipad yet");
    w.spawn_building(hpad, 0, 10, 2);
    w.spawn_building(hpad, 1, 34, 40);
    w.refresh_tokens();
    assert!(w.availability(0, hind).enabled, "Soviets fly the Hind");
    assert!(w.availability(0, tran).enabled && w.availability(1, tran).enabled, "both build the Chinook");
    assert!(!w.availability(1, hind).visible, "not for the Allies");
    assert!(w.availability(1, mh60).enabled && !w.availability(0, mh60).visible, "Black Hawk stays Allied");
}

#[test]
fn hind_is_built_landed_on_the_helipad_then_takes_off() {
    let mut w = flat_world();
    let pad = w.spawn_building(ty(&w, "HPAD"), 0, 10, 10).unwrap();
    w.refresh_tokens();
    w.update_power();
    let hind = ty(&w, "HIND");
    w.queue_order(Order::StartProduction { player: 0, ty: hind, count: 1 });
    let _ = run_until(&mut w, 1500, |w| w.actors.iter().any(|a| a.alive && a.ty == hind));
    let i = w.actors.iter().position(|a| a.alive && a.ty == hind).unwrap();
    let (px, py) = pad_point(&w, pad);
    assert_eq!((w.actors[i].x, w.actors[i].y), (px, py), "appears on the pad");
    let climb = w.rules.actors[hind as usize].unit.as_ref().unwrap().aircraft.as_ref().unwrap().altitude_velocity;
    assert!(w.actors[i].altitude <= climb, "starts on the ground (and lifts off the same tick)");
    // It heads for the rally point: vertical take-off first, then flight.
    run(&mut w, 5);
    assert!(w.actors[i].altitude > 0);
    assert!(dist(w.actors[i].x, w.actors[i].y, px, py) < 64, "climbs straight up");
    run(&mut w, 200);
    let a = &w.actors[i];
    assert_eq!(a.altitude, cruise(&w, i));
    assert!(dist(a.x, a.y, px, py) > 2 * CELL, "left the pad");
    assert_eq!(a.activity, Activity::Idle, "hovers at the rally point");
}

#[test]
fn helicopters_hover_in_place_and_turn_in_place() {
    let mut w = flat_world();
    let i = heli(&mut w, "MH60", 0, 20, 20);
    let ids = r(&w, i);
    w.queue_order(Order::Move { player: 0, ids: ids.clone(), x: cell_center(30), y: cell_center(20), attack_move: false });
    run(&mut w, 20);
    w.queue_order(Order::Stop { player: 0, ids: ids.clone() });
    run(&mut w, 1);
    let (x, y) = (w.actors[i].x, w.actors[i].y);
    assert!(x > cell_center(20) && x < cell_center(30), "stopped mid-way");
    run(&mut w, 50);
    assert_eq!((w.actors[i].x, w.actors[i].y), (x, y), "hovers in place");
    assert_eq!(w.actors[i].altitude, cruise(&w, i), "still in the air");
    // A target to the south: it turns on the spot to face it and fires.
    let facing = w.actors[i].facing;
    let tank = w.spawn_unit(ty(&w, "1TNK"), 1, x, y + 3 * CELL, 0);
    let hp = w.actors[tank].hp;
    let t = w.make_ref(tank);
    w.queue_order(Order::Attack { player: 0, ids, target: t });
    run(&mut w, 3);
    assert_eq!((w.actors[i].x, w.actors[i].y), (x, y), "turns without moving");
    assert_ne!(w.actors[i].facing, facing);
    run(&mut w, 60);
    assert!(crate::math::angle_diff(w.actors[i].facing, 512).abs() <= 80, "faces the target");
    assert!(w.actors[tank].hp < hp, "chain gun hit the tank");
}

#[test]
fn rotors_spin_fast_in_the_air_and_slowly_on_the_ground() {
    let mut w = flat_world();
    let i = heli(&mut w, "HIND", 0, 20, 20);
    let t0 = w.actors[i].turret;
    run(&mut w, 1);
    let air = crate::math::angle_diff(t0, w.actors[i].turret).abs();
    w.actors[i].altitude = 0;
    w.actors[i].heli.landed = true;
    let t1 = w.actors[i].turret;
    run(&mut w, 1);
    let ground = crate::math::angle_diff(t1, w.actors[i].turret).abs();
    assert!(air > ground && ground > 0, "air {air} ground {ground}");
}

#[test]
fn black_hawk_attacks_ground_but_not_air_and_spends_ammo() {
    let mut w = flat_world();
    w.add_player(w.rules.faction_index("england").unwrap(), false, (0, 0));
    let i = heli(&mut w, "MH60", 1, 20, 20);
    let tank = w.spawn_unit(ty(&w, "3TNK"), 0, cell_center(24), cell_center(20), 0);
    let enemy_heli = heli(&mut w, "HIND", 0, 20, 24);
    run(&mut w, 2);
    // Chain gun: ground only.
    let hp = w.actors[enemy_heli].hp;
    let target = w.make_ref(enemy_heli);
    w.queue_order(Order::Attack { player: 1, ids: r(&w, i), target });
    run(&mut w, 60);
    assert_eq!(w.actors[enemy_heli].hp, hp, "a chain gun cannot hit aircraft");
    assert_eq!(w.heli_ammo(i), (24, 24));
    let hp = w.actors[tank].hp;
    let target = w.make_ref(tank);
    w.queue_order(Order::Attack { player: 1, ids: r(&w, i), target });
    run(&mut w, 60);
    assert!(w.actors[tank].hp < hp, "strafed the tank");
    let (ammo, max) = w.heli_ammo(i);
    assert!(ammo < max, "rounds spent: {ammo}/{max}");
}

#[test]
fn longbow_fires_hellfires_at_ground_and_air_targets() {
    let mut w = flat_world();
    let i = heli(&mut w, "HELI", 1, 20, 20);
    let enemy_heli = heli(&mut w, "HIND", 0, 20, 23);
    run(&mut w, 2);
    let hp = w.actors[enemy_heli].hp;
    let target = w.make_ref(enemy_heli);
    w.queue_order(Order::Attack { player: 1, ids: r(&w, i), target });
    run(&mut w, 80);
    assert!(!w.actors[enemy_heli].alive || w.actors[enemy_heli].hp < hp, "anti-air Hellfire hit the Hind");
    let tank = w.spawn_unit(ty(&w, "3TNK"), 0, cell_center(24), cell_center(20), 0);
    run(&mut w, 2);
    let (before, _) = w.heli_ammo(i);
    let hp = w.actors[tank].hp;
    let target = w.make_ref(tank);
    w.queue_order(Order::Attack { player: 1, ids: r(&w, i), target });
    run(&mut w, 80);
    assert!(w.actors[tank].hp < hp, "anti-ground Hellfire hit the tank");
    assert!(w.heli_ammo(i).0 < before);
}

#[test]
fn idle_helicopters_hold_fire_but_attack_move_engages() {
    let mut w = flat_world();
    let i = heli(&mut w, "HIND", 0, 20, 20);
    let tank = w.spawn_unit(ty(&w, "1TNK"), 1, cell_center(23), cell_center(20), 0);
    let hp = w.actors[tank].hp;
    run(&mut w, 100);
    assert_eq!(w.actors[tank].hp, hp, "HoldFire stance: no shots while idle");
    w.queue_order(Order::Move { player: 0, ids: r(&w, i), x: cell_center(30), y: cell_center(20), attack_move: true });
    run(&mut w, 80);
    assert!(w.actors[tank].hp < hp, "attack-move engages");
}

#[test]
fn empty_helicopter_returns_to_the_helipad_reloads_and_takes_off() {
    let mut w = flat_world();
    let pad = w.spawn_building(ty(&w, "HPAD"), 0, 10, 10).unwrap();
    w.update_power();
    let i = heli(&mut w, "HIND", 0, 24, 20);
    w.actors[i].heli.ammo_used = 24;
    let tank = w.spawn_unit(ty(&w, "1TNK"), 1, cell_center(26), cell_center(20), 0);
    let hp = w.actors[tank].hp;
    let target = w.make_ref(tank);
    run(&mut w, 2);
    w.queue_order(Order::Attack { player: 0, ids: r(&w, i), target });
    run(&mut w, 2);
    assert_eq!(w.actors[i].heli.task, HeliTask::Resupply, "out of ammo: back to base");
    assert_eq!(w.actors[pad].dock_user, w.make_ref(i), "reserved the helipad");
    run_until(&mut w, 800, |w| w.actors[i].heli.landed);
    assert_eq!(w.actors[tank].hp, hp, "no shots without ammo");
    let (px, py) = pad_point(&w, pad);
    assert_eq!((w.actors[i].x, w.actors[i].y, w.actors[i].altitude), (px, py, 0), "landed on the pad");
    // AmmoPool ReloadDelay 8, ReloadCount 1: a round every 8 ticks.
    run(&mut w, 80);
    let (ammo, _) = w.heli_ammo(i);
    assert!((9..=10).contains(&ammo), "{ammo} rounds after 80 ticks");
    assert_eq!(w.actors[i].altitude, 0, "stays down while reloading");
    run(&mut w, 120);
    assert_eq!(w.heli_ammo(i), (24, 24), "full again");
    run(&mut w, 30);
    assert_eq!(w.actors[i].altitude, cruise(&w, i), "took off after resupply");
    assert!(w.resolve(w.actors[pad].dock_user).is_none(), "pad free again");
}

#[test]
fn return_to_base_with_full_ammo_waits_near_the_helipad() {
    let mut w = flat_world();
    let pad = w.spawn_building(ty(&w, "HPAD"), 0, 10, 10).unwrap();
    w.update_power();
    let i = heli(&mut w, "HIND", 0, 30, 20);
    w.queue_order(Order::ReturnToBase { player: 0, ids: r(&w, i) });
    run(&mut w, 400);
    let (px, py) = pad_point(&w, pad);
    let wait = w.rules.actors[w.actors[i].ty as usize].unit.as_ref().unwrap().aircraft.as_ref().unwrap().wait_distance;
    let d = dist(w.actors[i].x, w.actors[i].y, px, py);
    assert!(d <= wait && d > CELL, "hovers near the base ({d})");
    assert!(!w.actors[i].heli.landed && w.actors[i].heli.task == HeliTask::None);
    assert!(w.resolve(w.actors[pad].dock_user).is_none(), "the pad stays free");
}

#[test]
fn one_helicopter_per_helipad() {
    let mut w = flat_world();
    let pad = w.spawn_building(ty(&w, "HPAD"), 0, 10, 10).unwrap();
    w.update_power();
    let a = heli(&mut w, "HIND", 0, 24, 20);
    let b = heli(&mut w, "HIND", 0, 26, 20);
    for i in [a, b] {
        w.actors[i].heli.ammo_used = 24;
    }
    w.queue_order(Order::ReturnToBase { player: 0, ids: vec![w.make_ref(a), w.make_ref(b)] });
    run_until(&mut w, 800, |w| w.actors[a].heli.landed || w.actors[b].heli.landed);
    let (a, b) = if w.actors[a].heli.landed { (a, b) } else { (b, a) };
    let (px, py) = pad_point(&w, pad);
    let wait = w.rules.actors[w.actors[b].ty as usize].unit.as_ref().unwrap().aircraft.as_ref().unwrap().wait_distance;
    assert!(!w.actors[b].heli.landed && w.actors[b].altitude == cruise(&w, b), "the second one waits in the air");
    run(&mut w, 20);
    assert!(dist(w.actors[b].x, w.actors[b].y, px, py) <= wait + 256, "waiting near the pad");
    // Once the first has reloaded and left, the second lands and reloads.
    run_until(&mut w, 1000, |w| w.actors[b].heli.landed);
    assert!(!w.actors[a].heli.landed, "the first left the pad");
    assert_eq!((w.actors[b].x, w.actors[b].y), (px, py));
    run(&mut w, 260);
    assert_eq!(w.heli_ammo(a).0, 24);
    assert_eq!(w.heli_ammo(b).0, 24);
}

#[test]
fn helicopters_land_only_on_landable_free_cells() {
    let mut w = flat_world();
    // Water at (30, 30) only, rock all around (33, 10).
    let ci = w.map.idx(30, 30);
    w.map.terrain[ci] = Terrain::Water;
    for y in 6..=14 {
        for x in 29..=37 {
            let c = w.map.idx(x, y);
            w.map.terrain[c] = Terrain::Rock;
        }
    }
    w.pass = crate::flowfield::Passability::new(&w.map);
    w.pass_water = crate::flowfield::Passability::water(&w.map);
    w.pass_landing = crate::flowfield::Passability::landing(&w.map);
    let i = heli(&mut w, "MH60", 0, 20, 20);
    // On clear ground: lands right there.
    w.queue_order(Order::Land { player: 0, ids: r(&w, i), x: cell_center(22), y: cell_center(24) });
    run_until(&mut w, 300, |w| w.actors[i].heli.landed);
    assert_eq!((w.actors[i].x, w.actors[i].y, w.actors[i].altitude), (cell_center(22), cell_center(24), 0));
    assert_eq!(w.target_kind(i), Kind::Vehicle, "a landed helicopter is a ground target");
    // On water: lands on the nearest dry cell instead.
    w.queue_order(Order::Land { player: 0, ids: r(&w, i), x: cell_center(30), y: cell_center(30) });
    run(&mut w, 2);
    assert!(!w.actors[i].heli.landed && w.actors[i].altitude > 0, "took off");
    run_until(&mut w, 400, |w| w.actors[i].heli.landed);
    let (cx, cy) = w.cell_of(w.actors[i].x, w.actors[i].y);
    assert_ne!((cx, cy), (30, 30));
    assert!((cx - 30).abs() <= 1 && (cy - 30).abs() <= 1, "next to the water at ({cx}, {cy})");
    // In the middle of rock: nowhere to land, so it hovers there.
    w.queue_order(Order::Land { player: 0, ids: r(&w, i), x: cell_center(33), y: cell_center(10) });
    run(&mut w, 400);
    assert!(!w.actors[i].heli.landed && w.actors[i].altitude == cruise(&w, i));
    assert_eq!(w.cell_of(w.actors[i].x, w.actors[i].y), (33, 10), "hovers over the rock");
    // Next to a parked tank: not on top of it.
    let tank = w.spawn_unit(ty(&w, "3TNK"), 0, cell_center(25), cell_center(30), 0);
    run(&mut w, 1);
    w.queue_order(Order::Land { player: 0, ids: r(&w, i), x: cell_center(25), y: cell_center(30) });
    run_until(&mut w, 400, |w| w.actors[i].heli.landed);
    assert_ne!(w.cell_of(w.actors[i].x, w.actors[i].y), w.cell_of(w.actors[tank].x, w.actors[tank].y));
}

#[test]
fn deploy_lands_and_takes_off_again() {
    let mut w = flat_world();
    let i = heli(&mut w, "HIND", 0, 20, 20);
    w.queue_order(Order::Deploy { player: 0, ids: r(&w, i) });
    run_until(&mut w, 100, |w| w.actors[i].heli.landed);
    assert_eq!(w.cell_of(w.actors[i].x, w.actors[i].y), (20, 20));
    w.queue_order(Order::Deploy { player: 0, ids: r(&w, i) });
    run(&mut w, 40);
    assert_eq!(w.actors[i].altitude, cruise(&w, i));
    assert_eq!(w.cell_of(w.actors[i].x, w.actors[i].y), (20, 20), "straight up");
}

#[test]
fn landed_helicopters_are_hit_by_ground_weapons_not_anti_air() {
    let mut w = flat_world();
    let i = heli(&mut w, "HIND", 0, 20, 20);
    w.queue_order(Order::Land { player: 0, ids: r(&w, i), x: cell_center(20), y: cell_center(20) });
    run_until(&mut w, 100, |w| w.actors[i].heli.landed);
    let tank = &w.rules.actors[ty(&w, "1TNK") as usize];
    assert!(tank.can_attack(&w.rules, w.target_kind(i)), "tanks can shoot a landed helicopter");
    let sam = &w.rules.actors[ty(&w, "SAM") as usize];
    assert!(!sam.can_attack(&w.rules, w.target_kind(i)), "SAMs cannot");
    let t = w.spawn_unit(ty(&w, "1TNK"), 1, cell_center(23), cell_center(20), 0);
    let _ = t;
    let hp = w.actors[i].hp;
    run(&mut w, 100);
    assert!(!w.actors[i].alive || w.actors[i].hp < hp, "the tank shot the landed Hind");
}

#[test]
fn smart_order_on_own_helipad_lands_and_reloads() {
    let mut w = flat_world();
    let pad = w.spawn_building(ty(&w, "HPAD"), 0, 10, 10).unwrap();
    w.update_power();
    w.update_vision();
    let i = heli(&mut w, "HIND", 0, 20, 20);
    w.actors[i].heli.ammo_used = 10;
    run(&mut w, 2);
    let (px, py) = pad_point(&w, pad);
    assert_eq!(w.smart_action(0, &[i], px, py), SmartAction::Dock);
    w.queue_order(Order::Smart { player: 0, ids: r(&w, i), x: px, y: py });
    run_until(&mut w, 600, |w| w.actors[i].heli.landed);
    assert_eq!((w.actors[i].x, w.actors[i].y), (px, py));
    run_until(&mut w, 200, |w| w.heli_ammo(i).0 == 24);
    run(&mut w, 50);
    assert!(w.actors[i].heli.landed, "ordered onto this pad: stays there");
    assert_eq!(w.actors[pad].dock_user, w.make_ref(i), "and keeps it reserved");
}

#[test]
fn damaged_helicopter_is_repaired_on_the_service_depot() {
    let mut w = flat_world();
    let fix = w.spawn_building(ty(&w, "FIX"), 0, 12, 12).unwrap();
    w.update_vision();
    let i = heli(&mut w, "HIND", 0, 24, 20);
    let max = w.actors[i].hp;
    w.actors[i].hp = max / 2;
    run(&mut w, 2);
    let (x, y) = (cell_center(13), cell_center(13));
    assert_eq!(w.smart_action(0, &[i], x, y), SmartAction::Repair);
    let cash = w.players[0].cash;
    w.queue_order(Order::Smart { player: 0, ids: r(&w, i), x, y });
    run_until(&mut w, 600, |w| w.actors[i].heli.landed);
    assert_eq!((w.actors[i].x, w.actors[i].y), (x, y), "landed on the depot pad");
    let _ = fix;
    run_until(&mut w, 1000, |w| w.actors[i].hp == max);
    assert!(w.players[0].cash < cash, "repairs cost money");
    run(&mut w, 40);
    assert!(w.actors[i].altitude > 0, "takes off when repaired");
}

#[test]
fn shot_down_helicopters_fall_and_explode_on_the_ground() {
    let mut w = flat_world();
    let i = heli(&mut w, "HIND", 0, 20, 20);
    let soldier = w.spawn_unit(ty(&w, "E1"), 1, cell_center(20), cell_center(20), 0);
    run(&mut w, 1);
    w.damage(i, 1_000_000);
    assert!(!w.actors[i].alive);
    assert_eq!(w.crashes.len(), 1, "the husk falls");
    run(&mut w, 5);
    assert!(w.actors[soldier].alive, "nothing exploded yet");
    run(&mut w, 40);
    assert!(w.crashes.is_empty(), "hit the ground");
    assert!(!w.actors[soldier].alive || w.actors[soldier].hp < 5000, "the wreck exploded on the soldier");
    // On the ground a helicopter just explodes.
    let j = heli(&mut w, "HIND", 0, 30, 30);
    w.actors[j].altitude = 0;
    w.actors[j].heli.landed = true;
    w.damage(j, 1_000_000);
    assert!(w.crashes.is_empty());
}

#[test]
fn helicopter_games_are_deterministic() {
    let play = || {
        let mut w = flat_world();
        w.spawn_building(ty(&w, "HPAD"), 0, 10, 10);
        w.update_power();
        let a = heli(&mut w, "HIND", 0, 20, 20);
        let b = heli(&mut w, "HELI", 1, 30, 22);
        let t = w.spawn_unit(ty(&w, "1TNK"), 1, cell_center(26), cell_center(21), 0);
        let (ta, tb) = (w.make_ref(t), w.make_ref(a));
        w.queue_order(Order::Attack { player: 0, ids: r(&w, a), target: ta });
        w.queue_order(Order::Attack { player: 1, ids: r(&w, b), target: tb });
        run(&mut w, 600);
        w.state_hash()
    };
    assert_eq!(play(), play());
}

#[test]
fn land_and_return_orders_round_trip_as_json() {
    for o in [Order::Land { player: 1, ids: vec![3], x: 10, y: 20 }, Order::ReturnToBase { player: 1, ids: vec![3] }] {
        let s = serde_json::to_string(&o).unwrap();
        let back: Order = serde_json::from_str(&s).unwrap();
        assert_eq!(back.player(), 1);
        assert!(s.contains("\"o\":\"land\"") || s.contains("\"o\":\"return_to_base\""), "{s}");
    }
}

#[test]
fn render_draws_rotors_crashes_and_ammo_pips() {
    use crate::render::{SpriteIds, View, SPRITE_FLOATS};
    let mut w = flat_world();
    let _tran = heli(&mut w, "TRAN", 0, 20, 20);
    let hind = heli(&mut w, "HIND", 0, 24, 20);
    w.actors[hind].heli.ammo_used = 12;
    run(&mut w, 2);
    let ids = SpriteIds::new(w.rules.actors.len());
    let view = View { x0: 0.0, y0: 0.0, x1: 48.0 * 24.0, y1: 48.0 * 24.0 };
    let (mut sprites, mut rects) = (Vec::new(), Vec::new());
    let selected = vec![w.make_ref(hind)];
    w.build_render(0, 0.5, &view, &selected, &mut sprites, &mut rects);
    let count = |s: &[f32], id: f32| s.chunks(SPRITE_FLOATS).filter(|c| c[3] == id).count();
    let disc = ids.helis_base;
    assert_eq!(count(&sprites, (ty(&w, "TRAN") * 2 + 1) as f32), 2, "the Chinook has two rotors");
    assert_eq!(count(&sprites, (ty(&w, "HIND") * 2 + 1) as f32), 1);
    assert_eq!(count(&sprites, disc), 3, "a blurred disc per rotor in flight");
    // Ammo pips: 6 for the Hind, 3 of them lit at half ammo (dark backs plus lit fronts).
    let pips = rects.chunks(8).filter(|r| r[2] == 3.0 && r[3] == 3.0).count();
    let lit = rects.chunks(8).filter(|r| r[2] == 2.0 && r[3] == 2.0).count();
    assert_eq!((pips, lit), (6, 3));
    // A shot-down helicopter is drawn falling with smoke.
    w.damage(hind, 1_000_000);
    w.build_render(0, 0.5, &view, &selected, &mut sprites, &mut rects);
    assert_eq!(count(&sprites, (ty(&w, "HIND") * 2) as f32), 2, "husk and its shadow");
    assert_eq!(count(&sprites, ids.helis_base + 2.0), 1, "smoke");
}

#[test]
fn chinook_lands_to_load_and_unload_infantry() {
    let mut w = flat_world();
    let tran = heli(&mut w, "TRAN", 0, 20, 20);
    let soldiers: Vec<usize> = (0..3).map(|k| w.spawn_unit(ty(&w, "E1"), 0, cell_center(17 + k), cell_center(24), 0)).collect();
    // Hovering: soldiers cannot get in until it lands.
    let ids: Vec<u32> = soldiers.iter().map(|&s| w.make_ref(s)).collect();
    w.queue_order(Order::Smart { player: 0, ids: ids.clone(), x: w.actors[tran].x, y: w.actors[tran].y });
    run(&mut w, 60);
    assert!(w.passengers(tran).is_empty(), "no boarding in the air");
    // Deploy on the empty Chinook lands it; then they board.
    w.queue_order(Order::Deploy { player: 0, ids: r(&w, tran) });
    run_until(&mut w, 100, |w| w.actors[tran].heli.landed);
    w.queue_order(Order::Smart { player: 0, ids, x: w.actors[tran].x, y: w.actors[tran].y });
    run_until(&mut w, 300, |w| w.passengers(tran).len() == 3);
    assert!(soldiers.iter().all(|&s| !w.actors[s].in_world()), "passengers are out of the world");
    // Fly elsewhere: passengers ride along, hidden.
    w.queue_order(Order::Move { player: 0, ids: r(&w, tran), x: cell_center(32), y: cell_center(30), attack_move: false });
    run(&mut w, 150);
    assert_eq!(w.actors[tran].altitude, cruise(&w, tran));
    assert!(soldiers.iter().all(|&s| (w.actors[s].x, w.actors[s].y) == (w.actors[tran].x, w.actors[tran].y)));
    // Deploy on the loaded Chinook: lands and unloads, then takes off.
    w.queue_order(Order::Deploy { player: 0, ids: r(&w, tran) });
    run_until(&mut w, 300, |w| w.passengers(w.resolve(w.make_ref(tran)).unwrap()).is_empty());
    assert!(soldiers.iter().all(|&s| w.actors[s].in_world()));
    let (tx, ty_) = w.cell_of(w.actors[tran].x, w.actors[tran].y);
    assert!((tx - 32).abs() <= 3 && (ty_ - 30).abs() <= 3, "unloaded at the destination");
    run(&mut w, 120);
    assert!(!w.actors[tran].heli.landed && w.actors[tran].altitude > 0, "took off after unloading");
}

#[test]
fn passengers_die_when_the_chinook_is_shot_down() {
    let mut w = flat_world();
    let tran = heli(&mut w, "TRAN", 0, 20, 20);
    let s = w.spawn_unit(ty(&w, "E1"), 0, cell_center(20), cell_center(20), 0);
    assert!(w.load_passenger(tran, s));
    w.damage(tran, 1_000_000);
    assert!(!w.actors[s].alive, "went down with the Chinook");
}

/// A helicopter of type `id` attacks a tank until its AmmoPool is empty,
/// reloads on the helipad and is full again; `abort` sets its OpenRA
/// AttackAircraft AbortOnResupply. Returns the world, helicopter and tank.
fn heli_out_of_ammo(id: &str, abort: bool) -> (World, usize, usize) {
    let mut w = flat_world();
    let t = ty(&w, id) as usize;
    w.rules.actors[t].unit.as_mut().unwrap().aircraft.as_mut().unwrap().abort_on_resupply = abort;
    w.spawn_building(ty(&w, "HPAD"), 0, 10, 10).unwrap();
    w.update_power();
    let i = heli(&mut w, id, 0, 24, 20);
    // Two rounds left: the tank outlives them.
    let max = w.heli_ammo(i).1;
    w.actors[i].heli.ammo_used = max - 2;
    let tank = w.spawn_unit(ty(&w, "4TNK"), 1, cell_center(28), cell_center(20), 0);
    w.actors[tank].reload = [1_000_000; crate::world::MAX_WEAPONS];
    w.actors[tank].stance = crate::rules::Stance::HoldFire;
    run(&mut w, 2);
    w.queue_order(Order::Attack { player: 0, ids: r(&w, i), target: w.make_ref(tank) });
    run_until(&mut w, 400, |w| w.heli_ammo(i).0 == 0);
    run(&mut w, 2);
    assert_eq!(w.actors[i].heli.task, HeliTask::Resupply, "{id}: out of ammo, back to base");
    // The last rounds are still in flight when the pool runs dry.
    run(&mut w, 40);
    assert!(w.actors[tank].hp < w.rules.actors[w.actors[tank].ty as usize].hp, "{id} hit the tank");
    run_until(&mut w, 2000, |w| w.heli_ammo(i).0 == max);
    run(&mut w, 40);
    (w, i, tank)
}

/// OpenRA AbortOnResupply (true for every Red Alert aircraft): out of ammo
/// the attack ends; rearmed, the helicopter does not go back for the target.
#[test]
fn rearmed_helicopters_do_not_resume_their_attack_like_openra() {
    for id in ["HELI", "HIND"] {
        let (mut w, i, tank) = heli_out_of_ammo(id, true);
        assert!(w.rules.actors[w.actors[i].ty as usize].unit.as_ref().unwrap().aircraft.as_ref().unwrap().abort_on_resupply);
        let hp = w.actors[tank].hp;
        assert_eq!(w.actors[i].target, crate::world::NONE, "{id}: the attack ended");
        run(&mut w, 300);
        assert_eq!(w.actors[tank].hp, hp, "{id}: no new attack on the tank");
    }
}

/// With AbortOnResupply false (a modded map can set it) the rearmed
/// helicopter takes its attack up again.
#[test]
fn rearmed_helicopters_resume_their_attack_without_abort_on_resupply() {
    for id in ["HELI", "HIND"] {
        let (mut w, i, tank) = heli_out_of_ammo(id, false);
        let hp = w.actors[tank].hp;
        assert_eq!(w.actors[i].activity, Activity::Attack, "{id} back on the attack");
        assert_eq!(w.actors[i].target, w.make_ref(tank));
        run(&mut w, 400);
        assert!(!w.actors[tank].alive || w.actors[tank].hp < hp, "{id} hit the tank again");
    }
}

/// OpenRA FlyAttack: attack-moves never resupply. Out of ammo the
/// helicopter flies on to the attack-move's end and picks no new targets.
#[test]
fn attack_moving_helicopters_out_of_ammo_fly_on_without_resupplying() {
    let mut w = flat_world();
    w.spawn_building(ty(&w, "HPAD"), 0, 10, 10).unwrap();
    w.update_power();
    let i = heli(&mut w, "HIND", 0, 16, 20);
    let max = w.heli_ammo(i).1;
    w.actors[i].heli.ammo_used = max - 1;
    let tank = w.spawn_unit(ty(&w, "4TNK"), 1, cell_center(22), cell_center(20), 0);
    w.actors[tank].reload = [1_000_000; crate::world::MAX_WEAPONS];
    w.queue_order(Order::Move { player: 0, ids: r(&w, i), x: cell_center(36), y: cell_center(20), attack_move: true });
    run_until(&mut w, 400, |w| w.heli_ammo(i).0 == 0);
    run_until(&mut w, 800, |w| {
        w.actors[w.actors.len() - 1].alive && dist(w.actors[i].x, w.actors[i].y, cell_center(36), cell_center(20)) <= 2 * CELL
    });
    assert_ne!(w.actors[i].heli.task, HeliTask::Resupply, "no resupply on an attack-move");
    assert_eq!(w.actors[i].target, crate::world::NONE);
    let _ = tank;
}

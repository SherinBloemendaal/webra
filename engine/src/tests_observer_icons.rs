//! The observer's icon panels and new columns (observer.rs): the Vision and
//! Derricks columns of `observer_stats`, `army_counts` (OverrideActor, build
//! icons, order) and `observer_production` (each tab's current item, the
//! time left with the low power slowdown, support powers with their icons).
//! All read only: nothing here may change the state hash.

use crate::world::{cell_center, Order, World};

/// More ticks than the vision update interval (world.rs VISION_INTERVAL).
const VISION_INTERVAL: u32 = 4;
use crate::Game;

fn ty(w: &World, id: &str) -> u16 {
    w.rules.actor_index(id).unwrap() as u16
}

fn unit(w: &mut World, id: &str, owner: u8, cx: i32, cy: i32) -> usize {
    let t = ty(w, id);
    w.spawn_unit(t, owner, cell_center(cx), cell_center(cy), 0)
}

/// 64x64 clear map without ore or neutral actors, two human players.
fn flat_world() -> World {
    let mut w = World::new(5, 64, &[("allies", false), ("soviet", false)]);
    w.clear_neutral_world();
    for i in 0..w.map.cells() {
        w.map.terrain[i] = crate::map::Terrain::Clear;
        w.map.ore[i] = 0;
        w.map.gems[i] = 0;
    }
    w.pass = crate::flowfield::Passability::new(&w.map);
    w.pass_water = crate::flowfield::Passability::water(&w.map);
    w.pass_landing = crate::flowfield::Passability::landing(&w.map);
    w.pass.refresh(&w.map);
    for p in w.players.iter_mut() {
        p.explored.iter_mut().for_each(|e| *e = 1);
    }
    w.options.ore_regrowth = false;
    w
}

fn steps(w: &mut World, n: u32) {
    for _ in 0..n {
        w.step();
    }
}

fn stats(w: &World) -> serde_json::Value {
    serde_json::from_str(&Game::wrap(w.clone()).observer_stats()).unwrap()
}

fn production(w: &World, player: u8) -> serde_json::Value {
    serde_json::from_str(&Game::wrap(w.clone()).observer_production(player)).unwrap()
}

#[test]
fn vision_is_the_share_of_cells_seen_now_rounded_up_and_zero_once_defeated() {
    let mut w = flat_world();
    let cells = w.map.cells();
    assert_eq!(cells, 4096);
    w.players[0].visible.iter_mut().for_each(|v| *v = 0);
    assert_eq!(w.vision_percent(0), 0);
    // 41 of 4096 cells is 1.0009 %: OpenRA rounds up (Math.Ceiling) to 2 %.
    for v in w.players[0].visible.iter_mut().take(41) {
        *v = 1;
    }
    assert_eq!(w.vision_percent(0), 2);
    // Exactly a quarter stays 25 %.
    for v in w.players[0].visible.iter_mut().take(1024) {
        *v = 1;
    }
    assert_eq!(w.vision_percent(0), 25);
    w.players[0].visible.iter_mut().for_each(|v| *v = 1);
    assert_eq!(w.vision_percent(0), 100);
    assert_eq!(stats(&w)[0]["vision"], 100);
    // A lost player's RevealedCells are 0.
    w.players[0].defeated = true;
    assert_eq!(w.vision_percent(0), 0);
    assert_eq!(stats(&w)[0]["vision"], 0);
    assert_eq!(w.vision_percent(9), 0, "unknown player");
}

#[test]
fn vision_follows_the_units_sight_with_fog_and_keeps_explored_cells_without_fog() {
    let mut w = flat_world();
    for p in w.players.iter_mut() {
        p.explored.iter_mut().for_each(|e| *e = 0);
    }
    unit(&mut w, "1TNK", 0, 10, 10);
    steps(&mut w, VISION_INTERVAL + 1);
    let seen = w.vision_percent(0);
    assert!(seen > 0 && seen < 10, "a tank sees a few percent of a 64x64 map: {seen}");
    // Without fog every explored cell stays visible (vision.rs), like OpenRA's
    // RevealedCells that never go down without fog.
    let mut nofog = w.clone();
    nofog.options.fog = false;
    let tank = (0..nofog.actors.len()).find(|&i| nofog.actors[i].alive && nofog.actors[i].owner == 0).unwrap();
    nofog.actors[tank].x = cell_center(40);
    nofog.actors[tank].y = cell_center(40);
    steps(&mut nofog, VISION_INTERVAL + 1);
    w.actors[tank].x = cell_center(40);
    w.actors[tank].y = cell_center(40);
    steps(&mut w, VISION_INTERVAL + 1);
    assert!(w.vision_percent(0) > 0, "the tank sees around its new place");
    assert!(nofog.vision_percent(0) > w.vision_percent(0), "fog off keeps the old view too");
}

#[test]
fn derricks_count_the_oil_derricks_a_player_owns() {
    let mut w = flat_world();
    let oilb = ty(&w, "OILB");
    assert!(w.rules.actors[oilb as usize].world.derrick, "OILB has UpdatesDerrickCount");
    assert!(!w.rules.actors[ty(&w, "POWR") as usize].world.derrick);
    w.spawn_building(oilb, 0, 10, 10).unwrap();
    w.spawn_building(oilb, 0, 20, 10).unwrap();
    w.spawn_building(oilb, 1, 30, 30).unwrap();
    assert_eq!(w.derrick_count(0), 2);
    assert_eq!(w.derrick_count(1), 1);
    let s = stats(&w);
    assert_eq!(s[0]["derricks"], 2);
    assert_eq!(s[1]["derricks"], 1);
}

#[test]
fn army_counts_use_override_actors_and_buildable_types_in_tab_and_palette_order() {
    let mut w = flat_world();
    unit(&mut w, "1TNK", 0, 5, 5);
    unit(&mut w, "E1", 0, 6, 5);
    // Paratroopers' veteran riflemen count as riflemen (UpdatesPlayerStatistics.OverrideActor).
    unit(&mut w, "E1R1", 0, 7, 5);
    unit(&mut w, "E3R1", 0, 8, 5);
    unit(&mut w, "DOG", 0, 9, 5);
    // Harvesters are not army (observer.rs army_value).
    unit(&mut w, "HARV", 0, 10, 5);
    unit(&mut w, "3TNK", 1, 40, 40);
    let e1 = ty(&w, "E1");
    let e3 = ty(&w, "E3");
    let dog = ty(&w, "DOG");
    let tank = ty(&w, "1TNK");
    assert_eq!(w.rules.actors[ty(&w, "E1R1") as usize].world.stats_actor.as_deref(), Some("E1"));
    // Infantry tab before vehicles; within a tab by BuildPaletteOrder (E1 10, E3 20, DOG 50).
    assert_eq!(w.army_counts(0), vec![(e1, 2), (e3, 1), (dog, 1), (tank, 1)]);
    let flat = Game::wrap(w.clone()).army_counts(0);
    assert_eq!(flat, vec![u32::from(e1), 2, u32::from(e3), 1, u32::from(dog), 1, u32::from(tank), 1]);
    assert_eq!(w.army_counts(1), vec![(ty(&w, "3TNK"), 1)]);
}

#[test]
fn observer_production_has_each_tabs_current_item_with_the_low_power_time_left() {
    let mut w = flat_world();
    w.players[0].cash = 20_000;
    let weap = ty(&w, "WEAP");
    let tent = ty(&w, "TENT");
    let powr = ty(&w, "APWR");
    w.spawn_building(powr, 0, 30, 30).unwrap();
    w.spawn_building(weap, 0, 10, 10).unwrap();
    w.spawn_building(tent, 0, 20, 10).unwrap();
    w.refresh_tokens();
    w.update_power();
    let tank = ty(&w, "1TNK");
    let e1 = ty(&w, "E1");
    w.queue_order(Order::StartProduction { player: 0, ty: tank, count: 2 });
    w.queue_order(Order::StartProduction { player: 0, ty: e1, count: 1 });
    for _ in 0..10 {
        w.step();
    }
    let p = production(&w, 0);
    let queues = p["queues"].as_array().unwrap();
    assert_eq!(queues.len(), 2, "one current item per tab: {p}");
    // Tab order: infantry (2) before vehicles (3).
    assert_eq!(queues[0]["id"], "E1");
    assert_eq!(queues[1]["id"], "1TNK");
    let item = &w.players[0].queues[3].items[0];
    assert_eq!(queues[1]["remainingTicks"], i64::from(item.remaining));
    assert!(queues[1]["progress"].as_f64().unwrap() > 0.0);
    assert_eq!(queues[1]["done"], false);
    assert_eq!(queues[1]["paused"], false);
    assert!(queues[1]["buildTicks"].as_i64().unwrap() > 0);
    assert_eq!(p["lowPower"], false);
    // Low power: RemainingTimeActual stretches the time left by LowPowerModifier.
    let mut low = w.clone();
    low.players[0].power_use = low.players[0].power_gen + 100;
    let lp = production(&low, 0);
    let modifier = i64::from(low.rules.player.low_power_modifier);
    assert!(modifier > 100);
    assert_eq!(lp["lowPower"], true);
    assert_eq!(lp["queues"][1]["remainingTicks"], i64::from(item.remaining) * modifier / 100);
    // On hold.
    w.queue_order(Order::PauseProduction { player: 0, ty: tank, paused: true });
    w.step();
    assert_eq!(production(&w, 0)["queues"][1]["paused"], true);
    assert!(production(&w, 9).is_null(), "unknown player");
}

#[test]
fn observer_production_lists_support_powers_with_their_icons_and_charge() {
    let mut w = flat_world();
    for k in 0..3 {
        let p = ty(&w, "APWR");
        w.spawn_building(p, 1, 30 + k * 3, 30);
    }
    let silo = ty(&w, "MSLO");
    w.spawn_building(silo, 1, 20, 20).unwrap();
    w.refresh_tokens();
    w.update_power();
    w.step();
    let p = production(&w, 1);
    let powers = p["powers"].as_array().unwrap();
    assert_eq!(powers.len(), 1, "{p}");
    assert_eq!(powers[0]["icon"], "abomb");
    assert_eq!(powers[0]["ready"], false);
    let inst = &w.powers.players[1][0];
    assert_eq!(powers[0]["remainingTicks"], inst.remaining);
    assert_eq!(powers[0]["totalTicks"], inst.total);
    assert!(production(&w, 0)["powers"].as_array().unwrap().is_empty());
}

#[test]
fn observer_queries_leave_the_state_hash_alone() {
    let mut w = flat_world();
    unit(&mut w, "1TNK", 0, 5, 5);
    w.step();
    let before = w.state_hash();
    let g = Game::wrap(w.clone());
    let _ = (g.observer_stats(), g.observer_production(0), g.army_counts(0), g.observer_report());
    assert_eq!(g.world.state_hash(), before);
    assert_eq!(w.state_hash(), before);
}

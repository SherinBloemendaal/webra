//! Tests for the sidebar's Repair and Power down buttons (repair.rs) and map
//! beacons (beacons.rs).

use crate::beacons::{arrow_height, ARROW_MAX_HEIGHT};
use crate::repair::RepairCategory;
use crate::sound_events::{SoundEventKind, EVENT_STRIDE};
use crate::world::{cell_center, Order, World, MAX_WEAPONS, NONE};
use crate::Game;

fn ty(w: &World, id: &str) -> u16 {
    w.rules.actor_index(id).unwrap() as u16
}

fn run(w: &mut World, ticks: u32) {
    for _ in 0..ticks {
        w.step();
    }
}

/// 64x64 map, players 0 and 1 (allied when `allied`) and an enemy 2 so the
/// game is not over, no AI, no ore; player 0 has plenty of power.
fn world(allied: bool) -> World {
    let mut w = World::new(7, 64, &[("allies", false), ("soviet", false), ("soviet", false)]);
    w.clear_neutral_world();
    for i in 0..w.map.cells() {
        w.map.ore[i] = 0;
    }
    w.options.ore_regrowth = false;
    if allied {
        w.players[0].team = 1;
        w.players[1].team = 1;
    }
    for k in 0..3 {
        let t = ty(&w, "APWR");
        w.spawn_building(t, 0, 2 + k * 4, 56).expect("free spot");
    }
    w.update_power();
    w
}

/// A structure of `owner` at a free spot in the middle of the map.
fn building(w: &mut World, id: &str, owner: u8, cx: i32, cy: i32) -> usize {
    let t = ty(w, id);
    w.spawn_building(t, owner, cx, cy).expect("free spot")
}

fn max_hp(w: &World, i: usize) -> i32 {
    w.rules.actors[w.actors[i].ty as usize].hp
}

fn set_cash(w: &mut World, p: u8, cash: i32) {
    w.players[p as usize].cash = cash;
    w.players[p as usize].resources = 0;
}

/// Cost of one repair step of `hp` hit points on structure `i` (OpenRA's formula).
fn step_cost(w: &World, i: usize, hp: i32) -> i32 {
    let info = &w.rules.actors[w.actors[i].ty as usize];
    let b = info.building.as_ref().unwrap();
    let r = b.repairable.as_ref().unwrap();
    ((hp as i64 * r.percent as i64 * info.sell_value() as i64) / (info.hp as i64 * 100)).max(1) as i32
}

fn events(w: &mut World, kind: SoundEventKind) -> Vec<[i32; EVENT_STRIDE]> {
    let data = w.sound.take();
    data.chunks(EVENT_STRIDE).filter(|e| e[0] == kind as i32).map(|e| e.try_into().unwrap()).collect()
}

// ---- Repair -----------------------------------------------------------------------------

#[test]
fn red_alert_repair_numbers() {
    let w = world(false);
    let r = w.rules.actors[ty(&w, "POWR") as usize].building.as_ref().unwrap().repairable.clone().expect("repairable");
    assert_eq!((r.percent, r.interval, r.step), (20, 24, 700), "RA ^Building RepairStep 700, OpenRA defaults");
    assert_eq!(r.bonuses, vec![100, 150, 175, 200, 220, 240, 260, 280, 300]);
    // Walls have no repair button; the refinery's value is its CustomSellValue.
    assert!(w.rules.actors[ty(&w, "SBAG") as usize].building.as_ref().unwrap().repairable.is_none());
    assert_eq!(w.rules.actors[ty(&w, "PROC") as usize].sell_value(), 300);
    assert_eq!(w.rules.actors[ty(&w, "TSLA") as usize].sell_value(), w.rules.actors[ty(&w, "TSLA") as usize].cost);
}

#[test]
fn repair_heals_a_step_every_interval_and_charges_per_step() {
    let mut w = world(false);
    let b = building(&mut w, "TSLA", 0, 30, 30);
    let max = max_hp(&w, b);
    w.actors[b].hp = max / 2;
    set_cash(&mut w, 0, 10_000);
    w.queue_order(Order::RepairBuilding { player: 0, building: w.make_ref(b) });
    w.step();
    // The first step comes at once, then one every interval + 1 ticks (OpenRA counts down to 0).
    let cost = step_cost(&w, b, 700);
    assert_eq!(cost, 700 * 20 * w.rules.actors[w.actors[b].ty as usize].sell_value() / (max * 100));
    assert_eq!(w.actors[b].hp, max / 2 + 700);
    assert_eq!(w.players[0].funds(), 10_000 - cost);
    assert!(w.actors[b].repair_active);
    run(&mut w, 24);
    assert_eq!(w.actors[b].hp, max / 2 + 700, "nothing during the interval");
    w.step();
    assert_eq!(w.actors[b].hp, max / 2 + 1400);
    assert_eq!(w.players[0].funds(), 10_000 - 2 * cost);
}

#[test]
fn a_full_repair_costs_about_the_repair_percent_of_the_value_and_then_stops() {
    let mut w = world(false);
    let b = building(&mut w, "TSLA", 0, 30, 30);
    let max = max_hp(&w, b);
    w.actors[b].hp = 1;
    set_cash(&mut w, 0, 10_000);
    // Expected bill: OpenRA's per step formula, summed.
    let mut hp = 1;
    let mut bill = 0;
    while hp < max {
        let step = 700.min(max - hp);
        bill += step_cost(&w, b, step);
        hp += step;
    }
    w.queue_order(Order::RepairBuilding { player: 0, building: w.make_ref(b) });
    run(&mut w, 25 * 70);
    assert_eq!(w.actors[b].hp, max);
    assert_eq!(w.players[0].funds(), 10_000 - bill);
    let value = w.rules.actors[w.actors[b].ty as usize].sell_value();
    assert!(bill * 100 >= value * 18 && bill * 100 <= value * 21, "{bill} is about 20% of {value}");
    assert!(w.actors[b].repairers.is_empty() && !w.actors[b].repair_active, "repairing ended");
    // Nothing more is charged.
    run(&mut w, 100);
    assert_eq!(w.players[0].funds(), 10_000 - bill);
}

#[test]
fn repair_waits_without_money_and_goes_on_when_there_is_some_again() {
    let mut w = world(false);
    w.sound.set_enabled(true);
    let b = building(&mut w, "TSLA", 0, 30, 30);
    let max = max_hp(&w, b);
    w.actors[b].hp = max / 4;
    let cost = step_cost(&w, b, 700);
    set_cash(&mut w, 0, cost);
    w.queue_order(Order::RepairBuilding { player: 0, building: w.make_ref(b) });
    w.step();
    assert_eq!(w.actors[b].hp, max / 4 + 700);
    assert_eq!(w.players[0].funds(), 0);
    w.sound.take();
    run(&mut w, 200);
    assert_eq!(w.actors[b].hp, max / 4 + 700, "no money, no repair");
    assert!(!w.actors[b].repair_active, "the wrench goes away");
    assert_eq!(w.actors[b].repairers, vec![0], "still repairing once there is money");
    assert!(!events(&mut w, SoundEventKind::InsufficientFunds).is_empty(), "insufficient funds");
    set_cash(&mut w, 0, 1000);
    run(&mut w, 2);
    assert_eq!(w.actors[b].hp, max / 4 + 1400, "goes on within two ticks");
    assert!(w.actors[b].repair_active);
}

#[test]
fn a_second_click_stops_repairing() {
    let mut w = world(false);
    let b = building(&mut w, "POWR", 0, 30, 30);
    let max = max_hp(&w, b);
    w.actors[b].hp = max / 2;
    w.queue_order(Order::RepairBuilding { player: 0, building: w.make_ref(b) });
    w.step();
    w.queue_order(Order::RepairBuilding { player: 0, building: w.make_ref(b) });
    w.step();
    let hp = w.actors[b].hp;
    assert!(w.actors[b].repairers.is_empty());
    run(&mut w, 100);
    assert_eq!(w.actors[b].hp, hp);
}

#[test]
fn allies_repair_together_faster_and_each_pays() {
    let mut w = world(true);
    let b = building(&mut w, "TSLA", 0, 30, 30);
    let max = max_hp(&w, b);
    w.actors[b].hp = max / 4;
    set_cash(&mut w, 0, 5000);
    set_cash(&mut w, 1, 5000);
    let cost = step_cost(&w, b, 700);
    w.queue_order(Order::RepairBuilding { player: 0, building: w.make_ref(b) });
    w.queue_order(Order::RepairBuilding { player: 1, building: w.make_ref(b) });
    w.step();
    // Two repairers: 150 percent of the step, the same cost for each.
    assert_eq!(w.actors[b].hp, max / 4 + 1050);
    assert_eq!((w.players[0].funds(), w.players[1].funds()), (5000 - cost, 5000 - cost));
    assert_eq!(w.actors[b].repairers, vec![0, 1]);
    // Only one can pay: the plain step.
    set_cash(&mut w, 1, 0);
    run(&mut w, 25);
    assert_eq!(w.actors[b].hp, max / 4 + 1050 + 700);
}

#[test]
fn enemies_cannot_repair_and_undamaged_or_wall_structures_take_no_repair() {
    let mut w = world(false);
    let b = building(&mut w, "POWR", 0, 30, 30);
    let max = max_hp(&w, b);
    // Undamaged: nothing to repair.
    w.queue_order(Order::RepairBuilding { player: 0, building: w.make_ref(b) });
    w.step();
    assert!(w.actors[b].repairers.is_empty());
    w.actors[b].hp = max / 2;
    w.queue_order(Order::RepairBuilding { player: 1, building: w.make_ref(b) });
    w.step();
    assert!(w.actors[b].repairers.is_empty(), "an enemy cannot repair it");
    let wall = building(&mut w, "SBAG", 0, 20, 20);
    w.actors[wall].hp = 1;
    w.queue_order(Order::RepairBuilding { player: 0, building: w.make_ref(wall) });
    w.step();
    assert!(w.actors[wall].repairers.is_empty(), "walls have no repair button");
    assert!(!w.can_repair_building(0, wall));
    assert!(w.can_repair_building(0, b) && !w.can_repair_building(1, b));
}

#[test]
fn repairers_who_stop_being_allies_drop_out() {
    let mut w = world(true);
    let b = building(&mut w, "POWR", 0, 30, 30);
    w.actors[b].hp = 100;
    w.queue_order(Order::RepairBuilding { player: 1, building: w.make_ref(b) });
    w.step();
    assert_eq!(w.actors[b].repairers, vec![1]);
    w.players[1].team = 2;
    run(&mut w, 30);
    assert!(w.actors[b].repairers.is_empty());
}

#[test]
fn the_repair_announcement_goes_to_the_player_who_repairs() {
    let mut w = world(true);
    w.sound.set_enabled(true);
    let b = building(&mut w, "POWR", 0, 30, 30);
    w.actors[b].hp = 100;
    w.queue_order(Order::RepairBuilding { player: 1, building: w.make_ref(b) });
    w.step();
    let ev = events(&mut w, SoundEventKind::RepairStarted);
    assert_eq!(ev.len(), 1);
    assert_eq!((ev[0][1], ev[0][4], ev[0][5]), (w.actors[b].ty as i32, 1, 0), "type, repairer, owner");
}

// ---- Power down ---------------------------------------------------------------------------

#[test]
fn powering_down_frees_the_power_and_disables_the_structure() {
    let mut w = world(false);
    let t = building(&mut w, "TSLA", 0, 30, 30);
    w.step();
    let used = w.players[0].power_use;
    let drain = -w.rules.actors[w.actors[t].ty as usize].building.as_ref().unwrap().power;
    assert!(drain > 0);
    assert!(!w.is_powered_down(t));
    w.queue_order(Order::PowerDown { player: 0, building: w.make_ref(t) });
    w.step();
    assert!(w.actors[t].powered_off);
    assert_eq!(w.players[0].power_use, used - drain, "no drain while off");
    assert!(w.is_powered_down(t), "disabled like on low power");
    w.queue_order(Order::PowerDown { player: 0, building: w.make_ref(t) });
    w.step();
    assert!(!w.actors[t].powered_off && !w.is_powered_down(t));
    assert_eq!(w.players[0].power_use, used);
}

#[test]
fn a_switched_off_defence_holds_fire() {
    let mut w = world(false);
    let t = building(&mut w, "TSLA", 0, 30, 30);
    w.queue_order(Order::PowerDown { player: 0, building: w.make_ref(t) });
    w.step();
    let tank = w.spawn_unit(ty(&w, "3TNK"), 1, cell_center(33), cell_center(31), 0);
    w.actors[tank].reload = [1_000_000; MAX_WEAPONS];
    w.update_vision();
    let hp = w.actors[tank].hp;
    run(&mut w, 150);
    assert_eq!(w.actors[tank].hp, hp, "an offline Tesla Coil does not fire");
    w.queue_order(Order::PowerDown { player: 0, building: w.make_ref(t) });
    run(&mut w, 150);
    assert!(!w.actors[tank].alive || w.actors[tank].hp < hp, "back on, it fires");
}

#[test]
fn only_the_owner_powers_down_and_only_structures_with_the_button() {
    let mut w = world(true);
    let t = building(&mut w, "TSLA", 0, 30, 30);
    let p = building(&mut w, "POWR", 0, 20, 20);
    w.queue_order(Order::PowerDown { player: 1, building: w.make_ref(t) });
    w.queue_order(Order::PowerDown { player: 0, building: w.make_ref(p) });
    w.step();
    assert!(!w.actors[t].powered_off, "an ally cannot switch it off");
    assert!(!w.actors[p].powered_off, "power plants have no power down button");
    assert!(w.can_power_down(0, t) && !w.can_power_down(1, t) && !w.can_power_down(0, p));
    let with_button: Vec<&str> =
        w.rules.actors.iter().filter(|a| a.building.as_ref().is_some_and(|b| b.power_down)).map(|a| a.id.as_str()).collect();
    for id in ["DOME", "TSLA", "AGUN", "SAM", "GAP", "PDOX", "IRON", "MSLO"] {
        assert!(with_button.contains(&id), "{id} has the power down button");
    }
    assert_eq!(with_button.len(), 8);
}

#[test]
fn a_switched_off_superweapon_stops_charging() {
    let mut w = world(false);
    // Plenty of power, so only the button switches it off.
    for k in 0..4 {
        building(&mut w, "APWR", 0, 40 + k * 4, 40);
    }
    let m = building(&mut w, "MSLO", 0, 30, 30);
    run(&mut w, 30);
    let charge = |w: &World| w.power_instances(0).iter().map(|p| p.remaining).collect::<Vec<_>>();
    let before = charge(&w);
    assert!(!before.is_empty(), "the missile silo gives a power");
    run(&mut w, 10);
    assert_ne!(charge(&w), before, "it charges");
    w.queue_order(Order::PowerDown { player: 0, building: w.make_ref(m) });
    w.step();
    let paused = charge(&w);
    run(&mut w, 50);
    assert_eq!(charge(&w), paused, "no charging while switched off");
}

#[test]
fn power_toggles_change_the_state_hash_and_replay_the_same() {
    let play = || {
        let mut w = world(false);
        let t = building(&mut w, "TSLA", 0, 30, 30);
        let b = building(&mut w, "POWR", 0, 20, 20);
        w.actors[b].hp = 1000;
        let mut hashes = Vec::new();
        for tick in 0..300u32 {
            if tick == 10 {
                w.queue_order(Order::PowerDown { player: 0, building: w.make_ref(t) });
                w.queue_order(Order::RepairBuilding { player: 0, building: w.make_ref(b) });
                w.queue_order(Order::PlaceBeacon { player: 0, x: cell_center(5), y: cell_center(5) });
            }
            w.step();
            hashes.push(w.state_hash());
        }
        hashes
    };
    let a = play();
    assert_eq!(a, play(), "deterministic");
    let mut w = world(false);
    let t = building(&mut w, "TSLA", 0, 30, 30);
    w.step();
    let h = w.state_hash();
    w.actors[t].powered_off = true;
    assert_ne!(w.state_hash(), h, "power down is simulation state");
}

#[test]
fn the_power_sounds_tell_off_from_on() {
    let mut w = world(false);
    w.sound.set_enabled(true);
    let t = building(&mut w, "TSLA", 0, 30, 30);
    w.queue_order(Order::PowerDown { player: 0, building: w.make_ref(t) });
    w.step();
    w.queue_order(Order::PowerDown { player: 0, building: w.make_ref(t) });
    w.step();
    let ev = events(&mut w, SoundEventKind::PowerToggled);
    assert_eq!(ev.iter().map(|e| e[5]).collect::<Vec<_>>(), vec![1, 0]);
}

// ---- Beacons ------------------------------------------------------------------------------

#[test]
fn a_beacon_marks_a_cell_for_allies_and_replaces_the_last_one() {
    let mut w = World::new(7, 64, &[("allies", false), ("allies", false), ("soviet", false)]);
    w.players[0].team = 1;
    w.players[1].team = 1;
    w.sound.set_enabled(true);
    w.queue_order(Order::PlaceBeacon { player: 0, x: cell_center(10) + 5, y: cell_center(12) - 7 });
    w.step();
    let seen = w.visible_beacons(1);
    assert_eq!(seen.len(), 1);
    assert_eq!((seen[0].x, seen[0].y, seen[0].owner), (cell_center(10), cell_center(12), 0), "the centre of the cell");
    assert!(w.visible_beacons(2).is_empty(), "enemies do not see it");
    let ev = events(&mut w, SoundEventKind::BeaconPlaced);
    assert_eq!(ev.len(), 1);
    assert_eq!((ev[0][2], ev[0][3], ev[0][4], ev[0][5]), (cell_center(10), cell_center(12), 0, 750));
    w.queue_order(Order::PlaceBeacon { player: 0, x: cell_center(20), y: cell_center(20) });
    w.step();
    assert_eq!(w.visible_beacons(0).len(), 1, "one beacon per player");
    assert_eq!(w.visible_beacons(0)[0].x, cell_center(20));
}

#[test]
fn a_beacon_lasts_its_duration_and_off_map_spots_are_ignored() {
    let mut w = world(false);
    w.queue_order(Order::PlaceBeacon { player: 0, x: -5, y: 10 });
    w.queue_order(Order::PlaceBeacon { player: 1, x: 10, y: i32::MAX });
    w.step();
    assert!(w.beacons.list.is_empty());
    w.queue_order(Order::PlaceBeacon { player: 0, x: cell_center(3), y: cell_center(3) });
    w.step();
    // Seen on 750 ticks: the one it was placed on and 749 more.
    run(&mut w, 749);
    assert_eq!(w.visible_beacons(0).len(), 1);
    w.step();
    assert!(w.visible_beacons(0).is_empty(), "gone after 750 ticks");
    assert!(w.beacons.list.is_empty());
}

#[test]
fn the_beacon_arrow_bounces_between_the_ground_and_its_highest_point() {
    assert_eq!(arrow_height(0), 0);
    assert_eq!(arrow_height(1), 50);
    // 5c0 is not a multiple of 50: the arrow is clamped at the top and turns.
    assert_eq!(arrow_height(102), 5100);
    assert_eq!(arrow_height(103), ARROW_MAX_HEIGHT);
    assert_eq!(arrow_height(104), ARROW_MAX_HEIGHT - 50);
    assert_eq!(arrow_height(206), 0, "back on the ground");
    assert_eq!(arrow_height(207), 50);
    assert!((0..800).all(|t| (0..=ARROW_MAX_HEIGHT).contains(&arrow_height(t))));
}

#[test]
fn beacons_stay_out_of_the_state_hash() {
    let mut a = world(false);
    let mut b = world(false);
    a.queue_order(Order::PlaceBeacon { player: 0, x: cell_center(3), y: cell_center(3) });
    a.step();
    b.step();
    assert_eq!(a.state_hash(), b.state_hash());
}

// ---- Bulk repair (WebRA addition, Order::RepairBuildings) ----------------------------------

fn refs(w: &World, ids: &[usize]) -> Vec<u32> {
    ids.iter().map(|&i| w.make_ref(i)).collect()
}

#[test]
fn bulk_repair_starts_every_damaged_own_structure_and_announces_once() {
    let mut w = world(true);
    w.sound.set_enabled(true);
    let a = building(&mut w, "POWR", 0, 20, 20);
    let b = building(&mut w, "TSLA", 0, 26, 20);
    let full = building(&mut w, "POWR", 0, 32, 20);
    let wall = building(&mut w, "SBAG", 0, 38, 20);
    let ally = building(&mut w, "POWR", 1, 20, 30);
    let enemy = building(&mut w, "POWR", 2, 30, 40);
    for i in [a, b, ally, enemy, wall] {
        w.actors[i].hp = max_hp(&w, i) / 2;
    }
    set_cash(&mut w, 0, 10_000);
    w.sound.take();
    let ids = refs(&w, &[a, b, full, wall, ally, enemy, a]);
    w.queue_order(Order::RepairBuildings { player: 0, ids });
    w.step();
    assert_eq!(w.actors[a].repairers, vec![0]);
    assert_eq!(w.actors[b].repairers, vec![0]);
    for i in [full, wall, ally, enemy] {
        assert!(w.actors[i].repairers.is_empty(), "full health, walls, allied and enemy structures are skipped");
    }
    let said = events(&mut w, SoundEventKind::RepairStarted);
    assert_eq!(said.len(), 1, "one Repairing line for the group");
    assert_eq!(said[0][4], 0, "to the player who started repairing");
}

#[test]
fn bulk_repair_stops_all_when_all_are_repairing_and_completes_a_mixed_group() {
    let mut w = world(false);
    w.sound.set_enabled(true);
    let a = building(&mut w, "POWR", 0, 20, 20);
    let b = building(&mut w, "POWR", 0, 26, 20);
    for i in [a, b] {
        w.actors[i].hp = max_hp(&w, i) / 4;
    }
    set_cash(&mut w, 0, 100_000);
    // One is repairing already: the group toggle starts the other, the first keeps going.
    w.queue_order(Order::RepairBuilding { player: 0, building: w.make_ref(a) });
    w.step();
    w.sound.take();
    w.queue_order(Order::RepairBuildings { player: 0, ids: refs(&w, &[a, b]) });
    w.step();
    assert_eq!((w.actors[a].repairers.clone(), w.actors[b].repairers.clone()), (vec![0], vec![0]));
    assert_eq!(events(&mut w, SoundEventKind::RepairStarted).len(), 1);
    // All repairing: the same order stops all, silently (Red Alert has no "stopped" line).
    w.queue_order(Order::RepairBuildings { player: 0, ids: refs(&w, &[b, a]) });
    w.step();
    assert!(w.actors[a].repairers.is_empty() && w.actors[b].repairers.is_empty());
    assert!(!w.actors[a].repair_active && !w.actors[b].repair_active);
    assert!(events(&mut w, SoundEventKind::RepairStarted).is_empty());
    let hp = (w.actors[a].hp, w.actors[b].hp);
    run(&mut w, 100);
    assert_eq!((w.actors[a].hp, w.actors[b].hp), hp, "no more repair steps");
}

#[test]
fn bulk_repair_ignores_other_players_orders_and_empty_or_stale_lists() {
    let mut w = world(true);
    let a = building(&mut w, "POWR", 0, 20, 20);
    w.actors[a].hp = max_hp(&w, a) / 2;
    // Player 1 (an ally) cannot bulk repair player 0's structure, an enemy neither.
    w.queue_order(Order::RepairBuildings { player: 1, ids: refs(&w, &[a]) });
    w.queue_order(Order::RepairBuildings { player: 2, ids: refs(&w, &[a]) });
    w.queue_order(Order::RepairBuildings { player: 0, ids: vec![] });
    w.queue_order(Order::RepairBuildings { player: 0, ids: vec![NONE, 12345] });
    w.step();
    assert!(w.actors[a].repairers.is_empty());
    // Undamaged structures only: nothing starts and nothing is charged.
    w.actors[a].hp = max_hp(&w, a);
    let cash = w.players[0].funds();
    w.queue_order(Order::RepairBuildings { player: 0, ids: refs(&w, &[a]) });
    run(&mut w, 30);
    assert!(w.actors[a].repairers.is_empty());
    assert_eq!(w.players[0].funds(), cash);
}

#[test]
fn bulk_repair_pays_per_step_like_single_repairs() {
    let mut single = world(false);
    let mut bulk = world(false);
    let mut ids = Vec::new();
    for w in [&mut single, &mut bulk] {
        let a = building(w, "TSLA", 0, 20, 20);
        let b = building(w, "POWR", 0, 26, 20);
        for i in [a, b] {
            w.actors[i].hp = max_hp(w, i) / 3;
        }
        set_cash(w, 0, 1500);
        ids = vec![a, b];
    }
    for &i in &ids {
        single.queue_order(Order::RepairBuilding { player: 0, building: single.make_ref(i) });
    }
    bulk.queue_order(Order::RepairBuildings { player: 0, ids: refs(&bulk, &ids) });
    for _ in 0..400 {
        single.step();
        bulk.step();
        assert_eq!(single.players[0].funds(), bulk.players[0].funds());
        for &i in &ids {
            assert_eq!(single.actors[i].hp, bulk.actors[i].hp);
            assert_eq!(single.actors[i].repairers, bulk.actors[i].repairers);
        }
    }
    assert!(bulk.players[0].funds() < 1500);
}

#[test]
fn bulk_repair_orders_cross_the_wire_and_are_capped() {
    let o = Order::RepairBuildings { player: 3, ids: vec![1, 2] };
    let json = serde_json::to_string(&o).unwrap();
    assert_eq!(json, r#"{"o":"repair_buildings","player":3,"ids":[1,2]}"#);
    let back: Order = serde_json::from_str(&json).unwrap();
    assert_eq!(back.player(), 3);
    assert!(o.is_reasonable());
    assert!(!Order::RepairBuildings { player: 0, ids: vec![1; 2001] }.is_reasonable());
}

fn groups(json: &str) -> serde_json::Value {
    serde_json::from_str(json).unwrap()
}

fn ids_of(v: &serde_json::Value, key: &str) -> Vec<u32> {
    v[key].as_array().unwrap().iter().map(|x| x.as_u64().unwrap() as u32).collect()
}

#[test]
fn bulk_repair_queries_for_the_selection_and_the_repair_box() {
    let mut w = world(true);
    let a = building(&mut w, "POWR", 0, 20, 20);
    let b = building(&mut w, "POWR", 0, 40, 20);
    let full = building(&mut w, "POWR", 0, 24, 20);
    let ally = building(&mut w, "POWR", 1, 20, 24);
    let tank = w.spawn_unit(ty(&w, "2TNK"), 0, cell_center(22), cell_center(28), 0);
    for i in [a, b, ally, tank] {
        w.actors[i].hp = max_hp(&w, i) / 2;
    }
    w.step();
    let mut g = Game::wrap(w);
    let r = |g: &Game, i: usize| g.world.make_ref(i);
    let sel = vec![r(&g, tank), r(&g, b), r(&g, full), r(&g, ally), r(&g, a), r(&g, b)];
    let v = groups(&g.repair_selection_json(0, sel.clone()));
    assert_eq!(ids_of(&v, "buildings"), vec![r(&g, b), r(&g, a)], "own damaged structures, in selection order, once");
    assert_eq!(ids_of(&v, "combat"), vec![r(&g, tank)]);
    assert_eq!(ids_of(&v, "noFacility"), vec![r(&g, tank)], "no service depot yet");
    let v = groups(&g.repair_selection_json(1, sel));
    assert_eq!(ids_of(&v, "buildings"), vec![r(&g, ally)], "for player 1 only their own structure");
    // A box around cells 18..30 x 18..30: a, full, ally and the tank, not b.
    let c = 24.0;
    let v = groups(&g.repair_box_json(0, 18.0 * c, 18.0 * c, 30.0 * c, 30.0 * c));
    assert_eq!((ids_of(&v, "buildings"), ids_of(&v, "combat")), (vec![r(&g, a)], vec![r(&g, tank)]));
    let v = groups(&g.repair_box_json(0, 50.0 * c, 50.0 * c, 51.0 * c, 51.0 * c));
    assert!(["buildings", "combat", "harvesters", "other", "noFacility"].iter().all(|k| ids_of(&v, k).is_empty()));
    // Through the Game API: the order queues and toggles both.
    g.repair_buildings(0, vec![r(&g, a), r(&g, b)]);
    g.world.step();
    assert_eq!((g.world.actors[a].repairers.clone(), g.world.actors[b].repairers.clone()), (vec![0], vec![0]));
}

#[test]
fn bulk_repair_sorts_units_into_combat_ore_trucks_and_other() {
    let mut w = world(false);
    let fix = building(&mut w, "FIX", 0, 30, 30);
    let spawn = |w: &mut World, id: &str, owner: u8, cx: i32| {
        let t = ty(w, id);
        let i = w.spawn_unit(t, owner, cell_center(cx), cell_center(40), 0);
        w.actors[i].hp = max_hp(w, i) / 2;
        i
    };
    let tank = spawn(&mut w, "2TNK", 0, 10);
    let harv = spawn(&mut w, "HARV", 0, 13);
    let mcv = spawn(&mut w, "MCV", 0, 16);
    let tran = spawn(&mut w, "TRAN", 0, 19);
    let rifle = spawn(&mut w, "E1", 0, 22);
    let yak = spawn(&mut w, "YAK", 0, 25);
    let enemy = spawn(&mut w, "1TNK", 1, 28);
    let healthy = spawn(&mut w, "1TNK", 0, 31);
    w.actors[healthy].hp = max_hp(&w, healthy);
    w.step();
    let all: Vec<usize> = vec![tank, harv, mcv, tran, rifle, yak, enemy, healthy, fix];
    let v = w.repair_groups_json(0, all.iter().copied());
    let r = |i: usize| w.make_ref(i);
    assert_eq!(ids_of(&v, "combat"), vec![r(tank)]);
    assert_eq!(ids_of(&v, "harvesters"), vec![r(harv)]);
    assert_eq!(ids_of(&v, "other"), vec![r(mcv), r(tran)], "MCV and the unarmed Chinook");
    assert!(ids_of(&v, "noFacility").is_empty(), "the service depot repairs them all");
    assert!(ids_of(&v, "buildings").is_empty(), "the depot is undamaged");
    // Infantry have no repair structure, WebRA planes neither, enemy and healthy units are not ours to repair.
    for i in [rifle, yak, enemy, healthy] {
        assert_eq!(w.repair_category(0, i), None);
    }
    assert_eq!(w.repair_category(0, tank), Some(RepairCategory::Combat));
}

#[test]
fn bulk_repair_sends_units_to_the_nearest_depot_like_a_click_on_it() {
    let mut w = world(false);
    let near = building(&mut w, "FIX", 0, 30, 30);
    let far = building(&mut w, "FIX", 0, 46, 30);
    let tank = w.spawn_unit(ty(&w, "2TNK"), 0, cell_center(24), cell_center(40), 0);
    let tran = w.spawn_unit(ty(&w, "TRAN"), 0, cell_center(54), cell_center(40), 0);
    let rifle = w.spawn_unit(ty(&w, "E1"), 0, cell_center(12), cell_center(42), 0);
    let healthy = w.spawn_unit(ty(&w, "1TNK"), 0, cell_center(16), cell_center(42), 0);
    for i in [tank, tran, rifle] {
        w.actors[i].hp = max_hp(&w, i) / 2;
    }
    w.step();
    let before = (w.actors[rifle].activity, w.actors[healthy].activity);
    let ids = refs(&w, &[tank, tran, rifle, healthy, tank]);
    let depot_before = w.actors[tank].depot;
    w.queue_order(Order::RepairUnits { player: 1, ids: ids.clone() });
    w.step();
    assert_eq!(w.actors[tank].depot, depot_before, "another player's order does nothing");
    w.queue_order(Order::RepairUnits { player: 0, ids });
    w.step();
    // The synthetic map may give the tank no way onto the pad (then it gives
    // up at once, as after a click on the depot); the depot it was sent to stays.
    assert_eq!(w.actors[tank].depot, w.make_ref(near), "the nearest depot");
    assert_eq!(w.actors[tran].activity, crate::world::Activity::Repair);
    assert_eq!(w.actors[tran].depot, w.make_ref(far), "the helicopter to its nearest depot");
    assert_eq!((w.actors[rifle].activity, w.actors[healthy].activity), before, "infantry and undamaged units stay");
    // The same as a click on the depot with the tank selected (OpenRA's Repair order).
    let mut a = world(false);
    let mut b = world(false);
    for x in [&mut a, &mut b] {
        building(x, "FIX", 0, 30, 30);
        let t = x.spawn_unit(ty(x, "2TNK"), 0, cell_center(10), cell_center(40), 0);
        x.actors[t].hp = max_hp(x, t) / 2;
        x.step();
    }
    let t = refs(&a, &[a.actors.len() - 1])[0];
    let d = a.actors.iter().position(|x| x.alive && x.ty == ty(&a, "FIX")).unwrap();
    a.queue_order(Order::RepairUnits { player: 0, ids: vec![t] });
    b.queue_order(Order::Smart { player: 0, ids: vec![t], x: a.actors[d].x, y: a.actors[d].y });
    for _ in 0..300 {
        a.step();
        b.step();
    }
    assert_eq!(a.state_hash(), b.state_hash());
}

#[test]
fn bulk_repair_skips_units_without_a_depot() {
    let mut w = world(false);
    let tank = w.spawn_unit(ty(&w, "2TNK"), 0, cell_center(10), cell_center(40), 0);
    w.actors[tank].hp = max_hp(&w, tank) / 2;
    w.step();
    let before = w.actors[tank].activity;
    w.queue_order(Order::RepairUnits { player: 0, ids: refs(&w, &[tank]) });
    w.step();
    assert_eq!(w.actors[tank].activity, before);
    let o = Order::RepairUnits { player: 2, ids: vec![5] };
    let json = serde_json::to_string(&o).unwrap();
    assert_eq!(json, r#"{"o":"repair_units","player":2,"ids":[5]}"#);
    assert!(!Order::RepairUnits { player: 0, ids: vec![1; 2001] }.is_reasonable());
}

// ---- Bulk sell (WebRA addition, Order::SellBuildings) ----------------------------------------

#[test]
fn bulk_sell_sells_own_sellable_structures_but_never_the_construction_yard() {
    let mut w = world(true);
    w.sound.set_enabled(true);
    let fact = building(&mut w, "FACT", 0, 20, 20);
    let a = building(&mut w, "POWR", 0, 26, 20);
    let b = building(&mut w, "TENT", 0, 30, 20);
    let ally = building(&mut w, "POWR", 1, 20, 26);
    let hosp = building(&mut w, "HOSP", 0, 26, 26);
    set_cash(&mut w, 0, 0);
    w.step();
    let mut g = Game::wrap(w);
    let r = |g: &Game, i: usize| g.world.make_ref(i);
    let c = 24.0;
    let boxed = g.sell_box(0, 18.0 * c, 18.0 * c, 34.0 * c, 30.0 * c);
    let mut sorted = boxed.clone();
    sorted.sort_unstable();
    let mut want = vec![r(&g, a), r(&g, b)];
    want.sort_unstable();
    assert_eq!(sorted, want, "no Construction Yard, no ally's structure, no unsellable Hospital");
    let refund = g.sell_value(0, r(&g, a)) + g.sell_value(0, r(&g, b));
    assert!(refund > 0);
    // The engine checks again: the yard, the ally's and the hospital stay even when listed.
    let ids = vec![r(&g, fact), r(&g, a), r(&g, ally), r(&g, hosp), r(&g, b), r(&g, a)];
    g.world.queue_order(Order::SellBuildings { player: 0, ids });
    g.world.step();
    // Each sale plays its make animation backwards first (production.rs `sell`).
    assert!(g.world.actors[a].unmake_sell && g.world.actors[b].unmake_sell);
    assert_eq!(g.world.players[0].funds(), 0, "paid at the end of each sale");
    let make = |g: &Game, i: usize| g.world.rules.actors[g.world.actors[i].ty as usize].building.as_ref().unwrap().make_ticks;
    for _ in 0..make(&g, a).max(make(&g, b)) {
        g.world.step();
    }
    let w = &g.world;
    assert!(!w.actors[a].alive && !w.actors[b].alive);
    assert!(w.actors[fact].alive && w.actors[ally].alive && w.actors[hosp].alive);
    assert_eq!(w.players[0].funds(), refund, "the refund of the two");
    // A single click still sells the Construction Yard.
    let f = r(&g, fact);
    let n = make(&g, fact);
    g.sell(0, f);
    for _ in 0..=n {
        g.world.step();
    }
    assert!(!g.world.actors[fact].alive);
}

#[test]
fn bulk_sell_ignores_other_players_and_crosses_the_wire() {
    let mut w = world(false);
    let a = building(&mut w, "POWR", 0, 26, 20);
    w.queue_order(Order::SellBuildings { player: 1, ids: refs(&w, &[a]) });
    w.step();
    assert!(w.actors[a].alive);
    let o = Order::SellBuildings { player: 1, ids: vec![3] };
    assert_eq!(serde_json::to_string(&o).unwrap(), r#"{"o":"sell_buildings","player":1,"ids":[3]}"#);
    assert!(!Order::SellBuildings { player: 0, ids: vec![1; 2001] }.is_reasonable());
}

// ---- Game API -----------------------------------------------------------------------------

#[test]
fn the_repair_cursor_and_hotkey_queries() {
    let mut w = world(false);
    let fix = building(&mut w, "FIX", 0, 30, 30);
    let powr = building(&mut w, "POWR", 0, 20, 20);
    let weap = building(&mut w, "WEAP", 0, 40, 20);
    let tent = building(&mut w, "TENT", 0, 40, 30);
    let tank = w.spawn_unit(ty(&w, "2TNK"), 0, cell_center(10), cell_center(40), 0);
    w.step();
    let mut g = Game::wrap(w);
    let r = |g: &Game, i: usize| g.world.make_ref(i);
    assert_eq!(g.repair_cursor(0, r(&g, powr)), 0, "undamaged");
    g.world.actors[powr].hp = 10;
    assert_eq!(g.repair_cursor(0, r(&g, powr)), 1);
    assert_eq!(g.repair_cursor(1, r(&g, powr)), 0, "enemy structure");
    assert_eq!(g.repair_cursor(0, r(&g, tank)), 0, "undamaged unit");
    g.world.actors[tank].hp = 10;
    assert_eq!(g.repair_cursor(0, r(&g, tank)), 2, "to the service depot");
    let target = g.repair_unit_target(0, r(&g, tank));
    assert_eq!(target, vec![crate::render::px(g.world.actors[fix].x), crate::render::px(g.world.actors[fix].y)]);
    assert!(!g.can_power_down(0, r(&g, powr)));
    // Base, production and harvester cycling.
    let bases = g.base_actors(0);
    assert!(!bases.is_empty());
    assert!(bases.iter().all(|&id| g.world.rules.actors[g.world.actors[g.world.resolve(id).unwrap()].ty as usize].base_building));
    let prod = g.production_buildings(0);
    assert!(prod.contains(&r(&g, weap)) && prod.contains(&r(&g, tent)));
    assert!(!prod.iter().any(|&id| bases.contains(&id)), "no Construction Yards");
    // Infantry before Vehicle (ordered by what they produce).
    assert!(prod.iter().position(|&id| id == r(&g, tent)) < prod.iter().position(|&id| id == r(&g, weap)));
    assert_eq!(g.queue_producer(0, crate::rules::QueueType::Vehicle as u8), r(&g, weap));
    assert_eq!(g.queue_producer(1, crate::rules::QueueType::Ship as u8), NONE);
    let harv = g.harvesters(0);
    assert!(harv.iter().all(|&id| g.world.is_harvester(g.world.resolve(id).unwrap())));
}

// ---- Spectator "All players" view (combined.rs) ----------------------------------------------

#[test]
fn the_combined_view_joins_every_players_vision_and_restores_slot_zero() {
    let mut w = world(false);
    // Player 1 has a unit far from player 0's base, player 2 nothing near it.
    let far = w.spawn_unit(ty(&w, "E1"), 1, cell_center(60), cell_center(2), 0);
    w.update_vision();
    let fogs: Vec<Vec<u8>> = (0..3)
        .map(|p| {
            let mut v = Vec::new();
            w.fog_bytes(p, &mut v);
            v
        })
        .collect();
    let mut combined = Vec::new();
    w.combined_fog_bytes(&mut combined);
    for ci in 0..w.map.cells() {
        assert_eq!(combined[ci], fogs.iter().map(|f| f[ci]).max().unwrap(), "cell {ci}");
    }
    let before = (w.players[0].visible.clone(), w.players[0].explored.clone(), w.players[0].ghosts.len());
    let mut g = Game::wrap(w);
    let all = g.build_render(crate::combined::COMBINED, 1.0, 0.0, 0.0, 64.0 * 24.0, 64.0 * 24.0);
    let own = g.build_render(0, 1.0, 0.0, 0.0, 64.0 * 24.0, 64.0 * 24.0);
    assert!(all > own, "player 1's soldier shows too ({all} > {own})");
    let w = &g.world;
    assert_eq!((w.players[0].visible.clone(), w.players[0].explored.clone(), w.players[0].ghosts.len()), before, "slot 0 is restored");
    assert!(!w.render_combined && w.actors[far].alive);
}

// ---- What the buttons look like (repair.rs, beacons.rs, render.rs) ---------------------------

fn render_for(w: &World, player: u8) -> (Vec<f32>, Vec<f32>) {
    let view = crate::render::View { x0: 0.0, y0: 0.0, x1: 64.0 * 24.0, y1: 64.0 * 24.0 };
    let (mut sprites, mut rects) = (Vec::new(), Vec::new());
    w.build_render(player, 1.0, &view, &[], &mut sprites, &mut rects);
    (sprites, rects)
}

#[test]
fn wrench_power_off_icon_and_darkening_show_on_structures() {
    use crate::render::{SpriteIds, DISABLED_SHADE, SPRITE_FLOATS};
    let mut w = world(true);
    let t = building(&mut w, "TSLA", 0, 30, 30);
    let ids = SpriteIds::new(w.rules.actors.len());
    let wrench = ids.decorations_base + crate::repair::DECORATION_WRENCH;
    let off = ids.decorations_base + crate::repair::DECORATION_POWER_OFF;
    let body = (w.actors[t].ty * 2) as f32;
    let sprites =
        |w: &World, id: f32| render_for(w, 0).0.chunks(SPRITE_FLOATS).filter(|c| c[3] == id).map(|c| c.to_vec()).collect::<Vec<_>>();
    // Ticks on which the blinking icons show (OpenRA: one frame on, one off).
    let shown = |w: &mut World| {
        while (w.tick / crate::repair::DECORATION_FRAME_TICKS) % 2 == 1 {
            w.step();
        }
    };
    w.step();
    shown(&mut w);
    assert!(sprites(&w, wrench).is_empty() && sprites(&w, off).is_empty());
    assert_eq!(sprites(&w, body).len(), 1, "powered: not darkened");
    w.queue_order(Order::PowerDown { player: 0, building: w.make_ref(t) });
    w.actors[t].hp = 100;
    w.queue_order(Order::RepairBuilding { player: 1, building: w.make_ref(t) });
    w.step();
    shown(&mut w);
    let b = sprites(&w, body);
    assert_eq!(b.len(), 2, "the body, then black over it");
    assert_eq!((b[1][6], b[1][7]), (DISABLED_SHADE, -1.0));
    let o = sprites(&w, off);
    let r = sprites(&w, wrench);
    assert_eq!((o.len(), r.len()), (1, 1));
    assert_eq!(r[0][4], 1.0, "the wrench in the repairing player's colour");
    assert!(r[0][0] < o[0][0], "side by side: wrench left, power off icon right");
    // Off frames of the power off icon's blink: the wrench alone, still at its side.
    while (w.tick / crate::repair::DECORATION_FRAME_TICKS).is_multiple_of(2) {
        w.step();
    }
    assert!(sprites(&w, off).is_empty());
    let r2 = sprites(&w, wrench);
    assert_eq!((r2.len(), r2[0][0]), (1, r[0][0]), "the wrench does not blink (OpenRA loops allyrepair)");
}

/// Allies repairing one structure together: the wrench shows steadily in
/// the colour of each repairer in turn, one per loop of the animation
/// (OpenRA WithBuildingRepairDecoration: `allyrepair` looping in the player
/// palette of `Repairers[shownPlayer]`, CycleRepairer after every loop), so
/// every repairer's colour shows. Enemies who see the structure see no wrench
/// (WithDecorationBase.ValidRelationships, default Ally).
#[test]
fn the_wrench_cycles_through_the_colours_of_every_repairer() {
    use crate::render::{SpriteIds, SPRITE_FLOATS};
    use crate::repair::DECORATION_FRAME_TICKS;
    let mut w = world(true);
    let b = building(&mut w, "TSLA", 0, 30, 30);
    w.actors[b].hp = 100;
    set_cash(&mut w, 0, 50_000);
    set_cash(&mut w, 1, 50_000);
    for p in w.players.iter_mut() {
        p.explored.iter_mut().for_each(|e| *e = 1);
    }
    w.queue_order(Order::RepairBuilding { player: 1, building: w.make_ref(b) });
    w.queue_order(Order::RepairBuilding { player: 0, building: w.make_ref(b) });
    w.step();
    assert_eq!(w.actors[b].repairers, vec![1, 0]);
    let wrench = SpriteIds::new(w.rules.actors.len()).decorations_base + crate::repair::DECORATION_WRENCH;
    // The colour (team field) of the wrench each viewer sees, or None on an off frame.
    let colour = |w: &World, viewer: u8| {
        let sprites = render_for(w, viewer).0;
        let found: Vec<f32> = sprites.chunks(SPRITE_FLOATS).filter(|c| c[3] == wrench).map(|c| c[4]).collect();
        assert!(found.len() <= 1, "one wrench at a time: {found:?}");
        found.first().copied()
    };
    // Every tick shows the wrench; within a loop the colour holds.
    let mut seen = Vec::new();
    for _ in 0..(4 * 2 * DECORATION_FRAME_TICKS) {
        w.step();
        // The enemy sees the whole map, the structure included.
        w.players[2].visible.iter_mut().for_each(|v| *v = 1);
        assert_eq!(colour(&w, 2), None, "no wrench for the enemy");
        let shown = colour(&w, 0);
        assert!(shown.is_some(), "the wrench never blinks out");
        if let Some(c) = shown {
            let cycle = w.tick / (2 * DECORATION_FRAME_TICKS);
            if seen.last().is_none_or(|&(k, _)| k != cycle) {
                seen.push((cycle, c));
            } else {
                assert_eq!(seen.last().unwrap().1, c, "one colour per cycle");
            }
            // The ally sees the same wrench.
            assert_eq!(colour(&w, 1), Some(c));
        }
    }
    let colours: Vec<f32> = seen.iter().map(|&(_, c)| c).collect();
    assert!(colours.len() >= 3, "{seen:?}");
    for pair in colours.windows(2) {
        assert_ne!(pair[0], pair[1], "the next cycle shows the next repairer: {colours:?}");
    }
    assert!(colours.contains(&0.0) && colours.contains(&1.0), "both repairers' colours: {colours:?}");
}

#[test]
fn beacons_draw_for_the_owner_and_allies_only() {
    let mut w = World::new(7, 64, &[("allies", false), ("allies", false), ("soviet", false)]);
    w.players[0].team = 1;
    w.players[1].team = 1;
    w.step();
    let before: Vec<usize> = (0..3).map(|p| render_for(&w, p).1.len()).collect();
    w.queue_order(Order::PlaceBeacon { player: 0, x: cell_center(20), y: cell_center(20) });
    w.step();
    let after: Vec<usize> = (0..3).map(|p| render_for(&w, p).1.len()).collect();
    assert!(after[0] > before[0] && after[1] > before[1], "owner and ally see it");
    assert_eq!(after[2], before[2], "an enemy does not");
}

//! Tests for the Red Alert infantry abilities (infantry.rs, infantry_combat.rs, dog.rs).

use crate::infantry::{EnterKind, DEATH_CRUSHED};
use crate::rules::Kind;
use crate::world::{cell_center, Activity, Order, SmartAction, World, MAX_WEAPONS};

fn ty(w: &World, id: &str) -> u16 {
    w.rules.actor_index(id).unwrap() as u16
}

fn run(w: &mut World, ticks: u32) {
    for _ in 0..ticks {
        w.step();
    }
}

/// 64x64 open, clear map; player 0 Allies (England), player 1 Soviets
/// (Russia); both explored everything and have their Construction Yard.
fn flat_world() -> World {
    let mut w = World::new(7, 64, &[("england", false), ("russia", false)]);
    for i in 0..w.map.cells() {
        w.map.terrain[i] = crate::map::Terrain::Clear;
        w.map.ore[i] = 0;
        w.map.gems[i] = 0;
    }
    w.pass = crate::flowfield::Passability::new(&w.map);
    w.pass_water = crate::flowfield::Passability::water(&w.map);
    for b in 0..w.building_at.len() {
        if w.building_at[b] != crate::world::NONE {
            w.pass.set_blocked(b, true);
        }
    }
    w.pass.refresh(&w.map);
    for p in w.players.iter_mut() {
        p.explored.iter_mut().for_each(|e| *e = 1);
    }
    w.options.ore_regrowth = false;
    w
}

fn unit(w: &mut World, id: &str, owner: u8, cx: i32, cy: i32) -> usize {
    let t = ty(w, id);
    w.spawn_unit(t, owner, cell_center(cx), cell_center(cy), 0)
}

/// A unit that never fires.
fn passive(w: &mut World, id: &str, owner: u8, cx: i32, cy: i32) -> usize {
    let u = unit(w, id, owner, cx, cy);
    w.actors[u].reload = [1_000_000; MAX_WEAPONS];
    u
}

fn building(w: &mut World, id: &str, owner: u8, cx: i32, cy: i32) -> usize {
    let t = ty(w, id);
    let b = w.spawn_building(t, owner, cx, cy).expect("room for the structure");
    w.refresh_tokens();
    w.update_power();
    b
}

fn smart(w: &mut World, player: u8, units: &[usize], target: usize) {
    w.update_vision();
    let ids = units.iter().map(|&u| w.make_ref(u)).collect();
    let (x, y) = (w.actors[target].x, w.actors[target].y);
    w.queue_order(Order::Smart { player, ids, x, y });
}

fn cursor(w: &mut World, player: u8, units: &[usize], target: usize) -> SmartAction {
    w.rebuild_hash();
    w.update_vision();
    let (x, y) = (w.actors[target].x, w.actors[target].y);
    w.smart_action(player, units, x, y)
}

// ---- Rules -----------------------------------------------------------------------------

#[test]
fn every_red_alert_infantry_type_is_in_the_rules() {
    let w = flat_world();
    let r = &w.rules;
    for id in ["E1", "E2", "E3", "E4", "E6", "E7", "DOG", "MEDI", "MECH", "SPY", "SPY.England", "THF", "SHOK"] {
        let a = &r.actors[r.actor_index(id).unwrap()];
        assert_eq!(a.kind, Kind::Infantry, "{id}");
    }
    let a = |id: &str| &r.actors[r.actor_index(id).unwrap()];
    // OpenRA infantry.yaml values.
    assert_eq!((a("DOG").cost, a("DOG").hp, a("DOG").build_at.as_str()), (200, 1800, "Dog"));
    assert_eq!((a("E7").cost, a("E7").build_limit), (1800, 1));
    assert_eq!((a("SPY").cost, a("SPY.England").cost), (500, 250));
    assert_eq!(a("E2").fire_delays, vec![15]);
    assert!(a("MEDI").targets_allies && a("MECH").targets_allies && !a("E1").targets_allies);
    assert!(a("E6").abilities.captures.as_ref().is_some_and(|c| c.len() == 2));
    assert!(a("SPY").abilities.disguise.is_some() && a("DOG").abilities.ignores_disguise.is_some());
    // Factions: dogs from the kennel, Shock Troopers for Russia, the British spy for England.
    let can = |f: &str, id: &str| r.obtainable[r.faction_index(f).unwrap()][r.actor_index(id).unwrap()];
    assert!(can("soviet", "DOG") && !can("allies", "DOG"));
    assert!(can("russia", "SHOK") && !can("ukraine", "SHOK"));
    assert!(can("england", "SPY.England") && can("france", "SPY") && !can("france", "SPY.England"));
    assert!(can("allies", "MEDI") && can("allies", "E7") && can("soviet", "E4") && !can("allies", "E4"));
}

// ---- Engineers ---------------------------------------------------------------------------

#[test]
fn engineer_captures_an_enemy_structure_after_the_capture_delay_and_is_used_up() {
    let mut w = flat_world();
    let barr = building(&mut w, "BARR", 1, 30, 30);
    let e6 = unit(&mut w, "E6", 0, 30, 36);
    assert_eq!(cursor(&mut w, 0, &[e6], barr), SmartAction::Capture);
    smart(&mut w, 0, &[e6], barr);
    let mut waited = 0;
    for _ in 0..600 {
        w.step();
        if w.actors[e6].inf.enter.as_ref().is_some_and(|e| e.phase == crate::infantry::EnterPhase::Wait) {
            waited += 1;
            // The captures in progress are counted at the start of each tick.
            assert!(waited < 2 || w.being_captured(barr), "being captured while the engineer waits");
            assert!(waited < 2 || !w.sell(barr), "cannot be sold while being captured");
        }
        if w.actors[barr].owner == 0 {
            break;
        }
    }
    assert_eq!(w.actors[barr].owner, 0, "captured");
    assert!(waited >= 200, "CaptureDelay 200: waited {waited} ticks");
    assert!(!w.actors[e6].alive, "the engineer went in");
    // The captured Soviet barracks keeps its faction: Soviet infantry for the Allies.
    w.refresh_tokens();
    assert!(w.can_start(0, ty(&w, "E2")), "a captured Soviet barracks trains grenadiers");
}

#[test]
fn reusable_engineers_capture_from_outside_and_stay() {
    let mut w = flat_world();
    w.options.reusable_engineers = true;
    let powr = building(&mut w, "POWR", 1, 30, 30);
    let e6 = unit(&mut w, "E6", 0, 30, 36);
    smart(&mut w, 0, &[e6], powr);
    run(&mut w, 700);
    assert_eq!(w.actors[powr].owner, 0, "captured");
    assert!(w.actors[e6].alive, "Captures@REUSABLE: ConsumedByCapture false");
    assert_eq!(w.actors[e6].activity, Activity::Idle);
}

#[test]
fn engineer_repairs_an_own_structure_and_walls_and_allies_follow_the_rules() {
    let mut w = flat_world();
    let powr = building(&mut w, "POWR", 0, 30, 30);
    let e6 = unit(&mut w, "E6", 0, 30, 36);
    assert_eq!(cursor(&mut w, 0, &[e6], powr), SmartAction::RepairBlocked, "undamaged: goldwrench-blocked");
    w.actors[powr].hp /= 3;
    assert_eq!(cursor(&mut w, 0, &[e6], powr), SmartAction::InstantRepair);
    smart(&mut w, 0, &[e6], powr);
    run(&mut w, 300);
    assert_eq!(w.actors[powr].hp, w.rules.actors[ty(&w, "POWR") as usize].hp, "fully repaired");
    assert!(!w.actors[e6].alive, "the engineer is used up");
    // Walls are not capturable.
    let wall = building(&mut w, "FENC", 1, 40, 40);
    let e6b = unit(&mut w, "E6", 0, 40, 44);
    assert!(!w.can_capture(e6b, wall));
}

#[test]
fn bridge_huts_take_engineers_while_their_bridge_is_damaged() {
    let mut w = flat_world();
    // A stand-in for a bridge hut of the world objects.
    let hut = building(&mut w, "SILO", 0, 30, 30);
    let e6 = unit(&mut w, "E6", 1, 30, 34);
    w.register_bridge_hut(hut);
    assert!(!w.can_repair_bridge(e6, hut), "bridge intact");
    w.set_bridge_hut_state(hut, true, false);
    assert!(w.order_enter(e6, hut, EnterKind::RepairBridge));
    run(&mut w, 200);
    assert!(!w.actors[e6].alive, "the engineer went in");
    assert_eq!(w.take_bridge_repairs(), vec![w.make_ref(hut)]);
    assert!(w.take_bridge_repairs().is_empty());
    assert!(w.inf.bridge_huts[0].repairing);
}

// ---- Spies and thieves -------------------------------------------------------------------

#[test]
fn thief_steals_half_the_victims_money_from_a_refinery() {
    let mut w = flat_world();
    let proc_ = building(&mut w, "PROC", 1, 30, 30);
    w.players[1].cash = 4000;
    w.players[0].cash = 0;
    let thf = unit(&mut w, "THF", 0, 31, 37);
    assert_eq!(cursor(&mut w, 0, &[thf], proc_), SmartAction::Infiltrate);
    smart(&mut w, 0, &[thf], proc_);
    run(&mut w, 300);
    assert!(!w.actors[thf].alive, "the thief went in");
    assert_eq!(w.players[1].cash, 2000, "InfiltrateForCash Percentage 50");
    assert_eq!(w.players[0].cash, 2000);
}

#[test]
fn thief_steals_a_vehicle() {
    let mut w = flat_world();
    let tank = passive(&mut w, "3TNK", 1, 30, 30);
    let thf = unit(&mut w, "THF", 0, 30, 34);
    assert_eq!(cursor(&mut w, 0, &[thf], tank), SmartAction::Capture);
    smart(&mut w, 0, &[thf], tank);
    run(&mut w, 200);
    assert_eq!(w.actors[tank].owner, 0, "stolen");
    assert!(!w.actors[thf].alive);
}

#[test]
fn spy_in_a_power_plant_cuts_the_victims_power_for_a_while() {
    let mut w = flat_world();
    let powr = building(&mut w, "POWR", 1, 30, 30);
    let spy = unit(&mut w, "SPY.England", 0, 30, 36);
    w.update_power();
    let before = w.players[1].power_gen;
    smart(&mut w, 0, &[spy], powr);
    run(&mut w, 200);
    assert!(!w.actors[spy].alive);
    assert!(w.power_outage(1) > 0, "outage running");
    assert!(w.players[1].power_gen < before, "the plant makes nothing");
    assert!(w.is_powered_down(powr));
    run(&mut w, 600);
    assert_eq!(w.power_outage(1), 0, "Duration 500");
    assert_eq!(w.players[1].power_gen, before);
}

#[test]
fn spy_in_a_barracks_makes_the_owners_infantry_veterans() {
    let mut w = flat_world();
    let barr = building(&mut w, "BARR", 1, 30, 30);
    building(&mut w, "TENT", 0, 10, 10);
    let spy = unit(&mut w, "SPY.England", 0, 30, 36);
    smart(&mut w, 0, &[spy], barr);
    run(&mut w, 200);
    assert!(w.players[0].proxies.contains(&ty(&w, "barracks.upgraded")), "the proxy goes to the spy's owner");
    let e1 = unit(&mut w, "E1", 0, 12, 18);
    assert_eq!(w.actors[e1].rank, 1, "ProducibleWithLevel barracks.upgraded");
    let e1b = unit(&mut w, "E1", 1, 40, 40);
    assert_eq!(w.actors[e1b].rank, 0, "the victim gains nothing");
}

#[test]
fn spy_in_a_sub_pen_grants_the_sonar_pulse_that_reveals_submarines() {
    let mut w = flat_world();
    for y in 40..64 {
        for x in 0..64 {
            let i = w.map.idx(x, y);
            w.map.terrain[i] = crate::map::Terrain::Water;
        }
    }
    w.pass = crate::flowfield::Passability::new(&w.map);
    w.pass_water = crate::flowfield::Passability::water(&w.map);
    let spen = w.spawn_building(ty(&w, "SPEN"), 1, 30, 40).unwrap();
    let spy = unit(&mut w, "SPY.England", 0, 31, 36);
    smart(&mut w, 0, &[spy], spen);
    run(&mut w, 200);
    let key = "SpawnActorPower";
    assert!(w.power_instances(0).iter().any(|p| p.key == key), "Sonar Pulse granted");
    let sub = unit(&mut w, "SS", 1, 50, 55);
    run(&mut w, 100);
    assert!(w.actors[sub].submerged);
    assert!(w.is_cloaked_from(sub, 0));
    w.powers.players[0].iter_mut().for_each(|p| p.remaining = 0);
    // Only on water.
    assert!(!w.activate_support_power(0, key, cell_center(10), cell_center(10), None));
    assert!(w.activate_support_power(0, key, cell_center(50), cell_center(52), None));
    run(&mut w, 2);
    assert!(!w.is_cloaked_from(sub, 0), "detected by the pulse");
    run(&mut w, 300);
    assert!(w.is_cloaked_from(sub, 0), "LifeTime 250 is over");
}

#[test]
fn spy_in_a_radar_dome_steals_and_resets_the_exploration() {
    let mut w = flat_world();
    let dome = building(&mut w, "DOME", 1, 30, 30);
    w.players[0].explored.iter_mut().for_each(|e| *e = 0);
    w.players[1].explored.iter_mut().for_each(|e| *e = 1);
    let spy = unit(&mut w, "SPY.England", 0, 30, 36);
    smart(&mut w, 0, &[spy], dome);
    run(&mut w, 200);
    assert!(!w.actors[spy].alive);
    assert!(w.players[0].explored.iter().all(|&e| e != 0), "the spy's owner learns the map");
    assert!(w.players[1].explored.iter().any(|&e| e == 0), "the victim forgets it");
}

#[test]
fn spy_in_a_superweapon_resets_its_charge() {
    let mut w = flat_world();
    let iron = building(&mut w, "IRON", 1, 30, 30);
    building(&mut w, "APWR", 1, 36, 30);
    run(&mut w, 400);
    let charge =
        |w: &World| w.power_instances(1).iter().find(|p| p.key.starts_with("GrantExternalConditionPower")).map(|p| p.remaining).unwrap();
    let before = charge(&w);
    let spy = unit(&mut w, "SPY.England", 0, 30, 35);
    smart(&mut w, 0, &[spy], iron);
    run(&mut w, 200);
    assert!(!w.actors[spy].alive);
    assert!(charge(&w) > before, "charge started over: {} > {before}", charge(&w));
}

#[test]
fn a_disguised_spy_is_left_alone_except_by_dogs() {
    let mut w = flat_world();
    let spy = passive(&mut w, "SPY.England", 0, 30, 30);
    let e1 = passive(&mut w, "E1", 1, 33, 30);
    assert_eq!(cursor(&mut w, 0, &[spy], e1), SmartAction::Disguise);
    smart(&mut w, 0, &[spy], e1);
    run(&mut w, 2);
    let d = w.actors[spy].inf.disguise.expect("disguised");
    assert_eq!((d.ty, d.owner), (ty(&w, "E1"), 1));
    assert_eq!(w.disguise_seen_by(spy, 1).map(|d| d.owner), Some(1), "the enemy sees its own rifleman");
    assert!(w.disguise_seen_by(spy, 0).is_none(), "the owner sees the spy");
    let guard = unit(&mut w, "E1", 1, 32, 30);
    let dog = unit(&mut w, "DOG", 1, 32, 31);
    assert!(!w.appears_hostile(spy, guard));
    assert!(w.appears_hostile(spy, dog), "IgnoresDisguise");
    w.rebuild_hash();
    assert_eq!(w.scan_for_target(guard), None, "the rifleman leaves its 'friend' alone");
    assert_eq!(w.scan_for_target(dog), Some(spy));
    // Attacking drops the disguise.
    w.on_fire(spy);
    assert!(w.actors[spy].inf.disguise.is_none());
}

// ---- Tanya --------------------------------------------------------------------------------

#[test]
fn tanya_blows_up_a_structure_with_c4_and_walks_out() {
    let mut w = flat_world();
    let weap = building(&mut w, "WEAP", 1, 30, 30);
    let e7 = passive(&mut w, "E7", 0, 31, 36);
    assert_eq!(cursor(&mut w, 0, &[e7], weap), SmartAction::Demolish);
    smart(&mut w, 0, &[e7], weap);
    let mut planted = None;
    for _ in 0..300 {
        w.step();
        if planted.is_none() && w.being_demolished(weap) {
            planted = Some(w.tick);
            assert!(!w.sell(weap), "cannot be sold with C4 on it");
        }
        if !w.actors[weap].alive {
            break;
        }
    }
    let planted = planted.expect("C4 planted");
    assert!(!w.actors[weap].alive, "demolished");
    assert!(w.tick >= planted + 45, "DetonationDelay 45");
    assert!(w.actors[e7].alive, "Tanya walks out again");
    run(&mut w, 60);
    assert_eq!(w.actors[e7].activity, Activity::Idle);
}

#[test]
fn iron_curtain_defuses_c4() {
    let mut w = flat_world();
    let powr = building(&mut w, "POWR", 1, 30, 30);
    let e7 = passive(&mut w, "E7", 0, 30, 35);
    w.actors[powr].invulnerable_until = 10_000;
    assert!(w.order_enter(e7, powr, EnterKind::Demolish));
    run(&mut w, 300);
    assert!(w.actors[powr].alive);
    assert!(!w.being_demolished(powr));
}

#[test]
fn only_one_tanya_at_a_time() {
    let mut w = flat_world();
    building(&mut w, "TENT", 0, 10, 10);
    building(&mut w, "WEAP", 0, 14, 10);
    building(&mut w, "DOME", 0, 18, 10);
    building(&mut w, "ATEK", 0, 22, 10);
    building(&mut w, "APWR", 0, 26, 10);
    building(&mut w, "APWR", 0, 30, 10);
    let e7 = ty(&w, "E7");
    assert!(w.can_start(0, e7));
    w.start_production(0, e7, 3);
    assert_eq!(w.players[0].queues[crate::rules::QueueType::Infantry as usize].items.len(), 1, "BuildLimit 1");
    assert!(!w.can_start(0, e7));
    w.players[0].cash = 100_000;
    run(&mut w, 2000);
    assert_eq!(w.actors.iter().filter(|a| a.alive && a.ty == e7).count(), 1);
    assert!(!w.can_start(0, e7), "while she lives");
}

// ---- Dogs, medics, mechanics -------------------------------------------------------------

#[test]
fn dog_leaps_onto_a_soldier_and_kills_it_but_ignores_tanks() {
    let mut w = flat_world();
    let dog = unit(&mut w, "DOG", 0, 30, 30);
    let tank = passive(&mut w, "3TNK", 1, 32, 30);
    let e1 = passive(&mut w, "E1", 1, 32, 32);
    let mut leapt = false;
    for _ in 0..200 {
        w.step();
        leapt |= w.actors[dog].inf.leap.is_some();
        if !w.actors[e1].alive {
            break;
        }
    }
    assert!(leapt, "the dog leapt");
    assert!(!w.actors[e1].alive, "one bite kills");
    assert_eq!(w.actors[tank].hp, w.rules.actors[ty(&w, "3TNK") as usize].hp, "dogs only bite infantry");
    assert!(w.inf.corpses.iter().any(|c| c.sequence == 1), "a DefaultDeath body (die1)");
}

#[test]
fn medic_heals_hurt_allied_infantry_and_mechanic_repairs_vehicles() {
    let mut w = flat_world();
    let medi = unit(&mut w, "MEDI", 0, 30, 30);
    let e1 = passive(&mut w, "E1", 0, 32, 30);
    let max = w.actors[e1].hp;
    w.actors[e1].hp = max / 5;
    let enemy = passive(&mut w, "E1", 1, 30, 26);
    w.actors[enemy].hp = max / 5;
    assert_eq!(cursor(&mut w, 0, &[medi], e1), SmartAction::Heal);
    run(&mut w, 300);
    assert_eq!(w.actors[e1].hp, max, "healed by the medic's AutoTarget");
    assert_eq!(w.actors[enemy].hp, max / 5, "enemies are not healed");
    let mech = unit(&mut w, "MECH", 0, 40, 40);
    let tank = passive(&mut w, "2TNK", 0, 42, 40);
    let tmax = w.actors[tank].hp;
    w.actors[tank].hp = tmax / 2;
    assert_eq!(cursor(&mut w, 0, &[mech], tank), SmartAction::Fix);
    run(&mut w, 1200);
    assert_eq!(w.actors[tank].hp, tmax, "repaired by the mechanic");
    assert_eq!(w.actors[mech].activity, Activity::Idle);
}

#[test]
fn deaths_follow_the_damage_type_and_crushing() {
    let mut w = flat_world();
    let e1 = passive(&mut w, "E1", 1, 30, 30);
    let flamer = w.rules.weapons.iter().position(|x| x.name == "Flamer").unwrap();
    let types = w.rules.weapons[flamer].warheads[0].damage_types;
    w.damage_from(e1, 1_000_000, crate::world::NONE, types);
    run(&mut w, 1);
    assert!(w.inf.corpses.iter().any(|c| c.sequence == 5), "FireDeath plays die5");
    let e1b = passive(&mut w, "E1", 1, 40, 40);
    w.note_crushed(e1b);
    w.kill(e1b);
    assert!(w.inf.corpses.iter().any(|c| c.sequence == DEATH_CRUSHED));
    run(&mut w, 200);
    assert!(w.inf.corpses.is_empty(), "bodies go away");
}

#[test]
fn grenadiers_throw_after_their_fire_delay() {
    let mut w = flat_world();
    let e2 = unit(&mut w, "E2", 0, 30, 30);
    let target = passive(&mut w, "3TNK", 1, 33, 30);
    w.queue_order(Order::Attack { player: 0, ids: vec![w.make_ref(e2)], target: w.make_ref(target) });
    let mut fired_at = None;
    let mut shot_at = None;
    for _ in 0..60 {
        w.step();
        if fired_at.is_none() && w.actors[e2].reload[0] > 0 {
            fired_at = Some(w.tick);
        }
        if shot_at.is_none() && !w.projectiles.is_empty() {
            shot_at = Some(w.tick);
        }
    }
    let (f, s) = (fired_at.expect("fired"), shot_at.expect("grenade thrown"));
    assert_eq!(s - f, 15, "FireDelay 15");
}

#[test]
fn infantry_state_is_deterministic() {
    let make = || {
        let mut w = flat_world();
        let barr = building(&mut w, "BARR", 1, 30, 30);
        let e6 = unit(&mut w, "E6", 0, 30, 36);
        unit(&mut w, "DOG", 1, 20, 20);
        unit(&mut w, "E1", 0, 22, 22);
        smart(&mut w, 0, &[e6], barr);
        w
    };
    let (mut a, mut b) = (make(), make());
    for _ in 0..400 {
        a.step();
        b.step();
        assert_eq!(a.state_hash(), b.state_hash());
    }
}

// ---- AI ------------------------------------------------------------------------------------

#[test]
fn ai_trains_dogs_and_grenadiers_within_limits() {
    let mut w = World::new(5, 64, &[("russia", true), ("england", false)]);
    w.players[0].cash = 50_000;
    run(&mut w, 25 * 60 * 8);
    let count = |id: &str| w.actors.iter().filter(|a| a.alive && a.owner == 0 && a.ty == ty(&w, id)).count();
    assert!(count("E2") > 0, "grenadiers");
    assert!(count("DOG") > 0 && count("DOG") <= 4, "dogs, UnitLimits 4: {}", count("DOG"));
    assert!(count("E1") > count("DOG"), "riflemen are the bulk");
}

#[test]
fn ai_engineers_capture_what_they_see() {
    let mut w = World::new(5, 64, &[("russia", true), ("england", false)]);
    flat_reset(&mut w);
    let powr = building(&mut w, "POWR", 1, 30, 30);
    let e6 = unit(&mut w, "E6", 0, 31, 35);
    run(&mut w, 25 * 40);
    assert_eq!(w.actors[powr].owner, 0, "captured by the AI's engineer");
    assert!(!w.actors[e6].alive);
}

fn flat_reset(w: &mut World) {
    for i in 0..w.map.cells() {
        if w.building_at[i] == crate::world::NONE {
            w.map.terrain[i] = crate::map::Terrain::Clear;
        }
    }
    w.pass = crate::flowfield::Passability::new(&w.map);
    w.pass_water = crate::flowfield::Passability::water(&w.map);
    for b in 0..w.building_at.len() {
        if w.building_at[b] != crate::world::NONE {
            w.pass.set_blocked(b, true);
        }
    }
    w.pass.refresh(&w.map);
}

// ---- Drawing ------------------------------------------------------------------------------

fn sprite_ids(w: &World, player: u8) -> Vec<(u32, f32)> {
    let view = crate::render::View { x0: 0.0, y0: 0.0, x1: 64.0 * 24.0, y1: 64.0 * 24.0 };
    let (mut sprites, mut rects) = (Vec::new(), Vec::new());
    w.build_render(player, 1.0, &view, &[], &mut sprites, &mut rects);
    sprites.chunks(crate::render::SPRITE_FLOATS).map(|s| (s[3] as u32, s[4])).collect()
}

#[test]
fn enemies_see_a_disguised_spy_as_their_own_soldier() {
    let mut w = flat_world();
    let spy = passive(&mut w, "SPY.England", 0, 30, 30);
    let e1 = passive(&mut w, "E1", 1, 31, 30);
    w.update_vision();
    w.disguise_as(spy, e1);
    let slot = |id: &str| ty(&w, id) as u32 * 2;
    let theirs = sprite_ids(&w, 1);
    assert!(!theirs.iter().any(|&(s, _)| s == slot("SPY.England")), "the enemy never sees the spy");
    assert_eq!(theirs.iter().filter(|&&(s, team)| s == slot("E1") && team == 1.0).count(), 2, "two of its own riflemen");
    assert!(sprite_ids(&w, 0).iter().any(|&(s, _)| s == slot("SPY.England")), "the owner sees the spy");
}

#[test]
fn dying_soldiers_are_drawn_with_their_death_and_original_art_gets_the_pose() {
    let mut w = flat_world();
    let e1 = passive(&mut w, "E1", 1, 30, 30);
    w.update_vision();
    let tesla = w.rules.weapons.iter().position(|x| x.name == "TeslaZap").unwrap();
    let types = w.rules.weapons[tesla].warheads[0].damage_types;
    w.damage_from(e1, 1_000_000, crate::world::NONE, types);
    let base = crate::render::SpriteIds::new(w.rules.actors.len()).infantry_base;
    let zapped = base + crate::infantry_render::SPRITE_DIE_ZAPPED;
    assert!(sprite_ids(&w, 1).iter().any(|&(s, _)| s as f32 == zapped), "built-in electrocuted body (die6)");
    w.render_opts.poses = true;
    w.render_opts.death_art = vec![true; w.rules.actors.len()];
    let posed = crate::render::posed(ty(&w, "E1") as u32 * 2, crate::render::Pose::Die6, 0) as u32;
    assert!(sprite_ids(&w, 1).iter().any(|&(s, _)| s == posed), "die6 of the original art");
}

#[test]
fn standing_soldiers_use_both_stand_sequences_and_idle_now_and_then() {
    let mut w = flat_world();
    let soldiers: Vec<usize> = (0..12).map(|k| passive(&mut w, "E1", 0, 10 + k, 20)).collect();
    let mut seen = std::collections::BTreeSet::new();
    for _ in 0..300 {
        w.tick += 1;
        for &i in &soldiers {
            seen.insert(w.infantry_stand_pose(i).0 as u32);
        }
    }
    for p in [crate::render::Pose::Idle, crate::render::Pose::Stand2, crate::render::Pose::Idle1, crate::render::Pose::Idle2] {
        assert!(seen.contains(&(p as u32)), "{p:?} shows up");
    }
}

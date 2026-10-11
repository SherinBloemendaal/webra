//! Audio events of the announcer and the actor sounds (sound_events.rs): when
//! they fire (OpenRA's triggers), to whom, and how often.

use crate::math::CELL;
use crate::rules::{Kind, QueueType};
use crate::sound_events::{self as se, SoundEventKind as K, EVENT_STRIDE};
use crate::world::{cell_center, Order, World};

fn ty(w: &World, id: &str) -> u16 {
    w.rules.actor_index(id).unwrap() as u16
}

fn run(w: &mut World, ticks: u32) {
    for _ in 0..ticks {
        w.step();
    }
}

fn events(w: &mut World) -> Vec<[i32; EVENT_STRIDE]> {
    w.sound.take().chunks(EVENT_STRIDE).map(|c| c.try_into().unwrap()).collect()
}

fn of_kind(ev: &[[i32; EVENT_STRIDE]], kind: K) -> Vec<[i32; EVENT_STRIDE]> {
    ev.iter().filter(|e| e[0] == kind as i32).copied().collect()
}

/// Run `ticks` ticks and collect every event.
fn collect(w: &mut World, ticks: u32) -> Vec<[i32; EVENT_STRIDE]> {
    let mut all = Vec::new();
    for _ in 0..ticks {
        w.step();
        all.extend(events(w));
    }
    all
}

/// 64x64 clear map, no ore, everything explored, two players without AI.
fn flat_world(factions: [&str; 2]) -> World {
    let mut w = World::new(7, 64, &[(factions[0], false), (factions[1], false)]);
    for i in 0..w.map.cells() {
        w.map.terrain[i] = crate::map::Terrain::Clear;
        w.map.ore[i] = 0;
        w.map.gems[i] = 0;
    }
    w.pass = crate::flowfield::Passability::new(&w.map);
    w.pass_water = crate::flowfield::Passability::water(&w.map);
    w.pass_landing = crate::flowfield::Passability::landing(&w.map);
    for b in 0..w.building_at.len() {
        if w.building_at[b] != crate::world::NONE {
            w.pass.set_blocked(b, true);
        }
    }
    w.pass.refresh(&w.map);
    w.options.ore_regrowth = false;
    for p in w.players.iter_mut() {
        p.cash = 100_000;
    }
    w
}

/// A structure for `player` at the first valid spot near its base.
fn place(w: &mut World, player: u8, id: &str) -> usize {
    let t = ty(w, id);
    let (sx, sy) = w.players[player as usize].start;
    for r in 3..20 {
        for dy in -r..=r {
            for dx in -r..=r {
                if w.can_place(player, t, sx + dx, sy + dy) {
                    let b = w.spawn_building(t, player, sx + dx, sy + dy).unwrap();
                    w.refresh_tokens();
                    w.update_power();
                    return b;
                }
            }
        }
    }
    panic!("no room for {id}");
}

fn unit(w: &mut World, id: &str, owner: u8, cx: i32, cy: i32) -> usize {
    let t = ty(w, id);
    w.spawn_unit(t, owner, cell_center(cx), cell_center(cy), 0)
}

// ---- Support powers -------------------------------------------------------------

#[test]
fn powers_report_charging_once_then_ready_once_like_openra() {
    let mut w = flat_world(["soviet", "allies"]);
    w.sound.set_enabled(true);
    let afld = place(&mut w, 0, "AFLD");
    let afld_t = w.actors[afld].ty as i32;
    let ev = collect(&mut w, 3);
    let charging = of_kind(&ev, K::PowerCharging);
    // The spy plane and the paratroopers (the parabombs are Ukraine's).
    let keys = w.power_instances(0).len();
    assert_eq!(keys, 2);
    assert_eq!(charging.len(), keys, "one charging event per power of the Airfield");
    assert!(charging.iter().all(|e| e[1] == afld_t && e[4] == 0), "provider type, to its owner");
    let mut indices: Vec<i32> = charging.iter().map(|e| e[5]).collect();
    indices.sort();
    let mut expected: Vec<i32> = w.power_instances(0).iter().map(|p| p.index as i32).collect();
    expected.sort();
    assert_eq!(indices, expected);
    assert!(of_kind(&collect(&mut w, 50), K::PowerCharging).is_empty(), "never again while it charges");
    // Charged: ready once.
    for inst in w.powers.players[0].iter_mut() {
        inst.remaining = 1;
    }
    let ev = collect(&mut w, 5);
    assert_eq!(of_kind(&ev, K::PowerReady).len(), keys);
    // Firing resets both: the paratroopers charge again.
    let key = "ParatroopersPower@paratroopers";
    let index = w.rules.actors[afld_t as usize].abilities.support_powers.as_ref().unwrap().iter().position(|p| p.key == key).unwrap();
    let (tx, ty_) = (cell_center(40), cell_center(40));
    w.queue_order(Order::SupportPower { player: 0, key: key.into(), x: tx, y: ty_, x2: None, y2: None });
    let ev = collect(&mut w, 2);
    let fired = of_kind(&ev, K::PowerActivated);
    assert_eq!(fired.len(), 1);
    assert_eq!(fired[0][5], se::power_ref(afld_t as u16, index), "b names the power instance");
    assert_eq!((fired[0][5] >> 8, fired[0][5] & 0xff), (afld_t, index as i32));
    let again = of_kind(&ev, K::PowerCharging);
    assert_eq!(again.len(), 1, "only the fired power charges again");
    assert_eq!(again[0][5], index as i32);
}

#[test]
fn paratroopers_announce_their_arrival_once_and_each_drop_has_a_chute() {
    let mut w = flat_world(["soviet", "allies"]);
    let afld = place(&mut w, 0, "AFLD");
    run(&mut w, 1);
    for inst in w.powers.players[0].iter_mut() {
        inst.remaining = 0;
    }
    w.sound.set_enabled(true);
    let (tx, ty_) = (cell_center(40), cell_center(40));
    w.queue_order(Order::SupportPower {
        player: 0,
        key: "ParatroopersPower@paratroopers".into(),
        x: tx,
        y: ty_,
        x2: Some(tx + 4 * CELL),
        y2: Some(ty_),
    });
    let ev = collect(&mut w, 600);
    let arrived = of_kind(&ev, K::ReinforcementsArrived);
    assert_eq!(arrived.len(), 1, "one announcement per drop");
    let afld_t = w.actors[afld].ty as i32;
    assert_eq!((arrived[0][1], arrived[0][2], arrived[0][3], arrived[0][4]), (afld_t, tx, ty_, 0));
    let chutes = of_kind(&ev, K::ParaDrop);
    assert_eq!(chutes.len(), 5, "a chute sound per paratrooper (DropItems: 5)");
    assert!(chutes.iter().all(|e| e[1] == ty(&w, "BADR") as i32 && e[4] == 0), "the Badger's ChuteSound");
}

// ---- Production -------------------------------------------------------------------

/// Player 0 with power and barracks (Allied) and plenty of cash.
fn barracks_world() -> World {
    let mut w = flat_world(["allies", "soviet"]);
    place(&mut w, 0, "POWR");
    place(&mut w, 0, "TENT");
    w
}

#[test]
fn production_on_hold_waits_and_resumes() {
    let mut w = barracks_world();
    let e1 = ty(&w, "E1");
    let q = QueueType::Infantry as usize;
    w.queue_order(Order::StartProduction { player: 0, ty: e1, count: 1 });
    run(&mut w, 10);
    let at = w.players[0].queues[q].items[0].remaining;
    let hash = w.state_hash();
    w.queue_order(Order::PauseProduction { player: 0, ty: e1, paused: true });
    run(&mut w, 1);
    assert!(w.players[0].queues[q].items[0].paused);
    assert_ne!(w.state_hash(), hash, "holding is simulation state");
    let cash = w.players[0].cash;
    run(&mut w, 100);
    assert_eq!(w.players[0].queues[q].items[0].remaining, at, "on hold from the tick of the order: no progress");
    assert_eq!(w.players[0].cash, cash, "and nothing spent");
    w.queue_order(Order::PauseProduction { player: 0, ty: e1, paused: false });
    let build = w.rules.actors[e1 as usize].build_ticks as u32;
    run(&mut w, build + 10);
    assert!(w.players[0].queues[q].items.is_empty(), "resumed and finished");
    // The order travels as JSON like every other order.
    let o: Order = serde_json::from_str(r#"{"o":"pause_production","player":0,"ty":3,"paused":true}"#).unwrap();
    assert!(matches!(o, Order::PauseProduction { player: 0, ty: 3, paused: true }));
}

#[test]
fn build_limits_hold_owned_and_queued_ones() {
    let mut w = flat_world(["soviet", "allies"]);
    let mslo = ty(&w, "MSLO");
    assert_eq!(w.rules.actors[mslo as usize].build_limit, 1, "OpenRA Buildable.BuildLimit");
    assert_eq!(w.build_limit_left(0, ty(&w, "E1")), i32::MAX, "no limit");
    // Every prerequisite met (the Construction Yard produces the Defense queue).
    w.players[0].tokens.iter_mut().for_each(|t| *t = true);
    assert_eq!(w.build_limit_left(0, mslo), 1);
    w.start_production(0, mslo, 3);
    let q = QueueType::Defense as usize;
    assert_eq!(w.players[0].queues[q].items.len(), 1, "one silo at most");
    assert_eq!(w.build_limit_left(0, mslo), 0, "the queued one counts");
    w.start_production(0, mslo, 1);
    assert_eq!(w.players[0].queues[q].items.len(), 1);
    w.cancel_production(0, mslo);
    assert_eq!(w.build_limit_left(0, mslo), 1);
    // An owned one counts too.
    let (sx, sy) = w.players[0].start;
    let spot = (sx - 10..sx + 10).flat_map(|x| (sy - 10..sy + 10).map(move |y| (x, y))).find(|&(x, y)| w.can_place(0, mslo, x, y)).unwrap();
    w.spawn_building(mslo, 0, spot.0, spot.1).unwrap();
    w.players[0].tokens.iter_mut().for_each(|t| *t = true);
    assert_eq!(w.build_limit_left(0, mslo), 0);
    w.start_production(0, mslo, 1);
    assert!(w.players[0].queues[q].items.is_empty());
    // The "all tech" cheat lifts it, as OpenRA's AllTech does.
    w.players[0].dev.all_tech = true;
    assert_eq!(w.build_limit_left(0, mslo), i32::MAX);
}

#[test]
fn unbuildable_items_are_cancelled_with_one_announcement() {
    let mut w = barracks_world();
    let e1 = ty(&w, "E1");
    w.queue_order(Order::StartProduction { player: 0, ty: e1, count: 2 });
    run(&mut w, 5);
    w.sound.set_enabled(true);
    let tent = (0..w.actors.len()).find(|&i| w.actors[i].alive && w.actors[i].ty == ty(&w, "TENT")).unwrap();
    w.kill(tent);
    let ev = collect(&mut w, 5);
    let cancelled = of_kind(&ev, K::ProductionCancelled);
    assert_eq!(cancelled.len(), 1, "once for the queue, not per item");
    assert_eq!((cancelled[0][1], cancelled[0][4]), (e1 as i32, 0));
}

#[test]
fn a_blocked_unit_is_reported_once_until_it_leaves() {
    let mut w = flat_world(["allies", "soviet"]);
    w.sound.set_enabled(true);
    w.sound.push_blocked(0, 2, 7);
    w.sound.push_blocked(0, 2, 7);
    w.sound.push_blocked(1, 2, 7);
    let ev = events(&mut w);
    assert_eq!(of_kind(&ev, K::ProductionBlocked).len(), 2, "once per player and queue");
    w.sound.unblock(0, 2);
    w.sound.push_blocked(0, 2, 7);
    assert_eq!(of_kind(&events(&mut w), K::ProductionBlocked).len(), 1, "again for the next unit");
}

#[test]
fn placing_a_structure_that_opens_new_options_says_so_ten_ticks_later() {
    let mut w = World::new(1, 80, &[("allies", false), ("soviet", false)]);
    w.players[0].cash = 100_000;
    w.sound.set_enabled(true);
    let powr = ty(&w, "POWR");
    let place_one = |w: &mut World| {
        w.queue_order(Order::StartProduction { player: 0, ty: powr, count: 1 });
        let build = w.rules.actors[powr as usize].build_ticks as u32;
        run(w, build + 5);
        let (sx, sy) = w.players[0].start;
        let spot =
            (sx - 10..sx + 10).flat_map(|x| (sy - 10..sy + 10).map(move |y| (x, y))).find(|&(x, y)| w.can_place(0, powr, x, y)).unwrap();
        w.queue_order(Order::Place { player: 0, ty: powr, cx: spot.0, cy: spot.1 });
        events(w);
    };
    place_one(&mut w);
    let soon = collect(&mut w, se::NEW_OPTIONS_DELAY - 1);
    assert!(of_kind(&soon, K::NewOptions).is_empty(), "not at once");
    let later = collect(&mut w, 3);
    let new = of_kind(&later, K::NewOptions);
    assert_eq!(new.len(), 1, "power unlocks the barracks, refinery, ...");
    assert_eq!(new[0][4], 0);
    place_one(&mut w);
    assert!(of_kind(&collect(&mut w, 20), K::NewOptions).is_empty(), "a second power plant adds nothing");
}

// ---- Repairs ----------------------------------------------------------------------------

#[test]
fn the_service_depot_announces_the_start_and_the_end_of_a_repair() {
    let mut w = flat_world(["allies", "soviet"]);
    let fix = place(&mut w, 0, "FIX");
    let fix_t = w.actors[fix].ty as i32;
    let tank = unit(&mut w, "2TNK", 0, 20, 30);
    let max = w.rules.actors[w.actors[tank].ty as usize].hp;
    w.actors[tank].hp = max / 2;
    w.sound.set_enabled(true);
    let (fx, fy) = (w.actors[fix].x, w.actors[fix].y);
    let r = w.make_ref(tank);
    w.queue_order(Order::Smart { player: 0, ids: vec![r], x: fx, y: fy });
    let ev = collect(&mut w, 25 * 60);
    assert_eq!(w.actors[tank].hp, max, "repaired");
    let start = of_kind(&ev, K::UnitRepairStarted);
    let done = of_kind(&ev, K::UnitRepaired);
    assert_eq!(start.len(), 1, "Repairing once");
    assert_eq!(done.len(), 1, "Unit repaired once");
    assert_eq!((start[0][1], start[0][4], start[0][5]), (w.actors[tank].ty as i32, 0, fix_t));
    assert_eq!((done[0][4], done[0][5]), (0, fix_t));
    // An undamaged unit sent to the depot gets no repair and no announcement.
    w.queue_order(Order::Smart { player: 0, ids: vec![r], x: fx, y: fy });
    let ev = collect(&mut w, 25 * 20);
    assert!(of_kind(&ev, K::UnitRepairStarted).is_empty() && of_kind(&ev, K::UnitRepaired).is_empty());
}

#[test]
fn minelayers_rearm_with_a_sound_per_mine() {
    let mut w = flat_world(["allies", "soviet"]);
    // Parked on the pad: only WebRA's movement model lets an idle unit stand
    // on the depot's pad (OpenRA's moves it off, movement/cellmove.rs).
    w.options.movement = crate::movement::MovementModel::WebRA;
    let fix = w.spawn_building(ty(&w, "FIX"), 0, 30, 30).unwrap();
    w.refresh_tokens();
    // Parked on the depot's pad, it reloads one mine per ReloadDelay.
    let (fx, fy) = (w.actors[fix].x, w.actors[fix].y);
    let ml = w.spawn_unit(ty(&w, "MNLY"), 0, fx, fy, 0);
    w.actors[ml].ab.ammo = 3;
    w.sound.set_enabled(true);
    let ev = collect(&mut w, 25 * 30);
    assert_eq!(w.actors[ml].ab.ammo, 5);
    let rearmed = of_kind(&ev, K::Rearmed);
    assert_eq!(rearmed.len(), 2, "two mines reloaded");
    assert!(rearmed.iter().all(|e| e[1] == ty(&w, "MNLY") as i32 && e[4] == 0));
}

// ---- Units ------------------------------------------------------------------------------------

#[test]
fn veterancy_levels_are_announced_one_by_one() {
    let mut w = flat_world(["allies", "soviet"]);
    let tank = unit(&mut w, "2TNK", 0, 20, 20);
    w.sound.set_enabled(true);
    w.give_levels(tank, 2);
    let ups = of_kind(&events(&mut w), K::LevelUp);
    assert_eq!(ups.len(), 2);
    assert!(ups.iter().all(|e| e[1] == w.actors[tank].ty as i32 && e[4] == 0));
}

#[test]
fn crushed_infantry_makes_the_crush_sound_at_the_crusher() {
    let mut w = flat_world(["allies", "soviet"]);
    let (x0, y) = (cell_center(20), cell_center(30));
    let tank = w.spawn_unit(ty(&w, "1TNK"), 0, x0, y, 256);
    let rifle = w.spawn_unit(ty(&w, "E1"), 1, x0 + 3 * CELL, y, 768);
    // Rock all around the soldier but on the tank's side: it cannot jump
    // aside (OpenRA Crushable.WarnCrush, movement/cellmove.rs).
    for (dx, dy) in [(2, -1), (3, -1), (4, -1), (2, 1), (3, 1), (4, 1), (4, 0)] {
        let i = w.map.idx(20 + dx, 30 + dy);
        w.pass.set_blocked(i, true);
    }
    w.pass.refresh(&w.map);
    w.actors[tank].reload = [1_000_000; crate::world::MAX_WEAPONS];
    w.actors[rifle].reload = [1_000_000; crate::world::MAX_WEAPONS];
    w.sound.set_enabled(true);
    let r = w.make_ref(tank);
    w.queue_order(Order::Move { player: 0, ids: vec![r], x: x0 + 3 * CELL, y, attack_move: false });
    let mut crushed = Vec::new();
    for _ in 0..25 * 6 {
        w.step();
        let ev = events(&mut w);
        for e in of_kind(&ev, K::Crushed) {
            // Where the tank was when it crushed: it may drive on in the same tick.
            let speed = w.rules.actors[w.actors[tank].ty as usize].unit.as_ref().unwrap().speed;
            assert!(crate::math::dist(e[2], e[3], w.actors[tank].x, w.actors[tank].y) <= speed, "at the crusher");
            crushed.push(e);
        }
    }
    assert!(!w.actors[rifle].alive, "run over");
    assert_eq!(crushed.len(), 1);
    assert_eq!((crushed[0][1], crushed[0][4], crushed[0][5]), (ty(&w, "E1") as i32, 1, 0));
}

#[test]
fn falling_below_half_health_is_reported_once() {
    let mut w = flat_world(["allies", "soviet"]);
    let powr = place(&mut w, 0, "POWR");
    let max = w.rules.actors[w.actors[powr].ty as usize].hp;
    w.sound.set_enabled(true);
    w.damage(powr, max / 4);
    assert!(of_kind(&events(&mut w), K::DamageHeavy).is_empty(), "still above half");
    w.damage(powr, max / 4 + 1);
    let heavy = of_kind(&events(&mut w), K::DamageHeavy);
    assert_eq!(heavy.len(), 1);
    assert_eq!((heavy[0][1], heavy[0][4]), (w.actors[powr].ty as i32, 0));
    w.damage(powr, max / 10);
    assert!(of_kind(&events(&mut w), K::DamageHeavy).is_empty(), "already heavily damaged");
    // Killed from full health in one blow: only the death.
    let other = place(&mut w, 0, "POWR");
    w.damage(other, max * 2);
    let ev = events(&mut w);
    assert!(of_kind(&ev, K::DamageHeavy).is_empty() && !of_kind(&ev, K::Death).is_empty());
}

#[test]
fn cloaking_and_uncloaking_are_heard_but_not_at_birth() {
    let mut w = flat_world(["france", "soviet"]);
    w.sound.set_enabled(true);
    let stnk = unit(&mut w, "STNK", 0, 20, 20);
    let ss = {
        // A submarine starts submerged: no sound for that.
        let t = ty(&w, "SS");
        let (x, y) = (cell_center(40), cell_center(40));
        for i in 0..w.map.cells() {
            let (cx, cy) = ((i as i32) % w.map.width, (i as i32) / w.map.width);
            if (cx - 40).abs() < 6 && (cy - 40).abs() < 6 {
                w.map.terrain[i] = crate::map::Terrain::Water;
            }
        }
        w.pass = crate::flowfield::Passability::new(&w.map);
        w.pass_water = crate::flowfield::Passability::water(&w.map);
        w.pass_landing = crate::flowfield::Passability::landing(&w.map);
        w.spawn_unit(t, 0, x, y, 0)
    };
    let ev = collect(&mut w, 130);
    let cloaks = of_kind(&ev, K::CloakChanged);
    assert_eq!(cloaks.len(), 1, "only the phase transport, after its InitialDelay");
    assert_eq!((cloaks[0][1], cloaks[0][5]), (w.actors[stnk].ty as i32, 1));
    assert!(w.actors[ss].submerged);
    w.uncloak_on(stnk, "Attack");
    w.naval_on_fire(ss);
    let off = of_kind(&events(&mut w), K::CloakChanged);
    assert_eq!(off.len(), 2);
    assert!(off.iter().all(|e| e[5] == 0), "both uncloaked");
}

#[test]
fn a_paratrooper_landing_on_a_structure_dies_with_the_impact_sound() {
    let mut w = flat_world(["allies", "soviet"]);
    let powr = place(&mut w, 1, "POWR");
    let (x, y) = (w.actors[powr].x, w.actors[powr].y);
    let p = w.spawn_unit(ty(&w, "E1"), 0, x, y, 0);
    w.actors[p].altitude = 30;
    w.actors[p].air.parachute = true;
    w.sound.set_enabled(true);
    let ev = collect(&mut w, 25);
    assert!(!w.actors[p].alive, "Parachutable KilledOnImpassableTerrain");
    let impact = of_kind(&ev, K::ParachuteImpact);
    assert_eq!(impact.len(), 1);
    assert_eq!((impact[0][1], impact[0][5]), (ty(&w, "E1") as i32, 0), "on land");
}

// ---- Events other features emit (captures, infiltration, crates, timer) ------------------------

#[test]
fn the_event_api_for_captures_infiltration_crates_primary_buildings_and_the_timer() {
    let mut w = flat_world(["allies", "soviet"]);
    w.sound.set_enabled(true);
    let (proc_t, spy_t) = (ty(&w, "PROC"), ty(&w, "E1"));
    // Captures: owner = new owner, b = old owner.
    w.sound.push(K::Captured, proc_t as i32, 100, 200, 1, 0);
    // Infiltration: owner = the target's owner, b packs the infiltrator.
    w.sound.push(K::Infiltrated, proc_t as i32, 100, 200, 0, se::infiltrator_code(spy_t, 1));
    w.sound.push(K::PrimaryBuildingSelected, proc_t as i32, 100, 200, 0, 0);
    w.sound.push(K::CrateCollected, se::crate_action_code("HealActorsCrateAction"), 300, 400, 1, 0);
    let ev = events(&mut w);
    assert_eq!(ev[0], [K::Captured as i32, proc_t as i32, 100, 200, 1, 0]);
    assert_eq!(ev[1][5] >> 8, spy_t as i32);
    assert_eq!(ev[1][5] & 0xff, 1);
    assert_eq!(ev[2][0], K::PrimaryBuildingSelected as i32);
    assert_eq!(ev[3][1], 5);
    assert_eq!(se::crate_action_code("GiveUnitCrateAction@lst"), 9, "the @suffix does not matter");
    assert_eq!(se::crate_action_code("Unknown"), 0);
    // Time limit warnings at the minutes of RA's TimeLimitWarnings, to everyone.
    let tps = crate::world::TICKS_PER_SECOND;
    w.sound.push_time_limit(40 * 60 * tps, tps);
    w.sound.push_time_limit(40 * 60 * tps - 1, tps);
    w.sound.push_time_limit(60 * tps, tps);
    let ev = of_kind(&events(&mut w), K::TimeLimitWarning);
    assert_eq!(ev.len(), 2);
    assert_eq!((ev[0][1], ev[0][4]), (40, se::ALL_PLAYERS as i32));
    assert_eq!(ev[1][1], 1);
}

#[test]
fn notification_events_stay_out_of_the_simulation() {
    // The same game with and without sound: the hash never differs, also with
    // production on hold, powers, repairs and veterancy in play (AI players).
    let mut a = World::new(9, 80, &[("allies", true), ("soviet", true)]);
    let mut b = World::new(9, 80, &[("allies", true), ("soviet", true)]);
    a.sound.set_enabled(true);
    for t in 0..2500 {
        if t == 600 {
            for w in [&mut a, &mut b] {
                let e1 = ty(w, "E1");
                w.queue_order(Order::StartProduction { player: 0, ty: e1, count: 2 });
                w.queue_order(Order::PauseProduction { player: 0, ty: e1, paused: true });
            }
        }
        a.step();
        b.step();
        a.sound.take();
    }
    assert_eq!(a.state_hash(), b.state_hash());
    assert!(a.actors.iter().any(|x| x.alive && x.kind == Kind::Building));
}

//! Audio event log (sound_events.rs): what it reports, its caps, and that it
//! never changes the simulation.

use crate::rules::QueueType;
use crate::sound_events::{SoundEventKind as K, EVENT_STRIDE, MAX_COMBAT_EVENTS, MAX_EVENTS};
use crate::world::{cell_center, Order, World};

fn ty(w: &World, id: &str) -> u16 {
    w.rules.actor_index(id).unwrap() as u16
}

fn run(w: &mut World, ticks: u32) {
    for _ in 0..ticks {
        w.step();
    }
}

/// Events as (kind, a, x, y, owner, b) tuples.
fn events(w: &mut World) -> Vec<[i32; EVENT_STRIDE]> {
    w.sound.take().chunks(EVENT_STRIDE).map(|c| c.try_into().unwrap()).collect()
}

fn has(ev: &[[i32; EVENT_STRIDE]], kind: K) -> bool {
    ev.iter().any(|e| e[0] == kind as i32)
}

fn duel(seed: u64) -> (World, usize, usize) {
    let mut w = World::new(seed, 64, &[("allies", false), ("soviet", false)]);
    let (sx, sy) = w.players[0].start;
    let t = w.spawn_unit(ty(&w, "1TNK"), 0, cell_center(sx + 6), cell_center(sy + 8), 256);
    let e = w.spawn_unit(ty(&w, "E1"), 1, cell_center(sx + 10), cell_center(sy + 8), 768);
    (w, t, e)
}

#[test]
fn audio_events_are_off_by_default() {
    let (mut w, _, _) = duel(7);
    run(&mut w, 25 * 10);
    assert!(w.sound.is_empty(), "a server or test world logs nothing");
}

#[test]
fn combat_reports_fire_impact_and_death() {
    let (mut w, t, e) = duel(7);
    w.sound.set_enabled(true);
    let tank_ty = w.actors[t].ty as i32;
    let rifle_ty = w.actors[e].ty as i32;
    let eref = w.make_ref(e);
    let mut all = Vec::new();
    for _ in 0..25 * 20 {
        w.step();
        all.extend(events(&mut w));
    }
    assert!(w.resolve(eref).is_none(), "rifleman died");
    let weapon = |name: &str| w.rules.weapons.iter().position(|x| x.name == name).unwrap() as i32;
    let fire = all.iter().find(|e| e[0] == K::Fire as i32 && e[5] == tank_ty).expect("tank fired");
    assert_eq!(fire[1], weapon("25mm"), "light tank fires its 25mm gun");
    assert_eq!(fire[4], 0, "owned by player 0");
    assert!(all.iter().any(|e| e[0] == K::Fire as i32 && e[1] == weapon("M1Carbine") && e[4] == 1), "rifleman fired back");
    assert!(has(&all, K::Impact));
    let death = all.iter().find(|e| e[0] == K::Death as i32).expect("death event");
    assert_eq!((death[1], death[4], death[5] & 0xff), (rifle_ty, 1, 1), "infantry of player 1");
    // The death sequence of the killing damage type rides along (infantry.rs):
    // the 25mm shell's ExplosionDeath plays die4.
    assert_eq!(death[5] >> 8, 4, "ExplosionDeath plays die4");
}

#[test]
fn audio_events_never_change_the_simulation() {
    let mut a = World::new(42, 80, &[("allies", true), ("soviet", true)]);
    let mut b = World::new(42, 80, &[("allies", true), ("soviet", true)]);
    a.sound.set_enabled(true);
    let mut seen = 0;
    for t in 0..3000 {
        a.step();
        b.step();
        if t % 3 == 0 {
            seen += a.sound.take().len();
        }
        if t % 250 == 0 {
            assert_eq!(a.state_hash(), b.state_hash(), "desync at tick {t}");
        }
    }
    assert_eq!(a.state_hash(), b.state_hash());
    assert!(seen > 0, "the AI game produced events");
}

#[test]
fn production_placement_and_selling_are_reported() {
    let mut w = World::new(1, 80, &[("allies", false), ("soviet", true)]);
    w.sound.set_enabled(true);
    let powr = ty(&w, "POWR");
    w.queue_order(Order::StartProduction { player: 0, ty: powr, count: 1 });
    let build = w.rules.actors[powr as usize].build_ticks as u32;
    run(&mut w, build + 5);
    let ev = events(&mut w);
    assert!(ev.iter().any(|e| e[0] == K::ConstructionReady as i32 && e[1] == powr as i32 && e[4] == 0));
    let (sx, sy) = w.players[0].start;
    let spot = (sx + 4..sx + 8).flat_map(|x| (sy - 2..sy + 6).map(move |y| (x, y))).find(|&(x, y)| w.can_place(0, powr, x, y)).unwrap();
    w.queue_order(Order::Place { player: 0, ty: powr, cx: spot.0, cy: spot.1 });
    run(&mut w, 1);
    let ev = events(&mut w);
    let placed = ev.iter().find(|e| e[0] == K::BuildingPlaced as i32).expect("placed");
    assert_eq!((placed[1], placed[4]), (powr as i32, 0));
    let b = w.actors.iter().position(|a| a.alive && a.owner == 0 && a.ty == powr).unwrap();
    let bref = w.make_ref(b);
    w.queue_order(Order::Sell { player: 0, building: bref });
    run(&mut w, 1);
    assert!(has(&events(&mut w), K::Sold));
}

#[test]
fn produced_units_and_empty_wallets_are_reported() {
    let mut w = World::new(3, 80, &[("allies", false), ("soviet", true)]);
    let (sx, sy) = w.players[0].start;
    w.spawn_building(ty(&w, "POWR"), 0, sx + 4, sy);
    w.spawn_building(ty(&w, "TENT"), 0, sx + 4, sy + 4);
    w.refresh_tokens();
    w.sound.set_enabled(true);
    let e1 = ty(&w, "E1");
    w.queue_order(Order::StartProduction { player: 0, ty: e1, count: 1 });
    let build = w.rules.actors[e1 as usize].build_ticks as u32;
    run(&mut w, build + 10);
    let ev = events(&mut w);
    assert!(ev.iter().any(|e| e[0] == K::UnitProduced as i32 && e[1] == e1 as i32 && e[4] == 0), "rifleman came out");
    // Broke: production stalls and says so, at most once a second.
    w.players[0].cash = 0;
    w.players[0].resources = 0;
    w.queue_order(Order::StartProduction { player: 0, ty: e1, count: 1 });
    run(&mut w, 25 * 3);
    let funds = events(&mut w).iter().filter(|e| e[0] == K::InsufficientFunds as i32 && e[4] == 0).count();
    assert!((2..=4).contains(&funds), "throttled insufficient funds events: {funds}");
    assert_eq!(w.players[0].queues[QueueType::Infantry as usize].items.len(), 1, "still waiting for money");
}

#[test]
fn structures_under_fire_report_once_per_burst() {
    let mut w = World::new(4, 64, &[("allies", false), ("soviet", false)]);
    let (sx, sy) = w.players[0].start;
    let p = w.spawn_building(ty(&w, "POWR"), 0, sx + 4, sy).unwrap();
    w.sound.set_enabled(true);
    w.tick = 100;
    // Player 1's fire (the attacker's owner rides along like a weapon's damage source).
    let hit = |w: &mut World| w.with_damage_source(1, |w| w.damage(p, 10));
    hit(&mut w);
    hit(&mut w);
    w.tick = 110;
    hit(&mut w);
    let n = |w: &mut World| events(w).iter().filter(|e| e[0] == K::BuildingDamaged as i32).map(|e| e[5]).collect::<Vec<_>>();
    assert_eq!(n(&mut w), vec![1], "hits close together report once, naming the attacker");
    w.tick = 110 + crate::sound_events::DAMAGE_EVENT_QUIET_TICKS;
    hit(&mut w);
    assert_eq!(n(&mut w).len(), 1, "after a quiet spell it reports again");
    // Damage without an attacker, or the owner's own, is no attack (OpenRA DamageNotifier).
    w.tick += 2 * crate::sound_events::DAMAGE_EVENT_QUIET_TICKS;
    w.damage(p, 10);
    w.tick += 2 * crate::sound_events::DAMAGE_EVENT_QUIET_TICKS;
    w.with_damage_source(0, |w| w.damage(p, 10));
    assert!(n(&mut w).is_empty());
}

#[test]
fn the_log_is_capped_and_keeps_room_for_announcements() {
    let mut w = World::new(5, 64, &[("allies", false), ("soviet", false)]);
    w.sound.set_enabled(true);
    for k in 0..MAX_EVENTS * 2 {
        w.sound.push(K::Fire, 0, k as i32, 0, 0, 0);
    }
    assert_eq!(w.sound.len(), MAX_COMBAT_EVENTS);
    w.sound.push(K::UnitProduced, 1, 0, 0, 0, 0);
    assert_eq!(w.sound.len(), MAX_COMBAT_EVENTS + 1, "announcements still fit");
    for _ in 0..MAX_EVENTS {
        w.sound.push(K::Death, 1, 0, 0, 0, 1);
    }
    assert_eq!(w.sound.len(), MAX_EVENTS);
    assert!(w.sound.dropped() > 0);
    assert_eq!(w.sound.take().len(), MAX_EVENTS * EVENT_STRIDE);
    assert!(w.sound.is_empty() && w.sound.dropped() == 0);
    w.sound.set_enabled(false);
    w.sound.push(K::Fire, 0, 0, 0, 0, 0);
    assert!(w.sound.is_empty(), "disabled log stays empty");
}

fn mcv_world() -> (World, usize) {
    use crate::world::{GameOptions, PlayerSetup, StartingUnits};
    let options = GameOptions { starting_units: StartingUnits::Mcv, ..GameOptions::default() };
    let players = [PlayerSetup::new("allies", None), PlayerSetup::new("soviet", None)];
    let w = World::with_options(7, 80, &players, options);
    let mcv_t = ty(&w, "MCV");
    let mcv = (0..w.actors.len()).find(|&i| w.actors[i].alive && w.actors[i].owner == 0 && w.actors[i].ty == mcv_t).unwrap();
    (w, mcv)
}

#[test]
fn deploying_and_packing_up_report_the_transform() {
    let (mut w, mcv) = mcv_world();
    w.sound.set_enabled(true);
    let (mcv_t, fact_t) = (ty(&w, "MCV") as i32, ty(&w, "FACT") as i32);
    let (x, y) = (w.actors[mcv].x, w.actors[mcv].y);
    let r = w.make_ref(mcv);
    w.queue_order(Order::Deploy { player: 0, ids: vec![r] });
    run(&mut w, 1);
    let ev = events(&mut w);
    let t: Vec<_> = ev.iter().filter(|e| e[0] == K::Transformed as i32).collect();
    assert_eq!(t.len(), 1, "one transform event");
    assert_eq!(*t[0], [K::Transformed as i32, mcv_t, x, y, 0, fact_t], "MCV into yard, where the MCV stood");
    assert!(!has(&ev, K::BuildingPlaced), "a deploy is not a placement");

    let fact = (0..w.actors.len()).find(|&i| w.actors[i].alive && w.actors[i].owner == 0 && w.actors[i].ty == fact_t as u16).unwrap();
    let (fx, fy) = (w.actors[fact].x, w.actors[fact].y);
    let r = w.make_ref(fact);
    w.queue_order(Order::Deploy { player: 0, ids: vec![r] });
    run(&mut w, 1);
    let ev = events(&mut w);
    let t = ev.iter().find(|e| e[0] == K::Transformed as i32).expect("packed up");
    assert_eq!(*t, [K::Transformed as i32, fact_t, fx, fy, 0, mcv_t], "yard into MCV, where the yard stood");
    assert!(!has(&ev, K::Sold), "packing up is not selling");
}

#[test]
fn a_blocked_deploy_is_reported_and_a_plain_unit_stays_silent() {
    let (mut w, mcv) = mcv_world();
    let (into, cx, cy) = w.deploy_target(mcv).unwrap();
    let cell = w.rules.actors[into as usize].building.as_ref().unwrap().cells().last().unwrap();
    assert!(w.spawn_building(ty(&w, "SBAG"), 1, cx + cell.0, cy + cell.1).is_some());
    w.sound.set_enabled(true);
    let r = w.make_ref(mcv);
    w.queue_order(Order::Deploy { player: 0, ids: vec![r] });
    run(&mut w, 1);
    let ev = events(&mut w);
    let b = ev.iter().find(|e| e[0] == K::DeployBlocked as i32).expect("blocked");
    assert_eq!((b[1], b[4]), (ty(&w, "MCV") as i32, 0));
    assert!(!has(&ev, K::Transformed));

    // A unit that cannot transform at all has nothing to report.
    let (sx, sy) = w.players[0].start;
    let tank = w.spawn_unit(ty(&w, "1TNK"), 0, cell_center(sx + 6), cell_center(sy + 8), 256);
    assert!(!w.deploy(tank));
    let ev = events(&mut w);
    assert!(!has(&ev, K::DeployBlocked) && !has(&ev, K::Transformed));
}

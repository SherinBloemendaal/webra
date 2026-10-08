//! Debug menu (debug.rs): cheat orders only work in games with the cheats
//! option, apply identically on every peer, and the debug views never change
//! the simulation.

use crate::debug::{cell, DevFlag, DEV_CASH};
use crate::world::{cell_center, Activity, GameOptions, Order, PlayerSetup, World};

fn ty(w: &World, id: &str) -> u16 {
    w.rules.actor_index(id).unwrap() as u16
}

fn run(w: &mut World, ticks: u32) {
    for _ in 0..ticks {
        w.step();
    }
}

fn world(cheats: bool) -> World {
    let players = [PlayerSetup::new("russia", None), PlayerSetup::new("england", None)];
    World::with_options(9, 64, &players, GameOptions { cheats, ..GameOptions::default() })
}

/// Every cheat the debug menu can send, as the network delivers them (JSON).
fn all_cheats(enemy_unit: u32) -> Vec<Order> {
    let mut out: Vec<Order> = DevFlag::ALL.iter().map(|&flag| Order::DevFlag { player: 0, flag, on: true }).collect();
    out.push(Order::DevCash { player: 0 });
    out.push(Order::DevKill { player: 0, ids: vec![enemy_unit] });
    out.into_iter().map(|o| serde_json::from_str(&serde_json::to_string(&o).unwrap()).unwrap()).collect()
}

fn enemy_tank(w: &mut World) -> usize {
    let (sx, sy) = w.players[1].start;
    let t = ty(w, "2TNK");
    w.spawn_unit(t, 1, cell_center(sx + 1), cell_center(sy + 5), 0)
}

#[test]
fn cheat_orders_serialize_like_the_protocol() {
    let json = |o: &Order| serde_json::to_value(o).unwrap();
    assert_eq!(
        json(&Order::DevFlag { player: 1, flag: DevFlag::DisableShroud, on: true }),
        serde_json::json!({"o": "dev_flag", "player": 1, "flag": "disable_shroud", "on": true})
    );
    assert_eq!(json(&Order::DevCash { player: 0 }), serde_json::json!({"o": "dev_cash", "player": 0}));
    assert_eq!(json(&Order::DevKill { player: 0, ids: vec![7] }), serde_json::json!({"o": "dev_kill", "player": 0, "ids": [7]}));
    for f in DevFlag::ALL {
        assert_eq!(DevFlag::from_name(f.name()), Some(f));
    }
    // Unknown flags and extra fields are refused like every other order.
    assert!(serde_json::from_str::<Order>(r#"{"o":"dev_flag","player":0,"flag":"god_mode","on":true}"#).is_err());
    assert!(serde_json::from_str::<Order>(r#"{"o":"dev_cash","player":0,"amount":1000000}"#).is_err());
    assert!(Order::DevCash { player: 0 }.is_cheat() && !Order::Stop { player: 0, ids: vec![] }.is_cheat());
    assert!(!Order::DevKill { player: 0, ids: vec![0; 2001] }.is_reasonable(), "id lists are capped");
}

#[test]
fn cheat_orders_are_ignored_without_the_cheats_option() {
    let mut w = world(false);
    let mut twin = world(false);
    let tank = enemy_tank(&mut w);
    enemy_tank(&mut twin);
    let tank_ref = w.make_ref(tank);
    for o in all_cheats(tank_ref) {
        w.queue_order(o);
    }
    run(&mut w, 30);
    run(&mut twin, 30);
    assert!(w.actors[tank].alive, "dev_kill did nothing");
    assert_eq!(w.players[0].dev, Default::default(), "no flag was set");
    assert_eq!(w.state_hash(), twin.state_hash(), "the orders changed nothing at all");
    // Fog and build area still apply.
    assert!(w.players[0].explored.contains(&0));
    let (sx, sy) = w.players[0].start;
    assert!(!w.can_place(0, ty(&w, "POWR"), sx + 25, sy + 25) || !w.can_place(0, ty(&w, "POWR"), sx - 25, sy - 25));
}

#[test]
fn cheats_apply_identically_on_every_peer() {
    let mut a = world(true);
    let mut b = world(true);
    let tank = enemy_tank(&mut a);
    enemy_tank(&mut b);
    let cash0 = a.players[0].cash;
    for o in all_cheats(a.make_ref(tank)) {
        a.queue_order(o.clone());
        b.queue_order(o);
    }
    run(&mut a, 1);
    run(&mut b, 1);
    assert_eq!(a.state_hash(), b.state_hash());

    // Give cash and kill.
    assert_eq!(a.players[0].cash, cash0 + DEV_CASH);
    assert!(!a.actors[tank].alive, "the enemy tank was destroyed");
    // Every flag is on for player 0 only.
    for f in DevFlag::ALL {
        assert!(a.players[0].dev.get(f), "{}", f.name());
        assert!(!a.players[1].dev.get(f), "{} stays off for the other player", f.name());
    }
    // Disable shroud: the whole map is visible, also after the next vision update.
    run(&mut a, 3);
    run(&mut b, 3);
    assert!(a.players[0].visible.iter().all(|&v| v != 0) && a.players[0].explored.iter().all(|&e| e != 0));
    assert!(a.players[1].explored.contains(&0), "the other player still has shroud");

    // Instant build: a structure that takes many ticks is done on the next one, and paid in full.
    let msl = ty(&a, "MSLO");
    assert!(a.availability(0, msl).enabled, "all tech: the missile silo needs no tech center");
    assert!(!a.availability(1, msl).enabled, "the other player has no all tech");
    let cash = a.players[0].cash;
    for w in [&mut a, &mut b] {
        w.queue_order(Order::StartProduction { player: 0, ty: msl, count: 1 });
        run(w, 2);
    }
    let item = a.players[0].queues[a.rules.actors[msl as usize].queue as usize].items[0].clone();
    assert!(item.done, "built at once, {} ticks left", item.remaining);
    assert_eq!(cash - a.players[0].cash, a.rules.actors[msl as usize].cost, "instant build still costs money");

    // Build anywhere: far from the base on open ground (explored thanks to disable shroud).
    let (sx, sy) = a.players[0].start;
    let spot = (0..a.map.height)
        .flat_map(|y| (0..a.map.width).map(move |x| (x, y)))
        .filter(|&(x, y)| (x - sx).abs() + (y - sy).abs() > 20)
        .find(|&(x, y)| a.can_place(0, msl, x, y))
        .expect("a free spot far from the base");
    for w in [&mut a, &mut b] {
        w.queue_order(Order::Place { player: 0, ty: msl, cx: spot.0, cy: spot.1 });
        run(w, 2);
    }
    assert_ne!(a.building_at[a.map.idx(spot.0, spot.1)], crate::world::NONE, "placed far away");

    // Unlimited power: far more drain than output, yet never low power.
    for _ in 0..4 {
        let (x, y) =
            (0..a.map.height).flat_map(|y| (0..a.map.width).map(move |x| (x, y))).find(|&(x, y)| a.can_place(0, msl, x, y)).unwrap();
        a.spawn_building(msl, 0, x, y);
        b.spawn_building(msl, 0, x, y);
    }
    run(&mut a, 2);
    run(&mut b, 2);
    assert!(a.players[0].power_use > a.players[0].power_gen, "drain {} > output {}", a.players[0].power_use, a.players[0].power_gen);
    assert!(!a.players[0].low_power(), "unlimited power");

    // Instant charge: the nuke is ready as soon as the silo provides it.
    let nuke = a.power_instances(0).iter().find(|p| p.key == "NukePower").cloned().expect("the silo provides the nuke");
    assert!(nuke.ready(), "instant charge: {nuke:?}");

    // Switching a flag off again works the same way.
    for w in [&mut a, &mut b] {
        w.queue_order(Order::DevFlag { player: 0, flag: DevFlag::UnlimitedPower, on: false });
        run(w, 1);
    }
    assert!(a.players[0].low_power(), "power cheat off: low power again");
    for _ in 0..200 {
        a.step();
        b.step();
    }
    assert_eq!(a.state_hash(), b.state_hash(), "peers that applied the same cheats stay in sync");
}

#[test]
fn give_cash_is_capped_and_neutral_players_cannot_cheat() {
    let mut w = world(true);
    w.players[0].cash = crate::debug::DEV_CASH_MAX - 5;
    w.queue_order(Order::DevCash { player: 0 });
    w.queue_order(Order::DevCash { player: 9 });
    w.queue_order(Order::DevFlag { player: 200, flag: DevFlag::FastBuild, on: true });
    w.queue_order(Order::DevKill { player: 0, ids: vec![crate::world::NONE, 0x00ff_ffff, 12345] });
    run(&mut w, 1);
    assert_eq!(w.players[0].cash, crate::debug::DEV_CASH_MAX);
}

#[test]
fn debug_views_never_change_the_simulation() {
    let mut a = world(true);
    let mut b = world(true);
    let (sx, sy) = a.players[0].start;
    let t = ty(&a, "1TNK");
    let tank = a.spawn_unit(t, 0, cell_center(sx + 1), cell_center(sy + 5), 0);
    b.spawn_unit(t, 0, cell_center(sx + 1), cell_center(sy + 5), 0);
    let goal = (sx + 12, sy + 12);
    for w in [&mut a, &mut b] {
        w.order_move(&[tank], cell_center(goal.0), cell_center(goal.1), false);
        run(w, 3);
    }
    let id = a.make_ref(tank);
    assert_eq!(a.actors[tank].activity, Activity::Move);
    for _ in 0..50 {
        let (x0, y0, w0, h0, cells) = a.debug_cells(0, -5, -5, 200, 200);
        assert_eq!((x0, y0, w0, h0), (0, 0, a.map.width, a.map.height), "clamped to the map");
        assert_eq!(cells.len(), (a.map.width * a.map.height) as usize);
        let flow = a.debug_flow(0, id, 0, 0, a.map.width, a.map.height);
        let _ = a.debug_stats();
        a.step();
        b.step();
        if a.actors[tank].activity == Activity::Move {
            let (g, _, _, w, h, dirs) = flow.expect("a moving unit follows a cached field");
            assert_eq!(g, a.actors[tank].goal);
            assert_eq!(dirs.len(), (w * h) as usize);
        }
    }
    assert_eq!(a.state_hash(), b.state_hash(), "reading debug views changed nothing");
    assert_eq!(a.flow.computed, b.flow.computed, "the flow view never computes fields");

    // Cells report occupancy only where the player may see it.
    let (x0, y0, w, _, cells) = a.debug_cells(0, 0, 0, a.map.width, a.map.height);
    let at = |x: i32, y: i32| cells[((y - y0) * w + (x - x0)) as usize];
    assert_ne!(at(sx, sy) & cell::FOOTPRINT, 0, "own construction yard footprint");
    let (ex, ey) = a.players[1].start;
    assert_eq!(at(ex, ey), 0, "the enemy base is under the shroud");
    // Another player's unit has no flow view, nor has an unknown id.
    assert!(a.debug_flow(1, id, 0, 0, 10, 10).is_none());
    assert!(a.debug_flow(0, crate::world::NONE, 0, 0, 10, 10).is_none());
}

#[test]
fn hostile_cheat_orders_never_crash_a_cheat_game() {
    let mut w = world(true);
    let mut r = crate::rng::Rng::new(0xdeb);
    for _ in 0..400 {
        let refs: Vec<u32> = (0..w.actors.len()).filter(|&i| w.actors[i].alive).map(|i| w.make_ref(i)).collect();
        for _ in 0..r.range(0, 4) {
            let player = r.range(0, 4) as u8;
            let o = match r.range(0, 3) {
                0 => Order::DevFlag { player, flag: DevFlag::ALL[r.range(0, 6) as usize], on: r.chance(70) },
                1 => Order::DevCash { player },
                _ => Order::DevKill {
                    player,
                    ids: (0..r.range(0, 5))
                        .map(|_| {
                            if refs.is_empty() || r.chance(30) {
                                r.next_u64() as u32
                            } else {
                                refs[r.range(0, refs.len() as i32) as usize]
                            }
                        })
                        .collect(),
                },
            };
            w.queue_order(o);
        }
        // Keep both sides busy so killing, building and powers interact.
        if r.chance(10) {
            w.queue_order(Order::StartProduction { player: 0, ty: ty(&w, "E1"), count: 3 });
            w.queue_order(Order::StartProduction { player: 1, ty: ty(&w, "POWR"), count: 1 });
        }
        w.step();
    }
}

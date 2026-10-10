//! End-game statistics (observer.rs): counters, the history time series,
//! determinism and the state hash, defeat bookkeeping and refused orders of
//! defeated players.

use crate::observer::STATS_SAMPLE_TICKS;
use crate::rules::Kind;
use crate::world::{cell_center, AiDifficulty, GameOptions, Order, PlayerSetup, World, MAX_WEAPONS};
use crate::Game;

fn ty(w: &World, id: &str) -> u16 {
    w.rules.actor_index(id).unwrap() as u16
}

fn run(w: &mut World, ticks: u32) {
    for _ in 0..ticks {
        w.step();
    }
}

fn unit(w: &mut World, id: &str, owner: u8, cx: i32, cy: i32) -> usize {
    let t = ty(w, id);
    w.spawn_unit(t, owner, cell_center(cx), cell_center(cy), 0)
}

fn refs(w: &World, v: &[usize]) -> Vec<u32> {
    v.iter().map(|&u| w.make_ref(u)).collect()
}

/// 64x64 open map without ore, two human players that explored everything.
fn flat_world() -> World {
    let mut w = World::new(11, 64, &[("allies", false), ("soviet", false)]);
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

fn ai_world(seed: u64) -> World {
    let players: Vec<PlayerSetup> = ["allies", "soviet"]
        .iter()
        .map(|f| PlayerSetup { faction: (*f).into(), ai: Some(AiDifficulty::Hard), bot: Default::default(), team: 0, handicap: 0 })
        .collect();
    World::with_options(seed, 64, &players, GameOptions::default())
}

fn report(w: &World) -> serde_json::Value {
    serde_json::from_str(&Game::wrap(w.clone()).observer_report()).unwrap()
}

#[test]
fn history_samples_on_tick_one_and_every_interval() {
    let mut w = ai_world(3);
    run(&mut w, STATS_SAMPLE_TICKS * 4 + 10);
    let h = &w.observer.history;
    assert_eq!(h.interval, STATS_SAMPLE_TICKS, "5 s of game time");
    assert_eq!(STATS_SAMPLE_TICKS, 125);
    let want: Vec<u32> = std::iter::once(1).chain((1..=4).map(|k| k * STATS_SAMPLE_TICKS)).collect();
    assert_eq!(h.ticks, want);
    for p in 0..2 {
        assert_eq!(h.samples[p].len(), want.len(), "player {p}: one sample per tick");
    }
    // The last sample matches the counters at that tick's end.
    let r = report(&w);
    let series = &r["history"]["players"][0];
    assert_eq!(series["funds"].as_array().unwrap().len(), want.len());
    assert_eq!(r["history"]["interval"], STATS_SAMPLE_TICKS);
    assert_eq!(r["history"]["ticks"].as_array().unwrap().len(), want.len());
    assert!(r["players"][0]["productionTicks"].as_array().unwrap().len() == crate::rules::QUEUE_COUNT);
}

#[test]
fn history_and_counters_are_deterministic_and_outside_the_state_hash() {
    // Same game, different sampling intervals: identical state hashes every
    // tick (the statistics never feed back into the simulation).
    let mut a = ai_world(9);
    let mut b = ai_world(9);
    b.observer.history.interval = 7;
    let mut c = ai_world(9);
    for t in 0..3000 {
        a.step();
        b.step();
        c.step();
        assert_eq!(a.state_hash(), b.state_hash(), "tick {t}");
    }
    assert!(b.observer.history.ticks.len() > a.observer.history.ticks.len(), "the shorter interval sampled more");
    // Two runs of the same game (peers, a replay): identical statistics.
    assert_eq!(report(&a), report(&c));
    assert_eq!(a.observer.history.samples, c.observer.history.samples);
    // Wiping the statistics does not change the hash either.
    let h = a.state_hash();
    a.observer = Default::default();
    assert_eq!(a.state_hash(), h);
    // A busy AI game spends, builds and fights.
    let s = c.player_stats(0);
    assert!(s.spent > 0 && s.built_value > 0 && s.buildings_built > 0, "{s:?}");
    assert!(s.production_ticks.iter().sum::<u32>() > 0);
}

#[test]
fn replayed_orders_reproduce_the_statistics_exactly() {
    // A recorded game (orders through `apply_frame`) and its replay.
    let make = || {
        let mut g = Game::wrap(flat_world());
        g.set_lockstep(true);
        g
    };
    let mut live = make();
    let tanks: Vec<usize> = (0..3).map(|k| unit(&mut live.world, "2TNK", 0, 10 + k, 10)).collect();
    let mut frames: Vec<(u32, String)> = Vec::new();
    for t in 0..600u32 {
        if t % 100 == 5 {
            let ids = refs(&live.world, &tanks);
            let o = Order::Move { player: 0, ids, x: cell_center(20 + (t / 100) as i32 * 3), y: cell_center(30), attack_move: false };
            let frame = serde_json::to_string(&vec![(0u8, vec![serde_json::to_value(&o).unwrap()])]).unwrap();
            frames.push((t, frame));
        }
        if let Some((_, f)) = frames.iter().find(|(ft, _)| *ft == t) {
            live.apply_frame(f).unwrap();
        }
        live.tick();
    }
    let mut copy = make();
    for k in 0..3 {
        unit(&mut copy.world, "2TNK", 0, 10 + k, 10);
    }
    for t in 0..600u32 {
        if let Some((_, f)) = frames.iter().find(|(ft, _)| *ft == t) {
            copy.apply_frame(f).unwrap();
        }
        copy.tick();
    }
    assert_eq!(live.world.state_hash(), copy.world.state_hash());
    assert_eq!(live.observer_report(), copy.observer_report());
    assert_eq!(live.world.player_stats(0).orders, 6, "every logged order counts (actions per minute)");
    let r: serde_json::Value = serde_json::from_str(&live.observer_report()).unwrap();
    let orders = r["history"]["players"][0]["orders"].as_array().unwrap();
    assert_eq!(orders.last().unwrap(), 5, "5 orders by the last sample at tick 500");
}

#[test]
fn economy_production_and_combat_counters() {
    let mut w = flat_world();
    let (sx, sy) = w.players[0].start;
    for (id, dx, dy) in [("POWR", 4, 0), ("POWR", 4, 4), ("WEAP", 0, 6), ("FIX", 8, 0)] {
        let t = ty(&w, id);
        w.spawn_building(t, 0, sx + dx, sy + dy);
    }
    w.players[0].cash = 50_000;
    w.refresh_tokens();
    w.update_power();
    let jeep = ty(&w, "JEEP");
    let cost = i64::from(w.rules.actors[jeep as usize].cost);
    // Build two jeeps; cancel a third after it was partly paid.
    w.queue_order(Order::StartProduction { player: 0, ty: jeep, count: 2 });
    run(&mut w, 25 * 60);
    let s = w.player_stats(0);
    assert_eq!(s.units_built, 2);
    assert_eq!(s.spent, 2 * cost, "paid in full, nothing refunded");
    assert_eq!(s.built_value, 2 * cost);
    assert!(s.production_ticks[crate::rules::QueueType::Vehicle as usize] > 0);
    assert_eq!(w.player_detail(0).built.get(&jeep), Some(&2));
    w.queue_order(Order::StartProduction { player: 0, ty: jeep, count: 1 });
    run(&mut w, 20);
    w.queue_order(Order::CancelProduction { player: 0, ty: jeep });
    run(&mut w, 2);
    assert_eq!(w.player_stats(0).spent, 2 * cost, "the cancelled jeep's payments were refunded");
    // Selling.
    let powr = (0..w.actors.len()).find(|&i| w.actors[i].alive && w.actors[i].owner == 0 && w.actors[i].ty == ty(&w, "POWR")).unwrap();
    w.queue_order(Order::Sell { player: 0, building: w.make_ref(powr) });
    run(&mut w, 2);
    assert!(w.player_stats(0).sold > 0);
    // Combat: tanks kill a soldier; damage, value and the per type table follow.
    let victim = unit(&mut w, "E1", 1, 40, 40);
    w.actors[victim].reload = [1_000_000; MAX_WEAPONS];
    let tanks: Vec<usize> = (0..2).map(|k| unit(&mut w, "2TNK", 0, 36 + k, 40)).collect();
    w.rebuild_hash();
    w.update_vision();
    w.queue_order(Order::Attack { player: 0, ids: refs(&w, &tanks), target: w.make_ref(victim) });
    run(&mut w, 25 * 8);
    assert!(!w.actors[victim].alive);
    let e1 = ty(&w, "E1");
    let e1_cost = i64::from(w.rules.actors[e1 as usize].cost);
    let (s0, s1) = (w.player_stats(0), w.player_stats(1));
    assert_eq!(s0.assets_destroyed, e1_cost);
    assert_eq!(s1.assets_lost, e1_cost);
    assert_eq!(s0.damage_dealt, i64::from(w.rules.actors[e1 as usize].hp), "exactly the soldier's hit points");
    assert_eq!(s1.damage_taken, s0.damage_dealt);
    assert_eq!(w.player_detail(0).killed.get(&e1), Some(&1));
    assert_eq!(w.player_detail(1).lost.get(&e1), Some(&1));
    assert!(s0.experience > 0, "the killer gained experience");
    assert_eq!(s0.score(), s0.assets_destroyed + s0.built_value / 2);
    // The report names actor types by id and lists the current army.
    let r = report(&w);
    let p0 = &r["players"][0];
    assert_eq!(p0["built"]["JEEP"], 2);
    assert_eq!(p0["killed"]["E1"], 1);
    assert_eq!(p0["units"]["2TNK"], 2);
    assert!(p0["structures"]["WEAP"].as_u64() == Some(1));
    assert_eq!(r["players"][1]["lost"]["E1"], 1);
}

#[test]
fn defeat_and_game_end_are_recorded_with_a_final_sample() {
    let mut w = flat_world();
    run(&mut w, 30);
    for i in 0..w.actors.len() {
        if w.actors[i].alive && w.actors[i].owner == 1 {
            w.kill(i);
        }
    }
    run(&mut w, 30);
    assert!(w.players[1].defeated && w.has_won(0));
    let at = w.defeated_at(1).expect("defeat tick");
    assert!(at > 30 && at <= 60 && at.is_multiple_of(25), "checked once a second: {at}");
    assert_eq!(w.observer.end_tick, Some(at));
    assert_eq!(w.defeated_at(0), None);
    assert!(w.observer.history.ticks.contains(&at), "a sample on the tick the game ended");
    let r = report(&w);
    assert_eq!(r["winner"], 0);
    assert_eq!(r["endTick"], at);
    assert_eq!(r["players"][1]["defeatedAt"], at);
    assert_eq!(r["players"][1]["defeated"], true);
    assert_eq!(r["players"][0]["won"], true);
    let g = Game::wrap(w.clone());
    assert!(g.player_defeated(1) && !g.player_defeated(0) && !g.player_defeated(200));
}

#[test]
fn defeated_players_cannot_give_orders() {
    // A player whose last units are submarines is defeated (they do not keep
    // it in the game), and they go down with it (OpenRA OwnerLostAction Kill).
    let mut w = flat_world();
    for i in 0..w.actors.len() {
        if w.actors[i].alive && w.actors[i].owner == 1 {
            w.kill(i);
        }
    }
    let sub = unit(&mut w, "SS", 1, 30, 30);
    assert_eq!(w.actors[sub].kind, Kind::Ship);
    run(&mut w, 30);
    assert!(w.players[1].defeated, "submarines alone do not keep a player in the game");
    assert!(!w.actors[sub].alive, "destroyed with its defeated owner");
    // And a defeated player that still has a tank (flag set directly): no order of it applies.
    let tank = unit(&mut w, "2TNK", 1, 20, 20);
    let start = (w.actors[tank].x, w.actors[tank].y);
    let mut g = Game::wrap(w);
    g.set_lockstep(true);
    let order = Order::Move { player: 1, ids: refs(&g.world, &[tank]), x: cell_center(50), y: cell_center(50), attack_move: false };
    let frame = serde_json::to_string(&vec![(1u8, vec![serde_json::to_value(&order).unwrap()])]).unwrap();
    assert_eq!(g.apply_frame(&frame).unwrap(), 0, "refused when the frame is applied");
    // Queued directly (an AI or a race with the defeat): dropped when applied.
    g.world.queue_order(order);
    for _ in 0..60 {
        g.tick();
    }
    assert_eq!((g.world.actors[tank].x, g.world.actors[tank].y), start, "the tank never moved");
    assert_eq!(g.world.player_stats(1).orders, 0, "refused orders are not counted");
    // The winner's orders still work.
    let own = unit(&mut g.world, "2TNK", 0, 10, 40);
    let o = Order::Move { player: 0, ids: refs(&g.world, &[own]), x: cell_center(14), y: cell_center(40), attack_move: false };
    let frame = serde_json::to_string(&vec![(0u8, vec![serde_json::to_value(&o).unwrap()])]).unwrap();
    assert_eq!(g.apply_frame(&frame).unwrap(), 1);
}

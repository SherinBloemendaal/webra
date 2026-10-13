//! A structure's make animation in the simulation (OpenRA WithMakeAnimation
//! and its `build-incomplete` condition): placed during the game, it is
//! being built for `building.make_ticks` ticks (one per frame of its `make`
//! sequence, tools/gen_rules.py MAKE_FRAMES), and what the Red Alert rules
//! gate with `!build-incomplete` is off meanwhile: selling, being captured,
//! attacking (turret included) and the Construction Yard packing up.
//! Structures of the starting map skip it (OpenRA SkipMakeAnimsInit).

use crate::world::{cell_center, Order, World};

fn ty(w: &World, id: &str) -> u16 {
    w.rules.actor_index(id).unwrap() as u16
}

/// Two players on an open map, no neutral world, both see everything, plenty of power for player 0.
fn world() -> World {
    let mut w = World::new(9, 64, &[("russia", false), ("england", false)]);
    w.clear_neutral_world();
    for p in w.players.iter_mut() {
        p.explored.iter_mut().for_each(|e| *e = 1);
    }
    for k in 0..3 {
        let t = ty(&w, "APWR");
        w.spawn_building(t, 0, 2 + k * 4, 56).expect("room for power");
    }
    w.update_power();
    w
}

fn make_ticks(w: &World, id: &str) -> u32 {
    w.rules.actors[ty(w, id) as usize].building.as_ref().unwrap().make_ticks
}

/// Spawn `id` for `owner` during the game (tick > 0), as placing it does.
fn placed(w: &mut World, id: &str, owner: u8, cx: i32, cy: i32) -> usize {
    while w.tick == 0 {
        w.step();
    }
    let t = ty(w, id);
    let b = w.spawn_building(t, owner, cx, cy).expect("room for the structure");
    w.refresh_tokens();
    w.update_power();
    b
}

#[test]
fn the_rules_carry_openras_make_times_and_gates() {
    let w = world();
    // Frames of the original make files at one frame per tick.
    for (id, ticks) in [("FACT", 32), ("POWR", 13), ("WEAP", 15), ("FTUR", 28), ("PROC", 10), ("MSLO", 15), ("TSLA", 13), ("FPWR", 13)] {
        assert_eq!(make_ticks(&w, id), ticks, "{id}");
    }
    assert_eq!(make_ticks(&w, "SBAG"), 0, "walls have no make animation");
    let gates = |id: &str| w.rules.actors[ty(&w, id) as usize].building.as_ref().unwrap().make_gates;
    let g = gates("FACT");
    assert!(g.sell && g.capture && g.transform && !g.attack);
    for id in ["GUN", "TSLA", "SAM", "AGUN", "FTUR", "PBOX", "HBOX"] {
        assert!(gates(id).attack && gates(id).sell && gates(id).capture, "{id}");
    }
    assert!(!gates("POWR").attack && !gates("POWR").transform);
}

#[test]
fn the_starting_map_skips_the_make_animation_and_placed_structures_play_it() {
    let mut w = world();
    let yard = (0..w.actors.len()).find(|&i| w.actors[i].alive && w.actors[i].ty == ty(&w, "FACT")).expect("a starting yard");
    assert_eq!(w.actors[yard].make_until, 0);
    assert!(!w.build_incomplete(yard));
    let p = placed(&mut w, "POWR", 0, 30, 30);
    let at = w.tick;
    assert_eq!(w.actors[p].make_until, at + 13);
    // From the tick after it appeared through the last frame's tick (OpenRA
    // revokes build-incomplete at the end of that tick).
    for _ in 0..13 {
        w.step();
        assert!(w.build_incomplete(p), "tick {}", w.tick - at);
    }
    w.step();
    assert!(!w.build_incomplete(p), "built {} ticks after it appeared", w.tick - at);
}

#[test]
fn a_structure_being_built_cannot_be_sold() {
    let mut w = world();
    let p = placed(&mut w, "POWR", 0, 30, 30);
    let r = w.make_ref(p);
    let mut g = crate::Game::wrap(w);
    assert_eq!(g.sell_value(0, r), 0, "nothing to sell yet");
    g.world.queue_order(Order::Sell { player: 0, building: r });
    g.world.step();
    assert!(g.world.actors[p].alive, "Sellable needs !build-incomplete");
    while g.world.build_incomplete(p) {
        g.world.step();
    }
    assert!(g.sell_value(0, r) > 0);
    g.world.queue_order(Order::Sell { player: 0, building: r });
    g.world.step();
    assert!(!g.world.actors[p].alive || g.world.resolve(r).is_none(), "sold once built");
}

#[test]
fn a_structure_being_built_cannot_be_captured() {
    let mut w = world();
    let p = placed(&mut w, "POWR", 1, 30, 30);
    let e6 = w.spawn_unit(ty(&w, "E6"), 0, cell_center(29), cell_center(32), 0);
    assert!(!w.can_capture(e6, p), "Capturable needs !build-incomplete");
    while w.build_incomplete(p) {
        w.step();
    }
    assert!(w.can_capture(e6, p));
}

#[test]
fn a_defence_being_built_neither_aims_nor_fires() {
    let mut w = world();
    let tsla = placed(&mut w, "TSLA", 0, 30, 30);
    let gun = placed(&mut w, "GUN", 0, 30, 36);
    let foe = w.spawn_unit(ty(&w, "E1"), 1, cell_center(32), cell_center(33), 0);
    let tank = w.spawn_unit(ty(&w, "2TNK"), 1, cell_center(33), cell_center(37), 0);
    for u in [foe, tank] {
        w.actors[u].reload = [1_000_000; crate::world::MAX_WEAPONS];
    }
    let (hp_foe, hp_tank, turret) = (w.actors[foe].hp, w.actors[tank].hp, w.actors[gun].turret);
    while w.build_incomplete(tsla) || w.build_incomplete(gun) {
        w.step();
        if w.build_incomplete(tsla) {
            assert_eq!(w.actors[foe].hp, hp_foe, "the Tesla coil holds fire while built");
        }
        if w.build_incomplete(gun) {
            assert_eq!(w.actors[tank].hp, hp_tank, "the turret holds fire");
            assert_eq!(w.actors[gun].turret, turret, "and holds still (Turreted needs !build-incomplete)");
        }
    }
    for _ in 0..120 {
        w.step();
    }
    assert!(!w.actors[foe].alive || w.actors[foe].hp < hp_foe, "the Tesla coil fires once built");
    assert!(!w.actors[tank].alive || w.actors[tank].hp < hp_tank, "the turret fires once built");
}

#[test]
fn a_construction_yard_being_built_does_not_pack_up() {
    let mut w = world();
    w.options.redeployable_mcv = true;
    let yard = placed(&mut w, "FACT", 0, 30, 20);
    assert!(!w.can_deploy(yard), "Transforms is paused by build-incomplete");
    while w.build_incomplete(yard) {
        w.step();
    }
    assert!(w.can_deploy(yard), "packs up once built");
}

#[test]
fn the_make_time_is_simulation_state_the_same_for_everyone() {
    // Same game, one world draws with art that has make animations, the other
    // with art that has none: the make times and the hash stay identical.
    let run = |make_art: bool| {
        let mut w = world();
        w.render_opts.poses = true;
        w.render_opts.make_art = vec![make_art; w.rules.actors.len()];
        let p = placed(&mut w, "WEAP", 0, 30, 30);
        let view = crate::render::View { x0: 0.0, y0: 0.0, x1: 64.0 * 24.0, y1: 64.0 * 24.0 };
        let (mut s, mut r) = (Vec::new(), Vec::new());
        let mut hashes = Vec::new();
        for _ in 0..30 {
            w.step();
            w.build_render(0, 0.5, &view, &[], &mut s, &mut r);
            hashes.push(w.state_hash());
        }
        (w.actors[p].make_until, hashes)
    };
    assert_eq!(run(true), run(false));
    // And it is in the hash: a different make time is a different state.
    let mut w = world();
    let p = placed(&mut w, "WEAP", 0, 30, 30);
    let h = w.state_hash();
    w.actors[p].make_until += 1;
    assert_ne!(w.state_hash(), h);
}

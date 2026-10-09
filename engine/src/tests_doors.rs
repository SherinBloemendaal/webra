//! Production doors (doors.rs, OpenRA WithProductionDoorOverlay): the War
//! Factory's door layer over the ticks of a game. Shut while the factory is
//! idle or building, open frame by frame for the unit it produced, open while
//! that unit is still in the exit cell, shut frame by frame after it, and
//! never opened by other units passing by.

use crate::math::CELL;
use crate::render::{posed, Pose, View, MAX_POSE_AGE, POSE_CODES, POSE_STRIDE, SPRITE_FLOATS};
use crate::world::{cell_center, Activity, Order, World};

/// Door frames of the synthetic art (the original weap2.shp has four).
const DOOR_FRAMES: u32 = 4;
const OPEN: u32 = DOOR_FRAMES - 1;

fn ty(w: &World, id: &str) -> u16 {
    w.rules.actor_index(id).unwrap() as u16
}

/// Allied base with power, a refinery and one War Factory, plenty of cash,
/// poses on and a door layer of DOOR_FRAMES frames for the War Factory.
/// Returns the world and the factory.
fn factory_world() -> (World, usize) {
    let mut w = World::new(4, 80, &[("allies", false), ("soviet", false)]);
    let (sx, sy) = w.players[0].start;
    for (id, dx, dy) in [("APWR", 4, 0), ("PROC", -4, 0)] {
        let t = ty(&w, id);
        w.spawn_building(t, 0, sx + dx, sy + dy).unwrap_or_else(|| panic!("{id} fits"));
    }
    let weap = ty(&w, "WEAP");
    let f = w.spawn_building(weap, 0, sx, sy + 6).expect("the war factory fits");
    w.players[0].cash = 100_000;
    w.refresh_tokens();
    w.update_power();
    w.render_opts.poses = true;
    let mut table = vec![0u32; w.rules.actors.len()];
    table[weap as usize] = posed(layer_slot(&w), Pose::Still, DOOR_FRAMES) as u32;
    w.render_opts.building_overlays = table;
    assert_eq!(w.actors.iter().filter(|a| a.alive && a.ty == weap).count(), 1, "one war factory");
    // Past the make animation: the layer shows.
    for _ in 0..=MAX_POSE_AGE {
        w.step();
    }
    (w, f)
}

fn layer_slot(w: &World) -> u32 {
    ty(w, "WEAP") as u32 * 2 + 1
}

/// (pose, age) of the War Factory's door layer as player 0 sees it.
fn door(w: &World) -> (u32, u32) {
    let view = View { x0: -100.0, y0: -100.0, x1: 80.0 * 24.0 + 100.0, y1: 80.0 * 24.0 + 100.0 };
    let (mut sprites, mut rects) = (Vec::new(), Vec::new());
    w.build_render(0, 1.0, &view, &[], &mut sprites, &mut rects);
    let slot = layer_slot(w);
    let mut layers: Vec<(u32, u32)> = sprites
        .chunks(SPRITE_FLOATS)
        .map(|s| s[3] as u32)
        .filter(|&code| code % POSE_STRIDE == slot)
        .map(|code| ((code / POSE_STRIDE) % POSE_CODES, code / POSE_STRIDE / POSE_CODES))
        .collect();
    // A disabled structure draws its layers twice (the dark shade over it, render.rs DISABLED_SHADE).
    layers.dedup();
    assert_eq!(layers.len(), 1, "one door layer: {layers:?}");
    layers[0]
}

const SHUT: (u32, u32) = (Pose::Idle as u32, 0);

fn frame(k: u32) -> (u32, u32) {
    (Pose::Idle as u32, k)
}

fn exit_cell(w: &World, f: usize) -> (i32, i32) {
    let (ex, ey) = w.rules.actors[w.actors[f].ty as usize].building.as_ref().unwrap().exits[0];
    (w.actors[f].cx + ex, w.actors[f].cy + ey)
}

#[test]
fn war_factory_door_is_shut_while_idle_and_building_then_opens_for_its_unit_and_closes_after_it() {
    let (mut w, f) = factory_world();
    // Idle: shut on every tick.
    for t in 0..60 {
        w.step();
        assert_eq!(door(&w), SHUT, "idle tick {t}");
    }
    // Building a light tank: shut on every tick until it comes out.
    let tank = ty(&w, "1TNK");
    w.queue_order(Order::StartProduction { player: 0, ty: tank, count: 1 });
    let unit = loop {
        w.step();
        if let Some(u) = (0..w.actors.len()).find(|&i| w.actors[i].alive && w.actors[i].ty == tank) {
            break u;
        }
        assert_eq!(door(&w), SHUT, "building, tick {}", w.tick);
        assert!(w.tick < 5000, "the tank never came out");
    };
    // Produced this tick: on the exit cell, the door still shut (OpenRA opens it from the next tick on).
    let exit = exit_cell(&w, f);
    assert_eq!(w.cell_of(w.actors[unit].x, w.actors[unit].y), exit);
    assert_eq!(door(&w), SHUT);
    // One frame per tick up to the last, then open while the tank is in the exit cell.
    let mut seen = Vec::new();
    let mut left_at = None;
    for _ in 0..200 {
        w.step();
        seen.push(door(&w).1);
        assert_eq!(door(&w).0, Pose::Idle as u32);
        let in_exit = w.cell_of(w.actors[unit].x, w.actors[unit].y) == exit;
        if !in_exit {
            left_at = Some(seen.len());
            break;
        }
    }
    let left_at = left_at.expect("the tank leaves the exit cell");
    assert!(left_at > OPEN as usize, "the tank is still in the door once it is open: {seen:?}");
    let mut opening: Vec<u32> = (1..=OPEN).collect();
    opening.resize(left_at, OPEN);
    assert_eq!(seen, opening, "opens one frame a tick, then stays open");
    // Out of the exit cell: noticed the next tick (frame kept), then one frame a tick back to shut.
    let mut closing = Vec::new();
    for _ in 0..=OPEN {
        w.step();
        closing.push(door(&w).1);
    }
    let expected: Vec<u32> = std::iter::once(OPEN).chain((0..OPEN).rev()).collect();
    assert_eq!(closing, expected);
    // And it stays shut: no second cycle while the tank drives on, no flicker later.
    for t in 0..2 * MAX_POSE_AGE {
        w.step();
        assert_eq!(door(&w), SHUT, "after the tank left, tick {t}");
    }
    assert!(w.doors.is_idle(), "nothing left to animate");
}

#[test]
fn units_the_factory_did_not_produce_never_open_the_door() {
    let (mut w, f) = factory_world();
    let (ex, ey) = exit_cell(&w, f);
    // A brand new jeep of the owner (not produced here) drives through the exit cell.
    let jeep = ty(&w, "JEEP");
    let u = w.spawn_unit(jeep, 0, cell_center(ex - 3), cell_center(ey), 256);
    w.order_move(&[u], cell_center(ex + 3), cell_center(ey), false);
    let mut crossed = false;
    for t in 0..120 {
        w.step();
        crossed |= w.cell_of(w.actors[u].x, w.actors[u].y) == (ex, ey);
        assert_eq!(door(&w), SHUT, "tick {t}");
    }
    assert!(crossed, "the jeep went through the exit cell");
}

#[test]
fn the_door_walks_one_frame_a_tick_towards_open_or_shut_like_openra() {
    let (mut w, f) = factory_world();
    let (ex, ey) = exit_cell(&w, f);
    let jeep = ty(&w, "JEEP");
    let produce = |w: &mut World| {
        let u = w.spawn_unit(jeep, 0, cell_center(ex), cell_center(ey), 512);
        w.actors[u].activity = Activity::Move;
        w.door_unit_produced(f, u);
        u
    };
    let frames = |w: &mut World, n: usize| -> Vec<u32> {
        (0..n)
            .map(|_| {
                w.tick_doors();
                door(w).1
            })
            .collect()
    };
    let u = produce(&mut w);
    assert_eq!(door(&w), SHUT);
    assert_eq!(frames(&mut w, 6), [1, 2, 3, 3, 3, 3]);
    // Leaves the exit cell: the frame stays for the tick that notices, then closes.
    w.actors[u].x += CELL;
    assert_eq!(frames(&mut w, 2), [3, 2]);
    // The next unit comes out while the door is closing: it opens again from where it is.
    let v = produce(&mut w);
    assert_eq!(frames(&mut w, 3), [3, 3, 3]);
    // Standing idle on the exit cell (OpenRA: done leaving the factory) lets the door close.
    w.actors[v].activity = Activity::Idle;
    assert_eq!(frames(&mut w, 5), [3, 2, 1, 0, 0]);
    assert!(w.doors.is_idle());
    // Killed (or loaded into a transport) in the door: closes the same way.
    let k = produce(&mut w);
    assert_eq!(frames(&mut w, 2), [1, 2]);
    w.kill(k);
    // As when it leaves: the tick that notices still steps towards open first.
    assert_eq!(frames(&mut w, 5), [3, 2, 1, 0, 0]);
    // Damaged: the damaged door sequence, same frame.
    let max = w.rules.actors[w.actors[f].ty as usize].hp;
    w.actors[f].hp = max / 2 - 1;
    produce(&mut w);
    assert_eq!(frames(&mut w, 2), [1, 2]);
    assert_eq!(door(&w), (Pose::Damaged as u32, 2));
    // No power does not stop it (OpenRA's door has no pause condition).
    w.rules.actors[w.actors[f].ty as usize].requires_power = true;
    w.players[0].power_use = 10_000;
    w.players[0].power_gen = 0;
    assert_eq!(door(&w), (Pose::Damaged as u32, 2));
    w.actors[f].hp = max;
    assert_eq!(door(&w), frame(2));
}

#[test]
fn without_door_art_the_door_never_moves_and_nothing_piles_up() {
    let (mut w, f) = factory_world();
    // The layer without door frames (old tables): always the shut frame.
    let weap = w.actors[f].ty as usize;
    w.render_opts.building_overlays[weap] = posed(layer_slot(&w), Pose::Still, 0) as u32;
    let jeep = ty(&w, "JEEP");
    w.queue_order(Order::StartProduction { player: 0, ty: jeep, count: 3 });
    for t in 0..3000 {
        w.step();
        assert_eq!(door(&w), SHUT, "tick {t}");
    }
    assert_eq!(w.actors.iter().filter(|a| a.alive && a.ty == jeep).count(), 3);
    assert!(w.doors.is_idle(), "doors of units that left are forgotten");
}

#[test]
fn doors_never_change_the_simulation() {
    let (mut a, _) = factory_world();
    let (mut b, _) = factory_world();
    b.render_opts.poses = false;
    b.render_opts.building_overlays.clear();
    let jeep = ty(&a, "JEEP");
    for w in [&mut a, &mut b] {
        w.queue_order(Order::StartProduction { player: 0, ty: jeep, count: 2 });
    }
    for _ in 0..1500 {
        a.step();
        b.step();
        assert_eq!(a.state_hash(), b.state_hash());
    }
}

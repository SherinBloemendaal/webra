//! Target lines (target_lines.rs, OpenRA DrawLineToTarget): where they go,
//! in which colour, for whom, and that drawing them changes nothing.

use crate::math::CELL;
use crate::paths::LINE_FLOATS;
use crate::render::px;
use crate::target_lines::{CRIMSON, GREEN, ORANGE_RED, YELLOW};
use crate::world::{cell_center, Order, World};

fn ty(w: &World, id: &str) -> u16 {
    w.rules.actor_index(id).unwrap() as u16
}

fn run(w: &mut World, ticks: u32) {
    for _ in 0..ticks {
        w.step();
    }
}

fn world() -> World {
    let mut w = World::new(5, 64, &[("england", false), ("russia", false)]);
    w.clear_neutral_world();
    for p in w.players.iter_mut() {
        p.explored.iter_mut().for_each(|e| *e = 1);
    }
    w
}

fn unit(w: &mut World, id: &str, owner: u8, cx: i32, cy: i32) -> usize {
    let t = ty(w, id);
    let u = w.spawn_unit(t, owner, cell_center(cx), cell_center(cy), 0);
    w.rebuild_hash();
    w.update_vision();
    u
}

/// Segments of the target lines `player` sees of `units` (all selected and shown).
fn lines(w: &World, player: u8, units: &[usize]) -> Vec<[f32; LINE_FLOATS]> {
    let ids: Vec<u32> = units.iter().map(|&i| w.make_ref(i)).collect();
    let mut out = Vec::new();
    w.build_target_lines(player, 1.0, &ids, &ids, &mut out);
    out.chunks(LINE_FLOATS).map(|c| c.try_into().unwrap()).collect()
}

fn colour(l: &[f32; LINE_FLOATS]) -> [f32; 4] {
    [l[4], l[5], l[6], l[7]]
}

fn is_marker(l: &[f32; LINE_FLOATS]) -> bool {
    l[0] == l[2] && l[1] == l[3]
}

#[test]
fn a_moving_unit_has_a_green_line_to_its_destination_with_a_marker() {
    let mut w = world();
    let tank = unit(&mut w, "2TNK", 0, 10, 10);
    assert!(lines(&w, 0, &[tank]).is_empty(), "idle: no line (OpenRA IsIdle)");
    let ids = vec![w.make_ref(tank)];
    w.queue_order(Order::Move { player: 0, ids, x: cell_center(30), y: cell_center(10), attack_move: false });
    run(&mut w, 2);
    let l = lines(&w, 0, &[tank]);
    assert_eq!(l.len(), 2, "a line and its end marker");
    assert_eq!(colour(&l[0]), GREEN);
    assert_eq!((l[0][0], l[0][1]), (px(w.actors[tank].x), px(w.actors[tank].y)), "from the unit");
    assert_eq!((l[0][2], l[0][3]), (px(cell_center(30)), px(cell_center(10))), "to its destination cell");
    assert!(is_marker(&l[1]) && colour(&l[1]) == GREEN && l[1][0] == l[0][2]);
    // Allies see them, enemies and spectators do not; nor unselected units.
    assert!(lines(&w, 1, &[tank]).is_empty(), "not for the enemy");
    let mut out = Vec::new();
    w.build_target_lines(9, 1.0, &[w.make_ref(tank)], &[w.make_ref(tank)], &mut out);
    assert!(out.is_empty(), "not for a spectator view");
    w.build_target_lines(0, 1.0, &[], &[w.make_ref(tank)], &mut out);
    assert!(out.is_empty(), "only selected units");
}

#[test]
fn attack_move_and_queued_waypoints_chain_their_colours() {
    let mut w = world();
    let tank = unit(&mut w, "2TNK", 0, 10, 10);
    let ids = vec![w.make_ref(tank)];
    w.queue_order(Order::Move { player: 0, ids: ids.clone(), x: cell_center(20), y: cell_center(10), attack_move: true });
    w.queue_order(Order::Waypoint { player: 0, ids: ids.clone(), x: cell_center(20), y: cell_center(20), attack_move: false });
    w.queue_order(Order::Waypoint { player: 0, ids, x: cell_center(30), y: cell_center(20), attack_move: true });
    run(&mut w, 2);
    let l: Vec<_> = lines(&w, 0, &[tank]).into_iter().filter(|l| !is_marker(l)).collect();
    assert_eq!(l.iter().map(colour).collect::<Vec<_>>(), [ORANGE_RED, GREEN, ORANGE_RED], "attack-move, move, attack-move");
    // Each line starts where the last one ended.
    for k in 1..l.len() {
        assert_eq!((l[k][0], l[k][1]), (l[k - 1][2], l[k - 1][3]));
    }
    assert_eq!((l[2][2], l[2][3]), (px(cell_center(30)), px(cell_center(20))));
}

#[test]
fn attacks_guards_harvesters_and_engineers_have_openras_colours() {
    let mut w = world();
    let tank = unit(&mut w, "2TNK", 0, 10, 10);
    let enemy = unit(&mut w, "3TNK", 1, 14, 10);
    w.queue_order(Order::Attack { player: 0, ids: vec![w.make_ref(tank)], target: w.make_ref(enemy) });
    run(&mut w, 1);
    let l = lines(&w, 0, &[tank]);
    assert_eq!(colour(&l[0]), CRIMSON, "attack");
    assert_eq!((l[0][2], l[0][3]), (px(w.actors[enemy].x), px(w.actors[enemy].y)), "at the target");
    // Guard: orange red at the guarded unit.
    let jeep = unit(&mut w, "JEEP", 0, 8, 14);
    w.queue_order(Order::Guard { player: 0, ids: vec![w.make_ref(jeep)], target: w.make_ref(tank) });
    run(&mut w, 1);
    assert_eq!(colour(&lines(&w, 0, &[jeep])[0]), ORANGE_RED, "guard");
    // Force-fire on the ground: crimson at the spot.
    let arty = unit(&mut w, "ARTY", 0, 6, 6);
    w.queue_order(Order::AttackGround { player: 0, ids: vec![w.make_ref(arty)], x: cell_center(12), y: cell_center(6) });
    run(&mut w, 1);
    let l = lines(&w, 0, &[arty]);
    assert_eq!((colour(&l[0]), l[0][2]), (CRIMSON, px(cell_center(12))), "attack ground");
    // An engineer sent to capture: crimson; to repair an own structure: yellow.
    let (sx, sy) = w.players[1].start;
    let yard = (0..w.actors.len()).find(|&i| w.actors[i].alive && w.actors[i].owner == 1 && w.actors[i].kind == crate::rules::Kind::Building).unwrap();
    let e6 = unit(&mut w, "E6", 0, sx - 2, sy + 1);
    w.rebuild_hash();
    w.update_vision();
    let (yx, yy) = (w.actors[yard].x, w.actors[yard].y);
    w.queue_order(Order::Smart { player: 0, ids: vec![w.make_ref(e6)], x: yx, y: yy });
    run(&mut w, 1);
    assert_eq!(colour(&lines(&w, 0, &[e6])[0]), CRIMSON, "capture");
    let own = (0..w.actors.len()).find(|&i| w.actors[i].alive && w.actors[i].owner == 0 && w.actors[i].kind == crate::rules::Kind::Building).unwrap();
    w.actors[own].hp /= 2;
    let (hx, hy) = w.players[0].start;
    let fixer = unit(&mut w, "E6", 0, hx + 5, hy + 5);
    w.rebuild_hash();
    let (ox, oy) = (w.actors[own].x, w.actors[own].y);
    w.queue_order(Order::Smart { player: 0, ids: vec![w.make_ref(fixer)], x: ox, y: oy });
    run(&mut w, 1);
    assert_eq!(colour(&lines(&w, 0, &[fixer])[0]), YELLOW, "instant repair");
}

#[test]
fn harvesters_show_the_ore_in_crimson_and_the_refinery_in_green() {
    let mut w = World::new(5, 64, &[("england", false), ("russia", false)]);
    let harv = (0..w.actors.len()).find(|&i| w.actors[i].alive && w.actors[i].owner == 0 && w.rules.actors[w.actors[i].ty as usize].id == "HARV");
    let harv = harv.unwrap_or_else(|| {
        let (sx, sy) = w.players[0].start;
        let t = ty(&w, "PROC");
        w.spawn_building(t, 0, sx + 5, sy);
        w.refresh_tokens();
        (0..w.actors.len()).find(|&i| w.actors[i].alive && w.actors[i].owner == 0 && w.rules.actors[w.actors[i].ty as usize].id == "HARV").unwrap()
    });
    let mut seen = Vec::new();
    for _ in 0..25 * 90 {
        w.step();
        if let Some(l) = lines(&w, 0, &[harv]).first() {
            if !seen.contains(&colour(l)) {
                seen.push(colour(l));
            }
        }
    }
    assert!(seen.contains(&CRIMSON) && seen.contains(&GREEN), "{seen:?}");
}

#[test]
fn aircraft_show_where_they_fly_and_what_they_attack() {
    let mut w = world();
    let (sx, sy) = w.players[0].start;
    let t = ty(&w, "HPAD");
    w.spawn_building(t, 0, sx + 6, sy + 6).unwrap();
    w.refresh_tokens();
    let heli = unit(&mut w, "HELI", 0, sx + 4, sy + 10);
    w.actors[heli].altitude = w.rules.actors[w.actors[heli].ty as usize].unit.as_ref().unwrap().aircraft.as_ref().unwrap().cruise_altitude.max(CELL);
    w.queue_order(Order::Move { player: 0, ids: vec![w.make_ref(heli)], x: cell_center(40), y: cell_center(30), attack_move: false });
    run(&mut w, 2);
    let l = lines(&w, 0, &[heli]);
    assert_eq!(colour(&l[0]), GREEN, "flying");
    assert!(l[0][1] < px(w.actors[heli].y), "the line starts at the aircraft in the air");
    let (hx, hy) = w.cell_of(w.actors[heli].x, w.actors[heli].y);
    let enemy = unit(&mut w, "3TNK", 1, hx + 2, hy + 1);
    w.queue_order(Order::Attack { player: 0, ids: vec![w.make_ref(heli)], target: w.make_ref(enemy) });
    run(&mut w, 2);
    assert_eq!(colour(&lines(&w, 0, &[heli])[0]), CRIMSON, "attacking");
    w.queue_order(Order::Land { player: 0, ids: vec![w.make_ref(heli)], x: cell_center(20), y: cell_center(20) });
    run(&mut w, 2);
    let l = lines(&w, 0, &[heli]);
    assert_eq!(colour(&l[0]), GREEN, "landing");
}

#[test]
fn target_lines_are_presentation_only() {
    let mut a = world();
    let mut b = world();
    for w in [&mut a, &mut b] {
        let tank = unit(w, "2TNK", 0, 10, 10);
        let ids = vec![w.make_ref(tank)];
        w.queue_order(Order::Move { player: 0, ids, x: cell_center(30), y: cell_center(30), attack_move: false });
    }
    for _ in 0..100 {
        let ids: Vec<u32> = (0..a.actors.len()).filter(|&i| a.actors[i].alive).map(|i| a.make_ref(i)).collect();
        let mut out = Vec::new();
        a.build_target_lines(0, 0.5, &ids, &ids, &mut out);
        a.step();
        b.step();
    }
    assert_eq!(a.state_hash(), b.state_hash());
}

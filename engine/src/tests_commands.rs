//! Tests for the command bar orders (commands.rs) and fire stances (combat.rs).

use crate::commands::GUARD_RANGE;
use crate::math::{dist, CELL};
use crate::render::View;
use crate::rules::Stance;
use crate::world::{cell_center, Activity, Order, World, MAX_WAYPOINTS, MAX_WEAPONS, NONE};

fn ty(w: &World, id: &str) -> u16 {
    w.rules.actor_index(id).unwrap() as u16
}

fn run(w: &mut World, ticks: u32) {
    for _ in 0..ticks {
        w.step();
    }
}

/// 64x64 open, clear map, everything explored, no ore growth.
fn flat_world() -> World {
    let mut w = World::new(7, 64, &[("allies", false), ("soviet", false)]);
    w.clear_neutral_world();
    for i in 0..w.map.cells() {
        w.map.terrain[i] = crate::map::Terrain::Clear;
        w.map.ore[i] = 0;
    }
    w.pass = crate::flowfield::Passability::new(&w.map);
    w.pass_water = crate::flowfield::Passability::water(&w.map);
    w.pass_landing = crate::flowfield::Passability::landing(&w.map);
    for b in 0..w.building_at.len() {
        if w.building_at[b] != NONE {
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

/// Unit that never fires.
fn passive(w: &mut World, id: &str, owner: u8, cx: i32, cy: i32) -> usize {
    let u = unit(w, id, owner, cx, cy);
    w.actors[u].reload = [1_000_000; MAX_WEAPONS];
    u
}

fn refs(w: &World, units: &[usize]) -> Vec<u32> {
    units.iter().map(|&u| w.make_ref(u)).collect()
}

fn max_hp(w: &World, i: usize) -> i32 {
    w.rules.actors[w.actors[i].ty as usize].hp
}

fn pos(w: &World, i: usize) -> (i32, i32) {
    (w.actors[i].x, w.actors[i].y)
}

fn set_stance(w: &mut World, player: u8, units: &[usize], stance: Stance) {
    let ids = refs(w, units);
    w.queue_order(Order::SetStance { player, ids, stance });
    run(w, 1);
}

/// Put an actor somewhere else at once (as if it drove there).
fn teleport(w: &mut World, i: usize, cx: i32, cy: i32) {
    let a = &mut w.actors[i];
    (a.x, a.y, a.px, a.py) = (cell_center(cx), cell_center(cy), cell_center(cx), cell_center(cy));
}

// ---- Stances ---------------------------------------------------------------------------

#[test]
fn actors_start_with_openra_initial_stances() {
    let mut w = World::new(7, 64, &[("allies", false), ("soviet", true)]);
    let e1 = unit(&mut w, "E1", 0, 20, 20);
    let stnk = unit(&mut w, "STNK", 0, 21, 20);
    let ai_stnk = unit(&mut w, "STNK", 1, 22, 20);
    let hind = unit(&mut w, "HIND", 0, 23, 20);
    let dtrk = unit(&mut w, "DTRK", 0, 24, 20);
    let harv = unit(&mut w, "HARV", 0, 25, 20);
    let gun = w.spawn_building(ty(&w, "GUN"), 0, 30, 30).unwrap();
    assert_eq!(w.actors[e1].stance, Stance::AttackAnything, "AutoTarget default");
    assert_eq!(w.actors[stnk].stance, Stance::HoldFire, "Phase Transport: InitialStance HoldFire");
    assert_eq!(w.actors[ai_stnk].stance, Stance::ReturnFire, "InitialStanceAI ReturnFire");
    assert_eq!(w.actors[hind].stance, Stance::HoldFire);
    assert_eq!(w.actors[gun].stance, Stance::AttackAnything, "defences have stances too");
    assert!(w.has_stance(e1) && w.has_stance(gun));
    assert!(!w.has_stance(dtrk), "no AutoTarget: the Demolition Truck never picks targets");
    assert!(!w.has_stance(harv), "unarmed");
}

#[test]
fn hold_fire_never_shoots_on_its_own_not_even_back() {
    let mut w = flat_world();
    let tank = unit(&mut w, "1TNK", 0, 20, 20);
    let foe = unit(&mut w, "1TNK", 1, 24, 20);
    set_stance(&mut w, 1, &[foe], Stance::HoldFire);
    set_stance(&mut w, 0, &[tank], Stance::HoldFire);
    run(&mut w, 100);
    assert_eq!(w.actors[foe].hp, max_hp(&w, foe), "idle under HoldFire: no shots");
    let ids = refs(&w, &[foe]);
    let target = w.make_ref(tank);
    w.queue_order(Order::Attack { player: 1, ids, target });
    run(&mut w, 100);
    assert!(w.actors[tank].hp < max_hp(&w, tank), "the enemy fires");
    assert_eq!(w.actors[foe].hp, max_hp(&w, foe), "HoldFire does not shoot back");
}

#[test]
fn return_fire_shoots_back_from_where_it_stands() {
    let mut w = flat_world();
    let tank = unit(&mut w, "1TNK", 0, 20, 20);
    let near = passive(&mut w, "1TNK", 1, 24, 20);
    set_stance(&mut w, 0, &[tank], Stance::ReturnFire);
    run(&mut w, 100);
    assert_eq!(w.actors[near].hp, max_hp(&w, near), "an enemy in range that does not shoot is left alone");
    // An enemy in range opens fire: shoot back, without moving.
    let shooter = unit(&mut w, "1TNK", 1, 20, 24);
    set_stance(&mut w, 1, &[shooter], Stance::HoldFire);
    let ids = refs(&w, &[shooter]);
    let target = w.make_ref(tank);
    w.queue_order(Order::Attack { player: 1, ids, target });
    let start = pos(&w, tank);
    run(&mut w, 100);
    assert!(w.actors[shooter].hp < max_hp(&w, shooter), "shot back at the attacker");
    assert_eq!(w.actors[near].hp, max_hp(&w, near), "ReturnFire answers the attacker only");
    assert_eq!(pos(&w, tank), start, "ReturnFire never moves");
}

#[test]
fn return_fire_ignores_attackers_out_of_reach() {
    let mut w = flat_world();
    let tank = unit(&mut w, "1TNK", 0, 20, 20);
    set_stance(&mut w, 0, &[tank], Stance::ReturnFire);
    // Artillery outranges the tank's gun; a soldier that never fires spots for it.
    let spotter = passive(&mut w, "E1", 1, 20, 23);
    set_stance(&mut w, 1, &[spotter], Stance::HoldFire);
    let arty = unit(&mut w, "ARTY", 1, 28, 20);
    set_stance(&mut w, 1, &[arty], Stance::HoldFire);
    let ids = refs(&w, &[arty]);
    let target = w.make_ref(tank);
    w.queue_order(Order::Attack { player: 1, ids, target });
    let start = pos(&w, tank);
    run(&mut w, 150);
    assert!(w.actors[tank].hp < max_hp(&w, tank), "shelled");
    assert_eq!(pos(&w, tank), start, "does not drive out to the artillery");
    assert_eq!(w.actors[tank].activity, Activity::Idle);
}

#[test]
fn defend_attacks_in_range_but_never_chases() {
    let mut w = flat_world();
    let tank = unit(&mut w, "2TNK", 0, 20, 20);
    let foe = passive(&mut w, "1TNK", 1, 24, 20);
    set_stance(&mut w, 0, &[tank], Stance::Defend);
    let start = pos(&w, tank);
    run(&mut w, 60);
    assert!(w.actors[foe].hp < max_hp(&w, foe), "Defend attacks enemies in range");
    // Out of range (4c864), still in sight (6c0).
    teleport(&mut w, foe, 25, 20);
    run(&mut w, 60);
    assert_eq!(w.actors[tank].activity, Activity::Idle, "target out of range: the fight ends");
    assert_eq!(pos(&w, tank), start, "Defend never moves");
}

#[test]
fn attack_anything_chases_targets_it_picked() {
    let mut w = flat_world();
    let tank = unit(&mut w, "2TNK", 0, 20, 20);
    let foe = passive(&mut w, "1TNK", 1, 24, 20);
    run(&mut w, 60);
    assert!(w.actors[foe].hp < max_hp(&w, foe));
    // Out of range; an own soldier on HoldFire keeps it in sight.
    let spotter = passive(&mut w, "E1", 0, 28, 22);
    set_stance(&mut w, 0, &[spotter], Stance::HoldFire);
    run(&mut w, 2);
    teleport(&mut w, foe, 27, 20);
    let start = pos(&w, tank);
    run(&mut w, 20);
    assert_eq!(w.actors[tank].activity, Activity::Attack);
    assert!(pos(&w, tank).0 > start.0 + CELL / 4, "AttackAnything chases");
}

#[test]
fn hold_fire_ends_fights_the_unit_picked_itself() {
    let mut w = flat_world();
    let tank = unit(&mut w, "1TNK", 0, 20, 20);
    let foe = passive(&mut w, "1TNK", 1, 24, 20);
    run(&mut w, 40);
    assert_eq!(w.actors[tank].activity, Activity::Attack);
    set_stance(&mut w, 0, &[tank], Stance::HoldFire);
    assert_eq!(w.actors[tank].activity, Activity::Idle);
    // A shell already in the air still lands.
    run(&mut w, 25);
    let hp = w.actors[foe].hp;
    run(&mut w, 100);
    assert_eq!(w.actors[foe].hp, hp, "no more shots");
    // An ordered attack still goes ahead under HoldFire.
    let ids = refs(&w, &[tank]);
    let target = w.make_ref(foe);
    w.queue_order(Order::Attack { player: 0, ids, target });
    run(&mut w, 60);
    assert!(w.actors[foe].hp < hp);
}

#[test]
fn set_stance_changes_own_actors_with_auto_target_only() {
    let mut w = flat_world();
    let e1 = unit(&mut w, "E1", 0, 20, 20);
    let dtrk = unit(&mut w, "DTRK", 0, 21, 20);
    let foe = unit(&mut w, "E1", 1, 50, 50);
    let gun = w.spawn_building(ty(&w, "GUN"), 0, 30, 30).unwrap();
    let ids = refs(&w, &[e1, dtrk, foe, gun]);
    w.queue_order(Order::SetStance { player: 0, ids, stance: Stance::Defend });
    run(&mut w, 1);
    assert_eq!(w.actors[e1].stance, Stance::Defend);
    assert_eq!(w.actors[gun].stance, Stance::Defend, "defences take stances");
    assert_eq!(w.actors[foe].stance, Stance::AttackAnything, "not someone else's units");
    assert!(!w.has_stance(dtrk));
}

#[test]
fn hold_fire_defence_stays_quiet() {
    let mut w = flat_world();
    let gun = w.spawn_building(ty(&w, "GUN"), 0, 30, 30).unwrap();
    set_stance(&mut w, 0, &[gun], Stance::HoldFire);
    let foe = passive(&mut w, "1TNK", 1, 33, 31);
    run(&mut w, 100);
    assert_eq!(w.actors[foe].hp, max_hp(&w, foe));
    set_stance(&mut w, 0, &[gun], Stance::Defend);
    run(&mut w, 60);
    assert!(w.actors[foe].hp < max_hp(&w, foe));
}

// ---- Force-fire ------------------------------------------------------------------------

#[test]
fn force_attack_hits_own_units_and_they_do_not_shoot_back() {
    let mut w = flat_world();
    let a = unit(&mut w, "1TNK", 0, 20, 20);
    let b = unit(&mut w, "1TNK", 0, 24, 20);
    let ids = refs(&w, &[a]);
    let target = w.make_ref(b);
    w.queue_order(Order::Attack { player: 0, ids, target });
    run(&mut w, 100);
    assert!(w.actors[b].hp < max_hp(&w, b), "force-fire on an own tank");
    assert_eq!(w.actors[a].hp, max_hp(&w, a), "own fire is never answered");
    // Attacking itself does nothing.
    let ids = refs(&w, &[a]);
    let target = w.make_ref(a);
    w.queue_order(Order::Attack { player: 0, ids, target });
    run(&mut w, 2);
    assert_ne!(w.actors[a].target, target);
}

#[test]
fn attack_ground_moves_into_range_and_keeps_firing() {
    let mut w = flat_world();
    let tank = unit(&mut w, "2TNK", 0, 15, 20);
    let foe = w.spawn_building(ty(&w, "POWR"), 1, 30, 19).unwrap();
    set_stance(&mut w, 0, &[tank], Stance::HoldFire);
    let ids = refs(&w, &[tank]);
    let (x, y) = (cell_center(30), cell_center(20));
    w.queue_order(Order::AttackGround { player: 0, ids: ids.clone(), x, y });
    run(&mut w, 400);
    assert_eq!(w.actors[tank].activity, Activity::AttackGround, "fires until told otherwise");
    assert!(dist(w.actors[tank].x, w.actors[tank].y, x, y) < 6 * CELL, "drove into range");
    assert!(w.actors[foe].hp < max_hp(&w, foe), "the shells land on the ground point");
    w.queue_order(Order::Stop { player: 0, ids });
    run(&mut w, 1);
    assert_eq!(w.actors[tank].activity, Activity::Idle);
}

#[test]
fn attack_ground_needs_a_ground_weapon_and_no_plane() {
    let mut w = flat_world();
    let yak = unit(&mut w, "YAK", 0, 20, 20);
    let harv = unit(&mut w, "HARV", 0, 22, 20);
    let e1 = unit(&mut w, "E1", 0, 24, 20);
    let (x, y) = (cell_center(30), cell_center(30));
    assert!(!w.can_attack_ground(yak, x, y), "planes attack actors only");
    assert!(!w.can_attack_ground(harv, x, y), "unarmed");
    assert!(w.can_attack_ground(e1, x, y));
    let ids = refs(&w, &[yak, harv, e1]);
    w.queue_order(Order::AttackGround { player: 0, ids, x, y });
    run(&mut w, 1);
    assert_ne!(w.actors[yak].activity, Activity::AttackGround);
    assert_ne!(w.actors[harv].activity, Activity::AttackGround);
    assert_eq!(w.actors[e1].activity, Activity::AttackGround);
}

#[test]
fn helicopters_fire_on_the_ground() {
    let mut w = flat_world();
    let hind = unit(&mut w, "HIND", 1, 20, 20);
    let foe = w.spawn_building(ty(&w, "POWR"), 0, 30, 19).unwrap();
    let ids = refs(&w, &[hind]);
    w.queue_order(Order::AttackGround { player: 1, ids, x: cell_center(30), y: cell_center(20) });
    run(&mut w, 200);
    assert!(w.actors[foe].hp < max_hp(&w, foe));
}

// ---- Guard -----------------------------------------------------------------------------

#[test]
fn guards_follow_fight_and_stop_when_the_unit_dies() {
    let mut w = flat_world();
    let tank = unit(&mut w, "2TNK", 0, 20, 20);
    set_stance(&mut w, 0, &[tank], Stance::HoldFire);
    let e1 = unit(&mut w, "E1", 0, 18, 20);
    let ids = refs(&w, &[e1]);
    let target = w.make_ref(tank);
    w.queue_order(Order::Guard { player: 0, ids, target });
    let tank_ids = refs(&w, &[tank]);
    w.queue_order(Order::Move { player: 0, ids: tank_ids, x: cell_center(40), y: cell_center(22), attack_move: false });
    run(&mut w, 500);
    assert_eq!(w.actors[e1].activity, Activity::Guard);
    assert!(dist(w.actors[e1].x, w.actors[e1].y, w.actors[tank].x, w.actors[tank].y) <= GUARD_RANGE + CELL, "followed the tank");
    // An enemy turns up next to the tank: the guard fights it, then guards again.
    let foe = passive(&mut w, "E1", 1, 42, 22);
    run(&mut w, 200);
    assert!(!w.actors[foe].alive || w.actors[foe].hp < max_hp(&w, foe), "the guard attacked");
    w.kill(foe);
    run(&mut w, 30);
    assert_eq!(w.actors[e1].activity, Activity::Guard, "back to guarding");
    w.kill(tank);
    run(&mut w, 2);
    assert_eq!(w.actors[e1].activity, Activity::Idle);
    assert_eq!(w.actors[e1].guard, NONE);
}

#[test]
fn guard_takes_own_and_allied_units_only() {
    let mut w = flat_world();
    let e1 = unit(&mut w, "E1", 0, 20, 20);
    let foe = passive(&mut w, "E1", 1, 40, 40);
    let yak = unit(&mut w, "YAK", 0, 22, 20);
    let powr = w.spawn_building(ty(&w, "POWR"), 0, 30, 30).unwrap();
    assert!(!w.can_guard(0, e1, foe), "not enemies");
    assert!(!w.can_guard(0, e1, e1), "not itself");
    assert!(!w.can_guard(0, e1, powr), "units only");
    assert!(!w.can_guard(0, yak, e1), "planes cannot guard");
    assert!(w.can_guard(0, e1, yak));
    let ids = refs(&w, &[e1]);
    let target = w.make_ref(foe);
    w.queue_order(Order::Guard { player: 0, ids, target });
    run(&mut w, 1);
    assert_eq!(w.actors[e1].activity, Activity::Idle);
}

#[test]
fn a_new_order_ends_guarding() {
    let mut w = flat_world();
    let tank = unit(&mut w, "2TNK", 0, 20, 20);
    let e1 = unit(&mut w, "E1", 0, 18, 20);
    let ids = refs(&w, &[e1]);
    let target = w.make_ref(tank);
    w.queue_order(Order::Guard { player: 0, ids: ids.clone(), target });
    run(&mut w, 2);
    assert_eq!(w.actors[e1].guard, target);
    w.queue_order(Order::Move { player: 0, ids, x: cell_center(10), y: cell_center(10), attack_move: false });
    run(&mut w, 1);
    assert_eq!(w.actors[e1].guard, NONE);
    assert_eq!(w.actors[e1].activity, Activity::Move);
}

// ---- Scatter ---------------------------------------------------------------------------

#[test]
fn scatter_sends_each_unit_to_a_free_neighbouring_cell_deterministically() {
    let setup = || {
        let mut w = flat_world();
        let units: Vec<usize> = (0..4).map(|_| unit(&mut w, "E1", 0, 20, 20)).collect();
        let ids = refs(&w, &units);
        w.queue_order(Order::Scatter { player: 0, ids });
        run(&mut w, 1);
        (w, units)
    };
    let (mut a, units) = setup();
    let (mut b, _) = setup();
    for &u in &units {
        assert_eq!(a.actors[u].activity, Activity::Move);
        let (gx, gy) = (a.actors[u].goal as i32 % a.map.width, a.actors[u].goal as i32 / a.map.width);
        assert!((gx - 20).abs() <= 1 && (gy - 20).abs() <= 1 && (gx, gy) != (20, 20), "a neighbouring cell");
    }
    run(&mut a, 50);
    run(&mut b, 50);
    assert_eq!(a.state_hash(), b.state_hash(), "same random cells everywhere");
    assert!(units.iter().any(|&u| pos(&a, u) != (cell_center(20), cell_center(20))));
}

#[test]
fn scatter_avoids_blocked_cells() {
    let mut w = flat_world();
    let e1 = unit(&mut w, "E1", 0, 20, 20);
    // Wall it in except for one cell.
    for (dx, dy) in crate::flowfield::DIRS {
        if (dx, dy) != (1, 0) {
            let ci = w.map.idx(20 + dx, 20 + dy);
            w.pass.set_blocked(ci, true);
        }
    }
    w.pass.refresh(&w.map);
    let ids = refs(&w, &[e1]);
    w.queue_order(Order::Scatter { player: 0, ids });
    run(&mut w, 1);
    assert_eq!(w.actors[e1].goal, w.map.idx(21, 20) as u32);
}

// ---- Waypoints -------------------------------------------------------------------------

#[test]
fn waypoints_queue_moves_after_the_current_one() {
    let mut w = flat_world();
    let tank = unit(&mut w, "1TNK", 0, 20, 20);
    let ids = refs(&w, &[tank]);
    let wp = |w: &mut World, cx: i32, cy: i32, attack_move: bool| {
        w.queue_order(Order::Waypoint { player: 0, ids: ids.clone(), x: cell_center(cx), y: cell_center(cy), attack_move });
        run(w, 1);
    };
    wp(&mut w, 26, 20, false);
    assert_eq!(w.actors[tank].activity, Activity::Move, "an idle unit starts at once");
    assert!(w.actors[tank].waypoints.is_empty());
    wp(&mut w, 26, 28, true);
    wp(&mut w, 20, 28, false);
    assert_eq!(w.actors[tank].waypoints.len(), 2);
    assert_eq!(w.actors[tank].dest, (cell_center(26), cell_center(20)), "still on the first leg");
    run(&mut w, 200);
    assert!(
        dist(w.actors[tank].x, w.actors[tank].y, cell_center(26), cell_center(28)) < 2 * CELL || w.actors[tank].dest.1 == cell_center(28)
    );
    run(&mut w, 400);
    assert!(dist(w.actors[tank].x, w.actors[tank].y, cell_center(20), cell_center(28)) < CELL, "reached the last waypoint");
    assert!(w.actors[tank].waypoints.is_empty());
    assert_eq!(w.actors[tank].activity, Activity::Idle);
}

#[test]
fn a_new_order_clears_queued_waypoints_and_the_queue_is_bounded() {
    let mut w = flat_world();
    let tank = unit(&mut w, "1TNK", 0, 20, 20);
    let ids = refs(&w, &[tank]);
    for k in 0..(MAX_WAYPOINTS as i32 + 5) {
        w.queue_order(Order::Waypoint { player: 0, ids: ids.clone(), x: cell_center(22 + k % 10), y: cell_center(30), attack_move: false });
    }
    run(&mut w, 1);
    assert_eq!(w.actors[tank].waypoints.len(), MAX_WAYPOINTS, "the first starts, the rest queue up to the cap");
    // A stance change keeps the queue; a new command replaces it.
    set_stance(&mut w, 0, &[tank], Stance::Defend);
    assert_eq!(w.actors[tank].waypoints.len(), MAX_WAYPOINTS);
    w.queue_order(Order::Stop { player: 0, ids });
    run(&mut w, 1);
    assert!(w.actors[tank].waypoints.is_empty());
    assert_eq!(w.actors[tank].activity, Activity::Idle);
}

#[test]
fn waypoints_wait_for_an_ordered_attack() {
    let mut w = flat_world();
    let tank = unit(&mut w, "1TNK", 0, 20, 20);
    let foe = unit(&mut w, "E1", 1, 24, 20);
    set_stance(&mut w, 1, &[foe], Stance::HoldFire);
    set_stance(&mut w, 0, &[tank], Stance::HoldFire);
    run(&mut w, 2);
    let ids = refs(&w, &[tank]);
    let target = w.make_ref(foe);
    w.queue_order(Order::Attack { player: 0, ids: ids.clone(), target });
    w.queue_order(Order::Waypoint { player: 0, ids, x: cell_center(20), y: cell_center(30), attack_move: false });
    run(&mut w, 1);
    assert_eq!(w.actors[tank].activity, Activity::Attack);
    assert_eq!(w.actors[tank].waypoints.len(), 1);
    // Prone infantry (veterancy.rs) takes longer to kill: wait for the fight.
    for _ in 0..1500 {
        if !w.actors[foe].alive {
            break;
        }
        assert_eq!(w.actors[tank].waypoints.len(), 1, "queued until the attack ends");
        w.step();
    }
    assert!(!w.actors[foe].alive, "the attack finished first");
    run(&mut w, 300);
    assert!(w.actors[tank].waypoints.is_empty());
    assert!(dist(w.actors[tank].x, w.actors[tank].y, cell_center(20), cell_center(30)) < 2 * CELL, "then the queued move");
}

// ---- Rendering -------------------------------------------------------------------------

#[test]
fn targets_of_the_selection_and_the_hovered_actor_get_health_bars() {
    let mut w = flat_world();
    let tank = unit(&mut w, "1TNK", 0, 20, 20);
    let foe = passive(&mut w, "1TNK", 1, 24, 20);
    let other = passive(&mut w, "E1", 1, 22, 23);
    set_stance(&mut w, 0, &[tank], Stance::HoldFire);
    run(&mut w, 3);
    let view = View { x0: 0.0, y0: 0.0, x1: 2000.0, y1: 2000.0 };
    let selected = refs(&w, &[tank]);
    let rects = |w: &mut World, hover: u32| {
        w.render_opts.hover = hover;
        let (mut s, mut r) = (Vec::new(), Vec::new());
        w.build_render(0, 1.0, &view, &selected, &mut s, &mut r);
        r.len() / crate::render::RECT_FLOATS
    };
    // One segmented bar (frame and segments, overlays.rs) over an actor's box.
    let bar = |w: &World, i: usize| crate::overlays::health_bar_rect_count(w.selection_box(i, 1.0).2);
    let base = rects(&mut w, NONE);
    let ids = refs(&w, &[tank]);
    let target = w.make_ref(foe);
    w.queue_order(Order::Attack { player: 0, ids, target });
    run(&mut w, 1);
    let (foe_bar, other_bar) = (bar(&w, foe), bar(&w, other));
    let (other_ref, foe_ref, tank_ref) = (w.make_ref(other), w.make_ref(foe), w.make_ref(tank));
    assert_eq!(rects(&mut w, NONE), base + foe_bar, "a bar over the target");
    assert_eq!(rects(&mut w, other_ref), base + foe_bar + other_bar, "and over the hovered enemy");
    assert_eq!(rects(&mut w, foe_ref), base + foe_bar, "drawn once");
    assert_eq!(rects(&mut w, tank_ref), base + foe_bar, "selected actors have theirs already");
}

#[test]
fn hidden_targets_get_no_health_bar() {
    let mut w = flat_world();
    let tank = unit(&mut w, "1TNK", 0, 20, 20);
    let foe = passive(&mut w, "1TNK", 1, 24, 20);
    set_stance(&mut w, 0, &[tank], Stance::HoldFire);
    run(&mut w, 2);
    let view = View { x0: 0.0, y0: 0.0, x1: 2000.0, y1: 2000.0 };
    let selected = refs(&w, &[tank]);
    w.actors[tank].target = w.make_ref(foe);
    let count = |w: &World| {
        let (mut s, mut r) = (Vec::new(), Vec::new());
        w.build_render(0, 1.0, &view, &selected, &mut s, &mut r);
        r.len()
    };
    let seen = count(&w);
    // Out of sight now.
    let ci = w.cell_index(w.actors[foe].x, w.actors[foe].y);
    w.players[0].visible[ci] = 0;
    assert!(count(&w) < seen);
}

// ---- Orders on the wire ------------------------------------------------------------------

#[test]
fn command_orders_round_trip_through_json() {
    let orders = [
        Order::AttackGround { player: 1, ids: vec![1, 2], x: -5, y: 9 },
        Order::Guard { player: 1, ids: vec![3], target: 7 },
        Order::Scatter { player: 1, ids: vec![4] },
        Order::Waypoint { player: 1, ids: vec![5], x: 1, y: 2, attack_move: true },
        Order::SetStance { player: 1, ids: vec![6], stance: Stance::ReturnFire },
    ];
    let json = serde_json::to_string(&orders).unwrap();
    assert!(json.contains(r#""o":"attack_ground""#) && json.contains(r#""stance":"return_fire""#) && json.contains(r#""o":"set_stance""#));
    let back: Vec<Order> = serde_json::from_str(&json).unwrap();
    assert_eq!(format!("{back:?}"), format!("{orders:?}"));
    assert!(serde_json::from_str::<Order>(r#"{"o":"set_stance","player":0,"ids":[],"stance":"berserk"}"#).is_err());
    assert!(serde_json::from_str::<Order>(r#"{"o":"scatter","player":0,"ids":[],"x":1}"#).is_err(), "deny_unknown_fields");
    assert!(!Order::Scatter { player: 0, ids: vec![0; 2001] }.is_reasonable());
}

#[test]
fn command_orders_stay_in_lockstep() {
    let setup = || {
        let mut w = World::new(5, 64, &[("allies", false), ("soviet", true)]);
        let (sx, sy) = w.players[0].start;
        let units: Vec<usize> = (0..6).map(|k| unit(&mut w, if k % 2 == 0 { "E1" } else { "1TNK" }, 0, sx + 2 + k, sy + 6)).collect();
        (w, units)
    };
    let (mut a, units) = setup();
    let (mut b, _) = setup();
    for w in [&mut a, &mut b] {
        let ids = refs(w, &units);
        let first = vec![ids[0]];
        let (sx, sy) = w.players[0].start;
        w.queue_order(Order::SetStance { player: 0, ids: ids.clone(), stance: Stance::Defend });
        w.queue_order(Order::Scatter { player: 0, ids: ids.clone() });
        w.queue_order(Order::Waypoint { player: 0, ids: ids.clone(), x: cell_center(sx + 12), y: cell_center(sy + 12), attack_move: true });
        w.queue_order(Order::Guard { player: 0, ids: first, target: ids[1] });
        w.queue_order(Order::AttackGround { player: 0, ids: vec![ids[2]], x: cell_center(sx + 10), y: cell_center(sy + 2) });
    }
    for t in 0..1500 {
        a.step();
        b.step();
        if t % 250 == 0 {
            assert_eq!(a.state_hash(), b.state_hash(), "desync at tick {t}");
        }
    }
    assert_eq!(a.state_hash(), b.state_hash());
}

#[test]
fn kills_from_attack_ground_and_return_fire_credit_the_shooter() {
    // One shooter field (veterancy Shot) serves experience and return fire.
    let mut w = flat_world();
    let tank = unit(&mut w, "2TNK", 0, 20, 20);
    let foe = passive(&mut w, "E1", 1, 24, 20);
    set_stance(&mut w, 0, &[tank], Stance::HoldFire);
    let ids = refs(&w, &[tank]);
    w.queue_order(Order::AttackGround { player: 0, ids, x: cell_center(24), y: cell_center(20) });
    for _ in 0..1500 {
        if !w.actors[foe].alive {
            break;
        }
        w.step();
    }
    assert!(!w.actors[foe].alive, "the shells killed the soldier on the spot");
    assert!(w.actors[tank].xp > 0, "the kill counts for the tank");
    // Return fire: the attacker's shells in flight name it, so the victim answers it.
    let shooter = unit(&mut w, "1TNK", 1, 23, 23);
    set_stance(&mut w, 1, &[shooter], Stance::HoldFire);
    let ids = refs(&w, &[tank]);
    w.queue_order(Order::Stop { player: 0, ids });
    set_stance(&mut w, 0, &[tank], Stance::ReturnFire);
    let ids = refs(&w, &[shooter]);
    let target = w.make_ref(tank);
    w.queue_order(Order::Attack { player: 1, ids, target });
    run(&mut w, 150);
    assert!(w.actors[shooter].hp < max_hp(&w, shooter), "shot back at the attacker");
}

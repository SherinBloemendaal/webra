//! Combat fairness and OpenRA parity (combat.rs, units.rs): opportunity fire
//! while moving, attacks that follow a target out of sight, shots of a tick
//! that resolve together, and auto-target priorities per stance.

use crate::map::{Map, Terrain};
use crate::math::{dist, CELL};
use crate::rules::Stance;
use crate::world::{cell_center, Activity, GameOptions, Order, PlayerSetup, World, MAX_WEAPONS, NONE};

fn ty(w: &World, id: &str) -> u16 {
    w.rules.actor_index(id).unwrap() as u16
}

fn run(w: &mut World, ticks: u32) {
    for _ in 0..ticks {
        w.step();
    }
}

/// 64x64 open field, fog of war on, the two yards in far corners.
fn field(seed: u64) -> World {
    let mut map = Map::filled(64, 64, Terrain::Clear);
    map.spawns = vec![(1, 1), (58, 56)];
    let players = [PlayerSetup::new("allies", None), PlayerSetup::new("soviet", None)];
    World::on_map(seed, map, &players, GameOptions { ore_regrowth: false, ..GameOptions::default() })
}

fn unit(w: &mut World, id: &str, owner: u8, cx: i32, cy: i32) -> usize {
    let t = ty(w, id);
    w.spawn_unit(t, owner, cell_center(cx), cell_center(cy), 256)
}

/// A unit that never fires.
fn quiet(w: &mut World, id: &str, owner: u8, cx: i32, cy: i32) -> usize {
    let u = unit(w, id, owner, cx, cy);
    w.actors[u].reload = [1_000_000; MAX_WEAPONS];
    u
}

fn max_hp(w: &World, i: usize) -> i32 {
    w.rules.actors[w.actors[i].ty as usize].hp
}

fn set_stance(w: &mut World, player: u8, units: &[usize], stance: Stance) {
    let ids = units.iter().map(|&u| w.make_ref(u)).collect();
    w.queue_order(Order::SetStance { player, ids, stance });
    run(w, 1);
}

fn teleport(w: &mut World, i: usize, cx: i32, cy: i32) {
    let a = &mut w.actors[i];
    (a.x, a.y, a.px, a.py) = (cell_center(cx), cell_center(cy), cell_center(cx), cell_center(cy));
}

// ---- Opportunity fire --------------------------------------------------------------

#[test]
fn a_tank_on_a_move_shoots_what_it_passes_and_still_arrives() {
    let mut w = field(1);
    let tank = unit(&mut w, "2TNK", 0, 10, 30);
    let foe = quiet(&mut w, "E1", 1, 25, 33);
    run(&mut w, 1);
    let goal = (cell_center(40), cell_center(30));
    w.order_move(&[tank], goal.0, goal.1, false);
    let mut attacked = false;
    for _ in 0..25 * 30 {
        w.step();
        // Firing never turns the move into an attack.
        attacked |= w.actors[tank].activity == Activity::Attack;
        if w.actors[tank].activity == Activity::Idle {
            break;
        }
    }
    assert!(!attacked, "the move stayed a move");
    assert!(!w.actors[foe].alive || w.actors[foe].hp < max_hp(&w, foe), "the rifleman was shot at on the way");
    assert!(dist(w.actors[tank].x, w.actors[tank].y, goal.0, goal.1) <= CELL, "the tank arrived");
}

#[test]
fn infantry_on_a_move_holds_its_fire() {
    let mut w = field(2);
    let rifleman = unit(&mut w, "E1", 0, 10, 30);
    let foe = quiet(&mut w, "E1", 1, 20, 32);
    run(&mut w, 1);
    w.order_move(&[rifleman], cell_center(30), cell_center(30), false);
    run(&mut w, 25 * 20);
    assert_eq!(w.actors[foe].hp, max_hp(&w, foe), "AttackFrontal units do not fire while moving");
    // On attack-move it does engage.
    w.order_move(&[rifleman], cell_center(10), cell_center(30), true);
    run(&mut w, 25 * 20);
    assert!(!w.actors[foe].alive || w.actors[foe].hp < max_hp(&w, foe), "attack-move engages");
}

#[test]
fn opportunity_fire_needs_defend_stance_or_more() {
    let mut w = field(3);
    let tank = unit(&mut w, "2TNK", 0, 10, 30);
    let foe = quiet(&mut w, "E1", 1, 25, 33);
    set_stance(&mut w, 0, &[tank], Stance::ReturnFire);
    w.order_move(&[tank], cell_center(40), cell_center(30), false);
    run(&mut w, 25 * 20);
    assert_eq!(w.actors[foe].hp, max_hp(&w, foe));
}

// ---- Targets out of sight -----------------------------------------------------------

#[test]
fn an_attack_follows_its_target_to_where_it_was_last_seen() {
    // A spotter shows the rifleman ten cells from the tank.
    let mut w = field(4);
    let tank = quiet(&mut w, "2TNK", 0, 10, 30);
    quiet(&mut w, "E1", 0, 18, 32);
    let foe = quiet(&mut w, "E1", 1, 20, 30);
    run(&mut w, 3);
    assert!(w.targetable(foe, 0), "in sight");
    w.order_attack(&[tank], foe, false);
    let seen = (w.actors[foe].x, w.actors[foe].y);
    // It slips away out of sight.
    teleport(&mut w, foe, 45, 50);
    run(&mut w, 4);
    assert!(!w.targetable(foe, 0), "out of sight");
    assert_eq!(w.actors[tank].activity, Activity::Attack, "the attack goes on");
    assert_eq!(w.resolve(w.actors[tank].target), Some(foe));
    let before = dist(w.actors[tank].x, w.actors[tank].y, seen.0, seen.1);
    run(&mut w, 25);
    let after = dist(w.actors[tank].x, w.actors[tank].y, seen.0, seen.1);
    assert!(after < before, "heading for the last seen spot: {before} -> {after}");
    // Nothing there: the attack ends once the spot is in reach.
    run(&mut w, 25 * 10);
    assert_eq!(w.actors[tank].activity, Activity::Idle);
    assert_eq!(w.actors[tank].target, NONE);
    let range = w.rules.weapons[w.rules.actors[w.actors[tank].ty as usize].weapons[0]].range;
    assert!(dist(w.actors[tank].x, w.actors[tank].y, seen.0, seen.1) <= range + CELL);
}

#[test]
fn a_lost_target_that_shows_up_again_is_attacked_again() {
    let mut w = field(5);
    let tank = unit(&mut w, "2TNK", 0, 10, 30);
    quiet(&mut w, "E1", 0, 18, 32);
    let foe = quiet(&mut w, "E1", 1, 20, 30);
    run(&mut w, 3);
    w.order_attack(&[tank], foe, false);
    teleport(&mut w, foe, 45, 50);
    run(&mut w, 10);
    assert_eq!(w.resolve(w.actors[tank].target), Some(foe), "still after it");
    assert!(!w.targetable(foe, 0));
    // It comes back near where it was seen: the tank picks it up again.
    teleport(&mut w, foe, 19, 31);
    run(&mut w, 25 * 10);
    assert!(!w.actors[foe].alive || w.actors[foe].hp < max_hp(&w, foe), "attacked again once seen");
    assert!(!w.actors[foe].alive || w.resolve(w.actors[tank].target) == Some(foe), "the same attack");
}

#[test]
fn an_unseen_target_gives_an_ordered_attack_no_place_to_go() {
    let mut w = field(6);
    let tank = quiet(&mut w, "1TNK", 0, 10, 30);
    let foe = quiet(&mut w, "E1", 1, 45, 50);
    run(&mut w, 3);
    assert!(!w.targetable(foe, 0));
    // An order for a target the owner does not see leaks nothing: no last seen spot.
    w.order_attack(&[tank], foe, false);
    assert_eq!(w.actors[tank].target_seen, None);
    run(&mut w, 2);
    assert_eq!(w.actors[tank].activity, Activity::Idle);
}

#[test]
fn defend_stance_does_not_chase_a_target_out_of_sight() {
    let mut w = field(7);
    let tank = unit(&mut w, "1TNK", 0, 10, 30);
    set_stance(&mut w, 0, &[tank], Stance::Defend);
    let foe = quiet(&mut w, "E1", 1, 14, 30);
    run(&mut w, 12);
    assert_eq!(w.actors[tank].activity, Activity::Attack, "auto-target in range");
    teleport(&mut w, foe, 45, 50);
    run(&mut w, 4);
    assert_eq!(w.actors[tank].activity, Activity::Idle);
    assert_eq!((w.actors[tank].x, w.actors[tank].y), (cell_center(10), cell_center(30)), "it never moved");
}

// ---- Simultaneous fire ---------------------------------------------------------------

/// The `mirror_fight` example's `am_vs_am`: two equal armies, one the exact
/// mirror image of the other, attack-move into each other.
fn mirrored_fight(seed: u64, pre_steps: u32) -> (usize, usize) {
    let comp = ["E1", "E1", "E1", "E1", "E1", "E1", "2TNK", "2TNK", "2TNK", "2TNK"];
    let mut map = Map::filled(64, 64, Terrain::Clear);
    map.spawns = vec![(4, 4), (56, 56)];
    let players = [PlayerSetup::new("allies", None), PlayerSetup::new("allies", None)];
    let mut w = World::on_map(seed, map, &players, GameOptions { fog: false, explored: true, ..GameOptions::default() });
    let mut armies: [Vec<usize>; 2] = [Vec::new(), Vec::new()];
    for (k, id) in comp.iter().enumerate() {
        let (da, db) = ((k as i32 % 4) - 2, (k as i32 / 4) - 1);
        let t = ty(&w, id);
        armies[0].push(w.spawn_unit(t, 0, cell_center(20 + da), cell_center(30 + db * 2), 256));
        armies[1].push(w.spawn_unit(t, 1, cell_center(33 - da), cell_center(30 + db * 2), 768));
    }
    run(&mut w, 1 + pre_steps);
    // Mirrored destinations too: column 34 and its mirror image 19 (columns
    // 20 + da and 33 - da mirror about 26.5).
    w.order_move(&armies[0], cell_center(34), cell_center(30), true);
    w.order_move(&armies[1], cell_center(19), cell_center(30), true);
    let alive = |w: &World, a: &[usize]| a.iter().filter(|&&i| w.actors[i].alive).count();
    for _ in 0..25 * 120 {
        w.step();
        if alive(&w, &armies[0]) == 0 || alive(&w, &armies[1]) == 0 {
            break;
        }
    }
    (alive(&w, &armies[0]), alive(&w, &armies[1]))
}

/// Mirrored armies used to be decided by the tick the fight started on
/// (processing order and a fixed scan interval: one side always shot and
/// scanned first, 10 of 10 fights for the same side at each tick shift).
/// Now shots of a tick land together, targeting reads where units stood when
/// the tick began, and auto-target scans come after random delays like
/// OpenRA's: over tick shifts 0 to 3 and 16 seeds each, both sides win
/// (the `mirror_fight` example measures the same on more seeds).
#[test]
fn mirrored_armies_are_not_decided_by_the_starting_tick() {
    let (mut wins, mut survivors) = ([0u32; 2], [0usize; 2]);
    for pre_steps in 0..4 {
        let mut shift_wins = [0u32; 2];
        for seed in 1..=16 {
            let (a, b) = mirrored_fight(seed, pre_steps);
            survivors[0] += a;
            survivors[1] += b;
            if a != b {
                shift_wins[usize::from(b > a)] += 1;
            }
        }
        assert!(shift_wins[0] < 16 && shift_wins[1] < 16, "tick shift {pre_steps}: one side won every fight {shift_wins:?}");
        wins[0] += shift_wins[0];
        wins[1] += shift_wins[1];
    }
    let decided = wins[0] + wins[1];
    assert!(3 * wins[0] >= decided && 3 * wins[1] >= decided, "wins per side over 64 mirrored fights: {wins:?}");
    let (a, b) = (survivors[0] as i64, survivors[1] as i64);
    assert!((a - b).abs() * 3 <= a.max(b) + 6, "survivors per side: {survivors:?}");
}

#[test]
fn instant_shots_of_one_tick_all_land() {
    // Two riflemen in range of each other, both ready, ordered to attack
    // each other: each kills the other in the same tick when one shot is
    // enough (it no longer depends on which one acts first).
    let mut w = field(8);
    let a = unit(&mut w, "E1", 0, 20, 30);
    let b = unit(&mut w, "E1", 1, 23, 30);
    run(&mut w, 3);
    w.actors[a].hp = 1;
    w.actors[b].hp = 1;
    w.order_attack(&[a], b, false);
    w.order_attack(&[b], a, false);
    for _ in 0..25 * 5 {
        w.step();
        if !w.actors[a].alive || !w.actors[b].alive {
            break;
        }
    }
    assert!(!w.actors[a].alive && !w.actors[b].alive, "both shots landed in the same tick");
}

// ---- Auto-target priorities -------------------------------------------------------------

#[test]
fn only_attack_anything_picks_plain_structures_itself() {
    let mut w = field(9);
    let tank = unit(&mut w, "2TNK", 0, 20, 30);
    let powr = w.spawn_building(ty(&w, "POWR"), 1, 22, 29).unwrap();
    for stance in [Stance::ReturnFire, Stance::Defend] {
        set_stance(&mut w, 0, &[tank], stance);
        run(&mut w, 25 * 2);
        assert_eq!(w.actors[tank].target, NONE, "{stance:?} leaves a power plant alone");
        assert_eq!(w.actors[powr].hp, max_hp(&w, powr));
    }
    // A defence is fair game under Defend (AutoTargetPriority@DEFAULT: Defense).
    let pbox = w.spawn_building(ty(&w, "PBOX"), 1, 17, 31).unwrap();
    w.actors[pbox].reload = [1_000_000; MAX_WEAPONS];
    run(&mut w, 25 * 2);
    assert_eq!(w.resolve(w.actors[tank].target), Some(pbox), "Defend takes on the pillbox");
    w.kill(pbox);
    // AttackAnything goes for the power plant too.
    set_stance(&mut w, 0, &[tank], Stance::AttackAnything);
    run(&mut w, 25 * 2);
    assert_eq!(w.resolve(w.actors[tank].target), Some(powr), "AttackAnything picks structures");
}

#[test]
fn attack_move_under_defend_passes_plain_structures() {
    let mut w = field(10);
    let tank = unit(&mut w, "2TNK", 0, 10, 30);
    set_stance(&mut w, 0, &[tank], Stance::Defend);
    let powr = w.spawn_building(ty(&w, "POWR"), 1, 20, 28).unwrap();
    w.order_move(&[tank], cell_center(40), cell_center(30), true);
    run(&mut w, 25 * 20);
    assert_eq!(w.actors[powr].hp, max_hp(&w, powr), "OpenRA attack-move keeps the stance's priorities");
}

// ---- Attack-move tip ------------------------------------------------------------------------

#[test]
fn move_hint_flags_plain_moves_past_visible_enemies() {
    let mut w = field(11);
    let tank = unit(&mut w, "2TNK", 0, 10, 30);
    let mcv = unit(&mut w, "MCV", 0, 10, 26);
    let spotter = quiet(&mut w, "E1", 0, 24, 31);
    quiet(&mut w, "E1", 1, 25, 33);
    run(&mut w, 3);
    let to = |cx: i32, cy: i32| (cell_center(cx), cell_center(cy));
    let (ex, ey) = to(40, 30);
    assert!(w.move_hint(0, &[tank], ex, ey), "the way east passes the rifleman");
    assert!(w.move_hint(0, &[tank, mcv], ex, ey), "armed units among others count");
    let (nx, ny) = to(10, 55);
    assert!(!w.move_hint(0, &[tank], nx, ny), "the way south stays clear of it");
    assert!(!w.move_hint(0, &[mcv], ex, ey), "nothing armed in the selection");
    assert!(!w.move_hint(1, &[tank], ex, ey), "only own units");
    // Out of sight it is no reason for the tip.
    w.kill(spotter);
    run(&mut w, 3);
    assert!(!w.move_hint(0, &[tank], ex, ey));
}

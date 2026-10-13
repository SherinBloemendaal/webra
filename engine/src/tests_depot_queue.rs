//! Tests for the service depot's line (service.rs): many units sent to one
//! depot are repaired one after another, first come first served, wait on
//! cells of their own (aircraft hover or circle), and leave for the rally
//! point or a free spot nearby. Synthetic maps only.

use crate::map::{Map, Terrain};
use crate::math::{dist, CELL};
use crate::movement::MovementModel;
use crate::rules::{Kind, Rules};
use crate::world::{cell_center, Activity, Order, SmartAction, World};

fn ty(w: &World, id: &str) -> u16 {
    w.rules.actor_index(id).unwrap() as u16
}

/// A 64x48 all-clear map, player 0 (Soviet, rich) and an enemy player 1 far away.
fn arena(model: MovementModel) -> World {
    let (wd, ht) = (64, 48);
    let n = (wd * ht) as usize;
    let map = Map {
        width: wd,
        height: ht,
        terrain: vec![Terrain::Clear; n],
        ore: vec![0; n],
        gems: vec![0; n],
        spawns: vec![(1, 1), (wd - 3, ht - 3)],
    };
    let mut w = World::empty(Rules::load(), map, 9);
    w.options.movement = model;
    w.stress = true;
    w.add_player(w.rules.faction_index("soviet").unwrap(), false, (1, 1));
    w.add_player(w.rules.faction_index("allies").unwrap(), false, (wd - 3, ht - 3));
    w.players[0].cash = 100_000;
    w
}

/// The depot at cells 30..33 x 20..23 (pad (31, 21)).
fn depot(w: &mut World) -> usize {
    w.spawn_building(ty(w, "FIX"), 0, 30, 20).unwrap()
}

/// `n` units of `id` at a quarter of their hit points west of the depot.
fn damaged(w: &mut World, id: &str, n: usize, x0: i32) -> Vec<usize> {
    let t = ty(w, id);
    let max = w.rules.actors[t as usize].hp;
    let air = w.rules.actors[t as usize].unit.as_ref().unwrap().aircraft.as_ref().map_or(0, |a| a.cruise_altitude);
    (0..n as i32)
        .map(|k| {
            let u = w.spawn_unit(t, 0, cell_center(x0 + k % 4), cell_center(14 + k / 4 * 2), 256);
            w.actors[u].hp = max / 4;
            w.actors[u].altitude = air;
            u
        })
        .collect()
}

fn send(w: &mut World, units: &[usize], fix: usize) {
    let ids = units.iter().map(|&u| w.make_ref(u)).collect();
    let (x, y) = (w.actors[fix].x, w.actors[fix].y);
    w.queue_order(Order::Smart { player: 0, ids, x, y });
}

fn max_hp(w: &World, u: usize) -> i32 {
    w.rules.actors[w.actors[u].ty as usize].hp
}

/// What a run of a line looked like.
struct Run {
    /// Tick each unit was fully repaired, in unit order.
    done: Vec<u32>,
    /// Tick each unit got in line.
    joined: Vec<u32>,
}

/// Step until every unit is repaired (at most `limit` ticks), checking that
/// at most one unit is repaired at a time, that nobody leaves the line before
/// it is repaired, and that ground units waiting their turn never share a cell.
fn run_line(w: &mut World, units: &[usize], limit: u32) -> Run {
    let n = units.len();
    let mut done = vec![0u32; n];
    let mut joined = vec![0u32; n];
    let mut hps: Vec<i32> = units.iter().map(|&u| w.actors[u].hp).collect();
    for tick in 1..=limit {
        w.step();
        let now: Vec<i32> = units.iter().map(|&u| w.actors[u].hp).collect();
        // Depot steps heal 1000 (or what is left); ore trucks also heal
        // themselves slowly (SelfHealing, 100 a second), which does not count.
        let healed = now.iter().zip(&hps).filter(|(n, h)| **n - **h > 100).count();
        assert!(healed <= 1, "tick {tick}: {healed} units repaired at once");
        hps = now;
        let mut waiting_cells = Vec::new();
        for (k, &u) in units.iter().enumerate() {
            let a = &w.actors[u];
            if a.svc.ticket != 0 && joined[k] == 0 {
                joined[k] = (a.svc.ticket >> 32) as u32;
            }
            if a.hp >= max_hp(w, u) {
                if done[k] == 0 {
                    done[k] = tick;
                }
                continue;
            }
            assert_eq!(a.activity, Activity::Repair, "tick {tick}: unit {k} left the line unrepaired");
            if a.kind != Kind::Aircraft && a.svc.slot != crate::world::NONE && w.waits_on_slot(u) {
                assert!(!waiting_cells.contains(&a.svc.slot), "tick {tick}: two units wait on one cell");
                waiting_cells.push(a.svc.slot);
            }
        }
        if done.iter().all(|&d| d > 0) {
            return Run { done, joined };
        }
    }
    let left: Vec<_> = units.iter().map(|&u| (w.actors[u].activity, w.cell_of(w.actors[u].x, w.actors[u].y), w.actors[u].hp)).collect();
    panic!("{:?}: not all repaired in {limit} ticks: {left:?}", w.options.movement);
}

/// Units are repaired in the order they got in line.
fn assert_first_come_first_served(run: &Run) {
    let mut order: Vec<usize> = (0..run.done.len()).collect();
    order.sort_by_key(|&k| run.done[k]);
    let joins: Vec<u32> = order.iter().map(|&k| run.joined[k]).collect();
    assert!(joins.windows(2).all(|p| p[0] <= p[1]), "served out of turn: joined {joins:?} in the order served");
}

/// Step `ticks`, then every unit is idle and keeps still for two seconds.
fn settle(w: &mut World, units: &[usize], ticks: u32) {
    for _ in 0..ticks {
        w.step();
    }
    let before: Vec<(i32, i32)> = units.iter().map(|&u| (w.actors[u].x, w.actors[u].y)).collect();
    for _ in 0..50 {
        w.step();
    }
    for (k, &u) in units.iter().enumerate() {
        let a = &w.actors[u];
        if w.is_plane(u) {
            continue; // planes circle
        }
        assert_eq!(a.activity, Activity::Idle, "unit {k} still busy");
        assert_eq!((a.x, a.y), before[k], "unit {k} still moving");
    }
}

/// No ground unit stands on the pad or on a corridor straight out of it.
fn assert_way_clear(w: &World, units: &[usize]) {
    for &u in units {
        let a = &w.actors[u];
        if a.kind == Kind::Aircraft {
            continue;
        }
        let (cx, cy) = w.cell_of(a.x, a.y);
        let (dx, dy) = (cx - 31, cy - 21);
        assert!(!((dx == 0 || dy == 0) && dx.abs().max(dy.abs()) <= 3), "a repaired unit stands in the way at {:?}", (cx, cy));
    }
}

fn ten_tanks(model: MovementModel) {
    let mut w = arena(model);
    let fix = depot(&mut w);
    let tanks = damaged(&mut w, "2TNK", 10, 8);
    send(&mut w, &tanks, fix);
    let run = run_line(&mut w, &tanks, 25 * 240);
    assert_first_come_first_served(&run);
    let total = *run.done.iter().max().unwrap();
    eprintln!("{model:?}: ten tanks repaired in {total} ticks ({} s)", total / 25);
    // About 280 ticks of repair each (35 steps of 8 ticks), little lost between turns.
    assert!(total < 10 * 380, "{model:?}: ten tanks took {total} ticks");
    settle(&mut w, &tanks, 25 * 20);
    assert_way_clear(&w, &tanks);
    for &t in &tanks {
        let (cx, cy) = w.cell_of(w.actors[t].x, w.actors[t].y);
        assert!((cx - 31).abs().max((cy - 21).abs()) <= 6, "repaired tanks stay next to the depot: {:?}", (cx, cy));
    }
}

#[test]
fn ten_tanks_are_repaired_one_after_another_openra() {
    ten_tanks(MovementModel::OpenRA);
}

#[test]
fn ten_tanks_are_repaired_one_after_another_webra() {
    ten_tanks(MovementModel::WebRA);
}

fn ten_helicopters(model: MovementModel) {
    let mut w = arena(model);
    let fix = depot(&mut w);
    let helis = damaged(&mut w, "HIND", 10, 8);
    send(&mut w, &helis, fix);
    // Waiting helicopters hover apart from each other.
    let mut checked = false;
    for _ in 0..25 * 12 {
        w.step();
        let hovering: Vec<usize> = helis.iter().copied().filter(|&h| w.actors[h].svc.slot != crate::world::NONE).collect();
        if hovering.len() >= 8 {
            for (k, &a) in hovering.iter().enumerate() {
                for &b in &hovering[k + 1..] {
                    assert_ne!(w.actors[a].svc.slot, w.actors[b].svc.slot, "two helicopters wait over one cell");
                }
            }
            checked = true;
        }
    }
    assert!(checked, "{model:?}: the helicopters got waiting spots");
    let run = run_line(&mut w, &helis, 25 * 120);
    assert_first_come_first_served(&run);
    eprintln!("{model:?}: ten helicopters repaired in {} ticks", run.done.iter().max().unwrap() + 25 * 12);
    settle(&mut w, &helis, 25 * 10);
    for &h in &helis {
        assert!(w.actors[h].altitude > 0, "repaired helicopters hover");
        assert!(dist(w.actors[h].x, w.actors[h].y, cell_center(31), cell_center(21)) <= 6 * CELL, "and stay nearby");
    }
}

#[test]
fn ten_helicopters_are_repaired_one_after_another_openra() {
    ten_helicopters(MovementModel::OpenRA);
}

#[test]
fn ten_helicopters_are_repaired_one_after_another_webra() {
    ten_helicopters(MovementModel::WebRA);
}

#[test]
fn planes_land_on_the_depot_in_turn_and_fly_home_once_repaired() {
    let mut w = arena(MovementModel::WebRA);
    let fix = depot(&mut w);
    let afld = w.spawn_building(ty(&w, "AFLD"), 0, 10, 30).unwrap();
    let planes = damaged(&mut w, "MIG", 10, 8);
    w.step();
    let (x, y) = (w.actors[fix].x, w.actors[fix].y);
    assert_eq!(w.smart_action(0, &planes, x, y), SmartAction::Repair, "planes repair at the service depot (OpenRA ^Plane Repairable)");
    send(&mut w, &planes, fix);
    let run = run_line(&mut w, &planes, 25 * 120);
    assert_first_come_first_served(&run);
    eprintln!("ten MiGs repaired in {} ticks", run.done.iter().max().unwrap());
    for _ in 0..25 * 30 {
        w.step();
    }
    let (ax, ay) = (w.actors[afld].x, w.actors[afld].y);
    let parked = planes.iter().filter(|&&p| w.actors[p].altitude == 0 && (w.actors[p].x, w.actors[p].y) == (ax, ay)).count();
    assert_eq!(parked, 1, "one parks on the free airfield");
    for &p in &planes {
        let a = &w.actors[p];
        assert_eq!(a.activity, Activity::Idle);
        if a.altitude > 0 {
            assert_eq!(a.air.phase, crate::plane::Phase::Returning, "the others circle until an airfield is free");
        }
    }
}

#[test]
fn a_mixed_line_shares_the_one_pad() {
    for model in MovementModel::ALL {
        let mut w = arena(model);
        let fix = depot(&mut w);
        let mut units = damaged(&mut w, "2TNK", 3, 8);
        units.extend(damaged(&mut w, "HARV", 1, 12));
        units.extend(damaged(&mut w, "MCV", 1, 13));
        units.extend(damaged(&mut w, "HIND", 3, 5));
        units.extend(damaged(&mut w, "YAK", 2, 4));
        send(&mut w, &units, fix);
        let run = run_line(&mut w, &units, 25 * 240);
        assert_first_come_first_served(&run);
    }
}

#[test]
fn the_line_breaks_up_when_the_depot_is_destroyed() {
    for model in MovementModel::ALL {
        let mut w = arena(model);
        let fix = depot(&mut w);
        let mut units = damaged(&mut w, "2TNK", 6, 8);
        units.extend(damaged(&mut w, "HIND", 2, 5));
        units.extend(damaged(&mut w, "MIG", 1, 4));
        send(&mut w, &units, fix);
        for _ in 0..25 * 30 {
            w.step();
        }
        assert!(units.iter().any(|&u| w.actors[u].hp == max_hp(&w, u)), "{model:?}: someone was repaired");
        assert!(units.iter().any(|&u| w.actors[u].hp < max_hp(&w, u)), "{model:?}: someone still waits");
        w.damage(fix, 10_000_000);
        assert!(!w.actors[fix].alive);
        settle(&mut w, &units, 25 * 3);
        for &u in &units {
            if w.actors[u].kind == Kind::Aircraft {
                assert!(w.actors[u].altitude > 0, "{model:?}: aircraft take off");
            }
            let (cx, cy) = w.cell_of(w.actors[u].x, w.actors[u].y);
            assert!((cx - 31).abs().max((cy - 21).abs()) <= 12, "{model:?}: units stop where they were");
        }
    }
}

#[test]
fn without_money_the_unit_on_the_pad_waits_and_the_line_with_it() {
    let mut w = arena(MovementModel::OpenRA);
    let fix = depot(&mut w);
    let tanks = damaged(&mut w, "2TNK", 3, 8);
    w.players[0].cash = 30;
    w.players[0].resources = 0;
    send(&mut w, &tanks, fix);
    for _ in 0..25 * 40 {
        w.step();
    }
    assert_eq!(w.players[0].cash, 0, "spent what there was");
    let hps: Vec<i32> = tanks.iter().map(|&t| w.actors[t].hp).collect();
    for _ in 0..25 * 20 {
        w.step();
    }
    assert_eq!(hps, tanks.iter().map(|&t| w.actors[t].hp).collect::<Vec<_>>(), "no repair without money");
    for &t in &tanks {
        assert_eq!(w.actors[t].activity, Activity::Repair, "nobody gives up (OpenRA keeps trying)");
    }
    assert_eq!(tanks.iter().filter(|&&t| w.on_repair_pad(t)).count(), 1, "one stays on the pad");
    w.players[0].cash = 10_000;
    run_line(&mut w, &tanks, 25 * 120);
}

#[test]
fn a_repair_step_costs_and_heals_as_openra() {
    let mut w = arena(MovementModel::OpenRA);
    let fix = depot(&mut w);
    let t = damaged(&mut w, "2TNK", 1, 30)[0];
    send(&mut w, &[t], fix);
    let mut steps = Vec::new();
    let mut hp = w.actors[t].hp;
    let mut cash = w.players[0].cash;
    for tick in 0..600u32 {
        w.step();
        if w.actors[t].hp > hp {
            steps.push((tick, w.actors[t].hp - hp, cash - w.players[0].cash));
            hp = w.actors[t].hp;
            cash = w.players[0].cash;
        }
    }
    // FIX RepairsUnits: HpPerStep 1000, Interval 7 (a step every 8 ticks),
    // ValuePercentage 20: max(1, 1000 * 850 * 20 / (46000 * 100)) = 3.
    assert!(steps.len() >= 5);
    for p in steps.windows(2) {
        assert_eq!(p[1].0 - p[0].0, 8, "a step every Interval + 1 ticks");
    }
    // The last step heals what is left, for the full price (OpenRA heals HpPerStep, capped at MaxHP).
    assert_eq!(w.actors[t].hp, 46000, "fully repaired");
    let (last, full) = steps.split_last().unwrap();
    assert!(full.iter().all(|s| s.1 == 1000 && s.2 == 3), "{steps:?}");
    assert_eq!((last.1, last.2), (500, 3), "{steps:?}");
}

#[test]
fn repaired_units_go_to_the_depots_rally_point() {
    for model in MovementModel::ALL {
        let mut w = arena(model);
        let fix = depot(&mut w);
        let mut units = damaged(&mut w, "2TNK", 3, 8);
        units.extend(damaged(&mut w, "HIND", 1, 5));
        let r = w.make_ref(fix);
        w.queue_order(Order::Rally { player: 0, building: r, x: cell_center(44), y: cell_center(36) });
        w.step();
        assert_eq!(w.actors[fix].rally, Some((cell_center(44), cell_center(36))), "the depot takes a rally point");
        assert!(w.shows_rally_to(fix, 0), "shown like a factory's");
        send(&mut w, &units, fix);
        run_line(&mut w, &units, 25 * 120);
        settle(&mut w, &units, 25 * 30);
        for &u in &units {
            let d = dist(w.actors[u].x, w.actors[u].y, cell_center(44), cell_center(36));
            assert!(d <= 3 * CELL, "{model:?}: at the rally point ({d})");
        }
    }
}

#[test]
fn undamaged_units_get_the_blocked_cursor_and_stay_put() {
    let mut w = arena(MovementModel::WebRA);
    let fix = depot(&mut w);
    let t = w.spawn_unit(ty(&w, "2TNK"), 0, cell_center(10), cell_center(10), 0);
    let h = w.spawn_unit(ty(&w, "HIND"), 0, cell_center(12), cell_center(10), 0);
    w.actors[h].altitude = 1000;
    w.step();
    let (x, y) = (w.actors[fix].x, w.actors[fix].y);
    assert_eq!(w.smart_action(0, &[t], x, y), SmartAction::EnterBlocked);
    assert_eq!(w.smart_action(0, &[h], x, y), SmartAction::EnterBlocked);
    let before = [(w.actors[t].x, w.actors[t].y), (w.actors[h].x, w.actors[h].y)];
    send(&mut w, &[t, h], fix);
    for _ in 0..50 {
        w.step();
    }
    assert_eq!(before, [(w.actors[t].x, w.actors[t].y), (w.actors[h].x, w.actors[h].y)], "nothing to repair: no order (OpenRA)");
}

#[test]
fn the_line_is_deterministic() {
    for model in MovementModel::ALL {
        let hashes: Vec<Vec<u64>> = (0..2)
            .map(|_| {
                let mut w = arena(model);
                let fix = depot(&mut w);
                let mut units = damaged(&mut w, "2TNK", 6, 8);
                units.extend(damaged(&mut w, "HIND", 3, 5));
                units.extend(damaged(&mut w, "YAK", 2, 4));
                send(&mut w, &units, fix);
                (0..40)
                    .map(|_| {
                        for _ in 0..50 {
                            w.step();
                        }
                        w.state_hash()
                    })
                    .collect()
            })
            .collect();
        assert_eq!(hashes[0], hashes[1], "{model:?}: same state hashes in both runs");
    }
}

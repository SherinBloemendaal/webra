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

/// A smart order on the depot's left arm (its centre is the pad, where a
/// unit being repaired would be clicked instead).
fn send(w: &mut World, units: &[usize], fix: usize) {
    let ids = units.iter().map(|&u| w.make_ref(u)).collect();
    let (x, y) = (w.actors[fix].x - CELL, w.actors[fix].y);
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
    let (x, y) = (w.actors[fix].x - CELL, w.actors[fix].y);
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

#[test]
fn a_plane_ordered_again_on_the_pad_keeps_it_and_nobody_else_is_called() {
    let mut w = arena(MovementModel::WebRA);
    let fix = depot(&mut w);
    let planes = damaged(&mut w, "MIG", 3, 8);
    send(&mut w, &planes, fix);
    let on_pad = |w: &World| planes.iter().copied().find(|&p| w.actors[p].altitude == 0 && w.on_repair_pad(p));
    for _ in 0..25 * 60 {
        w.step();
        if on_pad(&w).is_some_and(|p| w.actors[p].hp > max_hp(&w, p) / 2) {
            break;
        }
    }
    let p = on_pad(&w).expect("a plane is being repaired on the pad");
    let ticket = w.actors[p].svc.ticket;
    // Clicked onto the depot again while it is on the pad (at the top of
    // the depot: the plane's own outline covers the arms next to the pad).
    let (x, y) = (w.actors[fix].x, w.actors[fix].y - 1400);
    assert_eq!(w.actor_at(0, x, y), Some(fix));
    let ids = vec![w.make_ref(p)];
    w.queue_order(Order::Smart { player: 0, ids, x, y });
    let hp = w.actors[p].hp;
    for _ in 0..25 * 3 {
        w.step();
        if w.actors[p].hp == max_hp(&w, p) {
            break;
        }
        assert_eq!(w.actors[fix].dock_user, w.make_ref(p), "the plane keeps the pad");
        for &o in &planes {
            assert!(o == p || !w.on_repair_pad(o), "nobody else is called onto the occupied pad");
        }
    }
    assert!(w.actors[p].hp > hp, "repaired on");
    assert!(w.actors[p].hp == max_hp(&w, p) || w.actors[p].svc.ticket == ticket, "same place in line");
    run_line(&mut w, &planes, 25 * 60);
}

#[test]
fn ordering_a_unit_in_line_to_the_same_depot_again_keeps_its_place() {
    for model in MovementModel::ALL {
        let mut w = arena(model);
        let fix = depot(&mut w);
        let tanks = damaged(&mut w, "2TNK", 4, 8);
        send(&mut w, &tanks, fix);
        let mut holder = None;
        for _ in 0..25 * 60 {
            w.step();
            holder = tanks.iter().copied().find(|&t| w.on_repair_pad(t) && w.actors[t].hp > max_hp(&w, t) / 2);
            if holder.is_some() {
                break;
            }
        }
        let h = holder.expect("someone on the pad");
        let waiting: Vec<usize> = tanks.iter().copied().filter(|&t| t != h && w.actors[t].svc.ticket != 0).collect();
        assert!(!waiting.is_empty());
        let tickets: Vec<u64> = waiting.iter().map(|&t| w.actors[t].svc.ticket).collect();
        // Everyone (the one on the pad too) clicked onto the same depot again.
        send(&mut w, &tanks, fix);
        for _ in 0..25 * 2 {
            w.step();
            assert_eq!(w.actors[fix].dock_user, w.make_ref(h), "{model:?}: the one on the pad keeps it");
        }
        assert_eq!(tickets, waiting.iter().map(|&t| w.actors[t].svc.ticket).collect::<Vec<_>>(), "{model:?}: places kept");
        run_line(&mut w, &tanks, 25 * 120);
    }
}

#[test]
fn two_depots_side_by_side_never_wait_in_each_others_way() {
    for model in MovementModel::ALL {
        let mut w = arena(model);
        let a = w.spawn_building(ty(&w, "FIX"), 0, 24, 20).unwrap();
        let b = w.spawn_building(ty(&w, "FIX"), 0, 30, 20).unwrap();
        // A war factory whose exit faces the second depot's waiting cells.
        let weap = w.spawn_building(ty(&w, "WEAP"), 0, 34, 15).unwrap();
        let pads = [w.repair_pad_cell(a), w.repair_pad_cell(b)];
        let mut left = damaged(&mut w, "2TNK", 6, 8);
        let mut right = damaged(&mut w, "2TNK", 6, 44);
        send(&mut w, &left, a);
        send(&mut w, &right, b);
        let wi = &w.rules.actors[w.actors[weap].ty as usize].building.as_ref().unwrap().clone();
        let exit_front: Vec<(i32, i32)> = wi.exits.iter().map(|&(ex, ey)| (34 + ex, 15 + ey + 1)).collect();
        let mut all = Vec::new();
        all.append(&mut left);
        all.append(&mut right);
        for _ in 0..25 * 200 {
            w.step();
            for &u in &all {
                let s = w.actors[u].svc.slot;
                if s == crate::world::NONE || w.actors[u].activity != Activity::Repair {
                    continue;
                }
                let (sx, sy) = (s as i32 % 64, s as i32 / 64);
                for &p in &pads {
                    let (dx, dy) = (sx - p as i32 % 64, sy - p as i32 / 64);
                    assert!(!((dx == 0 || dy == 0) && dx.abs().max(dy.abs()) <= 3), "{model:?}: a waiting cell on a depot's corridor");
                }
                assert!(!exit_front.contains(&(sx, sy)), "{model:?}: a waiting cell in front of the factory exit");
            }
            if all.iter().all(|&u| w.actors[u].hp == max_hp(&w, u)) {
                break;
            }
        }
        assert!(all.iter().all(|&u| w.actors[u].hp == max_hp(&w, u)), "{model:?}: both lines were served");
    }
}

#[test]
fn a_minelayer_reloading_waits_in_the_line() {
    let mut w = arena(MovementModel::OpenRA);
    let fix = depot(&mut w);
    let tanks = damaged(&mut w, "2TNK", 2, 26);
    send(&mut w, &tanks, fix);
    for _ in 0..25 * 10 {
        w.step();
    }
    assert!(tanks.iter().any(|&t| w.on_repair_pad(t)), "a tank holds the pad");
    let ml = w.spawn_unit(ty(&w, "MNLY"), 0, cell_center(20), cell_center(30), 0);
    w.actors[ml].ab.ammo = 1;
    let ids = vec![w.make_ref(ml)];
    w.queue_order(Order::LayMines { player: 0, ids, x0: 18, y0: 34, x1: 19, y1: 34 });
    let mut joined = false;
    for _ in 0..25 * 200 {
        w.step();
        if w.actors[ml].activity == Activity::Repair {
            joined = true;
            let holder = w.resolve(w.actors[fix].dock_user);
            if holder != Some(ml) {
                let (cx, cy) = w.cell_of(w.actors[ml].x, w.actors[ml].y);
                assert_ne!((cx, cy), (31, 21), "not onto the pad while another unit holds it");
            }
        }
    }
    assert!(joined, "the minelayer went to reload in the depot's line");
    let max = w.rules.actors[w.actors[ml].ty as usize].abilities.minelayer.as_ref().unwrap().ammo;
    assert_eq!(w.actors[ml].ab.ammo, max - 1, "reloaded, then laid the second mine");
}

#[test]
fn a_unit_that_left_the_line_and_stops_on_the_depot_gets_back_in_at_the_end() {
    let mut w = arena(MovementModel::WebRA);
    let fix = depot(&mut w);
    let tanks = damaged(&mut w, "2TNK", 5, 8);
    send(&mut w, &tanks, fix);
    let waiting = |w: &World| -> Vec<usize> {
        tanks
            .iter()
            .copied()
            .filter(|&t| w.actors[t].svc.ticket != 0 && !w.on_repair_pad(t) && w.actors[t].activity == Activity::Repair)
            .collect()
    };
    for _ in 0..25 * 60 {
        w.step();
        if waiting(&w).len() >= 3 {
            break;
        }
    }
    // The first in line (lowest ticket) moves off, onto the depot's left arm.
    let first = waiting(&w).into_iter().min_by_key(|&t| w.actors[t].svc.ticket).unwrap();
    let old_ticket = w.actors[first].svc.ticket;
    move_to(&mut w, first, 30, 21);
    let mut back = false;
    for _ in 0..25 * 30 {
        w.step();
        if w.actors[first].activity == Activity::Repair && w.actors[first].svc.ticket != 0 {
            back = true;
            break;
        }
    }
    assert!(back, "idle and damaged on the depot: it gets back in line");
    let t = w.actors[first].svc.ticket;
    assert!(t > old_ticket, "with a fresh ticket");
    for &o in &waiting(&w) {
        assert!(o == first || w.actors[o].svc.ticket < t, "behind everyone who was waiting");
    }
    run_line(&mut w, &tanks, 25 * 200);
}

fn move_to(w: &mut World, u: usize, cx: i32, cy: i32) {
    let ids = vec![w.make_ref(u)];
    w.queue_order(Order::Move { player: 0, ids, x: cell_center(cx), y: cell_center(cy), attack_move: false });
}

#[test]
fn minelayers_reload_only_on_the_pad_they_hold() {
    let mut w = arena(MovementModel::WebRA);
    let fix = depot(&mut w);
    // Idle on the depot's pad, out of mines: no reload (OpenRA reloads in Resupply only).
    let a = w.spawn_unit(ty(&w, "MNLY"), 0, cell_center(31), cell_center(21), 0);
    w.actors[a].ab.ammo = 0;
    for _ in 0..25 * 10 {
        w.step();
        assert_eq!(w.actors[a].ab.ammo, 0, "no reload off a held pad");
    }
    // Sent to the depot to reload: it reloads once called to the pad.
    let ids = vec![w.make_ref(a)];
    let (x, y) = (w.actors[fix].x - CELL, w.actors[fix].y);
    w.queue_order(Order::Smart { player: 0, ids, x, y });
    for _ in 0..25 * 60 {
        w.step();
        if w.actors[a].ab.ammo > 0 {
            assert!(w.on_repair_pad(a) || w.actors[a].activity != Activity::Repair, "reloads only holding the pad");
        }
    }
    let max = w.rules.actors[w.actors[a].ty as usize].abilities.minelayer.as_ref().unwrap().ammo;
    assert_eq!(w.actors[a].ab.ammo, max, "reloaded in the line");
}

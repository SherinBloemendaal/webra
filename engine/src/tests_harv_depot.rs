//! Ore trucks at the service depot (service.rs, repair.rs): every way a
//! player sends one there, in both movement models. A damaged truck is
//! repaired whatever it was doing (idle, harvesting, full, on its way to
//! the refinery, unloading) and goes back to work afterwards; an undamaged
//! one gets the blocked cursor and the order is ignored (OpenRA Repairable).
//! Synthetic maps only.

use crate::map::{Map, Terrain};
use crate::movement::MovementModel;
use crate::rules::Rules;
use crate::selection::Rect;
use crate::world::{cell_center, Activity, HarvState, Order, SmartAction, World, NONE};

fn ty(w: &World, id: &str) -> u16 {
    w.rules.actor_index(id).unwrap() as u16
}

/// Player 0's base on a 64x48 map: a service depot at cells 30..33 x
/// 20..23 (pad (31, 21)), a refinery at (12, 30) and an ore field south of
/// it; an enemy far away.
struct Base {
    w: World,
    fix: usize,
    proc_: usize,
}

fn base(model: MovementModel) -> Base {
    let (wd, ht) = (64, 48);
    let n = (wd * ht) as usize;
    let mut map = Map {
        width: wd,
        height: ht,
        terrain: vec![Terrain::Clear; n],
        ore: vec![0; n],
        gems: vec![0; n],
        spawns: vec![(1, 1), (wd - 3, ht - 3)],
    };
    for y in 36..42 {
        for x in 18..26 {
            map.ore[(y * wd + x) as usize] = 12;
        }
    }
    let mut w = World::empty(Rules::load(), map, 9);
    w.options.movement = model;
    w.stress = true;
    w.add_player(w.rules.faction_index("soviet").unwrap(), false, (1, 1));
    w.add_player(w.rules.faction_index("allies").unwrap(), false, (wd - 3, ht - 3));
    w.players[0].cash = 100_000;
    let fix = w.spawn_building(ty(&w, "FIX"), 0, 30, 20).unwrap();
    let proc_ = w.spawn_building_with(ty(&w, "PROC"), 0, 12, 30, false, false).unwrap();
    w.players[0].explored.fill(1);
    Base { w, fix, proc_ }
}

/// An ore truck of the refinery at cell (cx, cy), harvesting.
fn harv(b: &mut Base, cx: i32, cy: i32) -> usize {
    let t = ty(&b.w, "HARV");
    let h = b.w.spawn_unit(t, 0, cell_center(cx), cell_center(cy), 256);
    let rref = b.w.make_ref(b.proc_);
    let a = &mut b.w.actors[h];
    a.refinery = rref;
    a.activity = Activity::Harvest;
    a.harv = HarvState::Search;
    h
}

fn tank(b: &mut Base, cx: i32, cy: i32) -> usize {
    let t = ty(&b.w, "2TNK");
    b.w.spawn_unit(t, 0, cell_center(cx), cell_center(cy), 256)
}

fn max_hp(w: &World, u: usize) -> i32 {
    w.rules.actors[w.actors[u].ty as usize].hp
}

fn damage(b: &mut Base, u: usize) {
    b.w.actors[u].hp = max_hp(&b.w, u) / 3;
}

/// Where a player clicks: the middle of the depot (its pad).
fn depot_point(b: &Base) -> (i32, i32) {
    b.w.repair_pad_point(b.fix)
}

/// A smart order (right click, or left click in the default mouse style)
/// on the depot with `units` selected.
fn click_depot(b: &mut Base, units: &[usize]) {
    let (x, y) = depot_point(b);
    let ids = units.iter().map(|&u| b.w.make_ref(u)).collect();
    b.w.queue_order(Order::Smart { player: 0, ids, x, y });
    b.w.step();
}

/// Step until `pred` holds (at most `limit` ticks).
fn until(b: &mut Base, limit: u32, what: &str, pred: impl Fn(&World) -> bool) {
    for _ in 0..limit {
        if pred(&b.w) {
            return;
        }
        b.w.step();
    }
    panic!("{:?}: {what} not within {limit} ticks", b.w.options.movement);
}

fn harvesting(w: &World, h: usize) -> bool {
    w.actors[h].activity == Activity::Harvest && matches!(w.actors[h].harv, HarvState::ToOre | HarvState::Harvesting)
}

/// Unit `u` is in the depot's line now, is repaired to full on its pad and
/// leaves it; an ore truck then goes back to harvesting on its own.
fn assert_repaired(b: &mut Base, u: usize) {
    let model = b.w.options.movement;
    assert_eq!(b.w.actors[u].activity, Activity::Repair, "{model:?}: sent to the depot");
    let pad = b.w.repair_pad_cell(b.fix) as usize;
    let mut on_pad = false;
    for _ in 0..25 * 120 {
        b.w.step();
        let a = &b.w.actors[u];
        on_pad |= b.w.cell_index(a.x, a.y) == pad && a.activity == Activity::Repair;
        if a.hp >= max_hp(&b.w, u) {
            break;
        }
        assert_eq!(a.activity, Activity::Repair, "{model:?}: left the line unrepaired");
    }
    assert_eq!(b.w.actors[u].hp, max_hp(&b.w, u), "{model:?}: repaired to full");
    assert!(on_pad, "{model:?}: repaired on the depot's pad");
    until(b, 25 * 10, "off the pad", |w| w.cell_index(w.actors[u].x, w.actors[u].y) != pad);
    if b.w.is_harvester(u) {
        until(b, 25 * 30, "back to harvesting", |w| harvesting(w, u));
    }
}

/// What the truck is doing when the player sends it to the depot.
#[derive(Clone, Copy, Debug)]
enum Doing {
    Idle,
    Harvesting,
    /// Full, on its way to the refinery.
    Returning,
    /// On the refinery's dock, unloading.
    Unloading,
}

fn get_to(b: &mut Base, h: usize, doing: Doing) {
    match doing {
        Doing::Idle => {
            b.w.step();
            b.w.actors[h].activity = Activity::Idle;
        }
        Doing::Harvesting => until(b, 25 * 60, "harvesting", |w| w.actors[h].harv == HarvState::Harvesting),
        Doing::Returning => {
            until(b, 25 * 200, "full", |w| w.actors[h].harv == HarvState::ToDock);
            // A few steps on its way.
            for _ in 0..10 {
                b.w.step();
            }
            assert_eq!(b.w.actors[h].harv, HarvState::ToDock);
        }
        Doing::Unloading => until(b, 25 * 300, "unloading", |w| w.actors[h].harv == HarvState::Unloading),
    }
}

#[test]
fn a_damaged_ore_truck_clicked_onto_the_depot_is_repaired_whatever_it_was_doing() {
    for model in MovementModel::ALL {
        for doing in [Doing::Idle, Doing::Harvesting, Doing::Returning, Doing::Unloading] {
            let mut b = base(model);
            let h = harv(&mut b, 20, 26);
            get_to(&mut b, h, doing);
            damage(&mut b, h);
            let bales = b.w.actors[h].bales;
            let (x, y) = depot_point(&b);
            assert_eq!(b.w.smart_action(0, &[h], x, y), SmartAction::Repair, "{model:?} {doing:?}: the repair cursor");
            click_depot(&mut b, &[h]);
            // Off the refinery's dock: another truck may unload now.
            assert_eq!(b.w.actors[b.proc_].dock_user, NONE, "{model:?} {doing:?}: the dock is free");
            assert!(b.w.actors[h].bales <= bales, "{model:?} {doing:?}: keeps its load");
            assert_repaired(&mut b, h);
        }
    }
}

#[test]
fn ore_trucks_and_tanks_selected_together_are_all_repaired() {
    for model in MovementModel::ALL {
        let mut b = base(model);
        let h = harv(&mut b, 20, 26);
        let t1 = tank(&mut b, 22, 14);
        let t2 = tank(&mut b, 24, 14);
        get_to(&mut b, h, Doing::Harvesting);
        for u in [h, t1, t2] {
            damage(&mut b, u);
        }
        let (x, y) = depot_point(&b);
        assert_eq!(b.w.smart_action(0, &[t1, h, t2], x, y), SmartAction::Repair);
        click_depot(&mut b, &[t1, h, t2]);
        for u in [h, t1, t2] {
            assert_eq!(b.w.actors[u].activity, Activity::Repair, "{model:?}: in line");
        }
        until(&mut b, 25 * 240, "all repaired", |w| [h, t1, t2].iter().all(|&u| w.actors[u].hp >= max_hp(w, u)));
        until(&mut b, 25 * 30, "the truck back to harvesting", |w| harvesting(w, h));
    }
}

/// OpenRA Repairable.ResolveOrder ignores the order of a unit with nothing
/// to repair: in a mixed selection the undamaged ore truck keeps harvesting
/// while the damaged tank goes to the depot.
#[test]
fn an_undamaged_ore_truck_in_a_mixed_selection_keeps_harvesting() {
    for model in MovementModel::ALL {
        let mut b = base(model);
        let h = harv(&mut b, 20, 26);
        let t = tank(&mut b, 22, 14);
        get_to(&mut b, h, Doing::Harvesting);
        damage(&mut b, t);
        let (x, y) = depot_point(&b);
        assert_eq!(b.w.smart_action(0, &[h, t], x, y), SmartAction::Repair);
        click_depot(&mut b, &[h, t]);
        assert_eq!(b.w.actors[h].activity, Activity::Harvest, "{model:?}: the truck ignores the order");
        assert_eq!(b.w.actors[h].harv, HarvState::Harvesting, "{model:?}: and keeps harvesting");
        assert_repaired(&mut b, t);
    }
}

/// The blocked cursor over the depot for an undamaged ore truck, and the
/// click changes nothing (OpenRA EnterAlliedActorTargeter EnterBlockedCursor,
/// Repairable ignores the order).
#[test]
fn an_undamaged_ore_truck_gets_the_blocked_cursor_and_goes_on_harvesting() {
    for model in MovementModel::ALL {
        for doing in [Doing::Idle, Doing::Harvesting] {
            let mut b = base(model);
            let h = harv(&mut b, 20, 26);
            get_to(&mut b, h, doing);
            let before = (b.w.actors[h].activity, b.w.actors[h].harv);
            let (x, y) = depot_point(&b);
            assert_eq!(b.w.smart_action(0, &[h], x, y), SmartAction::EnterBlocked, "{model:?} {doing:?}");
            click_depot(&mut b, &[h]);
            let a = &b.w.actors[h];
            assert_eq!((a.activity, a.harv), before, "{model:?} {doing:?}: the order is ignored");
            for _ in 0..25 * 10 {
                b.w.step();
                assert_ne!(b.w.actors[h].activity, Activity::Repair, "{model:?} {doing:?}: never sent to the depot");
            }
            assert_eq!(b.w.actors[h].svc.ticket, 0);
        }
    }
}

/// The repair box (Ore trucks or All) and the Repair key on a selected
/// truck (both `repair_groups_json`, then `Order::RepairUnits`).
#[test]
fn the_repair_box_and_the_repair_key_send_ore_trucks_to_the_depot() {
    for model in MovementModel::ALL {
        for choice in ["harvesters", "all", "key"] {
            let mut b = base(model);
            let h = harv(&mut b, 20, 26);
            let t = tank(&mut b, 22, 26);
            get_to(&mut b, h, Doing::Harvesting);
            damage(&mut b, h);
            damage(&mut b, t);
            let groups = if choice == "key" {
                b.w.repair_groups_json(0, [h])
            } else {
                let area = Rect::new(cell_center(16), cell_center(20), cell_center(28), cell_center(44));
                let actors = b.w.selectable_actors(&[0], Some(area), None);
                b.w.repair_groups_json(0, actors)
            };
            let list = |k: &str| groups[k].as_array().unwrap().iter().map(|v| v.as_u64().unwrap() as u32).collect::<Vec<_>>();
            assert_eq!(list("harvesters"), vec![b.w.make_ref(h)], "{model:?} {choice}: the Ore trucks category");
            assert!(list("noFacility").is_empty(), "{model:?} {choice}: the depot repairs it");
            let ids = match choice {
                "all" => [list("combat"), list("harvesters")].concat(),
                _ => list("harvesters"),
            };
            b.w.queue_order(Order::RepairUnits { player: 0, ids });
            b.w.step();
            let tank_sent = b.w.actors[t].activity == Activity::Repair;
            assert_eq!(tank_sent, choice == "all", "{model:?} {choice}: the tank only with All");
            assert_repaired(&mut b, h);
        }
    }
}

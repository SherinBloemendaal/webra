//! Tests for planes (plane.rs) and support powers (powers.rs).

use crate::math::{facing_vec, CELL};
use crate::plane::{Mission, Phase};
use crate::rules::{Kind, QueueType};
use crate::world::{cell_center, Activity, Order, World};

fn ty(w: &World, id: &str) -> u16 {
    w.rules.actor_index(id).unwrap() as u16
}

fn run(w: &mut World, ticks: u32) {
    for _ in 0..ticks {
        w.step();
    }
}

fn of_type(w: &World, owner: u8, id: &str) -> Vec<usize> {
    let t = ty(w, id);
    (0..w.actors.len()).filter(|&i| w.actors[i].alive && w.actors[i].owner == owner && w.actors[i].ty == t).collect()
}

/// A two player game (no AI), player 0 with the given faction.
fn game(faction: &str) -> World {
    let mut w = World::new(7, 64, &[(faction, false), ("allies", false)]);
    w.players[0].cash = 100_000;
    w
}

/// Place a structure for `player` at the first valid spot near its base.
fn place(w: &mut World, player: u8, id: &str) -> usize {
    let t = ty(w, id);
    let (sx, sy) = w.players[player as usize].start;
    for r in 3..20 {
        for dy in -r..=r {
            for dx in -r..=r {
                if w.can_place(player, t, sx + dx, sy + dy) {
                    let b = w.spawn_building(t, player, sx + dx, sy + dy).unwrap();
                    w.refresh_tokens();
                    w.update_power();
                    return b;
                }
            }
        }
    }
    panic!("no room for {id}");
}

/// A plane parked on airfield `b`, as production leaves it.
fn parked_plane(w: &mut World, id: &str, b: usize) -> usize {
    let owner = w.actors[b].owner;
    let u = w.spawn_unit(ty(w, id), owner, w.actors[b].x, w.actors[b].y, 0);
    assert!(w.plane_produced(u, b));
    u
}

/// The cell centre of a passable land cell with passable neighbours, far from player 0.
fn open_ground(w: &World, min_dist: i32) -> (i32, i32) {
    let (sx, sy) = w.players[0].start;
    for y in 4..w.map.height - 4 {
        for x in 4..w.map.width - 4 {
            if (x - sx).abs() + (y - sy).abs() < min_dist {
                continue;
            }
            let ok = (-3..=3).all(|dy| (-3..=3).all(|dx| !w.pass.blocked[w.map.idx(x + dx, y + dy)]));
            if ok {
                return (cell_center(x), cell_center(y));
            }
        }
    }
    panic!("no open ground");
}

fn charge_all(w: &mut World, player: u8) {
    for inst in w.powers.players[player as usize].iter_mut() {
        inst.remaining = 0;
    }
}

#[test]
fn yak_is_built_at_the_airfield_and_parks_on_it() {
    let mut w = game("soviet");
    place(&mut w, 0, "POWR"); // full power: production at normal speed
    let afld = place(&mut w, 0, "AFLD");
    let yak = ty(&w, "YAK");
    assert!(w.availability(0, yak).enabled, "an airfield unlocks the Yak");
    w.queue_order(Order::StartProduction { player: 0, ty: yak, count: 2 });
    let build = w.rules.actors[yak as usize].build_ticks as u32;
    run(&mut w, build + 5);
    let yaks = of_type(&w, 0, "YAK");
    assert_eq!(yaks.len(), 1);
    let p = &w.actors[yaks[0]];
    assert_eq!(p.air.phase, Phase::Parked);
    assert_eq!(p.altitude, 0, "parked planes sit on the ground");
    assert_eq!((p.x, p.y), (w.actors[afld].x, w.actors[afld].y), "parked on the airfield");
    assert_eq!(p.air.base, w.make_ref(afld), "the airfield is reserved");
    assert_eq!(w.ammo_left(yaks[0]), 18, "full AmmoPool");
    // The second Yak finds the airfield taken and starts in the air.
    run(&mut w, build + 5);
    let yaks = of_type(&w, 0, "YAK");
    assert_eq!(yaks.len(), 2);
    assert_eq!(yaks.iter().filter(|&&i| w.actors[i].air.phase == Phase::Parked).count(), 1, "one plane per airfield");
    assert!(w.actors[yaks[1]].altitude > 0);
    assert!(w.rules.actors[yak as usize].queue == QueueType::Aircraft);
}

#[test]
fn parked_plane_takes_off_flies_to_the_target_and_circles() {
    let mut w = game("soviet");
    let afld = place(&mut w, 0, "AFLD");
    let p = parked_plane(&mut w, "YAK", afld);
    run(&mut w, 30);
    assert_eq!(w.actors[p].air.phase, Phase::Parked, "stays parked without orders");
    let (gx, gy) = (cell_center(w.map.width / 2), cell_center(w.map.height / 2));
    let id = w.make_ref(p);
    w.queue_order(Order::Move { player: 0, ids: vec![id], x: gx, y: gy, attack_move: false });
    run(&mut w, 2);
    assert_eq!(w.actors[p].air.phase, Phase::Flying, "took off");
    assert_eq!(w.actors[p].air.base, crate::world::NONE, "released the airfield");
    run(&mut w, 60);
    assert_eq!(w.actors[p].altitude, 2560, "climbed to cruise altitude");
    run(&mut w, 400);
    assert_eq!(w.actors[p].activity, Activity::Idle, "arrived");
    // Circling: always moving, never far from the destination.
    for _ in 0..200 {
        let (x0, y0) = (w.actors[p].x, w.actors[p].y);
        w.step();
        let a = &w.actors[p];
        assert_ne!((a.x, a.y), (x0, y0), "planes cannot hover");
        assert!(crate::math::dist(a.x, a.y, gx, gy) < 6 * CELL, "circles near the destination");
    }
}

#[test]
fn yak_attack_runs_use_ammo_then_it_rearms_and_returns_to_the_target() {
    let mut w = game("soviet");
    let afld = place(&mut w, 0, "AFLD");
    let p = parked_plane(&mut w, "YAK", afld);
    // An enemy power plant (40000 HP): one AmmoPool does not destroy it.
    let (tx, ty_) = open_ground(&w, 18);
    let powr = w.spawn_building(ty(&w, "POWR"), 1, tx / CELL, ty_ / CELL).unwrap();
    // Planes attack what their owner can see.
    w.add_reveal(0, tx, ty_, 3 * CELL, 100_000);
    w.update_vision();
    let hp0 = w.actors[powr].hp;
    w.queue_order(Order::Attack { player: 0, ids: vec![w.make_ref(p)], target: w.make_ref(powr) });
    let mut out_of_ammo = false;
    for _ in 0..3000 {
        w.step();
        if w.ammo_left(p) == 0 {
            out_of_ammo = true;
            break;
        }
    }
    assert!(out_of_ammo, "spent all 18 rounds");
    assert!(w.actors[powr].hp < hp0, "the attack runs hit");
    assert!(w.actors[powr].alive);
    w.step();
    assert_eq!(w.actors[p].air.phase, Phase::Returning, "heads home to rearm");
    let mut landed = false;
    for _ in 0..2000 {
        w.step();
        if w.actors[p].air.phase == Phase::Parked {
            landed = true;
            break;
        }
    }
    assert!(landed, "landed on the airfield");
    assert_eq!((w.actors[p].x, w.actors[p].y), (w.actors[afld].x, w.actors[afld].y));
    assert_eq!(w.actors[p].altitude, 0);
    // Yak: ReloadDelay 11 per round, 18 rounds.
    run(&mut w, 18 * 11 + 2);
    assert_eq!(w.ammo_left(p), 18, "rearmed");
    run(&mut w, 3);
    assert_eq!(w.actors[p].air.phase, Phase::Flying, "resumes the attack once full");
    assert_eq!(w.actors[p].activity, Activity::Attack);
}

#[test]
fn ground_weapons_hit_landed_planes_only() {
    let mut w = game("soviet");
    let afld = place(&mut w, 0, "AFLD");
    let p = parked_plane(&mut w, "YAK", afld);
    // An enemy light tank right next to the airfield.
    let (x, y) = (w.actors[afld].x + 2 * CELL, w.actors[afld].y + 2 * CELL);
    let tank = w.spawn_unit(ty(&w, "1TNK"), 1, x, y, 0);
    w.rebuild_hash();
    w.update_vision();
    assert_eq!(w.target_kind(p), Kind::Vehicle);
    let tank_info = &w.rules.actors[w.actors[tank].ty as usize];
    assert!(tank_info.can_attack(&w.rules, w.target_kind(p)), "a landed plane is a ground target");
    // Airborne, the same plane is out of the tank's reach.
    w.actors[p].altitude = 2560;
    w.actors[p].air.phase = Phase::Flying;
    assert_eq!(w.target_kind(p), Kind::Aircraft);
    assert!(!tank_info.can_attack(&w.rules, w.target_kind(p)));
    w.rebuild_hash();
    assert_ne!(w.auto_scan(tank), Some(p), "the tank ignores the plane overhead");
}

#[test]
fn planes_never_bump_into_each_other() {
    let mut w = game("soviet");
    let (x, y) = (cell_center(20), cell_center(20));
    let a = w.spawn_unit(ty(&w, "YAK"), 0, x, y, 256);
    let b = w.spawn_unit(ty(&w, "YAK"), 0, x, y, 256);
    run(&mut w, 20);
    assert_eq!((w.actors[a].x, w.actors[a].y), (w.actors[b].x, w.actors[b].y), "no separation push between planes");
}

#[test]
fn shot_down_plane_falls_and_explodes_where_it_crashes() {
    let mut w = game("soviet");
    let (x, y) = (cell_center(20), cell_center(30));
    let p = w.spawn_unit(ty(&w, "YAK"), 0, x, y, 256);
    let alt = w.actors[p].altitude;
    assert!(alt > 0);
    // FallsToEarth: Velocity 86 per tick while flying on at full speed.
    let fall_ticks = (alt + 85) / 86;
    let speed = w.rules.actors[w.actors[p].ty as usize].unit.as_ref().unwrap().speed;
    let (vx, vy) = facing_vec(256);
    let (ix, iy) = (x + vx * speed / 1024 * fall_ticks, y + vy * speed / 1024 * fall_ticks);
    let victims: Vec<usize> = (0..3).map(|k| w.spawn_unit(ty(&w, "E1"), 1, ix + (k - 1) * 128, iy, 0)).collect();
    let losses = w.losses[0];
    w.rebuild_hash();
    w.damage(p, 100_000);
    assert!(w.actors[p].alive, "falls instead of vanishing");
    assert_eq!(w.actors[p].air.phase, Phase::Crashing);
    w.damage(p, 100_000);
    assert!(w.actors[p].alive, "a falling wreck takes no more damage");
    assert!(w.untargetable_aircraft(p));
    run(&mut w, fall_ticks as u32 - 1);
    assert!(w.actors[p].alive && w.actors[p].altitude > 0);
    run(&mut w, 1);
    assert!(!w.actors[p].alive, "destroyed on impact");
    assert_eq!(w.losses[0], losses + 1);
    assert!(victims.iter().any(|&v| !w.actors[v].alive || w.actors[v].hp < 5000), "the crash hurts what is below");
}

#[test]
fn power_timers_need_an_airfield_charge_and_validate() {
    let mut w = game("soviet");
    run(&mut w, 2);
    assert!(w.power_instances(0).is_empty(), "no airfield, no powers");
    let target = open_ground(&w, 10);
    w.queue_order(Order::SupportPower { player: 0, key: "AirstrikePower@spyplane".into(), x: target.0, y: target.1, x2: None, y2: None });
    run(&mut w, 1);
    assert!(of_type(&w, 0, "U2").is_empty(), "cannot fire without the building");

    let afld = place(&mut w, 0, "AFLD");
    let afld2 = place(&mut w, 0, "AFLD");
    run(&mut w, 1);
    let keys: Vec<&str> = w.power_instances(0).iter().map(|p| p.key.as_str()).collect();
    assert_eq!(keys, ["ParatroopersPower@paratroopers", "AirstrikePower@spyplane"], "one instance per power, palette order");
    assert!(w.power_instances(1).is_empty());
    // Not charged yet: rejected.
    w.queue_order(Order::SupportPower { player: 0, key: "AirstrikePower@spyplane".into(), x: target.0, y: target.1, x2: None, y2: None });
    run(&mut w, 1);
    assert!(of_type(&w, 0, "U2").is_empty(), "not ready");
    // ChargeInterval 3750 for the spy plane, 7500 for paratroopers.
    // Charged one tick when the airfields appeared, one more above.
    run(&mut w, 3750 - 2);
    let spy = w.power_instances(0).iter().find(|p| p.key == "AirstrikePower@spyplane").unwrap().clone();
    assert_eq!(spy.remaining, 0);
    assert!(spy.ready());
    let para = w.power_instances(0).iter().find(|p| p.key == "ParatroopersPower@paratroopers").unwrap().clone();
    assert!(!para.ready());
    assert_eq!(para.progress_permille(), 500);
    // Another player cannot fire it.
    w.queue_order(Order::SupportPower { player: 1, key: "AirstrikePower@spyplane".into(), x: target.0, y: target.1, x2: None, y2: None });
    run(&mut w, 1);
    assert!(of_type(&w, 1, "U2").is_empty());
    w.queue_order(Order::SupportPower { player: 0, key: "AirstrikePower@spyplane".into(), x: target.0, y: target.1, x2: None, y2: None });
    run(&mut w, 1);
    assert_eq!(of_type(&w, 0, "U2").len(), 1, "fired once");
    let spy = w.power_instances(0).iter().find(|p| p.key == "AirstrikePower@spyplane").unwrap();
    assert!(spy.remaining >= spy.total - 1, "timer restarted");
    // Losing every airfield removes the powers.
    w.kill(afld);
    run(&mut w, 1);
    assert_eq!(w.power_instances(0).len(), 2, "the second airfield still provides them");
    w.kill(afld2);
    run(&mut w, 1);
    assert!(w.power_instances(0).is_empty());
}

#[test]
fn spy_plane_reveals_the_target_and_leaves() {
    let mut w = game("soviet");
    place(&mut w, 0, "AFLD");
    run(&mut w, 1);
    charge_all(&mut w, 0);
    let (tx, ty_) = (cell_center(w.map.width - 6), cell_center(w.map.height - 6));
    let ci = w.cell_index(tx, ty_);
    assert_eq!(w.players[0].explored[ci], 0, "starts under the shroud");
    w.queue_order(Order::SupportPower { player: 0, key: "AirstrikePower@spyplane".into(), x: tx, y: ty_, x2: None, y2: None });
    run(&mut w, 1);
    let u2 = of_type(&w, 0, "U2");
    assert_eq!(u2.len(), 1);
    let u2 = u2[0];
    assert_eq!(w.actors[u2].air.mission, Mission::SpyPlane);
    assert!(w.untargetable_aircraft(u2), "the spy plane cannot be shot at");
    let id = w.make_ref(u2);
    // Orders are rejected and the plane is not selectable.
    w.queue_order(Order::Stop { player: 0, ids: vec![id] });
    let mut revealed_at = None;
    for t in 0..600 {
        w.step();
        if revealed_at.is_none() && w.players[0].visible[ci] != 0 {
            revealed_at = Some(t);
        }
        if w.resolve(id).is_none() {
            break;
        }
    }
    assert!(revealed_at.is_some(), "the target was revealed");
    assert_eq!(w.players[0].explored[ci], 1);
    assert!(w.resolve(id).is_none(), "flew off the map");
    assert_eq!(w.losses[0], 0, "leaving is not a loss");
}

#[test]
fn paratroopers_drop_and_land_near_the_target() {
    let mut w = game("soviet");
    place(&mut w, 0, "AFLD");
    run(&mut w, 1);
    charge_all(&mut w, 0);
    let (tx, ty_) = open_ground(&w, 14);
    w.queue_order(Order::SupportPower {
        player: 0,
        key: "ParatroopersPower@paratroopers".into(),
        x: tx,
        y: ty_,
        x2: Some(tx + 4 * CELL),
        y2: Some(ty_),
    });
    run(&mut w, 1);
    let badr = of_type(&w, 0, "BADR");
    assert_eq!(badr.len(), 1);
    assert_eq!(w.actors[badr[0]].air.cargo.len(), 5);
    assert_eq!(w.actors[badr[0]].facing, 256, "flies in the chosen direction (east)");
    let mut saw_parachute = false;
    for _ in 0..600 {
        w.step();
        saw_parachute |= w.actors.iter().any(|a| a.alive && a.air.parachute && a.altitude > 0);
    }
    assert!(saw_parachute, "they come down on parachutes");
    let e1 = of_type(&w, 0, "E1R1");
    let e3 = of_type(&w, 0, "E3R1");
    assert_eq!((e1.len(), e3.len()), (3, 2), "OpenRA DropItems: E1R1 x3, E3R1 x2");
    for &i in e1.iter().chain(e3.iter()) {
        let a = &w.actors[i];
        assert_eq!(a.altitude, 0, "landed");
        assert!(!a.air.parachute);
        assert!(crate::math::dist(a.x, a.y, tx, ty_) <= 5 * CELL, "near the target");
    }
    assert!(of_type(&w, 0, "BADR").is_empty(), "the Badger left");
}

#[test]
fn parabombs_are_ukrainian_and_damage_the_target_area() {
    let mut w = game("ukraine");
    place(&mut w, 0, "AFLD.Ukraine");
    run(&mut w, 1);
    let keys: Vec<&str> = w.power_instances(0).iter().map(|p| p.key.as_str()).collect();
    assert!(keys.contains(&"AirstrikePower@parabombs"));
    let mut soviet = game("soviet");
    place(&mut soviet, 0, "AFLD");
    run(&mut soviet, 1);
    assert!(soviet.power_instances(0).iter().all(|p| p.key != "AirstrikePower@parabombs"), "Ukraine only");

    charge_all(&mut w, 0);
    let (tx, ty_) = open_ground(&w, 14);
    let powr = w.spawn_building(ty(&w, "POWR"), 1, tx / CELL, ty_ / CELL).unwrap();
    let hp0 = w.actors[powr].hp;
    let (px, py) = (w.actors[powr].x, w.actors[powr].y);
    w.queue_order(Order::SupportPower { player: 0, key: "AirstrikePower@parabombs".into(), x: px, y: py, x2: None, y2: None });
    run(&mut w, 1);
    let bomber = of_type(&w, 0, "BADR.Bomber");
    assert_eq!(bomber.len(), 1);
    let mut saw_bombs = false;
    for _ in 0..600 {
        w.step();
        saw_bombs |= !w.powers.bombs.is_empty();
    }
    assert!(saw_bombs, "bombs fall");
    assert!(!w.actors[powr].alive || w.actors[powr].hp < hp0, "bombs hit the target");
    assert!(of_type(&w, 0, "BADR.Bomber").is_empty(), "the bomber left");
}

#[test]
fn planes_and_powers_are_deterministic() {
    let play = || {
        let mut w = game("soviet");
        let afld = place(&mut w, 0, "AFLD");
        let p = parked_plane(&mut w, "YAK", afld);
        run(&mut w, 1);
        charge_all(&mut w, 0);
        let (tx, ty_) = open_ground(&w, 14);
        let tank = w.spawn_unit(ty(&w, "2TNK"), 1, tx, ty_, 0);
        w.add_reveal(0, tx, ty_, 4 * CELL, 100_000);
        w.update_vision();
        w.queue_order(Order::Attack { player: 0, ids: vec![w.make_ref(p)], target: w.make_ref(tank) });
        w.queue_order(Order::SupportPower { player: 0, key: "ParatroopersPower@paratroopers".into(), x: tx, y: ty_, x2: None, y2: None });
        let mut hashes = Vec::new();
        for t in 0..900 {
            w.step();
            if t % 100 == 0 {
                hashes.push(w.state_hash());
            }
        }
        hashes
    };
    assert_eq!(play(), play());
}

#[test]
fn support_power_orders_roundtrip_as_json() {
    let o: Order = serde_json::from_str(r#"{"o":"support_power","player":0,"key":"AirstrikePower@spyplane","x":1024,"y":2048}"#).unwrap();
    match &o {
        Order::SupportPower { x2, y2, .. } => assert_eq!((*x2, *y2), (None, None)),
        _ => panic!("wrong order"),
    }
    let back: Order = serde_json::from_str(&serde_json::to_string(&o).unwrap()).unwrap();
    assert_eq!(back.player(), 0);
    let long = Order::SupportPower { player: 0, key: "x".repeat(65), x: 0, y: 0, x2: None, y2: None };
    assert!(!long.is_reasonable());
}

#[test]
fn smart_order_on_an_own_airfield_returns_the_plane_to_base() {
    let mut w = game("soviet");
    let afld = place(&mut w, 0, "AFLD");
    let (x, y) = (cell_center(w.map.width / 2), cell_center(w.map.height / 2));
    let p = w.spawn_unit(ty(&w, "YAK"), 0, x, y, 0);
    w.rebuild_hash();
    let (bx, by) = (w.actors[afld].x, w.actors[afld].y);
    assert_eq!(w.smart_action(0, &[p], bx, by), crate::world::SmartAction::Dock, "the cursor offers to land");
    w.queue_order(Order::Smart { player: 0, ids: vec![w.make_ref(p)], x: bx, y: by });
    run(&mut w, 1);
    assert_eq!(w.actors[p].air.phase, Phase::Returning);
    assert_eq!(w.actors[p].air.base, w.make_ref(afld), "reserved the clicked airfield");
    let mut landed = false;
    for _ in 0..1500 {
        w.step();
        if w.actors[p].air.phase == Phase::Parked {
            landed = true;
            break;
        }
    }
    assert!(landed, "landed");
    assert_eq!((w.actors[p].x, w.actors[p].y, w.actors[p].altitude), (bx, by, 0));
    // A move order while returning cancels the landing.
    let q = w.spawn_unit(ty(&w, "YAK"), 0, x, y, 0);
    w.plane_return_to_base(q, None);
    assert_eq!(w.actors[q].air.phase, Phase::Returning);
    w.queue_order(Order::Move { player: 0, ids: vec![w.make_ref(q)], x, y, attack_move: false });
    run(&mut w, 1);
    assert_eq!(w.actors[q].air.phase, Phase::Flying);
}

// ---- Pilots (OpenRA EjectOnDeath) ---------------------------------------------------

/// Set the EjectOnDeath success rate of `id` (the rules are the world's own copy).
fn eject_rate(w: &mut World, id: &str, rate: i32) {
    let t = ty(w, id) as usize;
    w.rules.actors[t].abilities.eject_on_death.as_mut().expect("EjectOnDeath").success_rate = rate;
}

fn pilots(w: &World, owner: u8) -> Vec<usize> {
    of_type(w, owner, "E1")
}

#[test]
fn rules_give_aircraft_openra_eject_on_death() {
    let w = game("soviet");
    for id in ["YAK", "MIG", "HELI", "HIND", "TRAN", "MH60"] {
        let e = w.rules.actors[ty(&w, id) as usize].abilities.eject_on_death.as_ref().unwrap_or_else(|| panic!("{id}"));
        assert_eq!(
            (e.pilot.as_str(), e.success_rate, e.in_air, e.on_ground, e.allow_unsuitable_cell),
            ("E1", 50, true, false, true),
            "{id}"
        );
    }
    assert!(w.rules.actors[ty(&w, "BADR") as usize].abilities.eject_on_death.is_none(), "BADR: -EjectOnDeath");
    assert!(w.rules.actors[ty(&w, "1TNK") as usize].abilities.eject_on_death.is_none());
}

#[test]
fn a_pilot_bails_out_of_a_downed_plane_and_lands_by_parachute() {
    let mut w = game("soviet");
    eject_rate(&mut w, "YAK", 100);
    w.sound.set_enabled(true);
    let (x, y) = open_ground(&w, 14);
    let p = w.spawn_unit(ty(&w, "YAK"), 0, x, y, 256);
    let alt = w.actors[p].altitude;
    w.damage(p, 100_000);
    let pilot = pilots(&w, 0);
    assert_eq!(pilot.len(), 1, "one pilot");
    let e = pilot[0];
    assert_eq!((w.actors[e].x, w.actors[e].y, w.actors[e].altitude), (x, y, alt), "where the plane was hit, at its height");
    assert!(w.actors[e].air.parachute);
    let ev = w.sound.take();
    let ejected: Vec<&[i32]> =
        ev.chunks(crate::sound_events::EVENT_STRIDE).filter(|c| c[0] == crate::sound_events::SoundEventKind::PilotEjected as i32).collect();
    assert_eq!(ejected.len(), 1);
    assert_eq!((ejected[0][1], ejected[0][4]), (ty(&w, "YAK") as i32, 0), "the plane's ChuteSound, for everyone near");
    run(&mut w, 25 * 30);
    assert!(!w.actors[p].alive, "the plane crashed");
    assert_eq!(pilots(&w, 0), vec![e], "no second pilot where the wreck hits the ground");
    let a = &w.actors[e];
    assert!(a.alive && a.altitude == 0 && !a.air.parachute, "landed on open ground");
}

#[test]
fn a_pilot_over_water_comes_down_but_drowns() {
    let mut w = game("soviet");
    eject_rate(&mut w, "HELI", 100);
    let (x, y) = open_ground(&w, 14);
    let (cx, cy) = w.cell_of(x, y);
    for dy in -3..=3 {
        for dx in -3..=3 {
            let i = w.map.idx(cx + dx, cy + dy);
            w.map.terrain[i] = crate::map::Terrain::Water;
        }
    }
    w.pass = crate::flowfield::Passability::new(&w.map);
    w.pass_water = crate::flowfield::Passability::water(&w.map);
    w.pass_landing = crate::flowfield::Passability::landing(&w.map);
    let h = w.spawn_unit(ty(&w, "HELI"), 0, x, y, 0);
    w.actors[h].altitude = 1024;
    w.sound.set_enabled(true);
    w.damage(h, 1_000_000);
    let pilot = pilots(&w, 0);
    assert_eq!(pilot.len(), 1, "AllowUnsuitableCell: it still bails out");
    let mut impact = Vec::new();
    for _ in 0..25 * 10 {
        w.step();
        impact.extend(
            w.sound
                .take()
                .chunks(crate::sound_events::EVENT_STRIDE)
                .filter(|c| c[0] == crate::sound_events::SoundEventKind::ParachuteImpact as i32)
                .map(|c| c[5]),
        );
    }
    assert!(!w.actors[pilot[0]].alive, "Parachutable KilledOnImpassableTerrain");
    assert_eq!(impact, vec![1], "the WaterImpactSound");
}

#[test]
fn no_pilot_on_the_ground_by_chance_for_losers_or_over_bad_ground() {
    let mut w = game("soviet");
    let (x, y) = open_ground(&w, 14);
    // A landed helicopter: EjectOnGround is false.
    eject_rate(&mut w, "HELI", 100);
    let landed = w.spawn_unit(ty(&w, "HELI"), 0, x, y, 0);
    w.actors[landed].altitude = 0;
    w.damage(landed, 1_000_000);
    assert!(pilots(&w, 0).is_empty(), "no pilot at ground level");
    // SuccessRate 0.
    eject_rate(&mut w, "YAK", 0);
    let p = w.spawn_unit(ty(&w, "YAK"), 0, x, y, 256);
    w.damage(p, 1_000_000);
    assert!(pilots(&w, 0).is_empty(), "SuccessRate 0");
    // The owner has lost.
    eject_rate(&mut w, "YAK", 100);
    w.players[0].defeated = true;
    let p = w.spawn_unit(ty(&w, "YAK"), 0, x, y, 256);
    w.damage(p, 1_000_000);
    assert!(pilots(&w, 0).is_empty(), "WinState Lost");
    w.players[0].defeated = false;
    // Without AllowUnsuitableCell, not over a cell the pilot cannot enter.
    let t = ty(&w, "YAK") as usize;
    w.rules.actors[t].abilities.eject_on_death.as_mut().unwrap().allow_unsuitable_cell = false;
    let (cx, cy) = w.cell_of(x, y);
    let ci = w.map.idx(cx, cy);
    w.pass.set_blocked(ci, true);
    let p = w.spawn_unit(ty(&w, "YAK"), 0, x, y, 256);
    w.damage(p, 1_000_000);
    assert!(pilots(&w, 0).is_empty(), "unsuitable cell");
    w.pass.set_blocked(ci, false);
    let p = w.spawn_unit(ty(&w, "YAK"), 0, x, y, 256);
    w.damage(p, 1_000_000);
    assert_eq!(pilots(&w, 0).len(), 1, "a suitable one");
}

#[test]
fn pilots_follow_the_simulations_random_numbers() {
    let run_one = || {
        let mut w = game("soviet");
        let (x, y) = open_ground(&w, 14);
        for _ in 0..60 {
            let p = w.spawn_unit(ty(&w, "MIG"), 0, x, y, 256);
            w.damage(p, 1_000_000);
        }
        let n = pilots(&w, 0).len();
        (n, w.state_hash())
    };
    let (a, ha) = run_one();
    let (b, hb) = run_one();
    assert_eq!((a, ha), (b, hb), "same seed, same pilots");
    assert!((15..=45).contains(&a), "about half of 60 (SuccessRate 50): {a}");
}

//! Anti-air (combat.rs, rules.rs): every actor OpenRA's Red Alert rules arm
//! against aircraft (AA gun, SAM site, rocket soldiers, Flak Truck, Mammoth
//! Tank, Longbow, destroyer, missile sub) finds, hits and downs every kind of
//! aircraft; air-only weapons leave the ground alone and ground weapons the
//! air; AA structures need power; manual orders, cursors and the AI's use of
//! anti-air; and shots that burst in the air or run out of fuel.

use crate::map::{Map, Terrain};
use crate::math::{dist, CELL};
use crate::plane::Mission;
use crate::rules::{Kind, Stance, SupportPowerInfo, TARGET_AIR};
use crate::veterancy::Shot;
use crate::world::{cell_center, Activity, GameOptions, Order, PlayerSetup, Projectile, SmartAction, World, MAX_WEAPONS, NONE};

fn ty(w: &World, id: &str) -> u16 {
    w.rules.actor_index(id).unwrap() as u16
}

fn run(w: &mut World, ticks: u32) {
    for _ in 0..ticks {
        w.step();
    }
}

/// Ships sail west of this column, everything else stands east of it.
const SHORE: i32 = 14;

/// A 64x64 field without fog (vision is not what these tests are about),
/// water west of `SHORE`. Player 0 (Soviet) shoots, player 1 (Allies)
/// flies; player 0 has power to spare for its AA structures.
fn sky(seed: u64) -> World {
    let mut map = Map::filled(64, 64, Terrain::Clear);
    for y in 0..64 {
        for x in 0..SHORE {
            let i = map.idx(x, y);
            map.terrain[i] = Terrain::Water;
        }
    }
    map.spawns = vec![(40, 2), (40, 58)];
    let players = [PlayerSetup::new("soviet", None), PlayerSetup::new("allies", None)];
    let options = GameOptions { fog: false, explored: true, ore_regrowth: false, ..GameOptions::default() };
    let mut w = World::on_map(seed, map, &players, options);
    powered(&mut w, 0);
    w
}

/// Three advanced power plants for `player` along the south edge (600
/// power: a dozen AA structures).
fn powered(w: &mut World, player: u8) {
    for k in 0..3 {
        w.spawn_building(ty(w, "APWR"), player, 20 + 4 * k + 14 * player as i32, 59);
    }
    w.refresh_tokens();
    w.update_power();
}

/// Spawn `id` for `owner` at a cell: a structure (top-left cell) or a unit.
fn spawn(w: &mut World, id: &str, owner: u8, cx: i32, cy: i32) -> usize {
    let t = ty(w, id);
    if w.rules.actors[t as usize].building.is_some() {
        let b = w.spawn_building(t, owner, cx, cy).unwrap();
        w.refresh_tokens();
        w.update_power();
        b
    } else {
        w.spawn_unit(t, owner, cell_center(cx), cell_center(cy), 256)
    }
}

/// An aircraft that never fires and never picks a fight: a pure target.
fn quiet_flyer(w: &mut World, id: &str, owner: u8, cx: i32, cy: i32) -> usize {
    let a = w.spawn_unit(ty(w, id), owner, cell_center(cx), cell_center(cy), 256);
    w.actors[a].reload = [1_000_000; MAX_WEAPONS];
    w.actors[a].stance = Stance::HoldFire;
    a
}

fn set_stance(w: &mut World, player: u8, units: &[usize], stance: Stance) {
    let ids = units.iter().map(|&u| w.make_ref(u)).collect();
    w.queue_order(Order::SetStance { player, ids, stance });
    run(w, 1);
}

fn max_hp(w: &World, i: usize) -> i32 {
    w.rules.actors[w.actors[i].ty as usize].hp
}

/// Every actor type whose weapons can hit what flies (OpenRA ValidTargets
/// AirborneActor), straight from the rules.
fn anti_air_types(w: &World) -> Vec<String> {
    w.rules.actors.iter().filter(|a| a.can_attack_class(&w.rules, TARGET_AIR)).map(|a| a.id.clone()).collect()
}

/// The aircraft types a player can meet: helicopters, planes and the
/// Badger of the paratrooper and parabomb powers.
const AIRCRAFT: [&str; 7] = ["HELI", "HIND", "MH60", "TRAN", "YAK", "MIG", "BADR"];

/// Ticks for one shooter to down one aircraft: generous enough for the
/// slowest pair (a lone rocket soldier against a Badger's 400 hit points).
const DOWN_LIMIT: u32 = 25 * 60;

/// Where a shooter of type `id` stands: ships on the water, the rest ashore.
fn shooter_cell(w: &World, id: &str) -> (i32, i32) {
    let info = &w.rules.actors[ty(w, id) as usize];
    let naval = info.unit.as_ref().is_some_and(|u| w.rules.locomotors[u.locomotor].domain == crate::rules::Domain::Water);
    if naval {
        (6, 30)
    } else {
        (30, 30)
    }
}

/// One shooter against one quiet aircraft hovering or circling three cells
/// away: (ticks until it locked on by itself, ticks until the aircraft died).
fn duel(seed: u64, shooter: &str, target: &str) -> (Option<u32>, Option<u32>) {
    let mut w = sky(seed);
    let (cx, cy) = shooter_cell(&w, shooter);
    let s = spawn(&mut w, shooter, 0, cx, cy);
    // Helicopters start on HoldFire (InitialStance); everyone shoots by itself here.
    if w.actors[s].kind != Kind::Building {
        set_stance(&mut w, 0, &[s], Stance::AttackAnything);
    }
    let t = quiet_flyer(&mut w, target, 1, cx + 3, cy);
    let tref = w.make_ref(t);
    let mut locked = None;
    for k in 0..DOWN_LIMIT {
        if locked.is_none() && (w.actors[s].target == tref || w.actors[s].opportunity == tref) {
            locked = Some(k);
        }
        if w.resolve(tref).is_none() || !w.actors[t].alive || w.crashed(t) {
            return (locked, Some(k));
        }
        // The Longbow's AmmoPool would send it home to a helipad halfway
        // through a Badger; this is about hitting, so it never runs dry.
        w.actors[s].heli.ammo_used = 0;
        w.step();
    }
    (locked, None)
}

// ---- The matrix ---------------------------------------------------------------------

/// The reported bug: AA guns and SAM sites (air-only weapons) never fired,
/// since auto-target scans only looked as far as weapons that hit the
/// ground reach (zero for them), and rocket soldiers only spotted aircraft
/// within their Dragon's 5 cells, not their Redeye's 7.5.
#[test]
fn every_anti_air_shooter_downs_every_aircraft() {
    let w = sky(1);
    let shooters = anti_air_types(&w);
    for id in ["AGUN", "SAM", "E3", "E3R1", "FTRK", "4TNK", "HELI", "DD", "MSUB"] {
        assert!(shooters.iter().any(|s| s == id), "{id} is armed against aircraft");
    }
    let mut failures = Vec::new();
    for shooter in &shooters {
        for target in AIRCRAFT {
            let (locked, down) = duel(11, shooter, target);
            if locked.is_none() || down.is_none() {
                failures.push(format!("{shooter} vs {target}: locked on {locked:?}, downed {down:?}"));
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// Shooters see aircraft at the full range of their anti-air weapon, not
/// only at the reach of their ground weapon.
#[test]
fn anti_air_locks_on_at_the_full_range_of_its_anti_air_weapon() {
    for (shooter, cells) in [("E3", 7), ("AGUN", 9), ("SAM", 7), ("FTRK", 7)] {
        let mut w = sky(2);
        let s = spawn(&mut w, shooter, 0, 30, 30);
        let aa = w.rules.actors[ty(&w, shooter) as usize]
            .weapons
            .iter()
            .map(|&k| &w.rules.weapons[k])
            .filter(|k| k.can_target_class(TARGET_AIR))
            .map(|k| k.range)
            .max()
            .unwrap();
        assert!(cells * CELL <= aa, "{shooter}: {cells} cells is within its anti-air range {aa}");
        let t = quiet_flyer(&mut w, "HIND", 1, 30 + cells, 30);
        run(&mut w, 1);
        assert_eq!(w.scan_for_target(s, false), Some(t), "{shooter} picks the Hind {cells} cells away");
        run(&mut w, 40);
        assert!(w.actors[t].hp < max_hp(&w, t), "{shooter} hit it");
    }
}

/// Aircraft flying a strike at the shooter: the AA structures shoot them
/// down before they finish their runs, and a rocket soldier engages the
/// incoming plane at its Redeye's range.
#[test]
fn anti_air_defences_shoot_down_attacking_aircraft() {
    for defence in ["AGUN", "SAM"] {
        for attacker in ["YAK", "MIG", "HIND", "HELI", "MH60"] {
            let mut w = sky(3);
            let d = spawn(&mut w, defence, 0, 30, 30);
            let a = w.spawn_unit(ty(&w, attacker), 1, cell_center(30), cell_center(50), 0);
            w.queue_order(Order::Attack { player: 1, ids: vec![w.make_ref(a)], target: w.make_ref(d) });
            let aref = w.make_ref(a);
            run(&mut w, 25 * 20);
            assert!(w.resolve(aref).is_none() || !w.actors[a].alive || w.crashed(a), "{defence} downed the attacking {attacker}");
            assert!(w.actors[d].alive, "{defence} survived the {attacker}");
        }
    }
    let mut w = sky(4);
    let e3 = spawn(&mut w, "E3", 0, 30, 30);
    let yak = w.spawn_unit(ty(&w, "YAK"), 1, cell_center(30), cell_center(50), 0);
    w.queue_order(Order::Attack { player: 1, ids: vec![w.make_ref(yak)], target: w.make_ref(e3) });
    let mut fired_at = None;
    for _ in 0..25 * 10 {
        w.step();
        if fired_at.is_none() && w.actors[e3].reload[0] > 0 {
            fired_at = Some(dist(w.actors[e3].x, w.actors[e3].y, w.actors[yak].x, w.actors[yak].y));
        }
    }
    let fired_at = fired_at.expect("the rocket soldier fired its Redeye");
    assert!(fired_at > 5 * CELL + CELL / 2, "beyond the Dragon's reach: {fired_at}");
}

/// Support power aircraft (paratrooper and parabomb Badgers) are shot down
/// on their way over an AA defence line; the spy plane cannot be targeted.
#[test]
fn support_power_planes_are_shot_down_but_not_the_spy_plane() {
    let power = |w: &World, key: &str| -> SupportPowerInfo {
        w.rules
            .actors
            .iter()
            .filter_map(|a| a.abilities.support_powers.as_ref())
            .flatten()
            .find(|p| p.key == key)
            .unwrap_or_else(|| panic!("power {key}"))
            .clone()
    };
    for key in ["ParatroopersPower@paratroopers", "AirstrikePower@parabombs"] {
        // An AA line along the flight path (west to east over row 30).
        let mut w = sky(5);
        for k in 0..5 {
            spawn(&mut w, "SAM", 0, 18 + k * 8, 26);
            spawn(&mut w, "AGUN", 0, 20 + k * 8, 34);
        }
        assert!(!w.players[0].low_power());
        let info = power(&w, key);
        let planes = w.launch_air_power(1, &info, 0, cell_center(30), cell_center(30), Some((cell_center(60), cell_center(30)))).unwrap();
        let refs: Vec<u32> = planes.iter().map(|&p| w.make_ref(p)).collect();
        let hp: Vec<i32> = planes.iter().map(|&p| w.actors[p].hp).collect();
        let mut hit = false;
        let mut downed = false;
        for _ in 0..25 * 30 {
            w.step();
            for (k, &p) in planes.iter().enumerate() {
                let alive = w.resolve(refs[k]).is_some() && w.actors[p].alive;
                hit |= !alive || w.actors[p].hp < hp[k];
                downed |= alive && w.crashed(p) || w.losses[1] > 0;
            }
        }
        assert!(hit, "{key}: the Badgers were hit");
        assert!(downed, "{key}: a Badger went down");
    }
    let mut w = sky(6);
    let sam = spawn(&mut w, "SAM", 0, 30, 30);
    let info = power(&w, "AirstrikePower@spyplane");
    let planes = w.launch_air_power(1, &info, 0, cell_center(30), cell_center(30), Some((cell_center(60), cell_center(30)))).unwrap();
    assert!(planes.iter().all(|&p| w.actors[p].air.mission == Mission::SpyPlane));
    for _ in 0..25 * 20 {
        w.step();
        assert_eq!(w.actors[sam].target, NONE, "the spy plane is not targetable (-Targetable@AIRBORNE)");
    }
}

// ---- Air-only weapons and ground-only weapons ------------------------------------------

/// AA guns and SAM sites (ValidTargets AirborneActor) never pick, aim at or
/// fire on anything on the ground: infantry, vehicles, ships, structures,
/// and landed aircraft (which count as vehicles).
#[test]
fn air_only_weapons_ignore_the_ground() {
    for defence in ["AGUN", "SAM"] {
        let mut w = sky(7);
        // The Hind lands first: while it comes down it is still in the air.
        let heli = quiet_flyer(&mut w, "HIND", 1, 33, 33);
        w.queue_order(Order::Land { player: 1, ids: vec![w.make_ref(heli)], x: cell_center(33), y: cell_center(33) });
        run(&mut w, 100);
        assert!(w.actors[heli].heli.landed, "the Hind landed in range");
        let d = spawn(&mut w, defence, 0, 30, 30);
        let foes = [
            spawn(&mut w, "E1", 1, 33, 30),
            spawn(&mut w, "2TNK", 1, 30, 33),
            spawn(&mut w, "PBOX", 1, 26, 30),
            spawn(&mut w, "PT", 1, 10, 30),
        ];
        for &f in &foes {
            w.actors[f].reload = [1_000_000; MAX_WEAPONS];
        }
        for _ in 0..25 * 10 {
            w.step();
            assert_eq!(w.actors[d].target, NONE, "{defence} never targets the ground");
            assert_eq!(w.actors[d].reload[0], 0, "{defence} never fires");
        }
        for &f in foes.iter().chain([heli].iter()) {
            assert_eq!(w.actors[f].hp, max_hp(&w, f), "{defence} left {} alone", w.rules.actors[w.actors[f].ty as usize].id);
        }
        // The same Hind back in the air is shot at at once.
        w.queue_order(Order::Deploy { player: 1, ids: vec![w.make_ref(heli)] });
        run(&mut w, 60);
        assert!(w.actors[heli].hp < max_hp(&w, heli), "{defence} fires once it lifts off");
    }
}

/// A rocket soldier fights ground targets with its Dragon only and aircraft
/// with its Redeye only (each weapon's ValidTargets).
#[test]
fn rocket_soldiers_pick_the_weapon_for_the_target() {
    let mut w = sky(8);
    let e3 = spawn(&mut w, "E3", 0, 30, 30);
    let tank = spawn(&mut w, "2TNK", 1, 34, 30);
    w.actors[tank].reload = [1_000_000; MAX_WEAPONS];
    run(&mut w, 25 * 4);
    assert!(w.actors[tank].hp < max_hp(&w, tank), "the tank was hit");
    assert_eq!(w.actors[e3].reload[0], 0, "no Redeye at the tank");
    w.kill(tank);
    run(&mut w, 25 * 3);
    let heli = quiet_flyer(&mut w, "MH60", 1, 33, 30);
    let dragon_reload = w.actors[e3].reload[1];
    run(&mut w, 25 * 3);
    assert!(w.actors[heli].hp < max_hp(&w, heli), "the helicopter was hit");
    assert!(w.actors[e3].reload[0] > 0, "with the Redeye");
    assert!(w.actors[e3].reload[1] <= dragon_reload, "no Dragon at the helicopter");
}

/// Ground-only weapons (rifles, tank guns, the Tesla Coil) never target a
/// flying aircraft, and do not hurt it with ground bursts below it.
#[test]
fn ground_weapons_never_hit_flying_aircraft() {
    let mut w = sky(9);
    let shooters = [spawn(&mut w, "E1", 0, 30, 30), spawn(&mut w, "2TNK", 0, 31, 31), spawn(&mut w, "TSLA", 0, 27, 27)];
    let heli = quiet_flyer(&mut w, "HIND", 1, 33, 30);
    let yak = quiet_flyer(&mut w, "YAK", 1, 30, 33);
    for _ in 0..25 * 10 {
        w.step();
        for &s in &shooters {
            assert_eq!(w.actors[s].target, NONE);
            assert_eq!(w.auto_scan(s), None);
        }
    }
    assert_eq!(w.actors[heli].hp, max_hp(&w, heli));
    assert_eq!(w.actors[yak].hp, max_hp(&w, yak));
}

// ---- Power -----------------------------------------------------------------------------

/// AA guns and SAM sites need power (OpenRA ^DisableOnLowPowerOrPowerDown):
/// on low power or switched off they hold fire, with power again they shoot.
#[test]
fn anti_air_structures_need_power() {
    for defence in ["AGUN", "SAM"] {
        let mut map = Map::filled(48, 48, Terrain::Clear);
        map.spawns = vec![(2, 2), (40, 40)];
        let players = [PlayerSetup::new("soviet", None), PlayerSetup::new("allies", None)];
        let mut w = World::on_map(1, map, &players, GameOptions { fog: false, explored: true, ..GameOptions::default() });
        let d = spawn(&mut w, defence, 0, 20, 20);
        assert!(w.rules.actors[w.actors[d].ty as usize].requires_power);
        assert!(w.players[0].low_power(), "no power plant yet");
        let heli = quiet_flyer(&mut w, "MH60", 1, 23, 20);
        run(&mut w, 25 * 4);
        assert_eq!(w.actors[heli].hp, max_hp(&w, heli), "{defence} is out of power");
        assert_eq!(w.actors[d].reload[0], 0);
        // Power: it fires.
        spawn(&mut w, "POWR", 0, 10, 10);
        spawn(&mut w, "POWR", 0, 10, 14);
        assert!(!w.players[0].low_power());
        run(&mut w, 25 * 2);
        let hp = w.actors[heli].hp;
        assert!(hp < max_hp(&w, heli), "{defence} fires with power");
        // Switched off with the power down button: silent again.
        w.queue_order(Order::PowerDown { player: 0, building: w.make_ref(d) });
        run(&mut w, 25);
        let hp = w.actors[heli].hp;
        run(&mut w, 25 * 4);
        assert!(w.actors[d].powered_off);
        assert_eq!(w.actors[heli].hp, hp, "{defence} switched off holds fire");
    }
}

// ---- Orders and cursors ------------------------------------------------------------------

/// The attack cursor shows over a flying aircraft only when a selected unit
/// can hit it; a smart order sends those units to attack and the others to
/// the spot; landed aircraft are ground targets for everyone.
#[test]
fn attack_cursor_and_smart_orders_on_aircraft() {
    let mut w = sky(10);
    let e1 = spawn(&mut w, "E1", 0, 30, 30);
    let tank = spawn(&mut w, "2TNK", 0, 30, 32);
    let e3 = spawn(&mut w, "E3", 0, 30, 34);
    let heli = quiet_flyer(&mut w, "HIND", 1, 44, 30);
    run(&mut w, 1);
    let (hx, hy) = (w.actors[heli].x, w.actors[heli].y);
    assert_eq!(w.actor_at(0, hx, hy), Some(heli));
    assert_eq!(w.smart_action(0, &[e1], hx, hy), SmartAction::Move, "rifles cannot hit it: move cursor");
    assert_eq!(w.smart_action(0, &[e1, tank], hx, hy), SmartAction::Move);
    assert_eq!(w.smart_action(0, &[e3], hx, hy), SmartAction::Attack, "the Redeye can");
    assert_eq!(w.smart_action(0, &[e1, tank, e3], hx, hy), SmartAction::Attack, "one capable unit is enough");
    assert!(!w.can_attack_actor(e1, heli) && !w.can_attack_actor(tank, heli) && w.can_attack_actor(e3, heli));
    let ids = [e1, tank, e3].iter().map(|&u| w.make_ref(u)).collect();
    w.queue_order(Order::Smart { player: 0, ids, x: hx, y: hy });
    run(&mut w, 2);
    assert_eq!(w.actors[e3].activity, Activity::Attack);
    assert_eq!(w.actors[e3].target, w.make_ref(heli));
    for u in [e1, tank] {
        assert_eq!(w.actors[u].activity, Activity::Move, "moves to the spot instead");
        assert_eq!(w.actors[u].target, NONE);
    }
    // Landed, it is a ground target: everyone's attack cursor.
    w.queue_order(Order::Land { player: 1, ids: vec![w.make_ref(heli)], x: hx, y: hy });
    let mut landed = false;
    for _ in 0..200 {
        w.step();
        if w.actors[heli].heli.landed {
            landed = true;
            break;
        }
    }
    assert!(landed);
    let (hx, hy) = (w.actors[heli].x, w.actors[heli].y);
    assert_eq!(w.smart_action(0, &[e1], hx, hy), SmartAction::Attack);
    assert!(w.can_attack_actor(tank, heli));
}

/// An attack order on an aircraft out of range: the rocket soldier on
/// HoldFire walks into Redeye range and downs it; a tank given the same
/// order ignores it (no weapon can hit it) and keeps what it was doing.
#[test]
fn manual_attack_orders_on_aircraft() {
    let mut w = sky(12);
    let e3 = spawn(&mut w, "E3", 0, 20, 30);
    set_stance(&mut w, 0, &[e3], Stance::HoldFire);
    let heli = quiet_flyer(&mut w, "TRAN", 1, 40, 30);
    run(&mut w, 25 * 2);
    assert_eq!(w.actors[e3].target, NONE, "hold fire: no target of its own");
    w.queue_order(Order::Attack { player: 0, ids: vec![w.make_ref(e3)], target: w.make_ref(heli) });
    let href = w.make_ref(heli);
    let mut down = false;
    for _ in 0..25 * 60 {
        w.step();
        if w.resolve(href).is_none() || !w.actors[heli].alive || w.crashed(heli) {
            down = true;
            break;
        }
    }
    assert!(down, "the Chinook was shot down");
    assert!(dist(w.actors[e3].x, w.actors[e3].y, cell_center(20), cell_center(30)) > 4 * CELL, "it walked into range");

    let mut w = sky(13);
    let tank = spawn(&mut w, "2TNK", 0, 20, 30);
    let heli = quiet_flyer(&mut w, "HIND", 1, 24, 30);
    w.queue_order(Order::Move { player: 0, ids: vec![w.make_ref(tank)], x: cell_center(20), y: cell_center(40), attack_move: false });
    run(&mut w, 2);
    w.queue_order(Order::Attack { player: 0, ids: vec![w.make_ref(tank)], target: w.make_ref(heli) });
    run(&mut w, 2);
    assert_eq!(w.actors[tank].activity, Activity::Move, "the tank drives on");
    assert_eq!(w.actors[tank].target, NONE);
}

// ---- Shots in the air ----------------------------------------------------------------

/// A Projectile of weapon `id` fired by player 0 from (x, y) at actor `t`.
fn missile(w: &World, id: &str, x: i32, y: i32, t: usize, alt: i32) -> Projectile {
    let weapon = w.rules.weapons.iter().position(|k| k.name == id).unwrap() as u16;
    let (tx, ty) = (w.actors[t].x, w.actors[t].y);
    Projectile { x, y, tx, ty, weapon, owner: 0, target: w.make_ref(t), facing: 0, shot: Shot::NONE, alt, ox: 0, oy: 0, travel: 0 }
}

/// Bursts are measured in 3D (OpenRA SpreadDamage from the impact position):
/// a SAM missile that bursts on the ground under a helicopter does nothing
/// to it, one that bursts up at its height hits it; a nuke on the ground
/// reaches up to aircraft overhead.
#[test]
fn bursts_reach_aircraft_only_at_their_height() {
    let mut w = sky(14);
    let heli = quiet_flyer(&mut w, "MH60", 1, 30, 30);
    run(&mut w, 1);
    let (x, y, alt) = (w.actors[heli].x, w.actors[heli].y, w.actors[heli].altitude);
    assert!(alt > 0);
    let mut low = missile(&w, "Nike", x, y, heli, 0);
    low.target = NONE;
    w.projectiles.push(low);
    run(&mut w, 2);
    assert_eq!(w.actors[heli].hp, max_hp(&w, heli), "a ground burst misses the helicopter above");
    let mut high = missile(&w, "Nike", x, y, heli, alt);
    high.target = NONE;
    w.projectiles.push(high);
    run(&mut w, 2);
    assert!(w.actors[heli].hp < max_hp(&w, heli), "a burst at its height hits");

    let mut w = sky(15);
    let heli = quiet_flyer(&mut w, "MH60", 1, 30, 30);
    let far = quiet_flyer(&mut w, "MH60", 1, 30, 50);
    run(&mut w, 1);
    let atomic = w.rules.weapons.iter().position(|k| k.name == "Atomic").unwrap();
    let (x, y) = (w.actors[heli].x, w.actors[heli].y);
    w.impact(atomic, x, y, 0);
    run(&mut w, 2);
    assert!(!w.actors[heli].alive || w.actors[heli].hp < max_hp(&w, heli), "the nuke reaches up to it");
    assert_eq!(w.actors[far].hp, max_hp(&w, far), "but not 20 cells away");
}

/// Missiles fly at most their RangeLimit (OpenRA Missile, ExplodeWhenEmpty):
/// a SAM missile chasing a plane that outruns it bursts out of fuel and
/// misses; one that catches it in time hits.
#[test]
fn missiles_run_out_of_fuel() {
    let nike = |w: &World| w.rules.weapons.iter().find(|k| k.name == "Nike").unwrap().clone();
    let chase = |gap: i32| {
        let mut w = sky(16);
        let yak = quiet_flyer(&mut w, "YAK", 1, 30, 20);
        // Straight north-south flight, away from the missile.
        w.queue_order(Order::Move { player: 1, ids: vec![w.make_ref(yak)], x: cell_center(30), y: cell_center(63), attack_move: false });
        run(&mut w, 30);
        let (x, y, alt) = (w.actors[yak].x, w.actors[yak].y, w.actors[yak].altitude);
        let p = missile(&w, "Nike", x, y - gap, yak, alt);
        w.projectiles.push(p);
        let mut flown = 0;
        while !w.projectiles.is_empty() && flown < 200 {
            w.step();
            flown += 1;
        }
        assert!(w.projectiles.is_empty(), "the missile is gone");
        (w.actors[yak].hp < max_hp(&w, yak) || !w.actors[yak].alive, flown)
    };
    let w = sky(16);
    let info = nike(&w);
    assert_eq!(info.range_limit, 11 * CELL, "Nike RangeLimit 11c0");
    let (hit, _) = chase(2 * CELL);
    assert!(hit, "caught in time");
    let (hit, flown) = chase(7 * CELL);
    assert!(!hit, "outran");
    assert!(flown * info.speed <= info.range_limit + info.speed, "burst when its fuel ran out ({flown} ticks)");
    // Every missile has its fuel limit (RangeLimit, else the weapon's Range).
    for k in w.rules.weapons.iter().filter(|k| k.projectile == crate::rules::Projectile::Missile) {
        assert!(k.range_limit > 0, "{} has a fuel limit", k.name);
    }
}

// ---- The AI ------------------------------------------------------------------------------

/// An Allied and a Soviet bot build their side's anti-air defence (OpenRA
/// BaseBuilderBotModule BuildingFractions agun, sam) and rocket soldiers
/// (UnitsToBuild e3), and their base downs a helicopter that attacks it.
#[test]
fn ai_builds_and_uses_anti_air() {
    use crate::ai_bots::BotType;
    use crate::world::AiDifficulty;
    for (faction, defence) in [("england", "AGUN"), ("russia", "SAM")] {
        let mut map = Map::filled(64, 64, Terrain::Clear);
        for y in 0..64 {
            for x in 0..64 {
                if (4..10).contains(&x) && (20..30).contains(&y) {
                    let i = map.idx(x, y);
                    map.ore[i] = 10;
                }
            }
        }
        map.spawns = vec![(6, 6), (56, 56)];
        let players = [
            PlayerSetup { bot: BotType::Normal, ..PlayerSetup::new(faction, Some(AiDifficulty::Normal)) },
            PlayerSetup::new("england", None),
        ];
        // No fog: the attacker sees its target (vision is not the point here).
        let options =
            GameOptions { starting_units: crate::world::StartingUnits::Base, fog: false, explored: true, ..GameOptions::default() };
        let mut w = World::on_map(21, map, &players, options);
        w.players[0].cash = 100_000;
        w.ai[0].passive = true;
        let defence_ty = ty(&w, defence);
        let e3 = ty(&w, "E3");
        let mut built = false;
        for _ in 0..25 * 60 * 15 {
            w.step();
            if w.actors.iter().any(|a| a.alive && a.owner == 0 && a.ty == defence_ty) {
                built = true;
                break;
            }
        }
        assert!(built, "{faction} built a {defence}");
        run(&mut w, 25 * 60 * 2);
        assert!(w.actors.iter().any(|a| a.alive && a.owner == 0 && a.ty == e3), "{faction} trains rocket soldiers");
        // A helicopter strike on the anti-air defence.
        let d = (0..w.actors.len()).find(|&i| w.actors[i].alive && w.actors[i].owner == 0 && w.actors[i].ty == defence_ty).unwrap();
        let (dx, dy) = w.cell_of(w.actors[d].x, w.actors[d].y);
        let heli = w.spawn_unit(ty(&w, "MH60"), 1, cell_center((dx + 14).min(62)), cell_center((dy + 14).min(62)), 0);
        let href = w.make_ref(heli);
        w.queue_order(Order::Attack { player: 1, ids: vec![href], target: w.make_ref(d) });
        let mut down = false;
        for _ in 0..25 * 40 {
            w.step();
            if w.resolve(href).is_none() || !w.actors[heli].alive || w.crashed(heli) {
                down = true;
                break;
            }
        }
        assert!(down, "{faction}'s base shot the Black Hawk down");
    }
}

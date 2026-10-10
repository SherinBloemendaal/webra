//! Ships, submarines and transports (naval.rs, cargo.rs).

use crate::map::{Map, Terrain};
use crate::math::{dist, CELL};
use crate::rules::{Kind, Rules, TARGET_SUBMARINE, TARGET_UNDERWATER, TARGET_WATER};
use crate::world::{cell_center, Activity, Order, SmartAction, World, NONE};

/// Land on the left (x < SHORE), open sea on the right.
const SHORE: i32 = 20;
const W: i32 = 56;
const H: i32 = 40;

/// Two players (allies vs soviet) on a coast map, no starting units, plenty of cash.
fn coast() -> World {
    let mut terrain = vec![Terrain::Clear; (W * H) as usize];
    for y in 0..H {
        for x in SHORE..W {
            terrain[(y * W + x) as usize] = Terrain::Water;
        }
    }
    let map = Map {
        width: W,
        height: H,
        terrain,
        ore: vec![0; (W * H) as usize],
        gems: vec![0; (W * H) as usize],
        spawns: vec![(2, 2), (2, 30)],
    };
    let mut w = World::empty(Rules::load(), map, 11);
    for (f, start) in [("allies", (2, 2)), ("soviet", (2, 30))] {
        let fi = w.rules.faction_index(f).unwrap();
        w.add_player(fi, false, start);
    }
    for p in w.players.iter_mut() {
        p.cash = 20000;
    }
    w.refresh_tokens();
    w.update_power();
    w.update_vision();
    w
}

fn ty(w: &World, id: &str) -> u16 {
    w.rules.actor_index(id).unwrap() as u16
}

fn unit(w: &mut World, id: &str, owner: u8, cx: i32, cy: i32) -> usize {
    let t = ty(w, id);
    w.spawn_unit(t, owner, cell_center(cx), cell_center(cy), 0)
}

fn run(w: &mut World, ticks: u32) {
    for _ in 0..ticks {
        w.step();
    }
}

fn on_water(w: &World, i: usize) -> bool {
    w.map.terrain[w.cell_index(w.actors[i].x, w.actors[i].y)] == Terrain::Water
}

fn weapon(w: &World, name: &str) -> usize {
    w.rules.weapons.iter().position(|x| x.name == name).unwrap()
}

// ---- Ships ---------------------------------------------------------------------

#[test]
fn naval_yards_launch_ships_onto_open_water() {
    let mut w = coast();
    // Power and a construction yard for the prerequisites; yards on the water.
    w.spawn_building(ty(&w, "FACT"), 0, 4, 4);
    w.spawn_building(ty(&w, "POWR"), 0, 9, 4);
    let syrd = w.spawn_building(ty(&w, "SYRD"), 0, 26, 8).unwrap();
    w.spawn_building(ty(&w, "FACT"), 1, 4, 30);
    w.spawn_building(ty(&w, "POWR"), 1, 9, 30);
    let spen = w.spawn_building(ty(&w, "SPEN"), 1, 26, 28).unwrap();
    w.refresh_tokens();
    let (pt, ss) = (ty(&w, "PT"), ty(&w, "SS"));
    assert!(w.availability(0, pt).enabled, "gunboat buildable with a naval yard");
    assert!(w.availability(1, ss).enabled, "submarine buildable with a sub pen");
    w.queue_order(Order::StartProduction { player: 0, ty: pt, count: 2 });
    w.queue_order(Order::StartProduction { player: 1, ty: ss, count: 1 });
    let ticks = w.rules.actors[pt as usize].build_ticks.max(w.rules.actors[ss as usize].build_ticks) as u32 * 2 + 20;
    run(&mut w, ticks);
    let built: Vec<usize> = (0..w.actors.len()).filter(|&i| w.actors[i].alive && (w.actors[i].ty == pt || w.actors[i].ty == ss)).collect();
    assert_eq!(built.len(), 3, "two gunboats and a submarine launched");
    for &i in &built {
        assert!(on_water(&w, i), "ship on water");
        assert_eq!(w.building_at[w.cell_index(w.actors[i].x, w.actors[i].y)], NONE, "not inside the yard");
        let yard = if w.actors[i].owner == 0 { syrd } else { spen };
        assert!(dist(w.actors[i].x, w.actors[i].y, w.actors[yard].x, w.actors[yard].y) < 5 * CELL, "next to its yard");
    }
    // The two gunboats do not end up stacked.
    let pts: Vec<usize> = built.iter().copied().filter(|&i| w.actors[i].ty == pt).collect();
    assert!(dist(w.actors[pts[0]].x, w.actors[pts[0]].y, w.actors[pts[1]].x, w.actors[pts[1]].y) >= 384);
}

#[test]
fn ships_move_on_water_only() {
    let mut w = coast();
    let dd = unit(&mut w, "DD", 0, 40, 20);
    let lst = unit(&mut w, "LST", 0, 44, 22);
    // Order them deep inland: they stop at the shore.
    w.queue_order(Order::Move {
        player: 0,
        ids: vec![w.make_ref(dd), w.make_ref(lst)],
        x: cell_center(5),
        y: cell_center(20),
        attack_move: false,
    });
    for _ in 0..1500 {
        w.step();
        assert!(on_water(&w, dd) && on_water(&w, lst), "ships never enter land");
    }
    for i in [dd, lst] {
        let (cx, _) = w.cell_of(w.actors[i].x, w.actors[i].y);
        assert!(cx <= SHORE + 2, "ship sailed to the coast, ended at column {cx}");
        assert_eq!(w.actors[i].activity, Activity::Idle);
    }
    // Ground units cannot enter the sea either.
    let tank = unit(&mut w, "1TNK", 0, 10, 10);
    w.queue_order(Order::Move { player: 0, ids: vec![w.make_ref(tank)], x: cell_center(45), y: cell_center(10), attack_move: false });
    for _ in 0..800 {
        w.step();
        assert!(!on_water(&w, tank), "tanks stay on land");
    }
}

// ---- Submarines -----------------------------------------------------------------

#[test]
fn submarines_hide_until_they_fire() {
    let mut w = coast();
    // Structures keep both players in the game (submarines alone do not).
    for p in 0..2u8 {
        let start = w.players[p as usize].start;
        w.spawn_building(ty(&w, "POWR"), p, start.0, start.1);
    }
    let ss = unit(&mut w, "SS", 0, 30, 20);
    // An enemy cruiser in sight, but cruisers cannot detect subs.
    let ca = unit(&mut w, "CA", 1, 36, 20);
    run(&mut w, 3);
    assert!(w.actors[ss].submerged, "InitialDelay 0: dives right away");
    assert!(!w.is_visible_to(ss, 1), "invisible to the enemy");
    assert!(w.is_visible_to(ss, 0), "its owner still sees it");
    assert_eq!(w.target_class(ss), TARGET_UNDERWATER | TARGET_SUBMARINE);
    assert_eq!(w.scan_for_target(ca), None, "the cruiser finds nothing to shoot");
    w.kill(ca);
    // An unarmed transport in torpedo range: the sub surfaces to attack it.
    let lst = unit(&mut w, "LST", 1, 35, 21);
    w.update_vision();
    let hp0 = w.actors[lst].hp;
    let mut surfaced = false;
    for _ in 0..200 {
        w.step();
        if !w.actors[ss].submerged {
            surfaced = true;
            // Seen by the enemy while it still has eyes nearby (the transport sinks quickly).
            assert!(!w.actors[lst].alive || w.is_visible_to(ss, 1), "a surfaced sub can be seen");
            assert_eq!(w.target_class(ss), TARGET_WATER | TARGET_SUBMARINE);
        }
    }
    assert!(surfaced, "surfaced to fire");
    assert!(!w.actors[lst].alive || w.actors[lst].hp < hp0, "torpedoes hit the transport");
    // With nothing left to shoot, it dives again after CloakDelay (50 ticks).
    if w.actors[lst].alive {
        w.kill(lst);
    }
    let delay = w.rules.actors[ty(&w, "SS") as usize].abilities.cloak.as_ref().unwrap().cloak_delay as u32;
    run(&mut w, delay + 2);
    assert!(w.actors[ss].submerged, "back under water");
}

#[test]
fn depth_charges_hit_submerged_submarines() {
    let mut w = coast();
    let ss = unit(&mut w, "SS", 0, 30, 20);
    // A destroyer within its 4-cell detection range.
    let dd = unit(&mut w, "DD", 1, 33, 20);
    let charge = weapon(&w, "DepthCharge");
    let max = w.actors[ss].hp;
    let mut charges = 0;
    for _ in 0..300 {
        // Keep the sub from firing back so it stays submerged.
        w.actors[ss].reload = [1000; crate::world::MAX_WEAPONS];
        w.step();
        if w.projectiles.iter().any(|p| p.weapon as usize == charge) {
            charges += 1;
        }
        if !w.actors[ss].alive {
            break;
        }
    }
    assert!(w.actors[dd].alive);
    assert!(charges > 0, "the destroyer dropped depth charges");
    assert!(!w.actors[ss].alive || w.actors[ss].submerged, "the sub never surfaced");
    assert!(!w.actors[ss].alive || w.actors[ss].hp < max, "depth charges damaged the sub");
    // Only weapons with Underwater targets can engage a submerged sub.
    let c = TARGET_UNDERWATER | TARGET_SUBMARINE;
    assert!(w.rules.weapons[charge].can_target_class(c));
    for name in ["Stinger", "2Inch", "8Inch", "25mm"] {
        assert!(!w.rules.weapons[weapon(&w, name)].can_target_class(c), "{name} cannot hit a submerged sub");
    }
    assert!(w.rules.weapons[weapon(&w, "TorpTube")].can_target_class(c), "torpedoes can");
    // Depth charges cannot be aimed at surface ships.
    assert!(!w.rules.weapons[charge].can_target_class(TARGET_WATER));
}

#[test]
fn naval_yards_detect_nearby_submarines() {
    let mut w = coast();
    w.spawn_building(ty(&w, "SYRD"), 1, 26, 18);
    let ss = unit(&mut w, "SS", 0, 31, 19);
    run(&mut w, 4);
    assert!(w.actors[ss].submerged);
    assert!(w.is_visible_to(ss, 1), "a naval yard detects subs within 10 cells");
}

#[test]
fn cruiser_respects_minimum_range() {
    let mut w = coast();
    let ca = unit(&mut w, "CA", 0, 30, 20);
    let close = unit(&mut w, "LST", 1, 32, 20);
    let inch = weapon(&w, "8Inch");
    let min_range = w.rules.weapons[inch].min_range;
    assert!(min_range > 0 && w.rules.weapons[inch].inaccuracy > 0);
    w.queue_order(Order::Attack { player: 0, ids: vec![w.make_ref(ca)], target: w.make_ref(close) });
    let d0 = dist(w.actors[ca].x, w.actors[ca].y, w.actors[close].x, w.actors[close].y);
    let mut fired_close = false;
    for _ in 0..150 {
        w.step();
        let d = w.hit_distance(close, w.actors[ca].x, w.actors[ca].y);
        if d < min_range && w.projectiles.iter().any(|p| p.weapon as usize == inch) {
            fired_close = true;
        }
    }
    assert!(!fired_close, "no shot inside the 3-cell minimum range");
    assert!(dist(w.actors[ca].x, w.actors[ca].y, w.actors[close].x, w.actors[close].y) > d0, "the cruiser backs off");
    // A target out at 12 cells gets shelled (and the shells scatter).
    let far = unit(&mut w, "LST", 1, 30, 32);
    w.queue_order(Order::Attack { player: 0, ids: vec![w.make_ref(ca)], target: w.make_ref(far) });
    let mut shells = 0;
    for _ in 0..200 {
        w.step();
        shells += w.projectiles.iter().filter(|p| p.weapon as usize == inch).count();
    }
    assert!(shells > 0, "long range artillery fires");
}

#[test]
fn ships_get_repaired_at_their_naval_yard() {
    let mut w = coast();
    let syrd = w.spawn_building(ty(&w, "SYRD"), 0, 26, 8).unwrap();
    let dd = unit(&mut w, "DD", 0, 40, 28);
    let max = w.actors[dd].hp;
    w.actors[dd].hp = max / 4;
    let (yx, yy) = (w.actors[syrd].x, w.actors[syrd].y);
    w.rebuild_hash();
    assert_eq!(w.smart_action(0, &[dd], yx, yy), SmartAction::Repair);
    // Vehicles do not repair at a naval yard.
    let tank = unit(&mut w, "1TNK", 0, 10, 10);
    assert_ne!(w.smart_action(0, &[tank], yx, yy), SmartAction::Repair);
    let cash = w.players[0].funds();
    w.queue_order(Order::Smart { player: 0, ids: vec![w.make_ref(dd)], x: yx, y: yy });
    run(&mut w, 25 * 60);
    assert_eq!(w.actors[dd].hp, max, "fully repaired");
    assert!(w.players[0].funds() < cash, "repairs cost money");
    assert!(w.hit_distance(syrd, w.actors[dd].x, w.actors[dd].y) <= crate::naval::REPAIR_NEAR_RANGE, "repaired near the yard");
    assert_eq!(w.actors[dd].activity, Activity::Idle);
}

#[test]
fn ships_sink_with_a_wreck_effect() {
    let mut w = coast();
    let pt = unit(&mut w, "PT", 0, 30, 20);
    w.kill(pt);
    assert!(w.effects.iter().any(|e| e.kind == crate::world::EffectKind::Naval(crate::naval::NAVAL_WRECK)));
}

// ---- Transports -----------------------------------------------------------------

fn passengers_of(w: &World, t: usize) -> Vec<usize> {
    w.passengers(t)
}

#[test]
fn infantry_load_into_an_apc_and_unload() {
    let mut w = coast();
    let apc = unit(&mut w, "APC", 0, 10, 10);
    let men: Vec<usize> = (0..3).map(|k| unit(&mut w, "E1", 0, 5 + k, 16)).collect();
    w.rebuild_hash();
    let (ax, ay) = (w.actors[apc].x, w.actors[apc].y);
    assert_eq!(w.smart_action(0, &men, ax, ay), SmartAction::Load);
    // A tank cannot get into an APC (Cargo.Types: Infantry).
    let tank = unit(&mut w, "1TNK", 0, 14, 14);
    assert!(!w.can_enter(tank, apc));
    let ids = men.iter().map(|&i| w.make_ref(i)).collect();
    w.queue_order(Order::Smart { player: 0, ids, x: ax, y: ay });
    run(&mut w, 400);
    assert_eq!(passengers_of(&w, apc).len(), 3, "everyone got in");
    assert_eq!(w.cargo_weight(apc), 3);
    for &m in &men {
        assert!(!w.actors[m].in_world());
        let ci = w.cell_index(w.actors[m].x, w.actors[m].y);
        assert!(!w.units_in_cell(ci).contains(&(m as u32)), "passengers are out of the spatial hash");
        assert!(!w.is_visible_to(m, 1));
    }
    // Passengers ride along.
    w.queue_order(Order::Move { player: 0, ids: vec![w.make_ref(apc)], x: cell_center(12), y: cell_center(25), attack_move: false });
    run(&mut w, 300);
    assert_eq!(w.cell_of(w.actors[men[0]].x, w.actors[men[0]].y), w.cell_of(w.actors[apc].x, w.actors[apc].y));
    // Orders to passengers are ignored.
    w.queue_order(Order::Move { player: 0, ids: vec![w.make_ref(men[0])], x: cell_center(2), y: cell_center(2), attack_move: false });
    run(&mut w, 2);
    assert!(!w.actors[men[0]].in_world());
    // Deploy unloads them onto free cells around the APC.
    assert!(w.can_unload(apc));
    w.queue_order(Order::Deploy { player: 0, ids: vec![w.make_ref(apc)] });
    run(&mut w, 100);
    assert!(passengers_of(&w, apc).is_empty());
    let mut cells = Vec::new();
    for &m in &men {
        let a = &w.actors[m];
        assert!(a.alive && a.in_world());
        assert!(dist(a.x, a.y, w.actors[apc].x, w.actors[apc].y) <= 3 * CELL, "next to the APC");
        cells.push(w.cell_index(a.x, a.y));
    }
    cells.sort_unstable();
    cells.dedup();
    assert_eq!(cells.len(), 3, "each on its own cell");
}

#[test]
fn transport_capacity_is_respected() {
    let mut w = coast();
    let jeep = unit(&mut w, "JEEP", 0, 10, 10);
    let a = unit(&mut w, "E1", 0, 10, 12);
    let b = unit(&mut w, "E1", 0, 11, 12);
    assert!(w.load_passenger(jeep, a));
    assert!(!w.can_enter(b, jeep), "a Ranger holds one soldier (MaxWeight 1)");
    assert!(!w.load_passenger(jeep, b));
    // Enemy units cannot get in.
    let foe = unit(&mut w, "E1", 1, 12, 12);
    let apc = unit(&mut w, "APC", 0, 14, 10);
    assert!(!w.can_enter(foe, apc));
}

#[test]
fn passengers_are_protected_and_die_with_the_transport() {
    let mut w = coast();
    let apc = unit(&mut w, "APC", 0, 10, 10);
    let man = unit(&mut w, "E1", 0, 10, 11);
    assert!(w.load_passenger(apc, man));
    // An enemy rifleman next to the APC targets the APC, never the passenger.
    let foe = unit(&mut w, "E1", 1, 12, 10);
    run(&mut w, 2);
    assert_eq!(w.scan_for_target(foe), Some(apc));
    // A big blast on the APC hurts it but not the soldier inside.
    let (x, y) = (w.actors[apc].x, w.actors[apc].y);
    let hp = (w.actors[apc].hp, w.actors[man].hp);
    w.impact(weapon(&w, "155mm"), x, y, 1);
    assert!(w.actors[apc].hp < hp.0);
    assert_eq!(w.actors[man].hp, hp.1);
    // No EjectOnDeath on the APC: the soldier dies with it.
    assert!(!w.rules.actors[ty(&w, "APC") as usize].abilities.cargo.as_ref().unwrap().eject_on_death);
    let losses = w.losses[0];
    w.damage(apc, 1_000_000);
    assert!(!w.actors[apc].alive && !w.actors[man].alive);
    assert_eq!(w.losses[0], losses + 2);
}

#[test]
fn transport_ship_loads_from_and_unloads_onto_the_beach() {
    let mut w = coast();
    // Transport moored next to the shore; a tank and a soldier walk aboard.
    let lst = unit(&mut w, "LST", 0, SHORE, 15);
    let tank = unit(&mut w, "1TNK", 0, 8, 10);
    let man = unit(&mut w, "E1", 0, 8, 20);
    w.rebuild_hash();
    let (lx, ly) = (w.actors[lst].x, w.actors[lst].y);
    assert_eq!(w.smart_action(0, &[tank, man], lx, ly), SmartAction::Load);
    let ids = vec![w.make_ref(tank), w.make_ref(man)];
    w.queue_order(Order::Smart { player: 0, ids, x: lx, y: ly });
    run(&mut w, 600);
    assert_eq!(passengers_of(&w, lst).len(), 2, "both on board");
    // Sail along the coast and land them on the beach further south.
    w.queue_order(Order::Move { player: 0, ids: vec![w.make_ref(lst)], x: cell_center(SHORE), y: cell_center(32), attack_move: false });
    run(&mut w, 500);
    assert!(on_water(&w, lst));
    assert!(w.can_unload(lst), "next to the shore");
    w.queue_order(Order::Deploy { player: 0, ids: vec![w.make_ref(lst)] });
    run(&mut w, 120);
    assert!(passengers_of(&w, lst).is_empty());
    for i in [tank, man] {
        let a = &w.actors[i];
        assert!(
            a.in_world() && !on_water(&w, i),
            "landed on the beach: {:?} {:?} lst {:?}",
            w.cell_of(a.x, a.y),
            a.activity,
            w.cell_of(w.actors[lst].x, w.actors[lst].y)
        );
        let (cx, cy) = w.cell_of(w.actors[i].x, w.actors[i].y);
        assert!(cx < SHORE && cy >= 28, "unloaded where the ship is, at ({cx}, {cy})");
    }
    // Out at sea there is nowhere to unload.
    let tank2 = unit(&mut w, "1TNK", 0, 8, 12);
    w.queue_order(Order::Move { player: 0, ids: vec![w.make_ref(lst)], x: cell_center(45), y: cell_center(32), attack_move: false });
    run(&mut w, 400);
    assert!(w.load_passenger(lst, tank2));
    assert_eq!(w.actors[tank2].kind, Kind::Vehicle);
    assert!(!w.can_unload(lst), "no land next to the ship out at sea");
}

#[test]
fn naval_game_is_deterministic() {
    let play = || {
        let mut w = coast();
        unit(&mut w, "SS", 0, 30, 20);
        unit(&mut w, "DD", 1, 34, 21);
        unit(&mut w, "CA", 0, 26, 10);
        unit(&mut w, "PT", 1, 40, 12);
        let apc = unit(&mut w, "APC", 0, 10, 10);
        let men: Vec<usize> = (0..4).map(|k| unit(&mut w, "E1", 0, 5 + k, 16)).collect();
        let men: Vec<u32> = men.into_iter().map(|i| w.make_ref(i)).collect();
        let (x, y) = (w.actors[apc].x, w.actors[apc].y);
        w.queue_order(Order::Smart { player: 0, ids: men, x, y });
        let mut hashes = Vec::new();
        for t in 0..900 {
            w.step();
            if t == 400 {
                w.queue_order(Order::Deploy { player: 0, ids: vec![w.make_ref(apc)] });
            }
            if t % 100 == 0 {
                hashes.push(w.state_hash());
            }
        }
        hashes
    };
    assert_eq!(play(), play());
}

#[test]
fn ships_render_turrets_at_their_offsets_and_subs_as_ripples() {
    use crate::render::{px, SpriteIds, View, SPRITE_FLOATS};
    let mut w = coast();
    let ca = unit(&mut w, "CA", 0, 34, 20);
    let ss = unit(&mut w, "SS", 0, 40, 10);
    run(&mut w, 3);
    let view = View { x0: 0.0, y0: 0.0, x1: 2000.0, y1: 2000.0 };
    let (mut sprites, mut rects) = (Vec::new(), Vec::new());
    let sprites_of = |s: &[f32], id: f32| -> Vec<(f32, f32, f32)> {
        s.chunks(SPRITE_FLOATS).filter(|c| c[3] == id).map(|c| (c[0], c[1], c[6])).collect()
    };
    // Facing north: the forward turret is above the centre, the aft one below.
    w.actors[ca].facing = 0;
    w.actors[ca].pfacing = 0;
    w.build_render(0, 1.0, &view, &[], &mut sprites, &mut rects);
    let (x, y) = (px(w.actors[ca].x), px(w.actors[ca].y));
    let turret = (w.actors[ca].ty * 2 + 1) as f32;
    let mut ts = sprites_of(&sprites, turret);
    ts.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap());
    assert_eq!(ts.len(), 2, "the cruiser has two turrets");
    assert!((ts[0].0 - x).abs() < 0.01 && (ts[0].1 - (y - px(768))).abs() < 0.01, "front turret {:?}", ts[0]);
    assert!((ts[1].0 - x).abs() < 0.01 && (ts[1].1 - (y + px(896))).abs() < 0.01, "rear turret {:?}", ts[1]);
    // Facing east: forward is +x.
    w.actors[ca].facing = 256;
    w.actors[ca].pfacing = 256;
    w.build_render(0, 1.0, &view, &[], &mut sprites, &mut rects);
    let ts = sprites_of(&sprites, turret);
    assert!(ts.iter().any(|t| (t.0 - (x + px(768))).abs() < 0.01 && (t.1 - y).abs() < 0.01), "{ts:?}");
    // The submerged sub: faint body and a ripple for its owner, nothing for the enemy.
    assert!(w.actors[ss].submerged);
    let body = (w.actors[ss].ty * 2) as f32;
    let ripple = SpriteIds::new(w.rules.actors.len()).naval_base + crate::naval::NAVAL_RIPPLE as f32;
    let b = sprites_of(&sprites, body);
    assert_eq!(b.len(), 1);
    assert!(b[0].2 < 0.5, "drawn faint");
    assert_eq!(sprites_of(&sprites, ripple).len(), 1);
    // Give the enemy vision there: still nothing drawn.
    unit(&mut w, "CA", 1, 46, 10);
    w.update_vision();
    w.build_render(1, 1.0, &view, &[], &mut sprites, &mut rects);
    assert!(sprites_of(&sprites, body).is_empty() && sprites_of(&sprites, ripple).is_empty());
}

#[test]
fn missile_submarine_fires_anti_air_missiles() {
    let mut w = coast();
    let msub = unit(&mut w, "MSUB", 0, 34, 20);
    // Human submarines start on HoldFire (AutoTarget InitialStance): let it pick targets.
    w.actors[msub].stance = crate::rules::Stance::AttackAnything;
    let yak = unit(&mut w, "YAK", 1, 37, 20);
    assert_eq!(w.actors[yak].kind, Kind::Aircraft);
    let aa = weapon(&w, "SubMissileAA");
    let surface = weapon(&w, "SubMissile");
    assert!(w.rules.actors[ty(&w, "MSUB") as usize].weapons.contains(&aa));
    let hp = w.actors[yak].hp;
    let mut aa_shots = 0;
    for _ in 0..150 {
        w.step();
        aa_shots += w.projectiles.iter().filter(|p| p.weapon as usize == aa).count();
        assert!(!w.projectiles.iter().any(|p| p.weapon as usize == surface), "no ground missiles at a plane");
        if !w.actors[yak].alive {
            break;
        }
    }
    assert!(aa_shots > 0, "anti-air missiles launched");
    assert!(!w.actors[yak].alive || w.actors[yak].hp < hp, "the plane was hit");
}

//! Simulation-level tests. Run with `cargo test -p webra-sim --release`.

use crate::math::CELL;
use crate::rules::{Kind, QueueType};
use crate::world::{cell_center, Activity, Order, World};

fn ty(w: &World, id: &str) -> u16 {
    w.rules.actor_index(id).unwrap() as u16
}

fn count(w: &World, owner: u8, id: &str) -> usize {
    let t = ty(w, id);
    w.actors.iter().filter(|a| a.alive && a.owner == owner && a.ty == t).count()
}

fn run(w: &mut World, ticks: u32) {
    for _ in 0..ticks {
        w.step();
    }
}

#[test]
fn same_seed_same_game() {
    let mut a = World::new(42, 80, &[("allies", true), ("soviet", true)]);
    let mut b = World::new(42, 80, &[("allies", true), ("soviet", true)]);
    for t in 0..4000 {
        a.step();
        b.step();
        if t % 500 == 0 {
            assert_eq!(a.state_hash(), b.state_hash(), "desync at tick {t}");
        }
    }
    assert_eq!(a.state_hash(), b.state_hash());
}

#[test]
fn player_builds_power_plant_and_places_it() {
    let mut w = World::new(1, 80, &[("allies", false), ("soviet", true)]);
    let powr = ty(&w, "POWR");
    let cash0 = w.players[0].cash;
    w.queue_order(Order::StartProduction { player: 0, ty: powr, count: 1 });
    let build = w.rules.actors[powr as usize].build_ticks as u32;
    run(&mut w, build + 5);
    let item = w.players[0].queues[QueueType::Building as usize].items[0].clone();
    assert!(item.done, "power plant finished after {build} ticks");
    assert_eq!(cash0 - w.players[0].cash, 300, "paid the full cost");
    let (sx, sy) = w.players[0].start;
    let spot = (sx + 4..sx + 8)
        .flat_map(|x| (sy - 2..sy + 6).map(move |y| (x, y)))
        .find(|&(x, y)| w.can_place(0, powr, x, y))
        .expect("a valid spot next to the construction yard");
    assert!(!w.can_place(0, powr, sx + 30, sy + 30), "too far from the base");
    w.queue_order(Order::Place { player: 0, ty: powr, cx: spot.0, cy: spot.1 });
    run(&mut w, 1);
    assert_eq!(count(&w, 0, "POWR"), 1);
    assert_eq!(w.players[0].power_gen, 100);
    // Barracks needs power: now available for Allies (TENT) but never BARR.
    assert!(w.availability(0, ty(&w, "TENT")).enabled);
    assert!(!w.availability(0, ty(&w, "BARR")).visible);
    // War factory needs a refinery first: shown but disabled.
    let weap = w.availability(0, ty(&w, "WEAP"));
    assert!(weap.visible && !weap.enabled);
}

#[test]
fn refinery_comes_with_a_harvester_that_earns_money() {
    let mut w = World::new(3, 80, &[("allies", false), ("soviet", true)]);
    let (sx, sy) = w.players[0].start;
    let proc_ = ty(&w, "PROC");
    w.spawn_building(ty(&w, "POWR"), 0, sx + 4, sy);
    w.spawn_building(proc_, 0, sx, sy + 5);
    w.refresh_tokens();
    assert_eq!(count(&w, 0, "HARV"), 1, "free harvester");
    assert_eq!(w.players[0].storage, 2000);
    let start = w.players[0].funds();
    run(&mut w, 25 * 90);
    assert!(w.players[0].funds() >= start + 500, "at least one full load delivered: {} -> {}", start, w.players[0].funds());
}

#[test]
fn units_cross_the_map_with_flow_fields() {
    // Open land: this is about sharing flow fields, not about queueing at fords.
    let players = [crate::world::PlayerSetup::new("allies", None), crate::world::PlayerSetup::new("soviet", None)];
    let options = crate::world::GameOptions { map_style: crate::mapgen::MapStyle::Land, ..Default::default() };
    let mut w = World::with_options(5, 96, &players, options);
    // WebRA's crowd movement (movement/soft.rs); the OpenRA model's group
    // moves are tested in movement/tests.rs.
    w.options.movement = crate::movement::MovementModel::WebRA;
    let tnk = ty(&w, "1TNK");
    let (sx, sy) = w.players[0].start;
    let (ex, ey) = w.players[1].start;
    let mut ids = Vec::new();
    for k in 0..12 {
        let u = w.spawn_unit(tnk, 0, cell_center(sx + 5 + k % 4), cell_center(sy + 6 + k / 4), 512);
        // Not a fight: the crowd near the enemy yard must not start shooting at it.
        w.actors[u].stance = crate::rules::Stance::HoldFire;
        ids.push(w.make_ref(u));
    }
    // Just in front of the enemy yard, on the side facing our base.
    let (gx, gy) = (cell_center(ex - 6), cell_center(ey + 2));
    w.queue_order(Order::Move { player: 0, ids: ids.clone(), x: gx, y: gy, attack_move: false });
    run(&mut w, 25 * 60);
    let fields = w.flow.computed;
    for r in ids {
        let i = w.resolve(r).unwrap();
        let a = &w.actors[i];
        assert_eq!(a.activity, Activity::Idle);
        let d = crate::math::dist(a.x, a.y, gx, gy);
        // Twelve tanks crowd around the goal; this map's bases sit in the
        // bottom row, so the crowd spreads along the map edge.
        assert!(d < 5 * CELL, "unit arrived near the goal, distance {d}");
    }
    assert!(fields <= 3, "the group shares one flow field, computed {fields}");
}

#[test]
fn light_tank_beats_rifleman_and_damage_follows_versus_table() {
    let mut w = World::new(7, 64, &[("allies", false), ("soviet", false)]);
    let (sx, sy) = w.players[0].start;
    let t = w.spawn_unit(ty(&w, "1TNK"), 0, cell_center(sx + 6), cell_center(sy + 8), 256);
    let e = w.spawn_unit(ty(&w, "E1"), 1, cell_center(sx + 10), cell_center(sy + 8), 768);
    let tref = w.make_ref(t);
    let eref = w.make_ref(e);
    run(&mut w, 25 * 20);
    assert!(w.resolve(eref).is_none(), "rifleman died");
    let tank = w.resolve(tref).expect("tank survived");
    let lost = w.rules.actors[w.actors[tank].ty as usize].hp - w.actors[tank].hp;
    // M1Carbine: 1000 damage, 10% versus Heavy armor -> 100 per hit.
    assert!(lost % 100 == 0, "every carbine hit does 100 to heavy armor, lost {lost}");
}

#[test]
fn heavy_tank_needs_service_depot() {
    let mut w = World::new(9, 80, &[("soviet", false), ("allies", true)]);
    let (sx, sy) = w.players[0].start;
    let t3 = ty(&w, "3TNK");
    w.spawn_building(ty(&w, "POWR"), 0, sx + 4, sy);
    w.spawn_building(ty(&w, "PROC"), 0, sx, sy + 5);
    w.spawn_building(ty(&w, "WEAP"), 0, sx + 4, sy + 4);
    w.refresh_tokens();
    let av = w.availability(0, t3);
    assert!(av.visible && !av.enabled);
    assert!(!w.availability(0, ty(&w, "1TNK")).visible, "allied tank hidden for soviets");
    w.spawn_building(ty(&w, "FIX"), 0, sx + 8, sy);
    w.refresh_tokens();
    assert!(w.availability(0, t3).enabled);
    w.players[0].cash = 10_000;
    w.queue_order(Order::StartProduction { player: 0, ty: t3, count: 2 });
    let ticks = 2 * w.rules.actors[t3 as usize].build_ticks as u32 * 4;
    run(&mut w, ticks);
    assert_eq!(count(&w, 0, "3TNK"), 2);
}

#[test]
fn ai_builds_a_base_and_army() {
    let mut w = World::new(11, 96, &[("allies", false), ("soviet", true)]);
    run(&mut w, 25 * 60 * 4);
    let buildings = w.actors.iter().filter(|a| a.alive && a.owner == 1 && a.kind == Kind::Building).count();
    let army = w
        .actors
        .iter()
        .filter(|a| a.alive && a.owner == 1 && a.kind != Kind::Building && !w.rules.actors[a.ty as usize].weapons.is_empty())
        .count();
    assert!(buildings >= 6, "AI built a base: {buildings} buildings");
    assert!(army >= 4, "AI built an army: {army}");
    assert!(count(&w, 1, "HARV") >= 1);
}

#[test]
fn ai_vs_ai_game_runs_and_fights() {
    let mut w = World::new(13, 80, &[("allies", true), ("soviet", true)]);
    let mut max_units = 0;
    // Contested gems pay more per trip, so both sides rebuild longer: games
    // with gems on seeds 10 to 17 ended after 9 to 18 minutes (7 to 13 before).
    // Veterancy and prone infantry spread them further: elite armies end some
    // games sooner, soldiers taking cover drag others out (5 to 26 minutes).
    // Map styles (mapgen) make richer, more varied maps on top of that.
    // OpenRA's Normal AI attacks with squads of 40 or more (ai_bots.rs):
    // this game ends after 33 minutes.
    for _ in 0..(25 * 60 * 45) {
        w.step();
        max_units = max_units.max(w.actors.iter().filter(|a| a.alive && a.kind != Kind::Building).count());
        if w.winner.is_some() {
            break;
        }
    }
    let killed: u32 = w.losses.iter().sum();
    assert!(max_units >= 10, "armies were built: {max_units}");
    assert!(killed >= 5, "fighting happened: {killed} dead");
    assert!(w.winner.is_some(), "one AI destroyed the other within 45 minutes");
}

#[test]
fn stress_world_ticks() {
    let mut w = World::new_stress(1, 4000, 160);
    let alive0 = w.actors.iter().filter(|a| a.alive).count();
    assert_eq!(alive0, 4000);
    let t0 = std::time::Instant::now();
    run(&mut w, 100);
    let per_tick = t0.elapsed().as_secs_f64() * 1000.0 / 100.0;
    eprintln!("stress: 4000 units, {per_tick:.2} ms per tick (native), {} flow fields", w.flow.computed);
}

#[test]
fn requirements_explain_what_is_missing() {
    let w = World::new(1, 64, &[("russia", false), ("england", true)]);
    let labels = |t: &str| w.requirements(0, ty(&w, t)).into_iter().map(|r| (r.label, r.never)).collect::<Vec<_>>();
    assert_eq!(labels("3TNK"), vec![("Service Depot".to_string(), false), ("War Factory".to_string(), false)]);
    assert_eq!(labels("1TNK"), vec![("Allies only".to_string(), true)]);
    assert_eq!(labels("TENT"), vec![("Power Plant or Advanced Power Plant".to_string(), false), ("Allies only".to_string(), true)]);
    // Russia can only ever build Soviet Barracks, so that is the only one named.
    assert_eq!(labels("E1"), vec![("Soviet Barracks".to_string(), false)]);
    assert_eq!(labels("TTNK")[0], ("Tesla Coil".to_string(), false));
    assert_eq!(labels("CTNK").last().unwrap(), &("Germany only".to_string(), true));
    assert!(labels("POWR").is_empty());
}

#[test]
fn tanks_crush_enemy_infantry_but_not_friends() {
    let mut w = World::new(17, 64, &[("allies", false), ("soviet", false)]);
    let (sx, sy) = w.players[0].start;
    let (x0, y) = (cell_center(sx + 6), cell_center(sy + 9));
    let tank = w.spawn_unit(ty(&w, "1TNK"), 0, x0, y, 256);
    let enemy = w.spawn_unit(ty(&w, "E1"), 1, x0 + 3 * CELL, y, 768);
    let friend = w.spawn_unit(ty(&w, "E1"), 0, x0 + 3 * CELL, y + 3 * CELL, 768);
    let (tref, eref, fref) = (w.make_ref(tank), w.make_ref(enemy), w.make_ref(friend));
    // Hold the rifleman's fire so only the crush can kill it.
    w.actors[enemy].reload = [1_000_000; crate::world::MAX_WEAPONS];
    w.actors[tank].reload = [1_000_000; crate::world::MAX_WEAPONS];
    w.queue_order(Order::Move { player: 0, ids: vec![tref], x: x0 + 6 * CELL, y, attack_move: false });
    run(&mut w, 25 * 6);
    assert!(w.resolve(eref).is_none(), "enemy rifleman was crushed");
    w.queue_order(Order::Move { player: 0, ids: vec![tref], x: x0 + 3 * CELL, y: y + 3 * CELL, attack_move: false });
    run(&mut w, 25 * 6);
    assert!(w.resolve(fref).is_some(), "friendly infantry is pushed aside, not crushed");
}

#[test]
fn idle_ore_truck_goes_back_to_work() {
    let mut w = World::new(3, 80, &[("allies", false), ("soviet", true)]);
    let (sx, sy) = w.players[0].start;
    w.spawn_building(ty(&w, "POWR"), 0, sx + 4, sy);
    w.spawn_building(ty(&w, "PROC"), 0, sx, sy + 5);
    run(&mut w, 50);
    let h = (0..w.actors.len()).find(|&i| w.actors[i].alive && w.is_harvester(i)).unwrap();
    let href = w.make_ref(h);
    w.queue_order(Order::Move { player: 0, ids: vec![href], x: cell_center(sx + 8), y: cell_center(sy + 12), attack_move: false });
    run(&mut w, 25 * 10);
    assert_eq!(w.actors[h].activity, Activity::Harvest, "truck resumed harvesting after the move");
}

/// Gems pay twice what ore pays per bale (OpenRA ResourceValues), a truck
/// carries both at once and every bale is paid at its own value, and gems
/// never grow back.
#[test]
fn harvesters_mine_gems_and_ore_and_refineries_pay_by_type() {
    use crate::map::Terrain;
    let mut w = World::new(3, 80, &[("allies", false), ("soviet", false)]);
    w.options.ore_regrowth = false;
    for i in 0..w.map.cells() {
        w.map.ore[i] = 0;
        w.map.gems[i] = 0;
    }
    let (sx, sy) = w.players[0].start;
    w.spawn_building(ty(&w, "POWR"), 0, sx + 4, sy);
    w.spawn_building(ty(&w, "PROC"), 0, sx, sy + 5);
    for k in 0..3 {
        w.spawn_building(ty(&w, "SILO"), 0, sx + 8 + k, sy);
    }
    w.refresh_tokens();
    // A field south of the refinery: gems in the middle row, ore around them.
    for y in sy + 11..sy + 14 {
        for x in sx - 2..sx + 6 {
            let i = w.map.idx(x, y);
            w.map.terrain[i] = Terrain::Clear;
            if y == sy + 12 {
                w.map.gems[i] = 3;
            } else {
                w.map.ore[i] = 4;
            }
        }
    }
    w.pass = crate::flowfield::Passability::new(&w.map);
    let mined = |w: &World| -> i32 {
        let ore: i32 = w.map.ore.iter().map(|&o| o as i32).sum();
        let gems: i32 = w.map.gems.iter().map(|&g| g as i32).sum();
        (8 * 2 * 4 - ore) * 25 + (8 * 3 - gems) * 50
    };
    let h = (0..w.actors.len()).find(|&i| w.actors[i].alive && w.is_harvester(i)).unwrap();
    let start = w.players[0].funds();
    let mut saw_gems = false;
    for _ in 0..25 * 150 {
        w.step();
        let a = &w.actors[h];
        assert!(a.gem_bales >= 0 && a.gem_bales <= a.bales);
        saw_gems |= a.gem_bales > 0;
        let on_board = (a.bales - a.gem_bales) * 25 + a.gem_bales * 50;
        assert_eq!(w.players[0].funds() - start + on_board, mined(&w), "every mined bale is paid at its type's value");
    }
    assert!(saw_gems, "the truck carried gems");
    assert!(w.map.gems.iter().map(|&g| g as i32).sum::<i32>() < 24, "gems were mined");
    assert!(w.players[0].funds() - start >= 1000, "delivered at least a load: {}", w.players[0].funds() - start);
    // Mined-out gem cells stay empty even with regrowth on: only mines grow
    // resources (neutral.rs SeedsResource), and this map's are taken away.
    for i in 0..w.actors.len() {
        if w.actors[i].alive && w.rules.actors[w.actors[i].ty as usize].world.seeds.is_some() {
            w.remove(i);
        }
    }
    w.options.ore_regrowth = true;
    let gems = w.map.gems.clone();
    run(&mut w, 25 * 60);
    assert!(w.map.gems.iter().zip(&gems).all(|(&now, &then)| now <= then), "gems never grow back");
}

// ---- Content and rules ---------------------------------------------------------

fn opts() -> crate::world::GameOptions {
    crate::world::GameOptions::default()
}

fn world_with(seed: u64, factions: [&str; 2], ai: [bool; 2], options: crate::world::GameOptions) -> World {
    use crate::world::{AiDifficulty, PlayerSetup};
    let players: Vec<PlayerSetup> = factions.iter().zip(ai).map(|(f, a)| PlayerSetup::new(f, a.then_some(AiDifficulty::Normal))).collect();
    World::with_options(seed, 80, &players, options)
}

/// Base with power, refinery, war factory and depot, plenty of cash.
fn full_base(w: &mut World, player: u8) {
    let (sx, sy) = w.players[player as usize].start;
    for (id, dx, dy) in [("APWR", 4, 0), ("APWR", 4, 4), ("PROC", -4, 0), ("WEAP", 0, 6), ("FIX", 8, 0), ("DOME", 8, 4)] {
        let t = ty(w, id);
        w.spawn_building(t, player, sx + dx, sy + dy);
    }
    w.players[player as usize].cash = 100_000;
    w.refresh_tokens();
    w.update_power();
}

#[test]
fn every_actor_is_reachable_for_the_right_factions() {
    let w = World::new(1, 64, &[("england", false), ("russia", false)]);
    let r = &w.rules;
    let can = |faction: &str, id: &str| r.obtainable[r.faction_index(faction).unwrap()][r.actor_index(id).unwrap()];
    for (i, a) in r.actors.iter().enumerate() {
        let any = (0..r.factions.len()).any(|f| r.obtainable[f][i]);
        // FACT comes from deploying an MCV; support power actors (paratroopers,
        // spy plane, Badgers), mines, husks and crates are never built;
        // proxies come from infiltrations (infantry.rs).
        let support = ["E1R1", "E3R1", "U2", "BADR", "BADR.Bomber"].contains(&a.id.as_str())
            || matches!(a.kind, Kind::Mine | Kind::Husk | Kind::Crate | Kind::Proxy);
        // The neutral world (trees, civilians, bridges: gen_rules.py WORLD_ACTORS) and
        // map-only actors (France's fake Sub Pen) are never built.
        let map_only = a.prerequisites.iter().any(|p| r.tokens[p.token as usize] == crate::rules::TOKEN_DISABLED) && a.id != "FACT";
        assert!(any || support || map_only || a.id == "FACT", "{} is buildable by some faction", a.id);
    }
    // Helicopters (gen_rules.py OVERRIDES): both sides build the helipad and the
    // Chinook, the Soviets fly the Hind, the Allies the Black Hawk and Longbow.
    for f in ["allies", "england", "france", "germany", "soviet", "russia", "ukraine"] {
        assert!(can(f, "HPAD") && can(f, "TRAN"), "{f} builds helipads and Chinooks");
    }
    assert!(can("soviet", "HIND") && can("russia", "HIND") && can("ukraine", "HIND") && !can("allies", "HIND"));
    assert!(can("allies", "MH60") && can("england", "HELI") && !can("soviet", "MH60") && !can("russia", "HELI"));
    assert!(can("germany", "CTNK") && !can("england", "CTNK") && !can("russia", "CTNK"));
    assert!(can("russia", "TTNK") && !can("ukraine", "TTNK"));
    assert!(can("ukraine", "DTRK") && !can("russia", "DTRK"));
    assert!(can("england", "MGG") && can("france", "STNK") && can("france", "FPWR") && !can("germany", "FPWR"));
    assert!(can("soviet", "4TNK") && can("allies", "2TNK") && !can("allies", "4TNK"));
    for id in ["MCV", "HARV", "TRUK", "MNLY", "SILO", "BRIK", "MSLO", "DOME", "APWR"] {
        assert!(can("allies", id) && can("soviet", id), "{id} is shared");
    }
}

#[test]
fn units_come_out_of_the_right_building() {
    let mut w = World::new(2, 80, &[("russia", false), ("england", true)]);
    let (sx, sy) = w.players[0].start;
    w.spawn_building(ty(&w, "POWR"), 0, sx + 4, sy);
    w.spawn_building(ty(&w, "KENN"), 0, sx - 2, sy);
    w.refresh_tokens();
    let e1 = ty(&w, "E1");
    // A kennel trains dogs, not riflemen: without barracks E1 is unavailable.
    assert!(!w.availability(0, e1).enabled);
    w.spawn_building(ty(&w, "BARR"), 0, sx + 4, sy + 4);
    w.refresh_tokens();
    w.queue_order(Order::StartProduction { player: 0, ty: e1, count: 1 });
    run(&mut w, 120);
    let soldier = w.actors.iter().find(|a| a.alive && a.ty == e1).expect("rifleman trained");
    let barr = w.actors.iter().find(|a| a.alive && a.ty == ty(&w, "BARR")).unwrap();
    assert!(crate::math::dist(soldier.x, soldier.y, barr.x, barr.y) < 6 * CELL, "it left the barracks, not the kennel");
}

#[test]
fn defense_queue_builds_in_parallel_with_buildings() {
    let mut w = World::new(3, 80, &[("allies", false), ("soviet", true)]);
    full_base(&mut w, 0);
    let (powr, gun) = (ty(&w, "POWR"), ty(&w, "GUN"));
    w.spawn_building(ty(&w, "TENT"), 0, w.players[0].start.0 - 4, w.players[0].start.1 + 5);
    w.refresh_tokens();
    w.queue_order(Order::StartProduction { player: 0, ty: powr, count: 1 });
    w.queue_order(Order::StartProduction { player: 0, ty: gun, count: 1 });
    run(&mut w, 600);
    assert!(w.players[0].queues[QueueType::Building as usize].items[0].done);
    assert!(w.players[0].queues[QueueType::Defense as usize].items[0].done);
}

#[test]
fn turret_defense_destroys_an_approaching_tank() {
    let mut w = World::new(4, 64, &[("allies", false), ("soviet", false)]);
    full_base(&mut w, 0);
    let (sx, sy) = w.players[0].start;
    let gun = w.spawn_building(ty(&w, "GUN"), 0, sx + 12, sy + 2).unwrap();
    let tank = w.spawn_unit(ty(&w, "1TNK"), 1, cell_center(sx + 17), cell_center(sy + 2), 768);
    let tref = w.make_ref(tank);
    w.actors[tank].reload = [1_000_000; crate::world::MAX_WEAPONS];
    let gref = w.make_ref(gun);
    run(&mut w, 25 * 30);
    assert!(w.resolve(tref).is_none(), "turret killed the tank");
    assert!(w.resolve(gref).is_some());
}

#[test]
fn tesla_coil_needs_power() {
    let mut w = World::new(5, 64, &[("russia", false), ("england", false)]);
    let (sx, sy) = w.players[0].start;
    let coil = w.spawn_building(ty(&w, "TSLA"), 0, sx + 12, sy + 2).unwrap();
    w.refresh_tokens();
    w.update_power();
    assert!(w.players[0].low_power(), "no power plant: the Tesla Coil (-80) is unpowered");
    assert!(w.is_powered_down(coil));
    let tank = w.spawn_unit(ty(&w, "2TNK"), 1, cell_center(sx + 16), cell_center(sy + 2), 768);
    w.actors[tank].reload = [1_000_000; crate::world::MAX_WEAPONS];
    let hp = w.actors[tank].hp;
    run(&mut w, 25 * 5);
    assert_eq!(w.actors[tank].hp, hp, "an unpowered coil does not fire");
    w.spawn_building(ty(&w, "APWR"), 0, sx + 4, sy + 5);
    w.refresh_tokens();
    run(&mut w, 25 * 8);
    assert!(w.actors[tank].hp < hp || !w.actors[tank].alive, "powered coil zaps the tank");
}

#[test]
fn selling_refunds_half_the_value_scaled_by_health() {
    let mut w = World::new(6, 64, &[("allies", false), ("soviet", true)]);
    let (sx, sy) = w.players[0].start;
    let p = w.spawn_building(ty(&w, "POWR"), 0, sx + 4, sy).unwrap();
    let pref = w.make_ref(p);
    w.actors[p].hp = w.rules.actors[ty(&w, "POWR") as usize].hp / 2;
    let cash = w.players[0].cash;
    w.queue_order(Order::Sell { player: 0, building: pref });
    run(&mut w, 1);
    assert!(w.resolve(pref).is_none());
    assert_eq!(w.players[0].cash - cash, 300 * 50 / 100 / 2, "50% refund at half health");
}

#[test]
fn mcv_deploys_and_the_yard_packs_up_again() {
    let mut o = opts();
    o.starting_units = crate::world::StartingUnits::Mcv;
    let mut w = world_with(7, ["allies", "soviet"], [false, true], o);
    let (mcv_t, fact_t) = (ty(&w, "MCV"), ty(&w, "FACT"));
    let mcv = (0..w.actors.len()).find(|&i| w.actors[i].alive && w.actors[i].owner == 0 && w.actors[i].ty == mcv_t).unwrap();
    assert!(w.can_deploy(mcv));
    let r = w.make_ref(mcv);
    w.queue_order(Order::Deploy { player: 0, ids: vec![r] });
    run(&mut w, 1);
    let fact =
        (0..w.actors.len()).find(|&i| w.actors[i].alive && w.actors[i].owner == 0 && w.actors[i].ty == fact_t).expect("yard deployed");
    assert!(w.has_producer(0, QueueType::Building));
    let r = w.make_ref(fact);
    w.queue_order(Order::Deploy { player: 0, ids: vec![r] });
    run(&mut w, 1);
    assert!(!w.has_producer(0, QueueType::Building), "yard packed up");
    assert_eq!(count(&w, 0, "MCV"), 1);

    // With "Redeployable MCVs" off the yard stays put.
    let mut o = opts();
    o.redeployable_mcv = false;
    let w = world_with(7, ["allies", "soviet"], [false, true], o);
    let fact = (0..w.actors.len()).find(|&i| w.actors[i].alive && w.actors[i].owner == 0 && w.actors[i].ty == fact_t).unwrap();
    assert!(!w.can_deploy(fact));
}

#[test]
fn a_refused_deploy_keeps_the_mcv() {
    let mut o = opts();
    o.starting_units = crate::world::StartingUnits::Mcv;
    let mut w = world_with(7, ["allies", "soviet"], [false, true], o);
    let mcv_t = ty(&w, "MCV");
    let mcv = (0..w.actors.len()).find(|&i| w.actors[i].alive && w.actors[i].owner == 0 && w.actors[i].ty == mcv_t).unwrap();
    let (into, cx, cy) = w.deploy_target(mcv).unwrap();
    // Another structure on the yard's footprint: the deploy is refused and nothing is lost.
    let cell = w.rules.actors[into as usize].building.as_ref().unwrap().cells().last().unwrap();
    assert!(w.spawn_building(ty(&w, "SBAG"), 1, cx + cell.0, cy + cell.1).is_some());
    let before = w.actors.iter().filter(|a| a.alive).count();
    assert!(!w.deploy(mcv));
    assert!(w.actors[mcv].alive && w.actors[mcv].ty == mcv_t);
    assert_eq!(w.actors.iter().filter(|a| a.alive).count(), before);
    // Damage carries over when it does deploy.
    let wall = w.building_at[w.map.idx(cx + cell.0, cy + cell.1)] as usize;
    w.remove(wall);
    w.cleanup_dead();
    w.actors[mcv].hp /= 2;
    assert!(w.deploy(mcv));
    assert!(!w.actors[mcv].alive || w.actors[mcv].ty != mcv_t, "the MCV is gone");
    let fact = w.building_at[w.map.idx(cx + cell.0, cy + cell.1)] as usize;
    assert_eq!(w.actors[fact].ty, into);
    assert!((w.actors[fact].hp - w.rules.actors[into as usize].hp / 2).abs() <= 1);
}

#[test]
fn lobby_options_apply() {
    use crate::world::StartingUnits;
    let mut o = opts();
    o.starting_cash = 10_000;
    o.starting_units = StartingUnits::Light;
    o.tech_level = 1; // low
    o.explored = true;
    let w = world_with(8, ["germany", "ukraine"], [false, true], o);
    assert_eq!(w.players[0].cash, 10_000);
    assert_eq!(count(&w, 0, "MCV"), 1);
    assert_eq!(count(&w, 0, "E1"), 3);
    assert!(w.players[0].explored.iter().all(|&e| e == 1), "explored map");
    // Tech level "low": medium items (Radar Dome) say why they are locked.
    let reqs = w.requirements(0, ty(&w, "DOME"));
    assert!(reqs.iter().any(|r| r.never && r.label.starts_with("Tech level")), "{:?}", reqs.iter().map(|r| &r.label).collect::<Vec<_>>());

    let mut o = opts();
    o.fog = false;
    let mut w = world_with(8, ["germany", "ukraine"], [false, false], o);
    run(&mut w, 4);
    let p = &w.players[0];
    assert!(p.visible.iter().zip(&p.explored).all(|(&v, &e)| e == 0 || v != 0), "no fog over explored ground");
}

#[test]
fn artillery_respects_minimum_range() {
    let mut w = World::new(9, 64, &[("allies", false), ("soviet", false)]);
    let (sx, sy) = w.players[0].start;
    let arty = w.spawn_unit(ty(&w, "ARTY"), 0, cell_center(sx + 8), cell_center(sy + 9), 256);
    let tank = w.spawn_unit(ty(&w, "3TNK"), 1, cell_center(sx + 10), cell_center(sy + 9), 768);
    w.actors[tank].reload = [1_000_000; crate::world::MAX_WEAPONS];
    let tref = w.make_ref(tank);
    let aref = w.make_ref(arty);
    w.queue_order(Order::Attack { player: 0, ids: vec![aref], target: tref });
    run(&mut w, 3);
    assert!(w.projectiles.is_empty(), "no shot inside the 4 cell minimum range");
    run(&mut w, 25 * 6);
    let d = crate::math::dist(w.actors[arty].x, w.actors[arty].y, w.actors[tank].x, w.actors[tank].y);
    assert!(d >= 4 * CELL - 256, "artillery backed off to {d}");
}

#[test]
fn mammoth_missiles_only_target_infantry() {
    let r = crate::rules::Rules::load();
    let m = &r.actors[r.actor_index("4TNK").unwrap()];
    let names: Vec<&str> = m.weapons.iter().map(|&w| r.weapons[w].name.as_str()).collect();
    assert_eq!(names, vec!["120mm", "MammothTusk"]);
    assert!(r.weapons[m.weapons[0]].can_target(Kind::Vehicle));
    assert!(!r.weapons[m.weapons[1]].can_target(Kind::Vehicle) && r.weapons[m.weapons[1]].can_target(Kind::Infantry));
    // Flak truck: the ground cannon hits vehicles, the AA gun only aircraft.
    let f = &r.actors[r.actor_index("FTRK").unwrap()];
    assert!(f.can_attack(&r, Kind::Vehicle));
    assert!(!r.weapons[f.weapons[0]].can_target(Kind::Vehicle));
}

#[test]
fn walls_fill_the_gap_between_posts() {
    let mut w = World::new(10, 64, &[("allies", false), ("soviet", true)]);
    full_base(&mut w, 0);
    let (sx, sy) = w.players[0].start;
    let sbag = ty(&w, "SBAG");
    let y = sy - 2;
    let place = |w: &mut World, x: i32| {
        w.queue_order(Order::StartProduction { player: 0, ty: sbag, count: 1 });
        run(w, 40);
        w.queue_order(Order::Place { player: 0, ty: sbag, cx: x, cy: y });
        run(w, 1);
    };
    place(&mut w, sx);
    place(&mut w, sx + 5);
    let walls = (sx..=sx + 5).filter(|&x| {
        let b = w.building_at[w.map.idx(x, y)];
        b != crate::world::NONE && w.actors[b as usize].ty == sbag
    });
    assert_eq!(walls.count(), 6, "the four cells between the posts were filled");
}

#[test]
fn walls_filled_into_a_gap_crush_mines_like_placed_ones() {
    let mut w = World::new(10, 64, &[("allies", false), ("soviet", true)]);
    full_base(&mut w, 0);
    let (sx, sy) = w.players[0].start;
    let sbag = ty(&w, "SBAG");
    let y = sy - 2;
    // A hidden enemy mine in the gap does not stop the wall (placement must not reveal it).
    let ml = w.spawn_unit(ty(&w, "MNLY"), 1, cell_center(sx + 2), cell_center(y), 0);
    let ci = w.map.idx(sx + 2, y);
    assert!(w.lay_mine(ml, ci));
    let mine = w.mine_at(ci).unwrap();
    w.remove(ml);
    let place = |w: &mut World, x: i32| {
        w.queue_order(Order::StartProduction { player: 0, ty: sbag, count: 1 });
        run(w, 40);
        w.queue_order(Order::Place { player: 0, ty: sbag, cx: x, cy: y });
        run(w, 1);
    };
    place(&mut w, sx);
    place(&mut w, sx + 5);
    let b = w.building_at[ci];
    assert!(b != crate::world::NONE && w.actors[b as usize].ty == sbag, "the gap was filled");
    assert!(!w.actors[mine].alive && w.mine_at(ci).is_none(), "the mine under the filled piece is gone");
}

#[test]
fn structures_never_share_a_cell() {
    let mut w = World::new(10, 64, &[("allies", false), ("soviet", true)]);
    let (sx, sy) = w.players[0].start;
    let fact = w.building_at[w.map.idx(sx, sy)];
    assert!(fact != crate::world::NONE);
    // The start's yard covers (sx, sy): nothing may be put over it, not even partly.
    assert!(w.spawn_building(ty(&w, "POWR"), 1, sx - 1, sy - 1).is_none());
    assert_eq!(w.building_at[w.map.idx(sx, sy)], fact);
    assert!(w.spawn_building(ty(&w, "POWR"), 1, sx + 5, sy).is_some());
}

#[test]
fn wide_modded_walls_fill_a_line_without_overlapping() {
    // Re-audit: only the gap cell was checked, so a 2-cell wall piece filled
    // into a gap also covered the next cell and overwrote its owner there.
    let m = crate::map::Map::generate_for(64, 64, 10, 12, 2);
    let mut d = crate::mapdata::MapData::from_map(&m, "Walls", "x", "");
    d.rules = Some(serde_json::json!({ "actors": { "SBAG": { "building": { "width": 2, "footprint": ["xx"] } } } }));
    let players = [crate::world::PlayerSetup::new("england", None), crate::world::PlayerSetup::new("russia", None)];
    let mut w = World::from_map(&d, 10, &players, Default::default()).unwrap();
    w.players[0].explored.iter_mut().for_each(|e| *e = 1);
    full_base(&mut w, 0);
    let (sx, sy) = w.players[0].start;
    let sbag = ty(&w, "SBAG");
    let y = sy - 2;
    let place = |w: &mut World, x: i32| {
        w.queue_order(Order::StartProduction { player: 0, ty: sbag, count: 1 });
        run(w, 40);
        w.queue_order(Order::Place { player: 0, ty: sbag, cx: x, cy: y });
        run(w, 1);
    };
    place(&mut w, sx);
    place(&mut w, sx + 5);
    let walls: Vec<usize> = (0..w.actors.len()).filter(|&i| w.actors[i].alive && w.actors[i].ty == sbag).collect();
    assert!(walls.len() >= 3, "both posts and at least one piece between them: {}", walls.len());
    // Every structure still owns every cell of its footprint.
    for i in 0..w.actors.len() {
        let a = &w.actors[i];
        if !a.alive || a.kind != Kind::Building {
            continue;
        }
        for (dx, dy) in w.rules.actors[a.ty as usize].building.as_ref().unwrap().cells() {
            assert_eq!(w.building_at[w.map.idx(a.cx + dx, a.cy + dy)], i as u32, "cell {},{} of actor {i}", a.cx + dx, a.cy + dy);
        }
    }
}

#[test]
fn naval_yards_go_on_water_only() {
    let mut w = World::new(11, 96, &[("allies", false), ("soviet", true)]);
    full_base(&mut w, 0);
    let syrd = ty(&w, "SYRD");
    w.options.build_radius = false;
    w.players[0].explored.iter_mut().for_each(|e| *e = 1);
    let (sx, sy) = w.players[0].start;
    assert!(!w.can_place(0, syrd, sx + 1, sy - 3), "not on land");
    // Put a pond next to the base and try again.
    for y in sy - 4..sy {
        for x in sx..sx + 4 {
            let i = w.map.idx(x, y);
            w.map.terrain[i] = crate::map::Terrain::Water;
            w.map.ore[i] = 0;
            w.map.gems[i] = 0;
        }
    }
    assert!(w.can_place(0, syrd, sx, sy - 3), "on water within 2 cells of the base");
}

#[test]
fn demolition_truck_blast_hurts_everything_around() {
    let mut w = World::new(12, 64, &[("ukraine", false), ("allies", false)]);
    let (sx, sy) = w.players[0].start;
    let dtrk = w.spawn_unit(ty(&w, "DTRK"), 0, cell_center(sx + 10), cell_center(sy + 10), 0);
    let victims: Vec<u32> = (0..3)
        .map(|k| {
            let u = w.spawn_unit(ty(&w, "2TNK"), 1, cell_center(sx + 11 + k), cell_center(sy + 11), 0);
            w.actors[u].reload = [1_000_000; crate::world::MAX_WEAPONS];
            w.make_ref(u)
        })
        .collect();
    w.kill(dtrk);
    run(&mut w, 10);
    let dead = victims.iter().filter(|&&r| w.resolve(r).is_none()).count();
    assert!(dead >= 2, "mini nuke destroyed nearby tanks: {dead}");
}

#[test]
fn mammoth_tank_repairs_itself_below_half_health() {
    let mut w = World::new(13, 64, &[("soviet", false), ("allies", false)]);
    let (sx, sy) = w.players[0].start;
    let m = w.spawn_unit(ty(&w, "4TNK"), 0, cell_center(sx + 8), cell_center(sy + 9), 0);
    let max = w.rules.actors[ty(&w, "4TNK") as usize].hp;
    w.actors[m].hp = max / 4;
    run(&mut w, 25 * 20);
    assert!(w.actors[m].hp > max / 4, "self repair started");
    assert!(w.actors[m].hp <= max / 2 + 100, "and stops at half health");
}

#[test]
fn silos_add_storage() {
    let mut w = World::new(14, 64, &[("allies", false), ("soviet", true)]);
    let (sx, sy) = w.players[0].start;
    w.spawn_building(ty(&w, "PROC"), 0, sx - 4, sy);
    w.spawn_building(ty(&w, "SILO"), 0, sx + 4, sy);
    w.refresh_tokens();
    assert_eq!(w.players[0].storage, 2000 + 3000);
}

#[test]
fn delayed_warheads_land_over_several_ticks() {
    let mut w = World::new(15, 64, &[("allies", false), ("soviet", false)]);
    let vulcan = w.rules.weapons.iter().position(|x| x.name == "Vulcan").unwrap();
    assert!(w.rules.weapons[vulcan].warheads.iter().any(|h| h.delay > 0));
    let (sx, sy) = w.players[0].start;
    let e = w.spawn_unit(ty(&w, "E1"), 1, cell_center(sx + 8), cell_center(sy + 9), 0);
    let hp0 = w.actors[e].hp;
    w.rebuild_hash();
    w.impact(vulcan, w.actors[e].x, w.actors[e].y, 0);
    let after_first = w.actors[e].hp;
    run(&mut w, 12);
    assert!(after_first < hp0 && (!w.actors[e].alive || w.actors[e].hp < after_first), "later warheads hit too");
}

#[test]
fn ai_starting_from_an_mcv_builds_a_base_at_every_difficulty() {
    use crate::world::{AiDifficulty, PlayerSetup, StartingUnits};
    for diff in [AiDifficulty::Easy, AiDifficulty::Normal, AiDifficulty::Hard] {
        let mut o = opts();
        o.starting_units = StartingUnits::Mcv;
        let players = vec![PlayerSetup::new("england", Some(diff)), PlayerSetup::new("ukraine", Some(diff))];
        let mut w = World::with_options(21, 80, &players, o);
        run(&mut w, 25 * 60 * 4);
        for p in 0..2u8 {
            let b = w.actors.iter().filter(|a| a.alive && a.owner == p && a.kind == Kind::Building).count();
            assert!(b >= 5, "{diff:?} AI {p} built {b} buildings");
        }
    }
}

// ---- Maps, teams and lockstep foundation ----------------------------------------

fn setups(list: &[(&str, bool, u8)]) -> Vec<crate::world::PlayerSetup> {
    use crate::world::{AiDifficulty, PlayerSetup};
    list.iter()
        .map(|&(f, ai, team)| PlayerSetup {
            faction: f.into(),
            ai: ai.then_some(AiDifficulty::Normal),
            bot: Default::default(),
            team,
            handicap: 0,
        })
        .collect()
}

#[test]
fn map_file_with_actors_and_modded_rules_builds_a_world() {
    use crate::mapdata::{MapActor, MapData};
    let m = crate::map::Map::generate_for(64, 64, 4, 12, 2);
    let mut d = MapData::from_map(&m, "Custom", "Me", "");
    let (x, y) = (d.spawns[0][0] + 6, d.spawns[0][1]);
    d.actors.push(MapActor::new("SBAG", -1, x, y, 0));
    d.actors.push(MapActor::new("1TNK", 1, d.spawns[1][0] + 4, d.spawns[1][1] + 6, 512));
    d.rules = Some(serde_json::json!({ "actors": { "1TNK": { "cost": 1 } } }));
    let v = d.validate();
    assert!(v.ok && v.modded, "{:?}", v.errors);
    let w = World::from_map(&d, 1, &setups(&[("germany", false, 0), ("russia", true, 0)]), opts()).unwrap();
    assert_eq!(w.rules.actors[ty(&w, "1TNK") as usize].cost, 1, "modded rules apply");
    assert_eq!(w.players.len(), 3, "an extra neutral owner for the sandbag");
    assert!(w.players[2].neutral);
    assert_eq!(count(&w, 2, "SBAG"), 1);
    assert_eq!(count(&w, 1, "1TNK"), 1);
    assert!(!w.are_enemies(0, 2) && w.are_enemies(0, 1));
}

#[test]
fn teammates_do_not_fight_share_vision_and_win_together() {
    let players = setups(&[("england", false, 1), ("germany", false, 1), ("russia", false, 2), ("ukraine", false, 2)]);
    let mut o = opts();
    o.starting_units = crate::world::StartingUnits::Light;
    let mut w = World::with_options(3, 96, &players, o);
    assert!(w.are_allies(0, 1) && w.are_enemies(0, 2) && !w.are_enemies(2, 3));
    // Put an ally's tank next to player 0's riflemen: nobody shoots.
    let (sx, sy) = w.players[0].start;
    let t = w.spawn_unit(ty(&w, "1TNK"), 1, cell_center(sx + 2), cell_center(sy + 5), 0);
    let hp = w.actors[t].hp;
    run(&mut w, 50);
    assert_eq!(w.actors[t].hp, hp);
    // Shared vision: player 0 sees what player 1 sees around its base.
    let (bx, by) = w.players[1].start;
    let ci = w.map.idx(bx + 1, by + 1);
    assert!(w.players[0].visible[ci] != 0);
    // Team 2 loses everything: team 1 wins, both members.
    for i in 0..w.actors.len() {
        if w.actors[i].alive && w.actors[i].owner >= 2 {
            w.kill(i);
        }
    }
    run(&mut w, 30);
    assert!(w.has_won(0) && w.has_won(1) && !w.has_won(2));
}

#[test]
fn eight_player_map_and_skirmish_setup() {
    let list: Vec<(&str, bool, u8)> =
        ["england", "france", "germany", "allies", "russia", "ukraine", "soviet", "russia"].iter().map(|&f| (f, true, 0)).collect();
    let w = World::with_options(8, 128, &setups(&list), opts());
    // Eight players, and the neutral one the map's trees belong to.
    assert_eq!(w.players.iter().filter(|p| !p.neutral).count(), 8);
    for p in 0..8u8 {
        assert_eq!(count(&w, p, "FACT"), 1, "player {p} has a base");
    }
}

#[test]
fn orders_round_trip_through_json_and_get_restamped() {
    let o = Order::Move { player: 0, ids: vec![1, 2, 3], x: 100, y: 200, attack_move: true };
    let json = serde_json::to_string(&o).unwrap();
    assert!(json.starts_with(r#"{"o":"move""#), "{json}");
    let mut back: Order = serde_json::from_str(&json).unwrap();
    back.set_player(3);
    assert_eq!(back.player(), 3);
    assert!(serde_json::from_str::<Order>(r#"{"o":"move","player":0,"ids":[],"x":0,"y":0,"attack_move":false,"evil":1}"#).is_err());
    assert!(!Order::StartProduction { player: 0, ty: 1, count: 100_000 }.is_reasonable());
}

#[test]
fn four_player_free_for_all_ai_game_finishes() {
    let list = [("england", true, 0), ("russia", true, 0), ("germany", true, 0), ("ukraine", true, 0)];
    let mut w = World::with_options(12, 96, &setups(&list), opts());
    // OpenRA movement (the default) makes land games a few minutes longer
    // than the WebRA model (docs/contracts.md, AI measurements). The first
    // player falls after 44 minutes here since anti-air works and aircraft
    // end their attack to rearm (31 before; seeds 10 to 17 still average 34
    // minutes to the winner, as before; their first falls come at 11 to 26).
    for _ in 0..(25 * 60 * 50) {
        w.step();
        if w.winner.is_some() {
            break;
        }
    }
    let killed: u32 = w.losses.iter().sum();
    assert!(killed > 20, "fighting happened: {killed}");
    let defeated = w.players.iter().filter(|p| p.defeated).count();
    assert!(defeated >= 1, "at least one player was eliminated in 50 minutes");
}

// ---- Fairness ------------------------------------------------------------------

/// A unit and its left-right mirror image, each alone on the same generated
/// map, must drive mirrored paths tick for tick (flow field ties, cell borders
/// and blocked goals are resolved without a directional bias).
#[test]
fn mirrored_units_drive_mirrored_paths() {
    let routes = [((12, 14), (60, 50)), ((20, 30), (40, 12)), ((5, 40), (40, 5)), ((30, 30), (31, 45)), ((18, 9), (12, 11))];
    for seed in 0..4u64 {
        for &(from, to) in &routes {
            let mut paths = Vec::new();
            for mirror in [false, true] {
                let mut w = World::new(seed, 80, &[("allies", false), ("allies", false)]);
                for i in 0..w.actors.len() {
                    w.remove(i);
                }
                w.step();
                let width = w.map.width;
                let m = |c: (i32, i32)| if mirror { (width - 1 - c.0, c.1) } else { c };
                let (f, t) = (m(from), m(to));
                // Face the destination: an exact half turn has no mirror-neutral direction.
                let facing = crate::math::facing_of(t.0 - f.0, t.1 - f.1).unwrap();
                let u = w.spawn_unit(ty(&w, "1TNK"), 0, cell_center(f.0), cell_center(f.1), facing);
                w.order_move(&[u], cell_center(t.0), cell_center(t.1), false);
                let mut path = Vec::new();
                for _ in 0..1500 {
                    w.step();
                    let a = &w.actors[u];
                    path.push((if mirror { width * CELL - a.x } else { a.x }, a.y));
                    if a.activity == Activity::Idle {
                        break;
                    }
                }
                paths.push(path);
            }
            let diverge = paths[0].iter().zip(&paths[1]).position(|(p, q)| p != q);
            assert_eq!(diverge, None, "seed {seed} {from:?} -> {to:?}: mirrored paths diverge");
            assert_eq!(paths[0].len(), paths[1].len(), "seed {seed} {from:?} -> {to:?}: arrival time");
        }
    }
}

/// Identical AIs on mirrored spawns: neither player slot may win most games.
/// 20 games keep a fair coin under 1.5 % of failing (10 games: 11 %, and
/// every combat change reshuffles the outcomes).
#[test]
fn mirror_matches_are_fair() {
    let mut wins = [0u32; 2];
    for seed in 0..20u64 {
        let mut w = World::new(seed, 80, &[("allies", true), ("allies", true)]);
        for _ in 0..(25 * 60 * 25) {
            w.step();
            if w.winner.is_some() {
                break;
            }
        }
        if let Some(p) = w.winner {
            wins[p as usize] += 1;
        }
    }
    assert!(wins[0] <= 15 && wins[1] <= 15, "wins per slot over 20 mirror matches: {wins:?}");
}

// ---- AI in free for all and team games ----------------------------------------

fn spawn_tanks(w: &mut World, owner: u8, cell: (i32, i32), n: i32) -> Vec<usize> {
    let tnk = ty(w, "1TNK");
    (0..n).map(|k| w.spawn_unit(tnk, owner, cell_center(cell.0 + k % 3), cell_center(cell.1 + k / 3), 512)).collect()
}

#[test]
fn ai_attacks_the_nearest_enemy_base_and_the_least_attacked_of_equally_near_ones() {
    // Four players in two rows (spawns by column, top first): 1 (below) and
    // 2 (beside) are 0's neighbours, 3 sits across and is an AI as well.
    let list = [("england", true, 0), ("russia", false, 0), ("germany", false, 0), ("ukraine", true, 0)];
    let mut w = World::with_options(7, 96, &setups(&list), opts());
    let first = crate::ai::choose_target_player(&w, 0).unwrap();
    assert!(first == 1 || first == 2, "a neighbour, not the far base: {first}");
    let other = 3 - first;
    // Strength no longer decides: a much stronger neighbour is no reason to
    // gang up on the weaker one.
    let (sx, sy) = w.players[other as usize].start;
    spawn_tanks(&mut w, other, (sx, sy + 5), 6);
    assert_eq!(crate::ai::choose_target_player(&w, 0), Some(first));
    // Another AI already attacks `first`: the other neighbour is the choice.
    w.ai[3].target_player = Some(first);
    assert_eq!(crate::ai::choose_target_player(&w, 0), Some(other));
    // An expansion does not bring a far base nearer: distances count to the yard.
    let (ax, ay) = w.players[0].start;
    let pbox = ty(&w, "PBOX");
    w.spawn_building(pbox, 3, ax + 6, ay + 6);
    assert_eq!(crate::ai::choose_target_player(&w, 0), Some(other));
    // A grudge beats both: `first` hit one of 0's structures.
    let yard = (0..w.actors.len()).find(|&i| w.actors[i].alive && w.actors[i].owner == 0 && w.actors[i].kind == Kind::Building).unwrap();
    w.with_damage_source(first, |w| w.damage(yard, 10));
    assert_eq!(crate::ai::choose_target_player(&w, 0), Some(first));
    // Far bases only count once the near ones are gone.
    for i in 0..w.actors.len() {
        if w.actors[i].alive && (w.actors[i].owner == 1 || w.actors[i].owner == 2) {
            w.kill(i);
        }
    }
    run(&mut w, 25);
    assert_eq!(crate::ai::choose_target_player(&w, 0), Some(3));
}

#[test]
fn ai_keeps_its_target_until_another_is_clearly_better() {
    let list = [("england", true, 0), ("russia", false, 0), ("germany", false, 0), ("ukraine", true, 0)];
    let mut w = World::with_options(7, 96, &setups(&list), opts());
    let first = crate::ai::update_target_player(&mut w, 0).unwrap();
    let other = 3 - first;
    // Retargets keep an equally good target, whatever the tie break says now.
    w.ai[0].target_player = Some(other);
    for _ in 0..3 {
        w.tick += 60 * crate::world::TICKS_PER_SECOND;
        assert_eq!(crate::ai::update_target_player(&mut w, 0), Some(other));
    }
    // Once another AI attacks it too, the free neighbour is clearly better.
    w.ai[3].target_player = Some(other);
    w.tick += 60 * crate::world::TICKS_PER_SECOND;
    assert_eq!(crate::ai::update_target_player(&mut w, 0), Some(first));
}

#[test]
fn ai_teammates_follow_their_leaders_attack_target() {
    // Teams by row: 0 and 2 (top) against 1 and 3 (bottom).
    let list = [("england", true, 1), ("russia", false, 2), ("germany", true, 1), ("ukraine", false, 2)];
    let mut w = World::with_options(4, 96, &setups(&list), opts());
    // On its own, player 2 would go for the enemy below it, even when the far one is weaker.
    let (sx, sy) = w.players[1].start;
    spawn_tanks(&mut w, 1, (sx, sy + 5), 6);
    assert_eq!(crate::ai::choose_target_player(&w, 2), Some(3));
    // The leader (lowest slot AI of the team) attacks player 1: so does player 2.
    w.ai[0].target_player = Some(1);
    assert_eq!(crate::ai::update_target_player(&mut w, 2), Some(1));
    // Once that enemy is out, the teammate chooses again.
    for i in 0..w.actors.len() {
        if w.actors[i].alive && w.actors[i].owner == 1 {
            w.kill(i);
        }
    }
    run(&mut w, 25);
    assert_eq!(crate::ai::update_target_player(&mut w, 2), Some(3));
}

#[test]
fn ai_team_game_never_targets_an_ally() {
    let list = [("england", true, 1), ("russia", true, 2), ("germany", true, 1), ("ukraine", true, 2)];
    let mut w = World::with_options(4, 96, &setups(&list), opts());
    for t in 1..=(25 * 60 * 8) {
        w.step();
        if t % 25 != 0 {
            continue;
        }
        for (p, ai) in w.ai.iter().enumerate() {
            if let Some(target) = ai.target_player {
                assert!(w.are_enemies(p as u8, target), "tick {t}: player {p} targets ally {target}");
            }
        }
        for a in w.actors.iter().filter(|a| a.alive && a.activity == Activity::Attack) {
            if let Some(v) = w.resolve(a.target) {
                assert!(w.are_enemies(a.owner, w.actors[v].owner), "tick {t}: a unit of {} attacks an ally", a.owner);
            }
        }
        if w.winner.is_some() {
            break;
        }
    }
    let killed: u32 = w.losses.iter().sum();
    assert!(killed > 20, "the teams fought: {killed} losses");
}

#[test]
fn ai_sends_idle_units_to_an_ally_whose_base_is_attacked() {
    // AI 0 and human 1 against human 2.
    let list = [("england", true, 1), ("germany", false, 1), ("russia", false, 2)];
    let mut w = World::with_options(2, 96, &setups(&list), opts());
    let (ax, ay) = w.players[0].start;
    let helpers = spawn_tanks(&mut w, 0, (ax + 1, ay + 6), 6);
    let (bx, by) = w.players[1].start;
    let raiders = spawn_tanks(&mut w, 2, (bx + 1, by + 6), 2);
    let ally_base = (cell_center(bx + 1), cell_center(by + 2));
    // The AI sorts its new units first, then a raider shoots the ally's yard.
    run(&mut w, 60);
    let yard = (0..w.actors.len()).find(|&i| w.actors[i].alive && w.actors[i].owner == 1 && w.actors[i].kind == Kind::Building).unwrap();
    let src = w.make_ref(raiders[0]);
    w.with_damage_source(2, |w| w.damage_from(yard, 10, src, 0));
    // A protection squad forms next tick and leaves at its next squad
    // update (SquadManagerBotModule.AttackForceInterval: 75 ticks).
    run(&mut w, 200);
    // Every tank is on an attack-move to the ally's base or already fighting the raiders.
    let helping = helpers
        .iter()
        .filter(|&&i| {
            let a = &w.actors[i];
            let to_ally = a.activity == Activity::Move
                && a.attack_move
                && crate::math::dist(a.dest.0, a.dest.1, ally_base.0, ally_base.1) < 16 * CELL;
            let fighting = a.activity == Activity::Attack && w.resolve(a.target).is_some_and(|t| raiders.contains(&t));
            to_ally || fighting
        })
        .count();
    assert_eq!(helping, 6, "tanks sent to help the ally");
}

#[test]
fn ai_ignores_enemies_it_cannot_see_or_target_near_its_base() {
    // AI 0 with a few idle tanks (fewer than a wave) and two hidden enemies at its base.
    let list = [("england", true, 0), ("france", false, 0)];
    let mut w = World::with_options(2, 96, &setups(&list), opts());
    let (ax, ay) = w.players[0].start;
    let tanks = spawn_tanks(&mut w, 0, (ax + 1, ay + 6), 3);
    let mine = w.spawn_unit(ty(&w, "MINV"), 1, cell_center(ax + 4), cell_center(ay + 8), 0);
    w.actors[mine].ab.cloaked = true;
    let stnk = w.spawn_unit(ty(&w, "STNK"), 1, cell_center(ax + 6), cell_center(ay + 6), 0);
    w.actors[stnk].reload = [1_000_000; crate::world::MAX_WEAPONS];
    w.actors[stnk].ab.cloaked = true;
    let hidden = |w: &World| [mine, stnk].iter().map(|&h| (w.actors[h].x, w.actors[h].y)).collect::<Vec<_>>();
    let rallied_to_hidden = |w: &World| {
        tanks.iter().any(|&i| {
            let a = &w.actors[i];
            a.attack_move && hidden(w).iter().any(|&(hx, hy)| crate::math::dist(a.dest.0, a.dest.1, hx, hy) < CELL)
        })
    };
    for _ in 0..25 * 4 {
        w.step();
        w.actors[stnk].ab.cloaked = true;
        assert!(!rallied_to_hidden(&w), "the AI rallied to an enemy it cannot target");
    }
    assert!(!w.targetable(stnk, 0));
    // Once the Phase Transport is visible, it is a threat.
    w.actors[stnk].ab.cloaked = false;
    run(&mut w, 30);
    let (sx, sy) = (w.actors[stnk].x, w.actors[stnk].y);
    assert!(
        !w.actors[stnk].alive
            || tanks.iter().any(|&i| w.actors[i].attack_move && crate::math::dist(w.actors[i].dest.0, w.actors[i].dest.1, sx, sy) < CELL)
            || tanks.iter().any(|&i| w.actors[i].activity == Activity::Attack),
        "a visible intruder pulls the tanks in (or is already destroyed)"
    );
}

#[test]
fn ai_fires_ready_support_powers_at_its_target() {
    let list = [("russia", true, 0), ("england", false, 0)];
    let mut w = World::with_options(2, 96, &setups(&list), opts());
    let (sx, sy) = w.players[0].start;
    for (id, x, y) in [("MSLO", sx + 5, sy), ("APWR", sx, sy + 5), ("APWR", sx + 4, sy + 5)] {
        w.spawn_building(ty(&w, id), 0, x, y);
    }
    // Something worth a nuke (SupportPowerBotModule: MinimumAttractiveness
    // 3000 of structure value within five cells).
    let (ex, ey) = w.players[1].start;
    for (id, dx, dy) in [("POWR", 4, 0), ("PROC", 0, 4), ("WEAP", 4, 4)] {
        w.spawn_building(ty(&w, id), 1, ex + dx, ey + dy);
    }
    run(&mut w, 2);
    let nuke = |w: &World| w.power_instances(0).iter().find(|p| p.key == "NukePower").cloned();
    let inst = nuke(&w).expect("the missile silo provides the nuke");
    assert!(!inst.ready(), "charging");
    w.powers.players[0].iter_mut().find(|p| p.key == "NukePower").unwrap().remaining = 0;
    run(&mut w, 30);
    let after = nuke(&w).unwrap();
    assert!(!after.ready() && after.remaining > after.total - 40, "the AI launched the nuke: {after:?}");
}

#[test]
fn ai_leaves_neutral_actors_alone() {
    use crate::mapdata::{MapActor, MapData};
    let m = crate::map::Map::generate_for(64, 64, 6, 12, 2);
    let mut d = MapData::from_map(&m, "Neutral", "Me", "");
    let (x, y) = (d.spawns[0][0] + 5, d.spawns[0][1] + 6);
    d.actors.push(MapActor::new("1TNK", -1, x, y, 0));
    let mut w = World::from_map(&d, 1, &setups(&[("england", true, 0), ("russia", true, 0)]), opts()).unwrap();
    let neutral = w.players.len() as u8 - 1;
    let tank = (0..w.actors.len()).find(|&i| w.actors[i].alive && w.actors[i].owner == neutral).unwrap();
    let hp = w.actors[tank].hp;
    run(&mut w, 25 * 60 * 4);
    assert!(w.actors[tank].alive && w.actors[tank].hp == hp, "nobody shoots the neutral tank");
    for p in 0..2u8 {
        assert_eq!(crate::ai::choose_target_player(&w, p), Some(1 - p));
    }
}

// ---- Domains: water and air ---------------------------------------------------------

/// A 64x64 map with a lake in the middle and a rock wall, for domain tests.
fn lake_world() -> World {
    use crate::map::Terrain;
    let mut w = World::new(31, 64, &[("allies", false), ("soviet", false)]);
    for y in 20..44 {
        for x in 20..44 {
            let i = w.map.idx(x, y);
            w.map.terrain[i] = Terrain::Water;
            w.map.ore[i] = 0;
            w.map.gems[i] = 0;
        }
    }
    for y in 0..64 {
        let i = w.map.idx(10, y);
        w.map.terrain[i] = Terrain::Rock;
    }
    w.pass = crate::flowfield::Passability::new(&w.map);
    w.pass_water = crate::flowfield::Passability::water(&w.map);
    w.pass_landing = crate::flowfield::Passability::landing(&w.map);
    w.players[0].explored.iter_mut().for_each(|e| *e = 1);
    w
}

#[test]
fn ships_sail_on_water_and_stay_off_land() {
    let mut w = lake_world();
    let dd = w.spawn_unit(ty(&w, "DD"), 0, cell_center(22), cell_center(22), 256);
    let r = w.make_ref(dd);
    // Ordered onto land: the destroyer stops at the nearest water instead.
    w.queue_order(Order::Move { player: 0, ids: vec![r], x: cell_center(50), y: cell_center(40), attack_move: false });
    run(&mut w, 25 * 20);
    let (cx, cy) = w.cell_of(w.actors[dd].x, w.actors[dd].y);
    assert_eq!(w.map.terrain[w.map.idx(cx, cy)], crate::map::Terrain::Water, "still on water at {cx},{cy}");
    assert!(cx >= 40, "sailed to the east shore, at {cx}");
}

#[test]
fn naval_yard_produces_ships() {
    let mut w = lake_world();
    full_base(&mut w, 0);
    w.spawn_building(ty(&w, "SYRD"), 0, 30, 30);
    w.refresh_tokens();
    let pt = ty(&w, "PT");
    assert!(w.availability(0, pt).enabled);
    w.queue_order(Order::StartProduction { player: 0, ty: pt, count: 1 });
    run(&mut w, 400);
    let boat = w.actors.iter().position(|a| a.alive && a.ty == pt).expect("gunboat built");
    run(&mut w, 50);
    let (cx, cy) = w.cell_of(w.actors[boat].x, w.actors[boat].y);
    assert_eq!(w.map.terrain[w.map.idx(cx, cy)], crate::map::Terrain::Water);
}

#[test]
fn aircraft_fly_over_rock_and_only_anti_air_hits_them() {
    let mut w = lake_world();
    let heli = w.spawn_unit(ty(&w, "MH60"), 0, cell_center(5), cell_center(5), 256);
    assert!(w.actors[heli].altitude > 0, "flying");
    let r = w.make_ref(heli);
    w.queue_order(Order::Move { player: 0, ids: vec![r], x: cell_center(15), y: cell_center(5), attack_move: false });
    run(&mut w, 25 * 8);
    let (cx, _) = w.cell_of(w.actors[heli].x, w.actors[heli].y);
    assert!(cx >= 13, "crossed the rock wall at x=10, now at {cx}");
    // A tank cannot target it; a flak truck can.
    let tank = &w.rules.actors[ty(&w, "3TNK") as usize];
    assert!(!tank.can_attack(&w.rules, Kind::Aircraft));
    let flak = &w.rules.actors[ty(&w, "FTRK") as usize];
    assert!(flak.can_attack(&w.rules, Kind::Aircraft));
    let sam = w.spawn_unit(ty(&w, "FTRK"), 1, cell_center(16), cell_center(8), 0);
    let hp = w.actors[heli].hp;
    let _ = sam;
    run(&mut w, 25 * 6);
    assert!(!w.actors[heli].alive || w.actors[heli].hp < hp, "flak hit the helicopter");
}

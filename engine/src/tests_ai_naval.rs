//! Tests for the bots' fleets: naval squads that find, see and attack what
//! they can reach over water, defend the harbour, fall back to their yard,
//! and production that builds warships and naval yards only for water that
//! leads to an enemy (ai_squads.rs, ai_naval.rs, ai_units.rs, ai_base.rs).

use crate::ai_bots::BotType;
use crate::ai_squads::{naval_report, squad_units, SquadType};
use crate::math::CELL;
use crate::rules::Kind;
use crate::tests_ai::{arena, flood, put, quiet_unit, run, ty, Seat};
use crate::world::{cell_center, AiDifficulty, World};

fn naval() -> Option<(BotType, AiDifficulty)> {
    Some((BotType::Naval, AiDifficulty::Normal))
}

/// A Naval AI (England) with its yard at (52, 4) and a passive human
/// (Russia) with its yard at (52, 50); the AI never sends ground squads.
fn naval_arena() -> World {
    let seats: [Seat; 2] = [("england", naval(), 0, (52, 4)), ("russia", None, 0, (52, 50))];
    let mut w = arena(64, &seats);
    w.ai[0].passive = true;
    w
}

/// Power and a refinery for the AI (it builds no units without one), east
/// of its yard.
fn harbour_base(w: &mut World) {
    put(w, "POWR", 0, 44, 4);
    put(w, "POWR", 0, 44, 8);
    put(w, "PROC", 0, 56, 8);
    w.refresh_tokens();
    w.update_power();
}

/// Water connectivity label of a cell.
fn water(w: &World, x: i32, y: i32) -> u32 {
    w.pass_water.component[w.map.idx(x, y)]
}

/// Water label under actor `i`.
fn water_of(w: &World, i: usize) -> u32 {
    w.pass_water.component[w.cell_index(w.actors[i].x, w.actors[i].y)]
}

fn ships(w: &World, player: u8) -> Vec<usize> {
    (0..w.actors.len()).filter(|&i| w.actors[i].alive && w.actors[i].owner == player && w.actors[i].kind == Kind::Ship).collect()
}

/// An idle fleet whose leader fires from the edge of a Cruiser's 20 cell
/// range looks for enemies around its target, not around the point it aims
/// at (20 cells off, where OpenRA's scan found nothing and the fleet never
/// set out), attacks, and keeps attacking while its leader fires.
#[test]
fn a_cruiser_fleet_sets_out_for_a_target_on_the_shore() {
    let mut w = naval_arena();
    flood(&mut w, 0, 0, 40, 63);
    let plant = put(&mut w, "POWR", 1, 46, 30);
    let ca = w.spawn_unit(ty(&w, "CA"), 0, cell_center(20), cell_center(30), 768);
    let (px, py) = (w.actors[plant].x, w.actors[plant].y);
    w.add_reveal(0, px, py, 3 * CELL, 25 * 300);
    w.update_vision();
    // The plant is out of the Cruiser's sight and sight reach, but seen.
    let (ox, oy) = crate::ai::attack_offset(&w, ca, plant).expect("in reach");
    assert!((ox as i64).pow(2) + (oy as i64).pow(2) >= (19 * CELL as i64).pow(2), "at the edge of the range: {ox},{oy}");
    let full = w.actors[plant].hp;
    let mut fired_at = None;
    for _ in 0..25 * 120 {
        w.step();
        if w.actors[plant].hp < full {
            fired_at = Some(w.tick);
            break;
        }
    }
    assert!(fired_at.is_some(), "the Cruiser shells the plant: {}", crate::ai_squads::describe(&w, 0));
    assert!(naval_report(&w, 0).attacks >= 1);
    // Firing counts as progress: the squad does not drop back to idle
    // (OpenRA's 63 tick stuck check) while its Cruiser shells the shore.
    for _ in 0..150 {
        w.step();
        if !w.actors[plant].alive {
            break;
        }
        assert!(!crate::ai_squads::describe(&w, 0).contains("GroundIdle"), "{}", crate::ai_squads::describe(&w, 0));
    }
}

/// Missile Submarines start on ReturnFire for bots, so on an attack move
/// they would skip a structure that is not a defence; the fleet orders them
/// to attack the structure it went for directly.
#[test]
fn missile_submarines_attack_the_structure_they_were_sent_to() {
    let seats: [Seat; 2] = [("russia", naval(), 0, (52, 4)), ("england", None, 0, (52, 50))];
    let mut w = arena(64, &seats);
    w.ai[0].passive = true;
    flood(&mut w, 0, 0, 40, 63);
    let silo = w.spawn_building(ty(&w, "SILO"), 1, 42, 30).expect("silo");
    let msub = w.spawn_unit(ty(&w, "MSUB"), 0, cell_center(25), cell_center(30), 768);
    assert!(w.actors[msub].stance < crate::rules::Stance::Defend, "ReturnFire for bots");
    let full = w.actors[silo].hp;
    let mut hit = false;
    for _ in 0..25 * 120 {
        w.step();
        if !w.actors[silo].alive || w.actors[silo].hp < full {
            hit = true;
            break;
        }
    }
    assert!(hit, "{}", crate::ai_squads::describe(&w, 0));
}

/// A target out of sight counts as in reach only from within the ship's
/// sight (less a cell): the engine's units fire only at what their owner
/// sees. Seen, the whole weapon range counts.
#[test]
fn ships_reach_unseen_targets_only_within_their_sight() {
    let mut w = naval_arena();
    flood(&mut w, 0, 0, 40, 63);
    let plant = put(&mut w, "POWR", 1, 51, 30);
    let ca = w.spawn_unit(ty(&w, "CA"), 0, cell_center(20), cell_center(30), 768);
    w.step();
    assert!(!w.targetable(plant, 0));
    // 11 cells from the water: within range 20, beyond sight 7.
    assert_eq!(crate::ai::attack_offset(&w, ca, plant), None);
    let cfg = w.ai[0].cfg.clone();
    assert!(!crate::ai_naval::enemy_in_reach(&w, 0, &cfg, ty(&w, "CA"), water(&w, 20, 30)));
    let (px, py) = (w.actors[plant].x, w.actors[plant].y);
    w.add_reveal(0, px, py, 3 * CELL, 25 * 60);
    w.step();
    assert!(w.targetable(plant, 0));
    assert!(crate::ai::attack_offset(&w, ca, plant).is_some());
    assert!(crate::ai_naval::enemy_in_reach(&w, 0, &cfg, ty(&w, "CA"), water(&w, 20, 30)));
    // A target closer to the shore: the ship gets within sight of it.
    let pier = put(&mut w, "POWR", 1, 42, 10);
    assert!(!w.targetable(pier, 0));
    let o = crate::ai::view_offset(&w, ca, pier).expect("in sight reach");
    assert!(o.0 * o.0 + o.1 * o.1 <= (6 * CELL) * (6 * CELL), "{o:?}");
}

/// A naval yard on a pond that leads to no enemy builds no warships; once
/// an enemy stands on that water it does.
#[test]
fn warships_are_built_only_for_water_that_reaches_an_enemy() {
    let game = |enemy_on_pond: bool| {
        let mut w = naval_arena();
        flood(&mut w, 10, 10, 24, 24);
        harbour_base(&mut w);
        let yard = w.spawn_building(ty(&w, "SYRD"), 0, 12, 12).expect("yard on the pond");
        if enemy_on_pond {
            w.spawn_building(ty(&w, "SYRD"), 1, 20, 20).expect("enemy yard on the pond");
        }
        w.refresh_tokens();
        w.update_power();
        w.step();
        let cfg = w.ai[0].cfg.clone();
        let pt = ty(&w, "PT");
        assert_eq!(crate::ai_naval::warship_useful(&w, 0, &cfg, pt), enemy_on_pond);
        run(&mut w, 25 * 150);
        assert!(!crate::tests_ai::army(&w, 0).is_empty(), "the bot builds units");
        assert!(w.actors[yard].alive);
        ships(&w, 0).len()
    };
    assert_eq!(game(false), 0, "no warships for a dead pond");
    assert!(game(true) >= 1, "warships for an enemy on the pond");
}

/// A yard on two bodies of water (a large pond and a small sea that leads
/// to an enemy) gets its rally point on the sea, so its ships launch there
/// (naval.rs launches onto the rally point's water, else the largest).
#[test]
fn a_yard_between_two_waters_launches_onto_the_one_that_reaches() {
    let mut w = naval_arena();
    // Pond x 0..=15, a land wall at x 16 (but under the yard), sea x 17..=27.
    flood(&mut w, 0, 0, 27, 40);
    for y in 0..=40 {
        let i = w.map.idx(16, y);
        w.map.terrain[i] = crate::map::Terrain::Clear;
    }
    for y in 20..=22 {
        let i = w.map.idx(16, y);
        w.map.terrain[i] = crate::map::Terrain::Water;
    }
    w.pass = crate::flowfield::Passability::new(&w.map);
    w.pass_water = crate::flowfield::Passability::water(&w.map);
    w.pass_landing = crate::flowfield::Passability::landing(&w.map);
    harbour_base(&mut w);
    let yard = w.spawn_building(ty(&w, "SYRD"), 0, 15, 20).expect("yard on the gap");
    put(&mut w, "POWR", 1, 30, 30);
    w.refresh_tokens();
    w.update_power();
    w.step();
    let (pond, sea) = (water(&w, 5, 5), water(&w, 22, 5));
    assert_ne!(pond, sea);
    let launch = w.naval_spawn_cell(yard).unwrap();
    assert_eq!(water(&w, launch.0, launch.1), pond, "the larger pond by default");
    run(&mut w, 25 * 120);
    let (rx, ry) = w.actors[yard].rally.expect("a rally point");
    assert_eq!(w.pass_water.component[w.cell_index(rx, ry)], sea);
    let built = ships(&w, 0);
    assert!(!built.is_empty(), "warships for the sea");
    assert!(built.iter().all(|&s| water_of(&w, s) == sea), "launched onto the sea");
}

/// Of two yards, the one on water that leads to an enemy becomes primary,
/// so warships are built where they can fight.
#[test]
fn the_yard_on_useful_water_becomes_primary() {
    let mut w = naval_arena();
    flood(&mut w, 2, 20, 12, 30);
    flood(&mut w, 20, 20, 40, 63);
    harbour_base(&mut w);
    let pond_yard = w.spawn_building(ty(&w, "SYRD"), 0, 4, 22).expect("pond yard");
    let sea_yard = w.spawn_building(ty(&w, "SYRD"), 0, 25, 22).expect("sea yard");
    assert!(pond_yard < sea_yard, "the pond yard comes first");
    put(&mut w, "POWR", 1, 42, 40);
    w.refresh_tokens();
    w.update_power();
    w.step();
    run(&mut w, 25 * 120);
    assert!(w.actors[sea_yard].primary && !w.actors[pond_yard].primary);
    let built = ships(&w, 0);
    assert!(!built.is_empty());
    let sea = water(&w, 30, 40);
    assert!(built.iter().all(|&s| water_of(&w, s) == sea), "{:?}", built.iter().map(|&s| water_of(&w, s)).collect::<Vec<_>>());
}

/// Ships on separate bodies of water form separate naval squads (OpenRA
/// keeps one, whose leader on a pond held the whole fleet back).
#[test]
fn one_naval_squad_per_body_of_water() {
    let mut w = naval_arena();
    flood(&mut w, 2, 20, 12, 30);
    flood(&mut w, 20, 20, 40, 63);
    let a = quiet_unit(&mut w, "PT", 0, 6, 25);
    let b = quiet_unit(&mut w, "PT", 0, 30, 30);
    let c = quiet_unit(&mut w, "PT", 0, 32, 30);
    run(&mut w, 25 * 5);
    let r = naval_report(&w, 0);
    assert_eq!((r.squads, r.ships, r.largest), (2, 3, 2));
    let mut all = squad_units(&w, 0, SquadType::Naval);
    all.sort_unstable();
    assert_eq!(all, vec![a, b, c]);
}

/// A fleeing fleet falls back to a naval yard on its own water (OpenRA's
/// random own structure stands on land, out of a ship's reach), and with
/// none there to OpenRA's choice.
#[test]
fn a_fleeing_fleet_falls_back_to_its_yard() {
    let mut w = naval_arena();
    flood(&mut w, 2, 20, 12, 30);
    flood(&mut w, 20, 20, 40, 63);
    let yard = w.spawn_building(ty(&w, "SYRD"), 0, 25, 40).expect("sea yard");
    w.refresh_tokens();
    w.step();
    let at_sea = quiet_unit(&mut w, "PT", 0, 35, 25);
    let on_pond = quiet_unit(&mut w, "PT", 0, 6, 25);
    let (x, y) = crate::ai_squads::naval_retreat(&mut w, 0, &[at_sea]).expect("the yard");
    let (cx, cy) = w.cell_of(x, y);
    let (yx, yy) = (w.actors[yard].cx, w.actors[yard].cy);
    assert!((yx - 1..=yx + 3).contains(&cx) && (yy - 1..=yy + 3).contains(&cy), "by the yard: {cx},{cy}");
    assert_eq!(water(&w, cx, cy), water_of(&w, at_sea));
    assert_eq!(crate::ai_squads::naval_retreat(&mut w, 0, &[on_pond]), None);
}

/// A fleet that stands where it should see its target and does not (a Gap
/// Generator shrouds it) leaves the target alone for a while, and builds
/// no warships for it.
#[test]
fn a_fleet_gives_up_on_a_target_it_cannot_see() {
    let mut w = naval_arena();
    flood(&mut w, 0, 0, 40, 63);
    put(&mut w, "POWR", 1, 52, 40);
    // Five cells from the water: within a Gunboat's sight reach (its range,
    // 5.5 cells), outside the four cells units see into a generator's field.
    let silo = w.spawn_building(ty(&w, "SILO"), 1, 45, 30).expect("silo");
    let gap = w.spawn_building(ty(&w, "GAP"), 1, 47, 29).expect("gap");
    w.refresh_tokens();
    w.update_power();
    let pt = w.spawn_unit(ty(&w, "PT"), 0, cell_center(30), cell_center(30), 768);
    w.step();
    let cfg = w.ai[0].cfg.clone();
    let reach = |w: &World| crate::ai_naval::enemy_in_reach(w, 0, &cfg, ty(w, "PT"), water(w, 30, 30));
    assert!(reach(&w));
    let mut blind = false;
    for _ in 0..25 * 90 {
        w.step();
        if crate::ai_squads::naval_blind(&w, 0, silo) {
            blind = true;
            break;
        }
    }
    assert!(blind, "{}", crate::ai_squads::describe(&w, 0));
    assert!(w.actors[silo].alive && w.actors[gap].alive && !w.targetable(silo, 0), "shrouded");
    assert_ne!(crate::ai_squads::naval_target(&w, 0), Some(silo));
    assert!(w.actors[pt].alive);
    // Nothing else is in reach, so no warship is useful.
    assert!(!reach(&w));
}

/// An attack on the naval yard turns the fleet on the attacker when one of
/// its ships is near, whichever ship was built first (OpenRA asks the
/// squad's first unit).
#[test]
fn the_fleet_defends_its_harbour() {
    let mut w = naval_arena();
    flood(&mut w, 0, 0, 40, 63);
    let yard = w.spawn_building(ty(&w, "SYRD"), 0, 20, 10).expect("yard");
    // An enemy structure far away keeps the fleet busy.
    let far = put(&mut w, "POWR", 1, 41, 60);
    let (fx, fy) = (w.actors[far].x, w.actors[far].y);
    w.add_reveal(0, fx, fy, 3 * CELL, 25 * 600);
    w.refresh_tokens();
    w.update_vision();
    w.update_power();
    let first = quiet_unit(&mut w, "PT", 0, 36, 55);
    let near = quiet_unit(&mut w, "PT", 0, 24, 16);
    for _ in 0..25 * 20 {
        w.step();
        if crate::ai_squads::naval_target(&w, 0) == Some(far) {
            break;
        }
    }
    assert_eq!(naval_report(&w, 0).squads, 1);
    let id = |w: &World, t: Option<usize>| t.map(|t| (t, w.rules.actors[w.actors[t].ty as usize].id.clone(), w.actors[t].owner));
    assert_eq!(id(&w, crate::ai_squads::naval_target(&w, 0)), id(&w, Some(far)), "{}", crate::ai_squads::describe(&w, 0));
    // In sight of the near ship.
    let raider = w.spawn_unit(ty(&w, "PT"), 1, cell_center(25), cell_center(13), 256);
    w.step();
    assert!(w.targetable(raider, 0));
    let (yr, rr) = (w.make_ref(yard), w.make_ref(raider));
    w.ai[0].events.push(crate::ai::AttackEvent { victim: yr, attacker: rr, before: 100, after: 90 });
    run(&mut w, 3);
    assert_eq!(crate::ai_squads::naval_target(&w, 0), Some(raider), "{}", crate::ai_squads::describe(&w, 0));
    assert!(w.actors[first].alive && w.actors[near].alive);
}

/// Naval yards go on water from which the bot's warships can hit an enemy:
/// with only a pond by the base none is built; with the sea, one is, by it.
#[test]
fn naval_yards_are_built_only_on_water_that_reaches_an_enemy() {
    let game = |sea: bool| {
        let seats: [Seat; 2] = [("england", naval(), 0, (20, 4)), ("russia", None, 0, (52, 50))];
        let mut w = arena(64, &seats);
        w.ai[0].passive = true;
        flood(&mut w, 26, 2, 32, 12);
        if sea {
            flood(&mut w, 26, 13, 32, 63);
            put(&mut w, "POWR", 1, 34, 40);
        }
        w.refresh_tokens();
        run(&mut w, 25 * 240);
        let syrd = ty(&w, "SYRD");
        let yards: Vec<usize> =
            (0..w.actors.len()).filter(|&i| w.actors[i].alive && w.actors[i].owner == 0 && w.actors[i].ty == syrd).collect();
        let reach: Vec<bool> = yards
            .iter()
            .map(|&b| {
                let cfg = w.ai[0].cfg.clone();
                let types = crate::ai_naval::warship_types(&w, &cfg);
                !crate::ai_naval::reaching(&w, 0, &cfg, &types, &crate::ai_naval::water_around_building(&w, b)).is_empty()
            })
            .collect();
        (yards.len(), reach)
    };
    assert_eq!(game(false).0, 0, "no naval yard on a pond");
    let (n, reach) = game(true);
    assert!(n >= 1 && reach.iter().all(|&r| r), "{n} yards, reaching {reach:?}");
}

/// Generated maps where fleets used to pile up: on rivers with fords
/// (seed 3) a Turtle AI's fleet of 37 ships idled without a target for 99 %
/// of the game, and on islands (seed 2) a fleet of 41 never set out (its
/// leader aimed from a Missile Submarine's 20 cells). Now no fleet idles
/// large without a target, and the fleets attack.
#[test]
fn generated_naval_maps_keep_no_idle_fleets() {
    use crate::mapgen::MapStyle;
    use crate::world::{GameOptions, PlayerSetup};
    for (style, seed) in [(MapStyle::Rivers, 3u64), (MapStyle::Islands, 2)] {
        let factions = if (seed / 2).is_multiple_of(2) { ["allies", "soviet"] } else { ["soviet", "allies"] };
        let players: Vec<PlayerSetup> =
            (0..2).map(|k| PlayerSetup { bot: BotType::Turtle, ..PlayerSetup::new(factions[k], Some(AiDifficulty::Normal)) }).collect();
        let mut w = World::with_options(seed, 96, &players, GameOptions { map_style: style, ..GameOptions::default() });
        let (mut idle_most, mut largest, mut attacks) = (0, 0, 0);
        for _ in 0..25 * 60 * 45 {
            w.step();
            for p in 0..2 {
                let r = naval_report(&w, p);
                idle_most = idle_most.max(r.idle_ships);
                largest = largest.max(r.largest);
            }
            if w.winner.is_some() {
                break;
            }
        }
        for p in 0..2 {
            attacks += naval_report(&w, p).attacks;
        }
        // Before: 37 idle ships on the rivers, a fleet of 41 on the islands.
        assert!(idle_most <= 12 && largest <= 15, "{style:?} seed {seed}: {idle_most} idle ships, largest fleet {largest}");
        assert!(attacks >= 10, "{style:?} seed {seed}: {attacks} naval attacks");
    }
}

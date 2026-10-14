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
        assert_eq!(crate::ai_naval::warship_useful(&mut w, 0, &cfg, pt), enemy_on_pond);
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
    let (pt_ty, sea) = (ty(&w, "PT"), water(&w, 30, 30));
    assert!(!crate::ai_naval::in_reach(&mut w, 0, &cfg, pt_ty, sea));
}

/// The bots ask once per tick which water reaches an enemy (ai_naval.rs
/// `in_reach`): the same answers as asking afresh, and a target the fleet
/// gives up on within the tick is dropped from them at once.
#[test]
fn reach_answers_are_cached_per_tick() {
    let mut w = naval_arena();
    flood(&mut w, 0, 0, 40, 63);
    let silo = w.spawn_building(ty(&w, "SILO"), 1, 42, 30).expect("silo");
    quiet_unit(&mut w, "PT", 0, 37, 30);
    run(&mut w, 25 * 3);
    let cfg = w.ai[0].cfg.clone();
    let (pt, sea) = (ty(&w, "PT"), water(&w, 30, 30));
    for _ in 0..3 {
        let fresh = crate::ai_naval::enemy_in_reach(&w, 0, &cfg, pt, sea);
        assert!(fresh);
        assert_eq!(crate::ai_naval::in_reach(&mut w, 0, &cfg, pt, sea), fresh);
        assert_eq!(crate::ai_naval::in_reach(&mut w, 0, &cfg, pt, sea), fresh, "cached");
        w.step();
    }
    // Given up within the tick (here: hidden by force): asked again, no reach.
    assert!(crate::ai_naval::in_reach(&mut w, 0, &cfg, pt, sea));
    w.players[0].visible.iter_mut().for_each(|v| *v = 0);
    crate::ai_squads::naval_target_check(&mut w, 0, silo);
    assert!(crate::ai_squads::naval_blind(&w, 0, silo));
    assert!(!crate::ai_naval::in_reach(&mut w, 0, &cfg, pt, sea));
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
        let cfg = w.ai[0].cfg.clone();
        let types = crate::ai_naval::warship_types(&w, &cfg);
        let reach: Vec<bool> = yards
            .iter()
            .map(|&b| {
                let around = crate::ai_naval::water_around_building(&w, b);
                !crate::ai_naval::reaching(&mut w, 0, &cfg, &types, &around).is_empty()
            })
            .collect();
        (yards.len(), reach)
    };
    assert_eq!(game(false).0, 0, "no naval yard on a pond");
    let (n, reach) = game(true);
    assert!(n >= 1 && reach.iter().all(|&r| r), "{n} yards, reaching {reach:?}");
}

/// Whether one of `ships` (of `player`) has an enemy it can surely attack
/// from its body of water (`pass_water` component). A sufficient condition
/// judged from the world, not from the bots' `enemy_in_reach` (ai_naval.rs)
/// this test checks; it may miss enemies the bots reach (the safe side):
/// - an enemy ship on the same water: OpenRA's FindEnemies tries the
///   target's own position first;
/// - an enemy structure on water when one of OpenRA's nine FindEnemies
///   points (the structure's centre and eight points at the ship's range
///   against it, ai.rs `offset_within`) lies on that water and a cell the
///   structure can be hit on (`hit_cells`, Occupied cells, as combat.rs
///   measures) is within the ship's weapon range of that point. The bots
///   reach a structure only through those points, so this part applies the
///   bots' rule (written out again here, not called) and adds the check
///   that the ship can fire from there.
///
/// Both count only targets `player` can target now: seen and not cloaked
/// (the bots go for no unit they do not see, and a ship fires only at what
/// its owner sees). This shares engine rules with the bots: `targetable`
/// (`is_visible_to`, cloaks), `target_class` and the weapons' target
/// classes and ranges (`can_attack_class`, `range_against`,
/// `reaches_class`), and for structures the nine-point rule. A bug there
/// misleads the bots and this oracle alike and is for the combat and reach
/// tests to find; what this guards is the rest of the bots' reach and
/// squad logic (water labels, preferred enemies, blind targets, squad
/// states).
fn meets_enemy(w: &World, player: u8, ships: &[usize]) -> bool {
    let water = |c: usize| (!w.pass_water.blocked[c]).then(|| w.pass_water.component[c]);
    let enemies: Vec<usize> = (0..w.actors.len())
        .filter(|&t| w.actors[t].alive && w.are_enemies(player, w.actors[t].owner) && w.targetable(t, player))
        .filter(|&t| match w.actors[t].kind {
            Kind::Ship => true,
            Kind::Building => w.rules.actors[w.actors[t].ty as usize].building.as_ref().is_some_and(|b| b.on_water),
            _ => false,
        })
        .collect();
    ships.iter().any(|&s| {
        let Some(comp) = water(w.cell_index(w.actors[s].x, w.actors[s].y)) else { return false };
        let info = &w.rules.actors[w.actors[s].ty as usize];
        enemies.iter().any(|&t| {
            let class = w.target_class(t);
            if !info.can_attack_class(&w.rules, class) {
                return false;
            }
            let a = &w.actors[t];
            if a.kind == Kind::Ship {
                return water(w.cell_index(a.x, a.y)) == Some(comp);
            }
            let b = w.rules.actors[a.ty as usize].building.as_ref().unwrap();
            let r = info.range_against(&w.rules, class);
            let diag = r * 724 / 1024;
            let points = [(0, 0), (r, 0), (-r, 0), (0, r), (0, -r), (diag, diag), (-diag, diag), (-diag, -diag), (diag, -diag)];
            points.into_iter().any(|(ox, oy)| {
                let (px, py) = (a.x + ox, a.y + oy);
                let on_map = px >= 0 && py >= 0 && px < w.map.width * CELL && py < w.map.height * CELL;
                on_map
                    && water(w.cell_index(px, py)) == Some(comp)
                    && b.hit_cells.iter().any(|&(dx, dy)| {
                        let d = crate::math::dist_sq(px, py, cell_center(a.cx + dx), cell_center(a.cy + dy));
                        info.reaches_class(&w.rules, class, d)
                    })
            })
        })
    })
}

/// Generated maps where fleets used to pile up idle: in 15 minutes on 64
/// cell maps a Naval AI on rivers with fords (seed 3) gathered 20 ships
/// idle without a target, a Turtle AI on islands (seed 3) 12, while enemies
/// were in reach. Three checks per scenario:
/// - no naval squad idles without a target (`idle_naval_squads`) longer
///   than one squad update (AttackForceInterval) while one of its own
///   ships surely has an enemy to attack (`meets_enemy`);
/// - fleets met enemies at all (`contested`), or the first check proves
///   nothing;
/// - the most ships idle at once stays within the scenario's bound. A fleet
///   with no enemy it can reach may wait: on the islands the Soviet bot's
///   submarines wait at home while the enemy's destroyers sail in the fog.
///
/// To recalibrate after a change to the bots or the map generator (or a
/// merge with another branch that changes them), run this test with
/// `--nocapture`, read the printed `idle_most` per scenario and set each
/// bound to that peak; the other two checks must hold as they are.
#[test]
fn generated_naval_maps_keep_no_idle_fleets() {
    use crate::ai_squads::idle_naval_squads;
    use crate::mapgen::MapStyle;
    use crate::world::{GameOptions, PlayerSetup};
    use std::collections::BTreeMap;
    // Style, seed, bot and the most ships idle at once (measured).
    let scenarios = [(MapStyle::Rivers, 3u64, BotType::Naval, 4), (MapStyle::Islands, 3, BotType::Turtle, 9)];
    for (style, seed, bot, idle_bound) in scenarios {
        let factions = if (seed / 2).is_multiple_of(2) { ["allies", "soviet"] } else { ["soviet", "allies"] };
        let players: Vec<PlayerSetup> =
            (0..2).map(|k| PlayerSetup { bot, ..PlayerSetup::new(factions[k], Some(AiDifficulty::Normal)) }).collect();
        let mut w = World::with_options(seed, 64, &players, GameOptions { map_style: style, ..GameOptions::default() });
        let mut idle_most = 0;
        // Per (player, squad id): consecutive ticks the squad idled with an
        // enemy its own ships surely reach.
        let mut waited: BTreeMap<(u8, u32), i32> = BTreeMap::new();
        let mut waited_most = 0;
        // Ticks a player's naval squads (idle or not) had such an enemy.
        let mut contested = 0;
        for _ in 0..25 * 60 * 15 {
            w.step();
            let mut now = BTreeMap::new();
            for p in 0..2u8 {
                idle_most = idle_most.max(naval_report(&w, p).idle_ships);
                contested += meets_enemy(&w, p, &squad_units(&w, p, SquadType::Naval)) as u32;
                for (id, ships) in idle_naval_squads(&w, p) {
                    if meets_enemy(&w, p, &ships) {
                        let n = waited.get(&(p, id)).copied().unwrap_or(0) + 1;
                        waited_most = waited_most.max(n);
                        now.insert((p, id), n);
                    }
                }
            }
            waited = now;
            if w.winner.is_some() {
                break;
            }
        }
        eprintln!("{style:?} seed {seed} {bot:?}: idle_most {idle_most} waited_most {waited_most} contested {contested}");
        assert!(contested > 0, "{style:?} seed {seed} {bot:?}: no fleet ever had an enemy to attack");
        let interval = w.ai[0].cfg.info.squads.attack_force_interval;
        assert!(
            waited_most <= interval,
            "{style:?} seed {seed} {bot:?}: a fleet idled {waited_most} ticks with an enemy to attack (squads update every {interval})"
        );
        assert!(idle_most <= idle_bound, "{style:?} seed {seed} {bot:?}: {idle_most} ships idle at once (bound {idle_bound})");
    }
}

/// Rain, snow and sandstorms shorten sight (weather.rs), so they shorten
/// how near a ship must get to see a target too: in a sandstorm a Cruiser
/// (sight 7 cells, 5.25 in the storm) heads for a point it sees the target
/// from, shells it, and never gives it up as out of sight.
#[test]
fn ships_get_close_enough_to_see_in_a_sandstorm() {
    use crate::weather::{Biome, Environment, Weather, WeatherMode};
    let mut w = naval_arena();
    w.env = Environment::new(Biome::Desert, WeatherMode::Full, 5);
    w.env.weather = Weather::Sandstorm;
    w.env.until = u32::MAX;
    flood(&mut w, 0, 0, 40, 63);
    // Six cells from the nearest water point: within a Cruiser's clear sight
    // reach (six cells), beyond its reach in the storm (4.25 cells).
    let far = w.spawn_building(ty(&w, "SILO"), 1, 46, 50).expect("silo");
    let silo = w.spawn_building(ty(&w, "SILO"), 1, 43, 30).expect("silo");
    let ca = w.spawn_unit(ty(&w, "CA"), 0, cell_center(20), cell_center(30), 768);
    w.step();
    assert!(!w.targetable(far, 0) && !w.targetable(silo, 0));
    assert_eq!(crate::ai::sight_reach(&w, ty(&w, "CA")), 7 * CELL * 75 / 100 - CELL);
    assert_eq!(crate::ai::attack_offset(&w, ca, far), None, "out of reach in the storm");
    let (ox, oy) = crate::ai::view_offset(&w, ca, silo).expect("in reach");
    assert!((ox as i64).pow(2) + (oy as i64).pow(2) <= (crate::ai::sight_reach(&w, ty(&w, "CA")) as i64).pow(2));
    w.env.weather = Weather::Clear;
    assert!(crate::ai::attack_offset(&w, ca, far).is_some(), "in reach in clear weather");
    w.env.weather = Weather::Sandstorm;
    let full = w.actors[silo].hp;
    let mut hit = false;
    for _ in 0..25 * 120 {
        w.step();
        assert!(!crate::ai_squads::naval_blind(&w, 0, silo), "{}", crate::ai_squads::describe(&w, 0));
        if !w.actors[silo].alive || w.actors[silo].hp < full {
            hit = true;
            break;
        }
    }
    assert!(hit, "{}", crate::ai_squads::describe(&w, 0));
}

/// A submarine that dives within a fleet's sight but out of its detection
/// is cloaked, not shrouded: the fleet does not give it up as unseeable
/// (a_fleet_gives_up_on_a_target_it_cannot_see covers the shroud), and goes
/// for it again once it surfaces.
#[test]
fn a_diving_submarine_is_not_given_up_as_unseeable() {
    let mut w = naval_arena();
    flood(&mut w, 0, 0, 40, 63);
    let pt = quiet_unit(&mut w, "PT", 0, 20, 20);
    run(&mut w, 25 * 3);
    assert_eq!(naval_report(&w, 0).squads, 1);
    // Six cells off: in the Gunboat's sight (8), out of its detection (4).
    let ss = quiet_unit(&mut w, "SS", 1, 20, 26);
    w.actors[ss].submerged = true;
    w.step();
    w.actors[ss].submerged = true;
    w.update_vision();
    assert!(!w.targetable(ss, 0) && w.players[0].visible[w.cell_index(w.actors[ss].x, w.actors[ss].y)] != 0, "cloaked, not fogged");
    crate::ai_squads::naval_target_check(&mut w, 0, ss);
    assert!(!crate::ai_squads::naval_blind(&w, 0, ss), "a cloak is not the fog");
    // Surfaced, it is a target again.
    let mut again = false;
    for _ in 0..25 * 30 {
        w.actors[ss].submerged = false;
        w.step();
        if crate::ai_squads::naval_target(&w, 0) == Some(ss) {
            again = true;
            break;
        }
    }
    assert!(again, "{}", crate::ai_squads::describe(&w, 0));
    assert!(w.actors[pt].alive);
}

/// A bot's Transport (map placed; OpenRA's NavalUnitsTypes lists it, so it
/// joins the naval squads) counts as on the water it floats on, or next to
/// the beach it stands on: it joins the warships' squad and falls back to
/// their yard.
#[test]
fn a_landing_craft_joins_the_fleet_of_its_water() {
    let mut w = naval_arena();
    // A pond (rows 0 to 7) and the sea (rows 10 on) with a beach between:
    // one body for landing craft, two for ships, so the labels of the two
    // passabilities differ.
    flood(&mut w, 0, 0, 40, 63);
    for y in 8..=9 {
        for x in 0..=40 {
            let i = w.map.idx(x, y);
            w.map.terrain[i] = crate::map::Terrain::Beach;
        }
    }
    w.pass = crate::flowfield::Passability::new(&w.map);
    w.pass_water = crate::flowfield::Passability::water(&w.map);
    w.pass_landing = crate::flowfield::Passability::landing(&w.map);
    w.spawn_building(ty(&w, "SYRD"), 0, 20, 50).expect("yard");
    w.refresh_tokens();
    w.step();
    assert_ne!(water(&w, 5, 3), water(&w, 5, 30));
    assert_ne!(w.pass_landing.component[w.map.idx(5, 30)], water(&w, 5, 30));
    let pt = quiet_unit(&mut w, "PT", 0, 30, 30);
    let afloat = w.spawn_unit(ty(&w, "LST"), 0, cell_center(25), cell_center(10), 768);
    let beached = w.spawn_unit(ty(&w, "LST"), 0, cell_center(20), cell_center(9), 768);
    assert!(w.lands(beached) && w.pass_water.blocked[w.map.idx(20, 9)]);
    let sea = water(&w, 30, 30);
    for u in [pt, afloat, beached] {
        assert_eq!(crate::ai_squads::water_of(&w, u), Some(sea));
    }
    run(&mut w, 25 * 5);
    let r = naval_report(&w, 0);
    assert_eq!((r.squads, r.ships), (1, 3), "{}", crate::ai_squads::describe(&w, 0));
    assert!(crate::ai_squads::naval_retreat(&mut w, 0, &[beached]).is_some(), "back to the yard");
}

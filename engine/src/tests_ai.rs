//! Tests for the skirmish AI: OpenRA's four Red Alert bots and their modules
//! (ai.rs and ai_*.rs), never hurting allies, and fair, finishing games on
//! generated maps.

use crate::ai_bots::{BotConfig, BotType, Difficulty};
use crate::map::{Map, Terrain};
use crate::math::{dist, CELL};
use crate::rules::{Kind, Rules};
use crate::world::{cell_center, Activity, AiDifficulty, GameOptions, PlayerSetup, World};

fn ty(w: &World, id: &str) -> u16 {
    w.rules.actor_index(id).unwrap() as u16
}

fn run(w: &mut World, ticks: u32) {
    for _ in 0..ticks {
        w.step();
    }
}

fn count(w: &World, owner: u8, id: &str) -> usize {
    let t = ty(w, id);
    w.actors.iter().filter(|a| a.alive && a.owner == owner && a.ty == t).count()
}

/// One arena player: faction, bot and difficulty (None: a passive human), team, yard cell.
type Seat<'a> = (&'a str, Option<(BotType, AiDifficulty)>, u8, (i32, i32));

/// An all-clear square map without ore. Everyone is rich.
fn arena(size: i32, players: &[Seat]) -> World {
    let rules = Rules::load();
    let mut map = Map::generate(size, size, 3, 12);
    for i in 0..map.cells() {
        map.terrain[i] = Terrain::Clear;
        map.ore[i] = 0;
        map.gems[i] = 0;
    }
    let mut w = World::empty(rules, map, 3);
    w.pass = crate::flowfield::Passability::new(&w.map);
    w.pass_water = crate::flowfield::Passability::water(&w.map);
    w.pass_landing = crate::flowfield::Passability::landing(&w.map);
    for (p, &(faction, ai, team, start)) in players.iter().enumerate() {
        let f = w.rules.faction_index(faction).unwrap();
        w.add_player(f, ai.is_some(), start);
        w.players[p].team = team;
        w.players[p].cash = 100_000;
        let (bot, diff) = ai.unwrap_or((BotType::Normal, AiDifficulty::Normal));
        let st = crate::ai::AiState::new(&w.rules, p as u8, bot, diff);
        w.ai.push(st);
        w.spawn_building(ty(&w, "FACT"), p as u8, start.0, start.1);
    }
    w.refresh_tokens();
    w.update_power();
    w.update_vision();
    w
}

fn normal() -> Option<(BotType, AiDifficulty)> {
    Some((BotType::Normal, AiDifficulty::Normal))
}

/// Turn part of the map into water and refresh passability.
fn flood(w: &mut World, x0: i32, y0: i32, x1: i32, y1: i32) {
    for y in y0..=y1 {
        for x in x0..=x1 {
            let i = w.map.idx(x, y);
            w.map.terrain[i] = Terrain::Water;
        }
    }
    w.pass = crate::flowfield::Passability::new(&w.map);
    w.pass_water = crate::flowfield::Passability::water(&w.map);
    w.pass_landing = crate::flowfield::Passability::landing(&w.map);
}

/// Ore on a rectangle of cells.
fn ore(w: &mut World, x0: i32, y0: i32, x1: i32, y1: i32) {
    for y in y0..=y1 {
        for x in x0..=x1 {
            let i = w.map.idx(x, y);
            w.map.ore[i] = 10;
        }
    }
}

/// A base around the yard: power, refineries, factories, radar, depot, tech.
fn complete_base(w: &mut World, player: u8) {
    let (sx, sy) = w.players[player as usize].start;
    let soviet = w.players[player as usize].side == 1;
    let (barracks, tech) = if soviet { ("BARR", "STEK") } else { ("TENT", "ATEK") };
    let layout = [
        ("APWR", 4, 0),
        ("APWR", 8, 0),
        ("APWR", 12, 0),
        ("APWR", 16, 0),
        ("PROC", 0, 5),
        ("PROC", 4, 5),
        ("WEAP", 8, 5),
        ("FIX", 12, 5),
        ("DOME", 16, 5),
        (barracks, 0, 10),
        (tech, 4, 10),
    ];
    for (id, dx, dy) in layout {
        let t = ty(w, id);
        w.spawn_building(t, player, sx + dx, sy + dy);
    }
    w.refresh_tokens();
    w.update_power();
}

/// Units that never fire (bait and spotters).
fn quiet_unit(w: &mut World, id: &str, owner: u8, cx: i32, cy: i32) -> usize {
    let u = w.spawn_unit(ty(w, id), owner, cell_center(cx), cell_center(cy), 512);
    w.actors[u].reload = [1_000_000; crate::world::MAX_WEAPONS];
    u
}

/// Put a structure at (x, y), or at the nearest spot after it where no other
/// structure is in the way (structures never share cells).
fn put(w: &mut World, id: &str, player: u8, x: i32, y: i32) -> usize {
    let t = ty(w, id);
    for k in 0..400 {
        if let Some(b) = w.spawn_building(t, player, x + k % 20, y + k / 20) {
            return b;
        }
    }
    panic!("no room for {id} near {x},{y}");
}

/// Own units (not structures) of a player, by type id.
fn army(w: &World, player: u8) -> Vec<String> {
    w.actors
        .iter()
        .filter(|a| a.alive && a.owner == player && a.is_unit() && a.kind != Kind::Mine)
        .map(|a| w.rules.actors[a.ty as usize].id.clone())
        .collect()
}

// ---- Bot configs ------------------------------------------------------------------

/// rules.json carries OpenRA's four RA bots with their module configs.
#[test]
fn rules_carry_openras_four_bots_and_their_configs() {
    let rules = Rules::load();
    let cfg = |b: BotType| BotConfig::new(&rules, b);
    let names: Vec<&str> = rules.bots.iter().map(|b| b.name.as_str()).collect();
    assert_eq!(names, ["Rush AI", "Normal AI", "Turtle AI", "Naval AI"]);
    let (rush, normal, turtle, naval) = (cfg(BotType::Rush), cfg(BotType::Normal), cfg(BotType::Turtle), cfg(BotType::Naval));
    let sizes: Vec<i32> = [&rush, &normal, &turtle, &naval].iter().map(|c| c.info.squads.squad_size).collect();
    assert_eq!(sizes, [20, 40, 10, 1], "SquadSize");
    assert_eq!((turtle.info.squads.rush_interval, turtle.info.squads.minimum_attack_force_delay), (100_000, 100_000));
    let t = |id: &str| rules.actor_index(id).unwrap() as u16;
    assert_eq!(BotConfig::lookup(&normal.fractions, t("PBOX")), Some(9));
    assert_eq!(BotConfig::lookup(&normal.fractions, t("FTUR")), Some(10));
    assert_eq!(BotConfig::lookup(&turtle.limits, t("BARR")), Some(1));
    assert_eq!(BotConfig::lookup(&naval.limits, t("PROC")), Some(3));
    assert_eq!(BotConfig::lookup(&rush.delays, t("DOME")), Some(7000));
    assert_eq!(BotConfig::lookup(&naval.unit_delays, t("HARV")), Some(10000));
    assert_eq!(BotConfig::lookup(&rush.unit_limits, t("DOG")), Some(4));
    assert_eq!(BotConfig::lookup(&turtle.units_to_build, t("MNLY")), Some(2));
    assert_eq!((rush.info.harvester.initial_harvesters, normal.info.harvester.initial_harvesters), (2, 4));
    assert_eq!(rush.info.base_builder.new_production_cash_threshold, 7000);
    assert_eq!(turtle.info.base_builder.minimum_excess_power, 20);
    assert!(naval.info.mcv_manager.is_some() && naval.info.mcv_expansion.is_none());
    for c in [&rush, &normal, &turtle] {
        assert_eq!(c.info.mcv_expansion.as_ref().unwrap().minimum_construction_yard_count, 2);
    }
    assert_eq!(rush.info.mcv_expansion.as_ref().unwrap().move_old_conyard_first, Some(true));
    assert_eq!(normal.info.mcv_expansion.as_ref().unwrap().move_old_conyard_first, None);
    assert!(turtle.info.minelayer.is_some() && rush.info.minelayer.is_none());
    assert!(naval.info.resource_map.is_none(), "the Naval AI has no ResourceMapBotModule");
    let decisions: Vec<(String, i32)> =
        normal.info.support_powers.as_ref().unwrap().decisions.iter().map(|d| (d.order_name.clone(), d.minimum_attractiveness)).collect();
    let expect = [("SovietSpyPlane", 1), ("SovietParatroopers", 5), ("UkraineParabombs", 1), ("NukePowerInfoOrder", 3000)];
    assert_eq!(decisions, expect.map(|(n, a)| (n.to_string(), a)));
    // Power order names reach the decisions.
    let afld = &rules.actors[t("AFLD") as usize].abilities.support_powers.as_ref().unwrap();
    assert!(afld.iter().any(|p| p.order_name == "SovietParatroopers"));
    let mslo = &rules.actors[t("MSLO") as usize].abilities.support_powers.as_ref().unwrap();
    assert_eq!(mslo[0].order_name, "NukePowerInfoOrder");
}

#[test]
fn difficulty_scales_how_fast_a_bot_reacts() {
    assert_eq!(Difficulty(AiDifficulty::Easy).interval(30), 60);
    assert_eq!(Difficulty(AiDifficulty::Normal).interval(30), 30);
    assert_eq!(Difficulty(AiDifficulty::Hard).interval(30), 20);
    assert!(!Difficulty(AiDifficulty::Easy).uses_extra_powers() && Difficulty(AiDifficulty::Hard).uses_extra_powers());
}

/// The lobby's bot field: absent (older lobbies and saves) is the Normal AI;
/// unknown names are refused.
#[test]
fn lobby_bot_types_parse_and_default_to_the_normal_ai() {
    let json = |bot: &str| {
        format!(
            r#"{{"seed":1,"mapSize":64,"players":[{{"type":"human","faction":"england"}},{{"type":"ai","faction":"russia","difficulty":"hard"{bot}}}]}}"#
        )
    };
    assert_eq!(crate::parse_options(&json("")).unwrap().players[1].bot, BotType::Normal);
    for b in BotType::ALL {
        let p = crate::parse_options(&json(&format!(r#","bot":"{}""#, b.name()))).unwrap();
        assert_eq!((p.players[1].bot, p.players[1].ai), (b, Some(AiDifficulty::Hard)));
    }
    assert!(crate::parse_options(&json(r#","bot":"brutal""#)).is_err());
    let g = crate::Game::from_options(&json(r#","bot":"turtle""#)).unwrap();
    assert_eq!(g.world.ai[1].bot, BotType::Turtle);
    // Easy bots play with an extra handicap on top of the slot's.
    let easy = r#"{"seed":1,"mapSize":64,"players":[{"type":"human","faction":"england","handicap":10},{"type":"ai","faction":"russia","difficulty":"easy","handicap":10}]}"#;
    let g = crate::Game::from_options(easy).unwrap();
    assert_eq!((g.world.players[0].handicap, g.world.players[1].handicap), (10, 35));
}

// ---- Fuzzy attack or flee -----------------------------------------------------------

#[test]
fn fuzzy_rules_attack_weaker_enemies_and_flee_stronger_ones() {
    use crate::ai_fuzzy::{can_attack, Fuzzy};
    let mut w = arena(64, &[("russia", normal(), 0, (4, 4)), ("england", None, 0, (52, 52))]);
    let tanks: Vec<usize> = (0..6).map(|k| quiet_unit(&mut w, "3TNK", 0, 20 + k, 20)).collect();
    let few: Vec<usize> = (0..2).map(|k| quiet_unit(&mut w, "1TNK", 1, 20 + k, 30)).collect();
    let many: Vec<usize> = (0..14).map(|k| quiet_unit(&mut w, "2TNK", 1, 30 + k % 7, 30 + k / 7)).collect();
    assert!(can_attack(&w, Fuzzy::Default, &tanks, &few), "six heavy tanks take two light ones");
    assert!(can_attack(&w, Fuzzy::Rush, &tanks, &few), "and rush them");
    assert!(!can_attack(&w, Fuzzy::Rush, &tanks[..2], &many), "two tanks do not rush fourteen");
    // Badly hurt and outgunned: flee.
    for &t in &tanks[..2] {
        w.actors[t].hp = w.rules.actors[w.actors[t].ty as usize].hp / 5;
    }
    assert!(!can_attack(&w, Fuzzy::Default, &tanks[..2], &many), "near dead and weak: flee");
    // Nothing that shoots back: attack whatever the health.
    let powr = put(&mut w, "POWR", 1, 40, 10);
    assert!(can_attack(&w, Fuzzy::Default, &tanks[..2], &[powr]), "undefended structures are attacked");
}

// ---- Base builder -----------------------------------------------------------------

/// Low power first (BaseBuilderQueueManager priority override).
#[test]
fn base_builder_fixes_low_power_first() {
    let mut w = arena(64, &[("england", normal(), 0, (4, 4)), ("russia", None, 0, (52, 52))]);
    put(&mut w, "DOME", 0, 10, 4);
    w.refresh_tokens();
    w.update_power();
    assert!(w.players[0].power_use > w.players[0].power_gen, "low power to start with");
    let mut first = None;
    for _ in 0..25 * 30 {
        w.step();
        if let Some(it) = w.players[0].queues[crate::rules::QueueType::Building as usize].items.first() {
            first = Some(w.rules.actors[it.ty as usize].id.clone());
            break;
        }
    }
    let first = first.expect("a structure was queued");
    assert!(first == "POWR" || first == "APWR", "a power plant first, not {first}");
}

/// Personalities: the Turtle AI keeps one barracks and one war factory and
/// builds far more defences than the Rush AI, which adds factories when rich.
#[test]
fn turtle_walls_in_and_rush_builds_factories() {
    let run_bot = |bot: BotType| {
        let mut w = arena(64, &[("england", Some((bot, AiDifficulty::Normal)), 0, (4, 4)), ("russia", None, 0, (52, 52))]);
        w.ai[0].passive = true;
        ore(&mut w, 4, 24, 12, 30);
        run(&mut w, 25 * 60 * 12);
        w
    };
    let (turtle, rush) = (run_bot(BotType::Turtle), run_bot(BotType::Rush));
    let defenses = |w: &World| {
        w.actors.iter().filter(|a| a.alive && a.owner == 0 && a.kind == Kind::Building && w.rules.actors[a.ty as usize].defense).count()
    };
    assert!(count(&turtle, 0, "TENT") <= 1 && count(&turtle, 0, "WEAP") <= 1, "turtle BuildingLimits");
    assert!(defenses(&turtle) > defenses(&rush), "turtle {} defences, rush {}", defenses(&turtle), defenses(&rush));
    assert!(count(&rush, 0, "TENT") + count(&rush, 0, "WEAP") >= 3, "rush adds factories when rich");
    for w in [&turtle, &rush] {
        assert!(count(w, 0, "TENT") <= 7 && count(w, 0, "WEAP") <= 4 && count(w, 0, "DOME") <= 1, "BuildingLimits");
    }
}

// ---- Unit builder -----------------------------------------------------------------

/// UnitsToBuild and UnitLimits: only listed units (and what other modules
/// ask for: ore trucks, MCVs), never more than the limits.
#[test]
fn unit_builder_builds_listed_units_within_limits() {
    let mut w = arena(64, &[("russia", normal(), 0, (4, 4)), ("england", None, 0, (52, 52))]);
    complete_base(&mut w, 0);
    put(&mut w, "KENN", 0, 20, 10);
    w.refresh_tokens();
    w.ai[0].passive = true;
    run(&mut w, 25 * 60 * 8);
    let cfg = w.ai[0].cfg.clone();
    let units = army(&w, 0);
    assert!(units.len() >= 20, "an army: {units:?}");
    for id in &units {
        let t = ty(&w, id);
        let requested = cfg.harvesters.contains(&t) || cfg.mcvs.contains(&t);
        assert!(requested || BotConfig::lookup(&cfg.units_to_build, t).is_some(), "{id} is not in UnitsToBuild");
    }
    for (id, limit) in [("DOG", 4), ("FTRK", 4)] {
        assert!(count(&w, 0, id) <= limit, "{id}: {} over the limit", count(&w, 0, id));
    }
}

// ---- Squads -----------------------------------------------------------------------

/// Units around the base leave as an assault squad once there are
/// SquadSize plus the random bonus of them, and go for the enemy.
#[test]
fn units_at_the_base_leave_as_an_assault_squad() {
    let mut w = arena(64, &[("russia", Some((BotType::Rush, AiDifficulty::Normal)), 0, (4, 4)), ("england", None, 0, (52, 52))]);
    for k in 0..52 {
        w.spawn_unit(ty(&w, "3TNK"), 0, cell_center(10 + k % 8), cell_center(14 + k / 8), 512);
    }
    let enemy = crate::ai::base_point(&w, 1);
    let mut left = false;
    for _ in 0..25 * 60 {
        w.step();
        let squad = crate::ai_squads::squad_units(&w, 0, crate::ai_squads::SquadType::Assault).len()
            + crate::ai_squads::squad_units(&w, 0, crate::ai_squads::SquadType::Rush).len();
        let near = w.actors.iter().filter(|a| a.alive && a.owner == 0 && dist(a.x, a.y, enemy.0, enemy.1) < 20 * CELL).count();
        if squad >= 20 && near >= 10 {
            left = true;
            break;
        }
    }
    assert!(left, "a squad of 20 or more drove to the enemy base");
}

/// An attack on the base calls the units around it into a protection squad.
#[test]
fn a_protection_squad_answers_attacks_on_the_base() {
    let mut w = arena(64, &[("russia", normal(), 0, (4, 4)), ("england", None, 0, (52, 52))]);
    w.ai[0].passive = true;
    let tanks: Vec<usize> = (0..5).map(|k| w.spawn_unit(ty(&w, "3TNK"), 0, cell_center(12 + k), cell_center(12), 512)).collect();
    run(&mut w, 60);
    let foe = w.spawn_unit(ty(&w, "1TNK"), 1, cell_center(9), cell_center(9), 512);
    let yard = (0..w.actors.len()).find(|&i| w.actors[i].alive && w.actors[i].owner == 0 && w.actors[i].kind == Kind::Building).unwrap();
    // The tank shoots at the Construction Yard.
    w.observer.source = Some(1);
    let src = w.make_ref(foe);
    w.damage_from(yard, 100, src, 0);
    w.observer.source = None;
    let hp = w.actors[foe].hp;
    let mut answered = false;
    for _ in 0..25 * 20 {
        w.step();
        let squad = crate::ai_squads::squad_units(&w, 0, crate::ai_squads::SquadType::Protection);
        if !squad.is_empty() && (!w.actors[foe].alive || w.actors[foe].hp < hp) {
            answered = true;
            break;
        }
    }
    assert!(answered, "the tanks at the base turned on the attacker");
}

/// An air squad strikes where it meets little anti-air and leaves targets
/// under heavy anti-air alone.
#[test]
fn air_squads_avoid_targets_under_heavy_anti_air() {
    let mut w = arena(64, &[("england", normal(), 0, (4, 4)), ("russia", None, 0, (52, 52))]);
    w.ai[0].passive = true;
    let heli = w.spawn_unit(ty(&w, "MH60"), 0, cell_center(8), cell_center(8), 512);
    let guarded = quiet_unit(&mut w, "3TNK", 1, 44, 8);
    for (x, y) in [(43, 9), (45, 9), (44, 10)] {
        quiet_unit(&mut w, "FTRK", 1, x, y);
    }
    let open = quiet_unit(&mut w, "3TNK", 1, 8, 44);
    // Spotters so the AI sees both.
    quiet_unit(&mut w, "E1", 0, 44, 13);
    quiet_unit(&mut w, "E1", 0, 8, 40);
    let mut target = None;
    for _ in 0..25 * 90 {
        w.step();
        if w.actors[heli].activity == Activity::Attack {
            target = w.resolve(w.actors[heli].target);
            break;
        }
    }
    assert!(target.is_some() && target != Some(guarded), "the helicopter strikes away from the anti-air: {target:?} (open tank {open})");
}

/// Ships form a naval squad that hunts what it can reach on the water.
#[test]
fn naval_squads_hunt_enemy_ships() {
    let mut w = arena(64, &[("russia", Some((BotType::Naval, AiDifficulty::Normal)), 0, (4, 4)), ("england", None, 0, (52, 4))]);
    w.ai[0].passive = true;
    flood(&mut w, 0, 19, 63, 63);
    let sub = w.spawn_unit(ty(&w, "SS"), 0, cell_center(10), cell_center(24), 512);
    let boat = quiet_unit(&mut w, "PT", 1, 24, 22);
    w.add_reveal(0, cell_center(24), cell_center(22), 4 * CELL, 25 * 30);
    w.players[0].explored.iter_mut().for_each(|e| *e = 1);
    let mut hunted = false;
    for _ in 0..25 * 30 {
        w.step();
        if !w.actors[boat].alive || (w.actors[sub].activity == Activity::Attack && w.resolve(w.actors[sub].target) == Some(boat)) {
            hunted = true;
            break;
        }
    }
    assert!(hunted, "the submarine attacks the gunboat");
    assert_eq!(crate::ai_squads::squad_units(&w, 0, crate::ai_squads::SquadType::Naval), vec![sub]);
}

// ---- Ore trucks -----------------------------------------------------------------------

/// Lost ore trucks are rebuilt (InitialHarvesters), and a truck under fire
/// drives home to its refinery.
#[test]
fn ore_trucks_are_rebuilt_and_run_home_under_fire() {
    let mut w = arena(64, &[("england", normal(), 0, (4, 4)), ("russia", None, 0, (52, 52))]);
    complete_base(&mut w, 0);
    ore(&mut w, 30, 30, 36, 36);
    w.ai[0].passive = true;
    run(&mut w, 25 * 60 * 2);
    let trucks = crate::ai_harvest::trucks(&w, 0);
    assert!(trucks.len() >= 4, "InitialHarvesters 4: {}", trucks.len());
    // Lose all of them: new ones come.
    for &t in &trucks {
        w.actors[t].hp = 1;
        w.damage(t, 10);
    }
    run(&mut w, 25 * 60 * 2);
    assert!(crate::ai_harvest::trucks(&w, 0).len() >= 2, "trucks rebuilt");
    // A truck at the ore field comes under fire: home it goes.
    let truck = crate::ai_harvest::trucks(&w, 0)[0];
    let (tx, ty_) = (w.actors[truck].x, w.actors[truck].y);
    let foe = w.spawn_unit(ty(&w, "1TNK"), 1, tx + 3 * CELL, ty_, 512);
    w.order_attack(&[foe], truck, false);
    let mut home = false;
    for _ in 0..25 * 10 {
        w.step();
        if !w.actors[truck].alive {
            break;
        }
        if w.actors[truck].harv == crate::world::HarvState::ToDock || w.actors[truck].harv == crate::world::HarvState::Unloading {
            home = true;
            break;
        }
    }
    assert!(home, "the truck under fire heads for its refinery");
}

/// Waiting ore trucks go to the nearest ore whose path stays clear of
/// enemies, even where nobody has looked yet.
#[test]
fn idle_ore_trucks_find_ore_away_from_enemies() {
    let mut w = arena(64, &[("england", normal(), 0, (4, 4)), ("russia", None, 0, (52, 52))]);
    complete_base(&mut w, 0);
    w.ai[0].passive = true;
    // Two fields at the same distance from the base; enemies guard one.
    ore(&mut w, 4, 34, 7, 37);
    ore(&mut w, 34, 4, 37, 7);
    for k in 0..4 {
        quiet_unit(&mut w, "3TNK", 1, 4 + k, 31);
    }
    let truck = w.spawn_unit(ty(&w, "HARV"), 0, cell_center(10), cell_center(10), 512);
    w.actors[truck].activity = Activity::Idle;
    assert_eq!(w.players[0].explored[w.map.idx(35, 5)], 0, "not explored");
    run(&mut w, 25 * 20);
    let a = &w.actors[truck];
    let goal = if a.harv_cell == crate::world::NONE { a.goal } else { a.harv_cell };
    let (gx, gy) = (goal as i32 % w.map.width, goal as i32 / w.map.width);
    assert!(gx >= 30 && gy <= 10, "the truck heads for the unguarded field: {gx},{gy}");
}

// ---- Upkeep -------------------------------------------------------------------------

/// A structure hit below three quarters of its health gets repaired.
#[test]
fn damaged_structures_are_repaired() {
    let mut w = arena(64, &[("england", normal(), 0, (4, 4)), ("russia", None, 0, (52, 52))]);
    complete_base(&mut w, 0);
    w.ai[0].passive = true;
    let dome = (0..w.actors.len()).find(|&i| w.actors[i].alive && w.actors[i].owner == 0 && w.actors[i].ty == ty(&w, "DOME")).unwrap();
    let foe = w.spawn_unit(ty(&w, "2TNK"), 1, cell_center(30), cell_center(30), 512);
    run(&mut w, 200);
    let max = w.rules.actors[w.actors[dome].ty as usize].hp;
    let hit = max - max * 7 / 10;
    w.observer.source = Some(1);
    let src = w.make_ref(foe);
    w.damage_from(dome, hit, src, 0);
    w.observer.source = None;
    run(&mut w, 5);
    assert!(w.actors[dome].repairers.contains(&0), "the radar dome is being repaired");
}

/// Short of power, the bot switches off power hungry structures, and on
/// again once there is power to spare.
#[test]
fn low_power_switches_structures_off_and_on_again() {
    let mut w = arena(64, &[("russia", normal(), 0, (4, 4)), ("england", None, 0, (52, 52))]);
    w.ai[0].passive = true;
    let plant = put(&mut w, "POWR", 0, 10, 4);
    for (id, x, y) in [("DOME", 14, 4), ("TSLA", 18, 4), ("TSLA", 20, 4)] {
        put(&mut w, id, 0, x, y);
    }
    w.refresh_tokens();
    w.update_power();
    assert!(w.players[0].power_use > w.players[0].power_gen, "short of power");
    // No money: the base builder cannot just build more power.
    w.players[0].cash = 0;
    run(&mut w, 25 * 15);
    let off: Vec<String> =
        w.actors.iter().filter(|a| a.alive && a.owner == 0 && a.powered_off).map(|a| w.rules.actors[a.ty as usize].id.clone()).collect();
    assert!(!off.is_empty(), "something switched off");
    assert!(
        w.players[0].power_gen >= w.players[0].power_use,
        "enough power again: {} / {}",
        w.players[0].power_use,
        w.players[0].power_gen
    );
    // Plenty of power again: everything comes back on.
    for x in [24, 28, 32] {
        put(&mut w, "APWR", 0, x, 4);
    }
    w.update_power();
    run(&mut w, 25 * 15);
    assert!(w.actors.iter().all(|a| !(a.alive && a.owner == 0 && a.powered_off)), "back on");
    assert!(w.actors[plant].alive);
}

// ---- MCVs and expansion ---------------------------------------------------------------

/// MinimumConstructionYardCount 2: a rich bot with a war factory builds a
/// second MCV and deploys it by ore away from its first yard.
#[test]
fn a_second_mcv_expands_to_another_ore_field() {
    let mut w = arena(80, &[("england", normal(), 0, (4, 4)), ("russia", None, 0, (70, 70))]);
    complete_base(&mut w, 0);
    w.ai[0].passive = true;
    ore(&mut w, 4, 26, 9, 30);
    ore(&mut w, 30, 6, 35, 11);
    w.players[0].explored.iter_mut().for_each(|e| *e = 1);
    let first = (w.players[0].start.0, w.players[0].start.1);
    let mut expanded = None;
    for _ in 0..25 * 60 * 6 {
        w.step();
        let yards: Vec<(i32, i32)> = w
            .actors
            .iter()
            .filter(|a| a.alive && a.owner == 0 && a.ty == ty(&w, "FACT"))
            .map(|a| (a.cx, a.cy))
            .filter(|&c| c != first)
            .collect();
        if let Some(&c) = yards.first() {
            expanded = Some(c);
            break;
        }
    }
    let c = expanded.expect("a second Construction Yard");
    let d = (c.0 - first.0).pow(2) + (c.1 - first.1).pow(2);
    assert!(d >= 8 * 8, "away from the first yard: {c:?}");
    assert_eq!(crate::ai_mcv::yards_and_mcvs(&w, 0).0, 2);
}

/// The Naval AI's McvManager deploys its starting MCV where it stands.
#[test]
fn bots_deploy_their_starting_mcv() {
    for bot in BotType::ALL {
        let players = [PlayerSetup { bot, ..PlayerSetup::new("england", Some(AiDifficulty::Normal)) }, PlayerSetup::new("russia", None)];
        let options = GameOptions { starting_units: crate::world::StartingUnits::Mcv, ..GameOptions::default() };
        let mut w = World::with_options(7, 64, &players, options);
        run(&mut w, 25 * 20);
        assert!(count(&w, 0, "FACT") >= 1, "{bot:?} deployed its MCV");
    }
}

// ---- Support powers -----------------------------------------------------------------

fn make_ready(w: &mut World, player: u8, kind: &str) {
    let keys: Vec<String> = w.power_instances(player).iter().filter(|p| w.power_info(p).kind == kind).map(|p| p.key.clone()).collect();
    for key in keys {
        w.powers.players[player as usize].iter_mut().find(|p| p.key == key).unwrap().remaining = 0;
    }
}

fn fired(w: &World, player: u8, kind: &str) -> bool {
    w.power_instances(player).iter().any(|p| w.power_info(p).kind == kind && p.remaining > p.total - 60)
}

/// SupportPowerBotModule decisions: the nuke at valuable enemy structures
/// (MinimumAttractiveness 3000, never near own units), paratroopers onto
/// enemy structures away from water.
#[test]
fn support_power_decisions_pick_their_targets() {
    let mut w = arena(64, &[("russia", normal(), 0, (4, 4)), ("england", None, 0, (44, 44))]);
    w.ai[0].passive = true;
    complete_base(&mut w, 0);
    complete_base(&mut w, 1);
    put(&mut w, "MSLO", 0, 20, 4);
    put(&mut w, "AFLD", 0, 20, 10);
    w.refresh_tokens();
    w.update_power();
    // The bot saw the enemy base once (frozen structures).
    w.add_reveal(0, cell_center(52), cell_center(50), 14 * CELL, 50);
    run(&mut w, 30);
    make_ready(&mut w, 0, "NukePower");
    make_ready(&mut w, 0, "ParatroopersPower");
    run(&mut w, 40);
    assert!(fired(&w, 0, "NukePower"), "the nuke launched");
    let nuke = w.abil.nukes.first().expect("a missile in flight");
    let enemy = crate::ai::base_point(&w, 1);
    assert!(dist(nuke.x, nuke.y, enemy.0, enemy.1) < 16 * CELL, "at the enemy base");
    for a in w.actors.iter().filter(|a| a.alive && a.owner == 0 && a.kind != Kind::Building) {
        assert!(dist(a.x, a.y, nuke.x, nuke.y) > 7 * CELL, "far from own units");
    }
    assert!(fired(&w, 0, "ParatroopersPower"), "the paratroopers flew");
}

/// WebRA additions (not on Easy): the Iron Curtain on the army in a fight,
/// the Chronosphere to jump idle vehicles into the enemy base.
#[test]
fn iron_curtain_and_chronosphere_on_normal_but_not_easy() {
    for diff in [AiDifficulty::Normal, AiDifficulty::Easy] {
        let mut w = arena(64, &[("russia", Some((BotType::Normal, diff)), 0, (4, 4)), ("england", None, 0, (48, 48))]);
        w.ai[0].passive = true;
        complete_base(&mut w, 0);
        complete_base(&mut w, 1);
        put(&mut w, "IRON", 0, 20, 4);
        w.refresh_tokens();
        w.update_power();
        let tanks: Vec<usize> =
            (0..4).map(|k| w.spawn_unit(ty(&w, "3TNK"), 0, cell_center(28 + k % 2), cell_center(28 + k / 2), 256)).collect();
        let foes: Vec<usize> = (0..3).map(|k| quiet_unit(&mut w, "2TNK", 1, 32, 27 + k)).collect();
        w.order_attack(&tanks, foes[1], false);
        run(&mut w, 2);
        make_ready(&mut w, 0, "GrantExternalConditionPower");
        for _ in 0..30 {
            for &t in &tanks {
                if w.actors[t].alive && w.actors[t].activity != Activity::Attack {
                    w.order_attack(&[t], foes[1], false);
                }
            }
            w.step();
        }
        let shielded = tanks.iter().filter(|&&t| w.actors[t].invulnerable_until > w.tick).count();
        assert_eq!(fired(&w, 0, "GrantExternalConditionPower"), diff == AiDifficulty::Normal, "{diff:?}: Iron Curtain");
        if diff == AiDifficulty::Normal {
            assert!(shielded >= 3, "on the fighting army: {shielded} tanks invulnerable");
        }
    }
    let mut w = arena(64, &[("england", normal(), 0, (4, 4)), ("russia", None, 0, (48, 48))]);
    w.ai[0].passive = true;
    complete_base(&mut w, 0);
    complete_base(&mut w, 1);
    put(&mut w, "PDOX", 0, 20, 4);
    w.refresh_tokens();
    w.update_power();
    w.players[0].explored.iter_mut().for_each(|e| *e = 1);
    let tanks: Vec<usize> =
        (0..4).map(|k| w.spawn_unit(ty(&w, "1TNK"), 0, cell_center(12 + k % 2), cell_center(18 + k / 2), 512)).collect();
    run(&mut w, 2);
    make_ready(&mut w, 0, "ChronoshiftPower");
    run(&mut w, 30);
    assert!(fired(&w, 0, "ChronoshiftPower"), "the Chronosphere fired");
    let enemy = crate::ai::base_point(&w, 1);
    let shifted = tanks.iter().filter(|&&t| w.actors[t].alive && dist(w.actors[t].x, w.actors[t].y, enemy.0, enemy.1) < 16 * CELL).count();
    assert!(shifted >= 3, "tanks jumped into the enemy base: {shifted}");
}

/// The Sonar Pulse goes where an unseen attacker hit a ship.
#[test]
fn sonar_pulse_finds_the_unseen_attacker() {
    let mut w = arena(64, &[("england", normal(), 0, (4, 4)), ("russia", None, 0, (52, 4))]);
    w.ai[0].passive = true;
    flood(&mut w, 0, 19, 63, 63);
    w.players[0].explored.iter_mut().for_each(|e| *e = 1);
    let sonar = ty(&w, "powerproxy.sonarpulse");
    w.players[0].proxies.push(sonar);
    w.refresh_tokens();
    let ship = w.spawn_unit(ty(&w, "DD"), 0, cell_center(20), cell_center(30), 512);
    let sub = w.spawn_unit(ty(&w, "SS"), 1, cell_center(26), cell_center(34), 512);
    run(&mut w, 40);
    w.actors[sub].submerged = true;
    w.update_vision();
    assert!(!w.is_visible_to(sub, 0), "the submarine is hidden");
    make_ready(&mut w, 0, "SpawnActorPower");
    w.observer.source = Some(1);
    let src = w.make_ref(sub);
    w.damage_from(ship, 10, src, 0);
    w.observer.source = None;
    run(&mut w, 10);
    assert!(fired(&w, 0, "SpawnActorPower"), "the Sonar Pulse fired");
}

// ---- Capturing and mines ---------------------------------------------------------------

/// Engineers for a neutral structure in reach: trained and sent to capture it.
#[test]
fn bots_train_engineers_for_neutral_structures_and_capture_them() {
    let mut w = arena(64, &[("england", normal(), 0, (4, 4)), ("russia", None, 0, (52, 52)), ("allies", None, 0, (0, 0))]);
    w.players[2].neutral = true;
    w.ai[0].passive = true;
    complete_base(&mut w, 0);
    let target = put(&mut w, "POWR", 2, 26, 8);
    w.players[0].explored.iter_mut().for_each(|e| *e = 1);
    quiet_unit(&mut w, "E1", 0, 26, 13);
    let mut captured = false;
    // The neutral seat's own yard at (0, 0) is in reach too: both are taken.
    for _ in 0..25 * 60 * 6 {
        w.step();
        if w.actors[target].alive && w.actors[target].owner == 0 {
            captured = true;
            break;
        }
    }
    assert!(captured, "the neutral power plant was captured");
    assert!(count(&w, 0, "FACT") >= 2, "and the neutral Construction Yard: {}", count(&w, 0, "FACT"));
    let value = crate::ai_infantry::capture_value(&w, target);
    assert!(value > w.rules.actors[w.actors[target].ty as usize].building.as_ref().unwrap().value as i64, "power counts as a benefit");
}

/// The Turtle AI's Minelayers mine the way to the enemy.
#[test]
fn turtle_minelayers_lay_mines() {
    let mut w = arena(64, &[("england", Some((BotType::Turtle, AiDifficulty::Normal)), 0, (4, 4)), ("russia", None, 0, (52, 52))]);
    w.ai[0].passive = true;
    let layer = w.spawn_unit(ty(&w, "MNLY"), 0, cell_center(12), cell_center(12), 512);
    quiet_unit(&mut w, "1TNK", 1, 44, 44);
    run(&mut w, 25 * 60 * 2);
    let mines = w.actors.iter().filter(|a| a.alive && a.owner == 0 && a.kind == Kind::Mine).count();
    assert!(mines >= 3, "mines laid: {mines}");
    assert!(w.actors[layer].alive);
}

// ---- Allies -----------------------------------------------------------------------

#[test]
fn ai_never_bombs_or_attacks_allies() {
    // AI 0 and human 1 against human 2; 1's tanks sit in 2's base.
    let mut w = arena(
        64,
        &[("russia", Some((BotType::Normal, AiDifficulty::Hard)), 1, (4, 4)), ("england", None, 1, (4, 48)), ("france", None, 2, (48, 48))],
    );
    complete_base(&mut w, 0);
    complete_base(&mut w, 2);
    put(&mut w, "MSLO", 0, 20, 4);
    w.refresh_tokens();
    w.update_power();
    let (ex, ey) = w.players[2].start;
    for k in 0..12 {
        quiet_unit(&mut w, "1TNK", 1, ex + (k % 6) * 3, ey + 4 + (k / 6) * 4);
    }
    w.players[0].explored.iter_mut().for_each(|e| *e = 1);
    run(&mut w, 2);
    make_ready(&mut w, 0, "NukePower");
    for t in 0..25 * 60 * 3 {
        w.step();
        for n in &w.abil.nukes {
            assert!(crate::ai_support::safe_to_bomb(&w, 0, n.x, n.y, 7 * CELL), "tick {t}: the nuke would hit the ally");
        }
        for a in w.actors.iter().filter(|a| a.alive && a.owner == 0 && a.activity == Activity::Attack) {
            if let Some(v) = w.resolve(a.target) {
                assert!(w.are_enemies(0, w.actors[v].owner), "tick {t}: an AI unit attacks its ally");
            }
        }
    }
}

// ---- Whole games ------------------------------------------------------------------

fn play(seed: u64, size: i32, teams: &[u8], diff: AiDifficulty, limit_minutes: u32) -> (Option<u8>, World) {
    let factions = ["england", "russia", "germany", "ukraine", "france", "soviet", "allies", "russia"];
    let players: Vec<PlayerSetup> = teams
        .iter()
        .enumerate()
        .map(|(k, &team)| PlayerSetup { faction: factions[k % 8].into(), ai: Some(diff), bot: Default::default(), team, handicap: 0 })
        .collect();
    let mut w = World::with_options(seed, size, &players, GameOptions::default());
    for _ in 0..25 * 60 * limit_minutes {
        w.step();
        if w.winner.is_some() {
            break;
        }
    }
    (w.winner, w)
}

/// OpenRA's bots gather larger squads than WebRA's old waves (Normal AI:
/// SquadSize 40), so a four player game takes longer: measured 27 to 49
/// minutes on these seeds (Easy reacts at half the speed).
#[test]
fn four_player_ai_free_for_all_finishes_within_an_hour() {
    let games: Vec<(u64, AiDifficulty)> = vec![(1, AiDifficulty::Normal), (2, AiDifficulty::Hard), (3, AiDifficulty::Easy)];
    let results: Vec<(u64, Option<u8>, u32)> = std::thread::scope(|s| {
        let handles: Vec<_> = games
            .iter()
            .map(|&(seed, diff)| {
                s.spawn(move || {
                    let (winner, w) = play(seed, 96, &[0, 0, 0, 0], diff, 60);
                    (seed, winner, w.tick)
                })
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });
    for (seed, winner, ticks) in results {
        assert!(winner.is_some(), "seed {seed}: no winner after {} minutes", ticks / 1500);
    }
}

/// Identical AIs on generated maps: no spawn wins most free for alls, and
/// in a 2v2 of mirrored teams neither team wins (nearly) all games.
#[test]
fn generated_maps_are_fair_for_four_players() {
    const SEEDS: u64 = 8;
    let run_all = |teams: [u8; 4]| -> Vec<Option<u8>> {
        std::thread::scope(|s| {
            let handles: Vec<_> = (0..SEEDS)
                .map(|seed| {
                    s.spawn(move || {
                        let players: Vec<PlayerSetup> = teams
                            .iter()
                            .map(|&team| PlayerSetup {
                                faction: "allies".into(),
                                ai: Some(AiDifficulty::Normal),
                                bot: Default::default(),
                                team,
                                handicap: 0,
                            })
                            .collect();
                        let mut w = World::with_options(seed, 96, &players, GameOptions::default());
                        for _ in 0..25 * 60 * 40 {
                            w.step();
                            if w.winner.is_some() {
                                break;
                            }
                        }
                        w.winner
                    })
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        })
    };
    let ffa = run_all([0, 0, 0, 0]);
    let mut wins = [0u32; 4];
    for w in ffa.iter().flatten() {
        wins[*w as usize] += 1;
    }
    assert!(wins.iter().all(|&n| n <= 5), "free for all wins per slot over {SEEDS} seeds: {wins:?}");
    assert!(ffa.iter().filter(|w| w.is_some()).count() as u64 >= SEEDS - 1, "free for alls finish: {ffa:?}");
    // Slots 0 and 1 (left column) against 2 and 3 (right column): mirror images.
    let teams = run_all([1, 1, 2, 2]);
    let left = teams.iter().filter(|w| w.is_some_and(|p| p < 2)).count();
    let right = teams.iter().filter(|w| w.is_some_and(|p| p >= 2)).count();
    assert!(left <= 7 && right <= 7, "2v2 wins left {left}, right {right}");
}

#[test]
fn hard_ai_games_stay_deterministic() {
    let setup = || [PlayerSetup::new("russia", Some(AiDifficulty::Hard)), PlayerSetup::new("england", Some(AiDifficulty::Hard))];
    let mut a = World::with_options(5, 96, &setup(), GameOptions::default());
    let mut b = World::with_options(5, 96, &setup(), GameOptions::default());
    for t in 0..25 * 60 * 8 {
        a.step();
        b.step();
        if t % 1500 == 0 {
            assert_eq!(a.state_hash(), b.state_hash(), "tick {t}");
        }
    }
    assert_eq!(a.state_hash(), b.state_hash());
}

// ---- Running dry (ai_economy.rs) --------------------------------------------------

/// No ore anywhere and no money: the AI sells what it can do without (tech,
/// radar, depot, spare power) for an army, but keeps its Construction Yard,
/// factories, enough power and its defences.
#[test]
fn a_broke_ai_without_income_sells_its_surplus_for_an_army() {
    let mut w = arena(64, &[("england", normal(), 0, (4, 4)), ("russia", None, 0, (40, 44))]);
    complete_base(&mut w, 0);
    put(&mut w, "PBOX", 0, 20, 20);
    w.players[0].cash = 0;
    let buildings = |w: &World| -> Vec<usize> {
        (0..w.actors.len()).filter(|&i| w.actors[i].alive && w.actors[i].owner == 0 && w.actors[i].kind == Kind::Building).collect()
    };
    let before = buildings(&w);
    // The order structures go in.
    let mut sold: Vec<String> = Vec::new();
    let mut standing = before.clone();
    for _ in 0..25 * 120 {
        w.step();
        let now = buildings(&w);
        for &b in standing.iter().filter(|b| !now.contains(b)) {
            sold.push(w.rules.actors[w.actors[b].ty as usize].id.clone());
        }
        standing = now;
    }
    let left: Vec<String> = standing.iter().map(|&b| w.rules.actors[w.actors[b].ty as usize].id.clone()).collect();
    assert!(left.len() < before.len(), "sold something: {left:?}");
    for keep in ["FACT", "TENT", "WEAP", "PBOX"] {
        assert!(left.iter().any(|id| id == keep), "kept {keep}: {left:?}");
    }
    // Refineries without ore go first; it stops once it has its army (the
    // crew of a sold structure counts, sell.rs).
    assert_eq!(sold.first().map(|s| s.as_str()), Some("PROC"), "useless refineries go first: {sold:?}");
    assert!(sold.len() <= 4, "it stops once it has an army: {sold:?}");
    let p = &w.players[0];
    assert!(p.power_gen >= p.power_use, "still enough power: {} / {}", p.power_use, p.power_gen);
    let army = w
        .actors
        .iter()
        .filter(|a| a.alive && a.owner == 0 && a.kind != Kind::Building && !w.rules.actors[a.ty as usize].weapons.is_empty())
        .count();
    assert!(army >= 4, "the money went into an army: {army}");
}

/// With money and ore it sells nothing.
#[test]
fn an_ai_with_income_keeps_its_base() {
    let mut w = arena(64, &[("england", normal(), 0, (4, 4)), ("russia", None, 0, (40, 44))]);
    complete_base(&mut w, 0);
    for y in 30..36 {
        for x in 4..12 {
            let i = w.map.idx(x, y);
            w.map.ore[i] = 10;
        }
    }
    w.players[0].cash = 0;
    let before = w.actors.iter().filter(|a| a.alive && a.owner == 0 && a.kind == Kind::Building).count();
    run(&mut w, 25 * 60);
    let after = w.actors.iter().filter(|a| a.alive && a.owner == 0 && a.kind == Kind::Building).count();
    assert!(after >= before, "nothing sold: {before} -> {after}");
}

// ---- Target choice in free for alls -------------------------------------------------

/// Eight players on a ring (seed and map of the reported game), seven AIs and
/// a human in slot 0 who stays the weakest (no army at all, while every AI
/// gets tanks; they stay at home): the AIs pick their targets in their usual order, and at most
/// one of the human's two neighbours goes for it, through the opening and
/// across retargets. Before, every AI took the weakest of its two equally
/// near neighbours, so both of the human's neighbours attacked it.
#[test]
fn weakest_player_on_a_ring_is_attacked_by_at_most_one_neighbour() {
    for seed in [1706698519, 11, 22] {
        let players: Vec<PlayerSetup> = (0..8)
            .map(|k| PlayerSetup {
                faction: "allies".into(),
                ai: (k != 0).then_some(AiDifficulty::Normal),
                bot: Default::default(),
                team: 0,
                handicap: 0,
            })
            .collect();
        let mut w = World::with_options(seed, 96, &players, GameOptions::default());
        for p in 1..8u8 {
            // Target choice only: the AIs keep their armies at home, so no
            // base falls and no grudge decides this early.
            w.ai[p as usize].passive = true;
            let (sx, sy) = w.players[p as usize].start;
            for k in 0..4 {
                w.spawn_unit(ty(&w, "2TNK"), p, cell_center(sx - 1 + k), cell_center(sy + 6), 512);
            }
        }
        // Slot 0's two neighbours: the bases nearest to its yard.
        let yard = |p: usize| (w.players[p].start.0 + 1, w.players[p].start.1 + 2);
        let d = |p: usize| dist(yard(0).0, yard(0).1, yard(p).0, yard(p).1);
        let mut by_distance: Vec<usize> = (1..8).collect();
        by_distance.sort_by_key(|&p| d(p));
        let neighbours = [by_distance[0] as u8, by_distance[1] as u8];
        let mut picked = false;
        for t in 0..25 * 60 * 4 {
            w.step();
            if t % 25 != 0 {
                continue;
            }
            let on_human: Vec<u8> = (1..8u8).filter(|&p| w.ai[p as usize].target_player == Some(0)).collect();
            assert!(on_human.len() <= 1, "seed {seed}, tick {t}: AIs {on_human:?} all attack the weakest player");
            assert!(on_human.iter().all(|p| neighbours.contains(p)), "seed {seed}: only a neighbour attacks slot 0, not {on_human:?}");
            picked |= !on_human.is_empty();
        }
        assert!(picked || (1..8).all(|p| w.ai[p].target_player.is_some()), "seed {seed}: the AIs chose targets");
    }
}

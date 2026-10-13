//! Lobby options (gamerules.rs): spawn assignment, starting units, short game
//! and OwnerLostAction, the time limit, kill bounties, handicaps, player
//! experience, ally build radius and the options' parsing.

use crate::gamerules::{assign_spawns, spawn_pick_problem};
use crate::map::{Map, Terrain};
use crate::rules::{Kind, Rules};
use crate::sound_events::{SoundEventKind, EVENT_STRIDE};
use crate::world::{cell_center, AiDifficulty, GameOptions, PlayerSetup, StartingUnits, World};

fn ty(w: &World, id: &str) -> u16 {
    w.rules.actor_index(id).unwrap() as u16
}

fn run(w: &mut World, ticks: u32) {
    for _ in 0..ticks {
        w.step();
    }
}

fn unit(w: &mut World, id: &str, owner: u8, cx: i32, cy: i32) -> usize {
    let t = ty(w, id);
    w.spawn_unit(t, owner, cell_center(cx), cell_center(cy), 0)
}

fn setup(faction: &str, team: u8) -> PlayerSetup {
    PlayerSetup { faction: faction.into(), ai: None, bot: Default::default(), team, handicap: 0, spawn: None }
}

/// An open 48 by 48 map, spawns in the corners, players without a base.
fn open_map() -> Map {
    let (w, h) = (48, 48);
    Map {
        width: w,
        height: h,
        terrain: vec![Terrain::Clear; (w * h) as usize],
        ore: vec![0; (w * h) as usize],
        gems: vec![0; (w * h) as usize],
        spawns: vec![(4, 4), (40, 40), (40, 4), (4, 40)],
    }
}

fn world(players: &[PlayerSetup], options: GameOptions) -> World {
    World::on_map(9, open_map(), players, options)
}

fn events(w: &mut World, kind: SoundEventKind) -> Vec<[i32; EVENT_STRIDE]> {
    w.sound.take().chunks(EVENT_STRIDE).filter(|e| e[0] == kind as i32).map(|e| <[i32; EVENT_STRIDE]>::try_from(e).unwrap()).collect()
}

// ---- Spawns -----------------------------------------------------------------------------

#[test]
fn spawns_follow_the_slots_without_teams_or_without_the_option() {
    let spawns = [(4, 4), (40, 40), (40, 4), (4, 40)];
    let ffa = [setup("england", 0), setup("russia", 0), setup("france", 0), setup("ukraine", 0)];
    assert_eq!(assign_spawns(&spawns, &ffa, true, false), vec![0, 1, 2, 3], "free for all: each slot its spawn");
    let teams = [setup("england", 1), setup("russia", 1), setup("france", 2), setup("ukraine", 2)];
    assert_eq!(assign_spawns(&spawns, &teams, false, false), vec![0, 1, 2, 3], "option off");
}

/// The cases packages/protocol's `assignSpawns` runs too (the lobby markers).
#[test]
fn spawn_assignment_matches_the_protocol_package() {
    let cases: serde_json::Value = serde_json::from_str(include_str!("../../packages/protocol/test/fixtures/spawn-cases.json")).unwrap();
    for c in cases["cases"].as_array().unwrap() {
        let spawns: Vec<(i32, i32)> =
            c["spawns"].as_array().unwrap().iter().map(|p| (p[0].as_i64().unwrap() as i32, p[1].as_i64().unwrap() as i32)).collect();
        let picks = |k: usize| c.get("picks").and_then(|p| p[k].as_u64()).map(|s| s as u8);
        let players: Vec<PlayerSetup> = c["teams"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
            .map(|(k, t)| PlayerSetup { spawn: picks(k), ..setup("england", t.as_u64().unwrap() as u8) })
            .collect();
        let want: Vec<usize> = c["want"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap() as usize).collect();
        let generated = c["generated"].as_bool().unwrap_or(false);
        assert_eq!(assign_spawns(&spawns, &players, c["separate"].as_bool().unwrap(), generated), want, "{c}");
    }
}

#[test]
fn separate_team_spawns_keep_teams_together_and_apart() {
    // Corners: 0 top left, 1 bottom right, 2 top right, 3 bottom left.
    let spawns = [(4, 4), (40, 40), (40, 4), (4, 40)];
    // Slots 0 and 1 are a team: by slot they would start in opposite corners.
    let teams = [setup("england", 1), setup("germany", 1), setup("russia", 2), setup("ukraine", 2)];
    let got = assign_spawns(&spawns, &teams, true, false);
    let d2 = |a: usize, b: usize| {
        let (p, q) = (spawns[got[a]], spawns[got[b]]);
        (p.0 - q.0).pow(2) + (p.1 - q.1).pow(2)
    };
    assert!(d2(0, 1) < d2(0, 2) && d2(2, 3) < d2(1, 3), "team mates side by side: {got:?}");
    let mut sorted = got.clone();
    sorted.sort_unstable();
    assert_eq!(sorted, vec![0, 1, 2, 3], "every spawn used once");
    // A player without a team keeps its slot's spawn.
    let mixed = [setup("england", 0), setup("germany", 1), setup("russia", 1)];
    assert_eq!(assign_spawns(&spawns[..3], &mixed, true, false)[0], 0);
    assert_eq!(assign_spawns(&spawns[..3], &mixed, true, true)[0], 0);
    // The world starts players where the assignment says.
    let w = world(&teams, GameOptions { separate_team_spawns: true, ..GameOptions::default() });
    for (p, &s) in got.iter().enumerate() {
        assert_eq!(w.players[p].start, spawns[s]);
    }
}

#[test]
fn separate_team_spawns_on_generated_maps_split_the_spawn_list_by_team() {
    // A generated 4 player map lists its spawns by column, top first: the
    // halves of the list are the mirrored left and right sides.
    let options = GameOptions { separate_team_spawns: true, ..GameOptions::default() };
    let teams = [setup("england", 1), setup("germany", 2), setup("russia", 1), setup("ukraine", 2)];
    let w = World::with_options(5, 64, &teams, options);
    let spawns = &w.map.spawns;
    assert_eq!(assign_spawns(spawns, &teams, true, true), vec![0, 2, 1, 3]);
    let half = |p: usize| spawns.iter().position(|&s| s == w.players[p].start).unwrap() / 2;
    assert_eq!((half(0), half(2)), (0, 0), "team 1 on the first side");
    assert_eq!((half(1), half(3)), (1, 1), "team 2 on the mirrored side");
}

/// OpenRA's lobby spawn selection: a picked spawn is where the player
/// starts; the others fill in around it (gamerules.rs `assign_spawns`).
#[test]
fn picked_spawns_are_kept_and_the_others_fill_in() {
    let spawns = [(4, 4), (40, 40), (40, 4), (4, 40)];
    let picked = |s: u8, team: u8| PlayerSetup { spawn: Some(s), ..setup("england", team) };
    // Free for all: slot 1 takes spawn 0, slot 0 moves to the lowest free spawn.
    let ffa = [setup("england", 0), picked(0, 0), setup("russia", 0), setup("france", 0)];
    assert_eq!(assign_spawns(&spawns, &ffa, true, false), vec![1, 0, 2, 3]);
    let w = world(&ffa, GameOptions::default());
    assert_eq!((w.players[0].start, w.players[1].start), (spawns[1], spawns[0]), "the world starts them there");
    // Separate team spawns: the picked player counts as an enemy already placed.
    let teams = [setup("england", 1), setup("germany", 1), setup("russia", 2), picked(1, 2)];
    assert_eq!(assign_spawns(&spawns, &teams, true, false), vec![0, 2, 3, 1]);
    // Picks the lobbies never send are refused at the start.
    assert_eq!(spawn_pick_problem(&ffa, 4), None);
    assert!(spawn_pick_problem(&[picked(4, 0), setup("russia", 0)], 4).unwrap().contains("this map has 4"));
    assert!(spawn_pick_problem(&[picked(1, 0), picked(1, 0)], 4).unwrap().contains("two players"));
}

#[test]
fn spawn_picks_come_from_the_lobby_options_and_must_fit_the_map() {
    let options = |spawn: &str| {
        format!(
            r#"{{"seed":3,"mapSize":64,"players":[{{"slot":0,"type":"human","faction":"england","team":0,"spawn":{spawn}}},{{"slot":1,"type":"ai","difficulty":"normal","faction":"russia","team":0}}]}}"#
        )
    };
    let o = crate::parse_options(&options("1")).unwrap();
    assert_eq!(o.players.iter().map(|p| p.spawn).collect::<Vec<_>>(), vec![Some(1), None]);
    assert_eq!(crate::parse_options(&options("null")).unwrap().players[0].spawn, None, "null: automatic");
    assert!(crate::parse_options(&options("8")).is_err());
    assert!(crate::parse_options(&options("\"a\"")).is_err());
    // A map file with two spawns: spawn 2 (index 2) is not on it.
    let mut players = [setup("england", 0), setup("russia", 0)];
    players[0].spawn = Some(2);
    let data = crate::mapdata::MapData::parse(&crate::Game::generated_map(3, 64, 2)).unwrap();
    let refused = World::from_map(&data, 1, &players, GameOptions::default()).err().expect("refused");
    assert!(refused.contains("this map has 2"), "{refused}");
    players[0].spawn = Some(1);
    let Ok(w) = World::from_map(&data, 1, &players, GameOptions::default()) else { panic!("a valid pick is refused") };
    let cell = |k: usize| (data.spawns[k][0], data.spawns[k][1]);
    assert_eq!((w.players[0].start, w.players[1].start), (cell(1), cell(0)));
}

// ---- Starting units ---------------------------------------------------------------------------

#[test]
fn starting_units_are_openra_sets_on_a_ring_around_the_mcv() {
    let count =
        |w: &World, p: u8, id: &str| w.actors.iter().filter(|a| a.alive && a.owner == p && w.rules.actors[a.ty as usize].id == id).count();
    for (units, faction, want) in [
        (StartingUnits::Mcv, "england", vec![("MCV", 1), ("E1", 0)]),
        (StartingUnits::Light, "england", vec![("MCV", 1), ("E1", 3), ("E3", 2), ("JEEP", 1), ("1TNK", 1)]),
        (StartingUnits::Light, "russia", vec![("MCV", 1), ("E1", 3), ("E3", 2), ("APC", 1), ("FTRK", 1)]),
        (StartingUnits::Heavy, "germany", vec![("MCV", 1), ("E1", 3), ("E3", 2), ("JEEP", 1), ("1TNK", 1), ("2TNK", 3)]),
        (StartingUnits::Heavy, "ukraine", vec![("MCV", 1), ("E1", 3), ("E3", 2), ("APC", 1), ("FTRK", 1), ("3TNK", 2)]),
    ] {
        let w = world(&[setup(faction, 0), setup("allies", 0)], GameOptions { starting_units: units, ..GameOptions::default() });
        for (id, n) in want {
            assert_eq!(count(&w, 0, id), n, "{units:?} {faction}: {id}");
        }
        // Support units stand InnerSupportRadius + 1 to OuterSupportRadius cells from the MCV.
        let (sx, sy) = w.players[0].start;
        let home = (sx + 1, sy + 1);
        let set = w
            .rules
            .world
            .starting_units
            .iter()
            .find(|s| {
                s.class
                    == if units == StartingUnits::Mcv {
                        "none"
                    } else if units == StartingUnits::Light {
                        "light"
                    } else {
                        "heavy"
                    }
            })
            .unwrap();
        for a in w.actors.iter().filter(|a| a.alive && a.owner == 0 && w.rules.actors[a.ty as usize].id != "MCV") {
            let (cx, cy) = w.cell_of(a.x, a.y);
            let d2 = (cx - home.0).pow(2) + (cy - home.1).pow(2);
            assert!(d2 > set.inner_radius.pow(2) && d2 <= set.outer_radius.pow(2), "on the ring: {d2}");
        }
    }
    // The Construction Yard option deploys the base instead.
    let w =
        world(&[setup("england", 0), setup("russia", 0)], GameOptions { starting_units: StartingUnits::Base, ..GameOptions::default() });
    assert_eq!(count(&w, 0, "FACT"), 1);
}

#[test]
fn starting_unit_sets_skip_types_webra_does_not_have() {
    // A set naming an unknown type keeps the known ones (rules_options.rs).
    let raw: serde_json::Value = serde_json::from_str(crate::rules::RULES_JSON).unwrap();
    let rules = Rules::load();
    let light = rules.world.starting_units.iter().find(|s| s.class == "light").unwrap();
    assert!(light.support_actors.iter().all(|&a| rules.actors[a].unit.is_some()));
    // `known` drops names without an actor.
    let ids: Vec<String> = rules.actors.iter().map(|a| a.id.clone()).collect();
    let set = crate::rules_options::resolve_world(
        serde_json::from_value(serde_json::json!({
            "crates": raw["world"]["crates"],
            "time_limit": raw["world"]["time_limit"],
            "starting_units": [{"class": "light", "factions": ["england"], "base_actor": "MCV",
                                "support_actors": ["E1", "ZOMBIE", "E3"], "inner_radius": 3, "outer_radius": 5, "base_facing": 512}],
        }))
        .unwrap(),
        &ids,
        &rules.factions,
    )
    .unwrap();
    let names: Vec<&str> = set.starting_units[0].support_actors.iter().map(|&a| rules.actors[a].id.as_str()).collect();
    assert_eq!(names, vec!["E1", "E3"], "a type WebRA does not have is left out");
    // Every type of OpenRA's sets exists now (the infantry included): nothing is left out.
    for (set, raw_set) in rules.world.starting_units.iter().zip(raw["world"]["starting_units"].as_array().unwrap()) {
        assert_eq!(
            set.support_actors.len(),
            raw_set["support_actors"].as_array().unwrap().len(),
            "{} {:?}",
            set.class,
            raw_set["factions"]
        );
    }
}

// ---- Short game and OwnerLostAction ---------------------------------------------------------------

#[test]
fn short_game_needs_structures_and_the_mcv() {
    for short in [false, true] {
        let mut w = world(&[setup("england", 0), setup("russia", 0)], GameOptions { short_game: short, ..GameOptions::default() });
        // Player 1 keeps only a tank (its Construction Yard goes).
        for i in 0..w.actors.len() {
            if w.actors[i].alive && w.actors[i].owner == 1 {
                w.remove(i);
            }
        }
        let tank = unit(&mut w, "1TNK", 1, 30, 30);
        run(&mut w, 30);
        assert_eq!(w.players[1].defeated, short, "short game {short}");
        // OwnerLostAction Kill: the defeated player's tank is destroyed.
        assert_eq!(w.actors[tank].alive, !short);
        if short {
            assert_eq!(w.winner, Some(0));
            assert!(w.game_over);
        }
    }
    // The MCV counts for the short game (vehicles.yaml RequiredForShortGame).
    let mut w = world(&[setup("england", 0), setup("russia", 0)], GameOptions { short_game: true, ..GameOptions::default() });
    for i in 0..w.actors.len() {
        if w.actors[i].alive && w.actors[i].owner == 1 {
            w.remove(i);
        }
    }
    unit(&mut w, "MCV", 1, 30, 30);
    run(&mut w, 30);
    assert!(!w.players[1].defeated, "an MCV keeps a player in a short game");
}

#[test]
fn the_last_side_standing_is_victorious_after_the_others_are_defeated() {
    // Two allies against one: the loser's line first, then one victorious line per winner.
    let mut w =
        world(&[setup("england", 1), setup("germany", 1), setup("russia", 2)], GameOptions { short_game: true, ..GameOptions::default() });
    w.sound.set_enabled(true);
    for i in 0..w.actors.len() {
        if w.actors[i].alive && w.actors[i].owner == 2 {
            w.remove(i);
        }
    }
    run(&mut w, 30);
    assert!(w.game_over);
    let all = w.sound.take();
    let kinds: Vec<(i32, i32)> = all
        .chunks(EVENT_STRIDE)
        .filter(|e| e[0] == SoundEventKind::PlayerLost as i32 || e[0] == SoundEventKind::PlayerWon as i32)
        .map(|e| (e[0], e[4]))
        .collect();
    let (lost, won) = (SoundEventKind::PlayerLost as i32, SoundEventKind::PlayerWon as i32);
    assert_eq!(kinds, vec![(lost, 2), (won, 0), (won, 1)]);
    // Nothing more once the game is over.
    run(&mut w, 30);
    assert!(events(&mut w, SoundEventKind::PlayerWon).is_empty());
}

#[test]
fn a_defeated_players_walls_and_husks_go_to_the_neutral_player() {
    let mut w = world(&[setup("england", 0), setup("russia", 0)], GameOptions { crates: true, ..GameOptions::default() });
    let neutral = w.neutral_player().expect("crates bring the neutral player");
    let wall = ty(&w, "SBAG");
    let sb = w.spawn_building(wall, 1, 20, 20).unwrap();
    let tank = unit(&mut w, "2TNK", 1, 30, 30);
    for i in 0..w.actors.len() {
        if w.actors[i].alive && w.actors[i].owner == 1 && i != sb && i != tank {
            w.remove(i);
        }
    }
    run(&mut w, 2);
    w.lose(1);
    run(&mut w, 2);
    assert_eq!(w.actors[sb].owner, neutral, "OwnerLostAction ChangeOwner");
    assert!(!w.actors[tank].alive, "OwnerLostAction Kill");
    let husk = w.husk_at(w.map.idx(30, 30)).expect("the tank left its husk");
    assert_eq!(w.actors[husk].owner, neutral, "the husk of a defeated owner is neutral");
}

// ---- Time limit -------------------------------------------------------------------------------

#[test]
fn time_limit_warns_and_the_most_experienced_side_wins() {
    let players = [setup("england", 0), setup("russia", 0), setup("france", 0)];
    let mut w = world(&players, GameOptions { time_limit: 10, ..GameOptions::default() });
    w.sound.set_enabled(true);
    let limit = 10 * 60 * 25;
    assert_eq!(w.time_limit_ticks(), Some(limit as i64));
    // Five minutes left: a warning of the rules' minutes, to everyone.
    w.tick = (limit - 5 * 60 * 25 - 1) as u32;
    w.step();
    let warn = events(&mut w, SoundEventKind::TimeLimitWarning);
    assert_eq!(warn.len(), 1);
    assert_eq!((warn[0][1], warn[0][4]), (5, crate::sound_events::ALL_PLAYERS as i32));
    let k = w.rules.world.time_limit.warnings.iter().position(|&m| m == 5).unwrap();
    assert_eq!(w.rules.world.time_limit.notifications[k], "WarningFiveMinutesRemaining");
    // Time runs out: free for all, the most experienced player wins.
    w.players[1].experience = 50;
    w.players[2].experience = 20;
    w.tick = (limit - 1) as u32;
    w.step();
    assert!(w.game_over);
    assert_eq!(w.winner, Some(1));
    assert!(w.players[0].defeated && w.players[2].defeated && !w.players[1].defeated);
    let expired = events(&mut w, SoundEventKind::TimeLimitExpired);
    assert_eq!(expired.len(), 1, "time is up");
}

#[test]
fn time_limit_counts_real_minutes_at_any_speed_and_teams_add_up() {
    let players = [setup("england", 1), setup("germany", 1), setup("russia", 0), setup("ukraine", 0)];
    let mut w = world(&players, GameOptions { time_limit: 10, tick_ms: 20, ..GameOptions::default() });
    // Fastest: 50 ticks a second (OpenRA 1000 / Timestep).
    assert_eq!(w.time_limit_ticks(), Some(10 * 60 * 50));
    // Team 1 has 30 + 30; the players without a team 50 + 0 (one group, as in OpenRA).
    w.players[0].experience = 30;
    w.players[1].experience = 30;
    w.players[2].experience = 50;
    w.time_limit_expired();
    assert!(w.has_won(0) && w.has_won(1) && !w.has_won(2) && !w.has_won(3));
    // Team 0 wins as a group of one: only its most experienced player.
    let mut w = world(&players, GameOptions { time_limit: 10, ..GameOptions::default() });
    w.players[2].experience = 80;
    w.players[3].experience = 10;
    w.time_limit_expired();
    assert_eq!(w.winner, Some(2));
    assert!(w.players[3].defeated, "its group mate without a team loses");
}

// ---- Kill bounties --------------------------------------------------------------------------

#[test]
fn kill_bounties_pay_the_killer_a_share_of_the_value() {
    for bounty in [false, true] {
        let players = [setup("england", 1), setup("russia", 0), setup("germany", 1)];
        let mut w = world(&players, GameOptions { bounty, ..GameOptions::default() });
        w.sound.set_enabled(true);
        let tank = unit(&mut w, "3TNK", 1, 30, 30);
        let ally = unit(&mut w, "1TNK", 2, 34, 34);
        let cash = w.players[0].cash;
        w.with_damage_source(0, |w| w.kill(tank));
        w.with_damage_source(0, |w| w.kill(ally));
        let pct = w.rules.actors[ty(&w, "3TNK") as usize].options.gives_bounty.unwrap();
        let want = if bounty { w.rules.actors[ty(&w, "3TNK") as usize].cost * pct / 100 } else { 0 };
        assert_eq!(w.players[0].cash - cash, want, "bounty {bounty}: an enemy pays, an ally does not");
        let shown = events(&mut w, SoundEventKind::Bounty);
        assert_eq!(shown.len(), usize::from(bounty));
        if bounty {
            assert_eq!(shown[0][1], want);
            assert_eq!(shown[0][4], 0, "for the killing player");
        }
    }
}

// ---- Handicaps ----------------------------------------------------------------------------------

#[test]
fn handicaps_lower_firepower_and_armour_and_slow_production() {
    let mut players = [setup("england", 0), setup("russia", 0)];
    players[1].handicap = 50;
    let mut w = world(&players, GameOptions::default());
    let a = unit(&mut w, "1TNK", 0, 20, 20);
    let b = unit(&mut w, "1TNK", 1, 24, 24);
    assert_eq!(w.firepower_modifier(a), 100);
    assert_eq!(w.firepower_modifier(b), 50, "50 % handicap: half the firepower");
    assert_eq!(w.handicap_damage(b), 200, "and twice the damage taken");
    assert_eq!(w.modified_damage(b, 1000, 0), 2000);
    let t = ty(&w, "1TNK");
    assert_eq!(w.build_time_with(1, t, 1), w.build_time_with(0, t, 1) * 150 / 100, "150 % build time");
    // The lobby value checks: 0 to 95 in steps of 5.
    let json = |h: i64| {
        format!(
            r#"{{"seed":1,"mapSize":64,"players":[{{"type":"human","faction":"england","handicap":{h}}},{{"type":"ai","faction":"russia","difficulty":"easy"}}]}}"#
        )
    };
    assert_eq!(crate::parse_options(&json(35)).unwrap().players[0].handicap, 35);
    assert!(crate::parse_options(&json(33)).is_err());
    assert!(crate::parse_options(&json(100)).is_err());
}

// ---- Player experience -----------------------------------------------------------------------------

#[test]
fn player_experience_comes_from_kills_and_repairs_for_allies() {
    let players = [setup("england", 1), setup("russia", 0), setup("germany", 1)];
    let mut w = world(&players, GameOptions::default());
    let shooter = unit(&mut w, "1TNK", 0, 20, 20);
    let victim = unit(&mut w, "3TNK", 1, 22, 22);
    let source = w.make_ref(shooter);
    w.award_kill(victim, source);
    let info = &w.rules.actors[ty(&w, "3TNK") as usize];
    let g = info.gives_experience.as_ref().unwrap();
    assert_eq!(w.players[0].experience, info.cost as i64 * g.player_modifier as i64 / 100);
    // An ally repairs player 2's power plant to full: PlayerExperience 5.
    let powr = ty(&w, "POWR");
    let b = w.spawn_building(powr, 2, 30, 30).unwrap();
    w.actors[b].hp -= 100;
    w.toggle_repair(0, b);
    let before = w.players[0].experience;
    run(&mut w, 60);
    assert_eq!(w.actors[b].hp, w.rules.actors[powr as usize].hp);
    let xp = w.rules.actors[powr as usize].building.as_ref().unwrap().repairable.as_ref().unwrap().player_experience;
    assert_eq!(w.players[0].experience - before, xp as i64);
}

// ---- Ally build radius ---------------------------------------------------------------------------------

#[test]
fn ally_build_radius_lets_allies_build_next_to_each_other() {
    for ally in [false, true] {
        let players = [setup("england", 1), setup("germany", 1)];
        let mut w = world(&players, GameOptions { ally_build_radius: ally, ..GameOptions::default() });
        // Player 1's yard is the only structure near (20, 20).
        let fact = ty(&w, "FACT");
        w.spawn_building(fact, 1, 20, 20);
        let powr = ty(&w, "POWR");
        for p in w.players.iter_mut() {
            p.explored.iter_mut().for_each(|e| *e = 1);
        }
        w.rebuild_hash();
        assert_eq!(w.can_place(0, powr, 24, 20), ally, "ally build radius {ally}");
    }
}

// ---- Options parsing and determinism -------------------------------------------------------------------

#[test]
fn lobby_options_default_to_openra_and_reject_unknown_time_limits() {
    let base =
        r#""seed":1,"mapSize":64,"players":[{"type":"human","faction":"england"},{"type":"ai","faction":"russia","difficulty":"easy"}]"#;
    let g = crate::Game::from_options(&format!("{{{base}}}")).unwrap();
    let o = &g.world.options;
    assert!(o.crates && o.short_game && o.separate_team_spawns && o.ally_build_radius && !o.bounty && o.time_limit == 0);
    assert!(g.world.neutral_player().is_some(), "crates bring the neutral player");
    let g = crate::Game::from_options(&format!(
        r#"{{{base},"crates":false,"shortGame":false,"bounty":true,"timeLimit":30,"gameSpeed":"faster","separateTeamSpawns":false,"allyBuildRadius":false}}"#
    ))
    .unwrap();
    let o = &g.world.options;
    assert!(!o.crates && !o.short_game && o.bounty && !o.separate_team_spawns && !o.ally_build_radius);
    assert_eq!((o.time_limit, o.tick_ms), (30, 30));
    // Without crates a neutral player only comes with neutral actors: the
    // trees, ore mines and tech buildings of the generated map (neutral.rs).
    if let Some(n) = g.world.neutral_player() {
        assert!(g.world.actors.iter().any(|a| a.alive && a.owner == n), "the neutral player owns the neutral world");
    }
    assert!(crate::parse_options(&format!(r#"{{{base},"timeLimit":7}}"#)).is_err());
}

#[test]
fn games_with_every_option_stay_deterministic() {
    let players: Vec<PlayerSetup> = ["england", "russia"]
        .iter()
        .enumerate()
        .map(|(k, f)| PlayerSetup {
            faction: (*f).into(),
            ai: Some(AiDifficulty::Hard),
            bot: Default::default(),
            team: 0,
            handicap: (k * 10) as u8,
            spawn: None,
        })
        .collect();
    let options = GameOptions {
        crates: true,
        short_game: true,
        bounty: true,
        time_limit: 10,
        starting_units: StartingUnits::Light,
        ..GameOptions::default()
    };
    let mut a = World::with_options(21, 64, &players, options.clone());
    let mut b = World::with_options(21, 64, &players, options);
    let mut crates = 0;
    for k in 0..25 * 150 {
        a.step();
        b.step();
        if k % 250 == 0 {
            assert_eq!(a.state_hash(), b.state_hash(), "tick {k}");
        }
        crates = crates.max(a.actors.iter().filter(|x| x.alive && x.kind == Kind::Crate).count());
    }
    assert_eq!(a.state_hash(), b.state_hash());
    assert!(crates > 0, "the spawner dropped crates");
}

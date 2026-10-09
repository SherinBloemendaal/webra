//! Tests for the skirmish AI's arsenal (ai_arsenal.rs): aircraft, ships,
//! mines and other unit abilities, superweapons, never hurting allies, and
//! fair, finishing games on generated maps.

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

/// One arena player: faction, AI difficulty (None: a passive human), team, yard cell.
type Seat<'a> = (&'a str, Option<AiDifficulty>, u8, (i32, i32));

/// An all-clear square map. Everyone is rich.
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
    for (p, &(faction, ai, team, start)) in players.iter().enumerate() {
        let f = w.rules.faction_index(faction).unwrap();
        w.add_player(f, ai.is_some(), start);
        w.players[p].team = team;
        w.players[p].cash = 100_000;
        w.ai.push(crate::ai::AiState::new(p as u32, ai.unwrap_or(AiDifficulty::Normal)));
        w.spawn_building(ty(&w, "FACT"), p as u8, start.0, start.1);
    }
    w.refresh_tokens();
    w.update_power();
    w.update_vision();
    w
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
}

/// Every structure of the build order (and a tech center) around the yard, so
/// the AI moves straight on to its arsenal.
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

// ---- Aircraft -------------------------------------------------------------------

#[test]
fn ai_builds_aircraft_of_its_side_attacks_and_rearms() {
    for (faction, enemy, side_aircraft) in
        [("russia", "england", &["HIND", "YAK", "MIG"][..]), ("england", "russia", &["MH60", "HELI"][..])]
    {
        let mut w = arena(64, &[(faction, Some(AiDifficulty::Hard), 0, (4, 4)), (enemy, None, 0, (40, 44))]);
        complete_base(&mut w, 0);
        complete_base(&mut w, 1);
        let (mut attacked, mut rearmed, mut built) = (false, false, false);
        for t in 0..25 * 60 * 7 {
            // Keep a bait group of tanks in sight of the AI's base.
            if t % 250 == 0 && count(&w, 1, "2TNK") < 3 {
                for k in 0..3 {
                    quiet_unit(&mut w, "2TNK", 1, 26 + k, 26);
                }
            }
            w.step();
            built |= side_aircraft.iter().any(|id| count(&w, 0, id) > 0);
            for i in 0..w.actors.len() {
                let a = &w.actors[i];
                if !a.alive || a.owner != 0 || a.kind != Kind::Aircraft {
                    continue;
                }
                if a.activity == Activity::Attack && w.resolve(a.target).is_some_and(|v| w.actors[v].owner == 1) {
                    attacked = true;
                }
                let spent = if w.is_helicopter(i) { w.heli_ammo(i).0 < w.heli_ammo(i).1 } else { w.ammo_left(i) < w.max_ammo(i) };
                // Back on a pad or airfield with rounds spent: rearming.
                if attacked && spent && a.altitude == 0 {
                    rearmed = true;
                }
            }
            if attacked && rearmed {
                break;
            }
        }
        assert!(built, "{faction}: the AI built aircraft of its side ({side_aircraft:?})");
        assert!(
            count(&w, 0, "HPAD") > 0 || count(&w, 0, "AFLD") > 0 || count(&w, 0, "AFLD.Ukraine") > 0,
            "{faction}: an aircraft structure"
        );
        assert!(attacked, "{faction}: an aircraft attacked an enemy");
        assert!(rearmed, "{faction}: an aircraft came back to rearm");
        for &id in ["MH60", "HELI"].iter().filter(|_| faction == "russia") {
            assert_eq!(count(&w, 0, id), 0, "russia never builds the Allied {id}");
        }
    }
}

#[test]
fn ai_aircraft_avoid_targets_under_heavy_anti_air() {
    let mut w = arena(64, &[("england", Some(AiDifficulty::Hard), 0, (4, 4)), ("russia", None, 0, (52, 52))]);
    let heli = w.spawn_unit(ty(&w, "MH60"), 0, cell_center(10), cell_center(10), 512);
    // Two equal targets at the same distance; one sits among flak trucks.
    let guarded = quiet_unit(&mut w, "3TNK", 1, 24, 12);
    for (x, y) in [(23, 13), (25, 13), (24, 14)] {
        quiet_unit(&mut w, "FTRK", 1, x, y);
    }
    let open = quiet_unit(&mut w, "3TNK", 1, 12, 24);
    // Spotters so the AI sees both.
    quiet_unit(&mut w, "E1", 0, 22, 12);
    quiet_unit(&mut w, "E1", 0, 12, 22);
    let mut target = None;
    for _ in 0..60 {
        w.step();
        if w.actors[heli].activity == Activity::Attack {
            target = w.resolve(w.actors[heli].target);
            break;
        }
    }
    assert_eq!(target, Some(open), "the helicopter goes for the tank without anti-air (guarded one is {guarded})");
}

// ---- Ships ----------------------------------------------------------------------

#[test]
fn ai_builds_a_naval_yard_and_ships_where_water_reaches_the_enemy() {
    for (faction, enemy, yard) in [("england", "russia", "SYRD"), ("russia", "england", "SPEN")] {
        let mut w = arena(64, &[(faction, Some(AiDifficulty::Hard), 0, (4, 4)), (enemy, None, 0, (44, 4))]);
        // A sea along the south of both bases (within reach of the structures), scouted.
        flood(&mut w, 0, 18, 63, 63);
        complete_base(&mut w, 0);
        complete_base(&mut w, 1);
        w.players[0].explored.iter_mut().for_each(|e| *e = 1);
        let enemy_base = (cell_center(45), cell_center(6));
        let mut sailed = false;
        for _ in 0..25 * 60 * 8 {
            w.step();
            sailed |= w.actors.iter().any(|a| {
                a.alive
                    && a.owner == 0
                    && a.kind == Kind::Ship
                    && ((a.attack_move && dist(a.dest.0, a.dest.1, enemy_base.0, enemy_base.1) < 20 * CELL)
                        || (a.activity == Activity::Attack && w.resolve(a.target).is_some_and(|t| w.actors[t].owner == 1)))
            });
            if sailed {
                break;
            }
        }
        assert_eq!(count(&w, 0, yard), 1, "{faction}: one naval yard");
        let ships = w.actors.iter().filter(|a| a.alive && a.owner == 0 && a.kind == Kind::Ship).count();
        assert!(ships >= 1, "{faction}: ships built ({ships})");
        assert!(sailed, "{faction}: ships sailed at the enemy coast");
    }
}

#[test]
fn ai_builds_no_naval_yard_without_useful_water() {
    // A pond next to the AI base that reaches nowhere near the enemy.
    let mut w = arena(64, &[("england", Some(AiDifficulty::Hard), 0, (4, 4)), ("russia", None, 0, (52, 52))]);
    flood(&mut w, 0, 18, 12, 26);
    complete_base(&mut w, 0);
    w.players[0].explored.iter_mut().for_each(|e| *e = 1);
    run(&mut w, 25 * 60 * 5);
    assert_eq!(count(&w, 0, "SYRD"), 0, "no naval yard on a pond");
}

#[test]
fn ai_submarines_hunt_enemy_ships() {
    let mut w = arena(64, &[("russia", Some(AiDifficulty::Hard), 0, (4, 4)), ("england", None, 0, (52, 4))]);
    flood(&mut w, 0, 19, 63, 63);
    let sub = w.spawn_unit(ty(&w, "SS"), 0, cell_center(10), cell_center(24), 512);
    let boat = quiet_unit(&mut w, "PT", 1, 20, 21);
    quiet_unit(&mut w, "E1", 0, 20, 18);
    let mut hunted = false;
    for _ in 0..100 {
        w.step();
        if w.actors[sub].activity == Activity::Attack && w.resolve(w.actors[sub].target) == Some(boat) {
            hunted = true;
            break;
        }
    }
    assert!(hunted, "the submarine attacks the gunboat");
}

// ---- Abilities ------------------------------------------------------------------

#[test]
fn ai_lays_minefields_on_the_approaches_to_its_base() {
    let mut w = arena(64, &[("england", Some(AiDifficulty::Hard), 0, (4, 4)), ("russia", None, 0, (52, 52))]);
    complete_base(&mut w, 0);
    for p in 0..2 {
        w.players[p].explored.iter_mut().for_each(|e| *e = 1);
    }
    run(&mut w, 25 * 60 * 6);
    let fields = w.ai[0].minefields.len();
    assert!(fields >= 2, "minefields ordered: {fields}");
    let mine = ty(&w, "MINV");
    let mines: Vec<usize> =
        (0..w.actors.len()).filter(|&i| w.actors[i].alive && w.actors[i].owner == 0 && w.actors[i].ty == mine).collect();
    assert!(mines.len() >= 4, "mines laid: {}", mines.len());
    let base = crate::ai::base_point(&w, 0);
    let enemy = crate::ai::base_point(&w, 1);
    for &m in &mines {
        let (mx, my) = (w.actors[m].x, w.actors[m].y);
        // Out toward the enemy, not behind the base.
        let along = (mx - base.0) as i64 * (enemy.0 - base.0) as i64 + (my - base.1) as i64 * (enemy.1 - base.1) as i64;
        assert!(along > 0, "mine at {mx},{my} lies toward the enemy");
        assert_eq!(w.map.ore[w.cell_index(mx, my)], 0, "no mine on ore");
    }
}

#[test]
fn ai_chrono_tank_jumps_onto_enemy_artillery() {
    let mut w = arena(64, &[("germany", Some(AiDifficulty::Hard), 0, (4, 4)), ("russia", None, 0, (52, 52))]);
    w.players[0].explored.iter_mut().for_each(|e| *e = 1);
    let tank = w.spawn_unit(ty(&w, "CTNK"), 0, cell_center(10), cell_center(10), 512);
    w.actors[tank].reload = [1_000_000; crate::world::MAX_WEAPONS];
    let arty = quiet_unit(&mut w, "V2RL", 1, 17, 13);
    quiet_unit(&mut w, "E1", 0, 16, 11);
    let mut jumped = false;
    for _ in 0..60 {
        w.step();
        let a = &w.actors[tank];
        if dist(a.x, a.y, w.actors[arty].x, w.actors[arty].y) <= 3 * CELL && w.resolve(a.target) == Some(arty) {
            jumped = true;
            break;
        }
    }
    assert!(jumped, "the chrono tank teleported next to the V2 launcher and attacks it");
    assert!(w.actors[tank].ab.chrono_charge > 0, "and is recharging");
}

#[test]
fn ai_mad_tank_and_demolition_truck_go_off_among_enemies() {
    for (faction, id) in [("russia", "QTNK"), ("ukraine", "DTRK")] {
        // A demolition truck also goes off when it fires at a target in reach (engine
        // behaviour), so only the MAD tank shows the AI holding back near friends.
        let cases: &[bool] = if id == "QTNK" { &[false, true] } else { &[false] };
        for &friends_near in cases {
            let mut w = arena(64, &[(faction, Some(AiDifficulty::Hard), 0, (4, 4)), ("england", None, 0, (44, 44))]);
            // An enemy outpost: four structures around (34, 34), and the bomber in its middle.
            for (x, y) in [(31, 31), (35, 31), (31, 35), (35, 35)] {
                w.spawn_building(ty(&w, "POWR"), 1, x, y);
            }
            let bomber = w.spawn_unit(ty(&w, id), 0, cell_center(34), cell_center(34), 512);
            if friends_near {
                for k in 0..3 {
                    quiet_unit(&mut w, "3TNK", 0, 33 + k, 33);
                }
            }
            run(&mut w, 40);
            let went_off = !w.actors[bomber].alive || w.actors[bomber].ab.task == crate::abilities::Task::MadDeploy;
            assert_eq!(went_off, !friends_near, "{id}, own tanks next to it: {friends_near}");
        }
    }
}

#[test]
fn ai_radar_jammer_follows_the_attack() {
    let mut w = arena(64, &[("england", Some(AiDifficulty::Hard), 0, (4, 4)), ("russia", None, 0, (52, 52))]);
    let jammer = w.spawn_unit(ty(&w, "MRJ"), 0, cell_center(8), cell_center(12), 512);
    // An attack under way, far from the base.
    let tanks: Vec<usize> = (0..4).map(|k| w.spawn_unit(ty(&w, "1TNK"), 0, cell_center(30 + k), cell_center(30), 512)).collect();
    w.order_move(&tanks, cell_center(52), cell_center(52), true);
    run(&mut w, 40);
    let a = &w.actors[jammer];
    let goal = if a.activity == Activity::Move { a.dest } else { (a.x, a.y) };
    assert!(dist(goal.0, goal.1, cell_center(32), cell_center(32)) < 8 * CELL, "the jammer heads for the army: {goal:?}");
}

// ---- Superweapons ---------------------------------------------------------------

fn make_ready(w: &mut World, player: u8, kind: &str) {
    let keys: Vec<String> = w.power_instances(player).iter().filter(|p| w.power_info(p).kind == kind).map(|p| p.key.clone()).collect();
    for key in keys {
        w.powers.players[player as usize].iter_mut().find(|p| p.key == key).unwrap().remaining = 0;
    }
}

fn fired(w: &World, player: u8, kind: &str) -> bool {
    w.power_instances(player).iter().any(|p| w.power_info(p).kind == kind && p.remaining > p.total - 60)
}

#[test]
fn hard_ai_builds_superweapons_and_normal_waits() {
    for (diff, expect) in [(AiDifficulty::Hard, true), (AiDifficulty::Normal, false)] {
        let mut w = arena(64, &[("russia", Some(diff), 0, (4, 4)), ("england", None, 0, (52, 52))]);
        complete_base(&mut w, 0);
        run(&mut w, 25 * 60 * 5);
        let supers = count(&w, 0, "IRON") + count(&w, 0, "MSLO");
        assert_eq!(supers > 0, expect, "{diff:?}: superweapons after 5 minutes: {supers}");
    }
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

#[test]
fn ai_fires_iron_curtain_on_its_army_and_the_nuke_at_enemy_structures() {
    let mut w = arena(64, &[("russia", Some(AiDifficulty::Hard), 0, (4, 4)), ("england", None, 0, (48, 48))]);
    complete_base(&mut w, 0);
    complete_base(&mut w, 1);
    for (id, x, y) in [("IRON", 20, 4), ("MSLO", 20, 9)] {
        put(&mut w, id, 0, x, y);
    }
    w.refresh_tokens();
    w.update_power();
    // The army fights enemy tanks in the field.
    let tanks: Vec<usize> =
        (0..4).map(|k| w.spawn_unit(ty(&w, "3TNK"), 0, cell_center(28 + k % 2), cell_center(28 + k / 2), 256)).collect();
    let foes: Vec<usize> = (0..3).map(|k| quiet_unit(&mut w, "2TNK", 1, 32, 27 + k)).collect();
    w.order_attack(&tanks, foes[1], false);
    run(&mut w, 2);
    make_ready(&mut w, 0, "GrantExternalConditionPower");
    make_ready(&mut w, 0, "NukePower");
    for _ in 0..30 {
        for &t in &tanks {
            if w.actors[t].alive && w.actors[t].activity != Activity::Attack {
                w.order_attack(&[t], foes[1], false);
            }
        }
        w.step();
    }
    assert!(fired(&w, 0, "GrantExternalConditionPower"), "the Iron Curtain fired");
    let shielded = tanks.iter().filter(|&&t| w.actors[t].invulnerable_until > w.tick).count();
    assert!(shielded >= 3, "on the fighting army: {shielded} tanks invulnerable");
    assert!(fired(&w, 0, "NukePower"), "the nuke launched");
    let nuke = w.abil.nukes.first().expect("a missile in flight");
    let enemy = crate::ai::base_point(&w, 1);
    assert!(dist(nuke.x, nuke.y, enemy.0, enemy.1) < 14 * CELL, "at the enemy base");
    for a in w.actors.iter().filter(|a| a.alive && a.owner == 0 && a.kind != Kind::Building) {
        assert!(dist(a.x, a.y, nuke.x, nuke.y) > 7 * CELL, "far from own units");
    }
}

#[test]
fn ai_chronoshifts_its_gathered_army_into_the_enemy_base() {
    let mut w = arena(64, &[("england", Some(AiDifficulty::Hard), 0, (4, 4)), ("russia", None, 0, (48, 48))]);
    complete_base(&mut w, 0);
    complete_base(&mut w, 1);
    put(&mut w, "PDOX", 0, 20, 4);
    w.refresh_tokens();
    w.update_power();
    w.players[0].explored.iter_mut().for_each(|e| *e = 1);
    // Keep the wave from leaving before the jump: a wave needs more units.
    w.ai[0].target_player = Some(1);
    let rally = crate::ai::rally_point(&w, 0);
    let (rx, ry) = w.cell_of(rally.0, rally.1);
    let tanks: Vec<usize> =
        (0..4).map(|k| w.spawn_unit(ty(&w, "1TNK"), 0, cell_center(rx + k % 2), cell_center(ry + k / 2), 512)).collect();
    run(&mut w, 2);
    make_ready(&mut w, 0, "ChronoshiftPower");
    run(&mut w, 30);
    assert!(fired(&w, 0, "ChronoshiftPower"), "the Chronosphere fired");
    let enemy = crate::ai::base_point(&w, 1);
    let shifted = tanks.iter().filter(|&&t| w.actors[t].alive && dist(w.actors[t].x, w.actors[t].y, enemy.0, enemy.1) < 16 * CELL).count();
    assert!(shifted >= 3, "tanks jumped into the enemy base: {shifted}");
}

// ---- Allies -----------------------------------------------------------------------

#[test]
fn ai_never_bombs_or_attacks_allies() {
    // AI 0 and human 1 against human 2; 1's tanks sit in 2's base.
    let mut w = arena(64, &[("russia", Some(AiDifficulty::Hard), 1, (4, 4)), ("england", None, 1, (4, 48)), ("france", None, 2, (48, 48))]);
    complete_base(&mut w, 0);
    complete_base(&mut w, 2);
    put(&mut w, "MSLO", 0, 20, 4);
    w.refresh_tokens();
    w.update_power();
    let (ex, ey) = w.players[2].start;
    for k in 0..12 {
        quiet_unit(&mut w, "1TNK", 1, ex + (k % 6) * 3, ey + 4 + (k / 6) * 4);
    }
    run(&mut w, 2);
    make_ready(&mut w, 0, "NukePower");
    for t in 0..25 * 60 * 3 {
        w.step();
        for n in &w.abil.nukes {
            assert!(crate::ai_arsenal::safe_to_bomb(&w, 0, n.x, n.y, 7 * CELL), "tick {t}: the nuke would hit the ally");
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
    let players: Vec<PlayerSetup> =
        teams.iter().enumerate().map(|(k, &team)| PlayerSetup { faction: factions[k % 8].into(), ai: Some(diff), team }).collect();
    let mut w = World::with_options(seed, size, &players, GameOptions::default());
    for _ in 0..25 * 60 * limit_minutes {
        w.step();
        if w.winner.is_some() {
            break;
        }
    }
    (w.winner, w)
}

#[test]
fn four_player_ai_free_for_all_finishes_within_40_minutes() {
    let games: Vec<(u64, AiDifficulty)> = vec![(1, AiDifficulty::Normal), (2, AiDifficulty::Hard), (3, AiDifficulty::Easy)];
    let results: Vec<(u64, Option<u8>, u32)> = std::thread::scope(|s| {
        let handles: Vec<_> = games
            .iter()
            .map(|&(seed, diff)| {
                s.spawn(move || {
                    let (winner, w) = play(seed, 96, &[0, 0, 0, 0], diff, 40);
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
                            .map(|&team| PlayerSetup { faction: "allies".into(), ai: Some(AiDifficulty::Normal), team })
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
    let mut w = arena(64, &[("england", Some(AiDifficulty::Normal), 0, (4, 4)), ("russia", None, 0, (40, 44))]);
    complete_base(&mut w, 0);
    put(&mut w, "PBOX", 0, 20, 20);
    w.players[0].cash = 0;
    let before = w.actors.iter().filter(|a| a.alive && a.owner == 0 && a.kind == Kind::Building).count();
    run(&mut w, 25 * 120);
    let left: Vec<String> = w
        .actors
        .iter()
        .filter(|a| a.alive && a.owner == 0 && a.kind == Kind::Building)
        .map(|a| w.rules.actors[a.ty as usize].id.clone())
        .collect();
    assert!(left.len() < before, "sold something: {left:?}");
    for keep in ["FACT", "TENT", "WEAP", "PBOX"] {
        assert!(left.iter().any(|id| id == keep), "kept {keep}: {left:?}");
    }
    // Refineries without ore go first; it stops once it has its army.
    assert!(!left.iter().any(|id| id == "PROC"), "useless refineries go first: {left:?}");
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
    let mut w = arena(64, &[("england", Some(AiDifficulty::Normal), 0, (4, 4)), ("russia", None, 0, (40, 44))]);
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

/// Ore trucks with nothing left nearby drive to ore anywhere they can reach,
/// on their own side of the map first, even where nobody has looked yet.
#[test]
fn waiting_ore_trucks_find_ore_they_have_not_seen() {
    let mut w = arena(64, &[("england", Some(AiDifficulty::Normal), 0, (4, 4)), ("russia", None, 0, (40, 44))]);
    complete_base(&mut w, 0);
    // Ore far out of sight on our side, and nearer to the enemy as well.
    for (x0, y0) in [(4, 50), (40, 30)] {
        for y in y0..y0 + 3 {
            for x in x0..x0 + 3 {
                let i = w.map.idx(x, y);
                w.map.ore[i] = 10;
            }
        }
    }
    let harv = w.actors.iter().position(|a| a.alive && a.owner == 0 && w.rules.actors[a.ty as usize].id == "HARV").expect("a free truck");
    assert_eq!(w.players[0].explored[w.map.idx(5, 51)], 0, "not explored");
    run(&mut w, 25 * 40);
    let a = &w.actors[harv];
    let goal = (a.goal as i32 % w.map.width, a.goal as i32 / w.map.width);
    let target =
        if a.harv_cell == crate::world::NONE { goal } else { (a.harv_cell as i32 % w.map.width, a.harv_cell as i32 / w.map.width) };
    assert!(
        target.1 >= 49 && target.0 <= 8,
        "the truck heads for the ore on our side: target {target:?}, at {},{}",
        a.x / CELL,
        a.y / CELL
    );
}

// ---- Target choice in free for alls -------------------------------------------------

/// Eight players on a ring (seed and map of the reported game), seven AIs and
/// a human in slot 0 who stays the weakest (no army at all, while every AI
/// gets tanks): the AIs pick their targets in their usual order, and at most
/// one of the human's two neighbours goes for it, through the opening and
/// across retargets. Before, every AI took the weakest of its two equally
/// near neighbours, so both of the human's neighbours attacked it.
#[test]
fn weakest_player_on_a_ring_is_attacked_by_at_most_one_neighbour() {
    for seed in [1706698519, 11, 22] {
        let players: Vec<PlayerSetup> =
            (0..8).map(|k| PlayerSetup { faction: "allies".into(), ai: (k != 0).then_some(AiDifficulty::Normal), team: 0 }).collect();
        let mut w = World::with_options(seed, 96, &players, GameOptions::default());
        for p in 1..8u8 {
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

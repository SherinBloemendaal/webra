//! Tests for the radar minimap (minimap.rs): when the radar works, radar
//! jamming, and that the blips never reveal hidden or jammed enemies.

use std::collections::HashSet;

use crate::map::{Map, Terrain};
use crate::math::{dist_sq, CELL};
use crate::minimap::{RadarState, BLIP_INTS, NEUTRAL_OWNER};
use crate::rules::{Kind, Rules};
use crate::world::{cell_center, World, MAX_WEAPONS};

fn ty(w: &World, id: &str) -> u16 {
    w.rules.actor_index(id).unwrap() as u16
}

fn run(w: &mut World, ticks: u32) {
    for _ in 0..ticks {
        w.step();
    }
}

/// An all-clear 96x96 map with passive players (faction, team, yard cell).
/// Everything is explored; only what units see is visible.
fn arena(players: &[(&str, u8, (i32, i32))]) -> World {
    let rules = Rules::load();
    let mut map = Map::generate(96, 96, 3, 12);
    for i in 0..map.cells() {
        map.terrain[i] = Terrain::Clear;
        map.ore[i] = 0;
    }
    let mut w = World::empty(rules, map, 3);
    w.pass = crate::flowfield::Passability::new(&w.map);
    w.pass_water = crate::flowfield::Passability::water(&w.map);
    w.pass_landing = crate::flowfield::Passability::landing(&w.map);
    for (p, &(faction, team, start)) in players.iter().enumerate() {
        let f = w.rules.faction_index(faction).unwrap();
        w.add_player(f, false, start);
        w.players[p].team = team;
        w.players[p].cash = 100_000;
        w.ai.push(crate::ai::AiState::new(&w.rules, p as u8, Default::default(), crate::world::AiDifficulty::Normal));
        w.spawn_building(ty(&w, "FACT"), p as u8, start.0, start.1);
    }
    for p in w.players.iter_mut() {
        p.explored.iter_mut().for_each(|e| *e = 1);
    }
    w.refresh_tokens();
    w.update_power();
    w.update_vision();
    w
}

/// Player 0 (Allies) top left, player 1 (Soviet) bottom right, no teams.
fn duel() -> World {
    arena(&[("england", 0, (4, 4)), ("russia", 0, (88, 88))])
}

/// Unit that never fires.
fn unit(w: &mut World, id: &str, owner: u8, cx: i32, cy: i32) -> usize {
    let t = ty(w, id);
    let u = w.spawn_unit(t, owner, cell_center(cx), cell_center(cy), 0);
    w.actors[u].reload = [1_000_000; MAX_WEAPONS];
    u
}

/// A powered Radar Dome for `player` with its top left at (cx, cy).
fn dome(w: &mut World, player: u8, cx: i32, cy: i32) -> usize {
    w.spawn_building(ty(w, "POWR"), player, cx + 3, cy).unwrap();
    let d = w.spawn_building(ty(w, "DOME"), player, cx, cy).unwrap();
    w.update_power();
    w.update_vision();
    d
}

fn blips(w: &World, player: u8) -> Vec<[i32; BLIP_INTS]> {
    let mut out = Vec::new();
    w.minimap_blips(player, &mut out);
    assert_eq!(out.len() % BLIP_INTS, 0);
    out.chunks(BLIP_INTS).map(|c| [c[0], c[1], c[2], c[3], c[4]]).collect()
}

fn has_unit_blip(w: &World, player: u8, u: usize) -> bool {
    let (cx, cy) = w.cell_of(w.actors[u].x, w.actors[u].y);
    blips(w, player).iter().any(|b| b[0] == cx && b[1] == cy && b[2] == 1 && b[4] == w.actors[u].owner as i32)
}

fn has_building_blip(w: &World, player: u8, b: usize) -> bool {
    let a = &w.actors[b];
    blips(w, player).iter().any(|x| x[0] == a.cx && x[1] == a.cy && x[2] > 0 && x[4] == a.owner as i32)
}

#[test]
fn rules_carry_radar_and_jammer_data() {
    let w = duel();
    let dome = &w.rules.actors[ty(&w, "DOME") as usize];
    assert!(dome.abilities.provides_radar.as_ref().is_some_and(|p| p.jammable), "ProvidesRadar RequiresCondition !jammed");
    assert!(dome.requires_power, "!disabled: low power switches it off");
    let mrj = &w.rules.actors[ty(&w, "MRJ") as usize];
    assert_eq!(mrj.abilities.jams_radar.as_ref().map(|j| j.range), Some(18 * CELL), "ProximityExternalCondition@JAMMER Range 18c0");
    assert_eq!(mrj.abilities.jams_missiles.as_ref().map(|j| j.range), Some(5 * CELL), "missile jamming stays");
    let with_radar: Vec<&str> = w.rules.actors.iter().filter(|a| a.abilities.provides_radar.is_some()).map(|a| a.id.as_str()).collect();
    assert_eq!(with_radar, ["DOME"]);
}

#[test]
fn radar_needs_a_powered_radar_dome() {
    let mut w = duel();
    let tank = unit(&mut w, "2TNK", 0, 10, 10);
    assert_eq!(w.radar_state(0), RadarState::None);
    assert!(blips(&w, 0).is_empty(), "no radar: nothing on the minimap");
    let d = dome(&mut w, 0, 12, 4);
    assert_eq!(w.radar_state(0), RadarState::Online);
    assert!(has_unit_blip(&w, 0, tank));
    assert!(has_building_blip(&w, 0, d));
    assert_eq!(w.radar_state(1), RadarState::None, "radar is per player");
    // Low power switches it off (RequiresCondition !disabled).
    w.spawn_building(ty(&w, "IRON"), 0, 20, 4).unwrap();
    w.update_power();
    assert!(w.players[0].low_power());
    assert_eq!(w.radar_state(0), RadarState::LowPower);
    assert!(blips(&w, 0).is_empty());
    // Back online with more power; gone with the dome.
    for k in 0..4 {
        w.spawn_building(ty(&w, "APWR"), 0, 4 + k * 4, 14).unwrap();
    }
    w.update_power();
    assert_eq!(w.radar_state(0), RadarState::Online);
    w.kill(d);
    run(&mut w, 2);
    assert_eq!(w.radar_state(0), RadarState::None);
}

#[test]
fn enemy_units_show_only_while_visible_and_structures_as_remembered() {
    let mut w = duel();
    dome(&mut w, 0, 12, 4);
    let far = unit(&mut w, "3TNK", 1, 60, 60);
    let silo = w.spawn_building(ty(&w, "SILO"), 1, 40, 40).unwrap();
    w.update_vision();
    assert!(!w.is_visible_to(far, 0));
    assert!(!has_unit_blip(&w, 0, far), "unseen enemy units stay off the radar");
    assert!(!has_building_blip(&w, 0, silo), "never seen: not on the radar");
    // A scout sees both; the silo is remembered after the scout leaves.
    let scout = unit(&mut w, "E1", 0, 41, 43);
    w.actors[far].x = cell_center(41);
    w.actors[far].y = cell_center(46);
    run(&mut w, 2);
    assert!(w.is_visible_to(far, 0) && has_unit_blip(&w, 0, far));
    assert!(has_building_blip(&w, 0, silo));
    w.kill(scout);
    run(&mut w, 2);
    assert!(!w.is_visible_to(far, 0));
    assert!(!has_unit_blip(&w, 0, far), "units under fog disappear");
    assert!(has_building_blip(&w, 0, silo), "structures under fog stay as last seen");
}

#[test]
fn cloaked_and_gap_shrouded_enemies_stay_hidden() {
    let mut w = arena(&[("france", 0, (4, 4)), ("england", 0, (88, 88))]);
    dome(&mut w, 1, 80, 80);
    // The enemy watches the area with a tank, but a Phase Transport cloaks there.
    unit(&mut w, "2TNK", 1, 40, 46);
    let stnk = unit(&mut w, "STNK", 0, 40, 40);
    run(&mut w, 130);
    assert!(w.actors[stnk].ab.cloaked && w.is_cloaked_from(stnk, 1));
    assert!(!has_unit_blip(&w, 1, stnk), "cloaked units stay off enemy radar");
    // A Mobile Gap Generator shrouds the area around it for its enemies.
    let mgg = unit(&mut w, "MGG", 0, 40, 38);
    let hidden = unit(&mut w, "1TNK", 0, 42, 38);
    run(&mut w, 2);
    assert!(w.gen_shrouded(1, w.map.idx(42, 38)));
    assert!(!has_unit_blip(&w, 1, hidden) && !has_unit_blip(&w, 1, mgg), "nothing shows through gap shroud");
}

#[test]
fn enemy_radar_jammer_takes_the_dome_offline() {
    let mut w = duel();
    let d = dome(&mut w, 0, 12, 4);
    let (dx, dy) = (w.actors[d].x, w.actors[d].y);
    // 17 cells from the dome centre: inside the 18c0 range.
    let mrj = unit(&mut w, "MRJ", 1, 13 + 17, 5);
    assert!(dist_sq(w.actors[mrj].x, w.actors[mrj].y, dx, dy) <= (18 * CELL as i64).pow(2));
    assert_eq!(w.radar_state(0), RadarState::Jammed);
    assert!(blips(&w, 0).is_empty(), "jammed radar shows nothing");
    // Out of range: the radar comes back.
    w.actors[mrj].x = cell_center(13 + 20);
    assert_eq!(w.radar_state(0), RadarState::Online);
    // Own and allied jammers never jam.
    w.actors[mrj].x = cell_center(13 + 17);
    w.actors[mrj].owner = 0;
    assert_eq!(w.radar_state(0), RadarState::Online);
    // A jammer inside a transport does not jam.
    w.actors[mrj].owner = 1;
    w.actors[mrj].carrier = w.make_ref(d);
    assert_eq!(w.radar_state(0), RadarState::Online);
}

#[test]
fn enemy_radar_jammer_hides_actors_near_it_from_enemy_radar() {
    let mut w = arena(&[("england", 0, (4, 4)), ("russia", 0, (88, 88)), ("germany", 1, (4, 88)), ("ukraine", 1, (88, 4))]);
    dome(&mut w, 0, 12, 4);
    dome(&mut w, 1, 80, 80);
    // A Soviet jammer far from every dome, with a Soviet tank and a silo near it,
    // all watched by an Allied rifleman.
    let mrj = unit(&mut w, "MRJ", 1, 48, 48);
    let tank = unit(&mut w, "3TNK", 1, 50, 50);
    let silo = w.spawn_building(ty(&w, "SILO"), 1, 49, 46).unwrap();
    let watcher = unit(&mut w, "JEEP", 0, 47, 47);
    // Player 2 is an enemy of both; its tank stands next to the jammer too.
    let third = unit(&mut w, "1TNK", 2, 46, 49);
    run(&mut w, 2);
    assert_eq!(w.radar_state(0), RadarState::Online, "the jammer is too far from the dome");
    assert!(w.is_visible_to(tank, 0) && w.is_visible_to(silo, 0) && w.is_visible_to(mrj, 0));
    assert!(!has_unit_blip(&w, 0, tank) && !has_unit_blip(&w, 0, mrj), "jammed enemy units are off the radar");
    assert!(!has_building_blip(&w, 0, silo), "jammed enemy structures too");
    assert!(!has_unit_blip(&w, 0, third), "everything hostile near the jammer is hidden");
    assert!(has_unit_blip(&w, 0, watcher), "own units near an enemy jammer still show");
    // The jammer's owner and its allies see everything of their own.
    assert!(has_unit_blip(&w, 1, tank) && has_unit_blip(&w, 1, mrj) && has_building_blip(&w, 1, silo));
    // An enemy far from the jammer still shows.
    w.actors[tank].x = cell_center(50 + 20);
    w.actors[watcher].x = cell_center(47 + 22);
    run(&mut w, 2);
    assert!(w.is_visible_to(tank, 0));
    assert!(has_unit_blip(&w, 0, tank), "outside the 18c0 range it shows again");
    // Once the jammer dies the silo is shown as remembered.
    w.kill(mrj);
    run(&mut w, 2);
    assert!(has_building_blip(&w, 0, silo));
}

#[test]
fn neutral_actors_use_the_neutral_owner() {
    let mut w = duel();
    dome(&mut w, 0, 12, 4);
    let f = w.players[0].faction;
    w.add_player(f, false, (50, 50));
    w.players[2].neutral = true;
    w.ai.push(crate::ai::AiState::new(&w.rules, 2, Default::default(), crate::world::AiDifficulty::Easy));
    w.players[2].explored.iter_mut().for_each(|e| *e = 1);
    let hut = w.spawn_building(ty(&w, "SILO"), 2, 14, 10).unwrap();
    run(&mut w, 2);
    let a = &w.actors[hut];
    assert!(blips(&w, 0).iter().any(|b| b[0] == a.cx && b[1] == a.cy && b[4] == NEUTRAL_OWNER));
}

#[test]
fn minimap_reads_never_change_the_simulation() {
    let make = || {
        let mut w = World::new(11, 64, &[("england", true), ("russia", true)]);
        w.options.fog = true;
        w
    };
    let (mut a, mut b) = (make(), make());
    let mut out = Vec::new();
    for t in 0..25 * 60 {
        a.step();
        b.step();
        if t % 10 == 0 {
            for p in 0..2 {
                let _ = a.radar_state(p);
                a.minimap_blips(p, &mut out);
            }
        }
    }
    assert_eq!(a.state_hash(), b.state_hash());
}

/// Every enemy blip must stand for something the player sees right now (or a
/// remembered structure), never near an enemy radar jammer, and the radar must
/// be online. Own actors must all be there while it is.
fn check_no_leaks(w: &World, player: u8) {
    let list = blips(w, player);
    let state = w.radar_state(player);
    if state != RadarState::Online {
        assert!(list.is_empty(), "offline radar ({state:?}) shows nothing");
        return;
    }
    let jammers: Vec<(i32, i32, i64)> = w
        .actors
        .iter()
        .filter(|a| a.alive && a.in_world() && !w.are_allies(a.owner, player))
        .filter_map(|a| w.rules.actors[a.ty as usize].abilities.jams_radar.as_ref().map(|j| (a.x, a.y, j.range as i64 * j.range as i64)))
        .collect();
    let jammed = |x: i32, y: i32| jammers.iter().any(|&(jx, jy, r)| dist_sq(jx, jy, x, y) <= r);
    // What the player may see of enemies right now: unit cells and structure corners.
    let owner_of = |o: u8| if w.players[o as usize].neutral { NEUTRAL_OWNER } else { o as i32 };
    let mut allowed: HashSet<[i32; BLIP_INTS]> = HashSet::new();
    for (i, a) in w.actors.iter().enumerate() {
        if !a.alive
            || a.kind == Kind::Mine
            || !a.in_world()
            || !w.is_visible_to(i, player)
            || w.is_cloaked_from(i, player)
            || jammed(a.x, a.y)
        {
            continue;
        }
        if a.kind == Kind::Building {
            let bi = w.rules.actors[a.ty as usize].building.as_ref().unwrap();
            allowed.insert([a.cx, a.cy, bi.width, bi.height, owner_of(a.owner)]);
        } else {
            let (cx, cy) = w.cell_of(a.x, a.y);
            allowed.insert([cx, cy, 1, 1, owner_of(a.owner)]);
        }
    }
    for g in w.players[player as usize].ghosts.values() {
        let bi = w.rules.actors[g.ty as usize].building.as_ref().unwrap();
        if !w.gen_shrouded(player, w.map.idx(g.cx, g.cy)) && !jammed(g.cx * CELL + bi.width * CELL / 2, g.cy * CELL + bi.height * CELL / 2)
        {
            allowed.insert([g.cx, g.cy, bi.width, bi.height, owner_of(g.owner)]);
        }
    }
    for b in &list {
        // Trees, mines and walls in their terrain colour (neutral.rs): only on cells the player explored.
        if b[4] >= crate::neutral::RADAR_TERRAIN {
            assert!(
                w.players[player as usize].explored[w.map.idx(b[0], b[1])] != 0,
                "player {player} sees terrain blip {b:?} it never explored"
            );
            continue;
        }
        if b[4] != NEUTRAL_OWNER && w.are_allies(b[4] as u8, player) {
            continue;
        }
        assert!(allowed.contains(b), "player {player} sees enemy blip {b:?} it should not");
    }
    for (i, a) in w.actors.iter().enumerate() {
        if a.alive && a.owner == player && a.is_unit() && a.in_world() {
            let (cx, cy) = w.cell_of(a.x, a.y);
            assert!(list.iter().any(|b| b[0] == cx && b[1] == cy && b[4] == player as i32), "own actor {i} missing");
        }
    }
}

#[test]
fn ai_games_never_leak_hidden_or_jammed_enemies() {
    // Hard AIs build radar domes, gap generators and cloaked units, and one has a radar jammer.
    let hard = |f: &str| crate::world::PlayerSetup::new(f, Some(crate::world::AiDifficulty::Hard));
    // Without the tech buildings of a generated map (mapgen/settlements.rs).
    let options = crate::world::GameOptions { tech_buildings: crate::mapgen::settlements::TechBuildings::None, ..Default::default() };
    let mut w = World::with_options(5, 80, &[hard("england"), hard("russia"), hard("france")], options);
    // OpenRA's bots never build radar jammers: the Soviet AI gets one.
    let (sx, sy) = w.players[1].start;
    let mrj = w.rules.actor_index("MRJ").unwrap() as u16;
    w.spawn_unit(mrj, 1, crate::world::cell_center(sx + 1), crate::world::cell_center(sy + 5), 512);
    let mut online = [false; 3];
    let mut had_dome = [false; 3];
    let mut saw_jammer = false;
    for step in 0..(25 * 60 * 12) {
        w.step();
        if step % 50 == 0 {
            for p in 0..3u8 {
                online[p as usize] |= w.radar_state(p) == RadarState::Online;
                had_dome[p as usize] |=
                    w.actors.iter().any(|a| a.alive && a.owner == p && w.rules.actors[a.ty as usize].abilities.provides_radar.is_some());
                check_no_leaks(&w, p);
            }
            saw_jammer |= w.actors.iter().any(|a| a.alive && w.rules.actors[a.ty as usize].abilities.jams_radar.is_some());
        }
    }
    // An AI overrun before its radar dome stood never gets one; the others do.
    assert!(online.iter().zip(&had_dome).all(|(&o, &d)| o || !d), "every AI with a radar dome got its radar online");
    assert!(online.iter().filter(|&&o| o).count() >= 2, "AIs build radar domes: {online:?}");
    assert!(saw_jammer, "the radar jammer took part");
}

// ---- Spectator radar (Game::radar_state, Game::minimap_blips) ------------------------------

use crate::combined::COMBINED;
use crate::observer::OBSERVER;
use crate::Game;

fn game_blips(g: &mut Game, player: u8) -> Vec<[i32; BLIP_INTS]> {
    let out = g.minimap_blips(player);
    assert_eq!(out.len() % BLIP_INTS, 0);
    out.chunks(BLIP_INTS).map(|c| [c[0], c[1], c[2], c[3], c[4]]).collect()
}

fn unit_blip(w: &World, u: usize) -> [i32; BLIP_INTS] {
    let (cx, cy) = w.cell_of(w.actors[u].x, w.actors[u].y);
    [cx, cy, 1, 1, w.actors[u].owner as i32]
}

fn building_blip(w: &World, b: usize, owner: i32) -> [i32; BLIP_INTS] {
    let a = &w.actors[b];
    let bi = w.rules.actors[a.ty as usize].building.as_ref().unwrap();
    [a.cx, a.cy, bi.width, bi.height, owner]
}

/// Players 0 (France) and 1 (England) with radar domes and a neutral player 2
/// with a silo nobody sees. Player 0's Phase Transport cloaks next to player
/// 1's tank, and player 1's radar jammer stands next to its own tank, watched
/// by a player 0 jeep.
struct Spectated {
    g: Game,
    silo: usize,
    stnk: usize,
    jammed_tank: usize,
    mrj: usize,
    far: usize,
}

fn spectated() -> Spectated {
    let mut w = arena(&[("france", 0, (4, 4)), ("england", 0, (88, 88))]);
    dome(&mut w, 0, 12, 4);
    dome(&mut w, 1, 80, 80);
    let f = w.players[0].faction;
    w.add_player(f, false, (50, 50));
    w.players[2].neutral = true;
    w.ai.push(crate::ai::AiState::new(&w.rules, 2, Default::default(), crate::world::AiDifficulty::Easy));
    w.players[2].explored.iter_mut().for_each(|e| *e = 1);
    let silo = w.spawn_building(ty(&w, "SILO"), 2, 50, 30).unwrap();
    unit(&mut w, "2TNK", 1, 40, 46);
    let stnk = unit(&mut w, "STNK", 0, 40, 40);
    let mrj = unit(&mut w, "MRJ", 1, 30, 70);
    let jammed_tank = unit(&mut w, "3TNK", 1, 32, 70);
    unit(&mut w, "JEEP", 0, 29, 69);
    // A player 1 tank no other player sees.
    let far = unit(&mut w, "3TNK", 1, 70, 20);
    run(&mut w, 130);
    Spectated { g: Game::wrap(w), silo, stnk, jammed_tank, mrj, far }
}

#[test]
fn the_spectator_radar_is_always_online() {
    let mut w = duel();
    // Nobody has a radar dome: the players' radars are off, the spectators' are on.
    w.update_vision();
    let mut g = Game::wrap(w);
    assert_eq!(g.radar_state(0), RadarState::None as u8);
    assert!(g.minimap_blips(0).is_empty());
    assert_eq!(g.radar_state(OBSERVER), RadarState::Online as u8);
    assert_eq!(g.radar_state(COMBINED), RadarState::Online as u8);
    assert!(!game_blips(&mut g, OBSERVER).is_empty());
    assert!(!game_blips(&mut g, COMBINED).is_empty());
    // The radar's fog layer (`fog_ptr`): none for the whole map, every player's together for the combined view.
    g.fog_ptr(OBSERVER);
    assert!(g.fog.iter().all(|&f| f == 255), "no fog in the whole map view");
    let mut combined = Vec::new();
    g.world.combined_fog_bytes(&mut combined);
    g.fog_ptr(COMBINED);
    assert_eq!(g.fog, combined);
    assert!(g.fog.contains(&0) || g.fog.contains(&128), "the combined view keeps fog where nobody looks");
    // Other unknown players still get nothing.
    assert_eq!(g.radar_state(7), RadarState::None as u8);
    assert!(g.minimap_blips(7).is_empty());
}

#[test]
fn the_whole_map_radar_shows_every_structure_and_unit_without_fog_cloak_or_jammers() {
    let Spectated { mut g, silo, stnk, jammed_tank, mrj, far } = spectated();
    let w = &g.world;
    assert!(w.actors[stnk].ab.cloaked && w.is_cloaked_from(stnk, 1), "the Phase Transport is cloaked");
    assert!(w.is_visible_to(jammed_tank, 0) && !has_unit_blip(w, 0, jammed_tank), "player 0's radar is jammed there");
    assert!(
        !(0..2).any(|p| w.is_visible_to(silo, p)) && !w.is_visible_to(far, 0),
        "no player sees the neutral silo, player 0 not the far tank"
    );
    let expect: Vec<[i32; BLIP_INTS]> =
        vec![building_blip(w, silo, NEUTRAL_OWNER), unit_blip(w, stnk), unit_blip(w, jammed_tank), unit_blip(w, mrj), unit_blip(w, far)];
    let mut every = Vec::new();
    for (i, a) in w.actors.iter().enumerate() {
        if !a.alive || a.kind == Kind::Mine || !a.in_world() {
            continue;
        }
        let owner = if w.players[a.owner as usize].neutral { NEUTRAL_OWNER } else { a.owner as i32 };
        let rules = &w.rules.actors[a.ty as usize];
        if a.kind == Kind::Building {
            if rules.world.bridge.is_some() || rules.world.bridge_hut || w.radar_terrain_code(i).is_some() {
                continue;
            }
            every.push(building_blip(w, i, owner));
        } else {
            every.push(unit_blip(w, i));
        }
    }
    let list = game_blips(&mut g, OBSERVER);
    for b in expect.iter().chain(&every) {
        assert!(list.contains(b), "the observer's radar shows {b:?}");
    }
    assert_eq!(list.len(), every.len(), "and nothing else: no remembered structures");
    assert!(!g.world.render_all, "the flag is cleared after the call");
}

#[test]
fn the_combined_radar_shows_what_any_player_sees() {
    let Spectated { mut g, silo, stnk, jammed_tank, mrj, far } = spectated();
    let before = (g.world.players[0].visible.clone(), g.world.players[0].explored.clone(), g.world.players[0].ghosts.len());
    let list = game_blips(&mut g, COMBINED);
    let w = &g.world;
    // Every player's own actors, cloaked or next to a jammer: their owner sees them.
    for u in [stnk, jammed_tank, mrj, far] {
        assert!(list.contains(&unit_blip(w, u)), "actor {u} shows");
    }
    assert!(!has_unit_blip(w, 1, stnk), "player 1's own radar misses the cloaked Phase Transport");
    // The neutral silo nobody sees stays off.
    assert!(!list.contains(&building_blip(w, silo, NEUTRAL_OWNER)), "unseen neutral structures stay hidden");
    assert!(!w.render_combined, "the flag is cleared after the call");
    assert_eq!((w.players[0].visible.clone(), w.players[0].explored.clone(), w.players[0].ghosts.len()), before, "slot 0 is restored");
    // Once a player looks at the silo, it shows.
    let t = ty(&g.world, "E1");
    let scout = g.world.spawn_unit(t, 1, cell_center(51), cell_center(33), 0);
    g.world.actors[scout].reload = [1_000_000; MAX_WEAPONS];
    g.world.update_vision();
    assert!(g.world.is_visible_to(silo, 1));
    let w_silo = building_blip(&g.world, silo, NEUTRAL_OWNER);
    assert!(game_blips(&mut g, COMBINED).contains(&w_silo), "seen by player 1: on the combined radar");
}

#[test]
fn spectator_radar_reads_never_change_the_simulation() {
    let make = || {
        let mut w = World::new(11, 64, &[("england", true), ("russia", true)]);
        w.options.fog = true;
        w
    };
    let mut a = Game::wrap(make());
    let mut b = make();
    for t in 0..25 * 30 {
        a.world.step();
        b.step();
        if t % 10 == 0 {
            for p in [OBSERVER, COMBINED] {
                let _ = a.radar_state(p);
                let _ = a.minimap_blips(p);
            }
        }
    }
    assert_eq!(a.world.state_hash(), b.state_hash());
    assert!(!a.world.render_all && !a.world.render_combined);
}

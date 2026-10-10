//! Ground units and terrain (map.rs, flowfield.rs, units.rs): every
//! locomotor goes only where OpenRA's world.yaml TerrainSpeeds let it (no
//! entry or 0: impassable), on hand-made maps, map files and generated maps
//! of every style. Fords are WebRA's own (generated maps): ground units wade
//! through at rough speed and ships sail over them.

use std::collections::BTreeMap;

use crate::map::{Map, Terrain, SPEED_BEACH, TERRAIN_COUNT};
use crate::mapdata::MapData;
use crate::mapgen::MapStyle;
use crate::math::CELL;
use crate::rules::{Domain, Kind, Locomotor};
use crate::world::{cell_center, AiDifficulty, GameOptions, Order, PlayerSetup, StartingUnits, World};

/// OpenRA's RA world rules: the Locomotor traits and their TerrainSpeeds.
const WORLD_YAML: &str = include_str!("../../data/source/rules/world.yaml");

/// Locomotor name -> terrain type -> speed percent, from world.yaml.
fn openra_speeds() -> BTreeMap<String, BTreeMap<String, i32>> {
    let mut out: BTreeMap<String, BTreeMap<String, i32>> = BTreeMap::new();
    let (mut name, mut in_speeds) = (None::<String>, false);
    for line in WORLD_YAML.lines() {
        let depth = line.len() - line.trim_start_matches('\t').len();
        let text = line.trim();
        if depth <= 1 {
            name = None;
            in_speeds = false;
            if depth == 1 && text.starts_with("Locomotor@") {
                name = Some(String::new());
            }
            continue;
        }
        let Some(n) = name.as_mut() else { continue };
        if depth == 2 {
            in_speeds = text == "TerrainSpeeds:";
            if let Some(v) = text.strip_prefix("Name: ") {
                *n = v.to_string();
            }
        } else if depth == 3 && in_speeds {
            let (t, v) = text.split_once(':').unwrap();
            out.entry(n.clone()).or_default().insert(t.trim().to_string(), v.trim().parse().unwrap());
        }
    }
    out
}

fn all_terrains() -> Vec<Terrain> {
    (0..TERRAIN_COUNT).map(|v| Terrain::from_u8(v).unwrap()).collect()
}

/// Landing craft: ships that also drive on beaches (World::lands).
fn lands(l: &Locomotor) -> bool {
    l.domain == Domain::Water && l.speeds[SPEED_BEACH] > 0
}

/// Whether the engine's passability for locomotor `l` opens terrain `t`.
fn engine_open(l: &Locomotor, t: Terrain) -> bool {
    match l.domain {
        Domain::Water if lands(l) => t.landing_passable(),
        Domain::Water => t.ship_passable(),
        _ => t.passable(),
    }
}

#[test]
fn every_locomotor_follows_openras_terrain_speeds() {
    let speeds = openra_speeds();
    let w = World::new(1, 32, &[("allies", false), ("soviet", false)]);
    let mut checked = 0;
    for l in w.rules.locomotors.iter().filter(|l| l.domain != Domain::Air) {
        let table = speeds.get(&l.name).unwrap_or_else(|| panic!("{} is not an OpenRA locomotor", l.name));
        for t in all_terrains() {
            if t == Terrain::Ford {
                continue;
            }
            let openra = table.get(t.name()).copied().unwrap_or(0);
            assert_eq!(engine_open(l, t), openra > 0, "{} on {}: OpenRA speed {openra}", l.name, t.name());
            if openra > 0 {
                let m = Map::filled(1, 1, t);
                let ship = l.domain == Domain::Water;
                assert_eq!(l.speeds[m.speed_class_for(0, ship)], openra, "{} speed on {}", l.name, t.name());
            }
            checked += 1;
        }
        // Ore and gems lie on clear ground, roads and rough ground; OpenRA's resource layer makes them their own types.
        for (res, ore) in [("Ore", true), ("Gems", false)] {
            let mut m = Map::filled(1, 1, Terrain::Clear);
            if ore {
                m.ore[0] = 5;
            } else {
                m.gems[0] = 2;
            }
            let openra = table.get(res).copied().unwrap_or(0);
            if l.domain == Domain::Ground {
                assert_eq!(l.speeds[m.speed_class(0)], openra, "{} speed on {res}", l.name);
            } else {
                assert_eq!(openra, 0, "{} on {res}", l.name);
            }
        }
        // Fords (WebRA's generated river crossings): ground at rough speed, ships at water speed.
        let ford = Map::filled(1, 1, Terrain::Ford);
        match l.domain {
            Domain::Ground => assert_eq!(l.speeds[ford.speed_class_for(0, false)], table["Rough"], "{} on a ford", l.name),
            _ => assert_eq!(l.speeds[ford.speed_class_for(0, true)], table["Water"], "{} on a ford", l.name),
        }
        assert!(engine_open(l, Terrain::Ford));
    }
    assert!(checked >= 8 * 10, "every locomotor and terrain type");
}

// ---- Units on the map ---------------------------------------------------------------------

/// Ground units of `w` standing on terrain their locomotor cannot use (units
/// walking into an Enter target or leaping dogs pass through, like OpenRA's
/// MoveIntoTarget and the dog's leap).
fn units_off_their_ground(w: &World) -> Vec<String> {
    let mut out = Vec::new();
    for (i, a) in w.actors.iter().enumerate() {
        if !a.alive || !a.is_unit() || !a.in_world() || a.altitude > 0 || a.air.parachute || w.passes_through(i) {
            continue;
        }
        let Some(u) = w.rules.actors[a.ty as usize].unit.as_ref() else { continue };
        let l = &w.rules.locomotors[u.locomotor];
        if l.domain == Domain::Air {
            continue;
        }
        let ci = w.cell_index(a.x, a.y);
        let t = w.map.terrain[ci];
        if !engine_open(l, t) || l.speeds[w.map.speed_class_for(ci, l.domain == Domain::Water)] == 0 {
            let id = &w.rules.actors[a.ty as usize].id;
            out.push(format!("tick {}: {id} ({}) on {} at {:?}, {:?}", w.tick, l.name, t.name(), w.cell_of(a.x, a.y), a.activity));
        }
    }
    out
}

/// One unit type per ground locomotor of the rules (soldiers, wheels, tracks, ...).
fn one_per_ground_locomotor(w: &World) -> Vec<u16> {
    let mut out: Vec<u16> = Vec::new();
    let mut seen = Vec::new();
    for (t, a) in w.rules.actors.iter().enumerate() {
        let Some(u) = a.unit.as_ref() else { continue };
        if !matches!(a.kind, Kind::Infantry | Kind::Vehicle) || seen.contains(&u.locomotor) {
            continue;
        }
        if w.rules.locomotors[u.locomotor].domain == Domain::Ground {
            seen.push(u.locomotor);
            out.push(t as u16);
        }
    }
    let ground = w.rules.locomotors.iter().filter(|l| l.domain == Domain::Ground).count();
    assert_eq!(out.len(), ground, "a unit for every ground locomotor");
    out
}

/// A 48 x 32 map file: a river (x 22..24) the whole height, crossed by a
/// bridge (row 6) and a ford (row 25); a lake with a beach, rock, walls and
/// a road west of it. Two players without AI, explored.
fn river_world() -> World {
    let mut m = Map::filled(48, 32, Terrain::Clear);
    m.spawns = vec![(2, 28), (44, 28)];
    let set = |m: &mut Map, x: i32, y: i32, t: Terrain| {
        let i = m.idx(x, y);
        m.terrain[i] = t;
    };
    for y in 0..32 {
        for x in 22..25 {
            let t = match y {
                6 => Terrain::Bridge,
                25 => Terrain::Ford,
                _ => Terrain::River,
            };
            set(&mut m, x, y, t);
        }
    }
    for y in 10..18 {
        for x in 6..16 {
            let edge = y == 10 || y == 17 || x == 6 || x == 15;
            set(&mut m, x, y, if edge { Terrain::Beach } else { Terrain::Water });
        }
    }
    for x in 0..22 {
        set(&mut m, x, 4, Terrain::Road);
    }
    for y in 19..23 {
        set(&mut m, 18, y, Terrain::Rock);
        set(&mut m, 19, y, Terrain::Wall);
    }
    let d = MapData::from_map(&m, "Rivers", "Test", "");
    assert!(d.validate().ok, "{:?}", d.validate().errors);
    let players = [PlayerSetup::new("england", None), PlayerSetup::new("russia", None)];
    let options = GameOptions { starting_units: StartingUnits::Base, fog: false, ..GameOptions::default() };
    let mut w = World::from_map(&d, 5, &players, options).expect("world");
    for p in w.players.iter_mut() {
        p.explored.iter_mut().for_each(|e| *e = 1);
    }
    w
}

/// Step `ticks`, failing as soon as a ground unit stands where it cannot.
fn run_checked(w: &mut World, ticks: u32, what: &str) {
    for _ in 0..ticks {
        w.step();
        let bad = units_off_their_ground(w);
        assert!(bad.is_empty(), "{what}: {:?}", &bad[..bad.len().min(5)]);
    }
}

#[test]
fn every_ground_locomotor_crosses_a_river_only_on_the_bridge_or_the_ford() {
    let mut w = river_world();
    let types = one_per_ground_locomotor(&w);
    let units: Vec<usize> = types
        .iter()
        .enumerate()
        .map(|(k, &t)| w.spawn_unit(t, 0, cell_center(3 + (k as i32 % 3) * 2), cell_center(20 + k as i32 / 3 * 2), 0))
        .collect();
    let ids: Vec<u32> = units.iter().map(|&i| w.make_ref(i)).collect();
    // Across the river, far from both crossings, then into the lake.
    w.queue_order(Order::Move { player: 0, ids: ids.clone(), x: cell_center(40), y: cell_center(15), attack_move: false });
    let mut crossings: Vec<Terrain> = Vec::new();
    for _ in 0..25 * 90 {
        w.step();
        let bad = units_off_their_ground(&w);
        assert!(bad.is_empty(), "{:?}", &bad[..bad.len().min(5)]);
        for &i in &units {
            let (cx, _) = w.cell_of(w.actors[i].x, w.actors[i].y);
            if (22..25).contains(&cx) {
                crossings.push(w.map.terrain[w.cell_index(w.actors[i].x, w.actors[i].y)]);
            }
        }
    }
    for &i in &units {
        let id = &w.rules.actors[w.actors[i].ty as usize].id;
        assert!(w.actors[i].x > cell_center(30), "{id} crossed the river");
    }
    assert!(!crossings.is_empty() && crossings.iter().all(|t| matches!(t, Terrain::Bridge | Terrain::Ford)), "{crossings:?}");
    w.queue_order(Order::Move { player: 0, ids, x: cell_center(11), y: cell_center(14), attack_move: false });
    run_checked(&mut w, 25 * 90, "ordered into the lake");
    for &i in &units {
        let ci = w.cell_index(w.actors[i].x, w.actors[i].y);
        assert!(w.map.terrain[ci].passable(), "on the shore, not in the lake");
        assert!(w.actors[i].x < cell_center(22), "came back over a crossing");
    }
}

#[test]
fn ground_units_never_drive_into_water_on_generated_maps() {
    let mut rng = crate::rng::Rng::new(11);
    for style in MapStyle::CONCRETE {
        for (seed, biome) in [(3u64, crate::weather::Biome::Temperate), (8, crate::weather::Biome::Snow)] {
            // A player who sends everything anywhere, the AI against them.
            let players = vec![PlayerSetup::new("allies", None), PlayerSetup::new("soviet", Some(AiDifficulty::Normal))];
            let options = GameOptions { map_style: style, biome: Some(biome), ..GameOptions::default() };
            let mut w = World::with_options(seed, 72, &players, options);
            let what = format!("{style:?} {biome:?} seed {seed}");
            assert!(units_off_their_ground(&w).is_empty(), "{what} at the start");
            w.players[0].explored.iter_mut().for_each(|e| *e = 1);
            let (sx, sy) = w.players[0].start;
            let mut mine = Vec::new();
            for (k, &t) in one_per_ground_locomotor(&w).iter().enumerate() {
                for j in 0..3 {
                    let (cx, cy) = (sx + 5 + k as i32 % 3, sy - 3 + k as i32 / 3 + j * 3);
                    if w.map.contains(cx, cy) && !w.pass.blocked[w.map.idx(cx, cy)] {
                        mine.push(w.spawn_unit(t, 0, cell_center(cx), cell_center(cy), 0));
                    }
                }
            }
            for round in 0..20 {
                let ids: Vec<u32> = mine.iter().filter(|&&i| w.actors[i].alive).map(|&i| w.make_ref(i)).collect();
                // Mostly onto open water (the order must stop at the shore).
                let (x, y) = loop {
                    let (x, y) = (rng.range(0, w.map.width * CELL), rng.range(0, w.map.height * CELL));
                    let ci = w.cell_index(x, y);
                    if round % 3 == 0 || !w.map.terrain[ci].passable() {
                        break (x, y);
                    }
                };
                let order = match round % 4 {
                    0 => Order::Move { player: 0, ids, x, y, attack_move: false },
                    1 => Order::Smart { player: 0, ids, x, y },
                    2 => Order::Move { player: 0, ids, x, y, attack_move: true },
                    _ => Order::Scatter { player: 0, ids },
                };
                w.queue_order(order);
                run_checked(&mut w, 150, &what);
            }
        }
    }
}

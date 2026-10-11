//! Ships stay on water (naval.rs, units.rs, flowfield.rs): every way a ship
//! moves or appears keeps it on cells its locomotor can enter. OpenRA's RA
//! world.yaml: `naval` (Destroyer, Cruiser, Gunboat, Submarine, Missile
//! Submarine) has TerrainSpeeds Water only, `lcraft` (the Transport) Water
//! and Beach, so it runs up on beaches to load and unload. Fords are WebRA's
//! own river crossings on generated maps: land to every ship, as OpenRA's
//! ford templates (Rough and Road) are (map.rs Terrain::Ford).

use crate::map::{Map, Terrain};
use crate::mapdata::{MapActor, MapData};
use crate::mapgen::MapStyle;
use crate::rules::{Domain, Kind, Rules};
use crate::world::{cell_center, AiDifficulty, GameOptions, Order, PlayerSetup, StartingUnits, World, NONE};

/// Every ship type of the rules: the five on `naval` and the Transport on `lcraft`.
const SHIPS: [&str; 6] = ["DD", "CA", "PT", "SS", "MSUB", "LST"];

fn ty(w: &World, id: &str) -> u16 {
    w.rules.actor_index(id).unwrap() as u16
}

/// Ships (and other water units) standing where they cannot: on terrain
/// their locomotor does not enter, or inside a structure.
fn ships_off_their_water(w: &World) -> Vec<String> {
    let mut out = Vec::new();
    for (i, a) in w.actors.iter().enumerate() {
        if !a.alive || !a.is_unit() || !a.in_world() || w.domain_of(i) != Domain::Water {
            continue;
        }
        let ci = w.cell_index(a.x, a.y);
        let t = w.map.terrain[ci];
        if !w.terrain_open_to(a.ty as usize, t) || w.pass_of(i).blocked[ci] {
            let id = &w.rules.actors[a.ty as usize].id;
            out.push(format!("tick {}: {id} on {} at {:?} ({:?})", w.tick, t.name(), w.cell_of(a.x, a.y), a.activity));
        }
    }
    out
}

/// Last cell of every ship, to catch steps that squeeze diagonally between two cells it cannot enter.
struct Steps(Vec<Option<(i32, i32)>>);

impl Steps {
    fn new(w: &World) -> Steps {
        Steps(vec![None; w.actors.len()])
    }

    fn check(&mut self, w: &World, what: &str) {
        self.0.resize(w.actors.len(), None);
        for (i, a) in w.actors.iter().enumerate() {
            if !a.alive || !a.in_world() || !a.is_unit() || w.domain_of(i) != Domain::Water {
                self.0[i] = None;
                continue;
            }
            let c = w.cell_of(a.x, a.y);
            if let Some(p) = self.0[i] {
                // Farther than a cell in a tick is a teleport (the Chronosphere); one diagonal step must not squeeze.
                let step = (c.0 - p.0).abs() <= 1 && (c.1 - p.1).abs() <= 1;
                if step && c.0 != p.0 && c.1 != p.1 {
                    let open = |x: i32, y: i32| w.terrain_open_to(a.ty as usize, w.map.terrain[w.map.idx(x, y)]);
                    assert!(open(c.0, p.1) && open(p.0, c.1), "{what}: ship {i} cut the corner from {p:?} to {c:?}");
                }
            }
            self.0[i] = Some(c);
        }
    }
}

/// Step `ticks`, failing as soon as a ship stands or steps where it cannot.
fn run_checked(w: &mut World, ticks: u32, what: &str) {
    let mut steps = Steps::new(w);
    steps.check(w, what);
    for _ in 0..ticks {
        w.step();
        let bad = ships_off_their_water(w);
        assert!(bad.is_empty(), "{what}: {:?}", &bad[..bad.len().min(5)]);
        steps.check(w, what);
    }
}

/// A 64 x 48 coast. Land west of column 20; in the sea a staircase headland
/// (land where x < 32 - y in the top rows), a breakwater one cell wide along
/// row 24 (x 20..40), two land cells touching only at a corner (45, 30) and
/// (46, 31), and a beach along the coast from row 34 down. Two players with
/// a power plant each on land, everything explored.
fn harbour() -> World {
    let mut m = Map::filled(64, 48, Terrain::Water);
    m.spawns = vec![(2, 2), (2, 40)];
    let mut set = |x: i32, y: i32, t: Terrain| {
        let i = m.idx(x, y);
        m.terrain[i] = t;
    };
    for y in 0..48 {
        for x in 0..20 {
            set(x, y, Terrain::Clear);
        }
    }
    for y in 0..12 {
        for x in 20..32 - y {
            set(x, y, Terrain::Clear);
        }
    }
    for x in 20..40 {
        set(x, 24, Terrain::Rough);
    }
    set(45, 30, Terrain::Rock);
    set(46, 31, Terrain::Rock);
    for y in 34..48 {
        set(18, y, Terrain::Beach);
        set(19, y, Terrain::Beach);
    }
    let mut w = World::empty(Rules::load(), m, 17);
    for (f, start) in [("allies", (2, 2)), ("soviet", (2, 40))] {
        let fi = w.rules.faction_index(f).unwrap();
        w.add_player(fi, false, start);
    }
    for p in w.players.iter_mut() {
        p.cash = 50000;
        p.explored.iter_mut().for_each(|e| *e = 1);
    }
    let powr = ty(&w, "POWR");
    w.spawn_building(powr, 0, 2, 2).unwrap();
    w.spawn_building(powr, 1, 2, 40).unwrap();
    w.refresh_tokens();
    w.update_power();
    w.update_vision();
    w
}

fn ship(w: &mut World, id: &str, owner: u8, cx: i32, cy: i32) -> usize {
    let t = ty(w, id);
    w.spawn_unit(t, owner, cell_center(cx), cell_center(cy), 0)
}

fn order_move(w: &mut World, units: &[usize], cx: i32, cy: i32) {
    let ids = units.iter().map(|&i| w.make_ref(i)).collect();
    w.queue_order(Order::Move { player: w.actors[units[0]].owner, ids, x: cell_center(cx), y: cell_center(cy), attack_move: false });
}

fn terrain_under(w: &World, i: usize) -> Terrain {
    w.map.terrain[w.cell_index(w.actors[i].x, w.actors[i].y)]
}

// ---- Rules ------------------------------------------------------------------------------------

#[test]
fn ship_locomotors_open_water_and_only_the_transport_beaches() {
    let w = harbour();
    for id in SHIPS {
        let t = ty(&w, id) as usize;
        let u = w.rules.actors[t].unit.as_ref().unwrap();
        let loco = &w.rules.locomotors[u.locomotor];
        assert_eq!(loco.domain, Domain::Water, "{id}");
        assert_eq!(loco.name, if id == "LST" { "lcraft" } else { "naval" }, "{id}");
        let open: Vec<Terrain> =
            (0..crate::map::TERRAIN_COUNT).map(|v| Terrain::from_u8(v).unwrap()).filter(|&tt| w.terrain_open_to(t, tt)).collect();
        let want = if id == "LST" { vec![Terrain::Water, Terrain::Beach] } else { vec![Terrain::Water] };
        assert_eq!(open, want, "{id}");
        assert_eq!(w.type_lands(t), id == "LST");
    }
}

// ---- Pathfinding and steering ------------------------------------------------------------------

/// Flow fields and steering: around a staircase headland, a breakwater and
/// two land cells that touch at a corner, onto beaches and far inland. No
/// ship ever stands on land or slips diagonally between two land cells; the
/// Transport alone runs up on the beach.
#[test]
fn ships_sail_around_headlands_and_never_cut_across_land() {
    let mut w = harbour();
    let ships: Vec<usize> =
        SHIPS.iter().enumerate().map(|(k, id)| ship(&mut w, id, 0, 50 + (k as i32 % 3) * 3, 4 + (k as i32 / 3) * 3)).collect();
    // Past the staircase coast to the far side of the breakwater, close to it.
    order_move(&mut w, &ships, 24, 28);
    run_checked(&mut w, 25 * 60, "around the headland");
    for &i in &ships {
        let (_, cy) = w.cell_of(w.actors[i].x, w.actors[i].y);
        assert!(cy > 24, "{} got round the breakwater", w.rules.actors[w.actors[i].ty as usize].id);
    }
    // Back north through the corner-touching rocks, then into the corner of the staircase.
    for &i in &ships {
        order_move(&mut w, &[i], 46, 30);
    }
    run_checked(&mut w, 25 * 30, "onto the rocks");
    order_move(&mut w, &ships, 21, 12);
    run_checked(&mut w, 25 * 60, "into the staircase");
    // Deep inland and onto the beach: they stop at the shore, the Transport on the sand.
    order_move(&mut w, &ships, 5, 40);
    run_checked(&mut w, 25 * 60, "inland");
    for (&i, id) in ships.iter().zip(SHIPS) {
        let t = terrain_under(&w, i);
        if id == "LST" {
            assert_eq!(t, Terrain::Beach, "the Transport ran up on the beach");
        } else {
            assert_eq!(t, Terrain::Water, "{id} stopped at the shore");
        }
    }
}

/// A ford across a sound (a generated map's river crossing): tanks drive
/// over it, no ship sails over it, the Transport included; every ship
/// ordered to the far side stops at the ford.
#[test]
fn no_ship_sails_over_a_ford() {
    let mut w = harbour();
    // From the beach (the Transport's way round) to the far shore.
    for x in 18..64 {
        let i = w.map.idx(x, 36);
        w.map.terrain[i] = Terrain::Ford;
    }
    w.reset_passability();
    let ships: Vec<usize> = SHIPS.iter().enumerate().map(|(k, id)| ship(&mut w, id, 0, 24 + k as i32 * 5, 30)).collect();
    let tank = {
        let t = ty(&w, "2TNK");
        w.spawn_unit(t, 0, cell_center(21), cell_center(36), 0)
    };
    order_move(&mut w, &ships, 40, 44);
    order_move(&mut w, &[tank], 60, 36);
    run_checked(&mut w, 25 * 40, "toward the ford");
    for &i in &ships {
        let (_, cy) = w.cell_of(w.actors[i].x, w.actors[i].y);
        assert!(cy < 36, "{} stayed north of the ford", w.rules.actors[w.actors[i].ty as usize].id);
    }
    let (tx, _) = w.cell_of(w.actors[tank].x, w.actors[tank].y);
    assert!(tx >= 55, "the tank drove along the ford, at column {tx}");
}

/// Crowd separation: two fleets meet head-on in a channel two cells wide and
/// push each other; nobody is pushed onto the banks.
#[test]
fn ships_pushing_through_a_narrow_channel_stay_on_water() {
    let mut m = Map::filled(64, 40, Terrain::Clear);
    m.spawns = vec![(2, 2), (2, 34)];
    for y in 0..40 {
        for x in 0..64 {
            let open_sea = !(12..52).contains(&x) && (8..32).contains(&y);
            let channel = (19..21).contains(&y);
            if open_sea || channel {
                let i = m.idx(x, y);
                m.terrain[i] = Terrain::Water;
            }
        }
    }
    let mut w = World::empty(Rules::load(), m, 5);
    for (f, start) in [("allies", (2, 2)), ("soviet", (2, 34))] {
        let fi = w.rules.faction_index(f).unwrap();
        w.add_player(fi, false, start);
    }
    let powr = ty(&w, "POWR");
    w.spawn_building(powr, 0, 2, 2).unwrap();
    w.spawn_building(powr, 1, 2, 34).unwrap();
    let mut west = Vec::new();
    let mut east = Vec::new();
    for k in 0..12 {
        let id = SHIPS[k % SHIPS.len()];
        let y = 12 + (k as i32 / 2) * 3;
        west.push(ship(&mut w, id, 0, 3 + (k as i32 % 2) * 4, y));
        east.push(ship(&mut w, id, 0, 56 + (k as i32 % 2) * 4, y));
    }
    order_move(&mut w, &west, 58, 20);
    order_move(&mut w, &east, 5, 20);
    run_checked(&mut w, 25 * 120, "head-on in the channel");
}

/// Scatter (`Order::Scatter`) next to the coast and the breakwater.
#[test]
fn scattered_ships_stay_on_water() {
    let mut w = harbour();
    let ships: Vec<usize> =
        SHIPS.iter().enumerate().map(|(k, id)| ship(&mut w, id, 0, 20 + k as i32 % 3, 22 + (k as i32 / 3) * 4)).collect();
    for _ in 0..12 {
        let ids = ships.iter().map(|&i| w.make_ref(i)).collect();
        w.queue_order(Order::Scatter { player: 0, ids });
        run_checked(&mut w, 60, "scatter");
    }
}

// ---- Appearing in the world -------------------------------------------------------------------

/// Naval yards and sub pens launch every ship onto open water, also with
/// land right next to the yard and a crowd at its exits.
#[test]
fn yards_launch_every_ship_onto_water_next_to_the_shore() {
    let mut w = harbour();
    // Corner of the coast and the breakwater: land west and north of the yard.
    let syrd = w.spawn_building(ty(&w, "SYRD"), 0, 20, 25).expect("water for the yard");
    let spen = w.spawn_building(ty(&w, "SPEN"), 1, 32, 12).expect("water for the pen");
    w.refresh_tokens();
    let mut launched = 0;
    for round in 0..4 {
        for id in SHIPS {
            let (yard, owner) = if matches!(id, "SS" | "MSUB") { (spen, 1) } else { (syrd, 0) };
            if let Some(i) = w.produce_at(yard, owner, ty(&w, id)) {
                launched += 1;
                let bad = ships_off_their_water(&w);
                assert!(bad.is_empty(), "round {round}: {bad:?}");
                assert_eq!(terrain_under(&w, i), Terrain::Water, "{id} launched onto water");
            }
        }
        run_checked(&mut w, 40, "after launching");
    }
    assert!(launched >= 12, "{launched} ships launched");
}

/// Map files: a ship drawn onto the shore appears on the nearest water, a
/// tank drawn into the sea on the nearest land, the Transport stays on its
/// beach, and a ship far inland with no water near is left out.
#[test]
fn map_ships_drawn_on_land_appear_on_the_nearest_water() {
    let mut m = Map::filled(48, 32, Terrain::Clear);
    m.spawns = vec![(2, 2), (2, 26)];
    for y in 0..32 {
        for x in 30..48 {
            let i = m.idx(x, y);
            m.terrain[i] = if x == 30 { Terrain::Beach } else { Terrain::Water };
        }
    }
    let mut d = MapData::from_map(&m, "Coast", "Test", "");
    d.actors = vec![
        MapActor::new("DD", 0, 28, 10, 0),
        MapActor::new("LST", 0, 30, 14, 0),
        MapActor::new("2TNK", 0, 34, 18, 0),
        MapActor::new("CA", 0, 6, 20, 0),
        MapActor::new("PT", 0, 40, 6, 0),
    ];
    let players = [PlayerSetup::new("england", None), PlayerSetup::new("russia", None)];
    let options = GameOptions { starting_units: StartingUnits::Base, fog: false, ..GameOptions::default() };
    let w = World::from_map(&d, 3, &players, options).expect("world");
    let placed = |id: &str| {
        let t = ty(&w, id);
        (0..w.actors.len())
            .filter(|&i| w.actors[i].alive && w.actors[i].ty == t)
            .map(|i| w.cell_of(w.actors[i].x, w.actors[i].y))
            .collect::<Vec<_>>()
    };
    assert_eq!(placed("DD"), vec![(31, 10)], "off the shore and the beach, onto the water");
    assert_eq!(placed("LST"), vec![(30, 14)], "the Transport may lie on the beach");
    assert_eq!(placed("2TNK"), vec![(30, 18)], "the tank onto the beach");
    assert!(placed("CA").is_empty(), "no water within reach: not placed");
    assert_eq!(placed("PT"), vec![(40, 6)]);
    assert!(ships_off_their_water(&w).is_empty());
}

#[test]
fn open_cells_follow_each_locomotor() {
    let w = harbour();
    let (dd, lst, tank) = (ty(&w, "DD") as usize, ty(&w, "LST") as usize, ty(&w, "2TNK") as usize);
    // From the beach: a destroyer to the water beside it, the Transport stays, a tank stays.
    assert_eq!(w.open_cell_for(dd, 19, 40, 3), Some((20, 40)));
    assert_eq!(w.open_cell_for(lst, 19, 40, 3), Some((19, 40)));
    assert_eq!(w.open_cell_for(tank, 19, 40, 3), Some((19, 40)));
    // From the open sea: a tank to the nearest land, none within one ring.
    assert_eq!(w.open_cell_for(tank, 30, 30, 1), None);
    // The power plant's cells are no place for anything.
    assert_ne!(w.open_cell_for(tank, 2, 2, 3), Some((2, 2)));
}

// ---- Chronoshift -----------------------------------------------------------------------------

fn chronosphere(w: &mut World) -> &'static str {
    let key = "ChronoshiftPower@chronoshift";
    for k in 0..3 {
        let p = ty(w, "APWR");
        w.spawn_building(p, 0, 6 + k * 3, 14).unwrap();
    }
    let pdox = ty(w, "PDOX");
    w.spawn_building(pdox, 0, 6, 20).unwrap();
    w.refresh_tokens();
    w.update_power();
    w.step();
    w.powers.players[0].iter_mut().find(|p| p.key == key).expect("power offered").remaining = 0;
    key
}

fn chronoshift(w: &mut World, key: &str, from: (i32, i32), to: (i32, i32)) {
    w.queue_order(Order::SupportPower {
        player: 0,
        key: key.into(),
        x: cell_center(to.0),
        y: cell_center(to.1),
        x2: Some(cell_center(from.0)),
        y2: Some(cell_center(from.1)),
    });
    w.step();
}

/// The Chronosphere never puts a ship on land: ships whose target cell is
/// land stay; on the way back a ship whose origin closed meanwhile (a naval
/// yard went up there) returns to the nearest water (OpenRA Teleport
/// ChooseBestDestinationCell), and dies when there is none (killOnFailure).
#[test]
fn chronoshifted_ships_never_land_on_land() {
    let mut w = harbour();
    let key = chronosphere(&mut w);
    // Shifted onto land: refused.
    let dd = ship(&mut w, "DD", 0, 50, 40);
    chronoshift(&mut w, key, (50, 40), (10, 40));
    assert_eq!(w.cell_of(w.actors[dd].x, w.actors[dd].y), (50, 40), "no land for the destroyer");
    assert!(ships_off_their_water(&w).is_empty());
    // Shifted across the sea; a naval yard is built where it was.
    w.powers.players[0].iter_mut().find(|p| p.key == key).unwrap().remaining = 0;
    chronoshift(&mut w, key, (50, 40), (50, 10));
    assert_eq!(w.cell_of(w.actors[dd].x, w.actors[dd].y), (50, 10));
    let yard = w.spawn_building(ty(&w, "SYRD"), 1, 49, 39).expect("the old spot is free");
    w.refresh_tokens();
    let until = w.actors[dd].ab.chrono_return.expect("goes back later").2;
    let left = until - w.tick + 2;
    run_checked(&mut w, left, "back from the chronoshift");
    assert!(w.actors[dd].alive);
    assert_eq!(w.actors[dd].ab.chrono_return, None, "it went back");
    let (cx, cy) = w.cell_of(w.actors[dd].x, w.actors[dd].y);
    assert!((cx - 50).abs() <= 2 && (cy - 40).abs() <= 2 && w.building_at[w.map.idx(cx, cy)] == NONE, "next to the yard at ({cx}, {cy})");
    assert!(w.actors[yard].alive);
    // An open origin is kept as it is; nothing explored to go back to: none (the ship is lost).
    let (ox, oy) = (cell_center(56) + 100, cell_center(44) - 50);
    assert_eq!(w.chrono_return_spot(dd, ox, oy), Some((ox, oy)));
    let (yx, yy) = (cell_center(50), cell_center(40));
    w.players[0].explored.iter_mut().for_each(|e| *e = 0);
    assert_eq!(w.chrono_return_spot(dd, yx, yy), None);
    // Due now: it goes back before this tick's vision explores around it again.
    let now = w.tick;
    w.actors[dd].ab.chrono_return = Some((yx, yy, now));
    w.step();
    assert!(!w.actors[dd].alive, "no water to go back to: lost");
}

// ---- The whole game ---------------------------------------------------------------------------

/// Naval bots on generated naval maps (islands, lakes and rivers with fords):
/// fleets built at yards, sent to fight, retreating, repaired and sunk;
/// every tick every ship is on water. The same game run twice ends with
/// the same state hash.
#[test]
fn naval_bots_keep_every_ship_on_water() {
    let game = |style: MapStyle, seed: u64, ticks: u32| {
        let mut players = Vec::new();
        for f in ["allies", "soviet", "england", "russia"] {
            let mut p = PlayerSetup::new(f, Some(AiDifficulty::Hard));
            p.bot = crate::ai_bots::BotType::Naval;
            players.push(p);
        }
        let options = GameOptions { map_style: style, ..GameOptions::default() };
        let mut w = World::with_options(seed, 96, &players, options);
        let what = format!("{style:?} seed {seed}");
        let mut most = 0;
        let mut on_fords = 0;
        let fords = w.map.terrain.iter().filter(|&&t| t == Terrain::Ford).count();
        let mut steps = Steps::new(&w);
        for _ in 0..ticks {
            w.step();
            on_fords += w
                .actors
                .iter()
                .filter(|a| a.alive && a.kind == Kind::Ship && w.map.terrain[w.cell_index(a.x, a.y)] == Terrain::Ford)
                .count();
            let bad = ships_off_their_water(&w);
            assert!(bad.is_empty(), "{what}: {:?}", &bad[..bad.len().min(5)]);
            steps.check(&w, &what);
            most = most.max(w.actors.iter().filter(|a| a.alive && a.kind == Kind::Ship).count());
        }
        assert!(most >= 2, "{what}: the bots built ships ({most})");
        assert_eq!(on_fords, 0, "{what}: ship-ticks on the map's {fords} ford cells");
        w.state_hash()
    };
    let minutes = 25 * 60;
    // Seed 2: the island bots of seed 3 now spend their money on a land war
    // and build at most one ship in twelve minutes (with either movement
    // model), too few to check fleets.
    game(MapStyle::Islands, 2, 12 * minutes);
    // Lakes seed 10: the bots of seed 7 build one ship in twelve minutes
    // since anti-air shoots aircraft down (seed 10: 17 at once).
    let lakes = game(MapStyle::Lakes, 10, 12 * minutes);
    game(MapStyle::Rivers, 3, 12 * minutes);
    assert_eq!(game(MapStyle::Lakes, 10, 12 * minutes), lakes, "deterministic");
}

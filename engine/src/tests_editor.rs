//! The map editor's preview of a map file (World::editor_preview, Game::editor_preview):
//! the map's actors as a game starts them, drawn by the game's renderer, for maps
//! that are still being made.

use crate::map::{Map, Terrain};
use crate::mapdata::{MapActor, MapData};
use crate::observer::OBSERVER;
use crate::world::{World, EDITOR_SLOTS, NONE};
use crate::Game;

fn actor(t: &str, owner: i32, x: i32, y: i32) -> MapActor {
    MapActor { ty: t.into(), owner, x, y, facing: 256 }
}

/// A 48x48 clear map file with `spawns` and `actors` (`edit` applied to the terrain).
fn data(spawns: &[(i32, i32)], actors: Vec<MapActor>, edit: impl FnOnce(&mut Map)) -> MapData {
    let mut m = Map::filled(48, 48, Terrain::Clear);
    m.spawns = spawns.to_vec();
    edit(&mut m);
    let mut d = MapData::from_map(&m, "Editor", "Test", "");
    d.actors = actors;
    d
}

fn living(w: &World) -> Vec<(String, u8)> {
    w.actors.iter().filter(|a| a.alive).map(|a| (w.rules.actors[a.ty as usize].id.clone(), a.owner)).collect()
}

#[test]
fn places_the_map_actors_without_starting_units() {
    let d = data(&[(4, 4), (40, 40)], vec![actor("POWR", 0, 10, 10), actor("1TNK", 1, 20, 20), actor("V01", -1, 30, 10)], |_| {});
    let w = World::editor_preview(&d).expect("preview");
    let mut got = living(&w);
    got.sort();
    let neutral = EDITOR_SLOTS as u8;
    assert_eq!(got, vec![("1TNK".into(), 1), ("POWR".into(), 0), ("V01".into(), neutral)], "no yards or MCVs at the spawns");
    assert!(w.players[neutral as usize].neutral);
    assert_eq!(w.players.len(), EDITOR_SLOTS + 1);
    assert_eq!(w.tick, 0);
}

#[test]
fn maps_the_game_would_refuse_still_preview() {
    // No spawns, an actor of a spawn the map does not have, one off the map and an unknown type.
    let d = data(&[], vec![actor("POWR", -1, 2, 2), actor("E1", 0, 6, 6), actor("E1", -1, 99, 3), actor("NOPE", -1, 8, 8)], |_| {});
    assert!(!d.validate().ok);
    let w = World::editor_preview(&d).expect("an invalid map still has a preview");
    let mut got = living(&w);
    got.sort();
    assert_eq!(got, vec![("E1".into(), 0), ("POWR".into(), EDITOR_SLOTS as u8)]);
}

#[test]
fn tree_terrain_and_ore_under_structures_look_as_in_a_game() {
    let d = data(&[(4, 4), (40, 40)], vec![actor("SILO", 0, 12, 12)], |m| {
        for x in 20..23 {
            let i = m.idx(x, 30);
            m.terrain[i] = Terrain::Tree;
        }
        let i = m.idx(12, 12);
        m.ore[i] = 5;
    });
    let w = World::editor_preview(&d).expect("preview");
    for x in 20..23 {
        let ci = w.map.idx(x, 30);
        assert_eq!(w.map.terrain[ci], Terrain::Clear, "tree terrain becomes a tree actor on clear ground");
        let b = w.building_at[ci];
        assert_ne!(b, NONE);
        assert_eq!(w.actors[b as usize].owner, EDITOR_SLOTS as u8);
    }
    assert_eq!(w.map.ore[w.map.idx(12, 12)], 0, "no ore under a structure");
}

#[test]
fn rules_overrides_that_do_not_load_fall_back_to_the_base_rules() {
    let mut d = data(&[(4, 4), (40, 40)], vec![actor("POWR", 0, 10, 10)], |_| {});
    d.rules = Some(serde_json::json!({ "actors": { "POWR": { "nonsense": true } } }));
    assert!(crate::rules::Rules::load_with(d.rules()).is_err(), "the override must not load for this test");
    let w = World::editor_preview(&d).expect("preview");
    assert_eq!(living(&w).len(), 1);
}

#[test]
fn the_game_api_renders_the_preview_for_the_observer_view() {
    let d = data(&[(4, 4), (40, 40)], vec![actor("POWR", 0, 10, 10), actor("1TNK", 1, 20, 20)], |_| {});
    let mut g = Game::editor_preview(&d.canonical_json()).ok().expect("preview game");
    let n = g.build_render(OBSERVER, 1.0, 0.0, 0.0, 48.0 * 24.0, 48.0 * 24.0);
    assert!(n >= 2, "both actors are drawn, got {n} sprites");
    let powr = g.world.rules.actor_index("POWR").unwrap() as f32 * 2.0;
    let tank = g.world.rules.actor_index("1TNK").unwrap() as f32 * 2.0;
    let ids: Vec<f32> = g.sprites.chunks(crate::render::SPRITE_FLOATS).map(|s| s[3]).collect();
    assert!(ids.contains(&powr) && ids.contains(&tank), "{ids:?}");
    // Terrain bytes of the preview: one RGBA pixel per cell.
    let _ = g.terrain_ptr();
    assert_eq!(g.terrain_len(), 48 * 48 * 4);
}

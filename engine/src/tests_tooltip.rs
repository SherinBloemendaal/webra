//! The battlefield tooltip (tooltip.rs, OpenRA WorldTooltipLogic and
//! ViewportControllerWidget): what it names for whom, and what it keeps
//! hidden (shroud, fog, cloak, disguises). Synthetic worlds only.

use crate::math::CELL;
use crate::rules::{REL_ALLY, REL_ENEMY};
use crate::selection::Mods;
use crate::tooltip::{TooltipKind, WorldTooltip};
use crate::world::{cell_center, World};

fn ty(w: &World, id: &str) -> u16 {
    w.rules.actor_index(id).unwrap() as u16
}

/// A 64x64 map without actors or resources, everything explored by both players.
fn world() -> World {
    let mut w = World::new(11, 64, &[("england", false), ("russia", false)]);
    w.clear_neutral_world();
    for i in 0..w.actors.len() {
        if w.actors[i].alive {
            w.remove(i);
        }
    }
    w.cleanup_dead();
    for i in 0..w.map.cells() {
        w.map.ore[i] = 0;
        w.map.gems[i] = 0;
    }
    for p in w.players.iter_mut() {
        p.explored.iter_mut().for_each(|e| *e = 1);
    }
    w.update_vision();
    w
}

fn unit(w: &mut World, id: &str, owner: u8, cx: i32, cy: i32) -> usize {
    let t = ty(w, id);
    let u = w.spawn_unit(t, owner, cell_center(cx), cell_center(cy), 0);
    w.rebuild_hash();
    w.update_vision();
    u
}

fn building(w: &mut World, id: &str, owner: u8, cx: i32, cy: i32) -> usize {
    let t = ty(w, id);
    let b = w.spawn_building(t, owner, cx, cy).expect("room for the structure");
    w.update_vision();
    b
}

/// The tooltip player `p` gets at the centre of cell (cx, cy).
fn tip(w: &World, p: u8, cx: i32, cy: i32) -> Option<WorldTooltip> {
    w.world_tooltip(p, Some(p), cell_center(cx), cell_center(cy), Mods::default())
}

fn name(w: &World, id: &str) -> String {
    w.rules.actors[ty(w, id) as usize].name.clone()
}

#[test]
fn own_and_visible_enemy_units_show_name_and_owner() {
    let mut w = world();
    let mine = unit(&mut w, "E1", 0, 10, 10);
    let theirs = unit(&mut w, "3TNK", 1, 12, 10);
    let t = tip(&w, 0, 10, 10).expect("own rifleman");
    assert_eq!(t.kind, TooltipKind::Actor);
    assert_eq!(t.label, name(&w, "E1"));
    assert_eq!((t.actor, t.owner), (Some(mine), Some(0)));
    // The enemy tank is in sight: its name (GenericVisibility None) and owner row.
    let t = tip(&w, 0, 12, 10).expect("enemy tank in sight");
    assert_eq!((t.label.as_str(), t.actor, t.owner), (name(&w, "3TNK").as_str(), Some(theirs), Some(1)));
    assert!(t.extras.is_empty());
}

#[test]
fn fog_hides_enemy_units_and_shroud_hides_everything() {
    let mut w = world();
    unit(&mut w, "E1", 0, 5, 5);
    unit(&mut w, "3TNK", 1, 40, 40);
    // Explored but out of sight: the enemy tank is not there for player 0.
    assert_eq!(tip(&w, 0, 40, 40), None, "fogged enemy: nothing");
    // Its owner still sees it.
    assert!(tip(&w, 1, 40, 40).is_some());
    // Shrouded cells read "Unrevealed Terrain" and name nothing under them.
    let ci = w.map.idx(40, 40);
    w.players[0].explored[ci] = 0;
    w.map.ore[ci] = 5;
    let t = tip(&w, 0, 40, 40).unwrap();
    assert_eq!((t.kind, t.label.as_str()), (TooltipKind::Unexplored, w.rules.world.tooltips.unrevealed.as_str()));
    assert_eq!(t.label, "Unrevealed Terrain");
    // Off the map: no tooltip at all.
    assert_eq!(w.world_tooltip(0, Some(0), -CELL, cell_center(3), Mods::default()), None);
}

#[test]
fn resources_are_named_where_no_actor_is() {
    let mut w = world();
    unit(&mut w, "E1", 0, 10, 10);
    let (ore, gems) = (w.map.idx(11, 10), w.map.idx(12, 10));
    w.map.ore[ore] = 3;
    w.map.gems[gems] = 2;
    for (cx, want) in [(11, &w.rules.world.tooltips.ore), (12, &w.rules.world.tooltips.gems)] {
        let t = tip(&w, 0, cx, 10).unwrap();
        assert_eq!((t.kind, &t.label, t.owner), (TooltipKind::Resource, want, None));
    }
    assert_eq!(w.rules.world.tooltips.ore, "Valuable Minerals");
    assert_eq!(tip(&w, 0, 13, 10), None, "bare ground: nothing");
    // The soldier standing on ore wins over the ore.
    let here = w.map.idx(10, 10);
    w.map.ore[here] = 3;
    assert_eq!(tip(&w, 0, 10, 10).unwrap().kind, TooltipKind::Actor);
}

#[test]
fn cloaked_enemies_are_not_revealed_but_allies_see_them() {
    let mut w = world();
    unit(&mut w, "E1", 0, 10, 10);
    let stank = unit(&mut w, "STNK", 1, 12, 10);
    w.actors[stank].ab.cloaked = true;
    w.actors[stank].detected_by = 0;
    assert_eq!(tip(&w, 0, 12, 10), None, "undetected cloaked enemy: nothing");
    assert_eq!(tip(&w, 1, 12, 10).unwrap().actor, Some(stank), "its owner sees it");
    // Detected by player 0: it shows.
    w.actors[stank].detected_by = 1;
    assert_eq!(tip(&w, 0, 12, 10).unwrap().actor, Some(stank));
}

#[test]
fn a_disguised_spy_shows_its_disguise_to_enemies() {
    let mut w = world();
    let spy = unit(&mut w, "SPY", 0, 10, 10);
    let rifle = unit(&mut w, "E1", 1, 12, 10);
    assert_eq!(tip(&w, 1, 10, 10).unwrap().label, name(&w, "SPY"), "undisguised");
    w.disguise_as(spy, rifle);
    assert!(w.actors[spy].inf.disguise.is_some());
    // The enemy sees a rifleman of their own.
    let t = tip(&w, 1, 10, 10).unwrap();
    assert_eq!((t.label.clone(), t.owner, t.actor), (name(&w, "E1"), Some(1), Some(spy)));
    // DisguiseTooltip: the owner gets the disguise's name too, under its own flag.
    let t = tip(&w, 0, 10, 10).unwrap();
    assert_eq!((t.label.clone(), t.owner), (name(&w, "E1"), Some(0)));
}

#[test]
fn fakes_show_their_generic_name_to_enemies_only() {
    let mut w = world();
    unit(&mut w, "E1", 1, 14, 14);
    building(&mut w, "FPWR", 0, 12, 12);
    let fpwr = ty(&w, "FPWR") as usize;
    let tooltip = w.rules.actors[fpwr].tooltip.clone().unwrap();
    assert_eq!((tooltip.generic_name.as_str(), tooltip.generic_visibility, tooltip.generic_prefix), ("Power Plant", REL_ENEMY, false));
    assert_eq!(tip(&w, 0, 12, 12).unwrap().label, "Fake Power Plant");
    assert_eq!(tip(&w, 1, 12, 12).unwrap().label, "Power Plant", "no prefix (GenericStancePrefix false)");
    // GenericStancePrefix with an ally visibility: "Ally" before the generic name.
    assert_eq!(w.tooltip_label(fpwr, Some(REL_ALLY)), "Fake Power Plant");
    w.rules.actors[fpwr].tooltip.as_mut().unwrap().generic_visibility = REL_ALLY | REL_ENEMY;
    w.rules.actors[fpwr].tooltip.as_mut().unwrap().generic_prefix = true;
    assert_eq!(w.tooltip_label(fpwr, Some(REL_ALLY)), "Ally Power Plant");
    assert_eq!(w.tooltip_label(fpwr, Some(REL_ENEMY)), "Enemy Power Plant");
    assert_eq!(w.tooltip_label(fpwr, None), "Fake Power Plant", "spectators: the name");
}

#[test]
fn fogged_structures_show_what_was_seen() {
    let mut w = world();
    let scout = unit(&mut w, "E1", 0, 20, 18);
    let pp = building(&mut w, "POWR", 1, 20, 20);
    assert_eq!(tip(&w, 0, 20, 20).unwrap().kind, TooltipKind::Actor, "in sight: live");
    // The scout leaves: the structure is remembered.
    w.remove(scout);
    w.cleanup_dead();
    w.rebuild_hash();
    w.update_vision();
    assert!(!w.is_visible_to(pp, 0));
    let t = tip(&w, 0, 20, 20).unwrap();
    assert_eq!((t.kind, t.label.clone(), t.owner, t.actor), (TooltipKind::Frozen, name(&w, "POWR"), Some(1), None));
    // A capture under the fog does not show: the ghost keeps the owner it was seen with.
    w.actors[pp].owner = w.neutral_player().unwrap();
    w.update_vision();
    let t = tip(&w, 0, 20, 20).unwrap();
    assert_eq!((t.kind, t.owner), (TooltipKind::Frozen, Some(1)));
    // Player 1 lost it out of sight and never saw it as another's: nothing.
    assert_eq!(tip(&w, 1, 20, 20), None);
}

#[test]
fn tech_buildings_describe_capture_and_hide_the_neutral_owner_row() {
    let mut w = world();
    unit(&mut w, "E1", 0, 30, 28);
    unit(&mut w, "E1", 1, 31, 28);
    let neutral = w.neutral_player().expect("the generated map has a neutral player");
    let fcom = building(&mut w, "FCOM", neutral, 30, 30);
    let info = &w.rules.actors[ty(&w, "FCOM") as usize].world;
    let (ally, other) = (info.ally_description.clone(), info.other_description.clone());
    assert!(!ally.is_empty() && !other.is_empty());
    let t = tip(&w, 0, 30, 30).unwrap();
    assert_eq!((t.owner, t.extras.clone()), (None, vec![other.clone()]), "neutral: no owner row, the capture text");
    // Captured by player 0: its owner reads @ally, the enemy @other.
    w.actors[fcom].owner = 0;
    w.update_vision();
    assert_eq!(tip(&w, 0, 30, 30).unwrap().extras, vec![ally.clone()]);
    let t = tip(&w, 1, 30, 30).unwrap();
    assert_eq!((t.owner, t.extras), (Some(0), vec![other]));
    // Spectators (no render player): no descriptions.
    w.render_all = true;
    let t = w.world_tooltip(0, None, cell_center(30), cell_center(30), Mods::default()).unwrap();
    w.render_all = false;
    assert!(t.extras.is_empty());
}

#[test]
fn spectators_see_everything_without_shroud() {
    let mut w = world();
    let stank = unit(&mut w, "STNK", 1, 40, 40);
    w.actors[stank].ab.cloaked = true;
    w.actors[stank].detected_by = 0;
    let ci = w.map.idx(40, 40);
    w.players[0].explored[ci] = 0;
    w.render_all = true;
    let t = w.world_tooltip(0, None, cell_center(40), cell_center(40), Mods::default());
    w.render_all = false;
    let t = t.expect("the spectator view sees it");
    assert_eq!((t.kind, t.actor, t.owner), (TooltipKind::Actor, Some(stank), Some(1)));
    assert_eq!(t.label, name(&w, "STNK"), "the name, never a generic one");
}

#[test]
fn units_rank_above_the_structure_they_stand_on() {
    let mut w = world();
    let fact = building(&mut w, "FACT", 0, 20, 20);
    let rifle = unit(&mut w, "E1", 0, 21, 21);
    assert_eq!(tip(&w, 0, 21, 21).unwrap().actor, Some(rifle), "selection priority 10 beats 2");
    assert_eq!(tip(&w, 0, 20, 20).unwrap().actor, Some(fact));
}

#[test]
fn the_game_query_answers_json_for_every_view() {
    let mut w = world();
    unit(&mut w, "E1", 0, 10, 10);
    let mut g = crate::Game::wrap(w);
    let px = |c: i32| crate::render::px(cell_center(c));
    let j: serde_json::Value = serde_json::from_str(&g.world_tooltip(0, px(10), px(10), false, false)).unwrap();
    assert_eq!(j["kind"], "actor");
    assert_eq!(j["owner"], 0);
    assert_eq!(j["faction"], "england");
    assert!(j["id"].is_u64());
    assert_eq!(g.world_tooltip(0, px(50), px(50), false, false), "null");
    for view in [crate::observer::OBSERVER, crate::combined::COMBINED] {
        let j: serde_json::Value = serde_json::from_str(&g.world_tooltip(view, px(10), px(10), false, false)).unwrap();
        assert_eq!(j["kind"], "actor", "view {view}");
    }
    assert!(!g.world.render_all && !g.world.render_combined, "the spectator flags are cleared again");
}

#[test]
fn asking_changes_nothing() {
    let mut w = world();
    unit(&mut w, "E1", 0, 10, 10);
    unit(&mut w, "3TNK", 1, 30, 30);
    let before = w.state_hash();
    for p in 0..2u8 {
        for c in 0..64 {
            let _ = tip(&w, p, c, c);
        }
    }
    assert_eq!(w.state_hash(), before);
}

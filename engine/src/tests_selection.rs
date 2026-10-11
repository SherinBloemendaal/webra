//! OpenRA's selection rules (selection.rs): Selectable priorities and their
//! modifiers, selection classes, bounds on screen, and whose actors count.

use crate::math::CELL;
use crate::selection::{selection_priority, Mods, Rect};
use crate::world::{cell_center, World};

fn ty(w: &World, id: &str) -> u16 {
    w.rules.actor_index(id).unwrap_or_else(|| panic!("{id} is an actor")) as u16
}

/// Two players; player 0's test area is 12 cells right of its start (away
/// from its MCV). Returns the world and the area's top left cell.
fn world() -> (World, i32, i32) {
    let w = World::new(7, 96, &[("allies", false), ("soviet", false)]);
    let (sx, sy) = w.players[0].start;
    (w, sx + 12, sy - 6)
}

fn unit(w: &mut World, id: &str, owner: u8, cx: i32, cy: i32) -> usize {
    let t = ty(w, id);
    w.spawn_unit(t, owner, cell_center(cx), cell_center(cy), 0)
}

/// The rectangle of cells cx0..=cx1, cy0..=cy1.
fn cells(cx0: i32, cy0: i32, cx1: i32, cy1: i32) -> Rect {
    Rect::new(cx0 * CELL, cy0 * CELL, (cx1 + 1) * CELL - 1, (cy1 + 1) * CELL - 1)
}

fn sorted(mut v: Vec<usize>) -> Vec<usize> {
    v.sort_unstable();
    v
}

#[test]
fn the_rules_carry_openras_selectable() {
    let w = World::new(1, 64, &[("allies", false)]);
    let sel = |id: &str| w.rules.actors[ty(&w, id) as usize].selection.clone();
    let s = sel("E1").unwrap();
    assert_eq!((s.priority, s.modifiers, s.class.as_str()), (10, 1, "E1"), "^SelectableCombatUnit, Class E1");
    assert_eq!(sel("E1R1").unwrap().class, "E1", "the veteran rifleman is selected with the rifleman");
    let s = sel("MCV").unwrap();
    assert_eq!((s.priority, s.modifiers, s.class.as_str()), (8, 3, "mcv"), "^SelectableSupportUnit: Ctrl, Alt");
    assert_eq!(sel("HARV").unwrap().priority, 6, "^SelectableEconomicUnit");
    assert_eq!((sel("GUN").unwrap().priority, sel("POWR").unwrap().priority), (4, 2), "defences before other structures");
    assert_eq!(sel("AFLD.Ukraine").unwrap().class, "afld");
    assert_eq!(sel("E1").unwrap().bounds, vec![768, 853, 0, -256]);
    for id in ["BRIK", "SBAG", "MINV", "U2"] {
        assert_eq!(sel(id), None, "{id} cannot be selected");
    }
}

#[test]
fn priority_and_its_modifiers_like_openra() {
    let (w, _, _) = world();
    let info = |id: &str| w.rules.actors[ty(&w, id) as usize].selection.clone().unwrap();
    let none = Mods::default();
    let ctrl = Mods { ctrl: true, alt: false };
    let alt = Mods { ctrl: false, alt: true };
    let both = Mods { ctrl: true, alt: true };
    assert_eq!(selection_priority(&info("E1"), none), 10);
    assert_eq!(selection_priority(&info("E1"), ctrl), i64::MAX, "PriorityModifiers: Ctrl");
    assert_eq!(selection_priority(&info("E1"), alt), 10, "not Alt");
    assert_eq!(selection_priority(&info("MCV"), alt), i64::MAX);
    assert_eq!(selection_priority(&info("MCV"), both), 8, "Ctrl and Alt together raise nothing");
    assert_eq!(selection_priority(&info("POWR"), ctrl), 2, "structures have no modifiers");
}

#[test]
fn select_all_takes_the_highest_priority_on_screen() {
    let (mut w, cx, cy) = world();
    let e1 = [unit(&mut w, "E1", 0, cx, cy), unit(&mut w, "E1", 0, cx + 1, cy)];
    let tank = unit(&mut w, "1TNK", 0, cx + 2, cy);
    let harv = unit(&mut w, "HARV", 0, cx + 3, cy);
    let mcv = unit(&mut w, "MCV", 0, cx + 4, cy);
    let enemy = unit(&mut w, "3TNK", 1, cx + 5, cy);
    let area = Some(cells(cx - 1, cy - 1, cx + 6, cy + 1));
    let own = w.selectable_actors(&[0], area, None);
    assert_eq!(sorted(own.clone()), sorted(vec![e1[0], e1[1], tank, harv, mcv]), "own actors only");
    assert_eq!(sorted(w.highest_selection_priority(own.clone(), Mods::default())), sorted(vec![e1[0], e1[1], tank]), "combat units");
    let ctrl = sorted(w.highest_selection_priority(own.clone(), Mods { ctrl: true, alt: false }));
    assert_eq!(ctrl, sorted(vec![e1[0], e1[1], tank, harv, mcv]), "Ctrl raises every unit that allows it");
    assert_eq!(
        sorted(w.highest_selection_priority(own, Mods { ctrl: false, alt: true })),
        sorted(vec![harv, mcv]),
        "Alt: support and economy"
    );
    // A spectator watching every player selects for all of them.
    assert_eq!(
        sorted(w.highest_selection_priority(w.selectable_actors(&[0, 1], area, None), Mods::default())),
        sorted(vec![e1[0], e1[1], tank, enemy])
    );
    // Without units on screen the structures of the highest priority are selected.
    let powr = w.spawn_building(ty(&w, "POWR"), 0, cx, cy + 4).expect("the power plant fits");
    let gun = w.spawn_building(ty(&w, "GUN"), 0, cx + 3, cy + 4).expect("the turret fits");
    let base = Some(cells(cx - 1, cy + 3, cx + 5, cy + 6));
    assert_eq!(sorted(w.selectable_actors(&[0], base, None)), sorted(vec![powr, gun]));
    assert_eq!(
        w.highest_selection_priority(w.selectable_actors(&[0], base, None), Mods::default()),
        vec![gun],
        "defences before power plants"
    );
    // The whole map: every own actor of the highest priority, wherever it is.
    let far = unit(&mut w, "2TNK", 0, 2, 2);
    let map = w.highest_selection_priority(w.selectable_actors(&[0], None, None), Mods::default());
    assert_eq!(sorted(map), sorted(vec![e1[0], e1[1], tank, far]));
}

#[test]
fn bounds_touching_the_view_count() {
    let (mut w, cx, cy) = world();
    let powr = w.spawn_building(ty(&w, "POWR"), 0, cx, cy).expect("the power plant fits");
    // The view's left edge in the plant's right cell: its centre is outside, its footprint is not.
    let edge = Some(Rect::new((cx + 1) * CELL + 100, cy * CELL, (cx + 6) * CELL, (cy + 2) * CELL));
    assert!(w.actors[powr].x < (cx + 1) * CELL + 100);
    assert_eq!(w.selectable_actors(&[0], edge, None), vec![powr]);
    let past = Some(Rect::new((cx + 2) * CELL + 1, cy * CELL, (cx + 6) * CELL, (cy + 2) * CELL));
    assert!(w.selectable_actors(&[0], past, None).is_empty());
    // A rifleman's bounds (768 wide) reach 384 to each side of its centre.
    let e1 = unit(&mut w, "E1", 0, cx + 8, cy);
    let x = w.actors[e1].x;
    assert_eq!(w.selectable_actors(&[0], Some(Rect::new(x + 380, cy * CELL - CELL, x + 2000, cy * CELL + 2 * CELL)), None), vec![e1]);
    assert!(w.selectable_actors(&[0], Some(Rect::new(x + 390, cy * CELL - CELL, x + 2000, cy * CELL + 2 * CELL)), None).is_empty());
}

#[test]
fn select_by_class_matches_the_selection_classes_of_own_actors() {
    let (mut w, cx, cy) = world();
    let e1 = unit(&mut w, "E1", 0, cx, cy);
    let vet = unit(&mut w, "E1R1", 0, cx + 1, cy);
    let e3 = unit(&mut w, "E3", 0, cx + 2, cy);
    let tank = unit(&mut w, "1TNK", 0, cx + 3, cy);
    let enemy_e1 = unit(&mut w, "E1", 1, cx + 4, cy);
    let off_screen = unit(&mut w, "E1", 0, 3, 3);
    let view = Some(cells(cx - 1, cy - 1, cx + 6, cy + 1));
    let classes = w.selection_classes(&[0], &[e1]);
    assert_eq!(classes, vec!["E1"]);
    assert_eq!(sorted(w.selectable_actors(&[0], view, Some(&classes))), sorted(vec![e1, vet]), "on screen, the same class");
    assert_eq!(sorted(w.selectable_actors(&[0], None, Some(&classes))), sorted(vec![e1, vet, off_screen]), "the whole map");
    let classes = w.selection_classes(&[0], &[e3, tank, e1, enemy_e1]);
    assert_eq!(classes, vec!["E3", "1tnk", "E1"], "each class once; the enemy's is not ours to pick");
    assert!(w.selection_classes(&[0], &[enemy_e1]).is_empty());
    // Dead actors and passengers are not on the map.
    w.kill(vet);
    let classes = w.selection_classes(&[0], &[e1]);
    assert_eq!(sorted(w.selectable_actors(&[0], view, Some(&classes))), vec![e1]);
}

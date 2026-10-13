//! Range circles (range_circles.rs, OpenRA RenderRangeCircle,
//! RenderDetectionCircle, RenderShroudCircle, RenderJammerCircle,
//! WithRangeCircle): which actors get which circle from the rules, their
//! size and colours, who sees them, and the circles while placing a structure.
//! Synthetic worlds only.

use crate::paths::LINE_FLOATS;
use crate::range_circles::{Placing, CIRCLE_SEGMENTS};
use crate::render::px;
use crate::rules::CircleKind;
use crate::world::{cell_center, World};

fn ty(w: &World, id: &str) -> u16 {
    w.rules.actor_index(id).unwrap() as u16
}

fn world() -> World {
    let mut w = World::new(13, 64, &[("england", false), ("russia", false)]);
    w.clear_neutral_world();
    for i in 0..w.actors.len() {
        if w.actors[i].alive {
            w.remove(i);
        }
    }
    w.cleanup_dead();
    w
}

fn building(w: &mut World, id: &str, owner: u8, cx: i32, cy: i32) -> usize {
    let t = ty(w, id);
    w.spawn_building(t, owner, cx, cy).expect("room for the structure")
}

fn unit(w: &mut World, id: &str, owner: u8, cx: i32, cy: i32) -> usize {
    let t = ty(w, id);
    w.spawn_unit(t, owner, cell_center(cx), cell_center(cy), 0)
}

/// One drawn circle: centre, radius (world pixels), line colour and widths.
#[derive(Debug, PartialEq)]
struct Circle {
    center: (f32, f32),
    radius: f32,
    color: [f32; 4],
    border: [f32; 4],
    widths: (f32, f32),
}

/// The circles in a line buffer: 32 dashes of a border and a line each.
fn circles(lines: &[f32]) -> Vec<Circle> {
    let segs: Vec<&[f32]> = lines.chunks(LINE_FLOATS).collect();
    assert_eq!(segs.len() % (2 * CIRCLE_SEGMENTS), 0, "whole circles of border and line pairs");
    segs.chunks(2 * CIRCLE_SEGMENTS)
        .map(|c| {
            // Dash 0 starts east of the centre; dash 8 a quarter turn later, north.
            let (east, north) = ((c[0][0], c[0][1]), (c[16][0], c[16][1]));
            let center = (north.0, east.1);
            let radius = east.0 - center.0;
            assert!((center.1 - north.1 - radius).abs() < 0.01, "counter-clockwise, round");
            for pair in c.chunks(2) {
                assert_eq!(&pair[0][..4], &pair[1][..4], "border and line share their dash");
            }
            Circle {
                center,
                radius,
                color: c[1][4..8].try_into().unwrap(),
                border: c[0][4..8].try_into().unwrap(),
                widths: (c[1][8], c[0][8]),
            }
        })
        .collect()
}

fn selected(w: &World, player: u8, ids: &[usize]) -> Vec<Circle> {
    let refs: Vec<u32> = ids.iter().map(|&i| w.make_ref(i)).collect();
    let mut out = Vec::new();
    w.build_range_circles(player, 1.0, &refs, None, &mut out);
    circles(&out)
}

fn placing(w: &World, player: u8, id: &str, cx: i32, cy: i32) -> Vec<Circle> {
    let mut out = Vec::new();
    w.build_range_circles(player, 1.0, &[], Some(Placing { ty: ty(w, id) as usize, cx, cy }), &mut out);
    circles(&out)
}

const YELLOW: [f32; 4] = [1.0, 1.0, 0.0, 128.0 / 255.0];
const BORDER: [f32; 4] = [0.0, 0.0, 0.0, 96.0 / 255.0];

#[test]
fn the_rules_give_openra_s_circles_to_the_right_actors() {
    let w = world();
    let mut got: Vec<(String, CircleKind, String, i32)> = Vec::new();
    for a in &w.rules.actors {
        for c in &a.range_circles {
            got.push((a.id.clone(), c.kind, c.group.clone(), c.range));
        }
    }
    got.sort_by(|a, b| a.0.cmp(&b.0).then(format!("{:?}", a.1).cmp(&format!("{:?}", b.1))));
    let want = |id: &str, kind, group: &str, range: i32| (id.to_string(), kind, group.to_string(), range);
    use CircleKind::*;
    let mut expected = vec![
        // ^Defense RenderRangeCircle (FallbackRange 6c0 on the garrisons), AA type "aa".
        want("AGUN", Range, "aa", 0),
        want("SAM", Range, "aa", 0),
        want("GUN", Range, "", 0),
        want("FTUR", Range, "", 0),
        want("TSLA", Range, "", 0),
        want("PBOX", Range, "", 6144),
        want("PBOX", Fixed, "", 5120),
        want("HBOX", Range, "", 6144),
        // RenderDetectionCircle: DetectCloaked ranges.
        want("SS", Detection, "", 5120),
        want("MSUB", Detection, "", 4096),
        want("DD", Detection, "", 4096),
        want("PT", Detection, "", 4096),
        want("SPEN", Detection, "", 10240),
        want("SYRD", Detection, "", 10240),
        want("MNLY", Detection, "", 5120),
        // RenderShroudCircle: CreatesShroud ranges.
        want("GAP", Shroud, "", 6144),
        want("MGG", Shroud, "", 7168),
        // RenderJammerCircle (JamsMissiles) and WithRangeCircle@JAMMER of the radar jammer, the MAD tank's.
        want("MRJ", Jammer, "", 5120),
        want("MRJ", Fixed, "jammer", 18432),
        want("QTNK", Fixed, "", 7168),
    ];
    expected.sort_by(|a, b| a.0.cmp(&b.0).then(format!("{:?}", a.1).cmp(&format!("{:?}", b.1))));
    assert_eq!(got, expected);
    // OpenRA's colours: yellow ranges, lime green detection, cyan shroud, red
    // jammer, the WithRangeCircle colours of the rules; all over 96 alpha black.
    let colour = |id: &str, kind| w.rules.actors[ty(&w, id) as usize].range_circles.iter().find(|c| c.kind == kind).unwrap().color;
    assert_eq!(colour("GUN", Range), [255, 255, 0, 128]);
    assert_eq!(colour("SS", Detection), [50, 205, 50, 128]);
    assert_eq!(colour("GAP", Shroud), [0, 255, 255, 128]);
    assert_eq!(colour("MRJ", Jammer), [255, 0, 0, 128]);
    assert_eq!(colour("MRJ", Fixed), [0, 0, 255, 128]);
    assert_eq!(colour("QTNK", Fixed), [255, 255, 0, 128]);
    let pbox = &w.rules.actors[ty(&w, "PBOX") as usize].range_circles;
    assert_eq!(pbox[1].passengers, vec!["E3".to_string()], "PassengerConditions e3: RocketSoldier");
    assert!(!pbox[1].placement && pbox[0].placement);
    assert!(w
        .rules
        .actors
        .iter()
        .flat_map(|a| &a.range_circles)
        .all(|c| c.border == [0, 0, 0, 96] && c.width == 1.0 && c.border_width == 3.0));
}

#[test]
fn a_selected_defence_shows_its_longest_weapon_range_to_its_side() {
    let mut w = world();
    let gun = building(&mut w, "GUN", 0, 20, 20);
    let c = selected(&w, 0, &[gun]);
    assert_eq!(c.len(), 1);
    let range = w.rules.actors[ty(&w, "GUN") as usize].max_range(&w.rules);
    assert!(range > 0);
    assert!((c[0].radius - px(range)).abs() < 0.01);
    assert!((c[0].center.0 - px(w.actors[gun].x)).abs() < 0.01 && (c[0].center.1 - px(w.actors[gun].y)).abs() < 0.01);
    assert_eq!((c[0].color, c[0].border, c[0].widths), (YELLOW, BORDER, (1.0, 3.0)));
    assert!(selected(&w, 1, &[gun]).is_empty(), "not for enemies");
    assert_eq!(selected(&w, 9, &[gun]).len(), 1, "spectators see every combatant's");
    assert!(selected(&w, 0, &[]).is_empty(), "only selected");
    // Not for the neutral player's actors in a spectator view.
    let n = w.neutral_player().unwrap();
    w.actors[gun].owner = n;
    assert!(selected(&w, 9, &[gun]).is_empty());
}

#[test]
fn dashes_cover_three_quarters_of_each_32nd() {
    let mut w = world();
    let gun = building(&mut w, "GUN", 0, 20, 20);
    let mut out = Vec::new();
    w.build_range_circles(0, 1.0, &[w.make_ref(gun)], None, &mut out);
    let segs: Vec<&[f32]> = out.chunks(LINE_FLOATS).collect();
    let (cx, cy) = (px(w.actors[gun].x), px(w.actors[gun].y));
    let angle = |x: f32, y: f32| (cy - y).atan2(x - cx);
    let step = std::f32::consts::TAU / 32.0;
    for (k, s) in segs.iter().step_by(2).enumerate() {
        let (a0, a1) = (angle(s[0], s[1]), angle(s[2], s[3]));
        let span = (a1 - a0).rem_euclid(std::f32::consts::TAU);
        assert!((span - step * 0.75).abs() < 1e-3, "dash {k}: {span}");
        assert!(
            ((a0 - k as f32 * step).rem_euclid(std::f32::consts::TAU) + 1e-3).rem_euclid(std::f32::consts::TAU) < 2e-3,
            "dash {k} starts at 8k"
        );
    }
}

#[test]
fn detection_shroud_and_jammer_circles_follow_their_units() {
    let mut w = world();
    let mnly = unit(&mut w, "MNLY", 0, 10, 10);
    let mgg = unit(&mut w, "MGG", 0, 14, 10);
    let mrj = unit(&mut w, "MRJ", 0, 18, 10);
    let qtnk = unit(&mut w, "QTNK", 0, 22, 10);
    let c = selected(&w, 0, &[mnly, mgg, mrj, qtnk]);
    let radii: Vec<f32> = c.iter().map(|c| c.radius.round()).collect();
    assert_eq!(radii, [px(5120), px(7168), px(5120), px(18432), px(7168)].iter().map(|r| r.round()).collect::<Vec<_>>());
    assert_eq!(c[0].color, [50.0 / 255.0, 205.0 / 255.0, 50.0 / 255.0, 128.0 / 255.0]);
    assert_eq!(c[3].color, [0.0, 0.0, 1.0, 128.0 / 255.0]);
    // A moving unit's circle is drawn where the unit is drawn between ticks.
    w.actors[mgg].px = w.actors[mgg].x - 1024;
    let mut out = Vec::new();
    w.build_range_circles(0, 0.5, &[w.make_ref(mgg)], None, &mut out);
    let c = circles(&out);
    assert!((c[0].center.0 - px(w.actors[mgg].x - 512)).abs() < 0.01);
}

#[test]
fn the_pillbox_rocket_circle_needs_a_rocket_soldier_inside() {
    let mut w = world();
    let pbox = building(&mut w, "PBOX", 0, 20, 20);
    let rockets = w.rules.actors[ty(&w, "PBOX") as usize].range_circles[1].range;
    assert!(!selected(&w, 0, &[pbox]).iter().any(|c| (c.radius - px(rockets)).abs() < 0.01));
    let e3 = unit(&mut w, "E3", 0, 25, 25);
    let (pref, tref) = (w.make_ref(e3), w.make_ref(pbox));
    w.actors[pbox].cargo.push(pref);
    w.actors[e3].carrier = tref;
    let c = selected(&w, 0, &[pbox]);
    assert!(c.iter().any(|c| (c.radius - px(rockets)).abs() < 0.01 && c.color == YELLOW), "{c:?}");
}

#[test]
fn placing_a_defence_shows_the_same_type_of_circles_of_allies() {
    let mut w = world();
    building(&mut w, "TSLA", 0, 10, 10);
    building(&mut w, "SAM", 0, 14, 10);
    building(&mut w, "GUN", 1, 18, 10);
    // A Tesla Coil being placed: its own circle and the own Tesla Coil's (no
    // type), not the SAM site's ("aa") nor the enemy turret's.
    let c = placing(&w, 0, "TSLA", 30, 30);
    let tsla = w.rules.actors[ty(&w, "TSLA") as usize].max_range(&w.rules);
    assert_eq!(c.len(), 2, "{c:?}");
    assert!((c[0].center.0 - px(w.actors.iter().find(|a| a.ty == ty(&w, "TSLA")).unwrap().x)).abs() < 0.01, "others first");
    assert_eq!(c[1].center, (px(30 * 1024 + 512), px(30 * 1024 + 512)), "the placed one at its footprint's centre");
    assert!((c[1].radius - px(tsla)).abs() < 0.01);
    // AA guns show the SAM sites'.
    let c = placing(&w, 0, "AGUN", 30, 30);
    assert_eq!(c.len(), 2);
    // A Pillbox placed: FallbackRange when it has no weapon of its own (WebRA's
    // pillbox fires its garrison's weapon, so the longest weapon here).
    let c = placing(&w, 0, "PBOX", 30, 30);
    assert_eq!(c.len(), 2, "the Tesla Coil and the pillbox; not the rocket circle");
    // Structures without circles show none.
    assert!(placing(&w, 0, "POWR", 30, 30).is_empty());
}

#[test]
fn placing_a_gap_generator_shows_every_allied_shroud_circle() {
    let mut w = World::new(13, 64, &[("england", false), ("france", false), ("russia", false)]);
    w.clear_neutral_world();
    for i in 0..w.actors.len() {
        if w.actors[i].alive {
            w.remove(i);
        }
    }
    w.cleanup_dead();
    w.players[0].team = 1;
    w.players[1].team = 1;
    building(&mut w, "GAP", 0, 10, 10);
    unit(&mut w, "MGG", 1, 14, 10);
    unit(&mut w, "MGG", 2, 18, 10);
    let c = placing(&w, 0, "GAP", 30, 30);
    let mut others: Vec<f32> = c[..c.len() - 1].iter().map(|c| c.radius.round()).collect();
    others.sort_by(f32::total_cmp);
    assert_eq!(others, vec![px(6144).round(), px(7168).round()], "own GAP and the ally's MGG, not the enemy's");
    assert_eq!(c.last().unwrap().center, (px(30 * 1024 + 512), px(30 * 1024 + 512)), "then the placed one");
    assert!(c.iter().all(|c| c.color == [0.0, 1.0, 1.0, 128.0 / 255.0]));
}

#[test]
fn drawing_circles_changes_nothing() {
    let mut w = world();
    let gun = building(&mut w, "GUN", 0, 20, 20);
    let before = w.state_hash();
    let mut out = Vec::new();
    w.build_range_circles(0, 0.3, &[w.make_ref(gun)], Some(Placing { ty: ty(&w, "GAP") as usize, cx: 5, cy: 5 }), &mut out);
    assert!(!out.is_empty());
    assert_eq!(w.state_hash(), before);
}

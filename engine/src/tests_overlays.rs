//! Overlay instance generation (overlays.rs): owner coloured selection
//! brackets, segmented health bars, hover and always-on bars, rank chevrons
//! next to the bar and the animated building layer.

use crate::overlays::*;
use crate::render::{SpriteIds, View, RECT_FLOATS, SPRITE_FLOATS};
use crate::world::{cell_center, GameOptions, PlayerSetup, World, NONE};

fn ty(w: &World, id: &str) -> u16 {
    w.rules.actor_index(id).unwrap() as u16
}

/// 64x64 world, everything explored and visible to both players.
fn world() -> World {
    let players = [PlayerSetup::new("russia", None), PlayerSetup::new("england", None)];
    let mut w = World::with_options(5, 64, &players, GameOptions { ore_regrowth: false, ..GameOptions::default() });
    for p in w.players.iter_mut() {
        p.explored.iter_mut().for_each(|e| *e = 1);
    }
    w
}

fn unit(w: &mut World, id: &str, owner: u8, cx: i32, cy: i32) -> usize {
    let t = ty(w, id);
    let i = w.spawn_unit(t, owner, cell_center(cx), cell_center(cy), 0);
    w.update_vision();
    i
}

fn render(w: &World, selected: &[u32]) -> (Vec<f32>, Vec<f32>) {
    let view = View { x0: 0.0, y0: 0.0, x1: 64.0 * 24.0, y1: 64.0 * 24.0 };
    let (mut sprites, mut rects) = (Vec::new(), Vec::new());
    w.build_render(0, 1.0, &view, selected, &mut sprites, &mut rects);
    (sprites, rects)
}

fn rects(buf: &[f32]) -> Vec<&[f32]> {
    buf.chunks(RECT_FLOATS).collect()
}

/// Health bar frames: the dark rect one pixel around the segments.
fn bar_frames(buf: &[f32]) -> Vec<[f32; 4]> {
    rects(buf)
        .into_iter()
        .filter(|r| r[3] == BAR_HEIGHT + 2.0 && r[4..8] == [0.0, 0.0, 0.0, 0.75])
        .map(|r| [r[0], r[1], r[2], r[3]])
        .collect()
}

fn team_rects(buf: &[f32], team: u8) -> usize {
    rects(buf).into_iter().filter(|r| r[4] == -(team as f32 + 1.0)).count()
}

#[test]
fn brackets_are_eight_owner_coloured_arms_in_the_corners() {
    let mut out = Vec::new();
    push_brackets(10.0, 20.0, 24.0, 18.0, 3, &mut out);
    let r = rects(&out);
    assert_eq!(r.len(), 8);
    for q in &r {
        assert_eq!(q[4], -4.0, "team 3 is encoded as red -4");
        assert!(q[5] > 0.0 && q[7] > 0.0);
        assert!(q[0] >= 10.0 && q[0] + q[2] <= 34.0 + 1e-4, "inside horizontally: {q:?}");
        assert!(q[1] >= 20.0 && q[1] + q[3] <= 38.0 + 1e-4, "inside vertically: {q:?}");
        // Arms are thin and short: a bracket, not a full box edge.
        assert!(q[2].min(q[3]) == BRACKET_THICKNESS && q[2].max(q[3]) <= BRACKET_ARM);
    }
    // Every corner is touched by two arms.
    for (cx, cy) in [(10.0, 20.0), (34.0, 20.0), (10.0, 38.0), (34.0, 38.0)] {
        let touching = r.iter().filter(|q| (q[0] == cx || q[0] + q[2] == cx) && (q[1] == cy || q[1] + q[3] == cy)).count();
        assert_eq!(touching, 2, "corner ({cx}, {cy})");
    }
    // Small boxes get shorter arms so the brackets never meet.
    let mut small = Vec::new();
    push_brackets(0.0, 0.0, 9.0, 9.0, 0, &mut small);
    assert!(rects(&small).iter().all(|q| q[2].max(q[3]) <= 3.0));
}

#[test]
fn health_bar_segments_follow_openra_damage_states() {
    assert_eq!(segment_count(24.0), 6);
    assert_eq!(segment_count(48.0), 12);
    assert_eq!(segment_count(6.0), MIN_SEGMENTS);
    for (frac, lit, col) in [
        (1.0, 6, health_color(1.0)),
        (0.51, 4, [0.2, 0.85, 0.25]),
        (0.5, 3, [0.95, 0.8, 0.15]),
        (0.3, 2, [0.95, 0.8, 0.15]),
        (0.25, 2, [0.9, 0.15, 0.1]),
        (0.01, 1, [0.9, 0.15, 0.1]),
        (0.0, 0, [0.9, 0.15, 0.1]),
    ] {
        assert_eq!(health_color(frac), col, "colour at {frac}");
        let mut out = Vec::new();
        push_health_bar(100.0, 50.0, 24.0, frac, &mut out);
        let r = rects(&out);
        assert_eq!(r.len(), health_bar_rect_count(24.0));
        // Frame first, then the segments left to right above the box.
        assert_eq!(r[0][..4], [99.0, bar_top(50.0) - 1.0, 26.0, BAR_HEIGHT + 2.0]);
        let segs = &r[1..];
        assert_eq!(segs.len(), 6);
        let lit_now: Vec<_> = segs.iter().filter(|s| s[4..7] == col).collect();
        assert_eq!(lit_now.len(), lit, "lit segments at {frac}");
        for (k, s) in segs.iter().enumerate() {
            assert_eq!(s[1], bar_top(50.0));
            assert_eq!(s[3], BAR_HEIGHT);
            assert!(s[1] + s[3] < 50.0, "the bar sits above the bracket");
            assert!(s[0] >= 100.0 && s[0] + s[2] <= 124.0 + 1e-4);
            // Lit segments come first.
            assert_eq!(s[4..7] == col, k < lit, "segment {k} at {frac}");
            if k > 0 {
                assert!(s[0] > segs[k - 1][0] + segs[k - 1][2], "a gap between segments");
            }
        }
    }
}

#[test]
fn selected_units_get_brackets_and_a_bar_others_only_by_hover_or_setting() {
    let mut w = world();
    let own = unit(&mut w, "2TNK", 0, 20, 20);
    let enemy = unit(&mut w, "3TNK", 1, 23, 20);
    let (_, r) = render(&w, &[]);
    assert_eq!(team_rects(&r, 0), 0, "no brackets without a selection");
    assert!(bar_frames(&r).is_empty());

    let (_, r) = render(&w, &[w.make_ref(own)]);
    assert_eq!(team_rects(&r, 0), 8, "brackets in the owner's colour");
    let bars = bar_frames(&r);
    assert_eq!(bars.len(), 1);
    let (x, y, s, _) = w.selection_box(own, 1.0);
    assert_eq!(bars[0][1], bar_top(y - s / 2.0) - 1.0, "bar right above the bracket");
    assert_eq!(bars[0][0], x - s / 2.0 - 1.0);

    // Hover: a bar without brackets, also for enemies.
    w.render_opts.hover = w.make_ref(enemy);
    let (_, r) = render(&w, &[w.make_ref(own)]);
    assert_eq!(bar_frames(&r).len(), 2);
    assert_eq!(team_rects(&r, 1), 0, "hover draws no brackets");
    // Hovering a selected unit does not draw its bar twice.
    w.render_opts.hover = w.make_ref(own);
    assert_eq!(bar_frames(&render(&w, &[w.make_ref(own)]).1).len(), 1);
    w.render_opts.hover = NONE;

    // Damaged: only hurt actors; All: every visible actor (the start bases included).
    w.render_opts.health_bars = HealthBars::Damaged;
    assert!(bar_frames(&render(&w, &[]).1).is_empty(), "nothing is damaged yet");
    w.actors[enemy].hp /= 2;
    let bars = bar_frames(&render(&w, &[]).1);
    assert_eq!(bars.len(), 1);
    let (ex, _, es, _) = w.selection_box(enemy, 1.0);
    assert_eq!(bars[0][0], ex - es / 2.0 - 1.0);
    w.render_opts.health_bars = HealthBars::All;
    let visible = (0..w.actors.len())
        .filter(|&i| {
            let a = &w.actors[i];
            a.alive && a.in_world() && !w.rules.actors[a.ty as usize].is_wall() && (a.owner == 0 || w.is_visible_to(i, 0))
        })
        .count();
    assert!(visible >= 2);
    assert_eq!(bar_frames(&render(&w, &[]).1).len(), visible);
    assert_eq!(HealthBars::from_index(1), HealthBars::Damaged);
    assert_eq!(HealthBars::from_index(9), HealthBars::Selected);
}

#[test]
fn rank_chevrons_sit_right_of_the_health_bar() {
    let mut w = world();
    let t = unit(&mut w, "2TNK", 0, 30, 30);
    w.give_levels(t, 1);
    let ids = SpriteIds::new(w.rules.actors.len());
    let (sprites, _) = render(&w, &[w.make_ref(t)]);
    let chevron = sprites.chunks(SPRITE_FLOATS).find(|c| c[3] == ids.veterancy_base).expect("a chevron");
    let (x, y, s, _) = w.selection_box(t, 1.0);
    let bar_y = bar_top(y - s / 2.0);
    assert_eq!((chevron[0], chevron[1]), chevron_position(x, y, s, s));
    assert!(chevron[0] - CHEVRON_HALF > x + s / 2.0, "right of the bar's end");
    assert!(chevron[1] >= bar_y && chevron[1] <= bar_y + BAR_HEIGHT, "level with the bar");
}

#[test]
fn animated_building_layers_follow_the_overlay_table_and_stop_on_low_power() {
    let mut w = world();
    let dome = ty(&w, "DOME");
    let d = w.spawn_building(dome, 0, 30, 30).expect("room for a radar dome");
    w.update_vision();
    let count = |w: &World, id: f32| render(w, &[]).0.chunks(SPRITE_FLOATS).filter(|c| c[3] == id).count();
    let head = (dome * 2 + 1) as f32;
    assert_eq!(count(&w, head), 0, "no overlay table, no layer");

    let mut table = vec![0u32; w.rules.actors.len()];
    table[dome as usize] = 4321;
    w.render_opts.building_overlays = table;
    w.players[0].power_gen = 100;
    w.players[0].power_use = 0;
    assert_eq!(count(&w, head), 1, "the animated head frame over the dome");
    assert_eq!(count(&w, 4321.0), 0);
    let layer: Vec<f32> = render(&w, &[]).0.chunks(SPRITE_FLOATS).find(|c| c[3] == head).unwrap().to_vec();
    assert_eq!((layer[0], layer[1], layer[4]), (crate::render::px(w.actors[d].x), crate::render::px(w.actors[d].y), 0.0));

    // Low power stops the dish, like Red Alert's radar.
    w.players[0].power_use = 500;
    assert!(w.players[0].low_power());
    assert_eq!(count(&w, head), 0);
    assert_eq!(count(&w, 4321.0), 1, "the static frame instead");

    // Buildings without an entry get nothing.
    w.players[0].power_use = 0;
    let powr = ty(&w, "POWR");
    w.spawn_building(powr, 0, 40, 40).unwrap();
    assert_eq!(count(&w, (powr * 2 + 1) as f32), 0);
}

#[test]
fn damaged_units_buildings_and_walls_show_health_bars_by_default() {
    let mut w = world();
    assert_eq!(w.render_opts.health_bars, HealthBars::Damaged, "the default shows every damaged actor");
    let powr = ty(&w, "POWR");
    let plant = w.spawn_building(powr, 0, 30, 30).expect("room for a power plant");
    let sbag = ty(&w, "SBAG");
    let wall = w.spawn_building(sbag, 0, 36, 30).expect("room for a sandbag");
    let tank = unit(&mut w, "2TNK", 0, 40, 30);
    w.update_vision();
    assert!(bar_frames(&render(&w, &[]).1).is_empty(), "nothing is damaged yet");
    for i in [plant, wall, tank] {
        w.actors[i].hp -= 1;
    }
    assert_eq!(bar_frames(&render(&w, &[]).1).len(), 3, "a damaged building, wall piece and unit each get a bar");
    // "All" adds the undamaged actors, but never undamaged wall pieces.
    w.actors[wall].hp += 1;
    w.render_opts.health_bars = HealthBars::All;
    let (x, _, s, _) = w.selection_box(wall, 1.0);
    assert!(bar_frames(&render(&w, &[]).1).iter().all(|b| b[0] != x - s / 2.0 - 1.0), "no bar on a whole wall piece");
}

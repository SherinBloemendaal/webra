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
    // The static frame instead, and once more in black over it: a disabled
    // structure is darkened (OpenRA WithColoredOverlay@IDISABLE, render.rs).
    let still: Vec<Vec<f32>> = render(&w, &[]).0.chunks(SPRITE_FLOATS).filter(|c| c[3] == 4321.0).map(|c| c.to_vec()).collect();
    assert_eq!(still.len(), 2, "the static frame instead");
    assert_eq!((still[0][7], still[1][7]), (0.0, -1.0));
    assert!((still[1][6] - crate::render::DISABLED_SHADE).abs() < 1e-6);

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

/// Rects of a control group number: the dark plate and the white glyph runs.
fn group_rects(buf: &[f32]) -> (Vec<[f32; 4]>, Vec<[f32; 4]>) {
    let plate = |r: &&[f32]| r[4..8] == GROUP_PLATE && r[2] == GROUP_GLYPH_W as f32 + 2.0 && r[3] == GROUP_GLYPH_H as f32 + 2.0;
    let plates = rects(buf).into_iter().filter(plate).map(|r| [r[0], r[1], r[2], r[3]]).collect();
    let glyph = rects(buf).into_iter().filter(|r| r[4..8] == GROUP_COLOR).map(|r| [r[0], r[1], r[2], r[3]]).collect();
    (plates, glyph)
}

/// The 3x5 pixel grid `push_group_number` lit for a plate at (x, y).
fn lit_pixels(glyph: &[[f32; 4]], x: f32, y: f32) -> [u8; GROUP_GLYPH_H] {
    let mut rows = [0u8; GROUP_GLYPH_H];
    for r in glyph {
        assert_eq!(r[3], 1.0, "one row per rect");
        let row = (r[1] - y - 1.0) as usize;
        for c in 0..r[2] as usize {
            let col = (r[0] - x - 1.0) as usize + c;
            rows[row] |= 1 << (GROUP_GLYPH_W - 1 - col);
        }
    }
    rows
}

#[test]
fn group_numbers_draw_every_digit_as_its_glyph_inside_the_bottom_right_corner() {
    let (l, t, bw, bh) = (10.0, 20.0, 30.0, 24.0);
    for g in 0..=9u8 {
        let mut out = Vec::new();
        push_group_number(l, t, bw, bh, g, &mut out);
        let (plates, glyph) = group_rects(&out);
        assert_eq!(plates.len(), 1);
        let p = plates[0];
        assert_eq!((p[2], p[3]), GROUP_PLATE_SIZE);
        assert_eq!((p[0], p[1]), group_plate_origin(l, t, bw, bh));
        // Flush with the bracket's bottom right arms, inside the box.
        assert_eq!(p[0] + p[2], l + bw - BRACKET_THICKNESS, "left of the vertical arm");
        assert_eq!(p[1] + p[3], t + bh - BRACKET_THICKNESS, "above the horizontal arm");
        assert!(p[0] > l + bw / 2.0 && p[1] > t + bh / 2.0, "in the bottom right quarter");
        assert_eq!(lit_pixels(&glyph, p[0], p[1]), GROUP_GLYPHS[g as usize], "digit {g}");
        for r in &glyph {
            assert!(r[0] > p[0] && r[0] + r[2] < p[0] + p[2] && r[1] > p[1] && r[1] + r[3] < p[1] + p[3], "on the plate");
        }
    }
    // The smallest boxes (units and mines) still hold the plate below the top bracket arm.
    for side in [unit_box_size(0), MINE_BOX] {
        let (_, y) = group_plate_origin(0.0, 0.0, side, side);
        assert!(y >= BRACKET_THICKNESS, "a {side} pixel box keeps the plate inside");
    }
    // Every digit differs from the others.
    for (a, ga) in GROUP_GLYPHS.iter().enumerate() {
        for (b, gb) in GROUP_GLYPHS.iter().enumerate().skip(a + 1) {
            assert_ne!(ga, gb, "{a} and {b}");
        }
    }
    let mut none = Vec::new();
    push_group_number(0.0, 0.0, 24.0, 24.0, 10, &mut none);
    assert!(none.is_empty(), "only the ten group keys");
}

#[test]
fn control_group_numbers_show_on_selected_grouped_units_and_buildings_only() {
    let mut w = world();
    let tank = unit(&mut w, "2TNK", 0, 20, 20);
    let rifle = unit(&mut w, "E1", 0, 24, 20);
    let pp = w.spawn_building(ty(&w, "POWR"), 0, 30, 30).expect("room for a power plant");
    w.update_vision();
    let (rt, rr, rp) = (w.make_ref(tank), w.make_ref(rifle), w.make_ref(pp));
    w.render_opts.set_control_groups(&[rt, rp], &[3, 0]);
    assert_eq!(w.render_opts.control_group(rt), Some(3));
    assert_eq!(w.render_opts.control_group(rp), Some(0));
    assert_eq!(w.render_opts.control_group(rr), None);

    // OpenRA's group decoration RequiresSelection: none while unselected.
    assert!(group_rects(&render(&w, &[]).1).0.is_empty());
    // Selected: one number per grouped actor, at its box's bottom right corner.
    let (_, r) = render(&w, &[rt, rr, rp]);
    let (plates, glyph) = group_rects(&r);
    assert_eq!(plates.len(), 2, "the tank and the power plant, not the ungrouped rifleman");
    for (i, g) in [(tank, 3usize), (pp, 0)] {
        let (x, y, bw, bh) = w.selection_box(i, 1.0);
        let (l, t) = (x - bw / 2.0, y - bh / 2.0);
        let (px_, py_) = group_plate_origin(l, t, bw, bh);
        let p = *plates.iter().find(|p| p[0] == px_ && p[1] == py_).expect("plate at the corner");
        let mine: Vec<[f32; 4]> =
            glyph.iter().copied().filter(|q| q[0] > p[0] && q[0] < p[0] + p[2] && q[1] > p[1] && q[1] < p[1] + p[3]).collect();
        assert_eq!(lit_pixels(&mine, p[0], p[1]), GROUP_GLYPHS[g]);
        // Below the health bar, inside the box, above whatever hangs below it.
        assert!(p[1] > bar_top(t) + BAR_HEIGHT && p[0] >= l && p[0] + p[2] <= l + bw - BRACKET_THICKNESS);
        assert!(p[1] + p[3] <= t + bh - BRACKET_THICKNESS);
    }
    // Moving to another group, and an actor listed twice keeps its last group.
    w.render_opts.set_control_groups(&[rt, rt, rr, NONE], &[3, 7, 12, 1]);
    assert_eq!(w.render_opts.control_groups, vec![(rt, 7)], "group 12 and NONE are dropped");
    // A destroyed actor's number goes with it, also when its slot is reused.
    w.render_opts.set_control_groups(&[rt], &[5]);
    w.kill(tank);
    let again = unit(&mut w, "2TNK", 0, 20, 20);
    let (_, r) = render(&w, &[rt, w.make_ref(again)]);
    assert!(group_rects(&r).0.is_empty(), "the stale ref matches no live actor");
}

#[test]
fn control_group_numbers_stay_clear_of_bars_brackets_and_pips() {
    let mut w = world();
    // A harvester (ore bar), an APC (cargo pips), a Hind (ammo pips), a rifleman
    // (the smallest unit box) and a wall-sized structure.
    let ids: Vec<usize> =
        ["HARV", "APC", "HIND", "E1"].iter().enumerate().map(|(k, id)| unit(&mut w, id, 0, 10 + 6 * k as i32, 20)).collect();
    let pp = w.spawn_building(ty(&w, "POWR"), 0, 40, 40).expect("room for a power plant");
    w.update_vision();
    let refs: Vec<u32> = ids.iter().chain([&pp]).map(|&i| w.make_ref(i)).collect();
    let groups: Vec<u8> = (1..=refs.len() as u8).collect();
    w.render_opts.set_control_groups(&refs, &groups);
    let (_, r) = render(&w, &refs);
    let (plates, _) = group_rects(&r);
    assert_eq!(plates.len(), refs.len());
    let overlaps = |a: &[f32], b: &[f32; 4]| a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
    for p in &plates {
        for q in rects(&r) {
            let is_group = q[4..8] == GROUP_COLOR || (q[4..8] == GROUP_PLATE && (q[2], q[3]) == GROUP_PLATE_SIZE);
            assert!(is_group || !overlaps(q, p), "plate {p:?} overlaps {q:?}");
        }
    }
}

#[test]
fn control_groups_are_ui_state_outside_the_state_hash() {
    let mut w = world();
    let tank = unit(&mut w, "2TNK", 0, 20, 20);
    w.rebuild_hash();
    let r = w.make_ref(tank);
    let mut g = crate::Game::wrap(w);
    let before = g.state_hash();
    g.set_control_groups(vec![r], vec![1]);
    g.set_selection(vec![r]);
    g.build_render(0, 1.0, 0.0, 0.0, 64.0 * 24.0, 64.0 * 24.0);
    assert_eq!(g.state_hash(), before);
    assert_eq!(g.world.render_opts.control_group(r), Some(1));
}

/// Every structure that produces units, by type id.
fn factory_types(w: &World) -> Vec<u16> {
    (0..w.rules.actors.len())
        .filter(|&t| w.rules.actors[t].building.as_ref().is_some_and(|b| b.produces.iter().any(|q| !q.is_structure())))
        .map(|t| t as u16)
        .collect()
}

#[test]
fn rally_points_show_a_line_from_the_nearest_exit_while_the_factory_is_selected() {
    let mut w = world();
    let ids = SpriteIds::new(w.rules.actors.len());
    let types = factory_types(&w);
    assert!(types.len() >= 5, "barracks, kennel, war factory, helipad, airfield, yards: {}", types.len());
    let lines = |w: &World, player: u8, selected: &[u32]| {
        let mut out = Vec::new();
        w.build_rally_lines(player, selected, &mut out);
        out
    };
    for &t in &types {
        // Each factory on the first free spot, its rally point to the south east.
        let (b, cx, cy) = (0..64 * 64)
            .map(|k| (4 + (k % 50), 4 + (k / 50)))
            .find_map(|(cx, cy)| w.spawn_building(t, 0, cx, cy).map(|b| (b, cx, cy)))
            .unwrap_or_else(|| panic!("room for {}", w.rules.actors[t as usize].id));
        w.update_vision();
        let rally = (cell_center(cx + 7), cell_center(cy + 8));
        w.actors[b].rally = Some(rally);
        let r = w.make_ref(b);
        let name = &w.rules.actors[t as usize].id;

        assert!(lines(&w, 0, &[]).is_empty(), "{name}: nothing while not selected");
        assert!(!render(&w, &[]).0.chunks(SPRITE_FLOATS).any(|s| s[3] == ids.rally), "{name}: no flag while not selected");

        let l = lines(&w, 0, &[r]);
        assert_eq!(l.len(), crate::paths::LINE_FLOATS, "{name}: one segment");
        let info = w.rules.actors[t as usize].building.as_ref().unwrap();
        let from = info
            .exits
            .iter()
            .map(|&(ex, ey)| (cell_center(cx + ex), cell_center(cy + ey)))
            .min_by_key(|&(x, y)| crate::math::dist_sq(x, y, rally.0, rally.1))
            .unwrap_or((w.actors[b].x, w.actors[b].y));
        assert_eq!((l[0], l[1]), (crate::render::px(from.0), crate::render::px(from.1)), "{name}: from the exit nearest the rally point");
        assert_eq!((l[2], l[3]), (crate::render::px(rally.0), crate::render::px(rally.1)), "{name}: to the rally point");
        assert_eq!(l[4..8], team_color(0, 1.0, 1.0), "{name}: in the owner's colour");

        // The flag at the point and a marker at both ends, in the owner's colour.
        let (sprites, rects_buf) = render(&w, &[r]);
        let flag = sprites.chunks(SPRITE_FLOATS).find(|s| s[3] == ids.rally).expect("the rally flag");
        assert_eq!((flag[0], flag[1], flag[4]), (l[2], l[3], 0.0));
        let markers: Vec<&[f32]> =
            rects(&rects_buf).into_iter().filter(|q| q[2] == 2.0 * RALLY_MARKER && q[3] == 2.0 * RALLY_MARKER && q[4] == -1.0).collect();
        for (x, y) in [(l[0], l[1]), (l[2], l[3])] {
            assert!(markers.iter().any(|q| q[0] + RALLY_MARKER == x && q[1] + RALLY_MARKER == y), "{name}: marker at ({x}, {y})");
        }
        // The enemy, also with it selected, sees none of it.
        assert!(lines(&w, 1, &[r]).is_empty(), "{name}: hidden from the enemy");
    }
    // Without a rally point there is nothing to draw.
    let t = types[0];
    let b = w.actors.iter().position(|a| a.alive && a.ty == t).unwrap();
    w.actors[b].rally = None;
    assert!(lines(&w, 0, &[w.make_ref(b)]).is_empty());
}

#[test]
fn rally_lines_reach_the_line_buffer_and_skip_spectators() {
    let mut w = world();
    let weap = w.spawn_building(ty(&w, "WEAP"), 0, 20, 20).expect("room for a war factory");
    w.update_vision();
    w.actors[weap].rally = Some((cell_center(30), cell_center(30)));
    let r = w.make_ref(weap);
    let mut g = crate::Game::wrap(w);
    g.set_selection(vec![r]);
    assert_eq!(g.build_lines(0, 1.0, false), 1, "the rally line without unit paths");
    assert_eq!(g.build_lines(0, 1.0, true), 1, "no unit routes to add");
    assert_eq!(g.build_lines(1, 1.0, false), 0, "not the enemy's");
    assert_eq!(g.build_lines(crate::observer::OBSERVER, 1.0, false), 0, "spectators have no player");
    g.set_selection(vec![]);
    assert_eq!(g.build_lines(0, 1.0, false), 0, "deselected: gone");
}

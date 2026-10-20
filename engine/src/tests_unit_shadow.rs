//! Ground shadows of WebRA's 2D minimal units (render.rs `unit_shadow`,
//! `RenderOptions::shadow_slots`): a black copy of each listed body and
//! turret sprite at `UNIT_SHADOW_ALPHA`, offset by `UNIT_SHADOW_OFFSET` in
//! world space whatever way the unit and its turret face, drawn under every
//! unit body. Presentation only.

use crate::instances::eval_records;
use crate::render::{View, SPRITE_FLOATS, UNIT_SHADOW_ALPHA, UNIT_SHADOW_OFFSET};
use crate::world::{cell_center, PlayerSetup, World};

fn ty(w: &World, id: &str) -> u16 {
    w.rules.actor_index(id).unwrap() as u16
}

/// 64x64 world, everything explored.
fn world() -> World {
    let players = [PlayerSetup::new("england", None), PlayerSetup::new("russia", None)];
    let mut w = World::with_options(11, 64, &players, Default::default());
    w.clear_neutral_world();
    for p in w.players.iter_mut() {
        p.explored.iter_mut().for_each(|e| *e = 1);
    }
    w
}

fn draw(w: &World) -> Vec<[f32; 8]> {
    let view = View { x0: -100.0, y0: -100.0, x1: 64.0 * 24.0 + 100.0, y1: 64.0 * 24.0 + 100.0 };
    let (mut sprites, mut rects) = (Vec::new(), Vec::new());
    w.build_render(0, 1.0, &view, &[], &mut sprites, &mut rects);
    sprites.chunks(SPRITE_FLOATS).map(|s| s.try_into().unwrap()).collect()
}

/// A world with tanks, riflemen and cruisers facing every way, turrets turned
/// away from their hulls, and the shadow slots of those types set.
fn scene() -> (World, Vec<u16>) {
    let mut w = world();
    let types = vec![ty(&w, "2TNK"), ty(&w, "E1"), ty(&w, "CA")];
    for (k, facing) in [0, 128, 256, 400, 512, 700, 768, 1000].into_iter().enumerate() {
        for (j, &t) in types.iter().enumerate() {
            let a = w.spawn_unit(t, 0, cell_center(6 + 6 * k as i32), cell_center(6 + 8 * j as i32), facing);
            let turret = (facing + 300) % 1024;
            w.actors[a].turret = turret;
            w.actors[a].pturret = turret;
        }
    }
    w.update_vision();
    let slots: Vec<u32> = types.iter().flat_map(|&t| [t as u32 * 2, t as u32 * 2 + 1]).collect();
    w.render_opts.set_shadow_slots(&slots);
    (w, types)
}

#[test]
fn every_listed_sprite_casts_one_shadow_offset_in_world_space() {
    let (w, types) = scene();
    let drawn = draw(&w);
    let shadows: Vec<_> = drawn.iter().filter(|q| q[7] < 0.0).collect();
    let lit: Vec<_> =
        drawn.iter().filter(|q| q[7] >= 0.0 && types.iter().any(|&t| q[3] == (t * 2) as f32 || q[3] == (t * 2 + 1) as f32)).collect();
    // Every tank has a body and a turret, every rifleman a body, every cruiser a hull and two turrets.
    assert_eq!(lit.len(), 8 * (2 + 1 + 3));
    assert_eq!(shadows.len(), lit.len(), "one shadow per listed sprite");
    for q in &lit {
        let twin = shadows
            .iter()
            .find(|s| s[3] == q[3] && (s[0] - q[0] - UNIT_SHADOW_OFFSET).abs() < 1e-3 && (s[1] - q[1] - UNIT_SHADOW_OFFSET).abs() < 1e-3);
        let s =
            twin.unwrap_or_else(|| panic!("no shadow {UNIT_SHADOW_OFFSET} px to the bottom right of sprite {} at {},{}", q[3], q[0], q[1]));
        // The same sprite, turned the same way (the silhouette follows body and turret), black and faint.
        assert_eq!(s[2], q[2], "the shadow turns with its sprite");
        assert_eq!(s[6], UNIT_SHADOW_ALPHA);
    }
    assert!((UNIT_SHADOW_OFFSET - 0.08 * 24.0).abs() < 1e-6, "the shared palette's 0.08 cell");
}

#[test]
fn shadows_lie_under_every_unit_and_only_listed_slots_cast_them() {
    let (mut w, types) = scene();
    let drawn = draw(&w);
    let last_shadow = drawn.iter().rposition(|q| q[7] < 0.0).unwrap();
    let first_body = drawn.iter().position(|q| q[7] >= 0.0 && types.iter().any(|&t| q[3] == (t * 2) as f32)).unwrap();
    assert!(last_shadow < first_body, "every shadow is drawn before the first unit body");
    // Without the slots (original graphics, texture packs) nothing casts a shadow.
    w.render_opts.set_shadow_slots(&[]);
    assert!(draw(&w).iter().all(|q| q[7] >= 0.0));
    // Only the body slot of the tank: its turrets cast none.
    let tank = types[0] as u32;
    w.render_opts.set_shadow_slots(&[tank * 2]);
    let drawn = draw(&w);
    assert_eq!(drawn.iter().filter(|q| q[7] < 0.0).count(), 8);
    assert!(drawn.iter().filter(|q| q[7] < 0.0).all(|q| q[3] == (tank * 2) as f32));
}

#[test]
fn shadows_match_the_record_path_and_never_touch_the_simulation() {
    let (mut w, _) = scene();
    let before = w.state_hash();
    let (mut recs, mut extras, mut rect_recs) = (Vec::new(), Vec::new(), Vec::new());
    w.build_render_records(0, &[], &mut recs, &mut extras, &mut rect_recs);
    let view = View { x0: -100.0, y0: -100.0, x1: 64.0 * 24.0 + 100.0, y1: 64.0 * 24.0 + 100.0 };
    for alpha in [0.0, 0.5, 1.0] {
        let (mut s_cpu, mut r_cpu, mut s_rec, mut r_rec) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
        w.build_render(0, alpha, &view, &[], &mut s_cpu, &mut r_cpu);
        eval_records(&recs, &extras, &rect_recs, alpha, &view, &mut s_rec, &mut r_rec);
        let bits = |v: &[f32]| v.iter().map(|f| f.to_bits()).collect::<Vec<_>>();
        assert_eq!(bits(&s_cpu), bits(&s_rec));
    }
    assert_eq!(w.state_hash(), before);
    w.step();
    let stepped = w.state_hash();
    let (mut plain, _) = scene();
    plain.render_opts.set_shadow_slots(&[]);
    plain.step();
    assert_eq!(plain.state_hash(), stepped, "the shadow slots are not simulation state");
}

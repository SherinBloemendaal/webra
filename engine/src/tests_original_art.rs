//! Slots drawn from the original graphics (`RenderOptions::set_original_art`,
//! apps/game/js/content/atlas.js originalSlotInfo): helicopter rotors play
//! OpenRA's rotor sequences, explosions animate themselves, projectiles pick
//! their own facing frame, spinners sit over their unit, the silo shows its
//! storage level, and none of WebRA's own drawing is mixed in. Presentation
//! only: the state hash never changes.

use crate::overlays::{ORIGINAL_INFO_LEVEL, ORIGINAL_INFO_OVERLAY, ORIGINAL_INFO_SHEAR};
use crate::render::{
    classic_offset, posed, sheared_offset, Pose, SpriteIds, View, CLASSIC_PITCH_SIN, POSE_CODES, POSE_STRIDE, SPRITE_FLOATS,
};
use crate::rules::Projectile as Flight;
use crate::world::{cell_center, Effect, EffectKind, GameOptions, PlayerSetup, Projectile, World};

fn ty(w: &World, id: &str) -> u16 {
    w.rules.actor_index(id).unwrap() as u16
}

/// 64x64 world, everything explored and visible to both players, poses on.
fn world() -> World {
    let players = [PlayerSetup::new("england", None), PlayerSetup::new("russia", None)];
    let mut w = World::with_options(11, 64, &players, GameOptions { ore_regrowth: false, ..GameOptions::default() });
    for p in w.players.iter_mut() {
        p.explored.iter_mut().for_each(|e| *e = 1);
        p.visible.iter_mut().for_each(|v| *v = 1);
    }
    w.render_opts.poses = true;
    w
}

fn sprites(w: &World) -> Vec<[f32; SPRITE_FLOATS]> {
    let view = View { x0: -100.0, y0: -100.0, x1: 64.0 * 24.0 + 100.0, y1: 64.0 * 24.0 + 100.0 };
    let (mut out, mut rects) = (Vec::new(), Vec::new());
    w.build_render(0, 1.0, &view, &[], &mut out, &mut rects);
    out.chunks(SPRITE_FLOATS).map(|c| c.try_into().unwrap()).collect()
}

/// (slot, pose, age) of a sprite id.
fn unpack(id: f32) -> (u32, u32, u32) {
    let code = id as u32;
    (code % POSE_STRIDE, (code / POSE_STRIDE) % POSE_CODES, code / POSE_STRIDE / POSE_CODES)
}

fn in_slot(all: &[[f32; SPRITE_FLOATS]], slot: u32) -> Vec<[f32; SPRITE_FLOATS]> {
    all.iter().copied().filter(|s| unpack(s[3]).0 == slot).collect()
}

#[test]
fn original_art_options_parse_slots_overlays_and_levels() {
    let mut w = world();
    w.render_opts.set_original_art(
        &[9, 3, 3, 5],
        &[ORIGINAL_INFO_OVERLAY, 7, -256, 0, ORIGINAL_INFO_LEVEL, 4, 5, 0, 99, 1, 2, 3, ORIGINAL_INFO_LEVEL, 6, 0, 0, 1, 2],
    );
    assert_eq!(w.render_opts.original_slots, vec![3, 5, 9], "sorted, once each");
    assert!(w.render_opts.is_original(5) && !w.render_opts.is_original(4));
    assert_eq!(w.render_opts.unit_overlay(7), Some((-256, 0)));
    assert_eq!(w.render_opts.level_stages(4), Some(5));
    assert_eq!(w.render_opts.level_stages(6), None, "no stages, no level");
    assert_eq!(
        (w.render_opts.unit_overlays.len(), w.render_opts.level_stages.len()),
        (1, 1),
        "unknown kinds and the partial record are ignored"
    );
    w.render_opts.set_original_art(&[], &[]);
    assert!(w.render_opts.original_slots.is_empty() && w.render_opts.unit_overlays.is_empty());
}

#[test]
fn original_rotors_play_the_ground_and_air_sequences_without_webra_discs() {
    let mut w = world();
    let ids = SpriteIds::new(w.rules.actors.len());
    let (tran_t, heli_t) = (ty(&w, "TRAN"), ty(&w, "HELI"));
    let tran = w.spawn_unit(tran_t, 0, cell_center(20), cell_center(20), 0);
    let heli = w.spawn_unit(heli_t, 0, cell_center(30), cell_center(20), 0);
    w.actors[heli].altitude = 0;
    let (tran_slot, heli_slot) = (tran_t as u32 * 2 + 1, heli_t as u32 * 2 + 1);
    // WebRA art: blades plus a blurred disc in the air.
    let flying = w.actors[tran].altitude > 0;
    assert!(flying, "the Chinook spawns in the air");
    let plain = sprites(&w);
    assert_eq!(in_slot(&plain, tran_slot).len(), 2);
    assert!(plain.iter().any(|s| s[3] == ids.helis_base), "WebRA's rotor disc");

    w.render_opts.set_original_art(&[tran_slot, heli_slot], &[]);
    let all = sprites(&w);
    assert!(!all.iter().any(|s| s[3] == ids.helis_base || s[3] == ids.helis_base + 1.0), "no WebRA disc or wash");
    // The Chinook in the air: the front rotor's air sequence (move) and the rear one's (aux move), opaque.
    let mut tran_rotors: Vec<(u32, u32)> = in_slot(&all, tran_slot).iter().map(|s| (unpack(s[3]).1, s[6] as u32)).collect();
    tran_rotors.sort();
    assert_eq!(tran_rotors, vec![(Pose::Move as u32, 1), (Pose::AuxMove as u32, 1)]);
    // The landed helicopter: the slow rotor (idle pose).
    let heli_rotor = in_slot(&all, heli_slot);
    assert_eq!(heli_rotor.len(), 1);
    assert_eq!(unpack(heli_rotor[0][3]).1, Pose::Idle as u32);
    // Landed, the Chinook's rotors take the ground sequences.
    w.actors[tran].altitude = 0;
    let mut landed: Vec<u32> = in_slot(&sprites(&w), tran_slot).iter().map(|s| unpack(s[3]).1).collect();
    landed.sort();
    assert_eq!(landed, vec![Pose::Idle as u32, Pose::AuxIdle as u32]);
}

#[test]
fn original_explosions_animate_from_their_start_and_dust_is_left_out() {
    let mut w = world();
    let ids = SpriteIds::new(w.rules.actors.len());
    let fx = |kind, ttl, max| Effect { x: cell_center(10), y: cell_center(10), tx: cell_center(10), ty: cell_center(10), kind, ttl, max };
    w.effects.push(fx(EffectKind::SmallExplosion, 10, 14));
    w.effects.push(fx(EffectKind::Dust, 5, 12));
    let plain = sprites(&w);
    assert_eq!(plain.iter().filter(|s| s[3] == ids.small_explosion || s[3] == ids.large_explosion).count(), 2);
    w.render_opts.set_original_art(&[ids.small_explosion as u32, ids.large_explosion as u32], &[]);
    let all = sprites(&w);
    let boom = in_slot(&all, ids.small_explosion as u32);
    assert_eq!(boom.len(), 1);
    assert_eq!(boom[0][3], posed(ids.small_explosion as u32, Pose::Make, 4), "the make pose, 4 ticks in");
    assert_eq!((boom[0][5], boom[0][6]), (1.0, 1.0), "no WebRA growth or fade");
    assert!(in_slot(&all, ids.large_explosion as u32).is_empty(), "OpenRA has no dust cloud");
}

#[test]
fn original_missiles_pick_their_facing_frame_instead_of_turning_the_sprite() {
    // Rockets (DRAGON) in the missile special, anti-air missiles (MISSILE:
    // the SAM site's Nike, the Redeye) in their own effect slot.
    let ids = SpriteIds::new(world().rules.actors.len());
    let sam_slot = (ids.fx_base + crate::fx::FX_SAM_MISSILE) as u32;
    for (name, slot) in [("Dragon", ids.missile as u32), ("Nike", sam_slot), ("RedEye", sam_slot)] {
        let mut w = world();
        let weapon = w.rules.weapons.iter().position(|k| k.name == name).unwrap();
        assert_eq!(w.rules.weapons[weapon].projectile, Flight::Missile);
        assert!(w.naval_projectile_sprite(weapon).is_none());
        let (x, y) = (cell_center(12), cell_center(12));
        let shot = crate::veterancy::Shot::NONE;
        let weapon = weapon as u16;
        w.projectiles.push(Projectile {
            x,
            y,
            tx: x + 1000,
            ty: y,
            weapon,
            owner: 0,
            target: crate::world::NONE,
            facing: 256,
            shot,
            alt: 0,
            ox: 0,
            oy: 0,
            travel: 0,
        });
        let angle = |all: &[[f32; SPRITE_FLOATS]]| in_slot(all, slot)[0][2];
        let turned = angle(&sprites(&w));
        w.render_opts.set_original_art(&[slot], &[]);
        let own = angle(&sprites(&w));
        // WebRA's missile art points east and is turned back a quarter; the original one is not turned.
        let d = (own - turned).rem_euclid(std::f32::consts::TAU);
        assert!((d - std::f32::consts::FRAC_PI_2).abs() < 1e-4, "{name}: {own} {turned}");
    }
}

#[test]
fn original_spinners_sit_over_units_and_the_silo_shows_the_storage_level() {
    let mut w = world();
    let mrj = ty(&w, "MRJ");
    let i = w.spawn_unit(mrj, 0, cell_center(14), cell_center(14), 0);
    let slot = mrj as u32 * 2 + 1;
    assert!(in_slot(&sprites(&w), slot).is_empty(), "WebRA draws no second part on the Radar Jammer");
    w.render_opts.set_original_art(&[slot], &[ORIGINAL_INFO_OVERLAY, mrj as i32, -256, 0]);
    let all = sprites(&w);
    let dish = in_slot(&all, slot);
    assert_eq!(dish.len(), 1, "the dish over the jammer");
    assert_eq!(unpack(dish[0][3]).1, Pose::Idle as u32);
    let body = all.iter().find(|s| unpack(s[3]).0 == mrj as u32 * 2).expect("the body");
    // 256 world units behind the body (facing north: below it on screen,
    // shortened by OpenRA's classic perspective).
    assert_eq!(w.actors[i].facing, 0);
    let want = classic_offset(-256, 0, 0);
    assert!(want[0].abs() < 1e-6 && (want[1] - 6.0 * CLASSIC_PITCH_SIN).abs() < 1e-5);
    assert!((dish[0][0] - body[0] - want[0]).abs() < 1e-3 && (dish[0][1] - body[1] - want[1]).abs() < 1e-3, "{dish:?} {body:?}");

    // The silo: stage (stages - 1) * resources / capacity of its owner.
    let silo = ty(&w, "SILO");
    let s = w.spawn_building(silo, 0, 30, 30).expect("room for a silo");
    w.actors[s].born = 0;
    w.render_opts.set_original_art(&[silo as u32 * 2], &[ORIGINAL_INFO_LEVEL, silo as i32, 5, 0]);
    let stage = |w: &mut World, res: i32, cap: i32| {
        w.players[0].resources = res;
        w.players[0].storage = cap;
        w.building_pose(s)
    };
    assert_eq!(stage(&mut w, 0, 3000), (Pose::Idle, 0));
    assert_eq!(stage(&mut w, 1500, 3000), (Pose::Idle, 2));
    assert_eq!(stage(&mut w, 2999, 3000), (Pose::Idle, 3));
    assert_eq!(stage(&mut w, 3000, 3000), (Pose::Idle, 4));
    assert_eq!(stage(&mut w, 100, 0), (Pose::Idle, 0), "no capacity: empty");
    w.actors[s].hp = 1;
    assert_eq!(stage(&mut w, 3000, 3000), (Pose::Damaged, 4), "damaged stages");
}

#[test]
fn pre_rendered_turrets_sit_at_the_turreted_offset() {
    // The Mobile Flak's turret is 298 units behind the body's centre (OpenRA
    // FTRK Turreted Offset -298,0,298; the height is drawn into its frames).
    let mut w = world();
    let ftrk = ty(&w, "FTRK");
    let i = w.spawn_unit(ftrk, 0, cell_center(14), cell_center(14), 0);
    let slot = ftrk as u32 * 2 + 1;
    let place = |w: &World| {
        let all = sprites(w);
        let body = all.iter().find(|s| unpack(s[3]).0 == ftrk as u32 * 2).expect("the body")[..2].to_vec();
        let turret = in_slot(&all, slot);
        assert_eq!(turret.len(), 1, "one turret");
        [turret[0][0] - body[0], turret[0][1] - body[1]]
    };
    // WebRA's vector turret has the offset drawn in: centred on the body.
    assert_eq!(place(&w), [0.0, 0.0]);
    w.render_opts.set_original_art(&[slot], &[]);
    for facing in [0, 256, 384] {
        w.actors[i].facing = facing;
        w.actors[i].pfacing = facing;
        let want = classic_offset(-298, 0, facing);
        let got = place(&w);
        assert!((got[0] - want[0]).abs() < 1e-3 && (got[1] - want[1]).abs() < 1e-3, "facing {facing}: {got:?} {want:?}");
    }
    assert!(place(&w)[0] < -1.0, "facing south east, the turret sits to the north west");
    // Turrets on the body's centre stay there (the Medium Tank's).
    let tank = ty(&w, "2TNK");
    let t = w.spawn_unit(tank, 0, cell_center(30), cell_center(30), 0);
    w.actors[t].facing = 300;
    w.actors[t].pfacing = 300;
    w.render_opts.set_original_art(&[tank as u32 * 2 + 1], &[]);
    let all = sprites(&w);
    let body = all.iter().find(|s| unpack(s[3]).0 == tank as u32 * 2).expect("the tank");
    let turret = in_slot(&all, tank as u32 * 2 + 1);
    assert_eq!((turret[0][0], turret[0][1]), (body[0], body[1]));
}

#[test]
fn original_art_never_changes_the_simulation() {
    let run = |original: bool| {
        let mut w = world();
        if original {
            let slots: Vec<u32> = (0..w.rules.actors.len() as u32 * 2 + 60).collect();
            let info = [ORIGINAL_INFO_LEVEL, ty(&w, "SILO") as i32, 5, 0, ORIGINAL_INFO_SHEAR, ty(&w, "HIND") as i32, -358, 0];
            w.render_opts.set_original_art(&slots, &info);
        }
        w.spawn_unit(ty(&w, "HIND"), 0, cell_center(20), cell_center(20), 0);
        for _ in 0..50 {
            w.step();
            let _ = sprites(&w);
        }
        w.rebuild_hash();
        w.state_hash()
    };
    assert_eq!(run(false), run(true));
}

#[test]
fn classic_offsets_shorten_the_north_south_part_like_openra() {
    // OpenRA BodyOrientation.LocalToWorld with UseClassicPerspectiveFudge:
    // (y, -sin(pitch) * x), pitch 40 degrees.
    let north = classic_offset(1024, 0, 0);
    assert!(north[0].abs() < 1e-5 && (north[1] + 24.0 * CLASSIC_PITCH_SIN).abs() < 1e-4, "{north:?}");
    let east = classic_offset(1024, 0, 256);
    assert!((east[0] - 24.0).abs() < 1e-4 && east[1].abs() < 1e-4, "{east:?}");
    let right = classic_offset(0, 1024, 0);
    assert!((right[0] - 24.0).abs() < 1e-4 && right[1].abs() < 1e-4, "{right:?}");
    assert!((CLASSIC_PITCH_SIN - 654.0 / 1024.0).abs() < f32::EPSILON);
}

#[test]
fn ground_shear_records_are_parsed_per_actor_type_and_clamped() {
    let mut w = world();
    let (ca, tran, dd) = (ty(&w, "CA") as i32, ty(&w, "TRAN") as i32, ty(&w, "DD") as i32);
    w.render_opts
        .set_original_art(&[], &[ORIGINAL_INFO_SHEAR, ca, -358, 0, ORIGINAL_INFO_SHEAR, tran, 5000, 0, ORIGINAL_INFO_SHEAR, dd, 0, 0]);
    assert!((w.render_opts.ground_shear(ca as u16) + 358.0 / 1024.0).abs() < 1e-6);
    assert_eq!(w.render_opts.ground_shear(tran as u16), 1.0, "at most one pixel sideways per pixel south");
    assert_eq!(w.render_opts.ground_shear(dd as u16), 0.0, "no shear, no record");
    assert_eq!(w.render_opts.ground_shears.len(), 2);
    w.render_opts.set_original_art(&[], &[]);
    assert!(w.render_opts.ground_shears.is_empty());
}

#[test]
fn sheared_offsets_move_screen_x_with_the_north_south_part() {
    let g = -0.35;
    // Facing north, 1024 ahead is 24 px north: the shear moves it 8.4 px east (x + g * y, y south).
    let north = sheared_offset(1024, 0, 0, g);
    assert!((north[0] - 8.4).abs() < 1e-4 && (north[1] + 24.0 * CLASSIC_PITCH_SIN).abs() < 1e-4, "{north:?}");
    // Facing east, nothing changes north to south.
    let east = sheared_offset(1024, 0, 256, g);
    assert!((east[0] - 24.0).abs() < 1e-4 && east[1].abs() < 1e-4, "{east:?}");
    // Without a shear it is the classic offset.
    for facing in [0, 100, 512, 900] {
        assert_eq!(sheared_offset(-298, 64, facing, 0.0), classic_offset(-298, 64, facing));
    }
}

#[test]
fn sheared_art_keeps_both_cruiser_turrets_and_both_chinook_rotors_on_their_mounts() {
    let mut w = world();
    let (ca, tran) = (ty(&w, "CA"), ty(&w, "TRAN"));
    let c = w.spawn_unit(ca, 0, cell_center(20), cell_center(20), 0);
    let t = w.spawn_unit(tran, 0, cell_center(40), cell_center(20), 0);
    let g = -358;
    let slots = [ca as u32 * 2, ca as u32 * 2 + 1, tran as u32 * 2, tran as u32 * 2 + 1];
    w.render_opts.set_original_art(&slots, &[ORIGINAL_INFO_SHEAR, ca as i32, g, 0, ORIGINAL_INFO_SHEAR, tran as i32, g, 0]);
    let shear = g as f32 / 1024.0;
    for facing in [0, 128, 256, 640] {
        for i in [c, t] {
            w.actors[i].facing = facing;
            w.actors[i].pfacing = facing;
        }
        let all = sprites(&w);
        let parts = |id: u16| {
            // The opaque body (an aircraft also has a faint shadow of it on the ground).
            let body = all.iter().find(|s| unpack(s[3]).0 == id as u32 * 2 && s[6] == 1.0).expect("the body")[..2].to_vec();
            let mut at: Vec<[f32; 2]> = in_slot(&all, id as u32 * 2 + 1).iter().map(|s| [s[0] - body[0], s[1] - body[1]]).collect();
            at.sort_by(|a, b| a.partial_cmp(b).unwrap());
            at
        };
        let want = |offsets: &[i32]| {
            let mut at: Vec<[f32; 2]> = offsets.iter().map(|&o| sheared_offset(o, 0, facing, shear)).collect();
            at.sort_by(|a, b| a.partial_cmp(b).unwrap());
            at
        };
        let close = |a: &[[f32; 2]], b: &[[f32; 2]]| {
            a.len() == b.len() && a.iter().zip(b).all(|(p, q)| (p[0] - q[0]).abs() < 1e-3 && (p[1] - q[1]).abs() < 1e-3)
        };
        let (got, expect) = (parts(ca), want(&[-896, 768]));
        assert!(close(&got, &expect), "CA facing {facing}: {got:?} {expect:?}");
        // The rotors sit on the fuselage (both are lifted by the altitude alike).
        let (got, expect) = (parts(tran), want(&[597, -597]));
        assert!(close(&got, &expect), "TRAN facing {facing}: {got:?} {expect:?}");
    }
}

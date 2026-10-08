//! Tick-rate instance records (instances.rs): built once per tick, then
//! interpolated and culled per frame (the GPU pass, apps/game/shaders/instances.wgsl).
//! Evaluating the records at any alpha and view must give exactly what
//! `build_render` gives for that alpha and view, bit for bit, in the same order.

use crate::instances::*;
use crate::render::{View, RECT_FLOATS, SPRITE_FLOATS};
use crate::rules::Kind;
use crate::world::{cell_center, Effect, EffectKind, GameOptions, PlayerSetup, World};

const ALPHAS: [f32; 6] = [0.0, 0.125, 0.3, 0.5, 0.875, 1.0];

fn views(size: f32) -> Vec<View> {
    vec![
        // The whole map, a small window, one off the top left, one past the bottom right.
        View { x0: 0.0, y0: 0.0, x1: size, y1: size },
        View { x0: size * 0.3, y0: size * 0.25, x1: size * 0.3 + 640.0, y1: size * 0.25 + 400.0 },
        View { x0: -300.0, y0: -200.0, x1: 500.0, y1: 380.0 },
        View { x0: size * 0.7, y0: size * 0.6, x1: size + 50.0, y1: size + 90.0 },
    ]
}

fn bits(v: &[f32]) -> Vec<u32> {
    v.iter().map(|f| f.to_bits()).collect()
}

/// Records of `player`'s frame evaluated at every alpha and view equal `build_render`.
/// Returns the number of sprite and rect records.
fn assert_records_match(w: &World, player: u8, selected: &[u32]) -> (usize, usize) {
    let (mut recs, mut extras, mut rect_recs) = (Vec::new(), Vec::new(), Vec::new());
    w.build_render_records(player, selected, &mut recs, &mut extras, &mut rect_recs);
    assert_eq!(recs.len() % SPRITE_REC_FLOATS, 0);
    assert_eq!(extras.len() % SPRITE_EXTRA_FLOATS, 0);
    assert_eq!(rect_recs.len() % RECT_REC_FLOATS, 0);
    let size = w.map.width as f32 * 24.0;
    let (mut s_cpu, mut r_cpu, mut s_rec, mut r_rec) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for view in views(size) {
        for alpha in ALPHAS {
            w.build_render(player, alpha, &view, selected, &mut s_cpu, &mut r_cpu);
            eval_records(&recs, &extras, &rect_recs, alpha, &view, &mut s_rec, &mut r_rec);
            assert_eq!(s_cpu.len() % SPRITE_FLOATS, 0);
            assert_eq!(r_cpu.len() % RECT_FLOATS, 0);
            if bits(&s_cpu) != bits(&s_rec) {
                let first = s_cpu.chunks(SPRITE_FLOATS).zip(s_rec.chunks(SPRITE_FLOATS)).position(|(a, b)| bits(a) != bits(b));
                panic!(
                    "sprites differ for player {player} at alpha {alpha}, view {:?}: {} vs {} floats, first difference at instance {first:?}: {:?} vs {:?}",
                    (view.x0, view.y0, view.x1, view.y1),
                    s_cpu.len(),
                    s_rec.len(),
                    first.map(|k| &s_cpu[k * SPRITE_FLOATS..(k + 1) * SPRITE_FLOATS]),
                    first.map(|k| &s_rec[k * SPRITE_FLOATS..(k + 1) * SPRITE_FLOATS]),
                );
            }
            assert_eq!(bits(&r_cpu), bits(&r_rec), "rects differ for player {player} at alpha {alpha}");
        }
    }
    (recs.len() / SPRITE_REC_FLOATS, rect_recs.len() / RECT_REC_FLOATS)
}

fn ty(w: &World, id: &str) -> u16 {
    w.rules.actor_index(id).unwrap() as u16
}

/// Every actor type on one map, in mid-move and mid-turn, with the effects,
/// crashes, bombs, ability effects and decorations the renderer draws.
fn zoo() -> World {
    let players = [PlayerSetup::new("russia", None), PlayerSetup::new("england", None)];
    let mut w = World::with_options(3, 96, &players, GameOptions { ore_regrowth: false, ..GameOptions::default() });
    for p in w.players.iter_mut() {
        p.explored.iter_mut().for_each(|e| *e = 1);
    }
    let (mut cx, mut cy) = (4, 4);
    let mut next = |step: i32| {
        cx += step;
        if cx > 88 {
            cx = 4;
            cy += 5;
        }
        (cx, cy)
    };
    for t in 0..w.rules.actors.len() {
        let info = &w.rules.actors[t];
        let owner = (t % 2) as u8;
        match info.kind {
            Kind::Building => {
                let (x, y) = next(6);
                w.spawn_building(t as u16, owner, x, y);
            }
            _ => {
                let (x, y) = next(3);
                let i = w.spawn_unit(t as u16, owner, cell_center(x), cell_center(y), (t as i32 * 97) % 1024);
                let a = &mut w.actors[i];
                // Mid-move and mid-turn, with facings across the wraparound.
                a.px = a.x - 300 + (t as i32 % 7) * 90;
                a.py = a.y + 200 - (t as i32 % 5) * 80;
                a.pfacing = (1000 + t as i32 * 13) % 1024;
                a.facing = (a.pfacing + 40 - (t as i32 % 3) * 40 + 1024) % 1024;
                a.pturret = (a.facing + 500) % 1024;
                a.turret = (a.pturret + 1000) % 1024;
                if t % 3 == 0 {
                    a.flash = 2;
                }
                if a.kind == Kind::Aircraft && t % 2 == 0 {
                    a.altitude = 1024 + t as i32 * 7;
                }
            }
        }
    }
    w.update_vision();
    // Decorations and states.
    let units: Vec<usize> = (0..w.actors.len()).filter(|&i| w.actors[i].alive && w.actors[i].is_unit()).collect();
    for (k, &i) in units.iter().enumerate() {
        match k % 6 {
            0 => w.give_levels(i, 1 + k % 4),
            1 => w.actors[i].invulnerable_until = w.tick + 50,
            2 if w.actors[i].kind == Kind::Ship => w.actors[i].submerged = true,
            3 => w.actors[i].hp /= 2,
            _ => {}
        }
    }
    let infantry = (0..w.actors.len()).find(|&i| w.actors[i].alive && w.actors[i].kind == Kind::Infantry).unwrap();
    w.actors[infantry].air.parachute = true;
    w.actors[infantry].altitude = 2048;
    // Helicopters: one taking off (rotor wash), one at cruise altitude.
    let helis: Vec<usize> =
        (0..w.actors.len()).filter(|&i| w.actors[i].alive && w.actors[i].kind == Kind::Aircraft && w.is_helicopter(i)).collect();
    let info = &w.rules.actors[w.actors[helis[0]].ty as usize];
    let cruise = info.unit.as_ref().and_then(|u| u.aircraft.as_ref()).unwrap().cruise_altitude;
    w.actors[helis[0]].altitude = cruise / 2;
    w.actors[helis[1]].altitude = cruise;
    let tanks: Vec<usize> = (0..w.actors.len()).filter(|&i| w.actors[i].alive && w.actors[i].kind == Kind::Vehicle).collect();
    w.actors[tanks[0]].ab.cloaked = true;
    w.actors[tanks[1]].hp = 1;
    // Effects of every kind, at the start, middle and end of their life.
    let kinds = [
        EffectKind::SmallExplosion,
        EffectKind::LargeExplosion,
        EffectKind::Piff,
        EffectKind::TeslaBolt,
        EffectKind::NukeExplosion,
        EffectKind::ChronoShimmer,
        EffectKind::Dust,
        EffectKind::Naval(0),
        EffectKind::Naval(2),
    ];
    for (k, kind) in kinds.into_iter().enumerate() {
        for (j, ttl) in [0, 1, 7, 20].into_iter().enumerate() {
            let (x, y) = (cell_center(10 + k as i32 * 7), cell_center(70 + j as i32 * 4));
            w.effects.push(Effect { x, y, tx: x + 5000, ty: y - 3000, kind, ttl, max: 20 });
        }
    }
    let husk = ty(&w, "HIND");
    w.crashes.push(crate::helicopter::Crash {
        ty: husk,
        owner: 1,
        x: cell_center(40),
        y: cell_center(80),
        altitude: 600,
        palt: 900,
        facing: 10,
        pfacing: 1000,
        spin: 30,
    });
    w.powers.bombs.push(crate::powers::FallingBomb {
        x: cell_center(44),
        y: cell_center(80),
        altitude: 1500,
        speed: 140,
        weapon: 0,
        owner: 0,
        shot: crate::veterancy::Shot::NONE,
    });
    for kind in [crate::abilities::FxKind::Thump, crate::abilities::FxKind::Chrono] {
        w.abil.fx.push(crate::abilities::AbilityFx { x: cell_center(50), y: cell_center(82), kind, ttl: 5, max: 12 });
    }
    w.abil.nukes.push(crate::abilities::Nuke {
        owner: 0,
        sx: cell_center(20),
        sy: cell_center(20),
        x: cell_center(60),
        y: cell_center(60),
        weapon: 0,
        launch: w.tick,
        impact: w.tick + 100,
        camera_range: 0,
        camera_advance: 0,
        camera_remove: 0,
    });
    // Health bars everywhere, a hovered actor and an animated building layer table.
    w.render_opts.health_bars = crate::overlays::HealthBars::All;
    w.render_opts.hover = w.make_ref(units[3]);
    w.render_opts.building_overlays = (0..w.rules.actors.len()).map(|t| if t % 4 == 0 { 9000 + t as u32 } else { 0 }).collect();
    w
}

#[test]
fn records_of_every_actor_type_evaluate_to_build_render() {
    let mut w = zoo();
    let all: Vec<u32> = (0..w.actors.len()).filter(|&i| w.actors[i].alive).map(|i| w.make_ref(i)).collect();
    let (sprites, rects) = assert_records_match(&w, 0, &all);
    assert!(sprites > 150, "every actor type is drawn: {sprites} records");
    assert!(rects > 1000, "brackets, bars and pips: {rects} rect records");
    assert_records_match(&w, 1, &all[..all.len() / 2]);
    assert_records_match(&w, 0, &[]);
    // The spectator view (observer.rs).
    w.render_all = true;
    assert_records_match(&w, 0, &all);
    w.render_all = false;
    // Records with every optional part are present: offsets, arms, radians, fades.
    let (mut recs, mut extras, mut rect_recs) = (Vec::new(), Vec::new(), Vec::new());
    w.build_render_records(0, &all, &mut recs, &mut extras, &mut rect_recs);
    let parsed: Vec<(SpriteRec, Option<SpriteExtra>)> =
        (0..recs.len() / SPRITE_REC_FLOATS).map(|i| sprite_rec_at(&recs, &extras, i)).collect();
    let extra = |f: &dyn Fn(&SpriteExtra) -> bool| parsed.iter().filter_map(|(_, e)| e.as_ref()).any(f);
    assert!(extra(&|e| e.arm != [0.0, 0.0]), "ship turrets and rotors turn their arm with the hull");
    assert!(extra(&|e| e.offset0 != e.offset1), "crashes and bombs move their offset");
    assert!(extra(&|e| e.angle_mul != 1.0), "rotor wash turns slower");
    assert!(extra(&|e| e.angle_add != 0.0), "missiles and bolts have fixed angles");
    assert!(extra(&|e| e.alpha1 != 0.0 && e.scale1 != 0.0), "effects fade");
    assert!(parsed.iter().any(|(r, _)| r.turn != 0.0 && r.angle + r.turn > 1023.0), "turns across the wraparound");
    assert!(parsed.iter().any(|(r, _)| r.margin < 0.0) && parsed.iter().any(|(r, _)| r.margin == 96.0), "culled and never culled records");
    // Ticking on keeps them equal.
    for _ in 0..30 {
        w.step();
    }
    assert_records_match(&w, 0, &all);
}

#[test]
fn records_follow_ai_games_tick_by_tick() {
    for seed in [7u64, 11] {
        let mut w = World::new(seed, 80, &[("allies", true), ("soviet", true)]);
        w.render_opts.health_bars = crate::overlays::HealthBars::Damaged;
        let mut checked = 0;
        for tick in 0..(25 * 60 * 6) {
            w.step();
            if tick % 450 == 0 {
                for p in 0..2u8 {
                    let own: Vec<u32> =
                        (0..w.actors.len()).filter(|&i| w.actors[i].alive && w.actors[i].owner == p).map(|i| w.make_ref(i)).collect();
                    assert_records_match(&w, p, &own);
                }
                checked += 1;
            }
            if w.winner.is_some() {
                break;
            }
        }
        assert!(checked >= 5, "seed {seed}: {checked} samples");
    }
}

#[test]
fn records_depend_on_the_tick_not_on_the_frame() {
    // Built from the world alone: no alpha, no view, and building them twice
    // (or drawing frames in between) gives the same floats.
    let w = zoo();
    let all: Vec<u32> = (0..w.actors.len()).filter(|&i| w.actors[i].alive).map(|i| w.make_ref(i)).collect();
    let (mut a, mut ae, mut ar) = (Vec::new(), Vec::new(), Vec::new());
    let (mut b, mut be, mut br) = (Vec::new(), Vec::new(), Vec::new());
    w.build_render_records(0, &all, &mut a, &mut ae, &mut ar);
    let (mut s, mut r) = (Vec::new(), Vec::new());
    w.build_render(0, 0.4, &View { x0: 0.0, y0: 0.0, x1: 300.0, y1: 300.0 }, &all, &mut s, &mut r);
    w.build_render_records(0, &all, &mut b, &mut be, &mut br);
    assert_eq!((bits(&a), bits(&ae), bits(&ar)), (bits(&b), bits(&be), bits(&br)));
    // Units move between ticks: their records carry both ends.
    let moving = (0..a.len() / SPRITE_REC_FLOATS).map(|i| sprite_rec_at(&a, &ae, i).0).filter(|r| r.from != r.to).count();
    assert!(moving > 50, "{moving} moving records");
}

#[test]
fn record_evaluation_is_the_cpu_interpolation() {
    let view = View { x0: 0.0, y0: 0.0, x1: 100.0, y1: 100.0 };
    // A unit at 90 % of its move, turning from 1020 by +12 (across the wraparound).
    let r = SpriteRec::moving([10.0, 20.0], [30.0, 60.0], 32.0).facing(1020, 12).look(5.0, 1.0, 1.0, 1.0, 0.0);
    let s = eval_sprite(&r, None, 0.9, &view).unwrap();
    assert_eq!(s[0], 10.0 + (30.0 - 10.0) * 0.9f32);
    assert_eq!(s[1], 20.0 + (60.0 - 20.0) * 0.9f32);
    assert_eq!(s[2], (1020.0 + 12.0 * 0.9f32) * std::f32::consts::TAU / 1024.0);
    // Culled by the moving point with its margin: in at alpha 0, out at alpha 1.
    let far = SpriteRec::moving([120.0, 50.0], [140.0, 50.0], 30.0);
    assert!(eval_sprite(&far, None, 0.0, &view).is_some());
    assert!(eval_sprite(&far, None, 1.0, &view).is_none());
    assert!(eval_sprite(&SpriteRec::at(1e6, 1e6, NO_CULL), None, 0.5, &view).is_some(), "negative margin: never culled");
    // An arm along a hull facing east (256): forward is +x, right is +y.
    let t = SpriteRec::at(50.0, 50.0, 0.0).look(1.0, 0.0, 1.0, 1.0, 0.0).extended().arm(10.0, 4.0, 256, 0);
    let s = eval_sprite(&t.rec, Some(&t.extra), 0.0, &view).unwrap();
    assert!((s[0] - 60.0).abs() < 1e-4 && (s[1] - 54.0).abs() < 1e-4, "{s:?}");
    // Rects hang off their anchor.
    let q = Anchor { from: [0.0, 0.0], to: [10.0, 10.0] }.rect(5.0, -2.0, 3.0, 4.0, 1.0, [1.0, 0.0, 0.0, 1.0]);
    assert_eq!(eval_rect(&q, 0.5, &view).unwrap(), [3.0, 8.0, 4.0, 1.0, 1.0, 0.0, 0.0, 1.0]);
}

//! Presentation effects (fx.rs): explosions per CreateEffect warhead,
//! muzzle flashes, damage smoke, working animations, docking, landing
//! craft doors, paratroopers and OpenRA's Tesla zap. Nothing here may
//! change the simulation.

use crate::fx::{
    age_of, ActiveKind, IMPACT_AIR, IMPACT_GROUND, IMPACT_SHIP, IMPACT_WATER, MUZZLE_LIFE, WEBRA_MUZZLE_TICKS, WEBRA_SMOKE_TICKS,
};
use crate::map::Terrain;
use crate::render::{posed, Pose, SpriteIds, View, POSE_CODES, POSE_STRIDE, SPRITE_FLOATS};
use crate::world::{cell_center, Effect, EffectKind, GameOptions, HarvState, PlayerSetup, World, NONE};

fn ty(w: &World, id: &str) -> u16 {
    w.rules.actor_index(id).unwrap() as u16
}

fn weapon(w: &World, name: &str) -> usize {
    w.rules.weapons.iter().position(|x| x.name == name).unwrap_or_else(|| panic!("weapon {name}"))
}

/// 64x64 clear world, everything explored and visible, poses on.
fn world() -> World {
    let players = [PlayerSetup::new("england", None), PlayerSetup::new("russia", None)];
    let mut w = World::with_options(11, 64, &players, GameOptions { ore_regrowth: false, ..GameOptions::default() });
    for i in 0..w.map.cells() {
        w.map.terrain[i] = Terrain::Clear;
    }
    for p in w.players.iter_mut() {
        p.explored.iter_mut().for_each(|e| *e = 1);
        p.visible.iter_mut().for_each(|v| *v = 1);
    }
    w.render_opts.poses = true;
    w.rebuild_hash();
    w
}

fn sprites(w: &World) -> Vec<[f32; SPRITE_FLOATS]> {
    let view = View { x0: -100.0, y0: -100.0, x1: 64.0 * 24.0 + 100.0, y1: 64.0 * 24.0 + 100.0 };
    let (mut out, mut rects) = (Vec::new(), Vec::new());
    w.build_render(0, 1.0, &view, &[], &mut out, &mut rects);
    out.chunks(SPRITE_FLOATS).map(|c| c.try_into().unwrap()).collect()
}

fn unpack(id: f32) -> (u32, u32, u32) {
    let code = id as u32;
    (code % POSE_STRIDE, (code / POSE_STRIDE) % POSE_CODES, code / POSE_STRIDE / POSE_CODES)
}

fn in_slot(all: &[[f32; SPRITE_FLOATS]], slot: u32) -> Vec<[f32; SPRITE_FLOATS]> {
    all.iter().copied().filter(|s| unpack(s[3]).0 == slot).collect()
}

#[test]
fn render_data_resolves_every_name_of_render_json() {
    let w = world();
    let r = &w.rules.render;
    assert!(r.explosions.len() >= 15 && r.explosions.iter().any(|e| e == "self_destruct"));
    assert_eq!(r.weapons.len(), w.rules.weapons.len());
    assert_eq!(r.actors.len(), w.rules.actors.len());
    // Cannons blow up as small explosions on the ground and small splashes on water.
    let cannon = &r.weapons[weapon(&w, "90mm")];
    let name = |k: u16| r.explosions[k as usize].as_str();
    assert!(cannon.iter().any(|e| e.valid & IMPACT_GROUND != 0 && e.explosions.iter().any(|&k| name(k) == "small_explosion")));
    assert!(cannon.iter().any(|e| e.valid & IMPACT_WATER != 0 && e.explosions.iter().any(|&k| name(k).contains("splash"))));
    let tank = &r.actors[ty(&w, "2TNK") as usize];
    assert_eq!(tank.muzzles.len(), 1);
    assert_eq!(tank.muzzles[0].weapon, weapon(&w, "90mm"));
    assert!(tank.muzzles[0].turret && tank.smoke.is_some());
    assert_eq!(r.actors[ty(&w, "FIX") as usize].active, Some(ActiveKind::Resupply));
    assert_eq!(r.actors[ty(&w, "TSLA") as usize].active, Some(ActiveKind::Charge));
    assert_eq!(r.actors[ty(&w, "MSLO") as usize].active, Some(ActiveKind::Launch));
    assert_eq!(r.actors[ty(&w, "FACT") as usize].active, Some(ActiveKind::Placed));
    assert!(r.actors[ty(&w, "GUN") as usize].recoil);
    assert!(r.actors[ty(&w, "V2RL") as usize].reload_body);
    assert!(r.actors[ty(&w, "LST") as usize].landing_craft);
    assert!(r.actors[ty(&w, "HARV") as usize].docking);
    // Every explosion has a slot below the pose stride.
    let ids = SpriteIds::new(w.rules.actors.len());
    assert!((ids.explosion_base as u32 + r.explosions.len() as u32) < POSE_STRIDE);
}

#[test]
fn impacts_show_the_explosions_of_the_warheads_valid_where_they_land() {
    let mut w = world();
    let (x, y) = (cell_center(20), cell_center(20));
    assert_eq!(w.impact_class(x, y), IMPACT_GROUND);
    let i = w.map.idx(30, 30);
    w.map.terrain[i] = Terrain::Water;
    assert_eq!(w.impact_class(cell_center(30), cell_center(30)), IMPACT_WATER);
    let ship = w.spawn_unit(ty(&w, "DD"), 1, cell_center(30), cell_center(30), 0);
    w.rebuild_hash();
    assert_eq!(w.impact_class(cell_center(30), cell_center(30)), IMPACT_SHIP);
    let heli = w.spawn_unit(ty(&w, "HIND"), 1, cell_center(40), cell_center(40), 0);
    w.rebuild_hash();
    assert!(w.actors[heli].altitude > 0);
    assert_eq!(w.impact_class(cell_center(40), cell_center(40)), IMPACT_AIR);
    let _ = ship;

    // A cannon shell on the ground: small_explosion, picked the same way every time.
    let gun = weapon(&w, "90mm");
    w.effects.clear();
    w.impact(gun, x, y, 0);
    let booms: Vec<EffectKind> = w.effects.iter().map(|e| e.kind).collect();
    assert_eq!(booms.len(), 1, "one effect warhead valid on the ground");
    let EffectKind::Explosion(k, _) = booms[0] else { panic!("not an explosion") };
    assert_eq!(w.rules.render.explosions[k as usize], "small_explosion");
    // On open water: the splash warhead instead.
    w.effects.clear();
    let open = w.map.idx(33, 30);
    w.map.terrain[open] = Terrain::Water;
    w.impact(gun, cell_center(33), cell_center(30), 0);
    let names: Vec<&str> = w
        .effects
        .iter()
        .filter_map(|e| if let EffectKind::Explosion(k, _) = e.kind { Some(w.rules.render.explosions[k as usize].as_str()) } else { None })
        .collect();
    assert!(names.iter().all(|n| n.contains("splash")), "{names:?}");
}

#[test]
fn explosions_draw_once_with_original_art_and_fade_with_webra_art() {
    let mut w = world();
    let ids = SpriteIds::new(w.rules.actors.len());
    let k = w.rules.render.explosions.iter().position(|e| e == "self_destruct").unwrap() as u16;
    let slot = ids.explosion_base as u32 + k as u32;
    w.effects.push(Effect { x: cell_center(10), y: cell_center(10), tx: 0, ty: 0, kind: EffectKind::Explosion(k, 0), ttl: 40, max: 48 });
    w.effects.push(Effect { x: cell_center(12), y: cell_center(10), tx: 0, ty: 0, kind: EffectKind::Explosion(k, 20), ttl: 60, max: 68 });
    // WebRA art: growing and fading within its own time; the delayed one not yet.
    let plain = in_slot(&sprites(&w), slot);
    assert_eq!(plain.len(), 1, "the delayed explosion waits");
    assert!(plain[0][6] < 1.0 && plain[0][5] > 0.7);
    // Original art: the make pose, 8 ticks in, at its own size.
    w.render_opts.set_original_art(&[slot], &[]);
    let orig = in_slot(&sprites(&w), slot);
    assert_eq!(orig.len(), 1);
    assert_eq!(orig[0][3], posed(slot, Pose::Make, 8));
    assert_eq!((orig[0][5], orig[0][6]), (1.0, 1.0));
}

#[test]
fn deaths_show_the_death_weapon_explosions_instead_of_a_generic_one() {
    let mut w = world();
    let tank = w.spawn_unit(ty(&w, "2TNK"), 1, cell_center(20), cell_center(20), 0);
    w.rebuild_hash();
    w.effects.clear();
    w.kill(tank);
    let kinds: Vec<EffectKind> = w.effects.iter().map(|e| e.kind).collect();
    assert!(!kinds.contains(&EffectKind::LargeExplosion), "no generic explosion");
    assert!(kinds.iter().any(|k| matches!(k, EffectKind::Explosion(..))), "UnitExplode's explosion");
}

#[test]
fn muzzle_flashes_follow_shots_barrel_by_barrel_several_at_once() {
    let mut w = world();
    let ids = SpriteIds::new(w.rules.actors.len());
    let mammoth = ty(&w, "4TNK");
    let t = w.spawn_unit(mammoth, 0, cell_center(20), cell_center(20), 0);
    let slot = ids.muzzle_base as u32 + mammoth as u32;
    assert!(in_slot(&sprites(&w), slot).is_empty(), "no flash before a shot");
    let (gun, tusk) = (weapon(&w, "120mm"), weapon(&w, "MammothTusk"));
    w.note_fire(t, gun);
    let first = in_slot(&sprites(&w), slot);
    assert_eq!(first.len(), 1, "WebRA's flash right after the shot");
    // The second barrel fires the next shot; both flashes show at once (one per barrel).
    w.note_fire(t, gun);
    let both = in_slot(&sprites(&w), slot);
    assert_eq!(both.len(), 2, "two barrels flashing");
    assert_ne!((both[0][0], both[0][1]), (both[1][0], both[1][1]), "at their own barrels");
    // The tusks are another armament: their flashes join in.
    w.note_fire(t, tusk);
    assert_eq!(in_slot(&sprites(&w), slot).len(), 3);
    // The barrels take turns: the third cannon shot is the first barrel again.
    w.tick += 1;
    w.note_fire(t, gun);
    assert_eq!(w.actors[t].fx.barrels[0], w.tick + 1);
    // WebRA's flashes go after a few ticks; original ones play their sequence once.
    w.tick += WEBRA_MUZZLE_TICKS;
    assert!(in_slot(&sprites(&w), slot).is_empty());
    w.render_opts.set_original_art(&[slot], &[]);
    let orig = in_slot(&sprites(&w), slot);
    assert_eq!(orig.len(), 3, "every barrel that fired within the original flash time (the first cannon barrel fired twice)");
    assert!(orig.iter().all(|s| unpack(s[3]).1 == Pose::Make as u32));
    w.tick += MUZZLE_LIFE;
    assert!(in_slot(&sprites(&w), slot).is_empty());
}

#[test]
fn damage_smoke_starts_when_badly_hit_loops_one_or_two_times_and_ends() {
    let mut w = world();
    let ids = SpriteIds::new(w.rules.actors.len());
    let slot = ids.fx_base as u32;
    let tank = w.spawn_unit(ty(&w, "2TNK"), 0, cell_center(20), cell_center(20), 0);
    assert_eq!(w.rules.render.actors[w.actors[tank].ty as usize].smoke_loops, (1, 3), "OpenRA LoopCount 1, 3");
    let max = w.rules.actors[w.actors[tank].ty as usize].hp;
    w.damage(tank, max / 4);
    assert_eq!(w.actors[tank].fx.smoke, 0, "lightly damaged: no smoke");
    w.damage(tank, max / 2);
    let started = w.actors[tank].fx.smoke;
    assert!(started > 0, "below half health it smokes (WithDamageOverlay Heavy)");
    let loops = w.actors[tank].fx.smoke_loops as u32;
    assert!((1..=2).contains(&loops), "Next(1, 3): one or two loops");
    assert_eq!(in_slot(&sprites(&w), slot).len(), 1);
    // More hits while smoking do not restart it.
    w.tick += 5;
    w.damage(tank, 1);
    assert_eq!(w.actors[tank].fx.smoke, started);
    w.tick = started - 1 + WEBRA_SMOKE_TICKS * loops;
    assert!(in_slot(&sprites(&w), slot).is_empty(), "it ends after its loops");
    // The loop count is a hash of the start: both counts happen.
    let mut seen = [false; 3];
    for k in 0..40 {
        w.actors[tank].fx.smoke = 0;
        w.tick += 1 + k;
        w.damage(tank, 1);
        seen[w.actors[tank].fx.smoke_loops as usize] = true;
    }
    assert!(seen[1] && seen[2], "{seen:?}");
    // Original art: the start frames once, then the loop frames `loops` times (40 ms frames: one per tick).
    w.render_opts.set_original_art(&[slot], &[crate::overlays::ORIGINAL_INFO_SMOKE, 40, 49, 42]);
    w.actors[tank].fx.smoke = 0;
    w.damage(tank, 1);
    let (start, loops) = (w.actors[tank].fx.smoke - 1, w.actors[tank].fx.smoke_loops as u32);
    let frame_at = |w: &mut World, t: u32| {
        w.tick = start + t;
        in_slot(&sprites(w), slot).first().map(|s| unpack(s[3]))
    };
    assert_eq!(frame_at(&mut w, 10), Some((slot, Pose::Idle as u32, 10)));
    assert_eq!(frame_at(&mut w, 49), Some((slot, Pose::Idle as u32, 49)), "the loop's first frame");
    assert_eq!(frame_at(&mut w, 49 + 42 * loops - 1), Some((slot, Pose::Idle as u32, 49 + 41)), "the last loop's last frame");
    assert_eq!(frame_at(&mut w, 49 + 42 * loops), None, "done");
}

#[test]
fn structures_report_their_working_animations() {
    let mut w = world();
    let tesla = w.spawn_building(ty(&w, "TSLA"), 0, 10, 10).unwrap();
    let fix = w.spawn_building(ty(&w, "FIX"), 0, 20, 10).unwrap();
    let fact = w.spawn_building(ty(&w, "FACT"), 0, 30, 10).unwrap();
    let silo = w.spawn_building(ty(&w, "MSLO"), 0, 40, 10).unwrap();
    for b in [tesla, fix, fact, silo] {
        w.actors[b].born = 0;
    }
    assert_eq!(w.building_pose(tesla), (Pose::Idle, 0));
    // The Tesla coil charges when it fires.
    let zap = w.rules.actors[w.actors[tesla].ty as usize].weapons[0];
    w.note_fire(tesla, zap);
    w.tick += 3;
    assert_eq!(w.building_pose(tesla), (Pose::Active, 3));
    w.actors[tesla].hp = 1;
    assert_eq!(w.building_pose(tesla), (Pose::DamagedActive, 3));
    // The service depot works while it repairs (this tick or the last).
    w.note_service(fix);
    assert_eq!(w.building_pose(fix), (Pose::Active, 0));
    w.tick += 2;
    assert_eq!(w.building_pose(fix), (Pose::Idle, 0));
    // The construction yard animates when its owner places a structure; the silo when it launches.
    w.note_placed(0);
    let yard = (0..w.actors.len()).find(|&i| w.actors[i].alive && w.actors[i].ty == w.actors[fact].ty && w.actors[i].owner == 0).unwrap();
    w.actors[yard].born = 0;
    assert_eq!(w.building_pose(yard).0, Pose::Active, "the player's first construction yard");
    w.note_launch(silo);
    assert_eq!(w.building_pose(silo).0, Pose::Active);
    w.note_launch(fix);
    assert_eq!(w.actors[fix].fx.active, 0, "only structures with a launch animation");
}

#[test]
fn turrets_recoil_after_a_shot() {
    let mut w = world();
    let gun = w.spawn_building(ty(&w, "GUN"), 0, 10, 10).unwrap();
    w.actors[gun].born = 0;
    let slot = w.actors[gun].ty as u32 * 2 + 1;
    let pose = |w: &World| unpack(in_slot(&sprites(w), slot)[0][3]);
    assert_eq!(pose(&w).1, Pose::Idle as u32);
    let shell = w.rules.actors[w.actors[gun].ty as usize].weapons[0];
    w.note_fire(gun, shell);
    w.tick += 2;
    assert_eq!(pose(&w), (slot, Pose::Active as u32, 2));
}

#[test]
fn units_report_reloading_doors_docking_and_parachutes() {
    let mut w = world();
    // The V2 launcher without its rocket while it reloads.
    let v2 = w.spawn_unit(ty(&w, "V2RL"), 0, cell_center(10), cell_center(10), 0);
    assert_eq!(w.fx_unit_pose(v2), None);
    w.actors[v2].reload[0] = 30;
    assert_eq!(w.fx_unit_pose(v2), Some((Pose::Active, 0)));
    // The landing craft opens next to open ground, closes when it leaves.
    for x in 0..64 {
        for y in 0..64 {
            let i = w.map.idx(x, y);
            w.map.terrain[i] = if x < 30 { Terrain::Water } else { Terrain::Clear };
        }
    }
    let lst = w.spawn_unit(ty(&w, "LST"), 0, cell_center(29), cell_center(20), 0);
    w.tick_fx();
    assert!(w.actors[lst].fx.open, "beside the beach");
    w.tick += 4;
    assert_eq!(w.fx_unit_pose(lst), Some((Pose::Active, 4)));
    w.actors[lst].x = cell_center(10);
    w.actors[lst].px = cell_center(10);
    w.tick_fx();
    assert!(!w.actors[lst].fx.open, "out at sea");
    assert_eq!(w.fx_unit_pose(lst), Some((Pose::ActiveEnd, 0)));
    // The harvester docks (lead-in, then the loop) and leaves (the lead-in backwards).
    let harv = w.spawn_unit(ty(&w, "HARV"), 0, cell_center(40), cell_center(40), 0);
    w.actors[harv].harv = HarvState::Unloading;
    w.note_dock(harv, true);
    w.tick += 6;
    assert_eq!(w.fx_unit_pose(harv), Some((Pose::Dock, 6)));
    w.actors[harv].harv = HarvState::Search;
    w.note_dock(harv, false);
    assert_eq!(w.fx_unit_pose(harv), Some((Pose::ActiveEnd, 0)));
    // A paratrooper falls in its parachute pose; the canopy opens from the jump.
    let e1 = w.spawn_unit(ty(&w, "E1"), 0, cell_center(45), cell_center(45), 0);
    w.actors[e1].air.parachute = true;
    w.actors[e1].altitude = 2048;
    w.note_drop(e1);
    w.tick += 3;
    let all = sprites(&w);
    let ids = SpriteIds::new(w.rules.actors.len());
    let body = in_slot(&all, w.actors[e1].ty as u32 * 2);
    assert!(body.iter().all(|s| unpack(s[3]).1 == Pose::Parachute as u32), "falling pose");
    let canopy = in_slot(&all, ids.planes_base as u32);
    assert_eq!(unpack(canopy[0][3]), (ids.planes_base as u32, Pose::Idle as u32, 3), "the canopy's age is the time since the jump");
    assert_eq!(age_of(w.actors[e1].fx.dropped, w.tick), Some(3));
}

#[test]
fn the_original_tesla_zap_steps_along_the_line_like_openra() {
    let mut w = world();
    let ids = SpriteIds::new(w.rules.actors.len());
    let (bright, dim) = (ids.fx_base as u32 + 1, ids.fx_base as u32 + 2);
    let (x, y, tx, ty_) = (cell_center(10), cell_center(10), cell_center(16), cell_center(13));
    w.effects.push(Effect { x, y, tx, ty: ty_, kind: EffectKind::TeslaBolt, ttl: 6, max: 6 });
    assert!(in_slot(&sprites(&w), bright).is_empty(), "WebRA's zap without the original art");
    w.render_opts.set_original_art(&[bright, dim], &[]);
    let all = sprites(&w);
    let (b, d) = (in_slot(&all, bright), in_slot(&all, dim));
    assert!(!b.is_empty() && d.len() >= b.len(), "one bright and two dim bolts");
    for s in b.iter().chain(&d) {
        let (_, pose, frame) = unpack(s[3]);
        assert_eq!(pose, Pose::Idle as u32);
        assert!(frame < 4, "a direction frame of litning.shp");
        // Every step stays between the coil and the target (with the wander of a quarter of the length).
        assert!(s[0] >= 24.0 * 10.0 - 40.0 && s[0] <= 24.0 * 17.0 + 40.0, "{s:?}");
    }
    // The same zap every frame of the same tick (a hash, not a random draw).
    assert_eq!(sprites(&w), all);
    // OpenRA TeslaZap.Duration: two ticks.
    w.effects[0].ttl = 3;
    assert!(in_slot(&sprites(&w), bright).is_empty());
}

#[test]
fn presentation_effects_never_change_the_simulation() {
    let run = |fx: bool| {
        let mut w = world();
        if fx {
            let all: Vec<u32> = (0..POSE_STRIDE).collect();
            w.render_opts.set_original_art(&all, &[]);
        }
        let a = w.spawn_unit(ty(&w, "2TNK"), 0, cell_center(20), cell_center(20), 0);
        let b = w.spawn_unit(ty(&w, "3TNK"), 1, cell_center(24), cell_center(20), 0);
        w.actors[a].target = w.make_ref(b);
        w.actors[a].activity = crate::world::Activity::Attack;
        for _ in 0..120 {
            w.step();
            if fx {
                let _ = sprites(&w);
            }
        }
        w.rebuild_hash();
        w.state_hash()
    };
    assert_eq!(run(false), run(true));
    let _ = NONE;
}

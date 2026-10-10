//! Sprite poses (render.rs `Pose`, `RenderOptions::poses`): what body sprites
//! report for art with pre-rendered animations (original graphics, texture
//! packs). Presentation only: with poses off the ids are the plain slots,
//! and nothing about poses ever changes the simulation.

use crate::instances::eval_records;
use crate::render::{posed, Pose, SpriteIds, View, MAX_POSE_AGE, POSE_CODES, POSE_STRIDE, SPRITE_FLOATS};
use crate::world::{cell_center, Activity, AiDifficulty, GameOptions, HarvState, PlayerSetup, World};

fn ty(w: &World, id: &str) -> u16 {
    w.rules.actor_index(id).unwrap() as u16
}

/// 64x64 world, everything explored and visible to both players.
fn world() -> World {
    let players = [PlayerSetup::new("england", None), PlayerSetup::new("russia", None)];
    let mut w = World::with_options(11, 64, &players, GameOptions { ore_regrowth: false, ..GameOptions::default() });
    for p in w.players.iter_mut() {
        p.explored.iter_mut().for_each(|e| *e = 1);
    }
    w
}

fn sprite_ids(w: &World) -> Vec<f32> {
    let view = View { x0: -100.0, y0: -100.0, x1: 64.0 * 24.0 + 100.0, y1: 64.0 * 24.0 + 100.0 };
    let (mut sprites, mut rects) = (Vec::new(), Vec::new());
    w.build_render(0, 1.0, &view, &[], &mut sprites, &mut rects);
    sprites.chunks(SPRITE_FLOATS).map(|s| s[3]).collect()
}

/// (slot, pose, age) of a sprite id.
fn unpack(id: f32) -> (u32, u32, u32) {
    let code = id as u32;
    (code % POSE_STRIDE, (code / POSE_STRIDE) % POSE_CODES, code / POSE_STRIDE / POSE_CODES)
}

/// The pose and age of the sprite drawn in `slot`, if any.
fn pose_of(w: &World, slot: u32) -> Option<(u32, u32)> {
    sprite_ids(w).into_iter().map(unpack).find(|&(s, _, _)| s == slot).map(|(_, p, a)| (p, a))
}

#[test]
fn pose_ids_pack_slot_pose_and_age_exactly() {
    assert_eq!(posed(7, Pose::Idle, 0), 7.0);
    assert_eq!(unpack(posed(123, Pose::Make, 40)), (123, Pose::Make as u32, 40));
    // The largest id is still an exact f32 integer (below 2^24).
    let top = posed(POSE_STRIDE - 1, Pose::DamagedStill, MAX_POSE_AGE + 50);
    assert!(top < 16_777_216.0);
    assert_eq!(unpack(top), (POSE_STRIDE - 1, Pose::DamagedStill as u32, MAX_POSE_AGE));
    // Every sprite slot of the built-in rules (actors, specials) fits below the stride.
    let w = world();
    let ids = SpriteIds::new(w.rules.actors.len());
    assert!((ids.decorations_base as u32 + 8) < POSE_STRIDE);
}

#[test]
fn without_poses_sprite_ids_are_plain_slots() {
    let mut w = world();
    let e1 = ty(&w, "E1");
    let i = w.spawn_unit(e1, 0, cell_center(10), cell_center(10), 0);
    w.actors[i].px -= 200; // walking
    w.tick = 300;
    let powr = ty(&w, "POWR");
    w.spawn_building(powr, 0, 20, 20).unwrap(); // just placed
    w.update_vision();
    assert!(!w.render_opts.poses);
    for id in sprite_ids(&w) {
        assert!(id < POSE_STRIDE as f32, "plain slot expected, got {id}");
    }
}

#[test]
fn infantry_report_walking_firing_and_standing() {
    let mut w = world();
    w.render_opts.poses = true;
    let e1 = ty(&w, "E1");
    let i = w.spawn_unit(e1, 0, cell_center(10), cell_center(10), 0);
    w.update_vision();
    let body = e1 as u32 * 2;
    // Standing: stand or stand2, or an idle animation (infantry_render.rs).
    let (pose, age) = pose_of(&w, body).unwrap();
    assert_eq!((pose, age), {
        let (p, a) = w.infantry_stand_pose(i);
        (p as u32, a)
    });
    assert!([Pose::Idle, Pose::Stand2, Pose::Idle1, Pose::Idle2].iter().any(|&p| p as u32 == pose));
    w.actors[i].px -= 100;
    assert_eq!(pose_of(&w, body), Some((Pose::Move as u32, 0)));
    w.actors[i].px = w.actors[i].x;
    w.actors[i].activity = Activity::Attack;
    // One of its attack sequences, picked per shot (AttackSequences).
    let attack = w.infantry_attack_pose(i);
    assert!(matches!(attack, Pose::Attack | Pose::Attack2));
    assert_eq!(pose_of(&w, body), Some((attack as u32, 0)));
    let picks: std::collections::BTreeSet<u32> = (1..40)
        .map(|shot| {
            w.actors[i].fx.fired = shot;
            w.infantry_attack_pose(i) as u32
        })
        .collect();
    assert_eq!(picks.len(), 2, "both attack sequences over many shots");
    // Prone infantry use the second slot with the same poses.
    w.actors[i].prone_ticks = 50;
    w.actors[i].px -= 100;
    assert_eq!(pose_of(&w, body + 1), Some((Pose::Move as u32, 0)));
}

#[test]
fn harvesters_report_harvesting_and_docking() {
    let mut w = world();
    w.render_opts.poses = true;
    let harv = ty(&w, "HARV");
    let i = w.spawn_unit(harv, 0, cell_center(12), cell_center(12), 0);
    w.update_vision();
    let body = harv as u32 * 2;
    w.actors[i].harv = HarvState::Harvesting;
    assert_eq!(pose_of(&w, body), Some((Pose::Harvest as u32, 0)));
    w.actors[i].harv = HarvState::Unloading;
    assert_eq!(pose_of(&w, body), Some((Pose::Dock as u32, 0)));
    w.actors[i].harv = HarvState::ToOre;
    w.actors[i].px -= 50;
    assert_eq!(pose_of(&w, body), Some((Pose::Move as u32, 0)));
}

#[test]
fn buildings_report_make_damage_and_power() {
    let mut w = world();
    w.render_opts.poses = true;
    let dome = ty(&w, "DOME");
    // Placed at the start of the map: no make animation.
    let start = w.spawn_building(dome, 0, 10, 10).unwrap();
    w.update_vision();
    let body = dome as u32 * 2;
    assert_eq!(pose_of(&w, body), Some((Pose::Idle as u32, 0)));
    w.actors[start].alive = false;
    w.building_at.iter_mut().filter(|b| **b == start as u32).for_each(|b| *b = crate::world::NONE);
    // Placed during the game: make, with the ticks since placement as the age.
    w.tick = 500;
    let i = w.spawn_building(dome, 0, 30, 30).unwrap();
    w.update_vision();
    w.tick = 510;
    assert_eq!(pose_of(&w, body), Some((Pose::Make as u32, 10)));
    w.tick = 500 + MAX_POSE_AGE + 1;
    assert_eq!(pose_of(&w, body), Some((Pose::Idle as u32, 0)));
    // Below half health: damaged.
    let max = w.rules.actors[dome as usize].hp;
    w.actors[i].hp = max / 2 - 1;
    assert_eq!(pose_of(&w, body), Some((Pose::Damaged as u32, 0)));
    w.actors[i].hp = max / 2;
    assert_eq!(pose_of(&w, body), Some((Pose::Idle as u32, 0)));
    // Without power, structures that need it stand still.
    assert!(w.rules.actors[dome as usize].requires_power);
    w.players[0].power_use = 1000;
    w.players[0].power_gen = 0;
    assert_eq!(pose_of(&w, body), Some((Pose::Still as u32, 0)));
    w.actors[i].hp = 1;
    assert_eq!(pose_of(&w, body), Some((Pose::DamagedStill as u32, 0)));
}

#[test]
fn walls_report_their_connections() {
    let mut w = world();
    w.render_opts.poses = true;
    let sbag = ty(&w, "SBAG");
    let brik = ty(&w, "BRIK");
    // A plus of sandbags around (20, 20), and a concrete wall that does not connect to them.
    for (x, y) in [(20, 20), (20, 19), (21, 20), (20, 21)] {
        w.spawn_building(sbag, 0, x, y).unwrap();
    }
    w.spawn_building(brik, 0, 19, 20).unwrap();
    w.update_vision();
    let ages: Vec<u32> = sprite_ids(&w).into_iter().map(unpack).filter(|&(s, _, _)| s == sbag as u32 * 2).map(|(_, _, a)| a).collect();
    let mut sorted = ages.clone();
    sorted.sort();
    // Centre: north 1 + east 2 + south 4 = 7 (west is concrete). Arms: the centre on one side.
    assert_eq!(sorted, vec![1, 4, 7, 8], "north arm sees south (4), east arm sees west (8), south arm sees north (1)");
}

#[test]
fn remembered_buildings_stand_still() {
    let mut w = world();
    w.render_opts.poses = true;
    let powr = ty(&w, "POWR");
    let i = w.spawn_building(powr, 1, 40, 40).unwrap();
    w.update_vision();
    // Player 0 saw it once; then it is out of sight.
    w.players[0].visible.iter_mut().for_each(|v| *v = 0);
    let cell = w.map.idx(40, 40);
    let gid = w.make_ref(i);
    w.players[0].ghosts.insert(cell as u32, crate::world::Ghost { actor: gid, ty: powr, owner: 1, cx: 40, cy: 40 });
    assert!(!w.is_visible_to(i, 0));
    assert_eq!(pose_of(&w, powr as u32 * 2), Some((Pose::Still as u32, 0)));
}

#[test]
fn poses_never_change_the_simulation() {
    let players = [PlayerSetup::new("england", Some(AiDifficulty::Hard)), PlayerSetup::new("russia", Some(AiDifficulty::Hard))];
    let options = || GameOptions { ore_regrowth: true, ..GameOptions::default() };
    let mut plain = World::with_options(77, 64, &players, options());
    let mut posed_world = World::with_options(77, 64, &players, options());
    let view = View { x0: 0.0, y0: 0.0, x1: 64.0 * 24.0, y1: 64.0 * 24.0 };
    let (mut s, mut r, mut recs, mut extras, mut rects) = (Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for t in 0..1500 {
        plain.step();
        posed_world.step();
        // One world draws every tick with poses switching on and off, the other never draws.
        posed_world.render_opts.poses = t % 3 != 0;
        posed_world.build_render(0, 0.5, &view, &[], &mut s, &mut r);
        posed_world.build_render_records(1, &[], &mut recs, &mut extras, &mut rects);
        assert_eq!(plain.state_hash(), posed_world.state_hash(), "tick {t}");
    }
}

#[test]
fn records_with_poses_match_the_cpu_path() {
    let mut w = world();
    w.render_opts.poses = true;
    let e1 = ty(&w, "E1");
    let harv = ty(&w, "HARV");
    w.tick = 200;
    let a = w.spawn_unit(e1, 0, cell_center(8), cell_center(8), 100);
    w.actors[a].px -= 120;
    let h = w.spawn_unit(harv, 0, cell_center(14), cell_center(8), 300);
    w.actors[h].harv = HarvState::Harvesting;
    w.spawn_building(ty(&w, "WEAP"), 0, 20, 20).unwrap();
    w.tick = 230;
    w.update_vision();
    let (mut recs, mut extras, mut rect_recs) = (Vec::new(), Vec::new(), Vec::new());
    w.build_render_records(0, &[], &mut recs, &mut extras, &mut rect_recs);
    let view = View { x0: 0.0, y0: 0.0, x1: 64.0 * 24.0, y1: 64.0 * 24.0 };
    for alpha in [0.0, 0.4, 1.0] {
        let (mut s_cpu, mut r_cpu, mut s_rec, mut r_rec) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
        w.build_render(0, alpha, &view, &[], &mut s_cpu, &mut r_cpu);
        eval_records(&recs, &extras, &rect_recs, alpha, &view, &mut s_rec, &mut r_rec);
        let bits = |v: &[f32]| v.iter().map(|f| f.to_bits()).collect::<Vec<_>>();
        assert_eq!(bits(&s_cpu), bits(&s_rec));
        assert!(s_cpu.chunks(SPRITE_FLOATS).any(|q| unpack(q[3]).1 == Pose::Make as u32), "the war factory is being made");
        assert!(s_cpu.chunks(SPRITE_FLOATS).any(|q| unpack(q[3]).1 == Pose::Move as u32), "the rifleman walks");
        assert!(s_cpu.chunks(SPRITE_FLOATS).any(|q| unpack(q[3]).1 == Pose::Harvest as u32), "the harvester harvests");
    }
}

#[test]
fn structure_layers_hide_while_built_and_show_the_door_frame_by_damage_state() {
    let mut w = world();
    w.render_opts.poses = true;
    let weap = ty(&w, "WEAP");
    let tank = ty(&w, "1TNK");
    let layer = weap as u32 * 2 + 1;
    let mut table = vec![0u32; w.rules.actors.len()];
    // The still pose, its age the door frames (four, like the original weap2.shp).
    table[weap as usize] = posed(layer, Pose::Still, 4) as u32;
    w.render_opts.building_overlays = table;
    w.players[0].power_gen = 100;
    w.tick = 500;
    let f = w.spawn_building(weap, 0, 30, 30).unwrap();
    w.update_vision();
    // Hidden while the structure is built (OpenRA: RequiresCondition !build-incomplete).
    w.tick = 510;
    assert_eq!(pose_of(&w, weap as u32 * 2), Some((Pose::Make as u32, 10)));
    assert_eq!(pose_of(&w, layer), None);
    w.tick = 500 + MAX_POSE_AGE + 1;
    assert_eq!(pose_of(&w, layer), Some((Pose::Idle as u32, 0)));
    // A unit produced at the exit (1, 2): the door frame is the age of the idle pose (doors.rs).
    let (ex, ey) = w.rules.actors[weap as usize].building.as_ref().unwrap().exits[0];
    let u = w.spawn_unit(tank, 0, cell_center(30 + ex), cell_center(30 + ey), 512);
    w.actors[u].activity = Activity::Move;
    w.rebuild_hash();
    w.door_unit_produced(f, u);
    w.tick_doors();
    w.tick_doors();
    assert_eq!(pose_of(&w, layer), Some((Pose::Idle as u32, 2)));
    // An enemy at the exit does not open a shut door.
    w.kill(u);
    for _ in 0..4 {
        w.tick_doors();
    }
    assert_eq!(pose_of(&w, layer), Some((Pose::Idle as u32, 0)));
    w.spawn_unit(tank, 1, cell_center(30 + ex), cell_center(30 + ey), 512);
    w.rebuild_hash();
    w.tick_doors();
    assert_eq!(pose_of(&w, layer), Some((Pose::Idle as u32, 0)));
    // Damage picks the damaged door sequence; power does not pause the door
    // (OpenRA WithProductionDoorOverlay has no pause condition), so a
    // powered down factory keeps the idle or damaged pose.
    let max = w.rules.actors[weap as usize].hp;
    w.actors[f].hp = max / 2 - 1;
    assert_eq!(pose_of(&w, layer), Some((Pose::Damaged as u32, 0)));
    w.players[0].power_use = 1000;
    w.players[0].power_gen = 0;
    w.rules.actors[weap as usize].requires_power = true;
    assert_eq!(pose_of(&w, weap as u32 * 2), Some((Pose::DamagedStill as u32, 0)));
    assert_eq!(pose_of(&w, layer), Some((Pose::Damaged as u32, 0)));
    w.actors[f].hp = max;
    assert_eq!(pose_of(&w, weap as u32 * 2), Some((Pose::Still as u32, 0)));
    assert_eq!(pose_of(&w, layer), Some((Pose::Idle as u32, 0)));
    // Without poses the old rule: the plain slot, the table's value without power.
    w.render_opts.poses = false;
    assert!(sprite_ids(&w).contains(&(posed(layer, Pose::Still, 4))));
    w.players[0].power_gen = 2000;
    assert!(sprite_ids(&w).contains(&(layer as f32)));
}

#[test]
fn structure_layer_records_match_the_cpu_path() {
    let mut w = world();
    w.render_opts.poses = true;
    let weap = ty(&w, "WEAP");
    let mut table = vec![0u32; w.rules.actors.len()];
    table[weap as usize] = posed(weap as u32 * 2 + 1, Pose::Still, 4) as u32;
    w.render_opts.building_overlays = table;
    w.players[0].power_gen = 100;
    let f = w.spawn_building(weap, 0, 20, 20).unwrap();
    w.spawn_building(weap, 0, 40, 20).unwrap();
    let (ex, ey) = w.rules.actors[weap as usize].building.as_ref().unwrap().exits[0];
    w.tick = 300;
    let u = w.spawn_unit(ty(&w, "1TNK"), 0, cell_center(20 + ex), cell_center(20 + ey), 512);
    w.actors[u].activity = Activity::Move;
    w.rebuild_hash();
    w.door_unit_produced(f, u);
    for _ in 0..4 {
        w.tick_doors();
    }
    w.tick = 304;
    w.update_vision();
    let (mut recs, mut extras, mut rect_recs) = (Vec::new(), Vec::new(), Vec::new());
    w.build_render_records(0, &[], &mut recs, &mut extras, &mut rect_recs);
    let view = View { x0: 0.0, y0: 0.0, x1: 64.0 * 24.0, y1: 64.0 * 24.0 };
    for alpha in [0.0, 0.5, 1.0] {
        let (mut s_cpu, mut r_cpu, mut s_rec, mut r_rec) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
        w.build_render(0, alpha, &view, &[], &mut s_cpu, &mut r_cpu);
        eval_records(&recs, &extras, &rect_recs, alpha, &view, &mut s_rec, &mut r_rec);
        let bits = |v: &[f32]| v.iter().map(|f| f.to_bits()).collect::<Vec<_>>();
        assert_eq!(bits(&s_cpu), bits(&s_rec));
        let layers: Vec<(u32, u32, u32)> =
            s_cpu.chunks(SPRITE_FLOATS).map(|q| unpack(q[3])).filter(|&(s, _, _)| s == weap as u32 * 2 + 1).collect();
        assert_eq!(layers.len(), 2, "one layer per factory");
        assert!(layers.contains(&(weap as u32 * 2 + 1, Pose::Idle as u32, 3)), "the door of the factory that produced");
        assert!(layers.contains(&(weap as u32 * 2 + 1, Pose::Idle as u32, 0)), "the other one stays shut");
    }
}

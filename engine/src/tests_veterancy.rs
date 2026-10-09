//! Veterancy and prone infantry (veterancy.rs): experience from kills, level
//! ups, rank bonuses, elite self repair, TakeCover timing and damage, the
//! debug menu's level up cheat, and determinism.

use crate::math::CELL;
use crate::render::{SpriteIds, View, SPRITE_FLOATS};
use crate::veterancy::Shot;
use crate::world::{cell_center, Activity, GameOptions, Order, PlayerSetup, World, MAX_WEAPONS, NONE};

fn ty(w: &World, id: &str) -> u16 {
    w.rules.actor_index(id).unwrap() as u16
}

fn run(w: &mut World, ticks: u32) {
    for _ in 0..ticks {
        w.step();
    }
}

/// 64x64 open, clear map, everything explored, no ore regrowth.
fn flat_world(cheats: bool) -> World {
    let players = [PlayerSetup::new("russia", None), PlayerSetup::new("england", None)];
    let mut w = World::with_options(11, 64, &players, GameOptions { cheats, ore_regrowth: false, ..GameOptions::default() });
    for i in 0..w.map.cells() {
        w.map.terrain[i] = crate::map::Terrain::Clear;
        w.map.ore[i] = 0;
    }
    w.pass = crate::flowfield::Passability::new(&w.map);
    w.pass_water = crate::flowfield::Passability::water(&w.map);
    for b in 0..w.building_at.len() {
        if w.building_at[b] != NONE {
            w.pass.set_blocked(b, true);
        }
    }
    w.pass.refresh(&w.map);
    for p in w.players.iter_mut() {
        p.explored.iter_mut().for_each(|e| *e = 1);
    }
    w
}

fn unit(w: &mut World, id: &str, owner: u8, cx: i32, cy: i32) -> usize {
    let t = ty(w, id);
    w.spawn_unit(t, owner, cell_center(cx), cell_center(cy), 0)
}

/// A unit that never fires on its own.
fn passive(w: &mut World, id: &str, owner: u8, cx: i32, cy: i32) -> usize {
    let u = unit(w, id, owner, cx, cy);
    w.actors[u].reload = [1_000_000; MAX_WEAPONS];
    u
}

fn weapon(w: &World, name: &str) -> usize {
    w.rules.weapons.iter().position(|x| x.name == name).unwrap()
}

/// Kill `victim` with a hit credited to `killer`.
fn kill_by(w: &mut World, victim: usize, killer: usize) {
    let source = w.make_ref(killer);
    w.damage_from(victim, 1_000_000_000, source, 0);
    assert!(!w.actors[victim].alive);
}

#[test]
fn rules_carry_the_ra_veterancy_and_take_cover_values() {
    let w = flat_world(false);
    let e1 = &w.rules.actors[ty(&w, "E1") as usize];
    let x = e1.experience.as_ref().expect("infantry gain experience");
    assert_eq!(x.thresholds, vec![200, 400, 800, 1600]);
    assert_eq!(x.firepower, vec![105, 110, 120, 130]);
    assert_eq!(x.damage, vec![95, 90, 85, 75]);
    assert_eq!(x.speed, vec![105, 110, 120, 140]);
    assert_eq!(x.reload, vec![95, 90, 85, 75]);
    let h = x.heal.as_ref().expect("elite self repair");
    assert_eq!((h.rank, h.step, h.percentage_step, h.delay, h.start_if_below, h.damage_cooldown), (4, 0, 5, 100, 100, 125));
    let tc = e1.take_cover.as_ref().expect("soldiers take cover");
    assert_eq!((tc.duration, tc.speed_modifier), (50, 50));
    let bit = |name: &str| 1u32 << w.rules.damage_types.iter().position(|d| d == name).unwrap();
    assert_eq!(tc.triggers, bit("TriggerProne"));
    assert_eq!(tc.modifiers, vec![(bit("Prone50Percent"), 50)]);
    // Rifle bullets throw soldiers down; only the types TakeCover uses get bits.
    let carbine = &w.rules.weapons[weapon(&w, "M1Carbine")].warheads[0];
    // The death type picks the death animation (infantry_combat.rs).
    assert_eq!(carbine.damage_types, bit("TriggerProne") | bit("Prone50Percent") | bit("DefaultDeath"));
    assert_eq!(w.rules.weapons[weapon(&w, "MADTankThump")].warheads[0].damage_types, 0);
    // Structures give experience but gain none; walls neither; ore trucks only give.
    let powr = &w.rules.actors[ty(&w, "POWR") as usize];
    assert!(powr.experience.is_none() && powr.gives_experience.as_ref().is_some_and(|g| g.experience == -1 && g.actor_modifier == 10000));
    let sbag = &w.rules.actors[ty(&w, "SBAG") as usize];
    assert!(sbag.experience.is_none() && sbag.gives_experience.is_none());
    let harv = &w.rules.actors[ty(&w, "HARV") as usize];
    assert!(harv.experience.is_none() && harv.gives_experience.is_some());
    // Vehicles do not take cover; the Mammoth Tank gains experience on top of its own repair.
    let mammoth = &w.rules.actors[ty(&w, "4TNK") as usize];
    assert!(mammoth.take_cover.is_none() && mammoth.experience.is_some() && mammoth.self_heal.is_some());
}

#[test]
fn kills_give_the_victims_value_as_experience() {
    let mut w = flat_world(false);
    let tank = passive(&mut w, "2TNK", 0, 30, 30);
    let cost = w.rules.actors[ty(&w, "2TNK") as usize].cost as i64;
    // OpenRA counts percent of a value: an E1 ($100) is worth 10000.
    let e1 = passive(&mut w, "E1", 1, 40, 40);
    kill_by(&mut w, e1, tank);
    assert_eq!(w.actors[tank].xp, 100 * 100);
    assert_eq!(w.actors[tank].rank, 0);
    // Level 1 at twice its own value in kills.
    assert_eq!(w.level_experience(tank, 1), 200 * cost);
    let needed = w.level_experience(tank, 1) - w.actors[tank].xp;
    for _ in 0..(needed / 10000 - 1) {
        let e = passive(&mut w, "E1", 1, 40, 40);
        kill_by(&mut w, e, tank);
    }
    assert_eq!(w.actors[tank].rank, 0, "one kill short");
    let e = passive(&mut w, "E1", 1, 40, 40);
    kill_by(&mut w, e, tank);
    assert!(w.actors[tank].xp >= w.level_experience(tank, 1));
    assert_eq!(w.actors[tank].rank, 1);
    // A Badger bomber has an explicit Experience of 1000.
    let badger = &w.rules.actors[ty(&w, "BADR.Bomber") as usize];
    assert_eq!(badger.gives_experience.as_ref().unwrap().experience, 1000);
}

#[test]
fn one_big_kill_rises_through_several_levels_and_experience_is_capped() {
    let mut w = flat_world(false);
    let rifle = passive(&mut w, "E1", 0, 30, 30);
    let mammoth = passive(&mut w, "4TNK", 1, 40, 40);
    kill_by(&mut w, mammoth, rifle);
    // $2000 = 200000 > 1600 x $100: straight to elite, experience capped at the last level.
    assert_eq!(w.actors[rifle].rank, 4);
    assert_eq!(w.max_rank(rifle), 4);
    assert_eq!(w.actors[rifle].xp, w.level_experience(rifle, 4));
    assert_eq!(w.actors[rifle].xp, 1600 * 100);
}

#[test]
fn allies_passengers_and_unranked_killers_gain_nothing() {
    let mut w = flat_world(false);
    let tank = passive(&mut w, "2TNK", 0, 30, 30);
    // Own units give nothing.
    let own = passive(&mut w, "E1", 0, 40, 40);
    kill_by(&mut w, own, tank);
    assert_eq!(w.actors[tank].xp, 0);
    // A unit inside a transport gains nothing (GainsExperienceMultiplier 0 in cargo).
    let apc = passive(&mut w, "APC", 0, 20, 20);
    let rider = passive(&mut w, "E1", 0, 20, 21);
    w.actors[rider].carrier = w.make_ref(apc);
    let enemy = passive(&mut w, "E1", 1, 40, 40);
    kill_by(&mut w, enemy, rider);
    assert_eq!(w.actors[rider].xp, 0);
    // Ore trucks have no GainsExperience: crushing earns them nothing.
    let harv = passive(&mut w, "HARV", 0, 25, 25);
    let enemy = passive(&mut w, "E1", 1, 40, 40);
    kill_by(&mut w, enemy, harv);
    assert_eq!((w.actors[harv].xp, w.actors[harv].rank), (0, 0));
    // A dead or unknown source is ignored.
    let enemy = passive(&mut w, "E1", 1, 40, 40);
    w.damage_from(enemy, 1_000_000, 0x00ff_ffff, 0);
    assert!(!w.actors[enemy].alive);
}

#[test]
fn shots_in_flight_credit_their_shooter() {
    // End to end: a tank shell (a Bullet projectile) kills a soldier; the kill
    // is credited when the shell lands, through the projectile's Shot.
    let mut w = flat_world(false);
    let tank = unit(&mut w, "2TNK", 0, 30, 30);
    let e1 = passive(&mut w, "E1", 1, 33, 30);
    w.actors[e1].hp = 1;
    w.queue_order(Order::Attack { player: 0, ids: vec![w.make_ref(tank)], target: w.make_ref(e1) });
    for _ in 0..200 {
        w.step();
        if !w.actors[e1].alive {
            break;
        }
    }
    assert!(!w.actors[e1].alive, "the tank killed the soldier");
    assert_eq!(w.actors[tank].xp, 100 * 100);
}

#[test]
fn crushing_infantry_counts_as_a_kill() {
    // As tests.rs tanks_crush_enemy_infantry_but_not_friends, with the kill credited.
    let mut w = flat_world(false);
    let (x0, y) = (cell_center(20), cell_center(30));
    let tank = w.spawn_unit(ty(&w, "1TNK"), 0, x0, y, 256);
    let e1 = w.spawn_unit(ty(&w, "E1"), 1, x0 + 3 * CELL, y, 768);
    w.actors[tank].reload = [1_000_000; MAX_WEAPONS];
    w.actors[e1].reload = [1_000_000; MAX_WEAPONS];
    w.queue_order(Order::Move { player: 0, ids: vec![w.make_ref(tank)], x: x0 + 6 * CELL, y, attack_move: false });
    run(&mut w, 25 * 6);
    assert!(!w.actors[e1].alive, "crushed");
    assert_eq!(w.actors[tank].xp, 100 * 100);
}

#[test]
fn firepower_rises_and_damage_taken_falls_with_rank() {
    let mut w = flat_world(false);
    let rookie = passive(&mut w, "2TNK", 0, 10, 30);
    let elite = passive(&mut w, "2TNK", 0, 10, 40);
    w.give_levels(elite, 4);
    assert_eq!((w.actors[elite].rank, w.firepower_modifier(elite)), (4, 130));
    let a = passive(&mut w, "3TNK", 1, 30, 20);
    let b = passive(&mut w, "3TNK", 1, 30, 50);
    let tough = passive(&mut w, "3TNK", 1, 50, 20);
    let vet = passive(&mut w, "3TNK", 1, 50, 50);
    // Warheads find their victims through the spatial hash, rebuilt every tick.
    run(&mut w, 1);
    let gun = weapon(&w, "90mm");
    let hp = w.actors[a].hp;
    let (ax, ay) = (w.actors[a].x, w.actors[a].y);
    let (bx, by) = (w.actors[b].x, w.actors[b].y);
    let (rs, es) = (w.shot_of(rookie), w.shot_of(elite));
    w.impact_shot(gun, ax, ay, 0, rs);
    w.impact_shot(gun, bx, by, 0, es);
    let wh = &w.rules.weapons[gun].warheads[0];
    let versus = wh.versus[w.rules.actors[ty(&w, "3TNK") as usize].armor] as i64;
    let plain = (wh.damage as i64 * versus / 100) as i32;
    let strong = (wh.damage as i64 * 130 / 100 * versus / 100) as i32;
    assert_eq!(hp - w.actors[a].hp, plain);
    assert_eq!(hp - w.actors[b].hp, strong);
    // An elite victim takes 75 %.
    w.give_levels(tough, 4);
    let (tx, tyy) = (w.actors[tough].x, w.actors[tough].y);
    w.impact_shot(gun, tx, tyy, 0, rs);
    assert_eq!(hp - w.actors[tough].hp, plain * 75 / 100);
    // Each level in between has its own values.
    w.give_levels(vet, 2);
    assert_eq!(w.actors[vet].rank, 2);
    assert_eq!(w.modified_damage(vet, 1000, 0), 900);
    assert_eq!(w.firepower_modifier(vet), 110);
}

#[test]
fn elite_units_move_faster_and_reload_sooner() {
    let mut w = flat_world(false);
    let rookie = passive(&mut w, "E1", 0, 20, 20);
    let elite = passive(&mut w, "E1", 0, 20, 40);
    w.give_levels(elite, 4);
    let u = w.rules.actors[ty(&w, "E1") as usize].unit.clone().unwrap();
    let step = |w: &mut World, i: usize| {
        let (x, y) = (w.actors[i].x, w.actors[i].y);
        w.step_toward(i, x + 10 * CELL, y, &u);
        w.actors[i].x - x
    };
    let base = step(&mut w, rookie);
    assert!(base > 0);
    assert_eq!(step(&mut w, elite), base * 140 / 100);
    // Reload: the full ReloadDelay shrinks to 75 %; burst delays stay.
    let target = passive(&mut w, "E1", 1, 23, 40);
    w.actors[elite].reload = [0; MAX_WEAPONS];
    w.aim_and_fire(elite, target);
    let carbine = &w.rules.weapons[w.rules.actors[ty(&w, "E1") as usize].weapons[0]];
    let (burst, reload) = (carbine.burst, carbine.reload);
    assert_eq!(burst, 1);
    assert_eq!(w.actors[elite].reload[0], reload * 75 / 100);
    w.actors[rookie].reload = [0; MAX_WEAPONS];
    let target2 = passive(&mut w, "E1", 1, 23, 20);
    w.aim_and_fire(rookie, target2);
    assert_eq!(w.actors[rookie].reload[0], reload);
}

#[test]
fn elite_units_repair_themselves_after_a_quiet_spell() {
    let mut w = flat_world(false);
    let elite = passive(&mut w, "2TNK", 0, 30, 30);
    let vet = passive(&mut w, "2TNK", 0, 30, 40);
    w.give_levels(elite, 4);
    w.give_levels(vet, 3);
    let max = w.actors[elite].hp;
    run(&mut w, 1);
    w.damage(elite, max / 2);
    w.damage(vet, max / 2);
    let (hurt, vet_hurt) = (w.actors[elite].hp, w.actors[vet].hp);
    // Damage taken: 75 % at elite, 85 % at level 3.
    assert_eq!((hurt, vet_hurt), (max - max / 2 * 75 / 100, max - max / 2 * 85 / 100));
    // DamageCooldown 125 ticks, then 5 % of the maximum every 100 ticks.
    run(&mut w, 124 + 99);
    assert_eq!(w.actors[elite].hp, hurt, "no repair during the cooldown and the first delay");
    run(&mut w, 2);
    assert_eq!(w.actors[elite].hp, hurt + max * 5 / 100);
    // A hit restarts the cooldown.
    w.damage(elite, 100);
    let hp = w.actors[elite].hp;
    run(&mut w, 200);
    assert_eq!(w.actors[elite].hp, hp);
    // Full health eventually; veterans below elite never repair.
    run(&mut w, 100 * 25);
    assert_eq!(w.actors[elite].hp, max);
    assert_eq!(w.actors[vet].hp, vet_hurt);
}

#[test]
fn rifle_fire_throws_soldiers_prone_for_50_ticks() {
    let mut w = flat_world(false);
    let e1 = passive(&mut w, "E1", 1, 30, 30);
    run(&mut w, 1);
    let rifle = weapon(&w, "M1Carbine");
    let (x, y) = (w.actors[e1].x, w.actors[e1].y);
    let hp = w.actors[e1].hp;
    let full = hp - {
        w.impact(rifle, x, y, 0);
        w.actors[e1].hp
    };
    assert!(full > 0);
    assert!(w.is_prone(e1), "the first hit throws the soldier down");
    assert_eq!(hp - w.actors[e1].hp, full, "and lands at full damage");
    // Prone50Percent: the next hit lands at half damage.
    let before = w.actors[e1].hp;
    w.impact(rifle, x, y, 0);
    assert_eq!(before - w.actors[e1].hp, full / 2);
    // Duration 50 from the last hit.
    run(&mut w, 49);
    assert!(w.is_prone(e1));
    run(&mut w, 1);
    assert!(!w.is_prone(e1), "stands up 50 ticks after the last hit");
    let before = w.actors[e1].hp;
    w.impact(rifle, x, y, 0);
    assert_eq!(before - w.actors[e1].hp, full, "standing again: full damage");
}

#[test]
fn only_trigger_damage_types_make_soldiers_prone() {
    let mut w = flat_world(false);
    let e1 = passive(&mut w, "E1", 1, 30, 30);
    // Hits without a TriggerProne type (a MAD tank thump has none; Prone50Percent alone is no trigger) do not.
    let bit = |name: &str| 1u32 << w.rules.damage_types.iter().position(|d| d == name).unwrap();
    let (halved, trigger) = (bit("Prone50Percent"), bit("TriggerProne"));
    let hp = w.actors[e1].hp;
    w.damage_from(e1, 100, NONE, 0);
    w.damage_from(e1, 100, NONE, halved);
    assert_eq!(w.actors[e1].hp, hp - 200);
    assert!(!w.is_prone(e1));
    w.damage_from(e1, 100, NONE, trigger);
    assert!(w.is_prone(e1));
    // Vehicles never take cover.
    let tank = passive(&mut w, "2TNK", 1, 40, 40);
    let source = w.make_ref(e1);
    let types = w.rules.weapons[weapon(&w, "M1Carbine")].warheads[0].damage_types;
    w.damage_from(tank, 100, source, types);
    assert!(!w.is_prone(tank));
}

#[test]
fn prone_soldiers_crawl_at_half_speed_and_are_drawn_lying_down() {
    let mut w = flat_world(false);
    let e1 = passive(&mut w, "E1", 0, 20, 20);
    let u = w.rules.actors[ty(&w, "E1") as usize].unit.clone().unwrap();
    let (x, y) = (w.actors[e1].x, w.actors[e1].y);
    w.step_toward(e1, x + 10 * CELL, y, &u);
    let walk = w.actors[e1].x - x;
    w.actors[e1].prone_ticks = 10;
    let x = w.actors[e1].x;
    w.step_toward(e1, x + 10 * CELL, y, &u);
    assert_eq!(w.actors[e1].x - x, walk * 50 / 100);
    // Rendering: the prone pose is the infantry's second sprite slot.
    let view = View { x0: 0.0, y0: 0.0, x1: 64.0 * 24.0, y1: 64.0 * 24.0 };
    let (mut sprites, mut rects) = (Vec::new(), Vec::new());
    w.build_render(0, 1.0, &view, &[], &mut sprites, &mut rects);
    let body = ty(&w, "E1") as f32 * 2.0;
    let has = |s: &[f32], id: f32| s.chunks(SPRITE_FLOATS).any(|c| c[3] == id);
    assert!(has(&sprites, body + 1.0) && !has(&sprites, body));
    w.actors[e1].prone_ticks = 0;
    w.build_render(0, 1.0, &view, &[], &mut sprites, &mut rects);
    assert!(has(&sprites, body) && !has(&sprites, body + 1.0));
}

#[test]
fn rank_decorations_are_drawn_for_ranked_units() {
    let mut w = flat_world(false);
    let ids = SpriteIds::new(w.rules.actors.len());
    let view = View { x0: 0.0, y0: 0.0, x1: 64.0 * 24.0, y1: 64.0 * 24.0 };
    let count = |w: &World, id: f32| {
        let (mut sprites, mut rects) = (Vec::new(), Vec::new());
        w.build_render(0, 1.0, &view, &[], &mut sprites, &mut rects);
        sprites.chunks(SPRITE_FLOATS).filter(|c| c[3] == id).count()
    };
    let t = passive(&mut w, "2TNK", 0, 30, 30);
    let enemy = passive(&mut w, "2TNK", 1, 34, 30);
    for k in 0..4 {
        assert_eq!(count(&w, ids.veterancy_base + k as f32), 0);
    }
    w.give_levels(t, 1);
    assert_eq!(count(&w, ids.veterancy_base), 1, "one chevron");
    w.give_levels(t, 2);
    assert_eq!(count(&w, ids.veterancy_base + 2.0), 1, "three chevrons");
    w.give_levels(t, 1);
    assert_eq!(count(&w, ids.veterancy_base + 3.0), 1, "elite");
    // Enemy ranks show too (OpenRA ValidRelationships: Ally, Enemy, Neutral), when visible.
    w.give_levels(enemy, 4);
    w.update_vision();
    assert_eq!(count(&w, ids.veterancy_base + 3.0), 2);
}

#[test]
fn level_up_cheat_raises_own_units_one_rank_with_the_cheats_option() {
    for cheats in [false, true] {
        let mut w = flat_world(cheats);
        let own = passive(&mut w, "1TNK", 0, 30, 30);
        let enemy = passive(&mut w, "1TNK", 1, 40, 40);
        let ids = vec![w.make_ref(own), w.make_ref(own), w.make_ref(enemy), NONE, 0x00ff_ffff];
        let o: Order = serde_json::from_value(serde_json::json!({"o": "dev_experience", "player": 0, "ids": ids})).unwrap();
        assert!(o.is_cheat() && o.is_reasonable() && o.player() == 0);
        w.queue_order(o);
        run(&mut w, 1);
        assert_eq!(w.actors[own].rank, u8::from(cheats), "once, even when listed twice");
        assert_eq!(w.actors[enemy].rank, 0, "never other players' units");
        if cheats {
            assert_eq!(w.actors[own].xp, w.level_experience(own, 1));
            for _ in 0..6 {
                w.queue_order(Order::DevExperience { player: 0, ids: vec![w.make_ref(own)] });
                run(&mut w, 1);
            }
            assert_eq!(w.actors[own].rank, 4, "stops at elite");
            // Structures cannot rank up.
            let yard = (0..w.actors.len())
                .find(|&i| w.actors[i].alive && w.actors[i].owner == 0 && w.actors[i].kind == crate::rules::Kind::Building)
                .unwrap();
            w.queue_order(Order::DevExperience { player: 0, ids: vec![w.make_ref(yard)] });
            run(&mut w, 1);
            assert_eq!(w.actors[yard].rank, 0);
        }
    }
    assert_eq!(
        serde_json::to_value(Order::DevExperience { player: 1, ids: vec![3] }).unwrap(),
        serde_json::json!({"o": "dev_experience", "player": 1, "ids": [3]})
    );
    assert!(!Order::DevExperience { player: 0, ids: vec![0; 2001] }.is_reasonable());
}

#[test]
fn veterancy_and_prone_state_are_deterministic() {
    // Two identical skirmishes of tanks against riflemen: same experience,
    // ranks, prone timers and state hash on every tick.
    let build = || {
        let mut w = flat_world(false);
        for k in 0..4 {
            unit(&mut w, "1TNK", 0, 20 + k * 2, 30);
            unit(&mut w, "E1", 1, 20 + k * 2, 36);
            unit(&mut w, "E1", 1, 21 + k * 2, 37);
        }
        let ids: Vec<u32> = (0..w.actors.len())
            .filter(|&i| w.actors[i].alive && w.actors[i].owner == 0 && w.actors[i].is_unit())
            .map(|i| w.make_ref(i))
            .collect();
        w.queue_order(Order::Move { player: 0, ids, x: cell_center(26), y: cell_center(40), attack_move: true });
        w
    };
    let (mut a, mut b) = (build(), build());
    let mut saw_prone = false;
    for _ in 0..600 {
        a.step();
        b.step();
        assert_eq!(a.state_hash(), b.state_hash());
        saw_prone |= (0..a.actors.len()).any(|i| a.actors[i].alive && a.is_prone(i));
    }
    assert!(saw_prone, "the fight threw soldiers prone");
    let xp: i64 = a.actors.iter().filter(|x| x.alive).map(|x| x.xp).sum();
    assert!(xp > 0, "the fight gave experience");
    // The hash covers veterancy: a level changes it.
    let i = (0..a.actors.len())
        .find(|&i| a.actors[i].alive && a.actors[i].owner == 0 && a.actors[i].activity != Activity::Harvest && a.max_rank(i) > 0)
        .unwrap();
    let before = a.state_hash();
    a.give_levels(i, 1);
    assert_ne!(a.state_hash(), before);
    // Plain shots carry no shooter.
    assert_eq!(Shot::NONE.source, NONE);
}

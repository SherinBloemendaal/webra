//! Tests for unit abilities and support powers (abilities.rs).

use crate::abilities::Task;
use crate::math::CELL;
use crate::rules::Kind;
use crate::world::{cell_center, Activity, Order, SmartAction, World, MAX_WEAPONS};

fn ty(w: &World, id: &str) -> u16 {
    w.rules.actor_index(id).unwrap() as u16
}

fn run(w: &mut World, ticks: u32) {
    for _ in 0..ticks {
        w.step();
    }
}

/// 64x64 open, clear map; both players have their Construction Yard and have
/// explored everything.
fn flat_world(factions: [&str; 2]) -> World {
    let mut w = World::new(7, 64, &[(factions[0], false), (factions[1], false)]);
    flatten(&mut w);
    w
}

fn flatten(w: &mut World) {
    w.clear_neutral_world();
    for i in 0..w.map.cells() {
        w.map.terrain[i] = crate::map::Terrain::Clear;
        w.map.ore[i] = 0;
        w.map.gems[i] = 0;
    }
    w.pass = crate::flowfield::Passability::new(&w.map);
    w.pass_water = crate::flowfield::Passability::water(&w.map);
    w.pass_landing = crate::flowfield::Passability::landing(&w.map);
    for b in 0..w.building_at.len() {
        if w.building_at[b] != crate::world::NONE {
            w.pass.set_blocked(b, true);
        }
    }
    w.pass.refresh(&w.map);
    for p in w.players.iter_mut() {
        p.explored.iter_mut().for_each(|e| *e = 1);
    }
    w.options.ore_regrowth = false;
}

fn unit(w: &mut World, id: &str, owner: u8, cx: i32, cy: i32) -> usize {
    let t = ty(w, id);
    w.spawn_unit(t, owner, cell_center(cx), cell_center(cy), 0)
}

/// Unit that never fires (keeps fights out of ability tests).
fn passive(w: &mut World, id: &str, owner: u8, cx: i32, cy: i32) -> usize {
    let u = unit(w, id, owner, cx, cy);
    w.actors[u].reload = [1_000_000; MAX_WEAPONS];
    u
}

fn mines(w: &World, owner: u8) -> Vec<usize> {
    (0..w.actors.len()).filter(|&i| w.actors[i].alive && w.actors[i].kind == Kind::Mine && w.actors[i].owner == owner).collect()
}

fn refs(w: &World, units: &[usize]) -> Vec<u32> {
    units.iter().map(|&u| w.make_ref(u)).collect()
}

// ---- Minelayer and mines -------------------------------------------------------------

#[test]
fn minelayer_lays_a_minefield_and_enemy_tanks_set_mines_off() {
    let mut w = flat_world(["allies", "soviet"]);
    let ml = unit(&mut w, "MNLY", 0, 30, 30);
    assert_eq!(w.actors[ml].ab.ammo, 5, "AmmoPool.Ammo");
    let ids = refs(&w, &[ml]);
    w.queue_order(Order::LayMines { player: 0, ids, x0: 32, y0: 30, x1: 34, y1: 30 });
    run(&mut w, 25 * 20);
    let laid = mines(&w, 0);
    assert_eq!(laid.len(), 3, "one mine per cell");
    assert_eq!(w.actors[ml].ab.ammo, 2);
    assert_eq!(w.actors[ml].activity, Activity::Idle);
    assert!(laid.iter().all(|&m| w.rules.actors[w.actors[m].ty as usize].id == "MINV"));
    // Mines are invisible to the enemy: not targetable, not pickable.
    let m = w.mine_at(w.map.idx(33, 30)).unwrap();
    assert!(w.is_cloaked_from(m, 1) && !w.is_cloaked_from(m, 0));
    assert!(!w.targetable(m, 1));
    assert_eq!(w.actor_at(1, cell_center(33), cell_center(30)), None);
    // An enemy tank drives across and sets one off (ATMine: 40000 damage).
    let tank = passive(&mut w, "3TNK", 1, 33, 26);
    let hp = w.actors[tank].hp;
    let tr = w.make_ref(tank);
    w.queue_order(Order::Move { player: 1, ids: vec![tr], x: cell_center(33), y: cell_center(34), attack_move: false });
    run(&mut w, 25 * 15);
    assert!(w.resolve(tr).is_none() || w.actors[tank].hp <= hp - 30000, "mine hit the tank: {} -> {}", hp, w.actors[tank].hp);
    assert_eq!(mines(&w, 0).len(), 2, "the mine is used up, the others stay");
}

#[test]
fn own_units_set_off_mines_but_the_minelayer_does_not() {
    let mut w = flat_world(["allies", "soviet"]);
    let ml = unit(&mut w, "MNLY", 0, 20, 20);
    w.queue_order(Order::Deploy { player: 0, ids: refs(&w, &[ml]) });
    run(&mut w, 2);
    assert_eq!(mines(&w, 0).len(), 1, "deploy lays a mine under the minelayer");
    // The minelayer drives over its own mines (MineImmune).
    let ids = refs(&w, &[ml]);
    w.queue_order(Order::Move { player: 0, ids, x: cell_center(25), y: cell_center(20), attack_move: false });
    run(&mut w, 25 * 6);
    assert!(w.actors[ml].alive && w.actors[ml].hp == w.rules.actors[w.actors[ml].ty as usize].hp);
    assert_eq!(mines(&w, 0).len(), 1);
    // A friendly jeep does not (Mine.AvoidFriendly: false).
    let jeep = passive(&mut w, "JEEP", 0, 20, 24);
    let jr = w.make_ref(jeep);
    w.queue_order(Order::Move { player: 0, ids: vec![jr], x: cell_center(20), y: cell_center(16), attack_move: false });
    run(&mut w, 25 * 8);
    assert!(w.resolve(jr).is_none(), "jeep destroyed by its own side's mine");
    assert_eq!(mines(&w, 0).len(), 0);
}

#[test]
fn enemy_minelayer_detects_mines_and_explosions_clear_them() {
    let mut w = flat_world(["allies", "soviet"]);
    let ml = unit(&mut w, "MNLY", 0, 20, 20);
    w.queue_order(Order::Deploy { player: 0, ids: refs(&w, &[ml]) });
    run(&mut w, 2);
    let ids = refs(&w, &[ml]);
    w.queue_order(Order::Move { player: 0, ids, x: cell_center(10), y: cell_center(30), attack_move: false });
    run(&mut w, 25 * 6);
    let m = w.mine_at(w.map.idx(20, 20)).unwrap();
    let probe = unit(&mut w, "E1", 1, 22, 20);
    run(&mut w, 2);
    assert!(w.is_cloaked_from(m, 1), "riflemen detect Cloak, not Mine");
    // A Soviet minelayer (DetectCloaked Mine, 5c0) reveals it.
    let _ = probe;
    unit(&mut w, "MNLY", 1, 23, 22);
    run(&mut w, 2);
    assert!(!w.is_cloaked_from(m, 1));
    assert_eq!(w.actor_at(1, cell_center(20), cell_center(20)), Some(m));
    // Force-attack it: anything that hits ground actors damages mines.
    let tank = unit(&mut w, "3TNK", 1, 24, 24);
    let (tr, mr) = (w.make_ref(tank), w.make_ref(m));
    w.queue_order(Order::Attack { player: 1, ids: vec![tr], target: mr });
    run(&mut w, 25 * 6);
    assert!(w.resolve(mr).is_none(), "mine destroyed by tank fire");
}

#[test]
fn empty_minelayer_rearms_at_the_service_depot_and_finishes_the_field() {
    let mut w = flat_world(["allies", "soviet"]);
    w.spawn_building(ty(&w, "FIX"), 0, 30, 30);
    w.refresh_tokens();
    let ml = unit(&mut w, "MNLY", 0, 20, 30);
    w.actors[ml].ab.ammo = 1;
    let ids = refs(&w, &[ml]);
    w.queue_order(Order::LayMines { player: 0, ids, x0: 18, y0: 34, x1: 19, y1: 34 });
    run(&mut w, 25 * 10);
    assert_eq!(mines(&w, 0).len(), 1, "one mine, then out of ammo");
    assert!(matches!(w.actors[ml].ab.task, Task::Rearm | Task::LayMines));
    run(&mut w, 25 * 40);
    assert_eq!(mines(&w, 0).len(), 2, "rearmed at the depot and came back for the second cell");
    assert_eq!(w.actors[ml].ab.ammo, 4, "reloaded to 5 (50 ticks per mine), then laid one");
}

#[test]
fn mines_alone_do_not_keep_a_player_alive_and_cannot_be_ordered() {
    let mut w = flat_world(["allies", "soviet"]);
    let ml = unit(&mut w, "MNLY", 1, 20, 20);
    w.queue_order(Order::Deploy { player: 1, ids: refs(&w, &[ml]) });
    run(&mut w, 2);
    let m = mines(&w, 1)[0];
    let mr = w.make_ref(m);
    w.queue_order(Order::Move { player: 1, ids: vec![mr], x: cell_center(40), y: cell_center(40), attack_move: false });
    run(&mut w, 25);
    assert_eq!(w.cell_of(w.actors[m].x, w.actors[m].y), (20, 20), "mines do not move");
    for i in 0..w.actors.len() {
        if w.actors[i].alive && w.actors[i].owner == 1 && w.actors[i].kind != Kind::Mine {
            w.kill(i);
        }
    }
    run(&mut w, 30);
    assert!(w.players[1].defeated && w.has_won(0));
}

#[test]
fn lay_mines_order_is_validated() {
    let mut w = flat_world(["allies", "soviet"]);
    let ml = unit(&mut w, "MNLY", 0, 20, 20);
    let tank = unit(&mut w, "2TNK", 0, 22, 20);
    let ids = refs(&w, &[ml, tank]);
    // Another player cannot order it; a tank ignores the order.
    w.queue_order(Order::LayMines { player: 1, ids: ids.clone(), x0: 20, y0: 22, x1: 21, y1: 22 });
    run(&mut w, 25 * 6);
    assert!(mines(&w, 0).is_empty());
    let huge = Order::LayMines { player: 0, ids: ids.clone(), x0: 0, y0: 0, x1: 63, y1: 63 };
    assert!(!huge.is_reasonable(), "minefields are bounded");
    w.queue_order(Order::LayMines { player: 0, ids, x0: 20, y0: 22, x1: 20, y1: 22 });
    run(&mut w, 2);
    assert_eq!(w.actors[tank].activity, Activity::Idle);
    assert_eq!(w.actors[ml].ab.task, Task::LayMines);
    // Orders round-trip through the multiplayer JSON.
    let o = Order::LayMines { player: 0, ids: vec![1, 2], x0: 1, y0: 2, x1: 3, y1: 4 };
    let back: Order = serde_json::from_str(&serde_json::to_string(&o).unwrap()).unwrap();
    assert_eq!(format!("{back:?}"), format!("{o:?}"));
}

// ---- Cloak and detection -----------------------------------------------------------

#[test]
fn phase_transport_cloaks_uncloaks_when_firing_and_is_detected_up_close() {
    let mut w = flat_world(["france", "soviet"]);
    let stnk = unit(&mut w, "STNK", 0, 20, 20);
    let enemy = passive(&mut w, "3TNK", 1, 25, 20);
    assert!(!w.actors[stnk].ab.cloaked);
    run(&mut w, 124);
    assert!(!w.actors[stnk].ab.cloaked, "InitialDelay 125");
    run(&mut w, 2);
    assert!(w.actors[stnk].ab.cloaked && w.is_cloaked_from(stnk, 1) && !w.is_cloaked_from(stnk, 0));
    assert!(!w.targetable(stnk, 1), "enemies cannot target it");
    // Attacking uncloaks it for CloakDelay (175 ticks).
    let (sr, er) = (w.make_ref(stnk), w.make_ref(enemy));
    w.queue_order(Order::Attack { player: 0, ids: vec![sr], target: er });
    run(&mut w, 25 * 2);
    assert!(!w.actors[stnk].ab.cloaked, "visible while it fires");
    assert!(w.targetable(stnk, 1));
    w.queue_order(Order::Stop { player: 0, ids: vec![sr] });
    run(&mut w, 180);
    assert!(w.actors[stnk].ab.cloaked, "cloaks again after CloakDelay");
    // A rifleman next to it detects it (DetectCloaked 1c512).
    unit(&mut w, "E1", 1, 21, 20);
    run(&mut w, 2);
    assert!(!w.is_cloaked_from(stnk, 1));
    // Critically damaged: the cloak stops working.
    let max = w.rules.actors[w.actors[stnk].ty as usize].hp;
    w.actors[stnk].hp = max / 5;
    run(&mut w, 2);
    assert!(!w.actors[stnk].ab.cloaked);
}

#[test]
fn camo_pillbox_is_invisible_to_enemy_tanks() {
    let mut w = flat_world(["allies", "soviet"]);
    let hbox = w.spawn_building(ty(&w, "HBOX"), 0, 30, 30).unwrap();
    w.actors[hbox].reload = [1_000_000; MAX_WEAPONS];
    run(&mut w, 130);
    assert!(w.actors[hbox].ab.cloaked);
    let tank = unit(&mut w, "3TNK", 1, 30, 34);
    run(&mut w, 25 * 4);
    assert_eq!(w.actors[hbox].hp, w.rules.actors[w.actors[hbox].ty as usize].hp, "never auto-targeted");
    assert!(w.actors[tank].target == crate::world::NONE || w.resolve(w.actors[tank].target) != Some(hbox));
    assert_eq!(w.actor_at(1, cell_center(30), cell_center(30)), None);
    assert!(!w.players[1].ghosts.contains_key(&w.make_ref(hbox)), "no ghost of a cloaked structure");
    // Its own fire gives it away.
    w.actors[hbox].reload = [0; MAX_WEAPONS];
    run(&mut w, 25 * 3);
    assert!(!w.actors[hbox].ab.cloaked);
}

// ---- Jammer and gap generators ------------------------------------------------------

/// Chrono tank fires its missiles at a tank for 12 s; returns the damage done.
fn missile_damage(with_jammer: bool) -> i32 {
    let mut w = flat_world(["germany", "england"]);
    let ctnk = unit(&mut w, "CTNK", 0, 20, 30);
    let target = passive(&mut w, "2TNK", 1, 25, 30);
    if with_jammer {
        passive(&mut w, "MRJ", 1, 26, 31);
    }
    let hp = w.actors[target].hp;
    let (cr, tr) = (w.make_ref(ctnk), w.make_ref(target));
    w.queue_order(Order::Attack { player: 0, ids: vec![cr], target: tr });
    run(&mut w, 25 * 12);
    hp - w.actors[target].hp.max(0)
}

#[test]
fn radar_jammer_makes_enemy_missiles_miss() {
    let clean = missile_damage(false);
    let jammed = missile_damage(true);
    assert!(clean > 10_000, "missiles hit without a jammer: {clean}");
    assert!(jammed * 4 < clean, "jammed missiles mostly miss: {jammed} vs {clean}");
}

#[test]
fn gap_generator_shrouds_the_area_for_enemies() {
    let mut w = flat_world(["england", "soviet"]);
    // Enemy tank 6 cells out: sees the area, but only 4 cells through gap shroud.
    let scout = unit(&mut w, "2TNK", 1, 30, 19);
    w.actors[scout].reload = [1_000_000; MAX_WEAPONS];
    w.update_vision();
    let ci = w.map.idx(30, 25);
    assert!(w.players[1].visible[ci] != 0);
    let mgg = passive(&mut w, "MGG", 0, 30, 28);
    w.update_vision();
    assert!(w.gen_shrouded(1, ci) && w.players[1].visible[ci] == 0, "Mobile Gap Generator shrouds 7c0 around it");
    let mut fog = Vec::new();
    w.fog_bytes(1, &mut fog);
    assert_eq!(fog[ci], 0, "explored cells under the field read as shroud");
    assert!(w.is_visible_to(scout, 1) && !w.gen_shrouded(0, ci), "the owner is not affected");
    assert!(!w.is_visible_to(mgg, 1), "the generator itself is hidden");
    // Units see 4 cells through it (RevealsShroud@GAPGEN).
    let near = w.map.idx(30, 23);
    assert!(!w.gen_shrouded(1, near) && w.players[1].visible[near] != 0);
    w.kill(mgg);
    run(&mut w, 3);
    assert!(!w.gen_shrouded(1, ci));
    w.fog_bytes(1, &mut fog);
    assert!(fog[ci] > 0, "explored again once the generator is gone");
}

#[test]
fn gap_generator_structure_needs_power_and_hides_enemy_ghosts() {
    let mut w = flat_world(["allies", "soviet"]);
    w.spawn_building(ty(&w, "POWR"), 0, 40, 40);
    w.spawn_building(ty(&w, "GAP"), 0, 44, 44);
    let silo = w.spawn_building(ty(&w, "SILO"), 0, 46, 44).unwrap();
    w.update_power();
    // The enemy scouted the base earlier: it remembers the silo.
    let scout = unit(&mut w, "E1", 1, 46, 47);
    w.actors[scout].reload = [1_000_000; MAX_WEAPONS];
    w.update_vision();
    assert!(w.players[1].ghosts.contains_key(&w.make_ref(silo)) || w.is_visible_to(silo, 1));
    w.kill(scout);
    run(&mut w, 3);
    let ci = w.map.idx(46, 44);
    assert!(w.gen_shrouded(1, ci), "powered Gap Generator shrouds 6c0");
    let mut sprites = Vec::new();
    let mut rects = Vec::new();
    let view = crate::render::View { x0: 0.0, y0: 0.0, x1: 64.0 * 24.0, y1: 64.0 * 24.0 };
    w.build_render(1, 1.0, &view, &[], &mut sprites, &mut rects);
    let silo_sprite = (w.actors[silo].ty * 2) as f32;
    assert!(!sprites.chunks(8).any(|s| s[3] == silo_sprite), "the remembered silo is hidden under the shroud");
    // Low power switches it off.
    w.spawn_building(ty(&w, "IRON"), 0, 50, 50);
    w.update_power();
    run(&mut w, 3);
    assert!(w.players[0].low_power());
    assert!(!w.gen_shrouded(1, ci), "unpowered generators do nothing");
}

// ---- Chrono tank ----------------------------------------------------------------------

#[test]
fn chrono_tank_teleports_within_range_and_recharges() {
    let mut w = flat_world(["germany", "soviet"]);
    let ct = unit(&mut w, "CTNK", 0, 20, 30);
    let ids = refs(&w, &[ct]);
    // 13 cells: beyond MaxDistance 12.
    w.queue_order(Order::Teleport { player: 0, ids: ids.clone(), x: cell_center(33), y: cell_center(30) });
    run(&mut w, 1);
    assert_eq!(w.cell_of(w.actors[ct].x, w.actors[ct].y), (20, 30), "out of range: rejected");
    // Someone else cannot teleport it.
    w.queue_order(Order::Teleport { player: 1, ids: ids.clone(), x: cell_center(30), y: cell_center(30) });
    run(&mut w, 1);
    assert_eq!(w.cell_of(w.actors[ct].x, w.actors[ct].y), (20, 30));
    w.queue_order(Order::Teleport { player: 0, ids: ids.clone(), x: cell_center(32), y: cell_center(30) });
    run(&mut w, 1);
    assert_eq!(w.cell_of(w.actors[ct].x, w.actors[ct].y), (32, 30), "12 cells: teleported");
    assert_eq!(w.actors[ct].ab.chrono_charge, 250 - 1, "ChargeDelay 250, counting down");
    w.queue_order(Order::Teleport { player: 0, ids: ids.clone(), x: cell_center(36), y: cell_center(30) });
    run(&mut w, 1);
    assert_eq!(w.cell_of(w.actors[ct].x, w.actors[ct].y), (32, 30), "still charging: rejected");
    run(&mut w, 250);
    // Unexplored or blocked cells are not valid targets.
    let ci = w.map.idx(36, 30);
    w.players[0].explored[ci] = 0;
    assert!(!w.can_teleport(ct, 36, 30));
    w.players[0].explored[ci] = 1;
    let rock = w.map.idx(36, 31);
    w.pass.set_blocked(rock, true);
    assert!(!w.can_teleport(ct, 36, 31) && w.can_teleport(ct, 36, 30));
    assert_eq!(w.ability_deploy_state(ct), Some(3), "deploy picks a teleport target");
}

// ---- Demolition truck, MAD tank, supply truck ----------------------------------------------

#[test]
fn demolition_truck_detonates_on_deploy_and_when_it_reaches_its_target() {
    let mut w = flat_world(["ukraine", "allies"]);
    let dt = unit(&mut w, "DTRK", 0, 20, 20);
    let victim = passive(&mut w, "2TNK", 1, 21, 21);
    let vr = w.make_ref(victim);
    w.queue_order(Order::Deploy { player: 0, ids: refs(&w, &[dt]) });
    run(&mut w, 10);
    assert!(!w.actors[dt].alive, "deploy blows it up");
    assert!(w.resolve(vr).is_none(), "MiniNuke destroyed the tank next to it");
    // Attack order: drives up to the target and detonates within 2c0.
    let dt = unit(&mut w, "DTRK", 0, 20, 40);
    let pow = w.spawn_building(ty(&w, "POWR"), 1, 32, 40).unwrap();
    passive(&mut w, "E1", 0, 30, 44); // spotter: attacks need the target in sight
    w.update_vision();
    let (dr, pr) = (w.make_ref(dt), w.make_ref(pow));
    w.queue_order(Order::Attack { player: 0, ids: vec![dr], target: pr });
    run(&mut w, 25 * 15);
    assert!(w.resolve(dr).is_none(), "truck detonated");
    assert!(w.resolve(pr).is_none() || w.actors[pow].hp < w.rules.actors[w.actors[pow].ty as usize].hp / 2);
}

#[test]
fn mad_tank_thumps_vehicles_then_detonates_and_the_driver_bails_out() {
    let mut w = flat_world(["soviet", "allies"]);
    let mad = unit(&mut w, "QTNK", 0, 30, 30);
    let other_mad = passive(&mut w, "QTNK", 1, 32, 30);
    let tank = passive(&mut w, "2TNK", 1, 30, 33);
    let soldier = passive(&mut w, "E1", 1, 29, 32);
    let far = passive(&mut w, "2TNK", 1, 30, 40);
    let max = w.rules.actors[w.actors[tank].ty as usize].hp;
    let e1 = ty(&w, "E1");
    let drivers = |w: &World| w.actors.iter().filter(|a| a.alive && a.owner == 0 && a.ty == e1).count();
    w.queue_order(Order::Deploy { player: 0, ids: refs(&w, &[mad]) });
    run(&mut w, 9);
    assert_eq!(w.actors[mad].ab.task, Task::MadDeploy);
    assert_eq!(w.actors[tank].hp, max - max / 100, "first thump after ThumpInterval 8: 1% of max health");
    // Deployed: it cannot be moved away.
    let ids = refs(&w, &[mad]);
    w.queue_order(Order::Move { player: 0, ids, x: cell_center(10), y: cell_center(10), attack_move: false });
    run(&mut w, 25);
    assert_eq!(w.cell_of(w.actors[mad].x, w.actors[mad].y), (30, 30));
    let mref = w.make_ref(mad);
    run(&mut w, 96 + 42 - 9 - 25 - 1);
    assert!(w.resolve(mref).is_some(), "not yet");
    run(&mut w, 1);
    assert!(w.resolve(mref).is_none(), "detonated after ChargeDelay + DetonationDelay");
    assert_eq!(drivers(&w), 1, "the driver bails out");
    // 17 thumps (1%) and the detonation (19%), then the hull's own death explosion.
    let lost = max - w.actors[tank].hp;
    assert!(lost >= max * 36 / 100, "tank lost {lost} of {max}");
    let qmax = w.rules.actors[w.actors[other_mad].ty as usize].hp;
    assert!(w.actors[other_mad].hp > qmax * 9 / 10, "MAD tanks are immune to each other's thumps");
    assert_eq!(w.actors[soldier].hp, w.rules.actors[w.actors[soldier].ty as usize].hp, "infantry is unharmed");
    assert_eq!(w.actors[far].hp, max, "out of the 7c0 range");
}

#[test]
fn supply_truck_delivers_cash_to_own_and_allied_structures_only() {
    use crate::world::PlayerSetup;
    let players: Vec<PlayerSetup> = [("allies", 1u8), ("england", 1), ("soviet", 2)]
        .iter()
        .map(|&(f, t)| PlayerSetup { faction: f.into(), ai: None, team: t })
        .collect();
    let mut w = World::with_options(5, 64, &players, crate::world::GameOptions::default());
    flatten(&mut w);
    let proc_own = w.spawn_building(ty(&w, "POWR"), 0, 30, 20).unwrap();
    let ally_b = w.spawn_building(ty(&w, "POWR"), 1, 30, 30).unwrap();
    let enemy_b = w.spawn_building(ty(&w, "POWR"), 2, 30, 40).unwrap();
    let enemy_def = w.spawn_building(ty(&w, "PBOX"), 0, 36, 20).unwrap();
    let t1 = unit(&mut w, "TRUK", 0, 26, 21);
    let t2 = unit(&mut w, "TRUK", 0, 26, 31);
    w.rebuild_hash();
    w.update_vision();
    let at = |w: &World, b: usize| (w.actors[b].x, w.actors[b].y);
    let (x, y) = at(&w, enemy_b);
    assert_ne!(w.smart_action(0, &[t1], x, y), SmartAction::DeliverCash, "not to enemies");
    let (x, y) = at(&w, enemy_def);
    assert_ne!(w.smart_action(0, &[t1], x, y), SmartAction::DeliverCash, "defences do not accept cash");
    let (x, y) = at(&w, proc_own);
    assert_eq!(w.smart_action(0, &[t1], x, y), SmartAction::DeliverCash);
    let cash = (w.players[0].cash, w.players[1].cash);
    w.queue_order(Order::Smart { player: 0, ids: refs(&w, &[t1]), x, y });
    let (x, y) = at(&w, ally_b);
    assert_eq!(w.smart_action(0, &[t2], x, y), SmartAction::DeliverCash);
    w.queue_order(Order::Smart { player: 0, ids: refs(&w, &[t2]), x, y });
    run(&mut w, 25 * 10);
    assert!(!w.actors[t1].alive && !w.actors[t2].alive, "trucks are used up");
    assert_eq!(w.players[0].cash, cash.0 + 500, "Payload 500 to the owner");
    assert_eq!(w.players[1].cash, cash.1 + 500, "and to the ally's coffers");
}

#[test]
fn abilities_are_deterministic() {
    let play = || {
        let mut w = flat_world(["germany", "soviet"]);
        let ml = unit(&mut w, "MNLY", 0, 20, 20);
        let ct = unit(&mut w, "CTNK", 0, 22, 22);
        let mad = unit(&mut w, "QTNK", 1, 34, 22);
        let mrj = unit(&mut w, "MRJ", 1, 30, 22);
        let _ = mrj;
        let ids = refs(&w, &[ml]);
        w.queue_order(Order::LayMines { player: 0, ids, x0: 24, y0: 18, x1: 27, y1: 19 });
        let ids = refs(&w, &[ct]);
        w.queue_order(Order::Attack { player: 0, ids, target: w.make_ref(mad) });
        w.queue_order(Order::Deploy { player: 1, ids: refs(&w, &[mad]) });
        run(&mut w, 25 * 20);
        (w.state_hash(), w.actors.iter().filter(|a| a.alive).count())
    };
    assert_eq!(play(), play());
}

#[test]
fn deploy_states_for_ability_units() {
    let mut w = flat_world(["ukraine", "allies"]);
    let dt = unit(&mut w, "DTRK", 0, 20, 20);
    let mad = unit(&mut w, "QTNK", 0, 24, 20);
    let ml = unit(&mut w, "MNLY", 0, 28, 20);
    let tank = unit(&mut w, "3TNK", 0, 32, 20);
    assert_eq!(w.ability_deploy_state(dt), Some(1));
    assert_eq!(w.ability_deploy_state(mad), Some(1));
    assert_eq!(w.ability_deploy_state(ml), Some(1));
    assert_eq!(w.ability_deploy_state(tank), None);
    w.actors[ml].ab.ammo = 0;
    assert_eq!(w.ability_deploy_state(ml), Some(2), "no ammo");
    let _ = CELL;
}

// ---- Superweapons ---------------------------------------------------------------------

/// Give `player` a powered structure `id` and a full charge on its power `key`.
fn superweapon(w: &mut World, player: u8, id: &str, cx: i32, cy: i32, key: &str) {
    for k in 0..3 {
        let p = ty(w, "APWR");
        w.spawn_building(p, player, cx + 4 + k * 3, cy);
    }
    let b = ty(w, id);
    w.spawn_building(b, player, cx, cy);
    w.refresh_tokens();
    w.update_power();
    run(w, 1);
    let inst = w.powers.players[player as usize].iter_mut().find(|p| p.key == key).expect("power offered");
    inst.remaining = 0;
}

fn power(w: &mut World, player: u8, key: &str, x: (i32, i32), src: Option<(i32, i32)>) {
    w.queue_order(Order::SupportPower {
        player,
        key: key.into(),
        x: cell_center(x.0),
        y: cell_center(x.1),
        x2: src.map(|s| cell_center(s.0)),
        y2: src.map(|s| cell_center(s.1)),
    });
}

#[test]
fn chronosphere_shifts_vehicles_and_pulls_them_back_after_duration() {
    let mut w = flat_world(["allies", "soviet"]);
    let key = "ChronoshiftPower@chronoshift";
    superweapon(&mut w, 0, "PDOX", 8, 50, key);
    let t1 = passive(&mut w, "2TNK", 0, 20, 20);
    let t2 = passive(&mut w, "2TNK", 0, 21, 20);
    let enemy = passive(&mut w, "3TNK", 1, 20, 21);
    let soldier = passive(&mut w, "E1", 0, 19, 20);
    let outside = passive(&mut w, "2TNK", 0, 22, 22);
    run(&mut w, 1);
    // Not ready: ignored.
    w.powers.players[0].iter_mut().find(|p| p.key == key).unwrap().remaining = 5;
    power(&mut w, 0, key, (40, 30), Some((20, 20)));
    run(&mut w, 1);
    assert_eq!(w.cell_of(w.actors[t1].x, w.actors[t1].y), (20, 20));
    run(&mut w, 5);
    power(&mut w, 0, key, (40, 30), Some((20, 20)));
    run(&mut w, 1);
    let cell = |w: &World, i: usize| w.cell_of(w.actors[i].x, w.actors[i].y);
    assert_eq!(cell(&w, t1), (40, 30));
    assert_eq!(cell(&w, t2), (41, 30));
    assert_eq!(cell(&w, enemy), (40, 31), "enemy vehicles in the area go along");
    assert_eq!(cell(&w, soldier), (19, 20), "infantry is not Chronoshiftable");
    assert_eq!(cell(&w, outside), (22, 22), "outside the 3x3 plus footprint");
    assert!(!w.powers.players[0].iter().find(|p| p.key == key).unwrap().ready(), "timer restarted");
    run(&mut w, 400);
    assert_eq!(cell(&w, t1), (20, 20), "back after Duration 400");
    assert_eq!(cell(&w, enemy), (20, 21));
}

#[test]
fn germany_gets_the_advanced_chronoshift() {
    let mut w = flat_world(["germany", "soviet"]);
    superweapon(&mut w, 0, "PDOX", 8, 50, "ChronoshiftPower@advancedchronoshift");
    assert!(w.power_instances(0).iter().all(|p| p.key != "ChronoshiftPower@chronoshift"));
    let far = passive(&mut w, "2TNK", 0, 22, 20);
    run(&mut w, 1);
    power(&mut w, 0, "ChronoshiftPower@advancedchronoshift", (40, 30), Some((20, 20)));
    run(&mut w, 1);
    assert_eq!(w.cell_of(w.actors[far].x, w.actors[far].y), (42, 30), "5x5 diamond reaches 2 cells out");
}

#[test]
fn iron_curtain_blocks_damage_for_its_duration() {
    let mut w = flat_world(["soviet", "allies"]);
    let key = "GrantExternalConditionPower@IRONCURTAIN";
    superweapon(&mut w, 0, "IRON", 8, 50, key);
    let tank = passive(&mut w, "3TNK", 0, 30, 30);
    let truck = passive(&mut w, "DTRK", 0, 40, 40);
    run(&mut w, 1);
    power(&mut w, 0, key, (30, 30), None);
    run(&mut w, 1);
    let hp = w.actors[tank].hp;
    w.damage(tank, 10_000);
    assert_eq!(w.actors[tank].hp, hp, "invulnerable");
    run(&mut w, 400);
    w.damage(tank, 10_000);
    assert_eq!(w.actors[tank].hp, hp - 10_000, "worn off after Duration 400");
    // A demolition truck under the Iron Curtain blows up (KillsSelf).
    w.powers.players[0].iter_mut().find(|p| p.key == key).unwrap().remaining = 0;
    power(&mut w, 0, key, (40, 40), None);
    run(&mut w, 1);
    assert!(!w.actors[truck].alive);
}

#[test]
fn atom_bomb_lands_after_its_flight_time() {
    let mut w = flat_world(["soviet", "allies"]);
    superweapon(&mut w, 0, "MSLO", 8, 50, "NukePower");
    let target = w.spawn_building(ty(&w, "POWR"), 1, 40, 20).unwrap();
    let tank = passive(&mut w, "2TNK", 1, 44, 21);
    let tr = w.make_ref(tank);
    let hp = w.actors[target].hp;
    power(&mut w, 0, "NukePower", (41, 21), None);
    run(&mut w, 1);
    assert_eq!(w.abil.nukes.len(), 1);
    // MissileDelay 5 + FlightDelay 400.
    run(&mut w, 5 + 400 - 2);
    assert_eq!(w.actors[target].hp, hp, "still in the air");
    assert!(w.players[0].visible[w.map.idx(41, 21)] != 0, "camera over the target before impact");
    run(&mut w, 30);
    assert!(w.abil.nukes.is_empty());
    assert!(!w.actors[target].alive || w.actors[target].hp < hp / 2, "{} of {hp}", w.actors[target].hp);
    assert!(w.resolve(tr).is_none(), "the tank 3 cells away is gone");
}

#[test]
fn gps_satellite_launches_itself_once_and_reveals_the_map() {
    let mut w = World::new(9, 64, &[("allies", false), ("soviet", false)]);
    superweapon(&mut w, 0, "ATEK", 8, 50, "GpsPower");
    run(&mut w, 2);
    assert!(w.power_instances(0).iter().all(|p| p.key != "GpsPower"), "OneShot: gone after launch");
    assert!(w.players[0].explored.contains(&0));
    run(&mut w, 375);
    assert!(w.has_gps(0) && !w.has_gps(1));
    assert!(w.players[0].explored.iter().all(|&e| e == 1), "RevealDelay 375, then the whole map");
    run(&mut w, 13000);
    assert!(w.power_instances(0).iter().all(|p| p.key != "GpsPower"), "never charges again");
}

#[test]
fn superweapons_need_their_structure_and_validate() {
    let mut w = flat_world(["soviet", "allies"]);
    superweapon(&mut w, 0, "IRON", 8, 50, "GrantExternalConditionPower@IRONCURTAIN");
    let tank = passive(&mut w, "3TNK", 1, 30, 30);
    run(&mut w, 1);
    // Player 1 does not own the power.
    power(&mut w, 1, "GrantExternalConditionPower@IRONCURTAIN", (30, 30), None);
    run(&mut w, 1);
    assert_eq!(w.actors[tank].invulnerable_until, 0);
    // A chronoshift without a source area does nothing (and keeps the charge).
    let mut w = flat_world(["allies", "soviet"]);
    superweapon(&mut w, 0, "PDOX", 8, 50, "ChronoshiftPower@chronoshift");
    power(&mut w, 0, "ChronoshiftPower@chronoshift", (30, 30), None);
    run(&mut w, 1);
    assert!(w.power_instances(0).iter().find(|p| p.key == "ChronoshiftPower@chronoshift").unwrap().ready());
}

#[test]
fn unpowered_tesla_coil_stops_detecting_cloaked_units() {
    let mut w = flat_world(["france", "russia"]);
    let plant = w.spawn_building(ty(&w, "APWR"), 1, 40, 20).unwrap();
    w.spawn_building(ty(&w, "TSLA"), 1, 30, 30);
    w.refresh_tokens();
    let stnk = passive(&mut w, "STNK", 0, 33, 30);
    run(&mut w, 200);
    assert!(w.actors[stnk].ab.cloaked, "the phase transport cloaked");
    assert!(!w.is_cloaked_from(stnk, 1), "a powered Tesla Coil detects it 3 cells away");
    w.remove(plant);
    run(&mut w, 30);
    assert!(w.players[1].low_power());
    assert!(w.is_cloaked_from(stnk, 1), "without power the coil detects nothing");
}

#[test]
fn loading_uncloaks_the_phase_transport() {
    let mut w = flat_world(["france", "russia"]);
    let stnk = passive(&mut w, "STNK", 0, 30, 30);
    run(&mut w, 200);
    assert!(w.actors[stnk].ab.cloaked);
    let e1 = passive(&mut w, "E1", 0, 30, 31);
    assert!(w.load_passenger(stnk, e1));
    assert!(!w.actors[stnk].ab.cloaked, "loading reveals it (UncloakOn: Load)");
}

#[test]
fn visible_mines_block_placement_and_hidden_enemy_mines_do_not() {
    let mut w = flat_world(["allies", "soviet"]);
    let (sx, sy) = w.players[0].start;
    w.spawn_building(ty(&w, "POWR"), 0, sx + 4, sy);
    w.refresh_tokens();
    let own_layer = passive(&mut w, "MNLY", 0, sx + 9, sy);
    let enemy_layer = passive(&mut w, "MNLY", 1, sx + 9, sy + 2);
    let (own_cell, enemy_cell) = (w.map.idx(sx + 4, sy - 2), w.map.idx(sx + 6, sy - 2));
    assert!(w.lay_mine(own_layer, own_cell));
    assert!(w.lay_mine(enemy_layer, enemy_cell));
    // Minelayers detect mines nearby: take both away so only the mines remain.
    w.remove(enemy_layer);
    w.remove(own_layer);
    run(&mut w, 150);
    let gun = ty(&w, "PBOX");
    let cells = |w: &World, x: i32, y: i32| w.placement_cells(0, gun, x, y).iter().all(|c| c.2);
    assert!(cells(&w, sx + 5, sy - 2), "the spot next to it is buildable (control)");
    assert!(!cells(&w, sx + 4, sy - 2), "own mine blocks the cell");
    assert!(w.is_cloaked_from(w.mine_at(enemy_cell).unwrap(), 0), "the enemy mine is hidden from player 0");
    assert!(cells(&w, sx + 6, sy - 2), "a hidden enemy mine does not give itself away");
    // Placing on it crushes the mine.
    w.players[0].cash = 10_000;
    w.spawn_building(ty(&w, "TENT"), 0, sx - 4, sy + 5);
    w.refresh_tokens();
    w.queue_order(Order::StartProduction { player: 0, ty: gun, count: 1 });
    run(&mut w, 600);
    w.queue_order(Order::Place { player: 0, ty: gun, cx: sx + 6, cy: sy - 2 });
    run(&mut w, 2);
    assert!(w.building_at[enemy_cell] != crate::world::NONE, "pillbox placed");
    assert!(w.mine_at(enemy_cell).is_none(), "the hidden mine was crushed");
}

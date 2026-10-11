//! The neutral world of OpenRA maps (neutral.rs, bridges.rs): trees, civilians,
//! civilian and tech buildings, barrels, bridges, ore mines, terrain speeds and
//! wall crushing.

use crate::bridges::BridgeLook;
use crate::map::{Map, Terrain};
use crate::mapdata::{MapActor, MapData};
use crate::math::CELL;
use crate::neutral::DamageState;
use crate::rules::{Kind, TARGET_STRUCTURE, TARGET_WATER};
use crate::world::{cell_center, Activity, GameOptions, Order, PlayerSetup, StartingUnits, World, NONE};

fn ty(w: &World, id: &str) -> u16 {
    w.rules.actor_index(id).unwrap_or_else(|| panic!("no actor {id}")) as u16
}

fn weapon(w: &World, name: &str) -> usize {
    w.rules.weapons.iter().position(|x| x.name == name).unwrap_or_else(|| panic!("no weapon {name}"))
}

fn run(w: &mut World, ticks: u32) {
    for _ in 0..ticks {
        w.step();
    }
}

fn actor(t: &str, x: i32, y: i32) -> MapActor {
    MapActor::new(t, -1, x, y, 0)
}

/// Write terrain letter rows (bridge templates) with their top-left at (x, y).
fn stamp(m: &mut Map, rows: &[String], x: i32, y: i32) {
    for (dy, row) in rows.iter().enumerate() {
        for (dx, c) in row.chars().enumerate() {
            if let Some(t) = Terrain::from_letter(c) {
                let i = m.idx(x + dx as i32, y + dy as i32);
                m.terrain[i] = t;
            }
        }
    }
}

/// A 64x64 clear map (with `edit` applied), two players without AI that start
/// with a Construction Yard at the corners, explored, and the map's neutral actors.
fn world_with(edit: impl FnOnce(&mut Map), actors: Vec<MapActor>, options: GameOptions) -> World {
    let mut m = Map::filled(64, 64, Terrain::Clear);
    m.spawns = vec![(2, 2), (58, 58)];
    edit(&mut m);
    let mut d = MapData::from_map(&m, "Neutral", "Test", "");
    d.actors = actors;
    let v = d.validate();
    assert!(v.ok, "{:?}", v.errors);
    let players = [PlayerSetup::new("england", None), PlayerSetup::new("russia", None)];
    let mut w = World::from_map(&d, 3, &players, options).expect("world");
    for p in w.players.iter_mut() {
        p.explored.iter_mut().for_each(|e| *e = 1);
    }
    w
}

fn opts() -> GameOptions {
    GameOptions { ore_regrowth: false, starting_units: StartingUnits::Base, fog: false, ..GameOptions::default() }
}

fn world(actors: Vec<MapActor>) -> World {
    world_with(|_| {}, actors, opts())
}

fn find(w: &World, id: &str) -> Vec<usize> {
    let t = ty(w, id);
    (0..w.actors.len()).filter(|&i| w.actors[i].alive && w.actors[i].ty == t).collect()
}

fn unit(w: &mut World, id: &str, owner: u8, cx: i32, cy: i32) -> usize {
    let t = ty(w, id);
    w.spawn_unit(t, owner, cell_center(cx), cell_center(cy), 512)
}

// ---- Trees -----------------------------------------------------------------------------

#[test]
fn tree_terrain_becomes_neutral_tree_actors() {
    let w = world_with(
        |m| {
            for x in 20..25 {
                let i = m.idx(x, 30);
                m.terrain[i] = Terrain::Tree;
            }
        },
        vec![],
        opts(),
    );
    let n = w.neutral_player().expect("a neutral player owns the trees");
    assert!(w.players[n as usize].neutral);
    for x in 20..25 {
        let ci = w.map.idx(x, 30);
        assert_eq!(w.map.terrain[ci], Terrain::Clear, "the tree stands on clear ground");
        let b = w.building_at[ci];
        assert_ne!(b, NONE, "a tree occupies the cell");
        let info = &w.rules.actors[w.actors[b as usize].ty as usize];
        assert_eq!(info.world.category.as_deref(), Some("Tree"));
        assert_eq!(w.actors[b as usize].owner, n);
        assert!(w.pass.blocked[ci], "trees block movement");
        assert_eq!(w.target_class(b as usize), crate::rules::TARGET_TREES, "trees are only hit by warheads that list Trees");
        assert!(w.never_auto_targeted(b as usize) || !w.are_enemies(0, n));
    }
    // Every player is still playing: trees keep nobody in the game.
    assert_eq!(w.players.iter().filter(|p| !p.neutral).count(), 2);
}

#[test]
fn only_fire_burns_trees_down_to_stumps_that_still_block() {
    let mut w = world(vec![actor("T01", 30, 29)]);
    let ci = w.map.idx(30, 30);
    let tree = w.building_at[ci] as usize;
    assert_eq!(w.actors[tree].ty, ty(&w, "T01"));
    let hp = w.actors[tree].hp;
    assert_eq!(hp, 50000, "500 HP (OpenRA ^Tree)");
    let (x, y) = (cell_center(30), cell_center(30));
    // Rifle fire does nothing to a tree.
    let rifle = weapon(&w, "M1Carbine");
    for _ in 0..20 {
        w.impact(rifle, x, y, 0);
    }
    run(&mut w, 2);
    assert_eq!(w.actors[tree].hp, hp, "bullets do not hurt trees");
    // Flame (Trees in ValidTargets, Tree column of Versus: 50 percent) does.
    let fire = weapon(&w, "FireballLauncher");
    w.impact(fire, x, y, 0);
    run(&mut w, 1);
    assert_eq!(w.actors[tree].hp, hp - 15000 * 50 / 100);
    assert!(w.actors[tree].world.burning, "it burns (Incendiary)");
    let t01 = ty(&w, "T01");
    for _ in 0..20 {
        if !(w.actors[tree].alive && w.actors[tree].ty == t01) {
            break;
        }
        w.impact(fire, x, y, 0);
        run(&mut w, 1);
    }
    run(&mut w, 2);
    let stump = w.building_at[ci];
    assert_ne!(stump, NONE, "a stump stays (SpawnActorOnDeath T01.Husk)");
    assert_eq!(w.actors[stump as usize].ty, ty(&w, "T01.Husk"));
    assert!(w.pass.blocked[ci], "the stump still blocks");
    assert_eq!(w.target_class(stump as usize), 0, "stumps cannot be hit");
    let before = w.actors[stump as usize].hp;
    w.impact(fire, x, y, 0);
    run(&mut w, 1);
    assert_eq!(w.actors[stump as usize].hp, before, "and have no health");
}

// ---- Barrels ---------------------------------------------------------------------------

#[test]
fn burning_trees_show_their_fire_by_damage_state_with_start_loop_and_end() {
    let mut w = world(vec![actor("T01", 30, 29)]);
    let tree = w.building_at[w.map.idx(30, 30)] as usize;
    let max = w.actors[tree].hp;
    // The original art in use: burn-s, burn-m and burn-l at 40 ms a frame.
    let slot = |size: f32| (crate::render::SpriteIds::new(w.rules.actors.len()).decorations_base + size) as u32;
    let slots = [
        slot(crate::neutral::DECORATION_FLAME),
        slot(crate::neutral::DECORATION_FLAME_MEDIUM),
        slot(crate::neutral::DECORATION_FLAME_LARGE),
    ];
    let info: Vec<i32> = (0..3).flat_map(|s| [3, s, 40, 4, 4, s, 10, 3]).collect();
    w.render_opts.set_original_art(&slots, &info);
    assert_eq!(w.render_opts.fire_frames[0], Some((40, 4, 10, 3)));
    // Fire damage to Light: the small fire starts.
    let incendiary = w.rules.damage_type_bit(crate::neutral::INCENDIARY);
    w.damage_from(tree, max / 5, NONE, incendiary);
    assert!(w.actors[tree].world.burning);
    run(&mut w, 1);
    assert_eq!(w.fire_frame(tree, 0), Some(0), "the start plays");
    run(&mut w, 6);
    assert_eq!(w.fire_frame(tree, 0), Some(4 + 2), "then the loop");
    assert_eq!(w.fire_frame(tree, 1), None);
    // Down to Medium: the small fire ends, the medium one starts.
    w.damage(tree, max / 5 + 1);
    run(&mut w, 1);
    assert_eq!(w.fire_frame(tree, 0), Some(4 + 10), "the small fire's end");
    assert_eq!(w.fire_frame(tree, 1), Some(0));
    run(&mut w, 5);
    assert_eq!(w.fire_frame(tree, 0), None, "the end played once");
    // With WebRA's art: the flame of the burning size only.
    w.render_opts.set_original_art(&[], &[]);
    assert_eq!(w.fire_frame(tree, 1), Some(u32::MAX));
    assert_eq!(w.fire_frame(tree, 0), None);
}

#[test]
fn tech_buildings_leave_their_death_animation() {
    let mut w = world(vec![actor("HOSP", 30, 30)]);
    let hosp = find(&w, "HOSP")[0];
    let ty = w.actors[hosp].ty;
    w.kill(hosp);
    assert!(w.inf.corpses.iter().any(|c| c.ty == ty && c.sequence == 1), "WithDeathAnimation dead (die1)");
}

#[test]
fn barrels_explode_in_a_chain_and_hurt_what_is_near() {
    let mut w = world(vec![actor("BARL", 20, 20), actor("BARL", 21, 20), actor("BRL3", 22, 20), actor("BARL", 30, 20)]);
    let barrels: Vec<usize> = (20..23).map(|x| w.building_at[w.map.idx(x, 20)] as usize).collect();
    let far = w.building_at[w.map.idx(30, 20)] as usize;
    let tank = unit(&mut w, "2TNK", 1, 23, 21);
    let hp = w.actors[tank].hp;
    // Barrels are never picked by auto-target (NoAutoTarget).
    assert!(w.never_auto_targeted(barrels[0]));
    w.kill(barrels[0]);
    run(&mut w, 30);
    assert!(barrels.iter().all(|&b| !w.actors[b].alive), "the explosion set the row of barrels off");
    assert!(w.actors[far].alive, "a barrel out of reach stays");
    assert!(!w.actors[tank].alive || w.actors[tank].hp < hp, "the tank next to the barrels got hurt");
}

// ---- Civilians -------------------------------------------------------------------------

#[test]
fn civilians_wander_and_panic_when_hit() {
    let mut w = world(vec![actor("C2", 30, 30)]);
    let civ = find(&w, "C2")[0];
    assert_eq!(w.actors[civ].owner, w.neutral_player().unwrap());
    let start = (w.actors[civ].x, w.actors[civ].y);
    let mut moved = false;
    for _ in 0..1000 {
        w.step();
        moved |= (w.actors[civ].x, w.actors[civ].y) != start;
    }
    assert!(moved, "idle civilians wander (Wanders)");
    assert!(!w.draws_panic(civ));
    // A hit makes it panic: it runs (twice as fast) until the panic is over,
    // drawn with its panic sequences (the second sprite slot).
    w.damage(civ, 100);
    assert!(w.is_panicking(civ));
    assert!(w.draws_panic(civ), "panic-stand / panic-run");
    assert_eq!(w.world_speed_modifier(civ), 200);
    run(&mut w, 30);
    assert!(w.actors[civ].activity == Activity::Move || w.is_panicking(civ));
    run(&mut w, 250);
    assert!(!w.is_panicking(civ), "PanicDuration 250 ticks");
    assert!(!w.draws_panic(civ));
    assert_eq!(w.world_speed_modifier(civ), 100);
}

#[test]
fn tanks_run_over_civilians_and_neutrals_are_never_attacked_unprompted() {
    let mut w = world(vec![actor("C1", 30, 30)]);
    let civ = find(&w, "C1")[0];
    // An armed civilian (C1 carries a pistol) near an enemy tank: nobody fires.
    let tank = unit(&mut w, "3TNK", 0, 32, 30);
    run(&mut w, 100);
    assert!(w.actors[civ].alive, "neutral actors are no one's enemy");
    assert_eq!(w.actors[tank].hp, w.rules.actors[w.actors[tank].ty as usize].hp);
    // Driven over: crushed (OpenRA Crushable: not by allies, and neutrals are no allies).
    w.actors[civ].world.wander_countdown = 1_000_000;
    let ids = vec![w.make_ref(tank)];
    w.queue_order(Order::Move { player: 0, ids, x: cell_center(10), y: cell_center(30), attack_move: false });
    let mut crushed = false;
    for _ in 0..300 {
        w.step();
        // Keep the civilian just ahead of the driving tank.
        if w.actors[tank].moved && w.actors[civ].alive {
            w.actors[civ].x = w.actors[tank].x - 200;
            w.actors[civ].y = w.actors[tank].y;
        }
        if !w.actors[civ].alive {
            crushed = true;
            break;
        }
    }
    assert!(crushed, "the tank crushed the civilian");
}

// ---- Tech buildings and capture --------------------------------------------------------------

#[test]
fn a_captured_hospital_heals_the_new_owners_infantry() {
    let mut w = world(vec![actor("HOSP", 30, 30)]);
    let hosp = find(&w, "HOSP")[0];
    let soldier = unit(&mut w, "E1", 0, 10, 40);
    let max = w.actors[soldier].hp;
    w.actors[soldier].hp = max - 2000;
    run(&mut w, 300);
    assert_eq!(w.actors[soldier].hp, max - 2000, "no hospital, no healing");
    assert!(!w.hospital_healing(soldier));
    // Captured (the capture side calls on_captured, or after_capture when it changes the owner itself).
    let hosp_ty = w.actors[hosp].ty;
    w.on_captured(hosp, 0);
    assert_eq!(w.actors[hosp].owner, 0);
    assert_eq!(w.actors[hosp].ty, hosp_ty);
    run(&mut w, 1);
    assert!(w.hospital_healing(soldier));
    // ChangesHealth@HOSPITAL: 500 every 100 ticks.
    run(&mut w, 105);
    assert!(w.actors[soldier].hp >= max - 1500, "one heal step: {}", w.actors[soldier].hp);
    run(&mut w, 400);
    assert_eq!(w.actors[soldier].hp, max, "healed fully");
    assert!(!w.hospital_healing(soldier));
    // Damage pauses it (DamageCooldown 125).
    w.damage(soldier, 1000);
    let hp = w.actors[soldier].hp;
    run(&mut w, 120);
    assert_eq!(w.actors[soldier].hp, hp, "no heal during the damage cooldown");
    run(&mut w, 120);
    assert!(w.actors[soldier].hp > hp);
}

#[test]
fn oil_derricks_pay_their_owner_and_go_back_to_neutral_when_the_owner_loses() {
    let mut w = world(vec![actor("OILB", 30, 30)]);
    w.sound.set_enabled(true);
    let oil = find(&w, "OILB")[0];
    let n = w.neutral_player().unwrap();
    run(&mut w, 800);
    assert_eq!(w.players[n as usize].cash, 0, "a neutral derrick pays nobody (combatant owners only)");
    let cash = w.players[1].cash;
    w.on_captured(oil, 1);
    assert_eq!(w.players[1].cash, cash + 100, "GivesCashOnCapture 100");
    // Shown as a cash tick in the new owner's colour (FloatingText "+$100").
    let ticks = |ev: Vec<i32>| {
        ev.chunks(6).filter(|e| e[0] == crate::sound_events::SoundEventKind::CashTick as i32).map(|e| (e[4], e[1])).collect::<Vec<_>>()
    };
    assert_eq!(ticks(w.sound.take()), vec![(1, 100)]);
    run(&mut w, 30);
    // CashTrickler: 100 every Interval (375) ticks, paid when the countdown
    // drops below zero (so every 376 ticks).
    let mut shown = Vec::new();
    for _ in 0..346 {
        w.step();
        shown.extend(ticks(w.sound.take()));
    }
    assert_eq!(w.players[1].cash, cash + 200);
    assert_eq!(shown, vec![(1, 100)], "every payment shows");
    run(&mut w, 375);
    assert_eq!(w.players[1].cash, cash + 200);
    run(&mut w, 1);
    assert_eq!(w.players[1].cash, cash + 300);
    // A captured tech building alone does not keep a player in the game
    // (no MustBeDestroyed), and goes back to neutral when it loses (OwnerLostAction ChangeOwner).
    for i in 0..w.actors.len() {
        if w.actors[i].alive && w.actors[i].owner == 1 && i != oil {
            w.kill(i);
        }
    }
    run(&mut w, 30);
    assert!(w.players[1].defeated, "the derrick does not keep its owner in the game");
    assert_eq!(w.actors[oil].owner, n, "back to neutral");
    let neutral_cash = w.players[n as usize].cash;
    run(&mut w, 800);
    assert_eq!(w.players[n as usize].cash, neutral_cash);
}

#[test]
fn a_capture_that_changes_the_owner_itself_gets_the_effects_from_after_capture() {
    // How a capture that sets the owner on its own (an engineer's) hands over
    // a derrick: owner first, then `after_capture` with the previous owner.
    let mut w = world(vec![actor("OILB", 30, 30)]);
    let oil = find(&w, "OILB")[0];
    let old = w.actors[oil].owner;
    let cash = w.players[0].cash;
    w.actors[oil].owner = 0;
    w.after_capture(oil, old);
    assert_eq!(w.players[0].cash, cash + 100, "GivesCashOnCapture 100");
    // Called again with the owner unchanged, it does nothing.
    w.after_capture(oil, 0);
    assert_eq!(w.players[0].cash, cash + 100);
    run(&mut w, 376);
    assert_eq!(w.players[0].cash, cash + 200, "the derrick pays its new owner");
}

#[test]
fn tech_buildings_provide_their_prerequisites_and_command_posts_build_area() {
    let mut w = world(vec![actor("BIO", 20, 20), actor("FCOM", 40, 30), actor("MISS", 30, 40)]);
    let bio = find(&w, "BIO")[0];
    let fcom = find(&w, "FCOM")[0];
    let bio_token = w.rules.token("bio").expect("bio prerequisite");
    assert!(!w.players[0].tokens[bio_token as usize]);
    w.on_captured(bio, 0);
    run(&mut w, 1);
    assert!(w.players[0].tokens[bio_token as usize], "the Bio Lab gives its owner `bio`");
    // The Forward Command Post: build radius and buildable area around it.
    let powr = ty(&w, "POWR");
    assert!(!w.can_place(0, powr, 42, 34), "nothing to build next to yet");
    w.on_captured(fcom, 0);
    run(&mut w, 1);
    assert!(w.can_place(0, powr, 42, 34), "the command post lets its owner build around it");
    // The Tech Center (Communications Center) sees far.
    assert_eq!(w.rules.actors[ty(&w, "MISS") as usize].sight, 10 * CELL);
}

#[test]
fn tech_buildings_say_what_capturing_gives_and_spef_is_map_only() {
    let w = world(vec![]);
    // TooltipDescription@ally / @other: the owner reads what it has, everyone else how to get it.
    for id in ["HOSP", "BIO", "FCOM", "MISS", "OILB"] {
        let t = &w.rules.actors[ty(&w, id) as usize].world;
        assert!(!t.ally_description.is_empty(), "{id} tells its owner what it gives");
        assert!(t.other_description.starts_with("Capture"), "{id}: {}", t.other_description);
        assert!(w.rules.actors[ty(&w, id) as usize].abilities.capturable.is_some(), "{id} is capturable");
    }
    // France's fake Sub Pen: placed by maps only (OpenRA Prerequisites ~disabled), on water.
    let spef = &w.rules.actors[ty(&w, "SPEF") as usize];
    assert_eq!(spef.kind, Kind::Building);
    assert!(spef.building.as_ref().is_some_and(|b| b.cells().count() == 9), "a 3x3 Sub Pen look-alike");
    let spef_ty = ty(&w, "SPEF") as usize;
    assert!(w.rules.obtainable.iter().all(|f| !f[spef_ty]), "no faction ever builds SPEF");
}

// ---- Engineers (infantry.rs) on the neutral world --------------------------------------

/// An engineer of `player` sent at `target` with a right click (the Smart order).
fn send_engineer(w: &mut World, player: u8, target: usize, at: (i32, i32)) -> usize {
    let e6 = unit(w, "E6", player, at.0, at.1);
    w.rebuild_hash();
    w.update_vision();
    let (x, y) = (w.actors[target].x, w.actors[target].y);
    assert_eq!(w.smart_action(player, &[e6], x, y), crate::world::SmartAction::Capture);
    let ids = vec![w.make_ref(e6)];
    w.queue_order(Order::Smart { player, ids, x, y });
    e6
}

#[test]
fn an_engineer_captures_an_oil_derrick_and_a_hospital_with_their_openra_effects() {
    let mut w = world(vec![actor("OILB", 30, 30), actor("HOSP", 40, 30)]);
    w.sound.set_enabled(true);
    let oil = find(&w, "OILB")[0];
    let hosp = find(&w, "HOSP")[0];
    let cash = w.players[0].cash;
    let e6 = send_engineer(&mut w, 0, oil, (31, 36));
    for _ in 0..600 {
        w.step();
        if w.actors[oil].owner == 0 {
            break;
        }
    }
    assert_eq!(w.actors[oil].owner, 0, "captured by the engineer");
    assert!(!w.actors[e6].alive, "the engineer went in");
    // GivesCashOnCapture with its cash tick, and the CaptureNotification (eva).
    assert_eq!(w.players[0].cash, cash + 100);
    let cash_tick = crate::sound_events::SoundEventKind::CashTick as i32;
    assert!(w.sound.take().chunks(6).any(|e| e[0] == cash_tick && e[1] == 100 && e[4] == 0), "a cash tick");
    // CashTrickler pays the new owner.
    run(&mut w, 380);
    assert!(w.players[0].cash >= cash + 200, "the derrick pays: {}", w.players[0].cash - cash);
    // The hospital heals the capturing player's infantry.
    let soldier = unit(&mut w, "E1", 0, 10, 45);
    let max = w.actors[soldier].hp;
    w.actors[soldier].hp = max / 2;
    send_engineer(&mut w, 0, hosp, (41, 36));
    for _ in 0..600 {
        w.step();
        if w.actors[hosp].owner == 0 {
            break;
        }
    }
    assert_eq!(w.actors[hosp].owner, 0);
    run(&mut w, 2);
    assert!(w.hospital_healing(soldier), "ChangesHealth@HOSPITAL for the new owner's infantry");
}

#[test]
fn ai_engineers_take_tech_buildings_like_openras_capture_module() {
    // CaptureManagerBotModule: idle capturers go for the visible capturable
    // structures of enemy or neutral players, the most valuable first
    // (GetSellValue: tech buildings have none), each to the nearest one.
    let mut w = world(vec![actor("OILB", 30, 30), actor("V01", 40, 30)]);
    let oil = find(&w, "OILB")[0];
    let e6 = unit(&mut w, "E6", 1, 31, 37);
    w.update_vision();
    crate::ai_infantry::command_capturers(&mut w, 1);
    run(&mut w, 1);
    if w.actors[e6].inf.enter.is_none() {
        // The module waits for its first delay; once more after it.
        run(&mut w, 400);
        crate::ai_infantry::command_capturers(&mut w, 1);
    }
    for _ in 0..600 {
        w.step();
        if w.actors[oil].owner == 1 {
            break;
        }
    }
    assert_eq!(w.actors[oil].owner, 1, "the AI's engineer took the derrick");
    // Civilian buildings are not capturable (no Capturable trait).
    let v01 = find(&w, "V01")[0];
    assert!(w.rules.actors[w.actors[v01].ty as usize].abilities.capturable.is_none());
}

#[test]
fn captures_are_announced_to_both_sides() {
    let mut w = world(vec![actor("OILB", 30, 30)]);
    w.sound.set_enabled(true);
    let oil = find(&w, "OILB")[0];
    send_engineer(&mut w, 1, oil, (31, 36));
    let mut heard = false;
    for _ in 0..600 {
        w.step();
        let ev = w.sound.take();
        heard |= ev.chunks(6).any(|e| e[0] == crate::sound_events::SoundEventKind::Captured as i32 && e[4] == 1);
        if w.actors[oil].owner == 1 {
            break;
        }
    }
    assert_eq!(w.actors[oil].owner, 1);
    assert!(heard, "Captured (33) for the new owner");
}

// ---- Bridges ---------------------------------------------------------------------------

/// A river across the map (rows 20 and 21) with a BRIDGE1 template stamped
/// at (29, 20): its deck runs from the north bank to the south bank.
fn bridge_world() -> World {
    let rules = crate::rules::Rules::load();
    let t = rules.actors[rules.actor_index("BRIDGE1").unwrap()].world.bridge.as_ref().unwrap().templates["temperate"].clone();
    world_with(
        |m| {
            for y in 20..22 {
                for x in 0..64 {
                    let i = m.idx(x, y);
                    m.terrain[i] = Terrain::River;
                }
            }
            stamp(m, &t.healthy, 29, 20);
        },
        vec![actor("BRIDGE1", 29, 20)],
        opts(),
    )
}

fn deck_cells(w: &World, b: usize) -> Vec<usize> {
    w.neutral.bridges.bridges[b].cells.iter().filter(|c| w.map.terrain[c.2] == Terrain::Bridge).map(|c| c.2).collect()
}

#[test]
fn bridges_fall_kill_what_is_on_them_and_engineers_repair_them_at_a_hut() {
    let mut w = bridge_world();
    let br = find(&w, "BRIDGE1")[0];
    let b = w.bridge_of(br).expect("a bridge span");
    assert_eq!(w.bridge_look(br), Some(BridgeLook::Healthy));
    let deck = deck_cells(&w, b);
    assert!(!deck.is_empty() && deck.iter().all(|&c| !w.pass.blocked[c]), "units cross the deck");
    assert_eq!(w.target_class(br), TARGET_STRUCTURE | TARGET_WATER);
    assert!(w.never_auto_targeted(br), "bridges need force fire");
    let huts = find(&w, "BRIDGEHUT");
    assert_eq!(huts.len(), 2, "a hut at each end");
    // Ground units cross the river only over the bridge.
    let west = w.map.idx(20, 10);
    let east = w.map.idx(20, 40);
    assert_eq!(w.pass.component[west], w.pass.component[east]);
    // Damaged: below half health, the damaged template (rough deck).
    let max = w.actors[br].hp;
    w.damage(br, max * 6 / 10);
    assert_eq!(w.bridge_look(br), Some(BridgeLook::Damaged));
    assert!(deck.iter().all(|&c| w.map.terrain[c] == Terrain::Rough && !w.pass.blocked[c]), "still crossable");
    // A tank on the deck dies when the bridge goes down.
    let (dx, dy) = (deck[0] as i32 % w.map.width, deck[0] as i32 / w.map.width);
    let tank = unit(&mut w, "2TNK", 1, dx, dy);
    w.damage(br, max);
    assert!(w.actors[br].alive, "a destroyed bridge stays (Health.RemoveOnDeath false)");
    assert_eq!(w.actors[br].hp, 0);
    assert_eq!(w.bridge_look(br), Some(BridgeLook::Destroyed));
    assert!(!w.actors[tank].alive, "the tank on it fell");
    assert!(deck.iter().all(|&c| w.pass.blocked[c]), "no way across any more");
    w.pass.refresh(&w.map);
    assert_ne!(w.pass.component[west], w.pass.component[east]);
    assert_eq!(w.target_class(br), 0, "nothing to shoot at");
    // Repair at a hut (RepairsBridges): healthy again at once.
    let hut = huts[0];
    assert_eq!(w.bridge_hut_damage_state(hut), Some(DamageState::Dead));
    assert!(w.can_repair_bridge_at_hut(hut));
    let (hx, hy) = (w.actors[hut].x, w.actors[hut].y);
    assert_eq!(w.bridge_hut_at(hx, hy), Some(hut));
    assert!(w.repair_bridge_at_hut(hut, 0));
    assert_eq!(w.bridge_look(br), Some(BridgeLook::Healthy));
    assert_eq!(w.actors[br].hp, max);
    assert!(!w.can_repair_bridge_at_hut(hut), "nothing left to repair");
    w.pass.refresh(&w.map);
    assert_eq!(w.pass.component[west], w.pass.component[east]);
    // Demolition at a hut (C4) brings it down again.
    assert!(w.can_demolish_bridge_at_hut(huts[1]));
    assert!(w.demolish_bridge_at_hut(huts[1], 1));
    assert_eq!(w.bridge_look(br), Some(BridgeLook::Destroyed));
    assert!(!w.can_demolish_bridge_at_hut(huts[1]));
}

#[test]
fn an_engineer_repairs_a_fallen_bridge_through_its_hut() {
    let mut w = bridge_world();
    let br = find(&w, "BRIDGE1")[0];
    let huts = find(&w, "BRIDGEHUT");
    let max = w.actors[br].hp;
    let e6 = unit(&mut w, "E6", 0, 26, 17);
    // Intact: nothing to repair, so the engineer is not sent in.
    assert!(!w.can_repair_bridge(e6, huts[0]));
    w.damage(br, max);
    assert_eq!(w.bridge_look(br), Some(BridgeLook::Destroyed));
    let hut = huts.iter().copied().find(|&h| w.can_repair_bridge(e6, h)).expect("a hut on the engineer's side");
    w.rebuild_hash();
    w.update_vision();
    let (x, y) = (w.actors[hut].x, w.actors[hut].y);
    assert_eq!(w.smart_action(0, &[e6], x, y), crate::world::SmartAction::InstantRepair, "the repair cursor on the hut");
    let ids = vec![w.make_ref(e6)];
    w.queue_order(Order::Smart { player: 0, ids, x, y });
    for _ in 0..600 {
        w.step();
        if w.bridge_look(br) == Some(BridgeLook::Healthy) {
            break;
        }
    }
    assert_eq!(w.bridge_look(br), Some(BridgeLook::Healthy), "repaired by the engineer");
    assert!(!w.actors[e6].alive, "the engineer went into the hut");
    assert!(!w.can_repair_bridge_at_hut(hut));
}

#[test]
fn units_route_over_the_bridge_and_around_when_it_is_gone() {
    let mut w = bridge_world();
    let br = find(&w, "BRIDGE1")[0];
    let jeep = unit(&mut w, "JEEP", 0, 22, 10);
    let ids = vec![w.make_ref(jeep)];
    w.queue_order(Order::Move { player: 0, ids: ids.clone(), x: cell_center(22), y: cell_center(40), attack_move: false });
    let mut crossed = false;
    for _ in 0..600 {
        w.step();
        if w.actors[jeep].y > cell_center(30) {
            crossed = true;
            break;
        }
    }
    assert!(crossed, "the jeep drove over the bridge");
    // With the bridge gone the river cannot be crossed: the order ends on this bank.
    w.damage(br, w.actors[br].hp);
    w.queue_order(Order::Move { player: 0, ids, x: cell_center(22), y: cell_center(10), attack_move: false });
    run(&mut w, 400);
    assert!(w.actors[jeep].y > cell_center(22), "it stays on the south bank");
}

/// BR1, two BR3 spans and BR2 (a long bridge, OpenRA's LegacyBridgeLayer
/// geometry: each span joins the next one diagonally).
fn long_bridge_world() -> World {
    let rules = crate::rules::Rules::load();
    let tpl = |id: &str| rules.actors[rules.actor_index(id).unwrap()].world.bridge.as_ref().unwrap().templates["temperate"].clone();
    let (br1, br3, br2) = (tpl("BR1"), tpl("BR3"), tpl("BR2"));
    world_with(
        |m| {
            for y in 5..25 {
                for x in 2..20 {
                    let i = m.idx(x + 4, y);
                    m.terrain[i] = Terrain::Water;
                }
            }
            stamp(m, &br1.healthy, 10, 10);
            stamp(m, &br3.healthy, 10, 12);
            stamp(m, &br3.healthy, 9, 13);
            stamp(m, &br2.healthy, 7, 14);
        },
        vec![actor("BR1", 10, 10), actor("BR3", 10, 12), actor("BR3", 9, 13), actor("BR2", 7, 14)],
        opts(),
    )
}

#[test]
fn long_bridges_link_their_spans_and_a_fallen_shore_piece_takes_its_neighbour_along() {
    let mut w = long_bridge_world();
    let br1 = find(&w, "BR1")[0];
    let spans = find(&w, "BR3");
    let br2 = find(&w, "BR2")[0];
    assert_eq!(spans.len(), 2);
    let (a, c) = (w.bridge_of(br1).unwrap(), w.bridge_of(br2).unwrap());
    let s0 = w.bridge_of(spans[0]).unwrap();
    let s1 = w.bridge_of(spans[1]).unwrap();
    let layer = &w.neutral.bridges;
    assert_eq!(layer.bridges[a].neighbours, [None, Some(s0)]);
    assert_eq!(layer.bridges[s0].neighbours, [Some(a), Some(s1)]);
    assert_eq!(layer.bridges[s1].neighbours, [Some(s0), Some(c)]);
    assert_eq!(layer.bridges[c].neighbours, [Some(s1), None]);
    let huts = find(&w, "BRIDGEHUT");
    assert_eq!(huts.len(), 2, "one hut at each shore piece");
    // The shore piece falls: the span next to it looks destroyed too (OpenRA
    // LongBridgeSegmentIsDead), the one after it stands.
    let max = w.actors[br1].hp;
    w.damage(br1, max);
    assert_eq!(w.bridge_look(br1), Some(BridgeLook::Destroyed));
    assert_eq!(w.bridge_look(spans[0]), Some(BridgeLook::DestroyedNorth));
    assert_eq!(w.bridge_look(spans[1]), Some(BridgeLook::Healthy));
    // Repaired from a hut: the repair spreads span by span to the other hut.
    let hut = huts.iter().copied().find(|&h| w.bridge_hut_damage_state(h) == Some(DamageState::Dead)).expect("a hut sees the dead span");
    let mut listed = w.bridge_huts();
    listed.sort_unstable();
    assert_eq!(listed, huts, "the huts the engineers' side can enter");
    assert!(!w.bridge_hut_repairing(hut));
    assert!(w.repair_bridge_at_hut(hut, 0));
    assert!(w.bridge_hut_repairing(hut), "the repair spreads over the spans");
    run(&mut w, 60);
    assert!(!w.bridge_hut_repairing(hut), "and is done");
    for i in [br1, spans[0], spans[1], br2] {
        assert_eq!(w.bridge_look(i), Some(BridgeLook::Healthy));
    }
    assert!(huts.iter().all(|&h| !w.can_repair_bridge_at_hut(h)));
    // Demolition spreads from one hut to the other, a span every 20 ticks.
    assert!(w.demolish_bridge_at_hut(huts[0], 1));
    run(&mut w, 100);
    for i in [br1, spans[0], spans[1], br2] {
        assert_eq!(w.actors[i].hp, 0, "span {i} fell");
    }
}

/// A fallen span of a long bridge leaves open water (BR3 destroyed_north):
/// boats sail into the gap, and the repaired span sinks the one under it
/// (OpenRA Bridge.Repair: Resurrect, KillUnitsOnBridge where the actor
/// cannot exist), while a Transport waiting next to it lives on.
#[test]
fn a_repaired_bridge_sinks_the_boat_under_it() {
    let mut w = long_bridge_world();
    let br1 = find(&w, "BR1")[0];
    let span = find(&w, "BR3")[0];
    w.damage(br1, w.actors[br1].hp);
    assert_eq!(w.bridge_look(span), Some(BridgeLook::DestroyedNorth));
    let b = w.bridge_of(span).unwrap();
    let gap: Vec<usize> = w.neutral.bridges.bridges[b].cells.iter().map(|c| c.2).filter(|&c| w.map.terrain[c] == Terrain::Water).collect();
    assert!(!gap.is_empty(), "open water where the span was");
    let (gx, gy) = (gap[0] as i32 % w.map.width, gap[0] as i32 / w.map.width);
    let pt = unit(&mut w, "PT", 1, gx, gy);
    assert!(!w.pass_water.blocked[gap[0]], "boats may enter the gap");
    let lst = unit(&mut w, "LST", 1, 20, 20);
    let hut = find(&w, "BRIDGEHUT").into_iter().find(|&h| w.can_repair_bridge_at_hut(h)).expect("a hut to repair from");
    assert!(w.repair_bridge_at_hut(hut, 0));
    run(&mut w, 60);
    assert_eq!(w.bridge_look(span), Some(BridgeLook::Healthy));
    assert!(!w.actors[pt].alive, "the gunboat under the span sank");
    assert!(w.actors[lst].alive, "the Transport out in the open water did not");
}

// ---- Ore mines --------------------------------------------------------------------------

#[test]
fn ore_mines_grow_ore_around_them_with_regrowth_on() {
    let ore = |w: &World| w.map.ore.iter().map(|&o| o as i32).sum::<i32>();
    let gems = |w: &World| w.map.gems.iter().map(|&o| o as i32).sum::<i32>();
    let mut on = world_with(|_| {}, vec![actor("MINE", 30, 30), actor("GMINE", 40, 20)], GameOptions { ore_regrowth: true, ..opts() });
    let mut off = world_with(|_| {}, vec![actor("MINE", 30, 30), actor("GMINE", 40, 20)], opts());
    assert_eq!((ore(&on), gems(&on)), (0, 0));
    run(&mut on, 75 * 20);
    run(&mut off, 75 * 20);
    assert!(ore(&on) >= 15, "SeedsResource: a bale every 75 ticks, {}", ore(&on));
    assert!(gems(&on) >= 5, "gem mines grow gems, {}", gems(&on));
    assert_eq!((ore(&off), gems(&off)), (0, 0), "without ore regrowth mines grow nothing");
    // The ore lies around the mine, not on it, and only on ground that holds ore.
    let mine = w_cell(&on, 30, 30);
    assert_eq!(on.map.ore[mine], 0);
    for i in 0..on.map.cells() {
        if on.map.ore[i] > 0 {
            let (x, y) = (i as i32 % 64, i as i32 / 64);
            assert!((x - 30).abs() <= 20 && (y - 30).abs() <= 20);
            assert!(on.map.terrain[i].holds_ore() && on.building_at[i] == NONE);
        }
    }
}

/// Footprint size of a structure type.
fn size_of(rules: &crate::rules::Rules, ty: &str) -> (i32, i32) {
    let b = rules.actors[rules.actor_index(ty).expect("known type")].building.as_ref().expect("a structure");
    (b.width, b.height)
}

#[test]
fn generated_maps_place_tech_buildings_and_villages_by_the_map_symmetry() {
    use crate::mapgen::settlements::TechBuildings;
    use crate::weather::Biome;
    let rules = crate::rules::Rules::load();
    let tech_ids = ["HOSP", "OILB", "FCOM", "MISS", "BIO"];
    let mut derrick_maps = 0;
    let mut maps = 0;
    let mut village_maps = 0;
    let (mut hospitals, mut between) = (0, 0);
    for players in 2usize..=8 {
        let size = if players <= 4 { 96 } else { 128 };
        for seed in 1u64..=4 {
            let m = Map::generate_styled(size, size, seed, 12, players, crate::mapgen::MapStyle::Random);
            let flip_y = players == 4 || (players >= 5 && players % 2 == 0);
            for (tech, biome) in [
                (TechBuildings::Standard, Biome::Temperate),
                (TechBuildings::Extra, Biome::Desert),
                (TechBuildings::OilRush, Biome::Snow),
                (TechBuildings::None, Biome::Temperate),
            ] {
                let what = format!("{players}p seed {seed} {tech:?}");
                let actors = crate::mapgen::sites::world_actors(&m, &rules, biome, tech, seed);
                maps += 1;
                // Closed under the map's mirrors: every structure has its images.
                for a in actors.iter().filter(|a| a.ty != "MINE" && a.ty != "GMINE") {
                    let (fw, fh) = size_of(&rules, &a.ty);
                    let mut images = vec![(m.width - a.x - fw, a.y)];
                    // Derricks of a base's own sit in its pocket, which faces south
                    // in every row: they follow the bases, not the top to bottom mirror.
                    let own = a.ty == "OILB" && m.spawns.iter().any(|&(sx, sy)| (a.x - sx).abs() <= 11 && (a.y - sy).abs() <= 11);
                    if flip_y && !own {
                        images.push((a.x, m.height - a.y - fh));
                    }
                    for (ix, iy) in images {
                        assert!(
                            actors.iter().any(|b| b.ty == a.ty && (b.x, b.y) == (ix, iy)),
                            "{what}: {} at {},{} has no image at {ix},{iy}",
                            a.ty,
                            a.x,
                            a.y
                        );
                    }
                    // Villages are of the biome.
                    let world = &rules.actors[rules.actor_index(&a.ty).unwrap()].world;
                    if let Some(biomes) = &world.biomes {
                        assert!(biomes.iter().any(|b| b == biome.name()), "{what}: {} on {}", a.ty, biome.name());
                    }
                }
                // Every base has the same number of derricks of its own.
                let own: Vec<usize> = m
                    .spawns
                    .iter()
                    .map(|&(sx, sy)| actors.iter().filter(|a| a.ty == "OILB" && (a.x - sx).abs() <= 11 && (a.y - sy).abs() <= 11).count())
                    .collect();
                assert!(own.iter().all(|&n| n == own[0]), "{what}: derricks per base {own:?}");
                if tech == TechBuildings::None {
                    assert!(!actors.iter().any(|a| tech_ids.contains(&a.ty.as_str())), "{what}: no tech buildings");
                } else if own[0] > 0 {
                    derrick_maps += 1;
                }
                if actors
                    .iter()
                    .any(|a| rules.actors[rules.actor_index(&a.ty).unwrap()].world.category.as_deref() == Some("Civilian building"))
                {
                    village_maps += 1;
                }
                if tech == TechBuildings::Standard && actors.iter().any(|a| a.ty == "HOSP") {
                    hospitals += 1;
                }
                if tech == TechBuildings::Extra && actors.iter().any(|a| a.ty == "FCOM" || a.ty == "MISS") {
                    between += 1;
                }
                if tech == TechBuildings::OilRush && own[0] > 0 {
                    assert!(own[0] == 2 || own[0] == 1, "{what}: up to two derricks a base");
                }
                // The file validates, and the bases still reach each other past the buildings.
                let mut d = MapData::from_map(&m, "Gen", "Test", "");
                d.actors = actors.clone();
                let v = d.validate();
                assert!(v.ok, "{what}: {:?}", v.errors);
                if seed == 1 && biome == Biome::Temperate {
                    let setups: Vec<PlayerSetup> =
                        (0..players).map(|k| PlayerSetup::new(if k % 2 == 0 { "england" } else { "russia" }, None)).collect();
                    let mut w = World::from_map(&d, seed, &setups, GameOptions::default()).expect("world");
                    w.pass.refresh(&w.map);
                    let comp = |&(x, y): &(i32, i32)| w.pass.component[w.map.idx(x + 1, y + 5)];
                    let first = comp(&m.spawns[0]);
                    for s in &m.spawns {
                        assert_eq!(comp(s), first, "{what}: base at {s:?} cut off");
                    }
                }
            }
        }
    }
    assert!(derrick_maps * 10 >= (maps / 4 * 3) * 9, "most maps give every base a derrick: {derrick_maps} of {}", maps / 4 * 3);
    assert!(village_maps * 2 >= maps, "most maps have villages: {village_maps} of {maps}");
    // 28 maps per option: the middle and the spots between bases mostly have room.
    assert!(hospitals >= 21, "a hospital in the middle: {hospitals} of 28");
    assert!(between >= 21, "buildings between neighbours: {between} of 28");
}

fn w_cell(w: &World, x: i32, y: i32) -> usize {
    w.map.idx(x, y)
}

#[test]
fn generated_maps_get_mirrored_ore_mines_and_trees() {
    for players in [2usize, 4] {
        let setups: Vec<PlayerSetup> =
            (0..players).map(|k| PlayerSetup::new(if k % 2 == 0 { "england" } else { "russia" }, None)).collect();
        let w = World::with_options(21, 96, &setups, GameOptions::default());
        let mines: Vec<(i32, i32)> = find(&w, "MINE").iter().chain(&find(&w, "GMINE")).map(|&i| (w.actors[i].cx, w.actors[i].cy)).collect();
        assert!(mines.len() >= 2, "{players}: the ore fields have mines");
        for &(x, y) in &mines {
            assert!(mines.contains(&(w.map.width - 1 - x, y)), "{players}: mine at {x},{y} has its mirror image");
        }
        let n = w.neutral_player().expect("trees and mines are neutral");
        let trees = (0..w.actors.len())
            .filter(|&i| {
                w.actors[i].alive
                    && w.actors[i].owner == n
                    && w.rules.actors[w.actors[i].ty as usize].world.category.as_deref() == Some("Tree")
            })
            .count();
        assert!(trees > 0, "{players}: trees are actors");
        assert!(!w.map.terrain.contains(&Terrain::Tree));
    }
    // A generated map file carries the mines; it validates.
    let json = crate::Game::generated_map_styled(21, 96, 2, "land", "temperate").unwrap();
    let d = MapData::parse(&json).unwrap();
    assert!(d.actors.iter().any(|a| (a.ty == "MINE" || a.ty == "GMINE") && a.owner == -1));
    assert!(d.validate().ok, "{:?}", d.validate().errors);
}

// ---- Terrain -------------------------------------------------------------------------------

#[test]
fn roads_are_fast_and_beaches_slow_wheels() {
    let drive = |terrain: Terrain| {
        let mut w = world_with(
            |m| {
                for x in 0..64 {
                    let i = m.idx(x, 30);
                    m.terrain[i] = terrain;
                }
            },
            vec![],
            opts(),
        );
        let jeep = unit(&mut w, "JEEP", 0, 5, 30);
        let ids = vec![w.make_ref(jeep)];
        w.queue_order(Order::Move { player: 0, ids, x: cell_center(60), y: cell_center(30), attack_move: false });
        run(&mut w, 60);
        w.actors[jeep].x
    };
    let (clear, road, beach) = (drive(Terrain::Clear), drive(Terrain::Road), drive(Terrain::Beach));
    assert!(road > clear, "roads are faster (wheeled: 125 percent): {road} vs {clear}");
    assert!(beach < clear, "beaches slow wheels (50 percent): {beach} vs {clear}");
    let w = world(vec![]);
    let jeep_loco = &w.rules.locomotors[w.rules.actors[ty(&w, "JEEP") as usize].unit.as_ref().unwrap().locomotor];
    assert_eq!(jeep_loco.speeds[crate::map::SPEED_ROAD], 125);
    assert_eq!(jeep_loco.speeds[crate::map::SPEED_BEACH], 50);
    assert!(Terrain::Road.buildable() && Terrain::Road.holds_ore() && !Terrain::River.passable() && !Terrain::Wall.passable());
    assert!(!Terrain::Bridge.buildable() && Terrain::Beach.passable() && !Terrain::Beach.ship_passable());
}

// ---- Walls ------------------------------------------------------------------------------

/// A wall line of `wall` owned by `owner` across x = 30 from y = 0 to 63.
fn walled(wall: &str, owner: u8) -> World {
    let mut w = world(vec![]);
    let t = ty(&w, wall);
    for y in 0..64 {
        let _ = w.spawn_building(t, owner, 30, y);
    }
    w.pass.refresh(&w.map);
    w
}

#[test]
fn tanks_crush_enemy_walls_on_their_way_but_not_their_own() {
    let mut w = walled("SBAG", 1);
    let tank = unit(&mut w, "3TNK", 0, 20, 30);
    let ids = vec![w.make_ref(tank)];
    w.queue_order(Order::Move { player: 0, ids, x: cell_center(40), y: cell_center(30), attack_move: false });
    run(&mut w, 400);
    assert!(w.actors[tank].x > cell_center(35), "the tank drove through the enemy sandbags");
    let crushed = (0..64).filter(|&y| w.building_at[w.map.idx(30, y)] == NONE).count();
    assert!(crushed >= 1, "and crushed some on the way");
    // Infantry cannot.
    let mut w = walled("SBAG", 1);
    let rifle = unit(&mut w, "E1", 0, 20, 30);
    let ids = vec![w.make_ref(rifle)];
    w.queue_order(Order::Move { player: 0, ids, x: cell_center(40), y: cell_center(30), attack_move: false });
    run(&mut w, 400);
    assert!(w.actors[rifle].x < cell_center(30));
    // Concrete walls only fall to the heaviest tanks (heavywall).
    let mut w = walled("BRIK", 1);
    let light = unit(&mut w, "3TNK", 0, 20, 20);
    let heavy = unit(&mut w, "4TNK", 0, 20, 40);
    for (u, y) in [(light, 20), (heavy, 40)] {
        let ids = vec![w.make_ref(u)];
        w.queue_order(Order::Move { player: 0, ids, x: cell_center(40), y: cell_center(y), attack_move: false });
    }
    run(&mut w, 500);
    assert!(w.actors[light].x < cell_center(30), "a heavy tank cannot crush concrete");
    assert!(w.actors[heavy].x > cell_center(35), "a Mammoth Tank can");
    // Own walls stay.
    let mut w = walled("SBAG", 0);
    let tank = unit(&mut w, "3TNK", 0, 20, 30);
    let ids = vec![w.make_ref(tank)];
    w.queue_order(Order::Move { player: 0, ids, x: cell_center(40), y: cell_center(30), attack_move: false });
    run(&mut w, 400);
    assert!(w.actors[tank].x < cell_center(30), "own walls are not crushed");
    assert!((0..64).all(|y| w.building_at[w.map.idx(30, y)] != NONE));
}

// ---- Determinism ------------------------------------------------------------------------

#[test]
fn the_neutral_world_is_deterministic() {
    let make = || {
        let mut w =
            world(vec![actor("C1", 30, 30), actor("C2", 31, 31), actor("OILB", 20, 20), actor("MINE", 40, 40), actor("BARL", 25, 25)]);
        w.options.ore_regrowth = true;
        w
    };
    let (mut a, mut b) = (make(), make());
    for t in 0..800 {
        if t == 100 {
            let civ = find(&a, "C1")[0];
            a.damage(civ, 50);
            b.damage(civ, 50);
        }
        a.step();
        b.step();
        assert_eq!(a.state_hash(), b.state_hash(), "tick {t}");
    }
    assert!(a.actors.iter().any(|x| x.alive && x.kind == Kind::Infantry));
}

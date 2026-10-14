//! What battles leave and drop: crates (crates.rs), husks (husks.rs), the
//! crew of sold structures (sell.rs), primary structures (primary.rs) and
//! the warheads that change no health (smudges.rs).

use crate::map::{Map, Terrain};
use crate::rules::Kind;
use crate::rules_options::CrateActionKind;
use crate::smudges::NO_SMUDGE;
use crate::sound_events::{SoundEventKind, EVENT_STRIDE};
use crate::world::{cell_center, Activity, GameOptions, Order, PlayerSetup, SmartAction, World};
use crate::Game;

fn ty(w: &World, id: &str) -> u16 {
    w.rules.actor_index(id).unwrap() as u16
}

fn run(w: &mut World, ticks: u32) {
    for _ in 0..ticks {
        w.step();
    }
}

fn unit(w: &mut World, id: &str, owner: u8, cx: i32, cy: i32) -> usize {
    let t = ty(w, id);
    w.spawn_unit(t, owner, cell_center(cx), cell_center(cy), 0)
}

fn setup(faction: &str) -> PlayerSetup {
    PlayerSetup { faction: faction.into(), ai: None, bot: Default::default(), team: 0, handicap: 0, spawn: None }
}

/// 48 by 48 open land with a lake on the right, two explored players with a
/// Construction Yard each, crates on.
fn world() -> World {
    let (w, h) = (48, 48);
    let mut terrain = vec![Terrain::Clear; (w * h) as usize];
    for y in 0..h {
        for x in 40..w {
            terrain[(y * w + x) as usize] = Terrain::Water;
        }
    }
    let map = Map {
        width: w,
        height: h,
        terrain,
        ore: vec![0; (w * h) as usize],
        gems: vec![0; (w * h) as usize],
        spawns: vec![(2, 2), (2, 40)],
    };
    let mut world = World::on_map(5, map, &[setup("england"), setup("russia")], GameOptions { crates: true, ..GameOptions::default() });
    for p in world.players.iter_mut() {
        p.explored.iter_mut().for_each(|e| *e = 1);
    }
    world.update_vision();
    world
}

fn events(w: &mut World, kind: SoundEventKind) -> Vec<[i32; EVENT_STRIDE]> {
    w.sound.take().chunks(EVENT_STRIDE).filter(|e| e[0] == kind as i32).map(|e| <[i32; EVENT_STRIDE]>::try_from(e).unwrap()).collect()
}

fn crate_action(w: &World, crate_id: &str, key: &str) -> crate::rules_options::CrateAction {
    let info = w.rules.actors[ty(w, crate_id) as usize].options.crate_info.as_ref().unwrap();
    info.actions.iter().find(|a| a.key == key).unwrap().clone()
}

// ---- Crates ---------------------------------------------------------------------------------

#[test]
fn the_spawner_flies_crates_in_on_a_badger_and_they_land() {
    let mut w = world();
    let c = w.rules.world.crates.clone();
    assert_eq!((c.minimum, c.maximum, c.spawn_interval, c.initial_delay), (1, 3, 3000, 1500), "world.yaml CrateSpawner");
    run(&mut w, c.initial_delay as u32 - 1);
    assert!(!w.actors.iter().any(|a| a.alive && a.air.mission == crate::plane::Mission::CrateDrop), "nothing before InitialSpawnDelay");
    run(&mut w, 1);
    let neutral = w.neutral_player().unwrap();
    let planes: Vec<usize> =
        (0..w.actors.len()).filter(|&i| w.actors[i].alive && w.actors[i].air.mission == crate::plane::Mission::CrateDrop).collect();
    // Minimum 1, below Maximum: one to reach the minimum and one more.
    assert_eq!(planes.len(), 2, "two deliveries");
    assert!(planes.iter().all(|&p| w.actors[p].owner == neutral && w.rules.actors[w.actors[p].ty as usize].id == "BADR"));
    let mut fell = false;
    for _ in 0..1500 {
        w.step();
        fell |= w.actors.iter().any(|a| a.alive && a.kind == Kind::Crate && a.air.parachute);
    }
    assert!(fell, "crates come down on a parachute");
    let landed: Vec<usize> = (0..w.actors.len()).filter(|&i| w.actors[i].alive && w.actors[i].kind == Kind::Crate).collect();
    assert_eq!(landed.len(), 2);
    assert_eq!(w.crates.count, 2);
    for &k in &landed {
        let a = &w.actors[k];
        assert_eq!(a.altitude, 0);
        assert_eq!(w.crate_at(w.cell_index(a.x, a.y)), Some(k));
        assert!(!w.targetable(k, 0), "never a target");
    }
    // The planes leave the map again.
    assert!(!w.actors.iter().any(|a| a.alive && a.air.mission == crate::plane::Mission::CrateDrop));
}

#[test]
fn crates_go_after_their_duration() {
    let mut w = world();
    // Without the spawner's own crates.
    w.crates = crate::crates::CrateState::new(&w.rules, false);
    let neutral = w.neutral_player().unwrap();
    let t = ty(&w, "CRATE") as usize;
    let c = w.place_crate(t, neutral, 20, 20, 0);
    let duration = w.rules.actors[t].options.crate_info.as_ref().unwrap().duration;
    assert_eq!(duration, 4500);
    run(&mut w, duration as u32 - 1);
    assert!(w.actors[c].alive);
    run(&mut w, 2);
    assert!(!w.actors[c].alive);
    assert_eq!(w.crates.count, 0);
}

#[test]
fn driving_onto_a_crate_collects_it() {
    let mut w = world();
    w.sound.set_enabled(true);
    let neutral = w.neutral_player().unwrap();
    let money = ty(&w, "MONEYCRATE") as usize;
    w.place_crate(money, neutral, 20, 20, 0);
    let jeep = unit(&mut w, "JEEP", 0, 15, 20);
    let cash = w.players[0].cash;
    w.queue_order(Order::Move { player: 0, ids: vec![w.make_ref(jeep)], x: cell_center(24), y: cell_center(20), attack_move: false });
    run(&mut w, 150);
    assert_eq!(w.players[0].cash - cash, 500, "a money crate");
    assert_eq!(w.crates.count, 0);
    let got = events(&mut w, SoundEventKind::CrateCollected);
    assert_eq!(got.len(), 1);
    let cash_code = crate::sound_events::crate_action_code("GiveCashCrateAction");
    assert_eq!((got[0][1], got[0][4], got[0][5]), (cash_code, 0, money as i32), "the money crate's cash, for player 0");
    // A plane flies over a crate without taking it; infantry walk onto it.
    let heal = ty(&w, "HEALCRATE") as usize;
    let c = w.place_crate(heal, neutral, 20, 30, 0);
    let e1 = unit(&mut w, "E1", 0, 18, 30);
    w.actors[e1].hp = 1;
    w.queue_order(Order::Move { player: 0, ids: vec![w.make_ref(e1)], x: cell_center(22), y: cell_center(30), attack_move: false });
    run(&mut w, 200);
    assert!(!w.actors[c].alive);
    assert_eq!(w.actors[e1].hp, w.rules.actors[ty(&w, "E1") as usize].hp, "healed");
}

/// OpenRA's ActorMap holds a paratrooper from its creation, an aircraft
/// only when landed (world.rs `occupies_cell`): no crate is dropped on a
/// cell a paratrooper comes down on (ChooseDropCell, and ParaDrop's
/// suitable cell check for a delivery plane), and a crate landing on one
/// is collected by it (Crate.OnLanded asks only for a Mobile actor whose
/// locomotor crushes crates, wherever it hangs).
#[test]
fn crates_treat_a_descending_paratrooper_as_on_its_cell() {
    let mut w = world();
    w.crates = crate::crates::CrateState::new(&w.rules, false);
    let neutral = w.neutral_player().unwrap();
    let e1 = unit(&mut w, "E1", 0, 20, 20);
    w.actors[e1].altitude = 4096;
    w.actors[e1].air.parachute = true;
    let heli = w.spawn_unit(ty(&w, "HELI"), 1, cell_center(22), cell_center(20), 0);
    w.rebuild_hash();
    assert!(w.actors[heli].altitude > 0, "spawned flying");
    assert!(w.cell_has_actor(w.map.idx(20, 20)), "no crate drop on the paratrooper");
    assert!(!w.cell_has_actor(w.map.idx(22, 20)), "a helicopter overhead takes no cell");
    let cash = w.players[0].cash;
    let c = w.place_crate(ty(&w, "MONEYCRATE") as usize, neutral, 20, 20, crate::crates::CRATE_FALL_RATE);
    w.tick_falling_crate(c);
    assert!(!w.actors[c].alive, "landed on the paratrooper");
    assert_eq!(w.players[0].cash - cash, 500, "and the paratrooper collected it");
    assert_eq!(w.crates.count, 0);
    let c = w.place_crate(ty(&w, "MONEYCRATE") as usize, neutral, 22, 20, crate::crates::CRATE_FALL_RATE);
    w.tick_falling_crate(c);
    assert!(w.actors[c].alive && w.actors[c].altitude == 0, "under the helicopter it stays");
}

/// OpenRA ParaDrop with checkForSuitableCell: a delivery plane keeps its
/// crate over a cell with anything in the ActorMap, a paratrooper on its
/// parachute too, and drops it over a free one (only a flying aircraft
/// above it).
#[test]
fn a_delivery_plane_drops_no_crate_onto_a_paratrooper() {
    let mut w = world();
    w.crates = crate::crates::CrateState::new(&w.rules, false);
    let e1 = unit(&mut w, "E1", 0, 20, 20);
    w.actors[e1].altitude = 4096;
    w.actors[e1].air.parachute = true;
    let heli = w.spawn_unit(ty(&w, "HELI"), 1, cell_center(24), cell_center(20), 0);
    w.rebuild_hash();
    assert!(w.actors[heli].altitude > 0, "spawned flying");
    let money = ty(&w, "MONEYCRATE");
    for (cx, dropped) in [(20, false), (24, true)] {
        let plane = w.spawn_unit(ty(&w, "BADR"), 1, cell_center(cx), cell_center(20), 0);
        w.actors[plane].altitude = 2048;
        w.actors[plane].air.cargo = vec![money];
        w.drop_crate(plane);
        assert!(w.actors[plane].air.cargo.is_empty(), "the plane gives up its cargo either way");
        assert_eq!(w.crate_at(w.map.idx(cx, 20)).is_some(), dropped, "cell ({cx}, 20)");
    }
}

#[test]
fn crate_shares_follow_openra() {
    let mut w = world();
    let tank = unit(&mut w, "1TNK", 0, 20, 20);
    let shares = |w: &World, key: &str| w.crate_shares(&crate_action(w, "CRATE", key), tank);
    assert_eq!(shares(&w, "GiveCashCrateAction"), 50);
    assert_eq!(shares(&w, "LevelUpCrateAction"), 40, "a rookie can rank up");
    w.actors[tank].rank = w.max_rank(tank);
    assert_eq!(shares(&w, "LevelUpCrateAction"), 0, "elite: no more levels");
    // GiveBaseBuilder: 0 with a base, NoBaseSelectionShares without one.
    assert_eq!(shares(&w, "GiveBaseBuilderCrateAction"), 0);
    for i in 0..w.actors.len() {
        if w.actors[i].alive && w.actors[i].owner == 0 && w.rules.actors[w.actors[i].ty as usize].base_building {
            w.remove(i);
        }
    }
    run(&mut w, 1);
    assert_eq!(shares(&w, "GiveBaseBuilderCrateAction"), 100);
    // Prerequisites: a medium tank needs the tech level and a service depot.
    assert_eq!(shares(&w, "GiveUnitCrateAction@2tnk"), 0);
    let fix = ty(&w, "FIX");
    w.spawn_building(fix, 0, 8, 8);
    w.refresh_tokens();
    assert_eq!(shares(&w, "GiveUnitCrateAction@2tnk"), 4);
    assert_eq!(shares(&w, "GiveUnitCrateAction@3tnk"), 0, "Soviet only");
    // TimeDelay: the heavy squad not before tick 4500.
    assert_eq!(shares(&w, "GiveUnitCrateAction@squadheavyallies"), 0);
    w.tick = 4500;
    assert!(shares(&w, "GiveUnitCrateAction@squadheavyallies") > 0);
    // HideMap: never with the explored map option.
    assert_eq!(shares(&w, "HideMapCrateAction"), 5);
    w.options.explored = true;
    assert_eq!(shares(&w, "HideMapCrateAction"), 0);
    // Ships get no tanks on water, tanks no boats on land.
    let boat = unit(&mut w, "PT", 0, 44, 20);
    assert_eq!(w.crate_shares(&crate_action(&w, "CRATE", "GiveUnitCrateAction@1tnk"), boat), 0);
    assert_eq!(w.crate_shares(&crate_action(&w, "CRATE", "GiveUnitCrateAction@pt"), tank), 0);
    assert_eq!(w.crate_shares(&crate_action(&w, "CRATE", "GiveUnitCrateAction@pt"), boat), 6);
    // The squad with the medic and engineer comes without them until they exist.
    let squad = crate_action(&w, "CRATE", "GiveUnitCrateAction@squadheavyallies");
    assert!(squad.units.iter().all(|&u| w.rules.actors[u].unit.is_some()));
}

#[test]
fn crate_actions_do_what_openra_does() {
    let mut w = world();
    let tank = unit(&mut w, "1TNK", 0, 20, 20);
    let (x, y) = (w.actors[tank].x, w.actors[tank].y);
    // Level up.
    w.activate_crate(&crate_action(&w, "CRATE", "LevelUpCrateAction"), tank, x, y);
    assert_eq!(w.actors[tank].rank, 1);
    // Duplicate: copies on free cells around, at most MaxDuplicateValue worth.
    let before = w.actors.iter().filter(|a| a.alive && a.owner == 0 && a.ty == w.actors[tank].ty).count();
    let dup = crate_action(&w, "CRATE", "DuplicateUnitCrateAction");
    w.activate_crate(&dup, tank, x, y);
    let after = w.actors.iter().filter(|a| a.alive && a.owner == 0 && a.ty == w.actors[tank].ty).count();
    let cost = w.rules.actors[w.actors[tank].ty as usize].cost;
    assert_eq!(after - before, (dup.max_amount.min(dup.max_duplicate_value / cost)) as usize);
    // Units: the light squad next to the collector.
    let infantry = |w: &World| w.actors.iter().filter(|a| a.alive && a.owner == 0 && a.kind == Kind::Infantry).count();
    let n = infantry(&w);
    w.activate_crate(&crate_action(&w, "CRATE", "GiveUnitCrateAction@squadlight"), tank, x, y);
    assert_eq!(infantry(&w) - n, 5);
    // Reveal and hide the map.
    for p in w.players.iter_mut() {
        p.explored.iter_mut().for_each(|e| *e = 0);
    }
    w.activate_crate(&crate_action(&w, "CRATE", "RevealMapCrateAction"), tank, x, y);
    assert!(w.players[0].explored.iter().all(|&e| e == 1));
    assert!(w.players[1].explored.iter().all(|&e| e == 0), "only the collector's owner");
    w.update_vision();
    w.activate_crate(&crate_action(&w, "CRATE", "HideMapCrateAction"), tank, x, y);
    let explored = w.players[0].explored.iter().filter(|&&e| e != 0).count();
    let visible = w.players[0].visible.iter().filter(|&&v| v != 0).count();
    assert_eq!(explored, visible, "only what is in sight stays explored");
    // Invulnerability: the Iron Curtain's condition for Duration ticks.
    w.activate_crate(&crate_action(&w, "CRATE", "GrantExternalConditionCrateAction@invuln"), tank, x, y);
    assert_eq!(w.actors[tank].invulnerable_until, w.tick + 600);
    // Explosions hurt the collector (CrateExplosion AffectsParent).
    let hp = w.actors[tank].hp;
    w.actors[tank].invulnerable_until = 0;
    w.rebuild_hash();
    w.activate_crate(&crate_action(&w, "CRATE", "ExplodeCrateAction@boom"), tank, x, y);
    run(&mut w, 2);
    assert!(!w.actors[tank].alive || w.actors[tank].hp < hp, "boom");
    // A new MCV for a player without a base.
    let mcvs = |w: &World| w.actors.iter().filter(|a| a.alive && a.owner == 1 && w.rules.actors[a.ty as usize].id == "MCV").count();
    let soldier = unit(&mut w, "E1", 1, 30, 30);
    let (sx, sy) = (w.actors[soldier].x, w.actors[soldier].y);
    let n = mcvs(&w);
    w.activate_crate(&crate_action(&w, "CRATE", "GiveBaseBuilderCrateAction"), soldier, sx, sy);
    assert_eq!(mcvs(&w), n + 1);
}

#[test]
fn crate_kinds_cover_every_action_of_the_rules() {
    let w = world();
    let kinds: Vec<CrateActionKind> =
        w.rules.actors[ty(&w, "CRATE") as usize].options.crate_info.as_ref().unwrap().actions.iter().map(|a| a.kind).collect();
    for k in [
        CrateActionKind::GiveCash,
        CrateActionKind::LevelUp,
        CrateActionKind::Explode,
        CrateActionKind::HideMap,
        CrateActionKind::HealActors,
        CrateActionKind::RevealMap,
        CrateActionKind::DuplicateUnit,
        CrateActionKind::GiveBaseBuilder,
        CrateActionKind::GiveUnit,
        CrateActionKind::GrantExternalCondition,
    ] {
        assert!(kinds.contains(&k), "{k:?} in misc.yaml CRATE");
    }
}

#[test]
fn a_supply_truck_leaves_a_money_crate() {
    let mut w = world();
    let truck = unit(&mut w, "TRUK", 0, 20, 20);
    w.kill(truck);
    let c = w.crate_at(w.map.idx(20, 20)).expect("SpawnActorOnDeath moneycrate");
    assert_eq!(w.rules.actors[w.actors[c].ty as usize].id, "MONEYCRATE");
}

// ---- Husks ------------------------------------------------------------------------------------

#[test]
fn tanks_leave_husks_that_block_their_cell_and_burn_down() {
    let mut w = world();
    let tank = unit(&mut w, "2TNK", 1, 20, 20);
    let ci = w.map.idx(20, 20);
    w.kill(tank);
    let h = w.husk_at(ci).expect("2TNK.Husk");
    assert_eq!(w.rules.actors[w.actors[h].ty as usize].id, "2TNK.Husk");
    assert_eq!(w.actors[h].owner, 1);
    assert!(w.pass.blocked[ci], "a husk blocks its cell");
    // Only force-fire targets it; a normal click on it is a move.
    let shooter = unit(&mut w, "1TNK", 0, 24, 20);
    w.update_vision();
    assert!(!w.targetable(h, 0));
    let hx = w.actors[h].x;
    let hy = w.actors[h].y;
    assert_eq!(w.smart_action(0, &[shooter], hx, hy), SmartAction::Move);
    w.order_attack(&[shooter], h, true);
    run(&mut w, 2);
    assert_eq!(w.actors[shooter].activity, Activity::Attack, "force-fire keeps at it");
    w.order_move(&[shooter], cell_center(30), cell_center(30), false);
    // It burns: 200 hit points every 8 ticks until nothing is left.
    let info = w.rules.actors[w.actors[h].ty as usize].options.husk.clone().unwrap();
    assert_eq!((info.burn_step, info.burn_delay), (-200, 8));
    let hp = w.actors[h].hp;
    run(&mut w, 8);
    assert!(w.actors[h].hp <= hp - 200);
    let left = (w.actors[h].hp / 200 + 2) as u32 * 8;
    run(&mut w, left);
    assert!(!w.actors[h].alive, "burnt out");
    assert!(!w.pass.blocked[ci], "the cell is free again");
}

#[test]
fn harvesters_leave_a_full_or_empty_husk_and_spill_their_ore() {
    let mut w = world();
    let harv = unit(&mut w, "HARV", 1, 20, 20);
    let capacity = w.rules.actors[ty(&w, "HARV") as usize].unit.as_ref().unwrap().harvester.as_ref().unwrap().capacity;
    w.actors[harv].bales = capacity;
    w.actors[harv].activity = Activity::Idle;
    w.kill(harv);
    let h = w.husk_at(w.map.idx(20, 20)).unwrap();
    assert_eq!(w.rules.actors[w.actors[h].ty as usize].id, "HARV.FullHusk");
    // OreExplosion (CreateResource Size 1,1): ore on the ring around it.
    run(&mut w, 3);
    let ore: u32 = (19..=21).flat_map(|y| (19..=21).map(move |x| (x, y))).map(|(x, y)| w.map.ore[w.map.idx(x, y)] as u32).sum();
    assert!(ore > 0, "the full truck spilled ore");
    assert_eq!(w.map.ore[w.map.idx(20, 20)], 0, "inner radius 1: not under the wreck");
    // An empty one leaves the empty husk and no ore (FireWarheadsOnDeath needs ore on board).
    let empty = unit(&mut w, "HARV", 1, 30, 30);
    w.actors[empty].bales = 0;
    w.kill(empty);
    run(&mut w, 3);
    let h = w.husk_at(w.map.idx(30, 30)).unwrap();
    assert_eq!(w.rules.actors[w.actors[h].ty as usize].id, "HARV.EmptyHusk");
    let ore: u32 = (29..=31).flat_map(|y| (29..=31).map(move |x| (x, y))).map(|(x, y)| w.map.ore[w.map.idx(x, y)] as u32).sum();
    assert_eq!(ore, 0);
}

#[test]
fn husks_crush_enemy_infantry_and_can_be_restored() {
    let mut w = world();
    let rifle = unit(&mut w, "E1", 0, 20, 20);
    let tank = unit(&mut w, "3TNK", 1, 20, 20);
    w.rebuild_hash();
    w.kill(tank);
    assert!(!w.actors[rifle].alive, "the wreck lands on the soldier");
    let h = w.husk_at(w.map.idx(20, 20)).unwrap();
    // Engineers and mechanics take it back (Capturable husk, TransformOnCapture).
    let cap = w.husk_capture(h, false).unwrap().clone();
    assert_eq!(cap.types, vec!["husk".to_string()]);
    assert_eq!(w.rules.actors[cap.transform_into].id, "3TNK");
    let u = w.restore_husk(h, 0, false).unwrap();
    assert_eq!(w.actors[u].owner, 0);
    assert_eq!(w.actors[u].hp, w.rules.actors[cap.transform_into].hp * 15 / 100, "ForceHealthPercentage 15");
    run(&mut w, 1);
    assert!(w.husk_at(w.map.idx(20, 20)).is_none());
}

// ---- Sold structures ---------------------------------------------------------------------------

#[test]
fn a_sold_structure_leaves_its_crew() {
    let mut w = world();
    let weap = ty(&w, "WEAP");
    let b = w.spawn_building(weap, 0, 20, 20).unwrap();
    let infantry = |w: &World| w.actors.iter().filter(|a| a.alive && a.owner == 0 && a.kind == Kind::Infantry).count();
    let n = infantry(&w);
    w.sell(b);
    // 40 % of 2000 = 800: the guaranteed rifleman, then riflemen and
    // technicians (TECN, TECN2: $10, the neutral world's civilians) while the
    // rest pays, one per footprint cell: all nine cells.
    assert_eq!(infantry(&w) - n, 9);
    assert!(w.actors.iter().any(|a| a.alive && a.owner == 0 && w.rules.actors[a.ty as usize].id.starts_with("TECN")));
    // Below MinHpPercent only the guaranteed ones come out.
    let b = w.spawn_building(weap, 0, 30, 20).unwrap();
    w.actors[b].hp = w.rules.actors[weap as usize].hp / 5;
    let n = infantry(&w);
    w.sell(b);
    assert_eq!(infantry(&w) - n, 1);
}

// ---- Primary structures ------------------------------------------------------------------------

#[test]
fn deploying_a_factory_makes_it_primary_and_units_leave_it() {
    let mut w = world();
    w.sound.set_enabled(true);
    let tent = ty(&w, "TENT");
    let a = w.spawn_building(tent, 0, 10, 12).unwrap();
    let b = w.spawn_building(tent, 0, 20, 12).unwrap();
    w.refresh_tokens();
    w.queue_order(Order::Deploy { player: 0, ids: vec![w.make_ref(b)] });
    run(&mut w, 1);
    assert!(w.actors[b].primary && !w.actors[a].primary);
    assert_eq!(events(&mut w, SoundEventKind::PrimaryBuildingSelected).len(), 1);
    let e1 = ty(&w, "E1");
    w.start_production(0, e1, 1);
    let before: Vec<usize> = (0..w.actors.len()).filter(|&i| w.actors[i].alive).collect();
    run(&mut w, 400);
    let new = (0..w.actors.len()).find(|&i| w.actors[i].alive && !before.contains(&i) && w.actors[i].ty == e1).expect("a rifleman");
    let (bx, ax) = (w.actors[b].x, w.actors[a].x);
    assert!((w.actors[new].x - bx).abs() < (w.actors[new].x - ax).abs(), "out of the primary barracks");
    // Making the other one primary takes the mark away from the first.
    w.queue_order(Order::Deploy { player: 0, ids: vec![w.make_ref(a)] });
    run(&mut w, 1);
    assert!(w.actors[a].primary && !w.actors[b].primary);
    // Deploy on a primary structure clears it again.
    w.queue_order(Order::Deploy { player: 0, ids: vec![w.make_ref(a)] });
    run(&mut w, 1);
    assert!(!w.actors[a].primary);
    // The UI's deploy state names it.
    let g = Game::wrap(w.clone());
    assert_eq!(g.deploy_state(0, g.world.make_ref(a)), 3);
}

// ---- Smudges and resources ----------------------------------------------------------------------------

#[test]
fn explosions_leave_smudges_that_are_presentation_only() {
    let mut w = world();
    let gun = w.rules.weapons.iter().position(|x| x.name == "90mm").unwrap();
    let ci = w.map.idx(25, 25);
    let hash = w.state_hash();
    w.impact(gun, cell_center(25), cell_center(25), 0);
    assert_ne!(w.smudges.cells[ci], NO_SMUDGE, "a crater");
    assert!(w.smudges.changed);
    assert_eq!(w.state_hash(), hash, "smudges are not simulation state");
    // Every hit makes it deeper.
    let depth = w.smudges.cells[ci] & 7;
    w.impact(gun, cell_center(25), cell_center(25), 0);
    assert_eq!(w.smudges.cells[ci] & 7, depth + 1);
    // No smudges on water.
    let water = w.map.idx(44, 25);
    w.impact(gun, cell_center(44), cell_center(25), 0);
    assert_eq!(w.smudges.cells[water], NO_SMUDGE);
    // The client sees a smudge only once its player sees the cell (the alpha byte).
    let mut g = Game::wrap(w);
    for v in g.world.players[0].visible.iter_mut() {
        *v = 0;
    }
    g.build_render_records(0);
    let t = unsafe { std::slice::from_raw_parts(g.terrain_ptr(), g.terrain_len()) };
    assert_eq!(t[ci * 4 + 3], NO_SMUDGE, "hidden under the fog");
    g.world.players[0].visible[ci] = 1;
    g.world.tick += 1;
    g.build_render_records(0);
    let t = unsafe { std::slice::from_raw_parts(g.terrain_ptr(), g.terrain_len()) };
    assert_ne!(t[ci * 4 + 3], NO_SMUDGE, "revealed when seen");
}

#[test]
fn nukes_clear_ore_flash_and_shake_the_screen() {
    let mut w = world();
    w.sound.set_enabled(true);
    for y in 10..30 {
        for x in 10..30 {
            let i = w.map.idx(x, y);
            w.map.ore[i] = 5;
        }
    }
    let atomic = w.rules.weapons.iter().position(|x| x.name == "Atomic").unwrap();
    w.impact(atomic, cell_center(20), cell_center(20), 0);
    run(&mut w, 25);
    assert_eq!(w.map.ore[w.map.idx(20, 20)], 0, "DestroyResource at the centre");
    assert_eq!(w.map.ore[w.map.idx(24, 20)], 0, "and out to Size 5 over 20 ticks");
    assert_eq!(w.map.ore[w.map.idx(10, 10)], 5, "not beyond");
    let ev = w.sound.take();
    let kinds: Vec<i32> = ev.chunks(EVENT_STRIDE).map(|e| e[0]).collect();
    assert!(kinds.contains(&(SoundEventKind::Flash as i32)), "FlashEffect");
    assert!(kinds.contains(&(SoundEventKind::ScreenShake as i32)), "ShakeScreen");
    // A burst in the air leaves the ground as it was.
    let mut w = world();
    let gun = w.rules.weapons.iter().position(|x| x.name == "90mm").unwrap();
    w.apply_effect(gun, 0, cell_center(25), cell_center(25), 1024);
    assert_eq!(w.smudges.cells[w.map.idx(25, 25)], NO_SMUDGE);
}

#[test]
fn maps_place_crates_and_husks_in_their_cells() {
    let mut m = crate::map::Map::generate_for(64, 64, 4, 12, 2);
    for i in 0..m.cells() {
        m.terrain[i] = Terrain::Clear;
        m.ore[i] = 0;
        m.gems[i] = 0;
    }
    let mut data = crate::mapdata::MapData::from_map(&m, "Leftovers", "Tester", "");
    data.actors.push(crate::mapdata::MapActor::new("WCRATE", -1, 30, 30, 0));
    data.actors.push(crate::mapdata::MapActor::new("3TNK.Husk", -1, 31, 30, 256));
    let players = [setup("england"), setup("russia")];
    let w = World::from_map(&data, 1, &players, GameOptions::default()).unwrap();
    let c = w.crate_at(w.map.idx(30, 30)).expect("the map's crate");
    assert_eq!(w.rules.actors[w.actors[c].ty as usize].id, "WCRATE");
    assert_eq!(w.crates.count, 1);
    let h = w.husk_at(w.map.idx(31, 30)).expect("the map's husk");
    assert!(w.pass.blocked[w.map.idx(31, 30)]);
    assert_eq!(w.actors[h].facing, 256);
}

//! Tests for lightning strikes and the Lightning Rod (lightning.rs,
//! ai_lightning.rs), WebRA additions. Synthetic worlds only.

use crate::lightning::{OUTAGE_TICKS, PLANT_STRIKE_PERCENT};
use crate::rules::{CircleKind, Kind, QueueType};
use crate::sound_events::{SoundEventKind, EVENT_STRIDE};
use crate::tests_ai::{arena, put, run, ty};
use crate::weather::{Biome, Environment, Strike, StrikeKind, Weather, WeatherMode};
use crate::world::{cell_center, AiDifficulty, GameOptions, PlayerSetup, World};

/// 64x64 map, players 0 and 1 (no AI, no ore), a temperate sky with full weather.
fn world() -> World {
    let mut w = World::new(7, 64, &[("allies", false), ("soviet", false)]);
    w.clear_neutral_world();
    for i in 0..w.map.cells() {
        w.map.ore[i] = 0;
    }
    w.options.ore_regrowth = false;
    w.env = Environment::new(Biome::Temperate, WeatherMode::Full, 7);
    w.sound.set_enabled(true);
    w
}

fn building(w: &mut World, id: &str, owner: u8, cx: i32, cy: i32) -> usize {
    let t = ty(w, id);
    w.spawn_building(t, owner, cx, cy).expect("free spot")
}

fn max_hp(w: &World, i: usize) -> i32 {
    w.rules.actors[w.actors[i].ty as usize].hp
}

/// A strike at the centre of cell (cx, cy): `roll` 0..100 and `pick`.
fn strike(cx: i32, cy: i32, roll: i32, pick: i32) -> Strike {
    Strike { x: cell_center(cx), y: cell_center(cy), roll, pick }
}

fn strikes(w: &mut World) -> Vec<[i32; EVENT_STRIDE]> {
    let data = w.sound.take();
    data.chunks(EVENT_STRIDE).filter(|e| e[0] == SoundEventKind::LightningStrike as i32).map(|e| e.try_into().unwrap()).collect()
}

fn flash_kind(w: &World) -> StrikeKind {
    w.env.flash.expect("a flash").3
}

// ---- Rules ------------------------------------------------------------------------------

#[test]
fn the_lightning_rod_is_a_cheap_defense_structure_for_both_sides() {
    let mut w = world();
    let rod = ty(&w, "LROD") as usize;
    let info = &w.rules.actors[rod];
    assert_eq!((info.name.as_str(), info.kind, info.queue, info.cost), ("Lightning Rod", Kind::Building, QueueType::Defense, 300));
    assert_eq!((info.hp, info.build_ticks), (30000, 180));
    let b = info.building.as_ref().unwrap();
    assert_eq!((b.width, b.height, b.power, b.lightning_rod), (1, 1, 0, 6 * 1024), "1x1, needs no power, 6 cells");
    assert!(b.repairable.is_some() && b.sell_refund == 50 && !b.gives_buildable_area);
    assert!(info.abilities.capturable.is_some(), "engineers capture it like other structures");
    // Its range circle, shown when selected and while placing (WithRangeCircle).
    let c = &info.range_circles[0];
    assert_eq!((c.kind, c.group.as_str(), c.range, c.placement), (CircleKind::Fixed, "LightningRod", 6 * 1024, true));
    // Only rods ground lightning; power plants make power.
    for a in &w.rules.actors {
        assert_eq!(a.building.as_ref().is_some_and(|b| b.lightning_rod > 0), a.id == "LROD", "{}", a.id);
    }
    // Both sides build it once a power plant stands (prerequisite anypower).
    for p in 0..2u8 {
        assert!(!w.can_start(p, rod as u16), "player {p}: no power plant yet");
    }
    building(&mut w, "POWR", 0, 10, 10);
    building(&mut w, "POWR", 1, 40, 10);
    w.refresh_tokens();
    for p in 0..2u8 {
        assert!(w.can_start(p, rod as u16), "player {p}");
    }
}

// ---- Targeting --------------------------------------------------------------------------

#[test]
fn power_plants_attract_lightning_and_black_out_their_owners_power() {
    let mut w = world();
    let a = building(&mut w, "POWR", 0, 10, 10);
    let b = building(&mut w, "APWR", 1, 40, 10);
    let tsla = building(&mut w, "TSLA", 1, 44, 10);
    w.update_power();
    let gen1 = w.players[1].power_gen;
    assert!(gen1 > 0);
    // Below the plant chance the strike goes for a plant: `pick` chooses
    // among every player's plants in actor order, wherever the random cell is.
    let second = if a < b { 1 } else { 0 };
    w.strike_lightning(strike(60, 60, PLANT_STRIKE_PERCENT - 1, second));
    let half = max_hp(&w, b) / 2;
    assert_eq!(w.actors[b].hp, max_hp(&w, b) - half, "the plant loses half of its health");
    assert_eq!(w.actors[a].hp, max_hp(&w, a), "the other plant is untouched");
    assert_eq!(w.power_outage(1), OUTAGE_TICKS);
    assert_eq!(w.power_outage(0), 0);
    assert_eq!(flash_kind(&w), StrikeKind::PowerPlant);
    assert_eq!(w.env.flash.unwrap().1, w.actors[b].x, "the bolt hits the plant");
    let ev = strikes(&mut w);
    assert_eq!(ev.len(), 1);
    assert_eq!((ev[0][1], ev[0][4], ev[0][5]), (w.actors[b].ty as i32, 1, StrikeKind::PowerPlant as i32));
    // Every plant of the owner stops producing: low power, the Tesla Coil goes dark.
    w.update_power();
    assert_eq!(w.players[1].power_gen, 0);
    assert!(w.players[1].low_power() && w.is_powered_down(tsla));
    // Half of the current health each time: lightning alone never destroys it.
    for _ in 0..40 {
        w.strike_lightning(strike(60, 60, 0, second));
    }
    assert!(w.actors[b].alive && w.actors[b].hp >= 1);
    // The outage runs out after 15 s and the plants make power again.
    w.strike_lightning(strike(60, 60, 0, 1 - second));
    assert_eq!(w.power_outage(0), OUTAGE_TICKS);
    for _ in 0..OUTAGE_TICKS {
        w.step();
    }
    assert_eq!(w.power_outage(0), 0);
    w.update_power();
    assert!(w.players[0].power_gen > 0);
}

#[test]
fn a_running_outage_is_only_lengthened() {
    let mut w = world();
    building(&mut w, "POWR", 0, 10, 10);
    w.inf.outage.resize(2, (0, 0));
    w.inf.outage[0] = (OUTAGE_TICKS * 2, OUTAGE_TICKS * 2);
    w.strike_lightning(strike(60, 60, 0, 0));
    assert_eq!(w.power_outage(0), OUTAGE_TICKS * 2, "a spy's longer outage stays");
    w.inf.outage[0] = (5, 10);
    w.strike_lightning(strike(60, 60, 0, 0));
    assert_eq!(w.power_outage(0), OUTAGE_TICKS);
}

#[test]
fn other_strikes_halve_what_stands_on_the_struck_cell() {
    let mut w = world();
    let tank = w.spawn_unit(ty(&w, "2TNK"), 0, cell_center(20), cell_center(20), 0);
    let wall = building(&mut w, "SILO", 1, 30, 30);
    let plant = building(&mut w, "POWR", 1, 50, 50);
    // Above the plant chance: the random cell.
    w.strike_lightning(strike(20, 20, PLANT_STRIKE_PERCENT, 0));
    assert_eq!(w.actors[tank].hp, max_hp(&w, tank) - max_hp(&w, tank) / 2);
    assert_eq!(flash_kind(&w), StrikeKind::Hit);
    w.strike_lightning(strike(30, 30, 99, 0));
    assert_eq!(w.actors[wall].hp, max_hp(&w, wall) - max_hp(&w, wall) / 2);
    assert_eq!(w.power_outage(1), 0, "a silo is no power plant");
    // Open ground: nothing happens.
    w.strike_lightning(strike(5, 50, 99, 0));
    assert_eq!(flash_kind(&w), StrikeKind::Ground);
    // A plant struck on its cell blacks out its owner too.
    let (px, py) = (w.actors[plant].cx, w.actors[plant].cy);
    w.strike_lightning(strike(px, py, 99, 0));
    assert_eq!((flash_kind(&w), w.power_outage(1)), (StrikeKind::PowerPlant, OUTAGE_TICKS));
    // Lightning never kills, and the Iron Curtain blocks it.
    for _ in 0..40 {
        w.strike_lightning(strike(20, 20, 99, 0));
    }
    assert!(w.actors[tank].alive && w.actors[tank].hp >= 1);
    w.actors[wall].invulnerable_until = w.tick + 100;
    let hp = w.actors[wall].hp;
    w.strike_lightning(strike(30, 30, 99, 0));
    assert_eq!((w.actors[wall].hp, flash_kind(&w)), (hp, StrikeKind::Ground));
}

#[test]
fn a_lightning_rod_grounds_every_strike_within_its_range() {
    let mut w = world();
    let rod = building(&mut w, "LROD", 1, 30, 30);
    // Power plants and units of both players within 6 cells of the rod.
    let plant = building(&mut w, "POWR", 0, 26, 30);
    let tank = w.spawn_unit(ty(&w, "2TNK"), 0, cell_center(33), cell_center(34), 0);
    let far = building(&mut w, "POWR", 0, 50, 50);
    w.update_power();
    assert!(w.lightning_protected(w.actors[plant].x, w.actors[plant].y));
    assert!(!w.lightning_protected(w.actors[far].x, w.actors[far].y));
    // A plant strike skips the protected plant: only the far one can be picked.
    for pick in 0..4 {
        w.strike_lightning(strike(60, 5, 0, pick));
        assert_eq!(w.env.flash.unwrap().1, w.actors[far].x, "pick {pick}");
    }
    assert_eq!(w.actors[plant].hp, max_hp(&w, plant));
    // A strike on the tank's cell is grounded on the rod: no damage, the rod included.
    strikes(&mut w);
    w.strike_lightning(strike(33, 34, 99, 0));
    assert_eq!(w.actors[tank].hp, max_hp(&w, tank));
    assert_eq!(w.actors[rod].hp, max_hp(&w, rod));
    let f = w.env.flash.unwrap();
    assert_eq!((f.1, f.2, f.3), (w.actors[rod].x, w.actors[rod].y, StrikeKind::Rod));
    let ev = strikes(&mut w);
    assert_eq!((ev.len(), ev[0][4], ev[0][5]), (1, 1, StrikeKind::Rod as i32), "the rod's owner sees it grounded");
    // Every plant protected: plant strikes fall on the random cell instead.
    let rod2 = building(&mut w, "LROD", 0, 52, 52);
    let far_hp = w.actors[far].hp;
    w.strike_lightning(strike(10, 60, 0, 0));
    assert_eq!(flash_kind(&w), StrikeKind::Ground);
    assert_eq!(w.actors[far].hp, far_hp);
    // A strike both rods reach is grounded on the nearer one.
    w.strike_lightning(strike(51, 51, 99, 0));
    assert_eq!(w.env.flash.unwrap().1, w.actors[rod2].x);
    let rod3 = building(&mut w, "LROD", 1, 46, 46);
    w.strike_lightning(strike(47, 47, 99, 0));
    assert_eq!(w.env.flash.unwrap().1, w.actors[rod3].x);
    w.strike_lightning(strike(51, 50, 99, 0));
    assert_eq!(w.env.flash.unwrap().1, w.actors[rod2].x);
    // A destroyed rod protects nothing.
    w.actors[rod3].hp = 0;
    w.kill(rod3);
    w.actors[rod2].hp = 0;
    w.kill(rod2);
    w.cleanup_dead();
    w.strike_lightning(strike(60, 5, 0, 0));
    assert_eq!(w.env.flash.unwrap().1, w.actors[far].x);
    assert!(w.actors[far].hp < far_hp);
}

// ---- The weather mode, determinism ------------------------------------------------------

/// Two plants each for two players under a temperate sky, `mode` weather.
fn storm_world(seed: u64, mode: WeatherMode) -> World {
    let opts = GameOptions { biome: Some(Biome::Temperate), weather: mode, ..GameOptions::default() };
    let players = [PlayerSetup::new("allies", None), PlayerSetup::new("soviet", None)];
    let mut w = World::with_options(seed, 48, &players, opts);
    w.clear_neutral_world();
    w.sound.set_enabled(true);
    for (p, x) in [(0u8, 4), (0, 8), (1, 34), (1, 38)] {
        put(&mut w, "POWR", p, x, 20);
    }
    w.update_power();
    w
}

/// Plant hit points of every plant, in actor order.
fn plant_hp(w: &World) -> Vec<i32> {
    w.actors.iter().filter(|a| a.alive && w.rules.actors[a.ty as usize].id == "POWR").map(|a| a.hp).collect()
}

#[test]
fn storms_strike_deterministically_with_full_weather_only() {
    let mut a = storm_world(11, WeatherMode::Full);
    let mut b = storm_world(11, WeatherMode::Full);
    let mut c = storm_world(11, WeatherMode::Cosmetic);
    let mut hits = 0;
    let mut storms = 0;
    let mut last = Weather::Clear;
    // Twenty minutes: the opening's clear skies, then several spells of weather.
    for t in 0..25 * 60 * 20 {
        a.step();
        b.step();
        c.step();
        if t % 250 == 0 {
            assert_eq!(a.state_hash(), b.state_hash(), "tick {t}");
        }
        // Full and cosmetic weather share the cycle, flashes included (the
        // flash lands on its target with full weather only).
        assert_eq!((a.env.weather, a.env.since), (c.env.weather, c.env.since));
        assert_eq!(a.env.flash.map(|f| f.0), c.env.flash.map(|f| f.0));
        if a.env.weather == Weather::Thunderstorm && last != Weather::Thunderstorm {
            storms += 1;
        }
        last = a.env.weather;
        hits += strikes(&mut a).iter().filter(|e| e[5] == StrikeKind::PowerPlant as i32).count();
        strikes(&mut b);
        assert!(strikes(&mut c).is_empty(), "cosmetic lightning strikes nothing");
    }
    assert!(storms > 0, "a thunderstorm in twenty temperate minutes");
    assert!(hits > 0, "plants were struck");
    assert_eq!(plant_hp(&a), plant_hp(&b));
    assert!(plant_hp(&c).iter().all(|&hp| hp == 40000), "{:?}", plant_hp(&c));
}

// ---- The AI -----------------------------------------------------------------------------

fn normal() -> Option<(crate::ai_bots::BotType, AiDifficulty)> {
    Some((crate::ai_bots::BotType::Normal, AiDifficulty::Normal))
}

/// A bot with a yard and three power plants, a passive enemy far away, and
/// the sky of `biome` with `mode` weather.
fn ai_world(biome: Biome, mode: WeatherMode) -> World {
    let mut w = arena(64, &[("england", normal(), 0, (4, 4)), ("russia", None, 1, (52, 52))]);
    w.env = Environment::new(biome, mode, 3);
    // A first strike has been seen (cosmetic and off skies have none).
    if mode == WeatherMode::Full {
        w.env.flash = Some((0, 0, 0, StrikeKind::Ground));
    }
    for x in [10, 14, 18] {
        put(&mut w, "POWR", 0, x, 4);
    }
    w.refresh_tokens();
    w.update_power();
    // Structures are placed on explored ground only.
    w.update_vision();
    w
}

fn rods(w: &World, player: u8) -> Vec<usize> {
    let t = ty(w, "LROD");
    (0..w.actors.len()).filter(|&i| w.actors[i].alive && w.actors[i].owner == player && w.actors[i].ty == t).collect()
}

#[test]
fn bots_cover_their_power_plants_with_a_rod_while_thunderstorms_can_strike() {
    let mut w = ai_world(Biome::Temperate, WeatherMode::Full);
    let plants: Vec<(i32, i32)> =
        w.actors.iter().filter(|a| a.alive && a.owner == 0 && w.rules.actors[a.ty as usize].id == "POWR").map(|a| (a.x, a.y)).collect();
    assert_eq!(plants.len(), 3);
    let rod = ty(&w, "LROD");
    let buildable: Vec<u16> = vec![rod];
    assert_eq!(crate::ai_lightning::wanted_rod(&w, 0, &buildable), Some(rod));
    // Placed where it covers every plant of the row.
    let (cx, cy) = crate::ai_lightning::rod_location(&w, 0, rod).expect("a spot");
    for &(x, y) in &plants {
        assert!(crate::math::dist(cell_center(cx), cell_center(cy), x, y) <= 6 * 1024, "covers ({x}, {y})");
    }
    // The bot builds it by itself.
    for _ in 0..25 * 90 {
        w.step();
        if !rods(&w, 0).is_empty() {
            break;
        }
    }
    assert_eq!(rods(&w, 0).len(), 1, "one rod for three plants");
    assert!(plants.iter().all(|&(x, y)| w.lightning_protected(x, y)));
    // All covered: no second one.
    assert_eq!(crate::ai_lightning::wanted_rod(&w, 0, &buildable), None);
    run(&mut w, 25 * 30);
    assert_eq!(rods(&w, 0).len(), 1);
}

#[test]
fn bots_build_no_rod_where_lightning_cannot_strike() {
    for (biome, mode) in
        [(Biome::Temperate, WeatherMode::Cosmetic), (Biome::Temperate, WeatherMode::Off), (Biome::Desert, WeatherMode::Full)]
    {
        let w = ai_world(biome, mode);
        let rod = ty(&w, "LROD");
        assert_eq!(crate::ai_lightning::wanted_rod(&w, 0, &[rod]), None, "{biome:?} {mode:?}");
    }
    // Before the first strike of the game, or with too little money.
    let mut w = ai_world(Biome::Temperate, WeatherMode::Full);
    let rod = ty(&w, "LROD");
    w.env.flash = None;
    assert_eq!(crate::ai_lightning::wanted_rod(&w, 0, &[rod]), None);
    w.env.flash = Some((0, 0, 0, StrikeKind::Ground));
    w.players[0].cash = 800;
    w.players[0].resources = 0;
    assert_eq!(crate::ai_lightning::wanted_rod(&w, 0, &[rod]), None);
}

// ---- The bolt (presentation) ------------------------------------------------------------

#[test]
fn the_bolt_shows_briefly_where_the_viewer_explored_the_ground() {
    let mut w = world();
    w.tick = 100;
    w.env.flash = Some((100, cell_center(20), cell_center(20), StrikeKind::Hit));
    let mut lines = Vec::new();
    w.build_lightning_bolt(0, 0.0, &mut lines);
    assert!(lines.is_empty(), "unexplored ground hides the bolt");
    let ci = w.map.idx(20, 20);
    w.players[0].explored[ci] = 1;
    w.build_lightning_bolt(0, 0.0, &mut lines);
    let n = lines.len() / crate::paths::LINE_FLOATS;
    assert!(n > 10, "{n} segments");
    // It ends on the struck point (world pixels) and is the same every frame.
    let end = lines.chunks(crate::paths::LINE_FLOATS).map(|l| (l[2], l[3])).fold((0.0f32, 0.0f32), |a, p| if p.1 > a.1 { p } else { a });
    let (px, py) = (crate::render::px(cell_center(20)), crate::render::px(cell_center(20)));
    assert!((end.1 - py).abs() < 40.0 && (end.0 - px).abs() < 40.0, "{end:?}");
    let mut again = Vec::new();
    w.build_lightning_bolt(0, 0.0, &mut again);
    assert_eq!(lines, again);
    // Spectators (past the players) see it; it is gone after BOLT_TICKS.
    let mut spec = Vec::new();
    w.build_lightning_bolt(9, 0.0, &mut spec);
    assert!(!spec.is_empty());
    w.tick = 100 + crate::lightning::BOLT_TICKS;
    let mut late = Vec::new();
    w.build_lightning_bolt(0, 0.0, &mut late);
    assert!(late.is_empty());
}

// ---- Missions ---------------------------------------------------------------------------

/// Campaign and co-op missions keep OpenRA's rules: no mission file carries
/// WebRA's actors, and no player of any mission may build a Lightning Rod
/// (no `global-skirmish` token), while skirmish players do.
#[test]
fn no_mission_offers_the_lightning_rod() {
    use crate::tests_mission::{load, mission_ids, missions_dir};
    let ids = mission_ids();
    assert!(ids.len() > 40, "{} missions", ids.len());
    for id in &ids {
        let text = std::fs::read_to_string(missions_dir().join(format!("{id}.json"))).expect("mission file");
        assert!(!text.contains("\"LROD\""), "{id}: WebRA actors in the mission rules");
        let w = World::from_mission(load(id), 7, &Default::default()).unwrap_or_else(|e| panic!("{id}: {e}"));
        let rod = ty(&w, "LROD");
        for p in 0..w.players.len() as u8 {
            assert!(!w.can_start(p, rod), "{id}: player {p} can build a Lightning Rod");
            assert!(!w.availability(p, rod).visible, "{id}: player {p} sees the Lightning Rod");
        }
    }
    let mut w = world();
    building(&mut w, "POWR", 0, 10, 10);
    w.refresh_tokens();
    assert!(w.can_start(0, ty(&w, "LROD")), "skirmish players build it");
}

/// What the bot queues in its Building queue over `ticks`, by id.
fn queued_buildings(w: &mut World, ticks: i32) -> Vec<String> {
    let mut seen = Vec::new();
    for _ in 0..ticks {
        w.step();
        if let Some(it) = w.players[0].queues[QueueType::Building as usize].items.first() {
            let id = w.rules.actors[it.ty as usize].id.clone();
            if !seen.contains(&id) {
                seen.push(id);
            }
        }
    }
    seen
}

#[test]
fn bots_look_through_a_lightning_blackout_but_not_a_spys() {
    // Lightning: the plants stand intact, so no power plant is bought; the rod comes first.
    let mut w = ai_world(Biome::Temperate, WeatherMode::Full);
    // As World::step resolves it: at the start of the next tick, before the bot thinks.
    w.tick += 1;
    w.strike_lightning(strike(60, 60, 0, 0));
    assert!(w.power_outage(0) > 0 && w.lightning_blackout(0));
    w.tick -= 1;
    let gen = crate::ai_lightning::power_gen(&w, 0);
    w.update_power();
    assert_eq!(w.players[0].power_gen, 0);
    assert!(gen > 0, "the bot counts its intact plants");
    let seen = queued_buildings(&mut w, OUTAGE_TICKS);
    assert!(!seen.iter().any(|id| id == "POWR" || id == "APWR"), "{seen:?}");
    assert!(
        w.players[0].queues[QueueType::Defense as usize].items.iter().any(|it| w.rules.actors[it.ty as usize].id == "LROD")
            || !rods(&w, 0).is_empty()
    );
    // A spy's outage is what OpenRA's bots see as low power: they buy power.
    let mut w = ai_world(Biome::Temperate, WeatherMode::Off);
    w.inf.outage.resize(w.players.len(), (0, 0));
    w.inf.outage[0] = (500, 500);
    assert!(!w.lightning_blackout(0));
    let seen = queued_buildings(&mut w, 500);
    assert!(seen.first().is_some_and(|id| id == "POWR" || id == "APWR"), "{seen:?}");
}

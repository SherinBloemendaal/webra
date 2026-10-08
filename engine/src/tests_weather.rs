//! Biomes and weather in the simulation (weather.rs): snow momentum, ice,
//! desert heat, weather sight, determinism, cosmetic mode, and AI games that
//! still finish in every biome.

use crate::map::{Map, Terrain};
use crate::math::{dist, CELL};
use crate::rules::Rules;
use crate::weather::{Biome, Environment, Weather, WeatherMode, HEAT_MAX, OVERHEAT_RELOAD_PCT};
use crate::world::{cell_center, AiDifficulty, GameOptions, Order, PlayerSetup, World};

const SIZE: i32 = 48;

/// A flat 48x48 field of `ground` with two passive players and the given sky.
fn field(biome: Biome, mode: WeatherMode, ground: Terrain) -> World {
    let mut map = Map::filled(SIZE, SIZE, ground);
    map.spawns = vec![(2, 2), (40, 40)];
    let mut w = World::empty(Rules::load(), map, 5);
    for (f, start) in [("allies", (2, 2)), ("soviet", (40, 40))] {
        let fi = w.rules.faction_index(f).unwrap();
        w.add_player(fi, false, start);
    }
    w.env = Environment::new(biome, mode, 5);
    w.refresh_tokens();
    w.update_power();
    w.update_vision();
    w
}

/// Keep one weather for the rest of the test.
fn force(w: &mut World, weather: Weather) {
    w.env.weather = weather;
    w.env.until = u32::MAX;
}

fn unit(w: &mut World, id: &str, owner: u8, cx: i32, cy: i32, facing: i32) -> usize {
    let t = w.rules.actor_index(id).unwrap() as u16;
    w.spawn_unit(t, owner, cell_center(cx), cell_center(cy), facing)
}

fn order_move(w: &mut World, i: usize, cx: i32, cy: i32) {
    let r = w.make_ref(i);
    w.queue_order(Order::Move { player: w.actors[i].owner, ids: vec![r], x: cell_center(cx), y: cell_center(cy), attack_move: false });
}

fn stop(w: &mut World, i: usize) {
    let r = w.make_ref(i);
    w.queue_order(Order::Stop { player: w.actors[i].owner, ids: vec![r] });
}

fn run(w: &mut World, ticks: u32) {
    for _ in 0..ticks {
        w.step();
    }
}

/// Distance a tank drives east in `ticks`, then how far it goes on after a stop order.
fn drive_and_stop(biome: Biome, mode: WeatherMode, ground: Terrain, ticks: u32) -> (i32, i32) {
    let mut w = field(biome, mode, ground);
    let t = unit(&mut w, "1TNK", 0, 4, 24, 256);
    let x0 = w.actors[t].x;
    order_move(&mut w, t, 44, 24);
    run(&mut w, ticks);
    let driven = w.actors[t].x - x0;
    stop(&mut w, t);
    let x1 = w.actors[t].x;
    run(&mut w, 40);
    (driven, w.actors[t].x - x1)
}

#[test]
fn snow_vehicles_build_up_speed_and_coast_after_stopping() {
    let (temperate, temperate_coast) = drive_and_stop(Biome::Temperate, WeatherMode::Full, Terrain::Clear, 6);
    let (snow, snow_coast) = drive_and_stop(Biome::Snow, WeatherMode::Full, Terrain::Clear, 6);
    assert!(snow < temperate * 3 / 4, "snow start {snow} vs {temperate}");
    // A stop order ends the move on the next tick; on snow the tank slides on a little.
    assert!(temperate_coast <= 113, "temperate stops at once: {temperate_coast}");
    let (_, snow_coast_full) = drive_and_stop(Biome::Snow, WeatherMode::Full, Terrain::Clear, 40);
    assert!(snow_coast_full > 113 + 200 && snow_coast_full < CELL, "snow coast {snow_coast_full}");
    assert!(snow_coast <= snow_coast_full);
    // At full speed it is as fast as anywhere else.
    let (temperate_long, _) = drive_and_stop(Biome::Temperate, WeatherMode::Full, Terrain::Clear, 120);
    let (snow_long, _) = drive_and_stop(Biome::Snow, WeatherMode::Full, Terrain::Clear, 120);
    assert!(snow_long * 100 >= temperate_long * 90, "snow cruise {snow_long} vs {temperate_long}");
}

#[test]
fn ice_is_slipperier_than_snow() {
    let (_, snow) = drive_and_stop(Biome::Snow, WeatherMode::Full, Terrain::Clear, 60);
    let (_, ice) = drive_and_stop(Biome::Snow, WeatherMode::Full, Terrain::Rough, 60);
    // Rough ground halves wheeled speeds, not the tank's (88 %): the slide still has to be longer.
    assert!(ice > snow, "ice coast {ice} vs snow {snow}");
    assert!(ice < 2 * CELL, "ice coast stays short: {ice}");
    // Rough ground elsewhere is just rough ground.
    let (_, rough) = drive_and_stop(Biome::Temperate, WeatherMode::Full, Terrain::Rough, 60);
    assert!(rough <= 113, "{rough}");
}

#[test]
fn snow_slows_infantry_a_little() {
    let walk = |biome: Biome| {
        let mut w = field(biome, WeatherMode::Full, Terrain::Clear);
        let e = unit(&mut w, "E1", 0, 4, 24, 256);
        let x0 = w.actors[e].x;
        order_move(&mut w, e, 44, 24);
        run(&mut w, 100);
        w.actors[e].x - x0
    };
    let (temperate, snow) = (walk(Biome::Temperate), walk(Biome::Snow));
    assert!(snow * 100 >= temperate * 88 && snow * 100 <= temperate * 92, "infantry on snow {snow} vs {temperate}");
}

#[test]
fn snow_vehicles_still_arrive_where_they_were_sent() {
    let mut w = field(Biome::Snow, WeatherMode::Full, Terrain::Rough);
    let t = unit(&mut w, "1TNK", 0, 4, 4, 512);
    // A dog leg: east, then a hard turn south.
    order_move(&mut w, t, 30, 6);
    run(&mut w, 200);
    order_move(&mut w, t, 30, 40);
    run(&mut w, 800);
    let a = &w.actors[t];
    assert!(dist(a.x, a.y, cell_center(30), cell_center(40)) < 2 * CELL, "ended at {},{}", a.x / CELL, a.y / CELL);
    assert_eq!(a.activity, crate::world::Activity::Idle);
    assert_eq!(a.env.vel, 0, "came to rest");
}

#[test]
fn cosmetic_weather_changes_nothing_in_the_simulation() {
    let trace = |biome: Biome, mode: WeatherMode, weather: Option<Weather>| {
        let mut w = field(biome, mode, Terrain::Rough);
        if let Some(wx) = weather {
            force(&mut w, wx);
        }
        let t = unit(&mut w, "1TNK", 0, 4, 24, 256);
        let e = unit(&mut w, "E1", 0, 4, 28, 256);
        order_move(&mut w, t, 40, 24);
        order_move(&mut w, e, 40, 28);
        let mut out = Vec::new();
        for _ in 0..300 {
            w.step();
            out.push((w.actors[t].x, w.actors[t].y, w.actors[e].x, w.actors[t].env.heat));
            out.push((w.players[0].visible.iter().filter(|&&v| v != 0).count() as i32, 0, 0, 0));
        }
        out
    };
    let plain = trace(Biome::Temperate, WeatherMode::Off, None);
    assert_eq!(trace(Biome::Snow, WeatherMode::Cosmetic, Some(Weather::Snowfall)), plain, "cosmetic snow");
    assert_eq!(trace(Biome::Desert, WeatherMode::Cosmetic, Some(Weather::HeatWave)), plain, "cosmetic heat wave");
    assert_eq!(trace(Biome::Desert, WeatherMode::Cosmetic, Some(Weather::Sandstorm)), plain, "cosmetic sandstorm");
    assert_ne!(trace(Biome::Snow, WeatherMode::Full, None), plain, "full snow does change things");
}

#[test]
fn heat_waves_overheat_vehicles_that_keep_driving_and_idle_cools_them() {
    let mut w = field(Biome::Desert, WeatherMode::Full, Terrain::Clear);
    force(&mut w, Weather::HeatWave);
    let t = unit(&mut w, "1TNK", 0, 4, 24, 256);
    let step_len = |w: &mut World| {
        let x = w.actors[t].x;
        w.step();
        (w.actors[t].x - x).abs()
    };
    order_move(&mut w, t, 44, 24);
    run(&mut w, 20);
    let cool_speed = step_len(&mut w);
    // Drive back and forth until it overheats: 20 seconds of driving.
    let mut ticks = 21;
    while !w.actors[t].env.overheated {
        if w.actors[t].activity == crate::world::Activity::Idle {
            let back = if w.actors[t].x > 24 * CELL { 4 } else { 44 };
            order_move(&mut w, t, back, 24);
        }
        w.step();
        ticks += 1;
        assert!(ticks < 900, "never overheated, heat {}", w.actors[t].env.heat);
    }
    assert!(ticks >= 480, "overheated after {ticks} ticks");
    // Once it has turned around, it crawls (and stays hot while it drives).
    let back = if w.actors[t].x > 24 * CELL { 2 } else { 46 };
    order_move(&mut w, t, back, 24);
    run(&mut w, 40);
    assert!(w.actors[t].env.overheated);
    let hot_speed = step_len(&mut w);
    assert_eq!(hot_speed, cool_speed * 75 / 100, "overheated speed");
    stop(&mut w, t);
    run(&mut w, 2);
    let mut cool = 0;
    while w.actors[t].env.overheated {
        w.step();
        cool += 1;
        assert!(cool < 200, "still hot");
    }
    assert!((100..=130).contains(&cool), "cooled in {cool} ticks");
    assert!(w.actors[t].env.heat <= 400 && w.actors[t].env.heat > 0);
}

#[test]
fn overheated_vehicles_fire_slower() {
    let reload_after_shot = |hot: bool| {
        let mut w = field(Biome::Desert, WeatherMode::Full, Terrain::Clear);
        force(&mut w, Weather::HeatWave);
        let t = unit(&mut w, "1TNK", 0, 20, 24, 256);
        let target = unit(&mut w, "2TNK", 1, 23, 24, 768);
        w.actors[t].env.overheated = hot;
        w.actors[t].env.heat = if hot { HEAT_MAX } else { 0 };
        let r = w.make_ref(target);
        w.queue_order(Order::Attack { player: 0, ids: vec![w.make_ref(t)], target: r });
        for _ in 0..100 {
            w.step();
            // The reload is set when the shot leaves and counts down from the next tick.
            if w.actors[t].reload[0] > 0 {
                break;
            }
        }
        assert_eq!(w.actors[t].env.overheated, hot);
        w.actors[t].reload[0]
    };
    let (cool, hot) = (reload_after_shot(false), reload_after_shot(true));
    assert!(cool > 0);
    assert!((hot - cool * OVERHEAT_RELOAD_PCT / 100).abs() <= 1, "reload hot {hot} cool {cool}");
}

#[test]
fn weather_shortens_sight() {
    let seen = |mode: WeatherMode, weather: Weather| {
        let mut w = field(Biome::Desert, mode, Terrain::Clear);
        force(&mut w, weather);
        unit(&mut w, "1TNK", 0, 24, 24, 0);
        w.step();
        w.step();
        w.players[0].visible.iter().filter(|&&v| v != 0).count()
    };
    let clear = seen(WeatherMode::Full, Weather::Clear);
    let sand = seen(WeatherMode::Full, Weather::Sandstorm);
    assert!(sand < clear * 3 / 4, "sandstorm {sand} vs clear {clear}");
    assert_eq!(seen(WeatherMode::Cosmetic, Weather::Sandstorm), clear);
    assert_eq!(seen(WeatherMode::Full, Weather::HeatWave), clear, "heat does not blind");
}

fn ai_game(seed: u64, biome: Biome, weather: WeatherMode, minutes: u32) -> World {
    let players = [PlayerSetup::new("england", Some(AiDifficulty::Normal)), PlayerSetup::new("russia", Some(AiDifficulty::Normal))];
    let options = GameOptions { biome: Some(biome), weather, ..GameOptions::default() };
    let mut w = World::with_options(seed, 96, &players, options);
    for _ in 0..25 * 60 * minutes {
        w.step();
        if w.winner.is_some() {
            break;
        }
    }
    w
}

#[test]
fn same_seed_same_weather_on_every_peer() {
    let mut a = World::with_options(
        8,
        64,
        &[PlayerSetup::new("allies", Some(AiDifficulty::Normal)), PlayerSetup::new("soviet", Some(AiDifficulty::Normal))],
        GameOptions { biome: Some(Biome::Desert), ..GameOptions::default() },
    );
    let mut b = World::with_options(
        8,
        64,
        &[PlayerSetup::new("allies", Some(AiDifficulty::Normal)), PlayerSetup::new("soviet", Some(AiDifficulty::Normal))],
        GameOptions { biome: Some(Biome::Desert), ..GameOptions::default() },
    );
    let mut changes = 0;
    let mut last = Weather::Clear;
    for t in 0..25 * 60 * 9 {
        a.step();
        b.step();
        assert_eq!(a.env.weather, b.env.weather);
        if a.env.weather != last {
            changes += 1;
            last = a.env.weather;
        }
        if t % 500 == 0 {
            assert_eq!(a.state_hash(), b.state_hash(), "tick {t}");
        }
    }
    assert!(changes >= 2, "weather changed {changes} times");
    assert_eq!(a.state_hash(), b.state_hash());
}

/// The AI keeps playing in every biome with full weather: harvesters on
/// snow do not slide off their ore, overheated tanks rest and rejoin, and
/// the games end.
#[test]
fn ai_games_finish_in_every_biome() {
    let games: Vec<(u64, Biome)> = vec![(1, Biome::Snow), (2, Biome::Snow), (3, Biome::Desert), (4, Biome::Desert), (5, Biome::Temperate)];
    let results: Vec<(u64, Biome, Option<u8>, u32, i32)> = std::thread::scope(|s| {
        let handles: Vec<_> = games
            .iter()
            .map(|&(seed, biome)| {
                s.spawn(move || {
                    let w = ai_game(seed, biome, WeatherMode::Full, 40);
                    let hot = w.actors.iter().filter(|a| a.alive).map(|a| a.env.heat).max().unwrap_or(0);
                    (seed, biome, w.winner, w.tick, hot)
                })
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });
    for (seed, biome, winner, ticks, _) in &results {
        assert!(winner.is_some(), "{biome:?} seed {seed}: no winner after {} minutes", ticks / 1500);
    }
}

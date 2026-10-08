//! Headless AI vs AI match.
//! Usage: cargo run -p webra-sim --release --example ai_vs_ai -- [seed] [faction0] [faction1]
//! Environment: AI_STYLE (random, land, rivers, lakes, islands), AI_BIOME
//! (random, temperate, snow, desert), AI_WEATHER (full, cosmetic, off);
//! defaults random, temperate, full (the engine defaults).
use webra_sim::mapgen::MapStyle;
use webra_sim::rules::Kind;
use webra_sim::weather::{Biome, WeatherMode};
use webra_sim::world::{AiDifficulty, GameOptions, PlayerSetup, World};

fn main() {
    let seed: u64 = std::env::args().nth(1).map(|s| s.parse().expect("seed is a number")).unwrap_or(13);
    let f0 = std::env::args().nth(2).unwrap_or_else(|| "allies".into());
    let f1 = std::env::args().nth(3).unwrap_or_else(|| "soviet".into());
    let var = |k: &str, d: &str| std::env::var(k).unwrap_or_else(|_| d.into());
    let biome = var("AI_BIOME", "temperate");
    let options = GameOptions {
        map_style: MapStyle::from_name(&var("AI_STYLE", "random")).expect("AI_STYLE"),
        biome: if biome == "random" { None } else { Some(Biome::from_name(&biome).expect("AI_BIOME")) },
        weather: WeatherMode::from_name(&var("AI_WEATHER", "full")).expect("AI_WEATHER"),
        ..GameOptions::default()
    };
    let players = [PlayerSetup::new(&f0, Some(AiDifficulty::Normal)), PlayerSetup::new(&f1, Some(AiDifficulty::Normal))];
    let mut w = World::with_options(seed, 80, &players, options);
    let t0 = std::time::Instant::now();
    for t in 0..(25 * 60 * 20) {
        w.step();
        if t % 1500 == 0 {
            for p in 0..2u8 {
                let b = w.actors.iter().filter(|a| a.alive && a.owner == p && a.kind == Kind::Building).count();
                let u = w.actors.iter().filter(|a| a.alive && a.owner == p && a.kind != Kind::Building).count();
                println!(
                    "{:>3}:{:02} player {p}: funds {:>5}, {b:>2} buildings, {u:>3} units, {} lost",
                    t / 1500,
                    (t / 25) % 60,
                    w.players[p as usize].funds(),
                    w.losses[p as usize]
                );
            }
        }
        if let Some(winner) = w.winner {
            println!("winner: player {winner} after {}:{:02} game time", t / 1500, (t / 25) % 60);
            break;
        }
    }
    println!("simulated in {:.2?}", t0.elapsed());
}

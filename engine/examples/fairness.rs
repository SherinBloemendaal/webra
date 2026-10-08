//! Mirror matches over many seeds: counts how often each slot wins.
//! Usage: cargo run -p webra-sim --release --example fairness -- [seeds] [faction] [map size] [first seed]
//! Environment: FAIR_STYLE (random, land, rivers, lakes, islands), FAIR_BIOME
//! (random, temperate, snow, desert), FAIR_WEATHER (full, cosmetic, off);
//! defaults random, temperate, full.
use webra_sim::mapgen::MapStyle;
use webra_sim::weather::{Biome, WeatherMode};
use webra_sim::world::{AiDifficulty, GameOptions, PlayerSetup, World};

fn main() {
    let seeds: u64 = std::env::args().nth(1).map(|s| s.parse().expect("seeds is a number")).unwrap_or(10);
    let f = std::env::args().nth(2).unwrap_or_else(|| "allies".into());
    let size: i32 = std::env::args().nth(3).map(|s| s.parse().expect("size is a number")).unwrap_or(80);
    let first: u64 = std::env::args().nth(4).map(|s| s.parse().expect("first seed is a number")).unwrap_or(0);
    let mut wins = [0u32; 3];
    for seed in first..first + seeds {
        let var = |k: &str, d: &str| std::env::var(k).unwrap_or_else(|_| d.into());
        let biome = var("FAIR_BIOME", "temperate");
        let options = GameOptions {
            map_style: MapStyle::from_name(&var("FAIR_STYLE", "random")).expect("FAIR_STYLE"),
            biome: if biome == "random" { None } else { Some(Biome::from_name(&biome).expect("FAIR_BIOME")) },
            weather: WeatherMode::from_name(&var("FAIR_WEATHER", "full")).expect("FAIR_WEATHER"),
            ..GameOptions::default()
        };
        let players = [PlayerSetup::new(&f, Some(AiDifficulty::Normal)), PlayerSetup::new(&f, Some(AiDifficulty::Normal))];
        let mut w = World::with_options(seed, size, &players, options);
        let mut t = 0;
        while w.winner.is_none() && t < 25 * 60 * 25 {
            w.step();
            t += 1;
        }
        let slot = w.winner.map_or(2, |p| p as usize);
        wins[slot] += 1;
        println!(
            "seed {seed:>3}: winner {} after {}:{:02}, losses {:?}",
            w.winner.map_or("none".into(), |p| p.to_string()),
            t / 1500,
            (t / 25) % 60,
            w.losses
        );
    }
    println!("slot 0: {}, slot 1: {}, undecided: {}", wins[0], wins[1], wins[2]);
}

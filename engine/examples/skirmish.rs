//! Headless AI skirmish with 2..8 players and optional teams.
//! Usage: cargo run -p webra-sim --release --example skirmish -- [seed] [map size] [teams, e.g. 1122 or 0000] [minutes]
use webra_sim::world::{AiDifficulty, GameOptions, PlayerSetup, World};

fn main() {
    let seed: u64 = std::env::args().nth(1).map(|s| s.parse().expect("seed is a number")).unwrap_or(1);
    let size: i32 = std::env::args().nth(2).map(|s| s.parse().expect("size is a number")).unwrap_or(96);
    let teams = std::env::args().nth(3).unwrap_or_else(|| "0000".into());
    let minutes: u32 = std::env::args().nth(4).map(|s| s.parse().expect("minutes is a number")).unwrap_or(40);
    let factions = ["england", "russia", "germany", "ukraine", "france", "soviet", "allies", "russia"];
    let players: Vec<PlayerSetup> = teams
        .chars()
        .enumerate()
        .map(|(k, c)| PlayerSetup {
            faction: factions[k % 8].into(),
            ai: Some(AiDifficulty::Normal),
            bot: Default::default(),
            team: c.to_digit(10).expect("team digit") as u8,
            handicap: 0,
            spawn: None,
        })
        .collect();
    let mut w = World::with_options(seed, size, &players, GameOptions::default());
    let mut t = 0;
    while w.winner.is_none() && t < 25 * 60 * minutes {
        w.step();
        t += 1;
        if t % (25 * 60 * 5) == 0 {
            let alive: Vec<usize> = (0..players.len()).map(|p| w.actors.iter().filter(|a| a.alive && a.owner == p as u8).count()).collect();
            let targets: Vec<Option<u8>> = w.ai.iter().map(|a| a.target_player).collect();
            println!("{:>2} min: actors {alive:?}, targets {targets:?}", t / 1500);
        }
    }
    let won: Vec<u8> = (0..players.len() as u8).filter(|&p| w.has_won(p)).collect();
    println!("winners {won:?} after {}:{:02}, losses {:?}", t / 1500, (t / 25) % 60, w.losses);
}

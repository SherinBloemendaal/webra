//! N-player fairness probe: identical Normal AIs on generated maps, many seeds.
//! Prints per spawn slot (FFA) or per team (team games) how often it won and
//! how it placed, so map layouts can be compared before and after a change.
//!
//! Usage: cargo run -p webra-sim --release --example fairness_n -- [teams] [seeds] [map size] [faction]
//! Environment: FAIR_STYLE (random, land, rivers, lakes, islands), FAIR_BIOME
//! (random, temperate, snow, desert), FAIR_WEATHER (full, cosmetic, off);
//! defaults random, temperate, full.
//! `teams` is one digit per player: `0000` is a 4-player free for all, `1122`
//! and `1212` are 2v2 games, `000` three players, `00000000` eight.
//! Placement points: a player gets one point for every opponent eliminated
//! before it (the winner gets N - 1); at the time limit the survivors share
//! the remaining places by the value of what they still own.
use webra_sim::mapgen::MapStyle;
use webra_sim::weather::{Biome, WeatherMode};
use webra_sim::world::{AiDifficulty, GameOptions, PlayerSetup, World};

/// Map style, biome and weather from FAIR_STYLE, FAIR_BIOME and FAIR_WEATHER.
fn env_options() -> GameOptions {
    let var = |k: &str, d: &str| std::env::var(k).unwrap_or_else(|_| d.into());
    let biome = var("FAIR_BIOME", "temperate");
    GameOptions {
        map_style: MapStyle::from_name(&var("FAIR_STYLE", "random")).expect("FAIR_STYLE"),
        biome: if biome == "random" { None } else { Some(Biome::from_name(&biome).expect("FAIR_BIOME")) },
        weather: WeatherMode::from_name(&var("FAIR_WEATHER", "full")).expect("FAIR_WEATHER"),
        ..GameOptions::default()
    }
}

const LIMIT: u32 = 25 * 60 * 40;

struct Outcome {
    /// Placement points per slot.
    points: Vec<u32>,
    /// Winning slots (empty when undecided).
    winners: Vec<u8>,
    ticks: u32,
}

fn play(seed: u64, size: i32, teams: &[u8], faction: &str) -> Outcome {
    let players: Vec<PlayerSetup> = teams
        .iter()
        .map(|&team| PlayerSetup { faction: faction.into(), ai: Some(AiDifficulty::Normal), bot: Default::default(), team, handicap: 0 })
        .collect();
    let n = players.len();
    let mut w = World::with_options(seed, size, &players, env_options());
    let mut out_at: Vec<Option<u32>> = vec![None; n];
    let verbose = std::env::var("FAIR_VERBOSE").is_ok();
    let mut t = 0;
    while w.winner.is_none() && t < LIMIT {
        w.step();
        t += 1;
        if verbose && t % 1500 == 0 {
            let alive: Vec<usize> = (0..n).map(|p| w.actors.iter().filter(|a| a.alive && a.owner == p as u8).count()).collect();
            let targets: Vec<Option<u8>> = w.ai.iter().map(|a| a.target_player).collect();
            let hot = w.actors.iter().filter(|a| a.alive && a.env.overheated).count();
            println!(
                "{:>2} min: actors {alive:?}, targets {targets:?}, losses {:?}, weather {}, overheated {hot}",
                t / 1500,
                w.losses,
                w.env.weather.name()
            );
        }
        if t % 25 == 0 {
            for (out, player) in out_at.iter_mut().zip(&w.players) {
                if out.is_none() && player.defeated {
                    *out = Some(t);
                }
            }
        }
    }
    if verbose {
        for p in 0..n {
            let mut owned: Vec<String> = w
                .actors
                .iter()
                .filter(|a| a.alive && a.owner as usize == p)
                .map(|a| format!("{}@{},{}", w.rules.actors[a.ty as usize].id, a.x / 1024, a.y / 1024))
                .collect();
            owned.truncate(12);
            println!("player {p} left with {owned:?}, funds {}", w.players[p].funds());
        }
    }
    // Rank: later elimination is better; survivors by owned value.
    let value = |p: usize| -> i64 {
        w.actors.iter().filter(|a| a.alive && a.owner as usize == p).map(|a| w.rules.actors[a.ty as usize].cost as i64).sum()
    };
    let mut order: Vec<(u32, i64, usize)> =
        (0..n).map(|p| (out_at[p].unwrap_or(u32::MAX), if out_at[p].is_none() { value(p) } else { 0 }, p)).collect();
    order.sort();
    let mut points = vec![0u32; n];
    for (rank, &(_, _, p)) in order.iter().enumerate() {
        points[p] = rank as u32;
    }
    let winners: Vec<u8> = (0..n as u8).filter(|&p| w.winner.is_some() && w.has_won(p)).collect();
    Outcome { points, winners, ticks: t }
}

fn main() {
    let teams_arg = std::env::args().nth(1).unwrap_or_else(|| "0000".into());
    let seeds: u64 = std::env::args().nth(2).map(|s| s.parse().expect("seeds is a number")).unwrap_or(16);
    // FAIR_SEED plays that one seed only (handy with FAIR_VERBOSE); FAIR_FIRST
    // starts the seeds there instead of at 0 (a fresh sample).
    let only: Option<u64> = std::env::var("FAIR_SEED").ok().map(|s| s.parse().expect("FAIR_SEED is a number"));
    let first: u64 = std::env::var("FAIR_FIRST").ok().map_or(0, |s| s.parse().expect("FAIR_FIRST is a number"));
    let teams: Vec<u8> = teams_arg.chars().map(|c| c.to_digit(10).expect("team digit") as u8).collect();
    let n = teams.len();
    let default_size = if n <= 4 { 96 } else { 128 };
    let size: i32 = std::env::args().nth(3).map(|s| s.parse().expect("size is a number")).unwrap_or(default_size);
    let faction = std::env::args().nth(4).unwrap_or_else(|| "allies".into());
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).min(6);

    let results: Vec<(u64, Outcome)> = std::thread::scope(|s| {
        let handles: Vec<_> = (0..threads as u64)
            .map(|k| {
                let (teams, faction) = (&teams, faction.as_str());
                s.spawn(move || {
                    (first..first + seeds)
                        .filter(|seed| seed % threads as u64 == k && only.is_none_or(|o| o == *seed))
                        .map(|seed| (seed, play(seed, size, teams, faction)))
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        let mut all: Vec<(u64, Outcome)> = handles.into_iter().flat_map(|h| h.join().unwrap()).collect();
        all.sort_by_key(|r| r.0);
        all
    });

    let mut wins = vec![0u32; n];
    let mut points = vec![0u32; n];
    let mut undecided = 0;
    let mut total_ticks = 0u64;
    for (seed, o) in &results {
        println!("seed {seed:>3}: winners {:?} after {}:{:02}, points {:?}", o.winners, o.ticks / 1500, (o.ticks / 25) % 60, o.points);
        if o.winners.is_empty() {
            undecided += 1;
        }
        for &p in &o.winners {
            wins[p as usize] += 1;
        }
        for (total, &p) in points.iter_mut().zip(&o.points) {
            *total += p;
        }
        total_ticks += o.ticks as u64;
    }
    println!(
        "map {size}x{size}, teams {teams_arg}, faction {faction}, style {}, biome {}, weather {}, {seeds} seeds, mean length {} min",
        std::env::var("FAIR_STYLE").unwrap_or_else(|_| "random".into()),
        std::env::var("FAIR_BIOME").unwrap_or_else(|_| "temperate".into()),
        std::env::var("FAIR_WEATHER").unwrap_or_else(|_| "full".into()),
        total_ticks / seeds.max(1) / 1500
    );
    for p in 0..n {
        println!(
            "slot {p} (team {}): wins {:>3}, mean placement points {:.2} of {}",
            teams[p],
            wins[p],
            points[p] as f64 / seeds.max(1) as f64,
            n - 1
        );
    }
    let mut team_ids: Vec<u8> = teams.iter().copied().filter(|&t| t != 0).collect();
    team_ids.sort_unstable();
    team_ids.dedup();
    for t in team_ids {
        // A team win counts once per game.
        let team_wins = results.iter().filter(|(_, o)| o.winners.iter().any(|&p| teams[p as usize] == t)).count();
        println!("team {t}: wins {team_wins}");
    }
    println!("undecided: {undecided}");
}

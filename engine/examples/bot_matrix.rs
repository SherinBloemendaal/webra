//! Bot type pairings (ai_bots.rs): every pairing of Rush, Normal, Turtle and
//! Naval AI plays 1v1 on generated maps over a range of seeds; prints the
//! win split and game lengths per pairing.
//! Usage: cargo run -p webra-sim --release --example bot_matrix -- [seeds] [max minutes] [difficulty] [map size] [difficulty of the second bot]
//! Environment: AI_STYLE (random, land, rivers, lakes, islands), BOTS (comma
//! separated subset, e.g. "normal,rush").
//! Seed k puts the first bot of the pairing in slot k % 2, so both bots play
//! both spawns; factions alternate between Allies and Soviets the same way.
use webra_sim::ai_bots::BotType;
use webra_sim::mapgen::MapStyle;
use webra_sim::world::{AiDifficulty, GameOptions, PlayerSetup, World};

struct Game {
    /// Winner as an index into the pairing (0: first bot, 1: second), or None.
    winner: Option<usize>,
    minutes: f64,
}

fn play(a: BotType, b: BotType, seed: u64, minutes: u32, diffs: [AiDifficulty; 2], size: i32, style: MapStyle) -> Game {
    let swap = seed % 2 == 1;
    let bots = if swap { [b, a] } else { [a, b] };
    let diffs = if swap { [diffs[1], diffs[0]] } else { diffs };
    let factions = if (seed / 2).is_multiple_of(2) { ["allies", "soviet"] } else { ["soviet", "allies"] };
    let players: Vec<PlayerSetup> = (0..2).map(|k| PlayerSetup { bot: bots[k], ..PlayerSetup::new(factions[k], Some(diffs[k])) }).collect();
    let options = GameOptions { map_style: style, ..GameOptions::default() };
    let mut w = World::with_options(seed, size, &players, options);
    for _ in 0..25 * 60 * minutes {
        w.step();
        if w.winner.is_some() {
            break;
        }
    }
    let winner = w.winner.map(|p| if (p == 1) != swap { 1 } else { 0 });
    Game { winner, minutes: w.tick as f64 / 1500.0 }
}

fn main() {
    let arg = |k: usize| std::env::args().nth(k);
    let seeds: u64 = arg(1).map(|s| s.parse().expect("seeds")).unwrap_or(16);
    let minutes: u32 = arg(2).map(|s| s.parse().expect("minutes")).unwrap_or(60);
    let level = |s: Option<String>| match s.as_deref() {
        Some("easy") => AiDifficulty::Easy,
        Some("hard") => AiDifficulty::Hard,
        _ => AiDifficulty::Normal,
    };
    let difficulty = level(arg(3));
    let second = if arg(5).is_some() { level(arg(5)) } else { difficulty };
    let size: i32 = arg(4).map(|s| s.parse().expect("size")).unwrap_or(80);
    let style = MapStyle::from_name(&std::env::var("AI_STYLE").unwrap_or_else(|_| "random".into())).expect("AI_STYLE");
    let bots: Vec<BotType> = match std::env::var("BOTS") {
        Ok(list) => list.split(',').map(|b| BotType::from_name(b.trim()).expect("BOTS")).collect(),
        Err(_) => BotType::ALL.to_vec(),
    };
    let mut pairings = Vec::new();
    for i in 0..bots.len() {
        for j in i..bots.len() {
            pairings.push((bots[i], bots[j]));
        }
    }
    println!("{seeds} seeds per pairing, {minutes} minutes at most, {difficulty:?} against {second:?}, map {size}, style {style:?}");
    for (a, b) in pairings {
        let games: Vec<Game> = std::thread::scope(|s| {
            let handles: Vec<_> =
                (0..seeds).map(|seed| s.spawn(move || play(a, b, seed, minutes, [difficulty, second], size, style))).collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });
        let wins = |k: usize| games.iter().filter(|g| g.winner == Some(k)).count();
        let open = games.iter().filter(|g| g.winner.is_none()).count();
        let mut lengths: Vec<f64> = games.iter().filter(|g| g.winner.is_some()).map(|g| g.minutes).collect();
        lengths.sort_by(|x, y| x.partial_cmp(y).unwrap());
        let mean = if lengths.is_empty() { 0.0 } else { lengths.iter().sum::<f64>() / lengths.len() as f64 };
        let median = lengths.get(lengths.len() / 2).copied().unwrap_or(0.0);
        let max = lengths.last().copied().unwrap_or(0.0);
        let unfinished: Vec<String> =
            (0..seeds).filter(|&k| games[k as usize].winner.is_none()).map(|k| format!("{k}:{}", style.resolve(k).name())).collect();
        println!(
            "{:>6} vs {:<6}: {:>2}-{:<2} ({} unfinished {:?}), minutes mean {:.1}, median {:.1}, max {:.1}",
            a.name(),
            b.name(),
            wins(0),
            wins(1),
            open,
            unfinished,
            mean,
            median,
            max
        );
    }
}

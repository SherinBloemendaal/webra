//! Naval squads of the bots on generated naval maps: per game the largest
//! naval squad, the share of ship time spent idle without a target, ships
//! built and lost, naval attacks started, the share of ship time spent
//! attacking, game length and winner.
//! Usage: cargo run -p webra-sim --release --example naval_probe -- [seeds] [max minutes] [map size]
//! Environment: STYLES (comma separated, default "islands,lakes,rivers"),
//! BOTS (comma separated, default all four; each plays a mirror match),
//! PLAYERS (bots per game, default 2: a free for all above that).
//! Seed k swaps the factions the same way as examples/bot_matrix.rs.
use std::collections::HashSet;
use webra_sim::ai_bots::BotType;
use webra_sim::mapgen::MapStyle;
use webra_sim::rules::Kind;
use webra_sim::world::{Activity, AiDifficulty, GameOptions, PlayerSetup, World};

#[derive(Default, Clone)]
struct Fleet {
    largest: usize,
    /// Ship ticks in a naval squad, and of those idle without a target.
    squad_ticks: u64,
    idle_ticks: u64,
    built: usize,
    lost: usize,
    attacks: u32,
    /// Ship ticks, and of those spent attacking something.
    ship_ticks: u64,
    firing_ticks: u64,
}

struct Game {
    style: MapStyle,
    seed: u64,
    bot: BotType,
    fleets: Vec<Fleet>,
    winner: Option<u8>,
    minutes: f64,
}

fn play(style: MapStyle, seed: u64, bot: BotType, minutes: u32, size: i32, n: usize) -> Game {
    let factions = if (seed / 2).is_multiple_of(2) { ["allies", "soviet"] } else { ["soviet", "allies"] };
    let players: Vec<PlayerSetup> =
        (0..n).map(|k| PlayerSetup { bot, ..PlayerSetup::new(factions[k % 2], Some(AiDifficulty::Normal)) }).collect();
    let mut w = World::with_options(seed, size, &players, GameOptions { map_style: style, ..GameOptions::default() });
    let mut fleets = vec![Fleet::default(); n];
    let mut seen: Vec<HashSet<u32>> = vec![HashSet::new(); n];
    for _ in 0..25 * 60 * minutes {
        w.step();
        for i in 0..w.actors.len() {
            let a = &w.actors[i];
            if a.alive && a.kind == Kind::Ship && (a.owner as usize) < n {
                seen[a.owner as usize].insert(w.make_ref(i));
                fleets[a.owner as usize].ship_ticks += 1;
                if a.activity == Activity::Attack {
                    fleets[a.owner as usize].firing_ticks += 1;
                }
            }
        }
        for p in 0..n as u8 {
            let r = webra_sim::ai_naval_report(&w, p);
            let f = &mut fleets[p as usize];
            f.largest = f.largest.max(r.largest);
            f.squad_ticks += r.ships as u64;
            f.idle_ticks += r.idle_ships as u64;
            f.attacks = r.attacks;
        }
        if w.winner.is_some() {
            break;
        }
    }
    for p in 0..n {
        fleets[p].built = seen[p].len();
        fleets[p].lost = seen[p].iter().filter(|&&r| w.resolve(r).is_none_or(|i| !w.actors[i].alive)).count();
    }
    Game { style, seed, bot, fleets, winner: w.winner, minutes: w.tick as f64 / 1500.0 }
}

fn main() {
    let arg = |k: usize| std::env::args().nth(k);
    let seeds: u64 = arg(1).map(|s| s.parse().expect("seeds")).unwrap_or(4);
    let minutes: u32 = arg(2).map(|s| s.parse().expect("minutes")).unwrap_or(40);
    let size: i32 = arg(3).map(|s| s.parse().expect("size")).unwrap_or(96);
    let n: usize = std::env::var("PLAYERS").map(|s| s.parse().expect("PLAYERS")).unwrap_or(2);
    let styles: Vec<MapStyle> = std::env::var("STYLES")
        .unwrap_or_else(|_| "islands,lakes,rivers".into())
        .split(',')
        .map(|s| MapStyle::from_name(s.trim()).expect("STYLES"))
        .collect();
    let bots: Vec<BotType> = match std::env::var("BOTS") {
        Ok(list) => list.split(',').map(|b| BotType::from_name(b.trim()).expect("BOTS")).collect(),
        Err(_) => BotType::ALL.to_vec(),
    };
    println!("{seeds} seeds, {minutes} minutes at most, map {size}, {n} bots of a kind per game");
    println!(
        "style   seed bot     | per player: largest squad, idle share, ships built/lost, naval attacks, attacking share | winner, minutes"
    );
    let mut jobs = Vec::new();
    for &style in &styles {
        for &bot in &bots {
            for seed in 1..=seeds {
                jobs.push((style, seed, bot));
            }
        }
    }
    let games: Vec<Game> = std::thread::scope(|s| {
        let handles: Vec<_> = jobs.iter().map(|&(style, seed, bot)| s.spawn(move || play(style, seed, bot, minutes, size, n))).collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });
    for g in &games {
        let fleets: Vec<String> = g
            .fleets
            .iter()
            .map(|f| {
                let idle = (f.idle_ticks * 100).checked_div(f.squad_ticks).unwrap_or(0);
                let firing = (f.firing_ticks * 100).checked_div(f.ship_ticks).unwrap_or(0);
                format!("{:3} {:3}% {:3}/{:<3} {:3} {:3}%", f.largest, idle, f.built, f.lost, f.attacks, firing)
            })
            .collect();
        let winner = g.winner.map_or("none".to_string(), |p| format!("p{p}"));
        println!("{:7} {:4} {:7} | {} | {} {:.1}", g.style.name(), g.seed, g.bot.name(), fleets.join(" | "), winner, g.minutes);
    }
}

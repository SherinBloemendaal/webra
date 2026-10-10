//! Who the AIs gang up on in an 8 player free for all. One slot plays a
//! passive Easy AI (it builds and defends but never attacks, like a human who
//! turtles and so the weakest player early on), the other seven are Normal
//! AIs. Every 10 seconds the sweep counts how many AIs target each player.
//!
//! Printed per game: how often the passive slot was the target of 0, 1, 2 or
//! 3+ AIs (samples while it is in the game), and how often the AIs changed
//! their target. The summary compares the passive slot's share of samples
//! with two or more attackers against the same share of the other slots
//! while they are in the game (the background rate), over the whole game and
//! over the opening (while all eight players are in). A fair target choice
//! keeps the two close. Late in a game, with few players left, two AIs
//! attacking the same survivor is often the only choice they have.
//!
//! Usage: cargo run -p webra-sim --release --example target_sweep -- [seeds] [minutes] [size] [threads]
//! `seeds` is a comma separated list (default: the six seeds of the fairness
//! audit, 1706698519,11,22,33,44,55); every seed is played once per passive slot.
use std::sync::Mutex;
use webra_sim::mapgen::MapStyle;
use webra_sim::world::{AiDifficulty, GameOptions, PlayerSetup, World};

const PLAYERS: usize = 8;
/// Samples every 10 seconds.
const SAMPLE_TICKS: u32 = 250;

struct Run {
    seed: u64,
    passive: usize,
    style: &'static str,
    /// Per slot: samples (while the slot is in the game) targeted by 0, 1, 2 and 3+ AIs.
    counts: Vec<[u32; 4]>,
    /// The same, only while all players are in the game.
    opening: Vec<[u32; 4]>,
    samples: u32,
    /// Target changes of all AIs together (not counting the first pick).
    switches: u32,
    defeated: Vec<u8>,
    winner: Option<u8>,
}

fn play(seed: u64, passive: usize, minutes: u32, size: i32) -> Run {
    let players: Vec<PlayerSetup> = (0..PLAYERS)
        .map(|k| PlayerSetup {
            faction: "allies".into(),
            ai: Some(if k == passive { AiDifficulty::Easy } else { AiDifficulty::Normal }),
            bot: Default::default(),
            team: 0,
            handicap: 0,
        })
        .collect();
    let options = GameOptions { map_style: MapStyle::Random, ..GameOptions::default() };
    let mut w = World::with_options(seed, size, &players, options);
    w.ai[passive].passive = true;
    let mut counts = vec![[0u32; 4]; PLAYERS];
    let mut opening = vec![[0u32; 4]; PLAYERS];
    let mut samples = 0;
    let mut switches = 0;
    let mut last: Vec<Option<u8>> = vec![None; PLAYERS];
    for t in 0..minutes * 60 * 25 {
        w.step();
        for (p, a) in w.ai.iter().enumerate() {
            if a.target_player.is_some() && last[p].is_some() && a.target_player != last[p] {
                switches += 1;
            }
            if a.target_player.is_some() {
                last[p] = a.target_player;
            }
        }
        if t % SAMPLE_TICKS == 0 {
            samples += 1;
            let mut by = [0usize; PLAYERS];
            for (p, a) in w.ai.iter().enumerate() {
                if p == passive || w.players[p].defeated {
                    continue;
                }
                if let Some(tp) = a.target_player {
                    by[tp as usize] += 1;
                }
            }
            let all_in = w.players.iter().all(|p| !p.defeated);
            for (slot, &n) in by.iter().enumerate() {
                if !w.players[slot].defeated {
                    counts[slot][n.min(3)] += 1;
                }
                if all_in {
                    opening[slot][n.min(3)] += 1;
                }
            }
        }
        if w.winner.is_some() {
            break;
        }
    }
    let defeated = (0..PLAYERS as u8).filter(|&p| w.players[p as usize].defeated).collect();
    Run { seed, passive, style: w.options.map_style.resolve(seed).name(), counts, opening, samples, switches, defeated, winner: w.winner }
}

/// Share of a slot's samples in which it had two or more attackers.
fn ganged(c: &[u32; 4]) -> f64 {
    (c[2] + c[3]) as f64 / c.iter().sum::<u32>().max(1) as f64
}

/// Two or more attackers: share for the passive slot, and the mean share of
/// the other slots that were sampled at all.
fn shares(counts: &[[u32; 4]], passive: usize) -> (Option<f64>, Option<f64>) {
    let sampled = |c: &[u32; 4]| c.iter().sum::<u32>() > 0;
    let others: Vec<f64> = (0..PLAYERS).filter(|&s| s != passive && sampled(&counts[s])).map(|s| ganged(&counts[s])).collect();
    let bg = (!others.is_empty()).then(|| others.iter().sum::<f64>() / others.len() as f64);
    (sampled(&counts[passive]).then(|| ganged(&counts[passive])), bg)
}

fn main() {
    let arg = |k: usize| std::env::args().nth(k);
    let seeds: Vec<u64> = arg(1)
        .unwrap_or_else(|| "1706698519,11,22,33,44,55".into())
        .split(',')
        .map(|s| s.trim().parse().expect("seeds are numbers"))
        .collect();
    let minutes: u32 = arg(2).map_or(20, |s| s.parse().expect("minutes is a number"));
    let size: i32 = arg(3).map_or(96, |s| s.parse().expect("size is a number"));
    let threads: usize = arg(4).map_or(4, |s| s.parse().expect("threads is a number")).max(1);
    let jobs: Mutex<Vec<(u64, usize)>> = Mutex::new(seeds.iter().flat_map(|&s| (0..PLAYERS).map(move |p| (s, p))).rev().collect());
    let runs: Mutex<Vec<Run>> = Mutex::new(Vec::new());
    std::thread::scope(|scope| {
        for _ in 0..threads {
            scope.spawn(|| loop {
                let Some((seed, passive)) = jobs.lock().unwrap().pop() else { break };
                let run = play(seed, passive, minutes, size);
                runs.lock().unwrap().push(run);
            });
        }
    });
    let mut runs = runs.into_inner().unwrap();
    runs.sort_by_key(|r| (seeds.iter().position(|&s| s == r.seed), r.passive));
    let (mut weak, mut background, mut weak_open, mut background_open) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    let (mut switches, mut minutes_played) = (0u32, 0f64);
    let pct = |v: Option<f64>| v.map_or("  -".to_string(), |x| format!("{:>3.0}", x * 100.0));
    for r in &runs {
        let (p, bg) = shares(&r.counts, r.passive);
        let (po, bgo) = shares(&r.opening, r.passive);
        println!(
            "seed {:>10} {:<7} passive {}: targeted by 0/1/2/3+ AIs {:?} ({}% by 2+, others {}%; opening {}% vs {}%), target changes {}, defeated {:?}, winner {:?}",
            r.seed,
            r.style,
            r.passive,
            r.counts[r.passive],
            pct(p),
            pct(bg),
            pct(po),
            pct(bgo),
            r.switches,
            r.defeated,
            r.winner
        );
        weak.extend(p);
        background.extend(bg);
        weak_open.extend(po);
        background_open.extend(bgo);
        switches += r.switches;
        minutes_played += r.samples as f64 * SAMPLE_TICKS as f64 / 1500.0;
    }
    let mean = |v: &[f64]| v.iter().sum::<f64>() / v.len().max(1) as f64;
    for &seed in &seeds {
        let of: Vec<f64> = runs.iter().filter(|r| r.seed == seed).filter_map(|r| shares(&r.counts, r.passive).0).collect();
        println!("seed {seed}: passive slot targeted by 2+ AIs in {:.0}% of samples (mean over its 8 slots)", mean(&of) * 100.0);
    }
    println!(
        "summary over {} games: passive slot targeted by 2+ AIs {:.1}% of samples, other slots {:.1}%; opening (all players in): {:.1}% vs {:.1}%; {:.2} target changes per AI per 10 minutes",
        runs.len(),
        mean(&weak) * 100.0,
        mean(&background) * 100.0,
        mean(&weak_open) * 100.0,
        mean(&background_open) * 100.0,
        switches as f64 / (PLAYERS as f64 - 1.0) / (minutes_played / 10.0).max(1e-9)
    );
}

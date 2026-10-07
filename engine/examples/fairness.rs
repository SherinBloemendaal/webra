//! Mirror matches over many seeds: counts how often each slot wins.
//! Usage: cargo run -p webra-sim --release --example fairness -- [seeds] [faction] [map size] [first seed]
use webra_sim::world::World;

fn main() {
    let seeds: u64 = std::env::args().nth(1).map(|s| s.parse().expect("seeds is a number")).unwrap_or(10);
    let f = std::env::args().nth(2).unwrap_or_else(|| "allies".into());
    let size: i32 = std::env::args().nth(3).map(|s| s.parse().expect("size is a number")).unwrap_or(80);
    let first: u64 = std::env::args().nth(4).map(|s| s.parse().expect("first seed is a number")).unwrap_or(0);
    let mut wins = [0u32; 3];
    for seed in first..first + seeds {
        let mut w = World::new(seed, size, &[(f.as_str(), true), (f.as_str(), true)]);
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

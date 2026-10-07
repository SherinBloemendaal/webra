//! Headless AI vs AI match.
//! Usage: cargo run -p webra-sim --release --example ai_vs_ai -- [seed] [faction0] [faction1]
use webra_sim::rules::Kind;
use webra_sim::world::World;

fn main() {
    let seed: u64 = std::env::args().nth(1).map(|s| s.parse().expect("seed is a number")).unwrap_or(13);
    let f0 = std::env::args().nth(2).unwrap_or_else(|| "allies".into());
    let f1 = std::env::args().nth(3).unwrap_or_else(|| "soviet".into());
    let mut w = World::new(seed, 80, &[(f0.as_str(), true), (f1.as_str(), true)]);
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

//! Headless benchmark of a game on a map file (docs/contracts.md section 2):
//! every spawn taken by a Normal AI (or `players` of them), stepped for
//! `ticks`, with the setup time, the average and worst tick, and the path
//! work done, so the simulation cost of a map (an imported `.oramap`, a
//! large community map) can be measured without the browser.
//! Usage: cargo run -p webra-sim --release --example map_bench -- <map.json> [ticks] [players] [seed]
//! Environment: BENCH_PHASES=1 prints the slowest ticks with their tick number.
use webra_sim::mapdata::MapData;
use webra_sim::world::{AiDifficulty, GameOptions, PlayerSetup, World};

fn main() {
    let path = std::env::args().nth(1).expect("usage: map_bench <map.json> [ticks] [players] [seed]");
    let ticks: u32 = std::env::args().nth(2).map(|s| s.parse().expect("ticks is a number")).unwrap_or(1500);
    let json = std::fs::read_to_string(&path).expect("map file");
    let t0 = std::time::Instant::now();
    let data = MapData::parse(&json).expect("map file parses");
    let parse_ms = t0.elapsed().as_secs_f64() * 1000.0;
    let want: usize = std::env::args().nth(3).map(|s| s.parse().expect("players is a number")).unwrap_or(data.spawns.len());
    let seed: u64 = std::env::args().nth(4).map(|s| s.parse().expect("seed is a number")).unwrap_or(1);
    let factions = ["england", "russia", "germany", "ukraine", "france", "soviet", "allies", "russia"];
    let players: Vec<PlayerSetup> =
        (0..want.min(data.spawns.len()).min(8)).map(|k| PlayerSetup::new(factions[k % 8], Some(AiDifficulty::Normal))).collect();
    let t0 = std::time::Instant::now();
    let mut w = World::from_map(&data, seed, &players, GameOptions::default()).expect("game on the map");
    let setup_ms = t0.elapsed().as_secs_f64() * 1000.0;
    let actors = w.actors.iter().filter(|a| a.alive).count();
    println!(
        "{}: {}x{} cells, {} spawns, {} map actors; parse {parse_ms:.1} ms, setup {setup_ms:.1} ms, {actors} actors, {} players",
        data.name,
        data.width,
        data.height,
        data.spawns.len(),
        data.actors.len(),
        players.len()
    );
    let phases = std::env::var("BENCH_PHASES").is_ok();
    let t0 = std::time::Instant::now();
    let mut worst = (0.0f64, 0u32);
    let mut slow = Vec::new();
    let mut window = (0.0f64, 0u32);
    for t in 0..ticks {
        let tt = std::time::Instant::now();
        w.step();
        let ms = tt.elapsed().as_secs_f64() * 1000.0;
        if ms > worst.0 {
            worst = (ms, t);
        }
        if ms > 40.0 {
            slow.push((t, ms));
        }
        window.0 += ms;
        window.1 += 1;
        if window.1 == 1500 {
            let alive = w.actors.iter().filter(|a| a.alive).count();
            println!(
                "{:>3} min: avg {:.2} ms/tick, {alive} actors, {} flow fields, {} searches ({} cells)",
                (t + 1) / 1500,
                window.0 / f64::from(window.1),
                w.flow.computed,
                w.search.searches,
                w.search.expanded
            );
            window = (0.0, 0);
        }
    }
    let avg = t0.elapsed().as_secs_f64() * 1000.0 / f64::from(ticks);
    let alive = w.actors.iter().filter(|a| a.alive).count();
    println!(
        "{ticks} ticks: avg {avg:.2} ms/tick, worst {:.2} ms at tick {}, {} ticks over the 40 ms budget; {alive} alive, {} flow fields computed ({} cells), {} route searches ({} cells)",
        worst.0, worst.1, slow.len(), w.flow.computed, w.flow.expanded, w.search.searches, w.search.expanded
    );
    if phases {
        slow.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        for (t, ms) in slow.iter().take(20) {
            println!("  tick {t}: {ms:.2} ms");
        }
    }
}

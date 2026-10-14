//! Headless simulation benchmark of the stress test (the lobby's "Stress
//! test": two armies of tanks and soldiers that attack-move across an open
//! map into each other), for docs/contracts.md "Simulation performance".
//!
//! Usage: cargo run -p webra-sim --release --example sim_bench -- [units] [ticks] [seed] [options]
//!   --window N     ticks per report line (default 250)
//!   --hashes FILE  write the state hash every 25 ticks to FILE (determinism checks)
//!   --sections     a per-system breakdown per window (needs `--features profile`)
//!
//! Prints the average and worst tick per window, the units alive, flow
//! fields and route searches, a digest of the state hashes (every 25 ticks,
//! outside the timed ticks) and the peak resident memory. Built with
//! `--features profile` it also prints where the tick time goes (src/profile.rs).
use webra_sim::profile;
use webra_sim::world::World;

fn main() {
    let mut pos = Vec::new();
    let (mut window, mut hashes, mut sections) = (250u32, None::<String>, false);
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--window" => window = args.next().and_then(|s| s.parse().ok()).expect("--window N"),
            "--hashes" => hashes = Some(args.next().expect("--hashes FILE")),
            "--sections" => sections = true,
            _ => pos.push(a),
        }
    }
    let units: u32 = pos.first().map(|s| s.parse().expect("units")).unwrap_or(20_000);
    let ticks: u32 = pos.get(1).map(|s| s.parse().expect("ticks")).unwrap_or(3000);
    let seed: u64 = pos.get(2).map(|s| s.parse().expect("seed")).unwrap_or(1);
    // The map size of the game's stress test (js/main.js startStress).
    let size = ((units as f64).sqrt() * 2.2).ceil().max(96.0) as i32;
    let t0 = std::time::Instant::now();
    let mut w = World::new_stress(seed, units, size);
    println!("setup: {units} units on a {size}x{size} map, seed {seed}, in {:.1?}", t0.elapsed());
    profile::take();
    let mut digest: u64 = 0xcbf2_9ce4_8422_2325;
    let mut hash_lines = String::new();
    let mut all = Vec::with_capacity(ticks as usize);
    let mut win = Vec::new();
    let mut totals = vec![0u64; profile::SECTIONS.len()];
    let mut peak_rss = rss_mib();
    for t in 1..=ticks {
        let start = std::time::Instant::now();
        w.step();
        let ms = start.elapsed().as_secs_f64() * 1000.0;
        all.push(ms);
        win.push(ms);
        if t % 25 == 0 {
            let h = w.state_hash();
            digest = (digest ^ h).wrapping_mul(0x0100_0000_01b3);
            hash_lines.push_str(&format!("{} {h:016x}\n", w.tick));
        }
        if t % window == 0 || t == ticks {
            let avg = win.iter().sum::<f64>() / win.len() as f64;
            let worst = win.iter().cloned().fold(0.0, f64::max);
            let alive = w.actors.iter().filter(|a| a.alive && a.is_unit()).count();
            println!(
                "ticks {:5}-{:5}: avg {avg:6.2} ms, worst {worst:7.2} ms; {alive:6} units, {:6} flow fields, {:7} route searches ({} gave up, {} cells)",
                t + 1 - win.len() as u32,
                t,
                w.flow.computed,
                w.search.searches,
                w.search.limited,
                w.search.expanded
            );
            let took = profile::take();
            for (k, (_, ns, _)) in took.iter().enumerate() {
                totals[k] += ns;
            }
            if sections {
                print_sections(&took.iter().map(|&(_, ns, _)| ns).collect::<Vec<_>>(), win.len() as u32);
            }
            win.clear();
            if let Some(r) = rss_mib() {
                peak_rss = Some(peak_rss.map_or(r, |p: f64| p.max(r)));
            }
        }
    }
    println!("{ticks} ticks: {}; budget 40 ms", summary(&all));
    // The first tick starts every unit's move at once (all route searches).
    if all.len() > 1 {
        println!("after the first tick ({:.2} ms): {}", all[0], summary(&all[1..]));
    }
    println!("state hash digest {digest:016x} (final tick {}, hash {:016x})", w.tick, w.state_hash());
    if let Some(rss) = peak_rss {
        println!("peak resident memory {rss:.0} MiB (sampled after every window)");
    }
    if profile::ENABLED {
        println!("where the time goes (whole run):");
        print_sections(&totals, ticks);
    }
    if let Some(path) = hashes {
        std::fs::write(&path, hash_lines).expect("write the hashes");
    }
}

/// Average, median, 95th percentile and worst of tick times.
fn summary(ms: &[f64]) -> String {
    let mut sorted = ms.to_vec();
    sorted.sort_by(|a, b| a.total_cmp(b));
    let avg = ms.iter().sum::<f64>() / ms.len().max(1) as f64;
    let pct = |p: f64| sorted[((sorted.len() - 1) as f64 * p) as usize];
    format!("avg {avg:.2} ms/tick, median {:.2}, p95 {:.2}, worst {:.2}", pct(0.5), pct(0.95), sorted.last().copied().unwrap_or(0.0))
}

fn print_sections(ns: &[u64], ticks: u32) {
    let top: u64 = profile::SECTIONS.iter().zip(ns).filter(|(s, _)| !s.name().starts_with(' ')).map(|(_, &n)| n).sum();
    for (s, &n) in profile::SECTIONS.iter().zip(ns) {
        if n == 0 {
            continue;
        }
        let ms = n as f64 / 1e6 / ticks.max(1) as f64;
        println!("    {:32} {ms:7.3} ms/tick {:5.1}%", s.name(), 100.0 * n as f64 / top.max(1) as f64);
    }
}

/// Resident set size of this process, from `ps`. None where `ps` is missing.
fn rss_mib() -> Option<f64> {
    let out = std::process::Command::new("ps").args(["-o", "rss=", "-p", &std::process::id().to_string()]).output().ok()?;
    let kib: f64 = String::from_utf8_lossy(&out.stdout).trim().parse().ok()?;
    Some(kib / 1024.0)
}

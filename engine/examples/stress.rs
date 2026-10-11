//! Headless stress benchmark. Usage: cargo run -p webra-sim --release --example stress -- [units] [ticks]
//! Environment: STRESS_MOVEMENT (openra, webra; default openra, the engine default).
use webra_sim::movement::MovementModel;
use webra_sim::world::World;

fn main() {
    let mut args = std::env::args().skip(1);
    let units: u32 = args.next().map(|s| s.parse().expect("units")).unwrap_or(20_000);
    let ticks: u32 = args.next().map(|s| s.parse().expect("ticks")).unwrap_or(250);
    let size = ((units as f64).sqrt() * 2.2).ceil().max(96.0) as i32;
    let t0 = std::time::Instant::now();
    let mut w = World::new_stress(1, units, size);
    let model = std::env::var("STRESS_MOVEMENT").unwrap_or_else(|_| "openra".into());
    w.options.movement = MovementModel::from_name(&model).expect("STRESS_MOVEMENT is openra or webra");
    println!("setup: {units} units on a {size}x{size} map in {:.2?} ({model} movement)", t0.elapsed());
    let t0 = std::time::Instant::now();
    let mut worst = 0.0f64;
    for _ in 0..ticks {
        let t = std::time::Instant::now();
        w.step();
        worst = worst.max(t.elapsed().as_secs_f64() * 1000.0);
    }
    let avg = t0.elapsed().as_secs_f64() * 1000.0 / ticks as f64;
    let alive = w.actors.iter().filter(|a| a.alive).count();
    println!(
        "{ticks} ticks: avg {avg:.2} ms/tick, worst {worst:.2} ms, budget 40 ms; {alive} alive, {} flow fields computed, {} route searches ({} cells)",
        w.flow.computed, w.search.searches, w.search.expanded
    );
}

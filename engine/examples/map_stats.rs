//! Map fairness numbers without playing: what every base of a generated map
//! gets (ground distance to the nearest enemy, ore nearby, harbour, water
//! distance to the other harbours), per seed and summed up, so map layouts
//! can be compared before and after a change. `MAP_ASCII=1` also draws each map.
//!
//! Usage: cargo run -p webra-sim --release --example map_stats -- [players] [seeds] [map size] [style]
//! `style` is random (default), land, rivers, lakes or islands.
use webra_sim::map::{Map, Terrain};
use webra_sim::mapgen::metrics::measure;
use webra_sim::mapgen::MapStyle;

fn main() {
    let arg = |k: usize| std::env::args().nth(k);
    let players: usize = arg(1).map_or(2, |s| s.parse().expect("players is a number"));
    let seeds: u64 = arg(2).map_or(16, |s| s.parse().expect("seeds is a number"));
    let size: i32 = arg(3).map_or(if players <= 4 { 96 } else { 128 }, |s| s.parse().expect("size is a number"));
    let style = MapStyle::from_name(&arg(4).unwrap_or_else(|| "random".into())).expect("style: random, land, rivers, lakes or islands");
    let ascii = std::env::var("MAP_ASCII").is_ok();
    // Largest relative spread (max - min) / max of a per-base number, over all seeds.
    let mut worst = [0f64; 3];
    let mut sums = [0u64; 5];
    for seed in 0..seeds {
        let m = Map::generate_styled(size, size, seed, 12, players, style);
        let s = measure(&m);
        let rel = |v: Option<(u32, u32)>| v.map_or(0.0, |(lo, hi)| if hi == 0 { 0.0 } else { (hi - lo) as f64 / hi as f64 });
        let spreads = [rel(s.spread(|b| b.rush)), rel(s.spread(|b| Some(b.ore_cells))), rel(s.spread(|b| b.naval_steps))];
        for (w, v) in worst.iter_mut().zip(spreads) {
            *w = w.max(v);
        }
        for (sum, v) in sums.iter_mut().zip([s.water, s.fords, s.rock, s.trees, s.ore]) {
            *sum += v as u64;
        }
        println!(
            "seed {seed:>3} {:<8} water {:>5} fords {:>4} ore {:>5} | rush {:?} | ore near {:?} | harbour {:?} | naval steps {:?}",
            style.resolve(seed).name(),
            s.water,
            s.fords,
            s.ore,
            s.bases.iter().map(|b| b.rush.unwrap_or(0)).collect::<Vec<_>>(),
            s.bases.iter().map(|b| b.ore_cells).collect::<Vec<_>>(),
            s.bases.iter().map(|b| b.harbour_cells).collect::<Vec<_>>(),
            s.bases.iter().map(|b| b.naval_steps.unwrap_or(0)).collect::<Vec<_>>(),
        );
        if ascii {
            draw(&m);
        }
    }
    let n = seeds.max(1);
    println!(
        "{players} players, {size}x{size}, style {}, {seeds} seeds: mean water {}, fords {}, rock {}, trees {}, ore {}",
        style.name(),
        sums[0] / n,
        sums[1] / n,
        sums[2] / n,
        sums[3] / n,
        sums[4] / n
    );
    println!(
        "worst spread between bases: rush {:.0}%, ore near base {:.0}%, naval steps {:.0}%",
        worst[0] * 100.0,
        worst[1] * 100.0,
        worst[2] * 100.0
    );
}

fn draw(m: &Map) {
    for y in 0..m.height {
        let row: String = (0..m.width)
            .map(|x| {
                let i = m.idx(x, y);
                if m.spawns.iter().any(|&(sx, sy)| (sx..sx + 3).contains(&x) && (sy..sy + 4).contains(&y)) {
                    return 'B';
                }
                if m.ore[i] > 0 {
                    return '$';
                }
                match m.terrain[i] {
                    Terrain::Clear => '.',
                    Terrain::Rough => ',',
                    Terrain::Rock => '#',
                    Terrain::Water => '~',
                    Terrain::Tree => 'T',
                    Terrain::Ford => '=',
                }
            })
            .collect();
        println!("{row}");
    }
}

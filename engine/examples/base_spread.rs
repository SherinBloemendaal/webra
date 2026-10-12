//! How far a bot's base spreads over a match: per bot and sample, its
//! Construction Yards, MCVs ever built, yard sites ever used, structures,
//! refineries, how far structures stand from the spawn (cells, farthest and
//! mean), and how many clusters they form (structures within 6 cells of
//! each other). Usage:
//! cargo run -p webra-sim --release --example base_spread -- [seed] [bot0,bot1,...] [minutes] [every N minutes]
//! Environment: AI_STYLE (random, land, rivers, lakes, islands), AI_SIZE
//! (map size, 80), AI_REDEPLOY (on, off: the "Redeployable MCVs" option),
//! AI_LAYOUT (generated; classic: a clear map with an ore field by every
//! base and gems in the middle; scatter: small ore patches everywhere).
use std::collections::BTreeSet;
use webra_sim::ai_bots::BotType;
use webra_sim::map::{Map, Terrain};
use webra_sim::mapdata::MapData;
use webra_sim::mapgen::MapStyle;
use webra_sim::rules::Kind;
use webra_sim::world::{AiDifficulty, GameOptions, PlayerSetup, World};

fn main() {
    let arg = |k: usize| std::env::args().nth(k);
    let seed: u64 = arg(1).map(|s| s.parse().unwrap()).unwrap_or(1);
    let bots: Vec<BotType> =
        arg(2).unwrap_or_else(|| "normal,normal".into()).split(',').map(|b| BotType::from_name(b).expect("bot")).collect();
    let minutes: u32 = arg(3).map(|s| s.parse().unwrap()).unwrap_or(60);
    let every: u32 = arg(4).map(|s| s.parse::<u32>().unwrap()).unwrap_or(10) * 1500;
    let var = |k: &str, d: &str| std::env::var(k).unwrap_or_else(|_| d.into());
    let style = MapStyle::from_name(&var("AI_STYLE", "random")).expect("AI_STYLE");
    let size: i32 = var("AI_SIZE", "80").parse().expect("AI_SIZE");
    let redeploy = var("AI_REDEPLOY", "on") == "on";
    let layout = var("AI_LAYOUT", "generated");
    let sides = ["allies", "soviet"];
    let players: Vec<PlayerSetup> =
        (0..bots.len()).map(|k| PlayerSetup { bot: bots[k], ..PlayerSetup::new(sides[k % 2], Some(AiDifficulty::Normal)) }).collect();
    let options = GameOptions { map_style: style, redeployable_mcv: redeploy, ..GameOptions::default() };
    let mut w = match layout.as_str() {
        "generated" => World::with_options(seed, size, &players, options),
        other => {
            let map = layout_map(other, size, players.len());
            let data = MapData::from_map(&map, "probe", "probe", "");
            World::from_map(&data, seed, &players, options).expect("map")
        }
    };
    let fact = w.rules.actor_index("FACT").unwrap() as u16;
    let mcv = w.rules.actor_index("MCV").unwrap() as u16;
    let n = bots.len();
    let mut sites: Vec<BTreeSet<(i32, i32)>> = vec![BTreeSet::new(); n];
    let mut mcvs_seen: Vec<BTreeSet<u32>> = vec![BTreeSet::new(); n];
    println!("seed {seed} size {} layout {layout} style {style:?} redeploy {redeploy} bots {bots:?}", w.map.width);
    println!("time  p  yards mcvs sites built bldgs procs  far  mean clusters funds");
    let t0 = std::time::Instant::now();
    for t in 1..=(1500 * minutes) {
        w.step();
        if t % 25 == 0 {
            for (i, a) in w.actors.iter().enumerate() {
                if !a.alive || a.owner as usize >= n {
                    continue;
                }
                if a.ty == fact {
                    sites[a.owner as usize].insert((a.cx, a.cy));
                } else if a.ty == mcv {
                    mcvs_seen[a.owner as usize].insert(w.make_ref(i));
                }
            }
        }
        if t % every == 0 || w.winner.is_some() {
            for p in 0..n {
                let (sx, sy) = w.players[p].start;
                let b: Vec<(i32, i32)> =
                    w.actors.iter().filter(|a| a.alive && a.owner == p as u8 && a.kind == Kind::Building).map(|a| (a.cx, a.cy)).collect();
                let yards = w.actors.iter().filter(|a| a.alive && a.owner == p as u8 && a.ty == fact).count();
                let mcvs = w.actors.iter().filter(|a| a.alive && a.owner == p as u8 && a.ty == mcv).count();
                let procs = w
                    .actors
                    .iter()
                    .filter(|a| {
                        a.alive
                            && a.owner == p as u8
                            && w.rules.actors[a.ty as usize].building.as_ref().is_some_and(|x| x.refinery.is_some())
                    })
                    .count();
                let dist = |c: &(i32, i32)| (((c.0 - sx).pow(2) + (c.1 - sy).pow(2)) as f64).sqrt();
                let far = b.iter().map(dist).fold(0.0, f64::max);
                let mean = if b.is_empty() { 0.0 } else { b.iter().map(dist).sum::<f64>() / b.len() as f64 };
                println!(
                    "{:>3}:{:02} {p} {yards:>5} {mcvs:>4} {:>5} {:>5} {:>5} {procs:>5} {far:>4.0} {mean:>5.1} {:>8} {:>5}",
                    t / 1500,
                    (t / 25) % 60,
                    sites[p].len(),
                    mcvs_seen[p].len().saturating_sub(1),
                    b.len(),
                    clusters(&b),
                    w.players[p].funds()
                );
            }
        }
        if let Some(winner) = w.winner {
            println!("winner: player {winner} after {}:{:02}", t / 1500, (t / 25) % 60);
            break;
        }
    }
    println!("simulated in {:.2?}", t0.elapsed());
    for (p, used) in sites.iter().enumerate() {
        println!("player {p} spawn {:?} yard sites {used:?}", w.players[p].start);
    }
}

/// Groups of structures within 6 cells of each other (union-find).
fn clusters(b: &[(i32, i32)]) -> usize {
    let mut parent: Vec<usize> = (0..b.len()).collect();
    fn find(p: &mut [usize], i: usize) -> usize {
        let mut i = i;
        while p[i] != i {
            p[i] = p[p[i]];
            i = p[i];
        }
        i
    }
    for i in 0..b.len() {
        for j in i + 1..b.len() {
            if (b[i].0 - b[j].0).abs() <= 6 && (b[i].1 - b[j].1).abs() <= 6 {
                let (a, c) = (find(&mut parent, i), find(&mut parent, j));
                parent[a] = c;
            }
        }
    }
    (0..b.len()).filter(|&i| find(&mut parent, i) == i).count()
}

/// A clear map of `size` cells with the given ore layout, spawns in the corners.
fn layout_map(layout: &str, size: i32, players: usize) -> Map {
    let mut map = Map::filled(size, size, Terrain::Clear);
    let corners = [(6, 6), (size - 10, size - 10), (size - 10, 6), (6, size - 10)];
    map.spawns = corners[..players.clamp(2, 4)].to_vec();
    let mut patch = |x0: i32, y0: i32, x1: i32, y1: i32, gems: bool| {
        for y in y0.max(0)..=y1.min(size - 1) {
            for x in x0.max(0)..=x1.min(size - 1) {
                let i = map.idx(x, y);
                if gems {
                    map.gems[i] = 3;
                } else {
                    map.ore[i] = 10;
                }
            }
        }
    };
    match layout {
        // An ore field beside every base, a gem field in the middle.
        "classic" => {
            for &(x, y) in &corners {
                patch(x + 8, y - 2, x + 14, y + 5, false);
            }
            let m = size / 2;
            patch(m - 3, m - 3, m + 3, m + 3, true);
        }
        // Small ore patches on a grid over the whole map.
        "scatter" => {
            let mut y = 4;
            while y < size - 4 {
                let mut x = 4;
                while x < size - 4 {
                    patch(x, y, x + 2, y + 2, false);
                    x += 12;
                }
                y += 12;
            }
        }
        other => panic!("AI_LAYOUT {other}: generated, classic or scatter"),
    }
    map
}

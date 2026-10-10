//! Prints each AI's power, money, army composition and bot state over a match (balance debugging).
//! Usage: cargo run -p webra-sim --release --example ai_probe -- [seed] [bot0,bot1] [minutes] [every N seconds]
//! Environment: AI_STYLE (random, land, rivers, lakes, islands), AI_SIZE (map
//! size, 80), AI_FACTIONS (comma separated, one per bot; default the sides
//! of examples/bot_matrix.rs).
use std::collections::BTreeMap;
use webra_sim::ai_bots::BotType;
use webra_sim::mapgen::MapStyle;
use webra_sim::world::{AiDifficulty, GameOptions, PlayerSetup, World};

fn main() {
    let arg = |k: usize| std::env::args().nth(k);
    let seed: u64 = arg(1).map(|s| s.parse().unwrap()).unwrap_or(1);
    let bots: Vec<BotType> =
        arg(2).unwrap_or_else(|| "normal,normal".into()).split(',').map(|b| BotType::from_name(b).expect("bot")).collect();
    let minutes: u32 = arg(3).map(|s| s.parse().unwrap()).unwrap_or(9);
    let every: u32 = arg(4).map(|s| s.parse::<u32>().unwrap() * 25).unwrap_or(3000);
    let style = MapStyle::from_name(&std::env::var("AI_STYLE").unwrap_or_else(|_| "random".into())).expect("AI_STYLE");
    let size: i32 = std::env::var("AI_SIZE").map(|s| s.parse().expect("AI_SIZE")).unwrap_or(80);
    // The same sides as examples/bot_matrix.rs for this seed.
    let sides = if (seed / 2).is_multiple_of(2) { ["allies", "soviet"] } else { ["soviet", "allies"] };
    let factions: Vec<String> = match std::env::var("AI_FACTIONS") {
        Ok(list) => list.split(',').map(|f| f.to_string()).collect(),
        Err(_) => (0..bots.len()).map(|k| sides[k % 2].to_string()).collect(),
    };
    let players: Vec<PlayerSetup> =
        (0..bots.len()).map(|k| PlayerSetup { bot: bots[k], ..PlayerSetup::new(&factions[k], Some(AiDifficulty::Normal)) }).collect();
    let mut w = World::with_options(seed, size, &players, GameOptions { map_style: style, ..GameOptions::default() });
    for t in 1..=(25 * 60 * minutes) {
        w.step();
        if t % every == 0 {
            for p in 0..bots.len() as u8 {
                let mut comp: BTreeMap<String, usize> = BTreeMap::new();
                for a in w.actors.iter().filter(|a| a.alive && a.owner == p) {
                    *comp.entry(w.rules.actors[a.ty as usize].id.clone()).or_default() += 1;
                }
                let pl = &w.players[p as usize];
                println!(
                    "{}:{:02} p{p} power {}/{} funds {} lost {} {:?}",
                    t / 1500,
                    (t / 25) % 60,
                    pl.power_use,
                    pl.power_gen,
                    pl.funds(),
                    w.losses[p as usize],
                    comp
                );
                println!("      {}", webra_sim::ai_debug_summary(&w, p));
                let mut harv: BTreeMap<String, usize> = BTreeMap::new();
                for a in w.actors.iter().filter(|a| a.alive && a.owner == p && w.rules.actors[a.ty as usize].id == "HARV") {
                    *harv.entry(format!("{:?}/{:?}", a.activity, a.harv)).or_default() += 1;
                }
                for a in w.actors.iter().filter(|a| a.alive && a.owner == p && a.kind == webra_sim::rules::Kind::Aircraft) {
                    println!(
                        "      aircraft {} at {:?} {:?} alt {} target {:?} rtb {}",
                        w.rules.actors[a.ty as usize].id,
                        w.cell_of(a.x, a.y),
                        a.activity,
                        a.altitude,
                        w.resolve(a.target).map(|t| (w.rules.actors[w.actors[t].ty as usize].id.clone(), w.actors[t].owner)),
                        a.air.rtb
                    );
                }
                let ore = (0..w.map.cells()).filter(|&c| w.map.has_resource(c)).count();
                let open_ore = (0..w.map.cells()).filter(|&c| w.map.has_resource(c) && !w.pass.blocked[c]).count();
                println!("      trucks {harv:?} earned {} ore cells {ore} ({open_ore} open)", w.player_stats(p).earned);
            }
        }
        if w.winner.is_some() {
            println!("winner: player {:?} after {}:{:02}", w.winner, t / 1500, (t / 25) % 60);
            break;
        }
    }
}

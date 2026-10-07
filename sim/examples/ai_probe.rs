//! Prints each AI's power, money and army composition over a match (balance debugging).
use std::collections::BTreeMap;
use webra_sim::rules::Kind;
use webra_sim::world::World;

fn main() {
    let seed: u64 = std::env::args().nth(1).map(|s| s.parse().unwrap()).unwrap_or(1);
    let mut w = World::new(seed, 80, &[("allies", true), ("soviet", true)]);
    for t in 1..=(25 * 60 * 9) {
        w.step();
        if t % 3000 == 0 {
            for p in 0..2u8 {
                let mut comp: BTreeMap<String, usize> = BTreeMap::new();
                for a in w.actors.iter().filter(|a| a.alive && a.owner == p) {
                    *comp.entry(w.rules.actors[a.ty as usize].id.clone()).or_default() += 1;
                }
                let pl = &w.players[p as usize];
                let qs: Vec<Vec<String>> = pl
                    .queues
                    .iter()
                    .map(|q| {
                        q.items
                            .iter()
                            .map(|i| {
                                format!("{}:{}/{}{}", w.rules.actors[i.ty as usize].id, i.remaining, i.total, if i.done { "D" } else { "" })
                            })
                            .collect()
                    })
                    .collect();
                println!("   queues {:?}", qs);
                if let Some(it) = pl.queues[0].items.first() {
                    let av = w.availability(p, it.ty);
                    let req: Vec<String> = w.requirements(p, it.ty).into_iter().map(|r| r.label).collect();
                    println!(
                        "   head {} enabled={} visible={} reqs={:?} low_power={} funds={}",
                        w.rules.actors[it.ty as usize].id,
                        av.enabled,
                        av.visible,
                        req,
                        pl.low_power(),
                        pl.funds()
                    );
                }
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
            }
        }
        if w.winner.is_some() {
            break;
        }
    }
    let _ = Kind::Building;
}

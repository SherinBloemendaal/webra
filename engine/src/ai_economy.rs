//! Skirmish AI, the economy when it runs dry (called from `ai::think`).
//!
//! Long games (water maps, desert heat, sandstorms) can harvest every field a
//! base reaches. Without this both sides end up broke with nothing to fight
//! with, and the game never ends. The AI then:
//!
//! - sends waiting ore trucks to any ore its ground units can reach, explored
//!   or not (a skirmish AI knows the map's resources, as OpenRA's does), see
//!   `ai::send_idle_harvesters`;
//! - when it has no income left (no ore its trucks can reach, or no refinery
//!   and no money for one) and no army to speak of, sells what it no longer
//!   needs, one structure every few seconds, to pay for one last army:
//!   refineries and silos without ore, tech and support structures, aircraft
//!   and naval structures without aircraft or ships, then power plants it can
//!   spare. It keeps its Construction Yard, one barracks, one war factory,
//!   enough power for them, and its defences.

use crate::ai::is_army_unit;
use crate::rules::{Kind, QueueType};
use crate::world::{Order, World, TICKS_PER_SECOND};

/// Funds below which the AI counts as broke (less than a light tank).
pub(crate) const BROKE_FUNDS: i32 = 600;
/// An army this small (and broke) sells structures for a last army.
const SMALL_ARMY: usize = 4;
/// Time between two sales.
const SELL_EVERY_TICKS: u32 = 8 * TICKS_PER_SECOND;

/// Resource cells in the ground component of `player`'s base (what its ore trucks can reach).
pub(crate) fn reachable_resources(w: &World, player: u8) -> usize {
    // The base's own cells are under its structures: take the ground
    // component of the nearest open cell around the yard.
    let base = crate::ai::base_point(w, player);
    let (bx, by) = w.cell_of(base.0, base.1);
    let mut comp = 0;
    'rings: for r in 0..16 {
        for y in by - r..=by + r {
            for x in bx - r..=bx + r {
                if ((x - bx).abs() == r || (y - by).abs() == r) && w.map.contains(x, y) && !w.pass.blocked[w.map.idx(x, y)] {
                    comp = w.pass.component[w.map.idx(x, y)];
                    break 'rings;
                }
            }
        }
    }
    if comp == 0 {
        return 0;
    }
    (0..w.map.cells()).filter(|&c| w.map.has_resource(c) && !w.pass.blocked[c] && w.pass.component[c] == comp).count()
}

fn own_buildings(w: &World, player: u8) -> Vec<usize> {
    (0..w.actors.len()).filter(|&i| w.actors[i].alive && w.actors[i].owner == player && w.actors[i].kind == Kind::Building).collect()
}

/// Whether `player` earns nothing any more: no ore its trucks reach, no
/// refinery or no ore truck (and too little money to get one).
pub(crate) fn no_income(w: &World, player: u8) -> bool {
    let refineries = own_buildings(w, player)
        .into_iter()
        .filter(|&b| w.rules.actors[w.actors[b].ty as usize].building.as_ref().is_some_and(|x| x.refinery.is_some()))
        .count();
    let trucks = (0..w.actors.len()).filter(|&i| w.actors[i].alive && w.actors[i].owner == player && w.is_harvester(i)).count();
    let funds = w.players[player as usize].funds();
    reachable_resources(w, player) == 0 || (refineries == 0 && funds < 1400) || (trucks == 0 && funds < 1100)
}

/// While starving: drop queued items that do not fight on the ground
/// (structures other than power, defences, aircraft, ships), refunding what
/// was paid, so the money goes into the army.
pub(crate) fn cancel_luxuries(w: &mut World, player: u8) {
    for q in [QueueType::Building, QueueType::Defense, QueueType::Aircraft, QueueType::Ship] {
        let items: Vec<u16> = w.players[player as usize].queues[q as usize].items.iter().filter(|it| !it.done).map(|it| it.ty).collect();
        for ty in items {
            let power = w.rules.actors[ty as usize].building.as_ref().is_some_and(|b| b.power > 0);
            let truck = w.rules.actors[ty as usize].unit.as_ref().is_some_and(|u| u.harvester.is_some());
            if !power && !truck {
                w.cancel_production(player, ty);
            }
        }
    }
}

/// Sell one structure the AI can do without, when it is broke, earns nothing
/// and has (almost) no army. Returns whether it ordered a sale.
pub(crate) fn sell_when_broke(w: &mut World, player: u8) -> bool {
    let p = &w.players[player as usize];
    if p.funds() >= BROKE_FUNDS {
        return false;
    }
    let state = &w.ai[player as usize];
    if w.tick < state.last_sale + SELL_EVERY_TICKS {
        return false;
    }
    let army = (0..w.actors.len())
        .filter(|&i| {
            let a = &w.actors[i];
            a.alive && a.owner == player && a.kind != Kind::Building && is_army_unit(w, a.ty as usize)
        })
        .count();
    if army >= SMALL_ARMY || !no_income(w, player) {
        return false;
    }
    let Some(b) = surplus_structure(w, player) else { return false };
    let r = w.make_ref(b);
    w.queue_order(Order::Sell { player, building: r });
    w.ai[player as usize].last_sale = w.tick;
    true
}

/// The structure to sell first, or None when only the essentials are left.
fn surplus_structure(w: &World, player: u8) -> Option<usize> {
    let buildings = own_buildings(w, player);
    let info = |b: usize| &w.rules.actors[w.actors[b].ty as usize];
    let has_units = |kind: Kind| w.actors.iter().any(|a| a.alive && a.owner == player && a.kind == kind);
    let produces = |b: usize, q: QueueType| info(b).building.as_ref().is_some_and(|x| x.produces.contains(&q));
    // Keep the first producer of each of these queues (lowest index: deterministic).
    let mut kept: Vec<usize> = Vec::new();
    for q in [QueueType::Building, QueueType::Infantry, QueueType::Vehicle] {
        if let Some(&b) = buildings.iter().find(|&&b| produces(b, q)) {
            kept.push(b);
        }
    }
    let ore = reachable_resources(w, player) > 0;
    // Rank: lower sells first. Defences and walls are never sold.
    let rank = |b: usize| -> Option<u32> {
        let a = info(b);
        let bi = a.building.as_ref()?;
        if kept.contains(&b) || a.queue == QueueType::Defense || a.is_wall() || !a.weapons.is_empty() {
            return None;
        }
        if bi.refinery.is_some() || bi.storage > 0 {
            return if ore { None } else { Some(0) };
        }
        if produces(b, QueueType::Aircraft) {
            return if has_units(Kind::Aircraft) { None } else { Some(1) };
        }
        if produces(b, QueueType::Ship) {
            return if has_units(Kind::Ship) { None } else { Some(1) };
        }
        if bi.power > 0 {
            return Some(3);
        }
        // Tech centers, radar, service depot, second factories.
        Some(2)
    };
    let mut best: Option<(u32, i32, usize)> = None;
    for &b in &buildings {
        let Some(r) = rank(b) else { continue };
        // Power plants only while the rest keeps enough power.
        if r == 3 {
            let p = &w.players[player as usize];
            let power = info(b).building.as_ref().map_or(0, |x| x.power);
            if p.power_gen - power < p.power_use {
                continue;
            }
        }
        // Dearest first within a rank (more money back).
        let key = (r, -info(b).cost, b);
        if best.is_none_or(|bk| key < bk) {
            best = Some(key);
        }
    }
    best.map(|(_, _, b)| b)
}

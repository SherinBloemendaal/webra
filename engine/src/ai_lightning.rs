//! The skirmish AI and WebRA's Lightning Rod (lightning.rs; OpenRA's bots
//! have nothing like it). While thunderstorms can strike (the temperate
//! biome with `weather: full`) and once the first lightning of the game has
//! struck, a bot with at least [`MIN_PLANTS`] power plants builds a rod when
//! one of its plants stands unprotected and it has the money to spare
//! ([`FUNDS_RODS`] times the rod's cost), at most one rod per
//! [`PLANTS_PER_ROD`] plants and [`MAX_RODS`] in all. It places the rod
//! where it covers the most of its unprotected plants, within reach of the
//! first of them (a cell around it that leaves a gap for units, like its
//! other structures), else like any other structure.

use crate::ai::count_own;
use crate::rules::{Kind, QueueType};
use crate::world::World;

/// Power plants a bot owns before it builds a rod.
pub const MIN_PLANTS: usize = 2;
/// Power plants per rod.
pub const PLANTS_PER_ROD: usize = 3;
/// Rods a bot builds at most.
pub const MAX_RODS: usize = 3;
/// A bot builds a rod with at least this many times its cost in funds.
pub const FUNDS_RODS: i32 = 3;

/// Whether actor type `ty` is a Lightning Rod.
pub(crate) fn is_rod(w: &World, ty: u16) -> bool {
    w.rules.actors[ty as usize].building.as_ref().is_some_and(|b| b.lightning_rod > 0)
}

/// `player`'s own power plants (structures that make power).
fn own_plants(w: &World, player: u8) -> Vec<usize> {
    (0..w.actors.len())
        .filter(|&i| {
            let a = &w.actors[i];
            a.alive
                && a.in_world()
                && a.owner == player
                && a.kind == Kind::Building
                && w.rules.actors[a.ty as usize].building.as_ref().is_some_and(|b| b.power > 0)
        })
        .collect()
}

/// The Lightning Rod to build now, if any, from the `buildable` types.
pub(crate) fn wanted_rod(w: &World, player: u8, buildable: &[u16]) -> Option<u16> {
    // Only once lightning has struck in this game: the opening's money goes
    // into the economy, and a bot reacts to the sky like a player would.
    if !w.env.effects() || !w.env.biome.has_thunderstorms() || w.env.flash.is_none() {
        return None;
    }
    let rod = buildable.iter().copied().find(|&t| is_rod(w, t))?;
    let plants = own_plants(w, player);
    if plants.len() < MIN_PLANTS || w.players[player as usize].funds() < FUNDS_RODS * w.rules.actors[rod as usize].cost {
        return None;
    }
    let rods: Vec<u16> = (0..w.rules.actors.len() as u16).filter(|&t| is_rod(w, t)).collect();
    let queued = w.players[player as usize].queues[QueueType::Defense as usize].items.iter().filter(|it| rods.contains(&it.ty)).count();
    let limit = plants.len().div_ceil(PLANTS_PER_ROD).min(MAX_RODS);
    if count_own(w, player, &rods) + queued >= limit {
        return None;
    }
    plants.iter().any(|&p| !w.lightning_protected(w.actors[p].x, w.actors[p].y)).then_some(rod)
}

/// Where `player` places rod type `ty`: the top-left cell covering the most
/// of its unprotected power plants, near the first of them. None when no
/// plant is unprotected or nothing fits.
pub(crate) fn rod_location(w: &World, player: u8, ty: u16) -> Option<(i32, i32)> {
    let b = w.rules.actors[ty as usize].building.as_ref()?;
    let (range, bw, bh) = (b.lightning_rod, b.width, b.height);
    let open: Vec<(i32, i32)> =
        own_plants(w, player).into_iter().map(|p| (w.actors[p].x, w.actors[p].y)).filter(|&(x, y)| !w.lightning_protected(x, y)).collect();
    let &(fx, fy) = open.first()?;
    let covers = |x: i32, y: i32, (px, py): (i32, i32)| {
        let (dx, dy) = ((x - px) as i64, (y - py) as i64);
        dx * dx + dy * dy <= (range as i64) * (range as i64)
    };
    let (pcx, pcy) = w.cell_of(fx, fy);
    let reach = range / crate::math::CELL;
    let mut best: Option<(usize, i64, (i32, i32))> = None;
    for strict in [true, false] {
        for cy in pcy - reach..=pcy + reach {
            for cx in pcx - reach..=pcx + reach {
                let (x, y) = (crate::world::cell_center(cx), crate::world::cell_center(cy));
                if !covers(x, y, (fx, fy)) || !w.can_place(player, ty, cx, cy) {
                    continue;
                }
                if strict && !crate::ai_base::has_clearance(w, cx, cy, bw, bh) {
                    continue;
                }
                let n = open.iter().filter(|&&p| covers(x, y, p)).count();
                let d = crate::math::dist_sq(x, y, fx, fy);
                // Most plants covered, then nearest the first plant, then the scan order.
                if best.is_none_or(|(bn, bd, _)| n > bn || (n == bn && d < bd)) {
                    best = Some((n, d, (cx, cy)));
                }
            }
        }
        if best.is_some() {
            break;
        }
    }
    best.map(|b| b.2)
}

/// The power `player`'s plants make for the base builder (ai_base.rs): the
/// power meter, except during a blackout from lightning, when the bot counts
/// what its intact plants make once the 15 s are over instead of buying
/// power plants it does not need (and reaches the rod first). A spy's or a
/// mission's outage counts as OpenRA's bots see it (PowerManager.ExcessPower
/// drops while AffectedByPowerOutage disables the plants' Power trait).
pub(crate) fn power_gen(w: &World, player: u8) -> i32 {
    let p = &w.players[player as usize];
    if !w.lightning_blackout(player) {
        return p.power_gen;
    }
    let mut gen = p.power_gen;
    for a in &w.actors {
        if !a.alive || a.owner != player || a.kind != Kind::Building || a.powered_off || !w.outage_disabled_at(a) {
            continue;
        }
        let info = &w.rules.actors[a.ty as usize];
        if let Some(b) = info.building.as_ref().filter(|b| b.power > 0) {
            gen += if b.power_scales_with_health { b.power * a.hp / info.hp.max(1) } else { b.power };
        }
    }
    gen
}

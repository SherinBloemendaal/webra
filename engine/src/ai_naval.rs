//! WebRA additions to OpenRA's bots: which bodies of water reach an enemy.
//!
//! OpenRA's bots build naval yards wherever the base has water and ships
//! by their UnitsToBuild shares, whether or not the water leads anywhere:
//! on a lake, or on a river stretch between two fords, the fleet idles at
//! its yard for the rest of the game while every ship it builds joins it.
//! WebRA's bots only build naval yards on water from which their warships
//! can hit an enemy (ai_base.rs), launch their ships onto such water (the
//! yard's rally point) from a yard made primary, and only build warships
//! that leave onto water reaching an enemy
//! (ai_units.rs), and keep one naval squad per body of water (ai_squads.rs). "Reach" is OpenRA's own test for squad targets
//! (FindEnemies): a point within weapon range of the enemy, or the enemy
//! itself, on water connected to the ship's; within the ship's sight for an
//! enemy out of sight (ai.rs `attack_offset`).

use crate::ai::{is_preferred_enemy_with, reach_offset};
use crate::ai_bots::BotConfig;
use crate::rules::{Domain, Kind, QueueType};
use crate::world::World;

/// Whether actor type `ty` moves on water.
pub(crate) fn is_ship_type(w: &World, ty: u16) -> bool {
    w.rules.actors[ty as usize].unit.as_ref().is_some_and(|u| w.rules.locomotors[u.locomotor].domain == Domain::Water)
}

/// The warship types the bot's squads use (NavalUnitsTypes with a weapon).
pub(crate) fn warship_types(w: &World, cfg: &BotConfig) -> Vec<u16> {
    cfg.naval_units.iter().copied().filter(|&t| is_ship_type(w, t) && !w.rules.actors[t as usize].weapons.is_empty()).collect()
}

/// Water connectivity labels of the open water cells around a structure
/// footprint of `width` by `height` cells at top-left (`cx`, `cy`): where
/// the ships it launches start.
pub(crate) fn water_around(w: &World, cx: i32, cy: i32, width: i32, height: i32) -> Vec<u32> {
    let pass = &w.pass_water;
    let mut out = Vec::new();
    for y in cy - 1..=cy + height {
        for x in cx - 1..=cx + width {
            let inside = (cx..cx + width).contains(&x) && (cy..cy + height).contains(&y);
            if inside || !w.map.contains(x, y) {
                continue;
            }
            let c = w.map.idx(x, y);
            if !pass.blocked[c] && !out.contains(&pass.component[c]) {
                out.push(pass.component[c]);
            }
        }
    }
    out.sort_unstable();
    out
}

/// `water_around` an existing structure.
pub(crate) fn water_around_building(w: &World, b: usize) -> Vec<u32> {
    let a = &w.actors[b];
    let Some(info) = w.rules.actors[a.ty as usize].building.as_ref() else { return Vec::new() };
    water_around(w, a.cx, a.cy, info.width, info.height)
}

/// The answers of `in_reach` during one bot tick. The world does not change
/// while a bot thinks (its orders run later), except for the targets its
/// naval squads give up on (`invalidate`), so every client computes the
/// same. Not part of `state_hash`, like the rest of the AI state.
#[derive(Clone, Default, Debug)]
pub(crate) struct ReachCache {
    tick: u32,
    /// Enemy structures and ships warships may go for (`enemy_targets`).
    targets: Option<Vec<usize>>,
    /// Ship type, water label and whether an enemy is in reach from there.
    known: Vec<(u16, u32, bool)>,
}

/// Forget the cached answers (a target was given up on, ai_squads.rs).
pub(crate) fn invalidate(w: &mut World, player: u8) {
    let c = &mut w.ai[player as usize].reach;
    c.targets = None;
    c.known.clear();
}

/// The enemy structures and ships `player`'s warships may go for: preferred
/// enemies (ai.rs) the naval squads did not give up on as out of sight.
/// Enemy ground units do not count: one passing by the shore is no reason
/// for a fleet.
fn enemy_targets(w: &World, player: u8, cfg: &BotConfig) -> Vec<usize> {
    // Who still has structures, counted once (`is_preferred_enemy` would
    // count it for every candidate).
    let mut has = vec![false; w.players.len()];
    for a in w.actors.iter().filter(|a| a.alive && a.kind == Kind::Building) {
        if let Some(h) = has.get_mut(a.owner as usize) {
            *h = true;
        }
    }
    (0..w.actors.len())
        .filter(|&t| {
            w.actors[t].alive
                && matches!(w.actors[t].kind, Kind::Building | Kind::Ship)
                && is_preferred_enemy_with(w, player, t, cfg.ignored_targets, |p| has.get(p as usize).copied().unwrap_or(false))
                && !crate::ai_squads::naval_blind(w, player, t)
        })
        .collect()
}

/// Whether a ship of type `ty` on water `comp` could attack one of `targets`
/// (OpenRA FindEnemies with the type's weapon ranges).
fn reaches_any(w: &World, player: u8, ty: u16, comp: u32, targets: &[usize]) -> bool {
    let info = &w.rules.actors[ty as usize];
    targets.iter().any(|&t| info.can_attack_class(&w.rules, w.target_class(t)) && reach_offset(w, player, ty, comp, t).is_some())
}

/// Whether a ship of type `ty` on water `comp` could attack an enemy
/// structure or ship (`enemy_targets`), computed afresh (tests; the bots
/// ask `in_reach`).
#[cfg(test)]
pub(crate) fn enemy_in_reach(w: &World, player: u8, cfg: &BotConfig, ty: u16, comp: u32) -> bool {
    reaches_any(w, player, ty, comp, &enemy_targets(w, player, cfg))
}

/// `enemy_in_reach`, answered once per bot tick (`ReachCache`).
pub(crate) fn in_reach(w: &mut World, player: u8, cfg: &BotConfig, ty: u16, comp: u32) -> bool {
    let tick = w.tick;
    let c = &mut w.ai[player as usize].reach;
    if c.tick != tick {
        *c = ReachCache { tick, ..ReachCache::default() };
    }
    if let Some(&(_, _, r)) = c.known.iter().find(|k| k.0 == ty && k.1 == comp) {
        return r;
    }
    let targets = match c.targets.take() {
        Some(t) => t,
        None => enemy_targets(w, player, cfg),
    };
    let r = reaches_any(w, player, ty, comp, &targets);
    let c = &mut w.ai[player as usize].reach;
    c.targets = Some(targets);
    c.known.push((ty, comp, r));
    r
}

/// Of the water labels `comps`, those from which one of the warship types
/// `types` can attack an enemy.
pub(crate) fn reaching(w: &mut World, player: u8, cfg: &BotConfig, types: &[u16], comps: &[u32]) -> Vec<u32> {
    comps.iter().copied().filter(|&c| types.iter().any(|&ty| in_reach(w, player, cfg, ty, c))).collect()
}

/// The player's structures that build actor type `ty` (production.rs
/// `producers_of`), the one new units leave first: the primary one, else
/// the first (production.rs `spawn_produced`).
fn producers(w: &World, player: u8, ty: u16) -> Vec<usize> {
    let mut out = w.producers_of(player, ty);
    if let Some(k) = out.iter().position(|&b| w.actors[b].primary) {
        let p = out.remove(k);
        out.insert(0, p);
    }
    out
}

/// Whether a warship of type `ty` launched from yard `b` (onto the water
/// naval.rs `naval_spawn_cell` picks) could attack an enemy.
fn launches_into_reach(w: &mut World, player: u8, cfg: &BotConfig, ty: u16, b: usize) -> bool {
    let Some((x, y, _)) = w.naval_spawn_cell(b, ty) else { return false };
    let c = w.pass_water.component[w.map.idx(x, y)];
    in_reach(w, player, cfg, ty, c)
}

/// A yard touching several bodies of water launches its ships onto the one
/// with its rally point, else onto the largest (naval.rs). The bot puts the
/// rally point of each of its yards on water from which its warships can
/// hit an enemy, when the yard touches such water (OpenRA's bots give
/// naval yards no rally point).
fn rally_yards(w: &mut World, player: u8, cfg: &BotConfig) {
    let types = warship_types(w, cfg);
    let yards: Vec<usize> = (0..w.actors.len())
        .filter(|&i| {
            let a = &w.actors[i];
            a.alive
                && a.owner == player
                && a.kind == Kind::Building
                && w.rules.actors[a.ty as usize].building.as_ref().is_some_and(|b| b.produces.contains(&QueueType::Ship))
        })
        .collect();
    for b in yards {
        let around = water_around_building(w, b);
        let reach = reaching(w, player, cfg, &types, &around);
        let current = w.actors[b].rally.map(|(x, y)| w.cell_index(x, y)).filter(|&c| !w.pass_water.blocked[c]);
        if current.is_some_and(|c| reach.contains(&w.pass_water.component[c])) {
            continue;
        }
        if let Some((x, y)) = reach.first().and_then(|&comp| dock_cell(w, b, comp)) {
            w.actors[b].rally = Some((crate::world::cell_center(x), crate::world::cell_center(y)));
        }
    }
}

/// Whether the next warship of type `ty` the player builds could attack an
/// enemy from the water of the yard it leaves (ai_units.rs builds it only then).
pub(crate) fn warship_useful(w: &mut World, player: u8, cfg: &BotConfig, ty: u16) -> bool {
    match producers(w, player, ty).first() {
        Some(&b) => launches_into_reach(w, player, cfg, ty, b),
        None => false,
    }
}

/// Rally points first (`rally_yards`). When the yard the next warship of one of the bot's types would leave
/// launches it onto water that reaches no enemy, and another yard that
/// builds it does, the bot makes that one its primary yard (the Deploy
/// order, primary.rs), so the fleet is built where it can fight.
pub(crate) fn choose_primary_yard(w: &mut World, player: u8, cfg: &BotConfig) {
    rally_yards(w, player, cfg);
    let mut chosen: Vec<usize> = Vec::new();
    for ty in warship_types(w, cfg) {
        if !w.can_start(player, ty) {
            continue;
        }
        let yards = producers(w, player, ty);
        let Some(&next) = yards.first() else { continue };
        if chosen.contains(&next) || launches_into_reach(w, player, cfg, ty, next) {
            continue;
        }
        let useful = yards[1..].iter().copied().find(|&b| launches_into_reach(w, player, cfg, ty, b));
        if let Some(b) = useful {
            if !chosen.contains(&b) {
                chosen.push(b);
                let r = w.make_ref(b);
                w.queue_order(crate::world::Order::Deploy { player, ids: vec![r] });
            }
        }
    }
}

/// An open water cell with label `comp` next to own ship producer `b`
/// (where a retreating fleet waits), if `b` is one and has such a cell.
pub(crate) fn dock_cell(w: &World, b: usize, comp: u32) -> Option<(i32, i32)> {
    let a = &w.actors[b];
    let info = w.rules.actors[a.ty as usize].building.as_ref()?;
    if !info.produces.contains(&QueueType::Ship) {
        return None;
    }
    let pass = &w.pass_water;
    for y in a.cy - 1..=a.cy + info.height {
        for x in a.cx - 1..=a.cx + info.width {
            if w.map.contains(x, y) && {
                let c = w.map.idx(x, y);
                !pass.blocked[c] && pass.component[c] == comp
            } {
                return Some((x, y));
            }
        }
    }
    None
}

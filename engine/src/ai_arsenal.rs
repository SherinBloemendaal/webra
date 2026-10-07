//! Skirmish AI, the rest of the arsenal (called from `ai::think`): aircraft,
//! ships, unit abilities and superweapons.
//!
//! Like the rest of the AI it plays by the player's rules: it only shoots at
//! what it can target (visible, not cloaked), it knows where enemy structures
//! are (like most skirmish AIs) but not where hidden units are, and it never
//! aims at allies or neutral actors. Every helper is integer math and walks
//! the actor list a bounded number of times per think, so the AI stays cheap.
//!
//! Difficulty sets how much of the arsenal is used ([`Arsenal`]): Easy flies
//! one helicopter and sails one ship; Normal adds planes, mines, a radar
//! jammer, MAD tanks or demolition trucks, and superweapons after a quarter of
//! an hour; Hard builds more of everything and its superweapons right after
//! the base.

use crate::ai::{
    base_point, build_order_done, building_for, densest_buildings, is_live_enemy, owned_buildings, rally_point, DEFEND_RADIUS,
};
use crate::math::{dist, dist_sq, CELL};
use crate::rules::{Kind, QueueType, TARGET_AIR};
use crate::world::{cell_center, Activity, AiDifficulty, Order, World, TICKS_PER_SECOND};

const MINUTE: u32 = 60 * TICKS_PER_SECOND;
/// Mines per field: one Minelayer load (it carries five).
const FIELD: i32 = 2;

/// How much of the arsenal a difficulty uses.
pub(crate) struct Arsenal {
    /// Helipads and airfields to build once the base stands.
    pub helipads: usize,
    pub airfields: usize,
    /// Armed aircraft and warships to keep.
    pub aircraft: usize,
    pub ships: usize,
    /// Minefields to lay around the base.
    pub minefields: usize,
    /// MAD tanks or demolition trucks (one at a time) and a radar jammer, from this tick on.
    pub specials_from: Option<u32>,
    /// Superweapons and the gap generator, from this tick on (after the build order).
    pub superweapons_from: Option<u32>,
    /// Anti-air structures to add once enemy aircraft were seen.
    pub anti_air: usize,
    /// Most enemy anti-air weapons an aircraft attacks into.
    pub aa_tolerance: usize,
    /// Money kept back when buying arsenal items.
    pub reserve: i32,
}

pub(crate) fn arsenal(d: AiDifficulty) -> Arsenal {
    match d {
        AiDifficulty::Easy => Arsenal {
            helipads: 1,
            airfields: 0,
            aircraft: 1,
            ships: 1,
            minefields: 0,
            specials_from: None,
            superweapons_from: None,
            anti_air: 0,
            aa_tolerance: 3,
            reserve: 2000,
        },
        AiDifficulty::Normal => Arsenal {
            helipads: 1,
            airfields: 1,
            aircraft: 3,
            ships: 3,
            minefields: 2,
            specials_from: Some(15 * MINUTE),
            superweapons_from: Some(15 * MINUTE),
            anti_air: 1,
            aa_tolerance: 1,
            reserve: 1500,
        },
        AiDifficulty::Hard => Arsenal {
            helipads: 2,
            airfields: 2,
            aircraft: 6,
            ships: 5,
            minefields: 3,
            specials_from: Some(0),
            superweapons_from: Some(0),
            anti_air: 2,
            aa_tolerance: 1,
            reserve: 1000,
        },
    }
}

fn my_arsenal(w: &World, player: u8) -> Arsenal {
    arsenal(w.ai[player as usize].difficulty)
}

// ---- Shared helpers -------------------------------------------------------------

/// Whether `player` can ever get actor type `ty`: its faction can, and the
/// tech level allows it (tech level tokens never change during a game).
fn obtainable(w: &World, player: u8, ty: usize) -> bool {
    let p = &w.players[player as usize];
    w.rules.obtainable[p.faction][ty]
        && w.rules.actors[ty]
            .prerequisites
            .iter()
            .all(|pr| !w.rules.tokens[pr.token as usize].starts_with("techlevel.") || p.tokens[pr.token as usize] != pr.negate)
}

fn armed(w: &World, ty: usize) -> bool {
    !w.rules.actors[ty].weapons.is_empty()
}

/// Own living actors matching `f`.
fn own<F: Fn(&World, usize) -> bool>(w: &World, player: u8, f: F) -> Vec<usize> {
    (0..w.actors.len()).filter(|&i| w.actors[i].alive && w.actors[i].owner == player && f(w, i)).collect()
}

/// Building types that produce `queue` items of `build_at` (e.g. helipads: Aircraft / Helicopter).
fn producer_types(w: &World, queue: QueueType, build_at: &str) -> Vec<usize> {
    (0..w.rules.actors.len())
        .filter(|&t| {
            w.rules.actors[t]
                .building
                .as_ref()
                .is_some_and(|b| b.produces.contains(&queue) && b.production_types.iter().any(|p| p == build_at))
        })
        .collect()
}

/// Whether an armed unit built at `build_at` (e.g. "Helicopter") is obtainable for `player`.
fn armed_unit_obtainable(w: &World, player: u8, queue: QueueType, build_at: &str) -> bool {
    (0..w.rules.actors.len()).any(|t| {
        let info = &w.rules.actors[t];
        info.queue == queue && info.build_at == build_at && armed(w, t) && obtainable(w, player, t)
    })
}

/// Damage per minute-ish of unit type `ty` against armour `armor` (versus table
/// applied), from the weapons that can hit target classes `class`.
fn firepower(w: &World, ty: usize, armor: usize, class: u32) -> i64 {
    w.rules.actors[ty]
        .weapons
        .iter()
        .map(|&wi| &w.rules.weapons[wi])
        .filter(|wp| wp.can_target_class(class))
        .map(|wp| {
            let per_shot: i64 =
                wp.warheads.iter().map(|h| h.damage as i64 * h.versus.get(armor).copied().unwrap_or(100) as i64 / 100).sum();
            per_shot * wp.burst.max(1) as i64 * 1000 / wp.reload.max(1) as i64
        })
        .max()
        .unwrap_or(0)
}

/// What the enemy fields, as cost per (armour, target class): its structures
/// (known) and the units `player` can target right now.
fn enemy_mix(w: &World, player: u8) -> Vec<(usize, u32, i64)> {
    let mut mix: Vec<(usize, u32, i64)> = Vec::new();
    for i in 0..w.actors.len() {
        let a = &w.actors[i];
        if !a.alive || a.kind == Kind::Mine || !is_live_enemy(w, player, a.owner) {
            continue;
        }
        if a.kind != Kind::Building && !(a.in_world() && w.targetable(i, player)) {
            continue;
        }
        let info = &w.rules.actors[a.ty as usize];
        if info.is_wall() {
            continue;
        }
        let class = w.target_class(i);
        let cost = info.cost.max(100) as i64;
        match mix.iter_mut().find(|m| m.0 == info.armor && m.1 == class) {
            Some(m) => m.2 += cost,
            None => mix.push((info.armor, class, cost)),
        }
    }
    mix
}

/// The best unit to buy from `candidates` against the enemy mix: most
/// firepower against what the enemy fields, per cost, among affordable types.
fn best_against(w: &World, candidates: &[usize], mix: &[(usize, u32, i64)], funds: i32) -> Option<usize> {
    candidates.iter().copied().filter(|&t| w.rules.actors[t].cost <= funds).max_by_key(|&t| {
        let score: i64 = mix.iter().map(|&(armor, class, cost)| firepower(w, t, armor, class) * cost).sum();
        // Prefer the stronger unit; break ties toward the more expensive (tougher) one.
        (score / w.rules.actors[t].cost.max(1) as i64, w.rules.actors[t].cost, std::cmp::Reverse(t))
    })
}

/// Enabled types of `queue` (and `build_at`, when given) that are armed.
fn armed_types(w: &World, player: u8, queue: QueueType, build_at: Option<&str>) -> Vec<usize> {
    (0..w.rules.actors.len())
        .filter(|&t| {
            let info = &w.rules.actors[t];
            info.queue == queue && build_at.is_none_or(|b| info.build_at == b) && armed(w, t) && w.availability(player, t as u16).enabled
        })
        .collect()
}

/// Water component (ship passability) of a cell, or None on land.
fn water_component(w: &World, x: i32, y: i32) -> Option<u32> {
    let ci = w.cell_index(x, y);
    (!w.pass_water.blocked[ci]).then(|| w.pass_water.component[ci])
}

// ---- Buildings ------------------------------------------------------------------

/// The next arsenal structure for the Building queue once the build order is
/// done: helipads, a naval yard where the base reaches useful water, airfields.
pub(crate) fn next_building(w: &mut World, player: u8) -> Option<u16> {
    let ars = my_arsenal(w, player);
    let funds = w.players[player as usize].funds();
    let count_of = |w: &World, types: &[usize]| own(w, player, |w, i| types.contains(&(w.actors[i].ty as usize))).len();
    let cheapest_enabled = |w: &World, types: &[usize]| {
        types.iter().copied().filter(|&t| w.availability(player, t as u16).enabled).min_by_key(|&t| (w.rules.actors[t].cost, t))
    };
    let pads = producer_types(w, QueueType::Aircraft, "Helicopter");
    let fields = producer_types(w, QueueType::Aircraft, "Plane");
    let (have_pads, have_fields) = (count_of(w, &pads), count_of(w, &fields));
    let heli_ok = armed_unit_obtainable(w, player, QueueType::Aircraft, "Helicopter");
    let plane_ok = armed_unit_obtainable(w, player, QueueType::Aircraft, "Plane");
    // One aircraft structure at a time: the next once the last one has its aircraft.
    let flying = own(w, player, |w, i| w.actors[i].kind == Kind::Aircraft && armed(w, w.actors[i].ty as usize)).len();
    let air_ok = have_pads + have_fields <= flying;
    let mut wanted: Vec<usize> = Vec::new();
    if air_ok && heli_ok && have_pads < ars.helipads.min(1) {
        wanted.extend(cheapest_enabled(w, &pads));
    }
    if ars.ships > 0 && !has_naval_yard(w, player) {
        if let Some(t) = naval_yard_type(w, player) {
            if naval_site(w, player, t as u16).is_some() {
                wanted.push(t);
            }
        }
    }
    if air_ok && plane_ok && have_fields < ars.airfields {
        wanted.extend(cheapest_enabled(w, &fields));
    }
    if air_ok && heli_ok && have_pads < ars.helipads {
        wanted.extend(cheapest_enabled(w, &pads));
    }
    // Production pays as it goes, like the build order (half the cost up front).
    let t = *wanted.first()?;
    (funds >= w.rules.actors[t].cost / 2 + ars.reserve / 2).then_some(t as u16)
}

fn has_naval_yard(w: &World, player: u8) -> bool {
    w.actors.iter().any(|a| {
        a.alive
            && a.owner == player
            && a.kind == Kind::Building
            && w.rules.actors[a.ty as usize].building.as_ref().is_some_and(|b| b.on_water && b.produces.contains(&QueueType::Ship))
    })
}

/// The naval yard type `player` can build now whose ships are armed.
fn naval_yard_type(w: &World, player: u8) -> Option<usize> {
    (0..w.rules.actors.len())
        .filter(|&t| {
            let Some(b) = w.rules.actors[t].building.as_ref() else { return false };
            b.on_water
                && b.produces.contains(&QueueType::Ship)
                && w.availability(player, t as u16).enabled
                && b.production_types.iter().any(|p| armed_unit_obtainable(w, player, QueueType::Ship, p))
        })
        .min_by_key(|&t| (w.rules.actors[t].cost, t))
}

/// Where a naval yard of type `ty` can go: water inside the build area,
/// in a body of water that reaches an enemy base (ships there can fight).
/// Cached for half a minute: the scan covers the whole build area.
pub(crate) fn naval_site(w: &mut World, player: u8, ty: u16) -> Option<(i32, i32)> {
    let state = &w.ai[player as usize];
    if w.tick < state.naval_checked_at + 30 * TICKS_PER_SECOND && state.naval_checked_at > 0 {
        return state.naval_site;
    }
    let site = find_naval_site(w, player, ty);
    let state = &mut w.ai[player as usize];
    state.naval_checked_at = w.tick.max(1);
    state.naval_site = site;
    site
}

fn find_naval_site(w: &World, player: u8, ty: u16) -> Option<(i32, i32)> {
    let (sx, sy) = w.players[player as usize].start;
    let b = w.rules.actors[ty as usize].building.as_ref()?;
    let mut useful: Vec<(u32, bool)> = Vec::new();
    for r in 0i32..18 {
        for dy in -r..=r {
            for dx in -r..=r {
                if dx.abs() != r && dy.abs() != r {
                    continue;
                }
                let (cx, cy) = (sx + dx, sy + dy);
                if !w.can_place(player, ty, cx, cy) {
                    continue;
                }
                let centre = (cx * CELL + b.width * CELL / 2, cy * CELL + b.height * CELL / 2);
                let Some(comp) = water_component(w, centre.0, centre.1) else { continue };
                let ok = match useful.iter().find(|u| u.0 == comp) {
                    Some(u) => u.1,
                    None => {
                        let ok = water_reaches_enemy(w, player, comp);
                        useful.push((comp, ok));
                        ok
                    }
                };
                if ok {
                    return Some((cx, cy));
                }
            }
        }
    }
    None
}

/// Whether water component `comp` comes within 14 cells of an enemy base or
/// holds an enemy naval yard: ships launched there can reach the enemy.
fn water_reaches_enemy(w: &World, player: u8, comp: u32) -> bool {
    const REACH: i32 = 14;
    (0..w.players.len() as u8).filter(|&p| is_live_enemy(w, player, p)).any(|p| {
        let (bx, by) = base_point(w, p);
        let (cx, cy) = w.cell_of(bx, by);
        (cy - REACH..=cy + REACH).any(|y| {
            (cx - REACH..=cx + REACH).any(|x| {
                w.map.contains(x, y) && {
                    let ci = w.map.idx(x, y);
                    !w.pass_water.blocked[ci] && w.pass_water.component[ci] == comp
                }
            })
        })
    })
}

/// The next superweapon or gap generator for the Defense queue, and power
/// first when it would overload the grid.
pub(crate) fn next_superweapon(w: &mut World, player: u8) -> Option<u16> {
    let ars = my_arsenal(w, player);
    let from = ars.superweapons_from?;
    if w.tick < from || !build_order_done(w, player) {
        return None;
    }
    let owned_types: Vec<u16> = owned_buildings(w, player).iter().map(|&b| w.actors[b].ty).collect();
    let candidate = (0..w.rules.actors.len())
        .filter(|&t| {
            let info = &w.rules.actors[t];
            let special = info.abilities.creates_shroud.is_some()
                || info.abilities.support_powers.as_ref().is_some_and(|l| {
                    l.iter().any(|p| matches!(p.kind.as_str(), "ChronoshiftPower" | "GrantExternalConditionPower" | "NukePower"))
                });
            info.queue == QueueType::Defense && special && !owned_types.contains(&(t as u16)) && w.availability(player, t as u16).enabled
        })
        .min_by_key(|&t| (w.rules.actors[t].cost, t))?;
    let info = &w.rules.actors[candidate];
    let draw = -info.building.as_ref().map_or(0, |b| b.power).min(0);
    let p = &w.players[player as usize];
    if p.power_gen - p.power_use < draw + 20 {
        // Power plant first (in the Building queue), then the superweapon.
        let bq = QueueType::Building as usize;
        if p.queues[bq].items.is_empty() && w.has_producer(player, QueueType::Building) {
            if let Some(power) = building_for(w, player, "anypower") {
                if p.funds() >= w.rules.actors[power as usize].cost {
                    w.start_production(player, power, 1);
                }
            }
        }
        return None;
    }
    (w.players[player as usize].funds() >= info.cost / 2 + ars.reserve / 2).then_some(candidate as u16)
}

/// One or two anti-air structures once enemy aircraft were seen.
pub(crate) fn next_anti_air_defense(w: &World, player: u8) -> Option<u16> {
    let ars = my_arsenal(w, player);
    if !w.ai[player as usize].seen_air || ars.anti_air == 0 {
        return None;
    }
    let is_aa = |w: &World, t: usize| {
        let info = &w.rules.actors[t];
        info.queue == QueueType::Defense && info.can_attack_class(&w.rules, TARGET_AIR) && !info.is_wall()
    };
    let have = own(w, player, |w, i| is_aa(w, w.actors[i].ty as usize)).len();
    if have >= ars.anti_air {
        return None;
    }
    let best = (0..w.rules.actors.len())
        .filter(|&t| is_aa(w, t) && w.availability(player, t as u16).enabled)
        .max_by_key(|&t| (w.rules.actors[t].cost, std::cmp::Reverse(t)))?;
    (w.players[player as usize].funds() >= w.rules.actors[best].cost + ars.reserve / 2).then_some(best as u16)
}

// ---- Units ----------------------------------------------------------------------

/// Note armed enemy aircraft the AI can see (then it adds anti-air).
pub(crate) fn watch_the_sky(w: &mut World, player: u8) {
    if w.ai[player as usize].seen_air {
        return;
    }
    let seen = (0..w.actors.len()).any(|i| {
        let a = &w.actors[i];
        a.alive
            && a.kind == Kind::Aircraft
            && armed(w, a.ty as usize)
            && !w.is_support_aircraft(i)
            && is_live_enemy(w, player, a.owner)
            && w.targetable(i, player)
    });
    w.ai[player as usize].seen_air = seen;
}

/// Anti-air infantry when enemy aircraft are about and the army has little anti-air.
pub(crate) fn anti_air_infantry(w: &World, player: u8, army: usize) -> Option<u16> {
    if !w.ai[player as usize].seen_air {
        return None;
    }
    let aa_units = own(w, player, |w, i| {
        let a = &w.actors[i];
        matches!(a.kind, Kind::Infantry | Kind::Vehicle) && w.rules.actors[a.ty as usize].can_attack_class(&w.rules, TARGET_AIR)
    })
    .len();
    if aa_units * 4 >= army.max(4) {
        return None;
    }
    armed_types(w, player, QueueType::Infantry, None)
        .into_iter()
        .filter(|&t| w.rules.actors[t].can_attack_class(&w.rules, TARGET_AIR))
        .min_by_key(|&t| (w.rules.actors[t].cost, t))
        .map(|t| t as u16)
}

/// Queue aircraft: one per helipad or airfield (each rearms one), up to the
/// difficulty's count, the type that hurts the enemy mix most.
pub(crate) fn queue_aircraft(w: &mut World, player: u8) {
    let aq = QueueType::Aircraft as usize;
    if !w.players[player as usize].queues[aq].items.is_empty() || !w.has_producer(player, QueueType::Aircraft) {
        return;
    }
    let ars = my_arsenal(w, player);
    let flying = own(w, player, |w, i| w.actors[i].kind == Kind::Aircraft && armed(w, w.actors[i].ty as usize)).len();
    if flying >= ars.aircraft {
        return;
    }
    let mix = enemy_mix(w, player);
    let budget = unit_budget(w, player, &ars);
    let mut options: Vec<usize> = Vec::new();
    for kind in ["Helicopter", "Plane"] {
        let pads = producer_types(w, QueueType::Aircraft, kind);
        let have_pads = own(w, player, |w, i| pads.contains(&(w.actors[i].ty as usize))).len();
        let have = own(w, player, |w, i| {
            let info = &w.rules.actors[w.actors[i].ty as usize];
            w.actors[i].kind == Kind::Aircraft && info.build_at == kind && armed(w, w.actors[i].ty as usize)
        })
        .len();
        if have < have_pads {
            options.extend(armed_types(w, player, QueueType::Aircraft, Some(kind)));
        }
    }
    if let Some(t) = best_against(w, &options, &mix, budget) {
        w.start_production(player, t as u16, 1);
    }
}

/// The most a unit may cost to be queued now: production pays as it goes, so
/// half the price up front, keeping a third of the reserve back.
fn unit_budget(w: &World, player: u8, ars: &Arsenal) -> i32 {
    (w.players[player as usize].funds() - ars.reserve / 3) * 2
}

/// Queue warships at a naval yard, up to the difficulty's count:
/// submarines and destroyers when the enemy has ships, else what hurts its
/// structures and units most.
pub(crate) fn queue_ships(w: &mut World, player: u8) {
    let sq = QueueType::Ship as usize;
    if !w.players[player as usize].queues[sq].items.is_empty() || !w.has_producer(player, QueueType::Ship) {
        return;
    }
    let ars = my_arsenal(w, player);
    let ships = own(w, player, |w, i| w.actors[i].kind == Kind::Ship && armed(w, w.actors[i].ty as usize)).len();
    if ships >= ars.ships {
        return;
    }
    let options = armed_types(w, player, QueueType::Ship, None);
    let mix = enemy_mix(w, player);
    if let Some(t) = best_against(w, &options, &mix, unit_budget(w, player, &ars)) {
        w.start_production(player, t as u16, 1);
    }
}

/// A special vehicle for the Vehicle queue, if one is due: a Minelayer while
/// minefields are missing, a radar jammer, a MAD tank or demolition truck
/// (one at a time, a few minutes apart).
pub(crate) fn special_vehicle(w: &World, player: u8) -> Option<u16> {
    let ars = my_arsenal(w, player);
    let state = &w.ai[player as usize];
    let budget = unit_budget(w, player, &ars);
    let affordable = |t: usize| w.rules.actors[t].cost <= budget;
    let enabled_with = |f: &dyn Fn(&crate::rules::Abilities) -> bool| {
        (0..w.rules.actors.len())
            .filter(|&t| {
                let info = &w.rules.actors[t];
                info.queue == QueueType::Vehicle && f(&info.abilities) && w.availability(player, t as u16).enabled
            })
            .min_by_key(|&t| (w.rules.actors[t].cost, t))
    };
    let own_with =
        |f: &dyn Fn(&crate::rules::Abilities) -> bool| own(w, player, |w, i| f(&w.rules.actors[w.actors[i].ty as usize].abilities)).len();
    if state.minefields.len() < ars.minefields && own_with(&|a| a.minelayer.is_some()) == 0 {
        if let Some(t) = enabled_with(&|a| a.minelayer.is_some()).filter(|&t| affordable(t)) {
            return Some(t as u16);
        }
    }
    let from = ars.specials_from?;
    if w.tick < from {
        return None;
    }
    if own_with(&|a| a.jams_missiles.is_some()) == 0 {
        if let Some(t) = enabled_with(&|a| a.jams_missiles.is_some()).filter(|&t| affordable(t)) {
            return Some(t as u16);
        }
    }
    let boom = |a: &crate::rules::Abilities| a.mad_tank.is_some() || a.demo_truck.is_some();
    if w.tick >= state.next_special_at && own_with(&boom) == 0 {
        if let Some(t) = enabled_with(&boom).filter(|&t| affordable(t)) {
            return Some(t as u16);
        }
    }
    None
}

/// Called when a special vehicle was queued: space the next one out.
pub(crate) fn special_queued(w: &mut World, player: u8, ty: u16) {
    let ab = &w.rules.actors[ty as usize].abilities;
    if ab.mad_tank.is_some() || ab.demo_truck.is_some() {
        w.ai[player as usize].next_special_at = w.tick + 4 * MINUTE;
    }
}

// ---- Aircraft -------------------------------------------------------------------

/// Armed aircraft attack the most valuable target they hurt most, away from
/// heavy anti-air; empty or idle ones fly home to rearm.
pub(crate) fn command_aircraft(w: &mut World, player: u8) {
    let aircraft = own(w, player, |w, i| {
        let a = &w.actors[i];
        a.kind == Kind::Aircraft && a.in_world() && armed(w, a.ty as usize) && !w.is_support_aircraft(i) && a.altitude >= 0
    });
    if aircraft.is_empty() {
        return;
    }
    let mut ready: Vec<usize> = Vec::new();
    for &i in &aircraft {
        let a = &w.actors[i];
        if a.activity != Activity::Idle {
            continue;
        }
        let (ammo, max) = if w.is_helicopter(i) { w.heli_ammo(i) } else { (w.ammo_left(i), w.max_ammo(i)) };
        let landed = a.altitude == 0;
        if ammo >= max || max == 0 {
            ready.push(i);
        } else if !landed && a.heli.task == crate::helicopter::HeliTask::None {
            // Idle in the air with rounds spent: go home and rearm.
            let r = w.make_ref(i);
            w.queue_order(Order::ReturnToBase { player, ids: vec![r] });
        }
    }
    if ready.is_empty() {
        return;
    }
    let ars = my_arsenal(w, player);
    let base = base_point(w, player);
    // Visible enemy anti-air: (x, y, reach).
    let mut aa: Vec<(i32, i32, i32)> = Vec::new();
    let mut targets: Vec<usize> = Vec::new();
    for i in 0..w.actors.len() {
        let a = &w.actors[i];
        if !a.alive || !a.in_world() || a.kind == Kind::Mine || !is_live_enemy(w, player, a.owner) || !w.targetable(i, player) {
            continue;
        }
        let info = &w.rules.actors[a.ty as usize];
        if info.is_wall() {
            continue;
        }
        if info.can_attack_class(&w.rules, TARGET_AIR) && !(a.kind == Kind::Building && w.is_powered_down(i)) {
            aa.push((a.x, a.y, info.max_range(&w.rules) + 2 * CELL));
        }
        targets.push(i);
    }
    for i in ready {
        let ty = w.actors[i].ty as usize;
        let (x, y) = (w.actors[i].x, w.actors[i].y);
        let mut best: Option<(i64, usize)> = None;
        for &t in &targets {
            let ta = &w.actors[t];
            let class = w.target_class(t);
            let info = &w.rules.actors[ta.ty as usize];
            let fp = firepower(w, ty, info.armor, class);
            if fp == 0 {
                continue;
            }
            let danger = aa.iter().filter(|&&(ax, ay, r)| dist(ax, ay, ta.x, ta.y) <= r).count();
            if danger > ars.aa_tolerance {
                continue;
            }
            let mut score = info.cost.max(100) as i64 * fp / (1 + danger as i64);
            // Defend the base first.
            if dist(ta.x, ta.y, base.0, base.1) <= DEFEND_RADIUS {
                score *= 4;
            }
            // Nearer is better: halve the value every 24 cells.
            score = score * 24 * CELL as i64 / (24 * CELL as i64 + dist(x, y, ta.x, ta.y) as i64);
            if best.is_none_or(|(bs, bt)| score > bs || (score == bs && t < bt)) {
                best = Some((score, t));
            }
        }
        if let Some((_, t)) = best {
            let (r, tr) = (w.make_ref(i), w.make_ref(t));
            w.queue_order(Order::Attack { player, ids: vec![r], target: tr });
        }
    }
}

// ---- Ships ----------------------------------------------------------------------

/// Idle warships: submarines hunt enemy ships; the others sink ships in
/// reach, else sail at enemy structures near their water (in pairs).
pub(crate) fn command_ships(w: &mut World, player: u8) {
    let idle = own(w, player, |w, i| {
        let a = &w.actors[i];
        a.kind == Kind::Ship && a.in_world() && a.activity == Activity::Idle && armed(w, a.ty as usize)
    });
    if idle.is_empty() {
        return;
    }
    let ships = own(w, player, |w, i| w.actors[i].kind == Kind::Ship && armed(w, w.actors[i].ty as usize)).len();
    // Enemy ships this player can target, with their water component.
    let enemy_ships: Vec<(usize, Option<u32>)> = (0..w.actors.len())
        .filter(|&i| {
            let a = &w.actors[i];
            a.alive && a.in_world() && a.kind == Kind::Ship && is_live_enemy(w, player, a.owner) && w.targetable(i, player)
        })
        .map(|i| (i, water_component(w, w.actors[i].x, w.actors[i].y)))
        .collect();
    // Ships without a ship to fight, per water component: they shell the coast together.
    let mut bombard: Vec<(u32, Vec<usize>)> = Vec::new();
    for i in idle {
        let (x, y) = (w.actors[i].x, w.actors[i].y);
        let Some(comp) = water_component(w, x, y) else { continue };
        let info = &w.rules.actors[w.actors[i].ty as usize];
        let ship_target = enemy_ships
            .iter()
            .filter(|&&(t, c)| c == Some(comp) && info.can_attack_class(&w.rules, w.target_class(t)))
            .min_by_key(|&&(t, _)| (dist_sq(x, y, w.actors[t].x, w.actors[t].y), t))
            .map(|&(t, _)| t);
        if let Some(t) = ship_target {
            let (r, tr) = (w.make_ref(i), w.make_ref(t));
            w.queue_order(Order::Attack { player, ids: vec![r], target: tr });
            continue;
        }
        // Torpedo boats wait for ships to show up.
        if !info.can_attack(&w.rules, Kind::Building) {
            continue;
        }
        match bombard.iter_mut().find(|b| b.0 == comp) {
            Some(b) => b.1.push(i),
            None => bombard.push((comp, vec![i])),
        }
    }
    // In pairs, unless the AI only keeps one ship.
    let group = if my_arsenal(w, player).ships <= 1 { 1 } else { 2.min(ships) };
    for (comp, group_ships) in bombard {
        if group_ships.len() < group {
            continue;
        }
        let range = group_ships.iter().map(|&i| w.rules.actors[w.actors[i].ty as usize].max_range(&w.rules)).min().unwrap_or(0);
        if let Some((tx, ty)) = coastal_target(w, player, comp, range) {
            let ids: Vec<u32> = group_ships.iter().map(|&i| w.make_ref(i)).collect();
            w.queue_order(Order::Move { player, ids, x: tx, y: ty, attack_move: true });
        }
    }
}

/// The enemy structure that ships on water component `comp` can shell from
/// within `range`: the one nearest to such water. Returns a water point in range.
fn coastal_target(w: &World, player: u8, comp: u32, range: i32) -> Option<(i32, i32)> {
    let r = range / CELL;
    let mut best: Option<(i64, (i32, i32))> = None;
    for b in 0..w.actors.len() {
        let a = &w.actors[b];
        if !a.alive || a.kind != Kind::Building || !is_live_enemy(w, player, a.owner) || w.rules.actors[a.ty as usize].is_wall() {
            continue;
        }
        let (cx, cy) = w.cell_of(a.x, a.y);
        for y in cy - r..=cy + r {
            for x in cx - r..=cx + r {
                if !w.map.contains(x, y) {
                    continue;
                }
                let ci = w.map.idx(x, y);
                if w.pass_water.blocked[ci] || w.pass_water.component[ci] != comp {
                    continue;
                }
                let (px, py) = (cell_center(x), cell_center(y));
                let d = w.hit_distance(b, px, py);
                if d > range - CELL / 2 {
                    continue;
                }
                let key = d as i64 * 4096 + b as i64;
                if best.is_none_or(|(bk, _)| key < bk) {
                    best = Some((key, (px, py)));
                }
            }
        }
    }
    best.map(|(_, p)| p)
}

// ---- Abilities ------------------------------------------------------------------

/// Minelayers lay a few small fields on the approaches to the base: toward
/// the enemies, off to the side of the straight line the army drives along,
/// away from ore and buildings.
pub(crate) fn command_minelayers(w: &mut World, player: u8) {
    let want = my_arsenal(w, player).minefields;
    let layers = own(w, player, |w, i| {
        let a = &w.actors[i];
        w.rules.actors[a.ty as usize].abilities.minelayer.is_some() && a.in_world() && a.activity == Activity::Idle
    });
    for i in layers {
        if w.ai[player as usize].minefields.len() >= want {
            return;
        }
        let Some((x0, y0)) = minefield_site(w, player) else { return };
        w.ai[player as usize].minefields.push((x0, y0));
        let r = w.make_ref(i);
        w.queue_order(Order::LayMines { player, ids: vec![r], x0, y0, x1: x0 + FIELD - 1, y1: y0 + FIELD - 1 });
    }
}

/// Top-left cell of the next minefield, or None when no good spot is left.
fn minefield_site(w: &World, player: u8) -> Option<(i32, i32)> {
    let base = base_point(w, player);
    let (bx, by) = w.cell_of(base.0, base.1);
    let laid = &w.ai[player as usize].minefields;
    let mut enemies: Vec<(i64, u8)> = (0..w.players.len() as u8)
        .filter(|&p| is_live_enemy(w, player, p))
        .map(|p| {
            let e = base_point(w, p);
            (dist_sq(base.0, base.1, e.0, e.1), p)
        })
        .collect();
    enemies.sort_unstable();
    // Own refineries and the rally point: keep the fields away from own traffic.
    let rally = w.cell_of(rally_point(w, player).0, rally_point(w, player).1);
    for (_, p) in enemies {
        let e = base_point(w, p);
        let (dx, dy) = (e.0 - base.0, e.1 - base.1);
        let len = dist(0, 0, dx, dy).max(1);
        let (ux, uy) = (dx * 1024 / len, dy * 1024 / len);
        for along in [11, 13, 9, 15, 17] {
            for side in [5, -5, 7, -7, 9, -9] {
                let x0 = bx + (ux * along - uy * side) / 1024;
                let y0 = by + (uy * along + ux * side) / 1024;
                if laid.iter().any(|&(lx, ly)| (lx - x0).abs() < 5 && (ly - y0).abs() < 5) {
                    continue;
                }
                if (x0 - rally.0).abs() <= 3 && (y0 - rally.1).abs() <= 3 {
                    continue;
                }
                if field_ok(w, player, x0, y0) {
                    return Some((x0, y0));
                }
            }
        }
    }
    None
}

/// Every cell of a field at (x0, y0) is open ground the player has explored,
/// at least two cells from structures and three from ore.
fn field_ok(w: &World, player: u8, x0: i32, y0: i32) -> bool {
    for y in y0 - 3..y0 + FIELD + 3 {
        for x in x0 - 3..x0 + FIELD + 3 {
            if !w.map.contains(x, y) {
                return false;
            }
            let ci = w.map.idx(x, y);
            let inside = x >= x0 && x < x0 + FIELD && y >= y0 && y < y0 + FIELD;
            let near = x >= x0 - 2 && x < x0 + FIELD + 2 && y >= y0 - 2 && y < y0 + FIELD + 2;
            if w.map.ore[ci] > 0 || (near && w.building_at[ci] != crate::world::NONE) {
                return false;
            }
            if inside && (w.pass.blocked[ci] || w.players[player as usize].explored[ci] == 0 || w.mine_at(ci).is_some()) {
                return false;
            }
        }
    }
    true
}

/// Chrono tanks with a charge teleport next to enemy artillery or ore trucks
/// in reach (not into a crowd of defenders) and attack them.
pub(crate) fn command_chrono_tanks(w: &mut World, player: u8) {
    let tanks = own(w, player, |w, i| {
        let a = &w.actors[i];
        a.in_world() && a.ab.chrono_charge == 0 && w.rules.actors[a.ty as usize].abilities.portable_chrono.is_some()
    });
    for i in tanks {
        let Some(pc) = w.rules.actors[w.actors[i].ty as usize].abilities.portable_chrono.clone() else { continue };
        let (ux, uy) = w.cell_of(w.actors[i].x, w.actors[i].y);
        let reach = pc.max_distance - 2;
        let mut best: Option<(i32, usize)> = None;
        for t in 0..w.actors.len() {
            let a = &w.actors[t];
            if !a.alive || !a.in_world() || !matches!(a.kind, Kind::Vehicle | Kind::Infantry) || !is_live_enemy(w, player, a.owner) {
                continue;
            }
            let info = &w.rules.actors[a.ty as usize];
            let artillery = info.weapons.iter().any(|&wi| w.rules.weapons[wi].min_range > 0);
            if !(artillery || w.is_harvester(t)) || !w.targetable(t, player) {
                continue;
            }
            let (tx, ty) = w.cell_of(a.x, a.y);
            if (tx - ux) * (tx - ux) + (ty - uy) * (ty - uy) > reach * reach {
                continue;
            }
            if best.is_none_or(|(bc, bt)| info.cost > bc || (info.cost == bc && t < bt)) {
                best = Some((info.cost, t));
            }
        }
        let Some((_, t)) = best else { continue };
        let (tx, ty) = w.cell_of(w.actors[t].x, w.actors[t].y);
        // Defenders around the landing: armed enemy actors within 5 cells.
        let defenders = (0..w.actors.len())
            .filter(|&d| {
                let a = &w.actors[d];
                a.alive
                    && a.in_world()
                    && is_live_enemy(w, player, a.owner)
                    && armed(w, a.ty as usize)
                    && !w.is_harvester(d)
                    && dist(a.x, a.y, w.actors[t].x, w.actors[t].y) <= 5 * CELL
            })
            .count();
        if defenders > 2 {
            continue;
        }
        let spot = [(1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (-1, -1), (1, -1), (-1, 1), (2, 0), (-2, 0), (0, 2), (0, -2)]
            .iter()
            .map(|&(dx, dy)| (tx + dx, ty + dy))
            .find(|&(cx, cy)| w.can_teleport(i, cx, cy) && w.units_in_cell(w.map.idx(cx, cy)).is_empty());
        if let Some((cx, cy)) = spot {
            let (r, tr) = (w.make_ref(i), w.make_ref(t));
            w.queue_order(Order::Teleport { player, ids: vec![r], x: cell_center(cx), y: cell_center(cy) });
            w.queue_order(Order::Attack { player, ids: vec![r], target: tr });
        }
    }
}

/// Blast radius of a MAD tank or demolition truck (its largest warhead spread).
fn blast_radius(w: &World, ty: usize) -> i32 {
    let info = &w.rules.actors[ty];
    let weapons: Vec<usize> = match &info.abilities.mad_tank {
        Some(m) => vec![m.detonation_weapon],
        None => info.weapons.iter().copied().chain(info.death_weapon).collect(),
    };
    weapons.iter().flat_map(|&wi| w.rules.weapons[wi].warheads.iter().map(|h| h.spread)).max().unwrap_or(CELL).max(CELL)
}

/// MAD tanks and demolition trucks drive at the target player's densest
/// structures and go off once enough enemies are in the blast and few own or
/// allied units are.
pub(crate) fn command_bombers(w: &mut World, player: u8, target_player: Option<u8>) {
    let units = own(w, player, |w, i| {
        let a = &w.actors[i];
        let ab = &w.rules.actors[a.ty as usize].abilities;
        a.in_world() && (ab.mad_tank.is_some() || ab.demo_truck.is_some()) && a.ab.task != crate::abilities::Task::MadDeploy
    });
    for i in units {
        let (x, y) = (w.actors[i].x, w.actors[i].y);
        let radius = blast_radius(w, w.actors[i].ty as usize);
        let (mut enemies, mut friends) = (0, 0);
        for j in 0..w.actors.len() {
            let a = &w.actors[j];
            if j == i || !a.alive || !a.in_world() || a.kind == Kind::Mine || w.hit_distance(j, x, y) > radius {
                continue;
            }
            if is_live_enemy(w, player, a.owner) && (a.kind == Kind::Building || w.targetable(j, player)) {
                enemies += 1;
            } else if w.are_allies(player, a.owner) && a.kind != Kind::Building {
                friends += 1;
            }
        }
        let r = w.make_ref(i);
        if enemies >= 4 && friends <= 1 {
            w.queue_order(Order::Deploy { player, ids: vec![r] });
            continue;
        }
        if w.actors[i].activity == Activity::Idle {
            if let Some((tx, ty)) = target_player.and_then(|t| densest_buildings(w, t).first().copied()) {
                w.queue_order(Order::Move { player, ids: vec![r], x: tx, y: ty, attack_move: false });
            }
        }
    }
}

/// Radar jammers follow the army out (their jamming covers the attack), and
/// wait at the rally point while it gathers.
pub(crate) fn command_jammers(w: &mut World, player: u8) {
    let jammers = own(w, player, |w, i| {
        let a = &w.actors[i];
        a.in_world() && w.rules.actors[a.ty as usize].abilities.jams_missiles.is_some() && a.kind != Kind::Building
    });
    if jammers.is_empty() {
        return;
    }
    let base = base_point(w, player);
    let attackers = own(w, player, |w, i| {
        let a = &w.actors[i];
        crate::ai::is_army_unit(w, a.ty as usize)
            && ((a.activity == Activity::Move && a.attack_move) || a.activity == Activity::Attack)
            && dist(a.x, a.y, base.0, base.1) > 15 * CELL
    });
    let goal = if attackers.len() >= 3 {
        let n = attackers.len() as i64;
        let cx = (attackers.iter().map(|&i| w.actors[i].x as i64).sum::<i64>() / n) as i32;
        let cy = (attackers.iter().map(|&i| w.actors[i].y as i64).sum::<i64>() / n) as i32;
        (cx, cy)
    } else {
        rally_point(w, player)
    };
    for i in jammers {
        let a = &w.actors[i];
        let current = if a.activity == Activity::Move { a.dest } else { (a.x, a.y) };
        if dist(current.0, current.1, goal.0, goal.1) > 4 * CELL {
            let r = w.make_ref(i);
            w.queue_order(Order::Move { player, ids: vec![r], x: goal.0, y: goal.1, attack_move: false });
        }
    }
}

// ---- Superweapons ---------------------------------------------------------------

/// Whether a point is safe to bomb: no own or allied unit or structure within `radius`.
pub(crate) fn safe_to_bomb(w: &World, player: u8, x: i32, y: i32, radius: i32) -> bool {
    !w.actors
        .iter()
        .enumerate()
        .any(|(i, a)| a.alive && a.in_world() && a.kind != Kind::Mine && w.are_allies(player, a.owner) && w.hit_distance(i, x, y) <= radius)
}

/// Cells of a power's footprint centred on a world point.
fn footprint_cells(w: &World, footprint: &[String], x: i32, y: i32) -> Vec<usize> {
    let rows: Vec<&str> = if footprint.is_empty() { vec!["x"] } else { footprint.iter().map(|s| s.as_str()).collect() };
    let (cx, cy) = w.cell_of(x, y);
    let (h, wd) = (rows.len() as i32, rows[0].len() as i32);
    let mut out = Vec::new();
    for (ry, row) in rows.iter().enumerate() {
        for (rx, c) in row.chars().enumerate() {
            let (px, py) = (cx + rx as i32 - wd / 2, cy + ry as i32 - h / 2);
            if c == 'x' && w.map.contains(px, py) {
                out.push(w.map.idx(px, py));
            }
        }
    }
    out
}

/// Iron Curtain: on the own army unit in a fight with the most own units in
/// the footprint (at least three), never on a demolition truck (it would blow up).
pub(crate) fn iron_curtain_target(w: &World, player: u8, footprint: &[String]) -> Option<(i32, i32)> {
    let mut best: Option<(usize, usize)> = None;
    for i in 0..w.actors.len() {
        let a = &w.actors[i];
        if !a.alive || a.owner != player || a.activity != Activity::Attack || !crate::ai::is_army_unit(w, a.ty as usize) {
            continue;
        }
        let mut covered = 0;
        let mut bad = false;
        for ci in footprint_cells(w, footprint, a.x, a.y) {
            for &u in w.units_in_cell(ci) {
                let u = &w.actors[u as usize];
                if !u.alive || u.owner != player {
                    continue;
                }
                match &w.rules.actors[u.ty as usize].abilities.iron_curtainable {
                    Some(ic) if ic.kills => bad = true,
                    Some(_) if matches!(u.kind, Kind::Vehicle | Kind::Ship) => covered += 1,
                    _ => {}
                }
            }
        }
        if !bad && covered >= 3 && best.is_none_or(|(bc, bi)| covered > bc || (covered == bc && i < bi)) {
            best = Some((covered, i));
        }
    }
    best.map(|(_, i)| (w.actors[i].x, w.actors[i].y))
}

/// Chronosphere: the gathered army at the rally point (at least three own
/// chronoshiftable vehicles in the footprint) jumps next to the target
/// player's densest structures, onto open ground the player has explored.
/// Returns (destination, source).
pub(crate) fn chronoshift_target(w: &World, player: u8, target: u8, footprint: &[String]) -> Option<((i32, i32), (i32, i32))> {
    let rally = rally_point(w, player);
    let mut source: Option<(usize, usize)> = None;
    for i in 0..w.actors.len() {
        let a = &w.actors[i];
        if !a.alive
            || a.owner != player
            || a.kind != Kind::Vehicle
            || a.activity != Activity::Idle
            || dist(a.x, a.y, rally.0, rally.1) > 6 * CELL
            || !crate::ai::is_army_unit(w, a.ty as usize)
        {
            continue;
        }
        let shiftable = footprint_cells(w, footprint, a.x, a.y)
            .into_iter()
            .flat_map(|ci| w.units_in_cell(ci).iter().map(|&u| u as usize).collect::<Vec<_>>())
            .filter(|&u| {
                let ua = &w.actors[u];
                ua.alive
                    && ua.owner == player
                    && ua.kind == Kind::Vehicle
                    && crate::ai::is_army_unit(w, ua.ty as usize)
                    && w.rules.actors[ua.ty as usize].abilities.chronoshiftable.as_ref().is_some_and(|c| !c.explode_instead)
            })
            .count();
        if shiftable >= 3 && source.is_none_or(|(bc, bi)| shiftable > bc || (shiftable == bc && i < bi)) {
            source = Some((shiftable, i));
        }
    }
    let (_, s) = source?;
    let src = (w.actors[s].x, w.actors[s].y);
    let base = base_point(w, player);
    for (bx, by) in densest_buildings(w, target).into_iter().take(3) {
        // Land 4 cells short of the structures, on our side of them.
        let (dx, dy) = (base.0 - bx, base.1 - by);
        let len = dist(0, 0, dx, dy).max(1);
        for back in [4, 5, 3, 6] {
            let (x, y) = (bx + dx * back * CELL / len, by + dy * back * CELL / len);
            let open = footprint_cells(w, footprint, x, y)
                .into_iter()
                .filter(|&ci| !w.pass.blocked[ci] && w.players[player as usize].explored[ci] != 0 && !w.gen_shrouded(player, ci))
                .count();
            if open >= 4 {
                return Some(((x, y), src));
            }
        }
    }
    None
}

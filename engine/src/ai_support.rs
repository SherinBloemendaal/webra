//! OpenRA SupportPowerBotModule: a ready support power with a decision in
//! the bot's config (ai.yaml: spy plane, paratroopers, parabombs, nuke) is
//! fired at the most attractive spot. The map is scanned in squares of
//! CoarseScanRadius cells; a random square of above average attractiveness
//! is then scanned every FineScanRadius cells for the best cell. Each
//! Consideration adds its Attractiveness for every actor of the given
//! relationship and target types within CheckRadius (times the actor's
//! value or health share for those metrics) that the bot can see; like its
//! squads it knows where enemy structures are (OpenRA's bots count the
//! structures they remember under the fog).
//!
//! The GPS Satellite launches by itself once charged (abilities.rs). OpenRA's
//! bots have no decision for the other Red Alert powers; WebRA's bots (not
//! on Easy) also use them: the Iron Curtain on their army in a fight, the
//! Chronosphere to jump their gathered army next to the enemy base, and the
//! Sonar Pulse where an unseen attacker (a submerged submarine) hit them.

use crate::ai::rand;
use crate::ai_bots::{target_type_mask, target_types, DecisionInfo};
use crate::math::{dist, dist_sq, CELL};
use crate::rules::Kind;
use crate::world::{cell_center, Activity, Order, World};

/// Ticks a found target waits for the order to land (OpenRA: 10).
const ORDER_DELAY: i32 = 10;
/// How long an unseen attacker's position is worth a Sonar Pulse.
const SONAR_MEMORY: u32 = 250;

#[derive(Clone, Default, Debug)]
pub(crate) struct SupportState {
    /// Per power key: ticks before the next scan.
    waiting: Vec<(String, i32)>,
    /// Where and when an unseen attacker last hit an own ship or naval
    /// structure (Sonar Pulse target).
    pub(crate) hidden_attack: Option<(u32, i32, i32)>,
}

pub(crate) fn tick(w: &mut World, player: u8) {
    let cfg = w.ai[player as usize].cfg.clone();
    let decisions: &[DecisionInfo] = cfg.info.support_powers.as_ref().map_or(&[], |s| &s.decisions);
    let powers: Vec<(String, String, String, Vec<String>, bool)> = w
        .power_instances(player)
        .iter()
        .filter(|p| p.charging)
        .map(|p| {
            let info = w.power_info(p);
            (p.key.clone(), info.order_name.clone(), info.kind.clone(), info.footprint.clone(), p.ready())
        })
        .collect();
    let keys: Vec<&String> = powers.iter().map(|p| &p.0).collect();
    w.ai[player as usize].support.waiting.retain(|(k, _)| keys.contains(&k));
    let extras = w.ai[player as usize].level().uses_extra_powers();
    for (key, order_name, kind, footprint, ready) in powers {
        let st = &mut w.ai[player as usize].support;
        let slot = match st.waiting.iter().position(|(k, _)| *k == key) {
            Some(s) => s,
            None => {
                st.waiting.push((key.clone(), 0));
                st.waiting.len() - 1
            }
        };
        if st.waiting[slot].1 > 0 {
            st.waiting[slot].1 -= 1;
        }
        if !ready || st.waiting[slot].1 > 0 {
            continue;
        }
        if let Some(d) = decisions.iter().find(|d| d.order_name == order_name) {
            match find_target(w, player, d) {
                Some((x, y)) => {
                    w.ai[player as usize].support.waiting[slot].1 += ORDER_DELAY;
                    w.queue_order(Order::SupportPower { player, key, x, y, x2: None, y2: None });
                }
                None => {
                    let next = rand(w, d.minimum_scan_time_interval, d.maximum_scan_time_interval);
                    w.ai[player as usize].support.waiting[slot].1 += next;
                }
            }
            continue;
        }
        if !extras {
            continue;
        }
        let shot = match kind.as_str() {
            "GrantExternalConditionPower" => iron_curtain_target(w, player, &footprint).map(|p| (p, None)),
            "ChronoshiftPower" => crate::ai::current_target(w, player)
                .or_else(|| crate::ai::choose_target_player(w, player))
                .and_then(|t| chronoshift_target(w, player, t, &footprint))
                .map(|(dest, src)| (dest, Some(src))),
            "SpawnActorPower" => sonar_target(w, player).map(|p| (p, None)),
            _ => None,
        };
        match shot {
            Some(((x, y), second)) => {
                w.ai[player as usize].support.waiting[slot].1 += ORDER_DELAY;
                let (x2, y2) = (second.map(|p| p.0), second.map(|p| p.1));
                w.queue_order(Order::SupportPower { player, key, x, y, x2, y2 });
            }
            None => {
                let next = rand(w, 250, 262);
                w.ai[player as usize].support.waiting[slot].1 += next;
            }
        }
    }
}

// ---- Decisions --------------------------------------------------------------------------

/// Whether the bot sees actor `i` for a decision (OpenRA IsTargetableBy and
/// CanBeViewedByPlayer): own and allied actors always, others while visible,
/// and enemy structures always (the bot knows the bases, ai.rs; OpenRA's
/// bots see the structures they remember under the fog).
fn seen(w: &World, player: u8, i: usize) -> bool {
    let a = &w.actors[i];
    a.alive
        && a.in_world()
        && !matches!(a.kind, Kind::Husk | Kind::Crate | Kind::Proxy)
        && (w.are_allies(player, a.owner) || w.targetable(i, player) || (a.kind == Kind::Building && w.are_enemies(player, a.owner)))
}

fn relationship_matches(w: &World, player: u8, owner: u8, against: &str) -> bool {
    match against {
        "Enemy" => w.are_enemies(player, owner),
        "Ally" => w.are_allies(player, owner),
        "Neutral" => !w.are_enemies(player, owner) && !w.are_allies(player, owner),
        _ => false,
    }
}

/// Attractiveness of `ty` at health `hp` for one consideration.
fn metric(w: &World, metric: &str, attractiveness: i32, ty: u16, hp: Option<i32>) -> i64 {
    let info = &w.rules.actors[ty as usize];
    match metric {
        "Value" => info.cost as i64 * attractiveness as i64,
        "Health" => hp.map_or(0, |h| h as i64 * attractiveness as i64 / info.hp.max(1) as i64),
        _ => attractiveness as i64,
    }
}

/// OpenRA SupportPowerDecision.GetAttractiveness of everything within each
/// consideration's CheckRadius of a point (of the actors the bot sees).
fn attractiveness_at(w: &World, player: u8, d: &DecisionInfo, x: i32, y: i32) -> i64 {
    if !w.map.contains(x.div_euclid(CELL), y.div_euclid(CELL)) {
        return 0;
    }
    let mut sum = 0i64;
    for c in &d.considerations {
        let types = target_type_mask(&c.types);
        let r = c.check_radius as i64;
        for i in 0..w.actors.len() {
            let a = &w.actors[i];
            if !seen(w, player, i) || dist_sq(a.x, a.y, x, y) > r * r || !relationship_matches(w, player, a.owner, &c.against) {
                continue;
            }
            if target_types(w, i) & types != 0 {
                sum += metric(w, &c.target_metric, c.attractiveness, a.ty, Some(a.hp));
            }
        }
    }
    sum
}

/// Attractiveness of everything in a box of cells (the coarse scan).
fn attractiveness_in(w: &World, player: u8, d: &DecisionInfo, x0: i32, y0: i32, x1: i32, y1: i32) -> i64 {
    let mut sum = 0i64;
    let inside = |cx: i32, cy: i32| cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1;
    for c in &d.considerations {
        let types = target_type_mask(&c.types);
        for i in 0..w.actors.len() {
            let a = &w.actors[i];
            if !seen(w, player, i) || !relationship_matches(w, player, a.owner, &c.against) {
                continue;
            }
            let (cx, cy) = w.cell_of(a.x, a.y);
            if inside(cx, cy) && target_types(w, i) & types != 0 {
                sum += metric(w, &c.target_metric, c.attractiveness, a.ty, Some(a.hp));
            }
        }
    }
    sum
}

/// OpenRA FindCoarseAttackLocationToSupportPower and
/// FindFineAttackLocationToSupportPower: the world point to fire at.
fn find_target(w: &mut World, player: u8, d: &DecisionInfo) -> Option<(i32, i32)> {
    let step = d.coarse_scan_radius.max(1);
    let mut squares: Vec<((i32, i32), i64)> = Vec::new();
    let mut total = 0i64;
    for x in (0..w.map.width).step_by(step as usize) {
        for y in (0..w.map.height).step_by(step as usize) {
            let a = attractiveness_in(w, player, d, x, y, x + step, y + step);
            if a < d.minimum_attractiveness as i64 {
                continue;
            }
            squares.push(((x, y), a));
            total += a;
        }
    }
    if squares.is_empty() {
        return None;
    }
    let average = total / squares.len() as i64;
    crate::ai_base::shuffle(w, &mut squares);
    let (cx, cy) = squares.into_iter().find(|s| s.1 >= average)?.0;
    let fine = d.fine_scan_radius.max(1);
    let mut best: Option<(i64, (i32, i32))> = None;
    let mut i = -1;
    while i <= step + 1 {
        let mut j = -1;
        while j <= step + 1 {
            let (x, y) = (cx + i, cy + j);
            let a = attractiveness_at(w, player, d, cell_center(x), cell_center(y));
            if a > best.map_or(0, |b| b.0) && a >= d.minimum_attractiveness as i64 {
                best = Some((a, (x, y)));
            }
            j += fine;
        }
        i += fine;
    }
    best.map(|(_, (x, y))| (cell_center(x), cell_center(y)))
}

// ---- WebRA extensions --------------------------------------------------------------------

/// IBotRespondToAttack: remember where an attacker the bot cannot see hit
/// one of its ships or naval structures (a Sonar Pulse target).
pub(crate) fn note_hidden_attack(w: &mut World, player: u8, victim: usize, attacker: usize) {
    let a = &w.actors[victim];
    let naval = a.kind == Kind::Ship || w.rules.actors[a.ty as usize].building.as_ref().is_some_and(|b| b.on_water);
    if !naval || w.actors[attacker].kind != Kind::Ship || w.is_visible_to(attacker, player) {
        return;
    }
    let (x, y) = (w.actors[attacker].x, w.actors[attacker].y);
    let tick = w.tick;
    w.ai[player as usize].support.hidden_attack = Some((tick, x, y));
}

/// Sonar Pulse: on the last unseen attacker, while it is fresh, on explored water.
fn sonar_target(w: &World, player: u8) -> Option<(i32, i32)> {
    let (t, x, y) = w.ai[player as usize].support.hidden_attack?;
    if w.tick > t + SONAR_MEMORY {
        return None;
    }
    let ci = w.cell_index(x, y);
    (w.map.terrain[ci].ship_passable() && w.players[player as usize].explored[ci] != 0).then_some((x, y))
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

/// A ground unit that fights in squads (not a harvester, MCV or the like).
fn fighter(w: &World, i: usize) -> bool {
    let a = &w.actors[i];
    let info = &w.rules.actors[a.ty as usize];
    matches!(a.kind, Kind::Infantry | Kind::Vehicle)
        && !info.weapons.is_empty()
        && !w.is_harvester(i)
        && info.abilities.demo_truck.is_none()
}

/// Iron Curtain: on the own unit in a fight with the most own vehicles and
/// ships in the footprint (at least three), never where it would blow up a
/// demolition truck.
pub(crate) fn iron_curtain_target(w: &World, player: u8, footprint: &[String]) -> Option<(i32, i32)> {
    let mut best: Option<(usize, usize)> = None;
    for i in 0..w.actors.len() {
        let a = &w.actors[i];
        if !a.alive || a.owner != player || a.activity != Activity::Attack || !fighter(w, i) {
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

/// The target player's structures, the ones with the most other structures
/// within 5 cells first; at most the eight densest.
fn densest_buildings(w: &World, target: u8) -> Vec<(i32, i32)> {
    let buildings: Vec<usize> = (0..w.actors.len())
        .filter(|&i| {
            let a = &w.actors[i];
            a.alive && a.owner == target && a.kind == Kind::Building && !w.rules.actors[a.ty as usize].is_wall()
        })
        .collect();
    let near = |i: usize| {
        let a = &w.actors[i];
        buildings.iter().filter(|&&j| dist(a.x, a.y, w.actors[j].x, w.actors[j].y) <= 5 * CELL).count()
    };
    let mut ranked: Vec<(std::cmp::Reverse<usize>, usize)> = buildings.iter().map(|&i| (std::cmp::Reverse(near(i)), i)).collect();
    ranked.sort_unstable();
    ranked.into_iter().take(8).map(|(_, i)| (w.actors[i].x, w.actors[i].y)).collect()
}

/// Chronosphere: idle own vehicles at the base (at least three that can be
/// chronoshifted in the footprint) jump four cells short of the target
/// player's densest structures, onto open ground the bot has explored.
/// Returns (destination, source).
pub(crate) fn chronoshift_target(w: &World, player: u8, target: u8, footprint: &[String]) -> Option<((i32, i32), (i32, i32))> {
    let home = crate::ai::base_point(w, player);
    let mut source: Option<(usize, usize)> = None;
    for i in 0..w.actors.len() {
        let a = &w.actors[i];
        if !a.alive
            || a.owner != player
            || a.kind != Kind::Vehicle
            || a.activity != Activity::Idle
            || dist(a.x, a.y, home.0, home.1) > 20 * CELL
            || !fighter(w, i)
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
                    && fighter(w, u)
                    && w.rules.actors[ua.ty as usize].abilities.chronoshiftable.as_ref().is_some_and(|c| !c.explode_instead)
            })
            .count();
        if shiftable >= 3 && source.is_none_or(|(bc, bi)| shiftable > bc || (shiftable == bc && i < bi)) {
            source = Some((shiftable, i));
        }
    }
    let (_, s) = source?;
    let src = (w.actors[s].x, w.actors[s].y);
    for (bx, by) in densest_buildings(w, target).into_iter().take(3) {
        let (dx, dy) = (home.0 - bx, home.1 - by);
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

/// Whether a point is safe to bomb: no own or allied unit or structure within `radius` (tests).
#[cfg(test)]
pub(crate) fn safe_to_bomb(w: &World, player: u8, x: i32, y: i32, radius: i32) -> bool {
    !w.actors
        .iter()
        .enumerate()
        .any(|(i, a)| a.alive && a.in_world() && a.kind != Kind::Mine && w.are_allies(player, a.owner) && w.hit_distance(i, x, y) <= radius)
}

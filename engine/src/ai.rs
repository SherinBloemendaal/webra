//! Skirmish AI: deploys its MCV, follows a build order, keeps harvesters busy,
//! builds an army and a few defences, and attacks in growing waves. It plays by
//! the same rules and economy as a human; difficulty changes how fast it reacts
//! and how large its waves are.
//!
//! In free for all and team games it picks one enemy player to attack (the
//! nearest hostile base, the weakest of equally near ones), AI teammates attack
//! the same enemy as their team leader, and idle units help allies whose base
//! is under attack. Allies and neutral actors are never targeted.

use crate::math::{dist, CELL};
use crate::rules::{FootCell, Kind, QueueType};
use crate::world::{cell_center, Activity, AiDifficulty, Order, World};

const DEFEND_RADIUS: i32 = 14 * CELL;
/// Enemy bases within this distance of the nearest one count as equally near.
const NEAR_TIE: i32 = 8 * CELL;
/// How long an attack target is kept before it is reconsidered (one minute).
const RETARGET_TICKS: u32 = 60 * crate::world::TICKS_PER_SECOND;

pub struct AiState {
    offset: u32,
    think_interval: u32,
    wave_size: usize,
    max_wave: usize,
    /// Defensive structures to keep around the base.
    defenses: usize,
    /// Enemy player the waves go to, and when to reconsider it.
    pub target_player: Option<u8>,
    retarget_at: u32,
}

impl AiState {
    pub fn new(player: u32, difficulty: AiDifficulty) -> AiState {
        let (think_interval, wave_size, max_wave, defenses) = match difficulty {
            AiDifficulty::Easy => (50, 10, 12, 0),
            AiDifficulty::Normal => (25, 6, 20, 2),
            AiDifficulty::Hard => (15, 5, 30, 4),
        };
        AiState { offset: player * 7, think_interval, wave_size, max_wave, defenses, target_player: None, retarget_at: 0 }
    }
}

/// Build order by prerequisite token rather than actor id, so it works for both sides.
const BUILD_ORDER: &[&str] =
    &["anypower", "proc", "barracks", "weap", "proc", "anypower", "fix", "anypower", "dome", "anypower", "techcenter"];

pub fn think(w: &mut World, player: u8) {
    let state = &w.ai[player as usize];
    if !(w.tick + state.offset).is_multiple_of(state.think_interval) {
        return;
    }
    deploy_mcv(w, player);
    cancel_blocked(w, player);
    place_ready_building(w, player, QueueType::Building);
    place_ready_building(w, player, QueueType::Defense);
    queue_buildings(w, player);
    queue_defenses(w, player);
    queue_units(w, player);
    command_army(w, player);
    use_support_powers(w, player);
}

/// Without a Construction Yard, deploy an MCV (starting units "MCV only").
fn deploy_mcv(w: &mut World, player: u8) {
    if w.has_producer(player, QueueType::Building) {
        return;
    }
    let mcvs: Vec<usize> = (0..w.actors.len())
        .filter(|&i| {
            let a = &w.actors[i];
            a.alive && a.owner == player && a.kind == Kind::Vehicle && w.rules.actors[a.ty as usize].transforms_into.is_some()
        })
        .collect();
    for i in mcvs {
        if w.actors[i].activity != Activity::Idle {
            continue;
        }
        if w.can_deploy(i) {
            let r = w.make_ref(i);
            w.queue_order(Order::Deploy { player, ids: vec![r] });
            return;
        }
        // Blocked: drive a little and try again next time.
        let (x, y) = (w.actors[i].x, w.actors[i].y);
        let dx = if (w.tick / 100).is_multiple_of(2) { 2 * CELL } else { -2 * CELL };
        w.order_move(&[i], x + dx, y + CELL, false);
    }
}

/// Cancel queued items whose prerequisites were destroyed (e.g. a half-built
/// tech center after the war factory died), so the base can be rebuilt.
fn cancel_blocked(w: &mut World, player: u8) {
    for qi in 0..crate::rules::QUEUE_COUNT {
        let Some(item) = w.players[player as usize].queues[qi].items.first().cloned() else { continue };
        if !w.availability(player, item.ty).enabled {
            w.cancel_production(player, item.ty);
        }
    }
}

/// A unit worth sending into battle (not a harvester, mine layer or suicide unit).
fn is_army_unit(w: &World, ty: usize) -> bool {
    let info = &w.rules.actors[ty];
    info.kind != Kind::Building
        && info.can_attack(&w.rules, Kind::Vehicle)
        && info.abilities.demo_truck.is_none()
        && info.abilities.mad_tank.is_none()
}

fn owned_buildings(w: &World, player: u8) -> Vec<usize> {
    (0..w.actors.len()).filter(|&i| w.actors[i].alive && w.actors[i].owner == player && w.actors[i].kind == Kind::Building).collect()
}

fn count_providing(w: &World, player: u8, token: &str) -> usize {
    let faction = w.players[player as usize].faction;
    let Some(t) = w.rules.token(token) else { return 0 };
    owned_buildings(w, player)
        .iter()
        .filter(|&&b| w.rules.actors[w.actors[b].ty as usize].building.as_ref().unwrap().provides[faction].contains(&t))
        .count()
}

/// Cheapest enabled building that provides `token`.
fn building_for(w: &World, player: u8, token: &str) -> Option<u16> {
    let faction = w.players[player as usize].faction;
    let t = w.rules.token(token)?;
    (0..w.rules.actors.len())
        .filter(|&a| {
            let info = &w.rules.actors[a];
            info.kind == Kind::Building
                && info.queue == QueueType::Building
                && info.building.as_ref().unwrap().provides[faction].contains(&t)
                && w.availability(player, a as u16).enabled
        })
        .min_by_key(|&a| w.rules.actors[a].cost)
        .map(|a| a as u16)
}

fn build_order_done(w: &World, player: u8) -> bool {
    let mut needed: Vec<(&str, usize)> = Vec::new();
    BUILD_ORDER.iter().all(|&tok| {
        match needed.iter_mut().find(|(t, _)| *t == tok) {
            Some(e) => e.1 += 1,
            None => needed.push((tok, 1)),
        }
        let want = needed.iter().find(|(t, _)| *t == tok).unwrap().1;
        count_providing(w, player, tok) >= want || building_for(w, player, tok).is_none()
    })
}

fn queue_buildings(w: &mut World, player: u8) {
    if !w.players[player as usize].queues[QueueType::Building as usize].items.is_empty() || !w.has_producer(player, QueueType::Building) {
        return;
    }
    let p = &w.players[player as usize];
    // Power first when the next building would push us into low power.
    if p.power_use + 40 > p.power_gen {
        if let Some(ty) = building_for(w, player, "anypower") {
            w.start_production(player, ty, 1);
            return;
        }
    }
    let mut needed: Vec<(&str, usize)> = Vec::new();
    for &tok in BUILD_ORDER {
        match needed.iter_mut().find(|(t, _)| *t == tok) {
            Some(e) => e.1 += 1,
            None => needed.push((tok, 1)),
        }
        let have = count_providing(w, player, tok);
        let want = needed.iter().find(|(t, _)| *t == tok).unwrap().1;
        if have < want {
            if let Some(ty) = building_for(w, player, tok) {
                if w.players[player as usize].funds() >= w.rules.actors[ty as usize].cost / 2 {
                    w.start_production(player, ty, 1);
                }
                return;
            }
        }
    }
}

/// A few gun or Tesla defences once the base stands.
fn queue_defenses(w: &mut World, player: u8) {
    let want = w.ai[player as usize].defenses;
    let dq = QueueType::Defense as usize;
    if want == 0 || !w.players[player as usize].queues[dq].items.is_empty() || !build_order_done(w, player) {
        return;
    }
    let have = owned_buildings(w, player)
        .iter()
        .filter(|&&b| {
            let info = &w.rules.actors[w.actors[b].ty as usize];
            info.queue == QueueType::Defense && info.can_attack(&w.rules, Kind::Vehicle)
        })
        .count();
    if have >= want || w.players[player as usize].funds() < 1500 {
        return;
    }
    let best = (0..w.rules.actors.len() as u16)
        .filter(|&a| {
            let info = &w.rules.actors[a as usize];
            info.queue == QueueType::Defense
                && info.can_attack(&w.rules, Kind::Vehicle)
                && !info.is_wall()
                && w.availability(player, a).enabled
        })
        .max_by_key(|&a| w.rules.actors[a as usize].cost);
    if let Some(ty) = best {
        w.start_production(player, ty, 1);
    }
}

fn queue_units(w: &mut World, player: u8) {
    let order_done = build_order_done(w, player);
    let funds = w.players[player as usize].funds();
    let mut candidates: Vec<u16> = (0..w.rules.actors.len() as u16).filter(|&a| w.availability(player, a).enabled).collect();
    candidates.sort_by_key(|&a| std::cmp::Reverse(w.rules.actors[a as usize].cost));

    // Infantry is cheap: keep a trickle going, but tanks are the backbone.
    let count_kind = |k: Kind| w.actors.iter().filter(|a| a.alive && a.owner == player && a.kind == k).count();
    let (infantry, vehicles) = (count_kind(Kind::Infantry), count_kind(Kind::Vehicle));
    let iq = QueueType::Infantry as usize;
    if w.players[player as usize].queues[iq].items.len() < 2 && infantry < 6 + vehicles * 2 && (order_done || funds >= 600) {
        if let Some(&inf) = candidates.iter().rev().find(|&&a| {
            let info = &w.rules.actors[a as usize];
            info.queue == QueueType::Infantry && !info.weapons.is_empty()
        }) {
            w.start_production(player, inf, 1);
        }
    }

    // One harvester per refinery, plus a spare when there is money.
    let refineries = count_providing(w, player, "proc");
    let harvesters = (0..w.actors.len()).filter(|&i| w.actors[i].alive && w.actors[i].owner == player && w.is_harvester(i)).count();
    let vq = QueueType::Vehicle as usize;
    if !w.players[player as usize].queues[vq].items.is_empty() {
        return;
    }
    if harvesters < refineries + 1 && refineries > 0 {
        if let Some(&h) = candidates.iter().find(|&&a| w.rules.actors[a as usize].unit.as_ref().is_some_and(|u| u.harvester.is_some())) {
            if harvesters < refineries || funds >= 1500 {
                w.start_production(player, h, 1);
                return;
            }
        }
    }
    // Tanks as soon as there is a war factory and money to spare beyond the
    // build order: the best army unit we can afford now.
    let reserve = if order_done { 0 } else { 600 };
    let tank = candidates.iter().copied().find(|&a| {
        let info = &w.rules.actors[a as usize];
        info.queue == QueueType::Vehicle && is_army_unit(w, a as usize) && info.cost + reserve <= funds
    });
    if let Some(tank) = tank {
        w.start_production(player, tank, 1);
    }
}

fn place_ready_building(w: &mut World, player: u8, q: QueueType) {
    let qi = q as usize;
    let Some(item) = w.players[player as usize].queues[qi].items.first().cloned() else { return };
    if !item.done {
        return;
    }
    let (sx, sy) = w.players[player as usize].start;
    // Defences go out toward the map centre; everything else around the yard.
    let (ax, ay) = if q == QueueType::Defense {
        let (mx, my) = (w.map.width / 2, w.map.height / 2);
        (sx + (mx - sx).signum() * 7, sy + (my - sy).signum() * 7)
    } else {
        (sx, sy)
    };
    let b = w.rules.actors[item.ty as usize].building.as_ref().unwrap();
    let (bw, bh) = (b.width, b.height);
    // Mirror the scan per axis for bases in the right or bottom half of the
    // map, so players on mirrored spawns lay out mirrored bases.
    let (flip_x, flip_y) = (sx * 2 > w.map.width, sy * 2 > w.map.height);
    // Refineries go where the dock is closest to ore, so trips stay short
    // whichever way the dock faces relative to the base.
    let ore = if b.refinery.is_some() { ore_distance_field(w, sx, sy, 26) } else { Vec::new() };
    // Spiral outward from the anchor. Prefer spots that leave a one cell gap so
    // units can still pass; fall back to any legal spot.
    for strict in [true, false] {
        let mut best: Option<(i32, (i32, i32))> = None;
        for r in 0i32..18 {
            for dy in -r..=r {
                for dx in -r..=r {
                    if dx.abs() != r && dy.abs() != r {
                        continue;
                    }
                    // Mirror around the footprint centre, not the top-left corner.
                    let cx = if flip_x { ax - dx - (bw - 3) } else { ax + dx };
                    let cy = if flip_y { ay - dy - (bh - 4) } else { ay + dy };
                    if !w.can_place(player, item.ty, cx, cy) || (strict && !has_clearance(w, cx, cy, bw, bh)) {
                        continue;
                    }
                    if ore.is_empty() {
                        w.place_building(player, item.ty, cx, cy);
                        return;
                    }
                    let score = dock_ore_distance(w, item.ty, cx, cy, &ore);
                    if best.is_none_or(|(bs, _)| score < bs) {
                        best = Some((score, (cx, cy)));
                    }
                }
            }
        }
        if let Some((_, (cx, cy))) = best {
            w.place_building(player, item.ty, cx, cy);
            return;
        }
    }
    // Nowhere to place: cancel and get the money back.
    w.cancel_production(player, item.ty);
}

/// Ground distance (10 per straight step, 14 per diagonal) from every cell to
/// the nearest ore cell within `radius` cells of a base; `i32::MAX` where no
/// ore is reachable. Empty when there is no ore near the base.
fn ore_distance_field(w: &World, sx: i32, sy: i32, radius: i32) -> Vec<i32> {
    let mut d = vec![i32::MAX; w.map.cells()];
    let mut heap = std::collections::BinaryHeap::new();
    for y in sy - radius..=sy + radius {
        for x in sx - radius..=sx + radius {
            if w.map.contains(x, y) {
                let i = w.map.idx(x, y);
                if w.map.ore[i] > 0 && !w.pass.blocked[i] {
                    d[i] = 0;
                    heap.push(std::cmp::Reverse((0, i)));
                }
            }
        }
    }
    if heap.is_empty() {
        return Vec::new();
    }
    while let Some(std::cmp::Reverse((c, i))) = heap.pop() {
        if c > d[i] {
            continue;
        }
        let (x, y) = ((i as i32) % w.map.width, (i as i32) / w.map.width);
        for dir in 0..8 {
            if let Some(j) = crate::flowfield::step(&w.map, &w.pass.blocked, x, y, dir) {
                let nc = c + if dir % 2 == 0 { 10 } else { 14 };
                if nc < d[j] {
                    d[j] = nc;
                    heap.push(std::cmp::Reverse((nc, j)));
                }
            }
        }
    }
    d
}

/// How far an ore truck drives from the dock of a refinery placed at (cx, cy)
/// to the nearest ore. The refinery's own walls count, so a dock that faces
/// away from the ore scores worse than one that faces it.
fn dock_ore_distance(w: &World, ty: u16, cx: i32, cy: i32, field: &[i32]) -> i32 {
    let b = w.rules.actors[ty as usize].building.as_ref().unwrap();
    let Some(rf) = b.refinery.as_ref() else { return 0 };
    let x = cx * CELL + b.width * crate::math::HALF_CELL + b.center_offset.0 + rf.dock_offset.0;
    let y = cy * CELL + b.height * crate::math::HALF_CELL + b.center_offset.1 + rf.dock_offset.1;
    let (dx, dy) = (x.div_euclid(CELL), y.div_euclid(CELL));
    let walls = |px: i32, py: i32| b.footprint.iter().any(|&(fx, fy, c)| c == FootCell::Occupied && (cx + fx, cy + fy) == (px, py));
    let mut best = i32::MAX;
    for (dir, &(ox, oy)) in crate::flowfield::DIRS.iter().enumerate() {
        let (nx, ny) = (dx + ox, dy + oy);
        if !w.map.contains(nx, ny) || walls(nx, ny) {
            continue;
        }
        // No cutting past a wall corner on diagonal steps.
        if ox != 0 && oy != 0 && (walls(dx + ox, dy) || walls(dx, dy + oy)) {
            continue;
        }
        let f = field[w.map.idx(nx, ny)];
        if f != i32::MAX {
            best = best.min(f + if dir % 2 == 0 { 10 } else { 14 });
        }
    }
    best
}

fn has_clearance(w: &World, cx: i32, cy: i32, bw: i32, bh: i32) -> bool {
    for y in cy - 1..=cy + bh {
        for x in cx - 1..=cx + bw {
            let inside = x >= cx && x < cx + bw && y >= cy && y < cy + bh;
            if inside || !w.map.contains(x, y) {
                continue;
            }
            let i = w.map.idx(x, y);
            if w.building_at[i] != crate::world::NONE {
                return false;
            }
        }
    }
    true
}

/// Centre of a player's starting yard.
fn base_point(w: &World, player: u8) -> (i32, i32) {
    let (sx, sy) = w.players[player as usize].start;
    (cell_center(sx + 1), cell_center(sy + 2))
}

/// First enemy unit within `DEFEND_RADIUS` of a point that `player` can see
/// and target. Mines, cloaked or submerged units and passengers do not count:
/// the army could only rally to them and stand there.
fn threat_near(w: &World, player: u8, at: (i32, i32)) -> Option<usize> {
    (0..w.actors.len()).find(|&i| {
        let a = &w.actors[i];
        a.alive
            && a.in_world()
            && !matches!(a.kind, Kind::Building | Kind::Mine)
            && w.are_enemies(player, a.owner)
            && dist(a.x, a.y, at.0, at.1) <= DEFEND_RADIUS
            && w.targetable(i, player)
    })
}

fn command_army(w: &mut World, player: u8) {
    let base = base_point(w, player);
    let army: Vec<usize> = (0..w.actors.len())
        .filter(|&i| {
            let a = &w.actors[i];
            a.alive && a.owner == player && a.kind != Kind::Building && is_army_unit(w, a.ty as usize)
        })
        .collect();
    let idle: Vec<usize> = army.iter().copied().filter(|&i| w.actors[i].activity == Activity::Idle).collect();

    // Defend: enemies near our base pull idle units in.
    if let Some(t) = threat_near(w, player, base) {
        let (tx, ty) = (w.actors[t].x, w.actors[t].y);
        w.order_move(&idle, tx, ty, true);
        return;
    }
    // Help allies: enemies near a teammate's base pull idle units there too.
    if let Some(t) = allied_base_threat(w, player) {
        let (tx, ty) = (w.actors[t].x, w.actors[t].y);
        w.order_move(&idle, tx, ty, true);
        return;
    }

    // Gather idle units at a rally point toward the map center, attack in waves.
    let (mx, my) = (w.map.width * CELL / 2, w.map.height * CELL / 2);
    let rally = (base.0 + (mx - base.0) / 4, base.1 + (my - base.1) / 4);
    let gathered: Vec<usize> = idle.iter().copied().filter(|&i| dist(w.actors[i].x, w.actors[i].y, rally.0, rally.1) < 6 * CELL).collect();
    let target_player = update_target_player(w, player);
    let target = enemy_target(w, player, target_player, base);
    let (wave, max_wave) = (w.ai[player as usize].wave_size, w.ai[player as usize].max_wave);
    if gathered.len() >= wave {
        if let Some((tx, ty)) = target {
            w.order_move(&gathered, tx, ty, true);
            w.ai[player as usize].wave_size = (wave + 2).min(max_wave);
        }
        return;
    }
    // Units of an earlier wave that went idle in the field keep pushing; the rest regroup.
    let (forward, home): (Vec<usize>, Vec<usize>) =
        idle.into_iter().filter(|i| !gathered.contains(i)).partition(|&i| dist(w.actors[i].x, w.actors[i].y, rally.0, rally.1) > 20 * CELL);
    if let Some((tx, ty)) = target {
        w.order_move(&forward, tx, ty, true);
    }
    w.order_move(&home, rally.0, rally.1, false);
}

/// A visible enemy unit near the base of a living ally, nearest ally base first.
fn allied_base_threat(w: &World, player: u8) -> Option<usize> {
    let base = base_point(w, player);
    let mut allies: Vec<(i64, u8)> = (0..w.players.len() as u8)
        .filter(|&p| p != player && w.are_allies(player, p) && !w.players[p as usize].defeated && has_buildings(w, p))
        .map(|p| {
            let b = base_point(w, p);
            (crate::math::dist_sq(base.0, base.1, b.0, b.1), p)
        })
        .collect();
    allies.sort_unstable();
    allies.into_iter().find_map(|(_, p)| threat_near(w, player, base_point(w, p)))
}

fn has_buildings(w: &World, player: u8) -> bool {
    w.actors.iter().any(|a| a.alive && a.owner == player && a.kind == Kind::Building)
}

/// A player still in the game that `player` may attack.
fn is_live_enemy(w: &World, player: u8, p: u8) -> bool {
    w.are_enemies(player, p) && !w.players[p as usize].defeated && w.actors.iter().any(|a| a.alive && a.owner == p)
}

/// Military strength: value of armed units and armed structures.
fn strength(w: &World, player: u8) -> i64 {
    w.actors
        .iter()
        .filter(|a| a.alive && a.owner == player)
        .filter(|a| {
            let info = &w.rules.actors[a.ty as usize];
            !info.weapons.is_empty() && !info.is_wall()
        })
        .map(|a| w.rules.actors[a.ty as usize].cost as i64)
        .sum()
}

/// Distance from a point to a player's nearest building, or nearest unit when
/// it has no buildings left.
fn distance_to_player(w: &World, from: (i32, i32), p: u8) -> i32 {
    let mut best: Option<(bool, i32)> = None;
    for a in w.actors.iter().filter(|a| a.alive && a.owner == p && a.in_world() && a.kind != Kind::Mine) {
        let key = (a.kind != Kind::Building, dist(from.0, from.1, a.x, a.y));
        if best.is_none_or(|b| key < b) {
            best = Some(key);
        }
    }
    best.map_or(i32::MAX, |(_, d)| d)
}

/// The enemy player to attack from `player`'s point of view: the nearest
/// hostile base; among bases about as near as that one, the weakest player.
pub(crate) fn choose_target_player(w: &World, player: u8) -> Option<u8> {
    let base = base_point(w, player);
    let enemies: Vec<(u8, i32)> =
        (0..w.players.len() as u8).filter(|&p| is_live_enemy(w, player, p)).map(|p| (p, distance_to_player(w, base, p))).collect();
    let nearest = enemies.iter().map(|&(_, d)| d).min()?;
    enemies.iter().filter(|&&(_, d)| d <= nearest.saturating_add(NEAR_TIE)).min_by_key(|&&(p, d)| (strength(w, p), d, p)).map(|&(p, _)| p)
}

/// The team leader: the lowest slot AI player still alive on `player`'s team.
fn team_leader(w: &World, player: u8) -> u8 {
    if w.players[player as usize].team == 0 {
        return player;
    }
    (0..w.players.len() as u8)
        .find(|&p| w.are_allies(player, p) && w.players[p as usize].is_ai && !w.players[p as usize].defeated)
        .unwrap_or(player)
}

/// Keep (or pick) the enemy player this AI attacks. AI teammates follow their
/// leader's choice so the team attacks one enemy together.
pub(crate) fn update_target_player(w: &mut World, player: u8) -> Option<u8> {
    let leader = team_leader(w, player);
    if leader != player {
        if let Some(t) = w.ai[leader as usize].target_player.filter(|&t| is_live_enemy(w, player, t)) {
            w.ai[player as usize].target_player = Some(t);
            return Some(t);
        }
    }
    let state = &w.ai[player as usize];
    let current = state.target_player.filter(|&t| is_live_enemy(w, player, t));
    if current.is_some() && w.tick < state.retarget_at {
        return current;
    }
    let chosen = choose_target_player(w, player);
    let state = &mut w.ai[player as usize];
    state.target_player = chosen;
    state.retarget_at = w.tick + RETARGET_TICKS;
    chosen
}

/// Where to send attacks: the target player's building closest to our base,
/// else its nearest unit; without a target player, the nearest enemy building.
/// Like most skirmish AIs, it knows where the enemy bases are.
fn enemy_target(w: &World, player: u8, target_player: Option<u8>, base: (i32, i32)) -> Option<(i32, i32)> {
    let mut best: Option<(i64, (i32, i32))> = None;
    for a in &w.actors {
        let wanted = match target_player {
            Some(t) => a.owner == t,
            None => w.are_enemies(player, a.owner) && !w.players[a.owner as usize].defeated,
        };
        // Buildings are known (like most skirmish AIs, it knows the bases);
        // units only count when they are in the world and not mines.
        if !a.alive || !wanted || !a.in_world() || a.kind == Kind::Mine {
            continue;
        }
        let d = crate::math::dist_sq(a.x, a.y, base.0, base.1) + if a.kind == Kind::Building { 0 } else { 1 << 50 };
        if best.is_none_or(|(bd, _)| d < bd) {
            best = Some((d, (a.x, a.y)));
        }
    }
    best.map(|(_, p)| p)
}

// ---- Support powers ------------------------------------------------------------

/// The target player's building with the most of its other buildings within
/// 5 cells: where a nuke or a bomb run hurts most. Ties go to the lower index.
fn densest_building(w: &World, target: u8) -> Option<(i32, i32)> {
    let buildings: Vec<usize> =
        (0..w.actors.len()).filter(|&i| w.actors[i].alive && w.actors[i].owner == target && w.actors[i].kind == Kind::Building).collect();
    let near = |i: usize| {
        let a = &w.actors[i];
        buildings.iter().filter(|&&j| dist(a.x, a.y, w.actors[j].x, w.actors[j].y) <= 5 * CELL).count()
    };
    let best = buildings.iter().copied().max_by_key(|&i| (near(i), std::cmp::Reverse(i)))?;
    Some((w.actors[best].x, w.actors[best].y))
}

/// Fire every ready support power that has a sensible target: the GPS
/// satellite at once, the spy plane over the target player's base, bombs,
/// paratroopers and the nuke on its densest building. The Chronosphere and
/// the Iron Curtain need unit tactics the AI does not have yet; it leaves them.
fn use_support_powers(w: &mut World, player: u8) {
    let ready: Vec<(String, String)> =
        w.power_instances(player).iter().filter(|p| p.ready()).map(|p| (p.key.clone(), w.power_info(p).kind.clone())).collect();
    if ready.is_empty() {
        return;
    }
    let base = base_point(w, player);
    let target_player =
        w.ai[player as usize].target_player.filter(|&t| is_live_enemy(w, player, t)).or_else(|| choose_target_player(w, player));
    for (key, kind) in ready {
        let at = match kind.as_str() {
            "GpsPower" => Some(base),
            "AirstrikePower" if key.ends_with("@spyplane") => enemy_target(w, player, target_player, base),
            "AirstrikePower" | "ParatroopersPower" | "NukePower" => target_player.and_then(|t| densest_building(w, t)),
            _ => None,
        };
        if let Some((x, y)) = at {
            w.queue_order(Order::SupportPower { player, key, x, y, x2: None, y2: None });
        }
    }
}

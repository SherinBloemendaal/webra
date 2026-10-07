//! Skirmish AI: follows a build order, keeps harvesters busy, builds an army and
//! attacks in growing waves. It plays by the same rules and economy as a human.

use crate::math::{dist, CELL};
use crate::rules::{Kind, QueueType};
use crate::world::{cell_center, Activity, World};

const THINK_INTERVAL: u32 = 25;
const FIRST_WAVE: usize = 6;
const MAX_WAVE: usize = 20;
const DEFEND_RADIUS: i32 = 14 * CELL;

pub struct AiState {
    offset: u32,
    wave_size: usize,
}

impl AiState {
    pub fn new(player: u32) -> AiState {
        AiState { offset: player * 7, wave_size: FIRST_WAVE }
    }
}

/// Build order by prerequisite token rather than actor id, so it works for both sides.
const BUILD_ORDER: &[&str] = &["anypower", "proc", "barracks", "weap", "proc", "anypower", "fix", "anypower", "anypower"];

pub fn think(w: &mut World, player: u8) {
    let state = &w.ai[player as usize];
    if (w.tick + state.offset) % THINK_INTERVAL != 0 {
        return;
    }
    place_ready_building(w, player);
    queue_buildings(w, player);
    queue_units(w, player);
    command_army(w, player);
}

fn owned_buildings(w: &World, player: u8) -> Vec<usize> {
    (0..w.actors.len())
        .filter(|&i| w.actors[i].alive && w.actors[i].owner == player && w.actors[i].kind == Kind::Building)
        .collect()
}

fn count_providing(w: &World, player: u8, token: &str) -> usize {
    let faction = w.players[player as usize].faction;
    let Some(t) = w.rules.tokens.iter().position(|x| x == token) else { return 0 };
    owned_buildings(w, player)
        .iter()
        .filter(|&&b| w.rules.actors[w.actors[b].ty as usize].building.as_ref().unwrap().provides[faction].contains(&(t as u16)))
        .count()
}

/// Cheapest enabled building that provides `token`.
fn building_for(w: &World, player: u8, token: &str) -> Option<u16> {
    let faction = w.players[player as usize].faction;
    let t = w.rules.tokens.iter().position(|x| x == token)? as u16;
    (0..w.rules.actors.len())
        .filter(|&a| {
            let info = &w.rules.actors[a];
            info.kind == Kind::Building
                && info.building.as_ref().unwrap().provides[faction].contains(&t)
                && w.availability(player, a as u16).enabled
        })
        .min_by_key(|&a| w.rules.actors[a].cost)
        .map(|a| a as u16)
}

fn queue_buildings(w: &mut World, player: u8) {
    if !w.players[player as usize].queues[QueueType::Building as usize].items.is_empty() {
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

fn queue_units(w: &mut World, player: u8) {
    let order_done = {
        let mut needed: Vec<(&str, usize)> = Vec::new();
        BUILD_ORDER.iter().all(|&tok| {
            match needed.iter_mut().find(|(t, _)| *t == tok) {
                Some(e) => e.1 += 1,
                None => needed.push((tok, 1)),
            }
            let want = needed.iter().find(|(t, _)| *t == tok).unwrap().1;
            count_providing(w, player, tok) >= want || building_for(w, player, tok).is_none()
        })
    };
    let funds = w.players[player as usize].funds();
    let mut candidates: Vec<u16> = (0..w.rules.actors.len() as u16).filter(|&a| w.availability(player, a).enabled).collect();
    candidates.sort_by_key(|&a| std::cmp::Reverse(w.rules.actors[a as usize].cost));

    // Infantry is cheap: keep a trickle going whenever there is spare money.
    let iq = QueueType::Infantry as usize;
    if w.players[player as usize].queues[iq].items.len() < 2 && (order_done || funds >= 600) {
        if let Some(&inf) = candidates.iter().rev().find(|&&a| {
            let info = &w.rules.actors[a as usize];
            info.queue == QueueType::Infantry && !info.weapons.is_empty()
        }) {
            w.start_production(player, inf, 1);
        }
    }

    // One harvester per refinery, plus a spare once the war factory is up.
    let refineries = count_providing(w, player, "proc");
    let harvesters = (0..w.actors.len()).filter(|&i| w.actors[i].alive && w.actors[i].owner == player && w.is_harvester(i)).count();
    let vq = QueueType::Vehicle as usize;
    if !w.players[player as usize].queues[vq].items.is_empty() {
        return;
    }
    if harvesters < refineries + 1 && refineries > 0 {
        if let Some(&h) = candidates.iter().find(|&&a| w.rules.actors[a as usize].unit.as_ref().map_or(false, |u| u.harvester.is_some())) {
            if harvesters < refineries || funds >= 1500 {
                w.start_production(player, h, 1);
                return;
            }
        }
    }
    // Tanks once the build order is done (or when rich).
    if order_done || funds >= 2500 {
        if let Some(&tank) = candidates.iter().find(|&&a| {
            let info = &w.rules.actors[a as usize];
            info.queue == QueueType::Vehicle && !info.weapons.is_empty()
        }) {
            w.start_production(player, tank, 1);
        }
    }
}

fn place_ready_building(w: &mut World, player: u8) {
    let qi = QueueType::Building as usize;
    let Some(item) = w.players[player as usize].queues[qi].items.first().cloned() else { return };
    if !item.done {
        return;
    }
    let (sx, sy) = w.players[player as usize].start;
    let b = w.rules.actors[item.ty as usize].building.as_ref().unwrap();
    let (bw, bh) = (b.width, b.height);
    // Spiral outward from the base. Prefer spots that leave a one cell gap so
    // units can still pass; fall back to any legal spot.
    for strict in [true, false] {
        for r in 0i32..16 {
            for dy in -r..=r {
                for dx in -r..=r {
                    if dx.abs() != r && dy.abs() != r {
                        continue;
                    }
                    let (cx, cy) = (sx + dx, sy + dy);
                    if w.can_place(player, item.ty, cx, cy) && (!strict || has_clearance(w, cx, cy, bw, bh)) {
                        w.place_building(player, item.ty, cx, cy);
                        return;
                    }
                }
            }
        }
    }
    // Nowhere to place: cancel and get the money back.
    w.cancel_production(player, item.ty);
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

fn command_army(w: &mut World, player: u8) {
    let (sx, sy) = w.players[player as usize].start;
    let base = (cell_center(sx + 1), cell_center(sy + 2));
    let army: Vec<usize> = (0..w.actors.len())
        .filter(|&i| {
            let a = &w.actors[i];
            a.alive && a.owner == player && a.kind != Kind::Building && !w.is_harvester(i) && !w.rules.actors[a.ty as usize].weapons.is_empty()
        })
        .collect();

    // Defend: enemies near our buildings pull idle units in.
    let threat = (0..w.actors.len()).find(|&i| {
        let a = &w.actors[i];
        a.alive && a.owner != player && a.kind != Kind::Building && w.is_visible_to(i, player) && dist(a.x, a.y, base.0, base.1) <= DEFEND_RADIUS
    });
    if let Some(t) = threat {
        let idle: Vec<usize> = army.iter().copied().filter(|&i| w.actors[i].activity == Activity::Idle).collect();
        let (tx, ty) = (w.actors[t].x, w.actors[t].y);
        w.order_move(&idle, tx, ty, true);
        return;
    }

    // Gather idle units at a rally point toward the map center, attack in waves.
    let (mx, my) = (w.map.width * CELL / 2, w.map.height * CELL / 2);
    let rally = (base.0 + (mx - base.0) / 4, base.1 + (my - base.1) / 4);
    let idle: Vec<usize> = army.iter().copied().filter(|&i| w.actors[i].activity == Activity::Idle).collect();
    let gathered: Vec<usize> = idle.iter().copied().filter(|&i| dist(w.actors[i].x, w.actors[i].y, rally.0, rally.1) < 6 * CELL).collect();
    let target = enemy_target(w, player, base);
    let wave = w.ai[player as usize].wave_size;
    if gathered.len() >= wave {
        if let Some((tx, ty)) = target {
            w.order_move(&gathered, tx, ty, true);
            w.ai[player as usize].wave_size = (wave + 2).min(MAX_WAVE);
        }
        return;
    }
    // Units of an earlier wave that went idle in the field keep pushing; the rest regroup.
    let (forward, home): (Vec<usize>, Vec<usize>) = idle
        .into_iter()
        .filter(|i| !gathered.contains(i))
        .partition(|&i| dist(w.actors[i].x, w.actors[i].y, rally.0, rally.1) > 20 * CELL);
    if let Some((tx, ty)) = target {
        w.order_move(&forward, tx, ty, true);
    }
    w.order_move(&home, rally.0, rally.1, false);
}

/// Where to send attacks: the enemy building closest to our base, else any enemy unit.
/// Like most skirmish AIs, it knows where the enemy base is.
fn enemy_target(w: &World, player: u8, base: (i32, i32)) -> Option<(i32, i32)> {
    let mut best: Option<(i64, (i32, i32))> = None;
    for a in &w.actors {
        if !a.alive || a.owner == player || w.players[a.owner as usize].defeated {
            continue;
        }
        let d = crate::math::dist_sq(a.x, a.y, base.0, base.1) + if a.kind == Kind::Building { 0 } else { 1 << 50 };
        if best.map_or(true, |(bd, _)| d < bd) {
            best = Some((d, (a.x, a.y)));
        }
    }
    best.map(|(_, p)| p)
}

//! OpenRA MinelayerBotModule (Turtle AI): where enemies hit the bot's units
//! away from any base, the spot goes into a short queue; Minelayers mine
//! those spots (three by three cells), remember the good ones as favourite
//! spots and mine those again later. Without any, they mine halfway to a
//! random enemy. A spot near an enemy is mined three quarters of the way
//! there instead.

use crate::ai::rand;
use crate::ai_bots::{target_type_mask, target_types, MinelayerInfo};
use crate::math::{dist_sq, CELL};
use crate::rules::Kind;
use crate::world::{cell_center, Activity, Order, World};

/// MinelayerBotModule.MaxPositionCacheLength.
const MAX_POSITIONS: usize = 5;
/// MinelayerBotModule.RepeatedAltertTicks.
const REPEATED_ALERT_TICKS: i32 = 40;

#[derive(Clone, Default, Debug)]
pub(crate) struct MineState {
    ticks: i32,
    alerted: i32,
    conflicts: Vec<(i32, i32)>,
    favorites: Vec<(i32, i32)>,
    favorite_index: usize,
}

pub(crate) fn start(w: &mut World, player: u8) {
    let cfg = w.ai[player as usize].cfg.clone();
    if let Some(m) = &cfg.info.minelayer {
        let t = rand(w, 0, m.scan_tick);
        w.ai[player as usize].mines.ticks = t;
    }
}

/// OpenRA MinelayerBotModule.IsPreferredEnemyUnit (no visibility check).
fn preferred(w: &World, player: u8, m: &MinelayerInfo, i: usize) -> bool {
    let a = &w.actors[i];
    if !a.alive || !a.in_world() || matches!(a.kind, Kind::Husk | Kind::Crate | Kind::Proxy | Kind::Mine) || !w.are_enemies(player, a.owner)
    {
        return false;
    }
    let t = target_types(w, i);
    t != 0 && t & target_type_mask(&m.ignored_enemy_target_types) == 0
}

/// HasInvalidActorInCircle: (an allied or enemy actor of the "away from"
/// types is near, an enemy is near).
fn invalid_around(w: &World, player: u8, m: &MinelayerInfo, at: (i32, i32)) -> (bool, bool) {
    let r = (m.away_from_cell_distance * CELL) as i64;
    let allied = target_type_mask(&m.away_from_allied_target_types);
    let enemy = target_type_mask(&m.away_from_enemy_target_types);
    let mut near_enemy = false;
    for i in 0..w.actors.len() {
        let a = &w.actors[i];
        if !a.alive
            || !a.in_world()
            || matches!(a.kind, Kind::Husk | Kind::Crate | Kind::Proxy | Kind::Mine)
            || dist_sq(a.x, a.y, at.0, at.1) > r * r
        {
            continue;
        }
        if w.are_allies(player, a.owner) {
            if target_types(w, i) & allied != 0 {
                return (true, near_enemy);
            }
        } else if w.are_enemies(player, a.owner) {
            near_enemy = true;
            if target_types(w, i) & enemy != 0 {
                return (true, near_enemy);
            }
        }
    }
    (false, near_enemy)
}

/// IBotRespondToAttack: remember where the fight was (the attacker's cell
/// when a structure was hit, else the victim's).
pub(crate) fn respond_to_attack(w: &mut World, player: u8, victim: usize, attacker: usize) {
    let cfg = w.ai[player as usize].cfg.clone();
    let Some(m) = &cfg.info.minelayer else { return };
    if w.ai[player as usize].mines.alerted > 0 || !preferred(w, player, m, attacker) {
        return;
    }
    w.ai[player as usize].mines.alerted = REPEATED_ALERT_TICKS;
    let at = (w.actors[victim].x, w.actors[victim].y);
    if invalid_around(w, player, m, at).0 {
        return;
    }
    let by_enemy = target_types(w, victim) & target_type_mask(&m.use_enemy_location_target_types) != 0;
    let pos = if by_enemy { w.cell_of(w.actors[attacker].x, w.actors[attacker].y) } else { w.cell_of(at.0, at.1) };
    enqueue(&mut w.ai[player as usize].mines, pos);
}

fn enqueue(st: &mut MineState, cell: (i32, i32)) {
    if st.conflicts.len() < MAX_POSITIONS {
        st.conflicts.push(cell);
    } else {
        st.conflicts[MAX_POSITIONS - 1] = cell;
    }
}

/// A ground path from `from` to `to`, destination first (as OpenRA's path finder returns it).
fn ground_path(w: &World, from: (i32, i32), to: (i32, i32)) -> Option<Vec<(i32, i32)>> {
    if !w.map.contains(to.0, to.1) {
        return None;
    }
    let start = w.map.idx(from.0, from.1);
    let goal = w.map.idx(to.0, to.1);
    if w.pass.blocked[goal] || w.pass.component[goal] != w.pass.component[start] {
        return None;
    }
    let mut prev = vec![usize::MAX; w.map.cells()];
    prev[start] = start;
    let mut queue = std::collections::VecDeque::from([start]);
    while let Some(ci) = queue.pop_front() {
        if ci == goal {
            let mut path = vec![(ci as i32 % w.map.width, ci as i32 / w.map.width)];
            let mut c = ci;
            while c != start {
                c = prev[c];
                path.push((c as i32 % w.map.width, c as i32 / w.map.width));
            }
            return Some(path);
        }
        let (x, y) = (ci as i32 % w.map.width, ci as i32 / w.map.width);
        for dir in 0..8 {
            if let Some(j) = crate::flowfield::step(&w.map, &w.pass.blocked, x, y, dir) {
                if prev[j] == usize::MAX {
                    prev[j] = ci;
                    queue.push_back(j);
                }
            }
        }
    }
    None
}

pub(crate) fn tick(w: &mut World, player: u8) {
    let cfg = w.ai[player as usize].cfg.clone();
    let Some(m) = &cfg.info.minelayer else { return };
    let st = &mut w.ai[player as usize].mines;
    if st.alerted > 0 {
        st.alerted -= 1;
    }
    st.ticks -= 1;
    if st.ticks > 0 {
        return;
    }
    st.ticks = m.scan_tick;
    let mut spot = (0, 0);
    let mut favorite = false;
    let mut halfway = false;
    while let Some(&c) = w.ai[player as usize].mines.conflicts.first() {
        let (invalid, enemy) = invalid_around(w, player, m, (cell_center(c.0), cell_center(c.1)));
        if invalid {
            w.ai[player as usize].mines.conflicts.remove(0);
        } else {
            spot = c;
            halfway = enemy;
            break;
        }
    }
    let layers: Vec<usize> = (0..w.actors.len())
        .filter(|&i| {
            let a = &w.actors[i];
            a.alive
                && a.owner == player
                && a.in_world()
                && a.activity == Activity::Idle
                && cfg.minelayers.contains(&a.ty)
                && w.rules.actors[a.ty as usize].abilities.minelayer.is_some()
        })
        .collect();
    if w.ai[player as usize].mines.conflicts.is_empty() {
        if w.ai[player as usize].mines.favorites.is_empty() {
            if layers.is_empty() {
                return;
            }
            let enemies: Vec<usize> = (0..w.actors.len()).filter(|&i| preferred(w, player, m, i)).collect();
            let Some(e) = crate::ai_units::pick(w, &enemies) else { return };
            let to = w.cell_of(w.actors[e].x, w.actors[e].y);
            for &l in &layers {
                let from = w.cell_of(w.actors[l].x, w.actors[l].y);
                if let Some(path) = ground_path(w, from, to) {
                    enqueue(&mut w.ai[player as usize].mines, path[path.len() / 2]);
                    return;
                }
            }
            return;
        }
        loop {
            let st = &w.ai[player as usize].mines;
            if st.favorites.is_empty() {
                return;
            }
            let c = st.favorites[st.favorite_index];
            let (invalid, enemy) = invalid_around(w, player, m, (cell_center(c.0), cell_center(c.1)));
            if invalid {
                delete_favorite(&mut w.ai[player as usize].mines);
            } else {
                spot = c;
                halfway = enemy;
                favorite = true;
                break;
            }
        }
    }
    if layers.is_empty() {
        return;
    }
    let mut ordered: Vec<usize> = Vec::new();
    for &l in &layers {
        let from = w.cell_of(w.actors[l].x, w.actors[l].y);
        if let Some(path) = ground_path(w, from, spot) {
            ordered.push(l);
            if halfway {
                spot = path[path.len() / 4];
                halfway = false;
            }
            if ordered.len() as i32 >= m.max_per_assign {
                break;
            }
        }
    }
    let st = &mut w.ai[player as usize].mines;
    if ordered.is_empty() {
        if favorite {
            delete_favorite(st);
        } else if !st.conflicts.is_empty() {
            st.conflicts.remove(0);
        }
        return;
    }
    if favorite {
        st.favorite_index = (st.favorite_index + 1) % st.favorites.len();
    } else {
        if !st.conflicts.is_empty() {
            st.conflicts.remove(0);
        }
        add_favorite(st, spot, m.favorite_position_distance);
    }
    let r = m.mine_field_radius;
    let ids: Vec<u32> = ordered.iter().map(|&i| w.make_ref(i)).collect();
    let back = (w.actors[ordered[0]].x, w.actors[ordered[0]].y);
    w.queue_order(Order::LayMines { player, ids: ids.clone(), x0: spot.0 - r, y0: spot.1 - r, x1: spot.0 + r, y1: spot.1 + r });
    w.queue_order(Order::Waypoint { player, ids, x: back.0, y: back.1, attack_move: false });
}

fn delete_favorite(st: &mut MineState) {
    if st.favorites.is_empty() {
        return;
    }
    st.favorites.remove(st.favorite_index);
    if !st.favorites.is_empty() {
        st.favorite_index %= st.favorites.len();
    } else {
        st.favorite_index = 0;
    }
}

/// AddPositionToFavoritePositions: a new favourite, or merged into the nearest one.
fn add_favorite(st: &mut MineState, cell: (i32, i32), distance: i32) {
    let nearest = st.favorites.iter().enumerate().map(|(k, f)| ((f.0 - cell.0).pow(2) + (f.1 - cell.1).pow(2), k)).min();
    match nearest {
        Some((d, k)) if d <= distance * distance || st.favorites.len() >= MAX_POSITIONS => {
            let f = st.favorites[k];
            st.favorites[k] = ((f.0 - cell.0) / 2 + cell.0, (f.1 - cell.1) / 2 + cell.1);
        }
        _ => st.favorites.push(cell),
    }
}

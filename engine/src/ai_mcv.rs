//! OpenRA McvExpansionManagerBotModule (Rush, Normal and Turtle AI) and
//! McvManagerBotModule (Naval AI): deploy MCVs, build new ones to keep
//! MinimumConstructionYardCount yards, and expand: an extra MCV (or a yard
//! packed up when the base has outgrown its refineries) drives to the
//! resource square that scores best (ore, distance, threats, own yards and
//! refineries there; ai_harvest.rs resource map) and deploys there, asking
//! the base builder for a refinery by that ore.
//!
//! Differences: OpenRA queues the deploy behind the move; the engine has no
//! queued deploy, so a moving MCV is remembered and deploys once it stands
//! at its spot. Path lengths are ground cell steps (OpenRA asks its path
//! finder), and Construction Yards only pack up with the "Redeployable MCVs"
//! lobby option. A square without ore is never a target (OpenRA's centre of
//! it, CPos.Zero, lies outside its maps; WebRA's maps have a cell (0, 0)),
//! and a yard waits with packing up while a refinery is queued (OpenRA
//! checks the yard's own queues, which RA does not have).

use crate::ai::{count_own, own_of, rand};
use crate::ai_base::Cell;
use crate::ai_bots::BotConfig;
use crate::world::{Activity, Order, World};

#[derive(Clone, Copy, PartialEq, Eq, Default, Debug)]
enum Mode {
    #[default]
    CheckResource,
    CheckBase,
}

const CR_POSITIVE_MAX_FAILED: i32 = 3;
const NEGATIVE_MAX_FAILED: i32 = 0;

#[derive(Clone, Default, Debug)]
pub(crate) struct McvState {
    /// Expanding MCVs (references) and the resource square they head for.
    active: Vec<(u32, Option<(i32, i32)>)>,
    /// MCVs on their way to deploy: (reference, yard top-left cell).
    moving: Vec<(u32, (i32, i32))>,
    scan_ticks: i32,
    build_ticks: i32,
    move_ticks: i32,
    started: bool,
    undeploy_even_no_base: bool,
    no_fallback: bool,
    mode: Mode,
    min_radius: i32,
    max_radius: i32,
    keep: i32,
    max_failed: i32,
    failed: i32,
    last_failed_spot: Option<(i32, i32)>,
    respond_cooldown: i32,
    /// Own Construction Yards (references), oldest first (OpenRA orders them by ActorID).
    yard_order: Vec<u32>,
}

pub(crate) fn start(w: &mut World, player: u8) {
    let cfg = w.ai[player as usize].cfg.clone();
    if let Some(m) = &cfg.info.mcv_expansion {
        let scan = rand(w, m.scan_for_new_mcv_interval, m.scan_for_new_mcv_interval * 2);
        let build = rand(w, m.build_mcv_interval, m.build_mcv_interval * 2);
        let mv = rand(w, m.move_conyard_tick, m.move_conyard_tick * 2);
        let st = &mut w.ai[player as usize].mcv;
        st.scan_ticks = scan;
        st.build_ticks = build;
        st.move_ticks = mv;
        st.respond_cooldown = 20;
        switch_mode(st, &cfg, Mode::CheckResource);
    } else if let Some(m) = &cfg.info.mcv_manager {
        let scan = rand(w, m.scan_for_new_mcv_interval, m.scan_for_new_mcv_interval * 2);
        w.ai[player as usize].mcv.scan_ticks = scan;
    }
}

fn switch_mode(st: &mut McvState, cfg: &BotConfig, mode: Mode) {
    let Some(m) = &cfg.info.mcv_expansion else { return };
    st.mode = mode;
    match mode {
        Mode::CheckResource => {
            st.min_radius = m.cr_mode_min_deploy_radius;
            st.max_radius = m.cr_mode_max_deploy_radius;
            st.keep = m.cr_mode_try_maintain_range;
        }
        Mode::CheckBase => {
            st.min_radius = m.cb_mode_min_deploy_radius;
            st.max_radius = m.cb_mode_max_deploy_radius;
            st.keep = (m.cb_mode_max_deploy_radius + m.cb_mode_min_deploy_radius) >> 1;
        }
    }
}

/// IBotBaseExpansion.UpdateExpansionParams (from the base builder): look at
/// moving a yard soon.
pub(crate) fn update_expansion_params(w: &mut World, player: u8, fallback: bool, undeploy_even_no_base: bool, _stuck: Option<u32>) {
    if w.ai[player as usize].cfg.info.mcv_expansion.is_none() {
        return;
    }
    let st = &mut w.ai[player as usize].mcv;
    st.move_ticks = 20;
    st.no_fallback = !fallback;
    st.undeploy_even_no_base = undeploy_even_no_base;
}

fn idle(w: &World, i: usize) -> bool {
    w.actors[i].activity == Activity::Idle && w.actors[i].waypoints.is_empty()
}

pub(crate) fn tick(w: &mut World, player: u8) {
    let cfg = w.ai[player as usize].cfg.clone();
    deploy_arrived(w, player);
    if cfg.info.mcv_expansion.is_some() {
        tick_expansion(w, player, &cfg);
    } else if cfg.info.mcv_manager.is_some() {
        tick_manager(w, player, &cfg);
    }
}

/// MCVs that reached their spot deploy (the queued DeployTransform of OpenRA).
fn deploy_arrived(w: &mut World, player: u8) {
    let moving = std::mem::take(&mut w.ai[player as usize].mcv.moving);
    let mut keep = Vec::new();
    for (r, spot) in moving {
        let Some(i) = w.resolve(r).filter(|&i| w.actors[i].alive && w.actors[i].owner == player && w.actors[i].in_world()) else {
            continue;
        };
        if !idle(w, i) {
            keep.push((r, spot));
            continue;
        }
        if w.deploy_target(i).is_some_and(|(_, cx, cy)| (cx, cy) == spot) && w.can_deploy(i) {
            w.queue_order(Order::Deploy { player, ids: vec![r] });
        }
    }
    w.ai[player as usize].mcv.moving = keep;
}

fn tick_expansion(w: &mut World, player: u8, cfg: &BotConfig) {
    let m = cfg.info.mcv_expansion.as_ref().unwrap();
    let st = &mut w.ai[player as usize].mcv;
    st.respond_cooldown -= 1;
    if !st.started {
        st.started = true;
        deploy_mcvs(w, player, cfg, false);
    }
    let st = &mut w.ai[player as usize].mcv;
    st.scan_ticks -= 1;
    if st.scan_ticks <= 0 {
        st.scan_ticks = m.scan_for_new_mcv_interval;
        prune_active(w, player);
        update_yard_order(w, player, cfg);
        deploy_mcvs(w, player, cfg, true);
    }
    let st = &mut w.ai[player as usize].mcv;
    st.build_ticks -= 1;
    if st.build_ticks <= 0 {
        st.build_ticks = m.build_mcv_interval;
        build_mcv(w, player, cfg);
    }
    let st = &mut w.ai[player as usize].mcv;
    st.move_ticks -= 1;
    if st.move_ticks <= 0 {
        st.move_ticks = m.move_conyard_tick;
        prune_active(w, player);
        undeploy_yard(w, player, cfg);
    }
}

fn prune_active(w: &mut World, player: u8) {
    let active = std::mem::take(&mut w.ai[player as usize].mcv.active);
    let keep: Vec<_> =
        active.into_iter().filter(|(r, _)| w.resolve(*r).is_some_and(|i| w.actors[i].alive && w.actors[i].in_world())).collect();
    w.ai[player as usize].mcv.active = keep;
}

/// Keep the own yards in the order they appeared (oldest first).
fn update_yard_order(w: &mut World, player: u8, cfg: &BotConfig) {
    let refs: Vec<u32> = own_of(w, player, &cfg.yards).into_iter().map(|y| w.make_ref(y)).collect();
    let order = &mut w.ai[player as usize].mcv.yard_order;
    order.retain(|r| refs.contains(r));
    for r in refs {
        if !order.contains(&r) {
            order.push(r);
        }
    }
}

fn mcv_queued(w: &World, player: u8, cfg: &BotConfig) -> bool {
    w.players[player as usize].queues.iter().any(|q| q.items.iter().any(|it| cfg.mcvs.contains(&it.ty)))
}

/// OpenRA BuildMCV: an MCV while there are fewer yards (and MCVs) than wanted.
fn build_mcv(w: &mut World, player: u8, cfg: &BotConfig) {
    let m = cfg.info.mcv_expansion.as_ref().unwrap();
    if cfg.mcvs.is_empty() || count_own(w, player, &cfg.mcv_factories) == 0 {
        return;
    }
    let mcvs = count_own(w, player, &cfg.mcvs) as i32;
    let yards = count_own(w, player, &cfg.yards) as i32;
    let want = if w.players[player as usize].funds() >= m.build_additional_mcv_cash_amount {
        m.minimum_construction_yard_count + m.additional_construction_yard_count
    } else {
        m.minimum_construction_yard_count
    };
    if (yards <= 0 && mcvs > 1) || (yards > 0 && mcvs > 0) || yards + mcvs >= want || mcv_queued(w, player, cfg) {
        return;
    }
    let ty = crate::ai_units::pick(w, &cfg.mcvs).unwrap();
    if crate::ai_units::requested(w, player, ty) == 0 {
        crate::ai_units::request(w, player, ty);
    }
}

fn deploy_mcvs(w: &mut World, player: u8, cfg: &BotConfig, choose: bool) {
    let mcvs: Vec<usize> =
        own_of(w, player, &cfg.mcvs).into_iter().filter(|&i| w.actors[i].in_world() && idle(w, i) && !is_moving(w, player, i)).collect();
    for i in mcvs {
        deploy_mcv(w, player, cfg, i, choose);
    }
}

fn is_moving(w: &World, player: u8, i: usize) -> bool {
    let r = w.make_ref(i);
    w.ai[player as usize].mcv.moving.iter().any(|m| m.0 == r)
}

/// OpenRA UnDeployConyard: pack up a yard (the oldest or newest first, one
/// not building a refinery) to move it to a better spot, when there is
/// more than one or the base builder asked for it.
fn undeploy_yard(w: &mut World, player: u8, cfg: &BotConfig) {
    let m = cfg.info.mcv_expansion.as_ref().unwrap();
    if !w.ai[player as usize].mcv.active.is_empty() {
        return;
    }
    update_yard_order(w, player, cfg);
    let mut yards: Vec<usize> = w.ai[player as usize].mcv.yard_order.iter().filter_map(|&r| w.resolve(r)).collect();
    let old_first = match m.move_old_conyard_first {
        Some(b) => b,
        None => rand(w, 0, 2) > 0,
    };
    if !old_first {
        yards.reverse();
    }
    let st = &w.ai[player as usize].mcv;
    if yards.len() > 1 || st.undeploy_even_no_base {
        let producing_refinery = w.players[player as usize].queues.iter().any(|q| q.items.iter().any(|it| cfg.refineries.contains(&it.ty)));
        if let Some(&y) = yards.first().filter(|_| !producing_refinery) {
            if w.can_deploy(y) {
                let r = w.make_ref(y);
                w.queue_order(Order::Deploy { player, ids: vec![r] });
            }
        }
        w.ai[player as usize].mcv.undeploy_even_no_base = false;
    }
}

/// OpenRA DeployMcv: deploy where it stands, or (`choose`) drive to an
/// expansion spot and deploy there.
fn deploy_mcv(w: &mut World, player: u8, cfg: &BotConfig, i: usize, choose: bool) {
    let r = w.make_ref(i);
    let desired = if choose {
        let fallback = !w.ai[player as usize].mcv.no_fallback;
        let (spot, ore, check) = choose_deploy_location(w, player, cfg, i, fallback);
        w.ai[player as usize].mcv.no_fallback = false;
        let Some(spot) = spot else { return };
        let st = &mut w.ai[player as usize].mcv;
        st.active.retain(|a| a.0 != r);
        st.active.push((r, check));
        if let Some(ore) = ore {
            crate::ai_base::request_refinery(w, player, ore, spot, r);
        }
        let off = offset(w, i);
        drive_and_deploy(w, player, i, spot, (spot.0 + off.0, spot.1 + off.1));
        spot
    } else {
        let Some((_, cx, cy)) = w.deploy_target(i) else { return };
        if !w.can_deploy_at(i, cx, cy) {
            return;
        }
        w.queue_order(Order::Deploy { player, ids: vec![r] });
        w.cell_of(w.actors[i].x, w.actors[i].y)
    };
    if count_own(w, player, &cfg.yards) == 0 || rand(w, 0, 2) > 0 {
        let st = &mut w.ai[player as usize].base;
        st.base_center = Some(desired);
        st.defense_center = Some(desired);
    }
}

fn offset(w: &World, i: usize) -> (i32, i32) {
    w.rules.actors[w.actors[i].ty as usize].abilities.transforms.as_ref().map_or((0, 0), |t| (t.offset[0], t.offset[1]))
}

fn drive_and_deploy(w: &mut World, player: u8, i: usize, cell: (i32, i32), yard: (i32, i32)) {
    let r = w.make_ref(i);
    let (x, y) = (crate::world::cell_center(cell.0), crate::world::cell_center(cell.1));
    w.queue_order(Order::Move { player, ids: vec![r], x, y, attack_move: false });
    let st = &mut w.ai[player as usize].mcv;
    st.moving.retain(|m| m.0 != r);
    st.moving.push((r, yard));
}

fn cell_dist_sq(a: (i32, i32), b: (i32, i32)) -> i32 {
    (a.0 - b.0) * (a.0 - b.0) + (a.1 - b.1) * (a.1 - b.1)
}

/// Ground steps from `from` to every cell (8 directions, 1 per step), or -1.
fn steps_from(w: &World, from: (i32, i32)) -> Vec<i32> {
    let mut d = vec![-1; w.map.cells()];
    let start = w.map.idx(from.0, from.1);
    d[start] = 0;
    let mut queue = std::collections::VecDeque::from([start]);
    while let Some(ci) = queue.pop_front() {
        let (x, y) = (ci as i32 % w.map.width, ci as i32 / w.map.width);
        for dir in 0..8 {
            if let Some(j) = crate::flowfield::step(&w.map, &w.pass.blocked, x, y, dir) {
                if d[j] < 0 {
                    d[j] = d[ci] + 1;
                    queue.push_back(j);
                }
            }
        }
    }
    d
}

/// OpenRA CalculateThreats of a resource square.
fn threats(w: &World, player: u8, side2: i32, i: usize) -> i32 {
    let ix = &w.ai[player as usize].harvest.indices[i];
    let (count, units, bases) = crate::ai_harvest::nearby_threat(w, player, i);
    let own_bases = (ix.enemy_bases - ix.friendly_bases).max(0);
    let own_units = (ix.enemy_units - ix.friendly_units).max(0);
    if count == 0 {
        return ((own_units * side2) >> 6) + ((own_bases * side2) << 3);
    }
    ((own_units * side2 + units * side2 / count) >> 6) + ((own_bases * side2 + bases * side2 / count) << 3)
}

/// OpenRA GetExpansionCenter: the resource square that scores best for the
/// mode (spot, score, square centre).
fn expansion_center(w: &mut World, player: u8, cfg: &BotConfig, mcv: usize, fallback: bool) -> (Option<Cell>, i32, Option<Cell>) {
    let side = cfg.info.resource_map.as_ref().map_or(24, |r| r.resource_map_stride_radius * 2);
    let side2 = side * side;
    let st = &w.ai[player as usize].harvest;
    let n = st.indices.len();
    if n == 0 {
        return (None, i32::MIN, None);
    }
    let factor = (st.rows * st.rows + st.columns * st.columns).max(1);
    let here = w.cell_of(w.actors[mcv].x, w.actors[mcv].y);
    let mr = w.make_ref(mcv);
    let others: Vec<(u32, Option<(i32, i32)>)> = w.ai[player as usize].mcv.active.clone();
    let yards: Vec<((i32, i32), bool)> = (0..w.actors.len())
        .filter(|&i| w.actors[i].alive && cfg.yards.contains(&w.actors[i].ty) && w.are_allies(player, w.actors[i].owner))
        .map(|i| ((w.actors[i].cx, w.actors[i].cy), w.actors[i].owner != player))
        .collect();
    let mode = w.ai[player as usize].mcv.mode;
    let last_failed = w.ai[player as usize].mcv.last_failed_spot;
    match mode {
        Mode::CheckBase => {
            let mut best: Option<(i32, (i32, i32))> = None;
            for i in 0..n {
                let center = w.ai[player as usize].harvest.indices[i].center;
                if last_failed == Some(center) {
                    continue;
                }
                let mut a = side2 >> 1;
                a -= cell_dist_sq(center, here) / factor;
                a -= threats(w, player, side2, i);
                for &(loc, ally) in &yards {
                    if cell_dist_sq(center, loc) <= side2 {
                        a -= if ally { side2 } else { side2 << 1 };
                    }
                }
                for &(o, dest) in &others {
                    if dest == Some(center) && o != mr {
                        a -= side2 << 1;
                    }
                }
                if !fallback && cell_dist_sq(center, here) <= side2 {
                    a -= side2 << 1;
                }
                if best.is_none_or(|(b, _)| a > b) {
                    best = Some((a, center));
                }
            }
            match best {
                Some((a, c)) => (Some(c), a, Some(c)),
                None => (Some(here), i32::MIN, None),
            }
        }
        Mode::CheckResource => {
            let m = cfg.info.mcv_expansion.as_ref().unwrap();
            let refineries: Vec<(i32, i32)> =
                own_of(w, player, &cfg.refineries).into_iter().map(|b| (w.actors[b].cx, w.actors[b].cy)).collect();
            let steps = steps_from(w, here);
            let half = side2 >> 1;
            let threshold = {
                let sum: i32 = (0..n).map(|i| half - (w.ai[player as usize].harvest.indices[i].resource_cells - half).abs()).sum();
                (sum / n as i32) >> 1
            };
            let (max_failed, failed) = (w.ai[player as usize].mcv.max_failed, w.ai[player as usize].mcv.failed);
            let mut best: Option<(i32, Cell, Cell)> = None;
            for i in 0..n {
                let ix = w.ai[player as usize].harvest.indices[i].clone();
                if (failed > max_failed >> 1 && ix.resource_cells <= threshold) || last_failed == Some(ix.center) {
                    continue;
                }
                // A square without ore has no resource centre (OpenRA's is
                // CPos.Zero, outside every map's bounds, so no path leads
                // there); WebRA's maps have a corner cell (0, 0).
                if ix.resource_cells == 0 {
                    continue;
                }
                let rc = ix.resource_center;
                if !w.map.contains(rc.0, rc.1) {
                    continue;
                }
                let d = steps[w.map.idx(rc.0, rc.1)];
                if d < 0 {
                    continue;
                }
                let path = d + 1;
                let mut a = half - path * path / factor;
                a += (half - (ix.resource_cells - half).abs()) >> 2;
                // Ore mines draw an expansion: 8 per mine, and half the
                // time the spot is one of them rather than the ore's centre.
                a += 8 * ix.creators.len() as i32;
                let res_center = if ix.creators.is_empty() || rand(w, 0, 2) > 0 {
                    rc
                } else {
                    ix.creators[rand(w, 0, ix.creators.len() as i32) as usize]
                };
                a -= threats(w, player, side2, i);
                // Own refineries weigh as much as own yards (an ally's half).
                let refine_r2 = m.cr_mode_friendly_refinery_dislike_range * m.cr_mode_friendly_refinery_dislike_range;
                for &loc in &refineries {
                    if cell_dist_sq(res_center, loc) <= refine_r2 {
                        a -= side2 << 1;
                    }
                }
                let yard_r2 = m.cr_mode_friendly_conyard_dislike_range * m.cr_mode_friendly_conyard_dislike_range;
                for &(loc, ally) in &yards {
                    if cell_dist_sq(res_center, loc) <= yard_r2 {
                        a -= if ally { side2 } else { side2 << 1 };
                    }
                }
                for &(o, dest) in &others {
                    if dest == Some(ix.center) && o != mr {
                        a -= side2 << 1;
                    }
                }
                if !fallback && cell_dist_sq(res_center, here) <= yard_r2 {
                    a -= side2 << 1;
                }
                if best.is_none_or(|(b, _, _)| a > b) {
                    best = Some((a, ix.center, res_center));
                }
            }
            match best {
                Some((a, check, spot)) => (Some(spot), a, Some(check)),
                None => (None, i32::MIN, None),
            }
        }
    }
}

/// OpenRA ChooseMcvDeployLocation: (deploy cell, ore cell for a refinery,
/// resource square checked).
fn choose_deploy_location(
    w: &mut World,
    player: u8,
    cfg: &BotConfig,
    mcv: usize,
    fallback: bool,
) -> (Option<Cell>, Option<Cell>, Option<Cell>) {
    let (center, attraction, check) = expansion_center(w, player, cfg, mcv, fallback);
    let st = &w.ai[player as usize].mcv;
    let (min, max, keep) = (st.min_radius, st.max_radius, st.keep);
    let here = w.cell_of(w.actors[mcv].x, w.actors[mcv].y);
    let cell = center.and_then(|c| find_deploy_cell(w, mcv, here, c, min, max, keep));
    if cell.is_some() && attraction > 0 {
        good_spot(w, player, cfg);
    } else {
        bad_spot(w, player, cfg, if cell.is_some() { None } else { check });
    }
    let ore = (w.ai[player as usize].mcv.mode == Mode::CheckResource && center.is_some() && cell.is_some()).then(|| center.unwrap());
    (cell, ore, check)
}

/// OpenRA FindDeployCell around `target`, keeping `keep` cells toward `source`.
fn find_deploy_cell(
    w: &mut World,
    mcv: usize,
    source: (i32, i32),
    target: (i32, i32),
    min: i32,
    max: i32,
    keep: i32,
) -> Option<(i32, i32)> {
    let off = offset(w, mcv);
    let comp = w.pass.component[w.map.idx(source.0, source.1)];
    let reachable = |w: &World, c: (i32, i32)| w.map.contains(c.0, c.1) && w.pass.component[w.map.idx(c.0, c.1)] == comp;
    let fits = |w: &World, c: (i32, i32)| w.can_deploy_at(mcv, c.0 + off.0, c.1 + off.1);
    let mut cells: Vec<(i32, i32)> = Vec::new();
    for y in target.1 - max..=target.1 + max {
        for x in target.0 - max..=target.0 + max {
            let d = cell_dist_sq((x, y), target);
            if d >= min * min && d <= max * max && w.map.contains(x, y) {
                cells.push((x, y));
            }
        }
    }
    if source != target {
        let theta = keep as i64;
        let deta = crate::math::isqrt(cell_dist_sq(target, source) as i64) - theta;
        cells.sort_by_key(|&c| (deta * cell_dist_sq(c, target) as i64 + theta * cell_dist_sq(c, source) as i64, c.1, c.0));
    } else {
        crate::ai_base::shuffle(w, &mut cells);
    }
    let mut best = cells.iter().copied().find(|&c| fits(w, c));
    if source != target && best.is_some_and(|b| !reachable(w, b)) {
        best = None;
    }
    let far = best.is_some_and(|b| cell_dist_sq(b, target) >= (keep + 2) * (keep + 2));
    if best.is_none() || (source != target && far) {
        cells.sort_by_key(|&c| (cell_dist_sq(c, target), c.1, c.0));
        for c in cells {
            if fits(w, c) {
                if !reachable(w, c) {
                    return None;
                }
                return match best {
                    Some(b) if cell_dist_sq(c, target) >= cell_dist_sq(b, target) => Some(b),
                    _ => Some(c),
                };
            }
        }
    }
    best
}

fn good_spot(w: &mut World, player: u8, cfg: &BotConfig) {
    let st = &mut w.ai[player as usize].mcv;
    st.last_failed_spot = None;
    st.failed -= 1;
    if st.failed <= -st.max_failed {
        match st.mode {
            Mode::CheckResource => {
                st.max_failed = CR_POSITIVE_MAX_FAILED;
                st.failed = -st.max_failed;
            }
            Mode::CheckBase => {
                st.max_failed = CR_POSITIVE_MAX_FAILED;
                st.failed = st.max_failed - 1;
                switch_mode(st, cfg, Mode::CheckResource);
            }
        }
    }
}

fn bad_spot(w: &mut World, player: u8, cfg: &BotConfig, spot: Option<(i32, i32)>) {
    let st = &mut w.ai[player as usize].mcv;
    st.last_failed_spot = spot;
    st.failed += 1;
    if st.failed >= st.max_failed {
        st.failed = 0;
        match st.mode {
            Mode::CheckResource => switch_mode(st, cfg, Mode::CheckBase),
            Mode::CheckBase => {
                switch_mode(st, cfg, Mode::CheckResource);
                st.max_failed = NEGATIVE_MAX_FAILED;
            }
        }
    }
}

/// IBotRespondToAttack: an MCV under fire deploys where it stands.
pub(crate) fn respond_to_attack(w: &mut World, player: u8, victim: usize) {
    let cfg = w.ai[player as usize].cfg.clone();
    if cfg.info.mcv_expansion.is_none() || w.ai[player as usize].mcv.respond_cooldown > 0 || !cfg.mcvs.contains(&w.actors[victim].ty) {
        return;
    }
    w.ai[player as usize].mcv.respond_cooldown = 20;
    let r = w.make_ref(victim);
    w.ai[player as usize].mcv.moving.retain(|m| m.0 != r);
    deploy_mcv(w, player, &cfg, victim, false);
    if count_own(w, player, &cfg.yards) == 0 {
        let cell = w.cell_of(w.actors[victim].x, w.actors[victim].y);
        w.ai[player as usize].base.base_center = Some(cell);
    }
}

// ---- McvManagerBotModule (Naval AI) ---------------------------------------------------

fn tick_manager(w: &mut World, player: u8, cfg: &BotConfig) {
    let m = cfg.info.mcv_manager.as_ref().unwrap();
    if !w.ai[player as usize].mcv.started {
        w.ai[player as usize].mcv.started = true;
        manager_deploy_all(w, player, cfg, false);
    }
    let st = &mut w.ai[player as usize].mcv;
    st.scan_ticks -= 1;
    if st.scan_ticks > 0 {
        return;
    }
    st.scan_ticks = m.scan_for_new_mcv_interval;
    manager_deploy_all(w, player, cfg, true);
    // ShouldBuildMCV: no MCV, too few yards, and a factory that makes MCVs.
    if !cfg.mcvs.is_empty()
        && count_own(w, player, &cfg.mcvs) == 0
        && (count_own(w, player, &cfg.yards) as i32) < m.minimum_construction_yard_count
        && count_own(w, player, &cfg.mcv_factories) > 0
    {
        let ty = crate::ai_units::pick(w, &cfg.mcvs).unwrap();
        if crate::ai_units::requested(w, player, ty) == 0 {
            crate::ai_units::request(w, player, ty);
        }
    }
}

fn manager_deploy_all(w: &mut World, player: u8, cfg: &BotConfig, choose: bool) {
    let m = cfg.info.mcv_manager.as_ref().unwrap();
    let mcvs: Vec<usize> =
        own_of(w, player, &cfg.mcvs).into_iter().filter(|&i| w.actors[i].in_world() && idle(w, i) && !is_moving(w, player, i)).collect();
    for i in mcvs {
        let r = w.make_ref(i);
        let here = w.cell_of(w.actors[i].x, w.actors[i].y);
        if choose {
            let restrict = m.restrict_mcv_deployment_fallback_to_base && count_own(w, player, &cfg.yards) > 0;
            let center = crate::ai_base::random_base_center(w, player);
            let max = if restrict { m.max_base_radius } else { w.map.width.max(w.map.height) };
            let off = offset(w, i);
            let mut cells: Vec<(i32, i32)> = Vec::new();
            for y in center.1 - max..=center.1 + max {
                for x in center.0 - max..=center.0 + max {
                    let d = cell_dist_sq((x, y), center);
                    if d >= m.min_base_radius * m.min_base_radius && d <= max * max && w.map.contains(x, y) {
                        cells.push((x, y));
                    }
                }
            }
            crate::ai_base::shuffle(w, &mut cells);
            let Some(c) = cells.into_iter().find(|&c| w.can_deploy_at(i, c.0 + off.0, c.1 + off.1)) else { continue };
            let st = &mut w.ai[player as usize].base;
            st.base_center = Some(here);
            st.defense_center = Some(here);
            drive_and_deploy(w, player, i, c, (c.0 + off.0, c.1 + off.1));
        } else {
            let st = &mut w.ai[player as usize].base;
            st.base_center = Some(here);
            st.defense_center = Some(here);
            if w.can_deploy(i) {
                w.queue_order(Order::Deploy { player, ids: vec![r] });
            }
        }
    }
}

/// Construction Yards and MCVs of `player` (tests).
#[cfg(test)]
pub(crate) fn yards_and_mcvs(w: &World, player: u8) -> (usize, usize) {
    let cfg = w.ai[player as usize].cfg.clone();
    (count_own(w, player, &cfg.yards), count_own(w, player, &cfg.mcvs))
}

/// The resource square (its centre) MCV `mcv` would expand to now (tests).
#[cfg(test)]
pub(crate) fn expansion_square(w: &mut World, player: u8, mcv: usize) -> Option<Cell> {
    let cfg = w.ai[player as usize].cfg.clone();
    expansion_center(w, player, &cfg, mcv, true).2
}

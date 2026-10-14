//! OpenRA BaseBuilderBotModule and BaseBuilderQueueManager: what the bot
//! builds in its Building and Defense queues (power first when low, then
//! refineries, extra production when rich, a naval yard by water, silos when
//! full, then BuildingFractions within BuildingLimits and after
//! BuildingDelays), where it places it, factory rally points, and selling
//! refineries that stand too close together or without ore.
//!
//! WebRA does not build refineries while no ore is in reach of its ground
//! units (OpenRA would), and while it has no income and little money left
//! (ai_economy.rs) it only builds the power its factories need, or a
//! factory when it has none left. It builds naval yards only on water from
//! which its warships can hit an enemy (ai_naval.rs). Placement differs from OpenRA's random cell order: structures spiral out
//! from the base centre (mirrored for bases in the right half, so mirrored
//! spawns lay out mirrored bases), refineries go where their dock is closest
//! to ore, and defences use OpenRA's ordering toward the nearest enemy with
//! ties broken the same mirrored way.

use crate::ai::{count_own, own_of, owned_buildings, rand};
use crate::ai_bots::BotConfig;
use crate::math::{dist_sq, CELL};
use crate::rules::{FootCell, Kind, QueueType};
use crate::world::{cell_center, World, NONE};

/// Water near the base for a naval yard (BaseBuilderQueueManager.WaterCheck).
#[derive(Clone, Copy, PartialEq, Eq, Default, Debug)]
enum Water {
    #[default]
    NotChecked,
    Enough,
    NotEnough,
    DontCheck,
}

/// One BaseBuilderQueueManager (the Building or the Defense queue).
#[derive(Clone, Default, Debug)]
struct QueueManager {
    wait_ticks: i32,
    fail_count: i32,
    last_failed: Option<u16>,
    cached_bases: usize,
    check_for_bases_ticks: i32,
    min_excess_power: i32,
    water: Water,
    base_center_failing: Option<(i32, i32)>,
    queued_this_tick: bool,
}

#[derive(Clone, Default, Debug)]
pub(crate) struct BaseState {
    builders: [QueueManager; 2],
    current: usize,
    /// OpenRA initialBaseCenter (cell): where the base is while no yard stands.
    pub(crate) base_center: Option<(i32, i32)>,
    /// OpenRA DefenseCenter: where the base was last attacked (cell).
    pub(crate) defense_center: Option<(i32, i32)>,
    /// Refineries an expanding MCV asked for: (MCV reference, yard cell, ore cell).
    pub(crate) requested_refineries: Vec<RefineryRequest>,
    resource_conyard_center: Option<(i32, i32)>,
    rally_ticks: i32,
    rally_stack: Vec<u32>,
    best_resource_ticks: i32,
    sell_refinery_ticks: i32,
    being_produced: Vec<(u16, i32)>,
}

/// A map cell (x, y).
pub(crate) type Cell = (i32, i32);
/// A refinery an expanding MCV asked for: (MCV reference, yard cell, ore cell).
pub(crate) type RefineryRequest = (u32, Cell, Cell);

const QUEUES: [QueueType; 2] = [QueueType::Building, QueueType::Defense];

pub(crate) fn start(w: &mut World, player: u8) {
    let cfg = w.ai[player as usize].cfg.clone();
    let bb = &cfg.info.base_builder;
    let rally = rand(w, 0, bb.assign_rally_points_interval);
    let best = rand(w, 0, bb.check_best_resource_location_interval);
    let sell = if bb.sell_refinery_interval < 0 { 0 } else { rand(w, 0, bb.sell_refinery_interval) };
    let st = &mut w.ai[player as usize].base;
    st.rally_ticks = rally;
    st.best_resource_ticks = best;
    st.sell_refinery_ticks = sell;
    for b in st.builders.iter_mut() {
        b.min_excess_power = bb.minimum_excess_power;
        if cfg.naval_production.is_empty() {
            b.water = Water::DontCheck;
        }
    }
}

/// The base centre: a random own Construction Yard, else the initial base
/// centre (OpenRA GetRandomBaseCenter), as a cell.
pub(crate) fn random_base_center(w: &mut World, player: u8) -> (i32, i32) {
    let yards = own_of(w, player, &w.ai[player as usize].cfg.yards.clone());
    if yards.is_empty() {
        return initial_center(w, player);
    }
    let k = rand(w, 0, yards.len() as i32) as usize;
    let a = &w.actors[yards[k]];
    (a.cx, a.cy)
}

pub(crate) fn initial_center(w: &World, player: u8) -> (i32, i32) {
    w.ai[player as usize].base.base_center.unwrap_or(w.players[player as usize].start)
}

/// OpenRA GetDefenseBaseCenter: the yard nearest to where the base was attacked.
fn defense_base_center(w: &mut World, player: u8) -> (i32, i32) {
    if let Some(dc) = w.ai[player as usize].base.defense_center {
        let yards = own_of(w, player, &w.ai[player as usize].cfg.yards);
        if let Some(&y) = yards.iter().min_by_key(|&&y| (cell_dist_sq((w.actors[y].cx, w.actors[y].cy), dc), y)) {
            return (w.actors[y].cx, w.actors[y].cy);
        }
    }
    random_base_center(w, player)
}

fn cell_dist_sq(a: (i32, i32), b: (i32, i32)) -> i64 {
    let (dx, dy) = ((a.0 - b.0) as i64, (a.1 - b.1) as i64);
    dx * dx + dy * dy
}

/// IBotRespondToAttack: an attacked structure moves the defence centre to the attacker.
pub(crate) fn respond_to_attack(w: &mut World, player: u8, victim: usize, attacker: usize) {
    if w.actors[victim].kind != Kind::Building || !w.are_enemies(player, w.actors[attacker].owner) {
        return;
    }
    let cell = w.cell_of(w.actors[attacker].x, w.actors[attacker].y);
    w.ai[player as usize].base.defense_center = Some(cell);
}

/// Whether unit production waits for the first refineries (OpenRA
/// IBotRequestPauseUnitProduction: fewer than InititalMinimumRefineryCount).
pub(crate) fn pause_unit_production(w: &World, player: u8) -> bool {
    let cfg = &w.ai[player as usize].cfg;
    (count_own(w, player, &cfg.refineries) as i32) < cfg.info.base_builder.initital_minimum_refinery_count
}

pub(crate) fn tick(w: &mut World, player: u8) {
    let cfg = w.ai[player as usize].cfg.clone();
    let bb = &cfg.info.base_builder;
    tick_rally_points(w, player, &cfg);
    let st = &mut w.ai[player as usize].base;
    st.best_resource_ticks -= 1;
    if st.best_resource_ticks <= 0 {
        st.best_resource_ticks = bb.check_best_resource_location_interval;
        update_resource_conyard(w, player, &cfg);
    }
    // One queue manager per tick, round robin among the queues the player
    // can use; "being produced" counts the first item of every such queue.
    let funds = w.players[player as usize].funds();
    let mut being: Vec<(u16, i32)> = Vec::new();
    let mut found: Option<usize> = None;
    let current = w.ai[player as usize].base.current;
    for k in 0..QUEUES.len() {
        let idx = (current + 1 + k) % QUEUES.len();
        w.ai[player as usize].base.builders[idx].wait_ticks -= 1;
        if !w.has_producer(player, QUEUES[idx]) {
            continue;
        }
        found.get_or_insert(idx);
        if funds >= bb.production_min_cash_requirement {
            if let Some(item) = w.players[player as usize].queues[QUEUES[idx] as usize].items.first() {
                match being.iter_mut().find(|b| b.0 == item.ty) {
                    Some(b) => b.1 += 1,
                    None => being.push((item.ty, 1)),
                }
            }
        }
    }
    let st = &mut w.ai[player as usize].base;
    st.being_produced = being;
    if let Some(idx) = found {
        st.current = idx;
    }
    let idx = st.current;
    tick_queue_manager(w, player, &cfg, idx);
    if bb.sell_refinery_interval >= 0 {
        let st = &mut w.ai[player as usize].base;
        st.sell_refinery_ticks -= 1;
        if st.sell_refinery_ticks <= 0 {
            st.sell_refinery_ticks = bb.sell_refinery_interval;
            sell_useless_refinery(w, player, &cfg);
        }
    }
}

fn qm(w: &mut World, player: u8, idx: usize) -> &mut QueueManager {
    &mut w.ai[player as usize].base.builders[idx]
}

/// BaseBuilderQueueManager.Tick.
fn tick_queue_manager(w: &mut World, player: u8, cfg: &BotConfig, idx: usize) {
    let bb = &cfg.info.base_builder;
    if qm(w, player, idx).fail_count >= bb.maximum_failed_placement_attempts {
        // Nowhere to place: nudge the MCV expansion module to move the
        // stuck yard (not for defences) and try again.
        if let Some(center) = qm(w, player, idx).base_center_failing {
            let defense = qm(w, player, idx).last_failed.is_some_and(|t| cfg.defenses.contains(&t));
            if !defense {
                let r2 = (bb.max_base_radius * bb.max_base_radius) as i64;
                let stuck = own_of(w, player, &cfg.yards)
                    .into_iter()
                    .map(|y| (cell_dist_sq((w.actors[y].cx, w.actors[y].cy), center), y))
                    .filter(|&(d, _)| d <= r2)
                    .min();
                if let Some((_, y)) = stuck {
                    let r = w.make_ref(y);
                    crate::ai_mcv::update_expansion_params(w, player, false, true, Some(r));
                }
            }
            qm(w, player, idx).fail_count = 0;
        }
        if qm(w, player, idx).fail_count >= bb.maximum_failed_placement_attempts {
            return;
        }
    }
    if qm(w, player, idx).water == Water::NotChecked {
        let yards = own_of(w, player, &cfg.yards);
        if water_area_near(w, &yards, bb.max_base_radius) {
            qm(w, player, idx).water = Water::Enough;
        } else {
            let q = qm(w, player, idx);
            q.water = Water::NotEnough;
            q.check_for_bases_ticks = bb.check_for_new_bases_delay;
        }
    }
    if qm(w, player, idx).water == Water::NotEnough {
        qm(w, player, idx).check_for_bases_ticks -= 1;
        if qm(w, player, idx).check_for_bases_ticks <= 0 {
            let bases = count_own(w, player, &cfg.yards);
            let q = qm(w, player, idx);
            if bases > q.cached_bases {
                q.cached_bases = bases;
                q.water = Water::NotChecked;
            }
        }
    }
    if qm(w, player, idx).wait_ticks > 0 {
        return;
    }
    let buildings = owned_buildings(w, player).len() as i32;
    let bonus = bb.excess_power_increment * (buildings / bb.excess_power_increase_threshold.max(1));
    let q = qm(w, player, idx);
    q.min_excess_power =
        (bb.minimum_excess_power + bonus).clamp(bb.minimum_excess_power, bb.maximum_excess_power.max(bb.minimum_excess_power));
    q.queued_this_tick = false;
    let active = w.has_producer(player, QUEUES[idx]) && tick_queue(w, player, cfg, idx);
    let level = w.ai[player as usize].level();
    let delay = if active { bb.structure_production_active_delay } else { bb.structure_production_inactive_delay };
    let wait = level.interval(delay) + rand(w, 0, bb.structure_production_random_bonus_delay);
    qm(w, player, idx).wait_ticks = wait;
}

/// BaseBuilderQueueManager.TickQueue: start the next structure, or place a
/// finished one. Returns whether the queue is active.
fn tick_queue(w: &mut World, player: u8, cfg: &BotConfig, idx: usize) -> bool {
    let bb = &cfg.info.base_builder;
    let q = QUEUES[idx];
    let current = w.players[player as usize].queues[q as usize].items.first().cloned();
    match current {
        None => {
            if qm(w, player, idx).fail_count >= bb.maximum_failed_placement_attempts {
                return true;
            }
            if w.players[player as usize].funds() < bb.production_min_cash_requirement || qm(w, player, idx).queued_this_tick {
                return false;
            }
            let Some(ty) = choose_building(w, player, cfg, idx) else { return false };
            w.start_production(player, ty, 1);
            qm(w, player, idx).queued_this_tick = true;
            true
        }
        Some(item) if item.done => {
            let kind = if cfg.defenses.contains(&item.ty) && rand(w, 0, 100) < bb.place_defense_towards_enemy_chance {
                Placement::Defense
            } else if cfg.refineries.contains(&item.ty) {
                Placement::Refinery
            } else {
                Placement::Building
            };
            let (mut location, center) = choose_build_location(w, player, cfg, item.ty, kind, idx);
            // WebRA: a Lightning Rod goes where it covers the most power plants (ai_lightning.rs).
            if crate::ai_lightning::is_rod(w, item.ty) {
                location = crate::ai_lightning::rod_location(w, player, item.ty).or(location);
            }
            qm(w, player, idx).base_center_failing = center;
            let Some((cx, cy)) = location else {
                let q = qm(w, player, idx);
                q.fail_count += 1;
                if q.fail_count >= bb.maximum_failed_placement_attempts {
                    q.last_failed = Some(item.ty);
                    w.cancel_production(player, item.ty);
                }
                return true;
            };
            qm(w, player, idx).fail_count = 0;
            w.place_building(player, item.ty, cx, cy);
            // A new factory, tech structure or refinery may call for an
            // expansion (BaseBuilderQueueManager after PlaceBuilding).
            let ty = item.ty;
            if cfg.production.contains(&ty) || cfg.tech.contains(&ty) || cfg.refineries.contains(&ty) {
                nudge_expansion(w, player, cfg);
            }
            true
        }
        Some(_) => true,
    }
}

fn nudge_expansion(w: &mut World, player: u8, cfg: &BotConfig) {
    let bb = &cfg.info.base_builder;
    let refineries = count_own(w, player, &cfg.refineries) as i32;
    let production = count_own(w, player, &cfg.production) as i32;
    let tech = count_own(w, player, &cfg.tech) as i32;
    let on_cash = w.players[player as usize].funds() / bb.per_expansion_tolerate_on_cash.max(1);
    let pick = |w: &mut World, list: &[i32]| if list.is_empty() { 0 } else { list[rand(w, 0, list.len() as i32) as usize] };
    let tolerate = pick(w, &bb.expansion_tolerate);
    if refineries >= bb.initital_minimum_refinery_count + bb.additional_minimum_refinery_count
        && production > 0
        && production + tech - tolerate - on_cash >= refineries
    {
        let force = pick(w, &bb.force_expansion_tolerate);
        let undeploy_even_no_base = production + tech - force - on_cash >= refineries;
        crate::ai_mcv::update_expansion_params(w, player, true, undeploy_even_no_base, None);
    }
}

// ---- What to build -----------------------------------------------------------------

fn power_amount(w: &World, ty: u16) -> i32 {
    w.rules.actors[ty as usize].building.as_ref().map_or(0, |b| b.power)
}

fn limit_ok(w: &World, player: u8, cfg: &BotConfig, ty: u16) -> bool {
    BotConfig::lookup(&cfg.limits, ty).is_none_or(|limit| (count_own_buildings(w, player, ty) as i32) < limit)
}

fn count_own_buildings(w: &World, player: u8, ty: u16) -> usize {
    w.actors.iter().filter(|a| a.alive && a.owner == player && a.kind == Kind::Building && a.ty == ty).count()
}

/// OpenRA GetProducibleBuilding: a buildable type of `types` under its
/// BuildingLimits, at random.
fn producible(w: &mut World, player: u8, cfg: &BotConfig, types: &[u16], buildable: &[u16]) -> Option<u16> {
    let options: Vec<u16> = buildable.iter().copied().filter(|t| types.contains(t) && limit_ok(w, player, cfg, *t)).collect();
    if options.is_empty() {
        return None;
    }
    let k = rand(w, 0, options.len() as i32) as usize;
    Some(options[k])
}

/// OpenRA HasSufficientPowerForActor.
fn sufficient_power(w: &World, player: u8, cfg: &BotConfig, ty: u16) -> bool {
    let p = &w.players[player as usize];
    power_amount(w, ty) + crate::ai_lightning::power_gen(w, player) - p.power_use >= cfg.info.base_builder.minimum_excess_power
}

/// OpenRA HasAdequateRefineryCount.
fn adequate_refineries(w: &World, player: u8, cfg: &BotConfig) -> bool {
    let bb = &cfg.info.base_builder;
    let optimal = if count_own(w, player, &cfg.production) > 0 {
        bb.initital_minimum_refinery_count + bb.additional_minimum_refinery_count
    } else {
        bb.initital_minimum_refinery_count
    };
    cfg.refineries.is_empty()
        || count_own(w, player, &cfg.refineries) as i32 >= optimal
        || count_own(w, player, &cfg.power) == 0
        || count_own(w, player, &cfg.yards) == 0
}

/// BaseBuilderQueueManager.ChooseBuildingToBuild.
fn choose_building(w: &mut World, player: u8, cfg: &BotConfig, idx: usize) -> Option<u16> {
    let bb = &cfg.info.base_builder;
    let q = QUEUES[idx];
    let buildable: Vec<u16> =
        (0..w.rules.actors.len() as u16).filter(|&t| w.rules.actors[t as usize].queue == q && w.can_start(player, t)).collect();
    if buildable.is_empty() {
        return None;
    }
    // Whether water near the base reaches an enemy (`reaching_water_near`),
    // asked once.
    let mut naval_water: Option<bool> = None;
    // The power plant of the most power (OpenRA orders by Power.Amount).
    let power = buildable
        .iter()
        .copied()
        .filter(|&t| cfg.power.contains(&t) && limit_ok(w, player, cfg, t))
        .max_by_key(|&t| (power_amount(w, t), std::cmp::Reverse(t)));
    let power_ok = power.is_some_and(|p| power_amount(w, p) > 0);
    // WebRA: through a lightning blackout the plants count as working (ai_lightning.rs).
    let excess = crate::ai_lightning::power_gen(w, player) - w.players[player as usize].power_use;
    let min_excess = qm(w, player, idx).min_excess_power;
    let ore = crate::ai_economy::reachable_resources(w, player) > 0;
    // Starving (ai_economy.rs): only the power the factories need, a first
    // refinery, and a factory when none is left to spend the money on an army.
    if crate::ai_economy::starving(w, player) {
        if excess < 0 && power_ok {
            return power;
        }
        // The first refinery by reachable ore is the way out.
        let has_refinery = owned_buildings(w, player)
            .iter()
            .any(|&b| w.rules.actors[w.actors[b].ty as usize].building.as_ref().is_some_and(|x| x.refinery.is_some()));
        if ore && !has_refinery {
            if let Some(r) =
                buildable.iter().copied().filter(|t| cfg.refineries.contains(t)).min_by_key(|&t| (w.rules.actors[t as usize].cost, t))
            {
                return Some(r);
            }
        }
        if !w.has_producer(player, QueueType::Infantry) && !w.has_producer(player, QueueType::Vehicle) {
            return buildable
                .iter()
                .copied()
                .filter(|t| cfg.production.contains(t) && limit_ok(w, player, cfg, *t))
                .min_by_key(|&t| (w.rules.actors[t as usize].cost, t));
        }
        return None;
    }
    // Out of low power first.
    if excess < min_excess && power_ok {
        return power;
    }
    // Then the economy: refineries (WebRA: only while ore is in reach;
    // a refinery without ore is money thrown away).
    if ore && (!w.ai[player as usize].base.requested_refineries.is_empty() || !adequate_refineries(w, player, cfg)) {
        if let Some(r) = producible(w, player, cfg, &cfg.refineries, &buildable) {
            if sufficient_power(w, player, cfg, r) {
                return Some(r);
            }
            if power.is_some() {
                return power;
            }
        }
    }
    let funds = w.players[player as usize].funds();
    // Spend as fast as we earn: another factory.
    if bb.new_production_cash_threshold > 0 && funds > bb.new_production_cash_threshold && rand(w, 0, 100) < bb.new_production_chance {
        if let Some(p) = producible(w, player, cfg, &cfg.production, &buildable) {
            if sufficient_power(w, player, cfg, p) {
                return Some(p);
            }
            if power.is_some() {
                return power;
            }
        }
    }
    // A naval yard where the base has water.
    if qm(w, player, idx).water == Water::Enough
        && bb.new_production_cash_threshold > 0
        && funds > bb.new_production_cash_threshold
        && water_area_near(w, &area_givers(w, player), bb.check_for_water_radius)
        && *naval_water.get_or_insert_with(|| !reaching_water_near(w, player, cfg, bb.check_for_water_radius).is_empty())
    {
        if let Some(n) = producible(w, player, cfg, &cfg.naval_production, &buildable) {
            if sufficient_power(w, player, cfg, n) {
                return Some(n);
            }
            if power.is_some() {
                return power;
            }
        }
    }
    // Storage when the silos are nearly full.
    let p = &w.players[player as usize];
    if p.resources as i64 * 10 > p.storage as i64 * 8 {
        if let Some(s) = producible(w, player, cfg, &cfg.silos, &buildable) {
            if sufficient_power(w, player, cfg, s) {
                return Some(s);
            }
            if power.is_some() {
                return power;
            }
        }
    }
    // WebRA: a Lightning Rod over power plants while thunderstorms can strike (ai_lightning.rs).
    if let Some(r) = crate::ai_lightning::wanted_rod(w, player, &buildable) {
        return Some(r);
    }
    // Everything else, by BuildingFractions in random order.
    let mut fractions = cfg.fractions.clone();
    shuffle(w, &mut fractions);
    let total = owned_buildings(w, player).len() as i64;
    let tick = w.tick as i64;
    for (ty, frac) in fractions {
        if BotConfig::lookup(&cfg.delays, ty).is_some_and(|d| d as i64 > tick)
            || !buildable.contains(&ty)
            || (!ore && cfg.refineries.contains(&ty))
        {
            continue;
        }
        let producing = w.ai[player as usize].base.being_produced.iter().find(|b| b.0 == ty).map_or(0, |b| b.1);
        let count = count_own_buildings(w, player, ty) as i64 + producing as i64;
        if count * 100 > frac as i64 * total {
            continue;
        }
        if BotConfig::lookup(&cfg.limits, ty).is_some_and(|limit| limit as i64 <= count) {
            continue;
        }
        if cfg.naval_production.contains(&ty)
            && (qm(w, player, idx).water == Water::NotEnough
                || !water_area_near(w, &area_givers(w, player), bb.check_for_water_radius)
                || !*naval_water.get_or_insert_with(|| !reaching_water_near(w, player, cfg, bb.check_for_water_radius).is_empty()))
        {
            continue;
        }
        if (excess < min_excess || !sufficient_power(w, player, cfg, ty)) && power_ok {
            return power;
        }
        return Some(ty);
    }
    None
}

/// Fisher-Yates with the world RNG (OpenRA Shuffle).
pub(crate) fn shuffle<T>(w: &mut World, v: &mut [T]) {
    for i in (1..v.len()).rev() {
        let j = rand(w, 0, i as i32 + 1) as usize;
        v.swap(i, j);
    }
}

/// Own structures that give buildable area (OpenRA GivesBuildableArea).
fn area_givers(w: &World, player: u8) -> Vec<usize> {
    owned_buildings(w, player)
        .into_iter()
        .filter(|&b| w.rules.actors[w.actors[b].ty as usize].building.as_ref().is_some_and(|x| x.gives_area != 0))
        .collect()
}

/// OpenRA AIUtils.IsAreaAvailable: a water cell whose eight neighbours are
/// water too, within `radius` cells of one of `actors`.
fn water_area_near(w: &World, actors: &[usize], radius: i32) -> bool {
    !water_spots_near(w, actors, radius, true).is_empty()
}

/// Cells of the water spots of `water_area_near` (all of them, or with
/// `first` only the first found).
fn water_spots_near(w: &World, actors: &[usize], radius: i32, first: bool) -> Vec<usize> {
    let water = |x: i32, y: i32| w.map.contains(x, y) && w.map.terrain[w.map.idx(x, y)] == crate::map::Terrain::Water;
    let mut out = Vec::new();
    for &a in actors {
        let (ax, ay) = (w.actors[a].cx, w.actors[a].cy);
        for y in ay - radius..=ay + radius {
            for x in ax - radius..=ax + radius {
                if (x - ax) * (x - ax) + (y - ay) * (y - ay) <= radius * radius
                    && water(x, y)
                    && (-1..=1).all(|dy| (-1..=1).all(|dx| water(x + dx, y + dy)))
                {
                    out.push(w.map.idx(x, y));
                    if first {
                        return out;
                    }
                }
            }
        }
    }
    out
}

/// WebRA (ai_naval.rs): the water labels near the base (as `water_area_near`
/// finds it) from which the bot's warships could attack an enemy. A naval
/// yard is only built on such water.
fn reaching_water_near(w: &mut World, player: u8, cfg: &BotConfig, radius: i32) -> Vec<u32> {
    let mut comps: Vec<u32> = water_spots_near(w, &area_givers(w, player), radius, false)
        .into_iter()
        .filter(|&c| !w.pass_water.blocked[c])
        .map(|c| w.pass_water.component[c])
        .collect();
    comps.sort_unstable();
    comps.dedup();
    let types = crate::ai_naval::warship_types(w, cfg);
    crate::ai_naval::reaching(w, player, cfg, &types, &comps)
}

// ---- Where to build ------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
enum Placement {
    Building,
    Defense,
    Refinery,
}

/// BaseBuilderQueueManager.ChooseBuildLocation: the top-left cell, and the
/// base centre it was looked for around.
fn choose_build_location(w: &mut World, player: u8, cfg: &BotConfig, ty: u16, kind: Placement, idx: usize) -> (Option<Cell>, Option<Cell>) {
    let bb = &cfg.info.base_builder;
    let center = if kind == Placement::Defense { defense_base_center(w, player) } else { random_base_center(w, player) };
    match kind {
        Placement::Defense => {
            // Toward the nearest enemy actor (OpenRA ignores the fog here).
            let cc = (cell_center(center.0), cell_center(center.1));
            let target = (0..w.actors.len())
                .filter(|&i| {
                    let a = &w.actors[i];
                    a.alive && a.in_world() && !matches!(a.kind, Kind::Husk | Kind::Crate | Kind::Proxy) && w.are_enemies(player, a.owner)
                })
                .min_by_key(|&i| (dist_sq(w.actors[i].x, w.actors[i].y, cc.0, cc.1), i))
                .map_or(center, |i| w.cell_of(w.actors[i].x, w.actors[i].y));
            (
                find_pos(w, player, ty, center, target, bb.min_base_radius, bb.max_base_radius, Some(bb.try_maintain_defense_range)),
                Some(center),
            )
        }
        Placement::Refinery => {
            let requested = w.ai[player as usize].base.requested_refineries.first().copied();
            let failing = qm(w, player, idx).fail_count > 0;
            let anchor = if failing {
                center
            } else {
                requested.map(|r| r.1).or(w.ai[player as usize].base.resource_conyard_center).unwrap_or(center)
            };
            let ore_at = requested.filter(|_| !failing).map(|r| r.2);
            let found = place_refinery(w, player, ty, anchor, ore_at, bb.max_base_radius);
            if let Some(r) = requested {
                w.ai[player as usize].base.requested_refineries.retain(|x| x.0 != r.0);
            }
            match found {
                Some(c) => (Some(c), Some(anchor)),
                None => (spiral(w, player, ty, center, bb.max_base_radius), Some(center)),
            }
        }
        // WebRA: a naval yard launches its ships onto water that reaches an enemy (ai_naval.rs).
        Placement::Building if cfg.naval_production.contains(&ty) => {
            let reach = reaching_water_near(w, player, cfg, bb.check_for_water_radius);
            let b = w.rules.actors[ty as usize].building.as_ref().map_or((1, 1), |b| (b.width, b.height));
            let ok = |w: &World, x: i32, y: i32| crate::ai_naval::water_around(w, x, y, b.0, b.1).iter().any(|c| reach.contains(c));
            (spiral_where(w, player, ty, center, bb.max_base_radius, ok), Some(center))
        }
        Placement::Building => (spiral(w, player, ty, center, bb.max_base_radius), Some(center)),
    }
}

/// Mirror-symmetric tie break for a cell: distance from the map's middle
/// column, then the row (never the scan order).
fn mirror_key(w: &World, x: i32, y: i32) -> (i32, i32) {
    ((2 * x - (w.map.width - 1)).abs(), y)
}

/// OpenRA FindPos toward `target` keeping `keep` cells from it: candidate
/// top-left cells within min..=max of `center`, ordered by
/// deta * |c - target|^2 + theta * |c - center|^2.
#[allow(clippy::too_many_arguments)]
fn find_pos(
    w: &mut World,
    player: u8,
    ty: u16,
    center: (i32, i32),
    target: (i32, i32),
    min: i32,
    max: i32,
    keep: Option<i32>,
) -> Option<(i32, i32)> {
    if center == target {
        return spiral(w, player, ty, center, max);
    }
    let theta = keep.unwrap_or(0) as i64;
    let len = crate::math::isqrt(cell_dist_sq(target, center));
    let deta = len - theta;
    let mut cells: Vec<((i64, Cell), Cell)> = Vec::new();
    for y in center.1 - max..=center.1 + max {
        for x in center.0 - max..=center.0 + max {
            let d = cell_dist_sq((x, y), center);
            if d < (min * min) as i64 || d > (max * max) as i64 || !w.map.contains(x, y) {
                continue;
            }
            let score = if keep.is_some() { deta * cell_dist_sq((x, y), target) + theta * d } else { cell_dist_sq((x, y), target) };
            cells.push(((score, mirror_key(w, x, y)), (x, y)));
        }
    }
    cells.sort_unstable();
    cells.into_iter().map(|(_, c)| c).find(|&(x, y)| w.can_place(player, ty, x, y))
}

/// Spiral out from `center`, preferring spots that leave a one cell gap so
/// units can still pass, mirrored for bases in the right half of the map.
fn spiral(w: &World, player: u8, ty: u16, center: (i32, i32), max: i32) -> Option<(i32, i32)> {
    spiral_where(w, player, ty, center, max, |_, _, _| true)
}

/// `spiral` over the spots `accept` takes.
fn spiral_where(
    w: &World,
    player: u8,
    ty: u16,
    center: (i32, i32),
    max: i32,
    accept: impl Fn(&World, i32, i32) -> bool,
) -> Option<(i32, i32)> {
    let b = w.rules.actors[ty as usize].building.as_ref()?;
    let (bw, bh) = (b.width, b.height);
    // Never flip vertically: structures face south, so a base laid out upside
    // down is not equivalent (generated maps repeat their top half below).
    let flip_x = center.0 * 2 > w.map.width;
    for strict in [true, false] {
        for r in 0..max {
            for dy in -r..=r {
                for dx in -r..=r {
                    if dx.abs() != r && dy.abs() != r {
                        continue;
                    }
                    // Mirror around the footprint centre, not the top-left corner.
                    let cx = if flip_x { center.0 - dx - (bw - 3) } else { center.0 + dx };
                    let cy = center.1 + dy;
                    if w.can_place(player, ty, cx, cy) && (!strict || has_clearance(w, cx, cy, bw, bh)) && accept(w, cx, cy) {
                        return Some((cx, cy));
                    }
                }
            }
        }
    }
    None
}

/// A refinery spot near `anchor` whose dock is closest to ore (nearest to
/// `ore_at` when an expansion asked for it).
fn place_refinery(w: &World, player: u8, ty: u16, anchor: (i32, i32), ore_at: Option<(i32, i32)>, max: i32) -> Option<(i32, i32)> {
    let ore = ore_distance_field(w, anchor.0 + 1, anchor.1 + 2, max + 6);
    if ore.is_empty() {
        return None;
    }
    let b = w.rules.actors[ty as usize].building.as_ref()?;
    let flip_x = anchor.0 * 2 > w.map.width;
    for strict in [true, false] {
        let mut best: Option<((i64, i32), (i32, i32))> = None;
        for r in 0..max {
            for dy in -r..=r {
                for dx in -r..=r {
                    if dx.abs() != r && dy.abs() != r {
                        continue;
                    }
                    let cx = if flip_x { anchor.0 - dx - (b.width - 3) } else { anchor.0 + dx };
                    let cy = anchor.1 + dy;
                    if !w.can_place(player, ty, cx, cy) || (strict && !has_clearance(w, cx, cy, b.width, b.height)) {
                        continue;
                    }
                    let dock = dock_ore_distance(w, ty, cx, cy, &ore);
                    if dock == i32::MAX {
                        continue;
                    }
                    let near = ore_at.map_or(0, |o| cell_dist_sq((cx, cy), o));
                    let score = (near, dock);
                    if best.is_none_or(|(bs, _)| score < bs) {
                        best = Some((score, (cx, cy)));
                    }
                }
            }
        }
        if let Some((_, c)) = best {
            return Some(c);
        }
    }
    None
}

/// Ground distance (10 per straight step, 14 per diagonal) from every cell to
/// the nearest ore cell within `radius` cells of a point; `i32::MAX` where no
/// ore is reachable. Empty when there is no ore near.
fn ore_distance_field(w: &World, sx: i32, sy: i32, radius: i32) -> Vec<i32> {
    let mut d = vec![i32::MAX; w.map.cells()];
    let mut heap = std::collections::BinaryHeap::new();
    for y in sy - radius..=sy + radius {
        for x in sx - radius..=sx + radius {
            if w.map.contains(x, y) {
                let i = w.map.idx(x, y);
                if w.map.has_resource(i) && !w.pass.blocked[i] {
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

pub(crate) fn has_clearance(w: &World, cx: i32, cy: i32, bw: i32, bh: i32) -> bool {
    for y in cy - 1..=cy + bh {
        for x in cx - 1..=cx + bw {
            let inside = x >= cx && x < cx + bw && y >= cy && y < cy + bh;
            if inside || !w.map.contains(x, y) {
                continue;
            }
            if w.building_at[w.map.idx(x, y)] != NONE {
                return false;
            }
        }
    }
    true
}

// ---- Resource yard, rally points, refineries -------------------------------------------------

/// OpenRA: the Construction Yard with valuable resources around it and the
/// fewest enemies and own refineries near it (where new refineries go).
fn update_resource_conyard(w: &mut World, player: u8, cfg: &BotConfig) {
    let bb = &cfg.info.base_builder;
    st_requests_prune(w, player, cfg);
    let r = bb.max_base_radius;
    let mut best: Option<(i32, (i32, i32))> = None;
    for y in own_of(w, player, &cfg.yards) {
        let (cx, cy) = (w.actors[y].cx, w.actors[y].cy);
        let ore = (cy - r..=cy + r).any(|yy| {
            (cx - r..=cx + r).any(|xx| {
                let d = (xx - cx) * (xx - cx) + (yy - cy) * (yy - cy);
                d >= bb.min_base_radius * bb.min_base_radius
                    && d <= r * r
                    && w.map.contains(xx, yy)
                    && w.map.has_resource(w.map.idx(xx, yy))
            })
        });
        if !ore {
            continue;
        }
        let (x, yy) = (w.actors[y].x, w.actors[y].y);
        let near = |a: &crate::world::Actor| a.alive && a.in_world() && dist_sq(a.x, a.y, x, yy) <= (r * CELL) as i64 * (r * CELL) as i64;
        let refs = w.actors.iter().filter(|a| near(a) && a.owner == player && cfg.refineries.contains(&a.ty)).count() as i32;
        let enemies = w.actors.iter().filter(|a| near(a) && w.are_enemies(player, a.owner)).count() as i32;
        let suitable = -enemies - refs;
        if best.is_none_or(|(b, _)| suitable > b) {
            best = Some((suitable, (cx, cy)));
        }
    }
    w.ai[player as usize].base.resource_conyard_center = best.map(|b| b.1);
}

/// Requested refineries at a resource area that has enough of ours already are dropped.
fn st_requests_prune(w: &mut World, player: u8, cfg: &BotConfig) {
    let max = cfg.info.base_builder.max_refinery_per_indice;
    let requests = w.ai[player as usize].base.requested_refineries.clone();
    let keep: Vec<_> =
        requests.into_iter().filter(|r| crate::ai_harvest::refineries_near_resource_area(w, player, r.2).is_none_or(|n| n < max)).collect();
    w.ai[player as usize].base.requested_refineries = keep;
}

/// OpenRA IBotSuggestRefineryProduction.RequestLocation (from an expanding MCV).
pub(crate) fn request_refinery(w: &mut World, player: u8, ore: (i32, i32), yard: (i32, i32), mcv: u32) {
    let max = w.ai[player as usize].cfg.info.base_builder.max_refinery_per_indice;
    if crate::ai_harvest::refineries_near_resource_area(w, player, ore).is_none_or(|n| n < max) {
        let reqs = &mut w.ai[player as usize].base.requested_refineries;
        reqs.retain(|r| r.0 != mcv);
        reqs.push((mcv, yard, ore));
    }
}

/// Producers with a rally point (barracks, war factories, helipads...).
fn rally_producers(w: &World, player: u8) -> Vec<usize> {
    owned_buildings(w, player)
        .into_iter()
        .filter(|&b| {
            let info = w.rules.actors[w.actors[b].ty as usize].building.as_ref().unwrap();
            info.produces.iter().any(|q| matches!(q, QueueType::Infantry | QueueType::Vehicle)) && !info.exits.is_empty()
        })
        .collect()
}

/// OpenRA: every AssignRallyPointsInterval the factories are queued, and a
/// few each tick get a new rally point if theirs is missing or invalid.
fn tick_rally_points(w: &mut World, player: u8, cfg: &BotConfig) {
    let bb = &cfg.info.base_builder;
    let st = &mut w.ai[player as usize].base;
    st.rally_ticks -= 1;
    if st.rally_ticks <= 0 {
        st.rally_ticks = bb.assign_rally_points_interval.max(2);
        let list: Vec<u32> = rally_producers(w, player).into_iter().map(|b| w.make_ref(b)).collect();
        w.ai[player as usize].base.rally_stack.extend(list);
        return;
    }
    let st = &w.ai[player as usize].base;
    let n = st.rally_stack.len().div_ceil(st.rally_ticks.max(1) as usize);
    for _ in 0..n {
        let Some(r) = w.ai[player as usize].base.rally_stack.pop() else { break };
        let Some(b) = w.resolve(r) else { continue };
        if w.actors[b].owner == player {
            set_rally_point(w, player, b, bb.rally_point_scan_radius);
        }
    }
}

/// Ground component around a structure (of its first free neighbouring cell).
fn exit_component(w: &World, b: usize) -> Option<u32> {
    let a = &w.actors[b];
    let info = w.rules.actors[a.ty as usize].building.as_ref()?;
    for y in a.cy - 1..=a.cy + info.height {
        for x in a.cx - 1..=a.cx + info.width {
            if w.map.contains(x, y) && !w.pass.blocked[w.map.idx(x, y)] {
                return Some(w.pass.component[w.map.idx(x, y)]);
            }
        }
    }
    None
}

fn rally_valid(w: &World, comp: Option<u32>, x: i32, y: i32) -> bool {
    w.map.contains(x, y) && {
        let i = w.map.idx(x, y);
        !w.pass.blocked[i] && w.building_at[i] == NONE && w.map.terrain[i].buildable() && comp == Some(w.pass.component[i])
    }
}

fn set_rally_point(w: &mut World, _player: u8, b: usize, radius: i32) {
    let comp = exit_component(w, b);
    if let Some((x, y)) = w.actors[b].rally {
        let (rx, ry) = w.cell_of(x, y);
        if rally_valid(w, comp, rx, ry) {
            return;
        }
    }
    let (cx, cy) = (w.actors[b].cx, w.actors[b].cy);
    let cells: Vec<(i32, i32)> = (cy - radius..=cy + radius)
        .flat_map(|y| (cx - radius..=cx + radius).map(move |x| (x, y)))
        .filter(|&(x, y)| (x - cx) * (x - cx) + (y - cy) * (y - cy) <= radius * radius && rally_valid(w, comp, x, y))
        .collect();
    if cells.is_empty() {
        return;
    }
    let k = rand(w, 0, cells.len() as i32) as usize;
    w.actors[b].rally = Some((cell_center(cells[k].0), cell_center(cells[k].1)));
}

/// OpenRA SellUselessRefinery: one refinery too close to another, or far
/// from any valuable resource and any ore mine, is sold (never below the
/// minimum count).
pub(crate) fn sell_useless_refinery(w: &mut World, player: u8, cfg: &BotConfig) {
    let bb = &cfg.info.base_builder;
    let refineries: Vec<usize> = owned_buildings(w, player)
        .into_iter()
        .filter(|&b| w.rules.actors[w.actors[b].ty as usize].building.as_ref().is_some_and(|x| x.refinery.is_some()))
        .collect();
    if refineries.len() as i32 <= bb.initital_minimum_refinery_count + bb.additional_minimum_refinery_count {
        return;
    }
    let close = bb.sell_refinery_too_close_cell_distance;
    let far = bb.sell_refinery_no_resource_distance;
    for (k, &r) in refineries.iter().enumerate() {
        let at = (w.actors[r].cx, w.actors[r].cy);
        let crowded = refineries[k + 1..].iter().any(|&o| cell_dist_sq(at, (w.actors[o].cx, w.actors[o].cy)) <= (close * close) as i64);
        let (rx, ry) = (w.actors[r].x, w.actors[r].y);
        let mine_near = w.actors.iter().any(|a| {
            a.alive
                && a.in_world()
                && cfg.resource_creators.contains(&a.ty)
                && dist_sq(a.x, a.y, rx, ry) <= (far * CELL) as i64 * (far * CELL) as i64
        });
        let dry = cfg.info.resource_map.is_some()
            && !mine_near
            && !(at.1 - far..=at.1 + far).any(|y| {
                (at.0 - far..=at.0 + far).any(|x| {
                    (x - at.0) * (x - at.0) + (y - at.1) * (y - at.1) <= far * far
                        && w.map.contains(x, y)
                        && w.map.has_resource(w.map.idx(x, y))
                })
            });
        if crowded || dry {
            let rr = w.make_ref(r);
            w.queue_order(crate::world::Order::Sell { player, building: rr });
            return;
        }
    }
}

//! OpenRA UnitBuilderBotModule: every FeedbackTime ticks the bot builds
//! what other modules asked for (ore trucks, MCVs, engineers) and one unit
//! in the next queue by UnitsToBuild shares, UnitLimits and UnitDelays.

use crate::ai::rand;
use crate::ai_bots::BotConfig;
use crate::rules::QueueType;
use crate::world::World;

/// UnitBuilderBotModule.FeedbackTime: ticks between production decisions.
const FEEDBACK_TIME: i32 = 30;

#[derive(Clone, Default, Debug)]
pub(crate) struct UnitState {
    ticks: i32,
    /// Units other modules asked for (IBotRequestUnitProduction).
    requests: Vec<u16>,
    /// Units hanging around the base (IBotNotifyIdleBaseUnits).
    pub(crate) idle_units: usize,
    queue_index: usize,
}

pub(crate) fn start(_w: &mut World, _player: u8) {}

/// IBotRequestUnitProduction.RequestUnitProduction.
pub(crate) fn request(w: &mut World, player: u8, ty: u16) {
    w.ai[player as usize].units.requests.push(ty);
}

/// IBotRequestUnitProduction.RequestedProductionCount.
pub(crate) fn requested(w: &World, player: u8, ty: u16) -> usize {
    w.ai[player as usize].units.requests.iter().filter(|&&t| t == ty).count()
}

fn queue_of(name: &str) -> Option<QueueType> {
    match name {
        "Vehicle" => Some(QueueType::Vehicle),
        "Infantry" => Some(QueueType::Infantry),
        "Ship" => Some(QueueType::Ship),
        "Aircraft" => Some(QueueType::Aircraft),
        _ => None,
    }
}

pub(crate) fn tick(w: &mut World, player: u8) {
    let cfg = w.ai[player as usize].cfg.clone();
    let ub = &cfg.info.unit_builder;
    // WebRA: a bot that earns nothing any more spends its last credits too
    // (OpenRA waits for ProductionMinCashRequirement, which never comes).
    let min_cash = if crate::ai_economy::starving(w, player) { 1 } else { ub.production_min_cash_requirement };
    if w.players[player as usize].funds() < min_cash || crate::ai_base::pause_unit_production(w, player) {
        return;
    }
    let feedback = w.ai[player as usize].level().interval(FEEDBACK_TIME);
    let st = &mut w.ai[player as usize].units;
    st.ticks += 1;
    if st.ticks % feedback != 0 {
        return;
    }
    if !st.requests.is_empty() {
        let ty = st.requests.remove(0);
        build_unit(w, player, ty);
    }
    let st = &w.ai[player as usize].units;
    if ub.idle_base_units_maximum > 0 && ub.idle_base_units_maximum as usize <= st.idle_units {
        return;
    }
    for _ in 0..ub.unit_queues.len() {
        let st = &mut w.ai[player as usize].units;
        st.queue_index = (st.queue_index + 1) % ub.unit_queues.len();
        let Some(q) = queue_of(&ub.unit_queues[st.queue_index]) else { continue };
        if w.has_producer(player, q) {
            build_random_unit(w, player, &cfg, q);
            break;
        }
    }
}

/// OpenRA BuildUnit: a requested unit, when its queue is free.
fn build_unit(w: &mut World, player: u8, ty: u16) {
    let q = w.rules.actors[ty as usize].queue;
    if w.players[player as usize].queues[q as usize].items.is_empty() && w.has_producer(player, q) {
        w.start_production(player, ty, 1);
    }
}

fn build_random_unit(w: &mut World, player: u8, cfg: &BotConfig, q: QueueType) {
    if cfg.units_to_build.is_empty() || !w.players[player as usize].queues[q as usize].items.is_empty() {
        return;
    }
    if q == QueueType::Ship {
        crate::ai_naval::choose_primary_yard(w, player, cfg);
    }
    if let Some(ty) = choose_unit(w, player, cfg, q) {
        w.start_production(player, ty, 1);
    }
}

/// OpenRA ChooseRandomUnitToBuild: in random order, the first buildable type
/// below its UnitsToBuild share of the listed units, else the one closest to
/// its share; never past UnitLimits or before UnitDelays, and an aircraft
/// only while it has a free rearm structure. WebRA: a warship only while
/// the water of the yard it leaves reaches an enemy (that yard is made
/// primary when another one's does not, ai_naval.rs).
fn choose_unit(w: &mut World, player: u8, cfg: &BotConfig, q: QueueType) -> Option<u16> {
    let mut buildable: Vec<u16> =
        (0..w.rules.actors.len() as u16).filter(|&t| w.rules.actors[t as usize].queue == q && w.can_start(player, t)).collect();
    crate::ai_base::shuffle(w, &mut buildable);
    let listed: Vec<u16> = w
        .actors
        .iter()
        .filter(|a| a.alive && a.owner == player && cfg.units_to_build.iter().any(|&(t, _)| t == a.ty))
        .map(|a| a.ty)
        .collect();
    let tick = w.tick as i64;
    let mut desired: Option<(i64, u16)> = None;
    for ty in buildable {
        let Some(share) = BotConfig::lookup(&cfg.units_to_build, ty) else { continue };
        if BotConfig::lookup(&cfg.unit_delays, ty).is_some_and(|d| d as i64 > tick) {
            continue;
        }
        let count = listed.iter().filter(|&&t| t == ty).count() as i64;
        if BotConfig::lookup(&cfg.unit_limits, ty).is_some_and(|l| count >= l as i64) {
            continue;
        }
        // WebRA: no warships for water that reaches no enemy (ai_naval.rs).
        if useless_warship(w, player, cfg, ty) {
            continue;
        }
        let error = if listed.is_empty() { -1 } else { count * 100 / listed.len() as i64 - share as i64 };
        if error < 0 {
            return rearm_ok(w, player, ty).then_some(ty);
        }
        if desired.is_none_or(|(e, _)| error < e) {
            desired = Some((error, ty));
        }
    }
    desired.map(|(_, t)| t).filter(|&t| rearm_ok(w, player, t))
}

/// A warship of the naval squads (NavalUnitsTypes) that could attack no
/// enemy from the water of the player's yards (ai_naval.rs).
fn useless_warship(w: &mut World, player: u8, cfg: &BotConfig, ty: u16) -> bool {
    crate::ai_naval::warship_types(w, cfg).contains(&ty) && !crate::ai_naval::warship_useful(w, player, cfg, ty)
}

/// OpenRA HasAdequateAirUnitReloadBuildings: fewer aircraft of this type than
/// structures that rearm it.
fn rearm_ok(w: &World, player: u8, ty: u16) -> bool {
    let Some(air) = w.rules.actors[ty as usize].unit.as_ref().and_then(|u| u.aircraft.as_ref()) else { return true };
    if air.rearm_actors.is_empty() {
        return true;
    }
    let own = w.actors.iter().filter(|a| a.alive && a.owner == player && a.ty == ty).count();
    let pads = w
        .actors
        .iter()
        .filter(|a| {
            a.alive && a.owner == player && air.rearm_actors.iter().any(|r| r.eq_ignore_ascii_case(&w.rules.actors[a.ty as usize].id))
        })
        .count();
    own < pads
}

/// Random element of a list from the world RNG (OpenRA Random()).
pub(crate) fn pick<T: Copy>(w: &mut World, list: &[T]) -> Option<T> {
    if list.is_empty() {
        return None;
    }
    let k = rand(w, 0, list.len() as i32) as usize;
    Some(list[k])
}

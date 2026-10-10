//! The skirmish AI and the Red Alert infantry: which soldiers it trains
//! (OpenRA mods/ra ai.yaml UnitBuilderBotModule UnitsToBuild and UnitLimits)
//! and what it does with engineers (OpenRA CaptureManagerBotModule).

use crate::infantry::EnterKind;
use crate::math::dist_sq;
use crate::rules::{Kind, QueueType};
use crate::world::{Activity, World};

/// Infantry share of the army in percent and the most at once (0: no
/// limit), from UnitBuilderBotModule@normal of OpenRA's RA ai.yaml.
const INFANTRY_TO_BUILD: &[(&str, usize, usize)] =
    &[("E1", 65, 0), ("E2", 15, 0), ("E3", 30, 0), ("E4", 15, 0), ("E7", 1, 0), ("DOG", 15, 4), ("SHOK", 15, 0)];

/// BaseBuilderBotModule BuildingDelays kenn: no kennel before this tick.
const KENNEL_DELAY: u32 = 9000;

/// One kennel once the base stands (BaseBuilderBotModule BuildingFractions
/// kenn 1 and BuildingDelays kenn 9000), for the dogs of UnitsToBuild.
pub(crate) fn kennel(w: &World, player: u8) -> Option<u16> {
    if w.tick < KENNEL_DELAY {
        return None;
    }
    let ty = w.rules.actor_index("KENN")? as u16;
    let owned = w.actors.iter().any(|a| a.alive && a.owner == player && a.ty == ty);
    let cost = w.rules.actors[ty as usize].cost;
    (!owned && w.can_start(player, ty) && w.players[player as usize].funds() >= cost).then_some(ty)
}

/// CaptureManagerBotModule.MinimumCaptureDelay: ticks between capture orders.
const CAPTURE_DELAY: u32 = 375;
/// CaptureManagerBotModule.MaximumCaptureTargetOptions.
const CAPTURE_OPTIONS: usize = 10;

/// The soldier to train next (OpenRA UnitBuilderBotModule.ChooseUnitToBuild):
/// the first buildable type, in an order that changes every think, whose
/// share of the AI's units is below its UnitsToBuild percentage and that is
/// under its UnitLimits.
pub(crate) fn infantry_to_build(w: &World, player: u8) -> Option<u16> {
    let units: Vec<u16> =
        w.actors.iter().filter(|a| a.alive && a.owner == player && a.is_unit() && a.kind != Kind::Mine).map(|a| a.ty).collect();
    let n = INFANTRY_TO_BUILD.len();
    // OpenRA shuffles with the local random; this rotation is deterministic.
    let salt = w.ai.get(player as usize).map_or(0, |a| a.salt);
    let start = ((w.tick as u64 / 25).wrapping_add(salt) % n as u64) as usize;
    for k in 0..n {
        let (id, share, limit) = INFANTRY_TO_BUILD[(start + k) % n];
        let Some(ty) = w.rules.actor_index(id).map(|t| t as u16) else { continue };
        if w.rules.actors[ty as usize].queue != QueueType::Infantry || !w.can_start(player, ty) {
            continue;
        }
        // Only what the AI can pay for now, like its tanks: a broke AI
        // trains its cheapest soldier (ai.rs) instead of running a deficit
        // on dear ones that keeps every tank from starting.
        if w.rules.actors[ty as usize].cost > w.players[player as usize].funds() {
            continue;
        }
        let have = units.iter().filter(|&&t| t == ty).count();
        if have * 100 >= share * units.len().max(1) || (limit > 0 && have >= limit) {
            continue;
        }
        return Some(ty);
    }
    None
}

/// OpenRA CaptureManagerBotModule: every MinimumCaptureDelay ticks, idle own
/// units that can capture go for the most valuable capturable structures of
/// an enemy or neutral player the AI can see, each to the nearest of them.
pub(crate) fn command_capturers(w: &mut World, player: u8) {
    let Some(st) = w.ai.get_mut(player as usize) else { return };
    if st.next_capture_at == 0 {
        // Spread the AIs' first evaluation (OpenRA: a random initial delay).
        st.next_capture_at = (st.salt.wrapping_add(player as u64 * 97) % CAPTURE_DELAY as u64) as u32 + 1;
    }
    if w.tick < st.next_capture_at {
        return;
    }
    st.next_capture_at = w.tick + CAPTURE_DELAY;
    let capturers: Vec<usize> = (0..w.actors.len())
        .filter(|&i| {
            let a = &w.actors[i];
            a.alive
                && a.owner == player
                && a.in_world()
                && a.activity == Activity::Idle
                && a.kind == Kind::Infantry
                && w.rules.actors[a.ty as usize].abilities.captures.is_some()
        })
        .collect();
    if capturers.is_empty() {
        return;
    }
    let mut options: Vec<usize> = (0..w.actors.len())
        .filter(|&t| {
            let a = &w.actors[t];
            a.alive
                && a.kind == Kind::Building
                && !w.are_allies(player, a.owner)
                && w.targetable(t, player)
                && capturers.iter().any(|&c| w.can_capture(c, t))
        })
        .collect();
    options.sort_by_key(|&t| (std::cmp::Reverse(w.rules.actors[w.actors[t].ty as usize].building.as_ref().map_or(0, |b| b.value)), t));
    options.truncate(CAPTURE_OPTIONS);
    for c in capturers {
        let (x, y) = (w.actors[c].x, w.actors[c].y);
        let best =
            options.iter().copied().filter(|&t| w.can_capture(c, t)).min_by_key(|&t| (dist_sq(x, y, w.actors[t].x, w.actors[t].y), t));
        if let Some(t) = best {
            w.order_enter(c, t, EnterKind::Capture);
        }
    }
}

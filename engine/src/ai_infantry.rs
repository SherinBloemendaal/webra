//! The skirmish AI and capturing (OpenRA CaptureManagerBotModule): every
//! MinimumCaptureDelay ticks, idle own units that can capture go for the
//! most valuable capturable actors of a random enemy or neutral player that
//! the bot can see, each to the nearest one it can reach. OpenRA ranks the
//! targets by sell value; WebRA by `capture_value`, which also counts what
//! a structure's traits give its new owner.
//!
//! OpenRA removed capturing from the Red Alert bots in 2016 (commit
//! 7e6488c522) and their UnitsToBuild have no engineers. WebRA's bots keep
//! the module with OpenRA's defaults and train an engineer on their own
//! (through the unit builder's requests, like ore trucks) while a neutral
//! structure worth taking stands where their ground units can reach it:
//! tech buildings, oil derricks and the like. How much a target is worth is
//! read from its traits (`capture_value`), never from actor ids.

use crate::ai::rand;
use crate::infantry::EnterKind;
use crate::math::dist_sq;
use crate::rules::{Kind, QueueType};
use crate::world::{Activity, World};

/// CaptureManagerBotModule.MinimumCaptureDelay: ticks between capture orders.
const CAPTURE_DELAY: i32 = 375;
/// CaptureManagerBotModule.MaximumCaptureTargetOptions.
const CAPTURE_OPTIONS: usize = 10;
/// Most capturers (alive or queued) the bot trains for neutral structures.
const MAX_ENGINEERS: usize = 2;

#[derive(Clone, Default, Debug)]
pub(crate) struct CaptureState {
    delay_ticks: i32,
    /// Capturers on their way (references).
    active: Vec<u32>,
}

pub(crate) fn start_capture(w: &mut World, player: u8) {
    let t = rand(w, 0, CAPTURE_DELAY);
    w.ai[player as usize].capture.delay_ticks = t;
}

/// What capturing structure `t` is worth: its sell value (OpenRA
/// GetSellValue), plus its value again for each lasting benefit its traits
/// give the new owner (support powers, production, radar, ore storage).
pub(crate) fn capture_value(w: &World, t: usize) -> i64 {
    let info = &w.rules.actors[w.actors[t].ty as usize];
    let Some(b) = info.building.as_ref() else { return info.cost as i64 };
    let value = b.value as i64;
    let benefits = [
        info.abilities.support_powers.as_ref().is_some_and(|l| !l.is_empty()),
        !b.produces.is_empty(),
        info.abilities.provides_radar.is_some(),
        b.refinery.is_some() || b.storage > 0,
        b.power > 0,
    ];
    value + value * benefits.iter().filter(|&&x| x).count() as i64
}

fn capturer(w: &World, i: usize) -> bool {
    w.rules.actors[w.actors[i].ty as usize].abilities.captures.is_some()
}

pub(crate) fn tick_capture(w: &mut World, player: u8) {
    let st = &mut w.ai[player as usize].capture;
    st.delay_ticks -= 1;
    if st.delay_ticks > 0 {
        return;
    }
    let level = w.ai[player as usize].level();
    w.ai[player as usize].capture.delay_ticks = level.interval(CAPTURE_DELAY);
    if w.players[player as usize].defeated || w.winner.is_some() {
        return;
    }
    request_engineer(w, player);
    queue_capture_orders(w, player);
}

/// OpenRA QueueCaptureOrders.
fn queue_capture_orders(w: &mut World, player: u8) {
    let active: Vec<u32> = w.ai[player as usize]
        .capture
        .active
        .iter()
        .copied()
        .filter(|&r| {
            w.resolve(r).is_some_and(|i| w.actors[i].alive && w.actors[i].owner == player && w.actors[i].activity != Activity::Idle)
        })
        .collect();
    w.ai[player as usize].capture.active = active.clone();
    let capturers: Vec<usize> = (0..w.actors.len())
        .filter(|&i| {
            let a = &w.actors[i];
            a.alive
                && a.owner == player
                && a.in_world()
                && a.activity == Activity::Idle
                && capturer(w, i)
                && !active.contains(&w.make_ref(i))
        })
        .collect();
    if capturers.is_empty() {
        return;
    }
    // A random enemy or neutral player.
    let players: Vec<u8> =
        (0..w.players.len() as u8).filter(|&p| p != player && !w.are_allies(player, p) && !w.players[p as usize].defeated).collect();
    let Some(target_player) = crate::ai_units::pick(w, &players) else { return };
    let mut options: Vec<usize> = (0..w.actors.len())
        .filter(|&t| {
            let a = &w.actors[t];
            a.alive
                && a.in_world()
                && a.owner == target_player
                && w.is_visible_to(t, player)
                && !w.is_cloaked_from(t, player)
                && capturers.iter().any(|&c| w.can_capture(c, t))
        })
        .collect();
    options.sort_by_key(|&t| (std::cmp::Reverse(capture_value(w, t)), t));
    options.truncate(CAPTURE_OPTIONS);
    for c in capturers {
        let (x, y) = (w.actors[c].x, w.actors[c].y);
        let comp = w.pass.component[w.cell_index(x, y)];
        let best = options
            .iter()
            .copied()
            .filter(|&t| w.can_capture(c, t) && reachable(w, comp, t))
            .min_by_key(|&t| (dist_sq(x, y, w.actors[t].x, w.actors[t].y), t));
        if let Some(t) = best {
            w.order_enter(c, t, EnterKind::Capture);
            let r = w.make_ref(c);
            w.ai[player as usize].capture.active.push(r);
        }
    }
}

/// Whether ground units of component `comp` can walk up to structure `t`.
fn reachable(w: &World, comp: u32, t: usize) -> bool {
    let a = &w.actors[t];
    let Some(b) = w.rules.actors[a.ty as usize].building.as_ref() else {
        return w.pass.component[w.cell_index(a.x, a.y)] == comp;
    };
    (a.cy - 1..=a.cy + b.height).any(|y| {
        (a.cx - 1..=a.cx + b.width)
            .any(|x| w.map.contains(x, y) && !w.pass.blocked[w.map.idx(x, y)] && w.pass.component[w.map.idx(x, y)] == comp)
    })
}

/// WebRA: train an engineer while a neutral structure worth capturing
/// stands within reach of the base and the bot has fewer than MAX_ENGINEERS.
fn request_engineer(w: &mut World, player: u8) {
    let engineer = (0..w.rules.actors.len() as u16)
        .filter(|&t| {
            let info = &w.rules.actors[t as usize];
            info.queue == QueueType::Infantry && info.abilities.captures.is_some() && w.can_start(player, t)
        })
        .min_by_key(|&t| (w.rules.actors[t as usize].cost, t));
    let Some(engineer) = engineer else { return };
    let own =
        w.actors.iter().filter(|a| a.alive && a.owner == player && w.rules.actors[a.ty as usize].abilities.captures.is_some()).count();
    let queued = w.players[player as usize].queues[QueueType::Infantry as usize].items.iter().filter(|it| it.ty == engineer).count();
    if own + queued + crate::ai_units::requested(w, player, engineer) >= MAX_ENGINEERS {
        return;
    }
    let base = crate::ai::base_point(w, player);
    let comp = (0..16)
        .flat_map(|r| {
            let (bx, by) = w.cell_of(base.0, base.1);
            (by - r..=by + r).flat_map(move |y| (bx - r..=bx + r).map(move |x| (x, y)))
        })
        .find(|&(x, y)| w.map.contains(x, y) && !w.pass.blocked[w.map.idx(x, y)])
        .map(|(x, y)| w.pass.component[w.map.idx(x, y)]);
    let Some(comp) = comp else { return };
    let worth = (0..w.actors.len()).any(|t| {
        let a = &w.actors[t];
        a.alive
            && a.kind == Kind::Building
            && w.players[a.owner as usize].neutral
            && w.rules.actors[a.ty as usize].abilities.capturable.is_some()
            && w.is_visible_to(t, player)
            && capture_value(w, t) > 0
            && reachable(w, comp, t)
    });
    if worth {
        crate::ai_units::request(w, player, engineer);
    }
}

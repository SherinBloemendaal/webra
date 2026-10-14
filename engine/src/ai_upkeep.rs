//! OpenRA BuildingRepairBotModule and PowerDownBotModule: the bot repairs
//! its structures when they are hit (all damaged ones at most every
//! RepairAllBuildingsCoolDown ticks, else the one that just fell below three
//! quarters of its health), and while its power runs short it switches off
//! power hungry structures (PowerDownTypes: radar, Tesla Coils, missile silo,
//! anti-air), cheapest first, and on again once there is power to spare.

use crate::ai::{damage_state, rand, AttackEvent};
use crate::rules::Kind;
use crate::world::{Order, World};

#[derive(Clone, Default, Debug)]
pub(crate) struct UpkeepState {
    /// Tick of the last "repair everything" (BuildingRepairBotModule.prevTicks).
    repair_all_at: u32,
    toggle_ticks: i32,
    /// Structures switched off (references) and the power change of switching them on.
    toggled: Vec<(u32, i32)>,
}

pub(crate) fn start(w: &mut World, player: u8) {
    let cfg = w.ai[player as usize].cfg.clone();
    if let Some(p) = &cfg.info.power_down {
        let t = rand(w, 0, p.interval);
        w.ai[player as usize].upkeep.toggle_ticks = t;
    }
}

fn repairing(w: &World, player: u8, b: usize) -> bool {
    w.actors[b].repairers.contains(&player)
}

fn order_repair(w: &mut World, player: u8, b: usize) {
    let r = w.make_ref(b);
    w.queue_order(Order::RepairBuilding { player, building: r });
}

/// IBotRespondToAttack of BuildingRepairBotModule.
pub(crate) fn respond_to_attack(w: &mut World, player: u8, victim: usize, attacker: usize, e: AttackEvent) {
    let cfg = w.ai[player as usize].cfg.clone();
    let Some(info) = &cfg.info.building_repair else { return };
    let cooldown = info.repair_all_buildings_cool_down;
    let tick = w.tick;
    if cooldown >= 0 && w.ai[player as usize].upkeep.repair_all_at + (cooldown as u32) < tick {
        w.ai[player as usize].upkeep.repair_all_at = tick;
        let damaged: Vec<usize> = (0..w.actors.len())
            .filter(|&b| {
                let a = &w.actors[b];
                a.alive
                    && a.owner == player
                    && a.kind == Kind::Building
                    && w.can_repair_building(player, b)
                    && !repairing(w, player, b)
                    && (1..5).contains(&damage_state(a.hp, w.rules.actors[a.ty as usize].hp))
            })
            .collect();
        for b in damaged {
            order_repair(w, player, b);
        }
        return;
    }
    let neutral = !w.are_enemies(player, w.actors[attacker].owner) && !w.are_allies(player, w.actors[attacker].owner);
    if !w.actors[victim].alive || neutral || w.actors[victim].kind != Kind::Building {
        return;
    }
    let max = w.rules.actors[w.actors[victim].ty as usize].hp;
    let (before, after) = (damage_state(e.before, max), damage_state(e.after, max));
    if after > 1 && before <= 1 && w.can_repair_building(player, victim) && !repairing(w, player, victim) {
        order_repair(w, player, victim);
    }
}

/// Power gained by switching structure `b` off now (negative: power it
/// costs to switch it on again), like OpenRA's GetTogglePowerChanging.
fn toggle_change(w: &World, b: usize) -> i32 {
    let power = w.rules.actors[w.actors[b].ty as usize].building.as_ref().map_or(0, |x| x.power);
    if w.actors[b].powered_off {
        power
    } else {
        -power
    }
}

pub(crate) fn tick_power_down(w: &mut World, player: u8) {
    let cfg = w.ai[player as usize].cfg.clone();
    let Some(info) = &cfg.info.power_down else { return };
    let st = &mut w.ai[player as usize].upkeep;
    if st.toggle_ticks > 0 {
        st.toggle_ticks -= 1;
        return;
    }
    // WebRA: through a lightning blackout the plants count as working (ai_lightning.rs).
    let mut power = crate::ai_lightning::power_gen(w, player) - w.players[player as usize].power_use;
    let mut toggling: Vec<usize> = Vec::new();
    let toggled_now = w.ai[player as usize].upkeep.toggled.clone();
    if power > 0 && !toggled_now.is_empty() {
        let mut toggled: Vec<(u32, i32)> = toggled_now
            .into_iter()
            .filter(|(r, _)| w.resolve(*r).is_some_and(|b| w.actors[b].alive && w.actors[b].owner == player && w.actors[b].in_world()))
            .collect();
        toggled.sort_by_key(|t| std::cmp::Reverse(t.1));
        // OpenRA's loop removes while it walks, so it looks at every other
        // entry per pass; the rest wait for the next interval.
        let mut i = 0;
        while i < toggled.len() {
            let (r, change) = toggled[i];
            if power + change < 0 {
                i += 1;
                continue;
            }
            if let Some(b) = w.resolve(r) {
                toggling.push(b);
            }
            power += change;
            toggled.remove(i);
            i += 1;
        }
        w.ai[player as usize].upkeep.toggled = toggled;
    } else if power < 0 {
        let mut online: Vec<(i32, usize)> = (0..w.actors.len())
            .filter(|&b| {
                let a = &w.actors[b];
                a.alive && a.owner == player && cfg.power_down.contains(&a.ty) && w.can_power_down(player, b)
            })
            .map(|b| (toggle_change(w, b), b))
            .filter(|&(c, _)| c > 0)
            .collect();
        online.sort();
        for (change, b) in online {
            if power > 0 {
                break;
            }
            toggling.push(b);
            let r = w.make_ref(b);
            w.ai[player as usize].upkeep.toggled.push((r, -change));
            power += change;
        }
    }
    for b in toggling {
        let r = w.make_ref(b);
        w.queue_order(Order::PowerDown { player, building: r });
    }
    let level = w.ai[player as usize].level();
    w.ai[player as usize].upkeep.toggle_ticks = level.interval(info.interval);
}

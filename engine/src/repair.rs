//! The sidebar's Repair and Power down buttons.
//!
//! Repair (OpenRA `RepairableBuilding`, `Order::RepairBuilding`): a player
//! clicks an own or allied damaged structure to start or stop repairing it.
//! Every `interval` ticks the structure gains up to `step` hit points; each
//! repairing player pays `max(1, hp * percent * value / (max_hp * 100))` for
//! that step, where `value` is the structure's sell value (OpenRA
//! `GetSellValue`: CustomSellValue or the cost). Several allied players
//! repairing together heal faster (`bonuses`, by the number of players who
//! could pay), never pay more. A player who cannot pay sits the step out
//! (insufficient funds); when nobody can pay, the repair waits and tries again
//! every other tick. Repairing stops when the structure is fully repaired,
//! and for players who are no longer allied or no longer playing. Red Alert
//! numbers: 700 hit points per 24 ticks, 20 percent of the value in total.
//!
//! Power down (OpenRA `ToggleConditionOnOrder` with `OrderName: PowerDown`
//! and `PowerMultiplier@POWERDOWN`, `Order::PowerDown`): the owner switches a
//! structure that has the button (Red Alert: defences that need power, the
//! radar dome, the gap generator and the superweapons) off and on again. Off,
//! it uses no power and is disabled exactly like on low power
//! (`World::is_powered_down`): defences hold fire, radar and the gap generator
//! stop, support powers stop charging.
//!
//! Both are simulation state (part of `World::state_hash`); the announcer
//! line ("Repairing") and the power sounds go through sound_events.rs.

use crate::rules::Kind;
use crate::sound_events::SoundEventKind;
use crate::world::World;

/// Ticks before an unpaid repair step is tried again (OpenRA sets
/// `remainingTicks = 1`, then counts it down on the next tick).
pub const UNPAID_RETRY_TICKS: i32 = 1;

impl World {
    /// Whether `player` may start (or stop) repairing structure `i`: it has
    /// the repair button and is the player's own or an ally's (OpenRA
    /// `AppearsFriendlyTo`). Starting also needs it to be damaged.
    pub fn can_toggle_repair(&self, player: u8, i: usize) -> bool {
        let a = &self.actors[i];
        a.alive
            && a.kind == Kind::Building
            && a.in_world()
            && (player as usize) < self.players.len()
            && self.are_allies(player, a.owner)
            && self.rules.actors[a.ty as usize].building.as_ref().is_some_and(|b| b.repairable.is_some())
    }

    /// Whether a click with the repair cursor on structure `i` gives an order:
    /// a friendly damaged structure with the repair button (OpenRA
    /// `RepairOrderGenerator`). Clicking one that is being repaired stops it.
    pub fn can_repair_building(&self, player: u8, i: usize) -> bool {
        self.can_toggle_repair(player, i) && self.actors[i].hp < self.rules.actors[self.actors[i].ty as usize].hp
    }

    /// `Order::RepairBuilding`: start or stop `player` repairing structure `i`.
    pub(crate) fn toggle_repair(&mut self, player: u8, i: usize) {
        if !self.can_toggle_repair(player, i) {
            return;
        }
        if let Some(pos) = self.actors[i].repairers.iter().position(|&p| p == player) {
            // Red Alert has no "repairing stopped" notification.
            self.actors[i].repairers.remove(pos);
            if self.actors[i].repairers.is_empty() {
                self.actors[i].repair_active = false;
            }
            return;
        }
        let info = &self.rules.actors[self.actors[i].ty as usize];
        let bonuses = info.building.as_ref().and_then(|b| b.repairable.as_ref()).map_or(0, |r| r.bonuses.len());
        // A structure at full health has nothing to repair (the repair cursor
        // offers no order there); at most `bonuses - 1` players repair at once.
        if self.actors[i].hp >= info.hp || self.actors[i].repairers.len() + 1 >= bonuses {
            return;
        }
        self.actors[i].repairers.push(player);
        let a = &self.actors[i];
        let (ty, x, y, owner) = (a.ty as i32, a.x, a.y, a.owner);
        // OpenRA RepairingNotification: to the player who started repairing.
        self.sound.push(SoundEventKind::RepairStarted, ty, x, y, player, owner as i32);
    }

    /// Repair steps of every structure being repaired (OpenRA `RepairableBuilding.Tick`).
    pub(crate) fn tick_repairs(&mut self) {
        for i in 0..self.actors.len() {
            if !self.actors[i].alive || self.actors[i].repairers.is_empty() {
                continue;
            }
            self.tick_building_repair(i);
        }
    }

    fn tick_building_repair(&mut self, i: usize) {
        if self.actors[i].repair_ticks > 0 {
            self.actors[i].repair_ticks -= 1;
            return;
        }
        // Players who left the alliance or the game (won or lost) stop repairing.
        let owner = self.actors[i].owner;
        let mut repairers = std::mem::take(&mut self.actors[i].repairers);
        repairers.retain(|&p| self.are_allies(p, owner) && !self.players[p as usize].defeated && self.winner.is_none());
        self.actors[i].repairers = repairers;
        if self.actors[i].repairers.is_empty() {
            self.actors[i].repair_active = false;
            return;
        }
        let a = &self.actors[i];
        let info = &self.rules.actors[a.ty as usize];
        let b = info.building.as_ref().expect("repairers only on structures");
        let r = b.repairable.as_ref().expect("repairers only on repairable structures");
        let max_hp = info.hp.max(1);
        let hp = (r.step).min(max_hp - a.hp).max(0);
        // The cost is the same however many players repair.
        let cost = ((hp as i64 * r.percent as i64 * b.value as i64) / (max_hp as i64 * 100)).max(1) as i32;
        let (interval, bonuses, ty, player_xp) = (r.interval, r.bonuses.clone(), a.ty, r.player_experience);
        let tick = self.tick;
        let mut paying = 0usize;
        for k in 0..self.actors[i].repairers.len() {
            let p = self.actors[i].repairers[k];
            if self.spend(p, cost) {
                paying += 1;
                // Observer statistics (observer.rs): money spent on repairs.
                self.note_repair(p, cost);
            } else {
                // OpenRA TakeCash(cost, notifyLowFunds: true).
                self.sound.push_funds(tick, p, ty);
            }
        }
        self.actors[i].repair_active = paying > 0;
        if paying == 0 {
            self.actors[i].repair_ticks = UNPAID_RETRY_TICKS;
            return;
        }
        // The bonus counts the players who paid; at most bonuses.len() - 1 repair.
        let bonus = bonuses[(paying - 1).min(bonuses.len() - 1)];
        let heal = (hp as i64 * bonus as i64 / 100) as i32;
        let a = &mut self.actors[i];
        a.hp = (a.hp + heal).min(max_hp);
        if a.hp >= max_hp {
            // Undamaged: repairing ends, and allied repairers gain
            // PlayerExperience (gamerules.rs).
            let allies: Vec<u8> = a.repairers.iter().copied().filter(|&p| p != owner).collect();
            for p in allies {
                self.give_player_experience(p, player_xp as i64);
            }
            let a = &mut self.actors[i];
            a.repairers.clear();
            a.repair_active = false;
            a.repair_ticks = 0;
            return;
        }
        a.repair_ticks = interval;
    }

    /// Whether structure `i` has the power down button.
    pub fn has_power_down(&self, i: usize) -> bool {
        let a = &self.actors[i];
        a.kind == Kind::Building && self.rules.actors[a.ty as usize].building.as_ref().is_some_and(|b| b.power_down)
    }

    /// Whether a click with the power down cursor on actor `i` gives `player`
    /// an order: an own structure with the button (OpenRA `PowerDownOrderGenerator`).
    pub fn can_power_down(&self, player: u8, i: usize) -> bool {
        let a = &self.actors[i];
        a.alive && a.in_world() && a.owner == player && self.has_power_down(i)
    }

    /// `Order::PowerDown`: switch the owner's structure off, or on again.
    pub(crate) fn toggle_power_down(&mut self, player: u8, i: usize) {
        if !self.can_power_down(player, i) {
            return;
        }
        let a = &mut self.actors[i];
        a.powered_off = !a.powered_off;
        let (ty, x, y, owner, off) = (a.ty as i32, a.x, a.y, a.owner, a.powered_off);
        // OpenRA EnabledSound (DisablePower) when switched off, DisabledSound (EnablePower) when on again.
        self.sound.push(SoundEventKind::PowerToggled, ty, x, y, owner, off as i32);
        // The power meter follows at once (OpenRA PowerMultiplier updates the power manager).
        self.update_power();
    }
}

/// Decoration sprites, `SpriteIds::decorations_base + index`
/// (apps/game/js/art/decorations.js DECORATION_SPECIALS).
pub const DECORATION_WRENCH: f32 = 0.0;
pub const DECORATION_POWER_OFF: f32 = 1.0;
/// Ticks per frame of the blinking `allyrepair` and `poweroff` animations
/// (Tick 160 ms at 40 ms per tick); a cycle is on for one frame, off for one.
pub const DECORATION_FRAME_TICKS: u32 = 4;
/// Distance of the two icons from the centre when both show (OpenRA Offsets 10 and -10).
pub const DECORATION_SPREAD: f32 = 10.0;

impl World {
    /// The wrench of a structure being repaired, in the colour of each
    /// repairer in turn, and the power off icon of a switched off one, at its
    /// centre (OpenRA WithBuildingRepairDecoration and WithDecoration@POWERDOWN:
    /// shown to everyone who sees the structure, blinking, side by side when both show).
    pub(crate) fn render_building_decorations(&self, player: u8, sink: &mut crate::instances::Sink, base: f32, sprites: &mut Vec<f32>) {
        let frame = self.tick / DECORATION_FRAME_TICKS;
        if frame % 2 == 1 {
            return;
        }
        for (i, a) in self.actors.iter().enumerate() {
            if !a.alive || a.kind != Kind::Building || (!a.repair_active && !a.powered_off) {
                continue;
            }
            if a.owner != player && (!self.is_visible_to(i, player) || self.is_cloaked_from(i, player)) {
                continue;
            }
            let (x, y) = (crate::render::px(a.x), crate::render::px(a.y));
            if !sink.visible([x, y], [x, y], 32.0) {
                continue;
            }
            let wrench = a.repair_active && !a.repairers.is_empty();
            let spread = if wrench && a.powered_off { DECORATION_SPREAD } else { 0.0 };
            if wrench {
                // One repairer per blink cycle (OpenRA CycleRepairer after each animation).
                let who = a.repairers[(frame / 2) as usize % a.repairers.len()];
                let r = crate::instances::SpriteRec::at(x, y, 32.0).look(base + DECORATION_WRENCH, who as f32, 1.0, 1.0, 0.0);
                sink.sprite(sprites, r.offset(-spread, 0.0));
            }
            if a.powered_off {
                let r = crate::instances::SpriteRec::at(x, y, 32.0).look(base + DECORATION_POWER_OFF, a.owner as f32, 1.0, 1.0, 0.0);
                sink.sprite(sprites, r.offset(spread, 0.0));
            }
        }
    }
}

impl World {
    /// Where the repair cursor sends an own damaged unit `i`: the nearest own
    /// structure that repairs it (service depot, naval yard, helipad for
    /// helicopters; OpenRA Repairable(Near).FindRepairBuilding, which prefers
    /// the player's own), as the world point a smart order there targets.
    pub fn repair_depot_for(&self, player: u8, i: usize) -> Option<(i32, i32)> {
        let a = &self.actors[i];
        if !a.alive || !a.in_world() || a.owner != player || !a.is_unit() || a.hp >= self.rules.actors[a.ty as usize].hp {
            return None;
        }
        (0..self.actors.len())
            .filter(|&b| {
                let ba = &self.actors[b];
                ba.alive && ba.owner == player && ba.kind == Kind::Building && (self.repairs_at(i, b) || self.heli_repairs_at(i, b))
            })
            .min_by_key(|&b| (crate::math::dist_sq(a.x, a.y, self.actors[b].x, self.actors[b].y), b))
            .map(|b| (self.actors[b].x, self.actors[b].y))
    }
}

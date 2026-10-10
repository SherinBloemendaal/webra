//! The crew that leaves a sold structure (OpenRA SpawnActorsOnSell on
//! ^Building and ^ScienceBuilding, defaults.yaml).
//!
//! Their worth is ValuePercent of the structure's value, scaled by its
//! health (nothing below MinHpPercent). The guaranteed types come out first
//! (each costs its value), then random types the rest still pays for, one
//! per footprint cell. Types WebRA does not have yet (technicians,
//! engineers, civilians) are left out of the lists (rules_options.rs), so
//! today a sold structure leaves riflemen.

use crate::rules::Kind;
use crate::world::{cell_center, World};

impl World {
    /// Called by `sell` before structure `b` goes.
    pub(crate) fn spawn_sell_survivors(&mut self, b: usize) {
        let a = &self.actors[b];
        let info = &self.rules.actors[a.ty as usize];
        let (Some(s), Some(bi)) = (info.options.sell_survivors.clone(), info.building.as_ref()) else { return };
        // A mission condition can switch SpawnActorsOnSell off (mission/conditions.rs).
        if self.mission.is_some() && self.mission_no_sell_survivors(b) {
            return;
        }
        let owner = a.owner;
        let faction = self.players[owner as usize].faction;
        if !s.factions.is_empty() && !s.factions.contains(&faction) {
            return;
        }
        // OpenRA SpawnActorsOnSell: CustomSellValue, else the cost, scaled by health.
        let mut value = (s.value_percent as i64 * bi.value as i64 / 100) as i32;
        let max = info.hp.max(1) as i64;
        value = if 100 * a.hp as i64 >= s.min_hp_percent as i64 * max { (a.hp as i64 * value as i64 / max) as i32 } else { 0 };
        let mut cells: Vec<(i32, i32)> =
            bi.footprint.iter().filter(|c| c.2 != crate::rules::FootCell::Empty).map(|c| (a.cx + c.0, a.cy + c.1)).collect();
        let cost = |w: &World, t: usize| w.rules.actors[t].cost;
        let mut guaranteed = s.guaranteed.clone();
        while !cells.is_empty() && !guaranteed.is_empty() {
            let t = guaranteed.remove(self.rng.range(0, guaranteed.len() as i32) as usize);
            let (x, y) = cells.remove(self.rng.range(0, cells.len() as i32) as usize);
            value -= cost(self, t);
            self.spawn_survivor(t, owner, x, y);
        }
        loop {
            let affordable: Vec<usize> = s.actor_types.iter().copied().filter(|&t| cost(self, t) <= value).collect();
            if cells.is_empty() || affordable.is_empty() {
                break;
            }
            let t = affordable[self.rng.range(0, affordable.len() as i32) as usize];
            let (x, y) = cells.remove(self.rng.range(0, cells.len() as i32) as usize);
            value -= cost(self, t);
            self.spawn_survivor(t, owner, x, y);
        }
    }

    fn spawn_survivor(&mut self, ty: usize, owner: u8, x: i32, y: i32) {
        let facing = if self.rules.actors[ty].kind == Kind::Infantry { 512 } else { self.rng.range(0, 1024) };
        self.spawn_unit(ty as u16, owner, cell_center(x), cell_center(y), facing);
    }
}

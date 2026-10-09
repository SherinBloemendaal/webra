//! Debug menu: OpenRA's developer mode cheats and read-only debug views.
//!
//! # Cheats (simulation)
//!
//! Cheats change the simulation, so they are orders like any other
//! ([`crate::world::Order::DevFlag`], [`crate::world::Order::DevCash`],
//! [`crate::world::Order::DevKill`]): in multiplayer they travel through
//! lockstep and every peer applies them on the same tick. They only work when
//! the game was started with the lobby option "Debug menu"
//! ([`crate::world::GameOptions::cheats`], options key `cheats`, OpenRA's
//! `cheats` lobby option). Without it the engine ignores them, and the
//! multiplayer server refuses to relay them (apps/server/src/validate.js).
//!
//! Flags are per player, like OpenRA's `DeveloperMode` trait:
//!
//! - `fast_build`: production finishes on the next tick (it still costs money).
//! - `build_anywhere`: structures ignore the build area (adjacency, build radius).
//! - `unlimited_power`: the player never has low power.
//! - `fast_charge`: support powers are ready at once.
//! - `disable_shroud`: the player sees the whole map.
//! - `all_tech`: every prerequisite counts as met.
//!
//! # Debug views (read only)
//!
//! [`World::debug_cells`], [`World::debug_flow`] and [`World::debug_stats`]
//! read state for the overlays of apps/game/js/debug.js. They never change the
//! simulation (the flow field view only peeks into the cache), and they only
//! report what the player may see: explored cells, visible actors.

use crate::flowfield::DIR_NONE;
use crate::rules::{Domain, Kind};
use crate::world::{Activity, World, NONE};

/// Cash one "Give cash" adds (OpenRA `DeveloperMode.Cash`).
pub const DEV_CASH: i32 = 20_000;
/// Give cash never pushes a player's cash above this, so sums stay far from i32 overflow.
pub const DEV_CASH_MAX: i32 = 100_000_000;

/// One per-player cheat flag (order JSON: `"flag": "fast_build"`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DevFlag {
    FastBuild,
    BuildAnywhere,
    UnlimitedPower,
    FastCharge,
    DisableShroud,
    AllTech,
}

impl DevFlag {
    pub const ALL: [DevFlag; 6] = [
        DevFlag::FastBuild,
        DevFlag::BuildAnywhere,
        DevFlag::UnlimitedPower,
        DevFlag::FastCharge,
        DevFlag::DisableShroud,
        DevFlag::AllTech,
    ];

    pub fn name(self) -> &'static str {
        match self {
            DevFlag::FastBuild => "fast_build",
            DevFlag::BuildAnywhere => "build_anywhere",
            DevFlag::UnlimitedPower => "unlimited_power",
            DevFlag::FastCharge => "fast_charge",
            DevFlag::DisableShroud => "disable_shroud",
            DevFlag::AllTech => "all_tech",
        }
    }

    pub fn from_name(s: &str) -> Option<DevFlag> {
        DevFlag::ALL.into_iter().find(|f| f.name() == s)
    }
}

/// Cheat flags of one player. All off unless a `dev_flag` order turned one on.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DevFlags {
    pub fast_build: bool,
    pub build_anywhere: bool,
    pub unlimited_power: bool,
    pub fast_charge: bool,
    pub disable_shroud: bool,
    pub all_tech: bool,
}

impl DevFlags {
    pub fn get(&self, f: DevFlag) -> bool {
        match f {
            DevFlag::FastBuild => self.fast_build,
            DevFlag::BuildAnywhere => self.build_anywhere,
            DevFlag::UnlimitedPower => self.unlimited_power,
            DevFlag::FastCharge => self.fast_charge,
            DevFlag::DisableShroud => self.disable_shroud,
            DevFlag::AllTech => self.all_tech,
        }
    }

    pub fn set(&mut self, f: DevFlag, on: bool) {
        match f {
            DevFlag::FastBuild => self.fast_build = on,
            DevFlag::BuildAnywhere => self.build_anywhere = on,
            DevFlag::UnlimitedPower => self.unlimited_power = on,
            DevFlag::FastCharge => self.fast_charge = on,
            DevFlag::DisableShroud => self.disable_shroud = on,
            DevFlag::AllTech => self.all_tech = on,
        }
    }

    /// The flags as a bit set (state hash, UI).
    pub fn bits(&self) -> u32 {
        let mut bits = 0;
        for (k, &f) in DevFlag::ALL.iter().enumerate() {
            if self.get(f) {
                bits |= 1 << k;
            }
        }
        bits
    }
}

/// Cell flags of [`World::debug_cells`].
pub mod cell {
    /// The player has explored the cell (nothing else is reported otherwise).
    pub const EXPLORED: u8 = 1;
    /// Ground units cannot enter (terrain or a structure).
    pub const BLOCKED: u8 = 2;
    /// Ships can enter.
    pub const WATER: u8 = 4;
    /// Part of a structure's footprint (visible structures and own ones).
    pub const FOOTPRINT: u8 = 8;
    /// A footprint cell units can cross (`_` in OpenRA footprints).
    pub const FOOTPRINT_PASSABLE: u8 = 16;
    /// At least one unit stands in the cell (visible cells only).
    pub const UNITS: u8 = 32;
    /// The cell is visible right now.
    pub const VISIBLE: u8 = 64;
}

impl World {
    /// Whether cheat orders do anything in this game.
    pub fn cheats_enabled(&self) -> bool {
        self.options.cheats
    }

    pub fn dev_flags(&self, player: u8) -> DevFlags {
        self.players.get(player as usize).map_or_else(DevFlags::default, |p| p.dev)
    }

    /// Apply a `dev_flag` order. Ignored unless cheats are enabled.
    pub(crate) fn dev_set_flag(&mut self, player: u8, flag: DevFlag, on: bool) {
        if !self.options.cheats || player as usize >= self.players.len() || self.players[player as usize].neutral {
            return;
        }
        self.players[player as usize].dev.set(flag, on);
        match flag {
            // Power, prerequisites and vision follow at once, not on their next refresh.
            DevFlag::UnlimitedPower => self.update_power(),
            DevFlag::AllTech => self.tokens_dirty = true,
            DevFlag::DisableShroud if on => self.reveal_all(player),
            _ => {}
        }
    }

    /// Apply a `dev_cash` order: OpenRA's "Give cash". Ignored unless cheats are enabled.
    pub(crate) fn dev_give_cash(&mut self, player: u8) {
        if !self.options.cheats || player as usize >= self.players.len() || self.players[player as usize].neutral {
            return;
        }
        let p = &mut self.players[player as usize];
        p.cash = p.cash.saturating_add(DEV_CASH).min(DEV_CASH_MAX.max(p.cash));
    }

    /// Apply a `dev_kill` order: destroy the listed actors, of any owner, like
    /// OpenRA's "Kill" debug order. Passengers inside a transport are skipped
    /// (they die with it). Ignored unless cheats are enabled.
    pub(crate) fn dev_kill(&mut self, player: u8, ids: &[u32]) {
        if !self.options.cheats || player as usize >= self.players.len() || self.players[player as usize].neutral {
            return;
        }
        let mut targets: Vec<usize> = ids.iter().filter_map(|&r| self.resolve(r)).filter(|&i| self.actors[i].in_world()).collect();
        targets.sort_unstable();
        targets.dedup();
        for i in targets {
            if self.actors[i].alive {
                self.kill(i);
            }
        }
    }

    /// Mark every cell visible and explored for `player` (disable shroud).
    pub(crate) fn reveal_all(&mut self, player: u8) {
        let p = &mut self.players[player as usize];
        p.visible.iter_mut().for_each(|v| *v = 1);
        p.explored.iter_mut().for_each(|e| *e = 1);
    }

    /// Vision upkeep for "disable shroud": called at the end of every vision update.
    pub(crate) fn apply_dev_vision(&mut self) {
        for p in 0..self.players.len() {
            if self.players[p].dev.disable_shroud {
                self.reveal_all(p as u8);
            }
        }
    }

    // ---- Debug views (read only) ---------------------------------------------

    /// One byte of [`cell`] flags per cell of the rectangle (cx0, cy0)..=(cx1, cy1),
    /// clamped to the map; row by row. Returns `(x0, y0, width, height, flags)`.
    pub fn debug_cells(&self, player: u8, cx0: i32, cy0: i32, cx1: i32, cy1: i32) -> (i32, i32, i32, i32, Vec<u8>) {
        let (x0, y0) = (cx0.max(0), cy0.max(0));
        let (x1, y1) = (cx1.min(self.map.width - 1), cy1.min(self.map.height - 1));
        if x1 < x0 || y1 < y0 || player as usize >= self.players.len() {
            return (x0, y0, 0, 0, Vec::new());
        }
        let p = &self.players[player as usize];
        let mut out = Vec::with_capacity(((x1 - x0 + 1) * (y1 - y0 + 1)) as usize);
        for y in y0..=y1 {
            for x in x0..=x1 {
                let i = self.map.idx(x, y);
                if p.explored[i] == 0 {
                    out.push(0);
                    continue;
                }
                let visible = p.visible[i] != 0;
                let mut f = cell::EXPLORED;
                if visible {
                    f |= cell::VISIBLE;
                }
                if self.pass.blocked[i] {
                    f |= cell::BLOCKED;
                }
                if !self.pass_water.blocked[i] {
                    f |= cell::WATER;
                }
                let b = self.building_at[i];
                if b != NONE && self.actors[b as usize].alive && (visible || self.actors[b as usize].owner == player) {
                    f |= cell::FOOTPRINT;
                    if !self.pass.blocked[i] {
                        f |= cell::FOOTPRINT_PASSABLE;
                    }
                }
                if visible
                    && self.units_in_cell(i).iter().any(|&u| {
                        let u = u as usize;
                        self.actors[u].alive && !self.is_cloaked_from(u, player)
                    })
                {
                    f |= cell::UNITS;
                }
                out.push(f);
            }
        }
        (x0, y0, x1 - x0 + 1, y1 - y0 + 1, out)
    }

    /// Flow field an own moving unit follows: `(goal cell, x0, y0, width, height,
    /// direction per cell)` for the clamped rectangle, directions as in
    /// [`crate::flowfield::DIRS`] (8: goal, 255: no route or unexplored).
    /// None when the unit is not moving along a cached, current field.
    pub fn debug_flow(&self, player: u8, id: u32, cx0: i32, cy0: i32, cx1: i32, cy1: i32) -> Option<(u32, i32, i32, i32, i32, Vec<u8>)> {
        let i = self.resolve(id)?;
        let a = &self.actors[i];
        if a.owner != player || !a.is_unit() || !a.in_world() || a.goal == NONE || a.activity == Activity::Idle {
            return None;
        }
        let unit = self.rules.actors[a.ty as usize].unit.as_ref()?;
        let domain = self.rules.locomotors[unit.locomotor].domain;
        if domain == Domain::Air {
            return None;
        }
        let pass = self.pass_for(domain);
        let dirs = self.flow.peek(a.goal, unit.locomotor as u8, self.flow_crusher(i), pass.version)?;
        let (x0, y0) = (cx0.max(0), cy0.max(0));
        let (x1, y1) = (cx1.min(self.map.width - 1), cy1.min(self.map.height - 1));
        if x1 < x0 || y1 < y0 {
            return Some((a.goal, x0, y0, 0, 0, Vec::new()));
        }
        let explored = &self.players[player as usize].explored;
        let mut out = Vec::with_capacity(((x1 - x0 + 1) * (y1 - y0 + 1)) as usize);
        for y in y0..=y1 {
            for x in x0..=x1 {
                let c = self.map.idx(x, y);
                out.push(if explored[c] != 0 { dirs[c] } else { DIR_NONE });
            }
        }
        Some((a.goal, x0, y0, x1 - x0 + 1, y1 - y0 + 1, out))
    }

    /// Counters for the performance panel.
    pub fn debug_stats(&self) -> serde_json::Value {
        let alive = self.actors.iter().filter(|a| a.alive);
        let (mut units, mut buildings) = (0, 0);
        for a in alive {
            match a.kind {
                Kind::Building => buildings += 1,
                Kind::Mine => {}
                _ => units += 1,
            }
        }
        serde_json::json!({
            "tick": self.tick,
            "units": units,
            "buildings": buildings,
            "actorSlots": self.actors.len(),
            "projectiles": self.projectiles.len(),
            "effects": self.effects.len(),
            "flowComputed": self.flow.computed,
            "flowCached": self.flow.len(),
            "passVersion": self.pass.version,
        })
    }
}

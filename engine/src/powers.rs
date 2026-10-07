//! Support powers: the shared framework behind the Airfield's air powers
//! (spy plane, paratroopers, parabombs) and the superweapons (Chronosphere,
//! Iron Curtain, nuke, GPS).
//!
//! # Model (OpenRA `SupportPowerManager`)
//!
//! Powers are declared on structures (`ActorInfo::abilities.support_powers`,
//! exported by tools/gen_rules.py from the OpenRA traits). Every player has at
//! most one [`PowerInstance`] per power `key` (the trait name, for example
//! `AirstrikePower@spyplane`), however many structures provide it: two
//! Airfields still give one spy plane timer.
//!
//! An instance exists while the player owns a structure that provides the key
//! and meets the power's `prerequisites` (player tokens). It charges one tick
//! per simulation tick while at least one of those providers is powered
//! ([`World::is_powered_down`]); losing every provider removes the instance and
//! its charge, like OpenRA. Charging starts empty and takes `charge` ticks
//! (`ChargeInterval`).
//!
//! # API
//!
//! - Order: [`crate::world::Order::SupportPower`] `{ player, key, x, y, x2, y2 }`
//!   (world units; `x2`/`y2` is an optional second point, used by directional
//!   powers as the flight direction from (x, y)). The wasm API is
//!   `Game.activate_power(player, key, x, y, x2?, y2?)`.
//! - [`World::activate_support_power`] validates (instance exists, is ready, a
//!   powered provider exists) and dispatches on [`SupportPowerInfo::kind`]
//!   through [`World::fire_support_power`]. A handler returns `true` when the
//!   power fired; only then is the timer restarted.
//! - [`World::power_instances`] lists a player's powers for the UI
//!   (`player_json().powers`: `{ key, kind, name, description, progress, ready }`).
//! - [`World::power_info`] resolves a key to its rules entry.
//! - [`PowersState::reveals`] holds temporary map reveals ("cameras") that
//!   vision.rs applies every vision update; push a [`Reveal`] for any power
//!   that uncovers an area for a while.
//!
//! # Adding a power kind
//!
//! Add a match arm in [`World::fire_support_power`] for the OpenRA trait name
//! (`ChronoshiftPower`, `GrantExternalConditionPower`, `NukePower`,
//! `GpsPower`, ...) that calls your handler (in its own module) and returns
//! whether it fired. Keep handlers deterministic: integer math, no hash maps.
//! Kinds without a handler never fire, so their timer stays full.

use crate::math::{dist_sq, CELL};
use crate::rules::{Kind, SupportPowerInfo};
use crate::world::World;

/// One charging power of one player.
#[derive(Clone, Debug)]
pub struct PowerInstance {
    /// Power key (OpenRA trait name with its @suffix).
    pub key: String,
    /// A structure type that provides it and the index into its
    /// `support_powers`, to look the rules up again ([`World::power_info`]).
    pub provider_ty: u16,
    pub index: usize,
    /// Ticks still needed until ready.
    pub remaining: i32,
    /// Full charge time (ChargeInterval).
    pub total: i32,
    /// Charging this tick (a provider is powered).
    pub charging: bool,
}

impl PowerInstance {
    pub fn ready(&self) -> bool {
        self.remaining <= 0
    }

    /// Charge progress in 0..=1000 (integer, for determinism-safe callers).
    pub fn progress_permille(&self) -> i32 {
        if self.total <= 0 {
            return 1000;
        }
        ((self.total - self.remaining) as i64 * 1000 / self.total as i64) as i32
    }
}

/// A temporary reveal of the map for one player (support power cameras).
#[derive(Clone, Debug)]
pub struct Reveal {
    pub player: u8,
    pub x: i32,
    pub y: i32,
    /// Radius in world units.
    pub range: i32,
    /// Last tick the reveal is active.
    pub until: u32,
}

/// A bomb falling from an aircraft (GravityBomb). It lands, and its weapon
/// detonates, when `altitude` reaches 0.
#[derive(Clone, Debug)]
pub struct FallingBomb {
    pub x: i32,
    pub y: i32,
    pub altitude: i32,
    /// Fall speed per tick.
    pub speed: i32,
    pub weapon: u16,
    pub owner: u8,
}

#[derive(Default)]
pub struct PowersState {
    /// Power instances per player, sorted by palette order, then key.
    pub players: Vec<Vec<PowerInstance>>,
    pub reveals: Vec<Reveal>,
    pub bombs: Vec<FallingBomb>,
}

impl World {
    /// Rules entry of a power instance.
    pub fn power_info(&self, inst: &PowerInstance) -> &SupportPowerInfo {
        &self.rules.actors[inst.provider_ty as usize].abilities.support_powers.as_ref().expect("provider has powers")[inst.index]
    }

    /// The player's power instances (empty when none).
    pub fn power_instances(&self, player: u8) -> &[PowerInstance] {
        self.powers.players.get(player as usize).map_or(&[], |v| v.as_slice())
    }

    /// Whether `player` meets the prerequisites of a power.
    fn power_prereqs_met(&self, player: u8, info: &SupportPowerInfo) -> bool {
        let tokens = &self.players[player as usize].tokens;
        info.prerequisites.iter().all(|p| self.rules.token(p).is_some_and(|t| tokens[t as usize]))
    }

    /// Per-tick upkeep: charge timers, expiring reveals and falling bombs.
    pub(crate) fn tick_support_powers(&mut self) {
        let n = self.players.len();
        self.powers.players.resize_with(n, Vec::new);
        // One pass over the structures: which keys each player has, and whether
        // any provider of that key is powered. (player, key, provider_ty, index, powered)
        let mut offered: Vec<(u8, String, u16, usize, bool)> = Vec::new();
        for i in 0..self.actors.len() {
            let a = &self.actors[i];
            if !a.alive || a.kind != Kind::Building {
                continue;
            }
            let Some(list) = self.rules.actors[a.ty as usize].abilities.support_powers.as_ref() else { continue };
            let powered = !self.is_powered_down(i);
            for (k, info) in list.iter().enumerate() {
                if !self.power_prereqs_met(a.owner, info) {
                    continue;
                }
                match offered.iter_mut().find(|o| o.0 == a.owner && o.1 == info.key) {
                    Some(o) => o.4 |= powered,
                    None => offered.push((a.owner, info.key.clone(), a.ty, k, powered)),
                }
            }
        }
        for p in 0..n {
            let defeated = self.players[p].defeated;
            let mine: Vec<&(u8, String, u16, usize, bool)> = offered.iter().filter(|o| o.0 as usize == p).collect();
            let list = &mut self.powers.players[p];
            list.retain(|inst| mine.iter().any(|o| o.1 == inst.key));
            for o in &mine {
                if !list.iter().any(|inst| inst.key == o.1) {
                    let total = self.rules.actors[o.2 as usize].abilities.support_powers.as_ref().unwrap()[o.3].charge.max(1);
                    list.push(PowerInstance { key: o.1.clone(), provider_ty: o.2, index: o.3, remaining: total, total, charging: false });
                }
            }
            for inst in list.iter_mut() {
                inst.charging = !defeated && mine.iter().any(|o| o.1 == inst.key && o.4);
                if inst.charging && inst.remaining > 0 {
                    inst.remaining -= 1;
                }
            }
            let rules = &self.rules;
            let order = |inst: &PowerInstance| {
                rules.actors[inst.provider_ty as usize].abilities.support_powers.as_ref().unwrap()[inst.index].palette_order
            };
            list.sort_by(|a, b| order(a).cmp(&order(b)).then_with(|| a.key.cmp(&b.key)));
        }
        let tick = self.tick;
        self.powers.reveals.retain(|r| r.until >= tick);
        self.tick_falling_bombs();
    }

    /// Validate and fire a support power. Returns whether it fired.
    pub fn activate_support_power(&mut self, player: u8, key: &str, x: i32, y: i32, dir: Option<(i32, i32)>) -> bool {
        if player as usize >= self.players.len() || self.players[player as usize].defeated {
            return false;
        }
        let Some(pos) = self.power_instances(player).iter().position(|p| p.key == key) else { return false };
        let inst = self.powers.players[player as usize][pos].clone();
        if !inst.ready() || !self.has_powered_provider(player, key) {
            return false;
        }
        let max_x = self.map.width * CELL - 1;
        let max_y = self.map.height * CELL - 1;
        let (x, y) = (x.clamp(0, max_x), y.clamp(0, max_y));
        let info = self.power_info(&inst).clone();
        if !self.fire_support_power(player, &info, x, y, dir) {
            return false;
        }
        let list = &mut self.powers.players[player as usize];
        if let Some(p) = list.iter_mut().find(|p| p.key == key) {
            p.remaining = p.total;
        }
        true
    }

    /// Whether the player owns a powered structure that provides `key` and meets its prerequisites.
    pub fn has_powered_provider(&self, player: u8, key: &str) -> bool {
        (0..self.actors.len()).any(|i| {
            let a = &self.actors[i];
            a.alive
                && a.owner == player
                && a.kind == Kind::Building
                && !self.is_powered_down(i)
                && self.rules.actors[a.ty as usize]
                    .abilities
                    .support_powers
                    .as_ref()
                    .is_some_and(|l| l.iter().any(|p| p.key == key && self.power_prereqs_met(player, p)))
        })
    }

    /// Dispatch on the power kind. Add new kinds here (see the module docs).
    fn fire_support_power(&mut self, player: u8, info: &SupportPowerInfo, x: i32, y: i32, dir: Option<(i32, i32)>) -> bool {
        match info.kind.as_str() {
            // plane.rs: spy plane, parabombs (AirstrikePower) and paratroopers.
            "AirstrikePower" | "ParatroopersPower" => self.launch_air_power(player, info, x, y, dir),
            _ => false,
        }
    }

    /// Add a temporary reveal (camera) for a player.
    pub fn add_reveal(&mut self, player: u8, x: i32, y: i32, range: i32, ticks: i32) {
        if range > 0 && ticks > 0 {
            self.powers.reveals.push(Reveal { player, x, y, range, until: self.tick + ticks as u32 });
        }
    }

    /// Mark cells within `range` of (x, y) visible and explored for `player`.
    pub(crate) fn reveal_circle(&mut self, player: u8, x: i32, y: i32, range: i32) {
        let (cx, cy) = self.cell_of(x, y);
        let r = range / CELL + 1;
        let lim = range as i64 * range as i64;
        let (w, h) = (self.map.width, self.map.height);
        let p = &mut self.players[player as usize];
        for vy in (cy - r).max(0)..=(cy + r).min(h - 1) {
            for vx in (cx - r).max(0)..=(cx + r).min(w - 1) {
                if dist_sq(x, y, vx * CELL + CELL / 2, vy * CELL + CELL / 2) <= lim {
                    let idx = (vy * w + vx) as usize;
                    p.visible[idx] = 1;
                    p.explored[idx] = 1;
                }
            }
        }
    }

    /// Called by vision.rs after the actors' own sight: power cameras and spy planes.
    pub(crate) fn apply_power_reveals(&mut self) {
        let tick = self.tick;
        let reveals: Vec<Reveal> = self.powers.reveals.iter().filter(|r| r.until >= tick).cloned().collect();
        for r in reveals {
            self.reveal_circle(r.player, r.x, r.y, r.range);
        }
        self.apply_spy_plane_reveals();
    }
}

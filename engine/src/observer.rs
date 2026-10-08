//! Observers and replays: per-player statistics (like OpenRA's observer
//! stats), the whole-map spectator view and in-memory snapshots for seeking
//! in replays.
//!
//! The statistics are deterministic (updated by the simulation) but are not
//! part of `World::state_hash`. The spectator view is render only: the
//! `World::render_all` flag is set by `Game::build_render` for the duration
//! of that call and never while the simulation runs.

use crate::rules::Kind;
use crate::world::World;
use crate::Game;
use serde_json::json;
use std::collections::BTreeMap;
use wasm_bindgen::prelude::*;

/// Player index meaning "observer" for `Game::build_render` and `Game::fog_ptr`:
/// the whole map, every actor live.
pub const OBSERVER: u8 = 255;

/// Counters of one player.
#[derive(Clone, Copy, Default, Debug, PartialEq, Eq)]
pub struct PlayerStats {
    /// Enemy (non-allied) units this player's weapons destroyed.
    pub units_killed: u32,
    /// Own units destroyed, by anyone or anything.
    pub units_lost: u32,
    /// Enemy (non-allied) structures this player's weapons destroyed.
    pub buildings_killed: u32,
    /// Own structures destroyed (selling is not a loss).
    pub buildings_lost: u32,
    /// Income from harvesting and supply trucks.
    pub earned: i64,
}

/// World-level observer state (part of `World`).
#[derive(Clone, Default)]
pub struct ObserverStats {
    /// Per player slot; grown on demand.
    pub players: Vec<PlayerStats>,
    /// Owner of the weapon whose damage is being applied right now; kills
    /// in that window are credited to it. None outside weapon damage
    /// (crashes, cheats, abilities that destroy their own unit).
    pub(crate) source: Option<u8>,
    /// Attacker of airborne planes that were shot down and are still falling,
    /// by actor reference; the kill counts when the wreck hits the ground.
    shot_down: BTreeMap<u32, Option<u8>>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum StatClass {
    Unit,
    Building,
}

impl World {
    /// Counters of `player` (zero when nothing happened to it yet).
    pub fn player_stats(&self, player: u8) -> PlayerStats {
        self.observer.players.get(player as usize).copied().unwrap_or_default()
    }

    fn stats_mut(&mut self, player: u8) -> &mut PlayerStats {
        let p = player as usize;
        if self.observer.players.len() <= p {
            self.observer.players.resize(p + 1, PlayerStats::default());
        }
        &mut self.observer.players[p]
    }

    /// Run `f` with kills credited to `owner` (weapon damage, crushing).
    /// Nests: the previous source is restored afterwards.
    pub(crate) fn with_damage_source<R>(&mut self, owner: u8, f: impl FnOnce(&mut World) -> R) -> R {
        let prev = self.observer.source.replace(owner);
        let r = f(self);
        self.observer.source = prev;
        r
    }

    /// Called by `World::kill` when an airborne plane starts to fall: keep the
    /// attacker until the wreck hits the ground and `kill` runs again.
    pub(crate) fn note_shot_down(&mut self, i: usize) {
        let r = self.make_ref(i);
        let source = self.observer.source;
        self.observer.shot_down.insert(r, source);
    }

    /// Called by `World::kill` for every actor that dies (not for `remove`):
    /// a loss for its owner, a kill for a non-allied attacker. Mines are
    /// neither units nor structures here.
    pub(crate) fn record_death(&mut self, i: usize) {
        let r = self.make_ref(i);
        let shot_down = self.observer.shot_down.remove(&r);
        let a = &self.actors[i];
        let class = match a.kind {
            Kind::Mine => return,
            Kind::Building => StatClass::Building,
            _ => StatClass::Unit,
        };
        let owner = a.owner;
        let killer = shot_down.unwrap_or(self.observer.source);
        let lost = self.stats_mut(owner);
        match class {
            StatClass::Unit => lost.units_lost += 1,
            StatClass::Building => lost.buildings_lost += 1,
        }
        let Some(k) = killer else { return };
        if (k as usize) >= self.players.len() || self.are_allies(k, owner) {
            return;
        }
        let kills = self.stats_mut(k);
        match class {
            StatClass::Unit => kills.units_killed += 1,
            StatClass::Building => kills.buildings_killed += 1,
        }
    }

    /// Harvester unloading at a refinery: `give_resources`, counting what was
    /// actually stored as earned.
    pub(crate) fn give_harvested(&mut self, player: u8, amount: i32) {
        let before = self.players[player as usize].resources;
        self.give_resources(player, amount);
        let gained = self.players[player as usize].resources - before;
        self.note_earned(player, gained);
    }

    /// Income for the observer stats (harvesting, supply truck cash).
    pub(crate) fn note_earned(&mut self, player: u8, amount: i32) {
        if amount > 0 {
            self.stats_mut(player).earned += i64::from(amount);
        }
    }

    /// Total cost of the player's alive army: units (also those inside
    /// transports), not structures, mines, harvesters or support aircraft.
    pub fn army_value(&self, player: u8) -> i64 {
        (0..self.actors.len())
            .filter(|&i| {
                let a = &self.actors[i];
                a.alive && a.owner == player && a.is_unit() && a.hp > 0 && !self.is_harvester(i) && !self.is_support_aircraft(i)
            })
            .map(|i| i64::from(self.rules.actors[self.actors[i].ty as usize].cost))
            .sum()
    }

    /// Observer statistics of every non-neutral player, in player order.
    pub fn observer_stats_json(&self) -> serde_json::Value {
        let out: Vec<_> = (0..self.players.len())
            .filter(|&p| !self.players[p].neutral)
            .map(|p| {
                let pl = &self.players[p];
                let s = self.player_stats(p as u8);
                json!({
                    "player": p,
                    "faction": self.rules.factions[pl.faction],
                    "team": pl.team,
                    "cash": pl.cash,
                    "funds": pl.funds(),
                    "earned": s.earned,
                    "armyValue": self.army_value(p as u8),
                    "unitsKilled": s.units_killed,
                    "unitsLost": s.units_lost,
                    "buildingsKilled": s.buildings_killed,
                    "buildingsLost": s.buildings_lost,
                    "powerGenerated": pl.power_gen,
                    "powerUsed": pl.power_use,
                    "defeated": pl.defeated,
                    "won": self.has_won(p as u8),
                })
            })
            .collect();
        serde_json::Value::Array(out)
    }

    // ---- Spectator view (render only) ------------------------------------------------

    /// Render paths: whether `player` sees cell `ci` (always in the spectator view).
    #[inline]
    pub(crate) fn render_sees_cell(&self, player: u8, ci: usize) -> bool {
        self.render_all || self.players[player as usize].visible[ci] != 0
    }

    /// Render paths: owner-only decorations (rally points, move goals, ammo
    /// pips); never shown in the spectator view.
    #[inline]
    pub(crate) fn render_owns(&self, owner: u8, player: u8) -> bool {
        !self.render_all && owner == player
    }

    /// Render paths: decorations for the owner and allies (mines, cloak
    /// shimmer, nuke beacons, cargo pips); all shown in the spectator view.
    #[inline]
    pub(crate) fn render_allied(&self, owner: u8, player: u8) -> bool {
        self.render_all || self.are_allies(owner, player)
    }

    /// Fog bytes of the spectator view: every cell visible.
    pub fn observer_fog_bytes(&self, out: &mut Vec<u8>) {
        out.clear();
        out.resize(self.map.cells(), 255);
    }
}

#[wasm_bindgen]
impl Game {
    /// Player index of the observer (spectators, replays) for `build_render`
    /// and `fog_ptr`: the whole map with every actor live. No other method
    /// takes it.
    pub fn observer_player() -> u8 {
        OBSERVER
    }

    /// Observer statistics as a JSON array, one entry per non-neutral player
    /// in player order: `{ player, faction, team, cash, funds, earned,
    /// armyValue, unitsKilled, unitsLost, buildingsKilled, buildingsLost,
    /// powerGenerated, powerUsed, defeated, won }`.
    pub fn observer_stats(&self) -> String {
        self.world.observer_stats_json().to_string()
    }

    /// In-memory deep copy of the game for replay seeking: the same world,
    /// lockstep flag and selection, empty render buffers, an empty order
    /// outbox and audio log. Not serialized; it lives only as long as the
    /// returned object (free it from JavaScript when done).
    pub fn snapshot(&self) -> Game {
        let mut world = self.world.clone();
        world.render_all = false;
        world.sound.take();
        let mut game = Game::wrap(world);
        game.selection = self.selection.clone();
        game.lockstep = self.lockstep;
        game
    }

    /// Replace this game's world with a copy of `snap`'s (from `snapshot`).
    /// In memory only. Clears the order outbox and pending audio events
    /// (this game's audio setting stays) and marks the terrain dirty so the
    /// client uploads it again. `snap` itself is not changed.
    pub fn restore(&mut self, snap: &Game) {
        let mut sound = std::mem::take(&mut self.world.sound);
        sound.take();
        // Render settings (hover, health bar mode, animation table) belong to this screen, not the snapshot.
        let render_opts = std::mem::take(&mut self.world.render_opts);
        self.world = snap.world.clone();
        self.world.sound = sound;
        self.world.render_opts = render_opts;
        self.world.render_all = false;
        self.world.terrain_dirty = true;
        self.outbox.clear();
    }
}

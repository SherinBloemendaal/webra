//! Observers and replays: per-player statistics (like OpenRA's observer
//! stats), the whole-map spectator view and in-memory snapshots for seeking
//! in replays.
//!
//! The statistics are deterministic (updated by the simulation) but are not
//! part of `World::state_hash`. Besides the running counters the engine keeps
//! a time series per player (`StatsHistory`, one sample every
//! `STATS_SAMPLE_TICKS`), so every peer and every replay of a game shows the
//! same graphs on the end-game statistics screen (`Game::observer_report`). The spectator view is render only: the
//! `World::render_all` flag is set by `Game::build_render` for the duration
//! of that call and never while the simulation runs.

use crate::rules::{Kind, QUEUE_COUNT};
use crate::world::{World, TICKS_PER_SECOND};
use crate::Game;
use serde_json::json;
use std::collections::BTreeMap;
use wasm_bindgen::prelude::*;

/// Player index meaning "observer" for `Game::build_render` and `Game::fog_ptr`:
/// the whole map, every actor live.
pub const OBSERVER: u8 = 255;

/// Ticks between two samples of the statistics history (5 s of game time).
pub const STATS_SAMPLE_TICKS: u32 = 5 * TICKS_PER_SECOND;

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
    /// Ore and gems stored at refineries (part of `earned`).
    pub harvested_ore: i64,
    pub harvested_gems: i64,
    /// Money spent: production (cancelled items refunded) and repairs.
    pub spent: i64,
    /// Of `spent`: repairs at service depots and with the repair button (repair.rs).
    pub repair_spent: i64,
    /// Money back from selling structures.
    pub sold: i64,
    /// Value (cost) of the enemy actors this player destroyed, and of its own actors lost.
    pub assets_destroyed: i64,
    pub assets_lost: i64,
    /// Hit points of damage dealt to non-allied actors, and taken by own actors.
    pub damage_dealt: i64,
    pub damage_taken: i64,
    /// Produced and placed: infantry and vehicles, structures, aircraft, ships.
    pub units_built: u32,
    pub buildings_built: u32,
    pub aircraft_built: u32,
    pub ships_built: u32,
    /// Total cost of everything produced.
    pub built_value: i64,
    /// Experience gained by own actors (veterancy.rs) and rank promotions.
    pub experience: i64,
    pub promotions: u32,
    /// Support powers fired.
    pub powers_used: u32,
    /// Orders given through the order log (players' actions; AI decisions are not orders here).
    pub orders: u32,
    /// Ticks each production queue spent building (paid progress), per `QueueType`.
    pub production_ticks: [u32; QUEUE_COUNT],
}

impl PlayerStats {
    /// Score of the end-game screen: the value destroyed plus half the value built.
    pub fn score(&self) -> i64 {
        self.assets_destroyed + self.built_value / 2
    }
}

/// Per actor type counters of one player (actor type index -> count).
#[derive(Clone, Default, Debug, PartialEq, Eq)]
pub struct PlayerDetail {
    pub built: BTreeMap<u16, u32>,
    /// Enemy actors this player destroyed, by their type.
    pub killed: BTreeMap<u16, u32>,
    /// Own actors lost, by type.
    pub lost: BTreeMap<u16, u32>,
    /// Support powers fired, by power key.
    pub powers: BTreeMap<String, u32>,
}

/// One point of a player's statistics history (saturated to i32).
#[derive(Clone, Copy, Default, Debug, PartialEq, Eq)]
pub struct StatsSample {
    pub funds: i32,
    pub earned: i32,
    pub spent: i32,
    pub army: i32,
    pub kills: i32,
    pub deaths: i32,
    pub destroyed: i32,
    pub lost: i32,
    pub harvested: i32,
    pub power_gen: i32,
    pub power_use: i32,
    pub orders: i32,
    pub damage_dealt: i32,
}

/// The statistics time series: the same ticks for every player.
#[derive(Clone, Debug)]
pub struct StatsHistory {
    /// Ticks between samples (also sampled at tick 1 and when the game ends).
    pub interval: u32,
    pub ticks: Vec<u32>,
    /// Per player slot, aligned with `ticks`.
    pub samples: Vec<Vec<StatsSample>>,
}

impl Default for StatsHistory {
    fn default() -> Self {
        StatsHistory { interval: STATS_SAMPLE_TICKS, ticks: Vec::new(), samples: Vec::new() }
    }
}

/// World-level observer state (part of `World`).
#[derive(Clone, Default)]
pub struct ObserverStats {
    /// Per player slot; grown on demand.
    pub players: Vec<PlayerStats>,
    /// Per player slot, per actor type; grown on demand.
    pub details: Vec<PlayerDetail>,
    /// Time series for the graphs.
    pub history: StatsHistory,
    /// Tick each player was defeated at (per player slot).
    pub defeated_at: Vec<Option<u32>>,
    /// Tick the game ended at (a winner was decided).
    pub end_tick: Option<u32>,
    /// Owner of the weapon whose damage is being applied right now; kills
    /// in that window are credited to it. None outside weapon damage
    /// (crashes, cheats, abilities that destroy their own unit).
    pub(crate) source: Option<u8>,
    /// Attacker of airborne planes that were shot down and are still falling,
    /// by actor reference; the kill counts when the wreck hits the ground.
    shot_down: BTreeMap<u32, Option<u8>>,
}

fn sat(v: i64) -> i32 {
    v.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32
}

fn count_map(m: &BTreeMap<u16, u32>, w: &World) -> serde_json::Value {
    let out: serde_json::Map<String, serde_json::Value> =
        m.iter().filter_map(|(&t, &n)| w.rules.actors.get(t as usize).map(|a| (a.id.clone(), json!(n)))).collect();
    serde_json::Value::Object(out)
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

    fn detail_mut(&mut self, player: u8) -> &mut PlayerDetail {
        let p = player as usize;
        if self.observer.details.len() <= p {
            self.observer.details.resize(p + 1, PlayerDetail::default());
        }
        &mut self.observer.details[p]
    }

    /// Per type counters of `player` (empty when nothing happened to it yet).
    pub fn player_detail(&self, player: u8) -> PlayerDetail {
        self.observer.details.get(player as usize).cloned().unwrap_or_default()
    }

    /// Production paid `amount` for one tick of progress in queue `qi`.
    pub(crate) fn note_production(&mut self, player: u8, qi: usize, amount: i32) {
        let s = self.stats_mut(player);
        s.spent += i64::from(amount.max(0));
        if let Some(t) = s.production_ticks.get_mut(qi) {
            *t += 1;
        }
    }

    /// A queued item was cancelled (or became unbuildable) and `paid` refunded.
    pub(crate) fn note_production_refund(&mut self, player: u8, paid: i32) {
        self.stats_mut(player).spent -= i64::from(paid.max(0));
    }

    /// A repair step cost `price`.
    pub(crate) fn note_repair(&mut self, player: u8, price: i32) {
        let s = self.stats_mut(player);
        s.spent += i64::from(price.max(0));
        s.repair_spent += i64::from(price.max(0));
    }

    /// Selling a structure gave `refund` back.
    pub(crate) fn note_sold(&mut self, player: u8, refund: i32) {
        self.stats_mut(player).sold += i64::from(refund.max(0));
    }

    /// A unit left its factory or a structure was placed.
    pub(crate) fn note_built(&mut self, player: u8, ty: u16) {
        let Some(info) = self.rules.actors.get(ty as usize) else { return };
        let (kind, cost) = (info.kind, i64::from(info.cost));
        let s = self.stats_mut(player);
        match kind {
            Kind::Building => s.buildings_built += 1,
            Kind::Aircraft => s.aircraft_built += 1,
            Kind::Ship => s.ships_built += 1,
            Kind::Infantry | Kind::Vehicle => s.units_built += 1,
            Kind::Mine | Kind::Husk | Kind::Crate | Kind::Proxy => return,
        }
        s.built_value += cost;
        *self.detail_mut(player).built.entry(ty).or_insert(0) += 1;
    }

    /// `amount` hit points of damage to actor `i` (its owner takes it; the
    /// current damage source deals it unless allied).
    pub(crate) fn note_damage(&mut self, i: usize, amount: i32) {
        if amount <= 0 {
            return;
        }
        let owner = self.actors[i].owner;
        self.stats_mut(owner).damage_taken += i64::from(amount);
        if let Some(k) = self.observer.source {
            if (k as usize) < self.players.len() && !self.are_allies(k, owner) {
                self.stats_mut(k).damage_dealt += i64::from(amount);
            }
        }
    }

    /// Actor `i` gained `xp` experience and `ranks` levels.
    pub(crate) fn note_experience(&mut self, i: usize, xp: i64, ranks: u32) {
        let owner = self.actors[i].owner;
        let s = self.stats_mut(owner);
        s.experience += xp.max(0);
        s.promotions += ranks;
    }

    /// A support power was fired.
    pub(crate) fn note_power(&mut self, player: u8, key: &str) {
        self.stats_mut(player).powers_used += 1;
        *self.detail_mut(player).powers.entry(key.to_string()).or_insert(0) += 1;
    }

    /// An order from the order log was accepted for `player`.
    pub(crate) fn note_order(&mut self, player: u8) {
        self.stats_mut(player).orders += 1;
    }

    /// `check_victory`: `player` was defeated now.
    pub(crate) fn note_defeated(&mut self, player: u8) {
        let p = player as usize;
        if self.observer.defeated_at.len() <= p {
            self.observer.defeated_at.resize(p + 1, None);
        }
        if self.observer.defeated_at[p].is_none() {
            self.observer.defeated_at[p] = Some(self.tick);
        }
    }

    /// `check_victory`: the game was decided now.
    pub(crate) fn note_game_end(&mut self) {
        if self.observer.end_tick.is_none() {
            self.observer.end_tick = Some(self.tick);
        }
    }

    /// Tick `player` was defeated at, if it was.
    pub fn defeated_at(&self, player: u8) -> Option<u32> {
        self.observer.defeated_at.get(player as usize).copied().flatten()
    }

    /// End of `World::step`: a history sample on tick 1, every `interval`
    /// ticks and on the tick the game ended. Reads the world only.
    pub(crate) fn sample_stats(&mut self) {
        if self.stress {
            return;
        }
        let interval = self.observer.history.interval.max(1);
        let tick = self.tick;
        if !(tick == 1 || tick.is_multiple_of(interval) || self.observer.end_tick == Some(tick)) {
            return;
        }
        if self.observer.history.ticks.last() == Some(&tick) {
            return;
        }
        let n = self.players.len();
        let mut army = vec![0i64; n];
        for i in 0..self.actors.len() {
            let a = &self.actors[i];
            if a.alive && (a.owner as usize) < n && a.is_unit() && a.hp > 0 && !self.is_harvester(i) && !self.is_support_aircraft(i) {
                army[a.owner as usize] += i64::from(self.rules.actors[a.ty as usize].cost);
            }
        }
        let samples: Vec<StatsSample> = (0..n)
            .map(|p| {
                let s = self.player_stats(p as u8);
                let pl = &self.players[p];
                StatsSample {
                    funds: pl.funds(),
                    earned: sat(s.earned),
                    spent: sat(s.spent),
                    army: sat(army[p]),
                    kills: sat(i64::from(s.units_killed) + i64::from(s.buildings_killed)),
                    deaths: sat(i64::from(s.units_lost) + i64::from(s.buildings_lost)),
                    destroyed: sat(s.assets_destroyed),
                    lost: sat(s.assets_lost),
                    harvested: sat(s.harvested_ore + s.harvested_gems),
                    power_gen: pl.power_gen,
                    power_use: pl.power_use,
                    orders: sat(i64::from(s.orders)),
                    damage_dealt: sat(s.damage_dealt),
                }
            })
            .collect();
        let h = &mut self.observer.history;
        if h.samples.len() < n {
            // Players joined the history late (never in a running game): pad with zeros.
            let len = h.ticks.len();
            h.samples.resize(n, vec![StatsSample::default(); len]);
        }
        h.ticks.push(tick);
        for (p, s) in samples.into_iter().enumerate() {
            h.samples[p].push(s);
        }
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
            Kind::Mine | Kind::Husk | Kind::Crate => return,
            Kind::Building => StatClass::Building,
            _ => StatClass::Unit,
        };
        let owner = a.owner;
        let ty = a.ty;
        let value = i64::from(self.rules.actors[ty as usize].cost);
        let killer = shot_down.unwrap_or(self.observer.source);
        let lost = self.stats_mut(owner);
        match class {
            StatClass::Unit => lost.units_lost += 1,
            StatClass::Building => lost.buildings_lost += 1,
        }
        lost.assets_lost += value;
        *self.detail_mut(owner).lost.entry(ty).or_insert(0) += 1;
        let Some(k) = killer else { return };
        if (k as usize) >= self.players.len() || self.are_allies(k, owner) {
            return;
        }
        let kills = self.stats_mut(k);
        match class {
            StatClass::Unit => kills.units_killed += 1,
            StatClass::Building => kills.buildings_killed += 1,
        }
        kills.assets_destroyed += value;
        *self.detail_mut(k).killed.entry(ty).or_insert(0) += 1;
    }

    /// Harvester unloading at a refinery: `give_resources`, counting what was
    /// actually stored as earned.
    pub(crate) fn give_harvested(&mut self, player: u8, amount: i32, gem: bool) {
        let before = self.players[player as usize].resources;
        self.give_resources(player, amount);
        let gained = self.players[player as usize].resources - before;
        self.note_earned(player, gained);
        if gained > 0 {
            let s = self.stats_mut(player);
            if gem {
                s.harvested_gems += i64::from(gained);
            } else {
                s.harvested_ore += i64::from(gained);
            }
        }
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

    /// The Combat panel's Vision column (OpenRA ObserverStatsLogic.Vision of
    /// Shroud.RevealedCells): the percentage of the map's cells the player
    /// sees now, rounded up (with the fog of war off `visible` holds every
    /// explored cell, vision.rs, like OpenRA's count without fog). 0 once
    /// defeated, like RevealedCells of a lost player. Read only, a plain
    /// count of the fog bytes: nothing in the state hash.
    pub fn vision_percent(&self, player: u8) -> u32 {
        let Some(p) = self.players.get(player as usize) else { return 0 };
        let cells = self.map.cells();
        if p.defeated || cells == 0 {
            return 0;
        }
        let seen = p.visible.iter().filter(|&&v| v != 0).count();
        seen.saturating_mul(100).div_ceil(cells) as u32
    }

    /// The Economy panel's Derricks column (OpenRA ActorsHavingTrait
    /// UpdatesDerrickCount): the player's oil derricks.
    pub fn derrick_count(&self, player: u8) -> u32 {
        self.actors.iter().filter(|a| a.alive && a.owner == player && a.hp > 0 && self.rules.actors[a.ty as usize].world.derrick).count()
            as u32
    }

    /// The observer's army panel (OpenRA PlayerStatistics.Units shown by
    /// ObserverArmyIcons): `(actor type, count)` of the units that count for
    /// the army value, each under the type UpdatesPlayerStatistics.OverrideActor
    /// names (E1R1 as E1), only types with a build icon (Buildable: never
    /// `~disabled`), ordered by production tab (ProductionQueue DisplayOrder,
    /// the QueueType order) and then BuildPaletteOrder.
    pub fn army_counts(&self, player: u8) -> Vec<(u16, u32)> {
        let mut counts: BTreeMap<u16, u32> = BTreeMap::new();
        for (i, a) in self.actors.iter().enumerate() {
            if !(a.alive && a.owner == player && a.is_unit() && a.hp > 0) || self.is_harvester(i) || self.is_support_aircraft(i) {
                continue;
            }
            let info = &self.rules.actors[a.ty as usize];
            let ty = info.world.stats_actor.as_deref().and_then(|id| self.rules.actor_index(id)).map_or(a.ty, |t| t as u16);
            *counts.entry(ty).or_insert(0) += 1;
        }
        let mut list: Vec<(u16, u32)> = counts.into_iter().filter(|&(t, _)| self.has_build_icon(t)).collect();
        list.sort_by_key(|&(t, _)| {
            let info = &self.rules.actors[t as usize];
            (info.queue as usize, info.palette_order, t)
        });
        list
    }

    /// Whether a type can be built at all (OpenRA Buildable): its icon shows in the observer panels.
    fn has_build_icon(&self, ty: u16) -> bool {
        !self.rules.actors[ty as usize].prerequisites.iter().any(|pr| self.rules.tokens[pr.token as usize] == crate::rules::TOKEN_DISABLED)
    }

    /// The observer's production and support power icons of one player
    /// (OpenRA ObserverProductionIcons, ObserverSupportPowerIcons): see
    /// `Game::observer_production`.
    pub fn observer_production_json(&self, player: u8) -> serde_json::Value {
        let Some(pl) = self.players.get(player as usize) else { return serde_json::Value::Null };
        let factories = self.factories(player);
        // ProductionItem.RemainingTimeActual: low power stretches the time left by LowPowerModifier.
        let modifier = if pl.low_power() && !pl.dev.fast_build { self.rules.player.low_power_modifier } else { 100 };
        let queues: Vec<_> = pl
            .queues
            .iter()
            .enumerate()
            .filter_map(|(qi, q)| {
                let it = q.items.first()?;
                let build = self.build_time_with(player, it.ty, self.producer_count_in(&factories, it.ty));
                // Not started yet: the whole build time is still ahead.
                let (total, remaining) = if it.total > 0 { (it.total, it.remaining.max(0)) } else { (build, build) };
                Some(json!({
                    "queue": qi,
                    "id": self.rules.actors[it.ty as usize].id,
                    "progress": if total > 0 { (total - remaining) as f32 / total as f32 } else { 0.0 },
                    "done": it.done,
                    "paused": it.paused,
                    "remainingTicks": if it.done { 0 } else { i64::from(remaining) * i64::from(modifier) / 100 },
                    "buildTicks": build,
                }))
            })
            .collect();
        let powers: Vec<_> = self
            .power_instances(player)
            .iter()
            .map(|inst| {
                let info = self.power_info(inst);
                json!({
                    "key": inst.key,
                    "icon": info.icon,
                    "name": info.name,
                    "description": info.description,
                    "progress": (inst.total - inst.remaining) as f32 / inst.total.max(1) as f32,
                    // OpenRA SupportPowerInstance.Ready: charged and Active (a powered provider; powers.rs fires only then).
                    "ready": inst.ready() && inst.charging,
                    "charging": inst.charging,
                    "remainingTicks": inst.remaining.max(0),
                    "totalTicks": inst.total,
                })
            })
            .collect();
        json!({
            "funds": pl.funds(),
            "powerGenerated": pl.power_gen,
            "powerUsed": pl.power_use,
            "lowPower": pl.low_power(),
            "queues": queues,
            "powers": powers,
        })
    }

    /// Observer statistics of one player (the counters, no per type tables).
    fn player_stats_json(&self, p: usize) -> serde_json::Value {
        let pl = &self.players[p];
        let s = self.player_stats(p as u8);
        json!({
            "player": p,
            "faction": self.rules.factions[pl.faction],
            "team": pl.team,
            "isAi": pl.is_ai,
            "cash": pl.cash,
            "funds": pl.funds(),
            "earned": s.earned,
            "harvestedOre": s.harvested_ore,
            "harvestedGems": s.harvested_gems,
            "spent": s.spent,
            "repairSpent": s.repair_spent,
            "sold": s.sold,
            "armyValue": self.army_value(p as u8),
            "unitsKilled": s.units_killed,
            "unitsLost": s.units_lost,
            "buildingsKilled": s.buildings_killed,
            "buildingsLost": s.buildings_lost,
            "assetsDestroyed": s.assets_destroyed,
            "assetsLost": s.assets_lost,
            "damageDealt": s.damage_dealt,
            "damageTaken": s.damage_taken,
            "unitsBuilt": s.units_built,
            "buildingsBuilt": s.buildings_built,
            "aircraftBuilt": s.aircraft_built,
            "shipsBuilt": s.ships_built,
            "builtValue": s.built_value,
            "experience": s.experience,
            "promotions": s.promotions,
            "powersUsed": s.powers_used,
            "orders": s.orders,
            "score": s.score(),
            "powerGenerated": pl.power_gen,
            "powerUsed": pl.power_use,
            "vision": self.vision_percent(p as u8),
            "derricks": self.derrick_count(p as u8),
            "defeated": pl.defeated,
            "defeatedAt": self.defeated_at(p as u8),
            "won": self.has_won(p as u8),
        })
    }

    /// Observer statistics of every non-neutral player, in player order.
    pub fn observer_stats_json(&self) -> serde_json::Value {
        let out: Vec<_> = (0..self.players.len()).filter(|&p| !self.players[p].neutral).map(|p| self.player_stats_json(p)).collect();
        serde_json::Value::Array(out)
    }

    /// The end-game statistics: every counter, the per type tables, the
    /// current army and structures, and the history (see `Game::observer_report`).
    pub fn observer_report_json(&self) -> serde_json::Value {
        let playing: Vec<usize> = (0..self.players.len()).filter(|&p| !self.players[p].neutral).collect();
        let players: Vec<_> = playing
            .iter()
            .map(|&p| {
                let mut v = self.player_stats_json(p);
                let s = self.player_stats(p as u8);
                let d = self.player_detail(p as u8);
                let mut units = BTreeMap::new();
                let mut structures = BTreeMap::new();
                for a in &self.actors {
                    if !a.alive || a.owner as usize != p || a.hp <= 0 {
                        continue;
                    }
                    match a.kind {
                        Kind::Building => *structures.entry(a.ty).or_insert(0u32) += 1,
                        Kind::Mine => {}
                        _ => *units.entry(a.ty).or_insert(0u32) += 1,
                    }
                }
                let o = v.as_object_mut().expect("object");
                o.insert("productionTicks".into(), json!(s.production_ticks));
                o.insert("built".into(), count_map(&d.built, self));
                o.insert("killed".into(), count_map(&d.killed, self));
                o.insert("lost".into(), count_map(&d.lost, self));
                o.insert("units".into(), count_map(&units, self));
                o.insert("structures".into(), count_map(&structures, self));
                o.insert("powers".into(), json!(d.powers));
                v
            })
            .collect();
        let h = &self.observer.history;
        let series: Vec<_> = playing
            .iter()
            .map(|&p| {
                let empty = Vec::new();
                let list = h.samples.get(p).unwrap_or(&empty);
                let col = |f: fn(&StatsSample) -> i32| list.iter().map(f).collect::<Vec<i32>>();
                json!({
                    "player": p,
                    "funds": col(|s| s.funds),
                    "earned": col(|s| s.earned),
                    "spent": col(|s| s.spent),
                    "armyValue": col(|s| s.army),
                    "kills": col(|s| s.kills),
                    "deaths": col(|s| s.deaths),
                    "assetsDestroyed": col(|s| s.destroyed),
                    "assetsLost": col(|s| s.lost),
                    "harvested": col(|s| s.harvested),
                    "powerGenerated": col(|s| s.power_gen),
                    "powerUsed": col(|s| s.power_use),
                    "orders": col(|s| s.orders),
                    "damageDealt": col(|s| s.damage_dealt),
                })
            })
            .collect();
        json!({
            "tick": self.tick,
            "ticksPerSecond": TICKS_PER_SECOND,
            "winner": self.winner,
            "endTick": self.observer.end_tick,
            "players": players,
            "history": { "interval": h.interval, "ticks": h.ticks, "players": series },
        })
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
        !self.render_all && !self.render_combined && owner == player
    }

    /// Render paths: decorations for the owner and allies (mines, cloak
    /// shimmer, nuke beacons, cargo pips); all shown in the spectator view.
    #[inline]
    pub(crate) fn render_allied(&self, owner: u8, player: u8) -> bool {
        self.render_all || self.render_combined || self.are_allies(owner, player)
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
    /// powerGenerated, powerUsed, vision (percent of the map seen now),
    /// derricks (oil derricks owned), defeated, won }`.
    pub fn observer_stats(&self) -> String {
        self.world.observer_stats_json().to_string()
    }

    /// The end-game statistics as JSON (deterministic: the same on every
    /// peer and in replays; not part of the state hash): `{ tick,
    /// ticksPerSecond, winner, endTick, players: [observer_stats fields plus
    /// productionTicks (per queue), built, killed, lost, units, structures
    /// (actor id -> count) and powers (power key -> times fired)], history: {
    /// interval, ticks, players: [{ player, funds, earned, spent, armyValue,
    /// kills, deaths, assetsDestroyed, assetsLost, harvested, powerGenerated,
    /// powerUsed, orders, damageDealt }] } }`; every history array is aligned
    /// with `history.ticks`.
    pub fn observer_report(&self) -> String {
        self.world.observer_report_json().to_string()
    }

    /// One player's production and support powers for the observer's icon
    /// panels (OpenRA ObserverProductionIcons and ObserverSupportPowerIcons),
    /// small enough to ask for every player each UI update: `{ funds,
    /// powerGenerated, powerUsed, lowPower, queues: [{ queue, id, progress,
    /// done, paused, remainingTicks (ProductionItem.RemainingTimeActual: with
    /// the low power slowdown), buildTicks }] (each production tab's current
    /// item, in tab order), powers: [{ key, icon, name, description,
    /// progress, ready, charging, remainingTicks, totalTicks }] (palette
    /// order) }`; null for an unknown player. Read only, not hashed.
    pub fn observer_production(&self, player: u8) -> String {
        self.world.observer_production_json(player).to_string()
    }

    /// Whether `player` is out of the game (false for unknown players). Its
    /// orders are refused from then on.
    pub fn player_defeated(&self, player: u8) -> bool {
        self.world.players.get(player as usize).is_some_and(|p| p.defeated)
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

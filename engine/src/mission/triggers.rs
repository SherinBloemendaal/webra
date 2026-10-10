//! The callbacks scripts attach with `Trigger.*` (OpenRA ScriptTriggers and
//! TriggerGlobal). Kept in sorted maps so they fire in the same order on
//! every machine: per actor and trigger in registration order.

use crate::lua::Value;
use std::collections::{BTreeMap, BTreeSet};

/// Per-actor triggers (OpenRA's `Trigger` enum, the ones on actors).
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum ActorTrigger {
    OnIdle,
    OnDamaged,
    OnKilled,
    OnProduction,
    OnCapture,
    OnInfiltrated,
    OnAddedToWorld,
    OnRemovedFromWorld,
    OnDiscovered,
    OnPassengerEntered,
    OnPassengerExited,
    OnSold,
    OnSupportPowerActivated,
}

impl PlayerTrigger {
    pub fn parse(name: &str) -> Option<PlayerTrigger> {
        use PlayerTrigger::*;
        Some(match name {
            "OnPlayerWon" => OnPlayerWon,
            "OnPlayerLost" => OnPlayerLost,
            "OnObjectiveAdded" => OnObjectiveAdded,
            "OnObjectiveCompleted" => OnObjectiveCompleted,
            "OnObjectiveFailed" => OnObjectiveFailed,
            "OnBuildingPlaced" => OnBuildingPlaced,
            "OnPlayerDiscovered" => OnPlayerDiscovered,
            _ => return None,
        })
    }
}

impl ActorTrigger {
    pub fn parse(name: &str) -> Option<ActorTrigger> {
        use ActorTrigger::*;
        Some(match name {
            "OnIdle" => OnIdle,
            "OnDamaged" => OnDamaged,
            "OnKilled" => OnKilled,
            "OnProduction" => OnProduction,
            "OnCapture" => OnCapture,
            "OnInfiltrated" => OnInfiltrated,
            "OnAddedToWorld" => OnAddedToWorld,
            "OnRemovedFromWorld" => OnRemovedFromWorld,
            "OnDiscovered" => OnDiscovered,
            "OnPassengerEntered" => OnPassengerEntered,
            "OnPassengerExited" => OnPassengerExited,
            "OnSold" => OnSold,
            "OnSupportPowerActivated" => OnSupportPowerActivated,
            _ => return None,
        })
    }
}

/// Triggers on players.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum PlayerTrigger {
    OnPlayerWon,
    OnPlayerLost,
    OnObjectiveAdded,
    OnObjectiveCompleted,
    OnObjectiveFailed,
    OnBuildingPlaced,
    OnPlayerDiscovered,
}

/// What a group trigger waits for.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum GroupKind {
    /// OnAllKilled: every member killed (then once).
    AllKilled,
    /// OnAnyKilled: the first member killed (once).
    AnyKilled,
    /// OnAllRemovedFromWorld: every member out of the world (again when
    /// members came back and left again).
    AllRemoved,
    /// OnAllKilledOrCaptured (once).
    AllKilledOrCaptured,
    /// OnKilledOrCaptured of one actor (once).
    KilledOrCaptured,
}

#[derive(Clone, Debug)]
pub struct Group {
    pub kind: GroupKind,
    pub members: Vec<u32>,
    pub remaining: BTreeSet<u32>,
    pub func: Value,
    pub done: bool,
}

/// OnEnteredFootprint / OnExitedFootprint (OpenRA ActorMap cell triggers).
#[derive(Clone, Debug)]
pub struct CellTrigger {
    /// Engine cell indices.
    pub cells: BTreeSet<usize>,
    pub on_enter: Option<Value>,
    pub on_exit: Option<Value>,
    /// Handles of the ground actors on the cells last tick.
    pub inside: BTreeSet<u32>,
}

/// OnEnteredProximityTrigger / OnExitedProximityTrigger.
#[derive(Clone, Debug)]
pub struct ProximityTrigger {
    /// Engine world position.
    pub x: i32,
    pub y: i32,
    pub range: i32,
    pub on_enter: Option<Value>,
    pub on_exit: Option<Value>,
    pub inside: BTreeSet<u32>,
}

#[derive(Clone, Debug, Default)]
pub struct Triggers {
    pub actor: BTreeMap<(u32, ActorTrigger), Vec<Value>>,
    pub player: BTreeMap<(u8, PlayerTrigger), Vec<Value>>,
    pub any_production: Vec<Value>,
    pub timer_expired: Vec<Value>,
    pub groups: Vec<Group>,
    pub cells: BTreeMap<u32, CellTrigger>,
    pub proximity: BTreeMap<u32, ProximityTrigger>,
    pub next_id: u32,
}

impl Triggers {
    pub fn add_actor(&mut self, h: u32, t: ActorTrigger, f: Value) {
        self.actor.entry((h, t)).or_default().push(f);
    }

    pub fn actor_callbacks(&self, h: u32, t: ActorTrigger) -> Vec<Value> {
        self.actor.get(&(h, t)).cloned().unwrap_or_default()
    }

    pub fn has(&self, h: u32, t: ActorTrigger) -> bool {
        self.actor.get(&(h, t)).is_some_and(|v| !v.is_empty())
    }

    pub fn add_player(&mut self, p: u8, t: PlayerTrigger, f: Value) {
        self.player.entry((p, t)).or_default().push(f);
    }

    pub fn player_callbacks(&self, p: u8, t: PlayerTrigger) -> Vec<Value> {
        self.player.get(&(p, t)).cloned().unwrap_or_default()
    }

    /// Trigger.Clear: drop one kind of trigger of an actor.
    pub fn clear(&mut self, h: u32, t: ActorTrigger) {
        self.actor.remove(&(h, t));
    }

    /// Trigger.ClearAll: every trigger of an actor, also its part in groups.
    pub fn clear_all(&mut self, h: u32) {
        self.actor.retain(|(a, _), _| *a != h);
        for g in &mut self.groups {
            g.remaining.remove(&h);
            g.members.retain(|&m| m != h);
        }
        self.groups.retain(|g| !g.members.is_empty());
    }

    pub fn new_id(&mut self) -> u32 {
        self.next_id += 1;
        self.next_id
    }

    /// Actors whose triggers need watching each tick (idle, discovery).
    pub fn watched(&self, t: ActorTrigger) -> Vec<u32> {
        let mut out: Vec<u32> = self.actor.iter().filter(|((_, k), v)| *k == t && !v.is_empty()).map(|((h, _), _)| *h).collect();
        out.dedup();
        out
    }

    /// Callback count, for the state hash.
    pub fn count(&self) -> usize {
        self.actor.values().map(Vec::len).sum::<usize>()
            + self.player.values().map(Vec::len).sum::<usize>()
            + self.any_production.len()
            + self.timer_expired.len()
            + self.groups.iter().filter(|g| !g.done).count()
            + self.cells.len()
            + self.proximity.len()
    }

    pub fn roots(&self, out: &mut Vec<Value>) {
        out.extend(self.actor.values().flatten().cloned());
        out.extend(self.player.values().flatten().cloned());
        out.extend(self.any_production.iter().cloned());
        out.extend(self.timer_expired.iter().cloned());
        out.extend(self.groups.iter().filter(|g| !g.done).map(|g| g.func.clone()));
        for c in self.cells.values() {
            out.extend(c.on_enter.iter().chain(c.on_exit.iter()).cloned());
        }
        for p in self.proximity.values() {
            out.extend(p.on_enter.iter().chain(p.on_exit.iter()).cloned());
        }
    }
}

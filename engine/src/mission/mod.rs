//! Missions: OpenRA's Lua mission scripts run inside the simulation.
//!
//! A mission (data.rs, made by tools/gen_missions.py from OpenRA's campaign)
//! is a map, its players and actors, rules changes and Lua scripts. The
//! scripts run in the deterministic interpreter of `crate::lua` as part of
//! `World::step`, so a mission is lockstep-safe and replays exactly: the same
//! orders give the same game, scripts included. Saves and replays store the
//! mission and its options plus the orders and re-simulate (docs/contracts.md
//! section 9): the interpreter state never has to be written down.
//!
//! The scripting API is OpenRA's (OpenRA.Mods.Common/Scripting): globals like
//! `Actor`, `Trigger`, `Reinforcements`, `Media`, `Utils`, and properties and
//! methods of actors and players (api.rs). What OpenRA does with activities
//! queued on an actor (`actor.Move(cell)` then `actor.CallFunc(f)`) is a
//! queue of script activities per actor (activities.rs) that drives the
//! engine's own orders. Engine events (kills, damage, captures, production,
//! passengers) reach the triggers (triggers.rs) at the end of the tick they
//! happened in, where OpenRA calls them at once: a callback runs at most one
//! tick later.

pub mod data;

mod activities;
mod actor_api;
mod api;
mod conditions;
mod fluent;
mod player_api;
mod runtime;
pub mod setup;
mod triggers;

pub use data::MissionData;

use crate::lua::{Lua, LuaError, Value};
use crate::math::CELL;
use crate::world::World;
use std::collections::{BTreeMap, BTreeSet};

/// Instruction budget of the scripts in one tick (and of loading them).
pub const TICK_BUDGET: i64 = 20_000_000;
pub const LOAD_BUDGET: i64 = 50_000_000;

// Host object kinds (`lua::UserData::kind`).
pub(crate) const UD_ACTOR: u8 = 1;
pub(crate) const UD_PLAYER: u8 = 2;
pub(crate) const UD_CPOS: u8 = 3;
pub(crate) const UD_WPOS: u8 = 4;
pub(crate) const UD_CVEC: u8 = 5;
pub(crate) const UD_WVEC: u8 = 6;
pub(crate) const UD_WDIST: u8 = 7;
pub(crate) const UD_ANGLE: u8 = 8;
pub(crate) const UD_COLOR: u8 = 9;
/// An API global (`Camera`, `DateTime`, ...): `a` is its `api::Global`.
pub(crate) const UD_GLOBAL: u8 = 10;

/// What happened to an actor, for the triggers. Pushed by the engine while
/// a mission runs (`World::script_event`), handled at the end of the tick.
#[derive(Clone, Debug)]
pub enum ScriptEvent {
    Damaged {
        victim: u32,
        attacker: u32,
        damage: i32,
    },
    /// An actor died (before it is cleaned up): its last position and who killed it.
    Killed {
        victim: u32,
        killer: u32,
        snap: Snapshot,
    },
    /// An actor left the world for good without dying (sold, transformed, removed).
    Removed {
        actor: u32,
        snap: Snapshot,
    },
    Captured {
        actor: u32,
        captor: u32,
        old: u8,
        new: u8,
    },
    Infiltrated {
        target: u32,
        infiltrator: u32,
    },
    Sold {
        actor: u32,
    },
    Produced {
        producer: u32,
        unit: u32,
    },
    Placed {
        player: u8,
        building: u32,
    },
    PassengerEntered {
        transport: u32,
        passenger: u32,
    },
    PassengerExited {
        transport: u32,
        passenger: u32,
    },
}

/// Where an actor was when it left the world (dead actors keep answering
/// `Location`, `CenterPosition`, `Type` and `Owner`, like OpenRA's).
#[derive(Clone, Copy, Debug)]
pub struct Snapshot {
    pub ty: u16,
    pub owner: u8,
    pub x: i32,
    pub y: i32,
    pub altitude: i32,
    pub facing: i32,
}

impl Snapshot {
    pub fn of(w: &World, i: usize) -> Snapshot {
        let a = &w.actors[i];
        Snapshot { ty: a.ty, owner: a.owner, x: a.x, y: a.y, altitude: a.altitude, facing: a.facing }
    }
}

/// An actor as scripts know it. Handles never change meaning: a dead actor's
/// handle stays dead even when the engine reuses its slot.
#[derive(Clone, Debug)]
pub(crate) struct Handle {
    /// Rules actor id (engine actors), or the prop or marker type.
    pub ty: String,
    pub owner: u8,
    pub state: HState,
    pub tags: Vec<String>,
}

#[derive(Clone, Debug)]
pub(crate) enum HState {
    /// Created but not in the world yet (`Actor.Create(type, false, ...)`, a
    /// reinforcement waiting for its turn, a power proxy).
    Limbo(Limbo),
    /// An engine actor: its reference.
    Live(u32),
    /// Gone: killed (`died`) or removed.
    /// `at`: the tick it left. An actor removed without dying (RemoveSelf, sold)
    /// is not dead yet during that tick, like OpenRA's until the frame ends.
    Gone { snap: Snapshot, died: bool, at: u32 },
    /// A waypoint (engine world position).
    Marker { x: i32, y: i32 },
    /// The actor of a player (OpenRA PlayerActor: `player.GetActorsByType("player")`),
    /// which carries the player's triggers.
    PlayerActor,
    /// A camera or flare: reveals for its owner while it lasts.
    Prop { x: i32, y: i32, reveal: i32, image: Option<String>, alive: bool },
}

#[derive(Clone, Debug)]
pub(crate) struct Limbo {
    pub x: i32,
    pub y: i32,
    pub altitude: Option<i32>,
    pub facing: i32,
    pub health: Option<i32>,
    pub stance: Option<crate::rules::Stance>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ObjectiveState {
    Incomplete,
    Completed,
    Failed,
}

#[derive(Clone, Debug)]
pub struct Objective {
    pub description: String,
    pub kind: String,
    pub required: bool,
    pub state: ObjectiveState,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WinState {
    Undefined,
    Won,
    Lost,
}

/// A mission player (one per engine player slot).
#[derive(Clone, Debug)]
pub struct MissionPlayer {
    pub name: String,
    pub color: u32,
    pub playable: bool,
    pub non_combatant: bool,
    pub bot: bool,
    pub objectives: Vec<Objective>,
    pub win: WinState,
    /// Cooperative missions: this player's own result (OpenRA WinStateCooperative).
    pub coop: WinState,
    /// Granted external conditions: token, name.
    pub conditions: Vec<(i32, String)>,
    /// OpenRA's skirmish bot modules switched on by a condition (soviet-05).
    pub ai_enabled: bool,
}

/// How the mission ended for the person playing it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MissionResult {
    Playing,
    Won,
    Lost,
    /// A script failed: OpenRA ends the game (ScriptContext.FatalError).
    ScriptError,
}

/// Things for the client to show or play (never read by the simulation and
/// not part of the state hash).
#[derive(Clone, Debug, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UiEvent {
    Message { prefix: String, text: String, color: String },
    Speech { player: u8, name: String },
    Sound { player: u8, name: String },
    SoundFile { file: String },
    Camera { x: f32, y: f32 },
    Movie { file: String },
    MissionText { text: String, color: String },
    FloatingText { text: String, x: f32, y: f32, color: String, ticks: i32 },
    RadarPing { player: u8, x: f32, y: f32, color: String, ticks: i32 },
    Debug { text: String },
    Error { text: String },
    Objectives,
    Result { result: String },
}

#[derive(Clone, Debug)]
pub(crate) struct Delayed {
    pub tick: u32,
    pub seq: u32,
    pub func: Value,
}

/// A reinforcement or a spawn effect waiting for its delay (OpenRA SpawnActorEffect).
#[derive(Clone, Debug)]
pub(crate) struct PendingSpawn {
    pub tick: u32,
    pub seq: u32,
    pub handle: u32,
    pub path: Vec<(i32, i32)>,
    pub then: Option<Value>,
}

/// A Build call waiting for its units (ProductionQueueProperties / ClassicProductionQueueProperties).
#[derive(Clone, Debug)]
pub(crate) struct BuildOrder {
    pub player: u8,
    /// Queue types it uses (engine `QueueType` indices).
    pub queues: Vec<usize>,
    /// The factory of an `actor.Build` (handle), or none for `player.Build`.
    pub factory: Option<u32>,
    pub size: usize,
    pub squad: Vec<u32>,
    pub func: Option<Value>,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct TimeLimit {
    /// Tick the script time limit runs out (0: none).
    pub end: u32,
    pub warned: Vec<i32>,
    pub expired: bool,
}

/// A structure of a mission map outside its playable area (OpenRA map
/// bounds), in `World::offmap`: there it exists, out of reach and out of
/// sight, and still gives its owner power, prerequisites and storage, and
/// counts as one of its required units (allies-03b's Soviet base is powered
/// from beyond the edge).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OffMapStructure {
    pub owner: u8,
    /// Actor type index.
    pub ty: u16,
    /// Faction index (what it provides, like a structure's own faction).
    pub faction: u8,
}

#[derive(Clone, Debug)]
pub struct Mission {
    pub id: String,
    pub(crate) lua: Option<Lua>,
    pub(crate) data: std::sync::Arc<MissionData>,
    pub(crate) handles: Vec<Handle>,
    /// Engine reference to handle, for actors scripts know.
    pub(crate) handle_of: BTreeMap<u32, u32>,
    /// Engine references of actors that left the world lately, to their
    /// handles and the tick they left: a dead shooter still answers as the
    /// attacker of damage its shots do afterwards.
    pub(crate) gone_of: BTreeMap<u32, (u32, u32)>,
    /// Map actors by script name, in map order.
    pub(crate) named: Vec<(String, u32)>,
    pub players: Vec<MissionPlayer>,
    /// OpenRA cell of the engine's cell (0, 0).
    pub origin: (i32, i32),
    pub(crate) triggers: triggers::Triggers,
    pub(crate) queues: BTreeMap<u32, activities::Queue>,
    pub(crate) delayed: Vec<Delayed>,
    pub(crate) spawns: Vec<PendingSpawn>,
    pub(crate) builds: Vec<BuildOrder>,
    pub(crate) seq: u32,
    pub(crate) options: BTreeMap<String, String>,
    pub(crate) time_limit: TimeLimit,
    /// The script camera (engine world position), last set by `Camera.Position`.
    pub(crate) camera: Option<(i32, i32)>,
    pub(crate) mission_text: Option<(String, String)>,
    pub(crate) ui: Vec<UiEvent>,
    pub error: Option<String>,
    /// Map actors that could not be placed (name, type, why), for reports and tests.
    pub unplaced: Vec<(String, String, String)>,
    pub result: MissionResult,
    /// Tick the game ends (OpenRA MissionObjectives GameOverDelay).
    pub(crate) game_over_at: Option<u32>,
    pub(crate) next_token: i32,
    /// Actors with an OnDiscovered trigger: players (bits) that saw them.
    pub(crate) discovered: BTreeMap<u32, u32>,
    /// Each player's PlayerActor handle, made when a script asks for it.
    pub(crate) player_actors: BTreeMap<u8, u32>,
    /// Players whose low power notification a script switched off.
    pub(crate) low_power_quiet: BTreeSet<u8>,
    /// Granted actor conditions: handle to (token, condition, end tick or 0).
    pub(crate) conditions: BTreeMap<u32, Vec<(i32, String, u32)>>,
}

impl Mission {
    pub(crate) fn handle(&self, h: u32) -> Option<&Handle> {
        self.handles.get(h as usize)
    }

    pub(crate) fn new_handle(&mut self, ty: String, owner: u8, state: HState) -> u32 {
        if let HState::Live(r) = state {
            if let Some(&h) = self.handle_of.get(&r) {
                return h;
            }
        }
        self.handles.push(Handle { ty, owner, state: state.clone(), tags: Vec::new() });
        let h = self.handles.len() as u32 - 1;
        if let HState::Live(r) = state {
            self.handle_of.insert(r, h);
        }
        h
    }

    pub fn title(&self) -> &str {
        &self.data.title
    }

    /// The mission text (OpenRA's MISSION_TEXT label) and its colour.
    pub fn mission_text(&self) -> Option<(&str, &str)> {
        self.mission_text.as_ref().map(|(t, c)| (t.as_str(), c.as_str()))
    }

    pub fn low_power_quiet(&self, p: u8) -> bool {
        self.low_power_quiet.contains(&p)
    }

    /// The script camera (engine world position), if a script set it.
    pub fn camera(&self) -> Option<(i32, i32)> {
        self.camera
    }

    /// Drain the presentation events.
    pub fn take_ui(&mut self) -> Vec<UiEvent> {
        std::mem::take(&mut self.ui)
    }

    /// Whether the script has activities queued for engine actor `i`.
    pub fn scripted(&self, w: &World, i: usize) -> bool {
        self.handle_of.get(&w.make_ref(i)).is_some_and(|h| self.queues.get(h).is_some_and(|q| !q.is_empty()))
    }

    /// The art key a mission actor is drawn with (tools/gen_missions.py `art`):
    /// a built-in actor or a campaign character of the game's art tables.
    pub fn art_key(&self, id: &str) -> Option<&str> {
        self.data.art.get(id)?.get("art")?.as_str()
    }

    /// The engine actor of a living named map actor.
    pub fn named_actor(&self, w: &World, name: &str) -> Option<usize> {
        let &(_, h) = self.named.iter().find(|(n, _)| n == name)?;
        match self.handles[h as usize].state {
            HState::Live(r) => w.resolve(r),
            _ => None,
        }
    }

    pub(crate) fn next_seq(&mut self) -> u32 {
        self.seq += 1;
        self.seq
    }

    /// Engine cell of an OpenRA cell.
    pub(crate) fn cell_in(&self, x: i32, y: i32) -> (i32, i32) {
        (x - self.origin.0, y - self.origin.1)
    }

    /// OpenRA cell of an engine cell.
    pub(crate) fn cell_out(&self, x: i32, y: i32) -> (i32, i32) {
        (x + self.origin.0, y + self.origin.1)
    }

    /// Engine world position of an OpenRA WPos.
    pub(crate) fn pos_in(&self, x: i32, y: i32) -> (i32, i32) {
        (x - self.origin.0 * CELL, y - self.origin.1 * CELL)
    }

    /// OpenRA WPos of an engine world position.
    pub(crate) fn pos_out(&self, x: i32, y: i32) -> (i32, i32) {
        (x + self.origin.0 * CELL, y + self.origin.1 * CELL)
    }

    /// The player slot of an OpenRA player name.
    pub fn player_slot(&self, name: &str) -> Option<u8> {
        self.players.iter().position(|p| p.name == name).map(|p| p as u8)
    }

    pub(crate) fn ui(&mut self, e: UiEvent) {
        // Bounded: a client that stops draining (hidden tab) or a chatty
        // script cannot grow it without end.
        if self.ui.len() < 512 {
            self.ui.push(e);
        }
    }

    /// Every script value the mission keeps outside the interpreter (GC roots).
    pub(crate) fn roots(&self) -> Vec<Value> {
        let mut out = Vec::new();
        self.triggers.roots(&mut out);
        for q in self.queues.values() {
            q.roots(&mut out);
        }
        out.extend(self.delayed.iter().map(|d| d.func.clone()));
        out.extend(self.spawns.iter().filter_map(|s| s.then.clone()));
        out.extend(self.builds.iter().filter_map(|b| b.func.clone()));
        out
    }

    /// FNV-1a over the mission state that decides the game (the interpreter
    /// heap, handles, objectives, triggers, queues, timers). The UI log, the
    /// mission text and the camera are presentation and left out.
    pub fn state_hash(&self) -> u64 {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        let mut mix = |v: i64| {
            h ^= v as u64;
            h = h.wrapping_mul(0x0100_0000_01b3);
        };
        mix(self.lua.as_ref().map_or(0, |l| l.state_hash()) as i64);
        mix(self.handles.len() as i64);
        for hd in &self.handles {
            mix(hd.owner as i64);
            match &hd.state {
                HState::Limbo(_) => mix(1),
                HState::Live(r) => mix(2 + ((*r as i64) << 8)),
                HState::Gone { died, .. } => mix(3 + *died as i64),
                HState::Marker { .. } => mix(4),
                HState::PlayerActor => mix(6),
                HState::Prop { x, y, alive, .. } => {
                    mix(5 + *alive as i64);
                    mix(*x as i64);
                    mix(*y as i64);
                }
            }
        }
        for p in &self.players {
            mix(p.win as i64);
            mix(p.ai_enabled as i64);
            for o in &p.objectives {
                mix(o.state as i64);
            }
        }
        mix(self.triggers.count() as i64);
        for (h, q) in &self.queues {
            mix(*h as i64);
            mix(q.len() as i64);
        }
        mix(self.delayed.len() as i64);
        mix(self.spawns.len() as i64);
        mix(self.builds.len() as i64);
        mix(self.time_limit.end as i64);
        mix(self.result as i64);
        mix(self.error.is_some() as i64);
        h
    }
}

impl World {
    /// Record an engine event for the mission's triggers (no-op without a mission).
    #[inline]
    pub(crate) fn script_event(&mut self, e: ScriptEvent) {
        if self.mission_on {
            self.script_events.push(e);
        }
    }

    /// Whether `player` is driven by its mission script, not the skirmish AI.
    pub fn scripted_player(&self, player: u8) -> bool {
        self.mission.as_ref().is_some_and(|m| m.players.get(player as usize).is_some_and(|p| !p.ai_enabled))
    }

    /// The mission's tick: events to triggers, script activities,
    /// reinforcements, timers, footprint and proximity triggers, idle
    /// triggers, the scripts' `Tick` function, the time limit.
    pub(crate) fn tick_mission(&mut self) {
        let Some(mut m) = self.mission.take() else { return };
        let mut lua = m.lua.take().expect("mission interpreter");
        {
            let mut ctx = api::Ctx { w: self, m: &mut m };
            ctx.run_tick(&mut lua);
        }
        m.lua = Some(lua);
        self.mission = Some(m);
    }

    /// The mission, if this world plays one.
    pub fn mission(&self) -> Option<&Mission> {
        self.mission.as_deref()
    }

    /// Script player slots that are enemies of `player` (for the AI and tests).
    pub fn mission_players(&self) -> Vec<String> {
        self.mission.as_ref().map_or_else(Vec::new, |m| m.players.iter().map(|p| p.name.clone()).collect())
    }
}

/// `Media.DisplayMessage` colours and the like: "RRGGBB".
pub(crate) fn hex_color(rgba: u32) -> String {
    format!("{:06X}", rgba >> 8)
}

/// Parse "RRGGBB" or "RRGGBBAA" into RGBA.
pub(crate) fn parse_color(s: &str) -> Option<u32> {
    let s = s.trim_start_matches('#');
    let v = u32::from_str_radix(s, 16).ok()?;
    match s.len() {
        6 => Some((v << 8) | 0xff),
        8 => Some(v),
        _ => None,
    }
}

/// A script error as text for the error screen: message and traceback.
pub(crate) fn error_text(e: &LuaError) -> String {
    e.report()
}

#[cfg(test)]
impl World {
    /// Tests: run a chunk of Lua in the mission's interpreter, with the API.
    pub(crate) fn mission_exec(&mut self, src: &str) -> Result<Vec<Value>, String> {
        let mut m = self.mission.take().expect("a mission");
        let mut lua = m.lua.take().expect("mission interpreter");
        lua.set_budget(TICK_BUDGET);
        let r = {
            let mut ctx = api::Ctx { w: self, m: &mut m };
            lua.exec(&mut ctx, "test.lua", src).map_err(|e| e.report())
        };
        m.lua = Some(lua);
        self.mission = Some(m);
        r
    }

    /// Tests: a global of the mission's scripts as text.
    pub(crate) fn mission_global(&self, name: &str) -> Option<String> {
        self.mission.as_ref()?.lua.as_ref()?.global(name).to_text()
    }
}

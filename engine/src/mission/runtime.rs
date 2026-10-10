//! The mission's part of every tick, script loading, events to triggers,
//! objectives and the end of the game.

use super::api::{actor_value, cpos, err, num, player_value, text, Ctx, A, F, R};
use super::triggers::{ActorTrigger, CellTrigger, Group, GroupKind, PlayerTrigger, ProximityTrigger};
use super::*;
use crate::lua::{ErrorKind, Lua, Value};
use crate::math::CELL;
use crate::sound_events::SoundEventKind;

/// Rounds of event handling per tick (callbacks cause new events).
const EVENT_ROUNDS: usize = 8;

impl Ctx<'_> {
    /// Run every script file in order, then `WorldLoaded` (OpenRA ScriptContext).
    pub(crate) fn load_scripts(&mut self, lua: &mut Lua) {
        let scripts = self.m.data.scripts.clone();
        for s in &scripts {
            if let Err(e) = lua.exec(self, &s.name, &s.source) {
                self.fatal(&e);
                return;
            }
        }
        let wl = lua.global("WorldLoaded");
        if !wl.is_nil() {
            self.call(lua, &wl, Vec::new());
        }
        // The start notification (OpenRA StartGameNotification on the World).
        if let Some(n) = self.m.data.start_notification.clone() {
            self.m.ui(UiEvent::Speech { player: 0, name: n });
        }
        self.drain_events(lua);
        lua.collect(&mut self.m.roots().into_iter());
    }

    /// Call a script function; a script error ends the mission.
    pub(crate) fn call(&mut self, lua: &mut Lua, f: &Value, args: Vec<Value>) -> Option<Vec<Value>> {
        if self.m.error.is_some() {
            return None;
        }
        match lua.call(self, f, args) {
            Ok(v) => Some(v),
            Err(e) => {
                self.fatal(&e);
                None
            }
        }
    }

    /// OpenRA ScriptContext.FatalError: the script stops and the game ends.
    pub(crate) fn fatal(&mut self, e: &crate::lua::LuaError) {
        if self.m.error.is_some() {
            return;
        }
        let msg = match e.kind {
            ErrorKind::Budget => format!("{} (the mission script ran too long in one tick)", e.report()),
            _ => error_text(e),
        };
        self.m.error = Some(msg.clone());
        self.m.result = MissionResult::ScriptError;
        self.m.ui(UiEvent::Error { text: msg });
        self.m.ui(UiEvent::Result { result: "error".into() });
        self.w.game_over = true;
    }

    /// One tick of the mission (`World::tick_mission`).
    pub(crate) fn run_tick(&mut self, lua: &mut Lua) {
        lua.set_budget(TICK_BUDGET);
        self.drain_events(lua);
        if self.m.error.is_none() {
            self.tick_conditions();
            self.tick_spawns(lua);
            self.tick_queues(lua);
            self.tick_delayed(lua);
            self.tick_cells(lua);
            self.tick_proximity(lua);
            self.tick_discovered(lua);
            self.tick_idle(lua);
            let tick = lua.global("Tick");
            if !tick.is_nil() {
                self.call(lua, &tick, Vec::new());
            }
            self.tick_time_limit(lua);
            self.tick_bots();
            self.drain_events(lua);
        }
        // Old references of gone actors are not needed after a few seconds.
        let tick = self.w.tick;
        self.m.gone_of.retain(|_, &mut (_, t)| tick < t + 250);
        if let Some(at) = self.m.game_over_at {
            if self.w.tick >= at {
                self.w.game_over = true;
            }
        }
        lua.maybe_collect(&mut self.m.roots().into_iter());
    }

    // ---- Events ----------------------------------------------------------------------

    fn drain_events(&mut self, lua: &mut Lua) {
        for _ in 0..EVENT_ROUNDS {
            let events = std::mem::take(&mut self.w.script_events);
            if events.is_empty() {
                return;
            }
            for e in events {
                self.handle_event(lua, e);
            }
        }
        // Whatever is still left waits for the next tick.
    }

    /// The handle of an engine reference, if scripts know the actor.
    fn known(&self, r: u32) -> Option<u32> {
        self.m.handle_of.get(&r).copied()
    }

    /// The handle of an engine reference, made when needed (an actor a script did not know yet).
    fn handle_of_ref(&mut self, r: u32) -> Option<u32> {
        if let Some(h) = self.known(r) {
            return Some(h);
        }
        if let Some(&(h, _)) = self.m.gone_of.get(&r) {
            return Some(h);
        }
        self.w.resolve(r).map(|i| self.handle_for(i))
    }

    fn mark_gone(&mut self, r: u32, snap: Snapshot, died: bool) -> Option<u32> {
        let h = match self.m.handle_of.remove(&r) {
            Some(h) => h,
            // Not known to the scripts yet: a handle now, so it can still be named as an attacker.
            None => {
                let ty = self.w.rules.actors[snap.ty as usize].id.clone();
                self.m.handles.push(Handle { ty, owner: snap.owner, state: HState::Gone { snap, died }, tags: Vec::new() });
                let h = self.m.handles.len() as u32 - 1;
                self.m.gone_of.insert(r, (h, self.w.tick));
                return None;
            }
        };
        self.m.gone_of.insert(r, (h, self.w.tick));
        self.m.handles[h as usize].state = HState::Gone { snap, died };
        self.m.handles[h as usize].owner = snap.owner;
        self.m.queues.remove(&h);
        Some(h)
    }

    fn fire_actor(&mut self, lua: &mut Lua, h: u32, t: ActorTrigger, args: Vec<Value>) {
        for f in self.m.triggers.actor_callbacks(h, t) {
            if self.call(lua, &f, args.clone()).is_none() {
                return;
            }
        }
    }

    fn handle_event(&mut self, lua: &mut Lua, e: ScriptEvent) {
        if self.m.error.is_some() {
            return;
        }
        match e {
            ScriptEvent::Damaged { victim, attacker, damage } => {
                let Some(h) = self.known(victim) else { return };
                if !self.m.triggers.has(h, ActorTrigger::OnDamaged) {
                    return;
                }
                // OpenRA always names an attacker; damage without one (a burning
                // husk, a crush) counts as the actor's own, like Health = x does.
                let att = actor_value(self.handle_of_ref(attacker).unwrap_or(h));
                self.fire_actor(lua, h, ActorTrigger::OnDamaged, vec![actor_value(h), att, num(damage as i64)]);
            }
            ScriptEvent::Killed { victim, killer, snap } => {
                self.death_spawn(&snap);
                let killer_h = self.handle_of_ref(killer);
                let Some(h) = self.mark_gone(victim, snap, true) else { return };
                let k = actor_value(killer_h.unwrap_or(h));
                self.fire_actor(lua, h, ActorTrigger::OnKilled, vec![actor_value(h), k]);
                self.group_event(lua, h, GroupEvent::Killed);
                self.removed_from_world(lua, h);
                self.build_unit_lost(h);
            }
            ScriptEvent::Removed { actor, snap } => {
                let Some(h) = self.mark_gone(actor, snap, false) else { return };
                self.removed_from_world(lua, h);
            }
            ScriptEvent::Captured { actor, captor, old, new } => {
                let Some(h) = self.known(actor) else { return };
                self.m.handles[h as usize].owner = new;
                let c = self.handle_of_ref(captor).map_or(Value::Nil, actor_value);
                self.fire_actor(lua, h, ActorTrigger::OnCapture, vec![actor_value(h), c, player_value(old), player_value(new)]);
                self.group_event(lua, h, GroupEvent::Captured);
            }
            ScriptEvent::Infiltrated { target, infiltrator } => {
                let Some(h) = self.known(target) else { return };
                let i = self.handle_of_ref(infiltrator).map_or(Value::Nil, actor_value);
                self.fire_actor(lua, h, ActorTrigger::OnInfiltrated, vec![actor_value(h), i]);
            }
            ScriptEvent::Sold { actor } => {
                let Some(h) = self.known(actor) else { return };
                self.fire_actor(lua, h, ActorTrigger::OnSold, vec![actor_value(h)]);
            }
            ScriptEvent::Produced { producer, unit } => {
                let Some(u) = self.handle_of_ref(unit) else { return };
                let p = self.handle_of_ref(producer);
                if let Some(p) = p {
                    self.fire_actor(lua, p, ActorTrigger::OnProduction, vec![actor_value(p), actor_value(u)]);
                }
                let owner = self.m.handles[u as usize].owner;
                let ty = self.w.resolve(unit).map(|i| self.w.actors[i].ty);
                let queue = ty.map(|t| crate::world::World::queue_type_index(self.w.rules.actors[t as usize].queue));
                for f in self.m.triggers.any_production.clone() {
                    let kind = queue.map_or(Value::Nil, |q| text(QUEUE_NAMES[q]));
                    if self.call(lua, &f, vec![p.map_or(Value::Nil, actor_value), actor_value(u), kind]).is_none() {
                        return;
                    }
                }
                self.build_unit_done(lua, owner, p, u, queue);
            }
            ScriptEvent::Placed { player, building } => {
                let Some(b) = self.handle_of_ref(building) else { return };
                for f in self.m.triggers.player_callbacks(player, PlayerTrigger::OnBuildingPlaced) {
                    if self.call(lua, &f, vec![player_value(player), actor_value(b)]).is_none() {
                        return;
                    }
                }
            }
            ScriptEvent::PassengerEntered { transport, passenger } => {
                let p = self.known(passenger);
                if let Some(t) = self.known(transport) {
                    let pv = self.handle_of_ref(passenger).map_or(Value::Nil, actor_value);
                    self.fire_actor(lua, t, ActorTrigger::OnPassengerEntered, vec![actor_value(t), pv]);
                }
                if let Some(p) = p {
                    self.removed_from_world(lua, p);
                }
            }
            ScriptEvent::PassengerExited { transport, passenger } => {
                let p = self.known(passenger);
                if let Some(t) = self.known(transport) {
                    let pv = self.handle_of_ref(passenger).map_or(Value::Nil, actor_value);
                    self.fire_actor(lua, t, ActorTrigger::OnPassengerExited, vec![actor_value(t), pv]);
                }
                if let Some(p) = p {
                    self.added_to_world(lua, p);
                }
            }
        }
    }

    /// SpawnActorOnDeath of a structure (MissionData::death_spawns): the new
    /// actor takes the dead one's place once its cells are free.
    fn death_spawn(&mut self, snap: &Snapshot) {
        let id = &self.w.rules.actors[snap.ty as usize].id;
        let Some(into) = self.m.data.death_spawns.get(id).cloned() else { return };
        let Some(t) = self.w.rules.actor_index(&into) else { return };
        let dead = &self.w.rules.actors[snap.ty as usize];
        let (w, h) = dead.building.as_ref().map_or((1, 1), |b| (b.width, b.height));
        let (cx, cy) = ((snap.x - w * CELL / 2).div_euclid(CELL), (snap.y - h * CELL / 2).div_euclid(CELL));
        match self.w.rules.actors[t].kind {
            crate::rules::Kind::Building => {
                self.w.spawn_building(t as u16, snap.owner, cx, cy);
            }
            _ => {
                self.w.spawn_unit(t as u16, snap.owner, snap.x, snap.y, snap.facing);
            }
        }
    }

    /// OnRemovedFromWorld and the OnAllRemovedFromWorld groups.
    pub(crate) fn removed_from_world(&mut self, lua: &mut Lua, h: u32) {
        self.fire_actor(lua, h, ActorTrigger::OnRemovedFromWorld, vec![actor_value(h)]);
        self.group_event(lua, h, GroupEvent::Removed);
    }

    /// OnAddedToWorld, and members of OnAllRemovedFromWorld groups count again.
    pub(crate) fn added_to_world(&mut self, lua: &mut Lua, h: u32) {
        self.fire_actor(lua, h, ActorTrigger::OnAddedToWorld, vec![actor_value(h)]);
        for g in &mut self.m.triggers.groups {
            if g.kind == GroupKind::AllRemoved && g.members.contains(&h) {
                g.remaining.insert(h);
            }
        }
    }

    fn group_event(&mut self, lua: &mut Lua, h: u32, ev: GroupEvent) {
        let mut fire: Vec<(Value, Vec<Value>)> = Vec::new();
        for g in &mut self.m.triggers.groups {
            if g.done || !g.members.contains(&h) {
                continue;
            }
            let counts = match g.kind {
                GroupKind::AllKilled | GroupKind::AnyKilled => ev == GroupEvent::Killed,
                GroupKind::AllRemoved => ev != GroupEvent::Captured,
                GroupKind::AllKilledOrCaptured | GroupKind::KilledOrCaptured => ev != GroupEvent::Removed,
            };
            if !counts {
                continue;
            }
            match g.kind {
                GroupKind::AnyKilled => {
                    g.done = true;
                    fire.push((g.func.clone(), vec![actor_value(h)]));
                }
                GroupKind::KilledOrCaptured => {
                    g.done = true;
                    fire.push((g.func.clone(), Vec::new()));
                }
                _ => {
                    if g.remaining.remove(&h) && g.remaining.is_empty() {
                        // OnAllRemovedFromWorld can fire again when members come back.
                        g.done = g.kind != GroupKind::AllRemoved;
                        fire.push((g.func.clone(), Vec::new()));
                    }
                }
            }
        }
        for (f, args) in fire {
            if self.call(lua, &f, args).is_none() {
                return;
            }
        }
    }

    // ---- Per tick --------------------------------------------------------------------

    fn tick_delayed(&mut self, lua: &mut Lua) {
        let tick = self.w.tick;
        let mut due: Vec<Delayed> = Vec::new();
        self.m.delayed.retain(|d| {
            if d.tick <= tick {
                due.push(d.clone());
                false
            } else {
                true
            }
        });
        due.sort_by_key(|d| (d.tick, d.seq));
        for d in due {
            if self.call(lua, &d.func, Vec::new()).is_none() {
                return;
            }
        }
    }

    /// Ground actors on cells (OpenRA ActorMap cell triggers: actors that occupy cells, not flying aircraft).
    fn tick_cells(&mut self, lua: &mut Lua) {
        if self.m.triggers.cells.is_empty() {
            return;
        }
        let ids: Vec<u32> = self.m.triggers.cells.keys().copied().collect();
        for id in ids {
            let Some(t) = self.m.triggers.cells.get(&id) else { continue };
            let cells = t.cells.clone();
            let mut now = std::collections::BTreeSet::new();
            for i in 0..self.w.actors.len() {
                let a = &self.w.actors[i];
                if !a.alive
                    || !a.in_world()
                    || a.altitude > 0
                    || !matches!(
                        a.kind,
                        crate::rules::Kind::Infantry
                            | crate::rules::Kind::Vehicle
                            | crate::rules::Kind::Ship
                            | crate::rules::Kind::Aircraft
                    )
                {
                    continue;
                }
                let ci = self.w.cell_index(a.x, a.y);
                if cells.contains(&ci) {
                    now.insert(self.handle_for(i));
                }
            }
            self.membership(lua, id, now, true);
        }
    }

    fn tick_proximity(&mut self, lua: &mut Lua) {
        if self.m.triggers.proximity.is_empty() {
            return;
        }
        let ids: Vec<u32> = self.m.triggers.proximity.keys().copied().collect();
        for id in ids {
            let Some(t) = self.m.triggers.proximity.get(&id) else { continue };
            let (x, y, r) = (t.x as i64, t.y as i64, t.range as i64);
            let mut now = std::collections::BTreeSet::new();
            for i in 0..self.w.actors.len() {
                let a = &self.w.actors[i];
                if !a.alive || !a.in_world() {
                    continue;
                }
                let (dx, dy) = (a.x as i64 - x, a.y as i64 - y);
                if dx * dx + dy * dy < r * r {
                    now.insert(self.handle_for(i));
                }
            }
            self.membership(lua, id, now, false);
        }
    }

    /// Compare who is inside a cell or proximity trigger with last tick and call enter and exit.
    fn membership(&mut self, lua: &mut Lua, id: u32, now: std::collections::BTreeSet<u32>, cells: bool) {
        let (inside, on_enter, on_exit) = if cells {
            let Some(t) = self.m.triggers.cells.get_mut(&id) else { return };
            (std::mem::replace(&mut t.inside, now.clone()), t.on_enter.clone(), t.on_exit.clone())
        } else {
            let Some(t) = self.m.triggers.proximity.get_mut(&id) else { return };
            (std::mem::replace(&mut t.inside, now.clone()), t.on_enter.clone(), t.on_exit.clone())
        };
        if let Some(f) = on_enter {
            for &h in now.difference(&inside) {
                if self.call(lua, &f, vec![actor_value(h), num(id as i64)]).is_none() {
                    return;
                }
                // The trigger may have been removed by its own callback.
                let exists = if cells { self.m.triggers.cells.contains_key(&id) } else { self.m.triggers.proximity.contains_key(&id) };
                if !exists {
                    return;
                }
            }
        }
        if let Some(f) = on_exit {
            for &h in inside.difference(&now) {
                if self.call(lua, &f, vec![actor_value(h), num(id as i64)]).is_none() {
                    return;
                }
                let exists = if cells { self.m.triggers.cells.contains_key(&id) } else { self.m.triggers.proximity.contains_key(&id) };
                if !exists {
                    return;
                }
            }
        }
    }

    /// OnDiscovered / OnPlayerDiscovered: an actor seen for the first time
    /// by a player that is its enemy or neutral to it (OpenRA EnemyWatcher).
    fn tick_discovered(&mut self, lua: &mut Lua) {
        let mut watched = self.m.triggers.watched(ActorTrigger::OnDiscovered);
        let watched_players: Vec<u8> =
            self.m.triggers.player.keys().filter(|(_, t)| *t == PlayerTrigger::OnPlayerDiscovered).map(|(p, _)| *p).collect();
        if !watched_players.is_empty() {
            for h in 0..self.m.handles.len() as u32 {
                if watched_players.contains(&self.m.handles[h as usize].owner) && !watched.contains(&h) {
                    watched.push(h);
                }
            }
            watched.sort_unstable();
        }
        for h in watched {
            let Some(i) = self.engine_actor(h) else { continue };
            let owner = self.w.actors[i].owner;
            let seen = self.m.discovered.get(&h).copied().unwrap_or(0);
            for p in 0..self.w.players.len() as u8 {
                if p == owner || seen & (1 << p) != 0 || self.w.are_allies(p, owner) || self.w.players[p as usize].neutral {
                    continue;
                }
                if !self.w.actors[i].in_world() || !self.w.is_visible_to(i, p) {
                    continue;
                }
                *self.m.discovered.entry(h).or_insert(0) |= 1 << p;
                self.fire_actor(lua, h, ActorTrigger::OnDiscovered, vec![actor_value(h), player_value(p)]);
                for f in self.m.triggers.player_callbacks(owner, PlayerTrigger::OnPlayerDiscovered) {
                    if self.call(lua, &f, vec![player_value(owner), player_value(p), actor_value(h)]).is_none() {
                        return;
                    }
                }
            }
        }
    }

    fn tick_idle(&mut self, lua: &mut Lua) {
        for h in self.m.triggers.watched(ActorTrigger::OnIdle) {
            if self.is_idle(h) {
                self.fire_actor(lua, h, ActorTrigger::OnIdle, vec![actor_value(h)]);
                if self.m.error.is_some() {
                    return;
                }
            }
        }
    }

    /// The script time limit (OpenRA TimeLimitManager driven by DateTime.TimeLimit).
    fn tick_time_limit(&mut self, lua: &mut Lua) {
        let end = self.m.time_limit.end;
        if end == 0 || self.m.time_limit.expired {
            return;
        }
        let tick = self.w.tick;
        let info = self.m.data.time_limit.clone();
        let left = end.saturating_sub(tick) as i64;
        if let Some(text_pattern) = &info.countdown_text {
            // The countdown label (MISSION_TEXT) once a second.
            if left % 25 == 0 || self.m.mission_text.is_none() {
                let t = fluent::format_indexed(text_pattern, &[fluent::format_time(left, true)]);
                self.m.mission_text = Some((t.clone(), "FFFFFF".into()));
                self.m.ui(UiEvent::MissionText { text: t, color: "FFFFFF".into() });
            }
        }
        for (k, &minutes) in info.warnings.iter().enumerate() {
            if left == minutes as i64 * 60 * 25 && !self.m.time_limit.warned.contains(&minutes) {
                self.m.time_limit.warned.push(minutes);
                if let Some(n) = info.warning_notifications.get(k) {
                    self.m.ui(UiEvent::Speech { player: 255, name: n.clone() });
                }
                if let Some(t) = &info.notification {
                    let msg = fluent::format_indexed(t, &[minutes.to_string(), if minutes > 1 { "s".into() } else { String::new() }]);
                    self.m.ui(UiEvent::Message { prefix: "Battlefield Control".into(), text: msg, color: "FFFF00".into() });
                }
                self.w.sound.push(SoundEventKind::TimeLimitWarning, minutes, 0, 0, crate::sound_events::ALL_PLAYERS, 0);
            }
        }
        if tick >= end {
            self.m.time_limit.expired = true;
            self.m.mission_text = None;
            self.m.ui(UiEvent::MissionText { text: String::new(), color: "FFFFFF".into() });
            if !info.skip_expired_notification {
                self.m.ui(UiEvent::Speech { player: 255, name: "TimeLimitExpired".into() });
            }
            for f in self.m.triggers.timer_expired.clone() {
                if self.call(lua, &f, Vec::new()).is_none() {
                    return;
                }
            }
        }
    }

    /// Players whose bot modules a condition switched on (OpenRA's campaign
    /// bot with HarvesterBotModule, BuildingRepairBotModule, ...): base
    /// builders run the skirmish AI, the repair module repairs damaged structures.
    fn tick_bots(&mut self) {
        if !self.w.tick.is_multiple_of(25) {
            return;
        }
        for p in 0..self.m.players.len() {
            let modules = self.bot_modules(p as u8);
            if modules.iter().any(|m| m == "BuildingRepairBotModule") && !self.m.players[p].ai_enabled {
                for i in 0..self.w.actors.len() {
                    let a = &self.w.actors[i];
                    let max = self.w.rules.actors[a.ty as usize].hp;
                    if a.alive
                        && a.owner == p as u8
                        && a.kind == crate::rules::Kind::Building
                        && a.hp < max
                        && a.repairers.is_empty()
                        && self.w.can_toggle_repair(p as u8, i)
                    {
                        self.w.toggle_repair(p as u8, i);
                    }
                }
            }
        }
    }

    /// Bot modules switched on for a player by its granted conditions.
    pub(crate) fn bot_modules(&self, p: u8) -> Vec<String> {
        let Some(pl) = self.m.players.get(p as usize) else { return Vec::new() };
        let mut out = Vec::new();
        for (_, c) in &pl.conditions {
            if let Some(mods) = self.m.data.bot_conditions.get(c) {
                out.extend(mods.iter().cloned());
            }
        }
        out
    }

    // ---- Objectives (OpenRA MissionObjectives) ---------------------------------------

    pub(crate) fn add_objective(&mut self, lua: &mut Lua, p: u8, description: String, kind: String, required: bool) -> i32 {
        let pl = &mut self.m.players[p as usize];
        pl.objectives.push(Objective { description, kind, required, state: ObjectiveState::Incomplete });
        let id = pl.objectives.len() as i32 - 1;
        self.m.ui(UiEvent::Objectives);
        for f in self.m.triggers.player_callbacks(p, PlayerTrigger::OnObjectiveAdded) {
            if self.call(lua, &f, vec![player_value(p), num(id as i64)]).is_none() {
                break;
            }
        }
        id
    }

    pub(crate) fn mark_objective(&mut self, lua: &mut Lua, p: u8, id: i64, completed: bool) -> R<()> {
        let n = self.m.players[p as usize].objectives.len() as i64;
        if id < 0 || id >= n {
            return err("Objective ID is out of range.");
        }
        let o = &mut self.m.players[p as usize].objectives[id as usize];
        if completed {
            if o.state != ObjectiveState::Incomplete {
                return Ok(());
            }
            o.state = ObjectiveState::Completed;
        } else {
            if o.state == ObjectiveState::Failed {
                return Ok(());
            }
            o.state = ObjectiveState::Failed;
        }
        let required = o.required;
        self.m.ui(UiEvent::Objectives);
        let t = if completed { PlayerTrigger::OnObjectiveCompleted } else { PlayerTrigger::OnObjectiveFailed };
        for f in self.m.triggers.player_callbacks(p, t) {
            if self.call(lua, &f, vec![player_value(p), num(id)]).is_none() {
                return Ok(());
            }
        }
        if !required {
            return Ok(());
        }
        let objectives = &self.m.players[p as usize].objectives;
        if completed && objectives.iter().filter(|o| o.required).all(|o| o.state == ObjectiveState::Completed) {
            self.player_won(lua, p);
        } else if !completed {
            self.player_lost(lua, p);
        }
        Ok(())
    }

    fn enemies_of(&self, p: u8) -> Vec<u8> {
        (0..self.m.players.len() as u8)
            .filter(|&q| q != p && !self.m.players[q as usize].non_combatant && self.w.are_enemies(p, q))
            .collect()
    }

    /// Combatant players allied to `p`, `p` included (OpenRA MissionObjectives allies).
    fn allies_of(&self, p: u8) -> Vec<u8> {
        (0..self.m.players.len() as u8).filter(|&q| !self.m.players[q as usize].non_combatant && self.w.are_allies(p, q)).collect()
    }

    fn set_win(&mut self, q: u8, state: WinState) {
        let pl = &mut self.m.players[q as usize];
        if pl.win == WinState::Undefined {
            pl.win = state;
            if state == WinState::Lost {
                self.w.players[q as usize].defeated = true;
            }
        }
    }

    /// ForceDefeat: every open objective of `q` fails.
    fn force_defeat(&mut self, lua: &mut Lua, q: u8) {
        let open: Vec<i64> = (0..self.m.players[q as usize].objectives.len() as i64)
            .filter(|&i| self.m.players[q as usize].objectives[i as usize].state == ObjectiveState::Incomplete)
            .collect();
        for i in open {
            let _ = self.mark_objective(lua, q, i, false);
        }
    }

    /// All required objectives of `p` are done (OpenRA INotifyWinStateChanged.OnPlayerWon:
    /// the player's script triggers, then MissionObjectives).
    fn player_won(&mut self, lua: &mut Lua, p: u8) {
        for f in self.m.triggers.player_callbacks(p, PlayerTrigger::OnPlayerWon) {
            if self.call(lua, &f, vec![player_value(p)]).is_none() {
                return;
            }
        }
        let early = self.m.data.objectives.early_game_over;
        if self.m.data.objectives.cooperative {
            self.m.players[p as usize].coop = WinState::Won;
            let allies = self.allies_of(p);
            if allies.iter().all(|&a| self.m.players[a as usize].coop == WinState::Won) {
                for a in allies {
                    self.set_win(a, WinState::Won);
                }
                if early {
                    for q in self.enemies_of(p) {
                        self.force_defeat(lua, q);
                    }
                }
            }
        } else {
            self.set_win(p, WinState::Won);
            if early {
                for q in self.enemies_of(p) {
                    self.force_defeat(lua, q);
                }
            }
        }
        self.check_game_over();
    }

    /// A required objective of `p` failed (OnPlayerLost).
    fn player_lost(&mut self, lua: &mut Lua, p: u8) {
        for f in self.m.triggers.player_callbacks(p, PlayerTrigger::OnPlayerLost) {
            if self.call(lua, &f, vec![player_value(p)]).is_none() {
                return;
            }
        }
        let early = self.m.data.objectives.early_game_over;
        if self.m.data.objectives.cooperative {
            self.m.players[p as usize].coop = WinState::Lost;
            let allies = self.allies_of(p);
            if allies.iter().any(|&a| self.m.players[a as usize].coop == WinState::Lost) {
                for a in allies {
                    self.set_win(a, WinState::Lost);
                }
                if early {
                    for q in self.enemies_of(p) {
                        self.set_win(q, WinState::Won);
                    }
                }
            }
        } else {
            self.set_win(p, WinState::Lost);
            if early {
                for q in self.enemies_of(p) {
                    self.set_win(q, WinState::Won);
                }
            }
        }
        self.check_game_over();
    }

    /// The game is over when every player is non-combatant, decided, or has no
    /// objectives (OpenRA CheckIfGameIsOver); it ends GameOverDelay later.
    fn check_game_over(&mut self) {
        let human = &self.m.players[0];
        let result = match human.win {
            WinState::Won => MissionResult::Won,
            WinState::Lost => MissionResult::Lost,
            WinState::Undefined => MissionResult::Playing,
        };
        if result != MissionResult::Playing && self.m.result == MissionResult::Playing {
            self.m.result = result;
            if result == MissionResult::Won {
                self.w.winner = Some(0);
            }
            self.m.ui(UiEvent::Result { result: if result == MissionResult::Won { "won".into() } else { "lost".into() } });
        }
        let over = self.m.players.iter().all(|p| p.non_combatant || p.win != WinState::Undefined || p.objectives.is_empty());
        if over && self.m.game_over_at.is_none() {
            let delay = (self.m.data.objectives.game_over_delay.max(0) as u32).div_ceil(40);
            self.m.game_over_at = Some(self.w.tick + delay);
        }
    }

    // ---- Trigger registration (Trigger global) ---------------------------------------

    pub(crate) fn trigger_call(&mut self, lua: &mut Lua, f: F, a: &A) -> R<Vec<Value>> {
        let actor_trigger = |f: F| -> Option<ActorTrigger> {
            Some(match f {
                F::TriggerOnPassengerEntered => ActorTrigger::OnPassengerEntered,
                F::TriggerOnPassengerExited => ActorTrigger::OnPassengerExited,
                F::TriggerOnIdle => ActorTrigger::OnIdle,
                F::TriggerOnDamaged => ActorTrigger::OnDamaged,
                F::TriggerOnKilled => ActorTrigger::OnKilled,
                F::TriggerOnProduction => ActorTrigger::OnProduction,
                F::TriggerOnAddedToWorld => ActorTrigger::OnAddedToWorld,
                F::TriggerOnRemovedFromWorld => ActorTrigger::OnRemovedFromWorld,
                F::TriggerOnCapture => ActorTrigger::OnCapture,
                F::TriggerOnInfiltrated => ActorTrigger::OnInfiltrated,
                F::TriggerOnDiscovered => ActorTrigger::OnDiscovered,
                F::TriggerOnSold => ActorTrigger::OnSold,
                F::TriggerOnSupportPowerActivated => ActorTrigger::OnSupportPowerActivated,
                _ => return None,
            })
        };
        let player_trigger = |f: F| -> Option<PlayerTrigger> {
            Some(match f {
                F::TriggerOnPlayerWon => PlayerTrigger::OnPlayerWon,
                F::TriggerOnPlayerLost => PlayerTrigger::OnPlayerLost,
                F::TriggerOnObjectiveAdded => PlayerTrigger::OnObjectiveAdded,
                F::TriggerOnObjectiveCompleted => PlayerTrigger::OnObjectiveCompleted,
                F::TriggerOnObjectiveFailed => PlayerTrigger::OnObjectiveFailed,
                F::TriggerOnBuildingPlaced => PlayerTrigger::OnBuildingPlaced,
                F::TriggerOnPlayerDiscovered => PlayerTrigger::OnPlayerDiscovered,
                _ => return None,
            })
        };
        if let Some(t) = actor_trigger(f) {
            let h = a.actor(0)?;
            let func = a.func(1)?;
            self.m.triggers.add_actor(h, t, func);
            return Ok(Vec::new());
        }
        if let Some(t) = player_trigger(f) {
            let p = a.player(0)?;
            let func = a.func(1)?;
            self.m.triggers.add_player(p, t, func);
            return Ok(Vec::new());
        }
        match f {
            F::TriggerAfterDelay => {
                let delay = a.int(0)?;
                let func = a.func(1)?;
                // OpenRA adds the DelayedAction at the end of the frame: a
                // delay of 0 runs on the next tick, like 1.
                self.later(func, delay.max(1));
                Ok(Vec::new())
            }
            F::TriggerOnAllKilled | F::TriggerOnAnyKilled | F::TriggerOnAllRemovedFromWorld | F::TriggerOnAllKilledOrCaptured => {
                let t = a.table(0)?;
                let func = a.func(1)?;
                let mut members = Vec::new();
                for v in lua.sequence(t) {
                    match v.as_userdata() {
                        Some(u) if u.kind == UD_ACTOR => members.push(u.a as u32),
                        _ => return err(format!("{}: the group must be a table of actors", f.name())),
                    }
                }
                let kind = match f {
                    F::TriggerOnAllKilled => GroupKind::AllKilled,
                    F::TriggerOnAnyKilled => GroupKind::AnyKilled,
                    F::TriggerOnAllRemovedFromWorld => GroupKind::AllRemoved,
                    _ => GroupKind::AllKilledOrCaptured,
                };
                // Members that are already gone count as killed (or removed) right away.
                let remaining: std::collections::BTreeSet<u32> = members
                    .iter()
                    .copied()
                    .filter(|&h| match kind {
                        GroupKind::AllRemoved => self.in_world(h),
                        _ => !self.is_dead(h),
                    })
                    .collect();
                let fire_now = remaining.is_empty() && !members.is_empty() && kind != GroupKind::AnyKilled;
                self.m.triggers.groups.push(Group { kind, members, remaining, func: func.clone(), done: fire_now });
                if fire_now {
                    self.later(func, 1);
                }
                Ok(Vec::new())
            }
            F::TriggerOnKilledOrCaptured => {
                let h = a.actor(0)?;
                let func = a.func(1)?;
                self.m.triggers.groups.push(Group {
                    kind: GroupKind::KilledOrCaptured,
                    members: vec![h],
                    remaining: [h].into_iter().collect(),
                    func,
                    done: false,
                });
                Ok(Vec::new())
            }
            F::TriggerOnAnyProduction => {
                let func = a.func(0)?;
                self.m.triggers.any_production.push(func);
                Ok(Vec::new())
            }
            F::TriggerOnTimerExpired => {
                let func = a.func(0)?;
                self.m.triggers.timer_expired.push(func);
                Ok(Vec::new())
            }
            F::TriggerOnEnteredFootprint | F::TriggerOnExitedFootprint => {
                let t = a.table(0)?;
                let func = a.func(1)?;
                let mut cells = std::collections::BTreeSet::new();
                for v in lua.sequence(t) {
                    match v.as_userdata() {
                        Some(u) if u.kind == UD_CPOS => {
                            let (x, y) = self.m.cell_in(u.a, u.b);
                            if self.w.map.contains(x, y) {
                                cells.insert(self.w.map.idx(x, y));
                            }
                        }
                        _ => return err(format!("{}: the footprint must be a table of CPos", f.name())),
                    }
                }
                let id = self.m.triggers.new_id();
                let enter = f == F::TriggerOnEnteredFootprint;
                // Actors standing on the cells already count as inside (no enter event for them).
                let inside: std::collections::BTreeSet<u32> = if enter {
                    let found = self.actors_matching(|w, i| {
                        let a = &w.actors[i];
                        a.altitude == 0 && a.is_unit() && cells.contains(&w.cell_index(a.x, a.y))
                    });
                    found.into_iter().collect()
                } else {
                    Default::default()
                };
                let (on_enter, on_exit) = if enter { (Some(func), None) } else { (None, Some(func)) };
                self.m.triggers.cells.insert(id, CellTrigger { cells, on_enter, on_exit, inside });
                Ok(vec![num(id as i64)])
            }
            F::TriggerRemoveFootprintTrigger => {
                let id = a.int(0)? as u32;
                self.m.triggers.cells.remove(&id);
                Ok(Vec::new())
            }
            F::TriggerOnEnteredProximityTrigger | F::TriggerOnExitedProximityTrigger => {
                let (x, y, _) = a.wpos(0)?;
                let range = a.wdist(1)?;
                let func = a.func(2)?;
                let (ex, ey) = self.m.pos_in(x, y);
                let id = self.m.triggers.new_id();
                let enter = f == F::TriggerOnEnteredProximityTrigger;
                let (on_enter, on_exit) = if enter { (Some(func), None) } else { (None, Some(func)) };
                self.m
                    .triggers
                    .proximity
                    .insert(id, ProximityTrigger { x: ex, y: ey, range, on_enter, on_exit, inside: Default::default() });
                Ok(vec![num(id as i64)])
            }
            F::TriggerRemoveProximityTrigger => {
                let id = a.int(0)? as u32;
                self.m.triggers.proximity.remove(&id);
                Ok(Vec::new())
            }
            F::TriggerClearAll => {
                let h = a.actor(0)?;
                if let Some(p) = self.player_of_actor(h) {
                    self.m.triggers.player.retain(|(q, _), _| *q != p);
                }
                self.m.triggers.clear_all(h);
                Ok(Vec::new())
            }
            F::TriggerClear => {
                let h = a.actor(0)?;
                let name = a.string(1)?;
                if let Some(p) = self.player_of_actor(h) {
                    if let Some(t) = PlayerTrigger::parse(&name) {
                        self.m.triggers.player.remove(&(p, t));
                        return Ok(Vec::new());
                    }
                }
                let t = ActorTrigger::parse(&name)
                    .ok_or_else(|| crate::lua::LuaError::runtime(format!("Requested value '{name}' was not found.")))?;
                self.m.triggers.clear(h, t);
                Ok(Vec::new())
            }
            _ => err(format!("{} is not a global function", f.name())),
        }
    }

    /// The player whose PlayerActor handle `h` is.
    fn player_of_actor(&self, h: u32) -> Option<u8> {
        let hd = self.m.handle(h)?;
        matches!(hd.state, HState::PlayerActor).then_some(hd.owner)
    }

    // ---- Build orders (player.Build, factory.Build) -----------------------------------

    /// A produced unit counts for the Build call waiting on its queue.
    fn build_unit_done(&mut self, lua: &mut Lua, owner: u8, producer: Option<u32>, u: u32, queue: Option<usize>) {
        let Some(q) = queue else { return };
        let Some(k) = self.m.builds.iter().position(|b| {
            b.player == owner && b.queues.contains(&q) && b.factory.is_none_or(|fh| Some(fh) == producer) && b.squad.len() < b.size
        }) else {
            return;
        };
        self.m.builds[k].squad.push(u);
        if self.m.builds[k].squad.len() >= self.m.builds[k].size {
            let b = self.m.builds.remove(k);
            if let Some(f) = b.func {
                // The actors array only holds living actors.
                let alive: Vec<Value> = b.squad.iter().copied().filter(|&h| !self.is_dead(h)).map(actor_value).collect();
                let list = lua.array(alive);
                self.call(lua, &f, vec![list]);
            }
        }
    }

    /// A Build call whose items can no longer be finished (its queue was cancelled) ends without calling back.
    fn build_unit_lost(&mut self, _h: u32) {
        let w = &*self.w;
        self.m.builds.retain(|b| {
            let items: usize = b.queues.iter().map(|&q| w.players[b.player as usize].queues[q].items.len()).sum();
            items > 0 || b.squad.len() >= b.size || b.factory.is_some()
        });
    }

    /// The center of an OpenRA cell in engine world units.
    pub(crate) fn cell_center_in(&self, x: i32, y: i32) -> (i32, i32) {
        let (cx, cy) = self.m.cell_in(x, y);
        (cx * CELL + CELL / 2, cy * CELL + CELL / 2)
    }

    /// The CPos of an engine world position.
    pub(crate) fn cpos_of(&self, x: i32, y: i32) -> Value {
        let (ox, oy) = self.m.cell_out(x.div_euclid(CELL), y.div_euclid(CELL));
        cpos(ox, oy)
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum GroupEvent {
    Killed,
    Captured,
    Removed,
}

/// Queue names as OpenRA's `ProductionQueue.Type` (Trigger.OnAnyProduction).
const QUEUE_NAMES: [&str; 6] = ["Building", "Defense", "Infantry", "Vehicle", "Aircraft", "Ship"];

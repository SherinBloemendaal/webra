//! Player members for scripts (OpenRA ScriptPlayerProperties: Player,
//! MissionObjectives, Resources, Power, Production, Diplomacy, Statistics).

use super::api::*;
use super::*;
use crate::lua::{Lua, LuaError, UserData, Value};
use crate::rules::Kind;

impl Ctx<'_> {
    pub(crate) fn player_get(&mut self, lua: &mut Lua, obj: UserData, k: &str) -> R<Value> {
        let p = obj.a as u8;
        let Some(mp) = self.m.players.get(p as usize).cloned() else { return err("invalid player") };
        let pl = &self.w.players[p as usize];
        let method = |f: F| Ok(bound_fn(f, obj));
        match k {
            "InternalName" | "Name" => Ok(text(&mp.name)),
            "Color" => Ok(color(mp.color)),
            "Faction" => Ok(text(&self.w.rules.factions[pl.faction])),
            "Spawn" => Ok(num(0)),
            "HomeLocation" => {
                let (x, y) = pl.start;
                let (ox, oy) = self.m.cell_out(x, y);
                Ok(cpos(ox, oy))
            }
            "Team" | "Handicap" => Ok(num(0)),
            "IsBot" => Ok(boolean(mp.bot)),
            "IsNonCombatant" => Ok(boolean(mp.non_combatant)),
            // The player of this screen (co-op online: each client its own).
            "IsLocalPlayer" => Ok(boolean(p == self.m.local_player)),
            "Cash" => Ok(num(pl.cash as i64)),
            "Resources" => Ok(num(pl.resources as i64)),
            "ResourceCapacity" => Ok(num(pl.storage as i64)),
            "PowerProvided" => Ok(num(pl.power_gen as i64)),
            "PowerDrained" => Ok(num(pl.power_use as i64)),
            "PowerState" => {
                // OpenRA PowerManager: Critical below half, Low when drain exceeds supply.
                let s = if pl.power_use > pl.power_gen {
                    if pl.power_gen * 2 < pl.power_use {
                        "Critical"
                    } else {
                        "Low"
                    }
                } else {
                    "Normal"
                };
                Ok(text(s))
            }
            "PlayLowPowerNotification" => Ok(boolean(!self.m.low_power_quiet.contains(&p))),
            "UnitsLost" => Ok(num(self.w.player_stats(p).units_lost as i64)),
            "UnitsKilled" => Ok(num(self.w.player_stats(p).units_killed as i64)),
            "BuildingsLost" => Ok(num(self.w.player_stats(p).buildings_lost as i64)),
            "BuildingsKilled" => Ok(num(self.w.player_stats(p).buildings_killed as i64)),
            "KillsCost" => Ok(num(self.w.player_stats(p).assets_destroyed)),
            "DeathsCost" => Ok(num(self.w.player_stats(p).assets_lost)),
            "Experience" => Ok(num(pl.experience)),
            "GetActors" => method(F::PGetActors),
            "GetGroundAttackers" => method(F::PGetGroundAttackers),
            "GetActorsByType" => method(F::PGetActorsByType),
            "GetActorsByTypes" => method(F::PGetActorsByTypes),
            "HasPrerequisites" => method(F::PHasPrerequisites),
            "AddObjective" => method(F::PAddObjective),
            "AddPrimaryObjective" => method(F::PAddPrimaryObjective),
            "AddSecondaryObjective" => method(F::PAddSecondaryObjective),
            "MarkCompletedObjective" => method(F::PMarkCompletedObjective),
            "MarkFailedObjective" => method(F::PMarkFailedObjective),
            "IsObjectiveCompleted" => method(F::PIsObjectiveCompleted),
            "IsObjectiveFailed" => method(F::PIsObjectiveFailed),
            "GetObjectiveDescription" => method(F::PGetObjectiveDescription),
            "GetObjectiveType" => method(F::PGetObjectiveType),
            "HasNoRequiredUnits" => method(F::PHasNoRequiredUnits),
            "Build" => method(F::PBuild),
            "IsProducing" => method(F::PIsProducing),
            "IsAlliedWith" => method(F::PIsAlliedWith),
            "GrantCondition" => method(F::PGrantCondition),
            "RevokeCondition" => method(F::PRevokeCondition),
            "AcceptsCondition" => method(F::PAcceptsCondition),
            "TriggerPowerOutage" => method(F::PTriggerPowerOutage),
            _ => {
                let _ = lua;
                err(format!("Player does not define a member '{k}'"))
            }
        }
    }

    pub(crate) fn player_set(&mut self, obj: UserData, k: &str, v: Value) -> R<()> {
        let p = obj.a as u8;
        if p as usize >= self.w.players.len() {
            return err("invalid player");
        }
        let n = || v.to_num().map(to_int).ok_or_else(|| LuaError::runtime(format!("Player.{k} must be a number")));
        match k {
            "Cash" => {
                self.w.players[p as usize].cash = n()?.clamp(0, i32::MAX as i64) as i32;
                Ok(())
            }
            "Resources" => {
                let pl = &mut self.w.players[p as usize];
                pl.resources = n()?.clamp(0, pl.storage.max(0) as i64) as i32;
                Ok(())
            }
            "PlayLowPowerNotification" => {
                if v.truthy() {
                    self.m.low_power_quiet.remove(&p);
                } else {
                    self.m.low_power_quiet.insert(p);
                }
                Ok(())
            }
            _ => err(format!("Player.{k} cannot be set")),
        }
    }

    pub(crate) fn player_call(&mut self, lua: &mut Lua, f: F, p: u8, a: &A) -> R<Vec<Value>> {
        let one = |v: Value| Ok(vec![v]);
        match f {
            F::PGetActors => {
                let v = self.actors_list(lua, |w, i| w.actors[i].owner == p);
                one(v)
            }
            F::PGetGroundAttackers => {
                // OpenRA: actors with AttackBase and Mobile (ground units that fight).
                let v = self.actors_list(lua, |w, i| {
                    let a = &w.actors[i];
                    let info = &w.rules.actors[a.ty as usize];
                    a.owner == p && !info.weapons.is_empty() && matches!(a.kind, Kind::Infantry | Kind::Vehicle | Kind::Ship)
                });
                one(v)
            }
            F::PGetActorsByType | F::PGetActorsByTypes => {
                let names: Vec<String> = if f == F::PGetActorsByType {
                    vec![a.string(0)?]
                } else {
                    self.collection(lua, a, 0)?.iter().map(|v| v.to_text().unwrap_or_default()).collect()
                };
                let mut types = Vec::new();
                let mut player_actor = false;
                for n in &names {
                    // The player actor itself (OpenRA's `player` actor type).
                    if n.eq_ignore_ascii_case("player") {
                        player_actor = true;
                        continue;
                    }
                    types.push(self.actor_type(n)? as u16);
                }
                let mut hs = if player_actor { vec![self.player_actor(p)] } else { Vec::new() };
                hs.extend(self.actors_matching(|w, i| w.actors[i].owner == p && types.contains(&w.actors[i].ty)));
                one(self.actor_list(lua, &hs))
            }
            F::PHasPrerequisites => {
                let names: Vec<String> = self.collection(lua, a, 0)?.iter().map(|v| v.to_text().unwrap_or_default()).collect();
                let has = names.iter().all(|n| {
                    self.w
                        .rules
                        .token(&n.to_ascii_lowercase())
                        .is_some_and(|t| self.w.players[p as usize].tokens.get(t as usize).copied().unwrap_or(false))
                });
                one(boolean(has))
            }
            F::PAddObjective | F::PAddPrimaryObjective | F::PAddSecondaryObjective => {
                let d = a.string(0)?;
                let (kind, required) = match f {
                    F::PAddObjective => (a.opt_string(1)?.unwrap_or_else(|| "Primary".into()), a.opt_bool(2, true)?),
                    F::PAddPrimaryObjective => ("Primary".into(), true),
                    _ => ("Secondary".into(), false),
                };
                one(num(self.add_objective(lua, p, d, kind, required) as i64))
            }
            F::PMarkCompletedObjective | F::PMarkFailedObjective => {
                let id = a.int(0)?;
                self.mark_objective(lua, p, id, f == F::PMarkCompletedObjective)?;
                Ok(Vec::new())
            }
            F::PIsObjectiveCompleted | F::PIsObjectiveFailed | F::PGetObjectiveDescription | F::PGetObjectiveType => {
                let id = a.int(0)?;
                let objs = &self.m.players[p as usize].objectives;
                if id < 0 || id as usize >= objs.len() {
                    return err("Objective ID is out of range.");
                }
                let o = &objs[id as usize];
                one(match f {
                    F::PIsObjectiveCompleted => boolean(o.state == ObjectiveState::Completed),
                    F::PIsObjectiveFailed => boolean(o.state == ObjectiveState::Failed),
                    F::PGetObjectiveDescription => text(&o.description),
                    _ => text(&o.kind),
                })
            }
            F::PHasNoRequiredUnits => one(boolean(self.w.has_no_required_units(p))),
            F::PBuild => self.player_build(lua, p, a),
            F::PIsProducing => {
                let ty = self.actor_type(&a.string(0)?)?;
                let q = crate::world::World::queue_type_index(self.w.rules.actors[ty].queue);
                let has_queue = self.w.has_producer(p, self.w.rules.actors[ty].queue);
                let busy = !has_queue
                    || self.m.builds.iter().any(|b| b.player == p && b.factory.is_none() && b.queues.contains(&q))
                    || !self.w.players[p as usize].queues[q].items.is_empty();
                one(boolean(busy))
            }
            F::PIsAlliedWith => {
                let q = a.player(0)?;
                one(boolean(self.w.are_allies(p, q)))
            }
            F::PGrantCondition => {
                let c = a.string(0)?;
                one(num(self.grant_player_condition(p, &c)? as i64))
            }
            F::PRevokeCondition => {
                let t = a.int(0)? as i32;
                self.revoke_player_condition(p, t);
                Ok(Vec::new())
            }
            F::PAcceptsCondition => {
                let c = a.string(0)?;
                one(boolean(self.m.data.bot_conditions.contains_key(&c)))
            }
            F::PTriggerPowerOutage => {
                // OpenRA PowerManager.TriggerPowerOutage: the player's
                // structures that a power outage disables go dark for a while.
                let ticks = a.int(0)?.max(0) as i32;
                let n = self.w.players.len();
                self.w.inf.outage.resize(n, (0, 0));
                let cur = self.w.inf.outage[p as usize].0;
                if ticks > cur {
                    self.w.inf.outage[p as usize] = (ticks, ticks);
                }
                Ok(Vec::new())
            }
            _ => err(format!("{} is not a player member", f.name())),
        }
    }

    /// The handle of player `p`'s PlayerActor.
    pub(crate) fn player_actor(&mut self, p: u8) -> u32 {
        if let Some(&h) = self.m.player_actors.get(&p) {
            return h;
        }
        let h = self.m.new_handle("player".into(), p, HState::PlayerActor);
        self.m.player_actors.insert(p, h);
        h
    }

    /// `player.Build(types, func)` (OpenRA ClassicProductionQueueProperties.Build):
    /// queue every type on its player queue; false when a queue it needs is
    /// missing or busy. `func(actors)` runs once all of them are built.
    fn player_build(&mut self, lua: &mut Lua, p: u8, a: &A) -> R<Vec<Value>> {
        let names: Vec<String> = self.collection(lua, a, 0)?.iter().map(|v| v.to_text().unwrap_or_default()).collect();
        let func = a.opt_func(1)?;
        let mut types = Vec::new();
        for n in &names {
            types.push(self.actor_type(n)? as u16);
        }
        let mut queues: Vec<usize> =
            types.iter().map(|&t| crate::world::World::queue_type_index(self.w.rules.actors[t as usize].queue)).collect();
        queues.sort_unstable();
        queues.dedup();
        for &q in &queues {
            let qt = crate::rules::QueueType::from_index(q);
            if !self.w.has_producer(p, qt) || self.m.builds.iter().any(|b| b.player == p && b.factory.is_none() && b.queues.contains(&q)) {
                return Ok(vec![boolean(false)]);
            }
            if !self.w.players[p as usize].queues[q].items.is_empty() {
                return Ok(vec![boolean(false)]);
            }
        }
        if func.is_some() {
            self.m.builds.push(BuildOrder { player: p, queues: queues.clone(), factory: None, size: types.len(), squad: Vec::new(), func });
        }
        for &t in &types {
            self.w.start_production(p, t, 1);
        }
        Ok(vec![boolean(true)])
    }

    /// `factory.Build(types, func)` (OpenRA ProductionQueueProperties: a TD-style
    /// queue on the factory). RA factories have no own queue; the owner's
    /// queue builds and this factory delivers what it makes.
    pub(crate) fn factory_build(&mut self, lua: &mut Lua, h: u32, a: &A) -> R<Vec<Value>> {
        let names: Vec<String> = self.collection(lua, a, 0)?.iter().map(|v| v.to_text().unwrap_or_default()).collect();
        let func = a.opt_func(1)?;
        let Some(i) = self.engine_actor(h) else { return Ok(vec![boolean(false)]) };
        let p = self.w.actors[i].owner;
        if self.m.builds.iter().any(|b| b.factory == Some(h)) {
            return Ok(vec![boolean(false)]);
        }
        let mut types = Vec::new();
        for n in &names {
            types.push(self.actor_type(n)? as u16);
        }
        let mut queues: Vec<usize> =
            types.iter().map(|&t| crate::world::World::queue_type_index(self.w.rules.actors[t as usize].queue)).collect();
        queues.sort_unstable();
        queues.dedup();
        if queues.iter().any(|&q| !self.w.players[p as usize].queues[q].items.is_empty()) {
            return Ok(vec![boolean(false)]);
        }
        self.w.set_primary(i, true);
        self.m.builds.push(BuildOrder { player: p, queues, factory: Some(h), size: types.len(), squad: Vec::new(), func });
        for &t in &types {
            self.w.start_production(p, t, 1);
        }
        Ok(vec![boolean(true)])
    }
}

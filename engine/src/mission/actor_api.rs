//! Actor members for scripts (OpenRA's ScriptActorProperties: General,
//! Combat, Movement, Transports, Production, Ability, Support Powers),
//! `Actor.Create`, the `Reinforcements` global and the script activity runner.

use super::activities::{Act, Queue};
use super::api::*;
use super::setup::{facing_in, facing_out, stance_of};
use super::*;
use crate::infantry::EnterKind;
use crate::lua::{Lua, LuaError, UserData, Value};
use crate::math::{dist, CELL, HALF_CELL};
use crate::rules::Kind;
use crate::world::{cell_center, Activity, NONE};

/// Activities one actor may finish in one tick (instant ones chain).
const MAX_STEPS: usize = 32;

impl Ctx<'_> {
    // ---- Handle state ------------------------------------------------------------------

    /// The engine actor of a live handle.
    pub(crate) fn engine_actor(&self, h: u32) -> Option<usize> {
        match self.m.handle(h)?.state {
            HState::Live(r) => self.w.resolve(r),
            _ => None,
        }
    }

    pub(crate) fn is_dead(&self, h: u32) -> bool {
        match self.m.handle(h).map(|hd| &hd.state) {
            Some(HState::Live(r)) => self.w.resolve(*r).is_none(),
            Some(HState::Gone { died, at, .. }) => *died || *at != self.w.tick,
            None => true,
            Some(HState::Prop { alive, .. }) => !alive,
            Some(HState::Limbo(_) | HState::Marker { .. } | HState::PlayerActor) => false,
        }
    }

    pub(crate) fn in_world(&self, h: u32) -> bool {
        match self.m.handle(h).map(|hd| &hd.state) {
            Some(HState::Live(_)) => self.engine_actor(h).is_some_and(|i| self.w.actors[i].in_world()),
            Some(HState::Prop { alive, .. }) => *alive,
            Some(HState::Marker { .. } | HState::PlayerActor) => true,
            _ => false,
        }
    }

    /// OpenRA Actor.IsIdle: no activity, script or engine.
    pub(crate) fn is_idle(&self, h: u32) -> bool {
        if self.m.queues.get(&h).is_some_and(|q| !q.is_empty()) {
            return false;
        }
        match self.engine_actor(h) {
            Some(i) => self.engine_idle(i),
            None => !self.is_dead(h),
        }
    }

    fn engine_idle(&self, i: usize) -> bool {
        let a = &self.w.actors[i];
        if a.kind == Kind::Building {
            return true;
        }
        a.activity == Activity::Idle && a.waypoints.is_empty() && a.guard == NONE && a.inf.enter.is_none() && !a.air.rtb
    }

    /// World position (engine) of a handle, alive or not.
    pub(crate) fn position(&self, h: u32) -> Option<(i32, i32, i32)> {
        let hd = self.m.handle(h)?;
        match &hd.state {
            HState::Live(_) => self.engine_actor(h).map(|i| (self.w.actors[i].x, self.w.actors[i].y, self.w.actors[i].altitude)),
            HState::Gone { snap, .. } => Some((snap.x, snap.y, snap.altitude)),
            HState::Limbo(l) => Some((l.x, l.y, l.altitude.unwrap_or(0))),
            HState::Marker { x, y } | HState::Prop { x, y, .. } => Some((*x, *y, 0)),
            HState::PlayerActor => None,
        }
    }

    fn type_index(&self, h: u32) -> Option<usize> {
        self.w.rules.actor_index(&self.m.handle(h)?.ty)
    }

    fn info(&self, h: u32) -> Option<&crate::rules::ActorInfo> {
        self.type_index(h).map(|t| &self.w.rules.actors[t])
    }

    fn owner_of(&self, h: u32) -> u8 {
        match self.engine_actor(h) {
            Some(i) => self.w.actors[i].owner,
            None => self.m.handle(h).map_or(0, |hd| hd.owner),
        }
    }

    fn live(&self, h: u32, what: &str) -> R<usize> {
        self.engine_actor(h).ok_or_else(|| LuaError::runtime(format!("{what}: the actor is dead or not in the world")))
    }

    fn is_mobile_unit(&self, h: u32) -> bool {
        self.info(h).is_some_and(|i| i.unit.is_some() && i.kind != Kind::Building)
    }

    fn has_weapons(&self, h: u32) -> bool {
        self.info(h).is_some_and(|i| !i.weapons.is_empty())
    }

    fn is_aircraft(&self, h: u32) -> bool {
        self.info(h).is_some_and(|i| i.kind == Kind::Aircraft)
    }

    fn is_transport(&self, h: u32) -> bool {
        self.info(h).is_some_and(|i| i.abilities.cargo.is_some())
    }

    fn power_kind(&self, h: u32, kind: &str) -> Option<crate::rules::SupportPowerInfo> {
        self.info(h)?.abilities.support_powers.as_ref()?.iter().find(|p| p.kind == kind).cloned()
    }

    /// OpenRA Actor.HasScriptProperty: which members this actor has (its traits).
    pub(crate) fn has_property(&self, h: u32, name: &str) -> bool {
        let Some(hd) = self.m.handle(h) else { return false };
        let body = self.info(h).is_some();
        let unit = self.is_mobile_unit(h);
        let building = self.info(h).is_some_and(|i| i.kind == Kind::Building);
        let armed = self.has_weapons(h);
        let prop = matches!(hd.state, HState::Prop { .. } | HState::Marker { .. });
        let abilities = self.info(h).map(|i| &i.abilities);
        match name {
            "IsInWorld" | "IsDead" | "IsIdle" | "Owner" | "Type" | "HasProperty" | "EffectiveOwner" | "Flash" | "CallFunc" | "Wait"
            | "Destroy" | "Stop" | "Teleport" | "Location" | "CenterPosition" | "AddTag" | "RemoveTag" | "HasTag" | "IsTaggable"
            | "Stance" | "TooltipName" => body || prop,
            "Facing" => body,
            "Health" | "MaxHealth" | "Kill" => body && !matches!(self.info(h).map(|i| i.kind), Some(Kind::Proxy)),
            "Hunt" | "AttackMove" | "Patrol" | "PatrolUntil" => armed && unit,
            "Attack" | "CanTarget" => armed,
            "Move" | "ScriptedMove" | "MoveIntoWorld" | "Scatter" | "EnterTransport" | "IsMobile" => unit,
            "Passengers" | "HasPassengers" | "PassengerCount" | "LoadPassenger" | "UnloadPassenger" | "UnloadPassengers" => {
                self.is_transport(h)
            }
            "Produce" | "Build" | "IsProducing" | "RallyPoint" => {
                building && self.info(h).is_some_and(|i| i.building.as_ref().is_some_and(|b| !b.produces.is_empty()))
            }
            "IsPrimaryBuilding" => self.info(h).is_some_and(|i| i.options.primary_building),
            "Capture" | "CanCapture" => abilities.is_some_and(|a| a.captures.is_some()),
            "Deploy" => abilities.is_some_and(|a| a.transforms.is_some()) || self.is_transport(h),
            "DisguiseAs" | "DisguiseAsType" => abilities.is_some_and(|a| a.disguise.is_some()),
            "Infiltrate" => abilities.is_some_and(|a| a.infiltrates.is_some()),
            "Demolish" => abilities.is_some_and(|a| a.demolition.is_some()),
            "InstantlyRepair" => abilities.is_some_and(|a| a.instantly_repairs.is_some()),
            "DeliverCash" => abilities.is_some_and(|a| a.delivers_cash.is_some()),
            "Guard" => unit,
            "ReturnToBase" | "Land" | "Resupply" | "AmmoCount" | "MaximumAmmoCount" | "Reload" => self.is_aircraft(h),
            "FindResources" => self.info(h).is_some_and(|i| i.unit.as_ref().is_some_and(|u| u.harvester.is_some())),
            "Paradrop" => self.is_aircraft(h) && self.is_transport(h),
            "TargetParatroopers" => self.power_kind(h, "ParatroopersPower").is_some(),
            "TargetAirstrike" => self.power_kind(h, "AirstrikePower").is_some(),
            "ActivateNukePower" => self.power_kind(h, "NukePower").is_some(),
            "Chronoshift" => self.power_kind(h, "ChronoshiftPower").is_some(),
            "GrantCondition" | "RevokeCondition" | "AcceptsCondition" => !self.external_conditions(h).is_empty(),
            "StartBuildingRepairs" | "StopBuildingRepairs" => {
                building && self.info(h).is_some_and(|i| i.building.as_ref().is_some_and(|b| b.repairable.is_some()))
            }
            "Sell" => building && self.info(h).is_some_and(|i| i.building.as_ref().is_some_and(|b| b.sell_refund > 0)),
            "Panic" => self.info(h).is_some_and(|i| i.world.scaredy_cat.is_some()),
            "IsCloaked" => abilities.is_some_and(|a| a.cloak.is_some()),
            _ => false,
        }
    }

    /// Conditions a script may grant this actor (ExternalCondition traits; mission rules).
    pub(crate) fn external_conditions(&self, h: u32) -> Vec<String> {
        let ty = self.m.handle(h).map(|hd| hd.ty.clone()).unwrap_or_default();
        self.m.data.conditions.get(&ty).map(|c| c.external.clone()).unwrap_or_default()
    }

    // ---- Properties ----------------------------------------------------------------------

    pub(crate) fn actor_get(&mut self, lua: &mut Lua, obj: UserData, k: &str) -> R<Value> {
        let h = obj.a as u32;
        let Some(hd) = self.m.handle(h).cloned() else { return err("invalid actor") };
        let method = |f: F| Ok(bound_fn(f, obj));
        let pos = self.position(h);
        match k {
            "IsInWorld" => return Ok(boolean(self.in_world(h))),
            "IsDead" => return Ok(boolean(self.is_dead(h))),
            "IsIdle" => return Ok(boolean(self.is_idle(h))),
            "Owner" | "EffectiveOwner" => {
                let o = self.owner_of(h);
                if k == "EffectiveOwner" {
                    if let Some(d) = self.engine_actor(h).and_then(|i| self.w.actors[i].inf.disguise) {
                        return Ok(player_value(d.owner));
                    }
                }
                return Ok(player_value(o));
            }
            "Type" => return Ok(text(&hd.ty.to_ascii_lowercase())),
            "Location" => {
                let (x, y, _) = pos.unwrap_or((0, 0, 0));
                return Ok(self.cpos_of(x, y));
            }
            "CenterPosition" => {
                let (x, y, z) = pos.unwrap_or((0, 0, 0));
                let (ox, oy) = self.m.pos_out(x, y);
                return Ok(wpos(ox, oy, z));
            }
            "IsTaggable" => return Ok(boolean(true)),
            "HasProperty" => return method(F::AHasProperty),
            "Flash" => return method(F::AFlash),
            "Teleport" => return method(F::ATeleport),
            "CallFunc" => return method(F::ACallFunc),
            "Wait" => return method(F::AWait),
            "Destroy" => return method(F::ADestroy),
            "Stop" => return method(F::AStop),
            "AddTag" => return method(F::AAddTag),
            "RemoveTag" => return method(F::ARemoveTag),
            "HasTag" => return method(F::AHasTag),
            _ => {}
        }
        if matches!(hd.state, HState::Marker { .. } | HState::Prop { .. } | HState::PlayerActor) {
            return err(format!("Actor ({}) does not define a member '{k}'", hd.ty));
        }
        if !self.has_property(h, k) {
            return err(format!("The property or method '{k}' is not supported by actor {}", hd.ty.to_ascii_lowercase()));
        }
        let i = self.engine_actor(h);
        let info = self.info(h).cloned().expect("engine type");
        match k {
            "Facing" => {
                let f = i.map(|i| self.w.actors[i].facing).or(match &hd.state {
                    HState::Gone { snap, .. } => Some(snap.facing),
                    HState::Limbo(l) => Some(l.facing),
                    _ => None,
                });
                Ok(angle(facing_out(f.unwrap_or(0))))
            }
            "Stance" => Ok(i.map_or(Value::Nil, |i| text(stance_name(self.w.actors[i].stance)))),
            "TooltipName" => Ok(text(&info.name)),
            "Health" => Ok(num(i.map_or(0, |i| self.w.actors[i].hp.max(0)) as i64)),
            "MaxHealth" => Ok(num(info.hp as i64)),
            "Passengers" => {
                let ps = i.map(|i| self.w.passengers(i)).unwrap_or_default();
                let hs: Vec<u32> = ps.into_iter().map(|p| self.handle_for(p)).collect();
                Ok(self.actor_list(lua, &hs))
            }
            "HasPassengers" => Ok(boolean(i.is_some_and(|i| !self.w.passengers(i).is_empty()))),
            "PassengerCount" => Ok(num(i.map_or(0, |i| self.w.passengers(i).len()) as i64)),
            "RallyPoint" => {
                let Some(i) = i else { return Ok(Value::Nil) };
                let a = &self.w.actors[i];
                let (x, y) = a.rally.unwrap_or_else(|| {
                    let b = info.building.as_ref().expect("producing structure");
                    let (ex, ey) = b.exits.first().map_or((b.width / 2, b.height), |&(x, y)| (x, y));
                    (cell_center(a.cx + ex), cell_center(a.cy + ey))
                });
                Ok(self.cpos_of(x, y))
            }
            "IsPrimaryBuilding" => Ok(boolean(i.is_some_and(|i| self.w.actors[i].primary))),
            "IsMobile" => Ok(boolean(i.is_some())),
            "IsCloaked" => Ok(boolean(i.is_some_and(|i| self.w.actors[i].submerged || self.w.actors[i].ab.cloaked))),
            _ => {
                let f = match k {
                    "Kill" => F::AKill,
                    "Hunt" => F::AHunt,
                    "AttackMove" => F::AAttackMove,
                    "Patrol" => F::APatrol,
                    "PatrolUntil" => F::APatrolUntil,
                    "Attack" => F::AAttack,
                    "CanTarget" => F::ACanTarget,
                    "Move" => F::AMove,
                    "ScriptedMove" => F::AScriptedMove,
                    "MoveIntoWorld" => F::AMoveIntoWorld,
                    "Scatter" => F::AScatter,
                    "EnterTransport" => F::AEnterTransport,
                    "LoadPassenger" => F::ALoadPassenger,
                    "UnloadPassenger" => F::AUnloadPassenger,
                    "UnloadPassengers" => F::AUnloadPassengers,
                    "Produce" => F::AProduce,
                    "Build" => F::ABuild,
                    "IsProducing" => F::AIsProducing,
                    "Capture" => F::ACapture,
                    "CanCapture" => F::ACanCapture,
                    "Deploy" => F::ADeploy,
                    "DisguiseAs" => F::ADisguiseAs,
                    "DisguiseAsType" => F::ADisguiseAsType,
                    "Infiltrate" => F::AInfiltrate,
                    "Demolish" => F::ADemolish,
                    "InstantlyRepair" => F::AInstantlyRepair,
                    "DeliverCash" => F::ADeliverCash,
                    "Guard" => F::AGuard,
                    "ReturnToBase" => F::AReturnToBase,
                    "Land" => F::ALand,
                    "Resupply" => F::AResupply,
                    "FindResources" => F::AFindResources,
                    "Paradrop" => F::AParadrop,
                    "TargetParatroopers" => F::ATargetParatroopers,
                    "TargetAirstrike" => F::ATargetAirstrike,
                    "ActivateNukePower" => F::AActivateNukePower,
                    "Chronoshift" => F::AChronoshift,
                    "GrantCondition" => F::AGrantCondition,
                    "RevokeCondition" => F::ARevokeCondition,
                    "AcceptsCondition" => F::AAcceptsCondition,
                    "StartBuildingRepairs" => F::AStartBuildingRepairs,
                    "StopBuildingRepairs" => F::AStopBuildingRepairs,
                    "Sell" => F::ASell,
                    "Panic" => F::APanic,
                    "AmmoCount" => F::AAmmoCount,
                    "MaximumAmmoCount" => F::AMaximumAmmoCount,
                    "Reload" => F::AReload,
                    _ => return err(format!("The property or method '{k}' is not supported by actor {}", hd.ty.to_ascii_lowercase())),
                };
                method(f)
            }
        }
    }

    pub(crate) fn actor_set(&mut self, lua: &mut Lua, obj: UserData, k: &str, v: Value) -> R<()> {
        let h = obj.a as u32;
        if self.m.handle(h).is_none() {
            return err("invalid actor");
        }
        match k {
            "Owner" => {
                let Some(u) = v.as_userdata().filter(|u| u.kind == UD_PLAYER) else {
                    return err("Attempted to change the owner of an actor to nil value.");
                };
                let p = u.a as u8;
                match self.engine_actor(h) {
                    Some(i) if self.w.actors[i].owner != p => {
                        self.w.change_owner(i, p, true);
                        self.m.handles[h as usize].owner = p;
                    }
                    Some(_) => {}
                    None => self.m.handles[h as usize].owner = p,
                }
                Ok(())
            }
            "Health" => {
                let hp = v.to_num().map(to_int).ok_or_else(|| LuaError::runtime("Health must be a number"))?;
                let i = self.live(h, "Health")?;
                let max = self.w.rules.actors[self.w.actors[i].ty as usize].hp as i64;
                let hp = hp.clamp(0, max) as i32;
                // OpenRA InflictDamage(self, self, HP - value): lower health is
                // damage (and death at 0), higher is healing.
                let cur = self.w.actors[i].hp;
                if hp <= 0 {
                    self.w.kill_source = self.w.make_ref(i);
                    self.w.kill(i);
                } else if hp < cur {
                    let r = self.w.make_ref(i);
                    self.w.actors[i].hp = hp;
                    self.w.script_event(ScriptEvent::Damaged { victim: r, attacker: r, damage: cur - hp });
                } else {
                    self.w.actors[i].hp = hp;
                }
                Ok(())
            }
            "Stance" => {
                let s = v
                    .to_text()
                    .and_then(|s| stance_of(&s))
                    .ok_or_else(|| LuaError::runtime(format!("Unknown stance type '{}'", v.to_text().unwrap_or_default())))?;
                if let Some(i) = self.engine_actor(h) {
                    if self.w.rules.actors[self.w.actors[i].ty as usize].stance.is_some() {
                        self.w.actors[i].stance = s;
                    }
                }
                Ok(())
            }
            "IsInWorld" => {
                if v.truthy() {
                    self.add_to_world(lua, h)
                } else {
                    if let Some(i) = self.engine_actor(h) {
                        let snap = Snapshot::of(self.w, i);
                        self.w.remove(i);
                        // Taken out of the world, not dead: it can come back.
                        let limbo =
                            Limbo { x: snap.x, y: snap.y, altitude: Some(snap.altitude), facing: snap.facing, health: None, stance: None };
                        let r = self.w.make_ref(i);
                        self.m.handle_of.remove(&r);
                        self.m.handles[h as usize].state = HState::Limbo(limbo);
                        self.w.script_events.retain(|e| !matches!(e, ScriptEvent::Removed { actor, .. } if *actor == r));
                        self.removed_from_world(lua, h);
                    }
                    Ok(())
                }
            }
            "RallyPoint" => {
                let Some(u) = v.as_userdata().filter(|u| u.kind == UD_CPOS) else { return err("RallyPoint must be a CPos") };
                let i = self.live(h, "RallyPoint")?;
                let (x, y) = self.cell_center_in(u.a, u.b);
                self.w.actors[i].rally = Some((x, y));
                Ok(())
            }
            "IsPrimaryBuilding" => {
                let i = self.live(h, "IsPrimaryBuilding")?;
                self.w.set_primary(i, v.truthy());
                Ok(())
            }
            _ => err(format!("The property '{k}' of actor {} cannot be set", self.m.handles[h as usize].ty.to_ascii_lowercase())),
        }
    }

    // ---- Methods ----------------------------------------------------------------------

    fn queue(&mut self, h: u32, act: Act) {
        self.m.queues.entry(h).or_default().push(act);
    }

    pub(crate) fn actor_call(&mut self, lua: &mut Lua, f: F, h: u32, a: &A) -> R<Vec<Value>> {
        let none = Ok(Vec::new());
        match f {
            F::AHasProperty => {
                let name = a.string(0)?;
                Ok(vec![boolean(self.has_property(h, &name))])
            }
            F::AFlash => none,
            F::ATeleport => {
                let (cx, cy) = a.cpos(0)?;
                let cell = self.m.cell_in(cx, cy);
                if let Some(HState::Prop { x, y, .. }) = self.m.handles.get_mut(h as usize).map(|hd| &mut hd.state) {
                    // A camera that moves (allies-03b's camera.jeep).
                    *x = cell.0 * CELL + HALF_CELL;
                    *y = cell.1 * CELL + HALF_CELL;
                    return none;
                }
                self.queue(h, Act::Teleport(cell));
                none
            }
            F::ACallFunc => {
                let func = a.func(0)?;
                self.queue(h, Act::CallFunc(func, Vec::new()));
                none
            }
            F::AWait => {
                let t = a.int(0)?;
                self.queue(h, Act::Wait(t as i32));
                none
            }
            F::ADestroy => {
                if let Some(HState::Prop { alive, .. }) = self.m.handles.get_mut(h as usize).map(|hd| &mut hd.state) {
                    *alive = false;
                    return none;
                }
                if matches!(self.m.handles[h as usize].state, HState::Limbo(_)) {
                    // Never in the world: it just goes (RemoveSelf on an actor outside the world).
                    let hd = &self.m.handles[h as usize];
                    let ty = self.w.rules.actor_index(&hd.ty).unwrap_or(0) as u16;
                    let HState::Limbo(l) = &hd.state else { unreachable!() };
                    let snap = Snapshot { ty, owner: hd.owner, x: l.x, y: l.y, altitude: l.altitude.unwrap_or(0), facing: l.facing };
                    self.m.handles[h as usize].state = HState::Gone { snap, died: false, at: self.w.tick };
                    return none;
                }
                self.queue(h, Act::Destroy);
                none
            }
            F::AStop => {
                self.m.queues.remove(&h);
                if let Some(i) = self.engine_actor(h) {
                    self.stop_engine(i);
                }
                none
            }
            F::AAddTag => {
                let t = a.string(0)?;
                let tags = &mut self.m.handles[h as usize].tags;
                let added = !tags.contains(&t);
                if added {
                    tags.push(t);
                }
                Ok(vec![boolean(added)])
            }
            F::ARemoveTag => {
                let t = a.string(0)?;
                let tags = &mut self.m.handles[h as usize].tags;
                let had = tags.contains(&t);
                tags.retain(|x| *x != t);
                Ok(vec![boolean(had)])
            }
            F::AHasTag => {
                let t = a.string(0)?;
                Ok(vec![boolean(self.m.handles[h as usize].tags.contains(&t))])
            }
            F::AHunt => {
                self.queue(h, Act::Hunt);
                none
            }
            F::AAttackMove | F::AMove | F::AScriptedMove | F::AMoveIntoWorld => {
                let (cx, cy) = a.cpos(0)?;
                let close = if matches!(f, F::AAttackMove | F::AMove) { a.opt_int(1, 0)? as i32 } else { 0 };
                let cell = self.m.cell_in(cx, cy);
                let act = match f {
                    F::AMoveIntoWorld => Act::MoveIntoWorld(cell),
                    _ => Act::Move { cell, close, attack: f == F::AAttackMove },
                };
                self.queue(h, act);
                none
            }
            F::APatrol => {
                let cells = self.cells_arg(lua, a, 0)?;
                let looping = a.opt_bool(1, true)?;
                let wait = a.opt_int(2, 0)? as i32;
                self.queue_patrol(h, &cells, wait);
                if looping {
                    self.queue(h, Act::PatrolLoop { cells, wait });
                }
                none
            }
            F::APatrolUntil => {
                let cells = self.cells_arg(lua, a, 0)?;
                let func = a.func(1)?;
                let wait = a.opt_int(2, 0)? as i32;
                self.queue_patrol(h, &cells, wait);
                let again = lua.call(self, &func, vec![actor_value(h)])?.first().is_some_and(Value::truthy);
                if again {
                    self.queue(h, Act::PatrolUntil { cells, func, wait });
                }
                none
            }
            F::AAttack => {
                let t = a.actor(0)?;
                let allow_move = a.opt_bool(1, true)?;
                let force = a.opt_bool(2, false)?;
                self.queue(h, Act::Attack { target: t, allow_move, force });
                none
            }
            F::ACanTarget => {
                let t = a.actor(0)?;
                let ok = match (self.engine_actor(h), self.engine_actor(t)) {
                    (Some(i), Some(ti)) => self.w.actors[ti].in_world() && self.can_attack(i, ti),
                    _ => false,
                };
                Ok(vec![boolean(ok)])
            }
            F::AScatter => {
                self.queue(h, Act::Scatter);
                none
            }
            F::AEnterTransport => {
                let t = a.actor(0)?;
                self.queue(h, Act::EnterTransport(t));
                none
            }
            F::AKill => {
                if let Some(i) = self.engine_actor(h) {
                    self.w.kill_source = self.w.make_ref(i);
                    self.w.kill(i);
                }
                none
            }
            F::ALoadPassenger => {
                let p = a.actor(0)?;
                let t = self.live(h, "LoadPassenger")?;
                if !self.is_idle(p) {
                    return err("LoadPassenger requires the passenger to be idle.");
                }
                let pi = match self.engine_actor(p) {
                    Some(pi) => pi,
                    None => self.spawn_from_limbo(lua, p, None)?,
                };
                self.w.load_passenger(t, pi);
                none
            }
            F::AUnloadPassenger => {
                let t = self.live(h, "UnloadPassenger")?;
                let which = if a.has(0) { Some(a.actor(0)?) } else { None };
                let ps = self.w.passengers(t);
                let target = match which {
                    Some(p) => self.engine_actor(p).filter(|pi| ps.contains(pi)),
                    None => ps.last().copied(),
                };
                let Some(pi) = target else { return Ok(vec![Value::Nil]) };
                // Out of the transport but not into the world: limbo, like OpenRA's Cargo.Unload.
                let ph = self.handle_for(pi);
                let r = self.w.make_ref(t);
                let pref = self.w.make_ref(pi);
                self.w.actors[t].cargo.retain(|&c| c != pref);
                let snap = Snapshot::of(self.w, pi);
                self.w.actors[pi].carrier = NONE;
                self.w.remove(pi);
                let pr = self.w.make_ref(pi);
                self.m.handle_of.remove(&pr);
                self.w.script_events.retain(|e| !matches!(e, ScriptEvent::Removed { actor, .. } if *actor == pr));
                let _ = r;
                self.m.handles[ph as usize].state =
                    HState::Limbo(Limbo { x: snap.x, y: snap.y, altitude: Some(0), facing: snap.facing, health: None, stance: None });
                Ok(vec![actor_value(ph)])
            }
            F::AUnloadPassengers => {
                let cell = if a.has(0) {
                    let (cx, cy) = a.cpos(0)?;
                    Some(self.m.cell_in(cx, cy))
                } else {
                    None
                };
                let range = a.opt_int(1, 5)? as i32;
                self.queue(h, Act::Unload { cell, range });
                none
            }
            F::AProduce => {
                let ty = self.actor_type(&a.string(0)?)? as u16;
                self.queue(h, Act::Produce { ty });
                none
            }
            F::ABuild => self.factory_build(lua, h, a),
            F::AIsProducing => {
                let ty = self.actor_type(&a.string(0)?)?;
                let owner = self.owner_of(h);
                let q = crate::world::World::queue_type_index(self.w.rules.actors[ty].queue);
                let busy = self.m.builds.iter().any(|b| b.factory == Some(h)) || !self.w.players[owner as usize].queues[q].items.is_empty();
                Ok(vec![boolean(busy)])
            }
            F::ACapture | F::AInfiltrate | F::ADemolish | F::AInstantlyRepair => {
                let t = a.actor(0)?;
                let kind = match f {
                    F::ACapture => EnterKind::Capture,
                    F::AInfiltrate => EnterKind::Infiltrate,
                    F::ADemolish => EnterKind::Demolish,
                    _ => EnterKind::InstantRepair,
                };
                if f == F::AInfiltrate {
                    let (i, ti) = (self.live(h, "Infiltrate")?, self.live(t, "Infiltrate")?);
                    if !self.w.can_infiltrate(i, ti) {
                        return err(format!(
                            "Actor ({}) tried to infiltrate invalid target {}!",
                            self.m.handles[h as usize].ty.to_ascii_lowercase(),
                            self.m.handles[t as usize].ty.to_ascii_lowercase()
                        ));
                    }
                }
                if f == F::ACapture && !self.can_capture(h, t) {
                    return none;
                }
                self.queue(h, Act::Enter { kind, target: t });
                none
            }
            F::ACanCapture => {
                let t = a.actor(0)?;
                Ok(vec![boolean(self.can_capture(h, t))])
            }
            F::ADeploy => {
                self.queue(h, Act::Deploy);
                none
            }
            F::ADisguiseAs => {
                let t = a.actor(0)?;
                if let (Some(i), Some(ti)) = (self.engine_actor(h), self.engine_actor(t)) {
                    self.w.disguise_as(i, ti);
                }
                none
            }
            F::ADisguiseAsType => {
                let ty = self.actor_type(&a.string(0)?)? as u16;
                let owner = a.player(1)?;
                let i = self.live(h, "DisguiseAsType")?;
                let me = &self.w.actors[i];
                self.w.actors[i].inf.disguise =
                    if ty == me.ty && owner == me.owner { None } else { Some(crate::infantry::Disguise { ty, owner }) };
                none
            }
            F::ADeliverCash => {
                let t = a.actor(0)?;
                self.queue(h, Act::DeliverCash(t));
                none
            }
            F::AGuard => {
                let t = a.actor(0)?;
                self.queue(h, Act::Guard(t));
                none
            }
            F::AReturnToBase => {
                let dest = if a.has(0) { Some(a.actor(0)?) } else { None };
                self.queue(h, Act::ReturnToBase(dest));
                none
            }
            F::ALand => {
                let t = a.actor(0)?;
                self.queue(h, Act::Land(t));
                none
            }
            F::AResupply => {
                self.queue(h, Act::Resupply);
                none
            }
            F::AFindResources => {
                self.queue(h, Act::FindResources);
                none
            }
            F::AParadrop => {
                let (cx, cy) = a.cpos(0)?;
                let cell = self.m.cell_in(cx, cy);
                self.queue(h, Act::Paradrop(cell));
                self.queue(h, Act::FlyOffMap);
                self.queue(h, Act::Destroy);
                none
            }
            F::ATargetParatroopers | F::ATargetAirstrike => {
                let (x, y, _) = a.wpos(0)?;
                let facing = a.opt_angle(1)?;
                let kind = if f == F::ATargetParatroopers { "ParatroopersPower" } else { "AirstrikePower" };
                let info = self.power_kind(h, kind).ok_or_else(|| LuaError::runtime(format!("{}: no {kind}", f.name())))?;
                let owner = self.owner_of(h);
                let (ex, ey) = self.m.pos_in(x, y);
                // The planes fly along `facing` (OpenRA: toward the target from
                // behind it); without one, from the owner's side.
                let dir = facing.map(|fa| {
                    let (vx, vy) = crate::math::facing_vec(facing_in(fa));
                    (ex + vx, ey + vy)
                });
                let ty = self.type_index(h).unwrap_or(0) as u16;
                let planes = self.w.launch_air_power(owner, &info, crate::sound_events::power_ref(ty, 0), ex, ey, dir).unwrap_or_default();
                let code = crate::sound_events::power_code(&info.kind);
                self.w.sound.push(
                    crate::sound_events::SoundEventKind::PowerActivated,
                    code,
                    ex,
                    ey,
                    owner,
                    crate::sound_events::power_ref(ty, 0),
                );
                self.fire_support_power_trigger(lua, h, &info.key)?;
                let hs: Vec<u32> = planes.into_iter().map(|p| self.handle_for(p)).collect();
                Ok(vec![self.actor_list(lua, &hs)])
            }
            F::AActivateNukePower => {
                let (cx, cy) = a.cpos(0)?;
                let info = self.power_kind(h, "NukePower").ok_or_else(|| LuaError::runtime("ActivateNukePower: no NukePower"))?;
                let owner = self.owner_of(h);
                let (x, y) = self.cell_center_in(cx, cy);
                // Targets outside the map (allies-10a aims at 127,127) land on its edge.
                let (x, y) = (x.clamp(0, self.w.map.width * CELL - 1), y.clamp(0, self.w.map.height * CELL - 1));
                self.w.fire_nuke(owner, &info, x, y);
                self.fire_support_power_trigger(lua, h, &info.key)?;
                none
            }
            F::AChronoshift => {
                let t = a.table(0)?;
                let duration = a.opt_int(1, 0)?;
                let kill_cargo = a.opt_bool(2, false)?;
                for (k, v) in lua.pairs(t) {
                    let (Some(ku), Some(vu)) = (k.as_userdata(), v.as_userdata()) else {
                        return err("Chronoshift requires a table of actor,cpos pairs.");
                    };
                    if ku.kind != UD_ACTOR || vu.kind != UD_CPOS {
                        return err("Chronoshift requires a table of actor,cpos pairs.");
                    }
                    let Some(i) = self.engine_actor(ku.a as u32) else { continue };
                    let (x, y) = self.cell_center_in(vu.a, vu.b);
                    self.chronoshift(i, x, y, duration as i32, kill_cargo);
                }
                none
            }
            F::AGrantCondition => {
                let c = a.string(0)?;
                let duration = a.opt_int(1, 0)? as i32;
                Ok(vec![num(self.grant_actor_condition(h, &c, duration)? as i64)])
            }
            F::ARevokeCondition => {
                let token = a.int(0)? as i32;
                self.revoke_actor_condition(h, token);
                none
            }
            F::AAcceptsCondition => {
                let c = a.string(0)?;
                Ok(vec![boolean(self.external_conditions(h).contains(&c))])
            }
            F::AStartBuildingRepairs | F::AStopBuildingRepairs => {
                let p = a.opt_player(0)?.unwrap_or_else(|| self.owner_of(h));
                let i = self.live(h, f.name())?;
                let active = self.w.actors[i].repairers.contains(&p);
                if (f == F::AStartBuildingRepairs) != active && self.w.can_toggle_repair(p, i) {
                    self.w.toggle_repair(p, i);
                }
                none
            }
            F::ASell => {
                let i = self.live(h, "Sell")?;
                self.w.sell(i);
                none
            }
            F::APanic => {
                if let Some(i) = self.engine_actor(h) {
                    self.m.queues.remove(&h);
                    self.w.panic(i);
                }
                none
            }
            F::AAmmoCount | F::AMaximumAmmoCount => {
                let pool = a.opt_string(0)?.unwrap_or_else(|| "primary".into());
                if pool != "primary" {
                    return err(format!(
                        "Invalid ammopool name {pool} queried on actor {}.",
                        self.m.handles[h as usize].ty.to_ascii_lowercase()
                    ));
                }
                let i = self.live(h, f.name())?;
                let v = if f == F::AAmmoCount { self.w.ammo_left(i) } else { self.w.max_ammo(i) };
                Ok(vec![num(v as i64)])
            }
            F::AReload => {
                let i = self.live(h, "Reload")?;
                let amount = a.opt_int(1, 1)? as i32;
                let spent = &mut self.w.actors[i].air.spent;
                *spent = (*spent - amount).max(0);
                none
            }
            _ => err(format!("{} is not an actor member", f.name())),
        }
    }

    fn fire_support_power_trigger(&mut self, lua: &mut Lua, h: u32, key: &str) -> R<()> {
        for f in self.m.triggers.actor_callbacks(h, super::triggers::ActorTrigger::OnSupportPowerActivated) {
            lua.call(self, &f, vec![actor_value(h), text(key)])?;
        }
        Ok(())
    }

    /// OpenRA ChronoshiftPower on one actor (Chronoshiftable.Teleport): to the
    /// cell, for `duration` ticks (0: for good); passengers die with `kill_cargo`.
    fn chronoshift(&mut self, i: usize, x: i32, y: i32, duration: i32, kill_cargo: bool) {
        if !self.w.actors[i].is_unit() {
            return;
        }
        let (ox, oy) = (self.w.actors[i].x, self.w.actors[i].y);
        self.w.teleport(i, x, y);
        if kill_cargo {
            for p in self.w.passengers(i) {
                self.w.kill(p);
            }
        }
        if duration > 0 {
            let origin = self.w.actors[i].ab.chrono_return.map_or((ox, oy), |(x, y, _)| (x, y));
            self.w.actors[i].ab.chrono_return = Some((origin.0, origin.1, self.w.tick + duration as u32));
        }
    }

    fn can_attack(&self, i: usize, t: usize) -> bool {
        let class = self.w.target_class(t);
        self.w.rules.actors[self.w.actors[i].ty as usize].weapons.iter().any(|&w| {
            let wi = &self.w.rules.weapons[w];
            wi.valid & class != 0 && wi.invalid & class == 0
        })
    }

    fn can_capture(&self, h: u32, t: u32) -> bool {
        match (self.engine_actor(h), self.engine_actor(t)) {
            (Some(i), Some(ti)) => self.w.can_capture(i, ti),
            _ => false,
        }
    }

    fn cells_arg(&mut self, lua: &mut Lua, a: &A, i: usize) -> R<Vec<(i32, i32)>> {
        let mut out = Vec::new();
        for v in self.collection(lua, a, i)? {
            match v.as_userdata() {
                Some(u) if u.kind == UD_CPOS => out.push(self.m.cell_in(u.a, u.b)),
                _ => return err(format!("{}: waypoints must be CPos values", a.f.name())),
            }
        }
        Ok(out)
    }

    /// OpenRA CombatProperties.Patrol: attack-move to each waypoint (within 2 cells), then wait.
    fn queue_patrol(&mut self, h: u32, cells: &[(i32, i32)], wait: i32) {
        for &c in cells {
            self.queue(h, Act::Move { cell: c, close: 2, attack: true });
            self.queue(h, Act::Wait(wait));
        }
    }

    /// Stop what the engine does with an actor (OpenRA CancelActivity).
    fn stop_engine(&mut self, i: usize) {
        self.w.release_dock(i);
        self.w.clear_commands(i);
        let a = &mut self.w.actors[i];
        if a.kind != Kind::Building {
            a.activity = Activity::Idle;
            a.goal = NONE;
        }
        a.target = NONE;
        a.attack_move = false;
        a.inf.enter = None;
        a.air.new_order();
    }

    // ---- Creating actors ---------------------------------------------------------------

    /// Actor.Create(type, addToWorld, inits): an actor of `type` with the
    /// OpenRA inits Owner, Location, CenterPosition, Facing, Health, Stance,
    /// SubCell, Faction; in the world at once with `add`.
    pub(crate) fn create_actor(&mut self, lua: &mut Lua, ty: &str, add: bool, inits: u32) -> R<Value> {
        let mut owner = None;
        let mut cell = None;
        let mut center = None;
        let mut facing = None;
        let mut health = None;
        let mut stance = None;
        let mut subcell = None;
        for (k, v) in lua.pairs(inits) {
            let key = k.to_text().unwrap_or_default();
            match key.as_str() {
                "Owner" => owner = v.as_userdata().filter(|u| u.kind == UD_PLAYER).map(|u| u.a as u8),
                "Location" => cell = v.as_userdata().filter(|u| u.kind == UD_CPOS).map(|u| (u.a, u.b)),
                "CenterPosition" => center = v.as_userdata().filter(|u| u.kind == UD_WPOS).map(|u| (u.a, u.b, u.c)),
                "Facing" => {
                    facing = match &v {
                        Value::UserData(u) if u.kind == UD_ANGLE => Some(u.a),
                        // MapFormat 12 numbers are WAngle units already.
                        Value::Num(n) => Some(to_int(*n) as i32),
                        _ => return err("Invalid data type for 'Facing'"),
                    }
                }
                "Health" => health = v.to_num().map(|n| to_int(n) as i32),
                "Stance" => stance = v.to_text().and_then(|s| stance_of(&s)),
                "SubCell" => subcell = v.to_num().map(|n| to_int(n) as i32),
                "Faction" | "FreeActor" | "TurretFacing" | "ScriptTags" | "Plug" | "DeployState" => {}
                other => return err(format!("Unknown initializer type '{other}'")),
            }
        }
        let owner = owner.ok_or_else(|| LuaError::runtime(format!("Tried to create actor '{ty}' with an invalid or no owner init!")))?;
        let (x, y) = match (center, cell) {
            (Some((x, y, _)), _) => self.m.pos_in(x, y),
            (None, Some((cx, cy))) => {
                let (x, y) = self.cell_center_in(cx, cy);
                let (ox, oy) = subcell.map_or((0, 0), World::mission_subcell_offset);
                (x + ox, y + oy)
            }
            (None, None) => (0, 0),
        };
        let altitude = center.map(|(_, _, z)| z);
        let lower = ty.to_ascii_lowercase();
        if let Some(p) = self.m.data.props.get(&lower).cloned() {
            let state = HState::Prop { x, y, reveal: p.reveal, image: p.image, alive: add };
            let h = self.m.new_handle(lower, owner, state);
            return Ok(actor_value(h));
        }
        let t = self.actor_type(ty)?;
        let id = self.w.rules.actors[t].id.clone();
        let limbo = Limbo { x, y, altitude, facing: facing.map_or(512, facing_in), health, stance };
        let h = self.m.new_handle(id, owner, HState::Limbo(limbo));
        if add && self.w.rules.actors[t].kind != Kind::Proxy {
            // OpenRA adds it at the end of the frame: here at once, which a script cannot tell apart.
            self.add_to_world(lua, h)?;
        }
        Ok(actor_value(h))
    }

    /// Put a limbo actor into the world (Actor.Create with addToWorld, IsInWorld = true).
    fn add_to_world(&mut self, lua: &mut Lua, h: u32) -> R<()> {
        if !matches!(self.m.handles[h as usize].state, HState::Limbo(_)) {
            return Ok(());
        }
        self.spawn_from_limbo(lua, h, None)?;
        self.added_to_world(lua, h);
        Ok(())
    }

    /// The engine actor of a limbo handle, spawned where its inits say (or at `at`).
    fn spawn_from_limbo(&mut self, _lua: &mut Lua, h: u32, at: Option<(i32, i32)>) -> R<usize> {
        let hd = self.m.handles[h as usize].clone();
        let HState::Limbo(l) = &hd.state else { return err("the actor is already in the world") };
        let t = self.actor_type(&hd.ty)?;
        let (x, y) = at.unwrap_or((l.x, l.y));
        let kind = self.w.rules.actors[t].kind;
        let i = match kind {
            Kind::Building => {
                let (cx, cy) = (x.div_euclid(CELL), y.div_euclid(CELL));
                let b = self.w.rules.actors[t].building.as_ref().expect("structure");
                // Actor.Create places structures by their top-left cell.
                let _ = b;
                self.w
                    .spawn_building(t as u16, hd.owner, cx, cy)
                    .ok_or_else(|| LuaError::runtime(format!("Actor.Create: cannot place {} here", hd.ty)))?
            }
            Kind::Proxy => return err("power proxies have no body"),
            Kind::Husk => {
                let (cx, cy) = (x.div_euclid(CELL), y.div_euclid(CELL));
                self.w.place_husk(t, hd.owner, cell_center(cx), cell_center(cy), l.facing, 0)
            }
            Kind::Crate => {
                let (cx, cy) = (x.div_euclid(CELL), y.div_euclid(CELL));
                if !self.w.map.contains(cx, cy) {
                    return err("Actor.Create: the crate is outside the map");
                }
                self.w.place_crate(t, hd.owner, cx, cy, 0)
            }
            _ => {
                // A ground unit made inside a structure (Einstein at the lab's
                // door) steps out to the nearest open cell, as OpenRA's Nudge does.
                let (x, y) = if kind == Kind::Aircraft { (x, y) } else { self.open_spot(t, x, y) };
                let u = self.w.spawn_unit(t as u16, hd.owner, x, y, l.facing);
                if let Some(alt) = l.altitude {
                    if kind == Kind::Aircraft {
                        self.w.actors[u].altitude = alt;
                        if alt == 0 && !self.w.is_plane(u) {
                            self.w.actors[u].heli.landed = true;
                        }
                    }
                }
                u
            }
        };
        if let Some(pct) = l.health {
            let max = self.w.rules.actors[t].hp as i64;
            self.w.actors[i].hp = ((max * pct.clamp(1, 100) as i64) / 100).max(1) as i32;
        }
        if let Some(s) = l.stance {
            self.w.actors[i].stance = s;
        }
        let r = self.w.make_ref(i);
        self.m.handles[h as usize].state = HState::Live(r);
        self.m.handle_of.insert(r, h);
        Ok(i)
    }

    /// (x, y), or the center of the nearest cell a unit of type `t` can stand on.
    fn open_spot(&self, t: usize, x: i32, y: i32) -> (i32, i32) {
        let Some(u) = self.w.rules.actors[t].unit.as_ref() else { return (x, y) };
        let pass = self.w.pass_for(self.w.rules.locomotors[u.locomotor].domain);
        let (cx, cy) = (x.div_euclid(CELL), y.div_euclid(CELL));
        if !self.w.map.contains(cx, cy) || !pass.blocked[self.w.map.idx(cx, cy)] {
            return (x, y);
        }
        for r in 1..8i32 {
            let mut best: Option<(i32, (i32, i32))> = None;
            for dy in -r..=r {
                for dx in -r..=r {
                    if dx.abs() != r && dy.abs() != r {
                        continue;
                    }
                    let (nx, ny) = (cx + dx, cy + dy);
                    if self.w.map.contains(nx, ny) && !pass.blocked[self.w.map.idx(nx, ny)] {
                        let d = dx * dx + dy * dy;
                        if best.is_none_or(|(bd, _)| d < bd) {
                            best = Some((d, (nx, ny)));
                        }
                    }
                }
            }
            if let Some((_, (nx, ny))) = best {
                return (cell_center(nx), cell_center(ny));
            }
        }
        (x, y)
    }

    // ---- Reinforcements (OpenRA ReinforcementsGlobal) ----------------------------------------

    fn path_arg(&mut self, lua: &mut Lua, a: &A, i: usize) -> R<Vec<(i32, i32)>> {
        let mut out = Vec::new();
        for v in self.collection(lua, a, i)? {
            match v.as_userdata() {
                Some(u) if u.kind == UD_CPOS => out.push((u.a, u.b)),
                _ => return err(format!("{}: paths must be CPos values", a.f.name())),
            }
        }
        Ok(out)
    }

    /// A reinforcement actor in limbo at the path's first cell, facing along the path.
    fn reinforcement(&mut self, ty: &str, owner: u8, path: &[(i32, i32)]) -> R<u32> {
        let t = self.actor_type(ty)?;
        let (sx, sy) = path[0];
        let (x, y) = self.cell_center_in(sx, sy);
        let facing = match path.get(1) {
            Some(&(nx, ny)) => facing_of_cells(nx - sx, ny - sy),
            None => 512,
        };
        let altitude = self.w.rules.actors[t].unit.as_ref().and_then(|u| u.aircraft.as_ref()).map(|ac| ac.cruise_altitude);
        let id = self.w.rules.actors[t].id.clone();
        let limbo = Limbo { x, y, altitude, facing, health: None, stance: None };
        Ok(self.m.new_handle(id, owner, HState::Limbo(limbo)))
    }

    pub(crate) fn reinforce(&mut self, lua: &mut Lua, a: &A) -> R<Vec<Value>> {
        let owner = a.player(0)?;
        let types: Vec<String> = self.collection(lua, a, 1)?.iter().map(|v| v.to_text().unwrap_or_default()).collect();
        let path = self.path_arg(lua, a, 2)?;
        if path.is_empty() {
            return err("Reinforcements.Reinforce: the entry path is empty");
        }
        let interval = a.opt_int(3, 25)?;
        let func = a.opt_func(4)?;
        let mut out = Vec::new();
        for (k, ty) in types.iter().enumerate() {
            let h = self.reinforcement(ty, owner, &path)?;
            let seq = self.m.next_seq();
            let rest: Vec<(i32, i32)> = path.iter().skip(1).map(|&(x, y)| self.m.cell_in(x, y)).collect();
            self.m.spawns.push(PendingSpawn {
                tick: self.w.tick + (k as i64 * interval).max(0) as u32,
                seq,
                handle: h,
                path: rest,
                then: func.clone(),
            });
            out.push(actor_value(h));
        }
        // Reinforcements without a delay arrive this tick (OpenRA SpawnActorEffect with delay 0).
        self.tick_spawns(lua);
        Ok(vec![lua.array(out)])
    }

    pub(crate) fn reinforce_with_transport(&mut self, lua: &mut Lua, a: &A) -> R<Vec<Value>> {
        let owner = a.player(0)?;
        let ty = a.string(1)?;
        let cargo: Vec<String> =
            if a.has(2) { self.collection(lua, a, 2)?.iter().map(|v| v.to_text().unwrap_or_default()).collect() } else { Vec::new() };
        let entry = self.path_arg(lua, a, 3)?;
        if entry.is_empty() {
            return err("Reinforcements.ReinforceWithTransport: the entry path is empty");
        }
        let exit = if a.has(4) { Some(self.path_arg(lua, a, 4)?) } else { None };
        let action = a.opt_func(5)?;
        let exit_func = a.opt_func(6)?;
        let drop_range = a.opt_int(7, 3)? as i32;
        let th = self.reinforcement(&ty, owner, &entry)?;
        let t = self.spawn_from_limbo(lua, th, None)?;
        let mut passengers = Vec::new();
        if self.w.is_transport(t) {
            for c in &cargo {
                let ph = self.reinforcement(c, owner, &entry[..1])?;
                let pi = self.spawn_from_limbo(lua, ph, None)?;
                if !self.w.load_passenger(t, pi) {
                    // Too heavy or the wrong cargo type: OpenRA's Cargo.Load still
                    // takes it; here it rides along anyway.
                    let tref = self.w.make_ref(t);
                    let pref = self.w.make_ref(pi);
                    self.w.actors[t].cargo.push(pref);
                    let (x, y) = (self.w.actors[t].x, self.w.actors[t].y);
                    let p = &mut self.w.actors[pi];
                    p.carrier = tref;
                    p.x = x;
                    p.y = y;
                    p.px = x;
                    p.py = y;
                }
                passengers.push(ph);
            }
        }
        // The cargo's own enter events are not news to the script.
        self.w.script_events.retain(|e| !matches!(e, ScriptEvent::PassengerEntered { .. }));
        for &(x, y) in &entry[1..] {
            let cell = self.m.cell_in(x, y);
            self.queue(th, Act::Move { cell, close: 2, attack: false });
        }
        let last = self.m.cell_in(entry[entry.len() - 1].0, entry[entry.len() - 1].1);
        let plist = lua.array(passengers.iter().map(|&p| actor_value(p)).collect());
        match action {
            Some(f) => self.queue(th, Act::CallFunc(f, vec![actor_value(th), plist.clone()])),
            None => {
                if self.is_aircraft(th) {
                    self.queue(th, Act::LandNear(last));
                }
                if self.is_transport(th) {
                    self.queue(th, Act::Unload { cell: None, range: drop_range });
                }
            }
        }
        match (exit_func, exit) {
            (Some(f), _) => self.queue(th, Act::CallFunc(f, vec![actor_value(th)])),
            (None, Some(path)) => {
                for &(x, y) in &path {
                    let cell = self.m.cell_in(x, y);
                    self.queue(th, Act::Move { cell, close: 2, attack: false });
                }
                self.queue(th, Act::Destroy);
            }
            (None, None) => {}
        }
        self.added_to_world(lua, th);
        let ret = lua.new_table();
        let Value::Table(rt) = ret else { unreachable!() };
        lua.raw_set(rt, Value::Num(1.0), actor_value(th))?;
        lua.raw_set(rt, Value::Num(2.0), plist)?;
        Ok(vec![ret])
    }

    /// Reinforcements whose delay has passed enter the world and set off (OpenRA SpawnActorEffect).
    pub(crate) fn tick_spawns(&mut self, lua: &mut Lua) {
        let tick = self.w.tick;
        let mut due: Vec<PendingSpawn> = Vec::new();
        self.m.spawns.retain(|s| {
            if s.tick <= tick {
                due.push(s.clone());
                false
            } else {
                true
            }
        });
        due.sort_by_key(|s| (s.tick, s.seq));
        for s in due {
            if !matches!(self.m.handles[s.handle as usize].state, HState::Limbo(_)) {
                continue;
            }
            if let Err(e) = self.spawn_from_limbo(lua, s.handle, None) {
                self.fatal(&e);
                return;
            }
            self.added_to_world(lua, s.handle);
            for &cell in &s.path {
                self.queue(s.handle, Act::Move { cell, close: 2, attack: false });
            }
            if let Some(f) = s.then {
                self.queue(s.handle, Act::CallFunc(f, vec![actor_value(s.handle)]));
            }
        }
    }

    // ---- The activity runner -----------------------------------------------------------------

    pub(crate) fn tick_queues(&mut self, lua: &mut Lua) {
        let handles: Vec<u32> = self.m.queues.keys().copied().collect();
        for h in handles {
            if self.m.error.is_some() {
                return;
            }
            self.run_queue(lua, h);
        }
    }

    fn run_queue(&mut self, lua: &mut Lua, h: u32) {
        for _ in 0..MAX_STEPS {
            let Some(q) = self.m.queues.get_mut(&h) else { return };
            let Some(act) = q.items.front().cloned() else {
                self.m.queues.remove(&h);
                return;
            };
            let started = q.started;
            q.started = true;
            q.ticks += 1;
            let ticks = q.ticks;
            let done = match self.step(lua, h, &act, started, ticks) {
                Ok(d) => d,
                Err(e) => {
                    self.fatal(&e);
                    return;
                }
            };
            if !done {
                return;
            }
            if let Some(q) = self.m.queues.get_mut(&h) {
                // The callback may have stopped the actor (Stop clears the queue).
                if q.items.front().is_some_and(|f| same_act(f, &act)) {
                    q.advance();
                }
            }
        }
    }

    /// Run one activity a tick; Ok(true) when it is done.
    fn step(&mut self, lua: &mut Lua, h: u32, act: &Act, started: bool, ticks: i32) -> R<bool> {
        // Script-only steps that need no body.
        match act {
            Act::CallFunc(f, args) => {
                lua.call(self, f, args.clone())?;
                return Ok(true);
            }
            Act::Wait(n) => return Ok(ticks > *n),
            _ => {}
        }
        let Some(i) = self.engine_actor(h) else {
            // Dead or out of the world: what is left does not run.
            if self.is_dead(h) {
                self.m.queues.remove(&h);
            }
            return Ok(false);
        };
        if !self.w.actors[i].in_world() && !matches!(act, Act::Destroy) {
            return Ok(false);
        }
        let center = |c: (i32, i32)| (cell_center(c.0), cell_center(c.1));
        Ok(match act {
            Act::Move { cell, close, attack } => {
                if !started {
                    if self.w.actors[i].kind == Kind::Building {
                        return Ok(true);
                    }
                    let (x, y) = center(*cell);
                    self.w.clear_commands_keep_script(i);
                    self.w.order_move(&[i], x, y, *attack);
                    return Ok(false);
                }
                let (x, y) = center(*cell);
                let near = dist(self.w.actors[i].x, self.w.actors[i].y, x, y) <= *close * CELL + HALF_CELL;
                if near && *close > 0 && !*attack {
                    self.stop_engine(i);
                    return Ok(true);
                }
                self.engine_idle(i)
            }
            Act::MoveIntoWorld(cell) => {
                if !started {
                    let (x, y) = center(*cell);
                    self.w.order_move(&[i], x, y, false);
                    return Ok(false);
                }
                self.engine_idle(i)
            }
            Act::Destroy => {
                // RemoveSelf disposes the passengers with the transport (OpenRA Cargo
                // on disposing), where selling lets them out.
                for p in self.w.passengers(i) {
                    self.w.remove(p);
                }
                self.w.actors[i].cargo.clear();
                self.w.remove(i);
                true
            }
            Act::Hunt => {
                if started && !self.engine_idle(i) {
                    return Ok(false);
                }
                match self.hunt_target(i) {
                    Some(t) => {
                        let (x, y) = (self.w.actors[t].x, self.w.actors[t].y);
                        self.w.order_move(&[i], x, y, true);
                        false
                    }
                    None => true,
                }
            }
            Act::Attack { target, allow_move, force } => {
                if !started {
                    let Some(t) = self.engine_actor(*target) else { return Ok(true) };
                    self.w.order_attack(&[i], t, *force);
                    self.w.actors[i].hold = !*allow_move;
                    return Ok(false);
                }
                self.engine_idle(i)
            }
            Act::Teleport(cell) => {
                let (x, y) = center(*cell);
                let a = &mut self.w.actors[i];
                if a.kind != Kind::Building {
                    a.x = x;
                    a.y = y;
                    a.px = x;
                    a.py = y;
                    a.goal = NONE;
                    a.activity = Activity::Idle;
                }
                true
            }
            Act::Scatter => {
                if !started {
                    self.w.order_scatter(&[i]);
                    return Ok(false);
                }
                self.engine_idle(i)
            }
            Act::EnterTransport(t) => {
                if !started {
                    let Some(ti) = self.engine_actor(*t) else { return Ok(true) };
                    self.w.order_load(&[i], ti);
                    return Ok(false);
                }
                !self.w.actors[i].in_world() || self.engine_idle(i)
            }
            Act::Unload { cell, range } => {
                if !started {
                    if let Some(c) = cell {
                        let (x, y) = center(*c);
                        if dist(self.w.actors[i].x, self.w.actors[i].y, x, y) > *range * CELL {
                            self.w.order_move(&[i], x, y, false);
                        }
                    }
                    return Ok(false);
                }
                if !self.w.has_passengers(i) {
                    return Ok(self.engine_idle(i) || self.w.actors[i].activity == Activity::Unload);
                }
                if self.engine_idle(i) {
                    if self.w.actors[i].altitude > 0 && self.w.actors[i].kind == Kind::Aircraft {
                        let (x, y) = (self.w.actors[i].x, self.w.actors[i].y);
                        self.w.order_land(&[i], x, y);
                    } else {
                        self.w.order_unload(i);
                    }
                }
                false
            }
            Act::Deploy => {
                if self.w.can_unload(i) {
                    self.w.order_unload(i);
                } else if self.w.actors[i].kind == Kind::Aircraft && self.w.is_helicopter(i) {
                    self.w.heli_deploy(i);
                } else if !self.w.toggle_primary(i) && !self.w.ability_deploy(i) {
                    self.w.deploy(i);
                }
                true
            }
            Act::Enter { kind, target } => {
                if !started {
                    let Some(t) = self.engine_actor(*target) else { return Ok(true) };
                    if !self.w.order_enter(i, t, *kind) {
                        return Ok(true);
                    }
                    return Ok(false);
                }
                !self.w.actors[i].alive || self.engine_idle(i)
            }
            Act::DeliverCash(t) => {
                if !started {
                    let Some(ti) = self.engine_actor(*t) else { return Ok(true) };
                    let (x, y) = (self.w.actors[ti].x, self.w.actors[ti].y);
                    self.w.order_deliver_cash(&[i], ti, x, y);
                    return Ok(false);
                }
                self.engine_idle(i)
            }
            Act::Guard(t) => {
                if !started {
                    let Some(ti) = self.engine_actor(*t) else { return Ok(true) };
                    let owner = self.w.actors[i].owner;
                    self.w.order_guard(owner, &[i], ti);
                    return Ok(false);
                }
                self.w.actors[i].guard == NONE && self.engine_idle(i)
            }
            Act::ReturnToBase(dest) => {
                if !started {
                    let base = dest.and_then(|d| self.engine_actor(d)).map(|b| self.w.make_ref(b));
                    if self.w.is_plane(i) {
                        self.w.plane_return_to_base(i, base);
                    } else {
                        self.w.order_return_to_base(&[i]);
                    }
                    return Ok(false);
                }
                self.engine_idle(i)
            }
            Act::Land(t) => {
                if !started {
                    let Some(ti) = self.engine_actor(*t) else { return Ok(true) };
                    let (x, y) = (self.w.actors[ti].x, self.w.actors[ti].y);
                    self.w.order_land(&[i], x, y);
                    return Ok(false);
                }
                self.engine_idle(i)
            }
            Act::LandNear(cell) => {
                if !started {
                    let (x, y) = center(*cell);
                    if self.w.is_plane(i) {
                        return Ok(true);
                    }
                    self.w.order_land(&[i], x, y);
                    return Ok(false);
                }
                self.engine_idle(i) && self.w.actors[i].altitude == 0
            }
            Act::Resupply => true,
            Act::FindResources => {
                if self.w.is_harvester(i) {
                    let a = &mut self.w.actors[i];
                    a.activity = Activity::Harvest;
                    a.harv = crate::world::HarvState::Search;
                }
                true
            }
            Act::Paradrop(cell) => {
                let (x, y) = center(*cell);
                if !started {
                    self.w.order_move(&[i], x, y, false);
                    return Ok(false);
                }
                let range = self.w.rules.actors[self.w.actors[i].ty as usize]
                    .unit
                    .as_ref()
                    .and_then(|u| u.aircraft.as_ref())
                    .map_or(4 * CELL, |ac| ac.drop_range.max(CELL));
                if dist(self.w.actors[i].x, self.w.actors[i].y, x, y) <= range {
                    // Everyone jumps, one a tick (OpenRA ParaDrop).
                    match self.w.passengers(i).last().copied() {
                        Some(p) => {
                            let (px, py, alt) = (self.w.actors[i].x, self.w.actors[i].y, self.w.actors[i].altitude);
                            self.w.actors[i].cargo.pop();
                            let tref = self.w.make_ref(i);
                            let pref = self.w.make_ref(p);
                            let a = &mut self.w.actors[p];
                            a.carrier = NONE;
                            a.x = px;
                            a.y = py;
                            a.px = px;
                            a.py = py;
                            a.altitude = alt.max(CELL);
                            a.air.parachute = true;
                            self.w.script_event(ScriptEvent::PassengerExited { transport: tref, passenger: pref });
                            false
                        }
                        None => true,
                    }
                } else {
                    if self.engine_idle(i) {
                        self.w.order_move(&[i], x, y, false);
                    }
                    false
                }
            }
            Act::FlyOffMap => {
                let (x, y) = (self.w.actors[i].x, self.w.actors[i].y);
                let (w, hgt) = (self.w.map.width * CELL, self.w.map.height * CELL);
                let edge = [(x, -CELL), (x, hgt + CELL), (-CELL, y), (w + CELL, y)];
                let target = edge.iter().copied().min_by_key(|&(ex, ey)| dist(x, y, ex, ey) as i64).expect("edges");
                if !started {
                    self.w.order_move(&[i], target.0.clamp(0, w - 1), target.1.clamp(0, hgt - 1), false);
                    return Ok(false);
                }
                self.engine_idle(i)
            }
            Act::Produce { ty } => {
                let owner = self.w.actors[i].owner;
                self.w.produce_at(i, owner, *ty).is_some()
            }
            Act::PatrolLoop { cells, wait } => {
                let (cells, wait) = (cells.clone(), *wait);
                // Re-queue the patrol behind this marker, then the marker again.
                let mut q = Queue::default();
                for &c in &cells {
                    q.push(Act::Move { cell: c, close: 2, attack: true });
                    q.push(Act::Wait(wait));
                }
                q.push(Act::PatrolLoop { cells, wait });
                self.splice(h, q);
                true
            }
            Act::PatrolUntil { cells, func, wait } => {
                let (cells, func, wait) = (cells.clone(), func.clone(), *wait);
                let mut q = Queue::default();
                for &c in &cells {
                    q.push(Act::Move { cell: c, close: 2, attack: true });
                    q.push(Act::Wait(wait));
                }
                let again = lua.call(self, &func, vec![actor_value(h)])?.first().is_some_and(Value::truthy);
                if again {
                    q.push(Act::PatrolUntil { cells, func, wait });
                }
                self.splice(h, q);
                true
            }
            Act::CallFunc(..) | Act::Wait(_) => unreachable!("handled above"),
        })
    }

    /// Insert activities right after the current one.
    fn splice(&mut self, h: u32, mut q: Queue) {
        let cur = self.m.queues.entry(h).or_default();
        let first = cur.items.pop_front();
        q.items.extend(cur.items.drain(..));
        if let Some(f) = first {
            q.items.push_front(f);
        }
        cur.items = q.items;
    }

    /// The nearest enemy for Hunt (OpenRA Huntable actors, ignoring visibility).
    fn hunt_target(&self, i: usize) -> Option<usize> {
        let (x, y, owner) = (self.w.actors[i].x, self.w.actors[i].y, self.w.actors[i].owner);
        let mut best: Option<(i64, usize)> = None;
        for t in 0..self.w.actors.len() {
            let a = &self.w.actors[t];
            if !a.alive || !a.in_world() || !self.w.are_enemies(owner, a.owner) {
                continue;
            }
            if matches!(a.kind, Kind::Husk | Kind::Crate | Kind::Mine | Kind::Proxy) || !self.can_attack(i, t) {
                continue;
            }
            let d = crate::math::dist_sq(x, y, a.x, a.y);
            if best.is_none_or(|(bd, _)| d < bd) {
                best = Some((d, t));
            }
        }
        best.map(|(_, t)| t)
    }
}

/// Whether two queue items are the same activity (the queue was not changed under a callback).
fn same_act(a: &Act, b: &Act) -> bool {
    std::mem::discriminant(a) == std::mem::discriminant(b)
}

/// Engine facing toward an OpenRA cell offset (Map.FacingBetween).
fn facing_of_cells(dx: i32, dy: i32) -> i32 {
    crate::math::facing_of(dx, dy).unwrap_or(512)
}

fn stance_name(s: crate::rules::Stance) -> &'static str {
    match s {
        crate::rules::Stance::HoldFire => "HoldFire",
        crate::rules::Stance::ReturnFire => "ReturnFire",
        crate::rules::Stance::Defend => "Defend",
        crate::rules::Stance::AttackAnything => "AttackAnything",
    }
}

impl World {
    /// A player's order to actor `i` drops what its mission script queued
    /// (`clear_commands`, OpenRA CancelActivity).
    pub(crate) fn cancel_script_activities(&mut self, i: usize) {
        let r = self.make_ref(i);
        if let Some(m) = self.mission.as_mut() {
            if let Some(&h) = m.handle_of.get(&r) {
                m.queues.remove(&h);
            }
        }
    }

    /// `clear_commands` for a script's own order: the script queue stays.
    pub(crate) fn clear_commands_keep_script(&mut self, i: usize) {
        let a = &mut self.actors[i];
        a.waypoints.clear();
        a.guard = NONE;
        a.hold = false;
    }
}

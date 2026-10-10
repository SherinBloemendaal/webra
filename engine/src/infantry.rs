//! Infantry abilities of Red Alert as OpenRA's RA mod has them: engineers
//! capture structures and repair them (Captures, CaptureManager,
//! InstantlyRepairs, RepairsBridges), spies disguise themselves and
//! infiltrate (Disguise, Infiltrates and the InfiltrateFor* traits), thieves
//! steal cash and vehicles, Tanya plants C4 (Demolition), plus what an
//! infiltration grants: proxies (InfiltrateForSupportPower: veteran
//! production and the Sonar Pulse), power outages and support power resets.
//!
//! Everything that walks up to a target and goes in shares one activity,
//! `Activity::Enter` (OpenRA's `Enter` activity): approach until next to the
//! target, wait there for a capture delay, walk in, then act; Tanya walks out
//! again. Hooks called from the shared code:
//! - `on_created(i)` when a unit spawns (ProducibleWithLevel),
//! - `infantry_died(i)` when an actor dies (death animations, corpses),
//! - `tick_infantry_world()` once per tick before units act,
//! - `tick_enter(i)` for units in `Activity::Enter`,
//! - `infantry_smart_action` / `order_smart_infantry` for right clicks.
//!
//! Dogs (AttackLeap) are in dog.rs, healing and deaths in infantry_combat.rs,
//! drawing in infantry_render.rs.

use crate::math::{dist, facing_of, CELL};
use crate::rules::{CapturesInfo, Kind, SupportPowerInfo, RELATION_ALLY, RELATION_ENEMY, RELATION_NEUTRAL};
use crate::sound_events::SoundEventKind;
use crate::world::{cell_center, Activity, Effect, EffectKind, SmartAction, World, NONE};

/// A unit within this distance of a target's footprint (or body) stands next
/// to it (OpenRA Mobile.CanEnterTargetNow: on an adjacent cell).
pub(crate) const ENTER_REACH: i32 = CELL * 3 / 4;
/// Entering is complete this close to the target's centre point.
const ENTERED: i32 = 96;
/// Ticks without progress before an approach gives up.
const STUCK_LIMIT: i32 = 75;

/// What a unit does once it got into its target.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum EnterKind {
    /// OpenRA CaptureActor: take the target over (Captures).
    Capture,
    /// OpenRA Infiltrate: the target's InfiltrateFor* effects (Infiltrates).
    Infiltrate,
    /// OpenRA InstantRepair: repair an own or allied structure fully (InstantlyRepairs).
    InstantRepair,
    /// OpenRA Demolish: plant C4 and walk out again (Demolition).
    Demolish,
    /// OpenRA RepairBridge: enter a bridge hut whose bridge is damaged (RepairsBridges).
    RepairBridge,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum EnterPhase {
    /// Walking up to the target.
    Approach,
    /// Next to the target, waiting for the capture delay (OpenRA CaptureManager.StartCapture).
    Wait,
    /// Walking into the target from `from`.
    Entering,
    /// Walking out again to `from` (Demolition: EnterBehaviour Exit).
    Exiting,
}

/// The Enter activity of one unit.
#[derive(Clone, Debug)]
pub struct Enter {
    pub kind: EnterKind,
    /// Target actor reference.
    pub target: u32,
    pub phase: EnterPhase,
    /// Ticks spent next to the target (capture delay progress).
    pub ticks: i32,
    /// Where the unit stood when it started walking in.
    pub from: (i32, i32),
    /// The target's cell the approach heads for (recomputed when the target moves).
    pub target_cell: u32,
}

/// A spy's disguise (OpenRA Disguise: AsActor and AsPlayer).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Disguise {
    pub ty: u16,
    pub owner: u8,
}

/// C4 ticking on a structure (OpenRA Demolishable).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Demolishing {
    /// Tick it goes off.
    pub at: u32,
    /// Who planted it (the kill counts for it).
    pub by: u32,
    pub owner: u8,
}

/// A dog in the air (OpenRA Leap activity), see dog.rs.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Leap {
    pub target: u32,
    pub ox: i32,
    pub oy: i32,
    /// Where the prey is (or was last).
    pub tx: i32,
    pub ty: i32,
    pub ticks: i32,
    pub length: i32,
}

/// Per-actor infantry state (part of `Actor`).
#[derive(Clone, Default, Debug)]
pub struct InfantryState {
    pub enter: Option<Enter>,
    pub disguise: Option<Disguise>,
    pub leap: Option<Leap>,
    /// On a leap target: the dog leaping at it (OpenRA EdibleByLeap), or NONE.
    pub leaper: u32,
    /// Ticks a dog stays put after a bite (GrantConditionOnAttack `eating`).
    pub eat: i32,
    /// C4 planted on this structure.
    pub demolish: Option<Demolishing>,
    /// Players (one bit per slot) whose spies infiltrated this structure:
    /// InfiltrateForDecoration shows them the fake tag.
    pub infiltrated_by: u32,
    /// Death sequence picked by the killing hit (death animations; presentation).
    pub death: u8,
    /// Tick of the last AnnounceOnKill line (presentation: it only gates a sound event).
    pub announced: u32,
}

/// A dying soldier (OpenRA WithDeathAnimation's SpriteEffect). Presentation
/// only: never read by the simulation and not part of the state hash.
#[derive(Clone, Debug)]
pub struct Corpse {
    pub x: i32,
    pub y: i32,
    pub facing: i32,
    pub ty: u16,
    pub owner: u8,
    /// Death sequence: 1..=6 die1..die6, `DEATH_CRUSHED` crushed.
    pub sequence: u8,
    pub tick: u32,
}

/// Death sequence number of a crushed soldier (OpenRA CrushedSequence).
pub const DEATH_CRUSHED: u8 = 7;
/// Ticks a death animation is drawn (the longest RA one, die6, is 22 frames at 80 ms).
pub const DEATH_TICKS: u32 = 48;
/// Ticks a crushed body is drawn.
pub const CRUSHED_TICKS: u32 = 125;

/// The Sonar Pulse's SONAR actor (SpawnActorPower): a detector without a body.
#[derive(Clone, Debug)]
pub struct Pulse {
    pub owner: u8,
    pub x: i32,
    pub y: i32,
    pub range: i32,
    pub types: Vec<String>,
    /// Last tick it detects.
    pub until: u32,
}

/// A shot an Armament fires after its FireDelay (OpenRA Armament.FireDelay).
#[derive(Clone, Debug)]
pub struct DelayedShot {
    pub tick: u32,
    pub shooter: u32,
    /// Target actor reference, or NONE for a shot at the ground (`ground`).
    pub target: u32,
    pub ground: (i32, i32),
    pub weapon: u16,
}

/// Short visual effects of this module (presentation).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum InfantryFxKind {
    /// Sonar Pulse ring where it was fired.
    Sonar,
}

#[derive(Clone, Debug)]
pub struct InfantryFx {
    pub x: i32,
    pub y: i32,
    pub kind: InfantryFxKind,
    pub owner: u8,
    pub ttl: i32,
    pub max: i32,
}

/// World-level infantry state (part of `World`).
#[derive(Clone, Default)]
pub struct InfantryWorld {
    /// Dying soldiers (presentation only).
    pub corpses: Vec<Corpse>,
    /// Per player: (ticks left, total) of a power outage (InfiltrateForPowerOutage).
    pub outage: Vec<(i32, i32)>,
    /// Active Sonar Pulses.
    pub pulses: Vec<Pulse>,
    /// Shots waiting for their FireDelay.
    pub shots: Vec<DelayedShot>,
    /// Effects (presentation only).
    pub fx: Vec<InfantryFx>,
    /// This tick's captures in progress: (target, captor's owner, progress, total).
    pub captures: Vec<(u32, u8, i32, i32)>,
}

impl World {
    // ---- Relationships -----------------------------------------------------------

    /// OpenRA PlayerRelationship of `b` seen from `a`, as a RELATION_* bit.
    pub fn relation(&self, a: u8, b: u8) -> u32 {
        if self.are_allies(a, b) {
            RELATION_ALLY
        } else if self.are_enemies(a, b) {
            RELATION_ENEMY
        } else {
            RELATION_NEUTRAL
        }
    }

    // ---- Lifecycle -------------------------------------------------------------------

    /// A unit appeared: OpenRA ProducibleWithLevel gives it levels when its
    /// owner has the prerequisites (a spy infiltrated a barracks, war
    /// factory or airfield; paratroopers always).
    pub(crate) fn on_created(&mut self, i: usize) {
        let ty = self.actors[i].ty as usize;
        let Some(p) = self.rules.actors[ty].producible_level.as_ref() else { return };
        if self.rules.actors[ty].experience.is_none() {
            return;
        }
        let owner = self.actors[i].owner as usize;
        let tokens = &self.players[owner].tokens;
        let met = p.prerequisites.iter().all(|t| self.rules.token(t).is_some_and(|k| tokens[k as usize]));
        let levels = p.levels.max(0) as usize;
        if met && levels > 0 {
            self.give_levels(i, levels);
        }
    }

    /// Once per tick, before units act: delayed shots, C4, power outages,
    /// sonar pulses, the captures in progress and the presentation lists.
    pub(crate) fn tick_infantry_world(&mut self) {
        let tick = self.tick;
        let n = self.players.len();
        self.inf.outage.resize(n, (0, 0));
        for o in self.inf.outage.iter_mut() {
            if o.0 > 0 {
                o.0 -= 1;
                if o.0 == 0 {
                    o.1 = 0;
                }
            }
        }
        self.inf.pulses.retain(|p| p.until >= tick);
        // Bodies are presentation (not hashed): the built-in ones fade over
        // their own time, original death sequences stay until they ended.
        let opts = &self.render_opts;
        self.inf.corpses.retain(|c| {
            let built_in = if c.sequence == DEATH_CRUSHED { CRUSHED_TICKS } else { DEATH_TICKS };
            let art = if opts.poses && opts.death_art.get(c.ty as usize).copied().unwrap_or(false) {
                opts.infantry_ticks.get(c.ty as usize).map_or(0, |t| t[(c.sequence.clamp(1, DEATH_CRUSHED) - 1) as usize])
            } else {
                0
            };
            tick < c.tick + built_in.max(art)
        });
        for f in self.inf.fx.iter_mut() {
            f.ttl -= 1;
        }
        self.inf.fx.retain(|f| f.ttl > 0);
        self.fire_delayed_shots();
        self.tick_demolitions();
        for i in 0..self.actors.len() {
            if self.actors[i].alive && self.actors[i].inf.eat > 0 {
                self.actors[i].inf.eat -= 1;
            }
        }
        self.inf.captures = self.captures_in_progress();
    }

    /// OpenRA AnnounceOnKill: `killer` (an actor reference) killed an enemy;
    /// its owner hears it (Tanya), at most every Interval ticks.
    pub(crate) fn announce_kill(&mut self, killer: u32, victim: usize) {
        let Some(k) = self.resolve(killer) else { return };
        let Some(info) = self.rules.actors[self.actors[k].ty as usize].abilities.announce_on_kill.clone() else { return };
        let a = &self.actors[k];
        if !self.are_enemies(a.owner, self.actors[victim].owner)
            || (a.inf.announced > 0 && self.tick < a.inf.announced + info.interval.max(0) as u32)
        {
            return;
        }
        let (x, y, owner, ty) = (a.x, a.y, a.owner, a.ty);
        self.actors[k].inf.announced = self.tick;
        self.sound.push(SoundEventKind::KillAnnounced, ty as i32, x, y, owner, 0);
    }

    // ---- Proxies (InfiltrateForSupportPower) -------------------------------------------

    /// Give `player` a proxy actor type (OpenRA creates the proxy actor for
    /// the infiltrator's owner): its prerequisites and support powers.
    pub fn grant_proxy(&mut self, player: u8, proxy: u16) {
        let p = &mut self.players[player as usize];
        if !p.proxies.contains(&proxy) {
            p.proxies.push(proxy);
            p.proxies.sort_unstable();
        }
        self.tokens_dirty = true;
    }

    /// Prerequisite tokens of the player's proxies (production.rs refresh_tokens).
    pub(crate) fn proxy_tokens(&self, player: usize) -> Vec<u16> {
        let mut out = Vec::new();
        for &ty in &self.players[player].proxies {
            if let Some(p) = &self.rules.actors[ty as usize].abilities.proxy {
                out.extend(p.provides.iter().filter_map(|t| self.rules.token(t)));
            }
        }
        out
    }

    // ---- Power outage (InfiltrateForPowerOutage) -------------------------------------

    /// Ticks left of a power outage of `player` (0: none).
    pub fn power_outage(&self, player: u8) -> i32 {
        self.inf.outage.get(player as usize).map_or(0, |o| o.0)
    }

    /// Whether structure `i` is disabled by its owner's power outage (OpenRA
    /// AffectedByPowerOutage: power plants make no power for the duration).
    pub fn outage_disabled(&self, i: usize) -> bool {
        self.outage_disabled_at(&self.actors[i])
    }

    /// `outage_disabled` for an actor reference (production.rs power totals).
    pub(crate) fn outage_disabled_at(&self, a: &crate::world::Actor) -> bool {
        a.kind == Kind::Building
            && self.power_outage(a.owner) > 0
            && self.rules.actors[a.ty as usize].abilities.infiltrated.as_ref().is_some_and(|l| l.iter().any(|e| e.kind == "power_outage"))
    }

    // ---- Capture (Captures, Capturable, CaptureManager) ---------------------------------

    /// The Captures trait of unit `i` that can take actor `t` now, if any:
    /// enabled by the lobby's Reusable Engineers option or not, a capture
    /// type the target accepts, an enemy or neutral owner (CapturesInfo.
    /// ValidRelationships), and no aircraft in the air (Capturable
    /// RequiresCondition !airborne). Among several, the one with the
    /// shortest delay (OpenRA ValidCapturesWithLowestSabotageThreshold).
    pub fn capture_with(&self, i: usize, t: usize) -> Option<&CapturesInfo> {
        let (a, ta) = (&self.actors[i], &self.actors[t]);
        if i == t || !a.alive || !ta.alive || !ta.in_world() || ta.altitude > 0 {
            return None;
        }
        let list = self.rules.actors[a.ty as usize].abilities.captures.as_ref()?;
        let cap = self.rules.actors[ta.ty as usize].abilities.capturable.as_ref()?;
        if self.relation(a.owner, ta.owner) & (RELATION_ENEMY | RELATION_NEUTRAL) == 0 {
            return None;
        }
        let reusable = self.options.reusable_engineers;
        list.iter()
            .filter(|c| c.option == 0 || (c.option == 1) == reusable)
            .filter(|c| c.types.iter().any(|ty| cap.types.contains(ty)))
            .min_by_key(|c| c.delay)
    }

    /// Whether unit `i` can capture actor `t` now (see `capture_with`).
    pub fn can_capture(&self, i: usize, t: usize) -> bool {
        self.capture_with(i, t).is_some()
    }

    /// Whether structure (or unit) `t` is being captured right now: a captor
    /// waits next to it or walks in. It cannot be sold meanwhile (Sellable
    /// RequiresCondition !being-captured), and the captors' allies do not
    /// auto-target it (CaptureManager.PreventsAutoTarget).
    pub fn being_captured(&self, t: usize) -> bool {
        let r = self.make_ref(t);
        self.inf.captures.iter().any(|c| c.0 == r)
    }

    /// Whether `player`'s units leave `t` alone in auto-targeting because an
    /// allied captor is taking it over.
    pub(crate) fn capture_protected(&self, t: usize, player: u8) -> bool {
        if self.inf.captures.is_empty() {
            return false;
        }
        let r = self.make_ref(t);
        self.inf.captures.iter().any(|c| c.0 == r && self.are_allies(c.1, player))
    }

    /// Captures in progress (target, captor's owner, progress, total), for the
    /// tick's checks and the progress bar (OpenRA CapturableProgressBar).
    fn captures_in_progress(&self) -> Vec<(u32, u8, i32, i32)> {
        let mut out = Vec::new();
        for a in &self.actors {
            let Some(e) = a.inf.enter.as_ref() else { continue };
            if !a.alive || a.activity != Activity::Enter || e.kind != EnterKind::Capture {
                continue;
            }
            if !matches!(e.phase, EnterPhase::Wait | EnterPhase::Entering) || self.resolve(e.target).is_none() {
                continue;
            }
            let total = self.rules.actors[a.ty as usize].abilities.captures.as_ref().map_or(0, |l| {
                let reusable = self.options.reusable_engineers;
                l.iter().filter(|c| c.option == 0 || (c.option == 1) == reusable).map(|c| c.delay).min().unwrap_or(0)
            });
            out.push((e.target, a.owner, e.ticks.min(total), total));
        }
        out
    }

    /// Take actor `t` over for `new_owner` (OpenRA CaptureActor.DoCapture and
    /// INotifyCapture): it changes owner, the old and new owners are told
    /// (CaptureNotification), and the capturing player gains experience.
    /// `captor` is the unit that did it, if any. The world objects (tech
    /// structures, bridges) use it for anything with `abilities.capturable`.
    pub fn capture(&mut self, t: usize, new_owner: u8, captor: Option<usize>) {
        let (old, ty, x, y) = (self.actors[t].owner, self.actors[t].ty, self.actors[t].x, self.actors[t].y);
        if old == new_owner || !self.actors[t].alive {
            return;
        }
        let experience =
            captor.and_then(|c| self.capture_with(c, t).map(|ci| ci.experience)).filter(|_| self.are_enemies(new_owner, old)).unwrap_or(0);
        self.note_player_experience(new_owner, experience);
        // A husk becomes its vehicle again for the captor (TransformOnCapture, husks.rs).
        if self.actors[t].kind == Kind::Husk {
            self.restore_husk(t, new_owner, false);
            return;
        }
        let cancel = self.rules.actors[ty as usize].abilities.capturable.as_ref().is_some_and(|c| c.cancel_activity);
        self.change_owner(t, new_owner, cancel);
        // CaptureNotification for both sides (sound_events.rs Captured).
        self.sound.push(SoundEventKind::Captured, ty as i32, x, y, new_owner, old as i32);
        // GivesCashOnCapture and the like of the neutral world (neutral.rs).
        self.after_capture(t, old);
    }

    /// Give actor `i` to `owner` (OpenRA Actor.ChangeOwner): what it was
    /// doing for its old owner stops (when `cancel`, CancelActivity), its
    /// stance becomes the new owner's default, passengers change sides with
    /// it, and repairs by players who are not allied to the new owner end.
    pub fn change_owner(&mut self, i: usize, owner: u8, cancel: bool) {
        self.release_dock(i);
        let stance = self.initial_stance(self.actors[i].ty, owner);
        let a = &mut self.actors[i];
        a.owner = owner;
        a.stance = stance;
        a.aggressor = NONE;
        a.opportunity = NONE;
        a.rally = None;
        a.refinery = NONE;
        a.inf.disguise = None;
        if cancel || a.kind == Kind::Building {
            a.target = NONE;
            a.target_seen = None;
            a.attack_move = false;
            a.waypoints.clear();
            a.guard = NONE;
            a.inf.enter = None;
            if a.kind != Kind::Building {
                a.activity = Activity::Idle;
                a.goal = NONE;
            }
        }
        let repairers = std::mem::take(&mut self.actors[i].repairers);
        self.actors[i].repairers = repairers.into_iter().filter(|&p| self.are_allies(p, owner)).collect();
        for p in self.passengers(i) {
            self.actors[p].owner = owner;
            self.actors[p].stance = self.initial_stance(self.actors[p].ty, owner);
        }
        self.tokens_dirty = true;
        // Walls change who may crush them (neutral.rs wall crushing).
        self.pass.touch();
    }

    // ---- Infiltration (Infiltrates, InfiltrateFor*) -----------------------------------

    /// Whether unit `i` can infiltrate actor `t` (Infiltrates.Types against
    /// the target's types, ValidRelationships).
    pub fn can_infiltrate(&self, i: usize, t: usize) -> bool {
        let (a, ta) = (&self.actors[i], &self.actors[t]);
        if i == t || !a.alive || !ta.alive || !ta.in_world() {
            return false;
        }
        let Some(inf) = self.rules.actors[a.ty as usize].abilities.infiltrates.as_ref() else { return false };
        let types = &self.rules.actors[ta.ty as usize].infiltrate_types;
        inf.types.iter().any(|x| types.contains(x)) && inf.relationships & self.relation(a.owner, ta.owner) != 0
    }

    /// Unit `i` got into `t`: every InfiltrateFor* effect of the target that
    /// reacts to the infiltrator's types happens (OpenRA Infiltrate.OnEnterComplete).
    pub(crate) fn infiltrate(&mut self, i: usize, t: usize) {
        let ainfo = &self.rules.actors[self.actors[i].ty as usize];
        let Some(inf) = ainfo.abilities.infiltrates.clone() else { return };
        let cost = ainfo.cost;
        let (owner, victim) = (self.actors[i].owner, self.actors[t].owner);
        let (x, y, tty) = (self.actors[t].x, self.actors[t].y, self.actors[t].ty);
        // The spy's disguise drops (Disguise RevealDisguiseOn: Infiltrate is not
        // RA's default, but the unit is used up anyway).
        self.actors[i].inf.disguise = None;
        self.uncloak_on(i, "Infiltrate");
        let effects = self.rules.actors[tty as usize].abilities.infiltrated.clone().unwrap_or_default();
        for e in effects.iter().filter(|e| e.types.iter().any(|x| inf.types.contains(x))) {
            match e.kind.as_str() {
                "cash" => {
                    // InfiltrateForCash: a share of the victim's money, at least the minimum
                    // (or the infiltrator's cost when Minimum is negative).
                    let funds = self.players[victim as usize].funds() as i64;
                    let take = (funds * e.percentage as i64 / 100).min(e.maximum as i64) as i32;
                    let give = take.max(if e.minimum >= 0 { e.minimum } else { cost });
                    self.spend(victim, take);
                    self.players[owner as usize].cash += give;
                    self.note_earned(owner, give);
                    // InfiltrateForCash ShowTicks: over the target in the thief's colour.
                    self.show_cash_tick(t, owner, give);
                    self.note_player_experience(owner, e.experience + take * e.experience_percentage / 100);
                }
                "exploration" => {
                    // InfiltrateForExploration: the infiltrator learns what the victim
                    // explored and the victim forgets it, unless its GPS keeps it.
                    self.note_player_experience(owner, e.experience);
                    let theirs = self.players[victim as usize].explored.clone();
                    for (mine, &v) in self.players[owner as usize].explored.iter_mut().zip(theirs.iter()) {
                        *mine |= v;
                    }
                    if !self.has_gps(victim) && !self.options.explored {
                        let p = &mut self.players[victim as usize];
                        p.explored.iter_mut().for_each(|c| *c = 0);
                        p.ghosts.clear();
                    }
                }
                "power_outage" => {
                    self.note_player_experience(owner, e.experience);
                    let n = self.players.len();
                    self.inf.outage.resize(n, (0, 0));
                    self.inf.outage[victim as usize] = (e.duration, e.duration);
                }
                "support_power" => {
                    self.note_player_experience(owner, e.experience);
                    if let Some(proxy) = self.rules.actor_index(&e.proxy) {
                        self.grant_proxy(owner, proxy as u16);
                    }
                }
                "power_reset" => {
                    // InfiltrateForSupportPowerReset: the target's own powers start charging again.
                    self.note_player_experience(owner, e.experience);
                    let keys: Vec<String> =
                        self.rules.actors[tty as usize].abilities.support_powers.iter().flatten().map(|p| p.key.clone()).collect();
                    if let Some(list) = self.powers.players.get_mut(victim as usize) {
                        for inst in list.iter_mut().filter(|p| keys.contains(&p.key)) {
                            inst.remaining = inst.total;
                        }
                    }
                }
                "transform" => {
                    // InfiltrateForTransform: an allied husk is repaired into its vehicle, for its owner (husks.rs).
                    self.note_player_experience(owner, e.experience);
                    if self.actors[t].kind == Kind::Husk {
                        self.restore_husk(t, victim, true);
                    }
                }
                "decoration" => {
                    self.note_player_experience(owner, e.experience);
                    if owner < 32 {
                        self.actors[t].inf.infiltrated_by |= 1 << owner;
                    }
                }
                _ => {}
            }
        }
        // Infiltrates.Notification and the target's InfiltrateFor* notifications (sound_events.rs Infiltrated).
        let ity = self.actors[i].ty;
        self.sound.push(SoundEventKind::Infiltrated, tty as i32, x, y, victim, crate::sound_events::infiltrator_code(ity, owner));
    }

    // ---- Instant repair, C4, bridges ----------------------------------------------------

    /// Whether unit `i` can repair structure `t` by entering it (InstantlyRepairs:
    /// an own or allied, damaged InstantlyRepairable structure).
    pub fn can_instant_repair(&self, i: usize, t: usize) -> bool {
        self.instant_repair_target(i, t) && self.actors[t].hp < self.rules.actors[self.actors[t].ty as usize].hp
    }

    /// `can_instant_repair` without the damage: the goldwrench cursor shows,
    /// blocked while the structure is undamaged (OpenRA RepairBlockedCursor).
    pub fn instant_repair_target(&self, i: usize, t: usize) -> bool {
        let (a, ta) = (&self.actors[i], &self.actors[t]);
        i != t
            && a.alive
            && ta.alive
            && self.rules.actors[a.ty as usize].abilities.instantly_repairs.is_some()
            && self.rules.actors[ta.ty as usize].abilities.instantly_repairable.is_some()
            && self.are_allies(a.owner, ta.owner)
    }

    /// Whether unit `i` can plant C4 on actor `t` (Demolition, Demolishable):
    /// enemies and neutrals, anyone with force fire.
    pub fn can_demolish(&self, i: usize, t: usize, forced: bool) -> bool {
        let (a, ta) = (&self.actors[i], &self.actors[t]);
        if i == t || !a.alive || !ta.alive || !ta.in_world() {
            return false;
        }
        self.rules.actors[a.ty as usize].abilities.demolition.is_some()
            && self.rules.actors[ta.ty as usize].abilities.demolishable.is_some()
            && (forced || self.relation(a.owner, ta.owner) & (RELATION_ENEMY | RELATION_NEUTRAL) != 0)
    }

    /// Whether C4 ticks on `t` (Demolishable's `being-demolished`: it cannot be sold).
    pub fn being_demolished(&self, t: usize) -> bool {
        self.actors[t].inf.demolish.is_some()
    }

    /// C4 goes off: the structure dies unless it is invulnerable (Iron
    /// Curtain), which defuses it (Demolishable.Tick).
    fn tick_demolitions(&mut self) {
        let tick = self.tick;
        for t in 0..self.actors.len() {
            let Some(d) = self.actors[t].inf.demolish else { continue };
            if !self.actors[t].alive || tick < d.at {
                continue;
            }
            self.actors[t].inf.demolish = None;
            if self.actors[t].invulnerable_until > tick {
                continue;
            }
            self.award_kill(t, d.by);
            self.with_damage_source(d.owner, |w| w.kill(t));
        }
    }

    /// Whether unit `i` can repair the bridge of hut `t` (RepairsBridges: the
    /// bridge is damaged, no repair runs yet and it is not dangling;
    /// bridges.rs `can_repair_bridge_at_hut`).
    pub fn can_repair_bridge(&self, i: usize, t: usize) -> bool {
        self.actors[i].alive
            && self.rules.actors[self.actors[i].ty as usize].abilities.repairs_bridges.is_some()
            && self.can_repair_bridge_at_hut(t)
    }

    // ---- Disguise ---------------------------------------------------------------------

    /// Spy `i` takes the looks of infantry `t` (OpenRA Disguise.DisguiseAs):
    /// of its disguise when it is a disguised spy itself; taking the looks of
    /// its own kind of its own owner drops the disguise.
    pub fn disguise_as(&mut self, i: usize, t: usize) {
        if !self.can_disguise_as(i, t) {
            return;
        }
        let (ty, owner) = match self.actors[t].inf.disguise {
            Some(d) => (d.ty, d.owner),
            None => (self.actors[t].ty, self.actors[t].owner),
        };
        let me = &self.actors[i];
        self.actors[i].inf.disguise = if ty == me.ty && owner == me.owner { None } else { Some(Disguise { ty, owner }) };
    }

    /// Whether spy `i` may take the looks of `t` (Disguise targets: any
    /// Disguise type actor of any owner, not itself).
    pub fn can_disguise_as(&self, i: usize, t: usize) -> bool {
        i != t
            && self.actors[i].alive
            && self.actors[t].alive
            && self.actors[t].in_world()
            && self.rules.actors[self.actors[i].ty as usize].abilities.disguise.is_some()
            && self.rules.actors[self.actors[t].ty as usize].disguisable
    }

    /// The disguise `viewer` sees on actor `i`: its owner and allies, and
    /// units that ignore disguises, see through it.
    pub fn disguise_seen_by(&self, i: usize, viewer: u8) -> Option<Disguise> {
        let d = self.actors[i].inf.disguise?;
        (!self.render_all && !self.render_combined && !self.are_allies(self.actors[i].owner, viewer)).then_some(d)
    }

    /// OpenRA AppearsHostileTo: whether actor `t` looks like an enemy to unit
    /// `viewer`. A disguised spy looks like its disguise's owner's unit,
    /// except to actors with IgnoresDisguise (dogs, spies).
    pub fn appears_hostile(&self, t: usize, viewer: usize) -> bool {
        let (ta, va) = (&self.actors[t], &self.actors[viewer]);
        if self.are_allies(va.owner, ta.owner) {
            return false;
        }
        if let Some(d) = ta.inf.disguise {
            if self.rules.actors[va.ty as usize].abilities.ignores_disguise.is_none() {
                return self.are_enemies(va.owner, d.owner);
            }
        }
        self.are_enemies(va.owner, ta.owner)
    }

    // ---- The Enter activity ----------------------------------------------------------

    /// Send unit `i` to enter actor `t` for `kind`. Returns whether it goes.
    pub fn order_enter(&mut self, i: usize, t: usize, kind: EnterKind) -> bool {
        let ok = match kind {
            EnterKind::Capture => self.can_capture(i, t),
            EnterKind::Infiltrate => self.can_infiltrate(i, t),
            EnterKind::InstantRepair => self.can_instant_repair(i, t),
            EnterKind::Demolish => self.can_demolish(i, t, true),
            EnterKind::RepairBridge => self.can_repair_bridge(i, t),
        };
        if !ok || !self.actors[i].in_world() || self.actors[i].inf.leap.is_some() {
            return false;
        }
        self.release_dock(i);
        let target = self.make_ref(t);
        let a = &mut self.actors[i];
        a.activity = Activity::Enter;
        a.inf.enter = Some(Enter { kind, target, phase: EnterPhase::Approach, ticks: 0, from: (a.x, a.y), target_cell: NONE });
        a.target = NONE;
        a.attack_move = false;
        a.group_size = 1;
        a.goal = NONE;
        a.best_dist = i32::MAX;
        a.stuck_ticks = 0;
        a.air.new_order();
        true
    }

    /// Whether the Enter activity of kind `kind` may still go on with `t`.
    fn enter_valid(&self, i: usize, t: usize, kind: EnterKind) -> bool {
        match kind {
            EnterKind::Capture => self.can_capture(i, t),
            EnterKind::Infiltrate => self.can_infiltrate(i, t),
            EnterKind::InstantRepair => self.can_instant_repair(i, t),
            // A forced C4 order stays valid on any owner (ForceTargetRelationships).
            EnterKind::Demolish => self.can_demolish(i, t, true),
            EnterKind::RepairBridge => self.can_repair_bridge(i, t),
        }
    }

    fn end_enter(&mut self, i: usize) {
        let a = &mut self.actors[i];
        a.inf.enter = None;
        a.activity = Activity::Idle;
        a.goal = NONE;
    }

    /// Units that are not pushed around by the crowd: dogs in the air and
    /// units walking into (or out of) their Enter target.
    pub(crate) fn passes_through(&self, i: usize) -> bool {
        let s = &self.actors[i].inf;
        s.leap.is_some() || s.enter.as_ref().is_some_and(|e| matches!(e.phase, EnterPhase::Entering | EnterPhase::Exiting))
    }

    /// Whether unit `i` stands next to actor `t` (an adjacent cell).
    pub(crate) fn next_to(&self, i: usize, t: usize) -> bool {
        let (x, y) = (self.actors[i].x, self.actors[i].y);
        if self.hit_distance(t, x, y) <= ENTER_REACH {
            return true;
        }
        // OpenRA Mobile.CanEnterTargetNow: standing on a cell next to the
        // cell of a unit or husk (a husk blocks its whole cell).
        let target = &self.actors[t];
        if target.kind == Kind::Building {
            return false;
        }
        let ((cx, cy), (tx, ty)) = (self.cell_of(x, y), self.cell_of(target.x, target.y));
        (cx - tx).abs() <= 1 && (cy - ty).abs() <= 1
    }

    /// One tick of `Activity::Enter`.
    pub(crate) fn tick_enter(&mut self, i: usize) {
        let Some(e) = self.actors[i].inf.enter.clone() else {
            self.actors[i].activity = Activity::Idle;
            return;
        };
        if e.phase == EnterPhase::Exiting {
            if self.walk_straight(i, e.from.0, e.from.1) {
                self.end_enter(i);
            }
            return;
        }
        let target = self.resolve(e.target).filter(|&t| self.enter_valid(i, t, e.kind));
        let Some(t) = target else {
            // The target died, changed sides or cannot be entered any more:
            // a unit already inside walks out (OpenRA Enter: Exiting).
            if e.phase == EnterPhase::Entering {
                self.actors[i].inf.enter.as_mut().unwrap().phase = EnterPhase::Exiting;
            } else {
                self.end_enter(i);
            }
            return;
        };
        if e.phase == EnterPhase::Entering {
            let (tx, ty) = self.aim_point(t, e.from.0, e.from.1);
            if self.walk_straight(i, tx, ty) {
                self.enter_complete(i, t, e.kind);
            }
            return;
        }
        if !self.next_to(i, t) {
            self.approach_enter(i, t);
            return;
        }
        // Next to the target: wait for a capture delay, then go in.
        if e.kind == EnterKind::Capture {
            let Some(c) = self.capture_with(i, t).cloned() else {
                self.end_enter(i);
                return;
            };
            let ticks = e.ticks + 1;
            let en = self.actors[i].inf.enter.as_mut().unwrap();
            en.phase = EnterPhase::Wait;
            en.ticks = ticks;
            if ticks <= c.delay {
                return;
            }
            if !c.consumed {
                // Reusable engineers capture from where they stand (OpenRA:
                // ConsumedByCapture false captures at once and ends the activity).
                let owner = self.actors[i].owner;
                self.capture(t, owner, Some(i));
                self.end_enter(i);
                return;
            }
        }
        let (x, y) = (self.actors[i].x, self.actors[i].y);
        let en = self.actors[i].inf.enter.as_mut().unwrap();
        en.phase = EnterPhase::Entering;
        en.from = (x, y);
    }

    /// Walk toward a reachable cell next to the target (OpenRA MoveToTarget).
    fn approach_enter(&mut self, i: usize, t: usize) {
        let (x, y) = (self.actors[i].x, self.actors[i].y);
        let (ax, ay) = self.aim_point(t, x, y);
        let tcell = self.cell_index(ax, ay) as u32;
        let e = self.actors[i].inf.enter.as_ref().unwrap();
        if e.target_cell != tcell || self.actors[i].goal == NONE {
            let (cx, cy) = self.cell_of(ax, ay);
            let goal = self.path_goal(i, cx, cy);
            if goal == NONE {
                self.end_enter(i);
                return;
            }
            let a = &mut self.actors[i];
            a.goal = goal;
            a.best_dist = i32::MAX;
            a.stuck_ticks = 0;
            a.inf.enter.as_mut().unwrap().target_cell = tcell;
        }
        let goal = self.actors[i].goal;
        if self.on_cell(i, goal) || self.stuck_toward(i, goal) {
            // At the closest reachable cell and still not next to it: give up.
            if !self.next_to(i, t) && (self.on_cell(i, goal) || self.actors[i].stuck_ticks > STUCK_LIMIT) {
                self.end_enter(i);
            }
            return;
        }
        self.move_toward(i, goal);
    }

    /// Move straight toward (x, y) at the unit's speed, through anything (a
    /// unit walking into a structure). True on arrival.
    fn walk_straight(&mut self, i: usize, x: i32, y: i32) -> bool {
        let a = &self.actors[i];
        let speed = self.rules.actors[a.ty as usize].unit.as_ref().map_or(0, |u| u.speed).max(1);
        let speed = self.modified_speed(i, speed).max(1);
        let d = dist(a.x, a.y, x, y);
        if d <= ENTERED.min(speed) {
            return true;
        }
        let (ax, ay) = (a.x, a.y);
        let a = &mut self.actors[i];
        if let Some(f) = facing_of(x - ax, y - ay) {
            a.facing = f;
        }
        if d <= speed {
            a.x = x;
            a.y = y;
        } else {
            a.x += ((x - ax) as i64 * speed as i64 / d as i64) as i32;
            a.y += ((y - ay) as i64 * speed as i64 / d as i64) as i32;
        }
        a.moved = true;
        false
    }

    /// Unit `i` got into `t`.
    fn enter_complete(&mut self, i: usize, t: usize, kind: EnterKind) {
        let owner = self.actors[i].owner;
        match kind {
            EnterKind::Capture => {
                self.capture(t, owner, Some(i));
                self.remove(i);
            }
            EnterKind::Infiltrate => {
                self.infiltrate(i, t);
                self.remove(i);
            }
            EnterKind::InstantRepair => {
                // InstantRepair: full health, the engineer is used up.
                let max = self.rules.actors[self.actors[t].ty as usize].hp;
                self.actors[t].hp = max;
                self.remove(i);
            }
            EnterKind::Demolish => {
                let Some(d) = self.rules.actors[self.actors[i].ty as usize].abilities.demolition.clone() else { return };
                let by = self.make_ref(i);
                if self.actors[t].inf.demolish.is_none() {
                    self.actors[t].inf.demolish = Some(Demolishing { at: self.tick + d.delay.max(0) as u32, by, owner });
                }
                // FlashTarget: the structure blinks white.
                self.actors[t].flash = (d.flash_delay + d.flashes * d.flash_interval).max(1);
                self.actors[i].inf.disguise = None;
                self.uncloak_on(i, "Demolish");
                self.actors[i].inf.enter.as_mut().unwrap().phase = EnterPhase::Exiting;
            }
            EnterKind::RepairBridge => {
                // OpenRA RepairBridge: the hut's bridge is repaired span by span (bridges.rs).
                self.repair_bridge_at_hut(t, owner);
                self.remove(i);
            }
        }
    }

    // ---- Right clicks -------------------------------------------------------------------

    /// The infantry order a right click on actor `t` gives `units`, if any,
    /// in OpenRA's order targeter priority: Disguise and Infiltrate (7),
    /// then C4, capture and instant or bridge repair (6), then healing and
    /// repairing friends (the Medic's and Mechanic's armaments).
    pub(crate) fn infantry_smart_action(&self, player: u8, units: &[usize], t: usize) -> Option<SmartAction> {
        let ta = &self.actors[t];
        let any = |f: &dyn Fn(usize) -> bool| units.iter().any(|&u| f(u));
        if any(&|u| self.can_infiltrate(u, t)) {
            return Some(SmartAction::Infiltrate);
        }
        if ta.kind == Kind::Infantry && any(&|u| self.can_disguise_as(u, t)) {
            return Some(SmartAction::Disguise);
        }
        if any(&|u| self.can_demolish(u, t, false)) {
            return Some(SmartAction::Demolish);
        }
        if any(&|u| self.can_capture(u, t)) {
            let outside = units.iter().any(|&u| self.capture_with(u, t).is_some_and(|c| !c.consumed));
            return Some(if outside { SmartAction::CaptureOutside } else { SmartAction::Capture });
        }
        if any(&|u| self.can_repair_bridge(u, t)) {
            return Some(SmartAction::InstantRepair);
        }
        if any(&|u| self.instant_repair_target(u, t)) {
            return Some(if any(&|u| self.can_instant_repair(u, t)) { SmartAction::InstantRepair } else { SmartAction::RepairBlocked });
        }
        // A thief over an aircraft in the air, say: capturable, not now.
        if self.rules.actors[ta.ty as usize].abilities.capturable.is_some()
            && !self.are_allies(player, ta.owner)
            && any(&|u| {
                let caps = self.rules.actors[self.actors[u].ty as usize].abilities.captures.as_ref();
                let cap = self.rules.actors[ta.ty as usize].abilities.capturable.as_ref();
                caps.zip(cap).is_some_and(|(l, c)| l.iter().any(|x| x.types.iter().any(|ty| c.types.contains(ty))))
            })
        {
            return Some(SmartAction::EnterBlocked);
        }
        if self.are_allies(player, ta.owner) && any(&|u| self.can_heal(u, t)) {
            let mech = units.iter().any(|&u| self.can_heal(u, t) && ta.kind != Kind::Infantry);
            return Some(if mech { SmartAction::Fix } else { SmartAction::Heal });
        }
        None
    }

    /// Carry out an infantry smart order on the actor at (x, y): the units
    /// that can do it go, the rest move there (OpenRA gives each unit its own
    /// best order).
    pub(crate) fn order_smart_infantry(&mut self, action: SmartAction, units: &[usize], t: usize, x: i32, y: i32) {
        let mut rest = Vec::new();
        for &u in units {
            let done = match action {
                SmartAction::Infiltrate => self.order_enter(u, t, EnterKind::Infiltrate),
                SmartAction::Disguise => {
                    let ok = self.can_disguise_as(u, t);
                    if ok {
                        self.disguise_as(u, t);
                    }
                    ok
                }
                SmartAction::Demolish => self.order_enter(u, t, EnterKind::Demolish),
                SmartAction::Capture | SmartAction::CaptureOutside => self.order_enter(u, t, EnterKind::Capture),
                SmartAction::InstantRepair => {
                    self.order_enter(u, t, EnterKind::InstantRepair) || self.order_enter(u, t, EnterKind::RepairBridge)
                }
                SmartAction::Heal | SmartAction::Fix => {
                    let ok = self.can_heal(u, t);
                    if ok {
                        self.order_attack(&[u], t, false);
                    }
                    ok
                }
                // Undamaged structures and blocked targets: nothing to do there (OpenRA
                // ignores the order), and the others do not move either.
                SmartAction::RepairBlocked | SmartAction::EnterBlocked => true,
                _ => false,
            };
            if !done {
                rest.push(u);
            }
        }
        if !rest.is_empty() {
            // Everyone else with a weapon attacks an enemy target, the rest moves there.
            if self.are_enemies(self.actors[rest[0]].owner, self.actors[t].owner) {
                let (fighters, others): (Vec<usize>, Vec<usize>) =
                    rest.iter().partition(|&&u| self.has_weapons(u) && !self.rules.actors[self.actors[u].ty as usize].targets_allies);
                self.order_attack(&fighters, t, true);
                self.order_move(&others, x, y, false);
            } else {
                self.order_move(&rest, x, y, false);
            }
        }
    }

    // ---- Sonar Pulse (SpawnActorPower) -----------------------------------------------

    /// Fire a SpawnActorPower (the Sonar Pulse): the target cell must have one
    /// of the power's terrain types and be explored unless AllowUnderShroud;
    /// then its detector works there for `duration` ticks.
    pub(crate) fn fire_spawn_actor(&mut self, player: u8, info: &SupportPowerInfo, x: i32, y: i32) -> bool {
        if !self.spawn_actor_valid(player, info, x, y) {
            return false;
        }
        let (cx, cy) = self.cell_of(x, y);
        let (x, y) = (cell_center(cx), cell_center(cy));
        self.inf.pulses.push(Pulse {
            owner: player,
            x,
            y,
            range: info.detect_range,
            types: info.detect_types.clone(),
            until: self.tick + info.duration.max(0) as u32,
        });
        self.inf.fx.push(InfantryFx { x, y, kind: InfantryFxKind::Sonar, owner: player, ttl: 25, max: 25 });
        self.effects.push(Effect { x, y, tx: x, ty: y, kind: EffectKind::Naval(0), ttl: 12, max: 12 });
        true
    }

    /// SpawnActorPower.Validate: terrain and shroud of the target cell.
    pub fn spawn_actor_valid(&self, player: u8, info: &SupportPowerInfo, x: i32, y: i32) -> bool {
        let ci = self.cell_index(x, y);
        let terrain = crate::abilities::terrain_name(self.map.terrain[ci]);
        (info.terrain.is_empty() || info.terrain.iter().any(|t| t == terrain))
            && (info.allow_under_shroud || self.players[player as usize].explored[ci] != 0)
    }

    /// Players (bits) whose Sonar Pulses detect cloak types `types` at (x, y).
    pub(crate) fn pulse_detectors(&self, x: i32, y: i32, owner: u8, types: &[String]) -> u32 {
        let mut mask = 0;
        for p in &self.inf.pulses {
            if p.owner != owner && p.owner < 32 && p.types.iter().any(|t| types.contains(t)) && dist(x, y, p.x, p.y) <= p.range {
                mask |= 1 << p.owner;
            }
        }
        mask
    }

    /// Whether one of unit `i`'s weapons can fire at actor `t` as it is now.
    pub(crate) fn can_attack_class_now(&self, i: usize, t: usize) -> bool {
        self.rules.actors[self.actors[i].ty as usize].can_attack_class(&self.rules, self.target_class(t))
    }

    // ---- State hash -----------------------------------------------------------------------

    /// Infantry state of one live actor for `World::state_hash`.
    pub(crate) fn hash_infantry_actor(&self, a: &crate::world::Actor, mix: &mut impl FnMut(i64)) {
        mix(a.faction as i64);
        let s = &a.inf;
        if let Some(e) = &s.enter {
            for v in [e.kind as i64, e.target as i64, e.phase as i64, e.ticks as i64, e.from.0 as i64, e.from.1 as i64] {
                mix(v);
            }
        }
        if let Some(d) = s.disguise {
            mix(d.ty as i64);
            mix(d.owner as i64);
        }
        if let Some(l) = s.leap {
            for v in [l.target as i64, l.ticks as i64, l.length as i64, l.tx as i64, l.ty as i64] {
                mix(v);
            }
        }
        mix(s.leaper as i64);
        mix(s.eat as i64);
        if let Some(d) = s.demolish {
            mix(d.at as i64);
            mix(d.by as i64);
        }
        mix(s.infiltrated_by as i64);
    }

    /// World-level infantry state for `World::state_hash`.
    pub(crate) fn hash_infantry_world(&self, mix: &mut impl FnMut(i64)) {
        for p in &self.players {
            mix(p.proxies.len() as i64);
            for &t in &p.proxies {
                mix(t as i64);
            }
        }
        for &(left, total) in &self.inf.outage {
            mix(left as i64);
            mix(total as i64);
        }
        for p in &self.inf.pulses {
            for v in [p.owner as i64, p.x as i64, p.y as i64, p.until as i64] {
                mix(v);
            }
        }
        for s in &self.inf.shots {
            for v in [s.tick as i64, s.shooter as i64, s.target as i64, s.weapon as i64] {
                mix(v);
            }
        }
    }

    // ---- Player experience --------------------------------------------------------------

    /// OpenRA PlayerExperience: points for captures and infiltrations (gamerules.rs).
    fn note_player_experience(&mut self, player: u8, points: i32) {
        if points > 0 {
            self.give_player_experience(player, points as i64);
        }
    }
}

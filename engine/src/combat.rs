//! Combat: target acquisition, aiming, firing, projectiles and damage.
//!
//! Units and defensive structures share the same weapon code. Every number
//! comes from OpenRA's weapon rules: range and minimum range, reload and
//! burst, projectile speed and inaccuracy, and damage warheads with spread,
//! falloff, an armour-type versus table, target classes and delays.

use crate::math::{dist, dist_sq, facing_of, facing_vec, turn_toward, CELL};
use crate::rules::{Kind, Projectile as ProjKind, Stance, WarheadKind};
use crate::sound_events::{SoundEventKind, DAMAGE_EVENT_QUIET_TICKS};
use crate::veterancy::Shot;
use crate::world::{cell_center, Activity, Effect, EffectKind, PendingImpact, Projectile, World, MAX_WEAPONS, NONE};

/// Ticks between two auto-target scans of an actor: a fresh random number
/// from MIN up to (not including) MAX after every scan, like OpenRA
/// AutoTarget (MinimumScanTimeInterval 3, MaximumScanTimeInterval 8). With
/// a fixed interval the side whose scans happen to come first would win
/// every mirrored fight.
pub(crate) const MIN_SCAN_TICKS: i32 = 3;
pub(crate) const MAX_SCAN_TICKS: i32 = 8;

/// What a weapon fires at: an actor, or a point on the ground (force-fire).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum FireTarget {
    Actor(usize),
    Ground(i32, i32),
}

impl World {
    pub(crate) fn has_weapons(&self, i: usize) -> bool {
        !self.rules.actors[self.actors[i].ty as usize].weapons.is_empty()
    }

    /// Current target classes of actor `i` (rules::TARGET_* bits). Most actors
    /// use their kind's class; submarines switch between surfaced and
    /// submerged classes (naval.rs).
    pub fn target_class(&self, i: usize) -> u32 {
        // Trees, bridges and untargetable actors (neutral.rs).
        if let Some(c) = self.world_target_class(i) {
            return c;
        }
        // Damaged units are also Heal or Repair targets (infantry_combat.rs).
        self.kind_class(i) | self.support_class(i)
    }

    fn kind_class(&self, i: usize) -> u32 {
        let a = &self.actors[i];
        match a.kind {
            Kind::Ship => self.ship_target_class(i),
            // Landed aircraft are ground targets, paratroopers under their
            // parachute airborne ones (plane.rs, target_kind).
            Kind::Aircraft | Kind::Infantry => self.target_kind(i).target_class(),
            // Naval yards are WaterActor and Structure in OpenRA (torpedoes hit them).
            Kind::Building if self.rules.actors[a.ty as usize].building.as_ref().is_some_and(|b| b.on_water) => {
                crate::rules::TARGET_STRUCTURE | crate::rules::TARGET_WATER
            }
            // Landed aircraft count as vehicles, paratroopers in the air as air (plane.rs).
            _ => self.target_kind(i).target_class(),
        }
    }

    /// Structures that need power (Tesla Coil, AA, superweapons) shut down on
    /// low power, and so does a structure its owner switched off with the
    /// power down button (repair.rs; OpenRA's `disabled` condition).
    pub fn is_powered_down(&self, i: usize) -> bool {
        let a = &self.actors[i];
        a.powered_off
            || (self.rules.actors[a.ty as usize].requires_power && self.players[a.owner as usize].low_power())
            // A spy's power outage (InfiltrateForPowerOutage, infantry.rs).
            || self.outage_disabled(i)
    }

    // ---- Target acquisition ------------------------------------------------

    /// Closest visible enemy that one of this actor's weapons can hit within
    /// range. Units are preferred over structures and walls are ignored, like
    /// OpenRA's auto-target priorities: below AttackAnything (Defend and
    /// ReturnFire, also while attack-moving) only defences count among the
    /// structures (AutoTargetPriority@DEFAULT has Defense but not Structure).
    pub(crate) fn scan_for_target(&self, i: usize) -> Option<usize> {
        // Medics and mechanics look for friends to treat (infantry_combat.rs).
        if self.heals(i) {
            return self.scan_for_heal_target(i);
        }
        let a = &self.actors[i];
        let info = &self.rules.actors[a.ty as usize];
        let any_structure = a.stance == Stance::AttackAnything || !self.has_stance(i);
        let range = info.max_range(&self.rules);
        if range == 0 {
            return None;
        }
        let r_cells = range / CELL + 2;
        let (cx, cy) = self.cell_of(a.x, a.y);
        let range_sq = (range as i64) * (range as i64);
        let mut best_unit: Option<(i64, usize)> = None;
        let mut best_building: Option<(i32, usize)> = None;
        let vis = &self.players[a.owner as usize].visible;
        for y in cy - r_cells..=cy + r_cells {
            for x in cx - r_cells..=cx + r_cells {
                if !self.map.contains(x, y) {
                    continue;
                }
                let ci = self.map.idx(x, y);
                if vis[ci] == 0 {
                    continue;
                }
                for &u in self.units_in_cell(ci) {
                    let u = u as usize;
                    let t = &self.actors[u];
                    if !t.alive
                        || !self.are_enemies(a.owner, t.owner)
                        || self.never_auto_targeted(u)
                        // A disguised spy looks friendly (OpenRA AppearsHostileTo; infantry.rs).
                        || !self.appears_hostile(u, i)
                        || !info.can_attack_class(&self.rules, self.target_class(u))
                        || !self.targetable(u, a.owner)
                    {
                        continue;
                    }
                    let d = dist_sq(a.x, a.y, t.px, t.py);
                    if d <= range_sq && best_unit.is_none_or(|(bd, bi)| d < bd || (d == bd && u < bi)) {
                        best_unit = Some((d, u));
                    }
                }
                let b = self.building_at[ci];
                if b != NONE && best_unit.is_none() {
                    let b = b as usize;
                    let t = &self.actors[b];
                    let tinfo = &self.rules.actors[t.ty as usize];
                    if t.alive
                        && self.are_enemies(a.owner, t.owner)
                        && !self.is_cloaked_from(b, a.owner)
                        // Walls, barrels and the like only when ordered (NoAutoTarget, neutral.rs).
                        && !self.never_auto_targeted(b)
                        && !tinfo.is_wall()
                        // An allied engineer is taking it over (CaptureManager.PreventsAutoTarget).
                        && !self.capture_protected(b, a.owner)
                        && (any_structure || tinfo.defense)
                        && info.can_attack_class(&self.rules, self.target_class(b))
                        // A mission condition can switch Targetable off (mission/conditions.rs).
                        && !(self.mission.is_some() && self.mission_untargetable(b))
                    {
                        let d = self.target_distance(b, a.x, a.y);
                        if d <= range && best_building.is_none_or(|(bd, bi)| d < bd || (d == bd && b < bi)) {
                            best_building = Some((d, b));
                        }
                    }
                }
            }
        }
        best_unit.map(|(_, u)| u).or(best_building.map(|(_, b)| b))
    }

    /// Whether `player` can currently target actor `t` (visible, and not cloaked).
    pub(crate) fn targetable(&self, t: usize, player: u8) -> bool {
        // Falling wrecks and the spy plane cannot be targeted (plane.rs); cloaked actors neither (abilities.rs).
        // Crates never; husks only with force-fire (`live_target`, husks.rs).
        !matches!(self.actors[t].kind, Kind::Crate | Kind::Husk)
            && self.is_visible_to(t, player)
            && !self.untargetable_aircraft(t)
            && !self.is_cloaked_from(t, player)
            // Mission conditions can switch Targetable off (mission/conditions.rs).
            && !(self.mission.is_some() && self.mission_untargetable(t))
    }

    // ---- Fire targets -------------------------------------------------------------

    /// Where actor `t` stood when this tick began. Units processed earlier in
    /// a tick have moved already; range checks, aiming and chasing read this
    /// instead, so every shooter of a tick sees the same picture whatever
    /// order the units are processed in (mirrored fights stay mirrored).
    pub(crate) fn tick_start_pos(&self, t: usize) -> (i32, i32) {
        (self.actors[t].px, self.actors[t].py)
    }

    /// `hit_distance` from (x, y) to `t` where it stood when the tick began
    /// (`tick_start_pos`). Structures and mines never move.
    pub(crate) fn target_distance(&self, t: usize, x: i32, y: i32) -> i32 {
        let a = &self.actors[t];
        if matches!(a.kind, Kind::Building | Kind::Mine) {
            return self.hit_distance(t, x, y);
        }
        let r = self.rules.actors[a.ty as usize].unit.as_ref().map_or(0, |u| u.radius);
        (dist(x, y, a.px, a.py) - r / 2).max(0)
    }

    pub(crate) fn fire_target_pos(&self, ft: FireTarget) -> (i32, i32) {
        match ft {
            FireTarget::Actor(t) => self.tick_start_pos(t),
            FireTarget::Ground(x, y) => (x, y),
        }
    }

    pub(crate) fn fire_target_class(&self, ft: FireTarget) -> u32 {
        match ft {
            FireTarget::Actor(t) => self.target_class(t),
            FireTarget::Ground(x, y) => self.ground_class(x, y),
        }
    }

    /// Distance from (x, y) to the target's hit shape.
    pub(crate) fn fire_target_distance(&self, ft: FireTarget, x: i32, y: i32) -> i32 {
        match ft {
            FireTarget::Actor(t) => self.target_distance(t, x, y),
            FireTarget::Ground(gx, gy) => dist(x, y, gx, gy),
        }
    }

    // ---- Automatic targeting (OpenRA AutoTarget) -----------------------------------

    /// Count down to actor `i`'s next auto-target scan; true when it is due
    /// (the next one is then `MIN_SCAN_TICKS` to `MAX_SCAN_TICKS` away).
    fn scan_due(&mut self, i: usize) -> bool {
        self.actors[i].scan_cooldown -= 1;
        if self.actors[i].scan_cooldown > 0 {
            return false;
        }
        self.actors[i].scan_cooldown = self.rng.range(MIN_SCAN_TICKS, MAX_SCAN_TICKS);
        true
    }

    /// Attack-move and guard scan: pick the closest enemy in range whatever the
    /// stance (OpenRA scans on attack-move regardless of it). Actors without
    /// AutoTarget (Demolition Truck) never pick targets themselves.
    pub(crate) fn try_auto_target(&mut self, i: usize) -> bool {
        if !self.has_stance(i) {
            return false;
        }
        if !self.scan_due(i) {
            return false;
        }
        if let Some(t) = self.scan_for_target(i) {
            self.engage(i, t, false);
            return true;
        }
        false
    }

    /// Idle actors by stance (OpenRA AutoTarget TickIdle and Damaged): shoot
    /// back at an attacker (ReturnFire and up), attack enemies in range
    /// (Defend and up) and chase them (AttackAnything only).
    pub(crate) fn try_idle_target(&mut self, i: usize) -> bool {
        let aggressor = std::mem::replace(&mut self.actors[i].aggressor, NONE);
        if !self.has_stance(i) {
            return false;
        }
        let stance = self.actors[i].stance;
        let hold = stance < Stance::AttackAnything;
        // Healers never shoot back (their weapons only treat friends).
        if stance >= Stance::ReturnFire && !self.heals(i) {
            if let Some(t) = self.retaliation_target(i, aggressor, hold) {
                self.engage(i, t, hold);
                return true;
            }
        }
        if stance < Stance::Defend {
            return false;
        }
        if !self.scan_due(i) {
            return false;
        }
        if let Some(t) = self.scan_for_target(i) {
            self.engage(i, t, hold);
            return true;
        }
        false
    }

    /// The enemy to shoot back at after being hit by `aggressor`: it, or what
    /// the actor would pick anyway under Defend and AttackAnything (OpenRA
    /// respects target priorities). With `hold` it must be in range already.
    fn retaliation_target(&self, i: usize, aggressor: u32, hold: bool) -> Option<usize> {
        let t = self.resolve(aggressor)?;
        let owner = self.actors[i].owner;
        let info = &self.rules.actors[self.actors[i].ty as usize];
        let tclass = self.target_class(t);
        if !self.actors[t].in_world() || !self.are_enemies(owner, self.actors[t].owner) || !self.targetable(t, owner) {
            return None;
        }
        // No retaliation against what looks friendly (AutoTarget: AppearsFriendlyTo).
        if !self.appears_hostile(t, i) {
            return None;
        }
        let range =
            info.weapons.iter().filter(|&&w| self.rules.weapons[w].can_target_class(tclass)).map(|&w| self.rules.weapons[w].range).max()?;
        if hold && self.target_distance(t, self.actors[i].x, self.actors[i].y) > range {
            return None;
        }
        if self.actors[i].stance > Stance::ReturnFire {
            if let Some(better) = self.scan_for_target(i) {
                return Some(better);
            }
        }
        Some(t)
    }

    /// Attack `t` on the actor's own initiative; `hold`: without moving.
    fn engage(&mut self, i: usize, t: usize, hold: bool) {
        let tref = self.make_ref(t);
        let seen = self.tick_start_pos(t);
        let a = &mut self.actors[i];
        a.target = tref;
        a.target_seen = Some(seen);
        a.forced = false;
        a.hold = hold;
        a.chase_cell = NONE;
        if a.kind != Kind::Building {
            a.activity = Activity::Attack;
        }
    }

    /// Current valid target of `i`, if any.
    pub(crate) fn live_target(&self, i: usize) -> Option<usize> {
        let owner = self.actors[i].owner;
        // Forced attacks (force-fire) may target anyone, own actors included,
        // but never the attacker itself.
        let forced = self.actors[i].forced;
        // Healers treat own and allied units only (Armament TargetRelationships Ally).
        let heals = self.heals(i);
        self.resolve(self.actors[i].target).filter(|&t| {
            let ok =
                if heals { self.are_allies(owner, self.actors[t].owner) } else { forced || self.are_enemies(owner, self.actors[t].owner) };
            t != i
                && (ok && self.targetable(t, owner)
                    // Husks: force-fire only (husks.rs).
                    || !heals && forced && self.actors[t].kind == Kind::Husk && self.is_visible_to(t, owner))
        })
    }

    // ---- Units ---------------------------------------------------------------

    pub(crate) fn tick_attack(&mut self, i: usize) {
        let Some(t) = self.live_target(i) else {
            if self.chase_last_seen(i) {
                return;
            }
            self.attack_over(i);
            return;
        };
        self.actors[i].target_seen = Some(self.tick_start_pos(t));
        let info = &self.rules.actors[self.actors[i].ty as usize];
        let tclass = self.target_class(t);
        let usable: Vec<usize> = info.weapons.iter().copied().filter(|&w| self.rules.weapons[w].can_target_class(tclass)).collect();
        if usable.is_empty() {
            self.actors[i].target = NONE;
            self.actors[i].activity = Activity::Idle;
            return;
        }
        let range = usable.iter().map(|&w| self.rules.weapons[w].range).max().unwrap();
        let min_range = usable.iter().map(|&w| self.rules.weapons[w].min_range).min().unwrap();
        let (x, y) = (self.actors[i].x, self.actors[i].y);
        let d = self.target_distance(t, x, y);
        if d <= range && d >= min_range {
            // Dogs leap onto their prey instead of firing from range (dog.rs).
            if self.leaps(i) {
                self.leap_attack(i, t);
            } else {
                self.aim_and_fire(i, t);
            }
            return;
        }
        // Defend and ReturnFire fights never move the unit: out of reach ends them.
        if self.actors[i].hold {
            let a = &mut self.actors[i];
            a.target = NONE;
            a.hold = false;
            a.activity = Activity::Idle;
            return;
        }
        let (tx, ty) = self.tick_start_pos(t);
        if d < min_range {
            // Artillery: back away until the target is outside minimum range.
            self.back_away_from(i, tx, ty);
            return;
        }
        // While attack-moving, a closer threat takes priority.
        if !self.actors[i].forced && self.actors[i].attack_move && self.try_auto_target(i) {
            return;
        }
        // Chase: path toward the target's cell (or the nearest reachable
        // one). A target the unit cannot get in range of (across a river,
        // on an island) is let go, as OpenRA's Attack ends when its move
        // within range falls short.
        let reach = range + self.target_extent(t);
        if !self.approach(i, tx, ty, Some(reach)) {
            self.attack_over(i);
        }
    }

    /// How far the hit shape of `t` reaches from its position at most
    /// (`target_distance` measures to the shape): half its footprint for a
    /// structure, else nothing a chase needs to allow for.
    fn target_extent(&self, t: usize) -> i32 {
        let a = &self.actors[t];
        match self.rules.actors[a.ty as usize].building.as_ref() {
            Some(b) if a.kind == Kind::Building => b.width.max(b.height) * CELL / 2,
            _ => 0,
        }
    }

    /// The attack of `i` is over (its target died, vanished or cannot be
    /// reached): back to guarding, on with the attack-move, or idle.
    fn attack_over(&mut self, i: usize) {
        self.actors[i].target = NONE;
        self.actors[i].target_seen = None;
        if self.resume_guard(i) {
            return;
        }
        if self.actors[i].attack_move {
            // Resume the attack-move toward the original destination.
            let (dx, dy) = self.actors[i].dest;
            let (gx, gy) = self.cell_toward(dx, dy, self.actors[i].x, self.actors[i].y);
            let goal = self.path_goal(i, gx, gy);
            let a = &mut self.actors[i];
            a.goal = goal;
            a.activity = if goal == NONE { Activity::Idle } else { Activity::Move };
            a.best_dist = i32::MAX;
            a.stuck_ticks = 0;
        } else {
            self.actors[i].activity = Activity::Idle;
        }
    }

    /// The target of `i` is alive but out of sight (or cloaked): head for
    /// where it was last seen, like OpenRA's Attack activity with its last
    /// visible target, and pick it up again once it shows. False when there
    /// is nothing to look for: the target died, changed sides or sits in a
    /// transport, the attack may not move (`hold`), nobody saw where it went,
    /// or the unit got within weapon range of that spot without seeing it.
    fn chase_last_seen(&mut self, i: usize) -> bool {
        let a = &self.actors[i];
        let (owner, forced) = (a.owner, a.forced);
        let Some((lx, ly)) = a.target_seen.filter(|_| !a.hold) else { return false };
        let Some(t) = self.resolve(a.target) else { return false };
        if t == i
            || !self.actors[t].in_world()
            || self.untargetable_aircraft(t)
            || !(forced || self.are_enemies(owner, self.actors[t].owner))
        {
            return false;
        }
        let tclass = self.target_class(t);
        let info = &self.rules.actors[self.actors[i].ty as usize];
        let Some(range) =
            info.weapons.iter().filter(|&&w| self.rules.weapons[w].can_target_class(tclass)).map(|&w| self.rules.weapons[w].range).max()
        else {
            return false;
        };
        if dist(self.actors[i].x, self.actors[i].y, lx, ly) <= range {
            return false;
        }
        // While attack-moving, an enemy in sight on the way comes first.
        if !forced && self.actors[i].attack_move && self.try_auto_target(i) {
            return true;
        }
        self.approach(i, lx, ly, Some(range))
    }

    // ---- Opportunity fire (OpenRA AttackTurreted) -------------------------------

    /// A turreted unit on a plain move (OpenRA AttackFollow OpportunityFire:
    /// tanks, the Ranger, ships with turrets) shoots at enemies in range
    /// without leaving its move: the turret aims, the hull drives on. It
    /// scans like an idle unit under its stance (Defend and up), every few
    /// ticks (`scan_due`), and keeps a target while it stays in range.
    /// Units that aim with their body (infantry, artillery, V2) do not.
    pub(crate) fn opportunity_fire(&mut self, i: usize) {
        let info = &self.rules.actors[self.actors[i].ty as usize];
        if !info.opportunity_fire || !self.has_stance(i) || self.actors[i].stance < Stance::Defend {
            self.actors[i].opportunity = NONE;
            return;
        }
        let range = info.max_range(&self.rules);
        let (x, y, owner) = (self.actors[i].x, self.actors[i].y, self.actors[i].owner);
        let keep = self.resolve(self.actors[i].opportunity).filter(|&t| {
            t != i
                && self.actors[t].in_world()
                && self.are_enemies(owner, self.actors[t].owner)
                && self.targetable(t, owner)
                && self.target_distance(t, x, y) <= range
        });
        let t = match keep {
            Some(t) => Some(t),
            None => {
                self.actors[i].opportunity = NONE;
                if !self.scan_due(i) {
                    return;
                }
                self.scan_for_target(i)
            }
        };
        let Some(t) = t else { return };
        self.actors[i].opportunity = self.make_ref(t);
        self.aim_and_fire(i, t);
    }

    // ---- Structures -----------------------------------------------------------

    /// Defences: keep a target, aim the turret and fire. Unpowered ones idle.
    pub(crate) fn tick_defense(&mut self, i: usize) {
        if !self.has_weapons(i) || self.is_powered_down(i) {
            return;
        }
        let info = &self.rules.actors[self.actors[i].ty as usize];
        let range = info.max_range(&self.rules);
        let keep = self.live_target(i).filter(|&t| self.target_distance(t, self.actors[i].x, self.actors[i].y) <= range);
        let t = match keep {
            Some(t) => t,
            None => {
                self.actors[i].target = NONE;
                if !self.try_idle_target(i) {
                    return;
                }
                match self.live_target(i) {
                    Some(t) => t,
                    None => return,
                }
            }
        };
        self.aim_and_fire(i, t);
    }

    /// Self repair (Mammoth Tank): heals below a health threshold after a damage cooldown.
    pub(crate) fn tick_self_heal(&mut self, i: usize) {
        let ty = self.actors[i].ty as usize;
        let Some(h) = self.rules.actors[ty].self_heal.clone() else { return };
        let max = self.rules.actors[ty].hp;
        let a = &mut self.actors[i];
        if a.hp * 100 >= max * h.start_if_below || self.tick < a.last_damaged + h.damage_cooldown as u32 {
            a.heal_timer = 0;
            return;
        }
        a.heal_timer += 1;
        if a.heal_timer >= h.delay {
            a.heal_timer = 0;
            a.hp = (a.hp + h.step).min(max);
        }
    }

    // ---- Firing ------------------------------------------------------------------

    pub(crate) fn aim_and_fire(&mut self, i: usize, t: usize) {
        self.aim_and_fire_at(i, FireTarget::Actor(t));
    }

    /// Turn toward the target and fire every weapon that is ready and in range.
    pub(crate) fn aim_and_fire_at(&mut self, i: usize, ft: FireTarget) {
        let ty = self.actors[i].ty as usize;
        let info = &self.rules.actors[ty];
        let turret = info.turret_turn_speed;
        let unit = info.unit.clone();
        let (x, y) = (self.actors[i].x, self.actors[i].y);
        let (tx, ty_) = self.fire_target_pos(ft);
        let desired = facing_of(tx - x, ty_ - y).unwrap_or(self.actors[i].facing);
        let aligned = {
            let a = &mut self.actors[i];
            if let Some(ts) = turret {
                a.turret = turn_toward(a.turret, desired, ts);
                a.turret == desired
            } else if let Some(u) = &unit {
                if u.turn_in_place {
                    a.facing = desired;
                    true
                } else {
                    a.facing = turn_toward(a.facing, desired, u.turn_speed);
                    a.facing == desired
                }
            } else {
                true // structures without a turret (Tesla Coil) fire in any direction
            }
        };
        if !aligned {
            return;
        }
        let tclass = self.fire_target_class(ft);
        let reload_override = self.rules.actors[ty].reload_override;
        let weapons = self.rules.actors[ty].weapons.clone();
        let d = self.fire_target_distance(ft, x, y);
        for (slot, &w) in weapons.iter().enumerate().take(MAX_WEAPONS) {
            let wi = &self.rules.weapons[w];
            if self.actors[i].reload[slot] > 0 || !wi.can_target_class(tclass) || d > wi.range || d < wi.min_range {
                continue;
            }
            // Submarines surface to fire (Cloak UncloakOn: Attack).
            self.naval_on_fire(i);
            // Armament.FireDelay holds the shot back (infantry_combat.rs).
            self.fire_or_delay(i, slot, ft, w);
            // Firing heats vehicles up in a heat wave (weather.rs).
            self.actors[i].env.fired = true;
            // Uncloak on attack; a demolition truck detonates (abilities.rs).
            self.on_fire(i);
            // Armed civilians may panic when they shoot (neutral.rs).
            self.on_world_fired(i);
            if !self.actors[i].alive {
                return;
            }
            let wi = &self.rules.weapons[w];
            // Veterans reload faster (ReloadDelayMultiplier, veterancy.rs); burst delays stay.
            let full_reload = self.modified_reload(i, reload_override.unwrap_or(wi.reload));
            let a = &mut self.actors[i];
            a.burst_shot[slot] += 1;
            if a.burst_shot[slot] < wi.burst {
                a.reload[slot] = wi.burst_delay(a.burst_shot[slot] - 1).max(1);
            } else {
                a.burst_shot[slot] = 0;
                // Overheated vehicles fire slower (weather.rs).
                a.reload[slot] = if a.env.overheated { full_reload * crate::weather::OVERHEAT_RELOAD_PCT / 100 } else { full_reload };
            }
        }
    }

    pub(crate) fn fire(&mut self, i: usize, t: usize, w: usize) {
        self.fire_on(i, FireTarget::Actor(t), w);
    }

    /// Fire weapon `w` of actor `i` once at a target.
    pub(crate) fn fire_on(&mut self, i: usize, ft: FireTarget, w: usize) {
        let (sx, sy, facing, owner) = {
            let a = &self.actors[i];
            let info = &self.rules.actors[a.ty as usize];
            let f = if info.turret_turn_speed.is_some() { a.turret } else { a.facing };
            let (vx, vy) = facing_vec(f);
            let muzzle = match a.kind {
                Kind::Infantry => 128,
                Kind::Building => 256,
                Kind::Vehicle | Kind::Ship | Kind::Aircraft | Kind::Mine | Kind::Husk | Kind::Crate | Kind::Proxy => 384,
            };
            (a.x + vx * muzzle / 1024, a.y + vy * muzzle / 1024, f, a.owner)
        };
        let shooter_ty = self.actors[i].ty as i32;
        self.sound.push(SoundEventKind::Fire, w as i32, sx, sy, owner, shooter_ty);
        // Muzzle flash, recoil and the Tesla charge (fx.rs, presentation only).
        self.note_fire(i, w);
        // The shooter gets the kill and its rank's firepower applies (veterancy.rs).
        let shot = self.shot_of(i);
        // Aim at the target's hit shape point closest to the shooter (buildings are big).
        let (mut tx, mut ty) = match ft {
            // Units are aimed at where they stood when the tick began (`tick_start_pos`).
            FireTarget::Actor(t) if !matches!(self.actors[t].kind, Kind::Building) => self.tick_start_pos(t),
            FireTarget::Actor(t) => self.aim_point(t, sx, sy),
            FireTarget::Ground(x, y) => (x, y),
        };
        let wi = &self.rules.weapons[w];
        if wi.inaccuracy > 0 {
            // OpenRA scales inaccuracy with the distance relative to max range.
            let d = dist(sx, sy, tx, ty);
            let r = (wi.inaccuracy as i64 * d as i64 / wi.range.max(1) as i64) as i32;
            if r > 0 {
                tx += self.rng.range(-r, r + 1);
                ty += self.rng.range(-r, r + 1);
            }
        }
        match wi.projectile {
            // Hitscan shots and Tesla bolts land at once, but their damage
            // waits until every actor has acted this tick (see `land_shot`).
            ProjKind::Instant => {
                let alt = self.fire_target_altitude(ft);
                self.land_shot(w, tx, ty, alt, owner, shot, true);
            }
            ProjKind::Tesla => {
                self.effects.push(Effect { x: sx, y: sy, tx, ty, kind: EffectKind::TeslaBolt, ttl: 6, max: 6 });
                let alt = self.fire_target_altitude(ft);
                self.land_shot(w, tx, ty, alt, owner, shot, true);
            }
            ProjKind::Bullet | ProjKind::Missile => {
                // Shots at the ground fly to the point; missiles home on actors only.
                let target = match ft {
                    FireTarget::Actor(t) => self.make_ref(t),
                    FireTarget::Ground(..) => NONE,
                };
                self.projectiles.push(Projectile { x: sx, y: sy, tx, ty, weapon: w as u16, owner, target, facing, shot });
            }
            // GravityBomb: falls from the shooter's altitude where it was released (plane.rs).
            ProjKind::Bomb => {
                let alt = self.actors[i].altitude;
                self.drop_bomb(w, sx, sy, owner, alt, shot);
            }
        }
    }

    pub(crate) fn aim_point(&self, t: usize, sx: i32, sy: i32) -> (i32, i32) {
        let a = &self.actors[t];
        // Bridges are aimed at their centre (bridges.rs).
        if a.kind != Kind::Building || self.rules.actors[a.ty as usize].world.bridge.is_some() {
            return (a.x, a.y);
        }
        let b = self.rules.actors[a.ty as usize].building.as_ref().unwrap();
        let mut best = (i64::MAX, a.x, a.y);
        for &(dx, dy) in &b.hit_cells {
            let (cx, cy) = (cell_center(a.cx + dx), cell_center(a.cy + dy));
            let d = dist_sq(sx, sy, cx, cy);
            if d < best.0 {
                best = (d, cx, cy);
            }
        }
        (best.1, best.2)
    }

    pub(crate) fn tick_projectiles(&mut self) {
        // Delayed warheads (Vulcan bursts, chained death explosions) land first.
        let tick = self.tick;
        let due: Vec<PendingImpact> = {
            let (due, rest): (Vec<PendingImpact>, Vec<PendingImpact>) =
                std::mem::take(&mut self.pending).into_iter().partition(|p| p.tick <= tick);
            self.pending = rest;
            due
        };
        for p in due {
            self.apply_warhead(p.weapon as usize, p.warhead as usize, p.x, p.y, p.altitude, p.owner, p.shot);
        }
        let mut k = 0;
        while k < self.projectiles.len() {
            let p = &self.projectiles[k];
            let wi = &self.rules.weapons[p.weapon as usize];
            // Missiles home on a live target; bullets fly to the aimed point.
            let (mut tx, mut ty) = (p.tx, p.ty);
            if wi.projectile == ProjKind::Missile {
                if let Some(t) = self.resolve(p.target) {
                    let (ax, ay) = self.aim_point(t, p.x, p.y);
                    tx = ax;
                    ty = ay;
                }
            }
            let d = dist(p.x, p.y, tx, ty);
            let speed = wi.speed.max(1);
            if d <= speed {
                let (w, owner, shot) = (p.weapon as usize, p.owner, p.shot);
                // A shot at an aircraft bursts in the air (no smudges below, smudges.rs).
                let alt = self.resolve(p.target).map_or(0, |t| self.actors[t].altitude);
                self.projectiles.swap_remove(k);
                self.land_shot(w, tx, ty, alt, owner, shot, false);
                continue;
            }
            let p = &mut self.projectiles[k];
            p.x += ((tx - p.x) as i64 * speed as i64 / d as i64) as i32;
            p.y += ((ty - p.y) as i64 * speed as i64 / d as i64) as i32;
            p.tx = tx;
            p.ty = ty;
            if let Some(f) = facing_of(tx - p.x, ty - p.y) {
                p.facing = f;
            }
            k += 1;
        }
    }

    /// A weapon nobody in particular fired lands at a point (see `impact_shot`).
    pub(crate) fn impact(&mut self, w: usize, x: i32, y: i32, owner: u8) {
        self.impact_shot(w, x, y, owner, Shot::NONE);
    }

    /// A weapon lands at a point: each warhead applies now or after its delay.
    /// `shot` credits kills to the shooter and carries its firepower.
    pub(crate) fn impact_shot(&mut self, w: usize, x: i32, y: i32, owner: u8, shot: Shot) {
        self.land_shot(w, x, y, 0, owner, shot, false);
    }

    /// Height of what a shot was fired at (an aircraft in the air, or 0).
    fn fire_target_altitude(&self, ft: FireTarget) -> i32 {
        match ft {
            FireTarget::Actor(t) => self.actors[t].altitude,
            FireTarget::Ground(..) => 0,
        }
    }

    /// `impact_shot`; with `end_of_tick`, warheads without a delay apply
    /// with the delayed ones in `tick_projectiles`, after every actor has
    /// acted this tick. Shots fired in the same tick then resolve together:
    /// the actor processed first does not kill its target before the target
    /// fires back, so mirrored fights do not depend on processing order.
    /// `altitude`: the height it burst at (the warheads that change no
    /// health skip their smudges and resource changes above the ground).
    #[allow(clippy::too_many_arguments)]
    fn land_shot(&mut self, w: usize, x: i32, y: i32, altitude: i32, owner: u8, shot: Shot, end_of_tick: bool) {
        // The weapon's explosions where they land (OpenRA CreateEffect
        // warheads: on the ground, in open water, on a ship or in the air; fx.rs).
        let class = self.impact_class(x, y);
        self.sound.push(SoundEventKind::Impact, w as i32, x, y, owner, i32::from(class == crate::fx::IMPACT_WATER));
        self.spawn_weapon_effects(w, x, y, class);
        // Damage warheads, then the ones that change no health (smudges.rs),
        // numbered after them.
        for h in 0..self.warhead_count(w) {
            let delay = self.warhead_delay(w, h);
            if delay > 0 || end_of_tick {
                self.pending.push(PendingImpact {
                    tick: self.tick + delay as u32,
                    weapon: w as u16,
                    warhead: h as u8,
                    x,
                    y,
                    altitude,
                    owner,
                    shot,
                });
            } else {
                self.apply_warhead(w, h, x, y, altitude, owner, shot);
            }
        }
        // FireCluster warheads fire their weapon at the cells around (neutral.rs).
        for (cw, cx, cy) in self.cluster_targets(w, x, y) {
            self.land_shot(cw, cx, cy, 0, owner, shot, end_of_tick);
        }
    }

    /// Damage warheads plus the ones that change no health of weapon `w`.
    pub(crate) fn warhead_count(&self, w: usize) -> usize {
        let wi = &self.rules.weapons[w];
        wi.warheads.len() + wi.effects.len()
    }

    /// Delay of warhead `h` (damage warheads first, then the effects).
    pub(crate) fn warhead_delay(&self, w: usize, h: usize) -> i32 {
        let wi = &self.rules.weapons[w];
        match wi.warheads.get(h) {
            Some(d) => d.delay,
            None => wi.effects.get(h - wi.warheads.len()).map_or(0, |e| e.delay),
        }
    }

    /// Apply one damage warhead. Friendly fire applies, as in OpenRA.
    /// Kills are credited to `owner` for the observer stats (observer.rs) and
    /// to `shot.source` for veterancy (veterancy.rs).
    #[allow(clippy::too_many_arguments)]
    fn apply_warhead(&mut self, w: usize, h: usize, x: i32, y: i32, altitude: i32, owner: u8, shot: Shot) {
        let damage_warheads = self.rules.weapons[w].warheads.len();
        if h >= damage_warheads {
            self.apply_effect(w, h - damage_warheads, x, y, altitude);
            return;
        }
        let wh = &self.rules.weapons[w].warheads[h];
        let radius = wh.damage_radius();
        let r_cells = radius / CELL + 2;
        let (cx, cy) = self.cell_of(x, y);
        let mut hits: Vec<(usize, i32)> = Vec::new();
        let mut seen_buildings: Vec<usize> = Vec::new();
        for yy in cy - r_cells..=cy + r_cells {
            for xx in cx - r_cells..=cx + r_cells {
                if !self.map.contains(xx, yy) {
                    continue;
                }
                let ci = self.map.idx(xx, yy);
                for &u in self.units_in_cell(ci) {
                    let u = u as usize;
                    // Warhead.ValidRelationships (the Heal and Repair warheads only touch friends).
                    if self.actors[u].alive && wh.affects_class(self.target_class(u)) && self.warhead_relates(wh, owner, u) {
                        let d = self.hit_distance(u, x, y);
                        if d <= radius {
                            hits.push((u, d));
                        }
                    }
                }
                let b = self.building_at[ci];
                if b != NONE && !seen_buildings.contains(&(b as usize)) {
                    let b = b as usize;
                    seen_buildings.push(b);
                    if self.actors[b].alive && wh.affects_class(self.target_class(b)) && self.warhead_relates(wh, owner, b) {
                        let d = self.hit_distance(b, x, y);
                        if d <= radius {
                            hits.push((b, d));
                        }
                    }
                }
                // Mines (abilities.rs) are GroundActor targets too, and husks (husks.rs).
                if let Some(m) = self.mine_at(ci) {
                    if wh.affects(Kind::Mine) {
                        let d = self.hit_distance(m, x, y);
                        if d <= radius {
                            hits.push((m, d));
                        }
                    }
                }
                if let Some(h) = self.husk_at(ci) {
                    if wh.affects(Kind::Husk) {
                        let d = self.hit_distance(h, x, y);
                        if d <= radius {
                            hits.push((h, d));
                        }
                    }
                }
            }
        }
        // Bridges lie over cells without claiming them (bridges.rs).
        for b in self.bridges_near(cx, cy, r_cells) {
            if self.actors[b].alive && wh.affects_class(self.target_class(b)) {
                let d = self.hit_distance(b, x, y);
                if d <= radius {
                    hits.push((b, d));
                }
            }
        }
        let damages: Vec<(usize, i32)> = hits
            .iter()
            .map(|&(u, d)| {
                let info = &self.rules.actors[self.actors[u].ty as usize];
                let fall = wh.falloff_at(d) as i64;
                let base = match wh.kind {
                    // HealthPercentageDamage: a share of the victim's maximum health.
                    WarheadKind::Percent => info.hp as i64 * wh.damage as i64 / 100,
                    _ => wh.damage as i64,
                };
                // The shooter's FirepowerMultiplier (veterancy.rs), then versus and falloff.
                let base = base * shot.firepower as i64 / 100;
                (u, (base * wh.versus[info.armor] as i64 / 100 * fall / 100) as i32)
            })
            .collect();
        let types = wh.damage_types;
        self.with_damage_source(owner, |w| {
            for (u, dmg) in damages {
                w.damage_from(u, dmg, shot.source, types);
            }
        });
    }

    /// Damage without a shooter to credit and without damage types (tests).
    #[cfg(test)]
    pub(crate) fn damage(&mut self, u: usize, dmg: i32) {
        self.damage_from(u, dmg, NONE, 0);
    }

    /// Damage `u` by `dmg` (before its own modifiers), hit by actor reference
    /// `source` (or NONE) with damage type bits `types`. The victim's rank and
    /// prone modifiers apply, a trigger type throws infantry prone, and a kill
    /// gives `source` experience (veterancy.rs).
    pub(crate) fn damage_from(&mut self, u: usize, dmg: i32, source: u32, types: u32) {
        // Negative damage heals (the Medic's and Mechanic's warheads, infantry_combat.rs).
        if dmg < 0 {
            self.heal_by(u, -dmg);
            return;
        }
        if dmg <= 0 || !self.actors[u].alive || self.actors[u].invulnerable_until > self.tick || !self.has_health(u) {
            return;
        }
        // A destroyed bridge stays but takes no more damage (bridges.rs).
        if self.actors[u].hp <= 0 {
            return;
        }
        let dmg = self.modified_damage(u, dmg, types);
        if dmg <= 0 {
            return;
        }
        let tick = self.tick;
        let attacker = self.observer.source;
        let a = &mut self.actors[u];
        // One "under attack" event per burst of another player's fire on a
        // structure or a unit (sound_events.rs; OpenRA DamageNotifier ignores
        // damage without an attacker and the owner's own).
        let quiet = a.last_damaged == 0 || tick >= a.last_damaged + DAMAGE_EVENT_QUIET_TICKS;
        let hostile = attacker.is_some_and(|o| o != a.owner);
        let report = a.kind == Kind::Building && quiet && hostile;
        let report_unit = a.is_unit() && quiet && hostile;
        let dealt = dmg.min(a.hp.max(0));
        let before = a.hp;
        let old_hp = before;
        a.hp -= dmg;
        a.flash = 2;
        a.last_damaged = tick;
        if report || report_unit {
            let (ty, x, y, owner) = (a.ty as i32, a.x, a.y, a.owner);
            let kind = if report { SoundEventKind::BuildingDamaged } else { SoundEventKind::UnitDamaged };
            self.sound.push(kind, ty, x, y, owner, attacker.map_or(-1, i32::from));
        }
        // OpenRA SoundOnDamageTransition: DamagedSounds when it falls to Heavy (below half health) and lives.
        let a = &self.actors[u];
        let max = self.rules.actors[a.ty as usize].hp as i64;
        if a.hp > 0 && (a.hp as i64) * 100 < max * 50 && (before as i64) * 100 >= max * 50 {
            let (ty, x, y, owner) = (a.ty as i32, a.x, a.y, a.owner);
            self.sound.push(SoundEventKind::DamageHeavy, ty, x, y, owner, 0);
        }
        self.note_damage(u, dealt);
        // Mission triggers (OnDamaged).
        if self.mission_on {
            let victim = self.make_ref(u);
            self.script_events.push(crate::mission::ScriptEvent::Damaged { victim, attacker: source, damage: dealt });
        }
        // Damage smoke (fx.rs, presentation only).
        self.note_damage_fx(u);
        // An AI hears of hits on its actors (ai.rs: its bot modules respond,
        // and it remembers who hits its structures).
        crate::ai::note_damage(self, u, source, before);
        self.take_cover(u, types);
        // Damage states, panics, burning trees and the hospital (neutral.rs).
        self.on_world_damaged(u, old_hp, dmg, types);
        // Bridges change their template instead of dying (bridges.rs).
        if self.bridge_damaged(u) {
            return;
        }
        if self.actors[u].hp <= 0 {
            // Which death animation and scream (infantry_combat.rs).
            self.note_death_types(u, types);
            self.award_kill(u, source);
            self.kill_source = source;
            self.kill(u);
            return;
        }
        // OpenRA AutoTarget.Damaged: only idle actors react, never to own or allied fire.
        let a = &self.actors[u];
        let idle = a.activity == Activity::Idle && (a.kind != Kind::Building || a.target == NONE);
        if idle {
            if let Some(s) = self.resolve(source) {
                if self.are_enemies(self.actors[u].owner, self.actors[s].owner) {
                    self.actors[u].aggressor = source;
                }
            }
        }
    }

    /// Death explosion of a unit (e.g. Demolition Truck's mini nuke, V2 warhead).
    pub(crate) fn death_explosion(&mut self, i: usize) {
        // A plane shot down in the air already exploded where it crashed (plane.rs).
        if self.crashed(i) {
            return;
        }
        // FireWarheadsOnDeath: its explosions where it dies (fx.rs).
        if let Some(w) = self.rules.actors[self.actors[i].ty as usize].death_weapon {
            let (x, y) = (self.actors[i].x, self.actors[i].y);
            let class = self.impact_class(x, y);
            self.spawn_weapon_effects(w, x, y, class);
        }
        let a = &self.actors[i];
        // FireWarheadsOnDeath: the dying actor's firepower, nobody to credit (DamageSource Self).
        let shot = Shot { source: NONE, firepower: self.firepower_modifier(i) };
        let info = &self.rules.actors[a.ty as usize];
        // An ore truck only explodes with ore on board (FireWarheadsOnDeath
        // RequiresCondition: !no-ore): OreExplosion spills it (smudges.rs).
        if info.options.death_needs_resources && a.bales == 0 {
            return;
        }
        if let Some(w) = info.death_weapon {
            // One tick later, so chain reactions (barrels, neutral.rs) ripple
            // outward instead of recursing.
            let (x, y, owner) = (a.x, a.y, a.owner);
            self.queue_weapon(w, x, y, owner, shot, 1);
        }
    }
}

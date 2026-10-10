//! Combat details of the Red Alert infantry: the Medic's and Mechanic's
//! armaments that heal and repair friends (Armament TargetRelationships
//! Ally, the Heal and Repair target types and negative damage), deaths per
//! damage type (WithDeathAnimation, DeathSounds) and Armament FireDelay.

use crate::combat::FireTarget;
use crate::infantry::{Corpse, DelayedShot, DEATH_CRUSHED};
use crate::math::{dist_sq, CELL};
use crate::rules::{Kind, TARGET_HEAL, TARGET_REPAIR};
use crate::world::{World, NONE};

impl World {
    // ---- Heal and Repair targets ---------------------------------------------------

    /// The Heal or Repair target type actor `i` has right now: damaged
    /// infantry (Targetable@HEAL), damaged vehicles, ships and landed
    /// aircraft (Targetable@REPAIR); none in the air or under a parachute.
    pub(crate) fn support_class(&self, i: usize) -> u32 {
        let a = &self.actors[i];
        if a.hp <= 0 || a.hp >= self.rules.actors[a.ty as usize].hp || a.air.parachute || !a.is_unit() {
            return 0;
        }
        match a.kind {
            Kind::Infantry => TARGET_HEAL,
            Kind::Vehicle | Kind::Ship => TARGET_REPAIR,
            Kind::Aircraft if a.altitude == 0 => TARGET_REPAIR,
            _ => 0,
        }
    }

    /// Warhead.ValidRelationships: whether a warhead of `owner` affects actor `u`.
    pub(crate) fn warhead_relates(&self, wh: &crate::rules::Warhead, owner: u8, u: usize) -> bool {
        let all = crate::rules::RELATION_ALLY | crate::rules::RELATION_NEUTRAL | crate::rules::RELATION_ENEMY;
        wh.relationships & all == all || wh.relationships & self.relation(owner, self.actors[u].owner) != 0
    }

    /// Whether unit `i` heals or repairs friends (Medic, Mechanic).
    pub(crate) fn heals(&self, i: usize) -> bool {
        self.rules.actors[self.actors[i].ty as usize].targets_allies
    }

    /// Whether healer `i` can heal or repair actor `t`: an own or allied unit
    /// its weapons can treat (Armament TargetRelationships Ally).
    pub fn can_heal(&self, i: usize, t: usize) -> bool {
        let (a, ta) = (&self.actors[i], &self.actors[t]);
        i != t
            && self.heals(i)
            && ta.alive
            && ta.in_world()
            && self.are_allies(a.owner, ta.owner)
            && self.rules.actors[a.ty as usize].can_attack_class(&self.rules, self.support_class(t))
            && self.targetable(t, a.owner)
    }

    /// AutoTarget of a healer: the closest own or allied unit in range that
    /// needs it, among its AutoTargetPriority types (the Medic infantry, the
    /// Mechanic vehicles and ships, so no landed aircraft).
    pub(crate) fn scan_for_heal_target(&self, i: usize) -> Option<usize> {
        let a = &self.actors[i];
        let info = &self.rules.actors[a.ty as usize];
        let range = info.weapons.iter().map(|&w| self.rules.weapons[w].range).max().unwrap_or(0);
        if range == 0 {
            return None;
        }
        let r_cells = range / CELL + 2;
        let (cx, cy) = self.cell_of(a.x, a.y);
        let range_sq = range as i64 * range as i64;
        let mut best: Option<(i64, usize)> = None;
        for y in cy - r_cells..=cy + r_cells {
            for x in cx - r_cells..=cx + r_cells {
                if !self.map.contains(x, y) {
                    continue;
                }
                for &u in self.units_in_cell(self.map.idx(x, y)) {
                    let u = u as usize;
                    if self.actors[u].kind == Kind::Aircraft || !self.can_heal(i, u) {
                        continue;
                    }
                    let d = dist_sq(a.x, a.y, self.actors[u].px, self.actors[u].py);
                    if d <= range_sq && best.is_none_or(|(bd, bu)| d < bd || (d == bd && u < bu)) {
                        best = Some((d, u));
                    }
                }
            }
        }
        best.map(|(_, u)| u)
    }

    /// Negative damage (Heal and Repair warheads): health back up to the
    /// maximum, with a white flash (FlashTargetsInRadius). Damage modifiers
    /// (rank, prone) only apply to damage, not to healing.
    pub(crate) fn heal_by(&mut self, u: usize, amount: i32) {
        let max = self.rules.actors[self.actors[u].ty as usize].hp;
        let a = &mut self.actors[u];
        if !a.alive || a.hp >= max || amount <= 0 {
            return;
        }
        a.hp = (a.hp as i64 + amount as i64).min(max as i64) as i32;
        a.flash = 2;
    }

    // ---- Deaths ----------------------------------------------------------------------------

    /// Remember the death sequence a killing hit with damage types `types`
    /// plays on actor `u` (OpenRA WithDeathAnimation: the first DeathTypes
    /// entry the damage has; none for damage without types).
    pub(crate) fn note_death_types(&mut self, u: usize, types: u32) {
        let seq = self.rules.actors[self.actors[u].ty as usize]
            .death
            .as_ref()
            .and_then(|d| d.by_type.iter().find(|(bit, _)| *bit != 0 && types & bit != 0))
            .map_or(0, |&(_, s)| s);
        self.actors[u].inf.death = seq;
    }

    /// A soldier was crushed by a vehicle (WithDeathAnimation CrushedSequence).
    pub(crate) fn note_crushed(&mut self, u: usize) {
        let crushed = self.rules.actors[self.actors[u].ty as usize].death.as_ref().is_some_and(|d| d.crushed);
        self.actors[u].inf.death = if crushed { DEATH_CRUSHED } else { 0 };
    }

    /// Actor `i` died (world.rs kill): infantry with a death sequence leave a
    /// dying body for the renderer (presentation only).
    pub(crate) fn infantry_died(&mut self, i: usize) {
        let a = &self.actors[i];
        if a.kind != Kind::Infantry || a.inf.death == 0 || a.air.parachute {
            return;
        }
        let c = Corpse { x: a.x, y: a.y, facing: a.facing, ty: a.ty, owner: a.owner, sequence: a.inf.death, tick: self.tick };
        self.inf.corpses.push(c);
    }

    // ---- FireDelay -------------------------------------------------------------------------

    /// Fire weapon `w` of `i` at `ft` now, or after the slot's FireDelay
    /// (OpenRA Armament.FireDelay: the projectile leaves later, the reload
    /// starts now).
    pub(crate) fn fire_or_delay(&mut self, i: usize, slot: usize, ft: FireTarget, w: usize) {
        let delay = self.rules.actors[self.actors[i].ty as usize].fire_delays.get(slot).copied().unwrap_or(0);
        if delay <= 0 {
            self.fire_on(i, ft, w);
            return;
        }
        let (target, ground) = match ft {
            FireTarget::Actor(t) => (self.make_ref(t), (0, 0)),
            FireTarget::Ground(x, y) => (NONE, (x, y)),
        };
        let shooter = self.make_ref(i);
        self.inf.shots.push(DelayedShot { tick: self.tick + delay as u32, shooter, target, ground, weapon: w as u16 });
    }

    /// Shots whose FireDelay ran out leave now, if the shooter still lives and
    /// the target actor too (a shot at the ground always goes).
    pub(crate) fn fire_delayed_shots(&mut self) {
        if self.inf.shots.is_empty() {
            return;
        }
        let tick = self.tick;
        let (due, rest): (Vec<DelayedShot>, Vec<DelayedShot>) =
            std::mem::take(&mut self.inf.shots).into_iter().partition(|s| s.tick <= tick);
        self.inf.shots = rest;
        for s in due {
            let Some(i) = self.resolve(s.shooter).filter(|&i| self.actors[i].in_world()) else { continue };
            let ft = if s.target == NONE {
                FireTarget::Ground(s.ground.0, s.ground.1)
            } else {
                match self.resolve(s.target).filter(|&t| self.actors[t].in_world()) {
                    Some(t) => FireTarget::Actor(t),
                    None => continue,
                }
            };
            self.fire_on(i, ft, s.weapon as usize);
        }
    }
}

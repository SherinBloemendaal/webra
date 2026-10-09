//! The attack dog (OpenRA.Mods.Cnc AttackLeap, LeapAttack, Leap and
//! EdibleByLeap): it runs at its prey (GrantConditionWhileAiming `run` with a
//! SpeedMultiplier), leaps from weapon range onto it and bites, then stands
//! still while it eats (GrantConditionOnAttack `eating`) and reloads (Mobile
//! PauseOnCondition attack-cooldown || eating). Only one dog leaps at a
//! soldier at a time.

use crate::combat::FireTarget;
use crate::infantry::Leap;
use crate::math::{dist, facing_of};
use crate::world::{Activity, World, NONE};

impl World {
    /// Whether unit `i` attacks by leaping (AttackLeap).
    pub(crate) fn leaps(&self, i: usize) -> bool {
        self.rules.actors[self.actors[i].ty as usize].abilities.attack_leap.is_some()
    }

    /// Movement speed with the dog's run (`run` while it hunts a target), percent applied.
    pub(crate) fn infantry_speed(&self, i: usize, speed: i32) -> i32 {
        let a = &self.actors[i];
        match &self.rules.actors[a.ty as usize].abilities.attack_leap {
            Some(l) if a.activity == Activity::Attack && a.target != NONE => speed * l.run_speed / 100,
            _ => speed,
        }
    }

    /// Mobile.PauseOnCondition of the dog: it stays put while it eats or reloads.
    pub(crate) fn movement_paused(&self, i: usize) -> bool {
        let a = &self.actors[i];
        a.inf.eat > 0 || (self.leaps(i) && a.reload.iter().any(|&r| r > 0))
    }

    /// The dog is in weapon range of `t` (LeapAttack.Tick): leap when the
    /// target can be leapt at and the jaw is loaded.
    pub(crate) fn leap_attack(&mut self, i: usize, t: usize) {
        let Some(leap) = self.rules.actors[self.actors[i].ty as usize].abilities.attack_leap.clone() else { return };
        // EdibleByLeap.CanLeap: no other live dog is on its way.
        let me = self.make_ref(i);
        if self.resolve(self.actors[t].inf.leaper).is_some_and(|d| d != i && self.actors[d].inf.leap.is_some()) {
            return;
        }
        // Can't leap yet: every armament reloads (LeapAttack), or the dog still eats.
        let slots = self.rules.actors[self.actors[i].ty as usize].weapons.len().min(crate::world::MAX_WEAPONS);
        if self.actors[i].reload[..slots].iter().all(|&r| r > 0) || self.actors[i].inf.eat > 0 {
            return;
        }
        let (ox, oy) = (self.actors[i].x, self.actors[i].y);
        let (tx, ty) = self.tick_start_pos(t);
        if let Some(f) = facing_of(tx - ox, ty - oy) {
            self.actors[i].facing = f;
        }
        let length = (dist(ox, oy, tx, ty) / leap.speed.max(1)).max(1);
        self.actors[t].inf.leaper = me;
        let target = self.make_ref(t);
        self.actors[i].inf.leap = Some(Leap { target, ox, oy, tx, ty, ticks: 0, length });
    }

    /// A dog in the air (OpenRA Leap.Tick): it flies from where it jumped to
    /// its target's current position and bites on landing. Returns true while
    /// it leaps (nothing else happens to it then).
    pub(crate) fn tick_leap(&mut self, i: usize) -> bool {
        let Some(mut l) = self.actors[i].inf.leap else { return false };
        let target = self.resolve(l.target).filter(|&t| self.actors[t].in_world());
        // Follow the prey; when it vanished, land where it was last.
        if let Some(t) = target {
            (l.tx, l.ty) = (self.actors[t].x, self.actors[t].y);
        }
        let (tx, ty) = (l.tx, l.ty);
        let (x, y) = if l.length > 1 {
            let k = l.ticks.min(l.length - 1) as i64;
            let n = (l.length - 1) as i64;
            (l.ox + ((tx - l.ox) as i64 * k / n) as i32, l.oy + ((ty - l.oy) as i64 * k / n) as i32)
        } else {
            (tx, ty)
        };
        let a = &mut self.actors[i];
        a.x = x;
        a.y = y;
        a.moved = true;
        l.ticks += 1;
        if l.ticks < l.length {
            a.inf.leap = Some(l);
            return true;
        }
        a.inf.leap = None;
        // Landed: bite (AttackLeap.DoAttack) and eat (GrantConditionOnAttack RevokeDelay).
        if let Some(t) = target {
            let eat = self.rules.actors[self.actors[i].ty as usize].abilities.attack_leap.as_ref().map_or(0, |l| l.eat_ticks);
            let weapons = self.rules.actors[self.actors[i].ty as usize].weapons.clone();
            let tclass = self.target_class(t);
            for (slot, &w) in weapons.iter().enumerate().take(crate::world::MAX_WEAPONS) {
                if self.actors[i].reload[slot] > 0 || !self.rules.weapons[w].can_target_class(tclass) {
                    continue;
                }
                self.fire_on(i, FireTarget::Actor(t), w);
                self.on_fire(i);
                let reload = self.modified_reload(i, self.rules.weapons[w].reload);
                let a = &mut self.actors[i];
                a.reload[slot] = reload;
                a.inf.eat = a.inf.eat.max(eat);
                break;
            }
        }
        true
    }
}

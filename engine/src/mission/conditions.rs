//! External conditions scripts grant (OpenRA ExternalCondition with
//! `actor.GrantCondition`, `player.GrantCondition`). The engine has no
//! general condition system: tools/gen_missions.py lists, per actor type,
//! the conditions it accepts and what the traits requiring them switch
//! (targetable, extra sight, demolishable, invulnerable, kills itself, crew
//! on sale), and those are applied here and by small checks in the engine.
//! Player conditions switch the campaign bot's modules on (soviet-05's base
//! builder runs the skirmish AI; a repair module repairs structures).

use super::api::{err, Ctx, R};
use super::*;

impl Ctx<'_> {
    /// `actor.GrantCondition(name, duration)`: a revocation token.
    pub(crate) fn grant_actor_condition(&mut self, h: u32, c: &str, duration: i32) -> R<i32> {
        if !self.external_conditions(h).iter().any(|x| x == c) {
            return err(format!("Condition `{c}` has not been listed on an enabled ExternalCondition trait"));
        }
        let token = self.m.next_token;
        self.m.next_token += 1;
        let end = if duration > 0 { self.w.tick + duration as u32 } else { 0 };
        self.m.conditions.entry(h).or_default().push((token, c.to_string(), end));
        self.apply_conditions(h);
        Ok(token)
    }

    pub(crate) fn revoke_actor_condition(&mut self, h: u32, token: i32) {
        if let Some(list) = self.m.conditions.get_mut(&h) {
            list.retain(|(t, _, _)| *t != token);
        }
        self.apply_conditions(h);
    }

    /// Effects that act at once (invulnerability, KillsSelf); the others are
    /// read by the engine checks while the condition holds.
    pub(crate) fn apply_conditions(&mut self, h: u32) {
        let Some(i) = self.engine_actor(h) else { return };
        let ty = self.m.handles[h as usize].ty.clone();
        let Some(info) = self.m.data.conditions.get(&ty).cloned() else { return };
        let active: Vec<String> = self.m.conditions.get(&h).map(|l| l.iter().map(|(_, c, _)| c.clone()).collect()).unwrap_or_default();
        let holds = |when: &str| match when.strip_prefix('!') {
            Some(c) => !active.iter().any(|a| a == c),
            None => active.iter().any(|a| a == when),
        };
        // Any DamageMultiplier 0 whose condition holds makes it invulnerable
        // (without touching an Iron Curtain's own timer otherwise).
        let invulnerable: Vec<bool> = info.effects.iter().filter(|e| e.effect == "invulnerable").map(|e| holds(&e.when)).collect();
        if !invulnerable.is_empty() {
            let a = &mut self.w.actors[i];
            if invulnerable.iter().any(|&on| on) {
                a.invulnerable_until = u32::MAX;
            } else if a.invulnerable_until == u32::MAX {
                a.invulnerable_until = self.w.tick;
            }
        }
        if info.effects.iter().any(|e| e.effect == "kills_self" && holds(&e.when)) {
            self.w.kill(i);
        }
    }

    /// Conditions granted for a while run out (ExternalCondition duration).
    pub(crate) fn tick_conditions(&mut self) {
        let tick = self.w.tick;
        let expired: Vec<u32> =
            self.m.conditions.iter().filter(|(_, l)| l.iter().any(|&(_, _, end)| end != 0 && end <= tick)).map(|(&h, _)| h).collect();
        for h in expired {
            if let Some(l) = self.m.conditions.get_mut(&h) {
                l.retain(|&(_, _, end)| end == 0 || end > tick);
            }
            self.apply_conditions(h);
        }
    }

    /// `player.GrantCondition(name)`: bot modules for the player.
    pub(crate) fn grant_player_condition(&mut self, p: u8, c: &str) -> R<i32> {
        if !self.m.data.bot_conditions.contains_key(c) {
            return err(format!("Condition `{c}` has not been listed on an enabled ExternalCondition trait"));
        }
        let token = self.m.next_token;
        self.m.next_token += 1;
        self.m.players[p as usize].conditions.push((token, c.to_string()));
        self.update_bots(p);
        Ok(token)
    }

    pub(crate) fn revoke_player_condition(&mut self, p: u8, token: i32) {
        self.m.players[p as usize].conditions.retain(|(t, _)| *t != token);
        self.update_bots(p);
    }

    fn update_bots(&mut self, p: u8) {
        let modules = self.bot_modules(p);
        // A base builder means OpenRA's whole skirmish bot plays this player.
        self.m.players[p as usize].ai_enabled = modules.iter().any(|m| m == "BaseBuilderBotModule");
    }
}

impl World {
    /// Whether a mission condition makes actor `i` impossible to target
    /// (a Targetable trait that needs a condition it lacks, or is off while one holds).
    pub(crate) fn mission_untargetable(&self, i: usize) -> bool {
        self.mission_indestructible(i) || self.condition_effect(i, "targetable").is_some_and(|holds| !holds)
    }

    /// Whether units leave actor `i` alone unless ordered to attack it (NoAutoTarget, mission conditions).
    pub(crate) fn mission_no_auto_target(&self, i: usize) -> bool {
        self.mission_untargetable(i)
            || self.mission.as_ref().is_some_and(|m| m.data.no_auto_target.contains(&self.rules.actors[self.actors[i].ty as usize].id))
    }

    /// Mission actor types without health (`MissionData::indestructible`).
    pub(crate) fn mission_indestructible(&self, i: usize) -> bool {
        self.mission.as_ref().is_some_and(|m| m.data.indestructible.contains(&self.rules.actors[self.actors[i].ty as usize].id))
    }

    /// Whether a mission condition switches actor `i`'s Demolishable off.
    pub(crate) fn mission_undemolishable(&self, i: usize) -> bool {
        self.condition_effect(i, "demolishable").is_some_and(|holds| !holds)
    }

    /// Whether a mission condition switches actor `i`'s SpawnActorsOnSell off.
    pub(crate) fn mission_no_sell_survivors(&self, i: usize) -> bool {
        self.condition_effect(i, "sell_survivors").is_some_and(|holds| !holds)
    }

    /// For an actor whose type has `effect`: whether its trait is enabled now.
    fn condition_effect(&self, i: usize, effect: &str) -> Option<bool> {
        let m = self.mission.as_ref()?;
        let ty = &self.rules.actors[self.actors[i].ty as usize].id;
        let info = m.data.conditions.get(ty)?;
        let e = info.effects.iter().find(|e| e.effect == effect)?;
        let r = self.make_ref(i);
        let h = m.handle_of.get(&r);
        let active = |c: &str| h.and_then(|h| m.conditions.get(h)).is_some_and(|l| l.iter().any(|(_, x, _)| x == c));
        Some(match e.when.strip_prefix('!') {
            Some(c) => !active(c),
            None => active(&e.when),
        })
    }

    /// Extra sight that conditions give (RevealsShroud requiring a condition) and
    /// the mission's cameras and flares: applied after the actors' own vision.
    pub(crate) fn apply_mission_reveals(&mut self) {
        let Some(m) = self.mission.as_ref() else { return };
        let mut reveals: Vec<(u8, i32, i32, i32)> = Vec::new();
        for hd in &m.handles {
            if let HState::Prop { x, y, reveal, alive: true, .. } = hd.state {
                if reveal > 0 {
                    reveals.push((hd.owner, x, y, reveal));
                }
            }
        }
        for (&h, list) in &m.conditions {
            let Some(hd) = m.handles.get(h as usize) else { continue };
            let HState::Live(r) = hd.state else { continue };
            let Some(i) = self.resolve(r) else { continue };
            let Some(info) = m.data.conditions.get(&hd.ty) else { continue };
            for e in info.effects.iter().filter(|e| e.effect == "reveal" && e.value > 0) {
                let holds = match e.when.strip_prefix('!') {
                    Some(c) => !list.iter().any(|(_, x, _)| x == c),
                    None => list.iter().any(|(_, x, _)| *x == e.when),
                };
                if holds && self.actors[i].in_world() {
                    reveals.push((self.actors[i].owner, self.actors[i].x, self.actors[i].y, e.value));
                }
            }
        }
        for (p, x, y, r) in reveals {
            self.reveal_circle(p, x, y, r);
        }
    }
}

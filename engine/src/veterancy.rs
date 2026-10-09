//! Veterancy and prone infantry, as in OpenRA's Red Alert rules.
//!
//! # Veterancy (`GainsExperience`, `GivesExperience`)
//!
//! An actor that kills an enemy (or neutral) actor gains that actor's value:
//! `GivesExperience.Experience` (-1: its cost) times `ActorExperienceModifier`
//! percent (OpenRA default 10000), so experience is counted in percent of a
//! value. Levels come at the `GainsExperience.Conditions` thresholds, which
//! are multiples of the gaining actor's own value: RA's 200, 400, 800 and 1600
//! mean twice, four, eight and sixteen times its cost in kills. Level 4 is
//! elite. Experience only comes from kills (OpenRA has no experience for
//! damage dealt); crushing infantry counts as a kill by the crusher, and a
//! unit inside a transport gains nothing (`GainsExperienceMultiplier` 0 with
//! the `disable-experience` cargo condition). Allies give no experience.
//!
//! Each level switches on RA's rank bonuses (rules.json `experience`, read
//! from the catalog by tools/gen_rules.py): firepower 105/110/120/130 %,
//! damage taken 95/90/85/75 %, speed 105/110/120/140 %, reload delay
//! 95/90/85/75 %, and at elite `ChangesHealth@ELITE`: 5 % of the maximum
//! health every 100 ticks while damaged, unless hit in the last 125 ticks.
//! Firepower is captured when a shot is fired ([`Shot`]), so a shell in the
//! air keeps its shooter's bonus and credits the kill to it.
//!
//! # Prone infantry (`TakeCover`)
//!
//! A hit by a warhead with a `TriggerProne` damage type throws a soldier to
//! the ground for `Duration` ticks (RA: 50) after the last such hit. While
//! prone, damage of the `Prone50Percent` type is halved (the modifier only
//! applies to hits that land while already prone, as in OpenRA) and the
//! soldier moves at `SpeedModifier` (OpenRA default 50) percent. The renderer
//! draws the prone pose in the sprite slot a turret would use.
//!
//! OpenRA's negative `Duration` (prone for good) is not supported: rules
//! validation requires at least one tick.
//!
//! All math is integer and applies modifiers one after another, truncating
//! after each (OpenRA multiplies them in decimal and truncates once, so a
//! result can be a hit point apart).

use crate::rules::{ExperienceInfo, Kind};
use crate::world::{World, NONE};

/// Who fired a shot and with what firepower (percent). Projectiles, delayed
/// warheads and falling bombs carry it until they land.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Shot {
    /// Actor reference of the shooter (`World::make_ref`), or NONE.
    pub source: u32,
    pub firepower: i32,
}

impl Shot {
    /// No shooter to credit, plain damage (death explosions of the map, crashes, superweapons).
    pub const NONE: Shot = Shot { source: NONE, firepower: 100 };
}

/// Rank decoration sprites, `SpriteIds::veterancy_base + index`
/// (VETERANCY_SPECIALS in apps/game/js/art/veterancy.js).
const DECORATION_CHEVRONS: f32 = 0.0; // 1, 2 and 3 chevrons at 0, 1, 2
const DECORATION_ELITE: f32 = 3.0;

fn apply_percent(v: i64, percent: i32) -> i64 {
    v * percent as i64 / 100
}

impl World {
    fn experience_info(&self, i: usize) -> Option<&ExperienceInfo> {
        self.rules.actors[self.actors[i].ty as usize].experience.as_ref()
    }

    /// The level modifier `pick` of actor `i` at its current rank (100 for rookies).
    fn rank_modifier(&self, i: usize, pick: fn(&ExperienceInfo) -> &Vec<i32>) -> i32 {
        let rank = self.actors[i].rank as usize;
        if rank == 0 {
            return 100;
        }
        self.experience_info(i).and_then(|x| pick(x).get(rank - 1).copied()).unwrap_or(100)
    }

    /// Veterancy level of actor `i` (0 rookie).
    pub fn rank(&self, i: usize) -> u8 {
        self.actors[i].rank
    }

    /// Number of veterancy levels actor `i` can reach (0: it gains no experience).
    pub fn max_rank(&self, i: usize) -> u8 {
        self.experience_info(i).map_or(0, |x| x.thresholds.len() as u8)
    }

    /// Experience actor `i` needs for `level` (1-based): the threshold times its value.
    pub fn level_experience(&self, i: usize, level: usize) -> i64 {
        let cost = self.rules.actors[self.actors[i].ty as usize].cost as i64;
        self.experience_info(i).and_then(|x| x.thresholds.get(level.wrapping_sub(1))).map_or(0, |&t| t as i64 * cost)
    }

    /// Firepower of actor `i`, percent (FirepowerMultiplier of its rank).
    pub fn firepower_modifier(&self, i: usize) -> i32 {
        self.rank_modifier(i, |x| &x.firepower)
    }

    /// The shot actor `i` fires now: itself as the source, its current firepower.
    pub(crate) fn shot_of(&self, i: usize) -> Shot {
        Shot { source: self.make_ref(i), firepower: self.firepower_modifier(i) }
    }

    /// Reload delay of actor `i` for a weapon with delay `base` (ReloadDelayMultiplier).
    pub(crate) fn modified_reload(&self, i: usize, base: i32) -> i32 {
        (apply_percent(base as i64, self.rank_modifier(i, |x| &x.reload)) as i32).max(1)
    }

    /// Movement speed of actor `i` for a base speed (rank SpeedMultiplier, then prone).
    pub(crate) fn modified_speed(&self, i: usize, base: i32) -> i32 {
        let mut v = apply_percent(base as i64, self.rank_modifier(i, |x| &x.speed));
        if self.is_prone(i) {
            if let Some(tc) = &self.rules.actors[self.actors[i].ty as usize].take_cover {
                v = apply_percent(v, tc.speed_modifier);
            }
        }
        v as i32
    }

    /// Damage actor `u` takes from a hit of `dmg` with damage type bits `types`:
    /// its rank's DamageMultiplier, then TakeCover's modifiers while prone.
    pub(crate) fn modified_damage(&self, u: usize, dmg: i32, types: u32) -> i32 {
        let mut v = apply_percent(dmg as i64, self.rank_modifier(u, |x| &x.damage));
        if self.is_prone(u) {
            if let Some(tc) = &self.rules.actors[self.actors[u].ty as usize].take_cover {
                for &(bit, percent) in &tc.modifiers {
                    if types & bit != 0 {
                        v = apply_percent(v, percent);
                    }
                }
            }
        }
        v as i32
    }

    /// Whether infantry actor `i` lies prone (TakeCover).
    pub fn is_prone(&self, i: usize) -> bool {
        self.actors[i].prone_ticks > 0
    }

    /// TakeCover: a damaging hit with a trigger damage type throws the soldier
    /// down, or keeps it down for another full duration.
    pub(crate) fn take_cover(&mut self, u: usize, types: u32) {
        let Some(tc) = &self.rules.actors[self.actors[u].ty as usize].take_cover else { return };
        if types & tc.triggers != 0 {
            self.actors[u].prone_ticks = tc.duration;
        }
    }

    // ---- Experience ------------------------------------------------------------

    /// OpenRA GainsExperience.GiveExperience: add `amount`, capped at the last
    /// level's requirement, and rise through every level reached.
    pub(crate) fn give_experience(&mut self, i: usize, amount: i64) {
        let levels = self.max_rank(i) as usize;
        if levels == 0 || amount < 0 {
            return;
        }
        let cap = self.level_experience(i, levels);
        let before = (self.actors[i].xp, self.actors[i].rank);
        let xp = self.actors[i].xp.saturating_add(amount).clamp(0, cap);
        self.actors[i].xp = xp;
        while (self.actors[i].rank as usize) < levels && xp >= self.level_experience(i, self.actors[i].rank as usize + 1) {
            self.actors[i].rank += 1;
            // GainsExperience LevelUpNotification, per level, to the owner.
            let a = &self.actors[i];
            let (ty, x, y, owner) = (a.ty as i32, a.x, a.y, a.owner);
            self.sound.push(crate::sound_events::SoundEventKind::LevelUp, ty, x, y, owner, 0);
        }
        // Observer stats (observer.rs).
        let ranks = u32::from(self.actors[i].rank.saturating_sub(before.1));
        self.note_experience(i, xp - before.0, ranks);
    }

    /// OpenRA GainsExperience.GiveLevels: just enough experience for `n` more levels.
    pub(crate) fn give_levels(&mut self, i: usize, n: usize) {
        let levels = self.max_rank(i) as usize;
        let target = (self.actors[i].rank as usize + n).min(levels);
        if target == 0 {
            return;
        }
        let missing = self.level_experience(i, target) - self.actors[i].xp;
        self.give_experience(i, missing.max(0));
    }

    /// OpenRA GivesExperience.Killed: the actor behind `source` killed `victim`.
    /// Allies (and the victim itself) give nothing; passengers gain nothing.
    pub(crate) fn award_kill(&mut self, victim: usize, source: u32) {
        let Some(killer) = self.resolve(source) else { return };
        if killer == victim || !self.actors[killer].in_world() || self.are_allies(self.actors[killer].owner, self.actors[victim].owner) {
            return;
        }
        let info = &self.rules.actors[self.actors[victim].ty as usize];
        let Some(g) = &info.gives_experience else { return };
        let value = if g.experience >= 0 { g.experience } else { info.cost };
        let amount = value as i64 * g.actor_modifier as i64 / 100;
        self.give_experience(killer, amount);
    }

    // ---- Per tick ------------------------------------------------------------------

    /// Prone countdown and elite self repair of actor `i`.
    pub(crate) fn tick_veterancy(&mut self, i: usize) {
        if self.actors[i].prone_ticks > 0 {
            self.actors[i].prone_ticks -= 1;
        }
        let ty = self.actors[i].ty as usize;
        let Some(h) = self.rules.actors[ty].experience.as_ref().and_then(|x| x.heal.clone()) else { return };
        let max = self.rules.actors[ty].hp;
        let tick = self.tick;
        let a = &mut self.actors[i];
        // Same timing as the other ChangesHealth (combat.rs tick_self_heal).
        if (a.rank as i32) < h.rank
            || a.hp as i64 * 100 >= max as i64 * h.start_if_below as i64
            || tick < a.last_damaged.saturating_add(h.damage_cooldown as u32)
        {
            a.rank_heal_timer = 0;
            return;
        }
        a.rank_heal_timer += 1;
        if a.rank_heal_timer >= h.delay {
            a.rank_heal_timer = 0;
            let heal = h.step as i64 + max as i64 * h.percentage_step as i64 / 100;
            a.hp = (a.hp as i64 + heal).min(max as i64) as i32;
        }
    }

    // ---- Debug menu -------------------------------------------------------------------

    /// Apply a `dev_experience` order: one more level for each of the player's
    /// own listed units. Ignored unless cheats are enabled.
    pub(crate) fn dev_give_experience(&mut self, player: u8, ids: &[u32]) {
        if !self.options.cheats || player as usize >= self.players.len() || self.players[player as usize].neutral {
            return;
        }
        let mut targets: Vec<usize> = ids.iter().filter_map(|&r| self.resolve(r)).filter(|&i| self.actors[i].owner == player).collect();
        targets.sort_unstable();
        targets.dedup();
        for i in targets {
            self.give_levels(i, 1);
        }
    }

    // ---- Rendering ----------------------------------------------------------------------

    /// Rank decorations (chevrons, elite star) at the bottom right of every
    /// ranked unit `player` can see, like OpenRA's WithDecoration@RANK-*
    /// (shown for allies, enemies and neutrals alike).
    pub(crate) fn render_veterancy(&self, player: u8, sink: &mut crate::instances::Sink, base: f32, sprites: &mut Vec<f32>) {
        use crate::overlays::chevron_position;
        for (i, a) in self.actors.iter().enumerate() {
            if !a.alive || a.rank == 0 || !a.is_unit() || !a.in_world() || a.air.parachute {
                continue;
            }
            if a.owner != player && (!self.is_visible_to(i, player) || self.is_cloaked_from(i, player)) {
                continue;
            }
            let (anchor, w, h) = self.selection_anchor(i);
            if !sink.visible(anchor.from, anchor.to, 32.0) {
                continue;
            }
            let sprite =
                if a.rank >= self.max_rank(i) { base + DECORATION_ELITE } else { base + DECORATION_CHEVRONS + (a.rank.min(3) - 1) as f32 };
            // Just right of the health bar over the selection bracket (overlays.rs).
            let (dx, dy) = chevron_position(0.0, 0.0, w, h);
            let r = crate::instances::SpriteRec::moving(anchor.from, anchor.to, 32.0).look(sprite, a.owner as f32, 1.0, 1.0, 0.0);
            sink.sprite(sprites, r.offset(dx, dy));
        }
    }

    /// Whether actor `i` is drawn in its prone pose (infantry only).
    pub(crate) fn draws_prone(&self, i: usize) -> bool {
        self.actors[i].kind == Kind::Infantry && self.is_prone(i)
    }
}

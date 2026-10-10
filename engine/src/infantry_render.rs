//! Drawing the Red Alert infantry extras: dying soldiers (WithDeathAnimation
//! die1..die6 and the crushed body), the stand variants and idle animations
//! of standing soldiers (WithInfantryBody StandSequences and IdleSequences),
//! the spy's tag (WithDecoration@disguise), the fake tag of infiltrated fakes
//! (InfiltrateForDecoration), capture progress (CapturableProgressBar), the
//! power outage bar (AffectedByPowerOutage) and the Sonar Pulse ring.
//! Presentation only: it reads the world and never writes it.

use crate::infantry::{InfantryFxKind, CRUSHED_TICKS, DEATH_CRUSHED, DEATH_TICKS};
use crate::instances::{Sink, SpriteRec, NO_CULL};
use crate::render::{posed, push_fixed_rect, px, Pose, SpriteIds};
use crate::rules::Kind;
use crate::world::World;

/// Special sprites of apps/game/js/art/infantry.js, from `SpriteIds::infantry_base`.
pub const SPRITE_DIE_FALL: f32 = 0.0;
pub const SPRITE_DIE_BLOWN: f32 = 1.0;
pub const SPRITE_DIE_BURNED: f32 = 2.0;
pub const SPRITE_DIE_ZAPPED: f32 = 3.0;
pub const SPRITE_DIE_CRUSHED: f32 = 4.0;
pub const SPRITE_SPY_TAG: f32 = 5.0;
pub const SPRITE_FAKE_TAG: f32 = 6.0;
pub const SPRITE_SONAR: f32 = 7.0;

/// OpenRA WithInfantryBody MinIdleDelay and MaxIdleDelay: ticks between idle animations.
const MIN_IDLE_DELAY: u32 = 30;
const MAX_IDLE_DELAY: u32 = 110;
/// Ticks an idle animation runs at least (idle1 and idle2: 16 frames at 120 ms);
/// original art with a longer one gets its own length (`RenderOptions::infantry_ticks`).
const IDLE_ANIMATION_TICKS: u32 = 48;

/// The built-in sprite of a death sequence (die1/die2 fall, die3/die4 blast,
/// die5 fire, die6 electricity, crushed).
fn death_sprite(sequence: u8) -> f32 {
    match sequence {
        1 | 2 => SPRITE_DIE_FALL,
        3 | 4 => SPRITE_DIE_BLOWN,
        5 => SPRITE_DIE_BURNED,
        6 => SPRITE_DIE_ZAPPED,
        _ => SPRITE_DIE_CRUSHED,
    }
}

/// A fixed, well mixed number per actor slot and generation: which stand
/// variant a soldier uses and when it plays an idle animation. OpenRA picks
/// them with the cosmetic random; any spread works, as long as neighbours differ.
fn idle_hash(i: usize, gen: u32) -> u32 {
    // MurmurHash3's finalizer over the slot and generation.
    let mut h = (i as u32) ^ gen.rotate_left(16);
    h ^= h >> 16;
    h = h.wrapping_mul(0x85EB_CA6B);
    h ^= h >> 13;
    h = h.wrapping_mul(0xC2B2_AE35);
    h ^ (h >> 16)
}

impl World {
    /// The pose of a standing soldier: `stand` or `stand2` (StandSequences),
    /// now and then an idle animation (IdleSequences idle1 or idle2) played
    /// once from its age, every MinIdleDelay to MaxIdleDelay ticks.
    pub(crate) fn infantry_stand_pose(&self, i: usize) -> (Pose, u32) {
        let a = &self.actors[i];
        let h = idle_hash(i, a.gen);
        let stand = if h & 1 == 0 { Pose::Idle } else { Pose::Stand2 };
        let delay = MIN_IDLE_DELAY + (h >> 8) % (MAX_IDLE_DELAY - MIN_IDLE_DELAY + 1);
        // The whole idle animation of the art (set_death_art), at least the built-in window.
        let art = &self.render_opts;
        let anim = if art.death_art.get(a.ty as usize).copied().unwrap_or(false) {
            art.infantry_ticks.get(a.ty as usize).map_or(0, |t| t[7]).max(IDLE_ANIMATION_TICKS)
        } else {
            IDLE_ANIMATION_TICKS
        };
        let phase = (self.tick.wrapping_add(h >> 3)) % (delay + anim);
        if phase < delay {
            return (stand, 0);
        }
        (if (h >> 4) & 1 == 0 { Pose::Idle1 } else { Pose::Idle2 }, phase - delay)
    }

    /// The attack sequence of a firing soldier: `attack` or `attack2`, picked
    /// per shot (OpenRA WithInfantryBody takes a random one of the armament's
    /// AttackSequences each time it attacks). Art with one attack sequence
    /// shows it for both.
    pub(crate) fn infantry_attack_pose(&self, i: usize) -> Pose {
        if idle_hash(i, self.actors[i].fx.fired) & 1 == 0 {
            Pose::Attack
        } else {
            Pose::Attack2
        }
    }

    /// Dying soldiers `player` can see: the death sequence of their art when
    /// it has one (`RenderOptions::death_art`, original graphics), else the
    /// built-in body that fades out.
    pub(crate) fn render_corpses(&self, player: u8, sink: &mut Sink, ids: &SpriteIds, sprites: &mut Vec<f32>) {
        for c in &self.inf.corpses {
            let (x, y) = (px(c.x), px(c.y));
            if !self.render_sees_cell(player, self.cell_index(c.x, c.y)) || !sink.visible([x, y], [x, y], 24.0) {
                continue;
            }
            let age = self.tick.saturating_sub(c.tick);
            let at = SpriteRec::at(x, y, 24.0).facing(c.facing, 0);
            if self.render_opts.poses && self.render_opts.death_art.get(c.ty as usize).copied().unwrap_or(false) {
                sink.sprite(sprites, at.look(posed(c.ty as u32 * 2, Pose::death(c.sequence), age), c.owner as f32, 1.0, 1.0, 0.0));
                continue;
            }
            let life = if c.sequence == DEATH_CRUSHED { CRUSHED_TICKS } else { DEATH_TICKS } as f32;
            // Full strength for the first half of its life, then fading; at the
            // previous (alpha 0) and the current tick (alpha 1), affine in between.
            let fade = |t: f32| (2.0 * (1.0 - t / life)).clamp(0.0, 1.0);
            let (a0, a1) = (fade(age.saturating_sub(1) as f32), fade(age as f32));
            let sprite = ids.infantry_base + death_sprite(c.sequence);
            sink.sprite(sprites, at.look(sprite, c.owner as f32, 1.0, a0, 0.0).fade_to(1.0, a1));
        }
    }

    /// Spy and fake tags, capture and outage bars, sonar rings.
    pub(crate) fn render_infantry(
        &self,
        player: u8,
        sink: &mut Sink,
        ids: &SpriteIds,
        selected: &[u32],
        sprites: &mut Vec<f32>,
        rects: &mut Vec<f32>,
    ) {
        // The spy tag over disguised spies, for their owner and allies.
        for (i, a) in self.actors.iter().enumerate() {
            if !a.alive || a.inf.disguise.is_none() || !a.in_world() || !self.render_allied(a.owner, player) {
                continue;
            }
            let (anchor, _, h) = self.selection_anchor(i);
            if sink.visible(anchor.from, anchor.to, 32.0) {
                let r =
                    SpriteRec::moving(anchor.from, anchor.to, 32.0).look(ids.infantry_base + SPRITE_SPY_TAG, a.owner as f32, 1.0, 1.0, 0.0);
                sink.sprite(sprites, r.offset(0.0, -h / 2.0 - 6.0));
            }
        }
        // Capture progress over the structures being taken over (seen ones only).
        for &(t, _, progress, total) in &self.inf.captures {
            let Some(b) = self.resolve(t) else { continue };
            if total <= 0 || !self.is_visible_to(b, player) {
                continue;
            }
            let (anchor, w, h) = self.selection_anchor(b);
            let (x, y) = (anchor.to[0] - w / 2.0, anchor.to[1] - h / 2.0 - 4.0);
            let f = progress as f32 / total as f32;
            push_fixed_rect(sink, rects, &[x, y, w, 2.0, 0.0, 0.0, 0.0, 0.7]);
            push_fixed_rect(sink, rects, &[x, y, w * f, 2.0, 1.0, 0.65, 0.0, 1.0]);
        }
        for &r in selected {
            let Some(i) = self.resolve(r) else { continue };
            let a = &self.actors[i];
            if a.kind != Kind::Building || !(a.owner == player || self.is_visible_to(i, player)) {
                continue;
            }
            let (anchor, w, h) = self.selection_anchor(i);
            // InfiltrateForDecoration: the fake tag for the spy's owner and allies.
            let infiltrated =
                (0..self.players.len().min(32)).any(|p| a.inf.infiltrated_by & (1 << p) != 0 && self.render_allied(p as u8, player));
            if infiltrated {
                let r = SpriteRec::at(anchor.to[0], anchor.to[1], NO_CULL).look(ids.infantry_base + SPRITE_FAKE_TAG, 0.0, 1.0, 1.0, 0.0);
                sink.sprite(sprites, r.offset(0.0, -h / 2.0 + 4.0));
            }
            // AffectedByPowerOutage: a yellow bar of the outage left.
            if self.outage_disabled(i) {
                let (left, total) = self.inf.outage[a.owner as usize];
                let (x, y) = (anchor.to[0] - w / 2.0, anchor.to[1] + h / 2.0 + 4.0);
                push_fixed_rect(sink, rects, &[x, y, w, 2.0, 0.0, 0.0, 0.0, 0.7]);
                push_fixed_rect(sink, rects, &[x, y, w * left as f32 / total.max(1) as f32, 2.0, 1.0, 0.9, 0.1, 1.0]);
            }
        }
        // Sonar Pulse rings for the player who fired it and allies.
        for f in &self.inf.fx {
            if f.kind != InfantryFxKind::Sonar || !self.render_allied(f.owner, player) {
                continue;
            }
            let (x, y) = (px(f.x), px(f.y));
            if !sink.visible([x, y], [x, y], 96.0) {
                continue;
            }
            let t = |ttl: i32| 1.0 - ttl as f32 / f.max as f32;
            let (t0, t1) = (t(f.ttl + 1), t(f.ttl));
            let r = SpriteRec::at(x, y, 96.0).look(ids.infantry_base + SPRITE_SONAR, f.owner as f32, 0.5 + t0 * 2.5, 1.0 - t0, 0.0);
            sink.sprite(sprites, r.fade_to(0.5 + t1 * 2.5, 1.0 - t1));
        }
    }
}

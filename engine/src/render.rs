//! Builds flat instance arrays for the WebGPU renderer.
//!
//! Sprites: 8 floats each `[x, y, angle, sprite, team, scale, alpha, flash]`,
//! positions in world pixels (24 px per cell, like the original game).
//! Rects:   8 floats each `[x, y, w, h, r, g, b, a]` for selection boxes and health bars.

use crate::math::{angle_diff, CELL};
use crate::rules::Kind;
use crate::world::{Activity, EffectKind, World};

pub const PX_PER_CELL: f32 = 24.0;
pub const SPRITE_FLOATS: usize = 8;
pub const RECT_FLOATS: usize = 8;

#[inline]
pub fn px(wu: i32) -> f32 {
    wu as f32 * PX_PER_CELL / CELL as f32
}

/// Sprite ids: actor `t` has body `2t` and turret `2t + 1`; specials follow.
/// Must match the SPECIALS order in apps/game/js/sprites.js.
pub struct SpriteIds {
    pub bullet: f32,
    pub small_explosion: f32,
    pub large_explosion: f32,
    pub piff: f32,
    pub rally: f32,
    pub at_mine: f32,
    pub ap_mine: f32,
    /// Drawn pointing east (screen +x).
    pub tesla_bolt: f32,
    /// Drawn pointing east (screen +x).
    pub missile: f32,
    pub shell: f32,
    pub chrono: f32,
    pub nuke: f32,
    /// First of 8 reserved special slots per art module (apps/game/js/art/*.js).
    pub naval_base: f32,
    pub planes_base: f32,
    pub helis_base: f32,
    pub abilities_base: f32,
}

impl SpriteIds {
    pub fn new(actor_count: usize) -> SpriteIds {
        let b = (actor_count * 2) as f32;
        SpriteIds {
            bullet: b,
            small_explosion: b + 1.0,
            large_explosion: b + 2.0,
            piff: b + 3.0,
            rally: b + 4.0,
            at_mine: b + 5.0,
            ap_mine: b + 6.0,
            tesla_bolt: b + 7.0,
            missile: b + 8.0,
            shell: b + 9.0,
            chrono: b + 10.0,
            nuke: b + 11.0,
            naval_base: b + 12.0,
            planes_base: b + 20.0,
            helis_base: b + 28.0,
            abilities_base: b + 36.0,
        }
    }
}

const QUARTER_TURN: f32 = std::f32::consts::FRAC_PI_2;

pub struct View {
    pub x0: f32,
    pub y0: f32,
    pub x1: f32,
    pub y1: f32,
}

impl View {
    fn contains(&self, x: f32, y: f32, margin: f32) -> bool {
        x >= self.x0 - margin && x <= self.x1 + margin && y >= self.y0 - margin && y <= self.y1 + margin
    }
}

fn lerp(a: i32, b: i32, t: f32) -> f32 {
    px(a) + (px(b) - px(a)) * t
}

fn lerp_angle(a: i32, b: i32, t: f32) -> f32 {
    let d = angle_diff(a, b) as f32;
    (a as f32 + d * t) * std::f32::consts::TAU / 1024.0
}

impl World {
    /// Fill `sprites` and `rects` for what `player` can see inside `view`.
    pub fn build_render(&self, player: u8, alpha: f32, view: &View, selected: &[u32], sprites: &mut Vec<f32>, rects: &mut Vec<f32>) {
        sprites.clear();
        rects.clear();
        let ids = SpriteIds::new(self.rules.actors.len());
        let p = &self.players[player as usize];
        let push_sprite = |s: &mut Vec<f32>, x: f32, y: f32, angle: f32, sprite: f32, team: f32, scale: f32, a: f32, flash: f32| {
            s.extend_from_slice(&[x, y, angle, sprite, team, scale, a, flash]);
        };

        // Buildings: own and visible ones live, the rest as remembered ghosts.
        let mut building_turrets: Vec<f32> = Vec::new();
        for (i, a) in self.actors.iter().enumerate() {
            if !a.alive || a.kind != Kind::Building {
                continue;
            }
            if a.owner != player && !self.is_visible_to(i, player) {
                continue;
            }
            let (x, y) = (px(a.x), px(a.y));
            if !view.contains(x, y, 96.0) {
                continue;
            }
            let flash = (a.flash > 0) as i32 as f32;
            push_sprite(sprites, x, y, 0.0, (a.ty * 2) as f32, a.owner as f32, 1.0, 1.0, flash);
            if self.rules.actors[a.ty as usize].turret_turn_speed.is_some() {
                building_turrets.extend_from_slice(&[
                    x,
                    y,
                    lerp_angle(a.pturret, a.turret, alpha),
                    (a.ty * 2 + 1) as f32,
                    a.owner as f32,
                    1.0,
                    1.0,
                    flash,
                ]);
            }
        }
        for g in p.ghosts.values() {
            if let Some(i) = self.resolve(g.actor) {
                if self.is_visible_to(i, player) {
                    continue; // drawn live above
                }
            }
            let b = self.rules.actors[g.ty as usize].building.as_ref().unwrap();
            let (x, y) = (px(g.cx * CELL + b.width * CELL / 2), px(g.cy * CELL + b.height * CELL / 2));
            if view.contains(x, y, 96.0) {
                push_sprite(sprites, x, y, 0.0, (g.ty * 2) as f32, g.owner as f32, 1.0, 1.0, 0.0);
            }
        }

        sprites.extend_from_slice(&building_turrets);

        // Units: bodies, then turrets on top; aircraft after everything on the
        // ground, raised by their altitude, with a dark shadow underneath.
        let mut turrets: Vec<f32> = Vec::new();
        let mut aircraft: Vec<f32> = Vec::new();
        for (i, a) in self.actors.iter().enumerate() {
            if !a.alive || a.kind == Kind::Building {
                continue;
            }
            if a.kind == Kind::Aircraft {
                if a.owner != player && !self.is_visible_to(i, player) {
                    continue;
                }
                let (x, y) = (lerp(a.px, a.x, alpha), lerp(a.py, a.y, alpha));
                if !view.contains(x, y, 64.0) {
                    continue;
                }
                let lift = px(a.altitude);
                let ang = lerp_angle(a.pfacing, a.facing, alpha);
                // Shadow: the same sprite, transparent, at ground level.
                push_sprite(sprites, x + lift * 0.4, y, ang, (a.ty * 2) as f32, a.owner as f32, 0.9, 0.25, -1.0);
                push_sprite(&mut aircraft, x, y - lift, ang, (a.ty * 2) as f32, a.owner as f32, 1.0, 1.0, (a.flash > 0) as i32 as f32);
                if self.rules.actors[a.ty as usize].turret_turn_speed.is_some() {
                    push_sprite(
                        &mut aircraft,
                        x,
                        y - lift,
                        lerp_angle(a.pturret, a.turret, alpha),
                        (a.ty * 2 + 1) as f32,
                        a.owner as f32,
                        1.0,
                        1.0,
                        0.0,
                    );
                }
                continue;
            }
            if a.owner != player && !self.is_visible_to(i, player) {
                continue;
            }
            let (x, y) = (lerp(a.px, a.x, alpha), lerp(a.py, a.y, alpha));
            if !view.contains(x, y, 32.0) {
                continue;
            }
            let flash = (a.flash > 0) as i32 as f32;
            push_sprite(sprites, x, y, lerp_angle(a.pfacing, a.facing, alpha), (a.ty * 2) as f32, a.owner as f32, 1.0, 1.0, flash);
            if self.rules.actors[a.ty as usize].turret_turn_speed.is_some() {
                push_sprite(
                    &mut turrets,
                    x,
                    y,
                    lerp_angle(a.pturret, a.turret, alpha),
                    (a.ty * 2 + 1) as f32,
                    a.owner as f32,
                    1.0,
                    1.0,
                    flash,
                );
            }
        }
        sprites.extend_from_slice(&turrets);
        sprites.extend_from_slice(&aircraft);

        for pr in &self.projectiles {
            let (x, y) = (px(pr.x), px(pr.y));
            let ci = self.cell_index(pr.x, pr.y);
            if p.visible[ci] != 0 && view.contains(x, y, 16.0) {
                let ang = pr.facing as f32 * std::f32::consts::TAU / 1024.0;
                let wi = &self.rules.weapons[pr.weapon as usize];
                let (sprite, ang) = match wi.projectile {
                    crate::rules::Projectile::Missile => (ids.missile, ang - QUARTER_TURN),
                    _ if wi.arc => (ids.shell, ang),
                    _ => (ids.bullet, ang),
                };
                push_sprite(sprites, x, y, ang, sprite, pr.owner as f32, 1.0, 1.0, 0.0);
            }
        }
        for e in &self.effects {
            let (x, y) = (px(e.x), px(e.y));
            let ci = self.cell_index(e.x, e.y);
            if p.visible[ci] == 0 || !view.contains(x, y, 48.0) {
                continue;
            }
            let t = 1.0 - (e.ttl as f32 - alpha).max(0.0) / e.max as f32;
            let fade = (1.0 - t).max(0.0);
            if e.kind == EffectKind::TeslaBolt {
                // A chain of short zigzag segments from the coil to the target.
                let (tx, ty) = (px(e.tx), px(e.ty));
                let (dx, dy) = (tx - x, ty - y);
                let len = (dx * dx + dy * dy).sqrt().max(1.0);
                let ang = dy.atan2(dx);
                let n = (len / 14.0).ceil() as usize;
                for k in 0..n {
                    let f = (k as f32 + 0.5) / n as f32;
                    push_sprite(sprites, x + dx * f, y + dy * f, ang, ids.tesla_bolt, 0.0, 1.0, fade, 0.0);
                }
                continue;
            }
            let (sprite, scale, a) = match e.kind {
                EffectKind::SmallExplosion => (ids.small_explosion, 0.6 + t * 0.6, fade),
                EffectKind::LargeExplosion => (ids.large_explosion, 0.7 + t * 0.8, fade),
                EffectKind::Piff => (ids.piff, 0.6 + t * 0.4, fade),
                EffectKind::NukeExplosion => (ids.nuke, 0.5 + t * 1.5, fade),
                EffectKind::ChronoShimmer => (ids.chrono, 0.6 + t * 0.8, fade),
                EffectKind::Dust => (ids.large_explosion, 1.0 + t * 1.2, fade * 0.35),
                EffectKind::TeslaBolt => unreachable!(),
            };
            push_sprite(sprites, x, y, 0.0, sprite, 0.0, scale, a, 0.0);
        }

        // Selection: brackets, health bars and rally flags.
        for &r in selected {
            let Some(i) = self.resolve(r) else { continue };
            let a = &self.actors[i];
            if a.owner != player && !self.is_visible_to(i, player) {
                continue;
            }
            let info = &self.rules.actors[a.ty as usize];
            let (x, y, w, h) = if a.kind == Kind::Building {
                let b = info.building.as_ref().unwrap();
                (px(a.x), px(a.y), b.width as f32 * 24.0, b.height as f32 * 24.0)
            } else {
                let r = info.unit.as_ref().unwrap().radius;
                let s = (px(r * 2) + 6.0).max(14.0);
                (lerp(a.px, a.x, alpha), lerp(a.py, a.y, alpha), s, s)
            };
            let (l, t) = (x - w / 2.0, y - h / 2.0);
            let c = 4.0f32.min(w / 3.0);
            let white = [1.0, 1.0, 1.0, 0.9];
            for (rx, ry, rw, rh) in [
                (l, t, c, 1.0),
                (l, t, 1.0, c),
                (l + w - c, t, c, 1.0),
                (l + w - 1.0, t, 1.0, c),
                (l, t + h - 1.0, c, 1.0),
                (l, t + h - c, 1.0, c),
                (l + w - c, t + h - 1.0, c, 1.0),
                (l + w - 1.0, t + h - c, 1.0, c),
            ] {
                rects.extend_from_slice(&[rx, ry, rw, rh, white[0], white[1], white[2], white[3]]);
            }
            let frac = (a.hp as f32 / info.hp as f32).clamp(0.0, 1.0);
            let col = if frac > 0.5 {
                [0.25, 0.85, 0.3]
            } else if frac > 0.25 {
                [0.95, 0.8, 0.2]
            } else {
                [0.9, 0.2, 0.15]
            };
            rects.extend_from_slice(&[l, t - 5.0, w, 3.0, 0.0, 0.0, 0.0, 0.7]);
            rects.extend_from_slice(&[l, t - 5.0, w * frac, 3.0, col[0], col[1], col[2], 1.0]);
            if let Some(hv) = info.unit.as_ref().and_then(|u| u.harvester.as_ref()) {
                let load = a.bales as f32 / hv.capacity as f32;
                rects.extend_from_slice(&[l, t + h + 2.0, w, 2.0, 0.0, 0.0, 0.0, 0.7]);
                rects.extend_from_slice(&[l, t + h + 2.0, w * load, 2.0, 0.95, 0.75, 0.2, 1.0]);
            }
            if a.kind == Kind::Building && a.owner == player {
                if let Some((rx, ry)) = a.rally {
                    push_sprite(sprites, px(rx), px(ry), 0.0, ids.rally, a.owner as f32, 1.0, 1.0, 0.0);
                }
            }
            if a.kind != Kind::Building && a.owner == player && a.activity == Activity::Move && a.goal != crate::world::NONE {
                let gx = (a.goal as i32 % self.map.width) as f32 * 24.0 + 12.0;
                let gy = (a.goal as i32 / self.map.width) as f32 * 24.0 + 12.0;
                rects.extend_from_slice(&[gx - 1.5, gy - 1.5, 3.0, 3.0, 0.3, 1.0, 0.4, 0.8]);
            }
        }
    }

    /// One byte per cell for the local player: 0 shroud, 1 fog, 2 visible.
    pub fn fog_bytes(&self, player: u8, out: &mut Vec<u8>) {
        let p = &self.players[player as usize];
        out.clear();
        out.extend(p.visible.iter().zip(p.explored.iter()).map(|(&v, &e)| {
            if v != 0 {
                255
            } else if e != 0 {
                128
            } else {
                0
            }
        }));
    }

    /// RGBA per cell: R terrain type, G ore density (scaled), B ore max flag.
    pub fn terrain_bytes(&self, out: &mut Vec<u8>) {
        out.clear();
        let max = self.rules.player.ore_max_density.max(1) as u32;
        for i in 0..self.map.cells() {
            out.push(self.map.terrain[i] as u8);
            out.push((self.map.ore[i] as u32 * 255 / max) as u8);
            out.push(0);
            out.push(255);
        }
    }
}

//! Builds flat instance arrays for the WebGPU renderer: evaluated for one
//! frame (`build_render`, the CPU path) or as tick-rate records the GPU
//! instance pass evaluates every frame (`build_render_records`); both come
//! from `emit_render` through an `instances::Sink`.
//!
//! Sprites: 8 floats each `[x, y, angle, sprite, team, scale, alpha, flash]`,
//! positions in world pixels (24 px per cell, like the original game).
//! Rects:   8 floats each `[x, y, w, h, r, g, b, a]` for selection brackets and health bars;
//!          a negative `r` selects team colour `-r - 1` scaled by `g` (overlays.rs `team_color`).

use crate::instances::{Anchor, Sink, SpriteRec, NO_CULL};
use crate::math::{angle_diff, CELL};
use crate::overlays::{push_brackets, push_group_number, push_health_bar, team_color, RALLY_MARKER};
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
/// Infantry have no turret: their `2t + 1` is the prone pose (veterancy.rs).
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
    pub veterancy_base: f32,
    /// Repair wrench and power off icon (repair.rs).
    pub decorations_base: f32,
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
            veterancy_base: b + 44.0,
            decorations_base: b + 52.0,
        }
    }
}

const QUARTER_TURN: f32 = std::f32::consts::FRAC_PI_2;

/// Opacity of the black layer over a disabled structure (OpenRA
/// WithColoredOverlay@IDISABLE colour 000000B4: 180 of 255).
pub const DISABLED_SHADE: f32 = 180.0 / 255.0;

/// What a body or turret sprite shows, for art with pre-rendered animations
/// (apps/game/js/content: original graphics and texture packs pick their
/// sequence and frame from it in shaders/sprite.wgsl). Reported only with
/// `RenderOptions::poses`; presentation only, read from the world, never
/// written to it. Same numbers as `POSE` in apps/game/js/content/sequences.js.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum Pose {
    Idle = 0,
    Move = 1,
    Attack = 2,
    /// Below half health (OpenRA DamageState.Heavy: the "damaged-" sequences).
    Damaged = 3,
    /// Just placed: the age is the ticks since then (the "make" animation).
    Make = 4,
    Harvest = 5,
    /// Unloading at the refinery.
    Dock = 6,
    /// The first frame only: no power, or remembered under the fog.
    Still = 7,
    DamagedStill = 8,
}

/// Sprite ids with poses: `slot + POSE_STRIDE * (pose + POSE_CODES * age)`.
/// Slots stay below `POSE_STRIDE`, so `id % POSE_STRIDE` is always the slot
/// (docs/contracts.md section 8).
pub const POSE_STRIDE: u32 = 4096;
pub const POSE_CODES: u32 = 16;
/// Largest age the id carries (ticks since the actor appeared, or a wall's connection mask).
pub const MAX_POSE_AGE: u32 = 127;

/// The sprite id of `slot` showing `pose` at `age`.
#[inline]
pub fn posed(slot: u32, pose: Pose, age: u32) -> f32 {
    debug_assert!(slot < POSE_STRIDE);
    (slot + POSE_STRIDE * (pose as u32 + POSE_CODES * age.min(MAX_POSE_AGE))) as f32
}

pub struct View {
    pub x0: f32,
    pub y0: f32,
    pub x1: f32,
    pub y1: f32,
}

impl View {
    pub(crate) fn contains(&self, x: f32, y: f32, margin: f32) -> bool {
        x >= self.x0 - margin && x <= self.x1 + margin && y >= self.y0 - margin && y <= self.y1 + margin
    }
}

/// Rects given as `[x, y, w, h, r, g, b, a]` relative to `anchor`, each
/// culled with `margin` around the anchor.
pub(crate) fn push_anchored_rects(sink: &mut Sink, rects: &mut Vec<f32>, anchor: &Anchor, margin: f32, rel: &[f32]) {
    for q in rel.as_chunks::<RECT_FLOATS>().0 {
        sink.rect(rects, anchor.rect(margin, q[0], q[1], q[2], q[3], [q[4], q[5], q[6], q[7]]));
    }
}

/// A rect `[x, y, w, h, r, g, b, a]` at a fixed place, never culled.
pub(crate) fn push_fixed_rect(sink: &mut Sink, rects: &mut Vec<f32>, q: &[f32; 8]) {
    sink.rect(rects, Anchor::fixed(0.0, 0.0).rect(NO_CULL, q[0], q[1], q[2], q[3], [q[4], q[5], q[6], q[7]]));
}

impl World {
    /// Fill `sprites` and `rects` for what `player` can see inside `view`,
    /// interpolated by `alpha` (the CPU path: tick-rate records evaluated at
    /// once, instances.rs).
    pub fn build_render(&self, player: u8, alpha: f32, view: &View, selected: &[u32], sprites: &mut Vec<f32>, rects: &mut Vec<f32>) {
        sprites.clear();
        rects.clear();
        let mut sink = Sink::eval(alpha, view);
        self.emit_render(player, &mut sink, selected, sprites, rects);
    }

    /// The same frame as tick-rate records for the GPU instance pass
    /// (instances.rs): everything `player` can see on the whole map, with
    /// both ends of each interpolation and the cull of each group, in draw
    /// order. Depends on the world, `player`, `selected` and the render
    /// options only, so it is built once per tick (or when they change).
    pub fn build_render_records(&self, player: u8, selected: &[u32], sprites: &mut Vec<f32>, extras: &mut Vec<f32>, rects: &mut Vec<f32>) {
        sprites.clear();
        rects.clear();
        let mut sink = Sink::record(std::mem::take(extras));
        self.emit_render(player, &mut sink, selected, sprites, rects);
        *extras = sink.extras;
    }

    fn emit_render(&self, player: u8, sink: &mut Sink, selected: &[u32], sprites: &mut Vec<f32>, rects: &mut Vec<f32>) {
        let ids = SpriteIds::new(self.rules.actors.len());
        let p = &self.players[player as usize];

        // Buildings: own and visible ones live, the rest as remembered ghosts.
        let mut building_turrets: Vec<f32> = Vec::new();
        for (i, a) in self.actors.iter().enumerate() {
            if !a.alive || a.kind != Kind::Building {
                continue;
            }
            if a.owner != player && (!self.is_visible_to(i, player) || self.is_cloaked_from(i, player)) {
                continue;
            }
            let (x, y) = (px(a.x), px(a.y));
            let Some(at) = sink.group([x, y], [x, y], 96.0) else { continue };
            let flash = (a.flash > 0) as i32 as f32;
            // Cloaked structures (Camo Pillbox) are drawn faint for their owner and allies.
            let alpha = if a.ab.cloaked { 0.45 } else { 1.0 };
            let body = self.body_sprite(i, a.ty as u32 * 2);
            sink.sprite(sprites, at.look(body, a.owner as f32, 1.0, alpha, flash));
            // Disabled (low power, switched off): darkened like OpenRA's
            // WithColoredOverlay@IDISABLE (black at 70 percent) over every layer.
            let dim = self.is_powered_down(i);
            if dim {
                sink.sprite(sprites, at.look(body, a.owner as f32, 1.0, alpha * DISABLED_SHADE, -1.0));
            }
            // Radar dishes, smoke and lights (overlays.rs), over every building body.
            self.push_building_overlay(i, x, y, alpha, flash, sink, &mut building_turrets);
            if dim {
                self.push_building_overlay(i, x, y, alpha * DISABLED_SHADE, -1.0, sink, &mut building_turrets);
            }
            if self.rules.actors[a.ty as usize].turret_turn_speed.is_some() {
                // Interpolated by the frame's alpha like unit turrets (the angle used to be taken at the building's opacity).
                let slot = a.ty as u32 * 2 + 1;
                let turret = if self.render_opts.poses && self.heavily_damaged(i) { posed(slot, Pose::Damaged, 0) } else { slot as f32 };
                let r = at.facing(a.pturret, angle_diff(a.pturret, a.turret)).look(turret, a.owner as f32, 1.0, 1.0, flash);
                sink.sprite(&mut building_turrets, r);
                if dim {
                    let r = at.facing(a.pturret, angle_diff(a.pturret, a.turret)).look(turret, a.owner as f32, 1.0, DISABLED_SHADE, -1.0);
                    sink.sprite(&mut building_turrets, r);
                }
            }
        }
        // The spectator view (observer.rs) draws every structure live, no ghosts.
        for g in p.ghosts.values().filter(|_| !self.render_all) {
            if let Some(i) = self.resolve(g.actor) {
                if self.is_visible_to(i, player) && !self.is_cloaked_from(i, player) {
                    continue; // drawn live above
                }
            }
            let b = self.rules.actors[g.ty as usize].building.as_ref().unwrap();
            // Hidden while an enemy gap generator shrouds it (abilities.rs).
            if self.gen_shrouded(player, self.map.idx(g.cx, g.cy)) {
                continue;
            }
            let (x, y) = (px(g.cx * CELL + b.width * CELL / 2), px(g.cy * CELL + b.height * CELL / 2));
            if sink.visible([x, y], [x, y], 96.0) {
                let body = if self.render_opts.poses { posed(g.ty as u32 * 2, Pose::Still, 0) } else { (g.ty * 2) as f32 };
                sink.sprite(sprites, SpriteRec::at(x, y, 96.0).look(body, g.owner as f32, 1.0, 1.0, 0.0));
                self.push_ghost_overlay(g.ty, g.owner, x, y, sink, &mut building_turrets);
            }
        }

        sprites.extend_from_slice(&building_turrets);

        // Units: bodies, then turrets on top; aircraft after everything on the
        // ground, raised by their altitude, with a dark shadow underneath.
        let mut turrets: Vec<f32> = Vec::new();
        let mut aircraft: Vec<f32> = Vec::new();
        for (i, a) in self.actors.iter().enumerate() {
            // Passengers are inside their transport; mines are drawn by render_abilities.
            if !a.alive || a.kind == Kind::Building || a.kind == Kind::Mine || !a.in_world() {
                continue;
            }
            let (from, to) = ([px(a.px), px(a.py)], [px(a.x), px(a.y)]);
            if a.kind == Kind::Aircraft {
                if a.owner != player && !self.is_visible_to(i, player) {
                    continue;
                }
                let Some(at) = sink.group(from, to, 64.0) else { continue };
                let lift = px(a.altitude);
                let body = (a.ty * 2) as f32;
                let turn = angle_diff(a.pfacing, a.facing);
                // Shadow: the same sprite, transparent, at ground level.
                sink.sprite(sprites, at.facing(a.pfacing, turn).look(body, a.owner as f32, 0.9, 0.25, -1.0).offset(lift * 0.4, 0.0));
                let flash = (a.flash > 0) as i32 as f32;
                sink.sprite(&mut aircraft, at.facing(a.pfacing, turn).look(body, a.owner as f32, 1.0, 1.0, flash).offset(0.0, -lift));
                if self.rules.actors[a.ty as usize].turret_turn_speed.is_some() {
                    let r = at.facing(a.pturret, angle_diff(a.pturret, a.turret)).look(body + 1.0, a.owner as f32, 1.0, 1.0, 0.0);
                    sink.sprite(&mut aircraft, r.offset(0.0, -lift));
                }
                // Helicopter rotors and rotor wash (helicopter.rs).
                self.push_heli_rotors(i, at, lift, sink, sprites, &mut aircraft);
                continue;
            }
            // Paratroopers in the air are drawn with the aircraft extras (plane.rs).
            if a.air.parachute || (a.owner != player && (!self.is_visible_to(i, player) || self.is_cloaked_from(i, player))) {
                continue;
            }
            let Some(at) = sink.group(from, to, 32.0) else { continue };
            let flash = (a.flash > 0) as i32 as f32;
            if a.kind == Kind::Ship {
                self.push_ship(sink, sprites, &mut turrets, a, at, flash, &ids);
                continue;
            }
            // Cloaked units (Phase Transport) are drawn faint for their owner and allies.
            let body_alpha = if a.ab.cloaked { 0.45 } else { 1.0 };
            // Prone infantry lie flat (TakeCover, veterancy.rs).
            let body = if self.draws_prone(i) { a.ty * 2 + 1 } else { a.ty * 2 };
            sink.sprite(
                sprites,
                at.facing(a.pfacing, angle_diff(a.pfacing, a.facing)).look(
                    self.body_sprite(i, body as u32),
                    a.owner as f32,
                    1.0,
                    body_alpha,
                    flash,
                ),
            );
            if self.rules.actors[a.ty as usize].turret_turn_speed.is_some() {
                let r = at.facing(a.pturret, angle_diff(a.pturret, a.turret)).look((a.ty * 2 + 1) as f32, a.owner as f32, 1.0, 1.0, flash);
                sink.sprite(&mut turrets, r);
            }
        }
        // Shot-down helicopters falling (helicopter.rs).
        self.push_heli_crashes(player, sink, sprites, &mut aircraft);
        sprites.extend_from_slice(&turrets);
        // Mines, ability effects and decorations (abilities.rs).
        self.render_abilities(player, sink, selected, sprites, rects);
        // Paratroopers, bombs, contrails and wreck smoke under the aircraft (plane.rs).
        self.render_air_extras(player, sink, &ids, sprites);
        sprites.extend_from_slice(&aircraft);
        // Rank chevrons on top of every unit (veterancy.rs).
        self.render_veterancy(player, sink, ids.veterancy_base, sprites);
        // Repair wrenches and power off icons on structures (repair.rs).
        self.render_building_decorations(player, sink, ids.decorations_base, sprites);

        for pr in &self.projectiles {
            let (x, y) = (px(pr.x), px(pr.y));
            let ci = self.cell_index(pr.x, pr.y);
            if self.render_sees_cell(player, ci) && sink.visible([x, y], [x, y], 16.0) {
                let wi = &self.rules.weapons[pr.weapon as usize];
                let (sprite, turned) = match (self.naval_projectile_sprite(pr.weapon as usize), wi.projectile) {
                    // Torpedoes are drawn pointing east like missiles.
                    (Some(n), crate::rules::Projectile::Missile) => (ids.naval_base + n as f32, true),
                    (Some(n), _) => (ids.naval_base + n as f32, false),
                    (None, crate::rules::Projectile::Missile) => (ids.missile, true),
                    _ if wi.arc => (ids.shell, false),
                    _ => (ids.bullet, false),
                };
                let r = SpriteRec::at(x, y, 16.0).facing(pr.facing, 0).look(sprite, pr.owner as f32, 1.0, 1.0, 0.0);
                if turned {
                    sink.sprite(sprites, r.angle_affine(1.0, -QUARTER_TURN));
                } else {
                    sink.sprite(sprites, r);
                }
            }
        }
        for e in &self.effects {
            let (x, y) = (px(e.x), px(e.y));
            let ci = self.cell_index(e.x, e.y);
            if !self.render_sees_cell(player, ci) || !sink.visible([x, y], [x, y], 48.0) {
                continue;
            }
            // Age and fade at the previous (alpha 0) and the current tick
            // (alpha 1); both are affine in alpha in between.
            let age = |alpha: f32| 1.0 - (e.ttl as f32 - alpha).max(0.0) / e.max as f32;
            let (t0, t1) = (age(0.0), age(1.0));
            let (fade0, fade1) = ((1.0 - t0).max(0.0), (1.0 - t1).max(0.0));
            if e.kind == EffectKind::TeslaBolt {
                // A chain of short zigzag segments from the coil to the target.
                let (tx, ty) = (px(e.tx), px(e.ty));
                let (dx, dy) = (tx - x, ty - y);
                let len = (dx * dx + dy * dy).sqrt().max(1.0);
                let ang = dy.atan2(dx);
                let n = (len / 14.0).ceil() as usize;
                for k in 0..n {
                    let f = (k as f32 + 0.5) / n as f32;
                    let r = SpriteRec::at(x, y, 48.0).look(ids.tesla_bolt, 0.0, 1.0, fade0, 0.0);
                    sink.sprite(sprites, r.offset(dx * f, dy * f).radians(ang).fade_to(1.0, fade1));
                }
                continue;
            }
            let look = |t: f32, fade: f32| match e.kind {
                EffectKind::SmallExplosion => (ids.small_explosion, 0.6 + t * 0.6, fade),
                EffectKind::LargeExplosion => (ids.large_explosion, 0.7 + t * 0.8, fade),
                EffectKind::Piff => (ids.piff, 0.6 + t * 0.4, fade),
                EffectKind::NukeExplosion => (ids.nuke, 0.5 + t * 1.5, fade),
                EffectKind::ChronoShimmer => (ids.chrono, 0.6 + t * 0.8, fade),
                EffectKind::Dust => (ids.large_explosion, 1.0 + t * 1.2, fade * 0.35),
                EffectKind::Naval(n) => (ids.naval_base + n as f32, 0.7 + t * 0.6, fade),
                EffectKind::TeslaBolt => unreachable!(),
            };
            let ((sprite, scale0, a0), (_, scale1, a1)) = (look(t0, fade0), look(t1, fade1));
            sink.sprite(sprites, SpriteRec::at(x, y, 48.0).look(sprite, 0.0, scale0, a0, 0.0).fade_to(scale1, a1));
        }

        // Health bars of the selection's targets and of hovered, damaged or all actors (overlays.rs).
        self.render_status_bars(player, sink, selected, rects);
        // Selection: brackets, health bars, control group numbers and rally points.
        let mut rel: Vec<f32> = Vec::new();
        for &r in selected {
            let Some(i) = self.resolve(r) else { continue };
            let a = &self.actors[i];
            if !a.in_world() || (a.owner != player && (!self.is_visible_to(i, player) || self.is_cloaked_from(i, player))) {
                continue;
            }
            let info = &self.rules.actors[a.ty as usize];
            // Everything below hangs off the actor's box, given relative to its centre.
            let (anchor, w, h) = self.selection_anchor(i);
            let (l, t) = (-w / 2.0, -h / 2.0);
            rel.clear();
            // Owner coloured corner brackets and a segmented health bar (overlays.rs).
            push_brackets(l, t, w, h, a.owner, &mut rel);
            push_health_bar(l, t, w, self.health_frac(i), &mut rel);
            // Cargo pips: one per weight unit of Cargo.MaxWeight, filled per passenger.
            if self.is_transport(i) && self.render_allied(a.owner, player) {
                let max = self.cargo_max(i).clamp(0, 12);
                let full = self.cargo_weight(i);
                for k in 0..max {
                    let (px_, py_) = (l + 1.0 + k as f32 * 4.0, t + h + 5.0);
                    rel.extend_from_slice(&[px_ - 0.5, py_ - 0.5, 4.0, 4.0, 0.0, 0.0, 0.0, 0.8]);
                    let c = if k < full { [0.3, 0.95, 0.35, 1.0] } else { [0.35, 0.35, 0.35, 0.9] };
                    rel.extend_from_slice(&[px_, py_, 3.0, 3.0, c[0], c[1], c[2], c[3]]);
                }
            }
            if let Some(hv) = info.unit.as_ref().and_then(|u| u.harvester.as_ref()) {
                // Load bar: ore yellow, gems red after it (OpenRA pips: Ore pip-yellow, Gems pip-red).
                let cap = hv.capacity.max(1) as f32;
                let ore = (a.bales - a.gem_bales) as f32 / cap;
                let gems = a.gem_bales as f32 / cap;
                rel.extend_from_slice(&[l, t + h + 2.0, w, 2.0, 0.0, 0.0, 0.0, 0.7]);
                rel.extend_from_slice(&[l, t + h + 2.0, w * ore, 2.0, 0.95, 0.75, 0.2, 1.0]);
                rel.extend_from_slice(&[l + w * ore, t + h + 2.0, w * gems, 2.0, 0.9, 0.2, 0.3, 1.0]);
            }
            self.push_heli_ammo_pips(i, l, t + h, w, &mut rel);
            // The control group number, selected actors only (OpenRA's
            // control group decoration RequiresSelection; overlays.rs).
            if let Some(g) = self.render_opts.control_group(r) {
                push_group_number(l, t, w, h, g, &mut rel);
            }
            push_anchored_rects(sink, rects, &anchor, NO_CULL, &rel);
            // Rally point (OpenRA RallyPointIndicator): a marker at both ends of
            // the line (drawn by `build_rally_lines`) and the flag at the point.
            if self.shows_rally_to(i, player) {
                if let Some((from, to)) = self.rally_line(i) {
                    let c = team_color(a.owner, 1.0, 1.0);
                    let m = RALLY_MARKER;
                    for (x, y) in [from, to] {
                        push_fixed_rect(sink, rects, &[x - m, y - m, 2.0 * m, 2.0 * m, c[0], c[1], c[2], c[3]]);
                    }
                    sink.sprite(sprites, SpriteRec::at(to.0, to.1, NO_CULL).look(ids.rally, a.owner as f32, 1.0, 1.0, 0.0));
                }
            }
            if a.kind != Kind::Building && self.render_owns(a.owner, player) && a.activity == Activity::Move && a.goal != crate::world::NONE
            {
                let gx = (a.goal as i32 % self.map.width) as f32 * 24.0 + 12.0;
                let gy = (a.goal as i32 / self.map.width) as f32 * 24.0 + 12.0;
                push_fixed_rect(sink, rects, &[gx - 1.5, gy - 1.5, 3.0, 3.0, 0.3, 1.0, 0.4, 0.8]);
            }
        }
        self.render_waypoints(player, selected, sink, rects);
        // Beacons of the player and their allies, over the shroud (beacons.rs).
        self.render_beacons(player, sink, rects);
    }

    /// Queued waypoints of the selected own units: a marker per waypoint and
    /// dots from the current destination through the queue (attack-moves in orange).
    fn render_waypoints(&self, player: u8, selected: &[u32], sink: &mut Sink, rects: &mut Vec<f32>) {
        // Units of one order share the queue: draw each (group, point) once.
        let mut drawn: Vec<(u32, i32, i32)> = Vec::new();
        for &r in selected {
            let Some(i) = self.resolve(r) else { continue };
            let a = &self.actors[i];
            if a.owner != player || !a.in_world() || a.waypoints.is_empty() {
                continue;
            }
            let mut from = (a.activity == Activity::Move).then_some(a.dest);
            for wp in &a.waypoints {
                let col = if wp.attack_move { [1.0, 0.6, 0.2] } else { [0.3, 1.0, 0.4] };
                let (x, y) = (px(wp.x), px(wp.y));
                if !drawn.contains(&(wp.group, wp.x, wp.y)) {
                    drawn.push((wp.group, wp.x, wp.y));
                    push_fixed_rect(sink, rects, &[x - 2.5, y - 2.5, 5.0, 5.0, 0.0, 0.0, 0.0, 0.6]);
                    push_fixed_rect(sink, rects, &[x - 1.5, y - 1.5, 3.0, 3.0, col[0], col[1], col[2], 0.95]);
                    if let Some((fx, fy)) = from {
                        let (fx, fy) = (px(fx), px(fy));
                        let len = ((x - fx).powi(2) + (y - fy).powi(2)).sqrt();
                        let n = ((len / 8.0) as usize).clamp(1, 96);
                        for k in 1..n {
                            let f = k as f32 / n as f32;
                            let (dx, dy) = (fx + (x - fx) * f, fy + (y - fy) * f);
                            push_fixed_rect(sink, rects, &[dx - 0.75, dy - 0.75, 1.5, 1.5, col[0], col[1], col[2], 0.7]);
                        }
                    }
                }
                from = Some((wp.x, wp.y));
            }
        }
    }

    /// A ship's hull and turrets (OpenRA Turreted offsets along the hull, e.g.
    /// the Cruiser's two). Submerged submarines are a faint shape with a
    /// ripple; `build_render` only gets here for players allowed to see them.
    #[allow(clippy::too_many_arguments)]
    fn push_ship(
        &self,
        sink: &mut Sink,
        sprites: &mut Vec<f32>,
        turrets: &mut Vec<f32>,
        a: &crate::world::Actor,
        at: SpriteRec,
        flash: f32,
        ids: &SpriteIds,
    ) {
        let (team, body) = (a.owner as f32, (a.ty * 2) as f32);
        let turn = angle_diff(a.pfacing, a.facing);
        let hull = at.facing(a.pfacing, turn);
        if a.submerged {
            sink.sprite(sprites, hull.look(body, team, 1.0, 0.3, 0.0));
            let ripple = ids.naval_base + crate::naval::NAVAL_RIPPLE as f32;
            sink.sprite(sprites, hull.look(ripple, team, 1.0, 0.7, 0.0));
            return;
        }
        sink.sprite(sprites, hull.look(body, team, 1.0, 1.0, flash));
        let info = &self.rules.actors[a.ty as usize];
        if info.turret_turn_speed.is_none() {
            return;
        }
        let turret = at.facing(a.pturret, angle_diff(a.pturret, a.turret)).look(body + 1.0, team, 1.0, 1.0, flash);
        let offsets: &[(i32, i32)] = if info.turret_offsets.is_empty() { &[(0, 0)] } else { &info.turret_offsets };
        for &(fwd, side) in offsets {
            // Forward is (sin, -cos) of the hull angle, right is (cos, sin).
            sink.sprite(turrets, turret.extended().arm(px(fwd), px(side), a.pfacing, turn));
        }
    }

    /// Below half health, like OpenRA's DamageState.Heavy (hp < 50%).
    fn heavily_damaged(&self, i: usize) -> bool {
        let a = &self.actors[i];
        (a.hp as i64) * 2 < self.rules.actors[a.ty as usize].hp as i64
    }

    /// Walls (LineBuild): which neighbours are walls of the same type, OpenRA
    /// WithWallSpriteBody bits (1 north, 2 east, 4 south, 8 west).
    fn wall_connections(&self, i: usize) -> u32 {
        let a = &self.actors[i];
        let mut mask = 0;
        for (bit, dx, dy) in [(1, 0, -1), (2, 1, 0), (4, 0, 1), (8, -1, 0)] {
            let (x, y) = (a.cx + dx, a.cy + dy);
            if !self.map.contains(x, y) {
                continue;
            }
            let other = self.building_at[self.map.idx(x, y)];
            if other != crate::world::NONE && self.actors.get(other as usize).is_some_and(|o| o.alive && o.ty == a.ty) {
                mask |= bit;
            }
        }
        mask
    }

    /// The pose of a live structure's body sprite, and its age.
    pub(crate) fn building_pose(&self, i: usize) -> (Pose, u32) {
        let a = &self.actors[i];
        let info = &self.rules.actors[a.ty as usize];
        let damaged = self.heavily_damaged(i);
        if info.is_wall() {
            return (if damaged { Pose::Damaged } else { Pose::Idle }, self.wall_connections(i));
        }
        let age = self.tick.saturating_sub(a.born);
        if a.born > 0 && age < MAX_POSE_AGE {
            return (Pose::Make, age);
        }
        if self.is_powered_down(i) {
            return (if damaged { Pose::DamagedStill } else { Pose::Still }, 0);
        }
        (if damaged { Pose::Damaged } else { Pose::Idle }, 0)
    }

    /// The pose of a unit's body sprite: walking, firing, harvesting or docking.
    fn unit_pose(&self, i: usize) -> Pose {
        let a = &self.actors[i];
        let moving = a.x != a.px || a.y != a.py;
        let harvester = self.rules.actors[a.ty as usize].unit.as_ref().is_some_and(|u| u.harvester.is_some());
        if harvester {
            return match a.harv {
                crate::world::HarvState::Unloading => Pose::Dock,
                crate::world::HarvState::Harvesting if !moving => Pose::Harvest,
                _ if moving => Pose::Move,
                _ => Pose::Idle,
            };
        }
        if moving {
            Pose::Move
        } else if matches!(a.activity, Activity::Attack | Activity::AttackGround) {
            Pose::Attack
        } else {
            Pose::Idle
        }
    }

    /// `slot` with the pose of actor `i`'s body when poses are on.
    fn body_sprite(&self, i: usize, slot: u32) -> f32 {
        if !self.render_opts.poses {
            return slot as f32;
        }
        let (pose, age) = if self.actors[i].kind == Kind::Building { self.building_pose(i) } else { (self.unit_pose(i), 0) };
        posed(slot, pose, age)
    }

    /// One byte per cell for the local player: 0 shroud, 128 fog, 255 visible.
    pub fn fog_bytes(&self, player: u8, out: &mut Vec<u8>) {
        let p = &self.players[player as usize];
        out.clear();
        let gen = self.abil.gen_shroud.get(player as usize);
        out.extend(p.visible.iter().zip(p.explored.iter()).enumerate().map(|(i, (&v, &e))| {
            if v != 0 {
                255
            } else if e != 0 && gen.is_none_or(|g| g[i] == 0) {
                128
            } else {
                0
            }
        }));
    }

    /// RGBA per cell: R terrain type, G ore density and B gem density, each
    /// scaled so that the type's maximum is 255.
    pub fn terrain_bytes(&self, out: &mut Vec<u8>) {
        out.clear();
        let max = self.rules.player.ore_max_density.max(1) as u32;
        let gem_max = self.rules.player.gem_max_density.max(1) as u32;
        for i in 0..self.map.cells() {
            out.push(self.map.terrain[i] as u8);
            out.push((self.map.ore[i].min(max as u8) as u32 * 255 / max) as u8);
            out.push((self.map.gems[i].min(gem_max as u8) as u32 * 255 / gem_max) as u8);
            out.push(255);
        }
    }
}

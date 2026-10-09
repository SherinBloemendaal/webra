//! OpenRA style overlays on top of the battlefield: selection brackets in the
//! owner's colour, thin segmented health bars above them (for the selection,
//! the actor under the mouse and, by the player's choice, damaged or all
//! actors), and the animated layer of buildings (apps/game/js/art/anim.js).
//!
//! Everything here is presentation only: it reads the world and fills the
//! render buffers, the simulation never reads `RenderOptions`.

use crate::instances::{Anchor, Sink, SpriteRec};
use crate::render::{posed, push_anchored_rects, px, Pose, MAX_POSE_AGE, POSE_STRIDE};
use crate::rules::Kind;
use crate::world::{World, NONE};

/// Which actors show a health bar besides the selection and the hovered actor
/// (OpenRA's status bar setting: Standard, Show Damaged, Always Show).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum HealthBars {
    /// Only selected actors and the one under the mouse.
    #[default]
    Selected,
    /// Also every visible damaged actor.
    Damaged,
    /// Every visible actor.
    All,
}

impl HealthBars {
    pub fn from_index(i: u8) -> HealthBars {
        match i {
            1 => HealthBars::Damaged,
            2 => HealthBars::All,
            _ => HealthBars::Selected,
        }
    }
}

/// Client side render settings. Never part of the simulation state.
#[derive(Clone, Debug)]
pub struct RenderOptions {
    /// Actor ref under the mouse, or NONE.
    pub hover: u32,
    pub health_bars: HealthBars,
    /// Per actor type: the static frame of its animated building layer, or 0
    /// when the type has none. The animated head frame is the type's second
    /// sprite slot (`2t + 1`), see apps/game/js/sprites.js `buildAtlas`.
    /// A value of `POSE_STRIDE` or more is a layer with poses (the original
    /// War Factory roof and door): with `poses` on it shows the structure's
    /// pose, is hidden while the structure is built and plays `Pose::Make`
    /// (the door) when a unit has just been produced; the value itself is
    /// the layer's still sprite (fog, no power).
    pub building_overlays: Vec<u32>,
    /// Sprite poses (render.rs `Pose`): body sprites carry what the actor is
    /// doing, for art with pre-rendered animations (original graphics,
    /// texture packs). Off by default: sprite ids are then the plain slots.
    pub poses: bool,
}

impl Default for RenderOptions {
    fn default() -> RenderOptions {
        RenderOptions { hover: NONE, health_bars: HealthBars::Selected, building_overlays: Vec::new(), poses: false }
    }
}

/// Bracket arm thickness and the longest arm, in world pixels.
pub const BRACKET_THICKNESS: f32 = 1.0;
pub const BRACKET_ARM: f32 = 5.0;
/// Health bar: height of the segments, gap above the bracket, segment pitch.
pub const BAR_HEIGHT: f32 = 2.0;
pub const BAR_GAP: f32 = 2.0;
pub const SEGMENT_PITCH: f32 = 4.0;
pub const MIN_SEGMENTS: usize = 3;

/// Rect colour that the rect shader replaces with team colour `team` times
/// `shade` (apps/game/shaders/rect.wgsl): red below zero selects a team.
pub fn team_color(team: u8, shade: f32, alpha: f32) -> [f32; 4] {
    [-(team as f32 + 1.0), shade, 0.0, alpha]
}

/// Side of the box of an actor without a footprint or radius (mines).
pub const MINE_BOX: f32 = 14.0;

/// Side of a unit's selection box in world pixels for its radius in world units.
pub fn unit_box_size(radius: i32) -> f32 {
    (px(radius * 2) + 6.0).max(14.0)
}

/// OpenRA damage states: green above half health, yellow above a quarter, red below.
pub fn health_color(frac: f32) -> [f32; 3] {
    if frac > 0.5 {
        [0.2, 0.85, 0.25]
    } else if frac > 0.25 {
        [0.95, 0.8, 0.15]
    } else {
        [0.9, 0.15, 0.1]
    }
}

/// Number of segments of a health bar `w` world pixels wide.
pub fn segment_count(w: f32) -> usize {
    ((w / SEGMENT_PITCH).floor() as usize).max(MIN_SEGMENTS)
}

/// Filled segments for a health fraction: any health left lights one.
pub fn filled_segments(frac: f32, segments: usize) -> usize {
    if frac <= 0.0 {
        0
    } else {
        ((frac.min(1.0) * segments as f32).ceil() as usize).clamp(1, segments)
    }
}

fn push_rect(out: &mut Vec<f32>, x: f32, y: f32, w: f32, h: f32, c: [f32; 4]) {
    out.extend_from_slice(&[x, y, w, h, c[0], c[1], c[2], c[3]]);
}

/// Corner brackets around the box (l, t, w, h) in team colour: two arms per
/// corner, a third of the shorter side long at most.
pub fn push_brackets(l: f32, t: f32, w: f32, h: f32, team: u8, out: &mut Vec<f32>) {
    let arm = BRACKET_ARM.min(w.min(h) / 3.0);
    let k = BRACKET_THICKNESS;
    let c = team_color(team, 1.1, 0.95);
    let (r, b) = (l + w, t + h);
    for (x, y, ww, hh) in [
        (l, t, arm, k),
        (l, t, k, arm),
        (r - arm, t, arm, k),
        (r - k, t, k, arm),
        (l, b - k, arm, k),
        (l, b - arm, k, arm),
        (r - arm, b - k, arm, k),
        (r - k, b - arm, k, arm),
    ] {
        push_rect(out, x, y, ww, hh, c);
    }
}

/// Top edge of the health bar for a box whose top edge is `t`.
pub fn bar_top(t: f32) -> f32 {
    t - BAR_GAP - BAR_HEIGHT
}

/// A thin segmented health bar above the box (l, t, w): a dark frame, then one
/// rect per segment, lit in the health colour or dark when lost.
pub fn push_health_bar(l: f32, t: f32, w: f32, frac: f32, out: &mut Vec<f32>) {
    let y = bar_top(t);
    push_rect(out, l - 1.0, y - 1.0, w + 2.0, BAR_HEIGHT + 2.0, [0.0, 0.0, 0.0, 0.75]);
    let n = segment_count(w);
    let lit = filled_segments(frac, n);
    let pitch = w / n as f32;
    let col = health_color(frac);
    for k in 0..n {
        let c = if k < lit { [col[0], col[1], col[2], 1.0] } else { [0.18, 0.18, 0.18, 0.9] };
        // One pixel gap between segments, none after the last.
        let sw = if k + 1 == n { pitch } else { pitch - 1.0 };
        push_rect(out, l + k as f32 * pitch, y, sw.max(0.5), BAR_HEIGHT, c);
    }
}

/// Number of rects `push_health_bar` writes for a bar `w` wide.
pub fn health_bar_rect_count(w: f32) -> usize {
    1 + segment_count(w)
}

impl World {
    /// Centre and size (world pixels) of actor `i`'s selection box at
    /// `alpha`, raised by its altitude like the sprite (what the render
    /// records of `selection_anchor` evaluate to; the tests check against it).
    #[cfg(test)]
    pub(crate) fn selection_box(&self, i: usize, alpha: f32) -> (f32, f32, f32, f32) {
        let (anchor, w, h) = self.selection_anchor(i);
        let (x, y) = anchor.at(alpha);
        (x, y, w, h)
    }

    /// Actor `i`'s selection box as its centre at the previous and current
    /// tick (raised by its altitude) and its size (instances.rs).
    pub(crate) fn selection_anchor(&self, i: usize) -> (Anchor, f32, f32) {
        let a = &self.actors[i];
        let info = &self.rules.actors[a.ty as usize];
        if a.kind == Kind::Building {
            let b = info.building.as_ref().unwrap();
            return (Anchor::fixed(px(a.x), px(a.y)), b.width as f32 * 24.0, b.height as f32 * 24.0);
        }
        let Some(u) = info.unit.as_ref() else {
            // Mines: a small box on their cell.
            return (Anchor::fixed(px(a.x), px(a.y)), MINE_BOX, MINE_BOX);
        };
        let s = unit_box_size(u.radius);
        let lift = px(a.altitude);
        (Anchor { from: [px(a.px), px(a.py) - lift], to: [px(a.x), px(a.y) - lift] }, s, s)
    }

    /// Health fraction of actor `i` in 0..=1.
    pub(crate) fn health_frac(&self, i: usize) -> f32 {
        let a = &self.actors[i];
        let max = self.rules.actors[a.ty as usize].hp.max(1);
        (a.hp as f32 / max as f32).clamp(0.0, 1.0)
    }

    fn shows_overlay_to(&self, i: usize, player: u8) -> bool {
        let a = &self.actors[i];
        a.alive
            && a.in_world()
            && !a.air.parachute
            && (a.owner == player || (self.is_visible_to(i, player) && !self.is_cloaked_from(i, player)))
    }

    /// Health bars of actors that are not selected, each drawn once: what the
    /// selected own actors attack (OpenRA shows target health), the actor
    /// under the mouse and, by the player's setting, damaged or all visible
    /// ones. Only actors `player` can see; walls and mines get one only as a
    /// target or when hovered.
    pub(crate) fn render_status_bars(&self, player: u8, sink: &mut Sink, selected: &[u32], rects: &mut Vec<f32>) {
        let opts = &self.render_opts;
        // The selection draws its own bars (render.rs).
        let mut shown: Vec<usize> = selected.iter().filter_map(|&r| self.resolve(r)).collect();
        let mut rel: Vec<f32> = Vec::new();
        let mut bar = |i: usize, shown: &mut Vec<usize>, sink: &mut Sink| {
            if shown.contains(&i) || !self.shows_overlay_to(i, player) {
                return;
            }
            shown.push(i);
            let (anchor, w, h) = self.selection_anchor(i);
            // Culled around the box centre, by the box's longer side.
            if sink.visible(anchor.from, anchor.to, w.max(h)) {
                rel.clear();
                push_health_bar(-w / 2.0, -h / 2.0, w, self.health_frac(i), &mut rel);
                push_anchored_rects(sink, rects, &anchor, w.max(h), &rel);
            }
        };
        let targets: Vec<usize> = selected
            .iter()
            .filter_map(|&r| self.resolve(r))
            .filter(|&i| self.actors[i].owner == player && self.actors[i].in_world())
            .filter_map(|i| self.resolve(self.actors[i].target))
            .collect();
        for t in targets.into_iter().chain(self.resolve(opts.hover)) {
            bar(t, &mut shown, sink);
        }
        if opts.health_bars == HealthBars::Selected {
            return;
        }
        for i in 0..self.actors.len() {
            let a = &self.actors[i];
            let info = &self.rules.actors[a.ty as usize];
            if !a.alive || a.kind == Kind::Mine || info.is_wall() || (opts.health_bars == HealthBars::Damaged && a.hp >= info.hp) {
                continue;
            }
            bar(i, &mut shown, sink);
        }
    }

    /// The animated layer of a live building (sprite slot `2t + 1`, the shader
    /// picks the frame from the render clock), or its static frame while the
    /// owner is low on power and the building needs power.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn push_building_overlay(&self, i: usize, x: f32, y: f32, alpha: f32, flash: f32, sink: &mut Sink, out: &mut Vec<f32>) {
        let a = &self.actors[i];
        let Some(&still) = self.render_opts.building_overlays.get(a.ty as usize) else { return };
        if still == 0 {
            return;
        }
        let info = &self.rules.actors[a.ty as usize];
        let slot = a.ty as u32 * 2 + 1;
        let sprite = if still >= POSE_STRIDE && self.render_opts.poses {
            match self.building_pose(i) {
                // OpenRA shows the layer once the structure is built.
                (Pose::Make, _) => return,
                (Pose::Idle, _) => match self.door_age(i) {
                    Some(age) => posed(slot, Pose::Make, age),
                    None => posed(slot, Pose::Idle, 0),
                },
                (pose, _) => posed(slot, pose, 0),
            }
        } else if info.requires_power && self.players[a.owner as usize].low_power() {
            still as f32
        } else {
            slot as f32
        };
        sink.sprite(out, SpriteRec::at(x, y, 96.0).look(sprite, a.owner as f32, 1.0, alpha, flash));
    }

    /// Ticks since structure `i` produced a unit that is still near one of
    /// its exits (OpenRA WithProductionDoorOverlay opens the door for it), or
    /// None. The youngest such unit of the owner within two cells of an exit.
    pub(crate) fn door_age(&self, i: usize) -> Option<u32> {
        let a = &self.actors[i];
        let b = self.rules.actors[a.ty as usize].building.as_ref()?;
        let mut best: Option<u32> = None;
        for &(ex, ey) in &b.exits {
            for dy in -2..=2 {
                for dx in -2..=2 {
                    let (cx, cy) = (a.cx + ex + dx, a.cy + ey + dy);
                    if !self.map.contains(cx, cy) {
                        continue;
                    }
                    for &u in self.units_in_cell(self.map.idx(cx, cy)) {
                        let o = &self.actors[u as usize];
                        if !o.alive || o.owner != a.owner || o.born == 0 {
                            continue;
                        }
                        let age = self.tick.saturating_sub(o.born);
                        if age < MAX_POSE_AGE && best.is_none_or(|b| age < b) {
                            best = Some(age);
                        }
                    }
                }
            }
        }
        best
    }

    /// The static frame of a remembered (fogged) building's animated layer.
    pub(crate) fn push_ghost_overlay(&self, ty: u16, owner: u8, x: f32, y: f32, sink: &mut Sink, out: &mut Vec<f32>) {
        if let Some(&still) = self.render_opts.building_overlays.get(ty as usize) {
            if still != 0 {
                sink.sprite(out, SpriteRec::at(x, y, 96.0).look(still as f32, owner as f32, 1.0, 1.0, 0.0));
            }
        }
    }
}

/// Half the width of the rank chevron sprites (apps/game/js/art/veterancy.js).
pub const CHEVRON_HALF: f32 = 4.0;

/// Centre of a rank decoration: right of the health bar over the box centred
/// at (x, y) of size (w, h), so it never covers the bar or the unit.
pub fn chevron_position(x: f32, y: f32, w: f32, h: f32) -> (f32, f32) {
    let t = y - h / 2.0;
    (x + w / 2.0 + 1.5 + CHEVRON_HALF, bar_top(t) + BAR_HEIGHT / 2.0)
}

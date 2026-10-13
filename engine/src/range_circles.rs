//! Range circles (OpenRA RenderRangeCircle, RenderDetectionCircle,
//! RenderShroudCircle, RenderJammerCircle and WithRangeCircle, drawn by
//! RangeCircleAnnotationRenderable): around the selected actors of the viewer
//! and their allies (every combatant's for spectators), and while a structure
//! is placed, around the spot and around the viewer's and allies' actors with
//! a circle of the same group (IPlaceBuildingDecorationInfo).
//!
//! A circle is 32 straight dashes, each spanning three quarters of its 1/32
//! of the turn (facings 8i to 8i + 6), every dash a border line under a
//! coloured line (the rules' Width and BorderWidth, in line widths of the
//! shared line buffer: paths.rs `push_line`, shaders/line.wgsl draws them at a
//! fixed width on screen, so circles look the same at every zoom). Read only:
//! presentation, never part of the state hash.

use crate::math::{CELL, HALF_CELL};
use crate::paths::push_line;
use crate::render::px;
use crate::rules::{CircleKind, RangeCircleInfo};
use crate::world::World;

/// OpenRA RangeCircleAnnotationRenderable.RangeCircleSegments.
pub const CIRCLE_SEGMENTS: usize = 32;
/// Each dash spans facings 8i to 8i + 6 of 256 (RangeCircleStartRotations, EndRotations).
const DASH_FRACTION: f32 = 6.0 / 8.0;

/// The structure being placed: actor type and top-left cell.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Placing {
    pub ty: usize,
    pub cx: i32,
    pub cy: i32,
}

/// RGBA 0..=255 as the line buffer's 0..=1 colour.
fn rgba(c: [u8; 4]) -> [f32; 4] {
    c.map(|v| f32::from(v) / 255.0)
}

/// One dashed circle of `radius` world units around `center` (world pixels):
/// per dash the border, then the line (DrawRangeCircle).
pub fn push_circle(lines: &mut Vec<f32>, center: (f32, f32), radius: i32, c: &RangeCircleInfo) {
    let r = px(radius);
    let step = std::f32::consts::TAU / CIRCLE_SEGMENTS as f32;
    // OpenRA rotates WVec(radius, 0, 0) by the facing: counter-clockwise on screen.
    let at = |t: f32| (center.0 + r * t.cos(), center.1 - r * t.sin());
    let (border, color) = (rgba(c.border), rgba(c.color));
    for i in 0..CIRCLE_SEGMENTS {
        let t = i as f32 * step;
        let (a, b) = (at(t), at(t + step * DASH_FRACTION));
        if c.border_width > 0.0 {
            push_line(lines, a, b, border, c.border_width);
        }
        if c.width > 0.0 {
            push_line(lines, a, b, color, c.width);
        }
    }
}

impl World {
    /// Whether `player` sees the circles of `owner`'s actors (the owner's
    /// allies; spectators, numbers past the players, see every combatant's:
    /// OpenRA counts them allies of all but non-combatants).
    fn sees_circles_of(&self, owner: u8, player: u8) -> bool {
        if (player as usize) >= self.players.len() {
            return !self.players.get(owner as usize).is_none_or(|p| p.neutral);
        }
        self.are_allies(owner, player)
    }

    /// The radius actor `i` draws circle `c` with now, 0 for none: the
    /// longest weapon for RenderRangeCircle (AttackBase.GetMaximumRange), the
    /// rules' range for the others; WithRangeCircle with passenger
    /// conditions only with such a passenger inside.
    fn live_circle_range(&self, i: usize, c: &RangeCircleInfo) -> i32 {
        let info = &self.rules.actors[self.actors[i].ty as usize];
        if !c.passengers.is_empty()
            && !self.passengers(i).iter().any(|&p| c.passengers.contains(&self.rules.actors[self.actors[p].ty as usize].id))
        {
            return 0;
        }
        match c.kind {
            CircleKind::Range => info.max_range(&self.rules),
            _ => c.range,
        }
    }

    /// Where actor `i` is drawn (world pixels, `alpha` between ticks), raised by its altitude.
    fn circle_center(&self, i: usize, alpha: f32) -> (f32, f32) {
        let a = &self.actors[i];
        let lerp = |p: i32, n: i32| px(p) + (px(n) - px(p)) * alpha;
        (lerp(a.px, a.x), lerp(a.py, a.y) - px(a.altitude))
    }

    /// The circles of actor `i` that `pick` accepts, for `player`.
    fn push_actor_circles(&self, i: usize, player: u8, alpha: f32, pick: impl Fn(&RangeCircleInfo) -> bool, lines: &mut Vec<f32>) {
        let a = &self.actors[i];
        if !a.alive || !a.in_world() || !self.sees_circles_of(a.owner, player) {
            return;
        }
        for c in self.rules.actors[a.ty as usize].range_circles.iter().filter(|c| pick(c)) {
            let r = self.live_circle_range(i, c);
            if r > 0 {
                push_circle(lines, self.circle_center(i, alpha), r, c);
            }
        }
    }

    /// The range circles `player` sees this frame: those of the selected
    /// actors, then with `placing` the placed structure's and those of the
    /// same groups around other actors.
    pub fn build_range_circles(&self, player: u8, alpha: f32, selected: &[u32], placing: Option<Placing>, lines: &mut Vec<f32>) {
        for &r in selected {
            if let Some(i) = self.resolve(r) {
                self.push_actor_circles(i, player, alpha, |_| true, lines);
            }
        }
        let Some(p) = placing else { return };
        let Some(info) = self.rules.actors.get(p.ty) else { return };
        let Some(b) = info.building.as_ref() else { return };
        let center = (px(p.cx * CELL + b.width * HALF_CELL), px(p.cy * CELL + b.height * HALF_CELL));
        for c in info.range_circles.iter().filter(|c| c.placement) {
            // RenderRangeCircle: the longest weapon enabled by default, else FallbackRange.
            let r = match c.kind {
                CircleKind::Range => Some(info.max_range(&self.rules)).filter(|&r| r > 0).unwrap_or(c.range),
                _ => c.range,
            };
            // RenderRangeCircle shows nothing at all without a range.
            if c.kind == CircleKind::Range && r == 0 {
                continue;
            }
            // WithRangeCircle draws its own circle first, the others the other actors' first.
            if c.kind == CircleKind::Fixed && r > 0 {
                push_circle(lines, center, r, c);
            }
            // Other actors: the same RangeCircleType (RenderRangeCircle) or Type
            // (WithRangeCircle), every one (RenderShroudCircle, RenderJammerCircle).
            let same =
                |o: &RangeCircleInfo| o.kind == c.kind && (o.group == c.group || matches!(c.kind, CircleKind::Shroud | CircleKind::Jammer));
            for i in 0..self.actors.len() {
                self.push_actor_circles(i, player, alpha, same, lines);
            }
            if c.kind != CircleKind::Fixed && r > 0 {
                push_circle(lines, center, r, c);
            }
        }
    }
}

//! OpenRA style overlays on top of the battlefield: selection brackets in the
//! owner's colour, thin segmented health bars above them (for the selection,
//! the actor under the mouse and, by the player's choice, damaged or all
//! actors), and the animated layer of buildings (apps/game/js/art/anim.js).
//!
//! Everything here is presentation only: it reads the world and fills the
//! render buffers, the simulation never reads `RenderOptions`.

use crate::math::CELL;
use crate::render::{px, View};
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
    pub building_overlays: Vec<u32>,
}

impl Default for RenderOptions {
    fn default() -> RenderOptions {
        RenderOptions { hover: NONE, health_bars: HealthBars::Selected, building_overlays: Vec::new() }
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
    /// Centre and size (world pixels) of actor `i`'s selection box, raised by
    /// its altitude like the sprite.
    pub(crate) fn selection_box(&self, i: usize, alpha: f32) -> (f32, f32, f32, f32) {
        let a = &self.actors[i];
        let info = &self.rules.actors[a.ty as usize];
        if a.kind == Kind::Building {
            let b = info.building.as_ref().unwrap();
            return (px(a.x), px(a.y), b.width as f32 * 24.0, b.height as f32 * 24.0);
        }
        let r = info.unit.as_ref().map_or(CELL / 4, |u| u.radius);
        let s = unit_box_size(r);
        let x = px(a.px) + (px(a.x) - px(a.px)) * alpha;
        let y = px(a.py) + (px(a.y) - px(a.py)) * alpha - px(a.altitude);
        (x, y, s, s)
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

    /// Bracket and health bar of a selected actor; returns its box as (l, t, w, h).
    pub(crate) fn push_selection_overlay(&self, i: usize, alpha: f32, rects: &mut Vec<f32>) -> (f32, f32, f32, f32) {
        let (x, y, w, h) = self.selection_box(i, alpha);
        let (l, t) = (x - w / 2.0, y - h / 2.0);
        push_brackets(l, t, w, h, self.actors[i].owner, rects);
        push_health_bar(l, t, w, self.health_frac(i), rects);
        (l, t, w, h)
    }

    /// Health bars of actors that are not selected: the one under the mouse
    /// and, by the player's setting, damaged or all visible ones. Walls and
    /// mines never get one unless hovered.
    pub(crate) fn render_status_bars(&self, player: u8, alpha: f32, view: &View, selected: &[u32], rects: &mut Vec<f32>) {
        let opts = &self.render_opts;
        let is_selected = |i: usize| selected.iter().any(|&r| self.resolve(r) == Some(i));
        let mut bar = |i: usize| {
            let (x, y, w, h) = self.selection_box(i, alpha);
            if view.contains(x, y, w.max(h)) {
                push_health_bar(x - w / 2.0, y - h / 2.0, w, self.health_frac(i), rects);
            }
        };
        let hovered = self.resolve(opts.hover).filter(|&i| self.shows_overlay_to(i, player) && !is_selected(i));
        if let Some(i) = hovered {
            bar(i);
        }
        if opts.health_bars == HealthBars::Selected {
            return;
        }
        for i in 0..self.actors.len() {
            let a = &self.actors[i];
            if Some(i) == hovered || !a.alive || a.kind == Kind::Mine || self.rules.actors[a.ty as usize].is_wall() {
                continue;
            }
            if opts.health_bars == HealthBars::Damaged && a.hp >= self.rules.actors[a.ty as usize].hp {
                continue;
            }
            if self.shows_overlay_to(i, player) && !is_selected(i) {
                bar(i);
            }
        }
    }

    /// The animated layer of a live building (sprite slot `2t + 1`, the shader
    /// picks the frame from the render clock), or its static frame while the
    /// owner is low on power and the building needs power.
    pub(crate) fn push_building_overlay(&self, i: usize, x: f32, y: f32, alpha: f32, flash: f32, out: &mut Vec<f32>) {
        let a = &self.actors[i];
        let Some(&still) = self.render_opts.building_overlays.get(a.ty as usize) else { return };
        if still == 0 {
            return;
        }
        let info = &self.rules.actors[a.ty as usize];
        let stopped = info.requires_power && self.players[a.owner as usize].low_power();
        let sprite = if stopped { still as f32 } else { (a.ty * 2 + 1) as f32 };
        out.extend_from_slice(&[x, y, 0.0, sprite, a.owner as f32, 1.0, alpha, flash]);
    }

    /// The static frame of a remembered (fogged) building's animated layer.
    pub(crate) fn push_ghost_overlay(&self, ty: u16, owner: u8, x: f32, y: f32, out: &mut Vec<f32>) {
        if let Some(&still) = self.render_opts.building_overlays.get(ty as usize) {
            if still != 0 {
                out.extend_from_slice(&[x, y, 0.0, still as f32, owner as f32, 1.0, 1.0, 0.0]);
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

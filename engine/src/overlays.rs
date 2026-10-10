//! OpenRA style overlays on top of the battlefield: selection brackets in the
//! owner's colour, thin segmented health bars above them (for the selection,
//! the actor under the mouse and, by the player's choice, damaged or all
//! actors), and the animated layer of buildings (apps/game/js/art/anim.js).
//!
//! It also draws the control group number of selected actors (OpenRA
//! WithSpriteControlGroupDecoration, moved to the box's bottom right corner)
//! and the rally point of selected
//! production structures (OpenRA RallyPointIndicator).
//!
//! Everything here is presentation only: it reads the world and fills the
//! render buffers, the simulation never reads `RenderOptions`.

use crate::instances::{Anchor, Sink, SpriteRec};
use crate::paths::LINE_FLOATS;
use crate::render::{posed, push_anchored_rects, px, Pose, POSE_STRIDE};
use crate::rules::Kind;
use crate::world::{cell_center, World, NONE};

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
    /// War Factory roof and door, OpenRA WithProductionDoorOverlay): with
    /// `poses` on it is hidden while the structure is built and otherwise
    /// shows the door frame (doors.rs) as the age of the idle or damaged
    /// pose; the value itself is the layer's still sprite (fog), its age
    /// field the number of door frames.
    pub building_overlays: Vec<u32>,
    /// Sprite poses (render.rs `Pose`): body sprites carry what the actor is
    /// doing, for art with pre-rendered animations (original graphics,
    /// texture packs). Off by default: sprite ids are then the plain slots.
    pub poses: bool,
    /// The local player's control groups (apps/game/js/controlgroups.js):
    /// `(actor ref, group 0..=9)` sorted by ref, one entry per actor. Local
    /// UI state, set by the client and never part of the simulation.
    pub control_groups: Vec<(u32, u8)>,
    /// Sprite slots drawn from the original graphics (apps/game/js/content/atlas.js
    /// originalSlotInfo), sorted: those are drawn the OpenRA way (rotor
    /// sequences, effects that animate themselves, projectiles with their
    /// own facings). Empty with WebRA's art and texture packs.
    pub original_slots: Vec<u32>,
    /// Overlays drawn over units without a turret (OpenRA
    /// WithIdleOverlay@SPINNER): `(actor type, forward, side)` in world units.
    pub unit_overlays: Vec<(u16, i32, i32)>,
    /// Structures whose body shows the storage level (OpenRA
    /// WithResourceLevelSpriteBody): `(actor type, stages)`.
    pub level_stages: Vec<(u16, u32)>,
    /// The original damage smoke (fx.rs `smoke_frame`): milliseconds per
    /// frame, start frames, loop frames.
    pub smoke_frames: Option<(u32, u32, u32)>,
    /// The original tree fires (neutral.rs `fire_frame`), small, medium and
    /// large: milliseconds per frame, start, loop and end frames.
    pub fire_frames: [Option<(u32, u32, u32, u32)>; 3],
    /// Per actor type: its art has death sequences (with `poses`): dying
    /// soldiers show them instead of the built-in bodies (infantry_render.rs).
    pub death_art: Vec<bool>,
    /// Per actor type with death art: ticks its deaths play (die1..die6,
    /// crushed) and its longest idle animation (0: none), so a body stays
    /// until its sequence ended and an idle animation is not cut short.
    pub infantry_ticks: Vec<[u32; 8]>,
}

impl RenderOptions {
    /// `Game::set_death_art`: the types (of `n`) whose art has deaths, and
    /// eight lengths per type (die1..die6, crushed, longest idle animation).
    pub fn set_death_art(&mut self, n: usize, types: &[u32], ticks: &[u32]) {
        let mut art = vec![false; n];
        let mut lengths = vec![[0u32; 8]; n];
        for (k, &t) in types.iter().enumerate() {
            if let Some(v) = art.get_mut(t as usize) {
                *v = true;
                for (j, l) in lengths[t as usize].iter_mut().enumerate() {
                    // At most a minute: a body or an idle animation never lingers longer.
                    *l = ticks.get(k * 8 + j).copied().unwrap_or(0).min(1500);
                }
            }
        }
        self.death_art = art;
        self.infantry_ticks = lengths;
    }
}

impl Default for RenderOptions {
    fn default() -> RenderOptions {
        RenderOptions {
            hover: NONE,
            health_bars: HealthBars::Damaged,
            building_overlays: Vec::new(),
            poses: false,
            control_groups: Vec::new(),
            original_slots: Vec::new(),
            unit_overlays: Vec::new(),
            level_stages: Vec::new(),
            smoke_frames: None,
            fire_frames: [None; 3],
            death_art: Vec::new(),
            infantry_ticks: Vec::new(),
        }
    }
}

/// What `RenderOptions::set_original_art` reads from each record of its
/// `info` list (four integers each: kind, actor type, a, b).
pub const ORIGINAL_INFO_OVERLAY: i32 = 0;
pub const ORIGINAL_INFO_LEVEL: i32 = 1;
/// `[kind, milliseconds per frame, start frames, loop frames]` of the original damage smoke.
pub const ORIGINAL_INFO_SMOKE: i32 = 2;
/// `[kind, size, milliseconds per frame, start frames]` and
/// `[kind, size, loop frames, end frames]` of an original tree fire (size 0..=2).
pub const ORIGINAL_INFO_FIRE: i32 = 3;
pub const ORIGINAL_INFO_FIRE_TAIL: i32 = 4;
/// Integers per `info` record.
pub const ORIGINAL_INFO_STRIDE: usize = 4;

impl RenderOptions {
    /// Store the control groups: `refs[k]` is in group `groups[k]`. Pairs
    /// with a group above 9 are dropped, and an actor listed twice keeps
    /// its last group (an actor is in one group at a time, like OpenRA).
    pub fn set_control_groups(&mut self, refs: &[u32], groups: &[u8]) {
        let mut list: Vec<(u32, u8)> = refs.iter().copied().zip(groups.iter().copied()).filter(|&(r, g)| r != NONE && g <= 9).collect();
        // Stable sort, then keep the last entry of each ref.
        list.sort_by_key(|&(r, _)| r);
        let mut out: Vec<(u32, u8)> = Vec::with_capacity(list.len());
        for (r, g) in list {
            match out.last_mut() {
                Some(last) if last.0 == r => last.1 = g,
                _ => out.push((r, g)),
            }
        }
        self.control_groups = out;
    }

    /// Store what the original art needs (Game.set_original_slots): the
    /// slots drawn from it and `info` records `[kind, actor type, a, b]`:
    /// an overlay over a unit (`ORIGINAL_INFO_OVERLAY`, a forward, b side
    /// offset in world units) or a structure showing the storage level
    /// (`ORIGINAL_INFO_LEVEL`, a stages). Unknown kinds and a trailing
    /// partial record are ignored.
    pub fn set_original_art(&mut self, slots: &[u32], info: &[i32]) {
        let mut slots = slots.to_vec();
        slots.sort_unstable();
        slots.dedup();
        self.original_slots = slots;
        self.unit_overlays.clear();
        self.level_stages.clear();
        self.smoke_frames = None;
        self.fire_frames = [None; 3];
        let mut fire_heads = [None; 3];
        for r in info.as_chunks::<ORIGINAL_INFO_STRIDE>().0 {
            let size = usize::try_from(r[1]).ok().filter(|&s| s < 3);
            match (r[0], size) {
                (ORIGINAL_INFO_FIRE, Some(s)) if r[2] > 0 && r[3] >= 0 => fire_heads[s] = Some((r[2] as u32, r[3] as u32)),
                (ORIGINAL_INFO_FIRE_TAIL, Some(s)) if r[2] > 0 && r[3] >= 0 => {
                    if let Some((ms, start)) = fire_heads[s] {
                        self.fire_frames[s] = Some((ms, start, r[2] as u32, r[3] as u32));
                    }
                }
                _ => {}
            }
            let Ok(ty) = u16::try_from(r[1]) else { continue };
            match r[0] {
                ORIGINAL_INFO_OVERLAY => self.unit_overlays.push((ty, r[2], r[3])),
                ORIGINAL_INFO_LEVEL if r[2] > 0 => self.level_stages.push((ty, r[2] as u32)),
                ORIGINAL_INFO_SMOKE if r[1] > 0 && r[2] >= 0 && r[3] >= 0 => {
                    self.smoke_frames = Some((r[1] as u32, r[2] as u32, r[3] as u32))
                }
                _ => {}
            }
        }
    }

    /// Whether sprite slot `slot` is drawn from the original graphics.
    pub fn is_original(&self, slot: u32) -> bool {
        self.original_slots.binary_search(&slot).is_ok()
    }

    /// The forward and side offset of the overlay drawn over units of type `ty`, if any.
    pub fn unit_overlay(&self, ty: u16) -> Option<(i32, i32)> {
        self.unit_overlays.iter().find(|o| o.0 == ty).map(|o| (o.1, o.2))
    }

    /// The level stages of structures of type `ty`, if their body shows the storage level.
    pub fn level_stages(&self, ty: u16) -> Option<u32> {
        self.level_stages.iter().find(|o| o.0 == ty).map(|o| o.1)
    }

    /// The control group of actor ref `r`, if it is in one.
    pub fn control_group(&self, r: u32) -> Option<u8> {
        self.control_groups.binary_search_by_key(&r, |&(k, _)| k).ok().map(|k| self.control_groups[k].1)
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

/// Control group digits 0..=9 as 3x5 pixel glyphs, one row per entry, bit 2
/// the left column: small white numbers like the "groups" frames of Red
/// Alert's pips.shp that OpenRA draws (mods/ra/sequences/misc.yaml).
pub const GROUP_GLYPHS: [[u8; GROUP_GLYPH_H]; 10] = [
    [0b111, 0b101, 0b101, 0b101, 0b111],
    [0b010, 0b110, 0b010, 0b010, 0b111],
    [0b111, 0b001, 0b111, 0b100, 0b111],
    [0b111, 0b001, 0b011, 0b001, 0b111],
    [0b101, 0b101, 0b111, 0b001, 0b001],
    [0b111, 0b100, 0b111, 0b001, 0b111],
    [0b111, 0b100, 0b111, 0b101, 0b111],
    [0b111, 0b001, 0b010, 0b010, 0b010],
    [0b111, 0b101, 0b111, 0b101, 0b111],
    [0b111, 0b101, 0b111, 0b001, 0b111],
];
pub const GROUP_GLYPH_W: usize = 3;
pub const GROUP_GLYPH_H: usize = 5;
/// The digit's colour and the dark plate behind it (one pixel around the glyph).
pub const GROUP_COLOR: [f32; 4] = [1.0, 1.0, 1.0, 1.0];
pub const GROUP_PLATE: [f32; 4] = [0.0, 0.0, 0.0, 0.75];
/// Gap between the plate and the box's bottom and right edges. WebRA draws
/// the group in the box's bottom right corner (OpenRA's Red Alert uses the
/// top left): just inside the corner, left of the bracket's vertical arm and
/// above its horizontal one, clear of the health bar above the box and of
/// the cargo, ore and ammo pips below it.
pub const GROUP_INSET: (f32, f32) = (BRACKET_THICKNESS, BRACKET_THICKNESS);
/// Width and height of the dark plate (the glyph plus one pixel around it).
pub const GROUP_PLATE_SIZE: (f32, f32) = (GROUP_GLYPH_W as f32 + 2.0, GROUP_GLYPH_H as f32 + 2.0);

/// Top-left of the group number's plate for the box (l, t, w, h): in the
/// bottom right corner, `GROUP_INSET` inside the bracket arms.
pub fn group_plate_origin(l: f32, t: f32, w: f32, h: f32) -> (f32, f32) {
    (l + w - GROUP_INSET.0 - GROUP_PLATE_SIZE.0, t + h - GROUP_INSET.1 - GROUP_PLATE_SIZE.1)
}

/// Rects of control group `group`'s number in the bottom right corner of
/// the box (l, t, w, h): a dark plate, then one rect per horizontal run of
/// each glyph row.
pub fn push_group_number(l: f32, t: f32, w: f32, h: f32, group: u8, out: &mut Vec<f32>) {
    let Some(glyph) = GROUP_GLYPHS.get(group as usize) else { return };
    let (x, y) = group_plate_origin(l, t, w, h);
    push_rect(out, x, y, GROUP_PLATE_SIZE.0, GROUP_PLATE_SIZE.1, GROUP_PLATE);
    for (row, bits) in glyph.iter().enumerate() {
        let mut col = 0;
        while col < GROUP_GLYPH_W {
            let lit = |c: usize| bits & (1 << (GROUP_GLYPH_W - 1 - c)) != 0;
            if !lit(col) {
                col += 1;
                continue;
            }
            let start = col;
            while col < GROUP_GLYPH_W && lit(col) {
                col += 1;
            }
            push_rect(out, x + 1.0 + start as f32, y + 1.0 + row as f32, (col - start) as f32, 1.0, GROUP_COLOR);
        }
    }
}

/// Half the side of the square OpenRA marks each end of a rally line with
/// (TargetLineRenderable.DrawTargetMarker, size 1).
pub const RALLY_MARKER: f32 = 1.0;

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

    /// Whether `player` sees the rally point of structure `i` while it is
    /// selected: OpenRA's RallyPointIndicator shows it for the owner and
    /// allies (not for spectators, who have no player).
    pub(crate) fn shows_rally_to(&self, i: usize, player: u8) -> bool {
        let a = &self.actors[i];
        (player as usize) < self.players.len()
            && !self.render_all
            && !self.render_combined
            && a.kind == Kind::Building
            && a.rally.is_some()
            && a.in_world()
            && self.are_allies(a.owner, player)
    }

    /// Where structure `i`'s rally line starts and ends (world pixels): from
    /// the exit nearest the rally point (OpenRA NearestExitOrDefault; WebRA's
    /// units appear on the exit cell, so the line starts at its centre) or
    /// the structure's centre when it has no exits (helipads, airfields), to
    /// the rally point. None without a rally point.
    pub(crate) fn rally_line(&self, i: usize) -> Option<((f32, f32), (f32, f32))> {
        let a = &self.actors[i];
        let (rx, ry) = a.rally?;
        let b = self.rules.actors[a.ty as usize].building.as_ref()?;
        let from = b
            .exits
            .iter()
            .map(|&(ex, ey)| (cell_center(a.cx + ex), cell_center(a.cy + ey)))
            .min_by_key(|&(x, y)| crate::math::dist_sq(x, y, rx, ry))
            .unwrap_or((a.x, a.y));
        Some(((px(from.0), px(from.1)), (px(rx), px(ry))))
    }

    /// Rally lines of the selected structures `player` may see them of
    /// (`shows_rally_to`): one solid segment each in the owner's colour, as
    /// OpenRA's TargetLineRenderable (rally.wgsl takes the team colour like
    /// the rect shader). The flag and the end markers are sprites and rects
    /// of the render buffers (render.rs).
    pub fn build_rally_lines(&self, player: u8, selected: &[u32], lines: &mut Vec<f32>) {
        for &r in selected {
            let Some(i) = self.resolve(r) else { continue };
            if !self.shows_rally_to(i, player) {
                continue;
            }
            let Some((from, to)) = self.rally_line(i) else { continue };
            let c = team_color(self.actors[i].owner, 1.0, 1.0);
            lines.extend_from_slice(&[from.0, from.1, to.0, to.1, c[0], c[1], c[2], c[3]]);
        }
        debug_assert_eq!(lines.len() % LINE_FLOATS, 0);
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
            // Trees, barrels, husks and bridges have no selection decorations
            // (OpenRA: not Selectable); walls keep theirs.
            let info = &self.rules.actors[self.actors[i].ty as usize];
            if shown.contains(&i) || !self.shows_overlay_to(i, player) || (!info.world.selectable && !info.is_wall()) {
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
            // Anything damaged gets a bar (walls too); "all" adds undamaged
            // actors except wall pieces, which would cover every wall line.
            let damaged = a.hp < info.hp;
            if !a.alive || a.kind == Kind::Mine || (!damaged && (opts.health_bars == HealthBars::Damaged || info.is_wall())) {
                continue;
            }
            bar(i, &mut shown, sink);
        }
    }

    /// The animated layer of a live building (sprite slot `2t + 1`, the shader
    /// picks the frame from the render clock), or its static frame while the
    /// owner is low on power and the building needs power, or it is switched
    /// off with the power down button (repair.rs).
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn push_building_overlay(&self, i: usize, x: f32, y: f32, alpha: f32, flash: f32, sink: &mut Sink, out: &mut Vec<f32>) {
        let a = &self.actors[i];
        let Some(&still) = self.render_opts.building_overlays.get(a.ty as usize) else { return };
        if still == 0 {
            return;
        }
        let slot = a.ty as u32 * 2 + 1;
        let sprite = if still >= POSE_STRIDE && self.render_opts.poses {
            match self.building_pose(i) {
                // OpenRA shows the layer once the structure is built.
                (Pose::Make, _) => return,
                // The door frame, by damage state only: OpenRA's door is
                // never paused (no power condition), it follows the
                // damaged sequence (NormalizeSequence).
                (Pose::Damaged | Pose::DamagedStill, _) => posed(slot, Pose::Damaged, self.door_frame(i)),
                _ => posed(slot, Pose::Idle, self.door_frame(i)),
            }
        } else if self.is_powered_down(i) {
            // Low power or switched off with the power down button (repair.rs).
            still as f32
        } else {
            slot as f32
        };
        sink.sprite(out, SpriteRec::at(x, y, 96.0).look(sprite, a.owner as f32, 1.0, alpha, flash));
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

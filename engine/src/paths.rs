//! "Show unit paths" overlay: the planned route of selected own units as a
//! few line segments from the unit along its flow field to its goal.
//!
//! Lines: 8 floats each `[x0, y0, x1, y1, r, g, b, a]` in world pixels. A
//! route is cut into straight runs, so it has one segment per turn rather
//! than one per cell. Building it only reads the flow fields the units
//! already use (never computes one), so it cannot change the simulation.

use crate::flowfield::{DIRS, DIR_GOAL, DIR_NONE};
use crate::render::px;
use crate::rules::Domain;
use crate::world::{cell_center, Activity, HarvState, World, NONE};

pub const LINE_FLOATS: usize = 8;
/// Most segments drawn per unit; longer routes stop short.
pub const MAX_SEGMENTS: usize = 64;

const MOVE: [f32; 4] = [0.30, 1.0, 0.40, 0.75];
const ATTACK_MOVE: [f32; 4] = [1.0, 0.65, 0.20, 0.75];
const ATTACK: [f32; 4] = [1.0, 0.30, 0.25, 0.75];
const HARVEST: [f32; 4] = [0.95, 0.80, 0.30, 0.6];

impl World {
    /// Cell unit `i` is driving to right now and the line colour for it, or
    /// None when it is not on its way anywhere.
    fn path_target(&self, i: usize) -> Option<(u32, [f32; 4])> {
        let a = &self.actors[i];
        let target = match a.activity {
            Activity::Move if a.goal != NONE => (a.goal, if a.attack_move { ATTACK_MOVE } else { MOVE }),
            // Chasing a target that is out of range.
            Activity::Attack if a.goal != NONE && a.chase_cell != NONE => {
                let t = self.resolve(a.target)?;
                let range = self.rules.actors[a.ty as usize].weapons.iter().map(|&w| self.rules.weapons[w].range).max()?;
                if self.hit_distance(t, a.x, a.y) <= range {
                    return None;
                }
                (a.goal, ATTACK)
            }
            Activity::Harvest => match a.harv {
                HarvState::ToOre if a.harv_cell != NONE => (a.harv_cell, HARVEST),
                HarvState::ToDock => (self.dock_cell(self.resolve(a.refinery)?), HARVEST),
                _ => return None,
            },
            _ => return None,
        };
        Some(target)
    }

    /// Fill `lines` with the routes of the selected units `player` owns.
    /// `alpha` interpolates unit positions between ticks, as in `build_render`.
    pub fn build_paths(&self, player: u8, alpha: f32, selected: &[u32], lines: &mut Vec<f32>) {
        lines.clear();
        let w = self.map.width;
        let centre = |c: i32| px(cell_center(c));
        for &r in selected {
            let Some(i) = self.resolve(r) else { continue };
            let a = &self.actors[i];
            if a.owner != player || !a.is_unit() || !a.in_world() {
                continue;
            }
            let Some((goal, col)) = self.path_target(i) else { continue };
            let goal_pt = (centre(goal as i32 % w), centre(goal as i32 / w));
            let from = (px(a.px) + (px(a.x) - px(a.px)) * alpha, px(a.py) + (px(a.y) - px(a.py)) * alpha);
            let mut route = Route { from, col, segments: 0 };
            let unit = self.rules.actors[a.ty as usize].unit.as_ref().unwrap();
            let domain = self.rules.locomotors[unit.locomotor].domain;
            if domain == Domain::Air {
                route.to(goal_pt, lines);
                continue;
            }
            let pass = self.pass_of(i);
            // Only fields the unit already follows; none means nothing to show yet.
            let Some(dirs) = self.flow.peek(goal, unit.locomotor as u8, self.flow_crusher(i), pass.version) else { continue };
            let (mut cx, mut cy) = self.cell_of(a.x, a.y);
            let mut last = DIR_NONE;
            // A field never loops, so a route visits each cell at most once.
            for _ in 0..self.map.cells() {
                let d = dirs[(cy * w + cx) as usize];
                if d == DIR_GOAL {
                    route.to(goal_pt, lines);
                    break;
                }
                if d == DIR_NONE {
                    break;
                }
                // A turn: the straight run so far ends in this cell.
                if d != last && last != DIR_NONE && !route.to((centre(cx), centre(cy)), lines) {
                    break;
                }
                last = d;
                cx += DIRS[d as usize].0;
                cy += DIRS[d as usize].1;
            }
        }
    }
}

/// A route being written out as line segments.
struct Route {
    from: (f32, f32),
    col: [f32; 4],
    segments: usize,
}

impl Route {
    /// Add a segment to `to`. False once the route has its `MAX_SEGMENTS`.
    fn to(&mut self, to: (f32, f32), lines: &mut Vec<f32>) -> bool {
        if self.segments >= MAX_SEGMENTS {
            return false;
        }
        // A segment of length zero is a target marker (shaders/line.wgsl).
        if to == self.from {
            return true;
        }
        let c = self.col;
        lines.extend_from_slice(&[self.from.0, self.from.1, to.0, to.1, c[0], c[1], c[2], c[3]]);
        self.from = to;
        self.segments += 1;
        self.segments < MAX_SEGMENTS
    }
}

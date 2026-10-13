//! Target lines (OpenRA DrawLineToTarget and TargetLineRenderable): for the
//! selected units the client asks for, a line from the unit through the
//! targets of its current activity and its queued waypoints, in the colour
//! OpenRA gives that activity, with a marker at every target.
//!
//! When to show them is the client's (js/targetlines.js, OpenRA's
//! `TargetLines` setting: for 2.4 seconds after an order or a selection, or
//! while Shift is held); this module only says where they go. It reads the
//! world and never changes it, so it is not part of the state hash.
//!
//! Lines are the shared line buffer's segments (paths.rs `push_line`, world
//! pixels, width 1). A marker is a segment of length
//! zero, which shaders/line.wgsl draws as a small square (OpenRA's
//! DrawTargetMarker).

use crate::helicopter::HeliTask;
use crate::infantry::EnterKind;
use crate::paths::push_line;
use crate::plane::Phase;
use crate::render::px;
use crate::world::{cell_center, Activity, HarvState, World, NONE};

/// OpenRA's `Color` values (System.Drawing names) the target lines use, as
/// straight rgba in 0..1.
const fn rgb(r: u8, g: u8, b: u8) -> [f32; 4] {
    [r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0, 1.0]
}
/// Mobile, Aircraft, Passenger, DockClientManager, Repairable: moves, boarding, docking.
pub const GREEN: [f32; 4] = rgb(0, 128, 0);
/// AttackBase, Captures, Infiltrates, Demolition, Minelayer, Harvester (HarvestLineColor).
pub const CRIMSON: [f32; 4] = rgb(220, 20, 60);
/// AttackMove and Guard.
pub const ORANGE_RED: [f32; 4] = rgb(255, 69, 0);
/// InstantlyRepairs, RepairsBridges, DeliversCash.
pub const YELLOW: [f32; 4] = rgb(255, 255, 0);

/// Most targets drawn per unit (the activity's and the queued waypoints).
const MAX_NODES: usize = 1 + crate::world::MAX_WAYPOINTS;

impl World {
    /// The target line nodes of unit `i` (OpenRA Activity.TargetLineNodes over
    /// the current activity and the queued ones): target points in world
    /// units, each with its colour. Empty for an idle unit.
    pub fn target_line_nodes(&self, i: usize) -> Vec<((i32, i32), [f32; 4])> {
        let a = &self.actors[i];
        let mut out = Vec::new();
        if !a.alive || !a.is_unit() || !a.in_world() {
            return out;
        }
        let cell = |c: u32| (cell_center(c as i32 % self.map.width), cell_center(c as i32 / self.map.width));
        // An actor target where its owner last saw it (OpenRA: last visible target).
        let actor_at = |r: u32| -> Option<(i32, i32)> {
            let t = self.resolve(r)?;
            let b = &self.actors[t];
            if self.is_visible_to(t, a.owner) || self.are_allies(b.owner, a.owner) {
                Some((b.x, b.y))
            } else {
                a.target_seen
            }
        };
        // Aircraft flying to land or to resupply do that outside the activities.
        let air = match a.heli.task {
            HeliTask::Land => Some(((a.heli.land_x, a.heli.land_y), GREEN)),
            HeliTask::Resupply => actor_at(if a.heli.pad != NONE { a.heli.pad } else { a.air.base }).map(|p| (p, GREEN)),
            HeliTask::None if a.air.phase == Phase::Returning => actor_at(a.air.base).map(|p| (p, GREEN)),
            HeliTask::None => None,
        };
        let node = air.or_else(|| match a.activity {
            Activity::Idle | Activity::Unload => None,
            Activity::Move => (a.goal != NONE).then(|| (cell(a.goal), if a.attack_move { ORANGE_RED } else { GREEN })),
            Activity::Attack => actor_at(a.target).or(a.target_seen).map(|p| (p, CRIMSON)),
            Activity::AttackGround => Some((a.fire_at, CRIMSON)),
            Activity::Guard => actor_at(a.guard).map(|p| (p, ORANGE_RED)),
            Activity::Harvest => match a.harv {
                HarvState::ToOre | HarvState::Harvesting if a.harv_cell != NONE => Some((cell(a.harv_cell), CRIMSON)),
                HarvState::ToDock | HarvState::Unloading => actor_at(a.refinery).map(|p| (p, GREEN)),
                _ => None,
            },
            Activity::Repair => actor_at(a.depot).map(|p| (p, GREEN)),
            Activity::Board => actor_at(a.board_target).map(|p| (p, GREEN)),
            Activity::Enter => a.inf.enter.as_ref().and_then(|e| {
                let col = match e.kind {
                    EnterKind::Capture | EnterKind::Infiltrate | EnterKind::Demolish => CRIMSON,
                    EnterKind::InstantRepair | EnterKind::RepairBridge => YELLOW,
                };
                actor_at(e.target).map(|p| (p, col))
            }),
            Activity::Ability => match a.ab.task {
                crate::abilities::Task::LayMines if a.ab.mine_cell != NONE => Some((cell(a.ab.mine_cell), CRIMSON)),
                crate::abilities::Task::DeliverCash => actor_at(a.ab.target).map(|p| (p, YELLOW)),
                _ => None,
            },
        });
        // OpenRA: an idle actor shows no lines, queued moves included.
        if a.activity == Activity::Idle && node.is_none() {
            return out;
        }
        out.extend(node);
        for wp in &a.waypoints {
            if out.len() >= MAX_NODES {
                break;
            }
            out.push(((wp.x, wp.y), if wp.attack_move { ORANGE_RED } else { GREEN }));
        }
        out
    }

    /// Target lines of the units in `shown` that are selected and allied to
    /// `player` (OpenRA ShouldRender: `IsAlliedWith(LocalPlayer)`; spectators
    /// see none): from where the unit is drawn (`alpha` as in `build_render`)
    /// through its targets, a marker at each.
    pub fn build_target_lines(&self, player: u8, alpha: f32, selected: &[u32], shown: &[u32], lines: &mut Vec<f32>) {
        if player as usize >= self.players.len() {
            return;
        }
        for &r in shown {
            if !selected.contains(&r) {
                continue;
            }
            let Some(i) = self.resolve(r) else { continue };
            let a = &self.actors[i];
            if !self.are_allies(a.owner, player) {
                continue;
            }
            let lift = px(a.altitude);
            let mut from = (px(a.px) + (px(a.x) - px(a.px)) * alpha, px(a.py) + (px(a.y) - px(a.py)) * alpha - lift);
            for ((x, y), c) in self.target_line_nodes(i) {
                let to = (px(x), px(y));
                push_line(lines, from, to, c, 1.0);
                push_line(lines, to, to, c, 1.0);
                from = to;
            }
        }
    }
}

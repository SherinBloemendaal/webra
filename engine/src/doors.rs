//! Production doors (OpenRA WithProductionDoorOverlay, the War Factory's
//! roof and door): presentation only, like the audio event log. The
//! simulation never reads this state and it is not part of `state_hash`.
//!
//! OpenRA (OpenRA.Mods.Common/Traits/Render/WithProductionDoorOverlay.cs):
//! the door animation is played with `PlayFetchDirection`, one frame per
//! tick towards `desiredFrame`. `UnitProduced` remembers the new unit and
//! its exit cell and sets `desiredFrame` to the last frame (open); every
//! tick, once that unit is out of the world, out of the exit cell or done
//! leaving the factory, `desiredFrame` goes back to 0 (closed). So the door
//! is shut while the factory is idle or building, opens frame by frame when
//! a unit comes out, stays open while that unit is still in the exit cell
//! and closes frame by frame after it.
//!
//! WebRA places a produced unit on its exit cell and orders it on
//! (production.rs `spawn_produced`), so "done leaving" is the unit standing
//! idle there. The number of door frames belongs to the art: the client
//! puts it in the layer's entry of `RenderOptions::building_overlays`
//! (the age field of the still sprite id, docs/contracts.md section 8);
//! without door art the door never moves.

use crate::render::{POSE_CODES, POSE_STRIDE};
use crate::world::{Activity, World, NONE};

/// One factory whose door is open or still moving.
#[derive(Clone, Copy, Debug)]
struct Door {
    /// The factory (actor ref).
    building: u32,
    /// The unit it let out (actor ref), or NONE once that unit has left.
    unit: u32,
    /// The cell the unit came out on (OpenRA `openExit`).
    exit: (i32, i32),
    /// Door frame shown (OpenRA `door.CurrentFrame`): 0 shut.
    frame: u32,
}

#[derive(Clone, Debug, Default)]
pub struct Doors {
    doors: Vec<Door>,
}

impl Doors {
    /// No door open or moving.
    pub fn is_idle(&self) -> bool {
        self.doors.is_empty()
    }
}

/// Door frames of a layer entry of `RenderOptions::building_overlays`: the
/// age field of a pose-table layer's still sprite id, 0 for anything else.
pub fn door_frames_of(overlay: u32) -> u32 {
    if overlay < POSE_STRIDE {
        0
    } else {
        overlay / POSE_STRIDE / POSE_CODES
    }
}

impl World {
    /// Frames of the door of actor type `ty` in the current art (0: none).
    fn door_frames(&self, ty: u16) -> u32 {
        self.render_opts.building_overlays.get(ty as usize).map_or(0, |&v| door_frames_of(v))
    }

    /// Factory `b` produced unit `u` on the cell `u` stands on (OpenRA
    /// `INotifyProduction.UnitProduced`): the door opens for it. A later
    /// unit takes over from an earlier one still in the door.
    pub(crate) fn door_unit_produced(&mut self, b: usize, u: usize) {
        let building = self.make_ref(b);
        let unit = self.make_ref(u);
        let exit = self.cell_of(self.actors[u].x, self.actors[u].y);
        let doors = &mut self.doors.doors;
        match doors.iter_mut().find(|d| d.building == building) {
            Some(d) => {
                d.unit = unit;
                d.exit = exit;
            }
            None => doors.push(Door { building, unit, exit, frame: 0 }),
        }
    }

    /// One tick of every moving door: a frame towards open while its unit is
    /// in the door, towards shut otherwise (OpenRA's animation tick), then
    /// let the unit go once it has left (OpenRA `ITick.Tick`). Doors of dead
    /// factories and shut doors without a unit are forgotten.
    pub(crate) fn tick_doors(&mut self) {
        let mut doors = std::mem::take(&mut self.doors.doors);
        doors.retain_mut(|d| {
            let Some(b) = self.resolve(d.building) else { return false };
            let last = self.door_frames(self.actors[b].ty).saturating_sub(1);
            let desired = if d.unit == NONE { 0 } else { last };
            if d.frame < desired {
                d.frame += 1;
            } else if d.frame > desired {
                d.frame -= 1;
            }
            if d.unit != NONE && !self.still_in_door(d.unit, d.exit) {
                d.unit = NONE;
            }
            d.unit != NONE || d.frame > 0
        });
        self.doors.doors = doors;
    }

    /// Whether unit `r` is still coming out of the exit cell `exit`: alive,
    /// in the world, on that cell and not yet standing idle.
    fn still_in_door(&self, r: u32, exit: (i32, i32)) -> bool {
        let Some(u) = self.resolve(r) else { return false };
        let a = &self.actors[u];
        a.alive && a.in_world() && self.cell_of(a.x, a.y) == exit && a.activity != Activity::Idle
    }

    /// The door frame structure `i` shows: 0 shut, up to its door frames
    /// minus one when open.
    pub(crate) fn door_frame(&self, i: usize) -> u32 {
        let r = self.make_ref(i);
        let last = self.door_frames(self.actors[i].ty).saturating_sub(1);
        self.doors.doors.iter().find(|d| d.building == r).map_or(0, |d| d.frame.min(last))
    }
}

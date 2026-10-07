//! Ships and submarines: naval movement details, docking and repair at naval
//! yards, submerging, transports (LST).

use crate::world::World;

impl World {
    /// One tick of a ship. Until naval behaviour lands, ships use the shared activities.
    pub(crate) fn tick_ship(&mut self, i: usize) {
        self.tick_unit_activity(i);
    }
}

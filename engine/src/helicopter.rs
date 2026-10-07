//! Helicopters (Chinook, Black Hawk, Longbow, Hind): hovering flight, landing,
//! ammo and rearming at helipads, transport.

use crate::world::World;

impl World {
    /// One tick of a helicopter. Until helicopter behaviour lands, they use the shared activities.
    pub(crate) fn tick_helicopter(&mut self, i: usize) {
        self.tick_unit_activity(i);
    }
}

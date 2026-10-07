//! Fixed-wing aircraft (Yak, MiG, spy plane, bombers): flight, attack runs,
//! ammo and rearming at airfields, air support powers.

use crate::world::World;

impl World {
    /// One tick of a plane. Until plane behaviour lands, planes use the shared activities.
    pub(crate) fn tick_plane(&mut self, i: usize) {
        self.tick_unit_activity(i);
    }
}

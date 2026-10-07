//! Aircraft dispatch: helicopters (hover, VTOL) go to helicopter.rs, planes to plane.rs.

use crate::world::World;

impl World {
    pub(crate) fn is_helicopter(&self, i: usize) -> bool {
        let info = &self.rules.actors[self.actors[i].ty as usize];
        info.unit.as_ref().and_then(|u| u.aircraft.as_ref()).is_some_and(|a| a.can_hover)
    }

    pub(crate) fn tick_aircraft(&mut self, i: usize) {
        if self.is_helicopter(i) {
            self.tick_helicopter(i);
        } else {
            self.tick_plane(i);
        }
    }
}

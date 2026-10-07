//! Aircraft dispatch: helicopters (hover, VTOL) go to helicopter.rs, planes to plane.rs.

use crate::rules::Kind;
use crate::world::World;

impl World {
    pub(crate) fn is_helicopter(&self, i: usize) -> bool {
        let info = &self.rules.actors[self.actors[i].ty as usize];
        info.unit.as_ref().and_then(|u| u.aircraft.as_ref()).is_some_and(|a| a.can_hover)
    }

    /// Target class an actor counts as. Landed aircraft are ground targets
    /// (OpenRA: Targetable@GROUND while !airborne), so anti-air cannot hit
    /// them and ground weapons can.
    #[inline]
    pub(crate) fn target_kind(&self, i: usize) -> Kind {
        let a = &self.actors[i];
        if a.kind == Kind::Aircraft && a.altitude == 0 {
            Kind::Vehicle
        } else {
            a.kind
        }
    }

    pub(crate) fn tick_aircraft(&mut self, i: usize) {
        if self.is_helicopter(i) {
            self.tick_helicopter(i);
        } else {
            self.tick_plane(i);
        }
    }
}

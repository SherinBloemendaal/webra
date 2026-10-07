//! Unit abilities (mines, jammers, gap generators, cloaking, chrono tank, demolition
//! truck, MAD tank, supply truck, transports) and structure support powers
//! (Chronosphere, Iron Curtain, nuke, GPS).

use crate::world::World;

impl World {
    /// Per-unit ability upkeep, called every tick after the unit's activity.
    pub(crate) fn tick_abilities(&mut self, _i: usize) {}

    /// Per-player support power upkeep, called every tick.
    pub(crate) fn tick_powers(&mut self, _player: u8) {}
}

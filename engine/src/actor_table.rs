//! Actor table for a simulation that runs in a Web Worker (apps/game/js/sim):
//! the few facts the UI looks up synchronously for any actor id (owner,
//! kind, type, inside a transport or not), for every actor slot at once. The
//! worker sends it to the main thread after each tick, so selection, order
//! targeting and unit voices never wait for the worker.

use crate::rules::Kind;
use crate::world::NONE;
use crate::Game;
use wasm_bindgen::prelude::*;

/// u32 values per actor slot: `[ref, packed]`.
pub const ACTOR_TABLE_STRIDE: usize = 2;
/// `packed` flag: a structure.
pub const FLAG_BUILDING: u32 = 1;
/// `packed` flag: a structure that produces or repairs (rally points).
pub const FLAG_PRODUCER: u32 = 2;
/// `packed` flag: on the map (not inside a transport).
pub const FLAG_IN_WORLD: u32 = 4;
/// `packed` flag: a unit (not a structure or a mine).
pub const FLAG_UNIT: u32 = 8;

#[wasm_bindgen]
impl Game {
    /// Two u32 per actor slot: the actor's id (its `make_ref`, as every other
    /// method takes it) or 0xFFFFFFFF for a free slot, then
    /// `owner | flags << 8 | type << 16` (`type` indexes `rules_json().actors`,
    /// flags: 1 structure, 2 produces or repairs, 4 on the map, 8 unit).
    /// Read-only; the same facts `actor_json` reports.
    pub fn actor_table(&self) -> Vec<u32> {
        let w = &self.world;
        let mut out = Vec::with_capacity(w.actors.len() * ACTOR_TABLE_STRIDE);
        for (i, a) in w.actors.iter().enumerate() {
            if !a.alive {
                out.extend_from_slice(&[NONE, 0]);
                continue;
            }
            let info = &w.rules.actors[a.ty as usize];
            let mut flags = 0;
            if a.kind == Kind::Building {
                flags |= FLAG_BUILDING;
            }
            if info.building.as_ref().is_some_and(|b| !b.produces.is_empty() || b.repairs.is_some()) {
                flags |= FLAG_PRODUCER;
            }
            if a.in_world() {
                flags |= FLAG_IN_WORLD;
            }
            if a.is_unit() {
                flags |= FLAG_UNIT;
            }
            out.extend_from_slice(&[w.make_ref(i), u32::from(a.owner) | flags << 8 | (a.ty as u32) << 16]);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::World;

    #[test]
    fn actor_table_matches_actor_json() {
        let mut game = Game::wrap(World::new(7, 64, &[("england", false), ("russia", true)]));
        for _ in 0..3000 {
            game.tick();
        }
        let table = game.actor_table();
        let rules: serde_json::Value = serde_json::from_str(&game.rules_json()).unwrap();
        assert_eq!(table.len(), game.world.actors.len() * ACTOR_TABLE_STRIDE);
        let mut alive = 0;
        for slot in table.chunks(ACTOR_TABLE_STRIDE) {
            let (id, packed) = (slot[0], slot[1]);
            if id == NONE {
                continue;
            }
            alive += 1;
            let json: serde_json::Value = serde_json::from_str(&game.actor_json(id)).unwrap();
            assert_eq!(json["owner"].as_u64().unwrap() as u32, packed & 0xff);
            let flags = (packed >> 8) & 0xff;
            assert_eq!(json["building"].as_bool().unwrap(), flags & FLAG_BUILDING != 0);
            assert_eq!(json["producer"].as_bool().unwrap(), flags & FLAG_PRODUCER != 0);
            assert_eq!(json["carrier"].as_u64().unwrap() as u32 == NONE, flags & FLAG_IN_WORLD != 0);
            let ty = (packed >> 16) as usize;
            assert_eq!(json["type"], rules["actors"][ty]["id"]);
        }
        assert!(alive >= 4, "the bases are in the table ({alive})");
    }

    #[test]
    fn actor_table_marks_dead_slots_free() {
        let mut game = Game::wrap(World::new_stress(3, 400, 96));
        // Until the armies have met and units died (some 300 ticks).
        for _ in 0..1500 {
            game.tick();
            if game.world.actors.iter().filter(|a| !a.alive).count() >= 5 {
                break;
            }
        }
        let table = game.actor_table();
        let mut dead = 0;
        for (i, slot) in table.chunks(ACTOR_TABLE_STRIDE).enumerate() {
            let a = &game.world.actors[i];
            if a.alive {
                assert_eq!(slot[0], game.world.make_ref(i));
            } else {
                assert_eq!(slot[0], NONE);
                dead += 1;
            }
        }
        assert!(dead > 0 && dead < table.len() / ACTOR_TABLE_STRIDE, "{dead} dead slots");
    }
}

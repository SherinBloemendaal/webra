//! WebAssembly API for unit abilities (orders and UI queries). Positions are
//! world pixels, like the rest of the `Game` API.

use crate::math::CELL;
use crate::world::Order;
use crate::Game;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
impl Game {
    /// Minelayers mine every cell of the world-pixel rectangle (Ctrl + drag).
    pub fn order_lay_mines(&mut self, player: u8, ids: Vec<u32>, x0: f32, y0: f32, x1: f32, y1: f32) {
        let cell = |v: f32| crate::to_wu(v).div_euclid(CELL);
        self.submit(Order::LayMines { player, ids, x0: cell(x0), y0: cell(y0), x1: cell(x1), y1: cell(y1) });
    }

    /// Chrono tanks teleport to a world-pixel position.
    pub fn order_teleport(&mut self, player: u8, ids: Vec<u32>, x: f32, y: f32) {
        self.submit(Order::Teleport { player, ids, x: crate::to_wu(x), y: crate::to_wu(y) });
    }

    /// Whether at least one of the given own chrono tanks can teleport to (x, y) now.
    pub fn teleport_valid(&self, player: u8, ids: Vec<u32>, x: f32, y: f32) -> bool {
        let w = &self.world;
        let (cx, cy) = w.cell_of(crate::to_wu(x), crate::to_wu(y));
        ids.iter().filter_map(|&r| w.resolve(r)).any(|i| w.actors[i].owner == player && w.can_teleport(i, cx, cy))
    }

    /// Deploy-style ability of an own unit: 0 none, 1 deploys now (mine, MAD
    /// tank, demolition), 2 not now (no ammo, charging, deployed), 3 needs a
    /// target first (chrono tank teleport).
    pub fn ability_deploy_state(&self, player: u8, id: u32) -> u8 {
        let w = &self.world;
        match w.resolve(id) {
            Some(i) if w.actors[i].owner == player => w.ability_deploy_state(i).unwrap_or(0),
            _ => 0,
        }
    }

    /// Whether any of the given own units is a minelayer (enables Ctrl + drag minefields).
    pub fn has_minelayer(&self, player: u8, ids: Vec<u32>) -> bool {
        let w = &self.world;
        ids.iter()
            .filter_map(|&r| w.resolve(r))
            .any(|i| w.actors[i].owner == player && w.rules.actors[w.actors[i].ty as usize].abilities.minelayer.is_some())
    }
}

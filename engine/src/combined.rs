//! The spectator "All players" view (OpenRA ObserverCombinedView): what every
//! player sees together, with fog and remembered structures, instead of the
//! whole map without shroud (`observer::OBSERVER`). Render only, like the
//! other spectator view: `Game::build_render`, `build_render_records` and
//! `fog_ptr` take `COMBINED` as the player.
//!
//! The render paths read one player's vision, so for the length of a render
//! call slot 0's vision, explored cells, remembered structures and gap
//! generator shroud are swapped for everyone's together (any player sees a
//! cell, any player remembers a structure, a cell is shrouded only for all),
//! and swapped back afterwards. `render_combined` makes the decorations
//! follow the spectator rules (no owner-only ones, allied ones for all,
//! cloaked and submerged units shown). The simulation never sees any of it.

use crate::world::World;
use std::collections::BTreeMap;

/// Player index of the combined view for `Game::build_render` and `Game::fog_ptr`.
pub const COMBINED: u8 = 254;

impl World {
    /// The players whose vision the combined view joins: every non-neutral one.
    fn combined_players(&self) -> Vec<usize> {
        (0..self.players.len()).filter(|&p| !self.players[p].neutral).collect()
    }

    /// Fog bytes of the combined view: visible where any player sees, fogged
    /// where any player explored (and no gap generator hides it from all).
    pub fn combined_fog_bytes(&self, out: &mut Vec<u8>) {
        let players = self.combined_players();
        let mut one = Vec::new();
        out.clear();
        out.resize(self.map.cells(), 0);
        for p in players {
            self.fog_bytes(p as u8, &mut one);
            for (o, &v) in out.iter_mut().zip(one.iter()) {
                *o = (*o).max(v);
            }
        }
    }

    /// Run `f` (a render call for slot 0) with slot 0's vision replaced by
    /// all players' vision together; everything is restored afterwards.
    pub(crate) fn with_combined_view<R>(&mut self, f: impl FnOnce(&World) -> R) -> R {
        let players = self.combined_players();
        if self.players.is_empty() {
            return f(self);
        }
        let cells = self.map.cells();
        let mut visible = vec![0u8; cells];
        let mut explored = vec![0u8; cells];
        let mut ghosts = BTreeMap::new();
        for &p in &players {
            let pl = &self.players[p];
            for (v, &x) in visible.iter_mut().zip(pl.visible.iter()) {
                *v = (*v).max(x);
            }
            for (e, &x) in explored.iter_mut().zip(pl.explored.iter()) {
                *e = (*e).max(x);
            }
            for (&k, g) in &pl.ghosts {
                ghosts.entry(k).or_insert_with(|| g.clone());
            }
        }
        // A gap generator hides a cell only when it hides it from every player.
        let shroud = (!self.abil.gen_shroud.is_empty()).then(|| {
            let mut m = vec![1u8; cells];
            for &p in &players {
                match self.abil.gen_shroud.get(p) {
                    Some(g) => m.iter_mut().zip(g.iter()).for_each(|(c, &x)| *c &= x),
                    None => m.iter_mut().for_each(|c| *c = 0),
                }
            }
            m
        });
        let p0 = &mut self.players[0];
        std::mem::swap(&mut p0.visible, &mut visible);
        std::mem::swap(&mut p0.explored, &mut explored);
        std::mem::swap(&mut p0.ghosts, &mut ghosts);
        let mut shroud = shroud;
        if let (Some(m), Some(g0)) = (shroud.as_mut(), self.abil.gen_shroud.get_mut(0)) {
            std::mem::swap(g0, m);
        }
        self.render_combined = true;
        let r = f(self);
        self.render_combined = false;
        let p0 = &mut self.players[0];
        std::mem::swap(&mut p0.visible, &mut visible);
        std::mem::swap(&mut p0.explored, &mut explored);
        std::mem::swap(&mut p0.ghosts, &mut ghosts);
        if let (Some(m), Some(g0)) = (shroud.as_mut(), self.abil.gen_shroud.get_mut(0)) {
            std::mem::swap(g0, m);
        }
        r
    }
}

//! Radar minimap data (OpenRA `ProvidesRadar`, the RA radar widget and the
//! Mobile Radar Jammer).
//!
//! The radar works while the player owns a structure with `ProvidesRadar`
//! (the Radar Dome) that has power and is not jammed: an enemy jammer
//! (`ProximityExternalCondition@JAMMER`, condition `jammed`) within range of
//! the dome switches it off, like OpenRA's `RequiresCondition: !jammed && !disabled`.
//! While the radar works, enemy jammers also keep the actors around them off
//! the radar of their enemies.
//!
//! Everything here only reads the world: it is called by the client a few
//! times per second for one player and never touches simulation state, so
//! lockstep determinism is unaffected. It never reports what the player may
//! not see: enemy actors only when visible (not cloaked, not under gap
//! generator shroud), remembered enemy structures as ghosts, and no blips at
//! all while the radar is offline.

use crate::math::{dist_sq, CELL};
use crate::rules::Kind;
use crate::world::World;

/// Radar status of a player, as returned by [`World::radar_state`].
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum RadarState {
    /// No radar structure.
    None = 0,
    /// A powered, unjammed radar structure: the minimap shows the battlefield.
    Online = 1,
    /// Every powered radar structure is jammed by an enemy radar jammer.
    Jammed = 2,
    /// Radar structures exist but low power switched them off.
    LowPower = 3,
}

/// Ints per blip in [`World::minimap_blips`]: `[cell x, cell y, width, height, owner]`.
pub const BLIP_INTS: usize = 5;
/// Owner value of blips that belong to a neutral player.
pub const NEUTRAL_OWNER: i32 = 255;

/// An enemy radar jammer as seen by one player: position and range.
struct Jammer {
    x: i32,
    y: i32,
    range: i32,
}

impl World {
    /// Whether the player's radar works, and if not, why.
    pub fn radar_state(&self, player: u8) -> RadarState {
        if player as usize >= self.players.len() {
            return RadarState::None;
        }
        let jammers = self.enemy_jammers(player);
        let mut state = RadarState::None;
        for (i, a) in self.actors.iter().enumerate() {
            if !a.alive || a.owner != player || a.kind != Kind::Building {
                continue;
            }
            let Some(pr) = self.rules.actors[a.ty as usize].abilities.provides_radar.as_ref() else { continue };
            if self.is_powered_down(i) {
                if state == RadarState::None {
                    state = RadarState::LowPower;
                }
            } else if pr.jammable && Self::jammed_at(&jammers, a.x, a.y) {
                state = RadarState::Jammed;
            } else {
                return RadarState::Online;
            }
        }
        state
    }

    /// Radar jammers in the world that are not allied with `player` (OpenRA
    /// `ValidRelationships: Enemy, Neutral`). Passengers inside a transport do not jam.
    fn enemy_jammers(&self, player: u8) -> Vec<Jammer> {
        self.actors
            .iter()
            .filter(|a| a.alive && a.in_world() && !self.are_allies(a.owner, player))
            .filter_map(|a| {
                self.rules.actors[a.ty as usize].abilities.jams_radar.as_ref().map(|j| Jammer { x: a.x, y: a.y, range: j.range })
            })
            .collect()
    }

    fn jammed_at(jammers: &[Jammer], x: i32, y: i32) -> bool {
        jammers.iter().any(|j| dist_sq(j.x, j.y, x, y) <= j.range as i64 * j.range as i64)
    }

    /// Fill `out` with the radar blips `player` may see, [`BLIP_INTS`] ints
    /// each: structures (live and remembered) first, then units on top. Own and
    /// allied actors always show; enemy ones only when visible right now (or
    /// remembered, for structures) and not near an enemy radar jammer. Empty
    /// while the radar is offline.
    pub fn minimap_blips(&self, player: u8, out: &mut Vec<i32>) {
        out.clear();
        if self.radar_state(player) != RadarState::Online {
            return;
        }
        let jammers = self.enemy_jammers(player);
        let owner_of = |owner: u8| if self.players[owner as usize].neutral { NEUTRAL_OWNER } else { owner as i32 };
        // Whether an actor of `owner` at (x, y) may be shown to `player`, apart from visibility.
        let unjammed = |owner: u8, x: i32, y: i32| self.are_allies(owner, player) || !Self::jammed_at(&jammers, x, y);

        for (i, a) in self.actors.iter().enumerate() {
            if !a.alive || a.kind != Kind::Building {
                continue;
            }
            if !self.are_allies(a.owner, player) && (!self.is_visible_to(i, player) || self.is_cloaked_from(i, player)) {
                continue;
            }
            if !unjammed(a.owner, a.x, a.y) {
                continue;
            }
            let b = self.rules.actors[a.ty as usize].building.as_ref().unwrap();
            out.extend_from_slice(&[a.cx, a.cy, b.width, b.height, owner_of(a.owner)]);
        }
        // Enemy structures last seen under fog (the same ghosts the battlefield draws).
        for g in self.players[player as usize].ghosts.values() {
            if let Some(i) = self.resolve(g.actor) {
                if self.is_visible_to(i, player) && !self.is_cloaked_from(i, player) {
                    continue; // listed live above
                }
            }
            if self.gen_shrouded(player, self.map.idx(g.cx, g.cy)) {
                continue;
            }
            let b = self.rules.actors[g.ty as usize].building.as_ref().unwrap();
            let (x, y) = (g.cx * CELL + b.width * CELL / 2, g.cy * CELL + b.height * CELL / 2);
            if !unjammed(g.owner, x, y) {
                continue;
            }
            out.extend_from_slice(&[g.cx, g.cy, b.width, b.height, owner_of(g.owner)]);
        }
        for (i, a) in self.actors.iter().enumerate() {
            // Mines never show; passengers are inside their transport.
            if !a.alive || a.kind == Kind::Building || a.kind == Kind::Mine || !a.in_world() {
                continue;
            }
            if !self.are_allies(a.owner, player) && (!self.is_visible_to(i, player) || self.is_cloaked_from(i, player)) {
                continue;
            }
            // A disguised spy shows in its disguise's colour (OpenRA: the radar
            // colour follows the effective owner; infantry.rs).
            let shown = self.disguise_seen_by(i, player).map_or(a.owner, |d| d.owner);
            if !unjammed(shown, a.x, a.y) {
                continue;
            }
            let (cx, cy) = self.cell_of(a.x, a.y);
            out.extend_from_slice(&[cx, cy, 1, 1, owner_of(shown)]);
        }
    }
}

//! Map beacons (OpenRA `PlaceBeacon`, `Order::PlaceBeacon`): a player marks a
//! spot for their allies. Each player has one beacon at a time; a new one
//! replaces the old. It stays `PlayerRules::beacon_duration` ticks (Red Alert:
//! 750, half a minute) and only the owner and their allies see it, drawn over
//! the shroud with a bouncing arrow (render) and pinged on the radar with a
//! sound (the client, from `SoundEventKind::BeaconPlaced`).
//!
//! Beacons change nothing in the game itself; they are kept in the world so
//! every peer of a lockstep game shows the same ones, and stay out of
//! `World::state_hash`.

use crate::instances::{Anchor, Sink};
use crate::math::CELL;
use crate::overlays::team_color;
use crate::render::px;
use crate::sound_events::SoundEventKind;
use crate::world::World;

/// One player's beacon.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Beacon {
    pub owner: u8,
    /// World units, the centre of the clicked cell (OpenRA `Target.FromCell`).
    pub x: i32,
    pub y: i32,
    /// Tick it was placed and the first tick it is gone.
    pub placed: u32,
    pub expires: u32,
}

/// Every player's current beacon, in placing order.
#[derive(Clone, Default)]
pub struct Beacons {
    pub list: Vec<Beacon>,
}

/// Highest the beacon arrow bounces (OpenRA `Beacon.MaxArrowHeight` 5c0, in
/// world units) and its speed per tick (`arrowSpeed` 50).
pub const ARROW_MAX_HEIGHT: i32 = 5 * CELL;
pub const ARROW_SPEED: i32 = 50;
/// Ticks the ring under a new beacon spreads (the `circles` animation, played once).
pub const RING_TICKS: u32 = 20;

/// Height of the beacon arrow `age` ticks after placing (OpenRA `Beacon.Tick`:
/// up by `ARROW_SPEED` a tick, clamped to 0..`ARROW_MAX_HEIGHT`, turning round
/// at either end). Beacons live at most a few thousand ticks, so it is replayed.
pub fn arrow_height(age: u32) -> i32 {
    let (mut h, mut speed) = (0, ARROW_SPEED);
    for _ in 0..age.min(1 << 16) {
        h += speed;
        let clamped = h.clamp(0, ARROW_MAX_HEIGHT);
        if clamped != h {
            h = clamped;
            speed = -speed;
        }
    }
    h
}

impl World {
    /// `Order::PlaceBeacon`: put `player`'s beacon at the centre of the cell
    /// at (x, y), replacing their previous one.
    pub(crate) fn place_beacon(&mut self, player: u8, x: i32, y: i32) {
        if player as usize >= self.players.len() || self.players[player as usize].neutral {
            return;
        }
        if x < 0 || y < 0 || x >= self.map.width * CELL || y >= self.map.height * CELL {
            return;
        }
        let (cx, cy) = self.cell_of(x, y);
        let (x, y) = (crate::world::cell_center(cx), crate::world::cell_center(cy));
        let duration = self.rules.player.beacon_duration.max(1) as u32;
        self.beacons.list.retain(|b| b.owner != player);
        self.beacons.list.push(Beacon { owner: player, x, y, placed: self.tick, expires: self.tick + duration });
        self.sound.push(SoundEventKind::BeaconPlaced, 0, x, y, player, duration as i32);
    }

    /// Drop beacons whose time is up.
    pub(crate) fn tick_beacons(&mut self) {
        let tick = self.tick;
        self.beacons.list.retain(|b| b.expires > tick);
    }

    /// Beacons `player` sees: their own and their allies' (none in the
    /// spectator views: OpenRA shows them only to allies of the render player).
    pub fn visible_beacons(&self, player: u8) -> Vec<Beacon> {
        if self.render_all || self.render_combined || player as usize >= self.players.len() {
            return Vec::new();
        }
        self.beacons.list.iter().copied().filter(|b| b.expires > self.tick && self.are_allies(player, b.owner)).collect()
    }

    /// Beacons over everything else, the fog and shroud included (OpenRA
    /// `IEffectAboveShroud`), so rects: a ring spreading for a moment after
    /// placing (the `circles` animation) and the bouncing arrow in the owner's
    /// colour with a dark outline.
    pub(crate) fn render_beacons(&self, player: u8, sink: &mut Sink, rects: &mut Vec<f32>) {
        const OUTLINE: [f32; 4] = [0.05, 0.05, 0.05, 0.9];
        for b in self.visible_beacons(player) {
            let (x, y) = (px(b.x), px(b.y));
            let at = Anchor::fixed(x, y);
            let age = self.tick.saturating_sub(b.placed);
            if age < RING_TICKS {
                let t = age as f32 / RING_TICKS as f32;
                let r = 4.0 + 10.0 * t;
                let c = team_color(b.owner, 1.0, 0.9 * (1.0 - t));
                let w = 1.5;
                for (dx, dy, rw, rh) in [(-r, -r, 2.0 * r, w), (-r, r - w, 2.0 * r, w), (-r, -r, w, 2.0 * r), (r - w, -r, w, 2.0 * r)] {
                    sink.rect(rects, at.rect(64.0, dx, dy, rw, rh, c));
                }
            }
            // The arrow points down at the spot: a stem, then rows that narrow to the tip.
            let lift = px(arrow_height(age));
            let top = -lift - 16.0;
            let mut bars: Vec<(f32, f32, f32, f32)> = vec![(-1.0, top, 2.0, 7.0)];
            for (k, half) in [4.5f32, 3.5, 2.5, 1.5, 0.5].iter().enumerate() {
                bars.push((-half, top + 7.0 + k as f32, 2.0 * half, 1.0));
            }
            for &(dx, dy, w, h) in &bars {
                sink.rect(rects, at.rect(64.0, dx - 1.0, dy - 1.0, w + 2.0, h + 2.0, OUTLINE));
            }
            let c = team_color(b.owner, 1.0, 1.0);
            for &(dx, dy, w, h) in &bars {
                sink.rect(rects, at.rect(64.0, dx, dy, w, h, c));
            }
        }
    }
}

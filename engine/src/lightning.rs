//! Lightning strikes and the Lightning Rod (WebRA additions, no OpenRA
//! counterpart; docs/contracts.md "Biomes and weather").
//!
//! A thunderstorm (weather.rs) throws a strike every 4 to 12 s. The weather's
//! own random stream picks a random cell and two numbers for each strike, in
//! every weather mode; with `weather: full` the world resolves it here:
//!
//! 1. Power plants attract lightning: with a roll below
//!    [`PLANT_STRIKE_PERCENT`] the strike goes for a power plant (a structure
//!    that makes power: the Power Plant and the Advanced Power Plant), chosen
//!    among every player's plants that no Lightning Rod protects. Without one
//!    it falls on the random cell.
//! 2. A strike whose point lies within a Lightning Rod's range is grounded on
//!    the nearest such rod (the lowest actor index on a tie): nothing takes
//!    damage, the rod included. A rod protects everything around it, its
//!    owner's, allies' and enemies' alike, and needs no power.
//! 3. Otherwise the strike hits what stands on the struck cell: the
//!    structures covering it and the ground units on it (players' actors
//!    only; aircraft in the air, mines and the neutral world are not hit, nor
//!    is an actor whose own centre a rod protects). Each loses half of its
//!    current hit points (rounded down), so lightning never kills: it goes
//!    through the normal damage path without veterancy or handicap
//!    modifiers, and the Iron Curtain blocks it.
//! 4. A struck power plant also blacks out its owner's power: every power
//!    plant of that player stops producing for [`OUTAGE_TICKS`] (the spy's
//!    power outage, OpenRA PowerManager.TriggerPowerOutage: a running outage
//!    is only ever lengthened), so the low power effects follow (defences
//!    and radar go dark, production slows down) and the owner hears
//!    "Power plant struck by lightning".
//!
//! Everything here is simulation state (hit points and outages are in the
//! state hash); the flash's position and kind are presentation
//! (`Environment::flash`, the client's bolt and thunder) and the
//! `LightningStrike` sound events are write-only.

use crate::rules::Kind;
use crate::sound_events::SoundEventKind;
use crate::weather::{Strike, StrikeKind};
use crate::world::{World, TICKS_PER_SECOND};

/// Percent of the strikes that go for a power plant when one is unprotected.
pub const PLANT_STRIKE_PERCENT: i32 = 25;
/// Ticks a struck power plant blacks out its owner's power plants (15 s).
pub const OUTAGE_TICKS: i32 = 15 * TICKS_PER_SECOND as i32;

impl World {
    /// The Lightning Rods standing: (actor index, centre x, centre y, range).
    fn lightning_rods(&self) -> Vec<(usize, i32, i32, i32)> {
        let mut out = Vec::new();
        for (i, a) in self.actors.iter().enumerate() {
            if !a.alive || a.kind != Kind::Building || !a.in_world() {
                continue;
            }
            let range = self.rules.actors[a.ty as usize].building.as_ref().map_or(0, |b| b.lightning_rod);
            if range > 0 {
                out.push((i, a.x, a.y, range));
            }
        }
        out
    }

    /// The rod that grounds lightning at (x, y): the nearest one in range,
    /// the lowest actor index on a tie.
    fn grounding_rod(rods: &[(usize, i32, i32, i32)], x: i32, y: i32) -> Option<usize> {
        let d2 = |rx: i32, ry: i32| {
            let (dx, dy) = ((x - rx) as i64, (y - ry) as i64);
            dx * dx + dy * dy
        };
        rods.iter()
            .filter(|&&(_, rx, ry, r)| d2(rx, ry) <= (r as i64) * (r as i64))
            .min_by_key(|&&(i, rx, ry, _)| (d2(rx, ry), i))
            .map(|&(i, ..)| i)
    }

    /// Whether lightning at (x, y) is grounded on a Lightning Rod.
    pub fn lightning_protected(&self, x: i32, y: i32) -> bool {
        Self::grounding_rod(&self.lightning_rods(), x, y).is_some()
    }

    /// Whether actor `i` is a power plant lightning goes for: a player's
    /// structure that makes power.
    fn is_power_plant(&self, i: usize) -> bool {
        let a = &self.actors[i];
        a.kind == Kind::Building
            && self.rules.actors[a.ty as usize].building.as_ref().is_some_and(|b| b.power > 0)
            && self.players.get(a.owner as usize).is_some_and(|p| !p.neutral)
    }

    /// Whether lightning can hurt actor `i`: a player's living ground actor in
    /// the world with hit points left (not a mine, crate or husk).
    fn lightning_hurts(&self, i: usize) -> bool {
        let a = &self.actors[i];
        a.alive
            && a.in_world()
            && a.altitude == 0
            && a.hp > 0
            && matches!(a.kind, Kind::Building | Kind::Infantry | Kind::Vehicle | Kind::Ship | Kind::Aircraft)
            && self.players.get(a.owner as usize).is_some_and(|p| !p.neutral)
            && self.has_health(i)
    }

    /// Resolve this tick's strike (World::step, `weather: full` only) and
    /// move the flash onto what it struck.
    pub(crate) fn strike_lightning(&mut self, s: Strike) {
        let rods = self.lightning_rods();
        let protected = |x: i32, y: i32| Self::grounding_rod(&rods, x, y).is_some();
        let mut victims = Vec::new();
        let (mut x, mut y) = (s.x, s.y);
        if s.roll < PLANT_STRIKE_PERCENT {
            let plants: Vec<usize> = (0..self.actors.len())
                .filter(|&i| self.lightning_hurts(i) && self.is_power_plant(i) && !protected(self.actors[i].x, self.actors[i].y))
                .collect();
            if !plants.is_empty() {
                let p = plants[s.pick as usize % plants.len()];
                (x, y) = (self.actors[p].x, self.actors[p].y);
                victims.push(p);
            }
        }
        let kind = if let (true, Some(rod)) = (victims.is_empty(), Self::grounding_rod(&rods, x, y)) {
            let a = &self.actors[rod];
            (x, y) = (a.x, a.y);
            let (ty, owner) = (a.ty as i32, a.owner);
            self.sound.push(SoundEventKind::LightningStrike, ty, x, y, owner, StrikeKind::Rod as i32);
            StrikeKind::Rod
        } else {
            if victims.is_empty() {
                let cell = self.cell_of(x, y);
                victims = (0..self.actors.len())
                    .filter(|&i| {
                        let a = &self.actors[i];
                        self.lightning_hurts(i)
                            && !protected(a.x, a.y)
                            && if a.kind == Kind::Building { self.hit_distance(i, x, y) == 0 } else { self.cell_of(a.x, a.y) == cell }
                    })
                    .collect();
            }
            let mut kind = StrikeKind::Ground;
            for i in victims {
                let plant = self.is_power_plant(i);
                if !self.lightning_damage(i) {
                    continue;
                }
                let a = &self.actors[i];
                let (ty, ax, ay, owner) = (a.ty as i32, a.x, a.y, a.owner);
                let k = if plant { StrikeKind::PowerPlant } else { StrikeKind::Hit };
                if plant {
                    self.lightning_outage(owner);
                }
                kind = kind.max(k);
                self.sound.push(SoundEventKind::LightningStrike, ty, ax, ay, owner, k as i32);
            }
            kind
        };
        self.env.flash = Some((self.tick, x, y, kind));
    }

    /// Half of actor `i`'s current hit points, unless the Iron Curtain
    /// protects it. Whether it was hurt.
    fn lightning_damage(&mut self, i: usize) -> bool {
        let a = &self.actors[i];
        let dmg = a.hp / 2;
        if dmg <= 0 || a.invulnerable_until > self.tick {
            return false;
        }
        // No shooter: the strike counts as nobody's fire (no "under attack"
        // line, no kill credit, no retaliation).
        let source = self.observer.source.take();
        self.apply_damage(i, dmg, crate::world::NONE, 0);
        self.observer.source = source;
        true
    }

    /// `player`'s power plants stop producing for `OUTAGE_TICKS` (a longer
    /// running outage stays).
    fn lightning_outage(&mut self, player: u8) {
        let n = self.players.len();
        self.inf.outage.resize(n, (0, 0));
        if self.inf.outage[player as usize].0 < OUTAGE_TICKS {
            self.inf.outage[player as usize] = (OUTAGE_TICKS, OUTAGE_TICKS);
        }
    }
}

/// Ticks a lightning bolt stays on the map (presentation).
pub const BOLT_TICKS: u32 = 8;
/// Height (world pixels) the bolt comes down from.
const BOLT_HEIGHT: f32 = 320.0;
/// Segments of a bolt from the sky to the ground.
const BOLT_SEGMENTS: u32 = 12;

impl World {
    /// The latest lightning bolt as line segments (Game.build_lines): a
    /// jagged stroke from the sky down onto what the strike hit, a wide pale
    /// glow under a white core that fades out over `BOLT_TICKS`, plus a short
    /// fork. Shown where `player` has explored the ground (spectators see
    /// all). Presentation only: the jitter comes from the flash itself, never
    /// from the simulation's random streams.
    pub fn build_lightning_bolt(&self, player: u8, alpha: f32, lines: &mut Vec<f32>) {
        let Some((t, x, y, _)) = self.env.flash else { return };
        let age = self.tick.saturating_sub(t) as f32 + alpha;
        if self.tick < t || age >= BOLT_TICKS as f32 {
            return;
        }
        if let Some(p) = self.players.get(player as usize) {
            let (cx, cy) = self.cell_of(x, y);
            if p.explored.get(self.map.idx(cx, cy)).is_none_or(|&e| e == 0) {
                return;
            }
        }
        let fade = 1.0 - age / BOLT_TICKS as f32;
        let (gx, gy) = (crate::render::px(x), crate::render::px(y));
        // A small hash of the flash: the same bolt every frame of one strike.
        let mut seed = t.wrapping_mul(0x9e37_79b9) ^ (x as u32).wrapping_mul(0x85eb_ca6b) ^ (y as u32).wrapping_mul(0xc2b2_ae35);
        let mut jitter = move || {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            (seed % 1000) as f32 / 1000.0 - 0.5
        };
        let mut points = Vec::with_capacity(BOLT_SEGMENTS as usize + 1);
        for k in 0..=BOLT_SEGMENTS {
            let f = k as f32 / BOLT_SEGMENTS as f32;
            // Wide at the top, onto the point at the bottom.
            let dx = if k == BOLT_SEGMENTS { 0.0 } else { jitter() * 28.0 * (1.0 - f * 0.7) };
            points.push((gx + dx, gy - BOLT_HEIGHT * (1.0 - f)));
        }
        let glow = [0.62, 0.74, 1.0, 0.45 * fade];
        let core = [1.0, 1.0, 1.0, 0.95 * fade];
        for (color, width) in [(glow, 6.0), (core, 2.0)] {
            for w in points.windows(2) {
                crate::paths::push_line(lines, w[0], w[1], color, width);
            }
        }
        // A fork from a third of the way down.
        let (fx, fy) = points[BOLT_SEGMENTS as usize / 3];
        let side = if jitter() < 0.0 { -1.0 } else { 1.0 };
        let mut prev = (fx, fy);
        for k in 1..=3 {
            let next = (prev.0 + side * (10.0 + jitter() * 6.0), prev.1 + 18.0 + jitter() * 6.0);
            crate::paths::push_line(lines, prev, next, [core[0], core[1], core[2], core[3] * 0.6 / k as f32], 1.0);
            prev = next;
        }
    }
}

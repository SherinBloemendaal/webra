//! Warheads that change no health (OpenRA LeaveSmudge, DestroyResource,
//! CreateResource, ShakeScreen and FlashEffect warheads; ShakeOnDeath).
//!
//! - Smudges: scorch marks and craters on the ground (OpenRA SmudgeLayer
//!   @SCORCH and @CRATER in world.yaml). Presentation only: never read by the
//!   simulation and not part of the state hash. A cell holds one smudge: a
//!   type, one of `SMUDGE_VARIANTS` images and a depth that grows with every
//!   hit (the frames of the image; the client clamps it to the frames it
//!   has). Variants and the `Chance` roll use a hash of the cell and the tick
//!   instead of OpenRA's local random, so a replay looks the same. Terrain
//!   that accepts smudges: clear and rough ground, ore and gems (the
//!   tilesets' AcceptsSmudgeType); a cell with an actor the warhead is not
//!   valid against keeps its ground clean. The client sees them through
//!   `Game::terrain_ptr` (the alpha byte), revealed only where its player
//!   can see (lib.rs `sync_smudges`), like OpenRA's frozen smudges.
//! - DestroyResource and CreateResource change ore and gems: gameplay, in
//!   the state hash (the map's ore and gems are).
//! - ShakeScreen and FlashEffect are sound events for the client's camera
//!   (presentation; `prefers-reduced-motion` turns them down there).

use crate::husks::{LEFTOVER_FIRE, LEFTOVER_SMOKE};
use crate::map::Terrain;
use crate::rules_options::{EffectKind, WarheadEffect, RESOURCE_GEMS, RESOURCE_ORE, SMUDGE_CRATER, SMUDGE_SCORCH};
use crate::sound_events::SoundEventKind;
use crate::world::{cell_center, World, NONE};

/// SmudgeLayer@SCORCH and @CRATER (world.yaml): SmokeChance and MaxSmokeOffsetDistance.
const SMOKE_CHANCE_SCORCH: i32 = 50;
const SMOKE_OFFSET_SCORCH: i32 = 341;
const SMOKE_CHANCE_CRATER: i32 = 25;
const SMOKE_OFFSET_CRATER: i32 = 213;

/// No smudge on a cell.
pub const NO_SMUDGE: u8 = 255;
/// Images per smudge type (OpenRA sequences scorches sc1..sc6, craters cr1..cr6).
pub const SMUDGE_VARIANTS: u8 = 6;
/// Deepest level a smudge records (3 bits).
pub const MAX_SMUDGE_DEPTH: u8 = 7;
/// Flash types of the FlashEffect warhead (sound event `b`).
pub const FLASH_NUKE: i32 = 1;
/// OpenRA WarheadInfo.AirThreshold: above this height an impact leaves no smudge.
const AIR_THRESHOLD: i32 = 128;

/// Encoded smudge byte: bit 6 crater (else scorch), bits 3..5 the variant, bits 0..2 the depth.
pub fn encode(crater: bool, variant: u8, depth: u8) -> u8 {
    (u8::from(crater) << 6) | ((variant % SMUDGE_VARIANTS) << 3) | depth.min(MAX_SMUDGE_DEPTH)
}

/// Smudges of every cell (`NO_SMUDGE` or `encode`d).
#[derive(Clone, Default)]
pub struct Smudges {
    pub cells: Vec<u8>,
    /// A smudge changed since the client last looked (lib.rs `sync_smudges`).
    pub changed: bool,
}

impl Smudges {
    pub fn new(cells: usize) -> Smudges {
        Smudges { cells: vec![NO_SMUDGE; cells], changed: false }
    }
}

/// A small hash for presentation choices (variant, chance), stable across peers and replays.
fn mix(a: u32, b: u32) -> u32 {
    let mut h = a.wrapping_mul(0x9E37_79B1) ^ b.wrapping_mul(0x85EB_CA6B);
    h ^= h >> 15;
    h = h.wrapping_mul(0x2C1B_3C6D);
    h ^ (h >> 12)
}

impl World {
    /// Apply warhead effect `k` of weapon `w` at (x, y) (combat.rs `apply_warhead`).
    pub(crate) fn apply_effect(&mut self, w: usize, k: usize, x: i32, y: i32, altitude: i32) {
        let Some(e) = self.rules.weapons[w].effects.get(k).cloned() else { return };
        match e.kind {
            EffectKind::Smudge => self.leave_smudge(&e, x, y, altitude, k as u32),
            EffectKind::DestroyResource => self.destroy_resource(&e, x, y, altitude),
            EffectKind::CreateResource => self.create_resource(&e, x, y, altitude),
            EffectKind::Shake => {
                let packed = (e.multiplier.0.clamp(0, 15) + 16 * e.multiplier.1.clamp(0, 15)) as u8;
                self.sound.push(SoundEventKind::ScreenShake, e.duration, x, y, packed, e.intensity);
            }
            EffectKind::Flash => {
                let ty = if e.flash_type == "Nuke" { FLASH_NUKE } else { 0 };
                self.sound.push(SoundEventKind::Flash, e.duration, x, y, 0, ty);
            }
        }
    }

    /// Cells of an effect's annulus around the cell of (x, y).
    fn effect_cells(&self, e: &WarheadEffect, x: i32, y: i32) -> Vec<usize> {
        let c = self.cell_of(x, y);
        self.cells_in_annulus(c, e.inner, e.outer).into_iter().map(|(cx, cy)| self.map.idx(cx, cy)).collect()
    }

    /// OpenRA LeaveSmudgeWarhead.DoImpact (presentation only).
    fn leave_smudge(&mut self, e: &WarheadEffect, x: i32, y: i32, altitude: i32, salt: u32) {
        if altitude > AIR_THRESHOLD {
            return;
        }
        let (cx, cy) = self.cell_of(x, y);
        let roll = mix(self.tick ^ salt.wrapping_mul(31), self.map.idx(cx, cy) as u32) % 100;
        if e.chance < roll as i32 {
            return;
        }
        for ci in self.effect_cells(e, x, y) {
            // The tilesets' AcceptsSmudgeType is Crater, Scorch on every type
            // that takes one: the first the warhead names, craters first.
            let accepts = matches!(self.map.terrain[ci], Terrain::Clear | Terrain::Rough);
            if !accepts {
                continue;
            }
            let crater = e.smudge_types & SMUDGE_CRATER != 0;
            if !crater && e.smudge_types & SMUDGE_SCORCH == 0 {
                continue;
            }
            // Any actor here the warhead is not valid against keeps the ground clean.
            let blocked =
                self.units_in_cell(ci).iter().any(|&u| !crate::rules::class_accepts(e.valid, e.invalid, self.target_class(u as usize)))
                    || (self.building_at[ci] != NONE && !crate::rules::class_accepts(e.valid, e.invalid, crate::rules::TARGET_STRUCTURE));
            if blocked {
                continue;
            }
            self.add_smudge(ci, crater);
        }
    }

    /// OpenRA SmudgeLayer.AddSmudge: a new smudge of a random image, or the
    /// one there one level deeper.
    fn add_smudge(&mut self, ci: usize, crater: bool) {
        let cur = self.smudges.cells[ci];
        let next = if cur == NO_SMUDGE || ((cur >> 6) & 1 == 1) != crater {
            let variant = (mix(ci as u32, self.tick.wrapping_add(0x5bd1)) % SMUDGE_VARIANTS as u32) as u8;
            encode(crater, variant, 0)
        } else {
            encode(crater, (cur >> 3) & 7, (cur & 7) + 1)
        };
        if next != cur {
            self.smudges.cells[ci] = next;
            self.smudges.changed = true;
        }
        // SmudgeLayer smoke: SmokeChance percent, MaxSmokeOffsetDistance around
        // the centre (scorches burn, craters smoke). Presentation.
        let h = mix(ci as u32 ^ 0xA5A5, self.tick);
        let (chance, reach, kind) = if crater {
            (SMOKE_CHANCE_CRATER, SMOKE_OFFSET_CRATER, LEFTOVER_SMOKE)
        } else {
            (SMOKE_CHANCE_SCORCH, SMOKE_OFFSET_SCORCH, LEFTOVER_FIRE)
        };
        if (h % 100) as i32 <= chance {
            let off = |v: u32| (v % (2 * reach as u32 + 1)) as i32 - reach;
            let w = self.map.width as usize;
            let (x, y) = (cell_center((ci % w) as i32) + off(h >> 8), cell_center((ci / w) as i32) + off(h >> 20));
            self.effects.push(crate::husks::leftover_effect(kind, x, y));
        }
    }

    /// OpenRA DestroyResourceWarhead: ore and gems in the cells are cleared
    /// (or lose ResourceAmount bales).
    fn destroy_resource(&mut self, e: &WarheadEffect, x: i32, y: i32, altitude: i32) {
        if altitude > AIR_THRESHOLD {
            return;
        }
        let all = e.resources == 0;
        let mut changed = false;
        for ci in self.effect_cells(e, x, y) {
            for (bit, cell) in [(RESOURCE_ORE, &mut self.map.ore[ci]), (RESOURCE_GEMS, &mut self.map.gems[ci])] {
                if *cell == 0 || !(all || e.resources & bit != 0) {
                    continue;
                }
                *cell = if e.amount <= 0 { 0 } else { cell.saturating_sub(e.amount.min(255) as u8) };
                changed = true;
            }
        }
        if changed {
            self.terrain_dirty = true;
        }
    }

    /// OpenRA CreateResourceWarhead: each cell that can take the resource
    /// gets a random 1 .. (max density - density) bales more (an exploding
    /// ore truck spills its ore).
    fn create_resource(&mut self, e: &WarheadEffect, x: i32, y: i32, altitude: i32) {
        if altitude > AIR_THRESHOLD {
            return;
        }
        let gems = e.resources & RESOURCE_GEMS != 0;
        let max = if gems { self.rules.player.gem_max_density } else { self.rules.player.ore_max_density };
        let mut changed = false;
        for ci in self.effect_cells(e, x, y) {
            // ResourceLayer.CanAddResource: allowed terrain (clear ground), no
            // structure, no other resource, below the maximum density.
            let (mine, other) = if gems { (self.map.gems[ci], self.map.ore[ci]) } else { (self.map.ore[ci], self.map.gems[ci]) };
            if self.map.terrain[ci] != Terrain::Clear || self.building_at[ci] != NONE || other > 0 || mine >= max {
                continue;
            }
            let splash = self.rng.range(1, (max - mine) as i32) as u8;
            let cell = if gems { &mut self.map.gems[ci] } else { &mut self.map.ore[ci] };
            *cell = (*cell + splash).min(max);
            changed = true;
        }
        if changed {
            self.terrain_dirty = true;
        }
    }
}

//! Husks: the burning wrecks ground vehicles leave (OpenRA SpawnActorOnDeath,
//! HarvesterHuskModifier, ^Husk in defaults.yaml, mods/ra/rules/husks.yaml).
//!
//! A husk slides from where the vehicle died to its cell's centre (OpenRA
//! DragAndCrush) and crushes what its locomotor crushes there (infantry,
//! mines, crates), blocks the cell, burns down (ChangesHealth with a negative
//! step: 28000 hit points at 200 every 8 ticks, 45 seconds) and can be shot
//! with force-fire only. Its owner is the vehicle's, or the neutral player
//! when that owner had already lost (OpenRA's InternalOwner fallback); when
//! its owner loses, it goes to the neutral player (OwnerLostAction
//! ChangeOwner). Without a neutral player in the game (no crates, no neutral
//! map actors) it stays with the defeated owner, who no longer plays.
//!
//! Engineers and mechanics take a husk back (Capturable `husk`,
//! TransformOnCapture, InfiltrateForTransform): `husk_capture` and
//! `restore_husk` are the hooks the capturing infantry uses.
//!
//! Husks are not in the unit hash: `LeftoverCells` keeps the husk (and the
//! crate, crates.rs) of every cell.

use crate::instances::{Sink, SpriteRec};
use crate::math::{dist, CELL};
use crate::render::{posed, px, unit_shadow, Pose, SpriteIds, DISABLED_SHADE};
use crate::rules::Kind;
use crate::rules_options::HuskCapture;
use crate::world::{cell_center, World, NONE};

/// Special sprites of the leftovers art module (`SpriteIds::leftovers_base +`,
/// apps/game/js/art/leftovers.js `LEFTOVER_SPECIALS`, same order).
pub const LEFTOVER_FIRE: u8 = 0;
pub const LEFTOVER_SMOKE: u8 = 1;
pub const LEFTOVER_PRIMARY: u8 = 2;
/// Crate pickup animations (OpenRA crate-effects): level up, heal, map
/// hidden, map revealed, invulnerability.
pub const LEFTOVER_LEVELUP: u8 = 3;
pub const LEFTOVER_HEAL: u8 = 4;
pub const LEFTOVER_HIDE_MAP: u8 = 5;
pub const LEFTOVER_REVEAL_MAP: u8 = 6;
pub const LEFTOVER_INVULN: u8 = 7;
/// Ticks a leftover effect is drawn, per special (the PRIMARY tag is no
/// effect). An original sequence played once must end within them
/// (apps/game/js/content/audit.js FX_LIMITS.leftovers): smoke_m idle has
/// 49 + 42 frames at one per tick; the crate pickup animations get the
/// explosions' time (fx.rs EXPLOSION_LIFE).
pub const LEFTOVER_EFFECT_TICKS: [i32; 8] = [40, 91, 0, 48, 48, 48, 48, 48];

/// A leftover effect `n` (LEFTOVER_*) at (x, y), for its LEFTOVER_EFFECT_TICKS.
pub fn leftover_effect(n: u8, x: i32, y: i32) -> crate::world::Effect {
    let ttl = LEFTOVER_EFFECT_TICKS[n as usize];
    crate::world::Effect { x, y, tx: x, ty: y, kind: crate::world::EffectKind::Leftover(n), ttl, max: ttl }
}

/// Per actor state of husks and crates.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Leftover {
    /// Husk: ticks until the next burn step; crate: ticks it has been in the world.
    pub ticks: i32,
    /// Husk sliding to its cell's centre: the end point and the ticks left.
    pub drag: (i32, i32),
    pub drag_ticks: i32,
}

/// The husk and the crate on each cell (actor references, or NONE).
#[derive(Clone, Default)]
pub struct LeftoverCells {
    pub husk: Vec<u32>,
    pub crates: Vec<u32>,
}

impl LeftoverCells {
    pub fn new(cells: usize) -> LeftoverCells {
        LeftoverCells { husk: vec![NONE; cells], crates: vec![NONE; cells] }
    }
}

impl World {
    /// The live husk on cell `ci`.
    pub fn husk_at(&self, ci: usize) -> Option<usize> {
        let r = *self.leftover_at.husk.get(ci)?;
        self.resolve(r).filter(|&h| self.actors[h].kind == Kind::Husk)
    }

    /// Called by `kill` for every actor that dies: a ground vehicle in the
    /// world leaves its husk (a fuller harvester its full husk; a Supply
    /// Truck its money crate, crates.rs).
    pub(crate) fn spawn_husk(&mut self, i: usize) {
        let a = &self.actors[i];
        if !a.in_world() || a.altitude > 0 || a.air.parachute {
            return;
        }
        let info = &self.rules.actors[a.ty as usize];
        let Some(mut husk) = info.options.spawn_on_death else { return };
        if self.rules.actors[husk].kind == Kind::Crate {
            let (cx, cy) = self.cell_of(a.x, a.y);
            let owner = a.owner;
            if self.crate_at(self.map.idx(cx, cy)).is_none() {
                self.place_crate(husk, owner, cx, cy, 0);
            }
            return;
        }
        if let Some((full, threshold)) = info.options.full_husk {
            let capacity = info.unit.as_ref().and_then(|u| u.harvester.as_ref()).map_or(0, |h| h.capacity);
            if capacity > 0 && a.bales * 100 / capacity >= threshold {
                husk = full;
            }
        }
        // Husk.AllowedTerrain (OpenRA CanExistInCell): no wreck where it cannot
        // lie, such as the river under a bridge that fell with the vehicle on it.
        let ci = self.cell_index(a.x, a.y);
        if let Some(h) = self.rules.actors[husk].options.husk.as_ref() {
            let names = crate::crates::terrain_names(self, ci);
            if !h.allowed_terrain.is_empty() && !h.allowed_terrain.iter().any(|t| names.contains(&t.as_str())) {
                return;
            }
        }
        // The speed it died at drags the wreck to its cell's centre (OpenRA HuskSpeedInit).
        let speed = info.unit.as_ref().map_or(0, |u| {
            let ci = self.cell_index(a.x, a.y);
            u.speed * self.rules.locomotors[u.locomotor].speeds[self.map.speed_class(ci)] / 100
        });
        let (x, y, facing, victim) = (a.x, a.y, a.facing, a.owner);
        let owner = if self.players[victim as usize].defeated { self.neutral_player().unwrap_or(victim) } else { victim };
        let h = self.place_husk(husk, owner, x, y, facing, speed);
        let ci = self.cell_index(self.actors[h].leftover.drag.0, self.actors[h].leftover.drag.1);
        self.husk_crush(h, ci);
    }

    /// A husk of type `ty` at (x, y) that slides to its cell's centre at
    /// `speed` (0: at once), blocking the cell (also for husks a map places).
    pub(crate) fn place_husk(&mut self, ty: usize, owner: u8, x: i32, y: i32, facing: i32, speed: i32) -> usize {
        let (cx, cy) = self.cell_of(x, y);
        let ci = self.map.idx(cx, cy);
        // One husk per cell: an older wreck there makes room.
        if let Some(old) = self.husk_at(ci) {
            self.remove(old);
            self.husk_cell_freed(old);
        }
        let h = self.spawn_unit(ty as u16, owner, x, y, facing);
        let end = (cell_center(cx), cell_center(cy));
        let distance = dist(x, y, end.0, end.1);
        self.actors[h].leftover =
            Leftover { ticks: 0, drag: end, drag_ticks: if speed > 0 && distance > 0 { distance / speed } else { 0 } };
        if self.actors[h].leftover.drag_ticks == 0 {
            let a = &mut self.actors[h];
            (a.x, a.y, a.px, a.py) = (end.0, end.1, end.0, end.1);
        }
        self.leftover_at.husk[ci] = self.make_ref(h);
        self.pass.set_blocked(ci, true);
        self.pass_water.set_blocked(ci, true);
        self.pass_landing.set_blocked(ci, true);
        if !self.placing_map_actors {
            self.pass.refresh(&self.map);
            self.pass_water.refresh(&self.map);
            self.pass_landing.refresh(&self.map);
        }
        h
    }

    /// OpenRA DragAndCrush (first run): what the husk's locomotor crushes in
    /// its cell is crushed: enemy infantry, mines, a crate.
    fn husk_crush(&mut self, h: usize, ci: usize) {
        let Some(info) = self.rules.actors[self.actors[h].ty as usize].options.husk.clone() else { return };
        let owner = self.actors[h].owner;
        if info.crushes_infantry {
            let victims: Vec<usize> = self
                .units_in_cell(ci)
                .iter()
                .map(|&u| u as usize)
                .filter(|&u| {
                    let a = &self.actors[u];
                    a.alive && a.kind == Kind::Infantry && a.altitude == 0 && !a.air.parachute && self.are_enemies(owner, a.owner)
                })
                .collect();
            let source = self.make_ref(h);
            for v in victims {
                if self.actors[v].alive {
                    self.award_kill(v, source);
                    self.with_damage_source(owner, |w| w.kill(v));
                }
            }
        }
        if info.crushes_mines {
            if let Some(m) = self.mine_at(ci) {
                self.kill(m);
            }
        }
        if info.crushes_crates {
            if let Some(c) = self.crate_at(ci) {
                self.collect_crate(c, h);
            }
        }
    }

    /// A husk left (burnt out, shot, sold off by a capture): free its cell.
    pub(crate) fn husk_cell_freed(&mut self, i: usize) {
        let a = &self.actors[i];
        let ci = self.cell_index(a.leftover.drag.0, a.leftover.drag.1);
        let me = crate::world::idx_ref(i, a.gen);
        if self.leftover_at.husk[ci] != me {
            return;
        }
        self.leftover_at.husk[ci] = NONE;
        // Terrain and structures (bridges and their huts lie over cells without claiming them).
        self.set_cell_passability(ci);
        self.pass.refresh(&self.map);
        self.pass_water.refresh(&self.map);
        self.pass_landing.refresh(&self.map);
    }

    /// Every tick: husks slide to their cell's centre and burn down.
    pub(crate) fn tick_husks(&mut self) {
        for i in 0..self.actors.len() {
            let a = &self.actors[i];
            if !a.alive || a.kind != Kind::Husk {
                continue;
            }
            let Some(h) = self.rules.actors[a.ty as usize].options.husk.as_ref() else { continue };
            let (step, delay, below) = (h.burn_step, h.burn_delay, h.burn_start_if_below);
            let max = self.rules.actors[a.ty as usize].hp;
            let a = &mut self.actors[i];
            let l = &mut a.leftover;
            if l.drag_ticks > 0 {
                a.x += (l.drag.0 - a.x) / l.drag_ticks;
                a.y += (l.drag.1 - a.y) / l.drag_ticks;
                l.drag_ticks -= 1;
            }
            // OpenRA ChangesHealth: below StartIfBelow percent, a step every Delay ticks.
            if a.hp as i64 * 100 >= below as i64 * max as i64 {
                continue;
            }
            l.ticks -= 1;
            if l.ticks > 0 {
                continue;
            }
            l.ticks = delay;
            a.hp = (a.hp as i64 + step as i64).min(max as i64) as i32;
            if a.hp <= 0 {
                self.kill(i);
            }
        }
    }

    /// How husk `i` can be taken back: by capture (`infiltrate` false: the
    /// Capturable types, e.g. `husk`) or by infiltration (true: the
    /// InfiltrateForTransform types, e.g. `Husk`). None for anything else.
    pub fn husk_capture(&self, i: usize, infiltrate: bool) -> Option<&HuskCapture> {
        let a = &self.actors[i];
        if !a.alive || a.kind != Kind::Husk {
            return None;
        }
        let h = self.rules.actors[a.ty as usize].options.husk.as_ref()?;
        if infiltrate {
            h.infiltrate.as_ref()
        } else {
            h.capturable.as_ref()
        }
    }

    /// OpenRA TransformOnCapture / InfiltrateForTransform: husk `i` becomes
    /// the vehicle it was for `player`, with ForceHealthPercentage of its
    /// health (or the husk's health ratio). Returns the new actor.
    pub fn restore_husk(&mut self, i: usize, player: u8, infiltrate: bool) -> Option<usize> {
        let c = self.husk_capture(i, infiltrate)?.clone();
        let a = &self.actors[i];
        let (x, y, facing) = (a.leftover.drag.0, a.leftover.drag.1, a.facing);
        let ratio = (a.hp as i64, self.rules.actors[a.ty as usize].hp as i64);
        self.remove(i);
        self.husk_cell_freed(i);
        let u = self.spawn_unit(c.transform_into as u16, player, x, y, facing);
        let max = self.rules.actors[c.transform_into].hp as i64;
        let hp = if c.force_health_percent > 0 { max * c.force_health_percent as i64 / 100 } else { max * ratio.0 / ratio.1.max(1) };
        self.actors[u].hp = hp.clamp(1, max) as i32;
        Some(u)
    }

    /// Hit distance of husk `i`: its radius around the centre.
    pub(crate) fn husk_hit_distance(&self, i: usize, x: i32, y: i32) -> i32 {
        let a = &self.actors[i];
        let r = self.rules.actors[a.ty as usize].options.husk.as_ref().map_or(CELL / 2, |h| h.radius);
        (dist(x, y, a.x, a.y) - r / 2).max(0)
    }

    /// Husks (dark wrecks with their fire, OpenRA WithColoredOverlay@IDISABLE
    /// and WithIdleOverlay@Burns) and crates (the land or the water image,
    /// slots 2t and 2t + 1) that `player` sees. Falling crates are drawn with
    /// the paratroopers (plane.rs `render_air_extras`).
    pub(crate) fn render_leftovers(&self, player: u8, sink: &mut Sink, ids: &SpriteIds, sprites: &mut Vec<f32>) {
        for (i, a) in self.actors.iter().enumerate() {
            if !a.alive || !matches!(a.kind, Kind::Husk | Kind::Crate) || a.air.parachute || !self.is_visible_to(i, player) {
                continue;
            }
            let (from, to) = ([px(a.px), px(a.py)], [px(a.x), px(a.y)]);
            let Some(at) = sink.group(from, to, 32.0) else { continue };
            if a.kind == Kind::Crate {
                let water = self.map.terrain[self.cell_index(a.x, a.y)].ship_passable();
                let slot = a.ty as u32 * 2 + u32::from(water);
                sink.sprite(sprites, at.look(slot as f32, a.owner as f32, 1.0, 1.0, 0.0));
                continue;
            }
            let slot = a.ty as u32 * 2;
            let body = if self.render_opts.poses { posed(slot, Pose::Idle, 0) } else { slot as f32 };
            let flash = (a.flash > 0) as i32 as f32;
            let r = at.facing(a.pfacing, 0);
            // A wreck of a 2D minimal vehicle keeps its vehicle's ground shadow (render.rs `unit_shadow`).
            if self.render_opts.casts_shadow(slot) {
                sink.sprite(sprites, unit_shadow(r, body, a.owner as f32, 1.0));
            }
            sink.sprite(sprites, r.look(body, a.owner as f32, 1.0, 1.0, flash));
            sink.sprite(sprites, r.look(body, a.owner as f32, 1.0, DISABLED_SHADE, -1.0));
            let fire = ids.leftovers_base + LEFTOVER_FIRE as f32;
            sink.sprite(sprites, SpriteRec::at(px(a.x), px(a.y), 32.0).look(fire, 0.0, 1.0, 1.0, 0.0).offset(0.0, -4.0));
        }
    }
}

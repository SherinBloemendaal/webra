//! Primary production structures (OpenRA PrimaryBuilding, ^PrimaryBuilding
//! in defaults.yaml: barracks, kennel, war factory, helipad, airfield, naval
//! yard and sub pen).
//!
//! The deploy command on an own production structure (the Deploy key, or a
//! click on the selected structure) makes it the primary one, or not any
//! more; making one primary drops that mark from the owner's other
//! structures that produce any of its production types. New units leave
//! the primary structure (production.rs `spawn_produced`), else the newest
//! other one that can make them and has a free exit, and get its faction. The client hears it
//! as the "Primary building selected" notification
//! (`SoundEventKind::PrimaryBuildingSelected`) and draws the PRIMARY tag
//! over the selected structure.
//!
//! WebRA's rally order has no force flag, so a forced rally point does not
//! make a structure primary as it does in OpenRA (RallyPoint.IsForceSet).

use crate::instances::{Sink, SpriteRec};
use crate::render::{px, SpriteIds};
use crate::rules::Kind;
use crate::sound_events::SoundEventKind;
use crate::world::World;

impl World {
    /// Whether actor `i` is a structure that can be made primary.
    pub fn can_be_primary(&self, i: usize) -> bool {
        let a = &self.actors[i];
        a.alive && a.kind == Kind::Building && self.rules.actors[a.ty as usize].options.primary_building
    }

    /// OpenRA PrimaryBuilding.ResolveOrder: toggle the primary mark of
    /// structure `i`. Returns false when it has no PrimaryBuilding.
    pub(crate) fn toggle_primary(&mut self, i: usize) -> bool {
        if !self.can_be_primary(i) {
            return false;
        }
        let on = !self.actors[i].primary;
        self.set_primary(i, on);
        true
    }

    /// OpenRA PrimaryBuilding.SetPrimaryProducer.
    pub(crate) fn set_primary(&mut self, i: usize, on: bool) {
        self.actors[i].primary = on;
        if !on {
            return;
        }
        let owner = self.actors[i].owner;
        let types = self.rules.actors[self.actors[i].ty as usize].building.as_ref().map(|b| b.production_types.clone()).unwrap_or_default();
        for j in 0..self.actors.len() {
            let b = &self.actors[j];
            if j == i || !b.alive || !b.primary || b.owner != owner || b.kind != Kind::Building {
                continue;
            }
            let shares =
                self.rules.actors[b.ty as usize].building.as_ref().is_some_and(|bi| bi.production_types.iter().any(|t| types.contains(t)));
            if shares {
                self.actors[j].primary = false;
            }
        }
        let a = &self.actors[i];
        self.sound.push(SoundEventKind::PrimaryBuildingSelected, a.ty as i32, a.x, a.y, owner, 0);
    }

    /// OpenRA WithDecoration@primary: the PRIMARY tag at the top of a
    /// selected primary structure, for its owner (RequiresSelection).
    pub(crate) fn render_primary(&self, player: u8, sink: &mut Sink, selected: &[u32], ids: &SpriteIds, sprites: &mut Vec<f32>) {
        for &r in selected {
            let Some(i) = self.resolve(r) else { continue };
            let a = &self.actors[i];
            if !a.primary || a.owner != player || a.kind != Kind::Building {
                continue;
            }
            let h = self.rules.actors[a.ty as usize].building.as_ref().map_or(1, |b| b.height);
            let (x, y) = (px(a.x), px(a.y) - h as f32 * 12.0 + 4.0);
            let tag = ids.leftovers_base + crate::husks::LEFTOVER_PRIMARY as f32;
            if sink.visible([x, y], [x, y], 32.0) {
                sink.sprite(sprites, SpriteRec::at(x, y, 32.0).look(tag, a.owner as f32, 1.0, 1.0, 0.0));
            }
        }
    }
}

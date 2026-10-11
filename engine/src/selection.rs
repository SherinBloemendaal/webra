//! OpenRA's selection rules (`SelectionUtils`, `SelectableExts`): which actors
//! the selection hotkeys (SelectAllUnits, SelectUnitsByType) and double click
//! pick. OpenRA selects actors with a `Selectable` trait (rules.rs
//! `SelectionInfo`) of the players the viewer may select for: the local
//! player, the player a spectator watches, or every player when a spectator
//! watches the whole map (`GetPlayersToIncludeInSelection`; the client passes
//! them as `owners`). Local UI queries, like the selection itself: nothing
//! here changes the world or the state hash.

use crate::math::CELL;
use crate::rules::{SelectionInfo, SELECT_ALT, SELECT_CTRL};
use crate::world::World;

/// A world rectangle in world units (the view, or the whole map).
#[derive(Clone, Copy, Debug)]
pub struct Rect {
    pub x0: i32,
    pub y0: i32,
    pub x1: i32,
    pub y1: i32,
}

impl Rect {
    /// The rectangle between two corners, in any order.
    pub fn new(ax: i32, ay: i32, bx: i32, by: i32) -> Self {
        Rect { x0: ax.min(bx), y0: ay.min(by), x1: ax.max(bx), y1: ay.max(by) }
    }

    fn overlaps(&self, o: &Rect) -> bool {
        self.x0 <= o.x1 && o.x0 <= self.x1 && self.y0 <= o.y1 && o.y0 <= self.y1
    }
}

/// The modifier keys held with a selection key or click (OpenRA `Modifiers`).
#[derive(Clone, Copy, Debug, Default)]
pub struct Mods {
    pub ctrl: bool,
    pub alt: bool,
}

/// OpenRA `BaseSelectionPriority`: the priority, or above every other when the
/// one modifier the actor allows is held (Ctrl without Alt, or Alt without Ctrl).
pub fn selection_priority(info: &SelectionInfo, mods: Mods) -> i64 {
    let raised =
        (mods.ctrl && !mods.alt && info.modifiers & SELECT_CTRL != 0) || (mods.alt && !mods.ctrl && info.modifiers & SELECT_ALT != 0);
    if raised {
        i64::MAX
    } else {
        i64::from(info.priority)
    }
}

impl World {
    /// The `Selectable` of actor `i`, when it can be selected now: alive, on
    /// the map (not inside a transport) and not a support power's aircraft.
    pub fn selectable(&self, i: usize) -> Option<&SelectionInfo> {
        let a = &self.actors[i];
        if !a.alive || !a.in_world() || self.is_support_aircraft(i) {
            return None;
        }
        self.rules.actors[a.ty as usize].selection.as_ref()
    }

    /// Where actor `i` can be clicked: its `Selectable` bounds, else its
    /// footprint (structures) or one cell, around its position.
    fn selection_bounds(&self, i: usize, info: &SelectionInfo) -> Rect {
        let a = &self.actors[i];
        let (w, h, ox, oy) = match *info.bounds.as_slice() {
            [w, h, ox, oy] => (w, h, ox, oy),
            _ => match &self.rules.actors[a.ty as usize].building {
                Some(b) => (b.width * CELL, b.height * CELL, 0, 0),
                None => (CELL, CELL, 0, 0),
            },
        };
        let (cx, cy) = (a.x + ox, a.y + oy);
        Rect { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 }
    }

    /// OpenRA `SelectActorsByOwnerAndSelectionClass` over the actors whose
    /// bounds touch `area` (`SelectActorsOnScreen`) or every actor on the map
    /// (`area` None, `SelectActorsInWorld`): selectable actors of `owners`,
    /// of one of `classes` (None: any class). Actor indices in actor order.
    pub fn selectable_actors(&self, owners: &[u8], area: Option<Rect>, classes: Option<&[&str]>) -> Vec<usize> {
        (0..self.actors.len())
            .filter(|&i| {
                let Some(info) = self.selectable(i) else { return false };
                owners.contains(&self.actors[i].owner)
                    && classes.is_none_or(|c| c.contains(&info.class.as_str()))
                    && area.is_none_or(|r| r.overlaps(&self.selection_bounds(i, info)))
            })
            .collect()
    }

    /// OpenRA `SubsetWithHighestSelectionPriority`: the actors of `ids` with
    /// the highest selection priority (all of them selectable).
    pub fn highest_selection_priority(&self, ids: Vec<usize>, mods: Mods) -> Vec<usize> {
        let prio = |i: usize| self.selectable(i).map_or(i64::MIN, |s| selection_priority(s, mods));
        let Some(best) = ids.iter().map(|&i| prio(i)).max() else { return ids };
        ids.into_iter().filter(|&i| prio(i) == best).collect()
    }

    /// The selection classes of the actors of `ids` that belong to `owners`
    /// and can be selected (OpenRA SelectUnitsByType: the selected actors'
    /// classes; double click: the clicked actor's).
    pub fn selection_classes(&self, owners: &[u8], ids: &[usize]) -> Vec<&str> {
        let mut out: Vec<&str> = Vec::new();
        for &i in ids {
            if !owners.contains(&self.actors[i].owner) {
                continue;
            }
            if let Some(s) = self.selectable(i) {
                if !out.contains(&s.class.as_str()) {
                    out.push(&s.class);
                }
            }
        }
        out
    }
}

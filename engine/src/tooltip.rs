//! The battlefield tooltip (OpenRA `ViewportControllerWidget.UpdateCameraTick`
//! and `WorldTooltipLogic`): what the actor, remembered structure, resource
//! or shroud under the mouse is called, who owns it and the extra lines
//! (`TooltipDescription`). Seen with the viewer's eyes: shroud hides
//! everything ("Unrevealed Terrain"), the fog hides actors (remembered
//! structures show what was seen), cloaked enemies are not there and a
//! disguised spy shows its disguise. A local UI query like `pick`: it reads
//! the world and changes nothing, so the state hash never sees it.

use crate::infantry::Disguise;
use crate::math::CELL;
use crate::render::PX_PER_CELL;
use crate::rules::{Kind, TooltipInfo, REL_ALLY, REL_ENEMY, REL_NEUTRAL};
use crate::selection::{selection_priority, Mods};
use crate::world::{Ghost, World};

/// What the mouse is over (OpenRA `WorldTooltipType`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TooltipKind {
    Unexplored,
    Resource,
    Actor,
    /// A remembered structure under the fog (OpenRA `FrozenActor`).
    Frozen,
}

/// The battlefield tooltip's content (OpenRA `WorldTooltipLogic`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorldTooltip {
    pub kind: TooltipKind,
    /// The first line: the name for this viewer (`TooltipForPlayerStance`).
    pub label: String,
    /// The live actor (index), for `Actor` tooltips.
    pub actor: Option<usize>,
    /// The owner row's player (flag and name): None when the row is hidden
    /// (no owner row, or a non-combatant owner such as the neutral player).
    pub owner: Option<u8>,
    /// More lines (`IProvideTooltipInfo`: TooltipDescription).
    pub extras: Vec<String>,
    /// The actor type the label names for this viewer (`shown_type`), for
    /// the quick tips (apps/game/js/quicktips.js): a disguise's type, and
    /// for an enemy's fake the structure it imitates. None for resources and
    /// shroud.
    pub shown: Option<usize>,
}

impl WorldTooltip {
    fn text(kind: TooltipKind, label: &str) -> WorldTooltip {
        WorldTooltip { kind, label: label.to_string(), actor: None, owner: None, extras: Vec::new(), shown: None }
    }
}

/// OpenRA `Player.RelationshipWith`, as `REL_*` bits: own and allied actors
/// are allies, players at war enemies, the rest neutral.
fn relationship(w: &World, owner: u8, viewer: u8) -> u8 {
    if owner == viewer || w.are_allies(owner, viewer) {
        REL_ALLY
    } else if w.are_enemies(owner, viewer) {
        REL_ENEMY
    } else {
        REL_NEUTRAL
    }
}

impl World {
    /// The tooltip at world point (`x`, `y`) for `player`'s eyes (the render
    /// paths' slot: in the spectator views the flags `render_all` or
    /// `render_combined` are set), `viewer` the player relationships are
    /// taken from (None: a spectator, OpenRA without a render player), `mods`
    /// the modifier keys held (they raise selection priorities). None outside
    /// the map or over nothing with a tooltip.
    pub fn world_tooltip(&self, player: u8, viewer: Option<u8>, x: i32, y: i32, mods: Mods) -> Option<WorldTooltip> {
        let (cx, cy) = (x.div_euclid(CELL), y.div_euclid(CELL));
        if !self.map.contains(cx, cy) {
            return None;
        }
        let ci = self.map.idx(cx, cy);
        let texts = &self.rules.world.tooltips;
        // World.ShroudObscures: shrouded cells (render.rs fog_bytes 0) name nothing.
        if self.shroud_obscures(player, ci) {
            return Some(WorldTooltip::text(TooltipKind::Unexplored, &texts.unrevealed));
        }
        if let Some(i) = self.tooltip_actor_at(player, x, y, mods) {
            return Some(self.actor_tooltip(i, viewer));
        }
        if let Some(g) = self.tooltip_ghost_at(player, x, y, mods) {
            return Some(self.ghost_tooltip(g, viewer));
        }
        // ResourceRenderer.GetRenderedResourceTooltip: the resource drawn there.
        if self.map.gems[ci] > 0 {
            return Some(WorldTooltip::text(TooltipKind::Resource, &texts.gems));
        }
        if self.map.ore[ci] > 0 {
            return Some(WorldTooltip::text(TooltipKind::Resource, &texts.ore));
        }
        None
    }

    /// Whether cell `ci` is shroud to `player`: neither seen nor explored, or
    /// explored but hidden by an enemy gap generator (never in the spectator view).
    fn shroud_obscures(&self, player: u8, ci: usize) -> bool {
        if self.render_all {
            return false;
        }
        let p = &self.players[player as usize];
        p.visible[ci] == 0 && (p.explored[ci] == 0 || self.gen_shrouded(player, ci))
    }

    /// The actor under the point that the tooltip names (OpenRA
    /// `ScreenMap.ActorsAtMouse` with a tooltip that the fog does not hide,
    /// `WithHighestSelectionPriority`): of the actors drawn for `player` whose
    /// bounds hold the point, the one with the highest selection priority
    /// less its distance in pixels from the point to its bounds' centre;
    /// actors that cannot be selected rank below all that can. The first in
    /// actor order on a tie.
    pub fn tooltip_actor_at(&self, player: u8, x: i32, y: i32, mods: Mods) -> Option<usize> {
        let mut best: Option<(i64, usize)> = None;
        for (i, a) in self.actors.iter().enumerate() {
            if !a.alive || !a.in_world() {
                continue;
            }
            let info = &self.rules.actors[a.ty as usize];
            if info.tooltip.is_none() {
                continue;
            }
            // World.FogObscures: what the render paths draw for `player`.
            if !self.is_visible_to(i, player) || (a.owner != player && self.is_cloaked_from(i, player)) {
                continue;
            }
            let (x0, y0, x1, y1) = self.mouse_bounds(i);
            if x < x0 || x > x1 || y < y0 || y > y1 {
                continue;
            }
            let prio = self.selectable(i).map_or(i64::from(i32::MIN), |s| selection_priority(s, mods));
            let score = prio - pixel_distance((x0 + x1) / 2 - x, (y0 + y1) / 2 - y);
            if best.is_none_or(|(b, _)| score > b) {
                best = Some((score, i));
            }
        }
        best.map(|(_, i)| i)
    }

    /// Where actor `i` takes the mouse (OpenRA IMouseBounds): its selection
    /// bounds when it can be selected, else its footprint (structures,
    /// bridges, trees) or one cell around it.
    fn mouse_bounds(&self, i: usize) -> (i32, i32, i32, i32) {
        let a = &self.actors[i];
        if let Some(info) = self.selectable(i) {
            return self.selection_bounds(i, info).corners();
        }
        let (w, h) = match (&self.rules.actors[a.ty as usize].building, a.kind) {
            (Some(b), Kind::Building) => (b.width * CELL, b.height * CELL),
            _ => (CELL, CELL),
        };
        (a.x - w / 2, a.y - h / 2, a.x + w / 2, a.y + h / 2)
    }

    /// The remembered structure under the point (OpenRA
    /// `ScreenMap.FrozenActorsAtMouse`, visible and not hidden), when its
    /// live actor is not drawn: ranked like `tooltip_actor_at`.
    fn tooltip_ghost_at(&self, player: u8, x: i32, y: i32, mods: Mods) -> Option<&Ghost> {
        if self.render_all {
            return None; // the spectator view draws every structure live
        }
        let mut best: Option<(i64, &Ghost)> = None;
        for g in self.players[player as usize].ghosts.values() {
            let info = &self.rules.actors[g.ty as usize];
            let (Some(b), Some(_)) = (info.building.as_ref(), info.tooltip.as_ref()) else { continue };
            if let Some(i) = self.resolve(g.actor) {
                if self.is_visible_to(i, player) && !self.is_cloaked_from(i, player) {
                    continue; // drawn live (render.rs)
                }
            }
            if self.gen_shrouded(player, self.map.idx(g.cx, g.cy)) {
                continue;
            }
            let (x0, y0) = (g.cx * CELL, g.cy * CELL);
            let (x1, y1) = (x0 + b.width * CELL, y0 + b.height * CELL);
            if x < x0 || x > x1 || y < y0 || y > y1 {
                continue;
            }
            let prio = info.selection.as_ref().map_or(i64::from(i32::MIN), |s| selection_priority(s, mods));
            let score = prio - pixel_distance((x0 + x1) / 2 - x, (y0 + y1) / 2 - y);
            if best.is_none_or(|(s, _)| score > s) {
                best = Some((score, g));
            }
        }
        best.map(|(_, g)| g)
    }

    /// The tooltip of live actor `i` (OpenRA `Tooltip`, `DisguiseTooltip`,
    /// `TooltipDescription`).
    fn actor_tooltip(&self, i: usize, viewer: Option<u8>) -> WorldTooltip {
        let a = &self.actors[i];
        // DisguiseTooltip: a disguised spy carries its disguise's tooltip for
        // everyone, and its disguise's owner for everyone but its owner's allies.
        let (ty, owner) = match a.inf.disguise {
            Some(Disguise { ty, owner }) => {
                let shown = if viewer.is_none_or(|v| self.are_allies(a.owner, v)) { a.owner } else { owner };
                (ty as usize, shown)
            }
            None => (a.ty as usize, a.owner),
        };
        let mut t = self.named(TooltipKind::Actor, ty, owner, viewer);
        t.actor = Some(i);
        t.extras = self.tooltip_descriptions(a.ty as usize, a.owner, viewer);
        t
    }

    /// The tooltip of a remembered structure: its type and owner when it was
    /// last seen (OpenRA `FrozenActor.TooltipInfo`, `TooltipOwner`). Its
    /// TooltipDescription follows that owner too: OpenRA reads the live
    /// actor's here, which would tell a capture under the fog.
    fn ghost_tooltip(&self, g: &Ghost, viewer: Option<u8>) -> WorldTooltip {
        let mut t = self.named(TooltipKind::Frozen, g.ty as usize, g.owner, viewer);
        t.extras = self.tooltip_descriptions(g.ty as usize, g.owner, viewer);
        t
    }

    /// Name and owner row of actor type `ty` owned by `owner` for `viewer`
    /// (`WorldTooltipLogic`: the owner row for combatant owners with
    /// ShowOwnerRow).
    fn named(&self, kind: TooltipKind, ty: usize, owner: u8, viewer: Option<u8>) -> WorldTooltip {
        let rel = viewer.map(|v| relationship(self, owner, v));
        let info = &self.rules.actors[ty];
        let show = info.tooltip.as_ref().is_some_and(|t| t.show_owner) && !self.players.get(owner as usize).is_none_or(|p| p.neutral);
        WorldTooltip {
            kind,
            label: self.tooltip_label(ty, rel),
            actor: None,
            owner: show.then_some(owner),
            extras: Vec::new(),
            shown: self.shown_type(ty, rel),
        }
    }

    /// The actor type `tooltip_label` names: `ty` itself, or for the
    /// relationships of GenericVisibility the type whose own name is the
    /// generic name (a fake shows the structure it imitates to enemies, so
    /// nothing tells it apart), None when no type has that name.
    pub fn shown_type(&self, ty: usize, rel: Option<u8>) -> Option<usize> {
        let info = &self.rules.actors[ty];
        let Some(TooltipInfo { generic_name, generic_visibility, .. }) = info.tooltip.as_ref() else { return Some(ty) };
        if !rel.is_some_and(|r| generic_visibility & r != 0) {
            return Some(ty);
        }
        self.rules.actors.iter().position(|a| a.name == *generic_name && a.tooltip.as_ref().is_some_and(|t| t.generic_visibility == 0))
    }

    /// OpenRA `TooltipInfo.TooltipForPlayerStance`: the name, or for the
    /// relationships of GenericVisibility the generic name, after "Ally" or
    /// "Enemy" with GenericStancePrefix (RA has no neutral prefix). `rel` None:
    /// no viewer (spectators), the name.
    pub fn tooltip_label(&self, ty: usize, rel: Option<u8>) -> String {
        let info = &self.rules.actors[ty];
        let Some(TooltipInfo { generic_name, generic_visibility, generic_prefix, .. }) = info.tooltip.as_ref() else {
            return info.name.clone();
        };
        let Some(rel) = rel.filter(|r| generic_visibility & r != 0) else { return info.name.clone() };
        let texts = &self.rules.world.tooltips;
        let prefix = match rel {
            REL_ALLY => texts.ally_prefix.as_str(),
            REL_ENEMY => texts.enemy_prefix.as_str(),
            _ => "",
        };
        if *generic_prefix && !prefix.is_empty() {
            format!("{prefix} {generic_name}")
        } else {
            generic_name.clone()
        }
    }

    /// OpenRA `TooltipDescription` (tech buildings): @ally for the owner and
    /// its allies, @other for neutrals and enemies; nothing for spectators
    /// (no render player).
    fn tooltip_descriptions(&self, ty: usize, owner: u8, viewer: Option<u8>) -> Vec<String> {
        let Some(v) = viewer else { return Vec::new() };
        let w = &self.rules.actors[ty].world;
        let text = if relationship(self, owner, v) == REL_ALLY { &w.ally_description } else { &w.other_description };
        if text.is_empty() {
            Vec::new()
        } else {
            vec![text.clone()]
        }
    }
}

/// Distance in screen pixels for a world offset (OpenRA ranks by pixels).
fn pixel_distance(dx: i32, dy: i32) -> i64 {
    let px = |wu: i32| f64::from(wu) * f64::from(PX_PER_CELL) / f64::from(CELL);
    px(dx).hypot(px(dy)) as i64
}

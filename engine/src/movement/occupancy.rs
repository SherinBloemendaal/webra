//! Cell occupancy of the OpenRA movement model: OpenRA's ActorMap
//! influence and the Locomotor's blocking rules (CanMoveFreelyInto,
//! IsBlockedBy, sub-cells).
//!
//! A unit holds the cell it stands on, and while it steps to the next cell
//! that cell too (`Motion::from`, `Motion::to`). Units that share cells
//! (infantry, Locomotor SharesCell) hold one of five sub-cells and only
//! their destination cell (OpenRA Mobile.OccupiedCells). The table is
//! rebuilt at the start of every tick from the units' cells (snapping units
//! that other code placed, `World::occupancy_begin_tick`) and kept current
//! as units step during the tick.

use crate::movement::MovementModel;
use crate::rules::Kind;
use crate::world::{cell_center, World, NONE};

/// The whole cell (vehicles, ships). Sub-cells are 1 to 5.
pub const FULL_CELL: u8 = 0;
/// OpenRA MapGrid.DefaultSubCell of a rectangular grid: the centre.
pub const DEFAULT_SUB_CELL: u8 = 3;
/// The points of the sub-cells (index 0 is the whole cell): OpenRA's
/// MapGrid SubCellOffsets of a rectangular grid, with the left ones at
/// -256 like the right ones at 256 (OpenRA: -299), so that no side of a
/// mirrored map stands nearer its enemies.
pub const SUB_CELL_OFFSETS: [(i32, i32); 6] = [(0, 0), (-256, -256), (256, -256), (0, 0), (-256, 256), (256, 256)];

/// OpenRA BlockedByActor: which units count as blocking a cell.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum Blocking {
    /// Terrain only.
    None,
    /// Units that cannot be asked to move: enemies and immovable units.
    Immovable,
    /// Units that stand still.
    Stationary,
    /// Every unit.
    All,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Occupant {
    pub actor: u32,
    pub sub: u8,
}

/// Units per cell (OpenRA ActorMap influence of mobile actors).
#[derive(Clone, Default)]
pub struct Occupancy {
    cells: Vec<Vec<Occupant>>,
    /// Cells with occupants, so a rebuild clears only those.
    used: Vec<u32>,
    /// Tick (plus one) in which a unit last left each cell. A cell left in
    /// this tick is claimed from the next tick on, so who gets it does not
    /// depend on the order units act in (it alternates every tick).
    left: Vec<u32>,
}

impl Occupancy {
    pub fn at(&self, cell: u32) -> &[Occupant] {
        self.cells.get(cell as usize).map_or(&[], |v| v.as_slice())
    }

    fn clear(&mut self, cells: usize) {
        if self.cells.len() != cells {
            self.cells = vec![Vec::new(); cells];
            self.left = vec![0; cells];
            self.used.clear();
            return;
        }
        for &c in &self.used {
            self.cells[c as usize].clear();
        }
        self.used.clear();
    }

    /// Size the table for a map of `cells` cells (a new or replaced map).
    fn ensure(&mut self, cells: usize) {
        if self.cells.len() != cells {
            self.clear(cells);
        }
    }

    pub(crate) fn add(&mut self, cell: u32, actor: usize, sub: u8) {
        let v = &mut self.cells[cell as usize];
        if v.is_empty() {
            self.used.push(cell);
        }
        v.push(Occupant { actor: actor as u32, sub });
    }

    pub(crate) fn remove(&mut self, cell: u32, actor: usize) {
        if let Some(v) = self.cells.get_mut(cell as usize) {
            v.retain(|o| o.actor != actor as u32);
        }
    }

    /// A unit left `cell` in `tick`.
    fn note_left(&mut self, cell: u32, tick: u32) {
        if let Some(t) = self.left.get_mut(cell as usize) {
            *t = tick.wrapping_add(1);
        }
    }

    /// Whether a unit left `cell` in `tick`.
    pub(crate) fn left_in(&self, cell: u32, tick: u32) -> bool {
        self.left.get(cell as usize).is_some_and(|&t| t == tick.wrapping_add(1))
    }
}

/// The point of sub-cell `sub` of `cell` (world units).
pub fn sub_cell_point(width: i32, cell: u32, sub: u8) -> (i32, i32) {
    let (ox, oy) = SUB_CELL_OFFSETS[sub as usize];
    (cell_center(cell as i32 % width) + ox, cell_center(cell as i32 / width) + oy)
}

/// Whether two sub-cells of one cell overlap (the whole cell overlaps all).
#[inline]
fn overlaps(a: u8, b: u8) -> bool {
    a == FULL_CELL || b == FULL_CELL || a == b
}

/// Every sub-cell as a bit set (`sub_bits`).
const ALL_SUBS: u8 = 0b11_1110;

/// The sub-cells a holder on sub-cell `s` takes, as bits `1 << sub`: all
/// of them for the whole cell.
#[inline]
fn sub_bits(s: u8) -> u8 {
    if s == FULL_CELL {
        ALL_SUBS
    } else {
        1 << s
    }
}

impl World {
    /// Whether the game uses the OpenRA movement model.
    #[inline]
    pub(crate) fn cell_moves(&self) -> bool {
        self.options.movement == MovementModel::OpenRA
    }

    /// Whether unit `i` holds cells in the occupancy table: a ground unit or
    /// ship in the world, not in the air (aircraft, paratroopers, a leaping
    /// dog) and not walking into a structure.
    pub(crate) fn occupies_cells(&self, i: usize) -> bool {
        let a = &self.actors[i];
        a.alive
            && a.in_world()
            && a.is_unit()
            && a.kind != Kind::Aircraft
            && !a.air.parachute
            && self.rules.actors[a.ty as usize].unit.is_some()
            && !self.passes_through(i)
    }

    /// OpenRA Locomotor SharesCell of unit `i`.
    pub(crate) fn shares_cell(&self, i: usize) -> bool {
        self.rules.actors[self.actors[i].ty as usize].unit.as_ref().is_some_and(|u| self.rules.locomotors[u.locomotor].shares_cell)
    }

    /// OpenRA Mobile movable: a unit that can be asked to move (it has a speed).
    pub(crate) fn is_movable(&self, i: usize) -> bool {
        self.rules.actors[self.actors[i].ty as usize].unit.as_ref().is_some_and(|u| u.speed > 0)
    }

    /// The occupants of `cell` other than `i` that still hold it.
    pub(crate) fn others_at(&self, cell: u32, i: usize) -> impl Iterator<Item = Occupant> + '_ {
        self.occupancy.at(cell).iter().copied().filter(move |o| {
            let j = o.actor as usize;
            j != i && self.occupies_cells(j)
        })
    }

    /// Whether the terrain (and structures) of `cell` let unit `i` in: its
    /// passability, with the walls it crushes open (neutral.rs).
    pub(crate) fn terrain_allows(&self, i: usize, cell: u32) -> bool {
        let ci = cell as usize;
        let pass = self.pass_of(i);
        !pass.blocked[ci] || (pass.crush[ci] != 0 && self.crushes_wall_at(i, ci))
    }

    /// Whether unit `i` may step from cell `from` to the neighbouring cell
    /// `to` as far as the terrain goes: `to` is open to it, and a diagonal
    /// step does not cut a blocked corner (the rule of the flow fields,
    /// flowfield::step), so a unit never brushes over water or rock. A unit
    /// on a blocked cell (a structure went up around it) may leave any way.
    pub(crate) fn can_step(&self, i: usize, from: u32, to: u32) -> bool {
        if !self.terrain_allows(i, to) {
            return false;
        }
        let w = self.map.width;
        let (fx, fy, tx, ty) = (from as i32 % w, from as i32 / w, to as i32 % w, to as i32 / w);
        if fx == tx || fy == ty || !self.terrain_allows(i, from) {
            return true;
        }
        self.terrain_allows(i, self.map.idx(tx, fy) as u32) && self.terrain_allows(i, self.map.idx(fx, ty) as u32)
    }

    /// OpenRA Mobile.CanStayInCell: not a cell units may only cross (the
    /// service depot's pad, footprint `+`).
    pub(crate) fn can_stay_in_cell(&self, cell: u32) -> bool {
        let b = self.building_at[cell as usize];
        if b == NONE {
            return true;
        }
        let ba = &self.actors[b as usize];
        let Some(info) = self.rules.actors[ba.ty as usize].building.as_ref() else { return true };
        let (x, y) = (cell as i32 % self.map.width, cell as i32 / self.map.width);
        !info.transit_cells.contains(&(x - ba.cx, y - ba.cy))
    }

    /// OpenRA Crushable.CrushableBy: unit `o` is run over by unit `i`
    /// (soldiers and civilians under an enemy's tracked vehicle).
    pub(crate) fn crushable_by(&self, o: usize, i: usize) -> bool {
        self.actors[o].kind == Kind::Infantry
            && self.actors[i].kind == Kind::Vehicle
            && !self.are_allies(self.actors[i].owner, self.actors[o].owner)
            && self.rules.actors[self.actors[i].ty as usize]
                .unit
                .as_ref()
                .is_some_and(|u| self.rules.locomotors[u.locomotor].crushes_infantry)
    }

    /// OpenRA Locomotor.IsBlockedBy: whether occupant `o` keeps unit `i` out
    /// under `check`.
    pub(crate) fn blocked_by(&self, i: usize, o: usize, check: Blocking) -> bool {
        if check <= Blocking::Stationary {
            let movable = self.is_movable(o);
            // Allies that can be asked to move out of the way.
            if check <= Blocking::Immovable && movable && self.are_allies(self.actors[i].owner, self.actors[o].owner) {
                return false;
            }
            // Units on the move.
            if movable && self.actors[o].mv.moving {
                return false;
            }
        }
        !self.crushable_by(o, i)
    }

    /// The sub-cells of `cell` that its holders other than `i` take (bits
    /// `1 << sub`, all of them for a holder of the whole cell), counting
    /// only the holders `counts` accepts, and whether `cell` has any holder
    /// other than `i` at all. One pass over the holders: the occupancy
    /// queries below ask about the sub-cells of crowded cells many times
    /// per tick.
    fn taken_subs(&self, cell: u32, i: usize, counts: impl Fn(Occupant) -> bool) -> (u8, bool) {
        let (mut mask, mut any) = (0, false);
        for o in self.others_at(cell, i) {
            any = true;
            if mask != ALL_SUBS && counts(o) {
                mask |= sub_bits(o.sub);
            }
        }
        (mask, any)
    }

    /// OpenRA Mobile.CanEnterCell: unit `i` may move into `cell` (its
    /// terrain and, under `check`, the units on it).
    pub(crate) fn can_enter_cell(&self, i: usize, cell: u32, check: Blocking) -> bool {
        if cell as usize >= self.map.cells() || !self.terrain_allows(i, cell) {
            return false;
        }
        if check == Blocking::None {
            return true;
        }
        let shares = self.shares_cell(i);
        // `free_sub_cell` finds a sub-cell exactly when nobody else holds
        // the cell or one of its sub-cells is free.
        if shares {
            let (mask, any) = self.taken_subs(cell, i, |_| true);
            if !any || mask != ALL_SUBS {
                return true;
            }
        }
        let sub = if shares { self.actors[i].mv.to_sub } else { FULL_CELL };
        !self.others_at(cell, i).any(|o| overlaps(o.sub, sub) && self.blocked_by(i, o.actor as usize, check))
    }

    /// OpenRA ActorMap.FreeSubCell: `preferred` when nobody else holds it,
    /// else the default sub-cell of an empty cell, else a free one (the
    /// nearest, `nearest_sub_cell`). None when every sub-cell is taken (or a
    /// unit holds the whole cell).
    pub(crate) fn free_sub_cell(&self, cell: u32, i: usize, preferred: u8) -> Option<u8> {
        let (mask, any) = self.taken_subs(cell, i, |_| true);
        let taken = |s: u8| mask & sub_bits(s) != 0;
        if preferred != FULL_CELL && !taken(preferred) {
            return Some(preferred);
        }
        if !any {
            return Some(DEFAULT_SUB_CELL);
        }
        self.nearest_sub_cell(i, cell, |s| s != preferred && !taken(s))
    }

    /// The free sub-cell of `cell` nearest to unit `i`, ties to the upper
    /// one, then to the one nearer the map centre. OpenRA takes the first
    /// free one in index order (top left first); this order keeps mirrored
    /// units on mirrored sub-cells, so a sub-cell never favours a side of
    /// the map.
    pub(crate) fn nearest_sub_cell(&self, i: usize, cell: u32, free: impl Fn(u8) -> bool) -> Option<u8> {
        let (x, y) = (self.actors[i].x, self.actors[i].y);
        (1..SUB_CELL_OFFSETS.len() as u8).filter(|&s| free(s)).min_by_key(|&s| {
            let (px, py) = sub_cell_point(self.map.width, cell, s);
            let centre =
                (2 * px - self.map.width * crate::math::CELL).pow(2) as i64 + (2 * py - self.map.height * crate::math::CELL).pow(2) as i64;
            (crate::math::dist_sq(x, y, px, py), py, centre)
        })
    }

    /// OpenRA Mobile.GetAvailableSubCell under BlockedByActor.All: the
    /// whole cell for units that do not share cells, else a free sub-cell
    /// (the one it came from first). None when the cell is taken.
    pub(crate) fn available_sub_cell(&self, i: usize, cell: u32) -> Option<u8> {
        if !self.shares_cell(i) {
            let blocked = self.others_at(cell, i).any(|o| self.blocked_by(i, o.actor as usize, Blocking::All));
            return (!blocked).then_some(FULL_CELL);
        }
        let preferred = self.actors[i].mv.from_sub;
        let (mask, any) = self.taken_subs(cell, i, |o| self.blocked_by(i, o.actor as usize, Blocking::All));
        let taken = |s: u8| mask & sub_bits(s) != 0;
        if preferred != FULL_CELL && !taken(preferred) {
            return Some(preferred);
        }
        if !any {
            return Some(DEFAULT_SUB_CELL);
        }
        self.nearest_sub_cell(i, cell, |s| s != preferred && !taken(s))
    }

    /// The cells unit `i` holds (OpenRA Mobile.OccupiedCells).
    fn held_cells(&self, i: usize) -> [(u32, u8); 2] {
        let m = &self.actors[i].mv;
        if m.from == m.to || self.shares_cell(i) {
            [(m.to, m.to_sub), (NONE, 0)]
        } else {
            [(m.from, m.from_sub), (m.to, m.to_sub)]
        }
    }

    /// OpenRA Mobile.SetLocation: unit `i` now holds `from` and `to`.
    pub(crate) fn set_location(&mut self, i: usize, from: (u32, u8), to: (u32, u8)) {
        self.occupancy.ensure(self.map.cells());
        for (c, _) in self.held_cells(i) {
            if c != NONE {
                self.occupancy.remove(c, i);
                if c != from.0 && c != to.0 {
                    self.occupancy.note_left(c, self.tick);
                }
            }
        }
        let m = &mut self.actors[i].mv;
        (m.from, m.from_sub, m.to, m.to_sub) = (from.0, from.1, to.0, to.1);
        m.blocking = false;
        for (c, s) in self.held_cells(i) {
            if c != NONE {
                self.occupancy.add(c, i, s);
            }
        }
    }

    /// Start of a tick (OpenRA model): note who moved in the last tick
    /// (Mobile.CurrentMovementTypes) and rebuild the occupancy table. A unit
    /// that other code placed somewhere else (unloaded, teleported, landed
    /// from a leap, newly built) takes the cell it stands on, with a free
    /// sub-cell; when it had to squeeze in against the rules it is marked
    /// `crowded` and steps off once idle (cellmove.rs).
    pub(crate) fn occupancy_begin_tick(&mut self) {
        let n = self.actors.len();
        for a in self.actors.iter_mut() {
            a.mv.moving = a.alive && a.moved;
            if !a.mv.stepped {
                a.mv.turning = false;
            }
            a.mv.stepped = false;
        }
        let cells = self.map.cells();
        self.occupancy.clear(cells);
        let mut snap = Vec::new();
        for i in 0..n {
            if !self.occupies_cells(i) {
                continue;
            }
            let a = &self.actors[i];
            let m = &a.mv;
            let shares = self.shares_cell(i);
            let valid_sub = |s: u8| if shares { s != FULL_CELL } else { s == FULL_CELL };
            let here = self.cell_index(a.x, a.y) as u32;
            if m.to == NONE || m.pos != (a.x, a.y) || !self.adjacent_cells(here, m.to) || !valid_sub(m.to_sub) || !valid_sub(m.from_sub) {
                snap.push(i);
                continue;
            }
            let crowded = self.held_cells(i).iter().any(|&(c, s)| c != NONE && self.others_at(c, i).any(|o| self.squeezed(i, o, s)));
            self.actors[i].mv.crowded = crowded;
            for (c, s) in self.held_cells(i) {
                if c != NONE {
                    self.occupancy.add(c, i, s);
                }
            }
        }
        for i in snap {
            self.place_on_cell(i);
        }
    }

    /// Unit `i` takes the cell it stands on (a free sub-cell for infantry),
    /// `crowded` when it may not share it with whoever is there.
    pub(crate) fn place_on_cell(&mut self, i: usize) {
        self.occupancy.ensure(self.map.cells());
        if self.actors[i].mv.to != NONE {
            for (c, _) in self.held_cells(i) {
                if c != NONE {
                    self.occupancy.remove(c, i);
                }
            }
        }
        let here = self.cell_index(self.actors[i].x, self.actors[i].y) as u32;
        let sub = if self.shares_cell(i) { self.free_sub_cell(here, i, DEFAULT_SUB_CELL) } else { Some(FULL_CELL) };
        let crowded = match sub {
            None => true,
            Some(s) => self.others_at(here, i).any(|o| self.squeezed(i, o, s)),
        };
        let sub = sub.unwrap_or(if self.shares_cell(i) { DEFAULT_SUB_CELL } else { FULL_CELL });
        let a = &mut self.actors[i];
        a.mv.snapped(here, sub, (a.x, a.y));
        a.mv.crowded = crowded;
        self.occupancy.add(here, i, sub);
    }

    /// Whether unit `i` on sub-cell `sub` shares its place with occupant
    /// `o` against the rules: they overlap, and neither may run the other
    /// over (a tank driving onto a soldier crushes it when it arrives).
    fn squeezed(&self, i: usize, o: Occupant, sub: u8) -> bool {
        let j = o.actor as usize;
        overlaps(o.sub, sub) && !self.crushable_by(i, j) && !self.crushable_by(j, i)
    }

    /// Whether every unit holding `cell` is on its way out (OpenRA
    /// Move.CellIsEvacuating: moving, or turning to move).
    pub(crate) fn cell_is_evacuating(&self, cell: u32, i: usize) -> bool {
        self.others_at(cell, i).all(|o| {
            let m = &self.actors[o.actor as usize].mv;
            self.is_movable(o.actor as usize) && (m.moving || m.turning)
        })
    }

    /// The cell of point (x, y) as an index.
    #[inline]
    pub(crate) fn cell_at(&self, x: i32, y: i32) -> u32 {
        self.cell_index(x, y) as u32
    }

    /// Whether two cells touch (8-neighbourhood) or are the same.
    pub(crate) fn adjacent_cells(&self, a: u32, b: u32) -> bool {
        let w = self.map.width;
        let (ax, ay, bx, by) = (a as i32 % w, a as i32 / w, b as i32 % w, b as i32 / w);
        (ax - bx).abs() <= 1 && (ay - by).abs() <= 1
    }

    /// Squared distance between two cells, in cells (OpenRA CVec.LengthSquared).
    pub(crate) fn cell_dist2(&self, a: u32, b: u32) -> i32 {
        let w = self.map.width;
        let (dx, dy) = (a as i32 % w - b as i32 % w, a as i32 / w - b as i32 / w);
        dx * dx + dy * dy
    }

    /// World position of the middle of cell `c`.
    pub(crate) fn cell_point(&self, c: u32) -> (i32, i32) {
        (cell_center(c as i32 % self.map.width), cell_center(c as i32 / self.map.width))
    }
}

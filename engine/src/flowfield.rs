//! Flow-field pathfinding.
//!
//! A flow field stores, for every cell, the neighbour to step to on the
//! cheapest route to one goal cell. All units heading to the same goal with
//! the same locomotor share one field, so a thousand units cost about as much
//! as one. Fields are cached and rebuilt lazily when passability changes.
//!
//! Next to the direction each field keeps the remaining path length per
//! cell. Units use it to tell real progress from standing in a queue: a
//! detour around a wall moves a unit away from its goal in a straight line
//! but always brings it closer along the path.
//!
//! Two things keep the work per tick bounded, whatever the map or the
//! number of goals (OpenRA bounds its searches the same way, with a
//! hierarchical path finder that stops at the unit and a domain index for
//! the unreachable):
//!
//! - A field is computed only as far as the units that use it (`FlowField::
//!   complete`, `bound`): the search from the goal stops a margin beyond
//!   the asking unit's cell. A unit on a cell the field does not cover yet
//!   extends it (to twice the bound at least), so a group far away costs a
//!   few extensions, and a chase of a target a few cells away costs a few
//!   hundred cells per step of the target instead of the whole map.
//! - A passability change (a structure goes up, a wall falls, a bridge
//!   breaks) only recomputes the fields it can alter: those covering a
//!   changed cell or one next to it (`Passability::changes_since`). Every
//!   other field is exactly what a fresh search would give.
//!
//! Both keep the fields a pure function of the map, so the cache never
//! decides a game: a client that starts from an empty cache (a replay
//! snapshot, a rejoin) computes the same directions. Ore slows units and
//! so costs more on a route (OpenRA's Ore terrain type), so a cell gaining
//! or losing its ore counts as a change too (`Passability::note_cost_change`).

use crate::map::Map;
use crate::rules::Locomotor;
use std::cmp::Reverse;
use std::collections::{BTreeMap, BinaryHeap};

/// Neighbour offsets, clockwise from north.
pub const DIRS: [(i32, i32); 8] = [(0, -1), (1, -1), (1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1)];
pub const DIR_GOAL: u8 = 8;
pub const DIR_NONE: u8 = 255;

const COST_STRAIGHT: u32 = 100;
const COST_DIAGONAL: u32 = 141;
/// Most fields kept at once.
const MAX_CACHED: usize = 256;
/// Cells kept over all cached fields (three bytes each). Huge maps keep
/// fewer fields so the cache stays near 72 MB; maps up to about 300 x 300
/// cells keep all `MAX_CACHED`.
const CACHE_CELL_BUDGET: usize = 24 << 20;
/// Fewest fields kept, however large the map.
const MIN_CACHED: usize = 32;
/// `FlowField::dist` of a cell that cannot reach the goal.
pub const DIST_NONE: u16 = u16::MAX;
/// Path cost beyond the asking unit's cell a partial field covers, so that
/// crowd pushes and the units just behind it stay on covered cells.
const BOUND_MARGIN: u32 = 8 * COST_STRAIGHT;

#[derive(Clone)]
pub struct FlowField {
    pub goal: u32,
    pub loco: u8,
    /// 0, or 1 + the player whose units crush walls on the way (`Crush`).
    pub crusher: u8,
    pub version: u32,
    pub dirs: Vec<u8>,
    /// Remaining path cost to the goal per cell, in cell steps on clear
    /// terrain (path cost / `COST_STRAIGHT`, rounded down, saturating below
    /// `DIST_NONE`). It never rises along `dirs`, and drops by at least one
    /// per step wherever the locomotor is not faster than on clear terrain.
    pub dist: Vec<u16>,
    pub last_used: u64,
    /// The search ran to the end: every `DIR_NONE` cell cannot reach the
    /// goal. A partial field only covers cells up to path cost `bound`.
    pub complete: bool,
    /// Path cost (COST_STRAIGHT per clear cell) the field covers when it is
    /// not complete.
    pub bound: u32,
}

impl FlowField {
    /// Whether a passability change at cell `c` can alter this field: `c`
    /// or a neighbour of it is covered (a blocked cell on a route, a freed
    /// cell that opens a shortcut or a corner). Elsewhere the change is
    /// beyond the field's reach or in an area it cannot reach.
    fn touched_by(&self, map: &Map, c: usize) -> bool {
        if self.dist[c] != DIST_NONE {
            return true;
        }
        let (x, y) = ((c as i32) % map.width, (c as i32) / map.width);
        DIRS.iter().any(|&(dx, dy)| map.contains(x + dx, y + dy) && self.dist[map.idx(x + dx, y + dy)] != DIST_NONE)
    }
}

/// Passability shared by all ground locomotors, plus per-cell connectivity labels.
#[derive(Clone)]
pub struct Passability {
    pub blocked: Vec<bool>,
    pub component: Vec<u32>,
    /// Cells per connectivity label of `component` (index 0 unused).
    pub sizes: Vec<u32>,
    pub version: u32,
    dirty: bool,
    /// Crush classes of the wall on each blocked cell (`CRUSH_WALL`,
    /// `CRUSH_HEAVY_WALL`; OpenRA Crushable CrushClasses), 0 elsewhere.
    pub crush: Vec<u8>,
    /// Connectivity labels with the walls of a crush class mask open, per
    /// mask that walls on the map have (`components_for`).
    crush_components: Vec<(u8, Vec<u32>)>,
    /// Crush classes of all walls on the map, as of the last `refresh`.
    pub crush_present: u8,
    /// Cells whose passability changed, with the version the change took
    /// effect in (the `refresh` after it) and whether the cell is blocked
    /// now. `CHANGE_ALL` stands for a change fields cannot locate (a wall
    /// changing hands). Fields older than a change ask `changes_since`.
    changes: Vec<(u32, u32, bool)>,
    /// Version of the oldest change still in `changes`.
    changes_from: u32,
    /// Only path costs changed (ore came or went): the next `refresh` is a
    /// new version without new connectivity labels.
    cost_dirty: bool,
}

/// `Passability::changes` cell for a change that may affect any cell.
const CHANGE_ALL: u32 = u32::MAX;
/// Changes kept; fields older than the oldest kept recompute.
const CHANGES_KEPT: usize = 4096;

/// Crush class bits of walls (OpenRA Crushable CrushClasses `wall`, `heavywall`).
pub const CRUSH_WALL: u8 = 1;
pub const CRUSH_HEAVY_WALL: u8 = 2;

/// The crush class bits of OpenRA crush class names.
pub fn crush_bits<'a>(classes: impl IntoIterator<Item = &'a String>) -> u8 {
    classes.into_iter().fold(0, |m, c| {
        m | match c.as_str() {
            "wall" => CRUSH_WALL,
            "heavywall" => CRUSH_HEAVY_WALL,
            _ => 0,
        }
    })
}

/// A flow field for units that crush walls (OpenRA Locomotor
/// CanMoveFreelyInto: cells whose actors are all crushable by the player are
/// free). `player` is the crushers' owner; `blocked` is the passability with
/// the walls they may crush open (World::crusher_blocked).
pub struct Crush<'a> {
    pub player: u8,
    pub blocked: &'a [bool],
}

impl Passability {
    /// Passability for land units.
    pub fn new(map: &Map) -> Self {
        Passability::with(map, |t| t.passable())
    }

    /// Passability for ships: open water and fords.
    pub fn water(map: &Map) -> Self {
        Passability::with(map, |t| t.ship_passable())
    }

    /// Passability for landing craft: water, fords and beaches.
    pub fn landing(map: &Map) -> Self {
        Passability::with(map, |t| t.landing_passable())
    }

    fn with(map: &Map, open: impl Fn(crate::map::Terrain) -> bool) -> Self {
        let blocked = map.terrain.iter().map(|&t| !open(t)).collect();
        let n = map.cells();
        let mut p = Passability {
            blocked,
            component: vec![0; n],
            sizes: Vec::new(),
            version: 1,
            dirty: true,
            crush: vec![0; n],
            crush_components: Vec::new(),
            crush_present: 0,
            changes: Vec::new(),
            changes_from: 1,
            cost_dirty: false,
        };
        p.refresh(map);
        p
    }

    /// Note a change for the fields; it takes effect in the next version.
    fn log(&mut self, cell: u32, blocked: bool) {
        self.changes.push((self.version + 1, cell, blocked));
        if self.changes.len() > CHANGES_KEPT {
            let drop = self.changes.len() - CHANGES_KEPT;
            self.changes.drain(..drop);
            self.changes_from = self.changes[0].0;
        }
    }

    /// The changes since passability version `since` as (cell, blocked
    /// now), or None when they are too many to tell (or cannot be located).
    pub fn changes_since(&self, since: u32) -> Option<&[(u32, u32, bool)]> {
        if since >= self.version {
            return Some(&[]);
        }
        if since + 1 < self.changes_from {
            return None;
        }
        let start = self.changes.partition_point(|c| c.0 <= since);
        let list = &self.changes[start..];
        if list.iter().any(|c| c.1 == CHANGE_ALL) {
            return None;
        }
        Some(list)
    }

    /// The path cost of cell `i` changed (its ore ran out or grew): fields
    /// covering it recompute after the next `refresh`.
    pub fn note_cost_change(&mut self, i: usize) {
        self.cost_dirty = true;
        self.log(i as u32, self.blocked[i]);
    }

    /// Set the crush classes of the wall on cell `i` (0: none).
    pub fn set_crush(&mut self, i: usize, bits: u8) {
        if self.crush[i] != bits {
            self.crush[i] = bits;
            self.dirty = true;
            self.log(i as u32, self.blocked[i]);
        }
    }

    /// Connectivity labels for units that crush walls of `mask` (any owner's
    /// walls open), or the plain labels when no such wall is on the map.
    pub fn components_for(&self, mask: u8) -> &[u32] {
        self.crush_components.iter().find(|(m, _)| *m == mask).map_or(&self.component, |(_, c)| c)
    }

    /// Cells in the connected area of cell `i` (0 for a blocked cell).
    pub fn area_size(&self, i: usize) -> u32 {
        self.sizes.get(self.component[i] as usize).copied().unwrap_or(0)
    }

    /// Whether cell `i` is open for units that crush walls of `mask` (labels of `components_for`).
    #[inline]
    pub fn open_for(&self, i: usize, mask: u8) -> bool {
        !self.blocked[i] || self.crush[i] & mask != 0
    }

    /// Something besides blocked cells changed that fields depend on (who
    /// may crush a wall): fields recompute on the next lookup.
    pub fn touch(&mut self) {
        self.dirty = true;
        self.log(CHANGE_ALL, false);
    }

    pub fn set_blocked(&mut self, i: usize, b: bool) {
        if self.blocked[i] != b {
            self.blocked[i] = b;
            self.dirty = true;
            self.log(i as u32, b);
        }
    }

    /// Recompute connectivity labels after passability changed. Returns true if anything changed.
    pub fn refresh(&mut self, map: &Map) -> bool {
        if !self.dirty {
            if self.cost_dirty {
                self.cost_dirty = false;
                self.version += 1;
                return true;
            }
            return false;
        }
        self.dirty = false;
        self.cost_dirty = false;
        self.version += 1;
        label(map, &self.blocked, &mut self.component);
        let labels = self.component.iter().copied().max().unwrap_or(0) as usize;
        self.sizes = vec![0; labels + 1];
        for &c in &self.component {
            self.sizes[c as usize] += 1;
        }
        // Walls the crushers of a class mask drive through (OpenRA: tanks
        // path over enemy walls): one more labelling per mask in use.
        let present = self.crush.iter().fold(0u8, |m, &c| m | c);
        self.crush_present = present;
        self.crush_components.clear();
        for mask in [CRUSH_WALL, CRUSH_WALL | CRUSH_HEAVY_WALL] {
            if present & mask != 0 {
                let open: Vec<bool> = (0..map.cells()).map(|i| self.blocked[i] && self.crush[i] & mask == 0).collect();
                let mut labels = vec![0; map.cells()];
                label(map, &open, &mut labels);
                self.crush_components.push((mask, labels));
            }
        }
        true
    }
}

/// Connectivity labels (1, 2, ...; 0 for blocked cells) of the open cells.
fn label(map: &Map, blocked: &[bool], component: &mut [u32]) {
    let n = map.cells();
    component.iter_mut().for_each(|c| *c = 0);
    let mut next = 1u32;
    let mut stack = Vec::new();
    for start in 0..n {
        if blocked[start] || component[start] != 0 {
            continue;
        }
        component[start] = next;
        stack.push(start);
        while let Some(i) = stack.pop() {
            let (x, y) = ((i as i32) % map.width, (i as i32) / map.width);
            for d in 0..8 {
                if let Some(j) = step(map, blocked, x, y, d) {
                    if component[j] == 0 {
                        component[j] = next;
                        stack.push(j);
                    }
                }
            }
        }
        next += 1;
    }
}

/// Neighbour index of (x, y) in direction `d` if the step is legal: the
/// target is passable and diagonal steps do not cut a blocked corner.
#[inline]
pub fn step(map: &Map, blocked: &[bool], x: i32, y: i32, d: usize) -> Option<usize> {
    let (dx, dy) = DIRS[d];
    let (nx, ny) = (x + dx, y + dy);
    if !map.contains(nx, ny) {
        return None;
    }
    let j = map.idx(nx, ny);
    if blocked[j] {
        return None;
    }
    if dx != 0 && dy != 0 && (blocked[map.idx(x + dx, y)] || blocked[map.idx(x, y + dy)]) {
        return None;
    }
    Some(j)
}

#[derive(Clone)]
pub struct FlowCache {
    fields: Vec<FlowField>,
    index: BTreeMap<(u32, u8, u8), usize>,
    /// Slot of the last field looked up: units of one group ask for the same
    /// field one after another, so this skips most index lookups.
    last: usize,
    clock: u64,
    /// Fields computed (or recomputed, or extended) so far. A counter for
    /// the performance panel and tests, never part of the state hash.
    pub computed: u64,
    /// Cells expanded by the searches so far (the work done), as `computed`.
    pub expanded: u64,
}

impl FlowCache {
    pub fn new() -> Self {
        FlowCache { fields: Vec::new(), index: BTreeMap::new(), last: usize::MAX, clock: 0, computed: 0, expanded: 0 }
    }

    /// Direction byte for `cell` in the complete field toward `goal`,
    /// computing the field if needed (tests and tools; units use `field_at`).
    pub fn dir(&mut self, map: &Map, pass: &Passability, locos: &[Locomotor], goal: u32, loco: u8, cell: usize) -> u8 {
        let f = self.get(map, pass, locos, (goal, loco), None, None);
        self.fields[f].dirs[cell]
    }

    /// The complete, current field toward `goal` for locomotor `loco`,
    /// computing it if needed (tests and tools; units use `field_at`).
    pub fn field(&mut self, map: &Map, pass: &Passability, locos: &[Locomotor], goal: u32, loco: u8) -> &FlowField {
        let f = self.get(map, pass, locos, (goal, loco), None, None);
        &self.fields[f]
    }

    /// The field toward `key.0` (the goal) for locomotor `key.1` as a unit
    /// on `cell` follows it: it covers `cell` (or `cell` cannot reach the
    /// goal) and is current for every change that touches what it covers.
    /// With `crush` the unit crushes walls (`Crush`): fields are per player then.
    pub fn field_at(
        &mut self,
        map: &Map,
        pass: &Passability,
        locos: &[Locomotor],
        key: (u32, u8),
        crush: Option<Crush>,
        cell: usize,
    ) -> &FlowField {
        let f = self.get(map, pass, locos, key, crush, Some(cell));
        &self.fields[f]
    }

    /// The cached field toward `goal` for locomotor `loco` (and `crusher`:
    /// 0, or 1 + the crushing player), if there is one: the field the units
    /// follow, which may be older than the passability (see the module
    /// doc). Read only (debug views): never computes, evicts or touches the
    /// use clock.
    pub fn peek(&self, goal: u32, loco: u8, crusher: u8) -> Option<&[u8]> {
        let &i = self.index.get(&(goal, loco, crusher))?;
        Some(self.fields[i].dirs.as_slice())
    }

    /// Number of cached fields.
    pub fn len(&self) -> usize {
        self.fields.len()
    }

    pub fn is_empty(&self) -> bool {
        self.fields.is_empty()
    }

    /// Slot of the field for `key` (goal, locomotor) and `crush`, computed,
    /// extended or refreshed as `cell` needs (None: complete and current).
    fn get(
        &mut self,
        map: &Map,
        pass: &Passability,
        locos: &[Locomotor],
        key: (u32, u8),
        crush: Option<Crush>,
        cell: Option<usize>,
    ) -> usize {
        let (goal, loco) = key;
        self.clock += 1;
        let crusher = crush.as_ref().map_or(0, |c| c.player + 1);
        let blocked: &[bool] = crush.as_ref().map_or(&pass.blocked, |c| c.blocked);
        let hit = match self.fields.get(self.last) {
            Some(f) if f.goal == goal && f.loco == loco && f.crusher == crusher => Some(self.last),
            _ => self.index.get(&(goal, loco, crusher)).copied(),
        };
        if let Some(i) = hit {
            self.last = i;
            let f = &mut self.fields[i];
            f.last_used = self.clock;
            let mut current = f.version == pass.version;
            if !current {
                // Changes the field cannot have noticed leave it as it is.
                let untouched =
                    pass.changes_since(f.version).is_some_and(|list| !list.iter().any(|&(_, c, _)| f.touched_by(map, c as usize)));
                if untouched {
                    f.version = pass.version;
                    current = true;
                }
            }
            let (recompute, extend) = match cell {
                None => (!current || !f.complete, false),
                Some(c) if f.dirs[c] != DIR_NONE => (!current, false),
                // Not covered: extend a partial field.
                Some(_) => (!current || !f.complete, current && !f.complete),
            };
            if recompute {
                let min_bound = if extend { f.bound.saturating_mul(2) } else { 0 };
                let target = cell.map(|c| (c, min_bound));
                let (complete, bound, expanded) = compute(map, blocked, &locos[loco as usize], goal, &mut f.dirs, &mut f.dist, target);
                f.complete = complete;
                f.bound = bound;
                f.version = pass.version;
                self.computed += 1;
                self.expanded += expanded;
            }
            return i;
        }
        let max = (CACHE_CELL_BUDGET / map.cells().max(1)).clamp(MIN_CACHED, MAX_CACHED);
        let slot = if self.fields.len() < max {
            let n = map.cells();
            self.fields.push(FlowField {
                goal,
                loco,
                crusher,
                version: 0,
                dirs: vec![DIR_NONE; n],
                dist: vec![DIST_NONE; n],
                last_used: 0,
                complete: false,
                bound: 0,
            });
            self.fields.len() - 1
        } else {
            // Evict the least recently used field.
            let (i, _) = self.fields.iter().enumerate().min_by_key(|(_, f)| f.last_used).unwrap();
            let old = &self.fields[i];
            self.index.remove(&(old.goal, old.loco, old.crusher));
            i
        };
        let f = &mut self.fields[slot];
        f.goal = goal;
        f.loco = loco;
        f.crusher = crusher;
        f.last_used = self.clock;
        let (complete, bound, expanded) =
            compute(map, blocked, &locos[loco as usize], goal, &mut f.dirs, &mut f.dist, cell.map(|c| (c, 0)));
        f.complete = complete;
        f.bound = bound;
        f.version = pass.version;
        self.computed += 1;
        self.expanded += expanded;
        self.index.insert((goal, loco, crusher), slot);
        self.last = slot;
        slot
    }
}

impl Default for FlowCache {
    fn default() -> Self {
        Self::new()
    }
}

/// Dijkstra from the goal outward. Moving into a cell costs more on slow
/// terrain for this locomotor (OpenRA TerrainSpeeds).
///
/// With a `target` (cell, least bound) the search stops once the target
/// cell is settled and the cost is `BOUND_MARGIN` past it (and past the
/// least bound): a partial field. Returns whether the field is complete,
/// the cost it covers, and the cells expanded.
fn compute(
    map: &Map,
    blocked: &[bool],
    loco: &Locomotor,
    goal: u32,
    dirs: &mut [u8],
    dist: &mut [u16],
    target: Option<(usize, u32)>,
) -> (bool, u32, u64) {
    let n = map.cells();
    dirs.iter_mut().for_each(|d| *d = DIR_NONE);
    dist.iter_mut().for_each(|d| *d = DIST_NONE);
    let mut cost = vec![u32::MAX; n];
    let g = goal as usize;
    if g >= n || blocked[g] {
        return (true, u32::MAX, 0);
    }
    let ship = loco.domain == crate::rules::Domain::Water;
    let cell_cost = |i: usize| -> u32 {
        let s = loco.speeds[map.speed_class_for(i, ship)].max(1) as u32;
        100 * 100 / s
    };
    cost[g] = 0;
    dirs[g] = DIR_GOAL;
    dist[g] = 0;
    let mut heap = BinaryHeap::new();
    heap.push(Reverse((0u32, g as u32)));
    // Every cell with a final cost up to `limit` is expanded before a pop
    // beyond it; a partial field settles those cells and no others.
    let (target_cell, mut limit) = match target {
        Some((c, min_bound)) => (Some(c), min_bound),
        None => (None, u32::MAX),
    };
    let mut target_settled = target_cell.is_none();
    let mut complete = true;
    let mut expanded = 0u64;
    while let Some(Reverse((c, i))) = heap.pop() {
        let i = i as usize;
        if c > cost[i] {
            continue;
        }
        if c > limit && target_settled {
            complete = false;
            break;
        }
        if Some(i) == target_cell {
            target_settled = true;
            limit = limit.max(c.saturating_add(BOUND_MARGIN));
        }
        expanded += 1;
        let (x, y) = ((i as i32) % map.width, (i as i32) / map.width);
        let enter = cell_cost(i);
        for d in 0..8 {
            // Neighbour n reaches i by stepping in the opposite direction; the
            // corner rule is symmetric so checking from i is equivalent.
            if let Some(j) = step(map, blocked, x, y, d) {
                let base = if d % 2 == 0 { COST_STRAIGHT } else { COST_DIAGONAL };
                let nc = c + base * enter / 100;
                if nc < cost[j] {
                    cost[j] = nc;
                    heap.push(Reverse((nc, j as u32)));
                }
            }
        }
    }
    let limit = if complete { u32::MAX } else { limit };
    // Pick each cell's direction after the costs are final. Among equally cheap
    // steps the choice must not depend on the scan order (north first, low cell
    // index first), or units would move differently on the two halves of a
    // symmetric map. Prefer the step that ends closest to the goal, then the
    // one closer to the map centre; both stay the same under the mirrorings
    // and rotations a fair map uses.
    let (gx, gy) = ((g as i32) % map.width, (g as i32) / map.width);
    for j in 0..n {
        if cost[j] == u32::MAX || cost[j] > limit || j == g {
            continue;
        }
        // A step costs at least COST_STRAIGHT unless the terrain is faster
        // than clear, so this usually drops by at least one per step.
        dist[j] = (cost[j] / COST_STRAIGHT).min(DIST_NONE as u32 - 1) as u16;
        let (x, y) = ((j as i32) % map.width, (j as i32) / map.width);
        let mut best: Option<(i32, i32, u8)> = None;
        for (d, &(dx, dy)) in DIRS.iter().enumerate() {
            let Some(i) = step(map, blocked, x, y, d) else { continue };
            if cost[i] == u32::MAX || cost[i] > limit {
                continue;
            }
            let base = if d % 2 == 0 { COST_STRAIGHT } else { COST_DIAGONAL };
            if cost[i] + base * cell_cost(i) / 100 != cost[j] {
                continue;
            }
            let to_goal = (gx - x - dx).pow(2) + (gy - y - dy).pow(2);
            let to_centre = centre_distance(map, x + dx, y + dy);
            if best.is_none_or(|(bd, bc, _)| (to_goal, to_centre) < (bd, bc)) {
                best = Some((to_goal, to_centre, d as u8));
            }
        }
        if let Some((_, _, d)) = best {
            dirs[j] = d;
        }
    }
    (complete, limit, expanded)
}

/// Squared distance of a cell to the map centre, in half cells. Used to break
/// ties the same way on every half of a symmetric map.
#[inline]
pub fn centre_distance(map: &Map, x: i32, y: i32) -> i32 {
    (2 * x - (map.width - 1)).pow(2) + (2 * y - (map.height - 1)).pow(2)
}

/// Nearest cell to `goal` (by straight distance) that lies in `component`.
/// Used when a goal is blocked or on an unreachable island. Ties go to the
/// cell closest to `from` (where the units come from), then to the one
/// closest to the map centre, so the choice is the same on both halves of a
/// symmetric map.
pub fn nearest_in_component(map: &Map, pass: &Passability, goal: (i32, i32), component: u32, from: (i32, i32)) -> Option<u32> {
    nearest_in_labels(map, &pass.component, |i| !pass.blocked[i], goal, component, from)
}

/// `nearest_in_component` over connectivity `labels` whose cells `open` says
/// a unit can stand on (crushers: `Passability::components_for`).
pub fn nearest_in_labels(
    map: &Map,
    labels: &[u32],
    open: impl Fn(usize) -> bool,
    goal: (i32, i32),
    component: u32,
    from: (i32, i32),
) -> Option<u32> {
    let gi = map.idx(goal.0, goal.1);
    if labels[gi] == component && open(gi) {
        return Some(gi as u32);
    }
    let max_r = map.width.max(map.height);
    for r in 1..max_r {
        let mut best: Option<((i32, i32, i32), u32)> = None;
        for y in goal.1 - r..=goal.1 + r {
            for x in goal.0 - r..=goal.0 + r {
                if (x - goal.0).abs() != r && (y - goal.1).abs() != r {
                    continue;
                }
                if !map.contains(x, y) {
                    continue;
                }
                let i = map.idx(x, y);
                if labels[i] == component && open(i) {
                    let d = (x - goal.0).pow(2) + (y - goal.1).pow(2);
                    let df = (x - from.0).pow(2) + (y - from.1).pow(2);
                    let key = (d, df, centre_distance(map, x, y));
                    if best.is_none_or(|(bk, bi)| key < bk || (key == bk && (i as u32) < bi)) {
                        best = Some((key, i as u32));
                    }
                }
            }
        }
        if let Some((_, i)) = best {
            return Some(i);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::map::{Map, Terrain};

    fn open_map(w: i32, h: i32) -> Map {
        let n = (w * h) as usize;
        Map { width: w, height: h, terrain: vec![Terrain::Clear; n], ore: vec![0; n], gems: vec![0; n], spawns: vec![] }
    }

    fn walk(map: &Map, pass: &Passability, cache: &mut FlowCache, locos: &[Locomotor], from: (i32, i32), goal: u32) -> usize {
        let (mut x, mut y) = from;
        for steps in 0..10_000 {
            let i = map.idx(x, y);
            let d = cache.dir(map, pass, locos, goal, 0, i);
            if d == DIR_GOAL {
                return steps;
            }
            assert_ne!(d, DIR_NONE, "dead end at {x},{y}");
            assert!(!pass.blocked[i]);
            x += DIRS[d as usize].0;
            y += DIRS[d as usize].1;
        }
        panic!("no arrival");
    }

    #[test]
    fn routes_around_a_wall() {
        let mut map = open_map(20, 20);
        for y in 0..18 {
            let i = map.idx(10, y);
            map.terrain[i] = Terrain::Rock;
        }
        let pass = Passability::new(&map);
        let locos = vec![Locomotor {
            name: "t".into(),
            domain: crate::rules::Domain::Ground,
            speeds: vec![100, 50, 88, 0, 125, 125, 50],
            crushes_infantry: true,
            crushes: vec!["infantry".into()],
        }];
        let mut cache = FlowCache::new();
        let goal = map.idx(15, 2) as u32;
        let steps = walk(&map, &pass, &mut cache, &locos, (2, 2), goal);
        assert!(steps >= 18, "must go around the wall, took {steps}");
        // Second query reuses the cached field.
        walk(&map, &pass, &mut cache, &locos, (5, 5), goal);
        assert_eq!(cache.computed, 1);
    }

    #[test]
    fn path_length_drops_along_the_field() {
        let mut map = open_map(20, 20);
        for y in 0..18 {
            let i = map.idx(10, y);
            map.terrain[i] = Terrain::Rock;
        }
        for x in 0..20 {
            let i = map.idx(x, 19);
            map.terrain[i] = Terrain::Rough;
        }
        let pass = Passability::new(&map);
        let locos = vec![Locomotor {
            name: "t".into(),
            domain: crate::rules::Domain::Ground,
            speeds: vec![100, 50, 88, 0, 125, 125, 50],
            crushes_infantry: true,
            crushes: vec!["infantry".into()],
        }];
        let mut cache = FlowCache::new();
        let goal = map.idx(15, 2) as u32;
        let f = cache.field(&map, &pass, &locos, goal, 0);
        assert_eq!(f.dist[goal as usize], 0);
        assert_eq!(f.dist[map.idx(10, 5)], DIST_NONE, "rock");
        for start in 0..map.cells() {
            if pass.blocked[start] {
                continue;
            }
            let (mut x, mut y) = ((start as i32) % 20, (start as i32) / 20);
            loop {
                let i = map.idx(x, y);
                let d = f.dirs[i];
                if d == DIR_GOAL {
                    break;
                }
                let (nx, ny) = (x + DIRS[d as usize].0, y + DIRS[d as usize].1);
                assert!(f.dist[map.idx(nx, ny)] < f.dist[i], "path length drops by a step");
                (x, y) = (nx, ny);
            }
        }
        // Around the wall: from (8, 2) the path is far longer than the 7 cells straight.
        assert!(f.dist[map.idx(8, 2)] >= 20);
    }

    #[test]
    fn unreachable_goal_maps_to_nearest_reachable_cell() {
        let mut map = open_map(20, 20);
        for y in 0..20 {
            let i = map.idx(10, y);
            map.terrain[i] = Terrain::Water;
        }
        let pass = Passability::new(&map);
        let comp = pass.component[map.idx(2, 2)];
        let g = nearest_in_component(&map, &pass, (15, 5), comp, (2, 2)).unwrap();
        assert_eq!(g, map.idx(9, 5) as u32);
    }
}

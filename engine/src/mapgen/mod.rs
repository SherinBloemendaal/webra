//! Map styles of the skirmish generator (map.rs): connected water networks,
//! cliffs with passes, and the ore that follows the layout.
//!
//! map.rs places the bases and keeps them fair (mirrored for two players,
//! identical pockets for 3 to 8); this module draws the land and water around
//! them. A style is picked per seed (`MapStyle::Random`) or in the lobby:
//!
//! - **Land**: open plains, or highlands with long cliffs and narrow passes.
//!   Only small ponds, no harbours.
//! - **Rivers**: river valleys running from a confluence pool at the centre to
//!   the map edges, with fords every few cells, pools and tributaries.
//! - **Lakes**: a lake district: a central lake and satellite lakes, most of
//!   them linked to the centre by streams.
//! - **Islands**: a central sea with bays, islands (some with ore) and straits
//!   out to the map edges.
//!
//! Water radiates from the map centre along spokes that run between the bases
//! (the angular midpoints of neighbouring bases seen from the centre), so a
//! river never runs through a base. Features are drawn on the left half and
//! mirrored like the rest of the map (four players in two rows and rings of
//! six or eight: also top to bottom, so the bases above and below the middle
//! see the same water). In the naval styles every base gets a harbour: two
//! players a bay along the map edge behind the base, 3 to 8 players water
//! moats north and south of the pocket, of which the one with the cheapest
//! channel to the water network (the one facing the hub on ties) is dug
//! through and the other one becomes the usual rock wall; with the top to
//! bottom mirror a base below the middle gets the mirror image of its
//! partner's channel. Ground routes that have to cross water become fords
//! (`Terrain::Ford`), which ships still sail over, so the ground network and
//! the water network are both connected; roads are mirrored like the map.

use crate::map::{Map, Terrain};
use crate::math::facing_vec;
use crate::rng::Rng;
use std::cmp::Reverse;
use std::collections::BinaryHeap;

pub mod metrics;
pub mod settlements;
pub mod sites;
#[cfg(test)]
mod tests;

/// Salt for picking the style of `MapStyle::Random` from the game seed.
const STYLE_SALT: u64 = 0x57a1_e000_0000_0001;

/// Layout family of a generated map (lobby option `mapStyle`).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum MapStyle {
    /// One of the others, picked from the seed.
    #[default]
    Random,
    Land,
    Rivers,
    Lakes,
    Islands,
}

impl MapStyle {
    /// The styles `Random` picks from, in the order the seed indexes them.
    pub const CONCRETE: [MapStyle; 4] = [MapStyle::Land, MapStyle::Rivers, MapStyle::Lakes, MapStyle::Islands];

    pub fn name(self) -> &'static str {
        match self {
            MapStyle::Random => "random",
            MapStyle::Land => "land",
            MapStyle::Rivers => "rivers",
            MapStyle::Lakes => "lakes",
            MapStyle::Islands => "islands",
        }
    }

    pub fn from_name(s: &str) -> Option<MapStyle> {
        Some(match s {
            "random" => MapStyle::Random,
            "land" => MapStyle::Land,
            "rivers" => MapStyle::Rivers,
            "lakes" => MapStyle::Lakes,
            "islands" => MapStyle::Islands,
            _ => return None,
        })
    }

    /// The concrete style for a seed: `Random` picks one, others stay.
    pub fn resolve(self, seed: u64) -> MapStyle {
        match self {
            MapStyle::Random => Self::CONCRETE[Rng::new(seed ^ STYLE_SALT).range(0, Self::CONCRETE.len() as i32) as usize],
            s => s,
        }
    }

    /// Styles with a water network and a harbour per base.
    pub fn naval(self) -> bool {
        matches!(self, MapStyle::Rivers | MapStyle::Lakes | MapStyle::Islands)
    }
}

/// Mask values: what a feature puts on a cell.
pub(crate) const LAND: u8 = 0;
pub(crate) const WATER: u8 = 1;
pub(crate) const FORD: u8 = 2;

/// A layer of water features, drawn before it is laid onto the terrain.
pub(crate) struct Mask {
    pub w: i32,
    pub h: i32,
    pub v: Vec<u8>,
}

impl Mask {
    fn new(w: i32, h: i32) -> Mask {
        Mask { w, h, v: vec![LAND; (w * h) as usize] }
    }

    fn contains(&self, x: i32, y: i32) -> bool {
        x >= 0 && y >= 0 && x < self.w && y < self.h
    }

    fn get(&self, x: i32, y: i32) -> u8 {
        if self.contains(x, y) {
            self.v[(y * self.w + x) as usize]
        } else {
            LAND
        }
    }

    /// Set a cell unless it lies in a base area.
    fn set(&mut self, x: i32, y: i32, val: u8, zone: &[bool]) {
        if self.contains(x, y) {
            let i = (y * self.w + x) as usize;
            if !zone[i] {
                self.v[i] = val;
            }
        }
    }

    fn disk(&mut self, x: i32, y: i32, r: i32, val: u8, zone: &[bool]) {
        for oy in -r..=r {
            for ox in -r..=r {
                if ox * ox + oy * oy <= r * r + r {
                    self.set(x + ox, y + oy, val, zone);
                }
            }
        }
    }

    /// Ragged disk (lakes, seas): the edge wobbles by up to a cell.
    fn blob(&mut self, rng: &mut Rng, x: i32, y: i32, r: i32, val: u8, zone: &[bool]) {
        for oy in -r - 1..=r + 1 {
            for ox in -r - 1..=r + 1 {
                let d = ox * ox + oy * oy;
                if d <= r * r + rng.range(-r, r + 1) * 2 {
                    self.set(x + ox, y + oy, val, zone);
                }
            }
        }
    }

    /// Turn the water of a disk into a ford (the river bed stays, ground units can wade).
    fn ford(&mut self, x: i32, y: i32, r: i32, zone: &[bool]) {
        for oy in -r..=r {
            for ox in -r..=r {
                if ox * ox + oy * oy <= r * r + r && self.get(x + ox, y + oy) == WATER {
                    self.set(x + ox, y + oy, FORD, zone);
                }
            }
        }
    }

    fn mirror_x(&mut self) {
        for y in 0..self.h {
            for x in 0..self.w / 2 {
                let (i, j) = ((y * self.w + x) as usize, (y * self.w + self.w - 1 - x) as usize);
                self.v[j] = self.v[i];
            }
        }
    }

    fn mirror_y(&mut self) {
        for y in 0..self.h / 2 {
            for x in 0..self.w {
                let (i, j) = ((y * self.w + x) as usize, ((self.h - 1 - y) * self.w + x) as usize);
                self.v[j] = self.v[i];
            }
        }
    }
}

/// Where the bases are, as far as the features need to know.
pub(crate) struct Layout {
    /// Yard centres of every base.
    pub bases: Vec<(i32, i32)>,
    /// Base areas: features never draw there and channels never dig there.
    pub zone: Vec<bool>,
    /// Water is also mirrored top to bottom (four players in two rows).
    pub flip_y: bool,
}

/// What a style drew: the water layer and the spots its ore goes to.
pub(crate) struct Features {
    pub mask: Mask,
    /// Ore fields (x, y, radius) on the canonical part of the map (left half;
    /// top-left quarter with `flip_y`), mirrored by the caller.
    pub spots: Vec<(i32, i32, i32)>,
    /// The hub cell: the water network grows from here (naval styles).
    pub hub: (i32, i32),
}

/// The hub of the water network: a cell on the mirror axis, at the height
/// where the farthest base is as near as possible (the map centre when the
/// bases surround it evenly; lower for three players, whose third base sits
/// alone in the bottom row). Returns the cell and its centre in 1/1024 cells
/// (x exactly on the mirror axis).
pub(crate) fn hub(w: i32, h: i32, bases: &[(i32, i32)]) -> ((i32, i32), (i32, i32)) {
    let far = |y: i32| -> i64 {
        bases
            .iter()
            .map(|&(bx, by)| {
                let (dx, dy) = ((bx * 1024 + 512 - w * 512) as i64, ((by - y) * 1024) as i64);
                dx * dx + dy * dy
            })
            .max()
            .unwrap_or(0)
    };
    let y = (h / 4..=h * 3 / 4).min_by_key(|&y| (far(y), (y - h / 2).abs(), y)).unwrap_or(h / 2);
    ((w / 2, y), (w * 512, y * 1024 + 512))
}

/// Angles (1024 = full turn, 0 = north) halfway between neighbouring bases,
/// seen from the hub: water runs out along these spokes.
fn spokes(centre: (i32, i32), bases: &[(i32, i32)]) -> Vec<i32> {
    let mut angles: Vec<i32> =
        bases.iter().filter_map(|&(x, y)| crate::math::facing_of(x * 1024 + 512 - centre.0, y * 1024 + 512 - centre.1)).collect();
    angles.sort_unstable();
    angles.dedup();
    if angles.len() < 2 {
        return vec![0, 512];
    }
    let n = angles.len();
    (0..n)
        .map(|k| {
            let a = angles[k];
            let b = if k + 1 < n { angles[k + 1] } else { angles[0] + 1024 };
            ((a + b) / 2) % 1024
        })
        .collect()
}

/// Spokes within this many angle units of a mirror axis are drawn straight on it.
const AXIS_SNAP: i32 = 48;

/// The spoke angle snapped onto a mirror axis, if it is close to one.
fn axis_angle(a: i32, flip_y: bool) -> Option<i32> {
    let axes: &[i32] = if flip_y { &[0, 256, 512, 768, 1024] } else { &[0, 512, 1024] };
    axes.iter().find(|&&x| (a - x).abs() <= AXIS_SNAP).map(|&x| x % 1024)
}

/// Whether a spoke is drawn (the rest are its mirror images): the left half,
/// and with `flip_y` the top-left quarter, axes included.
fn canonical(a: i32, flip_y: bool) -> bool {
    if flip_y {
        a == 0 || a >= 768
    } else {
        a == 0 || a >= 512
    }
}

/// Cells along a spoke from `from` cells out to the map edge, with a lateral
/// meander of at most `amp` cells (none on a mirror axis).
#[allow(clippy::too_many_arguments)]
fn spoke_path(w: i32, h: i32, centre: (i32, i32), angle: i32, from: i32, amp: i32, rng: &mut Rng, straight: bool) -> Vec<(i32, i32)> {
    let (vx, vy) = facing_vec(angle);
    let (cx, cy) = centre;
    let mut out: Vec<(i32, i32)> = Vec::new();
    let mut off = 0;
    let mut t = from.max(0);
    loop {
        if !straight && t % 2 == 0 {
            let lim = amp.min(t / 4);
            off = (off + rng.range(-1, 2)).clamp(-lim, lim);
        }
        let px = cx + vx * t - vy * off;
        let py = cy + vy * t + vx * off;
        let (x, y) = (px.div_euclid(1024), py.div_euclid(1024));
        if x < 0 || y < 0 || x >= w || y >= h {
            break;
        }
        if out.last() != Some(&(x, y)) {
            out.push((x, y));
        }
        t += 1;
        if t > 2 * (w + h) {
            break;
        }
    }
    out
}

/// Cells of a slightly wavy line from a to b.
fn line_path(a: (i32, i32), b: (i32, i32), amp: i32, rng: &mut Rng) -> Vec<(i32, i32)> {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let len = crate::math::isqrt((dx * dx + dy * dy) as i64) as i32;
    let mut out = Vec::new();
    let mut off = 0;
    for t in 0..=len.max(1) {
        if t % 2 == 0 {
            let lim = amp.min(t / 3).min((len - t) / 3).max(0);
            off = (off + rng.range(-1, 2)).clamp(-lim, lim);
        }
        let (x, y) = (a.0 + dx * t / len.max(1), a.1 + dy * t / len.max(1));
        // Perpendicular offset (rounded toward the larger axis).
        let (px, py) = if dx.abs() > dy.abs() { (0, off) } else { (off, 0) };
        if out.last() != Some(&(x + px, y + py)) {
            out.push((x + px, y + py));
        }
    }
    out
}

/// Distance (cells) from the hub to the nearest base area, minus a margin.
fn hub_room(w: i32, h: i32, (cx, cy): (i32, i32), zone: &[bool]) -> i32 {
    let mut best = i32::MAX;
    for y in 0..h {
        for x in 0..w {
            if zone[(y * w + x) as usize] {
                let d = crate::math::isqrt((((x - cx) * (x - cx)) + (y - cy) * (y - cy)) as i64) as i32;
                best = best.min(d);
            }
        }
    }
    (best - 4).clamp(2, w.min(h) / 3)
}

/// Draw the water of a style. Land draws only small ponds (the cliffs are
/// [`draw_land`]).
pub(crate) fn draw_water(w: i32, h: i32, rng: &mut Rng, style: MapStyle, layout: &Layout) -> Features {
    let (hub_cell, centre) = hub(w, h, &layout.bases);
    let mut f = Features { mask: Mask::new(w, h), spots: Vec::new(), hub: hub_cell };
    let zone = &layout.zone;
    let flip = layout.flip_y;
    let room = hub_room(w, h, hub_cell, zone);
    let (cx, cy) = hub_cell;
    let spokes: Vec<i32> = spokes(centre, &layout.bases).into_iter().filter(|&a| canonical(a, flip)).collect();
    let size = w.min(h);
    match style {
        MapStyle::Random | MapStyle::Land => {}
        MapStyle::Rivers => {
            let hub = (2 + rng.range(0, 3)).min(room);
            f.mask.blob(rng, cx, cy, hub, WATER, zone);
            let mut drawn = 0;
            for (k, &a) in spokes.iter().enumerate() {
                // Most spokes carry a river; at least one always does.
                if drawn > 0 && !rng.chance(80) && k + 1 < spokes.len() {
                    continue;
                }
                drawn += 1;
                let straight = axis_angle(a, flip);
                let angle = straight.unwrap_or(a);
                let rw = rng.range(1, 3);
                let path = spoke_path(w, h, centre, angle, hub, 3 + size / 40, rng, straight.is_some());
                let ford_gap = rng.range(11, 16);
                let mut next_ford = hub + 6 + rng.range(0, 4);
                for (t, &(x, y)) in path.iter().enumerate() {
                    f.mask.disk(x, y, rw, WATER, zone);
                    // Pools where the valley widens.
                    if straight.is_none() && t > 6 && rng.chance(4) {
                        f.mask.blob(rng, x, y, rw + 2, WATER, zone);
                    }
                }
                for (t, &(x, y)) in path.iter().enumerate() {
                    if t as i32 == next_ford - hub {
                        f.mask.ford(x, y, rw + 1, zone);
                        // Ore on both banks next to the crossing (the far bank is the mirror image or the next river).
                        let (vx, vy) = facing_vec(angle);
                        let side = rw + 4;
                        f.spots.push((x - vy * side / 1024, y + vx * side / 1024, 2));
                        next_ford += ford_gap;
                    }
                }
                // A tributary from the middle of the river, ending in a pond.
                if path.len() > 16 && rng.chance(60) {
                    let from = path[path.len() * rng.range(35, 60) as usize / 100];
                    let turn = if rng.chance(50) { 1 } else { -1 } * rng.range(96, 176);
                    let (vx, vy) = facing_vec(angle + turn);
                    let len = rng.range(8, 16);
                    let to = (from.0 + vx * len / 1024, from.1 + vy * len / 1024);
                    for (x, y) in line_path(from, to, 2, rng) {
                        f.mask.disk(x, y, 1, WATER, zone);
                    }
                    f.mask.blob(rng, to.0, to.1, 2, WATER, zone);
                    f.spots.push((to.0 + vx * 4 / 1024, to.1 + vy * 4 / 1024, 2));
                }
            }
        }
        MapStyle::Lakes => {
            let hub = (size * rng.range(7, 11) / 100).clamp(3, room.max(3));
            f.mask.blob(rng, cx, cy, hub, WATER, zone);
            for &a in &spokes {
                let straight = axis_angle(a, flip);
                let angle = straight.unwrap_or(a);
                let path = spoke_path(w, h, centre, angle, hub, 2, rng, straight.is_some());
                if path.len() < 10 {
                    continue;
                }
                let at = path[path.len() * rng.range(40, 70) as usize / 100];
                let r = rng.range(3, 6);
                f.mask.blob(rng, at.0, at.1, r, WATER, zone);
                // Most satellite lakes drain into the central lake.
                if rng.chance(75) {
                    let stream = line_path(at, (cx, cy), if straight.is_some() { 0 } else { 2 }, rng);
                    let mid = stream[stream.len() / 2];
                    for &(x, y) in &stream {
                        f.mask.disk(x, y, 1, WATER, zone);
                    }
                    f.mask.ford(mid.0, mid.1, 2, zone);
                }
                let (vx, vy) = facing_vec(angle + 256);
                f.spots.push((at.0 + vx * (r + 4) / 1024, at.1 + vy * (r + 4) / 1024, 3));
            }
            // A few more lakes off the spokes; some feed the network.
            for _ in 0..rng.range(1, 4) {
                let x = rng.range(3, w / 2 - 3);
                let y = if flip { rng.range(3, h / 2 - 3) } else { rng.range(3, h - 3) };
                let r = rng.range(2, 5);
                if (y - r - 2..=y + r + 2)
                    .any(|yy| (x - r - 2..=x + r + 2).any(|xx| f.mask.contains(xx, yy) && zone[(yy * w + xx) as usize]))
                {
                    continue;
                }
                f.mask.blob(rng, x, y, r, WATER, zone);
                if rng.chance(50) {
                    for (sx, sy) in line_path((x, y), (cx, cy), 2, rng) {
                        f.mask.disk(sx, sy, 1, WATER, zone);
                    }
                }
                f.spots.push((x, y + r + 3, 2));
            }
        }
        MapStyle::Islands => {
            let sea = (size * rng.range(16, 25) / 100).clamp(4, room.max(4));
            f.mask.blob(rng, cx, cy, sea, WATER, zone);
            // Bays: lobes on the sea's rim.
            for _ in 0..rng.range(2, 5) {
                let a = if flip { 768 + rng.range(0, 257) } else { 512 + rng.range(0, 513) };
                let (vx, vy) = facing_vec(a);
                let d = sea * rng.range(55, 95) / 100;
                let r = (sea * rng.range(35, 60) / 100).max(2);
                f.mask.blob(rng, cx + vx * d / 1024, cy + vy * d / 1024, r, WATER, zone);
            }
            // Ore on the mainland coast facing each gap between bases.
            for &a in &spokes {
                let (vx, vy) = facing_vec(axis_angle(a, flip).unwrap_or(a));
                let d = sea + 5;
                f.spots.push((cx + vx * d / 1024, cy + vy * d / 1024, 3));
            }
            // Straits out to the map edge on some spokes.
            for &a in &spokes {
                if !rng.chance(60) {
                    continue;
                }
                let straight = axis_angle(a, flip);
                let rw = rng.range(1, 3);
                for (x, y) in spoke_path(w, h, centre, straight.unwrap_or(a), sea - 2, 2, rng, straight.is_some()) {
                    f.mask.disk(x, y, rw, WATER, zone);
                }
            }
            // Islands well inside the sea; some carry ore (ships or aircraft reach them).
            let mut placed = 0;
            for _ in 0..40 {
                if placed >= rng.range(2, 6) {
                    break;
                }
                let x = rng.range(2, w / 2);
                let y = if flip { rng.range(2, h / 2) } else { rng.range(2, h - 2) };
                let r = rng.range(1, 3);
                let clear = r + 2;
                // Never on the hub: the network grows from there.
                if (x - cx).abs() <= r + 4 && (y - cy).abs() <= r + 4 {
                    continue;
                }
                if !(y - clear..=y + clear).all(|yy| (x - clear..=x + clear).all(|xx| f.mask.get(xx, yy) == WATER)) {
                    continue;
                }
                f.mask.disk(x, y, r, LAND, zone);
                if rng.chance(60) {
                    f.spots.push((x, y, r));
                }
                placed += 1;
            }
        }
    }
    if style.naval() {
        // The hub itself is always water (the left cell; the mirror adds the right one).
        f.mask.disk(cx - 1, cy, 1, WATER, zone);
    }
    f.mask.mirror_x();
    if flip {
        f.mask.mirror_y();
    }
    f
}

/// The water network as it stands: everything ships reach from the hub
/// (falling back to the largest body of water if the hub is dry).
pub(crate) fn network_from(m: &Map, hub: (i32, i32)) -> Option<Vec<bool>> {
    let i = m.idx(hub.0.clamp(0, m.width - 1), hub.1.clamp(0, m.height - 1));
    if m.terrain[i].ship_passable() {
        Some(water_network(m, &[i]))
    } else {
        main_network(m)
    }
}

/// Lay a water mask onto the terrain, with shore decoration per style:
/// beaches (rough) on sea coasts, reeds (rough) and trees along rivers and lakes.
pub(crate) fn apply_water(m: &mut Map, f: &Features, style: MapStyle, rng: &mut Rng) {
    for i in 0..m.cells() {
        match f.mask.v[i] {
            WATER => {
                m.terrain[i] = Terrain::Water;
                m.clear_resource(i);
            }
            FORD => {
                m.terrain[i] = Terrain::Ford;
                m.clear_resource(i);
            }
            _ => {}
        }
    }
    let (shore, pct) = match style {
        MapStyle::Islands => (Terrain::Rough, 35),
        MapStyle::Rivers => (Terrain::Tree, 14),
        MapStyle::Lakes => (Terrain::Rough, 18),
        _ => return,
    };
    // Left half only; the caller mirrors the map afterwards.
    for y in 0..m.height {
        for x in 0..m.width / 2 {
            let i = m.idx(x, y);
            if f.mask.v[i] != LAND || m.terrain[i] != Terrain::Clear {
                continue;
            }
            let wet = [(1, 0), (-1, 0), (0, 1), (0, -1)].iter().any(|&(dx, dy)| f.mask.get(x + dx, y + dy) != LAND);
            if wet && rng.chance(pct) {
                m.terrain[i] = shore;
            }
        }
    }
}

/// Land features drawn right after the random scatter, before the map is
/// mirrored: plains get more rough ground and groves, highlands get long
/// cliffs (two cells thick) broken by passes. Returns ore spots (left half).
pub(crate) fn draw_land(m: &mut Map, rng: &mut Rng, style: MapStyle, zone: &[bool]) -> Vec<(i32, i32, i32)> {
    let mut spots = Vec::new();
    if style != MapStyle::Land {
        return spots;
    }
    let (w, h) = (m.width, m.height);
    let set = |m: &mut Map, x: i32, y: i32, t: Terrain| {
        if m.contains(x, y) && !zone[m.idx(x, y)] {
            let i = m.idx(x, y);
            m.terrain[i] = t;
            m.clear_resource(i);
        }
    };
    if rng.chance(45) {
        // Open plains: rough meadows and scattered groves, ore out in the open.
        for _ in 0..(w * h / 1200).max(2) {
            let (x, y, r) = (rng.range(0, w / 2), rng.range(0, h), rng.range(3, 7));
            for oy in -r..=r {
                for ox in -r..=r {
                    if ox * ox + oy * oy <= r * r && rng.chance(70) {
                        set(m, x + ox, y + oy, Terrain::Rough);
                    }
                }
            }
        }
        for _ in 0..rng.range(2, 4) {
            spots.push((rng.range(w / 4, w / 2 - 3), rng.range(h / 5, h - h / 5), 3));
        }
        return spots;
    }
    // Highlands: cliffs across the map with passes every so often.
    for _ in 0..rng.range(2, 5) {
        let (mut x, mut y) = (rng.range(w / 6, w / 2 - 2), rng.range(0, h));
        // Mostly north-south: cliffs stand between the bases and the centre.
        let a = if rng.chance(50) { rng.range(-128, 129) } else { 512 + rng.range(-128, 129) };
        let (vx, vy) = facing_vec(a);
        let len = rng.range(h / 3, h * 2 / 3);
        let gap_every = rng.range(10, 17);
        let mut fx = x * 1024;
        let mut fy = y * 1024;
        for t in 0..len {
            fx += vx;
            fy += vy;
            let wobble = rng.range(-1, 2);
            x = fx.div_euclid(1024) + if vy.abs() > vx.abs() { wobble } else { 0 };
            y = fy.div_euclid(1024) + if vy.abs() > vx.abs() { 0 } else { wobble };
            if t % gap_every < 4 && t > 2 {
                // A pass; ore waits beside it.
                if t % gap_every == 1 {
                    spots.push((x + 3, y, 2));
                }
                continue;
            }
            for (ox, oy) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
                set(m, x + ox, y + oy, Terrain::Rock);
            }
        }
    }
    spots
}

/// Cheapest 4-connected path from any source cell to the first target cell,
/// or None. `cost` gives the price of entering a cell (None: forbidden).
/// Ties resolve by cell index, so the result is the same on every platform.
pub(crate) fn cheapest_path(
    w: i32,
    h: i32,
    sources: &[usize],
    target: &dyn Fn(usize) -> bool,
    cost: &dyn Fn(usize) -> Option<u32>,
) -> Option<(u32, Vec<usize>)> {
    let n = (w * h) as usize;
    let mut dist = vec![u32::MAX; n];
    let mut prev = vec![u32::MAX; n];
    let mut heap = BinaryHeap::new();
    for &s in sources {
        if s < n && dist[s] != 0 {
            dist[s] = 0;
            heap.push(Reverse((0u32, s as u32)));
        }
    }
    while let Some(Reverse((d, i))) = heap.pop() {
        let i = i as usize;
        if d > dist[i] {
            continue;
        }
        if target(i) {
            let mut path = vec![i];
            let mut c = i;
            while prev[c] != u32::MAX {
                c = prev[c] as usize;
                path.push(c);
            }
            path.reverse();
            return Some((d, path));
        }
        let (x, y) = ((i as i32) % w, (i as i32) / w);
        for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
            let (nx, ny) = (x + dx, y + dy);
            if nx < 0 || ny < 0 || nx >= w || ny >= h {
                continue;
            }
            let j = (ny * w + nx) as usize;
            let Some(c) = cost(j) else { continue };
            let nd = d.saturating_add(c);
            if nd < dist[j] {
                dist[j] = nd;
                prev[j] = i as u32;
                heap.push(Reverse((nd, j as u32)));
            }
        }
    }
    None
}

/// Cells reachable by ship from `starts` (4-connected over water and fords).
pub(crate) fn water_network(m: &Map, starts: &[usize]) -> Vec<bool> {
    let mut seen = vec![false; m.cells()];
    let mut stack: Vec<usize> = starts.iter().copied().filter(|&s| m.terrain[s].ship_passable()).collect();
    for &s in &stack {
        seen[s] = true;
    }
    while let Some(i) = stack.pop() {
        let (x, y) = ((i as i32) % m.width, (i as i32) / m.width);
        for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
            if m.contains(x + dx, y + dy) {
                let j = m.idx(x + dx, y + dy);
                if !seen[j] && m.terrain[j].ship_passable() {
                    seen[j] = true;
                    stack.push(j);
                }
            }
        }
    }
    seen
}

/// The water network: the largest body of ship-passable cells (all of the
/// largest when several tie, as mirror images do), or None without water.
pub(crate) fn main_network(m: &Map) -> Option<Vec<bool>> {
    let mut label = vec![u32::MAX; m.cells()];
    let mut sizes: Vec<usize> = Vec::new();
    for start in 0..m.cells() {
        if label[start] != u32::MAX || !m.terrain[start].ship_passable() {
            continue;
        }
        let cells = water_network(m, &[start]);
        for (i, &c) in cells.iter().enumerate() {
            if c {
                label[i] = sizes.len() as u32;
            }
        }
        sizes.push(cells.iter().filter(|&&c| c).count());
    }
    let top = *sizes.iter().max()?;
    Some(label.iter().map(|&l| l != u32::MAX && sizes[l as usize] == top).collect())
}

/// Price of digging a channel through a cell: following water costs
/// `water`, digging 4, and passing close to a base a lot.
fn channel_cost(m: &Map, zone: &[bool], near: &[bool], water: u32, j: usize) -> Option<u32> {
    if zone[j] {
        None
    } else if m.terrain[j].ship_passable() {
        Some(water)
    } else if near[j] {
        Some(40)
    } else {
        Some(4)
    }
}

/// The cheapest channel from harbour cells to any `target` cell: (cost,
/// path). With a low `water` cost the channel joins the network wherever it
/// is nearest; with a cost close to digging it runs nearly straight.
pub(crate) fn plan_channel(
    m: &Map,
    harbour: &[usize],
    target: &[bool],
    zone: &[bool],
    near: &[bool],
    water: u32,
) -> Option<(u32, Vec<usize>)> {
    cheapest_path(m.width, m.height, harbour, &|j| target[j], &|j| channel_cost(m, zone, near, water, j))
}

/// Dig a planned channel two cells wide, and its mirror image.
pub(crate) fn dig_channel(m: &mut Map, path: &[usize], zone: &[bool]) {
    for &p in path {
        let (x, y) = ((p as i32) % m.width, (p as i32) / m.width);
        for (ox, oy) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
            for (cx, cy) in [(x + ox, y + oy), (m.width - 1 - x - ox, y + oy)] {
                if m.contains(cx, cy) {
                    let i = m.idx(cx, cy);
                    if !zone[i] && !m.terrain[i].ship_passable() {
                        m.terrain[i] = Terrain::Water;
                        m.clear_resource(i);
                    }
                }
            }
        }
    }
}

/// Make `b` reachable from `a` (yard top-left cells) by ground: carve the
/// cheapest road three cells wide, clearing rock and trees and turning water
/// into fords, mirrored left to right (with `flip_y` also top to bottom, as
/// the rest of the map is). Cells in `keep` (base walls, moats, harbours)
/// never change. Returns false when no road exists.
pub(crate) fn connect_ground(m: &mut Map, a: (i32, i32), b: (i32, i32), keep: &[bool], flip_y: bool) -> bool {
    if m.connected(a, b) {
        return true;
    }
    let (w, h) = (m.width, m.height);
    let from = m.idx(a.0 + 1, a.1 + 1);
    let to = m.idx(b.0 + 1, b.1 + 1);
    let cost = |j: usize| -> Option<u32> {
        let t = m.terrain[j];
        if t.passable() {
            Some(if t == Terrain::Ford { 2 } else { 1 })
        } else if keep[j] {
            None
        } else if t == Terrain::Water {
            Some(7)
        } else {
            Some(5)
        }
    };
    let Some((_, path)) = cheapest_path(w, h, &[from], &|j| j == to, &cost) else { return false };
    carve_road(m, &path, keep, flip_y);
    m.connected(a, b)
}

/// Land regions of at least this many cells are joined to the bases by
/// ground (smaller ones are islands, reached by ship or air).
pub(crate) const MAINLAND_REGION: usize = 60;

/// Join every large land region to the bases' ground network: a channel or a
/// strait may cut a region off (half the map, say), whose ore no ore truck
/// could then reach. Each region of at least `MAINLAND_REGION` cells gets
/// the cheapest road to the bases (fords over water, mirrored). Small
/// islands stay islands.
pub(crate) fn connect_land_regions(m: &mut Map, home: (i32, i32), keep: &[bool], flip_y: bool) {
    for _ in 0..16 {
        let (w, h) = (m.width, m.height);
        let label = land_components(m);
        let home_cell = m.idx(home.0 + 1, home.1 + 1);
        let main = label[home_cell];
        let mut sizes: std::collections::BTreeMap<u32, (usize, usize)> = std::collections::BTreeMap::new();
        for (i, &l) in label.iter().enumerate() {
            if l != u32::MAX && l != main {
                let e = sizes.entry(l).or_insert((0, i));
                e.0 += 1;
            }
        }
        // The largest cut-off region first (its mirror image follows from the mirrored road).
        let Some((&region, &(size, _))) =
            sizes.iter().filter(|(_, &(n, _))| n >= MAINLAND_REGION).max_by_key(|(&l, &(n, _))| (n, std::cmp::Reverse(l)))
        else {
            return;
        };
        let cost = |j: usize| -> Option<u32> {
            let t = m.terrain[j];
            if t.passable() {
                Some(if t == Terrain::Ford { 2 } else { 1 })
            } else if keep[j] {
                None
            } else if t == Terrain::Water {
                Some(7)
            } else {
                Some(5)
            }
        };
        let sources: Vec<usize> = (0..m.cells()).filter(|&i| label[i] == region).collect();
        let Some((_, path)) = cheapest_path(w, h, &sources, &|j| label[j] == main, &cost) else { return };
        carve_road(m, &path, keep, flip_y);
        let _ = size;
    }
}

/// Labels of 4-connected passable land (u32::MAX elsewhere).
fn land_components(m: &Map) -> Vec<u32> {
    let mut label = vec![u32::MAX; m.cells()];
    let mut next = 0;
    for s in 0..m.cells() {
        if label[s] != u32::MAX || !m.terrain[s].passable() {
            continue;
        }
        label[s] = next;
        let mut stack = vec![s];
        while let Some(i) = stack.pop() {
            let (x, y) = ((i as i32) % m.width, (i as i32) / m.width);
            for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                if m.contains(x + dx, y + dy) {
                    let j = m.idx(x + dx, y + dy);
                    if label[j] == u32::MAX && m.terrain[j].passable() {
                        label[j] = next;
                        stack.push(j);
                    }
                }
            }
        }
        next += 1;
    }
    label
}

/// A road three cells wide along `path`, and its mirror image: rock and trees
/// cleared, water turned into fords; `keep` cells never change.
fn carve_road(m: &mut Map, path: &[usize], keep: &[bool], flip_y: bool) {
    let (w, h) = (m.width, m.height);
    for &p in path {
        let (x, y) = ((p as i32) % w, (p as i32) / w);
        for oy in -1..=1 {
            for ox in -1..=1 {
                let (mx, my) = (w - 1 - x - ox, h - 1 - y - oy);
                let mirrored = [(x + ox, y + oy), (mx, y + oy), (x + ox, my), (mx, my)];
                for &(cx, cy) in &mirrored[..if flip_y { 4 } else { 2 }] {
                    if !m.contains(cx, cy) {
                        continue;
                    }
                    let i = m.idx(cx, cy);
                    if keep[i] {
                        continue;
                    }
                    match m.terrain[i] {
                        Terrain::Rock | Terrain::Tree => m.terrain[i] = Terrain::Clear,
                        Terrain::Water => {
                            m.terrain[i] = Terrain::Ford;
                            m.clear_resource(i);
                        }
                        _ => {}
                    }
                }
            }
        }
    }
}

/// Cells within `margin` of a marked cell (Chebyshev distance).
pub(crate) fn grow(w: i32, h: i32, marked: &[bool], margin: i32) -> Vec<bool> {
    let mut out = vec![false; marked.len()];
    for y in 0..h {
        for x in 0..w {
            if !marked[(y * w + x) as usize] {
                continue;
            }
            for oy in -margin..=margin {
                for ox in -margin..=margin {
                    let (nx, ny) = (x + ox, y + oy);
                    if nx >= 0 && ny >= 0 && nx < w && ny < h {
                        out[(ny * w + nx) as usize] = true;
                    }
                }
            }
        }
    }
    out
}

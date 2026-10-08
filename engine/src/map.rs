//! Terrain grid, resource layers (ore and gems) and the seeded skirmish map
//! generator.

use crate::rng::Rng;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum Terrain {
    Clear = 0,
    Rough = 1,
    Rock = 2,
    Water = 3,
    Tree = 4,
}

impl Terrain {
    pub fn from_u8(v: u8) -> Option<Terrain> {
        Some(match v {
            0 => Terrain::Clear,
            1 => Terrain::Rough,
            2 => Terrain::Rock,
            3 => Terrain::Water,
            4 => Terrain::Tree,
            _ => return None,
        })
    }

    pub fn passable(self) -> bool {
        matches!(self, Terrain::Clear | Terrain::Rough)
    }
    pub fn buildable(self) -> bool {
        self == Terrain::Clear
    }
}

/// Most bales an ore cell holds (OpenRA ResourceLayer Ore MaxDensity; map format limit).
pub const ORE_MAX_DENSITY: u8 = 12;
/// Most bales a gem cell holds (OpenRA ResourceLayer Gems MaxDensity; map format limit).
pub const GEM_MAX_DENSITY: u8 = 3;

/// The two Red Alert resource types (OpenRA ResourceLayer.ResourceTypes).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Resource {
    Ore,
    Gems,
}

/// Index into a locomotor's speed table (see `TERRAIN_TYPES` in gen_rules.py).
pub const SPEED_CLEAR: usize = 0;
pub const SPEED_ROUGH: usize = 1;
pub const SPEED_ORE: usize = 2;
pub const SPEED_WATER: usize = 3;

#[derive(Clone)]
pub struct Map {
    pub width: i32,
    pub height: i32,
    pub terrain: Vec<Terrain>,
    /// Ore density per cell (0 = none, bales left on the cell).
    pub ore: Vec<u8>,
    /// Gem density per cell (0 = none). A cell holds ore or gems, never both.
    pub gems: Vec<u8>,
    /// Starting cell (top-left of the construction yard) per player slot.
    pub spawns: Vec<(i32, i32)>,
}

impl Map {
    #[inline]
    pub fn contains(&self, x: i32, y: i32) -> bool {
        x >= 0 && y >= 0 && x < self.width && y < self.height
    }

    #[inline]
    pub fn idx(&self, x: i32, y: i32) -> usize {
        (y * self.width + x) as usize
    }

    #[inline]
    pub fn cells(&self) -> usize {
        (self.width * self.height) as usize
    }

    /// A map of one terrain type without resources or spawns.
    pub fn filled(width: i32, height: i32, t: Terrain) -> Map {
        let n = (width * height) as usize;
        Map { width, height, terrain: vec![t; n], ore: vec![0; n], gems: vec![0; n], spawns: Vec::new() }
    }

    /// Whether cell `i` holds ore or gems.
    #[inline]
    pub fn has_resource(&self, i: usize) -> bool {
        self.ore[i] > 0 || self.gems[i] > 0
    }

    /// The resource on cell `i` and how many bales are left there.
    pub fn resource(&self, i: usize) -> Option<(Resource, u8)> {
        if self.gems[i] > 0 {
            Some((Resource::Gems, self.gems[i]))
        } else if self.ore[i] > 0 {
            Some((Resource::Ore, self.ore[i]))
        } else {
            None
        }
    }

    /// Take one bale from cell `i`; the type taken, or None when it held nothing.
    pub fn take_bale(&mut self, i: usize) -> Option<Resource> {
        let (r, _) = self.resource(i)?;
        match r {
            Resource::Ore => self.ore[i] -= 1,
            Resource::Gems => self.gems[i] -= 1,
        }
        Some(r)
    }

    fn clear_resource(&mut self, i: usize) {
        self.ore[i] = 0;
        self.gems[i] = 0;
    }

    /// Movement class of cell `i`. Gems slow units like ore (OpenRA's
    /// locomotors give the Gems and Ore terrain types the same speeds).
    pub fn speed_class(&self, i: usize) -> usize {
        if self.terrain[i] == Terrain::Water {
            SPEED_WATER
        } else if self.has_resource(i) {
            SPEED_ORE
        } else if self.terrain[i] == Terrain::Rough {
            SPEED_ROUGH
        } else {
            SPEED_CLEAR
        }
    }

    /// Generate a two-player map, mirrored left to right, with both bases at
    /// the same height. Red Alert buildings are not symmetric: production
    /// exits, refinery docks and bibs all face south. On a point symmetric
    /// map the top base's exits and docks face the enemy and its ore while
    /// the bottom base's face the map edge, which decided most mirror
    /// matches. A left to right mirror gives both sides the same layout.
    pub fn generate(width: i32, height: i32, seed: u64, ore_max: u8) -> Map {
        let mut rng = Rng::new(seed);
        let mut m = Map::filled(width, height, Terrain::Clear);

        m.scatter(&mut rng);

        // Bases on the left and right edge; the seed picks the height.
        let sy = match rng.range(0, 3) {
            0 => 8,
            1 => height / 2 - 2,
            _ => height - 12,
        };
        let sx = 8;
        m.spawns = vec![(sx, sy), (width - 3 - sx, sy)];
        m.fill_circle(sx + 1, sy + 2, 11, Terrain::Clear);
        // Ore: one field beside the base toward the middle, one above or below
        // it toward the centre row, and contested fields on the centre line
        // (the mirror joins the halves). The contested fields have gems in
        // their dense middle, so the richer resource is the one to fight over.
        let (mx, my) = (width / 2, height / 2);
        let toward_centre = if sy + 2 > my { -1 } else { 1 };
        m.ore_field(&mut rng, sx + 13, sy + 2, 4, ore_max, 0);
        m.ore_field(&mut rng, sx + 3, sy + 2 + toward_centre * 13, 3, ore_max, 0);
        m.ore_field(&mut rng, mx - 3, sy + 2 + toward_centre * 6, 4, ore_max, CONTESTED_GEM_CORE);
        m.ore_field(&mut rng, mx - 9, my + toward_centre * (height / 4), 4, ore_max, CONTESTED_GEM_CORE);

        m.mirror_x();
        m.ensure_connected(m.spawns[0], m.spawns[1]);
        m
    }

    /// Map for `players` starting positions (2..8). Two players get the
    /// mirrored map of [`Map::generate`]; more players get [`Map::generate_pockets`].
    pub fn generate_for(width: i32, height: i32, seed: u64, ore_max: u8, players: usize) -> Map {
        let players = players.clamp(2, 8);
        if players == 2 {
            return Map::generate(width, height, seed, ore_max);
        }
        Map::generate_pockets(width, height, seed, ore_max, players)
    }

    /// Map for 3 to 8 players with equivalent starting positions.
    ///
    /// Red Alert structures face south (exits, refinery docks, bibs), so two
    /// bases only have the same surroundings when one is the other shifted or
    /// mirrored left to right, never rotated or flipped upside down. Every
    /// base gets the same pocket: a clearing with two ore fields south-west
    /// and south-east of the yard (where refinery docks face), rock walls to
    /// the north and the south, and open sides, so enemies come in from the
    /// east or the west. The random terrain is mirrored left to right.
    ///
    /// Three and four players sit in two rows, one in the middle of each half
    /// of the map, and the bottom half repeats the top half (three players:
    /// two on top, one below between them). Five to eight players sit on a
    /// ring around the centre, so every base has exactly two nearest
    /// neighbours; in rows of three or four the middle bases would have more
    /// and lose most free for alls. Contested ore lies halfway between
    /// neighbouring bases, with gems in its dense middle, so every pair of
    /// neighbours shares the same gems. Spawns are listed by column, top first, so the
    /// common split of the first half of the slots against the second half
    /// puts mirror images against each other. The AI makes up for the rest:
    /// its rally point and defences face the enemy, not a map side.
    pub fn generate_pockets(width: i32, height: i32, seed: u64, ore_max: u8, players: usize) -> Map {
        let mut m = Map::filled(width, height, Terrain::Clear);
        let mut rng = Rng::new(seed ^ 0x5eed_0000_0000_0004);
        m.scatter(&mut rng);
        m.mirror_x();
        // Three or four players: two rows, the bottom half repeating the top
        // half. Five to eight: a ring, so every base has two nearest
        // neighbours (a base in the middle of a row would have more).
        let rows = players <= 4;
        let mut centres = if rows { row_layout(width, height, players) } else { ring_layout(width, height, players) };
        if rows {
            m.repeat_top_half();
        }
        centres.sort_by_key(|&(x, y)| (x, y));
        let r = pocket_radius(&centres);
        let pocket_seed = seed ^ 0x90c3_e700_0000_0001;
        for &(cx, cy) in &centres {
            m.stamp_pocket(cx, cy, r, ore_max, pocket_seed);
        }
        // Contested ore halfway between neighbouring bases, where it fits,
        // with gems in the middle of each field.
        let d2 = |a: (i32, i32), b: (i32, i32)| (a.0 - b.0) * (a.0 - b.0) + (a.1 - b.1) * (a.1 - b.1);
        let mut contested: Vec<(i32, i32, i32)> = Vec::new();
        for (k, &a) in centres.iter().enumerate() {
            let near = centres.iter().filter(|&&b| b != a).map(|&b| d2(a, b)).min().unwrap_or(0);
            for &b in &centres[k + 1..] {
                // Neighbours: at most a quarter farther than the nearest base.
                if d2(a, b) * 16 > near * 25 {
                    continue;
                }
                let mid = ((a.0 + b.0) / 2, (a.1 + b.1) / 2);
                // Room: the field stays clear of every pocket.
                let room = centres.iter().map(|&c| (mid.0 - c.0).abs().max((mid.1 - c.1).abs()) - r - 5).min().unwrap_or(0);
                if room >= 2 {
                    contested.push((mid.0, mid.1, room.min(3)));
                }
            }
        }
        contested.sort_unstable();
        contested.dedup();
        for (k, &(x, y, fr)) in contested.iter().enumerate() {
            m.ore_field_mirrored(&mut Rng::new(pocket_seed ^ (k as u64 + 1)), x, y, fr, ore_max, fr - 1);
        }
        // The pockets are symmetric already; this makes the contested fields
        // of the right half the mirror images of the left half's.
        m.mirror_x();
        m.spawns = centres.iter().map(|&(cx, cy)| (cx - 1, cy - 2)).collect();
        let spawns = m.spawns.clone();
        for &s in &spawns[1..] {
            m.ensure_connected_mirrored(spawns[0], s);
        }
        m
    }

    /// One base pocket around the yard centre (cx, cy) with radius `r`: a
    /// clearing, two ore fields south-west and south-east of the yard, rock
    /// walls north and south. Left-right symmetric around column `cx`, and
    /// the same for every base of a map (same `seed`).
    fn stamp_pocket(&mut self, cx: i32, cy: i32, r: i32, ore_max: u8, seed: u64) {
        let half = r - 2;
        for dy in -r..=r + 2 {
            for dx in -half..=half {
                if self.contains(cx + dx, cy + dy) {
                    let i = self.idx(cx + dx, cy + dy);
                    self.terrain[i] = Terrain::Clear;
                    self.clear_resource(i);
                }
            }
        }
        self.fill_circle(cx, cy, r, Terrain::Clear);
        for dx in -half..=half {
            for dy in [-r - 1, -r - 2, r + 3, r + 4] {
                self.set_terrain(cx + dx, cy + dy, Terrain::Rock);
            }
        }
        let (fx, fy) = (r * 7 / 10, r * 8 / 10);
        let mut rng = Rng::new(seed);
        self.ore_field_pair(&mut rng, cx, fx, cy + fy, 4, ore_max, 0);
    }

    /// Ore field centred on (x, y), mirrored onto itself around column `x`.
    fn ore_field_mirrored(&mut self, rng: &mut Rng, x: i32, y: i32, r: i32, max: u8, gem_core: i32) {
        self.ore_field_pair(rng, x, 0, y, r, max, gem_core);
    }

    /// Two ore fields at (axis - off, y) and (axis + off, y) that are mirror
    /// images around column `axis` (one field when `off` is 0). Cells within
    /// `gem_core` of a field's centre get gems instead of ore.
    #[allow(clippy::too_many_arguments)]
    fn ore_field_pair(&mut self, rng: &mut Rng, axis: i32, off: i32, y: i32, r: i32, max: u8, gem_core: i32) {
        for oy in -r..=r {
            for ox in -r..=r {
                let d = ox * ox + oy * oy;
                let fuzz = rng.range(0, r + 1);
                let value = (max as i32 - (d * max as i32) / (r * r + 1) + rng.range(-2, 2)).clamp(2, max as i32) as u8;
                // Left field cell (axis - off + ox) and its mirror (axis + off - ox).
                if (off == 0 && ox > 0) || d > r * r + fuzz {
                    continue;
                }
                for x in [axis - off + ox, axis + off - ox] {
                    if self.contains(x, y + oy) {
                        let i = self.idx(x, y + oy);
                        if !self.terrain[i].passable() {
                            self.terrain[i] = Terrain::Clear;
                        }
                        self.put_resource(i, value, max, d <= gem_core * gem_core);
                    }
                }
            }
        }
    }

    /// Copy the top half of the map onto the bottom half (same picture, shifted down).
    fn repeat_top_half(&mut self) {
        let band = self.height / 2;
        for y in 0..band {
            for x in 0..self.width {
                let (i, j) = (self.idx(x, y), self.idx(x, y + band));
                self.terrain[j] = self.terrain[i];
                self.ore[j] = self.ore[i];
                self.gems[j] = self.gems[i];
            }
        }
    }

    /// Like `ensure_connected`, with the road also carved mirrored left to right.
    fn ensure_connected_mirrored(&mut self, a: (i32, i32), b: (i32, i32)) {
        if self.reachable(a, b) {
            return;
        }
        let w = self.width;
        let mirror = |p: (i32, i32)| (w - 3 - p.0, p.1);
        for (p, q) in [(a, b), (mirror(a), mirror(b))] {
            self.carve((p.0 + 1, p.1 + 1), (q.0 + 1, q.1 + 1));
            self.carve((q.0 + 1, q.1 + 1), (p.0 + 1, p.1 + 1));
        }
    }

    /// Random terrain over the whole map: rough patches, lakes, rock ridges
    /// and tree clusters.
    fn scatter(&mut self, rng: &mut Rng) {
        let (width, height) = (self.width, self.height);
        let area = width * height;
        // Rough patches.
        for _ in 0..(area / 900).max(2) {
            let (cx, cy) = (rng.range(0, width), rng.range(0, height));
            let r = rng.range(2, 6);
            self.blob(rng, cx, cy, r, Terrain::Rough);
        }
        // Lakes.
        for _ in 0..(area / 3500).max(1) {
            let (cx, cy) = (rng.range(0, width), rng.range(0, height));
            let r = rng.range(3, 7);
            self.blob(rng, cx, cy, r, Terrain::Water);
        }
        // Rock ridges as random walks.
        for _ in 0..(area / 1400).max(2) {
            let (mut x, mut y) = (rng.range(0, width), rng.range(0, height));
            let (dx, dy) = (rng.range(-1, 2), rng.range(-1, 2));
            for _ in 0..rng.range(6, 18) {
                for (ox, oy) in [(0, 0), (1, 0), (0, 1)] {
                    self.set_terrain(x + ox, y + oy, Terrain::Rock);
                }
                x += dx + rng.range(-1, 2);
                y += dy + rng.range(-1, 2);
            }
        }
        // Tree clusters.
        for _ in 0..(area / 500).max(4) {
            let (cx, cy) = (rng.range(0, width), rng.range(0, height));
            for _ in 0..rng.range(3, 12) {
                self.set_terrain(cx + rng.range(-3, 4), cy + rng.range(-3, 4), Terrain::Tree);
            }
        }
    }

    pub fn connected(&self, a: (i32, i32), b: (i32, i32)) -> bool {
        self.reachable(a, b)
    }

    fn set_terrain(&mut self, x: i32, y: i32, t: Terrain) {
        if self.contains(x, y) {
            let i = self.idx(x, y);
            self.terrain[i] = t;
            if !t.passable() {
                self.clear_resource(i);
            }
        }
    }

    fn fill_circle(&mut self, cx: i32, cy: i32, r: i32, t: Terrain) {
        for y in cy - r..=cy + r {
            for x in cx - r..=cx + r {
                if (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r && self.contains(x, y) {
                    let i = self.idx(x, y);
                    self.terrain[i] = t;
                    self.clear_resource(i);
                }
            }
        }
    }

    fn blob(&mut self, rng: &mut Rng, cx: i32, cy: i32, r: i32, t: Terrain) {
        for y in cy - r..=cy + r {
            for x in cx - r..=cx + r {
                let d = (x - cx) * (x - cx) + (y - cy) * (y - cy);
                let rr = r * r + rng.range(-r, r + 1) * 2;
                if d <= rr {
                    self.set_terrain(x, y, t);
                }
            }
        }
    }

    /// Ore field of radius `r` around (cx, cy); cells within `gem_core` of
    /// the centre get gems instead of ore.
    fn ore_field(&mut self, rng: &mut Rng, cx: i32, cy: i32, r: i32, max: u8, gem_core: i32) {
        for y in cy - r..=cy + r {
            for x in cx - r..=cx + r {
                if !self.contains(x, y) {
                    continue;
                }
                let d = (x - cx) * (x - cx) + (y - cy) * (y - cy);
                if d > r * r + rng.range(0, r + 1) {
                    continue;
                }
                let i = self.idx(x, y);
                if !self.terrain[i].passable() {
                    self.terrain[i] = Terrain::Clear;
                }
                // Denser in the middle of the field.
                let fall = (d * max as i32) / (r * r + 1);
                let value = (max as i32 - fall + rng.range(-2, 2)).clamp(2, max as i32) as u8;
                self.put_resource(i, value, max, d <= gem_core * gem_core);
            }
        }
    }

    /// Put ore of density `value` (out of `max`) on cell `i`, or as gems the
    /// same share of the gem maximum (at least one bale).
    fn put_resource(&mut self, i: usize, value: u8, max: u8, gems: bool) {
        if gems {
            let g = (value as i32 * GEM_MAX_DENSITY as i32 + max as i32 - 1) / (max as i32).max(1);
            self.ore[i] = 0;
            self.gems[i] = g.clamp(1, GEM_MAX_DENSITY as i32) as u8;
        } else {
            self.ore[i] = value;
            self.gems[i] = 0;
        }
    }

    /// Copy the left half onto the right half, mirrored.
    fn mirror_x(&mut self) {
        for y in 0..self.height {
            for x in 0..self.width / 2 {
                let (i, j) = (self.idx(x, y), self.idx(self.width - 1 - x, y));
                self.terrain[j] = self.terrain[i];
                self.ore[j] = self.ore[i];
                self.gems[j] = self.gems[i];
            }
        }
    }

    /// Carve a 3-cell wide corridor between the bases if ground units could not
    /// otherwise reach each other. The corridor is carved both ways so it is
    /// as symmetric as the bases are.
    fn ensure_connected(&mut self, a: (i32, i32), b: (i32, i32)) {
        if self.reachable(a, b) {
            return;
        }
        self.carve((a.0 + 1, a.1 + 1), (b.0 + 1, b.1 + 1));
        self.carve((b.0 + 1, b.1 + 1), (a.0 + 1, a.1 + 1));
    }

    /// Clear a 3-cell wide straight-ish road between two cells.
    fn carve(&mut self, a: (i32, i32), b: (i32, i32)) {
        let (mut x, mut y) = a;
        let (tx, ty) = b;
        while (x, y) != (tx, ty) {
            for oy in -1..=1 {
                for ox in -1..=1 {
                    if self.contains(x + ox, y + oy) {
                        let i = self.idx(x + ox, y + oy);
                        if !self.terrain[i].passable() {
                            self.terrain[i] = Terrain::Clear;
                        }
                    }
                }
            }
            x += (tx - x).signum();
            y += (ty - y).signum();
        }
    }

    fn reachable(&self, a: (i32, i32), b: (i32, i32)) -> bool {
        let mut seen = vec![false; self.cells()];
        let mut stack = vec![a];
        seen[self.idx(a.0, a.1)] = true;
        while let Some((x, y)) = stack.pop() {
            if (x, y) == b {
                return true;
            }
            for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                let (nx, ny) = (x + dx, y + dy);
                if self.contains(nx, ny) {
                    let i = self.idx(nx, ny);
                    if !seen[i] && self.terrain[i].passable() {
                        seen[i] = true;
                        stack.push((nx, ny));
                    }
                }
            }
        }
        false
    }

    /// Ore growth: dense fields slowly regrow and spread to neighbouring clear
    /// cells. Gems neither regrow nor spread (Red Alert), and ore never
    /// spreads onto them.
    pub fn grow_ore(&mut self, rng: &mut Rng, max: u8, blocked: &[bool]) -> bool {
        let mut changed = false;
        let n = self.cells();
        let mut spread = Vec::new();
        for i in 0..n {
            let d = self.ore[i];
            if d == 0 {
                continue;
            }
            if d < max {
                self.ore[i] = d + 1;
                changed = true;
            } else if rng.chance(4) {
                spread.push(i);
            }
        }
        for i in spread {
            let (x, y) = ((i as i32) % self.width, (i as i32) / self.width);
            let (nx, ny) = (x + rng.range(-1, 2), y + rng.range(-1, 2));
            if self.contains(nx, ny) {
                let j = self.idx(nx, ny);
                if !self.has_resource(j) && self.terrain[j].buildable() && !blocked[j] {
                    self.ore[j] = 1;
                    changed = true;
                }
            }
        }
        changed
    }
}

/// Radius of the gem middle of the contested fields of two-player maps.
const CONTESTED_GEM_CORE: i32 = 2;

/// Pocket radius for bases at these yard centres: as large as the distance
/// to the nearest neighbour allows, 6 to 10 cells.
fn pocket_radius(centres: &[(i32, i32)]) -> i32 {
    let nearest = centres
        .iter()
        .enumerate()
        .flat_map(|(k, a)| centres[k + 1..].iter().map(move |b| (a.0 - b.0).abs().max((a.1 - b.1).abs())))
        .min()
        .unwrap_or(24);
    ((nearest - 4) / 2).clamp(6, 10)
}

/// Column `x` mirrored: a base at yard centre `x` and one at `mirror(x)` are mirror images.
fn mirror_col(width: i32, x: i32) -> i32 {
    width - 1 - x
}

/// Yard centres for two rows: the top row in the middle of the top half,
/// the bottom row in the middle of the bottom half, `ceil(n / 2)` bases
/// evenly over the width (half a spacing from each edge), the bottom row
/// aligned below them or staggered between them when it has one base fewer.
fn row_layout(width: i32, height: i32, players: usize) -> Vec<(i32, i32)> {
    let band = height / 2;
    let top = players.div_ceil(2) as i32;
    let bottom = players as i32 - top;
    let spacing = width / top;
    // `k2` is twice the column position in spacings from the left edge;
    // right-half columns are the mirror images of left-half ones.
    let left = |k2: i32| k2 * spacing / 2;
    let column = |k2: i32| if 2 * left(k2) < width { left(k2) } else { mirror_col(width, left(2 * top - k2)) };
    let mut centres = Vec::new();
    for j in 0..top {
        centres.push((column(2 * j + 1), band / 2));
    }
    for j in 0..bottom {
        let k2 = if bottom == top { 2 * j + 1 } else { 2 * j + 2 };
        centres.push((column(k2), band + band / 2));
    }
    centres
}

/// Yards on a ring around the centre, mirror symmetric left to right.
fn ring_layout(width: i32, height: i32, players: usize) -> Vec<(i32, i32)> {
    let n = players as i32;
    // Room for a pocket: 11 cells to the sides, 13 above and 15 below the yard centre.
    let ry = (height / 2 - 15).max(10);
    let rx = (width / 2 - 12).max(10);
    let mut centres = Vec::new();
    for k in 0..n {
        // Angles (1024 = full turn, 0 = north) symmetric around the north-south axis.
        let a = (1024 * (2 * k + 1) / (2 * n)) % 1024;
        let (vx, vy) = crate::math::facing_vec(a);
        let x = width / 2 + vx * rx / 1024;
        let y = height / 2 + vy * ry / 1024;
        centres.push((x, y));
    }
    // Exact mirror pairs: rebuild the right half from the left half.
    let left: Vec<(i32, i32)> = centres.iter().copied().filter(|&(x, _)| 2 * x < width - 1).collect();
    let mut out: Vec<(i32, i32)> = left.clone();
    out.extend(left.iter().map(|&(x, y)| (mirror_col(width, x), y)));
    for &(x, y) in &centres {
        if 2 * x >= width - 1 && 2 * x <= width + 1 && !out.iter().any(|&(ox, oy)| oy == y && (ox - x).abs() <= 1) {
            out.push((width / 2 - 1, y));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn multi_player_maps_have_connected_spawns() {
        for players in 2..=8 {
            let size = if players <= 4 { 96 } else { 128 };
            let m = Map::generate_for(size, size, 5, 12, players);
            assert_eq!(m.spawns.len(), players);
            for &s in &m.spawns {
                assert!(m.contains(s.0, s.1) && m.contains(s.0 + 2, s.1 + 3), "{players}: spawn {s:?} in bounds");
                assert!(m.connected(m.spawns[0], s), "{players}: spawn {s:?} reachable");
            }
        }
    }

    /// 3 to 8 players: the map is mirrored left to right, every base has the
    /// same surroundings (shifted, never rotated, because structures face
    /// south), mirrored spawns pair up, and every spawn is reachable.
    #[test]
    fn multi_player_bases_are_equivalent() {
        for players in 3..=8 {
            for size in [64, 96, 128, 160] {
                if players > 4 && size < 96 {
                    continue;
                }
                for seed in 0..6 {
                    let m = Map::generate_for(size, size, seed, 12, players);
                    let what = format!("{players} players, size {size}, seed {seed}");
                    assert_eq!(m.spawns.len(), players, "{what}");
                    for y in 0..size {
                        for x in 0..size {
                            let (i, j) = (m.idx(x, y), m.idx(size - 1 - x, y));
                            assert_eq!(
                                (m.terrain[i], m.ore[i], m.gems[i]),
                                (m.terrain[j], m.ore[j], m.gems[j]),
                                "{what}: mirror at {x},{y}"
                            );
                        }
                    }
                    let (x0, y0) = m.spawns[0];
                    let centres: Vec<(i32, i32)> = m.spawns.iter().map(|&(x, y)| (x + 1, y + 2)).collect();
                    let r = pocket_radius(&centres);
                    for &(sx, sy) in &m.spawns {
                        assert!(m.contains(sx, sy) && m.contains(sx + 2, sy + 3), "{what}: spawn {sx},{sy} in bounds");
                        assert!(m.connected(m.spawns[0], (sx, sy)), "{what}: spawn {sx},{sy} reachable");
                        // A base on the middle column is its own mirror image, up to
                        // half a cell (the map has an even width, the yard is 3 wide).
                        let centred = ((sx + 1) * 2 - (size - 1)).abs() <= 1;
                        assert!(centred || m.spawns.contains(&(size - 3 - sx, sy)), "{what}: spawn {sx},{sy} has a mirror image");
                        // The pocket around the yard (clearing, ore fields, walls) is the
                        // same picture; the right half of a centred base is shifted by a cell.
                        for dy in -r - 2..=r + 4 {
                            for dx in -r..=if centred { 0 } else { r } {
                                // The clearing and the band of the walls.
                                if dx * dx + dy * dy > r * r && dx.abs() > r - 2 {
                                    continue;
                                }
                                let (a, b) = ((x0 + 1 + dx, y0 + 2 + dy), (sx + 1 + dx, sy + 2 + dy));
                                if !m.contains(a.0, a.1) || !m.contains(b.0, b.1) {
                                    continue;
                                }
                                let (i, j) = (m.idx(a.0, a.1), m.idx(b.0, b.1));
                                assert_eq!(
                                    (m.terrain[i], m.ore[i] > 0, m.gems[i] > 0),
                                    (m.terrain[j], m.ore[j] > 0, m.gems[j] > 0),
                                    "{what}: base at {sx},{sy} differs at offset {dx},{dy}"
                                );
                            }
                        }
                    }
                    // Listed by column, top row first.
                    let mut sorted = m.spawns.clone();
                    sorted.sort_unstable();
                    assert_eq!(sorted, m.spawns, "{what}");
                    assert!(m.ore.iter().filter(|&&o| o > 0).count() > 40 * players, "{what}: enough ore");
                    assert_resources_well_formed(&m, &what);
                }
            }
        }
    }

    #[test]
    fn generated_map_is_mirrored_left_to_right_and_connected() {
        for size in [64, 80, 96, 128] {
            for seed in 0..20 {
                let m = Map::generate(size, size, seed, 12);
                for y in 0..size {
                    for x in 0..size {
                        let (i, j) = (m.idx(x, y), m.idx(size - 1 - x, y));
                        assert_eq!(m.terrain[i], m.terrain[j], "size {size} seed {seed} terrain at {x},{y}");
                        assert_eq!(m.ore[i], m.ore[j], "size {size} seed {seed} ore at {x},{y}");
                        assert_eq!(m.gems[i], m.gems[j], "size {size} seed {seed} gems at {x},{y}");
                    }
                }
                // The yards are mirror images: 3 cells wide, same row.
                let ((x0, y0), (x1, y1)) = (m.spawns[0], m.spawns[1]);
                assert_eq!((y0, x0 + x1 + 2), (y1, size - 1), "size {size} seed {seed}");
                assert!(m.reachable(m.spawns[0], m.spawns[1]), "size {size} seed {seed}");
                assert!(m.ore.iter().filter(|&&o| o > 0).count() > 50);
                assert_resources_well_formed(&m, &format!("size {size} seed {seed}"));
            }
        }
    }

    /// Gems: on passable ground only, never on an ore cell, within the format's
    /// density, outside every starting yard, and present on every generated map.
    fn assert_resources_well_formed(m: &Map, what: &str) {
        let mut gem_cells = 0;
        for i in 0..m.cells() {
            assert!(m.ore[i] <= ORE_MAX_DENSITY && m.gems[i] <= GEM_MAX_DENSITY, "{what}: density at {i}");
            assert!(m.ore[i] == 0 || m.gems[i] == 0, "{what}: ore and gems share cell {i}");
            if m.has_resource(i) {
                assert!(m.terrain[i].passable(), "{what}: resource on {:?} at {i}", m.terrain[i]);
            }
            gem_cells += (m.gems[i] > 0) as usize;
        }
        assert!(gem_cells >= 4, "{what}: only {gem_cells} gem cells");
        for &(sx, sy) in &m.spawns {
            for (dx, dy) in (0..3).flat_map(|dx| (0..4).map(move |dy| (dx, dy))) {
                assert!(!m.has_resource(m.idx(sx + dx, sy + dy)), "{what}: resource on the yard at {sx},{sy}");
            }
        }
    }

    /// Two players: the gems are contested. Each side has the same gems
    /// (mirror) and they lie nearer the middle than the side's own ore.
    #[test]
    fn two_player_gems_are_contested_and_fair() {
        for size in [48, 64, 96, 128] {
            for seed in 0..10 {
                let m = Map::generate(size, size, seed, ORE_MAX_DENSITY);
                let (sx, sy) = m.spawns[0];
                let mut near = [0i64; 2];
                let (mut gem_d, mut gems, mut ore_d, mut ore) = (0i64, 0i64, 0i64, 0i64);
                for y in 0..size {
                    for x in 0..size {
                        let i = m.idx(x, y);
                        let side = (2 * x >= size) as usize;
                        near[side] += m.gems[i] as i64;
                        if side == 0 {
                            let d = ((x - sx - 1).pow(2) + (y - sy - 2).pow(2)) as i64;
                            if m.gems[i] > 0 {
                                (gem_d, gems) = (gem_d + d, gems + 1);
                            } else if m.ore[i] > 0 {
                                (ore_d, ore) = (ore_d + d, ore + 1);
                            }
                        }
                    }
                }
                assert_eq!(near[0], near[1], "size {size} seed {seed}");
                assert!(gems > 0 && gem_d * ore > ore_d * gems, "size {size} seed {seed}: gems farther out than ore on average");
            }
        }
    }

    #[test]
    fn gems_do_not_grow_or_spread_and_ore_does_not_spread_onto_them() {
        let mut m = Map::filled(32, 32, Terrain::Clear);
        let blocked = vec![false; m.cells()];
        for i in 0..m.cells() {
            if i % 2 == 0 {
                m.ore[i] = ORE_MAX_DENSITY;
            } else {
                m.gems[i] = 1;
            }
        }
        let gems = m.gems.clone();
        let mut rng = Rng::new(7);
        for _ in 0..50 {
            m.grow_ore(&mut rng, ORE_MAX_DENSITY, &blocked);
        }
        assert_eq!(m.gems, gems, "gems stay as they were");
        assert!((0..m.cells()).all(|i| m.ore[i] == 0 || m.gems[i] == 0));
        // Ore grows back and spreads onto free ground.
        let mut m = Map::filled(32, 32, Terrain::Clear);
        let blocked = vec![false; m.cells()];
        let c = m.idx(16, 16);
        m.ore[c] = ORE_MAX_DENSITY;
        let g = m.idx(8, 8);
        m.gems[g] = 2;
        for _ in 0..200 {
            m.grow_ore(&mut rng, ORE_MAX_DENSITY, &blocked);
        }
        assert!(m.ore.iter().filter(|&&o| o > 0).count() > 1, "ore spreads");
        assert_eq!((m.gems[g], m.gems.iter().filter(|&&x| x > 0).count()), (2, 1), "gems neither grow nor spread");
    }

    #[test]
    fn harvesting_takes_one_bale_of_the_cell_type() {
        let mut m = Map::filled(32, 32, Terrain::Clear);
        m.ore[0] = 2;
        m.gems[1] = 1;
        assert_eq!(m.resource(0), Some((Resource::Ore, 2)));
        assert_eq!(m.take_bale(1), Some(Resource::Gems));
        assert_eq!((m.take_bale(1), m.has_resource(1)), (None, false));
        assert_eq!(m.take_bale(0), Some(Resource::Ore));
        assert_eq!(m.ore[0], 1);
        // Gems slow units like ore.
        assert_eq!(m.speed_class(0), SPEED_ORE);
        m.gems[2] = 3;
        assert_eq!(m.speed_class(2), SPEED_ORE);
    }
}

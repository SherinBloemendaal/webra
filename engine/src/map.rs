//! Terrain grid, resource layers (ore and gems) and the seeded skirmish map
//! generator.

use crate::mapgen::{Layout, MapStyle};
use crate::rng::Rng;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum Terrain {
    Clear = 0,
    Rough = 1,
    Rock = 2,
    Water = 3,
    Tree = 4,
    /// Shallow water: ground units wade through at rough speed and ships
    /// sail over it, so a river crossing never cuts the water network.
    Ford = 5,
}

impl Terrain {
    pub fn from_u8(v: u8) -> Option<Terrain> {
        Some(match v {
            0 => Terrain::Clear,
            1 => Terrain::Rough,
            2 => Terrain::Rock,
            3 => Terrain::Water,
            4 => Terrain::Tree,
            5 => Terrain::Ford,
            _ => return None,
        })
    }

    pub fn passable(self) -> bool {
        matches!(self, Terrain::Clear | Terrain::Rough | Terrain::Ford)
    }
    pub fn buildable(self) -> bool {
        self == Terrain::Clear
    }
    /// Open to ships: water and fords.
    pub fn ship_passable(self) -> bool {
        matches!(self, Terrain::Water | Terrain::Ford)
    }
    /// Ore (and anything harvested) only lies on clear or rough ground.
    pub fn holds_ore(self) -> bool {
        matches!(self, Terrain::Clear | Terrain::Rough)
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

    pub(crate) fn clear_resource(&mut self, i: usize) {
        self.ore[i] = 0;
        self.gems[i] = 0;
    }

    /// Movement class of cell `i` for ground units (fords count as rough).
    /// Gems slow units like ore (OpenRA's locomotors give the Gems and Ore
    /// terrain types the same speeds).
    pub fn speed_class(&self, i: usize) -> usize {
        if self.terrain[i] == Terrain::Water {
            SPEED_WATER
        } else if self.has_resource(i) {
            SPEED_ORE
        } else if matches!(self.terrain[i], Terrain::Rough | Terrain::Ford) {
            SPEED_ROUGH
        } else {
            SPEED_CLEAR
        }
    }

    /// Whether a cell is ice: rough ground (frozen ponds) in the snow biome.
    pub fn biome_ice(&self, i: usize, biome: crate::weather::Biome) -> bool {
        biome == crate::weather::Biome::Snow && self.terrain[i] == Terrain::Rough
    }

    /// Speed table index of a cell for a locomotor: ships sail over fords at
    /// water speed, everything else uses [`Map::speed_class`].
    pub fn speed_class_for(&self, i: usize, ship: bool) -> usize {
        if ship && self.terrain[i].ship_passable() {
            SPEED_WATER
        } else {
            self.speed_class(i)
        }
    }

    /// Generate a two-player map, mirrored left to right, with both bases at
    /// the same height. Red Alert buildings are not symmetric: production
    /// exits, refinery docks and bibs all face south. On a point symmetric
    /// map the top base's exits and docks face the enemy and its ore while
    /// the bottom base's face the map edge, which decided most mirror
    /// matches. A left to right mirror gives both sides the same layout.
    /// The style is picked from the seed (see [`MapStyle::resolve`]).
    pub fn generate(width: i32, height: i32, seed: u64, ore_max: u8) -> Map {
        Map::generate_two(width, height, seed, ore_max, MapStyle::Random)
    }

    /// Map for `players` starting positions (2..8) in a style picked from the seed.
    pub fn generate_for(width: i32, height: i32, seed: u64, ore_max: u8, players: usize) -> Map {
        Map::generate_styled(width, height, seed, ore_max, players, MapStyle::Random)
    }

    /// Map for `players` starting positions (2..8) in `style`. Two players
    /// get the mirrored map of [`Map::generate`]; more players get
    /// [`Map::generate_pockets`].
    pub fn generate_styled(width: i32, height: i32, seed: u64, ore_max: u8, players: usize, style: MapStyle) -> Map {
        let players = players.clamp(2, 8);
        if players == 2 {
            return Map::generate_two(width, height, seed, ore_max, style);
        }
        Map::generate_pockets(width, height, seed, ore_max, players, style)
    }

    fn generate_two(width: i32, height: i32, seed: u64, ore_max: u8, style: MapStyle) -> Map {
        let style = style.resolve(seed);
        let mut rng = Rng::new(seed);
        let n = (width * height) as usize;
        let mut m = Map::filled(width, height, Terrain::Clear);

        // Bases on the left and right edge; the seed picks the height (from
        // its own stream, so the style never moves the bases).
        let sy = match Rng::new(seed ^ 0xba5e_0000_0000_0002).range(0, 3) {
            0 => 8,
            1 => height / 2 - 2,
            _ => height - 12,
        };
        let sx = 8;
        let (bx, by) = (sx + 1, sy + 2);
        // The base clearing, and with water a harbour bay along the map edge behind it.
        let mut zone = vec![false; n];
        let mut bay = vec![false; n];
        for y in 0..height {
            for x in 0..width {
                let mx = x.min(width - 1 - x);
                let i = m.idx(x, y);
                zone[i] = (mx - bx) * (mx - bx) + (y - by) * (y - by) <= 11 * 11;
                bay[i] = style.naval() && mx <= 3 && (by - 7..=by + 7).contains(&y);
            }
        }
        m.scatter(&mut rng, if style == MapStyle::Land { 1 } else { 0 });
        let land_spots = crate::mapgen::draw_land(&mut m, &mut rng, style, &zone);
        let layout = Layout { bases: vec![(bx, by), (width - 1 - bx, by)], zone: zone.clone(), flip_y: false };
        let water = crate::mapgen::draw_water(width, height, &mut rng, style, &layout);
        crate::mapgen::apply_water(&mut m, &water, style, &mut rng);
        m.spawns = vec![(sx, sy), (width - 3 - sx, sy)];
        m.fill_circle(bx, by, 11, Terrain::Clear);
        for (i, _) in bay.iter().enumerate().filter(|(_, &b)| b) {
            m.terrain[i] = Terrain::Water;
            m.clear_resource(i);
        }
        // Ore: one field beside the base toward the middle, one above or below
        // it toward the centre row, and contested fields on the centre line
        // (the mirror joins the halves), plus the fields of the style. The
        // contested fields have gems in their dense middle, so the richer
        // resource is the one to fight over.
        let (mx, my) = (width / 2, height / 2);
        let toward_centre = if sy + 2 > my { -1 } else { 1 };
        m.ore_field(&mut rng, sx + 13, sy + 2, 4, ore_max, 0);
        m.ore_field(&mut rng, sx + 4, sy + 2 + toward_centre * 13, 4, ore_max, 0);
        m.ore_field(&mut rng, mx - 3, sy + 2 + toward_centre * 6, 4, ore_max, CONTESTED_GEM_CORE);
        m.ore_field(&mut rng, mx - 9, my + toward_centre * (height / 4), 4, ore_max, CONTESTED_GEM_CORE);
        // Ore of the style; river crossings, islands and passes near the
        // mirror axis carry gems in their middle as well.
        for &(x, y, r) in land_spots.iter().chain(&water.spots) {
            if !zone[m.idx(x.clamp(0, width - 1), y.clamp(0, height - 1))] {
                m.ore_field(&mut rng, x, y, r, ore_max, style_gem_core(width, x, r));
            }
        }
        m.top_up_ore(&mut Rng::new(seed ^ 0x0de0_0000_0000_0007), &zone, n * ore_share(style, true) / 1000, ore_max, None, (bx, by));

        m.mirror_x();
        if style.naval() {
            // Dig the bay through to the water network (mirrored).
            let near = crate::mapgen::grow(width, height, &zone, 2);
            let harbour: Vec<usize> = (0..n).filter(|&i| bay[i] && (i as i32 % width) < width / 2).collect();
            let blocked: Vec<bool> = (0..n).map(|i| zone[i] && !bay[i]).collect();
            if let Some(network) = crate::mapgen::network_from(&m, water.hub) {
                if let Some((_, path)) = crate::mapgen::plan_channel(&m, &harbour, &network, &blocked, &near, 1) {
                    crate::mapgen::dig_channel(&mut m, &path, &blocked);
                }
            }
        }
        let (a, b) = (m.spawns[0], m.spawns[1]);
        crate::mapgen::connect_ground(&mut m, a, b, &bay);
        crate::mapgen::connect_land_regions(&mut m, a, &bay);
        m
    }

    /// Map for 3 to 8 players with equivalent starting positions.
    ///
    /// Red Alert structures face south (exits, refinery docks, bibs), so two
    /// bases only have the same surroundings when one is the other shifted or
    /// mirrored left to right, never rotated or flipped upside down. Every
    /// base gets the same pocket: a clearing with two ore fields south-west
    /// and south-east of the yard (where refinery docks face), walls to the
    /// north and the south (rock, or in the naval styles a harbour moat on
    /// the side facing the map centre), and open sides, so enemies come in
    /// from the east or the west. The random terrain is mirrored left to right.
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
    pub fn generate_pockets(width: i32, height: i32, seed: u64, ore_max: u8, players: usize, style: MapStyle) -> Map {
        let style = style.resolve(seed);
        let n = (width * height) as usize;
        let mut m = Map::filled(width, height, Terrain::Clear);
        let mut rng = Rng::new(seed ^ 0x5eed_0000_0000_0004);
        // Three or four players: two rows, the bottom half repeating the top
        // half. Five to eight: a ring, so every base has two nearest
        // neighbours (a base in the middle of a row would have more).
        let rows = players <= 4;
        let mut centres = if rows { row_layout(width, height, players) } else { ring_layout(width, height, players) };
        centres.sort_by_key(|&(x, y)| (x, y));
        let r = pocket_radius(&centres);
        let half = r - 2;
        // Pocket rectangles (clearing, ore, walls and moats); features stay out.
        // (A base on the middle column is widened by a cell when the map is
        // mirrored, so the areas are mirrored too.)
        let mut zone = vec![false; n];
        for &(cx, cy) in &centres {
            for dy in -r - 3..=r + 5 {
                for dx in -r..=r {
                    for x in [cx + dx, width - 1 - cx - dx] {
                        if m.contains(x, cy + dy) {
                            let i = m.idx(x, cy + dy);
                            zone[i] = true;
                        }
                    }
                }
            }
        }
        m.scatter(&mut rng, if style == MapStyle::Land { 1 } else { 0 });
        let mut land_spots = crate::mapgen::draw_land(&mut m, &mut rng, style, &zone);
        m.mirror_x();
        if rows {
            m.repeat_top_half();
            let band = height / 2;
            let copies: Vec<(i32, i32, i32)> = land_spots.iter().filter(|s| s.1 < band).map(|&(x, y, r)| (x, y + band, r)).collect();
            land_spots.retain(|s| s.1 < band);
            land_spots.extend(copies);
        }
        // Water mirrored top to bottom only where the bases are too (four players).
        let flip_y = players == 4;
        let layout = Layout { bases: centres.clone(), zone: zone.clone(), flip_y };
        let water = crate::mapgen::draw_water(width, height, &mut rng, style, &layout);
        crate::mapgen::apply_water(&mut m, &water, style, &mut rng);
        let pocket_seed = seed ^ 0x90c3_e700_0000_0001;
        for &(cx, cy) in &centres {
            m.stamp_pocket(cx, cy, r, ore_max, pocket_seed, style.naval());
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
                let room = centres.iter().map(|&c| (mid.0 - c.0).abs().max((mid.1 - c.1).abs()) - r - 6).min().unwrap_or(0);
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
        // Ore of the style (left half; four players: top half too, flipped below).
        let mut spots: Vec<(i32, i32, i32)> = land_spots;
        for &(x, y, sr) in &water.spots {
            spots.push((x, y, sr));
            if flip_y {
                spots.push((x, height - 1 - y, sr));
            }
        }
        for (k, &(x, y, sr)) in spots.iter().enumerate() {
            let clear = (y - sr - 1..=y + sr + 1).all(|yy| (x - sr - 1..=x + sr + 1).all(|xx| !m.contains(xx, yy) || !zone[m.idx(xx, yy)]));
            if clear && 2 * x < width {
                m.ore_field(&mut Rng::new(pocket_seed ^ 0x0e0e ^ (k as u64)), x, y, sr, ore_max, style_gem_core(width, x, sr));
            }
        }
        let band = rows.then_some(height / 2);
        m.top_up_ore(&mut Rng::new(pocket_seed ^ 0x0de0), &zone, n * ore_share(style, false) / 1000, ore_max, band, centres[0]);
        // The pockets are symmetric already; this makes the contested fields
        // of the right half the mirror images of the left half's.
        m.mirror_x();
        m.spawns = centres.iter().map(|&(cx, cy)| (cx - 1, cy - 2)).collect();
        // Walls and moats never change from here on.
        let mut keep = vec![false; n];
        for &(cx, cy) in &centres {
            for dy in -r - 3..=r + 5 {
                for dx in -half..=half {
                    for x in [cx + dx, width - 1 - cx - dx] {
                        if m.contains(x, cy + dy) {
                            let i = m.idx(x, cy + dy);
                            keep[i] = !m.terrain[i].passable();
                        }
                    }
                }
            }
        }
        if style.naval() {
            m.connect_moats(&centres, r, &zone, water.hub);
        }
        let spawns = m.spawns.clone();
        for &s in &spawns[1..] {
            crate::mapgen::connect_ground(&mut m, spawns[0], s, &keep);
        }
        crate::mapgen::connect_land_regions(&mut m, spawns[0], &keep);
        m
    }

    /// Naval styles: dig each base's harbour moat that is nearer the water
    /// network through to it (mirrored), and wall the other moat up again
    /// with rock, so every base has exactly one harbour on the network.
    fn connect_moats(&mut self, centres: &[(i32, i32)], r: i32, zone: &[bool], hub: (i32, i32)) {
        let half = r - 2;
        let (w, h) = (self.width, self.height);
        let near = crate::mapgen::grow(w, h, zone, 2);
        // Channels run to the hub itself, nearly straight (water costs half
        // of digging), so every harbour is about as far from the centre as
        // its base is: the hub sits where the bases are evenly far.
        let mut target = vec![false; self.cells()];
        for y in hub.1 - 3..=hub.1 + 3 {
            for x in hub.0 - 4..=hub.0 + 3 {
                if self.contains(x, y) && self.terrain[self.idx(x, y)].ship_passable() {
                    let i = self.idx(x, y);
                    target[i] = true;
                }
            }
        }
        if !target.iter().any(|&t| t) {
            let Some(network) = crate::mapgen::network_from(self, hub) else { return };
            target = network;
        }
        let moat = |m: &Map, cx: i32, cy: i32, north: bool| -> Vec<usize> {
            let rows = if north { -r - 3..=-r - 1 } else { r + 3..=r + 5 };
            rows.flat_map(|dy| (-half..=half).map(move |dx| (cx + dx, cy + dy)))
                .filter(|&(x, y)| m.contains(x, y))
                .map(|(x, y)| m.idx(x, y))
                .collect()
        };
        // Plan every channel against the same network, then dig: no base
        // profits from another's channel being dug first.
        let mut plans = Vec::new();
        for &(cx, cy) in centres.iter().filter(|c| 2 * c.0 < w) {
            // (cost, north first on ties, path, north) of each moat's channel.
            let best = [true, false]
                .into_iter()
                .filter_map(|north| {
                    let cells = moat(self, cx, cy, north);
                    // The own moat may be left; every other base cell is closed.
                    let blocked: Vec<bool> = (0..self.cells()).map(|i| zone[i] && !cells.contains(&i)).collect();
                    crate::mapgen::plan_channel(self, &cells, &target, &blocked, &near, 3).map(|(cost, path)| (cost, !north, path, north))
                })
                .min_by_key(|o| (o.0, o.1));
            if let Some((_, _, path, north)) = best {
                plans.push((cx, cy, north, path));
            }
        }
        for (cx, cy, north, path) in plans {
            let open = moat(self, cx, cy, north);
            let blocked: Vec<bool> = (0..self.cells()).map(|i| zone[i] && !open.contains(&i)).collect();
            crate::mapgen::dig_channel(self, &path, &blocked);
            for i in moat(self, cx, cy, !north) {
                let (x, y) = ((i as i32) % w, (i as i32) / w);
                for (mx, my) in [(x, y), (w - 1 - x, y)] {
                    if self.contains(mx, my) {
                        let j = self.idx(mx, my);
                        self.terrain[j] = Terrain::Rock;
                        self.clear_resource(j);
                    }
                }
            }
        }
    }

    /// One base pocket around the yard centre (cx, cy) with radius `r`: a
    /// clearing, two ore fields south-west and south-east of the yard, walls
    /// of three rows north and south (rock, or harbour water with `moats`).
    /// Left-right symmetric around column `cx`, and the same for every base
    /// of a map (same `seed`).
    fn stamp_pocket(&mut self, cx: i32, cy: i32, r: i32, ore_max: u8, seed: u64, moats: bool) {
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
        // Three rows each: rock, or harbour water in the naval styles.
        let wall = if moats { Terrain::Water } else { Terrain::Rock };
        for dx in -half..=half {
            for dy in [-r - 1, -r - 2, -r - 3, r + 3, r + 4, r + 5] {
                self.set_terrain(cx + dx, cy + dy, wall);
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
    /// `gem_core` of a field's centre get gems instead of ore. Rock and trees
    /// under a field are cleared; water and fords are left alone.
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
                    self.put_ore(x, y + oy, value, max, d <= gem_core * gem_core);
                }
            }
        }
    }

    /// Ore on a cell: rock and trees are cleared first, water and fords keep
    /// no ore.
    fn put_ore(&mut self, x: i32, y: i32, value: u8, max: u8, gems: bool) {
        if !self.contains(x, y) {
            return;
        }
        let i = self.idx(x, y);
        if self.terrain[i].ship_passable() {
            return;
        }
        if !self.terrain[i].holds_ore() {
            self.terrain[i] = Terrain::Clear;
        }
        self.put_resource(i, value, max, gems);
    }

    /// Water takes land that maps without it use for ore, so economies on
    /// water maps would run dry long before land maps'. Add ore fields on
    /// open land of the left half, away from the bases, until the map
    /// (mirrored) holds `target` ore and gem cells. With `band` (two rows of
    /// bases) fields go into the top band and repeat in the bottom band.
    #[allow(clippy::too_many_arguments)]
    fn top_up_ore(&mut self, rng: &mut Rng, zone: &[bool], target: usize, ore_max: u8, band: Option<i32>, home: (i32, i32)) {
        let (w, h) = (self.width, self.height);
        // Only ore harvesters can drive to counts: land joined to the bases
        // (islands are left out; fords are dug later and only join land).
        let mut mainland = vec![false; self.cells()];
        let mut stack = vec![self.idx(home.0.clamp(0, w - 1), home.1.clamp(0, h - 1))];
        mainland[stack[0]] = true;
        while let Some(i) = stack.pop() {
            let (x, y) = ((i as i32) % w, (i as i32) / w);
            for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                if self.contains(x + dx, y + dy) {
                    let j = self.idx(x + dx, y + dy);
                    if !mainland[j] && !self.terrain[j].ship_passable() {
                        mainland[j] = true;
                        stack.push(j);
                    }
                }
            }
        }
        let count = |m: &Map| (0..m.cells()).filter(|&i| mainland[i] && m.has_resource(i) && (i as i32 % w) < w / 2).count() * 2;
        // Every spot of the left half (top band with `band`) where a field
        // fits: on the bases' land, clear of the bases and of other ore, mostly
        // dry. Then fields at those spots, in an order the seed shuffles,
        // until the map holds `target` cells.
        let r = 3;
        let fits = |m: &Map, x: i32, cy: i32| -> bool {
            let mut land = 0;
            let mut cells = 0;
            for yy in cy - r - 1..=cy + r + 1 {
                for xx in x - r - 1..=x + r + 1 {
                    if !m.contains(xx, yy) || zone[m.idx(xx, yy)] {
                        return false;
                    }
                    let i = m.idx(xx, yy);
                    if m.has_resource(i) {
                        return false;
                    }
                    cells += 1;
                    if mainland[i] && !m.terrain[i].ship_passable() {
                        land += 1;
                    }
                }
            }
            mainland[m.idx(x, cy)] && land * 10 >= cells * 7
        };
        let mut spots: Vec<(u64, i32, i32)> = Vec::new();
        for y in (r + 1..band.unwrap_or(h) - r - 1).step_by(2) {
            for x in (r + 1..w / 2 - r - 1).step_by(2) {
                if fits(self, x, y) && band.is_none_or(|b| fits(self, x, y + b)) {
                    spots.push((rng.next_u64(), x, y));
                }
            }
        }
        spots.sort_unstable();
        for (field_seed, x, y) in spots {
            if count(self) >= target {
                return;
            }
            // Fields placed meanwhile may have taken the spot.
            if !fits(self, x, y) || band.is_some_and(|b| !fits(self, x, y + b)) {
                continue;
            }
            let gems = style_gem_core(w, x, r);
            self.ore_field(&mut Rng::new(field_seed), x, y, r, ore_max, gems);
            if let Some(b) = band {
                self.ore_field(&mut Rng::new(field_seed), x, y + b, r, ore_max, gems);
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

    /// Random terrain over the whole map: rough patches, `lakes` times the
    /// usual number of small lakes, rock ridges and tree clusters.
    fn scatter(&mut self, rng: &mut Rng, lakes: i32) {
        let (width, height) = (self.width, self.height);
        let area = width * height;
        // Rough patches.
        for _ in 0..(area / 900).max(2) {
            let (cx, cy) = (rng.range(0, width), rng.range(0, height));
            let r = rng.range(2, 6);
            self.blob(rng, cx, cy, r, Terrain::Rough);
        }
        // Lakes (the naval styles draw their water separately).
        for _ in 0..(area / 3500).max(1) * lakes {
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
            if !t.holds_ore() {
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
                // Denser in the middle of the field.
                let fall = (d * max as i32) / (r * r + 1);
                let value = (max as i32 - fall + rng.range(-2, 2)).clamp(2, max as i32) as u8;
                self.put_ore(x, y, value, max, d <= gem_core * gem_core);
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

/// Ore and gem cells, per mille of the map, that a generated map holds at
/// least on the land its bases reach: what the generator made before map
/// styles (about 4.5 % on two-player maps, 6 to 7 % with more players), a
/// third more on the water styles, whose games run longer (ore trucks wade
/// through fords, armies go round lakes and seas) and would otherwise
/// harvest the reachable land bare before anyone wins.
fn ore_share(style: MapStyle, two: bool) -> usize {
    match (style.naval(), two) {
        (false, true) => 45,
        (false, false) => 60,
        (true, true) => 60,
        (true, false) => 80,
    }
}

/// Radius of the gem middle of the contested fields of two-player maps.
const CONTESTED_GEM_CORE: i32 = 2;

/// Gem middle of a style's ore field (mapgen): fields in the middle fifth of
/// the map (river crossings, islands, passes near the mirror axis) are
/// contested and carry gems in their middle like the contested fields;
/// fields nearer a base hold ore only.
fn style_gem_core(width: i32, x: i32, r: i32) -> i32 {
    let middle = (2 * x - (width - 1)).abs() <= width / 5;
    if middle && r >= 2 {
        r - 1
    } else {
        0
    }
}

/// Pocket radius for bases at these yard centres: as large as the distance
/// to the nearest neighbour allows, 6 to 10 cells.
pub(crate) fn pocket_radius(centres: &[(i32, i32)]) -> i32 {
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
                for seed in 0..8 {
                    // Every style twice.
                    let style = MapStyle::CONCRETE[seed as usize % 4];
                    let m = Map::generate_styled(size, size, seed, 12, players, style);
                    let what = format!("{players} players, {style:?}, size {size}, seed {seed}");
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
                        // same picture for ground units (a harbour moat walls like rock); the
                        // right half of a centred base is shifted by a cell.
                        for dy in -r - 3..=r + 5 {
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
                                let ground =
                                    |k: usize| (m.terrain[k].passable(), m.terrain[k] == Terrain::Rough, m.ore[k] > 0, m.gems[k] > 0);
                                assert_eq!(ground(i), ground(j), "{what}: base at {sx},{sy} differs at offset {dx},{dy}");
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
                let m = Map::generate_styled(size, size, seed, 12, 2, MapStyle::CONCRETE[seed as usize % 4]);
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

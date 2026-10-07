//! Terrain grid, ore layer and the seeded skirmish map generator.

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

/// Index into a locomotor's speed table (see `TERRAIN_TYPES` in gen_rules.py).
pub const SPEED_CLEAR: usize = 0;
pub const SPEED_ROUGH: usize = 1;
pub const SPEED_ORE: usize = 2;

pub struct Map {
    pub width: i32,
    pub height: i32,
    pub terrain: Vec<Terrain>,
    /// Ore density per cell (0 = none).
    pub ore: Vec<u8>,
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

    pub fn speed_class(&self, i: usize) -> usize {
        if self.ore[i] > 0 {
            SPEED_ORE
        } else if self.terrain[i] == Terrain::Rough {
            SPEED_ROUGH
        } else {
            SPEED_CLEAR
        }
    }

    /// Generate a two-player map with 180 degree rotational symmetry.
    pub fn generate(width: i32, height: i32, seed: u64, ore_max: u8) -> Map {
        let mut rng = Rng::new(seed);
        let n = (width * height) as usize;
        let mut m =
            Map { width, height, terrain: vec![Terrain::Clear; n], ore: vec![0; n], spawns: vec![(8, 8), (width - 11, height - 12)] };

        let area = width * height;
        // Rough patches.
        for _ in 0..(area / 900).max(2) {
            let (cx, cy) = (rng.range(0, width), rng.range(0, height));
            let r = rng.range(2, 6);
            m.blob(&mut rng, cx, cy, r, Terrain::Rough);
        }
        // Lakes.
        for _ in 0..(area / 3500).max(1) {
            let (cx, cy) = (rng.range(0, width), rng.range(0, height));
            let r = rng.range(3, 7);
            m.blob(&mut rng, cx, cy, r, Terrain::Water);
        }
        // Rock ridges as random walks.
        for _ in 0..(area / 1400).max(2) {
            let (mut x, mut y) = (rng.range(0, width), rng.range(0, height));
            let (dx, dy) = (rng.range(-1, 2), rng.range(-1, 2));
            for _ in 0..rng.range(6, 18) {
                for (ox, oy) in [(0, 0), (1, 0), (0, 1)] {
                    m.set_terrain(x + ox, y + oy, Terrain::Rock);
                }
                x += dx + rng.range(-1, 2);
                y += dy + rng.range(-1, 2);
            }
        }
        // Tree clusters.
        for _ in 0..(area / 500).max(4) {
            let (cx, cy) = (rng.range(0, width), rng.range(0, height));
            for _ in 0..rng.range(3, 12) {
                m.set_terrain(cx + rng.range(-3, 4), cy + rng.range(-3, 4), Terrain::Tree);
            }
        }

        // Clear the bases.
        let spawns = m.spawns.clone();
        for &(sx, sy) in &spawns {
            m.fill_circle(sx + 1, sy + 2, 11, Terrain::Clear);
        }
        // Ore: one field next to each base (toward the map center), plus contested fields.
        let (mx, my) = (width / 2, height / 2);
        let (sx, sy) = spawns[0];
        m.ore_field(&mut rng, sx + 13, sy + 4, 4, ore_max);
        m.ore_field(&mut rng, sx + 3, sy + 13, 3, ore_max);
        m.ore_field(&mut rng, mx - 6, my + 4, 5, ore_max);
        m.ore_field(&mut rng, mx + 10, my - 12, 4, ore_max);

        m.mirror();
        m.ensure_connected(spawns[0], spawns[1]);
        m
    }

    /// Map for `players` starting positions (2..8). Two players keep the
    /// classic 180 degree symmetric layout; four players on a square map get
    /// 90 degree rotational symmetry; other counts sit on a ring around the
    /// centre with identical base surroundings.
    pub fn generate_for(width: i32, height: i32, seed: u64, ore_max: u8, players: usize) -> Map {
        let players = players.clamp(2, 8);
        if players == 2 {
            return Map::generate(width, height, seed, ore_max);
        }
        let mut m = Map::generate(width, height, seed, ore_max);
        // Wipe the 2-player bases and ore; rebuild for N players below.
        m.ore.iter_mut().for_each(|o| *o = 0);
        let mut rng = Rng::new(seed ^ 0x5eed_0000_0000_0004);
        let (cx, cy) = (width / 2, height / 2);
        let radius = (width.min(height) / 2 - 12).max(10);
        let mut spawns = Vec::new();
        for i in 0..players {
            // Angle in 1024 units, starting top-left like the 2-player map.
            let a = 896 + (i as i32 * 1024) / players as i32;
            let (vx, vy) = crate::math::facing_vec(a);
            let sx = cx + vx * radius / 1024 - 1;
            let sy = cy + vy * radius / 1024 - 2;
            spawns.push((sx.clamp(2, width - 5), sy.clamp(2, height - 6)));
        }
        m.spawns = spawns.clone();
        if players == 4 && width == height {
            m.rotate_symmetric();
            // Recompute the spawns as exact rotations of the first one.
            let (x0, y0) = m.spawns[0];
            let rot = |x: i32, y: i32| (width - 1 - y, x);
            let mut s = vec![(x0, y0)];
            let (mut x, mut y) = (x0 + 1, y0 + 1); // centre-ish cell of the 3x4 yard
            for _ in 0..3 {
                let (nx, ny) = rot(x, y);
                x = nx;
                y = ny;
                s.push((x - 1, y - 1));
            }
            m.spawns = s;
        }
        let spawns = m.spawns.clone();
        if players == 4 && width == height {
            // Build one base in the top-left quadrant, carve a road to the
            // centre, then rotate it into the other three quadrants.
            let (sx, sy) = spawns[0];
            m.fill_circle(sx + 1, sy + 2, 11, Terrain::Clear);
            m.ore_field(&mut rng, sx + 1 + 12, sy + 2 + 4, 4, ore_max);
            m.ore_field(&mut rng, sx + 1 + 3, sy + 2 + 13, 3, ore_max);
            m.ore_field(&mut rng, cx - 6, cy - 6, 4, ore_max);
            m.carve((sx + 1, sy + 1), (cx - 1, cy - 1));
            m.rotate_symmetric();
            m.fill_circle(cx, cy, 3, Terrain::Clear);
            return m;
        }
        for &(sx, sy) in &spawns {
            m.fill_circle(sx + 1, sy + 2, 11, Terrain::Clear);
            // Two ore fields per base, toward the centre.
            let (dx, dy) = ((cx - sx).signum(), (cy - sy).signum());
            m.ore_field(&mut rng, sx + 1 + dx * 12, sy + 2 + dy * 4, 4, ore_max);
            m.ore_field(&mut rng, sx + 1 + dx * 3, sy + 2 + dy * 13, 3, ore_max);
        }
        // Contested ore in the middle.
        m.ore_field(&mut rng, cx, cy, 5, ore_max);
        for &(sx, sy) in &spawns[1..] {
            m.ensure_connected(spawns[0], (sx, sy));
        }
        m
    }

    /// Make the map 90 degree rotationally symmetric by copying the top-left quadrant.
    fn rotate_symmetric(&mut self) {
        let w = self.width;
        let src_t = self.terrain.clone();
        let src_o = self.ore.clone();
        for y in 0..w {
            for x in 0..w {
                // Rotate (x, y) back into the top-left quadrant.
                let (mut qx, mut qy) = (x, y);
                for _ in 0..4 {
                    if qx < w / 2 && qy < w / 2 {
                        break;
                    }
                    let (nx, ny) = (qy, w - 1 - qx);
                    qx = nx;
                    qy = ny;
                }
                let (i, j) = (self.idx(x, y), self.idx(qx, qy));
                self.terrain[i] = src_t[j];
                self.ore[i] = src_o[j];
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
                self.ore[i] = 0;
            }
        }
    }

    fn fill_circle(&mut self, cx: i32, cy: i32, r: i32, t: Terrain) {
        for y in cy - r..=cy + r {
            for x in cx - r..=cx + r {
                if (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r && self.contains(x, y) {
                    let i = self.idx(x, y);
                    self.terrain[i] = t;
                    self.ore[i] = 0;
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

    fn ore_field(&mut self, rng: &mut Rng, cx: i32, cy: i32, r: i32, max: u8) {
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
                self.ore[i] = (max as i32 - fall + rng.range(-2, 2)).clamp(2, max as i32) as u8;
            }
        }
    }

    /// Copy the first half onto the second half, rotated 180 degrees.
    fn mirror(&mut self) {
        let n = self.cells();
        for i in 0..n / 2 {
            let j = n - 1 - i;
            self.terrain[j] = self.terrain[i];
            self.ore[j] = self.ore[i];
        }
    }

    /// Carve a 3-cell wide corridor between the bases if ground units could not
    /// otherwise reach each other.
    fn ensure_connected(&mut self, a: (i32, i32), b: (i32, i32)) {
        if self.reachable(a, b) {
            return;
        }
        self.carve((a.0 + 1, a.1 + 1), (b.0 + 1, b.1 + 1));
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

    /// Ore growth: dense fields slowly regrow and spread to neighbouring clear cells.
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
                if self.ore[j] == 0 && self.terrain[j].buildable() && !blocked[j] {
                    self.ore[j] = 1;
                    changed = true;
                }
            }
        }
        changed
    }
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
        let m = Map::generate_for(96, 96, 9, 12, 4);
        let w = 96;
        for y in 0..w {
            for x in 0..w {
                assert_eq!(m.terrain[m.idx(x, y)], m.terrain[m.idx(w - 1 - y, x)], "4-way symmetric");
            }
        }
    }

    #[test]
    fn generated_map_is_symmetric_and_connected() {
        for seed in 0..20 {
            let m = Map::generate(96, 96, seed, 12);
            let n = m.cells();
            for i in 0..n {
                assert_eq!(m.terrain[i], m.terrain[n - 1 - i]);
            }
            assert!(m.reachable(m.spawns[0], m.spawns[1]), "seed {seed}");
            assert!(m.ore.iter().filter(|&&o| o > 0).count() > 50);
        }
    }
}

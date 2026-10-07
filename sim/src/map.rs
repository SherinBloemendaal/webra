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
        let (mut x, mut y) = (a.0 + 1, a.1 + 1);
        let (tx, ty) = (b.0 + 1, b.1 + 1);
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

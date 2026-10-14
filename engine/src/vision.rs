//! Shroud and fog of war, plus "ghosts" of enemy buildings last seen under fog.

use crate::math::CELL;
use crate::rules::{FootCell, Kind};
use crate::world::{Ghost, World};

impl World {
    pub(crate) fn circle(&mut self, sight: i32) -> usize {
        let r = (sight + CELL - 1) / CELL;
        let r_us = r as usize;
        while self.circle_cache.len() <= r_us {
            self.circle_cache.push(Vec::new());
        }
        if self.circle_cache[r_us].is_empty() {
            let mut offs = Vec::new();
            let lim = (sight as i64) * (sight as i64);
            for dy in -r..=r {
                for dx in -r..=r {
                    let (wx, wy) = (dx as i64 * CELL as i64, dy as i64 * CELL as i64);
                    if wx * wx + wy * wy <= lim {
                        offs.push((dx, dy));
                    }
                }
            }
            self.circle_cache[r_us] = offs;
        }
        r_us
    }

    pub(crate) fn update_vision(&mut self) {
        for p in self.players.iter_mut() {
            p.visible.iter_mut().for_each(|v| *v = 0);
        }
        // Each unit's sight circle, as row spans counted into a difference
        // array per player (+1 where a span starts, -1 after it ends), so a
        // crowd of units costs a few writes per row of its circles instead
        // of a write per cell; a running sum along each row then marks
        // every cell some circle covers. The same cells as stamping every
        // circle cell by cell.
        let (w, h) = (self.map.width, self.map.height);
        let stride = w as usize + 1;
        let mut diff: Vec<Vec<i32>> = vec![Vec::new(); self.players.len()];
        // Spans (dy, first dx, last dx) of the circles used, by `circle` index.
        let mut spans: Vec<Vec<(i32, i32, i32)>> = Vec::new();
        let n = self.actors.len();
        for i in 0..n {
            let a = &self.actors[i];
            // Passengers see nothing from inside their transport; the
            // neutral player's vision is never used (neutral.rs).
            if !a.alive || !a.in_world() || self.players[a.owner as usize].neutral {
                continue;
            }
            // Rain, snowfall and sandstorms shorten sight (weather.rs).
            let sight = self.env.sight(self.rules.actors[a.ty as usize].sight);
            if sight <= 0 {
                continue;
            }
            let (owner, x, y) = (a.owner as usize, a.x, a.y);
            let ci = self.circle(sight);
            let (cx, cy) = self.cell_of(x, y);
            if spans.len() <= ci {
                spans.resize(ci + 1, Vec::new());
            }
            if spans[ci].is_empty() {
                spans[ci] = circle_spans(&self.circle_cache[ci]);
            }
            let d = &mut diff[owner];
            if d.is_empty() {
                *d = vec![0; stride * h as usize];
            }
            for &(dy, x0, x1) in &spans[ci] {
                let vy = cy + dy;
                let (x0, x1) = ((cx + x0).max(0), (cx + x1).min(w - 1));
                if vy < 0 || vy >= h || x0 > x1 {
                    continue;
                }
                let row = vy as usize * stride;
                d[row + x0 as usize] += 1;
                d[row + x1 as usize + 1] -= 1;
            }
        }
        for (p, d) in self.players.iter_mut().zip(&diff) {
            if d.is_empty() {
                continue;
            }
            for vy in 0..h as usize {
                let mut covered = 0;
                for vx in 0..w as usize {
                    covered += d[vy * stride + vx];
                    if covered > 0 {
                        let idx = vy * w as usize + vx;
                        p.visible[idx] = 1;
                        p.explored[idx] = 1;
                    }
                }
            }
        }
        // Support power cameras and spy planes (powers.rs).
        self.apply_power_reveals();
        // Mission cameras, flares and condition sight (mission/conditions.rs).
        if self.mission.is_some() {
            self.apply_mission_reveals();
        }
        // Allies share vision (OpenRA default for teams).
        if self.has_alliances() {
            let own: Vec<Vec<u8>> = self.players.iter().map(|p| p.visible.clone()).collect();
            for a in 0..self.players.len() {
                for (b, theirs) in own.iter().enumerate() {
                    if a != b && self.are_allies(a as u8, b as u8) {
                        let p = &mut self.players[a];
                        for (i, &v) in theirs.iter().enumerate() {
                            if v != 0 {
                                p.visible[i] = 1;
                                p.explored[i] = 1;
                            }
                        }
                    }
                }
            }
        }
        if !self.options.fog {
            // "Fog of war" off: everything ever explored stays visible.
            for p in self.players.iter_mut() {
                for (v, &e) in p.visible.iter_mut().zip(p.explored.iter()) {
                    *v |= e;
                }
            }
        }
        // Gap generators re-shroud cells for their enemies (abilities.rs).
        self.apply_generated_shroud();
        // Debug menu "disable shroud" (debug.rs) beats every other rule.
        self.apply_dev_vision();
        self.update_ghosts();
    }

    fn update_ghosts(&mut self) {
        for p in 0..self.players.len() {
            let pid = p as u8;
            // Forget ghosts whose spot is visible again but the building is gone or changed.
            let stale: Vec<u32> = self.players[p]
                .ghosts
                .iter()
                .filter(|(_, g)| {
                    let b = self.rules.actors[g.ty as usize].building.as_ref().unwrap();
                    let seen = b
                        .footprint
                        .iter()
                        .any(|&(dx, dy, c)| c != FootCell::Empty && self.players[p].visible[self.map.idx(g.cx + dx, g.cy + dy)] != 0);
                    seen && self.resolve(g.actor).is_none()
                })
                .map(|(k, _)| *k)
                .collect();
            for k in stale {
                self.players[p].ghosts.remove(&k);
            }
            for i in 0..self.actors.len() {
                let a = &self.actors[i];
                // Trees, rocks and bridges show once explored, without ghosts (neutral.rs).
                if !a.alive || a.kind != Kind::Building || a.owner == pid || self.rules.actors[a.ty as usize].world.shroud_only {
                    continue;
                }
                if self.is_visible_to(i, pid) && !self.is_cloaked_from(i, pid) {
                    let g = Ghost { actor: self.make_ref(i), ty: a.ty, owner: a.owner, cx: a.cx, cy: a.cy };
                    self.players[p].ghosts.insert(g.actor, g);
                }
            }
        }
    }
}

/// The rows of a sight circle (`World::circle`) as spans (dy, first dx,
/// last dx). A circle's cells in a row are always one unbroken run.
fn circle_spans(offs: &[(i32, i32)]) -> Vec<(i32, i32, i32)> {
    let mut spans: Vec<(i32, i32, i32)> = Vec::new();
    for &(dx, dy) in offs {
        match spans.iter_mut().find(|s| s.0 == dy) {
            Some(s) => {
                s.1 = s.1.min(dx);
                s.2 = s.2.max(dx);
            }
            None => spans.push((dy, dx, dx)),
        }
    }
    debug_assert_eq!(spans.iter().map(|s| (s.2 - s.1 + 1) as usize).sum::<usize>(), offs.len(), "a circle row is one run");
    spans
}

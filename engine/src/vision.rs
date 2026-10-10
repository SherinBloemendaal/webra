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
            let (w, h) = (self.map.width, self.map.height);
            let p = &mut self.players[owner];
            for &(dx, dy) in &self.circle_cache[ci] {
                let (vx, vy) = (cx + dx, cy + dy);
                if vx >= 0 && vy >= 0 && vx < w && vy < h {
                    let idx = (vy * w + vx) as usize;
                    p.visible[idx] = 1;
                    p.explored[idx] = 1;
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

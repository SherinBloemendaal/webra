//! Combat: target acquisition, aiming, firing, projectiles and damage.
//!
//! Units and defensive structures share the same weapon code. Every number
//! comes from OpenRA's weapon rules: range and minimum range, reload and
//! burst, projectile speed and inaccuracy, and damage warheads with spread,
//! falloff, an armour-type versus table, target classes and delays.

use crate::math::{dist, dist_sq, facing_of, facing_vec, turn_toward, CELL};
use crate::rules::{Kind, Projectile as ProjKind, WarheadKind};
use crate::world::{cell_center, Activity, Effect, EffectKind, PendingImpact, Projectile, World, MAX_WEAPONS, NONE};

const SCAN_INTERVAL: i32 = 8;

impl World {
    pub(crate) fn has_weapons(&self, i: usize) -> bool {
        !self.rules.actors[self.actors[i].ty as usize].weapons.is_empty()
    }

    /// Current target classes of actor `i` (rules::TARGET_* bits). Most actors
    /// use their kind's class; submarines switch between surfaced and
    /// submerged classes (naval.rs).
    pub fn target_class(&self, i: usize) -> u32 {
        let a = &self.actors[i];
        match a.kind {
            Kind::Ship => self.ship_target_class(i),
            // Landed aircraft are ground targets, paratroopers under their
            // parachute airborne ones (plane.rs, target_kind).
            Kind::Aircraft | Kind::Infantry => self.target_kind(i).target_class(),
            // Naval yards are WaterActor and Structure in OpenRA (torpedoes hit them).
            Kind::Building if self.rules.actors[a.ty as usize].building.as_ref().is_some_and(|b| b.on_water) => {
                crate::rules::TARGET_STRUCTURE | crate::rules::TARGET_WATER
            }
            // Landed aircraft count as vehicles, paratroopers in the air as air (plane.rs).
            _ => self.target_kind(i).target_class(),
        }
    }

    /// Structures that need power (Tesla Coil, AA, superweapons) shut down on low power.
    pub fn is_powered_down(&self, i: usize) -> bool {
        let a = &self.actors[i];
        self.rules.actors[a.ty as usize].requires_power && self.players[a.owner as usize].low_power()
    }

    // ---- Target acquisition ------------------------------------------------

    /// Closest visible enemy that one of this actor's weapons can hit within
    /// range. Units are preferred over structures and walls are ignored, like
    /// OpenRA's default auto-target priorities.
    pub(crate) fn scan_for_target(&self, i: usize) -> Option<usize> {
        let a = &self.actors[i];
        let info = &self.rules.actors[a.ty as usize];
        let range = info.max_range(&self.rules);
        if range == 0 {
            return None;
        }
        let r_cells = range / CELL + 2;
        let (cx, cy) = self.cell_of(a.x, a.y);
        let range_sq = (range as i64) * (range as i64);
        let mut best_unit: Option<(i64, usize)> = None;
        let mut best_building: Option<(i32, usize)> = None;
        let vis = &self.players[a.owner as usize].visible;
        for y in cy - r_cells..=cy + r_cells {
            for x in cx - r_cells..=cx + r_cells {
                if !self.map.contains(x, y) {
                    continue;
                }
                let ci = self.map.idx(x, y);
                if vis[ci] == 0 {
                    continue;
                }
                for &u in self.units_in_cell(ci) {
                    let u = u as usize;
                    let t = &self.actors[u];
                    if !t.alive
                        || !self.are_enemies(a.owner, t.owner)
                        || !info.can_attack_class(&self.rules, self.target_class(u))
                        || !self.targetable(u, a.owner)
                    {
                        continue;
                    }
                    let d = dist_sq(a.x, a.y, t.x, t.y);
                    if d <= range_sq && best_unit.is_none_or(|(bd, bi)| d < bd || (d == bd && u < bi)) {
                        best_unit = Some((d, u));
                    }
                }
                let b = self.building_at[ci];
                if b != NONE && best_unit.is_none() {
                    let b = b as usize;
                    let t = &self.actors[b];
                    if t.alive
                        && self.are_enemies(a.owner, t.owner)
                        && !self.is_cloaked_from(b, a.owner)
                        && !self.rules.actors[t.ty as usize].is_wall()
                        && info.can_attack(&self.rules, Kind::Building)
                    {
                        let d = self.hit_distance(b, a.x, a.y);
                        if d <= range && best_building.is_none_or(|(bd, bi)| d < bd || (d == bd && b < bi)) {
                            best_building = Some((d, b));
                        }
                    }
                }
            }
        }
        best_unit.map(|(_, u)| u).or(best_building.map(|(_, b)| b))
    }

    /// Whether `player` can currently target actor `t` (visible, and not cloaked).
    pub(crate) fn targetable(&self, t: usize, player: u8) -> bool {
        // Falling wrecks and the spy plane cannot be targeted (plane.rs); cloaked actors neither (abilities.rs).
        self.is_visible_to(t, player) && !self.untargetable_aircraft(t) && !self.is_cloaked_from(t, player)
    }

    pub(crate) fn try_auto_target(&mut self, i: usize) -> bool {
        if !self.has_weapons(i) {
            return false;
        }
        // HoldFire stance (Phase Transport stays cloaked until ordered to attack).
        // Ground units only: ships and aircraft belong to their own modules.
        let a = &self.actors[i];
        if matches!(a.kind, crate::rules::Kind::Vehicle | crate::rules::Kind::Infantry)
            && self.rules.actors[a.ty as usize].abilities.hold_fire.is_some()
            && !self.players[a.owner as usize].is_ai
        {
            return false;
        }
        let a = &mut self.actors[i];
        a.scan_cooldown -= 1;
        if a.scan_cooldown > 0 {
            return false;
        }
        a.scan_cooldown = SCAN_INTERVAL;
        if let Some(t) = self.scan_for_target(i) {
            let tref = self.make_ref(t);
            let a = &mut self.actors[i];
            a.target = tref;
            a.forced = false;
            a.chase_cell = NONE;
            if a.kind != Kind::Building {
                a.activity = Activity::Attack;
            }
            return true;
        }
        false
    }

    /// Current valid target of `i`, if any.
    pub(crate) fn live_target(&self, i: usize) -> Option<usize> {
        let owner = self.actors[i].owner;
        // Forced attacks may target anyone but yourself (e.g. a neutral wall).
        let forced = self.actors[i].forced;
        self.resolve(self.actors[i].target).filter(|&t| {
            self.actors[t].owner != owner && (forced || self.are_enemies(owner, self.actors[t].owner)) && self.targetable(t, owner)
        })
    }

    // ---- Units ---------------------------------------------------------------

    pub(crate) fn tick_attack(&mut self, i: usize) {
        let Some(t) = self.live_target(i) else {
            self.actors[i].target = NONE;
            if self.actors[i].attack_move {
                // Resume the attack-move toward the original destination.
                let (dx, dy) = self.actors[i].dest;
                let (gx, gy) = self.cell_toward(dx, dy, self.actors[i].x, self.actors[i].y);
                let goal = self.path_goal(i, gx, gy);
                let a = &mut self.actors[i];
                a.goal = goal;
                a.activity = if goal == NONE { Activity::Idle } else { Activity::Move };
                a.best_dist = i32::MAX;
                a.stuck_ticks = 0;
            } else {
                self.actors[i].activity = Activity::Idle;
            }
            return;
        };
        let info = &self.rules.actors[self.actors[i].ty as usize];
        let tclass = self.target_class(t);
        let usable: Vec<usize> = info.weapons.iter().copied().filter(|&w| self.rules.weapons[w].can_target_class(tclass)).collect();
        if usable.is_empty() {
            self.actors[i].target = NONE;
            self.actors[i].activity = Activity::Idle;
            return;
        }
        let range = usable.iter().map(|&w| self.rules.weapons[w].range).max().unwrap();
        let min_range = usable.iter().map(|&w| self.rules.weapons[w].min_range).min().unwrap();
        let (x, y) = (self.actors[i].x, self.actors[i].y);
        let d = self.hit_distance(t, x, y);
        if d <= range && d >= min_range {
            self.aim_and_fire(i, t);
            return;
        }
        if d < min_range {
            // Artillery: back away until the target is outside minimum range.
            let (tx, ty) = (self.actors[t].x, self.actors[t].y);
            let (ax, ay) = (x - tx, y - ty);
            let len = dist(0, 0, ax, ay).max(1);
            let (bx, by) = (x + ax * 2 * CELL / len, y + ay * 2 * CELL / len);
            let unit = self.rules.actors[self.actors[i].ty as usize].unit.clone().unwrap();
            self.step_toward(i, bx, by, &unit);
            return;
        }
        // While attack-moving, a closer threat takes priority.
        if !self.actors[i].forced && self.actors[i].attack_move && self.try_auto_target(i) {
            return;
        }
        // Chase: path toward the target's cell (or the nearest reachable one).
        let (tcx, tcy) = self.cell_toward(self.actors[t].x, self.actors[t].y, x, y);
        let tcell = self.map.idx(tcx, tcy) as u32;
        if self.actors[i].chase_cell != tcell || self.actors[i].goal == NONE {
            let goal = self.path_goal(i, tcx, tcy);
            let a = &mut self.actors[i];
            a.chase_cell = tcell;
            a.goal = goal;
        }
        let goal = self.actors[i].goal;
        if goal == NONE {
            self.actors[i].activity = Activity::Idle;
            return;
        }
        self.move_toward(i, goal);
    }

    // ---- Structures -----------------------------------------------------------

    /// Defences: keep a target, aim the turret and fire. Unpowered ones idle.
    pub(crate) fn tick_defense(&mut self, i: usize) {
        if !self.has_weapons(i) || self.is_powered_down(i) {
            return;
        }
        let info = &self.rules.actors[self.actors[i].ty as usize];
        let range = info.max_range(&self.rules);
        let keep = self.live_target(i).filter(|&t| self.hit_distance(t, self.actors[i].x, self.actors[i].y) <= range);
        let t = match keep {
            Some(t) => t,
            None => {
                self.actors[i].target = NONE;
                if !self.try_auto_target(i) {
                    return;
                }
                match self.live_target(i) {
                    Some(t) => t,
                    None => return,
                }
            }
        };
        self.aim_and_fire(i, t);
    }

    /// Self repair (Mammoth Tank): heals below a health threshold after a damage cooldown.
    pub(crate) fn tick_self_heal(&mut self, i: usize) {
        let ty = self.actors[i].ty as usize;
        let Some(h) = self.rules.actors[ty].self_heal.clone() else { return };
        let max = self.rules.actors[ty].hp;
        let a = &mut self.actors[i];
        if a.hp * 100 >= max * h.start_if_below || self.tick < a.last_damaged + h.damage_cooldown as u32 {
            a.heal_timer = 0;
            return;
        }
        a.heal_timer += 1;
        if a.heal_timer >= h.delay {
            a.heal_timer = 0;
            a.hp = (a.hp + h.step).min(max);
        }
    }

    // ---- Firing ------------------------------------------------------------------

    pub(crate) fn aim_and_fire(&mut self, i: usize, t: usize) {
        let ty = self.actors[i].ty as usize;
        let info = &self.rules.actors[ty];
        let turret = info.turret_turn_speed;
        let unit = info.unit.clone();
        let (x, y) = (self.actors[i].x, self.actors[i].y);
        let (tx, ty_) = (self.actors[t].x, self.actors[t].y);
        let desired = facing_of(tx - x, ty_ - y).unwrap_or(self.actors[i].facing);
        let aligned = {
            let a = &mut self.actors[i];
            if let Some(ts) = turret {
                a.turret = turn_toward(a.turret, desired, ts);
                a.turret == desired
            } else if let Some(u) = &unit {
                if u.turn_in_place {
                    a.facing = desired;
                    true
                } else {
                    a.facing = turn_toward(a.facing, desired, u.turn_speed);
                    a.facing == desired
                }
            } else {
                true // structures without a turret (Tesla Coil) fire in any direction
            }
        };
        if !aligned {
            return;
        }
        let tclass = self.target_class(t);
        let reload_override = self.rules.actors[ty].reload_override;
        let weapons = self.rules.actors[ty].weapons.clone();
        let d = self.hit_distance(t, x, y);
        for (slot, &w) in weapons.iter().enumerate().take(MAX_WEAPONS) {
            let wi = &self.rules.weapons[w];
            if self.actors[i].reload[slot] > 0 || !wi.can_target_class(tclass) || d > wi.range || d < wi.min_range {
                continue;
            }
            // Submarines surface to fire (Cloak UncloakOn: Attack).
            self.naval_on_fire(i);
            self.fire(i, t, w);
            // Firing heats vehicles up in a heat wave (weather.rs).
            self.actors[i].env.fired = true;
            // Uncloak on attack; a demolition truck detonates (abilities.rs).
            self.on_fire(i);
            if !self.actors[i].alive {
                return;
            }
            let wi = &self.rules.weapons[w];
            let a = &mut self.actors[i];
            a.burst_shot[slot] += 1;
            if a.burst_shot[slot] < wi.burst {
                a.reload[slot] = wi.burst_delay(a.burst_shot[slot] - 1).max(1);
            } else {
                a.burst_shot[slot] = 0;
                let reload = reload_override.unwrap_or(wi.reload).max(1);
                // Overheated vehicles fire slower (weather.rs).
                a.reload[slot] = if a.env.overheated { reload * crate::weather::OVERHEAT_RELOAD_PCT / 100 } else { reload };
            }
        }
    }

    pub(crate) fn fire(&mut self, i: usize, t: usize, w: usize) {
        let (sx, sy, facing, owner) = {
            let a = &self.actors[i];
            let info = &self.rules.actors[a.ty as usize];
            let f = if info.turret_turn_speed.is_some() { a.turret } else { a.facing };
            let (vx, vy) = facing_vec(f);
            let muzzle = match a.kind {
                Kind::Infantry => 128,
                Kind::Building => 256,
                Kind::Vehicle | Kind::Ship | Kind::Aircraft | Kind::Mine => 384,
            };
            (a.x + vx * muzzle / 1024, a.y + vy * muzzle / 1024, f, a.owner)
        };
        // Aim at the target's hit shape point closest to the shooter (buildings are big).
        let (mut tx, mut ty) = self.aim_point(t, sx, sy);
        let wi = &self.rules.weapons[w];
        if wi.inaccuracy > 0 {
            // OpenRA scales inaccuracy with the distance relative to max range.
            let d = dist(sx, sy, tx, ty);
            let r = (wi.inaccuracy as i64 * d as i64 / wi.range.max(1) as i64) as i32;
            if r > 0 {
                tx += self.rng.range(-r, r + 1);
                ty += self.rng.range(-r, r + 1);
            }
        }
        match wi.projectile {
            ProjKind::Instant => self.impact(w, tx, ty, owner),
            ProjKind::Tesla => {
                self.effects.push(Effect { x: sx, y: sy, tx, ty, kind: EffectKind::TeslaBolt, ttl: 6, max: 6 });
                self.impact(w, tx, ty, owner);
            }
            ProjKind::Bullet | ProjKind::Missile => {
                let tref = self.make_ref(t);
                self.projectiles.push(Projectile { x: sx, y: sy, tx, ty, weapon: w as u16, owner, target: tref, facing });
            }
            // GravityBomb: falls from the shooter's altitude where it was released (plane.rs).
            ProjKind::Bomb => {
                let alt = self.actors[i].altitude;
                self.drop_bomb(w, sx, sy, owner, alt);
            }
        }
    }

    pub(crate) fn aim_point(&self, t: usize, sx: i32, sy: i32) -> (i32, i32) {
        let a = &self.actors[t];
        if a.kind != Kind::Building {
            return (a.x, a.y);
        }
        let b = self.rules.actors[a.ty as usize].building.as_ref().unwrap();
        let mut best = (i64::MAX, a.x, a.y);
        for &(dx, dy) in &b.hit_cells {
            let (cx, cy) = (cell_center(a.cx + dx), cell_center(a.cy + dy));
            let d = dist_sq(sx, sy, cx, cy);
            if d < best.0 {
                best = (d, cx, cy);
            }
        }
        (best.1, best.2)
    }

    pub(crate) fn tick_projectiles(&mut self) {
        // Delayed warheads (Vulcan bursts, chained death explosions) land first.
        let tick = self.tick;
        let due: Vec<PendingImpact> = {
            let (due, rest): (Vec<PendingImpact>, Vec<PendingImpact>) =
                std::mem::take(&mut self.pending).into_iter().partition(|p| p.tick <= tick);
            self.pending = rest;
            due
        };
        for p in due {
            self.apply_warhead(p.weapon as usize, p.warhead as usize, p.x, p.y, p.owner);
        }
        let mut k = 0;
        while k < self.projectiles.len() {
            let p = &self.projectiles[k];
            let wi = &self.rules.weapons[p.weapon as usize];
            // Missiles home on a live target; bullets fly to the aimed point.
            let (mut tx, mut ty) = (p.tx, p.ty);
            if wi.projectile == ProjKind::Missile {
                if let Some(t) = self.resolve(p.target) {
                    let (ax, ay) = self.aim_point(t, p.x, p.y);
                    tx = ax;
                    ty = ay;
                }
            }
            let d = dist(p.x, p.y, tx, ty);
            let speed = wi.speed.max(1);
            if d <= speed {
                let (w, owner) = (p.weapon as usize, p.owner);
                self.projectiles.swap_remove(k);
                self.impact(w, tx, ty, owner);
                continue;
            }
            let p = &mut self.projectiles[k];
            p.x += ((tx - p.x) as i64 * speed as i64 / d as i64) as i32;
            p.y += ((ty - p.y) as i64 * speed as i64 / d as i64) as i32;
            p.tx = tx;
            p.ty = ty;
            if let Some(f) = facing_of(tx - p.x, ty - p.y) {
                p.facing = f;
            }
            k += 1;
        }
    }

    /// A weapon lands at a point: each warhead applies now or after its delay.
    pub(crate) fn impact(&mut self, w: usize, x: i32, y: i32, owner: u8) {
        let max_damage = self.rules.weapons[w].max_damage();
        let (kind, ttl) = if max_damage >= 20000 {
            (EffectKind::NukeExplosion, 40)
        } else if max_damage >= 3000 {
            (EffectKind::SmallExplosion, 12)
        } else {
            (EffectKind::Piff, 6)
        };
        // Shells landing in open water splash instead (naval.rs).
        let (kind, ttl) = self.water_impact_effect(x, y, ttl).unwrap_or((kind, ttl));
        self.effects.push(Effect { x, y, tx: x, ty: y, kind, ttl, max: ttl });
        for h in 0..self.rules.weapons[w].warheads.len() {
            let delay = self.rules.weapons[w].warheads[h].delay;
            if delay > 0 {
                self.pending.push(PendingImpact { tick: self.tick + delay as u32, weapon: w as u16, warhead: h as u8, x, y, owner });
            } else {
                self.apply_warhead(w, h, x, y, owner);
            }
        }
    }

    /// Apply one damage warhead. Friendly fire applies, as in OpenRA.
    fn apply_warhead(&mut self, w: usize, h: usize, x: i32, y: i32, _owner: u8) {
        let wh = &self.rules.weapons[w].warheads[h];
        let radius = wh.damage_radius();
        let r_cells = radius / CELL + 2;
        let (cx, cy) = self.cell_of(x, y);
        let mut hits: Vec<(usize, i32)> = Vec::new();
        let mut seen_buildings: Vec<usize> = Vec::new();
        for yy in cy - r_cells..=cy + r_cells {
            for xx in cx - r_cells..=cx + r_cells {
                if !self.map.contains(xx, yy) {
                    continue;
                }
                let ci = self.map.idx(xx, yy);
                for &u in self.units_in_cell(ci) {
                    let u = u as usize;
                    if self.actors[u].alive && wh.affects_class(self.target_class(u)) {
                        let d = self.hit_distance(u, x, y);
                        if d <= radius {
                            hits.push((u, d));
                        }
                    }
                }
                let b = self.building_at[ci];
                if b != NONE && !seen_buildings.contains(&(b as usize)) {
                    let b = b as usize;
                    seen_buildings.push(b);
                    if self.actors[b].alive && wh.affects_class(self.target_class(b)) {
                        let d = self.hit_distance(b, x, y);
                        if d <= radius {
                            hits.push((b, d));
                        }
                    }
                }
                // Mines (abilities.rs) are GroundActor targets too.
                if let Some(m) = self.mine_at(ci) {
                    if wh.affects(Kind::Mine) {
                        let d = self.hit_distance(m, x, y);
                        if d <= radius {
                            hits.push((m, d));
                        }
                    }
                }
            }
        }
        let damages: Vec<(usize, i32)> = hits
            .iter()
            .map(|&(u, d)| {
                let info = &self.rules.actors[self.actors[u].ty as usize];
                let fall = wh.falloff_at(d) as i64;
                let base = match wh.kind {
                    // HealthPercentageDamage: a share of the victim's maximum health.
                    WarheadKind::Percent => info.hp as i64 * wh.damage as i64 / 100,
                    _ => wh.damage as i64,
                };
                (u, (base * wh.versus[info.armor] as i64 / 100 * fall / 100) as i32)
            })
            .collect();
        for (u, dmg) in damages {
            self.damage(u, dmg);
        }
    }

    pub(crate) fn damage(&mut self, u: usize, dmg: i32) {
        if dmg <= 0 || !self.actors[u].alive || self.actors[u].invulnerable_until > self.tick {
            return;
        }
        let tick = self.tick;
        let a = &mut self.actors[u];
        a.hp -= dmg;
        a.flash = 2;
        a.last_damaged = tick;
        if a.hp <= 0 {
            self.kill(u);
        }
    }

    /// Death explosion of a unit (e.g. Demolition Truck's mini nuke, V2 warhead).
    pub(crate) fn death_explosion(&mut self, i: usize) {
        // A plane shot down in the air already exploded where it crashed (plane.rs).
        if self.crashed(i) {
            return;
        }
        let a = &self.actors[i];
        if let Some(w) = self.rules.actors[a.ty as usize].death_weapon {
            // One tick later, so chain reactions ripple outward instead of recursing.
            for h in 0..self.rules.weapons[w].warheads.len() {
                let delay = self.rules.weapons[w].warheads[h].delay.max(1);
                self.pending.push(PendingImpact {
                    tick: self.tick + delay as u32,
                    weapon: w as u16,
                    warhead: h as u8,
                    x: a.x,
                    y: a.y,
                    owner: a.owner,
                });
            }
        }
    }
}

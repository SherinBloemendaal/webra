//! Prerequisites, power, classic per-category production queues and building placement.

use crate::map::Terrain;
use crate::math::{dist, CELL};
use crate::rules::{Kind, QueueType};
use crate::sound_events::SoundEventKind;
use crate::world::{cell_center, Activity, Effect, EffectKind, QueueItem, World, NONE};

/// Most items a single queue holds.
const MAX_QUEUED: usize = 30;

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Requirement {
    pub label: String,
    /// This faction can never meet it (other side or country).
    pub never: bool,
}

fn tech_level_label(level: &str) -> &'static str {
    match level {
        "infonly" => "Infantry only",
        "low" => "Low",
        "medium" => "Medium",
        "high" => "No superweapons",
        _ => "Unrestricted",
    }
}

fn title(s: &str) -> String {
    let mut c = s.chars();
    c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Availability {
    /// Shown in the sidebar (all `~` prerequisites met).
    pub visible: bool,
    /// Can be started now (all prerequisites met).
    pub enabled: bool,
}

impl World {
    pub(crate) fn refresh_tokens(&mut self) {
        self.tokens_dirty = false;
        // The lobby tech level grants techlevel.* tokens up to the chosen level.
        let tech: Vec<u16> = (0..=self.options.tech_level.min(crate::rules::TECH_LEVELS.len() - 1))
            .filter_map(|l| self.rules.token(&format!("techlevel.{}", crate::rules::TECH_LEVELS[l])))
            .collect();
        for p in self.players.iter_mut() {
            p.tokens.iter_mut().for_each(|t| *t = false);
            for &t in &tech {
                p.tokens[t as usize] = true;
            }
            p.storage = 0;
        }
        for a in &self.actors {
            if !a.alive || a.kind != Kind::Building {
                continue;
            }
            let b = self.rules.actors[a.ty as usize].building.as_ref().unwrap();
            let p = &mut self.players[a.owner as usize];
            for &t in &b.provides[p.faction] {
                p.tokens[t as usize] = true;
            }
            p.storage += b.storage;
        }
        for p in self.players.iter_mut() {
            // Ore over capacity is lost, as in OpenRA when silos are destroyed.
            p.resources = p.resources.min(p.storage);
        }
    }

    pub(crate) fn update_power(&mut self) {
        for p in self.players.iter_mut() {
            p.power_gen = 0;
            p.power_use = 0;
        }
        for a in &self.actors {
            if !a.alive || a.kind != Kind::Building {
                continue;
            }
            let info = &self.rules.actors[a.ty as usize];
            let b = info.building.as_ref().unwrap();
            let p = &mut self.players[a.owner as usize];
            if b.power > 0 {
                p.power_gen += if b.power_scales_with_health { b.power * a.hp / info.hp.max(1) } else { b.power };
            } else {
                p.power_use -= b.power;
            }
        }
    }

    pub fn availability(&self, player: u8, ty: u16) -> Availability {
        let p = &self.players[player as usize];
        let info = &self.rules.actors[ty as usize];
        let mut visible = true;
        let mut enabled = true;
        for pr in &info.prerequisites {
            let has = p.tokens[pr.token as usize];
            if has == pr.negate {
                enabled = false;
                if pr.hidden {
                    visible = false;
                }
            }
        }
        Availability { visible, enabled: visible && enabled }
    }

    /// Unmet prerequisites of `ty` for `player`, as labels for the sidebar:
    /// the buildings that would provide each missing token, or the side or
    /// country an item is exclusive to when this faction can never get it.
    pub fn requirements(&self, player: u8, ty: u16) -> Vec<Requirement> {
        let p = &self.players[player as usize];
        let mut out: Vec<Requirement> = Vec::new();
        for pr in &self.rules.actors[ty as usize].prerequisites {
            if p.tokens[pr.token as usize] != pr.negate {
                continue;
            }
            let req = if pr.negate {
                // e.g. the generic spy is replaced by the British spy for England.
                Requirement { label: format!("Not available to {}", title(&self.rules.factions[p.faction])), never: true }
            } else {
                let providers = self.providers(p.faction, pr.token);
                let name = &self.rules.tokens[pr.token as usize];
                if let Some(level) = name.strip_prefix("techlevel.") {
                    Requirement { label: format!("Tech level {}", tech_level_label(level)), never: true }
                } else if providers.is_empty() {
                    Requirement { label: self.exclusive_label(pr.token), never: true }
                } else {
                    Requirement { label: providers.join(" or "), never: false }
                }
            };
            if !out.iter().any(|r| r.label == req.label) {
                out.push(req);
            }
        }
        out
    }

    /// Names of buildings that give `token` to `faction` and that the faction can build.
    fn providers(&self, faction: usize, token: u16) -> Vec<String> {
        let mut names: Vec<String> = Vec::new();
        for a in &self.rules.actors {
            let Some(b) = &a.building else { continue };
            let idx = self.rules.actor_index(&a.id).unwrap();
            if self.rules.obtainable[faction][idx] && b.provides[faction].contains(&token) && !names.contains(&a.name) {
                names.push(a.name.clone());
            }
        }
        names
    }

    /// "Allies only", "Soviet only" or "Russia only" for a token no building of
    /// this faction provides.
    fn exclusive_label(&self, token: u16) -> String {
        let factions: Vec<usize> = (0..self.rules.factions.len()).filter(|&f| !self.providers(f, token).is_empty()).collect();
        if factions.is_empty() {
            return "Not available yet".into();
        }
        let sides: Vec<usize> = factions.iter().map(|&f| self.rules.side_of(f)).collect();
        let all_of_side =
            |side: usize| (0..self.rules.factions.len()).filter(|&f| self.rules.side_of(f) == side).all(|f| factions.contains(&f));
        if sides.iter().all(|&s| s == sides[0]) && all_of_side(sides[0]) {
            return if sides[0] == 0 { "Allies only".into() } else { "Soviet only".into() };
        }
        let names: Vec<String> = factions
            .iter()
            .filter(|&&f| !matches!(self.rules.factions[f].as_str(), "allies" | "soviet"))
            .map(|&f| title(&self.rules.factions[f]))
            .collect();
        format!("{} only", names.join(" or "))
    }

    /// Own buildings that can produce `ty` (OpenRA: Production types vs BuildAtProductionType).
    fn producers_of(&self, player: u8, ty: u16) -> Vec<usize> {
        let info = &self.rules.actors[ty as usize];
        (0..self.actors.len())
            .filter(|&i| {
                let a = &self.actors[i];
                a.alive && a.owner == player && a.kind == Kind::Building && {
                    let b = self.rules.actors[a.ty as usize].building.as_ref().unwrap();
                    b.produces.contains(&info.queue) && b.production_types.contains(&info.build_at)
                }
            })
            .collect()
    }

    pub fn has_producer(&self, player: u8, q: QueueType) -> bool {
        self.actors.iter().any(|a| {
            a.alive
                && a.owner == player
                && a.kind == Kind::Building
                && self.rules.actors[a.ty as usize].building.as_ref().unwrap().produces.contains(&q)
        })
    }

    pub fn start_production(&mut self, player: u8, ty: u16, count: i32) {
        if ty as usize >= self.rules.actors.len() || !self.availability(player, ty).enabled {
            return;
        }
        let q = self.rules.actors[ty as usize].queue;
        let queue = &mut self.players[player as usize].queues[q as usize];
        for _ in 0..count.max(1) {
            // Classic sidebar: only one building at a time.
            if q.is_structure() && !queue.items.is_empty() {
                return;
            }
            if queue.items.len() >= MAX_QUEUED {
                return;
            }
            queue.items.push(QueueItem { ty, total: 0, remaining: 0, paid: 0, slow: 0, done: false });
        }
    }

    /// Remove the last queued item of this type; refund what was paid for it.
    pub fn cancel_production(&mut self, player: u8, ty: u16) {
        if ty as usize >= self.rules.actors.len() {
            return;
        }
        let q = self.rules.actors[ty as usize].queue;
        let queue = &mut self.players[player as usize].queues[q as usize];
        if let Some(pos) = queue.items.iter().rposition(|it| it.ty == ty) {
            let item = queue.items.remove(pos);
            self.refund(player, item.paid);
        }
    }

    pub(crate) fn tick_production(&mut self, player: u8) {
        if self.players[player as usize].defeated {
            return;
        }
        for qi in 0..crate::rules::QUEUE_COUNT {
            let q = QueueType::from_index(qi);
            if self.players[player as usize].queues[qi].items.is_empty() {
                continue;
            }
            let first_ty = self.players[player as usize].queues[qi].items[0].ty;
            let producers =
                if q.is_structure() { usize::from(self.has_producer(player, q)) } else { self.producers_of(player, first_ty).len() };
            // No factory (or it was destroyed): the queue waits.
            if producers == 0 {
                continue;
            }
            // Production pauses while prerequisites are lost (e.g. the repair depot died).
            if !self.availability(player, first_ty).enabled {
                continue;
            }
            let info = &self.rules.actors[first_ty as usize];
            let cost = info.cost;
            let build_ticks = info.build_ticks;
            let reductions = self.rules.player.speed_reduction.clone();
            let low_power_mod = self.rules.player.low_power_modifier;
            let low_power = self.players[player as usize].low_power();
            let item = &mut self.players[player as usize].queues[qi].items[0];
            if item.done {
                if q.is_structure() {
                    continue; // waiting for placement
                }
            } else {
                if item.total == 0 {
                    // More factories of the same kind build faster (BuildTimeSpeedReduction).
                    let red = reductions[(producers - 1).min(reductions.len() - 1)];
                    item.total = (build_ticks * red / 100).max(1);
                    item.remaining = item.total;
                }
                // Low power slows production by LowPowerModifier percent.
                let modifier = if low_power { low_power_mod } else { 100 };
                item.slow += 100;
                if item.slow < modifier {
                    continue;
                }
                item.slow -= modifier;
                let due = (cost as i64 * (item.total - item.remaining + 1) as i64 / item.total as i64) as i32;
                let delta = due - item.paid;
                if !self.spend(player, delta) {
                    // Insufficient funds: production stalls (sound_events.rs throttles the event).
                    let tick = self.tick;
                    self.sound.push_funds(tick, player, first_ty);
                    continue;
                }
                let item = &mut self.players[player as usize].queues[qi].items[0];
                item.paid = due;
                item.remaining -= 1;
                if item.remaining > 0 {
                    continue;
                }
                item.done = true;
                if q.is_structure() {
                    self.sound.push(SoundEventKind::ConstructionReady, first_ty as i32, 0, 0, player, 0);
                    continue;
                }
            }
            // Finished unit: spawn it at a producer.
            if self.spawn_produced(player, first_ty) {
                self.players[player as usize].queues[qi].items.remove(0);
            }
        }
    }

    fn spawn_produced(&mut self, player: u8, ty: u16) -> bool {
        let Some(&b) = self.producers_of(player, ty).first() else { return false };
        let (bcx, bcy, rally) = (self.actors[b].cx, self.actors[b].cy, self.actors[b].rally);
        let binfo = self.rules.actors[self.actors[b].ty as usize].building.as_ref().unwrap();
        let exits = binfo.exits.clone();
        let height = binfo.height;
        let width = binfo.width;
        // Pick the exit with the fewest units on it; among those, the one
        // nearest the rally point (so mirrored bases use mirrored exits).
        let mut best: Option<((usize, i64), (i32, i32))> = None;
        for &(ex, ey) in &exits {
            let (cx, cy) = (bcx + ex, bcy + ey);
            if !self.map.contains(cx, cy) {
                continue;
            }
            let n = self.units_in_cell(self.map.idx(cx, cy)).len();
            let to_rally = rally.map_or(0, |(rx, ry)| crate::math::dist_sq(cell_center(cx), cell_center(cy), rx, ry));
            if best.is_none_or(|(bk, _)| (n, to_rally) < bk) {
                best = Some(((n, to_rally), (cx, cy)));
            }
        }
        let (mut ex, mut ey) = match best {
            Some((_, c)) => c,
            None => (bcx + width / 2, (bcy + height).min(self.map.height - 1)),
        };
        let mut facing = 512;
        // Ships launch onto open water next to the yard (naval.rs); they wait while every exit is blocked.
        if self.is_water_type(ty) {
            let Some((cx, cy, f)) = self.naval_spawn_cell(b) else { return false };
            (ex, ey, facing) = (cx, cy, f);
        }
        let u = self.spawn_unit(ty, player, cell_center(ex), cell_center(ey), facing);
        let (ux, uy) = (self.actors[u].x, self.actors[u].y);
        self.sound.push(SoundEventKind::UnitProduced, ty as i32, ux, uy, player, 0);
        // Helicopters start landed on their helipad (helicopter.rs).
        self.heli_produced(u, b);
        // Planes park on their airfield (plane.rs).
        if self.plane_produced(u, b) {
            return true;
        }
        if self.is_harvester(u) {
            return true;
        }
        let (rx, ry) = rally.unwrap_or((cell_center(ex), cell_center((bcy + height + 1).min(self.map.height - 1))));
        self.order_move(&[u], rx, ry, false);
        true
    }

    // ---- Placement ---------------------------------------------------------

    /// Per footprint cell validity for placing `ty` with its top-left at (cx, cy).
    pub fn placement_cells(&self, player: u8, ty: u16, cx: i32, cy: i32) -> Vec<(i32, i32, bool)> {
        let Some(b) = self.rules.actors.get(ty as usize).and_then(|a| a.building.as_ref()) else {
            return Vec::new();
        };
        let in_area = self.in_build_area(player, ty, cx, cy);
        let mut out = Vec::new();
        for (dx, dy) in b.cells() {
            let (x, y) = (cx + dx, cy + dy);
            let ok = in_area && self.map.contains(x, y) && self.cell_free_for(player, b.on_water, self.map.idx(x, y), None);
            out.push((x, y, ok));
        }
        out
    }

    /// Whether a structure cell may go on map cell `i`: right terrain, no ore,
    /// no building, no units (except `ignore`), explored by the player.
    fn cell_free_for(&self, player: u8, on_water: bool, i: usize, ignore: Option<usize>) -> bool {
        let terrain_ok = if on_water { self.map.terrain[i] == Terrain::Water } else { self.map.terrain[i].buildable() };
        terrain_ok
            && self.map.ore[i] == 0
            && self.building_at[i] == NONE
            && self.units_in_cell(i).iter().all(|&u| !self.actors[u as usize].alive || Some(u as usize) == ignore)
            && self.players[player as usize].explored[i] != 0
            // A mine the player can see (own, allied or detected) blocks the cell;
            // hidden enemy mines must not, or placement would reveal them.
            && self.mine_at(i).is_none_or(|m| self.is_cloaked_from(m, player))
    }

    /// Mines under a new structure's footprint are crushed (hidden enemy mines included).
    fn clear_mines_under(&mut self, b: usize) {
        let a = &self.actors[b];
        let info = self.rules.actors[a.ty as usize].building.as_ref().unwrap();
        let cells: Vec<usize> = info.cells().map(|(dx, dy)| self.map.idx(a.cx + dx, a.cy + dy)).collect();
        for ci in cells {
            if let Some(m) = self.mine_at(ci) {
                self.remove(m);
            }
        }
    }

    /// Whether every footprint cell of `ty` at (cx, cy) is on the map and free
    /// for `player` (placement without the build area rule; see `cell_free_for`).
    fn footprint_free(&self, player: u8, ty: u16, cx: i32, cy: i32) -> bool {
        let Some(b) = self.rules.actors.get(ty as usize).and_then(|a| a.building.as_ref()) else { return false };
        b.cells().all(|(dx, dy)| {
            let (x, y) = (cx + dx, cy + dy);
            self.map.contains(x, y) && self.cell_free_for(player, b.on_water, self.map.idx(x, y), None)
        })
    }

    pub fn can_place(&self, player: u8, ty: u16, cx: i32, cy: i32) -> bool {
        let cells = self.placement_cells(player, ty, cx, cy);
        !cells.is_empty() && cells.iter().all(|c| c.2)
    }

    /// OpenRA rules: within `Adjacent` cells of an existing building that gives
    /// buildable area, and (with the "Build radius" option) within range of a
    /// base provider (construction yard).
    fn in_build_area(&self, player: u8, ty: u16, cx: i32, cy: i32) -> bool {
        let b = self.rules.actors[ty as usize].building.as_ref().unwrap();
        let (x0, y0, x1, y1) = (cx, cy, cx + b.width - 1, cy + b.height - 1);
        let mut adjacent = false;
        let mut provider = !(self.options.build_radius && b.requires_base_provider);
        for a in &self.actors {
            if !a.alive || a.owner != player || a.kind != Kind::Building {
                continue;
            }
            let ob = self.rules.actors[a.ty as usize].building.as_ref().unwrap();
            if ob.base_provider_range > 0 {
                let center = (cx * CELL + b.width * CELL / 2, cy * CELL + b.height * CELL / 2);
                if dist(center.0, center.1, a.x, a.y) <= ob.base_provider_range {
                    provider = true;
                }
            }
            if ob.gives_buildable_area && !adjacent {
                let adj = b.adjacent;
                let (ox0, oy0, ox1, oy1) = (a.cx, a.cy, a.cx + ob.width - 1, a.cy + ob.height - 1);
                // Chebyshev gap between the two rectangles.
                let gx = (ox0 - x1).max(x0 - ox1).max(0);
                let gy = (oy0 - y1).max(y0 - oy1).max(0);
                if gx.max(gy) <= adj {
                    adjacent = true;
                }
            }
        }
        adjacent && provider
    }

    pub fn place_building(&mut self, player: u8, ty: u16, cx: i32, cy: i32) -> bool {
        // Orders come from the network: never trust the type id.
        if ty as usize >= self.rules.actors.len() || player as usize >= self.players.len() {
            return false;
        }
        let qi = self.rules.actors[ty as usize].queue as usize;
        let ready = self.players[player as usize].queues[qi].items.first().is_some_and(|it| it.ty == ty && it.done);
        if !ready || !self.can_place(player, ty, cx, cy) {
            return false;
        }
        let Some(b) = self.spawn_building(ty, player, cx, cy) else { return false };
        self.players[player as usize].queues[qi].items.remove(0);
        let (bx, by) = (self.actors[b].x, self.actors[b].y);
        self.sound.push(SoundEventKind::BuildingPlaced, ty as i32, bx, by, player, 0);
        self.clear_mines_under(b);
        if let Some(lb) = self.rules.actors[ty as usize].abilities.line_build.clone() {
            self.fill_wall_line(player, ty, cx, cy, lb.range);
        }
        // Anyone ordered through the new building re-paths (passability version changed).
        for a in self.actors.iter_mut() {
            if a.alive && a.kind != Kind::Building && a.activity == Activity::Move {
                a.best_dist = i32::MAX;
            }
        }
        self.refresh_tokens();
        self.update_power();
        true
    }

    /// OpenRA LineBuild: a wall piece placed in line with another piece of the
    /// same wall (within range) fills the gap between them.
    fn fill_wall_line(&mut self, player: u8, ty: u16, cx: i32, cy: i32, range: i32) {
        for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
            let mut gap = Vec::new();
            for k in 1..=range {
                let (x, y) = (cx + dx * k, cy + dy * k);
                if !self.map.contains(x, y) {
                    break;
                }
                let i = self.map.idx(x, y);
                let b = self.building_at[i];
                if b != NONE {
                    let o = &self.actors[b as usize];
                    if o.alive && o.owner == player && o.ty == ty && !gap.is_empty() {
                        for &(gx, gy) in &gap {
                            // A piece may cover more than its gap cell (modded walls):
                            // every cell must be free, also of pieces placed just now.
                            if self.footprint_free(player, ty, gx, gy) {
                                // Like a placed piece, a filled one crushes mines under it.
                                if let Some(b) = self.spawn_building(ty, player, gx, gy) {
                                    self.clear_mines_under(b);
                                }
                            }
                        }
                    }
                    break;
                }
                if !self.cell_free_for(player, false, i, None) {
                    break;
                }
                gap.push((x, y));
            }
        }
    }

    // ---- Selling, deploying ------------------------------------------------

    /// Sell a structure: refund RefundPercent of its value, scaled by health (OpenRA Sellable).
    pub fn sell(&mut self, b: usize) -> bool {
        let a = &self.actors[b];
        if !a.alive || a.kind != Kind::Building {
            return false;
        }
        let info = &self.rules.actors[a.ty as usize];
        let percent = info.building.as_ref().unwrap().sell_refund;
        if percent <= 0 {
            return false;
        }
        let refund = (info.cost as i64 * percent as i64 * a.hp as i64 / (100 * info.hp as i64)) as i32;
        let (owner, x, y, ty) = (a.owner, a.x, a.y, a.ty);
        self.refund(owner, refund);
        self.sound.push(SoundEventKind::Sold, ty as i32, x, y, owner, 0);
        self.effects.push(Effect { x, y, tx: x, ty: y, kind: EffectKind::Dust, ttl: 20, max: 20 });
        self.remove(b);
        true
    }

    /// Where actor `i` would deploy to: (target actor type, top-left cell or unit cell).
    pub fn deploy_target(&self, i: usize) -> Option<(u16, i32, i32)> {
        let a = &self.actors[i];
        if !a.alive {
            return None;
        }
        let info = &self.rules.actors[a.ty as usize];
        let tr = info.abilities.transforms.as_ref()?;
        if tr.needs_option && !self.options.redeployable_mcv {
            return None;
        }
        let into = info.transforms_into? as u16;
        let (ox, oy) = (tr.offset[0], tr.offset[1]);
        if a.kind == Kind::Building {
            return Some((into, a.cx + ox, a.cy + oy));
        }
        let (ux, uy) = self.cell_of(a.x, a.y);
        Some((into, ux + ox, uy + oy))
    }

    /// Whether actor `i` can deploy (MCV) or pack up (Construction Yard) right now.
    pub fn can_deploy(&self, i: usize) -> bool {
        let Some((into, cx, cy)) = self.deploy_target(i) else { return false };
        let a = &self.actors[i];
        match &self.rules.actors[into as usize].building {
            // MCV: the yard's footprint must be free (the MCV itself may stand on it).
            Some(b) => b.cells().all(|(dx, dy)| {
                let (x, y) = (cx + dx, cy + dy);
                self.map.contains(x, y) && self.cell_free_for(a.owner, b.on_water, self.map.idx(x, y), Some(i))
            }),
            // Construction Yard: the MCV appears on its pad.
            None => self.map.contains(cx, cy),
        }
    }

    pub fn deploy(&mut self, i: usize) -> bool {
        if !self.can_deploy(i) {
            return false;
        }
        let (into, cx, cy) = self.deploy_target(i).unwrap();
        let owner = self.actors[i].owner;
        let facing = self.rules.actors[self.actors[i].ty as usize].abilities.transforms.as_ref().unwrap().facing;
        let hp_ratio = (self.actors[i].hp as i64, self.rules.actors[self.actors[i].ty as usize].hp as i64);
        let (x, y) = (self.actors[i].x, self.actors[i].y);
        // The new form first: should it not fit after all, the old one stays.
        // (A unit occupies no structure cells, and a structure only turns
        // into a unit, so the old form is never in the way.)
        let j = if self.rules.actors[into as usize].kind == Kind::Building {
            let Some(j) = self.spawn_building(into, owner, cx, cy) else { return false };
            j
        } else {
            self.spawn_unit(into, owner, cell_center(cx), cell_center(cy), facing)
        };
        self.release_dock(i);
        self.remove(i);
        // Free the old form's cells now, in the same tick.
        self.cleanup_dead();
        // Damage carries over between the two forms.
        let max = self.rules.actors[into as usize].hp as i64;
        self.actors[j].hp = ((max * hp_ratio.0 / hp_ratio.1.max(1)) as i32).max(1);
        self.effects.push(Effect { x, y, tx: x, ty: y, kind: EffectKind::Dust, ttl: 16, max: 16 });
        self.refresh_tokens();
        self.update_power();
        true
    }
}

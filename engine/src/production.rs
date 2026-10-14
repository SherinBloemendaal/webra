//! Prerequisites, power, classic per-category production queues and building placement.

use crate::map::Terrain;
use crate::math::{dist, CELL};
use crate::rules::{Kind, QueueType};
use crate::sound_events::{SoundEventKind, SOLD_DONE, SOLD_STARTED};
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
            // The structure's own faction (OpenRA FactionInit): a captured
            // Soviet barracks trains Soviet infantry for its new owner.
            for &t in &b.provides[a.faction as usize] {
                p.tokens[t as usize] = true;
            }
            p.storage += b.storage;
        }
        // Structures beyond a mission map's playable area (mission/mod.rs).
        for s in &self.offmap {
            let b = self.rules.actors[s.ty as usize].building.as_ref().unwrap();
            let p = &mut self.players[s.owner as usize];
            for &t in &b.provides[s.faction as usize] {
                p.tokens[t as usize] = true;
            }
            p.storage += b.storage;
        }
        // Proxies granted by infiltrations (infantry.rs).
        for p in 0..self.players.len() {
            for t in self.proxy_tokens(p) {
                self.players[p].tokens[t as usize] = true;
            }
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
            // Switched off with the power down button: no drain (OpenRA PowerMultiplier@POWERDOWN: 0).
            if !a.alive || a.kind != Kind::Building || a.powered_off {
                continue;
            }
            // A power plant under a spy's power outage makes nothing (infantry.rs).
            if self.outage_disabled_at(a) {
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
        // Structures beyond a mission map's playable area, at full health (mission/mod.rs).
        for s in &self.offmap {
            let b = self.rules.actors[s.ty as usize].building.as_ref().unwrap();
            let p = &mut self.players[s.owner as usize];
            if b.power > 0 {
                p.power_gen += b.power;
            } else {
                p.power_use -= b.power;
            }
        }
    }

    pub fn availability(&self, player: u8, ty: u16) -> Availability {
        let p = &self.players[player as usize];
        let info = &self.rules.actors[ty as usize];
        // Debug menu "all tech" (debug.rs): every prerequisite counts as met,
        // except the marker of actors that are never buildable.
        if p.dev.all_tech {
            let never =
                info.prerequisites.iter().any(|pr| !pr.negate && self.rules.tokens[pr.token as usize] == crate::rules::TOKEN_DISABLED);
            return Availability { visible: !never, enabled: !never };
        }
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
        // Structures also need a building that produces their queue (the Construction Yard).
        let q = self.rules.actors[ty as usize].queue;
        if q.is_structure() && !self.has_producer(player, q) {
            let names = self.queue_producer_names(q);
            if !names.is_empty() {
                out.push(Requirement { label: names.join(" or "), never: false });
            }
        }
        if self.availability(player, ty).enabled {
            return out;
        }
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

    /// Names of the buildings that produce queue `q` (the Construction Yard for
    /// structures; it comes from an MCV, so it is not "obtainable" itself).
    fn queue_producer_names(&self, q: QueueType) -> Vec<String> {
        let mut names: Vec<String> = Vec::new();
        for a in &self.rules.actors {
            if a.building.as_ref().is_some_and(|b| b.produces.contains(&q)) && !names.contains(&a.name) {
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

    /// Ticks to build `ty` with `producers` buildings that make it, before the
    /// low power slowdown: more factories of a kind build faster (OpenRA
    /// ClassicProductionQueue BuildTimeSpeedReduction).
    pub(crate) fn build_time_with(&self, player: u8, ty: u16, producers: usize) -> i32 {
        let reductions = &self.rules.player.speed_reduction;
        let red = reductions[(producers.max(1) - 1).min(reductions.len() - 1)];
        // The owner's handicap slows production (gamerules.rs).
        self.handicap_build_time(player, ty, self.rules.actors[ty as usize].build_ticks * red / 100).max(1)
    }

    /// `player`'s live structures that produce anything.
    pub(crate) fn factories(&self, player: u8) -> Vec<usize> {
        (0..self.actors.len())
            .filter(|&i| {
                let a = &self.actors[i];
                a.alive
                    && a.owner == player
                    && a.kind == Kind::Building
                    && !self.rules.actors[a.ty as usize].building.as_ref().unwrap().produces.is_empty()
            })
            .collect()
    }

    /// How many of `factories` can make `ty` (structures: one at most, the
    /// queue's Construction Yard counts once like in the queue).
    pub(crate) fn producer_count_in(&self, factories: &[usize], ty: u16) -> usize {
        let info = &self.rules.actors[ty as usize];
        let makes = |&&i: &&usize| {
            let b = self.rules.actors[self.actors[i].ty as usize].building.as_ref().unwrap();
            b.produces.contains(&info.queue) && (info.queue.is_structure() || b.production_types.contains(&info.build_at))
        };
        let n = factories.iter().filter(makes).count();
        if info.queue.is_structure() {
            n.min(1)
        } else {
            n
        }
    }

    /// How many buildings `player` has that can make `ty`.
    pub(crate) fn producer_count(&self, player: u8, ty: u16) -> usize {
        self.producer_count_in(&self.factories(player), ty)
    }

    pub fn has_producer(&self, player: u8, q: QueueType) -> bool {
        self.actors.iter().any(|a| {
            a.alive
                && a.owner == player
                && a.kind == Kind::Building
                && self.rules.actors[a.ty as usize].building.as_ref().unwrap().produces.contains(&q)
        })
    }

    /// Whether `player` may produce `ty` right now: every prerequisite is met
    /// and, for structures, a building that produces its queue (the
    /// Construction Yard) stands. OpenRA: the item is in `BuildableItems()`,
    /// which is empty while a classic queue has no producer.
    pub fn can_produce(&self, player: u8, ty: u16) -> bool {
        let q = self.rules.actors[ty as usize].queue;
        self.availability(player, ty).enabled && (!q.is_structure() || self.has_producer(player, q))
    }

    /// Whether `player` can queue one more `ty`: `can_produce` within its
    /// Buildable.BuildLimit (`build_limit_left`). Items already queued are not
    /// cancelled by the limit.
    pub fn can_start(&self, player: u8, ty: u16) -> bool {
        self.can_produce(player, ty) && self.build_limit_left(player, ty) > 0
    }

    /// Queue `count` items of `ty`. Structures queue like units (OpenRA): only
    /// the first item is built, and a finished structure waits for placement
    /// while the items behind it wait too.
    pub fn start_production(&mut self, player: u8, ty: u16, count: i32) {
        if ty as usize >= self.rules.actors.len() || !self.can_start(player, ty) {
            return;
        }
        // OpenRA ProductionQueue StartProduction: Buildable.BuildLimit counts owned and queued ones.
        let count = count.max(1).min(self.build_limit_left(player, ty));
        let q = self.rules.actors[ty as usize].queue;
        let queue = &mut self.players[player as usize].queues[q as usize];
        for _ in 0..count {
            if queue.items.len() >= MAX_QUEUED {
                return;
            }
            queue.items.push(QueueItem { ty, total: 0, remaining: 0, paid: 0, slow: 0, done: false, paused: false });
        }
    }

    /// How many more of `ty` `player` may queue under its Buildable.BuildLimit
    /// (owned plus queued; `i32::MAX` without a limit or with the "all tech" cheat).
    pub fn build_limit_left(&self, player: u8, ty: u16) -> i32 {
        let limit = self.rules.actors[ty as usize].build_limit;
        if limit <= 0 || self.players[player as usize].dev.all_tech {
            return i32::MAX;
        }
        let q = self.rules.actors[ty as usize].queue as usize;
        let queued = self.players[player as usize].queues[q].items.iter().filter(|it| it.ty == ty).count() as i32;
        let owned = self.actors.iter().filter(|a| a.alive && a.owner == player && a.ty == ty).count() as i32;
        (limit - queued - owned).max(0)
    }

    /// Put the first queued `ty` on hold or resume it (OpenRA PauseProduction:
    /// a paused first item holds up its queue). Finished items are not paused.
    pub fn pause_production(&mut self, player: u8, ty: u16, paused: bool) {
        if ty as usize >= self.rules.actors.len() || player as usize >= self.players.len() {
            return;
        }
        let q = self.rules.actors[ty as usize].queue as usize;
        if let Some(it) = self.players[player as usize].queues[q].items.iter_mut().find(|it| it.ty == ty) {
            it.paused = paused && !it.done;
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
            self.note_production_refund(player, item.paid);
            if pos == 0 {
                self.sound.unblock(player, q as usize);
            }
        }
    }

    /// OpenRA `CancelUnbuildableItems`: every queued item that can no longer
    /// be produced is removed and what was paid for it refunded. That covers
    /// items whose prerequisites were destroyed (a half-built tank after its
    /// service depot died) and, for the Building and Defense queues, every item
    /// once the last Construction Yard is gone. Nothing else in the queue is
    /// held up, and the items can be queued again once the prerequisites (or a
    /// new Construction Yard) are back.
    fn cancel_unbuildable(&mut self, player: u8) {
        for qi in 0..crate::rules::QUEUE_COUNT {
            if self.players[player as usize].queues[qi].items.is_empty() {
                continue;
            }
            let q = QueueType::from_index(qi);
            let producer = !q.is_structure() || self.has_producer(player, q);
            // Back to front, so removing an item does not shift the ones still to check.
            let mut cancelled = None;
            for i in (0..self.players[player as usize].queues[qi].items.len()).rev() {
                let ty = self.players[player as usize].queues[qi].items[i].ty;
                if producer && self.availability(player, ty).enabled {
                    continue;
                }
                let item = self.players[player as usize].queues[qi].items.remove(i);
                self.refund(player, item.paid);
                self.note_production_refund(player, item.paid);
                cancelled = Some(ty);
                if i == 0 {
                    self.sound.unblock(player, qi);
                }
            }
            // OpenRA CancelUnbuildableItems: one CancelledAudio for the queue.
            if let Some(ty) = cancelled {
                self.sound.push(SoundEventKind::ProductionCancelled, ty as i32, 0, 0, player, 0);
            }
        }
    }

    pub(crate) fn tick_production(&mut self, player: u8) {
        if self.players[player as usize].defeated {
            return;
        }
        let tick = self.tick;
        self.sound.flush_new_options(player, tick);
        self.cancel_unbuildable(player);
        for qi in 0..crate::rules::QUEUE_COUNT {
            let q = QueueType::from_index(qi);
            if self.players[player as usize].queues[qi].items.is_empty() {
                continue;
            }
            let first_ty = self.players[player as usize].queues[qi].items[0].ty;
            let producers = self.producer_count(player, first_ty);
            // No factory (or it was destroyed): the queue waits. (Structure
            // queues without a Construction Yard were emptied above.)
            if producers == 0 {
                continue;
            }
            let cost = self.rules.actors[first_ty as usize].cost;
            let build_total = self.build_time_with(player, first_ty, producers);
            let low_power_mod = self.rules.player.low_power_modifier;
            let low_power = self.players[player as usize].low_power();
            // Debug menu "instant build" (debug.rs): done on this tick, still paid in full.
            let fast_build = self.players[player as usize].dev.fast_build;
            let item = &mut self.players[player as usize].queues[qi].items[0];
            if item.done {
                if q.is_structure() {
                    continue; // waiting for placement
                }
            } else if item.paused {
                continue; // on hold: the queue waits
            } else {
                if item.total == 0 {
                    // More factories of the same kind build faster (BuildTimeSpeedReduction).
                    item.total = build_total;
                    item.remaining = item.total;
                }
                if fast_build {
                    item.remaining = item.remaining.min(1);
                }
                // Low power slows production by LowPowerModifier percent.
                let modifier = if low_power && !fast_build { low_power_mod } else { 100 };
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
                self.note_production(player, qi, delta);
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
                self.note_built(player, first_ty);
                self.sound.unblock(player, qi);
            } else if !fast_build {
                // OpenRA: BlockedAudio once while the unit cannot leave (not for instant builds).
                self.sound.push_blocked(player, qi, first_ty);
            }
        }
    }

    fn spawn_produced(&mut self, player: u8, ty: u16) -> bool {
        // The primary structure first (primary.rs, OpenRA ClassicProductionQueue);
        // one being captured has its exits shut (Exit RequiresCondition !being-captured, infantry.rs).
        let producers: Vec<usize> = self.producers_of(player, ty).into_iter().filter(|&b| !self.being_captured(b)).collect();
        let Some(&b) = producers.iter().find(|&&b| self.actors[b].primary).or(producers.first()) else { return false };
        self.produce_at(b, player, ty).is_some()
    }

    /// A unit of type `ty` for `player` leaves structure `b` (at its least
    /// crowded exit, toward its rally point). None when it cannot get out
    /// (a ship yard with every exit blocked). Missions use it directly
    /// (OpenRA Production.Produce, `actor.Produce`).
    pub(crate) fn produce_at(&mut self, b: usize, player: u8, ty: u16) -> Option<usize> {
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
            let (cx, cy, f) = self.naval_spawn_cell(b)?;
            (ex, ey, facing) = (cx, cy, f);
        }
        let u = self.spawn_unit(ty, player, cell_center(ex), cell_center(ey), facing);
        let (ux, uy) = (self.actors[u].x, self.actors[u].y);
        // OpenRA INotifyProduction: the factory's door opens for it (doors.rs).
        self.door_unit_produced(b, u);
        self.sound.push(SoundEventKind::UnitProduced, ty as i32, ux, uy, player, 0);
        // Mission triggers (OnProduction).
        let (producer, unit) = (self.make_ref(b), self.make_ref(u));
        self.script_event(crate::mission::ScriptEvent::Produced { producer, unit });
        // Helicopters start landed on their helipad (helicopter.rs).
        self.heli_produced(u, b);
        // Planes park on their airfield (plane.rs).
        if self.plane_produced(u, b) {
            return Some(u);
        }
        if self.is_harvester(u) {
            return Some(u);
        }
        let (rx, ry) = rally.unwrap_or((cell_center(ex), cell_center((bcy + height + 1).min(self.map.height - 1))));
        self.order_move(&[u], rx, ry, false);
        // OpenRA LeaveProductionActivity: MoveTo(rally point, 1) (movement/cellmove.rs).
        self.actors[u].mv.order_near = 1;
        Some(u)
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

    /// Whether a structure cell may go on map cell `i`: right terrain, no ore or gems,
    /// no building, no units (except `ignore`), explored by the player.
    fn cell_free_for(&self, player: u8, on_water: bool, i: usize, ignore: Option<usize>) -> bool {
        let terrain_ok = if on_water { self.map.terrain[i] == Terrain::Water } else { self.map.terrain[i].buildable() };
        terrain_ok
            && !self.map.has_resource(i)
            && self.building_at[i] == NONE
            && self.units_in_cell(i).iter().all(|&u| !self.actors[u as usize].alive || Some(u as usize) == ignore)
            // Husks and crates take the cell too (husks.rs, crates.rs).
            && self.husk_at(i).is_none()
            && self.crate_at(i).is_none()
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
        // Debug menu "build anywhere" (debug.rs): no adjacency or build radius.
        if self.players[player as usize].dev.build_anywhere {
            return true;
        }
        let b = self.rules.actors[ty as usize].building.as_ref().unwrap();
        let (x0, y0, x1, y1) = (cx, cy, cx + b.width - 1, cy + b.height - 1);
        let mut adjacent = false;
        let mut provider = !(self.options.build_radius && b.requires_base_provider);
        for (k, a) in self.actors.iter().enumerate() {
            // The "Ally build radius" option: allied structures count too (OpenRA MapBuildRadius).
            let ally = self.options.ally_build_radius && a.owner != player && self.are_allies(a.owner, player);
            if !a.alive || (a.owner != player && !ally) || a.kind != Kind::Building {
                continue;
            }
            let ob = self.rules.actors[a.ty as usize].building.as_ref().unwrap();
            // BaseProvider PauseOnCondition being-captured (infantry.rs).
            if ob.base_provider_range > 0 && !self.being_captured(k) {
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
        // The Construction Yard or a prerequisite may have died this tick, before
        // production cancels the item: such a structure cannot be placed either.
        if !ready || !self.can_produce(player, ty) || !self.can_place(player, ty, cx, cy) {
            return false;
        }
        // OpenRA PlaceBuilding: NewOptions when the placement adds buildable items (sound only).
        let options_before = self.sound.enabled().then(|| self.buildable_count(player));
        let Some(b) = self.spawn_building(ty, player, cx, cy) else { return false };
        self.begin_make(b);
        self.players[player as usize].queues[qi].items.remove(0);
        self.note_built(player, ty);
        let (bx, by) = (self.actors[b].x, self.actors[b].y);
        self.sound.push(SoundEventKind::BuildingPlaced, ty as i32, bx, by, player, 0);
        let building = self.make_ref(b);
        self.script_event(crate::mission::ScriptEvent::Placed { player, building });
        // The construction yard's placement animation (fx.rs, presentation only).
        self.note_placed(player);
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
        if options_before.is_some_and(|n| self.buildable_count(player) > n) {
            let tick = self.tick;
            self.sound.note_new_options(player, tick);
        }
        true
    }

    /// How many actor types `player` can produce now (OpenRA PlaceBuilding
    /// GetNumBuildables: the BuildableItems of every queue, which are empty
    /// while the queue has no producer). Sound only.
    fn buildable_count(&self, player: u8) -> usize {
        let producers: Vec<bool> = (0..crate::rules::QUEUE_COUNT).map(|q| self.has_producer(player, QueueType::from_index(q))).collect();
        (0..self.rules.actors.len())
            .filter(|&t| {
                let info = &self.rules.actors[t];
                let never = info.prerequisites.iter().any(|pr| self.rules.tokens[pr.token as usize] == crate::rules::TOKEN_DISABLED);
                !never && producers[info.queue as usize] && self.can_produce(player, t as u16)
            })
            .count()
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

    /// Whether structure `b` can be sold now (OpenRA Sellable RequiresCondition
    /// `!build-incomplete && !being-captured && !being-demolished`).
    pub fn can_sell(&self, b: usize) -> bool {
        let a = &self.actors[b];
        a.alive && a.kind == Kind::Building && !self.make_gates(b).sell && !self.being_captured(b) && !self.being_demolished(b)
    }

    /// Sell a structure (OpenRA Sellable.Sell): the sell sound at once, then
    /// the make animation backwards (WithMakeAnimation.Reverse: build-incomplete
    /// again, uninterruptible), and when it ended the Sell activity
    /// (`finish_sale`): RefundPercent of its value scaled by its health then,
    /// the crew, the announcement. A structure without a make animation is
    /// sold at once. Destroyed meanwhile, it brings nothing.
    pub fn sell(&mut self, b: usize) -> bool {
        let a = &self.actors[b];
        if !a.alive || a.kind != Kind::Building || a.unmake_at > 0 {
            return false;
        }
        // Sellable RequiresCondition !build-incomplete && !being-captured && !being-demolished (infantry.rs).
        if !self.can_sell(b) {
            return false;
        }
        let info = &self.rules.actors[a.ty as usize];
        let percent = info.building.as_ref().unwrap().sell_refund;
        if percent <= 0 {
            return false;
        }
        let make = info.building.as_ref().map_or(0, |bi| bi.make_ticks);
        let (owner, x, y, ty) = (a.owner, a.x, a.y, a.ty);
        // Sellable.SellSounds (cashturn), to the owner, at once.
        self.sound.push(SoundEventKind::Sold, ty as i32, x, y, owner, SOLD_STARTED);
        if make > 0 {
            let a = &mut self.actors[b];
            a.unmake_at = self.tick + make;
            a.unmake_sell = true;
            a.make_until = a.unmake_at;
            return true;
        }
        self.finish_sale(b);
        true
    }

    /// The Sell activity (OpenRA Activities/Sell): the refund for the health
    /// the structure has now, INotifySold.Sold (the crew walks out, the
    /// script's Sold event, the statistics) and the Notification
    /// (StructureSold); then it is gone.
    fn finish_sale(&mut self, b: usize) {
        let a = &self.actors[b];
        let info = &self.rules.actors[a.ty as usize];
        let percent = info.building.as_ref().unwrap().sell_refund;
        let refund = (info.cost as i64 * percent as i64 * a.hp as i64 / (100 * info.hp as i64)) as i32;
        let (owner, x, y, ty) = (a.owner, a.x, a.y, a.ty);
        self.refund(owner, refund);
        self.note_sold(owner, refund);
        self.sound.push(SoundEventKind::Sold, ty as i32, x, y, owner, SOLD_DONE);
        self.effects.push(Effect { x, y, tx: x, ty: y, kind: EffectKind::Dust, ttl: 20, max: 20 });
        // The crew walks out (sell.rs, OpenRA SpawnActorsOnSell).
        self.spawn_sell_survivors(b);
        let actor = self.make_ref(b);
        self.script_event(crate::mission::ScriptEvent::Sold { actor });
        self.remove(b);
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
        !self.transforms_paused(i) && self.deploy_spot_free(i)
    }

    /// A Construction Yard that cannot pack up now (OpenRA Transforms
    /// PauseOnCondition `chrono-vortex || being-captured || being-demolished
    /// || build-incomplete`; WebRA has no chrono vortex): its pack-up orders
    /// are ignored without a word (Transforms.ResolveOrder skips a paused
    /// trait). TransformsIntoTransforms only queues a deploy behind a pack-up
    /// that already runs, so nothing waits for the make animation to end.
    fn transforms_paused(&self, i: usize) -> bool {
        self.actors[i].kind == Kind::Building && (self.being_captured(i) || self.being_demolished(i) || self.make_gates(i).transform)
    }

    /// Whether the new form of actor `i` fits where it would appear (OpenRA
    /// Transforms.CanDeploy, also checked when a packing yard's reverse make
    /// animation ends).
    fn deploy_spot_free(&self, i: usize) -> bool {
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

    /// Whether MCV `i` could deploy with the Construction Yard's top-left at
    /// (cx, cy), wherever it stands now (the AI's MCV managers, ai_mcv.rs).
    pub(crate) fn can_deploy_at(&self, i: usize, cx: i32, cy: i32) -> bool {
        let a = &self.actors[i];
        let Some(into) = self.rules.actors[a.ty as usize].transforms_into else { return false };
        let Some(b) = self.rules.actors[into].building.as_ref() else { return false };
        b.cells().all(|(dx, dy)| {
            let (x, y) = (cx + dx, cy + dy);
            self.map.contains(x, y) && self.cell_free_for(a.owner, b.on_water, self.map.idx(x, y), Some(i))
        })
    }

    /// Deploy an MCV, or start packing up a Construction Yard: OpenRA's
    /// Transform plays the yard's make animation backwards first (granting
    /// build-incomplete again; the activity cannot be interrupted any more),
    /// and only when it ended does the MCV appear (`tick_pack_up`).
    pub fn deploy(&mut self, i: usize) -> bool {
        let (from, owner, x, y) = (self.actors[i].ty, self.actors[i].owner, self.actors[i].x, self.actors[i].y);
        if self.actors[i].unmake_at > 0 {
            return false; // already packing up: uninterruptible
        }
        // Nothing to turn into, or a paused yard: nothing to report.
        if self.deploy_target(i).is_none() || self.transforms_paused(i) {
            return false;
        }
        if !self.can_deploy(i) {
            self.sound.push(SoundEventKind::DeployBlocked, from as i32, x, y, owner, 0);
            return false;
        }
        let make = self.rules.actors[from as usize].building.as_ref().map_or(0, |b| b.make_ticks);
        if self.actors[i].kind == Kind::Building && make > 0 {
            let a = &mut self.actors[i];
            a.unmake_at = self.tick + make;
            a.make_until = a.unmake_at;
            return true;
        }
        self.transform_now(i)
    }

    /// Structures whose reverse make animation ended: a sold one is sold
    /// (`finish_sale`); a packing Construction Yard turns into the MCV or,
    /// when it no longer fits, plays the make animation forwards again and
    /// stays (OpenRA Transform.DoTransform).
    pub(crate) fn tick_unmake(&mut self) {
        for i in 0..self.actors.len() {
            let a = &self.actors[i];
            if !a.alive || a.unmake_at == 0 || self.tick < a.unmake_at {
                continue;
            }
            self.actors[i].unmake_at = 0;
            if std::mem::take(&mut self.actors[i].unmake_sell) {
                self.finish_sale(i);
                continue;
            }
            // Transforms.CanDeploy once build-incomplete is revoked: the MCV
            // fits and no C4 ticks on the yard (it cannot be captured while
            // packing up). Otherwise it unfolds again, silently.
            if self.deploy_spot_free(i) && !self.being_captured(i) && !self.being_demolished(i) {
                self.transform_now(i);
            } else {
                self.begin_make(i);
            }
        }
    }

    /// Turn actor `i` into its other form at once.
    fn transform_now(&mut self, i: usize) -> bool {
        let Some((into, cx, cy)) = self.deploy_target(i) else { return false };
        let (from, owner, x, y) = (self.actors[i].ty, self.actors[i].owner, self.actors[i].x, self.actors[i].y);
        let facing = self.rules.actors[from as usize].abilities.transforms.as_ref().unwrap().facing;
        let hp_ratio = (self.actors[i].hp as i64, self.rules.actors[from as usize].hp as i64);
        // The new form first: should it not fit after all, the old one stays.
        // (A unit occupies no structure cells, and a structure only turns
        // into a unit, so the old form is never in the way.)
        let j = if self.rules.actors[into as usize].kind == Kind::Building {
            let Some(j) = self.spawn_building(into, owner, cx, cy) else {
                self.sound.push(SoundEventKind::DeployBlocked, from as i32, x, y, owner, 0);
                return false;
            };
            // OpenRA Transform without SkipMakeAnims: the yard unfolds.
            self.begin_make(j);
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
        // OpenRA plays the old form's TransformSounds (and a structure's
        // UndeploySounds) at its position as it turns into the new one.
        self.sound.push(SoundEventKind::Transformed, from as i32, x, y, owner, into as i32);
        self.refresh_tokens();
        self.update_power();
        true
    }
}

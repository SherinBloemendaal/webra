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
        // Structures also need a building that produces their queue (the
        // Construction Yard); under OpenRA's factory loss rule so do units
        // (shown once their prerequisites are met: those name the factory).
        let q = self.rules.actors[ty as usize].queue;
        let shown = q.is_structure() || self.availability(player, ty).enabled;
        if shown && self.queue_needs_producer(q) && !self.has_producer(player, q) {
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

    /// The production type `player` builds a `ty` as (OpenRA
    /// ClassicProductionQueue.BuildUnit): its Buildable.BuildAtProductionType
    /// (the queue's type when it has none), but the queue's type under the
    /// "all tech" cheat, so a submarine comes out of a naval yard and a dog
    /// out of barracks then.
    pub(crate) fn built_as(&self, player: u8, ty: u16) -> &str {
        let info = &self.rules.actors[ty as usize];
        if self.players.get(player as usize).is_some_and(|p| p.dev.all_tech) {
            info.queue.name()
        } else {
            info.build_at.as_str()
        }
    }

    /// Own buildings that can produce `ty`: their Production types hold the
    /// type it is built as (OpenRA ClassicProductionQueue.BuildUnit, `built_as`).
    pub(crate) fn producers_of(&self, player: u8, ty: u16) -> Vec<usize> {
        let queue = self.rules.actors[ty as usize].queue;
        let built_as = self.built_as(player, ty);
        (0..self.actors.len())
            .filter(|&i| {
                let a = &self.actors[i];
                a.alive && a.owner == player && a.kind == Kind::Building && {
                    let b = self.rules.actors[a.ty as usize].building.as_ref().unwrap();
                    b.produces.contains(&queue) && b.production_types.iter().any(|t| t == built_as)
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
    /// queue's Construction Yard counts once like in the queue). This counts
    /// for the build time, by Buildable.BuildAtProductionType also under the
    /// "all tech" cheat (OpenRA ClassicProductionQueue.GetBuildTime); which
    /// structures may make it is `producers_of`.
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

    pub fn has_producer(&self, player: u8, q: QueueType) -> bool {
        self.actors.iter().any(|a| {
            a.alive
                && a.owner == player
                && a.kind == Kind::Building
                && self.rules.actors[a.ty as usize].building.as_ref().unwrap().produces.contains(&q)
        })
    }

    /// Whether queue `q` takes items only while a structure of its type
    /// stands: structure queues always, unit queues under OpenRA's factory
    /// loss rule (OpenRA ClassicProductionQueue: BuildableItems is empty
    /// while the queue is not Enabled). Under WebRA's a unit queue waits.
    fn queue_needs_producer(&self, q: QueueType) -> bool {
        q.is_structure() || self.options.factory_loss == crate::world::FactoryLoss::OpenRA
    }

    /// Whether `player` may produce `ty` right now: every prerequisite is met
    /// and, where the queue needs one (`queue_needs_producer`), a building
    /// that produces its queue (for structures the Construction Yard)
    /// stands. OpenRA: the item is in `BuildableItems()`, which is empty
    /// while a classic queue has no producer.
    pub fn can_produce(&self, player: u8, ty: u16) -> bool {
        let q = self.rules.actors[ty as usize].queue;
        self.availability(player, ty).enabled && (!self.queue_needs_producer(q) || self.has_producer(player, q))
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

    /// OpenRA ClassicProductionQueue.Tick under OpenRA's factory loss rule: a
    /// queue whose player has no structure of its type left is not Enabled
    /// and ClearQueue empties it, refunding everything paid for every item
    /// (a finished one in full), without a notification.
    fn clear_disabled_queues(&mut self, player: u8) {
        if self.options.factory_loss != crate::world::FactoryLoss::OpenRA {
            return;
        }
        for qi in 0..crate::rules::QUEUE_COUNT {
            let q = QueueType::from_index(qi);
            if self.players[player as usize].queues[qi].items.is_empty() || self.has_producer(player, q) {
                continue;
            }
            let items = std::mem::take(&mut self.players[player as usize].queues[qi].items);
            for item in items {
                self.refund(player, item.paid);
                self.note_production_refund(player, item.paid);
            }
            self.sound.unblock(player, qi);
        }
    }

    /// OpenRA `CancelUnbuildableItems`: every queued item that can no longer
    /// be produced is removed and what was paid for it refunded. That covers
    /// items whose prerequisites were destroyed (a half-built tank after its
    /// service depot died) and, for the Building and Defense queues, every item
    /// once the last Construction Yard is gone (under WebRA's factory loss
    /// rule; OpenRA's has already cleared those queues silently,
    /// `clear_disabled_queues`). Nothing else in the queue is
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
        self.clear_disabled_queues(player);
        self.cancel_unbuildable(player);
        for qi in 0..crate::rules::QUEUE_COUNT {
            let q = QueueType::from_index(qi);
            if self.players[player as usize].queues[qi].items.is_empty() {
                continue;
            }
            let first_ty = self.players[player as usize].queues[qi].items[0].ty;
            // Queues without a structure of their type were emptied above
            // (structure queues always, unit queues under OpenRA's factory
            // loss rule). A unit queue builds while a structure of its type
            // stands (OpenRA ClassicProductionQueue.Enabled); without one,
            // under WebRA's rule, it waits. The
            // build time counts the structures of the item's build_at type
            // (`producer_count_in`, one at most for structures).
            let (has_factory, producers) = if q.is_structure() {
                let has = self.has_producer(player, q);
                (has, usize::from(has))
            } else {
                self.unit_factories(player, first_ty)
            };
            if !has_factory {
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
            match self.spawn_produced(player, first_ty) {
                Some(true) => {
                    self.players[player as usize].queues[qi].items.remove(0);
                    self.note_built(player, first_ty);
                    self.sound.unblock(player, qi);
                }
                produced => {
                    // OpenRA BuildUnit without any structure that makes the
                    // unit: CancelProduction(unit, 1) cancels the last item of
                    // that type in the queue and refunds what was paid for it
                    // (the finished one itself once it is the last).
                    let cancelled_first = produced.is_none() && self.cancel_last_of(player, qi, first_ty);
                    if !fast_build {
                        // OpenRA: BlockedAudio once while the unit cannot leave
                        // or was not made (not for instant builds).
                        self.sound.push_blocked(player, qi, first_ty);
                    }
                    if cancelled_first {
                        self.sound.unblock(player, qi);
                    }
                }
            }
        }
    }

    /// OpenRA ClassicProductionQueue.BuildUnit: the finished unit leaves the
    /// primary structure, else the first other one whose exit it can use
    /// (OpenRA: the newest first). One being captured has its exits shut
    /// (Exit RequiresCondition !being-captured, infantry.rs). Some(false)
    /// while every producer's exits are blocked: the item stays done and
    /// tries again next tick. None when no structure makes it at all.
    fn spawn_produced(&mut self, player: u8, ty: u16) -> Option<bool> {
        let producers = self.producers_of(player, ty);
        if producers.is_empty() {
            return None;
        }
        let mut producers: Vec<usize> = producers.into_iter().filter(|&b| !self.being_captured(b)).collect();
        // Stable: the primary one first, the others in actor order.
        producers.sort_by_key(|&b| !self.actors[b].primary);
        Some(producers.into_iter().any(|b| self.produce_at(b, player, ty).is_some()))
    }

    /// OpenRA ProductionQueue.CancelProductionInner: the last item of type
    /// `ty` in queue `qi` is removed and what was paid for it refunded.
    /// Whether that was the queue's first item.
    fn cancel_last_of(&mut self, player: u8, qi: usize, ty: u16) -> bool {
        let Some(i) = self.players[player as usize].queues[qi].items.iter().rposition(|it| it.ty == ty) else { return false };
        let item = self.players[player as usize].queues[qi].items.remove(i);
        self.refund(player, item.paid);
        self.note_production_refund(player, item.paid);
        i == 0
    }

    /// One scan of `player`'s structures for a unit of type `ty`: whether any
    /// makes its queue (OpenRA ClassicProductionQueue.Enabled) and how many
    /// make its build_at type (`producer_count_in`, for the build time).
    fn unit_factories(&self, player: u8, ty: u16) -> (bool, usize) {
        let info = &self.rules.actors[ty as usize];
        let mut any = false;
        let mut count = 0;
        for a in self.actors.iter().filter(|a| a.alive && a.owner == player && a.kind == Kind::Building) {
            let b = self.rules.actors[a.ty as usize].building.as_ref().unwrap();
            if b.produces.contains(&info.queue) {
                any = true;
                count += usize::from(b.production_types.contains(&info.build_at));
            }
        }
        (any, count)
    }

    /// A unit of type `ty` for `player` leaves structure `b` (OpenRA
    /// Production.Produce, `actor.Produce` of missions): by the exit
    /// `select_exit` picks, toward the rally point. None when it cannot get
    /// out (every exit blocked, a ship yard without open water next to it).
    pub(crate) fn produce_at(&mut self, b: usize, player: u8, ty: u16) -> Option<usize> {
        let (bcy, rally) = (self.actors[b].cy, self.actors[b].rally);
        let height = self.rules.actors[self.actors[b].ty as usize].building.as_ref().unwrap().height;
        let (ex, ey, facing) = self.select_exit(b, player, ty)?;
        let u = self.spawn_unit(ty, player, cell_center(ex), cell_center(ey), facing);
        // OpenRA LocationInit(exit): the unit holds its exit cell from the
        // tick it is made, so the next one waits until it has driven off.
        if self.cell_moves() && self.occupies_cells(u) {
            self.place_on_cell(u);
        }
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
        let (rx, ry) = match rally {
            Some(r) => r,
            // OpenRA (at the pinned b6fc03f): RallyPointInfo.Path defaults to
            // empty and Red Alert's rules set none, so a new structure has no
            // rally point and Production.DoProduction gives the unit its exit
            // cell as the rally point (`rp.Path.Count > 0 ? rp.Path : [exit]`):
            // it stays there, and the next one to come out asks it to make
            // way; helicopters stay on their pad. In the WebRA movement model
            // (whose crowd would jam the door, see `exit_free_for`) ground
            // units and ships drive on to a cell below the structure.
            None if self.rules.actors[ty as usize].kind == Kind::Aircraft || self.cell_moves() => return Some(u),
            None => (cell_center(ex), cell_center((bcy + height + 1).min(self.map.height - 1))),
        };
        self.order_move(&[u], rx, ry, false);
        // OpenRA LeaveProductionActivity: MoveTo(rally point, 1) (movement/cellmove.rs).
        self.actors[u].mv.order_near = 1;
        Some(u)
    }

    /// OpenRA Production.SelectExit with CanUseExit: the exits by priority
    /// (ExitInfo.Priority, highest first), then nearest the rally point (the
    /// default one below the structure when none is set; OpenRA shuffles
    /// those), and the first a unit of `ty` can enter. Each exit looked at
    /// first tells the friendly units on it that they are in the way (idle
    /// ones step aside, movement/cellmove.rs). Aircraft (helipads,
    /// airfields) are not held up by units. Ships take the same rule on the
    /// open water just outside the yard's exits (naval.rs
    /// `naval_launch_cells`). The cell and facing, None while every exit is
    /// blocked.
    fn select_exit(&mut self, b: usize, player: u8, ty: u16) -> Option<(i32, i32, i32)> {
        let (bcx, bcy) = (self.actors[b].cx, self.actors[b].cy);
        let nudger = self.map.idx(bcx.clamp(0, self.map.width - 1), bcy.clamp(0, self.map.height - 1)) as u32;
        if self.is_water_type(ty) {
            for (cx, cy, facing) in self.naval_launch_cells(b, ty) {
                let cell = self.map.idx(cx, cy) as u32;
                self.notify_blockers_at(cell, player, nudger);
                if self.exit_free_for(player, ty, cell) {
                    return Some((cx, cy, facing));
                }
            }
            return None;
        }
        let binfo = self.rules.actors[self.actors[b].ty as usize].building.as_ref().unwrap();
        let (width, height) = (binfo.width, binfo.height);
        let (rx, ry) =
            self.actors[b].rally.unwrap_or((bcx * CELL + width * CELL / 2, cell_center((bcy + height + 1).min(self.map.height - 1))));
        let mut exits: Vec<(i32, i64, i32, i32)> = binfo
            .exits
            .iter()
            .enumerate()
            .filter(|&(k, _)| self.exit_lets_out(b, k, ty))
            .map(|(k, &(ex, ey))| (binfo.exit_priority.get(k).copied().unwrap_or(1), 0, bcx + ex, bcy + ey))
            .filter(|&(_, _, cx, cy)| self.map.contains(cx, cy))
            .map(|(p, _, cx, cy)| (p, crate::math::dist_sq(cell_center(cx), cell_center(cy), rx, ry), cx, cy))
            .collect();
        if binfo.exits.is_empty() {
            // A structure without exits: below its middle.
            return Some((bcx + width / 2, (bcy + height).min(self.map.height - 1), 512));
        }
        if exits.is_empty() {
            // No exit for this kind of unit (OpenRA: no Exit, Produce fails).
            return None;
        }
        // Stable: equal exits keep their order.
        exits.sort_by_key(|&(p, d, _, _)| (std::cmp::Reverse(p), d));
        let ground = self.rules.actors[ty as usize].kind != Kind::Aircraft;
        if !ground {
            return exits.first().map(|&(_, _, cx, cy)| (cx, cy, 512));
        }
        for (_, _, cx, cy) in exits {
            let cell = self.map.idx(cx, cy) as u32;
            self.notify_blockers_at(cell, player, nudger);
            if self.exit_free_for(player, ty, cell) {
                return Some((cx, cy, 512));
            }
        }
        None
    }

    /// OpenRA ExitExts.Exits: whether exit `k` of structure `b` lets out a
    /// unit of type `ty`, by its ExitInfo.ProductionTypes and the production
    /// type the unit is built as (Buildable.BuildAtProductionType, else the
    /// queue's; with the "all tech" cheat the queue's, as in
    /// ClassicProductionQueue.BuildUnit). The sub pen's Submarine exits are
    /// (-1, 2), (3, 2) and its top corners; its Ship exits, on all four
    /// corners, let out only units built as Ship (the transport, or any
    /// ship under all tech).
    pub(crate) fn exit_lets_out(&self, b: usize, k: usize, ty: u16) -> bool {
        let Some(binfo) = self.rules.actors[self.actors[b].ty as usize].building.as_ref() else { return true };
        let Some(types) = binfo.exit_types.get(k).filter(|t| !t.is_empty()) else { return true };
        let built_as = self.built_as(self.actors[b].owner, ty);
        types.iter().any(|t| t == built_as)
    }

    /// OpenRA MobileInfo.CanEnterCell for a unit of type `ty` of `player`
    /// that is not made yet, under BlockedByActor.All: the terrain lets it
    /// in, and nobody holds the cell that it could not run over (infantry:
    /// a sub-cell is free). In the WebRA movement model units hold no cells:
    /// there only units standing idle in the cell (when the tick began)
    /// keep it, as crowd separation pushes the ones on the move apart (a
    /// door that waited for those would jam behind the crowd that the
    /// model's arrival rule gathers in front of it).
    fn exit_free_for(&self, player: u8, ty: u16, cell: u32) -> bool {
        let ci = cell as usize;
        if self.pass_of_type(ty as usize).blocked[ci] {
            return false;
        }
        let shares = self.rules.actors[ty as usize].unit.as_ref().is_some_and(|u| self.rules.locomotors[u.locomotor].shares_cell);
        if self.cell_moves() {
            let held: Vec<crate::movement::occupancy::Occupant> =
                self.occupancy.at(cell).iter().copied().filter(|o| self.occupies_cells(o.actor as usize)).collect();
            if shares {
                return held.iter().all(|o| o.sub != crate::movement::occupancy::FULL_CELL)
                    && (1..crate::movement::occupancy::SUB_CELL_OFFSETS.len() as u8).any(|s| held.iter().all(|o| o.sub != s));
            }
            return held.iter().all(|o| self.crushable_by_type(o.actor as usize, ty, player));
        }
        // WebRA model: only units standing idle in the cell keep it; ones on
        // the move are pushed apart by the crowd separation (soft.rs).
        let standing: Vec<usize> = self
            .units_in_cell(ci)
            .iter()
            .map(|&u| u as usize)
            .filter(|&u| {
                let a = &self.actors[u];
                a.alive && a.kind != Kind::Aircraft && !a.air.parachute && a.activity == Activity::Idle
            })
            .collect();
        if shares {
            return standing.len() < crate::movement::occupancy::SUB_CELL_OFFSETS.len() - 1
                && standing.iter().all(|&u| self.shares_cell(u));
        }
        standing.iter().all(|&u| self.crushable_by_type(u, ty, player))
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

    /// Sell a structure: refund RefundPercent of its value, scaled by health (OpenRA Sellable).
    pub fn sell(&mut self, b: usize) -> bool {
        let a = &self.actors[b];
        if !a.alive || a.kind != Kind::Building {
            return false;
        }
        // Sellable RequiresCondition !being-captured && !being-demolished (infantry.rs).
        if self.being_captured(b) || self.being_demolished(b) {
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
        self.note_sold(owner, refund);
        self.sound.push(SoundEventKind::Sold, ty as i32, x, y, owner, 0);
        self.effects.push(Effect { x, y, tx: x, ty: y, kind: EffectKind::Dust, ttl: 20, max: 20 });
        // The crew walks out (sell.rs, OpenRA SpawnActorsOnSell).
        self.spawn_sell_survivors(b);
        let actor = self.make_ref(b);
        self.script_event(crate::mission::ScriptEvent::Sold { actor });
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
        // A Construction Yard being captured cannot pack up (Transforms PauseOnCondition being-captured).
        if self.actors[i].kind == Kind::Building && self.being_captured(i) {
            return false;
        }
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

    pub fn deploy(&mut self, i: usize) -> bool {
        let Some((into, cx, cy)) = self.deploy_target(i) else { return false };
        let (from, owner, x, y) = (self.actors[i].ty, self.actors[i].owner, self.actors[i].x, self.actors[i].y);
        if !self.can_deploy(i) {
            self.sound.push(SoundEventKind::DeployBlocked, from as i32, x, y, owner, 0);
            return false;
        }
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

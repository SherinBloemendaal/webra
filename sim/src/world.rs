//! World state, actor storage, orders and the fixed-step tick loop.

use crate::flowfield::{nearest_in_component, FlowCache, Passability};
use crate::map::Map;
use crate::math::{dist, CELL, HALF_CELL};
use crate::rng::Rng;
use crate::rules::{FootCell, Kind, QueueType, Rules, QUEUE_COUNT};
use std::collections::BTreeMap;

/// Simulation ticks per second at normal speed (OpenRA: 40 ms per tick).
pub const TICKS_PER_SECOND: u32 = 25;
pub const NONE: u32 = u32::MAX;
const IDX_BITS: u32 = 22;
const IDX_MASK: u32 = (1 << IDX_BITS) - 1;
const GEN_MASK: u32 = (1 << (32 - IDX_BITS)) - 1;
pub const MAX_WEAPONS: usize = 2;
const ORE_GROWTH_INTERVAL: u32 = 375;
const VISION_INTERVAL: u32 = 2;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Activity {
    Idle,
    Move,
    Attack,
    Harvest,
    Repair,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum HarvState {
    Search,
    ToOre,
    Harvesting,
    ToDock,
    Unloading,
    Wait,
}

#[derive(Clone)]
pub struct Actor {
    pub alive: bool,
    pub gen: u32,
    pub kind: Kind,
    pub ty: u16,
    pub owner: u8,
    pub x: i32,
    pub y: i32,
    pub px: i32,
    pub py: i32,
    pub facing: i32,
    pub turret: i32,
    pub pfacing: i32,
    pub pturret: i32,
    pub hp: i32,

    // Units
    pub activity: Activity,
    pub goal: u32,
    pub group: u32,
    pub group_size: i32,
    pub attack_move: bool,
    /// Original attack-move destination, resumed after a fight.
    pub dest: (i32, i32),
    pub target: u32,
    pub forced: bool,
    pub chase_cell: u32,
    pub reload: [i32; MAX_WEAPONS],
    pub burst_shot: [i32; MAX_WEAPONS],
    pub scan_cooldown: i32,
    pub best_dist: i32,
    pub stuck_ticks: i32,
    pub moved: bool,

    // Harvesters
    pub harv: HarvState,
    pub bales: i32,
    pub harv_timer: i32,
    pub harv_cell: u32,
    pub refinery: u32,

    // Repair
    pub depot: u32,
    pub repair_timer: i32,

    // Buildings
    pub cx: i32,
    pub cy: i32,
    pub rally: Option<(i32, i32)>,
    pub dock_user: u32,

    /// Ticks of white hit-flash left (render only).
    pub flash: i32,
}

impl Actor {
    fn blank() -> Actor {
        Actor {
            alive: false,
            gen: 0,
            kind: Kind::Vehicle,
            ty: 0,
            owner: 0,
            x: 0,
            y: 0,
            px: 0,
            py: 0,
            facing: 512,
            turret: 512,
            pfacing: 512,
            pturret: 512,
            hp: 0,
            activity: Activity::Idle,
            goal: NONE,
            group: 0,
            group_size: 1,
            attack_move: false,
            dest: (0, 0),
            target: NONE,
            forced: false,
            chase_cell: NONE,
            reload: [0; MAX_WEAPONS],
            burst_shot: [0; MAX_WEAPONS],
            scan_cooldown: 0,
            best_dist: i32::MAX,
            stuck_ticks: 0,
            moved: false,
            harv: HarvState::Search,
            bales: 0,
            harv_timer: 0,
            harv_cell: NONE,
            refinery: NONE,
            depot: NONE,
            repair_timer: 0,
            cx: 0,
            cy: 0,
            rally: None,
            dock_user: NONE,
            flash: 0,
        }
    }

    pub fn is_unit(&self) -> bool {
        self.kind != Kind::Building
    }
}

#[derive(Clone)]
pub struct QueueItem {
    pub ty: u16,
    pub total: i32,
    pub remaining: i32,
    pub paid: i32,
    pub slow: i32,
    pub done: bool,
}

#[derive(Clone, Default)]
pub struct Queue {
    pub items: Vec<QueueItem>,
}

#[derive(Clone)]
pub struct Ghost {
    pub actor: u32,
    pub ty: u16,
    pub owner: u8,
    pub cx: i32,
    pub cy: i32,
}

pub struct Player {
    pub faction: usize,
    pub side: usize,
    pub cash: i32,
    pub resources: i32,
    pub storage: i32,
    pub power_gen: i32,
    pub power_use: i32,
    pub tokens: Vec<bool>,
    pub queues: [Queue; QUEUE_COUNT],
    pub visible: Vec<u8>,
    pub explored: Vec<u8>,
    pub ghosts: BTreeMap<u32, Ghost>,
    pub is_ai: bool,
    pub defeated: bool,
    pub start: (i32, i32),
}

impl Player {
    pub fn funds(&self) -> i32 {
        self.cash + self.resources
    }
    pub fn low_power(&self) -> bool {
        self.power_use > self.power_gen
    }
}

pub struct Projectile {
    pub x: i32,
    pub y: i32,
    pub tx: i32,
    pub ty: i32,
    pub weapon: u16,
    pub owner: u8,
    pub target: u32,
    pub facing: i32,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum EffectKind {
    SmallExplosion,
    LargeExplosion,
    Piff,
}

pub struct Effect {
    pub x: i32,
    pub y: i32,
    pub kind: EffectKind,
    pub ttl: i32,
    pub max: i32,
}

#[derive(Clone, Debug)]
pub enum Order {
    Move { player: u8, ids: Vec<u32>, x: i32, y: i32, attack_move: bool },
    Smart { player: u8, ids: Vec<u32>, x: i32, y: i32 },
    Attack { player: u8, ids: Vec<u32>, target: u32 },
    Stop { player: u8, ids: Vec<u32> },
    StartProduction { player: u8, ty: u16, count: i32 },
    CancelProduction { player: u8, ty: u16 },
    Place { player: u8, ty: u16, cx: i32, cy: i32 },
    Rally { player: u8, building: u32, x: i32, y: i32 },
}

/// What a smart (right-click) order would do at a position.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SmartAction {
    None = 0,
    Move = 1,
    Attack = 2,
    Harvest = 3,
    Dock = 4,
    Repair = 5,
}

pub struct World {
    pub rules: Rules,
    pub map: Map,
    pub pass: Passability,
    pub flow: FlowCache,
    pub actors: Vec<Actor>,
    free: Vec<u32>,
    /// Actor index occupying each cell's footprint (buildings only), or NONE.
    pub building_at: Vec<u32>,
    pub players: Vec<Player>,
    pub projectiles: Vec<Projectile>,
    pub effects: Vec<Effect>,
    pub tick: u32,
    pub rng: Rng,
    orders: Vec<Order>,
    pub(crate) dying: Vec<u32>,
    // Spatial hash of units by cell, rebuilt every tick (counting sort).
    pub(crate) hash_start: Vec<u32>,
    pub(crate) hash_items: Vec<u32>,
    pub terrain_dirty: bool,
    pub tokens_dirty: bool,
    next_group: u32,
    pub ai: Vec<crate::ai::AiState>,
    pub winner: Option<u8>,
    pub circle_cache: Vec<Vec<(i32, i32)>>,
    pub stress: bool,
    /// Actors destroyed so far, per owner.
    pub losses: Vec<u32>,
}

impl World {
    pub fn new(seed: u64, map_size: i32, factions: &[(&str, bool)]) -> World {
        let rules = Rules::load();
        let map = Map::generate(map_size, map_size, seed, rules.player.ore_max_density);
        let mut w = World::empty(rules, map, seed);
        let spawns = w.map.spawns.clone();
        for (slot, &(faction, is_ai)) in factions.iter().enumerate() {
            let fi = w.rules.faction_index(faction).unwrap_or_else(|| panic!("unknown faction {faction}"));
            w.add_player(fi, is_ai, spawns[slot]);
        }
        let fact = w.rules.actor_index("FACT").unwrap() as u16;
        for p in 0..w.players.len() {
            let (sx, sy) = spawns[p];
            w.spawn_building(fact, p as u8, sx, sy);
        }
        w.ai = (0..w.players.len()).map(|p| crate::ai::AiState::new(p as u32)).collect();
        w.refresh_tokens();
        w.update_power();
        w.update_vision();
        w
    }

    pub(crate) fn empty(rules: Rules, map: Map, seed: u64) -> World {
        let pass = Passability::new(&map);
        let cells = map.cells();
        World {
            rules,
            pass,
            flow: FlowCache::new(),
            actors: Vec::new(),
            free: Vec::new(),
            building_at: vec![NONE; cells],
            players: Vec::new(),
            projectiles: Vec::new(),
            effects: Vec::new(),
            tick: 0,
            rng: Rng::new(seed.wrapping_mul(31).wrapping_add(7)),
            orders: Vec::new(),
            dying: Vec::new(),
            hash_start: vec![0; cells + 1],
            hash_items: Vec::new(),
            terrain_dirty: true,
            tokens_dirty: true,
            next_group: 1,
            ai: Vec::new(),
            winner: None,
            circle_cache: Vec::new(),
            stress: false,
            losses: Vec::new(),
            map,
        }
    }

    pub(crate) fn add_player(&mut self, faction: usize, is_ai: bool, start: (i32, i32)) {
        let cells = self.map.cells();
        let side = self.rules.side_of(faction);
        self.losses.push(0);
        self.players.push(Player {
            faction,
            side,
            cash: self.rules.player.starting_cash,
            resources: 0,
            storage: 0,
            power_gen: 0,
            power_use: 0,
            tokens: vec![false; self.rules.tokens.len()],
            queues: Default::default(),
            visible: vec![0; cells],
            explored: vec![0; cells],
            ghosts: BTreeMap::new(),
            is_ai,
            defeated: false,
            start,
        });
    }

    // ---- Actor references -------------------------------------------------

    #[inline]
    pub fn make_ref(&self, idx: usize) -> u32 {
        idx as u32 | ((self.actors[idx].gen & GEN_MASK) << IDX_BITS)
    }

    #[inline]
    pub fn resolve(&self, r: u32) -> Option<usize> {
        if r == NONE {
            return None;
        }
        let idx = (r & IDX_MASK) as usize;
        let a = self.actors.get(idx)?;
        if a.alive && (a.gen & GEN_MASK) == r >> IDX_BITS {
            Some(idx)
        } else {
            None
        }
    }

    fn alloc(&mut self) -> usize {
        if let Some(i) = self.free.pop() {
            i as usize
        } else {
            self.actors.push(Actor::blank());
            self.actors.len() - 1
        }
    }

    // ---- Spawning ----------------------------------------------------------

    pub fn spawn_unit(&mut self, ty: u16, owner: u8, x: i32, y: i32, facing: i32) -> usize {
        let i = self.alloc();
        let gen = self.actors[i].gen;
        let info = &self.rules.actors[ty as usize];
        let mut a = Actor::blank();
        a.alive = true;
        a.gen = gen;
        a.kind = info.kind;
        a.ty = ty;
        a.owner = owner;
        a.x = x;
        a.y = y;
        a.px = x;
        a.py = y;
        a.facing = facing;
        a.turret = facing;
        a.pfacing = facing;
        a.pturret = facing;
        a.hp = info.hp;
        a.scan_cooldown = (i as i32) % 8;
        if info.unit.as_ref().map_or(false, |u| u.harvester.is_some()) {
            a.activity = Activity::Harvest;
            a.harv = HarvState::Search;
        }
        self.actors[i] = a;
        i
    }

    pub fn spawn_building(&mut self, ty: u16, owner: u8, cx: i32, cy: i32) -> usize {
        let i = self.alloc();
        let gen = self.actors[i].gen;
        let info = &self.rules.actors[ty as usize];
        let b = info.building.as_ref().expect("building info");
        let mut a = Actor::blank();
        a.alive = true;
        a.gen = gen;
        a.kind = Kind::Building;
        a.ty = ty;
        a.owner = owner;
        a.cx = cx;
        a.cy = cy;
        a.x = cx * CELL + b.width * HALF_CELL;
        a.y = cy * CELL + b.height * HALF_CELL;
        a.px = a.x;
        a.py = a.y;
        a.hp = info.hp;
        let footprint = b.footprint.clone();
        let free_actor = b.refinery.as_ref().map(|r| (r.free_actor, r.free_actor_offset));
        self.actors[i] = a;
        for (dx, dy, c) in footprint {
            if c == FootCell::Empty {
                continue;
            }
            let ci = self.map.idx(cx + dx, cy + dy);
            self.building_at[ci] = i as u32;
            if c == FootCell::Occupied {
                self.pass.set_blocked(ci, true);
            }
        }
        self.pass.refresh(&self.map);
        self.tokens_dirty = true;
        if let Some((ty, (ox, oy))) = free_actor {
            let (x, y) = (cell_center(cx + ox), cell_center(cy + oy));
            self.spawn_unit(ty as u16, owner, x, y, 512);
        }
        i
    }

    pub fn kill(&mut self, i: usize) {
        if !self.actors[i].alive {
            return;
        }
        let (x, y, kind) = (self.actors[i].x, self.actors[i].y, self.actors[i].kind);
        self.actors[i].alive = false;
        self.actors[i].hp = 0;
        self.losses[self.actors[i].owner as usize] += 1;
        self.dying.push(i as u32);
        let effect = if kind == Kind::Infantry { EffectKind::Piff } else { EffectKind::LargeExplosion };
        let ttl = if kind == Kind::Building { 30 } else { 18 };
        self.effects.push(Effect { x, y, kind: effect, ttl, max: ttl });
    }

    /// Free storage and cells of actors killed this tick.
    fn cleanup_dead(&mut self) {
        let dying = std::mem::take(&mut self.dying);
        for i in dying {
            let i = i as usize;
            let a = self.actors[i].clone();
            if a.kind == Kind::Building {
                let b = self.rules.actors[a.ty as usize].building.as_ref().unwrap();
                for &(dx, dy, c) in &b.footprint {
                    if c == FootCell::Empty {
                        continue;
                    }
                    let ci = self.map.idx(a.cx + dx, a.cy + dy);
                    if self.building_at[ci] == i as u32 {
                        self.building_at[ci] = NONE;
                        self.pass.set_blocked(ci, !self.map.terrain[ci].passable());
                    }
                }
                self.tokens_dirty = true;
            }
            // Release a refinery dock this harvester held.
            if let Some(r) = self.resolve(a.refinery) {
                let me = idx_ref(i, a.gen);
                if self.actors[r].dock_user == me {
                    self.actors[r].dock_user = NONE;
                }
            }
            self.actors[i].gen = self.actors[i].gen.wrapping_add(1);
            self.free.push(i as u32);
        }
        self.pass.refresh(&self.map);
    }

    // ---- Geometry helpers --------------------------------------------------

    #[inline]
    pub fn cell_of(&self, x: i32, y: i32) -> (i32, i32) {
        (
            (x.div_euclid(CELL)).clamp(0, self.map.width - 1),
            (y.div_euclid(CELL)).clamp(0, self.map.height - 1),
        )
    }

    #[inline]
    pub fn cell_index(&self, x: i32, y: i32) -> usize {
        let (cx, cy) = self.cell_of(x, y);
        self.map.idx(cx, cy)
    }

    /// Distance from a point to the actor's hit shape.
    pub fn hit_distance(&self, i: usize, x: i32, y: i32) -> i32 {
        let a = &self.actors[i];
        if a.kind == Kind::Building {
            let b = self.rules.actors[a.ty as usize].building.as_ref().unwrap();
            let mut best = i32::MAX;
            for &(dx, dy) in &b.hit_cells {
                let x0 = (a.cx + dx) * CELL;
                let y0 = (a.cy + dy) * CELL;
                let nx = x.clamp(x0, x0 + CELL);
                let ny = y.clamp(y0, y0 + CELL);
                best = best.min(dist(x, y, nx, ny));
            }
            best
        } else {
            let r = self.rules.actors[a.ty as usize].unit.as_ref().unwrap().radius;
            (dist(x, y, a.x, a.y) - r / 2).max(0)
        }
    }

    pub fn is_visible_to(&self, i: usize, player: u8) -> bool {
        let a = &self.actors[i];
        if a.owner == player {
            return true;
        }
        let vis = &self.players[player as usize].visible;
        if a.kind == Kind::Building {
            let b = self.rules.actors[a.ty as usize].building.as_ref().unwrap();
            b.footprint
                .iter()
                .any(|&(dx, dy, c)| c != FootCell::Empty && vis[self.map.idx(a.cx + dx, a.cy + dy)] != 0)
        } else {
            vis[self.cell_index(a.x, a.y)] != 0
        }
    }

    /// Unit indices in the given cell (from this tick's spatial hash).
    #[inline]
    pub fn units_in_cell(&self, ci: usize) -> &[u32] {
        let s = self.hash_start[ci] as usize;
        let e = self.hash_start[ci + 1] as usize;
        &self.hash_items[s..e]
    }

    pub(crate) fn rebuild_hash(&mut self) {
        let cells = self.map.cells();
        let mut counts = vec![0u32; cells + 1];
        let mut cell_of = Vec::with_capacity(self.actors.len());
        for a in &self.actors {
            if a.alive && a.kind != Kind::Building {
                let ci = self.cell_index(a.x, a.y);
                counts[ci] += 1;
                cell_of.push(ci as u32);
            } else {
                cell_of.push(NONE);
            }
        }
        let mut acc = 0u32;
        for c in counts.iter_mut() {
            let n = *c;
            *c = acc;
            acc += n;
        }
        self.hash_start = counts.clone();
        self.hash_items.clear();
        self.hash_items.resize(acc as usize, 0);
        let mut fill = counts;
        for (i, &ci) in cell_of.iter().enumerate() {
            if ci != NONE {
                let p = fill[ci as usize] as usize;
                self.hash_items[p] = i as u32;
                fill[ci as usize] += 1;
            }
        }
    }

    // ---- Economy -----------------------------------------------------------

    pub fn spend(&mut self, player: u8, amount: i32) -> bool {
        let p = &mut self.players[player as usize];
        if amount <= 0 {
            return true;
        }
        if p.funds() < amount {
            return false;
        }
        // OpenRA spends stored ore before cash.
        let from_res = amount.min(p.resources);
        p.resources -= from_res;
        p.cash -= amount - from_res;
        true
    }

    pub fn refund(&mut self, player: u8, amount: i32) {
        self.players[player as usize].cash += amount;
    }

    pub fn give_resources(&mut self, player: u8, amount: i32) {
        let p = &mut self.players[player as usize];
        p.resources = (p.resources + amount).min(p.storage.max(p.resources));
    }

    // ---- Orders ------------------------------------------------------------

    pub fn queue_order(&mut self, o: Order) {
        self.orders.push(o);
    }

    fn owned_units(&self, player: u8, ids: &[u32]) -> Vec<usize> {
        let mut out: Vec<usize> = ids
            .iter()
            .filter_map(|&r| self.resolve(r))
            .filter(|&i| self.actors[i].owner == player && self.actors[i].is_unit())
            .collect();
        out.sort_unstable();
        out.dedup();
        out
    }

    fn apply_orders(&mut self) {
        let orders = std::mem::take(&mut self.orders);
        for o in orders {
            match o {
                Order::Move { player, ids, x, y, attack_move } => {
                    let units = self.owned_units(player, &ids);
                    self.order_move(&units, x, y, attack_move);
                }
                Order::Smart { player, ids, x, y } => {
                    let units = self.owned_units(player, &ids);
                    self.order_smart(player, &units, x, y);
                }
                Order::Attack { player, ids, target } => {
                    let units = self.owned_units(player, &ids);
                    if let Some(t) = self.resolve(target) {
                        self.order_attack(&units, t, true);
                    }
                }
                Order::Stop { player, ids } => {
                    for i in self.owned_units(player, &ids) {
                        self.release_dock(i);
                        let a = &mut self.actors[i];
                        a.activity = Activity::Idle;
                        a.target = NONE;
                        a.attack_move = false;
                    }
                }
                Order::StartProduction { player, ty, count } => self.start_production(player, ty, count),
                Order::CancelProduction { player, ty } => self.cancel_production(player, ty),
                Order::Place { player, ty, cx, cy } => {
                    self.place_building(player, ty, cx, cy);
                }
                Order::Rally { player, building, x, y } => {
                    if let Some(b) = self.resolve(building) {
                        if self.actors[b].owner == player && self.actors[b].kind == Kind::Building {
                            self.actors[b].rally = Some((x, y));
                        }
                    }
                }
            }
        }
    }

    pub(crate) fn release_dock(&mut self, i: usize) {
        if let Some(r) = self.resolve(self.actors[i].refinery) {
            let me = self.make_ref(i);
            if self.actors[r].dock_user == me {
                self.actors[r].dock_user = NONE;
            }
        }
    }

    pub fn order_move(&mut self, units: &[usize], x: i32, y: i32, attack_move: bool) {
        if units.is_empty() {
            return;
        }
        let group = self.next_group;
        self.next_group += 1;
        let (gx, gy) = self.cell_of(x, y);
        let mut goals: Vec<(u32, u32)> = Vec::new();
        for &i in units {
            self.release_dock(i);
            let comp = self.pass.component[self.cell_index(self.actors[i].x, self.actors[i].y)];
            let goal = match goals.iter().find(|(c, _)| *c == comp) {
                Some(&(_, g)) => g,
                None => {
                    let g = nearest_in_component(&self.map, &self.pass, (gx, gy), comp).unwrap_or(NONE);
                    goals.push((comp, g));
                    g
                }
            };
            let a = &mut self.actors[i];
            a.activity = if goal == NONE { Activity::Idle } else { Activity::Move };
            a.goal = goal;
            a.group = group;
            a.group_size = units.len() as i32;
            a.attack_move = attack_move;
            a.dest = (x, y);
            a.target = NONE;
            a.forced = false;
            a.best_dist = i32::MAX;
            a.stuck_ticks = 0;
        }
    }

    pub fn order_attack(&mut self, units: &[usize], target: usize, forced: bool) {
        let tref = self.make_ref(target);
        for &i in units {
            if self.rules.actors[self.actors[i].ty as usize].weapons.is_empty() || i == target {
                continue;
            }
            self.release_dock(i);
            let a = &mut self.actors[i];
            a.activity = Activity::Attack;
            a.target = tref;
            a.forced = forced;
            a.attack_move = false;
            a.chase_cell = NONE;
            a.group_size = 1;
            a.best_dist = i32::MAX;
            a.stuck_ticks = 0;
        }
    }

    /// Actor visible to `player` at a world position, preferring units over buildings.
    pub fn actor_at(&self, player: u8, x: i32, y: i32) -> Option<usize> {
        let (cx, cy) = self.cell_of(x, y);
        let mut best: Option<(i32, usize)> = None;
        for oy in -1..=1 {
            for ox in -1..=1 {
                if !self.map.contains(cx + ox, cy + oy) {
                    continue;
                }
                for &u in self.units_in_cell(self.map.idx(cx + ox, cy + oy)) {
                    let u = u as usize;
                    let a = &self.actors[u];
                    if !a.alive || !self.is_visible_to(u, player) {
                        continue;
                    }
                    let r = self.rules.actors[a.ty as usize].unit.as_ref().unwrap().radius.max(256);
                    let d = dist(x, y, a.x, a.y);
                    if d <= r && best.map_or(true, |(bd, _)| d < bd) {
                        best = Some((d, u));
                    }
                }
            }
        }
        if let Some((_, u)) = best {
            return Some(u);
        }
        let b = self.building_at[self.map.idx(cx, cy)];
        if b != NONE && self.actors[b as usize].alive && self.is_visible_to(b as usize, player) {
            return Some(b as usize);
        }
        None
    }

    pub fn smart_action(&self, player: u8, units: &[usize], x: i32, y: i32) -> SmartAction {
        if units.is_empty() {
            return SmartAction::None;
        }
        let (cx, cy) = self.cell_of(x, y);
        let ci = self.map.idx(cx, cy);
        let any_weapon = units.iter().any(|&i| !self.rules.actors[self.actors[i].ty as usize].weapons.is_empty());
        let any_harv = units.iter().any(|&i| self.is_harvester(i));
        let any_vehicle = units.iter().any(|&i| self.actors[i].kind == Kind::Vehicle);
        if let Some(t) = self.actor_at(player, x, y) {
            let ta = &self.actors[t];
            if ta.owner != player {
                return if any_weapon { SmartAction::Attack } else { SmartAction::Move };
            }
            if ta.kind == Kind::Building {
                let b = self.rules.actors[ta.ty as usize].building.as_ref().unwrap();
                if b.refinery.is_some() && any_harv {
                    return SmartAction::Dock;
                }
                if b.repairs.is_some() && any_vehicle {
                    return SmartAction::Repair;
                }
            }
        }
        if any_harv && self.map.ore[ci] > 0 && self.players[player as usize].explored[ci] != 0 {
            return SmartAction::Harvest;
        }
        SmartAction::Move
    }

    fn order_smart(&mut self, player: u8, units: &[usize], x: i32, y: i32) {
        match self.smart_action(player, units, x, y) {
            SmartAction::None => {}
            SmartAction::Move => self.order_move(units, x, y, false),
            SmartAction::Attack => {
                let t = self.actor_at(player, x, y).unwrap();
                let (fighters, others): (Vec<usize>, Vec<usize>) =
                    units.iter().partition(|&&i| !self.rules.actors[self.actors[i].ty as usize].weapons.is_empty());
                self.order_attack(&fighters, t, true);
                self.order_move(&others, x, y, false);
            }
            SmartAction::Harvest => {
                let (harvs, others): (Vec<usize>, Vec<usize>) = units.iter().partition(|&&i| self.is_harvester(i));
                let ci = self.cell_index(x, y) as u32;
                for i in harvs {
                    self.release_dock(i);
                    let a = &mut self.actors[i];
                    a.activity = Activity::Harvest;
                    a.harv = HarvState::ToOre;
                    a.harv_cell = ci;
                    a.goal = ci;
                    a.group_size = 1;
                    a.best_dist = i32::MAX;
                    a.stuck_ticks = 0;
                }
                self.order_move(&others, x, y, false);
            }
            SmartAction::Dock => {
                let t = self.actor_at(player, x, y).unwrap();
                let tref = self.make_ref(t);
                let (harvs, others): (Vec<usize>, Vec<usize>) = units.iter().partition(|&&i| self.is_harvester(i));
                for i in harvs {
                    self.release_dock(i);
                    let a = &mut self.actors[i];
                    a.activity = Activity::Harvest;
                    a.harv = HarvState::ToDock;
                    a.refinery = tref;
                    a.best_dist = i32::MAX;
                    a.stuck_ticks = 0;
                }
                self.order_move(&others, x, y, false);
            }
            SmartAction::Repair => {
                let t = self.actor_at(player, x, y).unwrap();
                let tref = self.make_ref(t);
                let (veh, others): (Vec<usize>, Vec<usize>) =
                    units.iter().partition(|&&i| self.actors[i].kind == Kind::Vehicle);
                for i in veh {
                    self.release_dock(i);
                    let a = &mut self.actors[i];
                    a.activity = Activity::Repair;
                    a.depot = tref;
                    a.repair_timer = 0;
                    a.group_size = 1;
                    a.best_dist = i32::MAX;
                    a.stuck_ticks = 0;
                }
                self.order_move(&others, x, y, false);
            }
        }
    }

    pub fn is_harvester(&self, i: usize) -> bool {
        self.rules.actors[self.actors[i].ty as usize].unit.as_ref().map_or(false, |u| u.harvester.is_some())
    }

    // ---- Tick --------------------------------------------------------------

    pub fn step(&mut self) {
        self.tick += 1;
        for a in self.actors.iter_mut() {
            a.px = a.x;
            a.py = a.y;
            a.pfacing = a.facing;
            a.pturret = a.turret;
        }
        self.rebuild_hash();
        self.apply_orders();
        if self.tokens_dirty {
            self.refresh_tokens();
        }
        self.update_power();
        for p in 0..self.players.len() {
            if self.players[p].is_ai && !self.players[p].defeated {
                crate::ai::think(self, p as u8);
            }
        }
        for p in 0..self.players.len() {
            self.tick_production(p as u8);
        }
        self.tick_units();
        self.tick_projectiles();
        self.cleanup_dead();
        if self.tokens_dirty {
            self.refresh_tokens();
        }
        if self.tick % ORE_GROWTH_INTERVAL == 0 {
            let max = self.rules.player.ore_max_density;
            if self.map.grow_ore(&mut self.rng, max, &self.pass.blocked) {
                self.terrain_dirty = true;
            }
        }
        if self.tick % VISION_INTERVAL == 0 {
            self.update_vision();
        }
        for e in self.effects.iter_mut() {
            e.ttl -= 1;
        }
        self.effects.retain(|e| e.ttl > 0);
        if self.tick % TICKS_PER_SECOND == 0 {
            self.check_victory();
        }
    }

    fn check_victory(&mut self) {
        if self.stress || self.winner.is_some() {
            return;
        }
        let mut alive_count = vec![0u32; self.players.len()];
        for a in &self.actors {
            if a.alive {
                alive_count[a.owner as usize] += 1;
            }
        }
        for (p, &n) in alive_count.iter().enumerate() {
            if n == 0 {
                self.players[p].defeated = true;
            }
        }
        let remaining: Vec<usize> = (0..self.players.len()).filter(|&p| !self.players[p].defeated).collect();
        if remaining.len() == 1 && self.players.len() > 1 {
            self.winner = Some(remaining[0] as u8);
        }
    }

    /// FNV-1a over the simulation state; used to check determinism.
    pub fn state_hash(&self) -> u64 {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        let mut mix = |v: i64| {
            h ^= v as u64;
            h = h.wrapping_mul(0x0100_0000_01b3);
        };
        mix(self.tick as i64);
        for a in &self.actors {
            if a.alive {
                for v in [a.ty as i32, a.owner as i32, a.x, a.y, a.facing, a.turret, a.hp, a.bales] {
                    mix(v as i64);
                }
            }
        }
        for p in &self.players {
            mix(p.cash as i64);
            mix(p.resources as i64);
        }
        for &o in &self.map.ore {
            mix(o as i64);
        }
        h
    }

    pub fn queue_type_index(q: QueueType) -> usize {
        q as usize
    }
}

#[inline]
pub fn cell_center(c: i32) -> i32 {
    c * CELL + HALF_CELL
}

#[inline]
fn idx_ref(idx: usize, gen: u32) -> u32 {
    idx as u32 | ((gen & GEN_MASK) << IDX_BITS)
}

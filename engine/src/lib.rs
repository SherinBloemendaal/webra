//! WebRA simulation: a deterministic, fixed-step RTS core compiled to WebAssembly.
//!
//! The JavaScript side owns input, UI and WebGPU rendering. It calls `tick()`
//! at 25 Hz, queues player orders, and reads flat instance buffers straight
//! out of WebAssembly memory every frame.

mod abilities;
mod abilities_api;
mod ai;
mod air;
mod combat;
pub mod flowfield;
mod helicopter;
pub mod map;
pub mod mapdata;
pub mod math;
mod naval;
mod plane;
mod production;
pub mod render;
pub mod rng;
pub mod rules;
mod trig_table;
mod units;
mod vision;
pub mod world;

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_abilities;
#[cfg(test)]
mod tests_helis;
#[cfg(test)]
mod tests_naval;
#[cfg(test)]
mod tests_planes;

use math::CELL;
use render::{View, PX_PER_CELL};
use rules::{FootCell, Kind, QueueType};
use serde_json::json;
use wasm_bindgen::prelude::*;
use world::{AiDifficulty, GameOptions, Order, PlayerSetup, StartingUnits, World, NONE, TICKS_PER_SECOND};

/// Version shown in the game: the crate version plus the git commit it was built from.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const GIT_HASH: &str = env!("WEBRA_GIT_HASH");

#[wasm_bindgen]
pub fn version() -> String {
    format!("{VERSION}+{GIT_HASH}")
}

fn to_wu(px: f32) -> i32 {
    (px * CELL as f32 / PX_PER_CELL).round() as i32
}

#[wasm_bindgen]
pub struct Game {
    world: World,
    sprites: Vec<f32>,
    rects: Vec<f32>,
    fog: Vec<u8>,
    terrain: Vec<u8>,
    selection: Vec<u32>,
    /// Lockstep multiplayer: orders wait in the outbox for the network.
    lockstep: bool,
    outbox: Vec<Order>,
}

#[wasm_bindgen]
impl Game {
    /// Skirmish: the local player (slot 0) against one AI.
    #[wasm_bindgen(constructor)]
    pub fn new(seed: u32, faction: &str, ai_faction: &str, map_size: i32) -> Result<Game, JsError> {
        let rules = rules::Rules::load();
        for f in [faction, ai_faction] {
            if rules.faction_index(f).is_none() {
                return Err(JsError::new(&format!("unknown faction {f}")));
            }
        }
        let size = map_size.clamp(48, 512);
        let world = World::new(seed as u64, size, &[(faction, false), (ai_faction, true)]);
        Ok(Game::wrap(world))
    }

    /// Skirmish on a generated map from lobby options (JSON, see
    /// apps/game/js/lobby.js and docs/contracts.md section 3). Factions must
    /// already be resolved (no "random"); closed slots are left out.
    pub fn from_options(json: &str) -> Result<Game, JsError> {
        let o = parse_options(json)?;
        Ok(Game::wrap(World::with_options(o.seed, o.map_size, &o.players, o.options)))
    }

    /// Game on a map file (docs/contracts.md section 2) with lobby options.
    /// Rules overrides of modded maps apply; the caller must have shown the warning.
    pub fn from_map(map_json: &str, options_json: &str) -> Result<Game, JsError> {
        let data = mapdata::MapData::parse(map_json).map_err(|e| JsError::new(&e))?;
        let o = parse_options(options_json)?;
        let world = World::from_map(&data, o.seed, &o.players, o.options).map_err(|e| JsError::new(&e))?;
        Ok(Game::wrap(world))
    }

    /// SHA-256 (hex) identity of a map file's canonical form.
    pub fn map_hash(map_json: &str) -> Result<String, JsError> {
        Ok(mapdata::MapData::parse(map_json).map_err(|e| JsError::new(&e))?.hash())
    }

    /// Canonical JSON of a map file (what the hash is computed over).
    pub fn map_canonical(map_json: &str) -> Result<String, JsError> {
        Ok(mapdata::MapData::parse(map_json).map_err(|e| JsError::new(&e))?.canonical_json())
    }

    /// `{ ok, errors, modded, hash }` for a map file.
    pub fn validate_map(map_json: &str) -> String {
        let v = match mapdata::MapData::parse(map_json) {
            Ok(d) => d.validate(),
            Err(e) => mapdata::Validation { ok: false, errors: vec![e], modded: false, hash: None },
        };
        serde_json::to_string(&v).expect("validation serializes")
    }

    /// A generated map exported as a map file (for the editor and for multiplayer).
    pub fn generated_map(seed: u32, size: i32, players: u32) -> String {
        let size = size.clamp(mapdata::MIN_SIZE, mapdata::MAX_SIZE);
        let m = map::Map::generate_for(size, size, seed as u64, 12, players as usize);
        let name = format!("Random {players}p #{seed}");
        mapdata::MapData::from_map(&m, &name, "WebRA", "Generated map").canonical_json()
    }

    /// Lobby preview of a map file: RGBA, one pixel per cell, spawns marked.
    pub fn map_file_preview(map_json: &str) -> Result<Vec<u8>, JsError> {
        let data = mapdata::MapData::parse(map_json).map_err(|e| JsError::new(&e))?;
        let m = data.to_map().map_err(|e| JsError::new(&e))?;
        Ok(preview_rgba(&m))
    }

    /// Lobby preview of a generated map: RGBA, one pixel per cell, spawns marked.
    pub fn map_preview(seed: u32, size: i32) -> Vec<u8> {
        Game::map_preview_players(seed, size, 2)
    }

    pub fn map_preview_players(seed: u32, size: i32, players: u32) -> Vec<u8> {
        let size = size.clamp(48, 512);
        preview_rgba(&map::Map::generate_for(size, size, seed as u64, 12, players as usize))
    }

    /// Benchmark: `units` armed units split over two armies that attack-move into each other.
    pub fn new_stress(seed: u32, units: u32, map_size: i32) -> Game {
        Game::wrap(World::new_stress(seed as u64, units, map_size.clamp(64, 1024)))
    }

    fn wrap(world: World) -> Game {
        Game {
            world,
            sprites: Vec::new(),
            rects: Vec::new(),
            fog: Vec::new(),
            terrain: Vec::new(),
            selection: Vec::new(),
            lockstep: false,
            outbox: Vec::new(),
        }
    }

    pub fn tick(&mut self) {
        self.world.step();
    }

    // ---- Lockstep multiplayer (docs/contracts.md section 4) ------------------

    /// In lockstep mode, local orders go to an outbox instead of the world.
    pub fn set_lockstep(&mut self, on: bool) {
        self.lockstep = on;
    }

    /// Local orders since the last call, as a JSON array, for the network.
    pub fn take_orders(&mut self) -> String {
        let orders = std::mem::take(&mut self.outbox);
        serde_json::to_string(&orders).expect("orders serialize")
    }

    /// Queue one network frame before `tick()`: `[[player, [order, ...]], ...]`.
    /// Every order is re-stamped with the player the server assigned, so a
    /// client can never act for someone else. Invalid entries are skipped.
    /// Returns the number of orders queued.
    pub fn apply_frame(&mut self, frame_json: &str) -> Result<u32, JsError> {
        let frame: Vec<(u8, Vec<serde_json::Value>)> = serde_json::from_str(frame_json)
            .map_err(|e| JsError::new(&format!("bad frame: {}", e.to_string().chars().take(80).collect::<String>())))?;
        let mut queued = 0;
        for (player, orders) in frame {
            if player as usize >= self.world.players.len() {
                continue;
            }
            for v in orders {
                let Ok(mut o) = serde_json::from_value::<Order>(v) else { continue };
                if !o.is_reasonable() {
                    continue;
                }
                o.set_player(player);
                self.world.queue_order(o);
                queued += 1;
            }
        }
        Ok(queued)
    }

    pub fn player_count(&self) -> usize {
        self.world.players.iter().filter(|p| !p.neutral).count()
    }

    pub fn ticks_per_second() -> u32 {
        TICKS_PER_SECOND
    }

    pub fn tick_count(&self) -> u32 {
        self.world.tick
    }

    pub fn map_width(&self) -> i32 {
        self.world.map.width
    }

    pub fn map_height(&self) -> i32 {
        self.world.map.height
    }

    pub fn state_hash(&self) -> String {
        format!("{:016x}", self.world.state_hash())
    }

    // ---- Static data -------------------------------------------------------

    /// Actor metadata for the UI and sprite generation, in rules order.
    pub fn rules_json(&self) -> String {
        let r = &self.world.rules;
        let actors: Vec<_> = r
            .actors
            .iter()
            .map(|a| {
                let b = a.building.as_ref();
                json!({
                    "id": a.id,
                    "name": a.name,
                    "description": a.description,
                    "kind": match a.kind {
                        Kind::Building => "building",
                        Kind::Infantry => "infantry",
                        Kind::Vehicle => "vehicle",
                        Kind::Ship => "ship",
                        Kind::Aircraft => "aircraft",
                        Kind::Mine => "mine",
                    },
                    "altitude": a.unit.as_ref().and_then(|u| u.aircraft.as_ref()).map_or(0, |ac| ac.cruise_altitude),
                    "queue": a.queue as usize,
                    "cost": a.cost,
                    "hp": a.hp,
                    "order": a.palette_order,
                    "width": b.map_or(1, |b| b.width),
                    "height": b.map_or(1, |b| b.height),
                    "footprint": b.map(|b| b.footprint.iter().map(|&(x, y, c)| json!([x, y, match c { FootCell::Empty => 0, FootCell::Occupied => 1, FootCell::Passable => 2 }])).collect::<Vec<_>>()),
                    "power": b.map_or(0, |b| b.power),
                    "turret": a.turret_turn_speed.is_some(),
                    "radius": a.unit.as_ref().map_or(0, |u| u.radius),
                    "harvester": a.unit.as_ref().is_some_and(|u| u.harvester.is_some()),
                    "refinery": b.is_some_and(|b| b.refinery.is_some()),
                    "repairs": b.is_some_and(|b| b.repairs.is_some()),
                    "weapons": a.weapons.iter().map(|&w| &r.weapons[w].name).collect::<Vec<_>>(),
                })
            })
            .collect();
        json!({
            "actors": actors,
            "factions": r.factions,
            "pxPerCell": PX_PER_CELL,
            "players": self.world.players.iter().map(|p| json!({"faction": r.factions[p.faction], "side": p.side, "ai": p.is_ai})).collect::<Vec<_>>(),
        })
        .to_string()
    }

    // ---- Per-frame buffers -------------------------------------------------

    pub fn terrain_dirty(&self) -> bool {
        self.world.terrain_dirty
    }

    /// RGBA per cell. Clears the dirty flag.
    pub fn terrain_ptr(&mut self) -> *const u8 {
        self.world.terrain_bytes(&mut self.terrain);
        self.world.terrain_dirty = false;
        self.terrain.as_ptr()
    }

    pub fn terrain_len(&self) -> usize {
        self.terrain.len()
    }

    pub fn fog_ptr(&mut self, player: u8) -> *const u8 {
        self.world.fog_bytes(player, &mut self.fog);
        self.fog.as_ptr()
    }

    pub fn fog_len(&self) -> usize {
        self.fog.len()
    }

    /// Build instance buffers for the view rectangle (world pixels). Returns the sprite count.
    pub fn build_render(&mut self, player: u8, alpha: f32, x0: f32, y0: f32, x1: f32, y1: f32) -> usize {
        let view = View { x0, y0, x1, y1 };
        self.selection.retain(|&r| self.world.resolve(r).is_some());
        self.world.build_render(player, alpha.clamp(0.0, 1.0), &view, &self.selection, &mut self.sprites, &mut self.rects);
        self.sprites.len() / render::SPRITE_FLOATS
    }

    pub fn sprite_ptr(&self) -> *const f32 {
        self.sprites.as_ptr()
    }

    pub fn rect_count(&self) -> usize {
        self.rects.len() / render::RECT_FLOATS
    }

    pub fn rect_ptr(&self) -> *const f32 {
        self.rects.as_ptr()
    }

    // ---- Selection ---------------------------------------------------------

    pub fn set_selection(&mut self, ids: Vec<u32>) {
        self.selection = ids;
    }

    /// Selected ids that are still alive.
    pub fn selection(&self) -> Vec<u32> {
        self.selection.iter().copied().filter(|&r| self.world.resolve(r).is_some()).collect()
    }

    /// Actor under a world-pixel position visible to `player`, or 0xFFFFFFFF.
    pub fn pick(&self, player: u8, x: f32, y: f32) -> u32 {
        self.world.actor_at(player, to_wu(x), to_wu(y)).map_or(NONE, |i| self.world.make_ref(i))
    }

    /// Own units inside a world-pixel rectangle. When the box holds at least one
    /// armed unit, unarmed ones (harvesters) are left out, so dragging over an
    /// army never drags the economy along.
    pub fn select_box(&self, player: u8, x0: f32, y0: f32, x1: f32, y1: f32) -> Vec<u32> {
        let units = self.units_in_box(player, x0, y0, x1, y1);
        let w = &self.world;
        let armed = |i: &usize| !w.rules.actors[w.actors[*i].ty as usize].weapons.is_empty();
        let picked: Vec<usize> = if units.iter().any(armed) { units.into_iter().filter(armed).collect() } else { units };
        picked.into_iter().map(|i| w.make_ref(i)).collect()
    }

    fn units_in_box(&self, player: u8, x0: f32, y0: f32, x1: f32, y1: f32) -> Vec<usize> {
        let (ax, bx) = (to_wu(x0.min(x1)), to_wu(x0.max(x1)));
        let (ay, by) = (to_wu(y0.min(y1)), to_wu(y0.max(y1)));
        let w = &self.world;
        (0..w.actors.len())
            .filter(|&i| {
                let a = &w.actors[i];
                a.alive && a.owner == player && a.is_unit() && a.x >= ax && a.x <= bx && a.y >= ay && a.y <= by
            })
            .collect()
    }

    /// All own units of the same type as `id` inside the view rectangle (double click).
    pub fn select_same_type(&self, player: u8, id: u32, x0: f32, y0: f32, x1: f32, y1: f32) -> Vec<u32> {
        let Some(t) = self.world.resolve(id) else { return Vec::new() };
        let ty = self.world.actors[t].ty;
        self.units_in_box(player, x0, y0, x1, y1)
            .into_iter()
            .filter(|&i| self.world.actors[i].ty == ty)
            .map(|i| self.world.make_ref(i))
            .collect()
    }

    /// JSON description of an actor for the selection panel.
    pub fn actor_json(&self, id: u32) -> String {
        let Some(i) = self.world.resolve(id) else { return "null".into() };
        let a = &self.world.actors[i];
        let info = &self.world.rules.actors[a.ty as usize];
        json!({
            "id": id,
            "type": info.id,
            "name": info.name,
            "owner": a.owner,
            "hp": a.hp,
            "maxHp": info.hp,
            "building": a.kind == Kind::Building,
            "producer": info.building.as_ref().is_some_and(|b| !b.produces.is_empty() || b.repairs.is_some()),
            "bales": a.bales,
            "ability": self.world.ability_json(i),
        })
        .to_string()
    }

    /// What a right-click would do: 0 none, 1 move, 2 attack, 3 harvest, 4 dock, 5 repair.
    pub fn cursor_action(&self, player: u8, ids: Vec<u32>, x: f32, y: f32) -> u8 {
        let units: Vec<usize> = ids
            .iter()
            .filter_map(|&r| self.world.resolve(r))
            .filter(|&i| self.world.actors[i].owner == player && self.world.actors[i].is_unit())
            .collect();
        self.world.smart_action(player, &units, to_wu(x), to_wu(y)) as u8
    }

    // ---- Orders (applied at the start of the next tick) --------------------

    pub fn order_smart(&mut self, player: u8, ids: Vec<u32>, x: f32, y: f32) {
        self.submit(Order::Smart { player, ids, x: to_wu(x), y: to_wu(y) });
    }

    pub fn order_move(&mut self, player: u8, ids: Vec<u32>, x: f32, y: f32, attack_move: bool) {
        self.submit(Order::Move { player, ids, x: to_wu(x), y: to_wu(y), attack_move });
    }

    pub fn order_attack(&mut self, player: u8, ids: Vec<u32>, target: u32) {
        self.submit(Order::Attack { player, ids, target });
    }

    pub fn order_stop(&mut self, player: u8, ids: Vec<u32>) {
        self.submit(Order::Stop { player, ids });
    }

    pub fn sell(&mut self, player: u8, building: u32) {
        self.submit(Order::Sell { player, building });
    }

    /// Refund a structure would give right now (0 if it cannot be sold).
    pub fn sell_value(&self, player: u8, building: u32) -> i32 {
        let Some(b) = self.world.resolve(building) else { return 0 };
        let a = &self.world.actors[b];
        if a.owner != player || a.kind != Kind::Building {
            return 0;
        }
        let info = &self.world.rules.actors[a.ty as usize];
        let pct = info.building.as_ref().unwrap().sell_refund;
        (info.cost as i64 * pct as i64 * a.hp as i64 / (100 * info.hp as i64)) as i32
    }

    /// Deploy selected MCVs / pack up a selected Construction Yard.
    pub fn deploy(&mut self, player: u8, ids: Vec<u32>) {
        self.submit(Order::Deploy { player, ids });
    }

    /// 0: cannot deploy, 1: can deploy now, 2: deployable but blocked here.
    pub fn deploy_state(&self, player: u8, id: u32) -> u8 {
        let Some(i) = self.world.resolve(id) else { return 0 };
        if self.world.actors[i].owner != player || self.world.deploy_target(i).is_none() {
            return 0;
        }
        if self.world.can_deploy(i) {
            1
        } else {
            2
        }
    }

    pub fn set_rally(&mut self, player: u8, building: u32, x: f32, y: f32) {
        self.submit(Order::Rally { player, building, x: to_wu(x), y: to_wu(y) });
    }

    pub fn start_production(&mut self, player: u8, actor: &str, count: i32) {
        if let Some(ty) = self.world.rules.actor_index(actor) {
            self.submit(Order::StartProduction { player, ty: ty as u16, count });
        }
    }

    pub fn cancel_production(&mut self, player: u8, actor: &str) {
        if let Some(ty) = self.world.rules.actor_index(actor) {
            self.submit(Order::CancelProduction { player, ty: ty as u16 });
        }
    }

    pub fn place_building(&mut self, player: u8, actor: &str, cx: i32, cy: i32) {
        if let Some(ty) = self.world.rules.actor_index(actor) {
            self.submit(Order::Place { player, ty: ty as u16, cx, cy });
        }
    }

    /// Flat `[x, y, ok, ...]` per footprint cell for the placement preview.
    pub fn placement_preview(&self, player: u8, actor: &str, cx: i32, cy: i32) -> Vec<i32> {
        let Some(ty) = self.world.rules.actor_index(actor) else { return Vec::new() };
        self.world.placement_cells(player, ty as u16, cx, cy).into_iter().flat_map(|(x, y, ok)| [x, y, ok as i32]).collect()
    }

    // ---- Player state for the sidebar --------------------------------------

    pub fn player_json(&self, player: u8) -> String {
        let w = &self.world;
        let p = &w.players[player as usize];
        let queues: Vec<_> = p
            .queues
            .iter()
            .map(|q| {
                q.items
                    .iter()
                    .map(|it| {
                        let progress = if it.total > 0 { (it.total - it.remaining) as f32 / it.total as f32 } else { 0.0 };
                        json!({"id": w.rules.actors[it.ty as usize].id, "progress": progress, "done": it.done})
                    })
                    .collect::<Vec<_>>()
            })
            .collect();
        // Every item that can be built in this game mode, with what is still missing.
        let buildable: Vec<_> = (0..w.rules.actors.len())
            .filter(|&t| !w.rules.actors[t].prerequisites.iter().any(|pr| w.rules.tokens[pr.token as usize] == rules::TOKEN_DISABLED))
            .map(|t| {
                let av = w.availability(player, t as u16);
                let reqs = w.requirements(player, t as u16);
                json!({
                    "id": w.rules.actors[t].id,
                    "enabled": av.enabled,
                    "queue": w.rules.actors[t].queue as usize,
                    "requires": reqs.iter().filter(|r| !r.never).map(|r| &r.label).collect::<Vec<_>>(),
                    "exclusive": reqs.iter().find(|r| r.never).map(|r| &r.label),
                })
            })
            .collect();
        let has_producer: Vec<bool> = (0..rules::QUEUE_COUNT)
            .map(|q| {
                let qt = QueueType::from_index(q);
                w.actors.iter().any(|a| {
                    a.alive
                        && a.owner == player
                        && a.kind == Kind::Building
                        && w.rules.actors[a.ty as usize].building.as_ref().unwrap().produces.contains(&qt)
                })
            })
            .collect();
        let units = w.actors.iter().filter(|a| a.alive && a.owner == player && a.is_unit()).count();
        json!({
            "cash": p.cash,
            "resources": p.resources,
            "storage": p.storage,
            "funds": p.funds(),
            "powerGenerated": p.power_gen,
            "powerUsed": p.power_use,
            "lowPower": p.low_power(),
            "queues": queues,
            "buildable": buildable,
            "hasProducer": has_producer,
            "defeated": p.defeated,
            "winner": w.winner,
            "won": w.has_won(player),
            "team": p.team,
            "units": units,
            "tick": w.tick,
            "flowFields": w.flow.computed,
        })
        .to_string()
    }

    /// Start position (world pixels) of a player, for centering the camera.
    pub fn start_position(&self, player: u8) -> Vec<f32> {
        let (sx, sy) = self.world.players[player as usize].start;
        vec![(sx as f32 + 1.5) * PX_PER_CELL, (sy as f32 + 2.0) * PX_PER_CELL]
    }

    pub fn actor_count(&self) -> usize {
        self.world.actors.iter().filter(|a| a.alive).count()
    }
}

impl World {
    pub fn new_stress(seed: u64, units: u32, map_size: i32) -> World {
        let rules = rules::Rules::load();
        let map = map::Map::generate(map_size, map_size, seed, rules.player.ore_max_density);
        let mut w = World::empty(rules, map, seed);
        w.stress = true;
        let spawns = w.map.spawns.clone();
        w.add_player(w.rules.faction_index("allies").unwrap(), false, spawns[0]);
        w.add_player(w.rules.faction_index("soviet").unwrap(), false, spawns[1]);
        let types: Vec<u16> = ["E1", "1TNK", "3TNK", "E1"].iter().map(|t| w.rules.actor_index(t).unwrap() as u16).collect();
        let per_side = (units / 2).max(1) as usize;
        for side in 0..2u8 {
            let (sx, sy) = spawns[side as usize];
            let mut placed = Vec::new();
            let mut r: i32 = 0;
            'outer: loop {
                for dy in -r..=r {
                    for dx in -r..=r {
                        if dx.abs() != r && dy.abs() != r {
                            continue;
                        }
                        let (cx, cy) = (sx + dx, sy + dy);
                        if !w.map.contains(cx, cy) || w.pass.blocked[w.map.idx(cx, cy)] {
                            continue;
                        }
                        // Two units per cell: one tank or a pair of soldiers.
                        for k in 0..2 {
                            let ty = types[(placed.len() + k) % types.len()];
                            let off = if k == 0 { -256 } else { 256 };
                            let u = w.spawn_unit(ty, side, cx * CELL + 512 + off, cy * CELL + 512, if side == 0 { 384 } else { 896 });
                            placed.push(u);
                            if placed.len() >= per_side {
                                break 'outer;
                            }
                        }
                    }
                }
                r += 1;
                if r > map_size {
                    break;
                }
            }
            let (ex, ey) = spawns[1 - side as usize];
            w.order_move(&placed, ex * CELL + 512, ey * CELL + 512, true);
        }
        w.ai = Vec::new();
        w.refresh_tokens();
        w.update_vision();
        w
    }
}

struct ParsedOptions {
    seed: u64,
    map_size: i32,
    players: Vec<PlayerSetup>,
    options: GameOptions,
}

fn parse_options(json: &str) -> Result<ParsedOptions, JsError> {
    let v: serde_json::Value = serde_json::from_str(json).map_err(|e| JsError::new(&format!("bad options: {e}")))?;
    let rules = rules::Rules::load();
    let num = |k: &str, d: i64| v.get(k).and_then(|x| x.as_i64()).unwrap_or(d);
    let flag = |k: &str, d: bool| v.get(k).and_then(|x| x.as_bool()).unwrap_or(d);
    let text = |k: &str, d: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or(d).to_string();
    let mut players = Vec::new();
    for p in v.get("players").and_then(|p| p.as_array()).ok_or_else(|| JsError::new("options.players missing"))? {
        let kind = p.get("type").and_then(|t| t.as_str()).unwrap_or("human");
        if kind == "closed" || kind == "open" {
            continue;
        }
        let faction = p.get("faction").and_then(|f| f.as_str()).unwrap_or("allies").to_string();
        if rules.faction_index(&faction).is_none() {
            return Err(JsError::new(&format!("unknown faction {}", faction.chars().take(24).collect::<String>())));
        }
        let ai = match kind {
            "ai" => Some(match p.get("difficulty").and_then(|d| d.as_str()).unwrap_or("normal") {
                "easy" => AiDifficulty::Easy,
                "hard" => AiDifficulty::Hard,
                _ => AiDifficulty::Normal,
            }),
            _ => None,
        };
        let team = p.get("team").and_then(|t| t.as_u64()).unwrap_or(0).min(8) as u8;
        players.push(PlayerSetup { faction, ai, team });
    }
    if !(2..=8).contains(&players.len()) {
        return Err(JsError::new("a game needs 2 to 8 players"));
    }
    let tech = text("techLevel", "unrestricted");
    let options = GameOptions {
        starting_cash: num("startingCash", 5000).clamp(0, 1_000_000) as i32,
        starting_units: match text("startingUnits", "mcv").as_str() {
            "light" => StartingUnits::Light,
            "heavy" => StartingUnits::Heavy,
            "base" => StartingUnits::Base,
            _ => StartingUnits::Mcv,
        },
        tech_level: rules::TECH_LEVELS.iter().position(|t| *t == tech).unwrap_or(4),
        fog: flag("fog", true),
        explored: flag("explored", false),
        build_radius: flag("buildRadius", true),
        redeployable_mcv: flag("redeployableMcv", true),
        ore_regrowth: flag("oreRegrowth", true),
    };
    Ok(ParsedOptions { seed: num("seed", 1).max(0) as u64, map_size: (num("mapSize", 96) as i32).clamp(48, 512), players, options })
}

fn preview_rgba(m: &map::Map) -> Vec<u8> {
    let mut out = Vec::with_capacity(m.cells() * 4);
    for i in 0..m.cells() {
        let rgb = if m.ore[i] > 0 {
            [200, 160, 50]
        } else {
            match m.terrain[i] {
                map::Terrain::Clear => [62, 88, 44],
                map::Terrain::Rough => [96, 92, 58],
                map::Terrain::Rock => [128, 118, 102],
                map::Terrain::Water => [36, 70, 102],
                map::Terrain::Tree => [28, 54, 24],
            }
        };
        out.extend_from_slice(&[rgb[0], rgb[1], rgb[2], 255]);
    }
    const COLORS: [[u8; 3]; 8] =
        [[90, 150, 255], [240, 80, 60], [240, 205, 70], [90, 205, 100], [205, 115, 240], [240, 140, 50], [100, 215, 215], [230, 230, 230]];
    for (k, &(sx, sy)) in m.spawns.iter().enumerate() {
        for dy in 0..4 {
            for dx in 0..3 {
                let (x, y) = (sx + dx, sy + dy);
                if m.contains(x, y) {
                    let i = m.idx(x, y) * 4;
                    out[i..i + 3].copy_from_slice(&COLORS[k % 8]);
                }
            }
        }
    }
    out
}

impl Game {
    fn submit(&mut self, o: Order) {
        if self.lockstep {
            self.outbox.push(o);
        } else {
            self.world.queue_order(o);
        }
    }
}

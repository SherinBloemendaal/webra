//! WebRA simulation: a deterministic, fixed-step RTS core compiled to WebAssembly.
//!
//! The JavaScript side owns input, UI and WebGPU rendering. It calls `tick()`
//! at 25 Hz, queues player orders, and reads flat instance buffers straight
//! out of WebAssembly memory every frame.

mod abilities;
mod abilities_api;
mod actor_table;
mod ai;
mod ai_base;
pub mod ai_bots;
mod ai_economy;
mod ai_fuzzy;
mod ai_harvest;
mod ai_infantry;
mod ai_mcv;
mod ai_mines;
mod ai_naval;
mod ai_squads;
mod ai_support;
mod ai_units;
mod ai_upkeep;
mod air;
pub mod beacons;
pub mod bridges;
mod cargo;
mod combat;
mod combined;
mod commands;
pub mod crates;
pub mod debug;
mod dog;
pub mod doors;
pub mod editor;
pub mod flowfield;
pub mod fx;
mod game_mission;
pub mod gamerules;
mod helicopter;
pub mod husks;
pub mod infantry;
mod infantry_combat;
mod infantry_render;
pub mod instances;
pub mod lua;
pub mod map;
pub mod mapdata;
pub mod mapgen;
pub mod math;
pub mod minimap;
pub mod mission;
pub mod movement;
mod naval;
pub mod neutral;
pub mod observer;
pub mod overlays;
mod panic_report;
pub mod paths;
mod plane;
mod powers;
mod primary;
mod production;
pub mod range_circles;
pub mod render;
mod repair;
pub mod rng;
pub mod rules;
pub mod rules_options;
pub mod selection;
mod sell;
pub mod smudges;
pub mod sound_events;
#[cfg(any(test, feature = "stack-probe"))]
pub mod stack_check;
pub mod target_lines;
pub mod tooltip;
mod trig_table;
mod units;
mod veterancy;
mod vision;
pub mod weather;
pub mod world;

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_abilities;
#[cfg(test)]
mod tests_ai;
#[cfg(test)]
mod tests_ai_naval;
#[cfg(test)]
mod tests_antiair;
#[cfg(test)]
mod tests_combat;
#[cfg(test)]
mod tests_commands;
#[cfg(test)]
mod tests_debug;
#[cfg(test)]
mod tests_doors;
#[cfg(test)]
mod tests_editor;
#[cfg(test)]
mod tests_fx;
#[cfg(test)]
mod tests_gamerules;
#[cfg(test)]
mod tests_helis;
#[cfg(test)]
mod tests_infantry;
#[cfg(test)]
mod tests_instances;
#[cfg(test)]
mod tests_leftovers;
#[cfg(test)]
mod tests_mapsetup;
#[cfg(test)]
mod tests_minimap;
#[cfg(test)]
mod tests_mission;
#[cfg(test)]
mod tests_naval;
#[cfg(test)]
mod tests_naval_terrain;
#[cfg(test)]
mod tests_neutral;
#[cfg(test)]
mod tests_nuke;
#[cfg(test)]
mod tests_observer_icons;
#[cfg(test)]
mod tests_original_art;
#[cfg(test)]
mod tests_overlays;
#[cfg(test)]
mod tests_pathing;
#[cfg(test)]
mod tests_planes;
#[cfg(test)]
mod tests_poses;
#[cfg(test)]
mod tests_power_timers;
#[cfg(test)]
mod tests_production;
#[cfg(test)]
mod tests_range_circles;
#[cfg(test)]
mod tests_repair;
#[cfg(test)]
mod tests_replay;
#[cfg(test)]
mod tests_security;
#[cfg(test)]
mod tests_selection;
#[cfg(test)]
mod tests_sound;
#[cfg(test)]
mod tests_sound_eva;
#[cfg(test)]
mod tests_stats;
#[cfg(test)]
mod tests_surrender;
#[cfg(test)]
mod tests_target_lines;
#[cfg(test)]
mod tests_terrain;
#[cfg(test)]
mod tests_tooltip;
#[cfg(test)]
mod tests_unreachable;
#[cfg(test)]
mod tests_veterancy;
#[cfg(test)]
mod tests_weather;

use math::CELL;
use render::{px, View, PX_PER_CELL};
use rules::{FootCell, Kind, QueueType, Stance};
use serde_json::json;
use wasm_bindgen::prelude::*;
use world::{AiDifficulty, GameOptions, Order, PlayerSetup, StartingUnits, World, NONE, TICKS_PER_SECOND};

/// Version shown in the game: the crate version plus the git commit it was built from.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const GIT_HASH: &str = env!("WEBRA_GIT_HASH");

/// One line about an AI player's bot state (examples/ai_probe.rs).
pub use ai::debug_summary as ai_debug_summary;
/// What an AI player's naval squads do (examples/naval_probe.rs).
pub use ai_squads::{naval_report as ai_naval_report, NavalReport};

/// The built-in rules (engine/rules.json) as JSON: the base that map rules
/// overrides apply to. Used by the map editor to validate and show defaults.
#[wasm_bindgen]
pub fn base_rules_json() -> String {
    rules::RULES_JSON.to_string()
}

#[wasm_bindgen]
pub fn version() -> String {
    format!("{VERSION}+{GIT_HASH}")
}

/// The last engine panic since the previous call, as JSON `{ message,
/// location, tick }`, or undefined (panic_report.rs). After a panic the
/// wasm32 build has trapped; the JavaScript side reads this to report it.
#[wasm_bindgen]
pub fn take_panic() -> Option<String> {
    panic_report::take()
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
    /// Heat shimmer instances (build_heat_fx).
    fx: Vec<f32>,
    selection: Vec<u32>,
    /// Route lines of the selected units (paths.rs).
    paths: Vec<f32>,
    /// The structure the local player is placing (range circles, range_circles.rs).
    placing: Option<range_circles::Placing>,
    /// Tick-rate records for the GPU instance pass (instances.rs).
    sprite_records: Vec<f32>,
    sprite_extras: Vec<f32>,
    rect_records: Vec<f32>,
    /// Lockstep multiplayer: orders wait in the outbox for the network.
    lockstep: bool,
    outbox: Vec<Order>,
    /// Smudges as the view player last saw them (smudges.rs): a new one
    /// shows once its cell is in sight, like OpenRA's SmudgeLayer under the
    /// fog. Presentation only; the alpha byte of `terrain_ptr`.
    smudges_shown: Vec<u8>,
    /// Some smudge still waits for its cell to come into sight; checked at `smudges_tick`.
    smudges_pending: bool,
    smudges_tick: u32,
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
        let o = parse_options(json).map_err(|e| JsError::new(&e))?;
        // A generated map has a spawn for every player.
        if let Some(problem) = gamerules::spawn_pick_problem(&o.players, o.players.len()) {
            return Err(JsError::new(&problem));
        }
        Ok(Game::wrap(World::with_options(o.seed, o.map_size, &o.players, o.options)))
    }

    /// Game on a map file (docs/contracts.md section 2) with lobby options.
    /// Rules overrides of modded maps apply; the caller must have shown the warning.
    pub fn from_map(map_json: &str, options_json: &str) -> Result<Game, JsError> {
        let data = mapdata::MapData::parse(map_json).map_err(|e| JsError::new(&e))?;
        // The options the map locks (map format version 2): the lobbies keep
        // them; a game that does not is refused rather than played otherwise.
        let raw: serde_json::Value = serde_json::from_str(options_json).map_err(|e| JsError::new(&format!("bad options: {e}")))?;
        if let Some(problem) = data.locked_option_problem(&raw) {
            return Err(JsError::new(&problem));
        }
        let o = parse_options(options_json).map_err(|e| JsError::new(&e))?;
        let world = World::from_map(&data, o.seed, &o.players, o.options).map_err(|e| JsError::new(&e))?;
        Ok(Game::wrap(world))
    }

    /// The map editor's view of a map file (apps/game/editor): the map's
    /// actors, the trees of its tree terrain and its bridges as a game on it
    /// starts them, for `build_render` and `terrain_ptr` with
    /// `observer_player()`. Not validated and never ticked: no player
    /// starts there (World::editor_preview). Spawn k's actors are drawn as
    /// player k, neutral ones as player `world::EDITOR_SLOTS`.
    pub fn editor_preview(map_json: &str) -> Result<Game, JsError> {
        let data = mapdata::MapData::parse(map_json).map_err(|e| JsError::new(&e))?;
        Ok(Game::wrap(World::editor_preview(&data).map_err(|e| JsError::new(&e))?))
    }

    /// The map editor's overlay of an editor preview (editor.rs
    /// `editor_cells`): per cell, flags (passable, buildable, reachable from
    /// spawn 1, on a rush path) and the nearest spawn by ground in the high byte.
    pub fn editor_cells(&self) -> Vec<u16> {
        self.world.editor_cells()
    }

    /// What the player of spawn `k` sees at the start of a game on an editor
    /// preview (editor.rs `editor_fog`): one byte per cell, 0 shroud, 255 visible.
    pub fn editor_fog(&self, k: u32) -> Vec<u8> {
        self.world.editor_fog(k as usize)
    }

    /// The map editor's fairness report of an editor preview (editor.rs `editor_report`), JSON.
    pub fn editor_report(&self) -> String {
        self.world.editor_report().to_string()
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

    /// A generated temperate map in the seed's style, exported as a map file.
    pub fn generated_map(seed: u32, size: i32, players: u32) -> String {
        Game::generated_map_styled(seed, size, players, "random", "temperate").expect("built-in names")
    }

    /// A generated map exported as a map file (for the editor and for
    /// multiplayer). `style`: random, land, rivers, lakes, islands; `biome`:
    /// random, temperate, snow, desert (random ones are picked from the seed,
    /// as in a game).
    pub fn generated_map_styled(seed: u32, size: i32, players: u32, style: &str, biome: &str) -> Result<String, JsError> {
        Game::generated_map_with(seed, size, players, style, biome, "standard")
    }

    /// `generated_map_styled` with the lobby option `techBuildings` (none,
    /// standard, extra, oilonly, oilrush): the tech buildings the map gets.
    pub fn generated_map_with(seed: u32, size: i32, players: u32, style: &str, biome: &str, tech: &str) -> Result<String, JsError> {
        let tech = parse_tech_buildings(tech)?;
        let size = size.clamp(mapdata::MIN_SIZE, mapdata::MAX_SIZE);
        let (style, biome) = (parse_style(style)?, parse_biome(biome)?.unwrap_or_else(|| weather::Biome::random(seed as u64)));
        let m = map::Map::generate_styled(size, size, seed as u64, 12, players as usize, style);
        let resolved = style.resolve(seed as u64);
        let name = format!("Random {players}p #{seed}");
        let description = format!("Generated map: {}, {}", resolved.name(), biome.name());
        let mut data = mapdata::MapData::from_map(&m, &name, "WebRA", &description);
        data.biome = biome;
        // The ore mines, tech buildings and villages a game on this map gets
        // (mapgen/sites.rs, settlements.rs).
        data.actors = mapgen::sites::world_actors(&m, &rules::Rules::load(), biome, tech, seed as u64);
        // A map file of the current format, stamped with this release (docs/contracts.md "Map versions").
        Ok(data.file_json())
    }

    /// Lobby preview of a map file: RGBA, one pixel per cell, spawns marked.
    pub fn map_file_preview(map_json: &str) -> Result<Vec<u8>, JsError> {
        let data = mapdata::MapData::parse(map_json).map_err(|e| JsError::new(&e))?;
        let m = data.to_map().map_err(|e| JsError::new(&e))?;
        Ok(preview_rgba(&m, data.biome))
    }

    /// Lobby preview of a generated two-player map (temperate, seed's style).
    pub fn map_preview(seed: u32, size: i32) -> Vec<u8> {
        Game::map_preview_players(seed, size, 2)
    }

    /// Lobby preview of a generated temperate map in the seed's style.
    pub fn map_preview_players(seed: u32, size: i32, players: u32) -> Vec<u8> {
        Game::map_preview_styled(seed, size, players, "random", "temperate").expect("built-in names")
    }

    /// Lobby preview of a generated map with a style and biome (names as in
    /// `generated_map_styled`): RGBA, one pixel per cell, spawns marked.
    pub fn map_preview_styled(seed: u32, size: i32, players: u32, style: &str, biome: &str) -> Result<Vec<u8>, JsError> {
        let size = size.clamp(48, 512);
        let (style, biome) = (parse_style(style)?, parse_biome(biome)?.unwrap_or_else(|| weather::Biome::random(seed as u64)));
        Ok(preview_rgba(&map::Map::generate_styled(size, size, seed as u64, 12, players as usize, style), biome))
    }

    /// The style a seed gives a generated map (`style` may be "random").
    pub fn resolved_style(seed: u32, style: &str) -> Result<String, JsError> {
        Ok(parse_style(style)?.resolve(seed as u64).name().to_string())
    }

    /// The biome a seed gives a generated map (`biome` may be "random").
    pub fn resolved_biome(seed: u32, biome: &str) -> Result<String, JsError> {
        Ok(parse_biome(biome)?.unwrap_or_else(|| weather::Biome::random(seed as u64)).name().to_string())
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
            fx: Vec::new(),
            selection: Vec::new(),
            paths: Vec::new(),
            placing: None,
            sprite_records: Vec::new(),
            sprite_extras: Vec::new(),
            rect_records: Vec::new(),
            lockstep: false,
            outbox: Vec::new(),
            smudges_shown: Vec::new(),
            smudges_pending: false,
            smudges_tick: u32::MAX,
        }
    }

    /// Reveal changed smudges where the view player sees them (every cell
    /// for spectators); marks the terrain dirty when one shows.
    fn sync_smudges(&mut self, player: u8) {
        let w = &mut self.world;
        let cells = w.smudges.cells.len();
        if self.smudges_shown.len() != cells {
            self.smudges_shown = vec![smudges::NO_SMUDGE; cells];
        }
        if !w.smudges.changed && !(self.smudges_pending && self.smudges_tick != w.tick) {
            return;
        }
        w.smudges.changed = false;
        self.smudges_tick = w.tick;
        let all = player == observer::OBSERVER || player == combined::COMBINED || player as usize >= w.players.len();
        let (mut pending, mut shown) = (false, false);
        for ci in 0..cells {
            let s = w.smudges.cells[ci];
            if s == self.smudges_shown[ci] {
                continue;
            }
            if all || w.players[player as usize].visible[ci] != 0 {
                self.smudges_shown[ci] = s;
                shown = true;
            } else {
                pending = true;
            }
        }
        self.smudges_pending = pending;
        if shown {
            w.terrain_dirty = true;
        }
    }

    pub fn tick(&mut self) {
        panic_report::note_tick(self.world.tick);
        self.world.step();
    }

    // ---- Audio events (sound_events.rs) -------------------------------------

    /// Turn the audio event log on or off. Off by default; it never affects
    /// the simulation, so lockstep peers may differ here.
    pub fn set_audio_events(&mut self, on: bool) {
        self.world.sound.set_enabled(on);
    }

    /// Audio events since the last call, flat: `audio_event_stride()` values
    /// per event (`[kind, a, x, y, owner, b]`, world units). Empties the log.
    pub fn take_audio_events(&mut self) -> Vec<i32> {
        self.world.sound.take()
    }

    pub fn audio_event_stride() -> u32 {
        sound_events::EVENT_STRIDE as u32
    }

    /// World units per cell, to convert audio event positions to pixels.
    pub fn world_units_per_cell() -> i32 {
        CELL
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
                // Defeated players' orders are refused (observer.rs counts the rest).
                if self.world.queue_player_order(o) {
                    queued += 1;
                }
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

    // ---- Biome and weather (weather.rs) --------------------------------------

    /// `{ biome, mode, weather, since, until, tick, sightPct, flash }`: the
    /// sky for the HUD and the weather renderer. `flash` is the latest
    /// lightning `[tick, x, y]` (world pixels) or null; `sightPct` is what
    /// weather does to sight right now (100 when effects are off).
    pub fn weather_json(&self) -> String {
        let env = &self.world.env;
        let px = |v: i32| v as f32 * PX_PER_CELL / CELL as f32;
        json!({
            "biome": env.biome.name(),
            "mode": env.mode.name(),
            "weather": env.weather.name(),
            "since": env.since,
            "until": env.until,
            "tick": self.world.tick,
            "sightPct": if env.effects() { env.weather.sight_pct() } else { 100 },
            "flash": env.flash.map(|(t, x, y)| json!([t, px(x), px(y)])),
        })
        .to_string()
    }

    /// Heat shimmer instances for the view rectangle (world pixels): own and
    /// visible vehicles that run hot, `[x, y, heat 0..1, overheated 0|1]`
    /// each, at most `MAX_HEAT_FX`. Returns the count; read with `fx_ptr`.
    pub fn build_heat_fx(&mut self, player: u8, x0: f32, y0: f32, x1: f32, y1: f32) -> usize {
        const MAX_HEAT_FX: usize = 512;
        self.fx.clear();
        let w = &self.world;
        let (ax, bx, ay, by) = (to_wu(x0.min(x1)), to_wu(x0.max(x1)), to_wu(y0.min(y1)), to_wu(y0.max(y1)));
        for i in 0..w.actors.len() {
            let a = &w.actors[i];
            if !a.alive || !a.in_world() || a.env.heat < weather::HEAT_RECOVER / 2 || a.x < ax || a.x > bx || a.y < ay || a.y > by {
                continue;
            }
            // The spectator views (observer.rs, combined.rs) are no player slot: everything shows.
            if (player as usize) < w.players.len() && a.owner != player && !w.is_visible_to(i, player) {
                continue;
            }
            let k = PX_PER_CELL / CELL as f32;
            self.fx.extend_from_slice(&[
                a.x as f32 * k,
                a.y as f32 * k,
                a.env.heat as f32 / weather::HEAT_MAX as f32,
                a.env.overheated as u8 as f32,
            ]);
            if self.fx.len() / 4 >= MAX_HEAT_FX {
                break;
            }
        }
        self.fx.len() / 4
    }

    pub fn fx_ptr(&self) -> *const f32 {
        self.fx.as_ptr()
    }

    // ---- Static data -------------------------------------------------------

    /// Actor metadata for the UI and sprite generation, in rules order.
    pub fn rules_json(&self) -> String {
        let r = &self.world.rules;
        let actors: Vec<_> = r
            .actors
            .iter()
            .enumerate()
            .map(|(ty_index, a)| {
                let b = a.building.as_ref();
                json!({
                    "id": a.id,
                    // A mission's own actor is drawn and voiced like this one (apps/game/js/missionart.js).
                    "art": self.world.mission().and_then(|m| m.art_key(&a.id)),
                    "name": a.name,
                    "description": a.description,
                    "kind": match a.kind {
                        Kind::Building => "building",
                        Kind::Infantry => "infantry",
                        Kind::Vehicle => "vehicle",
                        Kind::Ship => "ship",
                        Kind::Aircraft => "aircraft",
                        Kind::Mine => "mine",
                        Kind::Husk => "husk",
                        Kind::Crate => "crate",
                        Kind::Proxy => "proxy",
                    },
                    "altitude": a.unit.as_ref().and_then(|u| u.aircraft.as_ref()).map_or(0, |ac| ac.cruise_altitude),
                    "queue": a.queue as usize,
                    "cost": a.cost,
                    "hp": a.hp,
                    "order": a.palette_order,
                    "width": b.map_or(1, |b| b.width),
                    "height": b.map_or(1, |b| b.height),
                    // Where the art is centred relative to the footprint's centre, world pixels (OpenRA LocalCenterOffset).
                    "centerOffset": b.map_or([0.0, 0.0], |b| [px(b.center_offset.0), px(b.center_offset.1)]),
                    "footprint": b.map(|b| b.footprint.iter().map(|&(x, y, c)| json!([x, y, match c { FootCell::Empty => 0, FootCell::Occupied => 1, FootCell::Passable => 2, FootCell::Overlay => 3 }])).collect::<Vec<_>>()),
                    "power": b.map_or(0, |b| b.power),
                    "turret": a.turret_turn_speed.is_some(),
                    "radius": a.unit.as_ref().map_or(0, |u| u.radius),
                    // Terrain codes (map::Terrain) a ground unit or ship may stand on, by
                    // its locomotor (World::terrain_open_to): the map editor places ships
                    // on water. None for aircraft and actors that do not move.
                    "terrain": a.unit.as_ref().filter(|u| r.locomotors[u.locomotor].domain != rules::Domain::Air).map(|_| {
                        (0..map::TERRAIN_COUNT)
                            .filter(|&t| self.world.terrain_open_to(ty_index, map::Terrain::from_u8(t).unwrap()))
                            .collect::<Vec<_>>()
                    }),
                    // Naval yards stand on water, other structures on clear ground and roads.
                    "onWater": b.is_some_and(|b| b.on_water),
                    "harvester": a.unit.as_ref().is_some_and(|u| u.harvester.is_some()),
                    "refinery": b.is_some_and(|b| b.refinery.is_some()),
                    "repairs": b.is_some_and(|b| b.repairs.is_some()),
                    // Sidebar buttons (repair.rs): the Repair and Power down buttons work on it.
                    "repairable": b.is_some_and(|b| b.repairable.is_some()),
                    "powerDown": b.is_some_and(|b| b.power_down),
                    "weapons": a.weapons.iter().map(|&w| &r.weapons[w].name).collect::<Vec<_>>(),
                    // What a map may set for a pre-placed actor (mapdata.rs, map format
                    // version 2): a fire stance, veterancy levels, passengers.
                    "stance": a.stance.is_some() && !a.weapons.is_empty(),
                    "levels": a.experience.as_ref().map_or(0, |x| x.thresholds.len()),
                    "cargo": a.abilities.cargo.as_ref().filter(|c| !c.garrison).map(|c| json!({"types": c.types, "max": c.max})),
                    "passenger": a.unit.as_ref().and_then(|u| u.passenger.as_ref().map(|p| json!({"type": p, "weight": u.passenger_weight}))),
                    // The neutral world (neutral.rs): editor category, biomes, bridge templates.
                    "world": neutral::world_json(a),
                    // PrimaryBuilding (primary.rs): the deploy command makes it primary.
                    "primary": a.options.primary_building,
                    // Crate actions in rules order (crates.rs): their class (`key`,
                    // sound_events.rs crate_action_code), sound, notification and animation.
                    "crateActions": a.options.crate_info.as_ref().map(|c| c.actions.iter().map(|x| json!({
                        "key": x.key,
                        "kind": format!("{:?}", x.kind),
                        "sequence": x.sequence,
                        "sound": x.sound,
                        "notification": x.notification,
                        "amount": x.amount,
                    })).collect::<Vec<_>>()),
                    // Support power keys in rules order: audio events name a power by provider and index.
                    "powers": a.abilities.support_powers.as_ref().map_or(Vec::new(), |l| l.iter().map(|p| p.key.as_str()).collect::<Vec<_>>()),
                    "buildLimit": a.build_limit,
                    // Infantry abilities (infantry.rs), for tooltips and order cursors.
                    "heals": a.targets_allies,
                    "disguise": a.abilities.disguise.is_some(),
                    "captures": a.abilities.captures.is_some(),
                    "infiltrates": a.abilities.infiltrates.is_some(),
                    "demolition": a.abilities.demolition.is_some(),
                    "leaps": a.abilities.attack_leap.is_some(),
                })
            })
            .collect();
        json!({
            "actors": actors,
            // Weapon names in rules order: audio events name weapons by index.
            "weapons": r.weapons.iter().map(|w| &w.name).collect::<Vec<_>>(),
            "factions": r.factions,
            "pxPerCell": PX_PER_CELL,
            // Production takes this percentage of its time while power is low (OpenRA LowPowerModifier).
            "lowPowerModifier": r.player.low_power_modifier,
            // Teams (0: none, equal non-zero teams are allies) and neutral owners:
            // the client's relationship colours and radar pings follow them.
            "players": self.world.players.iter().map(|p| json!({"faction": r.factions[p.faction], "side": p.side, "ai": p.is_ai, "team": p.team, "neutral": p.neutral, "handicap": p.handicap})).collect::<Vec<_>>(),
            // Time limit warnings (gamerules.rs): minutes left and the announcer line.
            "timeLimit": {
                "warnings": r.world.time_limit.warnings,
                "notifications": r.world.time_limit.notifications,
            },
        })
        .to_string()
    }

    // ---- Per-frame buffers -------------------------------------------------

    pub fn terrain_dirty(&self) -> bool {
        self.world.terrain_dirty
    }

    /// RGBA per cell (R terrain, G ore, B gems, A the smudge the view player
    /// saw, smudges.rs). Clears the dirty flag.
    pub fn terrain_ptr(&mut self) -> *const u8 {
        self.world.terrain_bytes(&mut self.terrain);
        for (px, &s) in self.terrain.as_chunks_mut::<4>().0.iter_mut().zip(&self.smudges_shown) {
            px[3] = s;
        }
        self.world.terrain_dirty = false;
        self.terrain.as_ptr()
    }

    pub fn terrain_len(&self) -> usize {
        self.terrain.len()
    }

    /// Fog bytes for `player`, or the whole map visible for
    /// `observer_player()` (spectators, replays).
    pub fn fog_ptr(&mut self, player: u8) -> *const u8 {
        if player == observer::OBSERVER {
            self.world.observer_fog_bytes(&mut self.fog);
        } else if player == combined::COMBINED {
            self.world.combined_fog_bytes(&mut self.fog);
        } else {
            self.world.fog_bytes(player, &mut self.fog);
        }
        self.fog.as_ptr()
    }

    pub fn fog_len(&self) -> usize {
        self.fog.len()
    }

    // ---- Radar minimap (minimap.rs, apps/game/js/minimap.js) ----------------

    /// 0: no radar structure, 1: online, 2: jammed, 3: low power.
    pub fn radar_state(&self, player: u8) -> u8 {
        self.world.radar_state(player) as u8
    }

    /// Radar blips `player` may see, `[cell x, cell y, width, height, owner]`
    /// each (owner 255: neutral); empty while the radar is offline. Read only.
    pub fn minimap_blips(&self, player: u8) -> Vec<i32> {
        if player as usize >= self.world.players.len() {
            return Vec::new();
        }
        let mut out = Vec::new();
        self.world.minimap_blips(player, &mut out);
        out
    }

    /// Build instance buffers for the view rectangle (world pixels). Returns the sprite count.
    /// `player` may be `observer_player()`: the whole map, every actor live,
    /// no owner-only decorations (observer.rs).
    pub fn build_render(&mut self, player: u8, alpha: f32, x0: f32, y0: f32, x1: f32, y1: f32) -> usize {
        let view = View { x0, y0, x1, y1 };
        self.sync_smudges(player);
        // Units that got into a transport drop out of the selection.
        self.selection.retain(|&r| self.world.resolve(r).is_some_and(|i| self.world.actors[i].in_world()));
        // The spectator view renders as slot 0 with every visibility check
        // passing; the flag is cleared again before anything else can run.
        let observer = player == observer::OBSERVER;
        let alpha = alpha.clamp(0.0, 1.0);
        if player == combined::COMBINED {
            // Every player's vision together, rendered as slot 0 (combined.rs).
            let Game { world, selection, sprites, rects, .. } = self;
            world.with_combined_view(|w| w.build_render(0, alpha, &view, selection, sprites, rects));
            return self.sprites.len() / render::SPRITE_FLOATS;
        }
        self.world.render_all = observer;
        let player = if observer { 0 } else { player };
        self.world.build_render(player, alpha, &view, &self.selection, &mut self.sprites, &mut self.rects);
        self.world.render_all = false;
        self.sprites.len() / render::SPRITE_FLOATS
    }

    /// The frame `build_render` draws, as tick-rate records for the GPU
    /// instance pass (instances.rs, apps/game/shaders/instances.wgsl): the
    /// whole map, both ends of every interpolation, each group's cull. They
    /// change only with a tick, the selection, the hovered actor, the render
    /// settings or `player`, so the caller rebuilds them only then. Returns
    /// the sprite record count; `record_ptr`, `record_extra_ptr` and
    /// `rect_record_ptr` (with their counts) locate the data.
    pub fn build_render_records(&mut self, player: u8) -> usize {
        self.sync_smudges(player);
        self.selection.retain(|&r| self.world.resolve(r).is_some_and(|i| self.world.actors[i].in_world()));
        let observer = player == observer::OBSERVER;
        if player == combined::COMBINED {
            let Game { world, selection, sprite_records, sprite_extras, rect_records, .. } = self;
            world.with_combined_view(|w| w.build_render_records(0, selection, sprite_records, sprite_extras, rect_records));
            return self.sprite_records.len() / instances::SPRITE_REC_FLOATS;
        }
        self.world.render_all = observer;
        let player = if observer { 0 } else { player };
        self.world.build_render_records(player, &self.selection, &mut self.sprite_records, &mut self.sprite_extras, &mut self.rect_records);
        self.world.render_all = false;
        self.sprite_records.len() / instances::SPRITE_REC_FLOATS
    }

    pub fn record_ptr(&self) -> *const f32 {
        self.sprite_records.as_ptr()
    }

    pub fn record_extra_count(&self) -> usize {
        self.sprite_extras.len() / instances::SPRITE_EXTRA_FLOATS
    }

    pub fn record_extra_ptr(&self) -> *const f32 {
        self.sprite_extras.as_ptr()
    }

    pub fn rect_record_count(&self) -> usize {
        self.rect_records.len() / instances::RECT_REC_FLOATS
    }

    pub fn rect_record_ptr(&self) -> *const f32 {
        self.rect_records.as_ptr()
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

    /// Route lines of the selected units `player` owns ("Show unit paths"):
    /// a few straight segments per unit, from where it is drawn (`alpha` as in
    /// `build_render`) along its path to its destination. Returns the
    /// segment count; read them through `path_ptr` (`paths::LINE_FLOATS`
    /// floats each: `[x0, y0, x1, y1, r, g, b, a, width]`, world pixels).
    pub fn build_paths(&mut self, player: u8, alpha: f32) -> usize {
        self.world.build_paths(player, alpha.clamp(0.0, 1.0), &self.selection, &mut self.paths);
        self.paths.len() / paths::LINE_FLOATS
    }

    /// Every line the map shows this frame: the range circles of the
    /// selected actors and of the structure being placed (range_circles.rs),
    /// the rally lines of the selected
    /// structures (OpenRA RallyPointIndicator, overlays.rs), then, with
    /// `paths` ("Show unit paths"), the routes `build_paths` draws, then the
    /// target lines (OpenRA DrawLineToTarget, target_lines.rs) of the
    /// selected units in `target_lines` (the client decides when they show,
    /// js/targetlines.js). Returns the segment count; read them through
    /// `path_ptr`. A rally line's red channel below zero selects its owner's
    /// team colour, a segment of length zero is a target marker
    /// (shaders/line.wgsl).
    pub fn build_lines(&mut self, player: u8, alpha: f32, paths: bool, target_lines: Option<Vec<u32>>) -> usize {
        let alpha = alpha.clamp(0.0, 1.0);
        let mut route = Vec::new();
        if paths {
            self.world.build_paths(player, alpha, &self.selection, &mut route);
        }
        self.paths.clear();
        self.world.build_range_circles(player, alpha, &self.selection, self.placing, &mut self.paths);
        self.world.build_rally_lines(player, &self.selection, &mut self.paths);
        self.paths.extend_from_slice(&route);
        if let Some(ids) = target_lines.filter(|ids| !ids.is_empty()) {
            self.world.build_target_lines(player, alpha, &self.selection, &ids, &mut self.paths);
        }
        self.paths.len() / paths::LINE_FLOATS
    }

    pub fn path_ptr(&self) -> *const f32 {
        self.paths.as_ptr()
    }

    // ---- Selection ---------------------------------------------------------

    pub fn set_selection(&mut self, ids: Vec<u32>) {
        self.selection = ids;
    }

    // ---- Render overlays (overlays.rs); never part of the simulation --------

    /// Actor under the mouse (from `pick`), or 0xFFFFFFFF: it gets a health bar
    /// like the selection and the selection's targets (overlays.rs).
    pub fn set_hover(&mut self, id: u32) {
        self.world.render_opts.hover = id;
    }

    /// The structure the local player is placing (`actor` id, top-left cell
    /// `cx`, `cy`; an unknown or empty id: none): its range circles and those
    /// of the same group around the player's and allies' actors show
    /// (range_circles.rs). Local UI state like the hover.
    pub fn set_placing(&mut self, actor: &str, cx: i32, cy: i32) {
        self.placing = self.world.rules.actors.iter().position(|a| a.id == actor).map(|ty| range_circles::Placing { ty, cx, cy });
    }

    /// The battlefield tooltip at a world-pixel point for `player`'s view
    /// (`observer_player()` and the combined view too), as JSON (tooltip.rs):
    /// `null` for none, else `{ kind: "unexplored" | "resource" | "actor" |
    /// "frozen", label, id (actors: the actor id), owner (the owner row's
    /// player or null), faction (the owner's), extras: [lines] }`. `ctrl`,
    /// `alt`: the modifier keys held. Reads the world only.
    pub fn world_tooltip(&mut self, player: u8, x: f32, y: f32, ctrl: bool, alt: bool) -> String {
        let (x, y, mods) = (to_wu(x), to_wu(y), selection::Mods { ctrl, alt });
        let tip = if player == combined::COMBINED {
            self.world.with_combined_view(|w| w.world_tooltip(0, None, x, y, mods))
        } else if (player as usize) >= self.world.players.len() {
            // The spectator view (observer.rs): the whole map, every actor live.
            self.world.render_all = true;
            let tip = self.world.world_tooltip(0, None, x, y, mods);
            self.world.render_all = false;
            tip
        } else {
            self.world.world_tooltip(player, Some(player), x, y, mods)
        };
        let Some(t) = tip else { return "null".into() };
        let w = &self.world;
        let kind = match t.kind {
            tooltip::TooltipKind::Unexplored => "unexplored",
            tooltip::TooltipKind::Resource => "resource",
            tooltip::TooltipKind::Actor => "actor",
            tooltip::TooltipKind::Frozen => "frozen",
        };
        json!({
            "kind": kind,
            "label": t.label,
            "id": t.actor.map(|i| w.make_ref(i)),
            "owner": t.owner,
            "faction": t.owner.and_then(|o| w.players.get(o as usize)).map(|p| w.rules.factions[p.faction].clone()),
            "extras": t.extras,
        })
        .to_string()
    }

    /// Extra health bars: 0 selected and hovered only, 1 also damaged actors, 2 all actors.
    pub fn set_health_bars(&mut self, mode: u8) {
        self.world.render_opts.health_bars = overlays::HealthBars::from_index(mode);
    }

    /// Per actor type, the static frame of its animated building layer or 0
    /// (apps/game/js/sprites.js `buildAtlas` returns this table as `overlays`).
    pub fn set_building_overlays(&mut self, frames: Vec<u32>) {
        self.world.render_opts.building_overlays = frames;
    }

    /// Sprite poses (render.rs `Pose`) in the body sprite ids, for art with
    /// pre-rendered animations (original graphics, texture packs; see
    /// docs/contracts.md section 8). Presentation only: the simulation never
    /// reads it, so the state hash is the same either way.
    pub fn set_sprite_poses(&mut self, on: bool) {
        self.world.render_opts.poses = on;
    }

    /// Actor types whose art has death sequences (apps/game/js/sprites.js
    /// `buildAtlas` returns them as `deaths`): with sprite poses on, dying
    /// soldiers of these types play them (infantry_render.rs). `ticks` has
    /// eight numbers per type (`deathTicks`): how long die1..die6 and the
    /// crushed body play, then the longest idle animation (0: none).
    /// Presentation only: bodies are not part of the state hash.
    pub fn set_death_art(&mut self, types: Vec<u32>, ticks: Vec<u32>) {
        let n = self.world.rules.actors.len();
        self.world.render_opts.set_death_art(n, &types, &ticks);
    }

    /// The sprite slots drawn from the original graphics and what they need
    /// (apps/game/js/content/atlas.js originalSlotInfo, docs/contracts.md
    /// section 8): those slots are drawn the OpenRA way (rotor sequences,
    /// effects that animate themselves, projectiles with their own facings);
    /// `info` holds `[kind, actor type, a, b]` records (overlays over units,
    /// storage level stages; overlays.rs `RenderOptions::set_original_art`).
    /// Presentation only: the state hash is the same either way.
    pub fn set_original_slots(&mut self, slots: Vec<u32>, info: Vec<i32>) {
        self.world.render_opts.set_original_art(&slots, &info);
    }

    /// The local player's control groups, for the numbers on their selection
    /// boxes (overlays.rs): `ids[k]` is in group `groups[k]` (0..=9). Local
    /// UI state like the selection: the simulation never reads it, so the
    /// state hash is the same either way.
    pub fn set_control_groups(&mut self, ids: Vec<u32>, groups: Vec<u8>) {
        self.world.render_opts.set_control_groups(&ids, &groups);
    }

    /// Selected ids that are still alive.
    pub fn selection(&self) -> Vec<u32> {
        self.selection.iter().copied().filter(|&r| self.world.resolve(r).is_some_and(|i| self.world.actors[i].in_world())).collect()
    }

    /// Actor under a world-pixel position visible to `player`, or 0xFFFFFFFF.
    pub fn pick(&self, player: u8, x: f32, y: f32) -> u32 {
        self.world.actor_at(player, to_wu(x), to_wu(y)).map_or(NONE, |i| self.world.make_ref(i))
    }

    /// OpenRA box selection (selection.rs `select_in_box`): the visible
    /// selectable actors whose bounds touch the world-pixel rectangle, those
    /// of the highest selection priority for `player` (own combat units before
    /// support units, harvesters, structures and other players' actors;
    /// `ctrl`, `alt`: the modifiers held, which raise the actors that allow
    /// them). A `player` past the players is a spectator watching everyone.
    #[allow(clippy::too_many_arguments)]
    pub fn select_box(&self, player: u8, x0: f32, y0: f32, x1: f32, y1: f32, ctrl: bool, alt: bool) -> Vec<u32> {
        let w = &self.world;
        let area = selection::Rect::new(to_wu(x0), to_wu(y0), to_wu(x1), to_wu(y1));
        w.select_in_box(w.selection_viewer(player), area, selection::Mods { ctrl, alt }).into_iter().map(|i| w.make_ref(i)).collect()
    }

    /// OpenRA's click selection (selection.rs `select_at_point`): the actor a
    /// click at the world-pixel point selects, or 0xFFFFFFFF.
    pub fn select_at(&self, player: u8, x: f32, y: f32, ctrl: bool, alt: bool) -> u32 {
        let w = &self.world;
        w.select_at_point(w.selection_viewer(player), to_wu(x), to_wu(y), selection::Mods { ctrl, alt }).map_or(NONE, |i| w.make_ref(i))
    }

    /// OpenRA SelectAllUnits (selection.rs): the selectable actors of
    /// `owners` (the players the viewer selects for) whose bounds touch the
    /// world-pixel rectangle, those of the highest selection priority (combat
    /// units before support units, harvesters and structures; `ctrl`, `alt`:
    /// the modifiers held). The whole map's rectangle selects across the map.
    #[allow(clippy::too_many_arguments)]
    pub fn select_all(&self, owners: Vec<u8>, x0: f32, y0: f32, x1: f32, y1: f32, ctrl: bool, alt: bool) -> Vec<u32> {
        let w = &self.world;
        let area = selection::Rect::new(to_wu(x0), to_wu(y0), to_wu(x1), to_wu(y1));
        let found = w.selectable_actors(&owners, Some(area), None);
        w.highest_selection_priority(found, selection::Mods { ctrl, alt }).into_iter().map(|i| w.make_ref(i)).collect()
    }

    /// OpenRA SelectUnitsByType and double click (selection.rs): the
    /// selectable actors of `owners` whose bounds touch the world-pixel
    /// rectangle and whose selection class is one of those of `ids` (the
    /// selection, or the clicked actor) that `owners` own.
    pub fn select_by_class(&self, owners: Vec<u8>, ids: Vec<u32>, x0: f32, y0: f32, x1: f32, y1: f32) -> Vec<u32> {
        let w = &self.world;
        let picked: Vec<usize> = ids.iter().filter_map(|&r| w.resolve(r)).collect();
        let classes = w.selection_classes(&owners, &picked);
        if classes.is_empty() {
            return Vec::new();
        }
        let area = selection::Rect::new(to_wu(x0), to_wu(y0), to_wu(x1), to_wu(y1));
        w.selectable_actors(&owners, Some(area), Some(&classes)).into_iter().map(|i| w.make_ref(i)).collect()
    }

    /// Centre (world pixels, `[x, y]`) of the given actors that `player` owns
    /// and that are alive on the map (not inside a transport); empty when none
    /// are. Centres the camera on a control group or the selection.
    pub fn units_center(&self, player: u8, ids: Vec<u32>) -> Vec<f32> {
        let w = &self.world;
        let (mut sx, mut sy, mut n) = (0i64, 0i64, 0i64);
        for id in ids {
            let Some(i) = w.resolve(id) else { continue };
            let a = &w.actors[i];
            if a.owner != player || !a.in_world() {
                continue;
            }
            sx += i64::from(a.x);
            sy += i64::from(a.y);
            n += 1;
        }
        if n == 0 {
            return Vec::new();
        }
        let to_px = |wu: i64| (wu as f64 / n as f64) as f32 * PX_PER_CELL / CELL as f32;
        vec![to_px(sx), to_px(sy)]
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
            // The neutral player's (civilian and tech buildings, neutral.rs), and the
            // TooltipDescription texts of tech buildings: @ally for the owner and its
            // allies, @other for everyone else.
            "neutral": self.world.neutral_player() == Some(a.owner),
            "allyDescription": info.world.ally_description,
            "otherDescription": info.world.other_description,
            "bales": a.bales,
            "gemBales": a.gem_bales,
            "ability": self.world.ability_json(i),
            // Helicopters: AmmoPool rounds left and size, and whether landed.
            "ammo": self.world.heli_ammo(i).0,
            "maxAmmo": self.world.heli_ammo(i).1,
            "landed": a.heli.landed,
            // Transports: passengers inside (ids, loading order), their total weight and Cargo.MaxWeight.
            "passengers": self.world.passengers(i).into_iter().map(|p| self.world.make_ref(p)).collect::<Vec<_>>(),
            "cargoWeight": self.world.cargo_weight(i),
            "cargoMax": self.world.cargo_max(i),
            // Passengers: the transport they are in (NONE when outside).
            "carrier": a.carrier,
            "submerged": a.submerged,
            // Desert heat (weather.rs): percent of the overheat point, and whether it is overheated.
            "heat": a.env.heat * 100 / weather::HEAT_MAX,
            "overheated": a.env.overheated,
            // Veterancy (veterancy.rs): level, levels, and experience in value
            // points (OpenRA counts percent of a value: 100 points per credit).
            "rank": a.rank,
            "maxRank": self.world.max_rank(i),
            "xp": a.xp / 100,
            "nextXp": self.world.level_experience(i, (a.rank as usize + 1).min(self.world.max_rank(i) as usize)) / 100,
            "prone": self.world.is_prone(i),
            // Repair and power down buttons (repair.rs).
            "repairing": !a.repairers.is_empty(),
            "repairers": a.repairers,
            "poweredOff": a.powered_off,
            "canPowerDown": self.world.has_power_down(i),
            // Infantry abilities (infantry.rs): a spy's disguise (type and owner;
            // only the owner and allies should be shown the spy behind it), a
            // capture in progress, C4 ticking, a power outage.
            "disguise": a.inf.disguise.map(|d| json!({"type": self.world.rules.actors[d.ty as usize].id, "owner": d.owner})),
            "beingCaptured": self.world.being_captured(i),
            "demolished": self.world.being_demolished(i),
            "powerOutage": if self.world.outage_disabled(i) { self.world.power_outage(a.owner) } else { 0 },
        })
        .to_string()
    }

    /// What a right-click would do: 0 none, 1 move, 2 attack, 3 harvest, 4 dock,
    /// 5 repair, 6 load (enter a transport), 7 deliver cash, 8 capture, 9
    /// infiltrate, 10 C4, 11 engineer repair, 12 heal, 13 mechanic repair, 14
    /// disguise, 15 blocked enter, 16 blocked engineer repair, 17 capture from
    /// outside (reusable engineers), 18 blocked move (terrain none of them can
    /// enter; still a move) (world.rs SmartAction).
    pub fn cursor_action(&self, player: u8, ids: Vec<u32>, x: f32, y: f32) -> u8 {
        let units: Vec<usize> = ids
            .iter()
            .filter_map(|&r| self.world.resolve(r))
            .filter(|&i| self.world.actors[i].owner == player && self.world.actors[i].is_unit() && self.world.actors[i].in_world())
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

    /// Force-fire on the ground at (x, y) (world pixels) until told otherwise.
    /// Force-fire on an actor (own ones too) is `order_attack`.
    pub fn order_attack_ground(&mut self, player: u8, ids: Vec<u32>, x: f32, y: f32) {
        self.submit(Order::AttackGround { player, ids, x: to_wu(x), y: to_wu(y) });
    }

    /// Follow and protect an own or allied unit.
    pub fn order_guard(&mut self, player: u8, ids: Vec<u32>, target: u32) {
        self.submit(Order::Guard { player, ids, target });
    }

    /// Each unit moves to a random free neighbouring cell.
    pub fn order_scatter(&mut self, player: u8, ids: Vec<u32>) {
        self.submit(Order::Scatter { player, ids });
    }

    /// Queue a move (or attack-move) after the current orders (Shift+click).
    pub fn order_waypoint(&mut self, player: u8, ids: Vec<u32>, x: f32, y: f32, attack_move: bool) {
        self.submit(Order::Waypoint { player, ids, x: to_wu(x), y: to_wu(y), attack_move });
    }

    /// Fire stance: "hold_fire", "return_fire", "defend" or "attack_anything".
    /// Returns false (and sends nothing) for another name.
    pub fn set_stance(&mut self, player: u8, ids: Vec<u32>, stance: &str) -> bool {
        let Some(stance) = Stance::ALL.into_iter().find(|s| s.name() == stance) else { return false };
        self.submit(Order::SetStance { player, ids, stance });
        true
    }

    /// What the command bar can do for these actors of `player` (JSON):
    /// `units` (own units), `armed` (of them, with a weapon), `attackGround`
    /// (units that can fire on the ground), `guard` and `scatter` (units that
    /// can), `queued` (waypoints queued in total) and `stances`: per stance
    /// name, how many of the actors (units and defences with AutoTarget) use it.
    pub fn command_state(&self, player: u8, ids: Vec<u32>) -> String {
        let w = &self.world;
        let mut actors: Vec<usize> = ids
            .iter()
            .filter_map(|&r| w.resolve(r))
            .filter(|&i| w.actors[i].owner == player && w.actors[i].in_world() && !w.is_support_aircraft(i))
            .collect();
        actors.sort_unstable();
        actors.dedup();
        let units: Vec<usize> = actors.iter().copied().filter(|&i| w.actors[i].is_unit()).collect();
        let count = |f: &dyn Fn(usize) -> bool| units.iter().filter(|&&i| f(i)).count();
        let mut stances = serde_json::Map::new();
        for s in Stance::ALL {
            let n = actors.iter().filter(|&&i| w.has_stance(i) && w.actors[i].stance == s).count();
            stances.insert(s.name().into(), n.into());
        }
        json!({
            "units": units.len(),
            "armed": count(&|i| w.has_weapons(i)),
            "attackGround": count(&|i| !w.is_plane(i) && w.rules.actors[w.actors[i].ty as usize].can_attack_class(&w.rules, rules::TARGET_GROUND | rules::TARGET_WATER)),
            "guard": count(&|i| !w.is_plane(i)),
            "scatter": count(&|i| !w.is_plane(i)),
            "queued": units.iter().map(|&i| w.actors[i].waypoints.len()).sum::<usize>(),
            "stances": stances,
        })
        .to_string()
    }

    /// Whether a guard order from `player`'s `ids` onto actor `target` would
    /// do something (an own or allied unit that one of them can guard).
    pub fn can_guard(&self, player: u8, ids: Vec<u32>, target: u32) -> bool {
        let w = &self.world;
        let Some(t) = w.resolve(target) else { return false };
        ids.iter()
            .filter_map(|&r| w.resolve(r))
            .any(|i| w.actors[i].owner == player && w.actors[i].is_unit() && w.actors[i].in_world() && w.can_guard(player, i, t))
    }

    /// Whether a plain move of `ids` to (x, y) (world pixels) passes visible
    /// enemies the armed units among them would ignore: the client offers the
    /// attack-move tip then (World::move_hint).
    pub fn move_hint(&self, player: u8, ids: Vec<u32>, x: f32, y: f32) -> bool {
        let w = &self.world;
        let actors: Vec<usize> = ids.iter().filter_map(|&r| w.resolve(r)).collect();
        w.move_hint(player, &actors, to_wu(x), to_wu(y))
    }

    /// Whether players `a` and `b` are on the same side (the same player too).
    pub fn are_allies(&self, a: u8, b: u8) -> bool {
        let n = self.world.players.len();
        (a as usize) < n && (b as usize) < n && self.world.are_allies(a, b)
    }

    /// Whether one of `player`'s `ids` can fire on the ground at (x, y) (world pixels).
    pub fn can_attack_ground(&self, player: u8, ids: Vec<u32>, x: f32, y: f32) -> bool {
        let w = &self.world;
        let (x, y) = (to_wu(x), to_wu(y));
        ids.iter()
            .filter_map(|&r| w.resolve(r))
            .any(|i| w.actors[i].owner == player && w.actors[i].is_unit() && w.actors[i].in_world() && w.can_attack_ground(i, x, y))
    }

    /// Whether one of `player`'s `ids` has a weapon that can hit actor
    /// `target` as it is now (force attack on an aircraft: anti-air only;
    /// world.rs `can_attack_actor`).
    pub fn can_attack_actor(&self, player: u8, ids: Vec<u32>, target: u32) -> bool {
        let w = &self.world;
        let Some(t) = w.resolve(target) else { return false };
        ids.iter()
            .filter_map(|&r| w.resolve(r))
            .any(|i| w.actors[i].owner == player && w.actors[i].is_unit() && w.actors[i].in_world() && w.can_attack_actor(i, t))
    }

    /// Helicopters: land on or next to the cell at (x, y) (world pixels).
    pub fn order_land(&mut self, player: u8, ids: Vec<u32>, x: f32, y: f32) {
        self.submit(Order::Land { player, ids, x: to_wu(x), y: to_wu(y) });
    }

    /// Helicopters: fly back to a free helipad and reload.
    pub fn order_return_to_base(&mut self, player: u8, ids: Vec<u32>) {
        self.submit(Order::ReturnToBase { player, ids });
    }

    pub fn sell(&mut self, player: u8, building: u32) {
        self.submit(Order::Sell { player, building });
    }

    /// WebRA bulk sell: sell the listed own sellable structures, never a
    /// Construction Yard (`World::sell_group`).
    pub fn sell_buildings(&mut self, player: u8, ids: Vec<u32>) {
        self.submit(Order::SellBuildings { player, ids });
    }

    /// The structures a box dragged in sell mode sells (`World::can_bulk_sell`):
    /// the player's whose selection bounds touch the world-pixel box, in actor order.
    pub fn sell_box(&self, player: u8, x0: f32, y0: f32, x1: f32, y1: f32) -> Vec<u32> {
        let w = &self.world;
        let area = selection::Rect::new(to_wu(x0), to_wu(y0), to_wu(x1), to_wu(y1));
        w.selectable_actors(&[player], Some(area), None)
            .into_iter()
            .filter(|&b| w.can_bulk_sell(player, b))
            .map(|b| w.make_ref(b))
            .collect()
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

    // ---- Sidebar buttons: repair, power down, beacon (repair.rs, beacons.rs) -----------

    /// Start or stop repairing an own or allied structure.
    pub fn repair_building(&mut self, player: u8, building: u32) {
        self.submit(Order::RepairBuilding { player, building });
    }

    /// WebRA bulk repair: start repairing the listed own damaged structures,
    /// or stop all of them when every one is being repaired already
    /// (`World::toggle_repair_group`).
    pub fn repair_buildings(&mut self, player: u8, ids: Vec<u32>) {
        self.submit(Order::RepairBuildings { player, ids });
    }

    /// WebRA bulk repair: each listed own damaged unit goes to the nearest own
    /// structure that repairs it (`World::send_units_to_repair`).
    pub fn repair_units(&mut self, player: u8, ids: Vec<u32>) {
        self.submit(Order::RepairUnits { player, ids });
    }

    /// What the Repair button or key repairs of `ids` (the selection), by
    /// category (`World::repair_groups_json`): the own damaged structures it
    /// toggles and the own damaged units it sends to repair.
    pub fn repair_selection_json(&self, player: u8, ids: Vec<u32>) -> String {
        let w = &self.world;
        w.repair_groups_json(player, ids.into_iter().filter_map(|id| w.resolve(id))).to_string()
    }

    /// What a box dragged in repair mode holds to repair, by category
    /// (`World::repair_groups_json`): the player's actors whose selection
    /// bounds touch the world-pixel box, in actor order.
    pub fn repair_box_json(&self, player: u8, x0: f32, y0: f32, x1: f32, y1: f32) -> String {
        let w = &self.world;
        let area = selection::Rect::new(to_wu(x0), to_wu(y0), to_wu(x1), to_wu(y1));
        w.repair_groups_json(player, w.selectable_actors(&[player], Some(area), None)).to_string()
    }

    /// Switch an own structure off, or on again.
    pub fn power_down(&mut self, player: u8, building: u32) {
        self.submit(Order::PowerDown { player, building });
    }

    /// Surrender: the player loses (OpenRA's in-game menu Surrender; World::surrender).
    pub fn surrender(&mut self, player: u8) {
        self.submit(Order::Surrender { player });
    }

    /// Place the player's beacon at a world-pixel position (replaces their previous one).
    pub fn place_beacon(&mut self, player: u8, x: f32, y: f32) {
        self.submit(Order::PlaceBeacon { player, x: to_wu(x), y: to_wu(y) });
    }

    /// What a click with the repair cursor on actor `id` does (OpenRA
    /// RepairOrderGenerator): 0 nothing, 1 start or stop repairing a friendly
    /// damaged structure, 2 send an own damaged unit to its repair depot
    /// (`repair_unit_target`).
    pub fn repair_cursor(&self, player: u8, id: u32) -> u8 {
        let Some(i) = self.world.resolve(id) else { return 0 };
        if self.world.can_repair_building(player, i) {
            1
        } else if self.world.repair_depot_for(player, i).is_some() {
            2
        } else {
            0
        }
    }

    /// World-pixel `[x, y]` of the depot an own damaged unit would be repaired
    /// at (own depots only, the nearest first), or empty.
    pub fn repair_unit_target(&self, player: u8, id: u32) -> Vec<f32> {
        let Some(i) = self.world.resolve(id) else { return Vec::new() };
        match self.world.repair_depot_for(player, i) {
            Some((x, y)) => vec![px(x), px(y)],
            None => Vec::new(),
        }
    }

    /// Whether a click with the power down cursor on actor `id` toggles it.
    pub fn can_power_down(&self, player: u8, id: u32) -> bool {
        self.world.resolve(id).is_some_and(|i| self.world.can_power_down(player, i))
    }

    // ---- Hotkey helpers (apps/game/js/ingame-hotkeys.js) ----------------------------

    /// What the base hotkey cycles through (OpenRA CycleBasesHotkeyLogic): the
    /// player's Construction Yards and MCVs (BaseBuilding), or else their first
    /// selectable structure. Ids in actor order.
    pub fn base_actors(&self, player: u8) -> Vec<u32> {
        let w = &self.world;
        if player as usize >= w.players.len() {
            return Vec::new();
        }
        let bases: Vec<u32> = (0..w.actors.len())
            .filter(|&i| {
                let a = &w.actors[i];
                a.alive && a.owner == player && a.in_world() && w.rules.actors[a.ty as usize].base_building
            })
            .map(|i| w.make_ref(i))
            .collect();
        if !bases.is_empty() {
            return bases;
        }
        (0..w.actors.len())
            .find(|&i| {
                let a = &w.actors[i];
                a.alive && a.owner == player && a.kind == Kind::Building && !w.rules.actors[a.ty as usize].is_wall()
            })
            .map(|i| vec![w.make_ref(i)])
            .unwrap_or_default()
    }

    /// The player's harvesters on the map (OpenRA CycleHarvestersHotkeyLogic), in actor order.
    pub fn harvesters(&self, player: u8) -> Vec<u32> {
        let w = &self.world;
        (0..w.actors.len())
            .filter(|&i| w.actors[i].alive && w.actors[i].owner == player && w.actors[i].in_world() && w.is_harvester(i))
            .map(|i| w.make_ref(i))
            .collect()
    }

    /// The player's production structures other than Construction Yards
    /// (OpenRA CycleProductionActorsHotkeyLogic), ordered by what they produce
    /// first, then actor order.
    pub fn production_buildings(&self, player: u8) -> Vec<u32> {
        let w = &self.world;
        let mut list: Vec<(String, usize)> = (0..w.actors.len())
            .filter_map(|i| {
                let a = &w.actors[i];
                let info = &w.rules.actors[a.ty as usize];
                let b = info.building.as_ref()?;
                (a.alive && a.owner == player && a.kind == Kind::Building && !info.base_building && !b.production_types.is_empty())
                    .then(|| (b.production_types[0].clone(), i))
            })
            .collect();
        list.sort();
        list.into_iter().map(|(_, i)| w.make_ref(i)).collect()
    }

    /// The structure that builds what production tab `queue` (rules.rs
    /// QueueType order) makes, or NONE (OpenRA `MostLikelyProducer`; the same
    /// structure new units come out of).
    pub fn queue_producer(&self, player: u8, queue: u8) -> u32 {
        let w = &self.world;
        if queue as usize >= rules::QUEUE_COUNT {
            return NONE;
        }
        let q = QueueType::from_index(queue as usize);
        (0..w.actors.len())
            .find(|&i| {
                let a = &w.actors[i];
                a.alive
                    && a.owner == player
                    && a.kind == Kind::Building
                    && w.rules.actors[a.ty as usize].building.as_ref().is_some_and(|b| b.produces.contains(&q))
            })
            .map_or(NONE, |i| w.make_ref(i))
    }

    /// The player's army by type for the observer's army panel (OpenRA
    /// ObserverArmyIcons): flat `[actor type index, count, ...]`, the units
    /// that count for the army value (observer.rs: no harvesters, no support
    /// aircraft) under their OverrideActor type, buildable types only, in
    /// production tab and palette order (`World::army_counts`).
    pub fn army_counts(&self, player: u8) -> Vec<u32> {
        self.world.army_counts(player).into_iter().flat_map(|(t, n)| [u32::from(t), n]).collect()
    }

    /// Deploy selected MCVs / pack up a selected Construction Yard / unload selected transports.
    pub fn deploy(&mut self, player: u8, ids: Vec<u32>) {
        self.submit(Order::Deploy { player, ids });
    }

    /// 0: cannot deploy, 1: can deploy now, 2: deployable but blocked here,
    /// 3: a production structure the deploy command makes primary (primary.rs).
    /// A loaded transport "deploys" by unloading (2: no free cell to unload onto).
    pub fn deploy_state(&self, player: u8, id: u32) -> u8 {
        let Some(i) = self.world.resolve(id) else { return 0 };
        if self.world.actors[i].owner != player {
            return 0;
        }
        if self.world.can_be_primary(i) {
            return 3;
        }
        if self.world.has_passengers(i) && self.world.can_unload(i) {
            return 1;
        }
        // Helicopters: land here (then unload), or take off again.
        if self.world.actors[i].kind == Kind::Aircraft && self.world.is_helicopter(i) {
            return self.world.heli_deploy_state(i);
        }
        if self.world.has_passengers(i) {
            return 2;
        }
        if self.world.deploy_target(i).is_none() {
            return 0;
        }
        if self.world.can_deploy(i) {
            1
        } else {
            2
        }
    }

    /// Fire a support power (`key` from `player_json().powers`) at a world-pixel
    /// position. The optional second point sets the direction (aircraft fly
    /// from the target toward it). See engine/src/powers.rs.
    pub fn activate_power(&mut self, player: u8, key: &str, x: f32, y: f32, x2: Option<f32>, y2: Option<f32>) {
        self.submit(Order::SupportPower {
            player,
            key: key.chars().take(64).collect(),
            x: to_wu(x),
            y: to_wu(y),
            x2: x2.map(to_wu),
            y2: y2.map(to_wu),
        });
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

    /// Put the first queued `actor` on hold (`paused`) or resume it (OpenRA PauseProduction).
    pub fn pause_production(&mut self, player: u8, actor: &str, paused: bool) {
        if let Some(ty) = self.world.rules.actor_index(actor) {
            self.submit(Order::PauseProduction { player, ty: ty as u16, paused });
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

    /// The support power countdowns of the top-left timer list (OpenRA
    /// SupportPowerTimerWidget, powers.rs `power_timers`) that `viewer` may
    /// see; a negative viewer has no player of its own and sees every timer
    /// a power shows to anyone. `[{ player, key, name, remainingTicks, ready }]`.
    pub fn power_timers_json(&self, viewer: i32) -> String {
        let viewer = u8::try_from(viewer).ok();
        let timers: Vec<_> = self
            .world
            .power_timers(viewer)
            .into_iter()
            .map(|t| json!({"player": t.player, "key": t.key, "name": t.name, "remainingTicks": t.remaining, "ready": t.ready}))
            .collect();
        serde_json::Value::Array(timers).to_string()
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
                        json!({"id": w.rules.actors[it.ty as usize].id, "progress": progress, "done": it.done, "paused": it.paused, "started": it.paid > 0})
                    })
                    .collect::<Vec<_>>()
            })
            .collect();
        // Every item that can be built in this game mode, with what is still
        // missing and its build time with the player's factories (before the
        // low power slowdown: the production tooltip, OpenRA ProductionTooltipLogic).
        let factories = w.factories(player);
        let buildable: Vec<_> = (0..w.rules.actors.len())
            .filter(|&t| !w.rules.actors[t].prerequisites.iter().any(|pr| w.rules.tokens[pr.token as usize] == rules::TOKEN_DISABLED))
            .map(|t| {
                let reqs = w.requirements(player, t as u16);
                json!({
                    "id": w.rules.actors[t].id,
                    "enabled": w.can_produce(player, t as u16),
                    "queue": w.rules.actors[t].queue as usize,
                    "requires": reqs.iter().filter(|r| !r.never).map(|r| &r.label).collect::<Vec<_>>(),
                    "exclusive": reqs.iter().find(|r| r.never).map(|r| &r.label),
                    "buildTicks": w.build_time_with(player, t as u16, w.producer_count_in(&factories, t as u16)),
                    // Buildable.BuildLimit: how many more may be queued (null: no limit).
                    "limitLeft": Some(w.build_limit_left(player, t as u16)).filter(|&n| n != i32::MAX),
                    // ProductionIconOverlayManager: the cameo's overlays ("Veterancy": produced with a level).
                    "overlays": w.production_overlays(player, t as u16),
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
        // Support powers (powers.rs): one entry per power the player has.
        let powers: Vec<_> = w
            .power_instances(player)
            .iter()
            .map(|inst| {
                let info = w.power_info(inst);
                json!({
                    "key": inst.key,
                    "kind": info.kind,
                    "icon": info.icon,
                    "name": info.name,
                    "description": info.description,
                    "progress": (inst.total - inst.remaining) as f32 / inst.total.max(1) as f32,
                    "ready": inst.ready(),
                    "charging": inst.charging,
                    "remainingTicks": inst.remaining,
                })
            })
            .collect();
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
            // The game ended, with or without a winner (gamerules.rs).
            "gameOver": w.game_over,
            // Time limit (gamerules.rs): ticks left and ticks per real second, or null.
            "timeLimit": w.time_limit_ticks().map(|t| json!({"left": (t - w.tick as i64).max(0), "ticksPerSecond": w.ticks_per_real_second()})),
            "won": w.has_won(player),
            "team": p.team,
            "units": units,
            "powers": powers,
            "tick": w.tick,
            "flowFields": w.flow.computed,
            // Debug menu (debug.rs): whether cheats work in this game, and this player's flags.
            "cheats": w.cheats_enabled(),
            "dev": debug::DevFlag::ALL.iter().map(|&f| (f.name().to_string(), serde_json::Value::Bool(p.dev.get(f)))).collect::<serde_json::Map<_, _>>(),
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

    // ---- Debug menu (debug.rs, apps/game/js/debug.js) ------------------------

    /// Whether the game was started with the "Debug menu" (cheats) option.
    pub fn cheats_enabled(&self) -> bool {
        self.world.cheats_enabled()
    }

    /// Cheat: switch a flag (`fast_build`, `build_anywhere`, `unlimited_power`,
    /// `fast_charge`, `disable_shroud`, `all_tech`). An order like any other, so
    /// it goes through lockstep online; the engine ignores it without cheats.
    pub fn dev_flag(&mut self, player: u8, flag: &str, on: bool) {
        if let Some(flag) = debug::DevFlag::from_name(flag) {
            self.submit(Order::DevFlag { player, flag, on });
        }
    }

    /// Cheat: give the player cash (debug::DEV_CASH).
    pub fn dev_give_cash(&mut self, player: u8) {
        self.submit(Order::DevCash { player });
    }

    /// Cheat: destroy the given actors (any owner).
    pub fn dev_kill(&mut self, player: u8, ids: Vec<u32>) {
        self.submit(Order::DevKill { player, ids });
    }

    /// Cheat: one more veterancy level for each of the player's own given units.
    pub fn dev_experience(&mut self, player: u8, ids: Vec<u32>) {
        self.submit(Order::DevExperience { player, ids });
    }

    /// Debug view: `[x0, y0, width, height, flags...]` for the cells under the
    /// world-pixel rectangle; flags are debug::cell bits. Read only.
    pub fn debug_cells(&self, player: u8, x0: f32, y0: f32, x1: f32, y1: f32) -> Vec<i32> {
        let c = |px: f32| (px / PX_PER_CELL).floor() as i32;
        let (x, y, w, h, flags) = self.world.debug_cells(player, c(x0), c(y0), c(x1), c(y1));
        let mut out = vec![x, y, w, h];
        out.extend(flags.into_iter().map(i32::from));
        out
    }

    /// Debug view: the flow field an own moving unit follows, as
    /// `[goal x, goal y, x0, y0, width, height, dir...]` for the cells under the
    /// world-pixel rectangle (dirs: 0..8 clockwise from north, 8 goal, 255 none).
    /// Empty when the unit follows no current field. Read only.
    pub fn debug_flow(&self, player: u8, id: u32, x0: f32, y0: f32, x1: f32, y1: f32) -> Vec<i32> {
        let c = |px: f32| (px / PX_PER_CELL).floor() as i32;
        let Some((goal, x, y, w, h, dirs)) = self.world.debug_flow(player, id, c(x0), c(y0), c(x1), c(y1)) else { return Vec::new() };
        let width = self.world.map.width as u32;
        let mut out = vec![(goal % width) as i32, (goal / width) as i32, x, y, w, h];
        out.extend(dirs.into_iter().map(i32::from));
        out
    }

    /// Debug view: actors visible to `player` inside the world-pixel rectangle,
    /// with ids, health, footprints, weapon ranges and targets (JSON, world
    /// pixels). Read only.
    pub fn debug_actors(&self, player: u8, x0: f32, y0: f32, x1: f32, y1: f32) -> String {
        let w = &self.world;
        let px = |wu: i32| wu as f32 * PX_PER_CELL / math::CELL as f32;
        let margin = 4.0 * PX_PER_CELL;
        let inside = |x: f32, y: f32| x >= x0 - margin && x <= x1 + margin && y >= y0 - margin && y <= y1 + margin;
        let seen = |i: usize| w.is_visible_to(i, player) && !w.is_cloaked_from(i, player);
        let mut out = Vec::new();
        for i in 0..w.actors.len() {
            let a = &w.actors[i];
            if !a.alive || !a.in_world() || (player as usize) >= w.players.len() || !seen(i) {
                continue;
            }
            let (x, y) = (px(a.x), px(a.y));
            if !inside(x, y) {
                continue;
            }
            let info = &w.rules.actors[a.ty as usize];
            let weapons: Vec<_> = info
                .weapons
                .iter()
                .map(|&k| json!({"name": w.rules.weapons[k].name, "range": px(w.rules.weapons[k].range), "minRange": px(w.rules.weapons[k].min_range)}))
                .collect();
            let target = w.resolve(a.target).filter(|&t| seen(t)).map(|t| json!([px(w.actors[t].x), px(w.actors[t].y)]));
            let building = info.building.as_ref().map(|b| json!({"cx": a.cx, "cy": a.cy, "w": b.width, "h": b.height}));
            let own = a.owner == player;
            out.push(json!({
                "id": w.make_ref(i),
                "index": i,
                "type": info.id,
                "owner": a.owner,
                "x": x,
                "y": y,
                "altitude": px(a.altitude),
                "hp": a.hp,
                "maxHp": info.hp,
                "radius": info.unit.as_ref().map_or(0.0, |u| px(u.radius)),
                "sight": px(info.sight),
                "building": building,
                "weapons": weapons,
                "target": target,
                // Orders of other players stay private.
                "activity": if own { format!("{:?}", a.activity) } else { String::new() },
                "goal": if own && a.goal != NONE && a.activity != world::Activity::Idle {
                    json!([(a.goal % w.map.width as u32) as i32, (a.goal / w.map.width as u32) as i32])
                } else {
                    serde_json::Value::Null
                },
            }));
        }
        serde_json::Value::Array(out).to_string()
    }

    /// Debug view: simulation counters for the performance panel (JSON).
    pub fn debug_stats(&self) -> String {
        self.world.debug_stats().to_string()
    }
}

impl World {
    pub fn new_stress(seed: u64, units: u32, map_size: i32) -> World {
        let rules = rules::Rules::load();
        // Open land: the stress test measures crowds of units, not river crossings.
        let map = map::Map::generate_styled(map_size, map_size, seed, rules.player.ore_max_density, 2, mapgen::MapStyle::Land);
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

/// Lobby options of `from_options` and `from_map`; errors are plain text
/// (wasm callers turn them into a JsError, native tests read them).
fn parse_options(json: &str) -> Result<ParsedOptions, String> {
    let v: serde_json::Value = serde_json::from_str(json).map_err(|e| format!("bad options: {e}"))?;
    let rules = rules::Rules::load();
    let num = |k: &str, d: i64| v.get(k).and_then(|x| x.as_i64()).unwrap_or(d);
    let flag = |k: &str, d: bool| v.get(k).and_then(|x| x.as_bool()).unwrap_or(d);
    let text = |k: &str, d: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or(d).to_string();
    // Newer options: absent means the default, anything else must be a known name.
    let name = |k: &str, d: &str| -> Result<String, String> {
        match v.get(k) {
            None => Ok(d.to_string()),
            Some(serde_json::Value::String(s)) => Ok(s.chars().take(24).collect()),
            Some(_) => Err(format!("options.{k} must be a string")),
        }
    };
    let mut players = Vec::new();
    for p in v.get("players").and_then(|p| p.as_array()).ok_or_else(|| "options.players missing".to_string())? {
        let kind = p.get("type").and_then(|t| t.as_str()).unwrap_or("human");
        if kind == "closed" || kind == "open" {
            continue;
        }
        let faction = p.get("faction").and_then(|f| f.as_str()).unwrap_or("allies").to_string();
        if rules.faction_index(&faction).is_none() {
            return Err(format!("unknown faction {}", faction.chars().take(24).collect::<String>()));
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
        // OpenRA handicap: 0 to 95 percent in steps of 5 (gamerules.rs).
        let handicap = match p.get("handicap") {
            None => 0,
            Some(h) => h
                .as_u64()
                .filter(|&h| h <= gamerules::MAX_HANDICAP as u64 && h % gamerules::HANDICAP_STEP as u64 == 0)
                .ok_or_else(|| "players[].handicap must be 0 to 95 in steps of 5".to_string())? as u8,
        };
        // The OpenRA bot an AI slot plays (ai_bots.rs). Absent (lobbies and
        // saves from before bot types): the Normal AI.
        let bot = match p.get("bot") {
            None => ai_bots::BotType::Normal,
            Some(b) => b
                .as_str()
                .and_then(ai_bots::BotType::from_name)
                .ok_or_else(|| "players[].bot must be rush, normal, turtle or naval".to_string())?,
        };
        // The spawn picked in the lobby (0-based); absent or null: automatic
        // (gamerules.rs `assign_spawns`; games from before spawn picks).
        let spawn = match p.get("spawn") {
            None | Some(serde_json::Value::Null) => None,
            Some(s) => Some(
                s.as_u64()
                    .filter(|&s| s < crate::world::EDITOR_SLOTS as u64)
                    .ok_or_else(|| "players[].spawn must be a spawn index (0 to 7) or null".to_string())? as u8,
            ),
        };
        players.push(PlayerSetup { faction, ai, bot, team, handicap, spawn });
    }
    if !(2..=8).contains(&players.len()) {
        return Err("a game needs 2 to 8 players".to_string());
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
        // Optional for older callers (tools, tests); a value that is present must be known.
        map_style: parse_style_text(&name("mapStyle", "random")?)?,
        biome: parse_biome_text(&name("biome", "temperate")?)?,
        weather: weather::WeatherMode::from_name(&name("weather", "full")?)
            .ok_or_else(|| "options.weather must be full, cosmetic or off".to_string())?,
        cheats: flag("cheats", false),
        tech_buildings: parse_tech_buildings_text(&name("techBuildings", "standard")?)?,
        reusable_engineers: flag("reusableEngineers", false),
        // Lobby options of OpenRA's world and player rules (gamerules.rs,
        // crates.rs); absent keys (older callers) take OpenRA's defaults.
        crates: flag("crates", true),
        short_game: flag("shortGame", true),
        time_limit: {
            let t = num("timeLimit", rules.world.time_limit.default as i64);
            if !rules.world.time_limit.options.iter().any(|&o| o as i64 == t) {
                return Err("options.timeLimit is not one of the time limits".to_string());
            }
            t as i32
        },
        tick_ms: match name("gameSpeed", "normal")?.as_str() {
            "slowest" => 80,
            "slower" => 50,
            "fast" => 35,
            "faster" => 30,
            "fastest" => 20,
            _ => 40,
        },
        bounty: flag("bounty", false),
        separate_team_spawns: flag("separateTeamSpawns", true),
        ally_build_radius: flag("allyBuildRadius", true),
        // Absent in games from before the option (saves, replays): they
        // were played with WebRA's soft crowd separation and replay with it.
        movement: movement::MovementModel::from_name(&name("movement", "webra")?)
            .ok_or_else(|| "options.movement must be openra or webra".to_string())?,
    };
    Ok(ParsedOptions { seed: num("seed", 1).max(0) as u64, map_size: (num("mapSize", 96) as i32).clamp(48, 512), players, options })
}

fn parse_tech_buildings(s: &str) -> Result<mapgen::settlements::TechBuildings, JsError> {
    parse_tech_buildings_text(s).map_err(|e| JsError::new(&e))
}

fn parse_tech_buildings_text(s: &str) -> Result<mapgen::settlements::TechBuildings, String> {
    mapgen::settlements::TechBuildings::from_name(s)
        .ok_or_else(|| "tech buildings must be none, standard, extra, oilonly or oilrush".to_string())
}

fn parse_style(s: &str) -> Result<mapgen::MapStyle, JsError> {
    parse_style_text(s).map_err(|e| JsError::new(&e))
}

fn parse_style_text(s: &str) -> Result<mapgen::MapStyle, String> {
    mapgen::MapStyle::from_name(s).ok_or_else(|| "map style must be random, land, rivers, lakes or islands".to_string())
}

/// A biome name, or None for "random".
fn parse_biome(s: &str) -> Result<Option<weather::Biome>, JsError> {
    parse_biome_text(s).map_err(|e| JsError::new(&e))
}

fn parse_biome_text(s: &str) -> Result<Option<weather::Biome>, String> {
    if s == "random" {
        return Ok(None);
    }
    weather::Biome::from_name(s).map(Some).ok_or_else(|| "biome must be random, temperate, snow or desert".to_string())
}

pub(crate) fn preview_rgba(m: &map::Map, biome: weather::Biome) -> Vec<u8> {
    let mut out = Vec::with_capacity(m.cells() * 4);
    for i in 0..m.cells() {
        let rgb = if m.gems[i] > 0 {
            [190, 70, 150]
        } else if m.ore[i] > 0 {
            [200, 160, 50]
        } else {
            weather::preview_color(biome, m.terrain[i])
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
            self.world.queue_player_order(o);
        }
    }
}

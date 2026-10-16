//! A world for a mission: its players with their relations, its map actors,
//! and the scripts loaded and started (OpenRA's World.LoadComplete:
//! map actors spawned, then the scripts run, then `WorldLoaded`).

use super::data::MissionData;
use super::{api, HState, Limbo, Mission, MissionPlayer, MissionResult, WinState, LOAD_BUDGET};
use crate::lua::Lua;
use crate::math::{CELL, HALF_CELL};
use crate::rules::{Kind, Rules, Stance, TECH_LEVELS};
use crate::world::{AiDifficulty, GameOptions, World};
use std::collections::BTreeMap;
use std::sync::Arc;

/// OpenRA MapGrid SubCellOffsets of a rectangular grid (index 0 is the whole cell).
const SUBCELL_OFFSETS: [(i32, i32); 6] = [(0, 0), (-299, -256), (256, -256), (0, 0), (-299, 256), (256, 256)];

/// Diplomacy values of `World::diplomacy` (the stance of one player toward another).
pub const NEUTRAL: u8 = 0;
pub const ALLY: u8 = 1;
pub const ENEMY: u8 = 2;

/// The choices a mission starts with: lobby options (`difficulty`) by id.
#[derive(Clone, Debug)]
pub struct MissionOptions {
    pub options: BTreeMap<String, String>,
    /// The mission's playable players taken by people, in engine order
    /// (player 0, 1, ...): one for the campaign, several for a co-op
    /// mission online. Empty: the mission's first playable player.
    pub humans: Vec<String>,
    /// The engine player this screen belongs to (`IsLocalPlayer`, the UI's
    /// messages and camera). Presentation only: never part of the state hash.
    pub local_player: u8,
    /// How units move among each other (movement/). Missions started now
    /// play OpenRA's; saves and replays from before the option keep WebRA's.
    pub movement: crate::movement::MovementModel,
    /// What a production queue does without a structure of its type
    /// (production.rs). Missions started now play OpenRA's; saves and
    /// replays from before the option keep WebRA's.
    pub factory_loss: crate::world::FactoryLoss,
}

impl Default for MissionOptions {
    fn default() -> Self {
        MissionOptions {
            options: BTreeMap::new(),
            humans: Vec::new(),
            local_player: 0,
            movement: crate::movement::MovementModel::OpenRA,
            factory_loss: crate::world::FactoryLoss::OpenRA,
        }
    }
}

pub(crate) fn stance_of(name: &str) -> Option<Stance> {
    match name.to_ascii_lowercase().as_str() {
        "holdfire" | "hold_fire" => Some(Stance::HoldFire),
        "returnfire" | "return_fire" => Some(Stance::ReturnFire),
        "defend" => Some(Stance::Defend),
        "attackanything" | "attack_anything" => Some(Stance::AttackAnything),
        _ => None,
    }
}

/// OpenRA WAngle (counter-clockwise) to an engine facing (clockwise), and back.
pub(crate) fn facing_in(w: i32) -> i32 {
    (1024 - w.rem_euclid(1024)) % 1024
}

pub(crate) fn facing_out(f: i32) -> i32 {
    (1024 - f.rem_euclid(1024)) % 1024
}

pub(crate) fn parse_hex(s: &str) -> u32 {
    super::parse_color(s).unwrap_or(0xffff_ffff)
}

impl World {
    /// A world playing `data` (a mission file). The scripts are loaded and
    /// `WorldLoaded` runs before this returns; a script error does not fail
    /// the call, it ends the mission (see `Mission::error`).
    pub fn from_mission(data: MissionData, seed: u64, chosen: &MissionOptions) -> Result<World, String> {
        let mut rules = Rules::load_mission(&data.rules)?;
        // What script props provide (OpenRA ProvidesPrerequisite): tokens for
        // prerequisites only scripts ask for too (`Player.HasPrerequisites`).
        for p in data.props.values() {
            for t in &p.provides {
                rules.intern_token(t);
            }
        }
        let map = data.map.to_map()?;
        let data = Arc::new(data);
        // The people playing come first (one in the campaign, the co-op
        // players online), the other players follow in the mission's order.
        // Playable slots nobody took stay empty, like unoccupied slots in
        // OpenRA: their scripts check for nil.
        let humans: Vec<usize> = if chosen.humans.is_empty() {
            vec![data.human()]
        } else {
            let mut out = Vec::new();
            for name in &chosen.humans {
                let i = data
                    .players
                    .iter()
                    .position(|p| p.playable && &p.name == name)
                    .ok_or_else(|| format!("{name} is not a playable player of this mission"))?;
                if out.contains(&i) {
                    return Err(format!("{name} is taken twice"));
                }
                out.push(i);
            }
            out
        };
        if chosen.local_player as usize >= humans.len() {
            return Err("the local player must be one of the people playing".into());
        }
        let mut order = humans.clone();
        order.extend((0..data.players.len()).filter(|&i| !data.players[i].playable));
        let tech = TECH_LEVELS.iter().position(|t| *t == data.tech_level).unwrap_or(TECH_LEVELS.len() - 1);
        let options = GameOptions {
            starting_cash: data.starting_cash,
            starting_units: crate::world::StartingUnits::Mcv,
            tech_level: tech,
            fog: true,
            explored: false,
            build_radius: true,
            // Campaign rules: no ally build radius, no reusable engineers, no
            // bounties, no crates, no short game; MCVs undeploy.
            ally_build_radius: false,
            redeployable_mcv: true,
            ore_regrowth: true,
            map_style: crate::mapgen::MapStyle::Random,
            biome: Some(data.map.biome),
            weather: crate::weather::WeatherMode::Off,
            cheats: false,
            reusable_engineers: false,
            crates: false,
            short_game: false,
            time_limit: 0,
            tick_ms: 40,
            bounty: false,
            separate_team_spawns: false,
            tech_buildings: crate::mapgen::settlements::TechBuildings::None,
            movement: chosen.movement,
            factory_loss: chosen.factory_loss,
        };
        let mut w = World::empty(rules, map, seed);
        w.options = options.clone();
        w.env = crate::weather::Environment::new(data.map.biome, options.weather, seed);
        let mut players = Vec::new();
        for &pi in &order {
            let p = &data.players[pi];
            let fi = w.rules.faction_index(&p.faction).or_else(|| w.rules.faction_index("allies")).expect("allies faction");
            let bot = !humans.contains(&pi);
            w.add_player(fi, bot, (0, 0));
            let slot = w.players.len() - 1;
            w.players[slot].cash = data.starting_cash;
            w.players[slot].neutral = p.owns_world;
            players.push(MissionPlayer {
                name: p.name.clone(),
                color: parse_hex(&p.color),
                playable: !bot,
                non_combatant: p.non_combatant || p.owns_world,
                bot,
                objectives: Vec::new(),
                win: WinState::Undefined,
                coop: WinState::Undefined,
                conditions: Vec::new(),
                ai_enabled: false,
            });
        }
        // Relations as each player's reference states them (OpenRA PlayerReference
        // Allies and Enemies; everyone else is neutral).
        let n = players.len();
        let mut diplomacy = vec![NEUTRAL; n * n];
        for (a, &pa) in order.iter().enumerate() {
            let p = &data.players[pa];
            for (b, &pb) in order.iter().enumerate() {
                let other = &data.players[pb].name;
                diplomacy[a * n + b] = if a == b || p.allies.contains(other) {
                    ALLY
                } else if p.enemies.contains(other) {
                    ENEMY
                } else {
                    NEUTRAL
                };
            }
        }
        w.diplomacy = diplomacy;
        // The players a script hands to its bot (conditions.rs, `ai_enabled`)
        // play OpenRA's campaign bot: the mission's own bot modules.
        w.ai = (0..n)
            .map(|slot| crate::ai::AiState::new(&w.rules, slot as u8, crate::ai_bots::BotType::Campaign, AiDifficulty::Normal))
            .collect();
        for a in w.ai.iter_mut() {
            a.salt = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15).wrapping_add(1);
        }
        w.crates = crate::crates::CrateState::new(&w.rules, false);

        let mut m = Mission {
            id: data.id.clone(),
            lua: None,
            data: data.clone(),
            handles: Vec::new(),
            handle_of: BTreeMap::new(),
            gone_of: BTreeMap::new(),
            named: Vec::new(),
            players,
            origin: (data.origin[0], data.origin[1]),
            triggers: Default::default(),
            queues: BTreeMap::new(),
            delayed: Vec::new(),
            spawns: Vec::new(),
            builds: Vec::new(),
            seq: 0,
            options: BTreeMap::new(),
            time_limit: Default::default(),
            camera: None,
            mission_text: None,
            ui: Vec::new(),
            error: None,
            unplaced: Vec::new(),
            result: MissionResult::Playing,
            game_over_at: None,
            next_token: 1,
            discovered: BTreeMap::new(),
            low_power_quiet: Default::default(),
            player_actors: BTreeMap::new(),
            conditions: BTreeMap::new(),
            surrenders: Vec::new(),
            humans: humans.len(),
            local_player: chosen.local_player,
        };
        for id in data.options.keys() {
            if let Some(v) = data.option_value(id, &chosen.options) {
                m.options.insert(id.clone(), v.to_string());
            }
        }
        // One relabelling of the cells for all map actors (world.rs `placing_map_actors`).
        w.placing_map_actors = true;
        w.spawn_map_actors(&mut m);
        // Bridges take their state from the terrain, trees of tree terrain become actors (neutral.rs).
        w.setup_neutral();
        w.placing_map_actors = false;
        // A mission before the first token refresh: no `global-skirmish` (production.rs).
        w.mission_on = true;
        w.refresh_tokens();
        w.update_power();
        w.update_vision();

        // The scripts: OpenRA's sandbox, the API globals, the map actors as
        // globals, every script file in order, then WorldLoaded.
        let mut lua = Lua::new();
        api::install(&mut lua);
        for (name, h) in m.named.clone() {
            lua.set_global(&name, api::actor_value(h));
        }
        lua.set_budget(LOAD_BUDGET);
        {
            let mut ctx = api::Ctx { w: &mut w, m: &mut m };
            ctx.load_scripts(&mut lua);
        }
        m.lua = Some(lua);
        w.mission = Some(Box::new(m));
        Ok(w)
    }

    /// Spawn the mission's map actors and give each a handle (OpenRA SpawnMapActors).
    fn spawn_map_actors(&mut self, m: &mut Mission) {
        let data = m.data.clone();
        for a in &data.actors {
            let Some(owner) = m.player_slot(&a.owner).or_else(|| m.players.iter().position(|p| p.non_combatant).map(|p| p as u8)) else {
                continue;
            };
            let (cx, cy) = m.cell_in(a.x, a.y);
            let ty = a.ty.as_str();
            let h = if ty == "waypoint" || ty == "mpspawn" {
                m.new_handle(ty.to_string(), owner, HState::Marker { x: cx * CELL + HALF_CELL, y: cy * CELL + HALF_CELL })
            } else if let Some(p) = data.props.get(ty) {
                let state = HState::Prop {
                    x: cx * CELL + HALF_CELL,
                    y: cy * CELL + HALF_CELL,
                    reveal: p.reveal,
                    image: p.image.clone(),
                    alive: true,
                };
                m.new_handle(ty.to_string(), owner, state)
            } else if let Some(t) = self.rules.actor_index(ty) {
                let info = self.rules.actors[t].clone();
                let facing = super::setup::facing_in(a.facing.unwrap_or(0));
                let i = match info.kind {
                    Kind::Proxy => None,
                    Kind::Building => self.spawn_building_with(t as u16, owner, cx, cy, a.free_actor.unwrap_or(true), true),
                    Kind::Crate => {
                        if !self.map.contains(cx, cy) || self.crate_at(self.map.idx(cx, cy)).is_some() {
                            None
                        } else {
                            Some(self.place_crate(t, owner, cx, cy, 0))
                        }
                    }
                    Kind::Husk => {
                        if !self.map.contains(cx, cy) {
                            None
                        } else {
                            Some(self.place_husk(t, owner, cx * CELL + HALF_CELL, cy * CELL + HALF_CELL, facing, 0))
                        }
                    }
                    _ => match self.map_unit_cell(t, cx, cy) {
                        None => None,
                        Some((x, y)) => {
                            let (ox, oy) = match (info.kind, a.subcell) {
                                (Kind::Infantry, Some(s)) if (x, y) == (cx, cy) => {
                                    SUBCELL_OFFSETS.get(s as usize).copied().unwrap_or((0, 0))
                                }
                                _ => (0, 0),
                            };
                            let u = self.spawn_unit(t as u16, owner, x * CELL + HALF_CELL + ox, y * CELL + HALF_CELL + oy, facing);
                            self.place_map_aircraft(u);
                            Some(u)
                        }
                    },
                };
                match i {
                    Some(i) => {
                        let r = self.make_ref(i);
                        if let Some(pct) = a.health {
                            let max = self.rules.actors[t].hp as i64;
                            self.actors[i].hp = ((max * pct.clamp(1, 100) as i64) / 100).max(1) as i32;
                        }
                        if let Some(s) = a.stance.as_deref().and_then(stance_of) {
                            self.actors[i].stance = s;
                        }
                        if let Some(tf) = a.turret_facing {
                            let f = facing_in(tf);
                            self.actors[i].turret = f;
                            self.actors[i].pturret = f;
                        }
                        if let Some(fi) = a.faction.as_deref().and_then(|f| self.rules.faction_index(f)) {
                            self.actors[i].faction = fi as u8;
                        }
                        m.new_handle(self.rules.actors[t].id.clone(), owner, HState::Live(r))
                    }
                    None if info.kind == Kind::Proxy => {
                        let limbo = Limbo {
                            x: cx * CELL + HALF_CELL,
                            y: cy * CELL + HALF_CELL,
                            altitude: None,
                            facing,
                            health: None,
                            stance: None,
                        };
                        m.new_handle(self.rules.actors[t].id.clone(), owner, HState::Limbo(limbo))
                    }
                    // A structure beyond the playable area (it does not fit the cropped map).
                    None if info.kind == Kind::Building => {
                        let faction =
                            a.faction.as_deref().and_then(|f| self.rules.faction_index(f)).unwrap_or(self.players[owner as usize].faction);
                        self.offmap.push(super::OffMapStructure { owner, ty: t as u16, faction: faction as u8 });
                        continue;
                    }
                    None => {
                        m.unplaced.push((a.name.clone(), a.ty.clone(), format!("does not fit at {},{}", a.x, a.y)));
                        continue;
                    }
                }
            } else {
                m.unplaced.push((a.name.clone(), a.ty.clone(), "unknown type".into()));
                continue;
            };
            m.handles[h as usize].tags = a.tags.clone();
            // Bridges of the map's templates have no name (OpenRA LegacyBridgeLayer).
            if !a.name.is_empty() {
                m.named.push((a.name.clone(), h));
            }
        }
    }

    /// A map aircraft stands landed (OpenRA spawns map actors at ground level):
    /// on its owner's airfield or helipad under it, else on the spot.
    fn place_map_aircraft(&mut self, u: usize) {
        if self.actors[u].kind != crate::rules::Kind::Aircraft {
            return;
        }
        let ci = self.cell_index(self.actors[u].x, self.actors[u].y);
        let base = self.building_at[ci];
        if base != crate::world::NONE && self.actors[base as usize].owner == self.actors[u].owner {
            let b = base as usize;
            if self.is_plane(u) {
                self.plane_produced(u, b);
            } else {
                self.heli_produced(u, b);
            }
            return;
        }
        if !self.is_plane(u) {
            self.actors[u].altitude = 0;
            self.actors[u].heli.landed = true;
        }
    }

    /// Map cell and its subcell offset for scripts (OpenRA DefaultSubCell is the center).
    pub(crate) fn mission_subcell_offset(s: i32) -> (i32, i32) {
        SUBCELL_OFFSETS.get(s as usize).copied().unwrap_or((0, 0))
    }
}

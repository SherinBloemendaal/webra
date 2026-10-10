//! Map files (`.webra-map.json`, formats 1 and 2; see docs/contracts.md section 2).
//!
//! Format 2 is format 1 plus a `gems` layer; format 1 maps have no gems.
//! Map format version 2 adds the game setup (`players`, `options`,
//! `lockedOptions`, `tags`, and the state of pre-placed actors).
//! The canonical form is the JSON serialization of [`MapData`] with fields in
//! declaration order (`gems` left out when absent), keys inside `rules`
//! sorted (serde_json's default map), and no whitespace. Its SHA-256 (hex) is
//! the map's identity, shared with the game client, the editor and the server.
//!
//! Map format versions ("Map versions" in the contract): the engine reads
//! exactly [`FORMAT_VERSION`]. Older maps are upgraded before they get here,
//! by the one migration chain in packages/protocol (mapversions.js) that the
//! game, the editor, the server and the tools share; anything else is refused
//! when the JSON is read, whichever path reads it (map files and the maps
//! inside mission files).

use crate::map::{Map, Terrain, GEM_MAX_DENSITY, ORE_MAX_DENSITY};
use crate::rules::Rules;
use crate::weather::Biome;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// The map format version this engine reads (packages/protocol mapversions.js
/// MAP_FORMAT_VERSION; a protocol test keeps them equal). A file without
/// `formatVersion` is version 1.
pub const FORMAT_VERSION: u32 = 2;
/// The format without gems; still read, and written when a map has no gems.
pub const FORMAT_ORE_ONLY: u32 = 1;
/// The current format: format 1 plus the `gems` layer.
pub const FORMAT: u32 = 2;
pub const MAX_BYTES: usize = 1024 * 1024;
pub const MIN_SIZE: i32 = 32;
pub const MAX_SIZE: i32 = 256;
pub const MAX_ACTORS: usize = 2000;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct MapData {
    /// Always [`FORMAT_VERSION`]: reading any other version fails. Left out
    /// of the canonical form at version 1, so maps from before versions keep
    /// their identity (a later version is part of it).
    #[serde(
        rename = "formatVersion",
        default = "baseline_version",
        deserialize_with = "current_version",
        skip_serializing_if = "is_baseline_version"
    )]
    pub format_version: u32,
    /// The release that wrote the file: provenance only, never part of the
    /// canonical form or the hash.
    #[serde(rename = "gameVersion", default, deserialize_with = "game_version", skip_serializing)]
    pub game_version: Option<String>,
    pub format: u32,
    pub name: String,
    pub author: String,
    #[serde(default)]
    pub description: String,
    pub width: i32,
    pub height: i32,
    /// base64, width * height bytes (Terrain values).
    pub terrain: String,
    /// base64, width * height bytes (ore density 0..=12).
    pub ore: String,
    /// base64, width * height bytes (gem density 0..=3). Format 2 only; a
    /// cell holds ore or gems, never both.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gems: Option<String>,
    pub spawns: Vec<[i32; 2]>,
    #[serde(default)]
    pub actors: Vec<MapActor>,
    #[serde(default)]
    pub rules: Option<serde_json::Value>,
    /// Terrain palette and weather (weather.rs). Optional: absent means
    /// temperate, and a temperate map leaves it out of the canonical form,
    /// so maps from before biomes keep their hash. Not a rules override: a
    /// map with a biome is not modded.
    #[serde(default, skip_serializing_if = "Biome::is_temperate")]
    pub biome: Biome,
    /// The game setup (format version 2, packages/protocol mapsetup.js): the
    /// player slots, the lobby options the map starts with and the ones it
    /// locks, and its tags. Always in the canonical form, defaults filled in.
    #[serde(default)]
    pub players: Vec<MapSlot>,
    /// Lobby options (camelCase names and values as in the options JSON);
    /// keys sorted in the canonical form (serde_json's default map).
    #[serde(default)]
    pub options: serde_json::Map<String, serde_json::Value>,
    #[serde(rename = "lockedOptions", default)]
    pub locked_options: Vec<String>,
    #[serde(default)]
    pub tags: Vec<String>,
}

/// A player slot of a map (OpenRA MapPlayers): what it holds when the map is
/// loaded and which parts the lobby may not change. Lobbies apply it; the
/// engine checks it is well formed.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct MapSlot {
    #[serde(default = "random_faction")]
    pub faction: String,
    #[serde(default)]
    pub team: i32,
    #[serde(default = "no_color")]
    pub color: i32,
    #[serde(rename = "type", default = "open_slot")]
    pub ty: String,
    #[serde(default = "normal")]
    pub difficulty: String,
    #[serde(default = "normal")]
    pub bot: String,
    #[serde(default)]
    pub lock: Vec<String>,
}

impl Default for MapSlot {
    fn default() -> Self {
        MapSlot {
            faction: random_faction(),
            team: 0,
            color: no_color(),
            ty: open_slot(),
            difficulty: normal(),
            bot: normal(),
            lock: Vec::new(),
        }
    }
}

/// An optional text field that, when present, must be a string (null is
/// refused, as by the protocol; leave the field out for its default).
fn present_string<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    String::deserialize(d).map(Some)
}

fn random_faction() -> String {
    "random".into()
}
fn no_color() -> i32 {
    -1
}
fn open_slot() -> String {
    "open".into()
}
fn normal() -> String {
    "normal".into()
}
fn full_health() -> i32 {
    100
}
fn is_full_health(v: &i32) -> bool {
    *v == 100
}
fn is_zero(v: &i32) -> bool {
    *v == 0
}

/// Lobby options a map may set and lock, with their values (packages/protocol
/// mapsetup.js MAP_OPTION_VALUES; a game test checks them against it).
pub const MAP_OPTIONS: &[(&str, &[&str])] = &[
    ("weather", &["full", "cosmetic", "off"]),
    ("startingCash", &["2500", "5000", "7500", "10000", "20000"]),
    ("startingUnits", &["mcv", "light", "heavy", "base"]),
    ("techLevel", &["infonly", "low", "medium", "high", "unrestricted"]),
    ("gameSpeed", &["slowest", "slower", "normal", "fast", "faster", "fastest"]),
    ("timeLimit", &["0", "10", "20", "30", "40", "60", "90"]),
    ("fog", BOOL),
    ("explored", BOOL),
    ("buildRadius", BOOL),
    ("redeployableMcv", BOOL),
    ("oreRegrowth", BOOL),
    ("cheats", BOOL),
    ("crates", BOOL),
    ("shortGame", BOOL),
    ("bounty", BOOL),
    ("separateTeamSpawns", BOOL),
    ("allyBuildRadius", BOOL),
    ("reusableEngineers", BOOL),
];
const BOOL: &[&str] = &["true", "false"];
/// Slot values (protocol constants FACTIONS, MAP_SLOT_TYPES, DIFFICULTIES, BOTS, MAP_SLOT_LOCKS).
const SLOT_FACTIONS: &[&str] = &["random", "randomallies", "randomsoviet", "england", "france", "germany", "russia", "ukraine"];
const SLOT_TYPES: &[&str] = &["open", "ai", "closed"];
const SLOT_DIFFICULTIES: &[&str] = &["easy", "normal", "hard"];
const SLOT_BOTS: &[&str] = &["rush", "normal", "turtle", "naval"];
const SLOT_LOCKS: &[&str] = &["faction", "team", "color", "type"];
pub const TAGS_MAX: usize = 8;
pub const TAG_MAX: usize = 24;
pub const CARGO_MAX: usize = 16;
pub const VETERANCY_MAX: i32 = 4;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct MapActor {
    #[serde(rename = "type")]
    pub ty: String,
    /// Spawn index, or -1 for neutral.
    pub owner: i32,
    pub x: i32,
    pub y: i32,
    #[serde(default)]
    pub facing: i32,
    /// Health in percent, 1 to 100 (format version 2; 100 left out of the canonical form).
    #[serde(default = "full_health", skip_serializing_if = "is_full_health")]
    pub health: i32,
    /// Fire stance (`hold_fire`, `return_fire`, `defend`, `attack_anything`);
    /// absent: the actor's own default.
    #[serde(default, deserialize_with = "present_string", skip_serializing_if = "Option::is_none")]
    pub stance: Option<String>,
    /// Veterancy level, 0 to the actor's levels.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub veterancy: i32,
    /// Passengers (actor types) inside a transport.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cargo: Vec<String>,
}

impl MapActor {
    /// An actor with the default state (full health, its own stance, no levels, no passengers).
    pub fn new(ty: &str, owner: i32, x: i32, y: i32, facing: i32) -> MapActor {
        MapActor { ty: ty.into(), owner, x, y, facing, health: 100, stance: None, veterancy: 0, cargo: Vec::new() }
    }
}

#[derive(Serialize, Debug)]
pub struct Validation {
    pub ok: bool,
    pub errors: Vec<String>,
    pub modded: bool,
    pub hash: Option<String>,
}

fn baseline_version() -> u32 {
    1
}

fn is_baseline_version(v: &u32) -> bool {
    *v == 1
}

/// `formatVersion` must be the one this engine reads; the protocol package upgrades older maps first.
fn current_version<'de, D: serde::Deserializer<'de>>(d: D) -> Result<u32, D::Error> {
    let v = u32::deserialize(d)?;
    match v {
        FORMAT_VERSION => Ok(v),
        0 => Err(serde::de::Error::custom("formatVersion must be 1 or more")),
        v if v > FORMAT_VERSION => Err(serde::de::Error::custom(format!(
            "this map is in map format {v}, made by a newer version of WebRA; this engine reads format {FORMAT_VERSION}"
        ))),
        v => Err(serde::de::Error::custom(format!(
            "this map is in map format {v}; it must be upgraded to format {FORMAT_VERSION} before the engine reads it"
        ))),
    }
}

/// `gameVersion`: 1 to 32 of `0-9 A-Z a-z . + -` (protocol GAME_VERSION_RE); null counts as absent.
fn game_version<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    let v = Option::<String>::deserialize(d)?;
    if let Some(s) = &v {
        let ok = (1..=32).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'+' || b == b'-');
        if !ok {
            return Err(serde::de::Error::custom("gameVersion must be a version such as 0.9.0"));
        }
    }
    Ok(v)
}

fn b64() -> base64::engine::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

impl MapData {
    pub fn parse(json: &str) -> Result<MapData, String> {
        if json.len() > MAX_BYTES {
            return Err(format!("map is larger than {} bytes", MAX_BYTES));
        }
        let d: MapData = serde_json::from_str(json).map_err(|e| format!("invalid map JSON: {}", short(&e.to_string())))?;
        // A file without `formatVersion` is format 1 (the default, which serde does not check).
        if d.format_version != FORMAT_VERSION {
            return Err(format!(
                "invalid map JSON: this map is in map format {}; it must be upgraded to format {FORMAT_VERSION} before the engine reads it",
                d.format_version
            ));
        }
        Ok(d)
    }

    pub fn canonical_json(&self) -> String {
        serde_json::to_string(self).expect("map serializes")
    }

    /// The map as a file WebRA writes (the generator's output): the canonical
    /// form with `formatVersion` and `gameVersion` (this release) in front.
    /// The same bytes as packages/protocol `mapFileJson`; the same identity
    /// as the canonical form.
    pub fn file_json(&self) -> String {
        let canonical = self.canonical_json();
        let body = canonical.strip_prefix('{').expect("an object");
        let body = body.strip_prefix(&format!("\"formatVersion\":{},", self.format_version)).unwrap_or(body);
        let game = serde_json::to_string(crate::VERSION).expect("a string serializes");
        format!("{{\"formatVersion\":{},\"gameVersion\":{game},{body}", self.format_version)
    }

    pub fn hash(&self) -> String {
        let digest = Sha256::digest(self.canonical_json().as_bytes());
        digest.iter().map(|b| format!("{b:02x}")).collect()
    }

    pub fn modded(&self) -> bool {
        match &self.rules {
            None | Some(serde_json::Value::Null) => false,
            Some(serde_json::Value::Object(o)) => !o.is_empty(),
            Some(_) => true,
        }
    }

    pub fn rules(&self) -> Option<&serde_json::Value> {
        self.rules.as_ref().filter(|_| self.modded())
    }

    /// Full validation per the contract. Collects every problem.
    pub fn validate(&self) -> Validation {
        let mut errors = Vec::new();
        match (self.format, &self.gems) {
            (FORMAT_ORE_ONLY, None) | (FORMAT, Some(_)) => {}
            (FORMAT_ORE_ONLY, Some(_)) => errors.push("format 1 maps have no gems layer".into()),
            (FORMAT, None) => errors.push("format 2 maps need a gems layer".into()),
            (f, _) => errors.push(format!("unsupported map format {f}")),
        }
        let len_ok = |s: &str, lo: usize, hi: usize| (lo..=hi).contains(&s.chars().count());
        if !len_ok(&self.name, 1, 64) {
            errors.push("name must be 1 to 64 characters".into());
        }
        if !len_ok(&self.author, 1, 64) {
            errors.push("author must be 1 to 64 characters".into());
        }
        if !len_ok(&self.description, 0, 500) {
            errors.push("description must be at most 500 characters".into());
        }
        let size_ok = (MIN_SIZE..=MAX_SIZE).contains(&self.width) && (MIN_SIZE..=MAX_SIZE).contains(&self.height);
        if !size_ok {
            errors.push(format!("size must be between {MIN_SIZE} and {MAX_SIZE} cells"));
        }
        if self.canonical_json().len() > MAX_BYTES {
            errors.push("map is larger than 1 MiB".into());
        }
        let rules = match Rules::load_with(self.rules()) {
            Ok(r) => Some(r),
            Err(e) => {
                errors.push(e);
                None
            }
        };
        let map = if size_ok {
            match self.to_map() {
                Ok(m) => Some(m),
                Err(e) => {
                    errors.push(e);
                    None
                }
            }
        } else {
            None
        };
        if !(2..=8).contains(&self.spawns.len()) {
            errors.push("a map needs 2 to 8 spawn points".into());
        }
        if let Some(m) = &map {
            // Games start with a Construction Yard on the spawn (World::spawn_start)
            // or an MCV on the yard's second cell, so both must fit on open
            // ground. The yard is measured with this map's rules (overrides can
            // resize it); without valid rules the built-in 3x4 stands in.
            let yard: Vec<(i32, i32)> = rules
                .as_ref()
                .and_then(|r| r.actor_index("FACT").and_then(|f| r.actors[f].building.as_ref()))
                .map_or_else(|| (0..3).flat_map(|dx| (0..4).map(move |dy| (dx, dy))).collect(), |b| b.cells().collect());
            let (w, h) = yard.iter().fold((0, 0), |(w, h), &(dx, dy)| (w.max(dx + 1), h.max(dy + 1)));
            // Cells a spawn's yard or MCV or a pre-placed structure takes: 0 free,
            // 1 + i spawn i, spawns_end + k actor k. No two may share a cell, as
            // spawn_building refuses taken cells (starts are placed first).
            let spawns_end = 1 + self.spawns.len();
            let mut taken = vec![0usize; m.cells()];
            for (i, &[x, y]) in self.spawns.iter().enumerate() {
                // Range first: huge coordinates must not reach the offset arithmetic.
                if !m.contains(x, y) {
                    errors.push(format!("spawn {} is outside the map", i + 1));
                    continue;
                }
                let open = |(cx, cy): (i32, i32)| m.contains(cx, cy) && m.terrain[m.idx(cx, cy)].buildable();
                let cells: Vec<(i32, i32)> = yard.iter().map(|&(dx, dy)| (x + dx, y + dy)).chain([(x + 1, y + 1)]).collect();
                if !cells.iter().all(|&c| open(c)) {
                    errors.push(format!("spawn {} needs {w}x{h} clear ground at its position", i + 1));
                    continue;
                }
                let mut overlap = None;
                for &(cx, cy) in &cells {
                    let ci = m.idx(cx, cy);
                    match taken[ci] {
                        0 => taken[ci] = 1 + i,
                        t if t != 1 + i => overlap = Some(t),
                        _ => {}
                    }
                }
                if let Some(t) = overlap {
                    errors.push(format!("spawn {} overlaps the start of spawn {t}", i + 1));
                }
            }
            if self.spawns.len() >= 2 && errors.is_empty() {
                let first = (self.spawns[0][0], self.spawns[0][1]);
                for (i, s) in self.spawns.iter().enumerate().skip(1) {
                    if !m.connected(first, (s[0], s[1])) {
                        errors.push(format!("spawn {} cannot be reached from spawn 1 by ground", i + 1));
                    }
                }
            }
            if self.actors.len() > MAX_ACTORS {
                errors.push(format!("at most {MAX_ACTORS} pre-placed actors"));
            }
            for (k, a) in self.actors.iter().take(MAX_ACTORS).enumerate() {
                if !m.contains(a.x, a.y) {
                    errors.push(format!("actor {} at {},{} is outside the map", short(&a.ty), a.x, a.y));
                }
                if a.owner < -1 || a.owner >= self.spawns.len() as i32 {
                    errors.push(format!("actor {} has an invalid owner {}", short(&a.ty), a.owner));
                }
                if let Some(r) = &rules {
                    match r.actor_index(&a.ty) {
                        None => errors.push(format!("unknown actor type {}", short(&a.ty))),
                        // Proxies (infantry.rs) have no body to place.
                        Some(t) if r.actors[t].kind == crate::rules::Kind::Proxy => {
                            errors.push(format!("actor type {} cannot be placed on a map", short(&a.ty)))
                        }
                        // The whole footprint of a structure must lie on the map, not only its top-left cell.
                        Some(t) => {
                            let Some(b) = r.actors[t].building.as_ref().filter(|_| m.contains(a.x, a.y)) else { continue };
                            if !b.fits(m, a.x, a.y) {
                                errors.push(format!("structure {} at {},{} does not fit inside the map", short(&a.ty), a.x, a.y));
                                continue;
                            }
                            let mut overlap = None;
                            for (dx, dy) in b.cells() {
                                let ci = m.idx(a.x + dx, a.y + dy);
                                match taken[ci] {
                                    0 => taken[ci] = spawns_end + k,
                                    t => overlap = Some(t),
                                }
                            }
                            match overlap {
                                Some(t) if t < spawns_end => {
                                    errors.push(format!("structure {} at {},{} overlaps the start of spawn {t}", short(&a.ty), a.x, a.y))
                                }
                                Some(_) => errors.push(format!("structure {} at {},{} overlaps another structure", short(&a.ty), a.x, a.y)),
                                None => {}
                            }
                        }
                    }
                }
            }
        }
        self.validate_setup(&mut errors);
        for a in self.actors.iter().take(MAX_ACTORS) {
            MapData::validate_actor_state(a, rules.as_ref(), &mut errors);
        }
        let ok = errors.is_empty();
        Validation { ok, errors, modded: self.modded(), hash: ok.then(|| self.hash()) }
    }

    /// Decode the layers into a [`Map`]. A missing gems layer means no gems.
    pub fn to_map(&self) -> Result<Map, String> {
        let n = (self.width * self.height) as usize;
        let terrain = b64().decode(&self.terrain).map_err(|_| "terrain is not valid base64".to_string())?;
        let ore = b64().decode(&self.ore).map_err(|_| "ore is not valid base64".to_string())?;
        if terrain.len() != n || ore.len() != n {
            return Err(format!("terrain and ore layers must have {n} bytes"));
        }
        let gems = match &self.gems {
            Some(g) => b64().decode(g).map_err(|_| "gems is not valid base64".to_string())?,
            None => vec![0; n],
        };
        if gems.len() != n {
            return Err(format!("the gems layer must have {n} bytes"));
        }
        let mut t = Vec::with_capacity(n);
        for &v in &terrain {
            t.push(Terrain::from_u8(v).ok_or_else(|| format!("invalid terrain value {v}"))?);
        }
        for i in 0..n {
            let (o, g) = (ore[i], gems[i]);
            if o > ORE_MAX_DENSITY {
                return Err(format!("invalid ore density {o}"));
            }
            if g > GEM_MAX_DENSITY {
                return Err(format!("invalid gem density {g}"));
            }
            if o > 0 && !t[i].holds_ore() {
                return Err("ore can only lie on clear or rough ground or roads".into());
            }
            if g > 0 && !t[i].holds_ore() {
                return Err("gems can only lie on clear or rough ground or roads".into());
            }
            if o > 0 && g > 0 {
                return Err("a cell cannot hold both ore and gems".into());
            }
        }
        let spawns = self.spawns.iter().map(|s| (s[0], s[1])).collect();
        Ok(Map { width: self.width, height: self.height, terrain: t, ore, gems, spawns })
    }

    /// A map file of `m`: format 2 with its gems, or format 1 when it has
    /// none, so maps without gems keep the identity they had in format 1.
    /// Temperate; set `biome` for another biome.
    pub fn from_map(m: &Map, name: &str, author: &str, description: &str) -> MapData {
        let terrain: Vec<u8> = m.terrain.iter().map(|&t| t as u8).collect();
        let has_gems = m.gems.iter().any(|&g| g > 0);
        MapData {
            format_version: FORMAT_VERSION,
            game_version: None,
            format: if has_gems { FORMAT } else { FORMAT_ORE_ONLY },
            name: name.into(),
            author: author.into(),
            description: description.into(),
            width: m.width,
            height: m.height,
            terrain: b64().encode(terrain),
            ore: b64().encode(&m.ore),
            gems: has_gems.then(|| b64().encode(&m.gems)),
            spawns: m.spawns.iter().map(|&(x, y)| [x, y]).collect(),
            actors: Vec::new(),
            rules: None,
            biome: Biome::Temperate,
            players: Vec::new(),
            options: serde_json::Map::new(),
            locked_options: Vec::new(),
            tags: Vec::new(),
        }
    }

    /// The game setup's checks (format version 2): slots, options, locks, tags.
    /// Why the map's slots can never start a game, or None (protocol
    /// `mapSlotsProblem`): at least two slots stay playable (not locked
    /// closed), at least one can take a person (not locked to an AI or
    /// closed), and the playable slots are not all locked to one team.
    /// Spawns without an entry are open slots with nothing locked.
    fn slots_problem(&self) -> Option<String> {
        let open = MapSlot::default();
        let slots: Vec<&MapSlot> = (0..self.spawns.len()).map(|k| self.players.get(k).unwrap_or(&open)).collect();
        let locked = |s: &MapSlot, part: &str| s.lock.iter().any(|l| l == part);
        let playable: Vec<&&MapSlot> = slots.iter().filter(|s| !(s.ty == "closed" && locked(s, "type"))).collect();
        if playable.len() < 2 {
            return Some("a map must leave at least two slots that can play".into());
        }
        if !slots.iter().any(|s| s.ty == "open" || !locked(s, "type")) {
            return Some("a map must leave at least one slot a person can take".into());
        }
        let team = playable[0].team;
        if team != 0 && playable.iter().all(|s| locked(s, "team") && s.team == team) {
            return Some(format!("every slot that can play is locked to team {team}: nobody to fight"));
        }
        None
    }

    fn validate_setup(&self, errors: &mut Vec<String>) {
        if self.players.len() > self.spawns.len() {
            errors.push(format!("players lists {} slots; the map has {} spawns", self.players.len(), self.spawns.len()));
        }
        let mut colors = Vec::new();
        for (i, p) in self.players.iter().enumerate() {
            let w = format!("players[{i}]");
            if !SLOT_FACTIONS.contains(&p.faction.as_str()) {
                errors.push(format!("{w}.faction is unknown"));
            }
            if !(0..=4).contains(&p.team) {
                errors.push(format!("{w}.team must be 0 to 4"));
            }
            if !(-1..=7).contains(&p.color) {
                errors.push(format!("{w}.color must be -1 to 7"));
            } else if p.color >= 0 {
                if colors.contains(&p.color) {
                    errors.push("players: two slots have the same colour".into());
                }
                colors.push(p.color);
            }
            if !SLOT_TYPES.contains(&p.ty.as_str()) {
                errors.push(format!("{w}.type must be open, ai or closed"));
            }
            if !SLOT_DIFFICULTIES.contains(&p.difficulty.as_str()) {
                errors.push(format!("{w}.difficulty must be easy, normal or hard"));
            }
            if !SLOT_BOTS.contains(&p.bot.as_str()) {
                errors.push(format!("{w}.bot must be rush, normal, turtle or naval"));
            }
            for (k, l) in p.lock.iter().enumerate() {
                if !SLOT_LOCKS.contains(&l.as_str()) || p.lock[..k].contains(l) {
                    errors.push(format!("{w}.lock must list faction, team, color or type, each once"));
                }
            }
            if p.lock.iter().any(|l| l == "color") && p.color < 0 {
                errors.push(format!("{w}: a locked colour needs a colour"));
            }
        }
        // Fewer than two spawns is the spawn check's error already.
        if let Some(problem) = self.slots_problem().filter(|_| self.spawns.len() >= 2) {
            errors.push(format!("players: {problem}"));
        }
        for (k, v) in &self.options {
            match MAP_OPTIONS.iter().find(|(name, _)| name == k) {
                None => errors.push(format!("options: {} is not an option a map can set", short(k))),
                Some((_, values)) => {
                    let text = match v {
                        serde_json::Value::String(s) => s.clone(),
                        serde_json::Value::Bool(_) | serde_json::Value::Number(_) => v.to_string(),
                        _ => String::new(),
                    };
                    // Strings must be strings and numbers numbers, as in the options JSON.
                    let kind_ok = match v {
                        serde_json::Value::String(_) => !values.iter().all(|x| x.parse::<i64>().is_ok() || *x == "true" || *x == "false"),
                        serde_json::Value::Number(_) => values.iter().all(|x| x.parse::<i64>().is_ok()),
                        serde_json::Value::Bool(_) => *values == BOOL,
                        _ => false,
                    };
                    if !kind_ok || !values.contains(&text.as_str()) {
                        errors.push(format!("options.{k} must be one of {}", values.join(", ")));
                    }
                }
            }
        }
        for (i, k) in self.locked_options.iter().enumerate() {
            if !self.options.contains_key(k) || self.locked_options[..i].contains(k) {
                errors.push(format!("lockedOptions[{i}] must name an option the map sets in options, once"));
            }
        }
        if self.tags.len() > TAGS_MAX {
            errors.push(format!("tags must be a list of at most {TAGS_MAX}"));
        }
        for (i, t) in self.tags.iter().enumerate() {
            let ok = (1..=TAG_MAX).contains(&t.len())
                && t.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b' ' || b == b'-')
                && t.bytes().next().is_some_and(|b| b.is_ascii_alphanumeric())
                && t.bytes().last().is_some_and(|b| b.is_ascii_alphanumeric());
            if !ok || self.tags[..i].contains(t) {
                errors.push(format!("tags[{i}] must be 1 to {TAG_MAX} lower-case letters, digits, spaces or hyphens, once"));
            }
        }
    }

    /// The pre-placed actor state's checks: ranges, and with the rules
    /// whether the actor can have a stance, levels and these passengers.
    fn validate_actor_state(a: &MapActor, rules: Option<&Rules>, errors: &mut Vec<String>) {
        let what = format!("actor {} at {},{}", short(&a.ty), a.x, a.y);
        if !(1..=100).contains(&a.health) {
            errors.push(format!("{what}: health must be 1 to 100 percent"));
        }
        let stance = a.stance.as_deref().map(|s| crate::rules::Stance::ALL.iter().copied().find(|x| x.name() == s));
        if stance == Some(None) {
            errors.push(format!("{what}: stance must be hold_fire, return_fire, defend or attack_anything"));
        }
        if !(0..=VETERANCY_MAX).contains(&a.veterancy) {
            errors.push(format!("{what}: veterancy must be 0 to {VETERANCY_MAX}"));
        }
        if a.cargo.len() > CARGO_MAX {
            errors.push(format!("{what}: at most {CARGO_MAX} passengers"));
        }
        let Some(r) = rules else { return };
        let Some(t) = r.actor_index(&a.ty) else { return };
        let info = &r.actors[t];
        if a.stance.is_some() && (info.stance.is_none() || info.weapons.is_empty()) {
            errors.push(format!("{what}: {} has no fire stance", short(&a.ty)));
        }
        let levels = info.experience.as_ref().map_or(0, |x| x.thresholds.len() as i32);
        if a.veterancy > levels {
            errors.push(format!("{what}: {} gains at most {levels} veterancy levels", short(&a.ty)));
        }
        if a.health < 100 && matches!(info.kind, crate::rules::Kind::Crate | crate::rules::Kind::Proxy) {
            errors.push(format!("{what}: {} has no health to set", short(&a.ty)));
        }
        if a.cargo.is_empty() {
            return;
        }
        let Some(cargo) = info.abilities.cargo.as_ref().filter(|c| !c.garrison) else {
            errors.push(format!("{what}: {} carries no passengers", short(&a.ty)));
            return;
        };
        let mut weight = 0;
        for p in &a.cargo {
            let unit = r.actor_index(p).and_then(|pi| r.actors[pi].unit.as_ref());
            match unit.and_then(|u| u.passenger.as_ref().map(|kind| (kind, u.passenger_weight))) {
                Some((kind, w)) if cargo.types.iter().any(|ty| ty == kind) => weight += w,
                _ => errors.push(format!("{what}: {} cannot ride in {}", short(p), short(&a.ty))),
            }
        }
        if weight > cargo.max {
            errors.push(format!("{what}: the passengers weigh {weight}; {} carries {}", short(&a.ty), cargo.max));
        }
    }

    /// Whether lobby options (the options JSON a game starts with) keep the
    /// options this map locks: each locked option must have the map's value.
    pub fn locked_option_problem(&self, options: &serde_json::Value) -> Option<String> {
        self.locked_options.iter().find_map(|k| {
            let want = self.options.get(k)?;
            (options.get(k) != Some(want)).then(|| format!("this map locks {} to {want}", short(k)))
        })
    }
}

fn short(s: &str) -> String {
    s.chars().take(80).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_maps_round_trip_and_validate() {
        for players in [2, 4, 6] {
            let m = Map::generate_for(96, 96, 3, 12, players);
            let d = MapData::from_map(&m, "Test", "Tester", "");
            let v = d.validate();
            assert!(v.ok, "{players}: {:?}", v.errors);
            assert!(!v.modded);
            let again = MapData::parse(&d.canonical_json()).unwrap();
            assert_eq!(again.hash(), d.hash());
            let back = again.to_map().unwrap();
            assert_eq!(back.terrain, m.terrain);
            assert_eq!(back.ore, m.ore);
            assert_eq!(back.gems, m.gems);
            assert_eq!(d.format, FORMAT, "generated maps have gems");
            assert!(d.canonical_json().contains(r#","gems":""#));
        }
    }

    /// A map with this terrain everywhere, ore on cell 0 and gems on cell 1
    /// (when given), and two spawns.
    fn small(format: u32, gems: Option<Vec<u8>>) -> MapData {
        let n = 32 * 32;
        let mut ore = vec![0u8; n];
        ore[0] = 5;
        MapData {
            format_version: FORMAT_VERSION,
            game_version: None,
            format,
            name: "Small".into(),
            author: "x".into(),
            description: String::new(),
            width: 32,
            height: 32,
            terrain: b64().encode(vec![0u8; n]),
            ore: b64().encode(ore),
            gems: gems.map(|g| b64().encode(g)),
            spawns: vec![[4, 4], [20, 20]],
            actors: Vec::new(),
            rules: None,
            biome: Biome::Temperate,
            players: Vec::new(),
            options: serde_json::Map::new(),
            locked_options: Vec::new(),
            tags: Vec::new(),
        }
    }

    /// The game setup's defaults at the end of a canonical form (format version 2).
    const SETUP_TAIL: &str = r#","players":[],"options":{},"lockedOptions":[],"tags":[]}"#;

    #[test]
    fn maps_without_gems_have_no_gems_layer() {
        // Layer format 1 (no gems key) in map format version 2.
        let n = 32 * 32;
        let json = format!(
            r#"{{"formatVersion":2,"format":1,"name":"Old","author":"x","description":"","width":32,"height":32,"terrain":"{t}","ore":"{t}","spawns":[[4,4],[20,20]],"actors":[],"rules":null{SETUP_TAIL}"#,
            t = b64().encode(vec![0u8; n])
        );
        let d = MapData::parse(&json).unwrap();
        assert!(d.validate().ok, "{:?}", d.validate().errors);
        assert_eq!(d.canonical_json(), json, "canonical form unchanged");
        assert_eq!(d.to_map().unwrap().gems, vec![0; n]);
        // Without gems the exporter keeps writing format 1.
        let m = d.to_map().unwrap();
        assert_eq!(MapData::from_map(&m, "Old", "x", "").canonical_json(), json);
        // `"gems": null` is the same as no gems layer.
        let nulled = json.replace(r#","spawns""#, r#","gems":null,"spawns""#);
        assert_eq!(MapData::parse(&nulled).unwrap().hash(), d.hash());
    }

    #[test]
    fn format_2_gems_layer_is_checked() {
        let n = 32 * 32;
        let mut gems = vec![0u8; n];
        gems[1] = 3;
        let d = small(2, Some(gems.clone()));
        let v = d.validate();
        assert!(v.ok, "{:?}", v.errors);
        let json = d.canonical_json();
        assert!(json.contains(r#""ore":""#) && json.find(r#""ore":"#) < json.find(r#""gems":"#));
        assert!(json.find(r#""gems":"#) < json.find(r#""spawns":"#), "gems sits between ore and spawns");
        let m = MapData::parse(&json).unwrap().to_map().unwrap();
        assert_eq!((m.ore[0], m.gems[1]), (5, 3));
        // The gems layer belongs to format 2 only, and format 2 needs it.
        let errs = |d: &MapData| d.validate().errors;
        assert!(errs(&small(1, Some(gems.clone()))).contains(&"format 1 maps have no gems layer".to_string()));
        assert!(errs(&small(2, None)).contains(&"format 2 maps need a gems layer".to_string()));
        assert!(errs(&small(3, None)).contains(&"unsupported map format 3".to_string()));
        // Density, terrain, overlap with ore, length, encoding.
        let mut bad = gems.clone();
        bad[1] = 4;
        assert!(errs(&small(2, Some(bad))).contains(&"invalid gem density 4".to_string()));
        let mut both = gems.clone();
        both[0] = 1;
        assert!(errs(&small(2, Some(both))).contains(&"a cell cannot hold both ore and gems".to_string()));
        let mut rock = small(2, Some(gems.clone()));
        let mut terrain = vec![0u8; n];
        terrain[1] = Terrain::Rock as u8;
        rock.terrain = b64().encode(terrain);
        assert!(errs(&rock).contains(&"gems can only lie on clear or rough ground or roads".to_string()));
        assert!(errs(&small(2, Some(vec![0; n - 1]))).contains(&"the gems layer must have 1024 bytes".to_string()));
        let mut garbled = small(2, None);
        garbled.gems = Some("!!".into());
        assert!(errs(&garbled).contains(&"gems is not valid base64".to_string()));
        // An all-zero gems layer is a valid format 2 map (writers use format 1 for it).
        assert!(small(2, Some(vec![0; n])).validate().ok);
    }

    #[test]
    fn invalid_maps_report_every_problem() {
        let m = Map::generate_for(64, 64, 1, 12, 2);
        let mut d = MapData::from_map(&m, "", "x", "");
        d.spawns = vec![[0, 0]];
        d.actors.push(MapActor::new("NOPE", 5, 999, 0, 0));
        d.rules = Some(serde_json::json!({ "actors": { "1TNK": { "cost": "free" } } }));
        let v = d.validate();
        assert!(!v.ok && v.modded && v.hash.is_none());
        assert!(v.errors.len() >= 4, "{:?}", v.errors);
        assert!(MapData::parse(r#"{"format":1,"evil":true}"#).is_err(), "unknown fields are rejected");
    }

    #[test]
    fn structures_must_fit_inside_the_map() {
        // N1: only the top-left cell used to be checked, so a Construction Yard
        // (3x4) at 45,46 on a 48x48 map passed and trapped every client at start.
        let m = Map::generate_for(48, 48, 2, 12, 2);
        let mut d = MapData::from_map(&m, "Edge", "x", "");
        d.actors.push(MapActor::new("FACT", 0, 45, 46, 0));
        let v = d.validate();
        assert!(!v.ok && v.errors.iter().any(|e| e.contains("does not fit")), "{:?}", v.errors);
        let players = [crate::world::PlayerSetup::new("russia", None), crate::world::PlayerSetup::new("england", None)];
        assert!(crate::world::World::from_map(&d, 1, &players, Default::default()).is_err());
        // Units only need their own cell; a structure that fits exactly is fine.
        d.actors = vec![MapActor::new("E1", 0, 47, 47, 0), MapActor::new("FACT", -1, 45, 44, 0)];
        assert!(d.validate().errors.iter().all(|e| !e.contains("does not fit") && !e.contains("outside")));
    }

    #[test]
    fn spawns_must_fit_the_construction_yard_of_the_map_rules() {
        // Re-audit: the yard footprint was a fixed 3x4, so a modded 8x8 yard on
        // an edge spawn did not fit and the player silently started without one.
        let m = Map::generate_for(48, 48, 2, 12, 2);
        let mut d = MapData::from_map(&m, "Edge", "x", "");
        // Clear ground at the bottom right corner and a spawn whose 3x4 yard just fits there.
        let n = 48 * 48;
        d.terrain = b64().encode(vec![0u8; n]);
        d.ore = b64().encode(vec![0u8; n]);
        d.spawns[1] = [45, 44];
        assert!(d.validate().ok, "{:?}", d.validate().errors);
        let big = serde_json::json!({ "actors": { "FACT": { "building": {
            "width": 8, "height": 8, "footprint": vec!["xxxxxxxx"; 8], "center_offset": [0, 0]
        } } } });
        d.rules = Some(big);
        let v = d.validate();
        assert!(v.errors.iter().any(|e| e.contains("spawn 2 needs 8x8 clear ground")), "{:?}", v.errors);
        d.spawns[1] = [38, 38];
        assert!(d.validate().ok, "{:?}", d.validate().errors);
        // The MCV start puts the MCV on the yard's second cell, which must be open as well.
        d.rules = Some(serde_json::json!({ "actors": { "FACT": { "building": {
            "width": 1, "height": 1, "footprint": ["x"], "center_offset": [0, 0]
        } } } }));
        d.spawns[1] = [47, 47];
        assert!(d.validate().errors.iter().any(|e| e.contains("spawn 2 needs 1x1")), "{:?}", d.validate().errors);
    }

    #[test]
    fn starts_and_structures_must_not_overlap_and_spawns_must_be_on_the_map() {
        let m = Map::generate_for(48, 48, 2, 12, 2);
        let mut d = MapData::from_map(&m, "Overlap", "x", "");
        let n = 48 * 48;
        d.terrain = b64().encode(vec![0u8; n]);
        d.ore = b64().encode(vec![0u8; n]);
        d.spawns = vec![[4, 4], [30, 30]];
        assert!(d.validate().ok, "{:?}", d.validate().errors);
        let errors = |d: &MapData| d.validate().errors;
        // Huge spawn coordinates are refused before any offset arithmetic.
        d.spawns[1] = [i32::MAX, i32::MIN];
        assert!(errors(&d).iter().any(|e| e.contains("spawn 2 is outside the map")), "{:?}", errors(&d));
        // Two starts sharing cells.
        d.spawns[1] = [5, 6];
        assert!(errors(&d).iter().any(|e| e.contains("spawn 2 overlaps the start of spawn 1")), "{:?}", errors(&d));
        d.spawns[1] = [30, 30];
        // A structure on a start's yard, and two structures on each other.
        d.actors = vec![MapActor::new("POWR", -1, 5, 3, 0)];
        assert!(errors(&d).iter().any(|e| e.contains("overlaps the start of spawn 1")), "{:?}", errors(&d));
        d.actors = vec![MapActor::new("POWR", -1, 15, 15, 0), MapActor::new("FACT", 0, 16, 13, 0)];
        assert!(errors(&d).iter().any(|e| e.contains("overlaps another structure")), "{:?}", errors(&d));
        d.actors[1].x = 20;
        assert!(d.validate().ok, "{:?}", errors(&d));
    }

    #[test]
    fn biome_is_optional_and_left_out_when_temperate() {
        let m = Map::generate_for(48, 48, 2, 12, 2);
        let mut d = MapData::from_map(&m, "Biome", "x", "");
        let temperate = d.canonical_json();
        assert!(!temperate.contains("biome"), "temperate maps keep the old canonical form");
        // An explicit temperate biome is the same map (same hash).
        let explicit = temperate.replace(r#","players":"#, r#","biome":"temperate","players":"#);
        let temperate_hash = d.hash();
        assert_eq!(MapData::parse(&explicit).unwrap().hash(), temperate_hash);
        d.biome = Biome::Snow;
        let snow = d.canonical_json();
        assert!(snow.ends_with(&format!(r#""rules":null,"biome":"snow"{SETUP_TAIL}"#)), "{}", &snow[snow.len() - 100..]);
        assert_ne!(d.hash(), temperate_hash, "the biome is part of the identity");
        let v = d.validate();
        assert!(v.ok && !v.modded, "a biome is not a rules override: {:?}", v.errors);
        assert_eq!(MapData::parse(&snow).unwrap().biome, Biome::Snow);
        assert!(MapData::parse(&snow.replace("snow", "lava")).is_err(), "unknown biomes are refused");
    }

    #[test]
    fn fords_are_valid_terrain_without_ore() {
        let m = Map::generate_for(48, 48, 2, 12, 2);
        let mut d = MapData::from_map(&m, "Ford", "x", "");
        let mut terrain = b64().decode(&d.terrain).unwrap();
        let mut ore = vec![0u8; terrain.len()];
        terrain[0] = 5;
        d.terrain = b64().encode(&terrain);
        d.ore = b64().encode(&ore);
        assert!(d.to_map().is_ok());
        ore[0] = 3;
        d.ore = b64().encode(&ore);
        assert!(d.to_map().err().unwrap().contains("ore can only lie"));
        terrain[0] = crate::map::TERRAIN_COUNT;
        d.terrain = b64().encode(&terrain);
        assert!(d.to_map().err().unwrap().contains("invalid terrain value 11"));
    }

    #[test]
    fn hash_is_stable_across_rules_key_order() {
        let m = Map::generate_for(48, 48, 2, 12, 2);
        let mut a = MapData::from_map(&m, "A", "B", "");
        a.rules = Some(serde_json::from_str(r#"{"weapons":{"25mm":{"range":5000}},"actors":{"1TNK":{"cost":1}}}"#).unwrap());
        let b = MapData::parse(&a.canonical_json()).unwrap();
        assert_eq!(a.hash(), b.hash());
        assert!(a.canonical_json().contains(r#""rules":{"actors":{"1TNK":{"cost":1}},"weapons""#));
    }

    /// The format 1 baseline fixtures of the protocol package (map versions):
    /// the engine refuses format 1 (the protocol upgrades it first), and reads
    /// the upgraded map the protocol pinned to exactly its canonical form and hash.
    #[test]
    fn baseline_fixture_upgraded_has_the_pinned_identity() {
        let expected: serde_json::Value =
            serde_json::from_str(include_str!("../../packages/protocol/test/fixtures/maps/format1-legacy.expected.json")).unwrap();
        for old in [
            include_str!("../../packages/protocol/test/fixtures/maps/format1-legacy.webra-map.json"),
            include_str!("../../packages/protocol/test/fixtures/maps/format1-file.webra-map.json"),
        ] {
            assert!(MapData::parse(old.trim()).unwrap_err().contains("must be upgraded to format 2"));
        }
        let canonical = expected["canonical"].as_str().unwrap();
        let upgraded = MapData::parse(canonical).unwrap();
        assert_eq!(upgraded.canonical_json(), canonical);
        assert_eq!(upgraded.hash(), expected["hash"].as_str().unwrap());
        assert!(upgraded.validate().ok, "{:?}", upgraded.validate().errors);
        // The file form names the release; the identity stays.
        let file = MapData::parse(&upgraded.file_json()).unwrap();
        assert_eq!(file.game_version.as_deref(), Some(crate::VERSION));
        assert_eq!(file.hash(), upgraded.hash());
    }

    #[test]
    fn only_the_current_format_version_is_read() {
        let d = small(FORMAT_ORE_ONLY, None);
        let file = d.file_json();
        assert!(
            file.starts_with(&format!(r#"{{"formatVersion":2,"gameVersion":"{}","format":1,"name":"Small""#, crate::VERSION)),
            "{file}"
        );
        let back = MapData::parse(&file).unwrap();
        assert_eq!(back.canonical_json(), d.canonical_json());
        assert_eq!(back.hash(), d.hash());
        let newer = file.replacen(r#""formatVersion":2"#, r#""formatVersion":3"#, 1);
        let err = MapData::parse(&newer).unwrap_err();
        assert!(err.contains("map format 3, made by a newer version of WebRA"), "{err}");
        let older = file.replacen(r#""formatVersion":2"#, r#""formatVersion":1"#, 1);
        assert!(MapData::parse(&older).unwrap_err().contains("map format 1; it must be upgraded"));
        let canonical = d.canonical_json();
        let body = canonical.strip_prefix(r#"{"formatVersion":2,"#).expect("version 2 names itself");
        let zero = format!(r#"{{"formatVersion":0,{body}"#);
        assert!(MapData::parse(&zero).unwrap_err().contains("formatVersion must be 1 or more"));
        // Without formatVersion a file is format 1: refused, to be upgraded first.
        assert!(MapData::parse(&format!("{{{body}")).unwrap_err().contains("must be upgraded"));
        for bad in [r#""""#, r#""a b""#, &format!("\"{}\"", "1".repeat(33))] {
            let text = format!(r#"{{"gameVersion":{bad},{}"#, &canonical[1..]);
            assert!(MapData::parse(&text).unwrap_err().contains("gameVersion must be a version"), "{bad}");
        }
        assert!(MapData::parse(&format!(r#"{{"gameVersion":9,{}"#, &canonical[1..])).is_err(), "a version is text");
        let nulled = format!(r#"{{"gameVersion":null,{}"#, &canonical[1..]);
        assert_eq!(MapData::parse(&nulled).unwrap().hash(), d.hash());
        let v: serde_json::Value = serde_json::from_str(&crate::Game::validate_map(&newer)).unwrap();
        assert_eq!(v["ok"], false);
        assert!(v["errors"][0].as_str().unwrap().contains("newer version of WebRA"));
    }

    #[test]
    fn generated_maps_are_files_of_the_current_format() {
        let text = crate::Game::generated_map(7, 48, 2);
        assert!(text.starts_with(&format!(r#"{{"formatVersion":{FORMAT_VERSION},"gameVersion":"{}","#, crate::VERSION)), "{}", &text[..80]);
        let d = MapData::parse(&text).unwrap();
        assert!(d.validate().ok);
        assert_eq!(d.file_json(), text);
    }
}

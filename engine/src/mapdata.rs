//! Map files (`.webra-map.json`, format 1; see docs/contracts.md section 2).
//!
//! The canonical form is the JSON serialization of [`MapData`] with fields in
//! declaration order, keys inside `rules` sorted (serde_json's default map),
//! and no whitespace. Its SHA-256 (hex) is the map's identity, shared with
//! the game client, the editor and the server.

use crate::map::{Map, Terrain};
use crate::rules::Rules;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const FORMAT: u32 = 1;
pub const MAX_BYTES: usize = 1024 * 1024;
pub const MIN_SIZE: i32 = 32;
pub const MAX_SIZE: i32 = 256;
pub const MAX_ACTORS: usize = 2000;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct MapData {
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
    pub spawns: Vec<[i32; 2]>,
    #[serde(default)]
    pub actors: Vec<MapActor>,
    #[serde(default)]
    pub rules: Option<serde_json::Value>,
}

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
}

#[derive(Serialize, Debug)]
pub struct Validation {
    pub ok: bool,
    pub errors: Vec<String>,
    pub modded: bool,
    pub hash: Option<String>,
}

fn b64() -> base64::engine::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

impl MapData {
    pub fn parse(json: &str) -> Result<MapData, String> {
        if json.len() > MAX_BYTES {
            return Err(format!("map is larger than {} bytes", MAX_BYTES));
        }
        serde_json::from_str(json).map_err(|e| format!("invalid map JSON: {}", short(&e.to_string())))
    }

    pub fn canonical_json(&self) -> String {
        serde_json::to_string(self).expect("map serializes")
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
        if self.format != FORMAT {
            errors.push(format!("unsupported map format {}", self.format));
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
        let ok = errors.is_empty();
        Validation { ok, errors, modded: self.modded(), hash: ok.then(|| self.hash()) }
    }

    /// Decode the layers into a [`Map`].
    pub fn to_map(&self) -> Result<Map, String> {
        let n = (self.width * self.height) as usize;
        let terrain = b64().decode(&self.terrain).map_err(|_| "terrain is not valid base64".to_string())?;
        let ore = b64().decode(&self.ore).map_err(|_| "ore is not valid base64".to_string())?;
        if terrain.len() != n || ore.len() != n {
            return Err(format!("terrain and ore layers must have {n} bytes"));
        }
        let mut t = Vec::with_capacity(n);
        for &v in &terrain {
            t.push(Terrain::from_u8(v).ok_or_else(|| format!("invalid terrain value {v}"))?);
        }
        for (i, &o) in ore.iter().enumerate() {
            if o > 12 {
                return Err(format!("invalid ore density {o}"));
            }
            if o > 0 && !t[i].passable() {
                return Err("ore can only lie on clear or rough ground".into());
            }
        }
        Ok(Map { width: self.width, height: self.height, terrain: t, ore, spawns: self.spawns.iter().map(|s| (s[0], s[1])).collect() })
    }

    pub fn from_map(m: &Map, name: &str, author: &str, description: &str) -> MapData {
        let terrain: Vec<u8> = m.terrain.iter().map(|&t| t as u8).collect();
        MapData {
            format: FORMAT,
            name: name.into(),
            author: author.into(),
            description: description.into(),
            width: m.width,
            height: m.height,
            terrain: b64().encode(terrain),
            ore: b64().encode(&m.ore),
            spawns: m.spawns.iter().map(|&(x, y)| [x, y]).collect(),
            actors: Vec::new(),
            rules: None,
        }
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
        }
    }

    #[test]
    fn invalid_maps_report_every_problem() {
        let m = Map::generate_for(64, 64, 1, 12, 2);
        let mut d = MapData::from_map(&m, "", "x", "");
        d.spawns = vec![[0, 0]];
        d.actors.push(MapActor { ty: "NOPE".into(), owner: 5, x: 999, y: 0, facing: 0 });
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
        d.actors.push(MapActor { ty: "FACT".into(), owner: 0, x: 45, y: 46, facing: 0 });
        let v = d.validate();
        assert!(!v.ok && v.errors.iter().any(|e| e.contains("does not fit")), "{:?}", v.errors);
        let players = [crate::world::PlayerSetup::new("russia", None), crate::world::PlayerSetup::new("england", None)];
        assert!(crate::world::World::from_map(&d, 1, &players, Default::default()).is_err());
        // Units only need their own cell; a structure that fits exactly is fine.
        d.actors = vec![
            MapActor { ty: "E1".into(), owner: 0, x: 47, y: 47, facing: 0 },
            MapActor { ty: "FACT".into(), owner: -1, x: 45, y: 44, facing: 0 },
        ];
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
        d.actors = vec![MapActor { ty: "POWR".into(), owner: -1, x: 5, y: 3, facing: 0 }];
        assert!(errors(&d).iter().any(|e| e.contains("overlaps the start of spawn 1")), "{:?}", errors(&d));
        d.actors = vec![
            MapActor { ty: "POWR".into(), owner: -1, x: 15, y: 15, facing: 0 },
            MapActor { ty: "FACT".into(), owner: 0, x: 16, y: 13, facing: 0 },
        ];
        assert!(errors(&d).iter().any(|e| e.contains("overlaps another structure")), "{:?}", errors(&d));
        d.actors[1].x = 20;
        assert!(d.validate().ok, "{:?}", errors(&d));
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
}

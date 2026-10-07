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
            for (i, &[x, y]) in self.spawns.iter().enumerate() {
                // The 3x4 construction yard footprint must be on open ground.
                let open = (0..3).all(|dx| (0..4).all(|dy| m.contains(x + dx, y + dy) && m.terrain[m.idx(x + dx, y + dy)].buildable()));
                if !open {
                    errors.push(format!("spawn {} needs 3x4 clear ground at its position", i + 1));
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
            for a in self.actors.iter().take(MAX_ACTORS) {
                if !m.contains(a.x, a.y) {
                    errors.push(format!("actor {} at {},{} is outside the map", short(&a.ty), a.x, a.y));
                }
                if a.owner < -1 || a.owner >= self.spawns.len() as i32 {
                    errors.push(format!("actor {} has an invalid owner {}", short(&a.ty), a.owner));
                }
                if let Some(r) = &rules {
                    if r.actor_index(&a.ty).is_none() {
                        errors.push(format!("unknown actor type {}", short(&a.ty)));
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
    fn hash_is_stable_across_rules_key_order() {
        let m = Map::generate_for(48, 48, 2, 12, 2);
        let mut a = MapData::from_map(&m, "A", "B", "");
        a.rules = Some(serde_json::from_str(r#"{"weapons":{"25mm":{"range":5000}},"actors":{"1TNK":{"cost":1}}}"#).unwrap());
        let b = MapData::parse(&a.canonical_json()).unwrap();
        assert_eq!(a.hash(), b.hash());
        assert!(a.canonical_json().contains(r#""rules":{"actors":{"1TNK":{"cost":1}},"weapons""#));
    }
}

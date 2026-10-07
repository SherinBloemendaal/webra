//! Game rules, loaded from `rules.json` (generated from OpenRA data by
//! `tools/gen_rules.py`) and post-processed into lookup-friendly structures.

use serde::Deserialize;
use std::collections::BTreeMap;

const RULES_JSON: &str = include_str!("../rules.json");

#[derive(Deserialize)]
struct RawRules {
    factions: Vec<String>,
    player: PlayerRules,
    actors: Vec<RawActor>,
    weapons: Vec<RawWeapon>,
    locomotors: Vec<RawLocomotor>,
}

#[derive(Deserialize, Clone)]
pub struct PlayerRules {
    pub starting_cash: i32,
    pub ore_value: i32,
    pub low_power_modifier: i32,
    pub speed_reduction: Vec<i32>,
    pub ore_max_density: u8,
}

#[derive(Deserialize)]
struct RawActor {
    id: String,
    name: String,
    description: String,
    kind: String,
    queue: String,
    cost: i32,
    build_ticks: i32,
    palette_order: i32,
    prerequisites: Vec<String>,
    hp: i32,
    armor: usize,
    sight: i32,
    weapons: Vec<usize>,
    building: Option<RawBuilding>,
    unit: Option<UnitInfo>,
}

#[derive(Deserialize)]
struct RawBuilding {
    width: i32,
    height: i32,
    footprint: Vec<String>,
    power: i32,
    power_scales_with_health: bool,
    produces: Vec<String>,
    exits: Vec<Vec<i32>>,
    gives_buildable_area: bool,
    base_provider_range: i32,
    adjacent: i32,
    provides: BTreeMap<String, Vec<String>>,
    refinery: Option<RawRefinery>,
    repairs: Option<RepairInfo>,
    center_offset: Vec<i32>,
}

#[derive(Deserialize)]
struct RawRefinery {
    dock_offset: Vec<i32>,
    storage: i32,
    free_actor: String,
    free_actor_offset: Vec<i32>,
}

#[derive(Deserialize, Clone)]
pub struct RepairInfo {
    pub hp_per_step: i32,
    pub interval: i32,
    pub value_percent: i32,
}

#[derive(Deserialize, Clone)]
pub struct UnitInfo {
    pub speed: i32,
    pub turn_speed: i32,
    pub turn_in_place: bool,
    pub locomotor: usize,
    pub turret_turn_speed: Option<i32>,
    pub radius: i32,
    pub harvester: Option<HarvesterInfo>,
}

#[derive(Deserialize, Clone)]
pub struct HarvesterInfo {
    pub capacity: i32,
    pub bale_load_delay: i32,
    pub bale_unload_delay: i32,
    pub search_from_proc: i32,
    pub search_from_harv: i32,
}

#[derive(Deserialize)]
struct RawWeapon {
    name: String,
    range: i32,
    reload: i32,
    burst: i32,
    burst_delays: Vec<i32>,
    projectile: String,
    speed: i32,
    damage: i32,
    spread: i32,
    falloff: Vec<i32>,
    versus: Vec<i32>,
}

#[derive(Deserialize)]
struct RawLocomotor {
    name: String,
    speeds: Vec<i32>,
    crushes: Vec<String>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Building,
    Infantry,
    Vehicle,
}

/// Production queue types used by the classic (per-category) sidebar.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum QueueType {
    Building = 0,
    Infantry = 1,
    Vehicle = 2,
}
pub const QUEUE_COUNT: usize = 3;

impl QueueType {
    pub fn from_index(i: usize) -> QueueType {
        match i {
            0 => QueueType::Building,
            1 => QueueType::Infantry,
            _ => QueueType::Vehicle,
        }
    }
    fn parse(s: &str) -> QueueType {
        match s {
            "Building" | "Defense" => QueueType::Building,
            "Infantry" => QueueType::Infantry,
            "Vehicle" => QueueType::Vehicle,
            other => panic!("unsupported queue {other}"),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum FootCell {
    Empty,
    Occupied,
    /// Part of the building but units may drive over it (bib, depot pad).
    Passable,
}

#[derive(Clone, Debug)]
pub struct Prereq {
    pub token: u16,
    /// `~`: hide the item while this prerequisite is unmet.
    pub hidden: bool,
    /// `!`: the prerequisite must be absent.
    pub negate: bool,
}

pub struct BuildingInfo {
    pub width: i32,
    pub height: i32,
    pub footprint: Vec<(i32, i32, FootCell)>,
    /// Cells that can be hit: the solid cells, or the whole pad for
    /// buildings without solid cells (the service depot).
    pub hit_cells: Vec<(i32, i32)>,
    pub power: i32,
    pub power_scales_with_health: bool,
    pub produces: Vec<QueueType>,
    pub exits: Vec<(i32, i32)>,
    pub gives_buildable_area: bool,
    pub base_provider_range: i32,
    pub adjacent: i32,
    /// Prerequisite tokens provided, per faction index.
    pub provides: Vec<Vec<u16>>,
    pub refinery: Option<RefineryInfo>,
    pub repairs: Option<RepairInfo>,
    pub center_offset: (i32, i32),
}

pub struct RefineryInfo {
    pub dock_offset: (i32, i32),
    pub storage: i32,
    pub free_actor: usize,
    pub free_actor_offset: (i32, i32),
}

pub struct ActorInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub kind: Kind,
    pub queue: QueueType,
    pub cost: i32,
    pub build_ticks: i32,
    pub palette_order: i32,
    pub prerequisites: Vec<Prereq>,
    pub hp: i32,
    pub armor: usize,
    pub sight: i32,
    pub weapons: Vec<usize>,
    pub building: Option<BuildingInfo>,
    pub unit: Option<UnitInfo>,
}

impl ActorInfo {
    pub fn max_range(&self, rules: &Rules) -> i32 {
        self.weapons.iter().map(|&w| rules.weapons[w].range).max().unwrap_or(0)
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Projectile {
    Bullet,
    Missile,
    Instant,
}

pub struct WeaponInfo {
    pub name: String,
    pub range: i32,
    pub reload: i32,
    pub burst: i32,
    pub burst_delays: Vec<i32>,
    pub projectile: Projectile,
    pub speed: i32,
    pub damage: i32,
    pub spread: i32,
    pub falloff: Vec<i32>,
    pub versus: Vec<i32>,
}

impl WeaponInfo {
    pub fn burst_delay(&self, shot: i32) -> i32 {
        let i = (shot.max(0) as usize).min(self.burst_delays.len() - 1);
        self.burst_delays[i]
    }

    /// Damage multiplier (percent) at `distance` from the impact, following
    /// OpenRA's SpreadDamage falloff: linear between steps of `spread`.
    pub fn falloff_at(&self, distance: i32) -> i32 {
        if self.spread <= 0 {
            return if distance == 0 { 100 } else { 0 };
        }
        let step = (distance / self.spread) as usize;
        if step + 1 >= self.falloff.len() {
            return 0;
        }
        let a = self.falloff[step];
        let b = self.falloff[step + 1];
        let t = distance - step as i32 * self.spread;
        a + (b - a) * t / self.spread
    }

    /// Max distance at which this weapon still deals damage.
    pub fn damage_radius(&self) -> i32 {
        self.spread * (self.falloff.len() as i32 - 1)
    }
}

pub struct Locomotor {
    pub name: String,
    /// Speed percent per terrain class (Clear, Rough, Ore).
    pub speeds: Vec<i32>,
    /// OpenRA `Crushes: infantry`: drives over enemy soldiers.
    pub crushes_infantry: bool,
}

pub struct Rules {
    pub factions: Vec<String>,
    pub player: PlayerRules,
    pub actors: Vec<ActorInfo>,
    pub weapons: Vec<WeaponInfo>,
    pub locomotors: Vec<Locomotor>,
    pub tokens: Vec<String>,
}

pub const TOKEN_DISABLED: &str = "disabled";

impl Rules {
    pub fn load() -> Rules {
        let raw: RawRules = serde_json::from_str(RULES_JSON).expect("rules.json is valid");
        let mut tokens: Vec<String> = vec![TOKEN_DISABLED.to_string()];
        let mut intern = |t: &str| -> u16 {
            if let Some(i) = tokens.iter().position(|x| x == t) {
                i as u16
            } else {
                tokens.push(t.to_string());
                (tokens.len() - 1) as u16
            }
        };
        let ids: Vec<String> = raw.actors.iter().map(|a| a.id.clone()).collect();
        let mut actors = Vec::new();
        for a in raw.actors {
            let kind = match a.kind.as_str() {
                "building" => Kind::Building,
                "infantry" => Kind::Infantry,
                "vehicle" => Kind::Vehicle,
                k => panic!("unknown kind {k}"),
            };
            let mut prerequisites = Vec::new();
            for p in &a.prerequisites {
                let mut s = p.as_str();
                let hidden = s.starts_with('~');
                s = s.trim_start_matches('~');
                let negate = s.starts_with('!');
                s = s.trim_start_matches('!');
                // Tech level gating is a lobby option; the milestone always plays unrestricted.
                if s.starts_with("techlevel.") {
                    continue;
                }
                prerequisites.push(Prereq { token: intern(s), hidden, negate });
            }
            let building = a.building.map(|b| {
                let mut footprint = Vec::new();
                for (y, row) in b.footprint.iter().enumerate() {
                    for (x, c) in row.chars().enumerate() {
                        let cell = match c {
                            '_' => FootCell::Empty,
                            'x' | 'X' => FootCell::Occupied,
                            '=' | '+' => FootCell::Passable,
                            other => panic!("unknown footprint cell {other} in {}", a.id),
                        };
                        footprint.push((x as i32, y as i32, cell));
                    }
                }
                let provides = raw
                    .factions
                    .iter()
                    .map(|f| b.provides.get(f).map(|v| v.iter().map(|t| intern(t)).collect()).unwrap_or_default())
                    .collect();
                let solid: Vec<(i32, i32)> = footprint.iter().filter(|c| c.2 == FootCell::Occupied).map(|c| (c.0, c.1)).collect();
                let hit_cells = if solid.is_empty() {
                    footprint.iter().filter(|c| c.2 != FootCell::Empty).map(|c| (c.0, c.1)).collect()
                } else {
                    solid
                };
                BuildingInfo {
                    width: b.width,
                    height: b.height,
                    footprint,
                    hit_cells,
                    power: b.power,
                    power_scales_with_health: b.power_scales_with_health,
                    produces: b
                        .produces
                        .iter()
                        .filter(|p| matches!(p.as_str(), "Building" | "Infantry" | "Vehicle"))
                        .map(|p| QueueType::parse(p))
                        .collect(),
                    exits: b.exits.iter().map(|e| (e[0], e[1])).collect(),
                    gives_buildable_area: b.gives_buildable_area,
                    base_provider_range: b.base_provider_range,
                    adjacent: b.adjacent,
                    provides,
                    refinery: b.refinery.map(|r| RefineryInfo {
                        dock_offset: (r.dock_offset[0], r.dock_offset[1]),
                        storage: r.storage,
                        free_actor: ids.iter().position(|i| *i == r.free_actor).expect("free actor exists"),
                        free_actor_offset: (r.free_actor_offset[0], r.free_actor_offset[1]),
                    }),
                    repairs: b.repairs,
                    center_offset: (b.center_offset[0], b.center_offset[1]),
                }
            });
            actors.push(ActorInfo {
                id: a.id,
                name: a.name,
                description: a.description,
                kind,
                queue: QueueType::parse(&a.queue),
                cost: a.cost,
                build_ticks: a.build_ticks,
                palette_order: a.palette_order,
                prerequisites,
                hp: a.hp,
                armor: a.armor,
                sight: a.sight,
                weapons: a.weapons,
                building,
                unit: a.unit,
            });
        }
        let weapons = raw
            .weapons
            .into_iter()
            .map(|w| WeaponInfo {
                name: w.name,
                range: w.range,
                reload: w.reload,
                burst: w.burst.max(1),
                burst_delays: if w.burst_delays.is_empty() { vec![5] } else { w.burst_delays },
                projectile: match w.projectile.as_str() {
                    "bullet" => Projectile::Bullet,
                    "missile" => Projectile::Missile,
                    _ => Projectile::Instant,
                },
                speed: w.speed,
                damage: w.damage,
                spread: w.spread,
                falloff: w.falloff,
                versus: w.versus,
            })
            .collect();
        let locomotors = raw
            .locomotors
            .into_iter()
            .map(|l| Locomotor { crushes_infantry: l.crushes.iter().any(|c| c == "infantry"), name: l.name, speeds: l.speeds })
            .collect();
        Rules { factions: raw.factions, player: raw.player, actors, weapons, locomotors, tokens }
    }

    pub fn actor_index(&self, id: &str) -> Option<usize> {
        self.actors.iter().position(|a| a.id.eq_ignore_ascii_case(id))
    }

    pub fn faction_index(&self, name: &str) -> Option<usize> {
        self.factions.iter().position(|f| f == name)
    }

    /// Faction side: 0 = Allies, 1 = Soviet.
    pub fn side_of(&self, faction: usize) -> usize {
        match self.factions[faction].as_str() {
            "soviet" | "russia" | "ukraine" => 1,
            _ => 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rules_load_and_resolve() {
        let r = Rules::load();
        let tnk = &r.actors[r.actor_index("3TNK").unwrap()];
        assert_eq!(tnk.cost, 1150);
        assert_eq!(r.weapons[tnk.weapons[0]].name, "105mm");
        assert_eq!(r.weapons[tnk.weapons[0]].burst, 2);
        let proc_ = r.actors[r.actor_index("PROC").unwrap()].building.as_ref().unwrap();
        assert_eq!(proc_.refinery.as_ref().unwrap().storage, 2000);
        assert_eq!(r.actors[r.actor_index("FACT").unwrap()].prerequisites[0].token, 0, "FACT is ~disabled");
    }

    #[test]
    fn falloff_matches_openra() {
        let r = Rules::load();
        let w = &r.weapons[0];
        assert_eq!(w.falloff_at(0), 100);
        assert_eq!(w.falloff_at(w.spread), 37);
        assert_eq!(w.falloff_at(w.spread * 3), 0);
    }
}
